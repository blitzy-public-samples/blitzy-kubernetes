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

// AAP §0.5.1 (the `web/src/test/msw/handlers.ts` row -- "Per-control request
// handlers") / §0.4.4.3 (this file's role: "msw/handlers.ts holds one handler
// per control endpoint", with declarative request handlers as the ENTIRE mocking
// mechanism of the React tier) / §0.3.2 (the recorded wire shapes replayed
// below: SubjectAccessReview status, `ApiException` 403 bodies,
// TokenRequestStatus, `audit.k8s.io/v1` event JSON and EncryptionConfiguration
// YAML) / §0.4.1.2 (cross-language assertion semantics: the accumulate-versus-
// abort asymmetry must stay REACHABLE from here) / §0.10.2 (the boundary
// conditions that port unchanged) / tech-spec §6.6.3.4 (the documentation
// convention this provenance block and the per-symbol invariant comments below
// satisfy).
//
// THE INVARIANT THIS FILE LOCKS
//
//   Every mocked response is a RECORDED API-server contract, so no panel can
//   pass against an invented shape.
//
// Three consequences follow, and they are why this module exists at all rather
// than each spec hand-rolling its own responses:
//
//   1. Every success payload is served BY REFERENCE from the recorded fixtures
//      in ../fixtures. Nothing here restates a payload, so a correction to a
//      fixture reaches every handler instead of diverging from it.
//   2. Every failure response is a real Kubernetes `Status` document -- `kind`,
//      `apiVersion`, `metadata`, `status`, `message`, `reason`, `details` and
//      `code` -- composed exactly as `apierrors.NewForbidden`,
//      `NewNotFound` and `NewInternalError` compose it. An ad-hoc
//      `{ error: '...' }` body would typecheck, would look harmless, and would
//      defeat this file's entire purpose: `useControlStatus` reads `message`
//      and `reason` off that document, and `useAuditEvents` also reads `code`.
//   3. Audit events are handed on UNTOUCHED. `requestObject` and
//      `responseObject` are inspectable objects here, never presence booleans,
//      because the confidentiality guard is only assertable if there is an
//      object to detect. See SECTION 4.
//
// RULES POSITION
//
//   `review_rules` returns exactly one line: "No user rules provided." No rule
//   is invented here, and their absence is not treated as licence to lower the
//   bar -- AAP §0.11.1's enterprise-standard bar substitutes. The items that
//   bind this file hardest are "evidence over assumption" (serve recorded
//   payloads verbatim), "use the repository's existing mocking posture and no
//   more" (declarative handlers only -- no additional mocking framework, no
//   bespoke fake server, no `fetch` monkey-patch), "never weaken a boundary
//   condition" (SECTION 9 and SECTION 10 serve `timeoutSeconds: 5`,
//   `failurePolicy: Fail`, `sideEffects: None`, `admissionReviewVersions:
//   ['v1']`, `timeout: 3s`, strong-provider-first / `identity`-last, and no
//   `cachesize`, exactly as recorded), "no secrets, ever" (the only key
//   material anywhere in this tier is the documented NON-secret test key owned
//   by ../fixtures/encryptionConfig, served by reference and never restated),
//   and "cite only what the repository states" (the repository's own
//   requirement identifiers appear below; no external benchmark or hardening-
//   guide control number appears anywhere).
//
// DEPENDENCY DISCIPLINE (AAP §0.11.1, "respect the existing freeze")
//
//   The only third-party import is `msw`, already pinned at 2.15.0 in
//   web/package.json, and only its MSW 2 surface is used: `http.*` predicates
//   and `HttpResponse`. No MSW 1 idiom appears -- no `rest.*`, no
//   `res(ctx.json(...))`. No npm dependency is added, no Node built-in is
//   imported, and no `@types/node` global (`process`, `__dirname`, `global`) is
//   referenced; `URL`, `URLSearchParams` and `Headers` come from the DOM lib
//   web/tsconfig.json already declares.
//
// THIS IS NOT A SPEC FILE, AND IT MUST NOT BECOME ONE
//
//   web/vitest.config.ts collects `src/**/*.test.{ts,tsx}` only, so a
//   `describe`, `it` or `test` written here would SILENTLY never run. There are
//   none, and there are no lifecycle hooks either. Constructing the server is
//   web/src/test/msw/server.ts's job alone: this module builds handlers and has
//   no module-level side effect beyond binding names.

import { http, HttpResponse, type RequestHandler } from 'msw';

import {
  AUDIT_EVENTS_DEFAULT_PAGE_SIZE,
  AUDIT_EVENTS_ENDPOINT,
  AUDIT_EVENTS_QUERY_PARAMS,
  type AuditEvent,
} from '../../hooks/useAuditEvents';
import {
  CONTROL_IDS,
  controlStatusPath,
  type ControlId,
  type ControlStatus,
} from '../../hooks/useControlStatus';
import { ALL_OBSERVED_AUDIT_EVENTS } from '../fixtures/auditEvents';
import {
  FAIL_CLOSED_WEBHOOK,
  FORBIDDEN_CONTROL_STATUS_ERROR,
  FORBIDDEN_STATUS,
  INTERNAL_SERVER_ERROR_STATUS,
  NOT_FOUND_STATUS,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V1_FULL_WILDCARD_ATTRIBUTES,
  V1_PERMITTED_WILDCARD_GROUP,
  V1_PERMITTED_WILDCARD_ROLE,
  V1_PERMITTED_WILDCARD_SUBJECT_KIND,
  V2_GENERATED_ADMISSION_CONFIG,
  V2_NAMESPACES,
  V2_PODS,
  V2_RESTRICTED_WARNINGS,
  V4_AUDIENCES,
  V4_NAMESPACE,
  V4_OBSERVED_EXPIRY,
  V4_REQUESTED_TTL_SECONDS,
  V4_SERVICE_ACCOUNT_NAME,
  V7_PRINCIPALS,
  controlStatusFixture,
  controlStatusListFixture,
  type RecordedWebhookPosture,
} from '../fixtures/controlStatus';
import {
  DEPLOYMENT_ENCRYPTION_CONFIG,
  INTEGRATION_AESGCM_ENCRYPTION_CONFIG_YAML,
} from '../fixtures/encryptionConfig';

// ---------------------------------------------------------------------------
// SECTION 1 -- The Kubernetes `Status` error envelope.
//
// Measured from staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go
// (`type Status`) and staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go
// (`NewForbidden`, `NewNotFound`, `NewInternalError`). The message forms below
// are those constructors' own `fmt.Sprintf` formats, reproduced branch for
// branch, which is what lets a served message be byte-identical to the message
// the recorded error fixtures already carry.
// ---------------------------------------------------------------------------

/**
 * The `Status.reason` values this tier serves.
 *
 * A closed union rather than `string`, so a typo is a `tsc --noEmit` error
 * instead of a reason no consumer recognises. `useControlStatus` surfaces this
 * value verbatim as `ControlStatusError.reason` and `useAuditEvents` as
 * `AuditEventsError.reason`, which is the wire-level counterpart of the Go
 * oracle's `apierrors.IsForbidden` inspection
 * (`podsecurity_test.go` L407, L419; `node_test.go` via `expectForbidden`).
 */
export type KubernetesStatusReason =
  | 'Forbidden'
  | 'NotFound'
  | 'InternalError'
  | 'Unauthorized'
  | 'Invalid'
  | 'BadRequest';

/**
 * The `Status.details` sub-document.
 *
 * `group` is the EMPTY STRING for the core API group, exactly as the wire
 * carries it -- an absent `group` and a core-group `group` are different
 * claims, so the empty string is preserved rather than omitted.
 */
export interface KubernetesStatusDetails {
  /** API group of the failing resource; `''` for the core group. */
  readonly group: string;
  /** Plural resource name, e.g. `pods`, `nodes`, `secrets`. */
  readonly kind: string;
  /** Name of the failing object; `''` when the request addressed a collection. */
  readonly name: string;
}

/**
 * A Kubernetes `Status` document, as returned with every non-2xx API response.
 *
 * Invariant locked: `code` is present in the BODY as well as being the HTTP
 * status of the response that carries it. A real API server sets both, and the
 * two hooks read them from different places -- `useControlStatus` branches on
 * the HTTP status while `useAuditEvents` preserves the body's `code`
 * separately, precisely because they are distinct fields that may disagree.
 * Serving only one of them would leave half of that behaviour untestable.
 */
export interface KubernetesStatus {
  readonly kind: 'Status';
  readonly apiVersion: 'v1';
  /** Always empty on an error `Status`; kept so the document is complete. */
  readonly metadata: Readonly<Record<string, never>>;
  readonly status: 'Failure';
  /** Human-readable text, composed by the factories below. */
  readonly message: string;
  readonly reason: KubernetesStatusReason;
  /** Absent where the API server itself omits it, e.g. on an internal error. */
  readonly details?: KubernetesStatusDetails;
  /** Numeric HTTP status, duplicated in the body exactly as the wire does. */
  readonly code: number;
}

/**
 * Splits a qualified resource into its `details` members.
 *
 * Reproduces `schema.ParseGroupResource`: `GroupResource.String()` renders as
 * `<resource>.<group>`, so everything before the FIRST `.` is the resource and
 * the remainder is the group. `pods` therefore yields the core group as `''`,
 * and `controls.posture.k8s.io` yields group `posture.k8s.io`.
 *
 * @param qualifiedResource - a rendered `GroupResource`, or `''` for none.
 * @returns the `group`/`kind` pair, with `name` left to the caller.
 */
function parseQualifiedResource(qualifiedResource: string): {
  readonly group: string;
  readonly kind: string;
} {
  const separator = qualifiedResource.indexOf('.');
  if (separator === -1) {
    return { group: '', kind: qualifiedResource };
  }
  return {
    group: qualifiedResource.slice(separator + 1),
    kind: qualifiedResource.slice(0, separator),
  };
}

/**
 * Builds a `Status` document from an already-composed message.
 *
 * Exported because a spec asserting on an error state should be able to build
 * the expected document from the same code that served it, rather than
 * approximating the envelope a second time. The four callers below are the
 * only places this tier composes a message.
 *
 * @param reason - the `Status.reason`.
 * @param code - the numeric HTTP status, placed in `Status.code`.
 * @param message - the fully composed human-readable text.
 * @param qualifiedResource - rendered `GroupResource`; omit for no `details`.
 * @param name - object name, or `''` for a collection-scoped failure.
 * @returns the document, ready for {@link HttpResponse.json}.
 */
export function kubernetesStatus(
  reason: KubernetesStatusReason,
  code: number,
  message: string,
  qualifiedResource?: string,
  name = '',
): KubernetesStatus {
  if (qualifiedResource === undefined || qualifiedResource === '') {
    return {
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message,
      reason,
      code,
    };
  }
  const { group, kind } = parseQualifiedResource(qualifiedResource);
  return {
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    message,
    reason,
    details: { group, kind, name },
    code,
  };
}

/**
 * A `403 Forbidden` response, composed exactly as `apierrors.NewForbidden`.
 *
 * All three of that constructor's message branches are reproduced, because the
 * recorded error fixtures span two of them: an empty `qualifiedResource` yields
 * `forbidden: <detail>`, an empty `name` yields
 * `<resource> is forbidden: <detail>` (the collection-scope form the recorded
 * posture 403 uses), and otherwise `<resource> "<name>" is forbidden: <detail>`
 * (the object form the recorded PodSecurity and NodeRestriction denials use).
 *
 * Invariant locked: this is the ONLY way this tier expresses a refusal. An
 * ad-hoc error object would leave `useControlStatus` with no `reason` to
 * surface and would make a 403 indistinguishable from a malformed payload.
 *
 * @param qualifiedResource - rendered `GroupResource`, e.g. `pods`.
 * @param name - object name, or `''` for a collection-scoped denial.
 * @param detail - the authorization detail, i.e. the `%v` of the format.
 * @returns the response, carrying `403` on the wire AND in `Status.code`.
 */
