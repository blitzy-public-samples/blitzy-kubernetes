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

// AAP §0.5.1 (the `web/src/components/PostureDashboard.tsx` row — "Aggregate
// view across all eight controls, plus loading, empty, error") / §0.4.1.1 (L6,
// the React component-and-interaction tier, of which this module is the
// aggregate surface) / §0.4.2.4 (the React blueprint: one panel per control plus
// an aggregate dashboard, each covering a happy path, an edge case, an error
// case, loading and empty states, and an interaction case) / §0.3.1.1 (the
// roster of eight controls composed here) / tech-spec §6.6.3.4 (the
// documentation convention this provenance comment and the invariant comments
// below satisfy).
//
// NO PARITY ANCESTOR. Every other tier in this workstream ports a Go test; this
// one cannot. `blitzy/documentation/Project Guide.md` L133 records that "This is
// a control-plane/configuration project with no UI surface", and tech-spec §7.1
// returns the same verdict, so there is no earlier component and no earlier
// component test for this file to be faithful to. Its parity anchor is instead
// the REST and CLI behaviour it surfaces: each control's rendered verdict must
// equal the verdict of the corresponding assertion in the Go oracle, which
// AAP §0.5.1 deliberately keeps in the tree — the DELETE set of the
// transformation map is empty by design — precisely so that it stays checkable.
//
// No project rules document constrains this tier: `review_rules` returns the
// single line "No user rules provided.", so the enterprise-standard bar of
// AAP §0.11.1 is what binds. Four of its items bear directly on this file.
//
//   1. "Never weaken a boundary condition to make a test pass." Aggregation is
//      where boundaries are quietly lost, so the rule implemented below is
//      conservative and explicit: one failing control fails the aggregate, and
//      one control with no trustworthy verdict makes a pass impossible. There is
//      no majority, no score, no percentage and no average anywhere in this
//      file. A "seven of eight green" summary that reads as a pass would hide
//      the one control that matters.
//   2. "Cite only what the repository states." The repository enumerates no
//      external benchmark or hardening-guide control number, so none is asserted
//      here — not in an identifier, a comment, a rendered string, a heading or an
//      accessible name. The only identifiers used are the repository's own
//      `F-00X-RQ-00Y` requirement identifiers, which the child panels render,
//      and the V1 through V8 control designations.
//   3. "Evidence over assumption." The roster is iterated from `CONTROL_IDS`,
//      the value the hook module exports for exactly this purpose, and every
//      per-control lookup table below is a `Record<ControlId, …>` literal. A
//      control added to, removed from or renamed in that single definition site
//      is therefore a `tsc --noEmit` error in this file rather than a silently
//      missing row.
//   4. "No secrets, ever." This module renders no value from a control payload
//      at all: it renders verdicts, counts and control names, and delegates
//      every value to the child panel that owns it, along with that panel's own
//      placeholder and redaction discipline.
import { useCallback, useId, useState, type ChangeEvent, type ReactElement } from 'react';

import {
  CONTROL_IDS,
  selectControlStatus,
  useControlStatus,
  type ControlId,
  type ControlStatus,
  type ControlStatusError,
  type ControlStatusErrorKind,
  type ControlVerdict,
  type UseControlStatusResult,
} from '../hooks/useControlStatus';
import type { EffectiveVerdict } from '../domain/evidence';
import {
  describeStatusReason,
  safeProse,
} from '../domain/safeText';
import AuditFidelityPanel from './AuditFidelityPanel';
import EncryptionAtRestPanel from './EncryptionAtRestPanel';
import EtcdTransportPanel from './EtcdTransportPanel';
import NodeIsolationPanel from './NodeIsolationPanel';
import PodSecurityPanel from './PodSecurityPanel';
import RbacWildcardPanel from './RbacWildcardPanel';
import TokenHygienePanel from './TokenHygienePanel';
import WebhookPosturePanel from './WebhookPosturePanel';
import { resolveEffectiveControlVerdict } from './controlVerdicts';
import { EmbeddedPanelProvider } from './embeddedPanel';
import { REFRESH_UNAVAILABLE_TITLE as SHARED_REFRESH_UNAVAILABLE_TITLE } from './refreshContract';

/** Block name shared by every class name in this module. */
const BLOCK = 'posture-dashboard';

/**
 * The scoped overflow container each embedded control panel sits in (m5).
 *
 * `overflow-x: auto` rather than page-level scrolling, and the difference is what a reader
 * experiences at a narrow viewport: when the PAGE scrolls, one wide table drags the toolbar,
 * the verdict filter and the aggregate verdict off screen with it, and the operator loses the
 * one summary the surface exists to give them. When the CARD scrolls, the wide table is the
 * only thing that moves.
 *
 * `min-width: 0` is load-bearing and easy to omit: a flex or grid item's default minimum size
 * is its content, so without it the container refuses to shrink below its widest table and
 * `overflow-x` never engages. It is spelled out here rather than discovered later.
 *
 * Inline rather than a stylesheet because this repository ships no design system and no CSS
 * build (AAP §0.8.2, and the review records the design-system item as not applicable), so
 * there is no token to reference and no cascade to join.
 */
const CONTROL_SCROLL_STYLE = {
  overflowX: 'auto',
  maxWidth: '100%',
  minWidth: 0,
} as const;

/**
 * Title of the whole surface, and the accessible name of its `<main>` landmark.
 *
 * Exported, like every other rendered string in this module, so that a spec
 * asserts against the same constant the component renders instead of a copy of
 * its text. That is the convention the sibling panels in this folder already
 * follow, and it is what keeps a wording change from silently breaking a spec.
 */
export const POSTURE_DASHBOARD_TITLE = 'Cluster hardening posture';

/** Standing explanation of what the surface reports and how strictly. */
export const POSTURE_DASHBOARD_DESCRIPTION =
  'Posture of the eight hardening controls V1 through V8. The aggregate verdict ' +
  'is a pass only when every one of the eight controls is individually a pass.';

/** Heading of the aggregate section. */
export const AGGREGATE_SECTION_HEADING = 'Aggregate posture';

/** Heading of the per-control section. */
export const CONTROLS_SECTION_HEADING = 'Per-control posture';

/** Heading of the counts list nested inside the aggregate section. */
export const VERDICT_COUNTS_HEADING = 'Controls by verdict';

/** Visible name of the aggregate verdict live region. */
export const AGGREGATE_VERDICT_LABEL = 'Aggregate verdict';

