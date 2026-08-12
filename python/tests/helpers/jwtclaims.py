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

"""Projected ServiceAccount token claim inspection, ported from the Go V4 test.

This module ports the claim helpers of
``test/integration/auth/svcaccttoken_test.go`` - ``getPayload`` (L1310-1321),
``getSubObject`` (L1293-1308), ``checkPayload`` (L1275-1281) and
``checkExpiration`` (L1283-1291) - which are what the V4 ServiceAccount-token
hygiene assertions are built out of: the audience binding, the token's actual
lifetime and the exact ``kubernetes.io`` claim shape.

WHAT THE CONSUMER DOES WITH THIS

``tests/integration/test_svcacct_token.py`` reads a token exactly as the Go test
does, by composing the two accessors and comparing against JSON TEXT::

    payload = get_payload(token)
    check_payload(token, '["api"]', "aud")
    exp = int(get_sub_object(payload, "exp"))

The comparison being against JSON text rather than Python values is the whole
point of ``get_sub_object`` and is not incidental: the Go original returns
``string(json.Marshal(obj))``, so ``"ns"`` arrives quoted, ``["api"]`` arrives
compact and an absent or null claim arrives as the four characters ``null``.
A port that returned Python objects would silently change what every one of the
seven V4 call sites asserts.

THE SIGNATURE IS NOT VERIFIED, DELIBERATELY

``getPayload`` base64url-decodes the middle segment and nothing else. It never
looks at the signature, never fetches a key and never validates a claim.
Verification would need the server's JWKS and would test a different property -
that the issuer signed the token - in place of the property V4 exists to test,
which is what the token SAYS. So no function here verifies a signature, and no
function here validates ``exp``, ``aud``, ``iss``, ``nbf`` or ``iat``. In
particular an expired token must still be inspectable, because bounding the
lifetime of a token is precisely the assertion being made.

CREDENTIAL HYGIENE: ONE DELIBERATE DIVERGENCE FROM THE GO ORIGINAL

A projected ServiceAccount token is a live credential in shape, and a test
failure message ends up in CI logs, a JUnit artifact and an issue paste. The Go
original interpolates the token into its failure message
(``t.Fatalf("token did not have three parts: %v", b)``). This port does NOT: it
reports the SEGMENT COUNT, the segment length or the JSON error position, and
never the token, never a whole payload and never a value it was not asked
about. That is the single place where this module is stricter than the Go code
it ports rather than faithful to it, it costs no diagnostic power that matters,
and it is called out here so a future reader does not "fix" it back.

WHAT THIS MODULE IS NOT

* NOT the +-60 second expiry window. ``check_expiration`` echoes the returned
  TokenRequest spec; the window that bounds the JWT ``exp`` claim and
  ``status.expirationTimestamp`` against ``request_time + 3600s`` lives in the
  consuming test, and the leeway and the TTL are deliberately not defined,
  defaulted or made tunable anywhere in this file.
* NOT time-aware. Nothing here reads the clock, so nothing here needs freezing;
  the one assertion in the V4 surface that must stay a real wall-clock
  comparison is unaffected by this module.
* NOT a fixture module and NOT a test module. It declares no ``@pytest.fixture``
  (those belong to a ``conftest.py``, since an inline module-, package- or
  session-scoped autouse fixture can execute twice under ``--doctest-modules``),
  no ``test_*`` function and no ``Test*`` class, so it contributes nothing to
  collection.
* NOT stateful. Every function is pure with respect to module state: the only
  module-level names are immutable constants, two typing Protocols and the
  functions themselves.
"""

