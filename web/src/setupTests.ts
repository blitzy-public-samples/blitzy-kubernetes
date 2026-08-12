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
 * The one setup file every Vitest spec in this tier runs before its first test.
 *
 * AAP §0.5.1 (the `web/src/setupTests.ts` row: "jest-dom import, afterEach(cleanup),
 * jsdom stubs for IntersectionObserver, matchMedia, scrollTo") / §0.4.4.3 (the mocking
 * policy: MSW at the React tier only) / §0.2.2.3 (the jsdom pitfalls this file
 * pre-empts, each measured rather than assumed) / tech-spec §6.6.3.4.
 *
 * Referenced by `web/vitest.config.ts` as `setupFiles: ['./src/setupTests.ts']`, so it
 * runs once per spec FILE — Vitest isolates each file into its own environment, which is
 * what makes the MSW server below safe to own at module scope.
 *
 * FOUR RESPONSIBILITIES, and deliberately no more. This file must not contain fixtures,
 * helpers or assertions: anything a spec could import explicitly belongs somewhere a
 * reader can follow from the spec, not in an implicit preamble.
 *
 * 1. THE jest-dom MATCHERS. `toBeInTheDocument`, `toHaveAccessibleName` and the rest are
 *    registered by importing the package for its side effect. `@testing-library/jest-dom`
 *    also appears in `web/tsconfig.json`'s `types` allow-list; without that entry the
 *    matchers exist at runtime but fail typecheck, which is the confusing half of the
 *    failure because the tests pass while the gate does not.
 * 2. RTL CLEANUP AFTER EVERY TEST. Vitest's `globals: true` means RTL's auto-cleanup is
 *    active in principle, but it is registered explicitly here so the behaviour does not
 *    depend on a configuration flag that a future edit could flip. Without cleanup,
 *    rendered nodes accumulate in one jsdom document and `getByRole` starts finding the
 *    PREVIOUS test's element — a false pass that survives even after the component under
 *    test is broken, which for a security-posture badge is the worst possible failure.
 * 3. MSW LIFECYCLE. `listen` before the file's first test, `resetHandlers` after each
 *    test, `close` after the last. The reset is what stops a `server.use(...)` override
 *    in one test from silently governing the next.
 * 4. THE THREE BROWSER GLOBALS jsdom DOES NOT IMPLEMENT. Each is stubbed rather than
 *    polyfilled: the specs assert on rendered output and interaction, never on scroll
 *    position or viewport intersection, so a stub that records calls is enough and a
 *    real implementation would add behaviour nothing asserts.
 *
 * `onUnhandledRequest: 'error'` is the deliberate strictness. A spec that renders a
 * component which fetches an endpoint nobody stubbed would otherwise see an opaque
 * network failure and render its error state — passing an "it handles errors" assertion
 * for entirely the wrong reason. Failing loudly names the URL instead.
 */

// AAP §0.5.1 / §0.2.2.3 / tech-spec §6.6.3.4
//
// INVARIANT LOCKED BY THIS FILE: no state — rendered DOM, request handler, or stub call
// record — survives from one test into the next. Every leak this closes produces a FALSE
// PASS rather than a failure, which is why the cleanup is explicit rather than inherited.

import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { server } from './test/msw/server';

/**
 * Start intercepting before the first test in the file.
 *
 * `onUnhandledRequest: 'error'` is passed HERE because `listen()` is the only place MSW
 * accepts it — `setupServer()` takes handlers and nothing else. Setting it at this single
 * call site is what makes it hold for every spec in the tier without any of them having
 * to remember it, and `'error'` rather than the default `'warn'` is the point: a warning
 * is printed and the request is then allowed through to a network that is not there, so
 * the component under test renders its error branch and an "it handles failure"
 * assertion passes having proven only that MSW was misconfigured. `'error'` fails the
 * test instead, naming the method and URL nobody stubbed.
 */
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

/**
 * Unmount everything and forget every per-test override, after every test.
 *
 * Order matters: `cleanup()` first, because unmounting can trigger an abort or a final
 * fetch from a component's teardown, and those must still be intercepted by the handlers
 * that were in force during the test rather than by whatever the reset restores.
 */
afterEach(() => {
  cleanup();
  server.resetHandlers();
  // Restores anything a spec replaced with vi.spyOn. It deliberately does NOT reset
  // vi.fn() instances or automocks -- Vitest 4 narrowed restoreAllMocks to spies only
  // (AAP §0.2.2.2) -- so a spec that needs a fresh vi.fn() creates one per test rather
  // than relying on a global reset that no longer does that.
  vi.restoreAllMocks();
});

/** Stop intercepting after the last test, so the process can exit cleanly. */
afterAll(() => {
  server.close();
});

/**
 * `IntersectionObserver`, which jsdom does not implement.
 *
 * A recording no-op rather than a working implementation: nothing in this tier asserts on
 * viewport intersection, and a component that constructs one during render would
 * otherwise throw `IntersectionObserver is not defined` — a crash in the component under
 * test that reads as a component defect.
 *
 * The stub is a class rather than an object literal because callers use `new`, and it
 * returns the empty `takeRecords` result the real API returns when nothing was observed.
 */
class IntersectionObserverStub implements IntersectionObserver {
  readonly root: Element | Document | null = null;

  readonly rootMargin: string = '0px';

  /**
   * Part of the current `IntersectionObserver` interface in this TypeScript lib, and
   * required rather than optional — so the stub declares it even though nothing reads it.
   * Declaring the whole interface rather than casting is deliberate: a cast would keep
   * compiling if the real API gained a member a component then called at runtime.
   */
  readonly scrollMargin: string = '0px';

  readonly thresholds: readonly number[] = Object.freeze([0]);

  observe(): void {
    // Intentionally inert: no spec asserts on intersection, so recording a callback that
    // is never invoked is more honest than inventing an intersection event.
  }

  unobserve(): void {
    // Inert, as above.
  }

  disconnect(): void {
    // Inert, as above.
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

/**
 * `window.matchMedia`, which jsdom does not implement.
 *
 * Always reports `matches: false`, so a component asking about `prefers-reduced-motion` or
 * a breakpoint gets the same answer in every run. A stub that guessed from the query
 * string would make a spec's outcome depend on which query a component happened to ask,
 * which is exactly the non-determinism AAP §0.7.2 forbids.
 *
 * `addListener` and `removeListener` are the deprecated pair; they are provided because
 * older component code and some libraries still call them, and their absence surfaces as
 * a TypeError deep inside a render.
 */
vi.stubGlobal(
  'matchMedia',
  (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList,
);

/**
 * `window.scrollTo`, which jsdom declares but does not implement — it logs
 * "Not implemented: window.scrollTo" to stderr on every call.
 *
 * Stubbed to silence that noise, which would otherwise bury a real console error in a
 * spec that is asserting there are none.
 */
vi.stubGlobal('scrollTo', () => undefined);
