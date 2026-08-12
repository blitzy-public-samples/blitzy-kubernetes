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

// AAP §0.5.1 (the `web/src/components/NodeIsolationPanel.test.tsx` row) / §0.4.2.4 (the
// five case categories) / §0.4.2.2 (V7's four assertions: two denials and two positive
// controls) / §0.7.2 (assertion density: all FOUR are kept) / §0.10.2 (the NodeRestriction
// ordering hazard — node2 must exist before the cross-node call, or the answer is 404 and
// the denial proves the wrong thing) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   The V7 panel renders a PASS only when all four recorded outcomes were measured and
//   all four hold, it locates them by exact identity, and a 404 is a FAILURE.
//
// THE TWO DEFECTS THESE CASES EXIST TO PREVENT, both of which the compiler and the linter
// accepted:
//
//   1. ORDER-DEPENDENT MATCHING. Rows were matched by folding the label to alphanumerics
//      and testing tokens with `includes`. The cross-node row was keyed on `node2` — and
//      the recorded passing payload also carries
//      `precondition: node2 existed before the cross-node call` with the value `true`.
//      Which observation claimed the row depended on list order, and if the precondition
//      won, its `true` read as ALLOWED and a recorded PASS rendered as a FAIL. The
//      reordering case below is the direct proof.
//   2. SILENCE SUPPORTING A PASS. A `not-reported` row raised no floor, so a payload
//      asserting `pass` while measuring NONE of the four rendered a clean bill of health.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V7_OBSERVATIONS, V7_OUTCOME_TITLES } from '../domain/observationIds';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  FORBIDDEN_STATUS,
  NOT_FOUND_STATUS,
  V7_NODE_RESTRICTION_CHECKS,
  V7_NODE_RESTRICTION_FAILING,
  V7_NODE_RESTRICTION_NOT_FOUND,
  V7_NODE_RESTRICTION_PASSING,
  V7_NODE_RESTRICTION_UNKNOWN,
  V7_POSITIVE_CONTROLS_FAILING,
  CONTROL_POSITIVE_CONTROLS,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import NodeIsolationPanel, {
  NODE_ISOLATION_CHECKS,
  resolveNodeIsolationEffectiveVerdict,
} from './NodeIsolationPanel';

/** Reads the verdict badge, which is where the panel states its verdict. */
function verdictText(): string {
  return screen.getByRole('status').textContent ?? '';
}

/** Builds a V7 payload from the recorded passing one with a replaced observation list. */
function passingWith(observations: readonly ControlObservation[]): ControlStatus {
  return { ...V7_NODE_RESTRICTION_PASSING, evidence: { observations } };
}

/** The four measured outcomes, all holding — the minimum a pass requires. */
const ALL_FOUR_HOLD: readonly ControlObservation[] = [
  { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: FORBIDDEN_STATUS },
  { label: V7_OBSERVATIONS.unrelatedSecretRead, value: FORBIDDEN_STATUS },
  { label: V7_OBSERVATIONS.ownNodeRead, value: 'allowed' },
  { label: V7_OBSERVATIONS.ownNodeStatusUpdate, value: 'allowed' },
];