# AAP §0.5.1 (the python/tests/helpers/jwtclaims.py row: "getPayload /
# getSubObject / checkExpiration port via PyJWT") / §0.4.2.2 (the V4 integration
# blueprint: audience binding, expiry boundary, claim shape) / §0.10.2 (the
# token-expiry-window and claim-shape boundary conditions) / tech-spec §6.6.1.2.
#
# INVARIANT LOCKED BY THIS FILE: a projected ServiceAccount token is read the
# way test/integration/auth/svcaccttoken_test.go reads it - payload only,
# signature NEVER verified, no claim validated - and every claim is compared as
# the exact JSON TEXT that Go's json.Marshal produces. Five properties are
# load-bearing and none may be relaxed:
#
#   1. Exactly three dot-separated segments, or the read fails. Softening this
#      would let a truncated or concatenated token be inspected as though it
#      were well formed.
#   2. Unpadded base64url, decoded strictly. Go's base64.RawURLEncoding rejects
#      any character outside the URL-safe alphabet; base64.urlsafe_b64decode
#      would SILENTLY DISCARD such characters and return plausible garbage
#      (measured: base64.urlsafe_b64decode("ab*d=") returns b"i\xb7"), so this
#      module decodes with validate=True instead. See _decode_segment.
#   3. Compact, key-sorted serialisation, because that is what Go emits and what
#      the Go call sites compare against. See _dump_json.
#   4. "kubernetes.io" is ONE claim key that happens to contain a dot. No
#      function here ever splits a key on "." - callers pass an explicit
#      sequence of key names. Splitting would break the exact claim V4 asserts.
#   5. The claim shape asserted by V4 must be expressible verbatim: sub ==
#      "system:serviceaccount:<ns>:<sa>", kubernetes.io.namespace and
#      kubernetes.io.serviceaccount.name present, and kubernetes.io.pod and
#      kubernetes.io.secret both exactly null. Non-null pod or secret sub-claims
#      indicate a legacy or bound-to-object token, which is the regression V4
#      exists to catch.
#
# ASSERTION SEMANTICS. The Go helpers ported here split cleanly in two, and the
# split is preserved rather than collapsed. getPayload and getSubObject use
# t.Fatalf (abort immediately: the token could not be read at all, so every
# later assertion would be meaningless), while checkPayload and checkExpiration
# use t.Errorf (record the finding and carry on, so one run reports every
# offending claim instead of only the first). Both map onto AssertionError here,
# and which behaviour the caller gets is the caller's choice: raised inside
# `with subtests.test(...)` the finding is recorded and the test continues,
# exactly like t.Errorf; raised outside one it aborts, exactly like t.Fatalf.
# Every function that can raise sets __tracebackhide__, the analogue of the
# t.Helper() call every Go original makes, so a failure points at the assertion
# in the test rather than at a line in this file.
#
# REQUIREMENT IDENTIFIERS. Failure messages name F-004-RQ-001/002 jointly,
# which is how the plan itself cites them for V4 (AAP §0.4.2.2, §0.5.1). The
# plan never partitions the pair, so no split is invented here.

import base64
import binascii
import json
from datetime import datetime
from typing import Protocol

import jwt

__all__ = [
    "TokenRequestLike",
    "TokenRequestSpecLike",
    "check_expiration",
    "check_payload",
    "decode_claims",
    "expected_epoch_expiry",
    "get_payload",
    "get_sub_object",
    "has_sub_object",
]

# A JWS compact serialisation is header.payload.signature - three segments,
# joined by two dots. Named rather than inlined because the count IS the
# precondition ported from svcaccttoken_test.go L1313.
_JWS_COMPACT_SEGMENTS = 3

# Index of the payload (claims) segment. getPayload decodes parts[1] and only
# parts[1]; the signature segment is never read, which is what keeps this module
# faithful for a token whose signature is malformed.
_PAYLOAD_SEGMENT_INDEX = 1

# What Go's json.Marshal emits for a nil interface{}, which is what an absent
# map key unmarshals to. Returned verbatim so an absent or explicitly null
# claim is indistinguishable here, as it is in Go - see get_sub_object and
# has_sub_object for the two halves of that story.
_JSON_NULL = "null"

# The joint requirement identifier for V4, prefixed to every failure message so
# a CI failure reads as a requirement violation rather than a value mismatch.
_RQ = "F-004-RQ-001/002"


def _render_path(parts: tuple[str, ...]) -> str:
    """Render a claim path for a failure message, one explicit key per index.

    ``("kubernetes.io", "serviceaccount", "name")`` renders as
    ``payload['kubernetes.io']['serviceaccount']['name']``. Rendering each key
    as its own subscript is deliberate documentation inside the error message
    itself: it shows that ``kubernetes.io`` was treated as a single key rather
    than as two levels of nesting.

    Only key NAMES appear, never claim values, so this is safe to put in a
    message that reaches a CI log.
    """
    if not parts:
        return "payload"
    return "payload" + "".join(f"[{part!r}]" for part in parts)


