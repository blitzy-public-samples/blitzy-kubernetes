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

// AAP §0.5.1 / §0.4.2.4 (L6 React tier, V4) / tech-spec §0.6.1
//
// The React presentation surface for V4 — ServiceAccount-token hygiene, feature
// F-004, requirements F-004-RQ-001 (audience-bound) and F-004-RQ-002
// (time-bound, claim shape unchanged).
//
// NO PARITY ANCESTOR. This tier ports nothing, and that is a measured fact
// rather than an omission: `blitzy/documentation/Project Guide.md` §4 records
// that this is "a control-plane/configuration project with no UI surface", so
// there is no prior component and no prior component test to be faithful to.
// AAP §0.4.1.1 therefore anchors the tier on the behaviour it surfaces instead
// — here, the token-request behaviour asserted by
// `test/integration/auth/svcaccttoken_test.go` L1433
// (`TestServiceAccountTokenBoundAndAudienced`), which is the origin of every
// required value below and is never modified by this workstream (AAP §0.5.1
// keeps the DELETE set empty so the Go suite remains the parity oracle).
//
// WHAT THE GO ORACLE ASSERTS, and therefore what this panel must render:
//
//   * L1436  the audience is exactly ["api"] — one element, that element.
//   * L1473  the requested lifetime is 3600 s, and L1290 re-asserts that the
//            returned request spec echoes it.
//   * L1478  `requestTime` is captured immediately BEFORE issuance, so the
//            window is measured from a reference instant the server supplies
//            rather than from whenever anything is later rendered.
//   * L1501  the `leeway` constant bounds BOTH observed values. Its value is
//            reproduced ONCE below, by `EXPIRY_LEEWAY_SECONDS`, so that this
//            file has exactly one place where the tolerance is written down.
//   * L1507  the JWT `exp` claim, and L1512 `Status.ExpirationTimestamp`
//            converted with `.Unix()`, must each satisfy
//            `!(value < centre-leeway || value > centre+leeway)` — an
//            INCLUSIVE bound at both edges, which is why a value sitting
//            exactly on an edge renders here as in window.
//   * L1521-1525  `sub` is `system:serviceaccount:<namespace>:<name>`,
//            `kubernetes.io.namespace` and `kubernetes.io.serviceaccount.name`
//            are present, and `kubernetes.io.pod` and `kubernetes.io.secret`
//            are both exactly null.
//
// The oracle reports those claim checks with `t.Errorf` (L1279), which
// accumulates and continues rather than aborting at the first mismatch. This
// panel mirrors that: EVERY check row is always rendered, so no finding can be
// hidden behind an earlier one (AAP §0.11.1, "preserve assertion semantics
// across languages").
//
// INVARIANTS LOCKED BY THIS COMPONENT (AAP §0.11.1, "never weaken a boundary
// condition to make a test pass"):
//
//   1. A projected token is audience-bound to EXACTLY ["api"] and time-bound so
//      that both its `exp` claim and its status expiration timestamp fall
//      within `requestTime + 3600 s` plus or minus the leeway, with the
//      `kubernetes.io.pod` and `kubernetes.io.secret` sub-claims null.
//   2. The tolerance is a single, fixed, module-private constant. It is neither
//      a prop nor read from the wire, so no caller can widen it. The server's
//      own reported tolerance is DISPLAYED for comparison and never used to
//      evaluate anything. Widening the window would make the check meaningless;
//      narrowing it would make it flaky.
//   3. The audience is compared for exact equality, never containment: an
//      audience carrying "api" alongside anything else is a finding.
//   4. Absent, unreadable or unrecognised evidence renders as "could not
//      verify" and NEVER as a pass, and a 403 or 500 renders the error
//      affordance, which structurally carries no verdict at all.
//   5. No token string, key or other credential material ever reaches the DOM.
//      EVERY server-supplied string is rendered through one of the two guards —
//      `presentValue` for measured values, `redactCredentialShapedText` for
//      prose and identifiers — so there is no render path that bypasses them.
//      An explicit `null` is still rendered as the visible text `null`, because
//      omitting that row would make a non-null regression invisible.
//   6. Nothing here reads a wall clock. Every instant used is one the props or
//      the hook supplied, so what is rendered is a function of its input.
//
// The only imports are `react` and the sibling hook module, both already fixed
// by AAP §0.6.1.2; no dependency is added (AAP §0.11.1, "respect the surviving
// freeze"). Data access is exclusively through `useControlStatus`, so this file
// calls `fetch` nowhere.
import { useId } from 'react';

import {
  selectControlStatus,
  useControlStatus,
  type ControlEvidence,
  type ControlExpiry,
  type ControlFinding,
  type ControlId,
  type ControlObservation,
  type ControlStatus,
  type ControlStatusError,
  type ControlVerdict,
  type UseControlStatusResult,
} from '../hooks/useControlStatus';

/** The control this panel reports on. Annotated so a typo cannot compile. */
const CONTROL_ID: ControlId = 'V4';

/**
 * The audience a projected token must be bound to — exactly this list, in this
 * order, with this cardinality (`svcaccttoken_test.go` L1436, L1470).
 */
const REQUIRED_AUDIENCES: readonly string[] = ['api'];

/**
 * The requested token lifetime, in seconds (`svcaccttoken_test.go` L1473). The
 * permitted window is centred on `requestTime` plus this value, and the value
 * is fixed here rather than taken from the wire so that a server reporting a
 * longer requested lifetime is reported as a mismatch instead of silently
 * re-centring the window around itself.
 */
const REQUIRED_TTL_SECONDS = 3600;

/**
 * The symmetric tolerance applied around the centre of the permitted window,
 * in seconds — the `leeway` of `svcaccttoken_test.go` L1501.
 *
 * THE SINGLE SOURCE OF TRUTH FOR THE TOLERANCE, and deliberately the only place
 * in this file where the number appears. It is a module-private constant: not a
 * prop, not a default, not read from {@link ControlExpiry.leewaySeconds}. The
 * value is engineered, not arbitrary — tight enough that a roughly one-year
 * long-lived-token regression still fails (a bare "expires in the future" check
 * would pass such a regression), and loose enough to absorb API round-trip and
 * scheduling jitter. Widening it makes the check meaningless; narrowing it makes
 * it flaky.
 */
const EXPIRY_LEEWAY_SECONDS = 60;

/** Rendered form of {@link EXPIRY_LEEWAY_SECONDS}, derived so it cannot drift. */
const TOLERANCE_LABEL = `\u00b1${EXPIRY_LEEWAY_SECONDS} s`;

/** Rendered form of the whole permitted window, derived for the same reason. */
const REQUIRED_WINDOW_LABEL = `requestTime + ${REQUIRED_TTL_SECONDS} s ${TOLERANCE_LABEL}`;

/**
 * The repository's own requirement identifiers for this control, used when the
 * server reports none. No external benchmark or hardening-guide control number
 * is named anywhere in this tier, because the repository enumerates none
 * (AAP §0.11.1, "cite only what the repository states").
 */
