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
 * The one render entry point every component spec in this tier uses.
 *
 * AAP §0.5.1 (the `web/src/test/utils/renderWithProviders.tsx` row: "RTL render wrapper") /
 * §0.5.2.5 ("Every component test renders through `renderWithProviders.tsx` so provider
 * wiring is defined once, and every test file relies on the single MSW server instance
 * rather than creating its own") / §0.4.2.4 (every component spec covers the same five
 * categories — a passing verdict, a partial or unknown one, an error that must never read
 * as a pass, loading and empty states, and an interaction driven through `userEvent` — so
 * they must all start from the same render) / §0.2.2.3 (the React Testing Library 16
 * requirements this file honours) / tech-spec §7.1 ("No user interface required" — the
 * reason there is no pre-existing provider tree to reproduce, and why this tier's fidelity
 * is anchored on the REST contracts it renders rather than on a ported UI suite) /
 * §6.6.1.3 (jsdom only: browser automation, cross-browser runs and visual regression are
 * all recorded as not applicable to this repository) / §6.6.3.4 (the documentation
 * convention this block and the per-declaration comments below satisfy).
 *
 * WHY A WRAPPER RATHER THAN CALLING `render` DIRECTLY. Provider wiring belongs in ONE
 * place. Today the panels take their data as props or through a hook and need no context
 * provider mounted above them, so this wrapper mounts none — and that emptiness is a
 * measured conclusion rather than an oversight; see `AllProviders` below, which records the
 * evidence. The moment a theme, a router or a query client is genuinely needed, every spec
 * picks it up from here instead of eleven spec files each growing their own copy and
 * drifting apart. A spec that called RTL's `render` directly would silently miss whichever
 * provider was added last, and would then fail with a context error that points at the
 * component rather than at the missing wiring.
 *
 * THE RE-EXPORT BELOW IS PART OF THE SAME GUARANTEE. This module re-exports the whole of
 * `@testing-library/react`, so a spec can take `screen`, `waitFor`, `within`, `fireEvent`,
 * `renderHook` and `act` from the same specifier it takes the render from. That is the
 * conventional shape for a custom render, and it is what makes the shared render the path
 * of least resistance rather than an extra import a spec author has to remember. Because a
 * blanket re-export would otherwise hand out RTL's UNWRAPPED `render` from the very module
 * whose purpose is to guarantee one wiring path, the trailing export statement shadows that
 * one name with this file's wrapper. A spec that genuinely wants the unwrapped renderer
 * imports it from `@testing-library/react` and says so at its own import site.
 *
 * `userEvent` IS SET UP HERE TOO, and returned alongside the render result. RTL's own
 * guidance asks for one `userEvent.setup()` per test rather than the shared default API,
 * because the default keeps document-level state between uses; returning a fresh instance
 * from the render is what makes "one per test" the path of least resistance.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. Each omission is owned somewhere else, and
 * duplicating it here would be a defect rather than a belt-and-braces nicety:
 *
 * - It registers NO lifecycle hook — no `beforeAll`, `beforeEach`, `afterEach` or
 *   `afterAll`. `../../setupTests.ts` owns the tier's lifecycle: the jest-dom matchers,
 *   `afterEach(cleanup)`, the three jsdom stubs, and a single side-effect import of
 *   `../msw/server`, which registers its own `listen` / `resetHandlers` / `close` trio.
 *   Duplicating the cleanup registration would only repeat work — RTL's `cleanup` over an
 *   already-cleaned container is a no-op — but duplicating the server lifecycle is fatal: a
 *   second `listen()` on one MSW instance throws "cannot configure an already enabled
 *   network", failing every spec in the tier rather than just one. Either way the lifecycle
 *   has exactly one owner, and it is not this file.
 * - It imports neither `@testing-library/jest-dom` nor `../msw/server` nor anything from
 *   `../fixtures/`. Matchers and request handlers are not this file's business, and a spec
 *   that needs to override a handler imports `server` directly so the override is visible
 *   where it is used.
 * - It installs NO error boundary and swallows no error. A thrown render must reach the
 *   spec that caused it. This tier's central behavioural rule — the one
 *   `../../hooks/useControlStatus.test.ts` exists to hold — is that a rejected request must
 *   never surface as a passing verdict; a wrapper that absorbed a render error would
 *   convert exactly that failure into a silent pass, across every panel at once.
 * - It TRANSFORMS NOTHING it renders. Children, props and rendered output pass through
 *   untouched: no normalisation, no redaction, no filtering, no sorting, no serialisation.
 *   `../../components/ConfidentialityRedaction.test.tsx` proves that an audit event for the
 *   `secrets` resource never renders a response body — the presentation-layer half of the
 *   confidentiality guard that `test/utils/audit.go` asserts on the API side. If this
 *   wrapper altered content, that guard would pass for the wrong reason.
 * - It does not wrap in `act`. RTL already does, and an extra layer produces the "not
 *   wrapped in act" warnings AAP §0.2.2.3 records as the symptom of duplicated
 *   `@testing-library/dom` copies — a warning whose real cause is easy to misattribute.
 * - It is not a spec: no `describe`, `it`, `test` or `expect` is CALLED here, and the only
 *   mention of one is the usage example further down. `../../../vitest.config.ts` collects
 *   only files under `src` whose name carries a `.test.ts` or `.test.tsx` suffix, so this
 *   filename is never collected as a suite and a test call here would be dead code.
 */

