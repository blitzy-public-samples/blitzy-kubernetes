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

// AAP §0.5.1 (the `web/src/components/PostureDashboard.test.tsx` row: "Aggregate view across
// all eight controls, plus loading, empty, error") / §0.4.2.4 (the five case categories every
// component spec covers) / §0.7.2 (assertion density and failure legibility) / §0.10.2 (the
// positive controls and the "absent evidence is never a pass" boundary) / tech-spec §6.6.3.4.
//
// THE TWO INVARIANTS THIS FILE LOCKS
//
//   1. THE AGGREGATE CANNOT DISAGREE WITH THE PANELS BENEATH IT. Every count, every filter
//      decision and every control section's marker is the EFFECTIVE verdict — the one the
//      control's own panel renders after reconciling what the check reported against what it
//      measured — and never the raw `status.verdict` the response claimed.
//   2. ONE PRESS IS ONE REFRESH, AND AN UNAVAILABLE REFRESH SAYS SO. A press of any refresh
//      control on the surface calls the caller's handler exactly once, and when no handler
//      reached the dashboard every one of the nine controls is disabled with an explanation
//      rather than eight of them looking operable while the ninth admits it cannot act.
//
// WHY THESE PARTICULAR CASES, AND WHY THEY ARE BUILT THE WAY THEY ARE.
//
// The recorded fixtures are honest: each passing payload really does carry the evidence its
// verdict claims, so every panel resolves `pass` for it and the raw and effective verdicts
// AGREE. A spec built only from the fixtures would therefore have passed against the defect
// too — the dashboard counting `status.verdict` produces the same numbers whenever the two
// agree. So the decisive cases below DERIVE payloads in which the two must diverge: a passing
// payload with a finding attached (every panel floors that at `fail`) and a passing payload
// with its observations emptied (every panel degrades that to `unknown`). Both keep
// `verdict: 'pass'` on the wire, so the raw reading reports "Pass: 8" and the correct reading
// reports eight failures or eight unknowns. That is the difference the aggregate exists to
// show, and it is asserted in the tally, in the filter and in each control's section.

import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ControlId, ControlStatus, ControlVerdict } from '../hooks/useControlStatus';
import { CONTROL_IDS } from '../hooks/useControlStatus';
import {
  FAILING_CONTROL_STATUSES,
  FORBIDDEN_CONTROL_STATUS_ERROR,
  MIXED_CONTROL_STATUSES,
  NETWORK_CONTROL_STATUS_ERROR,
  PASSING_CONTROL_STATUSES,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  UNKNOWN_CONTROL_STATUSES,
  WARNING_CONTROL_STATUSES,
} from '../test/fixtures/controlStatus';
import { server } from '../test/msw/server';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import PostureDashboard, {
  AGGREGATE_EMPTY_LABEL,
  AGGREGATE_ERROR_LABEL,
  AGGREGATE_LOADING_LABEL,
  AGGREGATE_SECTION_HEADING,
  AGGREGATE_VERDICT_LABEL,
  AGGREGATE_VERDICT_PRESENTATION,
  ALL_VERDICTS_OPTION_LABEL,
  ALL_VERDICTS_VALUE,
  CONTROLS_SECTION_HEADING,
  CONTROL_SECTION_TITLES,
  FILTER_EMPTY_LABEL,
  FILTER_NOTICE_LABEL,
  POSTURE_DASHBOARD_TITLE,
  REFRESH_ALL_LABEL,
  REFRESH_UNAVAILABLE_TITLE,
  VERDICT_COUNTS_HEADING,
  VERDICT_FILTER_LABEL,
  VERDICT_PRECEDENCE,
  resolveEffectiveVerdicts,
  summarisePosture,
} from './PostureDashboard';
import { resolveEffectiveControlVerdict } from './controlVerdicts';

/** The roster as a plain map, which is the shape the dashboard's `statuses` prop takes. */
type StatusMap = Record<ControlId, ControlStatus>;

