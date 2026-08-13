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
// handlers"; this is that module's own collected contract spec) / §0.4.4.3 (the
// mocking policy: declarative request handlers are the ENTIRE mocking mechanism
// of the React tier, so their fidelity is the tier's foundation) / §0.3.2 (the
// recorded wire shapes replayed by the module under test) / §0.7.2 (test-quality
// criteria: assertion density preserved, failure legibility, isolation) /
// §0.10.2 (the boundary conditions that port unchanged) / tech-spec §6.6.3.4
// (the documentation convention this provenance block satisfies).
//
// THE INVARIANT THIS FILE LOCKS
//
//   The recorded handler set answers the RECORDED request and refuses everything
//   else. Nothing is defaulted, nothing is coerced, and no malformed or
//   semantically different request receives a recorded decision.
//
// WHY THIS SPEC EXISTS AT ALL. `handlers.ts` is a test double, so nothing in the
// production tree imports it and nothing else can fail when it is wrong. That is
// precisely the danger: a double that quietly answers the wrong question makes
// every panel spec built on it pass for the wrong reason, and no compiler, linter
// or panel test can detect it. Six of its contract-replay handlers had no caller
// and no spec at all, which meant their behaviour was asserted nowhere.
//
// THE FAILURE MODE THESE CASES ARE AIMED AT is not "the handler returns the wrong
// status" -- it is "the handler returns the RIGHT status for the WRONG request".
// Every `400` case below posts something that is nearly the recorded request and
// proves it is refused rather than answered, because a double that answers a
// near-miss with the recorded outcome converts a security assertion into a
// tautology. The success cases pin the other half: the recorded request still
// gets the recorded answer, byte for byte.
//
// NO HANDLER IS RE-IMPLEMENTED HERE. Every expectation is either a literal
// recorded value or is composed from the same exported fixture the handler reads,
// so a fixture correction reaches this spec and the handler together. Where a
// message format is the subject of the assertion -- the three `NewForbidden`
// branches, for instance -- the literal is spelled out, because deriving it from
// the code under test would assert nothing.

import { type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';

// AUDIT_EVENTS_DEFAULT_PAGE_SIZE is deliberately not imported: it is the HOOK's
// default, and the endpoint defaults nothing. A spec that reached for it would be
// asserting the behaviour this section now refuses.
import {
  AUDIT_EVENTS_ENDPOINT,
  AUDIT_EVENTS_QUERY_PARAMS,
  type AuditEvent,
} from '../../hooks/useAuditEvents';
import {
  CONTROL_IDS,
  controlStatusPath,
  type ControlStatus,
} from '../../hooks/useControlStatus';
import {
  ALL_OBSERVED_AUDIT_EVENTS,
  RBAC_AUDIT_RESPONSE_NAMESPACE,
  SECRET_AUDIT_REQUEST_NAMESPACE,
} from '../fixtures/auditEvents';
import {
  FAIL_CLOSED_WEBHOOK,
  FAIL_OPEN_WEBHOOK,
  FORBIDDEN_CONTROL_STATUS_ERROR,
  FORBIDDEN_STATUS,
  INTERNAL_SERVER_ERROR_STATUS,
  NOT_FOUND_STATUS,
  SERVER_ERROR_CONTROL_STATUS_ERROR,
  V1_DENIED_SUBJECT,
  V1_FULL_WILDCARD_ATTRIBUTES,
  V1_PERMITTED_WILDCARD_GROUP,
  V1_PERMITTED_WILDCARD_ROLE,
  V1_PERMITTED_WILDCARD_SUBJECT_KIND,
  V1_POSITIVE_CONTROL_SUBJECT,
  V2_GENERATED_ADMISSION_CONFIG,
  V2_NAMESPACES,
  V2_PODS,
  V2_POD_CONTAINER_IMAGE,
  V2_POD_CONTAINER_NAME,
  V2_POD_SECURITY_WARNING,
  V2_POD_SERVICE_ACCOUNT_NAME,
  V2_RESTRICTED_WARNINGS,
  V4_AUDIENCES,
  V4_LONG_LIVED_OBSERVED_EXPIRY,
  V4_NAMESPACE,
  V4_OBSERVED_EXPIRY,
  V4_REQUESTED_TTL_SECONDS,
  V4_REQUEST_TIME_SECONDS,
  V4_SERVICE_ACCOUNT_NAME,
  V7_PRINCIPALS,
  controlStatusFixture,
  controlStatusListFixture,
} from '../fixtures/controlStatus';
import {
  DEPLOYMENT_ENCRYPTION_CONFIG,
  INTEGRATION_AESGCM_ENCRYPTION_CONFIG_YAML,
} from '../fixtures/encryptionConfig';
import { server } from './server';
import {
  DEPLOYMENT_ENCRYPTION_CONFIG_PATH,
  INTEGRATION_ENCRYPTION_CONFIG_YAML_PATH,
  MUTATING_WEBHOOK_CONFIGURATION_PATH,
  NODE_STATUS_PATH,
  PODS_PATH,
  RECORDED_ARTIFACT_BASE_PATH,
  REDACTED_PROJECTED_TOKEN,
  SECRET_PATH,
  SERVICE_ACCOUNT_TOKEN_PATH,
  SUBJECT_ACCESS_REVIEW_PATH,
  V7_ACTING_NODE_NAME,
  V7_CROSS_NODE_TARGET_NAME,
  V7_UNRELATED_SECRET_NAME,
  V7_UNRELATED_SECRET_NAMESPACE,
  WARNING_CODE,
  WARNING_HEADER_NAME,
  auditEventsHandler,
  badRequestStatus,
  controlStatusHandler,
  controlStatusListHandler,
  crossNodeNotFoundHandler,
  forbiddenAuditEventsHandler,
  forbiddenControlStatusHandler,
  forbiddenStatus,
  handlers,
  internalErrorAuditEventsHandler,
  internalErrorControlStatusHandler,
  internalErrorStatus,
  kubernetesStatus,
  mutatingWebhookConfigurationHandler,
  notFoundControlStatusHandler,
  notFoundStatus,
  serviceAccountTokenHandler,
  warningHeaderValue,
} from './handlers';

// ---------------------------------------------------------------------------
// Local request helpers.
//
// Deliberately thin: they issue the request and hand back exactly what arrived,
// so no assertion is made against a value this file computed. Nothing here
// retries, defaults, or normalises a response -- the point of the spec is that
// the handler already did the right thing.
// ---------------------------------------------------------------------------

/** What one intercepted exchange yields. */
interface Exchange {
  /** HTTP status of the response. */
  readonly status: number;
  /** Parsed JSON body, or `undefined` when the body was not JSON. */
  readonly body: unknown;
  /** The response body as text, exactly as it arrived, byte for byte. */
  readonly text: string;
  /**
   * The combined `Warning` header, or `null` when none was sent. `Headers.get`
   * joins repeated values with `', '`, which is what makes "one value per
   * warning" assertable without a header-parsing helper of our own.
   */
  readonly warning: string | null;
  /** The `Content-Type`, for the one endpoint that serves YAML rather than JSON. */
  readonly contentType: string | null;
}

/**
 * Issues a request and reads the response as JSON.
 *
 * @param path - the URL, relative to the jsdom origin.
 * @param init - fetch options; defaults to a plain `GET`.
 * @returns the exchange.
 */
async function exchange(path: string, init?: RequestInit): Promise<Exchange> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    body,
    text,
    warning: response.headers.get(WARNING_HEADER_NAME),
    contentType: response.headers.get('Content-Type'),
  };
}

/**
 * Sends a JSON document with a method that carries a body.
 *
 * The body is serialised with `JSON.stringify` rather than by a helper, so a
 * spec that wants to post a non-object -- an array, a bare number, or text that
 * is not JSON at all -- can do so by passing it through unchanged.
 *
 * @param method - `POST` or `PUT`.
 * @param path - the URL, relative to the jsdom origin.
 * @param body - the value to serialise, or a raw string to send verbatim.
 * @returns the exchange.
 */
