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

// The React presentation surface for V3 — Secrets encryption at rest (feature
// F-003, the only Critical-severity control).
//
// AAP §0.5.1 (the `web/src/components/EncryptionAtRestPanel.test.tsx` row this
// component serves: "Ciphertext versus plaintext verdict rendering") /
// §0.4.2.4 (the L6 React blueprint — a happy path, an edge case, an error case,
// loading and empty states, and an interaction case driving refresh) /
// §0.7.1.3 (the >= 80 % line-and-branch floor for the React tier under Vitest
// 4's rewritten AST-aware V8 provider) / tech-spec §6.4.5 (encryption at rest) /
// tech-spec §6.6.3.4 (the documentation convention this provenance comment and
// the invariant comments below satisfy).
//
// NO PARITY ANCESTOR. `blitzy/documentation/Project Guide.md` L133 records that
// "This is a control-plane/configuration project with no UI surface", so this
// tier ports nothing and there is no prior JSX in the repository to follow. Its
// parity anchor is therefore the REST behaviour it surfaces: every value
// rendered below is measured from one of the two frozen artifacts named in the
// sections that follow, and never invented.
//
// THE SOURCES OF TRUTH, read line by line rather than summarised:
//
//   * `test/integration/secrets/encryption_test.go` — the Go oracle for V3,
//     `TestSecretsAreEncryptedAtRest` at L80. It creates a Secret whose value is
//     a known plaintext canary (L106-112), reads the RAW etcd blob past the API
//     server (L115-128) and then asserts, in this order:
//       L131 `len(resp.Kvs) != 1`                  -> t.Fatalf  (abort)
//       L136 `!bytes.HasPrefix(value, aesGCMPrefix)` -> t.Errorf (accumulate)
//       L141 `bytes.Contains(value, plaintextCanary)` -> t.Errorf (accumulate)
//       L150 read-back plaintext mismatch          -> t.Errorf (accumulate)
//     All four are rendered here as separate evidence rows. AAP §0.7.2 makes
//     assertion density part of the contract: a port that renders fewer than
//     four has weakened the control even while still passing.
//   * `cluster/gce/manifests/encryption-provider-config.yml` — the committed
//     deployment manifest. L19-22 states the mechanism the ordering rows below
//     depend on: the FIRST provider encrypts every new write and ALL listed
//     providers are tried in order when decrypting. L41-42 list the encrypted
//     resources, L46-50 the KMS v2 provider, L51-53 record that `cachesize` is a
//     v1-only tunable the API server rejects for v2, and L64 places `identity`
//     last as a decrypt-only fallback removed once the storage migration ends.
//
// THE INVARIANT THIS COMPONENT LOCKS
//   A Secret is reported encrypted at rest ONLY when the stored value BEGINS
//   WITH the AES-GCM prefix and the plaintext canary is absent. Plaintext must
//   never render as a pass. Consequently:
//     * the prefix is matched with `startsWith` — never equality, which would
//       break on every legitimate ciphertext body, and never a substring
//       search, which would also succeed when the prefix merely occurs inside
//       an otherwise unencrypted blob (the exact failure L136 exists to catch);
//     * contradicting evidence DOWNGRADES the rendered verdict and nothing ever
//       upgrades it, so a server that reports `pass` over plaintext evidence
//       still renders `fail`;
//     * loading, empty and error are separate affordances, and an error or an
//       `unknown` verdict can never reach the pass affordance.
//
// WHAT THIS COMPONENT DELIBERATELY DOES NOT RENDER
//   The raw stored blob. A blob produced by a BROKEN configuration contains
//   plaintext Secret data, so echoing it into the DOM would defeat the very
//   control this panel reports on. Only the derived facts are rendered — begins
//   with the prefix, canary absent — which is also why the canary constant is
//   named in the expectation text but the measured value it was found in is not.
//   The same reasoning mirrors the V6 confidentiality guard at the presentation
//   layer.
//
// DEPENDENCY DISCIPLINE (AAP §0.11.1). Three imports, all already present in the
// tier: `react` (pinned at 19.2.8 in web/package.json), the posture types and
// hook, and the recorded V3 constants. No design system, no CSS framework, no
// icon library, no router and no data-fetching library is introduced — and this
// component never calls `fetch` itself, so the single request path stays inside
// the hook where its abort, error and empty semantics are already proven.
//
// STYLING. There is none, deliberately. This tier has no CSS pipeline at all
// (web/vitest.config.ts sets `css: false` and web/package.json pins no styling
// dependency), so the markup is plain, semantic and unstyled: a named region, a
// heading hierarchy, a data table, lists, and a native button. Adding class
// names for a stylesheet that does not exist would be decoration, not design.
import { useId, useMemo, type ReactElement } from 'react';

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
  AESGCM_PREFIX,
  DEPLOYMENT_ENCRYPTION_CONFIG,
  PLAINTEXT_CANARY,
} from '../test/fixtures/encryptionConfig';

/**
 * The control this panel reports on.
 *
 * Exported so the aggregate dashboard and the spec address the same control
 * without either re-spelling the literal. It is deliberately NOT a prop: a
 * panel that renders V3's evidence rows against, say, V7's payload would be
 * meaningless, so the pairing is fixed here rather than left to a caller.
 */
export const ENCRYPTION_AT_REST_CONTROL_ID: ControlId = 'V3';

/**
 * The repository's own requirement identifiers this panel covers, in the order
 * AAP §0.4.2.3 and §0.4.2.2 assign them:
 *
 *   F-003-RQ-001 — the encrypted `resources` list.
 *   F-003-RQ-002 — Secrets are ciphertext at rest (the four oracle assertions).
 *   F-003-RQ-003 — provider ordering, KMS timeout, and the absent `cachesize`.
 *
 * No external benchmark or hardening-guide control name or number appears
 * anywhere in this file. AAP §0.10.1 records that the repository enumerates
 * none, so naming one would be an invention dressed up as a citation.
 */
const REQUIREMENT_IDS = ['F-003-RQ-001', 'F-003-RQ-002', 'F-003-RQ-003'] as const;

/**
 * The single `resources` rule of the committed deployment manifest.
 *
 * Read from the recorded fixture rather than re-literalled, because
 * web/src/test/fixtures/encryptionConfig.ts is the single definition site for
 * the recorded document shapes (AAP §0.5.5). Every expectation below is derived
 * from it, so a correction to the recording propagates here instead of
 * diverging — which is precisely the failure mode a second copy of these values
 * would introduce.
 */
