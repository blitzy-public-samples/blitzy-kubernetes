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
 * Contract tests for `useControlStatus`: every way a response can be untrustworthy.
 *
 * AAP §0.5.1 (the `web/src/hooks/useControlStatus.test.ts` row) / §0.4.2.4 (the five
 * categories every spec in this tier covers: happy path, edge, error, loading/empty, and
 * interaction) / §0.10.1 (a UI must never render a false PASS) / §0.11.1 ("never weaken a
 * boundary condition") / tech-spec §6.6.3.4.
 *
 * WHAT THIS HOOK IS FOR, AND THEREFORE WHAT ITS SPECS MUST PROVE. It is the only path by
 * which a control verdict reaches the screen, so its failure mode is not "an error is
 * mishandled" but "a posture the server never reported is rendered as fact". Every test
 * below is an instance of that one risk:
 *
 * 1. FAIL CLOSED ON A MALFORMED PAYLOAD. A response this client cannot fully read is
 *    refused, never partially rendered. The three parsers used to DEGRADE instead —
 *    filtering an invalid array member out, skipping a malformed finding, emptying an
 *    unreadable list — and each degradation converts "I could not read this" into
 *    "there was nothing to report", which is the single most dangerous transformation a
 *    security UI can perform.
 * 2. A REFUSAL IS NOT AN EMPTY RESULT. `fetch` does not reject on 4xx or 5xx, so a 403
 *    must reach `status: 'error'` and never `isEmpty: true`.
 * 3. A DUPLICATE IS A CONTRADICTION. Two entries for one control are refused rather than
 *    resolved by list order.
 * 4. AN ABORT IS NOT A FAILURE. Unmounting or refreshing must not paint an error.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { V4_OBSERVATIONS } from '../domain/observationIds';
import { server } from '../test/msw/server';
import {
  CONTROL_STATUS_BASE_PATH,
  controlStatusPath,
  isControlId,
  selectControlStatus,
  useControlStatus,
} from './useControlStatus';
import type { ControlId, ControlStatus, UseControlStatusResult } from './useControlStatus';

/** One well-formed control entry, with `overrides` applied on top. */
function entry(controlId: ControlId, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controlId,
    verdict: 'pass',
    summary: `${controlId} is in the required posture.`,
    findings: [],
    warnings: [],
    ...overrides,
  };
}

/** Replaces the collection handler with one returning `body` at `status`. */
function respondWith(body: unknown, status = 200): void {
  server.use(
    http.get(CONTROL_STATUS_BASE_PATH, () =>
      status === 204
        ? new HttpResponse(null, { status })
        : HttpResponse.json(body as never, { status }),
    ),
  );
}

/** Replaces the collection handler with one returning raw, possibly invalid, text. */
function respondWithText(text: string, status = 200): void {
  server.use(
    http.get(CONTROL_STATUS_BASE_PATH, () =>
      new HttpResponse(text, { status, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

/** Renders the hook and waits until it leaves `loading`. */
async function settled(controlId?: ControlId): Promise<UseControlStatusResult> {
  const { result } = renderHook(() => useControlStatus(controlId));
  await waitFor(() => {
    expect(result.current.status).not.toBe('loading');
  });
  return result.current;
}

/** Asserts a payload error and returns its message, so a test can name what it refused. */
async function refusedMessage(): Promise<string> {
  const settledResult = await settled();
  expect(settledResult.status).toBe('error');
  if (settledResult.status !== 'error') {
    throw new Error('unreachable: status was asserted to be error');
  }
  expect(settledResult.error.kind).toBe('payload');
  return settledResult.error.message;
}

beforeEach(() => {
  // Every test states its own response, so none inherits the recorded default handler's
  // body by accident. A spec whose outcome depends on a fixture it never mentions is a
  // spec that breaks when an unrelated fixture is edited.
  respondWith([entry('V1'), entry('V2')]);
});

describe('the three accepted envelope shapes', () => {
  it('reads a bare list of controls', async () => {
    respondWith([entry('V1'), entry('V3')]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.controls.map((control) => control.controlId)).toEqual(['V1', 'V3']);
    expect(result.isEmpty).toBe(false);
  });

  it('reads a Kubernetes-style list under `items`', async () => {
    respondWith({ kind: 'List', apiVersion: 'v1', items: [entry('V4')] });

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.controls.map((control) => control.controlId)).toEqual(['V4']);
  });

  it('reads a single control object, which is what the per-control endpoint returns', async () => {
    server.use(
      http.get(controlStatusPath('V6'), () => HttpResponse.json(entry('V6') as never)),
    );

    const result = await settled('V6');

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(selectControlStatus(result.controls, 'V6')?.verdict).toBe('pass');
  });

  it('refuses an `items` member that is not a list, rather than reading the body as one control', async () => {
    // A contract mismatch, not an alternative spelling: a body that declares `items` and
    // does not carry a list is malformed, and reinterpreting it as a single control would
    // invent an entry the server never sent.
    respondWith({ items: { controlId: 'V1' } });

    expect(await refusedMessage()).toMatch(/neither a control-status object/i);
  });

  it.each([
    ['a bare string', '"not a payload"'],
    ['a number', '42'],
    ['a boolean', 'true'],
    ['null', 'null'],
  ])('refuses %s as a body', async (_name, text) => {
    respondWithText(text);

    expect(await refusedMessage()).toMatch(/neither a control-status object/i);
  });
});

describe('the empty and no-content states', () => {
  it('reports an empty list as the explicit empty state, not as a failure', async () => {
    respondWith([]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.controls).toEqual([]);
    expect(result.isEmpty).toBe(true);
  });

  it('treats 204 No Content as the empty state', async () => {
    respondWith(null, 204);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.isEmpty).toBe(true);
  });

  it('treats an empty body under 200 as a payload error, not as no controls', async () => {
    // The asymmetry with 204 is deliberate and load-bearing: 204 is the contract for
    // "nothing to report", while an empty body under 200 is a server that answered with
    // nothing. Rendering "no controls" for the second would assert a clean bill of health
    // on no evidence at all.
    respondWithText('');

    expect(await refusedMessage()).toMatch(/not valid JSON/i);
  });

  it('starts in the loading state before any response arrives', () => {
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        return HttpResponse.json([entry('V1')] as never);
      }),
    );

    const { result } = renderHook(() => useControlStatus());

    expect(result.current.status).toBe('loading');
    // The refresh handle exists in every arm, including this one, so a loading UI can
    // offer a retry without narrowing first.
    expect(typeof result.current.refresh).toBe('function');
  });
});

