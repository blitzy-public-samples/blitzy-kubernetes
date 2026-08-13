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

/**
 * Contract tests for `useControlStatus`: every way a control verdict can be wrong.
 *
 * AAP §0.5.1 (the `web/src/hooks/useControlStatus.test.ts` row, whose purpose column reads
 * exactly "Fetch success, 403, 500, abort") / §0.4.2.4 (the same four categories restated as
 * this file's blueprint) / §0.4.1.2 (the assertion-semantics translation table, which is why
 * `expect.soft` and a hard `expect` appear side by side below rather than one of them
 * everywhere) / §0.7.2 (the test-quality criteria: preserved assertion density, structural
 * isolation, parallel safety, determinism, failure legibility) / tech-spec §6.6.3.4 (the
 * documentation convention this provenance block and the per-test invariant comments satisfy).
 *
 * RULES POSITION. `review_rules` returns exactly one line: "No user rules provided." No rule is
 * invented here, and their absence is not treated as licence to lower the bar — AAP §0.11.1's
 * enterprise-standard bar substitutes, and the items that bind this file are named at the
 * assertions that honour them.
 *
 * THE FOUR MANDATED CATEGORIES ARE THE FIRST FOUR `describe` BLOCKS, in the order AAP §0.5.1
 * lists them, so a reader can confirm the row is discharged without reading the rest. The
 * groups after them are the supporting surface: the envelope shapes, the fail-closed parser,
 * the duplicate contradiction, the exported helpers and the defensive failure-body reads.
 *
 * WHAT THIS HOOK IS FOR, AND THEREFORE WHAT ITS SPECS MUST PROVE. It is the only path by which
 * a control verdict reaches the screen, so its failure mode is not "an error is mishandled" but
 * "a posture the server never reported is rendered as fact". Every test below is an instance of
 * that one risk:
 *
 * 1. NO FALSE PASSES. A 403 and a 500 each resolve to an error state, and this file asserts
 *    POSITIVELY that no pass verdict is present in that state rather than merely that an error
 *    flag is set. {@link reportedPassVerdicts} reads `controls` defensively off the whole union
 *    for exactly that reason: were a verdict ever smuggled into the error arm, the assertion
 *    would see it and go red.
 * 2. FAIL CLOSED ON A MALFORMED PAYLOAD. A response this client cannot fully read is refused,
 *    never partially rendered. The three parsers used to DEGRADE instead — filtering an invalid
 *    array member out, skipping a malformed finding, emptying an unreadable list — and each
 *    degradation converts "I could not read this" into "there was nothing to report", which is
 *    the single most dangerous transformation a security UI can perform.
 * 3. A REFUSAL IS NOT AN EMPTY RESULT. `fetch` does not reject on 4xx or 5xx, so a 403 must
 *    reach `status: 'error'` and must stay distinguishable from the explicit empty state, which
 *    is a SUCCESS carrying nothing.
 * 4. A DUPLICATE IS A CONTRADICTION. Two entries for one control are refused rather than
 *    resolved by list order.
 * 5. AN ABORT IS NOT A FAILURE. Unmounting, changing the input or refreshing must not paint an
 *    error and must not leave a stale result behind.
 *
 * DETERMINISM IS STRUCTURAL HERE, NOT HOPED FOR (AAP §0.11.1, "isolation and determinism as
 * first-class properties"). `web/vitest.config.ts` sets `isolate: true` and configures neither
 * `retry` nor `bail`, and `hack/jenkins/test-dockerized.sh` runs `make test-web` under
 * `set -o errexit` — so one flaky spec fails the entire Prow job with nothing to hide it. Two
 * consequences are honoured throughout: there is not one wall-clock sleep in this file, and
 * every "the response has not arrived yet" moment is produced by {@link gateResponse}, whose
 * handler waits on a promise this file resolves by hand. A timing assumption cannot be wrong if
 * there is no timing assumption.
 *
 * THE MSW LIFECYCLE IS NOT THIS FILE'S. `../test/msw/server` owns `listen`, `resetHandlers` and
 * `close`, and `../setupTests` owns the DOM matcher registration and the RTL unmount. Nothing here re-registers any
 * of them: per-test responses are installed with `server.use(...)` only, and the global
 * `afterEach` in that module discards them. The one thing this file does own is putting back
 * what it replaces — the two `vi.spyOn` calls in the abort group are restored by that group's
 * own hook, which is the arrangement `../setupTests` documents and relies on.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_FAILING_CONTROL_STATUSES,
  ALL_PASSING_CONTROL_STATUSES,
  ALL_UNKNOWN_CONTROL_STATUSES,
  EXPECTED_VERDICT_BY_VARIANT,
  FORBIDDEN_CONTROL_STATUS_ERROR,
  FORBIDDEN_STATUS,
  INTERNAL_SERVER_ERROR_STATUS,
  MIXED_CONTROL_STATUSES,
  NOT_FOUND_STATUS,
  NO_CONTROL_STATUSES,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V4_AUDIENCES,
  V4_EXPIRY_LEEWAY_SECONDS,
  V4_REQUESTED_TTL_SECONDS,
  V4_TOKEN_EVIDENCE,
  V4_TOKEN_PASSING,
  WARNING_CONTROL_STATUSES,
  controlStatusFixture,
  controlStatusListFixture,
} from '../test/fixtures/controlStatus';
import type { ControlStatusVariant, PostureRequirementId } from '../test/fixtures/controlStatus';
import { server } from '../test/msw/server';
import {
  CONTROL_IDS,
  CONTROL_STATUS_BASE_PATH,
  controlStatusPath,
  isControlId,
  selectControlStatus,
  useControlStatus,
} from './useControlStatus';
import type { ControlId, ControlStatus, UseControlStatusResult } from './useControlStatus';

// ---------------------------------------------------------------------------
// Failure legibility.
// ---------------------------------------------------------------------------

/**
 * Composes an assertion message that names the requirement it enforces.
 *
 * AAP §0.7.2 makes this a criterion rather than a nicety: the reader of a CI failure on a
 * security test is often not the author of the test, so a failure must read as a requirement
 * violation and not as a value mismatch. Typing the identifier as
 * {@link PostureRequirementId} — the closed union `../test/fixtures/controlStatus` declares —
 * turns a mistyped or invented identifier into a `tsc --noEmit` error, which is also how
 * AAP §0.11.1's "cite only what the repository states" is enforced here rather than merely
 * intended: no external benchmark or hardening-guide control number is expressible.
 *
 * @param requirementId - the repository's own requirement identifier.
 * @param invariant - what must hold, phrased as the property rather than as the value.
 * @returns the composed message, for the second argument of `expect` or `expect.soft`.
 */
function forRequirement(requirementId: PostureRequirementId, invariant: string): string {
  return `${requirementId}: ${invariant}`;
}

// ---------------------------------------------------------------------------
// Wire helpers. Every response this file serves is stated by the test that needs it, so no
// test inherits a body it never mentions -- a spec whose outcome depends on a fixture it does
// not name is a spec that breaks when an unrelated fixture is edited.
//
// The bodies themselves come from `../test/fixtures/controlStatus`, which AAP §0.5.1 makes the
// single definition site for the recorded wire shapes. Nothing below invents a payload; the
// malformed cases are MUTATIONS of a recorded one (see `wireEntry`), which is a sharper test
// than an invented minimal object because the mutation is the only difference.
// ---------------------------------------------------------------------------

/**
 * Serves `controls` at `path` as a Kubernetes-style list, the shape the recorded collection
 * handler uses.
 *
 * @param controls - the payloads to report, in the order the server would serialise them.
 * @param path - the endpoint to answer. Defaults to the collection.
 */
function respondWithControlList(
  controls: readonly ControlStatus[],
  path: string = CONTROL_STATUS_BASE_PATH,
): void {
  server.use(http.get(path, () => HttpResponse.json({ items: controls })));
}

/**
 * Serves `controls` at the collection path as a BARE list, the second accepted envelope.
 *
 * @param controls - the payloads to report.
 */
function respondWithBareList(controls: readonly ControlStatus[]): void {
  server.use(http.get(CONTROL_STATUS_BASE_PATH, () => HttpResponse.json(controls)));
}

/**
 * Serves one payload as a bare object, which is what the per-control endpoint returns.
 *
 * @param control - the payload to report.
 * @param path - the endpoint to answer. Defaults to that control's own endpoint, derived with
 *   `controlStatusPath` so the URL is never spelled out a second time.
 */
function respondWithControl(control: ControlStatus, path?: string): void {
  server.use(http.get(path ?? controlStatusPath(control.controlId), () => HttpResponse.json(control)));
}

/**
 * Serves raw bytes with a JSON content type, valid or not.
 *
 * Used for every case whose point is that the BYTES are wrong — an empty body, truncated JSON,
 * a bare scalar, a number JSON cannot round-trip. Serialising through `HttpResponse.json`
 * could not express those, and reaching for a type assertion to force it would hide the very
 * shape under test.
 *
 * @param text - the exact response body.
 * @param status - the HTTP status. Defaults to 200, because these cases are about a successful
 *   transport carrying an unusable payload.
 * @param path - the endpoint to answer. Defaults to the collection.
 */