/** Visible name of the loading live region. */
export const AGGREGATE_LOADING_LABEL = 'Reading control posture';

/** Visible name of the empty live region. */
export const AGGREGATE_EMPTY_LABEL = 'No control posture reported';

/** Visible name of the failure alert. */
export const AGGREGATE_ERROR_LABEL = 'Control posture could not be read';

/** Substituted for a failure message that sanitized away to nothing. */
export const WITHHELD_AGGREGATE_ERROR_MESSAGE =
  'The failure message could not be displayed.';

/**
 * Bounds the aggregate failure message, substituting local wording when nothing survives.
 *
 * The alert this feeds is the highest-priority text the dashboard can emit — it announces
 * itself, and it is the first thing a screen-reader user hears when a collection read fails.
 * An empty string there would leave the label over a blank line, indistinguishable from a
 * server that failed without saying why, so the two cases are worded apart.
 */
function safeAggregateErrorMessage(message: string): string {
  const bounded = safeProse(message);
  return bounded === '' ? WITHHELD_AGGREGATE_ERROR_MESSAGE : bounded;
}

/** Accessible name of the refresh control. */
export const REFRESH_ALL_LABEL = 'Refresh all eight controls';

/**
 * Explains a disabled refresh control.
 *
 * The button is disabled exactly when no refresh handler reached this component,
 * which is a caller-driven configuration rather than a transient state.
 *
 * Re-exported from `./refreshContract` rather than worded again here, and that is
 * the whole point: this dashboard disables its own button and every child panel's
 * button from the same fact, so the two must not offer a reader two different
 * explanations of the same situation.
 */
export const REFRESH_UNAVAILABLE_TITLE = SHARED_REFRESH_UNAVAILABLE_TITLE;

/** Accessible name of the verdict filter. */
export const VERDICT_FILTER_LABEL = 'Filter controls by verdict';

/** Label of the filter option that applies no filter. */
export const ALL_VERDICTS_OPTION_LABEL = 'All verdicts';

/**
 * The filter value meaning "do not filter".
 *
 * The empty string is used because that is what an unselected `<option>` value
 * naturally carries and because it can never collide with a verdict name. This
 * matches the sentinel `AuditFidelityPanel` uses for its own level filter.
 */
export const ALL_VERDICTS_VALUE = '';

/** Visible name of the live region that reports an active filter. */
export const FILTER_NOTICE_LABEL = 'Filter active';

/** Visible name of the live region reporting that a filter matched nothing. */
export const FILTER_EMPTY_LABEL = 'No control matches the filter';

/** One verdict rendered as a short label plus a sentence of explanation. */
interface VerdictPresentation {
  /** Short label, as rendered. */
  readonly label: string;
  /** Why the aggregate resolved this way, in one sentence. */
  readonly description: string;
}

/**
 * How each verdict is rendered when it is the AGGREGATE verdict.
 *
 * Invariant locked: the four descriptions state the aggregate rule in words, so
 * the rule is legible to a reader of the rendered page and not only to a reader
 * of this file. The short labels are the same four the sibling panels use for a
 * per-control verdict, so one vocabulary covers the whole folder.
 *
 * `Record<ControlVerdict, …>` is load-bearing rather than decorative: written as
 * an exhaustive object literal, it cannot omit a member of the union and cannot
 * carry one that does not exist. A fifth verdict added to the hook module is
 * therefore a compile error here.
 */
export const AGGREGATE_VERDICT_PRESENTATION: Readonly<Record<ControlVerdict, VerdictPresentation>> =
  Object.freeze({
    pass: {
      label: 'Pass',
      description: 'Every one of the eight controls was reported and every one of them passed.',
    },
    fail: {
      label: 'Fail',
      description:
        'At least one control is violated. One failure fails the aggregate no matter how ' +
        'many other controls pass.',
    },
    warn: {
      label: 'Warning',
      description:
        'Every control was reported and none failed, but at least one operation was ' +
        'permitted with a server warning, so this is not a clean pass.',
    },
    unknown: {
      label: 'Unknown',
      description:
        'At least one control reported no trustworthy verdict, so a pass cannot be claimed ' +
        'for the aggregate.',
    },
  });

/**
 * Every verdict, most severe first — the precedence the aggregate rule applies
 * and the order the counts list and the filter options are rendered in.
 *
 * This is a display and iteration order only. The rule itself is implemented
 * explicitly in {@link verdictFromCounts} rather than by scanning this list, so
 * reordering it can change what a reader sees but can never change which verdict
 * the aggregate resolves to.
 */
export const VERDICT_PRECEDENCE: readonly ControlVerdict[] = Object.freeze([
  'fail',
  'unknown',
  'warn',
  'pass',
] as const satisfies readonly ControlVerdict[]);

/**
 * The subject of each control, as named by AAP §0.3.1.1.
 *
 * These are the accessible names of the eight per-control regions and the text
 * of their headings. They are deliberately NOT copies of the child panels' own
 * headings: each panel names itself, and giving the wrapper region a distinct
 * name keeps `getByRole('region', { name })` unambiguous between the wrapper and
 * the panel inside it.
 *
 * `Record<ControlId, string>` is the compile-time gate on the roster: a control
 * added to `CONTROL_IDS` without a title here does not typecheck.
 */
export const CONTROL_SECTION_TITLES: Readonly<Record<ControlId, string>> = Object.freeze({
  V1: 'V1 — RBAC least-privilege',
  V2: 'V2 — Pod Security enforcement',
  V3: 'V3 — Secrets encryption at rest',
  V4: 'V4 — ServiceAccount-token hygiene',
  V5: 'V5 — admission-webhook fail-closed',
  V6: 'V6 — sensitive-resource audit fidelity',
  V7: 'V7 — NodeRestriction',
  V8: 'V8 — etcd mutual-TLS',
});

/**
 * What each kind of failure means, in one clause.
 *
 * Rendered alongside the server's own message so that a reader can tell a
 * refusal from a transport failure from an unreadable body. `Record` over the
 * imported union again makes a new kind a compile error rather than a blank.
 */
export const ERROR_KIND_DESCRIPTIONS: Readonly<Record<ControlStatusErrorKind, string>> =
  Object.freeze({
    http: 'The server answered, and its status was not a success.',
    network: 'No response arrived, so nothing could be read.',
    payload: 'A success response arrived, but its body could not be trusted.',
    timeout: 'The request was still outstanding when its deadline elapsed, and was cancelled.',
  });

