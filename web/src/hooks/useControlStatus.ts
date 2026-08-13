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

// AAP §0.5.1 (the `web/src/hooks/useControlStatus.test.ts` row this module
// serves: "Fetch success, 403, 500, abort") / §0.4.2.4 (the L6/L7 React
// blueprint — every panel covers a happy path, an edge case, an error case,
// loading and empty states, and an interaction case driving refresh) /
// §0.7.1.3 (the >= 80 % line-and-branch floor for the React tier, re-baselined
// against Vitest 4's rewritten AST-aware V8 provider) / §0.4.6 and §0.9.1.2
// (`coverage.include = src/**/*.{ts,tsx}`, mandatory now that `coverage.all`
// has been removed) / tech-spec §6.6.3.4 (the documentation convention this
// provenance comment and the invariant comments below satisfy).
//
// This module is the single definition site for the control-posture types the
// rest of `web/src` is typechecked against. There is deliberately no `types.ts`
// and no barrel file: one definition site, imported directly.
//
// The behaviour modelled here is read from the Go parity oracle, which this
// workstream never deletes (AAP §0.5.1 — the DELETE set is empty by design):
//
//   * `test/integration/auth/rbac_test.go` L1170-1299 — V1, F-001-RQ-001/002.
//     The evidence datum is `SubjectAccessReview.status.allowed`. A security
//     finding is reported with `t.Errorf` (L1234-1236, L1274-1278, L1286-1297),
//     which accumulates and continues, so EVERY offending ClusterRole,
//     ClusterRoleBinding and subject is reported in one run. A failed positive
//     control is reported with `t.Fatalf` (L1252-1254) and is explicitly "test
//     setup broken" rather than a security finding.
//   * `test/integration/auth/podsecurity_test.go` L355-457 — V2,
//     F-002-RQ-001/003. Rejections are asserted through
//     `apierrors.IsForbidden`, i.e. HTTP 403 (L407, L419). The `warn=restricted`
//     case (L427-456) ADMITS the pod and simultaneously surfaces at least one
//     warning, which is neither a clean pass nor a fail.
//   * `test/integration/auth/svcaccttoken_test.go` L1425-1526 — V4,
//     F-004-RQ-001/002. The audience claim is exactly `["api"]`, the requested
//     TTL is 3600 s, and `const leeway = int64(60)` (L1501) bounds BOTH the JWT
//     `exp` claim (L1507, a JSON number of whole Unix seconds) and
//     `status.expirationTimestamp` (L1512, an RFC 3339 string) against
//     `requestTime + 3600 s`.
//
// MODULE INVARIANTS LOCKED HERE, each traceable to AAP §0.11.1:
//
//   1. "No false passes". A non-2xx response — 403 and 500 in particular —
//      resolves to an error state that is STRUCTURALLY incapable of carrying a
//      verdict: `ControlStatusErrorResult` has no `controls` member at all, so
//      rendering a forbidden or failed request as a pass is a `tsc --noEmit`
//      error under `strict`, not a code-review question.
//   2. "Never weaken a boundary condition". Every value received is surfaced
//      verbatim. Nothing here rounds, clamps, re-scales, re-parses or otherwise
//      reinterprets a number or a timestamp, because the ±60 s window asserted
//      against the V4 expiry data is engineered so that a roughly one-year
//      long-lived-token regression still fails while CI jitter is absorbed.
//   3. Absent or unrecognised evidence is `unknown`, never `pass`.
//   4. "Preserve assertion semantics across languages". A control carries MANY
//      findings, mirroring the accumulate-and-continue semantics of `t.Errorf`.
//
// Dependency discipline (AAP §0.11.1, "new dependencies live in python/ and
// web/"): the only import in this file is `react`, which is already pinned in
// web/package.json. Data access is the platform `fetch`; no HTTP client, no
// data-fetching library and no Node built-in is introduced, so
// web/package-lock.json stays in step and `npm ci` keeps working.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { safeProse } from '../domain/safeText';

/**
 * The eight security-hardening controls this posture surface reports on, in the
 * order the aggregate dashboard renders them (AAP §0.3.1.1):
 *
 * - `V1` — RBAC least-privilege: no identity outside `system:masters` resolves
 *   full wildcard authority.
 * - `V2` — Pod Security enforcement: `enforce=baseline` rejects privileged and
 *   hostPID pods; `warn=restricted` admits but warns.
 * - `V3` — Secrets encryption at rest.
 * - `V4` — ServiceAccount-token hygiene: audience-bound and time-bound tokens
 *   with an unchanged claim shape.
 * - `V5` — Admission-webhook fail-closed posture.
 * - `V6` — Sensitive-resource audit fidelity.
 * - `V7` — NodeRestriction: cross-node mutation denied.
 * - `V8` — etcd mutual-TLS transport.
 *
 * Exported as a value, and not merely as a type, because the aggregate
 * dashboard iterates it, the request handlers register one endpoint per member,
 * and the recorded fixtures build one entry per member. A single roster keeps
 * all three in step.
 *
 * The repository's own identifiers are used verbatim. No external benchmark or
 * hardening-guide control number is asserted anywhere in this tier, because the
 * repository does not enumerate any (AAP §0.11.1, "cite only what the
 * repository states").
 */
export const CONTROL_IDS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'] as const;

/**
 * Identifier of a single hardening control.
 *
 * Invariant locked: this union is DERIVED from {@link CONTROL_IDS} rather than
 * written out a second time, so the runtime roster and the compile-time union
 * can never drift apart.
 */
export type ControlId = (typeof CONTROL_IDS)[number];

/**
 * Type guard for {@link ControlId}.
 *
 * Invariant locked: an identifier is recognised only by exact match against
 * {@link CONTROL_IDS}. Nothing is trimmed, case-folded or otherwise coerced
 * into matching, because a control this client cannot name is a control it
 * cannot render a trustworthy verdict for.
 *
 * @param value - any value, typically read from a response body.
 * @returns `true` only when `value` is one of the eight known identifiers.
 */
export function isControlId(value: unknown): value is ControlId {
  return typeof value === 'string' && CONTROL_IDS.some((candidate) => candidate === value);
}

