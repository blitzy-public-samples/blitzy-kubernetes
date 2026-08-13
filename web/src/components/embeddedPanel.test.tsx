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

// AAP §0.4.2.4 (the React component tier) / §0.7.2 (assertion density, failure legibility) /
// tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS: THE ABSENCE OF A PROVIDER IS THE STANDALONE SIGNAL, and every
// hook here agrees about it. Eight panels and one dashboard depend on that agreement, and it is
// asserted directly rather than only through them, for two reasons.
//
// First, a defect here is silent. If `usePanelSubheading` reported "embedded" while
// `useRendersOwnHeading` reported "standalone", the result is a document with two `h2`s or none
// — valid markup either way, rendering identically to sighted review, and wrong. There is no
// exception to catch and nothing to see.
//
// Second, the contract has to hold for a panel NOBODY WIRED UP. A panel rendered on its own must
// behave correctly with no provider anywhere above it, so "no context" cannot be an error state;
// it has to be a meaningful default. That is exactly the case a spec driven only through the
// dashboard never reaches, because the dashboard always provides.

import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

import { renderWithProviders } from '../test/utils/renderWithProviders';
import {
  EmbeddedPanelProvider,
  useLiveRegionRole,
  usePanelDeepSubheading,
  usePanelLabelId,
  usePanelSubheading,
  useRendersOwnHeading,
} from './embeddedPanel';

/** The host heading id a real dashboard passes down. */
const HOST_HEADING_ID = 'dashboard-V8-heading';

/** A panel's own heading id, used only when it renders its own heading. */
const LOCAL_HEADING_ID = 'panel-own-heading';

/**
 * A probe that reads every hook at once and reports each answer as a data attribute.
 *
 * One component reading all six is deliberate: the hazard is DISAGREEMENT between them, so they
 * must be observed under a single set of conditions rather than one per render.
 */
function Probe(): ReactElement {
  const rendersOwnHeading = useRendersOwnHeading();
  const Subheading = usePanelSubheading();
  const DeepSubheading = usePanelDeepSubheading();
  const labelId = usePanelLabelId(LOCAL_HEADING_ID);
  const statusRole = useLiveRegionRole('status');
  const alertRole = useLiveRegionRole('alert');

  return (
    <section
      aria-labelledby={labelId}
      data-renders-own-heading={String(rendersOwnHeading)}
      data-subheading={Subheading}
      data-deep-subheading={DeepSubheading}
      data-label-id={labelId}
      data-status-role={statusRole ?? 'none'}
      data-alert-role={alertRole ?? 'none'}
    >
      {rendersOwnHeading ? <h2 id={LOCAL_HEADING_ID}>{'Own title'}</h2> : null}
      <Subheading>{'Subsection'}</Subheading>
      <DeepSubheading>{'Nested subsection'}</DeepSubheading>
      <p role={statusRole}>{'state text'}</p>
      <p role={alertRole}>{'failure text'}</p>
    </section>
  );
}

/** Renders the probe with a host above it, as the dashboard does. */
function embedded(children: ReactNode): ReactElement {
  return <EmbeddedPanelProvider headingId={HOST_HEADING_ID}>{children}</EmbeddedPanelProvider>;
}

/** The probe's reported answers, read back off the DOM. */
function answers(container: HTMLElement): Record<string, string> {
  const section = container.querySelector('section');
  expect(section, 'the probe rendered no section').not.toBeNull();
  const element = section as HTMLElement;
  return {
    rendersOwnHeading: element.getAttribute('data-renders-own-heading') ?? '',
    subheading: element.getAttribute('data-subheading') ?? '',
    deepSubheading: element.getAttribute('data-deep-subheading') ?? '',
    labelId: element.getAttribute('data-label-id') ?? '',
    statusRole: element.getAttribute('data-status-role') ?? '',
    alertRole: element.getAttribute('data-alert-role') ?? '',
  };
}

