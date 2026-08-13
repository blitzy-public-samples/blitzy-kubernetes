/*
Copyright The Kubernetes Authors.

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

/**
 * The load-bearing constants of controls V1 through V8, in ONE production-neutral place.
 *
 * AAP §0.10.2 (the boundary-condition table these values come from, every one of which
 * "must port unchanged") / §0.5.1 (the `web/src/**` rows) / §0.8.1.2 / tech-spec §6.6.
 *
 * WHY THIS MODULE EXISTS. Before it, a production component imported
 * `AESGCM_PREFIX` and `PLAINTEXT_CANARY` from `src/test/fixtures/encryptionConfig`
 * — production code depending on test code. That inversion has three costs, and only
 * the first is cosmetic:
 *
 * 1. A production build would have to include the fixture module, dragging recorded
 *    test payloads into shipped code.
 * 2. It makes the fixture the source of truth for a SECURITY constant. A fixture is
 *    edited to make a test express a scenario; the moment someone edits the recorded
 *    prefix to describe a negative case, the panel's notion of a valid prefix changes
 *    with it — and the test that was supposed to catch that now agrees with the bug.
 * 3. It makes the dependency unidirectional in the WRONG direction, so there is no
 *    place a reviewer can look to see the values the whole tier agrees on.
 *
 * The rule is therefore: this module depends on NOTHING — no React, no fixture, no
 * hook — and both the components and the fixtures depend on it. A fixture that needs
 * the aesgcm prefix imports it from here; a fixture that needs a DIFFERENT prefix to
 * express a negative case writes that different string inline, where it is visibly a
 * test's own datum rather than a redefinition of the contract.
 *
 * Every value is quoted from the repository, never inferred. The comment on each one
 * says what breaks if it changes, because a constant with no stated consequence is a
 * constant someone will "tidy".
 */

// AAP §0.10.2 / tech-spec §6.6 (V1-V8)
//
// INVARIANT LOCKED BY THIS FILE: the exact literal values the eight controls are
// asserted against. Weakening any one of them makes its control pass for the wrong
// reason, which is worse than a failing test because it is silent.

/* ------------------------------------------------------------------------ *
 * V3 - Secrets encryption at rest
 * ------------------------------------------------------------------------ */

/**
 * The ciphertext prefix an AES-GCM-encrypted Secret carries in etcd.
 *
 * Matched as a PREFIX, never by equality and never as a substring. Equality would
 * break on any change to the ciphertext body; a substring match would pass on a
 * nested occurrence, which is precisely how a plaintext blob that merely MENTIONS
 * the prefix could be read as encrypted.
 *
 * From `test/integration/secrets/encryption_test.go` and AAP §0.10.2.
 */
export const AESGCM_PREFIX = 'k8s:enc:aesgcm:v1:key1:';

/**
 * The plaintext marker written into the Secret the V3 control creates.
 *
 * Its ABSENCE from the raw etcd blob is the negative half of the encryption proof.
 * Without it, a passing prefix check proves only that a prefix was written — an
 * implementation that prepended the prefix to untouched plaintext would pass.
 */
export const PLAINTEXT_CANARY = 'BLITZY_PLAINTEXT_CANARY';

/**
 * The provider name that must come FIRST in the encryption provider list.
 *
 * `identity` first would mean nothing is encrypted at all while the configuration
 * still looked populated.
 */
export const IDENTITY_PROVIDER_NAME = 'identity';

/** The KMS provider API version. `v1` is deprecated and rejects nothing this control needs. */
export const KMS_API_VERSION = 'v2';

/**
 * The only committed bound on the KMS envelope call.
 *
 * Quoted as the wire string rather than a number of seconds, because that is what a
 * decoded manifest carries and what an assertion compares.
 */
export const KMS_TIMEOUT = '3s';

/**
 * The placeholder KMS endpoint. AAP §0.8.2 forbids real key material and real
 * endpoints anywhere in this tier, so this is the only endpoint that may appear.
 */
export const KMS_PLACEHOLDER_ENDPOINT = 'unix:///tmp/kms.socket';

/**
 * The resources the encryption configuration must cover, in order.
 *
 * Order is part of the assertion: the resource list is read positionally by the
 * generated configuration's own schema.
 */
