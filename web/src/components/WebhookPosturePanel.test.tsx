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

// AAP §0.5.1 (the `web/src/components/WebhookPosturePanel.test.tsx` row — "V5 behaviour |
// Fail-closed versus fail-open verdict") / §0.4.2.4 (the five case categories every panel
// spec covers) / §0.10.2 (the "Webhook posture" boundary row: `failurePolicy: Fail`,
// `timeoutSeconds: 5`, `sideEffects: None`, `admissionReviewVersions: ["v1"]`, and the
// documented consequence that `Ignore` "would make the webhook fail-open, which is the
// weakness V5 closed") / §0.7.1.4 (V5 is locked today by "nothing — inspection only", so
// this file is part of a genuine automation gain rather than a port) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   The V5 panel renders a confirmed fail-closed posture only when the six values
//   F-005-RQ-001 is made of were MEASURED and MATCHED, at their committed wire types.
//   Silence is never agreement, a duplicate is never a value, and a scalar reported for a
//   list-valued field is never the same thing as the single-element list.
//
// THE THREE DEFECTS THESE CASES EXIST TO PREVENT, all of which compiled and linted cleanly:
//
//   1. `resolveVerdict` returned `status.verdict` whenever the posture was merely
//      `undetermined`, and `postureClause` printed the FAIL-CLOSED sentence for an
//      undetermined posture whose verdict was `pass`. A payload claiming `pass` with NO
//      observations at all therefore rendered "Pass — the admission webhook is fail-closed:
//      an admission call that fails denies the request." That sentence is a hardening claim
//      the panel had been told nothing about.
//   2. `comparableValue` stripped one layer of brackets and quotes from BOTH sides before
//      comparing, so the scalar `v1`, the unquoted `[v1]` and the committed `["v1"]` all
//      compared equal. A manifest whose `admissionReviewVersions` is a bare string — which
//      the admission API rejects — read as correctly configured.
//   3. `findObservation` was `observations.find(...)` over an alias set with suffix
//      matching, so the FIRST observation addressing a field won and a second, later,
//      fail-open value was never seen.
//
// The authority for every required value is the committed artifact itself,
// `cluster/gce/addons/cloud-pvl-admission/mutating-webhook-configuration.yaml`, whose L25
// is `failurePolicy: Fail`, L24 `timeoutSeconds: 5`, L23 `sideEffects: None`, L22
// `admissionReviewVersions: ["v1"]`, L20 `name: "only-gce"` and L9 the webhook name.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V5_OBSERVATIONS } from '../domain/observationIds';
import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  MAX_SAFE_VALUE_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import {
  WEBHOOK_ADMISSION_REVIEW_VERSIONS,
  WEBHOOK_FAIL_CLOSED_POLICY,
  WEBHOOK_FAIL_OPEN_POLICY,
  WEBHOOK_NAME,
  WEBHOOK_SIDE_EFFECTS,
  WEBHOOK_TIMEOUT_SECONDS,
} from '../domain/securityConstants';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  CONTROL_STATUS_ERRORS,
  FAIL_CLOSED_WEBHOOK,
  FAIL_OPEN_WEBHOOK,
  V5_WEBHOOK_FAILING,
  V5_WEBHOOK_PASSING,
  V5_WEBHOOK_UNKNOWN,
  webhookPostureObservations,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import WebhookPosturePanel, {
  resolveWebhookPostureEffectiveVerdict,
} from './WebhookPosturePanel';

/** The sentence a confirmed fail-closed posture renders, in the panel's own words. */
const FAIL_CLOSED_SENTENCE =
  'the admission webhook is fail-closed: an admission call that fails denies the request';

/** The sentence an observed fail-open posture renders. */
const FAIL_OPEN_SENTENCE = 'the admission webhook is fail-open';

/** The sentence an unconfirmed posture renders. */
const UNDETERMINED_SENTENCE =
  'the failurePolicy evidence was inconclusive, so the fail-closed posture is not confirmed';

/** The six measurements F-005-RQ-001 is made of, all proven. */
const ALL_POSTURE_PROVEN: readonly ControlObservation[] = [
  { label: V5_OBSERVATIONS.failurePolicy, value: WEBHOOK_FAIL_CLOSED_POLICY },
  { label: V5_OBSERVATIONS.timeoutSeconds, value: WEBHOOK_TIMEOUT_SECONDS },
  { label: V5_OBSERVATIONS.sideEffects, value: WEBHOOK_SIDE_EFFECTS },
  {
    label: V5_OBSERVATIONS.admissionReviewVersions,
    value: JSON.stringify(WEBHOOK_ADMISSION_REVIEW_VERSIONS),
  },
  { label: V5_OBSERVATIONS.webhookName, value: WEBHOOK_NAME },
  { label: V5_OBSERVATIONS.matchConditionName, value: 'only-gce' },
];

/** A payload claiming `pass`, carrying exactly the observations under test. */
function claimingPass(observations: readonly ControlObservation[]): ControlStatus {
  return {
    ...V5_WEBHOOK_PASSING,
    findings: [],
    warnings: [],
    evidence: { observations },
  };
}

