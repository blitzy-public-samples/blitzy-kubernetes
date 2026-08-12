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

// AAP §0.5.1 (the `web/src/components/ConfidentialityRedaction.test.tsx` row —
// "Presentation-layer mirror: a secrets audit event must never render a responseObject") /
// §0.4.2.4 (the five case categories every panel spec covers) / §0.10.2 (the
// "Confidentiality guard" boundary row: no audit event whose `objectRef.resource` is
// `secrets` may carry a `responseObject`, while a `requestObject` on create or update is
// the accepted trade-off) / tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   Nothing derived from a `secrets` response body reaches the document — not the body, not
//   a fragment, not its length, not a hash, not a truncated prefix and not a copy inside a
//   collapsed disclosure element — while a `requestObject` on a `secrets` event and a
//   `responseObject` on any other resource both still render.
//
// THE UNDER-REPORTING DEFECT THESE CASES EXIST TO PREVENT. The guard read presence with an
// object test, `typeof payload === 'object' && Boolean(payload)`. The Go side of this same
// control does not agree: `test/utils/audit.go` L151-156 flattens `ResponseObject` to a
// BOOLEAN, and the Go guard at audit_test.go L1044 then tests
// `e.Resource == "secrets" && e.ResponseObject`. An event arriving in that flattened form
// therefore failed the object test, rendered "No body recorded", and was counted as nothing
// withheld — so the summary asserted that no Secret response body existed when one did.
// Under-reporting a guard is a quieter version of the same failure as defeating it.
//
// EVERY BODY IN THIS FILE IS A MARKER STRING, never a plausible Secret payload. The
// assertions look for the marker's ABSENCE from the rendered document, which is the only
// way to prove a redaction actually redacted, and a marker cannot itself become a
// credential leaked into a CI log.

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AuditEvent } from '../hooks/useAuditEvents';
import {
  ALL_OBSERVED_AUDIT_EVENTS,
  RBAC_RESPONSE_AUDIT_EVENTS,
  SECRETS_REQUEST_AUDIT_EVENTS,
} from '../test/fixtures/auditEvents';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import ConfidentialityRedaction, {
  mustWithholdResponseBody,
} from './ConfidentialityRedaction';

/** A marker that must never appear in the document when it is a Secret response body. */
const RESPONSE_MARKER = 'RESPONSE_BODY_MARKER_MUST_NOT_RENDER';

/** A marker that MUST appear: a request body on a Secret event is the accepted trade-off. */
const REQUEST_MARKER = 'REQUEST_BODY_MARKER_MUST_RENDER';

/** The first recorded `secrets` event, used as the base for the violation cases. */
const SECRETS_EVENT: AuditEvent = SECRETS_REQUEST_AUDIT_EVENTS[0];

/** The first recorded `roles` event, which legitimately carries both bodies. */
const RBAC_EVENT: AuditEvent = RBAC_RESPONSE_AUDIT_EVENTS[0];

/** A `secrets` event carrying a response body — the violation state, built locally. */
function offendingSecretsEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    ...SECRETS_EVENT,
    responseObject: { marker: RESPONSE_MARKER },
    ...overrides,
  };
}

/** The whole rendered text, for absence assertions. */
function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('ConfidentialityRedaction — the recorded events are clean', () => {
  it('reports nothing withheld across every recorded event', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={ALL_OBSERVED_AUDIT_EVENTS} />,
    );

    expect(container).toHaveTextContent('no body was withheld');
  });

  it('scans every supplied event and says how many', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={ALL_OBSERVED_AUDIT_EVENTS} />,
    );

    expect(container).toHaveTextContent(
      `Scanned ${String(ALL_OBSERVED_AUDIT_EVENTS.length)} audit events.`,
    );
  });

  it('confirms no recorded secrets event carries a response body', () => {
    for (const event of ALL_OBSERVED_AUDIT_EVENTS) {
      expect.soft(mustWithholdResponseBody(event)).toBe(false);
    }
  });

  it('renders a response body for the non-secrets control group', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[RBAC_EVENT]} />,
    );

    expect(container.querySelectorAll('pre').length).toBeGreaterThan(0);
  });
});