export const ENCRYPTED_RESOURCES: readonly string[] = Object.freeze(['secrets', 'configmaps']);

/**
 * The key KMS v2 REJECTS. Present under v1, removed under v2.
 *
 * Asserted as absent rather than merely unread: a configuration carrying it does not
 * load, so a panel that ignored it would report a posture the server never reached.
 */
export const FORBIDDEN_KMS_KEY = 'cachesize';

/**
 * The shape a conforming deployment encryption configuration must have.
 *
 * THIS IS A REQUIREMENT, NOT A RECORDING, which is why it lives in the domain rather than
 * in a fixture. `web/src/components/EncryptionAtRestPanel.tsx` reads it to decide whether
 * an observed configuration conforms, and "what must be true of a conforming
 * configuration" is a production fact about the control. It previously read the same shape
 * out of `src/test/fixtures/encryptionConfig`, which meant a fixture edited to express a
 * NEGATIVE case would have moved the panel's notion of conformance with it.
 *
 * The fixture keeps its own recorded copy for what a fixture is for — replaying the wire
 * shape and recording which manifest line each value was measured from. A spec asserts the
 * two agree, so a divergence is a test failure rather than a silent disagreement.
 *
 * Every value here is a §0.10.2 boundary condition, and each is composed from the named
 * constants above rather than restated, so there is one definition site per value:
 *
 * - `resources` is {@link ENCRYPTED_RESOURCES}, in order.
 * - The STRONG provider is first. `identity` first would mean nothing is encrypted.
 * - `identity` is LAST, and present: it is the decrypt-only fallback that lets already
 *   written plaintext still be read during migration.
 * - The KMS provider declares {@link KMS_API_VERSION}, the placeholder endpoint and
 *   {@link KMS_TIMEOUT}, and carries NO {@link FORBIDDEN_KMS_KEY} — v2 rejects it, so a
 *   configuration containing it does not load at all.
 *
 * No key material appears, per AAP §0.8.2. The manifest's aesgcm alternative is commented
 * out with a placeholder, so the committed document declares `kms` plus `identity` only.
 */
export const REQUIRED_ENCRYPTION_CONFIG_SHAPE = Object.freeze({
  apiVersion: 'apiserver.config.k8s.io/v1',
  kind: 'EncryptionConfiguration',
  /** The single resource rule. One rule covering both resources, not one rule each. */
  rule: Object.freeze({
    resources: ENCRYPTED_RESOURCES,
    /** The strong provider, which must be the FIRST entry of `providers`. */
    strongProvider: Object.freeze({
      apiVersion: KMS_API_VERSION,
      name: 'k8s-kms',
      endpoint: KMS_PLACEHOLDER_ENDPOINT,
      timeout: KMS_TIMEOUT,
    }),
    /** The name of the provider that must be LAST. */
    lastProviderName: IDENTITY_PROVIDER_NAME,
  }),
} as const);

/* ------------------------------------------------------------------------ *
 * V5 - Admission-webhook fail-closed posture
 * ------------------------------------------------------------------------ */

/**
 * The failure policy that closes V5.
 *
 * `Ignore` is the weakness this control exists to have removed: a webhook that fails
 * open admits everything the moment it becomes unreachable, which is exactly when an
 * admission control matters most.
 */
export const WEBHOOK_FAIL_CLOSED_POLICY = 'Fail';

/** The fail-OPEN value, named so a comparison can be written against it explicitly. */
export const WEBHOOK_FAIL_OPEN_POLICY = 'Ignore';

/** The committed webhook call timeout, in seconds. */
export const WEBHOOK_TIMEOUT_SECONDS = 5;

/** The committed `sideEffects` declaration. Anything else changes dry-run semantics. */
export const WEBHOOK_SIDE_EFFECTS = 'None';

/**
 * The committed `admissionReviewVersions`.
 *
 * A list, and compared AS a list: a scalar `"v1"` normalises to the same TEXT as this
 * single-element list, which is why V5's evidence readers must preserve the wire type
 * rather than compare rendered strings.
 */
export const WEBHOOK_ADMISSION_REVIEW_VERSIONS: readonly string[] = Object.freeze(['v1']);

/** The committed webhook name. */
export const WEBHOOK_NAME = 'cloud-pvl-admission.k8s.io';

/* ------------------------------------------------------------------------ *
 * V6 - Sensitive-resource audit fidelity
 * ------------------------------------------------------------------------ */

