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

"""HTTP status predicates over ``ApiException``, and the retrying expectations
built on them.

Two Go primitives are ported here, and they arrive together because in the Go
suite one is useless without the other:

  * ``apierrors.IsForbidden`` and its siblings from
    k8s.io/apimachinery/pkg/api/errors, the predicates that decide WHICH error
    an authorization test just observed. The status codes they test are the
    ones test/integration/utils.go:44-53 declares as ``Code403 =
    map[int]bool{403: true}`` (line 49) and ``Code404`` (line 50).
  * The ``expect`` family at test/integration/auth/node_test.go:684-731 -
    ``expect``, ``expectForbidden``, ``expectNotFound``, ``expectAllowed``,
    ``checkNilError`` and ``expectedForbiddenMessage`` - which wrap those
    predicates in a bounded retry and turn the outcome into a test failure.

Every ported integration module that asserts a 403 goes through this module, so
the two properties below are not stylistic preferences. They are the reason a
security test fails when the control it guards regresses, instead of passing
for the wrong reason.

WHY THE PREDICATES ARE EXACT, AND WHY 403 AND 404 MUST NEVER BE CONFLATED

Each predicate tests exactly one status code: 403, 404, 409. Not "any 4xx", not
"any error", not "not 2xx".

``TestNodeRestrictionCrossNodeDenied`` (V7) carries an explicit ORDER MATTERS
constraint, and this module is half of what makes that constraint enforceable:
node2 must already exist before node1 attempts the cross-node status update,
because a request against a node that is absent is answered **404 NotFound**
rather than **403 Forbidden**. The test asserts Forbidden. A predicate that
accepted "any 4xx" would therefore pass on a cluster where NodeRestriction had
been removed entirely - the update would simply 404 - and the security finding
would be silently inverted into a green run. Keeping :func:`is_forbidden` and
:func:`is_not_found` strictly disjoint is what makes the ordering hazard
detectable rather than latent. The fixture that guarantees the ordering belongs
to tests/integration/conftest.py; the predicate that refuses to accept the
wrong answer belongs here.

The same reasoning applies to V2 from the other direction.
``TestPodSecurityEnforceBaselineRejectsPrivileged`` requires the namespace's
``default`` ServiceAccount to exist before the pod is created, and says so at
podsecurity_test.go:367-374: without it, "pod creation would otherwise fail
with a non-Forbidden error before ever reaching the PodSecurity plugin".
Creating that ServiceAccount is again the fixture's job - and again, it is this
module's exactness that stops the wrong error being accepted if the fixture
ever regresses.

WHY ``is_already_exists`` IS HERE WITH NO ``Code409`` TO CITE

test/integration/utils.go declares no ``Code409``, because none of the tests
that use those maps assert Conflict. The predicate is still required: the V2
namespace fixture creates the ``default`` ServiceAccount tolerantly, exactly as
podsecurity_test.go:384 does with ``!apierrors.IsAlreadyExists(err)``, so that
a namespace which already has one is not a failure. 409 Conflict is the code
the API server returns for that, so 409 is what the predicate tests.

ACCUMULATE OR ABORT IS THE CALLER'S CHOICE, NOT THIS MODULE'S

Go draws a deliberate line through this family. ``expectForbidden``,
``expectNotFound``, ``expectAllowed`` and ``expectedForbiddenMessage`` all
report through ``t.Errorf``, which RECORDS the failure and lets the test carry
on, so a single run reports every offending case rather than only the first.
``checkNilError`` reports through ``t.Fatalf``, which ABORTS, because a failure
to set the fixture up is not a finding to be collected - it invalidates
everything after it.

Python has no two-verb assertion vocabulary, so the choice is moved to the call
site and the mechanism is uniform: every expectation here raises
``AssertionError``. Wrapped in ``with subtests.test(...)`` the subtest context
catches it, reports it and lets the loop continue - the ``t.Errorf`` shape.
Called bare, it propagates and the test stops - the ``t.Fatalf`` shape. One
exception type serves both because the caller, not the exception, decides. This
mapping is fixed by AAP §0.4.1.2, whose measured experiment confirmed that a
``subtests``-wrapped assertion reports every failing case in one run while the
same logic unwrapped stops at the first.

:func:`check_nil_error` is the one member that is documented as ABORT-ONLY. It
still raises the same ``AssertionError`` - it has to, or wrapping it would be a
silent no-op - but its docstring says plainly that wrapping it in ``subtests``
defeats its purpose, because a fixture that failed to build must not be
collected past.

No soft-assert of any kind is invented here, and ``pytest`` is not imported.
The accumulating behaviour comes entirely from the caller's ``subtests``
context, which is pytest 9 core.

WHY THE RETRY EXISTS AND WHY ITS BUDGET IS FIXED

``expect`` does not call the operation once. It polls it through
``wait.PollImmediate(time.Second, 30*time.Second, ...)``
(node_test.go:686), and that is load-bearing rather than defensive: the Node
authorizer and the RBAC bootstrap converge ASYNCHRONOUSLY, so a single call
made too early can observe a transient answer - most often an allow that is
about to become a deny, or a deny that is about to become an allow. Dropping
the loop would not change what the test asserts; it would change how often the
test is right, which is worse, because the resulting flake looks like a real
finding.

One second and thirty seconds are the measured original values.
``_EXPECT_INTERVAL_SECONDS`` and ``_EXPECT_TIMEOUT_SECONDS`` record them and are
passed to :func:`tests.helpers.polling.poll_immediate` EXPLICITLY at every call,
never left to that module's defaults - those defaults are 500 ms and 30 s, the
values the V6 audit test passes to ``wait.Poll``, and 500 ms is the wrong
interval here.

Each expectation still accepts ``interval`` and ``timeout`` as keyword
overrides, exactly as ``poll_immediate`` does, because a helper whose budget can
only be changed by editing it cannot be tested for the behaviour AT its budget.
A parity call site must not use them: the defaults are the measured original,
and widening one makes an assertion meaningless while narrowing one makes it
flaky.

``poll_immediate`` and not ``poll``: PollImmediate "always checks 'condition'
before waiting for the interval", so an operation that is ALREADY forbidden is
answered at once. V7 makes four such assertions and V2 three, and waiting an
interval before each would add seconds and no information.

WHY AN EXHAUSTED POLL IS CAUGHT RATHER THAN ALLOWED TO SURFACE

``expect`` returns ``(err == nil, lastErr)`` (node_test.go:695): it examines
the poll's error only for nil-ness and DISCARDS it, so the message the reader
sees is the caller's - "Expected forbidden error, got ..." - and never a bare
timeout. :func:`_expect` reproduces that by catching
:class:`tests.helpers.polling.PollTimeoutError` and returning an unsatisfied
outcome, which is why the failures raised from this module read as the Go ones
do. The diagnostic the timeout would have carried is not lost: attempts and
elapsed time are counted here and rendered as fields beneath the headline.

MATCHING A SERVER MESSAGE IS NOT A SUBSTRING SEARCH ON ``str(exc)``

``expectedForbiddenMessage`` matches with
``strings.Contains(e.Error(), expectedMessage)``, and for the
``*errors.StatusError`` the client returns, ``Error()`` is the DECODED
``ErrStatus.Message`` - the server's sentence, with its quotation marks intact.

The Python client is shaped differently, and the difference was MEASURED
against the pinned 34.1.0 client rather than assumed:

  * ``ApiException.body`` is ``urllib3``'s ``resp.data``, so it is **bytes**,
    and it holds the metav1.Status JSON rather than the message alone.
  * ``ApiException.__str__`` interpolates that body with ``"{0}".format(...)``,
    which renders bytes through ``repr`` - so every backslash escape in the
    JSON is escaped a second time.

Consequently, for the exact expectation at node_test.go:1131 - ``audience
"audience1" not found in pod spec volume, system:node:node1 is not authorized
to request tokens for this audience`` - the substring is ABSENT from
``str(exc)``, ABSENT from the decoded body (JSON wrote the quotes as ``\\"``),
and PRESENT only in the decoded ``message`` field. Around forty of the real
call sites at node_test.go:962-1349 pass needles containing double quotes, so a
port that searched only the rendered exception would match none of them: each
would poll for the full thirty seconds and then report a failure that was
purely an artifact of client-side formatting.

:func:`_forbidden_message_haystacks` therefore searches three renderings and
accepts a hit in any - the decoded metav1.Status ``message`` field first,
because it is the true analogue of Go's ``Error()``, then the decoded body
text, then ``str(exc)``. That is a strict SUPERSET of searching the rendered
exception, so nothing that used to match stops matching; it is what makes the
match test the server's sentence rather than the client's formatting of it.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

It does not broaden a predicate. There is no ``is_client_error``, no
``is_any_error`` and no "expected one of these codes" variant, because every
such convenience is a way for a test to pass on the wrong answer.

It ports only the three predicates the ported tests actually use - Forbidden,
NotFound, AlreadyExists - and stops there. ``apierrors.IsInvalid``, used at
podsecurity_test.go:293 by a test this workstream does not own, is deliberately
absent: an unused predicate is surface with no consumer to keep it honest.

It imports ``kubernetes`` at module scope, unlike tests/helpers/manifest.py
which defers the same import. The asymmetry is intentional and not an
oversight: manifest.py serves the SHELL tier, which must stay importable with a
bash interpreter and nothing else, whereas every consumer of this module is an
integration test that already requires the pinned client to do anything at all.
Deferring here would buy nothing and hide the dependency.

It declares no fixture. Fixtures belong to the tier's conftest.py files,
because a module-, package- or session-scoped autouse fixture declared inline
in an ordinary module can execute twice under ``--doctest-modules``.

It declares no test, so this module contributes nothing to collection.

USAGE

V7, where the two denials accumulate and the positive controls follow:

    from tests.helpers.apierrors import expect_allowed, expect_forbidden

    def test_node_restriction_cross_node_denied(subtests, node1, node2):
        for name, operation in cross_node_mutations(node1, target=node2):
            with subtests.test(operation=name):          # accumulate
                expect_forbidden(operation, requirement="F-007-RQ-002")

        expect_allowed(lambda: node1.read_own_node(),    # positive control:
                       requirement="F-007-RQ-002")       # abort if broken

V2, where the rejection must be Forbidden and not a masked ServiceAccount
error:

    expect_forbidden(
        lambda: create_privileged_pod(dry_run=["All"]),
        requirement="F-002-RQ-001",
    )
"""