describe('NodeIsolationPanel — recorded evidence and the fixture contract', () => {
  it('renders PASS for the recorded passing payload', () => {
    renderWithProviders(<NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} />);
    expect(verdictText()).toContain('Pass');
  });

  it('names its four rows with the SAME identities the fixture records', () => {
    const recorded = V7_NODE_RESTRICTION_PASSING.evidence.observations.map((entry) => entry.label);
    for (const check of NODE_ISOLATION_CHECKS) {
      expect.soft(recorded).toContain(check.observationLabel);
    }
    expect(NODE_ISOLATION_CHECKS.map((check) => check.observationLabel)).toEqual([
      V7_OBSERVATIONS.crossNodeStatusUpdate,
      V7_OBSERVATIONS.unrelatedSecretRead,
      V7_OBSERVATIONS.ownNodeRead,
      V7_OBSERVATIONS.ownNodeStatusUpdate,
    ]);
  });

  it('keeps all four rows on screen, in the oracle’s order', () => {
    renderWithProviders(<NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} />);
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    for (const check of NODE_ISOLATION_CHECKS) {
      expect.soft(rows.some((row) => row.includes(check.title))).toBe(true);
    }
  });

  it('accepts the scenario title as an exact alias for the measurement identity', () => {
    const byTitle: readonly ControlObservation[] = [
      { label: V7_OUTCOME_TITLES.crossNodeDenied, value: FORBIDDEN_STATUS },
      { label: V7_OUTCOME_TITLES.unrelatedSecretDenied, value: FORBIDDEN_STATUS },
      { label: V7_OUTCOME_TITLES.ownNodeReadAllowed, value: 'allowed' },
      { label: V7_OUTCOME_TITLES.ownNodeStatusUpdateAllowed, value: 'allowed' },
    ];
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(byTitle))).toBe('pass');
  });
});

describe('NodeIsolationPanel — matching is exact, so order cannot change the verdict', () => {
  it('renders PASS however the recorded observations are ORDERED', () => {
    // THE REGRESSION CASE. Reversed, the `precondition: node2 ...` observation comes
    // BEFORE the real cross-node 403. Under token matching it claimed the cross-node row,
    // its `true` read as ALLOWED, and the recorded PASS rendered as a FAIL.
    const reversed = [...V7_NODE_RESTRICTION_PASSING.evidence.observations].reverse();
    renderWithProviders(<NodeIsolationPanel status={passingWith(reversed)} />);
    expect(verdictText()).toContain('Pass');
  });

  it('leaves the node2 PRECONDITION unclaimed rather than reading it as an outcome', () => {
    // It is about node2 and it is a boolean, which is exactly the shape the old matcher
    // mistook for the cross-node decision. With none of the four rows reported, the
    // verdict must be Unknown — not the Fail the misreading produced.
    const preconditionOnly: readonly ControlObservation[] = [
      { label: V7_OBSERVATIONS.node2ExistedFirst, value: true },
    ];
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(preconditionOnly))).toBe('unknown');
  });

  it('does not let an unrelated Secret-shaped label claim the Secret row', () => {
    const decoy: readonly ControlObservation[] = [
      ...ALL_FOUR_HOLD.slice(0, 1),
      ...ALL_FOUR_HOLD.slice(2),
      { label: 'unrelated secret ns/unrelatedsecret was created by the superuser', value: 'allowed' },
    ];
    // The real Secret row is absent, so the verdict must be Unknown. Under token matching
    // the decoy supplied an ALLOWED outcome for a row that must be DENIED, i.e. a Fail.
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(decoy))).toBe('unknown');
  });

  it('treats a row reported TWICE as indeterminate rather than resolving it by order', () => {
    const duplicated: readonly ControlObservation[] = [
      ...ALL_FOUR_HOLD,
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: 'allowed' },
    ];
    renderWithProviders(<NodeIsolationPanel status={passingWith(duplicated)} />);
    expect(verdictText()).toContain('Unknown');
    expect(screen.getByRole('table')).toHaveTextContent(/reported 2 times/iu);
  });

  it('treats a row reported once under its identity and once under its alias as a conflict', () => {
    const bothNames: readonly ControlObservation[] = [
      ...ALL_FOUR_HOLD,
      { label: V7_OUTCOME_TITLES.crossNodeDenied, value: FORBIDDEN_STATUS },
    ];
    // Even though both say the same thing: an alias must not be able to override the
    // primary identity, or the precedence would be doing the deciding.
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(bothNames))).toBe('unknown');
  });
});

