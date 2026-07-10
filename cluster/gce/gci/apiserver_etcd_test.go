/*
Copyright 2019 The Kubernetes Authors.

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

package gci

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

type kubeAPIServeETCDEnv struct {
	KubeHome               string
	KubeAPIServerRunAsUser string
	ETCDServers            string
	ETCDServersOverride    string
	CAKey                  string
	CACert                 string
	CACertPath             string
	APIServerKey           string
	APIServerCert          string
	APIServerCertPath      string
	APIServerKeyPath       string
	ETCDKey                string
	ETCDCert               string
	StorageBackend         string
	StorageMediaType       string
	CompactionInterval     string
}

func TestServerOverride(t *testing.T) {
	testCases := []struct {
		desc string
		env  kubeAPIServeETCDEnv
		want []string
	}{
		{
			desc: "ETCD-SERVERS is not set - default override",
			want: []string{
				"--etcd-servers-overrides=/events#http://127.0.0.1:4002",
			},
		},
		{
			desc: "ETCD-SERVERS and ETCD_SERVERS_OVERRIDES are set",
			env: kubeAPIServeETCDEnv{
				ETCDServers:         "ETCDServers",
				ETCDServersOverride: "ETCDServersOverrides",
			},
			want: []string{
				"--etcd-servers-overrides=ETCDServersOverrides",
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.desc, func(t *testing.T) {
			c := newManifestTestCase(t, kubeAPIServerManifestFileName, kubeAPIServerStartFuncName, nil)
			defer c.tearDown()
			tc.env.KubeHome = c.kubeHome
			tc.env.KubeAPIServerRunAsUser = strconv.Itoa(os.Getuid())

			c.mustInvokeFunc(
				tc.env,
				[]string{"configure-helper.sh", kubeAPIServerConfigScriptName},
				"etcd.template",
				"testdata/kube-apiserver/base.template",
				"testdata/kube-apiserver/etcd.template",
			)
			c.mustLoadPodFromManifest()

			execArgs := strings.Join(c.pod.Spec.Containers[0].Command, " ")
			for _, f := range tc.want {
				if !strings.Contains(execArgs, f) {
					t.Fatalf("Got %q, want it to contain %q", execArgs, f)
				}
			}
		})
	}
}

func TestStorageOptions(t *testing.T) {
	testCases := []struct {
		desc     string
		env      kubeAPIServeETCDEnv
		want     []string
		dontWant []string
	}{
		{
			desc: "storage options are supplied",
			env: kubeAPIServeETCDEnv{
				StorageBackend:     "StorageBackend",
				StorageMediaType:   "StorageMediaType",
				CompactionInterval: "1s",
			},
			want: []string{
				"--storage-backend=StorageBackend",
				"--storage-media-type=StorageMediaType",
				"--etcd-compaction-interval=1s",
			},
		},
		{
			desc: "storage options are not supplied",
			env:  kubeAPIServeETCDEnv{},
			dontWant: []string{
				"--storage-backend",
				"--storage-media-type",
				"--etcd-compaction-interval",
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.desc, func(t *testing.T) {
			c := newManifestTestCase(t, kubeAPIServerManifestFileName, kubeAPIServerStartFuncName, nil)
			defer c.tearDown()
			tc.env.KubeHome = c.kubeHome
			tc.env.KubeAPIServerRunAsUser = strconv.Itoa(os.Getuid())

			c.mustInvokeFunc(
				tc.env,
				[]string{"configure-helper.sh", kubeAPIServerConfigScriptName},
				"etcd.template",
				"testdata/kube-apiserver/base.template",
				"testdata/kube-apiserver/etcd.template",
			)
			c.mustLoadPodFromManifest()

			execArgs := strings.Join(c.pod.Spec.Containers[0].Command, " ")
			for _, f := range tc.want {
				if !strings.Contains(execArgs, f) {
					t.Fatalf("Got %q, want it to contain %q", execArgs, f)
				}
			}

			for _, f := range tc.dontWant {
				if strings.Contains(execArgs, f) {
					t.Fatalf("Got %q, but it was not expected it to contain %q", execArgs, f)
				}
			}
		})
	}
}

func TestTLSFlags(t *testing.T) {
	testCases := []struct {
		desc string
		env  kubeAPIServeETCDEnv
		want []string
	}{
		{
			desc: "mTLS enabled",
			env: kubeAPIServeETCDEnv{
				CAKey:             "CAKey",
				CACert:            "CACert",
				CACertPath:        "CACertPath",
				APIServerKey:      "APIServerKey",
				APIServerCert:     "APIServerCert",
				ETCDKey:           "ETCDKey",
				ETCDCert:          "ETCDCert",
				ETCDServers:       "https://127.0.0.1:2379",
				APIServerKeyPath:  "APIServerKeyPath",
				APIServerCertPath: "APIServerCertPath",
			},
			want: []string{
				"--etcd-servers=https://127.0.0.1:2379",
				"--etcd-cafile=CACertPath",
				"--etcd-certfile=APIServerCertPath",
				"--etcd-keyfile=APIServerKeyPath",
			},
		},
		{
			desc: "mTLS disabled",
			want: []string{"--etcd-servers=http://127.0.0.1:2379"},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.desc, func(t *testing.T) {
			c := newManifestTestCase(t, kubeAPIServerManifestFileName, kubeAPIServerStartFuncName, nil)
			defer c.tearDown()
			tc.env.KubeHome = c.kubeHome
			tc.env.KubeAPIServerRunAsUser = strconv.Itoa(os.Getuid())

			c.mustInvokeFunc(
				tc.env,
				[]string{"configure-helper.sh", kubeAPIServerConfigScriptName},
				"etcd.template",
				"testdata/kube-apiserver/base.template",
				"testdata/kube-apiserver/etcd.template",
			)
			c.mustLoadPodFromManifest()

			execArgs := strings.Join(c.pod.Spec.Containers[0].Command, " ")
			for _, f := range tc.want {
				if !strings.Contains(execArgs, f) {
					t.Fatalf("Got %q, want it to contain %q", execArgs, f)
				}
			}
		})
	}
}

// TestConfigureEtcdParamsFailClosed locks the etcd mutual-TLS all-or-nothing fail-closed
// hardening in configure-etcd-params (configure-kubeapiserver.sh:18-70): under the hardened
// GCE posture (ETCD_APISERVER_ALLOW_INSECURE=false) any partial or fully-absent etcd mTLS
// credential set aborts the real function with exit 1, while a complete six-credential set
// (or the explicit insecure bypass) exits 0. Each case drives the REAL shell function through
// the runConfigureEtcdParamsExitCode subprocess helper so the fail-closed `exit 1` is captured
// as a child-process exit code instead of terminating this test binary.
//
// AAP §6.6.10 / §0.8.1 (V8) + §6.4.x + §0.11
func TestConfigureEtcdParamsFailClosed(t *testing.T) {
	// The six etcd mTLS credential env vars are all-or-nothing: the mTLS branch
	// (configure-kubeapiserver.sh:21-25) fires only when every one is present; any strict
	// subset takes the partial-credential else-branch (:48) and aborts with exit 1 (:49-50),
	// and a fully-absent set takes the all-absent elif (:26) which fails closed with exit 1
	// (:45-46) unless the plaintext bypass is explicitly enabled.
	//
	// Hardened-default posture: the GCE reference profiles pin ETCD_APISERVER_ALLOW_INSECURE=false
	// (cluster/gce/config-default.sh, config-test.sh; documented at configure-kubeapiserver.sh:30-35),
	// so the plaintext etcd fallback is DISABLED by default. Every fail-closed row below therefore
	// sets ALLOW_INSECURE=false EXPLICITLY to reproduce production; we deliberately do NOT rely on
	// the function-local "${ETCD_APISERVER_ALLOW_INSECURE:-true}" shim (:41), which exists only for
	// direct-invocation unit tests that never load the hardened GCE profiles.
	testCases := []struct {
		desc     string
		env      map[string]string
		wantExit int
	}{
		{
			desc:     "cert-only fails closed",
			env:      map[string]string{"ETCD_APISERVER_CLIENT_CERT": "clientcert", "ETCD_APISERVER_ALLOW_INSECURE": "false"},
			wantExit: 1, // partial-credential else-branch: ERROR (configure-kubeapiserver.sh:49) + exit 1 (:50)
		},
		{
			desc:     "key-only fails closed",
			env:      map[string]string{"ETCD_APISERVER_CLIENT_KEY": "clientkey", "ETCD_APISERVER_ALLOW_INSECURE": "false"},
			wantExit: 1, // partial-credential else-branch: ERROR (:49) + exit 1 (:50)
		},
		{
			desc:     "CA-only fails closed",
			env:      map[string]string{"ETCD_APISERVER_CA_CERT": "cacert", "ETCD_APISERVER_ALLOW_INSECURE": "false"},
			wantExit: 1, // partial-credential else-branch: ERROR (:49) + exit 1 (:50)
		},
		{
			desc:     "all-absent fails closed when insecure disabled",
			env:      map[string]string{"ETCD_APISERVER_ALLOW_INSECURE": "false"},
			wantExit: 1, // all-absent elif (:26) -> ERROR (:45) + exit 1 (:46)
		},
		{
			desc: "all six credentials present succeeds",
			env: map[string]string{
				"ETCD_APISERVER_CA_KEY":           "cakey",
				"ETCD_APISERVER_CA_CERT":          "cacert",
				"ETCD_APISERVER_SERVER_KEY":       "serverkey",
				"ETCD_APISERVER_SERVER_CERT":      "servercert",
				"ETCD_APISERVER_CLIENT_KEY":       "clientkey",
				"ETCD_APISERVER_CLIENT_CERT":      "clientcert",
				"ETCD_APISERVER_CA_CERT_PATH":     "/etc/srv/kubernetes/pki/etcd-apiserver-ca.crt",
				"ETCD_APISERVER_CLIENT_CERT_PATH": "/etc/srv/kubernetes/pki/etcd-apiserver-client.crt",
				"ETCD_APISERVER_CLIENT_KEY_PATH":  "/etc/srv/kubernetes/pki/etcd-apiserver-client.key",
				"ETCD_APISERVER_ALLOW_INSECURE":   "false",
			},
			wantExit: 0, // mTLS branch (:21-25)
		},
		{
			desc:     "all-absent with insecure bypass explicitly enabled",
			env:      map[string]string{"ETCD_APISERVER_ALLOW_INSECURE": "true"},
			wantExit: 0, // documented plaintext bypass: WARNING (:42-43), no exit
		},
	}

	for _, tc := range testCases {
		t.Run(tc.desc, func(t *testing.T) {
			// Invoke the REAL configure-etcd-params in a child bash process (read-only) and
			// capture its exit code; the fail-closed rows prove the hardened control actively
			// aborts rather than silently talking plaintext to etcd.
			gotExit := runConfigureEtcdParamsExitCode(t, tc.env)
			assert.Equal(t, tc.wantExit, gotExit, "configure-etcd-params exit code for %q", tc.desc)
		})
	}
}
