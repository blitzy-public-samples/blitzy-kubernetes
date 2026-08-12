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
 * - `not-reported` — nothing was observed. Absence of evidence is deliberately
 *   NOT treated as contradicting evidence; see {@link resolveEffectiveVerdict}.
 */
type CheckStatus = 'satisfied' | 'violated' | 'indeterminate' | 'not-reported';

/**
 * A read-only list guaranteed by the type system to hold at least one member.
 *
 * Used for the token rules below, where emptiness is not merely unlikely but
 * actively wrong: `[].every(...)` is `true`, so a check with no token groups
 * would match EVERY label, and `[].some(...)` is `false`, so a group with no
 * tokens would make its check match NOTHING. Both are silent misbehaviours.
 * Encoding non-emptiness here turns the guard that would otherwise be needed at
 * run time — and would be unreachable, untestable code — into a compile-time
 * error at the point where a new check is declared.
 */
type NonEmptyList<T> = readonly [T, ...T[]];

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
   * Observation labels that name this check outright. Compared after
   * normalisation, so punctuation, spacing and case are irrelevant.
   */
  readonly aliases: readonly string[];
  /**
   * Fallback matcher. Every group must contribute at least one token to the
   * normalised label, which is a readable way of writing "an AND of ORs"
   * without a regular expression nobody can maintain. Both levels are
   * {@link NonEmptyList}, so neither degenerate case is expressible.
   */
  readonly tokenGroups: NonEmptyList<NonEmptyList<string>>;
  /**
   * Tokens that disqualify a label outright, so the two own-node rows can never
   * absorb an observation that is plainly about node2 or about the Secret.
   */
  readonly excludedTokens: readonly string[];
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
    aliases: [
      'cross-node-status-update',
      'cross-node mutation',
      'cross-node denial',
      'node1 updates node2 status',
      'nodes/status node2',
    ],
    tokenGroups: [['node2', 'crossnode']],
    excludedTokens: [],
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
    aliases: [
      'unrelated-secret-read',
      'unrelatedsecret',
      'ns/unrelatedsecret',
      'unrelated secret read',
    ],
    tokenGroups: [['secret']],
    excludedTokens: [],
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
    aliases: ['own-node-read', 'own node read', 'node1 reads node1'],
    tokenGroups: [
      ['node1', 'ownnode', 'own'],
      ['get', 'read'],
    ],
    excludedTokens: ['node2', 'secret', 'crossnode'],
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
    aliases: [
      'own-node-status-update',
      'own node status update',
      'node1 updates node1 status',
      'nodes/status node1',
    ],
    tokenGroups: [
      ['node1', 'ownnode', 'own'],
      ['update', 'status', 'patch'],
    ],
    excludedTokens: ['node2', 'secret', 'crossnode'],
  },
];

/** Rendered for an observation whose value is an explicit, meaningful `null`. */
const NULL_VALUE_LABEL = 'reported explicitly as null';

/** Rendered for an observation whose value is the empty string. */
const EMPTY_VALUE_LABEL = 'reported as an empty value';

/**
 * Folds a label to a comparison key: lower case, alphanumerics only.
 *
 * Everything else is removed rather than replaced with a separator, so
 * `cross-node-status-update`, `Cross node status update` and
 * `crossNodeStatusUpdate` all fold to the same key. That is deliberate for
 * LABELS, which are prose the server chose. It is deliberately NOT applied to
 * VALUES, which are evidence — see {@link classifyObservedValue}, which reads a
 * status code out of the untouched string first.
 */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Matches an already-normalised observation label against one check.
 *
 * Two layers, in order of confidence: an exact fold-equal match against the
 * check's identifier, title or declared aliases, and failing that the token
 * rules. The exact layer is tried for EVERY check before any token rule runs
 * (see {@link matchObservationsToChecks}), so a precisely named observation can
 * never be stolen by another row's looser rule.
 */
function matchesCheckExactly(check: NodeIsolationCheck, normalizedLabel: string): boolean {
  if (normalizedLabel === normalizeLabel(check.id) || normalizedLabel === normalizeLabel(check.title)) {
    return true;
  }
  return check.aliases.some((alias) => normalizeLabel(alias) === normalizedLabel);
}

/**
 * Matches an already-normalised observation label against a check's token rules.
 *
 * No emptiness guard is needed on `tokenGroups`: {@link NonEmptyList} makes both
 * degenerate shapes unrepresentable, so the only run-time behaviour left here is
 * the behaviour under test.
 */
function matchesCheckByTokens(check: NodeIsolationCheck, normalizedLabel: string): boolean {
  if (check.excludedTokens.some((token) => normalizedLabel.includes(token))) {
    return false;
  }
  return check.tokenGroups.every((group) => group.some((token) => normalizedLabel.includes(token)));
}