# AAP §0.5.1 (the python/tests/helpers/apierrors.py row: "is_forbidden /
# is_not_found / is_already_exists over ApiException.status", sourced from
# k8s.io/apimachinery's apierrors) / §0.4.1.2, two of whose translation rows
# fix this module's whole design - "apierrors.IsForbidden(err)" maps to "except
# ApiException as e: assert e.status == 403", and "t.Errorf" (record the failure
# and continue) maps to a "with subtests.test(...) block" while "t.Fatalf"
# (abort this test immediately) maps to a bare assert / §0.10.2, whose
# "Positive controls" row requires that system:masters still be allowed */*/*
# and node1 still be allowed to read and update its own Node - "without them, a
# test also passes when the whole authorization stack is broken" - and whose
# "Assertion asymmetry" row requires that security findings accumulate while
# setup breakage aborts, because "collapsing both into one construct hides
# every finding after the first" / §0.7.2, which requires an assertion message
# to name the requirement identifier it enforces / tech-spec §6.6.1.2 ("real
# components, not mocks": these are statuses a real API server really returned).
#
# INVARIANT LOCKED BY THIS FILE: an authorization outcome is accepted only when
# it is EXACTLY the status the test asked for - 403, 404 or 409, never a
# neighbouring code and never merely "an error" - observed through a bounded
# one-second / thirty-second immediate-first poll that gives an asynchronously
# converging authorizer time to settle without letting a hang pass as a result.
# Failure is always an AssertionError with the requirement identifier first, so
# the call site alone decides between accumulate and abort. Widen a predicate
# and every test guarding that control keeps passing while the control is gone;
# narrow the budget and the same tests become flaky; drop the JSON-decoded
# message from the haystack set and every quoted expectation matches nothing.

import http.client
import json
import logging
import time
from collections.abc import Callable
from typing import Final, NamedTuple, NoReturn

import urllib3.exceptions
from kubernetes.client.rest import ApiException

from tests.helpers.polling import PollTimeoutError, poll_immediate

__all__ = [
    "check_nil_error",
    "expect_allowed",
    "expect_forbidden",
    "expect_forbidden_message",
    "expect_not_found",
    "is_already_exists",
    "is_forbidden",
    "is_not_found",
]

#: Debug-level trace of every unsatisfied retry tick, the port of ``t.Logf(
#: "unexpected response, will retry: %v", lastErr)`` at node_test.go:692.
#:
#: A ``logging.Logger`` is NOT the module-level mutable state this file is
#: forbidden to hold. It is a process-wide, internally lock-guarded singleton
#: that carries no per-call state, so two ``pytest-xdist`` workers cannot
#: observe one another through it and ``pytest-randomly`` cannot reorder
#: anything into a different result. Everything that varies per call - the last
#: error, the attempt count, the deadline - lives in the calling frame.
#:
#: Deliberately a logger and not ``print``, and deliberately not ``caplog``:
#: pytest is not imported by this module, and ``log_level = "INFO"`` in
#: python/pyproject.toml means these DEBUG lines stay out of the JUnit report
#: until someone asks for them with ``--log-cli-level=DEBUG``, which is a
#: documented debug command.
_LOGGER: Final[logging.Logger] = logging.getLogger(__name__)

#: HTTP 403. ``Code403 = map[int]bool{403: true}`` at
#: test/integration/utils.go:49, and the status ``apierrors.IsForbidden``
#: matches. The code every V1, V2 and V7 denial assertion demands.
_FORBIDDEN_STATUS: Final[int] = 403

#: HTTP 404. ``Code404 = map[int]bool{404: true}`` at
#: test/integration/utils.go:50, and the status ``apierrors.IsNotFound``
#: matches. Kept rigorously distinct from 403: see the V7 ordering hazard in
#: this module's docstring.
_NOT_FOUND_STATUS: Final[int] = 404

