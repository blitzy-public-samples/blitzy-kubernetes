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

import {
  AUDIT_API_VERSION,
  AUDIT_EVENT_KIND,
  AUDIT_LEVEL_ORDER,
  AUDIT_REQUEST_BODY_KEY,
  AUDIT_RESPONSE_BODY_KEY,
  CONFIDENTIAL_AUDIT_RESOURCE,
  type AuditLevel,
} from '../domain/securityConstants';

/**
 * The audit-level vocabulary, RE-EXPORTED rather than redeclared.
 *
 * `domain/securityConstants` is the one definition site: it depends on nothing,
 * so the parser, the panels and the recorded fixtures can all reach the same
 * tuple and the same union without a cycle. This hook re-exports both because
 * they are part of the audit contract its consumers already import from here —
 * the re-export keeps those import paths working while leaving exactly ONE place
 * where the order `None < Metadata < Request < RequestResponse` is written down.
 *
 * Load-bearing for F-006-RQ-002: `secrets` and `serviceaccounts/token` sit at
 * exactly `Request`, and a regression that silently promoted them to
 * `RequestResponse` would begin writing Secret payloads into the audit log. Index
 * order is the invariant — reordering the tuple is now a compile error at its
 * definition site rather than a divergence between three copies.
 */
export type { AuditLevel };
export { AUDIT_LEVEL_ORDER };

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
 * The four audit stages as a runtime value, so an incoming `stage` can be checked.
 *
 * The type alone is erased at compile time and checks nothing about a wire value. This
 * constant is what makes "one of the four" assertable, and it is deliberately NOT ordered
 * the way {@link AUDIT_LEVEL_ORDER} is: stages are a lifecycle, not a severity scale, so
 * ranking them would invite a comparison that means nothing.
 */
export const AUDIT_STAGES: readonly AuditStage[] = Object.freeze([
  'RequestReceived',
  'ResponseStarted',
  'ResponseComplete',
  'Panic',
]);

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
 * Wall-clock ceiling for a single audit-event request, in milliseconds.
 *
 * An `AbortController` bounds only what the CONSUMER does — unmount, a changed
 * filter, a refresh, a page change. It cannot bound what the SERVER does, and
 * `fetch` carries no default timeout, so a server that accepts the connection and
 * then never answers leaves this hook in `loading` for as long as the tab is open.
 * For a confidentiality surface that is the worst available outcome: the panel
 * neither shows events nor says it failed to read them, and "no response bodies
 * were observed" is indistinguishable from "nothing was checked".
 *
 * Longer than {@link useControlStatus}'s ceiling on purpose. A control-status read
 * returns eight verdicts; this one returns a page of up to
 * {@link AUDIT_EVENTS_DEFAULT_PAGE_SIZE} audit events read out of a log, so a
 * healthy response legitimately takes longer.
 */
export const AUDIT_EVENTS_REQUEST_TIMEOUT_MS = 30_000;

/** Message reported when {@link AUDIT_EVENTS_REQUEST_TIMEOUT_MS} elapses. */
const AUDIT_EVENTS_TIMEOUT_MESSAGE =
  `The audit-event request did not complete within ${AUDIT_EVENTS_REQUEST_TIMEOUT_MS / 1000}s ` +
  'and was cancelled. No conclusion about recorded response bodies can be drawn from a read ' +
  'that never completed. Retry to re-issue the request.';

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
 * Which layer a failed audit-event query failed at.
 *
 * The vocabulary matches {@link useControlStatus}'s `ControlStatusErrorKind`
 * deliberately: the two hooks front the same API server, and a consumer that
 * handles one should not have to learn a second spelling for the same four
 * outcomes.
 *
 * - `http` — a response arrived and its status was not a success.
 * - `payload` — a success response arrived but its body could not be trusted.
 * - `network` — no response arrived at all (transport, DNS or CORS failure).
 * - `timeout` — the request was still outstanding when its deadline elapsed.
 *
 * The last two carry NO {@link AuditEventsError.httpStatus}, because there was no
 * response to take one from.
 */
export type AuditEventsErrorKind = 'http' | 'network' | 'payload' | 'timeout';

/** Lowest integer the HTTP specification assigns as a status code. */
export const MIN_HTTP_STATUS_CODE = 100;