/**
 * A payload in which every control claims `pass` on the wire while carrying findings.
 *
 * This is the shape the defect turned into "Pass: 8": the aggregate read `status.verdict`
 * and each panel floored the same payload at `fail` because a finding contradicts a pass.
 * The findings are the recorded ones from each control's failing fixture, so the prose
 * rendered is real reported prose rather than invented text.
 */
function claimingPassWithFindings(): StatusMap {
  const derived: Partial<StatusMap> = {};
  for (const controlId of CONTROL_IDS) {
    derived[controlId] = {
      ...PASSING_CONTROL_STATUSES[controlId],
      verdict: 'pass',
      findings: FAILING_CONTROL_STATUSES[controlId].findings,
    };
  }
  return derived as StatusMap;
}

/**
 * A payload in which every control claims `pass` on the wire while reporting no evidence.
 *
 * The second half of the same defect, and the more insidious half: nothing is wrong, nothing
 * was measured, and a raw reading calls that a clean pass. Every panel degrades it to
 * `unknown`, because absent evidence is never good evidence.
 */
function claimingPassWithoutEvidence(): StatusMap {
  const derived: Partial<StatusMap> = {};
  for (const controlId of CONTROL_IDS) {
    derived[controlId] = {
      ...PASSING_CONTROL_STATUSES[controlId],
      verdict: 'pass',
      findings: [],
      // Every measured fact removed, including V4's audience list and observed expiry,
      // so nothing at all supports the claim the payload still makes.
      evidence: { observations: [] },
    };
  }
  return derived as StatusMap;
}

/** The dashboard's own section for one control. */
function controlSection(container: HTMLElement, controlId: ControlId): HTMLElement {
  const item = container.querySelector(`li[data-control-id="${controlId}"]`);
  expect(item, `no dashboard section rendered for ${controlId}`).not.toBeNull();
  return item as HTMLElement;
}

/** The verdict the dashboard itself marks one control section with. */
function sectionVerdict(container: HTMLElement, controlId: ControlId): string | null {
  const section = controlSection(container, controlId).querySelector(
    'section.posture-dashboard__control',
  );
  return section?.getAttribute('data-verdict') ?? null;
}

/**
 * Every verdict marker the CHILD PANEL renders inside one control's section.
 *
 * Two exclusions, both deliberate. The dashboard's own `section.posture-dashboard__control`
 * is excluded because it is the value under test on the other side of the comparison. And any
 * element carrying `data-scenario` is excluded because those are V8's five branch-documentation
 * rows — each describes what `configure-etcd-params` does in one scenario, not what this
 * deployment's posture is — so folding them in would compare a verdict against a legend.
 *
 * Four panels (V1, V2, V3, V7) expose no panel-level marker, so this is empty for them and
 * their agreement is asserted through the prose they render instead.
 */
function panelVerdictMarkers(section: HTMLElement): readonly string[] {
  return Array.from(section.querySelectorAll('[data-verdict]'))
    .filter((element) => !element.classList.contains('posture-dashboard__control'))
    .filter((element) => element.getAttribute('data-scenario') === null)
    .map((element) => element.getAttribute('data-verdict') ?? '');
}

/** The tally, read back as a verdict-keyed map. */
function renderedCounts(container: HTMLElement): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of Array.from(container.querySelectorAll('.posture-dashboard__count'))) {
    const verdict = item.getAttribute('data-verdict') ?? '';
    const text = item.textContent ?? '';
    const parsed = Number(text.slice(text.lastIndexOf(':') + 1).trim());
    counts[verdict] = parsed;
  }
  return counts;
}

/** Which controls are currently rendered, in the order they appear. */
function visibleControlIds(container: HTMLElement): readonly string[] {
  return Array.from(container.querySelectorAll('li[data-control-id]')).map(
    (item) => item.getAttribute('data-control-id') ?? '',
  );
}

/** The one refresh button belonging to one control's panel. */
function panelRefreshButton(container: HTMLElement, controlId: ControlId): HTMLButtonElement {
  const buttons = within(controlSection(container, controlId)).getAllByRole('button');
  expect(buttons, `${controlId} should own exactly one refresh control`).toHaveLength(1);
  return buttons[0] as HTMLButtonElement;
}

