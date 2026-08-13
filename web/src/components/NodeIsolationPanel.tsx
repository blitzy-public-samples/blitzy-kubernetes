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

// AAP §0.5.1 / §0.4.2.4 (L6 React tier, V7) / tech-spec §0.6.1 — the React
// presentation surface for V7, NodeRestriction / node isolation (feature F-007).
//
// NO PARITY ANCESTOR. This tier is greenfield: `Project Guide.md` L133 records
// that "This is a control-plane/configuration project with no UI surface", and
// tech-spec §6.6.1.3 marks UI automation and cross-browser testing not
// applicable. Nothing is therefore ported here. Per AAP §0.4.1.1 the parity
// anchor for the L6 tier is instead the REST behaviour this panel surfaces, and
// that behaviour is read from the Go oracle this workstream never deletes
// (AAP §0.5.1 — the DELETE set is empty by design):
//
//   `test/integration/auth/node_test.go` L1586-1687,
//   `TestNodeRestrictionCrossNodeDenied`, whose four assertions are, in order:
//
//     1. expectForbidden — node1 calls Nodes().UpdateStatus on node2  -> 403.
//     2. expectForbidden — node1 calls Secrets("ns").Get("unrelatedsecret")
//        -> 403.
//     3. expectAllowed   — node1 calls Nodes().Get("node1").  POSITIVE CONTROL.
//     4. expectAllowed   — node1 calls Nodes().UpdateStatus on node1.
//        POSITIVE CONTROL.
//
//   The helpers those assertions use are themselves evidence that 403 and 404
//   are distinct outcomes rather than interchangeable ones: `expectForbidden`
//   (L698) tests `apierrors.IsForbidden`, `expectNotFound` (L705) tests
//   `apierrors.IsNotFound`, and `expectAllowed` (L712) tests `err == nil`.
//
// THE INVARIANT THIS COMPONENT LOCKS (AAP §0.10.2, "NodeRestriction ordering";
// AAP §0.11.1, "never weaken a boundary condition to make a test pass"):
//
//   Cross-node mutation is denied with 403 Forbidden, while a node's OWN Node
//   object stays readable and updatable. A 404 NotFound is NEVER a pass,
//   because NotFound would mask Forbidden.
//
//   The Go oracle carries an explicit ORDER MATTERS comment saying exactly why:
//   node2 must be created before node1's cross-node call, "otherwise the
//   cross-node UpdateStatus returns NotFound instead of the deterministic
//   Forbidden result the V7 assertion requires". A NotFound proves only that
//   the object was absent; it cannot prove that the restriction was enforced.
//   The same trap exists at the presentation layer, and closing it is the core
//   logic of this file — see `classifyObservedValue` and `resolveCheckStatus`.
//
//   The two POSITIVE CONTROLS are part of the same boundary. Without them a
//   panel would report the two denials as a healthy control even if the entire
//   authorization stack were broken and every request were being refused.
//
// Requirement identifiers are the repository's own: F-007-RQ-001 (the admission
// plugin is present on both GCE profiles) and F-007-RQ-002 (cross-node denial).
// No external benchmark or hardening-guide control number is asserted anywhere,
// because the repository enumerates none (AAP §0.8.2, §0.10.1 and §0.11.1,
// "cite only what the repository states"). Nor is any credential rendered: the
// oracle's token values are documented fake test data and are irrelevant to a
// presentation layer, so they appear nowhere in this module.
//
// DEPENDENCY DISCIPLINE (AAP §0.11.1). Exactly two imports: `react`, and the
// sibling hook module that is the single definition site for the control-posture
// types. No design system, no CSS framework, no icon library, no router and no
// data-fetching library is introduced, so the pin set fixed by AAP §0.6.1.2 and
// web/package-lock.json stay in step. There is deliberately no local re-
// declaration of `ControlId`, `ControlVerdict` or `ControlStatus` and no
// `types.ts`: those live in one place and are imported from it.
import { useId, type ReactElement } from 'react';

import {
  selectControlStatus,
  useControlStatus,
  type ControlFinding,
  type ControlId,
  type ControlObservation,
  type ControlStatus,
  type ControlStatusError,
  type ControlStatusErrorResult,
  type ControlStatusLoadingResult,
  type ControlStatusSuccessResult,
  type ControlVerdict,
  type UseControlStatusResult,
} from '../hooks/useControlStatus';
import { REFRESH_UNAVAILABLE_TITLE, resolveRefreshHandler } from './refreshContract';
import { strictestVerdict } from '../domain/evidence';
import { V7_OBSERVATIONS, V7_OUTCOME_TITLES } from '../domain/observationIds';
import {
  describeStatusReason,
  safeLabel,
  safeObservationValue,
  safeProse,
} from '../domain/safeText';
// The enabling posture and the two denial statuses, from the ONE place each is defined.
// M16 gates the pass on the first two, so a literal here would be a second copy that
// typechecks while disagreeing with the fixture the gate is measured against.
import {
  FORBIDDEN_STATUS,
  NODE_AUTHORIZATION_MODE,
  NODE_RESTRICTION_PLUGIN,
  NOT_FOUND_STATUS,
} from '../domain/securityConstants';
import {
  useLiveRegionRole,
  usePanelLabelId,
  usePanelSubheading,
  useRendersOwnHeading,
} from './embeddedPanel';

/**
 * The control this panel reports on. Typed as {@link ControlId} rather than as a
 * bare string so that a typo is a `tsc --noEmit` error and not a panel that
 * silently queries an endpoint nobody serves.
 */
const V7_CONTROL_ID: ControlId = 'V7';

/**
 * The requirement identifiers V7 covers, used when the server reports none of
 * its own. F-007-RQ-001 is the admission-plugin presence requirement and
 * F-007-RQ-002 is the cross-node denial requirement.
 */
const V7_REQUIREMENT_IDS: readonly string[] = ['F-007-RQ-001', 'F-007-RQ-002'];

/**
 * Which of the four oracle outcomes a row describes.
 *
 * These identifiers are stable and are the primary key used to match a reported
 * {@link ControlObservation} to a row, so renaming one is a contract change.
 */
export type NodeIsolationCheckId =
  | 'cross-node-status-update'
  | 'unrelated-secret-read'
  | 'own-node-read'
  | 'own-node-status-update';

/**
 * What the oracle requires of a check.
 *
 * `denied` means the request MUST be refused with 403 Forbidden — nothing else
 * counts, which is the whole point of this module. `allowed` means the request
 * MUST succeed, mirroring the oracle's `expectAllowed` (`err == nil`).
 */
type CheckExpectation = 'denied' | 'allowed';

/**
 * What the server actually reported for a check, after classification.
 *
 * `forbidden` and `not-found` are separate members ON PURPOSE. Collapsing them
 * into a single "denied" member is precisely the weakening the Go oracle's
 * ORDER MATTERS comment warns against, so the type system is used to make that
 * collapse impossible to write by accident.
 */
type ObservedOutcome =
  /** A 2xx response, or an explicit affirmative such as `true` or `Allowed`. */
  | { readonly kind: 'allowed'; readonly httpStatus?: number; readonly raw: string }
  /** 403 Forbidden — the only outcome that proves a denial was enforced. */
  | { readonly kind: 'forbidden'; readonly httpStatus: number; readonly raw: string }
  /** 404 NotFound — a denial that proves nothing, because absence masks it. */
  | { readonly kind: 'not-found'; readonly httpStatus: number; readonly raw: string }
  /** A refusal whose status code was not reported, so 403 cannot be inferred. */
  | { readonly kind: 'denied-unspecified'; readonly httpStatus?: number; readonly raw: string }
  /** Something was reported, but it does not describe an outcome. */
  | { readonly kind: 'unreadable'; readonly raw: string }
  /**
   * The check was reported MORE THAN ONCE, so which outcome is authoritative cannot be
   * determined.
   *
   * A member of its own rather than a fold into `unreadable`, because the two have
   * different remedies: an unreadable value needs the value corrected, a duplicated
   * label needs the report corrected. Resolving a duplicate by list order -- which is
   * what this panel used to do -- makes a node-isolation verdict a function of
   * serialisation order.
   */
  | { readonly kind: 'inconsistent'; readonly count: number }
  /** Nothing at all was reported for this check. */
  | { readonly kind: 'not-reported' };

/**
 * How a check stands once its expectation is compared with what was observed.
 *
 * - `satisfied` — the observed outcome is exactly what the oracle requires.
 * - `violated` — the observed outcome contradicts the oracle.
 * - `indeterminate` — something was observed, but it cannot establish the
 *   requirement. A 404 on a denial check lands here, and so does a refusal
 *   whose status code is unknown: neither can be distinguished from a masked
 *   Forbidden.
 * - `not-reported` — nothing was observed. It is not treated as CONTRADICTING evidence,
 *   but it does prevent a pass: see {@link resolveEffectiveVerdict}.
 */
