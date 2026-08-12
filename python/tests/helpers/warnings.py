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

"""Lock-guarded recorder for the warnings an API server returns to a client.

Port of ``recordingWarningHandler``, defined at
test/integration/auth/svcaccttoken_test.go:1401-1425 and reused across a
package boundary by test/integration/auth/podsecurity_test.go:430-435, which
records in a comment that it borrows the handler because Go gives it no other
way to share one.

WHAT IT IS FOR

An API server reports non-fatal objections in the response's ``Warning``
header rather than in the response body, so a warning is invisible to a test
that only inspects the returned object or the raised error. Two ported
behaviours turn on exactly that invisible signal:

  * V2, tests/integration/test_podsecurity_baseline.py. A namespace labelled
    ``pod-security.kubernetes.io/warn=restricted`` ADMITS a plain pod, because
    the enforce level is left at the cluster default of privileged - and it
    must still surface a warning. Without a recorder the case collapses into a
    bare "the pod was admitted", which is also what a completely disabled Pod
    Security plugin produces. The warning is the entire invariant.
  * V4, tests/integration/test_svcacct_token.py, whose Go original is the file
    this handler is defined in.

WHAT IT DELIBERATELY IS NOT

It records warning MESSAGES and nothing else. It is not a response recorder,
not a header recorder and not a request log. Widening it would put server
response bodies - the very payloads the V6 confidentiality guard exists to
keep out of the audit log - into test memory for no assertion's benefit.

THE LOCK IS THE POINT OF THIS FILE

The Go struct embeds ``sync.Mutex`` and takes it in all three of its methods
for one concrete reason: the Go unit suite runs under the race detector by
default, ``KUBE_RACE=${KUBE_RACE-"-race"}`` at hack/make-rules/test.sh:73, so
an unsynchronised recorder fails the build rather than merely misbehaving.
podsecurity_test.go:450-453 makes the reasoning explicit at the call site,
reading the slice length between an explicit ``Lock()`` and ``Unlock()`` under
the comment "Read the captured warnings under the embedded mutex (satisfies
-race)".

Python has no race detector and no goleak equivalent, so NOTHING HERE WILL
EVER TELL YOU THE LOCK IS MISSING. That is precisely why this port carries an
explicit :class:`threading.Lock` rather than leaning on CPython's incidental
guarantees: ``list.append`` happening to be atomic under the current global
interpreter lock is not the invariant that was ported, it is an implementation
detail of one interpreter, and it says nothing at all about the read-then-
compare in :meth:`RecordingWarningHandler.assert_equal`, which must observe
one coherent list rather than a list halfway through someone else's append.
The suite is required to pass under ``pytest-xdist -n auto``, and a client may
deliver a warning from a background thread, so the hazard is real rather than
theoretical.

HOW IT IS INSTALLED

By the ``warning_recorder`` fixture in tests/integration/conftest.py, never by
this module. The Kubernetes Python client exposes no ``WarningHandler`` hook of
its own - unlike Go's ``rest.Config`` - so the fixture reads the ``Warning``
response header and calls :meth:`RecordingWarningHandler.handle_warning_header`
once per warning. That method's name and signature are therefore a contract
with the fixture and mirror the Go interface exactly.

This module declares no fixture of its own, both because installation is the
fixture's job and because a module-, package- or session-scoped autouse fixture
declared inline in an ordinary module can execute twice under
``--doctest-modules``.

ISOLATION

Each test gets its own recorder and each recorder gets its own lock. There is
no module-level state here of any kind, mutable or otherwise: a shared lock
would serialise unrelated recorders, and a shared list would leak one test's
warnings into the next test's assertion. :meth:`RecordingWarningHandler.clear`
exists so that ONE test can reset ONE recorder between its own phases, which
is how the V2 case separates the warnings caused by its namespace setup from
the warnings caused by the pod it is actually asserting on.

USAGE

    recorder = RecordingWarningHandler()
    # ... fixture installs it, client performs a request ...
    recorder.assert_any("Pod Security warning under warn=restricted",
                        requirement="F-002-RQ-003")

    recorder.clear()
    # ... a request expected to produce no warning at all ...
    recorder.assert_equal([], requirement="F-004-RQ-001")
"""

# AAP §0.5.1 (the python/tests/helpers/warnings.py row: "threading.Lock-guarded
# warning recorder", sourced from test/integration/auth/svcaccttoken_test.go) /
# §0.4.1.2, whose `-race` row reads "No analogue - pytest-randomly,
# pytest-xdist, threading.Lock, pytest-timeout" / §0.7.2, which requires that
# "the warning recorder is threading.Lock-guarded for the same reason the Go
# original is mutex-guarded" and that an assertion message name the requirement
# identifier it enforces / tech-spec §6.6.1.2 ("real components, not mocks":
# these are warnings a real API server really sent, not fabricated strings).
#
# INVARIANT LOCKED BY THIS FILE: every warning the server sent is recorded
# exactly once, in arrival order, and every append, every reset and every read
# happens under one per-instance lock - so a concurrent reader can never see a
# torn list and a concurrent writer can never lose a message. The lock is
# DELIBERATE: Python has no -race detector to notice its absence, so removing
# it breaks nothing visibly today and silently forfeits the guarantee the Go
# original was written to hold.

