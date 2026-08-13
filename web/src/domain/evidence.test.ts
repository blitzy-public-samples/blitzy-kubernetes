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

// AAP §0.7.1.3 (the React tier's >= 80 % line AND branch floor) / §0.7.2 (assertion density,
// failure legibility) / §0.10.2 (the boundary conditions that must port unchanged, three of
// which are implemented in this module) / tech-spec §6.6.3.4.
//
// WHY THIS FILE EXISTS. `evidence.ts` is the module every panel resolver reads its measurements
// through, and it had no spec of its own — it was exercised only incidentally, through whichever
// paths the eight panels happened to take. Three exported helpers were consequently never called
// by anything at all (`readHasPrefix`, `requireNumber`, `requirePrefix`), and the module sat at
// 78.57 % branch coverage, the only module in the tier below the floor AAP §0.7.1.3 sets.
//
// That is a worse gap than the number suggests. This module is where "not measured" is kept
// distinct from "measured as false", and that distinction is the whole mechanism preventing a
// missing observation from being read as a pass. A shared rule with no direct spec is a rule
// whose edges are asserted only where some caller happens to reach them.
//
// THE INVARIANTS LOCKED HERE:
//   1. ABSENCE IS NEVER AGREEMENT. Unreported, duplicated and wrong-typed reads are three
//      distinct outcomes, none of them a value, and every `require*` maps all three to
//      `unknown` — never to `pass` and never to `fail`.
//   2. A REASON NAMES THE LABEL AND NEVER THE VALUE. These strings are rendered, so a
//      measurement that carried a credential must not reach the DOM through a diagnostic.
//   3. COMBINING VERDICTS KEEPS THE STRONGEST CLAIM, and combining nothing yields `unknown`.

import { describe, expect, it } from 'vitest';

import type { EffectiveVerdict, MeasuredObservation } from './evidence';
import {
  describeType,
  findObservations,
  readBoolean,
  readHasPrefix,
  readIsNull,
  readNullable,
  readNumber,
  readString,
  requireBoolean,
  requireNull,
  requireNumber,
  requirePrefix,
  requireString,
  selectObservation,
  strictestVerdict,
  verdictForAbsence,
} from './evidence';

/** The label used throughout, so a failure message names something recognisable. */
const LABEL = 'etcd ciphertext prefix';

/** Builds an observation list from label/value pairs. */
function observations(
  ...pairs: readonly (readonly [string, string | number | boolean | null])[]
): readonly MeasuredObservation[] {
  return pairs.map(([label, value]) => ({ label, value }));
}

describe('evidence — findObservations and selectObservation', () => {
  it('matches a label EXACTLY, never as a substring', () => {
    // A substring match would let `etcd ciphertext prefix (legacy)` answer for
    // `etcd ciphertext prefix`, silently reporting one measurement as another.
    const list = observations([LABEL, 'k8s:enc:'], [`${LABEL} (legacy)`, 'plaintext']);

    expect(findObservations(list, LABEL)).toHaveLength(1);
    expect(findObservations(list, LABEL)[0].value).toBe('k8s:enc:');
  });

  it('reports the single match', () => {
    const found = selectObservation(observations([LABEL, 'value']), LABEL);

    expect(found.state).toBe('reported');
    expect(found.state === 'reported' ? found.value.value : undefined).toBe('value');
  });

  it('distinguishes unreported from conflict, rather than collapsing both to “absent”', () => {
    // Two different problems with two different remedies: the first is a gap in the report,
    // the second is a broken report naming one identity twice.
    expect(selectObservation(observations(['other', 1]), LABEL).state).toBe('unreported');
    expect(selectObservation(observations([LABEL, 1], [LABEL, 2]), LABEL).state).toBe('conflict');
  });

  it('treats an absent list as unreported rather than throwing', () => {
    expect(selectObservation(undefined, LABEL).state).toBe('unreported');
    expect(findObservations(undefined, LABEL)).toHaveLength(0);
  });

  it('names the label in the reason and never the measured value', () => {
    // These reasons are RENDERED. A duplicate observation whose value was a credential must
    // not reach the DOM through the diagnostic that reports the duplication.
    const secret = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJl';
    const found = selectObservation(observations([LABEL, secret], [LABEL, secret]), LABEL);

    expect(found.state).toBe('conflict');
    const reason = found.state === 'reported' ? '' : found.reason;
    expect(reason).toContain(LABEL);
    expect(reason).not.toContain(secret);
  });
});

