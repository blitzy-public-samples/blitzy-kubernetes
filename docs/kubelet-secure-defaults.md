# Kubelet Secure Authentication and Authorization Defaults

## Overview

Starting with Kubernetes v1.35, the `SecureKubeletDefaults` feature gate introduces
secure-by-default authentication and authorization settings for the kubelet. This document
explains the behavior, migration path, and troubleshooting guidance for cluster operators.

## Background

Historically, the kubelet applied legacy defaults that prioritized backward compatibility:

| Setting | Legacy Default | Implication |
|---------|---------------|-------------|
| `authentication.anonymous.enabled` | `true` | Any unauthenticated request is accepted |
| `authentication.webhook.enabled` | `false` | Token authentication via API server is disabled |
| `authorization.mode` | `AlwaysAllow` | All requests pass authorization regardless of identity |

These defaults allowed any network-reachable client to access the kubelet API without
authentication or authorization, exposing sensitive node and pod information.

## SecureKubeletDefaults Behavior

When the `SecureKubeletDefaults` feature gate is enabled:

### Anonymous Authentication Disabled

- Anonymous requests to the kubelet API receive a `401 Unauthorized` response
- All clients must present valid credentials (client certificate or bearer token)
- Health check endpoints (`/healthz`) also require authentication

### Webhook Authentication Enabled

- Bearer tokens presented to the kubelet are validated against the API server
- The API server acts as the token review backend
- Client certificate authentication remains available as a primary method

### Webhook Authorization

- All authenticated requests are checked against the API server's authorization backend
- The API server evaluates RBAC policies for kubelet API access
- Unauthorized requests receive a `403 Forbidden` response

## Enabling the Feature Gate

### On Individual Kubelets

```bash
kubelet --feature-gates=SecureKubeletDefaults=true
```

### Via Kubelet Configuration File

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  SecureKubeletDefaults: true
```

### Via kubeadm

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  SecureKubeletDefaults: true
```

## Migration Guide for Existing Clusters

### Step 1: Audit Current Kubelet API Consumers

Identify all clients that access the kubelet API:

```bash
# Check for anonymous access patterns in audit logs
grep "system:anonymous" /var/log/kubernetes/audit.log

# List services that access kubelet ports
ss -tlnp | grep -E '10250|10255'
```

Common kubelet API consumers:
- Metrics collection agents (Prometheus node-exporter, Datadog)
- Log aggregators
- Monitoring tools (kubelet /healthz, /pods, /stats)
- kubectl commands (exec, logs, port-forward via API server proxy)

### Step 2: Configure RBAC for Kubelet API Access

Create RBAC rules for legitimate kubelet API consumers:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubelet-api-reader
rules:
- apiGroups: [""]
  resources: ["nodes/proxy", "nodes/stats", "nodes/log", "nodes/metrics"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubelet-api-reader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubelet-api-reader
subjects:
- kind: ServiceAccount
  name: monitoring-agent
  namespace: monitoring
```

### Step 3: Test on a Non-Production Cluster

1. Enable the feature gate on a test cluster
2. Run your full monitoring and operations stack
3. Check for `401` or `403` errors in logs
4. Resolve RBAC issues before production rollout

### Step 4: Enable in Production (Rolling)

1. Enable on one node at a time
2. Monitor for authentication/authorization failures
3. Address any remaining RBAC gaps
4. Continue rolling out to all nodes

## Explicit Opt-Out

If you need to maintain legacy behavior after enabling the feature gate, you can
explicitly override the individual settings:

```bash
kubelet \
  --feature-gates=SecureKubeletDefaults=true \
  --anonymous-auth=true \
  --authentication-token-webhook=false \
  --authorization-mode=AlwaysAllow
```

Note: Explicit command-line flags override the feature gate defaults. However, using
the opt-out is strongly discouraged in production environments.

## Compatibility with Other Features

| Feature | Compatible | Notes |
|---------|-----------|-------|
| Node Authorization | Yes | Works with webhook authorization |
| Pod Security Admission | Yes | Independent enforcement layers |
| Kubelet Certificate Rotation | Yes | Recommended for production |
| Read-Only Port (10255) | Independent | Not affected by this feature gate |

## Troubleshooting

### 401 Unauthorized Errors

**Symptom**: Clients receive `401 Unauthorized` when accessing the kubelet API.

**Cause**: The client is not presenting valid credentials.

**Resolution**:
1. Ensure the client has a valid client certificate or bearer token
2. Verify the certificate is signed by the cluster CA
3. Check that the API server is reachable for webhook token review

```bash
# Test with client certificate
curl --cert /path/to/client.crt --key /path/to/client.key \
  --cacert /path/to/ca.crt \
  https://<node-ip>:10250/healthz
```

### 403 Forbidden Errors

**Symptom**: Authenticated clients receive `403 Forbidden` for kubelet API requests.

**Cause**: The client's identity does not have RBAC permission for the requested resource.

**Resolution**:
1. Check the user or service account identity
2. Verify RBAC rules allow the requested operation
3. Create or update ClusterRole and ClusterRoleBinding as needed

```bash
# Check effective permissions
kubectl auth can-i get nodes/proxy --as=system:serviceaccount:monitoring:prometheus
```

### Webhook Authentication Failures

**Symptom**: Kubelet logs show errors communicating with the API server for authentication.

**Cause**: Network connectivity or configuration issue between kubelet and API server.

**Resolution**:
1. Verify the kubelet can reach the API server
2. Check kubelet kubeconfig file configuration
3. Ensure API server certificates are valid

```bash
# Verify kubelet can reach API server
curl -k https://<apiserver-ip>:6443/healthz
```

### Read-Only Port Still Open

**Symptom**: Port 10255 still accepts unauthenticated requests.

**Cause**: The read-only port is controlled separately from the authenticated port.

**Resolution**:
The `SecureKubeletDefaults` feature gate does not affect the read-only port (10255).
To disable the read-only port:

```bash
kubelet --read-only-port=0
```

## Version History

| Version | Status | Notes |
|---------|--------|-------|
| v1.35 | Alpha | Feature gate introduced, defaults to disabled |