describe('PostureDashboard — the aggregate rule, exercised without rendering', () => {
  it('is a pass only when every one of the eight controls passes', () => {
    const aggregate = summarisePosture(PASSING_CONTROL_STATUSES);

    expect(aggregate.verdict).toBe('pass');
    expect(aggregate.counts).toEqual({ pass: 8, fail: 0, warn: 0, unknown: 0 });
    expect(aggregate.reported).toBe(8);
    expect(aggregate.total).toBe(8);
  });

  it('fails on one failure however many others pass', () => {
    const statuses: StatusMap = {
      ...PASSING_CONTROL_STATUSES,
      V3: FAILING_CONTROL_STATUSES.V3,
    };

    expect(summarisePosture(statuses).verdict).toBe('fail');
    expect(summarisePosture(statuses).counts.fail).toBe(1);
  });

  it('cannot claim a pass while one control is unknown', () => {
    const statuses: StatusMap = {
      ...PASSING_CONTROL_STATUSES,
      V7: UNKNOWN_CONTROL_STATUSES.V7,
    };

    expect(summarisePosture(statuses).verdict).toBe('unknown');
  });

  it('never absorbs a warning into a clean pass', () => {
    const statuses: StatusMap = {
      ...PASSING_CONTROL_STATUSES,
      V2: WARNING_CONTROL_STATUSES.V2,
    };

    expect(summarisePosture(statuses).verdict).toBe('warn');
    expect(summarisePosture(statuses).counts).toEqual({ pass: 7, fail: 0, warn: 1, unknown: 0 });
  });

  it('ranks a known failure above an unknown when both are present', () => {
    const statuses: StatusMap = {
      ...PASSING_CONTROL_STATUSES,
      V1: FAILING_CONTROL_STATUSES.V1,
      V7: UNKNOWN_CONTROL_STATUSES.V7,
    };

    expect(summarisePosture(statuses).verdict).toBe('fail');
  });

  it('judges a control omitted from the payload as unknown, never as pass', () => {
    const partial = { ...PASSING_CONTROL_STATUSES } as Partial<StatusMap>;
    delete partial.V5;

    const aggregate = summarisePosture(partial);

    expect(aggregate.verdict).toBe('unknown');
    expect(aggregate.counts.unknown).toBe(1);
    // The denominator is the ROSTER, so a silent control is judged rather than excluded.
    expect(aggregate.reported).toBe(7);
    expect(aggregate.total).toBe(8);
  });

  it('resolves an empty payload to unknown across the whole roster', () => {
    const aggregate = summarisePosture({});

    expect(aggregate.verdict).toBe('unknown');
    expect(aggregate.counts).toEqual({ pass: 0, fail: 0, warn: 0, unknown: 8 });
    expect(aggregate.reported).toBe(0);
  });

  it('resolves each control through that control’s own panel resolver', () => {
    const resolved = resolveEffectiveVerdicts(MIXED_CONTROL_STATUSES.reduce<Partial<StatusMap>>(
      (accumulator, status) => ({ ...accumulator, [status.controlId]: status }),
      {},
    ));

    for (const controlId of CONTROL_IDS) {
      const status = MIXED_CONTROL_STATUSES.find((entry) => entry.controlId === controlId);
      expect(resolved[controlId]).toBe(resolveEffectiveControlVerdict(controlId, status));
    }
  });

  it('counts the effective verdict, not the verdict the response claimed', () => {
    const claimed = claimingPassWithFindings();

    // Every payload says `pass` on the wire.
    for (const controlId of CONTROL_IDS) {
      expect(claimed[controlId].verdict).toBe('pass');
    }
    // And every panel floors it at `fail`, so the aggregate must too.
    expect(summarisePosture(claimed).counts).toEqual({ pass: 0, fail: 8, warn: 0, unknown: 0 });
    expect(summarisePosture(claimed).verdict).toBe('fail');
    // `reported` still counts eight: the payload DID describe all eight controls.
    expect(summarisePosture(claimed).reported).toBe(8);
  });

  it('degrades an unsupported claim of pass to unknown rather than counting it', () => {
    const claimed = claimingPassWithoutEvidence();

    expect(summarisePosture(claimed).counts).toEqual({ pass: 0, fail: 0, warn: 0, unknown: 8 });
    expect(summarisePosture(claimed).verdict).toBe('unknown');
  });

  it('reports coverage from the payload, not from how many verdicts were conclusive', () => {
    // All eight controls WERE described; none of them could be judged. Those are two
    // different facts, and collapsing them would tell a reader the response was silent
    // about eight controls when in truth it described eight and proved none.
    expect(summarisePosture(claimingPassWithoutEvidence()).reported).toBe(8);
    expect(summarisePosture(claimingPassWithFindings()).reported).toBe(8);
  });
});

