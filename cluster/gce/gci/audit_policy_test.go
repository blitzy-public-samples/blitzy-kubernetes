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
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"k8s.io/apiserver/pkg/apis/audit"
	auditinstall "k8s.io/apiserver/pkg/apis/audit/install"
	auditpkg "k8s.io/apiserver/pkg/audit"
	auditpolicy "k8s.io/apiserver/pkg/audit/policy"
	"k8s.io/apiserver/pkg/authentication/serviceaccount"
	"k8s.io/apiserver/pkg/authentication/user"
	"k8s.io/apiserver/pkg/authorization/authorizer"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func init() {
	// Register audit scheme to parse audit config.
	auditinstall.Install(auditpkg.Scheme)
}

// TestCreateMasterAuditPolicy verifies the audit policy emitted by
// create-master-audit-policy assigns the intended audit level per (user, verb,
// resource) — most importantly the V6 sensitive-resource levels.
// AAP §6.6.10 / §0.8.1 (V6) + §6.4.6 / §0.6.3: Secrets and ServiceAccount-token
// operations are raised to Request (forensic coverage without logging response
// payloads, the Request-over-RequestResponse trade-off), configmaps and
// tokenreviews stay at Metadata, and RBAC objects stay at RequestResponse.
func TestCreateMasterAuditPolicy(t *testing.T) {
	baseDir, err := os.MkdirTemp("", "configure-helper-test") // cleaned up by c.tearDown()
	require.NoError(t, err, "Failed to create temp directory")

	policyFile := filepath.Join(baseDir, "audit_policy.yaml")
	c := ManifestTestCase{
		t:                t,
		kubeHome:         baseDir,
		manifestFuncName: fmt.Sprintf("create-master-audit-policy %s", policyFile),
	}
	defer c.tearDown()

	// Initialize required environment variables.
	c.mustInvokeFunc(
		kubeAPIServerEnv{KubeHome: c.kubeHome},
		[]string{"configure-helper.sh"},
		"base.template",
		"testdata/kube-apiserver/base.template",
	)

	policy, err := auditpolicy.LoadPolicyFromFile(policyFile)
	require.NoError(t, err, "Failed to load generated policy.")

	// Users for test cases
	var (
		anonymous           = newUserInfo(user.Anonymous, user.AllUnauthenticated)
		kubeproxy           = newUserInfo(user.KubeProxy, user.AllAuthenticated)
		ingress             = newUserInfo("system:unsecured", user.AllAuthenticated, user.SystemPrivilegedGroup)
		kubelet             = newUserInfo("kubelet", user.AllAuthenticated, user.NodesGroup)
		node                = newUserInfo("system:node:node-123", user.AllAuthenticated, user.NodesGroup)
		controller          = newUserInfo(user.KubeControllerManager, user.AllAuthenticated)
		scheduler           = newUserInfo(user.KubeScheduler, user.AllAuthenticated)
		apiserver           = newUserInfo(user.APIServerUser, user.SystemPrivilegedGroup)
		autoscaler          = newUserInfo("cluster-autoscaler", user.AllAuthenticated)
		npd                 = newUserInfo("system:node-problem-detector", user.AllAuthenticated)
		npdSA               = serviceaccount.UserInfo("kube-system", "node-problem-detector", "")
		namespaceController = serviceaccount.UserInfo("kube-system", "namespace-controller", "")
		endpointController  = serviceaccount.UserInfo("kube-system", "endpoint-controller", "")
		defaultSA           = serviceaccount.UserInfo("default", "default", "")

		allUsers = []user.Info{anonymous, kubeproxy, ingress, kubelet, node, controller, scheduler, apiserver, autoscaler, npd, npdSA, namespaceController, endpointController, defaultSA}
	)

	// Resources for test cases
	var (
		nodes           = resource("nodes")
		nodeStatus      = resource("nodes", "", "", "status")
		endpoints       = resource("endpoints", "default")
		sysEndpoints    = resource("endpoints", "kube-system")
		services        = resource("services", "default")
		serviceStatus   = resource("services", "default", "", "status")
		configmaps      = resource("configmaps", "default")
		sysConfigmaps   = resource("configmaps", "kube-system")
		namespaces      = resource("namespaces")
		namespaceStatus = resource("namespaces", "", "", "status")
		namespaceFinal  = resource("namespaces", "", "", "finalize")
		podMetrics      = resource("podmetrics", "default", "metrics.k8s.io")
		nodeMetrics     = resource("nodemetrics", "", "metrics.k8s.io")
		pods            = resource("pods", "default")
		podStatus       = resource("pods", "default", "", "status")
		secrets         = resource("secrets", "default")
		saTokens        = resource("serviceaccounts", "default", "", "token")
		tokenReviews    = resource("tokenreviews", "", "authentication.k8s.io")
		deployments     = resource("deployments", "default", "apps")
		clusterRoles    = resource("clusterroles", "", "rbac.authorization.k8s.io")
		events          = resource("events", "default")
		foobars         = resource("foos", "default", "example.com")
		foobarbaz       = resource("foos", "default", "example.com", "baz")
	)

	// Aliases
	const (
		none     = audit.LevelNone
		metadata = audit.LevelMetadata
		request  = audit.LevelRequest
		response = audit.LevelRequestResponse
	)

	at := auditTester{
		T:         t,
		evaluator: auditpolicy.NewPolicyRuleEvaluator(policy),
	}

	at.testResources(none, kubeproxy, "watch", endpoints, sysEndpoints, services, serviceStatus)
	at.testResources(request, kubeproxy, "watch", nodes, pods)

	at.testResources(none, ingress, "get", sysConfigmaps)
	at.testResources(metadata, ingress, "get", configmaps)

	at.testResources(none, kubelet, node, "get", nodes, nodeStatus)
	// secrets are raised from Metadata to Request by create-master-audit-policy per the V6
	// mandate (tech-spec §6.4.6, AAP §0.6.3 / §0.5.1); a get carries no payload in the
	// (omitted) response object, so read paths log no secret data. sysConfigmaps stays Metadata.
	at.testResources(metadata, kubelet, node, "get", sysConfigmaps)
	at.testResources(request, kubelet, node, "get", secrets)
	at.testResources(response, kubelet, node, "create", deployments, pods)

	at.testResources(none, controller, scheduler, endpointController, "get", "update", sysEndpoints)
	at.testResources(request, controller, scheduler, endpointController, "get", endpoints)
	at.testResources(response, controller, scheduler, endpointController, "update", endpoints)

	at.testResources(none, apiserver, "get", namespaces, namespaceStatus, namespaceFinal)
	// secrets audited at Request per the V6 mandate (§6.4.6, AAP §0.6.3 / §0.5.1): Request
	// records the request object but omits the response object, so get/list never log secret
	// data; create/update log the request body (the accepted trade-off, AAP §0.2.4).
	// sysConfigmaps stays Metadata.
	at.testResources(metadata, apiserver, "get", "create", "update", sysConfigmaps)
	at.testResources(request, apiserver, "get", "create", "update", secrets)

	at.testResources(none, autoscaler, "get", "update", sysConfigmaps, sysEndpoints)
	at.testResources(metadata, autoscaler, "get", "update", configmaps)
	at.testResources(response, autoscaler, "update", endpoints)

	at.testResources(none, controller, "get", "list", podMetrics, nodeMetrics)

	at.testNonResources(none, allUsers, "/healthz", "/healthz/etcd", "/swagger-2.0.0.json", "/swagger-2.0.0.pb-v1.gz", "/version")
	at.testNonResources(metadata, allUsers, "/logs", "/openapi/v2", "/apis/policy", "/metrics", "/api")

	at.testResources(none, node, apiserver, defaultSA, anonymous, "get", "list", "create", "patch", "update", "delete", events)

	at.testResources(request, kubelet, node, npd, npdSA, "update", "patch", nodeStatus, podStatus)

	at.testResources(request, namespaceController, "deletecollection", pods, namespaces)

	// configmaps, sysConfigmaps and tokenReviews remain Metadata (§6.4.6, AAP §0.6.3), while
	// secrets and serviceaccounts/token are raised to Request per the V6 mandate (AAP §0.6.3 /
	// §0.5.1). Request omits the response object, so a token's issued credential (response-only)
	// and secret read payloads (response-only) are never written to the audit log.
	at.testResources(metadata, defaultSA, anonymous, npd, namespaceController, "get", "create", "update", configmaps, sysConfigmaps, tokenReviews)
	at.testResources(request, defaultSA, anonymous, npd, namespaceController, "get", "create", "update", secrets)
	at.testResources(request, defaultSA, apiserver, "create", saTokens)
	at.testResources(request, defaultSA, anonymous, npd, namespaceController, "get", "list", "watch", sysEndpoints, podMetrics, pods, clusterRoles, deployments)
	at.testResources(response, defaultSA, anonymous, npd, namespaceController, "create", "update", "patch", "delete", sysEndpoints, podMetrics, pods, clusterRoles, deployments)

	at.testResources(metadata, defaultSA, anonymous, npd, namespaceController, "get", "list", "watch", "create", "update", "patch", "delete", foobars, foobarbaz)
}

