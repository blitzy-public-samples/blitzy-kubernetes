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

// AAP §0.5.1 (the `web/src/components/PodSecurityPanel.test.tsx` row — "V2 behaviour: Pass
// and fail plus warning surfacing") / §0.4.2.4 (the five case categories every panel spec
// covers) / §0.7.2 (assertion density: V2 keeps its THREE cases — privileged rejected,
// hostPID rejected, warn admits with warning) / §0.10.2 (the Pod Security precondition: the
// namespace's `default` ServiceAccount must exist before pod creation, or a ServiceAccount
// error masks the PodSecurity rejection) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   The V2 panel renders a PASS only when all three measured paths of
//   `TestPodSecurityEnforceBaselineRejectsPrivileged` are proven, and any reported finding
//   floors the verdict at FAIL.
//
// THE DEFECT THESE CASES EXIST TO PREVENT, which the compiler and the linter both accepted:
// `resolveVerdict` escalated exactly one situation — a `warn` verdict with an empty warning
// channel — and returned `status.verdict` untouched for everything else. So a payload
// claiming `pass` rendered "Enforcement verified" and the sentence "the enforced level
// rejected every violating pod and the warned level objected as expected" while carrying
//
//   * no rejection evidence at all,
//   * a rejection with the wrong status code,
//   * an admitted privileged pod,
//   * no warn-namespace evidence, or
//   * a list of findings saying the control was broken.
//
// Each of those is a separate case below, because each was separately reachable.
//
// The oracle those cases are measured from — `test/integration/auth/podsecurity_test.go`
// L363-L457 — makes FOUR accumulating assertions (`t.Errorf` at L408, L420, L448 and L454)
// under TWO aborting setup requirements (`t.Fatalf` at L378 and L384), and its single
// verdict covers all of them. That is why a V2 pass needs all three paths and not two.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V2_OBSERVATIONS, v2NamespaceLabelObservation } from '../domain/observationIds';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  FORBIDDEN_STATUS,
  FORBIDDEN_CONTROL_STATUS_ERROR,
  NOT_FOUND_STATUS,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V2_NAMESPACES,
  V2_POD_SECURITY_FAILING,
  V2_POD_SECURITY_PASSING,
  V2_POD_SECURITY_UNKNOWN,
  V2_POD_SECURITY_WARNING,
  V2_RESTRICTED_WARNINGS,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import PodSecurityPanel, { resolvePodSecurityEffectiveVerdict } from './PodSecurityPanel';

/** The verdict heading, which is where the panel states its outcome. */
const HEADINGS = {
  pass: 'Enforcement verified',
  fail: 'Enforcement violated',
  warn: 'Admitted with warnings',
  unknown: 'Posture unknown',
} as const;

/** The identity of the enforce-namespace label observation. */
const ENFORCE_LABEL_ID = v2NamespaceLabelObservation(
  V2_NAMESPACES.enforceBaseline.name,
  V2_NAMESPACES.enforceBaseline.labelKey,
);

/** The identity of the warn-namespace label observation. */
const WARN_LABEL_ID = v2NamespaceLabelObservation(
  V2_NAMESPACES.warnRestricted.name,
  V2_NAMESPACES.warnRestricted.labelKey,
);

/** The eight measurements a pass rests on, all of them proven. */
const ALL_PROVEN: readonly ControlObservation[] = [
  { label: ENFORCE_LABEL_ID, value: V2_NAMESPACES.enforceBaseline.labelValue },
  { label: V2_OBSERVATIONS.defaultServiceAccountPrecondition, value: true },
  { label: V2_OBSERVATIONS.privilegedPodStatus, value: FORBIDDEN_STATUS },
  { label: V2_OBSERVATIONS.hostPidPodStatus, value: FORBIDDEN_STATUS },
  { label: WARN_LABEL_ID, value: V2_NAMESPACES.warnRestricted.labelValue },
  { label: V2_OBSERVATIONS.warnPodAdmitted, value: true },
  { label: V2_OBSERVATIONS.warnPodStatus, value: null },
  { label: V2_OBSERVATIONS.warningsRecorded, value: 1 },
];

/** A payload claiming `pass`, with the observation list under test. */
function claimingPass(observations: readonly ControlObservation[]): ControlStatus {
  return {
    ...V2_POD_SECURITY_PASSING,
    findings: [],
    warnings: V2_RESTRICTED_WARNINGS,
    evidence: { observations },
  };
}

/** {@link ALL_PROVEN} with one measurement removed by identity. */
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

/** Reads the row of the required-measurements table with that identity. */
function measurementResult(id: string): string {
  const row = document.querySelector(`tr[data-measurement="${id}"]`);
  expect(row).not.toBeNull();
  return row?.getAttribute('data-result') ?? '';
}

