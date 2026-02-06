# Security Hardening Migration Guide

## Overview

Kubernetes v1.35 introduces three alpha feature gates that change security-sensitive defaults.
This guide provides a step-by-step migration path for upgrading existing clusters, including
rollback procedures and a compatibility matrix.

## Affected Kubernetes Versions

| Feature Gate | Introduced | Alpha | Target Beta | Target GA |
|-------------|-----------|-------|-------------|-----------|
| `StrictTLSVerification` | v1.35 | v1.35 | v1.37 | v1.39 |
| `DisablePrivilegedByDefault` | v1.35 | v1.35 | v1.37 | v1.39 |
| `SecureKubeletDefaults` | v1.35 | v1.35 | v1.37 | v1.39 |

## Compatibility Matrix

| Component | Min Version | StrictTLS | DisablePriv | SecureKubelet |
|-----------|------------|-----------|-------------|---------------|
| kube-apiserver | v1.35+ | Supported | N/A | N/A |
| kubelet | v1.35+ | Supported | Supported | Supported |
| kube-controller-manager | v1.35+ | N/A | N/A | N/A |
| kube-scheduler | v1.35+ | N/A | N/A | N/A |
| kubectl | Any | N/A | N/A | N/A |
| kubeadm | v1.35+ | N/A | N/A | Supported |
| client-go | v1.35+ | N/A | N/A | N/A |

## Pre-Upgrade Checklist

Before upgrading to v1.35 and enabling any security feature gates, complete the following:

### Infrastructure Assessment

- [ ] All nodes are running Kubernetes v1.35 or later
- [ ] Internal component certificates are valid and signed by cluster CA
- [ ] API server is reachable from all kubelets (for webhook auth)
- [ ] RBAC policies exist for all kubelet API consumers
- [ ] Monitoring and alerting are configured for authentication failures

### Workload Assessment

- [ ] Inventory of all privileged containers in the cluster
- [ ] Inventory of all services using self-signed certificates for probes
- [ ] Inventory of all tools accessing kubelet API directly
- [ ] Backup of current kubelet configuration on all nodes

## Migration Path: StrictTLSVerification

### Phase 1: Preparation

1. **Audit TLS certificate usage**:
```bash
# Find pods with HTTPS probes
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.containers[].livenessProbe.httpGet.scheme == "HTTPS" or .spec.containers[].readinessProbe.httpGet.scheme == "HTTPS") | "\(.metadata.namespace)/\(.metadata.name)"'
```

2. **Verify internal certificates**:
```bash
# Check API server serving certificate
openssl s_client -connect <apiserver>:6443 -showcerts 2>/dev/null | \
  openssl x509 -noout -dates -subject
```

3. **Ensure CA bundles are distributed**:
All components need access to the cluster CA certificate to verify peer certificates.

### Phase 2: Enable on Test Cluster

```bash
# Enable on kube-apiserver
kube-apiserver --feature-gates=StrictTLSVerification=true

# Enable on kubelet
kubelet --feature-gates=StrictTLSVerification=true
```

### Phase 3: Validate

```bash
# Verify proxy requests work with valid certificates
kubectl proxy &
curl http://localhost:8001/api/v1/namespaces/default/services/my-svc/proxy/

# Verify probes are passing
kubectl get pods -o wide
kubectl describe pod <pod-name> | grep -A5 "Liveness\|Readiness"
```

### Phase 4: Production Rollout

1. Enable on kube-apiserver first
2. Enable on kubelets one node at a time
3. Monitor for TLS-related errors in component logs

### Rollback

```bash
# Disable on kube-apiserver
kube-apiserver --feature-gates=StrictTLSVerification=false

# Disable on kubelet
kubelet --feature-gates=StrictTLSVerification=false
```

## Migration Path: DisablePrivilegedByDefault

### Phase 1: Preparation

1. **Inventory privileged workloads**:
```bash
# List all privileged pods
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.containers[].securityContext.privileged == true) | "\(.metadata.namespace)/\(.metadata.name)"'

# List all privileged init containers
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.initContainers[]?.securityContext.privileged == true) | "\(.metadata.namespace)/\(.metadata.name)"'
```

2. **Evaluate alternatives to privileged mode**:

| Use Case | Alternative |
|----------|------------|
| Network configuration | `NET_ADMIN` capability |
| Device access | `hostPath` volumes with specific devices |
| Kernel module loading | `SYS_MODULE` capability |
| System tracing | `SYS_PTRACE` capability |
| Host filesystem access | Specific `hostPath` mounts |

