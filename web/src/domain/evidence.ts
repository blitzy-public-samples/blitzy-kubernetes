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
 * Reading measured evidence out of a control payload: exactly, once, and without coercing.
 *
 * AAP §0.10.2 (the boundary conditions these readers must not soften) / §0.7.2 (failure
 * legibility and assertion density) / §0.11.1 ("never weaken a boundary condition") /
 * tech-spec §6.6.
 *
 * THE THREE FAILURE MODES THIS MODULE EXISTS TO REMOVE, all of which were present across
 * the eight panels and each of which renders a PASS the evidence does not support:
 *
 * 1. FUZZY MATCHING. A panel that classified an observation by keyword — `label.includes`
 *    over a keyword table — cannot distinguish two observations whose labels share a
 *    substring. The V3 payload is the proof: it carries BOTH `plaintext canary` (whose
 *    value is the canary STRING) and `plaintext canary present in raw blob` (whose value
 *    is the boolean `false`). Keyword matching classified both as "the canary" and took
 *    the first, read a non-empty string as truthy, and reported the canary PRESENT — a
 *    FAIL rendered over a recorded PASS. Exact identity makes the two unmistakable.
 * 2. FIRST-MATCH-WINS. `find` over a list silently ignores a second occurrence. If the
 *    two disagree, which one is believed depends on the order the server serialised
 *    them in. A conflict must degrade the verdict, not be resolved by luck.
 * 3. COERCION. Reading `'false'` as a boolean, or `'403'` as a number, invents evidence.
 *    `403` and `'403'` mean different things about a server that produced one of them,
 *    and the V2 and V7 controls assert an exact 403.
 *
 * Every reader here therefore returns a THREE-STATE result — reported, unreported, or
 * conflicting — and never a bare value with `undefined` doing double duty for "absent"
 * and "present but unreadable". A panel that cannot tell those apart cannot floor its
 * verdict at UNKNOWN for the right reason.
 */

// AAP §0.10.2 / §0.7.2 / tech-spec §6.6 (V1-V8)
//
// INVARIANT LOCKED BY THIS FILE: an observation is located by EXACT identity, a repeated
// identity is a conflict rather than a race, and a value is returned at the wire type it
// arrived as or not at all.

/**
 * The wire shape of one measured fact.
 *
 * Declared structurally rather than imported from `../hooks/useControlStatus`, so this
 * module depends on nothing — not React, not a hook, not a fixture. `ControlObservation`
 * satisfies it structurally, so no adapter is needed at any call site.
 */
export interface MeasuredObservation {
  /** The observation's stable identity. Compared with `===`, never with `includes`. */
  readonly label: string;
  /**
   * The measured value at its wire type.
   *
   * `null` means "reported as null", which is a CLAIM and not an absence — the V4
   * control turns on exactly that difference for its `pod` and `secret` sub-claims.
   */
  readonly value: string | number | boolean | null;
}

/**
 * Why a lookup produced no usable value.
 *
 * - `unreported` — no observation carries the identity. The control did not measure it.
 * - `conflict` — two or more observations carry it. Which is true is unknowable here.
 * - `wrong-type` — one observation carries it, but at a type the caller cannot use.
 *
 * Kept as three distinct reasons rather than one because they call for different UI: the
 * first is a gap in the report, the second is a broken report, and the third is a
 * contract mismatch. Collapsing them would make all three read as "not measured".
 */
export type EvidenceAbsenceReason = 'unreported' | 'conflict' | 'wrong-type';

/** A successful read: the value, at the type asked for. */
export interface EvidenceReported<T> {
  readonly state: 'reported';
  readonly value: T;
}

/** An unsuccessful read, with the reason and a message naming the identity. */
export interface EvidenceMissing {
  readonly state: 'unreported' | 'conflict' | 'wrong-type';
  /** Human-readable explanation, safe to render: it names the LABEL, never the value. */
  readonly reason: string;
}

/**
 * The result of reading one measured fact.
 *
 * A discriminated union rather than `T | undefined`, so a caller cannot accidentally
 * treat "not measured" as a value. Narrow on `state === 'reported'`.
 */
export type EvidenceResult<T> = EvidenceReported<T> | EvidenceMissing;

/** Builds the reported case. */
function reported<T>(value: T): EvidenceReported<T> {
  return { state: 'reported', value };
}