const REQUIREMENT_IDS: readonly string[] = ['F-004-RQ-001', 'F-004-RQ-002'];

/** Prefix of the canonical `sub` claim (`svcaccttoken_test.go` L1521). */
const SUBJECT_PREFIX = 'system:serviceaccount:';

/** Rendered when the server reported nothing for a field. */
const NOT_REPORTED = 'not reported';

/** Rendered in place of a value that must not be shown. See {@link presentValue}. */
const REDACTED = '[redacted]';

/**
 * Rendered for a reported-but-empty string, so that "" is distinguishable from
 * both `null` and {@link NOT_REPORTED} without the word `undefined` ever
 * appearing on screen.
 */
const EMPTY_STRING_LABEL = '(empty string)';

/**
 * Labels whose value is treated as credential-bearing and is never rendered.
 *
 * Invariant locked (AAP §0.11.1, "no secrets, ever"): a projected token is a
 * live credential, and a rendered one would sit in the DOM and in every
 * screenshot and snapshot taken of it. Matching is by label so that the guard
 * holds even for evidence this panel does not otherwise recognise.
 */
const SENSITIVE_LABEL_PATTERN = /token|secret|key|password|credential|bearer/i;

/**
 * A value shaped like a compact JSON Web Token: three non-empty base64url
 * segments separated by dots.
 *
 * Deliberately expressed as a shape rather than by matching the well-known
 * header prefix, so that this file contains no fragment of a token and the
 * guard still catches one whose header differs.
 */
const CREDENTIAL_SHAPED_VALUE = /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/;

/**
 * Longest string value rendered verbatim. Anything longer is redacted rather
 * than truncated: a truncated credential is still a leaked credential prefix.
 */
const MAX_RENDERED_VALUE_LENGTH = 200;

/**
 * One claim this panel reads out of {@link ControlEvidence.observations}.
 *
 * `aliases` are pre-normalised by {@link normaliseLabel}, which is what lets a
 * single entry match every spelling a server or a recorded fixture might use —
 * `kubernetes.io.pod`, `kubernetes.io/pod` and `pod` all normalise to the same
 * string. Matching is by alias rather than by position because observations are
 * an unordered bag.
 */
interface ClaimDescriptor {
  /** How the claim is named on screen, in its canonical dotted form. */
  readonly claimName: string;
  /** Normalised labels that identify this claim. */
  readonly aliases: readonly string[];
}

/** The `sub` claim: the canonical ServiceAccount subject. */
const SUBJECT_CLAIM: ClaimDescriptor = { claimName: 'sub', aliases: ['sub', 'subject'] };

/** The namespace half of the subject. */
const NAMESPACE_CLAIM: ClaimDescriptor = {
  claimName: 'kubernetes.io.namespace',
  aliases: ['kubernetesionamespace', 'namespace'],
};

/** The ServiceAccount-name half of the subject. */
const SERVICE_ACCOUNT_NAME_CLAIM: ClaimDescriptor = {
  claimName: 'kubernetes.io.serviceaccount.name',
  aliases: ['kubernetesioserviceaccountname', 'serviceaccountname'],
};

/** Must be null: a non-null value means the token is bound to a Pod. */
const POD_CLAIM: ClaimDescriptor = {
  claimName: 'kubernetes.io.pod',
  aliases: ['kubernetesiopod', 'pod'],
};

/** Must be null: a non-null value means a legacy Secret-backed token. */
const SECRET_CLAIM: ClaimDescriptor = {
  claimName: 'kubernetes.io.secret',
  aliases: ['kubernetesiosecret', 'secret'],
};

// ---------------------------------------------------------------------------
// Pure helper layer.
//
// Everything below is a total function of its arguments: no wall clock, no
// randomness, no module-level mutable state and no I/O. That is what makes the
// panel's output reproducible for a spec, and it is invariant 6 above.
// ---------------------------------------------------------------------------

/** The outcome of one check. `unknown` is "could not verify" — never a pass. */
type CheckOutcome = 'pass' | 'fail' | 'unknown';

/** How each {@link CheckOutcome} is worded on screen. */
const OUTCOME_LABEL: Readonly<Record<CheckOutcome, string>> = {
  pass: 'pass',
  fail: 'fail',
  unknown: 'could not verify',
};

/**
 * One row of a checks table: what was checked, what was required, what was
 * observed, and how the two compared.
 */
interface CheckRow {
  /** Stable list key, also emitted as a `data-check` attribute. */
  readonly id: string;
  /** Row header text, and the name a spec can query the row by. */
  readonly check: string;
  /** The requirement, in the same units as `observed`. */
  readonly required: string;
  /** What the server reported, presented but never reinterpreted. */
  readonly observed: string;
  /** How the comparison went, in words. */
  readonly detail: string;
  /** The machine-readable outcome. */
  readonly outcome: CheckOutcome;
}

/**
 * Relative severity of a verdict, used to combine several verdicts by taking
 * the strictest.
 *
 * `unknown` deliberately outranks `warn`: a control whose evidence could not be
 * read must not present as merely noisy, and the Go oracle makes the same
 * distinction when it treats a broken positive control as setup breakage rather
 * than as a finding.
 */
const VERDICT_SEVERITY: Readonly<Record<ControlVerdict, number>> = {
  pass: 0,
  warn: 1,
  unknown: 2,
  fail: 3,
};

/**
 * Combines verdicts by taking the strictest.
 *
 * Invariant locked: a verdict can only ever be made stricter here, never
 * softer, so no combination of inputs can turn a failed or unverifiable check
 * into a pass.
 *
 * @param verdicts - the verdicts to combine; an empty list is `pass`, which is
 *   only reachable when there is genuinely nothing to object to.
 * @returns the strictest verdict supplied.
 */
function strictestVerdict(verdicts: readonly ControlVerdict[]): ControlVerdict {
  return verdicts.reduce<ControlVerdict>(
    (strictest, candidate) =>
      VERDICT_SEVERITY[candidate] > VERDICT_SEVERITY[strictest] ? candidate : strictest,
    'pass',
  );
}

/**
 * Reduces a set of check rows to one verdict.
 *
 * Any failure fails the set; otherwise any unverifiable check makes the set
 * unverifiable; only an all-pass set passes.
 */
function verdictFromRows(rows: readonly CheckRow[]): ControlVerdict {
  if (rows.some((row) => row.outcome === 'fail')) {
    return 'fail';
  }
  if (rows.some((row) => row.outcome === 'unknown')) {
    return 'unknown';
  }
  return 'pass';
}

/**
 * Folds a label to a comparable form: lower case, alphanumerics only.
 *
 * This is applied to labels ONLY, never to values. A value is either rendered
 * verbatim or redacted; it is never folded, because the comparisons this panel
 * performs are exact ones.
 */
function normaliseLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Finds the observation carrying a claim.
 *
 * @param observations - the reported evidence, or `undefined` when none was.
 * @param descriptor - the claim to look for.
 * @returns the first matching observation, or `undefined`. First match wins so
 *   that the server's ordering is respected rather than silently re-ranked.
 */
function findObservation(
  observations: readonly ControlObservation[] | undefined,
  descriptor: ClaimDescriptor,
): ControlObservation | undefined {
  if (observations === undefined) {
    return undefined;
  }
  return observations.find((observation) =>
    descriptor.aliases.includes(normaliseLabel(observation.label)),
  );
}

/**
 * Renders one observed value as text, redacting anything credential-bearing.
 *
 * Invariant locked: `null` always renders as the visible text `null`, even for a
 * sensitive label, because the V4 oracle asserts that
 * `kubernetes.io.pod` and `kubernetes.io.secret` are exactly null and hiding
 * that row would make a non-null regression invisible. A non-null value under a
 * sensitive label is reported as redacted, which still reveals the regression —
 * the row stops saying `null` — without putting the value on screen.
 *
 * @param label - the reported label, used to decide sensitivity.
 * @param value - the reported value, verbatim.
 * @returns text safe to render.
 */
function presentValue(label: string, value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  if (value.length === 0) {
    return EMPTY_STRING_LABEL;
  }
  if (
    SENSITIVE_LABEL_PATTERN.test(label) ||
    CREDENTIAL_SHAPED_VALUE.test(value) ||
    value.length > MAX_RENDERED_VALUE_LENGTH
  ) {
    return REDACTED;
  }
  return value;
}

/**
 * Redacts credential-shaped words out of free prose before it is rendered.
 *
 * Summaries, details, findings and warnings are human-readable text rather than
 * measured values, so they are rendered as written — except for any single word
 * shaped like a compact token, which is replaced. Splitting on a capturing
 * whitespace group preserves the original spacing, so nothing else about the
 * text changes.
 *
 * This is the second half of invariant 5: {@link presentValue} guards measured
 * values, and this guards prose, so there is no path by which a credential
 * reaches the DOM.
 */
function redactCredentialShapedText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (CREDENTIAL_SHAPED_VALUE.test(part) ? REDACTED : part))
    .join('');
}

/** Renders a count of seconds with its unit, without altering the number. */
function formatSeconds(seconds: number): string {
  return `${seconds} s`;
}

/**
 * Renders an audience list in the same bracketed, quoted form the oracle uses
 * (`svcaccttoken_test.go` L1436), so the required and observed columns are
 * directly comparable by eye.
 *
 * Each element passes through {@link presentValue} under a non-sensitive label,
 * so an audience that somehow carried credential-shaped text is still redacted.
 */
function formatAudienceList(audiences: readonly string[]): string {
  const rendered = audiences.map((audience) => `"${presentValue('audience', audience)}"`);
  return `[${rendered.join(', ')}]`;
}

/**
 * Exact audience comparison.
 *
 * Invariant locked: cardinality, order and contents must all match. Containment
 * is NOT sufficient — an audience carrying "api" alongside anything else widens
 * where the token is accepted, which is precisely the weakness the control
 * closes.
 */
function audiencesMatchExactly(observed: readonly string[]): boolean {
  return (
    observed.length === REQUIRED_AUDIENCES.length &&
    observed.every((audience, index) => audience === REQUIRED_AUDIENCES[index])
  );
}

/** The permitted expiry window, in whole seconds since the Unix epoch. */
interface ExpiryWindow {
  /** `requestTime + REQUIRED_TTL_SECONDS`. */
  readonly centreSeconds: number;
  /** Inclusive lower bound. */
  readonly lowerSeconds: number;
  /** Inclusive upper bound. */
  readonly upperSeconds: number;
}

/**
 * Builds the permitted window from the reference instant.
 *
 * The centre uses {@link REQUIRED_TTL_SECONDS} and the half-width uses
 * {@link EXPIRY_LEEWAY_SECONDS}; neither is taken from the wire, so the window
 * is not something a payload can widen.
 */
function expiryWindow(requestTimeSeconds: number): ExpiryWindow {
  const centreSeconds = requestTimeSeconds + REQUIRED_TTL_SECONDS;
  return {
    centreSeconds,
    lowerSeconds: centreSeconds - EXPIRY_LEEWAY_SECONDS,
    upperSeconds: centreSeconds + EXPIRY_LEEWAY_SECONDS,
  };
}

/** Where an observed instant sits relative to the window. */
type WindowPosition = 'inside' | 'at-edge' | 'outside';

/**
 * Classifies an observed instant against the window.
 *
 * Invariant locked: the bound is INCLUSIVE, matching the oracle's
 * `value < lower || value > upper` rejection test (`svcaccttoken_test.go`
 * L1507, L1512). A value sitting exactly on either edge is therefore in window,
 * and is reported as `at-edge` so that the boundary case is separately
 * observable rather than merely folded into `inside`.
 */
function positionInWindow(value: number, permitted: ExpiryWindow): WindowPosition {
  if (value === permitted.lowerSeconds || value === permitted.upperSeconds) {
    return 'at-edge';
  }
  return value > permitted.lowerSeconds && value < permitted.upperSeconds ? 'inside' : 'outside';
}

/** How each {@link WindowPosition} is worded on screen. */
const WINDOW_POSITION_LABEL: Readonly<Record<WindowPosition, string>> = {
  inside: 'in window',
  'at-edge': 'in window (exactly on the window edge, which is inclusive)',
  outside: 'out of window',
};

/** A position is a pass unless it is outside; the edge counts as inside. */
function outcomeForPosition(position: WindowPosition): CheckOutcome {
  return position === 'outside' ? 'fail' : 'pass';
}

/**
 * Converts an RFC 3339 timestamp to whole seconds since the Unix epoch, the
 * Python-and-Go-agnostic equivalent of the oracle's `.Time.Unix()`
 * (`svcaccttoken_test.go` L1511).
 *
 * Truncation towards negative infinity matches `.Unix()`, which discards the
 * sub-second remainder rather than rounding it. `Date.parse` is used only on a
 * value the caller supplied, so this reads no clock.
 *
 * @returns the instant in seconds, or `undefined` when the string is not a
 *   timestamp this runtime can read.
 */
function timestampToUnixSeconds(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : Math.floor(milliseconds / 1000);
}

// ---------------------------------------------------------------------------
// Check-row builders. One builder per requirement group, each producing rows
// that are rendered unconditionally so that every check is reported — the
// accumulate-and-continue semantics of the oracle's `t.Errorf`.
// ---------------------------------------------------------------------------

/** Shown when no reference instant was reported and no window exists. */
const NO_WINDOW_DETAIL =
  'the permitted window could not be computed: no reference instant was reported';

/** Shown when a claim is absent from the reported evidence entirely. */
const CLAIM_NOT_REPORTED_DETAIL = 'the claim was not reported';

