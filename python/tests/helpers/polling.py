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

"""Bounded poll-to-convergence helpers, ported from k8s.io/apimachinery's wait.

Port of ``wait.Poll`` (staging/src/k8s.io/apimachinery/pkg/util/wait/poll.go:65)
and ``wait.PollImmediate`` (poll.go:156), whose shared driver is
``waitForWithContext`` at
staging/src/k8s.io/apimachinery/pkg/util/wait/wait.go:205-228, bounded by the
budget ``wait.ForeverTestTimeout`` declares at that same file's line 37 as
``time.Second * 30``.

WHY THIS MODULE IS FOUNDATIONAL

``tests/helpers/apierrors.py`` polls through it, and so does every ported
integration module that has to wait for a control plane to converge. A defect
here does not fail one test loudly; it makes a whole tier flaky, or - worse -
lets a tier pass for the wrong reason. That is why the two semantics below are
reproduced exactly rather than folded into one convenient loop.

WHY THERE ARE TWO FUNCTIONS AND NOT ONE

Go ships two primitives and this tier calls both. The difference between them
is load-bearing at their respective call sites:

  * :func:`poll` ports ``wait.Poll``, which "always waits the interval before
    the run of 'condition'" (poll.go:53-54). Its call site is V6,
    test/integration/controlplane/audit/audit_test.go:1009:
    ``wait.Poll(500*time.Millisecond, wait.ForeverTestTimeout, ...)``. Waiting
    first is what gives the API server's asynchronous audit sink 500 ms to
    flush before the log is read for the first time; reading at t=0 would
    observe an empty file and burn one attempt on a foregone conclusion.
  * :func:`poll_immediate` ports ``wait.PollImmediate``, which "always checks
    'condition' before waiting for the interval" (poll.go:161-162). Two call
    sites: ``expect`` at test/integration/auth/node_test.go:684-696, which
    passes ``time.Second, 30*time.Second``, and ``WaitForPodToDisappear`` at
    test/integration/utils.go:56-67. Checking first is what lets a condition
    that is ALREADY true - a request that is already Forbidden - be answered
    without paying an interval for it, and V7 makes four such assertions.

Collapsing the two would change how long a run takes and, for a condition
already true at entry, WHEN the first observation happens. Both named entry
points therefore exist. They share one private core so their behaviour cannot
drift apart, and that core takes an ``immediate`` flag exactly as Go's own
private ``poll`` does at poll.go:243-252.

THE PREDICATE IS RE-INVOKED ON EVERY TICK AND MAY HAVE SIDE EFFECTS

This is a contract, not an implementation detail. The V6 predicate re-runs its
API operations on every single tick, deliberately, so that the audit log gains
new events while the poll waits for the expected set to appear: ``tc.ops(t,
kubeclient, tc.namespace)`` is the first statement inside the closure at
audit_test.go:1010. A helper that memoised the predicate's result, or hoisted
any part of it out of the loop, would leave that test waiting for events
nothing is producing - a guaranteed 30 s timeout in place of a convergent pass.
Nothing here caches, nothing here batches, and nothing here inspects the
predicate.

HOW GO'S THREE CONDITION OUTCOMES MAP

``wait.ConditionFunc`` is ``func() (done bool, err error)`` (wait.go:100-102),
and its driver distinguishes three outcomes at wait.go:212-221. Python has no
two-value return, so the third travels as an exception:

    Go outcome     Go meaning                     This module
    ------------   ----------------------------   -------------------------
    (true, nil)    satisfied; stop polling        predicate returns True
    (false, nil)   not yet; sleep and retry       predicate returns False
    (_, err)       abort now; propagate the err   predicate RAISES

Raising is the idiomatic mapping and it preserves the distinction exactly: the
exception propagates to the caller UNCHANGED, unwrapped, with no further
attempt made. That is what the V6 predicate relies on when it escalates a
failure to open the log or to decode a line - ``return false,
fmt.Errorf("unexpected error: %v", err)`` at audit_test.go:1013 and 1018 - and
it is the reason no exception is ever swallowed here. A predicate that wants a
transient failure to be retried must catch it itself and return False, which is
precisely the choice its Go counterpart makes by returning ``(false, nil)``.

EXHAUSTION CARRIES THE LAST DIAGNOSTIC, NEVER A BARE TIMEOUT

Go's exhausted poll returns ``ErrWaitTimeout``, whose text is the almost
useless "timed out waiting for the condition" (error.go:28). The V6 test
compensates by keeping the interesting detail in a closure variable and
interpolating it at the failure site: ``lastMissingReport =
missingReport.String()`` on every unsatisfied tick (audit_test.go:1021), then
``t.Fatalf("failed to get expected events -- missingReport: %s, error: %v",
lastMissingReport, err)`` at audit_test.go:1031.

:class:`PollTimeoutError` makes that capability part of the helper instead of
leaving it to each call site: pass ``describe_last`` and it is invoked ONLY on
exhaustion, to build the message. The message also names the budget, the
interval, the number of attempts, the elapsed time and - when the caller
supplies one - the requirement identifier, so a CI failure reads as a
requirement violation rather than as a bare timeout (AAP §0.7.2).

WHERE THE BUDGETS COME FROM

Nowhere in this file. ``tests/conftest.py`` owns them and states so:
``FOREVER_TEST_TIMEOUT_SECONDS = 30.0`` and
``DEFAULT_POLL_INTERVAL_SECONDS = 0.5``, whose comment records that
"tests/helpers/polling.py and tests/integration/conftest.py consume this; a
second definition elsewhere would be a divergence waiting to happen".
:func:`poll` and :func:`poll_immediate` therefore default both parameters to
``None`` and resolve them through a DEFERRED import inside the function body -
see :func:`_session_defaults` for why the import cannot be at module scope, and
for the standalone fallback.

A caller needing a different budget passes it explicitly, exactly as its Go
original does: ``expect`` passes one second and thirty seconds, and
``WaitForPodToDisappear`` takes both from its own caller.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

It imports nothing but the standard library. Not ``pytest``, which is a test
dependency rather than a helper dependency and whose absence must not stop this
module from being imported or reasoned about; not the Kubernetes client, which
has no business in a timing primitive.

It declares no fixture, because fixtures belong to the tier's conftest.py files
and because a module-, package- or session-scoped autouse fixture declared
inline in an ordinary module can execute twice under ``--doctest-modules``.

It declares no test, so it contributes nothing to collection.

It offers no async variant. Every polling call site ported here is synchronous,
and an unused coroutine API would be surface with no consumer to keep it honest.

It does not reproduce two quirks of the deprecated Go implementation, and both
omissions are deliberate rather than oversights. ``poller`` treats a timeout of
zero as INFINITY and documents that the caller must then close the done channel
or leak a goroutine (poll.go:266-269); here a non-positive timeout is a
``ValueError``, because a helper whose contract is "bounded" must not turn a
typo into a hang that only pytest-timeout's 300 s ceiling would notice. And
``poller`` builds a ``time.NewTicker``, which PANICS on a non-positive interval;
:func:`_resolve_budget` raises ``ValueError`` there too, which is the same
refusal expressed in Python.

ISOLATION AND DETERMINISM

There is no module-level mutable state of any kind. The deadline, the attempt
count and the last diagnostic all live in the call's own frame, so two workers
under ``pytest-xdist -n auto`` cannot observe each other and ``pytest-randomly``
cannot reorder anything into a different result.

The deadline is computed from :func:`time.monotonic`, never from the wall clock,
so that an NTP step or a manual clock change mid-poll cannot extend or truncate
the budget. A wall-clock deadline would also be vulnerable to a clock that moves
BACKWARDS, which turns a bounded wait into an unbounded one; a monotonic clock
cannot do that by definition.

Monotonic is not, however, immunity from a frozen clock, and that was MEASURED
rather than assumed: ``freezegun`` 1.5.5 - pinned, and used elsewhere in this
suite - freezes ``time.monotonic`` as well as ``time.time`` under its default
``tick=False``, while leaving ``time.sleep`` real. A poll wrapped in a default
``freeze_time`` would therefore never see its budget elapse. Two consequences,
both deliberate:

  * A test that freezes time must not wrap a poll in it, or must pass
    ``freeze_time(..., tick=True)``, under which monotonic advances with real
    time (also measured). Freezing time around a wait for a real control plane
    to converge is a contradiction in terms anyway - the system being waited on
    keeps using the real clock.
  * Because "must not" is not a mechanism, the loop carries a second, provably
    non-binding bound: an attempt ceiling derived from the budget itself. A
    clock that does not advance then produces a :class:`PollTimeoutError` that
    SAYS the clock did not advance, instead of a hang for pytest-timeout to
    reap 300 s later. The arithmetic is in :func:`_poll`.

USAGE

V6, mirroring the Go original's closure-held diagnostic exactly - the predicate
performs its operations on every tick, records the report of the last
unsatisfied tick, and lets a decode failure abort by raising:

    from tests.helpers.polling import poll, poll_immediate

    def test_audit_sensitive_resource_levels(...):
        last_report: str | None = None

        def audit_events_converged() -> bool:
            nonlocal last_report
            run_expected_operations()        # side effects on EVERY tick
            report = check_audit_lines(...)  # raising here aborts the poll
            if report.missing_events:
                last_report = str(report)
                return False
            return True

        poll(
            audit_events_converged,
            description="the expected audit events to be observed",
            requirement="F-006-RQ-002",
            describe_last=lambda: last_report,
        )

V7, where checking first matters because an already-Forbidden request must not
cost an interval:

        poll_immediate(
            lambda: is_forbidden(attempt_cross_node_update()),
            interval=1.0,
            timeout=30.0,
            description="the cross-node status update to be rejected",
            requirement="F-007-RQ-002",
        )
"""