describe('malformed members are refused, never skipped', () => {
  it('refuses an unknown control identifier rather than dropping the entry', async () => {
    // A dropped entry is invisible once rendered: a dashboard showing seven controls looks
    // exactly like one showing all eight when the eighth is the one that was dropped.
    respondWith([entry('V1'), { ...entry('V2'), controlId: 'V9' }]);

    expect(await refusedMessage()).toMatch(/does not identify one of the 8 known controls/i);
  });

  it.each([
    ['a non-string member', { audiences: ['api', 42] }],
    ['a null member', { audiences: ['api', null] }],
    ['an object member', { audiences: [{ name: 'api' }] }],
    ['a scalar instead of a list', { audiences: 'api' }],
  ])('refuses `audiences` carrying %s', async (_name, evidence) => {
    // THE MOTIVATING DEFECT. Filtering produced `['api']`, which SATISFIES the V4
    // assertion that the audience is exactly `['api']` — so a token bound to two
    // audiences, one unreadable, was reported as correctly single-audience.
    respondWith([entry('V4', { evidence })]);

    const message = await refusedMessage();
    expect(message).toMatch(/audiences/);
    expect(message).toMatch(/rejected rather than the member being dropped|list of strings/i);
  });

  it('keeps a well-formed audience list verbatim, including order and duplicates', async () => {
    respondWith([entry('V4', { evidence: { audiences: ['api', 'api', 'other'] } })]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(selectControlStatus(result.controls, 'V4')?.evidence?.audiences).toEqual([
      'api',
      'api',
      'other',
    ]);
  });

  it('distinguishes an EMPTY audience list from an unreadable one', async () => {
    // `audiences: []` is a token bound to no audience — a reportable finding the server
    // genuinely described. It must not be conflated with `audiences: [42]`, which is a
    // payload this client cannot interpret.
    respondWith([entry('V4', { evidence: { audiences: [] } })]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(selectControlStatus(result.controls, 'V4')?.evidence?.audiences).toEqual([]);
  });

  it.each([
    ['a number', 7],
    ['null', null],
    ['a boolean', false],
    ['a list', ['nested']],
  ])('refuses a finding that is %s', async (_name, finding) => {
    // A finding is a reported DEFECT — the evidence that stops a control rendering as a
    // pass. A control whose only finding was unreadable used to render as clean.
    respondWith([entry('V1', { verdict: 'fail', findings: [finding] })]);

    expect(await refusedMessage()).toMatch(/findings\[0\]/);
  });

  it('accepts findings as bare strings and as objects, in one list', async () => {
    respondWith([
      entry('V1', {
        verdict: 'fail',
        findings: ['bare message', { message: 'structured', requirementId: 'F-001-RQ-001' }],
      }),
    ]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const control = selectControlStatus(result.controls, 'V1');
    expect(control?.findings.map((finding) => finding.message)).toEqual([
      'bare message',
      'structured',
    ]);
    expect(control?.findings[1]?.requirementId).toBe('F-001-RQ-001');
  });

  it('refuses a warning object with no readable message', async () => {
    // The V2 control turns on a warning being PRESENT: under warn=restricted the pod IS
    // admitted, and only the warning distinguishes a working Pod Security plugin from an
    // absent one. Dropping it inverts that verdict.
    respondWith([entry('V2', { warnings: [{ code: 299 }] })]);

    expect(await refusedMessage()).toMatch(/warnings\[0\]/);
  });

  it('refuses a warning that is neither a string nor an object', async () => {
    respondWith([entry('V2', { warnings: ['fine', 42] })]);

    expect(await refusedMessage()).toMatch(/warnings\[1\]/);
  });

  it.each([
    ['no label', { value: 1 }],
    ['a non-string label', { label: 7, value: 1 }],
    ['no value member at all', { label: 'measured' }],
    ['an object value', { label: 'measured', value: { nested: true } }],
    ['a list value', { label: 'measured', value: [1] }],
  ])('refuses an observation with %s', async (_name, observation) => {
    respondWith([entry('V3', { evidence: { observations: [observation] } })]);

    expect(await refusedMessage()).toMatch(/observations\[0\]/);
  });

  it('preserves an observation reported as exactly null', async () => {
    // "Reported as null" and "not reported" are different claims, and the V4 control
    // turns on the difference: a `pod` sub-claim reported null is PROOF of an unbound
    // token, while an absent one proves nothing.
    respondWith([
      entry('V4', {
        evidence: {
          observations: [{ label: V4_OBSERVATIONS.kubernetesIoPod, value: null }],
        },
      }),
    ]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const observations = selectControlStatus(result.controls, 'V4')?.evidence?.observations;
    expect(observations).toEqual([{ label: V4_OBSERVATIONS.kubernetesIoPod, value: null }]);
  });

  it('refuses a non-finite numeric observation', async () => {
    // JSON cannot carry NaN, so this arrives as a string the parser must not coerce, or —
    // through a hand-built body — as a number the parser must reject. Either way it
    // compares absurdly against every bound the panels assert.
    respondWithText(
      JSON.stringify([entry('V4')]).replace(
        '"findings":[]',
        '"findings":[],"evidence":{"observations":[{"label":"ttl","value":1e999}]}',
      ),
    );

    expect(await refusedMessage()).toMatch(/observations\[0\]|non-finite/i);
  });
});

describe('duplicate control identifiers are a contradiction', () => {
  it('refuses a payload reporting one control twice, naming both positions', async () => {
    // Which entry is believed used to depend on the order the server serialised them in:
    // `selectControlStatus` takes the first. A payload reporting V3 as `fail` and then as
    // `pass` rendered PASS.
    respondWith([entry('V3', { verdict: 'fail' }), entry('V1'), entry('V3', { verdict: 'pass' })]);

    const message = await refusedMessage();
    expect(message).toMatch(/reports control V3 more than once/i);
    expect(message).toMatch(/entries 0 and 2/);
  });

  it('refuses even when the duplicates agree', async () => {
    // Agreement is not the property that matters. A payload that repeats itself is
    // malformed, and accepting the agreeing case would mean the check only fires when a
    // reader could already see the problem.
    respondWith([entry('V5'), entry('V5')]);

    expect(await refusedMessage()).toMatch(/more than once/i);
  });

  it('accepts all eight distinct controls', async () => {
    const all: ControlId[] = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];
    respondWith(all.map((controlId) => entry(controlId)));

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.controls).toHaveLength(8);
    for (const controlId of all) {
      expect(selectControlStatus(result.controls, controlId)).toBeDefined();
    }
  });
});

describe('verdict reading degrades in the safe direction', () => {
  it.each([
    ['absent', undefined],
    ['misspelled', 'passed'],
    ['differently cased', 'PASS'],
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
  ])('reads an %s verdict as unknown, never as pass', async (_name, verdict) => {
    // Unlike an unrecognised control ID, an unrecognised VERDICT still identifies the
    // control, so `unknown` is a truthful rendering of it. The asymmetry is deliberate:
    // one is "I cannot say what this is about", the other is "I cannot say what it says".
    respondWith([verdict === undefined ? entry('V1', {}) : entry('V1', { verdict })]);
    if (verdict === undefined) {
      respondWithText(JSON.stringify([{ controlId: 'V1', summary: 'no verdict member' }]));
    }

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(selectControlStatus(result.controls, 'V1')?.verdict).toBe('unknown');
  });

  it('substitutes an explicit sentence when the summary is absent', async () => {
    respondWithText(JSON.stringify([{ controlId: 'V1', verdict: 'pass' }]));

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(selectControlStatus(result.controls, 'V1')?.summary).toMatch(/reported no summary/i);
  });
});

describe('an HTTP refusal is never an empty result', () => {
  it.each([403, 401, 404, 500, 502, 503])(
    'reports HTTP %i as an error carrying the status',
    async (status) => {
      respondWith(
        { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: status, reason: 'Forbidden' },
        status,
      );

      const result = await settled();

      expect(result.status).toBe('error');
      if (result.status !== 'error') return;
      expect(result.error.kind).toBe('http');
      expect(result.error.httpStatus).toBe(status);
      // The property that matters most: no arm of the union offers `controls` or
      // `isEmpty` here, so a panel cannot reach a verdict from a refusal even by accident.
      expect('controls' in result).toBe(false);
      expect('isEmpty' in result).toBe(false);
    },
  );

  it('surfaces the Kubernetes Status reason so a panel can explain the refusal', async () => {
    respondWith(
      {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        code: 403,
        reason: 'Forbidden',
        message: 'controls is forbidden: User "probe" cannot list resource "controls"',
      },
      403,
    );

    const result = await settled();

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.message).toMatch(/forbidden/i);
  });

  it('reports invalid JSON as a payload error rather than a transport error', async () => {
    // The distinction is what tells a reader whether to look at the network or at the
    // server's serialiser.
    respondWithText('{"controlId": "V1"');

    const settledResult = await settled();

    expect(settledResult.status).toBe('error');
    if (settledResult.status !== 'error') return;
    expect(settledResult.error.kind).toBe('payload');
  });

  it('reports a transport failure as a network error', async () => {
    server.use(http.get(CONTROL_STATUS_BASE_PATH, () => HttpResponse.error()));

    const result = await settled();

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.kind).toBe('network');
  });
});

