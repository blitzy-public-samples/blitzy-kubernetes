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

package podsecurity

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apiserver/pkg/admission"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/apiserver/pkg/util/compatibility"
	"k8s.io/apiserver/pkg/warning"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/kubernetes/pkg/apis/apps"
	"k8s.io/kubernetes/pkg/apis/batch"
	"k8s.io/kubernetes/pkg/apis/core"
	v1 "k8s.io/kubernetes/pkg/apis/core/v1"
	podsecurityadmission "k8s.io/pod-security-admission/admission"
	"k8s.io/utils/ptr"
)

func TestConvert(t *testing.T) {
	extractor := podsecurityadmission.DefaultPodSpecExtractor{}
	internalTypes := map[schema.GroupResource]runtime.Object{
		core.Resource("pods"):                   &core.Pod{},
		core.Resource("replicationcontrollers"): &core.ReplicationController{},
		core.Resource("podtemplates"):           &core.PodTemplate{},
		apps.Resource("replicasets"):            &apps.ReplicaSet{},
		apps.Resource("deployments"):            &apps.Deployment{},
		apps.Resource("statefulsets"):           &apps.StatefulSet{},
		apps.Resource("daemonsets"):             &apps.DaemonSet{},
		batch.Resource("jobs"):                  &batch.Job{},
		batch.Resource("cronjobs"):              &batch.CronJob{},
	}
	for _, r := range extractor.PodSpecResources() {
		internalType, ok := internalTypes[r]
		if !ok {
			t.Errorf("no internal type registered for %s", r.String())
			continue
		}
		externalType, err := convert(internalType)
		if err != nil {
			t.Errorf("error converting %T: %v", internalType, err)
			continue
		}
		_, _, err = extractor.ExtractPodSpec(externalType)
		if err != nil {
			t.Errorf("error extracting from %T: %v", externalType, err)
			continue
		}
	}
}