# AAP §0.5.1 / §0.4.1.2: port of wait.Poll / wait.PollImmediate — bounded
# convergence, last diagnostic preserved.
#
# §0.5.1 is the python/tests/helpers/polling.py row, "Bounded polling helper",
# sourced from k8s.io/apimachinery's wait.Poll. §0.4.1.2 is the row of the
# assertion-translation table that maps "wait.Poll(500ms, ForeverTestTimeout,
# cond)" onto a "Polling helper bounded by pytest-timeout", and whose t.Fatalf,
# t.Errorf and t.Helper rows fix how exhaustion, accumulation and traceback
# trimming must behave. §0.7.2 requires an assertion message to name the
# requirement identifier it enforces. tech-spec §6.6.1.2 is "real components,
# not mocks": these helpers wait for a real control plane, they never simulate
# one.
#
# INVARIANT LOCKED BY THIS FILE: a bounded poll invokes its predicate at least
# once, re-invokes it on every tick with all of its side effects intact, stops
# the instant it returns True, aborts the instant it raises - propagating that
# exception unchanged - and on exhausting the caller's budget raises
# PollTimeoutError carrying the last diagnostic the caller offered. poll waits
# the interval BEFORE the first invocation; poll_immediate invokes BEFORE the
# first wait. Neither the 500 ms interval nor the 30 s ceiling is defined here:
# both are resolved from tests/conftest.py so there is exactly one place to
# change them, and neither may be widened (which makes a test meaningless) nor
# narrowed (which makes it flaky).

