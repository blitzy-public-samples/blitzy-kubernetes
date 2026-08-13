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

// AAP §0.5.1 (the `web/src/components/TokenHygienePanel.test.tsx` row — "V4 behaviour:
// Audience and TTL rendering including the boundary TTL") / §0.4.2.4 (the five case
// categories) / §0.7.2 (assertion density: V4 keeps its THREE groups — audience, the expiry
// boundary against BOTH wire values, and the claim shape) / §0.10.2 (the +-60 s window, and
// `pod`/`secret` exactly null) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   The V4 panel identifies each claim EXACTLY and refuses to choose between duplicates; a
//   reported finding floors the verdict at FAIL; no credential-shaped substring reaches the
//   DOM wherever it sits in the text; and a timestamp is read only when it satisfies the
//   RFC 3339 grammar AND names a real calendar instant.
//
// THE FOUR DEFECTS THESE CASES EXIST TO PREVENT, every one of which the compiler and the
// linter accepted:
//
//   1. FIRST MATCH WINS. Claims were located with `observations.find(...)` over a set of
//      loose normalised aliases, documented as "first match wins so that the server's
//      ordering is respected". A payload carrying `kubernetes.io/pod: null` followed by
//      `kubernetes.io/pod: "some-pod"` therefore read as an UNBOUND token — the exact
//      regression F-004-RQ-002 exists to catch, hidden by list order.
//   2. FINDINGS DID NOT FLOOR THE VERDICT. `analyseControl` combined the server verdict,
//      the recomputed rows and the warning channel — and not `control.findings`. A payload
//      reporting a finding this panel measures nothing about rendered `pass` with the
//      finding listed directly underneath it.
//   3. REDACTION ONLY SAW WHOLE WORDS. Prose was split on whitespace and each word tested
//      against an ANCHORED pattern, so `token=<jwt>`, `(<jwt>)`, `"<jwt>"` and `<jwt>,` all
//      survived. The guard ran, reported success, and left the credential on screen.
//   4. `Date.parse` ACCEPTED NON-TIMESTAMPS AND INVALID DATES. `2026-02-30T00:00:00Z`
//      parses and resolves to 2 March, so an expiry moved two days and was then compared as
//      if it were the value the server sent; a date with no offset was read in the HOST
//      time zone, making the output depend on where it ran.
//
// The oracle every required value comes from is `test/integration/auth/svcaccttoken_test.go`
// L1433-L1526, which this workstream never modifies.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V4_OBSERVATIONS } from '../domain/observationIds';
import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  FORBIDDEN_CONTROL_STATUS_ERROR,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V4_ASSUMED_EXPIRY_SECONDS,
  V4_CLAIM_SHAPE,
  V4_EXPIRY_LEEWAY_SECONDS,
  V4_EXPIRY_WINDOW,
  V4_ISSUER,
  V4_NAMESPACE,
  V4_OBSERVED_EXPIRY,
  V4_REQUESTED_TTL_SECONDS,
  V4_SERVICE_ACCOUNT_NAME,
  V4_TOKEN_BOUNDARY_PASSING,
  V4_TOKEN_EVIDENCE,
  V4_TOKEN_FAILING,
  V4_TOKEN_PASSING,
  V4_TOKEN_UNKNOWN,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import TokenHygienePanel, { resolveTokenHygieneEffectiveVerdict } from './TokenHygienePanel';

/**
 * A credential-shaped string, assembled from three eight-character segments.
 *
 * Built rather than written out so this file contains no fragment of any real token, and so
 * the shape being matched is visible in the construction.
 */
const JWT = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].join('.');

/** What the panel renders in place of a credential. */
const REDACTED = '[redacted]';

/** Reads the overall verdict the panel announces. */
function verdictText(): string {
  return screen.getByRole('status').textContent ?? '';
}

/** Reads the `data-outcome` of one check row. */
function outcome(check: string): string {
  const row = document.querySelector(`tr[data-check="${check}"]`);
  expect(row).not.toBeNull();
  return row?.getAttribute('data-outcome') ?? '';
}

/** Reads the whole text of one check row, for its detail wording. */
function rowText(check: string): string {
  return document.querySelector(`tr[data-check="${check}"]`)?.textContent ?? '';
}

/** A passing payload with a replaced observation list. */
function passingWith(observations: readonly ControlObservation[]): ControlStatus {
  return {
    ...V4_TOKEN_PASSING,
    evidence: { ...V4_TOKEN_EVIDENCE, observations },
  };
}

/** A passing payload whose status expiration timestamp is the string under test. */
function withTimestamp(expirationTimestamp: string): ControlStatus {
  return {
    ...V4_TOKEN_PASSING,
    evidence: {
      ...V4_TOKEN_EVIDENCE,
      observedExpiry: { ...V4_OBSERVED_EXPIRY, expirationTimestamp },
    },
  };
}

/** A passing payload whose JWT `exp` claim is the instant under test. */
function withExpirySeconds(expirySeconds: number): ControlStatus {
  return {
    ...V4_TOKEN_PASSING,
    evidence: {
      ...V4_TOKEN_EVIDENCE,
      observedExpiry: { ...V4_OBSERVED_EXPIRY, expirySeconds },
    },
  };
}

