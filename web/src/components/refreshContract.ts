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

// AAP §0.4.2.4 (the L6 React tier's interaction case: "an interaction case driving refresh
// or filter through `userEvent`") / §0.5.5 (one definition site per datum, which is why the
// wording and the rule below are here rather than copied into eight panels) /
// tech-spec §6.6.3.4.
//
// THE ONE PLACE THE REFRESH CONTRACT BETWEEN THE DASHBOARD AND ITS PANELS IS DECIDED.
//
// This module deliberately imports NOTHING — not React, not the hooks, not a panel — so
// every panel and the dashboard can import it with no possibility of an import cycle. The
// aggregate dashboard imports each panel; each panel imports this; nothing imports the
// dashboard. (The verdict registry in ./controlVerdicts.ts imports the panels for the same
// acyclic reason, and no panel imports the registry.)
//
// TWO DEFECTS THIS MODULE EXISTS TO PREVENT, both of which were reachable while every
// panel decided the question for itself:
//
//   1. DOUBLE REFRESH. A panel handed both a hook result and an `onRefresh` callback could
//      call BOTH, so one press of one button issued two requests and two callbacks. The
//      dashboard passes the same handler through both channels, so the two were the same
//      function invoked twice.
//   2. AN ENABLED NO-OP. A caller-driven surface with nothing to re-request manufactured a
//      do-nothing function to satisfy the required `refresh` member, and every child then
//      rendered an enabled button that silently did nothing when pressed — while the
//      dashboard's own button, which could see the absence, was correctly disabled. A
//      control that looks operable and is not is worse than one that says it cannot act.
//
// The rule, stated once: THE OVERRIDE REPLACES THE UNDERLYING HANDLER, NEVER JOINS IT, and
// a refresh that cannot re-request anything is `undefined` so the affordance is natively
// disabled with a title that says why.

/**
 * Why a refresh control is disabled, as its `title`.
 *
 * Rendered rather than left implicit: a disabled button with no explanation is a dead end,
 * and the reader's next question ("why can I not refresh this?") has a real answer — the
 * data was handed to the surface directly, so there is no request belonging to it to
 * re-issue.
 */
export const REFRESH_UNAVAILABLE_TITLE =
  'No request belongs to this view, so there is nothing to re-request. The posture was ' +
  'supplied directly by the caller.';

/**
 * The single handler a refresh affordance should call, or `undefined` when refreshing
 * cannot achieve anything.
 *
 * Invariant locked — EXACTLY ONE CHANNEL. When a caller supplies an override it REPLACES
 * the underlying handler; the two are never chained. Chaining is what turned one press
 * into two requests, and it is not recoverable by inspection because both channels
 * legitimately hold a function.
 *
 * Invariant locked — ABSENCE PROPAGATES. `available: false` returns `undefined` whatever
 * the two handlers hold, so a surface that knows nothing can be re-requested can say so
 * once and have every affordance beneath it agree. Callers render
 * `disabled={handler === undefined}` with {@link REFRESH_UNAVAILABLE_TITLE}, so the
 * disabled state is derived from the same value the click handler is, and the two cannot
 * disagree.
 *
 * @param override - the caller's handler, when it supplied one.
 * @param underlying - the handler belonging to the data source, when there is one.
 * @param available - `false` when the surface knows there is nothing to re-request.
 *   Defaults to `true`, so a panel used on its own keeps its own refresh working.
 * @returns the one handler to invoke, or `undefined` when the affordance must be disabled.
 */
export function resolveRefreshHandler(
  override: (() => void) | undefined,
  underlying: (() => void) | undefined,
  available = true,
): (() => void) | undefined {
  if (!available) {
    return undefined;
  }
  return override ?? underlying;
}