describe('ConfidentialityRedaction — a Secret response body never reaches the document', () => {
  it('withholds an object-valued Secret response body', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[offendingSecretsEvent()]} />,
    );

    expect(text(container)).not.toContain(RESPONSE_MARKER);
    expect(container).toHaveTextContent('Response body withheld');
  });

  it('counts the withheld body as a violation of the Request-level guard', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[offendingSecretsEvent()]} />,
    );

    expect(container).toHaveTextContent('Withheld 1 response body');
    expect(container).toHaveTextContent('violation of the Request-level audit guard');
  });

  it('addresses each redaction by the audit identifier, so a second cannot hide', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[
          offendingSecretsEvent({ auditID: 'offender-1' }),
          offendingSecretsEvent({ auditID: 'offender-2' }),
        ]}
      />,
    );

    expect(
      screen.getByRole('note', { name: /Response body withheld for audit event offender-1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('note', { name: /Response body withheld for audit event offender-2/ }),
    ).toBeInTheDocument();
    expect(container).toHaveTextContent('Withheld 2 response bodies');
  });

  it('withholds the Go-FLATTENED boolean form and counts it', () => {
    // `test/utils/audit.go` L151-156 flattens the body to `true`; the Go guard's test at
    // audit_test.go L1044 is a boolean test, so this IS a recorded body.
    const flattened = {
      ...SECRETS_EVENT,
      responseObject: true,
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[flattened]} />);

    expect(mustWithholdResponseBody(flattened)).toBe(true);
    expect(container).toHaveTextContent('Withheld 1 response body');
    expect(container).not.toHaveTextContent('no body was withheld');
    // The CELL must say so too, not only the summary: a count that says "withheld" beside
    // a cell that says "No body recorded" is the component contradicting itself.
    expect(
      screen.getByRole('note', { name: /Response body withheld for audit event/ }),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent('No body recorded');
  });

  it('withholds a string-valued response body rather than rendering it', () => {
    const stringified = {
      ...SECRETS_EVENT,
      responseObject: RESPONSE_MARKER,
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[stringified]} />);

    expect(text(container)).not.toContain(RESPONSE_MARKER);
    expect(container).toHaveTextContent('Withheld 1 response body');
    expect(
      screen.getByRole('note', { name: /Response body withheld for audit event/ }),
    ).toBeInTheDocument();
  });

  it('treats an explicit null response body as absence, not as a recorded body', () => {
    const explicitNull = {
      ...SECRETS_EVENT,
      responseObject: null,
    } as unknown as AuditEvent;

    expect(mustWithholdResponseBody(explicitNull)).toBe(false);
  });

  it('puts nothing derived from the body in the document — no length, hash or prefix', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[offendingSecretsEvent()]} />,
    );
    const rendered = text(container);

    expect(rendered).not.toContain(RESPONSE_MARKER);
    expect(rendered).not.toContain(RESPONSE_MARKER.slice(0, 8));
    expect(rendered).not.toContain(String(JSON.stringify({ marker: RESPONSE_MARKER }).length));
    expect(container.querySelectorAll('details').length).toBe(0);
  });

  it('never lets a filter present the view as though no redaction were needed', async () => {
    const { container, user } = renderWithProviders(
      <ConfidentialityRedaction events={[offendingSecretsEvent(), RBAC_EVENT]} />,
    );

    await user.selectOptions(screen.getByLabelText('Filter by resource'), 'roles');

    expect(container).toHaveTextContent('Withheld 1 response body');
    expect(container).toHaveTextContent('hidden by the current filter');
  });
});

describe('ConfidentialityRedaction — the guard is targeted, not blanket', () => {
  it('renders a requestObject on a Secret event — the accepted trade-off', () => {
    const withRequestBody = {
      ...SECRETS_EVENT,
      requestObject: { marker: REQUEST_MARKER },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[withRequestBody]} />,
    );

    expect(text(container)).toContain(REQUEST_MARKER);
  });

  it('renders a responseObject on a NON-secrets resource', () => {
    const roleEvent = {
      ...RBAC_EVENT,
      responseObject: { marker: RESPONSE_MARKER },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[roleEvent]} />);

    expect(text(container)).toContain(RESPONSE_MARKER);
    expect(container).toHaveTextContent('no body was withheld');
  });

  it('reports a non-object body on a non-secrets resource as undisplayable, not as absent', () => {
    const flattenedRole = {
      ...RBAC_EVENT,
      responseObject: true,
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[flattenedRole]} />,
    );

    expect(container).toHaveTextContent('Body could not be displayed');
    expect(mustWithholdResponseBody(flattenedRole)).toBe(false);
  });

  it('reports an absent body as absent for both resources', () => {
    const bare = { ...SECRETS_EVENT, requestObject: undefined, responseObject: undefined };
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[bare]} />);

    expect(container).toHaveTextContent('No body recorded');
  });

  it('treats a non-resource event, which has no objectRef, as not sensitive', () => {
    const nonResource = {
      ...SECRETS_EVENT,
      objectRef: undefined,
      requestURI: '/healthz',
      responseObject: { marker: RESPONSE_MARKER },
    } as unknown as AuditEvent;

    expect(mustWithholdResponseBody(nonResource)).toBe(false);
  });
});

describe('ConfidentialityRedaction — loading, empty, error and accessibility', () => {
  it('renders the empty affordance for a caller-supplied empty result', () => {
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[]} />);

    expect(container).toHaveTextContent('No audit events');
  });

  it('renders the pending affordance when the caller owns the loading lifecycle', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[]} isLoading />,
    );

    expect(container).toHaveTextContent('Loading audit events');
  });

  it('draws no conclusion about recorded bodies from a failed read', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[]}
        error={{ httpStatus: 403, reason: 'Forbidden', message: 'forbidden' }}
      />,
    );

    expect(container).toHaveTextContent('No conclusion about recorded response bodies');
    expect(container).not.toHaveTextContent('no body was withheld');
  });

  it('distinguishes a refused read from a broken server', () => {
    const forbidden = renderWithProviders(
      <ConfidentialityRedaction
        events={[]}
        error={{ httpStatus: 403, reason: 'Forbidden', message: 'forbidden' }}
      />,
    );
    expect(forbidden.container).toHaveTextContent('HTTP status 403');
    forbidden.unmount();

    const broken = renderWithProviders(
      <ConfidentialityRedaction
        events={[]}
        error={{ httpStatus: 500, reason: 'InternalError', message: 'boom' }}
      />,
    );
    expect(broken.container).toHaveTextContent('HTTP status 500');
  });

  it('names each event row by its audit identifier', () => {
    renderWithProviders(<ConfidentialityRedaction events={[SECRETS_EVENT]} />);

    expect(screen.getByRole('rowheader', { name: SECRETS_EVENT.auditID })).toBeInTheDocument();
  });

  it('renders no bare undefined or null text for an absent field', () => {
    const sparse = {
      ...SECRETS_EVENT,
      objectRef: { resource: 'secrets' },
      annotations: undefined,
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[sparse]} />);

    expect(text(container)).not.toContain('undefined');
    expect(container).toHaveTextContent('Not recorded');
  });
});