function respondWithRawJson(
  text: string,
  status = 200,
  path: string = CONTROL_STATUS_BASE_PATH,
): void {
  server.use(
    http.get(
      path,
      () => new HttpResponse(text, { status, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

/** The `Status` body a Kubernetes API server returns with a refusal. */
interface KubernetesStatusWire {
  /** The HTTP status, repeated in the body exactly as the API server repeats it. */
  readonly code: number;
  /** The machine-readable reason, for example `Forbidden`. */
  readonly reason: string;
  /** The server's own explanation, which a panel shows in preference to a generic sentence. */
  readonly message: string;
}

/**
 * Serves a refusal as a realistic Kubernetes `Status` body.
 *
 * AAP §0.4.4.3 requires the request handlers to replay real API-server wire shapes rather than
 * invented ones, so the envelope is the genuine `kind: Status` / `apiVersion: v1` /
 * `status: Failure` document with `code`, `reason` and `message` — the wire-level counterpart
 * of the `apierrors.IsForbidden` inspection at `podsecurity_test.go` L407 and L419. Callers
 * pass the recorded values from `../test/fixtures/controlStatus`, so the status, reason and
 * message still have exactly one definition site.
 *
 * @param wire - the recorded code, reason and message.
 * @param path - the endpoint to refuse. Defaults to the collection.
 */
function respondWithKubernetesStatus(
  wire: KubernetesStatusWire,
  path: string = CONTROL_STATUS_BASE_PATH,
): void {
  server.use(
    http.get(
      path,
      () =>
        HttpResponse.json(
          {
            kind: 'Status',
            apiVersion: 'v1',
            metadata: {},
            status: 'Failure',
            code: wire.code,
            reason: wire.reason,
            message: wire.message,
          },
          { status: wire.code },
        ),
    ),
  );
}

/**
 * A recorded payload with `overrides` applied on top, as an untyped wire record.
 *
 * The base is the RECORDED fixture, not an invented minimal object, so a malformed-payload
 * case differs from a well-formed one in exactly the member it overrides and in nothing else.
 * That is what makes the resulting assertion attributable: when it goes red, the override is
 * the only candidate.
 *
 * The return type is deliberately `Record<string, unknown>` rather than `ControlStatus`. These
 * bodies are, by construction, NOT valid `ControlStatus` values — describing them as one would
 * need a type assertion, and a spec that has to lie to the compiler about its own input is a
 * spec that can no longer detect the contract changing underneath it.
 *
 * @param controlId - which recorded payload to start from.
 * @param overrides - members to replace, including members whose types are wrong on purpose.
 * @returns the wire record, ready for `JSON.stringify`.
 */
function wireEntry(
  controlId: ControlId,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...controlStatusFixture(controlId), ...overrides };
}

/**
 * Serves `entries` at the collection path as the bytes they serialise to.
 *
 * @param entries - wire records, typically from {@link wireEntry}.
 */
function respondWithWireEntries(entries: readonly Record<string, unknown>[]): void {
  respondWithRawJson(JSON.stringify(entries));
}

// ---------------------------------------------------------------------------
// Rendering and assertion helpers.
// ---------------------------------------------------------------------------

/**
 * Renders the hook and waits until it leaves `loading`.
 *
 * `waitFor` rather than a sleep, so the wait ends when the state actually changes.
 *
 * @param controlId - the control to query, or omitted for the collection.
 * @returns the settled result, either the success arm or the error arm.
 */
async function settled(controlId?: ControlId): Promise<UseControlStatusResult> {
  const { result } = renderHook(() => useControlStatus(controlId));
  await waitFor(() => {
    expect(result.current.status).not.toBe('loading');
  });
  return result.current;
}

/**
 * Settles the hook and asserts it reached the SUCCESS arm.
 *
 * The `throw` after the assertion is the narrowing, not a second check: `expect` does not
 * inform the compiler, and returning the narrowed arm is what lets every caller read
 * `controls` without repeating the guard. Deliberately a hard `expect` and a `throw` rather
 * than `expect.soft` — this is the analogue of the `t.Fatalf` at `rbac_test.go` L1252-1254,
 * where the payload not loading at all is "test setup broken" and makes every assertion after
 * it meaningless (AAP §0.4.1.2).
 *
 * @param controlId - the control to query, or omitted for the collection.
 * @returns the success arm, narrowed.
 */
async function settledSuccess(
  controlId?: ControlId,
): Promise<Extract<UseControlStatusResult, { status: 'success' }>> {
  const result = await settled(controlId);
  expect(result.status, 'the payload must load before anything can be asserted about it').toBe(
    'success',
  );
  if (result.status !== 'success') {
    throw new Error(`expected the success arm, got ${result.status}`);
  }
  return result;
}

/**
 * Settles the hook and asserts it reached the ERROR arm.
 *
 * @param controlId - the control to query, or omitted for the collection.
 * @returns the error arm, narrowed.
 */
async function settledError(
  controlId?: ControlId,
): Promise<Extract<UseControlStatusResult, { status: 'error' }>> {
  const result = await settled(controlId);
  expect(result.status, 'a refused or unreadable response must reach the error arm').toBe('error');
  if (result.status !== 'error') {
    throw new Error(`expected the error arm, got ${result.status}`);
  }
  return result;
}

/**
 * Asserts a PAYLOAD error and returns its message, so a test can name what was refused.
 *
 * @returns the refusal message the hook composed.
 */
async function refusedMessage(): Promise<string> {
  const result = await settledError();
  expect(result.error.kind, 'an unreadable 2xx body is a payload error, not a transport one').toBe(
    'payload',
  );
  return result.error.message;
}

/**
 * A hook result read for a verdict without first trusting which arm it is in.
 *
 * The discriminant is required and `controls` is optional, which describes every arm of
 * {@link UseControlStatusResult} at once: the success arm supplies both, and the loading and
 * error arms supply only `status`. See {@link reportedPassVerdicts} for why the read is
 * deliberately arranged this way round.
 */
interface PossiblyVerdictCarrying {
  /** The arm the result is in. */
  readonly status: UseControlStatusResult['status'];
  /** The reported controls, present only on the success arm — which is the property under test. */
  readonly controls?: readonly ControlStatus[];
}

/**
 * Every control the result reports as PASSING, whatever arm it is in.
 *
 * THIS IS THE FILE'S CENTRAL ASSERTION HELPER, and its defensive shape is the whole point.
 * AAP §0.11.1's "no false passes" requires a 403 and a 500 to be asserted POSITIVELY as
 * carrying no pass verdict, not merely as having an error flag set. Reading `controls` off the
 * union — rather than off the success arm after narrowing — is what makes that assertion able
 * to fail: if the hook were ever changed to answer a refusal with a verdict, this helper would
 * SEE the verdict and the assertion would go red. Narrowing first would silently return the
 * empty list instead and the assertion would pass for the wrong reason, which is the exact
 * class of false reassurance this file exists to prevent.
 *
 * That the error arm has no `controls` member is enforced separately, and structurally, by
 * `tsc --noEmit` under `strict`. The two checks are complementary: the compiler stops a panel
 * from reaching a verdict through the type, and this helper stops the hook from putting one
 * there at run time.
 *
 * @param result - any arm of the hook's result.
 * @returns the identifiers reported as `pass`, in the order the server reported them.
 */
function reportedPassVerdicts(result: UseControlStatusResult): readonly ControlId[] {
  // `status` is named alongside the optional `controls` so this stays a normal structural
  // assignment rather than a type assertion. TypeScript rejects an all-optional target here --
  // the error arm would have "no properties in common" with it -- and reaching for `as` to get
  // past that would switch off the very checking that keeps this helper honest when the hook's
  // result type changes.
  const carrier: PossiblyVerdictCarrying = result;
  return (carrier.controls ?? [])
    .filter((control) => control.verdict === 'pass')
    .map((control) => control.controlId);
}

/**
 * The `name` of an abort reason, read structurally.
 *
 * `instanceof DOMException` is deliberately NOT how this reaches `name`. MEASURED: under the
 * pinned jsdom the reason the platform attaches to an aborted signal is a `DOMException` created
 * in a DIFFERENT realm, so `reason instanceof DOMException` is FALSE even though the object is
 * one — the mirror image of the realm mismatch the hook's own `describeNetworkFailure` records,
 * where a `DOMException` is not `instanceof Error`. An `instanceof` test therefore answers a
 * question about provenance when the question that matters is what the reason IS.
 *
 * Reading `name` is still reading the NAME and not the message text, which is what AAP §0.5.1
 * requires: `AbortError` is the platform contract the hook's own `isAbortError` keys on, whereas
 * the message ("This operation was aborted") is implementation-defined and localisable, so a
 * spec matching it would go red on a jsdom upgrade that reworded it.
 *
 * @param reason - `AbortSignal.reason`, whose type the platform leaves open.
 * @returns the reason's `name` when it has a string one, otherwise its stringification, so a
 *   failure still shows what was actually there rather than `undefined`.
 */
function abortReasonName(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.name;
  }
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    typeof reason.name === 'string'
  ) {
    return reason.name;
  }
  return String(reason);
}

/** A response held back until the test releases it. See {@link gateResponse}. */
interface ResponseGate {
  /** Lets the held response through. Safe to call more than once. */
  readonly release: () => void;
  /** Resolves once the handler has actually produced the response. */
  readonly served: Promise<void>;
  /** How many times the gated endpoint has been requested. */
  readonly requestCount: () => number;
}

/**
 * Registers a handler whose response does not arrive until this test says so.
 *
 * THIS IS HOW THE FILE STAYS DETERMINISTIC. Every case that needs an in-flight request — the
 * observable loading state, and all three abort cases — needs a response that has demonstrably
 * NOT arrived yet. The tempting way to arrange that is a delay in the handler and a sleep in
 * the test, which is a race: it passes while the delay happens to exceed the scheduling jitter
 * of the machine, and AAP §0.11.1 forbids exactly that because a flake here fails the whole
 * Prow job under `set -o errexit`. Waiting on a promise the test resolves by hand has no such
 * dependency: the response cannot arrive early on a fast machine and cannot arrive late on a
 * slow one, because it does not arrive until `release()` is called.
 *
 * Releasing at the end of the case is not tidiness either. It lets the handler complete so the
 * test can then prove the discarded response was genuinely discarded rather than merely not
 * yet delivered — which is the difference between asserting an abort and asserting a delay.
 *
 * @param path - the endpoint to gate.
 * @param respond - builds the response, called only after `release()`.
 * @returns the gate handle.
 */
function gateResponse(path: string, respond: () => Response): ResponseGate {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announceServed = (): void => {};
  const served = new Promise<void>((resolve) => {
    announceServed = resolve;
  });
  let requests = 0;

  server.use(
    http.get(path, async () => {
      requests += 1;
      await released;
      announceServed();
      return respond();
    }),
  );

  return { release, served, requestCount: () => requests };
}

/**
 * Lets every pending microtask and every scheduled React update run to completion.
 *
 * `act` rather than a timer: it flushes the work React has queued and returns when there is
 * none left, which is a statement about the queue rather than about the clock. Used after a
 * gate is released to prove that the response which then arrived changed nothing.
 */
async function flushPendingWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * The recorded default: the collection answers with all eight controls passing.
 *
 * Stated explicitly rather than inherited from `../test/msw/handlers`, even though that module
 * registers an equivalent handler, so that no case below depends on a body it does not name.
 * The payload itself still comes from the fixtures' single definition site.
 */
beforeEach(() => {
  respondWithControlList(controlStatusListFixture());
});

// ===========================================================================
// CATEGORY 1 of 4 (AAP §0.5.1) -- FETCH SUCCESS.
//
// A successful response resolves to a success state carrying the verdict the server reported,
// for every control and for all four verdicts, with the loading state observable before it and
// cleared after it.
// ===========================================================================

describe('category 1 of 4 — a successful fetch carries the recorded verdict', () => {
  /**
   * The three recorded variants, and the verdict each one is required to carry.
   *
   * Read from `EXPECTED_VERDICT_BY_VARIANT` rather than hardcoded, so a fixture whose verdict
   * drifts away from its variant is caught here instead of quietly redefining what "passing"
   * means. Table-driven because that is this repository's dominant idiom — AAP §0.9.2 records
   * `t.Run(` in 1,491 test files — and `describe.each` is its stated translation (§0.4.1.2).
   */
  const SUCCESS_VARIANTS: readonly ControlStatusVariant[] = ['passing', 'failing', 'unknown'];

  describe.each(SUCCESS_VARIANTS)('a %s payload', (variant) => {
    // INVARIANT LOCKED: the payload the server sent is the payload the consumer reads, member
    // for member, for every one of the eight controls. Nothing is rounded, re-scaled, re-parsed
    // or dropped on the way through -- AAP §0.11.1's "never weaken a boundary condition" is a
    // property of the whole payload here, not just of the numbers in it, because a panel can
    // only be as truthful as the evidence it is handed.
    it.each([...CONTROL_IDS])('reads %s verbatim, verdict and evidence together', async (controlId) => {
      const recorded = controlStatusFixture(controlId, variant);
      respondWithControl(recorded);

      const result = await settledSuccess(controlId);
      const control = selectControlStatus(result.controls, controlId);

      // Hard: without the payload, every assertion after this one is vacuous.
      expect(control, `${controlId} must be present in the ${variant} payload`).toBeDefined();
      // Soft from here on: these are INDEPENDENT facts about one payload, and the Go oracle's
      // `t.Errorf` semantics require every one of them to be reported in a single run rather
      // than only the first (AAP §0.4.1.2; `rbac_test.go` L1274-1278).
      expect
        .soft(control?.verdict, `${controlId} ${variant} verdict`)
        .toBe(EXPECTED_VERDICT_BY_VARIANT[variant]);
      expect.soft(control, `${controlId} ${variant} payload, member for member`).toEqual(recorded);
      expect.soft(result.isEmpty, `${controlId} ${variant} is a non-empty success`).toBe(false);
      expect
        .soft(result.controls, `${controlId} ${variant} reports exactly the control asked for`)
        .toHaveLength(1);
    });
  });

  // INVARIANT LOCKED: a `fail` verdict arrives with the evidence that produced it. The oracle
  // reports EVERY offender in one run -- one `t.Errorf` per offending ClusterRole at
  // `rbac_test.go` L1274-1278 and per offending ClusterRoleBinding and subject at L1286-1297 --
  // so a payload that failed must carry at least one finding, and a hook that dropped findings
  // would leave a `fail` verdict with nothing behind it.
  it.each([...CONTROL_IDS])('keeps every finding behind a failing %s verdict', async (controlId) => {
    const recorded = controlStatusFixture(controlId, 'failing');
    respondWithControl(recorded);

    const result = await settledSuccess(controlId);
    const control = selectControlStatus(result.controls, controlId);

    expect(control, `${controlId} must be present in the failing payload`).toBeDefined();
    expect
      .soft(
        control?.findings.length,
        forRequirement('F-001-RQ-002', `a failing ${controlId} must carry the findings that produced it`),
      )
      .toBe(recorded.findings.length);
    expect
      .soft(control?.findings.length, `${controlId} failing findings must not be empty`)
      .toBeGreaterThan(0);
    expect
      .soft(control?.findings, `${controlId} findings survive in order and in full`)
      .toEqual(recorded.findings);
  });

  // INVARIANT LOCKED: `warn` is a FIRST-CLASS verdict, not a shade of pass or fail. The V2
  // oracle's warn=restricted namespace ADMITS a restricted-violating pod -- `err` must be nil
  // at `podsecurity_test.go` L446-448 -- and then requires at least one warning to have been
  // recorded at L451-455. Only the warning distinguishes a working Pod Security configuration
  // from an absent one, so collapsing this into `pass` would lose the control outright.
  it.each(['V2', 'V8'] as const)(
    'reads the admitted-but-warned %s verdict as warn, never as pass',
    async (controlId) => {
      const recorded = WARNING_CONTROL_STATUSES[controlId];
      respondWithControl(recorded);

      const result = await settledSuccess(controlId);
      const control = selectControlStatus(result.controls, controlId);

      expect(control, `${controlId} must be present in the warning payload`).toBeDefined();
      expect
        .soft(
          control?.verdict,
          forRequirement('F-002-RQ-001', 'an operation permitted with a warning is warn, not pass'),
        )
        .toBe('warn');
      expect
        .soft(
          control?.warnings.length,
          forRequirement('F-002-RQ-001', 'the warn verdict must carry the warnings that justify it'),
        )
        .toBeGreaterThan(0);
      expect.soft(control?.warnings, `${controlId} warnings survive verbatim`).toEqual(recorded.warnings);
      expect
        .soft(reportedPassVerdicts(result), `${controlId} warn must not be reported as a pass`)
        .toEqual([]);
    },
  );

  // INVARIANT LOCKED: the aggregate the dashboard reads is the aggregate the server sent, in
  // the server's order and complete. A dashboard showing seven of eight controls looks exactly
  // like one showing all eight when the eighth is the one that went missing.
  it.each([
    ['every control passing', ALL_PASSING_CONTROL_STATUSES],
    ['every control failing', ALL_FAILING_CONTROL_STATUSES],
    ['every control indeterminate', ALL_UNKNOWN_CONTROL_STATUSES],
    ['the realistic mix of verdicts', MIXED_CONTROL_STATUSES],
  ])('reads the whole-dashboard payload with %s', async (_name, recorded) => {
    respondWithControlList(recorded);

    const result = await settledSuccess();

    expect.soft(result.controls, 'the aggregate survives verbatim and in order').toEqual(recorded);
    expect
      .soft(result.controls.map((control) => control.controlId), 'roster order is preserved')
      .toEqual([...CONTROL_IDS]);
    expect.soft(result.isEmpty, 'a full aggregate is not the empty state').toBe(false);
  });

  // INVARIANT LOCKED: loading is a state, observable BEFORE the response and gone after it.
  // Deterministic by construction: the response is held by a gate this test releases, so
  // "before" cannot become "after" on a fast machine.
  it('is observably loading before the response arrives, and not after', async () => {
    const recorded = controlStatusListFixture();
    const gate = gateResponse(CONTROL_STATUS_BASE_PATH, () => HttpResponse.json({ items: recorded }));

    const { result } = renderHook(() => useControlStatus());

    expect(result.current.status, 'the first render is loading, before any response').toBe('loading');
    expect(
      typeof result.current.refresh,
      'refresh exists in the loading arm too, so a loading UI can offer a retry without narrowing',
    ).toBe('function');
    expect(reportedPassVerdicts(result.current), 'loading reports no verdict at all').toEqual([]);

    gate.release();
    await gate.served;
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    if (result.current.status !== 'success') {
      throw new Error(`expected the success arm after release, got ${result.current.status}`);
    }
    expect.soft(result.current.controls, 'the released payload is the recorded one').toEqual(recorded);
    expect.soft(gate.requestCount(), 'exactly one request was issued').toBe(1);
  });

  // INVARIANT LOCKED: the request itself is correctly formed. `cache: 'no-store'` is what stops
  // a refresh being served from cache -- a cached posture is a stale posture, which defeats the
  // affordance -- and the `Accept` header is what asks for the contract this hook parses.
  it('asks for JSON and forbids a cached answer', async () => {
    const observed: { readonly cache: string; readonly accept: string | null }[] = [];
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, ({ request }) => {
        observed.push({ cache: request.cache, accept: request.headers.get('accept') });
        return HttpResponse.json({ items: controlStatusListFixture() });
      }),
    );

    await settledSuccess();

    expect(observed, 'the request must have reached the endpoint').toHaveLength(1);
    expect.soft(observed[0]?.cache, 'a posture read must never be served from cache').toBe('no-store');
    expect.soft(observed[0]?.accept, 'the request declares the contract it parses').toBe(
      'application/json',
    );
  });

  // INVARIANT LOCKED: the V4 boundary evidence reaches the consumer UNTOUCHED. The oracle bounds
  // both the JWT `exp` claim and `status.expirationTimestamp` against requestTime + 3600 s within
  // `const leeway = int64(60)` (`svcaccttoken_test.go` L1498-1514), and AAP §0.10.2 is emphatic
  // that the +/-60 s window is not slack to be tightened or loosened: it is calibrated so a
  // roughly one-year long-lived-token regression still fails while CI jitter is absorbed. A hook
  // that helpfully rounded a timestamp, or re-scaled seconds to milliseconds, would destroy it.
  it('surfaces the V4 audience, TTL and expiry window exactly as issued', async () => {
    respondWithControl(V4_TOKEN_PASSING);

    const result = await settledSuccess('V4');
    const evidence = selectControlStatus(result.controls, 'V4')?.evidence;

    expect(evidence, 'the V4 evidence bag must be present').toBeDefined();
    expect
      .soft(evidence?.audiences, forRequirement('F-004-RQ-001', 'the aud claim is exactly ["api"]'))
      .toEqual([...V4_AUDIENCES]);
    expect
      .soft(
        evidence?.requestedTtlSeconds,
        forRequirement('F-004-RQ-002', 'the requested TTL is reported in seconds, unconverted'),
      )
      .toBe(V4_REQUESTED_TTL_SECONDS);
    expect
      .soft(
        evidence?.observedExpiry?.leewaySeconds,
        forRequirement('F-004-RQ-002', 'the expiry tolerance is reported as the recorded 60 s'),
      )
      .toBe(V4_EXPIRY_LEEWAY_SECONDS);
    expect
      .soft(
        evidence?.observedExpiry,
        forRequirement('F-004-RQ-002', 'every expiry member survives verbatim, none rounded'),
      )
      .toEqual(V4_TOKEN_EVIDENCE.observedExpiry);
    // "Reported as null" and "not reported" are different claims, and V4 turns on the
    // difference: a pod sub-claim reported null is PROOF of an unbound token, while an absent
    // one proves nothing (`svcaccttoken_test.go` L1524-1525).
    expect
      .soft(
        evidence?.observations,
        forRequirement('F-004-RQ-001', 'the claim-shape observations keep their explicit nulls'),
      )
      .toEqual(V4_TOKEN_EVIDENCE.observations);
  });
});


