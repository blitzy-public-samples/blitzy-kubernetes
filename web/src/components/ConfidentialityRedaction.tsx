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

import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import {
  AUDIT_LEVEL_ORDER,
  AUTHORIZATION_DECISION_ANNOTATION,
  isConfidentialAuditIdentity,
  resolveAuditResourceIdentity,
  useAuditEvents,
  type AuditEvent,
  type AuditEventsError,
  type AuditEventsErrorKind,
  type AuditLevel,
  type AuditPayload,
  type AuditResourceIdentity,
} from '../hooks/useAuditEvents';
import {
  describeStatusReason,
  safeObservationValue,
  safeProse,
} from '../domain/safeText';

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

/**
 * Longest serialized body rendered in full.
 *
 * A bound rather than no bound (M18): a body belonging to a resource the guard does not
 * withhold is still arbitrary server data, and an unbounded one is both a rendering
 * hazard and — on a resource nobody anticipated carrying secrets — a disclosure hazard.
 * Generous enough that every recorded fixture body renders whole, so the bound cannot be
 * mistaken for the redaction it is not.
 */
export const MAX_RENDERED_BODY_LENGTH = 4096;

/** States a truncation rather than performing it silently, naming the full byte count. */
export const TRUNCATED_BODY_NOTICE = (length: number): string =>
  `[body truncated for display at ${String(MAX_RENDERED_BODY_LENGTH)} of ${String(
    length,
  )} characters]`;

/**
 * m5 — the wrap rules for a preformatted body.
 *
 * A `<pre>` does not wrap by default, so one long serialized line pushed the whole table
 * horizontally and took every other column off screen. `pre-wrap` keeps the JSON's
 * significant newlines while allowing soft wrapping; `anywhere` lets an unbroken run break
 * mid-token instead of setting a minimum width nothing can shrink below.
 */
const PRE_STYLE = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  margin: 0,
} as const;

/** m5 — keeps a body cell from being the column that sets the table's minimum width. */
const CELL_STYLE = { maxWidth: '24rem' } as const;

/**
 * m5 — the twelve-column table scrolls WITHIN its own wrapper.
 *
 * Twelve columns of audit metadata do not fit a narrow viewport, and without this the
 * overflow escaped to the page and took the surrounding panels with it. Scoping the scroll
 * to the wrapper keeps the table addressable at any width and leaves the rest of the
 * document where it is. `maxWidth: 100%` is what makes the wrapper narrower than its
 * content in the first place, so `overflowX` has something to act on.
 */
const TABLE_WRAPPER_STYLE = { overflowX: 'auto', maxWidth: '100%' } as const;

/** Rendered when a filter is in effect and narrows the table to nothing. */
export const NO_MATCHING_EVENTS_TEXT = 'No audit events match the current filter.';

/**
 * Ceiling on how many pages one scan traverses (M7).
 *
 * A bound is required rather than optional: `hasNextPage` is resolved partly from a
 * server-supplied `hasMore`, so a server that always reports a further page would
 * otherwise drive an unbounded sequence of requests. Hitting the ceiling is REPORTED
 * rather than hidden — the scan then yields a truncated view and explicitly declines to
 * draw a whole-set conclusion, which is the honest answer and the safe one.
 */
export const MAX_SCANNED_PAGES = 50;

/**
 * How much of the result set this scan covers.
 *
 * THE POINT OF THIS TYPE (M7). The component used to read only the hook's CURRENT page —
 * fifty events — and then render a summary sentence phrased over the whole result set:
 * "No event for the secrets resource carried a response body, so no body was withheld."
 * A Secret response body on page two was therefore omitted from the scan while the
 * summary read as complete, which is the strongest possible form of a false negative for
 * a confidentiality guard. Distinguishing the three states is what makes a page-local
 * view say that it is page-local.
 */
export type ScanCompleteness = 'scanning' | 'complete' | 'truncated';

/** Said when the traversal has not finished, so no whole-set conclusion is available. */
export const SCAN_IN_PROGRESS_TEXT =
  'Further pages are still being scanned, so this is a partial view and no conclusion ' +
  'about the whole result set can be drawn yet.';

