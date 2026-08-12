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

// AAP §0.5.1 (the `web/src/components/RbacWildcardPanel.test.tsx` row) / §0.4.2.4 (the
// five case categories every panel spec covers: happy path, partial/unknown, error,
// loading and empty, interaction) / §0.4.1.2 (the accumulate-versus-abort asymmetry,
// asserted here with `expect.soft` for findings and a hard `expect` for the positive
// control) / §0.7.2 (assertion density: V1 keeps BOTH strategies) / §0.10.2 (the
// positive control that must port unchanged) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   The V1 panel renders a PASS only when the recorded evidence establishes BOTH
//   halves of the control, and it locates that evidence by exact shared identity.
//
// WHY THESE PARTICULAR CASES. The defect this spec exists to prevent was not a wrong
// verdict computed from evidence -- it was a verdict computed from NO evidence, because
// the panel and the payload named the same facts differently. A spec that only rendered
// the passing fixture and asserted "Pass" would have caught it; a spec that only
// unit-tested the resolver with hand-built observations would NOT, because it would have
// used the panel's own vocabulary on both sides. So the first case below renders the
// RECORDED payload and asserts the badge, and the fixture-alignment case asserts the two
// vocabularies are literally the same strings.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V1_OBSERVATIONS } from '../domain/observationIds';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  V1_DENIED_SUBJECT,
  V1_POSITIVE_CONTROL_SUBJECT,
  V1_RBAC_FAILING,
  V1_RBAC_FINDINGS,
  V1_RBAC_PASSING,
  V1_RBAC_UNKNOWN,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import RbacWildcardPanel, {
  DECISION_LABELS,
  NON_MASTER_DENIED_PROBE,
  POSITIVE_CONTROL_BROKEN_TEXT,
  POSITIVE_CONTROL_CONFLICTING_TEXT,
  POSITIVE_CONTROL_SATISFIED_TEXT,
  POSITIVE_CONTROL_UNCONFIRMED_TEXT,
  PROBE_OUTCOME_CONFLICTING,
  PROBE_OUTCOME_FINDING,
  PROBE_OUTCOME_HOLDS,
  PROBE_OUTCOME_UNREPORTED,
  RBAC_WILDCARD_CONTROL_ABSENT_TEXT,
  RBAC_WILDCARD_ERROR_PREFIX,
  RBAC_WILDCARD_LOADING_TEXT,
  RBAC_WILDCARD_NO_CONTROLS_TEXT,
  REFRESH_BUTTON_LABEL,
  SUBJECT_ACCESS_REVIEW_PROBES,
  SYSTEM_MASTERS_ALLOWED_PROBE,
  assessRbacWildcard,
  readProbeDecision,
  resolveRbacWildcardEffectiveVerdict,
} from './RbacWildcardPanel';

/** Reads the verdict badge's accessible name, which is where the verdict is stated. */
function verdictText(): string {
  return screen.getByRole('status').textContent ?? '';
}

/**
 * Builds a V1 payload from the recorded passing one with a replaced observation list.
 *
 * Derived from the RECORDED payload rather than written from scratch, so a case that
 * changes one observation cannot accidentally pass because of some other field it forgot.
 */
function passingWith(observations: readonly ControlObservation[]): ControlStatus {
  return { ...V1_RBAC_PASSING, evidence: { observations } };
}

describe('RbacWildcardPanel — recorded evidence and the fixture contract', () => {
  it('renders PASS for the recorded passing payload', () => {
    // THE REGRESSION CASE. Before the fix this rendered UNKNOWN: the panel probed for
    // labels of its own invention while the payload carried the recorded ones, so neither
    // probe was found and the positive control was never confirmed.
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
    expect(verdictText()).toContain('Pass');
    expect(screen.getByText(POSITIVE_CONTROL_SATISFIED_TEXT)).toBeInTheDocument();
  });

  it('locates BOTH probes in the recorded payload, so neither is silently unreported', () => {
    const observations = V1_RBAC_PASSING.evidence.observations;
    expect(readProbeDecision(NON_MASTER_DENIED_PROBE, observations)).toBe('denied');
    expect(readProbeDecision(SYSTEM_MASTERS_ALLOWED_PROBE, observations)).toBe('allowed');
  });

  it('names its probes with the SAME identities the fixture records', () => {
    // The structural half of the alignment: the panel and the fixture import one
    // definition site, so this cannot drift back apart without a compile error there.
    expect(NON_MASTER_DENIED_PROBE.observationLabel).toBe(V1_OBSERVATIONS.deniedSubjectAllowed);
    expect(SYSTEM_MASTERS_ALLOWED_PROBE.observationLabel).toBe(
      V1_OBSERVATIONS.positiveControlAllowed,
    );
    const recorded = V1_RBAC_PASSING.evidence.observations.map((entry) => entry.label);
    for (const probe of SUBJECT_ACCESS_REVIEW_PROBES) {
      expect(recorded).toContain(probe.observationLabel);
    }
  });

  it('renders both probe rows always, with the recorded decisions', () => {
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
    const deniedRow = screen.getByRole('row', { name: new RegExp(V1_DENIED_SUBJECT.user, 'u') });
    expect(deniedRow).toHaveTextContent(DECISION_LABELS.denied);
    expect(deniedRow).toHaveTextContent(PROBE_OUTCOME_HOLDS);
    const controlRow = screen.getByRole('row', {
      name: new RegExp(`^${V1_POSITIVE_CONTROL_SUBJECT.user}\\b`, 'u'),
    });
    expect(controlRow).toHaveTextContent(DECISION_LABELS.allowed);
    expect(controlRow).toHaveTextContent(PROBE_OUTCOME_HOLDS);
  });
});