/**
 * The verdict rendered for one control.
 *
 * Invariant locked: `pass`, `fail`, `warn` and `unknown` are four DISTINCT
 * outcomes, and absent or unreadable evidence is `unknown` — never `pass`.
 *
 * - `pass` — the control holds.
 * - `fail` — the control is violated. At least one entry in
 *   {@link ControlStatus.findings} says which object violates it.
 * - `warn` — the operation was permitted yet the server objected to it. This is
 *   a first-class outcome rather than a shade of pass or fail: the V2 oracle's
 *   `warn=restricted` namespace admits a restricted-violating pod (no error)
 *   and simultaneously emits at least one warning
 *   (`podsecurity_test.go` L447-455). Collapsing it into `pass` or `fail` would
 *   lose the control.
 * - `unknown` — no trustworthy evidence was obtained. The Go oracle pairs every
 *   negative assertion with a positive control precisely because a check that
 *   cannot tell "no evidence" from "good evidence" also passes when the entire
 *   authorization stack is broken (`rbac_test.go` L1252-1254 aborts with "test
 *   setup broken" rather than recording a finding). `unknown` preserves that
 *   distinction at the presentation layer.
 */
export type ControlVerdict = 'pass' | 'fail' | 'warn' | 'unknown';

/** The verdicts accepted from the wire, in the order they are documented. */
const CONTROL_VERDICTS: readonly ControlVerdict[] = ['pass', 'fail', 'warn', 'unknown'];

/**
 * One reported violation of a control.
 *
 * Invariant locked: findings are a LIST, because the Go oracle reports every
 * offender in a single run rather than stopping at the first — `rbac_test.go`
 * L1274-1278 emits one `t.Errorf` per offending ClusterRole and L1286-1297 one
 * per offending ClusterRoleBinding and subject. A single string could not carry
 * that, and truncating to the first offender would hide the rest.
 */
export interface ControlFinding {
  /**
   * Human-readable description of the violation, exactly as reported. Always
   * present so that a panel never has to render an empty cell; when the server
   * omits it, a fixed explanatory sentence is substituted rather than `null`,
   * `undefined` or the empty string.
   */
  readonly message: string;
  /**
   * Identity of the offending object — for V1 a ClusterRole,
   * ClusterRoleBinding or subject name. Absent when the finding is about the
   * control as a whole rather than about one named object.
   */
  readonly subject?: string;
  /**
   * The repository's own requirement identifier that the finding violates, for
   * example `F-001-RQ-002`. Absent when the server does not attribute the
   * finding to a single requirement.
   */
  readonly requirementId?: string;
}

/**
 * One measured fact backing a verdict, as a label and a single scalar.
 *
 * This deliberately generic shape carries the per-control evidence the panels
 * tabulate — a per-resource audit level, a rendered etcd transport flag, a
 * ciphertext prefix, a `SubjectAccessReview` allowed decision — without this
 * module inventing a bespoke schema per control.
 *
 * Invariant locked: `null` is a REPRESENTABLE value, not a missing one. The V4
 * oracle asserts that `kubernetes.io.pod` and `kubernetes.io.secret` are both
 * exactly `null` (`svcaccttoken_test.go` L1524-1525) because a non-null value
 * there indicates a legacy or object-bound token. Conflating that `null` with
 * "not reported" would erase the assertion.
 */
export interface ControlObservation {
  /** What was measured. */
  readonly label: string;
  /** The measured value, verbatim. An explicit `null` is preserved as `null`. */
  readonly value: string | number | boolean | null;
}

/**
 * Observed lifetime of an issued credential.
 *
 * Invariant locked: every member is surfaced verbatim in the unit the server
 * used. Nothing is rounded, truncated to a coarser unit, converted between
 * seconds and milliseconds, or re-parsed out of a string. The V4 oracle bounds
 * both `exp` and `status.expirationTimestamp` against `requestTime + 3600 s`
 * within `leeway = 60` s (`svcaccttoken_test.go` L1498-1514); that window is
 * calibrated so a roughly one-year regression still fails while API round-trip
 * and scheduling jitter are absorbed, so a helpfully rounded timestamp would
 * destroy it.
 */
export interface ControlExpiry {
  /**
   * The JWT `exp` claim: whole seconds since the Unix epoch, as a JSON number,
   * exactly as issued (`svcaccttoken_test.go` L1503-1509).
   */
  readonly expirySeconds?: number;
  /**
   * `status.expirationTimestamp` as an RFC 3339 string, exactly as the API
   * returned it (`svcaccttoken_test.go` L1511-1514). Kept as the original
   * string rather than a `Date`, so no timezone or precision normalisation can
   * creep in between the wire and the panel.
   */
  readonly expirationTimestamp?: string;
  /**
   * The reference instant captured immediately before issuance, in whole
   * seconds since the Unix epoch — the `requestTime` of
   * `svcaccttoken_test.go` L1478 against which the window is measured.
   */
  readonly requestTimeSeconds?: number;
  /**
   * The symmetric tolerance, in seconds, applied around
   * `requestTimeSeconds + requestedTtlSeconds`. The oracle's value is 60
   * (`svcaccttoken_test.go` L1501).
   */
  readonly leewaySeconds?: number;
}

/**
 * Structured evidence behind a verdict, for panels that show their working.
 *
 * Every member is optional and the whole bag is absent when the server supplied
 * nothing usable, so a panel can distinguish "no evidence reported" from
 * "evidence reported as empty".
 */
export interface ControlEvidence {
  /**
   * The audience list bound to an issued token, verbatim and in order. The V4
   * oracle requires exactly `["api"]` (`svcaccttoken_test.go` L1472, L1489), so
   * both the contents and the cardinality are meaningful and neither is sorted,
   * de-duplicated or otherwise rewritten here.
   */
  readonly audiences?: readonly string[];
  /**
   * The token lifetime requested, in seconds — 3600 in the V4 oracle
   * (`svcaccttoken_test.go` L1473, L1498).
   */
  readonly requestedTtlSeconds?: number;
  /** The lifetime actually observed. See {@link ControlExpiry}. */
  readonly observedExpiry?: ControlExpiry;
  /** Additional measured facts. See {@link ControlObservation}. */
  readonly observations?: readonly ControlObservation[];
}

/**
 * The per-control payload a posture panel renders.
 *
 * Invariant locked: a `ControlStatus` only ever exists inside a SUCCESSFUL
 * response. It is reachable exclusively through
 * {@link ControlStatusSuccessResult}, so no transport failure can produce one.
 */
