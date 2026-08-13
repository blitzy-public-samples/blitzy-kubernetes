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

// AAP §0.5.1 (the `web/src/components/RbacWildcardPanel.tsx` row — "V1
// behaviour / Pass, fail, unknown, and error states") / §0.4.2.4 (the L6 React
// tier: one panel per control, each covering a happy path, an edge case, an
// error case, loading and empty states, and an interaction case driving
// refresh) / tech-spec §0.6.1 (the specification section the Project Guide's V1
// row maps this control to).
//
// NO PARITY ANCESTOR — this file ports nothing.
// `blitzy/documentation/Project Guide.md` §4 records that this is "a
// control-plane/configuration project with no UI surface", and tech-spec
// §6.6.1.3 records UI automation as not applicable, so there is no UI test to
// port. AAP §0.4.1.1 therefore anchors the React tier on the REST behaviour it
// surfaces. For V1 that behaviour is the SubjectAccessReview evaluation and the
// bootstrap-binding enumeration performed by
// `test/integration/auth/rbac_test.go` L1170-1299
// (`TestRBACNoWildcardOutsideSystemMasters`), corroborated by
// `plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go`. That Go test
// remains the oracle and is never deleted (AAP §0.5.1 — the DELETE set is empty
// by design); this panel is a second, presentation-layer witness to the same
// invariant, not a replacement for it.
//
// ────────────────────────────────────────────────────────────────────────────
// THE INVARIANT THIS PANEL RENDERS (V1, F-001-RQ-001 / F-001-RQ-002)
//
//   The full wildcard `*`/`*`/`*` — every verb, every API group, every
//   resource — exists in exactly ONE ClusterRole, `cluster-admin`, and is bound
//   to exactly ONE subject, the `system:masters` GROUP. An identity outside
//   `system:masters` that requests `*`/`*`/`*` must be DENIED. And EVERY
//   offender is rendered, not just the first.
//
// Verified against the source of truth rather than assumed
// (AAP §0.11.1, "evidence over assumption"): `bootstrappolicy/policy.go`
// declares the `cluster-admin` ClusterRole — commented there as "a 'root' role
// which can do absolutely anything" — with the rule
// `rbacv1helpers.NewRule("*").Groups("*").Resources("*").RuleOrDie()`, and
// `ClusterRoleBindings()` binds `cluster-admin` with
// `.Groups(user.SystemPrivilegedGroup)`, where `SystemPrivilegedGroup` is
// `"system:masters"`
// (`staging/src/k8s.io/apiserver/pkg/authentication/user/user.go:71`).
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THE MARKUP IS SHAPED THE WAY IT IS — assertion semantics, preserved.
//
// AAP §0.11.1 requires the Go oracle's deliberate asymmetry to survive the
// port, and this is the file where it is most visible, because the component has
// to make it RENDERABLE:
//
//   * `t.Errorf` — ACCUMULATE AND CONTINUE. Every security finding in the Go
//     original is reported this way (L1234-1236 the privilege-escalation
//     finding, L1271-1273 the missing `cluster-admin` wildcard rule,
//     L1274-1278 one per offending ClusterRole, L1290-1292 one per offending
//     ClusterRoleBinding, L1293-1297 one per offending subject), so ONE run
//     reports EVERY offender. This panel therefore renders the findings channel
//     as a COMPLETE LIST: no slice, no truncation, no "…and N more", and no
//     stopping at the first. Collapsing that list is precisely the regression
//     the oracle's `t.Errorf` choice exists to prevent, and the paired spec
//     asserts these softly, one `expect.soft` per finding.
//   * `t.Fatalf` — ABORT. The positive control is reported this way
//     (L1252-1254, "test setup broken: system:masters identity was denied full
//     wildcard */*/* (Allowed=false); the cluster-admin→system:masters grant is
//     missing"). A denied `system:masters` is NOT a security finding: it means
//     the check itself is broken and every other conclusion on the panel is
//     meaningless. It is therefore rendered as its own distinct, loud
//     affordance — an `alert`, in wording that says in plain terms that this is
//     a positive control and that its failure does NOT mean the cluster is
//     secure — and never as one more entry in the findings list. The paired
//     spec asserts it with a hard `expect`.
//
// The two are kept in separate channels with separate roles so that the spec can
// hold them to those two different standards, which is only possible if the
// markup distinguishes them in the first place.
//
// WHY THE POSITIVE CONTROL IS LOAD-BEARING (AAP §0.11.1, "never weaken a
// boundary condition"): without it, a panel reporting "no findings" would look
// identical whether the cluster is correctly locked down or the entire
// authorization stack is broken and denying everything. Zero findings is a pass
// ONLY when the positive control is also satisfied; zero findings with an
// unsatisfied positive control is `unknown`. This mirrors the reasoning recorded
// on `ControlVerdict` in `web/src/hooks/useControlStatus.ts`, which cites these
// very lines of the oracle for the same conclusion.
//
// NO EXTERNAL BENCHMARK OR HARDENING-GUIDE IDENTIFIER APPEARS ANYWHERE IN THIS
// FILE (AAP §0.11.1, "cite only what the repository states" — tech-spec §2.5.3
// records that the repository enumerates none). The repository's own
// requirement identifiers `F-001-RQ-001` and `F-001-RQ-002` are used instead.
//
// ────────────────────────────────────────────────────────────────────────────
// PRESENTATION CONSTRAINTS
//
// Plain semantic HTML only: `section`, `h2`, `h3`, `table`, `ul`, `li`,
// `button`. No design system, no CSS framework, no icon library and no
// stylesheet — AAP §0.8.2 excludes all of them, `web/package.json` pins none,
// and `web/vitest.config.ts` sets `css: false`. Presentation is carried
// entirely by the semantics of the elements, which is also what keeps every
// affordance reachable by role and accessible name. There are consequently no
// class names, no inline styles, no animations and no hover states to guard
// with `prefers-reduced-motion` or `@media (hover: hover)`.
//
// Data access is the hook and only the hook: this component never calls `fetch`
// itself, so there is exactly one place in this tier where a request is made and
// exactly one place where a 403 or a 500 is turned into a state. No runtime
// global is referenced at all — not even `globalThis`, which would be the only
// permitted one — because `web/tsconfig.json` deliberately admits no
// `@types/node`, so `process`, `__dirname` and `global` are neither available nor
// wanted.
import type { ReactElement, ReactNode } from 'react';

import {
  type ControlFinding,
  type ControlId,
  type ControlObservation,
  type ControlStatus,
  type ControlStatusError,
  type ControlVerdict,
  type UseControlStatusResult,
  selectControlStatus,
  useControlStatus,
} from '../hooks/useControlStatus';

import {
  REFRESH_UNAVAILABLE_TITLE as SHARED_REFRESH_UNAVAILABLE_TITLE,
  resolveRefreshHandler,
} from './refreshContract';
import {
  type EffectiveVerdict,
  type EvidenceAbsenceReason,
  readBoolean,
  readNumber,
  readString,
  strictestVerdict,
} from '../domain/evidence';
import { V1_OBSERVATIONS } from '../domain/observationIds';
import { safeLabel, safeObservationValue, safeProse } from '../domain/safeText';
// `usePanelLabelId` is deliberately NOT imported here: this panel names its region with a
// literal `aria-label` rather than by pointing at its heading, so the region keeps its
// accessible name whether or not the heading is rendered.
import {
  useLiveRegionRole,
  usePanelSubheading,
  useRendersOwnHeading,
} from './embeddedPanel';

/**
 * The control this panel reports on.
 *
 * Typed as {@link ControlId} rather than left as a bare string so that a typo
 * is a `tsc --noEmit` error, and exported so the dashboard, the request
 * handlers and the paired spec can all address this panel's control through one
 * definition site instead of repeating the literal.
 */
export const RBAC_WILDCARD_CONTROL_ID: ControlId = 'V1';

/**
 * The panel's visible title, and its accessible name.
 *
 * One constant feeds both the `aria-label` of the landmark and the text of the
 * `h2`, so the accessible name can never drift away from the visible heading.
 */
export const RBAC_WILDCARD_PANEL_TITLE = 'RBAC least-privilege (V1)';

/**
 * The requirement identifiers this panel covers, in the order AAP §0.5.1 lists
 * them for the V1 row.
 *
 * - `F-001-RQ-001` — a non-master identity must not resolve `*`/`*`/`*`. This is
 *   the SubjectAccessReview half of the control.
 * - `F-001-RQ-002` — the bootstrap policy declares the full wildcard only in
 *   `cluster-admin` and binds it only to `system:masters`. This is the
 *   enumeration half.
 *
 * Surfacing them makes a failure read as a requirement violation rather than as
 * a value mismatch, which is the "failure legibility" criterion of AAP §0.7.2.
 */
export const RBAC_WILDCARD_REQUIREMENT_IDS = ['F-001-RQ-001', 'F-001-RQ-002'] as const;

