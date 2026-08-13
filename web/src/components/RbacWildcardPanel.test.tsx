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

import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V1_OBSERVATIONS } from '../domain/observationIds';
import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  MAX_SAFE_PROSE_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_PROSE_ELISION,
  SAFE_REDACTED,
  safeProse,
} from '../domain/safeText';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  V1_DENIED_SUBJECT,
  V1_PERMITTED_WILDCARD_SUBJECT_KIND,
  V1_POSITIVE_CONTROL_SUBJECT,
  V1_RBAC_FAILING,
  V1_RBAC_FINDINGS,
  V1_RBAC_PASSING,
  V1_RBAC_UNKNOWN,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import RbacWildcardPanel, {
  CLUSTER_ADMIN_ROLE_NAME,
  DECISION_LABELS,
  EVIDENCE_OBSERVED_CONFLICTING,
  EVIDENCE_OBSERVED_UNREPORTED,
  EVIDENCE_OBSERVED_WRONG_TYPE,
  EVIDENCE_OUTCOME_FINDING,
  EVIDENCE_OUTCOME_HOLDS,
  EVIDENCE_OUTCOME_NOT_ESTABLISHED,
  EVIDENCE_OUTCOME_WRONG_REQUEST,
  EVIDENCE_TABLE_CAPTION,
  FULL_WILDCARD_LABEL,
  NON_MASTER_DENIED_PROBE,
  PERMITTED_WILDCARD_SUBJECT_KIND,
  PROBE_TABLE_CAPTION,
  RBAC_EVIDENCE_CHECKS,
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
  measureRbacEvidence,
  readProbeDecision,
  resolveRbacWildcardEffectiveVerdict,
} from './RbacWildcardPanel';

/** Reads the verdict badge's accessible name, which is where the verdict is stated. */
function verdictText(): string {
  return screen.getByRole('status').textContent ?? '';
}

/**
 * The SubjectAccessReview probe table, addressed by its caption.
 *
 * Named rather than positional because the panel renders TWO tables -- the probes and
 * the request-identity/enumeration checks -- and a positional query would silently start
 * reading the wrong one the moment their order changed.
 */
function probeTable(): HTMLElement {
  return screen.getByRole('table', { name: PROBE_TABLE_CAPTION });
}

/** The request-identity and bootstrap-enumeration table, addressed by its caption. */
function evidenceTable(): HTMLElement {
  return screen.getByRole('table', { name: EVIDENCE_TABLE_CAPTION });
}

/**
 * The text of the evidence row measuring `title`.
 *
 * Found by its row header rather than by index, so a reordered table cannot make a case
 * read the wrong row, and matched by substring because the titles contain `*` and `/` --
 * a regex query would need escaping and an accessible-name query would have to spell
 * every cell of the row.
 */
