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

"""Contract tests for ``tests.helpers.polling``: the PREDICATE DOMAIN above all.

AAP §0.5.1 (the ``python/tests/helpers/polling.py`` row: the ``wait.Poll`` port) /
§0.4.1.2 (the assertion-semantics translation table, whose ``wait.Poll`` row this
helper implements) / §0.7.2 (assertion density; structural isolation; parallel
safety) / §0.11.1 ("never weaken a boundary condition") / tech-spec §6.6.3.4 (the
documentation convention).

INVARIANT LOCKED BY THIS MODULE: **a poll ends on an exact boolean ``True`` and
on nothing else.**

WHY THAT IS A SECURITY PROPERTY AND NOT A STYLE PREFERENCE. Go's
``wait.ConditionFunc`` is ``func() (done bool, err error)``, so the compiler
guarantees the decision is a boolean. Python's ``if condition():`` accepts every
truthy object, and in this suite the objects a predicate is most likely to return
by mistake are all truthy:

  * ``(False, None)`` -- the shape a literal transcription of the Go signature
    produces. A non-empty tuple is truthy, so the poll returns on a predicate that
    reported NOT DONE;
  * a ``MissingEventsReport``, an ``HTTPResponse``, an ``ApiException`` -- no
    ``__bool__``, therefore truthy, so returning the EVIDENCE instead of a verdict
    about it satisfies the poll;
  * an un-awaited coroutine, which a missing ``await`` produces;
  * a non-empty list of remaining work, whose emptiness is the real condition and
    whose truthiness is its exact negation.

Each of those clears the poll on the FIRST attempt, so the failure is silent: the
call site's own assertions then run against whatever state exists and frequently
pass. That is a security gate cleared by a value that never said ``True``.

The remaining invariants below are the ones the strictness must not have cost:
the at-least-once guarantee, the propagation of a raise, the ordering difference
between ``poll`` and ``poll_immediate``, and the budget validation.
"""

from __future__ import annotations

import time
import warnings
from typing import Any

import pytest

from tests.helpers.polling import (
    PollPredicateError,
    PollTimeoutError,
    poll,
    poll_immediate,
)

# Short, explicit budgets everywhere. Nothing here waits on a real service, so a
# tenth of a second is generous, and passing both values on every call keeps the
# session defaults out of the arithmetic (they are 500 ms / 30 s).
INTERVAL = 0.01
TIMEOUT = 0.1


# ---------------------------------------------------------------------------
# 1. The predicate domain: exactly bool, and nothing else
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("returned", "described"),
    [
        pytest.param((False, None), "tuple", id="go-shaped-(False,None)-tuple"),
        pytest.param((True, None), "tuple", id="go-shaped-(True,None)-tuple"),
        pytest.param(["still-missing"], "list", id="non-empty-list-of-remaining-work"),
        pytest.param({"missing": 1}, "dict", id="report-like-mapping"),
        pytest.param(object(), "object", id="opaque-object-with-no-dunder-bool"),
        pytest.param(1, "int", id="the-integer-one"),
        pytest.param(0, "int", id="the-integer-zero"),
        pytest.param("True", "str", id="the-string-True"),
        pytest.param("", "str", id="the-empty-string"),
        pytest.param(None, "NoneType", id="None"),
    ],
)
def test_a_non_boolean_predicate_result_is_refused_immediately(
    returned: object, described: str
) -> None:
    """Every truthy AND falsey non-boolean is refused, on the attempt that returned it.

    Both directions are asserted because they fail differently and both are
    defects: a truthy non-boolean ends the poll on a decision nobody made, and a
    falsey non-boolean silently spends the whole budget and then reports a timeout
    about a predicate that was never asked a question it could answer.

    ``pytest.raises`` and not a bare call: the refusal must be an exception rather
    than a log line, because a helper that merely warned would leave the false
    pass in place.
    """
    attempts = 0

    def condition() -> bool:
        nonlocal attempts
        attempts += 1
        return returned  # type: ignore[return-value]

    with pytest.raises(PollPredicateError) as raised:
        poll_immediate(condition, interval=INTERVAL, timeout=TIMEOUT)

    assert attempts == 1, "the refusal must land on the first attempt, not after the budget"
    message = str(raised.value)
    assert described in message, f"the failure must name the returned type; got {message!r}"
    assert "attempt 1" in message
    assert "Return True or False" in message


def test_an_unawaited_coroutine_is_named_as_such_and_leaks_no_warning() -> None:
    """The most confusing mistake gets the least confusing message.

    ``<coroutine object condition at 0x...>`` inside a TypeError about types tells
    a reader nothing. Naming the missing ``await`` tells them everything.

    ``warnings.catch_warnings(record=True)`` is the second half of the assertion:
    an un-closed coroutine makes CPython emit "coroutine ... was never awaited" at
    collection time, which in a ``-W error`` run becomes a second, unrelated failure
    and in an ordinary run displaces the message that matters. The helper closes it
    before raising, so no warning is recorded here.
    """

    async def async_condition() -> bool:
        return True

    def returns_a_coroutine() -> Any:
        return async_condition()

    with warnings.catch_warnings(record=True) as recorded:
        warnings.simplefilter("always")
        with pytest.raises(PollPredicateError, match="COROUTINE") as raised:
            poll_immediate(returns_a_coroutine, interval=INTERVAL, timeout=TIMEOUT)

    assert "never awaited" in str(raised.value)
    assert [str(entry.message) for entry in recorded if "never awaited" in str(entry.message)] == []