// ===========================================================================
// CATEGORY 2 of 4 (AAP §0.5.1) -- 403 FORBIDDEN.
//
// A refusal resolves to an error state that preserves the status code, shows the server's own
// words, is distinguishable from an empty result, and -- the property this whole file exists
// for -- carries no pass verdict.
// ===========================================================================

describe('category 2 of 4 — a 403 Forbidden can never be reported as a passing control', () => {
  /**
   * The recorded 403 as it appears on the wire.
   *
   * Built from `FORBIDDEN_CONTROL_STATUS_ERROR` so the status, reason and message keep their
   * single definition site, and shaped as a genuine Kubernetes `Status` document because
   * AAP §0.4.4.3 requires the handlers to replay real API-server wire shapes. 403 is precisely
   * what `apierrors.IsForbidden` asserts on at `podsecurity_test.go` L407 and L419.
   */
  const FORBIDDEN_WIRE: KubernetesStatusWire = {
    code: FORBIDDEN_STATUS,
    reason: FORBIDDEN_CONTROL_STATUS_ERROR.reason,
    message: FORBIDDEN_CONTROL_STATUS_ERROR.message,
  };

  // INVARIANT LOCKED, AND IT IS THE CENTRAL ONE: a forbidden request resolves to an error state
  // and NO PASS VERDICT IS PRESENT IN IT. Asserted positively -- `reportedPassVerdicts` reads
  // `controls` off the whole union, so a hook that answered a refusal with a verdict would be
  // caught here rather than passing because the narrowing hid it.
  it('resolves a refused collection to an error carrying no verdict', async () => {
    respondWithKubernetesStatus(FORBIDDEN_WIRE);

    const result = await settledError();

    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-001-RQ-002', 'a forbidden request must never be reported as a passing control'),
      )
      .toEqual([]);
    expect.soft(result.error.kind, 'a non-2xx response is a transport-level http failure').toBe('http');
    expect
      .soft(result.error.httpStatus, forRequirement('F-001-RQ-002', 'the 403 status is preserved verbatim'))
      .toBe(FORBIDDEN_STATUS);
    expect
      .soft(result.error.reason, 'the Kubernetes Status reason reaches the panel unchanged')
      .toBe(FORBIDDEN_CONTROL_STATUS_ERROR.reason);
    expect
      .soft(result.error.message, "the panel shows the server's own explanation")
      .toBe(FORBIDDEN_CONTROL_STATUS_ERROR.message);
    // Structural, not conventional: the error arm has no `controls` and no `isEmpty`, so a panel
    // cannot reach a verdict from a refusal even by accident. Attempting it is a compile error.
    expect.soft('controls' in result, 'the error arm exposes no controls member').toBe(false);
    expect.soft('isEmpty' in result, 'the error arm exposes no isEmpty member').toBe(false);
  });

  // INVARIANT LOCKED: the per-control endpoint refuses the same way as the collection. A panel
  // that reads one control must not have its own, softer, failure path.
  it.each([...CONTROL_IDS])('resolves a refused %s endpoint to an error carrying no verdict', async (controlId) => {
    respondWithKubernetesStatus(FORBIDDEN_WIRE, controlStatusPath(controlId));

    const result = await settledError(controlId);

    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-001-RQ-002', `a forbidden ${controlId} read must not report ${controlId} as passing`),
      )
      .toEqual([]);
    expect.soft(result.error.httpStatus, `${controlId} preserves the 403`).toBe(FORBIDDEN_STATUS);
    expect.soft(result.error.kind, `${controlId} refusal is an http failure`).toBe('http');
  });

  // INVARIANT LOCKED: A REFUSAL AND AN EMPTY RESULT MUST NEVER LOOK ALIKE. The empty state is a
  // SUCCESS carrying nothing -- the server had nothing to report -- while a 403 means the caller
  // was not allowed to find out. Rendering the second as the first asserts a clean bill of
  // health on no evidence at all, so the two are compared here side by side rather than each
  // being checked in isolation against a remembered expectation.
  it('is distinguishable from the explicit empty state, which is a success', async () => {
    respondWithKubernetesStatus(FORBIDDEN_WIRE);
    const refused = await settled();

    respondWithControlList(NO_CONTROL_STATUSES);
    const empty = await settled();

    expect(refused.status, 'the refusal must reach the error arm').toBe('error');
    expect(empty.status, 'the empty response must reach the success arm').toBe('success');
    expect
      .soft(
        refused.status,
        forRequirement('F-001-RQ-002', 'a refusal and an empty result must not share a discriminant'),
      )
      .not.toBe(empty.status);
    expect.soft('isEmpty' in refused, 'a refusal has no emptiness to report').toBe(false);
    expect.soft('isEmpty' in empty, 'an empty success reports its emptiness explicitly').toBe(true);
    expect.soft(reportedPassVerdicts(refused), 'a refusal reports no verdict').toEqual([]);
    expect.soft(reportedPassVerdicts(empty), 'an empty success reports no verdict either').toEqual([]);
  });

  // INVARIANT LOCKED: a 403 with no body is still a 403. Failing to read an absent body must not
  // mask the status, because the status is the finding and the body is only diagnostic detail.
  it('reports the refusal even when no Status body accompanies it', async () => {
    respondWithRawJson('', FORBIDDEN_STATUS);

    const result = await settledError();

    expect
      .soft(result.error.httpStatus, forRequirement('F-001-RQ-002', 'a bodyless 403 is still a 403'))
      .toBe(FORBIDDEN_STATUS);
    expect.soft(result.error.kind, 'a bodyless refusal is still an http failure').toBe('http');
    expect
      .soft(result.error.message, 'a fallback sentence names the failure rather than being blank')
      .not.toBe('');
    expect.soft(reportedPassVerdicts(result), 'a bodyless 403 reports no verdict').toEqual([]);
  });

  // INVARIANT LOCKED: a 404 is a refusal too, and specifically NOT a pass. Recorded separately
  // from the 403 because the distinction is nameable and the temptation to treat "the control
  // was not found" as "the control has nothing against it" is exactly the false-pass shape.
  it('reports a 404 as an error and not as an absent-and-therefore-clean control', async () => {
    respondWithKubernetesStatus({
      code: NOT_FOUND_STATUS,
      reason: 'NotFound',
      message: 'controls.posture.k8s.io "V3" not found',
    });

    const result = await settledError();

    expect
      .soft(result.error.httpStatus, forRequirement('F-003-RQ-002', 'a 404 preserves its status'))
      .toBe(NOT_FOUND_STATUS);
    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-003-RQ-002', 'a control that could not be found is not a control that passed'),
      )
      .toEqual([]);
  });
});

