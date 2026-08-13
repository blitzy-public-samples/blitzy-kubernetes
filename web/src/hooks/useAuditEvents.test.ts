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
 * Contract tests for `useAuditEvents`: pagination, filtering and the empty result.
 *
 * AAP §0.5.1 (this file's row, whose purpose column reads exactly "Pagination, filtering,
 * empty result") / §0.4.2.4 (the React blueprint, which restates the same three
 * categories) / §0.4.1.2 (the assertion-semantics translation table: Go `t.Errorf`
 * accumulate becomes `expect.soft`, `t.Fatalf` abort becomes a hard `expect`, and a
 * `t.Run` table becomes `it.each`) / §0.4.2.2 (the V6 blueprint, whose CONFIDENTIALITY
 * GUARD this hook must keep assertable) / §0.10.2 (the confidentiality boundary
 * condition: no `secrets` event may carry a `responseObject`, while a `requestObject` on
 * create and update is the explicitly accepted trade-off) / tech-spec §6.6.3.4 (the
 * documentation convention this block and the per-test invariant comments satisfy).
 *
 * RULES POSITION. `review_rules` returns exactly one line: "No user rules provided." No
 * rule is invented here and their absence is not treated as licence to lower the bar --
 * AAP §0.11.1's enterprise-standard bar substitutes, and the items binding this file are
 * named at each group below.
 *
 * THE THREE MANDATED CATEGORIES, and where each is discharged:
 *   * pagination   -- "pagination", "advancing a page", "pagination metadata that
 *                     contradicts itself is refused";
 *   * filtering    -- "filtering" and "filtering over the recorded dimensions";
 *   * empty result -- "an empty result is a result, not a silence".
 * Two further groups exist because the three categories alone would leave the file's
 * reason for being unguarded: "the recorded bodies are surfaced verbatim" and "an HTTP
 * refusal is never an empty page".
 *
 * THE ONE PROPERTY EVERYTHING HERE PROTECTS. The V6 guard works by inspecting EVERY event
 * the server returned and failing if any `secrets` event carries a response body. That
 * makes this hook's contract unusual: it must validate without filtering.
 *
 * - VALIDATE, because `body as AuditEvent[]` is a compile-time assertion with no runtime
 *   effect. A page of strings, of nulls, or of objects missing every required member
 *   became a "successful" page of events, and the guard then ran over values it could not
 *   interpret. The sharpest case is `responseObject: true` — the flattened form
 *   `test/utils/audit.go` L151-156 produces for its Go comparison. It satisfies every
 *   `!== undefined` presence test while carrying nothing an object-shaped redactor can
 *   recognise, so the guard reports a violation it cannot describe and the redaction has
 *   nothing to redact.
 * - DO NOT FILTER, because the leaked body might be carried by exactly the event a filter
 *   discarded. Dropping an unreadable event is the one repair that could hide the
 *   disclosure the guard exists to find.
 *
 * The two combine into a single rule, asserted throughout: a page containing an event this
 * client cannot read is a page it can make NO claim about, so the whole page is refused.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  AUDIT_EVENTS_DEFAULT_PAGE_SIZE,
  AUDIT_EVENTS_ENDPOINT,
  AUDIT_EVENTS_QUERY_PARAMS,
  AUDIT_EVENTS_REQUEST_TIMEOUT_MS,
  AUDIT_LEVEL_ORDER,
  AUDIT_STAGES,
  MAX_HTTP_STATUS_CODE,
  MIN_HTTP_STATUS_CODE,
  isConfidentialAuditIdentity,
  resolveAuditResourceIdentity,
  useAuditEvents,
} from './useAuditEvents';
import type { AuditEvent, AuditEventFilter } from './useAuditEvents';
import {
  ALL_OBSERVED_AUDIT_EVENTS,
  AUDIT_SECRET_NAME,
  RBAC_AUDIT_RESPONSE_NAMESPACE,
  RBAC_RESPONSE_AUDIT_EVENTS,
  SECRETS_REQUEST_AUDIT_EVENTS,
  SECRETS_REQUEST_UNASSERTED_AUDIT_EVENTS,
  SECRET_AUDIT_REQUEST_NAMESPACE,
  secretsRequestAuditEvents,
} from '../test/fixtures/auditEvents';
import {
  AUDIT_EVENTS_QUALIFIED_RESOURCE,
  internalErrorStatusDocument,
  kubernetesStatus,
} from '../test/msw/handlers';
import type { KubernetesStatus } from '../test/msw/handlers';
import { server } from '../test/msw/server';

/** A conforming `audit.k8s.io/v1` event for a Secret create, with `overrides` applied. */
function auditEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'audit.k8s.io/v1',
    kind: 'Event',
    auditID: '2f0b4a1e-0000-4000-8000-000000000001',
    level: 'Request',
    stage: 'ResponseComplete',
    requestURI: '/api/v1/namespaces/secret-audit-request/secrets',
    verb: 'create',
    user: { username: 'system:admin', groups: ['system:masters'] },
    requestReceivedTimestamp: '2026-01-01T00:00:00.000000Z',
    stageTimestamp: '2026-01-01T00:00:00.100000Z',
    objectRef: { resource: 'secrets', namespace: 'secret-audit-request', name: 'audited' },
    responseStatus: { code: 201 },
    ...overrides,
  };
}

/**
 * The query strings a per-test handler observed, newest last.
 *
 * DELIBERATELY NOT MODULE STATE. AAP §0.11.1's isolation item requires isolation to be
 * structural rather than incidental, and a recorder shared between tests is exactly the
 * incidental kind: it survives a `beforeEach` reset only for as long as nobody forgets to
 * reset it, and under a randomised file order the forgetting is silent. Every `serve*`
 * helper below therefore returns a FRESH array owned by the one test that asked for it, so
 * no test can read another's requests even in principle.
 */
type IssuedQueries = string[];

/** Records one request's query string, minus the leading `?`. */
function recordQuery(into: IssuedQueries, url: string): void {
  into.push(new URL(url).search.replace(/^\?/, ''));
}

/**
 * Serves `body` at `status`, and returns the recorder of the requests it answered.
 *
 * The return value is the whole reason this returns anything: a test that needs to assert
 * on the query string keeps the array, and a test that does not simply ignores it.
 */
function respondWith(body: unknown, status = 200): IssuedQueries {
  const issued: IssuedQueries = [];
  server.use(
    http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
      recordQuery(issued, request.url);
      return HttpResponse.json(body as never, { status });
    }),
  );
  return issued;
}