def _describe_json_type(value: object) -> str:
    """Name the JSON type of ``value`` WITHOUT revealing the value itself.

    Failure messages need to say why a descent could not continue - "you asked
    for a key of something that is not an object" - and they must say it without
    printing claim material into a CI log. This maps a decoded JSON value onto
    its RFC 8259 type name and stops there.
    """
    if value is None:
        return "JSON null"
    if isinstance(value, bool):
        # Checked before int: bool is a subclass of int in Python, so the
        # obvious ordering would report every JSON boolean as a number.
        return "a JSON boolean"
    if isinstance(value, (int, float)):
        return "a JSON number"
    if isinstance(value, str):
        return "a JSON string"
    if isinstance(value, list):
        return f"a JSON array of {len(value)} element(s)"
    if isinstance(value, dict):
        return f"a JSON object with {len(value)} key(s)"
    return f"a value of Python type {type(value).__name__}"


def _dump_json(value: object) -> str:
    """Serialise ``value`` the way Go's ``encoding/json.Marshal`` would.

    Three settings, each measured against Go rather than chosen by taste:

    * ``separators=(",", ":")`` - Go emits no whitespace, so ``["api"]`` must
      not become ``["api", ]`` or gain a space after the colon. Every list and
      object comparison in the V4 surface depends on this.
    * ``sort_keys=True`` - Go marshals a ``map[string]interface{}`` with its
      keys sorted, and ``getSubObject`` unmarshals into exactly that type. Only
      reachable when a caller asks for a whole sub-object rather than a leaf, so
      it changes nothing the V4 call sites assert, and it removes a difference
      that would otherwise appear the first time one did.
    * ``ensure_ascii=False`` - Go does not escape non-ASCII characters, while
      Python's default would render them as ``\\uXXXX``.

    THREE RESIDUAL DIFFERENCES FROM GO, recorded so a future claim that hits one
    is handled knowingly rather than by accident. None of them can occur in the
    V4 claim surface, whose asserted values are the audience ``["api"]``, a
    ``system:serviceaccount:...`` subject, DNS-label namespace and
    ServiceAccount names, two nulls and one integer:

    1. Go escapes ``<``, ``>`` and ``&`` to ``\\u003c``, ``\\u003e`` and
       ``\\u0026``; Python does not. RFC 1123 label names cannot contain them.
    2. Go escapes U+2028 and U+2029; Python with ``ensure_ascii=False`` does
       not.
    3. Go renders a float64 whose value is integral without a fractional part
       (``1``), where Python renders ``1.0``. Every number in the V4 surface is
       a JSON integer, which both render identically.

    Go's escaper is deliberately NOT re-implemented here: that would add an
    unverifiable transformation between the token and a security assertion, to
    fix a case that cannot arise.
    """
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def _require_compact_serialization(token: str) -> list[str]:
    """Split ``token`` on "." and require exactly three segments.

    Ported from ``getPayload`` at svcaccttoken_test.go L1312-1315, which splits
    on "." and calls ``t.Fatalf`` unless there are three parts. The precondition
    is kept exactly as strict as the original.

    The message reports the SEGMENT COUNT and never the token. That is the one
    deliberate divergence from the Go original, which interpolates the token
    itself; see the credential-hygiene note in the module docstring.
    """
    __tracebackhide__ = True

    segments = token.split(".")
    if len(segments) != _JWS_COMPACT_SEGMENTS:
        raise AssertionError(
            f"{_RQ}: token is not a JWS compact serialisation: expected "
            f"{_JWS_COMPACT_SEGMENTS} dot-separated segments, saw {len(segments)}. "
            "The token is deliberately not reported: it is credential material."
        )
    return segments


