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

// Recorded control-verdict payloads for the eight security-hardening controls
// (V1 through V8), keyed by control identifier.
//
// AAP §0.5.1 (the `web/src/test/fixtures/controlStatus.ts` row: "Recorded
// control-verdict payloads", sourced from tech-spec §6.6.3.3) / §0.5.2.5 (React
// tier fixture detail: "control-verdict payloads keyed by control identifier") /
// §0.5.5 (shared test data has exactly ONE definition site) / §0.4.2.4 (the
// L6/L7 blueprint: every panel spec covers a happy path, an edge case, an error
// case, loading and empty states, and an interaction case) / §0.10.2 (boundary
// conditions that must port unchanged) / tech-spec §6.6.3.4 (every fixture
// states the invariant it locks).
//
// WHAT THIS FILE IS
//   The data behind `PostureDashboard` and all eight per-control panels. It is
//   the last of the three files in `web/src/test/fixtures` in dependency order:
//   it imports two constants from `./encryptionConfig` and the control-posture
//   types from `../../hooks/useControlStatus`, and nothing else.
//
// WHAT THIS FILE IS NOT
//   It is not a source of truth, it is not a generator, and it is not a test.
//   Every value below is transcribed from a measured line of the Go parity
//   oracle or of a committed configuration artifact, each named in the section
//   header that records it. Nothing is normalised, rounded, tidied, reordered or
//   inferred. Where a recorded artifact is frozen (AAP §0.8.2 lists the
//   deployment manifests as out of scope for modification), this file records it
//   and never edits it.
//
// NO USER RULES EXIST FOR THIS PROJECT
//   `review_rules` reports that none were provided, which AAP §0.11 records as a
//   finding and §0.11.2 confirms forces no file into scope. Their absence is not
//   permission to lower the bar: AAP §0.11.1's enterprise-standard bar governs
//   instead, and the seven items of it that bear directly on this file are
//   enumerated below.
//
// MODULE INVARIANTS LOCKED HERE
//
//   1. "Evidence over assumption". Every recorded value cites the file and line
//      it was measured at. A value with no citation does not belong here.
//
//   2. "Never weaken a boundary condition" (AAP §0.10.2). The values in this
//      file ARE the boundaries: the +-60 s token window, the 403-not-404 rule,
//      `failurePolicy: Fail`, `timeoutSeconds: 5`, the null pod and secret
//      sub-claims, the strict audit-level ordering, and the positive controls.
//      Where the compiler can enforce one, it is expressed as a literal or a
//      tuple type so that weakening it is a `tsc --noEmit` error rather than a
//      code-review question.
//
//   3. "Preserve assertion semantics across languages". The Go oracle mixes
//      `t.Errorf` (record the failure and CONTINUE, so one run reports EVERY
//      offender) with `t.Fatalf` (ABORT, reserved for a broken precondition).
//      That asymmetry is encoded here in two distinct places, and collapsing
//      them would hide every finding after the first:
//        * findings are a LIST on every payload, mirroring accumulate; at least
//          one failing payload below carries several, so a panel that renders
//          only the first is caught by its own spec;
//        * a broken POSITIVE CONTROL is not a finding. It is setup breakage, so
//          the corresponding payload carries verdict `unknown` with an EMPTY
//          findings list -- the presentation-layer equivalent of aborting.
//
//   4. "No secrets, ever". The webhook `caBundle` below is the literal
//      placeholder the committed manifest ships. The V8 payloads record
//      certificate PATH strings and never certificate contents. The V7 payloads
//      record principals only: the Go token file's strings are declared "Fake
//      values for testing" at `node_test.go` L1593 and have no place in a user
//      interface fixture, so none is reproduced.
//
//   5. "Cite only what the repository states". Every requirement identifier used
//      here is the repository's own (`F-00n-RQ-00n`). tech-spec §2.5.3 records
//      that the repository enumerates no external benchmark or hardening-guide
//      control numbers, so none is asserted anywhere in this tier -- naming one
//      would be an invention dressed up as a citation.
//
//   6. Determinism (AAP §0.7.2). Every value is a static literal or is derived
//      from static literals by arithmetic that the reader can check. There is no
//      clock, no randomness, no identifier generator and no IO, so two runs of
//      any spec that reads this file see byte-identical data. This matters most
//      for V4, where the recorded request time and the observed expiry are fixed
//      instants exactly `V4_REQUESTED_TTL_SECONDS` apart, which is what makes
//      the +-60 s window demonstrable without a wall clock.
//
//   7. Zero module-level side effects. The module body declares and exports;
//      it mutates no global, constructs no request handler and performs no IO.
//      Conformance is proved at compile time with `satisfies`, which emits
//      nothing at all, rather than at run time with a validator call.
//
// The types are imported from their single definition site and are never
// redeclared here. `ControlStatus` is a closed interface, so per-control detail
// that does not fit its members is exported as a separate named symbol with a
// locally declared type rather than smuggled onto a payload.
import type {
  ControlEvidence,
  ControlExpiry,
  ControlFinding,
  ControlId,
  ControlObservation,
  ControlStatus,
  ControlStatusError,
  ControlVerdict,
} from '../../hooks/useControlStatus';
import { CONTROL_IDS } from '../../hooks/useControlStatus';
import {
  V1_OBSERVATIONS,
  V2_OBSERVATIONS,
  V3_OBSERVATIONS,
  V4_OBSERVATIONS,
  V5_OBSERVATIONS,
  V6_OBSERVATIONS,
  V7_OBSERVATIONS,
  V7_OUTCOME_TITLES,
  V8_OBSERVATIONS,
  v2NamespaceLabelObservation,
  v6ResourceLevelObservation,
} from '../../domain/observationIds';
// The audit-level vocabulary, from the one place it is defined. A fixture that
// declared its own copy could record a level the parser would refuse, or an order
// the panels do not use, and typecheck either way.
import {
  AUDIT_LEVEL_ORDER,
  AUDIT_LEVEL_RANK,
  NODE_AUTHORIZATION_MODE,
  NODE_RESTRICTION_PLUGIN,
  compareAuditLevels,
  type AuditLevel,
} from '../../domain/securityConstants';
// The ONE cross-fixture import this folder permits (AAP §0.5.5), and it reaches a
// single sibling for a single control: the V3 constants and the V3 committed
// manifest each have exactly one definition site, so an edit there propagates here
// instead of diverging. They are deliberately NOT re-littered as literals.
//
// DEPLOYMENT_ENCRYPTION_CONFIG joins the two constants because the V3 passing
// payload must carry the manifest's posture — provider order, encrypted resources,
// KMS timeout, absent cachesize — and re-recording that document here would create
// the second copy this rule exists to prevent. It is read, never rendered: the
// observations below derive from it.
import {
  AESGCM_PREFIX,
  DEPLOYMENT_ENCRYPTION_CONFIG,
  PLAINTEXT_CANARY,
} from './encryptionConfig';

// ---------------------------------------------------------------------------
// SECTION 0 -- Shared vocabulary.
//
// Declared locally on purpose. `web/src/hooks` defines the control-posture
// types and nothing else, and this tier has no shared-types module, so nothing
// further is imported and nothing is invented (AAP §0.11.1, "evidence over
// assumption").
// ---------------------------------------------------------------------------

/**
 * How a failed assertion behaves in the Go oracle.
 *
 * - `accumulate` -- `t.Errorf`: the failure is recorded and the test continues,
 *   so ONE run reports EVERY finding. This is why {@link ControlStatus.findings}
 *   is a list.
 * - `abort` -- `t.Fatalf`: the run stops immediately. Reserved for a broken
 *   precondition, where every later assertion would be reading meaningless data.
 *   Its presentation-layer equivalent is a verdict of `unknown` with no
 *   findings, never a `pass` and never a `fail`.
 *
 * AAP §0.10.2 requires this asymmetry to port unchanged.
 *
 * Named distinctly from the equivalent vocabulary in `./encryptionConfig` so the
 * two never read as interchangeable: that one classifies the four V3 encryption
 * assertions specifically, this one classifies assertions across all eight
 * controls.
 */
export type AssertionSeverity = 'abort' | 'accumulate';

/**
 * The repository's own requirement identifiers, enumerated as a closed union so
 * a typo is a compile error rather than an unattributed finding.
 *
 * Reporting these is what makes a failure read as a requirement violation rather
 * than as a value mismatch -- the "failure legibility" criterion of AAP §0.7.2,
 * which matters disproportionately for security checks because the reader of a
 * CI failure is often not the author of the test.
 */
export type PostureRequirementId =
  | 'F-001-RQ-001'
  | 'F-001-RQ-002'
  | 'F-002-RQ-001'
  | 'F-002-RQ-002'
  | 'F-002-RQ-003'
  | 'F-003-RQ-001'
  | 'F-003-RQ-002'
  | 'F-003-RQ-003'
  | 'F-004-RQ-001'
  | 'F-004-RQ-002'
  | 'F-005-RQ-001'
  | 'F-006-RQ-001'
  | 'F-006-RQ-002'
  | 'F-006-RQ-003'
  | 'F-007-RQ-001'
  | 'F-007-RQ-002'
  | 'F-008-RQ-001'
  | 'F-008-RQ-002'
  | 'F-008-RQ-003';

/**
 * Which recorded flavour of a control payload a spec is asking for.
 *
 * These three are exhaustive over the payload MAPS below. The two remaining
 * states a panel must also render are deliberately NOT variants here, because
 * neither is a `ControlStatus`:
 *   * `loading` and the empty state are properties of the hook result, reached
 *     through {@link NO_CONTROL_STATUSES} and the hook's own `loading` arm;
 *   * the error state is a {@link ControlStatusError}, which by design carries no
 *     verdict at all -- see {@link CONTROL_STATUS_ERRORS}.
 */
export type ControlStatusVariant = 'passing' | 'failing' | 'unknown';

/**
 * The verdict each variant is required to carry.
 *
 * Invariant locked: `passing` maps to `pass`, `failing` to `fail`, and `unknown`
 * to `unknown` -- and nothing maps to `pass` except `passing`. A spec asserts
 * against this map instead of hardcoding the expected verdict, so a payload
 * whose verdict drifts away from its variant is caught by every panel spec at
 * once rather than by none of them.
 */
export const EXPECTED_VERDICT_BY_VARIANT = {
  passing: 'pass',
  failing: 'fail',
  unknown: 'unknown',
} as const satisfies Record<ControlStatusVariant, ControlVerdict>;

/**
 * HTTP status of a deterministic authorization denial: `403 Forbidden`.
 *
 * This is the wire-level counterpart of the Go oracle's `apierrors.IsForbidden`
 * checks -- `podsecurity_test.go` L407 and L419, and `node_test.go` L698 via
 * `expectForbidden`.
 */
export const FORBIDDEN_STATUS = 403;

/**
 * HTTP status of a missing object: `404 Not Found`.
 *
 * Recorded so that the difference from {@link FORBIDDEN_STATUS} is nameable, and
 * present ONLY so it can be rendered as a failure. See
 * {@link V7_NODE_RESTRICTION_NOT_FOUND} for why a 404 must never be a pass.
 */
export const NOT_FOUND_STATUS = 404;

/** HTTP status of a server-side failure: `500 Internal Server Error`. */
export const INTERNAL_SERVER_ERROR_STATUS = 500;

/**
 * The single evaluation instant every recorded payload reports, as an RFC 3339
 * string.
 *
 * One frozen instant is shared across all eight controls on purpose: it gives
 * the whole fixture set one reference clock, so a dashboard spec can assert that
 * every panel agrees on when the posture was measured. It is deliberately the
 * same instant as {@link V4_REQUEST_TIME_SECONDS}, so the V4 window arithmetic
 * and the dashboard timestamp cannot drift apart.
 */
export const OBSERVED_AT = '2026-01-01T00:00:00Z';

/**
 * A positive control: an operation that MUST succeed for a negative assertion to
 * mean anything.
 *
 * WHY THIS TYPE EXISTS AT ALL, and why it is separate from
 * {@link ControlStatus.findings}. The Go oracle pairs its denial assertions with
 * allowance assertions precisely because a check that cannot tell "correctly
 * denied" from "everything is broken" ALSO passes when the entire authorization
 * stack is down. `rbac_test.go` L1252-1254 makes the distinction explicit: a
 * failed positive control aborts with "test setup broken", and is deliberately
 * NOT reported as a security finding.
 *
 * Collapsing the two would be a silent downgrade in assurance, so they are
 * modelled apart: findings accumulate on the payload, and positive controls live here
 * and in {@link CONTROL_POSITIVE_CONTROLS}.
 *
 * WHAT A BROKEN POSITIVE CONTROL PRODUCES IS PER CONTROL, not universal. V1's aborts
 * (`t.Fatalf`) and yields `unknown` with no findings; V7's two accumulate (`t.Errorf`
 * via `expectAllowed`) and yield `fail` with one finding each. See
 * {@link PositiveControl.severityWhenBroken}.
 */
export interface PositiveControl {
  /** Stable, human-readable name of the control, suitable for a panel row. */
  readonly label: string;
  /** The identity the operation is performed as. */
  readonly principal: string;
  /** What is attempted. */
  readonly operation: string;
  /** What must happen for the surrounding negative assertions to be meaningful. */
  readonly expectation: string;
  /**
   * How the oracle behaves when THIS positive control fails.
   *
   * PER CONTROL, AND MEASURED RATHER THAN ASSUMED. This field was previously the narrow
   * literal `'abort'`, on the reasoning that a positive control is by nature a
   * precondition. The Go source says otherwise, and it says so plainly:
   *
   *   * V1's positive control is reported with `t.Fatalf` (`rbac_test.go` L1252-L1254)
   *     and its message begins "test setup broken", so the run ABORTS and the payload
   *     carries `unknown` with an empty findings list;
   *   * V7's two positive controls go through `expectAllowed` (`node_test.go`
   *     L1712-L1716), which reports with `t.Errorf`. They ACCUMULATE: the run continues
   *     and one evaluation reports both, so the payload carries `fail` with one finding
   *     each.
   *
   * Pinning this to `'abort'` made the V7 truth unrepresentable -- recording it was a
   * compile error -- which meant the tier stated V7's semantics incorrectly and could
   * not be corrected without widening the type. It is now {@link AssertionSeverity},
   * and each entry records what its own oracle does.
   */
  readonly severityWhenBroken: AssertionSeverity;
  /** Where the behaviour was measured, as `<path> L<from>-L<to>`. */
  readonly sourceReference: string;
}

// ---------------------------------------------------------------------------
// SECTION 1 -- V1, RBAC least-privilege. F-001-RQ-001 / F-001-RQ-002.
//
// Recorded from `test/integration/auth/rbac_test.go`
// (`TestRBACNoWildcardOutsideSystemMasters`, L1170-1299).
//
// THE INVARIANT: a full wildcard rule exists ONLY in the `cluster-admin`
// ClusterRole and is bound ONLY to the `system:masters` group.
//
// THE PREDICATE IS ALL THREE STARS AT ONCE. `policyRuleIsFullWildcard`
// (L1158-1167) returns `hasStar(Verbs) && hasStar(APIGroups) &&
// hasStar(Resources)`. The conjunction is load-bearing and must not be relaxed
// to a disjunction: it deliberately EXCLUDES read-only broad grants such as
// `system:kube-controller-manager`, which holds list/watch on */* and is
// least-privilege and expected (L1154-1157). A disjunctive predicate would flood
// the panel with false findings and train its reader to ignore it.
// ---------------------------------------------------------------------------

/**
 * The all-three-stars resource attributes both SubjectAccessReviews are
 * evaluated against, recorded from `rbac_test.go` L1225 and L1243.
 *
 * Written in prose as "all verbs, all API groups and all resources", and kept as
 * three separate members here because the predicate tests them independently.
 */
export const V1_FULL_WILDCARD_ATTRIBUTES = {
  verb: '*',
  group: '*',
  resource: '*',
} as const;

/**
 * The non-privileged identity that must NOT resolve full wildcard authority,
 * recorded from `rbac_test.go` L1226-1227.
 *
 * A violation here is a FINDING, not setup breakage: the oracle reports it with
 * `t.Errorf` at L1234-1236 and carries on.
 */
export const V1_DENIED_SUBJECT = {
  user: 'system:serviceaccount:default:default',
  groups: [
    'system:authenticated',
    'system:serviceaccounts',
    'system:serviceaccounts:default',
  ],
  severityWhenViolated: 'accumulate',
} as const satisfies {
  readonly user: string;
  readonly groups: readonly string[];
  readonly severityWhenViolated: AssertionSeverity;
};

/**
 * The privileged identity that MUST resolve full wildcard authority, recorded
 * from `rbac_test.go` L1244-1245.
 *
 * This is the V1 positive control. Without it the check ALSO passes when the
 * whole authorization stack is broken, because "denied" and "nothing works" are
 * indistinguishable from the denial assertion alone.
 */
export const V1_POSITIVE_CONTROL_SUBJECT = {
  user: 'admin',
  groups: ['system:masters', 'system:authenticated'],
} as const satisfies {
  readonly user: string;
  readonly groups: readonly string[];
};

/**
 * The one ClusterRole permitted to carry a full wildcard rule, recorded from
 * `rbac_test.go` L1270-1272 and corroborated by
 * `plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go` L312/L314.
 */
export const V1_PERMITTED_WILDCARD_ROLE = 'cluster-admin';

/**
 * The one group a full-wildcard role may be bound to, recorded from
 * `rbac_test.go` L1294 (`user.SystemPrivilegedGroup`) and corroborated by
 * `policy.go` L681.
 */
export const V1_PERMITTED_WILDCARD_GROUP = 'system:masters';

/**
 * The only subject kind a full-wildcard binding may name, recorded from
 * `rbac_test.go` L1294 (`rbacapi.GroupKind`).
 *
 * Both halves of that condition matter: a binding to a ServiceAccount or a User
 * named `system:masters` is still a finding, because the KIND must be `Group`.
 */
export const V1_PERMITTED_WILDCARD_SUBJECT_KIND = 'Group';

/**
 * V1 passing payload.
 *
 * INVARIANT LOCKED (F-001-RQ-001, F-001-RQ-002): the non-master identity is
 * denied, the positive control is allowed, `cluster-admin` is the sole role
 * carrying the wildcard, and every binding of it names only the `system:masters`
 * group.
 *
 * Note the two positive-control observations. They are recorded in the passing
 * payload as well as the failing one, so a panel can show that the denial was
 * measured against a working authorization stack rather than a broken one.
 */
