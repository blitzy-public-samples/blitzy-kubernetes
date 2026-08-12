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

// AAP §0.5.1 (the `web/src/components/WebhookPosturePanel.test.tsx` row — "V5
// behaviour | Fail-closed versus fail-open verdict") / §0.4.2.4 (L6 React
// tier — every panel covers a happy path, an edge case with partial or unknown
// status, an error case that renders an error state and NEVER a false pass,
// loading and empty states, and an interaction case driving refresh through
// user-event) / §0.10.2 (the boundary table row "Webhook posture") /
// §0.7.1.3 (the >= 80 % line-and-branch floor for the React tier, re-baselined
// against Vitest 4's rewritten AST-aware V8 provider) / tech-spec §0.5.1 and
// §6.6.3.4 (the documentation convention this provenance comment and the
// invariant comments below satisfy).
//
// NO PARITY ANCESTOR. The React tier ports nothing: `Project Guide.md` §4
// records that this is "a control-plane/configuration project with no UI
// surface", so there is no UI test to migrate and no baseline verdict for this
// file to reproduce. Its fidelity anchor is instead the REST and configuration
// behaviour it surfaces (AAP §0.4.1.1, L6).
//
// V5 IS THE ONE CONTROL WITH NO GO TEST AT ALL. AAP §0.7.1.4 records what locks
// V5 today as "nothing — inspection only", and `Project Guide.md` §4 records the
// finding that produced it: "Operational — V5 webhook fail-closed: sole
// committed webhook is `failurePolicy: Fail`, `timeoutSeconds: 5`". This panel,
// with its spec, is therefore part of a genuine automation gain rather than a
// port: it turns a check performed by human inspection into a rendered,
// queryable decision. Nothing about the committed artifact changes.
//
// THE INVARIANT THIS COMPONENT LOCKS — the admission webhook is fail-closed.
// `failurePolicy: Fail` with `timeoutSeconds: 5`, `sideEffects: None` and
// `admissionReviewVersions: ["v1"]`, and `Ignore` (fail-open) is a FAILURE,
// never a pass. `Ignore` is precisely the weakness V5 closed: it would admit the
// request when the admission call fails, so the webhook would be bypassed on
// error. Every required value below was read directly out of the committed
// artifact — see WEBHOOK_POSTURE_FIELDS for the line-by-line provenance — and
// none of them is a framework default, an inferred value or a rounded one.
//
// NO SECRETS, EVER (AAP §0.11.1). The `caBundle` is rendered as the literal
// placeholder the repository commits, `__CLOUD_PVL_ADMISSION_CA_CERT__`, and is
// visibly marked as a placeholder. No certificate material, no realistic-looking
// base64 and no elision: the placeholder-ness is itself part of what this panel
// reports, because it is what tells a reader the material is substituted at
// deployment time.
//
// CITE ONLY WHAT THE REPOSITORY STATES (AAP §0.11.1, §2.5.3). The repository
// enumerates no external benchmark or hardening-guide control number, so none is
// named here. The requirement identifier used is the repository's own,
// F-005-RQ-001.
//
// DEPENDENCY DISCIPLINE (AAP §0.11.1). The only imports are `react` and the
// sibling posture hook, both already part of this tier. No design system, no CSS
// framework, no icon library, no router and no data-fetching library is
// introduced, so web/package.json and web/package-lock.json stay in step and
// `npm ci` keeps working. Markup is plain semantic HTML; the panel ships no
// styles at all, which is why `web/vitest.config.ts` can keep `css: false`.
import { useCallback, useId, useMemo, type ReactElement } from 'react';

import {
  selectControlStatus,
  useControlStatus,
  type ControlId,
  type ControlObservation,
  type ControlStatus,
  type ControlStatusError,
  type ControlVerdict,
  type UseControlStatusResult,
} from '../hooks/useControlStatus';

/**
 * The control this panel reports on: V5, admission-webhook fail-closed posture.
 *
 * Exported so a caller — the aggregate dashboard, or a spec — names the same
 * control this panel queries instead of repeating the literal.
 */
export const WEBHOOK_POSTURE_CONTROL_ID: ControlId = 'V5';

/**
 * The repository's own requirement identifier for this control.
 *
 * Rendering it is the "failure legibility" criterion of AAP §0.7.2: a failure
 * reads as a requirement violation rather than as a value mismatch. No external
 * benchmark identifier is asserted, because the repository enumerates none.
 */
export const WEBHOOK_POSTURE_REQUIREMENT_ID = 'F-005-RQ-001';

/** The committed artifact whose fields this panel reports. */
export const WEBHOOK_CONFIGURATION_SOURCE_PATH =
  'cluster/gce/addons/cloud-pvl-admission/mutating-webhook-configuration.yaml';

/** `apiVersion` of the committed artifact (its line 1). */
export const WEBHOOK_CONFIGURATION_API_VERSION = 'admissionregistration.k8s.io/v1';

/** `kind` of the committed artifact (its line 2). */
export const WEBHOOK_CONFIGURATION_KIND = 'MutatingWebhookConfiguration';

/**
 * The committed `clientConfig.caBundle` value, verbatim.
 *
 * Invariant locked: this is a PLACEHOLDER, substituted at deployment time, and
 * it is rendered exactly as committed. Replacing it with anything that looks
 * like real certificate material would defeat the point of showing it.
 */
export const CA_BUNDLE_PLACEHOLDER = '__CLOUD_PVL_ADMISSION_CA_CERT__';

/**
 * The `failurePolicy` value that IS the control: an admission call that fails
 * denies the request.
 */
export const FAIL_CLOSED_POLICY = 'Fail';

/**
 * The `failurePolicy` value that BREAKS the control: an admission call that
 * fails is admitted anyway, so the webhook is bypassed on error.
 *
 * Invariant locked: observing this value renders a FAILURE, whatever verdict the
 * server reported. See {@link resolveVerdict}.
 */
