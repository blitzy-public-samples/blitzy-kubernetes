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

"""Contract tests for ``tests.helpers.jwtclaims``: decoder strictness and credential hygiene.

AAP §0.5.1 (the ``python/tests/helpers/jwtclaims.py`` row: the ``getPayload`` /
``getSubObject`` / ``checkExpiration`` port) / §0.4.2.2 (the V4 blueprint) /
§0.10.2 (the token-expiry window and claim-shape boundary conditions, neither of
which may be relaxed) / §0.7.2 (failure legibility, assertion density) /
tech-spec §6.6.3.4 (the documentation convention).

INVARIANTS LOCKED BY THIS MODULE:

1. THE SERIALISATION IS ACCEPTED ONLY IN THE FORM GO ACCEPTS. Three
   dot-separated segments, and the payload segment in the UNPADDED base64url
   alphabet. ``base64.RawURLEncoding`` rejects a padded segment and rejects any
   character outside the alphabet; a helper that accepted either would read a
   token the API server's own verifier would refuse - so V4 could pass on a token
   that was never issued.
2. NO CLAIM VALUE, AND NO TOKEN, EVER REACHES A FAILURE MESSAGE. Go interpolates
   both and can afford to; this suite publishes JUnit XML, and a claim value can
   be the credential. The mismatch report is a fingerprint that is nonetheless
   FALSIFIABLE: a reader who suspects a value can hash their candidate.
3. ABSENT AND NULL ARE INDISTINGUISHABLE IN ``get_sub_object`` and DISTINGUISHABLE
   IN ``has_sub_object``. The first is Go fidelity - a missing map key marshals to
   ``null``; the second is what the V4 requirement "``pod`` and ``secret`` both
   exactly null" actually needs, since an absent claim is not proof of an unbound
   token.
4. THE COMPARISON IS EXACT, AGAINST JSON TEXT. No coercion, no substring match,
   no normalisation - the claim shape V4 asserts is written the way Go marshals it.
5. ``kubernetes.io`` IS ONE KEY. Splitting it on "." would silently assert a
   different claim than the one V4 names.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import pytest

from tests.helpers.jwtclaims import (
    check_payload,
    decode_claims,
    get_payload,
    get_sub_object,
    has_sub_object,
)

# The V4 claim set, exactly as svcaccttoken_test.go asserts it: audience bound to
# "api", a namespaced ServiceAccount subject, and pod and secret sub-claims that
# are PRESENT and NULL - a non-null value in either is the legacy or
# bound-to-object token that V4 exists to catch.
V4_CLAIMS: dict[str, Any] = {
    "aud": ["api"],
    "exp": 1_770_000_000,
    "iss": "https://foo.bar.example.com",
    "sub": "system:serviceaccount:token-ns:token-sa",
    "kubernetes.io": {
        "namespace": "token-ns",
        "serviceaccount": {"name": "token-sa", "uid": "sa-uid-1"},
        "pod": None,
        "secret": None,
    },
}


def b64url(payload: bytes) -> str:
    """Encode ``payload`` in the UNPADDED base64url alphabet Go's RawURLEncoding uses."""
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def token_for(claims: dict[str, Any]) -> str:
    """Build a JWS compact serialisation carrying ``claims``.

    The signature segment is a literal: this module ports helpers that read the
    payload and never verify a signature, which is what makes them usable against
    a token whose signature is opaque to the test.
    """
    return f"{b64url(b'{}')}.{b64url(json.dumps(claims).encode())}.c2ln"


V4_TOKEN = token_for(V4_CLAIMS)
V4_PAYLOAD = json.dumps(V4_CLAIMS)


# ---------------------------------------------------------------------------
# 1. The V4 claim shape, asserted exactly as the Go call sites do
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("want", "parts"),
    [
        ('["api"]', ("aud",)),
        ('"system:serviceaccount:token-ns:token-sa"', ("sub",)),
        ('"token-ns"', ("kubernetes.io", "namespace")),
        ('"token-sa"', ("kubernetes.io", "serviceaccount", "name")),
        ("null", ("kubernetes.io", "pod")),
        ("null", ("kubernetes.io", "secret")),
        ("1770000000", ("exp",)),
    ],
    ids=["aud", "sub", "namespace", "sa-name", "pod-null", "secret-null", "exp"],
)
def test_v4_claim_shape_compares_exactly_against_json_text(want: str, parts: tuple[str, ...]) -> None:
    """Every claim V4 asserts arrives as the JSON text Go's ``json.Marshal`` emits.

    Strings QUOTED, arrays COMPACT, a numeric claim as bare digits for the caller
    to parse - which is exactly what the Go V4 test does with ``exp``
    (``strconv.ParseInt(getSubObject(...), 10, 64)``).
    """
    check_payload(V4_TOKEN, want, *parts)
    assert get_sub_object(V4_PAYLOAD, *parts) == want


