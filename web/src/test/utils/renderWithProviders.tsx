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
 * §0.4.2.4 (every component spec covers the same five categories, so they must all start
 * from the same render) / §0.2.2.3 (the RTL 16 requirements this file honours) /
 * tech-spec §6.6.3.4.
 *
 * WHY A WRAPPER RATHER THAN CALLING `render` DIRECTLY. Provider wiring belongs in ONE
 * place. Today the panels take their data as props or through a hook and need no context
 * provider at all, so this wrapper adds none — and that emptiness is the point rather than
 * an oversight. The moment a theme, a router or a query client is introduced, every spec
 * picks it up from here instead of ten spec files each growing their own copy and drifting.
 * A spec that called `render` directly would silently miss whichever provider was added
 * last, and would fail with a context error that points at the component rather than at
 * the missing wiring.
 *
 * `userEvent` IS SET UP HERE TOO, and returned alongside the render result. RTL's own
 * documentation asks for one `userEvent.setup()` per test rather than the global default
 * API, because the global one shares state across tests; returning it from the render is
 * what makes "one per test" the path of least resistance.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO:
 *
 * - It does not re-export the whole of `@testing-library/react`. A spec importing
 *   `screen` from a local util rather than from RTL makes it harder, not easier, to look
 *   up what a query does.
 * - It does not register cleanup. `../../setupTests.ts` owns the lifecycle, and a second
 *   registration would run `cleanup()` twice per test.
 * - It does not wrap in `act`. RTL already does, and an extra layer produces the
 *   "not wrapped in act" warnings AAP §0.2.2.3 records as the symptom of duplicated
 *   `@testing-library/dom` copies — a warning whose real cause is easy to misattribute.
 */

// AAP §0.5.1 / §0.4.2.4 / §0.2.2.3 / tech-spec §6.6.3.4
//
// INVARIANT LOCKED BY THIS FILE: every component spec renders through the same provider
// tree and the same per-test userEvent instance, so a difference between two specs is a
// difference in what they assert rather than in how they mounted.

import { render } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';

/**
 * Options accepted alongside the element.
 *
 * `wrapper` is excluded from the underlying `RenderOptions`: this helper OWNS the wrapper,
 * and letting a caller replace it would defeat the single-place-for-provider-wiring
 * property that is the whole reason the helper exists. A spec that genuinely needs a
 * different tree calls RTL's `render` directly and says so.
 */
export type RenderWithProvidersOptions = Omit<RenderOptions, 'wrapper'>;

/**
 * What a spec gets back: everything RTL returns, plus the per-test `userEvent` instance.
 */
export interface RenderWithProvidersResult extends RenderResult {
  /**
   * A `userEvent` instance created for THIS render.
   *
   * Per-test rather than the shared default export, because the default API keeps
   * document-level state (pointer position, pressed keys, clipboard) between uses. Two
   * tests sharing it can produce a pass that depends on the order they ran in, which
   * `pytest-randomly`'s equivalent — Vitest's file-level isolation plus this per-test
   * instance — is here to prevent.
   */
  readonly user: ReturnType<typeof userEvent.setup>;
}

/**
 * The provider tree every component spec mounts inside.
 *
 * Currently a pass-through, and honestly so: §7.1 of the technical specification records
 * that this system had no user interface before this migration, so there is no theme,
 * router, store or query client to provide. It exists as a named seam rather than being
 * omitted, because adding one later must be a one-line change here instead of an edit to
 * every spec.
 */
function Providers({ children }: { readonly children: ReactNode }): ReactElement {
  // A fragment rather than a div: an extra element would appear in every snapshot and in
  // every `container.firstChild` assertion, making the harness visible in the output of
  // tests that are not about the harness.
  return <>{children}</>;
}

/**
 * Renders `ui` inside the shared provider tree and returns RTL's result plus `user`.
 *
 * @param ui - the element under test.
 * @param options - RTL render options, minus `wrapper`.
 * @returns the RTL render result, extended with a per-test `userEvent` instance.
 *
 * @example
 * ```tsx
 * const { user } = renderWithProviders(<RbacWildcardPanel status={V1_RBAC_PASSING} />);
 * await user.click(screen.getByRole('button', { name: /refresh/i }));
 * expect(screen.getByRole('status')).toHaveAccessibleName(/pass/i);
 * ```
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  // Created BEFORE render, which is what RTL's guidance asks for: setup() installs its
  // event plumbing on the document, and doing it after a render that already attached
  // listeners can drop the first interaction.
  const user = userEvent.setup();
  const result = render(ui, { ...options, wrapper: Providers });
  return { ...result, user };
}
