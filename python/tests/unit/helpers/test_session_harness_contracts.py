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

"""Contract tests for the SESSION HARNESS: the two places it used to report green on nothing.

AAP §0.4.4.1 (the ``python/tests/conftest.py`` session fixtures - ``shared_etcd`` as the
``framework.SharedEtcd`` port, and ``parity_baseline`` as the baseline loader) / §0.4.5
(the parity harness, whose committed manifest this loader is the reader of) / §0.3.2
(``framework.SharedEtcd`` semantics and the "real components, not mocks" posture) /
§0.3.4 and §0.6 (the etcd 3.6.5 pin, and ``etcd3gw`` 2.7.0 as an HTTP/JSON client of the
v3 gRPC gateway) / §0.9.4.2 (an etcd 3.6.5 binary on PATH, provisioned by
``hack/lib/etcd.sh``) / §0.11.1 (proof by EXECUTION: "Nothing is declared migrated until
the baseline says so") / tech-spec §6.6.3.4 (the documentation convention).

WHY THE SESSION FIXTURES NEED CONTRACT TESTS OF THEIR OWN. Both fixtures decide, before
any test body runs, WHAT the suite is about to be measured against - which baseline, and
which datastore. A wrong answer from either is not a test failure; it is a run that
asserts less than it appears to, and then reports success. Those are the two failure
shapes covered here, and neither is visible from inside the tests that depend on them:

* THE BASELINE LOADER used to SKIP when the committed manifest was absent, so deleting
  the file turned the whole parity tier green. Every parity assertion is quantified over
  the recorded rows, so an absent or NARROW manifest does not fail the gate - it empties
  it.
* THE ETCD REUSE PATH used to adopt any listener whose ``/health`` said ``true``, so a
  session could run V3's raw-storage assertions against an etcd of any version, reached
  through an interface that may not serve the requests those assertions depend on.

INVARIANTS LOCKED BY THIS MODULE:

1. AN UNUSABLE BASELINE IS ALWAYS AN ERROR AND NEVER A SKIP - absent, unreadable,
   empty, unparsable, row-less or narrow alike - and the real committed artifact is
   accepted, so the refusals are not simply "refuse everything".
2. THE READER AND THE WRITER RESOLVE THE SAME FILE, by the same precedence, so neither
   environment spelling can be set to no effect.
3. "SOMETHING ANSWERS" IS NOT "THE RIGHT THING ANSWERS": the version floor and the v3
   gateway are both proven before an existing etcd is adopted, and the floor is the same
   one the spawn path enforces.
4. AN EXPLICIT ``KUBE_INTEGRATION_ETCD_URL`` IS AN INSTRUCTION: when the named endpoint
   cannot be used the session fails rather than quietly substituting a different one,
   while the same condition on this file's DEFAULT url still falls through to the pinned
   private binary.
"""

from __future__ import annotations

import inspect
import io
import json
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

import pytest

import tests.conftest as harness
from tests.parity.tools.generate_baseline import (
    ENV_BASELINE_FILE,
    ENV_BASELINE_FILE_ALIAS,
    PROVENANCE_DERIVED,
    PROVENANCE_GO_TEST_JSON,
    SCHEMA_VERSION,
    default_baseline_path,
    split_provenance,
)
from tests.parity.tools.generate_baseline import (
    _resolve_output as resolve_writer_output,
)

if TYPE_CHECKING:
    from pathlib import Path

# The loader's own error type. The names this module exercises are module-private
# because they are harness internals rather than a published surface - the fixtures
# ARE the public API - and reaching them directly is the only way to assert on a
# decision the fixtures take before any test body runs. It is bound through the
# module rather than imported by name so that this file cannot hold a stale class
# object across the monkeypatching the cases below do.
HarnessError = harness._HarnessError


