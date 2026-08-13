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

// AAP §0.5.1 (the `web/src/components/EncryptionAtRestPanel.test.tsx` row — "Ciphertext
// versus plaintext verdict rendering") / §0.4.2.4 (the five case categories) / §0.7.2
// (assertion density: V3 keeps ALL FOUR of its assertions) / §0.10.2 (the exactly-one entry,
// the prefix matched as a PREFIX, the canary absent, the live storage prefix, identity last,
// no `cachesize`) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   V3 renders a PASS only when all four oracle assertions are proven from typed
//   measurements found by exact identity; plaintext never renders as a pass; and no measured
//   string is ever echoed into the DOM.
//
// THE FIVE DEFECTS THESE CASES EXIST TO PREVENT, every one of which the compiler and the
// linter accepted:
//
//   1. THE INVERTED VERDICT (the worst of them). Observations were routed to rows by keyword
//      containment, first keyword and first observation winning. The recorded PASSING payload
//      carries two canary measurements — the canary STRING that was searched for, then the
//      BOOLEAN answer `false` — and both contain the word "canary". The string won the row
//      and read as a present canary; the explicit `false` was DISCARDED because the row was
//      taken. A recorded pass rendered "Plaintext detected", inverting the only
//      Critical-severity control of the eight.
//   2. PSEUDO-EVIDENCE. A closed vocabulary of words — `ok`, `pass`, `enabled`,
//      `ciphertext` — counted as proof of any row, and a numeric string counted as a count.
//   3. HALF A PROOF WAS ENOUGH. Only the prefix and the canary were required for a pass, so a
//      payload reporting no stored-entry count and no round trip still reached a clean pass.
//   4. A REPORTED PASS SURVIVED TOTALLY ABSENT EVIDENCE, because evidence of `unknown`
//      returned the reported verdict unchanged.
//   5. ARBITRARY VALUES WERE RENDERED VERBATIM. An unrecognised observation was echoed into
//      the DOM unless it happened to contain the one known canary — so any OTHER Secret data
//      in a raw blob went straight to the screen. Withholding only the known marker protected
//      the fixture, not the data.
//
// The oracle every required value comes from is `test/integration/secrets/encryption_test.go`
// L80-L153, which this workstream never modifies.

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V3_OBSERVATIONS } from '../domain/observationIds';
import { AESGCM_PREFIX, PLAINTEXT_CANARY } from '../domain/securityConstants';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  FORBIDDEN_CONTROL_STATUS_ERROR,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V3_ENCRYPTION_FAILING,
  V3_ENCRYPTION_PASSING,
  V3_DEPLOYMENT_MANIFEST_OBSERVATIONS,
  V3_ENCRYPTION_UNKNOWN,
  V3_EXAMPLE_STORAGE_PREFIX,
} from '../test/fixtures/controlStatus';
import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import EncryptionAtRestPanel, {
  resolveEncryptionAtRestEffectiveVerdict,
} from './EncryptionAtRestPanel';

/** The verdict badge, which is where the panel states its outcome. */
function verdictText(): string {
  return screen.getByRole('status').textContent ?? '';
}

/** Reads the whole text of the evidence row whose header is `check`. */
function rowText(check: string): string {
  const header = screen.getByRole('rowheader', { name: check });
  return header.closest('tr')?.textContent ?? '';
}

/** Reads the outcome cell of one evidence row: the last cell of its row. */
function rowOutcome(check: string): string {
  const header = screen.getByRole('rowheader', { name: check });
  const cells = header.closest('tr')?.querySelectorAll('td') ?? [];
  return cells[cells.length - 1]?.textContent ?? '';
}

/**
 * Everything a PASS rests on: the four ciphertext assertions, the live-storage-prefix
 * PRECONDITION, and the committed manifest's posture.
 *
 * WHY THE MANIFEST ROWS BELONG HERE. This panel attributes itself to all three V3
 * requirements, and while only the ciphertext proof could move its verdict, two of those
 * three claims rested on measurements that could not fail them: the four runtime
 * assertions prove a Secret written through THE TEST'S OWN API server was ciphertext, and
 * say nothing about the document a real deployment loads. Put `identity` first in the
 * provider list and every new write is plaintext while all four still pass.
 *
 * The manifest half is spread from the recorded fixture rather than written out, so this
 * list and the recorded document cannot diverge. The first case of the next block is the
 * two-sided control proving the list is SUFFICIENT -- without it every `without()` case
 * below would report the same verdict whatever the gate did.
 */