type CheckStatus = 'satisfied' | 'violated' | 'indeterminate' | 'not-reported';

/**
 * One of the four outcomes the oracle asserts, as a declarative row definition.
 *
 * The rows are fixed rather than derived from the payload, because they describe
 * what V7 REQUIRES rather than what a server happened to send. A server that
 * omits a check therefore cannot make that check disappear from the panel; it
 * can only make it render as `not-reported`.
 */
interface NodeIsolationCheck {
  /** See {@link NodeIsolationCheckId}. */
  readonly id: NodeIsolationCheckId;
  /** Row header text, using the oracle's own measured identities. */
  readonly title: string;
  /** See {@link CheckExpectation}. */
  readonly expectation: CheckExpectation;
  /** Human-readable form of {@link NodeIsolationCheck.expectation}. */
  readonly expectationLabel: string;
  /** `true` for the two rows that exist to prove the denials are targeted. */
  readonly isPositiveControl: boolean;
  /** The repository's own requirement identifier this row enforces. */
  readonly requirementId: string;
  /** Why the oracle requires this outcome, rendered beneath the table. */
  readonly note: string;
  /**
   * The EXACT `ControlObservation.label` carrying this check's outcome, taken from
   * {@link V7_OBSERVATIONS} so the fixture that records it and this panel cannot name it
   * differently.
   *
   * WHY THE TOKEN MATCHER IS GONE, stated as the defect it caused. This row used to be
   * matched by folding the label to alphanumerics and then testing token groups with
   * `includes`, with the cross-node row keyed on the token `node2` and the Secret row on
   * `secret`. The recorded passing payload also carries
   * `precondition: node2 existed before the cross-node call` with the value `true` —
   * which contains `node2`. Whether that observation or the real 403 claimed the
   * cross-node row depended purely on which came first in the list, and if the
   * precondition won, its `true` read as ALLOWED and a recorded PASS rendered as a
   * FAIL. Matching is now `===` against this identity and the exact aliases below.
   */
  readonly observationLabel: string;
  /**
   * Additional labels that name this check, compared EXACTLY -- never folded, never as a
   * substring.
   *
   * Present because a server may report a row under the scenario title rather than under
   * the measurement identity, and both are legitimate names for the same fact. Two
   * observations matching one row by ANY of its names is a conflict, not a preference
   * order, so an alias cannot quietly override the primary identity.
   */
  readonly aliases: readonly string[];
}

/**
 * The four outcomes of `TestNodeRestrictionCrossNodeDenied`, in the order the
 * oracle asserts them: the two denials first, then the two positive controls.
 *
 * Exported so that a specification, a fixture builder or the aggregate dashboard
 * can enumerate the same rows this panel renders instead of restating them.
 */
export const NODE_ISOLATION_CHECKS: readonly NodeIsolationCheck[] = [
  {
    id: 'cross-node-status-update',
    title: 'node1 updates the Node status of node2',
    expectation: 'denied',
    expectationLabel: 'Denied with 403 Forbidden',
    isPositiveControl: false,
    requirementId: 'F-007-RQ-002',
    note:
      'NodeRestriction confines create, update and patch of a Node object to the node’s own ' +
      'object, so a cross-node status update must be refused. A 404 NotFound here would mean ' +
      'only that node2 was absent, which is why it cannot stand in for the 403.',
    observationLabel: V7_OBSERVATIONS.crossNodeStatusUpdate,
    aliases: [V7_OUTCOME_TITLES.crossNodeDenied],
  },
  {
    id: 'unrelated-secret-read',
    title: 'node1 reads Secret ns/unrelatedsecret',
    expectation: 'denied',
    expectationLabel: 'Denied with 403 Forbidden',
    isPositiveControl: false,
    requirementId: 'F-007-RQ-002',
    note:
      'The Node authorizer returns no opinion for a Secret that none of node1’s pods reference, ' +
      'and no role grants that read to system:nodes, so the read must be refused.',
    observationLabel: V7_OBSERVATIONS.unrelatedSecretRead,
    aliases: [V7_OUTCOME_TITLES.unrelatedSecretDenied],
  },
  {
    id: 'own-node-read',
    title: 'node1 reads its own Node object',
    expectation: 'allowed',
    expectationLabel: 'Allowed',
    isPositiveControl: true,
    requirementId: 'F-007-RQ-002',
    note:
      'Positive control. Without it the two denials above would still be reported as a healthy ' +
      'control even if every request were being refused and the authorization stack were broken.',
    observationLabel: V7_OBSERVATIONS.ownNodeRead,
    aliases: [V7_OUTCOME_TITLES.ownNodeReadAllowed],
  },
  {
    id: 'own-node-status-update',
    title: 'node1 updates its own Node status',
    expectation: 'allowed',
    expectationLabel: 'Allowed',
    isPositiveControl: true,
    requirementId: 'F-007-RQ-002',
    note:
      'Positive control. NodeRestriction permits a node to act on its own Node object, so this ' +
      'must remain allowed; a denial here would mean the restriction is over-broad.',
    observationLabel: V7_OBSERVATIONS.ownNodeStatusUpdate,
    aliases: [V7_OUTCOME_TITLES.ownNodeStatusUpdateAllowed],
  },
];

/* ------------------------------------------------------------------------ *
 * The enabling configuration (M16) — F-007-RQ-001.
 * ------------------------------------------------------------------------ */

/**
 * How one enabling-configuration requirement stands.
 *
 * Kept as its own vocabulary rather than reusing {@link CheckStatus}, because the two
 * answer different questions and share only their shape: a runtime check asks what the API
 * server DID, and a configuration requirement asks whether the API server was launched in
 * a way that makes what it did mean anything.
 */
type ConfigStatus = 'satisfied' | 'violated' | 'indeterminate' | 'not-reported';

/** One enabling-configuration requirement, and what became of it. */
interface ResolvedConfigRequirement {
  /** Stable identifier, and the `data-config` attribute a specification addresses. */
  readonly id: 'authorization-mode' | 'node-restriction-plugin';
  /** Row header text. */
  readonly title: string;
  /** The exact observation identity carrying the measurement. */
  readonly observationLabel: string;
  /** What the requirement demands, in words, rendered beside what arrived. */
  readonly required: string;
  /** What arrived, already bounded for display. */
  readonly observed: string;
  /** See {@link ConfigStatus}. */
  readonly status: ConfigStatus;
  /** Why the requirement exists, rendered beneath the table. */
  readonly note: string;
}

/**
 * Resolves the two enabling-configuration requirements F-007-RQ-001 covers.
 *
 * THE M16 DEFECT, stated as what it allowed. `V7_REQUIREMENT_IDS` claims F-007-RQ-001 —
 * the enabling-configuration requirement — and the panel rendered `authorization mode` and
 * `admission plugins enabled` in "Other reported observations", where nothing read them.
 * A payload could therefore report `authorizationMode: 'RBAC'`, with the Node authorizer
 * absent entirely, and still earn a PASS attributed to F-007-RQ-001 on the strength of
 * four runtime outcomes that a permissive RBAC role would produce identically.
 *
 * Both requirements are now measured, and each is compared EXACTLY:
 *
 *   * the mode is the whole string `Node,RBAC`, ORDER INCLUDED, because both authorizers
 *     are load-bearing and the flag value is a sequence rather than a set;
 *   * the plugin list is split on commas and `NodeRestriction` must be a MEMBER — never a
 *     substring, so a hypothetical `NodeRestrictionShim` cannot satisfy it.
 *
 * The three outcomes are kept apart deliberately. An unreported requirement is a gap and
 * floors the verdict at `unknown`; a requirement reported WRONG is a defect and floors it
 * at `fail`, because a cluster running without the Node authorizer or without the
 * restriction plugin is not enforcing this control however its runtime checks read.
 */
function resolveConfigRequirements(
  observations: readonly ControlObservation[],
): readonly ResolvedConfigRequirement[] {
  return [
    resolveAuthorizationMode(observations),
    resolveNodeRestrictionPlugin(observations),
  ];
}

/** The `--authorization-mode` requirement: the whole string, order included. */
function resolveAuthorizationMode(
  observations: readonly ControlObservation[],
): ResolvedConfigRequirement {
  const base = {
    id: 'authorization-mode',
    title: 'Authorization mode',
    observationLabel: V7_OBSERVATIONS.authorizationMode,
    required: NODE_AUTHORIZATION_MODE,
    note:
      'The Node authorizer decides which objects a kubelet identity may read at all, so ' +
      'without it every denial below comes from an RBAC rule instead and this is a ' +
      'different control with the same symptom. The order is part of the flag value.',
  } as const;
  const matches = observations.filter(
    (observation) => observation.label === V7_OBSERVATIONS.authorizationMode,
  );
  if (matches.length > 1) {
    return { ...base, observed: describeDuplicateCount(matches.length), status: 'indeterminate' };
  }
  const [observation] = matches;
  if (observation === undefined) {
    return { ...base, observed: NOT_REPORTED_VALUE_LABEL, status: 'not-reported' };
  }
  if (typeof observation.value !== 'string') {
    return {
      ...base,
      observed: safeObservationValue(formatObservationValue(observation.value)),
      status: 'indeterminate',
    };
  }
  const observed = observation.value.trim();
  if (observed === '') {
    // AN EMPTY STRING IS NOT A MEASUREMENT, it is the absence of one wearing a value's
    // clothes — so it is indeterminate rather than violated, exactly as an empty plugin list
    // is below. Calling it a violation would assert that the cluster is misconfigured on the
    // strength of a report that said nothing, which is the same error as a false pass with
    // its sign reversed.
    return { ...base, observed: EMPTY_VALUE_LABEL, status: 'indeterminate' };
  }
  return {
    ...base,
    observed: safeObservationValue(observed),
    status: observed === NODE_AUTHORIZATION_MODE ? 'satisfied' : 'violated',
  };
}

