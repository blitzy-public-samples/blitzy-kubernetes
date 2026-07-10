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
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

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
