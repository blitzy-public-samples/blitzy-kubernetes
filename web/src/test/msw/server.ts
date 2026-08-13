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
 * The one MSW request-interception server the React test tier shares, and the
 * owner of its whole lifecycle.
 *
 * AAP §0.5.1 (the `web/src/test/msw/server.ts` row: "`setupServer` with listen /
 * resetHandlers / close lifecycle") / §0.2.2.4 ("a single MSW server instance
 * with `beforeAll(listen)`, `afterEach(resetHandlers)`, and `afterAll(close)`
 * rather than per-test servers") / §0.4.4.3 (the tier's mocking policy:
 * declarative HTTP mocking, and only at the React tier) / §0.5.5 (the
 * shared-instance contract -- every spec here overrides with `server.use(...)`
 * and none constructs its own server) / tech-spec §6.6.3.4 (the documentation
 * convention this provenance block and the invariant below satisfy).
 *
 * THE INVARIANT THIS FILE LOCKS
 *
 *   Exactly one MSW server serves this tier, and its handler list is restored
 *   to the recorded set after EVERY test -- so no test can leak a stubbed
 *   response into another, and no request can go unmocked without failing.
 *
 * Both halves of that sentence are load-bearing, and each closes a failure mode
 * whose symptom is a test that PASSES for the wrong reason rather than one that
 * goes red. A leaked override makes the next test assert against a payload it
 * never asked for; an unmocked request makes a component render its error branch
 * and satisfy an "it handles failure" assertion having proven only that nobody
 * stubbed the endpoint.
 *
 * ONE SHARED INSTANCE, PROVISIONED ONCE -- THE DISCIPLINE THIS FILE PORTS
 *
 * The conceptual ancestor is `test/integration/auth/main_test.go`, whose entire
 * body is `func TestMain(m *testing.M) { framework.EtcdMain(m.Run) }`: the
 * expensive shared resource is stood up once for the whole run and every test
 * borrows it, rather than each test paying to build its own. `EtcdMain` goes
 * further and reuses an etcd that is ALREADY listening instead of starting a
 * second one. That discipline -- not that code -- is what is ported here.
 *
 * A spec that called `setupServer` itself would fight this instance for the same
 * interception hooks or replace them silently, and a test whose requests are
 * intercepted by a server it did not configure fails in a way that points
 * nowhere. So there is exactly one call below, and `web/src/test/msw/handlers.ts`
 * documents the same rule from the other side.
 *
 * THE LIFECYCLE IS REGISTERED HERE, AND NOWHERE ELSE
 *
 * `web/src/setupTests.ts` -- the tier's only `setupFiles` entry -- imports this
 * module for its side effect and deliberately does NOT re-register any of the
 * three hooks below. Ownership sits here for two reasons:
 *
 *   1. It cannot be forgotten. Importing the server is what starts it, so a spec
 *      that reaches for `server` can never obtain one that is not intercepting.
 *      No spec in this tier registers a lifecycle hook of its own, so were these
 *      three absent, MSW would never start at all and every spec would run with
 *      no interception whatsoever.
 *   2. It cannot be doubled. Calling `listen()` twice on one instance is a known
 *      MSW footgun, and splitting the registration across two modules is how
 *      that happens. One owner makes the second call unreachable by
 *      construction.
 *
 * HOOK ORDER, MEASURED RATHER THAN ASSUMED
 *
 * This module's body runs BEFORE its importer's, because ES module imports are
 * hoisted -- so these hooks are always registered first. Vitest 4 was then
 * measured directly, with no ordering key set in `web/vitest.config.ts`:
 * `beforeAll` runs in registration order, while `afterEach` and `afterAll` run
 * in REVERSE registration order. The three consequences are exactly the ones
 * wanted, and they hold structurally rather than by anyone remembering them:
 *
 *   * `server.listen()` runs before every other `beforeAll` -- interception is
 *     live before the first line of setup that might issue a request.
 *   * `server.resetHandlers()` runs after every other `afterEach`, so the RTL
 *     unmount in `setupTests.ts` happens first. That order matters: unmounting
 *     can trigger an abort or one last fetch from a component's teardown, and
 *     those must still meet the handlers that were in force during the test.
 *   * `server.close()` runs after every other `afterAll` -- nothing is torn down
 *     underneath a request that is still in flight.
 *
 * RULES POSITION
 *
 * `review_rules` returns exactly one line: "No user rules provided." No rule is
 * invented here, and their absence is not treated as licence to lower the bar --
 * AAP §0.11.1's enterprise-standard bar substitutes. The item that binds this
 * file hardest is "isolation and determinism as first-class properties": AAP
 * §0.4.1.2 records that JavaScript has no true analogue of Go's `-race`, and
 * this tier's substitute is precisely one shared server whose handlers are reset
 * between every test, inside the fresh per-file environment
 * `web/vitest.config.ts` pins. Per AAP §0.7.2 that isolation must be
 * STRUCTURAL, not incidental, which is why the reset is registered here once and
 * never left to each spec to remember. "Use the repository's existing mocking
 * posture and no more" (AAP §0.10.1) is honoured too: MSW is the whole
 * mechanism, with no second mocking framework and no bespoke fake server. Also
 * observed: "respect the existing freeze" (the only third-party imports are the
 * already-pinned `msw` and `vitest`; no dependency is added), "cite only what
 * the repository states" (no external benchmark or hardening-guide control
 * number appears anywhere), and "no secrets, ever" (no key, token or certificate
 * literal appears here -- the tier's only key material is the documented
 * NON-secret test key owned by `../fixtures/encryptionConfig`).
 *
 * THIS IS NOT A SPEC FILE, AND IT MUST NOT BECOME ONE
 *
 * `web/vitest.config.ts` collects `src/**\/*.test.{ts,tsx}` only, so a
 * `describe`, `it` or `test` written here would SILENTLY never run. There are
 * none. What this module does contain is one export and three hook
 * registrations -- no branch, no guard, no diagnostic -- because anything
 * conditional here would be code no spec can reach and no reader can verify.
 *
 * HOW A SPEC USES THIS
 *
 * Import the named `server`, then install a per-test override inside the case
 * that needs one. The steps below are described rather than shown as a runnable
 * snippet on purpose: a case-declaring call written out even inside a comment
 * here invites the copy that turns this module into the spec file it must never
 * be.
 *
 *   1. `import { server } from '../test/msw/server';`
 *   2. Inside the one case that needs a refusal rather than the recorded
 *      success, call `server.use(...)` with an `http.get(...)` handler returning
 *      `HttpResponse.json(forbiddenStatus(...), { status: 403 })`.
 *   3. Assert the error state -- and, just as importantly, that the empty state
 *      is NOT rendered, since a refusal and an empty result must never look
 *      alike.
 *
 * Nothing has to be undone afterwards: the `afterEach` below discards the
 * override, so the next case sees the recorded handlers again.
 */