import inspect
import time
from collections.abc import Callable
from typing import Final

__all__ = ["PollPredicateError", "PollTimeoutError", "poll", "poll_immediate"]


# ---------------------------------------------------------------------------
# Budget resolution: single-sourced from tests/conftest.py, with a standalone
# fallback that mirrors the Go originals rather than inventing a number.
# ---------------------------------------------------------------------------

#: Mirror of ``tests.conftest.DEFAULT_POLL_INTERVAL_SECONDS``, used ONLY when
#: that module cannot be imported at all. 500 ms, the interval
#: ``TestAuditSensitiveResourceLevels`` passes to ``wait.Poll``
#: (test/integration/controlplane/audit/audit_test.go:1009).
#:
#: This is a MIRROR, not a second source of truth: conftest.py is authoritative
#: whenever it is importable, which under pytest is always.
_FALLBACK_POLL_INTERVAL_SECONDS: Final[float] = 0.5

#: Mirror of ``tests.conftest.FOREVER_TEST_TIMEOUT_SECONDS``, used under the
#: same condition and for the same reason. 30 s, from ``wait.ForeverTestTimeout
#: = time.Second * 30`` at
#: staging/src/k8s.io/apimachinery/pkg/util/wait/wait.go:37.
_FALLBACK_POLL_TIMEOUT_SECONDS: Final[float] = 30.0


def _session_defaults() -> tuple[float, float]:
    """Return ``(interval, timeout)`` as ``tests/conftest.py`` declares them.

    THE IMPORT IS DEFERRED ON PURPOSE, and this is the whole reason this
    function exists rather than a module-level ``from tests.conftest import
    ...``. tests/conftest.py builds fixtures that themselves need to poll, so
    importing it at module scope from here risks a genuine import cycle:
    conftest imports this module, which imports conftest, which is still
    halfway through executing. Deferring the import to call time removes the
    cycle entirely while keeping conftest.py authoritative - by the time any
    poll runs, conftest has finished importing and is already in
    ``sys.modules``, so the lookup is a dictionary hit and costs nothing.

    ``tests`` resolves as an implicit namespace package: python/pyproject.toml
    sets ``pythonpath = ["."]`` and ``consider_namespace_packages = true``, and
    python/tests deliberately carries no ``__init__.py``.

    THE FALLBACK EXISTS SO THIS MODULE REMAINS USABLE STANDALONE - imported by
    a script, or by ``python -c "import tests.helpers.polling"`` from a tree
    where pytest is not installed, which is exactly how this file's
    stdlib-only property is verified.

    ONLY ``ImportError`` IS CAUGHT, and the narrowness is the point. That one
    exception covers both genuine unavailabilities and nothing else: its
    ``ModuleNotFoundError`` subclass is raised when ``tests.conftest`` cannot be
    found at all, and ``ImportError`` itself is raised when the module is found but
    does not define one of the two names. Catching ``Exception`` also swallowed
    every failure raised WHILE conftest executed - a typo, a bad constant, a
    fixture-module bug - and substituted plausible-looking defaults for it, so a
    real programming error surfaced later as a mysterious timing difference instead
    of as the traceback that names the line. Such an error now propagates.

    The fallback values are not an independent opinion about how long to wait:
    each mirrors the same Go source the conftest constant cites, so the two
    paths agree by construction. Should they ever disagree, conftest wins,
    because every run under pytest takes the imported branch.
    """
    try:
        from tests.conftest import (
            DEFAULT_POLL_INTERVAL_SECONDS,
            FOREVER_TEST_TIMEOUT_SECONDS,
        )
    except ImportError:
        return (_FALLBACK_POLL_INTERVAL_SECONDS, _FALLBACK_POLL_TIMEOUT_SECONDS)
    return (DEFAULT_POLL_INTERVAL_SECONDS, FOREVER_TEST_TIMEOUT_SECONDS)


