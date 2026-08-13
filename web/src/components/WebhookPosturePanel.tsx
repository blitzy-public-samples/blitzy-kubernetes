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
import { useId, useMemo, type ReactElement } from 'react';

import {
  describeType,
  readBoolean,
  readNumber,
  readString,
  selectObservation,
  strictestVerdict,
  type EffectiveVerdict,
} from '../domain/evidence';
import { V5_OBSERVATIONS } from '../domain/observationIds';
import {
  describeStatusReason,
  safeLabel,
  safeObservationValue,
  safeProse,
} from '../domain/safeText';
import { REFRESH_UNAVAILABLE_TITLE, resolveRefreshHandler } from './refreshContract';
import {
  WEBHOOK_ADMISSION_REVIEW_VERSIONS,
  WEBHOOK_FAIL_CLOSED_POLICY,
  WEBHOOK_FAIL_OPEN_POLICY,
  WEBHOOK_NAME,
  WEBHOOK_SIDE_EFFECTS,
  WEBHOOK_TIMEOUT_SECONDS,
} from '../domain/securityConstants';
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
import {
  useLiveRegionRole,
  usePanelLabelId,
  usePanelSubheading,
  useRendersOwnHeading,
} from './embeddedPanel';

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
 *
 * Re-exported from the shared domain module rather than declared a second time,
 * so the literal has ONE definition site (AAP §0.5.5) and the fixtures, the
 * config-schema tier and this panel cannot drift apart.
 */
export const FAIL_CLOSED_POLICY = WEBHOOK_FAIL_CLOSED_POLICY;

/**
 * The `failurePolicy` value that BREAKS the control: an admission call that
 * fails is admitted anyway, so the webhook is bypassed on error.
 *
 * Invariant locked: observing this value renders a FAILURE, whatever verdict the
 * server reported. See {@link resolveWebhookPostureEffectiveVerdict}.
 */
export const FAIL_OPEN_POLICY = WEBHOOK_FAIL_OPEN_POLICY;

/**
 * The wire type a required field's measured value must arrive at.
 *
 * Invariant locked, and this is the whole of the type-preservation rule: a value
 * is compared ONLY after its wire type has been checked, so a value of the wrong
 * type is never normalised into a match.
 *
 *   * `text` — a JSON string, compared with `===` against the committed literal.
 *   * `integer` — a JSON number that is an integer. The artifact commits
 *     `timeoutSeconds: 5` as an integer, and the admission API rejects the string
 *     `"5"`, so the string form is a contract mismatch rather than a match.
 *   * `list` — a JSON string holding the artifact's own list punctuation, parsed
 *     as a JSON array of strings and compared member by member. A SCALAR reported
 *     for a list-valued field can no longer normalise to the same text as the
 *     single-element list: `v1` does not parse as an array, so it is reported as
 *     the wrong type instead of matching `["v1"]`.
 */
type WebhookFieldKind = 'text' | 'integer' | 'list';

/**
 * Whether a field is part of the control itself or corroborates it.
 *
 * `posture` fields are the ones F-005-RQ-001 is made of, enumerated by
 * AAP §0.4.2.3: `failurePolicy`, `timeoutSeconds`, `sideEffects`,
 * `admissionReviewVersions`, the webhook name and the `only-gce` match condition.
 * Every one of them must be OBSERVED AND MATCHED for a pass — silence in any of
 * them withholds the pass rather than being read as agreement.
 *
 * `context` fields describe the artifact around the control. A divergence in one
 * is still a finding, because the committed literal is the committed literal, but
 * their absence does not by itself withhold a pass.
 */
type WebhookFieldRole = 'posture' | 'context';

/**
 * One required field of the committed webhook configuration.
 *
 * `identity` is the SINGLE observation label accepted for the field's measured
 * counterpart, taken from the shared identity module so that the payload a server
 * sends, the fixtures and this panel all name the measurement identically and are
 * compared with `===`. There is deliberately no alias list and no fuzzy or suffix
 * matching: an alias set is what let a second, later observation of the same field
 * go unnoticed.
 */