/** Highest integer any HTTP status registry assigns, including vendor ranges. */
export const MAX_HTTP_STATUS_CODE = 599;

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
   * Which layer failed. Narrow on this before reading {@link httpStatus}: it is
   * the discriminant that says whether a response existed at all.
   */
  readonly kind: AuditEventsErrorKind;
  /** Always populated; falls back to a generated description. */
  readonly message: string;
  /**
   * The HTTP status of the failed response, verbatim.
   *
   * ABSENT — not zero — for `kind: 'network'` and `kind: 'timeout'`, because no
   * response and therefore no status ever existed. This field previously carried
   * a fabricated `0` in those cases, which put an invented value where a real
   * status goes: `0` is not an HTTP status, consumers had to know to test for it
   * as a sentinel, and any that did not would render "HTTP status 0". Absence
   * cannot be misread, and it makes this hook agree with its sibling
   * {@link useControlStatus}, which already models it this way.
   */
  readonly httpStatus?: number;
  /** The `reason` of a Kubernetes `Status` body, e.g. `"Forbidden"`. */
  readonly reason?: string;
  /**
   * The `code` of a Kubernetes `Status` body. Normally equal to
   * {@link httpStatus}, but preserved separately because they are distinct
   * fields on the wire and may disagree.
   *
   * Accepted ONLY as an integer in the HTTP status range (see
   * {@link MIN_HTTP_STATUS_CODE} and {@link MAX_HTTP_STATUS_CODE}). A body is
   * attacker- or bug-supplied data, so `0`, `-1`, `1.5` and `1e9` are all
   * discarded rather than surfaced as if a server had chosen them.
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
  /** Initial filter. Cloned on the way in, so the caller may keep and reuse its object. */
  filter?: Readonly<AuditEventFilter>;
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
   *
   * READONLY, and frozen at runtime as well as in the type. A mutable page is shared
   * state between every consumer of one hook instance: the confidentiality guard reads
   * this list to decide whether a Secret body was disclosed, and a panel that sorted it
   * in place, or spliced an event out of it, would change the evidence a later assertion
   * examines. `readonly` catches that at the gate; `Object.freeze` catches the consumer
   * that casts the type away.
   */
  events: readonly AuditEvent[];
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
  /**
   * The 1-based page the current {@link UseAuditEventsResult.events} were fetched for, or
   * `undefined` before any page has loaded.
   *
   * DIFFERENT FROM {@link UseAuditEventsResult.page} for exactly one render after a page
   * change, and that difference is why this member exists. Changing the page schedules a
   * request, so until the response arrives the hook holds the new page NUMBER beside the
   * previous page's EVENTS. A consumer that accumulates pages — the confidentiality guard
   * traverses every page before it will make a whole-set claim — must key each batch by
   * the page it actually came from, or it records one page's events under another's
   * number and then double-counts them.
   */
  loadedPage?: number;
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
  filter: Readonly<AuditEventFilter>;
  /**
   * Replaces the filter and resets to page 1, so a new filter can never be
   * combined with a stale page offset.
   */
  setFilter: (filter: Readonly<AuditEventFilter>) => void;
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
  events: readonly AuditEvent[];
  error: AuditEventsError | null;
  total?: number;
  hasMore?: boolean;
  /**
   * The 1-based page {@link AuditEventsQueryState.events} was fetched for.
   *
   * Recorded at the moment of the response rather than read back from the `page` state,
   * because the two are legitimately out of step for one render: changing the page
   * schedules a request, so between the change and its response the hook holds the NEW
   * page number alongside the PREVIOUS page's events. A consumer accumulating pages must
   * be able to tell which page it is looking at, and inferring it from `page` attributes
   * one page's events to another's number.
   */
  loadedPage?: number;
}

/** The pagination-bearing shape recovered from a successful response body. */
interface ParsedAuditEventsPage {
  events: readonly AuditEvent[];
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
  filter: Readonly<AuditEventFilter>,
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

/** Names the JSON type of a value without disclosing the value. */
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
 * Reads a REQUIRED string member, or explains why it could not be read.
 *
 * Returns the reason rather than throwing, so the caller can accumulate a single message
 * naming the offending index and member.
 */
function requiredString(
  event: Record<string, unknown>,
  key: string,
): { readonly value: string } | { readonly problem: string } {
  const raw = event[key];
  if (typeof raw !== 'string') {
    return {
      problem: `"${key}" is ${describeJsonType(raw)}, not a string`,
    };
  }
  if (raw.length === 0) {
    return { problem: `"${key}" is empty` };
  }
  return { value: raw };
}

/**
 * Validates an OPTIONAL audited body member: absent, or an OBJECT. Never anything else.
 *
 * THIS IS THE MOST IMPORTANT CHECK IN THIS MODULE. `test/utils/audit.go` L151-156 flattens
 * `responseObject` to the boolean `true` for its Go-side comparison, and that flattening
 * must never appear on the wire this hook reads. If it does, the presentation-layer
 * redaction breaks in the one direction that matters: `ConfidentialityRedaction` decides
 * what to withhold by inspecting an OBJECT, so a `responseObject: true` satisfies every
 * `!== undefined` presence test while carrying nothing an object-shaped redactor can
 * recognise -- the guard reports a violation it cannot describe, or, worse, a redactor
 * that only handles objects passes the raw value through to the DOM.
 *
 * A boolean here is therefore a CONTRACT VIOLATION and not a leniency to absorb. The page
 * is refused, which is the honest outcome: this client cannot tell whether a Secret body
 * was disclosed, and reporting either answer would be a guess.
 */
function optionalPayload(
  event: Record<string, unknown>,
  key: string,
): { readonly ok: true } | { readonly problem: string } {
  const raw = event[key];
  if (raw === undefined) {
    return { ok: true };
  }
  if (!isRecord(raw)) {
    return {
      problem:
        `"${key}" is ${describeJsonType(raw)}, but an audited body is an object on the ` +
        'wire. A boolean here is the Go-side FLATTENED form from test/utils/audit.go ' +
        'L151-156, which must never reach this tier: the confidentiality guard and its ' +
        'redaction both key on an object, so a flattened value would be reported as ' +
        'present while being unrenderable and unredactable',
    };
  }
  return { ok: true };
}

// A generic "is it an object" check for `objectRef`, `responseStatus`,
// `impersonatedUser` and `annotations` used to live here, and it was the C1 defect:
// each of those four is consumed to its LEAVES downstream, so validating only the
// container accepted `objectRef: {}` and let the confidentiality guard read
// `undefined` from it. The four now have purpose-built validators —
// describeInvalidObjectRef, describeInvalidResponseStatus, describeInvalidSubject
// and describeInvalidAnnotations — and the shallow helper is deliberately gone
// rather than left available for a fifth field to be checked half-way.

/**
 * Validates an optional string member of a nested object.
 *
 * `allowEmpty` distinguishes the two cases the wire genuinely has: an
 * `objectRef.apiGroup` of `""` IS the core API group and is meaningful, while an
 * `objectRef.resource` of `""` names nothing at all.
 */
function optionalNestedString(
  container: Record<string, unknown>,
  containerName: string,
  key: string,
  allowEmpty: boolean,
): { readonly ok: true } | { readonly problem: string } {
  const raw = container[key];
  if (raw === undefined) {
    return { ok: true };
  }
  if (typeof raw !== 'string') {
    return {
      problem: `has a "${containerName}.${key}" of ${describeJsonType(raw)}, not a string`,
    };
  }
  if (!allowEmpty && raw.length === 0) {
    return { problem: `has an empty "${containerName}.${key}"` };
  }
  return { ok: true };
}

/** Validates an optional array-of-strings member of a nested object. */
function optionalNestedStringList(
  container: Record<string, unknown>,
  containerName: string,
  key: string,
): { readonly ok: true } | { readonly problem: string } {
  const raw = container[key];
  if (raw === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(raw)) {
    return {
      problem: `has a "${containerName}.${key}" of ${describeJsonType(raw)}, not a list`,
    };
  }
  for (const [index, member] of raw.entries()) {
    if (typeof member !== 'string') {
      return {
        problem:
          `has a "${containerName}.${key}[${String(index)}]" of ` +
          `${describeJsonType(member)}, not a string. A malformed member is REFUSED ` +
          'rather than dropped, because filtering one out silently narrows an identity',
      };
    }
  }
  return { ok: true };
}

/**
 * Validates a subject: `user` or `impersonatedUser`.
 *
 * The identity of the principal is what makes an audit event evidence rather than
 * a log line, so every member it carries is checked rather than only its
 * presence. `groups` in particular is validated member-by-member: a group list
 * with an unreadable entry is a DIFFERENT identity from the list without it, and
 * dropping the entry would quietly produce the narrower one.
 */
function describeInvalidSubject(
  raw: unknown,
  containerName: string,
): string | null {
  if (!isRecord(raw)) {
    return `has a "${containerName}" of ${describeJsonType(raw)}, not an object`;
  }
  const username = requiredString(raw, 'username');
  if ('problem' in username) {
    return `has a "${containerName}" whose ${username.problem}`;
  }
  const uid = optionalNestedString(raw, containerName, 'uid', false);
  if ('problem' in uid) {
    return uid.problem;
  }
  const groups = optionalNestedStringList(raw, containerName, 'groups');
  if ('problem' in groups) {
    return groups.problem;
  }
  const extra = raw['extra'];
  if (extra !== undefined) {
    if (!isRecord(extra)) {
      return `has a "${containerName}.extra" of ${describeJsonType(extra)}, not an object`;
    }
    for (const key of Object.keys(extra)) {
      const values = optionalNestedStringList(extra, `${containerName}.extra`, key);
      if ('problem' in values) {
        return values.problem;
      }
    }
  }
  return null;
}

/**
 * Validates `objectRef`, the field the whole confidentiality guard keys on.
 *
 * INVARIANT LOCKED (F-006-RQ-003, AAP §0.10.2): when `objectRef` is present its
 * `resource` MUST be a non-empty string. Before this check the member was
 * validated only as "an object", so `objectRef: {}` and
 * `objectRef: { resource: 7 }` were both accepted — and the redaction test
 * `event.objectRef?.resource === 'secrets'` then evaluated FALSE for them, which
 * put a malformed Secret event carrying a `responseObject` on the NON-sensitive
 * branch and serialized the body into the document. An absent `objectRef` is a
 * different and legitimate thing (a non-resource request has none); an objectRef
 * that exists and cannot say what it refers to is a contradiction.
 *
 * Every other member is validated too, because each is rendered: `apiGroup` may
 * be the empty string (that IS the core group) while the rest may not.
 */
function describeInvalidObjectRef(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return `has an "objectRef" of ${describeJsonType(raw)}, not an object`;
  }
  const resource = raw['resource'];
  if (typeof resource !== 'string' || resource.length === 0) {
    return (
      `has an "objectRef" whose "resource" is ${describeJsonType(resource)}` +
      `${typeof resource === 'string' ? ' and empty' : ''}. An objectRef that exists ` +
      'must say what it refers to: the confidentiality guard keys on this exact field, ' +
      'so an unreadable one would put a Secret event on the non-sensitive branch and ' +
      'render its response body'
    );
  }
  for (const key of ['namespace', 'name', 'uid', 'apiVersion', 'resourceVersion', 'subresource']) {
    const member = optionalNestedString(raw, 'objectRef', key, false);
    if ('problem' in member) {
      return member.problem;
    }
  }
  // The core API group IS the empty string, so this one member may be empty.
  const apiGroup = optionalNestedString(raw, 'objectRef', 'apiGroup', true);
  if ('problem' in apiGroup) {
    return apiGroup.problem;
  }
  return null;
}

