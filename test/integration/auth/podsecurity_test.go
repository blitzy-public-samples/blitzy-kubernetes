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
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
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
