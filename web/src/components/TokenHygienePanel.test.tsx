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
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  FORBIDDEN_CONTROL_STATUS_ERROR,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V4_ASSUMED_EXPIRY_SECONDS,
  V4_CLAIM_SHAPE,
  V4_EXPIRY_LEEWAY_SECONDS,
  V4_EXPIRY_WINDOW,
  V4_ISSUER,
  V4_OBSERVED_EXPIRY,
  V4_REQUESTED_TTL_SECONDS,
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
    // `token issued: false` is unrecognised as a claim and is reported as such rather
    // than dropped.
    expect(
      screen.getByRole('region', { name: 'Other reported evidence' }),
    ).toHaveTextContent(V4_OBSERVATIONS.tokenIssued);
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

  it('redacts a credential smuggled through the DERIVED required column', () => {
    // The `sub` row's required column is built from the namespace and ServiceAccount
    // name claims, so it is server data wearing a computed shape.
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoNamespace,
      ),
      { label: V4_OBSERVATIONS.kubernetesIoNamespace, value: JWT },
    ]);
    const { container } = renderWithProviders(<TokenHygienePanel status={status} />);

    expect(container.textContent).not.toContain(JWT);
    expect(rowText('claim-sub')).toContain(REDACTED);
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

  it('cannot derive the expected subject when a half of it is missing', () => {
    const status = passingWith(
      V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.kubernetesIoServiceAccountName,
      ),
    );
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-sub')).toBe('unknown');
    expect(rowText('claim-sub')).toContain('expected subject could not be derived');
  });

  it('fails a subject that does not match the derived canonical form', () => {
    const status = passingWith([
      ...V4_TOKEN_EVIDENCE.observations.filter(
        (observation) => observation.label !== V4_OBSERVATIONS.subject,
      ),
      { label: V4_OBSERVATIONS.subject, value: 'system:serviceaccount:other:other' },
    ]);
    renderWithProviders(<TokenHygienePanel status={status} />);

    expect(outcome('claim-sub')).toBe('fail');
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
