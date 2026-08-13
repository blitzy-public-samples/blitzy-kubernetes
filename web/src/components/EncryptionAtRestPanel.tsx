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
import { REFRESH_UNAVAILABLE_TITLE, resolveRefreshHandler } from './refreshContract';
import {
  AESGCM_PREFIX,
  PLAINTEXT_CANARY,
  REQUIRED_ENCRYPTION_CONFIG_SHAPE,
} from '../domain/securityConstants';
import {
  describeType,
  readBoolean,
  readNullable,
  readNumber,
  strictestVerdict,
  type EvidenceAbsenceReason,
} from '../domain/evidence';
import { V3_ASSERTION_TITLES, V3_OBSERVATIONS } from '../domain/observationIds';
import { safeLabel, safeProse } from '../domain/safeText';
import {
  useLiveRegionRole,
  usePanelLabelId,
  usePanelSubheading,
  useRendersOwnHeading,
} from './embeddedPanel';

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
const RECORDED_RULE = REQUIRED_ENCRYPTION_CONFIG_SHAPE.rule;

/**
 * The resources the manifest encrypts: `secrets` first, then `configmaps`
 * (manifest L41-42). Order is part of the recording and is compared
 * positionally — the fixture's tuple type exists for exactly that reason.
 */
const EXPECTED_RESOURCES = RECORDED_RULE.resources;

/** The strong provider block: KMS v2, first in the list (manifest L46-50). */
const RECORDED_KMS = RECORDED_RULE.strongProvider;

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
 * The prefix a HARDCODED storage path uses, and the boundary AAP §0.10.2 names.
 *
 * The live prefix is a per-run UUID followed by this word, so the bare word on its
 * own is the mistake: it addresses a key that does not exist, the raw read returns
 * zero entries, and the cardinality assertion then fails for entirely the wrong
 * reason. It is named here so the shape row can call that case out explicitly.
 */
const HARDCODED_STORAGE_PREFIX = 'registry';

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
  | 'stored-entry-count'
  | 'ciphertext-prefix'
  | 'plaintext-canary'
  | 'canary-literal'
  | 'plaintext-round-trip'
  | 'storage-prefix-live'
  | 'storage-prefix-shape'
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
  'stored-entry-count': 'Stored etcd entries',
  'ciphertext-prefix': 'Stored value prefix',
  'plaintext-canary': 'Plaintext canary in the raw blob',
  'canary-literal': 'Canary searched for',
  'plaintext-round-trip': 'Plaintext round trip',
  'storage-prefix-live': 'Storage prefix source',
  'storage-prefix-shape': 'Storage prefix shape',
  'provider-order': 'Provider order',
  'kms-timeout': 'KMS timeout',
  'cachesize-absent': 'cachesize key',
  'encrypted-resources': 'Encrypted resources',
  'kms-endpoint': 'KMS endpoint',
} as const satisfies Record<EvidenceCheckId, string>;

/**
 * The STABLE IDENTITY of the observation each row is measured from.
 *
 * THIS TABLE REPLACES A KEYWORD MATCHER, and the replacement is the substance of
 * the V3 contract fix. The previous version routed an observation to a row by
 * testing whether its normalised label CONTAINED one of a list of keywords, first
 * keyword and first observation winning. The recorded passing payload carries two
 * canary-related measurements — the canary STRING that was searched for, and the
 * BOOLEAN answer to whether it was present in the raw blob — and both contain the
 * word "canary". The string arrived first, claimed the row, and was read as a
 * present canary because a non-empty string containing the canary is exactly what
 * "the canary is present" looks like. The explicit `false` that followed was then
 * DISCARDED, because the row was already taken. A recorded PASS rendered as
 * "Plaintext detected", inverting the most serious of the eight controls.
 *
 * Identities come from `../domain/observationIds`, so the string a payload writes
 * and the string this panel looks for are the same one by construction; the two
 * canary measurements now have two identities and two rows, and no observation can
 * claim a row it does not name.
 */
const CHECK_IDENTITY: Record<EvidenceCheckId, string> = {
  'stored-entry-count': V3_OBSERVATIONS.etcdEntryCount,
  'ciphertext-prefix': V3_OBSERVATIONS.rawValuePrefix,
  'plaintext-canary': V3_OBSERVATIONS.canaryPresentInRawBlob,
  'canary-literal': V3_OBSERVATIONS.canaryLiteral,
  'plaintext-round-trip': V3_OBSERVATIONS.plaintextRoundTrip,
  'storage-prefix-live': V3_OBSERVATIONS.storagePrefixFromLiveConfig,
  'storage-prefix-shape': V3_OBSERVATIONS.storagePrefixShape,
  'provider-order': V3_OBSERVATIONS.providerOrder,
  'kms-timeout': V3_OBSERVATIONS.kmsTimeout,
  'cachesize-absent': V3_OBSERVATIONS.cachesizeKey,
  'encrypted-resources': V3_OBSERVATIONS.encryptedResources,
  'kms-endpoint': V3_OBSERVATIONS.kmsEndpoint,
};

/** Every identity this panel recognises, for separating out the unrecognised. */
const RECOGNISED_IDENTITIES: readonly string[] = Object.values(CHECK_IDENTITY);

/**
 * The four rows that constitute the CIPHERTEXT PROOF — the four assertions of
 * `TestSecretsAreEncryptedAtRest`, and nothing less.
 *
 * The previous version required only the prefix and the canary, so a payload that
 * reported neither a stored-entry count nor a round-trip could still render a
 * clean pass. All four are load-bearing and each fails differently: the count
 * proves the raw read addressed the right object, the prefix proves the value was
 * written by the declared transformer, the canary proves the BODY was encrypted
 * rather than merely prefixed, and the round trip proves the encryption is
 * transparent to clients.
 *
 * This set has a SECOND role that the two sets below deliberately do not share: it
 * is what "partial proof" means. `summariseEvidence` reports `warn` when some but
 * not all of THESE rows are satisfied, and nothing else may lift a payload out of
 * `unknown` — see the reasoning recorded there.
 */
