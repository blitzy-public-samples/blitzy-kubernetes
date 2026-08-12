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

// AAP §0.5.1 (web/src/hooks/useAuditEvents.test.ts row -- the spec this module
// serves) / §0.4.2.4 (React blueprint L6/L7, including the
// ConfidentialityRedaction mirror of the V6 guard) / §0.7.1.3 (>= 80% line and
// branch floor for the React tier under the rewritten AST-aware V8 provider) /
// §0.4.6 and §0.9.1.2 (Vitest 4 requires an explicit `coverage.include`;
// `coverage.all` was removed and the `basic` reporter no longer exists) /
// tech-spec §6.6.3.4 (documentation convention: provenance citation plus a
// function-level comment naming the invariant locked).
//
// Requirements locked by this module: F-006-RQ-002 (sensitive-resource audit
// event emission and level projection) and F-006-RQ-003 (audit fidelity
// defaults). This is the single definition site for `AuditEvent`; there is
// deliberately no `types.ts` and no barrel file, so every consumer -- the
// recorded fixtures in web/src/test/fixtures/auditEvents.ts, the MSW handlers
// in web/src/test/msw/handlers.ts, AuditFidelityPanel and
// ConfidentialityRedaction -- imports the type from here.
//
// Wire-shape provenance: every field below is traced to the projection in
// test/utils/audit.go (`testEventFromInternalFiltered`, L136-182) and to the
// V6 integration guard in test/integration/controlplane/audit/audit_test.go
// (L1004-1047). Nothing here is imagined.

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The four audit levels of the `audit.k8s.io/v1` API, spelled exactly as they
 * appear on the wire.
 *
 * These are the only four levels; none is invented. The ordering that matters
 * is documented by {@link AUDIT_LEVEL_ORDER} rather than by this union, because
 * a union is unordered.
 */
export type AuditLevel = 'None' | 'Metadata' | 'Request' | 'RequestResponse';

/**
 * The audit levels in their strict ascending order of verbosity:
 * `None < Metadata < Request < RequestResponse`.
 *
 * This constant exists to make that ordering expressible in the presentation
 * layer without re-deriving it. It is load-bearing for F-006-RQ-002: `secrets`
 * and `serviceaccounts/token` sit at exactly `Request`, and a regression that
 * silently promoted them to `RequestResponse` would begin writing Secret
 * payloads into the audit log. Index order is the invariant -- do not reorder.
 */
export const AUDIT_LEVEL_ORDER: readonly AuditLevel[] = [
  'None',
  'Metadata',
  'Request',
  'RequestResponse',
];

/**
 * The audit stages of the `audit.k8s.io/v1` API, spelled exactly as they appear
 * on the wire. The V6 expectations are all recorded at `ResponseComplete`.
 */
export type AuditStage =
  | 'RequestReceived'
  | 'ResponseStarted'
  | 'ResponseComplete'
  | 'Panic';

/**
 * The annotation key carrying the authorizer's verdict.
 *
 * `test/utils/audit.go` L162 reads exactly this key out of the event's single
 * `annotations` map to populate its flat `AuthorizeDecision` field. The wire
 * has no dedicated field for it, so consumers must index the map. The V6
 * expectations record the value `"allow"`.
 */
export const AUTHORIZATION_DECISION_ANNOTATION = 'authorization.k8s.io/decision';

/**
 * The subject of an audit event, used for both `user` and `impersonatedUser`.
 *
 * `groups` is an **array**. `test/utils/audit.go` L159-160 sorts it and joins it
 * with commas into a single string, but that is a Go-side convenience for
 * struct comparison only -- the wire carries the array, and this type models
 * the wire.
 */
export interface AuditUserInfo {
  /** The authenticated (or impersonated) principal, e.g. a service account name. */
  username: string;
  /** Opaque identifier for the principal, when the authenticator supplies one. */
  uid?: string;
  /** Group memberships, unsorted on the wire. */
  groups?: string[];
  /** Additional authenticator-supplied attributes, each a list of values. */
  extra?: Record<string, string[]>;
}