describe('evidence — the typed readers keep “absent” apart from “false”', () => {
  it('reads each wire type at its own type', () => {
    expect(readBoolean(observations([LABEL, true]), LABEL)).toEqual({
      state: 'reported',
      value: true,
    });
    expect(readNumber(observations([LABEL, 5]), LABEL)).toEqual({ state: 'reported', value: 5 });
    expect(readString(observations([LABEL, 'Fail']), LABEL)).toEqual({
      state: 'reported',
      value: 'Fail',
    });
  });

  it('reports a wrong-typed value as wrong-type, not as a falsy value', () => {
    // The distinction the whole module exists for: `false` is a measurement, and a string
    // where a boolean was required is the absence of one.
    expect(readBoolean(observations([LABEL, 'true']), LABEL).state).toBe('wrong-type');
    expect(readNumber(observations([LABEL, '5']), LABEL).state).toBe('wrong-type');
    expect(readString(observations([LABEL, 5]), LABEL).state).toBe('wrong-type');
  });

  it('reads a reported null as a CLAIM, which is not an absence', () => {
    // V4 turns on exactly this: `pod: null` is the control passing, and no `pod` observation
    // at all is the control unmeasured. Conflating them would pass an unmeasured token.
    expect(readIsNull(observations([LABEL, null]), LABEL)).toEqual({
      state: 'reported',
      value: true,
    });
    expect(readIsNull(observations([LABEL, 'set']), LABEL)).toEqual({
      state: 'reported',
      value: false,
    });
    expect(readIsNull(observations(['other', null]), LABEL).state).toBe('unreported');
  });

  it('reads a nullable measurement at whatever type it was reported', () => {
    // Deliberately type-agnostic, unlike its typed siblings: the ONLY distinction it draws is
    // null versus absent, which is the V4 requirement. Every wire type passes through, so
    // there is no wrong-type case to assert — narrowing is the caller's job.
    expect(readNullable(observations([LABEL, 'text']), LABEL)).toEqual({
      state: 'reported',
      value: 'text',
    });
    expect(readNullable(observations([LABEL, null]), LABEL)).toEqual({
      state: 'reported',
      value: null,
    });
    expect(readNullable(observations([LABEL, 7]), LABEL)).toEqual({ state: 'reported', value: 7 });
    expect(readNullable(observations(['other', null]), LABEL).state).toBe('unreported');
    expect(readNullable(observations([LABEL, 1], [LABEL, 2]), LABEL).state).toBe('conflict');
  });
});

describe('evidence — readHasPrefix is a PREFIX test, not equality and not containment', () => {
  // AAP §0.10.2: the V3 ciphertext prefix `k8s:enc:aesgcm:v1:key1:` is matched as a PREFIX.
  // Equality would break on any change to the ciphertext body; containment would pass on a
  // nested occurrence, which is how a plaintext blob that merely MENTIONS the prefix could be
  // read as encrypted. Both wrong answers are asserted against directly.
  const PREFIX = 'k8s:enc:aesgcm:v1:key1:';

  it('reports true for a value that begins with the prefix', () => {
    const found = readHasPrefix(observations([LABEL, `${PREFIX}ciphertextbody`]), LABEL, PREFIX);

    expect(found).toEqual({ state: 'reported', value: true });
  });

  it('reports true for the bare prefix, equality being one case of a prefix', () => {
    expect(readHasPrefix(observations([LABEL, PREFIX]), LABEL, PREFIX)).toEqual({
      state: 'reported',
      value: true,
    });
  });

  it('reports FALSE when the prefix merely appears later in the value', () => {
    // The containment trap, asserted explicitly: a plaintext blob quoting the prefix is not
    // an encrypted one.
    const found = readHasPrefix(
      observations([LABEL, `plaintext mentioning ${PREFIX} in passing`]),
      LABEL,
      PREFIX,
    );

    expect(found).toEqual({ state: 'reported', value: false });
  });

  it('propagates the read failure rather than reporting false', () => {
    // `false` would assert that the value was measured and did not match. These three cases
    // assert that no value was usable at all, which is a different claim.
    expect(readHasPrefix(observations(['other', 'x']), LABEL, PREFIX).state).toBe('unreported');
    expect(readHasPrefix(observations([LABEL, 5]), LABEL, PREFIX).state).toBe('wrong-type');
    expect(readHasPrefix(observations([LABEL, 'a'], [LABEL, 'b']), LABEL, PREFIX).state).toBe(
      'conflict',
    );
  });
});