describe('the recorded payloads', () => {
  it('renders the recorded PASSING payload as a pass, every row passing', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);

    expect(verdictText()).toBe('Overall verdict: pass');
    expect(resolveTokenHygieneEffectiveVerdict(V4_TOKEN_PASSING)).toBe('pass');
    for (const check of [
      'audience-values',
      'audience-count',
      'requested-ttl',
      'jwt-exp',
      'status-expiration',
      'claim-sub',
      'claim-namespace',
      'claim-serviceaccount-name',
      'claim-pod',
      'claim-secret',
    ]) {
      expect(outcome(check)).toBe('pass');
    }
  });

  it('renders the BOUNDARY payload as a pass, one second inside the late edge', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_BOUNDARY_PASSING} />);

    expect(verdictText()).toBe('Overall verdict: pass');
    expect(outcome('jwt-exp')).toBe('pass');
    expect(outcome('status-expiration')).toBe('pass');
  });

  it('renders the FAILING payload as a fail with all three findings', () => {
    const { container } = renderWithProviders(<TokenHygienePanel status={V4_TOKEN_FAILING} />);

    expect(verdictText()).toBe('Overall verdict: fail');
    expect(V4_TOKEN_FAILING.findings).toHaveLength(3);
    for (const finding of V4_TOKEN_FAILING.findings) {
      expect(container).toHaveTextContent(finding.message);
    }
    // Both wire values are checked independently, so both report the regression.
    expect(outcome('jwt-exp')).toBe('fail');
    expect(outcome('status-expiration')).toBe('fail');
    expect(outcome('audience-values')).toBe('fail');
    expect(outcome('audience-count')).toBe('fail');
  });

  it('renders the UNKNOWN payload as unknown with no window to measure against', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_UNKNOWN} />);

    expect(verdictText()).toBe('Overall verdict: unknown');
    expect(outcome('jwt-exp')).toBe('unknown');
    expect(outcome('status-expiration')).toBe('unknown');
    // `token issued: false` is the ISSUANCE PRECONDITION, so it is acted upon in its
    // own row rather than filed under unrelated evidence. It used to land in "other
    // reported evidence", which reported the observation faithfully and then ignored
    // it — the payload said issuance had failed and the panel evaluated the claims
    // anyway.
    expect(outcome('token-issued')).toBe('unknown');
    expect(rowText('token-issued')).toContain('produced no token');
    expect(
      screen.getByRole('region', { name: 'Other reported evidence' }),
    ).not.toHaveTextContent(V4_OBSERVATIONS.tokenIssued);
  });
});

describe('a duplicated claim is ambiguous, never first-match', () => {
  it('refuses a pod claim reported as null AND as a pod name, null first', () => {
    // THE REGRESSION CASE. Under "first match wins" the leading `null` answered the
    // question and the bound token went unreported.
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations,
      { label: V4_OBSERVATIONS.kubernetesIoPod, value: 'some-pod' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-pod')).toBe('unknown');
    expect(rowText('claim-pod')).toContain('reported more than once');
    expect(rowText('claim-pod')).toContain('taking the first would hide the others');
    expect(verdictText()).toBe('Overall verdict: unknown');
    expect(resolveTokenHygieneEffectiveVerdict(status)).toBe('unknown');
  });

  it('refuses the same pair in the opposite order, so the answer is order-independent', () => {
    const reordered: readonly ControlObservation[] = [
      { label: V4_OBSERVATIONS.kubernetesIoPod, value: 'some-pod' },
      ...V4_TOKEN_EVIDENCE.observations,
    ];
    renderWithProviders(<TokenHygienePanel status={passingWith(reordered)} />);

    expect(outcome('claim-pod')).toBe('unknown');
    expect(verdictText()).toBe('Overall verdict: unknown');
  });

  it.each([
    ['sub', V4_OBSERVATIONS.subject, 'claim-sub'],
    ['namespace', V4_OBSERVATIONS.kubernetesIoNamespace, 'claim-namespace'],
    [
      'serviceaccount name',
      V4_OBSERVATIONS.kubernetesIoServiceAccountName,
      'claim-serviceaccount-name',
    ],
    ['secret', V4_OBSERVATIONS.kubernetesIoSecret, 'claim-secret'],
  ])('refuses a duplicated %s claim', (_name, label, check) => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations,
      { label, value: 'duplicate' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome(check)).toBe('unknown');
    expect(rowText(check)).toContain('reported more than once');
    expect(verdictText()).toBe('Overall verdict: unknown');
  });

  it('names the count, so the reader knows how many copies arrived', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations,
      { label: V4_OBSERVATIONS.kubernetesIoSecret, value: null },
      { label: V4_OBSERVATIONS.kubernetesIoSecret, value: null },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(rowText('claim-secret')).toContain('reported by 3 observations');
  });

  it('does not double-report a duplicated claim as unrelated evidence', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations,
      { label: V4_OBSERVATIONS.kubernetesIoPod, value: 'some-pod' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    // Every copy is recognised as the claim, so no copy leaks into the other-evidence
    // table where it would look like an independent measurement.
    expect(
      screen.getByRole('region', { name: 'Other reported evidence' }),
    ).not.toHaveTextContent(V4_OBSERVATIONS.kubernetesIoPod);
  });

  it('no longer claims a row from a bare single-word label', () => {
    // `pod` used to be an alias, so an unrelated observation folding to that word was
    // read as the claim. It is now reported as unrecognised evidence, which withholds
    // the pass without inventing a claim value.
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoPod,
      ),
      { label: 'pod', value: 'scheduler-probe' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-pod')).toBe('unknown');
    expect(rowText('claim-pod')).toContain('not reported');
    expect(
      screen.getByRole('region', { name: 'Other reported evidence' }),
    ).toHaveTextContent('scheduler-probe');
  });
});

