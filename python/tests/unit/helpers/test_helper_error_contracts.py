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

"""Contract tests for HONEST ERROR PROPAGATION across the shared harness helpers.

Provenance: AAP §0.4.4.1 (fixtures and helpers live outside the test modules that
use them, so their behaviour has to be provable on its own) / AAP §0.7.2 (failure
legibility: a failure must read as the defect it is) / AAP §0.11.1 (evidence over
assumption; and the explicit substitutes this tier owes for Go's ``-race`` and
``goleak``, which include reporting a socket that was not released) / tech-spec
§6.6.3.4 (every Blitzy-authored test carries a provenance citation and names the
invariant it locks).

INVARIANT LOCKED BY THIS MODULE: a shared helper reports the failure that actually
happened. Three helpers previously widened an ``except`` clause or ordered a state
change so that a real defect was reshaped into a plausible-looking one:

    tests.helpers.apierrors   a bounded expectation retried EVERY exception for
                              thirty seconds, so an ``AttributeError`` in the
                              caller's operation was finally reported as
                              "Expected forbidden error, got ..." -- the wrong
                              defect, half a minute late.
    tests.helpers.polling     the shared interval and timeout were read through a
                              bare ``except Exception``, so any failure raised
                              WHILE ``tests/conftest.py`` executed was replaced by
                              fallback numbers and never seen.
    tests.helpers.etcd_raw    a non-numeric budget and a malformed gateway row
                              escaped as ``TypeError``/``KeyError`` from a helper
                              documented to raise only ``RawEtcdError``, and a
                              FAILED ``close()`` marked the reader closed anyway,
                              so the socket it did not release could never be
                              released.

Each of the three is proven here against the behaviour, not against the comment.
No test in this module touches a network, an etcd or an API server: the seams are
exercised with local doubles, so the whole module runs under
``pytest -m "not integration"`` and needs no marker at all.
"""

from __future__ import annotations

import time
from typing import Any, Final, cast

import pytest
from etcd3gw import Etcd3Client

from tests.helpers.apierrors import expect_forbidden
from tests.helpers.etcd_raw import RawEtcdError, RawEtcdKV, read_prefix
from tests.helpers.polling import _session_defaults

# ---------------------------------------------------------------------------
# F09: a bounded expectation retries what the API server does, and nothing else
# ---------------------------------------------------------------------------


def test_a_programming_error_in_the_operation_is_raised_immediately() -> None:
    """A defect in the caller's operation surfaces AS ITSELF, on the first attempt.

    THE COST OF THE OLD BEHAVIOUR, which is why this is asserted on rather than
    described: ``expect`` retried every ``Exception`` for its full thirty-second
    budget and then reported "Expected forbidden error, got ...". A misspelled
    attribute in a one-line lambda therefore produced a thirty-second pause and an
    assertion message naming authorization -- pointing the reader at the API server
    while the actual defect sat in the test.

    Both halves are asserted: the exception type, and that it was raised on the
    FIRST attempt. The attempt count is what proves the poll did not swallow it,
    and the elapsed time is bounded well under the one-second retry interval so a
    regression cannot pass by being merely fast.
    """
    attempts = 0

    def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise AttributeError("the test itself is wrong: no such attribute")

    started = time.monotonic()
    with pytest.raises(AttributeError, match="no such attribute"):
        expect_forbidden(operation, requirement="F-007-RQ-002")
    elapsed = time.monotonic() - started

    assert attempts == 1, "a programming error must not be retried even once"
    assert elapsed < 0.5, (
        f"the failure took {elapsed:.2f}s to surface; it must not enter the retry loop"
    )


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(KeyError("status"), id="key-error"),
        pytest.param(TypeError("takes 2 positional arguments"), id="type-error"),
        pytest.param(ValueError("not a namespace"), id="value-error"),
        pytest.param(ZeroDivisionError("division by zero"), id="zero-division"),
    ],
)
def test_every_class_of_programming_error_propagates(error: Exception) -> None:
    """None of the ordinary mistakes a test can make is mistaken for an API decision.

    Each of these is something the operation itself got wrong. ``ApiException`` is
    the only exception that carries an authorization verdict, so anything else being
    fed into the predicate is a category error however many times it is retried.
    """
    with pytest.raises(type(error)):
        expect_forbidden(lambda: (_ for _ in ()).throw(error))