export interface WebhookPostureField {
  /**
   * Path of the field relative to `webhooks[0]` of the committed artifact, used
   * as the row header. Relative rather than absolute so the row header is short
   * enough to read and still unambiguous — the table caption names the object.
   */
  readonly path: string;
  /** The one accepted observation identity. See {@link V5_OBSERVATIONS}. */
  readonly identity: string;
  /** The wire type the measured value must arrive at. */
  readonly kind: WebhookFieldKind;
  /**
   * The committed value at ITS OWN type: a string for `text`, a number for
   * `integer`, and the member list for `list`. Rendered through
   * {@link requiredLiteral}, which reproduces the artifact's own punctuation.
   */
  readonly required: string | number | readonly string[];
  /** Line of {@link WEBHOOK_CONFIGURATION_SOURCE_PATH} the literal was read from. */
  readonly sourceLine: number;
  /** See {@link WebhookFieldRole}. */
  readonly role: WebhookFieldRole;
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
    identity: V5_OBSERVATIONS.failurePolicy,
    kind: 'text',
    required: WEBHOOK_FAIL_CLOSED_POLICY,
    sourceLine: 25,
    role: 'posture',
    note: 'An admission call that fails denies the request.',
  },
  {
    path: 'timeoutSeconds',
    identity: V5_OBSERVATIONS.timeoutSeconds,
    kind: 'integer',
    required: WEBHOOK_TIMEOUT_SECONDS,
    sourceLine: 24,
    role: 'posture',
    note: 'The only committed bound on the admission call.',
  },
  {
    path: 'sideEffects',
    identity: V5_OBSERVATIONS.sideEffects,
    kind: 'text',
    required: WEBHOOK_SIDE_EFFECTS,
    sourceLine: 23,
    role: 'posture',
    note: 'The webhook mutates nothing outside the admission request itself.',
  },
  {
    path: 'admissionReviewVersions',
    identity: V5_OBSERVATIONS.admissionReviewVersions,
    kind: 'list',
    required: WEBHOOK_ADMISSION_REVIEW_VERSIONS,
    sourceLine: 22,
    role: 'posture',
    note: 'The stable review version, and only that version.',
  },
  {
    path: 'name',
    identity: V5_OBSERVATIONS.webhookName,
    kind: 'text',
    required: WEBHOOK_NAME,
    sourceLine: 9,
    role: 'posture',
    note: 'Also the metadata.name of the configuration object (line 4).',
  },
  {
    path: 'matchConditions[0].name',
    identity: V5_OBSERVATIONS.matchConditionName,
    kind: 'text',
    required: 'only-gce',
    sourceLine: 20,
    role: 'posture',
    note: 'Narrows the webhook to the GCE provider.',
  },
  {
    path: 'matchConditions[0].expression',
    identity: V5_OBSERVATIONS.matchConditionExpression,
    kind: 'text',
    required: 'has(object.spec.gcePersistentDisk)',
    sourceLine: 21,
    role: 'context',
    note: 'Narrows the webhook to volumes that carry a GCE persistent disk.',
  },
  {
    path: 'rules[0].apiGroups',
    identity: V5_OBSERVATIONS.ruleApiGroups,
    kind: 'list',
    required: [''],
    sourceLine: 11,
    role: 'context',
    note: 'The core API group, written as the empty string.',
  },
  {
    path: 'rules[0].apiVersions',
    identity: V5_OBSERVATIONS.ruleApiVersions,
    kind: 'list',
    required: ['v1'],
    sourceLine: 12,
    role: 'context',
  },
  {
    path: 'rules[0].operations',
    identity: V5_OBSERVATIONS.ruleOperations,
    kind: 'list',
    required: ['CREATE'],
    sourceLine: 13,
    role: 'context',
  },
  {
    path: 'rules[0].resources',
    identity: V5_OBSERVATIONS.ruleResources,
    kind: 'list',
    required: ['persistentvolumes'],
    sourceLine: 14,
    role: 'context',
  },
  {
    path: 'rules[0].scope',
    identity: V5_OBSERVATIONS.ruleScope,
    kind: 'text',
    required: '*',
    sourceLine: 15,
    role: 'context',
    note: 'Both cluster-scoped and namespaced objects are matched.',
  },
  {
    path: 'clientConfig.url',
    identity: V5_OBSERVATIONS.clientConfigUrl,
    kind: 'text',
    required: 'https://127.0.0.1:9001/admit',
    sourceLine: 17,
    role: 'context',
    note: 'A loopback endpoint, so the call never leaves the control-plane node.',
  },
  {
    path: 'clientConfig.caBundle',
    identity: V5_OBSERVATIONS.clientConfigCaBundle,
    kind: 'text',
    required: CA_BUNDLE_PLACEHOLDER,
    sourceLine: 18,
    role: 'context',
    note: 'A placeholder, substituted at deployment time. No certificate material is committed.',
  },
] as const satisfies readonly WebhookPostureField[];

/**
 * The observation identity carrying whether the configuration could be read.
 *
 * Read separately from the field table because it is not a field of the artifact:
 * it reports whether the artifact was legible at all. A reported `false` withholds
 * the pass — nothing was measured — while it is emphatically not a divergence,
 * because an unreadable configuration is a gap in the report rather than proof of
 * a fail-open webhook.
 */
const CONFIGURATION_READABLE_IDENTITY = V5_OBSERVATIONS.configurationReadable;

/**
 * The observation identity carrying the repository-wide corroboration that this is
 * the only committed webhook configuration under `cluster/`.
 *
 * Invariant locked: the count is READ FROM THE PAYLOAD and never hard-coded, and
 * exactly ONE observation may carry it. The corroborating section renders only
 * when the server reported it, so the panel cannot assert a repository-wide fact
 * it was not told, and cannot pick between two contradictory counts by list order.
 */
const COMMITTED_CONFIGURATION_COUNT_IDENTITY = V5_OBSERVATIONS.committedConfigurationCount;

/**
 * Every identity the panel has a home for.
 *
 * Anything a payload reports outside this set is surfaced verbatim as an
 * unrecognised observation rather than dropped: discarding reported evidence would
 * be a quieter form of the same mistake as rendering it wrongly.
 */
const RECOGNISED_IDENTITIES: ReadonlySet<string> = new Set<string>([
  ...WEBHOOK_POSTURE_FIELDS.map((field) => field.identity),
  CONFIGURATION_READABLE_IDENTITY,
  COMMITTED_CONFIGURATION_COUNT_IDENTITY,
]);

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
 * One row of the rendered posture table, and therefore how one required field
 * compared with what was observed.
 *
 * Modelled as a discriminated union with ONE variant per outcome, so that
 * `observed` exists exactly when something usable was observed and `reason`
 * exists exactly when nothing usable was. A row cannot claim a match, or a
 * divergence, without carrying the value it compared, and the five outcomes are:
 *
 * - `match` — the observed value arrived at the required wire type AND is the
 *   required value.
 * - `divergent` — a value of the right type was observed and it is NOT the
 *   required value. This is a finding, and both values are rendered so a reader
 *   sees the difference.
 * - `unreported` — no observation carries the field's identity. This is neither a
 *   match nor a finding: silence is not evidence, so it never becomes either. It
 *   does, however, withhold a pass for a `posture` field.
 * - `conflict` — two or more observations carry the identity. Which of them is
 *   true is unknowable here, so neither is believed. Picking one by list order
 *   would decide the verdict by serialisation order rather than by evidence.
 * - `wrong-type` — one observation carries the identity at a type the field
 *   cannot use: a string where an integer is committed, or a scalar where a list
 *   is committed. Not a match, and not read as a divergence either, because a
 *   value the panel cannot interpret is not proof of a violation.
 */
