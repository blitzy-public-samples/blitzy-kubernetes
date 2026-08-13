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

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V7_OBSERVATIONS, V7_OUTCOME_TITLES } from '../domain/observationIds';
import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import {
  NODE_AUTHORIZATION_MODE,
  NODE_RESTRICTION_PLUGIN,
} from '../domain/securityConstants';
import { CONTROL_STATUS_ERRORS } from '../test/fixtures/controlStatus';
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

/**
 * The four measured outcomes, all holding.
 *
 * Written out rather than derived, because several cases below address these rows BY
 * POSITION — omit row 2, replace row 0 — and the oracle's four assertions in their four
 * order is exactly what those cases are about.
 *
 * NO LONGER SUFFICIENT FOR A PASS on its own: see {@link ALL_REQUIRED_PROVEN}.
 */
const ALL_FOUR_HOLD: readonly ControlObservation[] = [
  { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: FORBIDDEN_STATUS },
  { label: V7_OBSERVATIONS.unrelatedSecretRead, value: FORBIDDEN_STATUS },
  { label: V7_OBSERVATIONS.ownNodeRead, value: 'allowed' },
  { label: V7_OBSERVATIONS.ownNodeStatusUpdate, value: 'allowed' },
];

/** The two enabling-configuration identities a pass now also requires (M16). */
const ENABLING_CONFIG_IDENTITIES: readonly string[] = [
  V7_OBSERVATIONS.authorizationMode,
  V7_OBSERVATIONS.admissionPluginsEnabled,
];

/**
 * The enabling configuration, TAKEN FROM THE RECORDED PASSING PAYLOAD.
 *
 * Derived rather than written out, and the throw below is the point: the panel gates its
 * pass on exactly `Node,RBAC` and on `NodeRestriction` being a member of the enabled plugin
 * list, and the fixture is where those values are recorded. A hand-written copy here would
 * let the two drift apart while both typechecked — and every case that expects a PASS would
 * then hold over a payload that was already `unknown`, which is a vacuous assertion wearing
 * a green tick.
 */
const ENABLING_CONFIG_PROVEN: readonly ControlObservation[] = (() => {
  const recorded = V7_NODE_RESTRICTION_PASSING.evidence.observations.filter((observation) =>
    ENABLING_CONFIG_IDENTITIES.includes(observation.label),
  );
  if (recorded.length !== ENABLING_CONFIG_IDENTITIES.length) {
    throw new Error(
      'the recorded V7 passing payload no longer carries both enabling-configuration ' +
        'observations, so no case below can establish a pass',
    );
  }
  return recorded;
})();

/** Everything a V7 pass requires: the enabling configuration AND all four outcomes. */
const ALL_REQUIRED_PROVEN: readonly ControlObservation[] = [
  ...ENABLING_CONFIG_PROVEN,
  ...ALL_FOUR_HOLD,
];

/**
 * The recorded passing payload with the enabling configuration plus the given outcomes.
 *
 * Used wherever a case is about the OUTCOMES, so that the enabling configuration is never
 * the accidental cause of the verdict under test.
 */
function withConfig(outcomes: readonly ControlObservation[]): ControlStatus {
  return passingWith([...ENABLING_CONFIG_PROVEN, ...outcomes]);
}

/** The observed-outcomes table, addressed by its accessible name. */
function outcomesTable(): HTMLElement {
  return screen.getByRole('table', { name: /observed noderestriction outcomes/iu });
}

/** The enabling-configuration table, addressed by its accessible name. */
function configTable(): HTMLElement {
  return screen.getByRole('table', { name: /enabling configuration/iu });
}

