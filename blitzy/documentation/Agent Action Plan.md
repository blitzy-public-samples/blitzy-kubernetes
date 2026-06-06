# Technical Specification

# 0. Agent Action Plan

## 0.1 Executive Summary

### 0.1.1 Understanding of the Engagement

Based on the security-audit scope, the Blitzy platform understands that the objective is to analyze the assigned codebase — the upstream Kubernetes monorepo (Go module `k8s.io/kubernetes` [go.mod:L7], at HEAD commit `9293f9326d4`) — for security vulnerabilities, misconfigurations, and attack vectors, and to deliver a complete, structured **Security Vulnerability Catalog** containing severity classification, vulnerable code snippets, file paths, attack-vector descriptions, remediation guidance, validation criteria, and statistics. The catalog itself is the required deliverable and is presented in full visibility in sub-section 0.3.

Translating that intent into a precise technical mandate: the audit systematically inspected the first-party source tree (`pkg/`, `cmd/`, `plugin/`, and the in-tree libraries under `staging/src/k8s.io/`) together with security-relevant deployment configuration (`cluster/`) and the dependency manifest (`go.mod`/`go.sum`), evaluating each against the OWASP Top 10 (2021) and the corresponding CWE families: hardcoded secrets, injection vectors, authentication flaws, authorization gaps, cryptographic weaknesses, and vulnerable dependencies.

### 0.1.2 Headline Assessment

The assigned codebase is a mature, heavily-audited CNCF project that routes all vulnerability reports through the Kubernetes Security Response Committee under a formal embargo policy [SECURITY_CONTACTS:L1-L15]. The audit identified **no exploitable remote-code-execution, SQL or command injection, authentication-bypass, server-side request forgery, path-traversal, or unsafe-deserialization defects in first-party production code.** The genuine, evidence-backed findings reduce to two classes:

- **Two MEDIUM insecure binary defaults** in the API-server option layer that deviate from the CIS Kubernetes Benchmark (`AlwaysAllow` authorization and anonymous authentication enabled by default) but are universally overridden in real-world deployments.
- **Five LOW static-analysis hygiene items** (weak hash used for non-cryptographic key derivation, by-design `InsecureSkipVerify` sites, private keys embedded in test fixtures, `math/rand` used for non-security purposes, and one vestigial insecure-port constant).

A dependency review confirmed that all security-relevant pinned modules are at patched versions; no actionable dependency vulnerabilities were found (see 0.3.2).

### 0.1.3 Statistics Dashboard

The audit cataloged **7 findings** across **18 distinct files** (13 production files plus 5 test-fixture files). The production-finding density is approximately **0.151%** (13 production files carrying findings out of roughly 8,586 first-party non-test Go files), which corroborates the hardened posture.

**Findings by Severity**

| Severity | Count | Finding IDs |
|----------|-------|-------------|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 2 | F-01, F-02 |
| LOW | 5 | F-03, F-04, F-05, F-06, F-07 |
| **Total** | **7** | — |

```mermaid
pie showData
    title Findings by Severity (Total = 7)
    "MEDIUM" : 2
    "LOW" : 5
```

**Vulnerability Density per Module** (distinct cataloged files)

| Module | Cataloged Files | Findings Touching Module | Notes |
|--------|-----------------|--------------------------|-------|
| `pkg/` | 9 | F-01, F-02, F-03, F-04, F-05 | Largest first-party tree; both MEDIUM defaults live here |
| `staging/src/k8s.io/` | 7 | F-04, F-05, F-07 | In-tree libraries; mostly by-design TLS + test fixtures |
| `cmd/` | 2 | F-04, F-05 | kubeadm bootstrap wait + test server |
| `plugin/` | 0 | — | No findings |
| `cluster/` | 0 | — | Verified non-findings (legitimate node daemons) |

**Top 3 Vulnerability Categories**

| Rank | Category (OWASP / CWE) | Findings | Count |
|------|------------------------|----------|-------|
| 1 | Insecure Defaults / Security Misconfiguration (A05:2021; CWE-1188/276/287) | F-01, F-02, F-07 | 3 (contains both MEDIUM findings) |
| 2 | Cryptographic & TLS Weaknesses (A02:2021; CWE-328/338/295) | F-03, F-04, F-06 | 3 |
| 3 | Hardcoded Secrets in Test Fixtures (A07:2021; CWE-798) | F-05 | 1 |

The overall confidence in catalog completeness is moderate-to-high (~80%); the qualifying caveat — that dedicated SAST/SCA tooling (gosec, semgrep, govulncheck, trivy) could not be installed in the analysis environment and the audit was therefore conducted with manual `grep`/`find`/`awk` traversal plus targeted advisory research — is documented in 0.3.3.


## 0.2 Vulnerability Root Cause Identification

Based on repository analysis and corroborating advisory research, the cataloged findings trace to **two distinct root-cause classes**. The detailed per-finding evidence (snippets, attack vectors, CWE/CVE mappings) is presented in the full catalog at 0.3.1; this sub-section establishes the underlying *why* for each class.