/**
 * A caller-supplied set of already-resolved control payloads, keyed by control.
 *
 * Partial on purpose: a caller may supply some controls and not others, and the
 * aggregate rule below treats every control it was not given as `unknown` rather
 * than quietly narrowing the population it judges.
 */
export type PostureStatusMap = Readonly<Partial<Record<ControlId, ControlStatus>>>;

/** The aggregate outcome across the whole roster. */
export interface PostureAggregate {
  /**
   * The aggregate verdict, resolved by the conservative rule documented on
   * {@link summarisePosture}.
   */
  readonly verdict: ControlVerdict;
  /**
   * How many controls hold each verdict. Sums to {@link PostureAggregate.total}
   * because a control with no payload counts as `unknown`.
   */
  readonly counts: Readonly<Record<ControlVerdict, number>>;
  /** How many of the eight controls the payload actually described. */
  readonly reported: number;
  /** The size of the roster: every control that must be judged. */
  readonly total: number;
}

/** Shared empty list, so a state with no controls keeps a stable identity. */
const NO_CONTROLS: readonly ControlStatus[] = Object.freeze([]);

/**
 * Every control's EFFECTIVE verdict — the one its own panel renders — resolved once.
 *
 * Invariant locked, and the reason this function replaced a one-line read of
 * `status.verdict`: the number in this dashboard's tally is produced by the SAME
 * function call as the badge in the panel beneath it. Each panel reconciles what the
 * check reported against what it measured and downgrades a reported `pass` that the
 * evidence does not support — to `unknown` when the evidence is missing, to `fail`
 * when it contradicts the claim or a finding is attached. Counting the raw reported
 * verdict here meant the aggregate could read "Pass: 8" above a panel rendering a
 * failure, which is the worst possible place for the two to disagree because the
 * aggregate is the number a reader trusts at a glance.
 *
 * Invariant locked: an absent control is `unknown`, NEVER `pass`. The Go oracle pairs
 * every negative assertion with a positive control for exactly this reason — a check
 * that cannot tell "no evidence" from "good evidence" also passes when the whole
 * authorization stack is broken.
 *
 * Resolved into a map ONCE per render because three consumers need the same answers —
 * the tally, the verdict filter and each control section's `data-verdict` — and
 * resolving separately for each would let a future edit change one and not the others.
 *
 * @param statuses - the payloads available, keyed by control; may be partial.
 * @returns one verdict per control in the roster, exhaustive over `ControlId`.
 */
export function resolveEffectiveVerdicts(
  statuses: PostureStatusMap,
): Readonly<Record<ControlId, EffectiveVerdict>> {
  const resolved: Partial<Record<ControlId, EffectiveVerdict>> = {};
  for (const controlId of CONTROL_IDS) {
    resolved[controlId] = resolveEffectiveControlVerdict(controlId, statuses[controlId]);
  }
  // Every key was just written in the loop above, which iterates the whole roster, so
  // the partial is total. The assertion is confined to this one line.
  return Object.freeze(resolved as Record<ControlId, EffectiveVerdict>);
}

/**
 * A fresh, exhaustive tally.
 *
 * The object literal is checked against `Record<ControlVerdict, number>`, so it
 * can neither omit a verdict nor invent one. That makes this function the
 * compile-time gate on counting: a fifth verdict cannot be silently left out of
 * the tally.
 */
function emptyVerdictCounts(): Record<ControlVerdict, number> {
  return { pass: 0, fail: 0, warn: 0, unknown: 0 };
}

/**
 * THE AGGREGATE RULE, in precedence order, most severe first.
 *
 * Invariant locked, and the reason this is a separate named function rather than
 * an expression buried in a component: the aggregate is a pass ONLY when all
 * four other arms are ruled out, which is to say only when every control in the
 * roster passed.
 *
 *   1. any `fail`    -> `fail`    — one violated control fails the aggregate,
 *                                   however many others pass;
 *   2. any `unknown` -> `unknown` — a control with no trustworthy verdict makes
 *                                   a pass impossible, and ranks below `fail`
 *                                   only because a known violation is the more
 *                                   actionable finding of the two;
 *   3. any `warn`    -> `warn`    — a permitted-but-objected-to control is its
 *                                   own aggregate outcome and is never absorbed
 *                                   into a clean pass;
 *   4. otherwise     -> `pass`.
 *
 * There is deliberately no arithmetic here: no majority, no score, no percentage
 * and no average. Every such summary can read as a pass while a control is
 * violated, which is precisely the boundary AAP §0.11.1 forbids weakening.
 */
function verdictFromCounts(counts: Readonly<Record<ControlVerdict, number>>): ControlVerdict {
  if (counts.fail > 0) {
    return 'fail';
  }
  if (counts.unknown > 0) {
    return 'unknown';
  }
  if (counts.warn > 0) {
    return 'warn';
  }
  return 'pass';
}

/**
 * Tallies already-resolved per-control verdicts into one aggregate outcome.
 *
 * The population judged is always the whole roster — `CONTROL_IDS`, iterated
 * rather than re-listed — so a control missing from the payload is judged as
 * `unknown` instead of being excluded from the denominator. That is what makes
 * "seven passes and one silence" resolve to `unknown` rather than to `pass`.
 *
 * Takes the resolved verdicts rather than resolving them, so the render path can
 * resolve once and share the answers with the filter and with each control's
 * `data-verdict`. `reported` still comes from `statuses`, because "how many controls
 * the payload described" is a fact about the payload and not about its verdicts: a
 * control reported with an unsupported `pass` is REPORTED and counted `unknown`.
 */
function summariseResolved(
  statuses: PostureStatusMap,
  effective: Readonly<Record<ControlId, EffectiveVerdict>>,
): PostureAggregate {
  const counts = emptyVerdictCounts();
  let reported = 0;

  for (const controlId of CONTROL_IDS) {
    if (statuses[controlId] !== undefined) {
      reported += 1;
    }
    counts[effective[controlId]] += 1;
  }

  return Object.freeze({
    verdict: verdictFromCounts(counts),
    counts: Object.freeze(counts),
    reported,
    total: CONTROL_IDS.length,
  });
}

/**
 * Reduces a set of control payloads to one aggregate outcome.
 *
 * Exported so that the rule can be exercised directly, independently of any
 * rendering, and so that every arm of {@link verdictFromCounts} is reachable. Every
 * verdict counted is the EFFECTIVE one from {@link resolveEffectiveVerdicts}, so this
 * function and the panels can never disagree.
 *
 * @param statuses - the payloads available, keyed by control; may be partial.
 * @returns the aggregate verdict together with the tally behind it.
 */