const ALL_PROVEN: readonly ControlObservation[] = [
  { label: V3_OBSERVATIONS.etcdEntryCount, value: 1 },
  { label: V3_OBSERVATIONS.rawValuePrefix, value: AESGCM_PREFIX },
  { label: V3_OBSERVATIONS.canaryLiteral, value: PLAINTEXT_CANARY },
  { label: V3_OBSERVATIONS.canaryPresentInRawBlob, value: false },
  { label: V3_OBSERVATIONS.plaintextRoundTrip, value: true },
  { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: true },
  { label: V3_OBSERVATIONS.storagePrefixShape, value: V3_EXAMPLE_STORAGE_PREFIX },
  ...V3_DEPLOYMENT_MANIFEST_OBSERVATIONS,
];

/** A payload claiming `pass`, carrying the observation list under test. */
function claimingPass(observations: readonly ControlObservation[]): ControlStatus {
  return { ...V3_ENCRYPTION_PASSING, findings: [], evidence: { observations } };
}

/** {@link ALL_PROVEN} without one measurement. */
function without(label: string): readonly ControlObservation[] {
  return ALL_PROVEN.filter((observation) => observation.label !== label);
}

/** {@link ALL_PROVEN} with one measurement's value replaced. */
function replacing(
  label: string,
  value: ControlObservation['value'],
): readonly ControlObservation[] {
  return ALL_PROVEN.map((observation) =>
    observation.label === label ? { label, value } : observation,
  );
}

describe('the recorded payloads', () => {
  it('renders the recorded PASSING payload as a PASS', () => {
    // THE REGRESSION CASE. This payload rendered "FAIL - Plaintext detected" because the
    // canary STRING claimed the canary row ahead of the explicit `false`.
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />);

    expect(verdictText()).toContain('PASS');
    expect(verdictText()).toContain('Secrets are encrypted at rest');
    expect(resolveEncryptionAtRestEffectiveVerdict(V3_ENCRYPTION_PASSING)).toBe('pass');
  });

  it('proves the pass from all FOUR assertions, each with its own satisfied row', () => {
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />);

    expect(rowOutcome('Stored etcd entries')).toBe('satisfied');
    expect(rowOutcome('Stored value prefix')).toBe('satisfied');
    expect(rowOutcome('Plaintext canary in the raw blob')).toBe('satisfied');
    expect(rowOutcome('Plaintext round trip')).toBe('satisfied');
    // The fifth measurement the payload carries: the key came from the live prefix.
    expect(rowOutcome('Storage prefix source')).toBe('satisfied');
  });

  it('keeps the canary STRING and the canary ANSWER in separate rows', () => {
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />);

    // The answer row states the absence; the literal row states which marker was looked
    // for and contributes nothing to the verdict.
    expect(rowText('Plaintext canary in the raw blob')).toContain('reported absent');
    expect(rowText('Canary searched for')).toContain('the recorded marker');
    expect(rowOutcome('Canary searched for')).toBe('context');
  });

  it('renders the recorded FAILING payload as a FAIL naming the plaintext', () => {
    const { container } = renderWithProviders(
      <EncryptionAtRestPanel status={V3_ENCRYPTION_FAILING} />,
    );

    expect(verdictText()).toContain('FAIL');
    expect(resolveEncryptionAtRestEffectiveVerdict(V3_ENCRYPTION_FAILING)).toBe('fail');
    expect(rowOutcome('Plaintext canary in the raw blob')).toBe('violated');
    expect(rowOutcome('Stored value prefix')).toBe('violated');
    expect(V3_ENCRYPTION_FAILING.findings).toHaveLength(2);
    for (const finding of V3_ENCRYPTION_FAILING.findings) {
      expect(container).toHaveTextContent(finding.message);
    }
  });

  it('renders the recorded UNKNOWN payload as unknown, never as a failure', () => {
    // A count other than one means the raw read addressed the wrong key. That is a broken
    // measurement, not evidence of plaintext, so it must not be reported as one.
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_UNKNOWN} />);

    expect(verdictText()).toContain('UNKNOWN');
    expect(verdictText()).not.toContain('FAIL');
    expect(resolveEncryptionAtRestEffectiveVerdict(V3_ENCRYPTION_UNKNOWN)).toBe('unknown');
    expect(rowOutcome('Stored etcd entries')).toBe('not proven');
    expect(rowText('Stored etcd entries')).toContain('expected exactly 1');
    expect(rowText('Storage prefix source')).toContain('NOT read from the live configuration');
  });
});