function evidenceRowText(title: string): string {
  const row = within(evidenceTable())
    .getAllByRole('row')
    .find((candidate) => (candidate.textContent ?? '').includes(title));
  if (row === undefined) {
    throw new Error(`No evidence row measures ${JSON.stringify(title)}.`);
  }
  return row.textContent ?? '';
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
    expect(probeTable()).toHaveTextContent(PROBE_OUTCOME_UNREPORTED);
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
    expect(probeTable()).toHaveTextContent(PROBE_OUTCOME_CONFLICTING);
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
    expect(probeTable()).toHaveTextContent(PROBE_OUTCOME_FINDING);
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

// ---------------------------------------------------------------------------
// V1 IS TWO STRATEGIES, NOT ONE (AAP §0.7.2, §0.11.1).
//
// `rbac_test.go` L1170-1299 performs a SubjectAccessReview evaluation AND a
// bootstrap-policy enumeration. Gating the badge on the two SAR booleans alone made
// the enumeration decorative: a payload recording the wildcard rule escaping
// `cluster-admin`, or a binding naming a subject outside `system:masters`, still
// rendered a clean PASS -- and so did one whose review had probed something narrower
// than */*/*, which is a true statement about a different question.
//
// Every case below therefore starts from the RECORDED passing payload and removes or
// changes exactly one measured fact, so a case cannot pass because of some other field
// it forgot. The final case is the two-sided control: the recorded payload must still
// reach PASS with all four facts intact, or the gate would be refusing everything.
// ---------------------------------------------------------------------------

describe('RbacWildcardPanel — the request identity and bootstrap enumeration gate the pass', () => {
  /** The recorded observations with one label removed. */
  function without(label: string): readonly ControlObservation[] {
    return V1_RBAC_PASSING.evidence.observations.filter((entry) => entry.label !== label);
  }

  /** The recorded observations with one label's value replaced. */
  function replacing(
    label: string,
    value: string | number | boolean | null,
  ): readonly ControlObservation[] {
    return [...without(label), { label, value }];
  }

  it('measures all four facts as holding on the recorded passing payload', () => {
    const measurements = measureRbacEvidence(V1_RBAC_PASSING.evidence.observations);
    expect(measurements).toHaveLength(RBAC_EVIDENCE_CHECKS.length);
    expect(measurements.map((measurement) => measurement.verdict)).toEqual(
      RBAC_EVIDENCE_CHECKS.map(() => 'pass'),
    );
  });

  it('names its four facts with the SAME identities the fixture records', () => {
    // The structural half of the alignment, exactly as for the two probes: both sides
    // import one definition site, so this cannot drift apart without a compile error
    // there rather than a silently unfound observation here.
    const recorded = V1_RBAC_PASSING.evidence.observations.map((entry) => entry.label);
    for (const check of RBAC_EVIDENCE_CHECKS) {
      expect.soft(recorded).toContain(check.observationLabel);
    }
  });

  it('agrees with the fixture on the one permitted subject KIND', () => {
    // A binding to a ServiceAccount or a User NAMED system:masters is still an
    // offender, so the kind is part of the boundary and both sides must spell it alike.
    expect(PERMITTED_WILDCARD_SUBJECT_KIND).toBe(V1_PERMITTED_WILDCARD_SUBJECT_KIND);
  });

  it('renders all four rows, with the measured values and not merely the outcomes', () => {
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
    const table = evidenceTable();
    for (const check of RBAC_EVIDENCE_CHECKS) {
      expect.soft(table).toHaveTextContent(check.title);
      expect.soft(table).toHaveTextContent(check.requirementId);
    }
    // The reader sees WHAT was counted, which is what makes the outcome checkable.
    expect(table).toHaveTextContent(CLUSTER_ADMIN_ROLE_NAME);
    expect(table).toHaveTextContent(FULL_WILDCARD_LABEL);
    expect(evidenceRowText(RBAC_EVIDENCE_CHECKS[1].title)).toContain(EVIDENCE_OUTCOME_HOLDS);
  });

  it.each(RBAC_EVIDENCE_CHECKS.map((check) => [check.title, check] as const))(
    'withholds PASS when %s was never measured',
    (_title, check) => {
      const observations = without(check.observationLabel);
      renderWithProviders(<RbacWildcardPanel status={passingWith(observations)} />);
      expect(verdictText()).toContain('Unknown');
      expect(verdictText()).not.toContain('Pass');
      expect(evidenceRowText(check.title)).toContain(EVIDENCE_OBSERVED_UNREPORTED);
      expect(evidenceRowText(check.title)).toContain(EVIDENCE_OUTCOME_NOT_ESTABLISHED);
    },
  );

  it('withholds PASS for a NARROWER request, and does not call it a finding', () => {
    // A denial of get/""/pods is a true measurement of a different question. Reporting
    // FAIL here would invent a defect; reporting PASS would certify authority the
    // review never probed. UNKNOWN is the only honest answer.
    renderWithProviders(
      <RbacWildcardPanel
        status={passingWith(replacing(V1_OBSERVATIONS.requestedAttributes, 'get/*/pods'))}
      />,
    );
    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Fail');
    expect(evidenceRowText(RBAC_EVIDENCE_CHECKS[0].title)).toContain(
      EVIDENCE_OUTCOME_WRONG_REQUEST,
    );
  });

  it.each([
    [
      'an EXTRA ClusterRole carries the wildcard',
      V1_OBSERVATIONS.wildcardClusterRolesOutsideClusterAdmin,
      1,
    ],
    [
      'a wildcard binding names a subject outside the privileged group',
      V1_OBSERVATIONS.wildcardBindingsOutsideMasters,
      1,
    ],
    [
      'the wildcard rule is carried by a role other than cluster-admin',
      V1_OBSERVATIONS.wildcardClusterRoles,
      'example-superuser',
    ],
    [
      'cluster-admin no longer carries the wildcard rule at all',
      V1_OBSERVATIONS.wildcardClusterRoles,
      'none',
    ],
  ])(
    'renders FAIL, over a payload claiming pass, when %s',
    (_label, label: string, value: string | number) => {
      // These are the enumeration half of the oracle's `t.Errorf` channel
      // (L1271-1297): a MEASURED least-privilege defect, so it fails the control
      // rather than merely leaving it unproven -- even though the payload said `pass`
      // and both SubjectAccessReview probes still hold.
      const status = passingWith(replacing(label, value));
      expect(status.verdict).toBe('pass');
      renderWithProviders(<RbacWildcardPanel status={status} />);
      expect(verdictText()).toContain('Fail');
      expect(evidenceTable()).toHaveTextContent(EVIDENCE_OUTCOME_FINDING);
    },
  );

  it.each([
    ['a count reported as a string', V1_OBSERVATIONS.wildcardBindingsOutsideMasters, '0'],
    ['a count reported as a boolean', V1_OBSERVATIONS.wildcardClusterRolesOutsideClusterAdmin, false],
    ['a role name reported as a number', V1_OBSERVATIONS.wildcardClusterRoles, 0],
    ['a fact reported as an explicit null', V1_OBSERVATIONS.requestedAttributes, null],
  ])('refuses %s, because the wire type is part of the requirement', (
    _label,
    label: string,
    value: string | number | boolean | null,
  ) => {
    // A count that was reported as the string '0' has not been counted, and coercing
    // it would invent the very evidence the check exists to demand.
    renderWithProviders(<RbacWildcardPanel status={passingWith(replacing(label, value))} />);
    expect(verdictText()).toContain('Unknown');
    expect(verdictText()).not.toContain('Pass');
    expect(evidenceTable()).toHaveTextContent(EVIDENCE_OBSERVED_WRONG_TYPE);
  });

  it('treats a duplicated fact as conflicting rather than as the first one', () => {
    // Two answers under one identity. Resolving that by list order makes an
    // authorization verdict a function of serialisation order.
    const observations: readonly ControlObservation[] = [
      ...V1_RBAC_PASSING.evidence.observations,
      { label: V1_OBSERVATIONS.wildcardBindingsOutsideMasters, value: 3 },
    ];
    renderWithProviders(<RbacWildcardPanel status={passingWith(observations)} />);
    expect(verdictText()).toContain('Unknown');
    expect(evidenceTable()).toHaveTextContent(EVIDENCE_OBSERVED_CONFLICTING);
  });

  it('still reaches PASS with all four facts intact, so the gate is two-sided', () => {
    // Without this control the tightened gate could refuse every payload and look
    // correct. The recorded evidence must still be sufficient.
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
    expect(verdictText()).toContain('Pass');
    expect(assessRbacWildcard(V1_RBAC_PASSING).evidenceVerdict).toBe('pass');
  });

  it('renders four rows for an EMPTY bag rather than an empty table', () => {
    // "Not measured" must be visible, not absent: a table with no rows reads as
    // "nothing to check here", which is the opposite of what it means.
    renderWithProviders(<RbacWildcardPanel status={passingWith([])} />);
    expect(within(evidenceTable()).getAllByRole('row')).toHaveLength(
      RBAC_EVIDENCE_CHECKS.length + 1,
    );
    expect(verdictText()).toContain('Unknown');
  });
});

// ---------------------------------------------------------------------------
// EXTERNAL TEXT IS BOUNDED AND REDACTED (M18, AAP §0.11.1).
//
// Every string on this panel that a server controls -- the summary, the detail, each
// finding's message and subject, each warning, the requirement identifiers, the
// timestamp, the error message and reason, and every measured observation value --
// passes through the shared sanitizer in `../domain/safeText`. The cases below are
// two-sided on purpose: dangerous text must be withheld AND the recorded text must
// survive unchanged, because a sanitizer that mangled ordinary prose would push the
// panel back to inventing its own wording, and an invented message cannot say what
// actually went wrong.
// ---------------------------------------------------------------------------

describe('RbacWildcardPanel — external prose is bounded and redacted', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  it('renders the RECORDED summary and detail verbatim', () => {
    renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
    expect(verdictText()).toContain(V1_RBAC_PASSING.summary);
    expect(screen.getByText(V1_RBAC_PASSING.detail)).toBeInTheDocument();
  });

  it('renders every RECORDED finding message verbatim, so nothing is lost to redaction', () => {
    const { container } = renderWithProviders(<RbacWildcardPanel status={V1_RBAC_FAILING} />);
    for (const finding of V1_RBAC_FINDINGS) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
  });

  it('bounds an oversized summary rather than rendering it', () => {
    const status: ControlStatus = {
      ...V1_RBAC_PASSING,
      summary: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    };
    renderWithProviders(<RbacWildcardPanel status={status} />);
    expect(verdictText()).toContain(SAFE_OVERSIZED_TEXT);
    expect(verdictText()).not.toContain('xxxxxxxxxx');
  });

  it('truncates a long detail to the prose bound, with an elision marker', () => {
    const status: ControlStatus = { ...V1_RBAC_PASSING, detail: 'y '.repeat(2000) };
    const { container } = renderWithProviders(<RbacWildcardPanel status={status} />);
    expect(container.textContent).toContain(SAFE_PROSE_ELISION.trim());
    const rendered = safeProse(status.detail);
    expect(rendered.length).toBeLessThanOrEqual(MAX_SAFE_PROSE_LENGTH);
    expect(screen.getByText(rendered)).toBeInTheDocument();
  });

  it('redacts a credential shape out of a finding message and its subject', () => {
    const status: ControlStatus = {
      ...V1_RBAC_PASSING,
      findings: [
        {
          message: `ServiceAccount presented ${TOKEN_SHAPED} while resolving the wildcard.`,
          subject: TOKEN_SHAPED,
          requirementId: 'F-001-RQ-001',
        },
      ],
    };
    const { container } = renderWithProviders(<RbacWildcardPanel status={status} />);
    expect(container.textContent).not.toContain(TOKEN_SHAPED);
    expect(container.textContent).toContain(SAFE_REDACTED);
    // The surrounding explanation survives: only the shape is removed.
    expect(container).toHaveTextContent('while resolving the wildcard');
  });

  it('collapses control characters and newlines out of server prose', () => {
    const status: ControlStatus = {
      ...V1_RBAC_PASSING,
      summary: 'Denied.\n\u0007\u202EAllowed for nobody.',
    };
    const { container } = renderWithProviders(<RbacWildcardPanel status={status} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(verdictText()).toContain('Denied. Allowed for nobody.');
  });

  it('bounds a warning and a requirement identifier', () => {
    const status: ControlStatus = {
      ...V1_RBAC_PASSING,
      requirementIds: [TOKEN_SHAPED],
      warnings: [`bootstrap policy reload emitted ${TOKEN_SHAPED}`],
    };
    const { container } = renderWithProviders(<RbacWildcardPanel status={status} />);
    expect(container.textContent).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent('bootstrap policy reload emitted');
    expect(container).toHaveTextContent(`Requirements covered: ${SAFE_REDACTED}`);
  });

  it('redacts a credential shape out of a MEASURED observation value', () => {
    // The evidence table renders server values, so it is an external prose channel too.
    const observations: readonly ControlObservation[] = [
      ...V1_RBAC_PASSING.evidence.observations.filter(
        (entry) => entry.label !== V1_OBSERVATIONS.wildcardClusterRoles,
      ),
      { label: V1_OBSERVATIONS.wildcardClusterRoles, value: TOKEN_SHAPED },
    ];
    renderWithProviders(<RbacWildcardPanel status={passingWith(observations)} />);
    expect(evidenceTable().textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(evidenceTable()).toHaveTextContent(SAFE_REDACTED);
  });

  it('bounds the error message and the server reason', () => {
    renderWithProviders(
      <RbacWildcardPanel
        result={{
          status: 'error',
          error: {
            kind: 'http',
            message: `controls.posture.k8s.io is forbidden: ${TOKEN_SHAPED}`,
            httpStatus: 403,
            reason: TOKEN_SHAPED,
          },
          refresh: vi.fn(),
        }}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(alert).toHaveTextContent('controls.posture.k8s.io is forbidden');
    // `kind` and `httpStatus` are this tier's own typed values, so both still render.
    expect(screen.getByText('403')).toBeInTheDocument();
    expect(screen.getByText('http')).toBeInTheDocument();
  });

  it('bounds the observedAt timestamp channel', () => {
    const status: ControlStatus = { ...V1_RBAC_PASSING, observedAt: TOKEN_SHAPED };
    const { container } = renderWithProviders(<RbacWildcardPanel status={status} />);
    expect(container.textContent).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(`Evaluated at ${SAFE_REDACTED}.`);
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