/**
 * Validates `responseStatus`.
 *
 * `code` is required and must be a plausible HTTP status, because the V2 and V7
 * controls are decided by exact status codes and a `code` of `"403"`, `403.5` or
 * `99` cannot be compared against one. The three text members are validated as
 * strings for the same reason every rendered field is: a non-string reaches the
 * document as `[object Object]` or as `undefined`.
 */
function describeInvalidResponseStatus(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return `has a "responseStatus" of ${describeJsonType(raw)}, not an object`;
  }
  const code = raw['code'];
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 100 || code > 599) {
    return (
      `has a "responseStatus.code" of ${JSON.stringify(code)}; an audited status is an ` +
      'integer HTTP status code between 100 and 599, and a value outside that compares ' +
      'absurdly against the exact codes the controls assert'
    );
  }
  for (const key of ['status', 'reason', 'message']) {
    const member = optionalNestedString(raw, 'responseStatus', key, false);
    if ('problem' in member) {
      return member.problem;
    }
  }
  return null;
}

/**
 * Validates `annotations`: a FLAT map of string to string on the wire.
 *
 * Checked value-by-value because the authorizer's verdict is read out of this map
 * by key ({@link AUTHORIZATION_DECISION_ANNOTATION}) and rendered. A nested
 * object here would render as `[object Object]` in the decision column, which
 * reads as a decision and is not one.
 */
function describeInvalidAnnotations(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return `has "annotations" of ${describeJsonType(raw)}, not an object`;
  }
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] !== 'string') {
      return (
        `has an "annotations" entry whose value is ${describeJsonType(raw[key])}, not a ` +
        'string. Audit annotations are a flat string map on the wire'
      );
    }
  }
  return null;
}

/**
 * The resource a request path names, when the path is a resource path at all.
 *
 * `subresource` and `namespace` are present only when the path carries them.
 */
interface RequestUriTarget {
  readonly resource: string;
  readonly namespace?: string;
  readonly subresource?: string;
}

