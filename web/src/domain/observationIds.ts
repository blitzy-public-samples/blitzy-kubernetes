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
 * The stable, exact identity of every measured observation the eight controls report.
 *
 * AAP §0.5.1 / §0.10.2 / §0.7.2 (failure legibility) / tech-spec §6.6.
 *
 * WHY THIS MODULE EXISTS, stated as the defect it removes. A panel located its evidence
 * by inventing a label and hoping the payload used the same words. It did not. The V1
 * panel probed for a label of its own invention -- "SubjectAccessReview allowed:", the
 * principal, and the unrestricted verb/group/resource triple -- while the recorded
 * passing payload carried `denied subject: status.allowed` and
 * `positive control: status.allowed` — two vocabularies with NO overlap, so the panel
 * found no evidence, never confirmed its positive control, and rendered UNKNOWN over a
 * payload that recorded a clean PASS. The V3 panel had the mirror-image failure: it
 * matched by keyword, so `plaintext canary` and `plaintext canary present in raw blob`
 * both classified as "the canary", the first won, and its non-empty STRING value read as
 * truthy — reporting the canary PRESENT and rendering FAIL over a recorded PASS.
 *
 * Neither is fixable by editing one side. Both sides have to name the same thing, so the
 * identity has to live in ONE place that both import — which is this module.
 *
 * THE VALUES ARE THE SERVER'S VOCABULARY, NOT A NEW ONE. Every string below is the label
 * the recorded payload already carries, adopted verbatim as the contract rather than
 * replaced with a synthetic `v1.sar.allowed`-style key. Two reasons: the recorded payloads
 * are what the MSW handlers replay, so inventing new keys would mean rewriting the wire
 * fixtures and losing their provenance; and a label a human can read is what makes a
 * failure legible when it is rendered in a table beside its value.
 *
 * A LABEL IS AN IDENTITY, NOT A CAPTION. Two consequences follow and both are load-bearing:
 * a label must be unique within one control's observation list, and it must not be
 * reworded without changing both sides. `plaintext canary` versus
 * `plaintext canary present in raw blob` is the cautionary example — they are two
 * different facts, and only exact matching keeps them apart.
 *
 * This module depends on nothing but {@link ./securityConstants}. No React, no hook, no
 * fixture. The fixtures import it; it never imports them.
 */

// AAP §0.5.1 / §0.10.2 / tech-spec §6.6 (V1-V8)
//
// INVARIANT LOCKED BY THIS FILE: one identity per measured fact, shared by the fixture
// that records it and the panel that reads it, so the two cannot drift apart silently.

import { AESGCM_PREFIX, PLAINTEXT_CANARY } from './securityConstants';

/* ------------------------------------------------------------------------ *
 * V1 - RBAC least privilege
 * ------------------------------------------------------------------------ */

/**
 * V1's measured facts.
 *
 * The two `status.allowed` entries are the asymmetry AAP §0.10.2 requires kept: the
 * DENIED subject must not be allowed, and the POSITIVE CONTROL must be. Losing the second
 * turns the control into one that also passes when the whole authorization stack is broken
 * and nothing is allowed at all — which is why they are two separate identities and not
 * one "authorization worked" flag.
 */
export const V1_OBSERVATIONS = Object.freeze({
  /** The resource attributes the SubjectAccessReview asked about. */
  requestedAttributes: 'subjectAccessReview.resourceAttributes',
  /** The non-privileged principal the denial was evaluated for. */
  deniedSubjectUser: 'denied subject: user',
  /** MUST be `false`. A `true` here is the V1 failure. */
  deniedSubjectAllowed: 'denied subject: status.allowed',
  /** The privileged principal the positive control was evaluated for. */
  positiveControlUser: 'positive control: user',
  /** MUST be `true`. A `false` here is SETUP BREAKAGE, not a security finding. */
  positiveControlAllowed: 'positive control: status.allowed',
  /** How many ClusterRoles were enumerated at all. Zero means nothing was checked. */
  clusterRolesObserved: 'ClusterRoles observed',
  /**
   * WHICH ClusterRoles declare an unrestricted rule, as a comma-separated NAME list.
   * MUST be exactly `cluster-admin`.
   *
   * A name list rather than a count, and the difference is load-bearing: a count of one
   * is also satisfied by a cluster in which some other role carries the wildcard and
   * `cluster-admin` does not, which is the very substitution the control exists to
   * detect (`rbac_test.go` L1270-1278 raises a finding for both directions).
   */
  wildcardClusterRoles: 'ClusterRoles carrying a full wildcard rule',
  /** How many do so OUTSIDE `cluster-admin`. MUST be 0. */
  wildcardClusterRolesOutsideClusterAdmin:
    'ClusterRoles carrying a full wildcard rule outside cluster-admin',
  /** How many wildcard bindings name a subject other than Group/system:masters. MUST be 0. */
  wildcardBindingsOutsideMasters:
    'full-wildcard bindings with a subject outside Group/system:masters',
} as const);