def _decode_segment(segment: str) -> bytes:
    """Decode one unpadded base64url segment, as strictly as Go does.

    Ported from ``base64.RawURLEncoding.DecodeString(parts[1])`` at
    svcaccttoken_test.go L1316. Two details are easy to get wrong and both are
    handled explicitly:

    * PADDING. ``RawURLEncoding`` is the UNPADDED alphabet, while Python's
      decoders require the input length to be a multiple of four. A base64
      segment is short by two "=" when its length mod 4 is 2, by one when it is
      3, and by none when it is 0, so the segment is re-padded before decoding.
      Omitting this raises ``binascii.Error`` on roughly three quarters of real
      tokens, which reads as a flaky test rather than as a bug.
    * STRICTNESS. ``base64.urlsafe_b64decode`` silently DISCARDS characters
      outside the alphabet - measured:
      ``base64.urlsafe_b64decode("ab*d=")`` returns ``b"i\\xb7"`` - so a corrupt
      segment would decode to plausible garbage instead of failing. Go's
      ``RawURLEncoding`` returns an error instead, so this uses
      ``base64.b64decode`` with ``altchars`` for the URL-safe alphabet and
      ``validate=True``, which raises on the first character outside it.
    """
    __tracebackhide__ = True

    # -len(s) % 4 is 0, 3, 2, 1 for lengths 0, 1, 2, 3 mod 4. A length of 1 mod
    # 4 is not producible by any base64 encoder, and the deliberately strict
    # decode below rejects it rather than guessing, exactly as Go does.
    padded = segment + "=" * (-len(segment) % 4)
    try:
        return base64.b64decode(padded, altchars=b"-_", validate=True)
    except binascii.Error as exc:
        # binascii.Error subclasses ValueError; catching the precise type keeps
        # a genuine programming error from being swallowed as bad input. Its
        # messages carry no input bytes - "Only base64 data is allowed",
        # "Incorrect padding", "Invalid base64-encoded string: ..." - so
        # including it leaks nothing while keeping the failure diagnosable.
        raise AssertionError(
            f"{_RQ}: failed to base64url-decode the token payload segment "
            f"({len(segment)} characters): {exc}. The segment is deliberately "
            "not reported: it is credential material."
        ) from exc


def _load_payload(payload: str) -> object:
    """Parse payload TEXT into decoded JSON, reporting a failure legibly.

    Ported from ``json.Unmarshal([]byte(b), &obj)`` at svcaccttoken_test.go
    L1297-1299, whose failure is a ``t.Fatalf``. Returns ``object`` rather than
    a mapping because a payload is only conventionally a JSON object: a
    non-object payload must fail at the first descent with a legible message
    rather than at import of an assumption.

    The message carries the parser's position, never the payload text.
    """
    __tracebackhide__ = True

    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"{_RQ}: the token payload is not valid JSON ({len(payload)} characters): "
            f"{exc.msg} at line {exc.lineno} column {exc.colno}. The payload is "
            "deliberately not reported: it is credential material."
        ) from exc


def get_payload(token: str) -> str:
    """Return the decoded claims segment of ``token`` as JSON TEXT.

    Ports ``getPayload`` from test/integration/auth/svcaccttoken_test.go
    L1310-1321.

    INVARIANT PRESERVED: a token is read by decoding its middle segment and
    nothing else - exactly three dot-separated segments required, unpadded
    base64url decoded strictly, signature never touched, no claim validated. An
    expired token, or one whose signature is malformed or absent, still yields
    its claims, because bounding a token's lifetime is the assertion V4 makes
    and a helper that refused to read an expired token could not make it.

    Returns the ORIGINAL payload bytes decoded as UTF-8 text, not a re-encoding
    of a parsed structure, so that:

    * the return value composes with ``get_sub_object`` exactly as the Go call
      sites compose them - ``get_sub_object(get_payload(token), "aud")``; and
    * nothing about the payload is normalised in transit. A parsed-then-
      re-serialised payload could differ from what the API server actually
      emitted in key order or number formatting, and this module must not be
      able to launder such a difference away.

    This is also why PyJWT is not used here even though it is a pinned
    dependency of this tier: ``jwt.decode`` returns a parsed mapping rather than
    the original bytes, and - measured against the pinned 2.13.0 - it also
    base64-decodes the SIGNATURE segment, raising
    ``DecodeError("Invalid crypto padding")`` for a token whose signature is not
    valid base64url. The Go original never reads that segment. Callers who want
    parsed claims have ``decode_claims`` for it.

    Args:
        token: A JWS compact serialisation, ``header.payload.signature``.

    Returns:
        The claims segment as UTF-8 text, ready for ``get_sub_object``.

    Raises:
        AssertionError: If the token does not have exactly three segments, if
            the claims segment is not valid unpadded base64url, or if it does
            not decode as UTF-8. No message contains the token, any segment or
            any claim value.
    """
    __tracebackhide__ = True

    segments = _require_compact_serialization(token)
    raw = _decode_segment(segments[_PAYLOAD_SEGMENT_INDEX])
    try:
        # RFC 7519 requires the JOSE payload to be UTF-8. Go's string(payload)
        # cannot fail here because a Go string is a byte sequence, so the Go
        # original defers the failure to json.Unmarshal; Python must choose a
        # codec, and an explicit decode with a legible message is the better
        # failure. Either way a non-UTF-8 payload fails the test - only the line
        # it fails on differs.
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AssertionError(
            f"{_RQ}: the token payload segment decoded to {len(raw)} bytes that are "
            f"not valid UTF-8 ({exc.reason} at byte offset {exc.start}). RFC 7519 "
            "requires a UTF-8 payload. The bytes are deliberately not reported: "
            "they are credential material."
        ) from exc