def test_kubernetes_io_is_one_key_not_two_levels() -> None:
    """A claim name containing a dot is never split.

    ``"kubernetes.io.pod"`` therefore asks for a claim of that LITERAL name, which
    no token has, and is reported absent rather than silently resolving to the
    nested value - which would make the assertion pass while testing a different
    claim than the one V4 names.
    """
    assert get_sub_object(V4_PAYLOAD, "kubernetes.io", "pod") == "null"
    assert get_sub_object(V4_PAYLOAD, "kubernetes.io.pod") == "null"
    # Identical text, opposite meanings - which is why only the second is absent.
    assert has_sub_object(V4_PAYLOAD, "kubernetes.io", "pod") is True
    assert has_sub_object(V4_PAYLOAD, "kubernetes.io.pod") is False


def test_present_and_null_is_distinguished_from_absent() -> None:
    """``has_sub_object`` draws the line Go cannot, and V4 needs it drawn.

    ``get_sub_object`` returns "null" for both, faithfully: a missing key in a
    ``map[string]interface{}`` yields a nil ``interface{}`` that marshals to null.
    But "the pod sub-claim is absent" is NOT proof of an unbound token - a token
    from a server that never emits the claim at all would satisfy it - so the V4
    assertion needs presence AND nullity.
    """
    without_pod = {"kubernetes.io": {"secret": None}}

    assert get_sub_object(json.dumps(without_pod), "kubernetes.io", "pod") == "null"
    assert has_sub_object(json.dumps(without_pod), "kubernetes.io", "pod") is False
    assert has_sub_object(json.dumps(without_pod), "kubernetes.io", "secret") is True


@pytest.mark.parametrize(
    ("wrong", "parts"),
    [
        ('["api","other"]', ("aud",)),
        ('"api"', ("aud",)),
        ("[]", ("aud",)),
        ('{"name":"victim"}', ("kubernetes.io", "pod")),
        ('""', ("kubernetes.io", "namespace")),
    ],
    ids=["extra-audience", "scalar-audience", "empty-audience", "bound-pod", "empty-namespace"],
)
def test_a_wrong_claim_is_a_failure_not_a_near_miss(wrong: str, parts: tuple[str, ...]) -> None:
    """The comparison is exact: no substring match and no normalisation.

    ``["api","other"]`` is the case that matters most - a token whose audience is a
    superset of the requested one is NOT audience-bound, and a substring or
    membership comparison would pass it.
    """
    claims = json.loads(V4_PAYLOAD)
    target: Any = claims
    for part in parts[:-1]:
        target = target[part]
    target[parts[-1]] = json.loads(wrong)

    with pytest.raises(AssertionError):
        check_payload(token_for(claims), get_sub_object(V4_PAYLOAD, *parts), *parts)


# ---------------------------------------------------------------------------
# 2. Serialisation strictness  (finding #18)
# ---------------------------------------------------------------------------


def padded_segment(claims: dict[str, Any], pad_width: int) -> str:
    """Return a base64url payload segment that genuinely carries ``pad_width`` "=".

    Padding appears only for a body whose length is not a multiple of three, so the
    body is grown until it is - constructing the case rather than assuming a fixed
    claim set produces it.
    """
    filler = 0
    while True:
        body = json.dumps({**claims, "pad": "p" * filler}).encode()
        encoded = base64.urlsafe_b64encode(body).decode("ascii")
        if encoded.count("=") == pad_width:
            return encoded
        filler += 1


@pytest.mark.parametrize("pad_width", [1, 2], ids=["one-pad-char", "two-pad-chars"])
def test_a_padded_payload_segment_is_refused(pad_width: int) -> None:
    """Go's ``RawURLEncoding`` rejects "=", so this must too.

    Re-padding an already-padded segment appends NOTHING when its length is already
    a multiple of four, so without an explicit check Python's decoder accepts a
    serialisation Go's verifier refuses. A token is a credential: a helper that
    reads a form the server would not issue can pass V4 on a token that never
    existed.
    """
    segment = padded_segment(V4_CLAIMS, pad_width)
    assert segment.count("=") == pad_width

    with pytest.raises(AssertionError, match="base64 padding"):
        get_payload(f"aGRy.{segment}.c2ln")

    # The same body without its padding is still accepted, so the rule costs
    # nothing a real token needs.
    decoded = get_payload(f"aGRy.{segment.rstrip('=')}.c2ln")
    assert json.loads(decoded)["sub"] == V4_CLAIMS["sub"]