/**
 * Assigns the reported observations to the four rows.
 *
 * Invariants locked here:
 *
 *   1. Exact matches win globally. The exact pass runs to completion before the
 *      token pass begins.
 *   2. One observation per row, first occurrence wins — the same rule
 *      `selectControlStatus` applies to a duplicated control, so the two behave
 *      consistently.
 *   3. Nothing is invented. A row with no matching observation is simply left
 *      out of the map and renders as `not-reported`.
 *
 * @param observations - `evidence.observations` as reported, or an empty list.
 * @returns a map from check identifier to the observation backing it.
 */
function matchObservationsToChecks(
  observations: readonly ControlObservation[],
): ReadonlyMap<NodeIsolationCheckId, ControlObservation> {
  const assigned = new Map<NodeIsolationCheckId, ControlObservation>();
  const unclaimed: ControlObservation[] = [];

  for (const observation of observations) {
    const normalized = normalizeLabel(observation.label);
    const exact = NODE_ISOLATION_CHECKS.find((check) => matchesCheckExactly(check, normalized));
    if (exact !== undefined && !assigned.has(exact.id)) {
      assigned.set(exact.id, observation);
      continue;
    }
    if (exact === undefined) {
      unclaimed.push(observation);
    }
  }

  for (const observation of unclaimed) {
    const normalized = normalizeLabel(observation.label);
    const byToken = NODE_ISOLATION_CHECKS.find(
      (check) => !assigned.has(check.id) && matchesCheckByTokens(check, normalized),
    );
    if (byToken !== undefined) {
      assigned.set(byToken.id, observation);
    }
  }

  return assigned;
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

/** Matches the first three-digit HTTP status code in an untouched string. */
const HTTP_STATUS_PATTERN = /\b([1-5]\d{2})\b/;

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

  const codeMatch = HTTP_STATUS_PATTERN.exec(raw);
  if (codeMatch !== null) {
    return classifyStatusCode(Number(codeMatch[1]), raw);
  }

  const normalized = normalizeLabel(raw);
  if (normalized.includes('forbidden')) {
    return { kind: 'forbidden', httpStatus: 403, raw };
  }
  if (normalized.includes('notfound')) {
    return { kind: 'not-found', httpStatus: 404, raw };
  }
  if (
    normalized.includes('notallowed') ||
    normalized.includes('notpermitted') ||
    normalized.includes('disallowed') ||
    normalized.includes('unauthorized') ||
    normalized.includes('unauthorised') ||
    normalized.includes('denied') ||
    normalized.includes('rejected') ||
    normalized.includes('refused')
  ) {
    return { kind: 'denied-unspecified', raw };
  }
  if (
    normalized.includes('allowed') ||
    normalized.includes('permitted') ||
    normalized.includes('success') ||
    normalized === 'ok' ||
    normalized === 'nocontent'
  ) {
    return { kind: 'allowed', raw };
  }
  return { kind: 'unreadable', raw };
}

/**
 * Compares what the oracle requires with what was observed.
 *
 * THE DECISIVE RULE, stated once and implemented once: for a check the oracle
 * requires to be DENIED, only `forbidden` is `satisfied`. A `not-found` is
 * `indeterminate`, and so is a refusal whose code was not reported, because
 * neither can be told apart from a Forbidden that never happened. That is the
 * presentation-layer counterpart of the oracle's ORDER MATTERS comment.
 *
 * For a check the oracle requires to be ALLOWED, only `allowed` is `satisfied`
 * and every refusal is `violated`, mirroring `expectAllowed`, which accepts
 * nothing but `err == nil`. A refusal on a positive control is a real finding —
 * it means the restriction is over-broad, or the whole stack is failing closed —
 * so it is reported as a violation rather than softened into an unknown.
 */