def write_manifest(path: Path, document: object) -> Path:
    """Write a candidate manifest and return its path."""
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def load_expecting_refusal(path: Path) -> HarnessError:
    """Load ``path`` and return the refusal, FAILING if the loader skipped instead.

    ``pytest.raises(HarnessError)`` is not sufficient here, and the reason is the exact
    hazard this module exists to catch: ``pytest.skip()`` raises ``Skipped``, which
    derives from ``BaseException`` and therefore passes straight THROUGH
    ``pytest.raises`` - the test is then reported as *skipped*, its assertions never run,
    and the summary line contains no failure to notice. A test written that way would go
    green against the very regression it was added to prevent. So the outcome is
    discriminated explicitly, and a skip is converted into a failure that says so.

    Returns:
        The :class:`_HarnessError` the loader raised.
    """
    __tracebackhide__ = True
    try:
        document = harness._load_parity_baseline(path)
    except HarnessError as refusal:
        return refusal
    except BaseException as unexpected:  # the TYPE is the assertion, so nothing narrower works
        outcome = (
            "SKIPPED the run"
            if isinstance(unexpected, pytest.skip.Exception)
            else f"raised {type(unexpected).__name__}"
        )
        pytest.fail(
            f"loading an unusable baseline from {path} {outcome} ({unexpected}). An unusable "
            f"COMMITTED baseline must be a _HarnessError: a skip inside a session fixture "
            f"skips every dependent test quietly, so deleting the artifact would report "
            f"green and no failure would appear in the summary."
        )
    pytest.fail(
        f"loading an unusable baseline from {path} returned a document "
        f"({type(document).__name__}) instead of refusing it, so the parity contract would "
        f"be quantified over rows nobody measured."
    )


def one_row_manifest() -> dict[str, Any]:
    """A schema-valid, internally consistent manifest that asserts nothing.

    This is the shape that matters: it is not corrupt, not truncated in any way a
    parser can see, and every internal cross-check agrees with every other. Only a
    comparison against the measured domain can refuse it.
    """
    package = "k8s.io/kubernetes/cluster/gce/gci"
    return {
        "schema_version": SCHEMA_VERSION,
        "provenance": PROVENANCE_GO_TEST_JSON,
        "packages": [package],
        "counts": {
            "total": 1,
            "pass": 1,
            "fail": 0,
            "skip": 0,
            "by_package": {
                package: {
                    "total": 1,
                    "pass": 1,
                    "fail": 0,
                    "skip": 0,
                    "top_level": 1,
                    "subtests": 0,
                }
            },
        },
        "verdicts": [
            {
                "package": package,
                "test": "TestTLSFlags",
                "subtest": "",
                "action": "pass",
                "elapsed": 0.01,
            }
        ],
    }


# ---------------------------------------------------------------------------
# 1. The baseline loader: every unusable shape is an ERROR, not a skip
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("payload", "fragment"),
    [
        (None, "does not exist"),
        ("", "is empty"),
        ("   \n\t\n", "is empty"),
        ("{not json", "is not valid JSON"),
        ("[]", "is not a non-empty JSON object"),
        ("{}", "is not a non-empty JSON object"),
        ('"a string"', "is not a non-empty JSON object"),
        ('{"schema_version": 1}', "carries no 'verdicts' rows"),
        ('{"verdicts": []}', "carries no 'verdicts' rows"),
        ('{"verdicts": {}}', "carries no 'verdicts' rows"),
    ],
    ids=[
        "absent",
        "empty",
        "whitespace-only",
        "unparsable",
        "json-array",
        "empty-object",
        "json-string",
        "no-verdicts-key",
        "empty-verdicts-list",
        "verdicts-not-a-list",
    ],
)
def test_an_unusable_baseline_is_an_error_and_never_a_skip(
    payload: str | None, fragment: str, tmp_path: Path
) -> None:
    """INVARIANT LOCKED: there is NO skip path out of the baseline loader.

    The absent case is the one that mattered. It used to skip, on the reasoning that a
    fresh checkout has not run the generator yet - and the consequence was that
    ``rm python/tests/parity/baseline/go_baseline.json`` turned the parity tier green
    with a zero exit and nothing in the log to read as a warning. The manifest is a
    COMMITTED artifact, so its absence is a statement about the repository.

    The outcome is discriminated by :func:`load_expecting_refusal` rather than by
    ``pytest.raises`` alone, because a skip inside a session fixture skips every dependent
    test quietly: the summary line says "skipped", not "failed", and a CI job that greps
    for failures sees nothing.
    """
    path = tmp_path / "go_baseline.json"
    if payload is not None:
        path.write_text(payload, encoding="utf-8")

    assert fragment in str(load_expecting_refusal(path))