/**
 * Reads the resource identity out of an audit event's `requestURI`.
 *
 * The Kubernetes API has exactly two resource-path shapes and this recognises both
 * and nothing else: `/api/<version>/...` for the core group and
 * `/apis/<group>/<version>/...` for every named group, each optionally prefixed
 * with `namespaces/<name>/` inside the version segment. Anything else — `/healthz`,
 * `/version`, `/metrics`, `/openapi/v2` — is a NON-RESOURCE path and yields
 * `undefined`, which is a meaningful answer rather than a failure: a non-resource
 * request legitimately carries no `objectRef`.
 *
 * Deliberately conservative. It parses the path and never guesses: a path that does
 * not match a known shape is reported as non-resource rather than as "probably the
 * last segment", because a wrong guess here would either invent a contradiction
 * where none exists or hide one that does.
 *
 * @param requestURI - the event's `requestURI`, possibly with a query string.
 * @returns the named resource, or `undefined` for a non-resource path.
 */
function readRequestUriTarget(requestURI: string): RequestUriTarget | undefined {
  const path = requestURI.split('?')[0] ?? '';
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let rest: readonly string[];
  if (segments[0] === 'api' && segments.length >= 2) {
    rest = segments.slice(2);
  } else if (segments[0] === 'apis' && segments.length >= 3) {
    rest = segments.slice(3);
  } else {
    return undefined;
  }

  let namespace: string | undefined;
  if (rest[0] === 'namespaces' && rest.length >= 2) {
    if (rest.length === 2) {
      // `/api/v1/namespaces/<name>` addresses the Namespace OBJECT itself, so the
      // resource is `namespaces` and the trailing segment is that object's name
      // rather than a namespace scope. The name is not returned because nothing
      // compares it: `objectRef.name` is absent on collection requests, so a
      // comparison would be a contradiction check that fires on a legitimate
      // omission.
      return { resource: 'namespaces' };
    }
    namespace = rest[1];
    rest = rest.slice(2);
  }

  const resource = rest[0];
  if (resource === undefined || resource.length === 0) {
    return undefined;
  }
  // rest is [resource] | [resource, name] | [resource, name, subresource].
  const subresource = rest.length >= 3 ? rest[2] : undefined;
  return {
    resource,
    ...(namespace === undefined ? {} : { namespace }),
    ...(subresource === undefined ? {} : { subresource }),
  };
}

/**
 * What an audit event refers to, resolved once and trusted everywhere.
 *
 * THE POINT OF THIS TYPE is that `uncertain` is a first-class answer. The guard it
 * feeds used to ask `event.objectRef?.resource === SENSITIVE_RESOURCE`, an
 * expression with only two outcomes — so "this is not a Secret" and "I cannot tell
 * what this is" produced the same answer, and the second one is the dangerous one.
 * Modelling uncertainty explicitly is what lets every consumer fail CLOSED on it.
 */
export type AuditResourceIdentity =
  | {
      /** The event names a resource, and this is it. */
      readonly kind: 'resource';
      readonly resource: string;
      readonly namespace?: string;
      readonly subresource?: string;
      /**
       * Which field the identity came from. `requestURI` means no `objectRef` was
       * recorded, so the path is the only statement of identity available — it is
       * still an identity, and for a Secret path it must still be treated as one.
       */
      readonly source: 'objectRef' | 'requestURI';
    }
  | {
      /** A non-resource request: `/healthz`, `/version`, `/metrics`. */
      readonly kind: 'non-resource';
      readonly requestURI: string;
    }
  | {
      /** The event's identity cannot be established. Consumers MUST fail closed. */
      readonly kind: 'uncertain';
      readonly reason: string;
    };

/**
 * Resolves what an audit event refers to.
 *
 * Invariant locked (C1): the answer is `uncertain` — never `non-resource` and never
 * a guess — whenever the event says something about its identity that cannot be
 * believed. Three cases reach it:
 *
 *   1. `objectRef` is present but its `resource` is absent, empty or not a string.
 *      Something was referenced and the reference is unreadable.
 *   2. `objectRef` and `requestURI` name different resources, namespaces or
 *      subresources. Two statements that disagree cannot both be believed.
 *   3. `objectRef` is absent and the `requestURI` is a resource path — resolved
 *      from the path with `source: 'requestURI'`, so a Secret path is still a
 *      Secret. This is a resolved identity rather than an uncertain one, and the
 *      distinction matters: the answer is knowable, just from the other field.
 *
 * An event that reaches a consumer THROUGH THIS HOOK has already been refused if it
 * is in case 1 or 2, because {@link describeInvalidEvent} rejects both. This
 * function exists because the panels also accept caller-supplied events in
 * controlled mode, which bypass the parser entirely — so the guard cannot rely on
 * the parser having run, and both paths resolve identity the same way.
 *
 * Pure, total and free of exceptions: every input produces one of the three arms.
 *
 * @param event - a wire audit event, trusted or not.
 * @returns the resolved identity.
 */
export function resolveAuditResourceIdentity(event: AuditEvent): AuditResourceIdentity {
  const requestURI = typeof event.requestURI === 'string' ? event.requestURI : '';
  const rawObjectRef: unknown = event.objectRef;
  const target = readRequestUriTarget(requestURI);

  if (rawObjectRef === undefined || rawObjectRef === null) {
    if (target === undefined) {
      return { kind: 'non-resource', requestURI };
    }
    return {
      kind: 'resource',
      resource: target.resource,
      ...(target.namespace === undefined ? {} : { namespace: target.namespace }),
      ...(target.subresource === undefined ? {} : { subresource: target.subresource }),
      source: 'requestURI',
    };
  }

  if (!isRecord(rawObjectRef)) {
    return {
      kind: 'uncertain',
      reason: `objectRef is ${describeJsonType(rawObjectRef)}, not an object`,
    };
  }

  const resource = rawObjectRef['resource'];
  if (typeof resource !== 'string' || resource.length === 0) {
    return {
      kind: 'uncertain',
      reason:
        'objectRef is present but carries no readable "resource", so what this event ' +
        'refers to cannot be established',
    };
  }

  const contradiction = describeIdentityContradiction(requestURI, rawObjectRef);
  if (contradiction !== null) {
    return { kind: 'uncertain', reason: `the event ${contradiction}` };
  }

  const namespace = rawObjectRef['namespace'];
  const subresource = rawObjectRef['subresource'];
  return {
    kind: 'resource',
    resource,
    ...(typeof namespace === 'string' ? { namespace } : {}),
    ...(typeof subresource === 'string' ? { subresource } : {}),
    source: 'objectRef',
  };
}