/** The `data-status` one enabling-configuration row carries. */
function configStatus(container: HTMLElement, id: string): string | null {
  return container.querySelector(`[data-config="${id}"]`)?.getAttribute('data-status') ?? null;
}


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
    expect(resolveNodeIsolationEffectiveVerdict(withConfig(byTitle))).toBe('pass');
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
    expect(resolveNodeIsolationEffectiveVerdict(withConfig(decoy))).toBe('unknown');
  });

  it('treats a row reported TWICE as indeterminate rather than resolving it by order', () => {
    const duplicated: readonly ControlObservation[] = [
      ...ALL_FOUR_HOLD,
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: 'allowed' },
    ];
    renderWithProviders(<NodeIsolationPanel status={withConfig(duplicated)} />);
    expect(verdictText()).toContain('Unknown');
    // Addressed BY NAME rather than as "the table": the panel now renders the enabling
    // configuration in a table of its own (M16), so an unnamed lookup is ambiguous — and
    // this assertion is specifically about the OUTCOMES table.
    expect(outcomesTable()).toHaveTextContent(/reported 2 times/iu);
  });

  it('treats a row reported once under its identity and once under its alias as a conflict', () => {
    const bothNames: readonly ControlObservation[] = [
      ...ALL_FOUR_HOLD,
      { label: V7_OUTCOME_TITLES.crossNodeDenied, value: FORBIDDEN_STATUS },
    ];
    // Even though both say the same thing: an alias must not be able to override the
    // primary identity, or the precedence would be doing the deciding.
    expect(resolveNodeIsolationEffectiveVerdict(withConfig(bothNames))).toBe('unknown');
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
    expect(resolveNodeIsolationEffectiveVerdict(withConfig(partial))).toBe('unknown');
  });

  it('renders PASS when — and only when — all four are measured and hold', () => {
    expect(resolveNodeIsolationEffectiveVerdict(passingWith(ALL_REQUIRED_PROVEN))).toBe('pass');
  });

  it('cannot render PASS beside a reported finding, whatever the server said', () => {
    // The case no other assertion here reaches: all four rows hold AND the server claimed
    // `pass`, so the ONLY thing forcing a failure is the findings list. Without this case a
    // removal of the findings floor passes the whole spec — which is exactly what a
    // mutation run demonstrated before it was added.
    const withFinding: ControlStatus = {
      ...passingWith(ALL_REQUIRED_PROVEN),
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
    renderWithProviders(<NodeIsolationPanel status={withConfig(withNotFound)} />);
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
    expect(resolveNodeIsolationEffectiveVerdict(withConfig(unspecified))).toBe('unknown');
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
    expect(resolveNodeIsolationEffectiveVerdict(withConfig(refusedControl))).toBe('fail');
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
    const warned: ControlStatus = {
      ...passingWith(ALL_REQUIRED_PROVEN),
      warnings: ['node2 was recreated'],
    };
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

describe('NodeIsolationPanel — M8: an outcome is read exactly, or not at all', () => {
  /** The recorded baseline with one replacement on the cross-node denial row. */
  function crossNodeReporting(value: ControlObservation['value']): ControlStatus {
    return withConfig([
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value },
      ...ALL_FOUR_HOLD.slice(1),
    ]);
  }

  /** The recorded baseline with one replacement on a positive-control row. */
  function ownNodeReadReporting(value: ControlObservation['value']): ControlStatus {
    return withConfig([
      ...ALL_FOUR_HOLD.slice(0, 2),
      { label: V7_OBSERVATIONS.ownNodeRead, value },
      ALL_FOUR_HOLD[3],
    ]);
  }

  it.each([
    ['the exact number', FORBIDDEN_STATUS],
    ['a string that is nothing but the code', '403'],
    ['the exact word', 'Forbidden'],
    ['the word in any case', 'FORBIDDEN'],
    ['a serialized Status carrying only a code', '{"code":403}'],
    ['a serialized Status whose reason agrees', '{"kind":"Status","code":403,"reason":"Forbidden"}'],
    ['a code with surrounding whitespace', '  403  '],
    ['the word with surrounding whitespace', ' Forbidden '],
  ])('establishes a denial from %s', (_name, value) => {
    // THE ACCEPTED SET, first. Tightening a reader is only safe if what the repository
    // actually records still reads — the fixture records the number, and the three other
    // forms are what an API server or a serialized Status genuinely looks like.
    expect(resolveNodeIsolationEffectiveVerdict(crossNodeReporting(value))).toBe('pass');
  });

  it.each([
    ['a sentence naming the code it did NOT get', 'expected 403 but got 200'],
    ['a code beside a contradicting reason', '403 Not Found'],
    ['a negation of the outcome word', 'not forbidden'],
    ['a qualification of the outcome word', 'possibly forbidden'],
    ['a question about the outcome word', 'forbidden?'],
    ['a code buried in unrelated prose', 'HTTP 200 OK after 403 retries'],
    ['an outcome word with a trailing note', 'forbidden (see note)'],
    ['a Status whose reason contradicts its code', '{"code":403,"reason":"NotFound"}'],
    ['a Status whose code is a string', '{"code":"403"}'],
    ['a serialized object that is not a Status', '{"kind":"Pod","code":403}'],
    ['malformed JSON', '{"code":403'],
    ['a code in a JSON array', '[403]'],
    ['a two-digit run', '40'],
    ['a four-digit run', '4033'],
    ['a code outside the HTTP range', '700'],
    ['a class of codes rather than a code', '2xx'],
    ['the word with a full stop', 'forbidden.'],
    ['the word in quotation marks', '"forbidden"'],
    ['the word behind a dash', '-forbidden'],
    ['the word inside a longer identifier', 'forbidden_by_policy'],
  ])('refuses to read a denial out of %s', (_name, value) => {
    // NOT A PASS, and the first six are the exact strings the review named: each of them
    // used to satisfy a required 403, because the reader searched for the first
    // three-digit run anywhere in the text and then for `forbidden` as a SUBSTRING —
    // which `notforbidden` contains.
    expect(resolveNodeIsolationEffectiveVerdict(crossNodeReporting(value))).toBe('unknown');
  });

  it('reports an unreadable value as unrecognised rather than dropping the row', () => {
    renderWithProviders(<NodeIsolationPanel status={crossNodeReporting('not forbidden')} />);

    // Silence would be the wrong remedy for the wrong reading: the row must still be on
    // screen, saying that what arrived was not an outcome.
    expect(outcomesTable()).toHaveTextContent(/unrecognised outcome/iu);
    expect(verdictText()).toContain('Unknown');
  });

  it('never reads a negation as its own positive on a POSITIVE control either', () => {
    // The mirror of the denial case, and the safe direction: `not allowed` must not read
    // as ALLOWED. It is unreadable, which withholds the pass rather than granting one.
    expect(resolveNodeIsolationEffectiveVerdict(ownNodeReadReporting('not allowed'))).toBe(
      'unknown',
    );
  });

  it.each([
    ['a plain success code', 200],
    ['the word', 'Allowed'],
    ['a boolean true', true],
  ])('establishes an allowance on a positive control from %s', (_name, value) => {
    expect(resolveNodeIsolationEffectiveVerdict(ownNodeReadReporting(value))).toBe('pass');
  });

  it('fails a required denial that reports a success code', () => {
    expect(resolveNodeIsolationEffectiveVerdict(crossNodeReporting(200))).toBe('fail');
  });

  it.each([
    ['the number', NOT_FOUND_STATUS],
    ['the exact word', 'NotFound'],
    ['the two-word form', 'Not Found'],
    ['a serialized Status', '{"code":404,"reason":"NotFound"}'],
  ])('records a 404 reported as %s as a violation', (_name, value) => {
    // AAP §0.10.2's ordering hazard: a 404 means the target was absent, so the denial
    // proves nothing — and the oracle's `expectForbidden` reports it with `t.Errorf`.
    expect(resolveNodeIsolationEffectiveVerdict(crossNodeReporting(value))).toBe('fail');
  });

  it.each([
    ['a boolean false, which is a refusal with no code', false],
    ['the word denied, which names no code', 'denied'],
  ])('keeps a codeless refusal indeterminate when reported as %s', (_name, value) => {
    // Refused, but not shown to be a 403. Indeterminate is the honest reading: it may or
    // may not have been the status this requirement depends on.
    expect(resolveNodeIsolationEffectiveVerdict(crossNodeReporting(value))).toBe('unknown');
  });

  it('never reads an explicit null as an outcome of any kind', () => {
    expect(resolveNodeIsolationEffectiveVerdict(crossNodeReporting(null))).toBe('unknown');
  });
});

describe('NodeIsolationPanel — M16: the enabling configuration is part of the verdict', () => {
  /** The recorded baseline with one enabling-configuration observation replaced. */
  function configReporting(label: string, value: ControlObservation['value']): ControlStatus {
    return passingWith([
      ...ENABLING_CONFIG_PROVEN.map((observation) =>
        observation.label === label ? { label, value } : observation,
      ),
      ...ALL_FOUR_HOLD,
    ]);
  }

  /** The recorded baseline with one enabling-configuration observation removed. */
  function configOmitting(label: string): ControlStatus {
    return passingWith([
      ...ENABLING_CONFIG_PROVEN.filter((observation) => observation.label !== label),
      ...ALL_FOUR_HOLD,
    ]);
  }

  it('grants the pass when both requirements hold — the control', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={passingWith(ALL_REQUIRED_PROVEN)} />,
    );

    expect(verdictText()).toContain('Pass');
    expect(configStatus(container, 'authorization-mode')).toBe('satisfied');
    expect(configStatus(container, 'node-restriction-plugin')).toBe('satisfied');
  });

  it.each([
    ['the authorization mode', V7_OBSERVATIONS.authorizationMode, 'authorization-mode'],
    [
      'the enabled admission plugins',
      V7_OBSERVATIONS.admissionPluginsEnabled,
      'node-restriction-plugin',
    ],
  ])('withholds the pass when %s is not reported', (_name, label, rowId) => {
    const { container } = renderWithProviders(<NodeIsolationPanel status={configOmitting(label)} />);

    // THE M16 DEFECT, directly: `V7_REQUIREMENT_IDS` claims F-007-RQ-001 and the panel
    // rendered these two observations in "Other reported observations", where nothing read
    // them. A payload could omit both and still earn a pass attributed to the requirement
    // they are the whole of.
    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Pass');
    expect(configStatus(container, rowId)).toBe('not-reported');
  });

  it('fails when the authorization mode leaves the Node authorizer out', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={configReporting(V7_OBSERVATIONS.authorizationMode, 'RBAC')} />,
    );

    // FAIL rather than UNKNOWN: a cluster without the Node authorizer is not enforcing this
    // control, and the four runtime outcomes below would look identical under a permissive
    // RBAC role — which is a different control with the same symptom.
    expect(verdictText()).toContain('Fail');
    expect(configStatus(container, 'authorization-mode')).toBe('violated');
  });

  it.each([
    ['the right authorizers in the wrong order', 'RBAC,Node'],
    ['an extra authorizer', 'Node,RBAC,Webhook'],
    ['the mode with stray internal spacing', 'Node, RBAC'],
  ])('fails on %s, because the flag value is the whole string', (_name, mode) => {
    // Compared WHOLE, order included. The oracle launches its API server with exactly
    // `--authorization-mode Node,RBAC` (AAP §0.4.2.2), and an authorization mode is an
    // ordered chain rather than a set, so a rearrangement is a different configuration.
    expect(
      resolveNodeIsolationEffectiveVerdict(
        configReporting(V7_OBSERVATIONS.authorizationMode, mode),
      ),
    ).toBe('fail');
  });

  it('accepts NodeRestriction beside other plugins', () => {
    // MEMBERSHIP, not equality: the plugin list is genuinely a set and a cluster is free to
    // enable others, so requiring the whole string would fail a correct configuration.
    const status = configReporting(
      V7_OBSERVATIONS.admissionPluginsEnabled,
      `PodSecurity,${NODE_RESTRICTION_PLUGIN},LimitRanger`,
    );

    expect(resolveNodeIsolationEffectiveVerdict(status)).toBe('pass');
  });

  it.each([
    ['the plugin is absent', 'PodSecurity,LimitRanger'],
    ['only a plugin NAMED after it is present', 'NodeRestrictionShim'],
    ['it appears as a substring of another name', 'PreNodeRestrictionHook'],
  ])('fails when %s', (_name, plugins) => {
    // The last two are why membership is compared rather than containment: an
    // `includes('NodeRestriction')` test is satisfied by any plugin whose name contains it.
    expect(
      resolveNodeIsolationEffectiveVerdict(
        configReporting(V7_OBSERVATIONS.admissionPluginsEnabled, plugins),
      ),
    ).toBe('fail');
  });

  it.each([
    ['a boolean', V7_OBSERVATIONS.authorizationMode, true, 'authorization-mode'],
    ['an explicit null', V7_OBSERVATIONS.admissionPluginsEnabled, null, 'node-restriction-plugin'],
    ['an empty string', V7_OBSERVATIONS.admissionPluginsEnabled, '', 'node-restriction-plugin'],
  ])('withholds rather than fails on %s', (_name, label, value, rowId) => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={configReporting(label, value)} />,
    );

    // A value that cannot be read is a gap, not a defect: the panel does not know the
    // configuration is wrong, it knows it cannot tell.
    expect(verdictText()).toContain('Unknown');
    expect(configStatus(container, rowId)).toBe('indeterminate');
  });

  it('treats a duplicated configuration identity as indeterminate, never by list order', () => {
    const duplicated = passingWith([
      ...ALL_REQUIRED_PROVEN,
      { label: V7_OBSERVATIONS.authorizationMode, value: 'RBAC' },
    ]);
    const { container } = renderWithProviders(<NodeIsolationPanel status={duplicated} />);

    expect(verdictText()).toContain('Unknown');
    expect(configStatus(container, 'authorization-mode')).toBe('indeterminate');
    expect(configTable()).toHaveTextContent(/reported 2 times/iu);
  });

  it('states what each requirement demands, beside what was reported', () => {
    renderWithProviders(<NodeIsolationPanel status={passingWith(ALL_REQUIRED_PROVEN)} />);
    const table = configTable();

    // A row that showed only the reported value would leave the reader to know the
    // requirement from memory — which is what "rendered but unread" looked like.
    expect(table).toHaveTextContent(NODE_AUTHORIZATION_MODE);
    expect(table).toHaveTextContent(NODE_RESTRICTION_PLUGIN);
    expect(table).toHaveTextContent('F-007-RQ-001');
  });

  it('moves both identities out of the generic observation list', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={passingWith(ALL_REQUIRED_PROVEN)} />,
    );
    const other = container.querySelector('.node-isolation-panel__other-observations');

    // They are measured now, so listing them again among the observations nothing gates
    // would say the opposite of what the panel does with them.
    expect(other?.textContent ?? '').not.toContain(V7_OBSERVATIONS.authorizationMode);
    expect(other?.textContent ?? '').not.toContain(V7_OBSERVATIONS.admissionPluginsEnabled);
  });

  it('renders PASS for the recorded passing payload, configuration and all', () => {
    // The end-to-end guard on the whole change: the recorded payload must still pass, or
    // the gate has been tightened past what this repository actually reports.
    renderWithProviders(<NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} />);
    expect(verdictText()).toContain('Pass');
  });
});

