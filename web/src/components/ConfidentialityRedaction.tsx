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

// AAP §0.5.1 (web/src/components/ConfidentialityRedaction.tsx row: "Presentation-layer
// mirror: a secrets audit event must never render a responseObject") / §0.4.2.4 (L6
// React tier, V6 mirror) / §0.10.2 (the confidentiality-guard row of the
// boundary-conditions table) / tech-spec §6.4.6.
//
// This component is the presentation-layer mirror of the confidentiality guard in
// test/integration/controlplane/audit/audit_test.go (TestAuditSensitiveResourceLevels
// @941; the guard itself at L1043-1047). Requirements locked: F-006-RQ-002
// (sensitive-resource audit event emission and level projection) and F-006-RQ-003
// (audit fidelity defaults).
//
// The React tier has NO parity ancestor: blitzy/documentation/Project Guide.md §4
// records that this is a control-plane/configuration project with "no UI surface", so
// nothing is ported here. The parity anchor is instead the wire contract this view
// renders -- the audit.k8s.io/v1 event shape modelled once in
// web/src/hooks/useAuditEvents.ts -- and the Go guard's own semantics, reproduced
// below assertion for assertion.
//
// Why the Go guard cannot be satisfied by the API tier alone: the audit level for the
// sensitive resource is Request and deliberately not RequestResponse, precisely so the
// API server's response body -- which would duplicate the object's payload plus
// server-populated fields -- is never written down. A view that re-rendered that body
// would defeat the control while every API-side test stayed green. That is the gap this
// component closes.

import { useId, useMemo, useState, type ReactElement } from 'react';

import {
  AUDIT_LEVEL_ORDER,
  AUTHORIZATION_DECISION_ANNOTATION,
  useAuditEvents,
  type AuditEvent,
  type AuditEventsError,
  type AuditLevel,
  type AuditPayload,
} from '../hooks/useAuditEvents';

/**
 * The plural resource name whose response bodies must never be rendered.
 *
 * This single literal is the whole key of the guard. The Go original compares
 * `e.Resource == "secrets"`, where `Resource` is projected from
 * `e.ObjectRef.Resource` under a nil check (test/utils/audit.go L144-147), which is
 * why {@link isSensitiveResourceEvent} reads `objectRef?.resource` and nothing else.
 *
 * Deliberately NOT qualified by namespace, verb, audit level, request URI or user. Any
 * such narrowing would be a weakened boundary condition: an event that reached
 * RequestResponse through an unexpected path is exactly the regression the guard exists
 * to catch, so the predicate must not presuppose the shape of the regression.
 */
export const SENSITIVE_AUDIT_RESOURCE = 'secrets';

/** Accessible name of the landmark region, and the text of its heading. */
export const CONFIDENTIALITY_REDACTION_TITLE = 'Audit event confidentiality';

/** Accessible name of the event table, supplied by its caption. */
export const CONFIDENTIALITY_REDACTION_TABLE_CAPTION =
  'Audit events with request and response body disclosure';

/** Visible text of a redaction affordance, and the stem of its accessible name. */
export const REDACTION_NOTICE_TEXT = 'Response body withheld';

/** The reason shown alongside every redaction affordance. */
export const REDACTION_REASON_TEXT =
  `The ${SENSITIVE_AUDIT_RESOURCE} resource is audited at the Request level, so a ` +
  'response body must never be recorded or displayed.';

/** Accessible name of the summary status region. */
export const REDACTION_SUMMARY_LABEL = 'Redaction summary';

/** Accessible name of the error affordance. */
export const REDACTION_ERROR_LABEL = 'Audit event error';

/** Accessible name of the pending affordance, and its visible text. */
export const REDACTION_LOADING_TEXT = 'Loading audit events';

/** Accessible name of the empty-state affordance. */
export const REDACTION_EMPTY_LABEL = 'No audit events';