type auditTester struct {
	*testing.T
	evaluator auditpkg.PolicyRuleEvaluator
}

func (t *auditTester) testResources(level audit.Level, usrVerbRes ...interface{}) {
	verbs := []string{}
	users := []user.Info{}
	resources := []Resource{}
	for _, arg := range usrVerbRes {
		switch v := arg.(type) {
		case string:
			verbs = append(verbs, v)
		case user.Info:
			users = append(users, v)
		case Resource:
			resources = append(resources, v)
		default:
			t.Fatalf("Invalid test argument: %+v", arg)
		}
	}
	require.NotEmpty(t, verbs, "testcases must have a verb")
	require.NotEmpty(t, users, "testcases must have a user")
	require.NotEmpty(t, resources, "resource testcases must have a resource")

	for _, usr := range users {
		for _, verb := range verbs {
			for _, res := range resources {
				attrs := &authorizer.AttributesRecord{
					User:            usr,
					Verb:            verb,
					Namespace:       res.Namespace,
					APIGroup:        res.Group,
					APIVersion:      "v1",
					Resource:        res.Resource,
					Subresource:     res.Subresource,
					ResourceRequest: true,
				}
				t.expectLevel(level, attrs)
			}
		}
	}
}

func (t *auditTester) testNonResources(level audit.Level, users []user.Info, paths ...string) {
	for _, usr := range users {
		for _, verb := range []string{"get", "post"} {
			for _, path := range paths {
				attrs := &authorizer.AttributesRecord{
					User:            usr,
					Verb:            verb,
					ResourceRequest: false,
					Path:            path,
				}
				t.expectLevel(level, attrs)
			}
		}
	}
}

