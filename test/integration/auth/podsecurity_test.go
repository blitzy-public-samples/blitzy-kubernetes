/*
Copyright 2021 The Kubernetes Authors.

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

package auth

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	auditv1 "k8s.io/apiserver/pkg/apis/audit/v1"
	apiserver "k8s.io/apiserver/pkg/server"
	"k8s.io/apiserver/pkg/server/dynamiccertificates"
	utilfeature "k8s.io/apiserver/pkg/util/feature"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/component-base/featuregate"
	featuregatetesting "k8s.io/component-base/featuregate/testing"
	"k8s.io/component-base/metrics/testutil"
	kubeapiservertesting "k8s.io/kubernetes/cmd/kube-apiserver/app/testing"
	"k8s.io/kubernetes/pkg/capabilities"
	"k8s.io/kubernetes/pkg/features"
	"k8s.io/kubernetes/test/integration/framework"
	utiltest "k8s.io/kubernetes/test/utils"
	podsecurityconfigloader "k8s.io/pod-security-admission/admission/api/load"
	podsecurityserver "k8s.io/pod-security-admission/cmd/webhook/server"
	podsecuritytest "k8s.io/pod-security-admission/test"
	"k8s.io/utils/ptr"
)

func TestPodSecurity(t *testing.T) {
	// Enable all feature gates needed to allow all fields to be exercised
	featuregatetesting.SetFeatureGatesDuringTest(t, utilfeature.DefaultFeatureGate, featuregatetesting.FeatureOverrides{
		features.ProcMountType:         true,
		features.UserNamespacesSupport: true,
	})
	// Start server
	server := startPodSecurityServer(t)
	opts := podsecuritytest.Options{
		ClientConfig: server.ClientConfig,

		// Don't pass in feature-gate info, so all testcases run

		// TODO
		ExemptClient:         nil,
		ExemptNamespaces:     []string{},
		ExemptRuntimeClasses: []string{},
	}
	podsecuritytest.Run(t, opts)

	ValidatePluginMetrics(t, opts.ClientConfig)
}

// TestPodSecurityGAOnly ensures policies pass with only GA features enabled
func TestPodSecurityGAOnly(t *testing.T) {
	// Disable all alpha and beta features
	for k, v := range utilfeature.DefaultFeatureGate.DeepCopy().GetAll() {
		if k == "AllAlpha" || k == "AllBeta" {
			// Skip special features. When processed first, special features may
			// erroneously disable other features.
			continue
		} else if v.PreRelease == featuregate.Alpha || v.PreRelease == featuregate.Beta {
			featuregatetesting.SetFeatureGateDuringTest(t, utilfeature.DefaultFeatureGate, k, false)
		}
	}
	// Start server
	server := startPodSecurityServer(t)

	opts := podsecuritytest.Options{
		ClientConfig: server.ClientConfig,
		// Pass in feature gate info so negative test cases depending on alpha or beta features can be skipped
		Features: utilfeature.DefaultFeatureGate,
	}
	podsecuritytest.Run(t, opts)

	ValidatePluginMetrics(t, opts.ClientConfig)
}

func TestPodSecurityWebhook(t *testing.T) {
	// Enable all feature gates needed to allow all fields to be exercised
	featuregatetesting.SetFeatureGatesDuringTest(t, utilfeature.DefaultFeatureGate, featuregatetesting.FeatureOverrides{
		features.ProcMountType:         true,
		features.UserNamespacesSupport: true,
	})

	// Start test API server.
	capabilities.ResetForTest()
	capabilities.Initialize(capabilities.Capabilities{AllowPrivileged: true})
	testServer := kubeapiservertesting.StartTestServerOrDie(t, kubeapiservertesting.NewDefaultTestServerOptions(), []string{
		"--anonymous-auth=false",
		"--allow-privileged=true",
		// The webhook should pass tests even when PodSecurity is disabled.
		"--disable-admission-plugins=PodSecurity",
	}, framework.SharedEtcd())
	t.Cleanup(testServer.TearDownFn)

	webhookAddr, err := startPodSecurityWebhook(t, testServer)
	if err != nil {
		t.Fatalf("Failed to start webhook server: %v", err)
	}
	if err := installWebhook(t, testServer.ClientConfig, webhookAddr); err != nil {
		t.Fatalf("Failed to install webhook configuration: %v", err)
	}

	opts := podsecuritytest.Options{
		ClientConfig: testServer.ClientConfig,

		// Don't pass in feature-gate info, so all testcases run

		// TODO
		ExemptClient:         nil,
		ExemptNamespaces:     []string{},
		ExemptRuntimeClasses: []string{},
	}
	podsecuritytest.Run(t, opts)

	ValidateWebhookMetrics(t, webhookAddr)
}

func startPodSecurityServer(t *testing.T) *kubeapiservertesting.TestServer {
	// ensure the global is set to allow privileged containers
	capabilities.ResetForTest()
	capabilities.Initialize(capabilities.Capabilities{AllowPrivileged: true})

	server := kubeapiservertesting.StartTestServerOrDie(t, kubeapiservertesting.NewDefaultTestServerOptions(), []string{
		"--anonymous-auth=false",
		"--enable-admission-plugins=PodSecurity",
		"--allow-privileged=true",
		// TODO: "--admission-control-config-file=" + admissionConfigFile.Name(),
	}, framework.SharedEtcd())
	t.Cleanup(server.TearDownFn)
	return server
}

func startPodSecurityWebhook(t *testing.T, testServer *kubeapiservertesting.TestServer) (addr string, err error) {
	// listener, port, err := apiserver.CreateListener("tcp", "127.0.0.1:", net.ListenConfig{})
	secureListener, err := net.Listen("tcp", "127.0.0.1:")
	if err != nil {
		return "", err
	}
	insecureListener, err := net.Listen("tcp", "127.0.0.1:")
	if err != nil {
		return "", err
	}
	cert, err := dynamiccertificates.NewStaticCertKeyContent("localhost", utiltest.LocalhostCert, utiltest.LocalhostKey)
	if err != nil {
		return "", err
	}
	defaultConfig, err := podsecurityconfigloader.LoadFromData(nil) // load the default
	if err != nil {
		return "", err
	}

	c := podsecurityserver.Config{
		SecureServing: &apiserver.SecureServingInfo{
			Listener: secureListener,
			Cert:     cert,
		},
		InsecureServing: &apiserver.DeprecatedInsecureServingInfo{
			Listener: insecureListener,
		},
		KubeConfig:        testServer.ClientConfig,
		PodSecurityConfig: defaultConfig,
	}

	t.Logf("Starting webhook server...")
	webhookServer, err := podsecurityserver.Setup(&c)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(context.Background())
	go webhookServer.Start(ctx)
	t.Cleanup(cancel)

	// Wait for server to be ready
	t.Logf("Waiting for webhook server /readyz to be ok...")
	readyz := (&url.URL{
		Scheme: "http",
		Host:   c.InsecureServing.Listener.Addr().String(),
		Path:   "/readyz",
	}).String()
	if err := wait.PollImmediate(100*time.Millisecond, wait.ForeverTestTimeout, func() (bool, error) {
		resp, err := http.Get(readyz)
		if err != nil {
			return false, err
		}
		defer resp.Body.Close()
		return resp.StatusCode == 200, nil
	}); err != nil {
		return "", err
	}

	return c.SecureServing.Listener.Addr().String(), nil
}

func installWebhook(t *testing.T, clientConfig *rest.Config, addr string) error {
	client, err := kubernetes.NewForConfig(clientConfig)
	if err != nil {
		return fmt.Errorf("error creating client: %w", err)
	}

	fail := admissionregistrationv1.Fail
	equivalent := admissionregistrationv1.Equivalent
	none := admissionregistrationv1.SideEffectClassNone
	endpoint := (&url.URL{
		Scheme: "https",
		Host:   addr,
	}).String()

	// Installing Admission webhook to API server
	_, err = client.AdmissionregistrationV1().ValidatingWebhookConfigurations().Create(context.TODO(), &admissionregistrationv1.ValidatingWebhookConfiguration{
		ObjectMeta: metav1.ObjectMeta{Name: "podsecurity-webhook.integration.test"},
		Webhooks: []admissionregistrationv1.ValidatingWebhook{
			{
				Name: "podsecurity-webhook.integration.test",
				ClientConfig: admissionregistrationv1.WebhookClientConfig{
					URL:      &endpoint,
					CABundle: utiltest.LocalhostCert,
				},
				Rules: []admissionregistrationv1.RuleWithOperations{
					{
						Operations: []admissionregistrationv1.OperationType{admissionregistrationv1.Create, admissionregistrationv1.Update},
						Rule: admissionregistrationv1.Rule{
							APIGroups:   []string{""},
							APIVersions: []string{"v1"},
							Resources:   []string{"namespaces", "pods", "pods/ephemeralcontainers", "replicationcontrollers", "podtemplates"},
						},
					},
					{
						Operations: []admissionregistrationv1.OperationType{admissionregistrationv1.Create, admissionregistrationv1.Update},
						Rule: admissionregistrationv1.Rule{
							APIGroups:   []string{"apps"},
							APIVersions: []string{"v1"},
							Resources:   []string{"replicasets", "deployments", "statefulsets", "daemonsets"},
						},
					},
					{
						Operations: []admissionregistrationv1.OperationType{admissionregistrationv1.Create, admissionregistrationv1.Update},
						Rule: admissionregistrationv1.Rule{
							APIGroups:   []string{"batch"},
							APIVersions: []string{"v1"},
							Resources:   []string{"cronjobs", "jobs"},
						},
					},
				},
				FailurePolicy:           &fail,
				MatchPolicy:             &equivalent,
				AdmissionReviewVersions: []string{"v1"},
				SideEffects:             &none,
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		return err
	}

	t.Logf("Waiting for webhook to be established...")
	invalidNamespace := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: "validation-fail",
			Labels: map[string]string{
				"pod-security.kubernetes.io/enforce": "invalid",
			},
		},
	}
	// Wait for the invalid namespace to be rejected.
	if err := wait.PollImmediate(100*time.Millisecond, wait.ForeverTestTimeout, func() (bool, error) {
		_, err := client.CoreV1().Namespaces().Create(context.TODO(), invalidNamespace, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}})
		if err != nil && apierrors.IsInvalid(err) {
			return true, nil // An Invalid error indicates the webhook rejected the invalid level.
		}
		return false, nil
	}); err != nil {
		return err
	}

	return nil
}

func ValidatePluginMetrics(t *testing.T, clientConfig *rest.Config) {
	client, err := kubernetes.NewForConfig(clientConfig)
	if err != nil {
		t.Fatalf("Error creating client: %v", err)
	}
	ctx := context.Background()
	data, err := client.CoreV1().RESTClient().Get().AbsPath("metrics").DoRaw(ctx)
	if err != nil {
		t.Fatalf("Failed to read metrics: %v", err)
	}
	validateMetrics(t, data)
}

func ValidateWebhookMetrics(t *testing.T, webhookAddr string) {
	endpoint := &url.URL{
		Scheme: "https",
		Host:   webhookAddr,
		Path:   "/metrics",
	}
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	resp, err := client.Get(endpoint.String())
	if err != nil {
		t.Fatalf("Failed to fetch metrics from %s: %v", endpoint.String(), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Non-200 response trying to scrape metrics from %s: %v", endpoint.String(), resp)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Unable to read metrics response: %v", err)
	}
	validateMetrics(t, data)
}

func validateMetrics(t *testing.T, rawMetrics []byte) {
	metrics := testutil.NewMetrics()
	if err := testutil.ParseMetrics(string(rawMetrics), &metrics); err != nil {
		t.Fatalf("Failed to parse metrics: %v", err)
	}

	if err := testutil.ValidateMetrics(metrics, "pod_security_evaluations_total",
		"decision", "policy_level", "policy_version", "mode", "request_operation", "resource", "subresource"); err != nil {
		t.Errorf("Metric validation failed: %v", err)
	}
	if err := testutil.ValidateMetrics(metrics, "pod_security_exemptions_total",
		"request_operation", "resource", "subresource"); err != nil {
		t.Errorf("Metric validation failed: %v", err)
	}
}

// TestPodSecurityEnforceBaselineRejectsPrivileged verifies runtime Pod Security
// enforcement: a namespace labeled enforce=baseline rejects privileged/hostPID
// pods at admission, while a namespace labeled warn=restricted (enforce left at
// the cluster default) admits a restricted-violating pod but surfaces a warning.
// AAP §6.6.10 / §0.8.1 (V2) + §6.4.4.3: Pod Security enforcement — enforce=baseline
// rejects privileged/hostPID pods; warn=restricted admits but warns.
func TestPodSecurityEnforceBaselineRejectsPrivileged(t *testing.T) {
	server := startPodSecurityServer(t)
	client := kubernetes.NewForConfigOrDie(server.ClientConfig)

	// makeNS creates a labeled namespace and its "default" ServiceAccount using the
	// superuser client. kubeapiservertesting starts only the API server (no
	// controllers), so the "default" ServiceAccount is not auto-created; the
	// ServiceAccount admission plugin is enabled in startPodSecurityServer, so pod
	// creation would otherwise fail with a non-Forbidden error before ever reaching
	// the PodSecurity plugin. Creating the SA up front (mirroring
	// staging/src/k8s.io/pod-security-admission/test/run.go l229-234) ensures any
	// rejection below is genuinely a PodSecurity Forbidden, not a ServiceAccount error.
	makeNS := func(name string, labels map[string]string) {
		t.Helper()
		if _, err := client.CoreV1().Namespaces().Create(context.TODO(), &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
		}, metav1.CreateOptions{}); err != nil {
			t.Fatalf("failed creating namespace %s: %v", name, err)
		}
		if _, err := client.CoreV1().ServiceAccounts(name).Create(context.TODO(), &corev1.ServiceAccount{
			ObjectMeta: metav1.ObjectMeta{Name: "default"},
		}, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			t.Fatalf("failed creating default serviceaccount in %s: %v", name, err)
		}
	}

	// AAP §0.8.1 (V2): enforce=baseline must reject privileged and hostPID pods.
	// The enforce=baseline label matches the cluster config default emitted by
	// configure-helper.sh. DryRun creates run the full admission chain (PodSecurity
	// enforce rejection) but persist nothing, keeping framework.SharedEtcd() clean.
	const enforceNS = "psa-enforce-baseline"
	makeNS(enforceNS, map[string]string{"pod-security.kubernetes.io/enforce": "baseline"})

	privilegedPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "privileged-pod"},
		Spec: corev1.PodSpec{
			ServiceAccountName: "default",
			Containers: []corev1.Container{{
				Name:            "c",
				Image:           "busybox",
				SecurityContext: &corev1.SecurityContext{Privileged: ptr.To(true)},
			}},
		},
	}
	if _, err := client.CoreV1().Pods(enforceNS).Create(context.TODO(), privilegedPod, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}}); !apierrors.IsForbidden(err) {
		t.Errorf("expected privileged pod to be rejected by enforce=baseline with Forbidden, got err=%v", err)
	}

	hostPIDPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "hostpid-pod"},
		Spec: corev1.PodSpec{
			ServiceAccountName: "default",
			HostPID:            true,
			Containers:         []corev1.Container{{Name: "c", Image: "busybox"}},
		},
	}
	if _, err := client.CoreV1().Pods(enforceNS).Create(context.TODO(), hostPIDPod, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}}); !apierrors.IsForbidden(err) {
		t.Errorf("expected hostPID pod to be rejected by enforce=baseline with Forbidden, got err=%v", err)
	}

	// AAP §0.8.1 (V2): warn=restricted admits a restricted-violating (but baseline-compliant)
	// pod because enforce is left at the cluster default (privileged) — startPodSecurityServer
	// passes no --admission-control-config-file, and unset PSA levels default to privileged per
	// staging/src/k8s.io/pod-security-admission/admission/api/v1/defaults.go — yet it surfaces a warning.
	const warnNS = "psa-warn-restricted"
	makeNS(warnNS, map[string]string{"pod-security.kubernetes.io/warn": "restricted"})

	// Build a warning-capturing client by reusing the package-local recordingWarningHandler
	// (defined in svcaccttoken_test.go); it implements rest.WarningHandler.
	warnHandler := &recordingWarningHandler{}
	warnCfg := rest.CopyConfig(server.ClientConfig)
	warnCfg.WarningHandler = warnHandler
	warnClient := kubernetes.NewForConfigOrDie(warnCfg)

	// A plain pod (no securityContext) violates the restricted profile (missing runAsNonRoot,
	// seccompProfile, drop-ALL caps, allowPrivilegeEscalation=false) but complies with baseline.
	warnPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "warn-pod"},
		Spec: corev1.PodSpec{
			ServiceAccountName: "default",
			Containers:         []corev1.Container{{Name: "c", Image: "busybox"}},
		},
	}
	warnHandler.clear()
	if _, err := warnClient.CoreV1().Pods(warnNS).Create(context.TODO(), warnPod, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}}); err != nil {
		t.Errorf("expected restricted-violating pod to be admitted under warn=restricted (enforce=privileged default), got err=%v", err)
	}
	// Read the captured warnings under the embedded mutex (satisfies -race).
	warnHandler.Lock()
	gotWarnings := len(warnHandler.warnings)
	warnHandler.Unlock()
	if gotWarnings == 0 {
		t.Errorf("expected at least one Pod Security warning under warn=restricted, got none")
	}
}

// TestPodSecurityKubeSystemExemptionPreserved verifies that the documented
// kube-system Pod Security exemption is preserved and that no other namespace is
// loosened below the baseline default. startPodSecurityServer passes no
// --admission-control-config-file (see the // TODO at its definition), so the cluster
// PSA defaults and the kube-system exemption are not loaded there — and a namespace
// label cannot express an "exemption" — so this test starts its own in-process API
// server with an AdmissionConfiguration that mirrors the cluster hardening
// (enforce=baseline / warn=restricted / audit=restricted, exemptions.namespaces:[kube-system]).
// The behavioral reference is the read-only cluster/manifests/namespace-pss-labels.yaml,
// which is intentionally not imported here.
// AAP §6.6.10 / §0.8.1 (V2) + §6.4.4.3
func TestPodSecurityKubeSystemExemptionPreserved(t *testing.T) {
	// writePSAAdmissionConfig writes a temporary AdmissionConfiguration
	// (apiserver.config.k8s.io/v1) whose inline PodSecurityConfiguration
	// (pod-security.admission.config.k8s.io/v1) mirrors the cluster hardening and exempts
	// kube-system. It is a function-local closure (AAP §0.11: no new package globals or
	// shared mutable state) and returns the path to the written file.
	writePSAAdmissionConfig := func() string {
		t.Helper()
		const cfg = `apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    defaults:
      enforce: "baseline"
      enforce-version: "latest"
      warn: "restricted"
      warn-version: "latest"
      audit: "restricted"
      audit-version: "latest"
    exemptions:
      usernames: []
      runtimeClasses: []
      namespaces: ["kube-system"]
`
		path := t.TempDir() + "/psa-admission-config.yaml"
		if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
			t.Fatalf("failed writing PodSecurity admission config: %v", err)
		}
		return path
	}
	cfgFile := writePSAAdmissionConfig()

	// Mirror startPodSecurityServer (@145-146): allow privileged containers through the
	// process-wide capabilities gate so the decision under test is PodSecurity's alone.
	capabilities.ResetForTest()
	capabilities.Initialize(capabilities.Capabilities{AllowPrivileged: true})

	// Drive the REAL in-process API server (AAP §0.10: no control-plane mocks), loading the
	// admission config so the baseline default and the kube-system exemption take effect.
	server := kubeapiservertesting.StartTestServerOrDie(t, kubeapiservertesting.NewDefaultTestServerOptions(), []string{
		"--anonymous-auth=false",
		"--allow-privileged=true",
		"--enable-admission-plugins=PodSecurity",
		"--admission-control-config-file=" + cfgFile,
	}, framework.SharedEtcd())
	t.Cleanup(server.TearDownFn)
	client := kubernetes.NewForConfigOrDie(server.ClientConfig)

	// makeNS creates a namespace and its "default" ServiceAccount, tolerating AlreadyExists
	// for both. kube-system may be bootstrapped by the API server, and kubeapiservertesting
	// starts no controllers so the "default" ServiceAccount is not auto-created; the
	// ServiceAccount admission plugin is enabled, so pod creation would otherwise fail with a
	// non-Forbidden error before reaching PodSecurity. Creating the SA up front (mirroring the
	// existing makeNS @375-387) ensures the assertions below observe a genuine PodSecurity
	// decision, not a ServiceAccount error.
	makeNS := func(name string, labels map[string]string) {
		t.Helper()
		if _, err := client.CoreV1().Namespaces().Create(context.TODO(), &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
		}, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			t.Fatalf("failed creating namespace %s: %v", name, err)
		}
		if _, err := client.CoreV1().ServiceAccounts(name).Create(context.TODO(), &corev1.ServiceAccount{
			ObjectMeta: metav1.ObjectMeta{Name: "default"},
		}, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			t.Fatalf("failed creating default serviceaccount in %s: %v", name, err)
		}
	}

	const exemptNS = "kube-system"
	const nonExemptNS = "psa-nonexempt"
	makeNS(exemptNS, nil)
	makeNS(nonExemptNS, nil) // no PSA labels -> inherits the config default enforce=baseline

	// newPrivilegedPod builds an identical privileged pod for each namespace so the only
	// variable between the two assertions below is the namespace's exemption status.
	newPrivilegedPod := func() *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "privileged-pod"},
			Spec: corev1.PodSpec{
				ServiceAccountName: "default",
				Containers: []corev1.Container{{
					Name:            "c",
					Image:           "busybox",
					SecurityContext: &corev1.SecurityContext{Privileged: ptr.To(true)},
				}},
			},
		}
	}

	// DryRun creates run the full admission chain but persist nothing, keeping the
	// (uniquely-prefixed) framework.SharedEtcd() storage clean — matching the existing V2
	// test @407.
	dryRun := metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}}

	// AAP §0.8.1 (V2): the kube-system exemption must be preserved — a privileged pod in
	// kube-system is ADMITTED. This locks against anyone over-tightening the exemption to
	// baseline/restricted, which would break control-plane components that require it.
	if _, err := client.CoreV1().Pods(exemptNS).Create(context.TODO(), newPrivilegedPod(), dryRun); err != nil {
		t.Errorf("expected privileged pod to be ADMITTED in exempt namespace %q, got err=%v", exemptNS, err)
	}

	// AAP §0.8.1 (V2): nothing is loosened below baseline — the SAME privileged pod in a
	// non-exempt, unlabeled namespace is REJECTED with Forbidden, proving the cluster default
	// is baseline (not privileged). Pre-remediation (no --admission-control-config-file, default
	// level privileged) this pod would be admitted and this assertion would fail, which is the
	// regression lock.
	if _, err := client.CoreV1().Pods(nonExemptNS).Create(context.TODO(), newPrivilegedPod(), dryRun); !apierrors.IsForbidden(err) {
		t.Errorf("expected privileged pod to be REJECTED with Forbidden in non-exempt namespace %q under enforce=baseline default, got err=%v", nonExemptNS, err)
	}
}

// TestPodSecurityAuditRestrictedBoundary verifies the audit=restricted and
// warn=restricted boundaries of the cluster PSA configuration. A plain pod that is
// baseline-compliant but restricted-violating is ADMITTED under enforce=baseline, yet it
// (a) surfaces a client warning under warn=restricted and (b) records a
// pod-security.kubernetes.io/audit-violations annotation under audit=restricted. That
// annotation is emitted only to the audit backend (never to the object body or a client
// warning), so this test starts its own API server with an audit log in blocking mode —
// the event is written before the API response returns, so no sleeps are required.
// AAP §6.6.10 / §0.8.1 (V2) + §6.4.4.3
func TestPodSecurityAuditRestrictedBoundary(t *testing.T) {
	// writePSAAdmissionConfig writes the same cluster-mirroring AdmissionConfiguration used by
	// TestPodSecurityKubeSystemExemptionPreserved (function-local per AAP §0.11).
	writePSAAdmissionConfig := func() string {
		t.Helper()
		const cfg = `apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    defaults:
      enforce: "baseline"
      enforce-version: "latest"
      warn: "restricted"
      warn-version: "latest"
      audit: "restricted"
      audit-version: "latest"
    exemptions:
      usernames: []
      runtimeClasses: []
      namespaces: ["kube-system"]
`
		path := t.TempDir() + "/psa-admission-config.yaml"
		if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
			t.Fatalf("failed writing PodSecurity admission config: %v", err)
		}
		return path
	}

	// writeAuditPolicy writes a minimal audit Policy that logs pods at Metadata level; audit
	// annotations (including pod-security.kubernetes.io/audit-violations) are recorded at
	// Metadata level and above. Function-local per AAP §0.11.
	writeAuditPolicy := func() string {
		t.Helper()
		const policy = `apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Metadata
  resources:
  - group: ""
    resources: ["pods"]
`
		path := t.TempDir() + "/audit-policy.yaml"
		if err := os.WriteFile(path, []byte(policy), 0o600); err != nil {
			t.Fatalf("failed writing audit policy: %v", err)
		}
		return path
	}

	cfgFile := writePSAAdmissionConfig()
	auditPolicyFile := writeAuditPolicy()
	auditLogFile, err := os.CreateTemp(t.TempDir(), "psa-audit-*.log")
	if err != nil {
		t.Fatalf("failed creating audit log file: %v", err)
	}
	if err := auditLogFile.Close(); err != nil {
		t.Fatalf("failed closing audit log file: %v", err)
	}

	// Mirror startPodSecurityServer (@145-146): allow privileged containers through the
	// capabilities gate so the PodSecurity decision is isolated.
	capabilities.ResetForTest()
	capabilities.Initialize(capabilities.Capabilities{AllowPrivileged: true})

	// Real in-process API server (AAP §0.10) with the admission config AND an audit log.
	// --audit-log-mode=blocking makes the audit event synchronous with the request, so the
	// annotation is observable immediately after the create returns (no sleeps; AAP §0.10).
	server := kubeapiservertesting.StartTestServerOrDie(t, kubeapiservertesting.NewDefaultTestServerOptions(), []string{
		"--anonymous-auth=false",
		"--allow-privileged=true",
		"--enable-admission-plugins=PodSecurity",
		"--admission-control-config-file=" + cfgFile,
		"--audit-policy-file=" + auditPolicyFile,
		"--audit-log-path=" + auditLogFile.Name(),
		"--audit-log-mode=blocking",
		"--audit-log-version=audit.k8s.io/v1",
	}, framework.SharedEtcd())
	t.Cleanup(server.TearDownFn)
	client := kubernetes.NewForConfigOrDie(server.ClientConfig)

	// makeNS creates a namespace and its "default" ServiceAccount, tolerating AlreadyExists, so
	// the create below reaches PodSecurity rather than failing in the ServiceAccount plugin
	// (mirrors the existing makeNS @375-387).
	makeNS := func(name string, labels map[string]string) {
		t.Helper()
		if _, err := client.CoreV1().Namespaces().Create(context.TODO(), &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
		}, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			t.Fatalf("failed creating namespace %s: %v", name, err)
		}
		if _, err := client.CoreV1().ServiceAccounts(name).Create(context.TODO(), &corev1.ServiceAccount{
			ObjectMeta: metav1.ObjectMeta{Name: "default"},
		}, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			t.Fatalf("failed creating default serviceaccount in %s: %v", name, err)
		}
	}

	// No PSA labels -> the namespace inherits the config defaults
	// enforce=baseline / warn=restricted / audit=restricted.
	const ns = "psa-audit-boundary"
	makeNS(ns, nil)

	// Build a warning-capturing client by reusing the package-local recordingWarningHandler
	// (defined in svcaccttoken_test.go); it implements rest.WarningHandler (copy @432-435).
	warnHandler := &recordingWarningHandler{}
	warnCfg := rest.CopyConfig(server.ClientConfig)
	warnCfg.WarningHandler = warnHandler
	warnClient := kubernetes.NewForConfigOrDie(warnCfg)

	// A plain pod (no securityContext) complies with baseline but violates the restricted
	// profile (missing runAsNonRoot, seccompProfile, drop-ALL caps, allowPrivilegeEscalation=false).
	// A real (non-DryRun) create is used so the audit event is emitted and persisted; the pod is
	// cleaned up below. Storage is isolated by the unique framework.SharedEtcd() prefix.
	restrictedViolatingPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "audit-warn-pod"},
		Spec: corev1.PodSpec{
			ServiceAccountName: "default",
			Containers:         []corev1.Container{{Name: "c", Image: "busybox"}},
		},
	}

	warnHandler.clear()
	created, err := warnClient.CoreV1().Pods(ns).Create(context.TODO(), restrictedViolatingPod, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("expected restricted-violating pod to be ADMITTED under enforce=baseline, got err=%v", err)
	}
	t.Cleanup(func() {
		_ = client.CoreV1().Pods(ns).Delete(context.TODO(), created.Name, metav1.DeleteOptions{})
	})

	// AAP §0.8.1 (V2): warn=restricted surfaces at least one client warning. Read the captured
	// warnings under the embedded mutex (satisfies -race), copying them out for local checks.
	warnHandler.Lock()
	gotWarnings := append([]string(nil), warnHandler.warnings...)
	warnHandler.Unlock()
	if len(gotWarnings) == 0 {
		t.Errorf("expected at least one Pod Security warning under warn=restricted, got none")
	}
	// Boundary specificity: at least one warning references the restricted profile.
	foundRestricted := false
	for _, w := range gotWarnings {
		if strings.Contains(w, "restricted") {
			foundRestricted = true
			break
		}
	}
	if !foundRestricted {
		t.Errorf("expected a warn=restricted warning mentioning %q, got %v", "restricted", gotWarnings)
	}

	// AAP §0.8.1 (V2): audit=restricted records a non-empty
	// pod-security.kubernetes.io/audit-violations annotation on the pods/create audit event.
	// With --audit-log-mode=blocking the event is written before the response returns; the poll
	// below (wait.PollImmediate — an existing helper, not a sleep) only tolerates file-buffer
	// flush timing. Pre-remediation (no audit=restricted default) the annotation is absent and
	// this assertion fails, which is the regression lock.
	const auditViolationsKey = "pod-security.kubernetes.io/audit-violations"
	var lastErr error
	if pollErr := wait.PollImmediate(100*time.Millisecond, 30*time.Second, func() (bool, error) {
		data, readErr := os.ReadFile(auditLogFile.Name())
		if readErr != nil {
			lastErr = readErr
			return false, nil
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var ev auditv1.Event
			if unmarshalErr := json.Unmarshal([]byte(line), &ev); unmarshalErr != nil {
				continue // ignore any non-event line
			}
			if ev.Verb != "create" || ev.ObjectRef == nil {
				continue
			}
			if ev.ObjectRef.Resource != "pods" || ev.ObjectRef.Namespace != ns {
				continue
			}
			if ev.Annotations[auditViolationsKey] != "" {
				return true, nil
			}
		}
		lastErr = fmt.Errorf("no pods/create audit event in namespace %q carried a non-empty %q annotation", ns, auditViolationsKey)
		return false, nil
	}); pollErr != nil {
		t.Errorf("expected audit=restricted to record a %q annotation on the pods/create event: %v", auditViolationsKey, lastErr)
	}
}
