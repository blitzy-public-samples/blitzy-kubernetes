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

import hashlib
import json
import os
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Final

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
    "AUDIT_EVENT_KIND",
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
    "redact_event",
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
            f"- first event checked: {self._render_raw(self.first_event_checked)}\n"
            "\n"
            f"- last event checked: {self._render_raw(self.last_event_checked)}\n"
            "\n"
            f"- number of events checked: {self.num_events_checked}\n"
            "\n"
            f"- missing events: {self.missing_events!r}"
        )

    @staticmethod
    def _render_raw(raw: RawEvent | None) -> str:
        """Render a raw observed event for the report, WITHOUT its payload bodies.

        The two raw events are the whole reason this report needs redaction. Go
        renders them with %#v, and on a Secret create in blocking mode the
        `requestObject` member is the Secret - so an unredacted report prints
        credential material into a CI log while explaining why credential material
        must not be logged. `redact_event` keeps the envelope, which is what
        identifies the event, and replaces each payload with its type and size.

        `missing_events` needs no redaction: those are EXPECTATIONS, built by the
        test from `AuditEvent`, which models `request_object` and `response_object`
        as booleans and holds no body at all.
        """
        if raw is None:
            return "None"
        return repr(redact_event(raw))


#: The audit `kind` every line must declare.
#:
#: `audit.Codecs.UniversalDecoder(version)` decodes into an `auditinternal.Event`,
#: which fails on a document whose kind is something else, so requiring it is part
#: of reproducing that decoder rather than an addition to it.
AUDIT_EVENT_KIND: Final[str] = "Event"

#: The wire keys whose VALUE must never be rendered in a diagnostic.
#:
#: `requestObject` and `responseObject` carry the API object bodies. On a Secret
#: event a `responseObject` is the Secret itself, and F-006-RQ-002 exists precisely
#: because that body must not be recorded - so printing it into a CI log while
#: reporting the violation would be the same disclosure by another route. Their
#: PRESENCE and TYPE are what the guard asserts on, and presence and type are all a
#: reader needs, so that is all that is ever shown.
#:
#: `annotations` is included because the authorization annotation can carry a
#: reason string quoting the request, and a webhook patch annotation carries a JSON
#: patch of the object.
_REDACTED_WIRE_KEYS: Final[frozenset[str]] = frozenset(
    {"requestObject", "responseObject", "annotations"}
)

#: Placeholder substituted for a redacted value.
_REDACTED: Final[str] = "<redacted>"

#: Longest REDACTED line rendered in a diagnostic, in characters.
#:
#: It bounds only the output of :func:`redact_event`, i.e. a document whose
#: payload-bearing members have ALREADY been replaced before the cut is made. It
#: is never applied to a raw line: an undecodable line is described by
#: :func:`_undecodable_line_description` and no part of it is rendered, because a truncated
#: leak is still a leak.
#:
#: A blocking-mode audit log line for a create carries the whole request object, so
#: an unbounded excerpt can be many kilobytes of one CI message. The bound is
#: generous enough to show the envelope - level, stage, verb, user, objectRef - and
#: short enough that a failure stays readable.
_MAX_DIAGNOSTIC_CHARS: Final[int] = 400


def redact_event(raw: RawEvent) -> dict[str, object]:
    """Return a copy of ``raw`` with every payload-bearing value replaced by metadata.

    The envelope is preserved verbatim - level, stage, verb, user, objectRef,
    responseStatus - because that is what identifies which event a diagnostic is
    about. Only the members named in :data:`_REDACTED_WIRE_KEYS` are replaced, and
    each is replaced by its JSON type and, for a mapping, its key COUNT: enough to
    tell "present and an object with 5 keys" from "present but a boolean", which is
    exactly the distinction the V6 guard turns on, and nothing more.

    Public because a caller building its own failure message needs the same
    redaction, and because a test can prove the redaction directly.
    """
    redacted: dict[str, object] = {}
    for key, value in raw.items():
        if key not in _REDACTED_WIRE_KEYS or value is None:
            redacted[key] = value
            continue
        if isinstance(value, dict):
            redacted[key] = f"{_REDACTED} object with {len(value)} key(s)"
        elif isinstance(value, list):
            redacted[key] = f"{_REDACTED} array of {len(value)} item(s)"
        else:
            redacted[key] = f"{_REDACTED} {type(value).__name__}"
    return redacted