def _resolve_budget(interval: float | None, timeout: float | None) -> tuple[float, float]:
    """Fill in whichever of ``interval`` and ``timeout`` the caller left unset.

    ``None`` means "use the tier's default", not "no bound": an unbounded poll
    has no place in a suite whose hangs must become failures. Only the
    parameters actually left as ``None`` are resolved, so a caller that
    overrides one keeps the tier default for the other - which is what lets
    ``expect``'s one-second interval coexist with the shared 30 s ceiling.

    Both values are then validated. A non-positive interval is refused because
    ``poller`` builds a ``time.NewTicker`` from it (poll.go:283) and that
    constructor panics on a non-positive duration; raising ``ValueError`` is
    the same refusal in Python. A non-positive timeout is refused because Go
    reads a zero timeout as INFINITY (poll.go:266-267), and a helper whose
    entire purpose is to bound a wait must not silently accept a value that
    unbounds it.
    """
    resolved_interval, resolved_timeout = interval, timeout
    if resolved_interval is None or resolved_timeout is None:
        session_interval, session_timeout = _session_defaults()
        if resolved_interval is None:
            resolved_interval = session_interval
        if resolved_timeout is None:
            resolved_timeout = session_timeout

    if resolved_interval <= 0.0:
        raise ValueError(
            "polling interval must be greater than zero, got "
            f"{resolved_interval!r}: a non-positive interval is what makes "
            "Go's time.NewTicker panic (poll.go:283)"
        )
    if resolved_timeout <= 0.0:
        raise ValueError(
            "polling timeout must be greater than zero, got "
            f"{resolved_timeout!r}: Go reads a zero timeout as infinity "
            "(poll.go:266-267), and this helper is bounded by contract"
        )
    return (resolved_interval, resolved_timeout)


# ---------------------------------------------------------------------------
# Failure rendering: what a CI reader actually sees when a budget runs out
# ---------------------------------------------------------------------------


def _indent(text: str | None) -> str:
    """Indent a diagnostic block by four spaces so it cannot be read as a field.

    Mirrors ``_indent`` in tests/helpers/bash.py, which renders captured
    subprocess output this way for the same reason: a multi-line diagnostic set
    flush against single-line fields is unreadable, and an absent one must say
    so rather than leave a blank the reader has to interpret.
    """
    if text is None or not text.strip():
        return "    <none supplied>"
    return "\n".join(f"    {line}" for line in text.rstrip("\n").split("\n"))


def _collect_last_diagnostic(describe_last: Callable[[], str | None] | None) -> str | None:
    """Invoke ``describe_last`` exactly once, on exhaustion, and only then.

    Port of the role ``lastMissingReport`` plays in the V6 test: the closure
    updates it on every unsatisfied tick (audit_test.go:1021) and the caller
    interpolates it into ``t.Fatalf`` when the poll gives up
    (audit_test.go:1031). Passing a callable rather than a string is what
    reproduces "the value AS IT STOOD when the budget ran out" - a string
    argument would have to be captured before the first attempt, when there is
    nothing to report yet.

    Invoked once, so a describe_last with a cost - rendering a report over
    thousands of observed events - is paid only on the failure path.

    A raise from ``describe_last`` is caught and rendered inline. This is the
    one place in this module where an exception does not propagate, and the
    reasoning is specific rather than general: the finding is the TIMEOUT, and a
    diagnostic builder that fails must not be allowed to replace that finding
    with its own traceback. Nothing is hidden - the exception's type and message
    are written into the message in its place - and the predicate's exceptions,
    which carry real information about the system under test, are never treated
    this way.
    """
    if describe_last is None:
        return None
    try:
        return describe_last()
    except Exception as exc:
        return f"<describe_last() raised {type(exc).__name__}: {exc}>"


def _render_exhaustion(
    *,
    description: str | None,
    requirement: str | None,
    interval: float,
    timeout: float,
    attempts: int,
    elapsed: float,
    last_diagnostic: str | None,
    note: str | None = None,
) -> str:
    """Render the message of an exhausted poll: headline first, then fields.

    Go's exhausted poll produces "timed out waiting for the condition"
    (error.go:28) and nothing else, which is why every Go caller that cares
    about diagnosis keeps its own state and interpolates it by hand. This
    renderer is the port of that hand-rolled reporting, generalised so no call
    site has to repeat it.

    The requirement identifier PREFIXES the headline rather than sitting in a
    field, following ``_prefixed`` in tests/helpers/warnings.py: pytest's short
    test summary and the JUnit ``message`` attribute both show the first line
    only, and that first line is where a security failure most needs to name
    the requirement it violates (AAP §0.7.2).

    Every value the caller could want in order to decide "is this a real
    failure or too tight a budget" is present: the ceiling, the interval, how
    many attempts were actually made, and the true elapsed time - which exceeds
    the ceiling slightly whenever the final attempt was slow, and saying so is
    more useful than rounding it away.

    ``note`` carries an explanation from the helper itself rather than from the
    caller, and is used for exactly one thing today: saying that the monotonic
    clock did not advance. It is rendered before the caller's diagnostic and
    never in place of it.
    """
    headline = f"timed out after {timeout:g}s waiting for {description or 'the condition'}"
    if requirement:
        headline = f"{requirement}: {headline}"
    lines = [
        headline,
        f"  budget: {timeout:g}s (elapsed {elapsed:.3f}s)",
        f"  interval: {interval:g}s",
        f"  attempts: {attempts}",
    ]
    if note:
        lines.append(f"  note: {note}")
    lines.append("  last diagnostic:")
    lines.append(_indent(last_diagnostic))
    return "\n".join(lines)