def test_pytest_own_outcomes_are_never_swallowed() -> None:
    """``pytest.skip()`` inside an operation skips, rather than being retried as a failure.

    pytest's outcome exceptions derive from ``BaseException`` precisely so helpers
    cannot absorb them. This has always held -- ``BaseException`` was never caught --
    and it is asserted so that narrowing the retry set cannot have quietly reversed
    it.
    """

    def operation() -> None:
        pytest.skip("the operation decided this environment cannot run it")

    with pytest.raises(BaseException, match="cannot run it"):
        expect_forbidden(operation)


# ---------------------------------------------------------------------------
# F14: the shared budget falls back only when it genuinely cannot be read
# ---------------------------------------------------------------------------


def test_the_shared_budget_comes_from_conftest_under_pytest() -> None:
    """Under pytest the imported branch is always taken, so the fallback is dead weight.

    Asserting it keeps the two definitions honest: were they to drift, this is the
    test that notices, because it compares the resolved values against the
    authoritative constants rather than against literals.
    """
    from tests.conftest import DEFAULT_POLL_INTERVAL_SECONDS, FOREVER_TEST_TIMEOUT_SECONDS

    assert _session_defaults() == (DEFAULT_POLL_INTERVAL_SECONDS, FOREVER_TEST_TIMEOUT_SECONDS)