/**
 * The object an audit event refers to.
 *
 * Optional as a whole: `test/utils/audit.go` L144-147 guards the entire
 * projection with `if e.ObjectRef != nil`, because non-resource requests carry
 * no object reference. That is why redaction logic keys off
 * `event.objectRef?.resource === 'secrets'` rather than assuming presence.
 */
export interface AuditObjectReference {
  /** Plural resource name, e.g. `"secrets"`, `"configmaps"`, `"clusterroles"`. */
  resource: string;
  /** Absent for cluster-scoped objects. */
  namespace?: string;
  /** Absent on collection requests such as list and create-by-generateName. */
  name?: string;
  uid?: string;
  /** Empty string for the core API group. */
  apiGroup?: string;
  apiVersion?: string;
  resourceVersion?: string;
  /** e.g. `"token"` for the `serviceaccounts/token` selector. */
  subresource?: string;
}

/**
 * The response status recorded on an audit event -- a Kubernetes `Status`.
 *
 * Optional as a whole: `test/utils/audit.go` L148-150 guards it with
 * `if e.ResponseStatus != nil`. The V6 expectations record `code` 201 for the
 * Secret create and 200 for the update and delete.
 */
export interface AuditResponseStatus {
  /** The HTTP status code of the audited request. */
  code: number;
  /** `"Success"` or `"Failure"`. */
  status?: string;
  /** Machine-readable cause, e.g. `"Forbidden"`. */
  reason?: string;
  /** Human-readable explanation. */
  message?: string;
}

/**
 * An opaque audited request or response body.
 *
 * **This is an object, never a boolean, and that distinction is the single most
 * important property of this module.** `test/utils/audit.go` L151-156 does
 * `if e.ResponseObject != nil { event.ResponseObject = true }`, flattening the
 * payload to a presence flag so its Go test structs compare cheaply. That
 * flattening is a Go-test detail and must not leak here: the wire carries the
 * payload, and the presentation layer needs to distinguish "absent" from
 * "present but must not be rendered".
 *
 * Typed as a read-only record of unknown values so a component can test for
 * presence and safely refuse to render the contents without ever being able to
 * accidentally interpolate them into markup.
 */
export type AuditPayload = Readonly<Record<string, unknown>>;

/**
 * A single `audit.k8s.io/v1` audit event, modelled as it appears on the wire.
 *
 * Invariant locked: this models the **wire** event, where `requestObject` and
 * `responseObject` are objects. `test/utils/audit.go` flattens them to presence
 * booleans for Go-side comparison, and that flattening must not leak into this
 * type -- if it did, the confidentiality guard would become inexpressible in
 * the React tier while every spec stayed green.
 *
 * The guard being preserved (F-006-RQ-002, mirrored from
 * test/integration/controlplane/audit/audit_test.go L1043-1047): no audit event
 * whose `objectRef.resource` is `"secrets"` may carry a `responseObject`,
 * because `secrets` are audited at exactly `Request` and never at
 * `RequestResponse`. A `requestObject` surviving on create and update is the
 * explicitly accepted trade-off recorded at L1040-1042, not a defect.
 *
 * Field names are the JSON/camelCase wire names, not the Go PascalCase struct
 * names. Every optional field is optional because the Go projection guards it
 * with a nil check.
 */