const RECORDED_RULE = DEPLOYMENT_ENCRYPTION_CONFIG.resources[0];

/**
 * The resources the manifest encrypts: `secrets` first, then `configmaps`
 * (manifest L41-42). Order is part of the recording and is compared
 * positionally — the fixture's tuple type exists for exactly that reason.
 */
const EXPECTED_RESOURCES = RECORDED_RULE.resources;

/** The strong provider block: KMS v2, first in the list (manifest L46-50). */
const RECORDED_KMS = RECORDED_RULE.providers[0].kms;

/** The bounded gRPC budget for the envelope call: `3s` (manifest L50). */
const EXPECTED_KMS_TIMEOUT = RECORDED_KMS.timeout;

/**
 * The manifest's placeholder socket path (manifest L49). It is a placeholder in
 * the committed document and is rendered as one: the real KMS plugin socket is
 * provisioned out of band and is never committed. This is the only endpoint
 * value that appears anywhere in this file.
 */
const PLACEHOLDER_KMS_ENDPOINT = RECORDED_KMS.endpoint;

/**
 * The plaintext passthrough provider's name (manifest L64).
 *
 * Its POSITION is the boundary: last is a decrypt-only fallback, first would
 * mean every new write is stored in plaintext while the document still parses
 * and the API server still boots — a silently dead control.
 */
const IDENTITY_PROVIDER = 'identity';

/**
 * The stored-entry count that proves the raw read addressed the right object:
 * exactly one (`encryption_test.go` L131). Any other count means the etcd key
 * was derived wrongly, so every later assertion would be reading the wrong
 * object — which is why the oracle aborts there rather than accumulating.
 */
const EXPECTED_STORED_ENTRY_COUNT = 1;

/**
 * The KMS v1-only tunable the API server rejects for v2, recorded at manifest
 * L51-53 ("cachesize is not supported in v2"). Its ABSENCE is the passing
 * state.
 */
const FORBIDDEN_KMS_V2_KEY = 'cachesize';

/**
 * The evidence rows this panel renders, in render order.
 *
 * The first four mirror the four assertions of `TestSecretsAreEncryptedAtRest`
 * in source order (L131, L136, L141, L150); the next four are the committed
 * manifest's configuration boundaries; the last is context rather than a check.
 */
type EvidenceCheckId =
  | 'ciphertext-prefix'
  | 'plaintext-canary'
  | 'stored-entry-count'
  | 'plaintext-round-trip'
  | 'provider-order'
  | 'kms-timeout'
  | 'cachesize-absent'
  | 'encrypted-resources'
  | 'kms-endpoint';

/**
 * The outcome of one evidence row.
 *
 * `indeterminate` is a first-class outcome and never a quiet `satisfied`: "not
 * reported" and "reported good" are different claims, and the Go oracle pairs
 * every negative assertion with a positive control precisely because a check
 * that cannot tell them apart also passes when the mechanism under test is
 * entirely absent. `informational` marks a row that carries context and
 * deliberately contributes nothing to the verdict.
 */
type EvidenceOutcome = 'satisfied' | 'violated' | 'indeterminate' | 'informational';

/** One rendered evidence row: what was checked, what must hold, what was seen. */
interface EvidenceRow {
  readonly id: EvidenceCheckId;
  /** Row heading, from {@link ENCRYPTION_EVIDENCE_LABELS}. */
  readonly check: string;
  /** The requirement the row enforces. */
  readonly requirementId: string;
  /** The condition that must hold, stated in full so a reader can audit it. */
  readonly expectation: string;
  /** What was observed, derived — never the raw stored blob. */
  readonly observed: string;
  readonly outcome: EvidenceOutcome;
}

/**
 * The canonical spelling of each evidence row's label.
 *
 * Exported because it is also the OBSERVATION VOCABULARY: a server (or a
 * recorded fixture) that labels its `evidence.observations` with these strings
 * is matched exactly, so the mapping from wire data to rendered rows is
 * deterministic rather than a guess. Labels that differ are still matched, by
 * the keyword table below, and anything left over is surfaced verbatim instead
 * of being dropped — see {@link buildEvidenceRows}.
 */
export const ENCRYPTION_EVIDENCE_LABELS = {
  'ciphertext-prefix': 'Stored value prefix',
  'plaintext-canary': 'Plaintext canary',
  'stored-entry-count': 'Stored etcd entries',
  'plaintext-round-trip': 'Plaintext round trip',
  'provider-order': 'Provider order',
  'kms-timeout': 'KMS timeout',
  'cachesize-absent': 'cachesize key',
  'encrypted-resources': 'Encrypted resources',
  'kms-endpoint': 'KMS endpoint',
} as const satisfies Record<EvidenceCheckId, string>;

/**
 * Keyword table used to route a reported observation to an evidence row.
 *
 * WHY KEYWORDS AND NOT EXACT LABELS ONLY — `ControlObservation.label` is
 * documented as human-readable prose ("what was measured"), so an exact-match
 * table alone would silently render "not reported" for a payload that plainly
 * did report the measurement. Matching on a keyword recovers that data, and
 * every canonical label in {@link ENCRYPTION_EVIDENCE_LABELS} is itself matched
 * by the entry below it, so an aligned caller and an unaligned one land on the
 * same row.
 *
 * ORDER IS SIGNIFICANT and the sequence is deliberate: the first entry whose
 * keyword appears in the normalised label wins.
 *   * `round trip` precedes the canary entry because a round-trip label
 *     legitimately contains the word "plaintext";
 *   * the canary entry precedes the prefix entry for the same reason, since a
 *     stored-value label may mention plaintext too;
 *   * the cardinality entry precedes the prefix entry because the oracle's own
 *     phrasing for that assertion is "the raw PREFIX SCAN returns exactly one
 *     key/value pair". Measured, not assumed: with the two the other way round,
 *     a label worded like the oracle's routes the COUNT to the prefix row and
 *     leaves both rows wrong. `entr` is a stem so it matches "entry" and
 *     "entries" alike.
 * Each observation is routed to at most ONE row, and the first observation to
 * claim a row keeps it — mirroring `selectControlStatus`, where a duplicated
 * entry lets the first occurrence win rather than silently overwriting.
 */