def test_a_failure_inside_conftest_propagates_rather_than_being_defaulted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-``ImportError`` raised while reading the shared constants must NOT be swallowed.

    The old ``except Exception`` turned any such failure -- a typo, a bad constant, a
    bug in a fixture module -- into two plausible-looking numbers. The suite then ran
    with an interval and a timeout nobody had chosen, and the real defect surfaced
    later, if at all, as a mysterious timing difference.

    The failure is injected on the ATTRIBUTE, because ``from ... import X`` reads
    attributes off an already-imported module: that is the shape a genuine
    programming error in conftest takes once the module is in ``sys.modules``.
    """
    import tests.conftest as session_conftest

    class Exploding:
        def __get__(self, instance: object, owner: type | None = None) -> float:
            raise RuntimeError("a real defect in tests/conftest.py")

    class Shim:
        DEFAULT_POLL_INTERVAL_SECONDS = Exploding()
        FOREVER_TEST_TIMEOUT_SECONDS = 30.0

    monkeypatch.setitem(__import__("sys").modules, "tests.conftest", Shim)
    try:
        with pytest.raises(RuntimeError, match="a real defect"):
            _session_defaults()
    finally:
        monkeypatch.setitem(__import__("sys").modules, "tests.conftest", session_conftest)


def test_an_absent_module_still_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """``ImportError`` -- and only it -- keeps the module usable outside pytest.

    The fallback exists so this file's stdlib-only sibling can be imported by a
    script or by ``python -c`` in a tree where pytest is not installed. Narrowing the
    ``except`` must not have removed that.
    """
    import sys

    monkeypatch.setitem(sys.modules, "tests.conftest", None)

    interval, timeout = _session_defaults()

    assert interval == 0.5
    assert timeout == 30.0


# ---------------------------------------------------------------------------
# F15: the raw etcd reader raises its own error type, and closes before it says so
# ---------------------------------------------------------------------------


#: The endpoint every double is reached at. Never dialled: no test here opens a
#: socket, so this is only what a failure message names.
_ENDPOINT: Final[str] = "http://127.0.0.1:2379"


class _FakeSession:
    """A ``requests`` session double that records, or refuses, its own close."""

    def __init__(self, *, fail: bool = False) -> None:
        self.closed = 0
        self._fail = fail

    def close(self) -> None:
        if self._fail:
            raise OSError("the socket refuses to close")
        self.closed += 1


class _FakeClient:
    """An ``Etcd3Client`` double: enough surface for the reader, none of the wire."""

    def __init__(self, rows: object, *, session_fails: bool = False) -> None:
        self.session = _FakeSession(fail=session_fails)
        self.timeout: float | None = None
        self.api_path = "/v3/"
        self._rows = rows

    def get_prefix(self, prefix: str) -> Any:
        return self._rows

def _reader(client: _FakeClient) -> RawEtcdKV:
    """Wrap a client double in the REAL reader, casting once and centrally.

    :class:`RawEtcdKV` touches four members of its client -- ``session``,
    ``timeout``, ``api_path`` and ``get_prefix`` -- so a structural stand-in with
    those four exercises the real code path with no socket. The cast states that
    once, here, rather than scattering a per-call-site suppression.
    """
    return RawEtcdKV(cast("Etcd3Client", client), endpoint=_ENDPOINT)



@pytest.mark.parametrize(
    "timeout",
    [
        pytest.param(None, id="none"),
        pytest.param("30s", id="string-with-unit"),
        pytest.param([30], id="list"),
        pytest.param(object(), id="object"),
    ],
)
def test_a_non_numeric_budget_raises_the_documented_error(timeout: object) -> None:
    """A budget that is not a number is a ``RawEtcdError``, not a bare ``TypeError``.

    ``float(timeout)`` was the first thing a caller's value touched and it was
    unguarded, so a helper documented to raise only ``RawEtcdError`` leaked
    ``TypeError`` and ``ValueError`` from its opening line -- with a message naming
    neither the parameter nor the thirty-second bound being checked.
    """
    reader = _reader(_FakeClient([]))

    with pytest.raises(RawEtcdError, match="must be a number of seconds"):
        reader.scan_prefix("/registry/secrets/", timeout=timeout)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("rows", "why"),
    [
        pytest.param([("value",)], "one-element-row", id="row-too-short"),
        pytest.param([("value", {"no-key": b"x"})], "metadata-without-key", id="key-absent"),
        pytest.param([("value", "not-a-mapping")], "metadata-not-a-mapping", id="metadata-scalar"),
        pytest.param([None], "row-is-none", id="row-is-none"),
    ],
)
def test_a_malformed_gateway_row_raises_the_documented_error(rows: object, why: str) -> None:
    """A response shape this reader does not recognise is reported, naming the row.

    V3's whole verdict rests on this read, so a body that does not fit -- a proxy
    answering 200 with its own JSON, a future etcd renaming ``key``, a truncated
    response -- must say so. It used to raise ``KeyError``/``TypeError`` out of a
    list comprehension, which named neither the endpoint nor which row was wrong.
    """
    reader = _reader(_FakeClient(rows))

    with pytest.raises(RawEtcdError, match="does not recognise"):
        reader.scan_prefix("/registry/secrets/", timeout=1.0)

    assert why  # the id is the documentation; this keeps it referenced


def test_a_well_formed_row_still_decodes() -> None:
    """The guard must not have narrowed what a correct response may look like."""
    reader = _reader(
        _FakeClient([(b"k8s:enc:aesgcm:v1:key1:body", {"key": b"/registry/secrets/ns/name"})])
    )

    entries = reader.scan_prefix("/registry/secrets/", timeout=1.0)

    assert len(entries) == 1
    assert entries[0].key == b"/registry/secrets/ns/name"
    assert entries[0].value == b"k8s:enc:aesgcm:v1:key1:body"


def test_a_failed_close_leaves_the_reader_open_and_retryable() -> None:
    """A close that FAILED must not be recorded as a close that succeeded.

    Marking the reader closed first made the two indistinguishable: every later call
    returned immediately, and the pooled socket and file descriptor the close was
    meant to release stayed open with nothing left that could release them. There is
    no ``goleak`` analogue in this tier, so that leak has no other detector -- which
    is exactly why the failure is raised, the reader stays open, and the cause is
    retained on :attr:`RawEtcdKV.close_error` for a teardown assertion to report.
    """
    client = _FakeClient([], session_fails=True)
    reader = _reader(client)

    with pytest.raises(RawEtcdError, match="failed to release the HTTP session"):
        reader.close()

    assert reader.closed is False, "a session that is still open is not closed"
    assert isinstance(reader.close_error, OSError)

    # AND THE RETRY WORKS, which is the practical consequence: once whatever held
    # the socket lets go, the same reader can release it.
    client.session._fail = False
    reader.close()

    assert reader.closed is True
    assert reader.close_error is None
    assert client.session.closed == 1


def test_a_successful_close_is_idempotent() -> None:
    """Closing twice closes the session once. The context manager relies on this."""
    client = _FakeClient([])
    reader = _reader(client)

    reader.close()
    reader.close()

    assert client.session.closed == 1
    assert reader.closed is True


def test_read_prefix_rejects_a_non_numeric_budget_before_it_connects() -> None:
    """The module-level convenience refuses the same value, and never opens a socket.

    ``read_prefix`` validates the budget before constructing a client, so a bad
    argument cannot reach the network at all -- which is what makes this assertion
    safe to make without an etcd.
    """
    with pytest.raises(RawEtcdError, match="must be a number of seconds"):
        read_prefix(
            _ENDPOINT,
            "/registry/secrets/",
            timeout="soon",  # type: ignore[arg-type]
        )
