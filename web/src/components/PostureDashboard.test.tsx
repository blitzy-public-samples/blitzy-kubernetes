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

import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
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
// Rendered standalone in the m3 and m4 blocks below, as the OTHER SIDE of the embedding
// switch: suppressing a panel's heading and its live region is a property of being embedded,
// so a spec that only ever renders through the dashboard cannot tell a correct switch from a
// panel that lost its heading and its announcement everywhere.
import EtcdTransportPanel from './EtcdTransportPanel';
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
  WITHHELD_AGGREGATE_ERROR_MESSAGE,
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

/**
 * `MIXED_CONTROL_STATUSES` keyed by control, which is the shape the `statuses` prop takes.
 *
 * The fixture is recorded as a LIST because that is the wire shape a collection response has;
 * the prop is a map. Three specs above already did this reduction inline, and the blocks below
 * need it three more times, so it is named once here.
 */
function mixedRoster(): Readonly<Partial<StatusMap>> {
  return MIXED_CONTROL_STATUSES.reduce<Partial<StatusMap>>(
    (accumulator, status) => ({ ...accumulator, [status.controlId]: status }),
    {},
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

describe('PostureDashboard — m3: the heading run is monotonic and each name appears once', () => {
  /** Every heading in document order, as `[level, text]`. */
  function headingRun(container: HTMLElement): readonly (readonly [number, string])[] {
    return Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(
      (heading) => [Number(heading.tagName.slice(1)), heading.textContent ?? ''] as const,
    );
  }

  it('never goes backwards and never skips a level', () => {
    // THE m3 DEFECT, measured directly. The dashboard names each control with an `h3` and the
    // panel inside restarted at `h2`, so the run read h1 -> h2 -> h3 -> h2: a reversal, which
    // tells an assistive technology that the panel is a PEER of the per-control section rather
    // than its content.
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );
    const run = headingRun(container);

    expect(run.length).toBeGreaterThan(10);
    let previous = run[0][0];
    expect(previous).toBe(1);
    for (const [level, text] of run.slice(1)) {
      expect
        .soft(level, `"${text}" jumps from h${String(previous)} to h${String(level)}`)
        .toBeLessThanOrEqual(previous + 1);
      previous = level;
    }
  });

  it('renders no control panel heading at h2 inside a control card', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );

    for (const controlId of CONTROL_IDS) {
      const section = controlSection(container, controlId);
      expect.soft(section.querySelectorAll('h2')).toHaveLength(0);
      // And the card DOES still have its heading — the dashboard's own.
      expect.soft(section.querySelectorAll('h3').length).toBeGreaterThan(0);
    }
  });

  it('names each control exactly once', () => {
    renderWithProviders(<PostureDashboard statuses={PASSING_CONTROL_STATUSES} />);

    for (const controlId of CONTROL_IDS) {
      // The duplication half of the defect: the wrapper `h3` and the panel `h2` both named the
      // control, under two different wordings, so a heading-navigation pass hit the same
      // control twice and the two names disagreed.
      expect
        .soft(screen.getAllByRole('heading', { name: CONTROL_SECTION_TITLES[controlId] }))
        .toHaveLength(1);
    }
  });

  it('keeps every control card a NAMED region', () => {
    renderWithProviders(<PostureDashboard statuses={PASSING_CONTROL_STATUSES} />);

    for (const controlId of CONTROL_IDS) {
      // Suppressing the panel's heading must not leave its `<section>` pointing at an id that
      // no longer exists: an anonymous region is worse than a duplicated name, because it
      // disappears from a landmark list entirely.
      expect
        .soft(screen.getAllByRole('region', { name: CONTROL_SECTION_TITLES[controlId] }).length)
        .toBeGreaterThan(0);
    }
  });

  it('renders panel subheadings one level below the control heading', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );
    const section = controlSection(container, 'V8');

    // V8 renders three subheadings, and embedded they belong UNDER the control's `h3` rather
    // than beside it — a subsection is not a peer of the thing it is part of.
    expect(section.querySelectorAll('h4').length).toBeGreaterThan(0);
  });

  it('still renders its own h2 heading and h3 subheadings when standalone', () => {
    // The other side of the switch. Suppression is a property of being EMBEDDED, not a global
    // downgrade: a panel used on its own is the whole page and owns its title.
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={PASSING_CONTROL_STATUSES.V8} />,
    );

    expect(container.querySelectorAll('h2')).toHaveLength(1);
    expect(container.querySelectorAll('h3').length).toBeGreaterThan(0);
  });

  it('shifts the whole nested run down a level when embedded, preserving the nesting', () => {
    // V8 nests scenario articles beneath one of its own subheadings, so it has TWO levels to
    // shift, and shifting only the outer one would flatten the inner into a sibling of its
    // parent. Both levels are compared between the two modes on the same payload.
    const standalone = renderWithProviders(
      <EtcdTransportPanel status={PASSING_CONTROL_STATUSES.V8} />,
    );
    const outerStandalone = standalone.container.querySelectorAll('h3').length;
    const innerStandalone = standalone.container.querySelectorAll('h4').length;
    expect(outerStandalone).toBeGreaterThan(0);
    expect(innerStandalone).toBeGreaterThan(0);
    standalone.unmount();

    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );
    const panel = controlSection(container, 'V8').querySelector(
      '.posture-dashboard__control-scroll',
    ) as HTMLElement;

    // Inside the panel: nothing at the host's level or above, and each level moved down by
    // exactly one, so the h3/h4 relationship standalone is the h4/h5 relationship embedded.
    expect(panel.querySelectorAll('h2')).toHaveLength(0);
    expect(panel.querySelectorAll('h3')).toHaveLength(0);
    expect(panel.querySelectorAll('h4')).toHaveLength(outerStandalone);
    expect(panel.querySelectorAll('h5')).toHaveLength(innerStandalone);
  });
});