export function forbiddenStatus(
  qualifiedResource: string,
  name: string,
  detail: string,
): HttpResponse<KubernetesStatus> {
  let message: string;
  if (qualifiedResource === '') {
    message = `forbidden: ${detail}`;
  } else if (name === '') {
    message = `${qualifiedResource} is forbidden: ${detail}`;
  } else {
    message = `${qualifiedResource} ${JSON.stringify(name)} is forbidden: ${detail}`;
  }
  return HttpResponse.json(
    kubernetesStatus('Forbidden', FORBIDDEN_STATUS, message, qualifiedResource, name),
    { status: FORBIDDEN_STATUS },
  );
}

/**
 * A `404 Not Found` response, composed exactly as `apierrors.NewNotFound`.
 *
 * WHY THIS EXISTS AT ALL, and why it must stay distinct from
 * {@link forbiddenStatus}. `node_test.go` L1632-L1636 records the hazard in its
 * own words: node2 MUST be created before asserting that node1 cannot modify
 * it, "otherwise the cross-node UpdateStatus returns NotFound instead of the
 * deterministic Forbidden result the V7 assertion requires". A 404 is silence,
 * and silence is not a denial -- so a handler set that could not produce a 404
 * distinguishable from a 403 could not express why that ordering matters
 * (F-007-RQ-002). Neither status is ever presentable as a pass: both resolve to
 * the hooks' error arms, which carry no verdict at all.
 *
 * @param qualifiedResource - rendered `GroupResource`; `''` yields the API
 *   server's generic "could not find the requested resource" text.
 * @param name - the name that was addressed.
 * @returns the response, carrying `404` on the wire AND in `Status.code`.
 */
export function notFoundStatus(
  qualifiedResource: string,
  name: string,
): HttpResponse<KubernetesStatus> {
  const message =
    qualifiedResource === ''
      ? 'the server could not find the requested resource'
      : `${qualifiedResource} ${JSON.stringify(name)} not found`;
  return HttpResponse.json(
    kubernetesStatus('NotFound', NOT_FOUND_STATUS, message, qualifiedResource, name),
    { status: NOT_FOUND_STATUS },
  );
}

/**
 * A `500 Internal Server Error` response, composed exactly as
 * `apierrors.NewInternalError`: the message is `Internal error occurred: <detail>`.
 *
 * `details` is deliberately ABSENT. The Go constructor records the cause under
 * `details.causes` rather than naming a resource, so fabricating a
 * `group`/`kind`/`name` triple here would be an invented shape. Recorded
 * alongside the 403 because the two must render identically -- as an error,
 * with no verdict -- for opposite reasons: 403 means the caller may not know,
 * 500 means nobody knows, and neither is evidence that a control holds.
 *
 * @param detail - the underlying error text, i.e. the `%v` of the format.
 * @returns the response, carrying `500` on the wire AND in `Status.code`.
 */
export function internalErrorStatus(detail: string): HttpResponse<KubernetesStatus> {
  return HttpResponse.json(
    kubernetesStatus(
      'InternalError',
      INTERNAL_SERVER_ERROR_STATUS,
      `Internal error occurred: ${detail}`,
    ),
    { status: INTERNAL_SERVER_ERROR_STATUS },
  );
}

/**
 * A `400 Bad Request` response, composed as `apierrors.NewBadRequest`, whose
 * message is the detail unadorned.
 *
 * Reached only by a request body this tier cannot read as the document its
 * endpoint expects -- see SECTION 5. It exists so that a malformed request
 * fails loudly rather than being answered with a plausible-looking decision,
 * which for an authorization endpoint would be the worst possible response.
 *
 * @param detail - the complete message.
 * @returns the response, carrying `400` on the wire AND in `Status.code`.
 */
export function badRequestStatus(detail: string): HttpResponse<KubernetesStatus> {
  return HttpResponse.json(kubernetesStatus('BadRequest', 400, detail), { status: 400 });
}

// ---------------------------------------------------------------------------
// SECTION 2 -- The HTTP warning channel.
//
// Recovered from the V2 oracle rather than assumed: `podsecurity_test.go`
// L430-L435 captures warnings through `rest.WarningHandler`
// (`recordingWarningHandler`, mutex-guarded), and in the Kubernetes REST
// protocol those travel as HTTP `Warning` response headers with RFC 7234
// warn-code 299 -- not as a JSON field.
//
// A DOCUMENTED DIVERGENCE, resolved in favour of the typed contract:
// `ControlStatus` in web/src/hooks/useControlStatus.ts DOES model
// `warnings: readonly string[]`, and the hook is the contract this tier is
// typechecked against, so the posture payload carries the warning list in its
// body. The `Warning` header is emitted ALONGSIDE it -- additively, and only
// when the served payload actually carries warnings -- so the recorded protocol
// fact is preserved without inventing a field and without contradicting the
// hook. The hook ignores response headers, so nothing is at risk either way;
// the header is there for a spec that wants to assert the wire behaviour.
// ---------------------------------------------------------------------------

/** The response header the API server's warning channel uses. */
export const WARNING_HEADER_NAME = 'Warning';

/**
 * The RFC 7234 warn-code for "miscellaneous persistent warning", which is the
 * code the Kubernetes API server emits.
 */
export const WARNING_CODE = 299;

/**
 * Renders one `Warning` header value.
 *
 * The RFC 7234 form is `<warn-code> <warn-agent> <warn-text>`; the API server
 * emits `-` as the agent and a quoted string as the text. `JSON.stringify`
 * performs the quoting so that a warning containing a quote character cannot
 * produce a malformed header.
 *
 * @param text - the warning text, exactly as recorded.
 * @returns e.g. `299 - "would violate PodSecurity ..."`.
 */
export function warningHeaderValue(text: string): string {
  return `${WARNING_CODE} - ${JSON.stringify(text)}`;
}

/**
 * Builds the `Warning` headers for a set of recorded warnings.
 *
 * Invariant locked: one header value PER warning, appended in the recorded
 * order, because the oracle counts warnings (`podsecurity_test.go` L451-L455
 * fails when the count is zero) and joining them into a single value would turn
 * a countable list into one opaque string. Returns `undefined` for an empty
 * list so that a response with nothing to warn about carries no header at all,
 * which is what makes the presence of the header meaningful.
 *
 * @param warnings - the recorded warning texts.
 * @returns headers to merge into the response, or `undefined`.
 */
function warningHeaders(warnings: readonly string[]): Headers | undefined {
  if (warnings.length === 0) {
    return undefined;
  }
  const headers = new Headers();
  for (const warning of warnings) {
    headers.append(WARNING_HEADER_NAME, warningHeaderValue(warning));
  }
  return headers;
}


// ---------------------------------------------------------------------------
// SECTION 3 -- The control-posture endpoints.
//
// EVERY URL BELOW IS DERIVED, NEVER INVENTED. `controlStatusPath` in
// web/src/hooks/useControlStatus.ts is the single definition site of this
// surface: called with a `ControlId` it addresses that control's own endpoint --
// the one each panel queries -- and called with nothing it addresses the
// collection the aggregate dashboard queries. Importing the function rather than
// spelling `/api/posture/controls/V1` here is what makes a path change
// impossible to get half-applied.
//
// The default set registers ONE HANDLER PER CONTROL ENDPOINT (AAP §0.4.4.3),
// which means eight explicit paths rather than one `:controlId` pattern. That is
// deliberate: with `onUnhandledRequest: 'error'` in web/src/test/msw/server.ts,
// a request for anything outside the recorded roster surfaces as a loud
// unhandled request instead of being answered by a catch-all that would have to
// guess what to say.
// ---------------------------------------------------------------------------

/**
 * The qualified resource the recorded posture failures name.
 *
 * Not a free invention: it is the resource embedded in
 * {@link FORBIDDEN_CONTROL_STATUS_ERROR}'s recorded message
 * (`controls.posture.k8s.io is forbidden: ...`), lifted into a constant so the
 * `Status.details` this tier serves and that recorded message cannot disagree.
 */
const POSTURE_CONTROLS_QUALIFIED_RESOURCE = 'controls.posture.k8s.io';

/**
 * Serves ONE recorded control payload at that control's own endpoint.
 *
 * The body is the payload object on its own, which is what the per-control
 * endpoint naturally returns and one of the three body shapes
 * `useControlStatus` accepts. `Warning` headers are attached automatically when
 * -- and only when -- the payload carries warnings, so the recorded `warn`
 * outcome arrives over the wire the way the API server sends it (SECTION 2)
 * while the hook still reads the list from the body.
 *
 * Invariant locked: the payload is passed through UNTOUCHED. Nothing is merged
 * into it, defaulted, reordered or normalised, so what a spec imports from
 * ../fixtures/controlStatus is exactly what the panel under test receives.
 *
 * @param controlId - which control's endpoint to register.
 * @param status - the recorded payload to serve.
 * @returns the handler, for `handlers` or for `server.use(...)`.
 */
export function controlStatusHandler(
  controlId: ControlId,
  status: ControlStatus,
): RequestHandler {
  const headers = warningHeaders(status.warnings);
  return http.get(controlStatusPath(controlId), () =>
    HttpResponse.json(status, headers === undefined ? undefined : { headers }),
  );
}

/**
 * Serves a LIST of recorded payloads, in a Kubernetes-style `items` envelope.
 *
 * Two states need this rather than {@link controlStatusHandler}: the aggregate
 * dashboard, which reads every control from the collection endpoint, and the
 * explicit EMPTY state, which is a successful response carrying no controls at
 * all. An empty list is a legitimate argument and resolves to the hook's
 * `isEmpty: true` -- distinct from an error, and distinct from a set of failing
 * controls.
 *
 * Serving the `items` envelope here while {@link controlStatusHandler} serves a
 * bare object is deliberate coverage: the hook accepts three body shapes, and a
 * handler set that only ever emitted one would leave the others unexercised.
 *
 * @param target - the control endpoint to register, or `undefined` for the
 *   collection endpoint.
 * @param statuses - the recorded payloads, in the order to serve them.
 * @returns the handler, for `handlers` or for `server.use(...)`.
 */
export function controlStatusListHandler(
  target: ControlId | undefined,
  statuses: readonly ControlStatus[],
): RequestHandler {
  return http.get(controlStatusPath(target), () => HttpResponse.json({ items: statuses }));
}

/**
 * Serves the recorded `403 Forbidden` refusal on a posture endpoint.
 *
 * The message and reason are taken from {@link FORBIDDEN_CONTROL_STATUS_ERROR},
 * so the `ControlStatusError` the hook surfaces is byte-identical to the
 * fixture a spec asserts against -- one definition site for the failure, not
 * two approximations of it.
 *
 * Invariant locked (AAP §0.11.1, "no false passes"): a 403 can never become a
 * verdict. `ControlStatusErrorResult` has no `controls` member, so rendering
 * this as a pass is a `tsc --noEmit` error rather than a review question. This
 * handler is what makes that structural guarantee testable, and every panel spec
 * needs it -- for V2 the recorded rejections are 403
 * (`podsecurity_test.go` L407, L419) and for V7 both denials are 403
 * (`node_test.go` L1653-L1668).
 *
 * @param controlId - the control endpoint to refuse, or `undefined` for the
 *   collection endpoint.
 * @returns the handler, for `server.use(...)`.
 */