/** Visible label of the resource filter control. */
export const RESOURCE_FILTER_LABEL = 'Filter by resource';

/** Visible label of the audit level filter control. */
export const LEVEL_FILTER_LABEL = 'Filter by audit level';

/** Accessible name and visible text of the refresh control. */
export const REFRESH_BUTTON_TEXT = 'Refresh audit events';

/**
 * Sentinel value and visible text of the "no narrowing" option in both filters.
 *
 * A distinctive sentinel rather than the empty string, so that a filter carrying no
 * selection can never be confused with a filter narrowed to an event whose resource or
 * level happens to be absent.
 */
export const FILTER_ALL_VALUE = '__all__';

/** Visible text of the "no narrowing" option in both filters. */
export const FILTER_ALL_TEXT = 'All';

/** Rendered in place of a metadata field the event does not carry. */
export const NOT_RECORDED_TEXT = 'Not recorded';

/** Rendered in place of a body the event does not carry. */
export const NO_BODY_RECORDED_TEXT = 'No body recorded';

/**
 * Rendered in place of a body that could not be serialized.
 *
 * Reachable only for a body that is NOT subject to redaction: a sensitive response
 * body never reaches the serializer at all (see {@link renderResponseBodyCell}).
 */
export const UNSERIALIZABLE_BODY_TEXT = 'Body could not be displayed';

/** Rendered when a filter is in effect and narrows the table to nothing. */
export const NO_MATCHING_EVENTS_TEXT = 'No audit events match the current filter.';

/** Accessible name of the group holding the filter controls. */
export const FILTER_GROUP_LABEL = 'Filters';

/**
 * Column headers of the event table, in render order.
 *
 * Exported so a spec can address columns by the same literals the component renders,
 * rather than duplicating strings that could drift -- the convention
 * web/src/hooks/useAuditEvents.ts already follows for its endpoint and query-parameter
 * names. Each header is a `<th scope="col">`, so each is reachable as a column header by
 * its accessible name.
 */
export const CONFIDENTIALITY_REDACTION_COLUMNS: readonly string[] = [
  'Audit event',
  'Level',
  'Verb',
  'Resource',
  'Namespace',
  'Object name',
  'Status code',
  'User',
  'Stage',
  'Authorization decision',
  'Request body',
  'Response body',
];

/**
 * Whether this event concerns the sensitive resource.
 *
 * Mirrors the left half of the Go guard's condition, `e.Resource == "secrets"`. Events
 * carrying no object reference at all -- non-resource requests, which
 * test/utils/audit.go L144 guards with `if e.ObjectRef != nil` -- are correctly not
 * sensitive, because they reference no object whose body could leak.
 *
 * @param event a single audit.k8s.io/v1 event, exactly as received
 * @returns `true` when the event's object reference names the sensitive resource
 */
export function isSensitiveResourceEvent(event: AuditEvent): boolean {
  return event.objectRef?.resource === SENSITIVE_AUDIT_RESOURCE;
}

/**
 * Whether a payload is a real, inspectable object rather than an absent one.
 *
 * The declared type already excludes `null`, but a server is free to send one, and a
 * JSON `null` would otherwise pass a bare `!== undefined` test and reach the serializer
 * as the string `"null"`. Guarding on both is defensive, not redundant.
 *
 * @param payload a request or response body from the wire, possibly absent
 * @returns `true` when the payload is present and can be inspected
 */
function isPresentPayload(payload: AuditPayload | undefined): payload is AuditPayload {
  return typeof payload === 'object' && Boolean(payload);
}