const EVIDENCE_KEYWORDS: readonly {
  readonly id: EvidenceCheckId;
  readonly keywords: readonly string[];
}[] = [
  { id: 'plaintext-round-trip', keywords: ['round trip', 'roundtrip', 'read back', 'readback'] },
  { id: 'plaintext-canary', keywords: ['canary'] },
  { id: 'stored-entry-count', keywords: ['entr', 'key value pair', 'cardinality', 'count', 'kvs'] },
  {
    id: 'ciphertext-prefix',
    keywords: ['prefix', 'ciphertext', 'aesgcm', 'stored value', 'stored blob', 'raw value'],
  },
  { id: 'provider-order', keywords: ['provider', 'identity'] },
  { id: 'kms-timeout', keywords: ['timeout'] },
  { id: 'cachesize-absent', keywords: ['cachesize', 'cache size'] },
  { id: 'encrypted-resources', keywords: ['resource'] },
  { id: 'kms-endpoint', keywords: ['endpoint', 'socket'] },
];

/**
 * Values that read as "yes, the thing this label names holds".
 *
 * A CLOSED vocabulary, matched against the WHOLE normalised value and never as
 * a substring, so a raw stored blob can never be mistaken for a token. Note
 * that `plaintext` and `unencrypted` are denials rather than affirmations: in
 * this panel's vocabulary they name the failure, not the subject.
 */
const AFFIRMATIVE_VALUES: readonly string[] = [
  'true',
  'yes',
  'present',
  'found',
  'match',
  'matched',
  'matches',
  'ok',
  'pass',
  'passed',
  'satisfied',
  'ciphertext',
  'encrypted',
  'enabled',
];

/** Values that read as "no, it does not hold". Same closed-vocabulary rules. */
const NEGATIVE_VALUES: readonly string[] = [
  'false',
  'no',
  'absent',
  'missing',
  'none',
  'not present',
  'not found',
  'mismatch',
  'mismatched',
  'fail',
  'failed',
  'violated',
  'plaintext',
  'unencrypted',
  'disabled',
];

/** What a reported value claims about the measurement its label names. */
type ValueClaim = 'affirmed' | 'denied';

/**
 * Lower-cases a label or value and collapses every run of non-alphanumeric
 * characters to a single space.
 *
 * Used for BOTH label routing and value tokens so the two agree on what
 * "the same string" means. Nothing else about the value is altered, and the
 * normalised form is never rendered — every value shown to the reader is the
 * verbatim one or an explicit derived sentence.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Reads a value as a yes/no claim, or `undefined` when it is neither.
 *
 * A boolean is the claim directly. A string is a claim only when it matches the
 * closed vocabularies above exactly; anything else — a duration, a count, a
 * provider list, a raw blob — returns `undefined` so the caller can apply its
 * own, stricter reading. Numbers and `null` are never claims.
 */