#: HTTP 409 Conflict, the status ``apierrors.IsAlreadyExists`` matches. No
#: ``Code409`` exists in test/integration/utils.go because none of the tests
#: using those maps asserts Conflict; the V2 namespace fixture needs the
#: predicate all the same, mirroring podsecurity_test.go:384.
_ALREADY_EXISTS_STATUS: Final[int] = 409

#: Seconds between retries. ``time.Second``, the first argument ``expect``
#: passes to ``wait.PollImmediate`` at node_test.go:686. Passed explicitly to
#: ``poll_immediate`` on every call so that module's 500 ms default - the V6
#: audit interval - can never be inherited here by accident.
_EXPECT_INTERVAL_SECONDS: Final[float] = 1.0

#: Total seconds allowed. ``30*time.Second``, the second argument at
#: node_test.go:686, which is also ``wait.ForeverTestTimeout``. Comfortably
#: inside the 300 s per-test ceiling ``timeout`` sets in python/pyproject.toml,
#: so an exhausted expectation reports itself rather than being reaped.
_EXPECT_TIMEOUT_SECONDS: Final[float] = 30.0

#: How much of a rendered error may appear on the FIRST line of a failure.
#:
#: ``str(ApiException)`` is multi-line - status, reason, headers and body - and
#: pytest's short test summary and the JUnit ``message`` attribute both show
#: only the first line. Interpolating the raw rendering into the headline would
#: therefore push the diagnosis out of the one place a CI reader always sees.
#: The headline carries a single-line summary clipped to this many characters;
#: nothing is lost, because the untruncated multi-line form is always rendered
#: as a field directly beneath it.
_HEADLINE_SUMMARY_LIMIT: Final[int] = 200

#: The ONLY exceptions :func:`_expect` retries. Everything else propagates on the
#: first attempt, unwrapped - see that function's docstring for why breadth here
#: is a defect rather than robustness.
#:
#: Each member is here because a CONVERGING API server legitimately produces it
#: while the outcome under test is still settling, which is the exact condition
#: ``expect`` (test/integration/auth/node_test.go:684-696) exists to wait out:
#:
#:   * ``ApiException`` - the API server answered, and the answer is the subject
#:     of every predicate in this module. The RBAC or Node authorizer may not
#:     have caught up with a just-created binding yet, so a 403 that will become
#:     a 200 (or the reverse) arrives here.
#:   * ``urllib3.exceptions.HTTPError`` - the base of every urllib3 transport
#:     failure, and what the pinned client's REST layer surfaces when a
#:     connection is refused, reset or times out. Measured against
#:     ``kubernetes`` 34.1.0 on ``urllib3`` 2.3.0: ``ApiException`` does NOT
#:     derive from it (both descend straight from ``Exception``), so it must be
#:     listed separately rather than assumed to be covered.
#:   * ``http.client.HTTPException`` - a malformed or truncated response from a
#:     server mid-restart, raised beneath urllib3 rather than by it.
#:   * ``OSError`` - the socket layer itself: ``ConnectionResetError``,
#:     ``ConnectionRefusedError`` and ``TimeoutError`` are all subclasses, and a
#:     test server whose listener is not yet accepting produces them before
#:     urllib3 has anything to wrap. ``ssl.SSLError`` is covered by the same entry
#:     through inheritance, which is what a server whose serving certificate is not
#:     yet in place produces.
#:
#: Deliberately ABSENT, and each for the same reason - it is a defect in the test
#: rather than a transient state of the server, so retrying it wastes the whole
#: budget and then reports the last occurrence instead of the first cause:
#: ``TypeError``, ``AttributeError``, ``NameError``, ``KeyError``, ``ValueError``,
#: ``ImportError`` and ``AssertionError`` (which is also
#: :class:`~tests.helpers.polling.PollTimeoutError`'s base, and swallowing it
#: turned a real finding into a timeout about something else).
_RETRYABLE_OPERATION_ERRORS: Final[tuple[type[Exception], ...]] = (
    ApiException,
    urllib3.exceptions.HTTPError,
    http.client.HTTPException,
    OSError,
)


class _Outcome(NamedTuple):
    """What one bounded expectation observed. The port of ``expect``'s returns.

    ``expect`` returns ``(timeout bool, lastErr error)`` at node_test.go:684,
    and the two fields below are those two values under names that say which is
    which - ``timeout`` in the Go signature is in fact "did NOT time out", as
    ``return err == nil, lastErr`` at line 695 makes clear, and a positional
    Python tuple would preserve that trap.

    ``attempts`` and ``elapsed`` are additions, and they exist because this
    module swallows the poll's own exhaustion error (see :func:`_expect`) and
    would otherwise discard the only evidence of how hard it tried. Go discards
    it too; a reader of a CI failure should not have to.

    A ``NamedTuple`` rather than a dataclass: immutable, so no field can be
    reassigned after the observation it describes, and cheap enough to build on
    the success path as well as the failure path.
    """

    #: ``True`` when the predicate was satisfied within the budget. The
    #: negation of Go's misleadingly named ``timeout`` return.
    satisfied: bool

    #: The error the LAST invocation of the operation produced, or ``None`` if
    #: that invocation returned normally. The port of ``lastErr``.
    last_error: BaseException | None

    #: How many times the operation was actually invoked. Always at least one:
    #: ``poll_immediate`` guarantees the predicate runs before any sleep.
    attempts: int

    #: Monotonic seconds spent inside the expectation.
    elapsed: float



# ---------------------------------------------------------------------------
# Reading a status off whatever the operation raised, without ever raising
# ---------------------------------------------------------------------------