export function summarisePosture(statuses: PostureStatusMap): PostureAggregate {
  return summariseResolved(statuses, resolveEffectiveVerdicts(statuses));
}

/**
 * Indexes a reported control list by control identifier.
 *
 * Identity comes from each payload's own `controlId` — read through the hook
 * module's `selectControlStatus`, so the dashboard and every panel resolve a
 * control the same way — and never from a position in the list. A payload that
 * mentions a control twice resolves to its first occurrence, which is the
 * behaviour `selectControlStatus` documents.
 */
function indexControls(controls: readonly ControlStatus[]): PostureStatusMap {
  const indexed: Partial<Record<ControlId, ControlStatus>> = {};
  for (const controlId of CONTROL_IDS) {
    const status = selectControlStatus(controls, controlId);
    if (status !== undefined) {
      indexed[controlId] = status;
    }
  }
  return indexed;
}

/**
 * Flattens a caller-supplied map into the list shape the child panels consume.
 *
 * Roster order is used so the list is deterministic. Entries are taken by value,
 * not by key: an entry filed under one identifier whose payload names another is
 * resolved by the payload, because the payload's `controlId` is the authoritative
 * identity everywhere else in this tier and two sources of truth would let the
 * dashboard and its panels disagree about which control they are showing.
 */
function orderControls(statuses: PostureStatusMap): readonly ControlStatus[] {
  const ordered: ControlStatus[] = [];
  for (const controlId of CONTROL_IDS) {
    const status = statuses[controlId];
    if (status !== undefined) {
      ordered.push(status);
    }
  }
  return ordered;
}

/**
 * The dashboard's resolved lifecycle state, as a discriminated union.
 *
 * Invariant locked, and inherited from the hook module by construction: the
 * `error` arm carries no controls and no verdict at all, so a refused or failed
 * request cannot be rendered as a pass even by accident. Reaching for a verdict
 * on that arm is a `tsc --noEmit` error under `strict`, not a review comment.
 */
type PostureResolution =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly error: ControlStatusError }
  | {
      readonly state: 'resolved';
      readonly controls: readonly ControlStatus[];
      readonly isEmpty: boolean;
    };

/**
 * Projects a hook result onto {@link PostureResolution}.
 *
 * `isEmpty` is carried through verbatim rather than recomputed from the list
 * length: the hook is the authority on whether the server reported nothing, and
 * re-deriving it here would create a second answer to the same question.
 */
function resolveFromResult(result: UseControlStatusResult): PostureResolution {
  if (result.status === 'loading') {
    return { state: 'loading' };
  }
  if (result.status === 'error') {
    return { state: 'error', error: result.error };
  }
  return { state: 'resolved', controls: result.controls, isEmpty: result.isEmpty };
}

/**
 * Occupies the `refresh` member of the state handed to the child panels when a
 * caller drove the data but wired no handler.
 *
 * Deliberately a no-op with no body, and not a stub: `UseControlStatusResult`
 * requires the member, so some function must be supplied, and the honest function
 * for "this dashboard has nothing to re-request" is one that does nothing.
 *
 * It is also never CALLED. In exactly the configuration that selects it — posture
 * supplied directly, no `onRefresh` — every child is rendered with
 * `canRefresh={false}`, so each child's refresh affordance resolves to no handler
 * at all and is disabled with an explanation, matching this dashboard's own button
 * instead of contradicting it. Leaving the children enabled here was a real defect:
 * the top button correctly said it could not refresh while eight buttons beneath it
 * looked operable and did nothing. Named, so it is identifiable in a stack trace.
 */
function noRefresh(): void {
  /* No request exists to re-issue. See the note above. */
}


/**
 * The loading affordance.
 *
 * Invariant locked: loading is a state of its own, distinguishable from both a
 * pass and an empty result. No verdict element renders while it is showing, so
 * there is nothing on screen for a reader to mistake for a clean aggregate — and
 * that holds whether none of the controls has resolved or only some have.
 * `role="status"` rather than `role="alert"` because work in progress is
 * polite information, not an assertive announcement.
 */
function AggregateLoading({ labelId }: { readonly labelId: string }): ReactElement {
  return (
    <p className={`${BLOCK}__state ${BLOCK}__state--loading`} role="status" aria-labelledby={labelId}>
      <strong id={labelId}>{AGGREGATE_LOADING_LABEL}</strong>{' '}
      <span className={`${BLOCK}__state-detail`}>
        {'No aggregate verdict is shown until every control has been read, so this is not a pass.'}
      </span>
    </p>
  );
}

/**
 * The failure affordance.
 *
 * Invariant locked, and the single most important behaviour on this surface: a
 * refusal is never a pass. This renders for every non-success response — 403 and
 * 500 in particular — and for a transport failure, it says outright that no
 * verdict is available, and no verdict element renders beside it. The dashboard
 * is the one place a reader would trust at a glance, so it must be incapable of
 * looking clean when the posture could not be read.
 *
 * The status code and the server's own `reason` are rendered when present and
 * simply omitted when they are not. `httpStatus` is absent exactly for a
 * transport failure, where no response — and therefore no status — ever existed;
 * inventing a zero there would report a status the server never sent.
 *
 * `role="alert"` because a posture check that failed must be announced without
 * waiting for the operator to reach it. No error boundary wraps this surface
 * anywhere: swallowing a render error would let a failure look like a pass.
 */
function AggregateError({
  error,
  labelId,
}: {
  readonly error: ControlStatusError;
  readonly labelId: string;
}): ReactElement {
  return (
    <p
      className={`${BLOCK}__state ${BLOCK}__state--error`}
      role="alert"
      aria-labelledby={labelId}
      data-error-kind={error.kind}
    >
      {/*
        M18 — THE TWO EXTERNAL FIELDS ARE BOUNDED, the two local ones are not, and the split is
        deliberate. `message` and `reason` are the server's or the parser's own words and were
        rendered verbatim in an `alert` that fires without the operator asking for it — the most
        prominent text on the surface, reached before anything else. `httpStatus` is a number
        and `kind` is a typed union of this repository's own literals, so guarding either would
        only obscure that it is not external text.

        The label and the closing sentence are authored here and unconditional, so a reader is
        never left with a redaction marker and no statement of what it means.
      */}
      <strong id={labelId}>{AGGREGATE_ERROR_LABEL}</strong>{' '}
      <span className={`${BLOCK}__error-message`}>{safeAggregateErrorMessage(error.message)}</span>
      {error.httpStatus === undefined ? null : (
        <span className={`${BLOCK}__error-status`}>{` HTTP status ${error.httpStatus}.`}</span>
      )}
      {error.reason === undefined ? null : (
        <span className={`${BLOCK}__error-reason`}>{` Reason: ${describeStatusReason(error.reason)}.`}</span>
      )}
      <span className={`${BLOCK}__error-kind`}>{` ${ERROR_KIND_DESCRIPTIONS[error.kind]}`}</span>
      <span className={`${BLOCK}__state-detail`}>
        {' No aggregate verdict is available, and this is not a pass.'}
      </span>
    </p>
  );
}