export interface ControlStatus {
  /** Which control this payload describes. */
  readonly controlId: ControlId;
  /** The rendered outcome. See {@link ControlVerdict}. */
  readonly verdict: ControlVerdict;
  /**
   * One-line human-readable outcome, suitable for a panel heading. Always
   * present: when the server omits it, a fixed explanatory sentence is
   * substituted, so a panel never renders the text `null` or `undefined`.
   */
  readonly summary: string;
  /** Optional longer explanation, suitable for a panel body. */
  readonly detail?: string;
  /**
   * The repository's own requirement identifiers this control covers, for
   * example `F-002-RQ-001`. Reporting them makes a failure read as a
   * requirement violation rather than as a value mismatch, which is the
   * "failure legibility" criterion of AAP §0.7.2.
   */
  readonly requirementIds?: readonly string[];
  /**
   * Every reported violation, never just the first. Empty when there are none.
   * See {@link ControlFinding}.
   */
  readonly findings: readonly ControlFinding[];
  /**
   * Server-emitted warnings, verbatim and in order. Empty when there are none.
   *
   * These are plain strings because that is what the API server's warning
   * channel carries, and what the V2 oracle counts: the `warn=restricted`
   * namespace admits the pod and the test then requires at least one warning to
   * have been recorded (`podsecurity_test.go` L451-455). A non-empty
   * `warnings` list alongside an otherwise-permitted operation is exactly the
   * `warn` verdict.
   */
  readonly warnings: readonly string[];
  /** Structured evidence, absent when none was reported. */
  readonly evidence?: ControlEvidence;
  /**
   * When the control was evaluated, as an RFC 3339 string exactly as the server
   * reported it. Absent when the server reported none. Kept as the original
   * string for the same reason as {@link ControlExpiry.expirationTimestamp}.
   */
  readonly observedAt?: string;
}

/**
 * What kind of failure prevented a verdict from being obtained.
 *
 * - `http` — a response arrived and its status was not 2xx. `403` and `500`
 *   both land here.
 * - `network` — no response arrived at all.
 * - `payload` — a 2xx response arrived but its body could not be trusted to
 *   describe the controls asked about.
 */
export type ControlStatusErrorKind = 'http' | 'network' | 'payload' | 'timeout';

/**
 * A transport or contract failure.
 *
 * Invariant locked: this type carries NO verdict and NO {@link ControlStatus}.
 * That is the whole point — a 403 or a 500 is structurally incapable of being
 * rendered as a pass.
 */
export interface ControlStatusError {
  /** See {@link ControlStatusErrorKind}. */
  readonly kind: ControlStatusErrorKind;
  /**
   * Human-readable failure text. Prefers the `message` field of a Kubernetes
   * `Status` body when the server sent one, so a panel shows the server's own
   * words; otherwise a sentence naming the status code and the endpoint.
   */
  readonly message: string;
  /**
   * The HTTP status code, verbatim. Absent for `kind: 'network'` and for
   * `kind: 'timeout'`, where no response — and therefore no status — ever
   * existed. Never synthesised: a consumer that sees a number knows a server
   * sent it.
   */
  readonly httpStatus?: number;
  /**
   * The `reason` field of a Kubernetes `Status` body, for example `Forbidden`,
   * when the server sent one. This is the wire-level counterpart of the Go
   * oracle's `apierrors.IsForbidden` check (`podsecurity_test.go` L407, L419).
   */
  readonly reason?: string;
}

/** The request is in flight and no outcome is known yet. */
export interface ControlStatusLoadingResult {
  readonly status: 'loading';
  /** See {@link ControlStatusSuccessResult.refresh}. */
  readonly refresh: () => void;
}

/** The request succeeded and the payload was understood. */
export interface ControlStatusSuccessResult {
  readonly status: 'success';
  /**
   * The controls the server reported, in server order. Empty means the server
   * reported none, which is the explicit empty state rather than a failure —
   * see {@link ControlStatusSuccessResult.isEmpty}.
   */
  readonly controls: readonly ControlStatus[];
  /**
   * `true` exactly when `controls` is empty. Provided so the empty state is
   * directly observable by a panel and by a spec, instead of being inferred
   * from a length comparison at every call site.
   */
  readonly isEmpty: boolean;
  /**
   * Re-issues the request. Any request still in flight is aborted first, and
   * the state returns to `loading` while the new request runs, so a refresh
   * control is observable end to end. Stable across renders, so it is safe as
   * an effect dependency or a memoised prop.
   */
  readonly refresh: () => void;
}

/**
 * The request did not yield a trustworthy payload.
 *
 * Invariant locked: this arm has no `controls` member, so a panel cannot reach
 * a verdict from a failed request even by accident. Attempting it is a
 * compile-time error under `strict`.
 */
export interface ControlStatusErrorResult {
  readonly status: 'error';
  /** Why no verdict is available. See {@link ControlStatusError}. */
  readonly error: ControlStatusError;
  /** See {@link ControlStatusSuccessResult.refresh}. */
  readonly refresh: () => void;
}

/**
 * Everything {@link useControlStatus} returns, as a discriminated union keyed
 * on `status`.
 *
 * Narrow on `status` before reading anything else:
 *
 * ```tsx
 * const result = useControlStatus('V2');
 * if (result.status === 'loading') return <Spinner />;
 * if (result.status === 'error') return <ErrorBanner error={result.error} />;
 * if (result.isEmpty) return <EmptyState onRetry={result.refresh} />;
 * const control = selectControlStatus(result.controls, 'V2');
 * ```
 */
export type UseControlStatusResult =
  | ControlStatusLoadingResult
  | ControlStatusSuccessResult
  | ControlStatusErrorResult;

/**
 * Base path of the control-posture endpoint. Relative on purpose: it is
 * resolved against the document origin, so no hostname is baked into the
 * client and the request handlers can match it in any environment.
 */
export const CONTROL_STATUS_BASE_PATH = '/api/posture/controls';

/**
 * The request path for a control-posture query.
 *
 * With no argument this addresses the collection — every control in one
 * response, which is what the aggregate dashboard needs. With a
 * {@link ControlId} it addresses that one control, which is the per-control
 * endpoint each panel and each request handler is registered against.
 *
 * @param controlId - the single control to address, or omitted for all of them.
 * @returns a path relative to the document origin.
 */
export function controlStatusPath(controlId?: ControlId): string {
  return controlId === undefined
    ? CONTROL_STATUS_BASE_PATH
    : `${CONTROL_STATUS_BASE_PATH}/${controlId}`;
}

