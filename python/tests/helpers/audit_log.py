# Copyright The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Audit-log scanner and missing-events report, ported from test/utils/audit.go.

The API server writes its audit log as JSON Lines: one audit event per line. A
test that wants to prove something about auditing has to read that log while the
server is still filling it, so the log is always a moving target and the event a
test waits for may simply not have been flushed yet. The Go suite handles that by
separating two questions that look like one:

    "is every event I expect present?"   ->  MissingEventsReport.missing_events
    "what did the server actually log?"  ->  MissingEventsReport.all_events

This module answers both and decides neither. It contains no assertion, and an
absent event is not an error: the caller polls until the report comes back with
nothing missing, and only then draws a conclusion. That division of labour is why
the Go helper returns a report instead of failing the test itself, and it is
preserved here exactly.

WHAT all_events IS FOR, AND WHY IT MUST NOT BE TRIMMED AWAY

all_events is a superset of the expectations, deliberately. The V6
confidentiality guard in test/integration/controlplane/audit/audit_test.go scans
it rather than the expectation table:

    for _, e := range observedEvents {
        if e.Resource == "secrets" && e.ResponseObject { t.Errorf(...) }
    }

Secrets are audited at level Request and never at RequestResponse, precisely so
the response body, which would duplicate the Secret payload, never reaches the
audit log. Scanning every logged Secret event catches a regression to
RequestResponse even if the expectation table were edited to match it. Scanning
only the expected events would not: table and log would agree, the suite would
stay green, and secret payloads would be sitting on disk. A port that returned
only the missing events would destroy that guard silently, so all_events carries
every projected event, in log order, always.

PRESENCE, NOT TRUTHINESS

request_object and response_object answer "did the server write this section?",
not "does the section contain anything?". In Go they come from
`e.RequestObject != nil` and `e.ResponseObject != nil`, which are tests on a
pointer. The faithful equivalent here is `raw.get(key) is not None`, so a
present-but-empty ``{}`` still reports True. Writing `if raw.get(key):` instead
would report False for it and would defeat the confidentiality guard for exactly
the event most worth catching. The asymmetry between the two fields is intended:
a requestObject on a write is the accepted trade-off of Request over
RequestResponse rather than a violation, so this module reports both faithfully
and judges neither.

WHY THE THREE ANNOTATION MAPS DEFAULT TO None