function readValueClaim(value: ControlObservation['value']): ValueClaim | undefined {
  if (typeof value === 'boolean') {
    return value ? 'affirmed' : 'denied';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const token = normalise(value);
  if (AFFIRMATIVE_VALUES.includes(token)) {
    return 'affirmed';
  }
  return NEGATIVE_VALUES.includes(token) ? 'denied' : undefined;
}

/**
 * `true` when the label phrases the measurement as an ABSENCE, e.g. "plaintext
 * canary absent" or "no cachesize key".
 *
 * This is what makes a boolean readable: `true` against "canary absent" is the
 * passing state, while `true` against "canary present" is the failing one.
 * Applied ONLY by the two rows whose passing state is an absence — the canary
 * and the `cachesize` key — so a stray "not" elsewhere cannot invert an
 * unrelated reading.
 */
function labelAssertsAbsence(label: string): boolean {
  return /\b(absent|absence|missing|removed|omitted|not|no|none|free)\b/.test(normalise(label));
}

/**
 * Reads a whole, non-negative count.
 *
 * A number must be an integer to be a count; a string must be digits only. A
 * number-shaped string is the one coercion allowed anywhere in this file, and
 * only here, because a cardinality is unambiguous — there is no unit to lose
 * and no precision to round away. Everything else returns `undefined` and is
 * reported as indeterminate rather than guessed at.
 */
function readCount(value: ControlObservation['value']): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

/**
 * Renders a measured value as text that is safe to display.
 *
 * `null` is reported as such because the hook documents it as a REPRESENTABLE
 * measurement rather than a missing one, and an empty string is called out
 * instead of rendering as nothing at all. The literal words `undefined` and
 * `NaN` can never appear: the observation type admits neither.
 */
function describeValue(value: ControlObservation['value']): string {
  if (value === null) {
    return 'reported as null';
  }
  if (typeof value === 'string') {
    return value.trim() === '' ? 'reported as an empty value' : value;
  }
  return String(value);
}

/**
 * Splits a reported list — providers, resources — into its members.
 *
 * Accepts every separator a payload plausibly uses (comma, space, arrow,
 * bracket, slash) by keeping only runs of lower-case alphanumerics and hyphens,
 * which is what a Kubernetes provider or resource name is made of. Order is
 * preserved, because for both lists the ORDER is the boundary being checked.
 *
 * The interior hyphen is kept deliberately, because a provider name legitimately
 * contains one (`k8s-kms` in the committed manifest). Leading and trailing
 * hyphens are then stripped and hyphen-only members dropped, so an arrow
 * separator — `kms -> identity`, which a payload may well use — cannot be read as
 * a provider named `-`. Measured, not assumed: without the strip, that value
 * parses to three members and renders as `kms, -, identity`.
 */
function splitList(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((member) => member.replace(/^-+|-+$/g, ''))
    .filter((member) => member !== '');
}

/** A reading of one observation: its outcome plus the text to render for it. */
interface EvidenceReading {
  readonly outcome: EvidenceOutcome;
  readonly observed: string;
}

/** The reading used when the payload reported nothing for a row. */
const NOT_REPORTED: EvidenceReading = { outcome: 'indeterminate', observed: 'not reported' };


/**
 * Reads the ciphertext-prefix row (F-003-RQ-002, `encryption_test.go` L136).
 *
 * THE PREFIX IS MATCHED AS A PREFIX. `startsWith` is the whole assertion, and
 * the two tempting alternatives are both wrong:
 *   * equality would break on every legitimate value, because the bytes after
 *     the prefix ARE the ciphertext body;
 *   * a substring search would also succeed when the prefix merely occurs
 *     somewhere inside an otherwise unencrypted blob — exactly the failure the
 *     oracle's `bytes.HasPrefix` exists to catch.
 * A value that contains the prefix without beginning with it is therefore
 * reported as a VIOLATION and named as such, so the distinction is visible to
 * the reader rather than buried in this comment.
 *
 * The measured blob is never echoed back: a blob from a broken configuration
 * carries plaintext Secret data.
 */
function readCiphertextPrefix(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    return claim === 'affirmed'
      ? { outcome: 'satisfied', observed: `reported as beginning with ${AESGCM_PREFIX}` }
      : { outcome: 'violated', observed: `reported as NOT beginning with ${AESGCM_PREFIX}` };
  }
  if (typeof observation.value !== 'string') {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  if (observation.value.startsWith(AESGCM_PREFIX)) {
    return { outcome: 'satisfied', observed: `stored value begins with ${AESGCM_PREFIX}` };
  }
  if (observation.value.includes(AESGCM_PREFIX)) {
    return {
      outcome: 'violated',
      observed: `stored value contains ${AESGCM_PREFIX} but does not begin with it`,
    };
  }
  return { outcome: 'violated', observed: `stored value does not begin with ${AESGCM_PREFIX}` };
}

/**
 * Reads the plaintext-canary row (F-003-RQ-002, `encryption_test.go` L141).
 *
 * ABSENCE is the passing state, and this is the negative half of a pair: without
 * it a passing prefix check proves only that a prefix was WRITTEN, not that the
 * body was encrypted. Because the passing state is an absence, the label's
 * phrasing decides how a boolean reads — see {@link labelAssertsAbsence}.
 *
 * When a raw value is supplied it is searched for the canary with `includes`,
 * which is the correct semantic here and the mirror image of the prefix row: the
 * canary must not appear ANYWHERE in the blob, at any offset.
 */
function readPlaintextCanary(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    const canaryPresent = labelAssertsAbsence(observation.label)
      ? claim === 'denied'
      : claim === 'affirmed';
    return canaryPresent
      ? { outcome: 'violated', observed: `${PLAINTEXT_CANARY} reported present in the stored value` }
      : { outcome: 'satisfied', observed: `${PLAINTEXT_CANARY} reported absent from the stored value` };
  }
  if (typeof observation.value !== 'string') {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  return observation.value.includes(PLAINTEXT_CANARY)
    ? { outcome: 'violated', observed: `${PLAINTEXT_CANARY} found in the stored value` }
    : { outcome: 'satisfied', observed: `${PLAINTEXT_CANARY} absent from the stored value` };
}

/**
 * Reads the stored-entry-count row (F-003-RQ-002, `encryption_test.go` L131).
 *
 * EXACTLY ONE entry is the passing state. Any other count means the etcd key was
 * derived wrongly — the classic cause being a hardcoded `registry` prefix
 * instead of the live per-run one — so the reader is told the expected count
 * alongside the observed one. The oracle aborts on this assertion rather than
 * accumulating, because every later check would otherwise be reading the wrong
 * object.
 */
function readStoredEntryCount(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const count = readCount(observation.value);
  if (count !== undefined) {
    return count === EXPECTED_STORED_ENTRY_COUNT
      ? { outcome: 'satisfied', observed: `${String(count)} stored entry` }
      : {
          outcome: 'violated',
          observed: `${String(count)} stored entries (expected exactly ${String(
            EXPECTED_STORED_ENTRY_COUNT,
          )})`,
        };
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    return claim === 'affirmed'
      ? {
          outcome: 'satisfied',
          observed: `reported as exactly ${String(EXPECTED_STORED_ENTRY_COUNT)} stored entry`,
        }
      : {
          outcome: 'violated',
          observed: `reported as NOT exactly ${String(EXPECTED_STORED_ENTRY_COUNT)} stored entry`,
        };
  }
  return { outcome: 'indeterminate', observed: describeValue(observation.value) };
}

/**
 * Reads the plaintext round-trip row (F-003-RQ-002, `encryption_test.go` L150).
 *
 * THE SAME CONSTANT, THE OPPOSITE MEANING. The canary must be ABSENT from the
 * raw etcd blob and PRESENT when the Secret is read back through the API server;
 * together the two prove that encryption at rest is transparent to clients and
 * that the published contract is unchanged. So a reported value carrying the
 * canary satisfies THIS row while violating the canary row — which is why the
 * two are read by separate functions rather than by one shared predicate.
 */
function readPlaintextRoundTrip(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    return claim === 'affirmed'
      ? { outcome: 'satisfied', observed: 'the API server returned the original plaintext' }
      : { outcome: 'violated', observed: 'the API server did NOT return the original plaintext' };
  }
  if (typeof observation.value === 'string' && observation.value.includes(PLAINTEXT_CANARY)) {
    return { outcome: 'satisfied', observed: `the API server returned ${PLAINTEXT_CANARY}` };
  }
  return { outcome: 'indeterminate', observed: describeValue(observation.value) };
}

/**
 * Reads the provider-ordering row (F-003-RQ-003, manifest L19-22, L46, L64).
 *
 * The strong provider MUST be first and `identity` MUST be last, because the
 * first provider encrypts every new write while all of them are tried in order
 * when decrypting. Three readings follow from that, and each is reported with
 * the reason attached:
 *   * `identity` first — VIOLATION, and the severe one: every new write would be
 *     stored in plaintext while the document still parses and the API server
 *     still boots, leaving the control silently dead;
 *   * `identity` present but not last — VIOLATION, since a provider after the
 *     plaintext fallback can never be reached for a new write;
 *   * `identity` absent entirely — SATISFIED, and stronger than the recorded
 *     document: the manifest records at L60-63 that the fallback is removed once
 *     the storage migration completes, after which plaintext is no longer
 *     accepted at all.
 */