/** The `--enable-admission-plugins` requirement: `NodeRestriction` as an exact member. */
function resolveNodeRestrictionPlugin(
  observations: readonly ControlObservation[],
): ResolvedConfigRequirement {
  const base = {
    id: 'node-restriction-plugin',
    title: 'Admission plugin enabled',
    observationLabel: V7_OBSERVATIONS.admissionPluginsEnabled,
    required: `${NODE_RESTRICTION_PLUGIN} present in the enabled plugin list`,
    note:
      'The Node authorizer governs reads; this plugin is what stops a node identity from ' +
      'MUTATING an object it is allowed to read. Neither substitutes for the other, which ' +
      'is why they are two requirements rather than one posture flag.',
  } as const;
  const matches = observations.filter(
    (observation) => observation.label === V7_OBSERVATIONS.admissionPluginsEnabled,
  );
  if (matches.length > 1) {
    return { ...base, observed: describeDuplicateCount(matches.length), status: 'indeterminate' };
  }
  const [observation] = matches;
  if (observation === undefined) {
    return { ...base, observed: NOT_REPORTED_VALUE_LABEL, status: 'not-reported' };
  }
  if (typeof observation.value !== 'string') {
    return {
      ...base,
      observed: safeObservationValue(formatObservationValue(observation.value)),
      status: 'indeterminate',
    };
  }
  const raw = observation.value.trim();
  if (raw === '') {
    return { ...base, observed: EMPTY_VALUE_LABEL, status: 'indeterminate' };
  }
  // MEMBERSHIP, not containment: split on the separator the flag itself uses and compare
  // each member whole. `includes('NodeRestriction')` would also be satisfied by a plugin
  // merely NAMED after it.
  const members = raw.split(',').map((member) => member.trim());
  return {
    ...base,
    observed: safeObservationValue(raw),
    status: members.includes(NODE_RESTRICTION_PLUGIN) ? 'satisfied' : 'violated',
  };
}

/** Rendered in the observed column of a configuration requirement nobody reported. */
const NOT_REPORTED_VALUE_LABEL = 'not reported';

/** Rendered when one identity was reported more than once, so none is authoritative. */
function describeDuplicateCount(count: number): string {
  return `reported ${String(count)} times, so none is authoritative`;
}

/** Rendered for an observation whose value is an explicit, meaningful `null`. */
const NULL_VALUE_LABEL = 'reported explicitly as null';

/** Rendered for an observation whose value is the empty string. */
const EMPTY_VALUE_LABEL = 'reported as an empty value';

/**
 * Every name one row answers to: its measurement identity, its stable identifier and its
 * exact aliases.
 *
 * The identifier is included because it was already an EXACT match channel before this
 * module stopped folding labels, so keeping it removes nothing a caller could rely on. It
 * is safe to include precisely because comparison is `===`: the four identifiers are
 * distinct strings, so no observation can name two rows.
 *
 * @param check - the row.
 * @returns the names, compared with `===` at every call site.
 */
function namesFor(check: NodeIsolationCheck): readonly string[] {
  return [check.observationLabel, check.id, ...check.aliases];
}

/**
 * Finds the observations that name one row.
 *
 * Invariants locked here, and each replaces a way the previous matcher invented evidence:
 *
 *   1. EXACT comparison. Nothing is folded to alphanumerics and nothing is tested with
 *      `includes`, so an unrelated observation cannot claim a row by sharing a token with
 *      it. The `precondition: node2 ...` versus `denial: ... on node2` collision is the
 *      cautionary case and it is now impossible.
 *   2. ALL matches are returned, not the first. Multiplicity is the caller's decision to
 *      make, and it makes it by rejecting rather than by picking.
 *   3. Nothing is invented. A row nothing names resolves to `not-reported`.
 *
 * @param observations - `evidence.observations` as reported, or an empty list.
 * @param check - the row.
 * @returns every observation naming the row, in reported order.
 */
function observationsForCheck(
  observations: readonly ControlObservation[],
  check: NodeIsolationCheck,
): readonly ControlObservation[] {
  const names = namesFor(check);
  return observations.filter((observation) => names.includes(observation.label));
}

/**
 * Turns an HTTP status code into an {@link ObservedOutcome}.
 *
 * THIS FUNCTION IS THE BOUNDARY. 403 and 404 take separate branches and are
 * never merged, because a 404 cannot prove the restriction was enforced while a
 * 403 can. Any other refusal is `denied-unspecified`, which is also NOT a proof
 * of 403 — it merely records that something was refused.
 *
 * Codes outside 100-599, and 1xx/3xx codes, are `unreadable`: neither describes
 * a completed authorization decision, and guessing at one would be exactly the
 * kind of helpful reinterpretation this tier must not perform.
 */
function classifyStatusCode(code: number, raw: string): ObservedOutcome {
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return { kind: 'unreadable', raw };
  }
  if (code === 403) {
    return { kind: 'forbidden', httpStatus: code, raw };
  }
  if (code === 404) {
    return { kind: 'not-found', httpStatus: code, raw };
  }
  if (code >= 200 && code <= 299) {
    return { kind: 'allowed', httpStatus: code, raw };
  }
  if (code >= 400) {
    return { kind: 'denied-unspecified', httpStatus: code, raw };
  }
  return { kind: 'unreadable', raw };
}

/**
 * Matches a string that is NOTHING BUT a three-digit HTTP status code.
 *
 * Anchored at both ends, and that is the whole of the M8 fix. The superseded pattern was
 * `/\b([1-5]\d{2})\b/` — the FIRST three-digit run ANYWHERE in the text — which read a
 * status code out of prose that said the opposite of what the code alone implies:
 *
 *   * `expected 403 but got 200` -> 403 -> "denied with 403" -> SATISFIED. The sentence
 *     records a failure and was read as the requirement being met.
 *   * `403 Not Found` -> 403 -> SATISFIED, over a phrase naming the one status the V7
 *     ordering hazard exists to distinguish 403 FROM.
 *   * `HTTP 200 OK after 403 retries` -> 403 -> SATISFIED.
 *
 * A status code is a datum, not a narrative. If the server wants to report one it reports
 * the code, as this repository's own fixtures do; a sentence is not a measurement and is
 * now `unreadable`, which is indeterminate and never a denial.
 */
const EXACT_HTTP_STATUS_PATTERN = /^[1-5]\d{2}$/;

/**
 * The ONLY outcome words this panel reads, each matched as the WHOLE trimmed value.
 *
 * Whole-value, folded through {@link normalizeOutcomeWord}, so `Forbidden`, `forbidden`
 * and `FORBIDDEN` are one token while `not forbidden` is not that token at all. The
 * superseded reader used `includes('forbidden')` over a label-style fold, and
 * `notforbidden` contains `forbidden`: a negation was read as its own positive, so
 * `not forbidden` — a phrase stating the denial did NOT happen — satisfied the denial.
 *
 * Negation is not handled by listing negations, because that is the trap the substring
 * reader fell into: every negation a vocabulary knows about is a negation an attacker
 * phrases differently. Instead, ANY value that is not exactly one of these tokens is
 * `unreadable`. `not forbidden`, `possibly forbidden`, `forbidden?` and
 * `forbidden (see note)` are then all indeterminate — which is the honest reading of each
 * of them, and none of them can establish a denial.
 */
const EXACT_OUTCOME_TOKENS: Readonly<Record<string, ObservedOutcome['kind']>> = Object.freeze({
  forbidden: 'forbidden',
  notfound: 'not-found',
  allowed: 'allowed',
  denied: 'denied-unspecified',
});