/** Said when the page ceiling stopped the traversal with pages still outstanding. */
export const SCAN_TRUNCATED_TEXT =
  `The scan stopped after ${String(MAX_SCANNED_PAGES)} pages with further pages still ` +
  'available, so this is a partial view and no conclusion about the whole result set can ' +
  'be drawn.';

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
 * Rendered in the resource column of an event whose identity cannot be established.
 *
 * A distinct phrase rather than {@link NOT_RECORDED_TEXT}, because "the event named no
 * resource" and "the event named something unreadable" are different facts and only the
 * second one is a defect in the report.
 */
export const UNCERTAIN_IDENTITY_TEXT = 'Identity could not be established';

/** Rendered in the resource column of a non-resource request. */
export const NON_RESOURCE_REQUEST_TEXT = 'Non-resource request';

/**
 * Whether this event must be treated as concerning the sensitive resource.
 *
 * WHAT CHANGED, AND WHY IT IS THE WHOLE OF THIS GUARD. The predicate used to be
 * `event.objectRef?.resource === SENSITIVE_AUDIT_RESOURCE` — an expression with exactly
 * two outcomes, which is one too few. "This is not a Secret" and "I cannot tell what
 * this is" both produced `false`, and the second one is the dangerous answer:
 *
 *   * `objectRef: { name: 's' }` — present, but carrying no readable `resource`. Something
 *     was referenced and the reference is unreadable, so it might be a Secret.
 *   * `objectRef: 'secrets'` or any other non-object. Same.
 *   * `requestURI: '/api/v1/namespaces/ns/secrets/s'` with `objectRef` ABSENT. The path is
 *     the only statement of identity available, and it says Secret.
 *   * `requestURI: '.../secrets/s'` paired with `objectRef.resource: 'configmaps'`. Two
 *     statements that disagree; believing the objectRef is exactly how a crafted event
 *     would carry a Secret body past the guard.
 *
 * Every one of those four rendered the response body. The predicate now delegates to
 * {@link resolveAuditResourceIdentity} and {@link isConfidentialAuditIdentity} — the same
 * deeply validated model the hook applies at the parse boundary — so an uncertain
 * identity is treated as sensitive and a Secret identity recovered from the request URI
 * is treated as a Secret. Sharing the model rather than restating it is deliberate: two
 * copies of a confidentiality rule is one copy too many.
 *
 * The tie is resolved towards withholding because the two possible mistakes do not cost
 * the same. Treating a non-Secret as sensitive withholds one response body from a report;
 * treating an unidentifiable Secret as non-sensitive writes a Secret's contents into the
 * document.
 *
 * A genuine non-resource request — `/healthz`, `/version`, `/metrics` — is still NOT
 * sensitive, matching `test/utils/audit.go` L144's `if e.ObjectRef != nil` guard: it
 * references no object whose body could leak.
 *
 * @param event a single audit.k8s.io/v1 event, exactly as received
 * @returns `true` when the event must be treated as naming the sensitive resource
 */
export function isSensitiveResourceEvent(event: AuditEvent): boolean {
  return isConfidentialAuditIdentity(resolveAuditResourceIdentity(event));
}

/**
 * The resource an event names, for display and for filtering.
 *
 * @returns the resource name, or `undefined` when the event names none — which covers
 *   both a non-resource request and an unestablished identity, neither of which may be
 *   offered as a filter option for a resource that was never named.
 */
function identityResource(identity: AuditResourceIdentity): string | undefined {
  return identity.kind === 'resource' ? identity.resource : undefined;
}

/**
 * How the resource column reads for one resolved identity.
 *
 * The three arms are worded differently on purpose. A reader looking at a withheld row
 * needs to know WHICH of them applies: a Secret event and an unidentifiable event are
 * both withheld, and only the second is also a defect in the audit report itself.
 */