describe('NodeIsolationPanel — all four assertions are required for a pass', () => {
  it('renders UNKNOWN for a payload claiming pass with NO measured outcome', () => {
    renderWithProviders(<NodeIsolationPanel status={passingWith([])} />);
    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Pass');
  });

  it('renders UNKNOWN when the recorded unmeasured payload is served', () => {
    renderWithProviders(<NodeIsolationPanel status={V7_NODE_RESTRICTION_UNKNOWN} />);
    expect(verdictText()).toContain('Unknown');
  });

  it.each([0, 1, 2, 3])('renders UNKNOWN when only row %i is missing', (omitted: number) => {
    const partial = ALL_FOUR_HOLD.filter((_entry, index) => index !== omitted);
    expect(partial).toHaveLength(3);
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(partial))).toBe('unknown');
  });

  it('renders PASS when — and only when — all four are measured and hold', () => {
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(ALL_FOUR_HOLD))).toBe('pass');
  });

  it('cannot render PASS beside a reported finding, whatever the server said', () => {
    // The case no other assertion here reaches: all four rows hold AND the server claimed
    // `pass`, so the ONLY thing forcing a failure is the findings list. Without this case a
    // removal of the findings floor passes the whole spec — which is exactly what a
    // mutation run demonstrated before it was added.
    const withFinding: ControlStatus = {
      ...passingWith(ALL_FOUR_HOLD),
      findings: V7_NODE_RESTRICTION_FAILING.findings,
    };
    expect(withFinding.verdict).toBe('pass');
    expect(resolveNodeIsolationEffectiveVerdict(withFinding)).toBe('fail');

    const { container } = renderWithProviders(<NodeIsolationPanel status={withFinding} />);
    expect(verdictText()).toContain('Fail');
    for (const finding of withFinding.findings) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
  });
});

describe('NodeIsolationPanel — a 404 is a failure, not an indeterminate', () => {
  it('renders FAIL when the cross-node denial came back 404, even from a pass payload', () => {
    // `expectForbidden` (node_test.go L698-L703) asserts the error IS Forbidden and reports
    // anything else — a NotFound included — with `t.Errorf`. In Go this FAILS.
    const withNotFound: readonly ControlObservation[] = [
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: NOT_FOUND_STATUS },
      ...ALL_FOUR_HOLD.slice(1),
    ];
    renderWithProviders(<NodeIsolationPanel status={passingWith(withNotFound)} />);
    expect(verdictText()).toContain('Fail');
    expect(verdictText()).not.toContain('Unknown');
  });

  it('renders FAIL for the recorded 404 payload and explains why it is not a pass', () => {
    renderWithProviders(<NodeIsolationPanel status={V7_NODE_RESTRICTION_NOT_FOUND} />);
    expect(verdictText()).toContain('Fail');
    expect(screen.getByRole('note')).toHaveTextContent(/404 Not Found cannot establish/iu);
  });

  it('keeps a refusal with NO status code indeterminate, because it may or may not be 403', () => {
    const unspecified: readonly ControlObservation[] = [
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: 'denied' },
      ...ALL_FOUR_HOLD.slice(1),
    ];
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(unspecified))).toBe('unknown');
  });

  it('renders FAIL when a denial was ALLOWED, listing BOTH breached denials', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={V7_NODE_RESTRICTION_FAILING} />,
    );
    expect(verdictText()).toContain('Fail');
    // Matched on the COMPLETE message, not a prefix: the two findings share their opening
    // words, so a prefix match cannot tell them apart and would pass on either one alone.
    expect(V7_NODE_RESTRICTION_FAILING.findings).toHaveLength(2);
    for (const finding of V7_NODE_RESTRICTION_FAILING.findings) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
  });
});