def _status_of(error: object) -> int | None:
    """Return the HTTP status ``error`` carries, or ``None`` if it carries none.

    The single place any status is read, so every predicate below is exact and
    total by construction rather than by three copies of the same care.

    TOTAL BY CONTRACT: any object may be passed - ``None`` for "the operation
    succeeded", a ``ValueError`` from something unrelated, an object with no
    ``status`` at all - and the answer is ``None`` rather than an exception.
    The Go predicates behave the same way for an error they do not recognise
    (``IsForbidden`` reasons over a ``*StatusError``'s code and simply returns
    false otherwise), and :func:`_expect` relies on it: the predicate is
    evaluated on whatever the operation produced, including ``None``.

    THE ``isinstance`` GATE IS DELIBERATE AND IS A STRENGTHENING. Only an
    ``ApiException`` can carry an API-server status, so an arbitrary object that
    merely happens to expose ``status = 403`` - an HTTP response, a mock, a
    stray namedtuple - is not mistaken for a Forbidden API error. Verified
    against the pinned 34.1.0 client: ``ApiException`` is the only
    status-carrying exception it defines, and its client-side siblings
    ``ApiTypeError``, ``ApiValueError`` and ``ApiKeyError`` descend from
    ``OpenApiException`` WITHOUT descending from ``ApiException``, so they
    correctly read as "no status". ``isinstance`` rather than an exact type
    check, so any future subclass is included.

    NOTHING IS COERCED, AND THE ABSENCE OF COERCION IS THE POINT. A REAL HTTP
    response always yields an ``int``: ``ApiException.__init__`` takes its status
    from ``http_resp.status`` on the error path (kubernetes/client/rest.py:238),
    and ``urllib3``'s ``HTTPResponse.status`` is an ``int``. The transport-failure
    path (rest.py:214 and :224) passes the ``int`` ``0``. There is no path through
    the pinned 34.1.0 client on which a genuine API-server status arrives as a
    string.

    ``ApiException(status="403")`` is therefore not a case to support - it is a
    HAND-BUILT FAKE, and accepting it is a false pass. These predicates are how
    V1, V2 and V7 prove a DENIAL: ``expect_forbidden`` passing means the API
    server refused the request. A helper that read ``"403"`` as Forbidden would
    let a test double satisfy that proof without any server having refused
    anything, which is precisely the class of defect the whole integration tier
    exists to rule out. So the type is checked exactly and never converted:
    a string status reads as "no status", the predicate is false, and the
    assertion reports the real shape it was handed.

    ``type(status) is int`` and NOT ``isinstance``: ``bool`` is a subclass of
    ``int``, and ``status=True`` is not a status. The exact test rejects it
    without a second branch, and it also rejects ``IntEnum`` and every other
    int-like wrapper, none of which any real response produces. It could not
    have produced a false POSITIVE either way - neither 403, 404 nor 409 equals
    ``True`` - but ``is int`` states the contract instead of leaving a reader to
    re-derive it.
    """
    if not isinstance(error, ApiException):
        return None

    # getattr with a default rather than attribute access: both constructor
    # branches do set .status, but a subclass or a partially initialised
    # instance need not have, and a predicate must not raise AttributeError.
    status = getattr(error, "status", None)

    # No isinstance, no int(), no strip(), no try/except: exactly an int, or no
    # status at all. See the docstring - the rejected cases are fakes, and
    # admitting a fake here would let one satisfy a denial assertion.
    if type(status) is int:
        return status
    return None


# ---------------------------------------------------------------------------
# Rendering: what a CI reader actually sees, and where each part of it goes
# ---------------------------------------------------------------------------


def _prefixed(message: str, requirement: str | None) -> str:
    """Prefix an assertion message with the requirement identifier it enforces.

    Mirrors ``_prefixed`` in tests/helpers/warnings.py exactly, deliberately
    including the name, so the two behave identically and a reader who has seen
    one has seen both. AAP §0.7.2 asks that a failure read as a requirement
    violation rather than as a value mismatch, because whoever reads a CI
    failure in a security suite is frequently not whoever wrote the test:
    ``F-002-RQ-001`` is the V2 privileged-pod rejection and ``F-007-RQ-002`` the
    V7 cross-node denial.

    It prefixes the HEADLINE rather than occupying a field of its own, because
    pytest's short test summary and the JUnit ``message`` attribute both show
    the first line only.

    A blank or absent identifier yields the message unchanged, so a caller never
    has to choose between an identifier it does not have and a message
    disfigured by an empty prefix.
    """
    if requirement is None or not requirement.strip():
        return message
    return f"{requirement}: {message}"


def _describe(error: object) -> str:
    """Render ``error`` in full, the port of Go's ``%v`` on an ``error`` value.

    Go's ``t.Errorf("... got %v", err)`` prints ``<nil>`` for a nil error and
    ``err.Error()`` otherwise. Here a successful operation is ``None``, rendered
    as ``None`` - Python's own word for the same thing, and what a Python reader
    expects to see.

    The type name is prepended for a real exception because
    ``str(ApiException)`` opens with ``(403)`` and never names itself, so
    without it a reader cannot tell an API status from an unrelated failure that
    happened to mention a number. Go needs no such help: its concrete error type
    is visible in the code that produced it.

    Never raises. A ``__str__`` that itself fails must not be allowed to replace
    the finding with its own traceback, so it is reported in place - the same
    treatment tests/helpers/polling.py gives a ``describe_last`` that raises.
    """
    if error is None:
        return "None"
    try:
        rendered = str(error)
    except Exception as exc:
        # Broad on purpose, and narrow in effect: the ONLY thing being defended
        # against is "rendering the diagnostic failed", and the exception's type
        # and message are written into the message rather than hidden. No `noqa`
        # accompanies this, because flake8-blind-except is deliberately not in
        # python/pyproject.toml's `select` list and RUF100 would then flag the
        # suppression itself as unused.
        return f"<{type(error).__name__}.__str__() raised {type(exc).__name__}: {exc}>"
    if not rendered:
        # ApiException(status=None, reason=None) renders as "(None)\nReason:
        # None\n", but a bare Exception() renders as "", and a blank field the
        # reader has to interpret is worse than a named empty one.
        return f"{type(error).__name__} (no message)"
    return f"{type(error).__name__}: {rendered}"


def _summarize(error: object) -> str:
    """Render ``error`` on ONE line, clipped, for the headline of a failure.

    Newlines become spaces because the headline must stay a single line to
    survive pytest's short test summary and the JUnit ``message`` attribute, and
    runs of whitespace collapse because the multi-line rendering of an
    ``ApiException`` would otherwise leave gaps where its line breaks were.

    Clipping is safe rather than lossy: :func:`_render_failure` always emits the
    untruncated :func:`_describe` rendering as a field immediately below, so the
    headline trades completeness for legibility and nothing else. The ellipsis
    marks the clip so no reader mistakes a truncated body for the whole one.
    """
    collapsed = " ".join(_describe(error).split())
    if len(collapsed) <= _HEADLINE_SUMMARY_LIMIT:
        return collapsed
    return collapsed[:_HEADLINE_SUMMARY_LIMIT] + " ...[truncated]"


def _indent(text: str) -> str:
    """Indent a multi-line diagnostic by four spaces so it cannot read as a field.

    Mirrors ``_indent`` in tests/helpers/polling.py and tests/helpers/bash.py,
    which render an exhaustion diagnostic and captured subprocess output the
    same way and for the same reason: a multi-line block set flush against
    single-line ``key: value`` fields is unreadable.
    """
    return "\n".join(f"    {line}" for line in text.rstrip("\n").split("\n"))



def _render_failure(
    headline: str,
    *,
    requirement: str | None,
    outcome: _Outcome,
    interval: float,
    timeout: float,
) -> str:
    """Build the message of a failed expectation: Go's headline, then the facts.

    The first line is the Go original's text with the requirement identifier in
    front of it, and nothing else, because that line is all pytest's short
    summary and the JUnit ``message`` attribute show.

    Everything beneath it is what Go throws away. ``expect`` discards the poll's
    error entirely (``return err == nil, lastErr`` at node_test.go:695), so a Go
    reader of "Expected forbidden error, got ..." cannot tell one attempt from
    thirty - whether the authorizer answered wrongly and consistently, or the
    test simply out-ran its budget. Both readings need a different fix, so both
    numbers are reported here.
    """
    lines = [
        _prefixed(headline, requirement),
        f"  attempts: {outcome.attempts} over {outcome.elapsed:.3f}s"
        f" (interval {interval:g}s, budget {timeout:g}s)",
        "  last error:",
        _indent(_describe(outcome.last_error)),
    ]
    return "\n".join(lines)