describe('RbacWildcardPanel — a pass requires BOTH assertions to be established', () => {
  it('renders UNKNOWN for a payload claiming pass with NO evidence at all', () => {
    renderWithProviders(<RbacWildcardPanel status={passingWith([])} />);
    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Pass');
  });

  it('renders UNKNOWN when only the positive control was measured', () => {
    // Half the assertions is not the control. AAP §0.7.2 keeps V1's density at two.
    renderWithProviders(
      <RbacWildcardPanel
        status={passingWith([{ label: V1_OBSERVATIONS.positiveControlAllowed, value: true }])}
      />,
    );
    expect(verdictText()).toContain('Unknown');
    expect(screen.getByText(POSITIVE_CONTROL_SATISFIED_TEXT)).toBeInTheDocument();
  });

  it('renders UNKNOWN when only the denial was measured, and says the control is unconfirmed', () => {
    renderWithProviders(
      <RbacWildcardPanel
        status={passingWith([{ label: V1_OBSERVATIONS.deniedSubjectAllowed, value: false }])}
      />,
    );
    expect(verdictText()).toContain('Unknown');
    expect(screen.getByText(POSITIVE_CONTROL_UNCONFIRMED_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent(PROBE_OUTCOME_UNREPORTED);
  });

  it('renders UNKNOWN, not PASS, when the positive control was DENIED', () => {
    // The presentation-layer form of `t.Fatalf`: the check cannot tell a locked-down
    // cluster from a stack that denies everything, so no verdict is trustworthy.
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_UNKNOWN} />);
    expect(verdictText()).toContain('Unknown');
    expect(screen.getByRole('alert')).toHaveTextContent(POSITIVE_CONTROL_BROKEN_TEXT);
  });
});

describe('RbacWildcardPanel — conflicting and wrongly typed decisions', () => {
  it('treats a decision reported TWICE as conflicting, not as the first one', () => {
    // Two contradictory answers under one identity. Taking the first makes the verdict a
    // function of serialisation order; the panel refuses to make one at all.
    const observations: readonly ControlObservation[] = [
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: false },
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: true },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: true },
    ];
    expect(readProbeDecision(NON_MASTER_DENIED_PROBE, observations)).toBe('conflicting');
    renderWithProviders(<RbacWildcardPanel status={passingWith(observations)} />);
    expect(verdictText()).toContain('Unknown');
    expect(screen.getByRole('table')).toHaveTextContent(PROBE_OUTCOME_CONFLICTING);
  });

  it('says so distinctly when the POSITIVE CONTROL is the conflicting one', () => {
    const observations: readonly ControlObservation[] = [
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: false },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: true },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: false },
    ];
    renderWithProviders(<RbacWildcardPanel status={passingWith(observations)} />);
    expect(verdictText()).toContain('Unknown');
    // NOT the satisfied wording, which is what an inexhaustive branch would have shown.
    expect(screen.getByText(POSITIVE_CONTROL_CONFLICTING_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(POSITIVE_CONTROL_SATISFIED_TEXT)).not.toBeInTheDocument();
  });

  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['an explicit null', null],
  ])('refuses to read %s as a decision', (_label, value: string | number | null) => {
    // `'false'` is TRUTHY in JavaScript, so a coercing reader would invert the answer it
    // was asked for. None of these five is a boolean, so none is a decision.
    const observations: readonly ControlObservation[] = [
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: true },
    ];
    expect(readProbeDecision(NON_MASTER_DENIED_PROBE, observations)).toBe('conflicting');
    expect(assessRbacWildcard(passingWith(observations)).verdict).toBe('unknown');
  });

  it('no longer matches a label by SUBSTRING, so an unrelated boolean cannot decide', () => {
    // The old second channel matched any label containing the principal or the privileged
    // group. This observation contains the group name and carries a boolean, and it must
    // not be read as the positive control's decision.
    const observations: readonly ControlObservation[] = [
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: false },
      { label: `full-wildcard binding names ${V1_POSITIVE_CONTROL_SUBJECT.groups[0]}`, value: true },
    ];
    expect(readProbeDecision(SYSTEM_MASTERS_ALLOWED_PROBE, observations)).toBe('unreported');
    expect(assessRbacWildcard(passingWith(observations)).verdict).toBe('unknown');
  });
});