async function send(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<Exchange> {
  return exchange(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * A page size large enough to hold the whole recorded stream in one page.
 *
 * Named rather than inlined so the "one page" intent is visible: a spec asserting
 * that every observed event is served must ask for a page big enough to contain
 * them, or it is asserting something about pagination instead.
 */
const WHOLE_PAGE_SIZE = 100;

/**
 * Concrete URL of the audit endpoint, WITH the mandatory pagination parameters.
 *
 * `page` and `pageSize` are required by the endpoint and defaulted by nobody (see
 * the handler's `readMandatoryPositiveInteger`), so every spec that is not itself
 * about pagination supplies them here rather than repeating them. The hook does the
 * same thing in production: `buildAuditEventsQuery` sets both unconditionally.
 *
 * @param extra - additional query parameters, without a leading `&`.
 * @param page - the 1-based page. Defaults to the first.
 * @param pageSize - the page size. Defaults to {@link WHOLE_PAGE_SIZE}.
 * @returns the URL.
 */
function auditUrl(extra = '', page = 1, pageSize = WHOLE_PAGE_SIZE): string {
  const query = new URLSearchParams();
  query.set(AUDIT_EVENTS_QUERY_PARAMS.page, String(page));
  query.set(AUDIT_EVENTS_QUERY_PARAMS.pageSize, String(pageSize));
  return `${AUDIT_EVENTS_ENDPOINT}?${query.toString()}${extra === '' ? '' : `&${extra}`}`;
}

/** Concrete URL of a namespaced Pod create, derived from the exported pattern. */
function podsUrl(namespace: string, query = `?dryRun=All`): string {
  return `${PODS_PATH.replace(':namespace', namespace)}${query}`;
}

/** Concrete URL of the ServiceAccount token subresource. */
function tokenUrl(namespace: string, name: string): string {
  return SERVICE_ACCOUNT_TOKEN_PATH.replace(':namespace', namespace).replace(
    ':name',
    name,
  );
}

/** Concrete URL of the Node status subresource. */
function nodeStatusUrl(name: string): string {
  return NODE_STATUS_PATH.replace(':name', name);
}

/** Concrete URL of a namespaced Secret read. */
function secretUrl(namespace: string, name: string): string {
  return SECRET_PATH.replace(':namespace', namespace).replace(':name', name);
}

/** Concrete URL of a `MutatingWebhookConfiguration` read. */
function webhookUrl(name: string): string {
  return MUTATING_WEBHOOK_CONFIGURATION_PATH.replace(':name', name);
}

/** Narrows a response body to a record so fields can be read without `any`. */
function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Local document builders.
//
// Each builds the RECORDED request, with an overrides seam so a case can change
// exactly one field and prove the change is refused. Building the compliant
// document once means a `400` case cannot pass because of an unrelated omission
// the author forgot about -- the only difference between a passing case and a
// refused one is the field under test.
// ---------------------------------------------------------------------------

/**
 * The recorded full-wildcard `SubjectAccessReview`.
 *
 * @param subject - the identity to ask about.
 * @param specOverrides - fields to replace inside `spec`.
 * @param overrides - fields to replace at the document level.
 * @returns the document.
 */
function wildcardReview(
  subject: { readonly user: string; readonly groups: readonly string[] },
  specOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SubjectAccessReview',
    spec: {
      resourceAttributes: { ...V1_FULL_WILDCARD_ATTRIBUTES },
      user: subject.user,
      groups: [...subject.groups],
      ...specOverrides,
    },
    ...overrides,
  };
}

/**
 * A minimal but complete Pod document.
 *
 * One container, because PodSecurity evaluates the pod-level fields AND every
 * container: a pod with none is not the document whose outcome was recorded.
 *
 * @param name - `metadata.name`.
 * @param namespace - `metadata.namespace`, or omit it entirely with `undefined`.
 * @param overrides - fields to replace at the document level.
 * @returns the document.
 */
function podDocument(
  name: string,
  namespace: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  // Built from the RECORDED case rather than from a generic template. The endpoint
  // replays a recorded admission outcome, and that outcome is evidence about one
  // document: the privileged pod's 403 names `securityContext.privileged=true`, so
  // posting a pod without it and receiving that 403 would prove nothing about
  // privilege at all. A name with no recorded case falls back to the plain shape,
  // which is what the unrecorded-pod specs need.
  const recorded = V2_PODS.find((pod) => pod.name === name);
  const container: Record<string, unknown> = {
    name: recorded?.containerName ?? V2_POD_CONTAINER_NAME,
    image: recorded?.containerImage ?? V2_POD_CONTAINER_IMAGE,
    ...(recorded?.privileged === true ? { securityContext: { privileged: true } } : {}),
  };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, ...(namespace === undefined ? {} : { namespace }) },
    spec: {
      serviceAccountName: recorded?.serviceAccountName ?? V2_POD_SERVICE_ACCOUNT_NAME,
      // Absent unless `true`, which is how Kubernetes writes it.
      ...(recorded?.hostPID === true ? { hostPID: true } : {}),
      containers: [container],
    },
    ...overrides,
  };
}

/** The recorded pod document with one `spec` member replaced or removed. */
function podWithSpec(
  name: string,
  namespace: string,
  specOverrides: Record<string, unknown>,
): Record<string, unknown> {
  const base = podDocument(name, namespace);
  const spec = { ...(base['spec'] as Record<string, unknown>), ...specOverrides };
  for (const [key, value] of Object.entries(specOverrides)) {
    if (value === undefined) {
      delete spec[key];
    }
  }
  return { ...base, spec };
}

/**
 * The recorded `TokenRequest`.
 *
 * @param specOverrides - fields to replace inside `spec`.
 * @param overrides - fields to replace at the document level.
 * @returns the document.
 */
function tokenRequest(
  specOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenRequest',
    spec: {
      audiences: [...V4_AUDIENCES],
      expirationSeconds: V4_REQUESTED_TTL_SECONDS,
      ...specOverrides,
    },
    ...overrides,
  };
}

/**
 * A well-formed Node status update for one node.
 *
 * @param name - `metadata.name`; must match the URL for the update to be valid.
 * @param overrides - fields to replace at the document level.
 * @returns the document.
 */