def test_a_narrow_but_schema_valid_baseline_is_refused(tmp_path: Path) -> None:
    """A manifest can be flawless and still assert nothing at all.

    Every structural check in the loader - parses, non-empty object, non-empty
    ``verdicts`` - passes on a single row, and so does the writer's own
    ``validate_manifest``, because all of its checks are INTERNAL. The refusal therefore
    has to come from a comparison against something external, which is why the loader
    delegates to ``check_committed_domain``: the same function the generator's
    ``--check`` gate calls, so a baseline this fixture accepts is exactly one the
    generator would certify.
    """
    path = write_manifest(tmp_path / "go_baseline.json", one_row_manifest())

    message = str(load_expecting_refusal(path))

    assert "does not describe the complete measured" in message
    # And the reason names what is missing, so the message is actionable rather than
    # merely negative.
    assert "Missing:" in message
    assert "test/integration/auth" in message


def test_the_loader_accepts_the_real_committed_baseline(
    repo_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The positive control, without which every refusal above is satisfied by "refuse all".

    INVARIANT LOCKED: the artifact in version control is one this fixture loads, and it
    is returned read-only at the top level because it is session-scoped and shared by
    every parity test - the cheapest way to remove the most obvious route by which one
    test could perturb another.
    """
    # Read the COMMITTED artifact, not whatever an ambient override points at.
    monkeypatch.delenv(ENV_BASELINE_FILE, raising=False)
    monkeypatch.delenv(ENV_BASELINE_FILE_ALIAS, raising=False)

    document = harness._load_parity_baseline(
        harness._resolve_baseline_path(repo_root)
    )

    assert isinstance(document, MappingProxyType)
    # Provenance is asserted by ATOM, never by string equality. The committed
    # manifest is a COMPOSED provenance -- `go_test_json+non_go_measured` -- because
    # its one non-Go row (the hack/boilerplate case) is measured by running that case
    # and reading its JUnit XML rather than by `go test -json`. What matters, and what
    # every gate checks, is that the measured Go atom is PRESENT and the derived atom
    # is ABSENT: an equality assertion would have to be rewritten every time an
    # honest atom is added, and rewriting it to the observed value is exactly how a
    # `derived` manifest would slip past this positive control.
    atoms = split_provenance(document["provenance"])
    assert PROVENANCE_GO_TEST_JSON in atoms
    assert PROVENANCE_DERIVED not in atoms
    assert len(document["verdicts"]) == 3105
    with pytest.raises(TypeError):
        document["provenance"] = "tampered"  # type: ignore[index]


def test_the_baseline_reader_and_writer_resolve_the_same_file(
    repo_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One authoritative path, by one precedence, on both sides of the artifact.

    Two environment names exist because the committed runner uses one and AAP §0.7
    documents the other. If the reader and the writer disagreed about their order - or if
    one honoured a name the other ignored - then setting that name would silently have no
    effect on half the pipeline, and a gate would compare a ported run against a manifest
    nobody wrote. The two sides are compared here through the functions they each
    actually use: ``_resolve_baseline_path`` on the reading side and ``_resolve_output``
    on the writing side.
    """
    # The variable NAMES are the same objects on both sides, which is the cheapest way
    # to make a rename impossible to do by halves.
    assert (harness.ENV_PARITY_BASELINE, harness.ENV_PARITY_BASELINE_ALIAS) == (
        ENV_BASELINE_FILE,
        ENV_BASELINE_FILE_ALIAS,
    )

    monkeypatch.delenv(ENV_BASELINE_FILE, raising=False)
    monkeypatch.delenv(ENV_BASELINE_FILE_ALIAS, raising=False)
    default = default_baseline_path(repo_root)
    assert harness._resolve_baseline_path(repo_root) == default
    assert resolve_writer_output(None, repo_root) == default

    # And the code-pinned name wins in BOTH places, so neither can be set to no effect.
    primary = tmp_path / "primary.json"
    alias = tmp_path / "alias.json"
    monkeypatch.setenv(ENV_BASELINE_FILE_ALIAS, str(alias))
    assert harness._resolve_baseline_path(repo_root) == alias
    assert resolve_writer_output(None, repo_root) == alias
    monkeypatch.setenv(ENV_BASELINE_FILE, str(primary))
    assert harness._resolve_baseline_path(repo_root) == primary
    assert resolve_writer_output(None, repo_root) == primary


# ---------------------------------------------------------------------------
# 2. The etcd version probe: every "cannot tell" is reported as one
# ---------------------------------------------------------------------------


class FakeResponse(io.BytesIO):
    """The minimum ``urlopen`` result the probes use: a context manager with a status."""

    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (b'{"etcdserver": "3.6.5", "etcdcluster": "3.6.0"}', "3.6.5"),
        (b'{"etcdserver": "3.5.9"}', "3.5.9"),
        (b'{"etcdcluster": "3.6.0"}', None),
        (b'{"etcdserver": ""}', None),
        (b'{"etcdserver": "   "}', None),
        (b'{"etcdserver": 3.65}', None),
        (b'["3.6.5"]', None),
        (b"not json", None),
        (b"", None),
    ],
    ids=[
        "full-payload",
        "server-only",
        "no-server-key",
        "empty-string",
        "blank-string",
        "non-string",
        "json-array",
        "unparsable",
        "empty-body",
    ],
)
def test_the_version_probe_reports_cannot_tell_rather_than_guessing(
    body: bytes, expected: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every transport and decoding failure means "cannot tell", and the caller decides.

    A probe that fabricated a version - or that let a non-string through to the parser -
    would turn an unanswerable question into a confident wrong answer, and the caller
    would adopt an endpoint on the strength of it.
    """
    monkeypatch.setattr(
        harness.urllib.request, "urlopen", lambda *_a, **_k: FakeResponse(body)
    )

    assert harness._etcd_server_version("http://127.0.0.1:2379") == expected


def test_the_version_probe_treats_an_unreachable_endpoint_as_cannot_tell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refused connection is an absence of information, not an exception to propagate."""

    def refuse(*_args: object, **_kwargs: object) -> FakeResponse:
        raise harness.urllib.error.URLError("connection refused")

    monkeypatch.setattr(harness.urllib.request, "urlopen", refuse)

    assert harness._etcd_server_version("http://127.0.0.1:2379") is None


# ---------------------------------------------------------------------------
# 3. The reuse gate: healthy is necessary and NOT sufficient
# ---------------------------------------------------------------------------


def stub_probes(
    monkeypatch: pytest.MonkeyPatch,
    *,
    version: str | None,
    gateway: str | None,
) -> list[str]:
    """Replace both endpoint probes and record the order they were called in.

    Ordering is part of the contract, not an implementation detail: the version floor is
    the cheap check and the gateway write mutates the endpoint, so a version-refused
    endpoint must never be written to.
    """
    calls: list[str] = []

    def fake_version(_url: str, *_a: object, **_k: object) -> str | None:
        calls.append("version")
        return version

    def fake_gateway(_url: str, *_a: object, **_k: object) -> str | None:
        calls.append("gateway")
        return gateway

    monkeypatch.setattr(harness, "_etcd_server_version", fake_version)
    monkeypatch.setattr(harness, "_etcd_gateway_writable", fake_gateway)
    return calls


@pytest.mark.parametrize(
    ("version", "gateway", "fragment"),
    [
        (None, None, "did not report a server version"),
        ("v3.6.5-rc", None, "unparsable version"),
        ("3.5.9", None, "below the 3.6.5 this repository pins"),
        ("2.3.8", None, "below the 3.6.5 this repository pins"),
        ("3.6.4", None, "below the 3.6.5 this repository pins"),
        ("3.6.5", "/v3/kv/put answered HTTP 503", "v3 gateway is not usable"),
        ("3.7.0", "/v3/kv/put failed: <urlopen error>", "v3 gateway is not usable"),
    ],
    ids=[
        "version-unknowable",
        "version-unparsable",
        "one-patch-family-below",
        "a-major-below",
        "one-patch-below",
        "gateway-refuses",
        "gateway-unreachable",
    ],
)
def test_an_etcd_that_answers_but_cannot_be_used_is_refused(
    version: str | None,
    gateway: str | None,
    fragment: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """INVARIANT LOCKED: adoption requires the PINNED version AND a working v3 gateway.

    ``/health`` answering proves a server is up and nothing else. The two things it does
    not prove are exactly the two V3 depends on:

    * VERSION. ``hack/lib/etcd.sh:19`` pins 3.6.5 and ``build/dependencies.yaml``
      registers the pin; V3's assertions read RAW storage, where a storage-format
      difference is precisely what a pin exists to prevent. The spawn path already
      enforced this, so skipping it on reuse meant the same session was version-checked
      or not depending on whether a developer had left an etcd running.
    * TRANSPORT. ``etcd3gw`` 2.7.0 is an HTTP/JSON client of the gRPC GATEWAY, so
      ``/v3/kv/*`` has to be serving. A listener behind a proxy, or an etcd started with
      the gateway disabled, passes ``/health`` and fails the first raw read with an
      error about JSON that names nothing relevant.
    """
    monkeypatch.delenv(harness.ENV_ETCD_VERSION, raising=False)
    stub_probes(monkeypatch, version=version, gateway=gateway)

    refusal = harness._etcd_reuse_refusal("http://127.0.0.1:2379")

    assert refusal is not None
    assert fragment in refusal


def test_a_conforming_etcd_is_adopted_and_is_probed_in_the_cheap_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The positive control, plus the ordering that keeps a refused endpoint unwritten.

    Without this every refusal above would also be satisfied by a gate that refused
    everything, which would make the whole reuse path dead code - and reuse is what keeps
    a warm ``kube::etcd::start`` session usable, as ``startEtcd`` intends.
    """
    monkeypatch.delenv(harness.ENV_ETCD_VERSION, raising=False)
    calls = stub_probes(monkeypatch, version="3.6.5", gateway=None)

    assert harness._etcd_reuse_refusal("http://127.0.0.1:2379") is None
    assert calls == ["version", "gateway"], (
        "the version floor must be settled before the gateway smoke WRITE, so an endpoint "
        "this gate rejects is never written to"
    )


def test_a_version_refusal_never_writes_to_the_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refused endpoint is left exactly as it was found.

    The gateway check is a ``PUT`` of the smoke key, copied from hack/lib/etcd.sh:93. On
    an endpoint that has already failed the version floor that write is both pointless
    and a mutation of something this session has decided not to use.
    """
    monkeypatch.delenv(harness.ENV_ETCD_VERSION, raising=False)
    calls = stub_probes(monkeypatch, version="3.5.9", gateway=None)

    assert harness._etcd_reuse_refusal("http://127.0.0.1:2379") is not None
    assert calls == ["version"]


def test_the_reuse_floor_is_the_same_one_the_spawn_path_enforces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``$ETCD_VERSION`` moves both floors together, so there is one standard, not two.

    ``_resolve_etcd_binary`` resolves the spawn-path floor as ``$ETCD_VERSION`` if set,
    else the pinned default. Reading the same variable here is what makes a reused and a
    spawned instance interchangeable from a test's point of view.
    """
    stub_probes(monkeypatch, version="3.6.5", gateway=None)

    monkeypatch.setenv(harness.ENV_ETCD_VERSION, "3.7.0")
    refusal = harness._etcd_reuse_refusal("http://127.0.0.1:2379")
    assert refusal is not None
    assert "below the 3.7.0 this repository pins" in refusal

    monkeypatch.setenv(harness.ENV_ETCD_VERSION, "3.6.5")
    assert harness._etcd_reuse_refusal("http://127.0.0.1:2379") is None


def test_an_uncomparable_version_pin_is_a_harness_error_not_a_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A floor nobody can evaluate is a configuration fault, and is raised rather than returned.

    Returning it as an ordinary refusal would send the caller down the "start a private
    instance instead" branch, where the same unparsable pin fails again - reporting the
    consequence instead of the cause.
    """
    stub_probes(monkeypatch, version="3.6.5", gateway=None)
    monkeypatch.setenv(harness.ENV_ETCD_VERSION, "three-point-six")

    with pytest.raises(HarnessError, match="is not a version this gate can compare"):
        harness._etcd_reuse_refusal("http://127.0.0.1:2379")


# ---------------------------------------------------------------------------
# 4. An explicit endpoint is an INSTRUCTION, not a hint
# ---------------------------------------------------------------------------


class RefusingRequest:
    """A ``FixtureRequest`` stand-in that fails loudly if the spawn path is entered.

    ``shared_etcd`` uses ``request`` for exactly one thing - ``getfixturevalue`` on the
    spawn path - so a stub that raises on it turns "did this fall through to spawning?"
    into an observable fact rather than something inferred from a log line.
    """

    class Reached(RuntimeError):
        """Raised when the fixture reached the spawn path."""

    def getfixturevalue(self, name: str) -> object:
        raise RefusingRequest.Reached(name)


def drive_shared_etcd(request: object) -> Any:
    """Start the real ``shared_etcd`` generator, unwrapped from its fixture marker.

    ``inspect.unwrap`` follows the ``__wrapped__`` chain pytest's fixture marker sets, so
    this exercises the SHIPPED generator body rather than a copy of its logic.
    """
    generator_function = inspect.unwrap(harness.shared_etcd)
    return generator_function(request)


def test_an_explicit_but_unusable_endpoint_fails_instead_of_being_substituted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """INVARIANT LOCKED: the operator's named endpoint is honoured or the session fails.

    Silently starting a different etcd would run the integration tier against an instance
    nobody chose and then report green about it. The failure names the refusal, so the
    reader learns which check declined the endpoint rather than only that something did.
    """
    monkeypatch.setenv(harness.ENV_ETCD_URL, "http://10.0.0.9:2379")
    monkeypatch.setattr(harness, "_tcp_reachable", lambda *_a, **_k: True)
    monkeypatch.setattr(harness, "_etcd_healthy", lambda *_a, **_k: True)
    monkeypatch.setattr(
        harness, "_etcd_reuse_refusal", lambda *_a, **_k: "runs etcd 3.5.9, below the floor"
    )

    generator = drive_shared_etcd(RefusingRequest())
    with pytest.raises(HarnessError) as raised:
        next(generator)

    message = str(raised.value)
    assert "http://10.0.0.9:2379" in message
    assert "runs etcd 3.5.9, below the floor" in message
    assert "no substitute is started" in message


def test_the_same_condition_on_the_default_endpoint_falls_through_to_the_pinned_binary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The asymmetry is the point: a coincidence is repaired, an instruction is not overridden.

    When the url is merely this file's default, whatever is listening on 2379 is a
    coincidence, and starting the pinned private binary is the correct repair. Proving
    both halves matters because a gate that escalated in BOTH cases would break every
    developer machine with an unrelated etcd running, and one that escalated in NEITHER is
    the defect being fixed.
    """
    monkeypatch.delenv(harness.ENV_ETCD_URL, raising=False)
    monkeypatch.setattr(harness, "_tcp_reachable", lambda *_a, **_k: True)
    monkeypatch.setattr(harness, "_etcd_healthy", lambda *_a, **_k: True)
    monkeypatch.setattr(
        harness, "_etcd_reuse_refusal", lambda *_a, **_k: "its v3 gateway is not usable"
    )

    generator = drive_shared_etcd(RefusingRequest())
    with pytest.raises(RefusingRequest.Reached) as raised:
        next(generator)

    assert str(raised.value) == "etcd_binary", (
        "the default-url path must fall through to the pinned binary, which it reaches by "
        "requesting the etcd_binary fixture"
    )


def test_a_usable_endpoint_is_borrowed_and_never_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A borrowed etcd survives the run that used it, and the run still gets a fresh prefix.

    ``framework.SharedEtcd`` returns ``func() {}`` for a reused instance for this reason:
    the session did not create it, so it must not stop it and must not delete its data.
    Isolation comes from the per-run storage prefix instead, which is why adopting a
    shared datastore cannot make two runs collide.
    """
    monkeypatch.setenv(harness.ENV_ETCD_URL, "http://127.0.0.1:2379")
    monkeypatch.setattr(harness, "_tcp_reachable", lambda *_a, **_k: True)
    monkeypatch.setattr(harness, "_etcd_healthy", lambda *_a, **_k: True)
    monkeypatch.setattr(harness, "_etcd_reuse_refusal", lambda *_a, **_k: None)

    first = drive_shared_etcd(RefusingRequest())
    second = drive_shared_etcd(RefusingRequest())
    try:
        instance = next(first)
        other = next(second)

        assert instance.reused is True
        assert (instance.data_dir, instance.log_file, instance.pid) == (None, None, None)
        assert instance.url == "http://127.0.0.1:2379"
        assert instance.prefix.endswith(f"/{harness.STORAGE_PREFIX_SUFFIX}")
        assert instance.prefix != other.prefix, (
            "each session gets its own storage prefix even when the datastore is shared"
        )

        # Teardown must not stop what it did not start: the generator finishes without
        # touching the endpoint, which is `framework.SharedEtcd` returning `func() {}`.
        with pytest.raises(StopIteration):
            next(first)
    finally:
        first.close()
        second.close()