class PollPredicateError(TypeError):
    """Raised when a polled condition returns anything other than ``True`` or ``False``.

    THE FALSE-PASS THIS CLOSES. Go's ``wait.ConditionFunc`` is
    ``func() (done bool, err error)``, so the compiler guarantees the decision is
    a boolean and nothing else can end a poll. Python has no such guarantee, and
    ``if condition():`` accepts every truthy object -- which in this suite means a
    security gate can be cleared by a value that never said ``True``:

      * a ``(False, None)`` tuple, the shape a literal transcription of the Go
        signature produces. A non-empty tuple is truthy, so the poll would return
        on a predicate that reported NOT DONE;
      * a ``MissingEventsReport``, a ``Response``, an ``ApiException`` or any
        other object with no ``__bool__`` -- truthy by default, so returning the
        evidence instead of a verdict about it would satisfy the poll;
      * an un-awaited coroutine, which a missing ``await`` produces and which is
        always truthy;
      * a non-empty list of remaining work, whose emptiness is the real
        condition and whose truthiness is its exact negation.

    Every one of those clears the poll on the FIRST attempt, so the failure is
    silent: the caller's own assertions then run against whatever state exists
    and frequently pass. A ``TypeError`` at the first attempt is the opposite -
    loud, immediate, and naming the returned type.

    A ``TypeError`` and deliberately NOT an ``AssertionError``: this is a defect
    in the calling test's code, not a finding about the system under test, so it
    must not be capturable by a ``pytest.Subtests`` block that is accumulating
    security findings. It also must not derive from :class:`PollTimeoutError`,
    whose whole meaning is "the budget elapsed", which is not what happened.
    """


class PollTimeoutError(AssertionError, TimeoutError):
    """Raised when a poll exhausts its budget without the condition holding.

    Port of ``wait.ErrWaitTimeout`` (staging/src/k8s.io/apimachinery/pkg/util/
    wait/error.go:28), the value ``waitForWithContext`` returns at wait.go:220
    when the tick channel closes on an unsatisfied condition.

    INVARIANT PRESERVED: exhaustion is a distinguishable, non-silent outcome.
    Go's callers test it with ``if err != nil``; here it is an exception, so a
    caller that forgets to check cannot mistake a timeout for a pass - which is
    strictly stronger than the original and is the only respect in which this
    port deliberately improves on it.

    WHY IT DERIVES FROM ``AssertionError``

    So that the accumulate-or-abort choice belongs to the CALL SITE, exactly as
    it does in Go, where the same failure is reported through ``t.Errorf`` to
    accumulate or ``t.Fatalf`` to abort. Wrapped in ``with subtests.test(...)``
    the subtest context catches this, reports it and lets the next case run
    (accumulate, the ``t.Errorf`` shape); raised bare it aborts the test
    (the ``t.Fatalf`` shape, which is what audit_test.go:1031 does). One
    exception type serves both because the caller, not the exception, decides.

    WHY IT ALSO DERIVES FROM ``TimeoutError``

    Because a timeout is what it is, and a caller that wants to treat every
    timeout in a test alike should be able to write ``except TimeoutError``
    without knowing which helper produced it. The linearisation is clean -
    ``PollTimeoutError`` then ``AssertionError`` then ``TimeoutError`` then
    ``OSError`` - and ``str()``, ``repr()`` and ``args`` all behave exactly as
    they do for a single-base exception.

    ONE CONSEQUENCE WORTH KNOWING, because it is not obvious: ``TimeoutError``
    is a subclass of ``OSError``, so this is an ``OSError`` too. A call site
    that wraps a poll in ``except OSError`` - plausible around code that also
    touches files or sockets - will therefore catch an exhausted poll. Such a
    handler should name the errors it means, which is good practice regardless
    of this class.

    The structured fields are attributes as well as message text so that a test
    ABOUT polling can assert on them without parsing prose. The message is
    built inside ``__init__`` from those same fields, so the two can never
    disagree.
    """

    def __init__(
        self,
        *,
        interval: float,
        timeout: float,
        attempts: int,
        elapsed: float,
        last_diagnostic: str | None = None,
        description: str | None = None,
        requirement: str | None = None,
        note: str | None = None,
    ) -> None:
        """Build the message from the fields, then keep the fields.

        Keyword-only throughout: eight values of which four are numbers, and a
        positional call would be a puzzle at every call site and a silent
        transposition waiting to happen at one of them.
        """
        super().__init__(
            _render_exhaustion(
                description=description,
                requirement=requirement,
                interval=interval,
                timeout=timeout,
                attempts=attempts,
                elapsed=elapsed,
                last_diagnostic=last_diagnostic,
                note=note,
            )
        )
        #: The interval that was slept between attempts, in seconds.
        self.interval = interval
        #: The ceiling that was exhausted, in seconds.
        self.timeout = timeout
        #: How many times the condition was actually invoked. Always >= 1: the
        #: at-least-once guarantee holds on the failure path too.
        self.attempts = attempts
        #: Monotonic seconds from entry to exhaustion. May slightly exceed
        #: ``timeout`` when the last attempt was slow.
        self.elapsed = elapsed
        #: Whatever ``describe_last`` returned, or ``None`` if none was given.
        self.last_diagnostic = last_diagnostic
        #: The caller's description of what was being waited for.
        self.description = description
        #: The requirement identifier the call site enforces, if it named one.
        self.requirement = requirement
        #: An explanation contributed by the helper rather than the caller.
        #: Set when the attempt ceiling stopped the loop because the monotonic
        #: clock was not advancing; ``None`` on an ordinary exhaustion.
        self.note = note