export const FAIL_OPEN_POLICY = 'Ignore';

/**
 * One required field of the committed webhook configuration.
 *
 * `required` holds the committed literal EXACTLY as it appears in the artifact,
 * including its YAML list punctuation, so that what the panel shows and what the
 * repository ships are the same string. `observationKeys` are the labels this
 * panel accepts for the corresponding measured value; see
 * {@link findObservation} for the matching rule.
 */
export interface WebhookPostureField {
  /**
   * Path of the field relative to `webhooks[0]` of the committed artifact, used
   * as the row header. Relative rather than absolute so the row header is short
   * enough to read and still unambiguous — the table caption names the object.
   */
  readonly path: string;
  /** The committed literal, verbatim. */
  readonly required: string;
  /** Line of {@link WEBHOOK_CONFIGURATION_SOURCE_PATH} the literal was read from. */
  readonly sourceLine: number;
  /**
   * Additional labels accepted for the measured counterpart of this field.
   *
   * {@link path} is always accepted as well and is therefore not repeated here —
   * see {@link acceptedKeys}.
   */
  readonly observationKeys: readonly string[];
  /** Why the value matters, or what a reader should know about it. */
  readonly note?: string;
}

/**
 * Every field of the committed webhook configuration this panel reports, in the
 * order the artifact declares them.
 *
 * Invariant locked: these are MEASURED values, each carrying the line of
 * {@link WEBHOOK_CONFIGURATION_SOURCE_PATH} it was read from, and not one of
 * them is a default. The four that constitute the fail-closed posture of
 * F-005-RQ-001 — `failurePolicy`, `timeoutSeconds`, `sideEffects` and
 * `admissionReviewVersions` — are exact values, so a divergence in any of them
 * is a finding rather than a variation (AAP §0.10.2). `timeoutSeconds: 5` is the
 * only committed bound on the admission call.
 *
 * Exported so that a caller or a spec can enumerate the contract instead of
 * transcribing it a second time.
 */
export const WEBHOOK_POSTURE_FIELDS = [
  {
    path: 'failurePolicy',
    required: FAIL_CLOSED_POLICY,
    sourceLine: 25,
    observationKeys: ['failurePolicy', 'webhooks[0].failurePolicy'],
    note: 'An admission call that fails denies the request.',
  },
  {
    path: 'timeoutSeconds',
    required: '5',
    sourceLine: 24,
    observationKeys: ['timeoutSeconds', 'webhooks[0].timeoutSeconds'],
    note: 'The only committed bound on the admission call.',
  },
  {
    path: 'sideEffects',
    required: 'None',
    sourceLine: 23,
    observationKeys: ['sideEffects', 'webhooks[0].sideEffects'],
    note: 'The webhook mutates nothing outside the admission request itself.',
  },
  {
    path: 'admissionReviewVersions',
    required: '["v1"]',
    sourceLine: 22,
    observationKeys: ['admissionReviewVersions', 'webhooks[0].admissionReviewVersions'],
    note: 'The stable review version, and only that version.',
  },
  {
    path: 'name',
    required: 'cloud-pvl-admission.k8s.io',
    sourceLine: 9,
    observationKeys: ['webhookName', 'webhooks[0].name'],
    note: 'Also the metadata.name of the configuration object (line 4).',
  },
  {
    path: 'matchConditions[0].name',
    required: 'only-gce',
    sourceLine: 20,
    observationKeys: ['matchConditionName', 'webhooks[0].matchConditions[0].name'],
  },
  {
    path: 'matchConditions[0].expression',
    required: 'has(object.spec.gcePersistentDisk)',
    sourceLine: 21,
    observationKeys: [
      'matchConditionExpression',
      'webhooks[0].matchConditions[0].expression',
    ],
    note: 'Narrows the webhook to volumes that carry a GCE persistent disk.',
  },
  {
    path: 'rules[0].apiGroups',
    required: '[""]',
    sourceLine: 11,
    observationKeys: ['apiGroups', 'webhooks[0].rules[0].apiGroups'],
    note: 'The core API group, written as the empty string.',
  },
  {
    path: 'rules[0].apiVersions',
    required: '["v1"]',
    sourceLine: 12,
    observationKeys: ['apiVersions', 'webhooks[0].rules[0].apiVersions'],
  },
  {
    path: 'rules[0].operations',
    required: '["CREATE"]',
    sourceLine: 13,
    observationKeys: ['operations', 'webhooks[0].rules[0].operations'],
  },
  {
    path: 'rules[0].resources',
    required: '["persistentvolumes"]',
    sourceLine: 14,
    observationKeys: ['resources', 'webhooks[0].rules[0].resources'],
  },
  {
    path: 'rules[0].scope',
    required: '"*"',
    sourceLine: 15,
    observationKeys: ['scope', 'webhooks[0].rules[0].scope'],
    note: 'Both cluster-scoped and namespaced objects are matched.',
  },
  {
    path: 'clientConfig.url',
    required: 'https://127.0.0.1:9001/admit',
    sourceLine: 17,
    observationKeys: ['url', 'webhooks[0].clientConfig.url'],
    note: 'A loopback endpoint, so the call never leaves the control-plane node.',
  },
  {
    path: 'clientConfig.caBundle',
    required: CA_BUNDLE_PLACEHOLDER,
    sourceLine: 18,
    observationKeys: ['caBundle', 'webhooks[0].clientConfig.caBundle'],
    note: 'A placeholder, substituted at deployment time. No certificate material is committed.',
  },
] as const satisfies readonly WebhookPostureField[];