describe('evidence — describeType names the type without disclosing the value', () => {
  it.each([
    ['a string', 'super-secret-token', 'string'],
    ['a number', 42, 'number'],
    ['a boolean', true, 'boolean'],
    ['null', null, 'null'],
  ])('describes %s', (_name, value: string | number | boolean | null, expected) => {
    expect(describeType(value)).toBe(expected);
  });

  it('never echoes the value it was given', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';

    expect(describeType(secret)).toBe('string');
    expect(describeType(secret)).not.toContain(secret);
  });
});

describe('evidence — strictestVerdict keeps the strongest claim', () => {
  it('returns unknown for no verdicts at all', () => {
    // Combining no evidence proves nothing. Defaulting an empty set to `pass` is precisely
    // the false reassurance this tier exists to prevent.
    expect(strictestVerdict([])).toBe('unknown');
  });

  it('returns the only verdict when given one', () => {
    for (const verdict of ['pass', 'warn', 'unknown', 'fail'] as const) {
      expect.soft(strictestVerdict([verdict])).toBe(verdict);
    }
  });

  it('lets a fail survive every combination', () => {
    expect(strictestVerdict(['pass', 'fail'])).toBe('fail');
    expect(strictestVerdict(['fail', 'pass'])).toBe('fail');
    expect(strictestVerdict(['warn', 'fail', 'unknown'])).toBe('fail');
  });

  it('lets an unknown block a pass', () => {
    expect(strictestVerdict(['pass', 'unknown'])).toBe('unknown');
    expect(strictestVerdict(['pass', 'pass', 'pass'])).toBe('pass');
  });

  it('ranks unknown ABOVE warn, a missing measurement being worse news than a caveat', () => {
    // Reversing these two would let missing evidence be reported as a warning — a softer
    // statement than the truth.
    expect(strictestVerdict(['warn', 'unknown'])).toBe('unknown');
    expect(strictestVerdict(['unknown', 'warn'])).toBe('unknown');
  });

  it('never absorbs a warning into a clean pass', () => {
    expect(strictestVerdict(['pass', 'warn'])).toBe('warn');
  });

  it('treats an unrecognised verdict as ignorance rather than agreement', () => {
    // Reached through a deliberately invalid cast: the type system forbids this, and a
    // malformed payload does not. Ignoring the value and returning `pass` would be the
    // false-pass error in its purest form.
    const smuggled: readonly EffectiveVerdict[] = [
      'pass',
      'definitely-fine' as unknown as EffectiveVerdict,
    ];

    expect(strictestVerdict(smuggled)).toBe('unknown');
  });

  it('is order-independent across every pair', () => {
    const all = ['pass', 'warn', 'unknown', 'fail'] as const;
    for (const left of all) {
      for (const right of all) {
        expect
          .soft(strictestVerdict([left, right]), `${left} then ${right}`)
          .toBe(strictestVerdict([right, left]));
      }
    }
  });
});

describe('evidence — verdictForAbsence answers “cannot tell”, never “broken”', () => {
  it.each(['unreported', 'conflict', 'wrong-type'] as const)('maps %s to unknown', (reason) => {
    // `fail` would be as untruthful as `pass`: the panel does not know the control is broken,
    // it knows it cannot tell. `unknown` is what blocks a pass without inventing a defect.
    expect(verdictForAbsence(reason)).toBe('unknown');
  });
});