3. **Update workloads** to use minimum required capabilities:
```yaml
securityContext:
  capabilities:
    add:
    - NET_ADMIN
    - SYS_TIME
  privileged: false  # Explicit
```

### Phase 2: Enable on Test Cluster

```bash
kubelet --feature-gates=DisablePrivilegedByDefault=true
```

### Phase 3: Validate

```bash
# Verify non-privileged pods work normally
kubectl run test-non-priv --image=nginx
kubectl get pod test-non-priv -w

# Verify privileged pods are rejected
kubectl run test-priv --image=nginx --overrides='{"spec":{"containers":[{"name":"test","image":"nginx","securityContext":{"privileged":true}}]}}'
# Expected: Pod should fail or be rejected
```

### Phase 4: Production Rollout

1. Enable on one node at a time
2. Ensure kube-system pods that require privileged mode are handled
3. Common kube-system privileged pods: kube-proxy, CNI plugins, CSI node drivers

### Rollback

```bash
kubelet --feature-gates=DisablePrivilegedByDefault=false
```

## Migration Path: SecureKubeletDefaults

### Phase 1: Preparation

1. **Audit anonymous access**:
```bash
# Test current anonymous access
curl -k https://<node-ip>:10250/healthz
# If this returns "ok", anonymous access is currently enabled
```

2. **Configure RBAC**:
Ensure all legitimate kubelet API consumers have proper RBAC bindings.
See [Kubelet Secure Defaults](kubelet-secure-defaults.md) for RBAC examples.

3. **Verify API server connectivity**:
```bash
# From each node, verify API server reachability
curl -k https://<apiserver>:6443/healthz
```

### Phase 2: Enable on Test Cluster

```bash
kubelet --feature-gates=SecureKubeletDefaults=true
```

### Phase 3: Validate

```bash
# Verify anonymous access is rejected
curl -k https://<node-ip>:10250/healthz
# Expected: 401 Unauthorized

# Verify authenticated access works
curl --cert /path/to/admin.crt --key /path/to/admin.key \
  --cacert /path/to/ca.crt \
  https://<node-ip>:10250/healthz
# Expected: ok

# Verify kubectl commands work through API server
kubectl logs <pod-name>
kubectl exec -it <pod-name> -- /bin/sh
```

### Phase 4: Production Rollout

1. Enable on one node at a time
2. Monitor for 401/403 errors in kubelet logs
3. Address RBAC gaps as they are discovered
4. Continue until all nodes are migrated

### Rollback

```bash
kubelet --feature-gates=SecureKubeletDefaults=false
```

Or override individual settings:
```bash
kubelet \
  --feature-gates=SecureKubeletDefaults=true \
  --anonymous-auth=true
```

## Non-Feature-Gated Changes (Always Active)

The following security fixes are applied unconditionally in v1.35 and do not have
feature gate toggles. These changes are non-breaking and improve security posture
without affecting functionality.

### File Permission Changes

| Component | Change | Impact |
|-----------|--------|--------|
| etcd-migrate | Directories: 0777 → 0700 | Only etcd process owner can access data |
| etcd-migrate | Version file: 0666 → 0600 | Only owner can read/write version info |
| client-go | Kubeconfig: 0666 → 0600 | Only owner can read credentials |
| FC volume | Sysfs writes: 0666 → 0644 | World-write removed from sysfs operations |

**Validation**:
```bash
# Verify etcd directory permissions
ls -la /var/lib/etcd/
# Expected: drwx------ (0700)

# Verify kubeconfig permissions
ls -la ~/.kube/config
# Expected: -rw------- (0600)
```

### Command Injection Prevention

The GCE mounter now validates arguments to prevent command injection through
special characters. This is transparent to normal operations.

## Enabling All Feature Gates Simultaneously

For maximum security hardening, enable all three feature gates:

```bash
# On kube-apiserver
kube-apiserver --feature-gates=StrictTLSVerification=true

# On kubelet
kubelet --feature-gates=StrictTLSVerification=true,DisablePrivilegedByDefault=true,SecureKubeletDefaults=true
```

### Recommended Enable Order

1. `SecureKubeletDefaults` - Easiest to validate, most impactful
2. `StrictTLSVerification` - Requires certificate infrastructure review
3. `DisablePrivilegedByDefault` - Requires workload audit, most disruptive

## Support and Resources

- [Security Hardening Guide](security-hardening-guide.md) - Detailed configuration reference
- [Kubelet Secure Defaults](kubelet-secure-defaults.md) - Kubelet-specific documentation
- [CHANGELOG](../CHANGELOG/CHANGELOG-1.35.md) - Release notes for v1.35
- [Kubernetes Security Documentation](https://kubernetes.io/docs/concepts/security/)