/* ------------------------------------------------------------------------ *
 * V2 - Pod Security enforcement
 * ------------------------------------------------------------------------ */

/**
 * V2's measured facts.
 *
 * All THREE original paths are identified separately, because AAP §0.4.2.2 requires all
 * three and a panel that required only one would pass on a third of the evidence: the
 * privileged pod rejected, the hostPID pod rejected, and the plain pod ADMITTED under
 * `warn=restricted` while still surfacing a warning.
 */
export const V2_OBSERVATIONS = Object.freeze({
  /** MUST be exactly 403. A 404 would mean the namespace was missing instead. */
  privilegedPodStatus: 'pod privileged-pod: response status',
  /** MUST be exactly 403. */
  hostPidPodStatus: 'pod hostpid-pod: response status',
  /** MUST be `false`: a privileged pod that was admitted is the V2 failure. */
  privilegedPodAdmitted: 'pod privileged-pod: admitted',
  /** MUST be `false`. */
  hostPidPodAdmitted: 'pod hostpid-pod: admitted',
  /** MUST be `true`: under `warn=restricted` the pod IS admitted, by design. */
  warnPodAdmitted: 'pod warn-pod: admitted',
  /** MUST be reported as `null`: an admitted pod has no rejection status. */
  warnPodStatus: 'pod warn-pod: response status',
  /** MUST be at least 1: an admitted pod with NO warning means the plugin is absent. */
  warningsRecorded: 'warnings recorded',
  /** `enforce` defaults to `privileged`, which is why the warn namespace admits. */
  effectiveEnforceLevel: 'effective enforce level',
  /**
   * The precondition from AAP §0.10.2: the namespace's `default` ServiceAccount must
   * exist BEFORE the pod is created, or a ServiceAccount error masks the PodSecurity
   * rejection and the 403 proves the wrong thing.
   */
  defaultServiceAccountPrecondition:
    'precondition: namespace default ServiceAccount created first',
  /** `All`, so nothing persists in the shared etcd. */
  dryRun: 'createOptions.dryRun',
  /** The generated admission configuration's three channels and its exemption list. */
  admissionEnforce: 'admission config defaults.enforce',
  admissionWarn: 'admission config defaults.warn',
  admissionAudit: 'admission config defaults.audit',
  admissionExemptNamespaces: 'admission config exemptions.namespaces',
  /**
   * F-002-RQ-002: whether `PodSecurity` appears in `ADMISSION_CONTROL`, measured
   * SEPARATELY on each GCE profile.
   *
   * Two identities and not one, because a one-sided edit is the failure mode this
   * requirement exists to catch: leaving `PodSecurity` out of the test profile
   * while the default profile still lists it would read as green if only one were
   * measured, and the admission plugin would then be absent from every deployment
   * driven by that profile. Recorded from `cluster/gce/config-default.sh` L374 and
   * `cluster/gce/config-test.sh` L418, which declare the plugin list independently
   * of one another.
   */
  admissionControlDefaultProfile: 'PodSecurity in ADMISSION_CONTROL (cluster/gce/config-default.sh)',
  admissionControlTestProfile: 'PodSecurity in ADMISSION_CONTROL (cluster/gce/config-test.sh)',
} as const);

/**
 * Builds the identity of a namespace's Pod Security label observation.
 *
 * A BUILDER rather than a constant because the identity names the namespace, and there are
 * two of them. Both sides call this, so neither can spell it differently.
 */