describe('the recorded payloads', () => {
  it('renders the recorded PASSING payload as a pass, all three paths proven', () => {
    renderWithProviders(<PodSecurityPanel status={V2_POD_SECURITY_PASSING} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.pass })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(V2_POD_SECURITY_PASSING)).toBe('pass');
    // Every measurement, not merely the verdict: a pass that happened to be
    // reached with an unproven row would still show it here.
    expect(measurementResult('enforce-namespace-label')).toBe('pass');
    expect(measurementResult('default-serviceaccount-precondition')).toBe('pass');
    expect(measurementResult('rejection-privileged-pod')).toBe('pass');
    expect(measurementResult('rejection-hostpid-pod')).toBe('pass');
    expect(measurementResult('warn-namespace-label')).toBe('pass');
    expect(measurementResult('warn-pod-admitted')).toBe('pass');
    expect(measurementResult('warn-pod-no-rejection-status')).toBe('pass');
    expect(measurementResult('warning-surfaced')).toBe('pass');
  });

  it('keeps the recorded WARNING payload a warning rather than escalating it', () => {
    renderWithProviders(<PodSecurityPanel status={V2_POD_SECURITY_WARNING} />);

    // The warn scenario is a narrower one that never claimed the enforce half, and
    // `warn` is not a pass, so nothing is over-claimed by leaving it alone. Its
    // unproven enforce rows are still reported as unproven.
    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.warn })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(V2_POD_SECURITY_WARNING)).toBe('warn');
    expect(measurementResult('rejection-privileged-pod')).toBe('unknown');
    expect(measurementResult('warn-pod-admitted')).toBe('pass');
    expect(measurementResult('warning-surfaced')).toBe('pass');
  });

  it('renders the recorded FAILING payload as a failure with both findings', () => {
    const { container } = renderWithProviders(
      <PodSecurityPanel status={V2_POD_SECURITY_FAILING} />,
    );

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(V2_POD_SECURITY_FAILING)).toBe('fail');
    expect(V2_POD_SECURITY_FAILING.findings).toHaveLength(2);
    for (const finding of V2_POD_SECURITY_FAILING.findings) {
      expect(container).toHaveTextContent(finding.message);
    }
    expect(measurementResult('rejection-privileged-pod')).toBe('fail');
    expect(measurementResult('rejection-hostpid-pod')).toBe('fail');
  });

  it('renders the recorded UNKNOWN payload as unknown, precondition unmet', () => {
    renderWithProviders(<PodSecurityPanel status={V2_POD_SECURITY_UNKNOWN} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(V2_POD_SECURITY_UNKNOWN)).toBe('unknown');
    // An unmet precondition is UNKNOWN and never FAIL: the create failed with a
    // non-Forbidden error before PodSecurity ran, so failing it would blame the wrong
    // component. The rejection it undermines reports no decision at all.
    expect(measurementResult('default-serviceaccount-precondition')).toBe('unknown');
    expect(measurementResult('rejection-privileged-pod')).toBe('unknown');
    expect(screen.getByRole('table', { name: /Required measurements/ })).toHaveTextContent(
      'proves nothing either way',
    );
  });

  it('never fails a payload solely because the precondition was reported false', () => {
    const status = claimingPass(
      replacing(V2_OBSERVATIONS.defaultServiceAccountPrecondition, false),
    );
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(status)).toBe('unknown');
  });
});

describe('a pass must be earned', () => {
  it.each([
    ['the enforce-namespace label', ENFORCE_LABEL_ID, 'enforce-namespace-label'],
    [
      'the ServiceAccount precondition',
      V2_OBSERVATIONS.defaultServiceAccountPrecondition,
      'default-serviceaccount-precondition',
    ],
    ['the privileged rejection', V2_OBSERVATIONS.privilegedPodStatus, 'rejection-privileged-pod'],
    ['the hostPID rejection', V2_OBSERVATIONS.hostPidPodStatus, 'rejection-hostpid-pod'],
    ['the warn-namespace label', WARN_LABEL_ID, 'warn-namespace-label'],
    ['the warn-pod admission', V2_OBSERVATIONS.warnPodAdmitted, 'warn-pod-admitted'],
    ['the warn-pod status', V2_OBSERVATIONS.warnPodStatus, 'warn-pod-no-rejection-status'],
    ['the warning count', V2_OBSERVATIONS.warningsRecorded, 'warning-surfaced'],
  ])('withholds the pass when %s is not reported', (_name, label, measurementId) => {
    const status = claimingPass(without(label));
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(measurementResult(measurementId)).toBe('unknown');
    expect(resolvePodSecurityEffectiveVerdict(status)).toBe('unknown');
    // Withheld, not failed: an unproven measurement is not evidence of a defect.
    expect(screen.queryByRole('heading', { name: HEADINGS.fail })).toBeNull();
  });

  it('says the pass was WITHHELD rather than that no evidence arrived', () => {
    renderWithProviders(
      <PodSecurityPanel status={claimingPass(without(V2_OBSERVATIONS.warningsRecorded))} />,
    );

    const announced = screen.getByRole('status').textContent ?? '';
    expect(announced).toContain('pass is withheld');
    expect(announced).toContain('required measurements');
    expect(announced).not.toContain('No trustworthy evidence');
  });

  it('withholds the pass when NO evidence is reported at all', () => {
    const status = claimingPass([]);
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(status)).toBe('unknown');
  });

  it('withholds the pass when the evidence bag is absent entirely', () => {
    const status: ControlStatus = {
      ...V2_POD_SECURITY_PASSING,
      findings: [],
      warnings: V2_RESTRICTED_WARNINGS,
      evidence: undefined,
    };
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
  });
});