describe('a pass must be earned by all four assertions', () => {
  it('renders a PASS with the whole recorded evidence set, so the gate is two-sided', () => {
    // THE CONTROL FOR EVERY CASE BELOW. Without it a gate that refused every payload
    // would look correct, and each `withholds the pass when ...` case would be asserting
    // "not PASS" against a panel that never says PASS at all.
    const status = claimingPass(ALL_PROVEN);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('PASS');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('pass');
  });

  it.each([
    ['the stored-entry count', V3_OBSERVATIONS.etcdEntryCount],
    ['the ciphertext prefix', V3_OBSERVATIONS.rawValuePrefix],
    ['the canary answer', V3_OBSERVATIONS.canaryPresentInRawBlob],
    ['the plaintext round trip', V3_OBSERVATIONS.plaintextRoundTrip],
  ])('withholds the pass when %s is not reported', (_name, label) => {
    const status = claimingPass(without(label));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).not.toBe('pass');
  });

  it('withholds the pass when NO evidence is reported at all', () => {
    const status = claimingPass([]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('UNKNOWN');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('unknown');
  });

  it('withholds the pass when the evidence bag is absent entirely', () => {
    const status: ControlStatus = {
      ...V3_ENCRYPTION_PASSING,
      findings: [],
      evidence: undefined,
    };
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('UNKNOWN');
  });

  it('reports a partial proof as a warning rather than promoting it', () => {
    const status = claimingPass(without(V3_OBSERVATIONS.plaintextRoundTrip));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('WARN');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('warn');
  });
});

describe('the prefix is matched as a PREFIX', () => {
  it('fails a value that contains the prefix without beginning with it', () => {
    const status = claimingPass(
      replacing(V3_OBSERVATIONS.rawValuePrefix, `leading-bytes${AESGCM_PREFIX}`),
    );
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('FAIL');
    expect(rowText('Stored value prefix')).toContain('does not begin with it');
  });

  it('accepts a value that begins with the prefix and continues', () => {
    const status = claimingPass(
      replacing(V3_OBSERVATIONS.rawValuePrefix, `${AESGCM_PREFIX}ciphertext-body`),
    );
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('PASS');
  });

  it('fails a prefix reported as null', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.rawValuePrefix, null));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('FAIL');
    expect(rowText('Stored value prefix')).toContain('carries no transformer prefix');
  });
});

describe('pseudo-evidence is refused', () => {
  it.each([
    ['ok', 'ok'],
    ['pass', 'pass'],
    ['enabled', 'enabled'],
    ['ciphertext', 'ciphertext'],
    ['true as a word', 'true'],
  ])('does not accept the word %s as a canary answer', (_name, value) => {
    // The canary row reads a BOOLEAN from its own identity. A word is not an answer.
    const status = claimingPass(replacing(V3_OBSERVATIONS.canaryPresentInRawBlob, value));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(rowOutcome('Plaintext canary in the raw blob')).toBe('not proven');
  });

  it('does not accept a numeric STRING as the stored-entry count', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.etcdEntryCount, '1'));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(rowOutcome('Stored etcd entries')).toBe('not proven');
  });

  it('does not accept a word as the round-trip answer', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.plaintextRoundTrip, 'satisfied'));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
  });

  it('does not accept a round-trip value that merely CONTAINS the canary', () => {
    // A payload echoing the round-tripped Secret would be publishing the plaintext it is
    // meant to be proving is protected, so such a value is not proof either.
    const status = claimingPass(
      replacing(V3_OBSERVATIONS.plaintextRoundTrip, `api_key=${PLAINTEXT_CANARY}`),
    );
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(container.textContent).not.toContain(`api_key=${PLAINTEXT_CANARY}`);
  });

  it('withholds a row whose identity is reported twice', () => {
    // APPENDED, not replaced: this is the one case that WANTS a duplicate identity, so
    // it adds a second, contradicting canary answer beside the recorded one.
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.canaryPresentInRawBlob, value: true },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(rowText('Plaintext canary in the raw blob')).toContain('reported more than once');
  });
});