describe('findings floor the verdict', () => {
  it('fails a payload claiming pass with every row passing but one finding reported', () => {
    // The isolating case: no row objects, the warning channel is empty and the server
    // says pass. Only the findings list forces the failure.
    const status: ControlStatus = {
      ...V4_TOKEN_PASSING,
      verdict: 'pass',
      findings: [
        {
          message: 'The issuer rotated without re-issuing the audience binding.',
          subject: `serviceaccount/${V4_CLAIM_SHAPE.kubernetesIoNamespace}`,
          requirementId: 'F-004-RQ-001',
        },
      ],
    };
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(verdictText()).toBe('Overall verdict: fail');
    expect(resolveTokenHygieneEffectiveVerdict(status)).toBe('fail');
    expect(outcome('claim-pod')).toBe('pass');
    expect(outcome('jwt-exp')).toBe('pass');
    expect(
      screen.getByRole('list', { name: 'Reported findings' }),
    ).toHaveTextContent('The issuer rotated');
  });

  it('keeps a warning at warn when nothing else objects', () => {
    const status: ControlStatus = { ...V4_TOKEN_PASSING, warnings: ['audience list is broad'] };
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(verdictText()).toBe('Overall verdict: warn');
  });

  it('fails a finding even when the server reported only a warning', () => {
    const status: ControlStatus = {
      ...V4_TOKEN_PASSING,
      verdict: 'warn',
      warnings: ['audience list is broad'],
      findings: V4_TOKEN_FAILING.findings,
    };
    expect(resolveTokenHygieneEffectiveVerdict(status)).toBe('fail');
  });
});

describe('no credential reaches the DOM, wherever it sits in the text', () => {
  it.each([
    ['standing alone', JWT],
    ['after an equals sign', `token=${JWT}`],
    ['inside parentheses', `(${JWT})`],
    ['inside quotes', `"${JWT}"`],
    ['before a comma', `${JWT}, and more`],
    ['before a full stop', `bearer ${JWT}.`],
    ['immediately after a word', `prefix${JWT}`],
    ['twice in one sentence', `${JWT} then ${JWT}`],
  ])('redacts a credential %s in a finding message', (_name, message) => {
    const status: ControlStatus = {
      ...V4_TOKEN_PASSING,
      findings: [{ message: `Issued ${message} for the audience.` }],
    };
    const { container } = renderWithProviders(<TokenHygienePanel status={status} />);

    expect(container.textContent).not.toContain(JWT);
    expect(container).toHaveTextContent(REDACTED, { normalizeWhitespace: false });
  });

  it('redacts a four-segment credential whole, leaving no trailing segment', () => {
    const four = `${JWT}.dddddddd`;
    const { container } = renderWithProviders(
      <TokenHygienePanel status={{ ...V4_TOKEN_PASSING, findings: [{ message: four }] }} />,
    );

    expect(container.textContent).not.toContain('dddddddd');
  });

  it.each([
    ['the summary', (text: string): ControlStatus => ({ ...V4_TOKEN_PASSING, summary: text })],
    ['the detail', (text: string): ControlStatus => ({ ...V4_TOKEN_PASSING, detail: text })],
    ['a warning', (text: string): ControlStatus => ({ ...V4_TOKEN_PASSING, warnings: [text] })],
    [
      'the observed-at stamp',
      (text: string): ControlStatus => ({ ...V4_TOKEN_PASSING, observedAt: text }),
    ],
    [
      'a finding subject',
      (text: string): ControlStatus => ({
        ...V4_TOKEN_PASSING,
        findings: [{ message: 'a finding', subject: text }],
      }),
    ],
    [
      'a requirement identifier',
      (text: string): ControlStatus => ({ ...V4_TOKEN_PASSING, requirementIds: [text] }),
    ],
  ])('redacts a credential in %s', (_name, build) => {
    const { container } = renderWithProviders(
      <TokenHygienePanel status={build(`value=${JWT}`)} />,
    );

    expect(container.textContent).not.toContain(JWT);
  });

  it('redacts a credential in an unrecognised observation LABEL and value', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations,
      { label: `probe ${JWT}`, value: JWT },
    ]);
    const { container } = renderWithProviders(<TokenHygienePanel status={status} />);

    expect(container.textContent).not.toContain(JWT);
  });

  it('cannot be reached through the required column at all, which is now a constant', () => {
    // SUPERSEDED, AND DELIBERATELY SO. This case used to assert that a credential
    // placed in the namespace claim was REDACTED out of the `sub` row's required
    // column, because that column was built from the payload's own namespace and
    // ServiceAccount-name claims — server data wearing a computed shape. The column is
    // now a module constant recorded from the oracle, so the payload cannot influence
    // it in any way, redacted or otherwise. That is the stronger property, and this
    // case asserts it: the credential is absent from the DOM, the required column
    // still reads the canonical subject, and the credential surfaces only as a
    // redacted OBSERVED value on the row that actually reported it.
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoNamespace,
      ),
      { label: V4_OBSERVATIONS.kubernetesIoNamespace, value: JWT },
    ]);
    const { container } = renderWithProviders(<TokenHygienePanel status={status} />);

    expect(container.textContent).not.toContain(JWT);
    expect(rowText('claim-sub')).toContain(V4_CLAIM_SHAPE.subject);
    expect(rowText('claim-sub')).not.toContain(REDACTED);
    expect(rowText('claim-namespace')).toContain(REDACTED);
  });

  it.each([
    ['a 403 message', FORBIDDEN_CONTROL_STATUS_ERROR],
    ['a 500 message', SERVER_ERROR_CONTROL_STATUS_ERROR],
  ])('redacts a credential in %s and renders no verdict', (_name, error) => {
    const { container } = renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'error',
          error: { ...error, message: `refused: ${JWT}`, reason: `reason ${JWT}` },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container.textContent).not.toContain(JWT);
    expect(screen.getByRole('alert')).toHaveTextContent('no verdict is shown');
    expect(container.querySelector('[data-verdict]')).toBeNull();
  });

  it('redacts a credential-shaped VALUE under an unremarkable label', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations,
      { label: 'issuer echo', value: `Bearer ${JWT}` },
    ]);
    const { container } = renderWithProviders(<TokenHygienePanel status={status} />);

    expect(container.textContent).not.toContain(JWT);
  });

  it('does NOT over-redact the ordinary identifiers this control reports', () => {
    const { container } = renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);

    // Every dotted identifier here has a segment shorter than the eight-character floor,
    // so the guard leaves all of them alone. A regression that widened the shape would
    // start blanking the panel's own evidence.
    expect(container).toHaveTextContent(V4_ISSUER);
    expect(container).toHaveTextContent(V4_CLAIM_SHAPE.subject);
    expect(container).toHaveTextContent('F-004-RQ-001');
    expect(container.textContent).not.toContain(REDACTED);
  });
});