// ===========================================================================
// CATEGORY 3 of 4 (AAP §0.5.1) -- 500 INTERNAL SERVER ERROR.
//
// The same assertions as the 403, for the opposite reason: a 403 means the caller may not know,
// a 500 means nobody knows. Neither is evidence that a control holds. This group also covers the
// 2xx-with-unusable-body case, because a body the client cannot parse is the third distinct way
// to have no verdict and it too must never degrade into a pass.
// ===========================================================================

describe('category 3 of 4 — a 500 Internal Server Error can never be reported as a passing control', () => {
  /** The recorded 500 as it appears on the wire. See the 403's counterpart above. */
  const SERVER_ERROR_WIRE: KubernetesStatusWire = {
    code: INTERNAL_SERVER_ERROR_STATUS,
    reason: SERVER_ERROR_CONTROL_STATUS_ERROR.reason,
    message: SERVER_ERROR_CONTROL_STATUS_ERROR.message,
  };

  // INVARIANT LOCKED: a server-side failure resolves to an error state carrying no verdict, with
  // the status preserved so a reader can tell a broken server from a denied caller.
  it('resolves a failed collection to an error carrying no verdict', async () => {
    respondWithKubernetesStatus(SERVER_ERROR_WIRE);

    const result = await settledError();

    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-006-RQ-002', 'a failed evaluation must never be reported as a passing control'),
      )
      .toEqual([]);
    expect.soft(result.error.kind, 'a 5xx response is a transport-level http failure').toBe('http');
    expect
      .soft(
        result.error.httpStatus,
        forRequirement('F-006-RQ-002', 'the 500 status is preserved verbatim'),
      )
      .toBe(INTERNAL_SERVER_ERROR_STATUS);
    expect
      .soft(result.error.reason, 'the Status reason distinguishes a server fault from a denial')
      .toBe(SERVER_ERROR_CONTROL_STATUS_ERROR.reason);
    expect
      .soft(result.error.message, "the panel shows the server's own explanation")
      .toBe(SERVER_ERROR_CONTROL_STATUS_ERROR.message);
    expect.soft('controls' in result, 'the error arm exposes no controls member').toBe(false);
    expect.soft('isEmpty' in result, 'the error arm exposes no isEmpty member').toBe(false);
  });

  // INVARIANT LOCKED: the per-control endpoint fails the same way as the collection.
  it.each([...CONTROL_IDS])('resolves a failed %s endpoint to an error carrying no verdict', async (controlId) => {
    respondWithKubernetesStatus(SERVER_ERROR_WIRE, controlStatusPath(controlId));

    const result = await settledError(controlId);

    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-006-RQ-002', `a failed ${controlId} evaluation must not report ${controlId} as passing`),
      )
      .toEqual([]);
    expect.soft(result.error.httpStatus, `${controlId} preserves the 500`).toBe(
      INTERNAL_SERVER_ERROR_STATUS,
    );
    expect.soft(result.error.kind, `${controlId} failure is an http failure`).toBe('http');
  });

  // INVARIANT LOCKED: a 500 is distinguishable from an empty result, exactly as a 403 is. Checked
  // for the 500 as well rather than assumed to follow, because "the same reasoning applies" is
  // how a second failure path quietly acquires a different one.
  it('is distinguishable from the explicit empty state, which is a success', async () => {
    respondWithKubernetesStatus(SERVER_ERROR_WIRE);
    const failed = await settled();

    respondWithControlList(NO_CONTROL_STATUSES);
    const empty = await settled();

    expect(failed.status, 'the failure must reach the error arm').toBe('error');
    expect(empty.status, 'the empty response must reach the success arm').toBe('success');
    expect
      .soft(
        failed.status,
        forRequirement('F-006-RQ-002', 'a failure and an empty result must not share a discriminant'),
      )
      .not.toBe(empty.status);
    expect.soft('isEmpty' in failed, 'a failure has no emptiness to report').toBe(false);
    expect.soft('isEmpty' in empty, 'an empty success reports its emptiness explicitly').toBe(true);
    expect.soft(reportedPassVerdicts(failed), 'a failure reports no verdict').toEqual([]);
  });

  // INVARIANT LOCKED: a 5xx whose body cannot be read is still reported by its status. Every
  // shape a gateway or proxy substitutes for the expected document is covered, because the point
  // is that NONE of them may mask the status.
  it.each([
    ['a bodyless response', ''],
    ['a JSON list', '[1,2,3]'],
    ['a JSON string', '"just a string"'],
    ['a JSON number', '42'],
    ['an HTML gateway page', '<html>gateway error</html>'],
  ])('reports the failure when the body is %s', async (_name, body) => {
    respondWithRawJson(body, INTERNAL_SERVER_ERROR_STATUS);

    const result = await settledError();

    expect
      .soft(
        result.error.httpStatus,
        forRequirement('F-006-RQ-002', 'an unreadable error body must not mask the status'),
      )
      .toBe(INTERNAL_SERVER_ERROR_STATUS);
    expect.soft(result.error.kind, 'an unreadable error body is still an http failure').toBe('http');
    expect.soft(result.error.message, 'the message is never blank').not.toBe('');
    expect
      .soft(result.error.reason, 'no reason is invented from a body that carried none')
      .toBeUndefined();
    expect.soft(reportedPassVerdicts(result), 'an unreadable failure reports no verdict').toEqual([]);
  });

  // INVARIANT LOCKED: a 200 whose body is not JSON is an ERROR, never a silent pass and never an
  // empty result. The hook parses JSON, so a parse failure is a contract failure -- and it is
  // reported as `payload` rather than `network` so a reader knows to look at the server's
  // serialiser rather than at the wire.
  it.each([
    ['truncated JSON', '{"controlId": "V1"'],
    ['an empty body under 200', ''],
    ['HTML served as JSON', '<html><body>not json</body></html>'],
    ['a trailing comma', '[{"controlId":"V1"},]'],
  ])('treats %s under 200 as a payload error, never as a pass', async (_name, body) => {
    respondWithRawJson(body);

    const result = await settledError();

    expect
      .soft(
        result.error.kind,
        forRequirement('F-006-RQ-002', 'an unparseable 2xx body is a payload error, not a transport one'),
      )
      .toBe('payload');
    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-006-RQ-002', 'a body this client cannot parse must never render as a pass'),
      )
      .toEqual([]);
    expect.soft('isEmpty' in result, 'a parse failure is not the empty state').toBe(false);
  });

  // INVARIANT LOCKED: a request that produced no response at all is a NETWORK error, kept
  // distinct from an http one. `httpStatus` is absent rather than zero, because no response
  // existed and a zero would be a fabricated measurement.
  it('reports a request that never got a response as a network error with no status', async () => {
    server.use(http.get(CONTROL_STATUS_BASE_PATH, () => HttpResponse.error()));

    const result = await settledError();

    expect.soft(result.error.kind, 'no response at all is a network failure').toBe('network');
    expect
      .soft(result.error.httpStatus, 'no response means no status, and none is invented')
      .toBeUndefined();
    expect.soft(result.error.message, 'the failure is described rather than left blank').not.toBe('');
    expect.soft(reportedPassVerdicts(result), 'a network failure reports no verdict').toEqual([]);
  });
});


// ===========================================================================
// CATEGORY 4 of 4 (AAP §0.5.1) -- ABORT.
//
// The in-flight request is aborted when the consumer unmounts, when its input changes and when
// it is refreshed; an abort is not surfaced as an error; and no stale result is left behind.
// ===========================================================================