export interface AuditEvent {
  /** Always `"audit.k8s.io/v1"` for this tier; the audit group is version-pinned. */
  apiVersion: 'audit.k8s.io/v1';
  /** Always `"Event"`. */
  kind: 'Event';
  /** Unique identifier for the audited request, stable across its stages. */
  auditID: string;
  /** The level the policy evaluated for this request. */
  level: AuditLevel;
  /** The request lifecycle stage this event was emitted at. */
  stage: AuditStage;
  /** The request path, e.g. `/api/v1/namespaces/secret-audit-request/secrets`. */
  requestURI: string;
  /** The lower-case API verb, e.g. `"create"`, `"update"`, `"delete"`, `"get"`. */
  verb: string;
  /** The authenticated principal. Never absent on the wire. */
  user: AuditUserInfo;
  /** RFC 3339 timestamp of when the API server received the request. */
  requestReceivedTimestamp: string;
  /** RFC 3339 timestamp of when this stage was reached. */
  stageTimestamp: string;
  /** Source addresses of the request, nearest hop last. */
  sourceIPs?: string[];
  /** Self-reported client user agent; untrusted. */
  userAgent?: string;
  /** Present only when the request impersonated another principal. */
  impersonatedUser?: AuditUserInfo;
  /** Absent for non-resource requests. */
  objectRef?: AuditObjectReference;
  /** Absent before the response is known, e.g. at `RequestReceived`. */
  responseStatus?: AuditResponseStatus;
  /**
   * The audited request body. Present at `Request` and above on mutating
   * verbs. Its survival on Secret create and update is the accepted
   * trade-off, not a defect.
   */
  requestObject?: AuditPayload;
  /**
   * The audited response body. Present only at `RequestResponse`.
   *
   * For a `secrets` event this must never be present -- that is the guard. It
   * is typed as an inspectable optional object precisely so the guard stays
   * assertable; this module never strips, redacts or coerces it.
   */
  responseObject?: AuditPayload;
  /**
   * Audit annotations. A single flat map on the wire, from which
   * `test/utils/audit.go` L162-179 routes entries by prefix into the
   * authorizer decision, the admission-webhook maps and any custom set.
   * Index it with {@link AUTHORIZATION_DECISION_ANNOTATION}.
   */
  annotations?: Record<string, string>;
}

/**
 * The canonical response envelope of the audit-event listing endpoint.
 *
 * A bare `AuditEvent[]` is also accepted by this hook, so a handler may return
 * either shape; see {@link useAuditEvents} for the precedence rules that derive
 * pagination from these fields.
 */
export interface AuditEventList {
  /** The page of events, in the order the server returned them. */
  items: AuditEvent[];
  /** Total number of events matching the filter across all pages, when known. */
  total?: number;
  /**
   * Explicit "another page exists" signal. When present it wins over any
   * inference, which lets a server that cannot count totals still paginate
   * correctly.
   */
  hasMore?: boolean;
}

/**
 * The filter applied to an audit-event query.
 *
 * The fields mirror those the V6 integration test asserts on, so a filtered
 * view can reproduce exactly what the Go expectations cover. Every field is
 * optional and an omitted or empty field is simply not sent.
 */
export interface AuditEventFilter {
  /** Plural resource name, e.g. `"secrets"` or `"clusterroles"`. */
  resource?: string;
  /** API verb, e.g. `"create"`. */
  verb?: string;
  /** Namespace, e.g. `"secret-audit-request"`. */
  namespace?: string;
  /** Exact audit level. */
  level?: AuditLevel;
}

/**
 * The default endpoint the hook queries.
 *
 * Exported so `web/src/test/msw/handlers.ts` can register its handler against
 * the same literal instead of duplicating a string that could drift.
 */
export const AUDIT_EVENTS_ENDPOINT = '/api/posture/audit-events';

/** The default number of events requested per page. */
export const AUDIT_EVENTS_DEFAULT_PAGE_SIZE = 50;

/**
 * The query-parameter names this hook sends.
 *
 * Exported for the same reason as {@link AUDIT_EVENTS_ENDPOINT}: the MSW
 * handler matches on these names, so sharing the literals removes any chance of
 * a silent mismatch between the hook and its test double.
 *
 * Encoding contract, stable and relied upon by the handlers: `page` first, then
 * `pageSize`, then the filter fields in alphabetical order -- `level`,
 * `namespace`, `resource`, `verb`. Pagination parameters are always sent; a
 * filter field is sent only when it is a non-empty string. `page` is 1-based.
 */
export const AUDIT_EVENTS_QUERY_PARAMS = {
  page: 'page',
  pageSize: 'pageSize',
  level: 'level',
  namespace: 'namespace',
  resource: 'resource',
  verb: 'verb',
} as const;

