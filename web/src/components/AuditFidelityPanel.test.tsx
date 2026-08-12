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

// AAP §0.5.1 (the `web/src/components/AuditFidelityPanel.test.tsx` row — "V6 behaviour |
// Per-resource level table rendering") / §0.4.2.4 (the five case categories every panel spec
// covers) / §0.10.2 (the boundary rows "Audit level ordering", "Sensitive-resource levels"
// and "Confidentiality guard") / §0.7.2 (assertion density: V6 keeps the full matrix plus
// the confidentiality guard) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   The V6 panel's rendered verdict is derived from the evidence, so a Secret response body
//   or a `secrets` level away from `Request` is a FAILURE even when the check reported a
//   pass — and a pass is withheld when the three required measurements were not all
//   demonstrated.
//
// THE DEFECT THESE CASES EXIST TO PREVENT, which the compiler and the linter both accepted:
// `AuditFidelityVerdict` read `control.verdict` verbatim. The panel already computed, per
// observed event, that a `secrets` event carried a `responseObject` or sat above or below
// `Request`, and it rendered those findings in a table cell — while the headline two
// elements above still read "Pass — Every sensitive resource is audited at its measured
// level, and no audited response body was recorded for a resource that must omit one." The
// panel contradicted its own evidence, and a reader who trusted the headline was told the
// control held when the panel had proof it did not.
//
// The oracle is `test/integration/controlplane/audit/audit_test.go`: the per-resource
// expectations at L812-851 and L859-948, and the confidentiality guard at L1043-1047 whose
// `t.Errorf` accumulates so that EVERY offending event is reported in one run. The level
// aliases and their strict total order are measured from
// `cluster/gce/gci/audit_policy_test.go` L120-125.
//
// NO AUDITED PAYLOAD IS EVER ASSERTED ON HERE EITHER. The cases below hand the panel events
// carrying request and response bodies, and assert on the PRESENCE prose the panel renders —
// never on body contents — so this spec cannot become the thing that puts a Secret payload
// in a CI log.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V6_OBSERVATIONS, v6ResourceLevelObservation } from '../domain/observationIds';
import type { AuditEvent } from '../hooks/useAuditEvents';
import { AUDIT_LEVEL_ORDER } from '../hooks/useAuditEvents';
import type {
  ControlObservation,
  ControlStatus,
  UseControlStatusResult,
} from '../hooks/useControlStatus';
import {
  CONTROL_STATUS_ERRORS,
  SECRETS_AUDIT_LEVEL,
  V6_AUDIT_FAILING,
  V6_AUDIT_PASSING,
  V6_AUDIT_UNKNOWN,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import AuditFidelityPanel, {
  resolveAuditFidelityEffectiveVerdict,
} from './AuditFidelityPanel';

/** The identity of the per-resource row whose level is the load-bearing boundary. */
const SECRETS_ROW_ID = v6ResourceLevelObservation('', ['secrets'], 'secret-audit-request');

/** The three required measurements, all satisfied. */
const ALL_REQUIRED_PROVEN: readonly ControlObservation[] = [
  { label: V6_OBSERVATIONS.secretsAuditLevel, value: SECRETS_AUDIT_LEVEL },
  { label: V6_OBSERVATIONS.secretsResponseObjectCount, value: 0 },
  { label: V6_OBSERVATIONS.levelOrdering, value: AUDIT_LEVEL_ORDER.join(' < ') },
];

/** A payload claiming `pass`, carrying exactly the observations under test. */
function claimingPass(observations: readonly ControlObservation[]): ControlStatus {
  return {
    ...V6_AUDIT_PASSING,
    findings: [],
    warnings: [],
    evidence: { observations },
  };
}

/** The successful hook arm for one payload. */
function success(control: ControlStatus): UseControlStatusResult {
  return { status: 'success', controls: [control], isEmpty: false, refresh: vi.fn() };
}

/** {@link ALL_REQUIRED_PROVEN} with one measurement removed by identity. */
function without(label: string): readonly ControlObservation[] {
  const remaining = ALL_REQUIRED_PROVEN.filter((observation) => observation.label !== label);
  if (remaining.length === ALL_REQUIRED_PROVEN.length) {
    throw new Error(`"${label}" is not a required measurement, so removing it is a no-op.`);
  }
  return remaining;
}

/** {@link ALL_REQUIRED_PROVEN} with one measurement's value replaced. */
function replacing(
  label: string,
  value: ControlObservation['value'],
): readonly ControlObservation[] {
  if (!ALL_REQUIRED_PROVEN.some((observation) => observation.label === label)) {
    throw new Error(`"${label}" is not a required measurement, so replacing it is a no-op.`);
  }
  return ALL_REQUIRED_PROVEN.map((observation) =>
    observation.label === label ? { label, value } : observation,
  );
}

/**
 * One observed audit event.
 *
 * The bodies are deliberately trivial and carry no credential, key or realistic
 * payload: the panel reads only their PRESENCE, so their contents are irrelevant to
 * every assertion here and a plausible-looking Secret body would be a fixture
 * hazard for no benefit.
 */
function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    kind: 'Event',
    apiVersion: 'audit.k8s.io/v1',
    level: SECRETS_AUDIT_LEVEL,
    auditID: 'audit-1',
    stage: 'ResponseComplete',
    requestURI: '/api/v1/namespaces/secret-audit-request/secrets',
    verb: 'create',
    user: { username: 'system:apiserver' },
    requestReceivedTimestamp: '2026-02-01T00:00:00.000000Z',
    stageTimestamp: '2026-02-01T00:00:00.100000Z',
    objectRef: { resource: 'secrets', namespace: 'secret-audit-request', name: 'audit-secret' },
    ...overrides,
  };
}