export function forbiddenControlStatusHandler(controlId?: ControlId): RequestHandler {
  return http.get(controlStatusPath(controlId), () =>
    HttpResponse.json(
      kubernetesStatus(
        FORBIDDEN_CONTROL_STATUS_ERROR.reason,
        FORBIDDEN_STATUS,
        FORBIDDEN_CONTROL_STATUS_ERROR.message,
        POSTURE_CONTROLS_QUALIFIED_RESOURCE,
        controlId ?? '',
      ),
      { status: FORBIDDEN_STATUS },
    ),
  );
}

/**
 * Serves a `404 Not Found` on a posture endpoint.
 *
 * Kept as its own factory, separate from the 403 above, because the two must
 * stay distinguishable: a 404 says the evidence was never reached, a 403 says
 * the caller may not have it, and collapsing them would erase the very
 * distinction `node_test.go`'s ordering comment exists to protect. Neither is a
 * pass. The corresponding presentation-layer payload -- for a check that
 * returned NotFound where a Forbidden was required -- is the recorded
 * `V7_NODE_RESTRICTION_NOT_FOUND`, served through
 * {@link controlStatusHandler}.
 *
 * @param controlId - the control endpoint to answer, or `undefined` for the
 *   collection endpoint.
 * @returns the handler, for `server.use(...)`.
 */
export function notFoundControlStatusHandler(controlId?: ControlId): RequestHandler {
  return http.get(controlStatusPath(controlId), () =>
    notFoundStatus(POSTURE_CONTROLS_QUALIFIED_RESOURCE, controlId ?? ''),
  );
}

/**
 * Serves the recorded `500 Internal Server Error` on a posture endpoint.
 *
 * The message and reason come from {@link SERVER_ERROR_CONTROL_STATUS_ERROR}
 * for the same single-definition-site reason as the 403 above. The detail is
 * recovered from the recorded message by stripping the constructor's own
 * `Internal error occurred: ` prefix, so {@link internalErrorStatus} can
 * re-compose the identical text instead of this file carrying a second copy of
 * it.
 *
 * @param controlId - the control endpoint to fail, or `undefined` for the
 *   collection endpoint.
 * @returns the handler, for `server.use(...)`.
 */
export function internalErrorControlStatusHandler(controlId?: ControlId): RequestHandler {
  const prefix = 'Internal error occurred: ';
  const recorded = SERVER_ERROR_CONTROL_STATUS_ERROR.message;
  const detail = recorded.startsWith(prefix) ? recorded.slice(prefix.length) : recorded;
  return http.get(controlStatusPath(controlId), () => internalErrorStatus(detail));
}


// ---------------------------------------------------------------------------
// SECTION 4 -- The audit-event endpoint.
//
// URL and query surface derived from web/src/hooks/useAuditEvents.ts:
// `AUDIT_EVENTS_ENDPOINT`, `AUDIT_EVENTS_QUERY_PARAMS` and
// `AUDIT_EVENTS_DEFAULT_PAGE_SIZE` are imported rather than re-spelled, which
// the hook itself asks for -- it exports them so "the MSW handler matches on
// these names, so sharing the literals removes any chance of a silent mismatch
// between the hook and its test double". The handler path carries NO query
// string, because MSW warns about redundant query parameters in a predicate;
// the query is read from the request URL instead.
//
// THE HIGHEST-RISK REQUIREMENT IN THIS FILE (F-006-RQ-003, mirroring
// F-006-RQ-002 from test/integration/controlplane/audit/audit_test.go
// L1043-L1047):
//
//   `requestObject` and `responseObject` pass through EXACTLY as recorded --
//   never stripped, synthesised, reordered or coerced.
//
// test/utils/audit.go will actively mislead a reader here. Its helper struct
// (L48-L49) types both as `bool`, and `testEventFromInternalFiltered` does
// `if e.ResponseObject != nil { event.ResponseObject = true }`. That is a
// FLATTENED TEST PROJECTION for cheap Go-side struct comparison, NOT the
// contract: the `audit.k8s.io/v1` event types both as `*runtime.Unknown`, i.e.
// inspectable objects, which is exactly what `AuditEvent` in
// web/src/hooks/useAuditEvents.ts declares. Serving booleans would leave
// ConfidentialityRedaction.test.tsx with no object to detect and the guard
// would silently become unprovable while every spec stayed green.
//
// The recorded default set is ALL_OBSERVED_AUDIT_EVENTS -- nine events: three
// `secrets` events at level `Request` with `requestObject` present and NO
// `responseObject`, and six RBAC events at `RequestResponse` carrying BOTH. The
// Go guard scans `missingReport.AllEvents`, a SUPERSET of the expectations,
// precisely so a regression is caught even if the expected table were edited to
// match it; serving the whole observed set is what preserves that property here.
// The six RBAC events are the control group: they prove a redacting UI redacts
// only what it should.
// ---------------------------------------------------------------------------

/**
 * The qualified resource named by an audit-endpoint failure.
 *
 * Derived from the recorded events themselves rather than invented: their
 * `apiVersion` is `audit.k8s.io/v1` and their `kind` is `Event`, so the
 * rendered `GroupResource` is `events.audit.k8s.io`, which
 * {@link parseQualifiedResource} splits back into group `audit.k8s.io` and kind
 * `events`.
 */
const AUDIT_EVENTS_QUALIFIED_RESOURCE = 'events.audit.k8s.io';

/**
 * Reads a positive-integer query parameter, falling back when it is absent or
 * unusable.
 *
 * Mirrors the hook's own `clampToPositiveInteger` guard against `NaN`,
 * `Infinity`, zero, negatives and fractions -- none of which a server could
 * honour. The hook's guard is module-private, so this is a deliberate local
 * re-statement of the same rule rather than an import; both exist so that a
 * hand-built URL in a spec behaves the way the hook's own URLs do.
 *
 * @param query - the request's search parameters.
 * @param name - the parameter name, from `AUDIT_EVENTS_QUERY_PARAMS`.
 * @param fallback - the value to use when the parameter is unusable.
 * @returns a positive integer.
 */
function readPositiveInteger(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * Reads a filter parameter, treating an empty value as absent.
 *
 * The hook sends a filter field only when it is a non-empty string, so an empty
 * value can only reach here from a hand-built URL. Treating `?resource=` as "no
 * resource filter" rather than as "match the empty resource" keeps that case
 * from silently returning an empty page that looks like a real empty result.
 *
 * @param query - the request's search parameters.
 * @param name - the parameter name, from `AUDIT_EVENTS_QUERY_PARAMS`.
 * @returns the value, or `undefined` when absent or empty.
 */
function readFilterParameter(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  return raw === null || raw === '' ? undefined : raw;
}

/**
 * Decides whether one recorded event satisfies the request's filter.
 *
 * Invariant locked: every comparison is EXACT. Nothing is lower-cased, trimmed,
 * prefix-matched or fuzzy-matched, because an audit view that quietly widened
 * `resource=secrets` into something broader would report on events the operator
 * did not ask about -- and one that quietly narrowed it would hide events the
 * confidentiality guard needs to see. An unrecognised value therefore matches
 * nothing, which is a truthful empty result rather than a silent fallback to
 * "everything".
 *
 * `namespace` and `resource` are read from `objectRef`, which the wire omits
 * entirely for non-resource requests; such an event cannot satisfy either
 * filter, so the optional chain resolving to `undefined` correctly excludes it.
 *
 * @param event - the recorded event.
 * @param query - the request's search parameters.
 * @returns `true` when every present filter matches.
 */
function matchesAuditFilter(event: AuditEvent, query: URLSearchParams): boolean {
  const level = readFilterParameter(query, AUDIT_EVENTS_QUERY_PARAMS.level);
  if (level !== undefined && event.level !== level) {
    return false;
  }
  const namespace = readFilterParameter(query, AUDIT_EVENTS_QUERY_PARAMS.namespace);
  if (namespace !== undefined && event.objectRef?.namespace !== namespace) {
    return false;
  }
  const resource = readFilterParameter(query, AUDIT_EVENTS_QUERY_PARAMS.resource);
  if (resource !== undefined && event.objectRef?.resource !== resource) {
    return false;
  }
  const verb = readFilterParameter(query, AUDIT_EVENTS_QUERY_PARAMS.verb);
  return verb === undefined || event.verb === verb;
}

/**
 * Serves a filtered, paginated page of recorded audit events.
 *
 * Invariants locked:
 *
 *   1. Events are served BY REFERENCE and in the recorded order. The page is a
 *      `slice` of a `filter`, so each element is the very object the fixture
 *      exported -- `requestObject` and `responseObject` included, untouched.
 *      Nothing is cloned, re-serialised field by field, sorted or renumbered.
 *   2. `total` counts the matches across ALL pages, not the page, which is what
 *      the hook's `total` arithmetic needs to resolve `hasNextPage`.
 *   3. `hasMore` is computed from the slice's own position, so it is `false` on
 *      the last page and on a page past the end -- an empty page is honestly
 *      empty rather than implying more to come.
 *
 * The full `AuditEventList` envelope is served rather than a bare array so the
 * hook's documented precedence -- explicit `hasMore` first, then `total`
 * arithmetic, then the full-page heuristic -- is exercised at its first rung.
 *
 * @param events - the recorded events to serve; pass `[]` for the empty state.
 * @returns the handler, for `handlers` or for `server.use(...)`.
 */
export function auditEventsHandler(events: readonly AuditEvent[]): RequestHandler {
  return http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
    const query = new URL(request.url).searchParams;
    const page = readPositiveInteger(query, AUDIT_EVENTS_QUERY_PARAMS.page, 1);
    const pageSize = readPositiveInteger(
      query,
      AUDIT_EVENTS_QUERY_PARAMS.pageSize,
      AUDIT_EVENTS_DEFAULT_PAGE_SIZE,
    );
    const matched = events.filter((event) => matchesAuditFilter(event, query));
    const start = (page - 1) * pageSize;
    const items = matched.slice(start, start + pageSize);
    return HttpResponse.json({
      items,
      total: matched.length,
      hasMore: start + items.length < matched.length,
    });
  });
}

/**
 * Refuses the audit listing with `403 Forbidden`.
 *
 * Invariant locked: a refusal is NEVER an empty page. The hook reports
 * `status: 'error'` with `isEmpty` false, so a panel cannot render "no audit
 * events" -- a clean bill of health -- for a request the server declined. The
 * message names the requirement that cannot be reported without the listing, so
 * a CI reader who did not write the spec still learns what was lost.
 *
 * @returns the handler, for `server.use(...)`.
 */
export function forbiddenAuditEventsHandler(): RequestHandler {
  return http.get(AUDIT_EVENTS_ENDPOINT, () =>
    forbiddenStatus(
      AUDIT_EVENTS_QUALIFIED_RESOURCE,
      '',
      'User cannot list resource "events" in API group "audit.k8s.io" at the ' +
        'cluster scope; sensitive-resource audit fidelity (F-006-RQ-003) cannot ' +
        'be reported without it',
    ),
  );
}

/**
 * Fails the audit listing with `500 Internal Server Error`.
 *
 * Recorded alongside the 403 for the same reason the posture endpoints carry
 * both: the two must render identically -- as an error, never as an empty
 * result -- because neither is evidence about audit fidelity.
 *
 * @returns the handler, for `server.use(...)`.
 */
export function internalErrorAuditEventsHandler(): RequestHandler {
  return http.get(AUDIT_EVENTS_ENDPOINT, () =>
    internalErrorStatus(
      'audit event evaluation failed; sensitive-resource audit fidelity ' +
        '(F-006-RQ-003) is unreported',
    ),
  );
}