/**
 * {@link ALL_POSTURE_PROVEN} with one measurement removed by identity.
 *
 * Throws when the identity is not in the list. A silent no-op here would produce a
 * case that asserts the unchanged baseline and passes for the wrong reason.
 */
function without(label: string): readonly ControlObservation[] {
  const remaining = ALL_POSTURE_PROVEN.filter((observation) => observation.label !== label);
  if (remaining.length === ALL_POSTURE_PROVEN.length) {
    throw new Error(
      `"${label}" is not one of the posture measurements, so removing it is a no-op.`,
    );
  }
  return remaining;
}

/**
 * {@link ALL_POSTURE_PROVEN} with one measurement's value replaced.
 *
 * Throws when the identity is not in the list, for the same reason as
 * {@link without}: a replacement that matched nothing would leave the baseline
 * intact and the case would prove nothing.
 */
function replacing(
  label: string,
  value: ControlObservation['value'],
): readonly ControlObservation[] {
  if (!ALL_POSTURE_PROVEN.some((observation) => observation.label === label)) {
    throw new Error(
      `"${label}" is not one of the posture measurements, so replacing it is a no-op.`,
    );
  }
  return ALL_POSTURE_PROVEN.map((observation) =>
    observation.label === label ? { label, value } : observation,
  );
}

/** The verdict the rendered badge carries. */
function renderedVerdict(container: HTMLElement): string | null {
  return container.querySelector('[data-verdict]')?.getAttribute('data-verdict') ?? null;
}

/** The outcome attribute of one field's row. */
function rowOutcome(container: HTMLElement, path: string): string | null {
  return container.querySelector(`[data-field="${path}"]`)?.getAttribute('data-outcome') ?? null;
}

describe('WebhookPosturePanel — the recorded payloads render their recorded verdicts', () => {
  it('renders PASS with the fail-closed sentence for the recorded passing payload', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(renderedVerdict(container)).toBe('pass');
    expect(container).toHaveTextContent(FAIL_CLOSED_SENTENCE);
    expect(container).not.toHaveTextContent(UNDETERMINED_SENTENCE);
  });

  it('proves every field of the recorded passing payload matched, lists included', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    for (const path of [
      'failurePolicy',
      'timeoutSeconds',
      'sideEffects',
      'admissionReviewVersions',
      'name',
      'matchConditions[0].name',
      'matchConditions[0].expression',
      'rules[0].apiGroups',
      'rules[0].apiVersions',
      'rules[0].operations',
      'rules[0].resources',
      'rules[0].scope',
      'clientConfig.url',
      'clientConfig.caBundle',
    ]) {
      expect(rowOutcome(container, path)).toBe('match');
    }
  });

  it('renders FAIL with the fail-open sentence for the recorded failing payload', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_FAILING} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent(FAIL_OPEN_SENTENCE);
    expect(container).not.toHaveTextContent(FAIL_CLOSED_SENTENCE);
  });

  it('names the observed fail-open value and the reported finding', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_FAILING} />);

    expect(rowOutcome(container, 'failurePolicy')).toBe('divergent');
    expect(container).toHaveTextContent(V5_WEBHOOK_FAILING.findings[0].message);
  });

  it('renders UNKNOWN for the recorded unreadable-configuration payload', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_UNKNOWN} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent(UNDETERMINED_SENTENCE);
    expect(container).not.toHaveTextContent(FAIL_CLOSED_SENTENCE);
  });

  it('agrees with the exported resolver on all three recorded payloads', () => {
    expect(resolveWebhookPostureEffectiveVerdict(V5_WEBHOOK_PASSING)).toBe('pass');
    expect(resolveWebhookPostureEffectiveVerdict(V5_WEBHOOK_FAILING)).toBe('fail');
    expect(resolveWebhookPostureEffectiveVerdict(V5_WEBHOOK_UNKNOWN)).toBe('unknown');
  });
});