/** The verdict the rendered badge carries. */
function renderedVerdict(container: HTMLElement): string | null {
  return container.querySelector('[data-verdict]')?.getAttribute('data-verdict') ?? null;
}

/** The result attribute of one measurement row. */
function measurementResult(container: HTMLElement, identity: string): string | null {
  return (
    container.querySelector(`[data-measurement="${identity}"]`)?.getAttribute('data-result') ?? null
  );
}

describe('AuditFidelityPanel — the recorded payloads render their recorded verdicts', () => {
  it('renders PASS for the recorded passing payload', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(renderedVerdict(container)).toBe('pass');
    expect(container).toHaveTextContent(V6_AUDIT_PASSING.summary);
  });

  it('establishes all three required measurements from the recorded passing payload', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(measurementResult(container, V6_OBSERVATIONS.secretsAuditLevel)).toBe('satisfied');
    expect(measurementResult(container, V6_OBSERVATIONS.secretsResponseObjectCount)).toBe(
      'satisfied',
    );
    expect(measurementResult(container, V6_OBSERVATIONS.levelOrdering)).toBe('satisfied');
  });

  it('reads the per-resource secrets row of the recorded passing payload', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(measurementResult(container, SECRETS_ROW_ID)).toBe('satisfied');
  });

  it('renders FAIL for the recorded failing payload and names every finding', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_FAILING)} />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    for (const finding of V6_AUDIT_FAILING.findings) {
      expect(container).toHaveTextContent(finding.message);
    }
  });

  it('reports the recorded failing payload as a level violation and a guard violation', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_FAILING)} />,
    );

    expect(measurementResult(container, V6_OBSERVATIONS.secretsAuditLevel)).toBe('violated');
    expect(measurementResult(container, V6_OBSERVATIONS.secretsResponseObjectCount)).toBe(
      'violated',
    );
  });

  it('renders UNKNOWN for the recorded no-events-observed payload', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_UNKNOWN)} />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent('treat the control as unverified');
  });

  it('agrees with the exported resolver on all three recorded payloads', () => {
    expect(resolveAuditFidelityEffectiveVerdict(V6_AUDIT_PASSING)).toBe('pass');
    expect(resolveAuditFidelityEffectiveVerdict(V6_AUDIT_FAILING)).toBe('fail');
    expect(resolveAuditFidelityEffectiveVerdict(V6_AUDIT_UNKNOWN)).toBe('unknown');
  });
});