describe('category 4 of 4 — an abort is not a failure', () => {
  /**
   * The `AbortSignal` the hook handed to `fetch`, one per request, in order.
   *
   * HOW THE ABORT IS DETECTED, AND WHY NOT THE OBVIOUS WAY. AAP §0.5.1 requires the abort to be
   * detected through the `AbortError` semantics the hook implements rather than by matching a
   * message string, which rules out reading `error.message`. The apparently natural alternative
   * -- observing `request.signal` inside the MSW handler -- was MEASURED and does not work: with
   * the Node request-interception server under the pinned msw 2.15.0, a client abort never reaches a handler that is
   * awaiting, so a test waiting on that event waits until the 10 s `testTimeout` and fails
   * having proven nothing. Recording the signal the hook passes to `fetch` works because it is
   * the very object the hook aborts: after `unmount()` its `aborted` flag is true SYNCHRONOUSLY,
   * and its `reason` is the platform `DOMException` named `AbortError` -- which is exactly the
   * condition `isAbortError` in the hook keys on.
   */
  let observedSignals: AbortSignal[] = [];

  /** Everything the code under test wrote to `console.error` during the case. */
  let observedConsoleErrors: string[] = [];

  /**
   * Optional per-case notification, invoked once the platform response has RESOLVED but before
   * the hook's own continuation runs.
   *
   * Only the last case in this group sets it, and only that case needs it: reaching the hook's
   * `commit` guard requires the abort to land after `fetch` has resolved rather than before, and
   * nothing observable from outside the hook says when that moment has passed. Ordering here is
   * specified rather than timed -- the notification is delivered from inside the recorder, so a
   * test awaiting it is queued ahead of the hook's continuation on the same promise -- which is
   * what makes that case deterministic instead of a race. Left `undefined` for every other case,
   * so none of them pays for it.
   */
  let announceResponseResolved: (() => void) | undefined;

  /**
   * The two spies this group installs. Held so they can be put back: `clearMocks` in
   * `web/vitest.config.ts` empties recorded calls between tests but deliberately does NOT
   * restore implementations, and `../setupTests` documents -- and relies on -- this file
   * restoring its own. Leaving the `fetch` spy installed was measured to break the NEXT case,
   * because the following spy then wraps the previous one instead of the real implementation.
   */
  let fetchSpy: MockInstance<typeof globalThis.fetch> | undefined;
  let consoleErrorSpy: MockInstance<typeof console.error> | undefined;

  beforeEach(() => {
    observedSignals = [];
    observedConsoleErrors = [];
    announceResponseResolved = undefined;

    const realFetch = globalThis.fetch;
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        // Recorded and then passed straight through, so MSW still serves the request and this
        // spy observes rather than substitutes. A spy that answered requests itself would be
        // testing the spy.
        if (init?.signal) {
          observedSignals.push(init.signal);
        }
        const response = await realFetch(input, init);
        announceResponseResolved?.();
        return response;
      });

    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: readonly unknown[]) => {
        observedConsoleErrors.push(args.map((arg) => String(arg)).join(' '));
      });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = undefined;
  });

  /**
   * Asserts that a recorded signal was aborted with the platform's `AbortError`.
   *
   * @param signal - the signal the hook handed to `fetch`.
   * @param what - what was aborted, for the failure message.
   */
  function expectAbortedWithAbortError(signal: AbortSignal | undefined, what: string): void {
    expect(signal, `${what}: a request must have been issued to be aborted`).toBeDefined();
    expect.soft(signal?.aborted, `${what}: the in-flight request must be aborted`).toBe(true);
    // By NAME, never by message text -- see `abortReasonName`.
    expect
      .soft(
        abortReasonName(signal?.reason),
        `${what}: the abort reason must be the platform AbortError`,
      )
      .toBe('AbortError');
  }

  // INVARIANT LOCKED: unmounting aborts the in-flight request, and the response that arrives
  // afterwards changes nothing. If an abort were reported as a failure, a panel that unmounts
  // during navigation would flash an error the user cannot act on -- and, worse, a spec asserting
  // "shows an error on failure" would pass for that reason.
  it('aborts the in-flight request when the consumer unmounts, and paints nothing after', async () => {
    const recorded = controlStatusListFixture();
    const gate = gateResponse(CONTROL_STATUS_BASE_PATH, () => HttpResponse.json({ items: recorded }));

    const { result, unmount } = renderHook(() => useControlStatus());

    expect(result.current.status, 'the request must still be in flight before unmounting').toBe(
      'loading',
    );
    expect(observedSignals, 'exactly one request must have been issued').toHaveLength(1);
    expect(observedSignals[0]?.aborted, 'the request must not be aborted before unmounting').toBe(
      false,
    );

    unmount();

    expectAbortedWithAbortError(observedSignals[0], 'unmount');

    // Now let the response through. This is what separates "aborted" from "merely not delivered
    // yet": the payload really does arrive, and it must still change nothing.
    gate.release();
    await gate.served;
    await flushPendingWork();

    expect
      .soft(result.current.status, 'an abort is not an error, so no error state is painted')
      .toBe('loading');
    expect
      .soft(reportedPassVerdicts(result.current), 'an aborted request leaves no stale verdict behind')
      .toEqual([]);
    expect
      .soft(
        observedConsoleErrors,
        `no update may land on an unmounted consumer; console.error recorded: ${observedConsoleErrors.join(' | ')}`,
      )
      .toEqual([]);
  });

  // INVARIANT LOCKED: changing the input aborts the request for the OLD input and the result
  // lands on the new one. Without the abort, whichever response arrived last would win, so a
  // slow answer about V1 could overwrite a fast answer about V2 and the panel would silently
  // report the wrong control's posture.
  it("aborts the stale request when its input changes, and lands on the new input's payload", async () => {
    const staleGate = gateResponse(controlStatusPath('V1'), () =>
      HttpResponse.json(controlStatusFixture('V1')),
    );
    respondWithControl(controlStatusFixture('V2'));

    // The generic arguments are given explicitly rather than letting the props be inferred from
    // `initialProps`: inference would fix them at the literal type `'V1'`, and the `rerender`
    // below -- the whole point of this case -- would then not typecheck. Stating them is also
    // preferable to widening the literal with an assertion, which would put a cast in the one
    // spec whose subject is that the hook follows its input.
    const { result, rerender } = renderHook<UseControlStatusResult, { id: ControlId }>(
      ({ id }) => useControlStatus(id),
      { initialProps: { id: 'V1' } },
    );

    expect(result.current.status, 'the V1 request must still be in flight').toBe('loading');
    expect(observedSignals, 'the V1 request must have been issued').toHaveLength(1);

    rerender({ id: 'V2' });

    expectAbortedWithAbortError(observedSignals[0], 'input change');
    expect
      .soft(observedSignals, 'changing the input issues a second request rather than reusing the first')
      .toHaveLength(2);
    expect.soft(observedSignals[1]?.aborted, 'the new request must not be aborted').toBe(false);

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    if (result.current.status !== 'success') {
      throw new Error(`expected the success arm for V2, got ${result.current.status}`);
    }
    expect
      .soft(
        result.current.controls.map((control) => control.controlId),
        'the result describes the control currently asked about, not the previous one',
      )
      .toEqual(['V2']);

    // Release the abandoned V1 response and prove it cannot overwrite the V2 result.
    staleGate.release();
    await staleGate.served;
    await flushPendingWork();

    // Re-read into a fresh binding rather than narrowing `result.current` twice: the first
    // narrowing above is still in force, so a second check against it would be comparing a type
    // the compiler has already reduced to `never`.
    const afterStaleResponse = result.current;
    if (afterStaleResponse.status !== 'success') {
      throw new Error(`expected V2 to survive the stale response, got ${afterStaleResponse.status}`);
    }
    expect
      .soft(
        afterStaleResponse.controls.map((control) => control.controlId),
        'a late response for the abandoned input must not overwrite the current one',
      )
      .toEqual(['V2']);
    expect
      .soft(observedConsoleErrors, `console.error recorded: ${observedConsoleErrors.join(' | ')}`)
      .toEqual([]);
  });

  // INVARIANT LOCKED: refreshing aborts the request already in flight rather than racing it. Two
  // live requests for the same endpoint would let the older one commit last, which is how a
  // refresh ends up displaying the state it was invoked to replace.
  it('aborts the request already in flight when refresh is called', async () => {
    const gate = gateResponse(CONTROL_STATUS_BASE_PATH, () =>
      HttpResponse.json({ items: controlStatusListFixture() }),
    );

    const { result } = renderHook(() => useControlStatus());

    expect(result.current.status, 'the first request must still be in flight').toBe('loading');
    expect(observedSignals, 'the first request must have been issued').toHaveLength(1);

    await act(async () => {
      result.current.refresh();
    });

    expectAbortedWithAbortError(observedSignals[0], 'refresh');
    expect.soft(observedSignals, 'refresh issues a fresh request').toHaveLength(2);
    expect.soft(observedSignals[1]?.aborted, 'the refreshed request must not be aborted').toBe(false);
    expect
      .soft(result.current.status, 'aborting the previous attempt is not an error')
      .toBe('loading');

    gate.release();
    await gate.served;
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect
      .soft(gate.requestCount(), 'exactly two requests were issued: the aborted one and the refresh')
      .toBe(2);
    expect
      .soft(observedConsoleErrors, `console.error recorded: ${observedConsoleErrors.join(' | ')}`)
      .toEqual([]);
  });

  // INVARIANT LOCKED: an abort during a REFUSED request is still not an error. The abort guard
  // must sit outside the non-2xx branch, or a panel unmounting while a 403 is in flight would
  // paint the refusal it was navigating away from.
  it('does not paint a refusal that was aborted before it arrived', async () => {
    const gate = gateResponse(CONTROL_STATUS_BASE_PATH, () =>
      HttpResponse.json(
        {
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          code: FORBIDDEN_STATUS,
          reason: FORBIDDEN_CONTROL_STATUS_ERROR.reason,
          message: FORBIDDEN_CONTROL_STATUS_ERROR.message,
        },
        { status: FORBIDDEN_STATUS },
      ),
    );

    const { result, unmount } = renderHook(() => useControlStatus());
    expect(result.current.status, 'the refused request must still be in flight').toBe('loading');

    unmount();
    expectAbortedWithAbortError(observedSignals[0], 'unmount during a refusal');

    gate.release();
    await gate.served;
    await flushPendingWork();

    expect
      .soft(
        result.current.status,
        forRequirement('F-001-RQ-002', 'an aborted refusal is neither reported nor rendered'),
      )
      .toBe('loading');
    expect
      .soft(observedConsoleErrors, `console.error recorded: ${observedConsoleErrors.join(' | ')}`)
      .toEqual([]);
  });

  // INVARIANT LOCKED: A REFUSAL THAT WAS FULLY RECEIVED AND FULLY READ IS STILL NOT WRITTEN TO A
  // CONSUMER THAT HAS GONE. This is the hook's LAST line of defence, and it is the only abort case
  // that reaches it.
  //
  // WHY THE OTHER FOUR CASES DO NOT REACH IT, which is the reason this one is worth its length.
  // Each of them aborts before the response resolves, so `await fetch(...)` rejects and the hook
  // returns from its outer abort guard having prepared nothing. Here the sequence is the opposite
  // and much narrower: the response ARRIVES with a 403, the consumer unmounts, and only then does
  // the hook read the `Status` body for the panel to display. That read succeeds -- reading an
  // already-buffered body does not care that the request was abandoned -- so the hook arrives at
  // the moment of writing an error with nothing having thrown. The guard inside `commit` is the
  // only thing between that and an error painted on an unmounted consumer, and MEASURED coverage
  // confirms this case is what executes it: the body read completes, the guard fires, and
  // `setSnapshot` is never called.
  //
  // DETERMINISTIC BY ORDERING, NOT BY TIMING. Two mechanisms cooperate, and neither is a race.
  // The response body is a stream this test holds open, so the response cannot complete early;
  // and `announceResponseResolved` fires from inside the recorder the moment the platform
  // response resolves, which queues this test's continuation ahead of the hook's continuation on
  // the same promise. The unmount therefore lands after the response and before the body read,
  // every time, on any machine.
  it('commits nothing when a fully received refusal is read after the consumer has gone', async () => {
    const responseResolved = new Promise<void>((resolve) => {
      announceResponseResolved = resolve;
    });
    let allowBodyToFinish = (): void => {};
    const bodyMayFinish = new Promise<void>((resolve) => {
      allowBodyToFinish = resolve;
    });

    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, () => {
        const encoder = new TextEncoder();
        const heldOpenBody = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Split mid-key on purpose: the bytes emitted so far are not a parseable document, so
            // the body demonstrably cannot have been read before the unmount below.
            controller.enqueue(encoder.encode('{"kind":"Status","apiVersion":"v1","reas'));
            await bodyMayFinish;
            controller.enqueue(encoder.encode(`on":"${FORBIDDEN_CONTROL_STATUS_ERROR.reason}"}`));
            controller.close();
          },
        });
        return new HttpResponse(heldOpenBody, {
          status: FORBIDDEN_STATUS,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const { result, unmount } = renderHook(() => useControlStatus());
    await responseResolved;

    expect(result.current.status, 'the refusal has arrived but nothing is rendered from it yet').toBe(
      'loading',
    );

    unmount();
    expectAbortedWithAbortError(observedSignals[0], 'unmount after the refusal resolved');

    // Let the body complete. The hook now reads it successfully and reaches the point of writing
    // an error -- which is exactly what must not happen.
    allowBodyToFinish();
    await flushPendingWork();

    expect
      .soft(
        result.current.status,
        forRequirement('F-001-RQ-002', 'a refusal read after unmount is never written to a gone consumer'),
      )
      .toBe('loading');
    expect
      .soft(reportedPassVerdicts(result.current), 'and no verdict is left behind either')
      .toEqual([]);
    expect
      .soft(observedConsoleErrors, `console.error recorded: ${observedConsoleErrors.join(' | ')}`)
      .toEqual([]);
  });
});


