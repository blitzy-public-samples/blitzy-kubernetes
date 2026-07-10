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
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// mustSourceConfigVar sources a real GCE config profile (relative to the package
// directory, e.g. "../config-default.sh") in a child bash process and returns the
// value of the named variable. It drives the real config generator read-only.
func mustSourceConfigVar(t *testing.T, configScript, varName string) string {
	t.Helper()
	script := fmt.Sprintf("source %q; printf '%%s' \"${%s:-}\"", configScript, varName)
	cmd := exec.Command("bash", "-c", script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to source %q for %s: %v\noutput: %s", configScript, varName, err, out)
	}
	return string(out)
}

// AAP §6.6.10 / §0.8.1 (V7) + §6.4.x
func TestAdmissionControlNodeRestrictionOrdering(t *testing.T) {
	testCases := []struct {
		desc         string
		configScript string
	}{
		{desc: "config-default.sh profile", configScript: "../config-default.sh"},
		{desc: "config-test.sh profile", configScript: "../config-test.sh"},
	}

	for _, tc := range testCases {
		t.Run(tc.desc, func(t *testing.T) {
			admissionControl := mustSourceConfigVar(t, tc.configScript, "ADMISSION_CONTROL")
			if admissionControl == "" {
				t.Fatalf("ADMISSION_CONTROL is empty from %s; expected the real admission-plugins list", tc.configScript)
			}

			// Feed the real ADMISSION_CONTROL into manifest generation via the
			// environment; base.template intentionally omits ADMISSION_CONTROL, and the
			// harness's child bash inherits the parent process env (mustInvokeFunc does
			// not override cmd.Env), so t.Setenv propagates into the render. The
			// generator emits `--enable-admission-plugins=${ADMISSION_CONTROL}` only when
			// ADMISSION_CONTROL is non-empty (configure-kubeapiserver.sh lines 260-261).
			t.Setenv("ADMISSION_CONTROL", admissionControl)

			c := newManifestTestCase(t, kubeAPIServerManifestFileName, kubeAPIServerStartFuncName, nil)
			defer c.tearDown()

			env := kubeAPIServeETCDEnv{
				KubeHome:               c.kubeHome,
				KubeAPIServerRunAsUser: strconv.Itoa(os.Getuid()),
			}

			c.mustInvokeFunc(
				env,
				[]string{"configure-helper.sh", kubeAPIServerConfigScriptName},
				"etcd.template",
				"testdata/kube-apiserver/base.template",
				"testdata/kube-apiserver/etcd.template",
			)
			c.mustLoadPodFromManifest()

			execArgs := strings.Join(c.pod.Spec.Containers[0].Command, " ")

			if !strings.Contains(execArgs, "--enable-admission-plugins=") {
				t.Fatalf("expected --enable-admission-plugins flag to be emitted, got: %q", execArgs)
			}
			if !strings.Contains(execArgs, "NodeRestriction") {
				t.Fatalf("expected NodeRestriction in admission plugins, got: %q", execArgs)
			}
			if !strings.Contains(execArgs, "PodSecurity") {
				t.Fatalf("expected PodSecurity in admission plugins, got: %q", execArgs)
			}

			// Regression lock (V7): NodeRestriction must precede PodSecurity.
			nodeIdx := strings.Index(execArgs, "NodeRestriction")
			psIdx := strings.Index(execArgs, "PodSecurity")
			if nodeIdx >= psIdx {
				t.Fatalf("expected NodeRestriction (index %d) to appear before PodSecurity (index %d) in emitted admission plugins: %q", nodeIdx, psIdx, execArgs)
			}
		})
	}
}