# ---------------------------------------------------------------------------
# The loop, and the two named entry points that differ only in when it starts
# ---------------------------------------------------------------------------


def _evaluate(condition: Callable[[], bool], *, attempt: int) -> bool:
    """Invoke ``condition`` once and return its result ONLY if it is a real boolean.

    THE ONE PLACE a polled decision is read, so both call sites in :func:`_poll`
    are exact by construction rather than by two copies of the same care.

    ``type(result) is not bool`` and NOT ``isinstance``: ``bool`` has no
    subclasses in CPython, but the check is written as an exact type test to say
    that nothing bool-LIKE is accepted either - notably ``numpy.bool_``, which
    ``isinstance`` would reject anyway and which a reader should not have to
    reason about, and ``0``/``1``, which ``isinstance(x, int)`` would accept.

    An un-awaited coroutine is named specifically, because it is the mistake with
    the least informative default message: ``<coroutine object ...>`` in a
    ``TypeError`` about types tells a reader nothing, whereas "you forgot to
    await it" tells them everything. The coroutine is closed before raising so
    the interpreter does not additionally emit a "coroutine was never awaited"
    RuntimeWarning that would displace this message.

    A RAISE from the condition itself is NOT touched here: it propagates
    unchanged, which is the port of ``if err != nil { return err }`` at
    wait.go:213-215.

    Args:
        condition: The predicate under test.
        attempt: 1-based attempt number, quoted in the failure so a reader can
            see whether the wrong type appeared immediately or only later.

    Returns:
        The predicate's boolean decision.

    Raises:
        PollPredicateError: if the predicate returned anything but ``True`` or
            ``False``.
    """
    __tracebackhide__ = True
    result = condition()
    if type(result) is bool:
        return result

    if inspect.iscoroutine(result):
        result.close()
        raise PollPredicateError(
            f"the polled condition returned a COROUTINE on attempt {attempt} instead of a "
            f"bool: it is an async function that was never awaited, so the poll would have "
            f"returned immediately on a truthy object that made no decision at all. Await it "
            f"inside a synchronous wrapper, or poll the synchronous predicate."
        )

    raise PollPredicateError(
        f"the polled condition returned {type(result).__name__} ({result!r}) on attempt "
        f"{attempt} instead of a bool. A poll ends on an exact True and on nothing else: "
        f"every other value is truthy or falsey by accident, so accepting one would let a "
        f"predicate that never reported success end the poll - a (False, None) tuple, a "
        f"report object, an HTTP response and a list of remaining work are all truthy. "
        f"Return True or False."
    )