/** Serves raw text, so an invalid-JSON body can be expressed. */
function respondWithText(text: string, status = 200): IssuedQueries {
  const issued: IssuedQueries = [];
  server.use(
    http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
      recordQuery(issued, request.url);
      return new HttpResponse(text, {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return issued;
}

/**
 * Refuses the listing with a realistic Kubernetes `Status` body at `status`.
 *
 * The body is the wire shape `apierrors` produces -- `kind`, `apiVersion`, `status`,
 * `code` and `reason` -- rather than a bare string, because the hook reads `reason` and
 * `code` out of it and a test that refused with an empty body would never exercise that
 * path. The message names the requirement that goes unreported when the listing is
 * refused, per AAP §0.7.2's failure-legibility criterion.
 *
 * @param status - the HTTP status to refuse with; 403 and 500 are the recorded cases.
 * @returns the recorder, newest query last.
 */
function serveRefusal(status: number): IssuedQueries {
  return respondWith(refusalBody(status), status);
}

/**
 * Composes the refusal document through the SHARED envelope factory.
 *
 * WHY THIS DELEGATES RATHER THAN BUILDING THE OBJECT INLINE. This helper used to
 * assemble the `Status` document itself and emitted no `details` at all, which made
 * every refusal it served structurally unlike one from an API server:
 * `apierrors.NewForbidden` sets `Details{Group, Kind, Name}` UNCONDITIONALLY - only
 * its message branches on an empty `GroupResource` - and `NewInternalError` sets
 * `Details.Causes` and prefixes its message with `Internal error occurred: `. A
 * second hand-rolled envelope is also how two specs drift apart while both stay
 * green, so the tier now has ONE definition of the shape and this spec reads it.
 *
 * @param status - 403 or 500, the two recorded refusals.
 * @returns the `Status` document to serve.
 */
function refusalBody(status: number): KubernetesStatus {
  if (status === 403) {
    return kubernetesStatus(
      'Forbidden',
      status,
      // The collection-scope branch: `<resource> is forbidden: <detail>`, which is
      // the form a listing denial takes because it addresses no single object.
      'events.audit.k8s.io is forbidden: sensitive-resource audit fidelity ' +
        '(F-006-RQ-003) cannot be reported without the listing',
      AUDIT_EVENTS_QUALIFIED_RESOURCE,
      '',
    );
  }
  const detail =
    'audit event evaluation failed; sensitive-resource audit fidelity ' +
    '(F-006-RQ-003) is unreported';
  // `internalErrorStatus` is not reused here because this helper must return the
  // DOCUMENT for `respondWith` to serve, not an `HttpResponse`; the envelope and
  // the cause still come from the shared factory, so the shape cannot drift.
  return internalErrorStatusDocument(detail);
}

/**
 * Serves the RECORDED audit stream, filtered and paginated exactly as the endpoint's
 * contract describes, and returns the recorder of the requests it answered.
 *
 * Events are served BY REFERENCE out of a `filter` and a `slice`, so each element handed
 * to the hook is the very object `../test/fixtures/auditEvents` exported -- `requestObject`
 * and `responseObject` included, untouched. Nothing is cloned field by field, re-ordered or
 * re-serialised, because a handler that rebuilt its events could quietly drop the very
 * member the confidentiality guard exists to find and every assertion downstream would
 * still be green.
 *
 * @param events - the recorded events to serve; pass `[]` for the empty state.
 * @returns the recorder, newest query last.
 */
function serveRecorded(events: readonly AuditEvent[] = ALL_OBSERVED_AUDIT_EVENTS): IssuedQueries {
  const issued: IssuedQueries = [];
  server.use(
    http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
      const url = new URL(request.url);
      recordQuery(issued, request.url);
      const query = url.searchParams;
      const page = Number(query.get(AUDIT_EVENTS_QUERY_PARAMS.page));
      const pageSize = Number(query.get(AUDIT_EVENTS_QUERY_PARAMS.pageSize));
      const matched = events.filter((event) => matchesRecordedFilter(event, query));
      const start = (page - 1) * pageSize;
      const items = matched.slice(start, start + pageSize);
      return HttpResponse.json({
        items,
        total: matched.length,
        hasMore: start + items.length < matched.length,
      });
    }),
  );
  return issued;
}

/**
 * Decides whether one recorded event satisfies the request's filter.
 *
 * EXACT comparisons only -- nothing is lower-cased, trimmed or prefix-matched. An audit
 * view that quietly widened `resource=secrets` would report on events nobody asked about,
 * and one that quietly narrowed it would hide events the confidentiality guard needs to
 * see. An unrecognised value therefore matches nothing, which is a truthful empty result
 * rather than a silent fallback to "everything".
 */
function matchesRecordedFilter(event: AuditEvent, query: URLSearchParams): boolean {
  const wanted = (name: string): string | undefined => {
    const raw = query.get(name);
    return raw === null || raw === '' ? undefined : raw;
  };
  const level = wanted(AUDIT_EVENTS_QUERY_PARAMS.level);
  if (level !== undefined && event.level !== level) {
    return false;
  }
  const namespace = wanted(AUDIT_EVENTS_QUERY_PARAMS.namespace);
  if (namespace !== undefined && event.objectRef?.namespace !== namespace) {
    return false;
  }
  const resource = wanted(AUDIT_EVENTS_QUERY_PARAMS.resource);
  if (resource !== undefined && event.objectRef?.resource !== resource) {
    return false;
  }
  const verb = wanted(AUDIT_EVENTS_QUERY_PARAMS.verb);
  return verb === undefined || event.verb === verb;
}

/** A response held open until the test decides to release it. */
interface Gate {
  /** Releases every awaiter. Safe to call once. */
  readonly open: () => void;
  /** Resolves when {@link Gate.open} is called. */
  readonly passed: Promise<void>;
}

/**
 * Creates a gate, so response ORDER can be chosen rather than timed.
 *
 * AAP §0.11.1's determinism item forbids a wall-clock sleep, and this is what replaces it.
 * A `setTimeout` race is decided by whichever duration the machine happened to honour, so
 * it passes on a fast runner and flakes on a loaded one; `web/vitest.config.ts` sets no
 * `retry`, and `hack/jenkins/test-dockerized.sh` runs under `set -o errexit`, so a single
 * flake fails the whole job. A gate removes the clock from the experiment entirely: the
 * test states the order it wants and the order is what happens.
 */
function gate(): Gate {
  let release: () => void = () => undefined;
  const passed = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { open: release, passed };
}

/**
 * The `name` of an abort reason, read structurally.
 *
 * `instanceof DOMException` is deliberately NOT how this reaches `name`: under the pinned
 * jsdom the reason the platform attaches to an aborted signal is a `DOMException` created in
 * a DIFFERENT realm, so `reason instanceof DOMException` is FALSE even though the object is
 * one. Reading `name` is still reading the NAME rather than the message text, which is what
 * matters: `AbortError` is the platform contract the hook's own `isAbortError` keys on, while
 * the message ("This operation was aborted") is implementation-defined and localisable, so a
 * spec matching it would go red on a jsdom upgrade that reworded it.
 *
 * Declared here as well as in the sibling `useControlStatus` spec rather than shared: AAP
 * §0.5.1 fixes the file map for `web/src/test/`, and a twelve-line reader is not worth a file
 * the plan does not name. Both copies assert the same platform fact.
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

/** Renders the hook and waits until it leaves `loading`. */
async function settled(options: Parameters<typeof useAuditEvents>[0] = {}) {
  const rendered = renderHook(() => useAuditEvents(options));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  return rendered;
}

/** Asserts the page was refused and returns the message. */
async function refusedMessage(): Promise<string> {
  const { result } = await settled();
  expect(result.current.status).toBe('error');
  expect(result.current.events).toEqual([]);
  // The property that matters: a refused page is NEVER an empty one.
  expect(result.current.isEmpty).toBe(false);
  return result.current.error?.message ?? '';
}

/**
 * The `AbortSignal` the hook handed to `fetch`, one per request, in order.
 *
 * Recorded for every test in this file rather than only the abort case, so a case that
 * SHOULD leave a request un-aborted can say so too. The spy passes straight through to the
 * real `fetch`, so MSW still serves every request and this observes rather than substitutes:
 * a spy that answered requests itself would be testing the spy.
 */
let observedSignals: AbortSignal[] = [];

/** Everything the code under test wrote to `console.error` during the case. */
let observedConsoleErrors: string[] = [];

/**
 * The two spies, held so they can be restored.
 *
 * `web/vitest.config.ts` sets `clearMocks`, which empties recorded calls between tests but
 * deliberately does NOT restore implementations. Leaving the `fetch` spy installed would make
 * the next test's spy wrap this one instead of the real implementation, and the recorded
 * signals would then accumulate across tests.
 */
let fetchSpy: MockInstance<typeof globalThis.fetch> | undefined;
let consoleErrorSpy: MockInstance<typeof console.error> | undefined;

beforeEach(() => {
  // A default one-event page, so a test whose subject is not the response body does not
  // have to state one. The recorder this returns is deliberately DISCARDED: a test that
  // asserts on the issued query installs its own handler and keeps that handler's
  // recorder, which is what keeps every observation local to the test that made it.
  respondWith({ items: [auditEvent()] });

  observedSignals = [];
  observedConsoleErrors = [];

  const realFetch = globalThis.fetch;
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) {
        observedSignals.push(init.signal);
      }
      return realFetch(input, init);
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

describe('the accepted envelope shapes', () => {
  // INVARIANT LOCKED: exactly two response shapes are understood -- the `{items, total,
  // hasMore}` envelope and a bare array -- and every other body is REFUSED rather than
  // coerced. A body this client cannot read is a body it can make no claim about, so
  // reporting it as a page (or as an empty page) would let the confidentiality guard clear
  // events it never actually saw (F-006-RQ-002).

  it('reads the canonical items envelope', async () => {
    respondWith({ items: [auditEvent(), auditEvent({ verb: 'update' })], total: 2 });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(2);
    expect(result.current.total).toBe(2);
    expect(result.current.isEmpty).toBe(false);
  });

  it('reads a bare array of events', async () => {
    respondWith([auditEvent()]);

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(1);
    expect(result.current.total).toBeUndefined();
  });

  it('reports an empty page as the empty state', async () => {
    respondWith({ items: [], total: 0 });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('stays idle and issues no request when disabled', async () => {
    const issued = respondWith({ items: [auditEvent()] });

    const { result } = await settled({ enabled: false });

    expect(result.current.status).toBe('idle');
    // Idle is distinct from an empty success, and the distinction is what stops a
    // collapsed panel from claiming there were no audit events to report.
    expect(result.current.isEmpty).toBe(false);
    expect(issued).toEqual([]);
  });

  it.each([
    ['a bare string', '"nope"'],
    ['a number', '7'],
    ['null', 'null'],
    ['an object with no items', '{"total":3}'],
    ['items that is not a list', '{"items":{"0":{}}}'],
  ])('refuses %s as a body', async (_name, text) => {
    respondWithText(text);

    expect(await refusedMessage()).toMatch(/unusable/i);
  });

  it('reports invalid JSON as an error rather than an empty page', async () => {
    respondWithText('{"items": [');

    const { result } = await settled();

    expect(result.current.status).toBe('error');
    expect(result.current.isEmpty).toBe(false);
  });

  it.each([
    ['total', '{"items":[],"total":"3"}'],
    ['hasMore', '{"items":[],"hasMore":"yes"}'],
  ])('refuses a wrong-typed %s rather than ignoring it', async (name, text) => {
    // Ignoring it would silently fall back to the inference heuristic, so a server that
    // reported pagination in a broken way would be paginated by guesswork instead.
    respondWithText(text);

    expect(await refusedMessage()).toContain(name);
  });
});

describe('every event is validated, and none is ever dropped', () => {
  // INVARIANT LOCKED, and it is the pairing that matters rather than either half alone:
  // every event is VALIDATED, and no event is ever DROPPED.
  //
  // Validated, because `body as AuditEvent[]` is a compile-time assertion with no runtime
  // effect, so a page of strings or of objects missing every required member would become a
  // "successful" page and the guard would run over values it cannot interpret. Never
  // dropped, because the leaked response body might be carried by exactly the event a repair
  // discarded -- silently removing an unreadable event is the one fix that could hide the
  // disclosure the guard exists to find. The two combine into a single rule: a page holding
  // one unreadable event is refused whole (F-006-RQ-002).

  it.each([
    ['a string', '"not an event"'],
    ['null', 'null'],
    ['a number', '1'],
    ['an array', '[]'],
  ])('refuses a page whose member is %s', async (_name, member) => {
    respondWithText(`{"items":[${member}]}`);

    expect(await refusedMessage()).toMatch(/event at index 0/);
  });

  it.each([
    'auditID',
    'requestURI',
    'verb',
    'requestReceivedTimestamp',
    'stageTimestamp',
  ])('refuses an event missing the required "%s"', async (field) => {
    const incomplete = auditEvent();
    delete incomplete[field];
    respondWith({ items: [incomplete] });

    expect(await refusedMessage()).toContain(field);
  });

  it.each(['auditID', 'verb'])('refuses an empty "%s"', async (field) => {
    respondWith({ items: [auditEvent({ [field]: '' })] });

    expect(await refusedMessage()).toMatch(new RegExp(`"${field}" is empty`));
  });

  it('refuses a wrong apiVersion', async () => {
    respondWith({ items: [auditEvent({ apiVersion: 'audit.k8s.io/v1beta1' })] });

    expect(await refusedMessage()).toMatch(/apiVersion/);
  });

  it.each(['EventList', 'Pod', ''])('refuses kind "%s"', async (kind) => {
    // `EventList` is the sharp case: it is registered under the same group and version, so
    // an apiVersion-only check accepted it, and its `items` are never read — every field
    // the guard needs would have been absent while the page counted as successful.
    respondWith({ items: [auditEvent({ kind })] });

    expect(await refusedMessage()).toMatch(/kind/);
  });

  it.each(['Requested', 'request', 'REQUEST', '', 'RequestResponseResponse'])(
    'refuses level "%s", which is outside the closed set',
    async (level) => {
      // The level is the field F-006-RQ-002 asserts. One outside the four compares unequal
      // to every entry of AUDIT_LEVEL_ORDER, so an ordering assertion becomes
      // unfalsifiable rather than failing — it silently has nothing to compare.
      respondWith({ items: [auditEvent({ level })] });

      expect(await refusedMessage()).toMatch(/level/);
    },
  );

  it.each(AUDIT_LEVEL_ORDER)('accepts the documented level "%s"', async (level) => {
    respondWith({ items: [auditEvent({ level })] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events[0]?.level).toBe(level);
  });

  it.each(AUDIT_STAGES)('accepts the documented stage "%s"', async (stage) => {
    respondWith({ items: [auditEvent({ stage })] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
  });

  it('refuses an unknown stage', async () => {
    respondWith({ items: [auditEvent({ stage: 'ResponseFinished' })] });

    expect(await refusedMessage()).toMatch(/stage/);
  });

  it.each([
    ['a string', '"system:admin"'],
    ['null', 'null'],
    ['absent', undefined],
  ])('refuses an event whose user is %s', async (_name, replacement) => {
    if (replacement === undefined) {
      const withoutUser = auditEvent();
      delete withoutUser['user'];
      respondWith({ items: [withoutUser] });
    } else {
      respondWithText(
        JSON.stringify({ items: [auditEvent()] }).replace(
          /"user":\{[^}]*\}/,
          `"user":${replacement}`,
        ),
      );
    }

    expect(await refusedMessage()).toMatch(/user/);
  });

  it('refuses a user with no username', async () => {
    respondWith({ items: [auditEvent({ user: { groups: ['system:masters'] } })] });

    expect(await refusedMessage()).toMatch(/user/);
  });

  it.each([
    ['objectRef', '"secrets"'],
    ['responseStatus', '201'],
    ['impersonatedUser', 'true'],
    ['annotations', '["allow"]'],
  ])('refuses a wrong-typed optional %s', async (key, replacement) => {
    respondWithText(
      JSON.stringify({ items: [auditEvent({ [key]: { placeholder: true } })] }).replace(
        new RegExp(`"${key}":\\{[^}]*\\}`),
        `"${key}":${replacement}`,
      ),
    );

    expect(await refusedMessage()).toContain(key);
  });

  it('accepts an event with none of the optional members', async () => {
    const minimal = auditEvent();
    delete minimal['objectRef'];
    delete minimal['responseStatus'];
    respondWith({ items: [minimal] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events[0]?.objectRef).toBeUndefined();
  });
});

describe('the flattened body form must never be accepted', () => {
  // INVARIANT LOCKED: `requestObject` and `responseObject` are OBJECTS on the wire, never
  // presence booleans, and the boolean form is refused outright.
  //
  // `test/utils/audit.go` L151-156 does `if e.ResponseObject != nil { event.ResponseObject =
  // true }`, flattening the payload for cheap Go-side struct comparison. That flattening is a
  // Go-test convenience and must never reach this tier: `responseObject: true` satisfies every
  // `!== undefined` presence check while carrying nothing an object-shaped redactor can
  // recognise, so the guard would report a disclosure it cannot describe and the redaction
  // would have nothing to redact (F-006-RQ-002).

  it.each([
    ['responseObject', true],
    ['responseObject', false],
    ['requestObject', true],
  ])('refuses a boolean %s (the Go-flattened form)', async (key, flattened) => {
    // THE MOTIVATING DEFECT, and the reason this hook validates at all.
    // `test/utils/audit.go` L151-156 flattens the body to `true` for its Go comparison.
    // On the wire that value satisfies every `!== undefined` presence check while carrying
    // nothing object-shaped redaction can recognise, so the guard reports a disclosure it
    // cannot describe — or a redactor that only handles objects passes the value through.
    respondWith({ items: [auditEvent({ [key]: flattened })] });

    const message = await refusedMessage();
    expect(message).toContain(key);
    expect(message).toMatch(/flattened/i);
  });

  it.each([
    ['a string', '"redacted"'],
    ['a number', '1'],
    ['an array', '[{"data":{}}]'],
    ['null', 'null'],
  ])('refuses a responseObject that is %s', async (_name, replacement) => {
    respondWithText(`{"items":[${JSON.stringify(auditEvent()).slice(0, -1)},"responseObject":${replacement}}]}`);

    expect(await refusedMessage()).toContain('responseObject');
  });

  it('keeps a genuine object responseObject inspectable, so the guard can fire', async () => {
    // The positive control for the whole guard: the hook must NOT strip or redact the body.
    // Redaction is the rendering component's job. A hook that helpfully deleted it would
    // leave every spec green while making the guard unprovable.
    respondWith({
      items: [auditEvent({ level: 'RequestResponse', responseObject: { kind: 'Secret', data: {} } })],
    });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    const [event] = result.current.events;
    expect(event?.responseObject).toBeDefined();
    expect(typeof event?.responseObject).toBe('object');
    // The guard, expressed exactly as a panel expresses it.
    const offenders = result.current.events.filter(
      (candidate) =>
        candidate.objectRef?.resource === 'secrets' && candidate.responseObject !== undefined,
    );
    expect(offenders).toHaveLength(1);
  });

  it('accepts an EMPTY but present responseObject, which the guard must still catch', async () => {
    // Presence, never truthiness: an empty-but-present body on a Secret event is exactly
    // the regression the guard exists to find, and a truthiness test would report it absent.
    respondWith({ items: [auditEvent({ responseObject: {} })] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events[0]?.responseObject).toEqual({});
    expect(result.current.events[0]?.responseObject).not.toBeUndefined();
  });

  it('refuses the whole page when ONE event of several is malformed', async () => {
    // Never a partial page. The leaked body might be carried by exactly the event a filter
    // would have discarded, so a page with one unreadable event is a page this client can
    // make no claim about.
    respondWith({
      items: [auditEvent(), auditEvent({ responseObject: true }), auditEvent()],
    });

    const message = await refusedMessage();
    expect(message).toMatch(/event at index 1/);
  });
});

describe('nested members are validated to their leaves, not merely as objects', () => {
  // THE CRITICAL DEFECT THESE CLOSE. `objectRef`, `responseStatus`, the two subjects and
  // `annotations` were checked only with "is it an object". `objectRef: {}` therefore
  // passed — and the confidentiality guard, which asks
  // `event.objectRef?.resource === 'secrets'`, read `undefined` from it, concluded "not a
  // Secret", and let the event's responseObject be serialized into the document. Every
  // case below is a Secret event that could carry a body past that guard.

  it.each([
    ['an empty objectRef', {}],
    ['a resource of the wrong type', { resource: 7, namespace: 'secret-audit-request' }],
    ['an empty resource', { resource: '', namespace: 'secret-audit-request' }],
    ['a null resource', { resource: null }],
  ])('refuses %s, because an objectRef that exists must say what it refers to', async (
    _label,
    objectRef,
  ) => {
    respondWith({
      items: [auditEvent({ objectRef, responseObject: { kind: 'Secret', data: {} } })],
    });

    const message = await refusedMessage();

    expect(message).toContain('objectRef');
    expect(message).toContain('resource');
  });

  it('still accepts an event with NO objectRef, which is a non-resource request', async () => {
    // The distinction that keeps this strict rather than blunt: an absent objectRef is
    // legitimate (`/healthz` has none), while a present-but-unreadable one is not.
    respondWith({
      items: [auditEvent({ objectRef: undefined, requestURI: '/healthz', verb: 'get' })],
    });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(1);
  });

  it('accepts the core API group written as the empty string', async () => {
    // `apiGroup: ''` IS the core group, so this one member may be empty where the others
    // may not. A blanket non-empty rule would refuse every core-group event.
    respondWith({
      items: [
        auditEvent({
          objectRef: { resource: 'secrets', namespace: 'secret-audit-request', apiGroup: '' },
        }),
      ],
    });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
  });

  it.each([
    ['namespace', { resource: 'secrets', namespace: 7 }],
    ['name', { resource: 'secrets', name: {} }],
    ['subresource', { resource: 'secrets', subresource: 3 }],
    ['apiVersion', { resource: 'secrets', apiVersion: false }],
  ])('refuses an objectRef whose %s is not a string', async (member, objectRef) => {
    respondWith({ items: [auditEvent({ objectRef })] });

    expect(await refusedMessage()).toContain(`objectRef.${member}`);
  });

  it.each([
    ['a missing code', { status: 'Success' }],
    ['a string code', { code: '201' }],
    ['a fractional code', { code: 201.5 }],
    ['an out-of-range code', { code: 99 }],
    ['a code above the range', { code: 600 }],
  ])('refuses a responseStatus with %s', async (_label, responseStatus) => {
    // The V2 and V7 controls are decided by EXACT status codes, and none of these can be
    // compared against 403.
    respondWith({ items: [auditEvent({ responseStatus })] });

    expect(await refusedMessage()).toContain('responseStatus.code');
  });

  it('refuses a responseStatus whose reason is not a string', async () => {
    respondWith({ items: [auditEvent({ responseStatus: { code: 403, reason: 7 } })] });

    expect(await refusedMessage()).toContain('responseStatus.reason');
  });

  it.each([
    ['a group of the wrong type', { username: 'u', groups: [7] }],
    ['a group that is an object', { username: 'u', groups: [{}] }],
    ['groups that are not a list', { username: 'u', groups: 'system:masters' }],
    ['a uid of the wrong type', { username: 'u', uid: 7 }],
  ])('refuses a user with %s rather than narrowing the identity', async (_label, user) => {
    // Dropping an unreadable group would produce a DIFFERENT, narrower identity — and
    // the identity of the principal is what makes an audit event evidence.
    respondWith({ items: [auditEvent({ user })] });

    expect(await refusedMessage()).toContain('user');
  });

  it('refuses an impersonatedUser that is malformed', async () => {
    respondWith({ items: [auditEvent({ impersonatedUser: { username: '' } })] });

    expect(await refusedMessage()).toContain('impersonatedUser');
  });

  it('validates user.extra to its leaves', async () => {
    respondWith({
      items: [auditEvent({ user: { username: 'u', extra: { 'scopes.authorization': [7] } } })],
    });

    expect(await refusedMessage()).toContain('user.extra');
  });

  it('refuses annotations whose value is not a string', async () => {
    // The authorizer's verdict is read out of this map by key and rendered; a nested
    // object reaches the decision column as `[object Object]`, which reads as a decision.
    respondWith({ items: [auditEvent({ annotations: { 'authorization.k8s.io/decision': {} } })] });

    expect(await refusedMessage()).toContain('annotations');
  });

  it.each([
    ['sourceIPs', { sourceIPs: ['127.0.0.1', 7] }],
    ['userAgent', { userAgent: 7 }],
  ])('refuses a malformed %s', async (member, overrides) => {
    respondWith({ items: [auditEvent(overrides)] });

    expect(await refusedMessage()).toContain(member);
  });

  it('accepts a fully populated, well-formed event unchanged', async () => {
    // The positive control for all of the above: strictness must not cost fidelity.
    const complete = auditEvent({
      sourceIPs: ['127.0.0.1'],
      userAgent: 'kubectl/v1.34.0',
      impersonatedUser: { username: 'system:serviceaccount:kube-system:default', groups: [] },
      user: { username: 'system:admin', groups: ['system:masters'], uid: 'uid-1', extra: {} },
      annotations: { 'authorization.k8s.io/decision': 'allow' },
    });
    respondWith({ items: [complete] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events[0]).toEqual(complete);
  });
});

describe('the two statements of identity must agree', () => {
  // A `requestURI` and an `objectRef` that name different things cannot both be
  // believed. Choosing either one is unsound: believing the objectRef lets a crafted
  // event have its Secret body classified as a ConfigMap's, and believing the URI makes
  // the rendered table disagree with the verdict.

  it('refuses an event whose requestURI and objectRef name different resources', async () => {
    respondWith({
      items: [
        auditEvent({
          requestURI: '/api/v1/namespaces/secret-audit-request/secrets/audited',
          objectRef: { resource: 'configmaps', namespace: 'secret-audit-request' },
          responseObject: { data: {} },
        }),
      ],
    });

    const message = await refusedMessage();

    expect(message).toContain('secrets');
    expect(message).toContain('configmaps');
    expect(message).toContain('cannot both be believed');
  });

  it('refuses an event whose namespaces disagree', async () => {
    respondWith({
      items: [
        auditEvent({
          requestURI: '/api/v1/namespaces/secret-audit-request/secrets',
          objectRef: { resource: 'secrets', namespace: 'kube-system' },
        }),
      ],
    });

    expect(await refusedMessage()).toContain('namespace');
  });

  it('refuses an event whose subresources disagree', async () => {
    respondWith({
      items: [
        auditEvent({
          requestURI: '/api/v1/namespaces/ns/serviceaccounts/sa/token',
          objectRef: { resource: 'serviceaccounts', namespace: 'ns', subresource: 'status' },
        }),
      ],
    });

    expect(await refusedMessage()).toContain('subresource');
  });

  it.each([
    ['a core-group collection', '/api/v1/namespaces/secret-audit-request/secrets', 'secrets'],
    [
      'a core-group object',
      '/api/v1/namespaces/secret-audit-request/secrets/audited',
      'secrets',
    ],
    [
      'a named-group path',
      '/apis/rbac.authorization.k8s.io/v1/namespaces/rbac-audit-response/roles/r',
      'roles',
    ],
    ['a cluster-scoped path', '/apis/rbac.authorization.k8s.io/v1/clusterroles/edit', 'clusterroles'],
    ['a subresource path', '/api/v1/namespaces/ns/serviceaccounts/sa/token', 'serviceaccounts'],
    ['a query string', '/api/v1/namespaces/ns/secrets?watch=true', 'secrets'],
  ])('reconciles %s against a matching objectRef', async (_label, requestURI, resource) => {
    // Every recorded path shape must pass, or the guard would refuse real evidence.
    respondWith({ items: [auditEvent({ requestURI, objectRef: { resource } })] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
  });

  it.each([
    ['/healthz'],
    ['/version'],
    ['/metrics'],
    ['/openapi/v2'],
  ])('does not invent a contradiction for the non-resource path %s', async (requestURI) => {
    // A non-resource path names no resource, so there is nothing to reconcile. Guessing
    // "probably the last segment" would manufacture contradictions out of `/healthz`.
    respondWith({ items: [auditEvent({ requestURI, objectRef: { resource: 'secrets' } })] });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
  });
});

describe('an HTTP refusal is never an empty page', () => {
  // AAP §0.11.1's "no false passes", applied to the subtlest false pass in this tier: a
  // refusal and an empty result both render as "nothing to show". The 403 and the 500 are
  // the two recorded cases; 401 and 503 are carried alongside them because the property is
  // about non-2xx generally, not about one status code.

  it.each([403, 401, 500, 503])('reports HTTP %i as an error carrying the status', async (status) => {
    respondWith(
      { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: status, reason: 'Forbidden' },
      status,
    );

    const { result } = await settled();

    expect(result.current.status).toBe('error');
    expect(
      result.current.error?.httpStatus,
      `F-006-RQ-003: HTTP ${String(status)} must be preserved on the error, because a reader ` +
        'of a CI failure cannot tell a refusal from an outage without it',
    ).toBe(status);
    expect(result.current.events).toEqual([]);
    // A UI showing "no audit events" after a refusal would assert a clean bill of health it
    // has no evidence for.
    expect(
      result.current.isEmpty,
      `F-006-RQ-002: HTTP ${String(status)} must NOT set the empty-result flag; conflating ` +
        '"the server refused" with "there are no audit events" reports a clean ' +
        'confidentiality result on no evidence at all',
    ).toBe(false);
  });

  it.each([403, 500])(
    'reports the recorded Kubernetes Status body for HTTP %i as an error, not as emptiness',
    async (status) => {
      // The realistic `Status` wire shape rather than a bare body, so the `reason`/`code`
      // extraction path is genuinely exercised.
      const issued = serveRefusal(status);

      const { result } = await settled();

      expect(issued).toHaveLength(1);
      expect(result.current.status).toBe('error');
      expect(result.current.error?.httpStatus).toBe(status);
      expect(result.current.error?.code).toBe(status);
      expect(result.current.error?.reason).toBe(status === 403 ? 'Forbidden' : 'InternalError');
      expect(result.current.error?.message).toContain('F-006-RQ-003');
      expect(result.current.isEmpty).toBe(false);
      expect(result.current.hasNextPage).toBe(false);
      expect(result.current.total).toBeUndefined();
      // No page was ever loaded, which is what a traversal must see: a refusal is not a
      // scanned page, and treating it as one would let a guard skip past it.
      expect(result.current.loadedPage).toBeUndefined();
    },
  );

  it('preserves the Kubernetes Status reason and message', async () => {
    respondWith(
      {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        code: 403,
        reason: 'Forbidden',
        message: 'auditevents is forbidden',
      },
      403,
    );

    const { result } = await settled();

    expect(result.current.error?.reason).toBe('Forbidden');
    expect(result.current.error?.message).toBe('auditevents is forbidden');
  });

  it('reports a transport failure with NO http status at all', async () => {
    // INVARIANT LOCKED: a request that never produced a response reports the
    // ABSENCE of a status, not a fabricated one.
    //
    // This case previously asserted `httpStatus === 0`, which encoded the defect
    // rather than the requirement: 0 is not an HTTP status, it put an invented
    // value in the field that otherwise carries a real one, and it obliged every
    // consumer to recognise it as a sentinel. ConfidentialityRedaction did exactly
    // that and any consumer that forgot rendered the literal text "HTTP status 0".
    // The `kind` discriminant now names the layer that failed and `httpStatus` is
    // simply absent, which agrees with the sibling hook useControlStatus.
    server.use(http.get(AUDIT_EVENTS_ENDPOINT, () => HttpResponse.error()));

    const { result } = await settled();

    expect(result.current.status).toBe('error');
    expect
      .soft(result.current.error?.kind, 'no response arrived, so the failure is a network failure')
      .toBe('network');
    expect
      .soft(
        result.current.error?.httpStatus,
        'nothing answered, so no status may be reported for it - not even 0',
      )
      .toBeUndefined();
    expect
      .soft(
        Object.hasOwn(result.current.error ?? {}, 'httpStatus'),
        'the key is absent rather than present-and-undefined, so serialising the error cannot reintroduce it',
      )
      .toBe(false);
    expect(
      result.current.isEmpty,
      'F-006-RQ-002: a request that never reached the server is not an empty result either',
    ).toBe(false);
  });
});

describe('pagination', () => {
  // AAP §0.5.1 category 1 (pagination). Why a paging contract is a security property here
  // rather than a convenience: the confidentiality guard only clears a Secret disclosure
  // after traversing every page, so a page number that does not reach the server, or a
  // has-more signal that lies in either direction, ends the traversal early and produces a
  // clean verdict about events nobody looked at (F-006-RQ-002).

  it('sends page and pageSize, with the documented parameter names and order', async () => {
    const issued = respondWith({ items: [auditEvent()] });

    await settled({ page: 3, pageSize: 20 });

    expect(issued).toHaveLength(1);
    expect(
      issued[0],
      'F-006-RQ-003: the page and page size must reach the server under the documented ' +
        'names and in the documented order, because the recorded handlers and the parity ' +
        'map both describe that exact request',
    ).toBe(`${AUDIT_EVENTS_QUERY_PARAMS.page}=3&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=20`);
  });

  it('defaults the page size and starts at page 1', async () => {
    const { result } = await settled();

    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(AUDIT_EVENTS_DEFAULT_PAGE_SIZE);
    expect(result.current.hasPreviousPage).toBe(false);
  });

  it('reports which page the held events were fetched FOR', async () => {
    // `loadedPage` exists so a consumer accumulating pages can key each batch by the page
    // it actually came from. The confidentiality guard traverses every page before it will
    // make a whole-set claim, and keying by `page` instead filed one page's events under
    // another's number and then counted them twice.
    const { result } = await settled({ page: 4 });

    expect(result.current.loadedPage).toBe(4);
    expect(result.current.page).toBe(4);
  });

  it('reports no loaded page while the query has never run', () => {
    const { result } = renderHook(() => useAuditEvents({ enabled: false }));

    // `undefined` rather than 1, so "no page has loaded" is distinguishable from "page 1
    // has loaded". A consumer that treated the first as the second would record an empty
    // batch as a scanned page.
    expect(result.current.loadedPage).toBeUndefined();
    expect(result.current.status).toBe('idle');
  });

  it('clears the loaded page while a new page is in flight, then reports the new one', async () => {
    respondWith({ items: [auditEvent(), auditEvent()], total: 4 });
    // Waited on `loadedPage` itself rather than on `settled`, which only waits for the
    // hook to leave `loading` and can therefore return during the idle render before the
    // first request has resolved.
    const { result } = renderHook(() => useAuditEvents({ pageSize: 2 }));
    await waitFor(() => {
      expect(result.current.loadedPage).toBe(1);
    });

    expect(result.current.hasNextPage).toBe(true);

    act(() => {
      result.current.nextPage();
    });

    // `loadedPage` describes the events currently HELD, and a page change discards them —
    // so it is `undefined` here, alongside an empty `events` and a `loading` status. That
    // is the property an accumulating consumer relies on: there is no state in which a
    // page NUMBER can be paired with another page's EVENTS, so a batch cannot be filed
    // under the wrong key and counted twice.
    expect(result.current.page).toBe(2);
    expect(result.current.loadedPage).toBeUndefined();
    expect(result.current.events).toEqual([]);
    expect(result.current.status).toBe('loading');

    await waitFor(() => {
      expect(result.current.loadedPage).toBe(2);
    });
  });

  it('resolves hasNextPage from the loaded page, not from a page still in flight', async () => {
    // Two pages of two, four in total. On page 2 the arithmetic must say there is no
    // further page. Resolving from the CURRENT page while page 1's events and total were
    // still held would answer for the wrong page.
    respondWith({ items: [auditEvent(), auditEvent()], total: 4 });
    const { result } = await settled({ page: 2, pageSize: 2 });

    expect(result.current.loadedPage).toBe(2);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(true);
  });

  it.each([
    [0, 1],
    [-5, 1],
    [1.9, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('clamps an unusable initial page %s to %i', async (given, expected) => {
    const { result } = await settled({ page: given });

    expect(result.current.page).toBe(expected);
  });

  it('prefers an explicit hasMore over the full-page heuristic', async () => {
    // A server that cannot count totals can still paginate correctly, so the explicit
    // signal must win — including when it CONTRADICTS the heuristic, which is the case
    // that proves the precedence rather than merely exercising it. A full page would
    // otherwise be read as implying another.
    respondWith({ items: [auditEvent()], hasMore: false });

    const { result } = await settled({ pageSize: 1 });

    expect(result.current.hasNextPage).toBe(false);
  });

  it('falls back to the total when hasMore is absent', async () => {
    respondWith({ items: [auditEvent(), auditEvent()], total: 5 });

    const { result } = await settled({ pageSize: 2 });

    expect(result.current.hasNextPage).toBe(true);
  });

  it('reports no next page when the total is exhausted', async () => {
    // The LAST page. Claiming a further page here would send a traversal after a page that
    // does not exist; claiming none too early would end it before the page that does.
    respondWith({ items: [auditEvent(), auditEvent()], total: 2 });

    const { result } = await settled({ pageSize: 2 });

    expect(
      result.current.hasNextPage,
      'F-006-RQ-003: the last page must report no successor, or a traversal fetches past the ' +
        'end and can read the resulting empty page as an empty RESULT',
    ).toBe(false);
  });

  it('uses the full-page heuristic when neither hasMore nor total is reported', async () => {
    respondWith({ items: [auditEvent(), auditEvent()] });

    const { result } = await settled({ pageSize: 2 });

    expect(result.current.hasNextPage).toBe(true);
  });

  it('reports no next page for a short page under the heuristic', async () => {
    respondWith({ items: [auditEvent()] });

    const { result } = await settled({ pageSize: 2 });

    expect(result.current.hasNextPage).toBe(false);
  });

  it('never reports a next page while in the error state', async () => {
    respondWith({ kind: 'Status', code: 500 }, 500);

    const { result } = await settled({ pageSize: 1 });

    expect(result.current.status).toBe('error');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('advances and retreats within bounds', async () => {
    respondWith({ items: [auditEvent()], hasMore: true });

    const { result } = await settled({ pageSize: 1 });
    expect(result.current.page).toBe(1);

    await act(async () => {
      result.current.nextPage();
    });
    await waitFor(() => {
      expect(result.current.page).toBe(2);
    });
    expect(result.current.hasPreviousPage).toBe(true);

    await act(async () => {
      result.current.previousPage();
    });
    await waitFor(() => {
      expect(result.current.page).toBe(1);
    });
  });

  it('refuses to advance past the last page', async () => {
    respondWith({ items: [auditEvent()], hasMore: false });

    const { result } = await settled({ pageSize: 1 });

    await act(async () => {
      result.current.nextPage();
    });

    expect(result.current.page).toBe(1);
  });

  it('refuses to retreat below page 1', async () => {
    const { result } = await settled();

    await act(async () => {
      result.current.previousPage();
    });

    expect(result.current.page).toBe(1);
  });

  it('clamps an out-of-range setPage', async () => {
    const { result } = await settled();

    await act(async () => {
      result.current.setPage(0);
    });

    expect(result.current.page).toBe(1);
  });
});

describe('advancing a page re-asks the server, and only the latest answer counts', () => {
  // AAP §0.5.1 category 1 (pagination). The invariants locked here are the two a paging
  // control can get wrong without ever looking wrong: the SECOND request must carry the
  // second page's parameters, and a response for a page the operator has already left must
  // not be allowed to land. Both matter to F-006-RQ-002, because the confidentiality guard
  // clears a Secret disclosure only after traversing every page -- a traversal that
  // re-asked for page 1, or that displayed page 1's events under page 2's number, would
  // report a clean result about events it never actually examined.

  it('issues a second request carrying the next page, with the page size unchanged', async () => {
    // The recorded stream, two events to a page: ten matches, so page 2 exists.
    const issued = serveRecorded();

    const { result } = await settled({ pageSize: 2 });
    expect(issued).toHaveLength(1);
    expect(issued[0]).toBe(
      `${AUDIT_EVENTS_QUERY_PARAMS.page}=1&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=2`,
    );
    expect(result.current.hasNextPage).toBe(true);
    const firstPageIds = result.current.events.map((event) => event.auditID);

    await act(async () => {
      result.current.nextPage();
    });
    await waitFor(() => {
      expect(result.current.loadedPage).toBe(2);
    });

    // The request itself, not merely the reported page number: a control that advanced its
    // state without advancing its query would show page 1 twice and a traversal would never
    // terminate.
    expect(issued).toHaveLength(2);
    expect(issued[1]).toBe(
      `${AUDIT_EVENTS_QUERY_PARAMS.page}=2&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=2`,
    );
    // REPLACED, not appended -- the hook's documented contract is that `events` is the
    // CURRENT page. Asserting the identities differ is what distinguishes replacement from
    // a page that silently re-served the first two events.
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events.map((event) => event.auditID)).not.toEqual(firstPageIds);
    expect(result.current.total).toBe(ALL_OBSERVED_AUDIT_EVENTS.length);
  });

  it('reports no further page once the recorded stream is exhausted', async () => {
    // The LAST page specifically. Ten recorded events at five to a page means page 2 is the
    // end, and the has-more signal must say so -- a traversal that believed one more page
    // existed would fetch an empty page and could report it as an empty RESULT.
    const issued = serveRecorded();

    const { result } = await settled({ page: 2, pageSize: 5 });

    expect(result.current.loadedPage).toBe(2);
    expect(result.current.events).toHaveLength(5);
    expect(result.current.total).toBe(ALL_OBSERVED_AUDIT_EVENTS.length);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(true);
    expect(result.current.isEmpty).toBe(false);

    // `nextPage` is a no-op at the end, so no third request is issued.
    await act(async () => {
      result.current.nextPage();
    });
    expect(result.current.page).toBe(2);
    expect(issued).toHaveLength(1);
  });

  it('never lets a superseded page overwrite the page the operator moved to', async () => {
    // THE STALE-RESPONSE RACE, driven by gates rather than by timing. Page 2's response is
    // held open, the operator jumps to page 3, page 3 answers immediately, and only THEN is
    // page 2 released. If the late answer could land, the panel would display page 2's
    // events under page 3's number -- and the confidentiality guard would attribute one
    // page's evidence to another, which is how a Secret disclosure gets counted as already
    // cleared (F-006-RQ-002).
    const pageTwo = gate();
    const answeredPages: number[] = [];
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, async ({ request }) => {
        const requested = Number(
          new URL(request.url).searchParams.get(AUDIT_EVENTS_QUERY_PARAMS.page),
        );
        if (requested === 2) {
          await pageTwo.passed;
        }
        answeredPages.push(requested);
        return HttpResponse.json({
          items: [auditEvent({ auditID: `page-${String(requested)}` })],
          total: 9,
          hasMore: requested < 9,
        } as never);
      }),
    );

    // Rendered directly rather than through `settled`: page 2's answer is held, so a helper
    // that waited for the query to leave `loading` would wait for something this test is
    // deliberately preventing.
    const { result } = renderHook(() => useAuditEvents({ page: 2, pageSize: 1 }));
    // Page 2 is still held, so the hook is loading and holds NO events. That is the state a
    // late arrival would corrupt.
    expect(result.current.status).toBe('loading');
    expect(result.current.loadedPage).toBeUndefined();

    act(() => {
      result.current.setPage(3);
    });
    await waitFor(() => {
      expect(result.current.loadedPage).toBe(3);
    });
    expect(result.current.events[0]?.auditID).toBe('page-3');

    // Only now is the superseded request allowed to answer.
    pageTwo.open();
    await waitFor(() => {
      expect(answeredPages).toContain(2);
    });

    // The latest request still owns the state. Asserted on `loadedPage` AND on the event
    // identity, because either alone could pass while the other had been overwritten.
    expect(result.current.page).toBe(3);
    expect(result.current.loadedPage).toBe(3);
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.auditID).toBe('page-3');
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
  });
});


describe('pagination metadata that contradicts itself is refused', () => {
  // THE FAILURE THESE CLOSE. Metadata saying "this is the last page" while the page's
  // own numbers say otherwise turns incomplete data into a successful final page — and
  // a consumer that stops paging there reports a clean confidentiality result about
  // events it never fetched. Every case below was previously accepted, and each one
  // produced a confident answer from an impossible input.

  it.each([
    ['a negative total', { items: [], total: -3 }],
    ['a fractional total', { items: [], total: 2.5 }],
  ])('refuses %s rather than doing arithmetic with it', async (_label, body) => {
    respondWith(body);

    expect(await refusedMessage()).toContain('non-negative integer');
  });

  it('accepts a total of exactly zero, which is a real count', async () => {
    respondWith({ items: [], total: 0 });

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.total).toBe(0);
  });

  it('refuses a hasMore that contradicts the reported total', async () => {
    // The review's own example: page 1 of 1 item out of a claimed 1000, reporting no
    // further pages. Trusting `hasMore` here stops the traversal 999 events early
    // while the panel reports a complete scan.
    respondWith({ items: [auditEvent()], total: 1000, hasMore: false });

    const message = await refusedMessage();

    expect(message).toContain('hasMore: false');
    expect(message).toContain('cannot both be believed');
  });

  it('refuses a hasMore: true that contradicts an exhausted total', async () => {
    respondWith({ items: [auditEvent()], total: 1, hasMore: true });

    expect(await refusedMessage()).toContain('cannot both be believed');
  });

  it('accepts a hasMore that agrees with the total', async () => {
    respondWith({ items: [auditEvent()], total: 4, hasMore: true });

    const { result } = await settled({ pageSize: 1 });

    expect(result.current.status).toBe('success');
    expect(result.current.hasNextPage).toBe(true);
  });

  it('refuses a page carrying more events than the requested pageSize', async () => {
    respondWith({ items: [auditEvent(), auditEvent({ verb: 'update' })] });

    const rendered = renderHook(() => useAuditEvents({ pageSize: 1 }));
    await waitFor(() => {
      expect(rendered.result.current.isLoading).toBe(false);
    });

    expect(rendered.result.current.status).toBe('error');
    expect(rendered.result.current.error?.message).toContain('not honouring the page size');
  });

  it('refuses an empty page that promises another with no total to arbitrate', async () => {
    // Untraversable: a consumer either loops forever or stops while claiming to have
    // seen everything.
    respondWith({ items: [], hasMore: true });

    expect(await refusedMessage()).toContain('cannot be traversed');
  });

  it('refuses a total smaller than the events already returned', async () => {
    respondWith({ items: [auditEvent(), auditEvent({ verb: 'update' })], total: 1 });

    expect(await refusedMessage()).toContain('more events than it claims exist');
  });

  it('refuses events returned past the end of the reported total', async () => {
    respondWith({ items: [auditEvent()], total: 2 });

    // Page 5 of size 2 starts at offset 8, which is past a total of 2, so a page
    // carrying an event there contradicts the total.
    const rendered = renderHook(() => useAuditEvents({ page: 5, pageSize: 2 }));
    await waitFor(() => {
      expect(rendered.result.current.isLoading).toBe(false);
    });

    expect(rendered.result.current.status).toBe('error');
    expect(rendered.result.current.error?.message).toContain('contradicts the events');
  });

  it('accepts an honestly empty page past the end of the total', async () => {
    // The legitimate past-the-end request, and the reason the offset rule is
    // conditional rather than absolute.
    respondWith({ items: [], total: 2, hasMore: false });

    const rendered = renderHook(() => useAuditEvents({ page: 9, pageSize: 4 }));
    await waitFor(() => {
      expect(rendered.result.current.isLoading).toBe(false);
    });

    expect(rendered.result.current.status).toBe('success');
    expect(rendered.result.current.isEmpty).toBe(true);
    expect(rendered.result.current.hasNextPage).toBe(false);
  });

  it('refuses a page past the end that still promises another', async () => {
    respondWith({ items: [], total: 2, hasMore: true });

    const rendered = renderHook(() => useAuditEvents({ page: 9, pageSize: 4 }));
    await waitFor(() => {
      expect(rendered.result.current.isLoading).toBe(false);
    });

    expect(rendered.result.current.error?.message).toContain('past the end');
  });

  it('refuses the page rather than reporting it as empty, so incompleteness is visible', async () => {
    respondWith({ items: [auditEvent()], total: 1000, hasMore: false });

    const { result } = await settled();

    expect(result.current.isEmpty).toBe(false);
    expect(result.current.events).toEqual([]);
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('refresh addresses fresh data rather than a cache', () => {
  it('issues the audit query with cache: no-store and no-cache request headers', async () => {
    // INVARIANT LOCKED (M11). Without this a refresh re-issues a byte-identical
    // cache-eligible GET, so a page cached BEFORE a confidentiality violation can be
    // replayed after it — and the panel then reports "no Secret event carries a
    // response body" about events recorded before the one that did.
    const observed: { cache: string; cacheControl: string | null; pragma: string | null }[] = [];
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
        observed.push({
          cache: request.cache,
          cacheControl: request.headers.get('Cache-Control'),
          pragma: request.headers.get('Pragma'),
        });
        return HttpResponse.json({ items: [auditEvent()] });
      }),
    );

    const { result } = await settled();
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(observed).toHaveLength(2);
    });

    for (const request of observed) {
      expect.soft(request.cache).toBe('no-store');
      expect.soft(request.cacheControl).toContain('no-store');
      expect.soft(request.pragma).toBe('no-cache');
    }
  });
});

describe('filtering', () => {
  // AAP §0.5.1 category 2 (filtering), at the encoding level. INVARIANT LOCKED: the filter
  // the caller states is the filter the SERVER is asked for -- same fields, same names, same
  // order, correctly escaped -- and the hook owns a private copy of it.
  //
  // Both halves are load-bearing. A filter that did not reach the request would be applied
  // client-side, so a page boundary could hide events the operator asked to see; and a
  // filter held by reference would let a caller mutate the hook's state without a render,
  // leaving the returned `filter` describing one query while the issued request described
  // another. Neither failure looks like a failure -- both render as data (F-006-RQ-003).

  it('encodes every filter field, alphabetically after the pagination pair', async () => {
    const issued = respondWith({ items: [auditEvent()] });

    await settled({
      pageSize: 10,
      filter: {
        level: 'Request',
        namespace: SECRET_AUDIT_REQUEST_NAMESPACE,
        resource: 'secrets',
        verb: 'create',
      },
    });

    expect(issued[0]).toBe(
      `page=1&pageSize=10&level=Request&namespace=${SECRET_AUDIT_REQUEST_NAMESPACE}` +
        '&resource=secrets&verb=create',
    );
  });

  it('omits an empty filter field rather than sending a blank value', async () => {
    const issued = respondWith({ items: [auditEvent()] });

    await settled({ filter: { resource: '', verb: 'create' } });

    expect(issued[0]).not.toContain('resource=');
    expect(issued[0]).toContain('verb=create');
  });

  it('percent-encodes a value that needs it', async () => {
    const issued = respondWith({ items: [auditEvent()] });

    await settled({ filter: { resource: 'serviceaccounts/token' } });

    expect(issued[0]).toContain('resource=serviceaccounts%2Ftoken');
  });

  it('resets to page 1 when the filter changes', async () => {
    const issued = respondWith({ items: [auditEvent()], hasMore: true });

    const { result } = await settled({ pageSize: 1, page: 3 });
    expect(result.current.page).toBe(3);

    await act(async () => {
      result.current.setFilter({ resource: 'configmaps' });
    });

    await waitFor(() => {
      expect(result.current.page).toBe(1);
    });
    // Not a convenience: a new filter combined with a stale offset shows the wrong slice
    // of the wrong result set, and it looks like data rather than like an error.
    expect(issued.at(-1)).toContain('page=1');
    expect(issued.at(-1)).toContain('resource=configmaps');
  });

  it('clones the caller\'s filter, so mutating it afterwards cannot change the query', async () => {
    // Storing the caller's object by reference made the hook's state reachable from
    // outside it: a later `filter.resource = ...` changed state with no re-render, so the
    // issued request and the returned `filter` disagreed silently.
    const issued = respondWith({ items: [auditEvent()] });
    const mutable = { resource: 'secrets' };

    const { result } = await settled({ filter: mutable });
    const firstQuery = issued[0];

    mutable.resource = 'configmaps';

    expect(result.current.filter.resource).toBe('secrets');
    expect(firstQuery).toContain('resource=secrets');
    expect(issued).toHaveLength(1);
  });

  it('clones a filter passed to setFilter as well', async () => {
    const mutable = { resource: 'secrets' };

    const { result } = await settled();
    await act(async () => {
      result.current.setFilter(mutable);
    });
    await waitFor(() => {
      expect(result.current.filter.resource).toBe('secrets');
    });

    mutable.resource = 'configmaps';

    expect(result.current.filter.resource).toBe('secrets');
  });

  it('does not refetch when an equivalent inline filter object is passed on re-render', async () => {
    // The effect keys on the deterministic query STRING rather than on object identity, so
    // a caller passing an inline literal cannot drive a refetch loop.
    const issued = respondWith({ items: [auditEvent()] });
    const { result, rerender } = renderHook(
      ({ resource }: { resource: string }) => useAuditEvents({ filter: { resource } }),
      { initialProps: { resource: 'secrets' } },
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    const afterFirst = issued.length;

    rerender({ resource: 'secrets' });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(issued).toHaveLength(afterFirst);
  });
});

/**
 * One recorded filter dimension, with the number of recorded events it selects.
 *
 * `expected` is a LITERAL rather than a count computed from the fixture, and that is
 * deliberate. Deriving it from `ALL_OBSERVED_AUDIT_EVENTS` with the same predicate the
 * handler applies would make the case compare an expression against itself and pass for any
 * fixture whatsoever. Written out, the number is a claim about the RECORDED DATA -- so if
 * the recorded stream ever changes, these cases fail loudly and a human decides whether the
 * change was intended.
 */
interface RecordedFilterCase {
  /** The stable case id, used verbatim as the `it.each` title. */
  readonly id: string;
  /** The filter to apply. */
  readonly filter: Readonly<AuditEventFilter>;
  /** The query-string fragment the filter must produce. */
  readonly queryFragment: string;
  /** How many of the ten recorded events the filter selects. */
  readonly expected: number;
}

/**
 * The recorded filter dimensions, measured from `../test/fixtures/auditEvents`.
 *
 * The dimensions are the ones the V6 integration test exercises -- resource, verb and
 * namespace -- and the values are the recorded ones rather than invented ones. `clusterroles`
 * is included precisely BECAUSE the recorded stream contains none: §0.10.2 pins
 * `clusterroles` at exactly `RequestResponse`, so it is a resource an audit view must be
 * able to ask about, and asking about it is what proves that "nothing matched" is reported
 * as an empty result rather than as a failure.
 *
 * Composition of the ten recorded events, for anyone checking these numbers: four `secrets`
 * events in `secret-audit-request` (create, get, update, delete) and six RBAC events in
 * `rbac-audit-response` (three `roles`, three `rolebindings`, each create/update/delete).
 */
const RECORDED_FILTER_CASES: readonly RecordedFilterCase[] = [
  {
    id: 'resource=secrets',
    filter: { resource: 'secrets' },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.resource}=secrets`,
    expected: 4,
  },
  {
    id: 'resource=clusterroles',
    filter: { resource: 'clusterroles' },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.resource}=clusterroles`,
    expected: 0,
  },
  {
    id: 'verb=create',
    filter: { verb: 'create' },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.verb}=create`,
    expected: 3,
  },
  {
    id: 'verb=update',
    filter: { verb: 'update' },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.verb}=update`,
    expected: 3,
  },
  {
    id: 'verb=delete',
    filter: { verb: 'delete' },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.verb}=delete`,
    expected: 3,
  },
  {
    id: `namespace=${SECRET_AUDIT_REQUEST_NAMESPACE}`,
    filter: { namespace: SECRET_AUDIT_REQUEST_NAMESPACE },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.namespace}=${SECRET_AUDIT_REQUEST_NAMESPACE}`,
    expected: 4,
  },
  {
    id: `namespace=${RBAC_AUDIT_RESPONSE_NAMESPACE}`,
    filter: { namespace: RBAC_AUDIT_RESPONSE_NAMESPACE },
    queryFragment: `${AUDIT_EVENTS_QUERY_PARAMS.namespace}=${RBAC_AUDIT_RESPONSE_NAMESPACE}`,
    expected: 6,
  },
];

describe('filtering over the recorded dimensions', () => {
  // AAP §0.5.1 category 2 (filtering), parametrised over the dimensions the V6 integration
  // test exercises -- resource, verb and namespace -- against the RECORDED stream rather
  // than against hand-rolled events, so the wire shapes have exactly one definition site
  // (`../test/fixtures/auditEvents`).
  //
  // §0.4.1.2 translation in force here: the Go original drives its table with `t.Run`, which
  // becomes `it.each` with an explicit, stable id per case; and within a case the per-event
  // property check uses `expect.soft`, because the Go guard accumulates with `t.Errorf` and
  // reports every offending event rather than stopping at the first.

  it.each(RECORDED_FILTER_CASES)(
    'sends $id and surfaces only the events it matches',
    async ({ filter, queryFragment, expected }) => {
      const issued = serveRecorded();

      const { result } = await settled({ filter });

      // 1. The filter REACHED the request. A view that filtered client-side would look
      //    identical here while quietly fetching -- and, at a page boundary, hiding -- events
      //    the operator never asked to see (F-006-RQ-003).
      expect(issued).toHaveLength(1);
      expect(issued[0]).toContain(queryFragment);

      // 2. The page is a page, not a refusal. A hard expect, per §0.4.1.2: if the events
      //    never loaded there is nothing for the per-event checks below to say.
      expect(result.current.status).toBe('success');
      expect(result.current.error).toBeNull();
      expect(result.current.events).toHaveLength(expected);
      expect(result.current.total).toBe(expected);

      // 3. ONLY matching events are surfaced -- accumulated, so a page with several
      //    non-matching events names all of them in one run.
      for (const event of result.current.events) {
        if (filter.resource !== undefined) {
          expect
            .soft(event.objectRef?.resource, `F-006-RQ-003: event ${event.auditID} was surfaced under resource=${filter.resource} but is a ${String(event.objectRef?.resource)} event, so the view is reporting on events the operator did not ask about`)
            .toBe(filter.resource);
        }
        if (filter.verb !== undefined) {
          expect
            .soft(event.verb, `F-006-RQ-003: event ${event.auditID} was surfaced under verb=${filter.verb} but its verb is ${event.verb}`)
            .toBe(filter.verb);
        }
        if (filter.namespace !== undefined) {
          expect
            .soft(event.objectRef?.namespace, `F-006-RQ-003: event ${event.auditID} was surfaced under namespace=${filter.namespace} but belongs to ${String(event.objectRef?.namespace)}`)
            .toBe(filter.namespace);
        }
      }
    },
  );

  it('reports a filter that matches nothing as EMPTY, never as an error', async () => {
    // INVARIANT LOCKED: "nothing matched your filter" and "the query failed" are different
    // answers and must stay different. `clusterroles` is the recorded resource the stream
    // contains none of, so this is a genuine zero rather than a contrived one.
    serveRecorded();

    const { result } = await settled({ filter: { resource: 'clusterroles' } });

    expect(result.current.status).toBe('success');
    expect(result.current.events).toEqual([]);
    expect(result.current.isEmpty).toBe(true);
    expect(
      result.current.error,
      'F-006-RQ-003: a filter matching no recorded event must leave `error` null -- a ' +
        'view that reported an empty match as a failure would send an operator hunting a ' +
        'defect that does not exist',
    ).toBeNull();
    expect(result.current.total).toBe(0);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('resets to page 1 when the filter changes, so a stale offset cannot survive', async () => {
    // The recorded-data twin of the unit-level reset case above. Starting on page 2 of the
    // `secrets` slice and then switching to the RBAC namespace must not ask for page 2 of a
    // result set the operator has never seen: at four `secrets` events and two to a page,
    // page 2 exists; the RBAC slice has six, so page 2 exists there too and a surviving
    // offset would silently show its second page as though it were the first.
    const issued = serveRecorded();

    const { result } = await settled({
      page: 2,
      pageSize: 2,
      filter: { resource: 'secrets' },
    });
    expect(result.current.loadedPage).toBe(2);
    expect(issued[0]).toContain(`${AUDIT_EVENTS_QUERY_PARAMS.page}=2`);

    await act(async () => {
      result.current.setFilter({ namespace: RBAC_AUDIT_RESPONSE_NAMESPACE });
    });
    await waitFor(() => {
      expect(result.current.loadedPage).toBe(1);
    });

    expect(result.current.page).toBe(1);
    expect(issued.at(-1)).toContain(`${AUDIT_EVENTS_QUERY_PARAMS.page}=1`);
    expect(issued.at(-1)).toContain(
      `${AUDIT_EVENTS_QUERY_PARAMS.namespace}=${RBAC_AUDIT_RESPONSE_NAMESPACE}`,
    );
    expect(issued.at(-1)).not.toContain(AUDIT_EVENTS_QUERY_PARAMS.resource);
    // The first RBAC page, not the second: six matches, two to a page, so a further page
    // remains.
    expect(result.current.events).toHaveLength(2);
    expect(result.current.total).toBe(RBAC_RESPONSE_AUDIT_EVENTS.length);
    expect(result.current.hasNextPage).toBe(true);
    for (const event of result.current.events) {
      expect.soft(event.objectRef?.namespace).toBe(RBAC_AUDIT_RESPONSE_NAMESPACE);
    }
  });

  it('combines the recorded dimensions rather than widening to either', async () => {
    // Two dimensions at once. A view that OR-ed its filters would return more than asked
    // for, and one that dropped the second would return the wrong slice; both look like data.
    const issued = serveRecorded();

    const { result } = await settled({
      filter: { resource: 'secrets', verb: 'get' },
    });

    expect(issued[0]).toContain(`${AUDIT_EVENTS_QUERY_PARAMS.resource}=secrets`);
    expect(issued[0]).toContain(`${AUDIT_EVENTS_QUERY_PARAMS.verb}=get`);
    // Exactly the one recorded Secret READ -- the event the Go oracle logs but never
    // asserts, which is what makes the observed stream a genuine superset of the
    // expectations (F-006-RQ-002).
    expect(result.current.events).toHaveLength(SECRETS_REQUEST_UNASSERTED_AUDIT_EVENTS.length);
    expect(result.current.events[0]?.verb).toBe('get');
    expect(result.current.events[0]?.objectRef?.resource).toBe('secrets');
    expect(result.current.events[0]?.objectRef?.name).toBe(AUDIT_SECRET_NAME);
  });
});


describe('an empty result is a result, not a silence', () => {
  // AAP §0.5.1 category 3 (empty result). The invariant locked: an empty page is a
  // SUCCESSFUL answer that happened to match nothing, and it must be observably different
  // from all three of the other things that also render as "nothing to show" -- a query
  // still in flight, a query that was refused, and a query that has not run.
  //
  // §0.11.1's "no false passes" is what makes this a security property rather than a
  // presentation nicety. An audit panel that cannot tell an empty result from a refusal
  // will eventually report "no Secret event carries a response body" on the strength of a
  // 403, which is a clean bill of health with no evidence behind it (F-006-RQ-002).

  it('reports an empty recorded page as empty, with no error and no pagination', async () => {
    const issued = serveRecorded([]);

    const { result } = await settled();

    expect(issued).toHaveLength(1);
    expect(result.current.status).toBe('success');
    expect(result.current.events).toEqual([]);
    expect(
      result.current.isEmpty,
      'F-006-RQ-003: a successful query that matched nothing must set `isEmpty`, because ' +
        'that flag is the only thing a panel can distinguish an empty page by',
    ).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.total).toBe(0);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(false);
    // It genuinely LOADED, rather than never having asked: `loadedPage` is the difference
    // between "page 1 came back empty" and "no page has come back".
    expect(result.current.loadedPage).toBe(1);
  });

  it.each([
    ['loading', { enabled: true } as const],
    ['idle', { enabled: false } as const],
  ])('is distinguishable from the %s state', async (expectedStatus, options) => {
    // Gated so `loading` is a state the test can stand still in and inspect, rather than one
    // it has to catch as it goes past.
    const held = gate();
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, async () => {
        await held.passed;
        return HttpResponse.json({ items: [], total: 0, hasMore: false } as never);
      }),
    );

    const { result } = renderHook(() => useAuditEvents(options));

    expect(result.current.status).toBe(expectedStatus);
    expect(result.current.events).toEqual([]);
    // The shared symptom -- an empty list -- with the distinguishing flag NOT set. This is
    // the assertion that stops a panel keying off `events.length === 0`.
    expect(
      result.current.isEmpty,
      `F-006-RQ-003: the ${expectedStatus} state holds no events, but it is not an empty ` +
        'RESULT and must not be reported as one',
    ).toBe(false);
    expect(result.current.error).toBeNull();

    held.open();
    // Released so the worker leaves nothing in flight; the idle case never asked, so only
    // the loading case has a transition to await.
    if (expectedStatus === 'loading') {
      await waitFor(() => {
        expect(result.current.isEmpty).toBe(true);
      });
      // ...and having arrived, it now IS empty. The same hook, the same empty list, a
      // different verdict -- which is exactly the distinction being locked.
      expect(result.current.status).toBe('success');
    }
  });

  it.each([403, 500])(
    'is distinguishable from an HTTP %i refusal, which holds no verdict at all',
    async (status) => {
      serveRefusal(status);

      const { result } = await settled();

      expect(result.current.status).toBe('error');
      expect(result.current.events).toEqual([]);
      expect(
        result.current.isEmpty,
        `F-006-RQ-002: HTTP ${String(status)} left the event list empty, and reporting that ` +
          'as an empty RESULT would assert that no Secret audit event carries a response ' +
          'body on the strength of a request the server never answered',
      ).toBe(false);
      expect(result.current.error?.httpStatus).toBe(status);
    },
  );

  it('carries no message of its own when the page is legitimately empty', async () => {
    // A spurious message is how an empty result becomes an error in the reader's mind: a
    // panel that renders `error.message` whenever it is truthy would show text here.
    serveRecorded([]);

    const { result } = await settled();

    expect(result.current.error).toBeNull();
    expect(result.current.error?.message).toBeUndefined();
  });

  it('returns to a genuinely empty page after a refusal, without stale events', async () => {
    // The transition matters as much as the two states: a hook that kept the refused
    // request's state would report the retry's honest zero as a continuing failure, and one
    // that kept a previous page's events would report them under an empty result.
    let attempt = 0;
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json(
              {
                kind: 'Status',
                apiVersion: 'v1',
                status: 'Failure',
                code: 403,
                reason: 'Forbidden',
                message: 'events.audit.k8s.io is forbidden',
              } as never,
              { status: 403 },
            )
          : HttpResponse.json({ items: [], total: 0, hasMore: false } as never);
      }),
    );

    const { result } = await settled();
    expect(result.current.status).toBe('error');
    expect(result.current.isEmpty).toBe(false);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.isEmpty).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.events).toEqual([]);
  });
});

describe('the recorded bodies are surfaced verbatim, so the guard stays assertable', () => {
  // AAP §0.10.2's confidentiality-guard row, mirrored at the data-access layer. THIS IS THE
  // REASON THIS FILE EXISTS BEYOND ITS THREE MANDATED CATEGORIES.
  //
  // The guard downstream -- web/src/components/ConfidentialityRedaction.test.tsx -- asserts
  // that no `secrets` audit event renders a `responseObject`. That assertion is only
  // meaningful while the payload actually REACHES the presentation layer. A hook that
  // helpfully deleted `responseObject` would leave every redaction spec green while proving
  // nothing whatsoever, because there would be nothing left to redact. So the property
  // locked here is pass-through, not redaction: `requestObject` and `responseObject` arrive
  // exactly as the server sent them.
  //
  // §0.4.1.2 translation in force: the Go guard at
  // test/integration/controlplane/audit/audit_test.go L1043-1047 uses `t.Errorf` and scans
  // EVERY observed event -- a deliberate superset of the expectations, so that a regression
  // is caught even if the expected-events table were edited to match. Its React counterpart
  // therefore iterates every returned event with `expect.soft`, reporting all offenders in
  // one run, and uses a hard `expect` only for the precondition that the events loaded.
  //
  // WHAT "EXACTLY AS THE API SERVER RECORDED IT" MEANS BELOW, since the phrase is only as
  // good as the fixture behind it. The six RBAC `responseObject` bodies in
  // ../test/fixtures/auditEvents are CAPTURED output: a real kube-apiserver built from this
  // tree, under an audit policy holding RBAC at `RequestResponse`, replaying the six measured
  // operations -- see AUDIT_RBAC_RESPONSE_CAPTURE there for the method. They previously held a
  // test-only presence marker inside that wire field, which made this assertion's wording a
  // claim about data no server had produced. Nothing about the pass-through property changed;
  // what changed is that the thing being passed through is now wire data.

  it('hands back every recorded event, with both bodies untouched', async () => {
    serveRecorded();

    const { result } = await settled({ pageSize: ALL_OBSERVED_AUDIT_EVENTS.length });

    // HARD expect: the precondition. If the page did not load there is nothing below to say,
    // and a soft assertion here would let the whole guard report success on an empty list.
    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(ALL_OBSERVED_AUDIT_EVENTS.length);

    // Identity, member by member, against the recorded source. `toEqual` on the whole array
    // would also pass for a hook that rebuilt each event field by field and dropped an
    // unknown one, so the two payload members are named explicitly.
    result.current.events.forEach((event, index) => {
      const recorded = ALL_OBSERVED_AUDIT_EVENTS[index];
      expect
        .soft(event.auditID, `F-006-RQ-002: event ${String(index)} is out of recorded order`)
        .toBe(recorded?.auditID);
      expect
        .soft(
          event.requestObject,
          `F-006-RQ-002: the requestObject of event ${event.auditID} was altered in transit; ` +
            'the audited request body must arrive exactly as the API server recorded it',
        )
        .toEqual(recorded?.requestObject);
      expect
        .soft(
          event.responseObject,
          `F-006-RQ-002: the responseObject of event ${event.auditID} was altered in transit. ` +
            'Stripping it here would make the confidentiality guard unassertable downstream: ' +
            'every redaction spec would pass while there was nothing left to redact',
        )
        .toEqual(recorded?.responseObject);
    });
  });

  it('preserves the responseObject of the NON-secrets events that legitimately carry one', async () => {
    // The control group required by AAP §0.5.2.5. Without at least one event that DOES carry
    // a response body, a component that blanket-hid every response body would satisfy the
    // redaction test -- a different, and wrong, behaviour. The recorded RBAC events are that
    // group: `roles` and `rolebindings` are audited at `RequestResponse` because they carry
    // no secret material, so their bodies are supposed to survive.
    serveRecorded();

    const { result } = await settled({ pageSize: ALL_OBSERVED_AUDIT_EVENTS.length });

    expect(result.current.status).toBe('success');
    const carryingResponseBody = result.current.events.filter(
      (event) => event.responseObject !== undefined,
    );
    expect(
      carryingResponseBody,
      'F-006-RQ-002: the recorded stream must still contain the non-secrets events that ' +
        'carry a response body, or the redaction guard has no control group and a ' +
        'blanket-hiding component would pass',
    ).toHaveLength(RBAC_RESPONSE_AUDIT_EVENTS.length);

    for (const event of carryingResponseBody) {
      expect
        .soft(
          event.objectRef?.resource,
          `F-006-RQ-002: event ${event.auditID} carries a responseObject, so it must NOT be a ` +
            'secrets event -- a secrets event at RequestResponse is the exact regression V6 closed',
        )
        .not.toBe('secrets');
      expect.soft(event.level).toBe('RequestResponse');
      expect
        .soft(typeof event.responseObject, `F-006-RQ-002: event ${event.auditID} lost its object shape`)
        .toBe('object');
    }
  });

  it('accepts a requestObject on a recorded secrets create and update as CORRECT', async () => {
    // THE EXPLICITLY ACCEPTED TRADE-OFF, recorded at audit_test.go L1040-1042: `secrets` sit
    // at `Request`, so the audited REQUEST body survives on a create and an update while the
    // RESPONSE body never does. Asserted positively, because "tightening" the guard into
    // failing on a `requestObject` would break a control that is passing today -- weakening
    // by over-correction, which §0.11.1 forbids just as firmly as weakening by relaxation.
    serveRecorded(SECRETS_REQUEST_AUDIT_EVENTS);

    const { result } = await settled({ pageSize: SECRETS_REQUEST_AUDIT_EVENTS.length });

    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(SECRETS_REQUEST_AUDIT_EVENTS.length);

    for (const event of result.current.events) {
      expect.soft(event.objectRef?.resource).toBe('secrets');
      expect.soft(event.level).toBe('Request');
      expect
        .soft(
          event.requestObject,
          `F-006-RQ-002: the requestObject of the recorded ${event.verb} on a Secret is the ` +
            'accepted Request-over-RequestResponse trade-off and must be present, not treated ' +
            'as a violation',
        )
        .toBeDefined();
      expect
        .soft(
          event.responseObject,
          `F-006-RQ-002: the recorded ${event.verb} on a Secret must carry NO responseObject; ` +
            'one appearing here means the audit level regressed to RequestResponse and Secret ' +
            'response bodies are being written to the audit log',
        )
        .toBeUndefined();
    }
  });

  it('scans the whole page and finds no secrets event carrying a responseObject', async () => {
    // The Go guard's exact shape, at audit_test.go L1043-1047:
    //   if e.Resource == "secrets" && e.ResponseObject { t.Errorf(...) }
    // over `missingReport.AllEvents` -- every observed event, not only the expected ones.
    // Accumulating, so a page with several offenders names all of them in one run.
    serveRecorded();

    const { result } = await settled({ pageSize: ALL_OBSERVED_AUDIT_EVENTS.length });

    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(ALL_OBSERVED_AUDIT_EVENTS.length);

    for (const event of result.current.events) {
      const isSecretsEvent = event.objectRef?.resource === 'secrets';
      expect
        .soft(
          isSecretsEvent && event.responseObject !== undefined,
          `F-006-RQ-002: audit event ${event.auditID} (${event.verb} ${event.requestURI}) is a ` +
            'secrets event carrying a responseObject; secrets are audited at exactly Request ' +
            'and must never record a response body',
        )
        .toBe(false);
    }
  });

  it('would surface a violating secrets event rather than hide it', async () => {
    // The guard's own positive control, and the answer to "could that assertion ever fail?".
    // `../test/fixtures/auditEvents` deliberately ships no violating event -- that is the
    // failure state, not recorded data -- so the negative example is built here from the
    // recorded create, exactly as the fixture module's own note prescribes.
    //
    // If the hook stripped `responseObject`, or dropped an event it found suspicious, this
    // case would go green while asserting nothing. It is what proves the previous case is
    // capable of failing.
    const [recordedCreate] = secretsRequestAuditEvents(SECRET_AUDIT_REQUEST_NAMESPACE);
    expect(recordedCreate).toBeDefined();
    const violating: AuditEvent = {
      ...(recordedCreate as AuditEvent),
      level: 'RequestResponse',
      // Obviously synthetic, and deliberately carrying nothing that resembles key material:
      // §0.11.1's "no secrets, ever" applies with extra force to a body that stands in for a
      // Secret's own.
      responseObject: { kind: 'Secret', apiVersion: 'v1', data: {} },
    };
    serveRecorded([violating]);

    const { result } = await settled();

    expect(result.current.status).toBe('success');
    expect(result.current.events).toHaveLength(1);
    const [surfaced] = result.current.events;
    expect(surfaced?.objectRef?.resource).toBe('secrets');
    expect(
      surfaced?.responseObject,
      'F-006-RQ-002: a violating secrets event must reach the presentation layer intact. A ' +
        'hook that dropped or blanked it would silence the very disclosure the guard exists ' +
        'to find, and every downstream redaction spec would pass vacuously',
    ).toEqual({ kind: 'Secret', apiVersion: 'v1', data: {} });
    // ...and the guard, run over that page, finds it. Stated as an expectation so the
    // detection itself is asserted rather than assumed.
    const offenders = result.current.events.filter(
      (event) => event.objectRef?.resource === 'secrets' && event.responseObject !== undefined,
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.auditID).toBe(recordedCreate?.auditID);
  });
});


describe('immutability of the returned data', () => {
  // INVARIANT LOCKED: the returned page and filter are frozen at RUNTIME, not merely typed
  // `readonly`. The confidentiality guard reads the event list to decide whether a Secret
  // body was disclosed, so a consumer that sorted it in place or spliced an event out of it
  // would change the evidence a later assertion examines -- and `readonly` alone is erased
  // at compile time, so a single cast would be enough to do it (F-006-RQ-002).

  it('returns a frozen event list', async () => {
    respondWith({ items: [auditEvent()] });

    const { result } = await settled();

    // The confidentiality guard reads this list to decide whether a Secret body was
    // disclosed. A consumer that sorted it in place, or spliced an event out of it, would
    // change the evidence a later assertion examines.
    expect(Object.isFrozen(result.current.events)).toBe(true);
  });

  it('returns a frozen filter', async () => {
    const { result } = await settled({ filter: { resource: 'secrets' } });

    expect(Object.isFrozen(result.current.filter)).toBe(true);
  });

  it('rejects a mutation attempt on the returned event list', async () => {
    respondWith({ items: [auditEvent()] });

    const { result } = await settled();
    const events = result.current.events as AuditEvent[];

    expect(() => events.push(auditEvent() as unknown as AuditEvent)).toThrow(TypeError);
    expect(result.current.events).toHaveLength(1);
  });
});

describe('refresh', () => {
  // INVARIANT LOCKED: refresh re-asks the SAME question and can recover from a refusal, and
  // a request abandoned by unmounting is a cancellation rather than a failure.
  //
  // Re-asking the same question matters because a refresh that quietly changed page or filter
  // would report on a different result set than the one on screen; recovering from a refusal
  // matters because a panel stuck in its error state after a transient 503 would never
  // observe the audit stream again (F-006-RQ-003).

  it('re-issues the same query', async () => {
    const issued = respondWith({ items: [auditEvent()] });

    const { result } = await settled({ filter: { resource: 'secrets' } });
    expect(issued).toHaveLength(1);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(issued).toHaveLength(2);
    });

    expect(issued[1]).toBe(issued[0]);
  });

  it('recovers from an error state', async () => {
    let attempt = 0;
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json({ kind: 'Status', code: 503 } as never, { status: 503 })
          : HttpResponse.json({ items: [auditEvent()] } as never);
      }),
    );

    const { result } = await settled();
    expect(result.current.status).toBe('error');

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.events).toHaveLength(1);
  });

  it('aborts the in-flight request when the consumer unmounts, and reports no error', async () => {
    // THE ABORT ITSELF IS THE ASSERTION, NOT ITS CONSEQUENCE. Unmounting alone prevents any
    // further render, so `result.current` stays on its last loading value whether the hook
    // aborts or not -- which means a spec built only on "no error state appeared" passes
    // just as happily with the hook's `controller.abort()` deleted. That was MEASURED: with
    // the abort neutralised, the state assertions below still held. What cannot hold without
    // it is the signal: the object the hook handed to `fetch` is the object it aborts, so
    // `signal.aborted` and the platform reason on it are the cancellation, observed directly.
    //
    // WHY NOT `request.signal` INSIDE THE MSW HANDLER. Measured under the pinned msw 2.15.0
    // Node interception: a client abort never reaches a handler that is awaiting, so a test
    // waiting on that event waits out the 10s testTimeout and proves nothing. Recording the
    // signal at the `fetch` boundary is the same fact, observed where it is observable, and
    // it is exactly what the sibling `useControlStatus` spec does.
    //
    // GATED, NOT TIMED. Holding the response open for a fixed number of milliseconds and
    // then sleeping slightly longer, hoping the order comes out right, is decided by the
    // machine rather than by the test; the order is stated outright here instead, so the
    // property is proven with no clock in the experiment at all.
    const held = gate();
    let answered = false;
    const observedStatuses: string[] = [];
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, async () => {
        await held.passed;
        answered = true;
        return HttpResponse.json({ items: [auditEvent()] } as never);
      }),
    );

    const { result, unmount } = renderHook(() => useAuditEvents());
    expect(result.current.status).toBe('loading');
    observedStatuses.push(result.current.status);
    expect(observedSignals, 'exactly one request must have been issued').toHaveLength(1);
    const signal = observedSignals[0];
    expect(
      signal?.aborted,
      'the request must still be in flight before unmounting: an assertion about the abort ' +
        'is worthless if the signal was already aborted when it was recorded',
    ).toBe(false);

    unmount();

    // SYNCHRONOUSLY after unmount, because the effect's cleanup runs there: this is the
    // cancellation itself, and it is falsified by removing the hook's `controller.abort()`.
    expect(
      signal?.aborted,
      'F-006-RQ-003: unmounting must ABORT the in-flight audit request. Without it the ' +
        'response lands on a hook that no longer exists, React logs an update-after-unmount ' +
        'error, and the request keeps a connection open for a panel nobody is looking at',
    ).toBe(true);
    expect(
      abortReasonName(signal?.reason),
      'the abort reason must be the platform AbortError, which is the condition the ' +
        "hook's own isAbortError keys on -- asserted by NAME, never by message text, " +
        'which is implementation-defined and localisable',
    ).toBe('AbortError');

    // Released only AFTER the unmount, so the response provably arrives at a hook that no
    // longer exists -- which is the situation under test rather than an approximation of it.
    held.open();
    await waitFor(() => {
      expect(answered).toBe(true);
    });

    // The consequences, asserted second and labelled as consequences: an abort is a
    // cancellation, not a failure, so the unmounted hook must not have been driven into an
    // error state and no stale page may be left behind.
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.events).toEqual([]);
    expect(observedStatuses).toEqual(['loading']);
    expect(
      observedConsoleErrors,
      `no update may land on an unmounted consumer; console.error recorded: ${observedConsoleErrors.join(' | ')}`,
    ).toEqual([]);
  });
});