/**
 * Whether an event must be treated as referring to the confidential resource.
 *
 * INVARIANT LOCKED (F-006-RQ-003, AAP §0.10.2): `true` for a resolved `secrets`
 * identity AND for every UNCERTAIN identity. The second half is the whole point.
 * An event whose identity cannot be established might be a Secret event, and the
 * cost of the two possible mistakes is not symmetric: treating a non-Secret as
 * sensitive withholds one response body from a report, while treating an
 * unidentifiable Secret as non-sensitive writes a Secret's contents into the
 * document. The guard therefore resolves ties towards withholding.
 *
 * @param identity - the resolved identity.
 * @returns `true` when the event's response body must be withheld.
 */
export function isConfidentialAuditIdentity(identity: AuditResourceIdentity): boolean {
  if (identity.kind === 'uncertain') {
    return true;
  }
  return identity.kind === 'resource' && identity.resource === CONFIDENTIAL_AUDIT_RESOURCE;
}

/**
 * Reports a contradiction between an event's `requestURI` and its `objectRef`.
 *
 * INVARIANT LOCKED (C1): an event whose two statements of identity disagree is
 * REFUSED, not reconciled. There is no safe way to choose between them — a
 * `requestURI` of `/api/v1/namespaces/ns/secrets/s` paired with
 * `objectRef.resource: "configmaps"` is either a server defect or an attempt to
 * have a Secret event classified as something else, and in both cases every
 * downstream decision made from either field is unsound. Believing the objectRef
 * would let a crafted event carry a Secret body past the guard; believing the URI
 * would make the rendered table disagree with the verdict.
 *
 * Only fields present on BOTH sides are compared, because an omission is not a
 * contradiction: an audit policy may record an objectRef without a subresource,
 * and a cluster-scoped path carries no namespace.
 *
 * @param requestURI - the event's request path.
 * @param objectRef - the validated object reference.
 * @returns the contradiction, or `null` when the two agree or cannot be compared.
 */
function describeIdentityContradiction(
  requestURI: string,
  objectRef: Record<string, unknown>,
): string | null {
  const target = readRequestUriTarget(requestURI);
  if (target === undefined) {
    return null;
  }
  const resource = objectRef['resource'];
  if (typeof resource === 'string' && resource !== target.resource) {
    return (
      `names resource ${JSON.stringify(target.resource)} in its requestURI but ` +
      `${JSON.stringify(resource)} in its objectRef. Two statements of identity that ` +
      'disagree cannot both be believed, and choosing either one would let a crafted ' +
      'event be classified as something it is not'
    );
  }
  const namespace = objectRef['namespace'];
  if (
    typeof namespace === 'string' &&
    target.namespace !== undefined &&
    namespace !== target.namespace
  ) {
    return (
      `names namespace ${JSON.stringify(target.namespace)} in its requestURI but ` +
      `${JSON.stringify(namespace)} in its objectRef`
    );
  }
  const subresource = objectRef['subresource'];
  if (
    typeof subresource === 'string' &&
    target.subresource !== undefined &&
    subresource !== target.subresource
  ) {
    return (
      `names subresource ${JSON.stringify(target.subresource)} in its requestURI but ` +
      `${JSON.stringify(subresource)} in its objectRef`
    );
  }
  return null;
}

/**
 * Validates one wire event completely, returning a reason when it is unusable.
 *
 * Invariant locked: an event is accepted WHOLE or the page is refused. Nothing is
 * repaired, defaulted or dropped.
 *
 * Every REQUIRED member of {@link AuditEvent} is checked, because each one is read
 * downstream and an absent one produces `undefined` in a rendered table -- a table that
 * looks like a report and is not. `level` and `stage` are additionally checked against
 * their closed domains: `level` is the field F-006-RQ-002 is entirely about, and a level
 * outside the four would compare unequal to every entry of {@link AUDIT_LEVEL_ORDER},
 * making an ordering assertion silently unfalsifiable.
 *
 * `user` must be an object carrying a string `username`, because the identity of the
 * principal is what makes an audit event evidence rather than a log line.
 *
 * EVERY NESTED MEMBER IS VALIDATED TO ITS LEAVES, and that is the C1 fix. Checking
 * `objectRef`, `responseStatus`, `impersonatedUser` and `annotations` as "an
 * object" and stopping there accepted `objectRef: {}` — from which the guard's
 * `objectRef?.resource === 'secrets'` test read `undefined`, concluded "not a
 * Secret", and serialized the event's `responseObject` into the document. The
 * fields are consumed to their leaves downstream, so they are validated to their
 * leaves here.
 */