/** The audit `kind` the audit scheme registers for a single event. */
export const AUDIT_EVENT_KIND = 'Event';

/** The one audit apiVersion registered by `apis/audit/install/install.go`. */
export const AUDIT_API_VERSION = 'audit.k8s.io/v1';

/**
 * The audit levels as a STRICT TOTAL ORDER, weakest first.
 *
 * THE ONE DEFINITION SITE for the audit-level vocabulary of this tier, and the
 * reason it is a `const` TUPLE rather than a `readonly string[]`. Three copies of
 * this list used to exist — here, in `hooks/useAuditEvents.ts` and in
 * `test/fixtures/controlStatus.ts` — each with its own `AuditLevel` union beside
 * it. Three copies of an ORDER that is itself the assertion is three chances for
 * the parser, the panels and the recorded fixtures to disagree about what
 * `secrets sits at exactly Request` means, and nothing would have failed to say
 * so: each copy typechecked on its own.
 *
 * The order is the assertion, not a display convenience: it is what stops a
 * future edit from silently downgrading a level (AAP §0.10.2, `None < Metadata <
 * Request < RequestResponse`). Compare by index — see {@link compareAuditLevels}
 * — never by string. The `satisfies` target is a fixed four-element tuple of
 * literals, so reordering, adding, removing or renaming an entry is a
 * `tsc --noEmit` error rather than a review finding.
 *
 * Recorded from `cluster/gce/gci/audit_policy_test.go` L120-125, whose aliases
 * `none`, `metadata`, `request` and `response` name `audit.LevelNone`,
 * `LevelMetadata`, `LevelRequest` and `LevelRequestResponse`. The WIRE spellings
 * are used here because that is what an audit policy and an audit event carry.
 */
export const AUDIT_LEVEL_ORDER = [
  'None',
  'Metadata',
  'Request',
  'RequestResponse',
] as const satisfies readonly ['None', 'Metadata', 'Request', 'RequestResponse'];

/**
 * The four audit levels of the `audit.k8s.io/v1` API, spelled exactly as they
 * appear on the wire.
 *
 * DERIVED from {@link AUDIT_LEVEL_ORDER} rather than written out, which is what
 * makes the union and the order one fact instead of two: a level added to the
 * tuple is a member of this union immediately, and a level named here that is
 * absent from the tuple cannot exist. The ordering lives in the tuple because a
 * union is unordered.
 */
export type AuditLevel = (typeof AUDIT_LEVEL_ORDER)[number];

/**
 * Rank of each level, for comparison.
 *
 * INVARIANT LOCKED (F-006-RQ-001): `None < Metadata < Request < RequestResponse`
 * is a STRICT TOTAL ORDER. Every level has a distinct rank, so no two levels
 * compare equal unless they are the same level, and every pair is comparable.
 * That is what makes a silent downgrade detectable: an edit moving `secrets` from
 * `Request` to `Metadata` is not merely a different value, it is a strictly
 * SMALLER one, and a spec can say so.
 *
 * Derived from {@link AUDIT_LEVEL_ORDER}'s index order and typed as an exhaustive
 * `Record<AuditLevel, number>`, so a level cannot be ranked twice, cannot be
 * left unranked, and cannot be ranked in an order that contradicts the tuple.
 */
export const AUDIT_LEVEL_RANK: Readonly<Record<AuditLevel, number>> = Object.freeze(
  Object.fromEntries(AUDIT_LEVEL_ORDER.map((level, index) => [level, index])) as Record<
    AuditLevel,
    number
  >,
);

/**
 * Compares two audit levels by detail.
 *
 * Pure and total: every pair of levels is comparable, and the result is zero only
 * when the levels are identical, which is precisely the strict-total-order
 * property {@link AUDIT_LEVEL_RANK} encodes.
 *
 * @param left - the first level.
 * @param right - the second level.
 * @returns a negative number when `left` is less detailed than `right`, zero when
 *   they are the same level, and a positive number when `left` is more detailed.
 */
export function compareAuditLevels(left: AuditLevel, right: AuditLevel): number {
  return AUDIT_LEVEL_RANK[left] - AUDIT_LEVEL_RANK[right];
}