/**
 * The empty affordance.
 *
 * Invariant locked: empty is not a pass. A successful response that described no
 * control at all is a distinct outcome from one that described eight passing
 * controls, and conflating the two would report a clean cluster on evidence that
 * was never received. As with loading and error, no verdict element renders.
 */
function AggregateEmpty({ labelId }: { readonly labelId: string }): ReactElement {
  return (
    <p className={`${BLOCK}__state ${BLOCK}__state--empty`} role="status" aria-labelledby={labelId}>
      <strong id={labelId}>{AGGREGATE_EMPTY_LABEL}</strong>{' '}
      <span className={`${BLOCK}__state-detail`}>
        {`The request succeeded but described none of the ${CONTROL_IDS.length} controls, so no ` +
          `aggregate verdict can be claimed. An empty result is not a pass.`}
      </span>
    </p>
  );
}

/**
 * The aggregate verdict affordance: the primary affordance of this surface.
 *
 * One element, individually queryable by its stable accessible name, carrying
 * the verdict in words. The verdict — not a count, not a ratio — is what this
 * element says, because a reader who takes in only one thing from a dashboard
 * must take in the thing that is safe to act on.
 *
 * `data-verdict` carries the resolved verdict so a stylesheet can distinguish
 * the four outcomes without this component inventing colour classes, and so
 * colour is never the sole carrier of meaning: the text states the verdict, and
 * the sentence after it states why, regardless of how it is styled.
 */
function AggregateVerdict({
  aggregate,
  labelId,
}: {
  readonly aggregate: PostureAggregate;
  readonly labelId: string;
}): ReactElement {
  const presentation = AGGREGATE_VERDICT_PRESENTATION[aggregate.verdict];
  return (
    <p
      className={`${BLOCK}__state ${BLOCK}__state--verdict`}
      role="status"
      aria-labelledby={labelId}
      data-verdict={aggregate.verdict}
    >
      <strong id={labelId}>{AGGREGATE_VERDICT_LABEL}</strong>{' '}
      <span className={`${BLOCK}__verdict-value`}>{presentation.label}</span>
      {' — '}
      <span className={`${BLOCK}__verdict-description`}>{presentation.description}</span>{' '}
      <span className={`${BLOCK}__verdict-coverage`}>
        {`${aggregate.reported} of ${aggregate.total} controls were reported.`}
      </span>
    </p>
  );
}

/**
 * The supporting tally, one row per verdict.
 *
 * Secondary to the verdict above it by design. Every verdict gets a row even
 * when its count is zero, so "Fail: 0" is stated rather than inferred from an
 * absent row, and so the list neither grows nor shrinks between states.
 */