describe('WebhookPosturePanel — a pass must be earned (defect 1)', () => {
  it('withholds the pass when the payload claims one and reports nothing at all', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel status={claimingPass([])} />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent(UNDETERMINED_SENTENCE);
  });

  it('never prints the fail-closed sentence over a payload that reported no failurePolicy', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel status={claimingPass(without(V5_OBSERVATIONS.failurePolicy))} />,
    );

    expect(container).not.toHaveTextContent(FAIL_CLOSED_SENTENCE);
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it.each([
    ['failurePolicy', V5_OBSERVATIONS.failurePolicy],
    ['timeoutSeconds', V5_OBSERVATIONS.timeoutSeconds],
    ['sideEffects', V5_OBSERVATIONS.sideEffects],
    ['admissionReviewVersions', V5_OBSERVATIONS.admissionReviewVersions],
    ['webhook name', V5_OBSERVATIONS.webhookName],
    ['matchConditions[0].name', V5_OBSERVATIONS.matchConditionName],
  ])('withholds the pass when %s is unreported', (_name, identity) => {
    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(without(identity)))).toBe('unknown');
  });

  it('grants the pass when exactly the six posture fields are proven', () => {
    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(ALL_POSTURE_PROVEN))).toBe('pass');
  });

  it('does not withhold the pass for an unreported CONTEXT field', () => {
    const withoutContext = ALL_POSTURE_PROVEN.filter(
      (observation) => observation.label !== V5_OBSERVATIONS.clientConfigUrl,
    );

    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(withoutContext))).toBe('pass');
  });

  it('fails when a CONTEXT field diverges from its committed literal', () => {
    const diverging: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.clientConfigUrl, value: 'https://example.invalid/admit' },
    ];

    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(diverging))).toBe('fail');
  });

  it('floors the verdict at FAIL when the payload reports a finding beside a pass', () => {
    const withFinding: ControlStatus = {
      ...claimingPass(ALL_POSTURE_PROVEN),
      findings: [
        {
          message: 'The webhook was reachable but rejected every admission review.',
          subject: 'mutatingwebhookconfiguration/cloud-pvl-admission.k8s.io',
          requirementId: 'F-005-RQ-001',
        },
      ],
    };
    const { container } = renderWithProviders(<WebhookPosturePanel status={withFinding} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(resolveWebhookPostureEffectiveVerdict(withFinding)).toBe('fail');
  });

  it('withholds the pass when the configuration was reported unreadable', () => {
    const unreadable: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.configurationReadable, value: false },
    ];

    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(unreadable))).toBe('unknown');
  });

  it('withholds the pass when legibility is reported at a type it cannot use', () => {
    const unusable: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.configurationReadable, value: 'yes' },
    ];

    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(unusable))).toBe('unknown');
  });

  it('grants the pass when legibility is reported true', () => {
    const readable: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.configurationReadable, value: true },
    ];

    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(readable))).toBe('pass');
  });

  it('explains the withheld pass and names the unproven fields', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel status={claimingPass(without(V5_OBSERVATIONS.sideEffects))} />,
    );

    const region = container.querySelector('[data-region="pass-withheld"]');
    expect(region).not.toBeNull();
    expect(container.querySelector('[data-unproven="sideEffects"]')).not.toBeNull();
    expect(container).toHaveTextContent('a pass is withheld');
  });

  it('shows no withheld-pass explanation when the pass was earned', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container.querySelector('[data-region="pass-withheld"]')).toBeNull();
  });

  it('shows no withheld-pass explanation for a reported failure', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_FAILING} />);

    expect(container.querySelector('[data-region="pass-withheld"]')).toBeNull();
  });
});

describe('WebhookPosturePanel — fail-open is a failure whatever was reported', () => {
  it('renders FAIL when a payload claiming pass reports failurePolicy Ignore', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        status={claimingPass(
          replacing(V5_OBSERVATIONS.failurePolicy, WEBHOOK_FAIL_OPEN_POLICY),
        )}
      />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent(FAIL_OPEN_SENTENCE);
  });

  it.each(['ignore', 'IGNORE', 'iGnOrE'])(
    'reads %s as fail-open, because a fail-open webhook is fail-open however it was spelled',
    (spelling) => {
      const status = claimingPass(replacing(V5_OBSERVATIONS.failurePolicy, spelling));

      expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('fail');
    },
  );

  it.each(['fail', 'FAIL', 'fAiL'])(
    'does NOT accept %s as the committed fail-closed literal',
    (spelling) => {
      const { container } = renderWithProviders(
        <WebhookPosturePanel
          status={claimingPass(replacing(V5_OBSERVATIONS.failurePolicy, spelling))}
        />,
      );

      expect(container).not.toHaveTextContent(FAIL_CLOSED_SENTENCE);
      expect(renderedVerdict(container)).toBe('fail');
    },
  );

  it('treats an unrecognised failurePolicy as a divergence, not as fail-closed', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.failurePolicy, 'Whatever'));
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(rowOutcome(container, 'failurePolicy')).toBe('divergent');
    expect(container).toHaveTextContent(UNDETERMINED_SENTENCE);
    expect(renderedVerdict(container)).toBe('fail');
  });
});