/**
 * The exact level each sensitive resource must be audited at.
 *
 * `secrets` at `Request` and NOT `RequestResponse` is the deliberate confidentiality
 * trade-off: raising it would write Secret bodies into the audit log, which is the
 * very disclosure V6 exists to prevent. Lowering any of them loses the evidence.
 */
export const REQUIRED_AUDIT_LEVELS: Readonly<Record<string, AuditLevel>> = Object.freeze({
  secrets: 'Request',
  'serviceaccounts/token': 'Request',
  configmaps: 'Metadata',
  tokenreviews: 'Metadata',
  clusterroles: 'RequestResponse',
});

/**
 * The resource whose audit events may never carry a response body.
 *
 * This single string is the whole of the confidentiality guard's subject, and both
 * the API-tier assertion and the presentation-tier redaction key on it.
 */
export const CONFIDENTIAL_AUDIT_RESOURCE = 'secrets';

/** The wire member that must never appear on a {@link CONFIDENTIAL_AUDIT_RESOURCE} event. */
export const AUDIT_RESPONSE_BODY_KEY = 'responseObject';

/**
 * The wire member whose survival on create and update is the ACCEPTED trade-off.
 *
 * Recorded here so that a reader of the redaction logic can see that its presence is
 * a decision rather than an oversight.
 */
export const AUDIT_REQUEST_BODY_KEY = 'requestObject';

/* ------------------------------------------------------------------------ *
 * V8 - etcd mutual TLS
 * ------------------------------------------------------------------------ */

/** The plaintext etcd endpoint. Its presence in a rendered command is a V8 failure. */
export const ETCD_PLAINTEXT_ENDPOINT = 'http://127.0.0.1:2379';

/** The mutual-TLS etcd endpoint V8 requires. */
export const ETCD_TLS_ENDPOINT = 'https://127.0.0.1:2379';

/**
 * The three apiserver flags that must ALL be present for etcd mutual TLS.
 *
 * All three, not any: a certificate without its CA, or a CA without a client
 * certificate, is a half-configured transport that must fail rather than downgrade.
 */
export const ETCD_TLS_FLAGS: readonly string[] = Object.freeze([
  '--etcd-cafile',
  '--etcd-certfile',
  '--etcd-keyfile',
]);

/**
 * The opt-out variable, and the ONLY value that enables plaintext etcd.
 *
 * Both GCE profiles must default it to `false`. A one-sided edit would leave the test
 * profile insecure while the default profile stayed green, which is why the two are
 * asserted together.
 */
export const ETCD_ALLOW_INSECURE_VARIABLE = 'ETCD_APISERVER_ALLOW_INSECURE';

/** The literal that enables the opt-out. Any other value, including `"1"`, does not. */
export const ETCD_ALLOW_INSECURE_ENABLED_VALUE = 'true';

/**
 * The stderr text the fail-closed branch must emit, matched as a substring.
 *
 * Quoted from `cluster/gce/gci/configure-kubeapiserver.sh`, so the shell tier and this
 * tier assert the same string and a CI reader can grep both suites for it.
 */
export const ETCD_FAIL_CLOSED_MESSAGE = 'refusing to fall back to plaintext etcd';

/**
 * The stderr text the PARTIAL-credential branch must emit, matched as a substring.
 *
 * A separate phrase from {@link ETCD_FAIL_CLOSED_MESSAGE} because it is a separate
 * branch of the shell (`configure-kubeapiserver.sh` L48-L50) with separate
 * semantics: it never consults the opt-out at all, so a half-configured deployment
 * aborts unconditionally. Telling the two diagnostics apart is what stops a
 * partially-configured deployment being reported as a deliberately permitted one.
 */
export const ETCD_PARTIAL_CREDENTIALS_MESSAGE = 'Please provide all mTLS credential';

/**
 * The stdout text the plaintext-fallback branch must emit, matched as a substring.
 *
 * Quoted from the same shell function (L41-L43). Required evidence for the
 * explicitly permitted plaintext branch: without the warning, an unauthenticated
 * transport would be configured silently, and "the operator asked for it" would be
 * an assumption rather than an announced decision. Only the invariant half of the
 * sentence is quoted — the shell prefixes it with the six variable names, which are
 * context rather than contract.
 */
export const ETCD_PLAINTEXT_WARNING_MESSAGE =
  'mTLS between etcd server and kube-apiserver is not enabled';