describe('resolveAuditResourceIdentity — one validated identity, with uncertainty as an answer', () => {
  // The model the panels consume instead of `event.objectRef?.resource === 'secrets'`.
  // That expression had two outcomes, so "not a Secret" and "I cannot tell" produced the
  // same answer — and the second is the dangerous one. Uncertainty is modelled here so
  // every consumer can fail CLOSED on it.

  /** A well-formed Secret event, as a typed value rather than a wire record. */
  function secretsEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
    return { ...(auditEvent() as unknown as AuditEvent), ...overrides };
  }

  it('resolves a recorded Secret event from its objectRef', () => {
    const identity = resolveAuditResourceIdentity(secretsEvent());

    expect(identity).toEqual({
      kind: 'resource',
      resource: 'secrets',
      namespace: 'secret-audit-request',
      source: 'objectRef',
    });
    expect(isConfidentialAuditIdentity(identity)).toBe(true);
  });

  it('resolves a non-resource request as non-resource, not as uncertain', () => {
    const identity = resolveAuditResourceIdentity(
      secretsEvent({ objectRef: undefined, requestURI: '/healthz' }),
    );

    expect(identity.kind).toBe('non-resource');
    expect(isConfidentialAuditIdentity(identity)).toBe(false);
  });

  it('resolves a Secret path with NO objectRef from the requestURI, so it stays sensitive', () => {
    // Fail-closed in the useful direction: the identity is knowable, just from the other
    // field, so it is resolved rather than reported uncertain.
    const identity = resolveAuditResourceIdentity(
      secretsEvent({
        objectRef: undefined,
        requestURI: '/api/v1/namespaces/secret-audit-request/secrets/audited',
      }),
    );

    expect(identity).toMatchObject({ kind: 'resource', resource: 'secrets', source: 'requestURI' });
    expect(isConfidentialAuditIdentity(identity)).toBe(true);
  });

  it.each([
    ['an empty objectRef', {} as AuditEvent['objectRef']],
    ['a non-string resource', { resource: 7 } as unknown as AuditEvent['objectRef']],
    ['an empty resource', { resource: '' } as AuditEvent['objectRef']],
  ])('reports %s as UNCERTAIN and therefore confidential', (_label, objectRef) => {
    // The exact shape that reached the non-sensitive branch before this fix.
    const identity = resolveAuditResourceIdentity(secretsEvent({ objectRef }));

    expect(identity.kind).toBe('uncertain');
    expect(isConfidentialAuditIdentity(identity)).toBe(true);
  });

  it('reports a non-object objectRef as uncertain', () => {
    const identity = resolveAuditResourceIdentity(
      secretsEvent({ objectRef: 'secrets' as unknown as AuditEvent['objectRef'] }),
    );

    expect(identity.kind).toBe('uncertain');
    expect(isConfidentialAuditIdentity(identity)).toBe(true);
  });

  it('reports a URI/objectRef contradiction as uncertain, whichever way it points', () => {
    // Both directions, because the danger is symmetric: a Secret URI with a ConfigMap
    // objectRef would smuggle a Secret body out, and a ConfigMap URI with a Secret
    // objectRef would misattribute somebody else's body to Secrets.
    const secretUriConfigMapRef = resolveAuditResourceIdentity(
      secretsEvent({
        requestURI: '/api/v1/namespaces/secret-audit-request/secrets/audited',
        objectRef: { resource: 'configmaps', namespace: 'secret-audit-request' },
      }),
    );
    const configMapUriSecretRef = resolveAuditResourceIdentity(
      secretsEvent({
        requestURI: '/api/v1/namespaces/secret-audit-request/configmaps/audited',
        objectRef: { resource: 'secrets', namespace: 'secret-audit-request' },
      }),
    );

    expect(secretUriConfigMapRef.kind).toBe('uncertain');
    expect(configMapUriSecretRef.kind).toBe('uncertain');
    expect(isConfidentialAuditIdentity(secretUriConfigMapRef)).toBe(true);
    expect(isConfidentialAuditIdentity(configMapUriSecretRef)).toBe(true);
  });

  it('carries the subresource through when both halves agree', () => {
    const identity = resolveAuditResourceIdentity(
      secretsEvent({
        requestURI: '/api/v1/namespaces/ns/serviceaccounts/sa/token',
        objectRef: { resource: 'serviceaccounts', namespace: 'ns', subresource: 'token' },
      }),
    );

    expect(identity).toEqual({
      kind: 'resource',
      resource: 'serviceaccounts',
      namespace: 'ns',
      subresource: 'token',
      source: 'objectRef',
    });
    expect(isConfidentialAuditIdentity(identity)).toBe(false);
  });

  it('does not treat a non-Secret resource as confidential', () => {
    const identity = resolveAuditResourceIdentity(
      secretsEvent({
        requestURI: '/apis/rbac.authorization.k8s.io/v1/namespaces/rbac-audit-response/roles/r',
        objectRef: { resource: 'roles', namespace: 'rbac-audit-response' },
      }),
    );

    expect(isConfidentialAuditIdentity(identity)).toBe(false);
  });

  it('treats a missing requestURI as a non-resource path rather than throwing', () => {
    // Totality: the model must answer for every input, including one no server would
    // send, because a controlled-mode caller can construct anything.
    const identity = resolveAuditResourceIdentity(
      secretsEvent({ requestURI: undefined as unknown as string, objectRef: undefined }),
    );

    expect(identity).toEqual({ kind: 'non-resource', requestURI: '' });
  });

  it('resolves a Namespace object path without inventing a namespace scope', () => {
    const identity = resolveAuditResourceIdentity(
      secretsEvent({
        requestURI: '/api/v1/namespaces/psa-enforce-baseline',
        objectRef: { resource: 'namespaces', name: 'psa-enforce-baseline' },
      }),
    );

    expect(identity).toMatchObject({ kind: 'resource', resource: 'namespaces' });
  });
});