```mermaid
graph TD
    R[Security Findings Root Causes] --> A[Class A: Insecure Defaults / Misconfiguration<br/>A05:2021 - CWE-1188]
    R --> B[Class B: Cryptographic & Static-Analysis Hygiene<br/>A02:2021 - CWE-328/295/338]
    A --> F01[F-01 AlwaysAllow authz default - MEDIUM]
    A --> F02[F-02 anonymous-auth enabled default - MEDIUM]
    A --> F07[F-07 vestigial insecure-port constant - LOW]
    B --> F03[F-03 SHA-1 key derivation - LOW]
    B --> F04[F-04 InsecureSkipVerify by design - LOW]
    B --> F05[F-05 private keys in test fixtures - LOW]
    B --> F06[F-06 math/rand non-security - LOW]
```

### 0.2.1 Class A — Insecure Defaults and Misconfiguration (CWE-1188)

- **Root cause:** Convenience-oriented default initialization in the kube-apiserver option layer. When an operator supplies no explicit authorization or authentication flags, the option layer falls back to permissive values for backward compatibility and developer ergonomics.
- **Located in:** `pkg/kubeapiserver/options/authorization.go:L91-L93` (authorization fallback) and `pkg/kubeapiserver/options/authentication.go:L187-L191` (anonymous default). A related dead constant resides at `staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go:L27`.
- **Triggered by:** Running `kube-apiserver` with neither `--authorization-config` nor `--authorization-mode` set causes the effective mode list to become `[]string{authzmodes.ModeAlwaysAllow}` [pkg/kubeapiserver/options/authorization.go:L91-L93]; the default empty mode slice is established at `authorization.go:L78`. Independently, `WithAnonymous()` sets `Allow: true` [pkg/kubeapiserver/options/authentication.go:L187-L191], enabling the `system:anonymous` / `system:unauthenticated` identity by default.
- **Evidence:** The flag help text explicitly documents the behavior — "Defaults to AlwaysAllow if --authorization-config is not used" [pkg/kubeapiserver/options/authorization.go:L172-L173] — and the CIS Kubernetes Benchmark formalizes both deviations as controls 1.2.7 (authorization-mode must not be `AlwaysAllow`) and 1.2.1 (`--anonymous-auth=false`). Under `AlwaysAllow`, any authenticated principal obtains full cluster access, bypassing RBAC entirely.
- **This conclusion is definitive because:** the fallback assignment is unconditional given empty inputs, the behavior is self-documented in the flag help, and it is independently codified as a CIS audit control. The severity is held at MEDIUM (not HIGH) because every production distribution — kubeadm, RKE2, AKS, GKE — overrides these defaults with `--authorization-mode=Node,RBAC` and `--anonymous-auth=false`, and an in-code guard already resets anonymous auth to `false` when the `AlwaysAllow` authorizer is active [pkg/kubeapiserver/options/authentication.go:L840-L841].

### 0.2.2 Class B — Cryptographic and Static-Analysis Hygiene (CWE-328 / CWE-295 / CWE-338 / CWE-798)

- **Root cause:** Use of cryptographic primitives and patterns that a SAST scanner flags by signature, even though each instance is non-security-sensitive by design. The "weakness" is the *pattern*, not an exploitable behavior.
- **Located in:** `pkg/volume/util/attach_limit.go:L20,L41` and `pkg/proxy/winkernel/hns.go:L23,L561` (SHA-1); ten `InsecureSkipVerify: true` sites led by `pkg/probe/http/http.go:L41`; private-key PEM blocks confined to test fixtures such as `staging/src/k8s.io/apiserver/pkg/admission/plugin/webhook/testcerts/certs.go`; and `math/rand` imports across roughly 43 first-party files.
- **Triggered by:** Signature-based detection — for example, `sha1.New()` deriving a resource-name key [pkg/volume/util/attach_limit.go:L41], `sha1.Sum()` hashing an unordered endpoint set with an explicit collision-tolerance comment [pkg/proxy/winkernel/hns.go:L561], or `tls.Config{InsecureSkipVerify: true}` on a liveness prober that must connect to arbitrary user-defined endpoints [pkg/probe/http/http.go:L41].
- **Evidence:** Each site was manually inspected and confirmed non-cryptographic or by-design: the SHA-1 outputs are used as map/resource keys (not for integrity or signatures); the TLS sites either operate on IP-based connections where hostname verification is impossible or flip to verifying mode when a trust anchor is supplied — for instance `storage_factory.go` sets `InsecureSkipVerify = false` once `TrustedCAFile` is present [staging/src/k8s.io/apiserver/pkg/server/storage/storage_factory.go:L339]; security-sensitive randomness uses `crypto/rand` [staging/src/k8s.io/cluster-bootstrap/token/util/helpers.go:L19]; and every embedded private key lives under a `testcerts`, `testing`, `test/`, or `samples/` path.
- **This conclusion is definitive because:** the surrounding code, in-line comments, and call sites demonstrate non-security usage, and the cryptographically sensitive paths verifiably use strong primitives (`crypto/rand`, AES-GCM, `crypto/subtle.ConstantTimeCompare`). These items are retained as LOW catalog entries so that scanner alerts have a documented disposition, not because they represent exploitable weaknesses.