def _fail(
    headline: str,
    *,
    requirement: str | None,
    outcome: _Outcome,
    interval: float,
    timeout: float,
) -> NoReturn:
    """Raise the ``AssertionError`` that a failed expectation reports.

    One raise site for the whole family, so the message shape cannot drift
    between members.

    ``AssertionError`` and not a bespoke exception class: it is what makes the
    accumulate-or-abort decision the CALLER's. ``subtests.test(...)`` catches an
    ``AssertionError``, reports it and lets the loop continue - Go's ``t.Errorf``
    - while the same call left unwrapped propagates and stops the test - Go's
    ``t.Fatalf``. A dedicated subclass would work identically today and would
    invite a future ``except ApiExpectationError`` that quietly swallows a
    security finding.

    ``__tracebackhide__`` is set here as well as in every public entry point.
    pytest reports the deepest frame that is NOT hidden, so hiding only the
    entry point would leave THIS frame as the reported one and every failure in
    the suite would appear to originate inside this module.
    """
    __tracebackhide__ = True
    raise AssertionError(
        _render_failure(
            headline,
            requirement=requirement,
            outcome=outcome,
            interval=interval,
            timeout=timeout,
        )
    )


# ---------------------------------------------------------------------------
# The status predicates. Exactly one code each, and never a range.
# ---------------------------------------------------------------------------


def is_forbidden(error: object) -> bool:
    """Report whether ``error`` is an HTTP 403 Forbidden from the API server.

    Port of ``apierrors.IsForbidden`` (k8s.io/apimachinery/pkg/api/errors),
    whose status is ``Code403 = map[int]bool{403: true}`` at
    test/integration/utils.go:49. Its call sites in the owned tests are
    ``expectForbidden`` at test/integration/auth/node_test.go:700 and the two
    direct assertions at test/integration/auth/podsecurity_test.go:407 and :419.

    INVARIANT PRESERVED: 403 EXACTLY. Not "any 4xx", not "any error", not "not
    2xx". This predicate is the last thing standing between a passing security
    test and a cluster whose authorization stack has been removed - such a
    cluster answers the very same requests with 404, 401 or 200, and every one
    of those must read as a failure. AAP §0.10.2 records the positive controls
    (``system:masters`` must still be allowed ``*/*/*``; node1 must still be
    allowed to read and update its own Node) that exist to catch exactly that
    class of inversion; widening this predicate would defeat them.

    Never raises, for any argument. ``None`` - which is what
    :func:`_expect` passes when the operation SUCCEEDED - is not forbidden.

    Args:
        error: Whatever the operation produced. An ``ApiException``, ``None`` for
            success, or any other object.

    Returns:
        ``True`` only for an ``ApiException`` whose status is exactly 403.
    """
    return _status_of(error) == _FORBIDDEN_STATUS


def is_not_found(error: object) -> bool:
    """Report whether ``error`` is an HTTP 404 Not Found from the API server.

    Port of ``apierrors.IsNotFound``, whose status is ``Code404 =
    map[int]bool{404: true}`` at test/integration/utils.go:50. Used there by
    ``WaitForPodToDisappear`` (utils.go:62) and by ``expectNotFound`` at
    test/integration/auth/node_test.go:707.

    INVARIANT PRESERVED: 404 EXACTLY, and rigorously DISJOINT from
    :func:`is_forbidden`. This is the V7 ordering hazard made detectable:
    ``TestNodeRestrictionCrossNodeDenied`` must create node2 before node1
    attempts to mutate it, because a request against an absent node is answered
    404 and not 403. The test asserts Forbidden, so a predicate pair that
    treated the two codes alike would let the whole NodeRestriction control
    disappear without a single test turning red.

    Never raises, for any argument. ``None`` is not a NotFound.

    Args:
        error: Whatever the operation produced.

    Returns:
        ``True`` only for an ``ApiException`` whose status is exactly 404.
    """
    return _status_of(error) == _NOT_FOUND_STATUS


def is_already_exists(error: object) -> bool:
    """Report whether ``error`` is an HTTP 409 Conflict from the API server.

    Port of ``apierrors.IsAlreadyExists``, called at
    test/integration/auth/podsecurity_test.go:384 as
    ``!apierrors.IsAlreadyExists(err)`` so that creating the namespace's
    ``default`` ServiceAccount is idempotent - a namespace that already has one
    is not a failure, and any OTHER error still is.

    INVARIANT PRESERVED: 409 EXACTLY, and tolerance confined to that one code.
    This predicate is the only one in the module used to IGNORE an error rather
    than to require one, which makes its exactness matter more, not less: a
    fixture written as "ignore anything that looks like a conflict" would also
    ignore the 403 that says the fixture is not permitted to create the
    ServiceAccount at all, and V2's rejection assertions would then be measuring
    a namespace with no ServiceAccount instead of PodSecurity.

    Never raises, for any argument. ``None`` - a creation that succeeded - is not
    an AlreadyExists.

    Args:
        error: Whatever the operation produced.

    Returns:
        ``True`` only for an ``ApiException`` whose status is exactly 409.
    """
    return _status_of(error) == _ALREADY_EXISTS_STATUS



# ---------------------------------------------------------------------------
# Matching the server's sentence, not the client's rendering of it
# ---------------------------------------------------------------------------


def _body_text(error: object) -> str | None:
    """Decode ``ApiException.body`` to text, or return ``None`` if there is none.

    ``body`` is ``urllib3``'s ``resp.data`` (kubernetes/client/rest.py assigns it
    in ``RESTResponse.__init__``), so on the real error path it is **bytes** -
    measured against the pinned 34.1.0 client, not assumed. On the
    transport-failure path, where ``ApiException(status=0, reason=msg)`` is
    raised without an ``http_resp``, it is ``None``.

    Decoded with ``errors="replace"`` rather than strictly: a body that is not
    valid UTF-8 is a body worth searching anyway, and a ``UnicodeDecodeError``
    escaping from a predicate would abort the poll and report an encoding
    problem in place of the authorization finding.
    """
    body = getattr(error, "body", None)
    if isinstance(body, str):
        return body
    if isinstance(body, (bytes, bytearray)):
        return bytes(body).decode("utf-8", errors="replace")
    return None


def _status_message(body_text: str) -> str | None:
    """Extract the ``message`` field of a metav1.Status JSON body.

    THIS IS THE TRUE ANALOGUE OF GO'S ``err.Error()``. The client returns a
    ``*errors.StatusError`` whose ``Error()`` is ``ErrStatus.Message`` - the
    server's sentence, with its quotation marks as literal characters. The
    Python client hands back the whole metav1.Status as JSON instead, in which
    those same quotation marks are escaped as ``\\"``, so the sentence is only
    recoverable by decoding.

    Returns ``None`` for anything that is not a JSON object carrying a string
    ``message``: a non-JSON body, a JSON array, a ``message`` that is null. All
    are ordinary conditions rather than errors - :func:`_forbidden_message_haystacks`
    simply searches the remaining renderings - so nothing propagates.
    """
    try:
        decoded = json.loads(body_text)
    except (ValueError, TypeError):
        # Not JSON. Expected for a plaintext or empty body; the raw text is
        # searched by the caller regardless.
        return None
    if not isinstance(decoded, dict):
        return None
    message = decoded.get("message")
    if isinstance(message, str):
        return message
    return None