describe('embeddedPanel — standalone, with no provider anywhere above', () => {
  it('reports the standalone answer from every hook at once', () => {
    // The case a dashboard-driven spec never reaches: nobody wired anything up, and that has
    // to be the correct default rather than a missing configuration.
    const { container } = renderWithProviders(<Probe />);

    expect(answers(container)).toEqual({
      rendersOwnHeading: 'true',
      subheading: 'h3',
      deepSubheading: 'h4',
      labelId: LOCAL_HEADING_ID,
      statusRole: 'status',
      alertRole: 'alert',
    });
  });

  it('produces a monotonic h2 -> h3 -> h4 run naming the panel once', () => {
    const { container } = renderWithProviders(<Probe />);
    const levels = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((heading) =>
      Number(heading.tagName.slice(1)),
    );

    expect(levels).toEqual([2, 3, 4]);
  });

  it('names its own region and announces its own state', () => {
    const { container } = renderWithProviders(<Probe />);

    expect(container.querySelector('section')).toHaveAttribute(
      'aria-labelledby',
      LOCAL_HEADING_ID,
    );
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('embeddedPanel — embedded beneath a host', () => {
  it('reports the embedded answer from every hook at once', () => {
    const { container } = renderWithProviders(embedded(<Probe />));

    expect(answers(container)).toEqual({
      rendersOwnHeading: 'false',
      subheading: 'h4',
      deepSubheading: 'h5',
      labelId: HOST_HEADING_ID,
      statusRole: 'none',
      alertRole: 'none',
    });
  });

  it('shifts both subheading levels down by exactly one, preserving the nesting', () => {
    // Shifting only the outer level would flatten a nested subsection into a sibling of the
    // subsection it belongs under, so both levels move together.
    const { container } = renderWithProviders(embedded(<Probe />));
    const levels = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((heading) =>
      Number(heading.tagName.slice(1)),
    );

    expect(levels).toEqual([4, 5]);
  });

  it('takes its accessible name from the host, so the region is never anonymous', () => {
    // Suppressing the panel's heading must not leave `aria-labelledby` pointing at an id that
    // no longer exists: an anonymous region drops out of a landmark list altogether, which is
    // worse than the duplicated name the suppression was fixing.
    const { container } = renderWithProviders(embedded(<Probe />));

    expect(container.querySelector('section')).toHaveAttribute(
      'aria-labelledby',
      HOST_HEADING_ID,
    );
    expect(container.querySelector(`#${LOCAL_HEADING_ID}`)).toBeNull();
  });

  it('drops the live-region roles while keeping the text that carried them', () => {
    // The whole point of dropping the role rather than quietening it: the state is still there
    // to be read, it simply no longer interrupts.
    const { container } = renderWithProviders(embedded(<Probe />));

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container).toHaveTextContent('state text');
    expect(container).toHaveTextContent('failure text');
  });

  it('omits the role attribute entirely rather than writing a contradictory one', () => {
    // `role="status"` with `aria-live="off"` is a contradiction a reader of the markup has to
    // resolve, and there is no "inert live region" role to fall back on. Asserted on the
    // attribute itself because `undefined` and `'off'` are indistinguishable through a
    // role-based query.
    const { container } = renderWithProviders(embedded(<Probe />));

    for (const paragraph of Array.from(container.querySelectorAll('p'))) {
      expect.soft(paragraph.hasAttribute('role')).toBe(false);
      expect.soft(paragraph.hasAttribute('aria-live')).toBe(false);
    }
  });

  it('applies to a consumer nested arbitrarily deep, not just a direct child', () => {
    // Why this is a context rather than a prop: several of the affected elements live two or
    // three components below a panel's root, and a prop threaded by hand is one forgotten
    // component away from a silent regression.
    const { container } = renderWithProviders(
      embedded(
        <div>
          <div>
            <div>
              <Probe />
            </div>
          </div>
        </div>,
      ),
    );

    expect(answers(container).subheading).toBe('h4');
    expect(answers(container).labelId).toBe(HOST_HEADING_ID);
  });

  it('passes the host’s own heading id through verbatim', () => {
    const { container } = renderWithProviders(
      <EmbeddedPanelProvider headingId="some-other-host-heading">
        <Probe />
      </EmbeddedPanelProvider>,
    );

    expect(answers(container).labelId).toBe('some-other-host-heading');
  });
});