// AAP §0.5.1 / §0.5.2.5 / §0.4.2.4 / §0.2.2.3 / tech-spec §7.1 / §6.6.1.3 / §6.6.3.4
//
// INVARIANT LOCKED BY THIS FILE: provider wiring for the React tier has exactly ONE
// definition site. Every component spec therefore mounts inside the same tree and receives
// its own fresh `userEvent` instance, so a difference between two specs is a difference in
// what they assert rather than in how they mounted. The module is stateless — it holds no
// mutable module-level state, caches no container, memoises no wrapper and mutates nothing
// global at import time — which is what makes it safe under this tier's per-file isolation
// and under Vitest's default worker pool, and what keeps `afterEach(cleanup)` in
// `../../setupTests.ts` effective rather than defeated.

import { render as rtlRender } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';

// The conventional custom-render shape: re-export the library, then override the one name
// this file replaces (see the trailing `export` statement). Nothing is imported for side
// effects here — `@testing-library/react` is already in this module's graph through the
// named import above, so the re-export adds bindings and not behaviour.
export * from '@testing-library/react';

/**
 * Options accepted alongside the element.
 *
 * `wrapper` is excluded from the underlying `RenderOptions`: this helper OWNS the wrapper,
 * and letting a caller replace it would defeat the single-place-for-provider-wiring
 * property that is the whole reason the helper exists. Everything else RTL accepts —
 * `container`, `baseElement`, `queries`, `hydrate`, `reactStrictMode` and the recoverable
 * error callbacks — stays available, because none of those changes WHAT is mounted above
 * the element under test. A spec that genuinely needs a different tree calls RTL's `render`
 * directly and says so at its own import site.
 */
export type RenderWithProvidersOptions = Omit<RenderOptions, 'wrapper'>;

/**
 * What a spec gets back: everything RTL returns, plus the per-render `userEvent` instance.
 *
 * Declared as an extension of RTL's own `RenderResult` rather than as a fresh shape, so
 * `container`, `baseElement`, `rerender`, `unmount`, `asFragment`, `debug` and the bound
 * queries keep exactly the types RTL gives them and stay in step with the pinned library.
 */
export interface RenderWithProvidersResult extends RenderResult {
  /**
   * A `userEvent` instance created for THIS render.
   *
   * Per-render rather than the shared default export, because the default API keeps
   * document-level state (pointer position, pressed keys, clipboard) between uses. Two
   * tests sharing it can produce a pass that depends on the order they ran in — which is
   * precisely the order dependence this tier has to exclude by construction, since
   * JavaScript offers no equivalent of the Go race detector the parity oracle runs under.
   */
  readonly user: ReturnType<typeof userEvent.setup>;
}

