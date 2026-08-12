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
 * The single MSW request-interception server this tier's specs share.
 *
 * AAP §0.5.1 (the `web/src/test/msw/server.ts` row: "setupServer with listen /
 * resetHandlers / close lifecycle") / §0.4.4.3 (the mocking policy: declarative HTTP
 * mocking at the React tier only, replaying real API-server wire shapes) / §0.2.2.4 ("a
 * single MSW server instance ... rather than per-test servers") / tech-spec §6.6.
 *
 * ONE INSTANCE, NOT ONE PER TEST. A spec that constructed its own server would either
 * fight this one for the same interception hooks or replace them silently, and a test
 * whose requests are intercepted by a server it did not configure fails in a way that
 * points nowhere. Because Vitest isolates every spec FILE into its own environment (see
 * `isolate: true` in `web/vitest.config.ts`), module scope here is per-file scope, so this
 * single instance is genuinely private to each spec file even though it is written once.
 *
 * THE LIFECYCLE LIVES IN `../../setupTests.ts`, NOT HERE. This module exports the server
 * and nothing else. Registering `beforeAll`/`afterEach`/`afterAll` at import time would
 * make merely importing the server change a spec's behaviour, and would run the hooks
 * twice for any spec that also imported it explicitly.
 *
 * PER-TEST OVERRIDES GO THROUGH `server.use(...)`. That is the supported way to make one
 * test see a 403, a 500 or a malformed body, and `resetHandlers()` in `setupTests.ts`
 * discards it afterwards — so an override cannot leak into the next test and turn a real
 * failure into a pass.
 *
 * @example
 * ```ts
 * import { http, HttpResponse } from 'msw';
 * import { server } from '../test/msw/server';
 *
 * it('reports a refusal rather than an empty page', async () => {
 *   server.use(
 *     http.get('/api/posture/controls', () => HttpResponse.json(forbiddenStatus(...), { status: 403 })),
 *   );
 *   // ... assert the error state, and that "no controls" is NOT rendered.
 * });
 * ```
 */

// AAP §0.5.1 / §0.4.4.3 / §0.2.2.4 / tech-spec §6.6
//
// INVARIANT LOCKED BY THIS FILE: every HTTP request a spec makes is either matched by a
// recorded handler or fails LOUDLY. An unmatched request that merely errored would let a
// component render its error state and satisfy an "it handles failure" assertion for
// entirely the wrong reason.

import { setupServer } from 'msw/node';

import { handlers } from './handlers';

/**
 * The shared server, seeded with the recorded posture handlers.
 *
 * `handlers` is SPREAD rather than passed as an array, for two reasons that both matter.
 * `setupServer` takes handlers variadically, so an array argument would be a type error;
 * and spreading takes a copy, so the server's internal list is its own — `server.use(...)`
 * and `server.resetHandlers()` cannot mutate the exported `handlers` value that the
 * specs and the fixtures also read.
 */
export const server = setupServer(...handlers);

/**
 * Name any request no recorded handler matched, in addition to failing it.
 *
 * The FAILURE comes from `onUnhandledRequest: 'error'`, which `../../setupTests.ts` passes
 * to `server.listen()` — the only place MSW accepts it, since `setupServer` takes handlers
 * and nothing else. This listener is additive: it prints the offending method and URL even
 * when the failure surfaces through a component's own error path rather than through MSW's
 * reporter, which is where an unhandled request is otherwise hardest to recognise.
 */
server.events.on('request:unhandled', ({ request }) => {
  // Surfaced in addition to onUnhandledRequest so the URL appears even when the failure
  // is reported by the component's own error path rather than by MSW.
  // eslint-disable-next-line no-console -- a spec-time diagnostic, never shipped code
  console.error(
    `[msw] no recorded handler matched ${request.method} ${request.url}. ` +
      'Add one to web/src/test/msw/handlers.ts, or override it for this test with ' +
      'server.use(...). A request nobody stubbed makes a component render its error ' +
      'state, which would satisfy an error-handling assertion for the wrong reason.',
  );
});