/**
 * The only ClusterRole permitted to carry a full `*`/`*`/`*` rule
 * (`bootstrappolicy/policy.go`, the `cluster-admin` entry).
 */
export const CLUSTER_ADMIN_ROLE_NAME = 'cluster-admin';

/**
 * The only subject a full-wildcard role may be bound to, as a GROUP —
 * `user.SystemPrivilegedGroup`
 * (`staging/src/k8s.io/apiserver/pkg/authentication/user/user.go:71`).
 */
export const SYSTEM_PRIVILEGED_GROUP = 'system:masters';

/**
 * The full wildcard triple, exactly as the oracle's `ResourceAttributes` states
 * it (`rbac_test.go` L1225, L1243).
 *
 * Invariant locked: a rule is a full wildcard only when the verb AND the API
 * group AND the resource are all `*`. The oracle's `policyRuleIsFullWildcard`
 * helper (L1158-1168) requires all three, and its comment records why: that
 * deliberately EXCLUDES read-only broad grants such as
 * `system:kube-controller-manager`'s list/watch on `*`/`*`, which are
 * least-privilege and expected. Rendering those as offenders would be a false
 * positive; requiring fewer than three stars would be weakening the boundary.
 */
export const FULL_WILDCARD_REQUEST = {
  /** Every verb. */
  verb: '*',
  /** Every API group. */
  apiGroup: '*',
  /** Every resource. */
  resource: '*',
} as const;

/** The full wildcard rendered the way the oracle's messages spell it. */
export const FULL_WILDCARD_LABEL = '*/*/*';

/**
 * How a failed assertion behaves in the Go oracle.
 *
 * The vocabulary is shared with `web/src/test/fixtures/encryptionConfig.ts` so
 * that one word means one thing across this tier:
 *
 *   'abort'      — `t.Fatalf`: the run stops. A broken precondition, after
 *                  which every later assertion would be reading meaningless
 *                  data.
 *   'accumulate' — `t.Errorf`: recorded, and the run continues, so ONE run
 *                  reports EVERY finding.
 *
 * AAP §0.10.2 requires the asymmetry to port unchanged.
 */
export type RbacAssertionSeverity = 'abort' | 'accumulate';

/**
 * One SubjectAccessReview probe of full wildcard authority.
 *
 * The probe DEFINITION is a constant of this component rather than server data,
 * because it is a measured fact of the oracle: `rbac_test.go` L1223-1229 and
 * L1241-1247 spell out both identities, their group memberships and the
 * requested `ResourceAttributes` literally. The only thing that varies at
 * runtime is the DECISION the server returned for the probe, which arrives as an
 * observation. Keeping the definition here means the panel states what was asked
 * even when nothing came back, which is what lets it distinguish "denied" from
 * "never evaluated".
 */
export interface SubjectAccessReviewProbe {
  /** Stable identifier for consumers to key off; not a Go symbol. */
  readonly id: 'non-master-denied' | 'system-masters-allowed';
  /** `SubjectAccessReviewSpec.User`, verbatim. */
  readonly user: string;
  /** `SubjectAccessReviewSpec.Groups`, verbatim and in oracle order. */
  readonly groups: readonly string[];
  /** The outcome the control requires: `true` for allowed, `false` for denied. */
  readonly expectedAllowed: boolean;
  /** The requirement this probe enforces. */
  readonly requirementId: (typeof RBAC_WILDCARD_REQUIREMENT_IDS)[number];
  /** Line of `test/integration/auth/rbac_test.go` this probe is recorded from. */
  readonly goLine: number;
  /** The Go call used on failure, which is what determines `severity`. */
  readonly goCall: 't.Fatalf' | 't.Errorf';
  /** Behaviour on failure — see {@link RbacAssertionSeverity}. */
  readonly severity: RbacAssertionSeverity;
  /**
   * The EXACT `ControlObservation.label` this probe's decision is reported under,
   * taken from {@link V1_OBSERVATIONS} so the fixture that records it and this panel
   * cannot name it differently.
   *
   * WHY THIS IS NOW A DOMAIN CONSTANT AND WHY THE SECOND CHANNEL IS GONE. This field
   * used to hold a label of the panel's own invention -- "SubjectAccessReview allowed:",
   * the principal and the unrestricted triple -- while the recorded payload carried
   * `denied subject: status.allowed` and `positive control: status.allowed`. The two
   * vocabularies had NO overlap, so neither probe was ever found, the positive control
   * was never confirmed, and the panel rendered UNKNOWN over a payload recording a clean
   * PASS. A second, SUBSTRING channel existed to paper over exactly that mismatch, and
   * it could not: no recorded label contains either principal, because the principals
   * are the observation VALUES. Worse, a substring channel matches whatever happens to
   * contain the token, so an unrelated boolean observation could have supplied a
   * decision. Both sides now import one identity and comparison is `===`.
   */
  readonly observationLabel: string;
  /** What holding means, phrased as the outcome that must be true. */
  readonly description: string;
}

/**
 * The negative assertion: a non-master identity must be DENIED `*`/`*`/`*`.
 *
 * Recorded from `rbac_test.go` L1223-1236. The identity and all three group
 * memberships are the oracle's own, and the finding it raises when the decision
 * comes back allowed is a `t.Errorf` — a security finding that accumulates.
 */
export const NON_MASTER_DENIED_PROBE = {
  id: 'non-master-denied',
  user: 'system:serviceaccount:default:default',
  groups: ['system:authenticated', 'system:serviceaccounts', 'system:serviceaccounts:default'],
  expectedAllowed: false,
  requirementId: 'F-001-RQ-001',
  goLine: 1234,
  goCall: 't.Errorf',
  severity: 'accumulate',
  observationLabel: V1_OBSERVATIONS.deniedSubjectAllowed,
  description:
    'a non-master identity requesting every verb on every resource in every API ' +
    'group is denied; an allowed decision here is a privilege-escalation finding',
} as const satisfies SubjectAccessReviewProbe;

/**
 * The positive control: `system:masters` MUST be ALLOWED `*`/`*`/`*`.
 *
 * Recorded from `rbac_test.go` L1241-1254. Its failure is a `t.Fatalf` and its
 * message begins "test setup broken", because a denied `system:masters` proves
 * the `cluster-admin`→`system:masters` grant is missing — which means the
 * check itself is broken, NOT that the cluster is secure. Without this probe the
 * panel would render a clean bill of health for a cluster whose authorization
 * stack denies everything.
 */
export const SYSTEM_MASTERS_ALLOWED_PROBE = {
  id: 'system-masters-allowed',
  user: 'admin',
  groups: [SYSTEM_PRIVILEGED_GROUP, 'system:authenticated'],
  expectedAllowed: true,
  requirementId: 'F-001-RQ-002',
  goLine: 1252,
  goCall: 't.Fatalf',
  severity: 'abort',
  observationLabel: V1_OBSERVATIONS.positiveControlAllowed,
  description:
    'the system:masters group is allowed every verb on every resource in every ' +
    'API group, proving the review machinery works and the ' +
    'cluster-admin to system:masters grant is intact',
} as const satisfies SubjectAccessReviewProbe;

/**
 * Both probes, in the order the oracle performs them: the negative assertion
 * first (L1230), then the positive control (L1248).
 *
 * ASSERTION DENSITY IS PART OF THE CONTRACT (AAP §0.7.2): there are exactly two
 * probes and the panel renders both rows always. A panel that showed only the
 * negative assertion would pass while the whole authorization stack was broken,
 * and one that showed only the positive control would not be checking anything.
 */
export const SUBJECT_ACCESS_REVIEW_PROBES = [
  NON_MASTER_DENIED_PROBE,
  SYSTEM_MASTERS_ALLOWED_PROBE,
] as const satisfies readonly SubjectAccessReviewProbe[];

/**
 * The only subject KIND a full-wildcard binding may name — `rbacapi.GroupKind`
 * (`rbac_test.go` L1294), corroborated by `policy.go` L681.
 *
 * Both halves of that condition are load-bearing: a binding to a ServiceAccount or
 * to a User *named* `system:masters` is still an offender, because the kind must be
 * `Group`. Kept here as well as in the fixture because a component may not import a
 * fixture, and the two are compared for equality by the paired spec.
 */
export const PERMITTED_WILDCARD_SUBJECT_KIND = 'Group';

/**
 * What a MEASURED mismatch on one evidence check means.
 *
 *   'finding'          — the measurement is a positive observation of a
 *                        least-privilege defect. The oracle reports these with
 *                        `t.Errorf` and continues, so they accumulate and each one
 *                        is a `fail`.
 *   'not-established'  — the measurement shows the check asked a DIFFERENT question
 *                        from the one this control is about, so nothing is proven
 *                        either way. That is `unknown`, never `fail`: claiming a
 *                        defect from a measurement of something else would be as
 *                        untruthful as claiming a pass.
 */
export type RbacEvidenceMismatchMeaning = 'finding' | 'not-established';

