/*
Copyright 2025 The Kubernetes Authors.

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
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
	kubeapiservertesting "k8s.io/kubernetes/cmd/kube-apiserver/app/testing"
	"k8s.io/kubernetes/test/integration/framework"
	"k8s.io/utils/ptr"
)

// TestAdmissionWebhookFailClosedDeniesUnreachable verifies that an admission webhook
// registered with failurePolicy: Fail and timeoutSeconds: 5, pointing at an unreachable
// endpoint, causes a matching persistentvolumes CREATE to be DENIED (fail closed), while a
// non-matching object bypasses the webhook via matchConditions and is admitted.
//
// This locks weakness V5 (admission-webhook fail-closed): the hardened control MUST reject a
// request whose matching webhook cannot be reached, rather than silently admitting it. The test
// mirrors the shape of the committed cluster/gce/addons/cloud-pvl-admission webhook configuration
// (failurePolicy: Fail, timeoutSeconds: 5, sideEffects: None, matchConditions on
// spec.gcePersistentDisk, CREATE persistentvolumes) programmatically, installs it against the real
// in-process API server pointed at the intentionally-unreachable https://127.0.0.1:9001/admit
// endpoint (no backend is ever started), and asserts the resulting deny/allow outcome directly —
// no sleeps or wall-clock waits are used.
//
// Regression lock:
//   - Deny scenario: if the API server were to fail *open* on the unreachable Fail webhook
//     (silently admitting the matching PV), the require.Error assertion would fail.
//   - Bypass scenario: if matchConditions were ignored (or evaluated open), the non-matching
//     hostPath PV would also be intercepted and denied, so the require.NoError assertion would fail.
//
// Only the webhook endpoint is faked; the API server and etcd are real
// (StartTestServerOrDie + framework.SharedEtcd()).
//
// AAP §6.6.10 / §0.8.1 (V5) + §6.4.x
func TestAdmissionWebhookFailClosedDeniesUnreachable(t *testing.T) {
	// Start the REAL in-process API server backed by the shared embedded etcd. Each
	// framework.SharedEtcd() call returns a unique uuid-based storage prefix, so this test's
	// webhook configuration is naturally isolated from any concurrent integration test.
	// framework.DefaultTestServerFlags() enables the ValidatingAdmissionWebhook admission plugin
	// (proven by the broken_webhook integration precedent), which is exactly what this test needs.
	server := kubeapiservertesting.StartTestServerOrDie(t, nil, framework.DefaultTestServerFlags(), framework.SharedEtcd())
	defer server.TearDownFn()

	client, err := kubernetes.NewForConfig(server.ClientConfig)
	require.NoError(t, err, "failed to build clientset from server.ClientConfig")

	ctx := context.Background()

	// Reproduce the committed cloud-pvl-admission webhook shape programmatically. A
	// ValidatingWebhookConfiguration is used (rather than Mutating) because it needs no patch
	// response and produces the identical fail-closed deny on an unreachable Fail endpoint.
	fail := admissionregistrationv1.Fail
	none := admissionregistrationv1.SideEffectClassNone
	scopeAll := admissionregistrationv1.AllScopes // "*"

	webhookCfg := &admissionregistrationv1.ValidatingWebhookConfiguration{
		ObjectMeta: metav1.ObjectMeta{Name: "cloud-pvl-admission-failclosed.k8s.io"},
		Webhooks: []admissionregistrationv1.ValidatingWebhook{{
			// The webhook Name is surfaced verbatim in the fail-closed error
			// (`failed calling webhook "cloud-pvl-admission.k8s.io": ...`) and is the stable
			// substring the deny assertion keys on.
			Name: "cloud-pvl-admission.k8s.io",
			Rules: []admissionregistrationv1.RuleWithOperations{{
				Operations: []admissionregistrationv1.OperationType{admissionregistrationv1.Create},
				Rule: admissionregistrationv1.Rule{
					APIGroups:   []string{""},
					APIVersions: []string{"v1"},
					Resources:   []string{"persistentvolumes"},
					Scope:       &scopeAll,
				},
			}},
			ClientConfig: admissionregistrationv1.WebhookClientConfig{
				// Intentionally unreachable: nothing listens on 127.0.0.1:9001 in the test
				// environment, so the connection is refused before any TLS handshake, which is
				// why no CABundle is required.
				URL:      ptr.To("https://127.0.0.1:9001/admit"),
				CABundle: nil,
			},
			// matchConditions scopes the webhook to PVs backed by a GCE persistent disk, exactly
			// like the committed configuration. AdmissionWebhookMatchConditions is GA/on-by-default,
			// so no feature-gate wiring is needed.
			MatchConditions: []admissionregistrationv1.MatchCondition{{
				Name:       "only-gce",
				Expression: "has(object.spec.gcePersistentDisk)",
			}},
			FailurePolicy:           &fail,
			SideEffects:             &none,
			AdmissionReviewVersions: []string{"v1"},
			TimeoutSeconds:          ptr.To(int32(5)),
		}},
	}

	_, err = client.AdmissionregistrationV1().ValidatingWebhookConfigurations().Create(ctx, webhookCfg, metav1.CreateOptions{})
	require.NoError(t, err, "failed to register fail-closed webhook configuration")
	defer func() {
		// Hygiene only — the unique uuid etcd prefix already isolates this test.
		_ = client.AdmissionregistrationV1().ValidatingWebhookConfigurations().Delete(context.Background(), webhookCfg.Name, metav1.DeleteOptions{})
	}()

	// Wait for the webhook configuration to propagate into the admission chain WITHOUT sleeping.
	// A DryRun CREATE of a matching PV still invokes sideEffects: None webhooks but persists
	// nothing, so it reliably detects establishment: once the webhook is engaged, the DryRun
	// create begins failing with the webhook-call error. Reusing the same probe name each
	// iteration is safe precisely because DryRun never persists.
	require.NoError(t, wait.PollUntilContextTimeout(ctx, 100*time.Millisecond, 30*time.Second, true,
		func(ctx context.Context) (bool, error) {
			_, e := client.CoreV1().PersistentVolumes().Create(ctx, failClosedMatchingPV("v5-failclosed-probe"),
				metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}})
			if e != nil && strings.Contains(e.Error(), "cloud-pvl-admission.k8s.io") {
				return true, nil // webhook is established and failing closed
			}
			return false, nil
		}),
		"timed out waiting for the fail-closed webhook to become effective")

	// PRIMARY (fail-closed): a matching persistentvolumes CREATE must be DENIED, not silently
	// admitted, because the Fail webhook's endpoint is unreachable.
	_, err = client.CoreV1().PersistentVolumes().Create(ctx, failClosedMatchingPV("v5-failclosed-denied"), metav1.CreateOptions{})
	require.Error(t, err, "matching persistentvolumes CREATE must be DENIED by the fail-closed webhook, not silently admitted")
	assert.ErrorContains(t, err, "cloud-pvl-admission.k8s.io")
	// The dispatcher wraps an unreachable Fail webhook as an Internal error (apierrors.NewInternalError),
	// so the deny surfaces as a 500-class Internal error to the client.
	assert.True(t, apierrors.IsInternalError(err), "fail-closed webhook denial should surface as an Internal error")

	// EDGE (bypass): a non-matching PV (no spec.gcePersistentDisk) must be SKIPPED by the webhook
	// via matchConditions and therefore admitted, proving the match-scoping mirrored from the
	// committed cloud-pvl-admission configuration.
	pv, err := client.CoreV1().PersistentVolumes().Create(ctx, failClosedNonMatchingPV("v5-failclosed-bypass"), metav1.CreateOptions{})
	require.NoError(t, err, "non-matching PV (no spec.gcePersistentDisk) must bypass the webhook via matchConditions and be admitted")
	defer func() {
		_ = client.CoreV1().PersistentVolumes().Delete(context.Background(), pv.Name, metav1.DeleteOptions{})
	}()
}

// failClosedMatchingPV builds a PersistentVolume whose spec.gcePersistentDisk is set, so the
// webhook's matchConditions expression has(object.spec.gcePersistentDisk) evaluates TRUE and the
// (unreachable) webhook is invoked.
func failClosedMatchingPV(name string) *corev1.PersistentVolume {
	return &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: corev1.PersistentVolumeSpec{
			Capacity:    corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")},
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			PersistentVolumeSource: corev1.PersistentVolumeSource{
				GCEPersistentDisk: &corev1.GCEPersistentDiskVolumeSource{PDName: "test-pd"},
			},
		},
	}
}

// failClosedNonMatchingPV builds a PersistentVolume backed by hostPath (no gcePersistentDisk), so
// the webhook's matchConditions expression evaluates FALSE and the webhook is skipped entirely.
func failClosedNonMatchingPV(name string) *corev1.PersistentVolume {
	return &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: corev1.PersistentVolumeSpec{
			Capacity:    corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")},
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			PersistentVolumeSource: corev1.PersistentVolumeSource{
				HostPath: &corev1.HostPathVolumeSource{Path: "/tmp/pv-v5"},
			},
		},
	}
}
