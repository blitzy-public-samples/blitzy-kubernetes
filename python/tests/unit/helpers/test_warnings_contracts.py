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

"""Contract tests for ``tests.helpers.warnings``: the lock, the copies, and the order.

AAP §0.5.1 (the ``python/tests/helpers/warnings.py`` row: the "threading.Lock-guarded
warning recorder" port of ``recordingWarningHandler``) / §0.4.1.2, whose ``-race`` row
reads "No analogue -- pytest-randomly, pytest-xdist, threading.Lock, pytest-timeout" /
§0.7.2, which requires that "the warning recorder is threading.Lock-guarded for the
same reason the Go original is mutex-guarded" / tech-spec §6.6.3.4 (the documentation
convention).

WHY THIS MODULE EXISTS AT ALL. The Go original is protected by ``-race``, which is on
by default for unit runs and would fail the build the moment the mutex were removed.
Python has NO such detector, so removing the lock here breaks nothing visibly and
silently forfeits the guarantee -- until a V2 run under load loses a Pod Security
warning and ``assert_any`` reports "got none" against a server that sent one. These
tests are the substitute for the detector, so the guarantee is asserted rather than
assumed.

INVARIANTS LOCKED BY THIS MODULE:

1. NO MESSAGE IS LOST under concurrent appends. This is what the lock buys, and it
   is asserted by contending threads rather than argued from the source.
2. A READER SEES ONE COHERENT LIST -- never a torn one, and never the internal list
   itself, which a caller could mutate or watch change underneath it.
3. ARRIVAL ORDER IS PRESERVED, because a warning's position carries which request
   produced it.
4. ONLY THE MESSAGE IS RECORDED. ``code`` and ``agent`` are accepted and discarded,
   as the Go body discards them -- a recorder holding tuples would break every
   assertion ported from ``reflect.DeepEqual`` over a ``[]string`` at once.
5. THE LOCK IS PER INSTANCE, so two tests running in parallel neither serialise nor
   observe each other.
6. THE COMPARISON IN ``assert_equal`` IS EXACT AND ORDERED, and its message names the
   requirement identifier it enforces.
"""

from __future__ import annotations

import itertools
import threading
import time
from typing import TYPE_CHECKING

import pytest

from tests.helpers.warnings import RecordingWarningHandler

if TYPE_CHECKING:
    from collections.abc import Sequence

# The warning a real API server sends under `warn=restricted`, abbreviated. Used
# verbatim in places to keep the tests reading like the V2 call site they serve.
PSS_WARNING = (
    'would violate PodSecurity "restricted:latest": allowPrivilegeEscalation != false'
)

# Enough contention that an unlocked list would demonstrably lose appends. Chosen
# rather than tuned: the point is contention, not a specific count.
CONTENDING_THREADS = 16
APPENDS_PER_THREAD = 250


def record_all(recorder: RecordingWarningHandler, messages: Sequence[str]) -> None:
    """Append every message through the public handler, as a client's hook would."""
    for message in messages:
        recorder.handle_warning_header(299, "test-agent", message)