def get_sub_object(payload: str, *parts: str) -> str:
    """Descend ``payload`` by an explicit key sequence and return JSON TEXT.

    Ports ``getSubObject`` from test/integration/auth/svcaccttoken_test.go
    L1293-1308.

    INVARIANT PRESERVED: the return value is what Go's ``json.Marshal`` emits
    for the value found, so callers compare against JSON text and not against
    Python values. Concretely, for the claims a V4 token carries::

        get_sub_object(payload, "aud")                                 '["api"]'
        get_sub_object(payload, "sub")        '"system:serviceaccount:ns:sa"'
        get_sub_object(payload, "kubernetes.io", "namespace")             '"ns"'
        get_sub_object(payload, "kubernetes.io", "serviceaccount", "name")
                                                                         '"sa"'
        get_sub_object(payload, "kubernetes.io", "pod")                  'null'
        get_sub_object(payload, "kubernetes.io", "secret")               'null'
        get_sub_object(payload, "exp")                             '1770000000'

    Strings therefore arrive QUOTED, arrays arrive COMPACT, and a numeric claim
    arrives as bare digits for the caller to parse - which is exactly what the
    Go V4 test does with the ``exp`` claim
    (``strconv.ParseInt(getSubObject(...), 10, 64)``).

    ``kubernetes.io`` IS ONE KEY. It is a single JSON claim name that happens to
    contain a dot, not two levels of nesting, so the path is passed as an
    explicit sequence of key names and this function NEVER splits a key on ".".
    Passing the single string ``"kubernetes.io.pod"`` therefore asks for a claim
    of that literal name, which no token has, and is reported as absent rather
    than silently succeeding.

    ABSENT VERSUS NULL. Go cannot tell them apart: a missing key in a
    ``map[string]interface{}`` yields a nil ``interface{}``, which marshals to
    ``null``. This function reproduces that faithfully - an absent FINAL key
    returns ``"null"``. Use ``has_sub_object`` when a call site needs the
    stronger "present and exactly null" check, which is the V4 requirement for
    the ``pod`` and ``secret`` sub-claims.

    Args:
        payload: Claims segment as JSON text, normally from ``get_payload``.
        *parts: Claim keys to descend, one per level, each taken literally.
            With no parts the whole payload is re-serialised.

    Returns:
        The value at the path, serialised as compact, key-sorted JSON.

    Raises:
        AssertionError: If ``payload`` is not valid JSON, or if a descent cannot
            continue because the value at that point is not a JSON object - the
            legible equivalent of the nil type assertion that panics in Go. The
            message names the path traversed and the JSON TYPE found, never a
            value.
    """
    __tracebackhide__ = True

    current = _load_payload(payload)
    for index, part in enumerate(parts):
        traversed = parts[:index]
        if not isinstance(current, dict):
            # Go reaches this state as `obj.(map[string]interface{})` on a
            # non-map - a panic. Raising names the path and the type instead,
            # which is the same verdict with a usable message.
            raise AssertionError(
                f"{_RQ}: cannot descend to {part!r}: {_render_path(traversed)} is "
                f"{_describe_json_type(current)}, not a JSON object. The value is "
                "deliberately not reported: it is credential material."
            )
        if part not in current:
            if index + 1 == len(parts):
                # Go fidelity: an absent final key marshals to null.
                return _JSON_NULL
            # An absent key mid-path leaves Go holding nil and panicking on the
            # next iteration's type assertion. Report the real cause here.
            raise AssertionError(
                f"{_RQ}: claim {part!r} is absent from {_render_path(traversed)}, so "
                f"the remaining path {list(parts[index + 1 :])} cannot be resolved. "
                f"Keys present at that level: {sorted(current)}."
            )
        current = current[part]
    return _dump_json(current)


