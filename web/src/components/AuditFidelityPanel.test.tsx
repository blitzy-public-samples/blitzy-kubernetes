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
import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import type { AuditEvent } from '../hooks/useAuditEvents';
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

/**
 * EVERY required measurement, all satisfied — the baseline every withholding case varies.
 *
 * TAKEN FROM THE RECORDED PASSING PAYLOAD rather than written out, and that is deliberate.
 * This list used to be three hand-written observations, which was the minimal set the panel
 * then required. When the required set grew to ten (M6), a hand-written baseline would have
 * stopped producing a pass — and every `withholds the pass when X is unreported` case below
 * it would have held VACUOUSLY, over a baseline that was already `unknown`. Deriving it from
 * the fixture means the baseline and the panel's requirements cannot drift apart silently:
 * if the fixture stops satisfying the panel, the two-sided control immediately below fails.
 */
const ALL_REQUIRED_PROVEN: readonly ControlObservation[] =
  V6_AUDIT_PASSING.evidence.observations;

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
 * {@link ALL_REQUIRED_PROVEN} with SEVERAL measurements' values replaced at once.
 *
 * Needed because two of the coherence rules below are relations between two observations —
 * a completeness verdict of `false` means one thing beside a positive observed count and
 * another beside a count of zero — and asserting on a relation requires setting both of
 * its sides in one payload. Chaining {@link replacing} cannot do it: each call rebuilds
 * from the baseline and discards the previous substitution.
 */