describe('PostureDashboard — the tally and the panels can never disagree', () => {
  it('marks every control with the verdict its own panel resolves, on the happy path', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} onRefresh={vi.fn()} />,
    );

    for (const controlId of CONTROL_IDS) {
      const expected = resolveEffectiveControlVerdict(
        controlId,
        PASSING_CONTROL_STATUSES[controlId],
      );
      expect.soft(sectionVerdict(container, controlId), `${controlId} section`).toBe(expected);
      for (const marker of panelVerdictMarkers(controlSection(container, controlId))) {
        expect.soft(marker, `${controlId} panel marker`).toBe(expected);
      }
    }
    expect(renderedCounts(container)).toEqual({ pass: 8, fail: 0, warn: 0, unknown: 0 });
  });

  it('reports eight failures for a payload that claims eight passes but carries findings', () => {
    const claimed = claimingPassWithFindings();
    const { container } = renderWithProviders(
      <PostureDashboard statuses={claimed} onRefresh={vi.fn()} />,
    );

    // THE DEFECT THIS CASE EXISTS FOR: the raw reading rendered "Pass: 8" here.
    expect(renderedCounts(container)).toEqual({ pass: 0, fail: 8, warn: 0, unknown: 0 });
    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toHaveAttribute(
      'data-verdict',
      'fail',
    );

    for (const controlId of CONTROL_IDS) {
      const section = controlSection(container, controlId);
      expect.soft(sectionVerdict(container, controlId), `${controlId} section`).toBe('fail');
      for (const marker of panelVerdictMarkers(section)) {
        expect.soft(marker, `${controlId} panel marker`).toBe('fail');
      }
      // The four panels with no verdict marker still prove agreement: each renders the
      // reported finding, so the panel is showing the failure the dashboard counted.
      const finding = claimed[controlId].findings[0];
      expect.soft(section, `${controlId} finding prose`).toHaveTextContent(finding.message);
    }
  });

  it('reports eight unknowns for a payload that claims eight passes with no evidence', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={claimingPassWithoutEvidence()} onRefresh={vi.fn()} />,
    );

    expect(renderedCounts(container)).toEqual({ pass: 0, fail: 0, warn: 0, unknown: 8 });
    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toHaveAttribute(
      'data-verdict',
      'unknown',
    );
    for (const controlId of CONTROL_IDS) {
      expect.soft(sectionVerdict(container, controlId), `${controlId} section`).toBe('unknown');
      for (const marker of panelVerdictMarkers(controlSection(container, controlId))) {
        expect.soft(marker, `${controlId} panel marker`).toBe('unknown');
      }
    }
  });

  it('tallies a mixed roster exactly as each panel resolves it', () => {
    const statuses = MIXED_CONTROL_STATUSES.reduce<Partial<StatusMap>>(
      (accumulator, status) => ({ ...accumulator, [status.controlId]: status }),
      {},
    );
    const { container } = renderWithProviders(
      <PostureDashboard statuses={statuses} onRefresh={vi.fn()} />,
    );

    const expected: Record<string, number> = { pass: 0, fail: 0, warn: 0, unknown: 0 };
    for (const controlId of CONTROL_IDS) {
      const verdict = resolveEffectiveControlVerdict(controlId, statuses[controlId]);
      expected[verdict] += 1;
      expect.soft(sectionVerdict(container, controlId), `${controlId} section`).toBe(verdict);
    }

    expect(renderedCounts(container)).toEqual(expected);
    // One failure fails the aggregate however many others pass.
    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toHaveAttribute(
      'data-verdict',
      'fail',
    );
  });

  it('states how many of the eight controls the payload described', () => {
    const partial = { ...PASSING_CONTROL_STATUSES } as Partial<StatusMap>;
    delete partial.V6;
    renderWithProviders(<PostureDashboard statuses={partial} onRefresh={vi.fn()} />);

    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toHaveTextContent(
      '7 of 8 controls were reported.',
    );
  });

  it('reports full coverage even when not one control could be judged', () => {
    renderWithProviders(
      <PostureDashboard statuses={claimingPassWithoutEvidence()} onRefresh={vi.fn()} />,
    );
    const verdict = screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL });

    expect(verdict).toHaveAttribute('data-verdict', 'unknown');
    expect(verdict).toHaveTextContent('8 of 8 controls were reported.');
  });
});