/**
 * Whether a body was RECORDED at all, whatever shape it arrived in.
 *
 * Deliberately weaker than {@link isPresentPayload}, and the difference is the whole
 * point of having both. The declared type says a body is an object, but the Go side
 * of this control does not agree: `test/utils/audit.go` L151-156 flattens
 * `ResponseObject` to a BOOLEAN for its struct comparison, and the Go guard at
 * audit_test.go L1044 then tests `e.Resource == "secrets" && e.ResponseObject` — a
 * boolean test. A payload that reaches this component in that flattened form, or as
 * any other non-object, is still a body the API server recorded.
 *
 * Reading only `isPresentPayload` for the guard would therefore UNDER-report: a
 * `responseObject: true` on a `secrets` event would render "No body recorded" and be
 * counted as nothing withheld, which is the summary asserting that no body existed
 * when one did. That is a quieter version of the same failure as rendering the body.
 *
 * `null` is excluded because a JSON `null` is the wire's way of saying there is no
 * object, and `undefined` because the field was absent.
 *
 * @param payload a request or response body from the wire, possibly absent
 * @returns `true` when the wire carried anything other than absence
 */
function isRecordedPayload(payload: AuditPayload | undefined): boolean {
  return payload !== undefined && payload !== null;
}

/**
 * Whether this event's response body must be withheld from the document.
 *
 * This is the whole guard, in one place, mirroring the Go condition
 * `e.Resource == "secrets" && e.ResponseObject` (audit_test.go L1044). It is applied to
 * `responseObject` ONLY -- never to `requestObject`, whose survival on a create or an
 * update is the explicitly accepted Request-over-RequestResponse trade-off recorded at
 * audit_test.go L1040-1042 and in AAP §0.10.2, not a defect.
 *
 * A `true` result is a finding, not a feature. Under a correctly configured control the
 * count of such events is zero, exactly as the Go guard requires; every `true` is one
 * `t.Errorf` the Go original would have raised. The component therefore reports the
 * count as a violation of the Request-level guard rather than as protection applied.
 *
 * @param event a single audit.k8s.io/v1 event, exactly as received
 * @returns `true` when the event names the sensitive resource AND carries a response body
 */
export function mustWithholdResponseBody(event: AuditEvent): boolean {
  return isSensitiveResourceEvent(event) && isRecordedPayload(event.responseObject);
}

/**
 * Serializes a body that is NOT subject to redaction, for display.
 *
 * Never invoked for a sensitive response body: {@link renderResponseBodyCell} decides
 * on the resource before a payload is ever handed over, so redaction cannot be defeated
 * by anything this function does.
 *
 * A cyclic or otherwise unserializable body is reported as such rather than allowed to
 * throw during render, because a body that cannot be displayed is a display problem and
 * must not become a blank screen over the other events.
 */
function serializePayload(payload: AuditPayload): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return UNSERIALIZABLE_BODY_TEXT;
  }
}

/**
 * Renders a metadata value, substituting an explicit phrase for an absent one.
 *
 * Guards the document against the strings "undefined" and "null" ever appearing as
 * content, and treats the empty string as absent, which is how the wire spells the core
 * API group and how an unnamed collection request spells its object name.
 */
function textOrNotRecorded(value: string | number | undefined): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : NOT_RECORDED_TEXT;
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return NOT_RECORDED_TEXT;
}

/** Selects the singular or plural form for a count, avoiding "1 events". */
function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Builds the summary sentence, which is the component's accumulated verdict.
 *
 * Three properties are load-bearing here:
 *
 * 1. `scanned` and `withheldTotal` are counted over EVERY supplied event, never over the
 *    filtered view. The Go guard iterates `missingReport.AllEvents`, documented at
 *    audit_test.go L1038-1039 as "a superset of expEvents", so narrowing the population
 *    would weaken the guard rather than merely change a number.
 * 2. When a filter currently hides some withheld bodies, the summary says so out loud.
 *    A filter must never be able to present the view as though no redaction were needed.
 * 3. A withheld body is reported as a violation of the Request-level guard, because that
 *    is what it is: the Go original raises one `t.Errorf` per such event.
 *
 * Nothing here is a pass verdict. The component reports what was scanned and what was
 * withheld; it never claims a control is healthy.
 */