type WebhookPostureRow =
  | {
      readonly field: WebhookPostureField;
      readonly outcome: 'unreported';
      readonly reason: string;
    }
  | { readonly field: WebhookPostureField; readonly outcome: 'conflict'; readonly reason: string }
  | {
      readonly field: WebhookPostureField;
      readonly outcome: 'wrong-type';
      readonly reason: string;
    }
  | { readonly field: WebhookPostureField; readonly outcome: 'match'; readonly observed: string }
  | {
      readonly field: WebhookPostureField;
      readonly outcome: 'divergent';
      readonly observed: string;
    };

/**
 * The posture the observed `failurePolicy` establishes.
 *
 * `undetermined` covers an unreported policy, a duplicated one, one of the wrong
 * type and an unrecognised value. In none of those cases has the fail-closed
 * posture been demonstrated, and in none of them is it safe to imply it had been.
 */
type WebhookFailurePosture = 'fail-closed' | 'fail-open' | 'undetermined';

/**
 * Whether the committed configuration was legible at all.
 *
 * `unreported` is the common case — most payloads simply do not carry the flag —
 * and is distinct from `unreadable`, which is a positive statement that nothing
 * could be measured.
 */
type ConfigurationLegibility = 'readable' | 'unreadable' | 'unreported' | 'unusable';

/** Everything the panel derives from one control payload. */
interface WebhookPostureModel {
  /** One row per required field, in artifact order. */
  readonly rows: readonly WebhookPostureRow[];
  /** The subset of `rows` whose observed value differs from the required one. */
  readonly divergentRows: readonly WebhookPostureRow[];
  /**
   * The `posture`-role rows that did not produce a usable comparison, and are
   * therefore the reason a pass is withheld. Empty when every one was measured.
   */
  readonly unprovenPostureRows: readonly WebhookPostureRow[];
  /** See {@link WebhookFailurePosture}. */
  readonly posture: WebhookFailurePosture;
  /** See {@link ConfigurationLegibility}. */
  readonly legibility: ConfigurationLegibility;
  /**
   * The verdict the EVIDENCE alone supports, independently of what the server
   * reported. See {@link summariseEvidence}.
   */
  readonly evidence: EffectiveVerdict;
  /**
   * The number of committed webhook configurations the check reported. Absent
   * when the check did not report it, or reported it twice, or reported it at a
   * type that is not a number — the count is never assumed and never hard-coded.
   */
  readonly committedConfigurationCount?: number;
  /**
   * Observations this panel has no row for, surfaced verbatim rather than
   * dropped. Discarding reported evidence would be a quieter form of the same
   * mistake as rendering it wrongly.
   */
  readonly unrecognisedObservations: readonly ControlObservation[];
}

/**
 * Renders an observed value for display, BOUNDED.
 *
 * `null` is rendered as the token `null` on purpose. It is a MEASURED value —
 * the hook documents it as representable rather than missing — so eliding it
 * would hide evidence. An empty string is rendered as a pair of quotes for the
 * same reason: an empty table cell would read as "nothing was reported", which
 * is a different fact.
 *
 * Nothing here rounds, rescales, reformats or re-parses. A number is stringified
 * and a boolean is stringified; neither is reinterpreted.
 *
 * WHAT CHANGED, AND WHY. A non-empty string used to be returned VERBATIM, with no
 * length bound and no shape guard, and it reaches the document in three places: the
 * observed cell of a divergent posture row, the reason text of a wrong-typed list
 * field, and the value of an unrecognised observation. A control reporting an
 * 8 KB `failurePolicy`, a value carrying a bidirectional override, or a value
 * carrying a PEM block or a compact token therefore put all of it on screen. The
 * value is now routed through the shared {@link safeObservationValue}, which
 * flattens control characters, redacts a credential shape whole rather than
 * truncating it, and bounds the length. DISPLAY ONLY: every comparison in
 * {@link buildRow} is made against the raw `text.value`, so no verdict moves.
 */
function renderObservationValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  // The panel's own punctuation for a genuinely empty string is kept ahead of the
  // shared guard, because `""` says "reported, and empty" in the table's own idiom
  // and the surrounding cells are quoted literals.
  return value.length === 0 ? '""' : safeObservationValue(value);
}

/**
 * Renders one required value using the artifact's own punctuation.
 *
 * A `list` field is rendered through `JSON.stringify`, which reproduces the
 * committed spelling exactly: `['v1']` renders as `["v1"]` and `['']` renders as
 * `[""]`, both byte-identical to lines 22 and 11 of the committed artifact. The
 * displayed literal and the compared value therefore come from ONE source, so
 * the table cannot show one thing and compare another.
 */
function requiredLiteral(field: WebhookPostureField): string {
  if (typeof field.required === 'string') {
    return field.required;
  }
  if (typeof field.required === 'number') {
    return String(field.required);
  }
  return JSON.stringify(field.required);
}

/**
 * Parses an observed `list` value into its members, or returns `undefined` when
 * the text is not a JSON array of strings.
 *
 * THIS IS THE TYPE-PRESERVATION RULE, and it is the whole of the fix for the
 * scalar-versus-list conflation. Nothing is unwrapped, unquoted or split on
 * commas by hand: the text must parse as a JSON array whose every member is a
 * string. The consequences, each of them deliberate:
 *
 *   * `["v1"]` parses to `['v1']` and can be compared.
 *   * `v1` does NOT parse as an array. A scalar reported for a list-valued field
 *     is therefore the WRONG TYPE rather than a match — which is what stops a
 *     malformed artifact, whose `admissionReviewVersions` is a bare string the
 *     admission API would reject, from reading as correctly configured.
 *   * `[v1]` is not valid JSON and is likewise the wrong type, so a check that
 *     renders a list without quoting its members is told so instead of being
 *     silently accepted.
 *   * `["v1", 1]` parses but is not a list of strings, so it is the wrong type.
 *   * `["v1","v1beta1"]` parses and IS a list of strings, so it is compared —
 *     and diverges, because the committed list has one member. Nothing is
 *     sorted, de-duplicated or subset-matched.
 */
function parseListMembers(rendered: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.every((member): member is string => typeof member === 'string')
    ? (parsed as readonly string[])
    : undefined;
}

