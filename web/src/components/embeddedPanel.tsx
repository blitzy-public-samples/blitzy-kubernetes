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

// AAP §0.4.2.4 / tech-spec §7.1 — the shared contract between the aggregate posture
// dashboard and the eight control panels it composes.
//
// INVARIANT LOCKED: A PANEL IS CORRECT ON ITS OWN AND CORRECT INSIDE THE DASHBOARD, and the
// two are different documents. On its own a panel is the whole page: it owns the section
// title, and its verdict, loading, empty and error affordances are the only things on screen
// worth announcing. Inside the dashboard it is one of eight cards under a roster heading the
// dashboard already wrote, and one collection request changes all eight at once.
//
// Two defects follow from ignoring that difference, and this module is where both are fixed:
//
//   * HEADING HIERARCHY. The dashboard names each control with an `h3` and then the panel
//     restarted at `h2`, so the document went h1 -> h2 -> h3 -> h2: a reversal, and the
//     control's title appeared twice under two different names. Embedded, a panel renders no
//     heading of its own and takes its accessible name from the dashboard's heading, and its
//     internal subheadings move from `h3` to `h4` so the run stays monotonic.
//
//   * LIVE-REGION STORM. One collection transition was announced by the aggregate region
//     PLUS eight child `status`/`alert` regions, so a screen-reader user heard nine
//     announcements for one event — and the aggregate, the only one that summarises, arrived
//     buried among them. Embedded, the children keep their text and lose their roles: the
//     information is still there to read, and only the aggregate announces.
//
// Nothing here changes what a panel SAYS. Every sentence, verdict and observation renders
// identically in both modes; what changes is the heading level it sits under and whether a
// screen reader interrupts for it.

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

/**
 * What an embedded panel needs to know about the surface hosting it.
 *
 * Deliberately a CONTEXT rather than a prop threaded through eight component signatures.
 * The dashboard composes panels through one dispatcher, and several of the affected elements
 * live in nested sub-components two or three levels below a panel's root — a prop would have
 * to be forwarded through every one of them, and the first sub-component someone forgets is
 * a silent regression that renders an `h3` in a document that expects an `h4`.
 */
export interface EmbeddedPanelContextValue {
  /**
   * The id of the heading that names this panel's region.
   *
   * Supplied by the host because the host wrote the heading. A panel uses it for
   * `aria-labelledby` instead of pointing at a heading it no longer renders — this is the
   * "receive a heading ID appropriate to the dashboard hierarchy" half of the fix, and it is
   * what keeps every panel's `<section>` a NAMED region rather than an anonymous one.
   */
  readonly headingId: string;
}

/**
 * `undefined` means standalone, which is the default for a panel rendered directly.
 *
 * The absence of a provider is the standalone signal rather than a `false` flag, so a panel
 * used on its own needs no wiring at all and cannot accidentally opt into embedded
 * behaviour.
 */
const EmbeddedPanelContext = createContext<EmbeddedPanelContextValue | undefined>(undefined);

/** Props of {@link EmbeddedPanelProvider}. */
export interface EmbeddedPanelProviderProps extends EmbeddedPanelContextValue {
  /** The panel, or anything containing it. */
  readonly children: ReactNode;
}

/**
 * Marks everything inside as embedded in a host surface.
 *
 * Used once per control by the dashboard, wrapping the dispatcher. It is exported rather
 * than kept private so that a specification can exercise a panel's embedded rendering
 * directly, without standing up the whole dashboard to do it.
 */
export function EmbeddedPanelProvider({
  headingId,
  children,
}: EmbeddedPanelProviderProps): ReactElement {
  // The value is rebuilt each render, which is correct and cheap: `headingId` is derived
  // from the host's `useId` and is stable, so the identity change costs one context read per
  // render and buys not having a memo whose dependency list can drift.
  return (
    <EmbeddedPanelContext.Provider value={{ headingId }}>{children}</EmbeddedPanelContext.Provider>
  );
}

/**
 * Whether this panel renders its own section heading.
 *
 * `false` embedded, because the host already wrote one and two headings for one control is
 * the duplication half of the heading defect.
 */
export function useRendersOwnHeading(): boolean {
  return useContext(EmbeddedPanelContext) === undefined;
}

/**
 * The element name for this panel's internal subheadings.
 *
 * `h3` standalone, under the panel's own `h2`. `h4` embedded, under the host's `h3`. Returned
 * as an element NAME so a caller writes `<Subheading>` and cannot get the level wrong at one
 * of the thirty-odd sites that need it.
 */
export function usePanelSubheading(): 'h3' | 'h4' {
  return useContext(EmbeddedPanelContext) === undefined ? 'h3' : 'h4';
}

/**
 * The element name for a subheading NESTED INSIDE one of this panel's subheadings.
 *
 * One level below {@link usePanelSubheading}, and it exists because a fixed level here would
 * be flattened by the shift the outer hook performs. V8 renders five scenario articles beneath
 * its "Measured behaviour" subheading: at a literal `h4` those read as CHILDREN of that
 * subheading while the panel is standalone (`h3` -> `h4`) and as its SIBLINGS once the panel
 * is embedded and the subheading itself becomes an `h4`. Deriving this level from the same
 * context keeps the nesting a fact about the content rather than a side effect of where the
 * panel is rendered.
 */
export function usePanelDeepSubheading(): 'h4' | 'h5' {
  return useContext(EmbeddedPanelContext) === undefined ? 'h4' : 'h5';
}

/**
 * The id that names this panel's region.
 *
 * @param localHeadingId - the id of the heading the panel renders for itself.
 * @returns the host's heading id when embedded, the panel's own otherwise.
 */
export function usePanelLabelId(localHeadingId: string): string {
  return useContext(EmbeddedPanelContext)?.headingId ?? localHeadingId;
}

/**
 * The live-region role to use, or `undefined` when the host announces instead.
 *
 * Returning `undefined` rather than a quieter role is deliberate. `role="status"` with
 * `aria-live="off"` is a contradiction a reader of the markup has to resolve, and
 * `role="generic"` is not a thing; dropping the attribute leaves an ordinary element whose
 * text is read when the user reaches it, which is exactly the intent — the child's state is
 * still THERE, it just no longer interrupts.
 *
 * @param preferred - the role this element carries when the panel stands alone.
 * @returns `preferred` standalone, `undefined` embedded.
 */
export function useLiveRegionRole<Role extends 'status' | 'alert'>(
  preferred: Role,
): Role | undefined {
  return useContext(EmbeddedPanelContext) === undefined ? preferred : undefined;
}
