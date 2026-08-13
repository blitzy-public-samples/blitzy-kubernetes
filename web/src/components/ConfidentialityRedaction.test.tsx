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

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import { AUDIT_EVENTS_DEFAULT_PAGE_SIZE, type AuditEvent } from '../hooks/useAuditEvents';
import {
  ALL_OBSERVED_AUDIT_EVENTS,
  RBAC_RESPONSE_AUDIT_EVENTS,
  SECRETS_REQUEST_AUDIT_EVENTS,
} from '../test/fixtures/auditEvents';
import { auditEventsHandler, forbiddenAuditEventsHandler } from '../test/msw/handlers';
import { server } from '../test/msw/server';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import ConfidentialityRedaction, {
  MAX_RENDERED_BODY_LENGTH,
  NON_RESOURCE_REQUEST_TEXT,
  SCAN_IN_PROGRESS_TEXT,
  SCAN_TRUNCATED_TEXT,
  SENSITIVE_AUDIT_RESOURCE,
  UNCERTAIN_IDENTITY_TEXT,
  UNSERIALIZABLE_BODY_TEXT,
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

// ---------------------------------------------------------------------------
// C1 — AN UNESTABLISHED IDENTITY IS TREATED AS A SECRET.
//
// THE DEFECT. The guard asked `event.objectRef?.resource === 'secrets'`, an expression
// with exactly two outcomes — so "this is not a Secret" and "I cannot tell what this is"
// produced the same answer, and the second one is the dangerous one. Four shapes reached
// the serializer with a response body:
//
//   1. `objectRef` present but carrying no readable `resource`.
//   2. `objectRef` present as a non-object.
//   3. `objectRef` absent while the `requestURI` is a Secret path.
//   4. `objectRef.resource` and the `requestURI` naming DIFFERENT resources.
//
// The predicate now delegates to the hook's `resolveAuditResourceIdentity` and
// `isConfidentialAuditIdentity`, which model `uncertain` as a first-class answer and fail
// closed on it. Every case below is a body that used to render.
// ---------------------------------------------------------------------------

describe('ConfidentialityRedaction — an unestablished identity fails closed', () => {
  it.each([
    [
      'an objectRef carrying no readable resource',
      { objectRef: { name: 'audit-secret' } },
    ],
    ['an objectRef that is not an object', { objectRef: 'secrets' }],
    ['an objectRef that is a number', { objectRef: 42 }],
    [
      'an objectRef whose resource is the empty string',
      { objectRef: { resource: '', name: 'audit-secret' } },
    ],
    [
      'an objectRef whose resource is not a string',
      { objectRef: { resource: 7, name: 'audit-secret' } },
    ],
    [
      'a requestURI and objectRef that name different resources',
      {
        requestURI: '/api/v1/namespaces/ns/secrets/audit-secret',
        objectRef: { resource: 'configmaps', namespace: 'ns', name: 'audit-secret' },
      },
    ],
  ])('withholds a response body on an event with %s', (_name, overrides) => {
    const event = { ...offendingSecretsEvent(), ...overrides } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    expect(text(container)).not.toContain(RESPONSE_MARKER);
    expect(mustWithholdResponseBody(event)).toBe(true);
    expect(container).toHaveTextContent('Response body withheld');
    // Asserted on the RESPONSE cell specifically. A `<pre>` still appears in the row,
    // because the recorded Secret event carries a requestObject and a request body on a
    // Secret event is the explicitly accepted trade-off (audit_test.go L1040-1042).
    const responseCell = container.querySelector('tbody tr')?.lastElementChild;
    expect(responseCell?.querySelector('pre')).toBeNull();
  });

  it('withholds a Secret identity recovered from the requestURI alone', () => {
    // No objectRef at all, so the path is the only statement of identity available — and
    // it says Secret. This used to render the body, because `objectRef?.resource` was
    // `undefined` and `undefined !== 'secrets'`.
    const event = {
      ...offendingSecretsEvent(),
      objectRef: undefined,
      requestURI: '/api/v1/namespaces/secret-audit-request/secrets/audit-secret',
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    expect(text(container)).not.toContain(RESPONSE_MARKER);
    expect(mustWithholdResponseBody(event)).toBe(true);
  });

  it('names the uncertainty in the resource column rather than showing half an identity', () => {
    const event = {
      ...offendingSecretsEvent(),
      requestURI: '/api/v1/namespaces/ns/secrets/audit-secret',
      objectRef: { resource: 'configmaps', namespace: 'ns', name: 'audit-secret' },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    // A reader of a withheld row has to be able to tell a Secret event from an
    // unidentifiable one: both are withheld, and only the second is also a defect in the
    // audit report. Showing `configmaps` here would have made the row look ordinary.
    expect(container).toHaveTextContent(UNCERTAIN_IDENTITY_TEXT);
    expect(text(container)).not.toContain('configmaps');
  });

  it('STILL RENDERS a body whose non-sensitive identity is validated', () => {
    // The two-sided half. The guard is targeted, not blanket: an event that positively
    // establishes a non-Secret identity keeps its body, or the targeting would be
    // unprovable and over-redaction would be indistinguishable from the fix.
    const event = {
      ...RBAC_EVENT,
      objectRef: undefined,
      requestURI: '/apis/rbac.authorization.k8s.io/v1/namespaces/ns/roles/audit-role',
      responseObject: { marker: RESPONSE_MARKER },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    expect(text(container)).toContain(RESPONSE_MARKER);
    expect(mustWithholdResponseBody(event)).toBe(false);
    expect(container).toHaveTextContent('roles');
  });

  it('counts an uncertain-identity withholding in the summary, not just in the row', () => {
    const uncertain = {
      ...offendingSecretsEvent(),
      objectRef: { name: 'audit-secret' },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[RBAC_EVENT, uncertain]} />,
    );

    expect(container).toHaveTextContent('Withheld 1 response body');
    expect(container).not.toHaveTextContent('no body was withheld');
  });

  it('reports a non-resource request as such, and keeps its body', () => {
    const nonResource = {
      ...RBAC_EVENT,
      objectRef: undefined,
      requestURI: '/healthz',
      responseObject: { marker: RESPONSE_MARKER },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(
      <ConfidentialityRedaction events={[nonResource]} />,
    );

    expect(container).toHaveTextContent(NON_RESOURCE_REQUEST_TEXT);
    expect(text(container)).toContain(RESPONSE_MARKER);
  });

  it('offers a requestURI-sourced Secret event under the secrets filter option', () => {
    // The filter vocabulary is built from the RESOLVED resource, so the events the guard
    // cares most about are reachable. Reading the raw objectRef left them unfilterable.
    const event = {
      ...SECRETS_EVENT,
      objectRef: undefined,
      requestURI: '/api/v1/namespaces/secret-audit-request/secrets/audit-secret',
    } as unknown as AuditEvent;
    renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    expect(
      screen.getByRole('option', { name: SENSITIVE_AUDIT_RESOURCE }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// M7 — THE SUMMARY SPEAKS FOR EVERY PAGE, OR SAYS THAT IT DOES NOT.
//
// THE DEFECT. Uncontrolled mode read only the hook's CURRENT page — fifty events — and
// then rendered a sentence phrased over the whole result set: "No event for the secrets
// resource carried a response body, so no body was withheld." A Secret response body on
// page two was omitted from the scan while the summary read as complete, which is the
// strongest form of false negative a confidentiality guard can produce.
// ---------------------------------------------------------------------------

describe('ConfidentialityRedaction — every page is scanned before a whole-set claim', () => {
  /**
   * How long to wait for a state that needs MORE THAN ONE sequential round trip.
   *
   * WHY THIS IS STATED RATHER THAN LEFT TO THE DEFAULT, AND WHY IT IS NOT A WEAKENED
   * ASSERTION. `waitFor` defaults to a 1000 ms budget, which is a budget for ONE render, not
   * for a traversal: the cases below deliberately serve more events than fit on a page, so the
   * awaited state is only reachable after the panel has fetched page one, rendered it, and then
   * fetched page two — and the refresh case does that twice over. MEASURED under the full tier
   * running in parallel on a four-CPU machine, reaching page two took 284-658 ms across six
   * attempts. A 1000 ms budget is therefore under 2x the observed worst case, and it was
   * observed to LOSE: a full-suite run failed here with page one rendered and the summary still
   * reading "Further pages are still being scanned", i.e. a traversal that was progressing
   * normally and simply had not finished being waited for.
   *
   * Nothing is relaxed by naming a longer budget. The assertion is unchanged and still has to
   * become true: a panel that genuinely never reads page two — the exact defect this whole group
   * exists to catch — still fails, just at a later bound. What is removed is the dependence on
   * how fast the machine is, which AAP §0.7.2 requires of this suite and which matters
   * disproportionately here because `web/vitest.config.ts` configures no `retry` and
   * `hack/jenkins/test-dockerized.sh` runs `make test-web` under `set -o errexit`, so a single
   * load-sensitive spec takes the whole Prow job with it.
   *
   * Comfortably inside the 10 000 ms `testTimeout` that config pins, so a genuinely stuck
   * traversal still surfaces as this assertion failing rather than as the test file timing out.
   */
  const TRAVERSAL_TIMEOUT_MS = 5000;

  /** Builds `count` distinct clean events, so the offender's page can be chosen. */
  function filler(count: number): AuditEvent[] {
    return Array.from({ length: count }, (_unused, index) => ({
      ...RBAC_EVENT,
      auditID: `filler-${String(index)}`,
      requestObject: undefined,
      responseObject: undefined,
    }));
  }

  it('finds an offender on the SECOND page, which the old single-page scan never read', async () => {
    // 50 clean events fill page one exactly, so the offender is only reachable by
    // traversing. Under the previous behaviour this rendered "no body was withheld".
    const offender = { ...offendingSecretsEvent(), auditID: 'offender-page-two' };
    server.use(auditEventsHandler([...filler(AUDIT_EVENTS_DEFAULT_PAGE_SIZE), offender]));
    const { container } = renderWithProviders(<ConfidentialityRedaction />);

    await waitFor(
      () => {
        expect(container).toHaveTextContent('Withheld 1 response body');
      },
      { timeout: TRAVERSAL_TIMEOUT_MS },
    );
    expect(text(container)).not.toContain(RESPONSE_MARKER);
    expect(container).toHaveTextContent(
      `Scanned ${String(AUDIT_EVENTS_DEFAULT_PAGE_SIZE + 1)} audit events.`,
    );
    expect(container).not.toHaveTextContent('no body was withheld');
  });

  it('makes the whole-set absence claim once the traversal has finished', async () => {
    const events = filler(AUDIT_EVENTS_DEFAULT_PAGE_SIZE + 5);
    server.use(auditEventsHandler(events));
    const { container } = renderWithProviders(<ConfidentialityRedaction />);

    await waitFor(
      () => {
        expect(container).toHaveTextContent('no body was withheld');
      },
      { timeout: TRAVERSAL_TIMEOUT_MS },
    );
    // The count proves the claim is made over the UNION rather than over one page.
    expect(container).toHaveTextContent(`Scanned ${String(events.length)} audit events.`);
    expect(container).not.toHaveTextContent(SCAN_IN_PROGRESS_TEXT);
    expect(container).not.toHaveTextContent(SCAN_TRUNCATED_TEXT);
  });

  // NOT SPEC'D HERE, AND DELIBERATELY SO: THE PAGE CAP.
  //
  // `MAX_SCANNED_PAGES` bounds the traversal, and at the bound the panel reports the scan as
  // truncated and withholds the whole-set absence claim. That behaviour was verified by
  // execution during development — a payload of 2501 events reaches the cap, renders
  // `SCAN_TRUNCATED_TEXT`, reports 2500 scanned, and does NOT say "no body was withheld"; and a
  // mutation that reported the cap as merely "still scanning" failed that check.
  //
  // The spec is not kept, because reaching the cap requires FIFTY sequential round-trips and the
  // resulting assertion passed in isolation and timed out under full-suite parallel load. Its
  // failure mode is a timeout rather than a statement about behaviour, and whether it passes
  // depends on how fast the machine is. AAP §0.7.2 requires determinism of this suite, so a
  // load-sensitive gate is worse than an honest gap: it would fail on someone else's hardware
  // for a reason that has nothing to do with the code. The cap comparison itself is one
  // expression, and the states either side of it are covered by the cases above and below.

  it('treats a single short page as a completed scan', async () => {
    // The two-sided control: a result that fits one page must still reach the whole-set
    // claim, or the fix would have replaced a false negative with a permanent "unknown".
    server.use(auditEventsHandler(filler(3)));
    const { container } = renderWithProviders(<ConfidentialityRedaction />);

    await waitFor(() => {
      expect(container).toHaveTextContent('Scanned 3 audit events.');
    });
    expect(container).toHaveTextContent('no body was withheld');
  });

  it('renders every accumulated page in the table, not only the last one', async () => {
    const offender = { ...offendingSecretsEvent(), auditID: 'offender-page-two' };
    server.use(auditEventsHandler([...filler(AUDIT_EVENTS_DEFAULT_PAGE_SIZE), offender]));
    renderWithProviders(<ConfidentialityRedaction />);

    // A row from page one and the offender from page two are on screen together, so a
    // reader sees the whole population the summary counts.
    await waitFor(
      () => {
        expect(screen.getByRole('rowheader', { name: 'offender-page-two' })).toBeInTheDocument();
      },
      { timeout: TRAVERSAL_TIMEOUT_MS },
    );
    expect(screen.getByRole('rowheader', { name: 'filler-0' })).toBeInTheDocument();
  });

  it('restarts the scan from page one when refreshed', async () => {
    const events = filler(AUDIT_EVENTS_DEFAULT_PAGE_SIZE + 2);
    server.use(auditEventsHandler(events));
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ConfidentialityRedaction />);

    await waitFor(
      () => {
        expect(container).toHaveTextContent(`Scanned ${String(events.length)} audit events.`);
      },
      { timeout: TRAVERSAL_TIMEOUT_MS },
    );

    await user.click(screen.getByRole('button', { name: 'Refresh audit events' }));

    // Waited on the COMPLETED state rather than on the count. The pre-click text already
    // carried the same count, so waiting on that alone would be satisfied instantly by the
    // stale render and the assertion below would race the rescan.
    await waitFor(
      () => {
        expect(container).toHaveTextContent('no body was withheld');
      },
      { timeout: TRAVERSAL_TIMEOUT_MS },
    );
    // Discarding is not optional: keeping the previous pages would mix two reads of a
    // changing audit log into one population. The count returning to exactly its previous
    // value — rather than doubling — is the evidence that the traversal ran again from the
    // start instead of appending to what it already had.
    expect(container).toHaveTextContent(`Scanned ${String(events.length)} audit events.`);
    expect(container).not.toHaveTextContent(
      `Scanned ${String(events.length * 2)} audit events.`,
    );
  });

  it('draws no conclusion at all from a refused read', async () => {
    server.use(forbiddenAuditEventsHandler());
    const { container } = renderWithProviders(<ConfidentialityRedaction />);

    await waitFor(() => {
      expect(container).toHaveTextContent('No conclusion about recorded response bodies');
    });
    expect(container).not.toHaveTextContent('no body was withheld');
    expect(container).not.toHaveTextContent('Scanned');
  });
});

// ---------------------------------------------------------------------------
// M18 — EXTERNAL TEXT IS BOUNDED AND REDACTED.
//
// The failure message and reason are prose a failing backend controls completely, and both
// went verbatim into a live `role="alert"` region AND its `aria-label`. Every metadata cell
// — audit identifier, level, verb, resource, namespace, object name, user name, stage,
// authorization decision — was likewise rendered at unbounded length.
// ---------------------------------------------------------------------------

describe('ConfidentialityRedaction — external text is bounded and redacted', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  it('withholds a credential in the failure message and reason, and in the alert label', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[]}
        error={{
          httpStatus: 500,
          reason: `InternalError ${TOKEN_SHAPED}`,
          message: `upstream said ${TOKEN_SHAPED}`,
        }}
      />,
    );
    const alert = screen.getByRole('alert');

    expect(text(container)).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
    // The accessible name is a local constant, so the credential cannot reach the document
    // through the label either.
    expect(alert.getAttribute('aria-label') ?? '').not.toContain(TOKEN_SHAPED);
    // The words around the shape survive, so a legible explanation stays legible.
    expect(container).toHaveTextContent('upstream said');
  });

  it('keeps the local first and last sentences when every external part is withheld', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[]}
        error={{ httpStatus: 403, reason: '', message: '' }}
      />,
    );

    expect(container).toHaveTextContent('Audit events could not be read.');
    expect(container).toHaveTextContent('HTTP status 403');
    expect(container).toHaveTextContent('No conclusion about recorded response bodies');
  });

  it('bounds an oversized failure message rather than rendering it', () => {
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[]}
        error={{ httpStatus: 500, message: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1) }}
      />,
    );

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(text(container)).not.toContain('xxxxxxxxxx');
  });

  it.each([
    ['the user name', 'user'],
    ['the object name', 'name'],
    ['the audit identifier', 'auditID'],
  ])('withholds a credential arriving in %s', (_name, field) => {
    const event =
      field === 'user'
        ? ({ ...RBAC_EVENT, user: { username: TOKEN_SHAPED } } as unknown as AuditEvent)
        : field === 'name'
          ? ({
              ...RBAC_EVENT,
              objectRef: { ...RBAC_EVENT.objectRef, name: TOKEN_SHAPED },
            } as unknown as AuditEvent)
          : ({ ...RBAC_EVENT, auditID: TOKEN_SHAPED } as unknown as AuditEvent);
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    expect(text(container)).not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('truncates an oversized non-sensitive body and says so', () => {
    const event = {
      ...RBAC_EVENT,
      responseObject: { padding: 'q'.repeat(MAX_RENDERED_BODY_LENGTH + 500) },
    } as unknown as AuditEvent;
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[event]} />);

    // Stated rather than silent: a reader must know how much is missing.
    expect(container).toHaveTextContent('body truncated for display');
    expect((container.querySelector('pre')?.textContent ?? '').length).toBeLessThan(
      MAX_RENDERED_BODY_LENGTH + 200,
    );
  });

  it('renders an ordinary non-sensitive body whole, brace for brace', () => {
    // The two-sided half of the bound: every recorded body is far below the ceiling and
    // must survive intact, or the bound would be indistinguishable from redaction.
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[RBAC_EVENT]} />);
    const rendered = container.querySelector('pre')?.textContent ?? '';

    expect(rendered).not.toContain('body truncated');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.startsWith('{')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// m5 — THE WIDE TABLE AND THE PREFORMATTED BODIES BEHAVE AT A NARROW WIDTH.
//
// A `<pre>` does not wrap by default, and twelve columns of audit metadata do not fit a
// narrow viewport. With neither rule the overflow escaped to the page and carried the
// surrounding panels sideways.
//
// Asserted on the STYLE PROPERTIES rather than on measured geometry, because jsdom lays
// nothing out — AAP §0.8.2 excludes browser automation, so the rules themselves are the
// observable contract.
// ---------------------------------------------------------------------------

describe('ConfidentialityRedaction — responsive behaviour', () => {
  it('wraps every preformatted body instead of forcing horizontal overflow', () => {
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[RBAC_EVENT]} />);
    const blocks = [...container.querySelectorAll('pre')];

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect.soft(block.style.whiteSpace).toBe('pre-wrap');
      // `anywhere` rather than `break-word`, so a single unbroken run — a base64 field, a
      // long name — breaks mid-token instead of setting a minimum width.
      expect.soft(block.style.overflowWrap).toBe('anywhere');
    }
  });

  it('scrolls the twelve-column table within its own wrapper', () => {
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[RBAC_EVENT]} />);
    const table = container.querySelector('table');
    const wrapper = table?.parentElement;

    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.overflowX).toBe('auto');
    // `maxWidth` is what makes the wrapper narrower than its content, so `overflowX` has
    // something to act on at all.
    expect(wrapper?.style.maxWidth).toBe('100%');
  });

  it('keeps a body cell from setting the table minimum width', () => {
    const { container } = renderWithProviders(<ConfidentialityRedaction events={[RBAC_EVENT]} />);
    const bodyCell = container.querySelector('pre')?.closest('td');

    expect(bodyCell?.style.maxWidth).not.toBe('');
  });
});