function describeInvalidEvent(candidate: unknown): string | null {
  if (!isRecord(candidate)) {
    return `is ${describeJsonType(candidate)}, not an object`;
  }

  if (candidate['apiVersion'] !== AUDIT_API_VERSION) {
    return (
      `has apiVersion ${JSON.stringify(candidate['apiVersion'])}, but only ` +
      `${JSON.stringify(AUDIT_API_VERSION)} is registered by the audit scheme`
    );
  }
  if (candidate['kind'] !== AUDIT_EVENT_KIND) {
    return (
      `has kind ${JSON.stringify(candidate['kind'])}, but a single audit event is ` +
      `${JSON.stringify(AUDIT_EVENT_KIND)}. An EventList is registered under the same ` +
      'group and version, and its items would never be read'
    );
  }

  const requiredStringKeys = [
    'auditID',
    'requestURI',
    'verb',
    'requestReceivedTimestamp',
    'stageTimestamp',
  ];
  for (const key of requiredStringKeys) {
    const read = requiredString(candidate, key);
    if ('problem' in read) {
      return read.problem;
    }
  }

  const level = candidate['level'];
  if (typeof level !== 'string' || !AUDIT_LEVEL_ORDER.includes(level as AuditLevel)) {
    return (
      `has level ${JSON.stringify(level)}, which is not one of ` +
      `${JSON.stringify(AUDIT_LEVEL_ORDER)}. The level is the field F-006-RQ-002 asserts, ` +
      'and one outside the closed set compares unequal to every entry of the ordering, ' +
      'making the ordering assertion unfalsifiable rather than failing'
    );
  }

  const stage = candidate['stage'];
  if (typeof stage !== 'string' || !AUDIT_STAGES.includes(stage as AuditStage)) {
    const known = JSON.stringify(AUDIT_STAGES);
    return `has stage ${JSON.stringify(stage)}, which is not one of ${known}`;
  }

  const invalidUser = describeInvalidSubject(candidate['user'], 'user');
  if (invalidUser !== null) {
    return invalidUser;
  }
  if (candidate['impersonatedUser'] !== undefined) {
    const invalidImpersonated = describeInvalidSubject(
      candidate['impersonatedUser'],
      'impersonatedUser',
    );
    if (invalidImpersonated !== null) {
      return invalidImpersonated;
    }
  }

  const sourceIPs = optionalNestedStringList(candidate, 'event', 'sourceIPs');
  if ('problem' in sourceIPs) {
    return sourceIPs.problem;
  }
  const userAgent = optionalNestedString(candidate, 'event', 'userAgent', false);
  if ('problem' in userAgent) {
    return userAgent.problem;
  }

  if (candidate['objectRef'] !== undefined) {
    const invalidObjectRef = describeInvalidObjectRef(candidate['objectRef']);
    if (invalidObjectRef !== null) {
      return invalidObjectRef;
    }
    // Both halves validated, so the two statements of identity can be compared.
    const contradiction = describeIdentityContradiction(
      candidate['requestURI'] as string,
      candidate['objectRef'] as Record<string, unknown>,
    );
    if (contradiction !== null) {
      return contradiction;
    }
  }

  if (candidate['responseStatus'] !== undefined) {
    const invalidStatus = describeInvalidResponseStatus(candidate['responseStatus']);
    if (invalidStatus !== null) {
      return invalidStatus;
    }
  }

  if (candidate['annotations'] !== undefined) {
    const invalidAnnotations = describeInvalidAnnotations(candidate['annotations']);
    if (invalidAnnotations !== null) {
      return invalidAnnotations;
    }
  }

  for (const key of [AUDIT_REQUEST_BODY_KEY, AUDIT_RESPONSE_BODY_KEY]) {
    const payload = optionalPayload(candidate, key);
    if ('problem' in payload) {
      return payload.problem;
    }
  }

  return null;
}

/**
 * Validates a whole page of events, returning the first problem found.
 *
 * The FIRST problem rather than all of them, deliberately: the page is refused either
 * way, so enumerating the rest adds length without adding a decision -- and the events
 * after a malformed one may be malformed in the same way, turning one contract mismatch
 * into fifty lines of identical text.
 */
function describeInvalidPage(items: readonly unknown[]): string | null {
  for (const [index, candidate] of items.entries()) {
    const problem = describeInvalidEvent(candidate);
    if (problem !== null) {
      return `event at index ${String(index)} ${problem}`;
    }
  }
  return null;
}

/**
 * Recovers the event page from a parsed response body.
 *
 * Accepts the canonical {@link AuditEventList} envelope and, equivalently, a
 * bare array of events. Returns a `problem` for anything else, which the caller turns
 * into an error state -- a body this hook cannot understand must never be
 * reported as a successful empty page.
 *
 * EVENTS ARE VALIDATED, AND NEVER FILTERED. The distinction is the whole design:
 *
 * - VALIDATED, because an unvalidated cast let anything through. `body as AuditEvent[]`
 *   is a compile-time assertion with no runtime effect, so a page of strings, of nulls,
 *   or of objects missing every required member became a "successful" page of events. The
 *   confidentiality guard then ran over values it could not interpret, and a
 *   `responseObject: true` -- the Go-flattened form -- satisfied every presence test
 *   while being invisible to object-shaped redaction.
 * - NEVER FILTERED, because dropping an event would defeat that same guard, which derives
 *   its strength from inspecting EVERY event the server returned rather than only the
 *   well-formed ones. A leaked Secret body might be carried by exactly the event a
 *   filter discarded.
 *
 * The two combine into one rule: a page containing an event this client cannot read is a
 * page it cannot make any claim about, so the whole page is refused.
 */