/**
 * Folds a VALUE to an outcome-word key: lower case, internal whitespace removed, and
 * NOTHING ELSE.
 *
 * Deliberately weaker than a label-style fold, which strips every non-alphanumeric
 * character. That folding was right for labels — prose the server chose to name a row
 * with — and is WRONG for values, which are evidence. Stripping punctuation from a value
 * re-opens the hole the exact grammar closes: `forbidden?` folds to `forbidden` under it,
 * so a report EXPRESSING DOUBT about the outcome would establish it, and
 * `forbidden (see note)` would too. THIS WAS FOUND BY A SPECIFICATION, not by review: the
 * first draft of the exact grammar reused the label fold and was satisfied by `forbidden?`.
 *
 * The label fold itself is GONE. Rows are matched with `===` against their identity and
 * exact aliases, so nothing folds a label any more, and leaving an unused fold beside a
 * value grammar would invite its reintroduction.
 *
 * Whitespace alone is collapsed, because `Not Found` and `NotFound` are the two spellings
 * of one Kubernetes reason. Note the asymmetry that makes this safe: `not found` folds to
 * the NotFound token while `not forbidden` folds to `notforbidden`, which is no token at
 * all — so a two-word reason is read and a negation is not.
 */
function normalizeOutcomeWord(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, '');
}

/**
 * A serialized Kubernetes `Status`, the one structured form a denial may arrive in.
 *
 * The review's resolution allows "a narrowly specified serialized status object", and this
 * is that specification, deliberately narrow: an object literal carrying an integer `code`,
 * optionally beside a `reason`, and NOTHING is inferred from any other member. A `reason`
 * that disagrees with the `code` — `{"code":403,"reason":"NotFound"}` — is a CONTRADICTION
 * and is `unreadable`, because a report that says both cannot be believed about either.
 *
 * `kind` is checked when present: a serialized object that is not a `Status` is not a
 * denial record and is not read as one.
 */
interface SerializedStatus {
  readonly code: number;
  readonly reason?: string;
  readonly kind?: string;
}

/** Whether a parsed JSON value has the narrow {@link SerializedStatus} shape. */
function asSerializedStatus(parsed: unknown): SerializedStatus | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { code, reason, kind } = record;
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    return undefined;
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return undefined;
  }
  if (kind !== undefined && (typeof kind !== 'string' || normalizeOutcomeWord(kind) !== 'status')) {
    return undefined;
  }
  return { code, ...(reason === undefined ? {} : { reason }), ...(kind === undefined ? {} : { kind }) };
}

/**
 * Classifies a serialized `Status`, refusing any code/reason contradiction.
 *
 * The reason is only ever used to CONTRADICT the code, never to supply an outcome the code
 * did not carry. That asymmetry is deliberate: a code is an unambiguous datum and a reason
 * is a word, so the word can withhold trust from the datum but cannot create it.
 */
function classifySerializedStatus(status: SerializedStatus, raw: string): ObservedOutcome {
  const byCode = classifyStatusCode(status.code, raw);
  if (status.reason === undefined) {
    return byCode;
  }
  const byReason = EXACT_OUTCOME_TOKENS[normalizeOutcomeWord(status.reason)];
  if (byReason === undefined || byReason !== byCode.kind) {
    return { kind: 'unreadable', raw };
  }
  return byCode;
}

/**
 * Classifies one reported observation value.
 *
 * Accepts every member of `ControlObservation['value']`, because the hook module
 * surfaces whatever the server sent verbatim and a panel that only understood
 * numbers would silently discard the rest:
 *
 *   - `null` is meaningful rather than missing (the hook module is explicit about
 *     this), but it does not describe an outcome, so it is `unreadable` and
 *     therefore indeterminate. It is never quietly treated as an allow.
 *   - a boolean is an allow/deny decision with no status code, so `false`
 *     becomes `denied-unspecified` — a refusal that CANNOT be shown to be a 403.
 *   - a number is a status code.
 *   - a string is searched for a status code first, on the untouched text, and
 *     only then matched by reason word. Negations are tested before their
 *     positive forms so that `not allowed` and `disallowed` cannot be read as
 *     allows by a substring match.
 *
 * Anything unrecognised is `unreadable`, never an allow and never a 403.
 */
function classifyObservedValue(value: string | number | boolean | null): ObservedOutcome {
  if (value === null) {
    return { kind: 'unreadable', raw: NULL_VALUE_LABEL };
  }
  if (typeof value === 'boolean') {
    return value
      ? { kind: 'allowed', raw: 'true' }
      : { kind: 'denied-unspecified', raw: 'false' };
  }
  if (typeof value === 'number') {
    return classifyStatusCode(value, String(value));
  }

  const raw = value.trim();
  if (raw === '') {
    return { kind: 'unreadable', raw: EMPTY_VALUE_LABEL };
  }

  // 1. THE WHOLE VALUE is a status code, or it is not a status code at all.
  if (EXACT_HTTP_STATUS_PATTERN.test(raw)) {
    return classifyStatusCode(Number(raw), raw);
  }

  // 2. A serialized Kubernetes `Status`, in the one narrow shape specified above. Tried
  //    before the word vocabulary because a JSON document is never an outcome word, and
  //    a parse failure simply falls through rather than being reported as a defect.
  // Either brace, so a JSON ARRAY enters this branch and is rejected by shape rather than
  // falling through to the word vocabulary. `[403]` reaches the same `unreadable` verdict
  // either way, but rejecting it HERE is the honest route: it is a serialized document that
  // is not a Status, which is a different fact from "not one of four words".
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: 'unreadable', raw };
    }
    const status = asSerializedStatus(parsed);
    return status === undefined
      ? { kind: 'unreadable', raw }
      : classifySerializedStatus(status, raw);
  }

  // 3. THE WHOLE VALUE is one of four outcome words, or it is unreadable. No substring
  //    search, so no negation, qualification or sentence can carry a denial, and no list
  //    of negations has to stay ahead of however the next report phrases one.
  const kind = EXACT_OUTCOME_TOKENS[normalizeOutcomeWord(raw)];
  if (kind === undefined) {
    return { kind: 'unreadable', raw };
  }
  if (kind === 'forbidden') {
    return { kind: 'forbidden', httpStatus: FORBIDDEN_STATUS, raw };
  }
  if (kind === 'not-found') {
    return { kind: 'not-found', httpStatus: NOT_FOUND_STATUS, raw };
  }
  return kind === 'allowed' ? { kind: 'allowed', raw } : { kind: 'denied-unspecified', raw };
}

/**
 * Compares what the oracle requires with what was observed.
 *
 * THE DECISIVE RULE, stated once and implemented once: for a check the oracle
 * requires to be DENIED, only `forbidden` is `satisfied`.
 *
 * A 404 IS A VIOLATION, NOT AN INDETERMINATE. This is the correction the finding named,
 * and the oracle settles it: `expectForbidden` (`node_test.go` L698-L703) asserts
 * `apierrors.IsForbidden(err)` and reports anything else -- a NotFound included -- with
 * `t.Errorf`. In Go a 404 here FAILS the test. Recording it as `indeterminate` softened a
 * Go failure into "cannot tell", which understates it: the recorded
 * `V7_NODE_RESTRICTION_NOT_FOUND` payload carries verdict `fail` for exactly this reason,
 * and a panel that floored only at `unknown` would have downgraded a server-reported
 * failure whenever the server was less certain than the evidence.
 *
 * A refusal whose status code was NOT reported stays `indeterminate`, and the difference
 * is real: a 404 is a known wrong answer, while an unspecified refusal is an unknown one.
 *
 * For a check the oracle requires to be ALLOWED, only `allowed` is `satisfied`
 * and every refusal is `violated`, mirroring `expectAllowed` (L1712-L1716), which accepts
 * nothing but `err == nil` and also reports with `t.Errorf`. A refusal on a positive
 * control is a real finding — it means the restriction is over-broad, or the whole stack
 * is failing closed — so it is reported as a violation rather than softened.
 */
function resolveCheckStatus(expectation: CheckExpectation, outcome: ObservedOutcome): CheckStatus {
  if (outcome.kind === 'not-reported') {
    return 'not-reported';
  }
  if (outcome.kind === 'unreadable' || outcome.kind === 'inconsistent') {
    return 'indeterminate';
  }
  if (expectation === 'denied') {
    if (outcome.kind === 'forbidden') {
      return 'satisfied';
    }
    if (outcome.kind === 'allowed' || outcome.kind === 'not-found') {
      return 'violated';
    }
    // Only 'denied-unspecified' lands here: refused, but not shown to be a 403.
    return 'indeterminate';
  }
  return outcome.kind === 'allowed' ? 'satisfied' : 'violated';
}

/** One fully resolved table row: the requirement, the evidence and the outcome. */
interface ResolvedCheck {
  readonly check: NodeIsolationCheck;
  readonly observation?: ControlObservation;
  readonly outcome: ObservedOutcome;
  readonly status: CheckStatus;
}

/**
 * Resolves all four rows against the evidence the server reported.
 *
 * All four rows are always produced, in the oracle's own order, so a row the server
 * omitted renders as `not-reported` rather than disappearing. Multiplicity is rejected
 * here rather than resolved: two observations naming one row yield `inconsistent`.
 *
 * @param observations - `evidence.observations` as reported, or an empty list.
 * @returns one resolved row per check.
 */