describe('a contradicted measurement fails the control', () => {
  it('fails a privileged pod that was ADMITTED, even beside a recorded 403', () => {
    // Admission is interrogated FIRST, so an admitted pod is reported as the failure
    // it is rather than being overruled by a status code recorded alongside it.
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V2_OBSERVATIONS.privilegedPodAdmitted, value: true },
    ]);
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('rejection-privileged-pod')).toBe('fail');
    expect(resolvePodSecurityEffectiveVerdict(status)).toBe('fail');
  });

  it('fails a rejection carrying 404 rather than 403', () => {
    // `!apierrors.IsForbidden(err)` is the oracle's test (L407), so a 404 from a
    // missing namespace is a failure of this control and not a rejection.
    const status = claimingPass(
      replacing(V2_OBSERVATIONS.hostPidPodStatus, NOT_FOUND_STATUS),
    );
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('rejection-hostpid-pod')).toBe('fail');
  });

  it('does NOT accept "admitted: false" alone as proof of a 403', () => {
    const status = claimingPass([
      ...without(V2_OBSERVATIONS.privilegedPodStatus),
      { label: V2_OBSERVATIONS.privilegedPodAdmitted, value: false },
    ]);
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(measurementResult('rejection-privileged-pod')).toBe('unknown');
  });

  it('fails a namespace labelled at the wrong level', () => {
    const status = claimingPass(replacing(ENFORCE_LABEL_ID, 'privileged'));
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('enforce-namespace-label')).toBe('fail');
  });

  it('fails a warn namespace that REJECTED the pod instead of admitting it', () => {
    const status = claimingPass([
      ...replacing(V2_OBSERVATIONS.warnPodAdmitted, false),
    ]);
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('warn-pod-admitted')).toBe('fail');
  });

  it('fails an admitted warn pod that nevertheless carries a rejection status', () => {
    const status = claimingPass(replacing(V2_OBSERVATIONS.warnPodStatus, FORBIDDEN_STATUS));
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('warn-pod-no-rejection-status')).toBe('fail');
  });

  it('fails a recorded warning count of zero', () => {
    // The oracle's own message: "expected at least one Pod Security warning under
    // warn=restricted, got none" (L454).
    const status = claimingPass(replacing(V2_OBSERVATIONS.warningsRecorded, 0));
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('warning-surfaced')).toBe('fail');
  });

  it('fails a recorded warning count that the warning channel does not carry', () => {
    const status: ControlStatus = {
      ...V2_POD_SECURITY_PASSING,
      findings: [],
      warnings: [],
      evidence: { observations: ALL_PROVEN },
    };
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(measurementResult('warning-surfaced')).toBe('fail');
    // No findings and no empty warn channel, so the reader is sent to the one place
    // that does substantiate the failure rather than being told there is no detail.
    expect(screen.getByRole('status').textContent).toContain('required measurements');
  });
});