/** Builds a missing case with a message that names the identity but never the value. */
function missing(state: EvidenceAbsenceReason, reason: string): EvidenceMissing {
  return { state, reason };
}

/**
 * Finds every observation carrying `label`, matched EXACTLY.
 *
 * Exposed so a caller can assert on the multiplicity itself — a spec proving that a
 * duplicate is detected needs to see the count, not just the degraded verdict.
 */
export function findObservations(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): readonly MeasuredObservation[] {
  if (observations === undefined) {
    return [];
  }
  return observations.filter((observation) => observation.label === label);
}

/**
 * Selects the single observation carrying `label`.
 *
 * Invariant locked: EXACTLY ONE, or nothing. Zero is `unreported`; two or more is
 * `conflict`, never "the first one". A control that reported a fact twice with different
 * values has told the reader two things, and picking one of them by list order is a
 * verdict decided by serialisation order rather than by evidence.
 */
export function selectObservation(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<MeasuredObservation> {
  const matches = findObservations(observations, label);
  if (matches.length === 0) {
    return missing('unreported', `No observation labelled "${label}" was reported.`);
  }
  if (matches.length > 1) {
    return missing(
      'conflict',
      `${String(matches.length)} observations are labelled "${label}", so which one is ` +
        'authoritative cannot be determined. Treated as unproven rather than resolved by ' +
        'list order.',
    );
  }
  // Non-null assertion is unnecessary: length is exactly 1 here, and reading index 0 of a
  // one-element array is total. The local keeps that obvious to a reader.
  const [only] = matches;
  return reported(only);
}

/**
 * Reads a CARDINALITY measurement: a count of things that were observed.
 *
 * Stricter than {@link readNumber} in exactly one way, and it is the way that
 * matters for a verdict: a count must be a NON-NEGATIVE INTEGER. Nothing can be
 * observed 9.5 times or -1 times, so a value like that is not a count that happens
 * to be unusual — it is evidence that whatever produced it was not counting.
 *
 * WHY THIS IS NOT PEDANTRY. Every completeness check in this tier is arithmetic
 * over counts: "were at least as many events observed as expected?", "did any
 * Secret event carry a response body?". `readNumber` admits any finite number, so
 * an observed count of `9.5` against an expected `9` satisfied BOTH `> 0` and
 * `>= 9` and produced a PASS — a false pass built out of a value no counter can
 * emit. Rejecting it as `wrong-type` makes it INDETERMINATE instead, which is the
 * honest verdict: the measurement is unusable, so the control is unproven rather
 * than either broken or holding.
 *
 * Zero is accepted here, deliberately. An empty log is a legitimate measurement
 * ("nothing was scanned") and its consequence belongs to the caller, which
 * generally reports it as indeterminate rather than violated. Only NEGATIVE and
 * NON-INTEGER values are refused.
 *
 * @param observations - the measured observations to search.
 * @param label - the observation label to read.
 * @returns the count, or the reason it could not be read as one.
 */
export function readCount(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<number> {
  const found = readNumber(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  if (!Number.isInteger(found.value)) {
    return missing(
      'wrong-type',
      `The observation labelled "${label}" is ${String(found.value)}, which is not a whole ` +
        'number, so it cannot be a count of observed things. Rounding it would invent ' +
        'evidence, and comparing it would let a value no counter can emit satisfy a ' +
        'completeness check.',
    );
  }
  if (found.value < 0) {
    return missing(
      'wrong-type',
      `The observation labelled "${label}" is ${String(found.value)}, which is negative, so ` +
        'it cannot be a count of observed things.',
    );
  }
  return reported(found.value);
}

/**
 * Reads a BOOLEAN measurement. No truthiness, no string parsing.
 *
 * `'true'`, `'false'`, `1`, `0` and `''` are all rejected as `wrong-type`. Accepting any
 * of them is how a control that reported a STRING gets read as a boolean verdict — and
 * `'false'` is truthy in JavaScript, so the coercing version of this reader inverted the
 * very answer it was asked for.
 */
export function readBoolean(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<boolean> {
  const found = selectObservation(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  const { value } = found.value;
  if (typeof value !== 'boolean') {
    return missing(
      'wrong-type',
      `The observation labelled "${label}" is a ${describeType(value)}, not a boolean, ` +
        'so it cannot be read as one. Coercing it would invent evidence.',
    );
  }
  return reported(value);
}

/**
 * Reads a FINITE NUMBER measurement. A numeric string is rejected, not parsed.
 *
 * `403` and `'403'` are different claims about the server that produced one of them, and
 * the V2 and V7 controls assert an exact 403. `NaN` and the infinities are rejected too:
 * they compare unequal or absurdly against every bound.
 */
export function readNumber(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<number> {
  const found = selectObservation(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  const { value } = found.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return missing(
      'wrong-type',
      `The observation labelled "${label}" is a ${describeType(value)}, not a finite ` +
        'number, so it cannot be read as one. Parsing it would invent evidence.',
    );
  }
  return reported(value);
}

/**
 * Reads a STRING measurement. A number is rejected, not stringified.
 *
 * The asymmetry with `null` matters: `null` is a reported claim and is refused here as
 * `wrong-type` rather than as `unreported`, so a caller that needs "present and null"
 * uses {@link readNullable} and gets a different answer than a caller that needs text.
 */
export function readString(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<string> {
  const found = selectObservation(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  const { value } = found.value;
  if (typeof value !== 'string') {
    return missing(
      'wrong-type',
      `The observation labelled "${label}" is a ${describeType(value)}, not a string, ` +
        'so it cannot be read as one.',
    );
  }
  return reported(value);
}

/**
 * Reads a measurement that may legitimately be `null`, distinguishing null from absent.
 *
 * This is the V4 requirement in one function: `kubernetes.io/pod` reported as `null` is
 * PROOF of an unbound token, while the claim being absent proves nothing — a server that
 * never emits it would satisfy an absence check while issuing bound tokens.
 */
export function readNullable(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<string | number | boolean | null> {
  const found = selectObservation(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  return reported(found.value.value);
}

/**
 * Reports whether the measurement is present and exactly `null`.
 *
 * Returns an {@link EvidenceResult} rather than a bare boolean so that "absent" cannot be
 * confused with "present and not null" — the two demand different verdicts, UNKNOWN and
 * FAIL respectively.
 */
export function readIsNull(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EvidenceResult<boolean> {
  const found = readNullable(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  return reported(found.value === null);
}

/**
 * Reads a string measurement and reports whether it STARTS WITH `expectedPrefix`.
 *
 * A prefix comparison, never equality and never `includes`. Equality would break on any
 * change to the ciphertext body it is applied to; `includes` would pass on a nested
 * occurrence, which is exactly how a plaintext blob that merely mentions the prefix could
 * be read as encrypted. This is the V3 boundary condition, expressed once.
 */
export function readHasPrefix(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
  expectedPrefix: string,
): EvidenceResult<boolean> {
  const found = readString(observations, label);
  if (found.state !== 'reported') {
    return found;
  }
  return reported(found.value.startsWith(expectedPrefix));
}

/**
 * Names the type of a measured value WITHOUT disclosing the value.
 *
 * An observation can carry a subject name, a rendered command line or a claim value, so a
 * type complaint has no business quoting what it is complaining about. `null` is reported
 * as `null` rather than as `object`, because `typeof null === 'object'` is the classic
 * misreport and the distinction is load-bearing here.
 */
export function describeType(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

/**
 * The verdict domain shared by every panel and by the dashboard.
 *
 * Declared here rather than imported from the hook so that the ordering below has one
 * home, and so a panel resolver can be unit-tested without React.
 */
export type EffectiveVerdict = 'pass' | 'warn' | 'unknown' | 'fail';

/**
 * The verdicts from weakest claim to strongest, so a floor can be taken by index.
 *
 * `fail` is LAST — that is, strongest — because this order ranks how much a verdict
 * CLAIMS, and combining verdicts always keeps the strongest claim. `pass` claims the most
 * about correctness and is therefore the easiest to lose; `fail` claims the most about a
 * defect and must survive every combination.
 *
 * `unknown` deliberately outranks `warn`: a control that could not be evaluated is worse
 * news than one evaluated with a caveat, because a caveat is a measurement and an unknown
 * is the absence of one. A UI that ranked them the other way would let missing evidence
 * be reported as a warning — a softer statement than the truth.
 */
const VERDICT_STRENGTH: readonly EffectiveVerdict[] = Object.freeze([
  'pass',
  'warn',
  'unknown',
  'fail',
]);

/**
 * Combines verdicts CONSERVATIVELY: the result is the strongest claim among them.
 *
 * Invariant locked: a `fail` anywhere makes the whole `fail`, and an `unknown` anywhere
 * prevents a `pass`. This is the single function every panel resolver and the aggregate
 * dashboard use, so a child badge and the count beside it cannot disagree — they are not
 * two implementations of the same rule, they are one.
 *
 * An empty input is `unknown`, not `pass`: combining no evidence proves nothing, and
 * defaulting it to `pass` is precisely the false reassurance the whole tier exists to
 * prevent.
 */
export function strictestVerdict(verdicts: readonly EffectiveVerdict[]): EffectiveVerdict {
  let strongest: EffectiveVerdict = 'unknown';
  let strongestRank = VERDICT_STRENGTH.indexOf('unknown');
  let sawAny = false;
  for (const verdict of verdicts) {
    const rank = VERDICT_STRENGTH.indexOf(verdict);
    if (rank < 0) {
      // An unrecognised verdict is ignorance, not agreement.
      return 'unknown';
    }
    if (!sawAny || rank > strongestRank) {
      strongest = verdict;
      strongestRank = rank;
      sawAny = true;
    }
  }
  return sawAny ? strongest : 'unknown';
}

/**
 * Maps a failed evidence read onto the verdict it justifies.
 *
 * Every one of the three reasons yields `unknown` rather than `fail`, and that is the
 * honest answer: the panel does not know the control is broken, it knows it cannot tell.
 * Reporting `fail` would be as untruthful as reporting `pass`, and would train readers to
 * ignore the badge. `unknown` is what blocks a `pass` without inventing a defect.
 */
export function verdictForAbsence(_reason: EvidenceAbsenceReason): EffectiveVerdict {
  return 'unknown';
}

/**
 * Requires a boolean measurement to equal `expected`.
 *
 * Returns `pass` on a match, `fail` on a mismatch, and `unknown` when the measurement
 * could not be read — which is the three-way answer every load-bearing V1-V8 assertion
 * needs and which a bare boolean cannot express.
 */
export function requireBoolean(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
  expected: boolean,
): EffectiveVerdict {
  const found = readBoolean(observations, label);
  if (found.state !== 'reported') {
    return verdictForAbsence(found.state);
  }
  return found.value === expected ? 'pass' : 'fail';
}

/**
 * Requires a numeric measurement to equal `expected` exactly.
 *
 * Used for the 403 denials and the webhook timeout. No tolerance and no rounding: the
 * only tolerance anywhere in this tier is the V4 expiry leeway, which is applied at its
 * own call site where the reader can see it.
 */
export function requireNumber(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
  expected: number,
): EffectiveVerdict {
  const found = readNumber(observations, label);
  if (found.state !== 'reported') {
    return verdictForAbsence(found.state);
  }
  return found.value === expected ? 'pass' : 'fail';
}

/**
 * Requires a string measurement to equal `expected` exactly.
 *
 * Case-sensitive and whitespace-sensitive. `'fail'` is not `'Fail'`: the webhook
 * `failurePolicy` is a Kubernetes enum whose casing is part of its identity, and a
 * case-folding comparison would accept a value the API server rejects.
 */
export function requireString(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
  expected: string,
): EffectiveVerdict {
  const found = readString(observations, label);
  if (found.state !== 'reported') {
    return verdictForAbsence(found.state);
  }
  return found.value === expected ? 'pass' : 'fail';
}

/**
 * Requires a measurement to be present and exactly `null`.
 *
 * The V4 `pod` and `secret` sub-claims. An absent claim yields `unknown`, and a non-null
 * one yields `fail` — the two answers the control actually distinguishes.
 */
export function requireNull(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
): EffectiveVerdict {
  const found = readIsNull(observations, label);
  if (found.state !== 'reported') {
    return verdictForAbsence(found.state);
  }
  return found.value ? 'pass' : 'fail';
}

/**
 * Requires a string measurement to begin with `expectedPrefix`.
 *
 * The V3 ciphertext prefix, expressed as a verdict.
 */
export function requirePrefix(
  observations: readonly MeasuredObservation[] | undefined,
  label: string,
  expectedPrefix: string,
): EffectiveVerdict {
  const found = readHasPrefix(observations, label, expectedPrefix);
  if (found.state !== 'reported') {
    return verdictForAbsence(found.state);
  }
  return found.value ? 'pass' : 'fail';
}