function readProviderOrder(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    return claim === 'affirmed'
      ? {
          outcome: 'satisfied',
          observed: `reported as strong provider first, ${IDENTITY_PROVIDER} last`,
        }
      : {
          outcome: 'violated',
          observed: `reported as NOT strong provider first, ${IDENTITY_PROVIDER} last`,
        };
  }
  if (typeof observation.value !== 'string') {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  const providers = splitList(observation.value);
  if (providers.length === 0) {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  const rendered = providers.join(', ');
  const identityAt = providers.indexOf(IDENTITY_PROVIDER);
  if (identityAt === 0) {
    return {
      outcome: 'violated',
      observed: `${rendered} - ${IDENTITY_PROVIDER} is first, so nothing would be encrypted`,
    };
  }
  if (identityAt > 0 && identityAt !== providers.length - 1) {
    return {
      outcome: 'violated',
      observed: `${rendered} - ${IDENTITY_PROVIDER} is not last`,
    };
  }
  return {
    outcome: 'satisfied',
    observed:
      identityAt === -1
        ? `${rendered} - no plaintext fallback present`
        : `${rendered} - strong provider first, ${IDENTITY_PROVIDER} last`,
  };
}

/**
 * Reads the KMS timeout row (F-003-RQ-003, manifest L50).
 *
 * The recorded value is the DURATION STRING `3s`, and it is compared as such.
 * A bare number is not the recorded value and is reported as a violation rather
 * than helpfully assumed to mean seconds: guessing a unit is exactly the kind of
 * normalisation that would let a real drift render as a pass.
 */
function readKmsTimeout(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    return claim === 'affirmed'
      ? { outcome: 'satisfied', observed: `reported as ${EXPECTED_KMS_TIMEOUT}` }
      : { outcome: 'violated', observed: `reported as NOT ${EXPECTED_KMS_TIMEOUT}` };
  }
  if (observation.value === null) {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  const observed = String(observation.value).trim();
  return observed === EXPECTED_KMS_TIMEOUT
    ? { outcome: 'satisfied', observed }
    : { outcome: 'violated', observed: `${observed} (expected ${EXPECTED_KMS_TIMEOUT})` };
}

/**
 * Reads the `cachesize` row (F-003-RQ-003, manifest L51-53).
 *
 * ABSENCE is the passing state: `cachesize` is a KMS v1-only tunable and the API
 * server rejects it for v2, so a configuration carrying it does not boot. A
 * concrete reported value therefore means the key is SET and is a violation,
 * while the label phrasing decides how a boolean reads.
 *
 * Note what an absent OBSERVATION means here, and what it does not: it means the
 * key was not reported on, not that it is known to be absent. That is
 * indeterminate, and treating it as satisfied would be the quiet false pass this
 * panel exists to prevent.
 */
function readCachesizeAbsent(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    const keyPresent = labelAssertsAbsence(observation.label)
      ? claim === 'denied'
      : claim === 'affirmed';
    return keyPresent
      ? {
          outcome: 'violated',
          observed: `${FORBIDDEN_KMS_V2_KEY} reported present; it is rejected for KMS v2`,
        }
      : { outcome: 'satisfied', observed: `no ${FORBIDDEN_KMS_V2_KEY} key reported` };
  }
  if (observation.value === null) {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  return {
    outcome: 'violated',
    observed: `${FORBIDDEN_KMS_V2_KEY}=${describeValue(
      observation.value,
    )}; it is rejected for KMS v2`,
  };
}

/**
 * Reads the encrypted-resources row (F-003-RQ-001, manifest L41-42).
 *
 * The recorded list is `secrets` then `configmaps`, and it is compared
 * POSITIONALLY: order is part of the recording, `secrets` leads because it also
 * covers legacy ServiceAccount-token Secrets, and the fixture's tuple type
 * exists so the compiler enforces the same thing on the recorded side. A shorter
 * list is a violation rather than a partial pass — an unencrypted resource is
 * not a rounding error.
 */
function readEncryptedResources(observation: ControlObservation | undefined): EvidenceReading {
  if (observation === undefined) {
    return NOT_REPORTED;
  }
  const expected = EXPECTED_RESOURCES.join(', ');
  const claim = readValueClaim(observation.value);
  if (claim !== undefined) {
    return claim === 'affirmed'
      ? { outcome: 'satisfied', observed: `reported as ${expected}` }
      : { outcome: 'violated', observed: `reported as NOT ${expected}` };
  }
  if (typeof observation.value !== 'string') {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  const resources = splitList(observation.value);
  if (resources.length === 0) {
    return { outcome: 'indeterminate', observed: describeValue(observation.value) };
  }
  const rendered = resources.join(', ');
  const matches =
    resources.length === EXPECTED_RESOURCES.length &&
    EXPECTED_RESOURCES.every((resource, position) => resources[position] === resource);
  return matches
    ? { outcome: 'satisfied', observed: rendered }
    : { outcome: 'violated', observed: `${rendered} (expected ${expected})` };
}

/**
 * Reads the KMS endpoint row (manifest L49).
 *
 * INFORMATIONAL BY DESIGN: the endpoint is deployment-specific context, not a
 * pass-or-fail boundary, so this row contributes nothing to the verdict. The
 * committed manifest's value is a PLACEHOLDER and is rendered as one — the real
 * KMS plugin socket is provisioned out of band and is never committed — and when
 * the payload reports no endpoint the recorded placeholder is shown instead of
 * an empty cell. A reported value that is not the placeholder is shown verbatim
 * and NOT labelled a placeholder, because saying so would be false.
 */
function readKmsEndpoint(observation: ControlObservation | undefined): EvidenceReading {
  const reported =
    observation !== undefined && typeof observation.value === 'string' && observation.value.trim() !== ''
      ? observation.value
      : PLACEHOLDER_KMS_ENDPOINT;
  return {
    outcome: 'informational',
    observed:
      reported === PLACEHOLDER_KMS_ENDPOINT
        ? `${reported} (placeholder - the real socket is provisioned out of band)`
        : reported,
  };
}


/** One reported observation this panel has no row for. */
interface EvidenceExtra {
  readonly label: string;
  readonly value: string;
}

/** Everything derived from one payload's observations, computed in one pass. */
interface EvidenceDigest {
  /** The nine rows, always all nine, in render order. */
  readonly rows: readonly EvidenceRow[];
  /** Observations that matched no row, surfaced rather than dropped. */
  readonly extras: readonly EvidenceExtra[];
  /** The verdict the evidence alone supports. See {@link summariseEvidence}. */
  readonly verdict: ControlVerdict;
}

/**
 * Substituted for an unrecognised observation whose value carries the canary.
 *
 * The presentation-layer counterpart of the confidentiality reasoning at the top
 * of this file: an unrecognised measurement is rendered verbatim so no evidence
 * is lost, EXCEPT when it carries the known plaintext marker, in which case the
 * fact is reported and the value is not.
 */
const WITHHELD_VALUE = 'withheld - the reported value carries the plaintext canary';

/**
 * The two rows that decide whether ciphertext at rest is PROVEN (the proof pair).
 *
 * Both must be satisfied for a pass, and this is the pair the Go oracle treats
 * as one proof: L136 establishes that the stored value is ciphertext produced by
 * the declared key, L141 that the known plaintext is nowhere in the blob. Either
 * alone is insufficient — a written prefix over an unencrypted body would pass
 * the first, and an unrelated key's ciphertext would pass the second.
 */
const PROOF_PAIR_CHECKS: readonly EvidenceCheckId[] = ['ciphertext-prefix', 'plaintext-canary'];

/**
 * How severe each verdict is, used to combine the reported verdict with the one
 * the evidence supports. `pass` is the LEAST severe, so combining can only ever
 * move the rendered verdict away from it.
 */
const VERDICT_SEVERITY: Record<ControlVerdict, number> = {
  pass: 0,
  unknown: 1,
  warn: 2,
  fail: 3,
};

/** The headline sentence rendered for each verdict. */
const VERDICT_HEADLINE: Record<ControlVerdict, string> = {
  pass: 'Secrets are encrypted at rest',
  fail: 'Plaintext detected - Secrets are NOT encrypted at rest',
  warn: 'Partly verified - encryption at rest is not fully proven',
  unknown: 'Not verified - no trustworthy evidence of encryption at rest',
};

/** The word rendered in an evidence row's outcome cell. */
const OUTCOME_TEXT: Record<EvidenceOutcome, string> = {
  satisfied: 'satisfied',
  violated: 'violated',
  indeterminate: 'not proven',
  informational: 'context',
};

/**
 * Routes each observation to at most one evidence row, first match and first
 * observation winning. See {@link EVIDENCE_KEYWORDS} for why order matters.
 */
function classifyObservation(label: string): EvidenceCheckId | undefined {
  const normalised = normalise(label);
  return EVIDENCE_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => normalised.includes(keyword)),
  )?.id;
}

