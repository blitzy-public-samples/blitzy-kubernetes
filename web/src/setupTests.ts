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
 * AAP §0.4.4.3 (this file's four responsibilities, named there: the jest-dom matchers,
 * `afterEach(cleanup)`, the three jsdom stubs, and the single MSW server import — plus
 * the mocking policy that puts declarative HTTP mocking at the React tier and nowhere
 * else) / §0.5.1 (the `web/src/setupTests.ts` row: "jest-dom import, afterEach(cleanup),
 * jsdom stubs for IntersectionObserver, matchMedia, scrollTo") / §0.2.2.3 (the jsdom
 * pitfalls this file pre-empts, each measured rather than assumed) / tech-spec §6.6.1.3
 * (this repository ships no graphical client, which is why the tier runs in jsdom and
 * why browser automation, cross-browser runs and visual regression are all recorded as
 * not applicable to it) / tech-spec §6.6.3.4 (the documentation convention this
 * provenance block and the per-block invariant comments below satisfy).
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
 * 3. THE MSW SERVER, STARTED BY IMPORTING IT — AND NOTHING MORE. `./test/msw/server`
 *    owns both the single `setupServer` instance and its whole lifecycle: it registers
 *    `beforeAll(listen)`, `afterEach(resetHandlers)` and `afterAll(close)` itself. This
 *    file's entire contribution is to import that module exactly once, which is what
 *    guarantees the lifecycle is registered for every spec in the tier without any spec
 *    having to remember it. This file must NOT re-register those hooks; see the import
 *    comment below for the measured failure a second `listen()` produces.
 * 4. THE THREE BROWSER GLOBALS jsdom DOES NOT IMPLEMENT. Each is stubbed rather than
 *    polyfilled, because the specs assert on rendered output and interaction and never on
 *    scroll position or viewport intersection: an inert observer, a media query that
 *    always answers the same way, and a scroll recorder a spec can assert on. A real
 *    implementation would add behaviour nothing asserts, and — worse for a suite whose
 *    job is to be believed — behaviour that could differ between runs.
 */

// AAP §0.4.4.3 / §0.5.1 / §0.2.2.3 / tech-spec §6.6.1.3 / §6.6.3.4
//
// INVARIANT LOCKED BY THIS FILE: no state — rendered DOM, request handler, or recorded
// stub call — survives from one test into the next, while everything this file INSTALLS
// survives the whole spec file. Those two halves are what make the tier deterministic
// without a Go `-race` equivalent (AAP §0.4.1.2, §0.7.2), and each half is owned in
// exactly one place: the DOM by `cleanup()` below, the request handlers by
// `./test/msw/server`'s own `resetHandlers`, and recorded calls by `clearMocks` in
// `web/vitest.config.ts`. Every leak these close would produce a FALSE PASS rather than a
// failure, which is why the teardown is explicit and stated rather than inherited.

import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// A SIDE-EFFECT IMPORT, AND DELIBERATELY NOT A NAMED ONE. Importing this module is
// what starts the tier's MSW server: `./test/msw/server` owns the single
// `setupServer` instance AND registers `beforeAll(listen)`, `afterEach(resetHandlers)`
// and `afterAll(close)` itself. This file must therefore import it exactly once and
// must NOT re-register any of those three hooks -- a second `listen()` on one MSW
// instance throws "cannot configure an already enabled network", which fails every
// spec in the tier rather than just one. There is no `server` binding here because
// nothing in this file needs one; `strict` plus `noUnusedLocals` would flag it.
// `onUnhandledRequest: 'error'` lives at that module's `listen()` call, the only place
// MSW accepts it.
import './test/msw/server';