def _fingerprint(line: str) -> str:
    """Return a short SHA-256 fingerprint of ``line``, for correlation without disclosure.

    Twelve hex characters of a cryptographic digest: enough that two diagnostics
    from the same run can be told to describe the same record or different ones,
    and enough that a reader holding the log can confirm WHICH line is meant by
    hashing it themselves. It discloses nothing about the content, which is the
    whole point -- see :func:`_undecodable_line_description`.
    """
    return hashlib.sha256(line.encode("utf-8", errors="surrogateescape")).hexdigest()[:12]


def _undecodable_line_description(
    line: str,
    *,
    line_number: int | None,
    error: ValueError | None,
    decoded_type: str | None,
) -> str:
    """Describe a record that will not decode, WITHOUT reproducing any of its bytes.

    THE RULE THIS ENFORCES, and it has no exception: audit-log bytes that cannot be
    decoded are never echoed. A field-by-field redaction is only possible once a
    line has decoded to an object, so for everything else the diagnostic is built
    from METADATA alone.

    That restriction is not tidiness. A blocking-mode audit log for a Secret create
    carries the object in ``requestObject``, and a `RequestResponse`-level line
    would carry it in ``responseObject`` as well. A line truncated by a disk-full
    writer, a partially flushed line, or a line written at an unrecognised version
    is exactly the kind of record whose payload survives while its JSON envelope
    does not -- so echoing "just the first 400 characters" of it publishes the very
    material F-006-RQ-002 exists to keep out of the log, into pytest output and
    from there into the JUnit XML that TestGrid and Spyglass archive.

    What is reported instead is everything a reader needs to find and fix the
    record without seeing it: WHERE it is (the one-based line number), HOW BIG it is
    (characters), WHY it failed (the parser's message and position, or the JSON type
    it decoded to when that type is simply not an event), and WHICH record it is
    (:func:`_fingerprint`). The reader has the log; this message tells them which
    line of it to look at.

    Args:
        line: The offending record. Used only to measure and fingerprint it.
        line_number: One-based position in the stream, or ``None`` when the caller
            has no position to report.
        error: The decoder's exception when the bytes were not JSON at all.
        decoded_type: The Python type name the bytes DID decode to, when they were
            valid JSON but not an object.

    Returns:
        A single-line, content-free description.
    """
    parts: list[str] = [_REDACTED, "undecodable audit record"]
    if line_number is not None:
        parts.append(f"line {line_number}")
    parts.append(f"{len(line)} character(s)")
    if decoded_type is not None:
        parts.append(f"decoded as JSON {decoded_type}, which is not an audit event object")
    if error is not None:
        position = ""
        error_line = getattr(error, "lineno", None)
        error_column = getattr(error, "colno", None)
        if isinstance(error_line, int) and isinstance(error_column, int):
            position = f" at line {error_line} column {error_column}"
        parts.append(f"{type(error).__name__}: {error}{position}")
    parts.append(f"sha256:{_fingerprint(line)}")
    return f"<{'; '.join(parts)}>"


def _redacted_line(line: str, *, line_number: int | None = None) -> str:
    """Render one log line for a diagnostic: redacted when decodable, never raw.

    A line that decodes to a JSON OBJECT is rendered through :func:`redact_event`,
    so its envelope is visible and every payload-bearing member is replaced by its
    type and size. Bounding what remains is then safe, because the payload is
    already gone before the cut is made.

    Anything else -- a line that will not parse at all, or one that parses to a
    list or a scalar -- is described by :func:`_undecodable_line_description` and never
    rendered. A scalar is not a document whose members can be located, and a
    scalar in an audit log is as likely to be a fragment of one as anything else.
    """
    try:
        decoded = json.loads(line)
    except ValueError as exc:
        return _undecodable_line_description(
            line, line_number=line_number, error=exc, decoded_type=None
        )
    if not isinstance(decoded, dict):
        return _undecodable_line_description(
            line,
            line_number=line_number,
            error=None,
            decoded_type=type(decoded).__name__,
        )
    rendered = json.dumps(redact_event(decoded), sort_keys=True)
    if len(rendered) <= _MAX_DIAGNOSTIC_CHARS:
        return rendered
    # A redacted envelope that is still oversized: every payload member is already
    # a placeholder, so what remains is envelope metadata and truncating it cannot
    # disclose a body.
    return (
        f"{rendered[:_MAX_DIAGNOSTIC_CHARS]}... "
        f"[truncated, {len(rendered)} characters total]"
    )