function describeRedactionSummary(
  scanned: number,
  withheldTotal: number,
  withheldHidden: number,
): string {
  const sentences = [
    `Scanned ${scanned} audit ${plural(scanned, 'event', 'events')}.`,
  ];

  if (withheldTotal === 0) {
    sentences.push(
      `No event for the ${SENSITIVE_AUDIT_RESOURCE} resource carried a response body, ` +
        'so no body was withheld.',
    );
    return sentences.join(' ');
  }

  sentences.push(
    `Withheld ${withheldTotal} response ${plural(withheldTotal, 'body', 'bodies')} ` +
      `recorded against the ${SENSITIVE_AUDIT_RESOURCE} resource.`,
  );
  sentences.push(
    `Each withheld body is also a violation of the Request-level audit guard ` +
      `(F-006-RQ-002).`,
  );

  if (withheldHidden > 0) {
    sentences.push(
      `${withheldHidden} of ${plural(withheldHidden, 'them belongs', 'them belong')} to ` +
        'events hidden by the current filter and is counted here regardless.',
    );
  }

  return sentences.join(' ');
}

/**
 * Renders the request-body cell for one event.
 *
 * Applies NO redaction, for every resource including the sensitive one. This is
 * deliberate and must not be "tightened": audit_test.go L1040-1042 records that a
 * request object surviving on a create or an update is the explicitly accepted
 * Request-over-RequestResponse trade-off. Redacting it as well would make that
 * trade-off invisible and would leave the targeting of the response-body guard
 * unprovable, which is the same failure as not redacting at all.
 */
function renderRequestBodyCell(event: AuditEvent): ReactElement {
  if (!isRecordedPayload(event.requestObject)) {
    return <td>{NO_BODY_RECORDED_TEXT}</td>;
  }
  if (!isPresentPayload(event.requestObject)) {
    // Recorded, but not an inspectable object — the Go-flattened form, or any other
    // non-object. Its presence is reported and its content is not invented.
    return <td>{UNSERIALIZABLE_BODY_TEXT}</td>;
  }
  return (
    <td>
      <pre>{serializePayload(event.requestObject)}</pre>
    </td>
  );
}

/**
 * Renders the response-body cell for one event -- the guard itself.
 *
 * The resource is decided FIRST, and the sensitive branch never hands a payload to
 * {@link serializePayload}. That ordering is the structural guarantee: there is no code
 * path on which a sensitive response body is serialized, measured, hashed, truncated or
 * placed inside a collapsed disclosure element, so no byte derived from it can reach the
 * document. A collapsed `<details>` would still put those bytes in the document, which
 * is why the redaction affordance is plain text describing the withholding instead.
 *
 * The affordance carries `role="note"` with an accessible name that includes the audit
 * identifier, so every redaction is individually addressable and a second offender can
 * never hide behind the first -- the presentation-layer equivalent of the Go original's
 * `t.Errorf`, which records a finding and continues rather than aborting.
 */
function renderResponseBodyCell(event: AuditEvent): ReactElement {
  if (isSensitiveResourceEvent(event)) {
    // Presence is read with the WEAKER predicate on purpose: a flattened
    // `responseObject: true` is a recorded body under the Go guard's own boolean
    // test, so it must be withheld and counted rather than reported as absent.
    if (isRecordedPayload(event.responseObject)) {
      return (
        <td>
          <p
            role="note"
            aria-label={`${REDACTION_NOTICE_TEXT} for audit event ${event.auditID}`}
          >
            {`${REDACTION_NOTICE_TEXT}. ${REDACTION_REASON_TEXT}`}
          </p>
        </td>
      );
    }
    return <td>{NO_BODY_RECORDED_TEXT}</td>;
  }

  if (!isRecordedPayload(event.responseObject)) {
    return <td>{NO_BODY_RECORDED_TEXT}</td>;
  }
  if (!isPresentPayload(event.responseObject)) {
    return <td>{UNSERIALIZABLE_BODY_TEXT}</td>;
  }
  return (
    <td>
      <pre>{serializePayload(event.responseObject)}</pre>
    </td>
  );
}