function replacingAll(
  substitutions: ReadonlyMap<string, ControlObservation['value']>,
): readonly ControlObservation[] {
  for (const label of substitutions.keys()) {
    if (!ALL_REQUIRED_PROVEN.some((observation) => observation.label === label)) {
      throw new Error(`"${label}" is not a required measurement, so replacing it is a no-op.`);
    }
  }
  return ALL_REQUIRED_PROVEN.map((observation) =>
    substitutions.has(observation.label)
      ? { label: observation.label, value: substitutions.get(observation.label) ?? null }
      : observation,
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
    // The requestURI must be overridden ALONGSIDE objectRef. The helper's default names a
    // secret, and leaving it in place while objectRef names a role is exactly the identity
    // contradiction C1 now refuses to resolve — the event would be treated as sensitive and
    // the body reported, which is correct fail-closed behaviour but not what this case is
    // about. A coherent non-secrets event needs both halves to agree.
    const roleEvent = event({
      level: 'RequestResponse',
      requestURI: '/apis/rbac.authorization.k8s.io/v1/namespaces/rbac-audit-response/roles',
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
  it('grants the pass when every required measurement is proven', () => {
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
    // REPLACING rather than appending: the baseline already carries an observed count.
    const status = claimingPass(replacing(V6_OBSERVATIONS.auditEventsObserved, 0));
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent('nothing to inspect');
  });

  it.each([
    { label: 'a fraction that clears the expected count', observed: 9.5 },
    { label: 'a fraction below one', observed: 0.5 },
    { label: 'a negative count', observed: -1 },
    { label: 'a large fraction', observed: 40.25 },
  ])('refuses the pass when the observed event count is $label', ({ observed }) => {
    // INVARIANT LOCKED (finding Q): a completeness verdict is never computed from a
    // value that cannot be a count.
    //
    // The reader was `readNumber`, which admits ANY finite number, so an observed
    // count of 9.5 against an expected 9 satisfied both the positivity check
    // (`> 0`) and the completeness comparison (`9.5 >= 9`) and produced a PASS. The
    // pass was built out of a value no counter can emit. `readCount` now refuses a
    // non-integer or negative value as `wrong-type`, which surfaces as
    // INDETERMINATE -- the honest verdict, because a broken measuring apparatus
    // leaves the control unproven rather than refuted.
    const status = claimingPass(replacing(V6_OBSERVATIONS.auditEventsObserved, observed));

    expect(
      resolveAuditFidelityEffectiveVerdict(status),
      'a malformed observed count must never yield a pass',
    ).not.toBe('pass');

    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);
    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, V6_OBSERVATIONS.auditEventsObserved)).toBe(
      'indeterminate',
    );
  });

  it('still grants the pass for a whole-number count, so the guard is not blanket', () => {
    // CONTROL: rejecting malformed counts must not reject well-formed ones. Without
    // this, a reader that refused every count would satisfy the cases above.
    expect(
      resolveAuditFidelityEffectiveVerdict(
        claimingPass(replacing(V6_OBSERVATIONS.auditEventsObserved, 9)),
      ),
    ).toBe('pass');
  });

  it('grants the pass when the check reported that it scanned events', () => {
    // REPLACING rather than appending: the baseline already carries an observed count, and
    // a second copy of an identity is a conflict rather than a stronger measurement.
    const status = claimingPass(replacing(V6_OBSERVATIONS.auditEventsObserved, 12));

    expect(resolveAuditFidelityEffectiveVerdict(status)).toBe('pass');
  });

  it('fails when the per-resource secrets row projects above the required level', () => {
    const status = claimingPass(replacing(SECRETS_ROW_ID, 'RequestResponse'));

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

describe('AuditFidelityPanel — C1: an unestablished resource identity fails closed', () => {
  /**
   * An object reference that references something without naming its kind.
   *
   * Cast, and deliberately so: `AuditObjectReference.resource` is required, so a validated
   * payload cannot hold this shape. An UNVALIDATED one can, which is the whole of C1 — the
   * panel used to read `objectRef?.resource` and compare it, and a comparison has two
   * outcomes where "this is not a Secret" and "I cannot tell what this is" need three.
   */
  const EMPTY_REFERENCE = {} as unknown as AuditEvent['objectRef'];

  /**
   * Every shape whose resource identity CANNOT be established, and which the superseded
   * `event.objectRef?.resource !== SECRETS_RESOURCE` test therefore waved through.
   *
   * Each is a real audit-report defect rather than a contrived value: a reference that
   * names an object without naming its kind, an empty kind, a non-string kind, and an
   * `objectRef` that is not an object at all. None of them is a Secret event as far as an
   * equality test can see, so each one used to skip every confidentiality check.
   */
  const UNREADABLE_REFERENCES: readonly (readonly [string, Partial<AuditEvent>])[] = [
    [
      'a reference naming no resource at all',
      // The cast IS the point. `AuditObjectReference.resource` is required, so within the
      // type system this shape cannot exist — and it cannot, once the hook's parser has
      // validated the payload. It arrives from the wire, which is exactly why the panel
      // must not assume the field is there and why C1 was reachable in the first place.
      { objectRef: { name: 'audit-secret' } as unknown as AuditEvent['objectRef'] },
    ],
    ['a reference whose resource is empty', { objectRef: { resource: '', name: 's' } }],
    [
      'a reference whose resource is not a string',
      { objectRef: { resource: 7 } as unknown as AuditEvent['objectRef'] },
    ],
    [
      'a reference that is not an object',
      { objectRef: 'secrets' as unknown as AuditEvent['objectRef'] },
    ],
  ];

  it('grants the pass for a COHERENT Secret event at the required level — the control', () => {
    // Two-sided first, so none of the failures below can be the sanitizer, the fixture or
    // the gate refusing everything. A well-formed Secret event at Request with no response
    // body is exactly what the control requires, and it must pass.
    const status = claimingPass(ALL_REQUIRED_PROVEN);

    expect(resolveAuditFidelityEffectiveVerdict(status, [event()])).toBe('pass');
  });

  it.each(UNREADABLE_REFERENCES)('fails on %s, with no response body needed', (_name, shape) => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const unreadable = event(shape);

    // FAIL rather than pass, and note what is NOT required to get there: no response body,
    // no level deviation. An audit report that cannot say what it audited is itself the
    // defect, because every confidentiality conclusion below it is unfounded.
    expect(resolveAuditFidelityEffectiveVerdict(status, [unreadable])).toBe('fail');
  });

  it('names the uncertainty as its own finding rather than only its consequences', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(status)}
        events={[event({ objectRef: EMPTY_REFERENCE })]}
      />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('resource identity could not be established');
    // And the reason the shared model gave, so a reader can act on it.
    expect(container).toHaveTextContent(/objectRef/iu);
  });

  it('reports the uncertainty ALONGSIDE the body it fell back to reporting', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(status)}
        events={[event({ objectRef: EMPTY_REFERENCE, responseObject: { kind: 'Secret' } })]}
      />,
    );

    // Findings ACCUMULATE: the identity gap and the response body are two facts, and a
    // reader who sees only the second cannot tell it was found on a fail-closed assumption.
    expect(container).toHaveTextContent('resource identity could not be established');
    expect(container).toHaveTextContent('response object');
  });

  it('fails when the request path and the object reference disagree', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const contradictory = event({
      requestURI: '/api/v1/namespaces/secret-audit-request/secrets',
      objectRef: { resource: 'configmaps', namespace: 'secret-audit-request', name: 'cm' },
    });

    // Neither statement can be believed once they disagree, so the event is treated as a
    // Secret. Reading `objectRef.resource` alone would have called this a ConfigMap event
    // and skipped every check — while the path says a Secret was read.
    expect(resolveAuditFidelityEffectiveVerdict(status, [contradictory])).toBe('fail');
  });

  it('reaches a Secret event whose identity is knowable only from the request path', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const pathOnly = event({
      objectRef: undefined,
      responseObject: { kind: 'Secret' },
    });
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(status)} events={[pathOnly]} />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('response object');
    // Resolved, not uncertain: the path names the resource unambiguously, so this is a
    // confirmed Secret event and must NOT be reported as an identity gap.
    expect(container.textContent ?? '').not.toContain('resource identity could not be established');
  });

  it('says the target could not be established rather than guessing at either half', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={success(status)}
        events={[
          event({
            requestURI: '/api/v1/namespaces/secret-audit-request/secrets',
            objectRef: { resource: 'configmaps', namespace: 'secret-audit-request' },
          }),
        ]}
      />,
    );

    expect(container).toHaveTextContent('target could not be established');
    // Rendering `configmaps` here would make the row look like a mis-filed ConfigMap event
    // rather than an event whose identity is in dispute.
    expect(container.textContent ?? '').not.toContain('configmaps (core, namespace');
  });

  it('leaves a non-resource request alone, body and all', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const healthz = event({
      requestURI: '/healthz',
      objectRef: undefined,
      responseObject: { status: 'ok' },
    });
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(status)} events={[healthz]} />,
    );

    // `/healthz` references no resource, which is a KNOWN identity rather than an unknown
    // one. Failing closed on it would make every liveness probe a confidentiality finding.
    expect(renderedVerdict(container)).toBe('pass');
    expect(container).toHaveTextContent('non-resource request /healthz');
  });
});