/**
 * Picks one control out of a successful payload.
 *
 * Defined here so that every panel reads its own control the same way instead
 * of re-implementing the lookup. Returns `undefined` when the payload does not
 * mention the control, which a panel must render as an empty or unknown state —
 * never as a pass.
 *
 * A DUPLICATE CANNOT REACH THIS FUNCTION. {@link parsePayload} refuses a payload that
 * reports a control more than once, so the `find` below is total: at most one entry can
 * match. That ordering is deliberate — resolving a contradiction here, by taking the
 * first occurrence, would make the rendered verdict depend on the order the server
 * serialised its entries in. The refusal happens where the contradiction is visible.
 *
 * @param controls - the `controls` member of a successful result.
 * @param controlId - the control to look for.
 * @returns the matching payload, or `undefined` when it is absent.
 */
export function selectControlStatus(
  controls: readonly ControlStatus[],
  controlId: ControlId,
): ControlStatus | undefined {
  return controls.find((control) => control.controlId === controlId);
}

/** Substituted when the server reports a control without a summary. */
const UNREPORTED_SUMMARY = 'The server reported no summary for this control.';

/** Substituted when the server reports a finding without a readable message. */
const UNREADABLE_FINDING = 'The server reported a finding without a readable message.';

/** Shared empty lists, so an untouched result keeps a stable identity. */
const NO_FINDINGS: readonly ControlFinding[] = Object.freeze([]);
const NO_WARNINGS: readonly string[] = Object.freeze([]);
const NO_CONTROLS: readonly ControlStatus[] = Object.freeze([]);

/**
 * `204 No Content`. Named rather than inlined so that the one place which reads
 * a bodyless success is unmistakable.
 */
const NO_CONTENT_STATUS = 204;

/**
 * Narrows an unknown JSON value to a plain object.
 *
 * Arrays are excluded deliberately: `typeof [] === 'object'` in JavaScript, and
 * treating a list as a record is how a wire-shape mismatch turns into a silent
 * misread instead of a reported one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Thrown by a reader that found a member of the WRONG TYPE, rather than an absent one.
 *
 * Invariant locked: a malformed member fails the whole read. The readers below used to
 * degrade instead -- filtering an invalid array element out, skipping a malformed
 * finding, returning an empty list where an unreadable one was found -- and every one of
 * those degradations produces the same class of defect: a payload the client could not
 * understand rendered as a payload with nothing to report. For a security-posture view
 * that is the worst available outcome, because the missing evidence is invisible.
 *
 * The concrete case that motivated it: `audiences: ['api', 42]` was filtered to
 * `['api']`, which then SATISFIED the V4 assertion that the audience is exactly
 * `['api']`. A token bound to two audiences, one of which the client could not read, was
 * reported as correctly single-audience. Rejecting the field means the panel reports that
 * it cannot tell -- which is the truth.
 *
 * An exception rather than a `Result` return, because these readers nest four deep
 * (payload -> control -> evidence -> observation) and threading a failure through every
 * level would obscure the parsing itself. It is caught in exactly one place,
 * {@link parsePayload}, and converted into the same `payload` error a syntactically bad
 * body produces, so nothing escapes into React's render path.
 */
class PayloadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadShapeError';
  }
}

/**
 * Names the JSON type of a value WITHOUT disclosing the value.
 *
 * A control payload can carry a subject name, a rendered command line or a claim value,
 * so a shape complaint has no business quoting what it is complaining about. `null` is
 * reported as `null` rather than as `object`, because `typeof null === 'object'` is the
 * classic misreport and the null-versus-absent distinction is load-bearing here.
 */
function describeJsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Narrows an unknown JSON value to a read-only list of unknowns.
 *
 * `Array.isArray` alone widens its argument to a list of `any`, which would
 * silently disable checking for every element read afterwards. Re-typing the
 * result as `readonly unknown[]` restores that checking, which is why this
 * one-line helper exists rather than the bare predicate being used inline.
 */
function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** Reads a string member, or `undefined` when it is absent or not a string. */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a numeric member verbatim.
 *
 * Invariant locked: the value is returned EXACTLY as received, or not at all.
 * Non-finite numbers are rejected rather than substituted, and a number-shaped
 * string is rejected rather than parsed — reinterpreting either would be the
 * kind of helpful normalisation that AAP §0.11.1 forbids, because the ±60 s
 * expiry window asserted downstream is only meaningful against untouched
 * values. Omitting an unreadable field is honest; coercing it is not.
 */
function readFiniteNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a list of strings, keeping order and duplicates, or `undefined` when absent.
 *
 * Invariant locked: the list is accepted WHOLE or not at all. A single non-string member
 * rejects the entire payload rather than being filtered out.
 *
 * This is not defensiveness for its own sake -- filtering here was a security defect.
 * `audiences` is read by the V4 panel, which asserts that a token's audience is EXACTLY
 * `['api']`; a payload reporting `['api', 42]` describes a token bound to two audiences,
 * and dropping the unreadable one produced `['api']`, which satisfied the assertion. The
 * panel then rendered PASS for a token that is not audience-bound. `requirementIds` is
 * read the same way, where a dropped member silently shrinks the set of requirements a
 * finding claims to cover.
 *
 * A member of the wrong type is also NOT the same as an empty list: `audiences: []` is a
 * token bound to no audience at all, which is a reportable finding, whereas
 * `audiences: [42]` is a payload this client cannot interpret. Collapsing the second into
 * the first would report a defect the server never described.
 *
 * @throws PayloadShapeError when the member is a list containing a non-string.
 */
function readStringArray(
  source: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const items = asArray(raw);
  if (items === undefined) {
    throw new PayloadShapeError(
      `"${key}" is a ${describeJsonType(raw)}, but the contract declares a list of ` +
        'strings. Reading a scalar as a one-element list would invent a value the server ' +
        'did not report.',
    );
  }
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string') {
      throw new PayloadShapeError(
        `"${key}[${String(index)}]" is a ${describeJsonType(item)}, not a string. The ` +
          'whole list is rejected rather than the member being dropped: a shortened list ' +
          'is indistinguishable from a complete one once rendered, and for "audiences" a ' +
          'dropped member turns a multi-audience token into an apparently bound one.',
      );
    }
  }
  return items as readonly string[];
}


/**
 * Reads the verdict.
 *
 * Invariant locked: only the four documented literals are accepted, and they are
 * matched exactly. An absent, misspelled, differently-cased or non-string value
 * becomes `unknown` — NEVER `pass`. Degrading in the safe direction is what
 * stops a wire-shape drift from being rendered as a clean bill of health.
 */