// ===========================================================================
// SUPPORTING SURFACE.
//
// The four mandated categories above are the AAP §0.5.1 row. The groups below are the rest of
// the hook's contract, and they are here for one reason: every one of them is a way for a
// verdict to be wrong that the four categories do not reach on their own.
// ===========================================================================

describe('every non-2xx status resolves to an error, whatever the code', () => {
  // INVARIANT LOCKED: the two headline codes are not special-cased. Categories 2 and 3 above go
  // deep on 403 and 500 because those are the codes the oracle and the AAP name, and this group
  // goes WIDE so that depth cannot be mistaken for a whitelist: an authentication failure, a bad
  // gateway and an unavailable upstream must each reach the error arm carrying their own status
  // and no verdict, exactly as a 403 does.
  //
  // The statuses recorded in `../test/fixtures/controlStatus` are used where they exist. The rest
  // are written as literals deliberately: 401, 502 and 503 are generic HTTP conditions rather
  // than measured properties of this system, so inventing fixture constants for them would imply
  // a recorded provenance they do not have.
  it.each([
    ['unauthorized', 401],
    ['forbidden', FORBIDDEN_STATUS],
    ['not found', NOT_FOUND_STATUS],
    ['internal server error', INTERNAL_SERVER_ERROR_STATUS],
    ['bad gateway', 502],
    ['service unavailable', 503],
  ])('reports HTTP %s (%i) as an error carrying the status', async (_name, status) => {
    respondWithKubernetesStatus({
      code: status,
      reason: 'Failure',
      message: `the control posture endpoint answered ${String(status)}`,
    });

    const result = await settledError();

    expect
      .soft(
        result.error.httpStatus,
        forRequirement('F-001-RQ-002', `HTTP ${String(status)} is preserved verbatim`),
      )
      .toBe(status);
    expect.soft(result.error.kind, `HTTP ${String(status)} is an http failure`).toBe('http');
    expect
      .soft(
        reportedPassVerdicts(result),
        forRequirement('F-001-RQ-002', `HTTP ${String(status)} must never be reported as a passing control`),
      )
      .toEqual([]);
    // No arm of the union offers `controls` or `isEmpty` here, so a panel cannot reach a verdict
    // from any refusal even by accident.
    expect.soft('controls' in result, `HTTP ${String(status)} exposes no controls`).toBe(false);
    expect.soft('isEmpty' in result, `HTTP ${String(status)} exposes no isEmpty`).toBe(false);
  });
});

describe('the three accepted envelope shapes', () => {
  // INVARIANT LOCKED: a bare list is read as the list it is. Accepted because it is one of the
  // three shapes the contract declares, not because anything list-like should be tolerated.
  it('reads a bare list of controls', async () => {
    const recorded = [controlStatusFixture('V1'), controlStatusFixture('V3')];
    respondWithBareList(recorded);

    const result = await settledSuccess();

    expect.soft(result.controls, 'a bare list survives verbatim').toEqual(recorded);
    expect
      .soft(result.controls.map((control) => control.controlId), 'in the order sent')
      .toEqual(['V1', 'V3']);
    expect.soft(result.isEmpty, 'a populated list is not empty').toBe(false);
  });

  // INVARIANT LOCKED: the Kubernetes-style envelope is read through `items`, which is the shape
  // the recorded collection handler and a real API server both use.
  it('reads a Kubernetes-style list under `items`', async () => {
    const recorded = [controlStatusFixture('V4')];
    respondWithControlList(recorded);

    const result = await settledSuccess();

    expect.soft(result.controls, 'the items list survives verbatim').toEqual(recorded);
  });

  // INVARIANT LOCKED: a single control object is read as a one-entry list, so a panel and the
  // dashboard read the payload the same way instead of each having its own shape to handle.
  it('reads a single control object, which is what the per-control endpoint returns', async () => {
    respondWithControl(controlStatusFixture('V6'));

    const result = await settledSuccess('V6');

    expect
      .soft(selectControlStatus(result.controls, 'V6')?.verdict, 'the single object is understood')
      .toBe('pass');
    expect.soft(result.controls, 'and is presented as a one-entry list').toHaveLength(1);
  });

  // INVARIANT LOCKED: a body that declares `items` and does not carry a list is a contract
  // mismatch, not an alternative spelling. Reinterpreting it as a single control would invent an
  // entry the server never sent.
  it('refuses an `items` member that is not a list, rather than reading the body as one control', async () => {
    respondWithRawJson(JSON.stringify({ items: { controlId: 'V1' } }));

    expect(await refusedMessage()).toMatch(/neither a control-status object/i);
  });

  // INVARIANT LOCKED: a scalar body describes no control at all and is refused rather than
  // coerced into one.
  it.each([
    ['a bare string', '"not a payload"'],
    ['a number', '42'],
    ['a boolean', 'true'],
    ['null', 'null'],
  ])('refuses %s as a body', async (_name, text) => {
    respondWithRawJson(text);

    expect(await refusedMessage()).toMatch(/neither a control-status object/i);
  });
});

describe('the empty and no-content states', () => {
  // INVARIANT LOCKED: an empty list is the explicit EMPTY state -- a success carrying nothing --
  // and `isEmpty` says so directly so no call site has to infer it from a length comparison.
  it('reports an empty list as the explicit empty state, not as a failure', async () => {
    respondWithControlList(NO_CONTROL_STATUSES);

    const result = await settledSuccess();

    expect.soft(result.controls, 'nothing was reported').toEqual([]);
    expect.soft(result.isEmpty, 'and the emptiness is stated rather than inferred').toBe(true);
    expect.soft(reportedPassVerdicts(result), 'an empty result is not a passing one').toEqual([]);
  });

  // INVARIANT LOCKED: 204 No Content is the contract for "nothing to report" and resolves to the
  // empty state rather than to a parse failure.
  it('treats 204 No Content as the empty state', async () => {
    server.use(http.get(CONTROL_STATUS_BASE_PATH, () => new HttpResponse(null, { status: 204 })));

    const result = await settledSuccess();

    expect.soft(result.isEmpty, '204 is the bodyless success contract').toBe(true);
    expect.soft(result.controls, 'and carries no controls').toEqual([]);
  });

  // INVARIANT LOCKED: the asymmetry with 204 is deliberate and load-bearing. 204 is a server
  // saying "nothing to report"; an empty body under 200 is a server that answered with nothing.
  // Rendering the second as "no controls" would assert a clean bill of health on no evidence.
  it('treats an empty body under 200 as a payload error, not as no controls', async () => {
    respondWithRawJson('');

    expect(await refusedMessage()).toMatch(/not valid JSON/i);
  });
});