describe('the abort gate withholds what it cannot trust', () => {
  it('withholds the three downstream rows when the count is not exactly one', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.etcdEntryCount, 2));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    for (const check of [
      'Stored value prefix',
      'Plaintext canary in the raw blob',
      'Plaintext round trip',
    ]) {
      expect(rowOutcome(check)).toBe('not proven');
      expect(rowText(check)).toContain('withheld');
    }
    expect(verdictText()).toContain('UNKNOWN');
  });

  it('withholds them when the storage prefix was not read from the live configuration', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.storagePrefixFromLiveConfig, false));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowText('Stored value prefix')).toContain(
      'the storage prefix was not read from the live configuration',
    );
    expect(verdictText()).not.toContain('PASS');
  });

  it('withholds the canary row when a DIFFERENT marker was searched for', () => {
    // An absence proved about another string is not the absence this control needs.
    const status = claimingPass(
      replacing(V3_OBSERVATIONS.canaryLiteral, 'SOME_OTHER_MARKER_VALUE'),
    );
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowText('Plaintext canary in the raw blob')).toContain(
      `the marker searched for was not ${PLAINTEXT_CANARY}`,
    );
    expect(verdictText()).not.toContain('PASS');
  });

  it('calls out the bare registry prefix by name', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.storagePrefixShape, 'registry'));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowText('Storage prefix shape')).toContain('the hardcoded form');
  });
});

describe('provider ordering needs a real encrypting provider', () => {
  it.each([
    ['kms then identity', 'kms, identity', 'satisfied'],
    ['aesgcm then identity', 'aesgcm, identity', 'satisfied'],
    ['kms alone', 'kms', 'satisfied'],
    ['identity first', 'identity, kms', 'violated'],
    ['identity in the middle', 'kms, identity, aesgcm', 'violated'],
    ['identity alone', 'identity', 'violated'],
  ])('reads %s as %s', (_name, value, expected) => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.providerOrder, value));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Provider order')).toBe(expected);
  });

  it('does NOT accept an unrecognised sole provider merely because identity is absent', () => {
    // The defect: any list without `identity` passed, so a typo or a removed provider
    // rendered as "no plaintext fallback present" and counted as satisfied.
    const status = claimingPass(replacing(V3_OBSERVATIONS.providerOrder, 'not-a-provider'));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Provider order')).toBe('not proven');
    expect(rowText('Provider order')).toContain('cannot be confirmed to encrypt');
  });

  it('does not accept the word "ok" as an ordering answer', () => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.providerOrder, 'ok'));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Provider order')).toBe('not proven');
  });
});

// ---------------------------------------------------------------------------
// THE LIVE-STORAGE-PREFIX PRECONDITION GATES THE PROOF (M4, AAP §0.10.2).
//
// The etcd key must be derived from the LIVE storage prefix, which embeds a per-run UUID.
// While the gate only closed when the observation was PRESENT and reported `false`, three
// ways of failing to establish it left it open -- never reporting it, reporting it twice,
// and reporting it at a type that is not a boolean -- so a payload earned a clean pass on
// four assertions about an object nobody had confirmed was the right one.
// ---------------------------------------------------------------------------