/**
 * One measured fact that must hold before V1 can be a pass, beyond the two
 * SubjectAccessReview probes.
 *
 * WHY THIS EXISTS AT ALL. V1 is TWO strategies, not one
 * (`rbac_test.go` L1170-1299): the SubjectAccessReview evaluation *and* the
 * bootstrap-policy enumeration. The panel previously gated its verdict on the two
 * SAR booleans alone, so a payload that recorded the wildcard rule escaping
 * `cluster-admin`, or a binding naming a subject outside `system:masters`, or a
 * SubjectAccessReview evaluated against something NARROWER than
 * {@link FULL_WILDCARD_LABEL}, still rendered a clean pass — on half of the
 * assertions the oracle makes. AAP §0.7.2 makes assertion density part of the
 * contract, and AAP §0.11.1 forbids weakening a boundary condition, so both halves
 * must be ESTABLISHED and both are rendered as first-class checks rather than left
 * as decorative observations.
 *
 * The request identity is included here rather than beside the probes because it is
 * the same kind of fact: something the report either measured or did not. A denial
 * of `get`/`""`/`pods` is a true statement about a different question, and reading
 * it as evidence about `*`/`*`/`*` is how a panel comes to certify authority it
 * never probed.
 */
export interface RbacEvidenceCheck {
  /** Stable identifier for consumers to key off; not a Go symbol. */
  readonly id:
    | 'request-identity'
    | 'wildcard-role-is-cluster-admin'
    | 'no-wildcard-role-outside-cluster-admin'
    | 'no-wildcard-binding-outside-masters';
  /** The row header, which is also how a spec addresses this row. */
  readonly title: string;
  /**
   * The EXACT `ControlObservation.label` this fact is reported under, taken from
   * {@link V1_OBSERVATIONS} so the recording fixture and this panel cannot name it
   * differently. Compared with `===`, never with `includes`.
   */
  readonly observationLabel: string;
  /** The requirement this check enforces. */
  readonly requirementId: (typeof RBAC_WILDCARD_REQUIREMENT_IDS)[number];
  /** Where in `test/integration/auth/rbac_test.go` the fact is recorded from. */
  readonly goLines: string;
  /** See {@link RbacEvidenceMismatchMeaning}. */
  readonly mismatchMeaning: RbacEvidenceMismatchMeaning;
  /** The requirement in words, for the table's "Required" cell. */
  readonly requirement: string;
  /**
   * The value that must be measured, AT ITS WIRE TYPE.
   *
   * The type is part of the requirement, not an implementation detail: a count
   * reported as the string `'0'` has not been counted, and reading it as zero would
   * invent evidence. `readNumber` and `readString` refuse the other's type, so a
   * type mismatch resolves to `unknown` rather than to a match.
   */
  readonly expected:
    | { readonly kind: 'string'; readonly value: string }
    | { readonly kind: 'number'; readonly value: number };
}

/**
 * The four facts, in the order the oracle establishes them.
 *
 * ASSERTION DENSITY IS PART OF THE CONTRACT (AAP §0.7.2): there are exactly four and
 * the panel renders all four rows always, so a report that measured none is visibly a
 * report that measured none.
 */
export const RBAC_EVIDENCE_CHECKS = [
  {
    id: 'request-identity',
    title: `SubjectAccessReview requested authority is ${FULL_WILDCARD_LABEL}`,
    observationLabel: V1_OBSERVATIONS.requestedAttributes,
    requirementId: 'F-001-RQ-001',
    goLines: 'L1225, L1243',
    // A narrower request is a true measurement of a different question.
    mismatchMeaning: 'not-established',
    requirement: `Exactly ${FULL_WILDCARD_LABEL}`,
    expected: { kind: 'string', value: FULL_WILDCARD_LABEL },
  },
  {
    id: 'wildcard-role-is-cluster-admin',
    title: `ClusterRoles carrying a full wildcard rule`,
    observationLabel: V1_OBSERVATIONS.wildcardClusterRoles,
    requirementId: 'F-001-RQ-002',
    goLines: 'L1270-L1278',
    // Both directions are findings the oracle raises with `t.Errorf`: an EXTRA role
    // carrying the wildcard (L1274-1278) and `cluster-admin` no longer carrying it
    // (L1271-1273), the second of which would mean the enumeration is measuring a
    // policy that is not the bootstrapped one.
    mismatchMeaning: 'finding',
    requirement: `Exactly ${CLUSTER_ADMIN_ROLE_NAME}`,
    expected: { kind: 'string', value: CLUSTER_ADMIN_ROLE_NAME },
  },
  {
    id: 'no-wildcard-role-outside-cluster-admin',
    title: `ClusterRoles carrying a full wildcard rule outside ${CLUSTER_ADMIN_ROLE_NAME}`,
    observationLabel: V1_OBSERVATIONS.wildcardClusterRolesOutsideClusterAdmin,
    requirementId: 'F-001-RQ-002',
    goLines: 'L1274-L1278',
    mismatchMeaning: 'finding',
    requirement: 'Exactly 0',
    expected: { kind: 'number', value: 0 },
  },
  {
    id: 'no-wildcard-binding-outside-masters',
    title:
      `Full-wildcard bindings with a subject outside ` +
      `${PERMITTED_WILDCARD_SUBJECT_KIND}/${SYSTEM_PRIVILEGED_GROUP}`,
    observationLabel: V1_OBSERVATIONS.wildcardBindingsOutsideMasters,
    requirementId: 'F-001-RQ-002',
    goLines: 'L1286-L1297',
    mismatchMeaning: 'finding',
    requirement: 'Exactly 0',
    expected: { kind: 'number', value: 0 },
  },
] as const satisfies readonly RbacEvidenceCheck[];

/**
 * What the server reported for one probe.
 *
 * `'unreported'` is a first-class outcome and is deliberately NOT folded into
 * `'denied'`. For the negative assertion those two would coincidentally agree;
 * for the positive control they are opposites — "allowed" satisfies it,
 * "denied" means the check is broken, and "unreported" means nothing is known.
 * Treating silence as a decision is how a panel comes to render a pass it has no
 * evidence for.
 *
 * `'conflicting'` is the fourth outcome, and it exists because a payload can report the
 * SAME decision twice with different answers, or report it at a type that is not a
 * boolean. Both used to be resolved by taking the first match in list order, which makes
 * an authorization verdict a function of serialisation order rather than of evidence.
 * Neither is a decision, so neither may support a pass -- but both are distinct from
 * silence, because a contradictory report is a broken report rather than a missing one,
 * and the two call for different remedies.
 */
export type ProbeDecision = 'allowed' | 'denied' | 'unreported' | 'conflicting';

/**
 * Why no payload for this control is available from an otherwise SUCCESSFUL
 * response.
 *
 * - `'no-controls-reported'` — the response carried no controls at all, which is
 *   the hook's `isEmpty` case.
 * - `'control-absent'` — the response carried controls, but not this one.
 *
 * Both render as `unknown` and neither as a pass. They are kept apart because the
 * remedy differs, and because conflating them would make the empty state
 * unactionable.
 */
export type RbacWildcardEmptyReason = 'no-controls-reported' | 'control-absent';

/** Shared empty list, so an absent evidence bag never allocates. */
const NO_OBSERVATIONS: readonly ControlObservation[] = Object.freeze([]);

/**
 * Reads one probe's decision out of the evidence bag.
 *
 * EXACTLY ONE OBSERVATION, MATCHED EXACTLY, AT THE RIGHT TYPE. `readBoolean` from
 * {@link ../domain/evidence} enforces all three, and each one closes a distinct way this
 * function previously invented a decision:
 *
 *   * the label is compared with `===`, never with `includes`, so an unrelated
 *     observation that merely happened to contain a token can no longer supply an
 *     authorization decision;
 *   * two observations under one label are a CONFLICT rather than "the first one". A
 *     payload that reported `status.allowed` twice with different answers has said two
 *     things, and resolving that by list order makes the verdict depend on serialisation;
 *   * only a boolean counts. `SubjectAccessReview.status.allowed` is a boolean on the
 *     wire, so a string, a number or an explicit `null` is a contract mismatch. Note that
 *     `'false'` is TRUTHY in JavaScript, so a coercing reader would invert the very answer
 *     it was asked for.
 *
 * A conflict and a wrong type both resolve to `'conflicting'`, and absence to
 * `'unreported'`. None of the three is ever `'allowed'`, so none can support a pass.
 *
 * @param probe - the probe whose decision to read.
 * @param observations - the `evidence.observations` list, possibly empty.
 * @returns the decision. See {@link ProbeDecision}.
 */
export function readProbeDecision(
  probe: SubjectAccessReviewProbe,
  observations: readonly ControlObservation[],
): ProbeDecision {
  const decision = readBoolean(observations, probe.observationLabel);
  if (decision.state === 'unreported') {
    return 'unreported';
  }
  if (decision.state !== 'reported') {
    return 'conflicting';
  }
  return decision.value ? 'allowed' : 'denied';
}