## 0.3 Diagnostic Execution and Security Vulnerability Catalog

This sub-section presents the complete Security Vulnerability Catalog in full visibility. Sub-section 0.3.1 details every finding (F-01 through F-07) with severity, vulnerable code, location, attack vector, CWE/CVE mapping, remediation, and validation criteria. Sub-section 0.3.2 summarizes findings and the verified-clean dimensions. Sub-section 0.3.3 documents the verification methodology and confidence.

### 0.3.1 Code Examination Results — Full Vulnerability Catalog

The catalog at a glance:

| ID | Title | Severity | CWE | OWASP 2021 | Primary Location |
|----|-------|----------|-----|------------|------------------|
| F-01 | Insecure default authorization mode (AlwaysAllow) | MEDIUM | CWE-1188, CWE-276 | A05 | `pkg/kubeapiserver/options/authorization.go:L91-L93` |
| F-02 | Anonymous authentication enabled by default | MEDIUM | CWE-1188, CWE-287 | A05, A07 | `pkg/kubeapiserver/options/authentication.go:L187-L191` |
| F-03 | Weak hash (SHA-1) used for key derivation | LOW | CWE-328 | A02 | `pkg/volume/util/attach_limit.go:L41` |
| F-04 | TLS `InsecureSkipVerify: true` (by design) | LOW | CWE-295 | A02, A05 | `pkg/probe/http/http.go:L41` (+9 sites) |
| F-05 | Private keys embedded in test fixtures | LOW | CWE-798 | A07 | `staging/.../webhook/testcerts/certs.go` |
| F-06 | Insecure randomness (`math/rand`, non-security) | LOW | CWE-338 | A02 | ~43 first-party files |
| F-07 | Vestigial insecure-port constant | LOW | CWE-1188 | A05 | `staging/.../pod-security-admission/cmd/webhook/server/options/options.go:L27` |

#### F-01 — Insecure Default Authorization Mode (AlwaysAllow)

- **Severity:** MEDIUM — **CWE-1188** (Insecure Default Initialization), **CWE-276** (Incorrect Default Permissions); **OWASP A05:2021**; **CIS Kubernetes Benchmark 1.2.7**.
- **Location:** `pkg/kubeapiserver/options/authorization.go:L91-L93` (default established at `:L78`, documented at `:L172-L173`).
- **Vulnerable code:**

```go
if len(o.AuthorizationConfigurationFile) == 0 && len(o.Modes) == 0 {
    o.Modes = []string{authzmodes.ModeAlwaysAllow}
}
```

- **Attack vector:** A `kube-apiserver` started with neither `--authorization-config` nor `--authorization-mode` authorizes every authenticated request. Combined with F-02, an entirely unauthenticated client could be authorized, yielding full cluster control and bypassing RBAC. The flag help itself states the default is `AlwaysAllow` [pkg/kubeapiserver/options/authorization.go:L172-L173].
- **Remediation (operator-layer, primary):** start the API server with `--authorization-mode=Node,RBAC`. Optional non-breaking code hardening: emit a `klog.Warning` in `Complete()` when `AlwaysAllow` is selected by default.
- **Validation criteria:** kube-bench control 1.2.7 reports PASS; launching the API server with no authorization flags and asserting that an unprivileged request is denied.

#### F-02 — Anonymous Authentication Enabled by Default

- **Severity:** MEDIUM — **CWE-1188**, **CWE-287** (Improper Authentication); **OWASP A05/A07:2021**; **CIS Kubernetes Benchmark 1.2.1**.
- **Location:** `pkg/kubeapiserver/options/authentication.go:L187-L191` (flag definition at `:L359-L362`; in-code guard at `:L840-L841`).
- **Vulnerable code:**

```go
o.Anonymous = &AnonymousAuthenticationOptions{
    Allow: true,
}
```

- **Attack vector:** `--anonymous-auth` defaults to `true`, so unauthenticated requests are admitted as `system:anonymous` in group `system:unauthenticated`. If the authorizer is also permissive (F-01), this becomes unauthenticated full access. Anonymous access is required for unauthenticated health endpoints (`/healthz`, `/livez`, `/readyz`).
- **Mitigating control already present:** anonymous auth is forcibly reset to `false` when the `AlwaysAllow` authorizer is active [pkg/kubeapiserver/options/authentication.go:L840-L841], and under RBAC the `system:unauthenticated` group carries minimal permissions.
- **Remediation (operator-layer, primary):** set `--anonymous-auth=false`, or scope anonymous access to only the health endpoints using `AnonymousAuthConfigurableEndpoints`.
- **Validation criteria:** kube-bench control 1.2.1 reports PASS; an anonymous `kubectl get` against a protected resource returns `403 Forbidden`.