import threading
from collections.abc import Sequence

__all__ = ["RecordingWarningHandler"]


def _prefixed(message: str, requirement: str | None) -> str:
    """Prefix an assertion message with the requirement identifier it enforces.

    AAP §0.7.2 asks that a failure read as a requirement violation rather than
    as a value mismatch, because the person reading a CI failure in a security
    suite is frequently not the person who wrote the test. ``F-002-RQ-001`` and
    ``F-002-RQ-003`` are the V2 identifiers; ``F-004-RQ-001`` and
    ``F-004-RQ-002`` are the V4 ones.

    A blank or absent identifier yields the message unchanged, so the caller
    never has to choose between an identifier it does not have and a message
    disfigured by an empty prefix.
    """
    if requirement is None or not requirement.strip():
        return message
    return f"{requirement}: {message}"


class RecordingWarningHandler:
    """Collects the warning messages an API server returned, under a lock.

    Port of the ``recordingWarningHandler`` struct at
    test/integration/auth/svcaccttoken_test.go:1401-1405, whose two fields are
    a ``[]string`` of messages and an embedded ``sync.Mutex``.

    INVARIANT PRESERVED: messages accumulate in arrival order and every
    operation that touches them - append, reset and read alike - holds the same
    per-instance lock, as all three Go methods do.

    The lock is a plain :class:`threading.Lock` and is therefore NOT reentrant,
    matching ``sync.Mutex``, which is not reentrant either. No method here
    calls another lock-taking method while holding the lock, and none may be
    added that does; that is the whole of what non-reentrancy demands.

    This is a plain class rather than a dataclass on purpose. A dataclass would
    generate an ``__eq__`` and a ``__repr__`` over a lock object, which is
    neither comparable nor usefully printable, so the lock field would have to
    be excluded from both with ``compare=False, repr=False``. Writing the two
    methods that actually matter is clearer than suppressing two that should
    never have existed - and only :meth:`__repr__` is wanted here, since two
    recorders holding equal messages are still two different recorders and
    should not compare equal.
    """

    # Attributes are fixed, so a typo such as `self._warning = []` raises
    # AttributeError instead of silently creating a second list that nothing
    # ever reads - the failure mode that would make a recorder quietly report
    # no warnings at all.
    __slots__ = ("_lock", "_warnings")

    def __init__(self) -> None:
        """Create an empty recorder with a lock of its very own.

        The lock is built HERE, per instance, and never at module scope. A
        module-level lock would serialise recorders belonging to unrelated
        tests running in parallel, and would tie the isolation of one test to
        the behaviour of another - the opposite of what it is here to provide.
        """
        self._warnings: list[str] = []
        self._lock = threading.Lock()

    def handle_warning_header(self, code: int, agent: str, message: str) -> None:
        """Record one warning. Port of ``HandleWarningHeader``, L1407-1411.

        INVARIANT PRESERVED: the locked append of ``message`` ALONE.

        ``code`` and ``agent`` are accepted because the warning-header contract
        supplies all three values - the Go signature is
        ``HandleWarningHeader(code int, agent string, message string)`` - and
        are then deliberately discarded, exactly as the Go body discards them
        by appending only ``message``. The ``del`` below makes that discard
        executable rather than merely intended.

        DO NOT "improve" this by storing them. Every assertion in this class,
        and the Go ``reflect.DeepEqual`` against a ``[]string`` that they are
        ported from, compares against a flat sequence of message strings; a
        recorder holding tuples would break all of them at once. A test that
        needs the code or the agent asserts on the response, not here.
        """
        del code, agent
        with self._lock:
            self._warnings.append(message)

    def clear(self) -> None:
        """Discard every recorded warning. Port of ``clear``, L1413-1417.

        INVARIANT PRESERVED: the reset happens under the lock, so it cannot
        race a concurrent append.

        Go assigns ``nil`` to the slice; this empties the list. The two are
        equivalent for every purpose this class has, with one difference worth
        recording because it is invisible from either side alone:
        ``reflect.DeepEqual(nil_slice, empty_slice)`` is FALSE in Go, so the Go
        original must be asserted against ``nil`` after a ``clear()``, whereas
        Python draws no distinction between a cleared list and an empty one.
        ``clear()`` followed by ``assert_equal([])`` therefore passes here.

        That is a deliberate, VERDICT-PRESERVING simplification: it removes a
        way for a correct test to fail spuriously and adds no way for an
        incorrect one to pass, because "no warnings were recorded" is the only
        state either spelling can describe.
        """
        with self._lock:
            self._warnings.clear()

    def snapshot(self) -> list[str]:
        """Return a COPY of the recorded warnings, read under the lock.

        Port of the locked read the Go callers perform directly on the struct,
        as at test/integration/auth/podsecurity_test.go:451-453.

        INVARIANT PRESERVED: a reader observes one coherent list.

        The copy is not defensive habit, it is required twice over. Handing
        back the internal list would let a caller mutate recorder state through
        the value it was given, and would hand a reader a view that a
        concurrent :meth:`handle_warning_header` can change underneath it while
        it is being iterated or compared.
        """
        with self._lock:
            return list(self._warnings)

    @property
    def warnings(self) -> list[str]:
        """The recorded warnings, in arrival order, as a copy.

        Reads the ``warnings`` field of the Go struct (L1402) by the same
        locked route as :meth:`snapshot`, which it delegates to so there is
        exactly one implementation of the locked read. It is a property purely
        so that a caller reaching for the Go field name finds something with
        that name; it is in every respect :meth:`snapshot`.
        """
        return self.snapshot()

    def count(self) -> int:
        """Return how many warnings were recorded, read under the lock.

        Port of the length read at
        test/integration/auth/podsecurity_test.go:451-453, which brackets
        ``len(warnHandler.warnings)`` between an explicit ``Lock()`` and
        ``Unlock()`` under the comment "Read the captured warnings under the
        embedded mutex (satisfies -race)".

        INVARIANT PRESERVED: the count is taken under the lock, so it can never
        be read from a list halfway through an append.
        """
        with self._lock:
            return len(self._warnings)

    def assert_equal(self, expected: Sequence[str], requirement: str | None = None) -> None:
        """Assert the recorded warnings are exactly ``expected``, in order.

        Faithful port of ``assertEqual``, L1418-1425:
        ``t.Helper()``; take the lock; ``reflect.DeepEqual``; on mismatch
        ``t.Errorf("expected\\n\\t%v\\ngot\\n\\t%v", ...)``.

        INVARIANT PRESERVED - and this is the subtle half - the Go original
        reports through ``t.Errorf``, which RECORDS the failure and lets the
        test CONTINUE, not through ``t.Fatalf``, which aborts. Raising
        ``AssertionError`` reproduces both halves of that choice depending on
        how the caller invokes it: inside ``with subtests.test(...)`` the
        subtest context catches it, reports it and execution continues to the
        next case, which is the accumulate behaviour; called bare, it
        propagates and the test aborts. So the caller keeps the choice the Go
        author made per call site, and neither behaviour is hard-coded here.

        ``__tracebackhide__`` is the port of ``t.Helper()``: it trims this
        frame from the report so the failure is attributed to the caller's
        assertion rather than to a line inside this helper.

        ``expected`` is normalised with ``list(...)`` before comparing, which
        is what makes a tuple of the right messages pass. Python holds
        ``("a",) != ["a"]`` even though Go's ``reflect.DeepEqual`` compares two
        ``[]string`` values with no such distinction available to it, so
        normalising is what keeps the verdict identical rather than adding
        leniency. Element comparison stays exact: no sorting, no substring
        matching, no case folding. Order is part of the assertion because a
        warning's position carries which request produced it.
        """
        __tracebackhide__ = True
        want = list(expected)
        # Read AND compare under the lock, as assertEqual does. Only the
        # message formatting and the raise happen after release: there is no
        # reason to run arbitrary repr() work while other threads are blocked,
        # and none to risk a callable in a repr re-entering a non-reentrant
        # lock.
        with self._lock:
            got = list(self._warnings)
            equal = got == want
        if equal:
            return
        raise AssertionError(_prefixed(f"expected\n\t{want!r}\ngot\n\t{got!r}", requirement))

    def assert_any(self, description: str = "warning", requirement: str | None = None) -> None:
        """Assert at least one warning was recorded, whatever it said.

        ADDITION, not a port of a method: the Go original has no such method
        because its callers reach into the struct directly. It ports the call
        site at test/integration/auth/podsecurity_test.go:450-456, which reads
        the length under the mutex and then reports through ``t.Errorf`` -
        "expected at least one Pod Security warning under warn=restricted, got
        none" - and it exists so that
        tests/integration/test_podsecurity_baseline.py can state that
        invariant without reaching past this class's lock to do it.
        :meth:`assert_equal` is left untouched as the faithful port.

        INVARIANT LOCKED: under ``warn=restricted`` the pod is admitted AND a
        warning is surfaced. Only the second half distinguishes a working Pod
        Security plugin from an absent one, which is why the exact wording of
        the message is deliberately NOT asserted: pinning server-authored
        prose would make the test fail on a harmless upstream rewording while
        proving nothing more than its presence already does.

        ``description`` completes the sentence "expected at least one ..., got
        none", so passing "Pod Security warning under warn=restricted"
        reproduces the Go message verbatim. Accumulate-versus-abort and
        traceback hiding work exactly as in :meth:`assert_equal`.
        """
        __tracebackhide__ = True
        with self._lock:
            observed = len(self._warnings)
        if observed:
            return
        raise AssertionError(
            _prefixed(f"expected at least one {description}, got none", requirement)
        )

    def __repr__(self) -> str:
        """Show the recorded warnings, read under the lock.

        Exists so that a failure involving a recorder is diagnosable from the
        report alone. It takes the lock like every other read, and so must
        never be called from inside a locked region of this class - the lock is
        not reentrant. Nothing here does.
        """
        with self._lock:
            recorded = list(self._warnings)
        return f"{type(self).__name__}(warnings={recorded!r})"