# ---------------------------------------------------------------------------
# 1. Nothing is lost under contention  (the -race substitute)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(60)
def test_no_message_is_lost_under_concurrent_appends() -> None:
    """Every append from every thread is recorded exactly once.

    ``list.append`` happens to be atomic under the current CPython GIL, so this
    would pass even unlocked TODAY. That is precisely why the test asserts the
    OUTCOME rather than the mechanism: the guarantee must survive a free-threaded
    interpreter, a future where the recorder accumulates more than one field, or any
    read-modify-write that a maintainer adds later - none of which the source alone
    would warn about, and none of which ``-race`` is here to catch.
    """
    recorder = RecordingWarningHandler()
    barrier = threading.Barrier(CONTENDING_THREADS)

    def worker(worker_id: int) -> None:
        # A barrier rather than a bare start: without it the first threads finish
        # before the last ones are scheduled and there is no contention to test.
        barrier.wait()
        record_all(
            recorder,
            [f"w{worker_id}-{index}" for index in range(APPENDS_PER_THREAD)],
        )

    threads = [
        threading.Thread(target=worker, args=(worker_id,), name=f"warn-{worker_id}")
        for worker_id in range(CONTENDING_THREADS)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not [thread for thread in threads if thread.is_alive()], "a worker hung"

    expected_total = CONTENDING_THREADS * APPENDS_PER_THREAD
    recorded = recorder.snapshot()
    assert len(recorded) == expected_total
    assert recorder.count() == expected_total
    # Exactly once each, and every one of them: a set comparison catches both a
    # lost append and a duplicated one, which a length check alone would not.
    assert set(recorded) == {
        f"w{worker_id}-{index}"
        for worker_id in range(CONTENDING_THREADS)
        for index in range(APPENDS_PER_THREAD)
    }


@pytest.mark.timeout(60)
def test_a_concurrent_reader_never_observes_a_torn_list() -> None:
    """Every snapshot taken while a writer is appending is a coherent, ordered prefix.

    A reader handed the internal list could watch it change while comparing, which is
    how a V2 assertion would fail against a server that behaved correctly.

    THE LOOP IS BOUNDED BY OBSERVED GROWTH, not by an iteration count, because two
    earlier shapes proved nothing and did so silently. Bounding by the writer meant
    the writer finished before the reader was first scheduled; bounding by a fixed
    200 reader iterations meant the READER finished first - all 200 snapshots came
    back empty, and the prefix check passed trivially over the empty list. Requiring
    the reader to WATCH the list reach a target length is the only shape that
    guarantees the interleaving the test is named for, so the growth assertion is the
    test's own precondition rather than a bonus check.
    """
    recorder = RecordingWarningHandler()
    stop = threading.Event()
    ready = threading.Barrier(2)
    snapshots: list[list[str]] = []
    failures: list[str] = []
    target_growth = 500
    deadline = time.monotonic() + 20.0

    def writer() -> None:
        ready.wait()
        index = 0
        while not stop.is_set():
            recorder.handle_warning_header(299, "test-agent", f"m-{index}")
            index += 1
            # Hand the interpreter back so the reader is scheduled between appends.
            # Without it the two threads run in long uninterrupted bursts and the
            # reader observes only the start and the end of the storm.
            time.sleep(0)

    def reader() -> None:
        ready.wait()
        try:
            observed: list[str] = []
            while len(observed) < target_growth and time.monotonic() < deadline:
                observed = recorder.snapshot()
                # The one property a torn read would violate: the list is exactly
                # the first N messages, in order, for some N.
                if observed != [f"m-{position}" for position in range(len(observed))]:
                    failures.append(f"torn read of length {len(observed)}")
                snapshots.append(observed)
                time.sleep(0)
        finally:
            # In a finally so a failure above can never leave the writer spinning
            # for the rest of the session.
            stop.set()

    threads = [
        threading.Thread(target=writer, name="warn-writer"),
        threading.Thread(target=reader, name="warn-reader"),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not [thread for thread in threads if thread.is_alive()], "a worker hung"
    assert not failures, failures
    # Growth is monotonic: a snapshot is never shorter than an earlier one.
    lengths = [len(snapshot) for snapshot in snapshots]
    assert lengths == sorted(lengths)
    # The interleaving actually happened: the reader watched the list grow from
    # empty to the target while the writer was appending to it.
    assert lengths[0] < target_growth <= lengths[-1], lengths[:5]
    assert len(snapshots) > 1
    assert recorder.count() >= target_growth


@pytest.mark.timeout(60)
def test_clear_races_appends_without_losing_coherence() -> None:
    """``clear`` takes the same lock, so it cannot empty a half-appended list.

    The V4 call site clears between requests, and the client's warning hook fires from
    whichever transport thread served the response, so the two genuinely interleave.
    Bounded by the WRITER's observed progress for the same reason as the test above:
    a clearer that finishes before the writer starts asserts nothing.
    """
    recorder = RecordingWarningHandler()
    stop = threading.Event()
    ready = threading.Barrier(2)
    failures: list[str] = []
    appended = itertools.count()
    progress: list[int] = [0]
    target_appends = 500
    deadline = time.monotonic() + 20.0

    def writer() -> None:
        ready.wait()
        while not stop.is_set():
            index = next(appended)
            recorder.handle_warning_header(299, "test-agent", f"m-{index}")
            progress[0] = index + 1
            time.sleep(0)

    def clearer() -> None:
        ready.wait()
        try:
            while progress[0] < target_appends and time.monotonic() < deadline:
                recorder.clear()
                observed = recorder.snapshot()
                # Every element must still be a whole message, never a fragment or
                # a None left behind by a partially applied reset.
                if any(not isinstance(item, str) or not item for item in observed):
                    failures.append(f"incoherent element in {observed[:3]}")
                time.sleep(0)
        finally:
            stop.set()

    threads = [
        threading.Thread(target=writer, name="warn-writer"),
        threading.Thread(target=clearer, name="warn-clearer"),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not [thread for thread in threads if thread.is_alive()], "a worker hung"
    assert not failures, failures
    # The interleaving happened: the writer got past the target while being cleared.
    assert progress[0] >= target_appends
    # And the recorder is still usable afterwards, which is what the V4 call site
    # relies on when it clears between two token requests.
    recorder.clear()
    recorder.assert_equal([], requirement="F-004-RQ-001")


def test_the_lock_is_per_instance_not_shared() -> None:
    """Two recorders are independent, so parallel tests neither block nor observe each other.

    A module-level lock would tie the isolation of one test to the behaviour of
    another - the opposite of what it is here to provide - and would not be visible
    from either test alone.
    """
    first = RecordingWarningHandler()
    second = RecordingWarningHandler()

    record_all(first, ["only-first"])

    assert first.snapshot() == ["only-first"]
    assert second.snapshot() == []
    assert second.count() == 0

    # Holding one recorder's lock must not block the other's append. If the lock
    # were shared this would deadlock, which the timeout converts into a failure.
    # Naming the private lock is the point: its SCOPE is what is under test.
    with first._lock:
        second.handle_warning_header(299, "test-agent", "not-blocked")
    assert second.snapshot() == ["not-blocked"]


# ---------------------------------------------------------------------------
# 2. Copies, not views
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("reader", ["snapshot", "warnings"], ids=["snapshot", "property"])
def test_a_reader_receives_a_copy_it_cannot_write_through(reader: str) -> None:
    """Mutating the returned list must not touch recorder state.

    Handing back the internal list would let a caller corrupt the evidence a V2
    assertion is about to read - and would do it silently, since the mutation looks
    local at the call site.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, [PSS_WARNING])

    observed: list[str] = (
        recorder.snapshot() if reader == "snapshot" else recorder.warnings
    )
    observed.append("injected")
    observed[0] = "overwritten"

    assert recorder.snapshot() == [PSS_WARNING]
    assert recorder.count() == 1


def test_two_reads_are_independent_of_each_other() -> None:
    """Each read is its own list, so one caller's mutation is invisible to the next."""
    recorder = RecordingWarningHandler()
    record_all(recorder, ["a", "b"])

    first = recorder.snapshot()
    second = recorder.snapshot()

    assert first == second
    assert first is not second
    first.clear()
    assert recorder.snapshot() == ["a", "b"]


def test_the_property_and_the_method_are_the_same_locked_read() -> None:
    """``warnings`` exists so a reader reaching for the Go FIELD name finds it."""
    recorder = RecordingWarningHandler()
    record_all(recorder, ["a", "b", "c"])

    assert recorder.warnings == recorder.snapshot()
    assert recorder.count() == len(recorder.warnings)


# ---------------------------------------------------------------------------
# 3. What is recorded, and in what order
# ---------------------------------------------------------------------------


def test_only_the_message_is_recorded_code_and_agent_are_discarded() -> None:
    """The Go body appends ``message`` alone, and every ported assertion depends on it.

    A recorder holding ``(code, agent, message)`` tuples would break
    ``assert_equal`` - the port of ``reflect.DeepEqual`` over a ``[]string`` - for
    every call site simultaneously.
    """
    recorder = RecordingWarningHandler()

    recorder.handle_warning_header(299, "kube-apiserver/v1.34.0", PSS_WARNING)
    recorder.handle_warning_header(0, "", PSS_WARNING)

    assert recorder.snapshot() == [PSS_WARNING, PSS_WARNING]


def test_arrival_order_is_preserved_including_duplicates() -> None:
    """Order is part of the assertion: a warning's position carries which request sent it.

    Duplicates are kept for the same reason - two identical warnings from two
    requests are two findings, and de-duplicating would under-report.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, ["second-request", "first-request", "second-request"])

    assert recorder.snapshot() == ["second-request", "first-request", "second-request"]
    assert recorder.count() == 3


@pytest.mark.parametrize(
    "message",
    ["", " ", "\n", "a" * 8_192, 'quotes " and \\ backslash', "unicode \u00e9\u4e2d"],
    ids=["empty", "space", "newline", "long", "quoting", "unicode"],
)
def test_a_message_is_recorded_verbatim_whatever_it_contains(message: str) -> None:
    """No trimming, no normalisation, no truncation.

    Server-authored prose is asserted only for PRESENCE by the V2 call site, but a
    recorder that altered it would make any future exact assertion unwritable - and
    an empty warning is still a warning the server chose to send.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, [message])

    assert recorder.snapshot() == [message]


# ---------------------------------------------------------------------------
# 4. assert_equal and assert_any
# ---------------------------------------------------------------------------


def test_assert_equal_accepts_a_tuple_of_the_right_messages() -> None:
    """``expected`` is normalised with ``list(...)`` before comparing.

    Python holds ``("a",) != ["a"]`` where Go's ``reflect.DeepEqual`` compares two
    ``[]string`` with no such distinction available to it, so normalising keeps the
    VERDICT identical rather than adding leniency.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, ["a", "b"])

    recorder.assert_equal(("a", "b"))
    recorder.assert_equal(["a", "b"])


@pytest.mark.parametrize(
    "expected",
    [["b", "a"], ["a"], ["a", "b", "c"], ["A", "B"], ["a b"], []],
    ids=["reordered", "too-few", "too-many", "case-folded", "concatenated", "empty"],
)
def test_assert_equal_is_exact_and_ordered(expected: list[str]) -> None:
    """No sorting, no subset match, no case folding, no substring match."""
    recorder = RecordingWarningHandler()
    record_all(recorder, ["a", "b"])

    with pytest.raises(AssertionError):
        recorder.assert_equal(expected)


def test_assert_equal_names_the_requirement_it_enforces() -> None:
    """AAP §0.7.2: a failure must read as a requirement violation.

    The reader of a CI failure in a security suite is frequently not the author of
    the test, which is why the identifier leads rather than being implied by the
    file path.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, ["surprise"])

    with pytest.raises(AssertionError) as raised:
        recorder.assert_equal([], requirement="F-002-RQ-001")

    message = str(raised.value)
    assert message.startswith("F-002-RQ-001: ")
    assert "expected" in message
    assert "surprise" in message


@pytest.mark.parametrize("requirement", [None, "", "   "], ids=["none", "empty", "blank"])
def test_a_blank_requirement_leaves_the_message_undisfigured(requirement: str | None) -> None:
    """A caller without an identifier must not be forced to invent one."""
    recorder = RecordingWarningHandler()
    record_all(recorder, ["surprise"])

    with pytest.raises(AssertionError) as raised:
        recorder.assert_equal([], requirement=requirement)

    assert str(raised.value).startswith("expected")


def test_clear_then_assert_empty_passes() -> None:
    """A cleared recorder equals an empty list.

    Go must assert against ``nil`` after its ``clear()``, since
    ``reflect.DeepEqual(nil_slice, empty_slice)`` is false. Python draws no such
    distinction. That is a deliberate VERDICT-PRESERVING simplification: it removes
    a way for a correct test to fail spuriously and adds no way for an incorrect one
    to pass, because "no warnings were recorded" is the only state either spelling
    describes.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, ["a", "b"])

    recorder.clear()

    assert recorder.snapshot() == []
    assert recorder.count() == 0
    recorder.assert_equal([])


def test_assert_any_passes_on_one_warning_whatever_it_said() -> None:
    """The V2 ``warn=restricted`` case: admitted AND warned.

    The exact wording is deliberately NOT asserted - pinning server-authored prose
    would fail on a harmless upstream rewording while proving nothing more than its
    presence already does.
    """
    recorder = RecordingWarningHandler()
    record_all(recorder, [PSS_WARNING])

    recorder.assert_any(description="Pod Security warning", requirement="F-002-RQ-001")


def test_assert_any_fails_when_the_channel_was_silent() -> None:
    """Only this half distinguishes a working Pod Security plugin from an absent one.

    A pod admitted with no warning under ``warn=restricted`` is exactly the state V2
    must fail on, and the message has to say which channel was silent.
    """
    recorder = RecordingWarningHandler()

    with pytest.raises(AssertionError) as raised:
        recorder.assert_any(description="Pod Security warning", requirement="F-002-RQ-003")

    message = str(raised.value)
    assert message.startswith("F-002-RQ-003: ")
    assert "Pod Security warning" in message


def test_a_typo_on_the_internal_field_raises_rather_than_being_absorbed() -> None:
    """``__slots__`` turns ``self._warning = []`` into an AttributeError.

    Without it a typo creates a second list that nothing ever reads, and the
    recorder reports no warnings at all - a false PASS for the ``assert_equal([])``
    half of V4 and a false FAIL for V2, both silent.
    """
    recorder = RecordingWarningHandler()

    with pytest.raises(AttributeError):
        recorder._warning = []  # type: ignore[attr-defined]


def test_two_recorders_with_equal_contents_are_not_equal_objects() -> None:
    """Identity, not value: two recorders are two collection points.

    A generated ``__eq__`` over a lock field is neither meaningful nor comparable,
    and value equality here would let a test conflate the warnings of two different
    requests.
    """
    first = RecordingWarningHandler()
    second = RecordingWarningHandler()
    record_all(first, ["a"])
    record_all(second, ["a"])

    assert first != second
    # Comparing an object with itself is deliberate: identity IS the property.
    assert first == first
    assert first.snapshot() == second.snapshot()