/** Whether two member lists are equal, element for element and in order. */
function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((member, index) => member === right[index]);
}

/**
 * Compares one required field against the observations, wire type first.
 *
 * The order of the checks is the guarantee. Identity is resolved to EXACTLY ONE
 * observation or to nothing; the wire type is validated; and only then is the
 * value compared. No step can be reached by skipping an earlier one, so there is
 * no path on which a duplicated, absent or mistyped measurement becomes a match.
 */
function buildRow(
  field: WebhookPostureField,
  observations: readonly ControlObservation[],
): WebhookPostureRow {
  const found = selectObservation(observations, field.identity);
  if (found.state === 'conflict') {
    return { field, outcome: 'conflict', reason: found.reason };
  }
  if (found.state !== 'reported') {
    return { field, outcome: 'unreported', reason: found.reason };
  }
  const raw = found.value.value;

  if (field.kind === 'integer') {
    const observed = readNumber(observations, field.identity);
    if (observed.state !== 'reported') {
      return {
        field,
        outcome: 'wrong-type',
        reason:
          `Reported as ${describeType(raw)}; the committed value is an integer, and the ` +
          'admission API rejects a string in its place.',
      };
    }
    const matches = Number.isInteger(observed.value) && observed.value === field.required;
    return matches
      ? { field, outcome: 'match', observed: String(observed.value) }
      : { field, outcome: 'divergent', observed: String(observed.value) };
  }

  const text = readString(observations, field.identity);
  if (text.state !== 'reported') {
    return {
      field,
      outcome: 'wrong-type',
      reason: `Reported as ${describeType(raw)}; the committed value is written as text.`,
    };
  }

  if (field.kind === 'list') {
    const members = parseListMembers(text.value);
    if (members === undefined) {
      return {
        field,
        outcome: 'wrong-type',
        reason:
          `Reported as ${renderObservationValue(text.value)}, which is not a JSON list of ` +
          'strings; the committed value is a list, and a scalar in its place is a different ' +
          'shape rather than the same value written differently.',
      };
    }
    const required = field.required as readonly string[];
    // The MATCH case stringifies a list already proven equal to the local required
    // list, so what it renders is a local literal. The DIVERGENT case stringifies
    // arbitrary wire data, so the rendered form is bounded — a list is one display
    // string here, and guarding the whole rendering rather than each member keeps the
    // brackets and quoting intact instead of producing a half-redacted array literal.
    return sameMembers(members, required)
      ? { field, outcome: 'match', observed: JSON.stringify(members) }
      : { field, outcome: 'divergent', observed: safeObservationValue(JSON.stringify(members)) };
  }

  return text.value === field.required
    ? { field, outcome: 'match', observed: renderObservationValue(text.value) }
    : { field, outcome: 'divergent', observed: renderObservationValue(text.value) };
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
 * @param observations - every measured fact the check reported.
 */
function readPosture(observations: readonly ControlObservation[]): WebhookFailurePosture {
  const observed = readString(observations, FAILURE_POLICY_FIELD.identity);
  if (observed.state !== 'reported') {
    return 'undetermined';
  }
  const value = observed.value.trim();
  if (value.toLowerCase() === FAIL_OPEN_POLICY.toLowerCase()) {
    return 'fail-open';
  }
  return value === FAIL_CLOSED_POLICY ? 'fail-closed' : 'undetermined';
}

/**
 * Reads whether the committed configuration was legible at all.
 *
 * `unusable` covers a duplicated or non-boolean flag: the check said something
 * about legibility that this panel cannot act on, which withholds a pass for the
 * same reason an explicit `false` does.
 */
function readLegibility(observations: readonly ControlObservation[]): ConfigurationLegibility {
  const found = selectObservation(observations, CONFIGURATION_READABLE_IDENTITY);
  if (found.state === 'unreported') {
    return 'unreported';
  }
  const flag = readBoolean(observations, CONFIGURATION_READABLE_IDENTITY);
  if (flag.state !== 'reported') {
    return 'unusable';
  }
  return flag.value ? 'readable' : 'unreadable';
}

/**
 * The verdict the EVIDENCE alone supports — the gate a pass has to get through.
 *
 * INVARIANT LOCKED: A PASS MUST BE EARNED. The rules, in the order they apply:
 *
 *   1. A fail-open `failurePolicy`, or any divergence from a committed literal in
 *      any row, is a FAIL. The committed literal is the committed literal, so a
 *      context field that diverges is still a finding.
 *   2. An unreadable — or unusably reported — configuration withholds the pass.
 *      Nothing was measured, so nothing was demonstrated.
 *   3. Every `posture`-role row must have been measured AND matched. A row that is
 *      unreported, duplicated or of the wrong type withholds the pass, because
 *      silence is not agreement. This is what stops a payload carrying no
 *      evidence at all from rendering as a confirmed fail-closed posture.
 *   4. Only when all of the above hold is the evidence a PASS.
 *
 * Context rows that were not measured do NOT withhold the pass: F-005-RQ-001 is
 * made of the posture fields, and a check that reported those six has demonstrated
 * the requirement. Their absence is still rendered, row by row, so a reader sees
 * precisely how much of the artifact was inspected.
 */
function summariseEvidence(
  rows: readonly WebhookPostureRow[],
  posture: WebhookFailurePosture,
  legibility: ConfigurationLegibility,
): EffectiveVerdict {
  if (posture === 'fail-open') {
    return 'fail';
  }
  if (rows.some((row) => row.outcome === 'divergent')) {
    return 'fail';
  }
  if (legibility === 'unreadable' || legibility === 'unusable') {
    return 'unknown';
  }
  const proven = rows
    .filter((row) => row.field.role === 'posture')
    .every((row) => row.outcome === 'match');
  return proven ? 'pass' : 'unknown';
}

/**
 * Derives everything renderable from one control payload, or from its absence.
 *
 * Called with `undefined` — while the request is in flight, when the check
 * reported nothing, or when it failed — every row is `unreported`, the posture is
 * `undetermined` and the evidence verdict is `unknown`. The panel therefore
 * renders the required values it is checking against in every state, and claims
 * nothing about what is deployed.
 */
function buildPostureModel(status: ControlStatus | undefined): WebhookPostureModel {
  const observations = status?.evidence?.observations ?? NO_OBSERVATIONS;
  const rows = WEBHOOK_POSTURE_FIELDS.map((field) => buildRow(field, observations));
  const posture = readPosture(observations);
  const legibility = readLegibility(observations);
  const count = readNumber(observations, COMMITTED_CONFIGURATION_COUNT_IDENTITY);

  return {
    rows,
    divergentRows: rows.filter((row) => row.outcome === 'divergent'),
    unprovenPostureRows: rows.filter(
      (row) => row.field.role === 'posture' && row.outcome !== 'match',
    ),
    // Resolved from the observations through the SAME identity the row uses, so
    // the posture and the rendered row cannot disagree.
    posture,
    legibility,
    evidence: summariseEvidence(rows, posture, legibility),
    committedConfigurationCount: count.state === 'reported' ? count.value : undefined,
    unrecognisedObservations: observations.filter(
      (observation) => !RECOGNISED_IDENTITIES.has(observation.label),
    ),
  };
}

/**
 * The verdict this panel renders, which is not always the verdict the check
 * reported.
 *
 * INVARIANT LOCKED — A PASS MUST BE EARNED, and every rule here only ever moves
 * the outcome in the safe direction:
 *
 *   1. An observed fail-open policy is a FAILURE, whatever verdict arrived.
 *      `Ignore` is precisely the weakness V5 closed, so no reported verdict can
 *      overrule the observation of it. This is folded into the evidence verdict
 *      by {@link summariseEvidence}.
 *   2. A reported pass is downgraded to a failure when any required value
 *      diverged, or when the check attached a finding. `timeoutSeconds: 5` is the
 *      only committed bound on the call, and `sideEffects: None` and
 *      `admissionReviewVersions: ["v1"]` are exact values; rendering "pass" over
 *      a divergence in any of them would weaken a boundary condition to make a
 *      check look green. A pass rendered beside a finding is the same mistake in
 *      a different place.
 *   3. A reported pass is downgraded to UNKNOWN when the posture fields were not
 *      all measured. This is the rule that matters most: a payload that reports
 *      `pass` and carries no observations at all has demonstrated nothing, and
 *      before this rule existed it rendered as a confirmed fail-closed webhook.
 *   4. Otherwise the STRICTEST of the reported verdict and the evidence verdict
 *      stands, so `warn` and `unknown` remain distinct outcomes and neither is
 *      ever rounded into a pass.
 *
 * Nothing here can move the outcome the other way: silence does not become a
 * pass, and no rule in this function can turn a reported failure into one.
 *
 * Exported because the aggregate dashboard must count, filter and summarise the
 * SAME verdict this panel renders. A dashboard that re-derived it from
 * `status.verdict` would disagree with its own children (AAP §0.7.2's "failure
 * legibility": one control, one answer).
 *
 * @param status - the payload for this control, exactly as the hook parsed it.
 * @returns the verdict the panel renders for that payload.
 */
export function resolveWebhookPostureEffectiveVerdict(status: ControlStatus): EffectiveVerdict {
  return resolveVerdict(status, buildPostureModel(status));
}

/**
 * The verdict for an already-built model, so the render path decides once.
 *
 * The single implementation of the rules documented on
 * {@link resolveWebhookPostureEffectiveVerdict}, which delegates here after
 * building the model. One implementation means the exported resolver and the
 * rendered badge cannot disagree.
 */
function resolveVerdict(status: ControlStatus, model: WebhookPostureModel): ControlVerdict {
  const findingCount = status.findings.length;
  if (status.verdict === 'fail' || model.evidence === 'fail' || findingCount > 0) {
    return 'fail';
  }
  if (status.verdict === 'pass') {
    return model.evidence;
  }
  return strictestVerdict([status.verdict, model.evidence]);
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
 * INVARIANT LOCKED: the clause is a function of the OBSERVED posture and of
 * nothing else. It does not consult the verdict, and it must not: a reported pass
 * over an unreported `failurePolicy` used to print the fail-closed clause on the
 * reasoning that "a pass IS the assertion that the webhook is fail-closed", which
 * is exactly the rationalisation that lets a panel state a hardening claim it was
 * never told. An unconfirmed posture is now always described as unconfirmed, and
 * the reader is told which evidence was missing.
 */
function postureClause(posture: WebhookFailurePosture): string {
  if (posture === 'fail-open') {
    return FAIL_OPEN_CLAUSE;
  }
  if (posture === 'fail-closed') {
    return FAIL_CLOSED_CLAUSE;
  }
  return UNDETERMINED_CLAUSE;
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
  if (model.unprovenPostureRows.length > 0) {
    details.push(
      `${plural(model.unprovenPostureRows.length, 'required value')} could not be verified, ` +
        'so a pass is withheld',
    );
  }
  if (model.legibility === 'unreadable') {
    details.push('the committed configuration was reported as unreadable');
  }
  if (model.legibility === 'unusable') {
    details.push('the legibility of the committed configuration was reported unusably');
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
  return `${VERDICT_WORDS[verdict]} — ${postureClause(model.posture)}${suffix}.`;
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

/**
 * Rendered in place of a failure message that arrived empty, or that sanitized away
 * to nothing because all of it was credential-shaped or unrenderable.
 *
 * Local wording rather than an empty tail after the colon: a sentence that stops at
 * its punctuation reads as a rendering bug, and the reader still needs to be told
 * that the check did not complete.
 */
const UNDESCRIBED_FAILURE = 'the server supplied no readable explanation.';

/** Rendered in the observed column when a required value was matched. */
const MATCH_NOTE = 'Matches the required value.';

/** Rendered beside an observed value that is not the required value. */
const DIVERGENCE_NOTE = 'Finding — this is not the required value.';

/**
 * Rendered when the field was measured more than once.
 *
 * Neither value is shown and neither is believed: a check that reported one field
 * twice has said two things, and choosing between them by list order would decide
 * the verdict by serialisation order rather than by evidence.
 */
const CONFLICT_NOTE = 'Not verifiable — reported more than once.';

/**
 * Rendered when the measurement arrived at a type the field cannot use.
 *
 * A pass is withheld rather than a finding raised: a value this panel cannot
 * interpret is not proof of a violation, but it is certainly not proof that the
 * committed literal is in place.
 */
const WRONG_TYPE_NOTE = 'Not verifiable — reported at the wrong type.';

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
 * Why a reported pass can still render as Unknown.
 *
 * Stated in the rendered output rather than only in a comment, because the reader
 * who needs it is looking at a panel and not at this file.
 */
const PASS_WITHHELD_EXPLANATION =
  'A pass is withheld because the values F-005-RQ-001 is made of were not all ' +
  'demonstrated. Silence about a required value is not agreement with it, so the ' +
  'fail-closed posture is reported as unconfirmed rather than as verified.';

/**
 * The in-flight affordance.
 *
 * `role={liveStatusRole}` makes it a polite live region, and the `aria-label` repeats its
 * text because `status` takes its accessible name from the author rather than
 * from its content — without the label the affordance would be reachable by role
 * but not by name.
 */
function LoadingNotice(): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <p role={liveStatusRole} aria-label={LOADING_MESSAGE}>
      {LOADING_MESSAGE}
    </p>
  );
}

/** The empty affordance: the check completed and reported nothing to render. */
function EmptyNotice(): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <p role={liveStatusRole} aria-label={EMPTY_MESSAGE}>
      {EMPTY_MESSAGE}
    </p>
  );
}