/**
 * What the report said about one evidence check.
 *
 * A measured value is carried as text that is ALREADY safe to render
 * (`safeObservationValue`), rather than as the raw wire value. Sanitizing at the
 * boundary means every consumer of this model gets the bounded form, so a second
 * render site cannot reintroduce the unbounded one — which is the whole point of
 * having one sanitizer (AAP §0.11.1: no unbounded external text reaches the
 * document).
 *
 * An absence keeps its REASON rather than being flattened to a string here, so the
 * decision logic stays free of presentation and the row's wording lives with the
 * rest of the rendered text.
 */
export type RbacEvidenceObservedValue =
  | { readonly kind: 'measured'; readonly text: string }
  | { readonly kind: 'absent'; readonly reason: EvidenceAbsenceReason };

/** One evidence check, together with what the report said about it. */
export interface RbacEvidenceMeasurement {
  /** The check that was evaluated. */
  readonly check: RbacEvidenceCheck;
  /**
   * The raw outcome of the comparison: `'pass'` when the required value was measured,
   * `'fail'` when a different value was measured, `'unknown'` when nothing usable was.
   * Never `'warn'` — a boundary condition either holds or it does not.
   */
  readonly verdict: EffectiveVerdict;
  /**
   * What this check contributes to the PANEL's verdict, which is
   * {@link RbacEvidenceMeasurement.verdict} passed through
   * {@link RbacEvidenceCheck.mismatchMeaning}: a mismatch on a `'not-established'`
   * check contributes `'unknown'` rather than `'fail'`, because it is a measurement
   * of a different question and proves nothing about this control.
   */
  readonly contributedVerdict: EffectiveVerdict;
  /** What the report said. See {@link RbacEvidenceObservedValue}. */
  readonly observed: RbacEvidenceObservedValue;
}

/**
 * Evaluates one evidence check against the evidence bag.
 *
 * EXACTLY ONE OBSERVATION, MATCHED EXACTLY, AT THE REQUIRED WIRE TYPE — the same
 * three conditions {@link readProbeDecision} enforces, for the same reasons. A
 * duplicate is a conflict rather than "the first one"; a count reported as the string
 * `'0'` has not been counted, and coercing it would invent the evidence the check
 * exists to demand.
 *
 * @param check - the fact to evaluate.
 * @param observations - the `evidence.observations` list, possibly empty.
 * @returns the measurement. See {@link RbacEvidenceMeasurement}.
 */
export function measureRbacEvidenceCheck(
  check: RbacEvidenceCheck,
  observations: readonly ControlObservation[],
): RbacEvidenceMeasurement {
  const found =
    check.expected.kind === 'string'
      ? readString(observations, check.observationLabel)
      : readNumber(observations, check.observationLabel);
  if (found.state !== 'reported') {
    return {
      check,
      verdict: 'unknown',
      contributedVerdict: 'unknown',
      observed: { kind: 'absent', reason: found.state },
    };
  }
  const holds = found.value === check.expected.value;
  return {
    check,
    verdict: holds ? 'pass' : 'fail',
    contributedVerdict: holds ? 'pass' : check.mismatchMeaning === 'finding' ? 'fail' : 'unknown',
    observed: { kind: 'measured', text: safeObservationValue(found.value) },
  };
}

/**
 * Evaluates all four evidence checks, in {@link RBAC_EVIDENCE_CHECKS} order.
 *
 * The whole list is always returned, including for an empty bag, so the table renders
 * four rows whatever the report contained and "not measured" is visible rather than
 * absent.
 *
 * @param observations - the `evidence.observations` list, possibly empty.
 * @returns one measurement per check.
 */
export function measureRbacEvidence(
  observations: readonly ControlObservation[],
): readonly RbacEvidenceMeasurement[] {
  return RBAC_EVIDENCE_CHECKS.map((check) => measureRbacEvidenceCheck(check, observations));
}

/**
 * Everything the panel needs to render, derived once from a payload.
 *
 * Separated from the markup so that the security-invariant decision logic is
 * directly unit-testable — AAP §0.7.1.3 sets a 100 % line-and-branch floor on
 * exactly this kind of logic, on the grounds that these are the code paths whose
 * failure silently weakens a control.
 */
export interface RbacWildcardAssessment {
  /** The verdict to render. See {@link resolveRbacWildcardVerdict}. */
  readonly verdict: ControlVerdict;
  /** The negative assertion's decision (F-001-RQ-001). */
  readonly nonMasterDecision: ProbeDecision;
  /** The positive control's decision (F-001-RQ-002). */
  readonly systemMastersDecision: ProbeDecision;
  /**
   * `true` when the non-master identity resolved full wildcard authority. This
   * is the privilege escalation the control exists to prevent.
   */
  readonly escalated: boolean;
  /**
   * `true` when the positive control came back DENIED — the check itself is
   * broken and no conclusion about the cluster can be drawn. Distinct from
   * {@link RbacWildcardAssessment.controlUnconfirmed}, which is silence.
   */
  readonly controlBroken: boolean;
  /** `true` when the positive control was not reported at all. */
  readonly controlUnconfirmed: boolean;
  /**
   * `true` when the positive control's decision was reported more than once, or at a
   * type that is not a boolean.
   *
   * Distinct from both {@link RbacWildcardAssessment.controlBroken} (a decision was
   * reported and it was the wrong one) and
   * {@link RbacWildcardAssessment.controlUnconfirmed} (no decision was reported): here a
   * decision was reported and it is unusable. The remedy differs -- fix the report --
   * which is why it is not folded into either of the others.
   */
  readonly controlConflicting: boolean;
  /**
   * The four bootstrap-enumeration and request-identity checks, in
   * {@link RBAC_EVIDENCE_CHECKS} order, always all four.
   */
  readonly evidenceChecks: readonly RbacEvidenceMeasurement[];
  /**
   * The four checks combined through `strictestVerdict`: `'fail'` if any measured a
   * least-privilege defect, `'unknown'` if any was not established, `'pass'` only when
   * all four hold.
   */
  readonly evidenceVerdict: EffectiveVerdict;
  /** Every reported finding, in server order, complete and untruncated. */
  readonly findings: readonly ControlFinding[];
  /** Every server-emitted warning, in server order. */
  readonly warnings: readonly string[];
}

/**
 * Resolves the verdict to render from the reported verdict and the local
 * evidence.
 *
 * Invariant locked: THIS FUNCTION CAN ONLY EVER DEGRADE A VERDICT, NEVER UPGRADE
 * ONE. `'pass'` is returned only when the payload itself said `'pass'` AND there
 * are no findings AND the negative assertion held AND the positive control was
 * observed to be satisfied. Every other combination resolves to `'fail'`,
 * `'warn'` or `'unknown'`. Precedence, highest first:
 *
 *   1. `'fail'` — a finding was reported, or the payload said `'fail'`, or the
 *      non-master identity resolved `*`/`*`/`*`, or an enumeration check MEASURED a
 *      least-privilege defect. A detected escalation outranks
 *      a broken positive control: those two cannot both be true of one cluster
 *      (it cannot allow everything and deny everything at once), and of the two
 *      readings `'fail'` is the one that can never be mistaken for a clean bill
 *      of health. The setup-breakage affordance still renders alongside it.
 *   2. `'unknown'` — the NEGATIVE ASSERTION was not established, i.e. its decision is
 *      anything other than an observed `'denied'`. F-001-RQ-001 is the assertion this
 *      control exists to make, and a report that never made it cannot be a pass however
 *      confidently the server labelled it.
 *   3. `'unknown'` — the positive control is denied, unreported or conflicting. Zero
 *      findings is only meaningful once the check has proved it can say "allowed" at all
 *      (`rbac_test.go` L1252-1254).
 *   4. `'unknown'` — any of the four {@link RBAC_EVIDENCE_CHECKS} was not established:
 *      the SubjectAccessReview asked about something other than
 *      {@link FULL_WILDCARD_LABEL}, or the bootstrap enumeration was not reported.
 *   5. the reported verdict, for `'warn'` and `'pass'`.
 *   6. `'unknown'` — anything else, including a payload that reported
 *      `'unknown'` itself.
 *
 * WHY RULE 2 EXISTS. Both probes must be ESTABLISHED, not merely un-contradicted. The
 * previous shape checked only the positive control, so a payload asserting `pass` with
 * a satisfied positive control and NO negative-assertion evidence at all rendered a
 * clean pass -- on half the assertions the oracle makes. AAP §0.7.2 makes assertion
 * density part of the contract: V1 keeps BOTH strategies, so both must be observed.
 *
 * WHY RULE 4 EXISTS, AND WHY IT IS THE SAME ARGUMENT ONE LEVEL UP. "Both strategies"
 * means the SubjectAccessReview evaluation AND the bootstrap-policy enumeration
 * (`rbac_test.go` L1170-1299). Gating on the two SAR booleans alone made the
 * enumeration decorative: a payload recording the wildcard rule escaping
 * `cluster-admin`, or a binding naming a subject outside `system:masters`, still
 * rendered PASS, and so did a payload whose review had probed something narrower than
 * `*`/`*`/`*`. Rule 1 now carries the measured defects and rule 4 carries the
 * unmeasured ones, which is the same fail-versus-unknown split rules 1 and 2 already
 * make for the probes. See {@link RbacEvidenceCheck}.
 *
 * @param reported - the verdict the payload carried.
 * @param evidence - the locally derived evidence.
 * @returns the verdict to render.
 */