function parseVerdict(value: unknown): ControlVerdict {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  return CONTROL_VERDICTS.find((candidate) => candidate === value) ?? 'unknown';
}

/**
 * Reads one finding.
 *
 * A plain string is accepted and taken as the message, so a server (or a
 * recorded fixture) that reports findings as bare strings is understood without
 * losing any of them. An object may additionally name the offending subject and
 * the requirement it violates.
 *
 * @returns the finding, or `undefined` when the entry carries nothing
 *   renderable at all.
 */
function parseFinding(value: unknown, index: number): ControlFinding {
  if (typeof value === 'string') {
    return { message: value };
  }
  if (!isRecord(value)) {
    throw new PayloadShapeError(
      `"findings[${String(index)}]" is a ${describeJsonType(value)}; a finding is either ` +
        'a string message or an object carrying one. It is rejected rather than skipped ' +
        'because a finding is a REPORTED DEFECT: dropping it removes the one piece of ' +
        'evidence that would have stopped the control rendering as a pass.',
    );
  }
  return {
    message: readString(value, 'message') ?? UNREADABLE_FINDING,
    subject: readString(value, 'subject'),
    requirementId: readString(value, 'requirementId'),
  };
}

/**
 * Reads every finding, in order.
 *
 * Invariant locked: findings ACCUMULATE and none is ever lost. The Go oracle's `t.Errorf`
 * semantics require that every offender be reported in one run (`rbac_test.go` L1274-1278,
 * L1286-1297), so the list is read whole rather than truncated at the first surprise.
 *
 * A malformed ENTRY is now a payload error rather than a skipped one, and the difference
 * is the point. A finding is a reported DEFECT; it is the evidence that stops a control
 * rendering as a pass. Silently dropping one produced the exact inversion the accumulate
 * semantics exist to prevent -- a control with three findings, one of them unreadable,
 * rendered two -- and a control whose ONLY finding was unreadable rendered as clean.
 *
 * An absent `findings` member is still absent, not an error: a control with nothing to
 * report legitimately omits it. Only a member that IS present and cannot be read fails.
 *
 * @throws PayloadShapeError when `findings` is present but not a list, or contains an
 *   entry that is neither a string nor an object.
 */
function parseFindings(value: unknown): readonly ControlFinding[] {
  if (value === undefined || value === null) {
    return NO_FINDINGS;
  }
  const items = asArray(value);
  if (items === undefined) {
    throw new PayloadShapeError(
      `"findings" is a ${describeJsonType(value)}, but the contract declares a list.`,
    );
  }
  const findings: ControlFinding[] = items.map((item, index) => parseFinding(item, index));
  return findings.length === 0 ? NO_FINDINGS : findings;
}

/**
 * Reads every server warning, in order and verbatim.
 *
 * Strings are taken as-is, which is the shape the API server's warning channel
 * uses. An object carrying a string `message` contributes that message, so a
 * structured warning is not silently dropped.
 */
function parseWarnings(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return NO_WARNINGS;
  }
  const items = asArray(value);
  if (items === undefined) {
    throw new PayloadShapeError(
      `"warnings" is a ${describeJsonType(value)}, but the contract declares a list.`,
    );
  }
  const warnings: string[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item === 'string') {
      warnings.push(item);
      continue;
    }
    if (isRecord(item)) {
      const message = readString(item, 'message');
      if (message === undefined) {
        throw new PayloadShapeError(
          `"warnings[${String(index)}]" is an object with no string "message", so the ` +
            'warning cannot be rendered. It is rejected rather than dropped because the ' +
            'V2 control turns on a warning being PRESENT: under warn=restricted the pod ' +
            'is admitted, and only the warning distinguishes a working Pod Security ' +
            'plugin from an absent one. A dropped warning inverts that verdict.',
        );
      }
      warnings.push(message);
      continue;
    }
    throw new PayloadShapeError(
      `"warnings[${String(index)}]" is a ${describeJsonType(item)}; a warning is either a ` +
        'string or an object carrying a string "message".',
    );
  }
  return warnings.length === 0 ? NO_WARNINGS : warnings;
}

/**
 * Reads the measured facts.
 *
 * An explicit `null` measurement is preserved as `null`; an absent `value`
 * member is not, because "reported as null" and "not reported" are different
 * claims and the V4 oracle depends on the difference
 * (`svcaccttoken_test.go` L1524-1525).
 *
 * INVARIANT LOCKED — EVERY DIAGNOSTIC RAISED HERE IS VALUE-FREE. A refusal names
 * the POSITION it occurred at, the FIELD that was expected and the JSON TYPE that
 * arrived, and nothing else. It never quotes the observation's own `label` and
 * never quotes its `value`.
 *
 * That is a confidentiality rule, not a style preference. A refused payload is
 * surfaced as {@link ControlStatusError.message}, which the aggregate dashboard
 * and every panel render as document text — so a credential placed in a
 * malformed payload's `label` used to travel, unaltered, from an untrusted
 * response into the DOM by way of a parser diagnostic. Naming only the index and
 * the expected shape loses nothing a reader needs: the position identifies the
 * entry precisely, and the payload itself is refused rather than partially
 * rendered, so there is no rendered value for the label to help locate.
 */
function parseObservations(value: unknown): readonly ControlObservation[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const items = asArray(value);
  if (items === undefined) {
    throw new PayloadShapeError(
      `"observations" is a ${describeJsonType(value)}, but the contract declares a list.`,
    );
  }
  const observations: ControlObservation[] = [];
  for (const [index, item] of items.entries()) {
    const at = `"observations[${String(index)}]"`;
    if (!isRecord(item)) {
      throw new PayloadShapeError(
        `${at} is a ${describeJsonType(item)}; an observation is an object carrying a ` +
          'string "label" and a "value".',
      );
    }
    const label = readString(item, 'label');
    if (label === undefined) {
      throw new PayloadShapeError(
        `${at} has no string "label", so the measurement it carries cannot be identified. ` +
          'A measured fact whose identity is unknown is unusable evidence, and dropping it ' +
          'would leave the panel unable to distinguish "not measured" from ' +
          '"measured but unreadable" -- the two demand different verdicts.',
      );
    }
    if (!('value' in item)) {
      throw new PayloadShapeError(
        `${at} carries no "value" member. "Reported as null" and ` +
          '"not reported" are different claims and the V4 control turns on the difference ' +
          `(svcaccttoken_test.go L1524-1525), so an observation with no value at all is ` +
          'rejected rather than being read as either one.',
      );
    }
    const measured = item['value'];
    if (
      measured !== null &&
      typeof measured !== 'string' &&
      typeof measured !== 'number' &&
      typeof measured !== 'boolean'
    ) {
      throw new PayloadShapeError(
        `${at} has a value of type ${describeJsonType(measured)}; ` +
          'a measurement is a string, a finite number, a boolean or null. It is rejected ' +
          'rather than dropped because a MISSING observation reads as "the control did ' +
          'not measure this", which is a claim the server never made.',
      );
    }
    if (typeof measured === 'number' && !Number.isFinite(measured)) {
      throw new PayloadShapeError(
        `${at} is a non-finite number, which compares absurdly ` +
          'against every bound the panels assert.',
      );
    }
    observations.push({ label, value: measured });
  }
  return observations;
}