describe('a timestamp must be RFC 3339 and name a real instant', () => {
  it('refuses 2026-02-30 rather than silently reading it as 2 March', () => {
    // THE SEVERE CASE. `Date.parse` accepts this and yields 1772409600 — two days late
    // — which was then compared against the window as though the server had sent it.
    renderWithProviders(<TokenHygienePanel status={withTimestamp('2026-02-30T00:00:00Z')} />);

    expect(outcome('status-expiration')).toBe('unknown');
    expect(rowText('status-expiration')).toContain('could not be read as an instant');
    expect(verdictText()).toBe('Overall verdict: unknown');
  });

  it.each([
    ['a date with no time', '2026-01-01'],
    ['a time with no offset', '2026-01-01T01:00:00'],
    ['a prose date', 'Jan 1 2026 01:00:00 UTC'],
    ['a space in place of the T', '2026-01-01 01:00:00Z'],
    ['surrounding whitespace', '  2026-01-01T01:00:00Z  '],
    ['a basic-format timestamp', '20260101T010000Z'],
    ['unpadded fields', '2026-1-1T01:00:00Z'],
    ['a bare epoch count', '1767229200'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['month 00', '2026-00-01T00:00:00Z'],
    ['day 00', '2026-01-00T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['minute 60', '2026-01-01T01:60:00Z'],
    ['a leap second', '2026-01-01T01:00:60Z'],
    ['a 24-hour offset', '2026-01-01T01:00:00+24:00'],
    ['a 60-minute offset', '2026-01-01T01:00:00+00:60'],
    ['29 February in a common year', '2026-02-29T00:00:00Z'],
    ['29 February in a century year', '2100-02-29T00:00:00Z'],
    ['an empty string', ''],
  ])('reports %s as unreadable rather than converting it', (_name, timestamp) => {
    renderWithProviders(<TokenHygienePanel status={withTimestamp(timestamp)} />);

    expect(outcome('status-expiration')).toBe('unknown');
    expect(rowText('status-expiration')).toContain('could not be read as an instant');
  });

  it.each([
    ['a lowercase z', '2026-01-01T01:00:00z'],
    ['a lowercase t', '2026-01-01t01:00:00Z'],
    ['a fractional second', '2026-01-01T01:00:00.500Z'],
    ['an explicit +00:00 offset', '2026-01-01T01:00:00+00:00'],
    ['a non-UTC offset naming the same instant', '2026-01-01T02:00:00+01:00'],
  ])('accepts %s, which RFC 3339 permits', (_name, timestamp) => {
    renderWithProviders(<TokenHygienePanel status={withTimestamp(timestamp)} />);

    expect(outcome('status-expiration')).toBe('pass');
    expect(verdictText()).toBe('Overall verdict: pass');
  });

  it('accepts 29 February in a genuine leap year', () => {
    // Readable, and out of window — which is the point: the row reports a comparison
    // rather than an unreadable value.
    renderWithProviders(<TokenHygienePanel status={withTimestamp('2024-02-29T00:00:00Z')} />);

    expect(outcome('status-expiration')).toBe('fail');
    expect(rowText('status-expiration')).toContain('out of window');
  });

  it('truncates a fractional second downwards, as .Unix() does', () => {
    // The late edge plus a fraction: truncation keeps it exactly on the inclusive edge,
    // where rounding up would push it out.
    const edge = V4_ASSUMED_EXPIRY_SECONDS + V4_EXPIRY_LEEWAY_SECONDS;
    expect(edge).toBe(V4_EXPIRY_WINDOW.latestSeconds);
    renderWithProviders(<TokenHygienePanel status={withTimestamp('2026-01-01T01:01:00.999Z')} />);

    expect(outcome('status-expiration')).toBe('pass');
    expect(rowText('status-expiration')).toContain('exactly on the window edge');
  });
});

describe('the expiry window is inclusive and fixed', () => {
  it.each([
    ['the early edge', V4_EXPIRY_WINDOW.earliestSeconds, 'pass'],
    ['the late edge', V4_EXPIRY_WINDOW.latestSeconds, 'pass'],
    ['one second before the early edge', V4_EXPIRY_WINDOW.earliestSeconds - 1, 'fail'],
    ['one second after the late edge', V4_EXPIRY_WINDOW.latestSeconds + 1, 'fail'],
    ['the centre', V4_ASSUMED_EXPIRY_SECONDS, 'pass'],
  ])('reads %s as %s', (_name, expirySeconds, expected) => {
    renderWithProviders(<TokenHygienePanel status={withExpirySeconds(expirySeconds)} />);

    expect(outcome('jwt-exp')).toBe(expected);
  });

  it('reports an edge value as being exactly on the edge', () => {
    const edge = V4_EXPIRY_WINDOW.latestSeconds;
    renderWithProviders(<TokenHygienePanel status={withExpirySeconds(edge)} />);

    expect(rowText('jwt-exp')).toContain('exactly on the window edge');
  });

  it('ignores a tolerance the payload reports, showing it only for comparison', () => {
    const widened: ControlStatus = {
      ...V4_TOKEN_PASSING,
      evidence: {
        ...V4_TOKEN_EVIDENCE,
        observedExpiry: {
          ...V4_OBSERVED_EXPIRY,
          expirySeconds: V4_EXPIRY_WINDOW.latestSeconds + 1,
          leewaySeconds: 31_536_000,
        },
      },
    };
    renderWithProviders(<TokenHygienePanel status={widened} />);

    // A payload cannot widen the window by reporting a bigger tolerance.
    expect(outcome('jwt-exp')).toBe('fail');
    expect(screen.getByRole('region', { name: 'Token lifetime' })).toHaveTextContent(
      '31536000 s',
    );
  });

  it('fails a requested lifetime that is not the required one', () => {
    const status: ControlStatus = {
      ...V4_TOKEN_PASSING,
      evidence: { ...V4_TOKEN_EVIDENCE, requestedTtlSeconds: V4_REQUESTED_TTL_SECONDS * 2 },
    };
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('requested-ttl')).toBe('fail');
  });
});

describe('the audience is compared exactly', () => {
  it('fails a superset on both rows, so containment is never sufficient', () => {
    const status: ControlStatus = {
      ...V4_TOKEN_PASSING,
      evidence: { ...V4_TOKEN_EVIDENCE, audiences: ['api', 'extra.example.com'] },
    };
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('audience-values')).toBe('fail');
    expect(outcome('audience-count')).toBe('fail');
  });

  it('distinguishes an absent audience from one reported as empty', () => {
    const { unmount } = renderWithProviders(
      <TokenHygienePanel
        status={{ ...V4_TOKEN_PASSING, evidence: { ...V4_TOKEN_EVIDENCE, audiences: undefined } }}
      />,
    );
    expect(outcome('audience-values')).toBe('unknown');
    expect(screen.getByRole('region', { name: 'Audience binding' })).toHaveTextContent(
      'No audience was reported',
    );
    unmount();

    renderWithProviders(
      <TokenHygienePanel
        status={{ ...V4_TOKEN_PASSING, evidence: { ...V4_TOKEN_EVIDENCE, audiences: [] } }}
      />,
    );
    expect(outcome('audience-values')).toBe('fail');
    expect(screen.getByRole('region', { name: 'Audience binding' })).toHaveTextContent(
      'reported an empty audience list',
    );
  });
});