describe('RbacWildcardPanel — findings accumulate, and a finding is always a failure', () => {
  it('renders EVERY recorded offender, not just the first', () => {
    const { container } = renderWithProviders(<RbacWildcardPanel status={V1_RBAC_FAILING} />);
    expect(verdictText()).toContain('Fail');
    // Softly, one per finding: `t.Errorf` accumulates, so one run reports every offender
    // and one spec run should report every missing one. Matched on the COMPLETE message
    // rather than a prefix, so two findings that open with the same words cannot satisfy
    // each other's assertion.
    for (const finding of V1_RBAC_FINDINGS) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
    expect(V1_RBAC_FINDINGS.length).toBeGreaterThan(1);
  });

  it('renders FAIL when the non-master identity resolved the full wildcard', () => {
    const observations: readonly ControlObservation[] = [
      { label: V1_OBSERVATIONS.deniedSubjectAllowed, value: true },
      { label: V1_OBSERVATIONS.positiveControlAllowed, value: true },
    ];
    renderWithProviders(<RbacWildcardPanel status={passingWith(observations)} />);
    expect(verdictText()).toContain('Fail');
    expect(screen.getByRole('table')).toHaveTextContent(PROBE_OUTCOME_FINDING);
  });

  it('cannot render PASS beside a reported finding, whatever the server said', () => {
    const withFinding: ControlStatus = { ...V1_RBAC_PASSING, findings: V1_RBAC_FINDINGS };
    expect(withFinding.verdict).toBe('pass');
    expect(assessRbacWildcard(withFinding).verdict).toBe('fail');
  });
});

describe('RbacWildcardPanel — the exported resolver the dashboard consumes', () => {
  it('agrees with the badge the panel renders, for every recorded payload', () => {
    const cases: readonly [ControlStatus, string][] = [
      [V1_RBAC_PASSING, 'Pass'],
      [V1_RBAC_FAILING, 'Fail'],
      [V1_RBAC_UNKNOWN, 'Unknown'],
    ];
    for (const [payload, expected] of cases) {
      const { unmount } = renderWithProviders(<RbacWildcardPanel status={payload} />);
      expect.soft(verdictText()).toContain(expected);
      expect.soft(resolveRbacWildcardEffectiveVerdict(payload)).toBe(expected.toLowerCase());
      unmount();
    }
  });

  it('resolves an ABSENT payload to unknown rather than to a pass', () => {
    expect(resolveRbacWildcardEffectiveVerdict(undefined)).toBe('unknown');
  });
});

describe('RbacWildcardPanel — loading, empty, error and interaction', () => {
  it('renders the loading state with the refresh affordance available', () => {
    const refresh = vi.fn();
    renderWithProviders(<RbacWildcardPanel result={{ status: 'loading', refresh }} />);
    expect(screen.getByText(RBAC_WILDCARD_LOADING_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REFRESH_BUTTON_LABEL })).toBeEnabled();
  });

  it('renders the empty state as NOT a pass when no controls were reported', () => {
    renderWithProviders(
      <RbacWildcardPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );
    expect(screen.getByText(RBAC_WILDCARD_NO_CONTROLS_TEXT)).toBeInTheDocument();
    // The empty state states an EXPLICIT Unknown rather than omitting the badge. That is
    // the stronger behaviour and it is what the panel does: a missing badge is ambiguous
    // to a reader scanning several panels, whereas "Unknown" is a claim.
    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Pass');
  });

  it('distinguishes "this control was absent" from "nothing was reported"', () => {
    const otherControl: ControlStatus = { ...V1_RBAC_PASSING, controlId: 'V2' };
    renderWithProviders(
      <RbacWildcardPanel
        result={{ status: 'success', controls: [otherControl], isEmpty: false, refresh: vi.fn() }}
      />,
    );
    expect(screen.getByText(RBAC_WILDCARD_CONTROL_ABSENT_TEXT)).toBeInTheDocument();
  });

  it('renders a refusal as an error and never as a verdict', () => {
    renderWithProviders(
      <RbacWildcardPanel
        result={{
          status: 'error',
          error: {
            kind: 'http',
            message: 'controls.posture.k8s.io is forbidden: no access',
            httpStatus: 403,
            reason: 'Forbidden',
          },
          refresh: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText(new RegExp(RBAC_WILDCARD_ERROR_PREFIX, 'u'))).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('invokes the caller’s refresh handler exactly once per activation', async () => {
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <RbacWildcardPanel status={V1_RBAC_PASSING} onRefresh={onRefresh} />,
    );
    await user.click(screen.getByRole('button', { name: REFRESH_BUTTON_LABEL }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the refresh affordance, with a reason, when there is nothing to re-issue', () => {
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
    const button = screen.getByRole('button', { name: REFRESH_BUTTON_LABEL });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });
});