describe('AuditFidelityPanel — M6: every required per-resource level row must be proven', () => {
  /**
   * The four per-resource rows a V6 pass now rests on, with the level each must project at.
   *
   * These are the rows this control MEASURES, transcribed from the same oracle the panel
   * cites. `tokenreviews` and `clusterroles` are deliberately absent: AAP §0.10.2 pins them
   * too, but the integration check does not report them, so requiring them here would make
   * the pass unreachable for a payload that is doing everything asked of it.
   */
  const REQUIRED_LEVEL_ROWS: readonly (readonly [string, string, string])[] = [
    [
      'secrets at Request',
      v6ResourceLevelObservation('', ['secrets'], 'secret-audit-request'),
      'Metadata',
    ],
    [
      'serviceaccounts/token at Request',
      v6ResourceLevelObservation('', ['serviceaccounts/token'], 'create-audit-request'),
      'RequestResponse',
    ],
    [
      'configmaps at Metadata',
      v6ResourceLevelObservation('', ['configmaps'], 'webhook-audit-metadata'),
      'Request',
    ],
    [
      'roles and rolebindings at RequestResponse',
      v6ResourceLevelObservation(
        'rbac.authorization.k8s.io',
        ['roles', 'rolebindings'],
        'rbac-audit-response',
      ),
      'Metadata',
    ],
  ];

  it.each(REQUIRED_LEVEL_ROWS)(
    'withholds the pass when the row for %s is not reported',
    (_name, identity) => {
      const { container } = renderWithProviders(
        <AuditFidelityPanel result={success(claimingPass(without(identity)))} />,
      );

      // UNKNOWN rather than PASS. Before the fix these rows were folded in only when the
      // payload happened to report them, so a payload reporting three of the ten required
      // measurements got the same verdict as one reporting all ten.
      expect(renderedVerdict(container)).toBe('unknown');
      expect(measurementResult(container, identity)).toBe('indeterminate');
    },
  );

  it.each(REQUIRED_LEVEL_ROWS)(
    'fails when the row for %s projects at the wrong level',
    (_name, identity, wrongLevel) => {
      const { container } = renderWithProviders(
        <AuditFidelityPanel result={success(claimingPass(replacing(identity, wrongLevel)))} />,
      );

      expect(renderedVerdict(container)).toBe('fail');
      expect(measurementResult(container, identity)).toBe('violated');
    },
  );

  it.each([
    {
      name: 'configmaps required at Metadata, observed at Request',
      identity: v6ResourceLevelObservation('', ['configmaps'], 'webhook-audit-metadata'),
      observed: 'Request',
      required: 'Metadata',
      says: 'records the request body',
      mustNotSay: 'the payload reached the audit log',
    },
    {
      name: 'roles/rolebindings required at RequestResponse, observed at Metadata',
      identity: v6ResourceLevelObservation(
        'rbac.authorization.k8s.io',
        ['roles', 'rolebindings'],
        'rbac-audit-response',
      ),
      observed: 'Metadata',
      required: 'RequestResponse',
      says: 'held UP at the most verbose level for forensics',
      mustNotSay: 'above the required',
    },
    {
      name: 'secrets required at Request, observed at RequestResponse',
      identity: v6ResourceLevelObservation('', ['secrets'], 'secret-audit-request'),
      observed: 'RequestResponse',
      required: 'Request',
      says: 'records the response body',
      mustNotSay: 'below the required',
    },
  ])(
    'names the ACTUAL required level in the guidance for $name',
    ({ identity, observed, required, says, mustNotSay }) => {
      // INVARIANT LOCKED (finding R): remediation guidance names the level THIS row
      // requires, and says what the observed level actually records.
      //
      // The deviation helper compared every row against the hard-coded Secrets
      // requirement of `Request`. The verdict was still correct -- a wrong level is a
      // violation either way -- but the guidance was not: a roles/rolebindings row
      // required at RequestResponse and observed at Metadata was described as being
      // "below the required Request", and a configmaps row required at Metadata and
      // observed at Request was described as "above the required Request", which is
      // not even a deviation. An operator following either sentence would act on the
      // wrong level.
      const { container } = renderWithProviders(
        <AuditFidelityPanel result={success(claimingPass(replacing(identity, observed)))} />,
      );

      expect(measurementResult(container, identity)).toBe('violated');
      // The REQUIRED level must appear, and it is the row's own, not Secrets'.
      expect(container).toHaveTextContent(`the required ${required}`);
      // What the observed level records, or why the row is held where it is.
      expect(container).toHaveTextContent(says);
      // And the sentence that would have been produced by comparing against the
      // Secrets requirement must NOT appear.
      expect(container).not.toHaveTextContent(`${mustNotSay} Request (3 of 4)`);
    },
  );

  it('appends the row rationale so the guidance says why the level matters', () => {
    // The `because` text lives beside each required level in one place; before the fix
    // it reached the row TITLE but never the deviation detail, so a failing row said
    // what happened and not why it mattered.
    const identity = v6ResourceLevelObservation('', ['serviceaccounts/token'], 'create-audit-request');
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(replacing(identity, 'RequestResponse')))} />,
    );

    expect(measurementResult(container, identity)).toBe('violated');
    expect(container).toHaveTextContent('Required because');
    expect(container).toHaveTextContent('an issued token appears only in the response');
  });

  it('renders all ten required measurements whether or not the payload reports them', () => {
    // UNCONDITIONAL is the substance of the fix: a measurement that appears only when its
    // observation does cannot report the observation's ABSENCE, which is the one thing a
    // reader most needs from it.
    const proven = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(ALL_REQUIRED_PROVEN))} />,
    );
    const reportingNothing = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass([]))} />,
    );

    const provenRows = proven.container.querySelectorAll('[data-measurement]').length;
    const emptyRows = reportingNothing.container.querySelectorAll('[data-measurement]').length;

    expect(provenRows).toBe(10);
    expect(emptyRows).toBe(10);
  });

  it('withholds the pass when the completeness verdict is not reported', () => {
    const identity = V6_OBSERVATIONS.expectedEventsObserved;
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(without(identity)))} />,
    );

    // Without it the level table is a policy document: it says what the rules are and not
    // that any of them fired.
    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, identity)).toBe('indeterminate');
  });

  it('fails when an expected event was missed while others arrived', () => {
    const identity = V6_OBSERVATIONS.expectedEventsObserved;
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(replacing(identity, false)))} />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, identity)).toBe('violated');
  });

  it('withholds rather than fails when nothing arrived at all', () => {
    const substitutions = new Map<string, ControlObservation['value']>([
      [V6_OBSERVATIONS.expectedEventsObserved, false],
      [V6_OBSERVATIONS.auditEventsObserved, 0],
    ]);
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(replacingAll(substitutions)))} />,
    );

    // THE EMPTY-LOG EXEMPTION, and the difference matters: an expected event that never
    // arrived while others did is a rule that failed to fire, but an empty log is a check
    // that did not run. Reporting the second as a violation would say the control is broken
    // on the evidence that nothing was looked at.
    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, V6_OBSERVATIONS.expectedEventsObserved)).toBe(
      'indeterminate',
    );
    expect(measurementResult(container, V6_OBSERVATIONS.expectedEventCount)).toBe('indeterminate');
  });

  it('withholds the pass when the expected-event count is not reported', () => {
    const identity = V6_OBSERVATIONS.expectedEventCount;
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(without(identity)))} />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, identity)).toBe('indeterminate');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
  ])('fails on an expected-event count reported as %s', (_name, count) => {
    const identity = V6_OBSERVATIONS.expectedEventCount;
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(replacing(identity, count)))} />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, identity)).toBe('violated');
  });

  it('fails when fewer events were observed than expected while events did arrive', () => {
    const substitutions = new Map<string, ControlObservation['value']>([
      [V6_OBSERVATIONS.expectedEventCount, 9],
      [V6_OBSERVATIONS.auditEventsObserved, 4],
    ]);
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(claimingPass(replacingAll(substitutions)))} />,
    );

    // The observed stream is a SUPERSET of the expected set, so four observed against nine
    // expected cannot both be true and the report contradicts itself.
    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, V6_OBSERVATIONS.expectedEventCount)).toBe('violated');
  });

  it('accepts more observed than expected — the expected set is a lower bound', () => {
    const substitutions = new Map<string, ControlObservation['value']>([
      [V6_OBSERVATIONS.expectedEventCount, 9],
      [V6_OBSERVATIONS.auditEventsObserved, 40],
    ]);

    expect(
      resolveAuditFidelityEffectiveVerdict(claimingPass(replacingAll(substitutions))),
    ).toBe('pass');
  });
});