/**
 * The lifecycle of an audit-event query.
 *
 * Four distinct states, because collapsing any two of them would let the UI
 * assert something it has no evidence for:
 * - `idle`    -- not yet fetched (the query is disabled, or the first request
 *                has not been issued);
 * - `loading` -- a request is in flight;
 * - `success` -- a response arrived and was understood;
 * - `error`   -- the request failed, was refused, or returned a body this hook
 *                could not understand.
 */
export type AuditEventsStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * A failed audit-event query.
 *
 * Invariant locked: a refusal is never representable as a result. A 403 or a
 * 500 produces one of these and leaves the event list empty *with*
 * `status === 'error'`, so no consumer can mistake "the server refused" for
 * "there are no audit events".
 */
export interface AuditEventsError {
  /**
   * The HTTP status of the failed response, or `0` when the request never
   * produced one (a transport or CORS failure, or a body that could not be
   * parsed at all).
   */
  readonly httpStatus: number;
  /** Always populated; falls back to a generated description. */
  readonly message: string;
  /** The `reason` of a Kubernetes `Status` body, e.g. `"Forbidden"`. */
  readonly reason?: string;
  /**
   * The `code` of a Kubernetes `Status` body. Normally equal to
   * {@link httpStatus}, but preserved separately because they are distinct
   * fields on the wire and may disagree.
   */
  readonly code?: number;
}

/**
 * Everything {@link useAuditEvents} accepts. Every field is optional.
 *
 * The pagination and filter fields seed the hook's initial state only; after
 * mount they are owned by the hook and changed through the returned mutators.
 */
export interface UseAuditEventsOptions {
  /** Overrides {@link AUDIT_EVENTS_ENDPOINT}. */
  endpoint?: string;
  /** Initial 1-based page. Values below 1 are clamped to 1. */
  page?: number;
  /** Initial page size. Values below 1 are clamped to 1. */
  pageSize?: number;
  /** Initial filter. */
  filter?: AuditEventFilter;
  /**
   * When `false` no request is issued and the status stays `idle`. This is what
   * makes the not-yet-fetched state reachable and observable -- useful for a
   * collapsed panel, and for asserting that `idle` is distinct from an empty
   * success. Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * Everything {@link useAuditEvents} returns.
 *
 * The four booleans are deliberately derived here rather than left to each
 * consumer, so that every panel reaches the same verdict from the same state.
 */
export interface UseAuditEventsResult {
  /**
   * The current page of events, exactly as the server returned them.
   *
   * Never reordered, never normalised, and never filtered -- see the invariant
   * on {@link useAuditEvents}. Empty while loading, while idle, and on error.
   */
  events: AuditEvent[];
  /** The query lifecycle state. */
  status: AuditEventsStatus;
  /** `true` exactly when `status === 'loading'`. */
  isLoading: boolean;
  /**
   * `true` exactly when the query **succeeded and matched nothing**.
   *
   * Guaranteed `false` while idle, while loading, and on error. This is the
   * property that stops a refused request from rendering as a clean bill of
   * health.
   */
  isEmpty: boolean;
  /** The failure, or `null` when there is none. */
  error: AuditEventsError | null;
  /** The current 1-based page. */
  page: number;
  /** The current page size. */
  pageSize: number;
  /** Total matches across all pages, when the server reported it. */
  total?: number;
  /**
   * Whether a further page exists. Resolved from, in order: an explicit
   * `hasMore`, then `total` arithmetic, then a full-page heuristic. Always
   * `false` unless the query succeeded.
   */
  hasNextPage: boolean;
  /** Whether a previous page exists, i.e. the page is above 1. */
  hasPreviousPage: boolean;
  /** The filter currently in effect. */
  filter: AuditEventFilter;
  /**
   * Replaces the filter and resets to page 1, so a new filter can never be
   * combined with a stale page offset.
   */
  setFilter: (filter: AuditEventFilter) => void;
  /** Jumps to a 1-based page. Values below 1 are clamped to 1. */
  setPage: (page: number) => void;
  /** Advances one page. A no-op when no further page is known to exist. */
  nextPage: () => void;
  /** Steps back one page. A no-op on page 1. */
  previousPage: () => void;
  /** Re-issues the current query, bypassing nothing and preserving page and filter. */
  refresh: () => void;
}


/** The internal reducer-free state of one query attempt. */
interface AuditEventsQueryState {
  status: AuditEventsStatus;
  events: AuditEvent[];
  error: AuditEventsError | null;
  total?: number;
  hasMore?: boolean;
}

/** The pagination-bearing shape recovered from a successful response body. */
interface ParsedAuditEventsPage {
  events: AuditEvent[];
  total?: number;
  hasMore?: boolean;
}

/**
 * Coerces a caller-supplied page or page size to a positive integer.
 *
 * Defends the query string against `NaN`, `Infinity`, zero, negatives and
 * fractions, none of which a server could honour.
 */
function clampToPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const truncated = Math.trunc(value);
  return truncated < 1 ? 1 : truncated;
}