describe('malformed evidence is never coerced', () => {
  it.each([
    ['a numeric string status', '403' as const],
    ['a boolean status', true as const],
  ])('withholds the pass when the rejection status is %s', (_name, value) => {
    const status = claimingPass(replacing(V2_OBSERVATIONS.privilegedPodStatus, value));
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(measurementResult('rejection-privileged-pod')).toBe('unknown');
  });

  it('reads a null status as "no admission decision was reached"', () => {
    const status = claimingPass(replacing(V2_OBSERVATIONS.privilegedPodStatus, null));
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /Required measurements/ })).toHaveTextContent(
      'no admission decision was reached',
    );
  });

  it('withholds the pass when one identity is reported twice', () => {
    // Which of two conflicting values applies is unknowable, so neither is used.
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V2_OBSERVATIONS.privilegedPodStatus, value: FORBIDDEN_STATUS },
    ]);
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
    expect(measurementResult('rejection-privileged-pod')).toBe('unknown');
    expect(screen.getByRole('table', { name: /Required measurements/ })).toHaveTextContent(
      'reported more than once',
    );
  });

  it('withholds the pass when a duplicated pair disagrees', () => {
    const status = claimingPass([
      ...ALL_PROVEN,
      { label: V2_OBSERVATIONS.privilegedPodStatus, value: NOT_FOUND_STATUS },
    ]);
    renderWithProviders(<PodSecurityPanel status={status} />);

    // Not a failure either: the panel cannot tell which value the server meant, and
    // guessing the safe one would be as much of an invention as guessing the flattering
    // one.
    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.unknown })).toBeInTheDocument();
  });
});

describe('findings floor the verdict', () => {
  it('fails a payload claiming pass with every measurement proven but a finding reported', () => {
    // The isolating case: nothing else objects. Only the findings list forces the
    // failure, so removing the findings floor would leave this the sole detector.
    const status: ControlStatus = {
      ...V2_POD_SECURITY_PASSING,
      verdict: 'pass',
      findings: [
        {
          message: 'The exemption list gained an entry that no requirement sanctions.',
          subject: 'admission config exemptions.namespaces',
          requirementId: 'F-002-RQ-001',
        },
      ],
      warnings: V2_RESTRICTED_WARNINGS,
      evidence: { observations: ALL_PROVEN },
    };
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(resolvePodSecurityEffectiveVerdict(status)).toBe('fail');
    expect(screen.getByRole('status').textContent).toContain('See the reported findings.');
    for (const measurementId of [
      'enforce-namespace-label',
      'rejection-privileged-pod',
      'warning-surfaced',
    ]) {
      expect(measurementResult(measurementId)).toBe('pass');
    }
  });

  it('fails a WARN payload that also reports a finding', () => {
    const status: ControlStatus = {
      ...V2_POD_SECURITY_WARNING,
      findings: V2_POD_SECURITY_FAILING.findings,
    };
    expect(resolvePodSecurityEffectiveVerdict(status)).toBe('fail');
  });

  it('fails a warn verdict whose warning channel is empty', () => {
    const status: ControlStatus = { ...V2_POD_SECURITY_WARNING, warnings: [] };
    renderWithProviders(<PodSecurityPanel status={status} />);

    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.fail })).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Warning channel check failed' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toContain('warning channel check below');
  });
});

describe('the states that carry no verdict', () => {
  it('announces the loading state and claims nothing', () => {
    renderWithProviders(<PodSecurityPanel result={{ status: 'loading', refresh: vi.fn() }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading Pod Security');
    expect(screen.queryByRole('heading', { name: HEADINGS.pass })).toBeNull();
  });

  it.each([
    ['a 403 on the status endpoint', FORBIDDEN_CONTROL_STATUS_ERROR],
    ['a 500 on the status endpoint', SERVER_ERROR_CONTROL_STATUS_ERROR],
  ])('renders %s as an alert and never a verdict', (_name, error) => {
    renderWithProviders(<PodSecurityPanel result={{ status: 'error', error, refresh: vi.fn() }} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Pod Security posture request failed');
    // The disambiguation this panel exists to keep straight: a 403 HERE is a refused
    // client, not an admission rejection.
    expect(alert).toHaveTextContent('Status endpoint');
    expect(alert).not.toHaveTextContent('Enforcement verified');
  });

  it('distinguishes an empty report from a report that omitted this control', () => {
    const { unmount } = renderWithProviders(
      <PodSecurityPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('no controls at all');
    unmount();

    renderWithProviders(
      <PodSecurityPanel
        result={{
          status: 'success',
          controls: [V2_POD_SECURITY_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole('heading', { level: 3, name: HEADINGS.pass })).toBeInTheDocument();
  });

  it('treats an absent control payload as unknown in the exported resolver', () => {
    expect(resolvePodSecurityEffectiveVerdict(undefined)).toBe('unknown');
  });
});

describe('the interaction case', () => {
  it('re-requests exactly once per click, through the supplied handler', async () => {
    const onRefresh = vi.fn();
    const ownRefresh = vi.fn();
    const { user } = renderWithProviders(
      <PodSecurityPanel
        result={{
          status: 'success',
          controls: [V2_POD_SECURITY_PASSING],
          isEmpty: false,
          refresh: ownRefresh,
        }}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Re-check Pod Security enforcement' }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    // REPLACES rather than runs alongside, so one click is never two requests.
    expect(ownRefresh).not.toHaveBeenCalled();
  });
});