describe('the claim shape is proven, never assumed', () => {
  it.each([
    ['pod', V4_OBSERVATIONS.kubernetesIoPod, 'claim-pod'],
    ['secret', V4_OBSERVATIONS.kubernetesIoSecret, 'claim-secret'],
  ])('fails a non-null %s sub-claim', (_name, label, check) => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter((observation) => observation.label !== label),
      { label, value: 'bound-object' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome(check)).toBe('fail');
    expect(rowText(check)).toContain('legacy or object-bound token');
    expect(verdictText()).toBe('Overall verdict: fail');
  });

  it.each([
    ['pod', V4_OBSERVATIONS.kubernetesIoPod, 'claim-pod'],
    ['secret', V4_OBSERVATIONS.kubernetesIoSecret, 'claim-secret'],
  ])('treats an ABSENT %s sub-claim as unverified, not as proof', (_name, label, check) => {
    // An absent claim is not proof of an unbound token: a server that never emits it
    // would satisfy an absence check while issuing bound tokens.
    const status = passingWith(
      V4_TOKEN_EVIDENCE.observations.filter((observation) => observation.label !== label),
    );
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome(check)).toBe('unknown');
    expect(verdictText()).toBe('Overall verdict: unknown');
  });

  it('renders a null sub-claim as the visible word null', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);

    expect(rowText('claim-pod')).toContain('null');
    expect(rowText('claim-secret')).toContain('null');
  });

  it('checks the subject on its own when a sub-claim is missing, not against it', () => {
    // SUPERSEDED, AND DELIBERATELY SO. This case used to assert that a missing
    // ServiceAccount-name claim made the subject row UNVERIFIABLE, because the
    // expectation was derived from that very claim — so removing one input silenced a
    // different row's verdict. The three rows are now independent: the subject is
    // measured against the trusted constant and still resolves, and only the row whose
    // own claim is missing reads "could not verify".
    const status = passingWith(
      V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoServiceAccountName,
      ),
    );
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-sub')).toBe('pass');
    expect(rowText('claim-sub')).toContain('matches the canonical subject');
    expect(outcome('claim-serviceaccount-name')).toBe('unknown');
    expect(rowText('claim-serviceaccount-name')).toContain('the claim was not reported');
    expect(verdictText()).toBe('Overall verdict: unknown');
  });

  it('fails a subject that does not match the canonical form', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.subject,
      ),
      { label: V4_OBSERVATIONS.subject, value: 'system:serviceaccount:other:other' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-sub')).toBe('fail');
  });

  // -------------------------------------------------------------------------
  // M5, part 1 — the trusted-identity comparison.
  //
  // THE DEFECT. `expectedSubject` built the expected `sub` value from the payload's
  // OWN `kubernetes.io/namespace` and `kubernetes.io/serviceaccount/name` claims, and
  // the namespace and name rows themselves asserted only that each was A NON-EMPTY
  // STRING. All three checks therefore passed for ANY self-consistent identity: a
  // token reporting `sub: system:serviceaccount:evil:evil` alongside namespace `evil`
  // and name `evil` matched its own expectation on all three rows. The panel was
  // measuring internal consistency and reporting it as identity.
  //
  // THE ORACLE does not do that. It builds its expectation from `ns.Name` and
  // `sa.Name` — the names IT created, which no token can influence — and makes three
  // independent EQUALITY assertions against them (`svcaccttoken_test.go`
  // L1521-L1523). Each case below is a token that the old code passed.
  // -------------------------------------------------------------------------

  it('fails a SELF-CONSISTENT identity for a different account on all three rows', () => {
    // THE REGRESSION CASE, exactly as the finding describes it. Every one of the three
    // identity claims names `evil`, so the payload agrees with itself perfectly.
    const foreignSubject = 'system:serviceaccount:evil:evil';
    const status = passingWith([
      { label: V4_OBSERVATIONS.tokenIssued, value: true },
      { label: V4_OBSERVATIONS.subject, value: foreignSubject },
      { label: V4_OBSERVATIONS.kubernetesIoNamespace, value: 'evil' },
      { label: V4_OBSERVATIONS.kubernetesIoServiceAccountName, value: 'evil' },
      { label: V4_OBSERVATIONS.kubernetesIoPod, value: null },
      { label: V4_OBSERVATIONS.kubernetesIoSecret, value: null },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-sub')).toBe('fail');
    expect(outcome('claim-namespace')).toBe('fail');
    expect(outcome('claim-serviceaccount-name')).toBe('fail');
    expect(verdictText()).toBe('Overall verdict: fail');
    expect(resolveTokenHygieneEffectiveVerdict(status)).toBe('fail');
  });

  it('states the trusted expectation in the required column, not the observed value', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoNamespace,
      ),
      { label: V4_OBSERVATIONS.kubernetesIoNamespace, value: 'somewhere-else' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    // Both values are on screen, so the reader can see exactly what was expected and
    // what arrived. Under the old rule the required column would have read
    // `somewhere-else` and the row would have passed.
    expect(rowText('claim-namespace')).toContain(V4_NAMESPACE);
    expect(rowText('claim-namespace')).toContain('somewhere-else');
    expect(outcome('claim-namespace')).toBe('fail');
  });

  it.each([
    ['the namespace claim', V4_OBSERVATIONS.kubernetesIoNamespace, 'claim-namespace'],
    [
      'the ServiceAccount-name claim',
      V4_OBSERVATIONS.kubernetesIoServiceAccountName,
      'claim-serviceaccount-name',
    ],
  ])('fails a non-empty but WRONG value for %s', (_name, label, check) => {
    // Under the superseded presence rule every one of these passed: each is a
    // non-empty string, which was the entire test.
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter((observation) => observation.label !== label),
      { label, value: 'not-the-account-under-test' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome(check)).toBe('fail');
    expect(verdictText()).toBe('Overall verdict: fail');
  });

  it.each([
    ['a namespace-only substitution', 'system:serviceaccount:other:test-svcacct'],
    ['a name-only substitution', 'system:serviceaccount:myns-v4:other-svcacct'],
    ['a missing prefix', 'myns-v4:test-svcacct'],
    ['a trailing separator', 'system:serviceaccount:myns-v4:test-svcacct:'],
    ['a leading space', ' system:serviceaccount:myns-v4:test-svcacct'],
  ])('fails a subject that differs from the canonical one by %s', (_name, subject) => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.subject,
      ),
      { label: V4_OBSERVATIONS.subject, value: subject },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-sub')).toBe('fail');
    expect(rowText('claim-sub')).toContain('does not match the canonical subject');
  });

  it('derives the canonical subject from the two trusted names, so they cannot drift', () => {
    // Not a rendering assertion: an arithmetic one over the recorded fixture, proving
    // the constant the panel compares against and the value the fixture records are the
    // same string for the same reason rather than by coincidence.
    expect(V4_CLAIM_SHAPE.subject).toBe(
      `system:serviceaccount:${V4_NAMESPACE}:${V4_SERVICE_ACCOUNT_NAME}`,
    );
    expect(V4_NAMESPACE).toBe('myns-v4');
    expect(V4_SERVICE_ACCOUNT_NAME).toBe('test-svcacct');
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
  ])('fails an identity claim reported as %s rather than as the expected string', (_name, value) => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoNamespace,
      ),
      { label: V4_OBSERVATIONS.kubernetesIoNamespace, value },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-namespace')).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// M5, part 2 — the issuance precondition.