func (t *auditTester) expectLevel(expected audit.Level, attrs authorizer.Attributes) {
	obj := attrs.GetPath()
	if attrs.IsResourceRequest() {
		obj = attrs.GetResource()
		if attrs.GetNamespace() != "" {
			obj = obj + ":" + attrs.GetNamespace()
		}
	}
	name := fmt.Sprintf("%s.%s.%s", attrs.GetUser().GetName(), attrs.GetVerb(), obj)
	evaluator := t.evaluator
	t.Run(name, func(t *testing.T) {
		auditConfig := evaluator.EvaluatePolicyRule(attrs)
		assert.Equal(t, expected, auditConfig.Level)
		if auditConfig.Level != audit.LevelNone {
			assert.ElementsMatch(t, auditConfig.OmitStages, []audit.Stage{audit.StageRequestReceived})
		}
	})
}

func newUserInfo(name string, groups ...string) user.Info {
	return &user.DefaultInfo{
		Name:   name,
		Groups: groups,
	}
}

type Resource struct {
	Group, Resource, Subresource, Namespace string
}

func resource(kind string, nsGroupSub ...string) Resource {
	res := Resource{Resource: kind}
	if len(nsGroupSub) > 0 {
		res.Namespace = nsGroupSub[0]
	}
	if len(nsGroupSub) > 1 {
		res.Group = nsGroupSub[1]
	}
	if len(nsGroupSub) > 2 {
		res.Subresource = nsGroupSub[2]
	}
	return res
}