/**
 * Builds the audience checks (F-004-RQ-001).
 *
 * TWO rows on purpose. The values row would already fail a superset, but the
 * separate cardinality row states the "exactly, not merely contains" rule in
 * its own right, so a token audienced to more than one value produces two
 * distinct, individually queryable findings instead of one ambiguous mismatch.
 */
function buildAudienceRows(evidence: ControlEvidence | undefined): readonly CheckRow[] {
  const audiences = evidence?.audiences;
  const required = formatAudienceList(REQUIRED_AUDIENCES);
  const requiredCount = String(REQUIRED_AUDIENCES.length);

  if (audiences === undefined) {
    return [
      {
        id: 'audience-values',
        check: 'Audience values',
        required,
        observed: NOT_REPORTED,
        detail: 'no audience was reported',
        outcome: 'unknown',
      },
      {
        id: 'audience-count',
        check: 'Audience count',
        required: requiredCount,
        observed: NOT_REPORTED,
        detail: 'no audience was reported',
        outcome: 'unknown',
      },
    ];
  }

  const exact = audiencesMatchExactly(audiences);
  const countMatches = audiences.length === REQUIRED_AUDIENCES.length;
  return [
    {
      id: 'audience-values',
      check: 'Audience values',
      required,
      observed: formatAudienceList(audiences),
      detail: exact
        ? 'exact match'
        : 'not an exact match: the token is accepted somewhere it should not be',
      outcome: exact ? 'pass' : 'fail',
    },
    {
      id: 'audience-count',
      check: 'Audience count',
      required: requiredCount,
      observed: String(audiences.length),
      detail: countMatches
        ? 'exactly the required number of audiences'
        : 'the wrong number of audiences: containment is not sufficient',
      outcome: countMatches ? 'pass' : 'fail',
    },
  ];
}

/**
 * Builds one window check.
 *
 * @param id - stable row identifier.
 * @param check - row header text.
 * @param observed - the presented observed value.
 * @param observedSeconds - the observed instant in whole seconds, or
 *   `undefined` when it was absent or unreadable.
 * @param permitted - the permitted window, or `undefined` when it could not be
 *   computed.
 * @param missingDetail - wording used when `observedSeconds` is `undefined`,
 *   supplied by the caller so that "absent" and "unreadable" read differently.
 */
function buildWindowRow(
  id: string,
  check: string,
  observed: string,
  observedSeconds: number | undefined,
  permitted: ExpiryWindow | undefined,
  missingDetail: string,
): CheckRow {
  const required = REQUIRED_WINDOW_LABEL;
  if (observedSeconds === undefined) {
    return { id, check, required, observed, detail: missingDetail, outcome: 'unknown' };
  }
  if (permitted === undefined) {
    return { id, check, required, observed, detail: NO_WINDOW_DETAIL, outcome: 'unknown' };
  }
  const position = positionInWindow(observedSeconds, permitted);
  return {
    id,
    check,
    required,
    observed,
    detail: `${WINDOW_POSITION_LABEL[position]}, permitted ${formatSeconds(
      permitted.lowerSeconds,
    )} to ${formatSeconds(permitted.upperSeconds)}`,
    outcome: outcomeForPosition(position),
  };
}

/** The lifetime checks together with the window they were measured against. */
interface LifetimeChecks {
  /** The permitted window, or `undefined` when no reference instant was sent. */
  readonly permittedWindow: ExpiryWindow | undefined;
  /** The rows, always three of them. */
  readonly rows: readonly CheckRow[];
}

/**
 * Builds the lifetime checks (F-004-RQ-002).
 *
 * THREE rows, because the oracle makes three separate assertions: the echoed
 * request spec (`svcaccttoken_test.go` L1290), the JWT `exp` claim (L1507) and
 * the status expiration timestamp (L1512). Both observed instants are checked
 * against the same window, and each carries its own result, so a regression in
 * either one is visible on its own.
 */
function buildLifetimeChecks(evidence: ControlEvidence | undefined): LifetimeChecks {
  const expiry: ControlExpiry | undefined = evidence?.observedExpiry;
  const requestTimeSeconds = expiry?.requestTimeSeconds;
  const permittedWindow =
    requestTimeSeconds === undefined ? undefined : expiryWindow(requestTimeSeconds);

  const requestedTtl = evidence?.requestedTtlSeconds;
  const ttlMatches = requestedTtl === REQUIRED_TTL_SECONDS;
  const requestedTtlRow: CheckRow = {
    id: 'requested-ttl',
    check: 'Requested lifetime',
    required: formatSeconds(REQUIRED_TTL_SECONDS),
    observed: requestedTtl === undefined ? NOT_REPORTED : formatSeconds(requestedTtl),
    detail:
      requestedTtl === undefined
        ? 'no requested lifetime was reported'
        : ttlMatches
          ? 'the echoed request spec matches the requested lifetime'
          : 'the echoed request spec does not match the requested lifetime',
    outcome: requestedTtl === undefined ? 'unknown' : ttlMatches ? 'pass' : 'fail',
  };

  const expirySeconds = expiry?.expirySeconds;
  const expRow = buildWindowRow(
    'jwt-exp',
    'JWT exp claim',
    expirySeconds === undefined ? NOT_REPORTED : formatSeconds(expirySeconds),
    expirySeconds,
    permittedWindow,
    'the exp claim was not reported',
  );

  const rawTimestamp = expiry?.expirationTimestamp;
  const timestampSeconds =
    rawTimestamp === undefined ? undefined : timestampToUnixSeconds(rawTimestamp);
  const timestampRow = buildWindowRow(
    'status-expiration',
    'Status expiration timestamp',
    rawTimestamp === undefined ? NOT_REPORTED : presentValue('expiration timestamp', rawTimestamp),
    timestampSeconds,
    permittedWindow,
    rawTimestamp === undefined
      ? 'the status expiration timestamp was not reported'
      : 'the reported timestamp could not be read as an instant',
  );

  return { permittedWindow, rows: [requestedTtlRow, expRow, timestampRow] };
}

/** The five claim observations this panel reads, matched by label alias. */
interface ClaimReadings {
  readonly subject: ControlObservation | undefined;
  readonly namespace: ControlObservation | undefined;
  readonly serviceAccountName: ControlObservation | undefined;
  readonly pod: ControlObservation | undefined;
  readonly secret: ControlObservation | undefined;
}

/** Resolves every claim this panel knows about out of the reported evidence. */
function readClaims(
  observations: readonly ControlObservation[] | undefined,
): ClaimReadings {
  return {
    subject: findObservation(observations, SUBJECT_CLAIM),
    namespace: findObservation(observations, NAMESPACE_CLAIM),
    serviceAccountName: findObservation(observations, SERVICE_ACCOUNT_NAME_CLAIM),
    pod: findObservation(observations, POD_CLAIM),
    secret: findObservation(observations, SECRET_CLAIM),
  };
}