def _forbidden_message_haystacks(error: object) -> tuple[str, ...]:
    """Return every rendering of ``error`` in which the expected message may sit.

    Go needs no such function: ``strings.Contains(e.Error(), expectedMessage)``
    at node_test.go:728 searches one string, because ``Error()`` already IS the
    server's message. The Python client offers no equivalent single string, and
    the shortfall was measured rather than inferred, using the exact expectation
    from node_test.go:1131 - ``audience "audience1" not found in pod spec volume,
    system:node:node1 is not authorized to request tokens for this audience``:

        rendering                                  contains the needle
        ---------------------------------------    -------------------
        str(exc)                                   NO   (bytes body rendered
                                                         through repr, so every
                                                         escape is doubled)
        exc.body decoded                           NO   (JSON wrote each " as \\")
        json.loads(exc.body)["message"]            YES

    Around forty of the real call sites between node_test.go:962 and :1349 pass
    needles containing double quotes, so searching only the rendered exception
    would match none of them: each would poll for its full thirty seconds and
    then fail over client-side formatting rather than over anything the server
    did.

    All three renderings are therefore searched, decoded ``message`` first
    because it is the exact analogue. This is a strict SUPERSET of searching
    ``str(exc)`` and ``body``, so no match that worked before is lost, and it is
    what makes the assertion test the server's sentence rather than the client's
    presentation of it.

    Never raises, and skips a rendering it cannot build rather than substituting
    a placeholder, so a needle can never accidentally match filler text.
    """
    haystacks: list[str] = []

    body_text = _body_text(error)
    if body_text is not None:
        message = _status_message(body_text)
        if message is not None:
            haystacks.append(message)
        haystacks.append(body_text)

    if isinstance(error, BaseException):
        # _describe() rather than str(): it cannot raise, and it prefixes the
        # type name, which can only add to the haystack.
        haystacks.append(_describe(error))

    return tuple(haystacks)


# ---------------------------------------------------------------------------
# The bounded retry engine
# ---------------------------------------------------------------------------


def _expect(
    operation: Callable[[], object],
    predicate: Callable[[BaseException | None], bool],
    *,
    description: str,
    interval: float,
    timeout: float,
) -> _Outcome:
    """Invoke ``operation`` until ``predicate`` accepts its outcome, or time out.

    Port of ``expect`` at test/integration/auth/node_test.go:684-696, whose own
    comment reads: "expect executes a function a set number of times until it
    either returns the expected error or executes too many times. It returns if
    the retries timed out and the last error returned by the method."

    INVARIANTS PRESERVED, each traceable to a line of the original:

      * The loop is ``wait.PollImmediate(time.Second, 30*time.Second, ...)``
        (line 686), so :func:`tests.helpers.polling.poll_immediate` is used -
        never ``poll`` - and the interval and timeout are passed EXPLICITLY.
        Immediate-first is what lets an operation that is already Forbidden be
        answered without paying an interval; V7 makes four such assertions.
      * ``lastErr = f()`` (line 688) is re-evaluated on EVERY tick, side effects
        and all, and only the most recent outcome is retained. Nothing is
        memoised or hoisted.
      * ``t.Logf("unexpected response, will retry: %v", lastErr)`` (line 692)
        becomes one DEBUG log line per unsatisfied tick.
      * ``return err == nil, lastErr`` (line 695) inspects the poll's error only
        for nil-ness and DISCARDS it, so exhaustion must not surface as a
        timeout: :class:`~tests.helpers.polling.PollTimeoutError` is caught and
        turned into an unsatisfied :class:`_Outcome`, leaving the caller's
        "Expected forbidden error, got ..." as the message the reader sees.

    THE GO-TO-PYTHON ADAPTATION. Go's ``f`` RETURNS an ``error``; a Python
    operation RAISES. So the call is wrapped: a raise records the exception as
    ``last_error``, a normal return records ``None``, and the predicate is then
    evaluated over exactly the two-valued domain ``wantErr`` sees.

    WHAT IS RETRIED IS AN EXPLICIT, NARROW SET -- see
    :data:`_RETRYABLE_OPERATION_ERRORS` -- and everything else propagates on the
    FIRST attempt, unwrapped.

    That narrowness is the whole correctness of the retry. Go's ``expect``
    re-invokes a closure whose only failure mode is an API call returning an
    ``error``; Python's equivalent closure can also raise because the TEST is
    wrong -- a ``TypeError`` from a mistyped model field, an ``AttributeError``
    from a renamed client method, a ``NameError``, a ``KeyError`` on a fixture
    dict, an ``AssertionError`` from an assertion the operation performs itself.
    A blanket ``except Exception`` retried every one of those for the full 30
    seconds and then reported the LAST occurrence, so a one-line typo cost half a
    minute per call site and arrived as "waited 30s for a Forbidden response"
    with the original traceback thirty frames of retry away from its cause.
    Retrying a deterministic programming error also cannot help: it produces the
    identical exception every time by definition.

    ``AssertionError`` matters most and is called out for that reason. It is what
    :class:`tests.helpers.polling.PollTimeoutError` derives from, and what a
    nested helper's own assertion raises; absorbing it turned a real finding into
    a timeout report about a different thing entirely.

    ``BaseException`` is not caught either, and that was already true and stays
    true: ``KeyboardInterrupt`` and ``SystemExit`` must end the run, and pytest's
    own outcome exceptions (``Failed``, ``Skipped``) derive from
    ``BaseException`` precisely so that helpers cannot swallow them. An operation
    that calls ``pytest.fail()`` or ``pytest.skip()`` internally therefore
    reports that outcome instead of being mistaken for a failed API call.

    ISOLATION. ``last_error`` and ``attempts`` live in THIS frame and are reached
    through ``nonlocal``; there is no module-level mutable state anywhere in this
    file. Two ``pytest-xdist`` workers cannot observe one another and
    ``pytest-randomly`` cannot reorder anything into a different result.

    Args:
        operation: Zero-argument callable. Its RETURN VALUE IS IGNORED - Go's
            ``f`` yields only an error, and the ported assertions are about which
            error occurred, never about the object created. It is re-invoked on
            every tick, so it must be safe to repeat; the ported call sites
            ensure that with ``dry_run=["All"]`` or with idempotent reads.
        predicate: Accepts the last error (or ``None`` on success) and reports
            whether that is the awaited outcome. Must not raise.
        description: Phrased to follow "waiting for"; used for the DEBUG trace.
        interval: Seconds between retries. Never defaulted by the caller.
        timeout: Total seconds allowed. Never defaulted by the caller.

    Returns:
        An :class:`_Outcome`. ``satisfied`` is ``False`` on exhaustion, exactly
        as Go's ``timeout`` return is.
    """
    __tracebackhide__ = True

    last_error: BaseException | None = None
    attempts = 0
    started = time.monotonic()

    def observed() -> bool:
        """One tick: run the operation, record its outcome, test the predicate."""
        nonlocal last_error, attempts
        attempts += 1
        try:
            operation()
        except _RETRYABLE_OPERATION_ERRORS as exc:
            # The only failures a converging authorizer legitimately produces:
            # an API-server response (ApiException) or a transport hiccup while
            # the server is still coming up. Anything else is a defect in the
            # test and has already left this frame.
            last_error = exc
        else:
            last_error = None

        if predicate(last_error):
            return True

        # node_test.go:692. DEBUG because it is expected chatter on the happy
        # path of a converging authorizer, not a warning; %s-style lazy
        # formatting so _describe() is not paid for when DEBUG is off.
        _LOGGER.debug(
            "unexpected response, will retry (attempt %d, waiting for %s): %s",
            attempts,
            description,
            _describe(last_error),
        )
        return False

    try:
        poll_immediate(
            observed,
            interval=interval,
            timeout=timeout,
            description=description,
            describe_last=lambda: _describe(last_error),
        )
    except PollTimeoutError:
        # Swallowed on purpose, reproducing `return err == nil, lastErr`
        # (node_test.go:695): the caller owns the message, and PollTimeoutError's
        # "timed out after 30s waiting for ..." would displace it. The
        # information it carried is not lost - attempts and elapsed are counted
        # here and rendered by _render_failure.
        return _Outcome(
            satisfied=False,
            last_error=last_error,
            attempts=attempts,
            elapsed=time.monotonic() - started,
        )

    return _Outcome(
        satisfied=True,
        last_error=last_error,
        attempts=attempts,
        elapsed=time.monotonic() - started,
    )