export function v2NamespaceLabelObservation(namespace: string, labelKey: string): string {
  return `namespace ${namespace}: ${labelKey}`;
}

/* ------------------------------------------------------------------------ *
 * V3 - Secrets encryption at rest
 * ------------------------------------------------------------------------ */

/**
 * V3's measured facts — all FOUR of the original assertions, plus the storage-prefix
 * precondition.
 *
 * `canaryLiteral` and `canaryPresentInRawBlob` are the two identities a keyword matcher
 * conflated. The first carries the canary STRING (so a reader knows which marker was
 * looked for); the second carries the BOOLEAN answer. Reading the first as the answer
 * inverts the verdict, because a non-empty string is truthy.
 */
export const V3_OBSERVATIONS = Object.freeze({
  /** MUST be exactly 1. More means the key derivation is wrong and the wrong object was read. */
  etcdEntryCount: 'etcd entries for the Secret key',
  /** The observed ciphertext prefix. Compared as a PREFIX against {@link AESGCM_PREFIX}. */
  rawValuePrefix: 'raw stored value prefix (prefix match)',
  /** The canary STRING that was searched for. Not the answer — see the next entry. */
  canaryLiteral: 'plaintext canary',
  /** The BOOLEAN answer. MUST be `false`: the canary must be ABSENT from the raw blob. */
  canaryPresentInRawBlob: 'plaintext canary present in raw blob',
  /** MUST be `true`: the API server must still return the original plaintext. */
  plaintextRoundTrip: 'API server read round-trips to plaintext',
  /**
   * MUST be `true`. AAP §0.10.2: the etcd key must be derived from the LIVE storage
   * prefix, never hardcoded to `registry` — a hardcoded prefix reads a non-existent key
   * and the "exactly one" assertion then fails for the wrong reason.
   */
  storagePrefixFromLiveConfig: 'storage prefix read from live configuration',
  /** The observed prefix shape, for the reader. Never parsed. */
  storagePrefixShape: 'storage prefix shape',
  /**
   * The provider list, IN ORDER. The first entry encrypts every new write and all of
   * them are tried in order when decrypting, so the order IS the assertion.
   */
  providerOrder: 'encryption providers in order',
  /** MUST be exactly the recorded duration string. A bare number names no unit. */
  kmsTimeout: 'kms provider timeout',
  /** MUST be absent: KMS v2 rejects `cachesize`, so a configuration carrying it fails to load. */
  cachesizeKey: 'kms cachesize key',
  /** MUST be exactly the recorded resource list, positionally. */
  encryptedResources: 'encrypted resources in order',
  /** Deployment context rather than a boundary. Never contributes to the verdict. */
  kmsEndpoint: 'kms provider endpoint',
} as const);

/**
 * Builds the human-readable assertion titles the V3 evidence table renders.
 *
 * Separate from the observation identities above because these name the four ASSERTIONS
 * rather than the measurements, and they interpolate the constants so the rendered text
 * and the compared value can never disagree.
 */
export const V3_ASSERTION_TITLES = Object.freeze({
  exactlyOneEntry: 'exactly one etcd key/value pair for the Secret key',
  prefix: `raw stored value begins with ${AESGCM_PREFIX}`,
  canaryAbsent: `plaintext canary ${PLAINTEXT_CANARY} absent from the raw blob`,
  roundTrip: 'API server read round-trips to the original plaintext',
} as const);

/* ------------------------------------------------------------------------ *
 * V4 - ServiceAccount token hygiene
 * ------------------------------------------------------------------------ */

/**
 * V4's measured facts.
 *
 * `kubernetesIoPod` and `kubernetesIoSecret` must be present AND exactly `null`. An absent
 * claim is not proof of an unbound token, which is why the reader for these two is
 * {@link ../domain/evidence.requireNull} and not an absence check.
 */
