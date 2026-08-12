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

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V3_OBSERVATIONS } from '../domain/observationIds';
import { AESGCM_PREFIX, PLAINTEXT_CANARY } from '../domain/securityConstants';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  FORBIDDEN_CONTROL_STATUS_ERROR,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V3_ENCRYPTION_FAILING,
  V3_ENCRYPTION_PASSING,
  V3_ENCRYPTION_UNKNOWN,
  V3_EXAMPLE_STORAGE_PREFIX,
} from '../test/fixtures/controlStatus';
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

/** The four measurements a pass rests on, plus the live-prefix context, all proven. */
const ALL_PROVEN: readonly ControlObservation[] = [
  { label: V3_OBSERVATIONS.etcdEntryCount, value: 1 },
  { label: V3_OBSERVATIONS.rawValuePrefix, value: AESGCM_PREFIX },
  { label: V3_OBSERVATIONS.canaryLiteral, value: PLAINTEXT_CANARY },
  { label: V3_OBSERVATIONS.canaryPresentInRawBlob, value: false },
  { label: V3_OBSERVATIONS.plaintextRoundTrip, value: true },
  { label: V3_OBSERVATIONS.storagePrefixFromLiveConfig, value: true },
  { label: V3_OBSERVATIONS.storagePrefixShape, value: V3_EXAMPLE_STORAGE_PREFIX },
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
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.providerOrder, value },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Provider order')).toBe(expected);
  });

  it('does NOT accept an unrecognised sole provider merely because identity is absent', () => {
    // The defect: any list without `identity` passed, so a typo or a removed provider
    // rendered as "no plaintext fallback present" and counted as satisfied.
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.providerOrder, value: 'not-a-provider' },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Provider order')).toBe('not proven');
    expect(rowText('Provider order')).toContain('cannot be confirmed to encrypt');
  });

  it('does not accept the word "ok" as an ordering answer', () => {
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.providerOrder, value: 'ok' },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('Provider order')).toBe('not proven');
  });
});

describe('the manifest boundaries', () => {
  it.each([
    ['the recorded duration', '3s', 'satisfied'],
    ['a different duration', '30s', 'violated'],
    ['a bare number', 3, 'violated'],
  ])('reads a KMS timeout of %s as %s', (_name, value, expected) => {
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.kmsTimeout, value },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('KMS timeout')).toBe(expected);
  });

  it.each([
    ['null', null, 'satisfied'],
    ['false', false, 'satisfied'],
    ['true', true, 'violated'],
    ['a number', 1000, 'violated'],
  ])('reads a cachesize key of %s as %s', (_name, value, expected) => {
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.cachesizeKey, value },
    ]);
    renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(rowOutcome('cachesize key')).toBe(expected);
  });

  it('treats an unreported cachesize key as unproven, not as absent', () => {
    renderWithProviders(<EncryptionAtRestPanel status={claimingPass(ALL_PROVEN)} />);

    expect(rowOutcome('cachesize key')).toBe('not proven');
  });

  it.each([
    ['the recorded list in order', 'secrets, configmaps', 'satisfied'],
    ['the list reversed', 'configmaps, secrets', 'violated'],
    ['a shorter list', 'secrets', 'violated'],
  ])('reads encrypted resources of %s as %s', (_name, value, expected) => {
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.encryptedResources, value },
    ]);
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
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.kmsEndpoint, value: hostile },
    ]);
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(hostile);
    expect(rowText('KMS endpoint')).toContain('value withheld');
  });

  it('never echoes an out-of-shape KMS timeout', () => {
    const hostile = 'three seconds, give or take, plus a Secret';
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.kmsTimeout, value: hostile },
    ]);
    const { container } = renderWithProviders(<EncryptionAtRestPanel status={status} />);

    expect(container.textContent).not.toContain(hostile);
    expect(rowOutcome('KMS timeout')).toBe('violated');
  });

  it('never echoes an oversized provider list member', () => {
    const oversized = 'k'.repeat(200);
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V3_OBSERVATIONS.providerOrder, value: oversized },
    ]);
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