/* ------------------------------------------------------------------------ *
 * V2 - Pod Security admission
 * ------------------------------------------------------------------------ */

/** The Pod Security levels, weakest first. Ordered for the same reason the audit levels are. */
export const POD_SECURITY_LEVELS: readonly string[] = Object.freeze([
  'privileged',
  'baseline',
  'restricted',
]);

/** The level V2 requires on the `enforce` channel. */
export const POD_SECURITY_ENFORCE_LEVEL = 'baseline';

/** The level V2 requires on the `warn` and `audit` channels. */
export const POD_SECURITY_WARN_LEVEL = 'restricted';

/** The only namespace exempt from Pod Security enforcement. */
export const POD_SECURITY_EXEMPT_NAMESPACES: readonly string[] = Object.freeze(['kube-system']);

/* ------------------------------------------------------------------------ *
 * V1 and V7 - authorization
 * ------------------------------------------------------------------------ */

/**
 * The one group that may hold an unrestricted rule — every verb, every API group and
 * every resource.
 *
 * Its positive control matters as much as the denial it accompanies: `system:masters`
 * MUST still be allowed everything. Without that control, a V1 assertion also passes
 * when the whole authorization stack is broken and nothing is allowed at all.
 *
 * The rule itself is spelled with {@link WILDCARD} rather than written out, because the
 * Go notation for it closes a block comment.
 */
export const PRIVILEGED_GROUP = 'system:masters';

/** The one ClusterRole that may declare the unrestricted rule. */
export const WILDCARD_CLUSTER_ROLE = 'cluster-admin';

/** The wildcard token. A rule holding it for verb, group AND resource is unrestricted. */
export const WILDCARD = '*';

/** The HTTP status a denial must carry. 404 would mean the object was missing instead. */
export const FORBIDDEN_STATUS = 403;

/** The HTTP status that would mean the target did not exist — the V7 ordering hazard. */
export const NOT_FOUND_STATUS = 404;

/**
 * The exact `--authorization-mode` the V7 oracle runs its API server with.
 *
 * AAP §0.4.2.2 records the flag list verbatim: `--authorization-mode Node,RBAC`. BOTH
 * authorizers are load-bearing and the ORDER is part of the value, so this is compared as
 * a whole string rather than by membership. `RBAC` alone leaves the Node authorizer out,
 * and every cross-node denial the control depends on then comes from RBAC rules that a
 * cluster is free to change — which is a different control with the same symptom.
 */
export const NODE_AUTHORIZATION_MODE = 'Node,RBAC';

/**
 * The admission plugin that must be enabled for V7.
 *
 * `--enable-admission-plugins NodeRestriction` (AAP §0.4.2.2). The Node AUTHORIZER decides
 * which objects a kubelet may read; this PLUGIN is what stops it from mutating the ones it
 * is allowed to read. Neither substitutes for the other, which is why the mode above and
 * this plugin are two separate requirements rather than one posture flag.
 */
export const NODE_RESTRICTION_PLUGIN = 'NodeRestriction';

/* ------------------------------------------------------------------------ *
 * V4 - ServiceAccount token hygiene
 * ------------------------------------------------------------------------ */

/** The audience a V4 token must be bound to, and to NOTHING else. */
export const TOKEN_AUDIENCE = 'api';

/** The requested token lifetime, in seconds. */
export const TOKEN_TTL_SECONDS = 3600;

/**
 * The tolerance around `requestTime + TOKEN_TTL_SECONDS`, in seconds.
 *
 * Engineered, not arbitrary: wide enough to absorb CI jitter and narrow enough that a
 * roughly one-year long-lived-token regression still fails. Narrowing it makes the
 * assertion flaky; widening it makes it meaningless, because `exp > now` alone passes
 * for any token that has not yet expired.
 */
export const TOKEN_EXPIRY_LEEWAY_SECONDS = 60;

/**
 * The two sub-claims that must be present and exactly NULL.
 *
 * A non-null value in either identifies a legacy or bound-to-object token, which is
 * the regression V4 exists to catch. Presence matters as much as nullity: an ABSENT
 * claim is not proof of an unbound token.
 */
export const TOKEN_NULL_SUB_CLAIMS: readonly string[] = Object.freeze(['pod', 'secret']);