/** Narrows an unknown parsed JSON value to a plain object (arrays excluded). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds a filter parameter only when it carries a non-empty value. */
function appendFilterParam(
  params: URLSearchParams,
  name: string,
  value: string | undefined,
): void {
  if (typeof value === 'string' && value.length > 0) {
    params.set(name, value);
  }
}

/**
 * Builds the query string for one page of audit events.
 *
 * The ordering is the documented contract of
 * {@link AUDIT_EVENTS_QUERY_PARAMS}: `page`, `pageSize`, then the filter fields
 * alphabetically. It is deterministic so that the string doubles as this hook's
 * effect key -- two queries are the same request exactly when their strings
 * match -- and so `web/src/test/msw/handlers.ts` can match on it.
 */
function buildAuditEventsQuery(
  page: number,
  pageSize: number,
  filter: AuditEventFilter,
): string {
  const params = new URLSearchParams();
  params.set(AUDIT_EVENTS_QUERY_PARAMS.page, String(page));
  params.set(AUDIT_EVENTS_QUERY_PARAMS.pageSize, String(pageSize));
  appendFilterParam(params, AUDIT_EVENTS_QUERY_PARAMS.level, filter.level);
  appendFilterParam(params, AUDIT_EVENTS_QUERY_PARAMS.namespace, filter.namespace);
  appendFilterParam(params, AUDIT_EVENTS_QUERY_PARAMS.resource, filter.resource);
  appendFilterParam(params, AUDIT_EVENTS_QUERY_PARAMS.verb, filter.verb);
  return params.toString();
}

/**
 * Recovers the event page from a parsed response body.
 *
 * Accepts the canonical {@link AuditEventList} envelope and, equivalently, a
 * bare array of events. Returns `null` for anything else, which the caller turns
 * into an error state -- a body this hook cannot understand must never be
 * reported as a successful empty page.
 *
 * The events themselves are deliberately **not** validated, filtered or
 * normalised. Dropping an unexpected event would defeat the confidentiality
 * guard, which derives its strength from inspecting every event the server
 * returned rather than only the expected ones.
 */
function parseAuditEventsPayload(body: unknown): ParsedAuditEventsPage | null {
  if (Array.isArray(body)) {
    return { events: body as AuditEvent[] };
  }
  if (isRecord(body) && Array.isArray(body.items)) {
    const parsed: ParsedAuditEventsPage = { events: body.items as AuditEvent[] };
    if (typeof body.total === 'number' && Number.isFinite(body.total)) {
      parsed.total = body.total;
    }
    if (typeof body.hasMore === 'boolean') {
      parsed.hasMore = body.hasMore;
    }
    return parsed;
  }
  return null;
}

/**
 * Builds an error from a non-2xx response, preserving the HTTP status and any
 * Kubernetes `Status` `reason`, `message` and `code`.
 *
 * A 403 from the audit endpoint carries a `Status` whose `reason` is
 * `"Forbidden"`; surfacing it lets a panel explain *why* it cannot report,
 * instead of implying there was nothing to report.
 */