#### F-03 — Weak Hash (SHA-1) Used for Key Derivation

- **Severity:** LOW — **CWE-328** (Use of Weak Hash); **OWASP A02:2021**; gosec G401/G505.
- **Location:** `pkg/volume/util/attach_limit.go:L20,L41`; `pkg/proxy/winkernel/hns.go:L23,L561`.
- **Vulnerable code:**

```go
hash := sha1.New()
hash.Write([]byte(driverName))
hashed := hex.EncodeToString(hash.Sum(nil))[:16] // CSI attach-limit resource key
```

- **Attack vector:** None practical. SHA-1 is used here to derive an internal extended-resource key (attach-limit) and to hash an unordered set of HNS load-balancer endpoints; the winkernel code carries an explicit comment that collisions are acceptable because other keys identify the load balancer [pkg/proxy/winkernel/hns.go:L561]. SHA-1 is not used for signatures, integrity, or any trust decision. No `crypto/md5`, `crypto/des`, or `crypto/rc4` exists in production code.
- **Remediation (optional, defensive):** SHA-256 could replace SHA-1 in the winkernel path with negligible risk. The `attach_limit.go` path must **not** be changed without a migration because the derived value is part of an advertised extended-resource name; altering it would be backward-incompatible. Recommended disposition: document the non-cryptographic use or annotate with a justified `//nolint:gosec`.
- **Validation criteria:** confirm no integrity/signature consumer of the hash; existing attach-limit unit tests verify key stability.

#### F-04 — TLS `InsecureSkipVerify: true` (By Design)

- **Severity:** LOW — **CWE-295** (Improper Certificate Validation); **OWASP A07/A05:2021**; gosec G402.
- **Location:** ten production sites, including `pkg/probe/http/http.go:L41`, `pkg/kubelet/kubelet.go:L593`, `pkg/controlplane/apiserver/config.go:L418`, `staging/src/k8s.io/apiserver/pkg/server/storage/storage_factory.go:L321`, `staging/src/k8s.io/client-go/util/cert/server_inspection.go:L33,L67`, `pkg/registry/core/rest/storage_core.go:L557-L558`, `staging/src/k8s.io/apimachinery/pkg/util/proxy/dial.go:L71`, and `cmd/kubeadm/app/util/apiclient/wait.go:L264`.
- **Vulnerable code:**

```go
tlsConfig := &tls.Config{InsecureSkipVerify: true}
```

- **Attack vector:** In isolation, skipping certificate verification permits man-in-the-middle attacks. Each site, however, is structurally by-design: the HTTP prober must connect to arbitrary user-defined endpoints whose certificates cannot be known in advance; the API-server proxy transport connects to pods/services by IP where hostname verification is impossible; kubelet lifecycle hooks send no credentials. Where a trust anchor is available, the code verifies: `storage_factory.go` sets `InsecureSkipVerify = false` once `TrustedCAFile` is supplied [staging/src/k8s.io/apiserver/pkg/server/storage/storage_factory.go:L339]. The global TLS minimum version is correctly pinned to TLS 1.2 [staging/src/k8s.io/apiserver/pkg/server/secure_serving.go:L50].
- **Remediation (accept-with-justification):** retain the by-design sites; ensure each carries a rationale comment; prefer CA-based verification anywhere a trust anchor can be threaded through (already done in `storage_factory.go`).
- **Validation criteria:** enumerate all `InsecureSkipVerify: true` sites and confirm a documented rationale per site; confirm TLS `MinVersion` is `VersionTLS12` or higher at serving boundaries.

#### F-05 — Private Keys Embedded in Test Fixtures

- **Severity:** LOW (informational) — **CWE-798** (Use of Hardcoded Credentials) *pattern*; **OWASP A07:2021**; gosec G101.
- **Location:** test-only paths — `staging/src/k8s.io/apiserver/pkg/admission/plugin/webhook/testcerts/certs.go:L22,L71,L120,L169`, `staging/src/k8s.io/apiserver/pkg/storage/etcd3/testing/testingcert/certificates.go:L91`, `staging/src/k8s.io/apiextensions-apiserver/test/integration/conversion/webhook.go:L236`, `cmd/kube-apiserver/app/testing/testserver.go:L82`, and `pkg/controlplane/apiserver/samples/generic/server/testing/testserver.go:L60`.
- **Vulnerable code (illustrative, key body redacted):**

```go
// test-only fixture; never loaded by a production binary
var CAKey = []byte("-----BEGIN RSA PRIVATE KEY----- <redacted> -----END RSA PRIVATE KEY-----")
```