describe('AuditFidelityPanel — M6: the table separates the requirement from the measurement', () => {
  it('says in its caption that it carries both', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );
    const caption = container.querySelector('.audit-fidelity-panel__levels-table caption');

    // One column headed "Audit level" presented a transcribed expectation as though it were
    // a measured value, which is the presentation half of M6.
    expect(caption?.textContent ?? '').toContain('Required');
    expect(caption?.textContent ?? '').toContain('observed');
  });

  it('renders both a required and an observed level column', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );
    const headers = Array.from(
      container.querySelectorAll('.audit-fidelity-panel__levels-table thead th'),
    ).map((cell) => cell.textContent ?? '');

    expect(headers).toContain('Required level');
    expect(headers).toContain('Observed level');
  });

  it('marks the measured secrets row as agreeing, and shows the value it agreed with', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );
    const row = container.querySelector('[data-expectation="secrets-observed-write"]');

    expect(row?.getAttribute('data-observed')).toBe('match');
    expect(row?.textContent ?? '').toContain(SECRETS_AUDIT_LEVEL);
  });

  it('says a row is not measured here rather than leaving it to read as measured', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );
    const notMeasured = container.querySelectorAll('[data-observed="not-measured"]');

    // Most rows of the table are transcribed from the unit-tier oracle and this check does
    // not measure them. Saying so is what stops the whole table reading as evidence.
    expect(notMeasured.length).toBeGreaterThan(0);
    expect(notMeasured[0]?.textContent ?? '').toContain('Not measured by this check');
  });

  it('distinguishes reportable-and-absent from not-measured', () => {
    const status = claimingPass(without(SECRETS_ROW_ID));
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);
    const row = container.querySelector('[data-expectation="secrets-observed-write"]');

    expect(row?.getAttribute('data-observed')).toBe('unreported');
    expect(row?.textContent ?? '').toContain('Reportable, but not reported');
  });

  it('names a divergent observed level as differing, and keeps the requirement beside it', () => {
    const status = claimingPass(replacing(SECRETS_ROW_ID, 'RequestResponse'));
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);
    const row = container.querySelector('[data-expectation="secrets-observed-write"]');

    expect(row?.getAttribute('data-observed')).toBe('mismatch');
    expect(row?.textContent ?? '').toContain('differs: RequestResponse');
    // The requirement column is UNCHANGED: the row must not rewrite itself to agree with
    // what was measured, which is precisely how a downgrade would hide.
    expect(row?.getAttribute('data-audit-level')).toBe(SECRETS_AUDIT_LEVEL);
    expect(renderedVerdict(container)).toBe('fail');
  });

  it('shows one shared observation against both RBAC rows', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />,
    );

    // The policy rule names `roles` and `rolebindings` together, so the check reports the
    // RULE rather than the resource and both rows read from the same observation.
    for (const id of ['roles-write', 'rolebindings-write']) {
      const row = container.querySelector(`[data-expectation="${id}"]`);
      expect.soft(row?.getAttribute('data-observed')).toBe('match');
      expect.soft(row?.textContent ?? '').toContain('RequestResponse');
    }
  });
});