describe('malformed members are refused, never skipped', () => {
  // WHY THIS WHOLE GROUP EXISTS. The parser refuses a payload rather than dropping the part it
  // cannot read, and the reason is the finding this hook was corrected for: a dropped member is
  // indistinguishable from a member the server never sent, so silently discarding one turns "the
  // check reported something the client could not parse" into "the check reported nothing" --
  // and a control with nothing reported against it must not read as clean.

  // INVARIANT LOCKED: an unrecognised control identifier aborts the whole read. A dashboard
  // showing seven controls looks exactly like one showing all eight when the eighth was dropped.
  it('refuses an unknown control identifier rather than dropping the entry', async () => {
    respondWithWireEntries([wireEntry('V1'), wireEntry('V2', { controlId: 'V9' })]);

    expect(await refusedMessage()).toMatch(/does not identify one of the 8 known controls/i);
  });

  // INVARIANT LOCKED: an entry that is not an object at all identifies no control, so it aborts
  // the read for the same reason an unknown identifier does. Checked separately because a list of
  // scalars is a different wire mistake from a list of objects naming the wrong control, and only
  // one of the two would be caught by a check that assumed entries were objects.
  it.each([
    ['a string', 'V1'],
    ['a number', 1],
    ['null', null],
    ['a boolean', true],
    ['a nested list', ['V1']],
  ])('refuses a list entry that is %s', async (_name, entry) => {
    respondWithRawJson(JSON.stringify([entry]));

    expect(await refusedMessage()).toMatch(/does not identify one of the 8 known controls/i);
  });

  // INVARIANT LOCKED, AND IT IS THE OTHER SIDE OF THIS WHOLE GROUP: an ABSENT optional member is
  // absent, not an error. A control with nothing to report legitimately omits `findings` and
  // `warnings`, and both become empty lists so a panel can read `.length` without a guard. Only a
  // member that IS present and cannot be read fails the payload -- without this case, "refuse
  // everything unreadable" would be indistinguishable from "refuse everything".
  it('accepts a payload that omits findings and warnings entirely', async () => {
    respondWithRawJson(
      JSON.stringify([{ controlId: 'V7', verdict: 'pass', summary: 'nothing to report' }]),
    );

    const result = await settledSuccess();
    const control = selectControlStatus(result.controls, 'V7');

    expect(control, 'the payload is accepted').toBeDefined();
    expect.soft(control?.findings, 'an omitted findings member reads as an empty list').toEqual([]);
    expect.soft(control?.warnings, 'an omitted warnings member reads as an empty list').toEqual([]);
    expect.soft(control?.verdict, 'and the verdict is still read').toBe('pass');
    expect
      .soft(control?.evidence, 'an omitted evidence bag is absent rather than empty-but-present')
      .toBeUndefined();
  });

  // INVARIANT LOCKED: THE MOTIVATING DEFECT. Filtering an unreadable member out of `audiences`
  // produced `['api']`, which SATISFIES the V4 assertion that the audience is exactly `["api"]`
  // (`svcaccttoken_test.go` L1489) -- so a token bound to two audiences, one of them unreadable,
  // was reported as correctly single-audience. The list is therefore accepted whole or not at all.
  it.each([
    ['a non-string member', { audiences: ['api', 42] }],
    ['a null member', { audiences: ['api', null] }],
    ['an object member', { audiences: [{ name: 'api' }] }],
    ['a scalar instead of a list', { audiences: 'api' }],
  ])('refuses `audiences` carrying %s', async (_name, evidence) => {
    respondWithWireEntries([wireEntry('V4', { evidence })]);

    const message = await refusedMessage();
    expect
      .soft(
        message,
        forRequirement('F-004-RQ-001', 'an unreadable audience list must be named, not silently shortened'),
      )
      .toMatch(/audiences/);
    expect
      .soft(message, 'and the refusal must say why the member was not dropped')
      .toMatch(/rejected rather than the member being dropped|list of strings/i);
  });

  // INVARIANT LOCKED: a well-formed audience list is kept exactly as sent, including order and
  // duplicates, because both the contents and the cardinality are what V4 asserts on.
  it('keeps a well-formed audience list verbatim, including order and duplicates', async () => {
    respondWithWireEntries([wireEntry('V4', { evidence: { audiences: ['api', 'api', 'other'] } })]);

    const result = await settledSuccess();

    expect
      .soft(
        selectControlStatus(result.controls, 'V4')?.evidence?.audiences,
        forRequirement('F-004-RQ-001', 'the audience list is neither sorted nor de-duplicated'),
      )
      .toEqual(['api', 'api', 'other']);
  });

  // INVARIANT LOCKED: `audiences: []` is a token bound to NO audience -- a reportable finding the
  // server genuinely described -- and must not be conflated with `audiences: [42]`, which is a
  // payload this client cannot interpret. Collapsing the second into the first would report a
  // defect the server never described.
  it('distinguishes an EMPTY audience list from an unreadable one', async () => {
    respondWithWireEntries([wireEntry('V4', { evidence: { audiences: [] } })]);

    const result = await settledSuccess();

    expect
      .soft(
        selectControlStatus(result.controls, 'V4')?.evidence?.audiences,
        forRequirement('F-004-RQ-001', 'an empty audience list is reported, not treated as unreadable'),
      )
      .toEqual([]);
  });

  // INVARIANT LOCKED: a finding is a reported DEFECT -- the evidence that stops a control
  // rendering as a pass -- so an unreadable one fails the whole read. A control whose only
  // finding was unreadable used to render as clean.
  it.each([
    ['a number', 7],
    ['null', null],
    ['a boolean', false],
    ['a list', ['nested']],
  ])('refuses a finding that is %s', async (_name, finding) => {
    respondWithWireEntries([wireEntry('V1', { verdict: 'fail', findings: [finding] })]);

    expect(await refusedMessage()).toMatch(/findings\[0\]/);
  });

  // INVARIANT LOCKED: both recorded finding shapes are still read. A bare string is the message;
  // an object may additionally name the offending subject and the requirement it violates.
  it('accepts findings as bare strings and as objects, in one list', async () => {
    respondWithWireEntries([
      wireEntry('V1', {
        verdict: 'fail',
        findings: ['bare message', { message: 'structured', requirementId: 'F-001-RQ-001' }],
      }),
    ]);

    const result = await settledSuccess();
    const control = selectControlStatus(result.controls, 'V1');

    expect
      .soft(control?.findings.map((finding) => finding.message), 'both findings survive, in order')
      .toEqual(['bare message', 'structured']);
    expect
      .soft(
        control?.findings[1]?.requirementId,
        forRequirement('F-001-RQ-001', 'a finding keeps the requirement it attributes itself to'),
      )
      .toBe('F-001-RQ-001');
  });

  // INVARIANT LOCKED: the V2 control turns on a warning being PRESENT. Under warn=restricted the
  // pod is admitted either way (`podsecurity_test.go` L446-448), so only the warning
  // distinguishes a working Pod Security configuration from an absent one. A dropped warning
  // inverts that verdict, so an unreadable one is refused.
  it.each([
    ['an object with no message key', [{ code: 299 }]],
    ['an object with only a detail key', [{ detail: 'no message key' }]],
  ])('refuses a warning shaped as %s', async (_name, warnings) => {
    respondWithWireEntries([wireEntry('V2', { warnings })]);

    const message = await refusedMessage();
    expect
      .soft(
        message,
        forRequirement('F-002-RQ-001', 'an unreadable warning must be named rather than dropped'),
      )
      .toContain('warnings[0]');
    expect.soft(message, 'and the refusal must say what was missing').toContain('message');
  });

  // INVARIANT LOCKED: the offending index is named, so a reader is pointed at the entry rather
  // than at the list.
  it('refuses a warning that is neither a string nor an object, naming its position', async () => {
    respondWithWireEntries([wireEntry('V2', { warnings: ['fine', 42] })]);

    expect(await refusedMessage()).toMatch(/warnings\[1\]/);
  });

  // INVARIANT LOCKED: both recorded warning shapes are still read -- the two-sided control, so
  // the refusals above cannot be satisfied by refusing everything.
  it('accepts a warning as either a bare string or an object with a message', async () => {
    respondWithWireEntries([
      wireEntry('V1', { warnings: ['a bare string', { message: 'an object message' }] }),
    ]);

    const result = await settledSuccess();

    expect
      .soft(result.controls[0]?.warnings, 'both warning shapes are read, in order')
      .toEqual(['a bare string', 'an object message']);
  });

  // INVARIANT LOCKED: an observation is a measurement, so one that cannot be read fails the read
  // rather than vanishing from the table a panel renders.
  it.each([
    ['no label', { value: 1 }],
    ['a non-string label', { label: 7, value: 1 }],
    ['no value member at all', { label: 'measured' }],
    ['an object value', { label: 'measured', value: { nested: true } }],
    ['a list value', { label: 'measured', value: [1] }],
  ])('refuses an observation with %s', async (_name, observation) => {
    respondWithWireEntries([wireEntry('V3', { evidence: { observations: [observation] } })]);

    expect(await refusedMessage()).toMatch(/observations\[0\]/);
  });

  // INVARIANT LOCKED: "reported as null" and "not reported" are different claims, and V4 turns on
  // the difference -- a pod sub-claim reported null is PROOF of an unbound token, while an absent
  // one proves nothing (`svcaccttoken_test.go` L1524-1525). The recorded evidence carries two such
  // nulls, and both must survive as nulls.
  it('preserves observations reported as exactly null', async () => {
    respondWithControl(V4_TOKEN_PASSING);

    const result = await settledSuccess('V4');
    const observations = selectControlStatus(result.controls, 'V4')?.evidence?.observations;

    expect
      .soft(
        observations,
        forRequirement('F-004-RQ-001', 'an explicit null claim value is preserved as null'),
      )
      .toEqual(V4_TOKEN_EVIDENCE.observations);
    expect
      .soft(
        observations?.filter((observation) => observation.value === null).length,
        forRequirement('F-004-RQ-001', 'the pod and secret sub-claims are both reported as null'),
      )
      .toBe(2);
  });

  // INVARIANT LOCKED: a non-finite number is refused rather than coerced. JSON cannot carry
  // Infinity, so it can only arrive through a hand-built body -- and a value that compares
  // absurdly against every bound a panel asserts must not reach one. The body is written out as
  // raw bytes because `JSON.stringify` cannot express it.
  it('refuses a non-finite numeric observation', async () => {
    respondWithRawJson(
      '[{"controlId":"V4","verdict":"pass","summary":"non-finite observation",' +
        '"findings":[],"warnings":[],' +
        '"evidence":{"observations":[{"label":"observed ttl","value":1e999}]}}]',
    );

    expect(await refusedMessage()).toMatch(/observations\[0\]|non-finite/i);
  });

  // INVARIANT LOCKED: a diagnostic names the TYPE it received and never echoes the value. These
  // messages are rendered by the dashboard, so a body that carried a credential-shaped string
  // must not have it quoted back onto the screen. The sentinel below is deliberately, obviously
  // synthetic -- AAP §0.11.1, "no secrets, ever" -- so the test cannot be mistaken for one
  // carrying real key material.
  it('names the type it received without echoing the value', async () => {
    const syntheticSentinel = 'OBVIOUSLY-SYNTHETIC-NOT-A-CREDENTIAL-0000';
    respondWithWireEntries([wireEntry('V1', { findings: syntheticSentinel })]);

    const message = await refusedMessage();

    expect.soft(message, 'the type is named').toContain('string');
    expect.soft(message, 'and the value is not quoted back').not.toContain(syntheticSentinel);
  });
});

describe('declared lists arriving as something else are refused', () => {
  // INVARIANT LOCKED: a member the contract declares as a list, arriving in another shape, is a
  // contract violation rather than an alternative spelling. Wrapping it would fabricate a
  // one-element list the server never sent.
  it.each([
    ['an object', { message: 'not a list' }],
    ['a string', 'not a list'],
    ['a number', 7],
    ['a boolean', true],
  ])('refuses "findings" arriving as %s, naming the type it got', async (_name, findings) => {
    respondWithWireEntries([wireEntry('V1', { findings })]);

    const message = await refusedMessage();
    expect.soft(message, 'the member is named').toContain('findings');
    expect.soft(message, 'and the declared shape is stated').toContain('list');
  });

  it.each([
    ['an object', { message: 'not a list' }],
    ['a string', 'not a list'],
    ['a number', 7],
  ])('refuses "warnings" arriving as %s', async (_name, warnings) => {
    respondWithWireEntries([wireEntry('V1', { warnings })]);

    const message = await refusedMessage();
    expect.soft(message, 'the member is named').toContain('warnings');
    expect.soft(message, 'and the declared shape is stated').toContain('list');
  });

  it.each([
    ['an object', { label: 'not a list' }],
    ['a string', 'not a list'],
    ['a number', 7],
  ])('refuses "observations" arriving as %s', async (_name, observations) => {
    respondWithWireEntries([wireEntry('V1', { evidence: { observations } })]);

    const message = await refusedMessage();
    expect.soft(message, 'the member is named').toContain('observations');
    expect.soft(message, 'and the declared shape is stated').toContain('list');
  });

  it.each([
    ['a string', 'not an object'],
    ['a number', 7],
    ['null', null],
    ['a list', []],
  ])('refuses an observation member arriving as %s', async (_name, member) => {
    respondWithWireEntries([wireEntry('V1', { evidence: { observations: [member] } })]);

    expect(await refusedMessage()).toContain('observations[0]');
  });
});

describe('duplicate control identifiers are a contradiction', () => {
  // INVARIANT LOCKED: two entries for one control tell the reader two things about it, and
  // `selectControlStatus` takes the first -- so which one is believed would depend on the order
  // the server serialised them in. A payload reporting V3 as `fail` and then as `pass` rendered
  // PASS. Refusing is the only answer that neither invents agreement nor picks a winner by list
  // position.
  it('refuses a payload reporting one control twice, naming both positions', async () => {
    respondWithWireEntries([
      wireEntry('V3', { verdict: 'fail' }),
      wireEntry('V1'),
      wireEntry('V3', { verdict: 'pass' }),
    ]);

    const message = await refusedMessage();
    expect
      .soft(
        message,
        forRequirement('F-003-RQ-002', 'a contradictory payload is refused rather than resolved by order'),
      )
      .toMatch(/reports control V3 more than once/i);
    expect.soft(message, 'and both positions are named').toMatch(/entries 0 and 2/);
  });

  // INVARIANT LOCKED: agreement is not the property that matters. A payload that repeats itself
  // is malformed, and accepting the agreeing case would mean the check only fires when a reader
  // could already see the problem.
  it('refuses even when the duplicates agree', async () => {
    respondWithWireEntries([wireEntry('V5'), wireEntry('V5')]);

    expect(await refusedMessage()).toMatch(/more than once/i);
  });

  // INVARIANT LOCKED: the duplicate check does not reject a legitimate full roster. All eight
  // distinct controls in one payload is the dashboard's normal case.
  it('accepts all eight distinct controls', async () => {
    respondWithControlList(ALL_PASSING_CONTROL_STATUSES);

    const result = await settledSuccess();

    expect.soft(result.controls, 'the full roster is accepted').toHaveLength(CONTROL_IDS.length);
    for (const controlId of CONTROL_IDS) {
      expect
        .soft(selectControlStatus(result.controls, controlId), `${controlId} is present`)
        .toBeDefined();
    }
  });
});