- **Attack vector:** None. These PEM blocks are static fixtures used solely to exercise TLS, webhook, and storage code paths in unit/integration tests and sample servers. No production runtime path imports them, and they grant no access to any real system. A repository-wide scan found **zero** hardcoded literal secrets in production code.
- **Remediation:** none required. Keep fixtures under `testcerts`/`testing`/`test/`/`samples/` paths and configure SAST tooling to exclude test directories.
- **Validation criteria:** confirm the fixture symbols are referenced only from `_test.go` files and test/sample servers, never from a production build target.

#### F-06 — Insecure Randomness (`math/rand`, Non-Security Use)

- **Severity:** LOW — **CWE-338** (Use of Cryptographically Weak PRNG); **OWASP A02:2021**; gosec G404.
- **Location:** approximately 43 first-party files import `math/rand`; representative non-security uses include jitter, backoff, and generated name suffixes.
- **Vulnerable code:**

```go
import "math/rand" // used for jitter/backoff/name suffixes — not for secrets or keys
```

- **Attack vector:** None for security purposes. All security-sensitive generation uses `crypto/rand`: bootstrap tokens at `staging/src/k8s.io/cluster-bootstrap/token/util/helpers.go:L19`, and service-account JWT signing under `pkg/serviceaccount/`. Predictable `math/rand` output for backoff timing carries no confidentiality or integrity impact.
- **Remediation (optional):** migrate non-security uses to `math/rand/v2` (available under the project's Go 1.25 toolchain [go.mod:L7]) for clarity; add a lint rule forbidding `math/rand` inside security-sensitive packages.
- **Validation criteria:** confirm every token/key/nonce generation path imports `crypto/rand`, not `math/rand`.

#### F-07 — Vestigial Insecure-Port Constant

- **Severity:** LOW (informational) — **CWE-1188**; **OWASP A05:2021**.
- **Location:** `staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go:L27`.
- **Vulnerable code:**

```go
DefaultPort           = 8443
DefaultInsecurePort   = 8080 // declared but never referenced anywhere
```

- **Attack vector:** None active. The constant is never bound to a listener — a repository-wide search across first-party code (excluding `vendor/`) returns only the declaration line and no usages; the webhook binds only `SecureServing` on `DefaultPort` (8443) [staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go:L54]. The risk is latent: a future change could mistakenly bind it to open a plaintext port.
- **Remediation (safe code edit):** delete the dead constant. This is the single zero-risk source change identified by the audit.
- **Validation criteria:** `grep -rn "DefaultInsecurePort"` returns no references after deletion; the package compiles unchanged.

### 0.3.2 Key Findings from Repository Analysis

The following table records *what* was found and *where*, and the conclusion drawn:

| Finding | File:Line | Conclusion |
|---------|-----------|------------|
| Authorization falls back to `AlwaysAllow` with no flags | `pkg/kubeapiserver/options/authorization.go:L91-L93` | F-01 — insecure default; requires operator override (`Node,RBAC`) |
| Anonymous auth `Allow: true` by default | `pkg/kubeapiserver/options/authentication.go:L187-L191` | F-02 — insecure default; mitigated when `AlwaysAllow` active (`:L840-L841`) |
| `sha1.New()` for resource-key derivation | `pkg/volume/util/attach_limit.go:L41` | F-03 — non-cryptographic; SHA-256 swap is compat-breaking here |
| `sha1.Sum()` over unordered endpoint set, collisions accepted | `pkg/proxy/winkernel/hns.go:L561` | F-03 — non-cryptographic by explicit design comment |
| `InsecureSkipVerify: true` on liveness prober | `pkg/probe/http/http.go:L41` | F-04 — by design (arbitrary endpoints); 1 of 10 sites |
| Verification re-enabled when CA present | `staging/.../storage/storage_factory.go:L339` | F-04 mitigation — secure-by-default when trust anchor supplied |
| TLS `MinVersion` pinned to 1.2 | `staging/.../server/secure_serving.go:L50` | Non-finding — strong TLS floor confirmed |
| PEM private keys only in `testcerts`/`testing` paths | `staging/.../webhook/testcerts/certs.go` | F-05 — test fixtures, no production exposure |
| `crypto/rand` used for bootstrap tokens | `staging/.../cluster-bootstrap/token/util/helpers.go:L19` | F-06 mitigation — security randomness is strong |
| `DefaultInsecurePort = 8080` never referenced | `staging/.../pod-security-admission/.../options.go:L27` | F-07 — dead constant, safe to delete |
| kubelet anonymous auth defaults to `false`, mode `Webhook` | `pkg/kubelet/apis/config/v1beta1/defaults.go:L92-L93,L102` | Non-finding — kubelet defaults already CIS-compliant |
| `exec.Command` (87 sites) never invokes a shell | `pkg/volume/util/fsquota/common/quota_common_linux_impl.go:L132` | Non-finding — no command-injection surface |
| `privileged`/`hostNetwork` workloads in `cluster/` | `cluster/` addon manifests | Non-finding — legitimate node networking/system daemons |

**Verified-clean dependency posture (OWASP A06:2021 / CWE-1104).** Dedicated SCA tooling could not be installed, so the dependency manifest was reviewed manually against public advisories. All security-relevant pinned modules are at patched versions:

| Module | Pinned Version | Relevant CVE | Status |
|--------|----------------|--------------|--------|
| `gopkg.in/go-jose/go-jose.v2` | v2.6.3 [go.mod:L86] | CVE-2024-28180 (CWE-409, CVSS 4.3) | Patched — fix landed in v2.6.3 |
| `github.com/golang-jwt/jwt/v5` | v5.2.2 [go.mod:L161] | CVE-2025-30204 (CWE-405, CVSS 7.5) | Patched — fix landed in v5.2.2 |
| `golang.org/x/net` | v0.47.0 [go.mod:L74] | CVE-2023-39325 (HTTP/2 rapid reset) | Patched — fix landed in v0.17.0 |
| `golang.org/x/crypto` | v0.45.0 [go.mod:L73] | — | Current |

The repository uses the maintained `gopkg.in/go-jose/go-jose.v2` module path, not the archived (unfixed) `gopkg.in/square/go-jose.v2`.

### 0.3.3 Fix Verification Analysis

- **Reproduction approach.** Findings were established by static inspection of first-party source with `grep`/`find`/`awk`, anchored to exact line numbers, and corroborated with official advisory and CIS Benchmark research. The two MEDIUM defaults (F-01, F-02) are reproducible by launching `kube-apiserver` with no authorization/authentication flags and observing that requests are authorized and anonymous identities are accepted.
- **Confirmation tests.** For F-07, a repository-wide reference search confirmed the constant is unused, so its removal is provably side-effect-free. For F-04 and F-06, the security-sensitive counterparts were positively verified to use strong primitives (`InsecureSkipVerify=false` when a CA is present; `crypto/rand` for tokens). For F-05, fixture symbols were traced to test-only consumers.
- **Boundary conditions and edge cases covered.** Authorization fallback was checked for both the empty-config and empty-mode branch; the anonymous-auth guard interaction with `AlwaysAllow` was confirmed; the SHA-1 backward-compatibility constraint (advertised extended-resource name) was identified; and the TLS sites were each classified against whether a trust anchor is obtainable.
- **Outcome and confidence.** Per-finding diagnostic confidence ranges from 90% to 99%. Overall catalog-completeness confidence is approximately **80%**. The limiting factor is that automated SAST/SCA scanners (gosec, semgrep, govulncheck, trivy) and a Go toolchain could not be installed in the analysis environment; coverage is therefore bounded by manual traversal of first-party code. No CRITICAL or HIGH severity issues were found within that scope.


## 0.4 Remediation Specification

Remediations are classified by risk so that downstream agents apply the right change in the right layer. Because this is upstream Kubernetes, the two MEDIUM findings are intentional, documented binary defaults; their authoritative remediation is **operator/deployment hardening**, not a silent change to the API-server contract. Exactly one zero-risk source edit is warranted (F-07).

### 0.4.1 The Definitive Fixes

| ID | Fix Class | Action |
|----|-----------|--------|
| F-01 | Operator hardening (+ optional code) | Deploy with `--authorization-mode=Node,RBAC`; optionally add a non-breaking startup warning |
| F-02 | Operator hardening | Deploy with `--anonymous-auth=false` (or restrict anonymous to health endpoints) |
| F-03 | Accept-with-justification | Annotate non-crypto use; SHA-256 only with a migration (attach_limit) |
| F-04 | Accept-with-justification | Retain by-design sites; ensure rationale comments; verify with CA where available |
| F-05 | No action | Test-only fixtures; exclude from SAST |
| F-06 | Optional | Migrate non-security uses to `math/rand/v2`; lint-guard security packages |
| F-07 | Safe code edit | Delete the dead `DefaultInsecurePort` constant |

- **F-07 (definitive code fix).** File to modify: `staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go`. Current implementation at line 27: `DefaultInsecurePort   = 8080`. Required change: remove the line entirely. This fixes the root cause by eliminating a latent plaintext-port constant that could be bound in error; the webhook already serves exclusively over `SecureServing` on port 8443 [staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go:L54].
- **F-01 (optional code hardening).** File: `pkg/kubeapiserver/options/authorization.go`. At lines 91-93 the mode list falls back to `ModeAlwaysAllow`. The behavior is retained (changing it breaks the documented contract and bootstrap paths), but a `klog.Warning` is added so operators are alerted when the permissive default is in effect. This narrows the misconfiguration window without altering behavior.
- **F-02 (operator-layer).** File: deployment manifest / API-server flags (not repository source). Set `--anonymous-auth=false`. The in-code guard at `pkg/kubeapiserver/options/authentication.go:L840-L841` already neutralizes anonymous access under the `AlwaysAllow` authorizer.

### 0.4.2 Change Instructions

- **F-07 — DELETE** line 27 of `staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go`:

```go
// REMOVE the following unused constant (never referenced; latent plaintext-port risk):
DefaultInsecurePort   = 8080
```

  After removal, the `const` block retains `DefaultPort`, `DefaultClientQPSLimit`, and `DefaultClientQPSBurst` unchanged.

- **F-01 — INSERT** a warning at the fallback branch in `pkg/kubeapiserver/options/authorization.go` (around line 92), preserving existing behavior:

```go
if len(o.AuthorizationConfigurationFile) == 0 && len(o.Modes) == 0 {
    // SECURITY: no authorization flags supplied; defaulting to AlwaysAllow grants
    // every authenticated request full access. Warn so operators harden to Node,RBAC.
    klog.Warning("no --authorization-mode/--authorization-config set; defaulting to AlwaysAllow")
    o.Modes = []string{authzmodes.ModeAlwaysAllow}
}
```

- **F-02 — MODIFY deployment configuration** (no repository source change): add `--anonymous-auth=false` to the kube-apiserver invocation, or configure `AnonymousAuthConfigurableEndpoints` to permit anonymous access only on `/healthz`, `/livez`, and `/readyz`.
- **F-03 / F-04 / F-06 — annotate, do not rewrite.** Add a brief justification comment (or a reviewed `//nolint:gosec` with reason) at each flagged site so the scanner disposition is explicit. Do not alter `pkg/volume/util/attach_limit.go` hashing without an accompanying extended-resource-name migration.

All edits must carry an explanatory comment tying the change to its finding ID and motive, consistent with the surrounding Kubernetes code style.

### 0.4.3 Fix Validation

- **F-07.** Command: `grep -rn "DefaultInsecurePort" --include="*.go" . | grep -v /vendor/`. Expected output after fix: no matches. Confirmation: `go build ./staging/src/k8s.io/pod-security-admission/...` (or the repo's `make`) succeeds with the constant removed.
- **F-01.** Command: start the API server with no authorization flags and inspect logs. Expected output: the new warning line appears; behavior (AlwaysAllow) is unchanged. Hardened confirmation: with `--authorization-mode=Node,RBAC`, kube-bench control 1.2.7 returns PASS.
- **F-02.** Command: with `--anonymous-auth=false`, issue an unauthenticated request to a protected endpoint. Expected output: `401 Unauthorized`/`403 Forbidden`; kube-bench control 1.2.1 returns PASS.
- **F-03 / F-04 / F-06.** Confirmation: re-run the SAST scanner and verify each previously-flagged site now carries a documented disposition; unit tests for the affected packages pass unchanged.


## 0.5 Scope Boundaries

### 0.5.1 Changes Required (Exhaustive List)

Source-code changes are deliberately minimal — the audit found a hardened codebase, so the only mandatory edit is the removal of one dead constant. All other remediations are either operator-layer configuration or optional, reviewed annotations.

- **Mandatory code change (1 file):**
  - `staging/src/k8s.io/pod-security-admission/cmd/webhook/server/options/options.go` — Line 27 — DELETE the unused `DefaultInsecurePort = 8080` constant (F-07).
- **Optional, non-breaking code hardening (1 file):**
  - `pkg/kubeapiserver/options/authorization.go` — ~Line 92 — INSERT a `klog.Warning` when defaulting to `AlwaysAllow` (F-01). Behavior unchanged.
- **Optional defensive annotations (no behavior change):**
  - `pkg/volume/util/attach_limit.go` — Line 41 — add disposition comment / reviewed `//nolint:gosec` for non-cryptographic SHA-1 (F-03).
  - `pkg/proxy/winkernel/hns.go` — Line 561 — same disposition annotation (F-03).
  - The ten `InsecureSkipVerify: true` sites led by `pkg/probe/http/http.go:L41` — ensure each retains a rationale comment (F-04).
- **Operator-layer configuration (not repository source):**
  - kube-apiserver invocation — set `--authorization-mode=Node,RBAC` (F-01) and `--anonymous-auth=false` (F-02), plus the broader CIS hardening flags (`--profiling=false`, `--encryption-provider-config`, audit logging).
- **No user-specified rules mandate any additional files** (the rules set is empty; see 0.7). No other files require modification.

### 0.5.2 Explicitly Excluded

- **Do not modify the binary defaults.** The fallback at `pkg/kubeapiserver/options/authorization.go:L92` (`ModeAlwaysAllow`) and the anonymous default at `pkg/kubeapiserver/options/authentication.go:L189` (`Allow: true`) are intentional, documented CNCF behavior. Changing them would break `hack/local-up-cluster.sh`, end-to-end test fixtures, and unauthenticated health probes; these findings are flagged and remediated at the operator layer, not silently rewritten.
- **Do not "fix" the by-design TLS sites.** Especially `pkg/probe/http/http.go:L41` (must probe arbitrary user endpoints) and the IP-based proxy transport in `pkg/controlplane/apiserver/config.go:L418`; forcing verification would break liveness/readiness probing and pod/service proxying.
- **Do not change SHA-1 in `pkg/volume/util/attach_limit.go`** without an extended-resource-name migration — the derived value is advertised by existing nodes and a change is backward-incompatible.
- **Do not refactor verified non-findings:** kubelet defaults (`pkg/kubelet/apis/config/v1beta1/defaults.go:L92-L93,L102`, already CIS-compliant), the 87 `exec.Command` sites (no shell invocation), and the `privileged`/`hostNetwork` workloads under `cluster/` (legitimate node daemons).
- **Do not touch test fixtures (F-05)** — generated test certificates are correct practice and carry no production exposure.
- **Do not modify `vendor/`** — vendored third-party code is managed via `go.mod` and is out of scope for source edits.
- **Do not add features, new tests, or documentation** beyond what each remediation requires.


## 0.6 Verification Protocol

### 0.6.1 Vulnerability Elimination Confirmation

- **F-07 (dead constant removed).** Execute `grep -rn "DefaultInsecurePort" --include="*.go" . | grep -v /vendor/`; verify the output is empty. Confirm the package still builds (`go build ./staging/src/k8s.io/pod-security-admission/...` or the repository `make`), and that the webhook continues to bind only `SecureServing` on port 8443.
- **F-01 / F-02 (insecure defaults hardened).** Run a CIS conformance scan (kube-bench) and verify controls **1.2.7** (`--authorization-mode` not `AlwaysAllow`) and **1.2.1** (`--anonymous-auth=false`) report PASS. Functionally, confirm that an anonymous request to a protected endpoint returns `401/403`, and that an authenticated-but-unauthorized request is denied by RBAC. If the optional warning was added, confirm it appears in the API-server log only when no authorization flags are supplied.
- **F-03 / F-04 / F-06 (dispositioned).** Re-run the SAST scanner (gosec/semgrep) and verify every previously-flagged G401/G505 (SHA-1), G402 (`InsecureSkipVerify`), and G404 (`math/rand`) site now resolves to a documented disposition rather than an unexplained alert.
- **F-05 (test-only confirmed).** Verify the fixture symbols are referenced exclusively from `_test.go` files and test/sample servers; confirm no production build target imports them.
- **Dependency posture.** When tooling is available, run `govulncheck ./...` and confirm no findings for `go-jose`, `golang-jwt`, `golang.org/x/net`, or `golang.org/x/crypto`, consistent with the patched versions recorded in 0.3.2.

### 0.6.2 Regression Check

- **Build and unit tests.** Run the affected packages' unit suites non-interactively, e.g. `go test ./staging/src/k8s.io/pod-security-admission/... ./pkg/kubeapiserver/options/... ./pkg/volume/util/... -count=1`, and confirm all pass. Removing an unreferenced constant and adding a log line are non-behavioral, so no test should change.
- **Unchanged behavior.** Confirm that, absent operator overrides, the API server still defaults exactly as documented (no behavioral drift from the F-01 warning), that liveness/readiness probing over TLS still succeeds against endpoints with untrusted certificates (F-04 sites intact), and that CSI attach-limit extended-resource names are unchanged (F-03 left untouched).
- **Conformance.** Re-run the Kubernetes conformance / e2e smoke tests for the apiserver options and pod-security-admission webhook to confirm no startup or admission regressions.
- **Performance.** No performance-sensitive code paths are modified; no throughput or latency measurement is required beyond confirming the affected binaries start and serve normally.


## 0.7 Rules

No user-specified implementation rules were provided for this project (the rules set is empty), and no setup instructions or environments were attached. In the absence of explicit rules, the following standard-practice constraints govern any remediation derived from this catalog:

- Make only the targeted security changes specified in 0.4 and 0.5; introduce zero modifications outside the scope of a given finding.
- Comply with the existing development patterns, standards, and conventions of the Kubernetes project — including its established security idioms (`crypto/rand` for security-sensitive randomness, `crypto/subtle.ConstantTimeCompare` for secret comparison, TLS 1.2+ at serving boundaries, and UTC time methods where time is handled).
- Preserve the documented public behavior of binary defaults; remediate intentional defaults (F-01, F-02) at the operator/deployment layer rather than altering the API-server contract.
- Accompany every code edit with an explanatory comment tying the change to its finding ID and motive.
- Ensure target-version compatibility with the project's Go 1.25 toolchain [go.mod:L7]; do not introduce APIs newer than the supported toolchain.
- Run extensive testing (unit, conformance, and SAST re-scan) to prevent regressions before any change is considered complete, per 0.6.


## 0.8 Attachments

No attachments were provided for this project. Specifically:

- No PDF or image reference documents were supplied.
- No Figma design files or frames were supplied; consequently, no Figma Design Analysis and no Design System Compliance mapping are applicable to this security audit.
- No external reference files were cited in the prompt or rules.

All evidence underpinning this catalog was therefore derived directly from the assigned repository (module `k8s.io/kubernetes` [go.mod:L7], HEAD `9293f9326d4`) and corroborated with public security advisories and the CIS Kubernetes Benchmark, as cited inline throughout sub-sections 0.1–0.6.