/**
 * Derives the canonical subject from the namespace and ServiceAccount-name
 * claims, exactly as the oracle builds its expectation
 * (`svcaccttoken_test.go` L1521).
 *
 * @returns the expected `sub` value, or `undefined` when either half is missing,
 *   in which case the subject check reports that it could not be verified
 *   rather than inventing an expectation.
 */
function expectedSubject(readings: ClaimReadings): string | undefined {
  const namespace = readings.namespace?.value;
  const name = readings.serviceAccountName?.value;
  if (typeof namespace !== 'string' || namespace.length === 0) {
    return undefined;
  }
  if (typeof name !== 'string' || name.length === 0) {
    return undefined;
  }
  return `${SUBJECT_PREFIX}${namespace}:${name}`;
}

/** Builds the `sub` check. */
function buildSubjectRow(readings: ClaimReadings): CheckRow {
  const expected = expectedSubject(readings);
  const required = expected ?? `${SUBJECT_PREFIX}<namespace>:<serviceaccount name>`;
  const observation = readings.subject;
  const base = { id: 'claim-sub', check: SUBJECT_CLAIM.claimName, required };

  if (observation === undefined) {
    return { ...base, observed: NOT_REPORTED, detail: CLAIM_NOT_REPORTED_DETAIL, outcome: 'unknown' };
  }
  const observed = presentValue(observation.label, observation.value);
  if (expected === undefined) {
    return {
      ...base,
      observed,
      detail:
        'the expected subject could not be derived: the namespace or ServiceAccount name claim was not reported',
      outcome: 'unknown',
    };
  }
  const matches = observation.value === expected;
  return {
    ...base,
    observed,
    detail: matches ? 'matches the canonical subject' : 'does not match the canonical subject',
    outcome: matches ? 'pass' : 'fail',
  };
}

/** Builds a "must be a non-empty string" claim check. */
function buildPresenceRow(
  id: string,
  descriptor: ClaimDescriptor,
  observation: ControlObservation | undefined,
): CheckRow {
  const base = { id, check: descriptor.claimName, required: 'a non-empty string' };
  if (observation === undefined) {
    return { ...base, observed: NOT_REPORTED, detail: CLAIM_NOT_REPORTED_DETAIL, outcome: 'unknown' };
  }
  const present = typeof observation.value === 'string' && observation.value.length > 0;
  return {
    ...base,
    observed: presentValue(observation.label, observation.value),
    detail: present ? 'present' : 'reported, but not as a non-empty string',
    outcome: present ? 'pass' : 'fail',
  };
}

/**
 * Builds a "must be exactly null" claim check.
 *
 * Invariant locked: the row is ALWAYS rendered, and a null value is rendered as
 * the visible text `null`. Omitting the row when the value is null — the
 * expected case — would make a non-null regression invisible, which is the one
 * thing this check exists to catch.
 */
function buildNullRow(
  id: string,
  descriptor: ClaimDescriptor,
  observation: ControlObservation | undefined,
): CheckRow {
  const base = { id, check: descriptor.claimName, required: 'null' };
  if (observation === undefined) {
    return { ...base, observed: NOT_REPORTED, detail: CLAIM_NOT_REPORTED_DETAIL, outcome: 'unknown' };
  }
  const isNull = observation.value === null;
  return {
    ...base,
    observed: presentValue(observation.label, observation.value),
    detail: isNull
      ? 'null, so the token is not bound to that object'
      : 'not null, which indicates a legacy or object-bound token',
    outcome: isNull ? 'pass' : 'fail',
  };
}

/** Builds all five claim-shape checks (F-004-RQ-002). */
function buildClaimRows(readings: ClaimReadings): readonly CheckRow[] {
  return [
    buildSubjectRow(readings),
    buildPresenceRow('claim-namespace', NAMESPACE_CLAIM, readings.namespace),
    buildPresenceRow('claim-serviceaccount-name', SERVICE_ACCOUNT_NAME_CLAIM, readings.serviceAccountName),
    buildNullRow('claim-pod', POD_CLAIM, readings.pod),
    buildNullRow('claim-secret', SECRET_CLAIM, readings.secret),
  ];
}

/**
 * The observations this panel did not recognise as one of the five claims.
 *
 * Reported rather than discarded, so that evidence is never silently dropped;
 * every value still passes through {@link presentValue}, so an unrecognised
 * observation cannot become a way to smuggle a credential onto the screen.
 */
function unrecognisedObservations(
  observations: readonly ControlObservation[] | undefined,
  readings: ClaimReadings,
): readonly ControlObservation[] {
  if (observations === undefined) {
    return [];
  }
  const recognised = [
    readings.subject,
    readings.namespace,
    readings.serviceAccountName,
    readings.pod,
    readings.secret,
  ];
  return observations.filter((observation) => !recognised.includes(observation));
}

/** Everything the panel needs to render one control payload. */
interface PanelAnalysis {
  /** The strictest of the server's verdict, the recomputed rows and warnings. */
  readonly overallVerdict: ControlVerdict;
  /** The audience list as reported, or `undefined` when none was. */
  readonly audiences: readonly string[] | undefined;
  readonly audienceRows: readonly CheckRow[];
  /** The reference instant, for the window description. */
  readonly requestTimeSeconds: number | undefined;
  /** The tolerance the server reported, shown but never used to evaluate. */
  readonly reportedLeewaySeconds: number | undefined;
  /** The window both observed instants were measured against. */
  readonly permittedWindow: ExpiryWindow | undefined;
  readonly lifetimeRows: readonly CheckRow[];
  readonly claimRows: readonly CheckRow[];
  readonly extraObservations: readonly ControlObservation[];
}

/**
 * Reduces one control payload to everything the panel renders.
 *
 * Invariant locked: the rendered verdict is the STRICTEST of what the server
 * said, what recomputing the checks says, and whether any warning was reported.
 * A server claiming `pass` over failing evidence is therefore rendered as
 * `fail`, and no combination of inputs can soften a verdict.
 */
function analyseControl(control: ControlStatus): PanelAnalysis {
  const evidence = control.evidence;
  const observations = evidence?.observations;
  const readings = readClaims(observations);
  const audienceRows = buildAudienceRows(evidence);
  const lifetime = buildLifetimeChecks(evidence);
  const claimRows = buildClaimRows(readings);
  const warningVerdict: ControlVerdict = control.warnings.length > 0 ? 'warn' : 'pass';

  return {
    overallVerdict: strictestVerdict([
      control.verdict,
      verdictFromRows([...audienceRows, ...lifetime.rows, ...claimRows]),
      warningVerdict,
    ]),
    audiences: evidence?.audiences,
    audienceRows,
    requestTimeSeconds: evidence?.observedExpiry?.requestTimeSeconds,
    reportedLeewaySeconds: evidence?.observedExpiry?.leewaySeconds,
    permittedWindow: lifetime.permittedWindow,
    lifetimeRows: lifetime.rows,
    claimRows,
    extraObservations: unrecognisedObservations(observations, readings),
  };
}