def has_sub_object(payload: str, *parts: str) -> bool:
    """Report whether a claim path is PRESENT, distinguishing null from absent.

    A deliberate strengthening with no Go counterpart, and the reason it is a
    separate entry point rather than folded into ``get_sub_object``: folding it
    in would change the meaning of a byte-faithful port.

    WHY IT EXISTS. ``getSubObject`` returns the string ``null`` both for a claim
    that is explicitly JSON ``null`` and for one that is absent entirely,
    because in Go a missing map key is indistinguishable from a nil value. So
    the Go V4 assertion ``checkPayload(t, "null", "kubernetes.io", "pod")``
    passes if the ``pod`` sub-claim is null AND ALSO if the ``pod`` sub-claim
    has vanished from the token. This predicate lets a call site require the
    former::

        assert has_sub_object(payload, "kubernetes.io", "pod")
        check_payload(token, "null", "kubernetes.io", "pod")

    WHY IT DOES NOT BREAK PARITY. Today's tokens carry ``pod`` and ``secret``
    explicitly as null, so the stricter check passes today exactly as the Go
    check does. The verdict is unchanged, and verdict equality is what the
    parity contract compares. The strengthening only bites on a FUTURE
    regression in which the sub-claim disappears altogether - which Go would
    silently accept as ``null`` - so it is assurance gained without changing any
    observed outcome.

    Total by design: it answers the question for any path rather than raising.
    A path is absent if any key along it is missing OR if it runs into a value
    that is not a JSON object, since a claim cannot be nested inside a string, a
    number or null. Keys are taken literally, never split on ".", so
    ``has_sub_object(payload, "kubernetes.io.pod")`` is ``False``.

    Args:
        payload: Claims segment as JSON text, normally from ``get_payload``.
        *parts: Claim keys to descend, one per level, each taken literally.
            With no parts the payload itself is the subject, so the answer is
            ``True``.

    Returns:
        ``True`` if every key along the path exists, whatever its value.

    Raises:
        AssertionError: Only if ``payload`` is not valid JSON, which is a broken
            precondition rather than an answer to the question asked.
    """
    __tracebackhide__ = True

    current = _load_payload(payload)
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return True


def check_payload(token: str, want: str, *parts: str) -> None:
    """Assert that the claim at ``parts`` serialises to exactly ``want``.

    Ports ``checkPayload`` from test/integration/auth/svcaccttoken_test.go
    L1275-1281, which is ``getSubObject(getPayload(tok), parts...)`` compared
    against a wanted string with ``t.Errorf``.

    INVARIANT PRESERVED: the comparison is EXACT and against JSON text, so
    ``want`` is written the way the Go call sites write it - ``'["api"]'`` for
    the audience, ``'"ns"'`` (quoted) for a namespace, ``'null'`` for an unbound
    sub-claim. No coercion, no substring match, no normalisation.

    ACCUMULATE OR ABORT IS THE CALLER'S CHOICE. The Go original records the
    finding with ``t.Errorf`` and continues, so one run reports every wrong
    claim rather than only the first. Raised inside ``with subtests.test(...)``
    this behaves the same way; raised outside one it aborts, like ``t.Fatalf``.
    The V4 port wants the former for its five claim-shape checks.

    Args:
        token: A JWS compact serialisation.
        want: The expected value as JSON text, exactly as Go would marshal it.
        *parts: Claim keys to descend, one per level, each taken literally. At
            least one is required - see below.

    Raises:
        AssertionError: If the claim does not serialise to ``want``, or for any
            reason ``get_payload`` or ``get_sub_object`` raises. The message
            reports the single claim value it was asked about, which is what
            makes a failure diagnosable, and nothing else from the token.
    """
    __tracebackhide__ = True

    if not parts:
        # A zero-part call would put the ENTIRE payload into the failure message
        # below. Every Go call site passes at least one key, so nothing is lost
        # by refusing the shape that would leak a whole set of claims into a CI
        # log. get_sub_object still accepts it: there the value is returned to
        # the caller rather than embedded in a message.
        raise AssertionError(
            f"{_RQ}: check_payload requires at least one claim key. Comparing a whole "
            "payload would put every claim in this message, and a projected token's "
            "claims are credential material. Name the claim to assert."
        )

    got = get_sub_object(get_payload(token), *parts)
    if got != want:
        raise AssertionError(
            f"{_RQ}: unexpected payload at {_render_path(parts)}.\nsaw:\t{got}\nwant:\t{want}"
        )