export const V4_OBSERVATIONS = Object.freeze({
  /** Whether a token was issued at all. `false` means nothing below was measured. */
  tokenIssued: 'token issued',
  /** The `iss` claim. */
  issuer: 'issuer',
  /** The `sub` claim: MUST be `system:serviceaccount:<ns>:<sa>`. */
  subject: 'sub',
  /** The namespace sub-claim. */
  kubernetesIoNamespace: 'kubernetes.io/namespace',
  /** The ServiceAccount-name sub-claim. */
  kubernetesIoServiceAccountName: 'kubernetes.io/serviceaccount/name',
  /** MUST be present and exactly `null`. Non-null identifies a bound-to-object token. */
  kubernetesIoPod: 'kubernetes.io/pod',
  /** MUST be present and exactly `null`. */
  kubernetesIoSecret: 'kubernetes.io/secret',
  /** The earliest acceptable expiry: `requestTime + 3600 - 60`. */
  expiryWindowEarliest: 'expiry window: earliest',
  /** The latest acceptable expiry: `requestTime + 3600 + 60`. */
  expiryWindowLatest: 'expiry window: latest',
} as const);

/* ------------------------------------------------------------------------ *
 * V5 - Admission-webhook fail-closed posture
 * ------------------------------------------------------------------------ */

/**
 * V5's measured facts: every field the committed configuration pins.
 *
 * `admissionReviewVersions` is the entry that motivated the typed readers in
 * {@link ./evidence}: a LIST-valued field and a scalar `"v1"` normalise to the same TEXT,
 * so a comparison on rendered strings cannot tell a conforming configuration from a
 * malformed one.
 */
export const V5_OBSERVATIONS = Object.freeze({
  /** Whether the configuration could be read at all. `false` floors the verdict at UNKNOWN. */
  configurationReadable: 'configuration readable',
  /** The webhook name. */
  webhookName: 'webhook name',
  /** MUST be exactly `Fail`. `Ignore` is the fail-OPEN weakness V5 closed. */
  failurePolicy: 'failurePolicy',
  /** MUST be exactly 5. */
  timeoutSeconds: 'timeoutSeconds',
  /** MUST be exactly `None`. */
  sideEffects: 'sideEffects',
  /** MUST be the single-element list `["v1"]`, compared as a list. */
  admissionReviewVersions: 'admissionReviewVersions',
  clientConfigUrl: 'clientConfig.url',
  clientConfigCaBundle: 'clientConfig.caBundle',
  ruleApiGroups: 'rules[0].apiGroups',
  ruleApiVersions: 'rules[0].apiVersions',
  ruleOperations: 'rules[0].operations',
  ruleResources: 'rules[0].resources',
  ruleScope: 'rules[0].scope',
  matchConditionName: 'matchConditions[0].name',
  matchConditionExpression: 'matchConditions[0].expression',
  /**
   * How many webhook configurations are committed under `cluster/`.
   *
   * Corroborating rather than load-bearing: the panel renders it only when it was
   * reported, so a repository-wide fact is never asserted from silence.
   */
  committedConfigurationCount: 'committed webhook configurations',
} as const);

/* ------------------------------------------------------------------------ *
 * V6 - Sensitive-resource audit fidelity
 * ------------------------------------------------------------------------ */

/**
 * V6's measured facts.
 *
 * `secretsResponseObjectCount` is the confidentiality guard in one number: it MUST be 0.
 * Any other value is a Secret body in the audit log, which is the disclosure V6 exists to
 * prevent — so it floors the verdict at FAIL even when the server itself said `pass`.
 */
export const V6_OBSERVATIONS = Object.freeze({
  /** How many audit events were seen at all. Zero means nothing was checked. */
  auditEventsObserved: 'audit events observed',
  /**
   * How many events the oracle EXPECTED to observe, and whether every one of them
   * was seen.
   *
   * These two are what turn "some audit events arrived" into "the audit policy was
   * verified". The Go oracle polls until its whole expected set has been observed
   * and reports a missing-events list otherwise (`test/utils/audit.go` L86, L93), so
   * a count of observed events alone proves nothing: ten events that are all the
   * wrong ten satisfy it. `expectedEventsObserved` is the completeness answer and
   * `expectedEventCount` is the denominator that makes it auditable.
   */
  expectedEventCount: 'expected audit events',
  expectedEventsObserved: 'every expected audit event observed',
  /** The observed level for `secrets`. MUST be exactly `Request`. */
  secretsAuditLevel: 'secrets audit level',
  /** The required level, carried alongside so a failure reads without external context. */
  secretsAuditLevelRequired: 'secrets audit level required',
  /** THE GUARD. MUST be 0. */
  secretsResponseObjectCount: 'secrets events carrying a responseObject',
  /** The accepted trade-off, recorded so its presence reads as a decision. */
  requestObjectTradeOff: 'requestObject on create/update (accepted trade-off)',
  /**
   * The observed level order, whose value MUST be the canonical order rendered as
   * `None < Metadata < Request < RequestResponse`.
   *
   * The order itself is carried as the VALUE rather than as a bare `true` on purpose:
   * a boolean is unverifiable prose, whereas the rendered order can be compared
   * against `AUDIT_LEVEL_ORDER` and a reordering therefore fails instead of passing.
   */
  levelOrdering: 'level ordering None < Metadata < Request < RequestResponse',
} as const);

