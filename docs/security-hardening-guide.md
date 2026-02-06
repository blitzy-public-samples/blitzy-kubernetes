# Kubernetes Security Hardening Guide

## Overview

This guide documents the security hardening feature gates introduced in Kubernetes v1.35
to address critical and high-severity vulnerabilities identified during the security audit.
These feature gates provide a gradual migration path from legacy insecure defaults to
production-ready secure configurations.

## Feature Gates Summary

| Feature Gate | Component | Default | Security Impact |
|-------------|-----------|---------|-----------------|
| `StrictTLSVerification` | kube-apiserver, kubelet | `false` (Alpha) | Enforces TLS certificate validation |
| `DisablePrivilegedByDefault` | kubelet | `false` (Alpha) | Blocks privileged containers |
| `SecureKubeletDefaults` | kubelet | `false` (Alpha) | Secures kubelet auth/authz |

## StrictTLSVerification

### Security Posture Improvement

When enabled, this feature gate enforces TLS certificate verification for all internal
component communication, including:

- **API Server Proxy Transport**: Validates certificates when proxying requests to backend
  services, preventing MITM attacks on the proxy path.
- **Kubelet Container Lifecycle**: Validates certificates for HTTPS container lifecycle
  handler callbacks (preStop, postStart hooks).
- **Component Status Health Checks**: Validates certificates when checking controller-manager
  and scheduler health endpoints.
- **HTTP Probes**: Validates certificates for HTTPS liveness, readiness, and startup probes.

### Configuration

Enable on the kube-apiserver:
```bash
kube-apiserver --feature-gates=StrictTLSVerification=true
```

Enable on the kubelet:
```bash
kubelet --feature-gates=StrictTLSVerification=true
```

### Prerequisites

Before enabling `StrictTLSVerification`:

1. Ensure all internal component endpoints use certificates signed by a trusted CA
2. Configure the cluster CA bundle on all components
3. Verify that probe endpoints use valid certificates or update probes to use TCP/exec

### Fallback Configuration

For the kubelet container lifecycle handler, even without the feature gate, you can control
TLS verification via environment variables:

```bash
# Enable TLS verification without the feature gate
export KUBELET_CONTAINER_LIFECYCLE_INSECURE_SKIP_TLS_VERIFY=false
# Specify CA certificate file
export KUBELET_CONTAINER_LIFECYCLE_TLS_CA_FILE=/path/to/ca.crt
```

## DisablePrivilegedByDefault

### Security Posture Improvement

When enabled, the kubelet sets `AllowPrivileged` to `false`, preventing pods from running
in privileged mode unless the cluster administrator explicitly configures privileged access.
This mitigates container escape vulnerabilities (CWE-250) by enforcing least-privilege.

### Configuration

Enable on the kubelet:
```bash
kubelet --feature-gates=DisablePrivilegedByDefault=true
```

### Impact Assessment

Workloads affected by this change include:
- Pods with `securityContext.privileged: true`
- DaemonSets that require host-level access (e.g., CNI plugins, storage drivers)
- System pods in the `kube-system` namespace that use privileged mode

### Recommended Migration Steps

1. Audit all pods with `kubectl get pods --all-namespaces -o json | jq '.items[] | select(.spec.containers[].securityContext.privileged == true) | .metadata.name'`
2. Evaluate whether each pod truly requires privileged access
3. Where possible, use specific capabilities instead of full privileged mode
4. Enable the feature gate on test clusters first
5. Roll out to production nodes incrementally

## SecureKubeletDefaults

### Security Posture Improvement

When enabled, the kubelet applies secure defaults for authentication and authorization:

| Setting | Legacy Default | Secure Default |
|---------|---------------|----------------|
| `authentication.anonymous.enabled` | `true` | `false` |
| `authentication.webhook.enabled` | `false` | `true` |
| `authorization.mode` | `AlwaysAllow` | `Webhook` |

This prevents:
- Unauthenticated access to the kubelet API (CWE-287)
- Unauthorized operations on the kubelet API (CWE-285)

### Configuration

Enable on the kubelet:
```bash
kubelet --feature-gates=SecureKubeletDefaults=true
```

### Prerequisites

Before enabling `SecureKubeletDefaults`:

1. Ensure the kube-apiserver is reachable from all kubelets (webhook auth requires API server)
2. Verify RBAC rules exist for kubelet API access patterns
3. Configure appropriate `ClusterRole` and `ClusterRoleBinding` for monitoring tools
4. Test with `--authorization-mode=Webhook` explicitly before enabling the feature gate

### Verification

After enabling, verify the kubelet configuration:
```bash
# Check kubelet configuration
kubectl get --raw /api/v1/nodes/<node>/proxy/configz | jq '.kubeletconfig'

# Verify anonymous access is rejected
curl -k https://<node-ip>:10250/healthz
# Expected: 401 Unauthorized

# Verify authenticated access works
curl --cert /path/to/client.crt --key /path/to/client.key \
  --cacert /path/to/ca.crt \
  https://<node-ip>:10250/healthz
# Expected: ok
```

## Additional Security Fixes (Non-Feature-Gated)

The following security fixes are applied unconditionally and do not require feature gate
enablement:

### File Permission Hardening

| Component | File/Directory | Old Permissions | New Permissions | CWE |
|-----------|---------------|-----------------|-----------------|-----|
| etcd-migrate | Data directory | 0777 | 0700 | CWE-732 |
| etcd-migrate | Backup directory | 0777 | 0700 | CWE-732 |
| etcd-migrate | Version file | 0666 | 0600 | CWE-732 |
| client-go | Kubeconfig files | 0666 | 0600 | CWE-732 |
| FC volume | Sysfs writes | 0666 | 0644 | CWE-732 |

### Command Injection Prevention

Input validation has been added to the GCE mounter (`cluster/gce/gci/mounter/mounter.go`)
to prevent OS command injection through mount arguments (CWE-78).

### Log Sanitization

Bootstrap token values are now masked in kubeadm log output to prevent credential exposure
through log files (CWE-532).

## Compliance Mapping

| Standard | Requirement | Feature Gate |
|----------|-------------|-------------|
| CIS Benchmark 1.6.1 | Kubelet certificate verification | `StrictTLSVerification` |
| CIS Benchmark 4.2.1 | anonymous-auth is false | `SecureKubeletDefaults` |
| CIS Benchmark 4.2.2 | authorization-mode is not AlwaysAllow | `SecureKubeletDefaults` |
| NIST SP 800-53 SC-23 | Session authenticity | `StrictTLSVerification` |
| PCI-DSS 4.1 | Strong cryptography | `StrictTLSVerification` |

## Rollback Procedures

All feature gates can be disabled by setting them to `false`:

```bash
# Disable all security feature gates
kubelet --feature-gates=StrictTLSVerification=false,DisablePrivilegedByDefault=false,SecureKubeletDefaults=false
kube-apiserver --feature-gates=StrictTLSVerification=false
```

Note: File permission fixes and command injection prevention are always active and cannot
be rolled back via feature gates. These are non-breaking changes that do not affect
functionality.