class TokenRequestSpecLike(Protocol):
    """The one field of a TokenRequest spec that ``check_expiration`` reads.

    Structural rather than nominal on purpose. Verified against the pinned
    ``kubernetes`` 34.1.0 client: the models are ``AuthenticationV1TokenRequest``
    (``V1TokenRequest`` does NOT exist), ``V1TokenRequestSpec`` and
    ``V1TokenRequestStatus``, the spec field is the snake_case
    ``expiration_seconds`` for the JSON ``expirationSeconds``, and a token is
    issued with
    ``CoreV1Api.create_namespaced_service_account_token(name, namespace, body)``.
    Typing against the protocol rather than importing the model keeps this module
    importable, and its unit-level behaviour testable, with no Kubernetes client
    installed - and keeps a stub object with the same shape usable in its place.
    """

    @property
    def expiration_seconds(self) -> int | None:
        """Requested token lifetime in seconds, or ``None`` when unset."""


class TokenRequestLike(Protocol):
    """A TokenRequest as far as ``check_expiration`` is concerned."""

    @property
    def spec(self) -> TokenRequestSpecLike | None:
        """The request spec echoed back by the API server."""


def check_expiration(
    token_request: TokenRequestLike,
    expected_expiration_seconds: int,
) -> None:
    """Assert the returned TokenRequest spec echoes the requested TTL.

    Ports ``checkExpiration`` from test/integration/auth/svcaccttoken_test.go
    L1283-1291.

    INVARIANT PRESERVED: two INDEPENDENT findings, exactly as the Go original
    makes two independent ``t.Errorf`` calls - the lifetime must be SET, and it
    must EQUAL the requested value. Neither is short-circuited behind the other:
    both are evaluated and both are reported, so a run never hides the second
    finding because the first fired.

    Python is able to report both where Go cannot. The Go original dereferences
    ``*treq.Spec.ExpirationSeconds`` in its second check, so when the field is
    nil that check panics after the first is recorded; comparing ``None`` to an
    int is safe here, so both findings survive. The verdict is identical - a
    failure remains a failure - and only the diagnostics improve.

    THIS IS NOT THE +-60 SECOND WINDOW. This helper inspects the TokenRequest
    SPEC, which is the request echoed back, not the JWT. The window that bounds
    the token's ACTUAL lifetime - both the JWT ``exp`` claim and
    ``status.expirationTimestamp``, against ``request_time + 3600s`` within
    +-60 seconds - lives in ``tests/integration/test_svcacct_token.py``, and
    that leeway and that TTL are deliberately defined there and nowhere in this
    module. A regression issuing a roughly one-year token would satisfy
    ``exp > now`` and would be caught only by that window, so no reader should
    believe the time-bound invariant is covered here.

    Args:
        token_request: The TokenRequest returned by
            ``create_namespaced_service_account_token``, or any object exposing
            ``.spec.expiration_seconds``.
        expected_expiration_seconds: The lifetime the caller requested, in
            seconds. Supplied by the caller precisely so that no boundary value
            is defined in this module.

    Raises:
        AssertionError: Enumerating EVERY finding - the unset check and the
            equality check are reported together when both fail. Raised inside
            ``with subtests.test(...)`` this accumulates like ``t.Errorf``;
            raised outside one it aborts like ``t.Fatalf``.
    """
    __tracebackhide__ = True

    spec = token_request.spec
    if spec is None:
        # Unreachable in Go, where Spec is a value type and cannot be nil, and
        # unreachable for a TokenRequest the API server returned. Reported as a
        # broken precondition rather than as one of the two findings below,
        # because with no spec neither of them can be evaluated at all.
        raise AssertionError(
            f"{_RQ}: the TokenRequest has no spec, so its requested lifetime cannot be "
            "checked. A TokenRequest returned by create_namespaced_service_account_token "
            "always carries one; this indicates the wrong object was passed."
        )

    saw = spec.expiration_seconds
    findings: list[str] = []
    if saw is None:
        findings.append("unexpected nil expiration seconds.")
    if saw != expected_expiration_seconds:
        findings.append(
            f"unexpected expiration seconds.\nsaw:\t{saw}\nwant:\t{expected_expiration_seconds}"
        )

    if findings:
        raise AssertionError(f"{_RQ}: " + "\n".join(findings))