/**
 * Reads the observed credential lifetime.
 *
 * Invariant locked: each member is copied verbatim by {@link readFiniteNumber}
 * or {@link readString}. Returns `undefined` when no member at all was readable,
 * so an empty husk is never mistaken for a reported lifetime.
 */
function parseExpiry(value: unknown): ControlExpiry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const expirySeconds = readFiniteNumber(value, 'expirySeconds');
  const expirationTimestamp = readString(value, 'expirationTimestamp');
  const requestTimeSeconds = readFiniteNumber(value, 'requestTimeSeconds');
  const leewaySeconds = readFiniteNumber(value, 'leewaySeconds');
  if (
    expirySeconds === undefined &&
    expirationTimestamp === undefined &&
    requestTimeSeconds === undefined &&
    leewaySeconds === undefined
  ) {
    return undefined;
  }
  return { expirySeconds, expirationTimestamp, requestTimeSeconds, leewaySeconds };
}

/**
 * Reads the evidence bag, or `undefined` when nothing usable was reported.
 */
function parseEvidence(value: unknown): ControlEvidence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const audiences = readStringArray(value, 'audiences');
  const requestedTtlSeconds = readFiniteNumber(value, 'requestedTtlSeconds');
  const observedExpiry = parseExpiry(value['observedExpiry']);
  const observations = parseObservations(value['observations']);
  if (
    audiences === undefined &&
    requestedTtlSeconds === undefined &&
    observedExpiry === undefined &&
    observations === undefined
  ) {
    return undefined;
  }
  return { audiences, requestedTtlSeconds, observedExpiry, observations };
}

/**
 * Reads one control payload.
 *
 * @returns the payload, or `undefined` when the entry does not identify one of
 *   the eight known controls. The caller escalates that to a payload error
 *   rather than dropping the entry — see {@link parsePayload}.
 */
function parseControlStatus(value: unknown): ControlStatus | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const controlId = value['controlId'];
  if (!isControlId(controlId)) {
    return undefined;
  }
  return {
    controlId,
    verdict: parseVerdict(value['verdict']),
    summary: readString(value, 'summary') ?? UNREPORTED_SUMMARY,
    detail: readString(value, 'detail'),
    requirementIds: readStringArray(value, 'requirementIds'),
    findings: parseFindings(value['findings']),
    warnings: parseWarnings(value['warnings']),
    evidence: parseEvidence(value['evidence']),
    observedAt: readString(value, 'observedAt'),
  };
}

/** The result of reading a 2xx response body. */
type PayloadOutcome =
  | { readonly ok: true; readonly controls: readonly ControlStatus[] }
  | { readonly ok: false; readonly message: string };

/**
 * Normalises the three accepted top-level body shapes into a list of entries:
 * a bare list of control payloads, a Kubernetes-style list wrapping them under
 * `items`, or a single control payload on its own — which is what the
 * per-control endpoint naturally returns.
 *
 * @returns the entries, or `undefined` when the body is none of those shapes.
 *   A body carrying an `items` member that is not a list is rejected rather
 *   than reinterpreted as a single payload, because that shape is a contract
 *   mismatch and not an alternative spelling.
 */
function selectEntries(body: unknown): readonly unknown[] | undefined {
  const list = asArray(body);
  if (list !== undefined) {
    return list;
  }
  if (!isRecord(body)) {
    return undefined;
  }
  if ('items' in body) {
    return asArray(body['items']);
  }
  return [body];
}

/**
 * Reads a 2xx response body into control payloads.
 *
 * Invariant locked: this FAILS CLOSED. An entry that does not identify a known
 * control aborts the whole read instead of being dropped, because a partial
 * list is indistinguishable, once rendered, from a complete one — and a posture
 * view that silently omits a control it could not understand is exactly the
 * false reassurance AAP §0.11.1 forbids. The same bias produces the V8 control
 * this surface reports on, where a half-configured deployment must fail rather
 * than quietly downgrade.
 *
 * An unrecognised VERDICT is treated differently, and deliberately so: the
 * control is still identified, so `unknown` is a truthful rendering of it.
 * An unrecognised control identifier means the client cannot say what is being
 * reported at all, which is a different kind of ignorance.
 */
function parsePayload(body: unknown, path: string): PayloadOutcome {
  const entries = selectEntries(body);
  if (entries === undefined) {
    return {
      ok: false,
      message:
        `The response from ${path} was neither a control-status object, ` +
        'a list of them, nor a Kubernetes-style list.',
    };
  }
  const controls: ControlStatus[] = [];
  // Records the FIRST index each control was seen at, so a duplicate report can name
  // both positions rather than only the second.
  const seenAt = new Map<ControlId, number>();
  for (const [index, entry] of entries.entries()) {
    let control: ControlStatus | undefined;
    try {
      control = parseControlStatus(entry);
    } catch (error) {
      if (!(error instanceof PayloadShapeError)) {
        // Not a shape complaint: an unexpected fault has no business being reported as a
        // malformed payload, so it propagates to the caller's own failure handling.
        throw error;
      }
      return {
        ok: false,
        message:
          `Entry ${index} of the response from ${path} is malformed: ${error.message} ` +
          'The response is refused rather than partially rendered, because a control ' +
          'this client could not read is indistinguishable, once rendered, from a ' +
          'control with nothing to report.',
      };
    }
    if (control === undefined) {
      return {
        ok: false,
        message:
          `Entry ${index} of the response from ${path} does not identify one ` +
          `of the ${CONTROL_IDS.length} known controls, so the response cannot ` +
          'be trusted to describe them.',
      };
    }
    const firstIndex = seenAt.get(control.controlId);
    if (firstIndex !== undefined) {
      // A DUPLICATE IS A CONTRADICTION, NOT A CHOICE. Two entries for one control tell
      // the reader two things about it, and `selectControlStatus` takes the first -- so
      // which one is believed depends on the order the server serialised them in. A
      // payload reporting V3 as `fail` and then again as `pass` used to render PASS.
      // Refusing is the only answer that neither invents agreement nor picks a winner by
      // list position.
      return {
        ok: false,
        message:
          `The response from ${path} reports control ${control.controlId} more than ` +
          `once, at entries ${firstIndex} and ${index}. Which one is authoritative ` +
          'cannot be determined, and resolving it by list order would make the rendered ' +
          'verdict depend on serialisation order rather than on evidence.',
      };
    }
    seenAt.set(control.controlId, index);
    controls.push(control);
  }
  return { ok: true, controls };
}