/**
 * Reduces the reported observations to the nine rows plus whatever did not
 * match, then derives the verdict the evidence alone supports.
 *
 * Called with `undefined` when the payload reported no evidence at all, which is
 * a legitimate state and NOT an error: every row then reads "not reported", the
 * derived verdict is `unknown`, and {@link reconcileVerdict} leaves the reported
 * verdict standing rather than inventing a contradiction.
 */
function digestObservations(
  observations: readonly ControlObservation[] | undefined,
): EvidenceDigest {
  const index: Partial<Record<EvidenceCheckId, ControlObservation>> = {};
  const extras: EvidenceExtra[] = [];

  for (const observation of observations ?? []) {
    const id = classifyObservation(observation.label);
    if (id === undefined) {
      const carriesCanary =
        typeof observation.value === 'string' && observation.value.includes(PLAINTEXT_CANARY);
      extras.push({
        label: observation.label,
        value: carriesCanary ? WITHHELD_VALUE : describeValue(observation.value),
      });
      continue;
    }
    if (index[id] === undefined) {
      index[id] = observation;
    }
  }

  const rows: readonly EvidenceRow[] = [
    buildRow(
      'ciphertext-prefix',
      'F-003-RQ-002',
      `stored value begins with ${AESGCM_PREFIX} - a prefix match, never equality and never a substring search`,
      readCiphertextPrefix(index['ciphertext-prefix']),
    ),
    buildRow(
      'plaintext-canary',
      'F-003-RQ-002',
      `${PLAINTEXT_CANARY} absent from the stored value`,
      readPlaintextCanary(index['plaintext-canary']),
    ),
    buildRow(
      'stored-entry-count',
      'F-003-RQ-002',
      `exactly ${String(EXPECTED_STORED_ENTRY_COUNT)} stored entry for the Secret's etcd key`,
      readStoredEntryCount(index['stored-entry-count']),
    ),
    buildRow(
      'plaintext-round-trip',
      'F-003-RQ-002',
      'the API server returns the original plaintext on read',
      readPlaintextRoundTrip(index['plaintext-round-trip']),
    ),
    buildRow(
      'provider-order',
      'F-003-RQ-003',
      `strong provider first, ${IDENTITY_PROVIDER} last`,
      readProviderOrder(index['provider-order']),
    ),
    buildRow(
      'kms-timeout',
      'F-003-RQ-003',
      `timeout ${EXPECTED_KMS_TIMEOUT}`,
      readKmsTimeout(index['kms-timeout']),
    ),
    buildRow(
      'cachesize-absent',
      'F-003-RQ-003',
      `no ${FORBIDDEN_KMS_V2_KEY} key, which KMS v2 rejects`,
      readCachesizeAbsent(index['cachesize-absent']),
    ),
    buildRow(
      'encrypted-resources',
      'F-003-RQ-001',
      EXPECTED_RESOURCES.join(', '),
      readEncryptedResources(index['encrypted-resources']),
    ),
    buildRow(
      'kms-endpoint',
      'F-003-RQ-003',
      'a placeholder socket path in the committed manifest',
      readKmsEndpoint(index['kms-endpoint']),
    ),
  ];

  return { rows, extras, verdict: summariseEvidence(rows) };
}

/** Assembles one row from its identity, requirement, expectation and reading. */
function buildRow(
  id: EvidenceCheckId,
  requirementId: string,
  expectation: string,
  reading: EvidenceReading,
): EvidenceRow {
  return {
    id,
    check: ENCRYPTION_EVIDENCE_LABELS[id],
    requirementId,
    expectation,
    observed: reading.observed,
    outcome: reading.outcome,
  };
}

/**
 * Derives the verdict the evidence alone supports.
 *
 * The order of these tests is the security boundary:
 *   1. ANY violated row is a `fail`. One violation is enough, and a satisfied
 *      row elsewhere never offsets it.
 *   2. Both rows of the proof pair satisfied and nothing violated is a `pass`.
 *   3. Some evidence satisfied but the proof incomplete is a `warn` — reported
 *      as partial rather than promoted to a pass.
 *   4. Nothing determinable is `unknown`. The informational endpoint row is
 *      never `satisfied`, so it cannot lift this case into `warn`.
 */
function summariseEvidence(rows: readonly EvidenceRow[]): ControlVerdict {
  if (rows.some((row) => row.outcome === 'violated')) {
    return 'fail';
  }
  const proofPairSatisfied = PROOF_PAIR_CHECKS.every(
    (id) => rows.find((row) => row.id === id)?.outcome === 'satisfied',
  );
  if (proofPairSatisfied) {
    return 'pass';
  }
  return rows.some((row) => row.outcome === 'satisfied') ? 'warn' : 'unknown';
}