const CIPHERTEXT_PROOF_CHECKS: readonly EvidenceCheckId[] = [
  'stored-entry-count',
  'ciphertext-prefix',
  'plaintext-canary',
  'plaintext-round-trip',
];

/**
 * The PRECONDITION a pass additionally rests on: the etcd key was derived from the
 * LIVE storage prefix (AAP §0.10.2).
 *
 * WHY THIS IS NOW REQUIRED. The live prefix embeds a per-run UUID, so a harness
 * that hardcoded `registry` addresses a key that does not exist. While this row was
 * merely rendered, its ABSENCE let all four proof rows pass on their own: the gate
 * in {@link digestObservations} only closed when the observation was present AND
 * reported `false`, so a payload that never measured it — or reported it twice, or
 * at the wrong type — sailed through with a clean pass over four assertions about
 * an object nobody had confirmed was the right one.
 *
 * It is kept OUT of {@link CIPHERTEXT_PROOF_CHECKS} rather than merged into it, and
 * that separation is load-bearing: having read a storage prefix from the live
 * configuration says nothing whatsoever about ciphertext, so it must not be able to
 * lift a payload from `unknown` to "partly verified".
 */
const REQUIRED_PRECONDITION_CHECKS: readonly EvidenceCheckId[] = ['storage-prefix-live'];

/**
 * The COMMITTED MANIFEST rows a pass additionally rests on (F-003-RQ-001 and
 * F-003-RQ-003).
 *
 * WHY THESE ARE NO LONGER OPTIONAL. This panel attributes itself to all three V3
 * requirements, and while only the ciphertext proof could move the verdict, two of
 * those three claims rested on measurements that could not fail them. The four
 * runtime assertions prove that a Secret written through THE TEST'S OWN API server
 * was ciphertext at rest; they say nothing about the document a real deployment
 * loads, and the two most dangerous V3 regressions are invisible to them. Put
 * `identity` first in the provider list and every new write is plaintext while a
 * test server configured with `aesgcm` still passes all four. Add `cachesize` under
 * a KMS v2 provider and the API server refuses to load the configuration at all.
 *
 * They are also kept out of {@link CIPHERTEXT_PROOF_CHECKS}, for the same reason
 * the precondition is: a correct manifest is not partial evidence that a stored
 * Secret is ciphertext.
 *
 * `kms-endpoint`, `storage-prefix-shape` and `canary-literal` are deliberately
 * absent from every required set. All three are INFORMATIONAL by construction —
 * they never return `satisfied` — so requiring one would make a pass unreachable
 * rather than make it stricter.
 */
const REQUIRED_CONFIGURATION_CHECKS: readonly EvidenceCheckId[] = [
  'encrypted-resources',
  'provider-order',
  'kms-timeout',
  'cachesize-absent',
];

/**
 * The provider kinds that ENCRYPT, verbatim from the API type that defines them —
 * `staging/src/k8s.io/apiserver/pkg/apis/apiserver/v1/types_encryption.go` L89-101,
 * whose `ProviderConfiguration` declares exactly five JSON keys: `aesgcm`,
 * `aescbc`, `secretbox`, `identity` and `kms`.
 *
 * `identity` is the one that does not encrypt, so it is excluded here and named
 * separately. This closed set is what makes "the first provider is strong" a
 * decidable statement: previously ANY list without `identity` was accepted, so a
 * list naming a single unrecognised provider — a typo, a removed provider, or a
 * plaintext-equivalent one — passed the ordering check outright.
 */
const ENCRYPTING_PROVIDER_KINDS: readonly string[] = ['aesgcm', 'aescbc', 'secretbox', 'kms'];

/** Longest list a provider or resource observation may carry before it is unreadable. */
const MAX_LIST_MEMBERS = 16;

/** Longest a single list member may be: the DNS label limit, which every kind respects. */
const MAX_LIST_MEMBER_LENGTH = 63;


/**
 * Describes a measured value by its TYPE and PRESENCE, never by its content.
 *
 * THE WHOLE POINT: a string measured by this control may be a raw stored blob,
 * and a blob produced by a BROKEN configuration contains plaintext Secret data.
 * The previous version rendered every unrecognised string verbatim unless it
 * happened to contain the one known canary — so any OTHER Secret data in the
 * blob went straight to the DOM, and from there into every screenshot and DOM
 * snapshot taken of it. Withholding only the known marker protected the test
 * fixture rather than the data.
 *
 * A boolean, a number and `null` are rendered as themselves: none of them can
 * carry a Secret's bytes, and hiding them would lose real information. `null` is
 * reported as `null` because the hook documents it as a REPRESENTABLE measurement
 * rather than a missing one. The words `undefined` and `NaN` can never appear —
 * the observation type admits neither.
 */
function describeShape(value: ControlObservation['value']): string {
  if (value === null) {
    return 'reported as null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return `reported as the ${describeType(value)} ${String(value)}`;
  }
  if (value.length === 0) {
    return 'reported as an empty string';
  }
  return `reported as a string of ${String(value.length)} characters (value withheld)`;
}

/**
 * Renders a string verbatim ONLY when its whole shape is bounded and safe.
 *
 * The two rows that legitimately echo a reported string — the KMS timeout and the
 * KMS endpoint — do so through this gate, so a payload cannot use either row as a
 * channel for arbitrary bytes. A value that does not match its row's bounded
 * pattern is described by {@link describeShape} instead, which still tells the
 * reader that a value arrived and what shape it had.
 */
function echoIfBounded(value: string, allowed: RegExp): string | undefined {
  return allowed.test(value) ? value : undefined;
}

/** A Go duration as the manifest writes it: digits plus one unit, nothing else. */
const DURATION_SHAPE = /^\d{1,6}(?:ns|us|ms|s|m|h)$/;

/** A unix socket path, the only endpoint form the manifest uses. */
const UNIX_SOCKET_SHAPE = /^unix:\/\/\/[A-Za-z0-9._/-]{1,120}$/;

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
function splitList(value: string): readonly string[] | undefined {
  const members = value
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((member) => member.replace(/^-+|-+$/g, ''))
    .filter((member) => member !== '');
  if (members.length === 0 || members.length > MAX_LIST_MEMBERS) {
    return undefined;
  }
  // A member longer than a DNS label is not a provider or resource name, so the
  // value is not a list at all — it is something else, possibly a blob, and it is
  // reported by shape rather than parsed into plausible-looking members.
  return members.some((member) => member.length > MAX_LIST_MEMBER_LENGTH) ? undefined : members;
}