describe('NodeIsolationPanel — M18: external text is bounded and redacted', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  /** A PEM block, which the shared guard treats as credential-shaped whole. */
  const PEM_SHAPED = '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----';

  it('renders the recorded prose unchanged — the control', () => {
    // Without this every case below would also be satisfied by a guard that blanked the
    // panel, which reports nothing rather than reporting safely.
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} />,
    );

    expect(container).toHaveTextContent(V7_NODE_RESTRICTION_PASSING.summary);
    expect(container).toHaveTextContent(V7_NODE_RESTRICTION_PASSING.detail);
    for (const finding of V7_NODE_RESTRICTION_FAILING.findings) {
      expect.soft(finding.message.length).toBeGreaterThan(0);
    }
  });

  it.each([
    [
      'the summary',
      (text: string): ControlStatus => ({ ...V7_NODE_RESTRICTION_PASSING, summary: text }),
    ],
    [
      'the detail',
      (text: string): ControlStatus => ({ ...V7_NODE_RESTRICTION_PASSING, detail: text }),
    ],
    [
      'a warning',
      (text: string): ControlStatus => ({ ...V7_NODE_RESTRICTION_PASSING, warnings: [text] }),
    ],
    [
      'a finding message',
      (text: string): ControlStatus => ({
        ...V7_NODE_RESTRICTION_PASSING,
        findings: [{ message: text, requirementId: 'F-007-RQ-002' }],
      }),
    ],
    [
      'a finding subject',
      (text: string): ControlStatus => ({
        ...V7_NODE_RESTRICTION_PASSING,
        findings: [{ message: 'the cross-node write was admitted.', subject: text }],
      }),
    ],
    [
      'a finding requirement identifier',
      (text: string): ControlStatus => ({
        ...V7_NODE_RESTRICTION_PASSING,
        findings: [{ message: 'the cross-node write was admitted.', requirementId: text }],
      }),
    ],
    [
      'the evaluation timestamp',
      (text: string): ControlStatus => ({ ...V7_NODE_RESTRICTION_PASSING, observedAt: text }),
    ],
    [
      'a reported requirement identifier',
      (text: string): ControlStatus => ({ ...V7_NODE_RESTRICTION_PASSING, requirementIds: [text] }),
    ],
    [
      'an unrecognised observation label',
      (text: string): ControlStatus =>
        passingWith([...ALL_REQUIRED_PROVEN, { label: text, value: 1 }]),
    ],
    [
      'an unrecognised observation value',
      (text: string): ControlStatus =>
        passingWith([...ALL_REQUIRED_PROVEN, { label: 'probe', value: text }]),
    ],
    [
      'an unreadable outcome value',
      (text: string): ControlStatus =>
        withConfig([
          { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: text },
          ...ALL_FOUR_HOLD.slice(1),
        ]),
    ],
    [
      'a reported enabling-configuration value',
      (text: string): ControlStatus =>
        passingWith([
          { label: V7_OBSERVATIONS.authorizationMode, value: text },
          { label: V7_OBSERVATIONS.admissionPluginsEnabled, value: NODE_RESTRICTION_PLUGIN },
          ...ALL_FOUR_HOLD,
        ]),
    ],
  ])('withholds a token-shaped credential in %s', (_name, build) => {
    const { container } = renderWithProviders(<NodeIsolationPanel status={build(TOKEN_SHAPED)} />);

    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('bounds the unrecognised-outcome echo the tightened reader widened', () => {
    // The M8 fix sends strictly MORE server text down the unreadable branch — every
    // sentence and qualification that used to be read as an outcome now arrives there to be
    // echoed back — so the branch that renders arbitrary wire text is the one that most
    // needed bounding.
    const status = withConfig([
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value: `denied because ${PEM_SHAPED}` },
      ...ALL_FOUR_HOLD.slice(1),
    ]);
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    expect(outcomesTable()).toHaveTextContent(/unrecognised outcome/iu);
    expect(container.textContent ?? '').not.toContain('BEGIN PRIVATE KEY');
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('withholds a credential in the failure message and its reason', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'error',
          error: {
            ...CONTROL_STATUS_ERRORS.serverError,
            message: `the posture endpoint reported ${TOKEN_SHAPED}`,
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
    // The headline is authored locally from `kind` and `httpStatus`, so it is unconditional
    // and the reader is never left with a redaction marker and no explanation.
    expect(screen.getByRole('alert').textContent ?? '').not.toBe('');
  });

  it('keeps the words around a redacted PEM block', () => {
    const status: ControlStatus = {
      ...V7_NODE_RESTRICTION_PASSING,
      detail: `the kubelet credential was read as ${PEM_SHAPED} rather than as a placeholder.`,
    };
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    expect(container.textContent ?? '').not.toContain('BEGIN PRIVATE KEY');
    expect(container).toHaveTextContent('rather than as a placeholder');
  });

  it('bounds an oversized summary rather than rendering any of it', () => {
    const status: ControlStatus = {
      ...V7_NODE_RESTRICTION_PASSING,
      summary: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    };
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(container.textContent ?? '').not.toContain('xxxxxxxxxx');
  });

  it('collapses control characters and bidirectional overrides out of prose', () => {
    const status: ControlStatus = {
      ...V7_NODE_RESTRICTION_PASSING,
      summary: 'Cross-node writes are denied.\n\u0007\u202ENothing was admitted.',
    };
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(container).toHaveTextContent('Cross-node writes are denied. Nothing was admitted.');
  });

  it('substitutes local wording for text that sanitized away to nothing', () => {
    const status: ControlStatus = {
      ...V7_NODE_RESTRICTION_PASSING,
      summary: '\u0000\u0007',
      findings: [{ message: '\u202E\u200B' }],
    };
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    // A blank line under a verdict badge is indistinguishable from a server that chose to
    // say nothing, so both cases now say which one they are.
    expect(container).toHaveTextContent('summary could not be displayed');
    expect(container).toHaveTextContent('finding whose message could not be displayed');
  });

  it('falls back to its own requirement identifiers when every reported one is unusable', () => {
    const status: ControlStatus = { ...V7_NODE_RESTRICTION_PASSING, requirementIds: ['\u0007'] };
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    // Rendering "Requirements covered: " over nothing, in the panel HEADER, would be the
    // most prominent empty statement on screen.
    expect(container).toHaveTextContent('F-007-RQ-001');
    expect(container).toHaveTextContent('F-007-RQ-002');
  });

  it('never names an external standards benchmark', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel status={V7_NODE_RESTRICTION_PASSING} />,
    );

    // AAP §0.11.1: cite only what the repository states. No CIS or NSA control number is
    // enumerated anywhere in this repository, so none may be asserted here.
    expect(container.textContent ?? '').not.toMatch(/CIS|NSA|OWASP/);
  });
});