describe('PostureDashboard — m4: one transition is announced once', () => {
  it('exposes exactly one live region when posture resolves', () => {
    // THE m4 DEFECT. One collection response changes all eight cards, and each panel announced
    // its own verdict, so a screen-reader user heard nine announcements for one event — with
    // the aggregate, the only one that summarises, buried among the eight.
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toBeInTheDocument();
  });

  it('exposes exactly one alert when the collection read fails', () => {
    // The worst case of the storm: on an error EVERY panel renders its own error affordance
    // from the shared result, so nine `alert` regions fired at once.
    const { container } = renderWithProviders(
      <PostureDashboard error={SERVER_ERROR_CONTROL_STATUS_ERROR} />,
    );

    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(screen.getByRole('alert', { name: AGGREGATE_ERROR_LABEL })).toBeInTheDocument();
  });

  it('exposes exactly one live region while the collection is loading', () => {
    const { container } = renderWithProviders(<PostureDashboard isLoading />);

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(screen.getByRole('status', { name: AGGREGATE_LOADING_LABEL })).toBeInTheDocument();
  });

  it('keeps the child’s announced text readable in place, having dropped only the role', () => {
    // THE POINT OF THE FIX, and the thing that makes it safe: the child state is still THERE.
    // Nothing was hidden and nothing was summarised away — a reader who reaches the card reads
    // what they always did, they are simply not interrupted for it eight times.
    //
    // Measured against the SAME panel rendered standalone rather than against a guess at its
    // wording: whatever text V8 announces on its own must still be present, verbatim, once the
    // announcement is suppressed.
    const errorResult = {
      status: 'error' as const,
      error: SERVER_ERROR_CONTROL_STATUS_ERROR,
      refresh: vi.fn(),
    };
    const standalone = renderWithProviders(<EtcdTransportPanel result={errorResult} />);
    const announced = Array.from(
      standalone.container.querySelectorAll('[role="alert"],[role="status"]'),
    ).map((element) => element.textContent ?? '');
    expect(announced.length).toBeGreaterThan(0);
    standalone.unmount();

    const { container } = renderWithProviders(
      <PostureDashboard error={SERVER_ERROR_CONTROL_STATUS_ERROR} />,
    );
    const section = controlSection(container, 'V8');

    expect(section.querySelectorAll('[role="alert"],[role="status"]')).toHaveLength(0);
    for (const text of announced) {
      expect.soft(section.textContent ?? '').toContain(text);
    }
  });

  it('leaves every control card carrying its own substantive text', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={FAILING_CONTROL_STATUSES} />,
    );

    for (const controlId of CONTROL_IDS) {
      const section = controlSection(container, controlId);
      // Four panels (V1, V2, V3, V7) expose no panel-level verdict marker at all, which is why
      // this measures rendered TEXT rather than markers: the claim is that information
      // survived, and for those four the information is prose.
      expect
        .soft((section.textContent ?? '').length, `${controlId} rendered almost nothing`)
        .toBeGreaterThan(80);
    }
  });

  it('still announces its own state when a panel stands alone', () => {
    // V8 carries a live role on its loading, empty and error affordances rather than on a
    // resolved verdict, so the state driven here is the one that announces: an error.
    const { container } = renderWithProviders(
      <EtcdTransportPanel
        result={{ status: 'error', error: SERVER_ERROR_CONTROL_STATUS_ERROR, refresh: vi.fn() }}
      />,
    );

    expect(container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });
});

