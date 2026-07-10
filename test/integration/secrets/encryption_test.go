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

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	clientv3 "go.etcd.io/etcd/client/v3"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apiserver/pkg/server/options/encryptionconfig"
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

// TestEncryptionKMSv2CachesizeRejectedAtStartup verifies V3 (fail-closed): the API server MUST
// reject an EncryptionConfiguration that sets the illegal `cachesize` field under a KMS
// apiVersion:v2 provider, so a misconfigured (weakened) encryption setup can never come up silently.
// It drives the EXACT production loader/validator the API server invokes at startup — namely
// encryptionconfig.LoadEncryptionConfig, called from EtcdOptions.maybeApplyResourceTransformers
// (which is why StartTestServerOrDie's happy path in TestSecretsAreEncryptedAtRest succeeds) —
// rather than reimplementing the validation. Invoking the loader directly (instead of a full
// StartTestServer) keeps the failure path leak-free: LoadEncryptionConfig validates the parsed
// config before it builds any transformer or launches any KMS/etcd goroutine, whereas a full
// server startup constructs the main etcd storage prober before this validation runs and would
// leak those prober goroutines on the aborted-startup path (the prober's stop channel is tied to
// a server run lifecycle that never begins). No external KMS process is started: validation fails
// before the placeholder unix:///tmp/kms.socket endpoint is ever dialed.
// AAP §6.6.10 / §0.8.1 (V3) + §6.4.5 (Minimal Change Clause §0.11).
func TestEncryptionKMSv2CachesizeRejectedAtStartup(t *testing.T) {
	// Function-local (Minimal Change Clause §0.11 — no new package-level state) EncryptionConfiguration
	// with a KMS v2 provider that ALSO sets `cachesize`, which is not permitted under the v2 contract.
	// The unix:///tmp/kms.socket endpoint is a placeholder only: validation rejects the config before
	// any KMS dial occurs, so no external KMS process is started (mirrors the reference template shape).
	const kmsV2CachesizeConfigYAML = `
kind: EncryptionConfiguration
apiVersion: apiserver.config.k8s.io/v1
resources:
  - resources:
    - secrets
    providers:
    - kms:
        apiVersion: v2
        name: k8s-kms
        endpoint: unix:///tmp/kms.socket
        timeout: 3s
        cachesize: 1000
    - identity: {}
`

	// t.TempDir() is auto-cleaned at test end.
	encPath := filepath.Join(t.TempDir(), "encryption-config.yaml")
	require.NoError(t, os.WriteFile(encPath, []byte(kmsV2CachesizeConfigYAML), 0644))

	// Honor LoadEncryptionConfig's documented contract: the caller owns a context that is cancelled
	// to clean up any goroutines the loader may launch. For this fail-closed input, validation fails
	// before any goroutine is launched, but cancelling on return is the correct, leak-free pattern.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Exercise the real production loader/validator (encryptionconfig.LoadEncryptionConfig). reload
	// is false and apiServerID is empty, matching a fresh non-hot-reload startup load.
	_, err := encryptionconfig.LoadEncryptionConfig(ctx, encPath, false, "")

	// Fail-closed assertion: the load MUST fail, and the error MUST name the rejected field. The full
	// message reads like "error while parsing file: resources[0].providers[0].kms.cachesize: Invalid
	// value: 1000: cachesize is not supported in v2" (validateKMSCacheSize), so the substring matches.
	require.Error(t, err, "expected the encryption config load to fail when a KMS v2 provider sets cachesize")
	assert.ErrorContains(t, err, "cachesize is not supported in v2")
}

// TestEncryptionIdentityProviderLastFallback verifies V3: with a strong provider FIRST (aesgcm) and
// the identity provider LAST, new Secret writes are encrypted by the strong provider (ciphertext in
// etcd) while identity-present-but-last never causes plaintext storage; it also re-asserts that the
// plaintext canary is absent from the raw blob and that the apiserver still transparently decrypts.
// AAP §6.6.10 / §0.8.1 (V3) + §6.4.5 (Minimal Change Clause §0.11).
func TestEncryptionIdentityProviderLastFallback(t *testing.T) {
	// Function-local (Minimal Change Clause §0.11 — no new package-level state) aesgcm-first +
	// identity-last EncryptionConfiguration. The aesgcm key material below is the same non-secret
	// test fixture used by the existing encryptionConfigYAML — NOT a real credential.
	const aesGCMFirstIdentityLastConfigYAML = `
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
    - identity: {}
`

	// Capture the SAME shared etcd config passed to the server; its .Prefix and .Transport are
	// needed for the raw (unencrypted-path) read below.
	storageConfig := framework.SharedEtcd()

	encPath := filepath.Join(t.TempDir(), "encryption-config.yaml")
	require.NoError(t, os.WriteFile(encPath, []byte(aesGCMFirstIdentityLastConfigYAML), 0644))

	// This server is EXPECTED to start successfully, so StartTestServerOrDie mirrors the existing test.
	server := kubeapiservertesting.StartTestServerOrDie(t, nil, []string{
		"--encryption-provider-config", encPath,
		"--disable-admission-plugins", "ServiceAccount",
	}, storageConfig)
	defer server.TearDownFn()

	client := clientset.NewForConfigOrDie(server.ClientConfig)

	// Distinct namespace/secret names so this test never collides with the existing
	// TestSecretsAreEncryptedAtRest ("secret-encryption"/"encrypted-secret").
	ns := framework.CreateNamespaceOrDie(client, "secret-encryption-fallback", t)
	defer framework.DeleteNamespaceOrDie(client, ns, t)

	// Create a Secret whose value is the known plaintext canary.
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "fallback-secret", Namespace: ns.Name},
		Data:       map[string][]byte{"api_key": []byte(plaintextCanary)},
	}
	_, err := client.CoreV1().Secrets(ns.Name).Create(context.TODO(), secret, metav1.CreateOptions{})
	require.NoError(t, err)

	// Raw etcd read: reuse the existing etcdKeyForSecret helper and storageConfig.Prefix (never
	// hardcode "registry" — it embeds a per-run UUID).
	rawClient, kvClient, err := integration.GetEtcdClients(storageConfig.Transport)
	require.NoError(t, err)
	// Closing rawClient avoids leaked goroutines; kvClient wraps it.
	defer rawClient.Close()

	key := etcdKeyForSecret(storageConfig.Prefix, ns.Name, secret.Name)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := kvClient.Get(ctx, key, clientv3.WithPrefix())
	require.NoError(t, err)
	require.Len(t, resp.Kvs, 1)

	// Ordering assertion: the FIRST (aesgcm) provider — not identity — encrypts new writes, so the
	// stored blob must carry the aesgcm ciphertext prefix.
	assert.True(t, bytes.HasPrefix(resp.Kvs[0].Value, []byte(aesGCMPrefix)),
		"new writes must be encrypted by the first (aesgcm) provider, got %q", resp.Kvs[0].Value)

	// Confidentiality assertion: the known plaintext canary must be ABSENT from the raw blob —
	// identity-being-present-but-last must not cause plaintext storage.
	assert.False(t, bytes.Contains(resp.Kvs[0].Value, []byte(plaintextCanary)),
		"plaintext canary %q must not appear in etcd — identity-last must not cause plaintext storage", plaintextCanary)

	// Contract preservation: the apiserver still transparently decrypts on read (identity being
	// present-but-last in the decrypt chain is harmless).
	got, err := client.CoreV1().Secrets(ns.Name).Get(context.TODO(), secret.Name, metav1.GetOptions{})
	require.NoError(t, err)
	assert.Equal(t, plaintextCanary, string(got.Data["api_key"]))
}