/**
 * Describes a failed read without ever implying a healthy control.
 *
 * A refused or failed read is evidence of nothing about the audit configuration, so the
 * final sentence says exactly that. This is the presentation-layer half of the
 * invariant the hook documents on its own side: a refusal is never representable as a
 * result, and a 403 or a 500 must never render as "no response bodies were recorded".
 */
function describeFailure(failure: AuditEventsError): string {
  const parts = ['Audit events could not be read.'];

  parts.push(
    failure.httpStatus === 0
      ? 'No HTTP response was received.'
      : `HTTP status ${failure.httpStatus}.`,
  );

  if (typeof failure.reason === 'string' && failure.reason.length > 0) {
    parts.push(`Reason: ${failure.reason}.`);
  }
  if (typeof failure.message === 'string' && failure.message.length > 0) {
    parts.push(failure.message);
  }

  parts.push('No conclusion about recorded response bodies can be drawn from a failed read.');

  return parts.join(' ');
}

/**
 * Renders one event as a table row.
 *
 * The audit identifier is a row header, so every event is addressable by its own
 * accessible name and per-event assertions never have to rely on positional indexing.
 *
 * `index` participates in the React key because an audit identifier is stable across a
 * request's stages rather than unique per event, so two events legitimately share one.
 *
 * Every field is read defensively. A single malformed event must not throw during render,
 * because that would empty the whole table and silently stop the scan -- the exact
 * short-circuit the Go original avoids by recording a finding and continuing.
 */
function renderEventRow(event: AuditEvent, index: number): ReactElement {
  const objectRef = event.objectRef;
  const decision = event.annotations?.[AUTHORIZATION_DECISION_ANNOTATION];

  return (
    <tr key={`${event.auditID}::${index}`}>
      <th scope="row">{textOrNotRecorded(event.auditID)}</th>
      <td>{textOrNotRecorded(event.level)}</td>
      <td>{textOrNotRecorded(event.verb)}</td>
      <td>{textOrNotRecorded(objectRef?.resource)}</td>
      <td>{textOrNotRecorded(objectRef?.namespace)}</td>
      <td>{textOrNotRecorded(objectRef?.name)}</td>
      <td>{textOrNotRecorded(event.responseStatus?.code)}</td>
      <td>{textOrNotRecorded(event.user?.username)}</td>
      <td>{textOrNotRecorded(event.stage)}</td>
      <td>{textOrNotRecorded(decision)}</td>
      {renderRequestBodyCell(event)}
      {renderResponseBodyCell(event)}
    </tr>
  );
}

/**
 * Everything {@link ConfidentialityRedaction} accepts. Every field is optional.
 *
 * Supplying `events` puts the component in controlled mode, which is how a spec drives
 * it deterministically from recorded fixtures. Omitting `events` puts it in uncontrolled
 * mode, where it reads through {@link useAuditEvents}. It never calls `fetch` itself in
 * either mode.
 *
 * There is deliberately NO prop that disables, narrows or otherwise parameterises the
 * redaction, and deliberately no server-side query filter. Narrowing the query would
 * defeat the property the guard depends on -- the Go original inspects
 * `missingReport.AllEvents`, "a superset of expEvents" (audit_test.go L1038-1039), so
 * the population under inspection must stay as wide as what the server returned.
 */
export interface ConfidentialityRedactionProps {
  /**
   * The events to scan and render, in the order received. Presence of this prop selects
   * controlled mode; an empty array is a legitimate, distinct empty state.
   */
  events?: readonly AuditEvent[];
  /** Forces the pending state, for a caller that owns its own loading lifecycle. */
  isLoading?: boolean;
  /**
   * Forces the error state. `null` means "no override", deferring to the hook, which in
   * controlled mode reports no error because its query is disabled.
   */
  error?: AuditEventsError | null;
}