# ---------------------------------------------------------------------------
# The expectation family. Every member raises; the CALLER chooses accumulate
# or abort by whether it wraps the call in `with subtests.test(...)`.
# ---------------------------------------------------------------------------


def expect_forbidden(
    operation: Callable[[], object],
    *,
    requirement: str | None = None,
    interval: float = _EXPECT_INTERVAL_SECONDS,
    timeout: float = _EXPECT_TIMEOUT_SECONDS,
) -> None:
    """Require ``operation`` to be rejected with HTTP 403 Forbidden.

    Port of ``expectForbidden`` at test/integration/auth/node_test.go:698-703::

        if ok, err := expect(t, f, apierrors.IsForbidden); !ok {
            t.Errorf("Expected forbidden error, got %v", err)
        }

    INVARIANT PRESERVED: the operation must be denied with EXACTLY 403, and it is
    retried for up to thirty seconds first because the authorizer converges
    asynchronously. An operation that succeeds, or that fails with any other
    status, is a failure - including 404, which is the specific inversion V7's
    ordering hazard produces.

    ``t.Errorf`` means ACCUMULATE, and that is expressed by the call site rather
    than here. Wrap this call in ``with subtests.test(...)`` and each failing
    case is reported while the loop continues, so one run names every offending
    operation; call it bare and the first failure stops the test. V1 needs the
    former for its ClusterRole enumeration and the latter for its positive
    control, from the same helper.

    Args:
        operation: Zero-argument callable expected to raise ``ApiException`` with
            status 403. Re-invoked on every retry, so it must be repeatable - the
            ported call sites use ``dry_run=["All"]`` or idempotent reads. Its
            return value is ignored.
        requirement: Identifier this assertion enforces, for example
            ``F-002-RQ-001`` for the V2 privileged-pod rejection or
            ``F-007-RQ-002`` for the V7 cross-node denial. It prefixes the
            failure headline (AAP §0.7.2).
        interval: Seconds between retries. Defaults to the measured original,
            one second. A parity call site must not change it.
        timeout: Total seconds allowed. Defaults to the measured original, thirty
            seconds. A parity call site must not change it.

    Raises:
        AssertionError: The operation was not rejected with 403 within the
            budget. The message opens with "Expected forbidden error, got ..."
            and is followed by the attempt count, the elapsed time and the full
            last error.
    """
    __tracebackhide__ = True
    outcome = _expect(
        operation,
        is_forbidden,
        description="the operation to be rejected with 403 Forbidden",
        interval=interval,
        timeout=timeout,
    )
    if not outcome.satisfied:
        _fail(
            f"Expected forbidden error, got {_summarize(outcome.last_error)}",
            requirement=requirement,
            outcome=outcome,
            interval=interval,
            timeout=timeout,
        )


def expect_not_found(
    operation: Callable[[], object],
    *,
    requirement: str | None = None,
    interval: float = _EXPECT_INTERVAL_SECONDS,
    timeout: float = _EXPECT_TIMEOUT_SECONDS,
) -> None:
    """Require ``operation`` to be rejected with HTTP 404 Not Found.

    Port of ``expectNotFound`` at test/integration/auth/node_test.go:705-710,
    identical to ``expectForbidden`` but for ``apierrors.IsNotFound`` and the
    message "Expected notfound error, got %v" - whose unspaced "notfound" is the
    original's spelling and is kept, so a log grep written against the Go suite
    still finds the ported failure.

    INVARIANT PRESERVED: EXACTLY 404, and never interchangeable with
    :func:`expect_forbidden`. Asserting NotFound where the test means Forbidden
    is the mistake V7's ORDER MATTERS constraint exists to prevent, and keeping
    the two expectations separate is what leaves the constraint visible.

    ``t.Errorf`` means ACCUMULATE; as above, the call site decides by wrapping or
    not wrapping in ``subtests``.

    Args:
        operation: Zero-argument callable expected to raise ``ApiException`` with
            status 404. Re-invoked on every retry. Its return value is ignored.
        requirement: Identifier this assertion enforces; prefixes the headline.
        interval: Seconds between retries; defaults to the measured one second.
        timeout: Total seconds allowed; defaults to the measured thirty seconds.

    Raises:
        AssertionError: The operation was not rejected with 404 within the
            budget.
    """
    __tracebackhide__ = True
    outcome = _expect(
        operation,
        is_not_found,
        description="the operation to be rejected with 404 Not Found",
        interval=interval,
        timeout=timeout,
    )
    if not outcome.satisfied:
        _fail(
            f"Expected notfound error, got {_summarize(outcome.last_error)}",
            requirement=requirement,
            outcome=outcome,
            interval=interval,
            timeout=timeout,
        )


def expect_allowed(
    operation: Callable[[], object],
    *,
    requirement: str | None = None,
    interval: float = _EXPECT_INTERVAL_SECONDS,
    timeout: float = _EXPECT_TIMEOUT_SECONDS,
) -> None:
    """Require ``operation`` to succeed - the POSITIVE CONTROL of the family.

    Port of ``expectAllowed`` at test/integration/auth/node_test.go:712-717,
    whose predicate is the literal ``func(e error) bool { return e == nil }``.

    INVARIANT PRESERVED: success is ``last_error is None`` and NOTHING ELSE. No
    status is consulted, because a successful call produces no error to read one
    from - so this is the one member of the family that must never be rewritten
    in terms of a status code. Accepting "any 2xx" would be the same category of
    error as accepting "any 4xx" in :func:`is_forbidden`, in the opposite
    direction.

    WHY THIS MEMBER MATTERS AS MUCH AS THE DENIALS. AAP §0.10.2 lists the
    positive controls - ``system:masters`` must still be allowed ``*/*/*``, node1
    must still be allowed to read and update its own Node - and states why they
    are mandatory: "without them, a test also passes when the whole authorization
    stack is broken". A suite of denial assertions alone is satisfied by a
    cluster that denies EVERYTHING, which is not a hardened cluster but a broken
    one. This expectation is what distinguishes the two, so deleting a call to it
    silently removes the only evidence that the control is scoped rather than
    total.

    It retries for the same reason its siblings do, and it needs it most: a
    freshly bootstrapped RBAC store denies before it permits, so the allow being
    asserted is frequently the outcome that arrives LAST.

    Args:
        operation: Zero-argument callable expected to complete without raising.
            Re-invoked on every retry until it succeeds, so it must be
            repeatable. Its return value is ignored - the assertion is that no
            error occurred, and a caller needing the object should call the
            operation again after this returns, or assert on it inside the
            callable.
        requirement: Identifier this assertion enforces; prefixes the headline.
        interval: Seconds between retries; defaults to the measured one second.
        timeout: Total seconds allowed; defaults to the measured thirty seconds.

    Raises:
        AssertionError: The operation was still failing when the budget ran out.
            The message opens with "Expected no error, got ...".
    """
    __tracebackhide__ = True
    outcome = _expect(
        operation,
        lambda error: error is None,
        description="the operation to be allowed",
        interval=interval,
        timeout=timeout,
    )
    if not outcome.satisfied:
        _fail(
            f"Expected no error, got {_summarize(outcome.last_error)}",
            requirement=requirement,
            outcome=outcome,
            interval=interval,
            timeout=timeout,
        )