class AuditLogDecodeError(Exception):
    """A log line could not be decoded as an audit event of the version asked for.

    This is the port of the error return at audit.go line 109, where
    CheckAuditLinesFiltered abandons the scan and hands back the partial report
    alongside the error. Python has no two-value return, so the report travels
    on the exception: the V6 predicate escalates a decode failure by aborting
    the poll, and the diagnostic gathered so far has to survive that.

    Raised only for a line that cannot be decoded, which covers three cases, all
    three of which Go's UniversalDecoder(version) also fails: the line is not JSON
    or not a JSON object; its apiVersion or kind is not the audit Event of the
    requested version; or one of its members carries the wrong wire TYPE for the
    field it decodes into. A merely-absent expectation is reported through
    MissingEventsReport.missing_events and never raises, which is what keeps the
    poll-until-converged loop working.
    """

    def __init__(self, message: str, report: MissingEventsReport) -> None:
        super().__init__(message)
        # The report as it stood when decoding failed: the lines already
        # consumed are in all_events and num_events_checked is still 0, since
        # Go likewise returns before assigning it at line 129.
        self.report = report


def _as_mapping(value: Any, *, field_path: str) -> RawEvent | None:
    """Narrow a decoded JSON value to a mapping; absent and null give None, anything else raises.

    No single Go statement to port: this stands in for the `!= nil` test Go
    applies to each pointer-to-struct field of an audit event, at audit.go 144
    (ObjectRef), 148 (ResponseStatus) and 157 (ImpersonatedUser). A field that is
    absent, or explicitly null in the log, is nil in Go and None here, so both
    skip the block that would have read it.

    STRICT beyond that `!= nil` test, deliberately. This used to return None for
    ANY non-mapping, which made `"objectRef": "secrets"` indistinguishable from an
    absent objectRef - the projected event kept resource "" and the V6 guard, which
    keys on `resource == "secrets"`, skipped it. Go never reaches that state: its
    decoder cannot put a JSON string into a *ObjectReference and fails the whole
    document, so a wrong type is rejected here rather than read as absence.

    Raises:
        AuditLogDecodeError: if the value is present, not null, and not an object.
    """
    __tracebackhide__ = True
    if value is None:
        return None
    if not isinstance(value, dict):
        raise _shape_error(
            field_path,
            f"expected a JSON object, got {_json_type_name(value)}",
        )
    return value


def _text(mapping: RawEvent | None, key: str, *, field_path: str) -> str:
    """Read a STRING field strictly: absent and null project to "", anything else raises.

    No single Go statement to port: this stands in for what Go's decoder does
    before the composite literal at audit.go 137-143 ever runs. A missing or null
    JSON string becomes the "" zero value there, which is why "" is produced here
    too - an expectation that leaves a field unset must match an event whose field
    is absent.

    STRICT, AND THE STRICTNESS IS THE POINT. This used to end in `str(value)`,
    which coerced a JSON number, boolean, array or object into a string: a line
    carrying `"level": 3` projected to `"3"`, and `"resource": true` projected to
    `"True"`. Neither is what Go does - its decoder rejects the document outright -
    and both turn a malformed line into evidence that can then be MATCHED against
    an expectation. For an audit-fidelity control that is the difference between
    proving a level and proving that some string existed. `"level"` is the field
    F-006-RQ-002 is entirely about, so coercion there is not a cosmetic issue.

    Raises:
        AuditLogDecodeError: if the value is present, not null, and not a string.
    """
    __tracebackhide__ = True
    if mapping is None:
        return ""
    value = mapping.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _shape_error(
            field_path,
            f"expected a JSON string, got {_json_type_name(value)}",
        )
    return value