/**
 * Observation labels accepted for the repository-wide corroboration that this is
 * the only committed webhook configuration under `cluster/`.
 *
 * Invariant locked: the count is READ FROM THE PAYLOAD and never hard-coded. The
 * corroborating section renders only when the server reported it, so the panel
 * cannot assert a repository-wide fact it was not told.
 */
const COMMITTED_CONFIGURATION_COUNT_KEYS: readonly string[] = [
  'committedWebhookConfigurations',
  'committedWebhookConfigurationCount',
  'webhookConfigurations',
];

/**
 * The field that decides the posture.
 *
 * Read out of the table above rather than declared a second time, and TYPED so
 * that its `path` must be `failurePolicy`: if that table is ever reordered so
 * that its first row is a different field, this line stops compiling instead of
 * silently reading the posture from the wrong value. A compile-time guarantee
 * here is what lets {@link readPosture} be total, with no unreachable
 * "the policy field is missing" branch to leave untested.
 */
const FAILURE_POLICY_FIELD: WebhookPostureField & { readonly path: 'failurePolicy' } =
  WEBHOOK_POSTURE_FIELDS[0];

/** Shared empty lists, so a payload without evidence allocates nothing. */
const NO_OBSERVATIONS: readonly ControlObservation[] = Object.freeze([]);

/**
 * How one required field compares with what was observed.
 *
 * - `match` — the observed value is the required value.
 * - `divergent` — a value was observed and it is NOT the required value. This is
 *   a finding, and both values are rendered so a reader sees the difference.
 * - `unreported` — no value was observed. This is neither a match nor a finding:
 *   silence is not evidence, so it never becomes either.
 */
type FieldOutcome = 'match' | 'divergent' | 'unreported';

/**
 * One row of the rendered posture table.
 *
 * Modelled as a discriminated union on `outcome` so that `observed` exists
 * exactly when something was observed. A row cannot claim a match, or a
 * divergence, without carrying the value it compared.
 */
type WebhookPostureRow =
  | { readonly field: WebhookPostureField; readonly outcome: 'unreported' }
  | { readonly field: WebhookPostureField; readonly outcome: 'match'; readonly observed: string }
  | {
      readonly field: WebhookPostureField;
      readonly outcome: 'divergent';
      readonly observed: string;
    };

/**
 * The posture the observed `failurePolicy` establishes.
 *
 * `undetermined` covers BOTH an unreported policy and an unrecognised one. In
 * neither case has the fail-closed posture been demonstrated, and in neither
 * case is it safe to imply it had been.
 */
type WebhookFailurePosture = 'fail-closed' | 'fail-open' | 'undetermined';

/** Everything the panel derives from one control payload. */
interface WebhookPostureModel {
  /** One row per required field, in artifact order. */
  readonly rows: readonly WebhookPostureRow[];
  /** The subset of `rows` whose observed value differs from the required one. */
  readonly divergentRows: readonly WebhookPostureRow[];
  /** See {@link WebhookFailurePosture}. */
  readonly posture: WebhookFailurePosture;
  /**
   * The number of committed webhook configurations the check reported, rendered
   * as a string. Absent when the check did not report it — the count is never
   * assumed and never hard-coded.
   */
  readonly committedConfigurationCount?: string;
  /**
   * Observations this panel has no row for, surfaced verbatim rather than
   * dropped. Discarding reported evidence would be a quieter form of the same
   * mistake as rendering it wrongly.
   */
  readonly unrecognisedObservations: readonly ControlObservation[];
}

/**
 * Reduces an observation label to a comparable form: lower-cased, with every
 * separator removed, so `clientConfig.url`, `clientconfig_url` and
 * `webhooks[0].clientConfig.url` all reduce to a common shape.
 *
 * This normalises LABELS only. Values are never normalised this way — see
 * {@link comparableValue} for the far narrower treatment they get.
 */
function normaliseLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A key shaped like a path, and therefore safe to match by suffix. */
function isPathKey(key: string): boolean {
  return key.includes('.') || key.includes('[');
}

/**
 * Decides whether an observation label addresses one of `keys`.
 *
 * Plain keys must match exactly once normalised. Path-shaped keys additionally
 * match by suffix, so a check that reports `webhooks[0].clientConfig.url` and one
 * that reports `clientConfig.url` are both understood. Suffix matching is
 * deliberately restricted to path-shaped keys: allowing it for a short key such
 * as `name` would let `matchConditions[0].name` be misread as the webhook's own
 * name, which is a different field with a different required value.
 */
function matchesKey(label: string, keys: readonly string[]): boolean {
  const normalisedLabel = normaliseLabel(label);
  if (normalisedLabel.length === 0) {
    return false;
  }
  return keys.some((key) => {
    const normalisedKey = normaliseLabel(key);
    return (
      normalisedLabel === normalisedKey ||
      (isPathKey(key) && normalisedLabel.endsWith(normalisedKey))
    );
  });
}

/**
 * Every label accepted for one field: the path the panel DISPLAYS, followed by
 * the field's explicit aliases.
 *
 * Including the displayed path keeps the panel self-consistent — the label a
 * reader sees in the Field column is a label the panel understands — and it is
 * the spelling a check that walks the committed artifact produces naturally, so
 * `clientConfig.url` and `matchConditions[0].name` are recognised without the
 * check having to know this panel's alias vocabulary.
 */
function acceptedKeys(field: WebhookPostureField): readonly string[] {
  return [field.path, ...field.observationKeys];
}

/** The first observation addressing any of `keys`, or `undefined`. */
function findObservation(
  observations: readonly ControlObservation[],
  keys: readonly string[],
): ControlObservation | undefined {
  return observations.find((observation) => matchesKey(observation.label, keys));
}