describe('AuditFidelityPanel — a local confidentiality violation is a failure (the defect)', () => {
  it('renders FAIL when a pass payload is given a secrets event with a response body', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[event({ responseObject: { kind: 'Secret' } })]}
      />,
    );

    expect(renderedVerdict(container)).toBe('fail');
  });

  it('states the disagreement rather than leaving two elements to contradict each other', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[event({ responseObject: { kind: 'Secret' } })]}
      />,
    );

    expect(container.querySelector('[data-disagreement="fail"]')).not.toBeNull();
    expect(container).toHaveTextContent('The check reported pass for this control');
  });

  it('never renders the pass affordance beside a recorded response body', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[event({ responseObject: { kind: 'Secret' } })]}
      />,
    );

    expect(container).not.toHaveTextContent('no audited response body was recorded');
  });

  it.each(['None', 'Metadata', 'RequestResponse'] as const)(
    'renders FAIL when an observed secrets event is audited at %s',
    (level) => {
      const status = claimingPass(ALL_REQUIRED_PROVEN);

      expect(resolveAuditFidelityEffectiveVerdict(status, [event({ level })])).toBe('fail');
    },
  );

  it('distinguishes an over-collection from an under-collection in words', () => {
    const above = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[event({ level: 'RequestResponse' })]}
      />,
    );
    expect(above.container).toHaveTextContent('the payload reached the audit log');
    above.unmount();

    const below = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[event({ level: 'Metadata' })]}
      />,
    );
    expect(below.container).toHaveTextContent('drops the forensic record');
  });

  it('reports EVERY offending event, and every finding within one event', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[
          event({ auditID: 'audit-1', responseObject: { kind: 'Secret' } }),
          event({
            auditID: 'audit-2',
            level: 'RequestResponse',
            responseObject: { kind: 'Secret' },
          }),
        ]}
      />,
    );

    // One finding for the first event's response body, then TWO for the second —
    // its response body AND its raised level — because the Go guard's `t.Errorf`
    // records and continues both across events and within one.
    const findings = container.querySelectorAll('.audit-fidelity-panel__local-findings > li');
    expect(findings.length).toBe(3);
  });

  it('leaves a response body on a NON-secrets resource alone', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const roleEvent = event({
      level: 'RequestResponse',
      objectRef: { resource: 'roles', namespace: 'rbac-audit-response', name: 'audit-role' },
      responseObject: { kind: 'Role' },
    });

    expect(resolveAuditFidelityEffectiveVerdict(status, [roleEvent])).toBe('pass');
  });

  it('leaves a requestObject on a secrets event alone — the accepted trade-off', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const withRequestBody = event({ requestObject: { kind: 'Secret' } });

    expect(resolveAuditFidelityEffectiveVerdict(status, [withRequestBody])).toBe('pass');
  });

  it('never renders an audited body, for either resource', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(claimingPass(ALL_REQUIRED_PROVEN))}
        events={[
          event({
            requestObject: { marker: 'REQUEST_BODY_MARKER' },
            responseObject: { marker: 'RESPONSE_BODY_MARKER' },
          }),
        ]}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).not.toContain('REQUEST_BODY_MARKER');
    expect(text).not.toContain('RESPONSE_BODY_MARKER');
    expect(container).toHaveTextContent('Request body recorded; response body recorded.');
  });
});