describe('the live-storage-prefix precondition', () => {
  /** The rows that are only trustworthy once the right object was addressed. */
  const DEPENDENT_ROWS = [
    'Stored value prefix',
    'Plaintext canary in the raw blob',
    'Plaintext round trip',
  ] as const;

  it.each([
    ['is never reported', without(V3_OBSERVATIONS.storagePrefixFromLiveConfig), 'never reported'],
    [
      'is reported as false',
      replacing(V3_OBSERVATIONS.storagePrefixFromLiveConfig, false),
      'was not read from the live configuration',
    ],
    [
      'is reported at a type that is not a boolean',
      replacing(V3_OBSERVATIONS.storagePrefixFromLiveConfig, 'true'),
      'at a type that is not a boolean',
    ],
    [
      'is reported twice',
      [
        ...ALL_PROVEN,
        { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: false },
      ] as readonly ControlObservation[],
      'reported more than once',
    ],
  ])('withholds the dependent rows when the precondition %s', (_name, observations, reason) => {
    const status = claimingPass(observations);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).not.toBe('pass');
    for (const row of DEPENDENT_ROWS) {
      expect.soft(rowOutcome(row)).toBe('not proven');
      expect.soft(rowText(row)).toContain('withheld');
    }
    // The reason is worded per case, because "you did not measure this" and "you
    // measured it and it was false" send a reader to different places.
    expect(rowText(DEPENDENT_ROWS[0])).toContain(reason);
  });

  it('never claims a defect from an unestablished precondition', () => {
    // Absent evidence is not a defect. Reporting FAIL here would blame encryption for
    // the harness's own mistake, which is as untruthful as reporting PASS.
    const status = claimingPass(without(V3_OBSERVATIONS.storagePrefixFromLiveConfig));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('FAIL');
  });

  it('does not let the precondition alone count as partial proof of ciphertext', () => {
    // Having read a storage prefix from the live configuration says nothing whatsoever
    // about ciphertext, so it must not lift a payload from UNKNOWN to "partly verified".
    const status = claimingPass([
      { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: true },
      { label: V3_OBSERVATIONS.storagePrefixShape, value: V3_EXAMPLE_STORAGE_PREFIX },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('UNKNOWN');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// THE COMMITTED MANIFEST POSTURE IS REQUIRED FOR A PASS (M15).
//
// The panel claims F-003-RQ-001 and F-003-RQ-003, which ARE the manifest. While only the
// ciphertext proof could move the verdict, both claims rested on measurements that could
// not fail them: put `identity` first in the provider list and every new write is
// plaintext while a test server configured with aesgcm still passes all four assertions.
// ---------------------------------------------------------------------------

describe('the committed manifest posture gates the pass', () => {
  it.each([
    ['the encrypted resources list', V3_OBSERVATIONS.encryptedResources, 'F-003-RQ-001'],
    ['the provider order', V3_OBSERVATIONS.providerOrder, 'F-003-RQ-003'],
    ['the KMS timeout', V3_OBSERVATIONS.kmsTimeout, 'F-003-RQ-003'],
    ['the cachesize key', V3_OBSERVATIONS.cachesizeKey, 'F-003-RQ-003'],
  ])('withholds the pass when %s is not reported', (_name, label, requirementId) => {
    const status = claimingPass(without(label));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).not.toContain('PASS');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).not.toBe('pass');
    // The requirement the unproven row serves is rendered beside it, so the reader can
    // see WHICH of the panel's three claims is unbacked.
    expect(screen.getByRole('table')).toHaveTextContent(requirementId);
  });

  it('reports a complete ciphertext proof under an unmeasured manifest as a WARNING', () => {
    // The honest reading: the thing the control is chiefly about was measured in full,
    // and the caveat is that the shipped deployment posture was not. Not a pass, so
    // nothing is over-claimed; not unknown either, because the proof did complete.
    const status = claimingPass(
      ALL_PROVEN.filter(
        (observation) =>
          !V3_DEPLOYMENT_MANIFEST_OBSERVATIONS.some(
            (manifest) => manifest.label === observation.label,
          ),
      ),
    );
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('WARN');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('warn');
  });

  it('still fails, not merely withholds, when a manifest row is CONTRADICTED', () => {
    // `identity` first means every new write is plaintext. That is a measured defect and
    // it fails the control, which is the asymmetry that distinguishes it from silence.
    const status = claimingPass(
      replacing(V3_OBSERVATIONS.providerOrder, `${'identity'},kms`),
    );
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('FAIL');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('fail');
  });

  it('attributes every claimed requirement to at least one gated row', () => {
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />);

    const table = screen.getByRole('table');
    for (const requirementId of ['F-003-RQ-001', 'F-003-RQ-002', 'F-003-RQ-003']) {
      expect.soft(table).toHaveTextContent(requirementId);
    }
  });

  it('leaves the three INFORMATIONAL rows out of the gate, or a pass would be unreachable', () => {
    // `Storage prefix shape`, `Canary searched for` and `KMS endpoint` never return
    // `satisfied` by construction, so requiring one would make PASS impossible rather
    // than stricter. The recorded payload is a pass, which is the proof of that.
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />);

    expect(verdictText()).toContain('PASS');
    for (const row of ['Storage prefix shape', 'Canary searched for', 'KMS endpoint']) {
      expect.soft(rowOutcome(row)).toBe('context');
    }
  });
});

describe('the manifest boundaries', () => {
  it.each([
    ['the recorded duration', '3s', 'satisfied'],
    ['a different duration', '30s', 'violated'],
    ['a bare number', 3, 'violated'],
  ])('reads a KMS timeout of %s as %s', (_name, value, expected) => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.kmsTimeout, value));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('KMS timeout')).toBe(expected);
  });

  it.each([
    ['null', null, 'satisfied'],
    ['false', false, 'satisfied'],
    ['true', true, 'violated'],
    ['a number', 1000, 'violated'],
  ])('reads a cachesize key of %s as %s', (_name, value, expected) => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.cachesizeKey, value));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('cachesize key')).toBe(expected);
  });

  it('treats an unreported cachesize key as unproven, not as absent', () => {
    // The distinction this case exists for: "nobody looked" is not "the key is absent",
    // and treating it as absent would be the quiet false pass. The observation is
    // REMOVED explicitly rather than relied on being missing from the baseline, because
    // the recorded posture now carries it as `null` -- a MEASURED absence, which is the
    // opposite claim and the one that does satisfy the row.
    renderWithProviders(
      <EncryptionAtRestPanel status={claimingPass(without(V3_OBSERVATIONS.cachesizeKey))} />,
    );

    expect(rowOutcome('cachesize key')).toBe('not proven');
    expect(verdictText()).not.toContain('PASS');
  });

  it.each([
    ['the recorded list in order', 'secrets, configmaps', 'satisfied'],
    ['the list reversed', 'configmaps, secrets', 'violated'],
    ['a shorter list', 'secrets', 'violated'],
  ])('reads encrypted resources of %s as %s', (_name, value, expected) => {
    const status = claimingPass(replacing(V3_OBSERVATIONS.encryptedResources, value));
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Encrypted resources')).toBe(expected);
  });

  it('shows the KMS endpoint as context and never as a verdict input', () => {
    renderWithProviders(<EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />);

    expect(rowOutcome('KMS endpoint')).toBe('context');
    expect(rowText('KMS endpoint')).toContain('placeholder');
  });
});