describe('refresh and abort', () => {
  it('re-issues the request and returns to loading while it runs', async () => {
    let calls = 0;
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, () => {
        calls += 1;
        return HttpResponse.json([entry('V1', { summary: `call ${String(calls)}` })] as never);
      }),
    );

    const { result } = renderHook(() => useControlStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(calls).toBe(1);

    // Inside `act` because refresh sets state, and awaiting the CALL COUNT rather than the
    // status: the hook is already `success` from the first request, so waiting on the
    // status alone is satisfied immediately by the previous result and proves nothing about
    // the refresh. Waiting for the second request to have been issued, and only then for
    // the new body to have landed, is what actually observes the round trip.
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
      if (result.current.status !== 'success') return;
      expect(selectControlStatus(result.current.controls, 'V1')?.summary).toBe('call 2');
    });
  });

  it('recovers from an error when a refresh succeeds', async () => {
    let attempt = 0;
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json({ kind: 'Status', code: 503 } as never, { status: 503 })
          : HttpResponse.json([entry('V1')] as never);
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
    expect(attempt).toBe(2);
  });

  it('does not paint an error when the request is aborted by unmounting', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    server.use(
      http.get(CONTROL_STATUS_BASE_PATH, async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        return HttpResponse.json([entry('V1')] as never);
      }),
    );

    const { result, unmount } = renderHook(() => useControlStatus());
    expect(result.current.status).toBe('loading');
    unmount();

    // An abort is not a failure. If it were reported as one, a panel that unmounts during
    // navigation would flash an error the user cannot act on — and, worse, a spec asserting
    // "shows an error on failure" would pass for that reason.
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(errors.filter((entryArgs) => String(entryArgs).includes('not wrapped in act'))).toEqual(
      [],
    );
    spy.mockRestore();
  });

  it('keeps `refresh` stable across renders so it is safe as an effect dependency', async () => {
    const { result, rerender } = renderHook(() => useControlStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const first = result.current.refresh;

    rerender();

    expect(result.current.refresh).toBe(first);
  });
});

describe('the exported helpers', () => {
  it('builds the collection path and the per-control path', () => {
    expect(controlStatusPath()).toBe(CONTROL_STATUS_BASE_PATH);
    expect(controlStatusPath('V7')).toBe(`${CONTROL_STATUS_BASE_PATH}/V7`);
  });

  it.each([
    ['V1', true],
    ['V8', true],
    ['V9', false],
    ['v1', false],
    ['', false],
    ['V10', false],
  ])('isControlId(%s) is %s', (candidate, expected) => {
    expect(isControlId(candidate)).toBe(expected);
  });

  it('returns undefined for a control the payload does not mention', async () => {
    respondWith([entry('V1')]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    // A panel must render this as empty or unknown — never as a pass. The hook's job is
    // only to be unambiguous about it.
    expect(selectControlStatus(result.controls, 'V8')).toBeUndefined();
  });

  it('finds a control regardless of its position', async () => {
    respondWith([entry('V2'), entry('V5'), entry('V8')]);

    const result = await settled();

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const found: ControlStatus | undefined = selectControlStatus(result.controls, 'V8');
    expect(found?.controlId).toBe('V8');
  });
});