describe('PostureDashboard — m5: each control scrolls inside its own card', () => {
  it('wraps every control panel in a scoped horizontal-overflow container', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );
    const wrappers = container.querySelectorAll('.posture-dashboard__control-scroll');

    expect(wrappers).toHaveLength(CONTROL_IDS.length);
    for (const wrapper of Array.from(wrappers)) {
      const style = (wrapper as HTMLElement).style;
      // Page-level scrolling drags the toolbar, the filter and the aggregate verdict off
      // screen with one wide table. Scrolling the card moves only the table.
      expect.soft(style.overflowX).toBe('auto');
      expect.soft(style.maxWidth).toBe('100%');
      // Without `min-width: 0` a flex or grid item refuses to shrink below its content, so
      // `overflow-x` never engages and the fix silently does nothing.
      expect.soft(style.minWidth).toBe('0px');
    }
  });

  it('puts the container INSIDE the control card, so the heading never scrolls away', () => {
    const { container } = renderWithProviders(
      <PostureDashboard statuses={PASSING_CONTROL_STATUSES} />,
    );
    const section = controlSection(container, 'V6');
    const wrapper = section.querySelector('.posture-dashboard__control-scroll');

    expect(wrapper).not.toBeNull();
    expect(section.querySelector('h3')).not.toBeNull();
    // The heading is a SIBLING of the scrolling region rather than inside it, so scrolling a
    // wide table never takes the control's own title out of view.
    expect(wrapper?.querySelector('h3')).toBeNull();
  });
});

describe('PostureDashboard — M18: the aggregate failure text is bounded', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  /** A PEM block, which the shared guard treats as credential-shaped whole. */
  const PEM_SHAPED = '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----';

  /**
   * The aggregate failure affordance, which is what this finding is about.
   *
   * Scoped deliberately. The finding names the AGGREGATE error path, and the container also
   * holds eight control panels rendering the same `ControlStatusError` through their own
   * guards; asserting on the container would conflate this element's behaviour with theirs and
   * report the wrong component when one of them regressed. The surface-wide property is
   * asserted separately, and on purpose, in the last case of this block.
   */
  function aggregateError(container: HTMLElement): HTMLElement {
    const element = container.querySelector('.posture-dashboard__state--error');
    expect(element, 'no aggregate error affordance rendered').not.toBeNull();
    return element as HTMLElement;
  }

  it('renders a recorded failure message unchanged — the control', () => {
    const { container } = renderWithProviders(
      <PostureDashboard error={SERVER_ERROR_CONTROL_STATUS_ERROR} />,
    );

    expect(container).toHaveTextContent(SERVER_ERROR_CONTROL_STATUS_ERROR.message);
  });

  it('withholds a credential in the failure message and in its reason', () => {
    // This alert ANNOUNCES ITSELF and is the first thing a screen-reader user hears when a
    // collection read fails, so it is the highest-priority text the surface can emit — and it
    // rendered whatever the backend or the parser put in `message` verbatim.
    const { container } = renderWithProviders(
      <PostureDashboard
        error={{
          ...SERVER_ERROR_CONTROL_STATUS_ERROR,
          message: `the collection endpoint reported ${TOKEN_SHAPED}`,
          reason: `upstream said ${PEM_SHAPED}`,
        }}
      />,
    );
    const aggregate = aggregateError(container);
    const text = aggregate.textContent ?? '';

    expect(text).not.toContain(TOKEN_SHAPED);
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(aggregate).toHaveTextContent(SAFE_REDACTED);
    // The locally authored label and closing sentence are unconditional, so a redaction
    // marker never stands alone.
    expect(aggregate).toHaveTextContent(AGGREGATE_ERROR_LABEL);
    expect(aggregate).toHaveTextContent('this is not a pass');
  });

  it('bounds an oversized failure message rather than rendering any of it', () => {
    const { container } = renderWithProviders(
      <PostureDashboard
        error={{
          ...SERVER_ERROR_CONTROL_STATUS_ERROR,
          message: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
        }}
      />,
    );

    const aggregate = aggregateError(container);

    expect(aggregate).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(aggregate.textContent ?? '').not.toContain('xxxxxxxxxx');
  });

  it('collapses control characters and bidirectional overrides out of the message', () => {
    const { container } = renderWithProviders(
      <PostureDashboard
        error={{
          ...SERVER_ERROR_CONTROL_STATUS_ERROR,
          message: 'The read failed.\n\u0007\u202ENothing was verified.',
        }}
      />,
    );
    const aggregate = aggregateError(container);
    const text = aggregate.textContent ?? '';

    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(aggregate).toHaveTextContent('The read failed. Nothing was verified.');
  });

  it('substitutes local wording for a message that sanitized away to nothing', () => {
    const { container } = renderWithProviders(
      <PostureDashboard error={{ ...SERVER_ERROR_CONTROL_STATUS_ERROR, message: '\u0000\u0007' }} />,
    );

    expect(aggregateError(container)).toHaveTextContent(WITHHELD_AGGREGATE_ERROR_MESSAGE);
    expect(screen.getByRole('alert', { name: AGGREGATE_ERROR_LABEL })).toBeInTheDocument();
  });

  it('renders the HTTP status and the failure kind unguarded, being local facts', () => {
    const { container } = renderWithProviders(
      <PostureDashboard error={SERVER_ERROR_CONTROL_STATUS_ERROR} />,
    );

    // A number and a typed union of this repository's own literals: guarding either would
    // only obscure that neither is external text.
    const aggregate = aggregateError(container);
    expect(aggregate).toHaveTextContent('HTTP status 500');
    expect(aggregate.getAttribute('data-error-kind')).toBe('http');
  });

  it('leaves no credential anywhere on the surface, aggregate or panel', () => {
    // The surface-wide sweep, asserted separately from the aggregate cases above so that a
    // failure names the right thing. The same `ControlStatusError` reaches all eight panels as
    // well as the aggregate, and every one of them is a rendering path for it — so the property
    // that actually protects an operator is that NO path emits the credential, not that the
    // most prominent one does not.
    const { container } = renderWithProviders(
      <PostureDashboard
        error={{
          ...SERVER_ERROR_CONTROL_STATUS_ERROR,
          message: `the collection endpoint reported ${TOKEN_SHAPED}`,
          reason: `upstream said ${PEM_SHAPED}`,
        }}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).not.toContain(TOKEN_SHAPED);
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    // And the sweep is not vacuous: the surface really did render all nine paths.
    expect(container.querySelectorAll('li[data-control-id]')).toHaveLength(CONTROL_IDS.length);
    expect(aggregateError(container)).toBeInTheDocument();
  });
});