def _json_type_name(value: object) -> str:
    """Name the JSON type of ``value`` the way a wire-shape message should read.

    The value itself is never included: an audit event's members can carry object
    bodies, and a shape complaint has no need of the content it is complaining
    about (see :data:`_REDACTED_WIRE_KEYS`).
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _shape_error(field_path: str, detail: str) -> AuditLogDecodeError:
    """Build the exception raised for a wrong wire TYPE inside an otherwise-decodable line.

    Carries an empty report rather than the caller's: this is raised from the
    projection, which the public `audit_event_from_raw` can be called without a
    report at all. `check_audit_lines_filtered` catches and re-raises with its own
    partial report attached, so the caller-facing contract is unchanged.

    The message names the field path and the two types and NOTHING ELSE - no value,
    no surrounding line - because a wrong type in an audit event is often a wrong
    type in a member that carries an API object.
    """
    return AuditLogDecodeError(
        f"malformed audit event: {field_path} {detail}. Go's audit decoder rejects this "
        "document rather than coercing it, so it is rejected here too: a coerced value is "
        "evidence that can be matched against an expectation, which would let a malformed "
        "line satisfy F-006-RQ-002.",
        MissingEventsReport(),
    )


def _response_code(response_status: RawEvent) -> int:
    """Project responseStatus.code strictly. audit.go 148-150.

    Go's Code is an int32 with omitempty, so an absent or null code is 0. Anything
    else present must be a JSON integer: a boolean is excluded explicitly because
    `bool` is a subclass of `int` in Python, and a float or a string is rejected
    rather than truncated, matching Go's decoder - which parses an int32 field from
    the literal text with strconv and fails on "403" or 403.5 alike.

    This matters beyond tidiness: the V2 and V7 controls assert an exact 403, so a
    code that arrived as the string "403" and was silently coerced to 403 would let
    a malformed line satisfy a denial assertion.

    Raises:
        AuditLogDecodeError: if `code` is present, not null, and not a JSON integer.
    """
    __tracebackhide__ = True
    value = response_status.get("code")
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int):
        raise _shape_error(
            "responseStatus.code",
            f"expected a JSON integer, got {_json_type_name(value)}",
        )
    return value


def _joined_groups(groups: Any) -> str:
    """Canonicalise impersonatedUser.groups into one comparable string. audit.go 158-160.

    Sort then join, exactly as `sort.Strings` followed by `strings.Join(..., ",")`
    does. The sort is not cosmetic: an expectation carries one canonical string, so
    skipping it would make matching depend on the order the server happened to
    serialise the groups in. sorted() also leaves the raw mapping untouched, where
    Go's in-place sort mutates the very event that first_event_checked and
    last_event_checked expose.

    Absent and null both give "", because Go runs the join unconditionally inside
    the `e.ImpersonatedUser != nil` block and `strings.Join(nil, ",")` is "".

    STRICT on shape. This used to be guarded by `if isinstance(groups, list)` with
    `str(group)` over the members, which meant `"groups": "system:masters"` was read
    as absence and `"groups": [1, 2]` became "1,2". Go's Groups is a []string: a
    string there fails to decode, and so does a numeric member. Both are rejected.

    Raises:
        AuditLogDecodeError: if groups is present, not null, and not an array of
            strings.
    """
    __tracebackhide__ = True
    if groups is None:
        return ""
    if not isinstance(groups, list):
        raise _shape_error(
            "impersonatedUser.groups",
            f"expected a JSON array of strings, got {_json_type_name(groups)}",
        )
    for position, group in enumerate(groups):
        if not isinstance(group, str):
            raise _shape_error(
                f"impersonatedUser.groups[{position}]",
                f"expected a JSON string, got {_json_type_name(group)}",
            )
    return ",".join(sorted(groups))


def _annotation_text(name: str, value: Any) -> str:
    """Read one annotation value strictly. Go's Annotations is a map[string]string.

    A JSON null gives "": unmarshalling null into a map's string value leaves that
    value at its zero, and the key is still present, which is why an annotation
    present-but-null must project to "" rather than being dropped.

    Anything else non-string is rejected. This used to be `str(value)`, which turned
    `{"authorization.k8s.io/decision": true}` into the string "True" - an
    authorize_decision that is neither "allow" nor "forbid" but is nonetheless a
    non-empty string, so it read as a decision having been recorded. Go rejects the
    document instead: `json: cannot unmarshal bool into Go value of type string`.

    The annotation NAME is included in the message and the value is not: annotation
    values carry admission webhook patches, which are request-body fragments.

    Raises:
        AuditLogDecodeError: if the value is present, not null, and not a string.
    """
    __tracebackhide__ = True
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _shape_error(
            f"annotations[{name}]",
            f"expected a JSON string, got {_json_type_name(value)}",
        )
    return value


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


def _strip_line_terminator(raw_line: str) -> str:
    """Remove the line terminator and nothing else. Port of ``bufio.ScanLines``.

    ``ScanLines`` (bufio/scan.go) returns the token up to but excluding the ``\\n``,
    and then calls ``dropCR``, which removes a SINGLE trailing ``\\r`` -- and only
    one, and only when it sat immediately before that newline. It trims no other
    whitespace, from either end.

    Reproducing that exactly is what makes this reader's verdicts the same as Go's.
    ``strip()`` would additionally swallow interior indentation and, worse, would
    turn a whitespace-only record into the empty string that the old blank-line
    skip then discarded -- and a discarded record is a verdict the caller never
    learns about.

    Args:
        raw_line: One record as the line source yielded it, terminator included
            when there was one.

    Returns:
        The record without its terminator.
    """
    if raw_line.endswith("\n"):
        raw_line = raw_line[:-1]
        if raw_line.endswith("\r"):
            raw_line = raw_line[:-1]
    return raw_line


def _decode_failure(line: str, version: str, *, line_number: int | None = None) -> str:
    """Build the decode-failure message, keeping Go's shape from audit.go 109.

    Go's exact wording leads so a reader can grep the two suites for the same
    diagnostic; the requirement this guards is named after it, because the
    reader of a CI failure is often not the author of the test.

    ``line_number`` is the one-based position of the record in the stream. It is
    what makes a content-free diagnostic actionable: the reader cannot be shown the
    bytes (see :func:`_undecodable_line_description`), so they are told exactly
    which line of their own log to open.
    """
    return (
        f"failed decoding buf: {_redacted_line(line, line_number=line_number)},"
        f" apiVersion: {version}"
        " (F-006-RQ-002: sensitive-resource audit fidelity is asserted from the"
        " audit log, so a line that will not decode invalidates the check)"
    )


def _decode_line(
    line: str,
    version: str,
    report: MissingEventsReport,
    *,
    line_number: int | None = None,
) -> RawEvent:
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

    INVARIANT PRESERVED: no raw byte of an undecodable line reaches the message.
    ``line_number`` is threaded in from the scan so the line can still be located
    (F-006-RQ-002, CWE-532) -- see :func:`_undecodable_line_description`.

    Args:
        line: the stripped log line.
        version: the audit apiVersion the line must carry.
        report: the partial report to attach to any raised error.
        line_number: 1-based physical line number within the log, for diagnostics.
    """
    try:
        decoded = json.loads(line)
    except ValueError as exc:
        # ValueError rather than JSONDecodeError: the latter subclasses it, and
        # this also catches the non-strict numeric failures json can raise.
        raise AuditLogDecodeError(
            _decode_failure(line, version, line_number=line_number), report
        ) from exc
    if not isinstance(decoded, dict):
        # Valid JSON, but a scalar or a list is not an audit event.
        raise AuditLogDecodeError(
            _decode_failure(line, version, line_number=line_number), report
        )
    if decoded.get("apiVersion") != version:
        raise AuditLogDecodeError(
            _decode_failure(line, version, line_number=line_number), report
        )
    if decoded.get("kind") != AUDIT_EVENT_KIND:
        # The other half of what UniversalDecoder(version) enforced, and it was
        # missing. Go decodes through the audit scheme, which resolves a document
        # by its FULL GroupVersionKind: apis/audit/install/install.go registers
        # Event and EventList under audit.k8s.io/v1, so a line carrying
        # `"kind": "EventList"`, an empty kind, or no kind at all does not decode
        # into an Event and audit.go 109 returns the error. Checking apiVersion
        # alone accepted every one of those, and an EventList - whose `items` the
        # projection never reads - projected to a wholly empty AuditEvent that
        # then matched nothing while being counted as a checked event.
        raise AuditLogDecodeError(
            _decode_failure(line, version, line_number=line_number), report
        )
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
    # PHYSICAL line number, counted separately from `index`. `index` is Go's `i`
    # and counts DECODED EVENTS, so it does not advance across blank lines and
    # cannot locate a line in the file. A reader handed an undecodable line needs
    # the file position, because the fingerprint deliberately withholds the text
    # (F-006-RQ-002 / CWE-532) and the position is then the only way to find it.
    line_number = 0
    with _line_source(stream) as lines:
        for raw_line in lines:
            # THE LINE TERMINATOR ONLY, NEVER strip(). bufio.ScanLines hands Go the
            # token with its trailing "\n" removed, and its trailing "\r" removed
            # only when that "\r" immediately preceded the newline (dropCR). It does
            # NOT trim interior or leading whitespace, and -- decisively for this
            # loop -- it EMITS a token for a blank line rather than swallowing it,
            # which `runtime.DecodeInto` then fails at audit.go 106-110.
            #
            # NOTHING IS SKIPPED HERE, and that is the fix rather than an omission.
            # A blank or whitespace-only record in an audit log is a real defect: a
            # partially flushed write, a truncated line, a writer that emitted a
            # bare newline. Skipping it let the caller's poll spin to its deadline
            # and then blame a missing event, which points the reader at the API
            # server instead of at the log. Every emitted record is decoded, and the
            # empty token fails with the same content-free diagnostic as any other
            # undecodable one.
            line = _strip_line_terminator(raw_line)
            line_number = index + 1

            raw = _decode_line(line, version, report, line_number=line_number)
            if index == 0:
                report.first_event_checked = raw
            # Every line, so this ends up holding the last one. audit.go 111-114.
            report.last_event_checked = raw

            try:
                event = audit_event_from_raw(raw, custom_annotations_filter)
            except AuditLogDecodeError as exc:
                # The projection raises for a wrong wire TYPE, which Go's decoder
                # would have rejected at audit.go 106-110 before any projection ran.
                # It has no report of its own to hand back, so the partial report
                # gathered so far is attached here, keeping the caller-facing
                # contract identical to a JSON or version failure: one exception
                # type, always carrying a report.
                raise AuditLogDecodeError(str(exc), report) from exc
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

    Every member is read at its declared wire type and a mismatch raises rather
    than being coerced, because Go reaches this function only through a decoder
    that has already rejected any such document. See _text, _as_mapping,
    _response_code, _joined_groups and _annotation_text for the individual rules.

    Raises:
        AuditLogDecodeError: if any member carries the wrong wire type for the
            field it projects onto. Raised with an empty report, since this
            function has no scan state; check_audit_lines_filtered re-raises with
            its own partial report attached.
    """
    event = AuditEvent(
        level=_text(raw, "level", field_path="level"),
        stage=_text(raw, "stage", field_path="stage"),
        request_uri=_text(raw, "requestURI", field_path="requestURI"),
        verb=_text(raw, "verb", field_path="verb"),
        # e.User is a value rather than a pointer in Go, so an absent user is
        # the zero UserInfo and its Username is "".
        user=_text(
            _as_mapping(raw.get("user"), field_path="user"),
            "username",
            field_path="user.username",
        ),
    )

    object_ref = _as_mapping(raw.get("objectRef"), field_path="objectRef")
    if object_ref is not None:
        event.namespace = _text(object_ref, "namespace", field_path="objectRef.namespace")
        # The field the V6 guard keys on: `e.Resource == "secrets"`.
        event.resource = _text(object_ref, "resource", field_path="objectRef.resource")

    response_status = _as_mapping(raw.get("responseStatus"), field_path="responseStatus")
    if response_status is not None:
        event.code = _response_code(response_status)

    # Presence, never truthiness. audit.go 151-156 tests two runtime.Unknown
    # pointers for nil; `is not None` is that test. {} is present and reports
    # True; null and absent are nil and report False.
    if raw.get("responseObject") is not None:
        event.response_object = True
    if raw.get("requestObject") is not None:
        event.request_object = True

    impersonated = _as_mapping(raw.get("impersonatedUser"), field_path="impersonatedUser")
    if impersonated is not None:
        event.impersonated_user = _text(
            impersonated, "username", field_path="impersonatedUser.username"
        )
        event.impersonated_groups = _joined_groups(impersonated.get("groups"))

    annotations = _as_mapping(raw.get("annotations"), field_path="annotations")
    if annotations is None:
        # Go indexes a nil map at audit.go 162, which yields "" and routes
        # nothing, leaving all three maps nil.
        return event

    event.authorize_decision = _text(
        annotations,
        AUTHORIZATION_DECISION_ANNOTATION_KEY,
        field_path=f"annotations[{AUTHORIZATION_DECISION_ANNOTATION_KEY}]",
    )

    # Accumulated locally and assigned once, so each map stays None unless
    # something actually lands in it. This is Go's lazy
    # `if ... == nil { ... = map[string]string{} }` allocation at audit.go
    # 165-178, and it is what keeps a projected event equal to an expectation
    # that leaves these three unset.
    patch: dict[str, str] | None = None
    mutation: dict[str, str] | None = None
    custom: dict[str, str] | None = None
    for key, value in annotations.items():
        # json.loads only ever produces string keys for an object, so `key` is
        # already a str; naming it keeps the loop readable next to Go's
        # `for k, v := range e.Annotations`.
        name = key
        text = _annotation_text(name, value)
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