@pytest.mark.parametrize(
    "segment_count",
    [1, 2, 4, 5],
    ids=["one-segment", "two-segments", "four-segments", "five-segments"],
)
def test_only_a_three_segment_serialisation_is_accepted(segment_count: int) -> None:
    """svcaccttoken_test.go L1312-1315 fatals unless there are exactly three parts.

    Four segments is a JWE, not a JWS; two is a truncated token. Reading the second
    segment of either would inspect something that is not a claim set.
    """
    with pytest.raises(AssertionError, match="compact serialisation"):
        get_payload(".".join(["aGRy"] * segment_count))


@pytest.mark.parametrize(
    "segment",
    ["ab*d", "eyJhIjox!", "ey J", "eyJhIjox\n", "eyJhIjox~"],
    ids=["asterisk", "bang", "space", "newline", "tilde"],
)
def test_a_character_outside_the_alphabet_is_refused(segment: str) -> None:
    """``urlsafe_b64decode`` DISCARDS such characters; Go returns an error.

    Measured: ``base64.urlsafe_b64decode("ab*d=")`` returns ``b"i\\xb7"``. A corrupt
    segment must fail, not decode to plausible garbage that then fails to parse as
    JSON somewhere less legible.
    """
    with pytest.raises(AssertionError, match="base64url-decode"):
        get_payload(f"aGRy.{segment}.c2ln")


@pytest.mark.parametrize(
    "segment",
    ["«»", "eyJhIjox\u00e9", "\u00ff"],
    ids=["guillemets", "trailing-accent", "latin1-high"],
)
def test_a_non_ascii_segment_is_refused_before_reaching_the_decoder(segment: str) -> None:
    """A non-ASCII segment must not be handed to ``base64.b64decode`` at all.

    Two defects live here and both were real. ``b64decode`` raises a BARE
    ``ValueError`` for non-ASCII input rather than the ``binascii.Error`` an
    alphabet violation raises, so it escaped the handler and surfaced unhandled;
    and it raises from inside ``base64.py`` with the segment bound as a frame
    local, so a traceback renderer showing locals would print credential material.
    Refusing here fixes both, and matches Go, whose ``RawURLEncoding`` rejects the
    first offending byte.
    """
    with pytest.raises(AssertionError, match="non-ASCII") as raised:
        get_payload(f"aGRy.{segment}.c2ln")

    assert segment not in str(raised.value)


def test_a_payload_that_is_not_json_is_refused_legibly() -> None:
    """The parser's position is reported; the payload text is not.

    ``get_payload`` returns the decoded TEXT, as Go's does, so JSON validity is
    asserted by whoever parses it - which is ``get_sub_object``.
    """
    token = f"aGRy.{b64url(b'{not json')}.c2ln"

    assert get_payload(token) == "{not json"
    with pytest.raises(AssertionError, match="not valid JSON") as raised:
        get_sub_object(get_payload(token), "sub")

    assert "not json" not in str(raised.value)


# ---------------------------------------------------------------------------
# 3. Nothing from the token reaches a failure message  (finding #19)
# ---------------------------------------------------------------------------

# A claim set whose every value would be damaging in a published CI artifact.
SENSITIVE_SUBJECT = "system:serviceaccount:kube-system:privileged-controller"
SENSITIVE_CLAIMS: dict[str, Any] = {
    "aud": ["https://internal-audience.example.invalid"],
    "sub": SENSITIVE_SUBJECT,
    "kubernetes.io": {
        "namespace": "kube-system",
        "pod": {"name": "victim-pod", "uid": "pod-uid-7"},
        "secret": {"name": "victim-secret", "uid": "secret-uid-9"},
    },
}
SENSITIVE_TOKEN = token_for(SENSITIVE_CLAIMS)


@pytest.mark.parametrize(
    ("want", "parts", "leaked"),
    [
        ('"system:serviceaccount:ns:sa"', ("sub",), SENSITIVE_SUBJECT),
        ("null", ("kubernetes.io", "pod"), "victim-pod"),
        ("null", ("kubernetes.io", "secret"), "victim-secret"),
        ('["api"]', ("aud",), "internal-audience"),
    ],
    ids=["subject", "bound-pod", "bound-secret", "audience"],
)
def test_a_mismatch_never_prints_the_observed_value(
    want: str, parts: tuple[str, ...], leaked: str
) -> None:
    """``saw:`` is a fingerprint; ``want:`` is echoed verbatim.

    The asymmetry is the point: ``want`` was written into the test source by its
    author, so publishing it discloses nothing new, while ``saw`` came out of a real
    token.
    """
    with pytest.raises(AssertionError) as raised:
        check_payload(SENSITIVE_TOKEN, want, *parts)

    message = str(raised.value)
    assert leaked not in message
    assert want in message
    # The path is named, so the reader knows WHICH claim was wrong.
    assert parts[-1] in message


