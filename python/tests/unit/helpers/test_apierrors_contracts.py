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

"""Contract tests for ``tests.helpers.apierrors``: what may satisfy a DENIAL.

AAP §0.5.1 (the ``python/tests/helpers/apierrors.py`` row: the
``apierrors.IsForbidden`` port) / §0.4.1.2 (the ``apierrors.IsForbidden(err)`` ->
``except ApiException as e: assert e.status == 403`` translation row) / §0.4.2.2
(the V1, V2 and V7 blueprints whose 403 assertions run through this module) /
§0.7.2 (assertion density; failure legibility) / §0.11.1 ("never weaken a
boundary condition") / tech-spec §6.6.3.4 (the documentation convention).

INVARIANTS LOCKED BY THIS MODULE:

1. **ONLY AN INTEGER STATUS IS A STATUS.** These predicates are how V1, V2 and V7
   prove a DENIAL: ``expect_forbidden`` passing means the API server refused the
   request. A real response always yields an ``int`` -- ``ApiException`` takes its
   status from ``http_resp.status`` (kubernetes/client/rest.py:238) and urllib3's
   ``HTTPResponse.status`` is an ``int``, while the transport-failure path
   (rest.py:214, :224) passes the ``int`` ``0``. There is NO path through the
   pinned 34.1.0 client on which a genuine status arrives as a string. So
   ``ApiException(status="403")`` is not a case to support; it is a hand-built
   fake, and reading it as Forbidden would let a test double satisfy a denial
   proof without any server having refused anything.
2. **ONLY AN ``ApiException`` CARRIES A STATUS.** An arbitrary object exposing
   ``status = 403`` -- a response, a mock, a namedtuple -- is not an API error.
3. **``True`` IS NOT ``1``.** ``bool`` is an ``int`` subclass, so the type test is
   exact rather than an ``isinstance``.
4. **A BOUNDED EXPECTATION RETRIES ONLY WHAT A CONVERGING SERVER PRODUCES.** A
   ``TypeError`` from a mistyped model field, an ``AttributeError`` from a renamed
   client method, an ``AssertionError`` from a nested helper -- each is a defect in
   the test, produces the identical exception on every retry by definition, and
   must surface on the first attempt with its own traceback rather than thirty
   seconds later as "waited 30s for a Forbidden response".
"""

from __future__ import annotations

import http.client

import pytest
import urllib3.exceptions
from kubernetes.client.exceptions import ApiKeyError, ApiTypeError, ApiValueError
from kubernetes.client.rest import ApiException

from tests.helpers.apierrors import (
    expect_forbidden,
    is_already_exists,
    is_forbidden,
    is_not_found,
)


def _api_exception(status: object) -> ApiException:
    """An ``ApiException`` whose ``.status`` is exactly ``status``.

    Assigned after construction rather than passed in, so the attribute holds the
    given object verbatim regardless of what any constructor branch would do to
    it. That is the point of the test: the predicate must judge the value it is
    handed.
    """
    error = ApiException(status=500, reason="probe")
    error.status = status
    return error


# ---------------------------------------------------------------------------
# 1. Only an integer status is a status
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("predicate", "status"),
    [
        (is_forbidden, 403),
        (is_not_found, 404),
        (is_already_exists, 409),
    ],
)
def test_an_integer_status_is_recognised(predicate: object, status: int) -> None:
    """THE CONTROL for every rejection below.

    Without it, a helper that answered ``False`` for everything would satisfy the
    whole of the rest of this module.
    """
    assert predicate(_api_exception(status)) is True  # type: ignore[operator]


@pytest.mark.parametrize(
    ("predicate", "status"),
    [
        (is_forbidden, "403"),
        (is_not_found, "404"),
        (is_already_exists, "409"),
    ],
)
def test_a_STRING_status_is_not_a_status(predicate: object, status: str) -> None:
    """A numeric string is a hand-built fake, and it must not prove a denial.

    THE FALSE PASS THIS CLOSES. The superseded implementation ran ``int(status)``,
    so ``ApiException(status="403")`` read as Forbidden. Nothing in the pinned
    client produces that shape, so the only way to construct it is by hand -- which
    means the helper was accepting a test double in place of the API server's own
    refusal, in exactly the assertions (V1 wildcard denial, V2 privileged-pod
    rejection, V7 cross-node denial) whose entire content is that the server
    refused.
    """
    assert predicate(_api_exception(status)) is False  # type: ignore[operator]


@pytest.mark.parametrize(
    "status",
    [
        pytest.param(403.0, id="float-403"),
        pytest.param(None, id="None"),
        pytest.param(b"403", id="bytes"),
        pytest.param(" 403 ", id="string-with-whitespace"),
        pytest.param("forbidden", id="non-numeric-string"),
        pytest.param([403], id="list"),
    ],
)
def test_no_other_status_shape_is_coerced(status: object) -> None:
    """Nothing is parsed, stripped, rounded or unwrapped. Exactly ``int``, or nothing."""
    assert is_forbidden(_api_exception(status)) is False