function resolveChecks(observations: readonly ControlObservation[]): readonly ResolvedCheck[] {
  return NODE_ISOLATION_CHECKS.map((check) => {
    const matches = observationsForCheck(observations, check);
    if (matches.length > 1) {
      const outcome: ObservedOutcome = { kind: 'inconsistent', count: matches.length };
      return { check, outcome, status: resolveCheckStatus(check.expectation, outcome) };
    }
    const [observation] = matches;
    const outcome: ObservedOutcome =
      observation === undefined
        ? { kind: 'not-reported' }
        : classifyObservedValue(observation.value);
    return { check, observation, outcome, status: resolveCheckStatus(check.expectation, outcome) };
  });
}

/**
 * Ordering of verdicts from most to least favourable, used only to pick the
 * least favourable of several. `pass` is best and `fail` worst; `unknown` ranks
 * below `warn` because a warning is a KNOWN outcome whereas an unknown is an
 * absence of proof, and this panel must never present an absence of proof as
 * something better than a known objection.
 */
const VERDICT_SEVERITY: Readonly<Record<ControlVerdict, number>> = {
  pass: 0,
  warn: 1,
  unknown: 2,
  fail: 3,
};

/** Returns whichever of two verdicts is the less favourable. */
function leastFavourable(left: ControlVerdict, right: ControlVerdict): ControlVerdict {
  return VERDICT_SEVERITY[left] >= VERDICT_SEVERITY[right] ? left : right;
}

/**
 * Reconciles the verdict the server reported with the evidence it sent.
 *
 * The reconciliation is MONOTONE AND DOWNWARD ONLY. The verdict can be made less
 * favourable by contradicting evidence and can never be made more favourable, so
 * this function is incapable of manufacturing a pass. That is what makes it safe
 * to run over data this client does not control.
 *
 *   - any `violated` row floors the verdict at `fail`, which is how an observed 404 or an
 *     allowed cross-node write stops a reported pass from ever reaching the screen;
 *   - any `indeterminate` row floors it at `unknown`;
 *   - any `not-reported` row floors it at `unknown` — see below;
 *   - a non-empty `findings` list floors it at `fail`, since a finding is by
 *     definition a reported violation;
 *   - a non-empty `warnings` list floors it at `warn`, which is the hook
 *     module's own documented reading of a permitted-but-objected-to operation.
 *
 * A `not-reported` ROW NOW FLOORS THE VERDICT AT `unknown`, and the previous asymmetry was
 * the defect. The old reasoning was that absence of evidence is not contradicting
 * evidence, which is true — and beside the point. The question is not whether silence
 * contradicts the server's claim; it is whether silence SUPPORTS it. A payload that
 * asserted `pass` while measuring none of the four checks rendered a clean bill of health
 * for a control nobody had evaluated, which is the single most dangerous output this panel
 * can produce.
 *
 * AAP §0.7.2 settles it: assertion density is part of the contract, and V7 keeps ALL FOUR
 * of its assertions — two denials and two positive controls. A report that made fewer than
 * four has not made them, so `unknown` is the honest answer. Note the floor is `unknown`
 * and NOT `fail`: the panel does not know the control is broken, it knows it cannot tell,
 * and inventing a defect would be as untruthful as inventing a pass.
 *
 * The function remains MONOTONE AND DOWNWARD ONLY, so it still cannot manufacture a pass.
 */
function resolveEffectiveVerdict(
  reported: ControlVerdict,
  checks: readonly ResolvedCheck[],
  configRequirements: readonly ResolvedConfigRequirement[],
  findings: readonly ControlFinding[],
  warnings: readonly string[],
): ControlVerdict {
  let verdict = reported;
  if (checks.some((resolved) => resolved.status === 'violated')) {
    verdict = leastFavourable(verdict, 'fail');
  }
  if (checks.some((resolved) => resolved.status === 'indeterminate')) {
    verdict = leastFavourable(verdict, 'unknown');
  }
  if (checks.some((resolved) => resolved.status === 'not-reported')) {
    verdict = leastFavourable(verdict, 'unknown');
  }
  // M16 — THE ENABLING CONFIGURATION IS PART OF THE VERDICT, on the same monotone,
  // downward-only terms as everything else. A configuration reported WRONG floors at
  // `fail` because the control is then not enforced; a configuration nobody reported
  // floors at `unknown` because F-007-RQ-001 is claimed and unmeasured.
  if (configRequirements.some((requirement) => requirement.status === 'violated')) {
    verdict = leastFavourable(verdict, 'fail');
  }
  if (
    configRequirements.some(
      (requirement) =>
        requirement.status === 'indeterminate' || requirement.status === 'not-reported',
    )
  ) {
    verdict = leastFavourable(verdict, 'unknown');
  }
  if (findings.length > 0) {
    verdict = leastFavourable(verdict, 'fail');
  }
  if (warnings.length > 0) {
    verdict = leastFavourable(verdict, 'warn');
  }
  return verdict;
}

/**
 * The panel's own conservative verdict for V7, as one call over one payload.
 *
 * Exported for the same reason V1's is: the aggregate dashboard must count, filter and
 * summarise the verdict this panel RENDERS rather than the raw `status.verdict` the server
 * sent, so a badge and the count beside it cannot disagree.
 *
 * `strictestVerdict` combines the single derived verdict through the one shared
 * combination function, so every control's resolver agrees on what "strongest claim"
 * means rather than each implementing its own ordering.
 *
 * @param control - the payload for V7, or `undefined` when it was not reported. An absent
 *   payload yields `unknown`, never a pass.
 * @returns the verdict this panel renders.
 */