def test_the_fingerprint_reports_type_and_length_and_a_digest() -> None:
    """Three facts, and together they diagnose every V4 mismatch.

    The TYPE alone resolves the largest class: the regression V4 catches is a
    non-null pod or secret sub-claim, and "a JSON object with 2 key(s)" versus
    "null" says so completely.
    """
    with pytest.raises(AssertionError) as raised:
        check_payload(SENSITIVE_TOKEN, "null", "kubernetes.io", "pod")

    message = str(raised.value)
    assert "a JSON object with 2 key(s)" in message
    assert "character(s)" in message
    assert "sha256:" in message


def test_the_fingerprint_is_falsifiable_by_a_reader_who_knows_the_value() -> None:
    """A reader can confirm a suspected value by hashing it, without the tool.

    That is what keeps the report diagnostic rather than merely descriptive: the
    value is recoverable by someone who already knows it, and by nobody else. The
    digest is over the exact serialisation, so it is stable across runs.
    """
    serialised = json.dumps(SENSITIVE_SUBJECT, separators=(",", ":"), sort_keys=True)
    expected = hashlib.sha256(serialised.encode("utf-8")).hexdigest()[:12]

    with pytest.raises(AssertionError) as raised:
        check_payload(SENSITIVE_TOKEN, '"wrong"', "sub")

    assert f"sha256:{expected}" in str(raised.value)


def test_a_null_observation_is_fully_described_by_its_type() -> None:
    """Nothing is withheld when the observed value is null: there is no content.

    So the fingerprint of a null is a complete report, not a redacted one - which
    matters because "we expected a bound pod and saw null" is a legitimate V4
    failure a reader must be able to read at a glance.
    """
    with pytest.raises(AssertionError) as raised:
        check_payload(V4_TOKEN, '{"name":"expected-pod"}', "kubernetes.io", "pod")

    assert "JSON null" in str(raised.value)


def test_a_whole_payload_comparison_is_refused() -> None:
    """A zero-part call would put EVERY claim into the failure message.

    Every Go call site passes at least one key, so refusing the shape costs nothing
    and closes the one route by which the fingerprinting above could be bypassed.
    """
    with pytest.raises(AssertionError, match="at least one claim key"):
        check_payload(V4_TOKEN, "{}")

    # get_sub_object still accepts it: there the value is RETURNED to the caller
    # rather than embedded in a published message.
    assert json.loads(get_sub_object(V4_PAYLOAD))["sub"] == V4_CLAIMS["sub"]


@pytest.mark.parametrize(
    "parts",
    [("sub", "nested"), ("aud", "0"), ("exp", "seconds")],
    ids=["through-string", "through-array", "through-number"],
)
def test_descending_through_a_non_object_names_the_type_not_the_value(
    parts: tuple[str, ...],
) -> None:
    """Go panics here on a failed type assertion; this reports the same verdict legibly."""
    with pytest.raises(AssertionError, match="not a JSON object") as raised:
        get_sub_object(V4_PAYLOAD, *parts)

    message = str(raised.value)
    assert V4_CLAIMS["sub"] not in message
    assert "credential material" in message


def test_an_absent_mid_path_key_reports_the_keys_that_are_present() -> None:
    """Key NAMES are disclosed; values are not.

    A claim name is not credential material - ``aud``, ``sub``, ``kubernetes.io`` -
    and without them an absent-key failure is undiagnosable.
    """
    with pytest.raises(AssertionError) as raised:
        get_sub_object(V4_PAYLOAD, "kubernetes.io", "absent", "deeper")

    message = str(raised.value)
    assert "'namespace'" in message
    assert "'serviceaccount'" in message
    assert V4_CLAIMS["sub"] not in message


def test_decode_claims_returns_the_mapping_for_a_caller_that_needs_it() -> None:
    """The value-returning route is unrestricted: it hands data back, not a message."""
    claims = decode_claims(V4_TOKEN)

    assert claims["sub"] == V4_CLAIMS["sub"]
    assert claims["aud"] == ["api"]