function parseAuditEventsPayload(
  body: unknown,
): { readonly page: ParsedAuditEventsPage } | { readonly problem: string } {
  if (Array.isArray(body)) {
    const items = body as readonly unknown[];
    const problem = describeInvalidPage(items);
    if (problem !== null) {
      return { problem };
    }
    return { page: { events: items as readonly AuditEvent[] } };
  }
  if (isRecord(body) && Array.isArray(body.items)) {
    const items = body.items as readonly unknown[];
    const problem = describeInvalidPage(items);
    if (problem !== null) {
      return { problem };
    }
    const parsed: ParsedAuditEventsPage = { events: items as readonly AuditEvent[] };
    if (body.total !== undefined) {
      // INVARIANT LOCKED (M13): a total is a COUNT, so it is a non-negative
      // integer. `Number.isFinite` alone accepted -3 and 2.5, and both then flowed
      // into `page * pageSize < total`, an arithmetic comparison that yields a
      // confident answer from a nonsensical input: a negative total makes every
      // page look like the last one, so incomplete data reports as complete.
      if (
        typeof body.total !== 'number' ||
        !Number.isInteger(body.total) ||
        body.total < 0
      ) {
        return {
          problem:
            `"total" is ${JSON.stringify(body.total)}; a total is a non-negative integer ` +
            'count. A negative or fractional total makes the page arithmetic report ' +
            'incomplete data as a final page',
        };
      }
      parsed.total = body.total;
    }
    if (body.hasMore !== undefined) {
      if (typeof body.hasMore !== 'boolean') {
        return { problem: `"hasMore" is ${describeJsonType(body.hasMore)}, not a boolean` };
      }
      parsed.hasMore = body.hasMore;
    }
    return { page: parsed };
  }
  return {
    problem:
      `the body is ${describeJsonType(body)}; the contract is an AuditEventList envelope ` +
      'or a bare array of events',
  };
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
    // Still `http`, not `payload`: the failing thing is the non-2xx STATUS, which
    // arrived and is reported. An unreadable body on an error response only costs
    // the server's own words, so the fallback message stands in for them.
    return { kind: 'http', httpStatus: response.status, message: fallbackMessage };
  }

  if (!isRecord(body)) {
    return { kind: 'http', httpStatus: response.status, message: fallbackMessage };
  }

  const failure: {
    kind: AuditEventsErrorKind;
    httpStatus: number;
    message: string;
    reason?: string;
    code?: number;
  } = {
    // A response arrived and its status was not a success: that is exactly `http`.
    kind: 'http',
    httpStatus: response.status,
    message:
      typeof body.message === 'string' && body.message.length > 0
        ? body.message
        : fallbackMessage,
  };
  if (typeof body.reason === 'string' && body.reason.length > 0) {
    failure.reason = body.reason;
  }
  // `Number.isFinite` was too weak: it admits 0, negatives and fractions, so a
  // body claiming `"code": 0` or `"code": 1.5` was surfaced as though a server had
  // chosen it, and a consumer rendering `code` would print a value no HTTP
  // registry defines. A response body is untrusted input; an integer inside the
  // status range is the only shape this field can legitimately hold.
  if (isHttpStatusCode(body.code)) {
    failure.code = body.code;
  }
  return failure;
}

/**
 * Narrows an unknown body field to a usable HTTP status code.
 *
 * Integer-and-in-range rather than merely numeric, because the three ways this
 * field goes wrong in practice are all finite numbers: `0` from a client that
 * fabricates a sentinel, a fraction from a bad serialiser, and an out-of-range
 * value from a field that was never a status at all.
 *
 * @param value - the raw `code` member of a decoded response body.
 * @returns true when `value` is an integer in `[100, 599]`.
 */
function isHttpStatusCode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_HTTP_STATUS_CODE &&
    value <= MAX_HTTP_STATUS_CODE
  );
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
    // Trusted only because {@link describeIncoherentPage} has already refused any
    // page whose `hasMore` contradicts its own item count and total. Precedence is
    // unchanged; what changed is that reaching here means the claim was checked.
    return hasMore;
  }
  if (typeof total === 'number') {
    return pageOffset(page, pageSize) + itemCount < total;
  }
  return itemCount >= pageSize;
}

/** Items the server is expected to have skipped before the requested page. */
function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/**
 * Reports pagination metadata that contradicts itself, given the page requested.
 *
 * INVARIANT LOCKED (M13): CONTRADICTORY METADATA IS REFUSED, never reconciled. The
 * failure this closes is specific and quiet — a page whose metadata says "this is
 * the last page" while its own numbers say otherwise turns incomplete data into a
 * successful final page, and a consumer that stops paging there reports a clean
 * confidentiality result about events it never fetched.
 *
 * The rules, each with the contradiction it catches:
 *
 *   * `items.length <= pageSize` — a server returning more items than were asked
 *     for is not honouring the page size, so no offset arithmetic about it holds.
 *   * when the requested offset is at or past `total`, the page must be EMPTY and
 *     must not promise more. This is the legitimate past-the-end request, and it is
 *     the reason the offset rule below is conditional rather than absolute.
 *   * otherwise `offset + items.length <= total` — a server cannot have already
 *     returned more items than it claims exist in total.
 *   * when `total` is known, an explicit `hasMore` must EQUAL the arithmetic. Two
 *     statements about whether more data exists that disagree cannot both be
 *     believed, and the optimistic one is the dangerous one.
 *   * `hasMore: true` with an empty page is refused even without a total: an empty
 *     page promising more, with no total to arbitrate, is the shape that makes a
 *     traversal either loop forever or stop while claiming completeness.
 *
 * `page` and `pageSize` are the hook's own, already clamped to positive integers,
 * so they are inputs to the check rather than subjects of it.
 *
 * @param page - the 1-based page requested.
 * @param pageSize - the page size requested.
 * @param parsed - the parsed page and its metadata.
 * @returns the contradiction, or `null` when the metadata is coherent.
 */
