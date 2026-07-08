/*
Copyright 2015 The Kubernetes Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package secrets

// This file provides an integration test proving V3 of the security-hardening
// remediation: Secrets must be encrypted at rest (ciphertext in etcd), never
// stored via the identity/plaintext path. It applies an EncryptionConfiguration
// programmatically (the aesgcm provider, which needs no external KMS socket)
// through the test API server's --encryption-provider-config flag, then reads
// the raw etcd blob to assert ciphertext. It has NO build dependency on the
// cluster/ deployment scripts; it validates the runtime effect of the V3 config
// change in a self-contained, minimal-change manner.
// AAP §6.6.10 / §0.8.1 (V3) + §6.4.5.

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	clientset "k8s.io/client-go/kubernetes"
	kubeapiservertesting "k8s.io/kubernetes/cmd/kube-apiserver/app/testing"
	"k8s.io/kubernetes/test/integration"
	"k8s.io/kubernetes/test/integration/framework"
)

const (
	// AAP §6.6.10 / §0.8.1 (V3) + §6.4.5: aesgcm provider — no external KMS needed (Minimal Change Clause §0.11).
	aesGCMPrefix = "k8s:enc:aesgcm:v1:key1:"

	// AAP §6.4.5 / §0.5.1 (V3): EncryptionConfiguration applied via --encryption-provider-config.
	// The aesgcm key material below is the same non-secret test fixture used by
	// test/integration/controlplane/transformation/secrets_transformation_test.go — NOT a real credential.
	encryptionConfigYAML = `
kind: EncryptionConfiguration
apiVersion: apiserver.config.k8s.io/v1
resources:
  - resources:
    - secrets
    providers:
    - aesgcm:
        keys:
        - name: key1
          secret: c2VjcmV0IGlzIHNlY3VyZQ==
`
	// AAP §0.8.1 (V3): a known plaintext marker asserted absent from the raw etcd blob.
	plaintextCanary = "BLITZY_PLAINTEXT_CANARY"
)

// etcdKeyForSecret builds the raw etcd key exactly as the apiserver storage layer does:
// "/<storagePrefix>/secrets/<namespace>/<name>". storagePrefix MUST be read from the live
// framework.SharedEtcd() config (it embeds a per-run UUID, e.g. "<uuid>/registry") — never hardcode "registry".
// AAP §6.6.10 / §0.8.1 (V3): replicated inline (Go _test.go files are not importable across packages).
func etcdKeyForSecret(storagePrefix, namespace, name string) string {
	return "/" + storagePrefix + "/secrets/" + namespace + "/" + name
}

// TestSecretsAreEncryptedAtRest verifies V3: Secrets must be encrypted at rest (ciphertext in
// etcd), never stored via the identity/plaintext path.
// AAP §6.6.10 / §0.8.1 (V3) + §6.4.5.
func TestSecretsAreEncryptedAtRest(t *testing.T) {
	// Capture the SAME shared etcd config instance passed to the server; its .Prefix and
	// .Transport are needed to perform the raw (unencrypted-path) read below.
	storageConfig := framework.SharedEtcd()

	// Write the EncryptionConfiguration to a temp file and wire it via --encryption-provider-config.
	// t.TempDir() is auto-cleaned at test end.
	encPath := filepath.Join(t.TempDir(), "encryption-config.yaml")
	if err := os.WriteFile(encPath, []byte(encryptionConfigYAML), 0644); err != nil {
		t.Fatalf("failed to write encryption config: %v", err)
	}

	// Start a test API server with encryption enabled. Disabling the ServiceAccount admission
	// plugin avoids SA-controller retry latency, mirroring the transformation harness.
	server := kubeapiservertesting.StartTestServerOrDie(t, nil, []string{
		"--encryption-provider-config", encPath,
		"--disable-admission-plugins", "ServiceAccount",
	}, storageConfig)
	defer server.TearDownFn()

	client := clientset.NewForConfigOrDie(server.ClientConfig)

	ns := framework.CreateNamespaceOrDie(client, "secret-encryption", t)
	defer framework.DeleteNamespaceOrDie(client, ns, t)

	// Create a Secret whose value is a known plaintext canary.
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "encrypted-secret", Namespace: ns.Name},
		Data:       map[string][]byte{"api_key": []byte(plaintextCanary)},
	}
	if _, err := client.CoreV1().Secrets(ns.Name).Create(context.TODO(), secret, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create secret: %v", err)
	}

	// Raw etcd read (replicate readRawRecordFromETCD, transformation_test.go:516-531).
	rawClient, kvClient, err := integration.GetEtcdClients(storageConfig.Transport)
	if err != nil {
		t.Fatalf("failed to create etcd client: %v", err)
	}
	// Closing rawClient avoids leaked goroutines; kvClient wraps it.
	defer rawClient.Close()

	key := etcdKeyForSecret(storageConfig.Prefix, ns.Name, secret.Name)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := kvClient.Get(ctx, key, clientv3.WithPrefix())
	if err != nil {
		t.Fatalf("failed to read secret from etcd: %v", err)
	}

	// AAP §0.8.1 (V3): exactly one stored object for the secret key.
	if len(resp.Kvs) != 1 {
		t.Fatalf("expected exactly one etcd entry for key %q, got %d", key, len(resp.Kvs))
	}

	// AAP §6.6.10 / §0.8.1 (V3) + §6.4.5: stored value must be ciphertext (aesgcm prefix), not plaintext.
	if !bytes.HasPrefix(resp.Kvs[0].Value, []byte(aesGCMPrefix)) {
		t.Errorf("expected secret in etcd to be prefixed with %q (ciphertext), got %q", aesGCMPrefix, resp.Kvs[0].Value)
	}

	// AAP §0.8.1 (V3): the known plaintext must NOT appear in the raw etcd blob.
	if bytes.Contains(resp.Kvs[0].Value, []byte(plaintextCanary)) {
		t.Errorf("plaintext canary %q found in etcd — secret NOT encrypted at rest", plaintextCanary)
	}

	// AAP §0.11 (contract preservation): the apiserver transparently decrypts on read.
	got, err := client.CoreV1().Secrets(ns.Name).Get(context.TODO(), secret.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("failed to get secret via apiserver: %v", err)
	}
	if string(got.Data["api_key"]) != plaintextCanary {
		t.Errorf("decrypted secret mismatch: expected %q, got %q", plaintextCanary, string(got.Data["api_key"]))
	}
}