def expect_forbidden_message(
    operation: Callable[[], object],
    expected_message: str,
    *,
    requirement: str | None = None,
    interval: float = _EXPECT_INTERVAL_SECONDS,
    timeout: float = _EXPECT_TIMEOUT_SECONDS,
) -> None:
    """Require a 403 rejection whose server message contains ``expected_message``.

    Port of ``expectedForbiddenMessage`` at
    test/integration/auth/node_test.go:726-731, whose predicate is::

        func(e error) bool {
            return apierrors.IsForbidden(e) && strings.Contains(e.Error(), expectedMessage)
        }

    INVARIANT PRESERVED: BOTH halves, conjoined. The status must be exactly 403
    AND the server's own sentence must contain the substring, so a 403 issued for
    an unrelated reason - the wrong principal, a missing RBAC binding, an
    admission plugin that rejects everything - does not satisfy an assertion
    written about a specific denial.

    HOW THE SUBSTRING IS SOUGHT, AND WHY IT IS NOT ``str(exc)``. Go's
    ``e.Error()`` is the DECODED ``ErrStatus.Message``. The Python client exposes
    no equivalent single string: the message arrives JSON-encoded inside a bytes
    ``body``, and ``ApiException.__str__`` renders those bytes through ``repr``,
    doubling every escape. Measured against the pinned 34.1.0 client with the
    exact expectation at node_test.go:1131, the needle is absent from
    ``str(exc)``, absent from the decoded body, and present only in the decoded
    ``message`` field. :func:`_forbidden_message_haystacks` therefore searches
    all three and accepts a hit in any - a strict superset, so no previously
    matching needle stops matching, and quoted expectations (around forty of the
    real call sites) match at all.

    Note that the comparison stays a plain substring test, exactly as
    ``strings.Contains`` is. Nothing is normalised, lower-cased or
    whitespace-collapsed: the assertion is about the message the server actually
    produced, and a fuzzy comparison would let a changed message keep passing.

    ``t.Errorf`` means ACCUMULATE; the call site decides by wrapping or not.

    Args:
        operation: Zero-argument callable expected to raise ``ApiException`` with
            status 403. Re-invoked on every retry. Its return value is ignored.
        expected_message: Substring the server's message must contain. Positional,
            mirroring the Go original's third parameter.
        requirement: Identifier this assertion enforces; prefixes the headline.
        interval: Seconds between retries; defaults to the measured one second.
        timeout: Total seconds allowed; defaults to the measured thirty seconds.

    Raises:
        AssertionError: No 403 carrying that message arrived within the budget.
            The message opens with "Expected forbidden error with message
            '...', got ...".
    """
    __tracebackhide__ = True

    def forbidden_with_message(error: BaseException | None) -> bool:
        """The conjunction from node_test.go:728, over every rendering."""
        if not is_forbidden(error):
            return False
        return any(
            expected_message in haystack for haystack in _forbidden_message_haystacks(error)
        )

    outcome = _expect(
        operation,
        forbidden_with_message,
        description=(
            f"the operation to be rejected with 403 Forbidden carrying {expected_message!r}"
        ),
        interval=interval,
        timeout=timeout,
    )
    if not outcome.satisfied:
        _fail(
            f"Expected forbidden error with message {expected_message!r},"
            f" got {_summarize(outcome.last_error)}",
            requirement=requirement,
            outcome=outcome,
            interval=interval,
            timeout=timeout,
        )


def check_nil_error(error: BaseException | None, *, requirement: str | None = None) -> None:
    """Require ``error`` to be ``None``, aborting at once if it is not.

    Port of ``checkNilError`` at test/integration/auth/node_test.go:719-724::

        if err != nil {
            t.Fatalf("unexpected error: %v", err)
        }

    INVARIANT PRESERVED: a non-``None`` error aborts IMMEDIATELY and is never
    retried. Both halves are load-bearing - the abort is what stops a test
    proceeding over a fixture that was never built, and the absence of a retry is
    what stops a genuinely broken precondition being masked by an eventual
    success.

    THIS IS THE ABORT VARIANT, AND THE ONLY ONE IN THIS MODULE. Its Go original
    reports through ``t.Fatalf``, not ``t.Errorf``, and the distinction is
    deliberate on both sides: the errors it guards are SETUP failures - a node
    that could not be created, a token file that could not be written - and a
    setup failure does not belong in a collection of findings, because
    everything asserted after it is meaningless. DO NOT wrap this call in ``with
    subtests.test(...)``: doing so converts an abort into a recorded failure and
    lets the test continue over a fixture that was never built, which produces a
    cascade of misleading secondary failures instead of one accurate primary one.

    It still raises ``AssertionError`` rather than some unwrappable escape hatch,
    for the same reason every other member does - the mechanism is uniform, and
    the choice is documented rather than enforced, exactly as it is in Go, where
    nothing prevents a developer writing ``t.Errorf`` where ``t.Fatalf`` belongs.

    THERE IS NO RETRY, and that too is faithful. ``checkNilError`` receives an
    error that has ALREADY been produced; it does not receive a callable and has
    nothing to re-invoke. Retrying would require re-running the setup operation,
    which is the opposite of what a fixture check should do - the setup either
    worked or it did not, and repeating a failed creation would mask a
    genuinely broken precondition behind an eventual success.

    Args:
        error: The error the setup operation produced, or ``None`` if it
            succeeded. Typically obtained by catching ``ApiException`` around a
            fixture's own call.
        requirement: Identifier this check enforces; prefixes the message.

    Raises:
        AssertionError: ``error`` is not ``None``. The message opens with
            "unexpected error: ...".
    """
    __tracebackhide__ = True
    if error is None:
        return
    raise AssertionError(
        "\n".join(
            [
                _prefixed(f"unexpected error: {_summarize(error)}", requirement),
                "  checked without retry: this is the abort-on-setup-failure variant",
                "  error:",
                _indent(_describe(error)),
            ]
        )
    )