describe('no measured string is echoed into the DOM', () => {
  it('reports an unrecognised observation by label and SHAPE, never by value', () => {
    const blob = `plaintext-blob-with-${PLAINTEXT_CANARY}-and-other-secret-bytes`;
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: 'raw stored blob', value: blob },
    ]);
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(blob);
    expect(container.textContent).not.toContain('other-secret-bytes');
    expect(container).toHaveTextContent('raw stored blob: reported as a string of');
    expect(container).toHaveTextContent('value withheld');
  });

  it('withholds an unrecognised value that does NOT carry the known canary', () => {
    // The previous guard withheld only strings containing the canary, which protected the
    // fixture rather than the data. Any other Secret bytes went straight to the DOM.
    const secret = 'password=hunter2-not-the-canary-at-all';
    const status = claimingPass([...ALL_PROVEN, { label: 'leaked field', value: secret }]);
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).not.toContain('hunter2');
  });

  it('still reports unrecognised booleans, numbers and nulls by value', () => {
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: 'extra flag', value: true },
      { label: 'extra count', value: 7 },
      { label: 'extra nothing', value: null },
    ]);
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container).toHaveTextContent('extra flag: reported as the boolean true');
    expect(container).toHaveTextContent('extra count: reported as the number 7');
    expect(container).toHaveTextContent('extra nothing: reported as null');
  });

  it('never echoes an out-of-shape KMS endpoint', () => {
    const hostile = `unix://${PLAINTEXT_CANARY} and a whole sentence of Secret data`;
    const status = claimingPass(replacing(V3_OBSERVATIONS.kmsEndpoint, hostile));
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(hostile);
    expect(rowText('KMS endpoint')).toContain('value withheld');
  });

  it('never echoes an out-of-shape KMS timeout', () => {
    const hostile = 'three seconds, give or take, plus a Secret';
    const status = claimingPass(replacing(V3_OBSERVATIONS.kmsTimeout, hostile));
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(hostile);
    expect(rowOutcome('KMS timeout')).toBe('violated');
  });

  it('never echoes an oversized provider list member', () => {
    const oversized = 'k'.repeat(200);
    const status = claimingPass(replacing(V3_OBSERVATIONS.providerOrder, oversized));
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(oversized);
    expect(rowOutcome('Provider order')).toBe('not proven');
  });
});

describe('findings floor the verdict', () => {
  it('fails a payload claiming pass with all four assertions proven but a finding reported', () => {
    // The isolating case: every row is satisfied and the server says pass. Only the
    // findings list forces the failure.
    const status: ControlStatus = {
      ...V3_ENCRYPTION_PASSING,
      verdict: 'pass',
      findings: [
        {
          message: 'The storage-version migration has not completed, so plaintext remains.',
          subject: 'secret/legacy-secret',
          requirementId: 'F-003-RQ-003',
        },
      ],
      evidence: { observations: ALL_PROVEN },
    };
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(verdictText()).toContain('FAIL');
    expect(resolveEncryptionAtRestEffectiveVerdict(status)).toBe('fail');
    expect(rowOutcome('Stored value prefix')).toBe('satisfied');
  });
});