export function resolveNodeIsolationEffectiveVerdict(
  control: ControlStatus | undefined,
): ControlVerdict {
  if (control === undefined) {
    return 'unknown';
  }
  const observations = control.evidence?.observations ?? [];
  const checks = resolveChecks(observations);
  const configRequirements = resolveConfigRequirements(observations);
  return strictestVerdict([
    resolveEffectiveVerdict(
      control.verdict,
      checks,
      configRequirements,
      control.findings,
      control.warnings,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Presentation vocabulary.
//
// One deliberate lexical rule governs everything below, and it is what makes the
// mandated regression check decisive: THE WORD "PASS" APPEARS IN THE RENDERED
// OUTPUT ONLY AS THE LABEL OF A PASSING VERDICT. Per-check outcomes are
// "Satisfied", never "Passed"; no explanatory sentence, heading, caption or
// state message contains the sequence anywhere. Feeding a 404-shaped payload
// through this component therefore removes every occurrence of it from the DOM,
// so "the pass affordance is absent" is directly and unambiguously observable.
//
// There is also no colour and no icon in this module, so no meaning is ever
// carried by colour alone: every outcome is stated in words.
// ---------------------------------------------------------------------------

/** Heading, and therefore the accessible name of the panel's landmark. */
const PANEL_HEADING = 'V7 — Node isolation (NodeRestriction)';

/** Human-readable name of each verdict. */
const VERDICT_LABELS: Readonly<Record<ControlVerdict, string>> = {
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Warning',
  unknown: 'Unknown',
};

/** One sentence saying what each verdict means for this control. */
const VERDICT_EXPLANATIONS: Readonly<Record<ControlVerdict, string>> = {
  pass: 'every reported outcome matches the node scoping this control requires.',
  fail: 'at least one reported outcome contradicts the node scoping this control requires.',
  warn: 'the reported outcomes hold, and the server raised at least one warning.',
  unknown: 'the reported evidence does not establish that the restriction was enforced.',
};

/** Human-readable name of each per-check status. */
const CHECK_STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  satisfied: 'Satisfied',
  violated: 'Violated',
  indeterminate: 'Indeterminate',
  'not-reported': 'Not reported',
};

/** Human-readable name of each enabling-configuration status. */
const CONFIG_STATUS_LABELS: Readonly<Record<ConfigStatus, string>> = {
  satisfied: 'Satisfied',
  violated: 'Violated',
  indeterminate: 'Indeterminate',
  'not-reported': 'Not reported',
};

/** Accessible name of the enabling-configuration table. */
const CONFIG_TABLE_CAPTION =
  'Enabling configuration the reported outcomes depend on, and what was reported for each';

/** The requirement the enabling configuration answers to. */
const ENABLING_REQUIREMENT_ID = 'F-007-RQ-001';

/** Substituted for a summary that sanitized away to nothing. */
const WITHHELD_SUMMARY = 'The check reported a verdict whose summary could not be displayed.';

/** Substituted for a finding whose message sanitized away to nothing. */
const WITHHELD_FINDING_MESSAGE =
  'The check reported a finding whose message could not be displayed.';

/** Substituted for a failure message that sanitized away to nothing. */
const WITHHELD_ERROR_MESSAGE = 'The check reported a failure whose message could not be displayed.';

/**
 * Bounds a verdict summary, substituting local wording when nothing survives.
 *
 * An empty string is not an acceptable rendering of a verdict: the reader would see the
 * verdict badge over a blank line and could not tell a withheld summary from a server that
 * chose to say nothing. Both cases now say which one they are.
 */
function safeSummary(summary: string): string {
  const bounded = safeProse(summary);
  return bounded === '' ? WITHHELD_SUMMARY : bounded;
}

/** Bounds a failure message, substituting local wording when nothing survives. */
function safeErrorMessage(message: string): string {
  const bounded = safeProse(message);
  return bounded === '' ? WITHHELD_ERROR_MESSAGE : bounded;
}

/**
 * The rendered explanation the boundary requires whenever a NotFound is observed
 * on a check that must be denied.
 */
const NOT_FOUND_EXPLANATION =
  'A 404 Not Found cannot establish that the restriction was enforced: the object may simply ' +
  'have been absent, and an absent object masks the 403 Forbidden this requirement depends on. ' +
  'It is recorded as a VIOLATED check, because the oracle’s expectForbidden asserts the error ' +
  'is Forbidden and reports anything else — a NotFound included — as a failure. The check has ' +
  'to be repeated with the target object present, which is why the oracle creates node2 first.';

/** The reading rules this panel applies, rendered so they are auditable on screen. */
const INTERPRETATION_NOTES: readonly string[] = [
  'Only a 403 Forbidden establishes an enforced denial. A 404 Not Found is recorded as a ' +
    'violation, because an absent object masks the decision entirely; a refusal whose status ' +
    'code was not reported is recorded as indeterminate, because it may or may not have been a ' +
    '403.',
  'An outcome is read only from a value that is ENTIRELY a status code, entirely one of the ' +
    'words Forbidden, NotFound, Allowed or Denied, or an object carrying an integer code whose ' +
    'reason agrees with it. A sentence is not a measurement: “expected 403 but got 200”, ' +
    '“403 Not Found” and “not forbidden” are each recorded as an unrecognised outcome, because ' +
    'reading a code or a word out of prose would let a report of failure satisfy a requirement.',
  'The enabling configuration is part of the verdict. The authorization mode must be exactly ' +
    'Node,RBAC and NodeRestriction must be a member of the enabled plugin list; either one ' +
    'reported wrong is a failure, and either one unreported holds the verdict at Unknown, ' +
    'because the outcomes below mean what this control claims only while both are in force.',
  'Every one of the four checks must be reported. A check nobody measured is recorded as not ' +
    'reported and holds the verdict at Unknown, however confident the server’s own verdict was: ' +
    'a report that made none of the four assertions has not made them.',
  'A check reported more than once is recorded as indeterminate rather than resolved by list ' +
    'order, so a verdict never depends on which duplicate happened to be serialised first.',
  'The two allowed rows are positive controls. They establish that the denials are targeted node ' +
    'scoping rather than a stack that refuses every request.',
  'An HTTP 403 returned by the posture endpoint itself is a failure to read posture, not an ' +
    'enforced denial. It is reported under “Posture unavailable” and can never become a verdict.',
  'A verdict reported by the server is only ever made less favourable by the evidence, never more ' +
    'favourable, so contradicting evidence cannot be overridden.',
];

/**
 * Renders one reported observation value for display.
 *
 * Guarantees that the literal text `null` or `undefined` is never emitted from
 * absent data: an explicit `null` — which the hook module documents as a
 * meaningful value rather than a missing one — becomes a phrase that says so,
 * and an empty string becomes a phrase that says that instead of rendering
 * nothing at all.
 */
function formatObservationValue(value: string | number | boolean | null): string {
  if (value === null) {
    return NULL_VALUE_LABEL;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  const trimmed = value.trim();
  return trimmed === '' ? EMPTY_VALUE_LABEL : trimmed;
}

/**
 * Renders a classified outcome.
 *
 * The status code is always shown when one was observed, because the whole
 * distinction this panel exists to preserve is a distinction between codes. The
 * two refusal outcomes that prove nothing are worded so that they cannot be
 * mistaken for the one that proves something.
 */
function describeOutcome(outcome: ObservedOutcome): string {
  switch (outcome.kind) {
    case 'allowed':
      return outcome.httpStatus === undefined
        ? `Allowed (${safeObservationValue(outcome.raw)})`
        : `Allowed with HTTP ${outcome.httpStatus}`;
    case 'forbidden':
      return `Denied with HTTP ${outcome.httpStatus} Forbidden`;
    case 'not-found':
      return `Denied with HTTP ${outcome.httpStatus} Not Found`;
    case 'denied-unspecified':
      return outcome.httpStatus === undefined
        ? `Denied, status code not reported (${safeObservationValue(outcome.raw)})`
        : `Denied with HTTP ${outcome.httpStatus}`;
    case 'unreadable':
      // M18, AND THE CHANNEL THE M8 FIX WIDENED. Tightening the grammar sends strictly
      // MORE server text down this branch — every sentence, negation and qualification
      // that used to be read as an outcome now arrives here to be echoed back — so the
      // one branch that renders arbitrary wire text is also the one that most needed
      // bounding. `raw` is the server's own string in every case but two, where it is a
      // local label for null or empty.
      return `Unrecognised outcome (${safeObservationValue(outcome.raw)})`;
    case 'inconsistent':
      return (
        `Reported ${String(outcome.count)} times — which outcome is authoritative cannot ` +
        'be determined, so none is treated as one'
      );
    case 'not-reported':
      // Deliberately worded differently from CHECK_STATUS_LABELS['not-reported'].
      // The two columns state the same fact from different angles — what was
      // observed, and how the check therefore stands — and giving them identical
      // text would put two indistinguishable cells in one row, which is both
      // redundant to read and ambiguous to address.
      return 'No outcome reported';
  }
}

/**
 * Flattens a finding into a single sentence, so it is one addressable text node.
 *
 * All three members are server prose and all three are bounded (M18). The message goes
 * through {@link safeProse} because it is a sentence; the subject and requirement
 * identifier go through {@link safeLabel} because they are short identifiers and a
 * sentence-length bound would let one crowd the finding it belongs to. Sanitizing FIRST
 * and testing emptiness afterwards matters: a subject that is nothing but control
 * characters is empty evidence, and appending `subject: ` to it would state a fact the
 * report did not contain.
 */
function describeFinding(finding: ControlFinding): string {
  const message = safeProse(finding.message);
  const parts: string[] = [message === '' ? WITHHELD_FINDING_MESSAGE : message];
  const subject = finding.subject === undefined ? '' : safeLabel(finding.subject);
  if (subject !== '') {
    parts.push(`subject: ${subject}`);
  }
  const requirementId =
    finding.requirementId === undefined ? '' : safeLabel(finding.requirementId);
  if (requirementId !== '') {
    parts.push(`requirement: ${requirementId}`);
  }
  return parts.join(' — ');
}

/**
 * Headline for a transport or contract failure.
 *
 * Every branch names the endpoint rather than the control, which is the
 * distinction the wording exists to draw: this is a failure to READ posture, not
 * an observed authorization decision.
 */
function describeErrorHeadline(error: ControlStatusError): string {
  if (error.kind === 'network') {
    return 'No response was received for the V7 posture request.';
  }
  if (error.kind === 'payload') {
    return 'The V7 posture response could not be read as posture data.';
  }
  return error.httpStatus === undefined
    ? 'The request for V7 posture was refused.'
    : `The request for V7 posture returned HTTP ${error.httpStatus}.`;
}

/**
 * Keeps the two meanings of a status code apart, in the rendered text.
 *
 * This is the sentence that stops the panel from conflating them:
 *
 *   * an HTTP 403 HERE means this client may not read the posture endpoint. It
 *     is NOT the observed 403 Forbidden that establishes cross-node denial, and
 *     it must never be reported as a verdict of any kind;
 *   * an HTTP 404 HERE means the posture endpoint itself was not found. It is
 *     unrelated to the 404 that would mask a Forbidden result on a Node object.
 *
 * Both are returned as extra sentences appended to the generic explanation, so
 * whichever arrives, the reader is told which 403 or 404 they are looking at.
 */
function describeErrorDisambiguation(error: ControlStatusError): readonly string[] {
  const sentences: string[] = [
    'This is a failure to read the posture endpoint, not an enforced denial, so no verdict is ' +
      'shown for V7.',
  ];
  if (error.httpStatus === 403) {
    sentences.push(
      'An HTTP 403 on the posture endpoint means this client may not read it. It is not the ' +
        'observed 403 Forbidden that establishes cross-node denial.',
    );
  }
  if (error.httpStatus === 404) {
    sentences.push(
      'An HTTP 404 on the posture endpoint means the endpoint itself was not found. It is ' +
        'unrelated to the 404 that would mask a Forbidden result on a Node object.',
    );
  }
  return sentences;
}

/**
 * The panel's rendering state: exactly the hook's discriminated union with the
 * `refresh` handle removed.
 *
 * Derived with `Omit` from the hook module's own arms rather than restated, so it
 * cannot drift away from them — the same technique the hook uses for its internal
 * snapshot type. Removing `refresh` is what lets a caller drive the panel from a
 * plain pre-resolved payload without having to fabricate a callback.
 */
type NodeIsolationPanelState =
  | Omit<ControlStatusLoadingResult, 'refresh'>
  | Omit<ControlStatusSuccessResult, 'refresh'>
  | Omit<ControlStatusErrorResult, 'refresh'>;

/**
 * Props of {@link NodeIsolationPanel}. Every member is optional, so
 * `<NodeIsolationPanel />` is valid and self-driving.
 */
export interface NodeIsolationPanelProps {
  /**
   * A pre-resolved hook result. Supplying it suppresses the internal request
   * entirely, which is how loading, empty and error states are rendered without
   * any transport. Takes precedence over {@link NodeIsolationPanelProps.status}.
   */
  readonly result?: UseControlStatusResult;
  /**
   * A single pre-resolved payload, wrapped internally as a successful result
   * carrying just this control. Convenient when only the success state matters.
   */
  readonly status?: ControlStatus;
  /**
   * Handler for the refresh control, REPLACING the `refresh` handle of whichever
   * result is driving the panel rather than running alongside it, so one press is
   * one request. In the externally controlled case — a bare `status` and no handler
   * — there is genuinely nothing to re-request, so the button is rendered but
   * DISABLED with a title saying why; supply this prop to opt in to the interaction.
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

/** Renders the loading affordance. */
function renderLoading(): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <p className="node-isolation-panel__loading" role={liveStatusRole} aria-label="Loading V7 posture">
      Loading the V7 node-isolation posture…
    </p>
  );
}

/**
 * Renders the error affordance.
 *
 * `role={liveAlertRole}` because a failure to read posture is exactly the kind of change
 * a reader must not miss. It carries no verdict, and it structurally cannot: the
 * hook module's error arm has no `controls` member, so there is nothing here that
 * could be mistaken for one.
 */
function renderError(error: ControlStatusError): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). See the note on the status role above.
  const liveAlertRole = useLiveRegionRole('alert');
  const label =
    error.httpStatus === undefined
      ? 'V7 posture unavailable'
      : `V7 posture unavailable — HTTP ${error.httpStatus}`;
  return (
    <div className="node-isolation-panel__error" role={liveAlertRole} aria-label={label}>
      {/*
        The headline and the disambiguation sentences are LOCALLY AUTHORED from `kind` and
        `httpStatus` — a typed union and a number — so they are unconditional and are
        deliberately not guarded. The message and the reason are the server's own text and
        both are bounded (M18); guarding the two that are external and leaving the two that
        are local alone is what keeps a redaction marker from ever standing alone.
      */}
      <p className="node-isolation-panel__error-headline">{describeErrorHeadline(error)}</p>
      <p className="node-isolation-panel__error-message">{safeErrorMessage(error.message)}</p>
      {error.reason !== undefined && error.reason !== '' ? (
        <p className="node-isolation-panel__error-reason">
          {`Server reason: ${describeStatusReason(error.reason)}`}
        </p>
      ) : null}
      {describeErrorDisambiguation(error).map((sentence) => (
        <p className="node-isolation-panel__error-note" key={sentence}>
          {sentence}
        </p>
      ))}
    </div>
  );
}

/**
 * Renders the empty affordance.
 *
 * Two genuinely different absences are worded differently, because they point at
 * different problems: a server that reported no posture at all, and a server that
 * reported posture for other controls but not for this one. The hook module is
 * explicit that the second must be rendered as empty or unknown and never as a
 * pass, which is why no verdict element exists on this path.
 */
function renderEmpty(isEmpty: boolean): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <p className="node-isolation-panel__empty" role={liveStatusRole} aria-label="V7 posture not reported">
      {isEmpty
        ? 'The server reported no control posture at all, so there is nothing to show for V7.'
        : 'The server reported posture for other controls but not for V7, so no V7 verdict is shown.'}
    </p>
  );
}