/**
 * Renders `audit.k8s.io/v1` audit events with their request and response bodies, and
 * withholds every response body recorded against the sensitive resource.
 *
 * Invariant locked (F-006-RQ-002, mirroring the guard at
 * test/integration/controlplane/audit/audit_test.go L1043-1047):
 *
 *   1. No audit event whose `objectRef.resource` is the sensitive resource may render a
 *      `responseObject`. Nothing derived from such a body reaches the document -- not the
 *      body, not a fragment of it, not its serialized length, not a hash of it, not a
 *      truncated prefix, and not a copy hidden inside a collapsed disclosure element.
 *   2. A `requestObject` on a create or an update still renders. That is the explicitly
 *      accepted Request-over-RequestResponse trade-off (audit_test.go L1040-1042), not a
 *      defect, and over-redacting it would be as wrong as under-redacting the response.
 *   3. A response body on any OTHER resource still renders. The guard is targeted, not
 *      blanket; blanket redaction would make its targeting unprovable.
 *   4. Every supplied event is scanned and rendered. The list is never truncated and the
 *      scan never stops at the first offender, so a second offender can never hide behind
 *      the first. This is the presentation-layer form of the Go original's `t.Errorf`,
 *      which records each finding and continues rather than aborting.
 *   5. The count of withheld bodies is computed over the whole event set, before any
 *      filter is applied, so narrowing the view can never present the component as though
 *      no redaction were needed.
 *
 * The component reports evidence, never a verdict: it says what it scanned and what it
 * withheld, and on a failed read it says explicitly that no conclusion can be drawn.
 *
 * @example
 * ```tsx
 * // Controlled: driven from recorded fixtures.
 * <ConfidentialityRedaction events={recordedAuditEvents} />
 * // Uncontrolled: reads through useAuditEvents.
 * <ConfidentialityRedaction />
 * ```
 */