export function resolveRbacWildcardVerdict(
  reported: ControlVerdict,
  evidence: {
    readonly escalated: boolean;
    readonly findingCount: number;
    readonly nonMasterDecision: ProbeDecision;
    readonly systemMastersDecision: ProbeDecision;
    /** The four checks combined. See {@link RbacWildcardAssessment.evidenceVerdict}. */
    readonly evidenceVerdict: EffectiveVerdict;
  },
): ControlVerdict {
  if (
    reported === 'fail' ||
    evidence.escalated ||
    evidence.findingCount > 0 ||
    evidence.evidenceVerdict === 'fail'
  ) {
    return 'fail';
  }
  if (evidence.nonMasterDecision !== 'denied') {
    return 'unknown';
  }
  if (evidence.systemMastersDecision !== 'allowed') {
    return 'unknown';
  }
  if (evidence.evidenceVerdict !== 'pass') {
    return 'unknown';
  }
  if (reported === 'warn' || reported === 'pass') {
    return reported;
  }
  return 'unknown';
}

/**
 * The panel's own conservative verdict for V1, as one call over one payload.
 *
 * Exported so the aggregate dashboard counts, filters and summarises the SAME verdict
 * this panel renders in its badge, rather than the raw `status.verdict` the server sent.
 * A dashboard that counted the raw verdict would report "8 passing" beside a panel
 * rendering UNKNOWN, and the two would disagree with no single place to look.
 *
 * `strictestVerdict` is applied to the single derived verdict so that this resolver and
 * every other control's resolver combine through one shared function rather than through
 * eight private conventions.
 *
 * @param control - the payload for V1, or `undefined` when it was not reported.
 * @returns the verdict this panel renders.
 */
export function resolveRbacWildcardEffectiveVerdict(
  control: ControlStatus | undefined,
): ControlVerdict {
  return strictestVerdict([assessRbacWildcard(control).verdict]);
}

/**
 * Derives the whole render-time assessment from a payload.
 *
 * @param control - the payload for V1, or `undefined` when the server did not
 *   report this control. `undefined` yields an all-silent assessment whose
 *   verdict is `'unknown'`, which is what the empty state renders.
 * @returns the assessment. See {@link RbacWildcardAssessment}.
 */