func BenchmarkVerifyPod(b *testing.B) {
	p, err := newPlugin(nil)
	if err != nil {
		b.Fatal(err)
	}

	p.InspectEffectiveVersion(compatibility.DefaultBuildEffectiveVersion())

	enforceImplicitPrivilegedNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "enforce-implicit", Labels: map[string]string{}}}
	enforcePrivilegedNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "enforce-privileged", Labels: map[string]string{"pod-security.kubernetes.io/enforce": "privileged"}}}
	enforceBaselineNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "enforce-baseline", Labels: map[string]string{"pod-security.kubernetes.io/enforce": "baseline"}}}
	enforceRestrictedNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "enforce-restricted", Labels: map[string]string{"pod-security.kubernetes.io/enforce": "restricted"}}}
	warnBaselineNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "warn-baseline", Labels: map[string]string{"pod-security.kubernetes.io/warn": "baseline"}}}
	warnRestrictedNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "warn-restricted", Labels: map[string]string{"pod-security.kubernetes.io/warn": "restricted"}}}
	enforceWarnAuditBaseline := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "enforce-warn-audit-baseline", Labels: map[string]string{"pod-security.kubernetes.io/enforce": "baseline", "pod-security.kubernetes.io/warn": "baseline", "pod-security.kubernetes.io/audit": "baseline"}}}
	warnBaselineAuditRestrictedNamespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "warn-baseline-audit-restricted", Labels: map[string]string{"pod-security.kubernetes.io/warn": "baseline", "pod-security.kubernetes.io/audit": "restricted"}}}
	c := fake.NewSimpleClientset(
		enforceImplicitPrivilegedNamespace,
		enforcePrivilegedNamespace,
		enforceBaselineNamespace,
		enforceRestrictedNamespace,
		warnBaselineNamespace,
		warnRestrictedNamespace,
		enforceWarnAuditBaseline,
		warnBaselineAuditRestrictedNamespace,
	)
	p.SetExternalKubeClientSet(c)

	informerFactory := informers.NewSharedInformerFactory(c, 0)
	p.SetExternalKubeInformerFactory(informerFactory)
	stopCh := make(chan struct{})
	defer close(stopCh)
	informerFactory.Start(stopCh)
	informerFactory.WaitForCacheSync(stopCh)

	if err := p.ValidateInitialization(); err != nil {
		b.Fatal(err)
	}

	corePod := &core.Pod{}
	v1Pod := &corev1.Pod{}
	data, err := os.ReadFile("testdata/pod_restricted.yaml")
	if err != nil {
		b.Fatal(err)
	}
	if err := yaml.Unmarshal(data, v1Pod); err != nil {
		b.Fatal(err)
	}
	if err := v1.Convert_v1_Pod_To_core_Pod(v1Pod, corePod, nil); err != nil {
		b.Fatal(err)
	}

	appsDeployment := &apps.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "mydeployment"},
		Spec: apps.DeploymentSpec{
			Template: core.PodTemplateSpec{
				ObjectMeta: corePod.ObjectMeta,
				Spec:       corePod.Spec,
			},
		},
	}

	namespaces := []string{
		"enforce-implicit", "enforce-privileged", "enforce-baseline", "enforce-restricted",
		"warn-baseline", "warn-restricted",
		"enforce-warn-audit-baseline", "warn-baseline-audit-restricted",
	}
	for _, namespace := range namespaces {
		b.Run(namespace+"_pod", func(b *testing.B) {
			ctx := context.Background()
			attrs := admission.NewAttributesRecord(
				corePod.DeepCopy(), nil,
				schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
				namespace, "mypod",
				schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
				"",
				admission.Create, &metav1.CreateOptions{}, false,
				&user.DefaultInfo{Name: "myuser"},
			)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := p.Validate(ctx, attrs, nil); err != nil {
					b.Fatal(err)
				}
			}
		})

		b.Run(namespace+"_deployment", func(b *testing.B) {
			ctx := context.Background()
			attrs := admission.NewAttributesRecord(
				appsDeployment.DeepCopy(), nil,
				schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"},
				namespace, "mydeployment",
				schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"},
				"",
				admission.Create, &metav1.CreateOptions{}, false,
				&user.DefaultInfo{Name: "myuser"},
			)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := p.Validate(ctx, attrs, nil); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkVerifyNamespace(b *testing.B) {
	p, err := newPlugin(nil)
	if err != nil {
		b.Fatal(err)
	}

	p.InspectEffectiveVersion(compatibility.DefaultBuildEffectiveVersion())

	namespace := "enforce"
	enforceNamespaceBaselineV1 := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace, Labels: map[string]string{"pod-security.kubernetes.io/enforce": "baseline"}}}
	enforceNamespaceRestrictedV1 := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace, Labels: map[string]string{"pod-security.kubernetes.io/enforce": "restricted"}}}

	enforceNamespaceBaselineCore := &core.Namespace{}
	if err := v1.Convert_v1_Namespace_To_core_Namespace(enforceNamespaceBaselineV1, enforceNamespaceBaselineCore, nil); err != nil {
		b.Fatal(err)
	}
	enforceNamespaceRestrictedCore := &core.Namespace{}
	if err := v1.Convert_v1_Namespace_To_core_Namespace(enforceNamespaceRestrictedV1, enforceNamespaceRestrictedCore, nil); err != nil {
		b.Fatal(err)
	}

	v1Pod := &corev1.Pod{}
	data, err := os.ReadFile("testdata/pod_baseline.yaml")
	if err != nil {
		b.Fatal(err)
	}
	if err := yaml.Unmarshal(data, v1Pod); err != nil {
		b.Fatal(err)
	}

	// https://github.com/kubernetes/community/blob/master/sig-scalability/configs-and-limits/thresholds.md#kubernetes-thresholds
	ownerA := metav1.OwnerReference{
		APIVersion: "apps/v1",
		Kind:       "ReplicaSet",
		Name:       "myapp-123123",
		UID:        types.UID("7610a7f4-8f80-4f88-95b5-6cefdd8e9dbd"),
		Controller: ptr.To(true),
	}
	ownerB := metav1.OwnerReference{
		APIVersion: "apps/v1",
		Kind:       "ReplicaSet",
		Name:       "myapp-234234",
		UID:        types.UID("7610a7f4-8f80-4f88-95b5-as765as76f55"),
		Controller: ptr.To(true),
	}

	// number of warnings printed for the entire namespace
	namespaceWarningCount := 1

	podCount := 3000
	objects := make([]runtime.Object, 0, podCount+1)
	objects = append(objects, enforceNamespaceBaselineV1)
	for i := 0; i < podCount; i++ {
		v1PodCopy := v1Pod.DeepCopy()
		v1PodCopy.Name = fmt.Sprintf("pod%d", i)
		v1PodCopy.UID = types.UID(fmt.Sprintf("pod%d", i))
		v1PodCopy.Namespace = namespace
		switch i % 3 {
		case 0:
			v1PodCopy.OwnerReferences = []metav1.OwnerReference{ownerA}
		case 1:
			v1PodCopy.OwnerReferences = []metav1.OwnerReference{ownerB}
		default:
			// no owner references
		}
		objects = append(objects, v1PodCopy)
	}

	c := fake.NewSimpleClientset(
		objects...,
	)
	p.SetExternalKubeClientSet(c)

	informerFactory := informers.NewSharedInformerFactory(c, 0)
	p.SetExternalKubeInformerFactory(informerFactory)
	stopCh := make(chan struct{})
	defer close(stopCh)
	informerFactory.Start(stopCh)
	informerFactory.WaitForCacheSync(stopCh)

	if err := p.ValidateInitialization(); err != nil {
		b.Fatal(err)
	}

	ctx := context.Background()
	attrs := admission.NewAttributesRecord(
		enforceNamespaceRestrictedCore.DeepCopy(), enforceNamespaceBaselineCore.DeepCopy(),
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Namespace"},
		namespace, namespace,
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"},
		"",
		admission.Update, &metav1.UpdateOptions{}, false,
		&user.DefaultInfo{Name: "myuser"},
	)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		dc := dummyRecorder{agent: "", text: ""}
		ctxWithRecorder := warning.WithWarningRecorder(ctx, &dc)
		if err := p.Validate(ctxWithRecorder, attrs, nil); err != nil {
			b.Fatal(err)
		}
		// should either be a single aggregated warning, or a unique warning per pod
		if dc.count != (1+namespaceWarningCount) && dc.count != (podCount+namespaceWarningCount) {
			b.Fatalf("expected either %d or %d warnings, got %d", 1+namespaceWarningCount, podCount+namespaceWarningCount, dc.count)
		}
		// warning should contain the runAsNonRoot issue
		if e, a := "runAsNonRoot", dc.text; !strings.Contains(a, e) {
			b.Fatalf("expected warning containing %q, got %q", e, a)
		}
	}
}