// ---------------------------------------------------------------------------
// The elapsed request deadline (finding 1) and the error model (finding B).
// ---------------------------------------------------------------------------

describe('a request that is never answered ends at its deadline', () => {
  /**
   * THE GAP THIS GROUP CLOSES. Every other failure case here settles: the server
   * refuses, or sends an unreadable body, or the transport fails. None covers the
   * one an `AbortController` structurally cannot see -- a server that ACCEPTS the
   * connection and never answers. `fetch` has no default timeout, so this hook
   * stayed in `loading` for as long as the tab was open, and for a confidentiality
   * surface that is the worst outcome available: it neither lists events nor says
   * it could not read them, so "no response bodies were observed" becomes
   * indistinguishable from "nothing was ever checked".
   *
   * The clock is CONTROLLED rather than waited on. 30 real seconds would exceed the
   * suite's `testTimeout`; `toFake` is limited to the timer functions so promises,
   * `Date` and msw's own async machinery stay on the real clock.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A handler that receives the request and never answers it. */
  function installNeverAnsweringHandler(): () => void {
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, async () => {
        await released;
        return HttpResponse.json({ items: [] });
      }),
    );
    return () => {
      release();
    };
  }

  it('reports a timeout carrying no http status', async () => {
    const release = installNeverAnsweringHandler();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const { result } = renderHook(() => useAuditEvents());
    expect(result.current.isLoading, 'the request is in flight before the deadline').toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(AUDIT_EVENTS_REQUEST_TIMEOUT_MS);
    });

    expect(result.current.status, 'the deadline must resolve the loading state').toBe('error');
    expect.soft(result.current.error?.kind, 'a deadline is its own kind of failure').toBe('timeout');
    expect
      .soft(result.current.error?.httpStatus, 'nothing answered, so no status may be reported')
      .toBeUndefined();
    expect
      .soft(
        result.current.isEmpty,
        'F-006-RQ-002: an unanswered request is not an empty page of audit events',
      )
      .toBe(false);
    expect
      .soft(result.current.events, 'a timed-out read yields no events to inspect')
      .toEqual([]);

    release();
  });

  it('does not fire the deadline for a request answered in time', async () => {
    // CONTROL: a deadline hard-wired to fire would satisfy the case above and still
    // be wrong. `waitFor` is avoided because it polls on the faked timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const { result } = renderHook(() => useAuditEvents());
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(AUDIT_EVENTS_REQUEST_TIMEOUT_MS * 10);
    });

    expect(
      result.current.error?.kind,
      'a cleared deadline cannot turn a settled request into a timeout',
    ).not.toBe('timeout');
  });

  it('treats an unmount before the deadline as no failure at all', async () => {
    // INVARIANT LOCKED: unmounting is NOT a timeout. Both end the request without a
    // response and both abort the same controller, so only the flag the deadline
    // sets before aborting separates them. Conflated, either every unmount reports a
    // spurious failure or every timeout is silently swallowed - and the swallowed
    // case is the bug this group exists to prevent.
    const release = installNeverAnsweringHandler();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const { result, unmount } = renderHook(() => useAuditEvents());
    expect(result.current.isLoading).toBe(true);
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(AUDIT_EVENTS_REQUEST_TIMEOUT_MS * 2);
    });

    expect(
      result.current.error,
      'an unmounted consumer receives no committed failure, timeout or otherwise',
    ).toBeNull();

    release();
  });
});