async function readErrorFromResponse(response: Response): Promise<AuditEventsError> {
  const fallbackMessage = `audit event request failed with HTTP status ${response.status}`;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { httpStatus: response.status, message: fallbackMessage };
  }

  if (!isRecord(body)) {
    return { httpStatus: response.status, message: fallbackMessage };
  }

  const failure: {
    httpStatus: number;
    message: string;
    reason?: string;
    code?: number;
  } = {
    httpStatus: response.status,
    message:
      typeof body.message === 'string' && body.message.length > 0
        ? body.message
        : fallbackMessage,
  };
  if (typeof body.reason === 'string' && body.reason.length > 0) {
    failure.reason = body.reason;
  }
  if (typeof body.code === 'number' && Number.isFinite(body.code)) {
    failure.code = body.code;
  }
  return failure;
}

/**
 * Recognises a cancellation rather than a failure.
 *
 * Matches on the `AbortError` name of a `DOMException`, never on a message
 * string, because messages differ between engines and are not part of any
 * contract.
 */
function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

/** Describes a request that never produced a response. */
function describeTransportFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return `audit event request failed: ${cause.message}`;
  }
  return 'audit event request failed before a response was received';
}

/**
 * Decides whether a further page exists, in a documented order of preference:
 *
 * 1. an explicit `hasMore` from the server always wins, so a server that cannot
 *    count totals can still paginate correctly;
 * 2. otherwise, `total` arithmetic;
 * 3. otherwise, a full page is taken to imply there may be another. `pageSize`
 *    is always at least 1, so an empty page correctly yields `false`.
 */
function resolveHasNextPage(
  page: number,
  pageSize: number,
  itemCount: number,
  total: number | undefined,
  hasMore: boolean | undefined,
): boolean {
  if (typeof hasMore === 'boolean') {
    return hasMore;
  }
  if (typeof total === 'number') {
    return page * pageSize < total;
  }
  return itemCount >= pageSize;
}

/**
 * Fetches a filtered, paginated page of `audit.k8s.io/v1` audit events.
 *
 * Invariant locked: **events are surfaced exactly as received.**
 * `responseObject` is never stripped, redacted, reordered or coerced, and no
 * event is ever filtered out on the way through, so the confidentiality
 * invariant -- no audit event whose `objectRef.resource` is `"secrets"` may
 * carry a `responseObject` (F-006-RQ-002) -- stays assertable at the
 * presentation layer. Redaction is the rendering component's responsibility,
 * never this hook's: a hook that helpfully deleted `responseObject` would leave
 * every spec green while making the guard unprovable.
 *
 * Second invariant locked: **a refusal is never an empty page.** `fetch` does
 * not reject on 4xx or 5xx, so the response is status-checked explicitly; a 403
 * or a 500 resolves to `status: 'error'` with the status code preserved, and
 * `isEmpty` is `true` only when a query actually succeeded and matched nothing.
 * A UI that showed "no audit events" after a refusal would assert a clean bill
 * of health it has no evidence for.
 *
 * Requests are cancelled on unmount and whenever the query changes, so a slow
 * response from a superseded filter or page can never overwrite a newer one.
 *
 * @example
 * ```ts
 * const audit = useAuditEvents({ filter: { resource: 'secrets' }, pageSize: 20 });
 * if (audit.status === 'error') {
 *   // Report the refusal. Never render this as "no events".
 * }
 * const leaks = audit.events.filter(
 *   (event) => event.objectRef?.resource === 'secrets' && event.responseObject !== undefined,
 * );
 * ```
 */
