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
 * Contract tests for `useAuditEvents`: validation without filtering, and pagination.
 *
 * AAP §0.5.1 (the `web/src/hooks/useAuditEvents.test.ts` row) / §0.4.2.2 (the V6
 * blueprint, whose CONFIDENTIALITY GUARD this hook must keep assertable) / §0.10.2 (the
 * confidentiality boundary condition: no `secrets` event may carry a `responseObject`) /
 * §0.4.2.4 / tech-spec §6.6.3.4.
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
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIT_EVENTS_DEFAULT_PAGE_SIZE,
  AUDIT_EVENTS_ENDPOINT,
  AUDIT_EVENTS_QUERY_PARAMS,
  AUDIT_LEVEL_ORDER,
  AUDIT_STAGES,
  isConfidentialAuditIdentity,
  resolveAuditResourceIdentity,
  useAuditEvents,
} from './useAuditEvents';
import type { AuditEvent } from './useAuditEvents';
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

/** The captured query strings of every request the hook issued, newest last. */
let requestedQueries: string[] = [];

/** Serves `body` at `status`, recording each request's query string. */
function respondWith(body: unknown, status = 200): void {
  server.use(
    http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
      requestedQueries.push(new URL(request.url).search.replace(/^\?/, ''));
      return HttpResponse.json(body as never, { status });
    }),
  );
}

/** Serves raw text, so an invalid-JSON body can be expressed. */
function respondWithText(text: string, status = 200): void {
  server.use(
    http.get(AUDIT_EVENTS_ENDPOINT, ({ request }) => {
      requestedQueries.push(new URL(request.url).search.replace(/^\?/, ''));
      return new HttpResponse(text, {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
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

beforeEach(() => {
  requestedQueries = [];
  respondWith({ items: [auditEvent()] });
});

describe('the accepted envelope shapes', () => {
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
    const { result } = await settled({ enabled: false });

    expect(result.current.status).toBe('idle');
    // Idle is distinct from an empty success, and the distinction is what stops a
    // collapsed panel from claiming there were no audit events to report.
    expect(result.current.isEmpty).toBe(false);
    expect(requestedQueries).toEqual([]);
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
  it.each([403, 401, 500, 503])('reports HTTP %i as an error carrying the status', async (status) => {
    respondWith(
      { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: status, reason: 'Forbidden' },
      status,
    );

    const { result } = await settled();

    expect(result.current.status).toBe('error');
    expect(result.current.error?.httpStatus).toBe(status);
    expect(result.current.events).toEqual([]);
    // A UI showing "no audit events" after a refusal would assert a clean bill of health it
    // has no evidence for.
    expect(result.current.isEmpty).toBe(false);
  });

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

  it('reports a transport failure with httpStatus 0', async () => {
    server.use(http.get(AUDIT_EVENTS_ENDPOINT, () => HttpResponse.error()));

    const { result } = await settled();

    expect(result.current.status).toBe('error');
    expect(result.current.error?.httpStatus).toBe(0);
  });
});

describe('pagination', () => {
  it('sends page and pageSize, with the documented parameter names and order', async () => {
    await settled({ page: 3, pageSize: 20 });

    expect(requestedQueries).toHaveLength(1);
    expect(requestedQueries[0]).toBe(
      `${AUDIT_EVENTS_QUERY_PARAMS.page}=3&${AUDIT_EVENTS_QUERY_PARAMS.pageSize}=20`,
    );
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
    respondWith({ items: [auditEvent(), auditEvent()], total: 2 });

    const { result } = await settled({ pageSize: 2 });

    expect(result.current.hasNextPage).toBe(false);
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
  it('encodes every filter field, alphabetically after the pagination pair', async () => {
    await settled({
      pageSize: 10,
      filter: { level: 'Request', namespace: 'secret-audit-request', resource: 'secrets', verb: 'create' },
    });

    expect(requestedQueries[0]).toBe(
      'page=1&pageSize=10&level=Request&namespace=secret-audit-request&resource=secrets&verb=create',
    );
  });

  it('omits an empty filter field rather than sending a blank value', async () => {
    await settled({ filter: { resource: '', verb: 'create' } });

    expect(requestedQueries[0]).not.toContain('resource=');
    expect(requestedQueries[0]).toContain('verb=create');
  });

  it('percent-encodes a value that needs it', async () => {
    await settled({ filter: { resource: 'serviceaccounts/token' } });

    expect(requestedQueries[0]).toContain('resource=serviceaccounts%2Ftoken');
  });

  it('resets to page 1 when the filter changes', async () => {
    respondWith({ items: [auditEvent()], hasMore: true });

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
    expect(requestedQueries.at(-1)).toContain('page=1');
    expect(requestedQueries.at(-1)).toContain('resource=configmaps');
  });

  it('clones the caller\'s filter, so mutating it afterwards cannot change the query', async () => {
    // Storing the caller's object by reference made the hook's state reachable from
    // outside it: a later `filter.resource = ...` changed state with no re-render, so the
    // issued request and the returned `filter` disagreed silently.
    const mutable = { resource: 'secrets' };

    const { result } = await settled({ filter: mutable });
    const issued = requestedQueries[0];

    mutable.resource = 'configmaps';

    expect(result.current.filter.resource).toBe('secrets');
    expect(issued).toContain('resource=secrets');
    expect(requestedQueries).toHaveLength(1);
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
    const { result, rerender } = renderHook(
      ({ resource }: { resource: string }) => useAuditEvents({ filter: { resource } }),
      { initialProps: { resource: 'secrets' } },
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    const afterFirst = requestedQueries.length;

    rerender({ resource: 'secrets' });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(requestedQueries).toHaveLength(afterFirst);
  });
});

describe('immutability of the returned data', () => {
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
  it('re-issues the same query', async () => {
    const { result } = await settled({ filter: { resource: 'secrets' } });
    expect(requestedQueries).toHaveLength(1);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(requestedQueries).toHaveLength(2);
    });

    expect(requestedQueries[1]).toBe(requestedQueries[0]);
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

  it('does not report an error when a slow request is aborted by unmounting', async () => {
    server.use(
      http.get(AUDIT_EVENTS_ENDPOINT, async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        return HttpResponse.json({ items: [auditEvent()] } as never);
      }),
    );

    const { result, unmount } = renderHook(() => useAuditEvents());
    expect(result.current.status).toBe('loading');

    unmount();
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    // Nothing to assert on the unmounted hook itself; the property under test is that no
    // unhandled rejection or state-update-after-unmount warning escaped, which the
    // setup file's console handling and Vitest's unhandled-error tracking would surface.
    expect(true).toBe(true);
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