def expected_epoch_expiry(request_time: datetime, ttl_seconds: int) -> int:
    """Return ``request_time + ttl_seconds`` as whole epoch seconds.

    Mirrors ``int64(*jwt.NewNumericDate(requestTime.Add(ttl)))`` from
    svcaccttoken_test.go L1502, whose ``jwt`` is
    ``gopkg.in/go-jose/go-jose.v2/jwt`` where ``NumericDate`` is an ``int64``
    and ``NewNumericDate`` is ``NumericDate(t.Unix())``
    (vendor/gopkg.in/go-jose/go-jose.v2/jwt/claims.go L42, L45-56). So the Go
    value is Unix SECONDS with any sub-second part truncated, which is what a
    JWT ``exp`` claim is, and what this returns.

    Truncating before the addition is identical to truncating after it, because
    ``floor(x) + n == floor(x + n)`` for any integer ``n``; the order chosen
    here keeps the arithmetic in ``int`` rather than ``float``, so no precision
    is lost for large epoch values.

    NO BOUNDARY VALUE IS DEFINED HERE. Both the TTL and the leeway are the
    caller's, passed in rather than defaulted, so that neither the 3600 second
    TTL nor the +-60 second window can be "tuned" from this module. That window
    is engineered: narrow enough that a roughly one-year long-lived-token
    regression still fails, wide enough to absorb API round-trip and CI
    scheduling jitter. Narrowing it makes the test flaky; widening it makes the
    test meaningless.

    TIME ZONES. ``datetime.timestamp()`` is absolute for an aware datetime and
    interprets a naive one as LOCAL time, which is what makes this agree with
    Go's ``time.Now()`` (local) followed by ``.Unix()`` (absolute). So pass
    either an aware datetime or ``datetime.now()``. Do NOT pass
    ``datetime.utcnow()``: it returns a NAIVE datetime holding UTC, which
    ``timestamp()`` would misread as local time and silently shift the expected
    expiry by the machine's UTC offset - invisible on a UTC host, and a
    spurious pass or failure of the expiry window anywhere else.

    Args:
        request_time: When the token was requested, captured immediately BEFORE
            issuance so the window bounds the token's real lifetime.
        ttl_seconds: The requested lifetime in seconds.

    Returns:
        The expected ``exp`` claim value as whole epoch seconds.
    """
    return int(request_time.timestamp()) + ttl_seconds


def decode_claims(token: str) -> dict[str, object]:
    """Return the token's claims as a parsed mapping, verifying NOTHING.

    A convenience beside the Go-faithful text accessors, for a call site that
    wants Python values - iterating claim keys, say - rather than the JSON text
    that ``get_sub_object`` returns. Assertions ported from the Go test should
    use ``get_payload`` and ``get_sub_object`` so they compare exactly what the
    Go original compares.

    Implemented with PyJWT, the pinned dependency this tier carries for reading
    token claims (python/requirements-test.txt), under
    ``options={"verify_signature": False}``. Measured against that exact pin,
    2.13.0: with signature verification off, PyJWT also performs NO ``exp``,
    ``aud``, ``iss``, ``sub``, ``nbf`` or ``iat`` validation, so an expired
    token with an audience and an issuer decodes cleanly and no key or
    ``algorithms`` argument is needed. That is required, not merely convenient -
    V4 must be able to inspect a token precisely in order to judge its lifetime.

    One measured caveat, and the reason ``get_payload`` does not route through
    PyJWT: ``jwt.decode`` also base64-decodes the SIGNATURE segment, so a token
    whose signature is not valid base64url raises
    ``DecodeError("Invalid crypto padding")`` even with verification disabled.
    The Go original never reads that segment, so ``get_payload`` stays on the
    standard library and remains readable for any signature whatsoever.

    Args:
        token: A JWS compact serialisation.

    Returns:
        The decoded claims. Keys are claim names exactly as they appear in the
        token, so the nested Kubernetes claims are reached as
        ``claims["kubernetes.io"]["serviceaccount"]["name"]`` - one key that
        contains a dot, never split.

    Raises:
        AssertionError: If the token does not have exactly three segments - the
            same precondition ``get_payload`` enforces, applied here too so the
            failure is this module's legible message rather than PyJWT's - or if
            PyJWT cannot decode it. No message contains the token.
    """
    __tracebackhide__ = True

    _require_compact_serialization(token)
    try:
        # No key, no algorithms: with verify_signature off, PyJWT needs neither,
        # and supplying either would imply a verification this must not do.
        return jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError as exc:
        # PyJWT's messages describe the fault without echoing the input -
        # measured: "Not enough segments", "Invalid crypto padding", "Invalid
        # payload string: ...". Including the type and the text keeps a failure
        # diagnosable without putting credential material in a log.
        raise AssertionError(
            f"{_RQ}: could not decode the token claims: "
            f"{type(exc).__name__}: {exc}. The token is deliberately not reported: "
            "it is credential material."
        ) from exc