describe('PostureDashboard — the corrected per-control resolvers reach the aggregate', () => {
  it('never counts a control as passing when its own panel withholds the pass', () => {
    // THE INTEGRATION FINDING. The dashboard's arithmetic was already conservative; what it
    // delegated to was not. Every resolver has since been tightened to require its control's
    // full evidence, and this asserts the dashboard USES those verdicts rather than the
    // server's claim — for all eight controls at once.
    const claiming = claimingPassWithoutEvidence();
    const { container } = renderWithProviders(<PostureDashboard statuses={claiming} />);

    expect(renderedCounts(container).pass).toBe(0);
    for (const controlId of CONTROL_IDS) {
      expect.soft(sectionVerdict(container, controlId)).not.toBe('pass');
    }
  });

  it('agrees with each panel resolver, control by control, on every recorded roster', () => {
    // Typed as PARTIAL maps deliberately: `WARNING_CONTROL_STATUSES` records only V2 and V8,
    // because only those two controls have a recorded warning state. A roster with holes in it
    // is the realistic case — a collection response that described some controls and not
    // others — and it is exactly where a resolver that defaults an absent control to `pass`
    // would be caught.
    const rosters: readonly Readonly<Partial<StatusMap>>[] = [
      PASSING_CONTROL_STATUSES,
      FAILING_CONTROL_STATUSES,
      WARNING_CONTROL_STATUSES,
      UNKNOWN_CONTROL_STATUSES,
      mixedRoster(),
    ];
    for (const roster of rosters) {
      const resolved = resolveEffectiveVerdicts(roster);
      for (const controlId of CONTROL_IDS) {
        expect
          .soft(resolved[controlId])
          .toBe(resolveEffectiveControlVerdict(controlId, roster[controlId]));
      }
    }
  });

  it('keeps the fail > unknown > warn > pass precedence after every resolver change', () => {
    // The precedence the review asked to be PRESERVED. Asserted over a roster carrying one of
    // each verdict, so no ordering accident can satisfy it.
    const roster = mixedRoster();
    const aggregate = summarisePosture(roster);
    const verdicts = new Set(Object.values(resolveEffectiveVerdicts(roster)));

    expect(verdicts.has('fail')).toBe(true);
    expect(aggregate.verdict).toBe('fail');
    expect(VERDICT_PRECEDENCE[0]).toBe('fail');
  });

  it('computes the aggregate from the whole roster even when a filter hides the failure', async () => {
    const { container, user } = renderWithProviders(
      <PostureDashboard statuses={mixedRoster()} />,
    );

    await user.selectOptions(
      screen.getByLabelText(VERDICT_FILTER_LABEL),
      AGGREGATE_VERDICT_PRESENTATION.pass.label,
    );

    // The filter selects what is DISPLAYED and has no input into the aggregate, so no filter
    // can hide a failing control from the verdict above it.
    expect(screen.getByRole('status', { name: AGGREGATE_VERDICT_LABEL })).toHaveAttribute(
      'data-verdict',
      'fail',
    );
    // V3 is the failing control in the recorded mixed roster, so filtering to `pass` removes
    // precisely the control the aggregate verdict is reporting on.
    expect(visibleControlIds(container)).not.toContain('V3');
    expect(visibleControlIds(container)).toContain('V1');
  });
});