/** A reading of one observation: its outcome plus the text to render for it. */
interface EvidenceReading {
  readonly outcome: EvidenceOutcome;
  readonly observed: string;
}

/**
 * Explains why a typed read produced nothing, WITHOUT disclosing a string value.
 *
 * Three reasons and three different sentences, because they mean different
 * things: the payload did not measure it, the payload measured it twice and the
 * two cannot be reconciled, or it measured it at a type this row cannot use.
 */
function describeMissing(
  observations: readonly ControlObservation[] | undefined,
  identity: string,
  state: EvidenceAbsenceReason,
): string {
  if (state === 'unreported') {
    return 'not reported';
  }
  if (state === 'conflict') {
    return 'reported more than once, so which value applies cannot be determined';
  }
  const raw = readNullable(observations, identity);
  return raw.state === 'reported' ? describeShape(raw.value) : 'not reported';
}

/** Builds the indeterminate reading for a failed typed read. */
function unreadable(
  observations: readonly ControlObservation[] | undefined,
  identity: string,
  state: EvidenceAbsenceReason,
): EvidenceReading {
  return { outcome: 'indeterminate', observed: describeMissing(observations, identity, state) };
}

/**
 * Reads the stored-entry-count row (F-003-RQ-002, `encryption_test.go` L131).
 *
 * EXACTLY ONE entry is the passing state, and a real NUMBER is required: a
 * numeric string is a different claim about the server that produced it, and this
 * row is the gate every later row depends on, so it is the last place to start
 * coercing.
 *
 * A count other than one is INDETERMINATE rather than violated. The oracle aborts
 * here (`t.Fatalf`) precisely because every later assertion would be reading an
 * object that was never found — the classic cause being a storage prefix
 * hardcoded to `registry` instead of read from the live per-run configuration.
 * That is a broken measurement, not evidence of plaintext, and reporting it as an
 * encryption failure would blame the control for the harness's mistake.
 */