/**
 * Builds the identity of one per-resource audit-level row.
 *
 * The core API group renders as `core` rather than as the empty string, because an empty
 * segment in a rendered identity is indistinguishable from a missing one.
 */
export function v6ResourceLevelObservation(
  apiGroup: string,
  resources: readonly string[],
  namespace: string,
): string {
  return `${apiGroup === '' ? 'core' : apiGroup}/${resources.join('+')} in ${namespace}`;
}

/* ------------------------------------------------------------------------ *
 * V7 - NodeRestriction
 * ------------------------------------------------------------------------ */

/**
 * V7's measured facts: two denials and two allowances, each its own identity.
 *
 * All FOUR are required. AAP §0.4.2.2 lists them as the complete original set, and a
 * panel that checked only the denials would pass while node1 had lost the ability to
 * manage its own Node — a broken cluster reported as a hardened one.
 */
export const V7_OBSERVATIONS = Object.freeze({
  /** `Node,RBAC`. */
  authorizationMode: 'authorization mode',
  /** Must include `NodeRestriction`. */
  admissionPluginsEnabled: 'admission plugins enabled',
  /** MUST be denied with 403. */
  crossNodeStatusUpdate: 'denial: node1 UpdateStatus on node2',
  /** MUST be denied with 403. */
  unrelatedSecretRead: 'denial: node1 get Secret ns/unrelatedsecret',
  /** POSITIVE CONTROL: MUST be allowed. */
  ownNodeRead: 'positive control: node1 get own Node',
  /** POSITIVE CONTROL: MUST be allowed. */
  ownNodeStatusUpdate: 'positive control: node1 UpdateStatus own Node',
  /**
   * AAP §0.10.2's ordering hazard: node2 MUST exist before the cross-node call, otherwise
   * the answer is 404 rather than 403 and the denial proves the wrong thing.
   */
  node2ExistedFirst: 'precondition: node2 existed before the cross-node call',
  /** The required denial status, carried so a 404 failure explains itself. */
  denialStatusRequired: 'denial status required',
} as const);

/**
 * The four V7 outcome titles, as the evidence table renders them.
 *
 * Distinct from the observation identities because these describe the SCENARIO while the
 * identities name the measurement.
 */
export const V7_OUTCOME_TITLES = Object.freeze({
  crossNodeDenied: 'cross-node status update is denied',
  unrelatedSecretDenied: 'unrelated Secret read is denied',
  ownNodeReadAllowed: 'own Node read is allowed',
  ownNodeStatusUpdateAllowed: 'own Node status update is allowed',
} as const);

/* ------------------------------------------------------------------------ *
 * V8 - etcd mutual TLS
 * ------------------------------------------------------------------------ */

/**
 * V8's measured facts.
 *
 * The subtlest control in the set, because TWO truths must hold at once (AAP §0.10.4): the
 * unit-test compatibility default legitimately yields a PLAINTEXT endpoint from an empty
 * environment, while the fail-closed requirement demands `exit 1` when credentials are
 * absent and the opt-out was not set. A panel must therefore read the SCENARIO before
 * judging the endpoint — a plaintext endpoint is a failure in the fail-closed scenario and
 * expected in the compatibility one.
 */