describe('WebhookPosturePanel — wire types are preserved before comparison (defect 2)', () => {
  it('rejects the bare scalar v1 for the list-valued admissionReviewVersions', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.admissionReviewVersions, 'v1'));
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(rowOutcome(container, 'admissionReviewVersions')).toBe('wrong-type');
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('rejects the unquoted list form [v1], which is not valid JSON', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.admissionReviewVersions, '[v1]'));

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('unknown');
  });

  it('rejects a comma-joined list, the encoding that made a scalar indistinguishable', () => {
    const joined = WEBHOOK_ADMISSION_REVIEW_VERSIONS.join(',');
    const status = claimingPass(replacing(V5_OBSERVATIONS.admissionReviewVersions, joined));

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('unknown');
  });

  it('rejects a JSON array whose members are not strings', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.admissionReviewVersions, '[1]'));

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('unknown');
  });

  it('accepts the committed JSON list form and only that form', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.admissionReviewVersions, '["v1"]'));

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('pass');
  });

  it('diverges on a longer list rather than accepting it as a superset', () => {
    const status = claimingPass(
      replacing(V5_OBSERVATIONS.admissionReviewVersions, '["v1","v1beta1"]'),
    );
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(rowOutcome(container, 'admissionReviewVersions')).toBe('divergent');
    expect(renderedVerdict(container)).toBe('fail');
  });

  it('diverges when a member was helpfully expanded rather than reported verbatim', () => {
    const status = claimingPass([
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.ruleApiGroups, value: '["core"]' },
    ]);

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('fail');
  });

  it('diverges when list members are reported in a different order', () => {
    const status = claimingPass([
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.ruleOperations, value: '["UPDATE","CREATE"]' },
    ]);

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('fail');
  });

  it('accepts the core API group as the committed single-element empty-string list', () => {
    const status = claimingPass([
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.ruleApiGroups, value: '[""]' },
    ]);

    expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('pass');
  });

  it('rejects the string "5" for the integer-valued timeoutSeconds', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.timeoutSeconds, '5'));
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(rowOutcome(container, 'timeoutSeconds')).toBe('wrong-type');
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('accepts the integer 5 and diverges on any other number', () => {
    const withTimeout = (seconds: number): ControlStatus =>
      claimingPass(replacing(V5_OBSERVATIONS.timeoutSeconds, seconds));

    expect(resolveWebhookPostureEffectiveVerdict(withTimeout(5))).toBe('pass');
    expect(resolveWebhookPostureEffectiveVerdict(withTimeout(30))).toBe('fail');
  });

  it.each([5.4, 4.6, 5.5])(
    'diverges on the non-integer timeout %s rather than rounding it into agreement',
    (timeout) => {
      // 5.4 and 4.6 both ROUND to the committed 5, which is exactly why they are here:
      // a comparison that rounded before testing equality would accept them, and a
      // fractional timeout is not the committed integer however close it lands.
      const status = claimingPass(replacing(V5_OBSERVATIONS.timeoutSeconds, timeout));

      expect(resolveWebhookPostureEffectiveVerdict(status)).toBe('fail');
    },
  );

  it('rejects a boolean or null reported for a text field', () => {
    const withSideEffects = (value: ControlObservation['value']): ControlStatus =>
      claimingPass(replacing(V5_OBSERVATIONS.sideEffects, value));

    expect(resolveWebhookPostureEffectiveVerdict(withSideEffects(true))).toBe('unknown');
    expect(resolveWebhookPostureEffectiveVerdict(withSideEffects(null))).toBe('unknown');
  });

  it('renders the committed list literals with their own punctuation', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container).toHaveTextContent('["v1"]');
    expect(container).toHaveTextContent('[""]');
    expect(container).toHaveTextContent('["CREATE"]');
    expect(container).toHaveTextContent('["persistentvolumes"]');
  });
});

describe('WebhookPosturePanel — a duplicated measurement is never a value (defect 3)', () => {
  it('does not let the first of two failurePolicy observations win', () => {
    const duplicated: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.failurePolicy, value: WEBHOOK_FAIL_OPEN_POLICY },
    ];
    const { container } = renderWithProviders(
      <WebhookPosturePanel status={claimingPass(duplicated)} />,
    );

    expect(rowOutcome(container, 'failurePolicy')).toBe('conflict');
    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).not.toHaveTextContent(FAIL_CLOSED_SENTENCE);
  });

  it('treats two IDENTICAL reports of one field as a conflict as well', () => {
    const duplicated: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.sideEffects, value: WEBHOOK_SIDE_EFFECTS },
    ];

    expect(resolveWebhookPostureEffectiveVerdict(claimingPass(duplicated))).toBe('unknown');
  });

  it('renders neither of two conflicting values', () => {
    const duplicated: readonly ControlObservation[] = [
      ...ALL_POSTURE_PROVEN,
      { label: V5_OBSERVATIONS.clientConfigUrl, value: 'https://first.invalid/admit' },
      { label: V5_OBSERVATIONS.clientConfigUrl, value: 'https://second.invalid/admit' },
    ];
    const { container } = renderWithProviders(
      <WebhookPosturePanel status={claimingPass(duplicated)} />,
    );

    expect(rowOutcome(container, 'clientConfig.url')).toBe('conflict');
    expect(container).not.toHaveTextContent('first.invalid');
    expect(container).not.toHaveTextContent('second.invalid');
  });

  it('never claims a match from a suffix-shaped label of a different field', () => {
    const suffixed: readonly ControlObservation[] = [
      { label: 'webhooks[0].failurePolicy', value: WEBHOOK_FAIL_CLOSED_POLICY },
      { label: 'webhooks[0].timeoutSeconds', value: WEBHOOK_TIMEOUT_SECONDS },
    ];
    const { container } = renderWithProviders(
      <WebhookPosturePanel status={claimingPass(suffixed)} />,
    );

    expect(rowOutcome(container, 'failurePolicy')).toBe('unreported');
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('surfaces an unrecognised observation verbatim rather than dropping it', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        status={claimingPass([
          ...ALL_POSTURE_PROVEN,
          { label: 'webhooks[0].failurePolicy', value: 'Ignore' },
        ])}
      />,
    );

    expect(container).toHaveTextContent('Other reported observations');
    expect(container).toHaveTextContent('webhooks[0].failurePolicy');
  });
});