// ---------------------------------------------------------------------------
// SECTIONS 5 THROUGH 10 -- The recorded API-server contract replays.
//
// AAP §0.3.2 requires this tier to replay "the exact API-server wire shapes the
// Go tests assert on -- SubjectAccessReview status, `ApiException` 403 bodies,
// TokenRequestStatus, `audit.k8s.io/v1` event JSON, and EncryptionConfiguration
// YAML", because the React tier has no parity ancestor (tech-spec §7.1: "No
// user interface required") and its fidelity anchor is therefore the contracts
// it replays. The sections below are those contracts.
//
// ON THE PATHS USED HERE. The posture paths in SECTIONS 3 and 4 are imported
// from the hooks and nothing is invented. The paths below are the PUBLISHED
// Kubernetes REST API grammar for the operations the Go originals perform
// through client-go, and each is corroborated inside this repository:
// `/api/v1/namespaces/<ns>/<resource>` and
// `/apis/<group>/v1/namespaces/<ns>/<resource>` are the exact `requestURI`
// values recorded in ../fixtures/auditEvents, and each group/version below is a
// recorded `apiVersion` -- `authorization.k8s.io/v1` from the V1 oracle's
// `AuthorizationV1().SubjectAccessReviews()`, `authentication.k8s.io/v1` from
// the V4 oracle's `TokenRequest`, and `admissionregistration.k8s.io/v1` from the
// committed webhook manifest's line 1. No path is guessed.
//
// A small set of local narrowing helpers appears first. They read posted request
// bodies without `any`, which matters because `tsc --noEmit` runs under `strict`
// and a widened body type would silently disable checking for every field read
// afterwards. The equivalent helpers in the hooks are module-private and cannot
// be imported, so these are a deliberate local restatement of the same rule.
// ---------------------------------------------------------------------------

/** A parsed JSON object, before any field has been narrowed. */
type JsonRecord = Record<string, unknown>;

/**
 * Narrows an unknown JSON value to a plain object.
 *
 * Arrays are excluded deliberately: `typeof [] === 'object'` in JavaScript, and
 * treating a list as a record is how a wire-shape mismatch turns into a silent
 * misread instead of a reported one.
 *
 * @param value - any parsed JSON value.
 * @returns the object, or `undefined`.
 */
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/**
 * Names the JSON type of a value, for a rejection message.
 *
 * Reports the TYPE and never the value, so a malformed body cannot be echoed
 * back into a diagnostic. `null` and `array` are named separately from `object`
 * because JavaScript reports all three as `'object'` and the distinction is
 * exactly what these validators exist to enforce.
 *
 * @param value - any parsed JSON value.
 * @returns one of `absent`, `null`, `array`, `object`, `string`, `number`,
 *   `boolean`.
 */
function describeJsonType(value: unknown): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * The outcome of reading one field: either a value or the reason it is not one.
 *
 * A discriminated union rather than `T | undefined`, because "absent" and
 * "present but the wrong shape" must reach DIFFERENT responses. Collapsing them
 * is the defect class this whole section replaces: a filter or a `?? fallback`
 * turns a malformed request into a well-formed one and answers it with the
 * recorded outcome, which is the one response a contract replay must never give.
 */
type FieldRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a list of strings, keeping order and duplicates, rejecting anything else.
 *
 * `Array.isArray` alone widens its argument to a list of `any`, which would
 * disable checking for every element read afterwards; re-typing through
 * `readonly unknown[]` restores it. Order and duplicates are preserved because
 * for an audience list both the contents and the cardinality are meaningful
 * (F-004-RQ-001) -- a token additionally bound to a second audience is a
 * different, weaker credential.
 *
 * Invariant locked: a non-string MEMBER rejects the whole field. Filtering it
 * out -- which is what this helper used to do -- silently converted
 * `audiences: [123]` into `[]` and then into the recorded compliant audience
 * list, so a malformed request received the answer reserved for the recorded
 * one. Every member is validated and the first offender is named by index and
 * by type.
 *
 * @param value - any parsed JSON value.
 * @param fieldPath - dotted path of the field, for the rejection message.
 * @param options.requireNonEmpty - reject an empty list.
 * @param options.requireNonEmptyMembers - reject an empty-string member.
 * @returns the strings, or the reason the field is unreadable.
 */
function readStringList(
  value: unknown,
  fieldPath: string,
  options: {
    readonly requireNonEmpty?: boolean;
    readonly requireNonEmptyMembers?: boolean;
  } = {},
): FieldRead<readonly string[]> {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      problem: `${fieldPath} expected an array of strings, got ${describeJsonType(value)}`,
    };
  }
  const items: readonly unknown[] = value;
  const values: string[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string') {
      return {
        ok: false,
        problem:
          `${fieldPath}[${index}] expected a string, got ${describeJsonType(item)}; ` +
          'a malformed member rejects the whole list rather than being dropped',
      };
    }
    if (options.requireNonEmptyMembers === true && item === '') {
      return { ok: false, problem: `${fieldPath}[${index}] is the empty string` };
    }
    values.push(item);
  }
  if (options.requireNonEmpty === true && values.length === 0) {
    return { ok: false, problem: `${fieldPath} is empty` };
  }
  return { ok: true, value: values };
}

/**
 * Reads a required non-empty string field, rejecting absence and every other type.
 *
 * @param source - the parsed object.
 * @param key - the field name.
 * @param fieldPath - dotted path of the field, for the rejection message.
 * @returns the string, or the reason the field is unreadable.
 */
function readRequiredString(
  source: JsonRecord,
  key: string,
  fieldPath: string,
): FieldRead<string> {
  const value = source[key];
  if (typeof value !== 'string') {
    return {
      ok: false,
      problem: `${fieldPath} expected a string, got ${describeJsonType(value)}`,
    };
  }
  if (value === '') {
    return { ok: false, problem: `${fieldPath} is the empty string` };
  }
  return { ok: true, value };
}

/**
 * Reads a required positive-integer field, rejecting every near-miss.
 *
 * Rejects a numeric STRING, a fraction, zero, a negative, `NaN` and `Infinity`.
 * A quoted `"3600"` is the near-miss that matters most here: it looks right in a
 * request body, and coercing it would let a client that serialises its TTL as
 * text receive the response reserved for one that sends a number.
 *
 * @param source - the parsed object.
 * @param key - the field name.
 * @param fieldPath - dotted path of the field, for the rejection message.
 * @returns the integer, or the reason the field is unreadable.
 */
function readRequiredPositiveInteger(
  source: JsonRecord,
  key: string,
  fieldPath: string,
): FieldRead<number> {
  const value = source[key];
  if (typeof value !== 'number') {
    return {
      ok: false,
      problem: `${fieldPath} expected a number, got ${describeJsonType(value)}`,
    };
  }
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, problem: `${fieldPath} expected a positive integer` };
  }
  return { ok: true, value };
}

/**
 * Requires a field to be absent, or present and exactly `null`.
 *
 * Kept distinct from "absent" because the two are different claims on the wire
 * and only one of them is recorded. Used for `boundObjectRef`, where a PRESENT
 * object would make the issued token bound to a Pod or a Secret -- a different,
 * narrower credential whose recorded claim shape says the opposite
 * (F-004-RQ-002: `kubernetes.io.pod` and `kubernetes.io.secret` are both null).
 *
 * @param source - the parsed object.
 * @param key - the field name.
 * @param fieldPath - dotted path of the field, for the rejection message.
 * @param consequence - why a present value is a different request.
 * @returns the rejection reason, or `undefined` when acceptable.
 */
function requireAbsentOrNull(
  source: JsonRecord,
  key: string,
  fieldPath: string,
  consequence: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return `${fieldPath} must be absent or null, got ${describeJsonType(value)}: ${consequence}`;
}

/**
 * Requires a document to declare exactly the expected `apiVersion` and `kind`.
 *
 * Invariant locked: a body is answered only when it IS the document the endpoint
 * replays. A `ConfigMap` posted to the Pod endpoint, or a `SubjectAccessReview`
 * declaring `authorization.k8s.io/v1beta1`, is a different document; answering
 * either with the recorded outcome would let a spec prove a control against a
 * shape the API server never accepted. The real API server rejects both, and
 * both branches are named separately so a CI reader sees which one fired.
 *
 * @param body - the parsed request body.
 * @param expected.apiVersion - the exact `apiVersion` the endpoint replays.
 * @param expected.kind - the exact `kind` the endpoint replays.
 * @returns the rejection reason, or `undefined` when the identity matches.
 */
function requireDocumentIdentity(
  body: JsonRecord,
  expected: { readonly apiVersion: string; readonly kind: string },
): string | undefined {
  const apiVersion = body['apiVersion'];
  if (apiVersion !== expected.apiVersion) {
    return (
      `apiVersion must be ${JSON.stringify(expected.apiVersion)}, got ` +
      (typeof apiVersion === 'string'
        ? JSON.stringify(apiVersion)
        : describeJsonType(apiVersion))
    );
  }
  const kind = body['kind'];
  if (kind !== expected.kind) {
    return (
      `kind must be ${JSON.stringify(expected.kind)}, got ` +
      (typeof kind === 'string' ? JSON.stringify(kind) : describeJsonType(kind))
    );
  }
  return undefined;
}

/**
 * Reads a request body as a JSON object, naming what arrived instead.
 *
 * `request.json()` throws on a body that is not JSON at all, so that case is
 * caught and reported rather than surfacing as an unhandled rejection inside
 * MSW -- where it would appear as a transport failure and be indistinguishable
 * from the server being unreachable.
 *
 * @param request - the intercepted request.
 * @returns the object, or the reason it is not one.
 */
async function readJsonObjectBody(request: Request): Promise<FieldRead<JsonRecord>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, problem: 'the request body is not valid JSON' };
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    return {
      ok: false,
      problem: `the request body expected a JSON object, got ${describeJsonType(parsed)}`,
    };
  }
  return { ok: true, value: record };
}

/**
 * The `dryRun` query parameter value the recorded creates carry.
 *
 * `metav1.CreateOptions{DryRun: []string{"All"}}` -- which every recorded V2
 * create uses (`podsecurity_test.go` L391-L392) -- serialises as `?dryRun=All`.
 * `"All"` is the only value the API server accepts, and the recorded posture
 * payload carries it as an observation (`createOptions.dryRun` = `All`), so it
 * is a recorded value rather than a chosen one.
 */
const DRY_RUN_ALL = 'All';

/**
 * Requires the request to carry exactly `?dryRun=All`.
 *
 * Invariant locked (AAP §0.10.2, `metav1.CreateOptions{DryRun:["All"]}` --
 * "Validate without persisting"): a create WITHOUT it is a semantically
 * different request. It runs the same admission chain but PERSISTS the object,
 * which is why the oracle sets it and why the recorded outcome does not belong
 * to a request that omits it. Repeating the parameter is rejected too: a second
 * value means a second dry-run strategy was requested, and the API server
 * accepts only one.
 *
 * @param request - the intercepted request.
 * @returns the rejection reason, or `undefined` when exactly `All` was requested.
 */