describe('evidence — the require* helpers turn a reading into a verdict', () => {
  it('passes on the expected value and fails on a different one', () => {
    expect(requireBoolean(observations([LABEL, true]), LABEL, true)).toBe('pass');
    expect(requireBoolean(observations([LABEL, false]), LABEL, true)).toBe('fail');
    expect(requireNumber(observations([LABEL, 5]), LABEL, 5)).toBe('pass');
    expect(requireNumber(observations([LABEL, 6]), LABEL, 5)).toBe('fail');
    expect(requireString(observations([LABEL, 'Fail']), LABEL, 'Fail')).toBe('pass');
    expect(requireString(observations([LABEL, 'Ignore']), LABEL, 'Fail')).toBe('fail');
  });

  it('compares numbers exactly, with no tolerance and no rounding', () => {
    // AAP §0.10.2: the webhook `timeoutSeconds` is exactly 5. The only tolerance anywhere in
    // this tier is the V4 expiry leeway, applied at its own call site where a reader sees it.
    expect(requireNumber(observations([LABEL, 5.0001]), LABEL, 5)).toBe('fail');
    expect(requireNumber(observations([LABEL, 4.9999]), LABEL, 5)).toBe('fail');
  });

  it('compares strings case- and whitespace-sensitively', () => {
    // `failurePolicy` is a Kubernetes enum whose casing is part of its identity, so a
    // case-folding comparison would accept a value the API server rejects.
    expect(requireString(observations([LABEL, 'fail']), LABEL, 'Fail')).toBe('fail');
    expect(requireString(observations([LABEL, 'Fail ']), LABEL, 'Fail')).toBe('fail');
  });

  it('requires a reported null, distinguishing it from an absent claim', () => {
    expect(requireNull(observations([LABEL, null]), LABEL)).toBe('pass');
    expect(requireNull(observations([LABEL, 'pod-name']), LABEL)).toBe('fail');
    expect(requireNull(observations(['other', null]), LABEL)).toBe('unknown');
  });

  it('requires a prefix as a verdict, matching readHasPrefix', () => {
    const PREFIX = 'k8s:enc:aesgcm:v1:key1:';

    expect(requirePrefix(observations([LABEL, `${PREFIX}body`]), LABEL, PREFIX)).toBe('pass');
    expect(requirePrefix(observations([LABEL, 'plaintext']), LABEL, PREFIX)).toBe('fail');
    // Containment is not a prefix, and this is the verdict-level restatement of that.
    expect(requirePrefix(observations([LABEL, `x ${PREFIX}`]), LABEL, PREFIX)).toBe('fail');
  });

  it('never returns pass or fail for an unusable reading, across every helper', () => {
    // THE CENTRAL PROPERTY, asserted once over all five helpers and all three failure modes.
    // `fail` would be as wrong as `pass` here: both claim a measurement was taken.
    // The two failure modes that are wrong for EVERY helper regardless of its type: nothing
    // reported it, and two observations claim the identity at once.
    const universallyUnusable: readonly (readonly [
      string,
      readonly MeasuredObservation[] | undefined,
    ])[] = [
      ['unreported', observations(['unrelated', 1])],
      ['absent list', undefined],
      ['duplicated', observations([LABEL, 1], [LABEL, 1])],
    ];
    // Each helper paired with a value of a type IT cannot use. The values differ on purpose:
    // a string is the wrong type for `requireBoolean`, but for `requireNull` and
    // `requirePrefix` it is a perfectly good measurement that simply does not match, and
    // those rightly answer `fail` rather than `unknown`.
    const helpers: readonly (readonly [
      string,
      (list: readonly MeasuredObservation[] | undefined) => EffectiveVerdict,
      string | number | boolean | null,
    ])[] = [
      ['requireBoolean', (list) => requireBoolean(list, LABEL, true), 'true'],
      ['requireNumber', (list) => requireNumber(list, LABEL, 5), '5'],
      ['requireString', (list) => requireString(list, LABEL, 'Fail'), 5],
      ['requirePrefix', (list) => requirePrefix(list, LABEL, 'k8s:enc:'), 5],
    ];

    for (const [name, run, wrongTyped] of helpers) {
      for (const [mode, list] of universallyUnusable) {
        expect.soft(run(list), `${name} on a ${mode} observation`).toBe('unknown');
      }
      expect
        .soft(run(observations([LABEL, wrongTyped])), `${name} on a wrong-typed observation`)
        .toBe('unknown');
    }
    // `requireNull` has no wrong-type case at all: every wire value is either null or not,
    // so it answers `pass` or `fail` for anything reported and `unknown` only for the
    // universal modes above.
    for (const [mode, list] of universallyUnusable) {
      expect.soft(requireNull(list, LABEL), `requireNull on a ${mode} observation`).toBe('unknown');
    }
  });
});