def test_true_is_not_the_integer_one() -> None:
    """``bool`` is an ``int`` subclass, so the type test has to be exact.

    ``status=True`` could not have produced a false POSITIVE either way -- none of
    403, 404 or 409 equals ``True`` -- but ``type(...) is int`` states the contract
    instead of leaving a reader to re-derive it, and it also rejects ``IntEnum`` and
    every other int-like wrapper.
    """
    for predicate in (is_forbidden, is_not_found, is_already_exists):
        assert predicate(_api_exception(True)) is False
        assert predicate(_api_exception(False)) is False


# ---------------------------------------------------------------------------
# 2. Only an ApiException carries a status
# ---------------------------------------------------------------------------


class _LooksLikeAnApiError:
    """An object that merely happens to expose ``status``."""

    status = 403


@pytest.mark.parametrize(
    "candidate",
    [
        pytest.param(_LooksLikeAnApiError(), id="duck-typed-object"),
        pytest.param(None, id="None-meaning-the-operation-succeeded"),
        pytest.param(ValueError("unrelated"), id="unrelated-exception"),
        pytest.param(ApiTypeError("client-side"), id="ApiTypeError"),
        pytest.param(ApiValueError("client-side"), id="ApiValueError"),
        pytest.param(ApiKeyError("client-side"), id="ApiKeyError"),
    ],
)
def test_only_an_api_exception_can_carry_a_status(candidate: object) -> None:
    """The three client-side siblings descend from ``OpenApiException`` WITHOUT
    descending from ``ApiException``, so they correctly read as "no status"."""
    assert is_forbidden(candidate) is False
    assert is_not_found(candidate) is False
    assert is_already_exists(candidate) is False


def test_an_api_exception_with_no_status_attribute_does_not_raise() -> None:
    """A predicate must answer, never raise: :func:`_expect` evaluates it on
    whatever the operation produced, including a partially initialised instance."""
    error = ApiException(status=403, reason="probe")
    del error.status

    assert is_forbidden(error) is False


# ---------------------------------------------------------------------------
# 3. What a bounded expectation retries, and what it must not
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raised",
    [
        pytest.param(TypeError("V1TokenRequest() got an unexpected keyword"), id="TypeError"),
        pytest.param(AttributeError("no attribute 'create_namespaced_pod'"), id="AttributeError"),
        pytest.param(NameError("name 'namespce' is not defined"), id="NameError"),
        pytest.param(KeyError("node2-token"), id="KeyError"),
        pytest.param(ValueError("invalid literal"), id="ValueError"),
        pytest.param(AssertionError("a nested helper's own assertion"), id="AssertionError"),
    ],
)
def test_a_programming_error_surfaces_on_the_first_attempt(raised: BaseException) -> None:
    """A defect in the TEST is never retried, and never rewritten.

    THE COST THIS REMOVES. A blanket ``except Exception`` retried every one of
    these for the full 30-second budget and then reported the LAST occurrence, so
    a one-line typo cost half a minute per call site and arrived as "waited 30s for
    a Forbidden response" with the original traceback thirty frames of retry away
    from its cause. Retrying a deterministic error also cannot help: by definition
    it produces the identical exception every time.

    ``AssertionError`` matters most: it is what
    :class:`tests.helpers.polling.PollTimeoutError` derives from and what a nested
    helper's own assertion raises, so absorbing it turned a real finding into a
    timeout report about something else.
    """
    attempts = 0

    def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise raised

    with pytest.raises(type(raised)) as observed:
        expect_forbidden(operation, requirement="F-007-RQ-002", interval=0.01, timeout=1.0)

    assert observed.value is raised, "the original exception must arrive unwrapped"
    assert attempts == 1, "a programming error must not be retried"


@pytest.mark.parametrize(
    "transient",
    [
        pytest.param(ApiException(status=200, reason="not yet refused"), id="ApiException"),
        pytest.param(urllib3.exceptions.ProtocolError("connection reset"), id="urllib3-HTTPError"),
        pytest.param(http.client.BadStatusLine("truncated"), id="http.client-HTTPException"),
        pytest.param(ConnectionRefusedError("listener not accepting yet"), id="OSError"),
        pytest.param(TimeoutError("read timed out"), id="TimeoutError-is-an-OSError"),
    ],
)
def test_a_transient_transport_failure_is_retried(transient: BaseException) -> None:
    """Each of these is what a CONVERGING API server legitimately produces.

    ``expect`` (test/integration/auth/node_test.go:684-696) exists precisely to
    wait these out: an authorizer that has not caught up with a just-created
    binding, or a test server whose listener is not yet accepting. The operation
    therefore has to be re-invoked, and the outcome that eventually satisfies the
    predicate has to be the one reported.
    """
    attempts = 0

    def operation() -> None:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise transient
        raise ApiException(status=403, reason="Forbidden")

    expect_forbidden(operation, requirement="F-007-RQ-002", interval=0.01, timeout=10.0)

    assert attempts == 3, "a transient failure must be retried until the real outcome arrives"


def test_pytest_own_outcomes_are_never_absorbed() -> None:
    """``Failed`` and ``Skipped`` derive from ``BaseException`` so helpers cannot
    swallow them. An operation that skips internally must report a SKIP."""
    with pytest.raises(pytest.skip.Exception):
        expect_forbidden(
            lambda: pytest.skip("the prerequisite is absent"),
            requirement="F-007-RQ-002",
            interval=0.01,
            timeout=1.0,
        )