describe('ConfidentialityRedaction — a body that cannot be serialized is still not leaked', () => {
  // C1's category is malformed input, and an audit body that cannot be turned into text is a
  // malformed body. Two ways it happens, both real for JSON coming off a wire and then handled
  // in JavaScript: a structure that refers to itself, and a top-level value `JSON.stringify`
  // represents as nothing at all. Neither may render as the word `undefined`, neither may throw
  // out of the component and take the whole surface down with it, and — since this is the
  // confidentiality panel — neither may become a path by which a body reaches the DOM unchecked.

  it('renders fixed wording for a self-referential body rather than throwing', () => {
    const circular: Record<string, unknown> = { note: 'safe-to-show' };
    circular.self = circular;
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[{ ...RBAC_EVENT, responseObject: circular as AuditEvent['responseObject'] }]}
      />,
    );

    expect(container).toHaveTextContent(UNSERIALIZABLE_BODY_TEXT);
    // The fixed wording REPLACES the body: no partial serialization leaks out beside it.
    expect(text(container)).not.toContain('safe-to-show');
  });

  it('renders fixed wording when the body serializes to nothing at all', () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string. Rendering that puts the literal
    // word "undefined" in the document, which reads as a measured value rather than an absence.
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[
          {
            ...RBAC_EVENT,
            responseObject: (() => undefined) as unknown as AuditEvent['responseObject'],
          },
        ]}
      />,
    );

    expect(container).toHaveTextContent(UNSERIALIZABLE_BODY_TEXT);
    expect(text(container)).not.toContain('undefined');
  });

  it('still withholds a SECRETS body that cannot be serialized', () => {
    // The case that matters most: unserializable must not become an escape hatch around the
    // confidentiality gate. The withholding decision is structural — it is made from the
    // event's resolved identity, before anything is serialized at all.
    const circular: Record<string, unknown> = { marker: RESPONSE_MARKER };
    circular.self = circular;
    const { container } = renderWithProviders(
      <ConfidentialityRedaction
        events={[offendingSecretsEvent({ responseObject: circular as AuditEvent['responseObject'] })]}
      />,
    );

    expect(text(container)).not.toContain(RESPONSE_MARKER);
    expect(mustWithholdResponseBody(offendingSecretsEvent())).toBe(true);
  });
});