/** Renders the success affordance: the reconciled verdict and all four outcomes. */
function renderSuccess(control: ControlStatus): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  const observations = control.evidence?.observations ?? [];
  const checks = resolveChecks(observations);
  const configRequirements = resolveConfigRequirements(observations);
  const verdict = resolveEffectiveVerdict(
    control.verdict,
    checks,
    configRequirements,
    control.findings,
    control.warnings,
  );
  const sawNotFound = checks.some((resolved) => resolved.outcome.kind === 'not-found');
  const claimed = new Set<ControlObservation>(
    checks
      .map((resolved) => resolved.observation)
      .filter((observation): observation is ControlObservation => observation !== undefined),
  );
  // The two enabling-configuration identities are CLAIMED now, so they leave "Other
  // reported observations" and appear in a table that states what each must be. Leaving
  // them in the generic list was the visible half of M16: rendered, unread, and beside
  // observations nothing gates.
  const configIdentities = new Set(
    configRequirements.map((requirement) => requirement.observationLabel),
  );
  const otherObservations = observations.filter(
    (observation) => !claimed.has(observation) && !configIdentities.has(observation.label),
  );

  return (
    <div className="node-isolation-panel__body">
      <p
        className="node-isolation-panel__verdict"
        role={liveStatusRole}
        aria-label={`V7 verdict: ${VERDICT_LABELS[verdict]}`}
      >
        {'Verdict: '}
        <strong>{VERDICT_LABELS[verdict]}</strong>
        {` — ${VERDICT_EXPLANATIONS[verdict]}`}
      </p>

      <p className="node-isolation-panel__summary">{safeSummary(control.summary)}</p>
      {control.detail !== undefined && control.detail !== '' ? (
        <p className="node-isolation-panel__detail">{safeProse(control.detail)}</p>
      ) : null}

      {/*
        THE ENABLING CONFIGURATION FIRST, because it is the precondition of everything
        below it: the four runtime outcomes mean what this control claims they mean only
        while the Node authorizer and the NodeRestriction plugin are both in force.
      */}
      <table className="node-isolation-panel__config">
        <caption>{CONFIG_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            <th scope="col">Requirement</th>
            <th scope="col">Covers</th>
            <th scope="col">Required</th>
            <th scope="col">Reported</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {configRequirements.map((requirement) => (
            <tr key={requirement.id} data-config={requirement.id} data-status={requirement.status}>
              <th scope="row">{requirement.title}</th>
              <td>{ENABLING_REQUIREMENT_ID}</td>
              <td>{requirement.required}</td>
              <td>{requirement.observed}</td>
              <td>{CONFIG_STATUS_LABELS[requirement.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="node-isolation-panel__checks">
        <caption>Observed NodeRestriction outcomes for the node1 identity</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Requirement</th>
            <th scope="col">Expected</th>
            <th scope="col">Observed</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {checks.map(({ check, outcome, status }) => (
            <tr key={check.id}>
              <th scope="row">
                {check.isPositiveControl ? `${check.title} (positive control)` : check.title}
              </th>
              <td>{check.requirementId}</td>
              <td>{check.expectationLabel}</td>
              <td>{describeOutcome(outcome)}</td>
              <td>{CHECK_STATUS_LABELS[status]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {sawNotFound ? (
        <p
          className="node-isolation-panel__not-found-note"
          role="note"
          aria-label="Not Found outcomes cannot establish enforcement"
        >
          {NOT_FOUND_EXPLANATION}
        </p>
      ) : null}

      <Subheading className="node-isolation-panel__subheading">Reported findings</Subheading>
      {control.findings.length === 0 ? (
        <p className="node-isolation-panel__no-findings">No findings were reported for V7.</p>
      ) : (
        <ul className="node-isolation-panel__findings" aria-label="V7 findings">
          {control.findings.map((finding, index) => (
            <li key={`${finding.subject ?? 'control'}-${String(index)}`}>
              {describeFinding(finding)}
            </li>
          ))}
        </ul>
      )}

      <Subheading className="node-isolation-panel__subheading">Server warnings</Subheading>
      {control.warnings.length === 0 ? (
        <p className="node-isolation-panel__no-warnings">No warnings were reported for V7.</p>
      ) : (
        <ul className="node-isolation-panel__warnings" aria-label="V7 warnings">
          {control.warnings.map((warning, index) => (
            <li key={`${warning}-${String(index)}`}>{safeProse(warning)}</li>
          ))}
        </ul>
      )}

      <Subheading className="node-isolation-panel__subheading">Why each outcome is required</Subheading>
      <ul className="node-isolation-panel__rationale" aria-label="V7 outcome rationale">
        {configRequirements.map((requirement) => (
          <li key={requirement.id}>{`${requirement.title}: ${requirement.note}`}</li>
        ))}
        {NODE_ISOLATION_CHECKS.map((check) => (
          <li key={check.id}>{`${check.title}: ${check.note}`}</li>
        ))}
      </ul>

      <Subheading className="node-isolation-panel__subheading">How this panel reads the evidence</Subheading>
      <ul className="node-isolation-panel__notes" aria-label="V7 interpretation notes">
        {INTERPRETATION_NOTES.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      {otherObservations.length > 0 ? (
        <>
          <Subheading className="node-isolation-panel__subheading">Other reported observations</Subheading>
          <ul
            className="node-isolation-panel__other-observations"
            aria-label="V7 additional observations"
          >
            {/*
              BOTH HALVES ARE SERVER-CHOSEN (M18). This list renders whatever the report
              carried that nothing above claimed, so it is the one place where an
              unrecognised label and an unrecognised value are rendered side by side — the
              broadest echo channel in the panel and the one a credential is most likely to
              reach. The label is bounded as an identifier and the value as a value.
            */}
            {otherObservations.map((observation, index) => (
              <li key={`${observation.label}-${String(index)}`}>
                {`${safeLabel(observation.label)}: ${safeObservationValue(
                  formatObservationValue(observation.value),
                )}`}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {control.observedAt !== undefined && control.observedAt !== '' ? (
        <p className="node-isolation-panel__observed-at">
          {`Evaluated at ${safeLabel(control.observedAt)}`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Chooses the affordance for the current state.
 *
 * Written with early returns rather than nested conditional expressions so that
 * the narrowing is obvious at a glance, and so that the "no verdict without a
 * payload" ordering — loading, then error, then absent control, then success — is
 * the literal reading order of the function.
 */
function renderBody(
  state: NodeIsolationPanelState,
  control: ControlStatus | undefined,
): ReactElement {
  if (state.status === 'loading') {
    return renderLoading();
  }
  if (state.status === 'error') {
    return renderError(state.error);
  }
  if (control === undefined) {
    return renderEmpty(state.isEmpty);
  }
  return renderSuccess(control);
}

/** Props of the pure presentational component. */
interface NodeIsolationPanelViewProps {
  readonly state: NodeIsolationPanelState;
  readonly onRefresh?: () => void;
}

/**
 * The pure presentation of V7 posture. Given a state it renders a panel; it
 * performs no transport of any kind and holds no state of its own.
 *
 * The landmark is a `<section>` named by its own `<h2>`, which is what gives it
 * the `region` role with an accessible name. `region`, `status`, `alert` and
 * `note` are none of them name-from-content roles, so each of those elements
 * carries an explicit label; that is the one place ARIA is used here, and it is
 * used because native semantics genuinely cannot supply the name.
 *
 * Exactly one live-region element exists per state — the verdict on success, the
 * message on loading and on empty, the alert on error — so a role lookup is never
 * ambiguous.
 */
function NodeIsolationPanelView({ state, onRefresh }: NodeIsolationPanelViewProps): ReactElement {
  // EMBEDDED-AWARE OWN HEADING (m3), bound once for this component.
  const rendersOwnHeading = useRendersOwnHeading();
  const headingId = useId();
  const control =
    state.status === 'success' ? selectControlStatus(state.controls, V7_CONTROL_ID) : undefined;
  const reportedRequirementIds = control?.requirementIds;
  // BOUNDED BEFORE EMPTINESS IS TESTED (M18). A reported identifier is server prose that
  // reaches the panel HEADER, above every state affordance, so it is the most prominent
  // echo channel of all. Guarding first and filtering afterwards means a list of
  // identifiers that all sanitize away falls back to this panel's own literals rather than
  // rendering "Requirements covered: " over nothing.
  const guardedRequirementIds = (reportedRequirementIds ?? [])
    .map((identifier) => safeLabel(identifier))
    .filter((identifier) => identifier !== '');
  const requirementIds =
    guardedRequirementIds.length > 0 ? guardedRequirementIds : V7_REQUIREMENT_IDS;
  // EMBEDDED-AWARE REGION NAME (m3). The region is named by whichever heading exists: this
  // panel's own when standalone, the dashboard's control heading when embedded. Without this
  // an embedded panel would point `aria-labelledby` at an id it no longer renders, leaving a
  // region with no accessible name at all.
  const panelLabelId = usePanelLabelId(headingId);

  return (
    <section
      className="node-isolation-panel"
      aria-labelledby={panelLabelId}
      aria-busy={state.status === 'loading'}
    >
      <header className="node-isolation-panel__header">
        {/*
          EMBEDDED-AWARE OWN HEADING (m3). See embeddedPanel.tsx: embedded, the dashboard has
          already named this control, so a second title would duplicate the name and restart
          the heading run above its own level.
        */}
        {rendersOwnHeading ? (
          <h2 className="node-isolation-panel__heading" id={headingId}>
            {PANEL_HEADING}
          </h2>
        ) : null}
        <p className="node-isolation-panel__requirements">
          {`Requirements covered: ${requirementIds.join(', ')}`}
        </p>
        {/*
          BLITZY [A11Y]: measured in headless Chrome at a 1280x900 viewport, this
          button renders at 130.84 x 21 CSS px, so its height is below the 24 px
          minimum of WCAG 2.2 SC 2.5.8 (Target Size, Minimum) and well below the
          44 px commonly recommended for touch. That is a direct and unavoidable
          consequence of a higher-precedence requirement rather than an oversight:
          AAP §0.4.2.4 and this file's brief mandate "plain, accessible, semantic
          markup only ... no design system, no CSS framework, no icon library",
          and this module accordingly authors NO CSS, so the box is entirely the
          user agent's default for a text button. Enlarging it would require
          either an inline style (forbidden) or a stylesheet this workstream is
          not scoped to create — and `web/vitest.config.ts` sets `css: false`, so
          such a stylesheet would not even be loaded by the suite that validates
          this component. The rendered output is therefore left exactly as the
          requirement dictates and the shortfall is flagged here for designer
          review, rather than silently auto-corrected.

          What IS satisfied, and was verified at run time: the control is a native
          <button>, it is reachable by Tab alone, it is activated by BOTH Enter and
          Space, it carries the accessible name "Refresh V7 posture" computed from
          its own text content, and it shows the native focus indicator — a 2 px
          rgb(16,16,16) ring from `outline-style: auto` — because nothing here
          overrides :focus-visible.
        */}
        <button
          className="node-isolation-panel__refresh"
          type="button"
          onClick={onRefresh}
          disabled={onRefresh === undefined}
          title={onRefresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
        >
          Refresh V7 posture
        </button>
      </header>
      {renderBody(state, control)}
    </section>
  );
}

/**
 * The self-driving arm: reads V7 posture through the shared hook.
 *
 * This exists as a separate component rather than as a branch inside
 * {@link NodeIsolationPanel} because a hook may not be called conditionally.
 * Selecting between two component types is the supported way to make a data
 * source optional, and it keeps the promise that a pre-resolved caller issues no
 * request at all.
 */
function NodeIsolationPanelConnected({
  onRefresh,
  canRefresh = true,
}: {
  readonly onRefresh?: () => void;
  readonly canRefresh?: boolean;
}): ReactElement {
  const result = useControlStatus(V7_CONTROL_ID);
  return (
    <NodeIsolationPanelView
      state={result}
      onRefresh={resolveRefreshHandler(onRefresh, result.refresh, canRefresh)}
    />
  );
}

/**
 * Posture panel for V7, NodeRestriction / node isolation.
 *
 * Renders the four outcomes `TestNodeRestrictionCrossNodeDenied` asserts, and
 * locks the invariant that cross-node mutation is denied with 403 Forbidden while
 * a node's own Node object stays readable and updatable — with a 404 NotFound
 * never counting as a pass, because NotFound would mask Forbidden.
 *
 * Three ways to drive it, chosen by which props are supplied:
 *
 * ```tsx
 * <NodeIsolationPanel />                                  // reads its own data
 * <NodeIsolationPanel result={useControlStatus('V7')} />   // caller-owned state
 * <NodeIsolationPanel status={payload} onRefresh={fn} />   // one payload
 * ```
 *
 * Switching a mounted instance between the self-driving and pre-resolved forms
 * changes which component type is rendered and therefore remounts the subtree.
 * That is intended: the two forms differ in whether a request is issued, and
 * quietly carrying state across that boundary would hide the difference.
 */
export default function NodeIsolationPanel({
  result,
  status,
  onRefresh,
  canRefresh = true,
}: NodeIsolationPanelProps = {}): ReactElement {
  if (result !== undefined) {
    return (
      <NodeIsolationPanelView
        state={result}
        onRefresh={resolveRefreshHandler(onRefresh, result.refresh, canRefresh)}
      />
    );
  }
  if (status !== undefined) {
    // A payload handed over directly owns no request, so ONLY an explicit handler can
    // refresh it; without one the affordance is disabled and explained.
    return (
      <NodeIsolationPanelView
        state={{ status: 'success', controls: [status], isEmpty: false }}
        onRefresh={resolveRefreshHandler(onRefresh, undefined, canRefresh)}
      />
    );
  }
  return <NodeIsolationPanelConnected onRefresh={onRefresh} canRefresh={canRefresh} />;
}