/**
 * Combines the reported verdict with the one the evidence supports.
 *
 * INVARIANT LOCKED: this function can only ever make the rendered verdict MORE
 * severe. There is no path from a reported `fail`, `warn` or `unknown` to a
 * rendered `pass`, so neither an error, nor an unrecognised verdict, nor
 * contradicting evidence can produce a false clean bill of health.
 *
 * The one deliberate asymmetry: evidence of `unknown` does not veto the reported
 * verdict. "The payload carried no evidence" is not a finding about encryption —
 * it is a finding about the payload, and it is already stated plainly in every
 * row of the evidence table. Manufacturing a downgrade from it would make the
 * absence of an optional field indistinguishable from a real regression.
 */
function reconcileVerdict(reported: ControlVerdict, evidence: ControlVerdict): ControlVerdict {
  if (evidence === 'unknown') {
    return reported;
  }
  return VERDICT_SEVERITY[evidence] > VERDICT_SEVERITY[reported] ? evidence : reported;
}


/**
 * Renders a transport or contract failure in words, alongside the server's own
 * message.
 *
 * The HTTP status is named whenever one exists, and `reason` — the Kubernetes
 * `Status` body's own field, e.g. `Forbidden` — is appended when the server sent
 * it. A `network` failure has no status because no response ever existed, and
 * that is said rather than papered over with a fabricated code.
 */
function describeFailure(error: ControlStatusError): string {
  if (error.httpStatus === undefined) {
    return `No response was received (${error.kind}). No verdict is available, so nothing is reported as passing.`;
  }
  const reason = error.reason === undefined ? '' : ` ${error.reason}`;
  return `HTTP ${String(error.httpStatus)}${reason} (${error.kind}). No verdict is available, so nothing is reported as passing.`;
}

/**
 * Flattens one finding into a single readable line: the offending object, the
 * message as reported, and the requirement it violates.
 *
 * `subject` and `requirementId` are optional on the wire and are omitted when
 * absent rather than rendered as an empty prefix or a bare pair of brackets.
 */
function formatFinding(finding: ControlStatus['findings'][number]): string {
  const subject = finding.subject === undefined ? '' : `${finding.subject}: `;
  const requirement = finding.requirementId === undefined ? '' : ` (${finding.requirementId})`;
  return `${subject}${finding.message}${requirement}`;
}

/** Props of the evidence table. */
interface EvidenceTableProps {
  /** Id of the heading that names the table. */
  readonly labelledBy: string;
  readonly rows: readonly EvidenceRow[];
}

/**
 * The evidence table: one row per check, always all nine, in the order the Go
 * oracle asserts them followed by the manifest's configuration boundaries.
 *
 * A real `<table>` with `<th scope>` on both axes, named by the heading above it
 * rather than by a `<caption>` so the visible heading and the accessible name
 * cannot drift apart. Every row is individually addressable by its role and its
 * accessible name, which is the concatenation of its cells, so no test
 * identifier is needed anywhere in this component.
 */