// ---------------------------------------------------------------------------
// Presentation.
//
// Semantic HTML only: section, h2/h3, dl, ul, table and button. No design
// system, no CSS framework, no icon library and no inline style — the class
// names below are BEM seams for a stylesheet this tier does not ship, and every
// affordance is reachable through its role and accessible name so that neither
// colour nor position ever carries meaning on its own.
// ---------------------------------------------------------------------------

/** BEM block name, and the seam a stylesheet would attach to. */
const BLOCK = 'token-hygiene-panel';

/** Element ids used for the accessible names of the panel and its sections. */
interface PanelIds {
  readonly heading: string;
  readonly audience: string;
  readonly lifetime: string;
  readonly claims: string;
  readonly other: string;
  readonly findings: string;
  readonly warnings: string;
}

/** Renders one checks table. Column headers make every cell addressable. */
function ChecksTable({
  caption,
  rows,
}: {
  readonly caption: string;
  readonly rows: readonly CheckRow[];
}) {
  return (
    <table className={`${BLOCK}__checks`}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Required</th>
          <th scope="col">Observed</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-check={row.id} data-outcome={row.outcome}>
            <th scope="row">{row.check}</th>
            <td>{row.required}</td>
            <td>{row.observed}</td>
            <td>{`${row.detail} \u2014 ${OUTCOME_LABEL[row.outcome]}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Renders the observed audience list.
 *
 * Three distinct outcomes, because "no audience was reported" and "the audience
 * was reported as empty" are different claims about the token and only one of
 * them is a finding about its binding.
 */
function AudienceList({ audiences }: { readonly audiences: readonly string[] | undefined }) {
  if (audiences === undefined) {
    return <p className={`${BLOCK}__audience-none`}>No audience was reported for this token.</p>;
  }
  if (audiences.length === 0) {
    return (
      <p className={`${BLOCK}__audience-empty`}>The server reported an empty audience list.</p>
    );
  }
  return (
    <ul className={`${BLOCK}__audience-values`} aria-label="Observed audiences">
      {audiences.map((audience, index) => (
        <li key={`${String(index)}-${audience}`}>{presentValue('audience', audience)}</li>
      ))}
    </ul>
  );
}

/** The audience-binding section (F-004-RQ-001). */
function AudienceSection({
  audiences,
  rows,
  headingId,
}: {
  readonly audiences: readonly string[] | undefined;
  readonly rows: readonly CheckRow[];
  readonly headingId: string;
}) {
  return (
    <section className={`${BLOCK}__section`} aria-labelledby={headingId}>
      <h3 id={headingId}>Audience binding</h3>
      <p>
        {`Required: exactly ${formatAudienceList(
          REQUIRED_AUDIENCES,
        )} (F-004-RQ-001). An audience carrying any further value alongside it is a finding, not a pass.`}
      </p>
      <AudienceList audiences={audiences} />
      <ChecksTable caption="Audience binding checks" rows={rows} />
    </section>
  );
}

/**
 * Describes the permitted window.
 *
 * The tolerance actually applied and the tolerance the server reported are
 * listed as SEPARATE entries on purpose: the first is this panel's fixed
 * constant and the second is data. Showing both makes it plain that the wire
 * cannot move the window, which is invariant 2.
 */
function WindowDescription({
  requestTimeSeconds,
  reportedLeewaySeconds,
  permittedWindow,
}: {
  readonly requestTimeSeconds: number | undefined;
  readonly reportedLeewaySeconds: number | undefined;
  readonly permittedWindow: ExpiryWindow | undefined;
}) {
  return (
    <dl className={`${BLOCK}__window`}>
      <dt>Reference instant (requestTime)</dt>
      <dd>
        {requestTimeSeconds === undefined ? NOT_REPORTED : formatSeconds(requestTimeSeconds)}
      </dd>

      <dt>Required lifetime</dt>
      <dd>{formatSeconds(REQUIRED_TTL_SECONDS)}</dd>

      <dt>Tolerance applied</dt>
      <dd>{TOLERANCE_LABEL}</dd>

      <dt>Permitted window</dt>
      <dd>
        {permittedWindow === undefined
          ? NO_WINDOW_DETAIL
          : `${formatSeconds(permittedWindow.lowerSeconds)} to ${formatSeconds(
              permittedWindow.upperSeconds,
            )}, centred on ${formatSeconds(permittedWindow.centreSeconds)}`}
      </dd>

      <dt>Tolerance reported by the server</dt>
      <dd>
        {reportedLeewaySeconds === undefined
          ? NOT_REPORTED
          : formatSeconds(reportedLeewaySeconds)}
      </dd>
    </dl>
  );
}

/** The token-lifetime section (F-004-RQ-002) — the centrepiece of the panel. */
function LifetimeSection({
  requestTimeSeconds,
  reportedLeewaySeconds,
  permittedWindow,
  rows,
  headingId,
}: {
  readonly requestTimeSeconds: number | undefined;
  readonly reportedLeewaySeconds: number | undefined;
  readonly permittedWindow: ExpiryWindow | undefined;
  readonly rows: readonly CheckRow[];
  readonly headingId: string;
}) {
  return (
    <section className={`${BLOCK}__section`} aria-labelledby={headingId}>
      <h3 id={headingId}>Token lifetime</h3>
      <p>
        {`Required: ${REQUIRED_WINDOW_LABEL} (F-004-RQ-002). Both the JWT exp claim and the status expiration timestamp are checked against that window, and each carries its own result.`}
      </p>
      <p className={`${BLOCK}__boundary-rule`}>
        {`Boundary case: a value sitting exactly on either edge of the window is in window, because the ${TOLERANCE_LABEL} bound is inclusive.`}
      </p>
      <WindowDescription
        requestTimeSeconds={requestTimeSeconds}
        reportedLeewaySeconds={reportedLeewaySeconds}
        permittedWindow={permittedWindow}
      />
      <ChecksTable caption="Token lifetime checks" rows={rows} />
    </section>
  );
}

/** The claim-shape section (F-004-RQ-002). */
function ClaimShapeSection({
  rows,
  headingId,
}: {
  readonly rows: readonly CheckRow[];
  readonly headingId: string;
}) {
  return (
    <section className={`${BLOCK}__section`} aria-labelledby={headingId}>
      <h3 id={headingId}>Claim shape</h3>
      <p>
        {`Required: the canonical subject, the namespace and ServiceAccount name claims present, and the pod and secret sub-claims exactly null (F-004-RQ-002). Every row is shown whatever its value, so a non-null pod or secret claim cannot hide.`}
      </p>
      <ChecksTable caption="Claim shape checks" rows={rows} />
    </section>
  );
}

/** Anything reported that this panel did not recognise as one of the claims. */
function OtherEvidenceSection({
  observations,
  headingId,
}: {
  readonly observations: readonly ControlObservation[];
  readonly headingId: string;
}) {
  return (
    <section className={`${BLOCK}__section`} aria-labelledby={headingId}>
      <h3 id={headingId}>Other reported evidence</h3>
      {observations.length === 0 ? (
        <p>No further evidence was reported.</p>
      ) : (
        <table className={`${BLOCK}__other-evidence`}>
          <caption>Other reported evidence</caption>
          <thead>
            <tr>
              <th scope="col">Measurement</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {observations.map((observation, index) => (
              <tr key={`${String(index)}-${observation.label}`}>
                <th scope="row">{redactCredentialShapedText(observation.label)}</th>
                <td>{presentValue(observation.label, observation.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Renders one finding as a single line: message, subject and requirement. */
function describeFinding(finding: ControlFinding): string {
  const parts = [redactCredentialShapedText(finding.message)];
  if (finding.subject !== undefined) {
    parts.push(`subject: ${redactCredentialShapedText(finding.subject)}`);
  }
  if (finding.requirementId !== undefined) {
    parts.push(`requirement: ${redactCredentialShapedText(finding.requirementId)}`);
  }
  return parts.join(' \u2014 ');
}

/**
 * Every reported finding, never only the first.
 *
 * Mirrors the accumulate-and-continue semantics of the oracle's `t.Errorf`: the
 * list is rendered in full and in server order, and the no-findings case gets
 * its own sentence rather than an empty list.
 */
function FindingsSection({
  findings,
  headingId,
}: {
  readonly findings: readonly ControlFinding[];
  readonly headingId: string;
}) {
  return (
    <section className={`${BLOCK}__section`} aria-labelledby={headingId}>
      <h3 id={headingId}>Findings</h3>
      {findings.length === 0 ? (
        <p>No findings were reported for this control.</p>
      ) : (
        <ul className={`${BLOCK}__findings`} aria-label="Reported findings">
          {findings.map((finding, index) => (
            <li key={`${String(index)}-${finding.message}`}>{describeFinding(finding)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every server warning, verbatim apart from credential redaction. */
function WarningsSection({
  warnings,
  headingId,
}: {
  readonly warnings: readonly string[];
  readonly headingId: string;
}) {
  return (
    <section className={`${BLOCK}__section`} aria-labelledby={headingId}>
      <h3 id={headingId}>Server warnings</h3>
      {warnings.length === 0 ? (
        <p>No warnings were reported for this control.</p>
      ) : (
        <ul className={`${BLOCK}__warnings`} aria-label="Server warnings">
          {warnings.map((warning, index) => (
            <li key={`${String(index)}-${warning}`}>{redactCredentialShapedText(warning)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The four states: loading, error, empty and success. Each is a distinct
// affordance, and only the success body renders a verdict at all.
// ---------------------------------------------------------------------------

/** The request is in flight. */
function LoadingBody() {
  return (
    <p className={`${BLOCK}__loading`} role="status">
      Requesting the ServiceAccount token posture.
    </p>
  );
}

/**
 * No verdict could be obtained.
 *
 * Invariant locked (invariant 4): this body renders the failure and NOTHING
 * else. There is no verdict element here, and the panel's `data-verdict`
 * attribute is absent, so a 403 or a 500 cannot present as a pass. The error
 * arm of {@link UseControlStatusResult} carries no `controls` member, so that is
 * enforced by the compiler rather than by this comment.
 */
function ErrorBody({ error }: { readonly error: ControlStatusError }) {
  return (
    <div className={`${BLOCK}__error`}>
      <p role="alert">
        {`Posture could not be read, so no verdict is shown: ${redactCredentialShapedText(
          error.message,
        )}`}
      </p>
      <dl className={`${BLOCK}__error-detail`}>
        <dt>Failure kind</dt>
        <dd>{error.kind}</dd>

        <dt>HTTP status</dt>
        <dd>{error.httpStatus === undefined ? NOT_REPORTED : String(error.httpStatus)}</dd>

        <dt>Server reason</dt>
        <dd>
          {error.reason === undefined ? NOT_REPORTED : redactCredentialShapedText(error.reason)}
        </dd>
      </dl>
    </div>
  );
}

/**
 * The request succeeded but carried no posture for this control.
 *
 * Two sentences, because "the server reported nothing at all" and "the server
 * reported other controls but not this one" are different situations, and the
 * successful result's `isEmpty` member exists precisely so the difference is
 * observable without counting a list at the call site.
 */
function EmptyBody({ isEmpty }: { readonly isEmpty: boolean }) {
  return (
    <p className={`${BLOCK}__empty`} role="status">
      {isEmpty
        ? `The server reported no control posture at all, so there is nothing to show for ${CONTROL_ID}.`
        : `The server reported posture for other controls but none for ${CONTROL_ID}, so there is nothing to show.`}
    </p>
  );
}

/** The full evidence render. */
function SuccessBody({
  control,
  analysis,
  ids,
}: {
  readonly control: ControlStatus;
  readonly analysis: PanelAnalysis;
  readonly ids: PanelIds;
}) {
  return (
    <div className={`${BLOCK}__body`}>
      {/*
        <output> is the native element for the result of a calculation, and it is
        the ONLY live region in this body: one announcement per evaluation rather
        than one per row, which is why the individual results live in table cells
        instead.
      */}
      <output className={`${BLOCK}__verdict`}>
        {`Overall verdict: ${analysis.overallVerdict}`}
      </output>
      <p className={`${BLOCK}__summary`}>{redactCredentialShapedText(control.summary)}</p>
      {control.detail === undefined ? null : (
        <p className={`${BLOCK}__detail`}>{redactCredentialShapedText(control.detail)}</p>
      )}
      <p className={`${BLOCK}__observed-at`}>
        {`Evaluated at: ${
          control.observedAt === undefined
            ? NOT_REPORTED
            : redactCredentialShapedText(control.observedAt)
        }`}
      </p>

      <AudienceSection
        audiences={analysis.audiences}
        rows={analysis.audienceRows}
        headingId={ids.audience}
      />
      <LifetimeSection
        requestTimeSeconds={analysis.requestTimeSeconds}
        reportedLeewaySeconds={analysis.reportedLeewaySeconds}
        permittedWindow={analysis.permittedWindow}
        rows={analysis.lifetimeRows}
        headingId={ids.lifetime}
      />
      <ClaimShapeSection rows={analysis.claimRows} headingId={ids.claims} />
      <OtherEvidenceSection observations={analysis.extraObservations} headingId={ids.other} />
      <FindingsSection findings={control.findings} headingId={ids.findings} />
      <WarningsSection warnings={control.warnings} headingId={ids.warnings} />
    </div>
  );
}

/** Which affordance the panel is showing. Also emitted as `data-state`. */
type PanelState = 'loading' | 'error' | 'empty' | 'success';

/**
 * The panel itself, rendering whichever state the supplied result describes.
 *
 * Kept separate from the exported wrapper so that the wrapper can decide whether
 * to drive the panel from a prop or from the hook without ever calling a hook
 * conditionally.
 */
function TokenHygieneView({
  result,
  headingId,
}: {
  readonly result: UseControlStatusResult;
  readonly headingId?: string;
}) {
  // One generated prefix per mounted panel, so several panels on one page keep
  // unique ids without the caller having to supply any.
  const generatedId = useId();
  const base = headingId ?? `${BLOCK}-${generatedId}`;
  const ids: PanelIds = {
    heading: base,
    audience: `${base}-audience`,
    lifetime: `${base}-lifetime`,
    claims: `${base}-claims`,
    other: `${base}-other`,
    findings: `${base}-findings`,
    warnings: `${base}-warnings`,
  };

  const control =
    result.status === 'success' ? selectControlStatus(result.controls, CONTROL_ID) : undefined;
  const analysis = control === undefined ? undefined : analyseControl(control);

  const state: PanelState =
    result.status === 'loading'
      ? 'loading'
      : result.status === 'error'
        ? 'error'
        : control === undefined
          ? 'empty'
          : 'success';

  // The server's own identifiers when it sent any, otherwise this repository's.
  const reportedRequirementIds = control?.requirementIds;
  const requirementIds =
    reportedRequirementIds !== undefined && reportedRequirementIds.length > 0
      ? reportedRequirementIds
      : REQUIREMENT_IDS;

  return (
    <section
      className={BLOCK}
      aria-labelledby={ids.heading}
      aria-busy={state === 'loading'}
      data-control-id={CONTROL_ID}
      data-state={state}
      data-verdict={analysis?.overallVerdict}
    >
      <h2 id={ids.heading}>ServiceAccount token hygiene ({CONTROL_ID})</h2>
      <p className={`${BLOCK}__requirements`}>
        {`Requirements covered: ${requirementIds
          .map((identifier) => redactCredentialShapedText(identifier))
          .join(', ')}`}
      </p>
      {/*
        Always rendered and always operable, in every state, so the affordance's
        presence does not depend on how the panel happens to be fed. A native
        button is focusable and activates on both Enter and Space with no extra
        handling.
      */}
      <button type="button" className={`${BLOCK}__refresh`} onClick={result.refresh}>
        Re-request token posture
      </button>

      {result.status === 'loading' ? <LoadingBody /> : null}
      {result.status === 'error' ? <ErrorBody error={result.error} /> : null}
      {result.status === 'success' && control === undefined ? (
        <EmptyBody isEmpty={result.isEmpty} />
      ) : null}
      {control !== undefined && analysis !== undefined ? (
        <SuccessBody control={control} analysis={analysis} ids={ids} />
      ) : null}
    </section>
  );
}

/** Drives the panel from the hook. Exists so the hook call is unconditional. */
function TokenHygieneConnected({ headingId }: { readonly headingId?: string }) {
  const result = useControlStatus(CONTROL_ID);
  return <TokenHygieneView result={result} headingId={headingId} />;
}

/**
 * Used when a pre-resolved payload is supplied without a refresh handler.
 *
 * Not a stub: with a pre-resolved payload there is genuinely no request to
 * re-issue, and the affordance is still rendered and still operable so that it
 * is present in every state.
 */
function noRefresh(): void {
  // Deliberately empty. See the note above.
}

/**
 * Props for {@link TokenHygienePanel}.
 *
 * All optional. Supplied in isolation the panel fetches its own posture; supplied
 * with `result` or `status` it renders exactly what it was given and issues no
 * request at all, which is what makes it drivable from a fixture.
 *
 * Precedence, highest first: `result`, then `status`, then the hook.
 */
export interface TokenHygienePanelProps {
  /**
   * A pre-resolved hook state. Use this to render the loading, empty or error
   * affordance directly, since those states cannot be expressed by `status`.
   */
  readonly result?: UseControlStatusResult;
  /**
   * A pre-resolved control payload, rendered as a successful single-control
   * result. Ignored when `result` is also supplied.
   */
  readonly status?: ControlStatus;
  /**
   * Invoked by the re-request button when the panel is driven by `status`.
   * Ignored when `result` is supplied, because that state carries its own
   * refresh handle, and unnecessary when the hook is driving.
   */
  readonly onRefresh?: () => void;
  /**
   * Overrides the generated id used for the panel's accessible name, and the
   * prefix of every section id. Supply it when the surrounding page needs a
   * stable, known id; otherwise one is generated per mounted panel.
   */
  readonly headingId?: string;
}

/**
 * The V4 posture panel: ServiceAccount-token hygiene.
 *
 * INVARIANT LOCKED: a projected token is audience-bound to exactly `["api"]` and
 * time-bound so that BOTH its JWT `exp` claim and its status expiration
 * timestamp fall within `requestTime + 3600 s` plus or minus the fixed
 * tolerance, with the `kubernetes.io.pod` and `kubernetes.io.secret` sub-claims
 * null. Every check is rendered whatever its outcome; an unverifiable check
 * reads "could not verify" and never "pass"; a 403 or 500 renders the error
 * affordance and no verdict; and no token, key or other credential material is
 * ever rendered.
 *
 * @example Driven by the hook, fetching its own posture:
 * ```tsx
 * <TokenHygienePanel />
 * ```
 *
 * @example Driven by a recorded payload, issuing no request:
 * ```tsx
 * <TokenHygienePanel status={recordedV4Status} onRefresh={handleRefresh} />
 * ```
 *
 * @example Driven by an explicit state, to render the error affordance:
 * ```tsx
 * <TokenHygienePanel result={{ status: 'error', error, refresh: handleRefresh }} />
 * ```
 */
export default function TokenHygienePanel({
  result,
  status,
  onRefresh,
  headingId,
}: TokenHygienePanelProps) {
  if (result !== undefined) {
    return <TokenHygieneView result={result} headingId={headingId} />;
  }
  if (status !== undefined) {
    return (
      <TokenHygieneView
        result={{
          status: 'success',
          controls: [status],
          isEmpty: false,
          refresh: onRefresh ?? noRefresh,
        }}
        headingId={headingId}
      />
    );
  }
  // No hook is called on either branch above, so this is a stable choice of
  // component per call site rather than a conditional hook.
  return <TokenHygieneConnected headingId={headingId} />;
}

/**
 * Named alias for the default export above, which remains the authoritative
 * one.
 *
 * Both `import TokenHygienePanel from './TokenHygienePanel'` and
 * `import { TokenHygienePanel } from './TokenHygienePanel'` therefore resolve to
 * the same component. This is a deliberate one-line accommodation rather than a
 * second API: an aggregate view or a spec that reaches for the named form gets a
 * working import instead of a module-resolution failure, and because both names
 * are the same binding they cannot drift apart.
 */
export { TokenHygienePanel };