/**
 * Renders an observed value for display, verbatim.
 *
 * `null` is rendered as the token `null` on purpose. It is a MEASURED value —
 * the hook documents it as representable rather than missing — so eliding it
 * would hide evidence. An empty string is rendered as a pair of quotes for the
 * same reason: an empty table cell would read as "nothing was reported", which
 * is a different fact.
 *
 * Nothing here rounds, rescales, reformats or re-parses. A number is stringified
 * and a boolean is stringified; neither is reinterpreted.
 */
function renderObservationValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value.length === 0 ? '""' : value;
  }
  return String(value);
}

/** Strips one layer of matching quotes from `value`, if it carries any. */
function unquote(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Reduces a rendered value to the form used for comparison.
 *
 * This normalises PUNCTUATION ONLY — one layer of surrounding list brackets, one
 * layer of quotes around each element, and surrounding whitespace — so that
 * `["v1"]`, `[v1]` and `v1` compare equal, because they denote the same
 * single-element list, and so that a check reporting `timeoutSeconds` as the
 * number 5 compares equal to the committed literal `5`.
 *
 * Everything else is left strictly alone, because loosening a comparison is how
 * a weakened control passes a check (AAP §0.11.1). In particular there is NO
 * case folding, so `ignore` is not accepted as `Ignore` and `none` is not
 * accepted as `None`; NO numeric coercion or rounding, so `5.0` is not accepted
 * as `5`; NO unit conversion; NO sorting or de-duplication, so `["v1","v1beta1"]`
 * does not compare equal to `["v1"]`; and NO substring matching, so a value that
 * merely contains the required one is a divergence.
 */
function comparableValue(rendered: string): string {
  const trimmed = rendered.trim();
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unwrapped
    .split(',')
    .map((element) => unquote(element.trim()))
    .join(',');
}

/** Compares one required field with the observation addressing it. */
function buildRow(
  field: WebhookPostureField,
  observation: ControlObservation | undefined,
): WebhookPostureRow {
  if (observation === undefined) {
    return { field, outcome: 'unreported' };
  }
  const observed = renderObservationValue(observation.value);
  const outcome: FieldOutcome =
    comparableValue(observed) === comparableValue(field.required) ? 'match' : 'divergent';
  return outcome === 'match'
    ? { field, outcome: 'match', observed }
    : { field, outcome: 'divergent', observed };
}

/**
 * Reads the fail-closed posture out of the compared rows.
 *
 * INVARIANT LOCKED — the two directions are DELIBERATELY ASYMMETRIC, and the
 * asymmetry is the control:
 *
 *   * Detecting the dangerous value is LENIENT. Any casing of `Ignore` is read as
 *     fail-open, because a fail-open webhook is fail-open however the value was
 *     spelled, and failing to notice it is the outcome that matters.
 *   * Accepting the safe value is STRICT. Only the exact committed literal `Fail`
 *     establishes fail-closed. Anything else — a different casing, a different
 *     value, or silence — leaves the posture undetermined, so it can never be
 *     rendered as a confirmed fail-closed posture.
 *
 * A value that is neither is still surfaced as a divergent row, so the reader
 * sees exactly what was observed.
 *
 * @param observation - the measurement of {@link FAILURE_POLICY_FIELD}, or
 *   `undefined` when the check did not report it.
 */
function readPosture(observation: ControlObservation | undefined): WebhookFailurePosture {
  if (observation === undefined) {
    return 'undetermined';
  }
  const observed = renderObservationValue(observation.value).trim();
  if (observed.toLowerCase() === FAIL_OPEN_POLICY.toLowerCase()) {
    return 'fail-open';
  }
  return observed === FAIL_CLOSED_POLICY ? 'fail-closed' : 'undetermined';
}

/**
 * Derives everything renderable from one control payload, or from its absence.
 *
 * Called with `undefined` — while the request is in flight, when the check
 * reported nothing, or when it failed — every row is `unreported` and the
 * posture is `undetermined`. The panel therefore renders the required values it
 * is checking against in every state, and claims nothing about what is deployed.
 */
function buildPostureModel(status: ControlStatus | undefined): WebhookPostureModel {
  const observations = status?.evidence?.observations ?? NO_OBSERVATIONS;
  const consumed = new Set<ControlObservation>();

  const rows = WEBHOOK_POSTURE_FIELDS.map((field): WebhookPostureRow => {
    const observation = findObservation(observations, acceptedKeys(field));
    if (observation !== undefined) {
      consumed.add(observation);
    }
    return buildRow(field, observation);
  });

  const countObservation = findObservation(observations, COMMITTED_CONFIGURATION_COUNT_KEYS);
  if (countObservation !== undefined) {
    consumed.add(countObservation);
  }

  return {
    rows,
    divergentRows: rows.filter((row) => row.outcome === 'divergent'),
    // Read from the observation rather than from the row so that the posture and
    // the rendered row cannot disagree: both resolve the same field through the
    // same accepted labels.
    posture: readPosture(findObservation(observations, acceptedKeys(FAILURE_POLICY_FIELD))),
    committedConfigurationCount:
      countObservation === undefined
        ? undefined
        : renderObservationValue(countObservation.value),
    unrecognisedObservations: observations.filter((observation) => !consumed.has(observation)),
  };
}

/**
 * The verdict this panel renders, which is not always the verdict the check
 * reported.
 *
 * INVARIANT LOCKED — three rules, each of which only ever moves the outcome in
 * the safe direction:
 *
 *   1. An observed fail-open policy is a FAILURE, whatever verdict arrived.
 *      `Ignore` is precisely the weakness V5 closed, so no reported verdict can
 *      overrule the observation of it.
 *   2. A reported pass is downgraded to a failure when any required value
 *      diverged. `timeoutSeconds: 5` is the only committed bound on the call, and
 *      `sideEffects: None` and `admissionReviewVersions: ["v1"]` are exact
 *      values; rendering "pass" over a divergence in any of them would weaken a
 *      boundary condition to make a check look green.
 *   3. Otherwise the reported verdict stands, verbatim — including `warn` and
 *      `unknown`, which are distinct outcomes and are never rounded into a pass
 *      or a fail.
 *
 * Nothing here can move the outcome the other way: silence does not become a
 * pass, and no rule in this function can turn a reported failure into one.
 */
function resolveVerdict(status: ControlStatus, model: WebhookPostureModel): ControlVerdict {
  if (model.posture === 'fail-open') {
    return 'fail';
  }
  if (status.verdict === 'pass' && model.divergentRows.length > 0) {
    return 'fail';
  }
  return status.verdict;
}

/** How each verdict opens the rendered sentence. */
const VERDICT_WORDS: Readonly<Record<ControlVerdict, string>> = Object.freeze({
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Warning',
  unknown: 'Unknown',
});

/** What a fail-closed webhook does, in the words the panel renders. */
const FAIL_CLOSED_CLAUSE =
  'the admission webhook is fail-closed: an admission call that fails denies the request';

/**
 * What a fail-open webhook does. The wording is deliberate: a reader must be able
 * to tell from the panel alone that the webhook would be bypassed on error.
 */
const FAIL_OPEN_CLAUSE =
  'the admission webhook is fail-open: an admission call that fails is admitted anyway, ' +
  'so the webhook is bypassed on error and the request reaches the cluster unchecked';

/** What the panel says when the posture was not demonstrated. */
const UNDETERMINED_CLAUSE =
  'the failurePolicy evidence was inconclusive, so the fail-closed posture is not confirmed';

/**
 * Describes the posture in the rendered verdict sentence.
 *
 * When the posture is undetermined but the check reported a pass, the fail-closed
 * clause is used: a pass against F-005-RQ-001 IS the assertion that the webhook
 * is fail-closed, so reporting it is repeating the check's own finding rather
 * than inventing one. For every other verdict the undetermined clause is used,
 * so an unconfirmed posture is never described as confirmed.
 */
function postureClause(posture: WebhookFailurePosture, verdict: ControlVerdict): string {
  if (posture === 'fail-open') {
    return FAIL_OPEN_CLAUSE;
  }
  if (posture === 'fail-closed') {
    return FAIL_CLOSED_CLAUSE;
  }
  return verdict === 'pass' ? FAIL_CLOSED_CLAUSE : UNDETERMINED_CLAUSE;
}

/** `1 finding` / `2 findings`, so no sentence reads "1 findings". */
function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

/** `true` when `value` is a string carrying something worth rendering. */
function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Builds the one sentence the verdict affordance renders and is named by.
 *
 * It is one sentence in one element on purpose. The verdict word is not wrapped
 * in a child element, so the only element whose entire text is `Fail` in the
 * whole panel is the table cell holding the committed `failurePolicy` literal —
 * which keeps "is there a pass affordance?" an unambiguous question to ask of the
 * rendered output.
 */
function verdictSentence(
  verdict: ControlVerdict,
  status: ControlStatus,
  model: WebhookPostureModel,
): string {
  const details: string[] = [];
  if (model.divergentRows.length > 0) {
    details.push(`${plural(model.divergentRows.length, 'required value')} did not match`);
  }
  const findings = status.findings ?? [];
  if (findings.length > 0) {
    details.push(`${plural(findings.length, 'finding')} reported`);
  }
  const warnings = status.warnings ?? [];
  if (warnings.length > 0) {
    details.push(`${plural(warnings.length, 'warning')} reported`);
  }
  const suffix = details.length > 0 ? `; ${details.join('; ')}` : '';
  return `${VERDICT_WORDS[verdict]} — ${postureClause(model.posture, verdict)}${suffix}.`;
}

/** The request is in flight, so nothing is known yet. */
interface PanelStateLoading {
  readonly phase: 'loading';
}

/** The check succeeded and reported nothing about this control. */
interface PanelStateEmpty {
  readonly phase: 'empty';
}

/** The check did not complete, so there is no verdict to render. */
interface PanelStateError {
  readonly phase: 'error';
  readonly error: ControlStatusError;
}

/** The check reported this control. */
interface PanelStateResolved {
  readonly phase: 'resolved';
  readonly status: ControlStatus;
}

/**
 * The four states this panel renders, as a discriminated union.
 *
 * Invariant locked: only `resolved` carries a {@link ControlStatus}, so loading,
 * empty and error are structurally incapable of producing a verdict. That mirrors
 * the hook's own guarantee, where the error arm has no `controls` member.
 */
type PanelState = PanelStateLoading | PanelStateEmpty | PanelStateError | PanelStateResolved;

/** Shared singletons for the two states that carry no data. */
const LOADING_STATE: PanelState = Object.freeze({ phase: 'loading' as const });
const EMPTY_STATE: PanelState = Object.freeze({ phase: 'empty' as const });

/**
 * Maps one hook result onto a panel state.
 *
 * `isEmpty` is honoured explicitly rather than inferred from a length
 * comparison — the hook exposes it so that panels do not each re-derive it — and
 * a payload that reports other controls but not this one is the empty state too:
 * a control that was not reported has no verdict, and inventing one from the
 * others would be exactly the false pass this tier is built to prevent.
 */
function panelStateFromResult(
  result: UseControlStatusResult,
  controlId: ControlId,
): PanelState {
  if (result.status === 'loading') {
    return LOADING_STATE;
  }
  if (result.status === 'error') {
    return { phase: 'error', error: result.error };
  }
  if (result.isEmpty) {
    return EMPTY_STATE;
  }
  const control = selectControlStatus(result.controls, controlId);
  return control === undefined ? EMPTY_STATE : { phase: 'resolved', status: control };
}

/**
 * Heading of the panel, and therefore the accessible name of its landmark.
 *
 * It names the control the way the repository does, and it names the posture
 * rather than the artifact, because the posture is what the panel decides.
 */
const PANEL_HEADING = 'V5 — admission webhook fail-closed posture';

/** Announced while the check is in flight. */
const LOADING_MESSAGE = 'Checking the committed admission webhook posture.';

/** Announced when the check reported nothing about this control. */
const EMPTY_MESSAGE =
  'The check reported no evidence for this control, so this panel is empty and shows no verdict.';

/** Substituted for a finding the check reported without a readable message. */
const UNDESCRIBED_FINDING = 'The check reported a finding without a readable message.';

/** Rendered in the observed column when a required value was matched. */
const MATCH_NOTE = 'Matches the required value.';

/** Rendered beside an observed value that is not the required value. */
const DIVERGENCE_NOTE = 'Finding — this is not the required value.';

/**
 * What the observed column says when nothing was observed, per state.
 *
 * The four wordings are distinct because the four situations are: a check still
 * running has not reported yet, a check that failed cannot report, and a check
 * that completed and stayed silent about a field has reported nothing about it.
 * Collapsing them into one string would make an in-flight request look like a
 * completed one that found nothing.
 */
const UNREPORTED_NOTES: Readonly<Record<PanelState['phase'], string>> = Object.freeze({
  loading: 'Not checked yet.',
  empty: 'Not reported.',
  error: 'Unavailable — the check did not complete.',
  resolved: 'Not reported.',
});

/** Accessible name and label of the single re-request control. */
const REFRESH_LABEL = 'Refresh — re-request posture evidence';

/**
 * The in-flight affordance.
 *
 * `role="status"` makes it a polite live region, and the `aria-label` repeats its
 * text because `status` takes its accessible name from the author rather than
 * from its content — without the label the affordance would be reachable by role
 * but not by name.
 */
function LoadingNotice(): ReactElement {
  return (
    <p role="status" aria-label={LOADING_MESSAGE}>
      {LOADING_MESSAGE}
    </p>
  );
}

/** The empty affordance: the check completed and reported nothing to render. */
function EmptyNotice(): ReactElement {
  return (
    <p role="status" aria-label={EMPTY_MESSAGE}>
      {EMPTY_MESSAGE}
    </p>
  );
}

/**
 * Describes a failed check in one sentence, including the HTTP status verbatim so
 * that a 403 and a 500 are told apart by a reader rather than merged into a
 * generic failure.
 */
function describeError(error: ControlStatusError): string {
  const parts = [`The posture check did not complete, so no verdict is shown: ${error.message}`];
  if (error.httpStatus !== undefined) {
    parts.push(`HTTP status ${error.httpStatus}`);
  }
  if (hasText(error.reason)) {
    parts.push(`reason ${error.reason}`);
  }
  parts.push(`failure kind ${error.kind}`);
  return `${parts.join(' — ')}.`;
}

/**
 * The error affordance.
 *
 * `role="alert"` because a check that did not complete is an assertive
 * announcement, and — like `status` — it is named by its `aria-label`. Invariant
 * locked: this renders INSTEAD of a verdict, never alongside one. A 403 or a 500
 * cannot be rendered as a pass, because the state that carries an error carries
 * no {@link ControlStatus} for a verdict to come from. There is no error boundary
 * here and none is wanted: a failed request is an expected outcome to be
 * rendered, not an exception to be caught.
 */
function ErrorNotice({ error }: { readonly error: ControlStatusError }): ReactElement {
  const sentence = describeError(error);
  return (
    <p role="alert" aria-label={sentence}>
      {sentence}
    </p>
  );
}

/**
 * The verdict affordance — the central rendered decision of this panel.
 *
 * Fail-closed reads as a pass; fail-open reads as a failure and says that the
 * webhook would be bypassed on error. See {@link resolveVerdict} for the rules
 * and {@link verdictSentence} for the wording.
 */
function VerdictNotice({
  status,
  model,
}: {
  readonly status: ControlStatus;
  readonly model: WebhookPostureModel;
}): ReactElement {
  const verdict = resolveVerdict(status, model);
  const sentence = verdictSentence(verdict, status, model);
  return (
    <p role="status" aria-label={sentence} data-verdict={verdict}>
      {sentence}
    </p>
  );
}

/**
 * The requirement identifiers this panel covers: its own, first, followed by any
 * the check attributed to the control, de-duplicated so each appears once.
 *
 * Only the repository's own identifiers appear. No external benchmark or
 * hardening-guide number is asserted, because the repository enumerates none.
 */
function RequirementList({ status }: { readonly status: ControlStatus | undefined }): ReactElement {
  const reported = status?.requirementIds ?? [];
  const identifiers = Array.from(new Set([WEBHOOK_POSTURE_REQUIREMENT_ID, ...reported]));
  return (
    <p>
      Requirements covered:{' '}
      {identifiers.map((identifier, index) => (
        <span key={identifier}>
          {index > 0 ? ', ' : ''}
          <code>{identifier}</code>
        </span>
      ))}
    </p>
  );
}

/**
 * The observed cell of one row.
 *
 * The observed value is rendered ONLY when it differs from the required value, in
 * which case both are on screen and the row is marked a finding. When they agree
 * the cell says so rather than repeating the value, so every committed literal
 * appears exactly once in the rendered output and "which value is this?" has one
 * answer.
 */
function ObservedCell({
  row,
  unreportedNote,
}: {
  readonly row: WebhookPostureRow;
  readonly unreportedNote: string;
}): ReactElement {
  if (row.outcome === 'unreported') {
    return <span>{unreportedNote}</span>;
  }
  if (row.outcome === 'match') {
    return <span>{MATCH_NOTE}</span>;
  }
  return (
    <span>
      <code>{row.observed}</code> {DIVERGENCE_NOTE}
    </span>
  );
}

/**
 * The required-versus-observed table.
 *
 * Rendered in every state, because the values F-005-RQ-001 requires are a
 * property of the committed artifact rather than of any one request: a reader
 * always sees what is being checked, even while the check is in flight or after it
 * failed. Each row is a `<tr>` whose row header is the field path, so a row is
 * addressable by name individually.
 */
function PostureTable({
  rows,
  unreportedNote,
}: {
  readonly rows: readonly WebhookPostureRow[];
  readonly unreportedNote: string;
}): ReactElement {
  return (
    <table>
      <caption>
        Required values, relative to <code>webhooks[0]</code> of the committed
        configuration, and what the check observed. A row is a finding when the
        observed value differs from the required value.
      </caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Required value</th>
          <th scope="col">Observed value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field.path}>
            <th scope="row">
              <code>{row.field.path}</code>
            </th>
            <td>
              <code>{row.field.required}</code>{' '}
              {hasText(row.field.note) ? <span>{row.field.note} </span> : null}
              <span>Committed at line {row.field.sourceLine}.</span>
            </td>
            <td>
              <ObservedCell row={row} unreportedNote={unreportedNote} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Everything the check reported beyond the table: its own words, the
 * repository-wide corroboration, findings, warnings, unrecognised observations
 * and the evaluation time.
 *
 * Every section renders only when it has content, so a clean control shows no
 * empty "Findings" heading and a control with three findings shows all three —
 * the list is never truncated to the first, because the Go oracle this tier
 * mirrors reports every offender in one run (AAP §0.4.1.2).
 */
function EvidenceSections({
  status,
  model,
}: {
  readonly status: ControlStatus;
  readonly model: WebhookPostureModel;
}): ReactElement {
  const findingsHeadingId = useId();
  const warningsHeadingId = useId();
  const observationsHeadingId = useId();

  const findings = status.findings ?? [];
  const warnings = status.warnings ?? [];
  const observedAt = status.observedAt;
  const configurationCount = model.committedConfigurationCount;

  return (
    <>
      {hasText(status.summary) ? <p>{status.summary}</p> : null}
      {hasText(status.detail) ? <p>{status.detail}</p> : null}

      {configurationCount === undefined ? null : (
        <p>
          Committed webhook configurations reported under the cluster tree:{' '}
          <code>{configurationCount}</code>.
          {comparableValue(configurationCount) === '1'
            ? ' That is the sole committed webhook configuration, so this posture is the whole of it.'
            : ''}
        </p>
      )}

      {findings.length > 0 ? (
        <>
          <h3 id={findingsHeadingId}>Findings</h3>
          <ul aria-labelledby={findingsHeadingId}>
            {findings.map((finding, index) => (
              <li key={`${index}-${finding.subject ?? finding.message}`}>
                <p>{hasText(finding.message) ? finding.message : UNDESCRIBED_FINDING}</p>
                {hasText(finding.subject) ? (
                  <p>
                    Reported object: <code>{finding.subject}</code>
                  </p>
                ) : null}
                {hasText(finding.requirementId) ? (
                  <p>Attributed to requirement {finding.requirementId}.</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {warnings.length > 0 ? (
        <>
          <h3 id={warningsHeadingId}>Warnings</h3>
          <ul aria-labelledby={warningsHeadingId}>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </>
      ) : null}

      {model.unrecognisedObservations.length > 0 ? (
        <>
          <h3 id={observationsHeadingId}>Other reported observations</h3>
          <dl aria-labelledby={observationsHeadingId}>
            {model.unrecognisedObservations.map((observation, index) => (
              <div key={`${index}-${observation.label}`}>
                <dt>{observation.label}</dt>
                <dd>
                  <code>{renderObservationValue(observation.value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {hasText(observedAt) ? (
        <p>
          Evaluated at <time dateTime={observedAt}>{observedAt}</time>.
        </p>
      ) : null}
    </>
  );
}

/**
 * The whole panel, rendered from one already-decided {@link PanelState}.
 *
 * This is the only component that produces markup for the panel as a whole, so
 * the four states share one landmark, one required-values table and one refresh
 * control instead of three near-identical layouts that could drift apart.
 *
 * Markup notes, all of them deliberate:
 *   * `<section aria-labelledby>` — a landmark with an accessible name taken from
 *     the heading, so the panel is addressable by role and name.
 *   * `aria-busy` while the request is in flight, so assistive technology is told
 *     the content is changing rather than being left to infer it.
 *   * native `<table>` with `<caption>`, `<th scope="col">` and `<th scope="row">`
 *     for the field grid, and a native `<button type="button">` for the
 *     interaction — keyboard-operable with no handler of ours, because that is
 *     what a real button already is.
 *   * no `className`, no inline style and no CSS import: this tier ships no
 *     stylesheet, and nothing here conveys meaning by colour alone.
 */
function WebhookPosturePanelView({
  state,
  onRefresh,
}: {
  readonly state: PanelState;
  readonly onRefresh: () => void;
}): ReactElement {
  const headingId = useId();
  const status = state.phase === 'resolved' ? state.status : undefined;
  const model = useMemo(() => buildPostureModel(status), [status]);

  return (
    <section aria-labelledby={headingId} aria-busy={state.phase === 'loading'}>
      <h2 id={headingId}>{PANEL_HEADING}</h2>

      <p>
        Committed artifact: <code>{WEBHOOK_CONFIGURATION_SOURCE_PATH}</code>, an{' '}
        {WEBHOOK_CONFIGURATION_API_VERSION} {WEBHOOK_CONFIGURATION_KIND}.
      </p>

      {state.phase === 'loading' ? <LoadingNotice /> : null}
      {state.phase === 'empty' ? <EmptyNotice /> : null}
      {state.phase === 'error' ? <ErrorNotice error={state.error} /> : null}
      {status === undefined ? null : <VerdictNotice status={status} model={model} />}

      <RequirementList status={status} />

      <PostureTable rows={model.rows} unreportedNote={UNREPORTED_NOTES[state.phase]} />

      {status === undefined ? null : <EvidenceSections status={status} model={model} />}

      <button type="button" onClick={onRefresh}>
        {REFRESH_LABEL}
      </button>
    </section>
  );
}

/**
 * Props of {@link WebhookPosturePanel}.
 *
 * All of them are optional, and they select how the panel obtains its data:
 *
 *   * neither `status` nor `result` — the panel reads the posture itself through
 *     {@link useControlStatus}, which is how the aggregate dashboard and the
 *     request-handler-backed specs use it;
 *   * `result` — a caller that already holds a hook result (one request feeding
 *     several panels) hands it over, and the panel narrows it exactly as it would
 *     have narrowed its own;
 *   * `status` — a caller that already holds the resolved payload for this control
 *     hands that over instead, which is the cheapest way to render one specific
 *     posture.
 *
 * `result` wins when both are supplied, because it carries the loading and error
 * states that a bare payload cannot express.
 */
export interface WebhookPosturePanelProps {
  /**
   * A pre-resolved payload for this control. Rendered as the resolved state; no
   * request is made.
   */
  readonly status?: ControlStatus;
  /**
   * A pre-obtained hook result. Its loading, empty and error states are rendered
   * as such, and no request is made by this panel.
   */
  readonly result?: UseControlStatusResult;
  /**
   * Which control to read. Defaults to {@link WEBHOOK_POSTURE_CONTROL_ID} and
   * exists so the aggregate dashboard can pass the identifier it iterates rather
   * than relying on this panel's default matching it.
   */
  readonly controlId?: ControlId;
  /**
   * Called when the refresh control is used, after the underlying result — when
   * there is one — has been asked to re-issue its request. Lets a caller refresh
   * sibling panels from the same interaction.
   */
  readonly onRefresh?: () => void;
}

/**
 * Renders a {@link UseControlStatusResult} the caller already holds.
 *
 * Refreshing re-issues the underlying request AND notifies the caller, in that
 * order, so a panel-level refresh is never silently a no-op when a callback is
 * also supplied.
 */
function ResultBackedPanel({
  result,
  controlId,
  onRefresh,
}: {
  readonly result: UseControlStatusResult;
  readonly controlId: ControlId;
  readonly onRefresh?: () => void;
}): ReactElement {
  const state = useMemo(() => panelStateFromResult(result, controlId), [result, controlId]);
  const handleRefresh = useCallback(() => {
    result.refresh();
    onRefresh?.();
  }, [result, onRefresh]);
  return <WebhookPosturePanelView state={state} onRefresh={handleRefresh} />;
}

/**
 * Reads the posture through {@link useControlStatus}.
 *
 * Kept as its own component so the hook is called unconditionally: the exported
 * panel chooses between this and the prop-driven components by rendering one of
 * them, never by calling a hook behind an `if`.
 *
 * Invariant locked: data arrives ONLY through the hook. This file calls `fetch`
 * nowhere, so the guarantees the hook documents — a non-2xx status can never
 * become a verdict, an aborted request is not a failure, and every value is
 * surfaced verbatim — hold for this panel by construction.
 */
function HookBackedPanel({
  controlId,
  onRefresh,
}: {
  readonly controlId: ControlId;
  readonly onRefresh?: () => void;
}): ReactElement {
  const result = useControlStatus(controlId);
  return <ResultBackedPanel result={result} controlId={controlId} onRefresh={onRefresh} />;
}

/** Renders a payload the caller already resolved for this control. */
function StatusBackedPanel({
  status,
  onRefresh,
}: {
  readonly status: ControlStatus;
  readonly onRefresh?: () => void;
}): ReactElement {
  const state = useMemo<PanelState>(() => ({ phase: 'resolved', status }), [status]);
  const handleRefresh = useCallback(() => {
    onRefresh?.();
  }, [onRefresh]);
  return <WebhookPosturePanelView state={state} onRefresh={handleRefresh} />;
}

/**
 * The V5 posture panel: does the committed admission webhook fail closed?
 *
 * ```tsx
 * <WebhookPosturePanel />                        // reads the posture itself
 * <WebhookPosturePanel result={useControlStatus('V5')} />
 * <WebhookPosturePanel status={payload} onRefresh={recheckEverything} />
 * ```
 *
 * THE INVARIANT THIS COMPONENT LOCKS: the admission webhook is fail-closed —
 * `failurePolicy: Fail` with `timeoutSeconds: 5`, `sideEffects: None` and
 * `admissionReviewVersions: ["v1"]` — and `Ignore` (fail-open) is a failure,
 * never a pass.
 *
 * This function calls no hook of its own, which is what makes the three data
 * sources above legal to choose between at render time: each branch renders a
 * different component, and each of those calls its own hooks unconditionally.
 *
 * @param props - see {@link WebhookPosturePanelProps}. Every member is optional.
 * @returns the panel in whichever of its four states — loading, empty, error or
 *   resolved — the selected data source is in.
 */
export default function WebhookPosturePanel({
  status,
  result,
  controlId = WEBHOOK_POSTURE_CONTROL_ID,
  onRefresh,
}: WebhookPosturePanelProps): ReactElement {
  if (result !== undefined) {
    return <ResultBackedPanel result={result} controlId={controlId} onRefresh={onRefresh} />;
  }
  if (status !== undefined) {
    return <StatusBackedPanel status={status} onRefresh={onRefresh} />;
  }
  return <HookBackedPanel controlId={controlId} onRefresh={onRefresh} />;
}