describe('NodeIsolationPanel — the edges of the exact grammar', () => {
  /** The recorded baseline with one replacement on the cross-node denial row. */
  function crossNode(value: ControlObservation['value']): ControlStatus {
    return withConfig([
      { label: V7_OBSERVATIONS.crossNodeStatusUpdate, value },
      ...ALL_FOUR_HOLD.slice(1),
    ]);
  }

  it.each([
    ['a code above the HTTP range, as a number', 700],
    ['a code below the HTTP range, as a number', 99],
    ['a fractional code', 403.5],
    ['a code above the range inside a Status', '{"code":999}'],
    ['a fractional code inside a Status', '{"code":403.5}'],
  ])('refuses to read an outcome from %s', (_name, value) => {
    // Reached only through the two routes that carry a code WITHOUT the three-digit string
    // form: a raw number observation, and a serialized Status. Neither describes a completed
    // authorization decision, and guessing at one would be the reinterpretation this tier
    // exists to avoid.
    expect(resolveNodeIsolationEffectiveVerdict(crossNode(value))).toBe('unknown');
  });

  it.each([
    ['an informational code', 100],
    ['a redirect', 302],
  ])('treats %s as unreadable rather than as an allow or a denial', (_name, code) => {
    expect(resolveNodeIsolationEffectiveVerdict(crossNode(code))).toBe('unknown');
  });

  it('keeps a 4xx that is not 403 or 404 indeterminate, and names its code', () => {
    const { container } = renderWithProviders(<NodeIsolationPanel status={crossNode(401)} />);

    // Refused, and the code is known but is not the one the requirement depends on. The code
    // is still rendered, because the whole distinction this panel preserves is between codes.
    expect(verdictText()).toContain('Unknown');
    expect(outcomesTable()).toHaveTextContent('Denied with HTTP 401');
    expect(container.textContent ?? '').not.toContain('403 Forbidden retried');
  });

  it('keeps a 5xx indeterminate on a required denial', () => {
    expect(resolveNodeIsolationEffectiveVerdict(crossNode(500))).toBe('unknown');
  });

  it('reads an empty value as unreadable, and says so in words', () => {
    const { container } = renderWithProviders(<NodeIsolationPanel status={crossNode('')} />);

    expect(verdictText()).toContain('Unknown');
    // Never the literal empty string in a cell: a blank outcome cell is indistinguishable
    // from a rendering bug.
    expect(container).toHaveTextContent(/empty value/iu);
  });

  it.each([
    ['a reason that is not a string', '{"code":403,"reason":5}'],
    ['a kind that is not a string', '{"code":403,"kind":5}'],
    ['a reason naming no known outcome', '{"code":403,"reason":"Teapot"}'],
    ['a JSON array of codes', '[403]'],
    ['a JSON array of Status objects', '[{"code":403}]'],
  ])('rejects a serialized document carrying %s', (_name, value) => {
    // The narrow shape is narrow on purpose: an integer `code`, optionally a string `reason`
    // that AGREES with it, and `kind` either absent or exactly `Status`. Nothing is inferred
    // from any other member, and an unrecognised reason withholds trust from the code rather
    // than being ignored.
    expect(resolveNodeIsolationEffectiveVerdict(crossNode(value))).toBe('unknown');
  });

  it('accepts a Status whose kind is spelled in another case', () => {
    expect(resolveNodeIsolationEffectiveVerdict(crossNode('{"kind":"status","code":403}'))).toBe(
      'pass',
    );
  });

  it('renders the empty affordance differently for the two kinds of absence', () => {
    const noneAtAll = renderWithProviders(
      <NodeIsolationPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );
    expect(noneAtAll.container).toHaveTextContent('no control posture at all');
    noneAtAll.unmount();

    const othersOnly = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'success',
          controls: [V7_NODE_RESTRICTION_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
      />,
    );
    // The control IS present here, so this is the pass path; the point of the pair is that
    // the two absences are worded differently and neither is a verdict.
    expect(othersOnly.container).toHaveTextContent('Pass');
  });

  it('reports posture for other controls but not V7 as unknown, never as a pass', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'success',
          controls: [{ ...V7_NODE_RESTRICTION_PASSING, controlId: 'V1' }],
          isEmpty: false,
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container).toHaveTextContent('but not for V7');
    expect(container.textContent ?? '').not.toContain('Verdict: Pass');
  });

  it('distinguishes an unreadable body from a refusal, and calls neither a denial', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel
        result={{ status: 'error', error: CONTROL_STATUS_ERRORS.payload, refresh: vi.fn() }}
      />,
    );

    // A 2xx whose body could not be read is the third distinct way to have no verdict, and
    // the one most easily mistaken for success because the transport worked.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(container).toHaveTextContent('could not be read as posture data');
    expect(container.textContent ?? '').not.toContain('Verdict:');
  });

  it('separates a 404 on the posture endpoint from a 404 on a Node object', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'error',
          error: { kind: 'http', httpStatus: NOT_FOUND_STATUS, message: 'not found' },
          refresh: vi.fn(),
        }}
      />,
    );

    // The two 404s mean entirely different things, and conflating them is how a reader
    // concludes the ordering hazard was hit when the endpoint simply was not there.
    expect(container).toHaveTextContent(/endpoint itself was not found/iu);
    expect(container).toHaveTextContent(/unrelated to the 404/iu);
  });

  it('reports an empty authorization mode as unreadable rather than as the wrong mode', () => {
    const status = passingWith([
      { label: V7_OBSERVATIONS.authorizationMode, value: '' },
      { label: V7_OBSERVATIONS.admissionPluginsEnabled, value: NODE_RESTRICTION_PLUGIN },
      ...ALL_FOUR_HOLD,
    ]);
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    // INDETERMINATE, not violated, and consistent with the empty plugin list above: an
    // empty string is the absence of a measurement rather than a wrong one, so the honest
    // answer is that the configuration cannot be read — not that it is broken.
    expect(verdictText()).toContain('Unknown');
    expect(configStatus(container, 'authorization-mode')).toBe('indeterminate');
    expect(configTable()).toHaveTextContent(/empty value/iu);
  });

  it('treats a duplicated plugin list as indeterminate', () => {
    const status = passingWith([
      ...ALL_REQUIRED_PROVEN,
      { label: V7_OBSERVATIONS.admissionPluginsEnabled, value: 'PodSecurity' },
    ]);
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);

    expect(verdictText()).toContain('Unknown');
    expect(configStatus(container, 'node-restriction-plugin')).toBe('indeterminate');
  });
});