/**
 * Reads a 2xx body, keeping a JSON syntax failure distinguishable from a
 * transport failure.
 *
 * `204 No Content` is the explicit "nothing to report" contract, so it resolves
 * to the empty state rather than to a parse failure. An empty body under any
 * OTHER 2xx status stays a payload error, and that asymmetry is deliberate: for
 * a security-posture view, refusing to render is safer than rendering "no
 * controls" for a server that merely answered with nothing.
 *
 * An abort surfacing during the read is re-thrown untouched, so the caller's
 * single abort guard remains the only place that decides an abort is not a
 * failure.
 */
async function readPayload(response: Response, path: string): Promise<PayloadOutcome> {
  if (response.status === NO_CONTENT_STATUS) {
    return { ok: true, controls: NO_CONTROLS };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { ok: false, message: `The response from ${path} was not valid JSON.` };
  }
  return parsePayload(body, path);
}

/** The `message` and `reason` of a Kubernetes `Status` body, when readable. */
interface StatusBody {
  readonly message?: string;
  readonly reason?: string;
}

/**
 * Reads the `Status` body that accompanies a non-2xx response, so a panel can
 * show the server's own words — the presentation-layer counterpart of the Go
 * oracle's `apierrors.IsForbidden` inspection.
 *
 * Never throws. An error body is optional diagnostic detail and never the
 * failure itself, so a body that cannot be read or parsed degrades to "no
 * extra detail" rather than masking a reported 403 or 500 with a parse failure.
 */
async function readStatusBody(response: Response): Promise<StatusBody> {
  try {
    const text = await response.text();
    if (text.trim() === '') {
      return {};
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return {};
    }
    // Both members are SERVER-SUPPLIED prose, so both are bounded and redacted
    // here at the boundary they enter through rather than at each of the ten
    // places they are eventually rendered. `safeProse` leaves ordinary wording
    // untouched, so the server still gets to say what went wrong in its own
    // words -- it simply cannot say it with a credential, a control character or
    // an unbounded string (AAP §0.11.1).
    const message = readString(parsed, 'message');
    const reason = readString(parsed, 'reason');
    return {
      message: message === undefined ? undefined : safeProse(message),
      reason: reason === undefined ? undefined : safeProse(reason),
    };
  } catch {
    // Reaching here means the body was unreadable or was not JSON. The status
    // code has already been captured by the caller, and an abort that surfaces
    // here is caught by the caller's own guard before any state is committed,
    // so returning "no detail" is the complete and correct handling.
    return {};
  }
}

/**
 * Fallback failure text for a non-2xx response with no `Status` message.
 *
 * `statusText` is chosen by the server, so it is sanitized before being
 * composed in: it is the same class of external text as a `Status` message and
 * reaches the same rendered error line.
 */
function describeHttpFailure(response: Response, path: string): string {
  const statusText = safeProse(response.statusText);
  return statusText === ''
    ? `Request to ${path} failed with HTTP ${response.status}.`
    : `Request to ${path} failed with HTTP ${response.status} ${statusText}.`;
}

/**
 * Failure text for a request that produced no response at all.
 *
 * `DOMException` is tested separately from `Error` rather than being assumed to
 * inherit from it. Measured, not assumed: under the pinned jsdom the platform
 * rejects with a `DOMException` for which `instanceof Error` is FALSE, so
 * checking only `Error` would silently discard the platform's own wording for
 * every `NetworkError` and `TimeoutError` and leave the panel with nothing but a
 * generic sentence. Whatever detail exists is carried through verbatim; only a
 * genuinely absent one falls back.
 */
function describeNetworkFailure(error: unknown, path: string): string {
  // Bounded and redacted like every other message this hook did not author: a
  // platform error message can carry the request URL, and a URL can carry a
  // query parameter that carries a token.
  const detail =
    error instanceof DOMException || error instanceof Error ? safeProse(error.message) : '';
  return detail === ''
    ? `Request to ${path} could not be completed.`
    : `Request to ${path} could not be completed: ${detail}`;
}

/**
 * Recognises an aborted request.
 *
 * Invariant locked: recognition is by the error's `name`, never by matching its
 * message text, which is implementation-defined and localisable. `DOMException`
 * is checked explicitly because that is what the platform `fetch` rejects with
 * on abort; the `Error` branch covers a runtime that rejects with a plain error
 * of the same name.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

/** The hook's internal state: the returned arms without the refresh handle. */
type ControlStatusSnapshot =
  | Omit<ControlStatusLoadingResult, 'refresh'>
  | Omit<ControlStatusSuccessResult, 'refresh'>
  | Omit<ControlStatusErrorResult, 'refresh'>;

/**
 * The one loading snapshot, shared so that its identity is stable. React bails
 * out of a re-render when a state update returns the value it already holds,
 * which is what keeps the first mount from rendering `loading` twice.
 */
const LOADING_SNAPSHOT: ControlStatusSnapshot = Object.freeze({ status: 'loading' as const });

/**
 * Wall-clock ceiling for a single control-status request, in milliseconds.
 *
 * An `AbortController` alone bounds only what the CONSUMER does — unmount,
 * refresh, a changed path. It cannot bound what the SERVER does, and the failure
 * that matters here is the one it cannot see: a server that accepts the
 * connection and then never responds. `fetch` has no default timeout, so without
 * this the promise never settles, nothing is committed, and the panel stays in
 * `loading` for as long as the tab is open — a posture surface that silently
 * shows nothing rather than reporting that it could not read.
 *
 * 15 seconds is chosen from the contract this UI renders rather than from taste:
 * the admission webhook it reports on is committed to `timeoutSeconds: 5` and the
 * KMS envelope call to `timeout: 3s` (AAP §0.10.2), so a healthy control-plane
 * read completes well inside it, while a request still outstanding at 15s has
 * stopped being slow and started being wedged.
 */