export const V1_RBAC_PASSING = {
  controlId: 'V1',
  verdict: 'pass',
  summary: 'No identity outside system:masters resolves full wildcard authority.',
  detail:
    'A SubjectAccessReview for */*/* was denied for a non-privileged ' +
    'ServiceAccount identity and allowed for a system:masters identity. ' +
    'Enumerating the bootstrapped policy found the full wildcard rule only in ' +
    'the cluster-admin ClusterRole, bound only to the system:masters group.',
  requirementIds: ['F-001-RQ-001', 'F-001-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V1_OBSERVATIONS.requestedAttributes, value: '*/*/*' },
      { label: V1_OBSERVATIONS.deniedSubjectUser, value: V1_DENIED_SUBJECT.user },
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: false },
      {
        label: V1_OBSERVATIONS.positiveControlUser,
        value: V1_POSITIVE_CONTROL_SUBJECT.user,
      },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: true },
      {
        label: V1_OBSERVATIONS.wildcardClusterRoles,
        value: V1_PERMITTED_WILDCARD_ROLE,
      },
      {
        label: V1_OBSERVATIONS.wildcardClusterRolesOutsideClusterAdmin,
        value: 0,
      },
      {
        label: V1_OBSERVATIONS.wildcardBindingsOutsideMasters,
        value: 0,
      },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * The V1 findings, as several entries rather than one.
 *
 * WHY THERE ARE THREE. The oracle emits one `t.Errorf` PER offender -- one per
 * offending ClusterRole at L1274-1278, and one per offending ClusterRoleBinding
 * and per offending subject at L1286-1297 -- so a single run reports the
 * complete offender set. Recording several here is what makes a panel that
 * renders only `findings[0]` fail its own spec instead of silently under-
 * reporting a privilege-escalation path.
 *
 * The two role and binding offenders are illustrative names, not measured ones:
 * the oracle's green baseline has no offenders to measure, so a failing fixture
 * necessarily describes a hypothetical cluster. The SHAPE and the SEVERITY are
 * measured; the object names are not, and are chosen to be obviously synthetic.
 */
export const V1_RBAC_FINDINGS = [
  {
    message:
      'ClusterRole "example-superuser" carries a full wildcard rule (verbs, ' +
      'apiGroups and resources all "*") outside cluster-admin; least-privilege ' +
      'RBAC requires none.',
    subject: 'clusterrole/example-superuser',
    requirementId: 'F-001-RQ-001',
  },
  {
    message:
      'ClusterRoleBinding "example-escalation" grants the full-wildcard role ' +
      '"cluster-admin" to subject ServiceAccount/"example-runner" outside the ' +
      'system:masters group; least-privilege RBAC requires binding the full ' +
      'wildcard only to that group.',
    subject: 'clusterrolebinding/example-escalation',
    requirementId: 'F-001-RQ-002',
  },
  {
    message:
      'Non-master identity "system:serviceaccount:default:default" resolved ' +
      'full wildcard */*/* authority (status.allowed=true); least-privilege ' +
      'RBAC requires denial.',
    subject: 'system:serviceaccount:default:default',
    requirementId: 'F-001-RQ-001',
  },
] as const satisfies readonly ControlFinding[];

/**
 * V1 failing payload: the wildcard escaped `cluster-admin` and `system:masters`.
 *
 * The positive control STILL HOLDS here -- `positive control: status.allowed` is
 * `true` -- which is exactly what makes these three entries genuine security
 * findings rather than setup breakage. Contrast {@link V1_RBAC_UNKNOWN}.
 */
export const V1_RBAC_FAILING = {
  controlId: 'V1',
  verdict: 'fail',
  summary: 'Full wildcard authority is reachable outside system:masters.',
  detail:
    'Every offender is listed. The oracle reports one finding per offending ' +
    'ClusterRole, ClusterRoleBinding and subject and continues, so this list ' +
    'is the complete set from a single evaluation and not merely the first ' +
    'failure encountered.',
  requirementIds: ['F-001-RQ-001', 'F-001-RQ-002'],
  findings: V1_RBAC_FINDINGS,
  warnings: [],
  evidence: {
    observations: [
      { label: V1_OBSERVATIONS.requestedAttributes, value: '*/*/*' },
      { label: V1_OBSERVATIONS.deniedSubjectUser, value: V1_DENIED_SUBJECT.user },
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: true },
      {
        label: V1_OBSERVATIONS.positiveControlUser,
        value: V1_POSITIVE_CONTROL_SUBJECT.user,
      },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: true },
      {
        label: V1_OBSERVATIONS.wildcardClusterRolesOutsideClusterAdmin,
        value: 1,
      },
      {
        label: V1_OBSERVATIONS.wildcardBindingsOutsideMasters,
        value: 1,
      },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V1 indeterminate payload: the POSITIVE CONTROL failed.
 *
 * INVARIANT LOCKED -- this is the presentation-layer form of `t.Fatalf`. The
 * oracle aborts at L1252-1254 with "test setup broken" when a `system:masters`
 * identity is denied all verbs, groups and resources, because from that point on
 * nothing the denial assertion reports can be trusted: a stack that denies
 * everything denies the non-master identity too, and would otherwise read as a
 * clean pass.
 *
 * Hence, deliberately:
 *   * the verdict is `unknown`, NOT `pass` and NOT `fail`;
 *   * `findings` is EMPTY -- setup breakage is not a security finding;
 *   * the reason is carried in `detail` and in the observations.
 */
export const V1_RBAC_UNKNOWN = {
  controlId: 'V1',
  verdict: 'unknown',
  summary: 'RBAC least-privilege could not be evaluated.',
  detail:
    'Setup breakage, not a security finding: the system:masters positive ' +
    'control was DENIED full wildcard authority, so the cluster-admin grant is ' +
    'missing or the authorization stack is not answering. A stack that denies ' +
    'everything also denies the non-privileged identity, so the denial ' +
    'assertion carries no information and no verdict is reported.',
  requirementIds: ['F-001-RQ-001', 'F-001-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      {
        label: V1_OBSERVATIONS.positiveControlUser,
        value: V1_POSITIVE_CONTROL_SUBJECT.user,
      },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: false },
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: null },
      { label: V1_OBSERVATIONS.clusterRolesObserved, value: 0 },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

// ---------------------------------------------------------------------------
// SECTION 2 -- V2, Pod Security enforcement.
// F-002-RQ-001 / F-002-RQ-002 / F-002-RQ-003.
//
// Recorded from `test/integration/auth/podsecurity_test.go`
// (`TestPodSecurityEnforceBaselineRejectsPrivileged`, L357-457) and from the
// admission configuration generated by `cluster/gce/gci/configure-helper.sh`
// L1097-1109.
//
// THE INVARIANT: `enforce=baseline` REJECTS privileged and hostPID pods with
// 403; `warn=restricted` ADMITS a restricted-violating pod and simultaneously
// surfaces at least one warning.
//
// THE PRECONDITION THAT MAKES THE REJECTION MEANINGFUL (L367-374, L375-387).
// `kubeapiservertesting` starts only the API server, so no controller creates
// the namespace's `default` ServiceAccount, while the ServiceAccount admission
// plugin IS enabled. Without creating that ServiceAccount up front, pod creation
// fails with a NON-Forbidden error before ever reaching the PodSecurity plugin,
// and the rejection assertion would pass for entirely the wrong reason. The
// oracle therefore creates it first, mirroring
// `staging/src/k8s.io/pod-security-admission/test/run.go` L229-234.
//
// WHY NOTHING PERSISTS (L391-392). Every creation uses `DryRun: ["All"]`, which
// runs the full admission chain -- so the PodSecurity decision is real -- yet
// writes nothing, keeping the shared etcd clean.
// ---------------------------------------------------------------------------

/**
 * The generated PodSecurity admission configuration, recorded from
 * `cluster/gce/gci/configure-helper.sh` L1097-1109.
 *
 * INVARIANT LOCKED (F-002-RQ-001): `enforce=baseline` with `warn` and `audit` at
 * `restricted`, and exactly one exempt namespace.
 *
 * The two envelope identifiers are pinned as literal types so that a drift in
 * either API version is a compile error: the outer document is
 * `apiserver.config.k8s.io/v1` and the inner PodSecurity plugin configuration is
 * `pod-security.admission.config.k8s.io/v1`. The `exemptions` lists are recorded
 * complete -- `usernames` and `runtimeClasses` are EMPTY, and recording them as
 * empty rather than omitting them is what lets a spec prove that nothing has
 * been quietly exempted.
 */
export const V2_GENERATED_ADMISSION_CONFIG = {
  envelopeApiVersion: 'apiserver.config.k8s.io/v1',
  pluginApiVersion: 'pod-security.admission.config.k8s.io/v1',
  kind: 'PodSecurityConfiguration',
  defaults: {
    enforce: 'baseline',
    enforceVersion: 'latest',
    warn: 'restricted',
    warnVersion: 'latest',
    audit: 'restricted',
    auditVersion: 'latest',
  },
  exemptions: {
    usernames: [],
    runtimeClasses: [],
    namespaces: ['kube-system'],
  },
} as const satisfies {
  readonly envelopeApiVersion: 'apiserver.config.k8s.io/v1';
  readonly pluginApiVersion: 'pod-security.admission.config.k8s.io/v1';
  readonly kind: 'PodSecurityConfiguration';
  readonly defaults: {
    readonly enforce: 'privileged' | 'baseline' | 'restricted';
    readonly enforceVersion: string;
    readonly warn: 'privileged' | 'baseline' | 'restricted';
    readonly warnVersion: string;
    readonly audit: 'privileged' | 'baseline' | 'restricted';
    readonly auditVersion: string;
  };
  readonly exemptions: {
    readonly usernames: readonly string[];
    readonly runtimeClasses: readonly string[];
    readonly namespaces: readonly string[];
  };
};

/**
 * The two labelled namespaces the oracle exercises, recorded from
 * `podsecurity_test.go` L393-394 and L427-428.
 *
 * The label KEYS are the Pod Security admission label prefix plus the mode, and
 * are reproduced exactly: a panel that renders `pod-security.k8s.io/enforce`
 * instead of `pod-security.kubernetes.io/enforce` would be describing a label
 * that enforces nothing.
 */
export const V2_NAMESPACES = {
  enforceBaseline: {
    name: 'psa-enforce-baseline',
    labelKey: 'pod-security.kubernetes.io/enforce',
    labelValue: 'baseline',
  },
  warnRestricted: {
    name: 'psa-warn-restricted',
    labelKey: 'pod-security.kubernetes.io/warn',
    labelValue: 'restricted',
  },
} as const;

/**
 * The ServiceAccount all three recorded pods run as, from `podsecurity_test.go`
 * L399, L414 and L444.
 *
 * `default`, and set EXPLICITLY by the oracle rather than left to be defaulted.
 * AAP §0.10.2 records why: the namespace's `default` ServiceAccount must exist
 * before the pod is created, or a ServiceAccount error masks the PodSecurity
 * rejection and the 403 proves the wrong thing.
 */
export const V2_POD_SERVICE_ACCOUNT_NAME = 'default';

/** The single container's name on all three recorded pods (L402, L417, L447). */
export const V2_POD_CONTAINER_NAME = 'c';

/** The container image on all three recorded pods (L403, L417, L447), verbatim. */
export const V2_POD_CONTAINER_IMAGE = 'busybox';

/**
 * Whether `PodSecurity` appears in `ADMISSION_CONTROL`, recorded per GCE profile.
 *
 * INVARIANT LOCKED (F-002-RQ-002). Recorded from `cluster/gce/config-default.sh`
 * L374 and `cluster/gce/config-test.sh` L418, each of which declares the plugin
 * list independently of the other.
 *
 * TWO ENTRIES AND NOT ONE BOOLEAN, for the same reason the etcd insecure-fallback
 * defaults are recorded per profile: a one-sided edit is the failure mode. Dropping
 * `PodSecurity` from the test profile while the default profile still listed it
 * would leave every test-profile deployment with no Pod Security admission at all,
 * and a single combined flag would still read as green.
 */
export const V2_ADMISSION_CONTROL_PROFILES = {
  'cluster/gce/config-default.sh': true,
  'cluster/gce/config-test.sh': true,
} as const satisfies Record<string, boolean>;

/**
 * The `PodSecurity`-in-both-profiles measurement, as panel observations.
 *
 * Derived from {@link V2_ADMISSION_CONTROL_PROFILES} rather than written out, so the
 * evidence a panel gates on and the record above cannot diverge.
 */
export const V2_ADMISSION_CONTROL_OBSERVATIONS: readonly ControlObservation[] = [
  {
    label: V2_OBSERVATIONS.admissionControlDefaultProfile,
    value: V2_ADMISSION_CONTROL_PROFILES['cluster/gce/config-default.sh'],
  },
  {
    label: V2_OBSERVATIONS.admissionControlTestProfile,
    value: V2_ADMISSION_CONTROL_PROFILES['cluster/gce/config-test.sh'],
  },
];

/**
 * The three pods the oracle creates, recorded from `podsecurity_test.go`
 * L396-421 and L439-449.
 *
 * `expectedHttpStatus` is 403 for the two rejections and `null` for the admitted
 * pod -- `null` meaning "admitted, so no error status exists", which is a
 * measured outcome and not a missing value.
 *
 * THE POD DOCUMENT SHAPE IS RECORDED TOO, and it is not decoration. The recorded
 * outcome of a pod creation is only the outcome OF THAT POD: a 403 that names
 * `securityContext.privileged=true` is evidence about a privileged pod and about
 * nothing else. While only the name and namespace were recorded, a replay handler
 * could serve that 403 for a pod carrying no `securityContext` at all — an
 * admission decision replayed for a document that could not have produced it,
 * which makes the rejection unfalsifiable. `serviceAccountName` is included
 * because AAP §0.10.2 makes the namespace's `default` ServiceAccount a
 * PRECONDITION: the oracle sets it explicitly on all three pods (L399, L414,
 * L444) so that a rejection is genuinely a PodSecurity Forbidden rather than a
 * ServiceAccount error.
 *
 * `image: 'busybox'` is the oracle's own image string (L403, L417, L447), recorded
 * verbatim rather than modernised: the field is part of the document whose
 * admission outcome was measured.
 */
export const V2_PODS = [
  {
    name: 'privileged-pod',
    namespace: V2_NAMESPACES.enforceBaseline.name,
    violation: 'securityContext.privileged=true',
    admitted: false,
    expectedHttpStatus: FORBIDDEN_STATUS,
    severityWhenViolated: 'accumulate',
    serviceAccountName: V2_POD_SERVICE_ACCOUNT_NAME,
    containerName: V2_POD_CONTAINER_NAME,
    containerImage: V2_POD_CONTAINER_IMAGE,
    privileged: true,
    hostPID: false,
    sourceReference: 'test/integration/auth/podsecurity_test.go L396-L409',
  },
  {
    name: 'hostpid-pod',
    namespace: V2_NAMESPACES.enforceBaseline.name,
    violation: 'spec.hostPID=true',
    admitted: false,
    expectedHttpStatus: FORBIDDEN_STATUS,
    severityWhenViolated: 'accumulate',
    serviceAccountName: V2_POD_SERVICE_ACCOUNT_NAME,
    containerName: V2_POD_CONTAINER_NAME,
    containerImage: V2_POD_CONTAINER_IMAGE,
    privileged: false,
    hostPID: true,
    sourceReference: 'test/integration/auth/podsecurity_test.go L411-L421',
  },
  {
    name: 'warn-pod',
    namespace: V2_NAMESPACES.warnRestricted.name,
    violation:
      'no securityContext: violates restricted (runAsNonRoot, seccompProfile, ' +
      'drop-ALL capabilities, allowPrivilegeEscalation=false) yet complies ' +
      'with baseline',
    admitted: true,
    expectedHttpStatus: null,
    severityWhenViolated: 'accumulate',
    serviceAccountName: V2_POD_SERVICE_ACCOUNT_NAME,
    containerName: V2_POD_CONTAINER_NAME,
    containerImage: V2_POD_CONTAINER_IMAGE,
    // NEITHER flag set, and that is the whole of this case: a plain pod violates
    // `restricted` while complying with `baseline`, so it is ADMITTED under an
    // enforce level left at the cluster default and still surfaces a warning.
    privileged: false,
    hostPID: false,
    sourceReference: 'test/integration/auth/podsecurity_test.go L439-L456',
  },
] as const satisfies readonly {
  readonly name: string;
  readonly namespace: string;
  readonly violation: string;
  readonly admitted: boolean;
  readonly expectedHttpStatus: number | null;
  readonly severityWhenViolated: AssertionSeverity;
  /** The ServiceAccount the pod runs as. The PRECONDITION of AAP §0.10.2. */
  readonly serviceAccountName: string;
  readonly containerName: string;
  readonly containerImage: string;
  /** `spec.containers[0].securityContext.privileged`, absent unless `true`. */
  readonly privileged: boolean;
  /** `spec.hostPID`, absent unless `true`. */
  readonly hostPID: boolean;
  readonly sourceReference: string;
}[];

/**
 * The warning text the `warn=restricted` namespace surfaces.
 *
 * Recorded as the API server's own warning shape, enumerating the four
 * restricted-profile violations `podsecurity_test.go` L437-438 names. It is a
 * single string in a LIST because the warning channel carries strings and the
 * oracle counts them: L451-455 reads the recorded warnings under a mutex and
 * fails when the count is zero. The assertion is "at least one", so the list is
 * the meaningful unit and its exact text is not asserted.
 */
export const V2_RESTRICTED_WARNINGS = [
  'would violate PodSecurity "restricted:latest": allowPrivilegeEscalation != ' +
    'false (container "c" must set securityContext.allowPrivilegeEscalation=' +
    'false), unrestricted capabilities (container "c" must set ' +
    'securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or ' +
    'container "c" must set securityContext.runAsNonRoot=true), seccompProfile ' +
    '(pod or container "c" must set securityContext.seccompProfile.type to ' +
    '"RuntimeDefault" or "Localhost")',
] as const satisfies readonly string[];


/**
 * V2 passing payload: all THREE measured paths of the oracle, in one payload.
 *
 * INVARIANT LOCKED (F-002-RQ-001, F-002-RQ-003): the privileged pod and the
 * hostPID pod are both rejected with 403, and the rejection is genuinely a
 * PodSecurity decision because the namespace's `default` ServiceAccount existed
 * first; and the `warn=restricted` namespace ADMITS its pod while still
 * objecting to it.
 *
 * WHY ALL THREE, and this is the correction that matters:
 * `TestPodSecurityEnforceBaselineRejectsPrivileged` is ONE test function whose
 * single verdict covers four `t.Errorf` assertions -- the two rejections
 * (L408, L420), the admission under `warn=restricted` (L447-L449) and the
 * non-zero warning count (L451-L455). A payload that claims `pass` for V2 while
 * recording only the enforce half is claiming more than it measured, and
 * `PodSecurityPanel`'s own pass sentence says so out loud: "the enforced level
 * rejected every violating pod AND the warned level objected as expected".
 * Recording only two of the three paths here is what let that sentence be
 * rendered without evidence for its second clause. The panel now REQUIRES all
 * three before it will render a pass, so the recorded pass records all three.
 *
 * `warnings` is therefore non-empty on a PASSING payload, which is correct
 * rather than contradictory: under `warn=restricted` a warning is REQUIRED
 * evidence, not a defect. Its absence is the failure (L451-L455), which is why
 * {@link V2_POD_SECURITY_WARNING} keeps the warn half on its own as a separate,
 * narrower scenario.
 *
 * The precondition and the dry-run posture are recorded as observations rather
 * than left in a comment, so the panel can show WHY the 403 is trustworthy.
 */
export const V2_POD_SECURITY_PASSING = {
  controlId: 'V2',
  verdict: 'pass',
  summary: 'enforce=baseline rejected privileged and hostPID pods; warn=restricted objected.',
  detail:
    'Both offending pods were rejected with 403 Forbidden by the PodSecurity ' +
    'admission plugin. The namespace default ServiceAccount was created before ' +
    'the pods, so neither rejection can be a ServiceAccount error masquerading ' +
    'as a Pod Security decision, and both creations ran with dry-run so nothing ' +
    'persisted. In the separately labelled warn=restricted namespace the ' +
    'restricted-violating pod was admitted -- enforce is left at the cluster ' +
    'default of privileged -- and the server still returned a warning.',
  requirementIds: ['F-002-RQ-001', 'F-002-RQ-002', 'F-002-RQ-003'],
  findings: [],
  warnings: V2_RESTRICTED_WARNINGS,
  evidence: {
    observations: [
      {
        label: v2NamespaceLabelObservation(
          V2_NAMESPACES.enforceBaseline.name,
          V2_NAMESPACES.enforceBaseline.labelKey,
        ),
        value: V2_NAMESPACES.enforceBaseline.labelValue,
      },
      { label: V2_OBSERVATIONS.privilegedPodStatus, value: FORBIDDEN_STATUS },
      { label: V2_OBSERVATIONS.hostPidPodStatus, value: FORBIDDEN_STATUS },
      {
        label: V2_OBSERVATIONS.defaultServiceAccountPrecondition,
        value: true,
      },
      { label: V2_OBSERVATIONS.dryRun, value: 'All' },
      {
        label: v2NamespaceLabelObservation(
          V2_NAMESPACES.warnRestricted.name,
          V2_NAMESPACES.warnRestricted.labelKey,
        ),
        value: V2_NAMESPACES.warnRestricted.labelValue,
      },
      { label: V2_OBSERVATIONS.warnPodAdmitted, value: true },
      { label: V2_OBSERVATIONS.warnPodStatus, value: null },
      { label: V2_OBSERVATIONS.warningsRecorded, value: V2_RESTRICTED_WARNINGS.length },
      { label: V2_OBSERVATIONS.effectiveEnforceLevel, value: 'privileged' },
      {
        label: V2_OBSERVATIONS.admissionEnforce,
        value: V2_GENERATED_ADMISSION_CONFIG.defaults.enforce,
      },
      {
        label: V2_OBSERVATIONS.admissionWarn,
        value: V2_GENERATED_ADMISSION_CONFIG.defaults.warn,
      },
      {
        label: V2_OBSERVATIONS.admissionAudit,
        value: V2_GENERATED_ADMISSION_CONFIG.defaults.audit,
      },
      {
        label: V2_OBSERVATIONS.admissionExemptNamespaces,
        value: V2_GENERATED_ADMISSION_CONFIG.exemptions.namespaces.join(','),
      },
      // F-002-RQ-002, measured per profile. This payload claims all three V2
      // requirements, and until these two observations existed the third of them
      // rested on nothing at all: the runtime behaviour above proves the plugin was
      // enabled on the SERVER THE ORACLE STARTED, not that either shipped GCE
      // profile enables it.
      ...V2_ADMISSION_CONTROL_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V2 warning payload: `warn=restricted` ADMITTED the pod and warned about it.
 *
 * INVARIANT LOCKED (F-002-RQ-003): this is neither a pass nor a fail, and
 * `ControlVerdict` carries `warn` as a first-class outcome precisely so it need
 * not be forced into either. The oracle asserts BOTH halves and would fail on
 * either alone: the create must succeed (L447-449, `err != nil` is an error) AND
 * at least one warning must have been recorded (L451-455, `gotWarnings == 0` is
 * an error). Collapsing this into `pass` would lose the warning; collapsing it
 * into `fail` would misreport a namespace that is behaving exactly as configured.
 *
 * `enforce` is left at the cluster default of `privileged`, which is why the pod
 * is admitted at all -- `startPodSecurityServer` passes no
 * `--admission-control-config-file`, and unset Pod Security levels default to
 * `privileged` per
 * `staging/src/k8s.io/pod-security-admission/admission/api/v1/defaults.go`
 * (L423-426).
 */
export const V2_POD_SECURITY_WARNING = {
  controlId: 'V2',
  verdict: 'warn',
  summary: 'warn=restricted admitted the pod and surfaced a warning.',
  detail:
    'The restricted-violating pod was admitted because enforce is left at the ' +
    'cluster default of privileged, and the server simultaneously returned at ' +
    'least one Pod Security warning. Both halves are required: an admission ' +
    'with no warning, and a rejection, are each a failure of this control.',
  requirementIds: ['F-002-RQ-003'],
  findings: [],
  warnings: V2_RESTRICTED_WARNINGS,
  evidence: {
    observations: [
      {
        label: v2NamespaceLabelObservation(
          V2_NAMESPACES.warnRestricted.name,
          V2_NAMESPACES.warnRestricted.labelKey,
        ),
        value: V2_NAMESPACES.warnRestricted.labelValue,
      },
      { label: V2_OBSERVATIONS.warnPodAdmitted, value: true },
      { label: V2_OBSERVATIONS.warnPodStatus, value: null },
      { label: V2_OBSERVATIONS.warningsRecorded, value: V2_RESTRICTED_WARNINGS.length },
      { label: V2_OBSERVATIONS.effectiveEnforceLevel, value: 'privileged' },
      { label: V2_OBSERVATIONS.dryRun, value: 'All' },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V2 failing payload: `enforce=baseline` ADMITTED both offending pods.
 *
 * Two findings, one per admitted pod, mirroring the oracle's two independent
 * `t.Errorf` calls at L408 and L420. Reporting only the first would leave a
 * reader believing hostPID was still blocked.
 */
export const V2_POD_SECURITY_FAILING = {
  controlId: 'V2',
  verdict: 'fail',
  summary: 'enforce=baseline admitted pods it must reject.',
  detail:
    'Both offending pods were admitted. Because the namespace default ' +
    'ServiceAccount existed, this is a genuine Pod Security enforcement gap and ' +
    'not a masked ServiceAccount error.',
  requirementIds: ['F-002-RQ-001', 'F-002-RQ-003'],
  findings: [
    {
      message:
        'Pod "privileged-pod" with securityContext.privileged=true was ADMITTED ' +
        'in namespace "psa-enforce-baseline"; enforce=baseline requires 403 ' +
        'Forbidden.',
      subject: 'pod/privileged-pod',
      requirementId: 'F-002-RQ-001',
    },
    {
      message:
        'Pod "hostpid-pod" with spec.hostPID=true was ADMITTED in namespace ' +
        '"psa-enforce-baseline"; enforce=baseline requires 403 Forbidden.',
      subject: 'pod/hostpid-pod',
      requirementId: 'F-002-RQ-001',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      {
        label: v2NamespaceLabelObservation(
          V2_NAMESPACES.enforceBaseline.name,
          V2_NAMESPACES.enforceBaseline.labelKey,
        ),
        value: V2_NAMESPACES.enforceBaseline.labelValue,
      },
      { label: V2_OBSERVATIONS.privilegedPodAdmitted, value: true },
      { label: V2_OBSERVATIONS.hostPidPodAdmitted, value: true },
      {
        label: V2_OBSERVATIONS.defaultServiceAccountPrecondition,
        value: true,
      },
      { label: V2_OBSERVATIONS.dryRun, value: 'All' },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V2 indeterminate payload: the precondition was not met.
 *
 * The `default` ServiceAccount was absent, so pod creation failed with a
 * NON-Forbidden error before the PodSecurity plugin ever ran (L367-374). The
 * observed status is therefore neither a 403 nor an admission, and no verdict is
 * reported -- rendering this as a pass would claim enforcement that was never
 * exercised, and rendering it as a fail would blame the wrong component.
 */
export const V2_POD_SECURITY_UNKNOWN = {
  controlId: 'V2',
  verdict: 'unknown',
  summary: 'Pod Security enforcement could not be evaluated.',
  detail:
    'The namespace default ServiceAccount was absent, so the ServiceAccount ' +
    'admission plugin rejected the pod before the PodSecurity plugin ran. The ' +
    'resulting error is not a Forbidden decision, so it proves nothing either ' +
    'way about enforce=baseline.',
  requirementIds: ['F-002-RQ-001'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      {
        label: V2_OBSERVATIONS.defaultServiceAccountPrecondition,
        value: false,
      },
      { label: V2_OBSERVATIONS.privilegedPodStatus, value: null },
      { label: V2_OBSERVATIONS.privilegedPodAdmitted, value: null },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

// ---------------------------------------------------------------------------
// SECTION 3 -- V3, Secrets encryption at rest.
// F-003-RQ-001 / F-003-RQ-002 / F-003-RQ-003.
//
// Recorded from `test/integration/secrets/encryption_test.go`
// (`TestSecretsAreEncryptedAtRest`, L77-153).
//
// THE INVARIANT: the stored Secret is CIPHERTEXT, not plaintext. The verdict this
// control renders is exactly that binary.
//
// THE TWO CONSTANTS COME FROM ONE PLACE. `AESGCM_PREFIX` and `PLAINTEXT_CANARY`
// are imported from `./encryptionConfig` and are deliberately not written out
// again here (AAP §0.5.5). That single-source property is the concrete benefit of
// leaving Go's "test files are not importable across packages" limitation behind
// -- the oracle itself carries a comment at L72 explaining that it had to
// replicate its helper inline for exactly that reason.
//
// THE STRUCTURED ASSERTION CATALOGUE IS NOT DUPLICATED HERE. `./encryptionConfig`
// already records the four encryption assertions as a typed list, and the KMS v2
// details that belong to the deployment manifest -- provider ordering with
// `identity` last, and the absence of `cachesize` -- live there too. This section
// records what the PANEL renders: the four conditions with their severities, as
// the observations of a control payload.
//
// THE KEY IS DERIVED, NEVER HARDCODED (L69-75). The etcd key is
// `/<storagePrefix>/secrets/<namespace>/<name>`, and `storagePrefix` must be read
// from the live shared-etcd configuration because it embeds a per-run UUID and
// looks like `<uuid>/registry`. Hardcoding `registry` addresses a key that does
// not exist, the raw read returns zero entries, and the "exactly one key/value
// pair" assertion then fails for entirely the wrong reason -- reporting a missing
// object while encryption is working perfectly.
// ---------------------------------------------------------------------------

/**
 * The four measured conditions of the V3 oracle, with the severity each carries.
 *
 * INVARIANT LOCKED (F-003-RQ-002) and the reason the severities are recorded: the
 * FIRST condition aborts and the other three accumulate, exactly as the oracle
 * does. Cardinality is checked with `t.Fatalf` at L131 because a wrong key makes
 * every later assertion meaningless -- it would be reading a value that is not
 * there. The remaining three use `t.Errorf` at L136, L141 and L150, so one run
 * reports all of them.
 *
 * MATCHING SEMANTICS ARE PART OF THE RECORD. `bytes.HasPrefix` at L136 is a
 * PREFIX test: not equality, because the bytes after the prefix are the
 * ciphertext body and every legitimate value differs there; and not a substring
 * search, because that would also succeed when the prefix merely occurs somewhere
 * inside an otherwise unencrypted blob -- which is precisely the failure the
 * assertion exists to catch.
 *
 * The prefix and canary assertions are a PAIR. A passing prefix check alone
 * proves only that a prefix was WRITTEN; the absence check is what proves the
 * body was actually encrypted.
 */
export const V3_ENCRYPTION_CONDITIONS = [
  {
    label: 'exactly one etcd key/value pair for the Secret key',
    severity: 'abort',
    matching: 'cardinality',
    sourceReference: 'test/integration/secrets/encryption_test.go L131',
  },
  {
    label: `raw stored value begins with ${AESGCM_PREFIX}`,
    severity: 'accumulate',
    matching: 'prefix',
    sourceReference: 'test/integration/secrets/encryption_test.go L136',
  },
  {
    label: `plaintext canary ${PLAINTEXT_CANARY} absent from the raw blob`,
    severity: 'accumulate',
    matching: 'absence',
    sourceReference: 'test/integration/secrets/encryption_test.go L141',
  },
  {
    label: 'API server read round-trips to the original plaintext',
    severity: 'accumulate',
    matching: 'equality',
    sourceReference: 'test/integration/secrets/encryption_test.go L150',
  },
] as const satisfies readonly {
  readonly label: string;
  readonly severity: AssertionSeverity;
  readonly matching: 'cardinality' | 'prefix' | 'absence' | 'equality';
  readonly sourceReference: string;
}[];

/**
 * An illustrative live storage prefix, recorded in the SHAPE the oracle documents
 * at L71: a per-run UUID followed by `/registry`.
 *
 * The UUID is obviously synthetic and is present only so a panel can render a
 * realistic prefix. It must never be treated as a constant to compare against:
 * the real value changes every run, which is the whole point of reading it from
 * the live configuration.
 */
export const V3_EXAMPLE_STORAGE_PREFIX =
  '00000000-0000-0000-0000-000000000000/registry';

/**
 * The committed deployment manifest's posture, as panel observations.
 *
 * INVARIANT LOCKED (F-003-RQ-001 and F-003-RQ-003, AAP §0.10.2): the encrypted
 * resource list, the provider ORDER with the strong provider first and `identity`
 * last, the KMS envelope timeout, and the ABSENCE of `cachesize`.
 *
 * WHY THE PASSING PAYLOAD NEEDS THESE. The four runtime assertions above prove that
 * a Secret written through THIS TEST'S API server was ciphertext at rest. They say
 * nothing about the document a real deployment loads — and the two most dangerous
 * V3 regressions are invisible to them. Put `identity` first in the provider list
 * and every new write is plaintext while a test server configured with aesgcm still
 * passes all four; add `cachesize` under a KMS v2 provider and the API server
 * refuses to load the configuration at all. A payload claiming F-003-RQ-001 and
 * F-003-RQ-003 from runtime evidence alone was attributing requirements to
 * measurements that could not fail them.
 *
 * DERIVED FROM {@link DEPLOYMENT_ENCRYPTION_CONFIG} rather than written out, so the
 * recorded document and the evidence gated on it cannot diverge. `cachesizeKey` is
 * recorded as `null` — MEASURED ABSENCE, not a missing observation — because "the
 * key is not present" is exactly the assertion, and an omitted observation would
 * read as "nobody looked".
 */
export const V3_DEPLOYMENT_MANIFEST_OBSERVATIONS: readonly ControlObservation[] = [
  {
    label: V3_OBSERVATIONS.encryptedResources,
    value: DEPLOYMENT_ENCRYPTION_CONFIG.resources[0].resources.join(','),
  },
  {
    label: V3_OBSERVATIONS.providerOrder,
    value: DEPLOYMENT_ENCRYPTION_CONFIG.resources[0].providers
      .map((provider) => ('kms' in provider ? `kms:${provider.kms.apiVersion}` : 'identity'))
      .join(','),
  },
  {
    label: V3_OBSERVATIONS.kmsTimeout,
    value: DEPLOYMENT_ENCRYPTION_CONFIG.resources[0].providers[0].kms.timeout,
  },
  {
    label: V3_OBSERVATIONS.kmsEndpoint,
    value: DEPLOYMENT_ENCRYPTION_CONFIG.resources[0].providers[0].kms.endpoint,
  },
  { label: V3_OBSERVATIONS.cachesizeKey, value: null },
];

/**
 * V3 passing payload: the Secret is ciphertext at rest.
 *
 * All four conditions hold. The prefix observation records the imported constant
 * itself rather than a fabricated ciphertext blob, and the canary observation
 * records the constant alongside `false` for "present in the raw blob", so the
 * negative half of the proof is visible on the panel rather than implied.
 */
export const V3_ENCRYPTION_PASSING = {
  controlId: 'V3',
  verdict: 'pass',
  summary: 'Secrets are stored as ciphertext at rest.',
  detail:
    'The raw datastore read returned exactly one entry for the Secret key, its ' +
    'value begins with the aesgcm transformer prefix, the known plaintext ' +
    'canary is absent from the raw blob, and reading the Secret back through ' +
    'the API server round-trips to the original plaintext.',
  requirementIds: ['F-003-RQ-001', 'F-003-RQ-002', 'F-003-RQ-003'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V3_OBSERVATIONS.etcdEntryCount, value: 1 },
      { label: V3_OBSERVATIONS.rawValuePrefix, value: AESGCM_PREFIX },
      { label: V3_OBSERVATIONS.canaryLiteral, value: PLAINTEXT_CANARY },
      { label: V3_OBSERVATIONS.canaryPresentInRawBlob, value: false },
      { label: V3_OBSERVATIONS.plaintextRoundTrip, value: true },
      { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: true },
      { label: V3_OBSERVATIONS.storagePrefixShape, value: V3_EXAMPLE_STORAGE_PREFIX },
      // The committed manifest's posture, WITHOUT which this payload's claim to
      // F-003-RQ-001 and F-003-RQ-003 rests on runtime evidence that cannot fail
      // either of them.
      ...V3_DEPLOYMENT_MANIFEST_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V3 failing payload: the Secret is stored in plaintext.
 *
 * Two findings, because the two accumulate-severity assertions that detect
 * plaintext fail TOGETHER and the oracle reports both: the aesgcm prefix is
 * missing (L136-138) and the canary is present in the raw blob (L141-143). A
 * panel that showed only one of them would understate the evidence for the most
 * serious of the eight controls.
 */
export const V3_ENCRYPTION_FAILING = {
  controlId: 'V3',
  verdict: 'fail',
  summary: 'Secrets are stored in plaintext at rest.',
  detail:
    'The raw datastore value carries no aesgcm transformer prefix and contains ' +
    'the known plaintext canary, so the Secret was written through the ' +
    'identity (plaintext) path rather than encrypted.',
  requirementIds: ['F-003-RQ-002'],
  findings: [
    {
      message:
        `Raw stored value does not begin with ${AESGCM_PREFIX}; the Secret was ` +
        'not written through the encrypting provider.',
      subject: 'secret/encrypted-secret',
      requirementId: 'F-003-RQ-002',
    },
    {
      message:
        `Plaintext canary ${PLAINTEXT_CANARY} was found in the raw datastore ` +
        'blob; the Secret is NOT encrypted at rest.',
      subject: 'secret/encrypted-secret',
      requirementId: 'F-003-RQ-002',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      { label: V3_OBSERVATIONS.etcdEntryCount, value: 1 },
      { label: V3_OBSERVATIONS.rawValuePrefix, value: null },
      { label: V3_OBSERVATIONS.canaryLiteral, value: PLAINTEXT_CANARY },
      { label: V3_OBSERVATIONS.canaryPresentInRawBlob, value: true },
      { label: V3_OBSERVATIONS.plaintextRoundTrip, value: true },
      { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: true },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V3 indeterminate payload: the abort-severity condition failed.
 *
 * The raw read returned a number of entries other than one, which the oracle
 * treats as `t.Fatalf` at L131-133. Nothing downstream can be evaluated, because
 * the prefix and canary assertions would be reading a value that was never found
 * -- so both are recorded as `null` and no verdict is rendered.
 *
 * This is also the shape a hardcoded `registry` storage prefix produces, which is
 * why `storage prefix read from live configuration` is recorded as `false` here:
 * it distinguishes "encryption is broken" from "the read addressed the wrong
 * key", and those must never be confused.
 */
export const V3_ENCRYPTION_UNKNOWN = {
  controlId: 'V3',
  verdict: 'unknown',
  summary: 'Encryption at rest could not be evaluated.',
  detail:
    'The raw datastore read did not return exactly one entry for the Secret ' +
    'key, so there is no stored value to inspect. This is the shape a storage ' +
    'prefix that was hardcoded rather than read from the live configuration ' +
    'produces, and it must not be reported as an encryption failure.',
  requirementIds: ['F-003-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V3_OBSERVATIONS.etcdEntryCount, value: 0 },
      { label: V3_OBSERVATIONS.rawValuePrefix, value: null },
      { label: V3_OBSERVATIONS.canaryPresentInRawBlob, value: null },
      { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: false },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;


// ---------------------------------------------------------------------------
// SECTION 4 -- V4, ServiceAccount-token hygiene. F-004-RQ-001 / F-004-RQ-002.
//
// Recorded from `test/integration/auth/svcaccttoken_test.go`
// (`TestServiceAccountTokenBoundAndAudienced`, L1427-1526).
//
// THE INVARIANT: the issued token is audience-bound, time-bound, and carries the
// unchanged claim shape.
//
// THE +-60 SECOND WINDOW IS ENGINEERED, NOT SLACK. L1492-1493 states the reason
// outright: a regression issuing a long-lived (roughly one-year) projected token
// would STILL satisfy `exp > now`, so testing only that the token expires in the
// future detects nothing. Bounding `exp` against `requestTime + 3600 s` within
// `leeway = 60` (L1501) is what makes the assertion meaningful.
//   * NARROWING the window makes the test flaky -- 60 s is what absorbs API
//     round-trip and CI scheduling jitter (L1499-1500).
//   * WIDENING it makes the test meaningless -- a window of a year admits the
//     very regression it exists to catch.
// It is therefore neither tightened nor loosened here, and
// {@link V4_EXPIRY_LEEWAY_SECONDS} is the single place the value appears.
//
// BOTH TIMESTAMPS ARE CHECKED, NOT ONE. The oracle bounds the JWT `exp` claim
// (L1503-1509) AND `status.expirationTimestamp` (L1511-1514) independently, each
// with its own `t.Errorf`. They are separate wire values from separate code
// paths, so agreement between them is itself evidence.
//
// WHY THE TTL IS NOT CLAMPED OR EXTENDED (L1448-1455). `ServiceAccountMaxExpiration`
// is 2 h, so the requested 3600 s is honoured rather than clamped; and because the
// token is not pod-bound and 3600 differs from `WarnOnlyBoundTokenExpirationSeconds`
// (3607 s), the server-side projected-token extension never applies. The emitted
// values therefore reflect the request directly, which is what makes the window
// deterministic.
//
// DETERMINISM. Every instant below is a fixed literal, or is derived from fixed
// literals by the SAME arithmetic the oracle performs at L1502
// (`requestTime + requestedTTL`). Nothing reads a clock, so the window is
// demonstrable in a spec without freezing time.
// ---------------------------------------------------------------------------

/**
 * The audience the token must be bound to: exactly `['api']`.
 *
 * Recorded from `svcaccttoken_test.go` L1472 (requested) and L1489 (asserted),
 * and matching the server's `--api-audiences` at L1435/L1445.
 *
 * INVARIANT LOCKED (F-004-RQ-001): both the CONTENTS and the CARDINALITY are
 * meaningful. A token additionally bound to a second audience is a different,
 * weaker credential, so this list is never sorted, extended or de-duplicated.
 */
export const V4_AUDIENCES = ['api'] as const satisfies readonly string[];

/** The token issuer configured for the oracle, `svcaccttoken_test.go` L1434. */
export const V4_ISSUER = 'https://foo.bar.example.com';

/** Namespace of the ServiceAccount under test, `svcaccttoken_test.go` L1460. */
export const V4_NAMESPACE = 'myns-v4';

/** Name of the ServiceAccount under test, `svcaccttoken_test.go` L1464. */
export const V4_SERVICE_ACCOUNT_NAME = 'test-svcacct';

/**
 * The reference instant captured immediately BEFORE issuance, in whole seconds
 * since the Unix epoch. The oracle's `requestTime`, `svcaccttoken_test.go` L1478.
 *
 * 1767225600 is 2026-01-01T00:00:00Z, deliberately the same instant as
 * {@link OBSERVED_AT} so the token arithmetic and the dashboard timestamp share
 * one reference clock and cannot drift apart.
 *
 * Captured BEFORE issuance in the oracle for a reason worth preserving: a
 * reference taken afterwards would already include the round-trip, quietly
 * shifting the window by the very jitter the leeway exists to absorb.
 */
export const V4_REQUEST_TIME_SECONDS = 1767225600;

/**
 * The requested token lifetime in seconds: 3600. Recorded from
 * `svcaccttoken_test.go` L1473 (the request) and L1498 (the assertion constant).
 */
export const V4_REQUESTED_TTL_SECONDS = 3600;

/**
 * The symmetric tolerance in seconds: 60, and not 30 and not 120. Recorded from
 * `svcaccttoken_test.go` L1501 (`const leeway = int64(60)`).
 *
 * See the section header for why this value is load-bearing in both directions.
 */
export const V4_EXPIRY_LEEWAY_SECONDS = 60;

/**
 * The expiry a correctly issued token carries: `requestTime + requestedTTL`.
 *
 * DERIVED rather than written out, using exactly the arithmetic the oracle
 * performs at L1502. Deriving it is what guarantees the difference from
 * {@link V4_REQUEST_TIME_SECONDS} is EXACTLY
 * {@link V4_REQUESTED_TTL_SECONDS} -- a hand-written literal could drift from
 * that relationship while still looking plausible, and the whole boundary rests
 * on the relationship rather than on either number alone.
 *
 * Evaluates to 1767229200, i.e. 2026-01-01T01:00:00Z.
 */
export const V4_ASSUMED_EXPIRY_SECONDS =
  V4_REQUEST_TIME_SECONDS + V4_REQUESTED_TTL_SECONDS;

/**
 * The inclusive window both observed expiry values must fall inside, derived with
 * the same comparison the oracle makes at L1507 and L1512.
 *
 * Evaluates to 1767229140 (2026-01-01T00:59:00Z) through 1767229260
 * (2026-01-01T01:01:00Z).
 */
export const V4_EXPIRY_WINDOW = {
  earliestSeconds: V4_ASSUMED_EXPIRY_SECONDS - V4_EXPIRY_LEEWAY_SECONDS,
  latestSeconds: V4_ASSUMED_EXPIRY_SECONDS + V4_EXPIRY_LEEWAY_SECONDS,
} as const;

/**
 * The lifetime a compliant token reports: dead centre of the window.
 *
 * Both members are recorded because the oracle checks both: `expirySeconds` is
 * the JWT `exp` claim as a JSON number of whole Unix seconds (L1503-1509), and
 * `expirationTimestamp` is `status.expirationTimestamp` as an RFC 3339 string
 * (L1511-1514). The string is kept as issued rather than as a `Date`, so no
 * timezone or precision normalisation can creep in between the wire and the
 * panel.
 */
export const V4_OBSERVED_EXPIRY = {
  expirySeconds: V4_ASSUMED_EXPIRY_SECONDS,
  expirationTimestamp: '2026-01-01T01:00:00Z',
  requestTimeSeconds: V4_REQUEST_TIME_SECONDS,
  leewaySeconds: V4_EXPIRY_LEEWAY_SECONDS,
} as const satisfies ControlExpiry;

/**
 * A lifetime one second inside the late edge of the window: `assumedExpiry + 59`.
 *
 * Recorded so a panel's boundary rendering is genuinely exercised rather than
 * only its comfortable centre. This value MUST still read as a pass, because
 * L1507 rejects only `exp > assumedExpiry + leeway`; a panel that flags it has
 * effectively narrowed the window to something tighter than 60 s, which is the
 * flakiness failure mode the section header warns about.
 *
 * Evaluates to 1767229259, i.e. 2026-01-01T01:00:59Z.
 */
export const V4_BOUNDARY_OBSERVED_EXPIRY = {
  expirySeconds: V4_ASSUMED_EXPIRY_SECONDS + V4_EXPIRY_LEEWAY_SECONDS - 1,
  expirationTimestamp: '2026-01-01T01:00:59Z',
  requestTimeSeconds: V4_REQUEST_TIME_SECONDS,
  leewaySeconds: V4_EXPIRY_LEEWAY_SECONDS,
} as const satisfies ControlExpiry;

/**
 * The regression the window exists to catch: a token valid for roughly a year.
 *
 * 1798761600 is 2027-01-01T00:00:00Z, which is 31,532,400 s past
 * {@link V4_ASSUMED_EXPIRY_SECONDS} -- far outside +-60 s, yet comfortably in the
 * future. A check that tested only `exp > now` would pass on this value, which is
 * precisely the point L1492-1493 makes.
 */
export const V4_LONG_LIVED_OBSERVED_EXPIRY = {
  expirySeconds: 1798761600,
  expirationTimestamp: '2027-01-01T00:00:00Z',
  requestTimeSeconds: V4_REQUEST_TIME_SECONDS,
  leewaySeconds: V4_EXPIRY_LEEWAY_SECONDS,
} as const satisfies ControlExpiry;

/**
 * The claim shape that must be unchanged, recorded from `svcaccttoken_test.go`
 * L1520-1525.
 *
 * INVARIANT LOCKED (F-004-RQ-002) -- `pod` and `secret` are BOTH exactly `null`,
 * and that `null` is a measured value rather than a missing one. A non-null value
 * in either position indicates a legacy or object-bound token, which is a
 * different credential with different revocation behaviour, so the two members
 * are typed as `null` literally: recording a string there is a compile error.
 *
 * `subject` is the general form `system:serviceaccount:<namespace>:<name>`, built
 * from the two recorded names rather than written out, so the three can never
 * disagree.
 */
export const V4_CLAIM_SHAPE = {
  subject: `system:serviceaccount:${V4_NAMESPACE}:${V4_SERVICE_ACCOUNT_NAME}`,
  kubernetesIoNamespace: V4_NAMESPACE,
  kubernetesIoServiceAccountName: V4_SERVICE_ACCOUNT_NAME,
  kubernetesIoPod: null,
  kubernetesIoSecret: null,
} as const satisfies {
  readonly subject: string;
  readonly kubernetesIoNamespace: string;
  readonly kubernetesIoServiceAccountName: string;
  readonly kubernetesIoPod: null;
  readonly kubernetesIoSecret: null;
};

/**
 * The V4 evidence bag, using the three members
 * {@link ControlEvidence} provides for exactly this control: the audience list,
 * the requested TTL and the observed expiry, plus the claim-shape observations.
 *
 * Exported separately so `TokenHygienePanel.test.tsx` can reuse it while varying
 * only the expiry, which is the axis its boundary cases move along.
 */
export const V4_TOKEN_EVIDENCE = {
  audiences: V4_AUDIENCES,
  requestedTtlSeconds: V4_REQUESTED_TTL_SECONDS,
  observedExpiry: V4_OBSERVED_EXPIRY,
  observations: [
    // FIRST, because it is the precondition for every entry after it. The oracle
    // aborts on an empty token before it asserts anything -- `token :=
    // treq.Status.Token; if token == "" { t.Fatalf(...) }` at
    // `svcaccttoken_test.go` L1484-L1487 -- so a recorded payload that carries
    // claim values without recording that a token existed is describing claims it
    // could not have read. Recorded here rather than implied by the presence of the
    // other entries, because "implied by" is exactly the inference the panel must
    // not make.
    { label: V4_OBSERVATIONS.tokenIssued, value: true },
    { label: V4_OBSERVATIONS.issuer, value: V4_ISSUER },
    { label: V4_OBSERVATIONS.subject, value: V4_CLAIM_SHAPE.subject },
    {
      label: V4_OBSERVATIONS.kubernetesIoNamespace,
      value: V4_CLAIM_SHAPE.kubernetesIoNamespace,
    },
    {
      label: V4_OBSERVATIONS.kubernetesIoServiceAccountName,
      value: V4_CLAIM_SHAPE.kubernetesIoServiceAccountName,
    },
    { label: V4_OBSERVATIONS.kubernetesIoPod, value: V4_CLAIM_SHAPE.kubernetesIoPod },
    { label: V4_OBSERVATIONS.kubernetesIoSecret, value: V4_CLAIM_SHAPE.kubernetesIoSecret },
    { label: V4_OBSERVATIONS.expiryWindowEarliest, value: V4_EXPIRY_WINDOW.earliestSeconds },
    { label: V4_OBSERVATIONS.expiryWindowLatest, value: V4_EXPIRY_WINDOW.latestSeconds },
  ],
} as const satisfies ControlEvidence;

/**
 * V4 passing payload: the token is audience-bound and time-bound with the
 * unchanged claim shape.
 */
export const V4_TOKEN_PASSING = {
  controlId: 'V4',
  verdict: 'pass',
  summary: 'Projected token is audience-bound and time-bound.',
  detail:
    'The aud claim is exactly ["api"]. Both the JWT exp claim and ' +
    'status.expirationTimestamp fall within 60 s of requestTime + 3600 s, so ' +
    'the token is bounded to the requested lifetime rather than merely being in ' +
    'the future. The kubernetes.io claim shape is unchanged, with the pod and ' +
    'secret sub-claims both null.',
  requirementIds: ['F-004-RQ-001', 'F-004-RQ-002'],
  findings: [],
  warnings: [],
  evidence: V4_TOKEN_EVIDENCE,
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V4 boundary payload: compliant, but sitting one second inside the late edge.
 *
 * Still a `pass`, deliberately. See {@link V4_BOUNDARY_OBSERVED_EXPIRY}.
 */
export const V4_TOKEN_BOUNDARY_PASSING = {
  controlId: 'V4',
  verdict: 'pass',
  summary: 'Projected token is time-bound, one second inside the tolerance.',
  detail:
    'The observed expiry is 59 s later than requestTime + 3600 s, which is ' +
    'inside the 60 s tolerance and therefore compliant. Rendering this as a ' +
    'failure would amount to narrowing a window that is calibrated to absorb ' +
    'API round-trip and scheduling jitter.',
  requirementIds: ['F-004-RQ-001', 'F-004-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    audiences: V4_AUDIENCES,
    requestedTtlSeconds: V4_REQUESTED_TTL_SECONDS,
    observedExpiry: V4_BOUNDARY_OBSERVED_EXPIRY,
    observations: V4_TOKEN_EVIDENCE.observations,
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V4 failing payload: a long-lived token bound to the wrong audiences.
 *
 * Three findings, matching the three independent assertions that fail together on
 * such a token: the audience list (L1489) plus the two expiry bounds (L1507 and
 * L1512), which are separate wire values checked separately.
 */
export const V4_TOKEN_FAILING = {
  controlId: 'V4',
  verdict: 'fail',
  summary: 'Projected token is long-lived and not audience-bound.',
  detail:
    'The token would satisfy a naive "expires in the future" check while being ' +
    'valid for roughly a year, which is exactly the regression the 60 s window ' +
    'exists to catch.',
  requirementIds: ['F-004-RQ-001', 'F-004-RQ-002'],
  findings: [
    {
      message:
        'aud claim is ["api","unbounded.example.com"]; F-004-RQ-001 requires ' +
        'exactly ["api"], so both the contents and the cardinality are wrong.',
      subject: `serviceaccount/${V4_NAMESPACE}/${V4_SERVICE_ACCOUNT_NAME}`,
      requirementId: 'F-004-RQ-001',
    },
    {
      message:
        'JWT exp claim 1798761600 is outside requestTime + 3600 s within 60 s ' +
        '(expected 1767229140 through 1767229260); the token is valid for ' +
        'roughly a year.',
      subject: `serviceaccount/${V4_NAMESPACE}/${V4_SERVICE_ACCOUNT_NAME}`,
      requirementId: 'F-004-RQ-002',
    },
    {
      message:
        'status.expirationTimestamp 2027-01-01T00:00:00Z is outside ' +
        'requestTime + 3600 s within 60 s; checked independently of the exp ' +
        'claim because they are separate wire values.',
      subject: `serviceaccount/${V4_NAMESPACE}/${V4_SERVICE_ACCOUNT_NAME}`,
      requirementId: 'F-004-RQ-002',
    },
  ],
  warnings: [],
  evidence: {
    audiences: ['api', 'unbounded.example.com'],
    requestedTtlSeconds: V4_REQUESTED_TTL_SECONDS,
    observedExpiry: V4_LONG_LIVED_OBSERVED_EXPIRY,
    observations: [
      // A token WAS issued here -- that is what makes this payload a failure rather
      // than an indeterminate one. Its defects are in what the token contains, so
      // the audience and lifetime rows must be evaluated and must fail, not withheld.
      { label: V4_OBSERVATIONS.tokenIssued, value: true },
      { label: V4_OBSERVATIONS.issuer, value: V4_ISSUER },
      // The claim shape is INTACT on this payload, and recording it in full is what
      // makes that precise: all three findings below are about the audience and the
      // lifetime, and none is about identity. Recording only `subject` would have
      // left the two sub-claims reading "could not verify" and made the payload look
      // as though it also failed to establish which account the token names.
      { label: V4_OBSERVATIONS.subject, value: V4_CLAIM_SHAPE.subject },
      {
        label: V4_OBSERVATIONS.kubernetesIoNamespace,
        value: V4_CLAIM_SHAPE.kubernetesIoNamespace,
      },
      {
        label: V4_OBSERVATIONS.kubernetesIoServiceAccountName,
        value: V4_CLAIM_SHAPE.kubernetesIoServiceAccountName,
      },
      { label: V4_OBSERVATIONS.kubernetesIoPod, value: V4_CLAIM_SHAPE.kubernetesIoPod },
      { label: V4_OBSERVATIONS.kubernetesIoSecret, value: V4_CLAIM_SHAPE.kubernetesIoSecret },
      { label: V4_OBSERVATIONS.expiryWindowEarliest, value: V4_EXPIRY_WINDOW.earliestSeconds },
      { label: V4_OBSERVATIONS.expiryWindowLatest, value: V4_EXPIRY_WINDOW.latestSeconds },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V4 indeterminate payload: issuance returned no token to inspect.
 *
 * With no token there are no claims, so every claim observation is `null` and the
 * expiry bag is absent entirely -- distinguishing "no evidence reported" from
 * "evidence reported as empty". The oracle's counterpart is the `t.Fatalf` on an
 * empty token at L1484-1486.
 */
export const V4_TOKEN_UNKNOWN = {
  controlId: 'V4',
  verdict: 'unknown',
  summary: 'Token hygiene could not be evaluated.',
  detail:
    'The TokenRequest returned no token, so there are no claims to inspect and ' +
    'no expiry to bound. Nothing is asserted either way about audience or ' +
    'lifetime.',
  requirementIds: ['F-004-RQ-001', 'F-004-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    requestedTtlSeconds: V4_REQUESTED_TTL_SECONDS,
    observations: [
      { label: V4_OBSERVATIONS.tokenIssued, value: false },
      { label: V4_OBSERVATIONS.subject, value: null },
      { label: V4_OBSERVATIONS.kubernetesIoPod, value: null },
      { label: V4_OBSERVATIONS.kubernetesIoSecret, value: null },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;


// ---------------------------------------------------------------------------
// SECTION 5 -- V5, admission-webhook fail-closed posture. F-005-RQ-001.
//
// Transcribed from
// `cluster/gce/addons/cloud-pvl-admission/mutating-webhook-configuration.yaml`,
// all 25 lines.
//
// THE INVARIANT: `failurePolicy: Fail`. A webhook that cannot be reached must
// BLOCK the request, not wave it through. `Ignore` is the fail-open weakness this
// control closed, and it is recorded below only as the failing variant.
//
// THAT FILE IS FROZEN (AAP §0.8.2 lists it as out of scope for modification).
// This section RECORDS it. It does not edit it, does not restructure it, and does
// not normalise it.
//
// A PRECISION CORRECTION, VERIFIED AGAINST THE FILE. `only-gce` is a
// matchCondition NAME (L20), NOT a rule. `grep -n only-gce` on the manifest
// returns line 20 and nothing else. The two constructs are unrelated and must not
// be conflated: `rules[0]` (L10-15) selects WHICH requests reach the webhook by
// group, version, operation, resource and scope, while `matchConditions[0]`
// (L19-21) is a CEL expression that further narrows those requests to
// PersistentVolumes that actually carry a GCE persistent disk. Recording
// `only-gce` as a rule would misdescribe the webhook's entire selection surface.
// ---------------------------------------------------------------------------

/** One `rules` entry of the recorded webhook, transcribed from L10-15. */
export interface RecordedWebhookRule {
  readonly apiGroups: readonly string[];
  readonly apiVersions: readonly string[];
  readonly operations: readonly string[];
  readonly resources: readonly string[];
  readonly scope: string;
}

/** One `matchConditions` entry of the recorded webhook, transcribed from L19-21. */
export interface RecordedWebhookMatchCondition {
  /** The condition's NAME. `only-gce` is this, and is not a rule. */
  readonly name: string;
  /** The CEL expression evaluated against the incoming object. */
  readonly expression: string;
}

/**
 * The recorded posture of a mutating admission webhook.
 *
 * The member types are deliberately stronger than the data needs, so that
 * `tsc --noEmit` PROVES the recorded posture rather than merely permitting it:
 *   * `failurePolicy` admits only the two values admissionregistration defines,
 *     so a typo is a compile error rather than a webhook that silently does
 *     nothing;
 *   * `sideEffects` is pinned to the literal `'None'`, because a webhook
 *     declaring side effects cannot be dry-run safely;
 *   * `rules` and `matchConditions` are single-element TUPLES, matching the
 *     recorded document exactly -- adding a second rule to a recorded value is a
 *     compile error, which is how the frozen shape stays frozen.
 */
export interface RecordedWebhookPosture {
  /** The webhook's own name, L9. */
  readonly name: string;
  /** `Fail` is fail-closed. `Ignore` is the fail-open weakness this control closed. */
  readonly failurePolicy: 'Fail' | 'Ignore';
  /** Seconds the API server waits before applying `failurePolicy`, L24. */
  readonly timeoutSeconds: number;
  /** L23. Pinned as a literal: anything else changes dry-run semantics. */
  readonly sideEffects: 'None';
  /** L22. */
  readonly admissionReviewVersions: readonly string[];
  readonly clientConfig: {
    /** L17. */
    readonly url: string;
    /**
     * L18. The literal placeholder the manifest ships, substituted at deployment
     * time from out-of-band material. It is recorded VERBATIM and is never
     * replaced with a real or realistic-looking base64 certificate.
     */
    readonly caBundle: string;
  };
  readonly rules: readonly [RecordedWebhookRule];
  readonly matchConditions: readonly [RecordedWebhookMatchCondition];
}

/**
 * The single `rules` entry, transcribed from L10-15.
 *
 * `apiGroups: ['']` is the CORE group and is an empty string rather than an empty
 * list -- an empty list would select no group at all.
 */
export const V5_WEBHOOK_RULE = {
  apiGroups: [''],
  apiVersions: ['v1'],
  operations: ['CREATE'],
  resources: ['persistentvolumes'],
  scope: '*',
} as const satisfies RecordedWebhookRule;

/**
 * The single `matchConditions` entry, transcribed from L19-21.
 *
 * This is where `only-gce` lives, and the only place it appears in the manifest.
 */
export const V5_WEBHOOK_MATCH_CONDITION = {
  name: 'only-gce',
  expression: 'has(object.spec.gcePersistentDisk)',
} as const satisfies RecordedWebhookMatchCondition;

/**
 * The committed, fail-closed webhook posture.
 *
 * INVARIANT LOCKED (F-005-RQ-001): `failurePolicy: 'Fail'`, `timeoutSeconds: 5`,
 * `sideEffects: 'None'`, `admissionReviewVersions: ['v1']`.
 *
 * The `caBundle` is the manifest's own literal placeholder. It contains no key
 * material, no certificate and no credential of any kind, and substituting
 * something that merely LOOKS like a certificate would put a plausible-seeming
 * secret into a fixture for no benefit.
 */
export const FAIL_CLOSED_WEBHOOK = {
  name: 'cloud-pvl-admission.k8s.io',
  failurePolicy: 'Fail',
  timeoutSeconds: 5,
  sideEffects: 'None',
  admissionReviewVersions: ['v1'],
  clientConfig: {
    url: 'https://127.0.0.1:9001/admit',
    caBundle: '__CLOUD_PVL_ADMISSION_CA_CERT__',
  },
  rules: [V5_WEBHOOK_RULE],
  matchConditions: [V5_WEBHOOK_MATCH_CONDITION],
} as const satisfies RecordedWebhookPosture;

/**
 * The fail-OPEN variant: identical in every respect except `failurePolicy`.
 *
 * Recorded so the panel's fail-closed-versus-fail-open verdict is genuinely
 * exercised. `Ignore` means that when the webhook is unreachable the API server
 * admits the request ANYWAY -- the admission control silently stops applying
 * while every other field still reads as correctly configured. That is exactly
 * the weakness this control closed, and it is the reason the difference is a
 * one-word diff rather than an obvious misconfiguration.
 */
export const FAIL_OPEN_WEBHOOK = {
  ...FAIL_CLOSED_WEBHOOK,
  failurePolicy: 'Ignore',
} as const satisfies RecordedWebhookPosture;

/**
 * Builds the observation list a webhook-posture panel renders.
 *
 * A pure function of its argument: same input, same output, no clock, no
 * randomness, no IO. It exists so the passing and failing payloads below cannot
 * drift apart in which fields they surface -- the only difference between them
 * should be the recorded posture itself.
 *
 * THE WIRE TYPE OF A LIST-VALUED FIELD IS PART OF THE RECORD.
 * `ControlObservation.value` carries a scalar, so a list has to be encoded as a
 * string -- and the encoding chosen is the manifest's OWN punctuation, produced by
 * `JSON.stringify`, so `admissionReviewVersions` is recorded as the four
 * characters `["v1"]` exactly as L22 commits it and `rules[0].apiGroups` as
 * `[""]` exactly as L11 commits it.
 *
 * A comma-join was the obvious alternative and is deliberately NOT used: joining
 * `['v1']` yields the bare text `v1`, which is indistinguishable from a SCALAR
 * `admissionReviewVersions: "v1"` -- a malformed manifest the admission API would
 * reject. Recording the punctuation is what lets a panel tell the two apart, and
 * `WebhookPosturePanel` parses this value as a JSON array of strings for exactly
 * that reason.
 *
 * @param posture - the recorded webhook posture to describe.
 * @returns One observation per asserted field, in the manifest's own order.
 */
export function webhookPostureObservations(
  posture: RecordedWebhookPosture,
): readonly ControlObservation[] {
  return [
    { label: V5_OBSERVATIONS.webhookName, value: posture.name },
    { label: V5_OBSERVATIONS.failurePolicy, value: posture.failurePolicy },
    { label: V5_OBSERVATIONS.timeoutSeconds, value: posture.timeoutSeconds },
    { label: V5_OBSERVATIONS.sideEffects, value: posture.sideEffects },
    {
      label: V5_OBSERVATIONS.admissionReviewVersions,
      value: JSON.stringify(posture.admissionReviewVersions),
    },
    { label: V5_OBSERVATIONS.clientConfigUrl, value: posture.clientConfig.url },
    { label: V5_OBSERVATIONS.clientConfigCaBundle, value: posture.clientConfig.caBundle },
    { label: V5_OBSERVATIONS.ruleApiGroups, value: JSON.stringify(posture.rules[0].apiGroups) },
    {
      label: V5_OBSERVATIONS.ruleApiVersions,
      value: JSON.stringify(posture.rules[0].apiVersions),
    },
    {
      label: V5_OBSERVATIONS.ruleOperations,
      value: JSON.stringify(posture.rules[0].operations),
    },
    {
      label: V5_OBSERVATIONS.ruleResources,
      value: JSON.stringify(posture.rules[0].resources),
    },
    { label: V5_OBSERVATIONS.ruleScope, value: posture.rules[0].scope },
    { label: V5_OBSERVATIONS.matchConditionName, value: posture.matchConditions[0].name },
    {
      label: V5_OBSERVATIONS.matchConditionExpression,
      value: posture.matchConditions[0].expression,
    },
  ];
}

/** V5 passing payload: the webhook fails closed. */
export const V5_WEBHOOK_PASSING = {
  controlId: 'V5',
  verdict: 'pass',
  summary: 'Admission webhook fails closed.',
  detail:
    'failurePolicy is Fail, so a request is blocked when the webhook cannot be ' +
    'reached within its 5 s timeout. sideEffects is None and only ' +
    'admissionReview v1 is accepted.',
  requirementIds: ['F-005-RQ-001'],
  findings: [],
  warnings: [],
  evidence: { observations: webhookPostureObservations(FAIL_CLOSED_WEBHOOK) },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/** V5 failing payload: the webhook fails open. */
export const V5_WEBHOOK_FAILING = {
  controlId: 'V5',
  verdict: 'fail',
  summary: 'Admission webhook fails open.',
  detail:
    'failurePolicy is Ignore, so an unreachable webhook causes the request to ' +
    'be admitted rather than blocked. Every other field still reads as ' +
    'correctly configured, which is what makes this weakness easy to miss.',
  requirementIds: ['F-005-RQ-001'],
  findings: [
    {
      message:
        'Webhook "cloud-pvl-admission.k8s.io" declares failurePolicy: Ignore; ' +
        'F-005-RQ-001 requires Fail so that an unreachable webhook blocks the ' +
        'request instead of admitting it.',
      subject: 'mutatingwebhookconfiguration/cloud-pvl-admission.k8s.io',
      requirementId: 'F-005-RQ-001',
    },
  ],
  warnings: [],
  evidence: { observations: webhookPostureObservations(FAIL_OPEN_WEBHOOK) },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V5 indeterminate payload: the configuration was not readable.
 *
 * No MutatingWebhookConfiguration was returned, so `failurePolicy` is unknown --
 * and an unknown failure policy must NEVER be optimistically reported as `Fail`.
 * Absent evidence is `unknown`, never `pass`.
 */
export const V5_WEBHOOK_UNKNOWN = {
  controlId: 'V5',
  verdict: 'unknown',
  summary: 'Webhook posture could not be evaluated.',
  detail:
    'The MutatingWebhookConfiguration was not readable, so the effective ' +
    'failurePolicy is unknown. An unknown failure policy is reported as ' +
    'indeterminate and never assumed to be fail-closed.',
  requirementIds: ['F-005-RQ-001'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V5_OBSERVATIONS.webhookName, value: FAIL_CLOSED_WEBHOOK.name },
      { label: V5_OBSERVATIONS.configurationReadable, value: false },
      { label: V5_OBSERVATIONS.failurePolicy, value: null },
      { label: V5_OBSERVATIONS.timeoutSeconds, value: null },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

// ---------------------------------------------------------------------------
// SECTION 6 -- V6, sensitive-resource audit fidelity.
// F-006-RQ-001 / F-006-RQ-002 / F-006-RQ-003.
//
// Recorded from `test/integration/controlplane/audit/audit_test.go` L59-120 (the
// audit policy pattern) and L1043-1047 (the confidentiality guard). The level
// aliases are recorded from `cluster/gce/gci/audit_policy_test.go` L120-125.
//
// THE INVARIANT: each sensitive resource is audited at EXACTLY its recorded
// level -- neither lower, which loses forensic detail, nor higher, which for
// `secrets` would log the payload.
//
// THE RECORDED EVENTS THEMSELVES ARE NOT DUPLICATED HERE. They live in the
// sibling `auditEvents.ts`, which is not imported (AAP §0.5.5: one definition
// site per datum, and the only cross-fixture import this folder permits is the
// two V3 constants). This section records the LEVEL TABLE and the guard.
// ---------------------------------------------------------------------------

/**
 * The four audit levels, in ascending order of detail.
 *
 * Recorded in `domain/securityConstants`, from `cluster/gce/gci/audit_policy_test.go`
 * L120-125, whose aliases are `none`, `metadata`, `request` and `response` for
 * `audit.LevelNone`, `LevelMetadata`, `LevelRequest` and `LevelRequestResponse`.
 * The wire names are used because that is what an audit policy and an audit event
 * carry.
 */
export type { AuditLevel };

/**
 * The level vocabulary, its ORDER, its ranks and its comparison, all re-exported
 * from `domain/securityConstants` rather than redeclared here.
 *
 * This fixture used to carry its own `AuditLevel` union, its own ordered tuple and
 * its own rank table. They agreed with the parser's copy, and that was the
 * problem: agreement by inspection is not agreement by construction. A recorded
 * fixture whose level vocabulary can drift from the parser's is a fixture that can
 * record a level the parser would refuse, or claim an order the panels do not use,
 * and nothing in the gate would notice. Importing the one definition makes any
 * such drift impossible rather than merely unlikely — there is no second copy left
 * to drift from.
 *
 * The names stay exported here because this fixture is a published surface for the
 * specs, and moving a definition must not move a consumer's import path.
 */
export { AUDIT_LEVEL_ORDER, AUDIT_LEVEL_RANK, compareAuditLevels };

/** One rule of the recorded audit policy. */
export interface AuditLevelRule {
  /** The level this rule projects events at. */
  readonly level: AuditLevel;
  /** The namespace the rule is scoped to. */
  readonly namespace: string;
  /** The API group. The empty string is the CORE group. */
  readonly apiGroup: string;
  /** The resources, including subresources written as `resource/subresource`. */
  readonly resources: readonly string[];
}

/**
 * The ten recorded policy rules, in the order the policy declares them.
 *
 * Order is preserved because audit policy evaluation is FIRST-MATCH: the earliest
 * matching rule wins, so reordering these would change which level applies. That
 * is why they are recorded as a sequence rather than as a map keyed by resource.
 *
 * INVARIANT LOCKED (F-006-RQ-002): `secrets` sits at exactly `Request` (L109-113)
 * and `roles`/`rolebindings` at exactly `RequestResponse` (L114-118). The
 * asymmetry is deliberate and is explained at L103-108: `Request` records the
 * request object but OMITS the response object, so Secret read responses are never
 * logged, while RBAC objects carry no secret material and can therefore afford
 * full forensic detail.
 */
export const SENSITIVE_RESOURCE_AUDIT_RULES = [
  {
    level: 'RequestResponse',
    namespace: 'no-webhook-namespace',
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'Metadata',
    namespace: 'webhook-audit-metadata',
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'Request',
    namespace: 'webhook-audit-request',
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'RequestResponse',
    namespace: 'webhook-audit-response',
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'Request',
    namespace: 'create-audit-request',
    apiGroup: '',
    resources: ['serviceaccounts/token'],
  },
  {
    level: 'RequestResponse',
    namespace: 'create-audit-response',
    apiGroup: '',
    resources: ['serviceaccounts/token'],
  },
  {
    level: 'Request',
    namespace: 'update-audit-request',
    apiGroup: 'apps',
    resources: ['deployments/scale'],
  },
  {
    level: 'RequestResponse',
    namespace: 'update-audit-response',
    apiGroup: 'apps',
    resources: ['deployments/scale'],
  },
  {
    level: 'Request',
    namespace: 'secret-audit-request',
    apiGroup: '',
    resources: ['secrets'],
  },
  {
    level: 'RequestResponse',
    namespace: 'rbac-audit-response',
    apiGroup: 'rbac.authorization.k8s.io',
    resources: ['roles', 'rolebindings'],
  },
] as const satisfies readonly AuditLevelRule[];

/**
 * The level `secrets` must be audited at: exactly `Request`.
 *
 * Named separately because it is the single most consequential value in this
 * section, and because {@link V6_CONFIDENTIALITY_GUARD} depends on it: `Request`
 * is what stops the response object being logged, so the level and the guard are
 * two statements of the same invariant.
 */
export const SECRETS_AUDIT_LEVEL = 'Request' as const satisfies AuditLevel;

/**
 * The confidentiality guard, recorded from `audit_test.go` L1043-1047 with its
 * `t.Errorf` at L1045.
 *
 * INVARIANT LOCKED (F-006-RQ-003): NO audit event whose `objectRef.resource` is
 * `secrets` may carry a `responseObject`.
 *
 * `requestObject` remaining present on create and update is the EXPLICITLY
 * ACCEPTED trade-off of `Request` over `RequestResponse`, not a defect -- the
 * policy comment at L103-108 records the reasoning. The guard is therefore about
 * the response object and only the response object.
 *
 * Its scope is deliberately wider than the expected-event table: the oracle scans
 * EVERY observed event, a superset of the events it expected, so a regression to
 * `RequestResponse` is caught even if the expectation table were edited to match
 * it. The `severity` is `accumulate` because every offending event is reported in
 * one run.
 */
export const V6_CONFIDENTIALITY_GUARD = {
  resource: 'secrets',
  responseObjectPermitted: false,
  requestObjectPermitted: true,
  scope: 'every observed audit event, not only the expected ones',
  severity: 'accumulate',
  sourceReference:
    'test/integration/controlplane/audit/audit_test.go L1043-L1047',
} as const satisfies {
  readonly resource: string;
  readonly responseObjectPermitted: false;
  readonly requestObjectPermitted: boolean;
  readonly scope: string;
  readonly severity: AssertionSeverity;
  readonly sourceReference: string;
};

/**
 * The level table as panel observations, one per recorded rule.
 *
 * Derived from {@link SENSITIVE_RESOURCE_AUDIT_RULES} rather than written out, so
 * the table a panel renders and the table a spec asserts against cannot diverge.
 * Pure: a `map` over static data.
 */
export const V6_AUDIT_LEVEL_OBSERVATIONS: readonly ControlObservation[] =
  SENSITIVE_RESOURCE_AUDIT_RULES.map((rule) => ({
    label: v6ResourceLevelObservation(rule.apiGroup, rule.resources, rule.namespace),
    value: rule.level,
  }));

/**
 * How many audit events the oracle EXPECTS to observe: nine.
 *
 * Recorded from `audit_test.go`'s two measured operation sets — three `secrets`
 * events (create, update, delete; L817-L850) and six RBAC events (roles and
 * rolebindings, each created, updated and deleted; L864 and its five siblings).
 *
 * A LITERAL, NOT AN IMPORT, deliberately. The sibling `auditEvents.ts` records the
 * events themselves and this file records the level table and the guard; AAP §0.5.5
 * permits exactly one cross-fixture import in this folder (the two V3 constants),
 * and widening that rule to reach a count would couple the two files in the
 * direction the rule exists to prevent. The arithmetic is stated above so a reader
 * can check it against either source.
 */
export const V6_EXPECTED_EVENT_COUNT = 9;

/**
 * How many audit events the oracle OBSERVES: ten.
 *
 * One more than it expects, and the extra one is load-bearing. `secretOperations`
 * performs a Secret GET at `audit_test.go` L750-L751 that its own comment at
 * L739-L741 records as "intentionally not asserted", so the observed stream is a
 * genuine SUPERSET of the expectation table. That superset is what gives the
 * confidentiality guard something the expectations cannot hide: L1041-L1043 records
 * that a future regression to `RequestResponse` is caught "even if the
 * expected-events table were changed to match".
 */
export const V6_OBSERVED_EVENT_COUNT = 10;

/**
 * The completeness measurement, as panel observations.
 *
 * WHY COMPLETENESS IS SEPARATE FROM THE OBSERVED COUNT, and why both are recorded.
 * A count of observed events proves that auditing is on; it proves nothing about
 * WHICH events arrived, so ten events that are all the wrong ten satisfy it. The Go
 * oracle does not accept that: `test/utils/audit.go` L86 and L93 poll until every
 * expected event has been seen and otherwise fail with a missing-events report
 * naming each absent one. `expectedEventsObserved` is that report's verdict, and
 * `expectedEventCount` is the denominator that makes the verdict auditable.
 *
 * Both are required for a V6 pass. Without them a panel could report "audited at
 * the required levels" from a policy table alone, having never confirmed that a
 * single one of those rules actually fired.
 */
export const V6_EVENT_COMPLETENESS_OBSERVATIONS: readonly ControlObservation[] = [
  { label: V6_OBSERVATIONS.auditEventsObserved, value: V6_OBSERVED_EVENT_COUNT },
  { label: V6_OBSERVATIONS.expectedEventCount, value: V6_EXPECTED_EVENT_COUNT },
  { label: V6_OBSERVATIONS.expectedEventsObserved, value: true },
];


/**
 * V6 passing payload: every sensitive resource is audited at its recorded level
 * and no Secret event carries a response object.
 */
export const V6_AUDIT_PASSING = {
  controlId: 'V6',
  verdict: 'pass',
  summary: 'Sensitive resources are audited at their required levels.',
  detail:
    'All ten recorded policy rules project at the expected level. Secrets sit ' +
    'at Request, which records the request object and omits the response ' +
    'object, and no observed Secret event carries a response object.',
  requirementIds: ['F-006-RQ-001', 'F-006-RQ-002', 'F-006-RQ-003'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      ...V6_AUDIT_LEVEL_OBSERVATIONS,
      // The completeness pair, WITHOUT which the level table above is a policy
      // document rather than a measurement: it says what the rules are and not
      // that any of them fired.
      ...V6_EVENT_COMPLETENESS_OBSERVATIONS,
      { label: V6_OBSERVATIONS.secretsAuditLevel, value: SECRETS_AUDIT_LEVEL },
      // The required level, carried beside the observed one so a failure reads
      // without external context and so the panel can render expected-versus-
      // observed rather than a bare value.
      { label: V6_OBSERVATIONS.secretsAuditLevelRequired, value: SECRETS_AUDIT_LEVEL },
      { label: V6_OBSERVATIONS.secretsResponseObjectCount, value: 0 },
      // The accepted trade-off, recorded so its presence reads as a decision:
      // `requestObject` surviving on create and update is what `Request` MEANS,
      // and a reader who does not see it recorded may take it for a second defect.
      {
        label: V6_OBSERVATIONS.requestObjectTradeOff,
        value: V6_CONFIDENTIALITY_GUARD.requestObjectPermitted,
      },
      {
        label: V6_OBSERVATIONS.levelOrdering,
        value: AUDIT_LEVEL_ORDER.join(' < '),
      },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V6 failing payload: a downgrade AND a confidentiality breach.
 *
 * Three findings, because the guard reports EVERY offending event rather than the
 * first (L1043-1047 loops and calls `t.Errorf` per event), and a level downgrade
 * is a separate finding from the events it produces. A panel showing only the
 * first would report the downgrade while hiding that Secret payloads had already
 * been written to the audit log.
 */
export const V6_AUDIT_FAILING = {
  controlId: 'V6',
  verdict: 'fail',
  summary: 'Secret audit events carry response objects.',
  detail:
    'The secrets rule has been raised to RequestResponse, so the API server ' +
    'writes the response body of every Secret request into the audit log. ' +
    'Every offending event is listed.',
  requirementIds: ['F-006-RQ-002', 'F-006-RQ-003'],
  findings: [
    {
      message:
        'Audit rule for core/secrets in namespace "secret-audit-request" ' +
        'projects at RequestResponse; F-006-RQ-002 requires exactly Request so ' +
        'that response bodies are never logged.',
      subject: 'auditpolicy/secret-audit-request',
      requirementId: 'F-006-RQ-002',
    },
    {
      message:
        'Audit event for objectRef.resource "secrets" (verb create) carries a ' +
        'responseObject, which duplicates the Secret payload into the audit log.',
      subject: 'audit/secrets/create',
      requirementId: 'F-006-RQ-003',
    },
    {
      message:
        'Audit event for objectRef.resource "secrets" (verb get) carries a ' +
        'responseObject, so Secret reads are now logged with their contents.',
      subject: 'audit/secrets/get',
      requirementId: 'F-006-RQ-003',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      // The completeness pair is present here TOO, and that is the point of this
      // payload: every expected event arrived and was measured, so the failure
      // below is a genuine level regression rather than an incomplete scan. A
      // failing payload that omitted completeness would be indistinguishable from
      // one that simply had not finished looking.
      ...V6_EVENT_COMPLETENESS_OBSERVATIONS,
      { label: V6_OBSERVATIONS.secretsAuditLevel, value: 'RequestResponse' },
      { label: V6_OBSERVATIONS.secretsAuditLevelRequired, value: SECRETS_AUDIT_LEVEL },
      { label: V6_OBSERVATIONS.secretsResponseObjectCount, value: 2 },
      {
        label: V6_OBSERVATIONS.requestObjectTradeOff,
        value: V6_CONFIDENTIALITY_GUARD.requestObjectPermitted,
      },
      {
        label: V6_OBSERVATIONS.levelOrdering,
        value: AUDIT_LEVEL_ORDER.join(' < '),
      },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V6 indeterminate payload: the expected events never appeared.
 *
 * The oracle polls to convergence and aborts with a missing-events report when the
 * expected set is still incomplete (L1030-1032). With no events observed, the
 * guard has nothing to scan -- and "no Secret event carried a response object"
 * because no Secret event was seen AT ALL is emphatically not a pass. That is why
 * the responseObject count is `null` here and `0` in the passing payload: the two
 * are different facts and must render differently.
 */
export const V6_AUDIT_UNKNOWN = {
  controlId: 'V6',
  verdict: 'unknown',
  summary: 'Audit fidelity could not be evaluated.',
  detail:
    'The expected audit events did not appear before the polling deadline, so ' +
    'no levels were observed and the confidentiality guard had nothing to scan. ' +
    'An empty audit log is not evidence that Secret responses are unlogged.',
  requirementIds: ['F-006-RQ-002', 'F-006-RQ-003'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V6_OBSERVATIONS.auditEventsObserved, value: 0 },
      // Completeness reported as FALSE against the same expected count the passing
      // payload carries. This is the distinction the missing-events report exists
      // to make: nine events were expected, none arrived, and "no Secret event
      // carried a response object" is therefore not a finding about Secrets at all.
      { label: V6_OBSERVATIONS.expectedEventCount, value: V6_EXPECTED_EVENT_COUNT },
      { label: V6_OBSERVATIONS.expectedEventsObserved, value: false },
      { label: V6_OBSERVATIONS.secretsAuditLevel, value: null },
      { label: V6_OBSERVATIONS.secretsResponseObjectCount, value: null },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

// ---------------------------------------------------------------------------
// SECTION 7 -- V7, NodeRestriction. F-007-RQ-001 / F-007-RQ-002.
//
// Recorded from `test/integration/auth/node_test.go`
// (`TestNodeRestrictionCrossNodeDenied`, L1585-1687).
//
// THE INVARIANT: a node identity cannot modify another node's Node object nor read
// a Secret unrelated to its own pods, while retaining access to its OWN Node
// object.
//
// A 404 MUST NEVER RENDER AS A PASS. This is the subtlest correctness point in the
// control, and the oracle documents it at L1632-1636: node2 MUST be created before
// the cross-node call, "otherwise the cross-node UpdateStatus returns NotFound
// instead of the deterministic Forbidden result the V7 assertion requires". A
// NotFound means the authorization decision was never reached -- the object simply
// was not there -- so treating it as a denial would report node isolation that was
// never tested. `expectForbidden` (L698) narrows on `apierrors.IsForbidden`
// specifically for this reason, and {@link V7_NODE_RESTRICTION_NOT_FOUND} exists so
// a panel that blurs the distinction fails its own spec.
//
// NO TOKEN VALUES ARE RECORDED. `node_test.go` L1593 labels its token strings
// "Fake values for testing", and even fake credentials have no place in a user
// interface fixture: they train readers to expect credentials in fixtures. Only
// the PRINCIPALS are recorded below.
// ---------------------------------------------------------------------------

/**
 * The principals the oracle authenticates as, recorded from `node_test.go`
 * L1604-1606 -- names and groups only, never the token strings.
 */
export const V7_PRINCIPALS = {
  master: { user: 'admin', group: 'system:masters' },
  node1: { user: 'system:node:node1', group: 'system:nodes' },
  node2: { user: 'system:node:node2', group: 'system:nodes' },
} as const;

/**
 * The enabling posture the denials depend on, recorded from `node_test.go`
 * L1614-1621.
 *
 * Recorded as evidence because the Forbidden results below hold ONLY while
 * NodeRestriction admission is enforcing alongside Node authorization (L1610-1613).
 * A panel that reported the denials without the posture would be asserting an
 * outcome without its precondition.
 */
export const V7_ENABLING_POSTURE = {
  // FROM THE ONE DEFINITION SITE, not re-spelled. `NodeIsolationPanel` gates its pass on
  // these exact values, and a panel cannot import from `src/test/`, so a literal here
  // would be a second copy that typechecks while disagreeing with the gate.
  authorizationMode: NODE_AUTHORIZATION_MODE,
  enabledAdmissionPlugins: [NODE_RESTRICTION_PLUGIN],
  disabledAdmissionPlugins: ['ServiceAccount', 'TaintNodesByCondition'],
} as const satisfies {
  readonly authorizationMode: string;
  readonly enabledAdmissionPlugins: readonly string[];
  readonly disabledAdmissionPlugins: readonly string[];
};

/** One authorization check the V7 oracle performs. */
export interface NodeRestrictionCheck {
  /** Stable, human-readable name of the check. */
  readonly label: string;
  /** The identity performing the operation. */
  readonly principal: string;
  /** What is attempted. */
  readonly operation: string;
  /** Whether the operation must be denied or allowed. */
  readonly expectedOutcome: 'forbidden' | 'allowed';
  /**
   * The HTTP status a denial must carry: 403 and never 404. `null` for an
   * allowance, where the operation succeeds and no error status exists.
   */
  readonly expectedHttpStatus: number | null;
  /**
   * `true` for the two allowances, which exist to prove the denials are targeted.
   *
   * NOTE THE DIFFERENCE FROM V1, because it is measured and not a matter of taste.
   * V1's positive control fails with `t.Fatalf` (`rbac_test.go` L1252-L1254) and its
   * message begins "test setup broken", so a V1 positive-control failure ABORTS and is
   * reported as `unknown` with no findings. V7's four checks all go through
   * `expectForbidden` (`node_test.go` L698) or `expectAllowed` (L712), and BOTH call
   * `t.Errorf`. A V7 positive-control failure is therefore a recorded FAILURE that
   * accumulates -- see {@link NodeRestrictionCheck.severityWhenViolated}.
   */
  readonly isPositiveControl: boolean;
  /**
   * How a failure of this check behaves in the oracle.
   *
   * `'accumulate'` for all four, without exception: `expectForbidden` and
   * `expectAllowed` both report with `t.Errorf`, so ONE run reports EVERY check that
   * failed rather than stopping at the first. Recording it per check is what stops a
   * consumer from assuming the V1 abort semantics apply here as well, and it is why
   * {@link V7_POSITIVE_CONTROLS_FAILING} carries TWO findings from one evaluation.
   */
  readonly severityWhenViolated: AssertionSeverity;
  /** Where the behaviour was measured. */
  readonly sourceReference: string;
}

/**
 * The four checks, in the order the oracle performs them: two denials then two
 * allowances.
 *
 * All four use `t.Errorf` (via `expectForbidden` at L698 and `expectAllowed` at
 * L712), so one run reports every one that fails.
 */
export const V7_NODE_RESTRICTION_CHECKS = [
  {
    label: V7_OUTCOME_TITLES.crossNodeDenied,
    principal: V7_PRINCIPALS.node1.user,
    operation: 'UpdateStatus on Node "node2"',
    expectedOutcome: 'forbidden',
    expectedHttpStatus: FORBIDDEN_STATUS,
    isPositiveControl: false,
    severityWhenViolated: 'accumulate',
    sourceReference: 'test/integration/auth/node_test.go L1653-L1659',
  },
  {
    label: V7_OUTCOME_TITLES.unrelatedSecretDenied,
    principal: V7_PRINCIPALS.node1.user,
    operation: 'get Secret "unrelatedsecret" in namespace "ns"',
    expectedOutcome: 'forbidden',
    expectedHttpStatus: FORBIDDEN_STATUS,
    isPositiveControl: false,
    severityWhenViolated: 'accumulate',
    sourceReference: 'test/integration/auth/node_test.go L1665-L1668',
  },
  {
    label: V7_OUTCOME_TITLES.ownNodeReadAllowed,
    principal: V7_PRINCIPALS.node1.user,
    operation: 'get Node "node1"',
    expectedOutcome: 'allowed',
    expectedHttpStatus: null,
    isPositiveControl: true,
    severityWhenViolated: 'accumulate',
    sourceReference: 'test/integration/auth/node_test.go L1673-L1676',
  },
  {
    label: V7_OUTCOME_TITLES.ownNodeStatusUpdateAllowed,
    principal: V7_PRINCIPALS.node1.user,
    operation: 'UpdateStatus on Node "node1"',
    expectedOutcome: 'allowed',
    expectedHttpStatus: null,
    isPositiveControl: true,
    severityWhenViolated: 'accumulate',
    sourceReference: 'test/integration/auth/node_test.go L1680-L1686',
  },
] as const satisfies readonly NodeRestrictionCheck[];

/**
 * V7 passing payload: both denials are 403 and both positive controls hold.
 */
export const V7_NODE_RESTRICTION_PASSING = {
  controlId: 'V7',
  verdict: 'pass',
  summary: 'A node identity is confined to its own Node objects.',
  detail:
    'node1 was denied 403 Forbidden when updating node2 status and when reading ' +
    'an unrelated Secret, and was allowed to read and update its own Node ' +
    'object. The two allowances are positive controls: without them the denials ' +
    'would also be satisfied by an authorization stack that refuses everything.',
  requirementIds: ['F-007-RQ-001', 'F-007-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V7_OBSERVATIONS.authorizationMode, value: V7_ENABLING_POSTURE.authorizationMode },
      {
        label: V7_OBSERVATIONS.admissionPluginsEnabled,
        value: V7_ENABLING_POSTURE.enabledAdmissionPlugins.join(','),
      },
      {
        label: V7_OBSERVATIONS.crossNodeStatusUpdate,
        value: FORBIDDEN_STATUS,
      },
      {
        label: V7_OBSERVATIONS.unrelatedSecretRead,
        value: FORBIDDEN_STATUS,
      },
      { label: V7_OBSERVATIONS.ownNodeRead, value: 'allowed' },
      {
        label: V7_OBSERVATIONS.ownNodeStatusUpdate,
        value: 'allowed',
      },
      { label: V7_OBSERVATIONS.node2ExistedFirst, value: true },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V7 failing payload: cross-node mutation and unrelated Secret reads succeeded.
 *
 * Two findings, one per breached denial, matching the oracle's two independent
 * `expectForbidden` calls.
 */
export const V7_NODE_RESTRICTION_FAILING = {
  controlId: 'V7',
  verdict: 'fail',
  summary: 'A node identity reached another node objects and an unrelated Secret.',
  detail:
    'Both denials were breached while both positive controls still held, so this ' +
    'is a genuine node-isolation gap rather than a broken authorization stack.',
  requirementIds: ['F-007-RQ-002'],
  findings: [
    {
      message:
        'Identity "system:node:node1" successfully updated the status of Node ' +
        '"node2"; NodeRestriction must deny cross-node mutation with 403 ' +
        'Forbidden.',
      subject: 'node/node2',
      requirementId: 'F-007-RQ-002',
    },
    {
      message:
        'Identity "system:node:node1" successfully read Secret ' +
        '"ns/unrelatedsecret", which is not referenced by any of its pods; the ' +
        'Node authorizer must deny the read with 403 Forbidden.',
      subject: 'secret/ns/unrelatedsecret',
      requirementId: 'F-007-RQ-002',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      { label: V7_OBSERVATIONS.authorizationMode, value: V7_ENABLING_POSTURE.authorizationMode },
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: 'allowed' },
      { label: V7_OBSERVATIONS.unrelatedSecretRead, value: 'allowed' },
      { label: V7_OBSERVATIONS.ownNodeRead, value: 'allowed' },
      { label: V7_OBSERVATIONS.ownNodeStatusUpdate, value: 'allowed' },
      { label: V7_OBSERVATIONS.node2ExistedFirst, value: true },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V7 NotFound payload: the cross-node call returned 404, not 403.
 *
 * INVARIANT LOCKED (F-007-RQ-002) -- THIS IS NOT A PASS, and it is exported
 * specifically so that a panel which treats NotFound as success fails its own
 * spec. The verdict is `fail` rather than `unknown` because the precondition the
 * oracle spells out at L1632-1636 was violated: node2 did not exist when the
 * cross-node call was made, so the request never reached an authorization
 * decision. A 404 is silence, and silence is not a denial.
 *
 * It carries a finding rather than an empty list because the defect is real and
 * actionable -- the check must be re-run with the target object present -- rather
 * than a broken positive control. Contrast {@link V1_RBAC_UNKNOWN}, where the
 * positive control itself failed and no verdict is reported at all.
 */
export const V7_NODE_RESTRICTION_NOT_FOUND = {
  controlId: 'V7',
  verdict: 'fail',
  summary: 'Cross-node denial returned 404 Not Found instead of 403 Forbidden.',
  detail:
    'The target Node did not exist when the cross-node update was attempted, so ' +
    'the API server answered NotFound and no authorization decision was ever ' +
    'reached. This proves nothing about node isolation and must never be ' +
    'rendered as a pass: the check has to be repeated with the target Node ' +
    'present, which is why the oracle creates node2 first.',
  requirementIds: ['F-007-RQ-002'],
  findings: [
    {
      message:
        'Cross-node UpdateStatus on Node "node2" returned 404 Not Found rather ' +
        'than 403 Forbidden; the target object was absent, so node isolation was ' +
        'never exercised. A NotFound result is not a denial.',
      subject: 'node/node2',
      requirementId: 'F-007-RQ-002',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      { label: V7_OBSERVATIONS.authorizationMode, value: V7_ENABLING_POSTURE.authorizationMode },
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: NOT_FOUND_STATUS },
      { label: V7_OBSERVATIONS.denialStatusRequired, value: FORBIDDEN_STATUS },
      { label: V7_OBSERVATIONS.node2ExistedFirst, value: false },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V7 failing payload: BOTH positive controls were refused.
 *
 * INVARIANT LOCKED (F-007-RQ-002) -- THIS IS A FAILURE, NOT AN UNKNOWN, and the
 * distinction is measured rather than chosen. `node_test.go` L1712's `expectAllowed`
 * reports with `t.Errorf`, so a refused positive control is a recorded failure that
 * ACCUMULATES; only V1's positive control uses `t.Fatalf` and therefore aborts. A
 * consumer that carried V1's abort semantics across to V7 would report a refused
 * positive control as "could not evaluate" when the oracle calls it a failure.
 *
 * BOTH failures are in ONE payload, and that is the whole point of the accumulate
 * semantics: `t.Errorf` records and continues, so one evaluation reports every check
 * that failed. A payload carrying only the first would make a panel that renders only
 * `findings[0]` look correct.
 *
 * The two denials are recorded as 403 alongside them, because that is what a stack
 * refusing everything actually returns -- which is precisely why the positive controls
 * exist. Without them, those two 403s read as a clean pass.
 */
export const V7_POSITIVE_CONTROLS_FAILING = {
  controlId: 'V7',
  verdict: 'fail',
  summary: 'A node identity cannot reach even its own Node object.',
  detail:
    'node1 was refused 403 Forbidden when reading its own Node object AND when ' +
    'updating its own Node status, so NodeRestriction is over-broad or the ' +
    'authorization stack is refusing everything. The two denials below also ' +
    'returned 403, which is exactly why they prove nothing on their own. Both ' +
    'failures are reported from one evaluation because the oracle records each ' +
    'with t.Errorf and continues.',
  requirementIds: ['F-007-RQ-002'],
  findings: [
    {
      message:
        'Positive control failed: identity "system:node:node1" was refused 403 ' +
        'Forbidden reading its OWN Node object. NodeRestriction permits a node to ' +
        'read its own Node, so the two denials in this report carry no information.',
      subject: 'node/node1',
      requirementId: 'F-007-RQ-002',
    },
    {
      message:
        'Positive control failed: identity "system:node:node1" was refused 403 ' +
        'Forbidden updating the status of its OWN Node object. NodeRestriction ' +
        'permits a node to act on its own Node, so this denial means the ' +
        'restriction is over-broad.',
      subject: 'node/node1',
      requirementId: 'F-007-RQ-002',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      { label: V7_OBSERVATIONS.authorizationMode, value: V7_ENABLING_POSTURE.authorizationMode },
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: FORBIDDEN_STATUS },
      { label: V7_OBSERVATIONS.unrelatedSecretRead, value: FORBIDDEN_STATUS },
      { label: V7_OBSERVATIONS.ownNodeRead, value: FORBIDDEN_STATUS },
      { label: V7_OBSERVATIONS.ownNodeStatusUpdate, value: FORBIDDEN_STATUS },
      { label: V7_OBSERVATIONS.node2ExistedFirst, value: true },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V7 indeterminate payload: the four checks were never measured.
 *
 * INVARIANT LOCKED (F-007-RQ-002) -- an `unknown` payload is one where the EVIDENCE IS
 * ABSENT, not one where the evidence is bad. The enabling posture was read and the
 * cross-node call was attempted, but no outcome was recorded for any of the four
 * checks: the cross-node result is explicitly `null` and the other three are missing
 * entirely.
 *
 * This is the payload that makes the V7 panel's conservative floor assertable. All
 * four checks unmeasured means the panel MUST render `unknown` -- and it must do so
 * even if the server had claimed `pass`, because assertion density is part of the
 * contract (AAP §0.7.2): V7 keeps its four assertions, and a report carrying none of
 * them has not made them.
 *
 * `findings` is empty because nothing was found; an absence of evidence is not a
 * defect, and reporting one would be as untruthful as reporting a pass. The payload
 * for genuinely refused positive controls is {@link V7_POSITIVE_CONTROLS_FAILING},
 * which carries findings and the verdict `fail`.
 */
export const V7_NODE_RESTRICTION_UNKNOWN = {
  controlId: 'V7',
  verdict: 'unknown',
  summary: 'Node isolation could not be evaluated.',
  detail:
    'None of the four authorization checks produced a recorded outcome: the ' +
    'cross-node update reported no result at all and the unrelated-Secret read ' +
    'and both positive controls were not reported. No verdict about node ' +
    'isolation follows from a report that measured nothing.',
  requirementIds: ['F-007-RQ-001', 'F-007-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V7_OBSERVATIONS.authorizationMode, value: V7_ENABLING_POSTURE.authorizationMode },
      { label: V7_OBSERVATIONS.denialStatusRequired, value: FORBIDDEN_STATUS },
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: null },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;


// ---------------------------------------------------------------------------
// SECTION 8 -- V8, etcd mutual-TLS transport.
// F-008-RQ-001 / F-008-RQ-002 / F-008-RQ-003.
//
// Recorded from `cluster/gce/gci/apiserver_etcd_test.go` (`TestTLSFlags`, L158,
// with its two subtests at L164-183 and L185-188) and from
// `cluster/gce/gci/configure-kubeapiserver.sh` (`configure-etcd-params`, L18-51).
// Profile defaults are recorded from `cluster/gce/config-default.sh` L446 and
// `cluster/gce/config-test.sh` L492.
//
// THE INVARIANT: the API-server-to-etcd transport is mutually authenticated, and a
// deployment that cannot authenticate it FAILS CLOSED rather than silently
// downgrading to plaintext.
//
// ============================ READ THIS FIRST ============================
// TWO PLAINTEXT-RELATED TRUTHS HOLD SIMULTANEOUSLY, AND THEY MUST NEVER BE
// RECONCILED INTO ONE.
//
//   (a) The UNIT-TEST COMPATIBILITY DEFAULT. With an entirely empty environment,
//       `configure-etcd-params` renders `--etcd-servers=http://127.0.0.1:2379`,
//       and `TestTLSFlags` "mTLS disabled" (L185-188) asserts exactly that. This
//       is satisfiable ONLY because of the function-local `":-true"` default at
//       `configure-kubeapiserver.sh` L41. That shim is documented in place at
//       L36-40 as expressly NOT the intended production posture: it exists for
//       direct-invocation contexts that never load the GCE profiles, and the
//       source names `apiserver_etcd_test.go` and `apiserver_kms_test.go` as the
//       reason it is there.
//
//   (b) The FAIL-CLOSED REQUIREMENT. In any profile-driven deployment,
//       `ETCD_APISERVER_ALLOW_INSECURE` is false (both GCE profiles default it so),
//       the shim's default never applies, and missing credentials take the
//       else-branch at L44-46: an ERROR mentioning that it is "refusing to fall
//       back to plaintext etcd", followed by `exit 1`.
//
// Both are true at once. Collapsing them -- "fixing" the unit-test expectation to
// demand `exit 1`, or concluding from it that plaintext is acceptable -- breaks
// parity in one direction or the control in the other. This is the single subtlest
// parity requirement in the migration and the one most likely to be helpfully
// broken, so the two states are recorded as SEPARATE, SEPARATELY LABELLED entries
// distinguished by `isUnitTestCompatibilityDefault`, and they are never merged.
// =========================================================================
//
// THE PARTIAL-CREDENTIAL BRANCH IS THE OTHER SUBTLE ONE (L48-50). It does not
// consult `ETCD_APISERVER_ALLOW_INSECURE` at all: a half-configured deployment
// exits 1 UNCONDITIONALLY. A deployment with some but not all etcd credentials
// must fail, never silently downgrade -- so that state records
// `insecureFallbackPermitted: null`, meaning the flag was not consulted rather
// than that it was false.
//
// PATH STRINGS ONLY. The three TLS flags carry FILE PATHS. The recorded values are
// the oracle's own path placeholders from L169/L175/L176. No certificate, no key
// and no CA bundle content appears anywhere in this section.
// ---------------------------------------------------------------------------

/** What `configure-etcd-params` produced. */
export type EtcdTransportOutcome =
  /** Mutually authenticated TLS to etcd. The only production-acceptable outcome. */
  | 'mutual-tls'
  /** Unauthenticated plaintext to the loopback etcd. */
  | 'plaintext-loopback'
  /** Refused to start rather than downgrade. */
  | 'fail-closed';

/** One recorded outcome of the etcd transport configuration function. */
export interface EtcdTransportState {
  /**
   * Stable label, used as the panel row heading and as the spec's case name. Every
   * label is distinct, which is what keeps the two plaintext states apart.
   */
  readonly label: string;
  /** How many of the six etcd credentials were supplied. */
  readonly credentialsPresent: 'all' | 'partial' | 'none';
  /**
   * The effective value of `ETCD_APISERVER_ALLOW_INSECURE`, or `null` when the
   * branch taken does not consult it -- which is the case for `partial`, where the
   * failure is unconditional. `null` here is a measured fact, not a missing value.
   */
  readonly insecureFallbackPermitted: boolean | null;
  /** What the function produced. */
  readonly outcome: EtcdTransportOutcome;
  /** The etcd flags rendered into the API server command, verbatim. Paths only. */
  readonly renderedFlags: readonly string[];
  /** Process exit status: 0 when configuration completed, 1 when it failed closed. */
  readonly exitCode: 0 | 1;
  /** The diagnostic emitted, when one is. */
  readonly diagnostic: string | null;
  /**
   * `true` ONLY for the unset-environment state that exists to keep the in-tree
   * unit tests passing. This flag is the mechanism that keeps the two plaintext
   * states distinguishable, so a panel can render one as an expected test-harness
   * default and the other as an operator decision.
   */
  readonly isUnitTestCompatibilityDefault: boolean;
  /** Where the behaviour was measured. */
  readonly sourceReference: string;
}

/**
 * The three mutual-TLS flags, recorded from `apiserver_etcd_test.go` L180-182.
 *
 * The values are the oracle's own path placeholders (`CACertPath`,
 * `APIServerCertPath`, `APIServerKeyPath` from L169, L176 and L175). They are FILE
 * PATHS. Certificate and key CONTENTS never appear in this file.
 */
export const V8_MUTUAL_TLS_FLAGS = [
  '--etcd-servers=https://127.0.0.1:2379',
  '--etcd-cafile=CACertPath',
  '--etcd-certfile=APIServerCertPath',
  '--etcd-keyfile=APIServerKeyPath',
] as const satisfies readonly string[];

/** The plaintext loopback flag, recorded from `apiserver_etcd_test.go` L187. */
export const V8_PLAINTEXT_FLAGS = [
  '--etcd-servers=http://127.0.0.1:2379',
] as const satisfies readonly string[];

/**
 * The five recorded states of `configure-etcd-params`.
 *
 * Entries 2 and 3 are the two plaintext-related truths described at length in the
 * section header. They differ ONLY in `isUnitTestCompatibilityDefault` and in
 * whether a warning is emitted, which is exactly why they are recorded separately:
 * merged, the distinction between a test-harness default and a deliberate operator
 * opt-out would disappear.
 */
export const ETCD_TRANSPORT_STATES = [
  {
    label: 'mTLS enabled: all six credentials supplied',
    credentialsPresent: 'all',
    insecureFallbackPermitted: null,
    outcome: 'mutual-tls',
    renderedFlags: V8_MUTUAL_TLS_FLAGS,
    exitCode: 0,
    diagnostic: null,
    isUnitTestCompatibilityDefault: false,
    sourceReference:
      'cluster/gce/gci/apiserver_etcd_test.go L164-L183; ' +
      'cluster/gce/gci/configure-kubeapiserver.sh L21-L25',
  },
  {
    label: 'unit-test compatibility default: empty environment yields plaintext',
    credentialsPresent: 'none',
    insecureFallbackPermitted: true,
    outcome: 'plaintext-loopback',
    renderedFlags: V8_PLAINTEXT_FLAGS,
    exitCode: 0,
    diagnostic: null,
    isUnitTestCompatibilityDefault: true,
    sourceReference:
      'cluster/gce/gci/apiserver_etcd_test.go L185-L188; ' +
      'cluster/gce/gci/configure-kubeapiserver.sh L36-L42',
  },
  {
    label: 'insecure fallback explicitly permitted: plaintext with a warning',
    credentialsPresent: 'none',
    insecureFallbackPermitted: true,
    outcome: 'plaintext-loopback',
    renderedFlags: V8_PLAINTEXT_FLAGS,
    exitCode: 0,
    diagnostic:
      'WARNING: all etcd mTLS credentials are missing, mTLS between etcd server ' +
      'and kube-apiserver is not enabled.',
    isUnitTestCompatibilityDefault: false,
    sourceReference: 'cluster/gce/gci/configure-kubeapiserver.sh L41-L43',
  },
  {
    label: 'fail closed: credentials absent and insecure fallback not permitted',
    credentialsPresent: 'none',
    insecureFallbackPermitted: false,
    outcome: 'fail-closed',
    renderedFlags: [],
    exitCode: 1,
    // The key phrase is kept contiguous in ONE literal rather than split across a
    // concatenation, so that `grep 'refusing to fall back to plaintext etcd'`
    // finds it here exactly as it finds it in the shell source. A phrase broken
    // over two string fragments is correct at run time and invisible to review.
    diagnostic:
      'ERROR: all etcd mTLS credentials are missing and ' +
      'ETCD_APISERVER_ALLOW_INSECURE is not set to true; ' +
      'refusing to fall back to plaintext etcd for a hardened profile.',
    isUnitTestCompatibilityDefault: false,
    sourceReference: 'cluster/gce/gci/configure-kubeapiserver.sh L44-L46',
  },
  {
    label: 'fail closed: credentials only partially supplied',
    credentialsPresent: 'partial',
    insecureFallbackPermitted: null,
    outcome: 'fail-closed',
    renderedFlags: [],
    exitCode: 1,
    diagnostic:
      'ERROR: some of the etcd mTLS credentials are missing, mTLS between etcd ' +
      'server and kube-apiserver cannot be enabled. Please provide all mTLS ' +
      'credential.',
    isUnitTestCompatibilityDefault: false,
    sourceReference: 'cluster/gce/gci/configure-kubeapiserver.sh L48-L50',
  },
] as const satisfies readonly EtcdTransportState[];

/**
 * The insecure-fallback default on both GCE profiles: false on BOTH.
 *
 * INVARIANT LOCKED (F-008-RQ-002). Recorded per profile rather than as a single
 * boolean, because a one-sided edit is the failure mode: leaving the test profile
 * insecure while the default profile stayed hardened would still read as green if
 * only one were checked.
 */
export const ETCD_INSECURE_FALLBACK_PROFILE_DEFAULTS = {
  'cluster/gce/config-default.sh': false,
  'cluster/gce/config-test.sh': false,
} as const satisfies Record<string, boolean>;

/**
 * The profile-default measurement, as panel observations.
 *
 * Derived from {@link ETCD_INSECURE_FALLBACK_PROFILE_DEFAULTS} so the record and the
 * evidence gated on it cannot diverge. Required by every branch that reaches or
 * permits plaintext: the reason an operator-chosen plaintext transport is a WARNING
 * rather than a control failure is that no profile-driven deployment can reach it,
 * and that claim is only true while both profiles default the opt-out to false.
 */
export const V8_PROFILE_DEFAULT_OBSERVATIONS: readonly ControlObservation[] = [
  {
    label: V8_OBSERVATIONS.insecureFallbackDefaultDefaultProfile,
    value: ETCD_INSECURE_FALLBACK_PROFILE_DEFAULTS['cluster/gce/config-default.sh'],
  },
  {
    label: V8_OBSERVATIONS.insecureFallbackDefaultTestProfile,
    value: ETCD_INSECURE_FALLBACK_PROFILE_DEFAULTS['cluster/gce/config-test.sh'],
  },
];

/**
 * The credential FILE PATHS a profile-driven deployment renders into the flags.
 *
 * Recorded from `cluster/gce/gci/configure-helper.sh`, which writes the three
 * artifacts under `auth_dir="/etc/srv/kubernetes/pki"` as
 * `etcd-apiserver-ca.crt`, `etcd-apiserver-client.crt` and
 * `etcd-apiserver-client.key`.
 *
 * WHY THESE AND NOT THE ORACLE'S PLACEHOLDERS. `apiserver_etcd_test.go` L169 and
 * L175-L176 set the three environment variables to the bare words `CACertPath`,
 * `APIServerCertPath` and `APIServerKeyPath`, and {@link V8_MUTUAL_TLS_FLAGS}
 * records the rendered flags containing them VERBATIM, because that is what the
 * shell test measured and parity depends on it. The OBSERVATIONS below are a
 * different thing: they are this tier's evidence that each flag carries a
 * credential path, and a bare word is not a path. Recording real absolute paths is
 * what lets the panel demand a path SHAPE — before that, any non-empty string
 * satisfied `--etcd-cafile is supplied`, so a PEM body or the word `no` earned a
 * pass for the strongest posture V8 has, and was then rendered.
 *
 * PATHS ONLY. No certificate, no key and no CA bundle CONTENT appears anywhere in
 * this file, and the panel renders only a basename or a fixed phrase.
 */
export const V8_CREDENTIAL_PATHS = {
  caFile: '/etc/srv/kubernetes/pki/etcd-apiserver-ca.crt',
  certFile: '/etc/srv/kubernetes/pki/etcd-apiserver-client.crt',
  keyFile: '/etc/srv/kubernetes/pki/etcd-apiserver-client.key',
} as const satisfies Record<string, string>;

/** V8 passing payload: the transport is mutually authenticated. */
export const V8_ETCD_TRANSPORT_PASSING = {
  controlId: 'V8',
  verdict: 'pass',
  summary: 'etcd transport is mutually authenticated.',
  detail:
    'All six etcd credentials are supplied, so the API server addresses etcd over ' +
    'https with a CA file, a client certificate and a client key. Both GCE ' +
    'profiles default the insecure fallback to false, so a deployment missing ' +
    'credentials would fail closed rather than downgrade.',
  requirementIds: ['F-008-RQ-001', 'F-008-RQ-002', 'F-008-RQ-003'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V8_OBSERVATIONS.etcdServers, value: 'https://127.0.0.1:2379' },
      { label: V8_OBSERVATIONS.etcdCaFile, value: V8_CREDENTIAL_PATHS.caFile },
      { label: V8_OBSERVATIONS.etcdCertFile, value: V8_CREDENTIAL_PATHS.certFile },
      { label: V8_OBSERVATIONS.etcdKeyFile, value: V8_CREDENTIAL_PATHS.keyFile },
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'all' },
      { label: V8_OBSERVATIONS.outcome, value: 'mutual-tls' },
      { label: V8_OBSERVATIONS.exitCode, value: 0 },
      // No diagnostic: the mutual-TLS branch emits none, and `null` records that as
      // a MEASURED absence rather than leaving it unobserved.
      { label: V8_OBSERVATIONS.diagnostic, value: null },
      ...V8_PROFILE_DEFAULT_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V8 fail-closed payload: credentials are missing and the deployment refused to
 * start.
 *
 * A `pass` for the CONTROL, deliberately. Refusing to start is the correct,
 * hardened behaviour -- F-008-RQ-003 is satisfied precisely BY the `exit 1`. The
 * summary says so plainly so a reader does not mistake a non-zero exit for a
 * regression, and the payload carries no finding because nothing is wrong.
 */
export const V8_ETCD_TRANSPORT_FAIL_CLOSED = {
  controlId: 'V8',
  verdict: 'pass',
  summary: 'etcd transport failed closed rather than downgrading to plaintext.',
  detail:
    'The etcd credentials were absent and the insecure fallback was not ' +
    'permitted, so configuration refused to fall back to plaintext and exited 1. ' +
    'This is the hardened outcome the control requires: the non-zero exit is the ' +
    'control working, not a defect.',
  requirementIds: ['F-008-RQ-001', 'F-008-RQ-003'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'none' },
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: false },
      { label: V8_OBSERVATIONS.outcome, value: 'fail-closed' },
      { label: V8_OBSERVATIONS.exitCode, value: 1 },
      { label: V8_OBSERVATIONS.etcdServers, value: null },
      // THE DIAGNOSTIC IS EVIDENCE, not decoration. AAP §0.10.2 states this branch
      // as stderr containing "refusing to fall back to plaintext etcd" AND exit 1:
      // the exit code alone cannot distinguish an intentional fail-closed abort from
      // a crash, and the message alone cannot prove the boot stopped.
      {
        label: V8_OBSERVATIONS.diagnostic,
        value: ETCD_TRANSPORT_STATES[3].diagnostic,
      },
      ...V8_PROFILE_DEFAULT_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V8 warning payload: plaintext, permitted explicitly, with a warning.
 *
 * `warn` and not `fail`, because the operator asked for it: this is the documented
 * local and development escape hatch reached only when
 * `ETCD_APISERVER_ALLOW_INSECURE` is explicitly `true`. It is `warn` and not
 * `pass` because the transport genuinely is unauthenticated.
 *
 * This is the OPERATOR-CHOSEN plaintext state. The test-harness plaintext default
 * is {@link ETCD_TRANSPORT_STATES} entry 2 and is a different thing; see the
 * section header.
 */
export const V8_ETCD_TRANSPORT_WARNING = {
  controlId: 'V8',
  verdict: 'warn',
  summary: 'etcd transport is plaintext because the insecure fallback was permitted.',
  detail:
    'ETCD_APISERVER_ALLOW_INSECURE was explicitly set to true, so configuration ' +
    'addressed the loopback etcd over http and emitted a warning instead of ' +
    'exiting. This is the documented local and development escape hatch; neither ' +
    'GCE profile enables it.',
  requirementIds: ['F-008-RQ-001', 'F-008-RQ-002'],
  findings: [],
  warnings: [
    'WARNING: all etcd mTLS credentials are missing, mTLS between etcd server ' +
      'and kube-apiserver is not enabled.',
  ],
  evidence: {
    observations: [
      { label: V8_OBSERVATIONS.etcdServers, value: 'http://127.0.0.1:2379' },
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'none' },
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: true },
      { label: V8_OBSERVATIONS.outcome, value: 'plaintext-loopback' },
      { label: V8_OBSERVATIONS.exitCode, value: 0 },
      { label: V8_OBSERVATIONS.unitTestCompatibilityDefault, value: false },
      // THE WARNING IS WHAT MAKES THIS A DECISION rather than a silent downgrade,
      // and it is the observation that distinguishes this state from the
      // compatibility default, which emits nothing at all.
      {
        label: V8_OBSERVATIONS.diagnostic,
        value: ETCD_TRANSPORT_STATES[2].diagnostic,
      },
      // Required here in particular: "neither GCE profile enables it" is the entire
      // reason this is a warning and not a failure, so the claim needs evidence.
      ...V8_PROFILE_DEFAULT_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V8 unit-test compatibility payload: plaintext from an EMPTY environment.
 *
 * ===========================================================================
 * THE SUBTLEST PAYLOAD IN THIS FILE, and the one most likely to be helpfully
 * "fixed" into a broken state. AAP §0.10.4 names it the single subtlest parity
 * requirement in the migration.
 *
 * `TestTLSFlags` "mTLS disabled" (`apiserver_etcd_test.go` L185-L188) invokes
 * `configure-etcd-params` with an EMPTY environment and expects
 * `--etcd-servers=http://127.0.0.1:2379`. That expectation is satisfiable only
 * because of the function-local `":-true"` default at
 * `configure-kubeapiserver.sh` L41, which the shell's own comment records as a
 * backward-compatibility shim for direct-invocation contexts that never load the
 * GCE profiles — explicitly the in-tree unit tests.
 *
 * Both truths hold at once:
 *   * this state legitimately yields PLAINTEXT and exit 0, and the shell test
 *     that asserts it must stay green;
 *   * a profile-driven deployment missing credentials must FAIL CLOSED with
 *     exit 1, because both profiles set the opt-out to false.
 *
 * Collapsing them breaks parity in one direction or the control in the other. The
 * discriminator is `unit-test compatibility default`, recorded `true` here and
 * `false` on {@link V8_ETCD_TRANSPORT_WARNING}, together with the diagnostic: the
 * operator-chosen state emits a WARNING and this one emits NOTHING.
 * ===========================================================================
 *
 * `warn` and not `fail`, because the transport genuinely is unauthenticated; and not
 * `pass`, for the same reason. What distinguishes it from the operator-chosen state
 * is the explanation, not the verdict.
 */
export const V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT = {
  controlId: 'V8',
  verdict: 'warn',
  summary: 'etcd transport is plaintext under the unit-test compatibility default.',
  detail:
    'The environment supplied no etcd credentials and no explicit insecure ' +
    'fallback setting, so the function-local backward-compatibility default ' +
    'applied and configuration addressed the loopback etcd over http without ' +
    'emitting a warning. This is the direct-invocation path the in-tree shell ' +
    'unit tests take; it is NOT the profile-driven path, and both GCE profiles ' +
    'set the insecure fallback to false so a real deployment fails closed instead.',
  requirementIds: ['F-008-RQ-001', 'F-008-RQ-002'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V8_OBSERVATIONS.etcdServers, value: 'http://127.0.0.1:2379' },
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'none' },
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: true },
      { label: V8_OBSERVATIONS.outcome, value: 'plaintext-loopback' },
      { label: V8_OBSERVATIONS.exitCode, value: 0 },
      { label: V8_OBSERVATIONS.unitTestCompatibilityDefault, value: true },
      // NO diagnostic, recorded as a measured `null`. The shell emits its WARNING
      // only where the opt-out was consulted and found to be `true` explicitly; the
      // shim path prints nothing, and that silence is how the two are told apart.
      { label: V8_OBSERVATIONS.diagnostic, value: null },
      ...V8_PROFILE_DEFAULT_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V8 failing payload: plaintext etcd in a profile-driven deployment.
 *
 * Two findings. The first is the plaintext transport itself; the second is the
 * PARTIAL-credential branch, which is the subtle one -- a half-configured
 * deployment must exit 1 unconditionally (that branch does not consult the
 * fallback flag at all), so observing it continue is a distinct defect from
 * observing plaintext with no credentials whatsoever.
 */
export const V8_ETCD_TRANSPORT_FAILING = {
  controlId: 'V8',
  verdict: 'fail',
  summary: 'etcd transport downgraded to plaintext instead of failing closed.',
  detail:
    'A profile-driven deployment reached plaintext etcd. Both GCE profiles ' +
    'default the insecure fallback to false, so this path should have exited 1.',
  requirementIds: ['F-008-RQ-001', 'F-008-RQ-002', 'F-008-RQ-003'],
  findings: [
    {
      message:
        'API server addresses etcd at http://127.0.0.1:2379 with no CA file, ' +
        'client certificate or client key; the transport is unauthenticated and ' +
        'unencrypted.',
      subject: 'kube-apiserver/--etcd-servers',
      requirementId: 'F-008-RQ-001',
    },
    {
      message:
        'Configuration continued with only some of the six etcd credentials ' +
        'supplied; the partial-credential branch must exit 1 unconditionally, ' +
        'because a half-configured deployment has to fail rather than silently ' +
        'downgrade.',
      subject: 'kube-apiserver/configure-etcd-params',
      requirementId: 'F-008-RQ-003',
    },
  ],
  warnings: [],
  evidence: {
    observations: [
      { label: V8_OBSERVATIONS.etcdServers, value: 'http://127.0.0.1:2379' },
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'partial' },
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: false },
      { label: V8_OBSERVATIONS.outcome, value: 'plaintext-loopback' },
      { label: V8_OBSERVATIONS.exitCode, value: 0 },
      { label: V8_OBSERVATIONS.exitCodeRequiredForPartial, value: 1 },
      // No diagnostic was emitted, recorded as a measured absence. That is itself
      // part of the regression: the partial branch must print its "Please provide
      // all mTLS credential" ERROR and exit 1, and this deployment did neither.
      { label: V8_OBSERVATIONS.diagnostic, value: null },
      ...V8_PROFILE_DEFAULT_OBSERVATIONS,
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;

/**
 * V8 indeterminate payload: the rendered command was not readable.
 *
 * With no pod manifest to inspect there are no etcd flags, so the transport is
 * unknown -- and an unknown transport is never optimistically reported as mutual
 * TLS.
 */
export const V8_ETCD_TRANSPORT_UNKNOWN = {
  controlId: 'V8',
  verdict: 'unknown',
  summary: 'etcd transport could not be evaluated.',
  detail:
    'The rendered API server command was not readable, so no etcd flags were ' +
    'observed. An unknown transport is reported as indeterminate and never ' +
    'assumed to be mutually authenticated.',
  requirementIds: ['F-008-RQ-001'],
  findings: [],
  warnings: [],
  evidence: {
    observations: [
      { label: V8_OBSERVATIONS.renderedCommandReadable, value: false },
      { label: V8_OBSERVATIONS.etcdServers, value: null },
      { label: V8_OBSERVATIONS.credentialsSupplied, value: null },
      { label: V8_OBSERVATIONS.exitCode, value: null },
    ],
  },
  observedAt: OBSERVED_AT,
} as const satisfies ControlStatus;


// ---------------------------------------------------------------------------
// SECTION 9 -- Positive controls, gathered.
//
// Only V1 and V7 have a MEASURED positive control, so the map is keyed over
// exactly those two rather than over all eight. An exhaustive-over-eight map would
// have to invent six, which is precisely what AAP §0.11.1's "evidence over
// assumption" forbids -- and an invented positive control is worse than none,
// because it looks like assurance.
// ---------------------------------------------------------------------------

/**
 * The two measured positive controls.
 *
 * WHAT A BREAK MEANS DIFFERS BETWEEN THE TWO, and the difference is measured. Read V1's
 * entry alongside {@link V1_RBAC_UNKNOWN}: its break is `t.Fatalf`, so the payload
 * carries `unknown` with an EMPTY findings list -- setup breakage, never a security
 * finding. Read V7's two alongside {@link V7_POSITIVE_CONTROLS_FAILING}: theirs is
 * `t.Errorf` via `expectAllowed`, so the payload carries `fail` with one finding per
 * refused control, both from a single evaluation.
 *
 * Neither is {@link V7_NODE_RESTRICTION_UNKNOWN}, which is the different case of the
 * four checks never having been measured at all.
 */
export const CONTROL_POSITIVE_CONTROLS = {
  V1: [
    {
      label: 'system:masters resolves full wildcard authority',
      principal: V1_POSITIVE_CONTROL_SUBJECT.user,
      operation:
        'SubjectAccessReview for all verbs, all API groups and all resources',
      expectation:
        'MUST be allowed. If it is denied, the cluster-admin grant is missing or ' +
        'the authorization stack is not answering, and the denial assertion for ' +
        'the non-privileged identity carries no information.',
      severityWhenBroken: 'abort',
      sourceReference: 'test/integration/auth/rbac_test.go L1241-L1254',
    },
  ],
  V7: [
    {
      label: 'a node reads its own Node object',
      principal: V7_PRINCIPALS.node1.user,
      operation: 'get Node "node1"',
      expectation:
        'MUST be allowed. Without it the cross-node denial is also satisfied by ' +
        'an authorization stack that refuses every request.',
      severityWhenBroken: 'accumulate',
      sourceReference: 'test/integration/auth/node_test.go L1670-L1676',
    },
    {
      label: 'a node updates its own Node status',
      principal: V7_PRINCIPALS.node1.user,
      operation: 'UpdateStatus on Node "node1"',
      expectation:
        'MUST be allowed. NodeRestriction permits a node to act on its own Node ' +
        'object, so a denial here proves the denials above are blanket failures ' +
        'rather than targeted node scoping.',
      severityWhenBroken: 'accumulate',
      sourceReference: 'test/integration/auth/node_test.go L1678-L1686',
    },
  ],
} as const satisfies Record<'V1' | 'V7', readonly PositiveControl[]>;

// ---------------------------------------------------------------------------
// SECTION 10 -- The keyed payload maps.
//
// Each map is `satisfies Record<ControlId, ControlStatus>`, so it is EXHAUSTIVE by
// construction: omitting a control is a compile error (the object type is not
// assignable to the record), and misspelling one is a compile error too (excess
// property checking rejects the unknown key). That is what AAP §0.5.2.5's "keyed by
// control identifier" buys -- a missing panel is caught by `tsc --noEmit` rather
// than by a spec nobody wrote.
// ---------------------------------------------------------------------------

/**
 * One PASSING payload per control: the happy path for every panel and for the
 * aggregate dashboard.
 *
 * Note that V8's entry is {@link V8_ETCD_TRANSPORT_PASSING} (mutual TLS) rather
 * than {@link V8_ETCD_TRANSPORT_FAIL_CLOSED}. Both carry verdict `pass`, because
 * failing closed is also correct behaviour, but the mutual-TLS state is the one a
 * healthy deployment is in.
 */
export const PASSING_CONTROL_STATUSES = {
  V1: V1_RBAC_PASSING,
  V2: V2_POD_SECURITY_PASSING,
  V3: V3_ENCRYPTION_PASSING,
  V4: V4_TOKEN_PASSING,
  V5: V5_WEBHOOK_PASSING,
  V6: V6_AUDIT_PASSING,
  V7: V7_NODE_RESTRICTION_PASSING,
  V8: V8_ETCD_TRANSPORT_PASSING,
} as const satisfies Record<ControlId, ControlStatus>;

/**
 * One FAILING payload per control, each carrying at least one finding.
 *
 * Several carry more than one -- V1 has three, and V2, V3, V4, V6, V7 and V8 have
 * two or three -- because the Go oracle reports every offender in a single run. A
 * panel that renders only `findings[0]` therefore fails its own spec instead of
 * silently under-reporting.
 */
export const FAILING_CONTROL_STATUSES = {
  V1: V1_RBAC_FAILING,
  V2: V2_POD_SECURITY_FAILING,
  V3: V3_ENCRYPTION_FAILING,
  V4: V4_TOKEN_FAILING,
  V5: V5_WEBHOOK_FAILING,
  V6: V6_AUDIT_FAILING,
  V7: V7_NODE_RESTRICTION_FAILING,
  V8: V8_ETCD_TRANSPORT_FAILING,
} as const satisfies Record<ControlId, ControlStatus>;

/**
 * One INDETERMINATE payload per control.
 *
 * Every entry carries verdict `unknown` with an EMPTY findings list, because in
 * each case the evidence needed to reach a verdict was not obtained. None of them
 * is a `pass`: absent evidence is never good evidence.
 */
export const UNKNOWN_CONTROL_STATUSES = {
  V1: V1_RBAC_UNKNOWN,
  V2: V2_POD_SECURITY_UNKNOWN,
  V3: V3_ENCRYPTION_UNKNOWN,
  V4: V4_TOKEN_UNKNOWN,
  V5: V5_WEBHOOK_UNKNOWN,
  V6: V6_AUDIT_UNKNOWN,
  V7: V7_NODE_RESTRICTION_UNKNOWN,
  V8: V8_ETCD_TRANSPORT_UNKNOWN,
} as const satisfies Record<ControlId, ControlStatus>;

/**
 * The controls with a MEASURED `warn` state, keyed over exactly those two.
 *
 * V2's `warn=restricted` namespace admits a restricted-violating pod and warns
 * about it; V8's explicitly permitted insecure fallback uses plaintext and warns.
 * No other control has a measured middle outcome, and the map is keyed `'V2' | 'V8'`
 * rather than made exhaustive precisely so that none is invented for the other six.
 */
export const WARNING_CONTROL_STATUSES = {
  V2: V2_POD_SECURITY_WARNING,
  V8: V8_ETCD_TRANSPORT_WARNING,
} as const satisfies Record<'V2' | 'V8', ControlStatus>;

/**
 * The three variant maps, indexed by variant.
 *
 * `satisfies Record<ControlStatusVariant, Record<ControlId, ControlStatus>>` makes
 * this exhaustive on both axes at once: every variant is present and each maps a
 * complete set of controls.
 */
export const CONTROL_STATUS_FIXTURES = {
  passing: PASSING_CONTROL_STATUSES,
  failing: FAILING_CONTROL_STATUSES,
  unknown: UNKNOWN_CONTROL_STATUSES,
} as const satisfies Record<ControlStatusVariant, Record<ControlId, ControlStatus>>;

// ---------------------------------------------------------------------------
// SECTION 11 -- Aggregates, the empty state, and the error fixtures.
// ---------------------------------------------------------------------------

/**
 * Every passing payload, in the roster order {@link CONTROL_IDS} defines.
 *
 * DERIVED from the roster rather than written out, so the dashboard's render order
 * and the roster can never disagree, and so adding a ninth control to
 * `CONTROL_IDS` would extend this list automatically instead of silently omitting
 * it. The `map` is a pure expression over static data: no clock, no randomness, no
 * IO, and no mutation of anything outside it.
 */
export const ALL_PASSING_CONTROL_STATUSES: readonly ControlStatus[] =
  CONTROL_IDS.map((controlId) => PASSING_CONTROL_STATUSES[controlId]);

/** Every failing payload, in roster order. */
export const ALL_FAILING_CONTROL_STATUSES: readonly ControlStatus[] =
  CONTROL_IDS.map((controlId) => FAILING_CONTROL_STATUSES[controlId]);

/** Every indeterminate payload, in roster order. */
export const ALL_UNKNOWN_CONTROL_STATUSES: readonly ControlStatus[] =
  CONTROL_IDS.map((controlId) => UNKNOWN_CONTROL_STATUSES[controlId]);

/**
 * A mixed aggregate: some controls pass, one warns, one fails, one is unknown.
 *
 * This is the realistic dashboard case and the one most likely to expose a
 * rendering bug, because a panel that hardcodes a single verdict style looks
 * correct against a uniformly green payload and wrong here.
 */
export const MIXED_CONTROL_STATUSES: readonly ControlStatus[] = [
  V1_RBAC_PASSING,
  V2_POD_SECURITY_WARNING,
  V3_ENCRYPTION_FAILING,
  V4_TOKEN_BOUNDARY_PASSING,
  V5_WEBHOOK_PASSING,
  V6_AUDIT_PASSING,
  V7_NODE_RESTRICTION_UNKNOWN,
  V8_ETCD_TRANSPORT_PASSING,
];

/**
 * The explicit EMPTY state: the server reported no controls at all.
 *
 * This is a successful response carrying nothing, which is distinct from an error
 * and distinct from a set of failing controls. The hook surfaces it as
 * `isEmpty: true`, and a panel must render an empty state -- never a pass, and
 * never a silent blank.
 */
export const NO_CONTROL_STATUSES: readonly ControlStatus[] = [];

/**
 * A `403 Forbidden` transport failure.
 *
 * INVARIANT LOCKED -- a 403 renders an ERROR state and NEVER a false pass. This is
 * structural rather than conventional: {@link ControlStatusError} carries no
 * verdict and no `ControlStatus`, and the hook's error arm has no `controls`
 * member, so reaching a verdict from a forbidden request is a `tsc --noEmit` error
 * under `strict`. The fixtures below cannot express a pass even deliberately, which
 * is why there is no "error payload with a verdict" in this file.
 *
 * `reason: 'Forbidden'` is the `reason` field of a Kubernetes `Status` body, the
 * wire-level counterpart of the oracle's `apierrors.IsForbidden` checks.
 */
export const FORBIDDEN_CONTROL_STATUS_ERROR = {
  kind: 'http',
  httpStatus: FORBIDDEN_STATUS,
  reason: 'Forbidden',
  message:
    'controls.posture.k8s.io is forbidden: User cannot list resource "controls" ' +
    'at the cluster scope',
} as const satisfies ControlStatusError;

/**
 * A `500 Internal Server Error` transport failure.
 *
 * Recorded alongside the 403 because the two must render the same way -- as an
 * error, with no verdict -- for opposite reasons: 403 means the caller may not
 * know, 500 means nobody knows. Neither is evidence that a control holds.
 */
export const SERVER_ERROR_CONTROL_STATUS_ERROR = {
  kind: 'http',
  httpStatus: INTERNAL_SERVER_ERROR_STATUS,
  reason: 'InternalError',
  message: 'Internal error occurred: control posture evaluation failed',
} as const satisfies ControlStatusError;

/**
 * A failure in which no response arrived at all.
 *
 * `httpStatus` is deliberately ABSENT rather than zero: no response existed, so no
 * status ever did. A zero would be a fabricated value pretending to be a
 * measurement.
 */
export const NETWORK_CONTROL_STATUS_ERROR = {
  kind: 'network',
  message: 'Failed to reach the control posture endpoint: network request failed',
} as const satisfies ControlStatusError;

/**
 * A 2xx response whose body could not be trusted.
 *
 * The transport succeeded, so `httpStatus` is 200, yet the payload did not describe
 * the controls asked about. This is the third distinct way to have no verdict, and
 * it too must never degrade into a pass.
 */
export const PAYLOAD_CONTROL_STATUS_ERROR = {
  kind: 'payload',
  httpStatus: 200,
  message:
    'The control posture response body did not describe the requested controls',
} as const satisfies ControlStatusError;

/** The four error fixtures, gathered for a spec that iterates them. */
export const CONTROL_STATUS_ERRORS = {
  forbidden: FORBIDDEN_CONTROL_STATUS_ERROR,
  serverError: SERVER_ERROR_CONTROL_STATUS_ERROR,
  network: NETWORK_CONTROL_STATUS_ERROR,
  payload: PAYLOAD_CONTROL_STATUS_ERROR,
} as const satisfies Record<string, ControlStatusError>;

// ---------------------------------------------------------------------------
// SECTION 12 -- Pure selectors.
//
// Functions, not data, so a spec can ask for "V6, failing" without importing eight
// symbols. Each is a pure lookup over the static maps above: same arguments, same
// result, no clock, no randomness, no IO and no mutation.
// ---------------------------------------------------------------------------

/**
 * Picks one recorded payload.
 *
 * @param controlId - which control. Typed as {@link ControlId}, so an unknown
 *   identifier is a compile error rather than an `undefined` at run time.
 * @param variant - which flavour. Defaults to `'passing'`, the happy path.
 * @returns the recorded payload, always defined because both maps are exhaustive.
 */
export function controlStatusFixture(
  controlId: ControlId,
  variant: ControlStatusVariant = 'passing',
): ControlStatus {
  return CONTROL_STATUS_FIXTURES[variant][controlId];
}

/**
 * Builds a whole-dashboard payload of one flavour, in roster order.
 *
 * @param variant - which flavour. Defaults to `'passing'`.
 * @returns one payload per control, ordered by {@link CONTROL_IDS}.
 */
export function controlStatusListFixture(
  variant: ControlStatusVariant = 'passing',
): readonly ControlStatus[] {
  return CONTROL_IDS.map((controlId) => CONTROL_STATUS_FIXTURES[variant][controlId]);
}
