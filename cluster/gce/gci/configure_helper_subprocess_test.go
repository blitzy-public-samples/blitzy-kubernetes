/*
Copyright 2024 The Kubernetes Authors.

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
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// runConfigureEtcdParamsExitCode sources the REAL configure-kubeapiserver.sh in a child
// bash process, invokes the production configure-etcd-params function with the supplied
// environment, and returns the child's exit code WITHOUT terminating the Go test binary.
//
// It exists because the shared harness helper ManifestTestCase.mustInvokeFunc
// (configure_helper_test.go, lines 108-123) calls t.Fatalf on any non-zero child exit and
// therefore cannot assert the V8 fail-closed `exit 1` path; this helper captures the exit
// code via *exec.ExitError instead. It is consumed by TestConfigureEtcdParamsFailClosed in
// apiserver_etcd_test.go (same package) to drive the partial-credential fail-closed table.
//
// AAP §6.6.10 / §0.8.1 (V8) + §6.4.x + §0.11
func runConfigureEtcdParamsExitCode(t *testing.T, env map[string]string) int {
	t.Helper()

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to determine working directory: %v", err)
	}

	// configure-etcd-params uses a bash nameref (`local -n params_ref=$1`,
	// configure-kubeapiserver.sh line 19), so a param NAME must be passed;
	// invoking it bare emits a spurious "local: `': not a valid identifier".
	// Mirror the real caller start-kube-apiserver (line 90): `configure-etcd-params params`.
	// cd into the package directory so the relative `source` of the real script resolves
	// (Go runs tests with CWD == package dir cluster/gce/gci).
	script := fmt.Sprintf("cd %q; source %q; params=''; configure-etcd-params params", cwd, kubeAPIServerConfigScriptName)

	cmd := exec.Command("bash", "-c", script)
	// Build a hermetic child environment: inherit the parent environment EXCEPT any
	// ETCD_APISERVER_* variables, then layer the per-case env on top. Stripping the
	// inherited ETCD_APISERVER_* prefix keeps the partial-credential / all-absent cases
	// deterministic even when the parent shell already exports those credential vars:
	// without this filter, an inherited credential (e.g. ETCD_APISERVER_CA_CERT) would be
	// injected into a case that intends to omit it, turning an all-absent/bypass case into
	// a partial-credential set and masking the fail-closed `exit 1` decision. The per-case
	// env is appended last so an explicit case value always wins over any inherited value.
	parentEnv := os.Environ()
	childEnv := make([]string, 0, len(parentEnv)+len(env))
	for _, kv := range parentEnv {
		if strings.HasPrefix(kv, "ETCD_APISERVER_") {
			continue
		}
		childEnv = append(childEnv, kv)
	}
	for k, v := range env {
		childEnv = append(childEnv, fmt.Sprintf("%s=%s", k, v))
	}
	cmd.Env = childEnv

	out, err := cmd.CombinedOutput()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	// A non-exit error (e.g. bash missing) is a genuine harness failure, not a fail-closed signal.
	t.Fatalf("failed to run configure-etcd-params subprocess: %v\noutput: %s", err, out)
	return -1
}