function readStoredEntryCount(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['stored-entry-count'];
  const found = readNumber(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  if (found.value === EXPECTED_STORED_ENTRY_COUNT) {
    return { outcome: 'satisfied', observed: `${String(found.value)} stored entry` };
  }
  return {
    outcome: 'indeterminate',
    observed:
      `${String(found.value)} stored entries (expected exactly ` +
      `${String(EXPECTED_STORED_ENTRY_COUNT)}); the raw read did not address the Secret's key, ` +
      'so nothing downstream can be evaluated',
  };
}

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
 * carries plaintext Secret data, so every branch below renders a DERIVED sentence
 * about the value rather than the value itself.
 */
function readCiphertextPrefix(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['ciphertext-prefix'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  const { value } = found;
  if (value === null) {
    return {
      outcome: 'violated',
      observed: 'reported as null: the stored value carries no transformer prefix',
    };
  }
  if (typeof value !== 'string') {
    return { outcome: 'indeterminate', observed: describeShape(value) };
  }
  if (value.startsWith(AESGCM_PREFIX)) {
    return { outcome: 'satisfied', observed: `stored value begins with ${AESGCM_PREFIX}` };
  }
  if (value.includes(AESGCM_PREFIX)) {
    return {
      outcome: 'violated',
      observed: `stored value contains ${AESGCM_PREFIX} but does not begin with it`,
    };
  }
  return { outcome: 'violated', observed: `stored value does not begin with ${AESGCM_PREFIX}` };
}

/**
 * Reads the canary-presence row (F-003-RQ-002, `encryption_test.go` L141).
 *
 * ONE IDENTITY, ONE ANSWER, AND IT IS A BOOLEAN. This row reads
 * {@link V3_OBSERVATIONS.canaryPresentInRawBlob}, whose name states its polarity:
 * `true` means the plaintext marker was found in the raw blob, which is the
 * failure. There is no label-phrasing heuristic any more, and there is no reading
 * of the canary STRING as an answer — that string is a separate identity with a
 * separate row, which is what the previous keyword matcher conflated.
 *
 * ABSENCE is the passing state, and this is the negative half of a pair: without
 * it a passing prefix check proves only that a prefix was WRITTEN, not that the
 * body was encrypted.
 */
function readPlaintextCanary(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['plaintext-canary'];
  const found = readBoolean(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  return found.value
    ? { outcome: 'violated', observed: `${PLAINTEXT_CANARY} reported present in the raw blob` }
    : { outcome: 'satisfied', observed: `${PLAINTEXT_CANARY} reported absent from the raw blob` };
}

/**
 * Reads which marker was searched for (context for the row above).
 *
 * INFORMATIONAL, but not inert: when the reported marker is NOT the recorded
 * canary, the absence proved above is an absence of something else, so
 * {@link digestObservations} withholds the canary row rather than accepting a
 * proof about the wrong string. The reported marker is only echoed when it equals
 * the recorded constant — a value this file already names — and is otherwise
 * described by shape.
 */
function readCanaryLiteral(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['canary-literal'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return {
      outcome: 'informational',
      observed: describeMissing(observations, identity, found.state),
    };
  }
  if (found.value === PLAINTEXT_CANARY) {
    return { outcome: 'informational', observed: `${PLAINTEXT_CANARY} - the recorded marker` };
  }
  return {
    outcome: 'informational',
    observed: `a marker other than ${PLAINTEXT_CANARY} was searched for (${describeShape(
      found.value,
    )})`,
  };
}

/**
 * Reads the plaintext round-trip row (F-003-RQ-002, `encryption_test.go` L150).
 *
 * A BOOLEAN, from its own identity. The oracle compares the value read back
 * through the API server against the original plaintext, so the payload reports
 * the ANSWER — and a payload that echoed the round-tripped Secret value instead
 * would be publishing the plaintext it is meant to be proving is protected. The
 * previous version accepted such a value as proof when it happened to contain the
 * canary; it no longer does, and a string here is reported by shape.
 */
function readPlaintextRoundTrip(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['plaintext-round-trip'];
  const found = readBoolean(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  return found.value
    ? { outcome: 'satisfied', observed: 'the API server returned the original plaintext' }
    : { outcome: 'violated', observed: 'the API server did NOT return the original plaintext' };
}

/**
 * Reads whether the etcd key was derived from the LIVE storage prefix.
 *
 * AAP §0.10.2 boundary: the prefix embeds a per-run UUID, so hardcoding
 * `registry` addresses a key that does not exist. Reported `false` is therefore
 * INDETERMINATE and not a violation — it says the measurement is untrustworthy,
 * not that Secrets are in plaintext — and {@link digestObservations} uses it to
 * withhold the three rows that depend on having read the right object. That
 * distinction is the whole reason the recorded indeterminate payload carries this
 * observation.
 */
function readStoragePrefixLive(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['storage-prefix-live'];
  const found = readBoolean(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  return found.value
    ? { outcome: 'satisfied', observed: 'read from the live configuration' }
    : {
        outcome: 'indeterminate',
        observed:
          'reported as NOT read from the live configuration, so the raw read may have addressed ' +
          'a key that does not exist',
      };
}

/**
 * Reads the shape of the storage prefix (context only).
 *
 * The value is never parsed into a prefix to compare against — it embeds a
 * per-run UUID and changes every run, which is precisely why it must be read from
 * the live configuration. Only its SHAPE is reported, and the bare `registry`
 * case is called out by name because that is the hardcoded form the boundary
 * exists to catch.
 */
function readStoragePrefixShape(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['storage-prefix-shape'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return {
      outcome: 'informational',
      observed: describeMissing(observations, identity, found.state),
    };
  }
  const { value } = found;
  if (typeof value !== 'string') {
    return { outcome: 'informational', observed: describeShape(value) };
  }
  if (value === HARDCODED_STORAGE_PREFIX) {
    return {
      outcome: 'informational',
      observed: `the bare ${HARDCODED_STORAGE_PREFIX} prefix, which is the hardcoded form`,
    };
  }
  return {
    outcome: 'informational',
    observed: value.endsWith(`/${HARDCODED_STORAGE_PREFIX}`)
      ? `a per-run prefix ending in /${HARDCODED_STORAGE_PREFIX}`
      : describeShape(value),
  };
}

/**
 * Reads the provider-ordering row (F-003-RQ-003, manifest L19-22, L46, L64).
 *
 * The strong provider MUST be first and `identity` MUST be last, because the
 * first provider encrypts every new write while all of them are tried in order
 * when decrypting.
 *
 * WHAT CHANGED, AND WHY IT MATTERED. The previous version treated the ABSENCE of
 * `identity` as satisfied on its own, so ANY list without it passed — including a
 * single unrecognised provider. "No plaintext fallback" is only stronger than the
 * recorded document when something in the list actually encrypts, so the first
 * member is now checked against {@link ENCRYPTING_PROVIDER_KINDS}, the closed set
 * the API type itself declares.
 *
 * An unrecognised first member is INDETERMINATE rather than violated: the payload
 * may legitimately be reporting provider NAMES (the manifest's KMS provider is
 * named `k8s-kms`) rather than kinds, and this row must not assert a defect it
 * cannot demonstrate. It does not pass, which is the requirement.
 */
function readProviderOrder(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['provider-order'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  const { value } = found;
  if (typeof value !== 'string') {
    return { outcome: 'indeterminate', observed: describeShape(value) };
  }
  const providers = splitList(value);
  if (providers === undefined) {
    return { outcome: 'indeterminate', observed: describeShape(value) };
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
    return { outcome: 'violated', observed: `${rendered} - ${IDENTITY_PROVIDER} is not last` };
  }
  const [first] = providers;
  if (first === undefined || !ENCRYPTING_PROVIDER_KINDS.includes(first)) {
    return {
      outcome: 'indeterminate',
      observed:
        `${rendered} - the first provider is not one of the encrypting kinds ` +
        `(${ENCRYPTING_PROVIDER_KINDS.join(', ')}), so it cannot be confirmed to encrypt`,
    };
  }
  return {
    outcome: 'satisfied',
    observed:
      identityAt === -1
        ? `${rendered} - encrypting provider first, no plaintext fallback present`
        : `${rendered} - encrypting provider first, ${IDENTITY_PROVIDER} last`,
  };
}

/**
 * Reads the KMS timeout row (F-003-RQ-003, manifest L50).
 *
 * The recorded value is the DURATION STRING `3s`, and it is compared as such.
 * A bare number is not the recorded value and is reported as a violation rather
 * than helpfully assumed to mean seconds: guessing a unit is exactly the kind of
 * normalisation that would let a real drift render as a pass.
 *
 * A mismatching value is echoed only when its whole shape is a bounded duration,
 * so this row cannot be used as a channel for arbitrary bytes.
 */
function readKmsTimeout(observations: readonly ControlObservation[] | undefined): EvidenceReading {
  const identity = CHECK_IDENTITY['kms-timeout'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  const { value } = found;
  if (value === EXPECTED_KMS_TIMEOUT) {
    return { outcome: 'satisfied', observed: EXPECTED_KMS_TIMEOUT };
  }
  if (typeof value === 'number') {
    return {
      outcome: 'violated',
      observed: `${String(value)} names no unit (expected ${EXPECTED_KMS_TIMEOUT})`,
    };
  }
  if (typeof value !== 'string') {
    return { outcome: 'indeterminate', observed: describeShape(value) };
  }
  const echoed = echoIfBounded(value, DURATION_SHAPE);
  return {
    outcome: 'violated',
    observed: `${echoed ?? describeShape(value)} (expected ${EXPECTED_KMS_TIMEOUT})`,
  };
}

/**
 * Reads the `cachesize` row (F-003-RQ-003, manifest L51-53).
 *
 * ABSENCE is the passing state: `cachesize` is a KMS v1-only tunable and the API
 * server rejects it for v2, so a configuration carrying it does not boot. A
 * reported `null` or `false` therefore satisfies the row, and any concrete value
 * violates it.
 *
 * Note what an absent OBSERVATION means here, and what it does not: it means the
 * key was not reported on, not that it is known to be absent. That is
 * indeterminate, and treating it as satisfied would be the quiet false pass this
 * panel exists to prevent.
 */
function readCachesizeAbsent(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['cachesize-absent'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  const { value } = found;
  if (value === null || value === false) {
    return { outcome: 'satisfied', observed: `no ${FORBIDDEN_KMS_V2_KEY} key is set` };
  }
  if (value === true) {
    return {
      outcome: 'violated',
      observed: `${FORBIDDEN_KMS_V2_KEY} reported present; it is rejected for KMS v2`,
    };
  }
  return {
    outcome: 'violated',
    observed: `${FORBIDDEN_KMS_V2_KEY} is set (${describeShape(
      value,
    )}); it is rejected for KMS v2`,
  };
}

/**
 * Reads the encrypted-resources row (F-003-RQ-001, manifest L41-42).
 *
 * The recorded list is `secrets` then `configmaps`, and it is compared
 * POSITIONALLY: order is part of the recording, `secrets` leads because it also
 * covers legacy ServiceAccount-token Secrets, and the domain's tuple exists so the
 * compiler enforces the same thing on the recorded side. A shorter list is a
 * violation rather than a partial pass — an unencrypted resource is not a rounding
 * error.
 */
function readEncryptedResources(
  observations: readonly ControlObservation[] | undefined,
): EvidenceReading {
  const identity = CHECK_IDENTITY['encrypted-resources'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported') {
    return unreadable(observations, identity, found.state);
  }
  const { value } = found;
  if (typeof value !== 'string') {
    return { outcome: 'indeterminate', observed: describeShape(value) };
  }
  const resources = splitList(value);
  if (resources === undefined) {
    return { outcome: 'indeterminate', observed: describeShape(value) };
  }
  const expected = EXPECTED_RESOURCES.join(', ');
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
 * the payload reports no endpoint the recorded placeholder is shown instead of an
 * empty cell. A reported value is echoed only when its whole shape is a unix
 * socket path, and is never labelled a placeholder unless it is one.
 */
function readKmsEndpoint(observations: readonly ControlObservation[] | undefined): EvidenceReading {
  const identity = CHECK_IDENTITY['kms-endpoint'];
  const found = readNullable(observations, identity);
  if (found.state !== 'reported' || typeof found.value !== 'string' || found.value === '') {
    return {
      outcome: 'informational',
      observed:
        `${PLACEHOLDER_KMS_ENDPOINT} (placeholder from the recorded manifest; none was ` +
        'reported)',
    };
  }
  if (found.value === PLACEHOLDER_KMS_ENDPOINT) {
    return {
      outcome: 'informational',
      observed: `${PLACEHOLDER_KMS_ENDPOINT} (placeholder - the real socket is provisioned out of band)`,
    };
  }
  const echoed = echoIfBounded(found.value, UNIX_SOCKET_SHAPE);
  return { outcome: 'informational', observed: echoed ?? describeShape(found.value) };
}

/**
 * One reported observation this panel has no row for.
 *
 * `shape` rather than `value`, and that is the point (see {@link describeShape}):
 * an unrecognised measurement is REPORTED so nothing is silently dropped, but its
 * string content is never rendered, because an unrecognised observation on THIS
 * control is exactly where a raw stored blob would arrive.
 */
interface EvidenceExtra {
  readonly label: string;
  readonly shape: string;
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
 * Withheld when the measurement it depended on could not be trusted.
 *
 * Not "not reported": the payload DID report it, and saying otherwise would send
 * a reader looking for a missing field instead of at the gate above it.
 */
function withheldBecause(reason: string): EvidenceReading {
  return { outcome: 'indeterminate', observed: `withheld: ${reason}` };
}

/**
 * Why the live-storage-prefix precondition closed the gate, per way of failing.
 *
 * Four cases and four sentences, because they send a reader to four different places:
 * the harness reported the prefix was not read from the live configuration; nobody
 * measured it; two observations disagree about it; or it arrived at a type that is not
 * a boolean. Keyed on `readBoolean`'s own state plus `'reported'` for the `false` case,
 * so the mapping is exhaustive by construction and a fifth state added upstream would
 * be a `tsc --noEmit` error here rather than an empty explanation.
 */
const PREFIX_LIVE_GATE_REASON: Readonly<Record<EvidenceAbsenceReason | 'reported', string>> =
  Object.freeze({
    reported: 'the storage prefix was not read from the live configuration',
    unreported:
      'it was never reported whether the storage prefix was read from the live ' +
      'configuration, so the raw read may have addressed a key that does not exist',
    conflict:
      'the storage prefix source was reported more than once, so whether the raw read ' +
      'addressed the right key cannot be determined',
    'wrong-type':
      'the storage prefix source was reported at a type that is not a boolean, so ' +
      'whether the raw read addressed the right key cannot be determined',
  });

/**
 * Reduces the reported observations to the twelve rows plus whatever did not
 * match, then derives the verdict the evidence alone supports.
 *
 * THE ABORT GATE. The oracle asserts cardinality with `t.Fatalf` and the other
 * three with `t.Errorf` (`encryption_test.go` L131 versus L136, L141, L150), and
 * that asymmetry is load-bearing rather than stylistic: if the raw read did not
 * return exactly one entry then the prefix, canary and round-trip assertions would
 * be reading an object that was never found, so their answers mean nothing. Three
 * situations close the gate, and each withholds those three rows with its own
 * stated reason:
 *
 *   1. the stored-entry count is not exactly one;
 *   2. the storage prefix was reported as NOT read from the live configuration,
 *      which is the documented cause of (1);
 *   3. the marker searched for was not the recorded canary, which makes the
 *      canary row a proof about a different string.
 *
 * Called with `undefined` when the payload reported no evidence at all, which is a
 * legitimate state and NOT an error: every row then reads "not reported" and the
 * derived verdict is `unknown`, which {@link reconcileVerdict} refuses to render
 * as a pass.
 */
function digestObservations(
  observations: readonly ControlObservation[] | undefined,
): EvidenceDigest {
  const extras: EvidenceExtra[] = (observations ?? [])
    .filter((observation) => !RECOGNISED_IDENTITIES.includes(observation.label))
    .map((observation) => ({
      label: observation.label,
      shape: describeShape(observation.value),
    }));

  const countReading = readStoredEntryCount(observations);
  const prefixLiveReading = readStoragePrefixLive(observations);
  const canaryLiteralReading = readCanaryLiteral(observations);
  // Read ONCE and narrowed properly: an unreported marker is not a mismatch (the
  // payload simply did not say which marker it used), while a reported marker that
  // differs from the recorded canary makes the absence proof above about a
  // different string.
  const literal = readNullable(observations, CHECK_IDENTITY['canary-literal']);
  const literalIsRecorded = literal.state !== 'reported' || literal.value === PLAINTEXT_CANARY;

  // THE PRECONDITION CLOSES THE GATE IN EVERY UNSATISFIED CASE, not only when it was
  // reported `false`. The earlier condition additionally required the observation to be
  // PRESENT, so three ways of failing to establish it left the gate open: never
  // reporting it, reporting it twice, and reporting it at a type that is not a boolean.
  // In all three the raw read may have addressed a key that does not exist, which is
  // exactly the situation the four proof rows cannot be trusted through. The reason is
  // worded per case, because "you did not measure this" and "you measured it and it was
  // false" send a reader to different places.
  const prefixLiveState = readBoolean(
    observations,
    CHECK_IDENTITY['storage-prefix-live'],
  ).state;
  const gateReason =
    countReading.outcome !== 'satisfied'
      ? 'the raw read did not return exactly one entry for the Secret key'
      : prefixLiveReading.outcome !== 'satisfied'
        ? PREFIX_LIVE_GATE_REASON[prefixLiveState]
        : undefined;

  const gated = (reading: EvidenceReading): EvidenceReading =>
    gateReason === undefined ? reading : withheldBecause(gateReason);

  const canaryReading = literalIsRecorded
    ? gated(readPlaintextCanary(observations))
    : withheldBecause(`the marker searched for was not ${PLAINTEXT_CANARY}`);

  const rows: readonly EvidenceRow[] = [
    buildRow(
      'stored-entry-count',
      'F-003-RQ-002',
      V3_ASSERTION_TITLES.exactlyOneEntry,
      countReading,
    ),
    buildRow(
      'ciphertext-prefix',
      'F-003-RQ-002',
      `${V3_ASSERTION_TITLES.prefix} - a prefix match, never equality and never a substring search`,
      gated(readCiphertextPrefix(observations)),
    ),
    buildRow('plaintext-canary', 'F-003-RQ-002', V3_ASSERTION_TITLES.canaryAbsent, canaryReading),
    buildRow(
      'canary-literal',
      'F-003-RQ-002',
      `the marker searched for is ${PLAINTEXT_CANARY}`,
      canaryLiteralReading,
    ),
    buildRow(
      'plaintext-round-trip',
      'F-003-RQ-002',
      V3_ASSERTION_TITLES.roundTrip,
      gated(readPlaintextRoundTrip(observations)),
    ),
    buildRow(
      'storage-prefix-live',
      'F-003-RQ-002',
      'the etcd key is derived from the live storage prefix, never hardcoded',
      prefixLiveReading,
    ),
    buildRow(
      'storage-prefix-shape',
      'F-003-RQ-002',
      `a per-run prefix, not the bare ${HARDCODED_STORAGE_PREFIX}`,
      readStoragePrefixShape(observations),
    ),
    buildRow(
      'provider-order',
      'F-003-RQ-003',
      `an encrypting provider first, ${IDENTITY_PROVIDER} last or absent`,
      readProviderOrder(observations),
    ),
    buildRow(
      'kms-timeout',
      'F-003-RQ-003',
      `timeout ${EXPECTED_KMS_TIMEOUT}`,
      readKmsTimeout(observations),
    ),
    buildRow(
      'cachesize-absent',
      'F-003-RQ-003',
      `no ${FORBIDDEN_KMS_V2_KEY} key, which KMS v2 rejects`,
      readCachesizeAbsent(observations),
    ),
    buildRow(
      'encrypted-resources',
      'F-003-RQ-001',
      EXPECTED_RESOURCES.join(', '),
      readEncryptedResources(observations),
    ),
    buildRow(
      'kms-endpoint',
      'F-003-RQ-003',
      'a placeholder socket path in the committed manifest',
      readKmsEndpoint(observations),
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
 *   2. A `pass` requires ALL THREE required sets, and nothing violated: the four
 *      {@link CIPHERTEXT_PROOF_CHECKS}, the
 *      {@link REQUIRED_PRECONDITION_CHECKS} that make them measurements of the
 *      right object, and the {@link REQUIRED_CONFIGURATION_CHECKS} that are the
 *      other two requirements this panel claims. The first version of this
 *      function required only two proof rows; the second required all four but
 *      left the precondition and the whole manifest posture unable to affect the
 *      verdict, so a payload could earn a clean pass on four assertions about an
 *      object nobody had confirmed was the right one, under a manifest nobody had
 *      looked at.
 *   3. PART OF THE PROOF satisfied is a `warn` — reported as partial rather than
 *      promoted to a pass. "Part of the proof" means one of the four CIPHERTEXT
 *      rows and nothing else, which is why the precondition and the manifest rows
 *      are separate sets rather than members of that one. Measured, not assumed —
 *      with a looser test, a payload whose raw read addressed the wrong key
 *      entirely still reported "partly verified" on the strength of having read
 *      its storage prefix from the live configuration, which says nothing
 *      whatsoever about ciphertext.
 *   4. Nothing proven is `unknown`. The informational rows are never `satisfied`,
 *      so they cannot lift this case either.
 *
 * A COMPLETE ciphertext proof under an unmeasured manifest lands on `warn` through
 * rule 3, which is the honest reading: the thing the control is chiefly about was
 * measured in full, and the caveat is that the shipped deployment posture was not.
 * `warn` is not a pass, so nothing is over-claimed, and the evidence table names
 * exactly which rows were not established.
 */
function summariseEvidence(rows: readonly EvidenceRow[]): ControlVerdict {
  if (rows.some((row) => row.outcome === 'violated')) {
    return 'fail';
  }
  const outcomeOf = (id: EvidenceCheckId): EvidenceOutcome | undefined =>
    rows.find((row) => row.id === id)?.outcome;
  const satisfied = (id: EvidenceCheckId): boolean => outcomeOf(id) === 'satisfied';
  const proven =
    CIPHERTEXT_PROOF_CHECKS.every(satisfied) &&
    REQUIRED_PRECONDITION_CHECKS.every(satisfied) &&
    REQUIRED_CONFIGURATION_CHECKS.every(satisfied);
  if (proven) {
    return 'pass';
  }
  return CIPHERTEXT_PROOF_CHECKS.some(satisfied) ? 'warn' : 'unknown';
}

/**
 * Combines the reported verdict with the evidence and the reported findings.
 *
 * INVARIANT LOCKED: this function can only ever make the rendered verdict MORE
 * severe, and A PASS MUST BE EARNED. There is no path from a reported `fail`,
 * `warn` or `unknown` to a rendered `pass`, and no path from a reported `pass`
 * over unproven evidence to a rendered `pass` either.
 *
 * WHAT CHANGED. The previous version returned the reported verdict unchanged
 * whenever the evidence was `unknown`, on the reasoning that "the payload carried
 * no evidence" is a finding about the payload rather than about encryption. That
 * reasoning is wrong for the direction that matters: it made a reported `pass`
 * with NO evidence at all render as a clean pass on the most serious of the eight
 * controls. Absent evidence is not a defect — so it yields `unknown` rather than
 * `fail` — but it is certainly not a proof, so it cannot support a pass.
 *
 * A reported finding floors the verdict at `fail` on its own authority: a payload
 * cannot claim `pass` while also reporting that something is wrong, and the
 * finding may well concern something this panel measures nothing about.
 */
function reconcileVerdict(
  reported: ControlVerdict,
  evidence: ControlVerdict,
  findingCount: number,
): ControlVerdict {
  if (reported === 'fail' || evidence === 'fail' || findingCount > 0) {
    return 'fail';
  }
  if (reported === 'pass') {
    // The evidence decides: `pass` when all four assertions hold, `warn` when the
    // proof is partial, `unknown` when nothing was proven.
    return evidence;
  }
  return strictestVerdict([reported, evidence]);
}


/**
 * The panel's own conservative verdict for V3, as one call over one payload.
 *
 * Exported so the aggregate dashboard counts, filters and summarises the SAME
 * verdict this panel renders in its badge, rather than the raw `status.verdict`
 * the server sent. A dashboard counting the raw verdict would report a pass beside
 * a panel rendering FAIL — and for the one Critical-severity control of the eight,
 * that disagreement is the worst possible place to have no single place to look.
 *
 * @param control - the payload for V3, or `undefined` when it was not reported.
 * @returns the verdict this panel renders.
 */
export function resolveEncryptionAtRestEffectiveVerdict(
  control: ControlStatus | undefined,
): ControlVerdict {
  if (control === undefined) {
    return 'unknown';
  }
  const digest = digestObservations(control.evidence?.observations);
  return strictestVerdict([
    reconcileVerdict(control.verdict, digest.verdict, control.findings.length),
  ]);
}

/**
 * Renders a transport or contract failure in words, alongside the server's own
 * message.
 *
 * The HTTP status is named whenever one exists, and `reason` — the Kubernetes
 * `Status` body's own field, e.g. `Forbidden` — is appended when the server sent
 * it. A `network` failure has no status because no response ever existed, and
 * that is said rather than papered over with a fabricated code.
 *
 * M18 — `reason` IS EXTERNAL TEXT AND IS BOUNDED HERE. It is short and
 * well-known in practice, which is exactly why it was easy to overlook: nothing
 * in the contract obliges a server to send `Forbidden` rather than a credential,
 * a control character or eight kilobytes of prose, and this sentence is rendered
 * on the panel's most prominent failure affordance. `httpStatus` and `kind`
 * beside it are a number and one of this repository's own literals, so they are
 * deliberately left unguarded.
 */
function describeFailure(error: ControlStatusError): string {
  if (error.httpStatus === undefined) {
    return `No response was received (${error.kind}). No verdict is available, so nothing is reported as passing.`;
  }
  const reason = error.reason === undefined ? '' : ` ${safeProse(error.reason)}`;
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
  // Every member is server-supplied. Prose goes through `safeProse` and the two
  // identifier-shaped members through the harder `safeLabel`, because a subject or a
  // requirement id that needs 2000 characters is not one (AAP §0.11.1).
  const subject = finding.subject === undefined ? '' : `${safeLabel(finding.subject)}: `;
  const requirement =
    finding.requirementId === undefined ? '' : ` (${safeLabel(finding.requirementId)})`;
  return `${subject}${safeProse(finding.message)}${requirement}`;
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
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <Subheading id={headingId}>{heading}</Subheading>
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
   * REPLACES the refresh action rather than joining it. Without it the button calls
   * the result's own `refresh`, which re-issues the request; with a pre-resolved
   * `status` and no handler there is nothing to re-request, so the button is
   * DISABLED and carries a title saying why instead of being an enabled no-op.
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
 * The placeholder occupying {@link UseControlStatusResult.refresh} when a pre-resolved
 * `status` is rendered.
 *
 * Deliberately empty and deliberately NOT a stub: there is no request behind a
 * pre-resolved payload, so the honest behaviour is to do nothing. It is also never the
 * handler the button calls — that branch resolves refresh availability from the caller's
 * own handler, so a payload handed over directly renders a DISABLED button rather than
 * an enabled control wired to this.
 */
const NO_REFRESH = (): void => undefined;

/** Props of the internal view. */
interface EncryptionAtRestPanelViewProps {
  readonly result: UseControlStatusResult;
  readonly onRefresh?: () => void;
  readonly canRefresh?: boolean;
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
  canRefresh = true,
}: EncryptionAtRestPanelViewProps): ReactElement {
  // EMBEDDED-AWARE OWN HEADING (m3), bound once for this component.
  const rendersOwnHeading = useRendersOwnHeading();
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  // EMBEDDED-AWARE LIVE REGION (m4). See the note on the status role above.
  const liveAlertRole = useLiveRegionRole('alert');
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  // One generated base id per instance, because the aggregate dashboard renders
  // eight panels into one document and duplicated ids would break every
  // aria-labelledby association at once.
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  // EMBEDDED-AWARE REGION NAME (m3). The region is named by whichever heading exists: this
  // panel's own when standalone, the dashboard's control heading when embedded. Without this
  // an embedded panel would point `aria-labelledby` at an id it no longer renders, leaving a
  // region with no accessible name at all.
  const panelLabelId = usePanelLabelId(headingId);
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
    control === undefined
      ? undefined
      : reconcileVerdict(control.verdict, digest.verdict, control.findings.length);

  const reportedRequirements =
    control?.requirementIds !== undefined && control.requirementIds.length > 0
      ? control.requirementIds.map(safeLabel).join(', ')
      : undefined;

  // The override REPLACES the result's own handler rather than joining it, so one
  // press is one request; and an unavailable refresh resolves to `undefined`, which
  // disables the affordance and explains itself instead of accepting a dead press.
  const refresh = resolveRefreshHandler(onRefresh, result.refresh, canRefresh);

  return (
    <section aria-labelledby={panelLabelId} aria-busy={result.status === 'loading'}>
      {/*
        EMBEDDED-AWARE OWN HEADING (m3). Standalone, this heading names the panel's region and
        is the only title on screen. Embedded, the dashboard has already written an `h3` naming
        this control, so rendering a second title here both DUPLICATED the name and restarted
        the heading run at a shallower level than the one above it. The region keeps a name
        either way: `aria-labelledby` points at whichever heading exists.
      */}
      {rendersOwnHeading ? (
        <h2 id={headingId}>Secrets encryption at rest (V3)</h2>
      ) : null}
      <p>Requirements covered: {REQUIREMENT_IDS.join(', ')}</p>
      <button
        type="button"
        onClick={refresh}
        disabled={refresh === undefined}
        title={refresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
      >
        Re-check encryption at rest
      </button>

      {result.status === 'loading' ? (
        <p role={liveStatusRole} aria-label="Encryption at rest status: checking">
          Checking whether the stored Secret is ciphertext...
        </p>
      ) : null}

      {result.status === 'error' ? (
        <div role={liveAlertRole} aria-labelledby={errorHeadingId}>
          <Subheading id={errorHeadingId}>Encryption at rest could not be verified</Subheading>
          {/*
            The server's own words, bounded and redacted. `describeFailure` composes
            this tier's own typed tokens and the numeric status, so it is not an
            external channel and is not sanitized.
          */}
          <p>{safeProse(result.error.message)}</p>
          <p>{describeFailure(result.error)}</p>
        </div>
      ) : null}

      {result.status === 'success' && control === undefined ? (
        <p role={liveStatusRole} aria-label="Encryption at rest status: nothing reported">
          The server reported no posture for this control, so encryption at rest is not verified.
        </p>
      ) : null}

      {control !== undefined && verdict !== undefined ? (
        <>
          <p role={liveStatusRole} aria-label={`Encryption at rest verdict: ${verdict}`}>
            {verdict.toUpperCase()} - {VERDICT_HEADLINE[verdict]}
          </p>
          {/*
            THE VERDICT IS LOCAL, EVERYTHING BELOW IT IS NOT. `verdict` and
            `VERDICT_HEADLINE` are this file's own words for a verdict this file
            computed; the summary, detail, reported requirement identifiers and
            timestamp are all server-supplied and every one is bounded and redacted on
            the way in.
          */}
          <p>{safeProse(control.summary)}</p>
          {control.detail !== undefined ? <p>{safeProse(control.detail)}</p> : null}
          {reportedRequirements !== undefined ? (
            <p>Reported requirements: {reportedRequirements}</p>
          ) : null}
          {control.observedAt !== undefined ? (
            <p>Observed at {safeLabel(control.observedAt)}</p>
          ) : null}

          <Subheading id={evidenceHeadingId}>Evidence</Subheading>
          <EvidenceTable labelledBy={evidenceHeadingId} rows={digest.rows} />

          <TextListSection
            headingId={findingsHeadingId}
            heading="Findings"
            items={control.findings.map(formatFinding)}
          />
          <TextListSection
            headingId={warningsHeadingId}
            heading="Server warnings"
            items={control.warnings.map(safeProse)}
          />
          <TextListSection
            headingId={extrasHeadingId}
            heading="Other reported observations"
            // An unrecognised observation's LABEL is server-supplied, so it is bounded;
            // its value is already reduced to a shape and never rendered (see
            // `describeShape`), which is what keeps a raw stored blob off the panel.
            items={digest.extras.map((extra) => `${safeLabel(extra.label)}: ${extra.shape}`)}
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
  /** Forwarded to the view; see {@link EncryptionAtRestPanelProps.canRefresh}. */
  readonly canRefresh?: boolean;
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
  canRefresh = true,
}: ConnectedEncryptionAtRestPanelProps): ReactElement {
  const result = useControlStatus(ENCRYPTION_AT_REST_CONTROL_ID);
  return (
    <EncryptionAtRestPanelView
      result={result}
      onRefresh={onRefresh}
      canRefresh={canRefresh}
    />
  );
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
  canRefresh = true,
}: EncryptionAtRestPanelProps): ReactElement {
  if (result !== undefined) {
    return (
      <EncryptionAtRestPanelView result={result} onRefresh={onRefresh} canRefresh={canRefresh} />
    );
  }
  if (status !== undefined) {
    // A payload handed over directly owns no request, so ONLY an explicit handler can
    // refresh it. Without one the affordance is disabled and explained.
    return (
      <EncryptionAtRestPanelView
        result={{ status: 'success', controls: [status], isEmpty: false, refresh: NO_REFRESH }}
        onRefresh={onRefresh}
        canRefresh={canRefresh && onRefresh !== undefined}
      />
    );
  }
  return <ConnectedEncryptionAtRestPanel onRefresh={onRefresh} canRefresh={canRefresh} />;
}