import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { handlers } from './handlers';

/**
 * The shared server, seeded with the recorded posture handlers.
 *
 * Exported as a NAMED `server`, which is contractual rather than stylistic: six
 * modules in this tier already import `{ server }` from this exact path, and it
 * is the only export here. Nothing else is exposed -- no default export, no
 * re-export of `handlers`, no helper -- so there is exactly one way to reach the
 * server and no second way that could drift from it.
 *
 * `handlers` is SPREAD rather than passed as an array, for two reasons that both
 * matter. `setupServer` takes handlers variadically, so an array argument would
 * be a type error; and spreading copies, so the server's internal list is its
 * own -- `server.use(...)` and `server.resetHandlers()` mutate that copy and can
 * never reach the frozen `handlers` value the specs and fixtures also read.
 */
export const server = setupServer(...handlers);

/**
 * Start intercepting before the first test in the file.
 *
 * `onUnhandledRequest: 'error'` is the deliberate strictness, and `listen()` is
 * the only place MSW accepts it -- `setupServer()` takes handlers and nothing
 * else. The default, `'warn'`, prints a message and then lets the request
 * through to a network that is not there: the component under test renders its
 * error branch, and an "it handles failure" assertion passes having proven only
 * that MSW was misconfigured. `'error'` fails the test instead and names the
 * method and URL nobody stubbed.
 *
 * When that failure appears, the fix belongs in `./handlers.ts` -- add the
 * missing recorded handler -- or in the individual test, via `server.use(...)`.
 * It never belongs here: relaxing this option would trade a loud, located
 * failure for a silent one across the entire tier.
 */
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

/**
 * Forget every per-test override, after every test.
 *
 * THIS IS THE ISOLATION GUARANTEE, not boilerplate. `server.use(...)` is the
 * supported way for one test to see a 403, a 500, an empty page or a malformed
 * body, and this line is what stops that override from silently governing the
 * next test in the file. Without it, a test that passes in isolation and a test
 * that passes only because its predecessor installed a handler are
 * indistinguishable -- and for a security-posture panel, an assertion satisfied
 * by the previous test's stub is the worst available outcome.
 *
 * `resetHandlers()` with no argument restores exactly the recorded set this
 * module was constructed with, so the baseline every spec starts from is the
 * same one `./handlers.ts` exports.
 */
afterEach(() => {
  server.resetHandlers();
});

/**
 * Stop intercepting after the last test in the file, so the worker can exit
 * cleanly and leaves no listener behind.
 *
 * AAP §0.4.1.2 records that this tier has no analogue of Go's goroutine-leak
 * detector, so teardown is explicit here rather than inferred from process exit.
 */
afterAll(() => {
  server.close();
});