export default function ConfidentialityRedaction({
  events: providedEvents,
  isLoading: providedIsLoading,
  error: providedError,
}: ConfidentialityRedactionProps = {}): ReactElement {
  // Controlled mode is selected by the presence of the prop, not by its length, so an
  // empty array stays a caller-supplied empty result rather than triggering a fetch.
  const controlled = providedEvents !== undefined;

  // The hook is called unconditionally, as the rules of hooks require. `enabled: false`
  // keeps its query idle and issues no request at all in controlled mode.
  const query = useAuditEvents({ enabled: !controlled });

  const [resourceFilter, setResourceFilter] = useState<string>(FILTER_ALL_VALUE);
  const [levelFilter, setLevelFilter] = useState<string>(FILTER_ALL_VALUE);

  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const resourceFilterId = `${baseId}-resource-filter`;
  const levelFilterId = `${baseId}-level-filter`;

  const events: readonly AuditEvent[] = providedEvents ?? query.events;

  // Counted over EVERY supplied event, deliberately before any filter narrows the view.
  const withheldTotal = useMemo(
    () =>
      events.reduce((total, event) => (mustWithholdResponseBody(event) ? total + 1 : total), 0),
    [events],
  );

  // Filter vocabularies are derived from the data, so an option can never offer a value
  // that matches nothing. Levels follow AUDIT_LEVEL_ORDER, whose index order is the
  // documented strict ordering None < Metadata < Request < RequestResponse.
  const resourceOptions = useMemo(() => {
    const present = new Set<string>();
    for (const event of events) {
      const resource = event.objectRef?.resource;
      if (typeof resource === 'string' && resource.length > 0) {
        present.add(resource);
      }
    }
    return Array.from(present).sort((left, right) => left.localeCompare(right));
  }, [events]);

  const levelOptions = useMemo(() => {
    const present = new Set<AuditLevel>();
    for (const event of events) {
      present.add(event.level);
    }
    return AUDIT_LEVEL_ORDER.filter((level) => present.has(level));
  }, [events]);

  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          (resourceFilter === FILTER_ALL_VALUE ||
            event.objectRef?.resource === resourceFilter) &&
          (levelFilter === FILTER_ALL_VALUE || event.level === levelFilter),
      ),
    [events, resourceFilter, levelFilter],
  );

  const withheldVisible = useMemo(
    () =>
      visibleEvents.reduce(
        (total, event) => (mustWithholdResponseBody(event) ? total + 1 : total),
        0,
      ),
    [visibleEvents],
  );

  // How many withheld bodies the current filter is hiding. The summary reports this so a
  // narrowed view can never read as "no redactions needed".
  const withheldHidden = withheldTotal - withheldVisible;

  const failure: AuditEventsError | null = providedError ?? query.error;

  // 'idle' counts as pending: a query that has not run yet is not evidence of an empty
  // result, and must not flash an empty state before the first response arrives.
  const pending =
    providedIsLoading === true ||
    (!controlled && (query.status === 'loading' || query.status === 'idle'));

  // State precedence: failure > pending > empty > populated. Failure wins outright so
  // that a refused read can never be masked by a concurrent refresh.
  let body: ReactElement;

  if (failure !== null) {
    body = (
      <>
        <p role="alert" aria-label={REDACTION_ERROR_LABEL}>
          {describeFailure(failure)}
        </p>
        {controlled ? null : (
          <button type="button" onClick={query.refresh}>
            {REFRESH_BUTTON_TEXT}
          </button>
        )}
      </>
    );
  } else if (pending) {
    body = (
      <p role="status" aria-label={REDACTION_LOADING_TEXT}>
        {REDACTION_LOADING_TEXT}
      </p>
    );
  } else if (events.length === 0) {
    body = (
      <p role="status" aria-label={REDACTION_EMPTY_LABEL}>
        No audit events were returned, so no response body was inspected.
      </p>
    );
  } else {
    body = (
      <>
        <p role="status" aria-label={REDACTION_SUMMARY_LABEL}>
          {describeRedactionSummary(events.length, withheldTotal, withheldHidden)}
        </p>

        <fieldset>
          <legend>{FILTER_GROUP_LABEL}</legend>

          <label htmlFor={resourceFilterId}>{RESOURCE_FILTER_LABEL}</label>
          <select
            id={resourceFilterId}
            value={resourceFilter}
            onChange={(changeEvent) => setResourceFilter(changeEvent.target.value)}
          >
            <option value={FILTER_ALL_VALUE}>{FILTER_ALL_TEXT}</option>
            {resourceOptions.map((resource) => (
              <option key={resource} value={resource}>
                {resource}
              </option>
            ))}
          </select>

          <label htmlFor={levelFilterId}>{LEVEL_FILTER_LABEL}</label>
          <select
            id={levelFilterId}
            value={levelFilter}
            onChange={(changeEvent) => setLevelFilter(changeEvent.target.value)}
          >
            <option value={FILTER_ALL_VALUE}>{FILTER_ALL_TEXT}</option>
            {levelOptions.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>

          {controlled ? null : (
            <button type="button" onClick={query.refresh}>
              {REFRESH_BUTTON_TEXT}
            </button>
          )}
        </fieldset>

        <table>
          <caption>{CONFIDENTIALITY_REDACTION_TABLE_CAPTION}</caption>
          <thead>
            <tr>
              {CONFIDENTIALITY_REDACTION_COLUMNS.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleEvents.length === 0 ? (
              <tr>
                <td colSpan={CONFIDENTIALITY_REDACTION_COLUMNS.length}>
                  {NO_MATCHING_EVENTS_TEXT}
                </td>
              </tr>
            ) : (
              visibleEvents.map((event, index) => renderEventRow(event, index))
            )}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{CONFIDENTIALITY_REDACTION_TITLE}</h2>
      {body}
    </section>
  );
}