/**
 * Describes a failed check in one sentence, including the HTTP status verbatim so
 * that a 403 and a 500 are told apart by a reader rather than merged into a
 * generic failure.
 *
 * THE SENTENCE IS LOCALLY AUTHORED and the two externally supplied parts are the
 * only ones that come from the wire. `message` and `reason` are prose the server
 * wrote, so both pass through {@link safeProse} — an error body is the one channel a
 * failing backend controls completely, and it used to be interpolated verbatim into
 * a live `role={liveAlertRole}` region and its `aria-label`. `httpStatus` is a number and
 * `kind` is a typed union of this repository's own literals, so neither is external
 * text and neither is sanitized; guarding them would only obscure that they are
 * already closed sets.
 *
 * A message that sanitizes away to nothing is replaced by local wording rather than
 * leaving the sentence dangling after its colon.
 */
function describeError(error: ControlStatusError): string {
  const message = safeProse(error.message);
  const parts = [
    `The posture check did not complete, so no verdict is shown: ${
      message.length > 0 ? message : UNDESCRIBED_FAILURE
    }`,
  ];
  if (error.httpStatus !== undefined) {
    parts.push(`HTTP status ${error.httpStatus}`);
  }
  const reason = describeStatusReason(error.reason);
  if (reason.length > 0) {
    parts.push(`reason ${reason}`);
  }
  parts.push(`failure kind ${error.kind}`);
  return `${parts.join(' — ')}.`;
}