describe('AuditFidelityPanel — M18: external prose is bounded and stripped of credentials', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  /** A PEM block, which the shared guard treats as credential-shaped whole. */
  const PEM_SHAPED = '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----';

  it('renders the recorded summary, detail, findings and warnings unchanged', () => {
    // THE CONTROL for every case below: without it a guard that blanked everything would
    // satisfy all of them, and the panel would report nothing at all rather than safely.
    const passing = renderWithProviders(<AuditFidelityPanel result={success(V6_AUDIT_PASSING)} />);
    expect(passing.container).toHaveTextContent(V6_AUDIT_PASSING.summary);
    if (V6_AUDIT_PASSING.detail !== undefined) {
      expect(passing.container).toHaveTextContent(V6_AUDIT_PASSING.detail);
    }

    const failing = renderWithProviders(<AuditFidelityPanel result={success(V6_AUDIT_FAILING)} />);
    for (const finding of V6_AUDIT_FAILING.findings) {
      expect.soft(failing.container).toHaveTextContent(finding.message);
    }
    for (const warning of V6_AUDIT_FAILING.warnings) {
      expect.soft(failing.container).toHaveTextContent(warning);
    }
  });

  it.each([
    ['the summary', (text: string): ControlStatus => ({ ...V6_AUDIT_PASSING, summary: text })],
    ['the detail', (text: string): ControlStatus => ({ ...V6_AUDIT_PASSING, detail: text })],
    ['a warning', (text: string): ControlStatus => ({ ...V6_AUDIT_PASSING, warnings: [text] })],
    [
      'a finding message',
      (text: string): ControlStatus => ({
        ...V6_AUDIT_PASSING,
        findings: [{ message: text, requirementId: 'F-006-RQ-002' }],
      }),
    ],
    [
      'a finding subject',
      (text: string): ControlStatus => ({
        ...V6_AUDIT_PASSING,
        findings: [{ message: 'the recorded level diverged.', subject: text }],
      }),
    ],
    [
      'a finding requirement identifier',
      (text: string): ControlStatus => ({
        ...V6_AUDIT_PASSING,
        findings: [{ message: 'the recorded level diverged.', requirementId: text }],
      }),
    ],
    [
      'the evaluation timestamp',
      (text: string): ControlStatus => ({ ...V6_AUDIT_PASSING, observedAt: text }),
    ],
    [
      'a reported requirement identifier',
      (text: string): ControlStatus => ({ ...V6_AUDIT_PASSING, requirementIds: [text] }),
    ],
  ])('withholds a token-shaped credential in %s', (_name, build) => {
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(build(TOKEN_SHAPED))} />);

    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('withholds a credential in the failure message and its reason', () => {
    const { container } = renderWithProviders(
      <AuditFidelityPanel
        result={{
          status: 'error',
          error: {
            ...CONTROL_STATUS_ERRORS.serverError,
            message: `the audit sink reported ${TOKEN_SHAPED}`,
            reason: `upstream said ${PEM_SHAPED}`,
          },
          refresh: vi.fn(),
        }}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).not.toContain(TOKEN_SHAPED);
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(container).toHaveTextContent(SAFE_REDACTED);
    // The locally authored sentence is unconditional, so the reader is never left with a
    // redaction marker and no statement of what it means.
    expect(container).toHaveTextContent('this is not a pass');
  });

  it('withholds a PEM block from an observed event, and keeps the words around it', () => {
    const status: ControlStatus = {
      ...V6_AUDIT_PASSING,
      detail: `the sink wrote ${PEM_SHAPED} into the log rather than the placeholder.`,
    };
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(container.textContent ?? '').not.toContain('BEGIN PRIVATE KEY');
    expect(container).toHaveTextContent(SAFE_REDACTED);
    expect(container).toHaveTextContent('rather than the placeholder');
  });

  it('bounds an oversized summary rather than rendering any of it', () => {
    const status: ControlStatus = {
      ...V6_AUDIT_PASSING,
      summary: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    };
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(container.textContent ?? '').not.toContain('xxxxxxxxxx');
  });

  it('collapses control characters and bidirectional overrides out of prose', () => {
    const status: ControlStatus = {
      ...V6_AUDIT_PASSING,
      summary: 'Secrets sit at Request.\n\u0007\u202ENothing was downgraded.',
    };
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(container).toHaveTextContent('Secrets sit at Request. Nothing was downgraded.');
  });

  it('substitutes a local sentence for text that sanitized away to nothing', () => {
    const status: ControlStatus = {
      ...V6_AUDIT_PASSING,
      summary: '\u0000\u0007',
      findings: [{ message: '\u202E\u200B' }],
    };
    const { container } = renderWithProviders(<AuditFidelityPanel result={success(status)} />);

    // An empty string is not an acceptable rendering of a verdict or a finding: the reader
    // would see a heading over nothing and could not tell a blank report from a clean one.
    expect(container).toHaveTextContent('summary could not be displayed');
    expect(container).toHaveTextContent('finding whose message could not be displayed');
  });

  it('bounds every server-supplied part of an observed-event row', () => {
    const status = claimingPass(ALL_REQUIRED_PROVEN);
    const noisy = event({
      verb: TOKEN_SHAPED,
      objectRef: { resource: 'secrets', namespace: TOKEN_SHAPED, name: 'audit-secret' },
      requestURI: `/api/v1/namespaces/${TOKEN_SHAPED}/secrets`,
    });
    const { container } = renderWithProviders(
      <AuditFidelityPanel result={success(status)} events={[noisy]} />,
    );

    // Rendered, and only then absent: without this the negative assertion below would hold
    // vacuously over a row the panel never drew.
    expect(container.querySelector('.audit-fidelity-panel__events-table')).not.toBeNull();
    expect(container).toHaveTextContent(SAFE_REDACTED);
    // A target row is assembled ENTIRELY from server strings — resource, subresource, group
    // and namespace — and the verb beside it likewise.
    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
  });
});