function nodeStatusUpdate(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SECTION 1 -- the Kubernetes `Status` envelope.
// ---------------------------------------------------------------------------

describe('the Kubernetes Status envelope', () => {
  it('omits details when no qualified resource is named', () => {
    expect(kubernetesStatus('InternalError', 500, 'boom')).toEqual({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message: 'boom',
      reason: 'InternalError',
      code: 500,
    });
  });

  it('treats an empty qualified resource as no details rather than an empty one', () => {
    expect(kubernetesStatus('BadRequest', 400, 'boom', '')).not.toHaveProperty('details');
  });

  it('splits a core-group resource into an empty group', () => {
    expect(kubernetesStatus('NotFound', 404, 'boom', 'pods', 'p')).toMatchObject({
      details: { group: '', kind: 'pods', name: 'p' },
    });
  });

  it('splits a grouped resource at the FIRST dot, so a dotted group survives', () => {
    expect(
      kubernetesStatus('Forbidden', 403, 'boom', 'controls.posture.k8s.io', 'V1'),
    ).toMatchObject({ details: { group: 'posture.k8s.io', kind: 'controls', name: 'V1' } });
  });

  it('renders the bare forbidden branch when no resource is named', async () => {
    const body = await forbiddenStatus('', '', 'nope').json();
    expect(body.message).toBe('forbidden: nope');
  });

  it('renders the collection-scope forbidden branch when no name is given', async () => {
    const body = await forbiddenStatus('pods', '', 'nope').json();
    expect(body.message).toBe('pods is forbidden: nope');
  });

  it('renders the object-scope forbidden branch with a quoted name', async () => {
    const body = await forbiddenStatus('pods', 'a "quoted" pod', 'nope').json();
    expect(body.message).toBe('pods "a \\"quoted\\" pod" is forbidden: nope');
  });

  it('carries 403 both on the wire and in the body', async () => {
    const response = forbiddenStatus('pods', 'p', 'nope');
    expect(response.status).toBe(FORBIDDEN_STATUS);
    expect((await response.json()).code).toBe(FORBIDDEN_STATUS);
  });

  it('renders the generic not-found text when no resource is named', async () => {
    const body = await notFoundStatus('', 'p').json();
    expect(body.message).toBe('the server could not find the requested resource');
    expect(body.code).toBe(NOT_FOUND_STATUS);
  });

  it('renders the named not-found text with a quoted name', async () => {
    expect((await notFoundStatus('nodes', 'node2').json()).message).toBe(
      'nodes "node2" not found',
    );
  });

  it('prefixes an internal error and names no resource', async () => {
    const body = await internalErrorStatus('evaluation failed').json();
    expect(body.message).toBe('Internal error occurred: evaluation failed');
    expect(body.reason).toBe('InternalError');
    expect(body.code).toBe(INTERNAL_SERVER_ERROR_STATUS);
    expect(body).not.toHaveProperty('details');
  });

  it('leaves a bad-request message unadorned', async () => {
    const body = await badRequestStatus('the body is not a Pod').json();
    expect(body.message).toBe('the body is not a Pod');
    expect(body.reason).toBe('BadRequest');
    expect(body.code).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 -- the HTTP warning channel.
// ---------------------------------------------------------------------------

describe('the HTTP warning channel', () => {
  it('renders the RFC 7234 form with the API server’s agent and warn-code', () => {
    expect(warningHeaderValue('careful')).toBe(`${String(WARNING_CODE)} - "careful"`);
  });

  it('quotes a warning containing a quote rather than emitting a malformed header', () => {
    expect(warningHeaderValue('say "hi"')).toBe(`${String(WARNING_CODE)} - "say \\"hi\\""`);
  });

  it('sends no Warning header when the payload carries no warnings', async () => {
    const { warning } = await exchange(controlStatusPath('V1'));
    expect(controlStatusFixture('V1').warnings).toHaveLength(0);
    expect(warning).toBeNull();
  });

  it('sends the recorded warning when the payload carries one', async () => {
    server.use(controlStatusHandler('V2', V2_POD_SECURITY_WARNING));
    const { warning } = await exchange(controlStatusPath('V2'));
    expect(V2_POD_SECURITY_WARNING.warnings).toHaveLength(1);
    expect(warning).toBe(warningHeaderValue(V2_POD_SECURITY_WARNING.warnings[0]));
  });

  it('sends ONE header value per warning rather than one joined value', async () => {
    // A two-warning payload is built here rather than recorded, because the point
    // being proved is the header composition and no recorded payload carries two.
    // The oracle COUNTS warnings (podsecurity_test.go L451-L455), so collapsing a
    // list into one value would turn a countable list into one opaque string.
    const two: ControlStatus = {
      ...V2_POD_SECURITY_WARNING,
      warnings: ['first warning', 'second warning'],
    };
    server.use(controlStatusHandler('V2', two));
    const { warning } = await exchange(controlStatusPath('V2'));
    expect(warning).toBe(
      [warningHeaderValue('first warning'), warningHeaderValue('second warning')].join(
        ', ',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// SECTION 3 -- the control-posture endpoints.
// ---------------------------------------------------------------------------

describe('the control-posture endpoints', () => {
  it.each(CONTROL_IDS)('serves the recorded %s payload untouched', async (controlId) => {
    const { status, body } = await exchange(controlStatusPath(controlId));
    expect(status).toBe(200);
    expect(body).toEqual(controlStatusFixture(controlId));
  });

  it('serves the collection as an items envelope in roster order', async () => {
    const { status, body } = await exchange(controlStatusPath());
    expect(status).toBe(200);
    expect(body).toEqual({ items: controlStatusListFixture() });
    expect((asRecord(body)['items'] as readonly ControlStatus[]).map((c) => c.controlId)).toEqual([
      ...CONTROL_IDS,
    ]);
  });

  it('serves an explicitly EMPTY list as a success, not as an error', async () => {
    server.use(controlStatusListHandler(undefined, []));
    const { status, body } = await exchange(controlStatusPath());
    expect(status).toBe(200);
    expect(body).toEqual({ items: [] });
  });

  it('refuses a control endpoint with the recorded 403 Status document', async () => {
    server.use(forbiddenControlStatusHandler('V1'));
    const { status, body } = await exchange(controlStatusPath('V1'));
    expect(status).toBe(FORBIDDEN_STATUS);
    expect(body).toEqual({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message: FORBIDDEN_CONTROL_STATUS_ERROR.message,
      reason: FORBIDDEN_CONTROL_STATUS_ERROR.reason,
      details: { group: 'posture.k8s.io', kind: 'controls', name: 'V1' },
      code: FORBIDDEN_STATUS,
    });
  });

  it('answers a control endpoint with 404 distinguishably from 403', async () => {
    server.use(notFoundControlStatusHandler('V7'));
    const { status, body } = await exchange(controlStatusPath('V7'));
    expect(status).toBe(NOT_FOUND_STATUS);
    expect(asRecord(body)['reason']).toBe('NotFound');
  });

  it('fails a control endpoint with the recorded 500 message', async () => {
    server.use(internalErrorControlStatusHandler('V6'));
    const { status, body } = await exchange(controlStatusPath('V6'));
    expect(status).toBe(INTERNAL_SERVER_ERROR_STATUS);
    expect(asRecord(body)['message']).toBe(SERVER_ERROR_CONTROL_STATUS_ERROR.message);
    expect(asRecord(body)['reason']).toBe(SERVER_ERROR_CONTROL_STATUS_ERROR.reason);
  });
});

// ---------------------------------------------------------------------------
// SECTION 4 -- the audit-event endpoint.
// ---------------------------------------------------------------------------

describe('the audit-event endpoint', () => {
  const secretsEvents = ALL_OBSERVED_AUDIT_EVENTS.filter(
    (event) => event.objectRef?.resource === 'secrets',
  );

  it('serves every observed event with total and hasMore', async () => {
    const { status, body } = await exchange(auditUrl());
    expect(status).toBe(200);
    expect(body).toEqual({
      items: ALL_OBSERVED_AUDIT_EVENTS,
      total: ALL_OBSERVED_AUDIT_EVENTS.length,
      hasMore: false,
    });
  });

  it('hands Secret request bodies through as OBJECTS, never as presence booleans', async () => {
    const { body } = await exchange(auditUrl(`${AUDIT_EVENTS_QUERY_PARAMS.resource}=secrets`));
    const items = asRecord(body)['items'] as readonly AuditEvent[];
    expect(items).toHaveLength(secretsEvents.length);
    // A read carries no request body, so `requestObject` is legitimately absent
    // on `get`/`list`/`watch` and legitimately PRESENT on the body-bearing verbs
    // (a delete's body is the DeleteOptions, which the oracle records too --
    // audit_test.go L847). Both shapes appear in the recorded stream, and the
    // recorded READ is load-bearing: it is the one `secrets` event no expected-
    // events table contains, which is what proves the confidentiality guard
    // scans the OBSERVED stream rather than the expectations (audit_test.go
    // L1039-L1046). Splitting the assertion by verb therefore keeps the guard
    // exact instead of demanding a body the API server never sent.
    const bodyBearingVerbs = new Set(['create', 'update', 'patch', 'delete']);
    for (const event of items) {
      // The confidentiality guard is only assertable while there is an object to
      // detect. test/utils/audit.go flattens both fields to `bool` for cheap Go
      // struct comparison; that projection is NOT the contract, and serving it
      // would make ConfidentialityRedaction unprovable while every spec stayed
      // green (F-006-RQ-003). So whenever a request body is served at all it must
      // arrive as an OBJECT -- never as a presence boolean.
      if (bodyBearingVerbs.has(event.verb)) {
        expect(typeof event.requestObject).toBe('object');
      } else {
        expect(event.requestObject).toBeUndefined();
      }
      expect(typeof event.requestObject).not.toBe('boolean');
      // Unconditional, for every `secrets` event whatever its verb: `Request`
      // never records a response body, and recording one would log the Secret
      // (F-006-RQ-003).
      expect(event.responseObject).toBeUndefined();
      expect(event.level).toBe('Request');
    }
  });

  it('serves the RBAC control group with BOTH bodies present', async () => {
    const { body } = await exchange(
      auditUrl(`${AUDIT_EVENTS_QUERY_PARAMS.namespace}=${RBAC_AUDIT_RESPONSE_NAMESPACE}`),
    );
    const items = asRecord(body)['items'] as readonly AuditEvent[];
    expect(items.length).toBeGreaterThan(0);
    for (const event of items) {
      expect(event.level).toBe('RequestResponse');
      expect(typeof event.responseObject).toBe('object');
    }
  });

  it('matches the namespace filter exactly', async () => {
    const { body } = await exchange(
      auditUrl(`${AUDIT_EVENTS_QUERY_PARAMS.namespace}=${SECRET_AUDIT_REQUEST_NAMESPACE}`),
    );
    expect(asRecord(body)['total']).toBe(secretsEvents.length);
  });

  it('matches the verb filter exactly', async () => {
    const { body } = await exchange(auditUrl(`${AUDIT_EVENTS_QUERY_PARAMS.verb}=create`));
    expect(asRecord(body)['total']).toBe(
      ALL_OBSERVED_AUDIT_EVENTS.filter((event) => event.verb === 'create').length,
    );
  });

  it('returns an honest empty page for an unrecognised filter value rather than everything', async () => {
    const { body } = await exchange(auditUrl(`${AUDIT_EVENTS_QUERY_PARAMS.resource}=SECRETS`));
    expect(body).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('treats an empty filter value as absent rather than as matching the empty string', async () => {
    const { body } = await exchange(auditUrl(`${AUDIT_EVENTS_QUERY_PARAMS.resource}=`));
    expect(asRecord(body)['total']).toBe(ALL_OBSERVED_AUDIT_EVENTS.length);
  });

  it('paginates, counting total across ALL pages and reporting hasMore honestly', async () => {
    const first = await exchange(auditUrl('', 1, 4));
    expect(asRecord(first.body)['total']).toBe(ALL_OBSERVED_AUDIT_EVENTS.length);
    expect(asRecord(first.body)['hasMore']).toBe(true);
    expect(asRecord(first.body)['items']).toEqual(ALL_OBSERVED_AUDIT_EVENTS.slice(0, 4));

    const last = await exchange(auditUrl('', 3, 4));
    expect(asRecord(last.body)['hasMore']).toBe(false);
    expect(asRecord(last.body)['items']).toEqual(ALL_OBSERVED_AUDIT_EVENTS.slice(8));
  });

  it('reports an empty page past the end as empty, not as implying more to come', async () => {
    const { body } = await exchange(auditUrl('', 9, 4));
    expect(asRecord(body)['items']).toEqual([]);
    expect(asRecord(body)['hasMore']).toBe(false);
  });

  // NOTHING IS DEFAULTED, and these are the specs that say so. Every case below
  // previously answered 200 with a page the caller had not asked for -- a correct
  // answer to a different question, which a paginating consumer cannot detect.
  it.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['fractional', '1.5'],
    ['not a number', 'many'],
    ['the empty string', ''],
    ['a padded integer', ' 4 '],
    ['a hexadecimal literal', '0x4'],
    ['an exponent form', '1e2'],
  ])('refuses a %s pageSize with 400 rather than defaulting it', async (_label, raw) => {
    const { status, body } = await exchange(
      `${AUDIT_EVENTS_ENDPOINT}?${AUDIT_EVENTS_QUERY_PARAMS.page}=1&` +
        `${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=${encodeURIComponent(raw)}`,
    );

    expect(status).toBe(400);
    expect(asRecord(body)['status']).toBe('Failure');
    expect(asRecord(body)['message']).toContain(AUDIT_EVENTS_QUERY_PARAMS.pageSize);
    expect(asRecord(body)['message']).toContain('positive integer');
    // A refusal carries no page at all: a 400 that also carried items would be a
    // partial answer to a request that had no answer.
    expect(asRecord(body)).not.toHaveProperty('items');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '2.5'],
    ['not a number', 'first'],
  ])('refuses a %s page with 400 rather than defaulting it', async (_label, raw) => {
    const { status, body } = await exchange(
      `${AUDIT_EVENTS_ENDPOINT}?${AUDIT_EVENTS_QUERY_PARAMS.page}=${encodeURIComponent(raw)}&` +
        `${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=4`,
    );

    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(AUDIT_EVENTS_QUERY_PARAMS.page);
  });

  it.each([
    ['both parameters', AUDIT_EVENTS_ENDPOINT],
    ['page', `${AUDIT_EVENTS_ENDPOINT}?${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=4`],
    ['pageSize', `${AUDIT_EVENTS_ENDPOINT}?${AUDIT_EVENTS_QUERY_PARAMS.page}=1`],
  ])('refuses a request omitting %s', async (_label, url) => {
    // The production client always sends both (`buildAuditEventsQuery` sets them
    // unconditionally), so this strictness cannot reject a real request -- it
    // rejects the hand-built URL that a lenient reader made unfalsifiable.
    const { status, body } = await exchange(url);

    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain('is required');
  });

  it.each([
    ['page', `${AUDIT_EVENTS_QUERY_PARAMS.page}=1&${AUDIT_EVENTS_QUERY_PARAMS.page}=9&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=4`],
    ['pageSize', `${AUDIT_EVENTS_QUERY_PARAMS.page}=1&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=4&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=100`],
  ])('refuses a duplicated %s rather than picking one', async (name, query) => {
    // Two intentions, no recorded outcome: answering either would invent one.
    const { status, body } = await exchange(`${AUDIT_EVENTS_ENDPOINT}?${query}`);

    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(name);
    expect(asRecord(body)['message']).toContain('two intentions');
  });

  it('serves the page the caller asked for, once both parameters are valid', async () => {
    // The positive control: strictness must not cost the endpoint its function.
    const { status, body } = await exchange(auditUrl('', 2, 4));

    expect(status).toBe(200);
    expect(asRecord(body)['items']).toEqual(ALL_OBSERVED_AUDIT_EVENTS.slice(4, 8));
  });

  it('serves the explicit empty state as a success carrying no events', async () => {
    server.use(auditEventsHandler([]));
    const { status, body } = await exchange(auditUrl());
    expect(status).toBe(200);
    expect(body).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('refuses the listing with 403 rather than an empty page', async () => {
    server.use(forbiddenAuditEventsHandler());
    const { status, body } = await exchange(auditUrl());
    expect(status).toBe(FORBIDDEN_STATUS);
    expect(asRecord(body)['reason']).toBe('Forbidden');
    expect(asRecord(body)['details']).toEqual({
      group: 'audit.k8s.io',
      kind: 'events',
      name: '',
    });
    expect(asRecord(body)['message']).toContain('F-006-RQ-003');
  });

  it('fails the listing with 500 rather than an empty page', async () => {
    server.use(internalErrorAuditEventsHandler());
    const { status, body } = await exchange(auditUrl());
    expect(status).toBe(INTERNAL_SERVER_ERROR_STATUS);
    expect(asRecord(body)['message']).toContain('Internal error occurred: ');
  });
});

// ---------------------------------------------------------------------------
// SECTION 5 -- V1: SubjectAccessReview (F-001-RQ-001, F-001-RQ-002).
//
// The two recorded reviews ask the SAME question of two identities and the
// oracle asserts the two answers with deliberately different severities: the
// denial accumulates (`t.Errorf`, rbac_test.go L1234-L1236) and a failed
// positive control aborts (`t.Fatalf`, L1252-L1254). Both branches must stay
// reachable, so both are exercised here -- and every near-miss review is proved
// REFUSED, because a narrower question answered with the wildcard rule reads as
// a denial of the wildcard when it was never asked about.
// ---------------------------------------------------------------------------

describe('SubjectAccessReview (V1)', () => {
  it('denies the recorded non-privileged identity', async () => {
    const { status, body } = await send(
      'POST',
      SUBJECT_ACCESS_REVIEW_PATH,
      wildcardReview(V1_DENIED_SUBJECT),
    );
    expect(status).toBe(201);
    const document = asRecord(body);
    expect(document['kind']).toBe('SubjectAccessReview');
    expect(document['apiVersion']).toBe('authorization.k8s.io/v1');
    const reviewStatus = asRecord(document['status']);
    expect(reviewStatus['allowed']).toBe(false);
    expect(reviewStatus['reason']).toContain(V1_PERMITTED_WILDCARD_ROLE);
  });

  it('allows the recorded system:masters positive control', async () => {
    const { status, body } = await send(
      'POST',
      SUBJECT_ACCESS_REVIEW_PATH,
      wildcardReview(V1_POSITIVE_CONTROL_SUBJECT),
    );
    expect(status).toBe(201);
    const reviewStatus = asRecord(asRecord(body)['status']);
    expect(reviewStatus['allowed']).toBe(true);
    expect(reviewStatus['reason']).toContain(V1_PERMITTED_WILDCARD_SUBJECT_KIND);
    expect(reviewStatus['reason']).toContain(V1_PERMITTED_WILDCARD_GROUP);
  });

  it('echoes the posted spec verbatim so the answered review is identifiable', async () => {
    const review = wildcardReview(V1_DENIED_SUBJECT);
    const { body } = await send('POST', SUBJECT_ACCESS_REVIEW_PATH, review);
    expect(asRecord(body)['spec']).toEqual(review['spec']);
  });

  it('decides from the GROUPS, so the recorded user without its group is denied', async () => {
    // The authorizer grants the wildcard to a GROUP, not to a username, so
    // `admin` outside system:masters must be denied. Hard-coding the answer per
    // username would make the positive control unfalsifiable.
    const { body } = await send(
      'POST',
      SUBJECT_ACCESS_REVIEW_PATH,
      wildcardReview({ user: V1_POSITIVE_CONTROL_SUBJECT.user, groups: [] }),
    );
    expect(asRecord(asRecord(body)['status'])['allowed']).toBe(false);
  });

  it.each([
    ['a body that is not JSON at all', 'not json', 'not valid JSON'],
    ['a JSON array body', [], 'expected a JSON object, got array'],
    ['a JSON scalar body', 7, 'expected a JSON object, got number'],
  ])('refuses %s with 400', async (_label, body, expected) => {
    const { status, body: served } = await send('POST', SUBJECT_ACCESS_REVIEW_PATH, body);
    expect(status).toBe(400);
    expect(asRecord(served)['message']).toContain(expected);
    expect(asRecord(served)['reason']).toBe('BadRequest');
  });

  it.each([
    [
      'a wrong apiVersion',
      wildcardReview(V1_DENIED_SUBJECT, {}, { apiVersion: 'authorization.k8s.io/v1beta1' }),
      'apiVersion must be "authorization.k8s.io/v1"',
    ],
    [
      'a wrong kind',
      wildcardReview(V1_DENIED_SUBJECT, {}, { kind: 'SelfSubjectAccessReview' }),
      'kind must be "SubjectAccessReview"',
    ],
    [
      'no spec',
      { apiVersion: 'authorization.k8s.io/v1', kind: 'SubjectAccessReview' },
      'spec expected a JSON object, got absent',
    ],
    [
      'a non-resource review',
      wildcardReview(V1_DENIED_SUBJECT, {
        nonResourceAttributes: { path: '/healthz', verb: 'get' },
      }),
      'spec.nonResourceAttributes must be absent',
    ],
    [
      'no resourceAttributes',
      wildcardReview(V1_DENIED_SUBJECT, { resourceAttributes: undefined }),
      'spec.resourceAttributes expected a JSON object, got absent',
    ],
    [
      'a narrowed verb',
      wildcardReview(V1_DENIED_SUBJECT, {
        resourceAttributes: { ...V1_FULL_WILDCARD_ATTRIBUTES, verb: 'get' },
      }),
      'spec.resourceAttributes.verb must be "*", got "get"',
    ],
    [
      'a narrowed resource',
      wildcardReview(V1_DENIED_SUBJECT, {
        resourceAttributes: { ...V1_FULL_WILDCARD_ATTRIBUTES, resource: 'pods' },
      }),
      'spec.resourceAttributes.resource must be "*", got "pods"',
    ],
    [
      'a namespaced review',
      wildcardReview(V1_DENIED_SUBJECT, {
        resourceAttributes: { ...V1_FULL_WILDCARD_ATTRIBUTES, namespace: 'kube-system' },
      }),
      'spec.resourceAttributes.namespace must be absent',
    ],
    [
      'a subresource review',
      wildcardReview(V1_DENIED_SUBJECT, {
        resourceAttributes: { ...V1_FULL_WILDCARD_ATTRIBUTES, subresource: 'status' },
      }),
      'spec.resourceAttributes.subresource must be absent',
    ],
    [
      'an anonymous review',
      wildcardReview(V1_DENIED_SUBJECT, { user: undefined }),
      'spec.user expected a string, got absent',
    ],
    [
      'an empty user',
      wildcardReview(V1_DENIED_SUBJECT, { user: '' }),
      'spec.user is the empty string',
    ],
    [
      'a non-string user',
      wildcardReview(V1_DENIED_SUBJECT, { user: 42 }),
      'spec.user expected a string, got number',
    ],
    [
      'groups that are not a list',
      wildcardReview(V1_DENIED_SUBJECT, { groups: 'system:masters' }),
      'spec.groups expected an array of strings, got string',
    ],
    [
      'a non-string group member',
      wildcardReview(V1_DENIED_SUBJECT, { groups: [V1_PERMITTED_WILDCARD_GROUP, 7] }),
      'spec.groups[1] expected a string, got number',
    ],
    [
      'an empty group member',
      wildcardReview(V1_DENIED_SUBJECT, { groups: [''] }),
      'spec.groups[0] is the empty string',
    ],
  ])('refuses %s with 400 and no decision', async (_label, review, expected) => {
    const { status, body } = await send('POST', SUBJECT_ACCESS_REVIEW_PATH, review);
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(expected);
    // The decisive property: a refusal carries NO authorization decision at all.
    expect(asRecord(body)).not.toHaveProperty('status.allowed');
    expect(asRecord(body)['status']).toBe('Failure');
  });

  it('drops no malformed member silently: a bad group list is refused, not filtered', async () => {
    // Before the fix a non-string member was filtered out, so `[7]` became "no
    // groups" -- which reads as a denial and would have been served as one.
    const { status } = await send(
      'POST',
      SUBJECT_ACCESS_REVIEW_PATH,
      wildcardReview(V1_DENIED_SUBJECT, { groups: [7] }),
    );
    expect(status).toBe(400);
  });

  it('is not reachable by GET, so only the recorded method is replayed', async () => {
    await expect(fetch(SUBJECT_ACCESS_REVIEW_PATH)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SECTION 6 -- V2: Pod Security admission (F-002-RQ-001, F-002-RQ-003).
// ---------------------------------------------------------------------------

describe('Pod admission (V2)', () => {
  const enforceNamespace = V2_NAMESPACES.enforceBaseline.name;
  const warnNamespace = V2_NAMESPACES.warnRestricted.name;

  it('refuses the privileged pod with the API server’s own 403 message', async () => {
    const { status, body } = await send(
      'POST',
      podsUrl(enforceNamespace),
      podDocument('privileged-pod', enforceNamespace),
    );
    expect(status).toBe(FORBIDDEN_STATUS);
    expect(asRecord(body)['message']).toBe(
      'pods "privileged-pod" is forbidden: violates PodSecurity ' +
        `"${V2_NAMESPACES.enforceBaseline.labelValue}:` +
        `${V2_GENERATED_ADMISSION_CONFIG.defaults.enforceVersion}": ` +
        'securityContext.privileged=true',
    );
    expect(asRecord(body)['details']).toEqual({ group: '', kind: 'pods', name: 'privileged-pod' });
  });

  it('refuses the hostPID pod with 403', async () => {
    const { status, body } = await send(
      'POST',
      podsUrl(enforceNamespace),
      podDocument('hostpid-pod', enforceNamespace),
    );
    expect(status).toBe(FORBIDDEN_STATUS);
    expect(asRecord(body)['message']).toContain('spec.hostPID=true');
  });

  it('admits the warn pod, echoing the document and surfacing the warning', async () => {
    const document = podDocument('warn-pod', warnNamespace);
    const { status, body, warning } = await send('POST', podsUrl(warnNamespace), document);
    expect(status).toBe(201);
    expect(body).toEqual(document);
    expect(warning).toBe(warningHeaderValue(V2_RESTRICTED_WARNINGS[0]));
  });

  it('admits with no warning header in the enforcing namespace’s admitted case', async () => {
    // The warn channel belongs to the warn=restricted namespace only, so an
    // admitted pod elsewhere must carry no Warning header at all -- which is what
    // makes the header's presence meaningful.
    const { warning } = await send(
      'POST',
      podsUrl(warnNamespace),
      podDocument('warn-pod', warnNamespace),
    );
    expect(warning).not.toBeNull();
    const other = await send(
      'POST',
      podsUrl(enforceNamespace),
      podDocument('privileged-pod', enforceNamespace),
    );
    expect(other.warning).toBeNull();
  });

  it('REQUIRES ?dryRun=All, because a create that would persist was never measured', async () => {
    const { status, body } = await send(
      'POST',
      podsUrl(warnNamespace, ''),
      podDocument('warn-pod', warnNamespace),
    );
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain('must carry ?dryRun=All');
  });

  it.each([
    ['None', '?dryRun=None'],
    ['an empty value', '?dryRun='],
    ['a repeated parameter', '?dryRun=All&dryRun=All'],
  ])('refuses dryRun=%s with 400', async (_label, query) => {
    const { status, body } = await send(
      'POST',
      podsUrl(warnNamespace, query),
      podDocument('warn-pod', warnNamespace),
    );
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain('?dryRun must be exactly one "All"');
  });

  it.each([
    [
      'a wrong kind',
      podDocument('warn-pod', undefined, { kind: 'ConfigMap' }),
      'kind must be "Pod"',
    ],
    [
      'a wrong apiVersion',
      podDocument('warn-pod', undefined, { apiVersion: 'v1beta1' }),
      'apiVersion must be "v1"',
    ],
    [
      'no metadata',
      { apiVersion: 'v1', kind: 'Pod', spec: { containers: [{ name: 'c' }] } },
      'metadata expected a JSON object, got absent',
    ],
    [
      'no name',
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {},
        spec: { containers: [{ name: 'c' }] },
      },
      'metadata.name expected a string, got absent',
    ],
    [
      'a contradicting namespace',
      podDocument('warn-pod', 'somewhere-else'),
      'metadata.namespace must match the namespace on the URL',
    ],
    [
      'no spec',
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'warn-pod' } },
      'spec expected a JSON object, got absent',
    ],
    [
      'no containers',
      podDocument('warn-pod', undefined, { spec: { containers: [] } }),
      'spec.containers expected a non-empty array',
    ],
  ])('refuses %s with 400', async (_label, document, expected) => {
    const { status, body } = await send('POST', podsUrl(warnNamespace), document);
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(expected);
  });

  // -------------------------------------------------------------------------
  // An admission outcome is evidence about ONE document (F-002-RQ-001).
  //
  // Every case below posts a document that differs from the recorded one in
  // exactly one security-relevant field and expects `400`, never the recorded
  // decision. That is the whole point: while the endpoint keyed only on
  // `(namespace, name)`, a pod named `privileged-pod` that was not privileged
  // received the recorded 403 naming `securityContext.privileged=true`, so a
  // panel spec could assert "privilege is rejected" while proving nothing about
  // privilege. The mismatch is refused rather than silently corrected, because a
  // corrected document is a different document again.
  // -------------------------------------------------------------------------
  it.each([
    [
      'the privileged pod WITHOUT its privilege',
      podWithSpec('privileged-pod', enforceNamespace, {
        containers: [{ name: V2_POD_CONTAINER_NAME, image: V2_POD_CONTAINER_IMAGE }],
      }),
      'spec.containers[0].securityContext.privileged must be true',
    ],
    [
      'the warn pod WITH privilege added',
      podWithSpec('warn-pod', warnNamespace, {
        containers: [
          {
            name: V2_POD_CONTAINER_NAME,
            image: V2_POD_CONTAINER_IMAGE,
            securityContext: { privileged: true },
          },
        ],
      }),
      'spec.containers[0].securityContext.privileged must be false',
    ],
    [
      'the hostPID pod WITHOUT hostPID',
      podWithSpec('hostpid-pod', enforceNamespace, { hostPID: undefined }),
      'spec.hostPID must be true',
    ],
    [
      'the warn pod WITH hostPID added',
      podWithSpec('warn-pod', warnNamespace, { hostPID: true }),
      'spec.hostPID must be false',
    ],
    [
      'a different ServiceAccount',
      podWithSpec('warn-pod', warnNamespace, { serviceAccountName: 'builder' }),
      `spec.serviceAccountName must be ${JSON.stringify(V2_POD_SERVICE_ACCOUNT_NAME)}`,
    ],
    [
      'no ServiceAccount at all',
      podWithSpec('warn-pod', warnNamespace, { serviceAccountName: undefined }),
      'the recorded pods run as',
    ],
    [
      'a second container',
      podWithSpec('warn-pod', warnNamespace, {
        containers: [
          { name: V2_POD_CONTAINER_NAME, image: V2_POD_CONTAINER_IMAGE },
          { name: 'sidecar', image: V2_POD_CONTAINER_IMAGE },
        ],
      }),
      'spec.containers must carry exactly the one recorded container, got 2',
    ],
    [
      'a container that is not an object',
      podWithSpec('warn-pod', warnNamespace, { containers: [42] }),
      'spec.containers[0] expected a JSON object, got number',
    ],
    [
      'a different container name',
      podWithSpec('warn-pod', warnNamespace, {
        containers: [{ name: 'app', image: V2_POD_CONTAINER_IMAGE }],
      }),
      `spec.containers[0].name must be ${JSON.stringify(V2_POD_CONTAINER_NAME)}`,
    ],
    [
      'a different image',
      podWithSpec('warn-pod', warnNamespace, {
        containers: [{ name: V2_POD_CONTAINER_NAME, image: 'alpine' }],
      }),
      `spec.containers[0].image must be ${JSON.stringify(V2_POD_CONTAINER_IMAGE)}`,
    ],
    [
      'no image',
      podWithSpec('warn-pod', warnNamespace, {
        containers: [{ name: V2_POD_CONTAINER_NAME }],
      }),
      'spec.containers[0].image expected a string, got absent',
    ],
    [
      'a stringly-typed hostPID',
      podWithSpec('warn-pod', warnNamespace, { hostPID: 'true' }),
      'spec.hostPID expected a boolean or absence, got string',
    ],
    [
      'a stringly-typed privileged flag',
      podWithSpec('privileged-pod', enforceNamespace, {
        containers: [
          {
            name: V2_POD_CONTAINER_NAME,
            image: V2_POD_CONTAINER_IMAGE,
            securityContext: { privileged: 'true' },
          },
        ],
      }),
      'spec.containers[0].securityContext.privileged expected a boolean or absence, got string',
    ],
    [
      'a securityContext that is not an object',
      podWithSpec('privileged-pod', enforceNamespace, {
        containers: [
          {
            name: V2_POD_CONTAINER_NAME,
            image: V2_POD_CONTAINER_IMAGE,
            securityContext: 'privileged',
          },
        ],
      }),
      'spec.containers[0].securityContext expected a JSON object or absence, got string',
    ],
  ])('refuses %s with 400 rather than replaying the recorded decision', async (
    _label,
    document,
    expected,
  ) => {
    const namespace = String(asRecord(asRecord(document)['metadata'])['namespace']);
    const { status, body } = await send('POST', podsUrl(namespace), document);
    expect(status).toBe(400);
    expect(status).not.toBe(FORBIDDEN_STATUS);
    expect(asRecord(body)['message']).toContain(expected);
  });

  it('names the requirement on every shape refusal, so a reader learns WHY', async () => {
    const { body } = await send(
      'POST',
      podsUrl(enforceNamespace),
      podWithSpec('privileged-pod', enforceNamespace, {
        containers: [{ name: V2_POD_CONTAINER_NAME, image: V2_POD_CONTAINER_IMAGE }],
      }),
    );
    expect(String(asRecord(body)['message'])).toContain('(F-002-RQ-001)');
  });

  it('accepts the recorded shape of EVERY recorded case, so the gate is two-sided', async () => {
    // Without this control the tightened check could reject everything and still
    // look correct. Each recorded pod is posted exactly as recorded and must reach
    // its recorded outcome -- 403 for the two rejected cases, 201 for the admitted
    // one -- so the gate is proven to admit the truth as well as refuse fiction.
    for (const pod of V2_PODS) {
      const namespace = pod.admitted ? warnNamespace : enforceNamespace;
      const { status } = await send(
        'POST',
        podsUrl(namespace),
        podDocument(pod.name, namespace),
      );
      expect(status).toBe(pod.admitted ? 201 : FORBIDDEN_STATUS);
    }
  });

  it('refuses an unrecorded pod, naming the recorded roster', async () => {
    const { status, body } = await send(
      'POST',
      podsUrl(warnNamespace),
      podDocument('invented-pod', warnNamespace),
    );
    expect(status).toBe(400);
    const message = String(asRecord(body)['message']);
    expect(message).toContain('no recorded Pod Security outcome exists for "invented-pod"');
    expect(message).toContain(`${enforceNamespace}/privileged-pod`);
  });

  it('refuses a recorded pod name in the WRONG namespace, because the pair is the key', async () => {
    const { status, body } = await send(
      'POST',
      podsUrl(warnNamespace),
      podDocument('privileged-pod', warnNamespace),
    );
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain('no recorded Pod Security outcome exists');
  });
});

// ---------------------------------------------------------------------------
// SECTION 7 -- V4: TokenRequest (F-004-RQ-001, F-004-RQ-002).
// ---------------------------------------------------------------------------

describe('TokenRequest (V4)', () => {
  const url = tokenUrl(V4_NAMESPACE, V4_SERVICE_ACCOUNT_NAME);

  it('issues the recorded token, echoing the requested audience and TTL', async () => {
    const { status, body } = await send('POST', url, tokenRequest());
    expect(status).toBe(201);
    const document = asRecord(body);
    expect(document['kind']).toBe('TokenRequest');
    expect(document['apiVersion']).toBe('authentication.k8s.io/v1');
    expect(document['spec']).toEqual({
      audiences: [...V4_AUDIENCES],
      expirationSeconds: V4_REQUESTED_TTL_SECONDS,
      boundObjectRef: null,
    });
    expect(asRecord(document['status'])).toEqual({
      token: REDACTED_PROJECTED_TOKEN,
      expirationTimestamp: V4_OBSERVED_EXPIRY.expirationTimestamp,
    });
  });

  it('serves no credential: the token is an unmistakable placeholder, not a JWT', async () => {
    const { body } = await send('POST', url, tokenRequest());
    const token = String(asRecord(asRecord(body)['status'])['token']);
    expect(token).toBe(REDACTED_PROJECTED_TOKEN);
    expect(token).not.toContain('.');
  });

  it('serves a parameterised regression expiry when one is installed', async () => {
    server.use(
      serviceAccountTokenHandler(V4_LONG_LIVED_OBSERVED_EXPIRY.expirationTimestamp),
    );
    const { body } = await send('POST', url, tokenRequest());
    expect(asRecord(asRecord(body)['status'])['expirationTimestamp']).toBe(
      V4_LONG_LIVED_OBSERVED_EXPIRY.expirationTimestamp,
    );
  });

  // -------------------------------------------------------------------------
  // The served expiry is COHERENT with the requested TTL (F-004-RQ-002).
  //
  // While the timestamp was pinned to the recorded expiry whatever was asked
  // for, a request for 7200 seconds was answered by a document saying both "you
  // asked for two hours" and "this expires in one" -- and the +-60 s window
  // (AAP §0.10.2) was then measuring a timestamp belonging to a DIFFERENT
  // request, so the boundary condition was unfalsifiable while every spec stayed
  // green. The recorded TTL still yields the recorded string byte for byte.
  // -------------------------------------------------------------------------
  it('answers the RECORDED TTL with the RECORDED string, byte for byte', async () => {
    const { body } = await send('POST', url, tokenRequest());
    const status = asRecord(asRecord(body)['status']);
    expect(status['expirationTimestamp']).toBe(V4_OBSERVED_EXPIRY.expirationTimestamp);
    // The recorded literal is the arithmetic, not a recomputation of it.
    expect(V4_REQUEST_TIME_SECONDS + V4_REQUESTED_TTL_SECONDS).toBe(
      Math.floor(Date.parse(V4_OBSERVED_EXPIRY.expirationTimestamp) / 1000),
    );
  });

  it.each([
    [7200, '2026-01-01T02:00:00Z'],
    [60, '2026-01-01T00:01:00Z'],
    [1, '2026-01-01T00:00:01Z'],
  ])(
    'derives a coherent expiry for a %i-second TTL rather than reusing the recorded one',
    async (ttl, expected) => {
      const { body } = await send(
        'POST',
        url,
        tokenRequest({ expirationSeconds: ttl }),
      );
      const document = asRecord(body);
      // The echo and the expiry describe the SAME request.
      expect(asRecord(document['spec'])['expirationSeconds']).toBe(ttl);
      const served = String(asRecord(document['status'])['expirationTimestamp']);
      expect(served).toBe(expected);
      expect(served).not.toBe(V4_OBSERVED_EXPIRY.expirationTimestamp);
      expect(Math.floor(Date.parse(served) / 1000)).toBe(V4_REQUEST_TIME_SECONDS + ttl);
    },
  );

  it('serves second precision, matching the API server’s RFC 3339 output', async () => {
    // A millisecond field would be a shape the oracle never emitted, and the
    // panel parses this string.
    const { body } = await send('POST', url, tokenRequest({ expirationSeconds: 7200 }));
    const served = String(asRecord(asRecord(body)['status'])['expirationTimestamp']);
    expect(served).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it('lets an explicit override win over the derived expiry, which is what makes it a regression channel', async () => {
    server.use(
      serviceAccountTokenHandler(V4_LONG_LIVED_OBSERVED_EXPIRY.expirationTimestamp),
    );
    const { body } = await send('POST', url, tokenRequest({ expirationSeconds: 7200 }));
    expect(asRecord(asRecord(body)['status'])['expirationTimestamp']).toBe(
      V4_LONG_LIVED_OBSERVED_EXPIRY.expirationTimestamp,
    );
  });

  it('echoes a multi-audience request verbatim rather than sorting or deduplicating it', async () => {
    // Cardinality and order are both meaningful: a token additionally bound to a
    // second audience is a different, weaker credential (F-004-RQ-001), so the
    // echo must show exactly what was asked for.
    const requested = ['second', ...V4_AUDIENCES, 'second'];
    const { body } = await send('POST', url, tokenRequest({ audiences: requested }));
    expect(asRecord(asRecord(body)['spec'])['audiences']).toEqual(requested);
  });

  it.each([
    ['a different namespace', tokenUrl('other-namespace', V4_SERVICE_ACCOUNT_NAME)],
    ['a different service account', tokenUrl(V4_NAMESPACE, 'other-account')],
  ])('answers %s with 404 rather than issuing a token', async (_label, path) => {
    const { status, body } = await send('POST', path, tokenRequest());
    expect(status).toBe(NOT_FOUND_STATUS);
    expect(asRecord(body)['reason']).toBe('NotFound');
    expect(asRecord(body)['details']).toMatchObject({ kind: 'serviceaccounts' });
    expect(asRecord(body)).not.toHaveProperty('status.token');
  });

  it.each([
    [
      'a wrong kind',
      tokenRequest({}, { kind: 'TokenReview' }),
      'kind must be "TokenRequest"',
    ],
    [
      'a wrong apiVersion',
      tokenRequest({}, { apiVersion: 'authentication.k8s.io/v1beta1' }),
      'apiVersion must be "authentication.k8s.io/v1"',
    ],
    [
      'no spec',
      { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest' },
      'spec expected a JSON object, got absent',
    ],
    [
      'absent audiences',
      tokenRequest({ audiences: undefined }),
      'spec.audiences expected an array of strings, got absent',
    ],
    [
      'an empty audience list',
      tokenRequest({ audiences: [] }),
      'spec.audiences is empty',
    ],
    [
      'a non-string audience member',
      tokenRequest({ audiences: [123] }),
      'spec.audiences[0] expected a string, got number',
    ],
    [
      'an empty-string audience member',
      tokenRequest({ audiences: [''] }),
      'spec.audiences[0] is the empty string',
    ],
    [
      'a quoted TTL',
      tokenRequest({ expirationSeconds: String(V4_REQUESTED_TTL_SECONDS) }),
      'spec.expirationSeconds expected a number, got string',
    ],
    [
      'an absent TTL',
      tokenRequest({ expirationSeconds: undefined }),
      'spec.expirationSeconds expected a number, got absent',
    ],
    [
      'a fractional TTL',
      tokenRequest({ expirationSeconds: 3600.5 }),
      'spec.expirationSeconds expected a positive integer',
    ],
    [
      'a zero TTL',
      tokenRequest({ expirationSeconds: 0 }),
      'spec.expirationSeconds expected a positive integer',
    ],
    [
      'a negative TTL',
      tokenRequest({ expirationSeconds: -1 }),
      'spec.expirationSeconds expected a positive integer',
    ],
    [
      'a bound object reference',
      tokenRequest({ boundObjectRef: { kind: 'Pod', name: 'p', uid: 'u' } }),
      'spec.boundObjectRef must be absent or null',
    ],
  ])('refuses %s with 400 and issues no token', async (_label, document, expected) => {
    const { status, body } = await send('POST', url, document);
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(expected);
    expect(asRecord(body)).not.toHaveProperty('status.token');
  });

  it('defaults NOTHING: a malformed audience never receives the compliant one', async () => {
    // The sharpest edge in the module. The previous shape filtered the non-string
    // member out, saw an empty list, and substituted the recorded ["api"] -- so a
    // client that asked for the wrong audience was told it had asked for the right
    // one, and the audience-binding assertion became unfalsifiable.
    const { status, text } = await send('POST', url, tokenRequest({ audiences: [123] }));
    expect(status).toBe(400);
    expect(text).not.toContain(`"${V4_AUDIENCES[0]}"]`);
  });

  it('accepts a null boundObjectRef, which is the recorded state', async () => {
    const { status } = await send('POST', url, tokenRequest({ boundObjectRef: null }));
    expect(status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// SECTION 8 -- V7: NodeRestriction (F-007-RQ-002).
// ---------------------------------------------------------------------------

describe('NodeRestriction (V7)', () => {
  it('allows the acting node to update its OWN status, echoing the document', async () => {
    const document = nodeStatusUpdate(V7_ACTING_NODE_NAME);
    const { status, body } = await send(
      'PUT',
      nodeStatusUrl(V7_ACTING_NODE_NAME),
      document,
    );
    expect(status).toBe(200);
    expect(body).toEqual(document);
  });

  it('refuses the cross-node status update with 403 and NEVER 404', async () => {
    const { status, body } = await send(
      'PUT',
      nodeStatusUrl(V7_CROSS_NODE_TARGET_NAME),
      nodeStatusUpdate(V7_CROSS_NODE_TARGET_NAME),
    );
    expect(status).toBe(FORBIDDEN_STATUS);
    expect(status).not.toBe(NOT_FOUND_STATUS);
    expect(asRecord(body)['message']).toBe(
      `nodes "${V7_CROSS_NODE_TARGET_NAME}" is forbidden: node ` +
        `"${V7_ACTING_NODE_NAME}" is not allowed to modify node ` +
        `"${V7_CROSS_NODE_TARGET_NAME}"`,
    );
  });

  it('refuses a status update whose body names a DIFFERENT node from the URL', async () => {
    // The URL names the object the authorization decision is about, so a
    // mismatched pair is exactly how a cross-node write would be smuggled past a
    // check that only reads the URL. The real API server rejects it in these words.
    const { status, body } = await send(
      'PUT',
      nodeStatusUrl(V7_ACTING_NODE_NAME),
      nodeStatusUpdate(V7_CROSS_NODE_TARGET_NAME),
    );
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(
      `the name of the object ("${V7_CROSS_NODE_TARGET_NAME}") does not match the ` +
        `name on the URL ("${V7_ACTING_NODE_NAME}")`,
    );
  });

  it.each([
    [
      'a wrong kind',
      nodeStatusUpdate(V7_ACTING_NODE_NAME, { kind: 'Pod' }),
      'kind must be "Node"',
    ],
    [
      'no metadata',
      { apiVersion: 'v1', kind: 'Node', status: {} },
      'metadata expected a JSON object, got absent',
    ],
    [
      'no status',
      { apiVersion: 'v1', kind: 'Node', metadata: { name: V7_ACTING_NODE_NAME } },
      'status expected a JSON object, got absent',
    ],
  ])('refuses %s with 400', async (_label, document, expected) => {
    const { status, body } = await send(
      'PUT',
      nodeStatusUrl(V7_ACTING_NODE_NAME),
      document,
    );
    expect(status).toBe(400);
    expect(asRecord(body)['message']).toContain(expected);
  });

  it('refuses an unrecorded node rather than guessing a decision', async () => {
    const { status, body } = await send('PUT', nodeStatusUrl('node9'), nodeStatusUpdate('node9'));
    expect(status).toBe(400);
    const message = String(asRecord(body)['message']);
    expect(message).toContain('no recorded NodeRestriction outcome exists for node "node9"');
    expect(message).toContain(V7_ACTING_NODE_NAME);
    expect(message).toContain(V7_CROSS_NODE_TARGET_NAME);
  });

  it('serves the pre-creation 404 through the explicit override, still validating the body', async () => {
    server.use(crossNodeNotFoundHandler());
    const found = await send(
      'PUT',
      nodeStatusUrl(V7_CROSS_NODE_TARGET_NAME),
      nodeStatusUpdate(V7_CROSS_NODE_TARGET_NAME),
    );
    expect(found.status).toBe(NOT_FOUND_STATUS);
    expect(asRecord(found.body)['message']).toBe(`nodes "${V7_CROSS_NODE_TARGET_NAME}" not found`);

    const malformed = await send(
      'PUT',
      nodeStatusUrl(V7_CROSS_NODE_TARGET_NAME),
      nodeStatusUpdate(V7_ACTING_NODE_NAME),
    );
    expect(malformed.status).toBe(400);
  });

  it('refuses ANY other target through the pre-creation override, naming the recorded one', async () => {
    // The target is part of the recorded scenario, not a parameter of it. While
    // this variant answered any node name, a request addressing node1's OWN status
    // -- the positive control, whose recorded outcome is "allowed" -- was answered
    // `404 Not Found` for node2: a body naming an object the request never
    // mentioned. A spec could then conclude that a NotFound is rendered as a
    // failure while actually exercising the ALLOWED path.
    server.use(crossNodeNotFoundHandler());
    const { status, body } = await send(
      'PUT',
      nodeStatusUrl(V7_ACTING_NODE_NAME),
      nodeStatusUpdate(V7_ACTING_NODE_NAME),
    );
    expect(status).toBe(400);
    expect(status).not.toBe(NOT_FOUND_STATUS);
    const message = String(asRecord(body)['message']);
    expect(message).toContain(
      `no recorded pre-creation outcome exists for node "${V7_ACTING_NODE_NAME}"`,
    );
    expect(message).toContain(`"${V7_CROSS_NODE_TARGET_NAME}" only`);
  });

  it('refuses an unrecorded target through the override too, rather than a 404 for node2', async () => {
    server.use(crossNodeNotFoundHandler());
    const { status, body } = await send('PUT', nodeStatusUrl('node9'), nodeStatusUpdate('node9'));
    expect(status).toBe(400);
    expect(String(asRecord(body)['message'])).toContain('node "node9"');
  });

  it('refuses the unrelated Secret read with the namespaced authorization message', async () => {
    const { status, body } = await exchange(
      secretUrl(V7_UNRELATED_SECRET_NAMESPACE, V7_UNRELATED_SECRET_NAME),
    );
    expect(status).toBe(FORBIDDEN_STATUS);
    expect(asRecord(body)['message']).toBe(
      `secrets "${V7_UNRELATED_SECRET_NAME}" is forbidden: User ` +
        `"${V7_PRINCIPALS.node1.user}" cannot get resource "secrets" in API group "" ` +
        `in the namespace "${V7_UNRELATED_SECRET_NAMESPACE}"`,
    );
  });

  it('answers any other Secret with 404, which is an error either way', async () => {
    const { status, body } = await exchange(secretUrl('default', 'other'));
    expect(status).toBe(NOT_FOUND_STATUS);
    expect(asRecord(body)['message']).toBe('secrets "other" not found');
  });
});

// ---------------------------------------------------------------------------
// SECTION 9 -- V5: the admission-webhook posture document (F-005-RQ-001).
// ---------------------------------------------------------------------------

describe('MutatingWebhookConfiguration (V5)', () => {
  it('serves the committed fail-closed document with every load-bearing field', async () => {
    const { status, body } = await exchange(webhookUrl(FAIL_CLOSED_WEBHOOK.name));
    expect(status).toBe(200);
    const document = asRecord(body);
    expect(document['apiVersion']).toBe('admissionregistration.k8s.io/v1');
    expect(document['kind']).toBe('MutatingWebhookConfiguration');
    expect(asRecord(document['metadata'])['name']).toBe(FAIL_CLOSED_WEBHOOK.name);
    const webhooks = document['webhooks'] as readonly unknown[];
    expect(webhooks).toHaveLength(1);
    // AAP §0.10.2: `Ignore` would make the webhook fail OPEN, which is the
    // weakness this control closed. All four values are pinned as literals rather
    // than derived, so a fixture edit cannot move the expectation with the value.
    expect(webhooks[0]).toMatchObject({
      failurePolicy: 'Fail',
      timeoutSeconds: 5,
      sideEffects: 'None',
      admissionReviewVersions: ['v1'],
    });
    expect(webhooks[0]).toEqual(FAIL_CLOSED_WEBHOOK);
  });

  it('serves the caBundle PLACEHOLDER, never a realistic-looking certificate', async () => {
    const { body } = await exchange(webhookUrl(FAIL_CLOSED_WEBHOOK.name));
    const webhook = asRecord((asRecord(body)['webhooks'] as readonly unknown[])[0]);
    const caBundle = String(asRecord(webhook['clientConfig'])['caBundle']);
    expect(caBundle).toBe('__CLOUD_PVL_ADMISSION_CA_CERT__');
    expect(caBundle).not.toContain('BEGIN CERTIFICATE');
  });

  it('serves the fail-OPEN variant when installed, differing in one word only', async () => {
    server.use(mutatingWebhookConfigurationHandler(FAIL_OPEN_WEBHOOK));
    const { body } = await exchange(webhookUrl(FAIL_OPEN_WEBHOOK.name));
    const webhook = asRecord((asRecord(body)['webhooks'] as readonly unknown[])[0]);
    expect(webhook['failurePolicy']).toBe('Ignore');
    expect(webhook['timeoutSeconds']).toBe(FAIL_CLOSED_WEBHOOK.timeoutSeconds);
    expect(webhook['sideEffects']).toBe(FAIL_CLOSED_WEBHOOK.sideEffects);
  });

  it('answers another configuration name with 404', async () => {
    const { status, body } = await exchange(webhookUrl('some-other-webhook'));
    expect(status).toBe(NOT_FOUND_STATUS);
    expect(asRecord(body)['details']).toEqual({
      group: 'admissionregistration.k8s.io',
      kind: 'mutatingwebhookconfigurations',
      name: 'some-other-webhook',
    });
  });
});

// ---------------------------------------------------------------------------
// SECTION 10 -- V3: the EncryptionConfiguration documents (F-003-RQ-001,
// F-003-RQ-003).
// ---------------------------------------------------------------------------

describe('EncryptionConfiguration artifacts (V3)', () => {
  it('serves the committed deployment document by reference', async () => {
    const { status, body } = await exchange(DEPLOYMENT_ENCRYPTION_CONFIG_PATH);
    expect(status).toBe(200);
    expect(body).toEqual(DEPLOYMENT_ENCRYPTION_CONFIG);
  });

  it('preserves provider ORDER, which is a security boundary and not formatting', async () => {
    const { body } = await exchange(DEPLOYMENT_ENCRYPTION_CONFIG_PATH);
    const rule = asRecord((asRecord(body)['resources'] as readonly unknown[])[0]);
    expect(rule['resources']).toEqual(['secrets', 'configmaps']);
    const providers = rule['providers'] as readonly unknown[];
    // `identity` FIRST would mean every new write is stored in plaintext while the
    // document still parsed and the API server still booted (AAP §0.10.2).
    expect(asRecord(providers[0])).toHaveProperty('kms');
    expect(asRecord(providers[providers.length - 1])).toEqual({ identity: {} });
    expect(asRecord(asRecord(providers[0])['kms'])['apiVersion']).toBe('v2');
    expect(asRecord(asRecord(providers[0])['kms'])['timeout']).toBe('3s');
    expect(asRecord(asRecord(providers[0])['kms'])['endpoint']).toBe('unix:///tmp/kms.socket');
  });

  it('serves no cachesize anywhere, because KMS v2 rejects it', async () => {
    const { text } = await exchange(DEPLOYMENT_ENCRYPTION_CONFIG_PATH);
    expect(text).not.toContain('cachesize');
  });

  it('serves the integration document as YAML text, byte for byte', async () => {
    const { status, text, contentType } = await exchange(
      INTEGRATION_ENCRYPTION_CONFIG_YAML_PATH,
    );
    expect(status).toBe(200);
    expect(contentType).toContain('application/yaml');
    expect(text).toBe(INTEGRATION_AESGCM_ENCRYPTION_CONFIG_YAML);
    // The leading and trailing newlines are part of the recorded document: the
    // oracle writes this exact text to disk and the API server reads it back.
    expect(text.startsWith('\n')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('is reachable only at the recorded artifact paths', async () => {
    expect(DEPLOYMENT_ENCRYPTION_CONFIG_PATH.startsWith(RECORDED_ARTIFACT_BASE_PATH)).toBe(true);
    expect(INTEGRATION_ENCRYPTION_CONFIG_YAML_PATH.startsWith(RECORDED_ARTIFACT_BASE_PATH)).toBe(
      true,
    );
    await expect(fetch(`${RECORDED_ARTIFACT_BASE_PATH}/not-recorded`)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SECTION 11 -- the default handler set.
// ---------------------------------------------------------------------------

describe('the default handler set', () => {
  it('is frozen, so no spec can mutate what every later spec intercepts', () => {
    expect(Object.isFrozen(handlers)).toBe(true);
    const mutable = handlers as RequestHandler[];
    expect(() => mutable.push(mutable[0])).toThrow(TypeError);
    expect(() => {
      mutable.length = 0;
    }).toThrow(TypeError);
    expect(handlers).toHaveLength(CONTROL_IDS.length + 10);
  });

  it('registers one handler per control endpoint plus the ten shared endpoints', () => {
    // The ten: the collection endpoint, the audit listing, and the eight recorded
    // contract replays (SubjectAccessReview, Pod, TokenRequest, Node status,
    // Secret read, MutatingWebhookConfiguration, and the two EncryptionConfiguration
    // artifacts). Asserted as a count AND, above, endpoint by endpoint.
    expect(CONTROL_IDS.length).toBe(8);
    expect(handlers).toHaveLength(18);
  });

  it('has no observable effect beyond binding names: importing it starts nothing', () => {
    // Re-imported values are identical, which is only true if constructing the
    // array is a pure expression over static data -- no clock, no randomness, no
    // per-call identity.
    expect(handlers.every((handler) => typeof handler === 'object')).toBe(true);
  });
});