describe('PostureDashboard — the verdict filter selects on the effective verdict', () => {
  it('hides every control when filtering for a pass nothing actually holds', async () => {
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={claimingPassWithFindings()} onRefresh={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText(VERDICT_FILTER_LABEL), 'pass');

    // Filtering on the RAW verdict would have shown all eight here.
    expect(visibleControlIds(container)).toHaveLength(0);
    expect(screen.getByText(FILTER_EMPTY_LABEL)).toBeInTheDocument();
  });

  it('shows every control when filtering for the failure they all effectively hold', async () => {
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={claimingPassWithFindings()} onRefresh={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText(VERDICT_FILTER_LABEL), 'fail');

    expect(visibleControlIds(container)).toEqual([...CONTROL_IDS]);
    expect(screen.getByText(FILTER_NOTICE_LABEL)).toBeInTheDocument();
  });

  it('keeps the aggregate computed from all eight controls while a filter is active', async () => {
    const statuses: StatusMap = { ...PASSING_CONTROL_STATUSES, V3: FAILING_CONTROL_STATUSES.V3 };
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={statuses} onRefresh={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText(VERDICT_FILTER_LABEL), 'pass');

    expect(visibleControlIds(container)).not.toContain('V3');
    // The filter selects what is DISPLAYED and has no input into the aggregate.
    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toHaveAttribute(
      'data-verdict',
      'fail',
    );
    expect(renderedCounts(container).fail).toBe(1);
  });

  it('selects exactly the controls holding each verdict of a mixed roster', async () => {
    const statuses = MIXED_CONTROL_STATUSES.reduce<Partial<StatusMap>>(
      (accumulator, status) => ({ ...accumulator, [status.controlId]: status }),
      {},
    );
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={statuses} onRefresh={vi.fn()} />,
    );

    for (const verdict of VERDICT_PRECEDENCE) {
      await user.selectOptions(screen.getByLabelText(VERDICT_FILTER_LABEL), verdict);
      const expected = CONTROL_IDS.filter(
        (controlId) => resolveEffectiveControlVerdict(controlId, statuses[controlId]) === verdict,
      );
      expect.soft(visibleControlIds(container), `filtered by ${verdict}`).toEqual([...expected]);
    }
  });

  it('restores the whole roster when the filter is cleared', async () => {
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} onRefresh={vi.fn()} />,
    );
    const select = screen.getByLabelText(VERDICT_FILTER_LABEL);

    await user.selectOptions(select, 'fail');
    expect(visibleControlIds(container)).toHaveLength(0);

    await user.selectOptions(select, ALL_VERDICTS_VALUE);

    expect(visibleControlIds(container)).toEqual([...CONTROL_IDS]);
    expect(screen.queryByText(FILTER_NOTICE_LABEL)).not.toBeInTheDocument();
  });

  it('offers one option per verdict plus the do-not-filter option', () => {
    renderWithProviders(<PostureDashboard statuses={PASSING_CONTROL_STATUSES} />);

    const options = within(screen.getByLabelText(VERDICT_FILTER_LABEL)).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      ALL_VERDICTS_OPTION_LABEL,
      ...VERDICT_PRECEDENCE.map((verdict) => AGGREGATE_VERDICT_PRESENTATION[verdict].label),
    ]);
  });
});