export function useAuditEvents(options: UseAuditEventsOptions = {}): UseAuditEventsResult {
  const {
    endpoint = AUDIT_EVENTS_ENDPOINT,
    page: initialPage,
    pageSize: initialPageSize,
    filter: initialFilter,
    enabled = true,
  } = options;

  // Pagination and filter state are seeded from the options exactly once; from
  // then on they are owned here and changed only through the returned mutators.
  const [page, setPageState] = useState<number>(() => clampToPositiveInteger(initialPage, 1));
  const [pageSize] = useState<number>(() =>
    clampToPositiveInteger(initialPageSize, AUDIT_EVENTS_DEFAULT_PAGE_SIZE),
  );
  const [filter, setFilterState] = useState<AuditEventFilter>(() => initialFilter ?? {});
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [state, setState] = useState<AuditEventsQueryState>(() => ({
    status: 'idle',
    events: [],
    error: null,
  }));

  // The request URL is the effect's key. Deriving it from a deterministic query
  // string means the effect depends on a primitive, so a caller passing an
  // inline filter object cannot trigger a refetch loop through identity churn.
  const requestUrl = useMemo(
    () => `${endpoint}?${buildAuditEventsQuery(page, pageSize, filter)}`,
    [endpoint, page, pageSize, filter],
  );

  useEffect(() => {
    if (!enabled) {
      // Return to the not-yet-fetched state. The functional form lets React bail
      // out of re-rendering when the query was already idle.
      setState((previous) =>
        previous.status === 'idle' ? previous : { status: 'idle', events: [], error: null },
      );
      return undefined;
    }

    const controller = new AbortController();
    const { signal } = controller;

    setState({ status: 'loading', events: [], error: null });

    const run = async (): Promise<void> => {
      try {
        const response = await fetch(requestUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal,
        });
        if (signal.aborted) {
          return;
        }

        if (!response.ok) {
          const failure = await readErrorFromResponse(response);
          if (signal.aborted) {
            return;
          }
          setState({ status: 'error', events: [], error: failure });
          return;
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          if (signal.aborted) {
            return;
          }
          setState({
            status: 'error',
            events: [],
            error: {
              httpStatus: response.status,
              message: 'audit event response body was not valid JSON',
            },
          });
          return;
        }
        if (signal.aborted) {
          return;
        }

        const parsed = parseAuditEventsPayload(body);
        if (parsed === null) {
          setState({
            status: 'error',
            events: [],
            error: {
              httpStatus: response.status,
              message:
                'audit event response did not contain an items array or an array of events',
            },
          });
          return;
        }

        // Straight through: the events are handed on untouched.
        setState({
          status: 'success',
          events: parsed.events,
          error: null,
          total: parsed.total,
          hasMore: parsed.hasMore,
        });
      } catch (cause) {
        // A cancelled request is not a failure and must leave the state alone:
        // the effect that superseded it owns the state now.
        if (signal.aborted || isAbortError(cause)) {
          return;
        }
        setState({
          status: 'error',
          events: [],
          error: { httpStatus: 0, message: describeTransportFailure(cause) },
        });
      }
    };

    void run();

    // Runs on unmount and before every superseding request.
    return () => {
      controller.abort();
    };
  }, [enabled, requestUrl, refreshToken]);

  const hasNextPage =
    state.status === 'success'
      ? resolveHasNextPage(page, pageSize, state.events.length, state.total, state.hasMore)
      : false;

  const setFilter = useCallback((next: AuditEventFilter) => {
    setFilterState(next);
    // Resetting the page is not a convenience: a new filter combined with a
    // stale offset would silently show the wrong slice of the wrong result set.
    setPageState(1);
  }, []);

  const setPage = useCallback((next: number) => {
    setPageState(clampToPositiveInteger(next, 1));
  }, []);

  const nextPage = useCallback(() => {
    if (!hasNextPage) {
      return;
    }
    setPageState((current) => current + 1);
  }, [hasNextPage]);

  const previousPage = useCallback(() => {
    setPageState((current) => (current > 1 ? current - 1 : current));
  }, []);

  const refresh = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  return {
    events: state.events,
    status: state.status,
    isLoading: state.status === 'loading',
    // True only for a query that succeeded and matched nothing -- never while
    // idle, never while loading, and never after a refusal.
    isEmpty: state.status === 'success' && state.events.length === 0,
    error: state.error,
    page,
    pageSize,
    total: state.total,
    hasNextPage,
    hasPreviousPage: page > 1,
    filter,
    setFilter,
    setPage,
    nextPage,
    previousPage,
    refresh,
  };
}