describe('the states that carry no verdict', () => {
  it('announces the loading state and claims nothing', () => {
    renderWithProviders(
      <EncryptionAtRestPanel result={{ status: 'loading', refresh: vi.fn() }} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Checking whether the stored Secret');
    expect(screen.queryByText(/Secrets are encrypted at rest$/)).toBeNull();
  });

  it.each([
    ['a 403 on the status endpoint', FORBIDDEN_CONTROL_STATUS_ERROR],
    ['a 500 on the status endpoint', SERVER_ERROR_CONTROL_STATUS_ERROR],
  ])('renders %s as an alert and never a verdict', (_name, error) => {
    renderWithProviders(
      <EncryptionAtRestPanel result={{ status: 'error', error, refresh: vi.fn() }} />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('could not be verified');
    expect(alert).toHaveTextContent('nothing is reported as passing');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('distinguishes an empty report from a report that omitted this control', () => {
    const { unmount } = renderWithProviders(
      <EncryptionAtRestPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('no posture for this control');
    unmount();

    renderWithProviders(
      <EncryptionAtRestPanel
        result={{
          status: 'success',
          controls: [V3_ENCRYPTION_FAILING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
      />,
    );
    expect(verdictText()).toContain('FAIL');
  });

  it('treats an absent control payload as unknown in the exported resolver', () => {
    expect(resolveEncryptionAtRestEffectiveVerdict(undefined)).toBe('unknown');
  });
});

describe('the interaction case', () => {
  it('re-requests through the supplied handler exactly once per click', async () => {
    const onRefresh = vi.fn();
    const ownRefresh = vi.fn();
    const { user } = renderWithProviders(
      <EncryptionAtRestPanel
        result={{
          status: 'success',
          controls: [V3_ENCRYPTION_PASSING],
          isEmpty: false,
          refresh: ownRefresh,
        }}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Re-check encryption at rest' }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(ownRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EXTERNAL TEXT IS BOUNDED AND REDACTED (M18, AAP §0.11.1).
//
// This panel already refused to echo a measured VALUE into the DOM -- the block above
// proves that -- but its prose channels were rendered as supplied: the summary, the
// detail, the timestamp, the reported requirement identifiers, each finding, each server
// warning, each unrecognised observation's label, and the error message. All of them now
// pass through the shared sanitizer. Two-sided on purpose: dangerous text is withheld AND
// the recorded text survives, because a sanitizer that mangled ordinary prose would push
// the panel back to inventing its own wording.
// ---------------------------------------------------------------------------

describe('external prose is bounded and redacted', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  it('renders the recorded summary and detail verbatim', () => {
    const { container } = renderWithProviders(
      <EncryptionAtRestPanel status={V3_ENCRYPTION_PASSING} />,
    );

    expect(container).toHaveTextContent(V3_ENCRYPTION_PASSING.summary);
    expect(container).toHaveTextContent(V3_ENCRYPTION_PASSING.detail);
  });

  it('renders every recorded finding message verbatim on the failing payload', () => {
    const { container } = renderWithProviders(
      <EncryptionAtRestPanel status={V3_ENCRYPTION_FAILING} />,
    );

    for (const finding of V3_ENCRYPTION_FAILING.findings) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
  });

  it('bounds an oversized summary rather than rendering it', () => {
    const status: ControlStatus = {
      ...V3_ENCRYPTION_PASSING,
      summary: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    };
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(container.textContent).not.toContain('xxxxxxxxxx');
  });

  it('redacts a credential shape out of the detail, a finding and a warning', () => {
    const status: ControlStatus = {
      ...V3_ENCRYPTION_PASSING,
      detail: `the transformer key was ${TOKEN_SHAPED} at the time of the read.`,
      warnings: [`provider reload reported ${TOKEN_SHAPED}`],
      findings: [
        {
          message: `the raw blob began with ${TOKEN_SHAPED} instead.`,
          subject: TOKEN_SHAPED,
          requirementId: 'F-003-RQ-002',
        },
      ],
    };
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
    // The surrounding explanation survives: only the shape is removed.
    expect(container).toHaveTextContent('at the time of the read');
    expect(container).toHaveTextContent('provider reload reported');
  });

  it('bounds the timestamp and the reported requirement identifiers', () => {
    const status: ControlStatus = {
      ...V3_ENCRYPTION_PASSING,
      observedAt: TOKEN_SHAPED,
      requirementIds: [TOKEN_SHAPED],
    };
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(`Observed at ${SAFE_REDACTED}`);
    expect(container).toHaveTextContent(`Reported requirements: ${SAFE_REDACTED}`);
  });

  it('bounds an unrecognised observation LABEL as well as its value', () => {
    // The value was already reduced to a shape; the label was not, and an unrecognised
    // observation on THIS control is exactly where a raw stored blob would arrive.
    const status = claimingPass([...ALL_PROVEN, { label: `leaked ${TOKEN_SHAPED}`, value: 3 }]);
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('collapses control characters out of server prose', () => {
    const status: ControlStatus = {
      ...V3_ENCRYPTION_PASSING,
      summary: 'Ciphertext.\n\u0007\u202EPlaintext for nobody.',
    };
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(container).toHaveTextContent('Ciphertext. Plaintext for nobody.');
  });

  it('bounds the error message while keeping this tier’s own typed explanation', () => {
    renderWithProviders(
      <EncryptionAtRestPanel
        result={{
          status: 'error',
          error: {
            kind: 'http',
            message: `controls.posture.k8s.io is forbidden: ${TOKEN_SHAPED}`,
            httpStatus: 403,
            reason: 'Forbidden',
          },
          refresh: vi.fn(),
        }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(alert).toHaveTextContent('controls.posture.k8s.io is forbidden');
    // `describeFailure` composes locally authored words around the numeric status, so both
    // survive; the server's `reason` inside that same sentence is bounded, and the cases
    // below are what establish it.
    expect(alert).toHaveTextContent('403');
  });

  it('bounds the server’s reason inside the composed failure sentence', () => {
    // HOW THIS GAP SURVIVED A FIRST PASS, recorded so it is not reintroduced: every case above
    // supplies `reason: 'Forbidden'`. It is short, it is a well-known Kubernetes `Status` value,
    // and it reads like a local constant — but nothing in the contract obliges a server to send
    // that rather than key material, and this sentence is the panel's most prominent failure
    // text. `message` was guarded and `reason`, one token away in the same string, was not.
    renderWithProviders(
      <EncryptionAtRestPanel
        result={{
          status: 'error',
          error: {
            kind: 'http',
            message: 'the posture endpoint refused the request',
            httpStatus: 500,
            reason: '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----',
          },
          refresh: vi.fn(),
        }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').not.toContain('BEGIN PRIVATE KEY');
    expect(alert).toHaveTextContent(SAFE_REDACTED);
    // The locally authored sentence is unconditional, so the redaction marker never stands
    // alone and the reader still learns that no verdict was claimed.
    expect(alert).toHaveTextContent('nothing is reported as passing');
    expect(alert).toHaveTextContent('500');
  });

  it('bounds an oversized reason and collapses control characters in it', () => {
    renderWithProviders(
      <EncryptionAtRestPanel
        result={{
          status: 'error',
          error: {
            kind: 'http',
            message: 'the posture endpoint refused the request',
            httpStatus: 500,
            reason: 'z'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
          },
          refresh: vi.fn(),
        }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(alert.textContent ?? '').not.toContain('zzzzzzzzzz');
  });

  it('renders an ordinary reason unchanged — the control for both cases above', () => {
    renderWithProviders(
      <EncryptionAtRestPanel
        result={{
          status: 'error',
          error: {
            kind: 'http',
            message: 'the posture endpoint refused the request',
            httpStatus: 403,
            reason: 'Forbidden',
          },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403 Forbidden (http)');
  });
});

describe('EncryptionAtRestPanel — the connected path, which issues its own request', () => {
  // WHY THIS BLOCK EXISTS. Given neither `result` nor `status`, this panel falls back to a
  // connected variant that reads the posture endpoint through the hook itself. Every case above
  // supplies one prop or the other, so that whole variant — an entire render path a caller gets
  // by writing `<EncryptionAtRestPanel />` — was never executed by any spec. An uncovered render
  // path on the tier's only Critical-severity control is not a coverage statistic; it is a
  // component whose behaviour nothing had checked.

  it('shows its loading affordance first and claims no verdict until the read resolves', async () => {
    const { container } = renderWithProviders(<EncryptionAtRestPanel />);

    // Before the read resolves, the panel is busy and says so. It does NOT show an absence of
    // state, which a reader could take for a clean result.
    expect(container.querySelector('section')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Checking whether the stored Secret');

    await waitFor(() => {
      expect(container.querySelector('section')).toHaveAttribute('aria-busy', 'false');
    });
    // And once resolved it renders the panel proper, with its title intact.
    expect(
      screen.getByRole('heading', { name: /Secrets encryption at rest/ }),
    ).toBeInTheDocument();
  });

  it('disables its refresh affordance when no handler reached it, and explains why', async () => {
    renderWithProviders(<EncryptionAtRestPanel canRefresh={false} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Secrets encryption at rest/ })).toBeInTheDocument();
    });

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });
});