function VerdictCounts({
  aggregate,
  headingId,
}: {
  readonly aggregate: PostureAggregate;
  readonly headingId: string;
}): ReactElement {
  return (
    <ul className={`${BLOCK}__counts`} aria-labelledby={headingId}>
      {VERDICT_PRECEDENCE.map((verdict) => (
        <li className={`${BLOCK}__count`} key={verdict} data-verdict={verdict}>
          {`${AGGREGATE_VERDICT_PRESENTATION[verdict].label}: ${aggregate.counts[verdict]}`}
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders the panel that owns one control.
 *
 * The `switch` is exhaustive over `ControlId` and carries no `default`. Because
 * the function is annotated as returning `ReactElement`, omitting a control makes
 * the implicit `undefined` return a compile error — which is the mechanism that
 * stops a control from being silently dropped from this dashboard.
 *
 * WHAT IS PASSED DOWN, AND WHY BOTH:
 *
 *   * `result` goes to all eight panels and is never omitted. A panel given
 *     neither `result` nor `status` falls back to a request of its own, so
 *     omitting it would turn one dashboard render into nine independent reads and
 *     would make the panels' states diverge from the aggregate above them.
 *     Passing it is also what gives each panel its own loading, error and empty
 *     affordance for free, driven by the same state.
 *   * `result.controls` is the WHOLE reported list, not a one-element list built
 *     for the panel. Panels distinguish "the server reported no posture at all"
 *     from "it reported posture for other controls but not mine", and that
 *     distinction is only available to them if they can see the whole list.
 *   * `status` additionally goes to the seven panels that accept it, handing them
 *     the resolved payload directly. Both props derive from the same single
 *     state, so they cannot disagree; when a control is absent, `status` is
 *     `undefined` and every panel falls through to `result` and renders its own
 *     absent-control affordance.
 *   * `AuditFidelityPanel` accepts no `status` — it reads its control out of
 *     `result.controls` itself — so it receives `result` plus the refresh props.
 *     Its `expectations` and `events` props are deliberately not supplied:
 *     `expectations` then defaults to the panel's own measured rows, and an omitted
 *     `events` tells it to leave that section out entirely rather than to render it
 *     empty. That omission is also what makes its verdict identical to the one this
 *     dashboard counts for V6, since the registry adapts its resolver with an empty
 *     event list.
 *   * `canRefresh` goes to ALL EIGHT and is the same boolean this dashboard uses to
 *     disable its own button. One fact, one answer: either every refresh affordance
 *     on the surface works or every one of them is disabled and says why.
 */
function ControlPanel({
  controlId,
  status,
  result,
  onRefresh,
  canRefresh,
}: {
  readonly controlId: ControlId;
  readonly status: ControlStatus | undefined;
  readonly result: UseControlStatusResult;
  readonly onRefresh: () => void;
  readonly canRefresh: boolean;
}): ReactElement {
  switch (controlId) {
    case 'V1':
      return (
        <RbacWildcardPanel
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
    case 'V2':
      return (
        <PodSecurityPanel
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
    case 'V3':
      return (
        <EncryptionAtRestPanel
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
    case 'V4':
      return (
        <TokenHygienePanel
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
    case 'V5':
      return (
        <WebhookPosturePanel
          controlId={controlId}
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
    case 'V6':
      return <AuditFidelityPanel result={result} onRefresh={onRefresh} canRefresh={canRefresh} />;
    case 'V7':
      return (
        <NodeIsolationPanel
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
    case 'V8':
      return (
        <EtcdTransportPanel
          status={status}
          result={result}
          onRefresh={onRefresh}
          canRefresh={canRefresh}
        />
      );
  }
}


/** The filter state: one verdict, or the sentinel meaning "do not filter". */
type VerdictFilterValue = ControlVerdict | typeof ALL_VERDICTS_VALUE;

/**
 * Narrows a raw form value back to a {@link ControlVerdict}.
 *
 * A `<select>` hands back a plain string. Recognition is by exact match against
 * the roster of verdicts — nothing is trimmed, case-folded or coerced into
 * matching — and an unrecognised value falls back to "do not filter" rather than
 * silently emptying the list, because a filter this component cannot name is one
 * it must not act on.
 */
function isControlVerdict(value: string): value is ControlVerdict {
  return VERDICT_PRECEDENCE.some((candidate) => candidate === value);
}

/**
 * Projects the dashboard's state onto the hook-shaped state its panels consume.
 *
 * One object is built per render and shared by all eight panels, so every panel
 * shows the same lifecycle state as the aggregate above it. There is no way for a
 * panel to be showing a resolved verdict while the aggregate reads loading, or
 * the reverse.
 */
function panelResultFor(
  resolution: PostureResolution,
  refresh: () => void,
): UseControlStatusResult {
  if (resolution.state === 'loading') {
    return { status: 'loading', refresh };
  }
  if (resolution.state === 'error') {
    return { status: 'error', error: resolution.error, refresh };
  }
  return {
    status: 'success',
    controls: resolution.controls,
    isEmpty: resolution.isEmpty,
    refresh,
  };
}

/** Props of the presentational body, which never touches a data hook. */
interface PostureDashboardViewProps {
  /** The already-resolved lifecycle state. */
  readonly resolution: PostureResolution;
  /**
   * Re-requests every control. `undefined` means no handler was wired, which
   * disables the refresh control rather than leaving a button that does nothing
   * when pressed.
   */
  readonly onRefresh: (() => void) | undefined;
}

/**
 * The whole dashboard, rendered from already-resolved state.
 *
 * This is where the layout, the landmark and the interaction live. It calls no
 * data hook, so it renders identically whether its state came from the network or
 * from a caller — which is what makes the surface deterministically drivable.
 *
 * STRUCTURE, and why every part of it is addressable by role plus accessible name
 * rather than by a test identifier or by raw text:
 *
 *   * the outer `<main>` is named by its `<h1>`, so it resolves to a `main`
 *     landmark named "Cluster hardening posture", and carries `aria-busy` while a
 *     read is in flight;
 *   * the aggregate and per-control sections are each named by their own `<h2>`,
 *     so each resolves to a `region` with a distinct name;
 *   * inside the aggregate section, EXACTLY ONE of the loading region, the failure
 *     alert, the empty region and the verdict region renders, because all four are
 *     keyed off the same discriminant. A pass affordance is therefore structurally
 *     absent from every state except a resolved one;
 *   * each of the eight controls sits in its own `<section>` named by an `<h3>`, so
 *     a spec can scope queries to one control with `within(...)`;
 *   * the refresh control is a native `<button type="button">` and the filter is a
 *     native `<select>` associated with a real `<label>`, so both are keyboard
 *     operable and correctly named without a single ARIA attribute;
 *   * every live region carries `aria-labelledby` pointing at VISIBLE text, so the
 *     name an assistive technology announces is the name on screen.
 *
 * HEADING LEVELS. This module's own headings run `h1` then `h2` then `h3` with no
 * level skipped. Each child panel is independently mounted elsewhere in this tier
 * and roots itself at `h2`, so inside a control's `h3` section the panel's `h2`
 * follows an `h3`. That is a level RETURN, which closes the subsection and opens a
 * new one, and not a level SKIP, which is the case the "no skipped levels" rule
 * exists to prevent. The alternative — dropping this module's per-control heading —
 * would leave the eight regions unnamed by any visible heading, and the panels are
 * not modified by this workstream.
 *
 * NO MEMOISATION, deliberately. Every derived value below is O(8) over a fixed
 * roster, and the inputs a caller supplies are fresh objects on each render, so a
 * `useMemo` keyed on them would recompute every time anyway while implying a
 * stability it cannot deliver. The one handler that benefits from a stable
 * identity is memoised.
 */
function PostureDashboardView({ resolution, onRefresh }: PostureDashboardViewProps): ReactElement {
  // One base per instance, suffixed per element, so two dashboards on one page
  // never collide and so no identifier depends on render order.
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const aggregateHeadingId = `${baseId}-aggregate-heading`;
  const countsHeadingId = `${baseId}-counts-heading`;
  const controlsHeadingId = `${baseId}-controls-heading`;
  const verdictLabelId = `${baseId}-verdict-label`;
  const loadingLabelId = `${baseId}-loading-label`;
  const errorLabelId = `${baseId}-error-label`;
  const emptyLabelId = `${baseId}-empty-label`;
  const filterId = `${baseId}-verdict-filter`;
  const filterNoticeLabelId = `${baseId}-filter-notice-label`;
  const filterEmptyLabelId = `${baseId}-filter-empty-label`;

  const [verdictFilter, setVerdictFilter] = useState<VerdictFilterValue>(ALL_VERDICTS_VALUE);

  const handleFilterChange = useCallback((changeEvent: ChangeEvent<HTMLSelectElement>): void => {
    const chosen = changeEvent.target.value;
    setVerdictFilter(isControlVerdict(chosen) ? chosen : ALL_VERDICTS_VALUE);
  }, []);

  // Reachable only from the resolved arm. The loading and error arms carry no
  // controls at all, so no verdict can be read out of them even by accident.
  const controls = resolution.state === 'resolved' ? resolution.controls : NO_CONTROLS;
  const statuses = indexControls(controls);

  // THE AGGREGATE IS ALWAYS COMPUTED FROM THE WHOLE ROSTER, never from the
  // filtered view. That is what makes it impossible for the filter to hide a
  // failing control while the aggregate still reads as a pass: the filter selects
  // what is displayed below and has no input into this value.
  //
  // Resolved ONCE, from each control's own panel resolver, and shared by the tally,
  // the filter and every control section's `data-verdict`. A reader can therefore
  // never see "Pass: 8" over a panel that rendered a failure, and the filter can
  // never sort a control into a bucket its own panel disagrees with.
  const effectiveVerdicts = resolveEffectiveVerdicts(statuses);
  const aggregate = summariseResolved(statuses, effectiveVerdicts);

  // ONE fact about refreshing, applied to this dashboard's button and to all eight
  // child buttons: `canRefresh` is false exactly when no handler reached this
  // component, which is precisely when the button below is disabled.
  const canRefresh = onRefresh !== undefined;
  const panelRefresh = onRefresh ?? noRefresh;
  const panelResult = panelResultFor(resolution, panelRefresh);

  const filteredVerdict: ControlVerdict | undefined =
    verdictFilter === ALL_VERDICTS_VALUE ? undefined : verdictFilter;
  const filterVerdictLabel =
    filteredVerdict === undefined
      ? ALL_VERDICTS_OPTION_LABEL
      : AGGREGATE_VERDICT_PRESENTATION[filteredVerdict].label;

  // Filtering only ever SELECTS from the roster: it never reorders it, never
  // rewrites a row, and the unfiltered case returns the roster by identity rather
  // than a copy of it.
  const visibleControlIds: readonly ControlId[] =
    filteredVerdict === undefined
      ? CONTROL_IDS
      : CONTROL_IDS.filter((controlId) => effectiveVerdicts[controlId] === filteredVerdict);
  const hiddenCount = CONTROL_IDS.length - visibleControlIds.length;

  return (
    <main
      className={BLOCK}
      aria-labelledby={titleId}
      aria-busy={resolution.state === 'loading'}
      data-posture-state={resolution.state}
    >
      <h1 className={`${BLOCK}__title`} id={titleId}>
        {POSTURE_DASHBOARD_TITLE}
      </h1>
      <p className={`${BLOCK}__description`}>{POSTURE_DASHBOARD_DESCRIPTION}</p>

      <div className={`${BLOCK}__toolbar`}>
        <button
          className={`${BLOCK}__refresh`}
          type="button"
          onClick={onRefresh}
          disabled={onRefresh === undefined}
          title={onRefresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
        >
          {REFRESH_ALL_LABEL}
        </button>
        <label className={`${BLOCK}__filter-label`} htmlFor={filterId}>
          {VERDICT_FILTER_LABEL}
        </label>
        <select
          className={`${BLOCK}__filter-control`}
          id={filterId}
          value={verdictFilter}
          onChange={handleFilterChange}
        >
          <option value={ALL_VERDICTS_VALUE}>{ALL_VERDICTS_OPTION_LABEL}</option>
          {VERDICT_PRECEDENCE.map((verdict) => (
            <option key={verdict} value={verdict}>
              {AGGREGATE_VERDICT_PRESENTATION[verdict].label}
            </option>
          ))}
        </select>
      </div>

      <section className={`${BLOCK}__aggregate`} aria-labelledby={aggregateHeadingId}>
        <h2 className={`${BLOCK}__aggregate-heading`} id={aggregateHeadingId}>
          {AGGREGATE_SECTION_HEADING}
        </h2>

        {resolution.state === 'loading' && <AggregateLoading labelId={loadingLabelId} />}
        {resolution.state === 'error' && (
          <AggregateError error={resolution.error} labelId={errorLabelId} />
        )}
        {resolution.state === 'resolved' && resolution.isEmpty && (
          <AggregateEmpty labelId={emptyLabelId} />
        )}
        {resolution.state === 'resolved' && !resolution.isEmpty && (
          <>
            <AggregateVerdict aggregate={aggregate} labelId={verdictLabelId} />
            <h3 className={`${BLOCK}__counts-heading`} id={countsHeadingId}>
              {VERDICT_COUNTS_HEADING}
            </h3>
            <VerdictCounts aggregate={aggregate} headingId={countsHeadingId} />
          </>
        )}
      </section>

      <section className={`${BLOCK}__controls`} aria-labelledby={controlsHeadingId}>
        <h2 className={`${BLOCK}__controls-heading`} id={controlsHeadingId}>
          {CONTROLS_SECTION_HEADING}
        </h2>

        {filteredVerdict === undefined ? null : (
          <p
            className={`${BLOCK}__state ${BLOCK}__state--filtered`}
            role="status"
            aria-labelledby={filterNoticeLabelId}
          >
            <strong id={filterNoticeLabelId}>{FILTER_NOTICE_LABEL}</strong>{' '}
            <span className={`${BLOCK}__state-detail`}>
              {`${hiddenCount} of ${CONTROL_IDS.length} controls are hidden by the ` +
                `"${filterVerdictLabel}" filter. The aggregate verdict above is computed from ` +
                `all ${CONTROL_IDS.length} controls, so no filter can hide a failing control ` +
                `from it.`}
            </span>
          </p>
        )}

        {visibleControlIds.length === 0 ? (
          <p
            className={`${BLOCK}__state ${BLOCK}__state--filter-empty`}
            role="status"
            aria-labelledby={filterEmptyLabelId}
          >
            <strong id={filterEmptyLabelId}>{FILTER_EMPTY_LABEL}</strong>{' '}
            <span className={`${BLOCK}__state-detail`}>
              {`No control holds the "${filterVerdictLabel}" verdict. Choose ` +
                `"${ALL_VERDICTS_OPTION_LABEL}" to see every control again.`}
            </span>
          </p>
        ) : (
          <ul className={`${BLOCK}__control-list`} aria-labelledby={controlsHeadingId}>
            {visibleControlIds.map((controlId) => (
              <li className={`${BLOCK}__control-item`} key={controlId} data-control-id={controlId}>
                <section
                  className={`${BLOCK}__control`}
                  aria-labelledby={`${baseId}-${controlId}-heading`}
                  data-control-id={controlId}
                  data-verdict={effectiveVerdicts[controlId]}
                >
                  <h3
                    className={`${BLOCK}__control-heading`}
                    id={`${baseId}-${controlId}-heading`}
                  >
                    {CONTROL_SECTION_TITLES[controlId]}
                  </h3>
                  {/*
                    EMBEDDED MODE (m3, m4). The provider tells the panel inside that this
                    document already has a heading for the control and already has a live
                    region for the collection transition:

                      * the panel renders no title of its own and names its region with the
                        `h3` above, so the run is h1 -> h2 -> h3 -> h4 instead of
                        h1 -> h2 -> h3 -> h2 with the control's name written twice;
                      * the panel's `status` and `alert` roles are dropped, so ONE aggregate
                        announcement is made for a transition that changes all eight cards
                        rather than nine competing ones.

                    Nothing the panel SAYS changes: every verdict, sentence and observation is
                    still rendered and still readable in place.
                  */}
                  <EmbeddedPanelProvider headingId={`${baseId}-${controlId}-heading`}>
                    {/*
                      m5 — THE SCOPED OVERFLOW LAYER. Each panel composes several wide tables,
                      and eight of them side by side previously relied on the PAGE scrolling
                      horizontally: at a narrow viewport the whole dashboard shifted, taking
                      the toolbar and the aggregate verdict off screen with it. Scrolling the
                      individual card instead keeps every other control, and the aggregate,
                      exactly where they were. Inline rather than a stylesheet because this
                      repository ships no design system and no CSS build (AAP §0.8.2), so the
                      style lives beside the markup it governs.
                    */}
                    <div className={`${BLOCK}__control-scroll`} style={CONTROL_SCROLL_STYLE}>
                      <ControlPanel
                        controlId={controlId}
                        status={statuses[controlId]}
                        result={panelResult}
                        onRefresh={panelRefresh}
                        canRefresh={canRefresh}
                      />
                    </div>
                  </EmbeddedPanelProvider>
                </section>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * The dashboard wired to the collection endpoint.
 *
 * Split out so that the data hook is mounted ONLY on the path that needs it. A
 * caller that supplies posture directly never renders this component, so no
 * request is issued and no network behaviour leaks into a deterministic render.
 *
 * `useControlStatus()` is called with no argument on purpose: that addresses the
 * collection, so all eight controls arrive in one response rather than in nine
 * independent ones. This module never calls `fetch` itself.
 */
function ConnectedPostureDashboard({
  onRefresh,
}: {
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  const result = useControlStatus();
  // Present on all three arms of the union, and stable across renders.
  const { refresh: reload } = result;

  // Refreshing re-issues the underlying request AND notifies the caller, in that
  // order, so a caller can observe a refresh without having to replace it.
  const refresh = useCallback((): void => {
    reload();
    onRefresh?.();
  }, [reload, onRefresh]);

  return <PostureDashboardView resolution={resolveFromResult(result)} onRefresh={refresh} />;
}

/** Props of {@link PostureDashboard}. Every one is optional. */
export interface PostureDashboardProps {
  /**
   * Already-resolved posture, keyed by control. Supplying it renders the
   * successful arm without issuing a request, which is how every scenario —
   * including a partially reported roster — is driven deterministically. A
   * control omitted from the map is judged `unknown`, never `pass`.
   */
  readonly statuses?: PostureStatusMap;
  /**
   * A pre-resolved hook state, for driving the loading, empty and error arms in
   * exactly the shape the hook produces them. Ignored when `statuses` is supplied,
   * because a map is the more specific instruction.
   */
  readonly result?: UseControlStatusResult;
  /**
   * Render the loading state. Takes precedence over `statuses` and `result`, so a
   * partially arrived roster can be shown as in flight rather than as resolved.
   */
  readonly isLoading?: boolean;
  /**
   * Render the failure state with this failure. Takes precedence over every other
   * prop: of the states this component can be asked to show, a failure is the one
   * that must never be overridden into something that could read as a pass.
   */
  readonly error?: ControlStatusError;
  /**
   * Invoked by the refresh control. On the connected path it runs in addition to
   * the hook's own refresh; on a caller-driven path it is the whole behaviour, and
   * omitting it disables the control rather than leaving a button that does
   * nothing.
   */
  readonly onRefresh?: () => void;
}

/**
 * The aggregate posture view across all eight hardening controls.
 *
 * INVARIANT LOCKED BY THIS COMPONENT: the aggregate posture is a pass ONLY when
 * every one of the eight controls is individually a pass. A single failing control
 * fails the aggregate, and any control that is unknown or errored makes a pass
 * impossible. A warning-only control is its own aggregate outcome and is never
 * absorbed into a clean pass. Nothing here is computed as a majority, a score, a
 * percentage or an average, because every one of those can read as a pass while a
 * control is violated.
 *
 * The roster is iterated from `CONTROL_IDS`, the hook module's single definition
 * site, and every per-control table in this file is keyed by `ControlId`, so a
 * control added, renamed or removed there is a compile error here rather than a
 * silently missing section.
 *
 * DATA SOURCE PRECEDENCE, evaluated in this order and documented because it is
 * what makes each scenario addressable:
 *
 *   1. `error`      — render the failure state. A failure is never overridden.
 *   2. `isLoading`  — render the loading state.
 *   3. `statuses`   — render the resolved state from the supplied map.
 *   4. `result`     — render whichever arm the supplied hook state carries.
 *   5. none of them — mount {@link ConnectedPostureDashboard} and read the
 *                     collection endpoint through `useControlStatus`.
 *
 * No hook is called on this path, so the early returns above cannot reorder one.
 * No error boundary is installed anywhere in this file: swallowing a render error
 * would let a failure look like a pass, which is the one thing this surface must
 * never do.
 *
 * @param props - see {@link PostureDashboardProps}; all members are optional.
 * @returns the `main` landmark containing the aggregate verdict and all eight
 *   per-control regions.
 */
export default function PostureDashboard({
  statuses,
  result,
  isLoading,
  error,
  onRefresh,
}: PostureDashboardProps = {}): ReactElement {
  if (error !== undefined) {
    return <PostureDashboardView resolution={{ state: 'error', error }} onRefresh={onRefresh} />;
  }
  if (isLoading === true) {
    return <PostureDashboardView resolution={{ state: 'loading' }} onRefresh={onRefresh} />;
  }
  if (statuses !== undefined) {
    const controls = orderControls(statuses);
    return (
      <PostureDashboardView
        resolution={{ state: 'resolved', controls, isEmpty: controls.length === 0 }}
        onRefresh={onRefresh}
      />
    );
  }
  if (result !== undefined) {
    return <PostureDashboardView resolution={resolveFromResult(result)} onRefresh={onRefresh} />;
  }
  return <ConnectedPostureDashboard onRefresh={onRefresh} />;
}