//
// THE DEFECT. `tokenIssued` was read by nothing. A payload explicitly reporting
// that issuance had produced no token could still be rendered as a pass on the
// strength of claim, audience and expiry observations that, by its own account, came
// from no token at all.
//
// THE ORACLE aborts first: `token := treq.Status.Token; if token == "" {
// t.Fatalf("expected a non-empty projected token") }` (`svcaccttoken_test.go`
// L1484-L1487). EVERY subsequent assertion — the audience, both expiry bounds, the
// echoed request spec and all five claim assertions — sits after that abort.
//
// The translation of a `t.Fatalf` in this tier is "could not verify" and never
// "fail" (AAP §0.4.1.2): an unissued token is a measurement that did not run, not a
// hardening defect.
// ---------------------------------------------------------------------------

describe('the issuance precondition gates every dependent check', () => {
  /** Every check that is downstream of issuance, and therefore withheld without it. */
  const DEPENDENT_CHECKS: readonly string[] = [
    'audience-values',
    'audience-count',
    'requested-ttl',
    'jwt-exp',
    'status-expiration',
    'claim-sub',
    'claim-namespace',
    'claim-serviceaccount-name',
    'claim-pod',
    'claim-secret',
  ];

  /** The recorded observations with the issuance entry removed. */
  function withoutIssuance(): readonly ControlObservation[] {
    return V4_TOKEN_EVIDENCE.observations.filter(
      (observation) => observation.label !== V4_OBSERVATIONS.tokenIssued,
    );
  }

  it('passes the precondition on the recorded payload, so the gate is two-sided', () => {
    // THE CONTROL. Without it every withholding case below would hold vacuously, over
    // a baseline that never produced a pass in the first place.
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);

    expect(outcome('token-issued')).toBe('pass');
    expect(rowText('token-issued')).toContain('a token was issued');
    for (const check of DEPENDENT_CHECKS) {
      expect(outcome(check)).toBe('pass');
    }
    expect(verdictText()).toBe('Overall verdict: pass');
  });

  it.each([
    [
      'issuance reported as false',
      (): readonly ControlObservation[] => [
        { label: V4_OBSERVATIONS.tokenIssued, value: false },
        ...withoutIssuance(),
      ],
      'produced no token',
    ],
    [
      'issuance never reported',
      (): readonly ControlObservation[] => withoutIssuance(),
      'did not say whether a token was issued',
    ],
    [
      'issuance reported twice, disagreeing',
      (): readonly ControlObservation[] => [
        { label: V4_OBSERVATIONS.tokenIssued, value: true },
        { label: V4_OBSERVATIONS.tokenIssued, value: false },
        ...withoutIssuance(),
      ],
      'reported more than once',
    ],
    [
      'issuance reported twice, agreeing',
      (): readonly ControlObservation[] => [
        { label: V4_OBSERVATIONS.tokenIssued, value: true },
        { label: V4_OBSERVATIONS.tokenIssued, value: true },
        ...withoutIssuance(),
      ],
      'reported more than once',
    ],
    [
      'issuance reported as a string',
      (): readonly ControlObservation[] => [
        { label: V4_OBSERVATIONS.tokenIssued, value: 'true' },
        ...withoutIssuance(),
      ],
      'something other than true or false',
    ],
    [
      'issuance reported as null',
      (): readonly ControlObservation[] => [
        { label: V4_OBSERVATIONS.tokenIssued, value: null },
        ...withoutIssuance(),
      ],
      'something other than true or false',
    ],
  ])('withholds every dependent check when %s', (_name, build, phrase) => {
    const status = passingWith(build());
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('token-issued')).toBe('unknown');
    expect(rowText('token-issued')).toContain(phrase);
    for (const check of DEPENDENT_CHECKS) {
      expect(outcome(check)).toBe('unknown');
      expect(rowText(check)).toContain('withheld');
    }
    // The payload declares `pass` and carries a complete, compliant evidence bag. It
    // is nonetheless UNKNOWN, because nothing in it can be attributed to a token.
    expect(status.verdict).toBe('pass');
    expect(verdictText()).toBe('Overall verdict: unknown');
    expect(resolveTokenHygieneEffectiveVerdict(status)).toBe('unknown');
  });

  it('is UNKNOWN and never FAIL when issuance failed, matching the oracle abort', () => {
    // The oracle `t.Fatalf`s on an empty token, which is setup breakage rather than a
    // finding about the control. Reporting it as a failure would name a hardening
    // defect the evidence does not show.
    const status = passingWith([
      { label: V4_OBSERVATIONS.tokenIssued, value: false },
      ...withoutIssuance(),
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('token-issued')).not.toBe('fail');
    expect(verdictText()).toBe('Overall verdict: unknown');
  });

  it('keeps the observed value on a withheld row, so nothing is hidden', () => {
    const status = passingWith([
      { label: V4_OBSERVATIONS.tokenIssued, value: false },
      ...withoutIssuance(),
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    // Withholding withdraws the COMPARISON, not the evidence: the reader still sees
    // what arrived, alongside the reason it was not acted upon.
    expect(rowText('claim-sub')).toContain(V4_CLAIM_SHAPE.subject);
    expect(rowText('claim-sub')).toContain('withheld');
    expect(rowText('requested-ttl')).toContain(String(V4_REQUESTED_TTL_SECONDS));
  });

  it('explains the withholding in the section prose as well as in the row', () => {
    const status = passingWith([
      { label: V4_OBSERVATIONS.tokenIssued, value: false },
      ...withoutIssuance(),
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    const region = screen.getByRole('region', { name: 'Token issuance' });
    expect(region).toHaveTextContent('The checks below are withheld');
    expect(region).toHaveTextContent('produced no token');
  });

  it('says nothing about withholding when the precondition holds', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);

    expect(screen.getByRole('region', { name: 'Token issuance' })).not.toHaveTextContent(
      'The checks below are withheld',
    );
  });

  it('renders the issuance section BEFORE everything it gates', () => {
    // Order is part of the fix: a reader who meets the precondition after the rows it
    // governs has already read three tables of withheld results without knowing why.
    const { container } = renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);
    const headings = [...container.querySelectorAll('h3')].map((node) => node.textContent);

    expect(headings.indexOf('Token issuance')).toBe(0);
    expect(headings.indexOf('Token issuance')).toBeLessThan(headings.indexOf('Audience binding'));
    expect(headings.indexOf('Token issuance')).toBeLessThan(headings.indexOf('Token lifetime'));
    expect(headings.indexOf('Token issuance')).toBeLessThan(headings.indexOf('Claim shape'));
  });

  it('evaluates rather than withholds on the recorded FAILING payload', () => {
    // A token WAS issued there; its defects are in what it contains. Withholding those
    // rows would turn a measured failure into "could not verify" and lose the finding.
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_FAILING} />);

    expect(outcome('token-issued')).toBe('pass');
    expect(outcome('audience-values')).toBe('fail');
    expect(outcome('jwt-exp')).toBe('fail');
    expect(rowText('audience-values')).not.toContain('withheld');
    expect(verdictText()).toBe('Overall verdict: fail');
  });

  it('does not report the issuance observation twice', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);

    // Recognised as the precondition, so it is acted upon in its own row and is NOT
    // also listed as unrelated evidence — where it would look like a measurement the
    // panel had not used.
    expect(rowText('token-issued')).toContain(V4_OBSERVATIONS.tokenIssued);
    expect(
      screen.getByRole('region', { name: 'Other reported evidence' }),
    ).not.toHaveTextContent(V4_OBSERVATIONS.tokenIssued);
  });
});