/**
 * The error affordance.
 *
 * `role={liveAlertRole}` because a check that did not complete is an assertive
 * announcement, and — like `status` — it is named by its `aria-label`. Invariant
 * locked: this renders INSTEAD of a verdict, never alongside one. A 403 or a 500
 * cannot be rendered as a pass, because the state that carries an error carries
 * no {@link ControlStatus} for a verdict to come from. There is no error boundary
 * here and none is wanted: a failed request is an expected outcome to be
 * rendered, not an exception to be caught.
 */
function ErrorNotice({ error }: { readonly error: ControlStatusError }): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). See the note on the status role above.
  const liveAlertRole = useLiveRegionRole('alert');
  const sentence = describeError(error);
  return (
    <p role={liveAlertRole} aria-label={sentence}>
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
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  const verdict = resolveVerdict(status, model);
  const sentence = verdictSentence(verdict, status, model);
  return (
    <p role={liveStatusRole} aria-label={sentence} data-verdict={verdict}>
      {sentence}
    </p>
  );
}

/**
 * Why one posture row failed to establish its required value.
 *
 * Exhaustive over the five outcomes rather than defaulted, so a new outcome is a
 * compile error here instead of an unexplained row. `match` is unreachable from
 * the unproven list by construction and is described as such rather than left to
 * a fallback that could quietly cover a real case.
 */
function describeUnproven(row: WebhookPostureRow): string {
  switch (row.outcome) {
    case 'divergent':
      return `${DIVERGENCE_NOTE} Observed ${row.observed}.`;
    case 'conflict':
      return `${CONFLICT_NOTE} ${row.reason}`;
    case 'wrong-type':
      return `${WRONG_TYPE_NOTE} ${row.reason}`;
    case 'unreported':
      return row.reason;
    case 'match':
      return MATCH_NOTE;
  }
}

/**
 * Explains a withheld pass, and names the evidence that was missing.
 *
 * Renders ONLY when the check reported a pass and the evidence did not support
 * one, which is the case a reader is most likely to be confused by: the panel
 * says Unknown where the server said pass, so it has to say why. Every unproven
 * posture row is listed with the reason it could not be verified, so the remedy
 * is legible without reading the source.
 *
 * Silent in every other case, including a genuine pass and a genuine failure.
 */
