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

"""Contract tests for ``tests.helpers.audit_log``: wire-shape strictness and body redaction.

AAP §0.5.1 (the ``python/tests/helpers/audit_log.py`` row: the ``CheckAuditLines``
and ``MissingEventsReport`` port) / §0.4.2.2 (the V6 blueprint, whose
CONFIDENTIALITY GUARD is the reason this module exists) / §0.10.2 (the audit-level
and confidentiality boundary conditions, none of which may be relaxed) / §0.7.2
(assertion density, failure legibility, structural isolation) / tech-spec §6.6.3.4
(the documentation convention).

INVARIANTS LOCKED BY THIS MODULE. Each is a property the V6 port silently depends
on, and none of them is observable from a happy-path test:

1. A MALFORMED LINE IS REJECTED, NOT COERCED INTO MATCHABLE EVIDENCE. Go reaches
   the projection only through ``audit.Codecs.UniversalDecoder(version)``, which
   fails any document whose members carry the wrong wire type. A port that
   stringified them instead would let ``"level": 3`` project to the level
   ``"3"`` and ``"objectRef": "secrets"`` project to no resource at all - the
   first invents evidence, the second hides it from the confidentiality guard,
   and F-006-RQ-002 is entirely about ``level``.
2. ``kind`` IS HALF THE DECODER CONTRACT. The audit scheme resolves a document by
   its full GroupVersionKind, so an ``EventList`` or a kind-less line is not an
   Event and does not decode. Checking ``apiVersion`` alone accepted both.
3. ABSENT AND NULL STILL PROJECT TO THE GO ZERO VALUE. Strictness must not cost
   the property that an expectation leaving a field unset matches an event whose
   field is absent - that is what every V6 expectation is written against.
4. NO SECRET BODY EVER REACHES A DIAGNOSTIC. The V6 guard exists because a
   ``responseObject`` on a Secret event defeats the control; a report or an
   exception message that printed the body would defeat it just as thoroughly, in
   a JUnit artifact instead of an audit log.
5. RAW DIAGNOSTICS ARE BOUNDED, so one pathological line cannot flood the report.
6. PRESENCE, NEVER TRUTHINESS, for ``requestObject`` and ``responseObject``: an
   empty-but-present body is the regression the guard catches.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.helpers.audit_log import (
    AUDIT_EVENT_KIND,
    AuditEvent,
    AuditLogDecodeError,
    MissingEventsReport,
    check_audit_lines,
    check_audit_lines_filtered,
    redact_event,
)

# The one version the audit scheme registers, and the one every V6 call passes.
VERSION = "audit.k8s.io/v1"

# The literal the V3 fixture uses as its plaintext marker. Reused here as the
# thing that must NEVER appear in a diagnostic: if this string can be recovered
# from a failure message, so can a real Secret's data.
CANARY = "BLITZY_PLAINTEXT_CANARY"


def line(**overrides: Any) -> str:
    """Render one well-formed audit line, with ``overrides`` applied.

    A JSON object with the right ``kind`` and ``apiVersion`` and a Secret
    ``objectRef``, so every negative case below differs from a PASSING line in
    exactly the one member under test. ``None`` is a real override value here -
    the null-projection cases need it - so absence is spelled by popping the key.
    """
    event: dict[str, Any] = {
        "kind": AUDIT_EVENT_KIND,
        "apiVersion": VERSION,
        "level": "Request",
        "stage": "ResponseComplete",
        "requestURI": "/api/v1/namespaces/secret-audit-request/secrets",
        "verb": "create",
        "user": {"username": "admin"},
        "objectRef": {"resource": "secrets", "namespace": "secret-audit-request"},
        "responseStatus": {"code": 201},
    }
    event.update(overrides)
    for key in [key for key, value in overrides.items() if value is _ABSENT]:
        del event[key]
    return json.dumps(event)


class _Absent:
    """Sentinel for "delete this key", distinct from an explicit JSON null."""

    def __repr__(self) -> str:  # pragma: no cover - diagnostic only
        return "<absent>"


_ABSENT = _Absent()


# The expectation that the unmodified `line()` projects onto. Written the way a
# V6 call site writes one: only the fields it cares about, every other field
# left at its Go zero value.
BASELINE_EXPECTATION = AuditEvent(
    level="Request",
    stage="ResponseComplete",
    request_uri="/api/v1/namespaces/secret-audit-request/secrets",
    verb="create",
    code=201,
    user="admin",
    resource="secrets",
    namespace="secret-audit-request",
)


# ---------------------------------------------------------------------------
# 1. The happy path, so every rejection below is known to differ in one member
# ---------------------------------------------------------------------------


def test_well_formed_line_matches_its_expectation() -> None:
    """A conforming line projects onto its expectation and reports nothing missing."""
    report = check_audit_lines([line()], [BASELINE_EXPECTATION], VERSION)

    assert report.missing_events == []
    assert report.num_events_checked == 1
    assert report.all_events == [BASELINE_EXPECTATION]


# ---------------------------------------------------------------------------
# 2. Wrong wire TYPE is rejected rather than coerced  (finding #15)
# ---------------------------------------------------------------------------

# Each row is one member carrying a type Go's decoder cannot put into the field
# it decodes onto, paired with the field path the message must name. The
# `id` explains, in the node identifier, what the coercion would have produced.
WRONG_TYPE_CASES: list[tuple[dict[str, Any], str]] = [
    ({"level": 3}, "level"),
    ({"level": True}, "level"),
    ({"level": ["Request"]}, "level"),
    ({"level": {"value": "Request"}}, "level"),
    ({"stage": 1}, "stage"),
    ({"requestURI": 7}, "requestURI"),
    ({"verb": False}, "verb"),
    ({"user": "admin"}, "user"),
    ({"user": ["admin"]}, "user"),
    ({"user": {"username": 42}}, "user.username"),
    ({"objectRef": "secrets"}, "objectRef"),
    ({"objectRef": ["secrets"]}, "objectRef"),
    ({"objectRef": {"resource": True}}, "objectRef.resource"),
    ({"objectRef": {"namespace": 0}}, "objectRef.namespace"),
    ({"responseStatus": 201}, "responseStatus"),
    ({"responseStatus": {"code": "201"}}, "responseStatus.code"),
    ({"responseStatus": {"code": 201.5}}, "responseStatus.code"),
    ({"responseStatus": {"code": True}}, "responseStatus.code"),
    ({"responseStatus": {"code": [201]}}, "responseStatus.code"),
    ({"impersonatedUser": "system:masters"}, "impersonatedUser"),
    ({"impersonatedUser": {"username": ["u"]}}, "impersonatedUser.username"),
    ({"impersonatedUser": {"groups": "system:masters"}}, "impersonatedUser.groups"),
    ({"impersonatedUser": {"groups": {"0": "a"}}}, "impersonatedUser.groups"),
    ({"impersonatedUser": {"groups": ["a", 2]}}, "impersonatedUser.groups[1]"),
    ({"impersonatedUser": {"groups": [None]}}, "impersonatedUser.groups[0]"),
    ({"annotations": ["a"]}, "annotations"),
    ({"annotations": "decision"}, "annotations"),
    ({"annotations": {"authorization.k8s.io/decision": True}}, "annotations[authorization"),
    ({"annotations": {"patch.webhook.admission.k8s.io/x": 1}}, "annotations[patch.webhook"),
]


@pytest.mark.parametrize(
    ("override", "field_path"),
    WRONG_TYPE_CASES,
    ids=[f"{path}={next(iter(o.values()))!r}"[:70] for o, path in WRONG_TYPE_CASES],
)
def test_wrong_wire_type_is_rejected_naming_the_field(
    override: dict[str, Any], field_path: str
) -> None:
    """A member of the wrong JSON type raises, and the message names the field.

    The alternative - the behaviour this replaces - was to stringify it. That is
    not a cosmetic difference: a coerced value is EVIDENCE, and evidence can be
    matched against an expectation, so a malformed line could satisfy
    F-006-RQ-002 instead of failing it.
    """
    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([line(**override)], [], VERSION)

    assert field_path in str(raised.value)


@pytest.mark.parametrize(
    ("override", "field_path"),
    WRONG_TYPE_CASES,
    ids=[f"{path}"[:70] for _, path in WRONG_TYPE_CASES],
)
def test_wrong_wire_type_never_reports_the_offending_value(
    override: dict[str, Any], field_path: str
) -> None:
    """The message names the two TYPES and never the value.

    An audit event's members carry API objects - a ``responseObject`` body, an
    admission-webhook patch - so a shape complaint that quoted what it found
    would be a body-disclosure path with a different name.
    """
    del field_path

    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([line(**override)], [], VERSION)

    message = str(raised.value)
    assert "expected a JSON" in message
    assert ", got " in message


def test_wrong_type_exception_still_carries_a_report() -> None:
    """A shape rejection hands back the partial report, like a decode failure.

    ``audit_event_from_raw`` has no scan state of its own, so
    ``check_audit_lines_filtered`` re-raises with its own. Without that the
    caller-facing contract would differ between two failures a caller cannot
    distinguish in advance.
    """
    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([line(), line(level=3)], [BASELINE_EXPECTATION], VERSION)

    report = raised.value.report
    assert isinstance(report, MissingEventsReport)
    # Seeded with every expectation before the first line is read, and the first
    # line was consumed before the second one failed.
    assert report.missing_events == [BASELINE_EXPECTATION]
    assert report.all_events == [BASELINE_EXPECTATION]
    assert report.first_event_checked is not None


# ---------------------------------------------------------------------------
# 3. kind is enforced  (finding #15)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "override",
    [
        {"kind": "EventList"},
        {"kind": "Pod"},
        {"kind": ""},
        {"kind": None},
        {"kind": 1},
        {"kind": _ABSENT},
    ],
    ids=["EventList", "Pod", "empty", "null", "number", "absent"],
)
def test_wrong_or_missing_kind_does_not_decode(override: dict[str, Any]) -> None:
    """Only ``kind: Event`` decodes, because the audit scheme resolves a full GVK.

    ``EventList`` is the sharp case: it is registered under the same group and
    version, so an apiVersion-only check accepted it, and its ``items`` are never
    read - so it projected to a wholly empty AuditEvent that matched nothing while
    still counting as a checked event.
    """
    with pytest.raises(AuditLogDecodeError):
        check_audit_lines([line(**override)], [], VERSION)


def test_wrong_api_version_still_does_not_decode() -> None:
    """The pre-existing half of the decoder contract is unchanged."""
    with pytest.raises(AuditLogDecodeError):
        check_audit_lines([line(apiVersion="audit.k8s.io/v1beta1")], [], VERSION)


@pytest.mark.parametrize(
    "text",
    ["not json at all", "[]", '"a string"', "42", "null", "{", '{"kind": "Event"'],
    ids=["prose", "array", "string", "number", "null", "truncated", "unterminated"],
)
def test_undecodable_line_raises(text: str) -> None:
    """A line that is not a JSON object is a hard failure, never a skipped line.

    Skipping would let the caller's 500 ms poll spin to its timeout and then blame
    a missing event, hiding the real cause.
    """
    with pytest.raises(AuditLogDecodeError):
        check_audit_lines([text], [], VERSION)


# ---------------------------------------------------------------------------
# 4. Strictness must not cost the Go zero-value projection  (regression guard)
# ---------------------------------------------------------------------------


def test_absent_and_null_members_project_to_the_go_zero_value() -> None:
    """Absent and explicitly null both give "" / 0 / None, as Go's decoder does.

    This is what lets a V6 expectation set only the fields it cares about. If
    strictness had been implemented as "present and correctly typed or reject",
    every real audit line - which omits most members - would have failed.
    """
    sparse = json.dumps(
        {
            "kind": AUDIT_EVENT_KIND,
            "apiVersion": VERSION,
            "level": None,
            "stage": "ResponseComplete",
            "requestURI": None,
            "user": None,
            "objectRef": None,
            "responseStatus": None,
            "impersonatedUser": None,
            "annotations": None,
        }
    )

    report = check_audit_lines([sparse], [AuditEvent(stage="ResponseComplete")], VERSION)

    assert report.missing_events == []
    projected = report.all_events[0]
    assert projected.level == ""
    assert projected.request_uri == ""
    assert projected.user == ""
    assert projected.resource == ""
    assert projected.code == 0
    assert projected.impersonated_groups == ""
    assert projected.admission_webhook_patch_annotations is None
    assert projected.custom_audit_annotations is None


def test_null_annotation_value_is_present_and_empty() -> None:
    """``{"k": null}`` in a map[string]string leaves the key present with "".

    Dropping the key instead would change which of the three annotation maps gets
    lazily allocated, and an event whose maps differ from an expectation's does
    not match it.
    """
    report = check_audit_lines(
        [line(annotations={"patch.webhook.admission.k8s.io/round_1": None})],
        [],
        VERSION,
    )

    projected = report.all_events[0]
    assert projected.admission_webhook_patch_annotations == {
        "patch.webhook.admission.k8s.io/round_1": ""
    }


def test_impersonated_groups_are_sorted_then_joined() -> None:
    """``sort.Strings`` then ``strings.Join(..., ",")``, so matching is order-free.

    Skipping the sort would make the assertion depend on the order the server
    happened to serialise the groups in.
    """
    report = check_audit_lines(
        [line(impersonatedUser={"username": "u", "groups": ["zeta", "alpha", "mu"]})],
        [],
        VERSION,
    )

    assert report.all_events[0].impersonated_groups == "alpha,mu,zeta"


def test_impersonated_groups_absent_gives_empty_string() -> None:
    """Go joins unconditionally inside the non-nil block, and ``Join(nil, ",")`` is ""."""
    report = check_audit_lines([line(impersonatedUser={"username": "u"})], [], VERSION)

    assert report.all_events[0].impersonated_user == "u"
    assert report.all_events[0].impersonated_groups == ""


@pytest.mark.parametrize(
    ("body", "expected"),
    [({}, True), ({"data": {}}, True), (None, False), (_ABSENT, False)],
    ids=["empty-object-present", "populated", "null", "absent"],
)
def test_bodies_are_presence_tests_not_truthiness_tests(body: Any, expected: bool) -> None:
    """An EMPTY-but-present responseObject must report True.

    This is the whole point of the V6 guard: a truthiness test would report ``{}``
    as absent, and an empty-but-present Secret response body is exactly the
    regression the guard exists to catch.
    """
    report = check_audit_lines([line(responseObject=body, requestObject=body)], [], VERSION)

    projected = report.all_events[0]
    assert projected.response_object is expected
    assert projected.request_object is expected


# ---------------------------------------------------------------------------
# 5. No body ever reaches a diagnostic  (finding #16)
# ---------------------------------------------------------------------------

SECRET_BODY = {"data": {"api_key": CANARY}, "stringData": {"token": CANARY}}


def test_redact_event_preserves_the_envelope_and_replaces_the_bodies() -> None:
    """The envelope is diagnostic and stays; the payload members become metadata."""
    raw = json.loads(line(responseObject=SECRET_BODY, requestObject=SECRET_BODY))

    redacted = redact_event(raw)

    assert redacted["kind"] == AUDIT_EVENT_KIND
    assert redacted["level"] == "Request"
    assert redacted["objectRef"] == {
        "resource": "secrets",
        "namespace": "secret-audit-request",
    }
    assert redacted["responseObject"] == "<redacted> object with 2 key(s)"
    assert redacted["requestObject"] == "<redacted> object with 2 key(s)"
    assert CANARY not in json.dumps(redacted)


@pytest.mark.parametrize(
    ("body", "rendered"),
    [
        ({"a": 1, "b": 2}, "<redacted> object with 2 key(s)"),
        ([1, 2, 3], "<redacted> array of 3 item(s)"),
        ("a string body", "<redacted> str"),
        (7, "<redacted> int"),
        (True, "<redacted> bool"),
    ],
    ids=["object", "array", "string", "number", "boolean"],
)
def test_redaction_reports_shape_only_for_every_wire_type(body: Any, rendered: str) -> None:
    """Whatever type the body arrived as, only its shape survives redaction.

    A wrong-typed body is exactly the case a redactor must not fall through on:
    ``"responseObject": "<the secret>"`` is a scalar, so a redactor that only
    handled objects would print it verbatim.
    """
    raw = json.loads(line())
    raw["responseObject"] = body

    assert redact_event(raw)["responseObject"] == rendered


@pytest.mark.parametrize("key", ["responseObject", "requestObject", "annotations"])
def test_an_explicitly_null_payload_member_is_kept_verbatim(key: str) -> None:
    """A JSON null is preserved as null, and that is not an exemption from redaction.

    ``null`` discloses nothing - there is no content to withhold - and it is
    load-bearing diagnostic information: "explicitly null" versus "an object with 0
    keys" is precisely the distinction the presence projection turns on, so a
    diagnostic that rendered both as ``<redacted>`` would hide the reason a guard
    did or did not fire. The redactor withholds VALUES, not the fact of a member
    having no value.
    """
    raw = json.loads(line())
    raw[key] = None

    assert redact_event(raw)[key] is None


def test_report_str_never_discloses_a_body() -> None:
    """``MissingEventsReport.__str__`` renders first/last through the redactor.

    The report is what a V6 failure prints, and the events it names are the very
    ones carrying Secret bodies - so an unredacted report would put a Secret in a
    JUnit artifact, defeating the control it was reporting on.
    """
    report = check_audit_lines(
        [line(responseObject=SECRET_BODY, requestObject=SECRET_BODY)],
        [AuditEvent(level="Metadata", verb="get")],
        VERSION,
    )

    rendered = str(report)
    assert CANARY not in rendered
    assert "<redacted> object with 2 key(s)" in rendered
    # Still diagnostic: the envelope, the count and the expectation survive.
    assert "missing 1 events" in rendered
    assert "secrets" in rendered
    assert "number of events checked: 1" in rendered
    # And the projection itself still saw the body, so the guard can fire.
    assert report.all_events[0].response_object is True


def test_decode_failure_message_never_discloses_a_body() -> None:
    """A line that fails to decode is reported redacted, not verbatim.

    Go interpolates the raw buffer here. A malformed line is the MOST likely one
    to carry an unexpected body, so this is where verbatim reporting would hurt.
    """
    undecodable = json.dumps(
        {"kind": "EventList", "apiVersion": VERSION, "responseObject": SECRET_BODY}
    )

    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([undecodable], [], VERSION)

    message = str(raised.value)
    assert CANARY not in message
    assert "<redacted>" in message
    # Go's wording still leads, so the two suites are greppable for one string.
    assert message.startswith("failed decoding buf:")


def test_unparseable_line_is_described_never_echoed() -> None:
    """A record that will not parse is described from METADATA ONLY - none of it is shown.

    A line cannot be redacted member by member until it has decoded to an object,
    so for everything else the diagnostic carries no bytes of the record at all.
    That is not fastidiousness: a truncated or partially flushed Secret event is
    precisely the record whose ``requestObject`` survives while its JSON envelope
    does not, and echoing "just the first few hundred characters" of it publishes
    the very body F-006-RQ-002 exists to keep out of the log - into pytest output,
    and from there into the JUnit XML that TestGrid and Spyglass archive.

    What must be reported instead is everything needed to FIND the record without
    seeing it: which line, how long, why it failed, and a fingerprint that ties two
    diagnostics to the same record. The reader already holds the log.
    """
    flood = CANARY + "x" * 20_000

    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([flood], [], VERSION)

    message = str(raised.value)
    # NOT ONE BYTE OF THE RECORD. The canary would leak a body; the filler proves
    # that no prefix of the record survives either, which a truncating excerpt
    # would have left in place.
    assert CANARY not in message
    assert "xxxxxxxxxx" not in message
    # Metadata only, and all of it: the marker, the position, the size, the
    # parser's own complaint and the fingerprint.
    assert "<redacted>" in message
    assert "undecodable audit record" in message
    assert "line 1" in message
    assert f"{len(flood)} character(s)" in message
    assert "JSONDecodeError" in message
    assert "sha256:" in message
    # And the whole message stays readable: a description is bounded by
    # construction, so one pathological record cannot flood a CI log.
    assert len(message) < 1_000


def test_valid_json_that_is_not_an_object_is_described_never_echoed() -> None:
    """A scalar or array record is reported by its JSON TYPE, with none of its content.

    ``json.loads`` succeeds here, so the old code path fell through to echoing the
    line. A JSON array of Secret bodies decodes perfectly well and is not an audit
    event, which is exactly the shape that made the fallback unsafe.
    """
    payload = json.dumps([SECRET_BODY, SECRET_BODY])

    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([payload], [], VERSION)

    message = str(raised.value)
    assert CANARY not in message
    assert "decoded as JSON list, which is not an audit event object" in message
    assert "sha256:" in message


def test_the_fingerprint_identifies_the_record_without_disclosing_it() -> None:
    """Two diagnostics for the same record share a fingerprint; different records do not.

    That is what makes a content-free message actionable at all: a reader holding
    the log can hash the line themselves and confirm WHICH record is meant, and a
    reader comparing two failures can tell one record from two.
    """

    def fingerprint_of(record: str) -> str:
        with pytest.raises(AuditLogDecodeError) as raised:
            check_audit_lines([record], [], VERSION)
        message = str(raised.value)
        marker = "sha256:"
        start = message.index(marker) + len(marker)
        return message[start : message.index(">", start)]

    first = fingerprint_of("not json at all")
    again = fingerprint_of("not json at all")
    other = fingerprint_of("also not json")

    assert first == again
    assert first != other


def test_line_fingerprint_reports_the_physical_line_number() -> None:
    """The reported position is the 1-BASED PHYSICAL line, not a decoded-event index.

    Since the text is withheld, the position is the only way to find the offending
    line, so it has to be the number an editor would show. Go's own loop counter
    (``for i = 0; scanner.Scan(); i++`` at test/utils/audit.go 103) is 0-based and
    is what ``num_events_checked`` reports, so a diagnostic that reused it would be
    off by one on every line of every log -- consistently enough to look right.

    The third record is the offender: a 1-based physical position says "line 3",
    while the 0-based counter would say "line 2", and BOTH are asserted so the two
    cannot be confused. Blank records are deliberately not used to make the point --
    they are a decode failure in their own right, which
    :func:`test_a_blank_record_is_a_decode_failure_not_a_skip` locks separately.
    """
    good = json.dumps(
        {"kind": "Event", "apiVersion": VERSION, "level": "Metadata", "verb": "get"}
    )

    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines([good, good, "{not json"], [], VERSION)

    message = str(raised.value)
    # Two records decode before it, so the offender is physical line 3.
    assert "line 3" in message
    assert "line 2" not in message



def test_empty_report_renders_without_raising() -> None:
    """The seeded, never-populated report is the one a caller prints first."""
    rendered = str(MissingEventsReport())

    assert "missing 0 events" in rendered
    assert "first event checked: None" in rendered
    assert "last event checked: None" in rendered


# ---------------------------------------------------------------------------
# 6. Scan mechanics preserved
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("records", "offending_line"),
    [
        pytest.param(["", line()], 1, id="empty-first"),
        pytest.param([line(), ""], 2, id="empty-last"),
        pytest.param([line(), "   ", line()], 2, id="whitespace-only-interior"),
    ],
)
def test_a_blank_record_is_a_decode_failure_not_a_skip(
    records: list[str], offending_line: int
) -> None:
    """A blank or whitespace-only record FAILS, naming its line. Go fails it too.

    ``bufio.Scanner`` with ``ScanLines`` emits a token for a blank line - it does
    not swallow it - and ``runtime.DecodeInto`` then fails that empty buffer at
    audit.go 106-110. Skipping it here was a silent divergence with a real cost: a
    partially flushed or truncated write disappeared from the scan, the caller's
    500 ms poll spun to its deadline, and the failure it finally reported was
    "missing events" - which points the reader at the API server rather than at the
    log line that was actually broken.

    The line number is asserted because a content-free diagnostic is only
    actionable if it says WHERE.
    """
    with pytest.raises(AuditLogDecodeError) as raised:
        check_audit_lines(records, [], VERSION)

    message = str(raised.value)
    assert f"line {offending_line}" in message
    assert "undecodable audit record" in message
    assert "0 character(s)" in message or "3 character(s)" in message


def test_a_trailing_newline_in_a_real_log_yields_no_extra_record(tmp_path: Path) -> None:
    """A blocking-mode log ends with "\\n" and still reports exactly its own events.

    This is the legitimate concern the old blank-line skip was reaching for, and it
    needs no skip: iterating a file object yields one string per line and produces
    NO final empty element for the terminating newline, exactly as
    ``bufio.Scanner`` produces no final token. ``num_events_checked`` therefore
    equals Go's ``i`` without anything being discarded.
    """
    log = tmp_path / "kube-apiserver-audit.log"
    log.write_text(f"{line()}\n{line()}\n", encoding="utf-8")

    report = check_audit_lines(log, [], VERSION)

    assert report.num_events_checked == 2
    assert len(report.all_events) == 2


def test_a_carriage_return_before_the_newline_is_dropped(tmp_path: Path) -> None:
    """CRLF records decode. ``dropCR`` removes exactly one "\\r", and only before "\\n".

    Without that, a log written on a CRLF stream would fail every line with a JSON
    error - a decoder difference from Go masquerading as a broken audit log.
    """
    log = tmp_path / "crlf-audit.log"
    log.write_bytes(f"{line()}\r\n".encode())

    report = check_audit_lines(log, [], VERSION)

    assert report.num_events_checked == 1


def test_all_events_is_a_superset_the_guard_can_scan() -> None:
    """Every projected event is retained, not just the ones an expectation wanted.

    The confidentiality guard scans ``all_events``; trimming it to the missing
    events would leave the guard passing while Secret payloads reached the log.
    """
    unexpected_secret_response = line(responseObject={})

    report = check_audit_lines(
        [line(), unexpected_secret_response],
        [BASELINE_EXPECTATION],
        VERSION,
    )

    assert report.missing_events == []
    assert len(report.all_events) == 2
    offenders = [
        event
        for event in report.all_events
        if event.resource == "secrets" and event.response_object
    ]
    assert len(offenders) == 1


def test_custom_annotations_filter_routes_only_what_it_claims() -> None:
    """The caller's filter runs LAST, after both dedicated prefixes.

    Ordering matters: a filter that ran first could claim a webhook annotation
    that belongs in one of the two dedicated maps.
    """
    report = check_audit_lines_filtered(
        [
            line(
                annotations={
                    "patch.webhook.admission.k8s.io/round_0": "[]",
                    "mutation.webhook.admission.k8s.io/round_0": "{}",
                    "authorization.k8s.io/decision": "allow",
                }
            )
        ],
        [],
        VERSION,
        lambda key, value: key.startswith(("patch.", "mutation.", "authorization.")),
    )

    projected = report.all_events[0]
    assert projected.authorize_decision == "allow"
    assert projected.admission_webhook_patch_annotations == {
        "patch.webhook.admission.k8s.io/round_0": "[]"
    }
    assert projected.admission_webhook_mutation_annotations == {
        "mutation.webhook.admission.k8s.io/round_0": "{}"
    }
    # Only the decision reached the filter, because the other two were claimed.
    assert projected.custom_audit_annotations == {"authorization.k8s.io/decision": "allow"}