export const CONTROL_STATUS_REQUEST_TIMEOUT_MS = 15_000;

/** Message committed when {@link CONTROL_STATUS_REQUEST_TIMEOUT_MS} elapses. */
const TIMEOUT_MESSAGE =
  `The control-status request did not complete within ${CONTROL_STATUS_REQUEST_TIMEOUT_MS / 1000}s ` +
  'and was cancelled. No posture verdict can be shown for it. Retry to re-issue the request.';

/**
 * Reads the posture of one hardening control, or of all eight at once.
 *
 * Called with no argument it queries {@link CONTROL_STATUS_BASE_PATH} and
 * returns every control the server reports, which is what the aggregate
 * dashboard needs. Called with a {@link ControlId} it queries that control's own
 * endpoint, which is what a single panel needs. Either way the successful arm
 * carries a list, so both callers read the payload the same way — use
 * {@link selectControlStatus} to pick one out.
 *
 * INVARIANTS LOCKED BY THIS FUNCTION:
 *
 *   1. A non-2xx response — 403 and 500 in particular — resolves to the error
 *      arm and can NEVER be represented as a pass verdict. `fetch` does not
 *      reject on a non-2xx status, so `response.ok` is checked explicitly, and
 *      the error arm has no `controls` member for a verdict to live in.
 *   2. An aborted request is NOT a failure. It resolves to nothing at all: no
 *      error is surfaced, no state is committed, and the previous result is not
 *      left behind as though it were fresh. The in-flight request is aborted
 *      both when the hook unmounts and when its input changes, and every state
 *      update is gated on the request still being the current one, so no update
 *      can land on an unmounted component.
 *   3. Every value the server sends is surfaced verbatim. Nothing is rounded,
 *      clamped, re-scaled or re-parsed.
 *   4. Loading, success, empty and error are four separately observable states.
 *
 * @param controlId - the single control to query, or omitted for all of them.
 * @returns a discriminated union; narrow on `status` before reading anything
 *   else, and call `refresh()` to re-issue the request.
 */
export function useControlStatus(controlId?: ControlId): UseControlStatusResult {
  const [snapshot, setSnapshot] = useState<ControlStatusSnapshot>(LOADING_SNAPSHOT);
  // Bumped by refresh(). It is part of the effect's dependency list, so a
  // refresh re-runs exactly the same code path as the initial load, rather than
  // a parallel one that could drift away from it.
  const [attempt, setAttempt] = useState(0);
  const path = controlStatusPath(controlId);

  useEffect(() => {
    const controller = new AbortController();
    // Flipped by the cleanup below. Checked alongside the abort signal because
    // the two are not redundant: cleanup marks this effect run superseded even
    // in the window before an in-flight read observes the abort.
    let current = true;
    // Set by the deadline timer BEFORE it aborts. This is what separates the two
    // reasons a request can end without a response, which the abort signal alone
    // cannot distinguish: a consumer cancellation must commit nothing, while a
    // deadline must commit an error. Without this flag a timeout implemented by
    // aborting is swallowed by the same branch that ignores unmount, and the hook
    // stays in `loading` exactly as it did before the deadline existed.
    let timedOut = false;

    const commit = (next: ControlStatusSnapshot): void => {
      // `timedOut` deliberately overrides the aborted check: the deadline aborts
      // the controller on purpose, so its own error must still be committable.
      if (!current || (controller.signal.aborted && !timedOut)) {
        return;
      }
      setSnapshot(next);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      // Abort as well as flag: the flag decides what is reported, the abort
      // actually releases the socket and stops the response being parsed.
      controller.abort();
      commit({
        status: 'error',
        error: { kind: 'timeout', message: TIMEOUT_MESSAGE },
      });
    }, CONTROL_STATUS_REQUEST_TIMEOUT_MS);

    // Returning the previous value unchanged when it is already the loading
    // snapshot keeps the identity stable, so the first mount does not re-render
    // and only a genuine success-or-error -> loading transition does.
    setSnapshot((previous) => (previous.status === 'loading' ? previous : LOADING_SNAPSHOT));

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(path, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          // A refresh that could be served from cache would render stale
          // posture, which defeats the affordance.
          cache: 'no-store',
        });

        if (!response.ok) {
          const body = await readStatusBody(response);
          commit({
            status: 'error',
            error: {
              kind: 'http',
              httpStatus: response.status,
              reason: body.reason,
              message: body.message ?? describeHttpFailure(response, path),
            },
          });
          return;
        }

        const outcome = await readPayload(response, path);
        if (!outcome.ok) {
          commit({
            status: 'error',
            error: { kind: 'payload', httpStatus: response.status, message: outcome.message },
          });
          return;
        }

        commit({
          status: 'success',
          controls: outcome.controls,
          isEmpty: outcome.controls.length === 0,
        });
      } catch (error) {
        if (timedOut) {
          // The deadline already committed the timeout error. The abort it raised
          // arrives here as an AbortError; reporting it again as a network
          // failure would overwrite the accurate diagnosis with a vaguer one.
          return;
        }
        if (isAbortError(error) || controller.signal.aborted) {
          // Invariant 2: a CONSUMER abort is not a failure, so nothing is
          // committed. Reached on unmount, refresh and a changed path.
          return;
        }
        commit({
          status: 'error',
          error: { kind: 'network', message: describeNetworkFailure(error, path) },
        });
      } finally {
        // Deterministic in every outcome — success, HTTP error, payload error,
        // network error, consumer abort and the timeout itself. A timer that
        // outlived its request would abort a LATER one, so this is cleared here
        // as well as in the cleanup below rather than only there.
        clearTimeout(deadline);
      }
    };

    void load();

    return () => {
      current = false;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [path, attempt]);

  const refresh = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  // Memoised so that a re-render with an unchanged snapshot hands consumers the
  // same object, keeping the result safe to use as an effect dependency.
  return useMemo<UseControlStatusResult>(() => {
    if (snapshot.status === 'success') {
      return {
        status: 'success',
        controls: snapshot.controls,
        isEmpty: snapshot.isEmpty,
        refresh,
      };
    }
    if (snapshot.status === 'error') {
      return { status: 'error', error: snapshot.error, refresh };
    }
    return { status: 'loading', refresh };
  }, [snapshot, refresh]);
}