describe('a Status body code is accepted only as a real http status', () => {
  /**
   * WHY THIS IS VALIDATION AND NOT DECORATION. `code` comes out of a response body,
   * which is data the client does not control. The predicate was
   * `Number.isFinite`, which admits every one of the values below, so a body
   * claiming `"code": 0` or `"code": 1.5` reached consumers as though a server had
   * chosen it -- and `code` is rendered. An integer inside the HTTP range is the
   * only shape the field can legitimately hold.
   */
  function respondWithCode(code: unknown): void {
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, () =>
        HttpResponse.json({ code, reason: 'Forbidden', message: 'refused' }, { status: 403 }),
      ),
    );
  }

  it.each([
    { label: 'zero', code: 0 },
    { label: 'negative', code: -1 },
    { label: 'a fraction', code: 403.5 },
    { label: 'below the http range', code: MIN_HTTP_STATUS_CODE - 1 },
    { label: 'above the http range', code: MAX_HTTP_STATUS_CODE + 1 },
    { label: 'absurdly large', code: 1e9 },
    { label: 'a string', code: '403' },
    { label: 'null', code: null },
    { label: 'NaN serialised as null', code: Number.NaN },
  ])('discards $label', async ({ code }) => {
    respondWithCode(code);

    const { result } = await settled();

    expect(result.current.status, 'a 403 is still an error whatever the body claims').toBe('error');
    expect
      .soft(result.current.error?.code, 'a body code outside the http range is not reported at all')
      .toBeUndefined();
    // The REAL status still reaches the consumer: rejecting the body's claim must
    // not cost the transport-level fact, which is what tells a refusal from a bug.
    expect
      .soft(result.current.error?.httpStatus, 'the response status is preserved verbatim')
      .toBe(403);
    expect.soft(result.current.error?.kind, 'a non-2xx response is an http failure').toBe('http');
  });

  it.each([
    { label: 'the lowest valid status', code: MIN_HTTP_STATUS_CODE },
    { label: 'a Forbidden that agrees with the response', code: 403 },
    { label: 'a code that disagrees with the response', code: 500 },
    { label: 'the highest valid status', code: MAX_HTTP_STATUS_CODE },
  ])('preserves $label', async ({ code }) => {
    // CONTROL, and the disagreeing case is the point of keeping `code` separate at
    // all: `code` and the response status are distinct fields on the wire and a
    // server may set them differently, so a valid code is carried through even when
    // it contradicts the status rather than being normalised away.
    respondWithCode(code);

    const { result } = await settled();

    expect(result.current.error?.code, 'a valid http status in the body is reported').toBe(code);
    expect(result.current.error?.httpStatus, 'and never overwrites the real status').toBe(403);
  });
});