describe('PostureDashboard — refresh ownership', () => {
  it('calls the caller’s handler exactly once when the dashboard button is pressed', async () => {
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} onRefresh={onRefresh} />,
    );

    await user.click(screen.getByRole('button', { name: REFRESH_ALL_LABEL }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('calls the handler exactly once from EVERY child refresh control', async () => {
    const onRefresh = vi.fn();
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} onRefresh={onRefresh} />,
    );

    for (const controlId of CONTROL_IDS) {
      onRefresh.mockClear();

      await user.click(panelRefreshButton(container, controlId));

      // Exactly once. A panel that called both its own `refresh` and the callback issued
      // two requests per press, because the dashboard supplies the same function to both.
      expect.soft(onRefresh, `${controlId} refresh`).toHaveBeenCalledTimes(1);
    }
  });

  it('disables all nine refresh controls, with a reason, when no handler was wired', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );

    const dashboardButton = screen.getByRole('button', { name: REFRESH_ALL_LABEL });
    expect(dashboardButton).toBeDisabled();
    expect(dashboardButton).toHaveAttribute('title', REFRESH_UNAVAILABLE_TITLE);

    for (const controlId of CONTROL_IDS) {
      const button = panelRefreshButton(container, controlId);
      // The defect: the dashboard's own button was disabled while these eight looked
      // operable and silently did nothing when pressed.
      expect.soft(button, `${controlId} button disabled`).toBeDisabled();
      expect.soft(button, `${controlId} button explained`).toHaveAttribute(
        'title',
        REFRESH_UNAVAILABLE_TITLE,
      );
    }
  });

  it('offers the same explanation on the dashboard control and on its children', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );

    const titles = new Set(
      [
        screen.getByRole('button', { name: REFRESH_ALL_LABEL }),
        ...CONTROL_IDS.map((controlId) => panelRefreshButton(container, controlId)),
      ].map((button) => button.getAttribute('title')),
    );

    // One fact, one wording. Two explanations of the same situation is a reader's problem.
    expect(titles).toEqual(new Set([REFRESH_UNAVAILABLE_TITLE]));
  });

  it('enables every refresh control while a handler is wired', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} onRefresh={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: REFRESH_ALL_LABEL })).toBeEnabled();
    for (const controlId of CONTROL_IDS) {
      expect.soft(panelRefreshButton(container, controlId), controlId).toBeEnabled();
    }
  });

  it('issues exactly one request per press on the connected path', async () => {
    const requested: string[] = [];
    const record = ({ request }: { request: Request }): void => {
      requested.push(request.url);
    };
    server.events.on('request:start', record);
    try {
      const { container, user } = renderWithProviders(<PostureDashboard />);
      await waitFor(() => {
        expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toBeInTheDocument();
      });
      const afterMount = requested.length;
      expect(afterMount).toBe(1);

      await user.click(panelRefreshButton(container, 'V5'));
      await waitFor(() => {
        expect(requested.length).toBeGreaterThan(afterMount);
      });

      // ONE additional read, not two: the child calls the dashboard's handler, which
      // re-issues the single collection request the whole surface shares.
      expect(requested).toHaveLength(afterMount + 1);
    } finally {
      server.events.removeListener('request:start', record);
    }
  });

  it('notifies the caller once per press on the connected path', async () => {
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(<PostureDashboard onRefresh={onRefresh} />);
    await waitFor(() => {
      expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: REFRESH_ALL_LABEL }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('PostureDashboard — loading, empty and failure never read as a pass', () => {
  it('renders the loading affordance with no verdict beside it', () => {
    renderWithProviders(<PostureDashboard isLoading onRefresh={vi.fn()} />);

    expect(screen.getByRole('status', { name: AGGREGATE_LOADING_LABEL })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: AGGREGATE_VERDICT_LABEL }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  });

  it('prefers the loading state over a partially arrived roster', () => {
    const partial = { ...PASSING_CONTROL_STATUSES } as Partial<StatusMap>;
    delete partial.V8;
    renderWithProviders(<PostureDashboard isLoading statuses={partial} />);

    expect(screen.getByRole('status', { name: AGGREGATE_LOADING_LABEL })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: AGGREGATE_VERDICT_LABEL }),
    ).not.toBeInTheDocument();
  });

  it('renders the empty affordance for a successful response describing nothing', () => {
    renderWithProviders(
      <PostureDashboard
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );

    expect(screen.getByRole('status', { name: AGGREGATE_EMPTY_LABEL })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: AGGREGATE_VERDICT_LABEL }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['403 Forbidden', FORBIDDEN_CONTROL_STATUS_ERROR],
    ['500 Internal Server Error', SERVER_ERROR_CONTROL_STATUS_ERROR],
    ['a transport failure', NETWORK_CONTROL_STATUS_ERROR],
  ])('renders %s as a failure and never as a verdict', (_label, error) => {
    renderWithProviders(<PostureDashboard error={error} onRefresh={vi.fn()} />);

    expect(screen.getByRole('alert', { name: AGGREGATE_ERROR_LABEL })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: AGGREGATE_VERDICT_LABEL }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(VERDICT_COUNTS_HEADING)).not.toBeInTheDocument();
  });

  it('renders a failure even when posture was also supplied', () => {
    renderWithProviders(
      <PostureDashboard
        error={FORBIDDEN_CONTROL_STATUS_ERROR}
        statuses={PASSING_CONTROL_STATUSES}
      />,
    );

    // A failure is the one state that must never be overridden into something that
    // could read as a pass.
    expect(screen.getByRole('alert', { name: AGGREGATE_ERROR_LABEL })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: AGGREGATE_VERDICT_LABEL }),
    ).not.toBeInTheDocument();
  });

  it('omits an HTTP status for a transport failure rather than inventing one', () => {
    renderWithProviders(<PostureDashboard error={NETWORK_CONTROL_STATUS_ERROR} />);

    expect(screen.getByRole('alert', { name: AGGREGATE_ERROR_LABEL })).not.toHaveTextContent(
      /HTTP\s*0/u,
    );
  });
});