function describeIncoherentPage(
  page: number,
  pageSize: number,
  parsed: ParsedAuditEventsPage,
): string | null {
  const itemCount = parsed.events.length;
  const { total, hasMore } = parsed;

  if (itemCount > pageSize) {
    return (
      `the page carries ${String(itemCount)} events for a requested pageSize of ` +
      `${String(pageSize)}, so the server is not honouring the page size and no offset ` +
      'arithmetic over its metadata holds'
    );
  }

  if (hasMore === true && itemCount === 0 && total === undefined) {
    return (
      'the page is empty yet reports hasMore: true with no total to arbitrate. An empty ' +
      'page that promises another cannot be traversed: a consumer either loops forever ' +
      'or stops while still claiming to have seen everything'
    );
  }

  if (total === undefined) {
    return null;
  }

  const offset = pageOffset(page, pageSize);
  if (offset >= total) {
    if (itemCount > 0) {
      return (
        `the page starts at offset ${String(offset)} of a reported total of ` +
        `${String(total)} yet carries ${String(itemCount)} events, so the total ` +
        'contradicts the events already returned'
      );
    }
    if (hasMore === true) {
      return (
        `the page is past the end of a reported total of ${String(total)} yet reports ` +
        'hasMore: true'
      );
    }
    return null;
  }

  if (offset + itemCount > total) {
    return (
      `the page returns events ${String(offset + 1)}-${String(offset + itemCount)} of a ` +
      `reported total of ${String(total)}, so the server has already returned more ` +
      'events than it claims exist'
    );
  }

  if (hasMore !== undefined && hasMore !== offset + itemCount < total) {
    return (
      `the page reports hasMore: ${String(hasMore)} while its own numbers say ` +
      `${String(offset + itemCount)} of ${String(total)} events have been returned. Two ` +
      'statements about whether more data exists that disagree cannot both be believed'
    );
  }

  return null;
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
  // CLONED AND FROZEN on the way in. Storing the caller's object by reference made the
  // hook's state reachable from outside it: a caller holding `{ resource: 'secrets' }`
  // could later set `filter.resource = 'configmaps'`, and because React saw no state
  // change there was no re-render -- so `requestUrl` still described the old query while
  // the returned `filter` described the new one, and the two disagreed silently. Freezing
  // the clone additionally turns a mutation attempt into a visible failure in strict mode
  // rather than a no-op.
  const [filter, setFilterState] = useState<Readonly<AuditEventFilter>>(() =>
    Object.freeze({ ...initialFilter }),
  );
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
    // Set by the deadline BEFORE it aborts, because the abort signal alone cannot
    // say WHY the request ended without a response. A consumer cancellation must
    // leave the state untouched -- the effect that superseded it owns the state --
    // while a deadline must report a failure. Conflating them is what leaves this
    // hook in `loading` forever when a server accepts and never answers.
    let timedOut = false;

    setState({ status: 'loading', events: [], error: null });

    const deadline = setTimeout(() => {
      timedOut = true;
      // Flag first, then abort: the flag decides what is reported, the abort
      // releases the socket and stops any response being parsed.
      controller.abort();
      setState({
        status: 'error',
        events: [],
        error: { kind: 'timeout', message: AUDIT_EVENTS_TIMEOUT_MESSAGE },
      });
    }, AUDIT_EVENTS_REQUEST_TIMEOUT_MS);

    const run = async (): Promise<void> => {
      try {
        const response = await fetch(requestUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            // Belt to `cache: 'no-store'`'s braces. The fetch option governs the
            // HTTP cache this client owns; these headers ask every intermediary
            // between here and the API server not to answer from one either.
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
          },
          // INVARIANT LOCKED (F-006-RQ-003 freshness). Refresh MUST reach the
          // server. Without this the refresh button re-issued a byte-identical
          // cache-eligible GET, so a clean page cached before a confidentiality
          // violation could be replayed afterwards -- and the panel would report
          // "no Secret event carries a response body" about a page recorded before
          // the one that did. `no-store` is chosen over `no-cache` and over a
          // cache-busting query parameter: `no-cache` still writes the response to
          // the cache, and a synthetic parameter would change the request URL, so
          // the request the panel makes would no longer be the request the
          // recorded handler and the parity map describe.
          cache: 'no-store',
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
              // A 2xx arrived; the body is what could not be trusted.
              kind: 'payload',
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
        if ('problem' in parsed) {
          setState({
            status: 'error',
            events: [],
            error: {
              kind: 'payload',
              httpStatus: response.status,
              message:
                `audit event response is unusable: ${parsed.problem}. The page is refused ` +
                'rather than partially reported, because an event this client cannot read ' +
                'is an event the confidentiality guard cannot clear.',
            },
          });
          return;
        }

        const incoherent = describeIncoherentPage(page, pageSize, parsed.page);
        if (incoherent !== null) {
          setState({
            status: 'error',
            events: [],
            error: {
              kind: 'payload',
              httpStatus: response.status,
              message:
                `audit event pagination is incoherent: ${incoherent}. The page is refused ` +
                'rather than reported, because pagination metadata that contradicts ' +
                'itself is how incomplete data becomes a successful final page.',
            },
          });
          return;
        }

        // Straight through: the events are handed on untouched, only proven readable.
        // FROZEN, so no consumer can mutate the page a later assertion will read -- see
        // the invariant on UseAuditEventsResult.events.
        setState({
          status: 'success',
          events: Object.freeze(parsed.page.events.slice()),
          error: null,
          total: parsed.page.total,
          hasMore: parsed.page.hasMore,
          // Which page these events are. Captured from the closure that issued the
          // request, so it is the page actually asked for rather than whatever the page
          // state has since become.
          loadedPage: page,
        });
      } catch (cause) {
        if (timedOut) {
          // The deadline has already reported the timeout. The abort it raised
          // surfaces here as an AbortError; re-reporting it as a transport failure
          // would replace an accurate diagnosis with a vaguer one.
          return;
        }
        // A CONSUMER-cancelled request is not a failure and must leave the state
        // alone: the effect that superseded it owns the state now.
        if (signal.aborted || isAbortError(cause)) {
          return;
        }
        setState({
          status: 'error',
          events: [],
          // NO httpStatus. Nothing answered, so there is no status to report; this
          // used to fabricate `0`, which is not an HTTP status and which every
          // consumer then had to recognise as a sentinel.
          error: { kind: 'network', message: describeTransportFailure(cause) },
        });
      } finally {
        // Deterministic on every path -- success, HTTP error, payload error,
        // transport error, consumer abort, and the timeout itself. A timer that
        // outlived its request would fire against a LATER one, so it is cleared
        // here as well as in the cleanup below rather than only there.
        clearTimeout(deadline);
      }
    };

    void run();

    // Runs on unmount and before every superseding request.
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [enabled, requestUrl, refreshToken]);

  // Resolved from the page the held events BELONG TO, not from the current page state.
  // Between a page change and its response the two differ, and answering "is there a
  // further page after page 2?" from page 1's events and totals is how a traversal
  // either stops early or advances twice for one response.
  const loadedPage = state.loadedPage ?? page;
  const hasNextPage =
    state.status === 'success'
      ? resolveHasNextPage(loadedPage, pageSize, state.events.length, state.total, state.hasMore)
      : false;

  const setFilter = useCallback((next: Readonly<AuditEventFilter>) => {
    // Cloned for the same reason as the seed above: the caller keeps its object and may
    // mutate it, and a hook whose state can change without a render is a hook whose
    // rendered output can contradict the request it issued.
    setFilterState(Object.freeze({ ...next }));
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
    loadedPage: state.loadedPage,
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