An expectation is matched against a projected event by value. Go builds both
sides with the annotation maps left nil unless a matching annotation exists, and
compares with reflect.DeepEqual. The V6 expectations set eleven fields and leave
the maps unset, so a projected event has to leave them unset too. Defaulting
them to ``{}`` here would make ``{} != None`` fail every comparison, the poll
would never converge, and the failure would read as a missing audit event rather
than as a bug in this file. They default to None and are allocated only when an
annotation actually lands in one.
"""

# AAP §0.5.1 (the python/tests/helpers/audit_log.py row: the CheckAuditLines and
# MissingEventsReport port, from test/utils/audit.go:86 and :93) / §0.4.2.2 (the
# V6 integration blueprint, whose CONFIDENTIALITY GUARD scans every observed
# event for a secrets responseObject) / §0.10.2 (that guard as a boundary
# condition which must port unchanged) / tech-spec §0.3.2, which lists
# utils.CheckAuditLines and CheckAuditLinesFiltered at test/utils/audit.go:86
# and :93 among the harness primitives to recreate rather than mock.
#
# The V6 requirements this module carries the evidence for are F-006-RQ-002
# (sensitive-resource audit fidelity: the per-resource levels and the events the
# API server must emit) and F-006-RQ-003 (advanced auditing enabled, without
# which there is no log to read). This module asserts neither. It projects the
# log so its caller can, which is why a diagnostic raised from here names
# F-006-RQ-002: a line that will not decode invalidates both.
#
# INVARIANT LOCKED BY THIS FILE: the audit log is projected faithfully and
# judged not at all. Every line the server wrote reaches all_events in log
# order; request_object and response_object stay presence tests, so an empty
# section still reports True; the three annotation maps stay None until an
# annotation lands in one; and a missing event yields a report rather than an
# exception. Weaken any one of those and the V6 confidentiality guard keeps
# passing while secret payloads reach the audit log.

import json
import os
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

# Audit annotation prefixes, copied from the constants the mutating admission
# dispatcher writes them with, at
# staging/src/k8s.io/apiserver/pkg/admission/plugin/webhook/mutating/dispatcher.go
# lines 59 and 61. They are duplicated as literals rather than derived because
# nothing in this tier links against the Go tree; verify them against that file
# when it moves.
PATCH_AUDIT_ANNOTATION_PREFIX = "patch.webhook.admission.k8s.io/"
MUTATION_AUDIT_ANNOTATION_PREFIX = "mutation.webhook.admission.k8s.io/"

# The annotation the authorization filter records its decision under, from
# staging/src/k8s.io/apiserver/pkg/endpoints/filters/authorization.go line 41.
# Absent means "no decision was recorded", which projects to "" so that an
# expectation leaving authorize_decision unset still matches.
AUTHORIZATION_DECISION_ANNOTATION_KEY = "authorization.k8s.io/decision"

# A decoded audit-log line, exactly as json.loads produced it. Held by
# MissingEventsReport.first_event_checked and .last_event_checked, which is where
# Go holds the decoded *auditinternal.Event. Mapping rather than dict because
# this module only ever reads it: nothing here writes back into a raw event.
RawEvent = Mapping[str, Any]

# Port of `type AuditAnnotationsFilter func(key, val string) bool`, audit.go
# line 61. Returning True routes an annotation into
# AuditEvent.custom_audit_annotations.
AuditAnnotationsFilter = Callable[[str, str], bool]

# What check_audit_lines accepts in place of Go's io.Reader. A str or PathLike is
# always treated as a filesystem path to open and close; anything else is an
# already-open iterable of lines the caller owns, which is the closest analogue
# of an io.Reader. Passing whole log *contents* as a single str would therefore
# be read as a path, so callers holding text should pass text.splitlines().
AuditLogSource = str | os.PathLike[str] | Iterable[str]

__all__ = [
    "AUTHORIZATION_DECISION_ANNOTATION_KEY",
    "MUTATION_AUDIT_ANNOTATION_PREFIX",
    "PATCH_AUDIT_ANNOTATION_PREFIX",
    "AuditAnnotationsFilter",
    "AuditEvent",
    "AuditLogDecodeError",
    "AuditLogSource",
    "MissingEventsReport",
    "RawEvent",
    "audit_event_from_raw",
    "check_audit_lines",
    "check_audit_lines_filtered",
]


@dataclass
class AuditEvent:
    """A simplified audit event for testing, ported from audit.go lines 36-59.

    Field order follows the Go struct so the two can be read side by side, and
    every default is the Go zero value: "" for the strings, 0 for code, False
    for the two booleans and None for the three annotation maps. That matters
    because an expectation sets only the handful of fields it cares about and
    relies on the rest defaulting to zero, exactly as a Go composite literal
    does. Equality is the generated dataclass comparison, which stands in for
    reflect.DeepEqual at audit.go line 208.

    INVARIANT PRESERVED: an expectation that leaves a field unset matches a
    projected event whose corresponding field is absent from the log. The three
    annotation maps are the sharp edge, and are documented on the module.

    level and stage carry the wire strings verbatim ("None", "Metadata",
    "Request", "RequestResponse"; "ResponseComplete" and its siblings) rather
    than an enum. The wire value is what expectations compare against, so an
    enum would add a translation layer the Go original does not have, and level
    in particular has to survive untouched: it is what makes the sensitive
    resource levels assertable by the caller (secrets and
    serviceaccounts/token at exactly Request, configmaps and tokenreviews at
    exactly Metadata, clusterroles at exactly RequestResponse).
    """

    # Kept for fidelity with the Go struct's ID field even though the
    # projection never populates it: testEventFromInternalFiltered does not set
    # ID, so it stays zero on both sides of the comparison and would break
    # matching if this port started filling it in from auditID.
    id: str = ""
    level: str = ""
    stage: str = ""
    request_uri: str = ""
    verb: str = ""
    code: int = 0
    user: str = ""
    impersonated_user: str = ""
    impersonated_groups: str = ""
    resource: str = ""
    namespace: str = ""
    # Presence of the section in the logged event, never its contents. See the
    # module docstring: an empty-but-present object must still report True.
    request_object: bool = False
    response_object: bool = False
    authorize_decision: str = ""

    # These three stay None until an annotation lands in them, mirroring Go's
    # lazy `if ... == nil { ... = map[string]string{} }` allocation at audit.go
    # lines 165-178. field(default=None) rather than a mutable default: a shared
    # dict would leak annotations between events, and {} would break equality
    # against every expectation that leaves them unset.
    admission_webhook_mutation_annotations: dict[str, str] | None = field(default=None)
    admission_webhook_patch_annotations: dict[str, str] | None = field(default=None)
    # Populated only when a custom filter is supplied to
    # check_audit_lines_filtered, matching the Go comment at audit.go lines
    # 57-58.
    custom_audit_annotations: dict[str, str] | None = field(default=None)


@dataclass
class MissingEventsReport:
    """Analysis of which expected events are absent, from audit.go lines 64-70.

    Ported field for field, all_events included. The caller reads
    missing_events to decide whether to poll again and all_events to inspect
    what was really logged; see the module docstring for why the second one
    cannot be dropped.

    INVARIANT PRESERVED: this is a report, not a verdict. Constructing one
    never raises, and an entry in missing_events means "not seen yet", which is
    the caller's cue to poll again rather than a failure.
    """

    # The raw decoded lines, not projected events, because Go stores
    # *auditinternal.Event here and the string form below renders them. The
    # first line seen and the last line seen, so on a one-line log they are the
    # same mapping.
    first_event_checked: RawEvent | None = None
    last_event_checked: RawEvent | None = None
    num_events_checked: int = 0
    # Seeded with every expectation before the first line is read, so an empty
    # or not-yet-flushed log reports everything missing rather than nothing.
    missing_events: list[AuditEvent] = field(default_factory=list)
    # Every projected event, in log order. A superset of the expectations.
    all_events: list[AuditEvent] = field(default_factory=list)

    def __str__(self) -> str:
        """Human-readable report, reproducing Go's String() at audit.go 73-83.

        The labels, the counts, their order and the blank line between each
        section are all reproduced, because the V6 test interpolates this string
        into its failure message through lastMissingReport: this is the
        diagnostic a CI reader actually sees when the poll times out.

        Go renders the three values with %#v, a Go-syntax representation with
        no Python equivalent. repr() is the closest legible stand-in and is used
        deliberately: for a dataclass it prints the type name and every field,
        which is the property that makes %#v useful here. all_events is
        excluded, exactly as Go excludes AllEvents, because a converged run can
        hold thousands of events and the report exists to explain a failure.
        """
        return (
            f"missing {len(self.missing_events)} events\n"
            "\n"
            f"- first event checked: {self.first_event_checked!r}\n"
            "\n"
            f"- last event checked: {self.last_event_checked!r}\n"
            "\n"
            f"- number of events checked: {self.num_events_checked}\n"
            "\n"
            f"- missing events: {self.missing_events!r}"
        )


class AuditLogDecodeError(Exception):
    """A log line could not be decoded as an audit event of the version asked for.

    This is the port of the error return at audit.go line 109, where
    CheckAuditLinesFiltered abandons the scan and hands back the partial report
    alongside the error. Python has no two-value return, so the report travels
    on the exception: the V6 predicate escalates a decode failure by aborting
    the poll, and the diagnostic gathered so far has to survive that.

    Raised only for a line that cannot be decoded. A merely-absent expectation
    is reported through MissingEventsReport.missing_events and never raises,
    which is what keeps the poll-until-converged loop working.
    """

    def __init__(self, message: str, report: MissingEventsReport) -> None:
        super().__init__(message)
        # The report as it stood when decoding failed: the lines already
        # consumed are in all_events and num_events_checked is still 0, since
        # Go likewise returns before assigning it at line 129.
        self.report = report


def _as_mapping(value: Any) -> RawEvent | None:
    """Narrow a decoded JSON value to a mapping, or None if it is not one.

    No single Go statement to port: this stands in for the `!= nil` test Go
    applies to each pointer-to-struct field of an audit event, at audit.go 144
    (ObjectRef), 148 (ResponseStatus) and 157 (ImpersonatedUser). A field that is
    absent, or explicitly null in the log, is nil in Go and None here, so both
    skip the block that would have read it.
    """
    return value if isinstance(value, dict) else None


def _text(mapping: RawEvent | None, key: str) -> str:
    """Read a string field, projecting absent, null and non-mapping to "".

    No single Go statement to port either: it exists because Go's decoder gives
    a missing or null JSON string the "" zero value before the composite literal
    at audit.go 137-143 ever sees it, whereas json.loads would hand back None.
    Every string projection funnels through here so that None never reaches an
    AuditEvent field, where it would compare unequal to an expectation's "".
    """
    if mapping is None:
        return ""
    value = mapping.get(key)
    if value is None:
        return ""
    return str(value)


def _response_code(response_status: RawEvent) -> int:
    """Project responseStatus.code, the only numeric field. audit.go 148-150.

    Go's Code is an int32 with omitempty, so an absent code is 0. bool is a
    subclass of int in Python, but a JSON true is not a status code, so it is
    excluded explicitly rather than silently projecting to 1.
    """
    value = response_status.get("code")
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0
    return int(value)


@contextmanager
def _line_source(source: AuditLogSource) -> Iterator[Iterable[str]]:
    """Yield the lines of `source`, closing it afterwards only if we opened it.

    Ports the lifetime contract of the `stream io.Reader` parameter at audit.go
    86 and 93 rather than a body of code: Go reads whatever it is handed and
    leaves the lifetime to the caller, which is what the V6 test depends on when
    it reopens the log with os.Open on every 500 ms poll tick and closes it with
    defer. This reproduces that contract from both sides. A str or PathLike is
    opened here and closed on the way out, including
    when the body raises, so calling repeatedly against a path leaks no handle
    and every call starts from position zero. Anything else is yielded
    untouched, because the caller owns it.

    INVARIANT PRESERVED: no state survives a call. Nothing is cached, so a log
    that grew between two calls is re-read in full rather than resumed, which is
    what makes the caller's poll converge on the current contents of the log.
    """
    if isinstance(source, str | os.PathLike):
        with open(source, encoding="utf-8") as handle:
            yield handle
    else:
        yield source


def _decode_failure(line: str, version: str) -> str:
    """Build the decode-failure message, keeping Go's shape from audit.go 109.

    Go's exact wording leads so a reader can grep the two suites for the same
    diagnostic; the requirement this guards is named after it, because the
    reader of a CI failure is often not the author of the test.
    """
    return (
        f"failed decoding buf: {line}, apiVersion: {version}"
        " (F-006-RQ-002: sensitive-resource audit fidelity is asserted from the"
        " audit log, so a line that will not decode invalidates the check)"
    )


def _decode_line(line: str, version: str, report: MissingEventsReport) -> RawEvent:
    """Decode one audit-log line. Port of the decode step at audit.go 106-110.

    Go builds `audit.Codecs.UniversalDecoder(version)` and decodes into an
    internal Event, which fails both when the line is not JSON and when it does
    not carry a version the audit scheme recognises. Only audit.k8s.io/v1 is
    registered, by apis/audit/install/install.go, which adds the internal
    version and v1 and makes v1 the priority version, so requiring apiVersion to
    equal the requested version is precisely what that decoder enforced.

    INVARIANT PRESERVED: a line written at the wrong version is a hard failure,
    not a quietly skipped line. Skipping it would let the caller's poll spin
    until it timed out and then blame a missing event, hiding the real cause.
    The partial report rides out on the exception so that diagnostic survives.
    """
    try:
        decoded = json.loads(line)
    except ValueError as exc:
        # ValueError rather than JSONDecodeError: the latter subclasses it, and
        # this also catches the non-strict numeric failures json can raise.
        raise AuditLogDecodeError(_decode_failure(line, version), report) from exc
    if not isinstance(decoded, dict):
        # Valid JSON, but a scalar or a list is not an audit event.
        raise AuditLogDecodeError(_decode_failure(line, version), report)
    if decoded.get("apiVersion") != version:
        raise AuditLogDecodeError(_decode_failure(line, version), report)
    return decoded


def check_audit_lines(
    stream: AuditLogSource,
    expected: Sequence[AuditEvent],
    version: str,
) -> MissingEventsReport:
    """Search the audit log for the expected audit lines. audit.go 85-88.

    Delegates with no annotations filter, exactly as the Go one-liner does, so
    every projected event leaves custom_audit_annotations at None.

    Args:
        stream: the audit log. A str or PathLike is opened and closed here; a
            file object or any other iterable of lines is consumed as-is and
            left open, mirroring Go's io.Reader.
        expected: the events that must appear. Not consumed or mutated; the
            report's missing_events starts as a copy of it.
        version: the audit apiVersion every line must carry, for example
            "audit.k8s.io/v1". Taken as a parameter because the V6 test is
            parametrized over it, even though v1 is the only version the audit
            scheme registers today.

    Returns:
        A MissingEventsReport. Absent expectations are reported, never raised:
        the caller polls until missing_events is empty and then inspects
        all_events.

    Raises:
        AuditLogDecodeError: a non-blank line was not a decodable audit event of
            `version`. The partial report is on the exception's `report`.
    """
    return check_audit_lines_filtered(stream, expected, version, None)


def check_audit_lines_filtered(
    stream: AuditLogSource,
    expected: Sequence[AuditEvent],
    version: str,
    custom_annotations_filter: AuditAnnotationsFilter | None = None,
) -> MissingEventsReport:
    """Search the audit log for the expected audit lines, routing custom
    annotations through a filter. Port of CheckAuditLinesFiltered, audit.go
    90-131.

    `custom_annotations_filter` decides which audit annotations are added to
    AuditEvent.custom_audit_annotations; when it is None that map stays None on
    every projected event, matching the Go doc comment at audit.go 91-92.

    INVARIANTS PRESERVED, each of which the V6 confidentiality guard depends on:

    - all_events collects every projected event in log order, a superset of
      `expected`. The guard scans it, so trimming it to the missing events would
      leave the guard passing while secret payloads reached the audit log.
    - missing_events is seeded with every expectation before the first line is
      read, so a log the server has not flushed yet reports everything missing
      rather than nothing missing.
    - An absent expectation is reported, never raised, so the caller can poll.
    - The stream is read once, from the beginning, with nothing cached between
      calls, so the 500 ms poll sees the log as it now stands.

    See check_audit_lines for the argument, return and raise contract, which is
    identical.
    """
    expectations = _AuditEventTracker(expected)

    # audit.go 98-100. list() rather than sharing the caller's sequence: Go
    # assigns the slice itself, but a report that aliased the caller's list would
    # let the reassignment below surprise a caller that kept a reference.
    report = MissingEventsReport(missing_events=list(expected))

    index = 0
    with _line_source(stream) as lines:
        for raw_line in lines:
            # bufio.ScanLines hands Go the line without its trailing newline or
            # carriage return, which is what strip() reproduces here.
            line = raw_line.strip()
            if not line:
                # A blocking-mode audit log can end with a trailing newline, and
                # a caller that split the text itself yields a final "" for it.
                # Go's scanner produces no token in that case, so skipping
                # without advancing the counter keeps num_events_checked equal to
                # Go's i for every well-formed log. Nothing else is ever
                # skipped: a non-blank line that will not decode raises.
                continue

            raw = _decode_line(line, version, report)
            if index == 0:
                report.first_event_checked = raw
            # Every line, so this ends up holding the last one. audit.go 111-114.
            report.last_event_checked = raw

            event = audit_event_from_raw(raw, custom_annotations_filter)
            expectations.mark(event)
            report.all_events.append(event)
            index += 1

    report.missing_events = expectations.missing()
    report.num_events_checked = index
    return report


def audit_event_from_raw(
    raw: RawEvent,
    custom_annotations_filter: AuditAnnotationsFilter | None = None,
) -> AuditEvent:
    """Project a decoded audit-log line onto an AuditEvent. Port of
    testEventFromInternalFiltered, audit.go 133-182.

    Every rule of the original is reproduced, including the ones that look
    incidental. `id` is deliberately left at "" because the Go projection never
    sets ID either, and filling it in from auditID would make every projected
    event unequal to every expectation.

    INVARIANT PRESERVED: request_object and response_object are presence tests,
    not content tests. An empty-but-present responseObject on a Secret event is
    the regression the V6 guard exists to catch, and a truthiness test would
    report it as absent.
    """
    event = AuditEvent(
        level=_text(raw, "level"),
        stage=_text(raw, "stage"),
        request_uri=_text(raw, "requestURI"),
        verb=_text(raw, "verb"),
        # e.User is a value rather than a pointer in Go, so an absent user is
        # the zero UserInfo and its Username is "".
        user=_text(_as_mapping(raw.get("user")), "username"),
    )

    object_ref = _as_mapping(raw.get("objectRef"))
    if object_ref is not None:
        event.namespace = _text(object_ref, "namespace")
        # The field the V6 guard keys on: `e.Resource == "secrets"`.
        event.resource = _text(object_ref, "resource")

    response_status = _as_mapping(raw.get("responseStatus"))
    if response_status is not None:
        event.code = _response_code(response_status)

    # Presence, never truthiness. audit.go 151-156 tests two runtime.Unknown
    # pointers for nil; `is not None` is that test. {} is present and reports
    # True; null and absent are nil and report False.
    if raw.get("responseObject") is not None:
        event.response_object = True
    if raw.get("requestObject") is not None:
        event.request_object = True

    impersonated = _as_mapping(raw.get("impersonatedUser"))
    if impersonated is not None:
        event.impersonated_user = _text(impersonated, "username")
        groups = impersonated.get("groups")
        if isinstance(groups, list):
            # Sort then join, canonicalising exactly as sort.Strings followed by
            # strings.Join does at audit.go 159-160. The sort is not cosmetic: an
            # expectation carries one canonical string, so skipping it would make
            # matching depend on the order the server happened to serialise the
            # groups in. sorted() also leaves the raw mapping untouched, where
            # Go's in-place sort mutates the very event that
            # first_event_checked and last_event_checked expose.
            event.impersonated_groups = ",".join(sorted(str(group) for group in groups))

    annotations = _as_mapping(raw.get("annotations"))
    if annotations is None:
        # Go indexes a nil map at audit.go 162, which yields "" and routes
        # nothing, leaving all three maps nil.
        return event

    event.authorize_decision = _text(annotations, AUTHORIZATION_DECISION_ANNOTATION_KEY)

    # Accumulated locally and assigned once, so each map stays None unless
    # something actually lands in it. This is Go's lazy
    # `if ... == nil { ... = map[string]string{} }` allocation at audit.go
    # 165-178, and it is what keeps a projected event equal to an expectation
    # that leaves these three unset.
    patch: dict[str, str] | None = None
    mutation: dict[str, str] | None = None
    custom: dict[str, str] | None = None
    for key, value in annotations.items():
        name = str(key)
        text = "" if value is None else str(value)
        # Order matters and follows audit.go 164-179: the patch prefix, then the
        # mutation prefix, then the caller's filter. The filter has to stay last
        # or it could claim a webhook annotation that belongs in one of the two
        # dedicated maps.
        if name.startswith(PATCH_AUDIT_ANNOTATION_PREFIX):
            if patch is None:
                patch = {}
            patch[name] = text
        elif name.startswith(MUTATION_AUDIT_ANNOTATION_PREFIX):
            if mutation is None:
                mutation = {}
            mutation[name] = text
        elif custom_annotations_filter is not None and custom_annotations_filter(name, text):
            if custom is None:
                custom = {}
            custom[name] = text

    event.admission_webhook_patch_annotations = patch
    event.admission_webhook_mutation_annotations = mutation
    event.custom_audit_annotations = custom
    return event


@dataclass
class _TrackedEvent:
    """One expectation and whether it has been seen yet.

    Port of the private `auditEvent` wrapper at audit.go 184-188.
    """

    event: AuditEvent
    found: bool = False


class _AuditEventTracker:
    """Tracks which expectations have been observed. audit.go 190-223.

    Private, as the Go original is: the public surface of this module is the two
    check functions, and the tracker is an implementation detail of them.
    """

    def __init__(self, expected: Iterable[AuditEvent]) -> None:
        """Port of newAuditEventTracker, audit.go 195-203.

        Go copies each AuditEvent by value while sharing the maps it points at,
        which is what its "the Check functions take ownership of these maps"
        comment at audit.go 52-53 warns about. Holding the caller's objects is
        the direct Python equivalent, and nothing here mutates an expectation.
        """
        self._events = [_TrackedEvent(event=event) for event in expected]

    def mark(self, observed: AuditEvent) -> None:
        """Mark every expectation equal to `observed` as found. audit.go 205-212.

        INVARIANT PRESERVED: every match, not merely the first. Go's loop has no
        break, so one observed event satisfies two identical expectations.
        Stopping at the first would leave the duplicate permanently missing and
        the caller polling until it timed out.
        """
        for tracked in self._events:
            if tracked.event == observed:
                tracked.found = True

    def missing(self) -> list[AuditEvent]:
        """Expectations not yet observed, in declaration order. audit.go 214-223.

        Go returns a nil slice when nothing is missing. An empty list is the
        Python equivalent and is what the caller's `len(...) > 0` check reads.
        """
        return [tracked.event for tracked in self._events if not tracked.found]