export const V8_OBSERVATIONS = Object.freeze({
  /** Whether the rendered command could be read. `false` floors the verdict at UNKNOWN. */
  renderedCommandReadable: 'rendered command readable',
  /** The endpoint. `https://...` for mTLS; `http://...` is plaintext. */
  etcdServers: '--etcd-servers',
  /** All three must be present together for mutual TLS. */
  etcdCaFile: '--etcd-cafile',
  etcdCertFile: '--etcd-certfile',
  etcdKeyFile: '--etcd-keyfile',
  /** `all`, `none` or `partial`. `partial` MUST exit 1. */
  credentialsSupplied: 'credentials supplied',
  /** Whether the opt-out was set to exactly `true`. */
  insecureFallbackPermitted: 'insecure fallback permitted',
  /** `fail-closed` or `plaintext-loopback`. */
  outcome: 'outcome',
  /** 0 or 1. MUST be 1 for both the all-absent and the PARTIAL branches. */
  exitCode: 'exit code',
  /** The required exit code for partial credentials, carried so a 0 explains itself. */
  exitCodeRequiredForPartial: 'exit code required for partial credentials',
  /** The compatibility shim, so its plaintext expectation reads as deliberate. */
  unitTestCompatibilityDefault: 'unit-test compatibility default',
  /**
   * The diagnostic `configure-etcd-params` emitted, verbatim, or `null` when the
   * branch taken emits none.
   *
   * Load-bearing rather than decorative. AAP §0.10.2 states the fail-closed
   * condition as stderr containing "refusing to fall back to plaintext etcd" AND
   * `exit 1` — the exit code alone does not distinguish an intentional fail-closed
   * abort from a crash, and the message alone does not prove the boot stopped. The
   * plaintext branch is the mirror image: its WARNING is what makes an
   * operator-chosen plaintext transport an announced decision rather than a silent
   * downgrade, which is why the explicit opt-in requires it and the compatibility
   * default (which emits nothing) does not.
   */
  diagnostic: 'diagnostic emitted',
  /** Both GCE profiles must default the opt-out to false. A one-sided edit must fail. */
  insecureFallbackDefaultDefaultProfile:
    'insecure fallback default (cluster/gce/config-default.sh)',
  insecureFallbackDefaultTestProfile: 'insecure fallback default (cluster/gce/config-test.sh)',
} as const);

/**
 * The five V8 scenario titles.
 *
 * Named so the compatibility case and the fail-closed case are visibly different
 * scenarios rather than contradictory expectations of one.
 */
export const V8_SCENARIO_TITLES = Object.freeze({
  mtlsEnabled: 'mTLS enabled: all six credentials supplied',
  unitTestCompatibility: 'unit-test compatibility default: empty environment yields plaintext',
  insecurePermitted: 'insecure fallback explicitly permitted: plaintext with a warning',
  failClosedAbsent: 'fail closed: credentials absent and insecure fallback not permitted',
  failClosedPartial: 'fail closed: credentials only partially supplied',
} as const);

/* ------------------------------------------------------------------------ *
 * Cross-control positive controls
 * ------------------------------------------------------------------------ */

/**
 * The positive-control titles shared across controls.
 *
 * Collected here because a positive control is the same idea everywhere it appears: proof
 * that the mechanism under test can still say YES. Without them, every denial assertion
 * also passes on a cluster where nothing is permitted at all.
 */
export const POSITIVE_CONTROL_TITLES = Object.freeze({
  mastersWildcard: 'system:masters resolves full wildcard authority',
  nodeReadsOwnNode: 'a node reads its own Node object',
  nodeUpdatesOwnNodeStatus: 'a node updates its own Node status',
} as const);

/**
 * Every observation identity in one frozen list, for the uniqueness guard.
 *
 * A spec asserts that this list has no duplicates. That matters because two controls
 * sharing an identity would be harmless, but two identities WITHIN one control's payload
 * would make {@link ./evidence.selectObservation} report a conflict forever — and the
 * cheapest place to catch that is here, at authoring time, rather than in whichever
 * panel happened to read it.
 */
export const ALL_OBSERVATION_IDS: readonly string[] = Object.freeze([
  ...Object.values(V1_OBSERVATIONS),
  ...Object.values(V2_OBSERVATIONS),
  ...Object.values(V3_OBSERVATIONS),
  ...Object.values(V4_OBSERVATIONS),
  ...Object.values(V5_OBSERVATIONS),
  ...Object.values(V6_OBSERVATIONS),
  ...Object.values(V7_OBSERVATIONS),
  ...Object.values(V8_OBSERVATIONS),
]);