describe('the states that carry no verdict', () => {
  it('announces the loading state and claims nothing', () => {
    const { container } = renderWithProviders(
      <TokenHygienePanel result={{ status: 'loading', refresh: vi.fn() }} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Requesting the ServiceAccount token');
    expect(container.querySelector('[data-verdict]')).toBeNull();
  });

  it('distinguishes an empty report from a report that omitted this control', () => {
    const { unmount } = renderWithProviders(
      <TokenHygienePanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('no control posture at all');
    unmount();

    renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'success',
          controls: [V4_TOKEN_FAILING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
      />,
    );
    expect(verdictText()).toBe('Overall verdict: fail');
  });

  it('treats an absent control payload as unknown in the exported resolver', () => {
    expect(resolveTokenHygieneEffectiveVerdict(undefined)).toBe('unknown');
  });
});

describe('the interaction case', () => {
  it('re-requests through the supplied handler exactly once per click', async () => {
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <TokenHygienePanel status={V4_TOKEN_PASSING} onRefresh={onRefresh} />,
    );

    await user.click(screen.getByRole('button', { name: 'Re-request token posture' }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the control, with a reason, when there is nothing to re-request', () => {
    renderWithProviders(<TokenHygienePanel status={V4_TOKEN_PASSING} />);
    const button = screen.getByRole('button', { name: 'Re-request token posture' });

    // A payload handed over directly owns no request. An enabled button here would
    // promise a re-check it cannot perform, so the affordance explains itself instead.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
    expect(verdictText()).toBe('Overall verdict: pass');
  });

  it('calls the override instead of the underlying refresh when both exist', async () => {
    const onRefresh = vi.fn();
    const refresh = vi.fn();
    const { user } = renderWithProviders(
      <TokenHygienePanel
        result={{ status: 'success', controls: [V4_TOKEN_PASSING], isEmpty: false, refresh }}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Re-request token posture' }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables every refresh route when the caller says refreshing is unavailable', () => {
    renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'success',
          controls: [V4_TOKEN_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
        onRefresh={vi.fn()}
        canRefresh={false}
      />,
    );
    const button = screen.getByRole('button', { name: 'Re-request token posture' });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });
});

describe('TokenHygienePanel — external prose is bounded, not only credential-redacted', () => {
  // WHY THIS BLOCK EXISTS. The panel's prose guard replaced credential SHAPES and did nothing
  // about three other properties of untrusted text, so all three reached the DOM: unbounded
  // length, control characters, and bidirectional overrides. The last is the one that matters
  // most here, because U+202E reorders every glyph after it and this prose feeds an affordance
  // that announces itself — a reversed sentence in an alert can state the opposite of the text
  // actually present. The guard now composes the shared bound over the local substitution, so
  // this panel keeps its own `[redacted]` marker and gains the bounds.

  it('renders an ordinary failure message unchanged — the control', () => {
    const { container } = renderWithProviders(
      <TokenHygienePanel
        result={{ status: 'error', error: SERVER_ERROR_CONTROL_STATUS_ERROR, refresh: vi.fn() }}
      />,
    );

    expect(container).toHaveTextContent(SERVER_ERROR_CONTROL_STATUS_ERROR.message);
  });

  it('bounds an oversized failure message instead of rendering all of it', () => {
    const { container } = renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'error',
          error: {
            ...SERVER_ERROR_CONTROL_STATUS_ERROR,
            message: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
          },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(container.textContent ?? '').not.toContain('xxxxxxxxxx');
  });

  it('strips a bidirectional override out of the failure message', () => {
    const { container } = renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'error',
          error: {
            ...SERVER_ERROR_CONTROL_STATUS_ERROR,
            message: 'The token was rejected.\u202E',
            reason: 'InternalError\u202D',
          },
          refresh: vi.fn(),
        }}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u202E');
    expect(text).not.toContain('\u202D');
    expect(container).toHaveTextContent('The token was rejected.');
  });

  it('collapses control characters out of a summary and a detail', () => {
    const { container } = renderWithProviders(
      <TokenHygienePanel
        status={{
          ...V4_TOKEN_PASSING,
          summary: 'Token bound.\u0000\u0007 Audience exact.',
          detail: 'Expiry within the window.\n\n\u0008Nothing else was measured.',
        }}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u0000');
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u0008');
    expect(container).toHaveTextContent('Token bound. Audience exact.');
  });

  it('presents ONE redaction marker, the two constants being the same text', () => {
    // Adding a second guard over prose raised the question of whether a reader could end up
    // seeing two different markers for one meaning. They cannot, and this records WHY rather
    // than assuming it: the panel's local marker and the shared one are the same string, so
    // whichever pass performs a substitution the rendered wording is identical. Asserted
    // directly, because it is the constants being equal — not the composition order — that
    // makes this true, and a future change to either constant should fail here.
    expect(REDACTED).toBe(SAFE_REDACTED);

    const { container } = renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'error',
          error: { ...SERVER_ERROR_CONTROL_STATUS_ERROR, message: `refused: ${JWT}` },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container.textContent).not.toContain(JWT);
    expect(container).toHaveTextContent(REDACTED);
  });

  it('redacts a credential that is ALSO past the length bound', () => {
    // The two guards compose rather than one shadowing the other: a message long enough to be
    // replaced wholesale must not first leak the credential it carried, and a message carrying
    // a credential must not escape the bound by virtue of having been redacted.
    const { container } = renderWithProviders(
      <TokenHygienePanel
        result={{
          status: 'error',
          error: {
            ...SERVER_ERROR_CONTROL_STATUS_ERROR,
            message: `refused: ${JWT} ${'y'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH)}`,
          },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container.textContent).not.toContain(JWT);
    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
  });
});