function describeIdentity(identity: AuditResourceIdentity): string {
  if (identity.kind === 'uncertain') {
    return UNCERTAIN_IDENTITY_TEXT;
  }
  if (identity.kind === 'non-resource') {
    return NON_RESOURCE_REQUEST_TEXT;
  }
  return safeObservationValue(identity.resource);
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
  let serialized: string;
  try {
    serialized = JSON.stringify(payload, null, 2);
  } catch {
    return UNSERIALIZABLE_BODY_TEXT;
  }
  // `JSON.stringify` returns `undefined` for a value it cannot represent at the top
  // level. Rendering that would put the word `undefined` in the document.
  if (typeof serialized !== 'string') {
    return UNSERIALIZABLE_BODY_TEXT;
  }
  if (serialized.length <= MAX_RENDERED_BODY_LENGTH) {
    return serialized;
  }
  // BOUNDED, NOT DISCARDED. A body over the bound belongs to a resource the guard does
  // not withhold, so the reader is entitled to see it — but an unbounded one is both a
  // rendering hazard and, on a resource nobody anticipated, a disclosure hazard. The
  // notice is appended rather than substituted so the truncation is stated rather than
  // silent, and it says the byte count so the reader knows how much is missing.
  return `${serialized.slice(0, MAX_RENDERED_BODY_LENGTH)}\n${TRUNCATED_BODY_NOTICE(
    serialized.length,
  )}`;
}

/**
 * Renders one non-sensitive body inside a `<pre>` that WRAPS.
 *
 * m5: a `<pre>` preserves newlines and, by default, does not wrap — so a serialized body
 * with one long line forced the whole page horizontally and the table's other columns off
 * screen. `pre-wrap` keeps the significant newlines of the JSON while permitting soft
 * wrapping, and `anywhere` lets a single unbroken run — a base64 field, a long name — break
 * mid-token rather than establishing a minimum width nothing can shrink below.
 *
 * Inline style rather than a class, deliberately: this tier ships no stylesheet and no
 * design system (AAP §0.8.2 records that there is no UI to inherit one from), so a class
 * name here would be a hook for a stylesheet that does not exist and the overflow
 * behaviour would remain unfixed.
 */