function EvidenceTable({ labelledBy, rows }: EvidenceTableProps): ReactElement {
  return (
    <table aria-labelledby={labelledBy}>
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Requirement</th>
          <th scope="col">Expected</th>
          <th scope="col">Observed</th>
          <th scope="col">Outcome</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">{row.check}</th>
            <td>{row.requirementId}</td>
            <td>{row.expectation}</td>
            <td>{row.observed}</td>
            <td>{OUTCOME_TEXT[row.outcome]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Props of a headed list of lines. */
interface TextListSectionProps {
  /** Id given to the heading, and used to name the list. */
  readonly headingId: string;
  readonly heading: string;
  readonly items: readonly string[];
}

/**
 * A heading plus a list, or nothing at all when there is nothing to list.
 *
 * Rendering nothing for an empty list is deliberate: an empty `<ul>` under a
 * heading reads as "there are findings" to anyone skimming the headings, which
 * is the opposite of the truth. Lists therefore work at 0, 1 and N items, and
 * there is no separator to leave dangling after the last one.
 */
function TextListSection({ headingId, heading, items }: TextListSectionProps): ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <h3 id={headingId}>{heading}</h3>
      <ul aria-labelledby={headingId}>
        {items.map((item, position) => (
          <li key={`${headingId}-${String(position)}`}>{item}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * Props of {@link EncryptionAtRestPanel}.
 *
 * All three are optional, and the panel is fully functional with none of them:
 * it then reads its own posture through {@link useControlStatus}. They exist so
 * a caller — the aggregate dashboard, or a spec — can drive every state
 * deterministically without a network round trip and without stubbing `fetch`.
 *
 * `result` wins over `status` when both are given, because `result` can express
 * states `status` cannot: loading, error, and the empty payload.
 */
export interface EncryptionAtRestPanelProps {
  /**
   * A complete hook result, rendered as-is. This is the deterministic route to
   * the loading, error and empty affordances.
   */
  readonly result?: UseControlStatusResult;
  /**
   * A single pre-resolved payload, rendered as a successful, non-empty result.
   * Ignored when `result` is supplied.
   */
  readonly status?: ControlStatus;
  /**
   * Replaces the refresh action. Without it the button calls the result's own
   * `refresh`, which re-issues the request; with a pre-resolved `status` and no
   * handler the button is a no-op, because there is no request to re-issue.
   */
  readonly onRefresh?: () => void;
}

/**
 * The refresh action used when a pre-resolved `status` is rendered and the caller
 * supplied no handler.
 *
 * Deliberately empty and deliberately NOT a stub: there is no request behind a
 * pre-resolved payload, so the honest behaviour is to do nothing. The button
 * still renders, stays keyboard-operable and keeps its accessible name, so the
 * affordance a real deployment shows is the affordance a caller sees.
 */
const NO_REFRESH = (): void => undefined;

/** Props of the internal view. */
interface EncryptionAtRestPanelViewProps {
  readonly result: UseControlStatusResult;
  readonly onRefresh?: () => void;
}

/**
 * The whole panel, rendered from an already-resolved result.
 *
 * STRUCTURE — a named region (`<section>` plus `aria-labelledby`, which is what
 * gives it the landmark role and its accessible name), an `<h2>` title, the
 * requirement identifiers it covers, the refresh button, then exactly ONE of the
 * four states: loading, error, empty, or resolved. `aria-busy` marks the region
 * while a request is in flight.
 *
 * WHY THE BUTTON SITS ABOVE THE STATES — it is present and operable in every one
 * of them, including the error and empty states, which is precisely when a
 * reader most wants to retry. It is never disabled, so a click during loading
 * still re-issues the request rather than silently doing nothing.
 */
function EncryptionAtRestPanelView({
  result,
  onRefresh,
}: EncryptionAtRestPanelViewProps): ReactElement {
  // One generated base id per instance, because the aggregate dashboard renders
  // eight panels into one document and duplicated ids would break every
  // aria-labelledby association at once.
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const errorHeadingId = `${baseId}-error`;
  const evidenceHeadingId = `${baseId}-evidence`;
  const findingsHeadingId = `${baseId}-findings`;
  const warningsHeadingId = `${baseId}-warnings`;
  const extrasHeadingId = `${baseId}-extras`;

  // `undefined` covers three different situations, and all three must avoid the
  // pass affordance: the request is still running, it failed, or it succeeded
  // without mentioning this control.
  const control =
    result.status === 'success'
      ? selectControlStatus(result.controls, ENCRYPTION_AT_REST_CONTROL_ID)
      : undefined;

  const digest = useMemo(() => digestObservations(control?.evidence?.observations), [control]);

  const verdict =
    control === undefined ? undefined : reconcileVerdict(control.verdict, digest.verdict);

  const reportedRequirements =
    control?.requirementIds !== undefined && control.requirementIds.length > 0
      ? control.requirementIds.join(', ')
      : undefined;

  const refresh = onRefresh ?? result.refresh;

  return (
    <section aria-labelledby={headingId} aria-busy={result.status === 'loading'}>
      <h2 id={headingId}>Secrets encryption at rest (V3)</h2>
      <p>Requirements covered: {REQUIREMENT_IDS.join(', ')}</p>
      <button
        type="button"
        onClick={() => {
          refresh();
        }}
      >
        Re-check encryption at rest
      </button>

      {result.status === 'loading' ? (
        <p role="status" aria-label="Encryption at rest status: checking">
          Checking whether the stored Secret is ciphertext...
        </p>
      ) : null}

      {result.status === 'error' ? (
        <div role="alert" aria-labelledby={errorHeadingId}>
          <h3 id={errorHeadingId}>Encryption at rest could not be verified</h3>
          <p>{result.error.message}</p>
          <p>{describeFailure(result.error)}</p>
        </div>
      ) : null}

      {result.status === 'success' && control === undefined ? (
        <p role="status" aria-label="Encryption at rest status: nothing reported">
          The server reported no posture for this control, so encryption at rest is not verified.
        </p>
      ) : null}

      {control !== undefined && verdict !== undefined ? (
        <>
          <p role="status" aria-label={`Encryption at rest verdict: ${verdict}`}>
            {verdict.toUpperCase()} - {VERDICT_HEADLINE[verdict]}
          </p>
          <p>{control.summary}</p>
          {control.detail !== undefined ? <p>{control.detail}</p> : null}
          {reportedRequirements !== undefined ? (
            <p>Reported requirements: {reportedRequirements}</p>
          ) : null}
          {control.observedAt !== undefined ? <p>Observed at {control.observedAt}</p> : null}

          <h3 id={evidenceHeadingId}>Evidence</h3>
          <EvidenceTable labelledBy={evidenceHeadingId} rows={digest.rows} />

          <TextListSection
            headingId={findingsHeadingId}
            heading="Findings"
            items={control.findings.map(formatFinding)}
          />
          <TextListSection
            headingId={warningsHeadingId}
            heading="Server warnings"
            items={control.warnings}
          />
          <TextListSection
            headingId={extrasHeadingId}
            heading="Other reported observations"
            items={digest.extras.map((extra) => `${extra.label}: ${extra.value}`)}
          />
        </>
      ) : null}
    </section>
  );
}

/** Props of the self-fetching wrapper. */
interface ConnectedEncryptionAtRestPanelProps {
  /** Forwarded to the view; see {@link EncryptionAtRestPanelProps.onRefresh}. */
  readonly onRefresh?: () => void;
}

/**
 * The panel wired to its own data source.
 *
 * Separate from the dispatcher below for a concrete reason: hooks must not be
 * called conditionally. Keeping {@link useControlStatus} inside its own
 * component means supplying `result` or `status` simply renders a DIFFERENT
 * component rather than skipping a hook call, so switching a caller between
 * driven and self-fetching is legal at any time.
 */
function ConnectedEncryptionAtRestPanel({
  onRefresh,
}: ConnectedEncryptionAtRestPanelProps): ReactElement {
  const result = useControlStatus(ENCRYPTION_AT_REST_CONTROL_ID);
  return <EncryptionAtRestPanelView result={result} onRefresh={onRefresh} />;
}

/**
 * V3 - Secrets encryption at rest.
 *
 * Renders the ciphertext-versus-plaintext verdict, the evidence behind it, the
 * findings and warnings the server reported, and the loading, empty and error
 * states. With no props it reads its own posture through
 * {@link useControlStatus}; with `result` or `status` it renders exactly what it
 * is given.
 *
 * INVARIANT LOCKED: a Secret is reported encrypted at rest ONLY when the stored
 * value BEGINS WITH the AES-GCM prefix and the plaintext canary is absent.
 * Plaintext never renders as a pass, contradicting evidence downgrades the
 * verdict, and neither an error nor an unrecognised verdict can reach the pass
 * affordance.
 *
 * @param props - see {@link EncryptionAtRestPanelProps}. All members optional.
 * @returns the rendered panel, in exactly one of its four states.
 */
export default function EncryptionAtRestPanel({
  result,
  status,
  onRefresh,
}: EncryptionAtRestPanelProps): ReactElement {
  if (result !== undefined) {
    return <EncryptionAtRestPanelView result={result} onRefresh={onRefresh} />;
  }
  if (status !== undefined) {
    return (
      <EncryptionAtRestPanelView
        result={{ status: 'success', controls: [status], isEmpty: false, refresh: NO_REFRESH }}
        onRefresh={onRefresh}
      />
    );
  }
  return <ConnectedEncryptionAtRestPanel onRefresh={onRefresh} />;
}