type dummyRecorder struct {
	count int
	agent string
	text  string
}

func (r *dummyRecorder) AddWarning(agent, text string) {
	r.count++
	r.agent = agent
	r.text = text
	return
}

var _ warning.Recorder = &dummyRecorder{}

// TestPodSecurityEnforceBaselineRejectsHostNetwork drives the real
// Plugin.Validate decision path in-process (no API server): a pod requesting
// hostNetwork:true, created in a namespace labeled enforce=baseline, is rejected
// with a Forbidden error. This is an API-server-free unit complement to the
// integration test test/integration/auth/podsecurity_test.go::TestPodSecurityEnforceBaselineRejectsPrivileged
// (which uses privileged/hostPID pods); hostNetwork is a DISTINCT baseline
// "Host Namespaces" violation, so this does not duplicate the frozen scenario.
// AAP §0.8.1 (V2): enforce=baseline must reject a hostNetwork:true pod (Forbidden).
func TestPodSecurityEnforceBaselineRejectsHostNetwork(t *testing.T) {
	p, err := newPlugin(nil)
	if err != nil {
		t.Fatal(err)
	}
	p.InspectEffectiveVersion(compatibility.DefaultBuildEffectiveVersion())

	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "enforce-baseline", Labels: map[string]string{"pod-security.kubernetes.io/enforce": "baseline"}}}
	c := fake.NewSimpleClientset(ns)
	p.SetExternalKubeClientSet(c)
	informerFactory := informers.NewSharedInformerFactory(c, 0)
	p.SetExternalKubeInformerFactory(informerFactory)
	stopCh := make(chan struct{})
	defer close(stopCh)
	informerFactory.Start(stopCh)
	informerFactory.WaitForCacheSync(stopCh)
	if err := p.ValidateInitialization(); err != nil {
		t.Fatal(err)
	}

	// The pod passed to NewAttributesRecord is the INTERNAL *core.Pod; convert a
	// v1 pod with hostNetwork:true (and one container so the PodSpec is valid).
	corePod := &core.Pod{}
	v1Pod := &corev1.Pod{Spec: corev1.PodSpec{HostNetwork: true, Containers: []corev1.Container{{Name: "c", Image: "busybox"}}}}
	if err := v1.Convert_v1_Pod_To_core_Pod(v1Pod, corePod, nil); err != nil {
		t.Fatal(err)
	}

	attrs := admission.NewAttributesRecord(
		corePod, nil,
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
		ns.Name, "mypod",
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
		"", admission.Create, &metav1.CreateOptions{}, false,
		&user.DefaultInfo{Name: "myuser"},
	)
	err = p.Validate(context.Background(), attrs, nil)
	if err == nil {
		t.Fatalf("expected hostNetwork:true pod to be rejected by enforce=baseline, got err=nil")
	}
	if !apierrors.IsForbidden(err) {
		t.Errorf("expected a Forbidden error from enforce=baseline, got %v", err)
	}
}