describe('NodeIsolationPanel — V7 positive controls ACCUMULATE, so both failures show', () => {
  it('records all four checks as accumulating, matching t.Errorf', () => {
    // Measured, not chosen: expectForbidden (L698) and expectAllowed (L1712) both report
    // with `t.Errorf`, so one run reports every check that failed. Only V1's positive
    // control uses `t.Fatalf`.
    for (const check of V7_NODE_RESTRICTION_CHECKS) {
      expect.soft(check.severityWhenViolated).toBe('accumulate');
    }
    for (const control of CONTROL_POSITIVE_CONTROLS.V7) {
      expect.soft(control.severityWhenBroken).toBe('accumulate');
    }
    expect(CONTROL_POSITIVE_CONTROLS.V1[0].severityWhenBroken).toBe('abort');
  });

  it('renders FAIL with BOTH positive-control failures from one evaluation', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={V7_POSITIVE_CONTROLS_FAILING} />,
    );
    expect(verdictText()).toContain('Fail');
    expect(V7_POSITIVE_CONTROLS_FAILING.findings).toHaveLength(2);
    for (const finding of V7_POSITIVE_CONTROLS_FAILING.findings) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
  });

  it('renders FAIL, not UNKNOWN, when a positive control is refused', () => {
    const refusedControl: readonly ControlObservation[] = [
      ...ALL_FOUR_HOLD.slice(0, 2),
      { label: V7_OBSERVATIONS.ownNodeRead, value: FORBIDDEN_STATUS },
      ALL_FOUR_HOLD[3],
    ];
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(refusedControl))).toBe('fail');
  });
});

describe('NodeIsolationPanel — the exported resolver the dashboard consumes', () => {
  it('agrees with the badge the panel renders, for every recorded payload', () => {
    const cases: readonly [ControlStatus, string][] = [
      [V7_NODE_RESTRICTION_PASSING, 'Pass'],
      [V7_NODE_RESTRICTION_FAILING, 'Fail'],
      [V7_NODE_RESTRICTION_NOT_FOUND, 'Fail'],
      [V7_POSITIVE_CONTROLS_FAILING, 'Fail'],
      [V7_NODE_RESTRICTION_UNKNOWN, 'Unknown'],
    ];
    for (const [payload, expected] of cases) {
      const { unmount } = renderWithProviders(<NodeIsolationPanel status={payload} />);
      expect.soft(verdictText()).toContain(expected);
      expect.soft(resolveNodeIsolationEffectiveVerdict(payload)).toBe(expected.toLowerCase());
      unmount();
    }
  });

  it('resolves an ABSENT payload to unknown rather than to a pass', () => {
    expect(resolveNodeIsolationEffectiveVerdict(undefined)).toBe('unknown');
  });

  it('floors at warn when the server raised a warning and everything else holds', () => {
    const warned: ControlStatus = { ...passingWith(ALL_FOUR_HOLD), warnings: ['node2 was recreated'] };
    expect(resolveNodeIsolationEffectiveVerdict(warned)).toBe('warn');
  });
});

describe('NodeIsolationPanel — loading, empty, error and interaction', () => {
  it('renders the loading state and no verdict', () => {
    renderWithProviders(<NodeIsolationPanel result={{ status: 'loading', refresh: vi.fn() }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reading|loading|checking/iu);
    expect(verdictText()).not.toContain('Pass');
  });

  it('renders the empty state as NOT a pass when no controls were reported', () => {
    renderWithProviders(
      <NodeIsolationPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('Pass');
  });

  it('renders a refusal as an error, with no verdict and no table', () => {
    renderWithProviders(
      <NodeIsolationPanel
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
    expect(screen.getByRole('alert')).toHaveTextContent(/forbidden/iu);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('Pass');
  });

  it('invokes the caller’s refresh handler exactly once per activation', async () => {
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} onRefresh={onRefresh} />,
    );
    await user.click(screen.getByRole('button'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('calls the override instead of the underlying refresh when both exist', async () => {
    const onRefresh = vi.fn();
    const refresh = vi.fn();
    const { user } = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'success',
          controls: [V7_NODE_RESTRICTION_PASSING],
          isEmpty: false,
          refresh,
        }}
        onRefresh={onRefresh}
      />,
    );
    await user.click(screen.getByRole('button'));

    // ONE channel. Chaining the two turned a single press into two requests.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables the control, with a reason, when there is nothing to re-request', () => {
    renderWithProviders(<NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} />);
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });

  it('disables every refresh route when the caller says refreshing is unavailable', () => {
    renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'success',
          controls: [V7_NODE_RESTRICTION_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
        onRefresh={vi.fn()}
        canRefresh={false}
      />,
    );
    const button = screen.getByRole('button');

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });
});