// TestAuditPolicyLevelTableNoRaise is a focused, self-contained V6 regression lock: it loads
// its own copy of the audit policy generated by create-master-audit-policy and asserts that
// Secrets and serviceaccounts/token are audited at Request for every verb, while proving the
// raise did NOT leak to neighbouring resources (configmaps and tokenreviews stay at Metadata;
// ordinary resources keep the documented Request-for-reads / RequestResponse-for-writes
// defaults). It deliberately reloads its own policy and asserts an independent, minimal table
// rather than depending on TestCreateMasterAuditPolicy's state.
// AAP §6.6.10 / §0.8.1 (V6) + §6.4.x
func TestAuditPolicyLevelTableNoRaise(t *testing.T) {
	baseDir, err := os.MkdirTemp("", "configure-helper-test") // cleaned up by c.tearDown()
	require.NoError(t, err, "Failed to create temp directory")

	policyFile := filepath.Join(baseDir, "audit_policy.yaml")
	c := ManifestTestCase{
		t:                t,
		kubeHome:         baseDir,
		manifestFuncName: fmt.Sprintf("create-master-audit-policy %s", policyFile),
	}
	defer c.tearDown()

	// Generate the real audit policy by invoking create-master-audit-policy from the
	// unmodified configure-helper.sh (read-only; no shell edits), exactly as the sibling
	// TestCreateMasterAuditPolicy does.
	c.mustInvokeFunc(
		kubeAPIServerEnv{KubeHome: c.kubeHome},
		[]string{"configure-helper.sh"},
		"base.template",
		"testdata/kube-apiserver/base.template",
	)

	policy, err := auditpolicy.LoadPolicyFromFile(policyFile)
	require.NoError(t, err, "Failed to load generated policy.")

	at := auditTester{
		T:         t,
		evaluator: auditpolicy.NewPolicyRuleEvaluator(policy),
	}

	// Level aliases (mirror the existing test's naming for readability).
	const (
		metadata = audit.LevelMetadata
		request  = audit.LevelRequest
		response = audit.LevelRequestResponse
	)

	// Generic users that are not matched by any user-scoped rule, so the resolved audit level
	// is governed purely by the resource/verb catch-all rules.
	anonymous := newUserInfo(user.Anonymous, user.AllUnauthenticated)
	defaultSA := serviceaccount.UserInfo("default", "default", "")

	// Resources under test. resource(kind, namespace, group, subresource).
	secrets := resource("secrets", "default")
	saTokens := resource("serviceaccounts", "default", "", "token") // subresource "token"
	configmaps := resource("configmaps", "default")
	tokenReviews := resource("tokenreviews", "", "authentication.k8s.io")
	clusterRoles := resource("clusterroles", "", "rbac.authorization.k8s.io")
	roles := resource("roles", "default", "rbac.authorization.k8s.io")
	deployments := resource("deployments", "default", "apps")
	pods := resource("pods", "default")

	// V6 raise (regression lock): Secrets and serviceaccounts/token are audited at Request for
	// ALL verbs. Pre-remediation these resolved to Metadata (secrets) or RequestResponse (token
	// write), so asserting Request FAILS against the unhardened config and PASSES against the
	// current hardened policy — proving the control, not the harness. expectLevel additionally
	// confirms OmitStages == [RequestReceived], so the response object (issued token / secret
	// payload) is never written to the audit log.
	at.testResources(request, defaultSA, anonymous, "get", "list", "watch", "create", "update", "patch", "delete", secrets)
	at.testResources(request, defaultSA, "create", saTokens)

	// No-other-resource-raised guard: configmaps and tokenreviews are NOT part of the V6 raise;
	// they remain pinned at Metadata (NOT Request). A broad or leaked raise would fail here.
	at.testResources(metadata, defaultSA, anonymous, "get", "create", "update", configmaps, tokenReviews)

	// Ordinary resources keep the documented default — Request for reads, RequestResponse for
	// writes — and were NOT specially raised to Request-for-all-verbs like the sensitive set.
	at.testResources(request, defaultSA, anonymous, "get", "list", "watch", pods, deployments, clusterRoles, roles)
	at.testResources(response, defaultSA, anonymous, "create", "update", "patch", "delete", pods, deployments, clusterRoles, roles)
}