// TestPodSecurityUnlabeledNamespaceDefaultsPrivileged is the positive-path
// counterpart to TestPodSecurityEnforceBaselineRejectsHostNetwork: the SAME
// hostNetwork:true pod is ADMITTED in a namespace carrying no pod-security
// labels, because a label-less namespace inherits the cluster default level
// (privileged), which permits host namespaces. Together these two tests lock
// BOTH directions of the enforce decision on the identical pod.
// AAP §0.8.1 (V2): a label-less namespace defaults to privileged and admits a hostNetwork:true pod.
func TestPodSecurityUnlabeledNamespaceDefaultsPrivileged(t *testing.T) {
	p, err := newPlugin(nil)
	if err != nil {
		t.Fatal(err)
	}
	p.InspectEffectiveVersion(compatibility.DefaultBuildEffectiveVersion())

	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "unlabeled", Labels: map[string]string{}}}
	c := fake.NewSimpleClientset(ns)
	p.SetExternalKubeClientSet(c)
	informerFactory := informers.NewSharedInformerFactory(c, 0)
	p.SetExternalKubeInformerFactory(informerFactory)
	stopCh := make(chan struct{})
	defer close(stopCh)
	informerFactory.Start(stopCh)
	informerFactory.WaitForCacheSync(stopCh)
	if err := p.ValidateInitialization(); err != nil {
		t.Fatal(err)
	}

	corePod := &core.Pod{}
	v1Pod := &corev1.Pod{Spec: corev1.PodSpec{HostNetwork: true, Containers: []corev1.Container{{Name: "c", Image: "busybox"}}}}
	if err := v1.Convert_v1_Pod_To_core_Pod(v1Pod, corePod, nil); err != nil {
		t.Fatal(err)
	}

	attrs := admission.NewAttributesRecord(
		corePod, nil,
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
		ns.Name, "mypod",
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
		"", admission.Create, &metav1.CreateOptions{}, false,
		&user.DefaultInfo{Name: "myuser"},
	)
	if err := p.Validate(context.Background(), attrs, nil); err != nil {
		t.Errorf("expected hostNetwork:true pod to be admitted in a label-less (privileged-default) namespace, got err=%v", err)
	}
}

// TestPodSecurityWarnLevelSurfacesRestrictedViolation verifies that a pod which
// is baseline-compliant but restricted-violating (a plain pod with no
// securityContext — missing runAsNonRoot/seccompProfile/drop-ALL) is ADMITTED in
// a namespace labeled warn=restricted (enforce inherits the privileged default),
// while a non-empty warning is surfaced through the warning recorder. This
// asserts BOTH the admit path and the warn-surfacing behavior.
// AAP §0.8.1 (V2): warn=restricted admits a restricted-violating pod but surfaces a warning.
func TestPodSecurityWarnLevelSurfacesRestrictedViolation(t *testing.T) {
	p, err := newPlugin(nil)
	if err != nil {
		t.Fatal(err)
	}
	p.InspectEffectiveVersion(compatibility.DefaultBuildEffectiveVersion())

	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "warn-restricted", Labels: map[string]string{"pod-security.kubernetes.io/warn": "restricted"}}}
	c := fake.NewSimpleClientset(ns)
	p.SetExternalKubeClientSet(c)
	informerFactory := informers.NewSharedInformerFactory(c, 0)
	p.SetExternalKubeInformerFactory(informerFactory)
	stopCh := make(chan struct{})
	defer close(stopCh)
	informerFactory.Start(stopCh)
	informerFactory.WaitForCacheSync(stopCh)
	if err := p.ValidateInitialization(); err != nil {
		t.Fatal(err)
	}

	// A plain pod (no securityContext) complies with baseline but violates the
	// restricted profile, so warn=restricted admits it yet emits a warning.
	corePod := &core.Pod{}
	v1Pod := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "busybox"}}}}
	if err := v1.Convert_v1_Pod_To_core_Pod(v1Pod, corePod, nil); err != nil {
		t.Fatal(err)
	}

	attrs := admission.NewAttributesRecord(
		corePod, nil,
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
		ns.Name, "mypod",
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
		"", admission.Create, &metav1.CreateOptions{}, false,
		&user.DefaultInfo{Name: "myuser"},
	)
	// Attach a warning recorder exactly like BenchmarkVerifyNamespace (l283-284).
	dc := dummyRecorder{}
	ctxWithRecorder := warning.WithWarningRecorder(context.Background(), &dc)
	if err := p.Validate(ctxWithRecorder, attrs, nil); err != nil {
		t.Errorf("expected restricted-violating pod to be admitted under warn=restricted (enforce=privileged default), got err=%v", err)
	}
	if dc.count == 0 || dc.text == "" {
		t.Errorf("expected a non-empty PodSecurity warning to be surfaced, got count=%d text=%q", dc.count, dc.text)
	}
}