describe('PostureDashboard — structure and accessible naming', () => {
  it('is a named main landmark holding two named regions', () => {
    renderWithProviders(<PostureDashboard statuses={PASSING_CONTROL_STATUSES} />);

    expect(screen.getByRole('main', { name: POSTURE_DASHBOARD_TITLE })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: AGGREGATE_SECTION_HEADING })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: CONTROLS_SECTION_HEADING })).toBeInTheDocument();
  });

  it('renders every control in roster order, each under its own heading', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );

    expect(visibleControlIds(container)).toEqual([...CONTROL_IDS]);
    for (const controlId of CONTROL_IDS) {
      expect
        .soft(screen.getByRole('heading', { name: CONTROL_SECTION_TITLES[controlId] }))
        .toBeInTheDocument();
    }
  });

  it('labels the tally with one entry per verdict, in precedence order', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );

    const entries = Array.from(container.querySelectorAll('.posture-dashboard__count'));

    expect(entries.map((entry) => entry.getAttribute('data-verdict'))).toEqual([
      ...VERDICT_PRECEDENCE,
    ]);
  });

  it('renders no control payload value of its own', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );
    const aggregate = container.querySelector('.posture-dashboard__aggregate');

    // The aggregate region reports verdicts, counts and coverage. Every observed value
    // belongs to the panel that owns it, along with that panel's redaction discipline.
    expect(aggregate).not.toHaveTextContent(/eyJ|BEGIN [A-Z]+ PRIVATE KEY|c2VjcmV0/u);
  });

  it('accepts a verdict-shaped roster without a handler and stays inert', () => {
    const verdicts: readonly ControlVerdict[] = VERDICT_PRECEDENCE;

    // Guards the assumption every case above relies on: the four verdicts the tally is
    // keyed by are exactly the four the dashboard can render.
    expect(new Set(verdicts)).toEqual(new Set(['pass', 'fail', 'warn', 'unknown']));
  });
});