function requireDryRunAll(request: Request): string | undefined {
  const requested = new URL(request.url).searchParams.getAll('dryRun');
  if (requested.length === 0) {
    return (
      'the create must carry ?dryRun=All: the recorded outcome was measured ' +
      'under DryRun ["All"], which runs the full admission chain and persists ' +
      'nothing, so a create that would persist has no recorded outcome'
    );
  }
  if (requested.length > 1 || requested[0] !== DRY_RUN_ALL) {
    return (
      `?dryRun must be exactly one ${JSON.stringify(DRY_RUN_ALL)}, got ` +
      JSON.stringify(requested)
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SECTION 5 -- V1: SubjectAccessReview (F-001-RQ-001, F-001-RQ-002).
//
// Recorded from test/integration/auth/rbac_test.go L1223-L1254. The oracle
// evaluates the SAME resource attributes -- all verbs, all API groups, all
// resources -- for two identities and asserts the two results with DELIBERATELY
// DIFFERENT severities:
//
//   * the non-privileged identity `system:serviceaccount:default:default` must
//     NOT be allowed. A violation is reported with `t.Errorf` (L1234-L1236),
//     which accumulates and continues, so one run reports every finding.
//   * `admin` in `system:masters` MUST be allowed. A failure here is reported
//     with `t.Fatalf` (L1252-L1254) and is explicitly "test setup broken"
//     rather than a security finding, because a stack that denies everything
//     also satisfies the denial above.
//
// Both branches must therefore be REACHABLE from this handler, and they are: the
// decision is read from the posted `spec.groups`, exactly as the authorizer
// does, so a spec chooses which branch it exercises by posting the identity it
// wants -- neither outcome is hard-coded and neither is unreachable.
// ---------------------------------------------------------------------------

/** The published path of the cluster-scoped `SubjectAccessReview` create. */
export const SUBJECT_ACCESS_REVIEW_PATH = '/apis/authorization.k8s.io/v1/subjectaccessreviews';

/**
 * The `status` of an evaluated `SubjectAccessReview`.
 *
 * Invariant locked: `allowed` is the ONLY field the oracle asserts on, and it is
 * a plain boolean rather than anything three-valued. `denied` and
 * `evaluationError` are declared because the wire carries them and a consumer
 * must be able to see them, but nothing in this tier infers permission from
 * their absence.
 */
export interface SubjectAccessReviewStatus {
  /** Whether the action is permitted. */
  readonly allowed: boolean;
  /** Set when an authorizer explicitly denied, as opposed to abstaining. */
  readonly denied?: boolean;
  /** Human-readable explanation of the decision. */
  readonly reason?: string;
  /** Set when the decision could not be evaluated cleanly. */
  readonly evaluationError?: string;
}

/**
 * The `resourceAttributes` members that NARROW a review.
 *
 * Enumerated from `authorizationv1.ResourceAttributes`. Each one restricts the
 * review to a namespace, an object, a version, a subresource or a selected set,
 * so a review carrying any of them is asking a NARROWER question than the
 * recorded one -- and a narrower question that comes back `allowed: false`
 * proves nothing about the full wildcard. Every member is `omitempty` in Go, so
 * the recorded request serialises without them and an empty string is treated as
 * equivalent to absent.
 */
const NARROWING_RESOURCE_ATTRIBUTES = [
  'namespace',
  'name',
  'version',
  'subresource',
  'fieldSelector',
  'labelSelector',
] as const;

/**
 * Validates that a posted review asks EXACTLY the recorded question.
 *
 * Invariant locked (F-001-RQ-001, F-001-RQ-002): the review must be the
 * all-verbs / all-groups / all-resources review both recorded identities are
 * evaluated against (`rbac_test.go` L1225 and L1243), and it must name the
 * identity it is asking about. Three failure modes are closed here, and each one
 * previously produced a plausible-looking decision:
 *
 *   * a NARROWER review -- say `verb: 'get'` -- answered with the wildcard rule,
 *     so `allowed: false` would be read as "the identity holds no wildcard" when
 *     it only ever meant "the identity cannot get";
 *   * an ANONYMOUS review, with no `user`, answered from its groups alone;
 *   * a MALFORMED `groups` list, whose non-string members were dropped, turning
 *     `['system:masters', 7]` into a readable list and `[7]` into "no groups at
 *     all" -- which reads as a denial.
 *
 * @param body - the parsed request body.
 * @returns the rejection reason, or `undefined` with the validated identity.
 */
function validateSubjectAccessReview(
  body: JsonRecord,
):
  | { readonly ok: true; readonly spec: JsonRecord; readonly groups: readonly string[] }
  | { readonly ok: false; readonly problem: string } {
  const identity = requireDocumentIdentity(body, {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SubjectAccessReview',
  });
  if (identity !== undefined) {
    return { ok: false, problem: identity };
  }
  const spec = asRecord(body['spec']);
  if (spec === undefined) {
    return {
      ok: false,
      problem: `spec expected a JSON object, got ${describeJsonType(body['spec'])}`,
    };
  }
  if (spec['nonResourceAttributes'] !== undefined) {
    return {
      ok: false,
      problem:
        'spec.nonResourceAttributes must be absent: the recorded review is a ' +
        'RESOURCE review over all verbs, all API groups and all resources, and a ' +
        'non-resource review asks a different question',
    };
  }
  const attributes = asRecord(spec['resourceAttributes']);
  if (attributes === undefined) {
    return {
      ok: false,
      problem:
        'spec.resourceAttributes expected a JSON object, got ' +
        describeJsonType(spec['resourceAttributes']),
    };
  }
  for (const [key, required] of Object.entries(V1_FULL_WILDCARD_ATTRIBUTES)) {
    if (attributes[key] !== required) {
      return {
        ok: false,
        problem:
          `spec.resourceAttributes.${key} must be ${JSON.stringify(required)}, got ` +
          (typeof attributes[key] === 'string'
            ? JSON.stringify(attributes[key])
            : describeJsonType(attributes[key])) +
          '; only the full wildcard review has a recorded outcome',
      };
    }
  }
  for (const key of NARROWING_RESOURCE_ATTRIBUTES) {
    const narrowing = attributes[key];
    if (narrowing !== undefined && narrowing !== '') {
      return {
        ok: false,
        problem:
          `spec.resourceAttributes.${key} must be absent: it narrows the review, ` +
          'and a narrower review that is refused says nothing about the full wildcard',
      };
    }
  }
  const user = readRequiredString(spec, 'user', 'spec.user');
  if (!user.ok) {
    return {
      ok: false,
      problem: `${user.problem}; a review must name the identity it is asking about`,
    };
  }
  if (spec['groups'] === undefined) {
    return { ok: true, spec, groups: [] };
  }
  const groups = readStringList(spec['groups'], 'spec.groups', {
    requireNonEmptyMembers: true,
  });
  if (!groups.ok) {
    return { ok: false, problem: groups.problem };
  }
  return { ok: true, spec, groups: groups.value };
}

/**
 * Serves an evaluated `SubjectAccessReview`.
 *
 * The decision rule is the recorded one and nothing more: an identity resolves
 * the full wildcard exactly when its groups include
 * {@link V1_PERMITTED_WILDCARD_GROUP}. That is the whole of V1 -- the rule
 * covering all verbs, all API groups and all resources lives only in the
 * {@link V1_PERMITTED_WILDCARD_ROLE} ClusterRole, bound only to that group, as a
 * {@link V1_PERMITTED_WILDCARD_SUBJECT_KIND} subject. Both recorded branches stay
 * reachable, because the decision is read from the posted identity rather than
 * hard-coded: post the recorded non-privileged subject and the answer is a
 * denial, post the recorded `system:masters` subject and it is an allowance.
 *
 * The posted `spec` is echoed back verbatim, which is what the API server does
 * and which lets a spec confirm the review it asked for is the review that was
 * answered. Anything that is not the recorded review -- a different document, a
 * narrowed question, an anonymous subject, a malformed group list -- is answered
 * `400 Bad Request` rather than with a plausible-looking decision: for an
 * authorization endpoint, guessing would be the worst possible response.
 *
 * @returns the handler.
 */
function subjectAccessReviewHandler(): RequestHandler {
  return http.post<Record<string, never>, JsonRecord>(
    SUBJECT_ACCESS_REVIEW_PATH,
    async ({ request }) => {
      const parsed = await readJsonObjectBody(request);
      if (!parsed.ok) {
        return badRequestStatus(
          `SubjectAccessReview in version "v1" cannot be handled: ${parsed.problem}, ` +
            'so least-privilege RBAC (F-001-RQ-002) cannot be evaluated',
        );
      }
      const review = validateSubjectAccessReview(parsed.value);
      if (!review.ok) {
        return badRequestStatus(
          `SubjectAccessReview in version "v1" cannot be handled: ${review.problem} ` +
            '(F-001-RQ-002)',
        );
      }
      const { spec, groups } = review;
      const allowed = groups.includes(V1_PERMITTED_WILDCARD_GROUP);
      const status: SubjectAccessReviewStatus = {
        allowed,
        reason: allowed
          ? `RBAC: allowed by ClusterRoleBinding of ClusterRole ` +
            `${JSON.stringify(V1_PERMITTED_WILDCARD_ROLE)} to ` +
            `${V1_PERMITTED_WILDCARD_SUBJECT_KIND} ` +
            `${JSON.stringify(V1_PERMITTED_WILDCARD_GROUP)}`
          : `no RBAC policy matched; least-privilege RBAC (F-001-RQ-002) grants ` +
            `the full wildcard rule only to ClusterRole ` +
            `${JSON.stringify(V1_PERMITTED_WILDCARD_ROLE)}, bound only to ` +
            `${V1_PERMITTED_WILDCARD_SUBJECT_KIND} ` +
            `${JSON.stringify(V1_PERMITTED_WILDCARD_GROUP)}`,
      };
      return HttpResponse.json(
        {
          kind: 'SubjectAccessReview',
          apiVersion: 'authorization.k8s.io/v1',
          metadata: {},
          spec,
          status,
        },
        { status: 201 },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// SECTION 6 -- V2: Pod Security admission (F-002-RQ-001, F-002-RQ-003).
//
// Recorded from test/integration/auth/podsecurity_test.go L363-L457. Namespace
// `psa-enforce-baseline` rejects `privileged-pod` (L396-L409) and `hostpid-pod`
// (L411-L421) -- both asserted through `apierrors.IsForbidden`, i.e. HTTP 403 --
// while `psa-warn-restricted` ADMITS `warn-pod` (L439-L449) and simultaneously
// surfaces at least one warning (L451-L455). All three creates use
// `DryRun: ["All"]`, which runs the full admission chain and persists nothing.
//
// `?dryRun=All` IS THEREFORE REQUIRED HERE, not merely tolerated. A create
// without it runs the same admission chain but PERSISTS the pod, which is a
// different request from the one that was measured -- and the recorded posture
// payload carries `createOptions.dryRun` = `All` as evidence precisely because
// the dry-run posture is part of what was observed. A create that would persist
// is answered `400 Bad Request` rather than with the recorded decision.
//
// The 403 message is composed with the API server's own formats, not
// approximated: `apierrors.NewForbidden` renders
// `<resource> "<name>" is forbidden: <detail>`, and the PodSecurity plugin's
// detail is `violates PodSecurity "<level>:<version>": <aggregate detail>`
// (staging/src/k8s.io/pod-security-admission/admission/admission.go L480-L484).
// The level and version are the recorded label value and enforce version, and
// the aggregate detail is the violation each recorded pod carries; the oracle
// asserts only that the rejection IS Forbidden, so the recorded violation
// identifier is used rather than inventing the policy checks' prose.
// ---------------------------------------------------------------------------

/** The published path of a namespaced Pod create. */
export const PODS_PATH = '/api/v1/namespaces/:namespace/pods';

/** The qualified resource of a Pod: the core group renders as the bare name. */
const PODS_QUALIFIED_RESOURCE = 'pods';

/**
 * Validates that a posted Pod is the document whose outcome was recorded.
 *
 * Invariant locked (F-002-RQ-001, F-002-RQ-003): the recorded 403 and the
 * recorded admit-with-warning belong to a real Pod created in a real labelled
 * namespace. Four failure modes are closed, and each one previously received the
 * recorded decision:
 *
 *   * a document that is not a Pod at all -- a `ConfigMap`, or a Pod declaring a
 *     version the API server never served;
 *   * a Pod with no readable `metadata.name`, which fell through to the
 *     unrecorded-pod branch and reported the empty string as the pod's name;
 *   * a Pod whose `metadata.namespace` CONTRADICTS the URL. The enforcing labels
 *     live on the namespace, so a mismatched pair would be admitted under one
 *     policy and reported under another;
 *   * a Pod with no containers. PodSecurity evaluates the pod-level fields and
 *     every container, so an empty pod is not the recorded document -- and
 *     `privileged` and `hostPID`, the two recorded violations, are read from a
 *     container and from the pod respectively.
 *
 * @param body - the parsed request body.
 * @param pathNamespace - the namespace from the URL.
 * @returns the validated `metadata.name`, or the reason the body is unusable.
 */
function validatePodCreate(
  body: JsonRecord,
  pathNamespace: string,
): FieldRead<string> {
  const identity = requireDocumentIdentity(body, { apiVersion: 'v1', kind: 'Pod' });
  if (identity !== undefined) {
    return { ok: false, problem: identity };
  }
  const metadata = asRecord(body['metadata']);
  if (metadata === undefined) {
    return {
      ok: false,
      problem: `metadata expected a JSON object, got ${describeJsonType(body['metadata'])}`,
    };
  }
  const name = readRequiredString(metadata, 'name', 'metadata.name');
  if (!name.ok) {
    return name;
  }
  const declaredNamespace = metadata['namespace'];
  if (declaredNamespace !== undefined && declaredNamespace !== pathNamespace) {
    return {
      ok: false,
      problem:
        `metadata.namespace must match the namespace on the URL ` +
        `(${JSON.stringify(pathNamespace)}), got ` +
        (typeof declaredNamespace === 'string'
          ? JSON.stringify(declaredNamespace)
          : describeJsonType(declaredNamespace)) +
        '; the enforcing labels live on the namespace, so a mismatched pair would ' +
        'be admitted under one policy and reported under another',
    };
  }
  const spec = asRecord(body['spec']);
  if (spec === undefined) {
    return {
      ok: false,
      problem: `spec expected a JSON object, got ${describeJsonType(body['spec'])}`,
    };
  }
  const containers = spec['containers'];
  if (!Array.isArray(containers) || (containers as readonly unknown[]).length === 0) {
    return {
      ok: false,
      problem:
        `spec.containers expected a non-empty array, got ${describeJsonType(containers)}; ` +
        'PodSecurity evaluates the pod-level fields AND every container, so a pod ' +
        'with no containers is not the document whose outcome was recorded',
    };
  }
  return { ok: true, value: name.value };
}

/**
 * Serves the recorded admission outcome for a Pod create.
 *
 * Invariant locked: the outcome comes from the recorded {@link V2_PODS} table,
 * matched on name AND namespace, so the two rejections are 403 and the admitted
 * pod is a success carrying warnings -- never the other way round, and never a
 * fabricated decision. A pod outside that table is answered with `400 Bad
 * Request`: this endpoint replays recorded admission outcomes, and an
 * unrecorded pod has no recorded outcome, so answering it with an invented
 * verdict is precisely what this file exists to prevent.
 *
 * `?dryRun=All` is REQUIRED, checked before the recorded table is consulted, for
 * the reason {@link requireDryRunAll} records: every recorded create ran under
 * `DryRun: ["All"]`, and a create that would persist is a different request.
 *
 * The admitted response echoes the posted document, which is what a successful
 * dry-run create returns, and attaches one `Warning` header per recorded
 * warning. That is the `warn` outcome as the protocol carries it: neither a clean
 * pass nor a failure.
 *
 * @returns the handler.
 */
function podAdmissionHandler(): RequestHandler {
  return http.post<{ namespace: string }, JsonRecord>(
    PODS_PATH,
    async ({ request, params }) => {
      const parsed = await readJsonObjectBody(request);
      if (!parsed.ok) {
        return badRequestStatus(
          `Pod in version "v1" cannot be handled: ${parsed.problem} (F-002-RQ-001)`,
        );
      }
      const dryRun = requireDryRunAll(request);
      if (dryRun !== undefined) {
        return badRequestStatus(
          `Pod in version "v1" cannot be handled: ${dryRun} (F-002-RQ-001)`,
        );
      }
      const validated = validatePodCreate(parsed.value, params.namespace);
      if (!validated.ok) {
        return badRequestStatus(
          `Pod in version "v1" cannot be handled: ${validated.problem} (F-002-RQ-001)`,
        );
      }
      const body = parsed.value;
      const name = validated.value;
      const recorded = V2_PODS.find(
        (pod) => pod.name === name && pod.namespace === params.namespace,
      );
      if (recorded === undefined) {
        return badRequestStatus(
          `Pod in version "v1" cannot be handled: no recorded Pod Security ` +
            `outcome exists for ${JSON.stringify(name)} in namespace ` +
            `${JSON.stringify(params.namespace)}; the recorded pods are ` +
            `${V2_PODS.map((pod) => `${pod.namespace}/${pod.name}`).join(', ')} ` +
            `(F-002-RQ-001)`,
        );
      }
      if (!recorded.admitted) {
        return forbiddenStatus(
          PODS_QUALIFIED_RESOURCE,
          recorded.name,
          `violates PodSecurity "${V2_NAMESPACES.enforceBaseline.labelValue}:` +
            `${V2_GENERATED_ADMISSION_CONFIG.defaults.enforceVersion}": ` +
            recorded.violation,
        );
      }
      const warnings =
        params.namespace === V2_NAMESPACES.warnRestricted.name ? V2_RESTRICTED_WARNINGS : [];
      const headers = warningHeaders(warnings);
      return HttpResponse.json(body, {
        status: 201,
        ...(headers === undefined ? {} : { headers }),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// SECTION 7 -- V4: TokenRequest (F-004-RQ-001, F-004-RQ-002).
//
// Recorded from test/integration/auth/svcaccttoken_test.go L1469-L1516. The
// request is `{ audiences: ["api"], expirationSeconds: 3600 }`; the response
// carries `status.token` and `status.expirationTimestamp`, and the returned spec
// echoes the requested TTL (L1516, `checkExpiration`).
//
// NO TOKEN VALUE IS SERVED. `status.token` is an unmistakable placeholder, and
// that is a deliberate reading of two facts rather than an omission: AAP §0.11.1
// forbids credentials outright, and ../fixtures/controlStatus records that even
// fake credentials have no place in a fixture because "they train readers to
// expect credentials in fixtures". Nothing in this tier decodes a JWT -- no JWT
// library is pinned in web/package.json -- and the three V4 assertions are
// carried by data that IS recorded: `spec.audiences`,
// `status.expirationTimestamp`, and the claim shape surfaced as observations on
// the V4 posture payload.
//
// NO CLOCK IS READ. The served timestamp is a recorded value, so the +-60 s
// window around `requestTime + 3600 s` is asserted against the recorded
// reference instant rather than against "now". That window is calibrated so a
// roughly one-year regression still fails while CI jitter is absorbed
// (AAP §0.10.2: narrowing it makes the test flaky, widening it makes the test
// meaningless), and the handler is parameterised by the expiry precisely so both
// the compliant and the regressed expiries are servable without either being
// recomputed here.
// ---------------------------------------------------------------------------

/** The published path of the ServiceAccount `token` subresource create. */
export const SERVICE_ACCOUNT_TOKEN_PATH =
  '/api/v1/namespaces/:namespace/serviceaccounts/:name/token';

/**
 * The value served in place of a projected token.
 *
 * Deliberately unable to match any provider's credential pattern: it is not a
 * JWT, has no dots, and reads as what it is. The `TokenRequestStatus` contract
 * only requires `token` to be a string, and this tier never decodes it.
 */
export const REDACTED_PROJECTED_TOKEN = 'REDACTED_PROJECTED_TOKEN';

/** Qualified resource of a ServiceAccount: core group, so the bare plural. */
const SERVICE_ACCOUNTS_QUALIFIED_RESOURCE = 'serviceaccounts';

/**
 * Validates that a posted `TokenRequest` is the request whose outcome was
 * recorded.
 *
 * Invariant locked (F-004-RQ-001, F-004-RQ-002): NOTHING IS DEFAULTED. This is
 * the sharpest edge in the file, because the previous shape defaulted a
 * malformed request to the compliant recorded values -- `audiences: [123]`
 * became `["api"]` and `expirationSeconds: "3600"` became `3600` -- so a client
 * that asked for the wrong thing was told it had asked for the right thing. A
 * mock that answers a malformed audience request with the compliant audience is
 * worse than no mock: it makes the audience-binding assertion unfalsifiable.
 *
 * Absence is rejected as firmly as malformation, and for the same reason rather
 * than out of strictness for its own sake. A TokenRequest with no `audiences`
 * yields a token valid for the API server's DEFAULT audiences, and one with no
 * `expirationSeconds` yields the server's default TTL -- both different, weaker
 * credentials than the recorded one, and both outside the +-60 s window
 * (AAP §0.10.2) that only means something when the requested TTL is known. The
 * recorded request always carries both, so neither has a recorded outcome when
 * omitted. Each rejection names the recorded value, so a reader learns what to
 * post rather than only that something was wrong.
 *
 * @param body - the parsed request body.
 * @returns the validated audience list and TTL, or the reason the body is
 *   unusable.
 */
function validateTokenRequest(
  body: JsonRecord,
): FieldRead<{ readonly audiences: readonly string[]; readonly expirationSeconds: number }> {
  const identity = requireDocumentIdentity(body, {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenRequest',
  });
  if (identity !== undefined) {
    return { ok: false, problem: identity };
  }
  const spec = asRecord(body['spec']);
  if (spec === undefined) {
    return {
      ok: false,
      problem: `spec expected a JSON object, got ${describeJsonType(body['spec'])}`,
    };
  }
  const audiences = readStringList(spec['audiences'], 'spec.audiences', {
    requireNonEmpty: true,
    requireNonEmptyMembers: true,
  });
  if (!audiences.ok) {
    return {
      ok: false,
      problem:
        `${audiences.problem}; the recorded request carries ` +
        `${JSON.stringify(V4_AUDIENCES)} and nothing is defaulted, because a token ` +
        'bound to different audiences is a different credential',
    };
  }
  const expirationSeconds = readRequiredPositiveInteger(
    spec,
    'expirationSeconds',
    'spec.expirationSeconds',
  );
  if (!expirationSeconds.ok) {
    return {
      ok: false,
      problem:
        `${expirationSeconds.problem}; the recorded request carries ` +
        `${String(V4_REQUESTED_TTL_SECONDS)}, and the +-60 s expiry window is ` +
        'meaningless unless the requested TTL is known',
    };
  }
  const bound = requireAbsentOrNull(
    spec,
    'boundObjectRef',
    'spec.boundObjectRef',
    'the recorded request binds no object, which is exactly why the ' +
      'kubernetes.io.pod and kubernetes.io.secret claims are recorded as null',
  );
  if (bound !== undefined) {
    return { ok: false, problem: bound };
  }
  return {
    ok: true,
    value: { audiences: audiences.value, expirationSeconds: expirationSeconds.value },
  };
}

/**
 * Serves an issued `TokenRequest`.
 *
 * The response echoes the posted `audiences` and `expirationSeconds` verbatim
 * -- unsorted, un-deduplicated and unclamped -- because the returned spec is an
 * echo on the wire and because for an audience list both contents and
 * cardinality are meaningful. Nothing is defaulted and nothing is coerced: see
 * {@link validateTokenRequest} for why a request that omits or malforms either
 * field is answered `400 Bad Request` instead. `boundObjectRef` is `null`, which
 * is the recorded state: the oracle's request binds no object, which is exactly
 * why the `kubernetes.io.pod` and `kubernetes.io.secret` claims are asserted to
 * be `null` (L1523-L1525).
 *
 * The addressed ServiceAccount is validated before the body is read, because the
 * token subresource is reached THROUGH an account: a request naming any other
 * account is answered `404 Not Found`, never a token.
 *
 * @param expirationTimestamp - the RFC 3339 expiry to serve. Defaults to the
 *   recorded compliant value; pass a recorded regression expiry to exercise the
 *   far side of the window.
 * @returns the handler.
 */
export function serviceAccountTokenHandler(
  expirationTimestamp: string = V4_OBSERVED_EXPIRY.expirationTimestamp,
): RequestHandler {
  return http.post<{ namespace: string; name: string }, JsonRecord>(
    SERVICE_ACCOUNT_TOKEN_PATH,
    async ({ request, params }) => {
      if (
        params.namespace !== V4_NAMESPACE ||
        params.name !== V4_SERVICE_ACCOUNT_NAME
      ) {
        // The subresource is addressed THROUGH the ServiceAccount, so a request
        // naming an account that does not exist cannot reach token issuance at
        // all. 404 rather than 400 because the request itself is well formed --
        // and rather than a token, because issuing one for an arbitrary identity
        // is the opposite of what F-004-RQ-001 constrains.
        return notFoundStatus(SERVICE_ACCOUNTS_QUALIFIED_RESOURCE, params.name);
      }
      const parsed = await readJsonObjectBody(request);
      if (!parsed.ok) {
        return badRequestStatus(
          `TokenRequest in version "v1" cannot be handled: ${parsed.problem} ` +
            '(F-004-RQ-001)',
        );
      }
      const validated = validateTokenRequest(parsed.value);
      if (!validated.ok) {
        return badRequestStatus(
          `TokenRequest in version "v1" cannot be handled: ${validated.problem} ` +
            '(F-004-RQ-001)',
        );
      }
      return HttpResponse.json(
        {
          kind: 'TokenRequest',
          apiVersion: 'authentication.k8s.io/v1',
          metadata: {},
          spec: {
            audiences: validated.value.audiences,
            expirationSeconds: validated.value.expirationSeconds,
            boundObjectRef: null,
          },
          status: { token: REDACTED_PROJECTED_TOKEN, expirationTimestamp },
        },
        { status: 201 },
      );
    },
  );
}


// ---------------------------------------------------------------------------
// SECTION 8 -- V7: NodeRestriction (F-007-RQ-002).
//
// Recorded from test/integration/auth/node_test.go L1591-L1687. The acting
// identity in all four recorded checks is node1, and what differs is the TARGET:
//
//   * UpdateStatus on node2 -> Forbidden (L1653-L1659);
//   * get Secret "unrelatedsecret" in namespace "ns" -> Forbidden (L1665-L1668);
//   * get its OWN Node -> allowed (L1673-L1676), a positive control;
//   * UpdateStatus on its OWN Node -> allowed (L1680-L1686), a positive control.
//
// Keying the handlers on the target rather than on a bearer token is both
// faithful and deliberate: ../fixtures/controlStatus records the PRINCIPALS only
// and states why -- node_test.go L1593 labels its token strings "Fake values for
// testing", and even fake credentials have no place in this tier.
//
// Both positive controls are served as successes on purpose. Without them the
// two denials are ALSO satisfied by an authorization stack that refuses
// everything, which is exactly the failure mode the oracle pairs its assertions
// to rule out.
//
// The 403 messages are the API server's own, measured rather than approximated:
// plugin/pkg/admission/noderestriction/admission.go L505 renders
// `node %q is not allowed to modify node %q`, wrapped by
// `admission.NewForbidden` into `<resource> "<name>" is forbidden: <detail>`;
// and staging/src/k8s.io/apiserver/pkg/endpoints/handlers/responsewriters/errors.go
// L76 renders the namespaced authorization denial as
// `User %q cannot %s resource %q in API group %q in the namespace %q`.
// ---------------------------------------------------------------------------

/**
 * The username prefix every node identity carries.
 *
 * Recorded from `node_test.go` L1605 (`system:node:node1`) and used ONLY to
 * derive the bare node names below, so the derived names cannot drift from the
 * recorded principals the way a second set of literals could.
 */
const NODE_USERNAME_PREFIX = 'system:node:';

/**
 * Derives a bare node name from a node principal.
 *
 * @param principal - a recorded node username, e.g. `system:node:node1`.
 * @returns the node's own name, e.g. `node1`.
 */
function nodeNameFor(principal: string): string {
  return principal.startsWith(NODE_USERNAME_PREFIX)
    ? principal.slice(NODE_USERNAME_PREFIX.length)
    : principal;
}

/** The node the recorded checks act AS, derived from the recorded principal. */
export const V7_ACTING_NODE_NAME = nodeNameFor(V7_PRINCIPALS.node1.user);

/** The other node the recorded cross-node denial targets. */
export const V7_CROSS_NODE_TARGET_NAME = nodeNameFor(V7_PRINCIPALS.node2.user);

/**
 * The namespace holding the Secret unrelated to the acting node's pods.
 * Recorded from `node_test.go` L1637 and L1646.
 */
export const V7_UNRELATED_SECRET_NAMESPACE = 'ns';

/** The Secret the acting node must not read. Recorded from `node_test.go` L1646. */
export const V7_UNRELATED_SECRET_NAME = 'unrelatedsecret';

/** The published path of the Node `status` subresource update. */
export const NODE_STATUS_PATH = '/api/v1/nodes/:name/status';

/** The published path of a namespaced Secret read. */
export const SECRET_PATH = '/api/v1/namespaces/:namespace/secrets/:name';

/** The qualified resources of a Node and a Secret: core group, bare names. */
const NODES_QUALIFIED_RESOURCE = 'nodes';
const SECRETS_QUALIFIED_RESOURCE = 'secrets';

/**
 * Validates that a posted Node status update is the operation whose outcome was
 * recorded.
 *
 * Invariant locked (F-007-RQ-002): the URL names the object the authorization
 * decision is made ABOUT, so the body must agree with it. The previous shape
 * echoed any JSON object back as a successful update, which meant an arbitrary
 * document -- or a Node document naming a DIFFERENT node from the URL -- was
 * served the acting node's recorded allowance. The real API server rejects that
 * mismatch with `400 Bad Request` in the same words reproduced below, and it
 * matters more here than in most places: a body/URL mismatch is precisely how a
 * cross-node write would be smuggled past a check that only reads the URL.
 *
 * @param body - the parsed request body.
 * @param pathName - the node name from the URL.
 * @returns the rejection reason, or `undefined` when the update is well formed.
 */
function validateNodeStatusUpdate(body: JsonRecord, pathName: string): string | undefined {
  const identity = requireDocumentIdentity(body, { apiVersion: 'v1', kind: 'Node' });
  if (identity !== undefined) {
    return identity;
  }
  const metadata = asRecord(body['metadata']);
  if (metadata === undefined) {
    return `metadata expected a JSON object, got ${describeJsonType(body['metadata'])}`;
  }
  const name = readRequiredString(metadata, 'name', 'metadata.name');
  if (!name.ok) {
    return name.problem;
  }
  if (name.value !== pathName) {
    return (
      `the name of the object (${JSON.stringify(name.value)}) does not match the ` +
      `name on the URL (${JSON.stringify(pathName)}); the URL names the object the ` +
      'authorization decision is made about, so a mismatched pair has no recorded ' +
      'outcome'
    );
  }
  if (asRecord(body['status']) === undefined) {
    return (
      `status expected a JSON object, got ${describeJsonType(body['status'])}; ` +
      'this is the status subresource, and an update carrying no status is not the ' +
      'operation whose outcome was recorded'
    );
  }
  return undefined;
}

/**
 * Serves the recorded outcome of a Node status update by the acting node.
 *
 * Invariant locked: the acting node's OWN Node succeeds and the other node's
 * Node is refused with 403 -- never 404. The distinction is the entire point of
 * F-007-RQ-002: a NotFound means the request never reached an authorization
 * decision, so it proves nothing about node isolation, which is why the oracle
 * creates node2 first. A target outside the recorded pair is answered `400 Bad
 * Request` rather than with a guessed decision, and so is a body that is not a
 * well-formed status update for the node the URL names -- see
 * {@link validateNodeStatusUpdate}.
 *
 * @returns the handler.
 */
function nodeStatusHandler(): RequestHandler {
  return http.put<{ name: string }, JsonRecord>(
    NODE_STATUS_PATH,
    async ({ request, params }) => {
      const parsed = await readJsonObjectBody(request);
      if (!parsed.ok) {
        return badRequestStatus(
          `Node in version "v1" cannot be handled: ${parsed.problem} (F-007-RQ-002)`,
        );
      }
      const problem = validateNodeStatusUpdate(parsed.value, params.name);
      if (problem !== undefined) {
        return badRequestStatus(
          `Node in version "v1" cannot be handled: ${problem} (F-007-RQ-002)`,
        );
      }
      const body = parsed.value;
      if (params.name === V7_ACTING_NODE_NAME) {
        return HttpResponse.json(body);
      }
      if (params.name === V7_CROSS_NODE_TARGET_NAME) {
        return forbiddenStatus(
          NODES_QUALIFIED_RESOURCE,
          params.name,
          `node ${JSON.stringify(V7_ACTING_NODE_NAME)} is not allowed to modify ` +
            `node ${JSON.stringify(params.name)}`,
        );
      }
      return badRequestStatus(
        `Node in version "v1" cannot be handled: no recorded NodeRestriction ` +
          `outcome exists for node ${JSON.stringify(params.name)}; the recorded ` +
          `nodes are ${V7_ACTING_NODE_NAME} and ${V7_CROSS_NODE_TARGET_NAME} ` +
          `(F-007-RQ-002)`,
      );
    },
  );
}

/**
 * Serves the cross-node update as `404 Not Found`.
 *
 * This is the pre-creation state `node_test.go` L1632-L1636 warns about, made
 * servable so a spec can prove that a NotFound is rendered as a failure and
 * NEVER as a pass. It is stateless by design: no handler here tracks whether an
 * object has been created, so the two outcomes are two explicit handlers rather
 * than one handler with hidden state. Pair it with the recorded
 * `V7_NODE_RESTRICTION_NOT_FOUND` posture payload, which carries a finding
 * rather than a verdict of `pass`.
 *
 * The body is validated exactly as {@link nodeStatusHandler} validates it, so
 * this variant differs from the recorded handler in ONE respect only -- the
 * outcome it serves. A shim that accepted anything would let a spec reach the
 * 404 with a malformed request and conclude that a NotFound had been rendered as
 * a failure, when a 400 would have produced the same visible result.
 *
 * @returns the handler, for `server.use(...)`.
 */
export function crossNodeNotFoundHandler(): RequestHandler {
  return http.put<{ name: string }, JsonRecord>(
    NODE_STATUS_PATH,
    async ({ request, params }) => {
      const parsed = await readJsonObjectBody(request);
      if (!parsed.ok) {
        return badRequestStatus(
          `Node in version "v1" cannot be handled: ${parsed.problem} (F-007-RQ-002)`,
        );
      }
      const problem = validateNodeStatusUpdate(parsed.value, params.name);
      if (problem !== undefined) {
        return badRequestStatus(
          `Node in version "v1" cannot be handled: ${problem} (F-007-RQ-002)`,
        );
      }
      return notFoundStatus(NODES_QUALIFIED_RESOURCE, V7_CROSS_NODE_TARGET_NAME);
    },
  );
}

/**
 * Serves the recorded outcome of a Secret read by the acting node.
 *
 * Invariant locked: the unrelated Secret is refused with 403, using the API
 * server's own namespaced authorization message. Any other Secret is answered
 * `404 Not Found`, because the recorded fixture set contains exactly one Secret
 * and nothing else exists to read -- and a 404 is an error either way, never a
 * pass.
 *
 * @returns the handler.
 */
function secretReadHandler(): RequestHandler {
  return http.get<{ namespace: string; name: string }>(SECRET_PATH, ({ params }) => {
    if (
      params.namespace === V7_UNRELATED_SECRET_NAMESPACE &&
      params.name === V7_UNRELATED_SECRET_NAME
    ) {
      return forbiddenStatus(
        SECRETS_QUALIFIED_RESOURCE,
        params.name,
        `User ${JSON.stringify(V7_PRINCIPALS.node1.user)} cannot get resource ` +
          `"secrets" in API group "" in the namespace ` +
          `${JSON.stringify(params.namespace)}`,
      );
    }
    return notFoundStatus(SECRETS_QUALIFIED_RESOURCE, params.name);
  });
}

// ---------------------------------------------------------------------------
// SECTION 9 -- V5: the admission-webhook posture document (F-005-RQ-001).
//
// The committed artifact is
// cluster/gce/addons/cloud-pvl-admission/mutating-webhook-configuration.yaml,
// whose line 1 declares `admissionregistration.k8s.io/v1` and line 2
// `MutatingWebhookConfiguration` -- which is why the published API path below is
// the right place to replay it. The webhook body itself is served straight from
// ../fixtures/controlStatus, so every asserted value arrives exactly as
// recorded: `failurePolicy: Fail`, `timeoutSeconds: 5`, `sideEffects: None`,
// `admissionReviewVersions: ['v1']`, the single `rules` entry, the single
// `matchConditions` entry, and the `caBundle` PLACEHOLDER verbatim -- no real or
// realistic-looking certificate is ever substituted.
//
// The fail-OPEN variant is servable through the same factory, which is what lets
// a spec prove the panel renders a failure when `failurePolicy` reads `Ignore`.
// That one-word difference IS the control: with `Ignore`, an unreachable webhook
// is admitted anyway while every other field still reads as correct.
// ---------------------------------------------------------------------------

/** The published path of a `MutatingWebhookConfiguration` read. */
export const MUTATING_WEBHOOK_CONFIGURATION_PATH =
  '/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations/:name';

/** Qualified resource of a `MutatingWebhookConfiguration`. */
const MUTATING_WEBHOOK_QUALIFIED_RESOURCE =
  'mutatingwebhookconfigurations.admissionregistration.k8s.io';

/**
 * The `metadata.labels` of the committed artifact, transcribed from its lines
 * 5 through 7.
 *
 * Included so the replayed document is the committed document rather than a
 * subset of it. They are addon-manager labels and carry no part of the control,
 * which is precisely why they are recorded here rather than being asserted.
 */
const WEBHOOK_CONFIGURATION_LABELS = {
  'addonmanager.kubernetes.io/mode': 'Reconcile',
  'k8s-app': 'cloud-pvl-admission',
} as const;

/**
 * Serves a recorded `MutatingWebhookConfiguration`.
 *
 * @param posture - the recorded webhook posture to serve. Defaults to the
 *   committed fail-closed posture; pass the recorded fail-open variant to
 *   exercise the failure rendering.
 * @returns the handler, for `handlers` or for `server.use(...)`.
 */
export function mutatingWebhookConfigurationHandler(
  posture: RecordedWebhookPosture = FAIL_CLOSED_WEBHOOK,
): RequestHandler {
  return http.get<{ name: string }>(MUTATING_WEBHOOK_CONFIGURATION_PATH, ({ params }) => {
    if (params.name !== posture.name) {
      return notFoundStatus(MUTATING_WEBHOOK_QUALIFIED_RESOURCE, params.name);
    }
    return HttpResponse.json({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'MutatingWebhookConfiguration',
      metadata: { name: posture.name, labels: WEBHOOK_CONFIGURATION_LABELS },
      webhooks: [posture],
    });
  });
}

// ---------------------------------------------------------------------------
// SECTION 10 -- V3: the EncryptionConfiguration documents (F-003-RQ-001,
// F-003-RQ-003).
//
// AAP §0.3.2 requires this tier to replay EncryptionConfiguration YAML, and
// ../fixtures/encryptionConfig records both forms for exactly that purpose --
// its own note says keeping the recorded text beside the recorded structure
// "means a handler never has to hand-roll YAML, which is the only way the two
// could diverge".
//
// TWO DISTINCT DOCUMENTS, SERVED SEPARATELY AND NEVER MERGED:
//
//   * the committed GCE deployment document -- `resources: [secrets, configmaps]`
//     with the KMS v2 provider FIRST (`timeout: 3s`, the placeholder
//     `unix:///tmp/kms.socket` endpoint, and NO `cachesize`, which v2 rejects)
//     and `identity` LAST as a decrypt-only fallback. Its bytes are
//     deliberately not duplicated by the fixture, so its recorded STRUCTURE is
//     served as JSON;
//   * the V3 integration document -- the inline static-key aesgcm configuration,
//     recorded VERBATIM as text including its leading and trailing newlines, and
//     served as YAML.
//
// Ordering is a security boundary here, not a formatting preference: `identity`
// first would mean every new write is stored in plaintext while the document
// still parsed and the API server still booted. Both documents are served BY
// REFERENCE precisely so that ordering cannot be rearranged in transit.
//
// EncryptionConfiguration is a file read by the API server at startup, not a
// REST resource, so these two documents have no published API path. Their paths
// are therefore derived rather than invented: the base sits inside the
// `/api/posture` namespace the hooks themselves define, and each leaf is the
// kebab-cased name of the fixture identifier it serves.
//
// The aesgcm key in the integration document is the documented NON-secret test
// vector the Go oracle itself records as "the same non-secret test fixture used
// by ...secrets_transformation_test.go -- NOT a real credential"
// (encryption_test.go L51-L52). It is served BY REFERENCE and is the only key
// material anywhere in this tier.
// ---------------------------------------------------------------------------

/** Base path of the recorded-artifact endpoints. */
export const RECORDED_ARTIFACT_BASE_PATH = '/api/posture/artifacts';

/** Path serving the committed GCE deployment EncryptionConfiguration. */
export const DEPLOYMENT_ENCRYPTION_CONFIG_PATH =
  `${RECORDED_ARTIFACT_BASE_PATH}/deployment-encryption-config` as const;

/** Path serving the V3 integration EncryptionConfiguration, as YAML. */
export const INTEGRATION_ENCRYPTION_CONFIG_YAML_PATH =
  `${RECORDED_ARTIFACT_BASE_PATH}/integration-encryption-config.yaml` as const;

/**
 * Serves the committed deployment EncryptionConfiguration structure.
 *
 * @returns the handler.
 */
function deploymentEncryptionConfigHandler(): RequestHandler {
  return http.get(DEPLOYMENT_ENCRYPTION_CONFIG_PATH, () =>
    HttpResponse.json(DEPLOYMENT_ENCRYPTION_CONFIG),
  );
}

/**
 * Serves the V3 integration EncryptionConfiguration as YAML text.
 *
 * The body is the recorded string exactly as the oracle writes it to disk, so
 * the leading and trailing newlines are part of the response. The content type
 * is `application/yaml`, which is what the Kubernetes ecosystem uses.
 *
 * @returns the handler.
 */
function integrationEncryptionConfigYamlHandler(): RequestHandler {
  return http.get(INTEGRATION_ENCRYPTION_CONFIG_YAML_PATH, () =>
    HttpResponse.text(INTEGRATION_AESGCM_ENCRYPTION_CONFIG_YAML, {
      headers: { 'Content-Type': 'application/yaml' },
    }),
  );
}

// ---------------------------------------------------------------------------
// SECTION 11 -- The default handler set.
//
// web/src/test/msw/server.ts spreads this array into `setupServer(...handlers)`,
// so the NAME and the SHAPE are contractual. It is a plain named export: no
// default export, no barrel, no second array split by control, and no
// `setupServer` call -- constructing the server belongs to that module alone.
//
// Every endpoint the twelve specs exercise is registered, which is what makes
// `onUnhandledRequest: 'error'` useful rather than noisy: an unhandled request
// then means a genuine gap, and the fix is to add the handler rather than to
// weaken the setting.
//
// The eight per-control entries are DERIVED from `CONTROL_IDS` rather than
// written out, so the roster, the recorded payloads and the registered endpoints
// cannot drift apart, and a ninth control would extend all three at once. The
// default variant is the recorded PASSING payload for every control: the happy
// path each panel spec starts from, with every other state -- failing, unknown,
// warn, empty, 403, 404, 500 -- reached by installing one of the exported
// factories above through `server.use(...)`.
// ---------------------------------------------------------------------------

/**
 * The recorded request handlers for the whole posture surface.
 *
 * Invariant locked: this array is built from pure expressions over static
 * recorded data. Constructing it starts no server, opens no socket, reads no
 * clock and mutates nothing outside itself, so importing this module has no
 * observable effect beyond binding names.
 *
 * FROZEN, AND READONLY IN THE TYPE SYSTEM. Both halves are load-bearing, and
 * neither substitutes for the other. Module scope is shared by every importer in
 * a spec file, so a mutable exported array is shared mutable state: one
 * `handlers.push(...)` or `handlers.length = 0` in any spec -- or in any helper a
 * spec calls -- would change what every LATER spec in that file intercepts,
 * turning a real failure into a pass with no edit visible at the failure site.
 * `readonly RequestHandler[]` makes such a call a `tsc --noEmit` error, and
 * `Object.freeze` makes it throw at runtime under the strict mode ES modules
 * always run in, so neither a typecheck bypass nor a plain-JavaScript caller can
 * get past it.
 *
 * CONSUMERS SPREAD IT. `web/src/test/msw/server.ts` calls
 * `setupServer(...handlers)`, which copies into the server's own list, so
 * `server.use(...)` and `server.resetHandlers()` mutate that copy and never this
 * value. Any future consumer needing a mutable list must likewise spread into a
 * fresh array -- `[...handlers, extra]` -- rather than mutate this one.
 */
export const handlers: readonly RequestHandler[] = Object.freeze([
  // The eight per-control endpoints, then the collection the dashboard reads.
  ...CONTROL_IDS.map((controlId) =>
    controlStatusHandler(controlId, controlStatusFixture(controlId)),
  ),
  controlStatusListHandler(undefined, controlStatusListFixture()),

  // The audit listing: all nine observed events, passed through untouched.
  auditEventsHandler(ALL_OBSERVED_AUDIT_EVENTS),

  // The recorded API-server contract replays.
  subjectAccessReviewHandler(),
  podAdmissionHandler(),
  serviceAccountTokenHandler(),
  nodeStatusHandler(),
  secretReadHandler(),
  mutatingWebhookConfigurationHandler(),
  deploymentEncryptionConfigHandler(),
  integrationEncryptionConfigYamlHandler(),
]);