/**
 * The provider tree every component spec mounts inside.
 *
 * A PASS-THROUGH TODAY, AND MEASURED RATHER THAN ASSUMED. Three pieces of evidence, all
 * checkable in this tree:
 *
 * 1. `../../../package.json` pins seventeen packages and among them there is no router, no
 *    state-management library, no design system and no HTTP client. There is nothing of
 *    that kind to provide.
 * 2. Both hooks in `../../hooks/` consume nothing beyond `react`, the platform `fetch` and
 *    first-party modules under `../../domain/`, and every panel takes its verdict as a prop.
 *    No component in this tier reads a third-party context that a wrapper could satisfy.
 * 3. The tier's ONE React context — `EmbeddedPanelContext` in
 *    `../../components/embeddedPanel.tsx` — must NOT be hoisted to here, and this is the
 *    trap worth naming. Its default is `undefined`, and every reader
 *    (`useRendersOwnHeading`, `usePanelSubheading`, `usePanelDeepSubheading`,
 *    `usePanelLabelId`, `useLiveRegionRole`) treats that absence as the meaningful
 *    standalone default: the panel renders its own heading, picks its shallower subheading
 *    levels and keeps its live-region role. `PostureDashboard` provides that context around
 *    the panels it embeds, and only there. Adding it to this shared wrapper would silently
 *    flip every standalone panel spec into embedded mode, suppressing the headings and live
 *    regions those specs assert on — a one-line change here presenting as a tier-wide
 *    outbreak of component defects.
 *
 * It exists as a named seam rather than being omitted so that adding a provider later is a
 * one-line change here instead of an edit to every spec.
 */
function AllProviders({ children }: { readonly children: ReactNode }): ReactElement {
  // A fragment rather than a div: an extra element would appear in every snapshot and in
  // every `container.firstChild` assertion, making the harness visible in the output of
  // tests that are not about the harness. Children are returned exactly as received.
  return <>{children}</>;
}

/**
 * Renders `ui` inside the shared provider tree and returns RTL's result plus `user`.
 *
 * @param ui - what to mount. Typed as `ReactNode` to match the pinned RTL 16 signature,
 *   `render(ui: React.ReactNode, options?)`, rather than narrowing it here — a helper that
 *   accepted less than the library it delegates to would reject a fragment or an array of
 *   elements for no reason a caller could act on.
 * @param options - RTL render options, minus `wrapper`. Defaults to an empty object so the
 *   common single-argument call needs no undefined check.
 * @returns the RTL render result, extended with a `userEvent` instance for this render.
 *
 * @example
 * ```tsx
 * const { user } = renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
 * await user.click(screen.getByRole('button', { name: /refresh/i }));
 * expect(screen.getByRole('status')).toHaveAccessibleName(/pass/i);
 * ```
 */
export function renderWithProviders(
  ui: ReactNode,
  options: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  // Created BEFORE the render, which is what RTL's guidance asks for: setup() installs its
  // event plumbing on the document, and doing it after a render that already attached
  // listeners can drop the first interaction.
  const user = userEvent.setup();

  // PRECEDENCE IS DELIBERATE AND IS BOTH TYPE-LEVEL AND RUNTIME-LEVEL. The caller's options
  // are spread FIRST and `wrapper` is set LAST, so the wrapper is this file's under every
  // call — even one whose options object was widened enough to smuggle a `wrapper` key past
  // `RenderWithProvidersOptions`, which excludes it. Every other option the caller passed
  // still applies.
  const result = rtlRender(ui, { ...options, wrapper: AllProviders });

  return { ...result, user };
}

// Completes the override that the blanket re-export above makes necessary: an explicit
// export takes precedence over `export *` for the same name, in both the ES module
// semantics Vite implements and TypeScript's view of them, so `render` imported FROM THIS
// MODULE is the wrapper and never RTL's unwrapped renderer. This is the one name where a
// mistake would be invisible — the unwrapped call would render, pass, and quietly opt out
// of the provider tree — so it is closed here rather than left to reviewer vigilance.
export { renderWithProviders as render };