describe('AuditFidelityPanel — a pass must be earned', () => {
  it('grants the pass when exactly the three required measurements are proven', () => {
    expect(resolveAuditFidelityEffectiveVerdict(claimingPass(ALL_REQUIRED_PROVEN))).toBe('pass');
  });

  it.each([
    ['the secrets level', V6_OBSERVATIONS.secretsAuditLevel],
    ['the response-body count', V6_OBSERVATIONS.secretsResponseObjectCount],
    ['the level ordering', V6_OBSERVATIONS.levelOrdering],
  ])('withholds the pass when %s is unreported', (_name, identity) => {
    expect(resolveAuditFidelityEffectiveVerdict(claimingPass(without(identity)))).toBe('unknown');
  });

  it('withholds the pass for a payload claiming one and reporting nothing at all', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass([]))} />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('never reads a null response-body count as a count of zero', () => {
    const status = claimingPass(replacing(V6_OBSERVATIONS.secretsResponseObjectCount, null));
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent('not a count of zero');
  });

  it('never reads a stringified zero as the number zero', () => {
    const status = claimingPass(replacing(V6_OBSERVATIONS.secretsResponseObjectCount, '0'));

    expect(resolveAuditFidelityEffectiveVerdict(status)).toBe('unknown');
  });

  it('fails on any non-zero reported response-body count', () => {
    const status = claimingPass(replacing(V6_OBSERVATIONS.secretsResponseObjectCount, 1));
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('carried a response body');
  });

  it('fails when the reported secrets level is not exactly the required one', () => {
    const status = claimingPass(replacing(V6_OBSERVATIONS.secretsAuditLevel, 'RequestResponse'));

    expect(resolveAuditFidelityEffectiveVerdict(status)).toBe('fail');
  });

  it('withholds rather than fails when the reported level cannot be named at all', () => {
    const status = claimingPass(replacing(V6_OBSERVATIONS.secretsAuditLevel, 'Verbose'));
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(measurementResult(container, V6_OBSERVATIONS.secretsAuditLevel)).toBe('indeterminate');
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('fails when the reported level ordering is not the canonical order', () => {
    const status = claimingPass(
      replacing(V6_OBSERVATIONS.levelOrdering, 'None < Request < Metadata < RequestResponse'),
    );
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('silently downgraded');
  });

  it('withholds the pass when the check reported that it scanned no events', () => {
    const status = claimingPass([
      ...ALL_REQUIRED_PROVEN,
      { label: V6_OBSERVATIONS.auditEventsObserved, value: 0 },
    ]);
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent('nothing to inspect');
  });

  it('grants the pass when the check reported that it scanned events', () => {
    const status = claimingPass([
      ...ALL_REQUIRED_PROVEN,
      { label: V6_OBSERVATIONS.auditEventsObserved, value: 12 },
    ]);

    expect(resolveAuditFidelityEffectiveVerdict(status)).toBe('pass');
  });

  it('fails when the per-resource secrets row projects above the required level', () => {
    const status = claimingPass([
      ...ALL_REQUIRED_PROVEN,
      { label: SECRETS_ROW_ID, value: 'RequestResponse' },
    ]);

    expect(resolveAuditFidelityEffectiveVerdict(status)).toBe('fail');
  });

  it('floors the verdict at FAIL when the payload reports a finding beside a pass', () => {
    const withFinding: ControlStatus = {
      ...claimingPass(ALL_REQUIRED_PROVEN),
      findings: [
        {
          message: 'The audit policy file could not be reloaded after the last edit.',
          subject: 'auditpolicy/secret-audit-request',
          requirementId: 'F-006-RQ-002',
        },
      ],
    };

    expect(resolveAuditFidelityEffectiveVerdict(withFinding)).toBe('fail');
  });

  it('does not let a duplicated measurement decide the verdict by list order', () => {
    const duplicated = claimingPass([
      ...ALL_REQUIRED_PROVEN,
      { label: V6_OBSERVATIONS.secretsResponseObjectCount, value: 4 },
    ]);
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(duplicated)} />);

    expect(measurementResult(container, V6_OBSERVATIONS.secretsResponseObjectCount)).toBe(
      'indeterminate',
    );
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('keeps a reported warning as a warning rather than rounding it into a pass', () => {
    const warned: ControlStatus = {
      ...claimingPass(ALL_REQUIRED_PROVEN),
      verdict: 'warn',
      warnings: ['The audit log rotated during the scan.'],
    };

    expect(resolveAuditFidelityEffectiveVerdict(warned)).toBe('warn');
  });

  it('reports no disagreement when the resolved verdict is the reported one', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(container.querySelector('[data-disagreement]')).toBeNull();
  });
});