def _poll(
    condition: Callable[[], bool],
    *,
    immediate: bool,
    interval: float | None,
    timeout: float | None,
    description: str | None,
    requirement: str | None,
    describe_last: Callable[[], str | None] | None,
) -> None:
    """The single loop behind :func:`poll` and :func:`poll_immediate`.

    Port of the private ``poll`` at poll.go:243-262 together with the driver it
    delegates to, ``waitForWithContext`` at wait.go:205-228. Go needs the two
    because its ticks arrive on a channel fed by a goroutine; a synchronous
    Python loop needs neither channel nor goroutine, so they collapse into one
    function whose ``immediate`` parameter is the very flag Go's private
    ``poll`` takes at poll.go:243.

    Both public entry points route through here so their behaviour cannot drift
    apart - the difference between them is one boolean, and the shape of the
    loop is identical in Go for the same reason.

    INVARIANTS PRESERVED, each traceable to a line of the original:

      * "'condition' will always be invoked at least once" (poll.go:54 and
        poll.go:162). This loop cannot exit without an attempt, even when the
        budget has already elapsed on entry. Go earns that guarantee from the
        channel CLOSE: ``poller`` closes the channel when its timer fires
        (poll.go:281) and ``waitForWithContext`` runs ``fn`` for the closed
        receive before returning ErrWaitTimeout (wait.go:211-221).
      * The interval is slept BETWEEN attempts and is never merged into one
        long sleep, so a predicate with side effects performs them once per
        tick - the property the V6 test depends on.
      * The sleep is clamped to what remains of the budget, so the final
        attempt lands ON the deadline instead of past it. That is exactly where
        Go's close-driven final attempt lands, and it is what makes
        ``timeout=0.3`` fail in about 0.3 s rather than at the next whole
        interval.
      * A raise from the predicate leaves this function at once, unwrapped,
        with no further attempt - reproducing ``if err != nil { return err }``
        at wait.go:213-215.
      * ONLY an exact boolean ``True`` ends the poll. Go's ``ConditionFunc``
        returns ``(bool, error)``, so the type system guarantees it there; here
        :func:`_evaluate` guarantees it, and every other value raises
        :class:`PollPredicateError` on the attempt that produced it. Truthiness
        is never consulted, because a truthy non-boolean would clear the poll -
        and therefore a security gate - without any predicate having said so.
      * Exhaustion raises :class:`PollTimeoutError`, reproducing ``return
        ErrWaitTimeout`` at wait.go:220 and adding the diagnostic Go's error
        does not carry.

    Every piece of state - the deadline, the attempt count - is local to this
    frame. There is no module-level mutable state anywhere in this file, which
    is what makes the helper safe under ``pytest-xdist -n auto`` and immune to
    the reordering ``pytest-randomly`` performs.
    """
    __tracebackhide__ = True

    resolved_interval, resolved_timeout = _resolve_budget(interval, timeout)

    # MONOTONIC, deliberately, and never time.time(): an NTP step or a manual
    # clock change mid-poll must not be able to extend or truncate the budget,
    # and a wall clock that moves backwards would unbound it altogether.
    started = time.monotonic()
    deadline = started + resolved_timeout
    attempts = 0

    # The second bound, and the reason it cannot bind on a healthy clock.
    #
    # Every iteration below either sleeps min(interval, remaining) - which is
    # `interval` until the budget's final fragment - or exits, so a clock that
    # advances permits at most ceil(timeout / interval) iterations, plus the one
    # immediate attempt. `+ 3` therefore leaves slack that no real run can
    # consume: a SLOW predicate makes strictly FEWER attempts, never more.
    #
    # A clock that does NOT advance is the case this exists for. Measured:
    # freezegun 1.5.5 with its default tick=False freezes time.monotonic while
    # leaving time.sleep real, so `remaining` would stay positive for ever and
    # this loop would spin until pytest-timeout reaped the whole test 300 s
    # later with no explanation. With this ceiling the same mistake produces a
    # PollTimeoutError that names the cause.
    max_attempts = int(resolved_timeout // resolved_interval) + 3
    clock_stalled = False

    if immediate:
        # PollImmediate's "always checks 'condition' before waiting for the
        # interval" (poll.go:161-162), which is the immediate arm at
        # poll.go:244-251: invoke once, let a raise propagate, return on
        # success, otherwise fall through into the interval loop below.
        attempts += 1
        if _evaluate(condition, attempt=attempts):
            return

    while True:
        if attempts >= max_attempts:
            # Unreachable while the clock advances; see max_attempts above.
            clock_stalled = True
            break
        remaining = deadline - time.monotonic()
        if remaining > 0.0:
            time.sleep(min(resolved_interval, remaining))
        elif attempts > 0:
            break
        # Reaching here with the budget already spent and nothing yet attempted
        # means the caller passed a timeout shorter than one interval, or that
        # resolution itself outlived it. Fall through and take the one attempt
        # the at-least-once guarantee owes them - Go's close-driven receive
        # (poll.go:281 closes, wait.go:211-221 runs fn for the closed receive) -
        # and let the next iteration exhaust.
        attempts += 1
        if _evaluate(condition, attempt=attempts):
            return

    raise PollTimeoutError(
        interval=resolved_interval,
        timeout=resolved_timeout,
        attempts=attempts,
        elapsed=time.monotonic() - started,
        last_diagnostic=_collect_last_diagnostic(describe_last),
        description=description,
        requirement=requirement,
        note=(
            "the monotonic clock did not advance across "
            f"{attempts} attempts, so the budget could never elapse; the usual "
            "cause is a poll wrapped in freezegun's freeze_time with its "
            "default tick=False, which freezes time.monotonic - pass tick=True "
            "or do not freeze time around a poll"
            if clock_stalled
            else None
        ),
    )


def poll(
    condition: Callable[[], bool],
    *,
    interval: float | None = None,
    timeout: float | None = None,
    description: str | None = None,
    requirement: str | None = None,
    describe_last: Callable[[], str | None] | None = None,
) -> None:
    """Wait the interval, THEN evaluate ``condition``, until it holds or time runs out.

    Port of ``wait.Poll``, staging/src/k8s.io/apimachinery/pkg/util/wait/
    poll.go:65, whose contract is "Poll always waits the interval before the
    run of 'condition'. 'condition' will always be invoked at least once"
    (poll.go:53-54).

    INVARIANT PRESERVED: the FIRST evaluation happens one interval in, not at
    entry. The V6 call site is what makes that load-bearing -
    ``wait.Poll(500*time.Millisecond, wait.ForeverTestTimeout, ...)`` at
    test/integration/controlplane/audit/audit_test.go:1009 - because the API
    server writes its audit log asynchronously, so reading it at t=0 observes an
    empty file and spends an attempt on a foregone conclusion. Use
    :func:`poll_immediate` when the condition can plausibly already hold.

    Args:
        condition: Zero-argument predicate, re-invoked on EVERY tick with all of
            its side effects intact - the V6 predicate re-runs its API
            operations each time precisely so the log gains new events
            (audit_test.go:1010). Return ``True`` to stop and return, ``False``
            to sleep and retry, and RAISE to abort immediately; a raised
            exception propagates to the caller unchanged and unwrapped, which is
            the port of Go's ``(false, err)`` (wait.go:213-215). A predicate
            that wants a transient failure retried must catch it itself and
            return ``False``, exactly as its Go counterpart chooses
            ``(false, nil)``.
        interval: Seconds to sleep between attempts. ``None`` means
            ``tests.conftest.DEFAULT_POLL_INTERVAL_SECONDS``, the 500 ms the V6
            test passes. Must be greater than zero.
        timeout: Total seconds allowed. ``None`` means
            ``tests.conftest.FOREVER_TEST_TIMEOUT_SECONDS``, the port of
            ``wait.ForeverTestTimeout = time.Second * 30``
            (staging/src/k8s.io/apimachinery/pkg/util/wait/wait.go:37). Must be
            greater than zero; a zero timeout is NOT read as infinity here.
        description: What is being waited for, phrased to follow "waiting
            for" - "the expected audit events to be observed". Appears in the
            failure headline.
        requirement: Identifier of the requirement the call site enforces, for
            example ``F-006-RQ-002``. Prefixes the failure headline so a CI
            failure reads as a requirement violation (AAP §0.7.2).
        describe_last: Zero-argument callable invoked ONLY on exhaustion, to
            build the last-diagnostic block. This is the port of the V6
            closure's ``lastMissingReport`` (audit_test.go:1021, reported at
            audit_test.go:1031); without it an exhausted poll reports nothing
            more useful than Go's bare "timed out waiting for the condition".

    Raises:
        PollTimeoutError: The budget was exhausted with the condition never
            true. Derives from ``AssertionError``, so the call site decides
            between accumulate and abort, and from ``TimeoutError``.
        PollPredicateError: ``condition`` returned something other than ``True``
            or ``False``. Raised on the attempt that returned it, before any
            further attempt and before the budget can elapse.
        ValueError: ``interval`` or ``timeout`` is not greater than zero.
        Exception: Anything the predicate raises, propagated unchanged.
    """
    __tracebackhide__ = True
    _poll(
        condition,
        immediate=False,
        interval=interval,
        timeout=timeout,
        description=description,
        requirement=requirement,
        describe_last=describe_last,
    )


def poll_immediate(
    condition: Callable[[], bool],
    *,
    interval: float | None = None,
    timeout: float | None = None,
    description: str | None = None,
    requirement: str | None = None,
    describe_last: Callable[[], str | None] | None = None,
) -> None:
    """Evaluate ``condition`` at once, THEN wait the interval between retries.

    Port of ``wait.PollImmediate``, staging/src/k8s.io/apimachinery/pkg/util/
    wait/poll.go:156, whose contract is "PollImmediate always checks
    'condition' before waiting for the interval. 'condition' will always be
    invoked at least once" (poll.go:161-162).

    INVARIANT PRESERVED: the first evaluation happens at entry, before any
    sleep, so a condition that already holds is answered without paying an
    interval for it. Two call sites make that matter: ``expect`` at
    test/integration/auth/node_test.go:684-696, which passes
    ``time.Second, 30*time.Second`` and is how V7 asserts four separate
    authorization outcomes - each of which is normally decided on the first
    request, so waiting first would add four seconds and no information - and
    ``WaitForPodToDisappear`` at test/integration/utils.go:56-67.

    Identical to :func:`poll` in every other respect, including the arguments,
    the exceptions and the predicate contract; both delegate to one loop so the
    only difference between them stays the one difference Go has.

    Args:
        condition: Zero-argument predicate, invoked immediately and then
            re-invoked on every tick with all of its side effects intact.
            ``True`` stops and returns, ``False`` sleeps and retries, and a
            RAISE aborts at once and propagates unchanged.
        interval: Seconds between attempts after the immediate one. ``None``
            means ``tests.conftest.DEFAULT_POLL_INTERVAL_SECONDS``. Note that
            the ported call sites pass this explicitly - ``expect`` uses one
            second - because their Go originals do.
        timeout: Total seconds allowed, measured from entry and therefore
            INCLUDING the immediate attempt. ``None`` means
            ``tests.conftest.FOREVER_TEST_TIMEOUT_SECONDS``, the port of
            ``wait.ForeverTestTimeout`` at
            staging/src/k8s.io/apimachinery/pkg/util/wait/wait.go:37.
        description: What is being waited for, phrased to follow "waiting for".
        requirement: Identifier of the requirement the call site enforces, for
            example ``F-007-RQ-002``; it prefixes the failure headline.
        describe_last: Zero-argument callable invoked ONLY on exhaustion. The
            natural argument here is the ``lastErr``-style value ``expect``
            keeps in its closure (node_test.go:687), rendered as text.

    Raises:
        PollTimeoutError: The budget was exhausted with the condition never
            true.
        PollPredicateError: ``condition`` returned something other than ``True``
            or ``False``.
        ValueError: ``interval`` or ``timeout`` is not greater than zero.
        Exception: Anything the predicate raises, propagated unchanged.
    """
    __tracebackhide__ = True
    _poll(
        condition,
        immediate=True,
        interval=interval,
        timeout=timeout,
        description=description,
        requirement=requirement,
        describe_last=describe_last,
    )