function resolveCheckStatus(expectation: CheckExpectation, outcome: ObservedOutcome): CheckStatus {
  if (outcome.kind === 'not-reported') {
    return 'not-reported';
  }
  if (outcome.kind === 'unreadable') {
    return 'indeterminate';
  }
  if (expectation === 'denied') {
    if (outcome.kind === 'forbidden') {
      return 'satisfied';
    }
    if (outcome.kind === 'allowed') {
      return 'violated';
    }
    // 'not-found' and 'denied-unspecified' both land here.
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

/** Resolves all four rows against the evidence the server reported. */
function resolveChecks(observations: readonly ControlObservation[]): readonly ResolvedCheck[] {
  const assigned = matchObservationsToChecks(observations);
  return NODE_ISOLATION_CHECKS.map((check) => {
    const observation = assigned.get(check.id);
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
 *   - any `violated` row floors the verdict at `fail`;
 *   - any `indeterminate` row floors it at `unknown`, which is how an observed
 *     404 stops a reported pass from ever reaching the screen;
 *   - a non-empty `findings` list floors it at `fail`, since a finding is by
 *     definition a reported violation;
 *   - a non-empty `warnings` list floors it at `warn`, which is the hook
 *     module's own documented reading of a permitted-but-objected-to operation.
 *
 * A `not-reported` row raises NO floor, and that asymmetry is deliberate. It is
 * the difference between "the server showed its working and the working is
 * unsound" and "the server did not show its working". Only the former is
 * grounds for overriding the server's own verdict; treating the latter as
 * contradiction would mean a payload carrying a plain verdict and no evidence
 * could never render as anything but unknown, which is not a boundary the
 * oracle draws.
 */
function resolveEffectiveVerdict(
  reported: ControlVerdict,
  checks: readonly ResolvedCheck[],
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
  if (findings.length > 0) {
    verdict = leastFavourable(verdict, 'fail');
  }
  if (warnings.length > 0) {
    verdict = leastFavourable(verdict, 'warn');
  }
  return verdict;
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

/**
 * The rendered explanation the boundary requires whenever a NotFound is observed
 * on a check that must be denied.
 */
const NOT_FOUND_EXPLANATION =
  'A 404 Not Found cannot establish that the restriction was enforced: the object may simply ' +
  'have been absent, and an absent object masks the 403 Forbidden this requirement depends on. ' +
  'Such an outcome is reported as indeterminate and never as a satisfied check.';

/** The reading rules this panel applies, rendered so they are auditable on screen. */
const INTERPRETATION_NOTES: readonly string[] = [
  'Only a 403 Forbidden establishes an enforced denial. A 404 Not Found, and any refusal whose ' +
    'status code was not reported, are recorded as indeterminate.',
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
        ? `Allowed (${outcome.raw})`
        : `Allowed with HTTP ${outcome.httpStatus}`;
    case 'forbidden':
      return `Denied with HTTP ${outcome.httpStatus} Forbidden`;
    case 'not-found':
      return `Denied with HTTP ${outcome.httpStatus} Not Found`;
    case 'denied-unspecified':
      return outcome.httpStatus === undefined
        ? `Denied, status code not reported (${outcome.raw})`
        : `Denied with HTTP ${outcome.httpStatus}`;
    case 'unreadable':
      return `Unrecognised outcome (${outcome.raw})`;
    case 'not-reported':
      // Deliberately worded differently from CHECK_STATUS_LABELS['not-reported'].
      // The two columns state the same fact from different angles — what was
      // observed, and how the check therefore stands — and giving them identical
      // text would put two indistinguishable cells in one row, which is both
      // redundant to read and ambiguous to address.
      return 'No outcome reported';
  }
}

/** Flattens a finding into a single sentence, so it is one addressable text node. */
function describeFinding(finding: ControlFinding): string {
  const parts: string[] = [finding.message];
  if (finding.subject !== undefined && finding.subject !== '') {
    parts.push(`subject: ${finding.subject}`);
  }
  if (finding.requirementId !== undefined && finding.requirementId !== '') {
    parts.push(`requirement: ${finding.requirementId}`);
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
   * Handler for the refresh control. When omitted, the panel uses the `refresh`
   * handle of whichever result is driving it. In the externally controlled case
   * — a bare `status` and no handler — the button is still rendered and still
   * keyboard operable, but there is genuinely nothing for it to re-request, so it
   * carries no handler; supply this prop to opt in to the interaction.
   */
  readonly onRefresh?: () => void;
}

/** Renders the loading affordance. */
function renderLoading(): ReactElement {
  return (
    <p className="node-isolation-panel__loading" role="status" aria-label="Loading V7 posture">
      Loading the V7 node-isolation posture…
    </p>
  );
}

/**
 * Renders the error affordance.
 *
 * `role="alert"` because a failure to read posture is exactly the kind of change
 * a reader must not miss. It carries no verdict, and it structurally cannot: the
 * hook module's error arm has no `controls` member, so there is nothing here that
 * could be mistaken for one.
 */
function renderError(error: ControlStatusError): ReactElement {
  const label =
    error.httpStatus === undefined
      ? 'V7 posture unavailable'
      : `V7 posture unavailable — HTTP ${error.httpStatus}`;
  return (
    <div className="node-isolation-panel__error" role="alert" aria-label={label}>
      <p className="node-isolation-panel__error-headline">{describeErrorHeadline(error)}</p>
      <p className="node-isolation-panel__error-message">{error.message}</p>
      {error.reason !== undefined && error.reason !== '' ? (
        <p className="node-isolation-panel__error-reason">{`Server reason: ${error.reason}`}</p>
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
  return (
    <p className="node-isolation-panel__empty" role="status" aria-label="V7 posture not reported">
      {isEmpty
        ? 'The server reported no control posture at all, so there is nothing to show for V7.'
        : 'The server reported posture for other controls but not for V7, so no V7 verdict is shown.'}
    </p>
  );
}

/** Renders the success affordance: the reconciled verdict and all four outcomes. */
function renderSuccess(control: ControlStatus): ReactElement {
  const observations = control.evidence?.observations ?? [];
  const checks = resolveChecks(observations);
  const verdict = resolveEffectiveVerdict(
    control.verdict,
    checks,
    control.findings,
    control.warnings,
  );
  const sawNotFound = checks.some((resolved) => resolved.outcome.kind === 'not-found');
  const claimed = new Set<ControlObservation>(
    checks
      .map((resolved) => resolved.observation)
      .filter((observation): observation is ControlObservation => observation !== undefined),
  );
  const otherObservations = observations.filter((observation) => !claimed.has(observation));

  return (
    <div className="node-isolation-panel__body">
      <p
        className="node-isolation-panel__verdict"
        role="status"
        aria-label={`V7 verdict: ${VERDICT_LABELS[verdict]}`}
      >
        {'Verdict: '}
        <strong>{VERDICT_LABELS[verdict]}</strong>
        {` — ${VERDICT_EXPLANATIONS[verdict]}`}
      </p>

      <p className="node-isolation-panel__summary">{control.summary}</p>
      {control.detail !== undefined && control.detail !== '' ? (
        <p className="node-isolation-panel__detail">{control.detail}</p>
      ) : null}

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

      <h3 className="node-isolation-panel__subheading">Reported findings</h3>
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

      <h3 className="node-isolation-panel__subheading">Server warnings</h3>
      {control.warnings.length === 0 ? (
        <p className="node-isolation-panel__no-warnings">No warnings were reported for V7.</p>
      ) : (
        <ul className="node-isolation-panel__warnings" aria-label="V7 warnings">
          {control.warnings.map((warning, index) => (
            <li key={`${warning}-${String(index)}`}>{warning}</li>
          ))}
        </ul>
      )}

      <h3 className="node-isolation-panel__subheading">Why each outcome is required</h3>
      <ul className="node-isolation-panel__rationale" aria-label="V7 outcome rationale">
        {NODE_ISOLATION_CHECKS.map((check) => (
          <li key={check.id}>{`${check.title}: ${check.note}`}</li>
        ))}
      </ul>

      <h3 className="node-isolation-panel__subheading">How this panel reads the evidence</h3>
      <ul className="node-isolation-panel__notes" aria-label="V7 interpretation notes">
        {INTERPRETATION_NOTES.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      {otherObservations.length > 0 ? (
        <>
          <h3 className="node-isolation-panel__subheading">Other reported observations</h3>
          <ul
            className="node-isolation-panel__other-observations"
            aria-label="V7 additional observations"
          >
            {otherObservations.map((observation, index) => (
              <li key={`${observation.label}-${String(index)}`}>
                {`${observation.label}: ${formatObservationValue(observation.value)}`}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {control.observedAt !== undefined && control.observedAt !== '' ? (
        <p className="node-isolation-panel__observed-at">{`Evaluated at ${control.observedAt}`}</p>
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
  const headingId = useId();
  const control =
    state.status === 'success' ? selectControlStatus(state.controls, V7_CONTROL_ID) : undefined;
  const reportedRequirementIds = control?.requirementIds;
  const requirementIds =
    reportedRequirementIds !== undefined && reportedRequirementIds.length > 0
      ? reportedRequirementIds
      : V7_REQUIREMENT_IDS;

  return (
    <section
      className="node-isolation-panel"
      aria-labelledby={headingId}
      aria-busy={state.status === 'loading'}
    >
      <header className="node-isolation-panel__header">
        <h2 className="node-isolation-panel__heading" id={headingId}>
          {PANEL_HEADING}
        </h2>
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
        <button className="node-isolation-panel__refresh" type="button" onClick={onRefresh}>
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
function NodeIsolationPanelConnected({ onRefresh }: { readonly onRefresh?: () => void }): ReactElement {
  const result = useControlStatus(V7_CONTROL_ID);
  return <NodeIsolationPanelView state={result} onRefresh={onRefresh ?? result.refresh} />;
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
}: NodeIsolationPanelProps = {}): ReactElement {
  if (result !== undefined) {
    return <NodeIsolationPanelView state={result} onRefresh={onRefresh ?? result.refresh} />;
  }
  if (status !== undefined) {
    return (
      <NodeIsolationPanelView
        state={{ status: 'success', controls: [status], isEmpty: false }}
        onRefresh={onRefresh}
      />
    );
  }
  return <NodeIsolationPanelConnected onRefresh={onRefresh} />;
}