function PassWithheldNotice({
  status,
  model,
}: {
  readonly status: ControlStatus;
  readonly model: WebhookPostureModel;
}): ReactElement | null {
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  const headingId = useId();
  if (status.verdict !== 'pass' || model.evidence === 'pass') {
    return null;
  }
  const sentence =
    `${PASS_WITHHELD_EXPLANATION} The check reported a pass for ` +
    `${WEBHOOK_POSTURE_REQUIREMENT_ID}, so the two disagree and the weaker answer is the ` +
    'one shown.';
  return (
    <section aria-labelledby={headingId} data-region="pass-withheld">
      <Subheading id={headingId}>Why a pass is withheld</Subheading>
      <p>{sentence}</p>
      {model.unprovenPostureRows.length === 0 ? null : (
        <dl>
          {model.unprovenPostureRows.map((row) => (
            <div key={row.field.path} data-unproven={row.field.path}>
              <dt>
                <code>{row.field.path}</code>
              </dt>
              <dd>{describeUnproven(row)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * The requirement identifiers this panel covers: its own, first, followed by any
 * the check attributed to the control, de-duplicated so each appears once.
 *
 * Only the repository's own identifiers appear. No external benchmark or
 * hardening-guide number is asserted, because the repository enumerates none.
 *
 * The panel's own identifier is a local constant; the reported ones are external, so
 * each is bounded as a label. De-duplication happens on the GUARDED strings, so two
 * reported identifiers that both redact to the same placeholder collapse into one
 * entry instead of rendering `[redacted], [redacted]`.
 */
function RequirementList({ status }: { readonly status: ControlStatus | undefined }): ReactElement {
  const reported = status?.requirementIds ?? [];
  const identifiers = Array.from(
    new Set([WEBHOOK_POSTURE_REQUIREMENT_ID, ...reported.map((identifier) => safeLabel(identifier))]),
  );
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
  if (row.outcome === 'conflict') {
    return (
      <span>
        {CONFLICT_NOTE} {row.reason}
      </span>
    );
  }
  if (row.outcome === 'wrong-type') {
    return (
      <span>
        {WRONG_TYPE_NOTE} {row.reason}
      </span>
    );
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
          <tr
            key={row.field.path}
            data-field={row.field.path}
            data-role={row.field.role}
            data-outcome={row.outcome}
          >
            <th scope="row">
              <code>{row.field.path}</code>
            </th>
            <td>
              <code>{requiredLiteral(row.field)}</code>{' '}
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
 *
 * EVERY STRING IN THIS COMPONENT COMES FROM THE WIRE, and that is why it is where
 * the sanitizing happens. The summary, the detail, each finding's message, subject
 * and requirement identifier, each warning, each unrecognised observation's label
 * and value, and the evaluation timestamp are all server-authored, and all of them
 * used to be interpolated verbatim and unbounded — a control could put a PEM block,
 * a compact token, a bidirectional override or a megabyte of text into any of them.
 * Prose goes through {@link safeProse}, which keeps a legible explanation legible
 * while redacting a credential shape whole and bounding the length; identifiers and
 * labels go through {@link safeLabel}, which is bounded harder and redacts an
 * identifier-shaped-like-a-token entirely, because there is nothing in such an
 * identifier worth showing.
 *
 * SANITIZE ONCE, THEN DECIDE. Each value is sanitized into a local and the emptiness
 * test is applied to the RESULT, so a field whose entire content was unrenderable
 * renders no heading and no empty paragraph rather than an empty element that reads
 * as a rendering fault.
 */
function EvidenceSections({
  status,
  model,
}: {
  readonly status: ControlStatus;
  readonly model: WebhookPostureModel;
}): ReactElement {
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  const findingsHeadingId = useId();
  const warningsHeadingId = useId();
  const observationsHeadingId = useId();

  const findings = status.findings ?? [];
  const warnings = status.warnings ?? [];
  const configurationCount = model.committedConfigurationCount;

  const summary = safeProse(status.summary);
  const detail = safeProse(status.detail);
  // Bounded as a LABEL rather than as prose: an evaluation instant is an identifier,
  // and it is placed in the `datetime` attribute as well as in the text, so the two
  // must be the same guarded string or they could disagree about what was rendered.
  const observedAt = hasText(status.observedAt) ? safeLabel(status.observedAt) : '';

  return (
    <>
      {summary.length > 0 ? <p>{summary}</p> : null}
      {detail.length > 0 ? <p>{detail}</p> : null}

      {configurationCount === undefined ? null : (
        <p>
          Committed webhook configurations reported under the cluster tree:{' '}
          <code>{String(configurationCount)}</code>.
          {configurationCount === 1
            ? ' That is the sole committed webhook configuration, so this posture is the whole of it.'
            : ''}
        </p>
      )}

      {findings.length > 0 ? (
        <>
          <Subheading id={findingsHeadingId}>Findings</Subheading>
          <ul aria-labelledby={findingsHeadingId}>
            {findings.map((finding, index) => {
              const message = safeProse(finding.message);
              const subject = safeLabel(finding.subject);
              const requirementId = safeLabel(finding.requirementId);
              return (
                // The key is deliberately index-first and uses the RAW subject: a key
                // is never placed in the document, so guarding it would buy nothing
                // and would risk collapsing two distinct findings onto one key.
                <li key={`${index}-${finding.subject ?? finding.message}`}>
                  <p>{message.length > 0 ? message : UNDESCRIBED_FINDING}</p>
                  {hasText(finding.subject) ? (
                    <p>
                      Reported object: <code>{subject}</code>
                    </p>
                  ) : null}
                  {hasText(finding.requirementId) ? (
                    <p>Attributed to requirement {requirementId}.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {warnings.length > 0 ? (
        <>
          <Subheading id={warningsHeadingId}>Warnings</Subheading>
          <ul aria-labelledby={warningsHeadingId}>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{safeProse(warning)}</li>
            ))}
          </ul>
        </>
      ) : null}

      {model.unrecognisedObservations.length > 0 ? (
        <>
          <Subheading id={observationsHeadingId}>Other reported observations</Subheading>
          <dl aria-labelledby={observationsHeadingId}>
            {model.unrecognisedObservations.map((observation, index) => (
              <div key={`${index}-${observation.label}`}>
                {/*
                  BOTH halves are guarded, and they are guarded differently. An
                  unrecognised observation is the widest channel this panel renders:
                  the label is arbitrary text this panel has no row for, and the value
                  is whatever the control chose to attach to it. Neither can be
                  checked against a local expectation, so both are bounded on shape
                  alone.
                */}
                <dt>{safeLabel(observation.label)}</dt>
                <dd>
                  <code>{renderObservationValue(observation.value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {observedAt.length > 0 ? (
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
  /**
   * The ONE handler the refresh control calls, or `undefined` when there is nothing
   * to re-request — in which case the control is disabled and says why. Resolved by
   * {@link resolveRefreshHandler} in every caller, so no branch can chain two
   * handlers or hand this an enabled do-nothing function.
   */
  readonly onRefresh: (() => void) | undefined;
}): ReactElement {
  // EMBEDDED-AWARE OWN HEADING (m3), bound once for this component.
  const rendersOwnHeading = useRendersOwnHeading();
  const headingId = useId();
  // EMBEDDED-AWARE REGION NAME (m3). The region is named by whichever heading exists: this
  // panel's own when standalone, the dashboard's control heading when embedded. Without this
  // an embedded panel would point `aria-labelledby` at an id it no longer renders, leaving a
  // region with no accessible name at all.
  const panelLabelId = usePanelLabelId(headingId);
  const status = state.phase === 'resolved' ? state.status : undefined;
  const model = useMemo(() => buildPostureModel(status), [status]);

  return (
    <section aria-labelledby={panelLabelId} aria-busy={state.phase === 'loading'}>
      {/*
        EMBEDDED-AWARE OWN HEADING (m3). Standalone, this heading names the panel's region and
        is the only title on screen. Embedded, the dashboard has already written an `h3` naming
        this control, so rendering a second title here both DUPLICATED the name and restarted
        the heading run at a shallower level than the one above it. The region keeps a name
        either way: `aria-labelledby` points at whichever heading exists.
      */}
      {rendersOwnHeading ? <h2 id={headingId}>{PANEL_HEADING}</h2> : null}

      <p>
        Committed artifact: <code>{WEBHOOK_CONFIGURATION_SOURCE_PATH}</code>, an{' '}
        {WEBHOOK_CONFIGURATION_API_VERSION} {WEBHOOK_CONFIGURATION_KIND}.
      </p>

      {state.phase === 'loading' ? <LoadingNotice /> : null}
      {state.phase === 'empty' ? <EmptyNotice /> : null}
      {state.phase === 'error' ? <ErrorNotice error={state.error} /> : null}
      {status === undefined ? null : <VerdictNotice status={status} model={model} />}
      {status === undefined ? null : <PassWithheldNotice status={status} model={model} />}

      <RequirementList status={status} />

      <PostureTable rows={model.rows} unreportedNote={UNREPORTED_NOTES[state.phase]} />

      {status === undefined ? null : <EvidenceSections status={status} model={model} />}

      <button
        type="button"
        onClick={onRefresh}
        disabled={onRefresh === undefined}
        title={onRefresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
      >
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
   * Called when the refresh control is used, REPLACING the underlying result's own
   * `refresh` rather than running alongside it. Lets a caller own the re-request —
   * refreshing sibling panels from the same interaction, for instance — while
   * guaranteeing one press is one request.
   */
  readonly onRefresh?: () => void;
  /**
   * Whether refreshing can re-request anything at all.
   *
   * `false` disables this panel's refresh affordance and explains why, which is how an
   * aggregate surface that was handed its posture directly keeps every control's button
   * consistent with its own. Defaults to `true`, so a panel used on its own is unaffected.
   */
  readonly canRefresh?: boolean;
}

/**
 * Renders a {@link UseControlStatusResult} the caller already holds.
 *
 * EXACTLY ONE REFRESH CHANNEL. A supplied `onRefresh` REPLACES `result.refresh`; the
 * two are never both called. Chaining them was a real defect rather than a
 * theoretical one: the aggregate dashboard passes the same function as both the
 * result's `refresh` and the callback, so one press issued two identical requests
 * and notified the caller twice, and nothing in either signature revealed it.
 */
function ResultBackedPanel({
  result,
  controlId,
  onRefresh,
  canRefresh = true,
}: {
  readonly result: UseControlStatusResult;
  readonly controlId: ControlId;
  readonly onRefresh?: () => void;
  readonly canRefresh?: boolean;
}): ReactElement {
  const state = useMemo(() => panelStateFromResult(result, controlId), [result, controlId]);
  const handleRefresh = resolveRefreshHandler(onRefresh, result.refresh, canRefresh);
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
  canRefresh = true,
}: {
  readonly controlId: ControlId;
  readonly onRefresh?: () => void;
  readonly canRefresh?: boolean;
}): ReactElement {
  const result = useControlStatus(controlId);
  return (
    <ResultBackedPanel
      result={result}
      controlId={controlId}
      onRefresh={onRefresh}
      canRefresh={canRefresh}
    />
  );
}

/**
 * Renders a payload the caller already resolved for this control.
 *
 * There is no request behind a handed-over payload, so the ONLY thing a refresh can
 * do here is call the caller's handler. Without one the affordance is disabled and
 * explained rather than enabled and inert.
 */
function StatusBackedPanel({
  status,
  onRefresh,
  canRefresh = true,
}: {
  readonly status: ControlStatus;
  readonly onRefresh?: () => void;
  readonly canRefresh?: boolean;
}): ReactElement {
  const state = useMemo<PanelState>(() => ({ phase: 'resolved', status }), [status]);
  const handleRefresh = resolveRefreshHandler(onRefresh, undefined, canRefresh);
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
  canRefresh = true,
}: WebhookPosturePanelProps): ReactElement {
  if (result !== undefined) {
    return (
      <ResultBackedPanel
        result={result}
        controlId={controlId}
        onRefresh={onRefresh}
        canRefresh={canRefresh}
      />
    );
  }
  if (status !== undefined) {
    return <StatusBackedPanel status={status} onRefresh={onRefresh} canRefresh={canRefresh} />;
  }
  return <HookBackedPanel controlId={controlId} onRefresh={onRefresh} canRefresh={canRefresh} />;
}