describe('WebhookPosturePanel — the corroborating configuration count', () => {
  it('renders the reported count and calls a count of one the sole configuration', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        status={claimingPass([
          ...ALL_POSTURE_PROVEN,
          { label: V5_OBSERVATIONS.committedConfigurationCount, value: 1 },
        ])}
      />,
    );

    expect(container).toHaveTextContent('sole committed webhook configuration');
  });

  it('renders a count above one without claiming it is the only configuration', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        status={claimingPass([
          ...ALL_POSTURE_PROVEN,
          { label: V5_OBSERVATIONS.committedConfigurationCount, value: 3 },
        ])}
      />,
    );

    expect(container).toHaveTextContent('Committed webhook configurations reported');
    expect(container).not.toHaveTextContent('sole committed webhook configuration');
  });

  it('asserts nothing about the repository when the count was not reported', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container).not.toHaveTextContent('Committed webhook configurations reported');
  });

  it('ignores a count reported twice rather than picking one', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        status={claimingPass([
          ...ALL_POSTURE_PROVEN,
          { label: V5_OBSERVATIONS.committedConfigurationCount, value: 1 },
          { label: V5_OBSERVATIONS.committedConfigurationCount, value: 9 },
        ])}
      />,
    );

    expect(container).not.toHaveTextContent('Committed webhook configurations reported');
  });
});

describe('WebhookPosturePanel — loading, empty, error and interaction', () => {
  it('renders the loading affordance and no verdict while the request is in flight', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel result={{ status: 'loading', refresh: vi.fn() }} />,
    );

    expect(screen.getByRole('status', { name: /Checking the committed/ })).toBeInTheDocument();
    expect(renderedVerdict(container)).toBeNull();
  });

  it('renders the required values even while the check is in flight', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel result={{ status: 'loading', refresh: vi.fn() }} />,
    );

    expect(container).toHaveTextContent('Not checked yet.');
    expect(rowOutcome(container, 'failurePolicy')).toBe('unreported');
  });

  it('renders the empty affordance and no verdict when the control was not reported', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );

    expect(renderedVerdict(container)).toBeNull();
    expect(container).toHaveTextContent('this panel is empty and shows no verdict');
  });

  it('renders the empty affordance when other controls were reported but not V5', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'success',
          controls: [V5_WEBHOOK_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
        controlId="V1"
      />,
    );

    expect(renderedVerdict(container)).toBeNull();
  });

  it.each([
    ['forbidden', CONTROL_STATUS_ERRORS.forbidden],
    ['serverError', CONTROL_STATUS_ERRORS.serverError],
    ['network', CONTROL_STATUS_ERRORS.network],
  ])('renders an alert and never a verdict for a %s failure', (_name, error) => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel result={{ status: 'error', error, refresh: vi.fn() }} />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(renderedVerdict(container)).toBeNull();
    expect(container).not.toHaveTextContent(FAIL_CLOSED_SENTENCE);
  });

  it('calls the override instead of the underlying refresh when both exist', async () => {
    const refresh = vi.fn();
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'success',
          controls: [V5_WEBHOOK_PASSING],
          isEmpty: false,
          refresh,
        }}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    // ONE channel. Calling both turned a single press into two identical requests,
    // because the aggregate dashboard supplies the same function through both props.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('re-issues the underlying request when the caller supplied no override', async () => {
    const refresh = vi.fn();
    const { user } = renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'success',
          controls: [V5_WEBHOOK_PASSING],
          isEmpty: false,
          refresh,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('notifies the caller for a pre-resolved payload, which cannot re-request', async () => {
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <WebhookPosturePanel status={V5_WEBHOOK_PASSING} onRefresh={onRefresh} />,
    );

    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the control, with a reason, for a payload nothing can re-request', () => {
    renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);
    const button = screen.getByRole('button', { name: /Refresh/ });

    // No request belongs to a handed-over payload and no handler was supplied, so an
    // enabled button would promise a re-check it cannot perform.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });

  it('disables every refresh route when the caller says refreshing is unavailable', () => {
    renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'success',
          controls: [V5_WEBHOOK_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
        onRefresh={vi.fn()}
        canRefresh={false}
      />,
    );
    const button = screen.getByRole('button', { name: /Refresh/ });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });
});

describe('WebhookPosturePanel — accessibility and no-secret rendering', () => {
  it('is a region named by its heading', () => {
    renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(
      screen.getByRole('region', { name: 'V5 — admission webhook fail-closed posture' }),
    ).toBeInTheDocument();
  });

  it('addresses every field row by its own name', () => {
    renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(screen.getByRole('rowheader', { name: 'failurePolicy' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'clientConfig.caBundle' })).toBeInTheDocument();
  });

  it('renders the caBundle placeholder verbatim and no certificate-shaped material', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container).toHaveTextContent('__CLOUD_PVL_ADMISSION_CA_CERT__');
    expect(container.textContent ?? '').not.toContain('BEGIN CERTIFICATE');
  });

  it('names the repository requirement rather than any external benchmark', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container).toHaveTextContent('F-005-RQ-001');
    expect(container.textContent ?? '').not.toMatch(/CIS|NSA|OWASP/);
  });
});