describe('verdict reading degrades in the safe direction', () => {
  /**
   * A recorded payload with one member removed entirely.
   *
   * Distinct from overriding it: an ABSENT member and a member present with a wrong value are
   * different wire conditions, and the verdict reader treats them the same way on purpose --
   * which is only demonstrable if both can actually be produced.
   *
   * @param controlId - which recorded payload to start from.
   * @param member - the member to remove.
   * @returns the wire record without that member.
   */
  function wireEntryWithout(controlId: ControlId, member: string): Record<string, unknown> {
    const record = wireEntry(controlId);
    delete record[member];
    return record;
  }

  // INVARIANT LOCKED: an absent, misspelled, differently-cased or non-string verdict reads as
  // `unknown`, NEVER as `pass`. Unlike an unrecognised control identifier, an unrecognised
  // verdict still identifies the control, so `unknown` is a truthful rendering of it -- the
  // asymmetry is deliberate: one is "I cannot say what this is about", the other is "I cannot say
  // what it says". Degrading in the safe direction is what stops wire drift from being rendered
  // as a clean bill of health.
  it.each([
    ['absent', wireEntryWithout('V1', 'verdict')],
    ['misspelled', wireEntry('V1', { verdict: 'passed' })],
    ['differently cased', wireEntry('V1', { verdict: 'PASS' })],
    ['a number', wireEntry('V1', { verdict: 1 })],
    ['a boolean', wireEntry('V1', { verdict: true })],
    ['null', wireEntry('V1', { verdict: null })],
  ])('reads an %s verdict as unknown, never as pass', async (_name, entry) => {
    respondWithWireEntries([entry]);

    const result = await settledSuccess();

    expect
      .soft(
        selectControlStatus(result.controls, 'V1')?.verdict,
        forRequirement('F-001-RQ-002', 'an unreadable verdict is unknown, never pass'),
      )
      .toBe('unknown');
    expect
      .soft(reportedPassVerdicts(result), 'and no control is reported as passing')
      .toEqual([]);
  });

  // INVARIANT LOCKED: an absent summary becomes an explicit sentence, so a panel never renders
  // the text `null` or `undefined` where an explanation belongs.
  it('substitutes an explicit sentence when the summary is absent', async () => {
    respondWithWireEntries([wireEntryWithout('V1', 'summary')]);

    const result = await settledSuccess();

    expect
      .soft(selectControlStatus(result.controls, 'V1')?.summary, 'the substitution is explicit')
      .toMatch(/reported no summary/i);
  });
});

describe('the evidence bag degrades to “not reported” rather than to a false value', () => {
  // INVARIANT LOCKED: a bag that is not an object carries no fields to misread, so it is an
  // ABSENCE -- and it must become `undefined` rather than an empty-but-present bag, because a
  // panel reading an empty bag as "measured nothing" is the false-pass shape.
  it.each([
    ['a string', 'not an object'],
    ['a number', 7],
    ['a list', []],
    ['null', null],
  ])('treats evidence arriving as %s as no evidence at all', async (_name, evidence) => {
    respondWithWireEntries([wireEntry('V1', { evidence })]);

    const result = await settledSuccess();

    expect
      .soft(result.controls[0]?.evidence, 'an unusable bag is absent, not empty-but-present')
      .toBeUndefined();
  });

  // INVARIANT LOCKED: the line between refusing and degrading, drawn deliberately. A bag that IS
  // an object and names `audiences` as a scalar is a contract violation about a specific
  // measurement, and V4's control turns on the audience list being exactly `["api"]` -- so
  // wrapping a scalar would invent the very value under test. That is refused, loudly.
  it('REFUSES a wrong-typed evidence field rather than degrading it to absent', async () => {
    respondWithWireEntries([wireEntry('V1', { evidence: { audiences: 'api' } })]);

    const message = await refusedMessage();
    expect
      .soft(
        message,
        forRequirement('F-004-RQ-001', 'a scalar audience is refused rather than wrapped into a list'),
      )
      .toContain('audiences');
    expect.soft(message, 'and the declared shape is stated').toContain('list');
  });

  // INVARIANT LOCKED: the asymmetry against the case above, which looks like an inconsistency
  // until the reason is stated. A SCALAR arriving at the wrong type has no coercion that could
  // invent a plausible value -- `'3600'` simply is not a number the server reported -- so it
  // becomes "not reported" and a panel reading it withholds its check. A LIST arriving as a
  // scalar is different: wrapping it fabricates a one-element list, and for `audiences` that
  // fabricated list is exactly what V4 asserts on. Absence is safe here; fabrication never is.
  it('degrades a wrong-typed SCALAR field to not-reported, which is the safe answer', async () => {
    respondWithWireEntries([wireEntry('V1', { evidence: { requestedTtlSeconds: '3600' } })]);

    const result = await settledSuccess();

    expect
      .soft(
        result.controls[0]?.evidence?.requestedTtlSeconds,
        forRequirement('F-004-RQ-002', 'a number-shaped string is not parsed into a reported TTL'),
      )
      .toBeUndefined();
  });

  // INVARIANT LOCKED: one unusable field does not discard the measurements reported beside it.
  it('drops an observedExpiry whose every field is unusable, keeping the rest', async () => {
    respondWithWireEntries([
      wireEntry('V1', {
        evidence: {
          observedExpiry: { expirySeconds: 'no', expirationTimestamp: 5, requestTimeSeconds: [] },
          observations: [{ label: 'kept', value: true }],
        },
      }),
    ]);

    const result = await settledSuccess();

    expect
      .soft(result.controls[0]?.evidence?.observedExpiry, 'the wholly unusable expiry is absent')
      .toBeUndefined();
    expect
      .soft(result.controls[0]?.evidence?.observations, 'the usable observation beside it survives')
      .toEqual([{ label: 'kept', value: true }]);
  });

  // INVARIANT LOCKED: an expiry is kept when even one field is usable, because a partially
  // reported window is still evidence and discarding it would withhold a check the server
  // answered.
  it('keeps an observedExpiry when even one field is usable', async () => {
    respondWithWireEntries([
      wireEntry('V1', { evidence: { observedExpiry: { expirySeconds: V4_REQUESTED_TTL_SECONDS } } }),
    ]);

    const result = await settledSuccess();

    expect
      .soft(
        result.controls[0]?.evidence?.observedExpiry?.expirySeconds,
        forRequirement('F-004-RQ-002', 'a partially reported expiry window is still reported'),
      )
      .toBe(V4_REQUESTED_TTL_SECONDS);
  });
});

describe('refresh re-reads the posture', () => {
  // INVARIANT LOCKED: refresh re-issues the request and the NEW body is what lands. Waiting on
  // the call count and then on the body, rather than on the status alone, is deliberate: the hook
  // is already `success` from the first request, so a `waitFor` on the status is satisfied
  // immediately by the previous result and proves nothing about the refresh.
  it('re-issues the request and adopts the new payload', async () => {
    let calls = 0;
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, () => {
        calls += 1;
        return HttpResponse.json({
          items: [calls === 1 ? controlStatusFixture('V1') : controlStatusFixture('V1', 'failing')],
        });
      }),
    );

    const { result } = renderHook(() => useControlStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(calls, 'the first read happened').toBe(1);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    await waitFor(() => {
      const refreshed = result.current;
      expect(refreshed.status).toBe('success');
      if (refreshed.status !== 'success') {
        return;
      }
      expect(selectControlStatus(refreshed.controls, 'V1')?.verdict).toBe('fail');
    });

    expect
      .soft(calls, 'exactly one extra request was issued, not a retry storm')
      .toBe(2);
  });

  // INVARIANT LOCKED: a refresh can recover from an error. Without this the error state would be
  // terminal and the retry affordance would be decorative.
  it('recovers from an error when a refresh succeeds', async () => {
    let attempts = 0;
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(
              {
                kind: 'Status',
                apiVersion: 'v1',
                metadata: {},
                status: 'Failure',
                code: INTERNAL_SERVER_ERROR_STATUS,
                reason: SERVER_ERROR_CONTROL_STATUS_ERROR.reason,
                message: SERVER_ERROR_CONTROL_STATUS_ERROR.message,
              },
              { status: INTERNAL_SERVER_ERROR_STATUS },
            )
          : HttpResponse.json({ items: controlStatusListFixture() });
      }),
    );

    const { result } = renderHook(() => useControlStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect.soft(attempts, 'the recovery came from a second request').toBe(2);
  });

  // INVARIANT LOCKED: `refresh` is stable across renders, so it is safe as an effect dependency
  // or a memoised prop. An unstable handle would re-trigger any effect that depends on it, which
  // is how a refresh control becomes a polling loop.
  it('keeps `refresh` stable across renders so it is safe as an effect dependency', async () => {
    const { result, rerender } = renderHook(() => useControlStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const first = result.current.refresh;

    rerender();

    expect(result.current.refresh, 'the same handle is returned').toBe(first);
  });
});

describe('the exported helpers', () => {
  // INVARIANT LOCKED: both paths are DERIVED from one base, so a URL is never spelled out twice
  // and the handlers, the hook and the specs cannot drift apart.
  it('builds the collection path and the per-control path', () => {
    expect.soft(controlStatusPath(), 'no argument addresses the collection').toBe(
      CONTROL_STATUS_BASE_PATH,
    );
    for (const controlId of CONTROL_IDS) {
      expect
        .soft(controlStatusPath(controlId), `${controlId} addresses its own endpoint`)
        .toBe(`${CONTROL_STATUS_BASE_PATH}/${controlId}`);
    }
  });

  // INVARIANT LOCKED: an identifier is recognised only by EXACT match. Nothing is trimmed,
  // case-folded or coerced into matching, because a control this client cannot name is a control
  // it cannot render a trustworthy verdict for.
  it.each([
    ['V1', true],
    ['V8', true],
    ['V9', false],
    ['v1', false],
    ['', false],
    ['V10', false],
    [' V1', false],
    ['V1 ', false],
  ])('isControlId(%o) is %s', (candidate, expected) => {
    expect(isControlId(candidate), `${JSON.stringify(candidate)} recognition`).toBe(expected);
  });

  // INVARIANT LOCKED: a control the payload does not mention is `undefined`, unambiguously. A
  // panel must render that as empty or unknown -- never as a pass -- and the hook's job is only
  // to be unambiguous about it.
  it('returns undefined for a control the payload does not mention', async () => {
    respondWithControlList([controlStatusFixture('V1')]);

    const result = await settledSuccess();

    expect
      .soft(
        selectControlStatus(result.controls, 'V8'),
        forRequirement('F-008-RQ-001', 'an unreported control is absent, not passing'),
      )
      .toBeUndefined();
    expect.soft(reportedPassVerdicts(result), 'only the reported control is reported').toEqual(['V1']);
  });

  // INVARIANT LOCKED: the lookup is by identifier and not by position, so a server that reorders
  // its entries cannot make a panel read another control's verdict.
  it('finds a control regardless of its position', async () => {
    respondWithControlList([
      controlStatusFixture('V2'),
      controlStatusFixture('V5'),
      controlStatusFixture('V8'),
    ]);

    const result = await settledSuccess();
    const found: ControlStatus | undefined = selectControlStatus(result.controls, 'V8');

    expect.soft(found?.controlId, 'the last entry is found by identifier').toBe('V8');
    expect
      .soft(selectControlStatus(result.controls, 'V2')?.controlId, 'and so is the first')
      .toBe('V2');
  });
});