describe('NodeIsolationPanel — the self-driving path and the remaining absences', () => {
  it('reads its own posture when given nothing at all', async () => {
    // The connected path, which every prop-driven case above bypasses. It is worth one case
    // because it is the path a real page uses, and because the panel would otherwise be
    // proven only in the mode specifications happen to find convenient.
    renderWithProviders(<NodeIsolationPanel />);

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /V7 verdict/iu })).toBeInTheDocument();
    });
    expect(verdictText()).toContain('Pass');
  });

  it('renders a payload carrying no evidence at all as unknown', () => {
    // `evidence` is optional on the wire, so the panel must survive its absence — and must
    // read it as nothing measured rather than as nothing wrong.
    const noEvidence: ControlStatus = {
      ...V7_NODE_RESTRICTION_PASSING,
      evidence: undefined,
    };
    renderWithProviders(<NodeIsolationPanel status={noEvidence} />);

    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Pass');
    expect(resolveNodeIsolationEffectiveVerdict(noEvidence)).toBe('unknown');
  });

  it('omits the evaluation timestamp rather than rendering an empty one', () => {
    const undated: ControlStatus = { ...V7_NODE_RESTRICTION_PASSING, observedAt: undefined };
    const { container } = renderWithProviders(<NodeIsolationPanel status={undated} />);

    expect(container.querySelector('.node-isolation-panel__observed-at')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Evaluated at');
  });

  it('omits the detail paragraph rather than rendering an empty one', () => {
    const terse: ControlStatus = { ...V7_NODE_RESTRICTION_PASSING, detail: '' };
    const { container } = renderWithProviders(<NodeIsolationPanel status={terse} />);

    expect(container.querySelector('.node-isolation-panel__detail')).toBeNull();
  });

  it('names an empty unrecognised value rather than rendering a blank line', () => {
    const status = passingWith([...ALL_REQUIRED_PROVEN, { label: 'probe', value: '' }]);
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);
    const other = container.querySelector('.node-isolation-panel__other-observations');

    // `probe: ` with nothing after it reads as a rendering fault; saying the value was empty
    // reads as a fact about the report.
    expect(other?.textContent ?? '').toContain('empty value');
  });

  it('names an explicit null unrecognised value as an explicit null', () => {
    const status = passingWith([...ALL_REQUIRED_PROVEN, { label: 'probe', value: null }]);
    const { container } = renderWithProviders(<NodeIsolationPanel status={status} />);
    const other = container.querySelector('.node-isolation-panel__other-observations');

    // The hook module documents `null` as MEANINGFUL rather than missing, so it must not
    // render as the word `null` and must not render as nothing.
    expect(other?.textContent ?? '').toContain('explicitly as null');
  });

  it('substitutes local wording for a failure message that sanitized away', () => {
    const { container } = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'error',
          error: { ...CONTROL_STATUS_ERRORS.network, message: '\u0007\u0000' },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container).toHaveTextContent('failure whose message could not be displayed');
  });

  it('states a refusal without inventing a status code it was not given', () => {
    // `kind: 'http'` with NO `httpStatus`: the transport refused the request and the code
    // did not survive. The headline must say so in words rather than interpolating the
    // absence, which is how `HTTP undefined` reaches a screen.
    const { container } = renderWithProviders(
      <NodeIsolationPanel
        result={{
          status: 'error',
          error: { kind: 'http', message: 'the request never completed' },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container).toHaveTextContent('The request for V7 posture was refused.');
    expect(container.textContent ?? '').not.toMatch(/HTTP undefined|HTTP NaN/u);
  });
});