describe('WebhookPosturePanel — the fixture observation builder', () => {
  it('records the fail-closed posture at the wire types the panel requires', () => {
    const observations = webhookPostureObservations(FAIL_CLOSED_WEBHOOK);
    const byLabel = new Map(
      observations.map((observation) => [observation.label, observation.value]),
    );

    expect(byLabel.get(V5_OBSERVATIONS.failurePolicy)).toBe(WEBHOOK_FAIL_CLOSED_POLICY);
    expect(byLabel.get(V5_OBSERVATIONS.timeoutSeconds)).toBe(WEBHOOK_TIMEOUT_SECONDS);
    expect(byLabel.get(V5_OBSERVATIONS.admissionReviewVersions)).toBe('["v1"]');
    expect(byLabel.get(V5_OBSERVATIONS.ruleApiGroups)).toBe('[""]');
  });

  it('differs from the fail-open recording in failurePolicy and nothing else', () => {
    const closed = webhookPostureObservations(FAIL_CLOSED_WEBHOOK);
    const open = webhookPostureObservations(FAIL_OPEN_WEBHOOK);
    const differing = closed.filter(
      (observation, index) => observation.value !== open[index].value,
    );

    expect(differing.map((observation) => observation.label)).toEqual([
      V5_OBSERVATIONS.failurePolicy,
    ]);
  });

  it('reports one observation per field, with no identity reported twice', () => {
    const labels = webhookPostureObservations(FAIL_CLOSED_WEBHOOK).map(
      (observation) => observation.label,
    );

    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// EXTERNAL TEXT IS BOUNDED AND REDACTED (M18, AAP §0.11.1 "no secrets, ever").
//
// THE DEFECT. Every server-authored string this panel rendered went into the document
// verbatim and unbounded: the summary, the detail, each finding's message, subject and
// requirement identifier, each warning, each unrecognised observation's label and
// value, the evaluation timestamp, the reported requirement identifiers, and the error
// message and reason — the last two into a live `role="alert"` region AND its
// `aria-label`. A control could therefore place a PEM block, a compact token, a
// bidirectional override or a megabyte of text into any one of them.
//
// A NOTE ON WHERE THE VALUE CHANNEL SAT. The posture table already refused to echo a
// matched value, but a DIVERGENT value and a wrong-typed list value were rendered
// through `renderObservationValue`, which returned any non-empty string as it stood.
// That is now routed through the shared guard as well, and it is display-only: every
// comparison in `buildRow` is still made against the raw wire value, so no verdict moves.
//
// EVERY CASE HERE IS TWO-SIDED. Dangerous text is withheld AND the recorded text
// survives, because a sanitizer that mangled ordinary prose would push the panel back
// to inventing its own wording — and an invented message cannot say what went wrong.
// ---------------------------------------------------------------------------

describe('WebhookPosturePanel — external text is bounded and redacted', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  /** A PEM block marker, which the shared guard treats as credential-shaped whole. */
  const PEM_SHAPED = '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----';

  it('renders the recorded summary and detail unchanged', () => {
    // THE CONTROL for every case below. Without it a sanitizer that blanked everything
    // would satisfy all of them.
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container).toHaveTextContent(V5_WEBHOOK_PASSING.summary);
    if (V5_WEBHOOK_PASSING.detail !== undefined) {
      expect(container).toHaveTextContent(V5_WEBHOOK_PASSING.detail);
    }
  });

  it('renders every recorded finding and warning of the failing payload unchanged', () => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_FAILING} />);

    for (const finding of V5_WEBHOOK_FAILING.findings) {
      expect.soft(container).toHaveTextContent(finding.message);
    }
    for (const warning of V5_WEBHOOK_FAILING.warnings) {
      expect.soft(container).toHaveTextContent(warning);
    }
  });

  it.each([
    ['the summary', (text: string): ControlStatus => ({ ...V5_WEBHOOK_PASSING, summary: text })],
    ['the detail', (text: string): ControlStatus => ({ ...V5_WEBHOOK_PASSING, detail: text })],
    [
      'a warning',
      (text: string): ControlStatus => ({ ...V5_WEBHOOK_PASSING, warnings: [text] }),
    ],
    [
      'a finding message',
      (text: string): ControlStatus => ({
        ...V5_WEBHOOK_PASSING,
        findings: [{ message: text, requirementId: 'F-005-RQ-001' }],
      }),
    ],
    [
      'a finding subject',
      (text: string): ControlStatus => ({
        ...V5_WEBHOOK_PASSING,
        findings: [{ message: 'the committed posture diverged.', subject: text }],
      }),
    ],
    [
      'a finding requirement identifier',
      (text: string): ControlStatus => ({
        ...V5_WEBHOOK_PASSING,
        findings: [{ message: 'the committed posture diverged.', requirementId: text }],
      }),
    ],
    [
      'the evaluation timestamp',
      (text: string): ControlStatus => ({ ...V5_WEBHOOK_PASSING, observedAt: text }),
    ],
    [
      'a reported requirement identifier',
      (text: string): ControlStatus => ({ ...V5_WEBHOOK_PASSING, requirementIds: [text] }),
    ],
    [
      'an unrecognised observation label',
      (text: string): ControlStatus =>
        claimingPass([...ALL_POSTURE_PROVEN, { label: text, value: 1 }]),
    ],
    [
      'an unrecognised observation value',
      (text: string): ControlStatus =>
        claimingPass([...ALL_POSTURE_PROVEN, { label: 'probe', value: text }]),
    ],
  ])('withholds a token-shaped credential in %s', (_name, build) => {
    const { container } = renderWithProviders(<WebhookPosturePanel status={build(TOKEN_SHAPED)} />);

    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('withholds a PEM block wherever it arrives, and keeps the words around it', () => {
    const status: ControlStatus = {
      ...V5_WEBHOOK_PASSING,
      detail: `the caBundle was read as ${PEM_SHAPED} rather than as the placeholder.`,
      warnings: [`reload reported ${PEM_SHAPED}`],
    };
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(container).toHaveTextContent(SAFE_REDACTED);
    // Only the shape is removed; the explanation that gives it meaning survives.
    expect(container).toHaveTextContent('rather than as the placeholder');
    expect(container).toHaveTextContent('reload reported');
  });

  it('bounds an oversized summary rather than rendering any of it', () => {
    const status: ControlStatus = {
      ...V5_WEBHOOK_PASSING,
      summary: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    };
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(container.textContent ?? '').not.toContain('xxxxxxxxxx');
  });

  it('collapses control characters and bidirectional overrides out of prose', () => {
    const status: ControlStatus = {
      ...V5_WEBHOOK_PASSING,
      summary: 'Fail-closed.\n\u0007\u202EFail-open for nobody.',
    };
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(container).toHaveTextContent('Fail-closed. Fail-open for nobody.');
  });

  it('bounds a divergent observed value without moving the verdict', () => {
    // The comparison uses the RAW wire value, so an oversized divergent value must still
    // read as divergent — bounded display, unchanged decision.
    const oversized = 'y'.repeat(MAX_SAFE_VALUE_LENGTH + 1);
    const status = claimingPass(replacing(V5_OBSERVATIONS.sideEffects, oversized));
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container.textContent ?? '').not.toContain('yyyyyyyyyy');
    expect(container).toHaveTextContent(SAFE_REDACTED);
    expect(rowOutcome(container, 'sideEffects')).toBe('divergent');
    expect(renderedVerdict(container)).toBe('fail');
  });

  it('bounds a credential-shaped divergent value, and still calls it divergent', () => {
    const status = claimingPass(replacing(V5_OBSERVATIONS.failurePolicy, TOKEN_SHAPED));
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(rowOutcome(container, 'failurePolicy')).toBe('divergent');
    // A failurePolicy that is neither Fail nor Ignore leaves the posture unconfirmed,
    // which is the safe direction and is asserted elsewhere; here the point is that the
    // value never reached the document.
    expect(container).toHaveTextContent(UNDETERMINED_SENTENCE);
  });

  it.each([
    ['a credential-shaped member', `["${TOKEN_SHAPED}"]`, TOKEN_SHAPED],
    ['an oversized member', `["${'z'.repeat(MAX_SAFE_VALUE_LENGTH + 1)}"]`, 'zzzzzzzzzz'],
  ])('bounds a DIVERGENT list carrying %s', (_name, reported, forbidden) => {
    // The narrowest gap of the set, and the one a per-field audit misses: a list value
    // that PARSES as a JSON list of strings is not wrong-typed, so it reaches the
    // divergent branch and is rendered through `JSON.stringify` of arbitrary wire data.
    const status = claimingPass(replacing(V5_OBSERVATIONS.admissionReviewVersions, reported));
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container.textContent ?? '').not.toContain(forbidden);
    expect(rowOutcome(container, 'admissionReviewVersions')).toBe('divergent');
    expect(renderedVerdict(container)).toBe('fail');
  });

  it('keeps a divergent list that is safe to show, brackets and quoting intact', () => {
    // The two-sided half: bounding must not mangle an ordinary divergent list, or the
    // reader loses the one thing the cell exists to say.
    const status = claimingPass(
      replacing(V5_OBSERVATIONS.admissionReviewVersions, '["v1","v1beta1"]'),
    );
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container).toHaveTextContent('["v1","v1beta1"]');
    expect(rowOutcome(container, 'admissionReviewVersions')).toBe('divergent');
  });

  it('bounds a credential-shaped value reported for the LIST field', () => {
    // A scalar reported for a list-valued field is the wrong type, and the reason text
    // quotes what arrived — which is the third place a raw value reached the document.
    const status = claimingPass(
      replacing(V5_OBSERVATIONS.admissionReviewVersions, TOKEN_SHAPED),
    );
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(rowOutcome(container, 'admissionReviewVersions')).toBe('wrong-type');
    expect(container).toHaveTextContent('not a JSON list of');
  });

  it.each([
    ['a 403', CONTROL_STATUS_ERRORS.forbidden],
    ['a 500', CONTROL_STATUS_ERRORS.serverError],
  ])('withholds a credential in %s error message and reason, and renders no verdict', (
    _name,
    error,
  ) => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'error',
          error: { ...error, message: `refused: ${TOKEN_SHAPED}`, reason: `reason ${PEM_SHAPED}` },
          refresh: vi.fn(),
        }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(container.textContent ?? '').not.toContain('BEGIN PRIVATE KEY');
    expect(alert).toHaveTextContent('did not complete, so no verdict is shown');
    // The accessible name is the same guarded sentence, so the credential cannot reach
    // the document through the label either.
    expect(alert.getAttribute('aria-label') ?? '').not.toContain(TOKEN_SHAPED);
    expect(renderedVerdict(container)).toBeNull();
  });

  it('names the failure kind and HTTP status, which are closed sets rather than prose', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        result={{ status: 'error', error: CONTROL_STATUS_ERRORS.forbidden, refresh: vi.fn() }}
      />,
    );

    // Deliberately unguarded: `kind` is a typed union of this repository's own literals
    // and `httpStatus` is a number, so neither is external text.
    expect(container).toHaveTextContent(`failure kind ${CONTROL_STATUS_ERRORS.forbidden.kind}`);
    expect(container).toHaveTextContent('HTTP status 403');
  });

  it('says a wholly credential-shaped message was withheld, not that none arrived', () => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'error',
          error: { ...CONTROL_STATUS_ERRORS.serverError, message: TOKEN_SHAPED, reason: undefined },
          refresh: vi.fn(),
        }}
      />,
    );

    // The credential is REPLACED rather than deleted, so the sentence reads
    // `... no verdict is shown: [redacted]`. That is the honest wording: a message did
    // arrive and was withheld, which is a different fact from none arriving — and the
    // local substitution below is reserved for the second case.
    expect(container).toHaveTextContent(`no verdict is shown: ${SAFE_REDACTED}`);
    expect(container).not.toHaveTextContent('no readable explanation');
    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
  });

  it.each([
    ['an empty message', ''],
    ['a whitespace-only message', '   \t  '],
    ['a message of nothing but control characters', '\u0007\u0000\u202E'],
  ])('substitutes local wording for %s', (_name, message) => {
    const { container } = renderWithProviders(
      <WebhookPosturePanel
        result={{
          status: 'error',
          error: { ...CONTROL_STATUS_ERRORS.serverError, message, reason: undefined },
          refresh: vi.fn(),
        }}
      />,
    );

    // Nothing renderable survived, so the sentence must not simply stop after its colon.
    expect(container).toHaveTextContent('no readable explanation');
    expect(screen.getByRole('alert')).toHaveTextContent('did not complete');
  });

  it('renders no empty paragraph for a summary that was entirely unrenderable', () => {
    const status: ControlStatus = { ...V5_WEBHOOK_PASSING, summary: '\u0007\u0007' };
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    // Sanitize once, then decide: the emptiness test runs on the RESULT, so a field whose
    // whole content was unrenderable contributes no element at all.
    expect([...container.querySelectorAll('p')].some((node) => node.textContent === '')).toBe(
      false,
    );
  });

  it('collapses two reported identifiers that redact to the same placeholder', () => {
    const status: ControlStatus = {
      ...V5_WEBHOOK_PASSING,
      requirementIds: [TOKEN_SHAPED, `${TOKEN_SHAPED}.extra`],
    };
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain(TOKEN_SHAPED);
    // De-duplication happens on the guarded strings, so the list reads `[redacted]` once
    // rather than `[redacted], [redacted]`.
    expect(text).not.toContain(`${SAFE_REDACTED}, ${SAFE_REDACTED}`);
    expect(container).toHaveTextContent('F-005-RQ-001');
  });

  it('still renders null and numeric observation values, which cannot be credentials', () => {
    const status = claimingPass([
      ...ALL_POSTURE_PROVEN,
      { label: 'reload attempts', value: 3 },
      { label: 'previous policy', value: null },
    ]);
    const { container } = renderWithProviders(<WebhookPosturePanel status={status} />);

    expect(container).toHaveTextContent('reload attempts');
    expect(container).toHaveTextContent('3');
    expect(container).toHaveTextContent('null');
  });

  it('leaves every committed literal in the required column untouched', () => {
    // The required column is built from local constants, so nothing in it is guarded and
    // nothing in it may be lost. A sanitizer reaching the wrong column would blank the
    // very values the panel exists to state.
    const { container } = renderWithProviders(<WebhookPosturePanel status={V5_WEBHOOK_PASSING} />);

    expect(container).toHaveTextContent(WEBHOOK_FAIL_CLOSED_POLICY);
    expect(container).toHaveTextContent(WEBHOOK_SIDE_EFFECTS);
    expect(container).toHaveTextContent(WEBHOOK_NAME);
    expect(container).toHaveTextContent(String(WEBHOOK_TIMEOUT_SECONDS));
    expect(container).toHaveTextContent(JSON.stringify(WEBHOOK_ADMISSION_REVIEW_VERSIONS));
  });
});