export function assessRbacWildcard(
  control: ControlStatus | undefined,
): RbacWildcardAssessment {
  const observations = control?.evidence?.observations ?? NO_OBSERVATIONS;
  const nonMasterDecision = readProbeDecision(NON_MASTER_DENIED_PROBE, observations);
  const systemMastersDecision = readProbeDecision(SYSTEM_MASTERS_ALLOWED_PROBE, observations);
  const findings = control?.findings ?? [];
  const warnings = control?.warnings ?? [];
  const escalated = nonMasterDecision === 'allowed';
  const evidenceChecks = measureRbacEvidence(observations);
  const evidenceVerdict = strictestVerdict(
    evidenceChecks.map((measurement) => measurement.contributedVerdict),
  );

  return {
    verdict: resolveRbacWildcardVerdict(control?.verdict ?? 'unknown', {
      escalated,
      findingCount: findings.length,
      nonMasterDecision,
      systemMastersDecision,
      evidenceVerdict,
    }),
    nonMasterDecision,
    systemMastersDecision,
    escalated,
    controlBroken: systemMastersDecision === 'denied',
    controlUnconfirmed: systemMastersDecision === 'unreported',
    controlConflicting: systemMastersDecision === 'conflicting',
    evidenceChecks,
    evidenceVerdict,
    findings,
    warnings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * RENDERED TEXT
 *
 * Every user-visible string is a named export. Three reasons, all practical:
 * the paired spec can assert against the same constant the component renders
 * rather than a copy that drifts; the wording of the setup-breakage notice is
 * itself part of the contract, because it is what makes the abort case textually
 * distinguishable from a finding; and a single definition site keeps the
 * accessible name of an affordance identical to its visible text.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The invariant, stated on the panel itself.
 *
 * Rendered rather than merely commented, so that a reader of the UI sees the
 * boundary condition the verdict is measured against.
 */
export const RBAC_WILDCARD_INVARIANT_TEXT =
  `The full ${FULL_WILDCARD_LABEL} wildcard — every verb, every API group, every ` +
  `resource — is permitted only in the ${CLUSTER_ADMIN_ROLE_NAME} ClusterRole, and a ` +
  `full-wildcard role may be bound only to the ${SYSTEM_PRIVILEGED_GROUP} group ` +
  `(subject kind Group).`;

/** Shown while the posture request is in flight. */
export const RBAC_WILDCARD_LOADING_TEXT = 'Checking RBAC least-privilege posture…';

/** Prefixes the server's own failure wording in the error state. */
export const RBAC_WILDCARD_ERROR_PREFIX = 'RBAC least-privilege posture could not be read:';

/**
 * Shown in the error state, and load-bearing: AAP §0.4.2.4 requires that a 403
 * or a 500 never renders as a pass, and this sentence is where the panel says so
 * out loud. The hook makes it structurally impossible as well — its error arm
 * carries no `controls` member for a verdict to live in.
 */
export const RBAC_WILDCARD_NO_VERDICT_TEXT =
  'No verdict is available, because the posture request did not succeed. A failed ' +
  'request is never rendered as a pass.';

/** Shown when the server returned a successful response reporting no controls. */
export const RBAC_WILDCARD_NO_CONTROLS_TEXT =
  'The server reported no controls at all, so there is nothing to assess. This is ' +
  'not a pass.';

/** Shown when the response carried controls but not this one. */
export const RBAC_WILDCARD_CONTROL_ABSENT_TEXT =
  `The server's response did not include control ${RBAC_WILDCARD_CONTROL_ID}, so its ` +
  'posture is unknown. This is not a pass.';

/** The positive control held: the check can tell "allowed" from "denied". */
export const POSITIVE_CONTROL_SATISFIED_TEXT =
  `Positive control satisfied: the ${SYSTEM_PRIVILEGED_GROUP} group was allowed ` +
  `${FULL_WILDCARD_LABEL}, which proves the review machinery works and the ` +
  `${CLUSTER_ADMIN_ROLE_NAME} to ${SYSTEM_PRIVILEGED_GROUP} grant is intact.`;

/**
 * The positive control FAILED. This is the presentation-layer counterpart of the
 * oracle's `t.Fatalf` at `rbac_test.go` L1252-1254, and its wording is
 * deliberately unlike a finding's: it names itself a positive control, it says
 * what the failure means, and it says explicitly what the failure does NOT mean.
 */
export const POSITIVE_CONTROL_BROKEN_TEXT =
  `Check integrity broken — this is a positive control, not a security finding. The ` +
  `${SYSTEM_PRIVILEGED_GROUP} group was DENIED ${FULL_WILDCARD_LABEL}, so the ` +
  `${CLUSTER_ADMIN_ROLE_NAME} to ${SYSTEM_PRIVILEGED_GROUP} grant is missing and this ` +
  `check cannot tell a correctly locked-down cluster from an authorization stack that ` +
  `denies everything. It does NOT mean the cluster is secure, and no verdict here can ` +
  `be trusted until it is fixed.`;

/** The positive control was never evaluated, so nothing is proven either way. */
export const POSITIVE_CONTROL_UNCONFIRMED_TEXT =
  `Positive control not confirmed — this is a positive control, not a security ` +
  `finding. No decision was reported for the ${SYSTEM_PRIVILEGED_GROUP} group, so an ` +
  `absence of findings cannot be read as a pass.`;

/**
 * The positive control was reported inconsistently, so it proves nothing.
 *
 * Kept textually distinct from both the satisfied and the unconfirmed notices. Falling
 * through to the SATISFIED wording is what an inexhaustive branch would have done here,
 * and it would have announced that the review machinery works on the strength of a
 * self-contradictory report.
 */
export const POSITIVE_CONTROL_CONFLICTING_TEXT =
  `Positive control not confirmed — this is a positive control, not a security ` +
  `finding. The decision for the ${SYSTEM_PRIVILEGED_GROUP} group was reported more ` +
  `than once, or at a type that is not a boolean, so which answer is authoritative ` +
  `cannot be determined and none of them is treated as a decision.`;

/**
 * Stated whenever the non-master identity resolved full wildcard authority, so
 * the escalation is visible even if the server listed no matching finding.
 */
export const PRIVILEGE_ESCALATION_TEXT =
  `Privilege-escalation finding (F-001-RQ-001): the non-master identity ` +
  `${NON_MASTER_DENIED_PROBE.user} resolved full wildcard ${FULL_WILDCARD_LABEL}; ` +
  `least-privilege RBAC requires denial.`;

/** Accessible name of the probe table, supplied by its caption. */
export const PROBE_TABLE_CAPTION =
  `SubjectAccessReview probes for full wildcard authority ${FULL_WILDCARD_LABEL}`;

/**
 * Accessible name of the evidence table, supplied by its caption.
 *
 * Deliberately unlike {@link PROBE_TABLE_CAPTION}, so both tables are addressable by
 * name and a spec asserting on one cannot accidentally read the other.
 */
export const EVIDENCE_TABLE_CAPTION =
  'Request identity and bootstrap policy enumeration';

/** Accessible name of the re-request affordance. */
export const REFRESH_BUTTON_LABEL = 'Re-run the RBAC least-privilege check';

/** Explains a disabled re-request affordance rather than leaving it inert. */
export const REFRESH_UNAVAILABLE_TITLE = SHARED_REFRESH_UNAVAILABLE_TITLE;

/** Heading of the findings section, parameterised by the count. */
export function findingsHeading(count: number): string {
  return `Findings (${count})`;
}

/** Heading of the warnings section, parameterised by the count. */
export function warningsHeading(count: number): string {
  return `Warnings (${count})`;
}

/** Human-readable label per verdict. Exhaustive over {@link ControlVerdict}. */
export const VERDICT_LABELS: Readonly<Record<ControlVerdict, string>> = Object.freeze({
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Warning',
  unknown: 'Unknown',
});

/** Human-readable label per decision. Exhaustive over {@link ProbeDecision}. */
export const DECISION_LABELS: Readonly<Record<ProbeDecision, string>> = Object.freeze({
  allowed: 'Allowed',
  denied: 'Denied',
  unreported: 'Not reported',
  conflicting: 'Reported inconsistently',
});

/**
 * What "no findings" means, per verdict.
 *
 * A lookup rather than a chain of conditionals: it is exhaustive over
 * {@link ControlVerdict} by construction, so a fifth verdict could not be added
 * upstream without a `tsc --noEmit` error here, and it contributes no branches to
 * measure against the coverage floor of AAP §0.7.1.3.
 *
 * The distinction encoded here is the point of the empty state. Zero findings is
 * a pass ONLY alongside a satisfied positive control; on its own it is silence.
 */
export const ABSENT_FINDINGS_TEXT: Readonly<Record<ControlVerdict, string>> = Object.freeze({
  pass:
    `No findings: the full ${FULL_WILDCARD_LABEL} wildcard was found only in the ` +
    `${CLUSTER_ADMIN_ROLE_NAME} ClusterRole, bound only to the ` +
    `${SYSTEM_PRIVILEGED_GROUP} group, and the non-master identity was denied it.`,
  fail:
    'No findings were itemised, yet the verdict is Fail — see the SubjectAccessReview ' +
    'outcome above for what failed.',
  warn:
    'No findings were reported. The server did report at least one warning for this ' +
    'control; see the warnings below.',
  unknown:
    'No findings were reported, and this is NOT a pass: an absence of findings can only ' +
    'be read as a pass once the positive control above has been observed to hold.',
});

/** Column headers of the probe table, in render order. */
const PROBE_COLUMN_HEADERS: readonly string[] = Object.freeze([
  'Identity',
  'Groups',
  'Requested authority',
  'Required decision',
  'Observed decision',
  'Outcome',
]);

/** Outcome cell: the probe held. */
export const PROBE_OUTCOME_HOLDS = 'Holds';

/** Outcome cell: the probe was never evaluated. */
export const PROBE_OUTCOME_UNREPORTED = 'Not reported';

/** Outcome cell: an accumulating security finding. */
export const PROBE_OUTCOME_FINDING = 'Privilege-escalation finding';

/** Outcome cell: an aborting precondition failure. */
export const PROBE_OUTCOME_BROKEN = 'Check integrity broken';

/**
 * Outcome cell: the decision was reported more than once, or at the wrong type.
 *
 * Worded so it cannot be mistaken for either a holding probe or a finding. The report
 * is broken, which is neither evidence of a defect nor evidence of correctness.
 */
export const PROBE_OUTCOME_CONFLICTING =
  'Reported inconsistently — not counted as a decision';

/**
 * Whether a probe's observed decision matches the outcome the control requires.
 *
 * Invariant locked: `'unreported'` NEVER holds. Silence is not agreement, and
 * for the negative assertion the two would otherwise be indistinguishable —
 * "denied" and "never asked" both look like the absence of an allow.
 *
 * @param probe - the probe, carrying the required outcome.
 * @param decision - the observed decision.
 * @returns `true` only when the probe was evaluated and agreed.
 */
export function probeHolds(probe: SubjectAccessReviewProbe, decision: ProbeDecision): boolean {
  if (decision === 'unreported' || decision === 'conflicting') {
    return false;
  }
  return (decision === 'allowed') === probe.expectedAllowed;
}

/**
 * The outcome cell's text for one probe.
 *
 * The severity split is what keeps the two assertion semantics visible in the
 * table itself: an `'accumulate'` probe that fails is a security finding, while an
 * `'abort'` probe that fails means the check is broken. See
 * {@link RbacAssertionSeverity}.
 */
function describeProbeOutcome(probe: SubjectAccessReviewProbe, decision: ProbeDecision): string {
  if (decision === 'unreported') {
    return PROBE_OUTCOME_UNREPORTED;
  }
  if (decision === 'conflicting') {
    return PROBE_OUTCOME_CONFLICTING;
  }
  if (probeHolds(probe, decision)) {
    return PROBE_OUTCOME_HOLDS;
  }
  return probe.severity === 'accumulate' ? PROBE_OUTCOME_FINDING : PROBE_OUTCOME_BROKEN;
}

/** Observed cell: the fact was never reported. */
export const EVIDENCE_OBSERVED_UNREPORTED = 'Not reported';

/** Observed cell: the fact was reported more than once, so none of them counts. */
export const EVIDENCE_OBSERVED_CONFLICTING = 'Reported more than once';

/** Observed cell: the fact was reported at a type it cannot be read at. */
export const EVIDENCE_OBSERVED_WRONG_TYPE = 'Reported at an unusable type';

/**
 * What an unusable read shows in the Observed cell, per reason.
 *
 * A lookup rather than a conditional chain: exhaustive over
 * {@link EvidenceAbsenceReason} by construction, so a fourth reason added upstream
 * would be a `tsc --noEmit` error here rather than a silently blank cell. The three
 * are kept apart because the remedies differ — a gap in the report, a broken report,
 * and a contract mismatch — and because collapsing them would make all three read as
 * "not measured".
 */
export const EVIDENCE_OBSERVED_ABSENCE_TEXT: Readonly<Record<EvidenceAbsenceReason, string>> =
  Object.freeze({
    unreported: EVIDENCE_OBSERVED_UNREPORTED,
    conflict: EVIDENCE_OBSERVED_CONFLICTING,
    'wrong-type': EVIDENCE_OBSERVED_WRONG_TYPE,
  });

/** Outcome cell: the required value was measured. */
export const EVIDENCE_OUTCOME_HOLDS = PROBE_OUTCOME_HOLDS;

/**
 * Outcome cell: nothing usable was measured, so this half of the control is unproven.
 *
 * Worded so it cannot be mistaken for either a holding check or a finding: an absence
 * of evidence is neither proof of a defect nor proof of correctness, and it is exactly
 * what blocks a pass without inventing one.
 */
export const EVIDENCE_OUTCOME_NOT_ESTABLISHED =
  'Not established — not counted as evidence';

/**
 * Outcome cell: a least-privilege defect was MEASURED.
 *
 * This is the enumeration half of the oracle's `t.Errorf` channel
 * (`rbac_test.go` L1271-1297), so it is a security finding and it fails the control.
 */
export const EVIDENCE_OUTCOME_FINDING = 'Least-privilege finding';

/**
 * Outcome cell: the review measured a DIFFERENT request from the one this control is
 * about.
 *
 * Not a finding, and deliberately not worded as one: a denial of a narrower request is
 * a true statement about another question. Nothing about full wildcard authority is
 * established either way, so the verdict is floored at unknown rather than failed.
 */
export const EVIDENCE_OUTCOME_WRONG_REQUEST =
  `Measured a request other than ${FULL_WILDCARD_LABEL} — nothing is established`;

/** Column headers of the evidence table, in render order. */
const EVIDENCE_COLUMN_HEADERS: readonly string[] = Object.freeze([
  'Measured fact',
  'Requirement',
  'Required',
  'Observed',
  'Outcome',
]);

/**
 * The outcome cell's text for one evidence measurement.
 *
 * The `mismatchMeaning` split is what keeps the two readings of a mismatch visible in
 * the table itself: a measured defect is a finding, whereas a measurement of a
 * different question establishes nothing. See {@link RbacEvidenceMismatchMeaning}.
 *
 * @param measurement - the measurement to describe.
 * @returns the cell text.
 */
export function describeEvidenceOutcome(measurement: RbacEvidenceMeasurement): string {
  if (measurement.verdict === 'pass') {
    return EVIDENCE_OUTCOME_HOLDS;
  }
  if (measurement.verdict === 'unknown') {
    return EVIDENCE_OUTCOME_NOT_ESTABLISHED;
  }
  return measurement.check.mismatchMeaning === 'finding'
    ? EVIDENCE_OUTCOME_FINDING
    : EVIDENCE_OUTCOME_WRONG_REQUEST;
}

/**
 * The observed cell's text for one evidence measurement.
 *
 * @param observed - what the report said.
 * @returns the cell text, already bounded and safe to render.
 */
export function describeEvidenceObserved(observed: RbacEvidenceObservedValue): string {
  return observed.kind === 'measured'
    ? observed.text
    : EVIDENCE_OBSERVED_ABSENCE_TEXT[observed.reason];
}

/* ══════════════════════════════════════════════════════════════════════════
 * MARKUP
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The landmark, the heading and the re-request affordance — everything common to
 * all four states.
 *
 * The `section` carries an `aria-label` taken from the same constant as the `h2`,
 * which gives it the `region` role with an accessible name identical to its
 * visible heading. No generated id is involved, so two panels can never collide
 * on one.
 *
 * The re-request `button` is ALWAYS rendered, so it is queryable in every state
 * including loading and error, where re-issuing the request is exactly what a
 * reader wants. When the panel was handed a payload by its caller there is no
 * request to re-issue, so the button is natively `disabled` with a `title` that
 * says why — an inert button that silently did nothing would be worse than an
 * honest disabled one.
 */
function PanelFrame({
  children,
  onRefresh,
}: {
  readonly children: ReactNode;
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  // EMBEDDED-AWARE OWN HEADING (m3), bound once for this component.
  const rendersOwnHeading = useRendersOwnHeading();
  return (
    <section aria-label={RBAC_WILDCARD_PANEL_TITLE}>
      {/*
        EMBEDDED-AWARE OWN HEADING (m3). Standalone, this heading names the panel's region and
        is the only title on screen. Embedded, the dashboard has already written an `h3` naming
        this control, so rendering a second title here both DUPLICATED the name and restarted
        the heading run at a shallower level than the one above it. The region keeps a name
        either way: `aria-labelledby` points at whichever heading exists.
      */}
      {rendersOwnHeading ? <h2>{RBAC_WILDCARD_PANEL_TITLE}</h2> : null}
      {children}
      <button
        type="button"
        onClick={onRefresh}
        disabled={onRefresh === undefined}
        title={onRefresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
      >
        {REFRESH_BUTTON_LABEL}
      </button>
    </section>
  );
}

/**
 * The positive control's own affordance.
 *
 * Kept separate from the findings list on purpose, and given the `alert` role
 * only in the broken case: `rbac_test.go` L1252-1254 aborts there, so this is the
 * one condition on the panel that invalidates everything else. The paired spec
 * asserts this with a hard `expect`, mirroring `t.Fatalf`, while asserting each
 * finding softly, mirroring `t.Errorf`.
 */
function PositiveControlNotice({ decision }: { readonly decision: ProbeDecision }): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). See the note on the status role above.
  const liveAlertRole = useLiveRegionRole('alert');
  if (decision === 'denied') {
    return <p role={liveAlertRole}>{POSITIVE_CONTROL_BROKEN_TEXT}</p>;
  }
  if (decision === 'unreported') {
    return <p>{POSITIVE_CONTROL_UNCONFIRMED_TEXT}</p>;
  }
  if (decision === 'conflicting') {
    return <p>{POSITIVE_CONTROL_CONFLICTING_TEXT}</p>;
  }
  return <p>{POSITIVE_CONTROL_SATISFIED_TEXT}</p>;
}

/**
 * One row of the probe table.
 *
 * A `th` with `scope="row"` carries the identity, so the row's accessible name
 * begins with the subject under test and every cell is reachable from it. That is
 * what lets a spec address a single probe by its identity rather than by index.
 */
function ProbeRow({
  probe,
  decision,
}: {
  readonly probe: SubjectAccessReviewProbe;
  readonly decision: ProbeDecision;
}): ReactElement {
  return (
    <tr>
      <th scope="row">{probe.user}</th>
      <td>{probe.groups.join(', ')}</td>
      <td>
        {`${FULL_WILDCARD_REQUEST.verb} / ${FULL_WILDCARD_REQUEST.apiGroup} / ` +
          `${FULL_WILDCARD_REQUEST.resource}`}
      </td>
      <td>{probe.expectedAllowed ? DECISION_LABELS.allowed : DECISION_LABELS.denied}</td>
      <td>{DECISION_LABELS[decision]}</td>
      <td>{describeProbeOutcome(probe, decision)}</td>
    </tr>
  );
}

/**
 * One row of the evidence table — a request-identity or bootstrap-enumeration check.
 *
 * A `th` with `scope="row"` carries the fact's title, so the row is addressable by the
 * thing it measures rather than by index, exactly as {@link ProbeRow} is. The Observed
 * cell holds text that was bounded and redacted when the measurement was taken, so no
 * unbounded server value reaches the document from here.
 */
function EvidenceRow({
  measurement,
}: {
  readonly measurement: RbacEvidenceMeasurement;
}): ReactElement {
  return (
    <tr>
      <th scope="row">{measurement.check.title}</th>
      <td>{measurement.check.requirementId}</td>
      <td>{measurement.check.requirement}</td>
      <td>{describeEvidenceObserved(measurement.observed)}</td>
      <td>{describeEvidenceOutcome(measurement)}</td>
    </tr>
  );
}

/**
 * One finding.
 *
 * The optional members are appended as sentences rather than rendered as empty
 * cells, so the text `undefined` can never reach the document — the defensive
 * requirement of the UI guidelines and of AAP §0.7.2's legibility criterion. The
 * requirement identifier is included whenever the server attributed one, which is
 * what makes a failure read as a requirement violation.
 */
function FindingItem({ finding }: { readonly finding: ControlFinding }): ReactElement {
  return (
    <li>
      {safeProse(finding.message)}
      {finding.subject === undefined
        ? null
        : ` Offending object: ${safeLabel(finding.subject)}.`}
      {finding.requirementId === undefined
        ? null
        : ` Requirement: ${safeLabel(finding.requirementId)}.`}
    </li>
  );
}

/** The loading state. */
function RbacWildcardLoading({
  onRefresh,
}: {
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <PanelFrame onRefresh={onRefresh}>
      <p role={liveStatusRole}>{RBAC_WILDCARD_LOADING_TEXT}</p>
    </PanelFrame>
  );
}

/**
 * The error state — a 403, a 500, a network failure or an untrustworthy payload.
 *
 * There is deliberately no verdict here, and no `status` element for one to
 * appear in later. The server's own wording is preferred for the message (the
 * hook prefers a Kubernetes `Status` body's `message` when one was sent), and the
 * status code and `reason` are surfaced verbatim beside it.
 */
function RbacWildcardError({
  error,
  onRefresh,
}: {
  readonly error: ControlStatusError;
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). See the note on the status role above.
  const liveAlertRole = useLiveRegionRole('alert');
  return (
    <PanelFrame onRefresh={onRefresh}>
      <p role={liveAlertRole}>{`${RBAC_WILDCARD_ERROR_PREFIX} ${safeProse(error.message)}`}</p>
      <dl>
        {/*
          `kind` is a typed union of this tier's own tokens and `httpStatus` is a
          number, so neither is external prose and neither is sanitized -- passing a
          local token through a redactor would only make it possible for it to come
          back changed. `message` and `reason` come from a Kubernetes `Status` body
          and are the two channels a hostile or broken server controls, so both are
          bounded and redacted (AAP §0.11.1).
        */}
        <dt>Failure kind</dt>
        <dd>{error.kind}</dd>
        {error.httpStatus === undefined ? null : (
          <>
            <dt>HTTP status</dt>
            <dd>{String(error.httpStatus)}</dd>
          </>
        )}
        {error.reason === undefined ? null : (
          <>
            <dt>Server reason</dt>
            <dd>{safeLabel(error.reason)}</dd>
          </>
        )}
      </dl>
      <p>{RBAC_WILDCARD_NO_VERDICT_TEXT}</p>
    </PanelFrame>
  );
}

/**
 * The empty state, in its two distinguishable forms.
 *
 * Both are `unknown` and neither is a pass. They are told apart because the
 * remedies differ: no controls at all points at the posture endpoint, whereas a
 * response that omitted this one control points at the control's own collector.
 */
function RbacWildcardEmpty({
  reason,
  onRefresh,
}: {
  readonly reason: RbacWildcardEmptyReason;
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <PanelFrame onRefresh={onRefresh}>
      <p role={liveStatusRole}>{`Verdict: ${VERDICT_LABELS.unknown}`}</p>
      <p>
        {reason === 'no-controls-reported'
          ? RBAC_WILDCARD_NO_CONTROLS_TEXT
          : RBAC_WILDCARD_CONTROL_ABSENT_TEXT}
      </p>
      <p>{RBAC_WILDCARD_INVARIANT_TEXT}</p>
    </PanelFrame>
  );
}

/**
 * The populated state: a verdict, the two probes, the positive control and EVERY
 * finding.
 *
 * The findings list is rendered with a plain `map` over the whole array. That is
 * the load-bearing detail of this component: there is no `slice`, no cap, no
 * "…and N more" and no early exit, because `rbac_test.go` reports every offender
 * in one run through `t.Errorf` and a panel that truncated would reintroduce
 * exactly the defect that choice prevents. `key` is the index because a finding
 * has no server-assigned identity and duplicates are legitimate — the same
 * offending subject can violate more than one rule — so index is the only stable
 * identity available, and the list is never reordered or filtered.
 */
function RbacWildcardReport({
  control,
  onRefresh,
}: {
  readonly control: ControlStatus;
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  const assessment = assessRbacWildcard(control);
  const requirementIds =
    control.requirementIds !== undefined && control.requirementIds.length > 0
      ? control.requirementIds
      : RBAC_WILDCARD_REQUIREMENT_IDS;

  return (
    <PanelFrame onRefresh={onRefresh}>
      {/*
        THE VERDICT IS LOCAL, THE SUMMARY IS NOT. `VERDICT_LABELS[...]` is this file's
        own word for a verdict this file computed, so a server cannot influence it; the
        summary, detail, requirement identifiers, findings, warnings and timestamp are
        all server-supplied and every one of them is bounded and redacted on the way in.
        Prose goes through `safeProse` and identifiers through the harder `safeLabel`,
        because an identifier that needs 2000 characters is not an identifier.
      */}
      <p role={liveStatusRole}>
        {`Verdict: ${VERDICT_LABELS[assessment.verdict]} — ${safeProse(control.summary)}`}
      </p>
      {control.detail === undefined ? null : <p>{safeProse(control.detail)}</p>}
      <p>{`Requirements covered: ${requirementIds.map(safeLabel).join(', ')}`}</p>
      <p>{RBAC_WILDCARD_INVARIANT_TEXT}</p>

      <PositiveControlNotice decision={assessment.systemMastersDecision} />
      {assessment.escalated ? <p>{PRIVILEGE_ESCALATION_TEXT}</p> : null}

      <table>
        <caption>{PROBE_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            {PROBE_COLUMN_HEADERS.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <ProbeRow probe={NON_MASTER_DENIED_PROBE} decision={assessment.nonMasterDecision} />
          <ProbeRow
            probe={SYSTEM_MASTERS_ALLOWED_PROBE}
            decision={assessment.systemMastersDecision}
          />
        </tbody>
      </table>

      {/*
        The enumeration half of V1, rendered as first-class checks rather than left as
        decorative observations. All four rows always render, so a report that measured
        none of them is visibly a report that measured none -- which is the difference
        between an unproven control and a clean one.
      */}
      <table>
        <caption>{EVIDENCE_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            {EVIDENCE_COLUMN_HEADERS.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assessment.evidenceChecks.map((measurement) => (
            <EvidenceRow key={measurement.check.id} measurement={measurement} />
          ))}
        </tbody>
      </table>

      <Subheading>{findingsHeading(assessment.findings.length)}</Subheading>
      {assessment.findings.length === 0 ? (
        <p>{ABSENT_FINDINGS_TEXT[assessment.verdict]}</p>
      ) : (
        <ul>
          {assessment.findings.map((finding, index) => (
            <FindingItem key={index} finding={finding} />
          ))}
        </ul>
      )}

      {assessment.warnings.length === 0 ? null : (
        <>
          <Subheading>{warningsHeading(assessment.warnings.length)}</Subheading>
          <ul>
            {assessment.warnings.map((warning, index) => (
              <li key={index}>{safeProse(warning)}</li>
            ))}
          </ul>
        </>
      )}

      {control.observedAt === undefined ? null : (
        <p>{`Evaluated at ${safeLabel(control.observedAt)}.`}</p>
      )}
    </PanelFrame>
  );
}

/**
 * Renders whichever of the four states the hook's result describes.
 *
 * Shared by the connected component and by a caller that drives the panel with a
 * result of its own, so both paths render identical markup for identical state —
 * which is what makes the pre-resolved props a genuine test seam rather than a
 * second, divergent implementation.
 */
function RbacWildcardResult({
  result,
  onRefresh,
}: {
  readonly result: UseControlStatusResult;
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  if (result.status === 'loading') {
    return <RbacWildcardLoading onRefresh={onRefresh} />;
  }
  if (result.status === 'error') {
    return <RbacWildcardError error={result.error} onRefresh={onRefresh} />;
  }
  const control = selectControlStatus(result.controls, RBAC_WILDCARD_CONTROL_ID);
  if (control === undefined) {
    return (
      <RbacWildcardEmpty
        reason={result.isEmpty ? 'no-controls-reported' : 'control-absent'}
        onRefresh={onRefresh}
      />
    );
  }
  return <RbacWildcardReport control={control} onRefresh={onRefresh} />;
}

/**
 * The self-fetching variant.
 *
 * Its only job is to own the hook call, which is why it is a component and not a
 * branch inside {@link RbacWildcardPanel}: React's rules require a hook to be
 * called unconditionally by the component that uses it, so the choice between
 * fetching and being handed a payload has to be a choice of which component to
 * render, not a conditional call.
 */
function RbacWildcardConnected({
  onRefresh,
  canRefresh,
}: {
  readonly onRefresh: (() => void) | undefined;
  readonly canRefresh: boolean;
}): ReactElement {
  const result = useControlStatus(RBAC_WILDCARD_CONTROL_ID);
  return (
    <RbacWildcardResult
      result={result}
      onRefresh={resolveRefreshHandler(onRefresh, result.refresh, canRefresh)}
    />
  );
}

/**
 * Props of {@link RbacWildcardPanel}. All optional, and mutually exclusive in
 * practice; `status` wins if both are supplied.
 */
export interface RbacWildcardPanelProps {
  /**
   * A pre-resolved payload for this control. Supplying it renders the populated
   * state directly and issues NO request, which is what lets a caller drive the
   * panel through every verdict without a transport.
   */
  readonly status?: ControlStatus;
  /**
   * A pre-resolved hook result. Supplying it renders whichever of loading,
   * error, empty or populated the result describes, and issues no request.
   */
  readonly result?: UseControlStatusResult;
  /**
   * Handler for the re-request affordance when a payload was supplied. Without
   * it the button renders natively `disabled`, because there is no request for
   * this panel to re-issue. Ignored when `result` is supplied — that carries its
   * own `refresh`.
   */
  readonly onRefresh?: () => void;
  /**
   * Whether refreshing can re-request anything at all.
   *
   * `false` disables this panel's refresh affordance and explains why, which is how an
   * aggregate surface that was handed its posture directly keeps every control's button
   * consistent with its own. Defaults to `true`, so a panel used on its own is unaffected.
   */
  readonly canRefresh?: boolean;
}

/**
 * The V1 posture panel: RBAC least-privilege.
 *
 * Renders whether the full `*`/`*`/`*` wildcard is confined to the
 * `cluster-admin` ClusterRole and bound only to the `system:masters` group
 * (F-001-RQ-002), and whether a non-master identity is denied it
 * (F-001-RQ-001) — together with EVERY offender found, the positive control that
 * proves the check itself works, and distinct loading, empty and error states.
 *
 * Data comes from `useControlStatus` and only from there; this component never
 * calls `fetch`.
 *
 * @param props - see {@link RbacWildcardPanelProps}. With none, the panel fetches
 *   its own posture for control `V1`.
 * @returns the rendered panel.
 */
export default function RbacWildcardPanel({
  status,
  result,
  onRefresh,
  canRefresh = true,
}: RbacWildcardPanelProps = {}): ReactElement {
  if (status !== undefined) {
    return (
      <RbacWildcardReport
        control={status}
        onRefresh={resolveRefreshHandler(onRefresh, undefined, canRefresh)}
      />
    );
  }
  if (result !== undefined) {
    return (
      <RbacWildcardResult
        result={result}
        onRefresh={resolveRefreshHandler(onRefresh, result.refresh, canRefresh)}
      />
    );
  }
  return <RbacWildcardConnected onRefresh={onRefresh} canRefresh={canRefresh} />;
}