/**
 * Unmount everything rendered by the test that just finished.
 *
 * Kept explicitly even though RTL 16 auto-registers its own cleanup when a global
 * `afterEach` exists (which `globals: true` provides): AAP §0.5.1 names
 * `afterEach(cleanup)` as a requirement of this file, and cleanup over an
 * already-cleaned container is a no-op, so the belt-and-braces call is free. A future
 * reader may be tempted to delete it as redundant — do not.
 *
 * Ordering against the MSW handler reset is structural rather than stated here. Vitest
 * runs `afterEach` hooks in REVERSE registration order, and `./test/msw/server`'s body
 * runs before this file's because ES imports are hoisted — so this `cleanup()` always
 * runs BEFORE that module's `resetHandlers()`. That is the order wanted: unmounting can
 * trigger an abort or one last fetch from a component's teardown, and those must still
 * meet the handlers that were in force during the test.
 *
 * UNMOUNTING IS ALL THIS HOOK DOES, and the omission is deliberate enough to name: there
 * is no global `vi.restoreAllMocks()`, `vi.resetAllMocks()` or `vi.unstubAllGlobals()`
 * call here, and none may be added. The asymmetry is the whole reason — `setupFiles` runs
 * once per spec FILE, while a hook registered here runs after every TEST, so a global
 * restore would begin dismantling, from the end of the first test onwards, the
 * environment the rest of this file installs exactly once. Every test after the first in
 * a file would then run against a half-torn-down environment: no IntersectionObserver, no
 * matchMedia. `web/vitest.config.ts` records the same reasoning from the other side,
 * leaving `restoreMocks`, `unstubGlobals` and `unstubEnvs` unset and making `clearMocks`
 * the tier's single mock-lifecycle mechanism — it empties recorded calls before each test
 * without touching what is installed.
 *
 * MEASURED, not merely argued. Adding `vi.unstubAllGlobals()` to a hook alongside this
 * one was tried directly against a two-test spec: the FIRST test passed and the second
 * failed with "expected 'undefined' to be 'function'" on `globalThis.IntersectionObserver`
 * — the exact half-torn-down environment described above, and a failure that would have
 * been blamed on the component rather than on the setup file. Removing it turned both
 * tests green again.
 *
 * Safe to omit for a second measured reason: the tier's only `vi.spyOn` is in
 * `src/hooks/useControlStatus.test.ts`, and that test calls `mockRestore()` on it itself.
 * A spec that replaces something owns putting it back, which is also the only place a
 * reader would think to look for the undo.
 */
afterEach(() => {
  cleanup();
});

/**
 * `IntersectionObserver`, which jsdom does not implement.
 *
 * An inert stub rather than a working implementation: nothing in this tier asserts on
 * viewport intersection, and a component that constructs one during render would
 * otherwise throw `IntersectionObserver is not defined` — a crash in the component under
 * test that reads as a component defect.
 *
 * The stub is a class rather than an object literal because callers use `new`, and it
 * returns the empty `takeRecords` result the real API returns when nothing was observed.
 */
class IntersectionObserverStub implements IntersectionObserver {
  readonly root: Element | Document | null;

  readonly rootMargin: string;

  /**
   * Part of the current `IntersectionObserver` interface in this TypeScript lib, and
   * required rather than optional — so the stub declares it even though no spec here reads
   * it. Declaring the whole interface rather than casting is deliberate: a cast would keep
   * compiling if the real API gained a member a component then called at runtime.
   */
  readonly scrollMargin: string;

  readonly thresholds: ReadonlyArray<number>;

  /**
   * The real `(callback, options?)` constructor signature, so `new IntersectionObserver(cb)`
   * and `new IntersectionObserver(cb, { threshold: 0.5 })` both construct exactly as they
   * would in a browser. A nullary stub would accept those calls too — JavaScript discards
   * surplus arguments — but it would then answer questions about ITSELF rather than about
   * the caller, which is the kind of stub that makes a component look correct while
   * reporting a configuration it never asked for.
   *
   * The callback is `_callback` because it is deliberately never invoked: this stub reports
   * no intersections at all, and calling it would fabricate an intersection event no spec
   * asked for and none can predict. The leading underscore is also the form
   * `noUnusedParameters` in `web/tsconfig.json` accepts for an intentionally unused
   * parameter, so the intent is stated to the compiler rather than suppressed from it.
   *
   * The options ARE read, and are reflected back through the three readonly properties the
   * interface exposes — including the real API's normalisation of a scalar `threshold` into
   * the `thresholds` list. Frozen, because the interface declares it readonly and a caller
   * that mutated it would be changing an observer's reported configuration after the fact.
   */
  constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? '0px';
    this.scrollMargin = options?.scrollMargin ?? '0px';

    const threshold = options?.threshold ?? 0;
    this.thresholds = Object.freeze(typeof threshold === 'number' ? [threshold] : [...threshold]);
  }

  observe(): void {
    // Intentionally inert. Accepting the target and then reporting nothing is the honest
    // stub: this tier asserts on rendered output, so synthesising an intersection event
    // would hand a component a viewport state no spec asked for and none could predict.
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
 *
 * A `vi.fn()` rather than a bare no-op, so a spec that cares whether a panel scrolled can
 * assert on it — `expect(vi.mocked(window.scrollTo)).toHaveBeenCalled()`. Recording costs
 * nothing while unused, and it is the one stub here whose CALLS must not outlive a test:
 * `clearMocks: true` in `web/vitest.config.ts` empties the call list before every test, so
 * no test can read another's scrolling. That option calls `mockClear()`, which discards the
 * recorded calls and leaves the mock itself installed — which is exactly why this stub
 * survives the whole spec file while its records do not.
 */
vi.stubGlobal('scrollTo', vi.fn());