def test_a_truthy_result_on_a_later_attempt_is_still_refused() -> None:
    """The check is per attempt, not once at entry.

    A predicate that answers correctly and then drifts -- a refactor that starts
    returning the report it used to inspect -- must be caught on the attempt that
    drifted, with the attempt number in the message so the reader can see it was
    not the first.
    """
    attempts = 0

    def condition() -> bool:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            return False
        return ["drifted"]  # type: ignore[return-value]

    with pytest.raises(PollPredicateError, match="attempt 3"):
        poll_immediate(condition, interval=INTERVAL, timeout=10.0)

    assert attempts == 3


def test_exact_true_and_false_are_both_accepted() -> None:
    """THE CONTROL. Without it every case above could pass on a helper that refused
    everything, including the two values it must accept."""
    calls = 0

    def eventually() -> bool:
        nonlocal calls
        calls += 1
        return calls >= 3

    poll_immediate(eventually, interval=INTERVAL, timeout=10.0)

    assert calls == 3, "False must retry and True must return"


# ---------------------------------------------------------------------------
# 2. What the strictness must not have cost
# ---------------------------------------------------------------------------


def test_the_condition_is_invoked_at_least_once_even_on_a_spent_budget() -> None:
    """poll.go:54 and poll.go:162: "'condition' will always be invoked at least once"."""
    calls = 0

    def never() -> bool:
        nonlocal calls
        calls += 1
        return False

    with pytest.raises(PollTimeoutError):
        poll(never, interval=1.0, timeout=0.001)

    assert calls >= 1


def test_a_raise_from_the_predicate_propagates_unwrapped() -> None:
    """wait.go:213-215: ``if err != nil { return err }`` -- no retry, no wrapping.

    A ``RuntimeError`` and not an ``AssertionError``, so this cannot be confused
    with :class:`PollTimeoutError`, which derives from ``AssertionError``.
    """
    calls = 0

    def explode() -> bool:
        nonlocal calls
        calls += 1
        raise RuntimeError("the predicate itself failed")

    with pytest.raises(RuntimeError, match="the predicate itself failed"):
        poll_immediate(explode, interval=INTERVAL, timeout=10.0)

    assert calls == 1, "a raise must abort at once rather than being retried"


def test_poll_waits_before_the_first_evaluation_and_poll_immediate_does_not() -> None:
    """The one difference between the two entry points, asserted rather than assumed.

    ``wait.Poll`` "always waits the interval before the run of 'condition'"
    (poll.go:53), which is why the V6 test uses it -- reading an
    asynchronously-written audit log at t=0 spends an attempt on a foregone
    conclusion. ``PollImmediate`` is the opposite (poll.go:161-162), which is why
    V7's ``expect`` uses it.
    """
    interval = 0.05

    started = time.monotonic()
    poll(lambda: True, interval=interval, timeout=10.0)
    waited = time.monotonic() - started

    started = time.monotonic()
    poll_immediate(lambda: True, interval=interval, timeout=10.0)
    immediate = time.monotonic() - started

    assert waited >= interval, "poll must sleep one interval before evaluating"
    assert immediate < interval, "poll_immediate must evaluate before sleeping"


@pytest.mark.parametrize(
    ("interval", "timeout"),
    [
        pytest.param(0.0, TIMEOUT, id="zero-interval"),
        pytest.param(-1.0, TIMEOUT, id="negative-interval"),
        pytest.param(INTERVAL, 0.0, id="zero-timeout-is-not-infinity"),
        pytest.param(INTERVAL, -1.0, id="negative-timeout"),
    ],
)
def test_a_non_positive_budget_is_refused(interval: float, timeout: float) -> None:
    """A zero timeout is NOT read as "wait for ever", which is the reading that
    would turn a typo into a wedged CI job."""
    with pytest.raises(ValueError, match="greater than zero"):
        poll_immediate(lambda: True, interval=interval, timeout=timeout)


def test_exhaustion_names_the_requirement_and_the_last_diagnostic() -> None:
    """AAP §0.7.2: a failure must read as a requirement violation.

    ``describe_last`` is the port of the V6 closure's ``lastMissingReport``
    (audit_test.go:1021), and without it an exhausted poll reports nothing more
    useful than Go's bare "timed out waiting for the condition".
    """
    with pytest.raises(PollTimeoutError) as raised:
        poll_immediate(
            lambda: False,
            interval=INTERVAL,
            timeout=0.05,
            description="the expected audit events to be observed",
            requirement="F-006-RQ-002",
            describe_last=lambda: "missing 3 events",
        )

    message = str(raised.value)
    assert message.startswith("F-006-RQ-002:")
    assert "the expected audit events to be observed" in message
    assert "missing 3 events" in message


def test_poll_timeout_error_is_both_an_assertion_error_and_a_timeout_error() -> None:
    """The accumulate-or-abort choice belongs to the CALL SITE (AAP §0.4.1.2).

    ``AssertionError`` is what lets a ``pytest.Subtests`` block capture it as one
    finding among many; ``TimeoutError`` is what lets a caller distinguish
    exhaustion from any other assertion.
    """
    assert issubclass(PollTimeoutError, AssertionError)
    assert issubclass(PollTimeoutError, TimeoutError)


def test_poll_predicate_error_is_not_an_assertion_error() -> None:
    """A wrong predicate type is a defect in the TEST, not a finding about the system.

    So it must not be capturable by a subtest block that is accumulating security
    findings, and it must not be mistaken for exhaustion.
    """
    assert issubclass(PollPredicateError, TypeError)
    assert not issubclass(PollPredicateError, AssertionError)
    assert not issubclass(PollPredicateError, PollTimeoutError)