describe('AuditFidelityPanel — the measured level table', () => {
  it('renders secrets at exactly Request everywhere it appears, never above', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    const secretsRows = Array.from(
      container.querySelectorAll('tr[data-expectation^="secrets-"]'),
    );
    expect(secretsRows.length).toBeGreaterThan(0);
    for (const row of secretsRows) {
      expect(row.getAttribute('data-audit-level')).toBe(SECRETS_AUDIT_LEVEL);
    }
  });

  it('renders every level with its ordinal, so a downgrade cannot look equivalent', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(container).toHaveTextContent('Request (3 of 4)');
    expect(container).toHaveTextContent('Metadata (2 of 4)');
    expect(container).toHaveTextContent('RequestResponse (4 of 4)');
  });

  it('states the strict total order in the legend', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(container).toHaveTextContent('None < Metadata < Request < RequestResponse');
  });

  it('filters the level table without reordering or rewriting a row', async () => {
    const { container, user } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    await user.selectOptions(
      screen.getByLabelText('Filter by audit level'),
      'RequestResponse',
    );

    const rows = Array.from(container.querySelectorAll('tr[data-expectation]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute('data-audit-level')).toBe('RequestResponse');
    }
  });

  it('renders the empty affordance when no measured row survives the filter', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} expectations={[]} />,
    );

    expect(container).toHaveTextContent('No measured audit levels were supplied');
  });
});

describe('AuditFidelityPanel — loading, empty, error and interaction', () => {
  it('renders the loading affordance and no verdict while the request is in flight', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={{ status: 'loading', refresh: vi.fn() }} />,
    );

    expect(renderedVerdict(container)).toBeNull();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('renders UNKNOWN and never a pass when the payload omits this control', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent('reported nothing about this control');
  });

  it.each([
    ['forbidden', CONTROL_STATUS_ERRORS.forbidden],
    ['serverError', CONTROL_STATUS_ERRORS.serverError],
    ['network', CONTROL_STATUS_ERRORS.network],
  ])('renders an alert and never a verdict for a %s failure', (_name, error) => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={{ status: 'error', error, refresh: vi.fn() }} />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(renderedVerdict(container)).toBeNull();
    expect(container).toHaveTextContent('this is not a pass');
  });

  it('omits the observed-event section entirely when no events were supplied', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(container).not.toHaveTextContent('No audit event was observed');
    expect(container.querySelector('.audit-fidelity-panel__events-table')).toBeNull();
  });

  it('distinguishes "not asked for" from "asked for and none found"', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} events={[]} />,
    );

    expect(container).toHaveTextContent('No audit event was observed');
  });

  it('re-issues the request when the refresh control is used', async () => {
    const refresh = vi.fn();
    const { user } = renderWithProviders(
      <AuditFidelityPanel
        result={{ status: 'success', controls: [V6_AUDIT_PASSING], isEmpty: false, refresh }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('AuditFidelityPanel — accessibility and citation discipline', () => {
  it('is a region named by its heading', () => {
    renderWithProviders(<AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />);

    expect(screen.getAllByRole('region').length).toBeGreaterThan(0);
  });

  it('names the repository requirements rather than any external benchmark', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(container).toHaveTextContent('F-006-RQ-002');
    expect(container).toHaveTextContent('F-006-RQ-003');
    expect(container.textContent ?? '').not.toMatch(/CIS|NSA|OWASP/);
  });

  it('cites the oracle line each measured row came from', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    expect(container).toHaveTextContent('cluster/gce/gci/audit_policy_test.go L143');
    expect(container).toHaveTextContent(
      'test/integration/controlplane/audit/audit_test.go L812-851',
    );
  });
});