function BodyCell({ payload }: { readonly payload: AuditPayload }): ReactElement {
  return (
    <td style={CELL_STYLE}>
      <pre style={PRE_STYLE}>{serializePayload(payload)}</pre>
    </td>
  );
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
    // BOUNDED (M18). Every one of these cells — the audit identifier, level, verb,
    // resource, namespace, object name, user name, stage and authorization decision — is
    // arbitrary server text, and all nine used to be rendered verbatim at unbounded
    // length. The shared guard flattens control characters and bidirectional overrides,
    // withholds a credential shape whole, and bounds the length.
    return safeObservationValue(value);
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
 * 4. THE "NOTHING WAS WITHHELD" SENTENCE IS A WHOLE-SET CLAIM, and it is therefore made
 *    only when `completeness` is `complete` (M7). While a traversal is still running, or
 *    after the page ceiling stopped one, the summary states that the view is partial and
 *    declines the claim — because a Secret body on an unscanned page would otherwise be
 *    reported as absent. A withheld body ALREADY FOUND is reported in every state, since
 *    a leak found on page three is a finding whether or not page four was ever read.
 *
 * Nothing here is a pass verdict. The component reports what was scanned and what was
 * withheld; it never claims a control is healthy.
 */
function describeRedactionSummary(
  scanned: number,
  withheldTotal: number,
  withheldHidden: number,
  completeness: ScanCompleteness,
): string {
  const sentences = [
    `Scanned ${scanned} audit ${plural(scanned, 'event', 'events')}.`,
  ];

  if (completeness !== 'complete') {
    sentences.push(completeness === 'truncated' ? SCAN_TRUNCATED_TEXT : SCAN_IN_PROGRESS_TEXT);
  }

  if (withheldTotal === 0) {
    // The absence claim is available ONLY over a completed scan. Over a partial one the
    // sentence above has already said why, and adding "no body was withheld" here would
    // contradict it.
    if (completeness === 'complete') {
      sentences.push(
        `No event for the ${SENSITIVE_AUDIT_RESOURCE} resource carried a response body, ` +
          'so no body was withheld.',
      );
    }
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
  return <BodyCell payload={event.requestObject} />;
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
function renderResponseBodyCell(event: AuditEvent, identity: AuditResourceIdentity): ReactElement {
  // THE IDENTITY IS DECIDED BEFORE ANYTHING ELSE, and it is the ALREADY-RESOLVED one
  // passed in rather than a second resolution performed here. One resolution per event,
  // shared by the row and both body cells, is what makes it impossible for the rendered
  // resource column to disagree with the redaction decision.
  if (isConfidentialAuditIdentity(identity)) {
    // Presence is read with the WEAKER predicate on purpose: a flattened
    // `responseObject: true` is a recorded body under the Go guard's own boolean
    // test, so it must be withheld and counted rather than reported as absent.
    if (isRecordedPayload(event.responseObject)) {
      return (
        <td>
          <p
            role="note"
            aria-label={`${REDACTION_NOTICE_TEXT} for audit event ${safeObservationValue(
              event.auditID,
            )}`}
          >
            {`${REDACTION_NOTICE_TEXT}. ${REDACTION_REASON_TEXT}`}
          </p>
        </td>
      );
    }
    return <td>{NO_BODY_RECORDED_TEXT}</td>;
  }

  // Reached ONLY for an identity that resolved to a definite non-sensitive resource or to
  // a genuine non-resource request. `uncertain` cannot arrive here, because
  // `isConfidentialAuditIdentity` returns `true` for it — so serialization is now
  // structurally gated on a VALIDATED identity rather than on the absence of a match.
  if (!isRecordedPayload(event.responseObject)) {
    return <td>{NO_BODY_RECORDED_TEXT}</td>;
  }
  if (!isPresentPayload(event.responseObject)) {
    return <td>{UNSERIALIZABLE_BODY_TEXT}</td>;
  }
  return <BodyCell payload={event.responseObject} />;
}

/**
 * What to say when a failure carries no HTTP status, keyed by the layer that failed.
 *
 * `Record` over the imported union rather than a default string, so that adding a
 * new {@link AuditEventsErrorKind} is a COMPILE ERROR here instead of silently
 * rendering a blank or a wrong sentence. `http` and `payload` both always carry a
 * status, so their entries are unreachable in practice; they are still stated,
 * because a hook change that stopped supplying one must produce a legible sentence
 * rather than fall through to nothing.
 *
 * Every string is LOCAL. Nothing a failing backend controls reaches these
 * sentences, which is what lets them be rendered into a live `role="alert"` region
 * unconditionally.
 */
const NO_RESPONSE_DESCRIPTIONS: Readonly<Record<AuditEventsErrorKind, string>> = Object.freeze({
  http: 'The server answered, but no status was recorded for its response.',
  network: 'No HTTP response was received.',
  payload: 'A response arrived, but no status was recorded for it.',
  timeout: 'No HTTP response was received before the request deadline elapsed.',
});


/**
 * Describes a failed read without ever implying a healthy control.
 *
 * A refused or failed read is evidence of nothing about the audit configuration, so the
 * final sentence says exactly that. This is the presentation-layer half of the
 * invariant the hook documents on its own side: a refusal is never representable as a
 * result, and a 403 or a 500 must never render as "no response bodies were recorded".
 *
 * M18 — THE SENTENCES ARE LOCAL, THE TWO INTERPOLATED PARTS ARE NOT. `reason` and
 * `message` are prose a failing backend controls completely, and both went verbatim into
 * a live `role="alert"` region and its `aria-label`. Both now pass through
 * {@link safeProse}, which keeps a legible explanation legible while withholding a
 * credential shape and bounding the length. `httpStatus` is a NUMBER and is deliberately
 * interpolated as it stands: it is the one field that tells a refusal from a broken
 * server, and guarding a number would only obscure that it cannot carry text.
 *
 * The first and last sentences are local and unconditional, so a failure whose every
 * external part is withheld still says what happened and still says that no conclusion
 * follows from it.
 */
function describeFailure(failure: AuditEventsError): string {
  const parts = ['Audit events could not be read.'];

  // Read from the PRESENCE of httpStatus, not from a magic value. The hook used to
  // fabricate `httpStatus: 0` for a request that never got a response, so this
  // branch tested for that sentinel - and a single missed comparison anywhere in
  // the tier rendered the literal text "HTTP status 0". The field is now simply
  // absent when no response existed, which is unmissable: `undefined` cannot be
  // mistaken for a status, and the `kind` discriminant names the layer that failed.
  parts.push(
    failure.httpStatus === undefined
      ? NO_RESPONSE_DESCRIPTIONS[failure.kind]
      : `HTTP status ${failure.httpStatus}.`,
  );

  // ABSENT IS NOT UNRECOGNISED. `describeStatusReason` maps everything that is not an
  // allowlisted `StatusReason` -- `undefined` included -- to `[unrecognised reason]`,
  // which is the right answer for a value the server sent and the wrong one for a field
  // that never arrived. `reason` comes from a Kubernetes `Status` body, so it is absent
  // on every failure that produced no response: this alert used to say "Reason:
  // [unrecognised reason]." for a network error or a timeout, asserting that the server
  // had supplied something unreadable when no server had answered. That is the same
  // fabrication the `httpStatus` note above describes, and it is corrected the same way
  // -- read from PRESENCE, and say nothing when there is nothing to say. The two
  // unconditional sentences either side still carry the whole meaning of the alert.
  if (failure.reason !== undefined) {
    const reason = describeStatusReason(failure.reason);
    if (reason.length > 0) {
      parts.push(`Reason: ${reason}.`);
    }
  }
  const message = safeProse(failure.message);
  if (message.length > 0) {
    parts.push(message);
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
  // ONE resolution per event, shared by the resource column and the response-body cell.
  // Resolving twice would let the column say `configmaps` while the guard withheld the
  // body as a Secret, and a reader has no way to tell which of the two to believe.
  const identity = resolveAuditResourceIdentity(event);

  return (
    <tr key={`${event.auditID}::${index}`}>
      <th scope="row">{textOrNotRecorded(event.auditID)}</th>
      <td>{textOrNotRecorded(event.level)}</td>
      <td>{textOrNotRecorded(event.verb)}</td>
      {/*
        The RESOLVED identity, not the raw `objectRef.resource`. An event whose two
        statements of identity disagree, or whose objectRef carries no readable resource,
        now reads "Identity could not be established" rather than showing whichever half
        happened to be present — which is what let a contradictory event look ordinary
        while its body was withheld for a reason the row did not state.
      */}
      <td>{describeIdentity(identity)}</td>
      <td>{textOrNotRecorded(objectRef?.namespace)}</td>
      <td>{textOrNotRecorded(objectRef?.name)}</td>
      <td>{textOrNotRecorded(event.responseStatus?.code)}</td>
      <td>{textOrNotRecorded(event.user?.username)}</td>
      <td>{textOrNotRecorded(event.stage)}</td>
      <td>{textOrNotRecorded(decision)}</td>
      {renderRequestBodyCell(event)}
      {renderResponseBodyCell(event, identity)}
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

  // ---------------------------------------------------------------------------
  // M7 — PAGE ACCUMULATION.
  //
  // In uncontrolled mode the hook returns ONE page. The guard's population must be as
  // wide as what the server returned — the Go original inspects
  // `missingReport.AllEvents`, "a superset of expEvents" (audit_test.go L1038-1039) — so
  // the component traverses every page and scans the union, rather than the first fifty
  // events. Recorded per page number rather than appended to a list, so a page arriving
  // twice replaces its own entry instead of double-counting its events.
  //
  // In controlled mode the caller's array IS the whole set by definition, so no traversal
  // happens and no request is issued.
  // ---------------------------------------------------------------------------
  const [scannedPages, setScannedPages] = useState<ReadonlyMap<number, readonly AuditEvent[]>>(
    () => new Map(),
  );
  // The page that reported no successor, once one has. `undefined` while unknown, which is
  // distinct from page 1 and is why this is not initialised to a number.
  const [terminalPage, setTerminalPage] = useState<number | undefined>(undefined);

  const { status: queryStatus, page: queryPage, loadedPage, events: queryEvents } = query;
  const { hasNextPage, setPage, refresh: refetch } = query;

  useEffect(() => {
    if (controlled || queryStatus !== 'success' || loadedPage === undefined) {
      return;
    }
    // KEYED BY `loadedPage`, NEVER BY `page`. The two differ for one render after a page
    // change — the hook holds the new page number beside the previous page's events — so
    // keying by `page` filed page one's fifty events under key 2 and then counted them a
    // second time when page two actually arrived. That is not a cosmetic error: the
    // summary's event count is the denominator of the guard's claim.
    setScannedPages((current) => {
      // Referential equality is the right test: the hook freezes each page and returns the
      // same array until the next fetch, so an unchanged page must not produce a new Map
      // and therefore another render.
      if (current.get(loadedPage) === queryEvents) {
        return current;
      }
      const next = new Map(current);
      next.set(loadedPage, queryEvents);
      return next;
    });
    if (!hasNextPage) {
      setTerminalPage(loadedPage);
      return;
    }
    // Advanced with an ABSOLUTE target rather than with `nextPage()`. A relative step is
    // taken from the current page state, which has already moved on when a response for an
    // earlier page arrives late — so two responses could each add one and skip a page. An
    // absolute `loadedPage + 1` is idempotent under a repeated or reordered response, and
    // a page already scanned is simply re-requested rather than jumped over.
    if (loadedPage < MAX_SCANNED_PAGES && queryPage <= loadedPage) {
      setPage(loadedPage + 1);
    }
  }, [controlled, queryStatus, queryPage, loadedPage, queryEvents, hasNextPage, setPage]);

  /** Every event scanned so far, in page order. */
  const events: readonly AuditEvent[] = useMemo(() => {
    if (controlled) {
      return providedEvents ?? [];
    }
    return [...scannedPages.keys()]
      .sort((left, right) => left - right)
      .flatMap((number) => scannedPages.get(number) ?? []);
  }, [controlled, providedEvents, scannedPages]);

  /**
   * How much of the result set the summary may speak for.
   *
   * `complete` requires BOTH that a page reported no successor AND that every page from 1
   * to that page is present. The second half matters: a gap left by a page that never
   * arrived would otherwise be reported as a whole-set scan with events missing from it.
   */
  const completeness: ScanCompleteness = useMemo(() => {
    if (controlled) {
      return 'complete';
    }
    if (queryStatus !== 'success') {
      return 'scanning';
    }
    if (hasNextPage) {
      return (loadedPage ?? queryPage) >= MAX_SCANNED_PAGES ? 'truncated' : 'scanning';
    }
    if (terminalPage === undefined) {
      return 'scanning';
    }
    for (let number = 1; number <= terminalPage; number += 1) {
      if (!scannedPages.has(number)) {
        return 'scanning';
      }
    }
    return 'complete';
  }, [controlled, queryStatus, hasNextPage, queryPage, loadedPage, terminalPage, scannedPages]);

  /**
   * Re-runs the scan from page 1, discarding everything accumulated.
   *
   * Discarding is not optional: keeping the old pages would mix two reads of a changing
   * audit log into one population and report a count belonging to neither. Exactly ONE
   * request is issued — changing the page re-issues the query on its own, so `refresh` is
   * called only when the page is already 1 and there is nothing to change.
   */
  const rescan = useCallback(() => {
    setScannedPages(new Map());
    setTerminalPage(undefined);
    if (queryPage === 1) {
      refetch();
      return;
    }
    setPage(1);
  }, [queryPage, refetch, setPage]);

  // Counted over EVERY scanned event, deliberately before any filter narrows the view.
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
      // The RESOLVED resource, so a Secret event whose identity came from its request URI
      // is offered — and therefore reachable — under `secrets`. Reading the raw objectRef
      // here would leave exactly the events the guard cares most about unfilterable.
      const resource = identityResource(resolveAuditResourceIdentity(event));
      if (resource !== undefined) {
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
            identityResource(resolveAuditResourceIdentity(event)) === resourceFilter) &&
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
  //
  // `events.length === 0` is part of the test so that the SECOND and later pages of a
  // traversal do not replace the table with the pending affordance on every hop. Once
  // anything has been scanned the table stays on screen and the summary says the scan is
  // still running — which is both less jarring and more informative, because a leak found
  // on page one remains visible while page two is fetched.
  const pending =
    providedIsLoading === true ||
    (!controlled &&
      (query.status === 'loading' || query.status === 'idle') &&
      events.length === 0);

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
          <button type="button" onClick={rescan}>
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
          {describeRedactionSummary(events.length, withheldTotal, withheldHidden, completeness)}
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
            <button type="button" onClick={rescan}>
              {REFRESH_BUTTON_TEXT}
            </button>
          )}
        </fieldset>

        {/*
          m5 — the scroll is SCOPED to this wrapper. Twelve columns of audit metadata do
          not fit a narrow viewport, and without a wrapper the overflow escaped to the page
          and carried the surrounding panels sideways with it.
        */}
        <div style={TABLE_WRAPPER_STYLE}>
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
        </div>
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
