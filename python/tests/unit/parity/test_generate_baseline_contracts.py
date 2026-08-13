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

"""Contract tests for the parity baseline GENERATOR: every shape that must not become a baseline.

AAP §0.4.5 (the parity harness, and ``tools/generate_baseline.py`` as its generator) /
§0.5.1 (the ``python/tests/parity/tools/generate_baseline.py`` row) / §0.7.1.2 (the
measured baseline the manifest must reproduce: 648 verdicts in ``cluster/gce/gci``, 8
top-level and 640 subtests, and 43 top-level identities in ``test/integration/auth``) /
§0.9.1.3 (the generation command and its measured output) / tech-spec §6.6.3.4 (the
documentation convention).

WHY THE GENERATOR NEEDS ITS OWN CONTRACT TESTS. The baseline manifest is the artifact
the entire migration is judged against: "All tests should pass the same way as they
pass today" is enforced by comparing a ported run against it. Every assertion the
parity contract makes is QUANTIFIED OVER THE RECORDED VERDICTS, which gives the
generator a failure mode no downstream check can catch - a manifest that is smaller
than the truth does not fail the gate, it EMPTIES it, silently and with a zero exit.
So the properties asserted here are not about the generator's convenience; they are
about whether the gate exists at all.

INVARIANTS LOCKED BY THIS MODULE:

1. A STREAM CARRYING NO GO VERDICTS CANNOT BECOME A BASELINE, with or without the
   appended non-Go row. The non-Go row is a supplement to a measured Go domain and
   may never be the whole of one.
2. EVERY PACKAGE MUST REPORT EXACTLY ONE TERMINAL ACTION, AND IT MUST BE ``pass``. A
   package that fails while all of its tests pass is a build error, a ``TestMain``
   abort or a panic outside any test - the rows look perfect and the run was not.
3. A TRUNCATED STREAM IS DETECTED even when the truncation lands on a line boundary,
   where a JSON check cannot see it.
4. ONLY DEMONSTRABLY BENIGN ``go test`` FLAGS ARE FORWARDED. Anything that can change
   which tests run, or whether a verdict is emitted, is refused.
5. A DUPLICATED IDENTITY IS REJECTED WHEREVER IT ENTERS - including through
   ``--check`` on a hand-edited artifact, which never passes through the builder.
6. NOTHING IS WRITTEN ON ANY FAILURE, and no temporary file survives one.
7. GO'S SUBTEST IDENTITY SPELLING IS PRESERVED EXACTLY, including nested slashes and
   the ``#01`` de-duplication suffix.
8. A BASELINE IS ONLY EVER WHAT THE SUITE WAS OBSERVED TO DO. Rows read off Go source
   and stamped ``pass`` wholesale cannot reach the committed manifest by any route: a
   missing toolchain is reported rather than substituted for, the diagnostic mode
   needs an explicit acknowledgement, the committed path is reserved for measured
   rows, and ``--check`` refuses any other provenance.
9. FLAG VALUES ARE VALIDATED FROM EVERY SOURCE AND IN EVERY SPELLING - attached,
   separated, and inherited through ``GOFLAGS`` - because the allow-list decides
   which flags may be forwarded and only the value decides what they SAY.
10. THE COMMITTED MANIFEST COVERS THE WHOLE MEASURED DOMAIN. Being internally
    self-consistent is not enough: the package set, every per-package cardinality and
    the pass/skip distribution are all compared against measured pins, so a
    truncated or narrowly regenerated baseline fails instead of emptying the gate.
11. A SKIP IS RECORDABLE EXACTLY WHERE SOMETHING ACCOUNTS FOR IT, and a failure is
    recordable nowhere at all.
12. A NARROWED PACKAGE LIST CANNOT OVERWRITE THE COMMITTED MANIFEST. The quiet cousin
    of invariant 10, guarded one step earlier: what survives a narrow regeneration
    still looks complete, still validates and still reports green, while every
    identity of the omitted packages has silently left the gate.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Final

import pytest

from tests.parity.tools.generate_baseline import (
    DEFAULT_ORACLE_TIMEOUT,
    DEFAULT_PACKAGES,
    ENV_EXTRA_ARGS,
    EXPECTED_SKIP_COUNT,
    EXPECTED_SKIP_MARKER,
    EXPECTED_SKIP_PACKAGE,
    GO_MODULE_PATH,
    GO_TEST_DEFAULT_TIMEOUT,
    NON_GO_BASELINE_CLASSNAME,
    NON_GO_BASELINE_PACKAGE,
    NON_GO_BASELINE_RELATIVE_PATH,
    NON_GO_BASELINE_TEST,
    OUTER_TIMEOUT_MARGIN_SECONDS,
    PACKAGE_EXPECTATIONS,
    PROVENANCE_DERIVED,
    PROVENANCE_GO_TEST_JSON,
    PROVENANCE_NON_GO_MEASURED,
    SCHEMA_VERSION,
    BaselineError,
    PackageExpectation,
    Verdict,
    _non_go_baseline_verdict,
    _oracle_environment,
    _parse_non_go_junit,
    _resolve_extra_go_args,
    _terminate_process_group,
    _timeout_budget,
    build_manifest,
    check_committed_domain,
    check_domain_not_narrowed,
    check_go_verdict_domain,
    check_provenance_describes_rows,
    compose_provenance,
    default_baseline_path,
    is_non_go_package,
    main,
    parse_go_duration,
    reduce_event_stream,
    split_go_test_id,
    split_provenance,
    validate_manifest,
    write_manifest_atomic,
)
from tests.parity.tools.generate_baseline import (
    _oracle_environment as oracle_environment,
)
from tests.parity.tools.generate_baseline import (
    _resolve_extra_go_args as resolve_extra_go_args,
)

# A package that exists only in these tests, so nothing here can accidentally
# satisfy or violate a real PACKAGE_EXPECTATIONS entry.
PKG = f"{GO_MODULE_PATH}/synthetic/pkg"

# Guards are passed explicitly as an empty mapping wherever a synthetic stream is
# built, because a synthetic package has no measured cardinality to declare.
NO_GUARDS: dict[str, PackageExpectation] = {}


def event(**fields: Any) -> str:
    """Render one `go test -json` event line."""
    return json.dumps(fields)


def verdict_line(test: str, action: str = "pass", package: str = PKG) -> str:
    """Render one test-level verdict event."""
    return event(Action=action, Package=package, Test=test, Elapsed=0.01)


def package_line(action: str = "pass", package: str = PKG) -> str:
    """Render one package-level terminal event, which carries no ``Test``."""
    return event(Action=action, Package=package, Elapsed=0.5)


def green_stream(*tests: str, package: str = PKG) -> list[str]:
    """A well-formed, all-passing stream: a run event, N verdicts, one package summary."""
    lines = [event(Action="run", Package=package, Test=tests[0])] if tests else []
    lines += [verdict_line(test, package=package) for test in tests]
    lines.append(package_line(package=package))
    return lines


# ---------------------------------------------------------------------------
# 1. Zero Go verdicts cannot become a baseline  (finding #20)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("lines", "why"),
    [
        ([], "an empty file"),
        (["", "   ", ""], "only blank lines"),
        ([package_line()], "a package summary and nothing else"),
        (
            [event(Action="run", Package=PKG, Test="TestA"), package_line()],
            "a run event with no outcome",
        ),
        (
            [event(Action="output", Package=PKG, Output="ok\\n"), package_line()],
            "output text only",
        ),
        (
            [verdict_line("TestMain"), package_line()],
            "only TestMain, which emits no verdict identity",
        ),
    ],
    ids=["empty", "blank", "summary-only", "run-only", "output-only", "testmain-only"],
)
def test_a_stream_with_no_go_verdicts_is_refused(lines: list[str], why: str) -> None:
    """Zero Go verdicts must abort, whatever produced the emptiness.

    This is the shape the appended non-Go row used to rescue. `build_manifest` only
    ever rejected ZERO rows, so one Python row was enough to satisfy it, and the
    result was a manifest that made every parity assertion vacuously true.
    """
    reduction = reduce_event_stream(lines, source=f"<{why}>")

    assert reduction.verdicts == ()
    with pytest.raises(BaselineError, match="ZERO verdicts"):
        check_go_verdict_domain(reduction, packages=[], require_requested=False)


def test_the_non_go_row_alone_cannot_satisfy_the_builder() -> None:
    """Demonstrates WHY obligation 1 must live before the append, not after.

    `build_manifest` accepts a single non-Go row - correctly, since it cannot know
    what preceded it. The refusal therefore has to happen at the collection step,
    which is what `check_go_verdict_domain` is called for on both Go routes.
    """
    non_go_only = [
        Verdict(
            package=NON_GO_BASELINE_PACKAGE,
            test=NON_GO_BASELINE_TEST,
            subtest="",
            action="pass",
            elapsed=None,
        )
    ]

    manifest = build_manifest(
        non_go_only,
        # Honest provenance: there is no Go row here, so a Go-only claim would be
        # refused by check_provenance_describes_rows. See
        # test_a_non_go_row_may_not_be_stamped_as_go_output.
        provenance=compose_provenance(PROVENANCE_NON_GO_MEASURED),
        expectations=NO_GUARDS,
    )

    assert manifest["counts"] == {
        "total": 1,
        "pass": 1,
        "fail": 0,
        "skip": 0,
        "by_package": {
            NON_GO_BASELINE_PACKAGE: {
                "total": 1,
                "pass": 1,
                "fail": 0,
                "skip": 0,
                "top_level": 1,
                "subtests": 0,
            }
        },
    }


def test_a_requested_package_that_produced_nothing_is_refused() -> None:
    """A misspelled or empty package would narrow the declared domain silently."""
    reduction = reduce_event_stream(green_stream("TestA"), source="<stream>")

    with pytest.raises(BaselineError, match="produced NO VERDICT") as raised:
        check_go_verdict_domain(
            reduction,
            packages=["synthetic/pkg", "synthetic/absent"],
            require_requested=True,
        )

    assert f"{GO_MODULE_PATH}/synthetic/absent" in str(raised.value)


def test_a_requested_package_that_only_reported_a_summary_is_refused() -> None:
    """A package-level summary is NOT a verdict, and `go test` emits one for a package
    that ran nothing at all - "no test files", every test file excluded by a build tag,
    or a filter that matched nothing - and then exits 0.

    Accepting a summary as evidence of presence is what let a requested package
    contribute zero rows while the manifest still declared it in scope, which makes
    every assertion about that package vacuous. The message must also SAY that the
    package was summarised, so the reader can tell "ran and emitted nothing" from
    "was never built".
    """
    empty_package = f"{GO_MODULE_PATH}/synthetic/empty"
    lines = [
        *green_stream("TestA"),
        json.dumps({"Action": "pass", "Package": empty_package, "Elapsed": 0.0}),
    ]
    reduction = reduce_event_stream(lines, source="<stream>")
    assert reduction.package_status[empty_package] == "pass"
    assert all(verdict.package != empty_package for verdict in reduction.verdicts)

    with pytest.raises(BaselineError, match="produced NO VERDICT") as raised:
        check_go_verdict_domain(
            reduction,
            packages=["synthetic/pkg", "synthetic/empty"],
            require_requested=True,
        )

    message = str(raised.value)
    assert empty_package in message
    assert "did report a package-level summary" in message


@pytest.mark.parametrize(
    "spec",
    ["synthetic/pkg", "./synthetic/pkg", "./synthetic/pkg/", f"{GO_MODULE_PATH}/synthetic/pkg"],
    ids=["bare", "dot-slash", "trailing-slash", "import-path"],
)
def test_a_requested_package_is_matched_after_normalisation(spec: str) -> None:
    """The runner passes repository-relative patterns; the stream reports import paths.

    Comparing the two spellings directly makes the presence check fire on EVERY
    well-formed run, which is how this was first caught - against the real 648-verdict
    ``cluster/gce/gci`` stream, invoked exactly as ``test-parity.sh`` invokes it.
    """
    reduction = reduce_event_stream(green_stream("TestA"), source="<stream>")

    check_go_verdict_domain(reduction, packages=[spec], require_requested=True)


def test_a_recursive_pattern_is_satisfied_by_a_package_beneath_it() -> None:
    """``./synthetic/...`` names a subtree, and the root itself usually holds no tests."""
    reduction = reduce_event_stream(green_stream("TestA"), source="<stream>")

    check_go_verdict_domain(reduction, packages=["./synthetic/..."], require_requested=True)


# ---------------------------------------------------------------------------
# 2. Package-level outcomes are load-bearing  (finding #21)
# ---------------------------------------------------------------------------


def test_a_failing_package_whose_tests_all_pass_is_refused() -> None:
    """The case the reduction was computing and the caller was discarding.

    A package-level ``fail`` with every verdict ``pass`` is a BUILD ERROR, a
    ``TestMain`` abort or a panic outside any test. The run route's exit-code check
    does not cover it - a package-level failure does not always give `go test` a
    non-zero exit in a multi-package run - and the stream route has no exit code at
    all.
    """
    lines = [verdict_line("TestA"), verdict_line("TestB"), package_line(action="fail")]
    reduction = reduce_event_stream(lines, source="<stream>")

    # The rows genuinely are all green, which is exactly what made this invisible.
    assert [v.action for v in reduction.verdicts] == ["pass", "pass"]
    assert reduction.package_status == {PKG: "fail"}

    with pytest.raises(BaselineError, match="did not pass") as raised:
        check_go_verdict_domain(reduction, packages=[PKG], require_requested=True)

    assert "NONE - every individual test passed" in str(raised.value)


@pytest.mark.parametrize("status", ["fail", "skip"], ids=["fail", "skip"])
def test_any_non_passing_package_status_is_refused(status: str) -> None:
    """``skip`` too: a skipped package contributed none of the verdicts it owns."""
    reduction = reduce_event_stream(
        [verdict_line("TestA"), package_line(action=status)], source="<stream>"
    )

    with pytest.raises(BaselineError, match="did not pass"):
        check_go_verdict_domain(reduction, packages=[PKG], require_requested=True)


def test_a_second_terminal_action_for_one_package_is_refused() -> None:
    """A mapping SILENTLY OVERWRITES, so a `fail` followed by a `pass` erased the failure.

    Two terminal actions mean the package was listed twice or two streams were
    concatenated. Keeping the later one is how a run the toolchain called failed
    became a baseline the toolchain called clean.
    """
    lines = [verdict_line("TestA"), package_line(action="fail"), package_line(action="pass")]

    with pytest.raises(BaselineError, match="SECOND terminal action") as raised:
        reduce_event_stream(lines, source="<stream>")

    message = str(raised.value)
    assert "'fail' then 'pass'" in message
    assert "line 3" in message


def test_verdicts_without_a_terminal_package_action_are_refused() -> None:
    """Truncation that lands on a line boundary is invisible to a JSON check.

    Every verdict after the cut is missing, and a missing verdict is
    indistinguishable from a behaviour that never existed.
    """
    reduction = reduce_event_stream([verdict_line("TestA")], source="<stream>")

    with pytest.raises(BaselineError, match="no terminal package action") as raised:
        check_go_verdict_domain(reduction, packages=[PKG], require_requested=True)

    assert "ENDED MID-PACKAGE" in str(raised.value)


def test_a_well_formed_multi_package_stream_is_accepted() -> None:
    """The positive control: without it, every assertion above could pass vacuously."""
    other = f"{GO_MODULE_PATH}/synthetic/other"
    lines = green_stream("TestA", "TestB") + green_stream("TestC", package=other)

    reduction = reduce_event_stream(lines, source="<stream>")
    check_go_verdict_domain(reduction, packages=[PKG, other], require_requested=True)

    assert len(reduction.verdicts) == 3
    assert reduction.package_status == {PKG: "pass", other: "pass"}


# ---------------------------------------------------------------------------
# 3. Malformed and truncated streams  (finding #21, reduction half)
# ---------------------------------------------------------------------------


def test_unparsable_json_aborts_rather_than_being_skipped() -> None:
    """Skipping a line silently drops every verdict it carried."""
    lines = [verdict_line("TestA"), "{not json", package_line()]

    with pytest.raises(BaselineError, match="unparsable JSON on line 2"):
        reduce_event_stream(lines, source="<stream>")


def test_a_truncated_final_line_says_so() -> None:
    """The diagnostic names truncation, because that is the likeliest cause."""
    lines = [verdict_line("TestA"), '{"Action":"pass","Package":"p","Test":"Test']

    with pytest.raises(BaselineError, match="appears TRUNCATED") as raised:
        reduce_event_stream(lines, source="<stream>")

    assert "final line" in str(raised.value)


@pytest.mark.parametrize(
    "line",
    ["[]", '"a string"', "42", "null", "true"],
    ids=["array", "string", "number", "null", "boolean"],
)
def test_a_non_object_line_is_refused(line: str) -> None:
    """`go test -json` emits one JSON OBJECT per line."""
    with pytest.raises(BaselineError, match=r"not a JSON\s+object"):
        reduce_event_stream([line], source="<stream>")


def test_an_outcome_with_no_package_cannot_be_attributed() -> None:
    """Without a Package the verdict belongs to nothing and cannot be keyed."""
    with pytest.raises(BaselineError, match="no Package field"):
        reduce_event_stream([event(Action="pass", Test="TestA")], source="<stream>")


def test_a_non_string_test_field_is_refused() -> None:
    """A numeric Test cannot be split into an identity."""
    with pytest.raises(BaselineError, match="non-string Test field"):
        reduce_event_stream([event(Action="pass", Package=PKG, Test=7)], source="<stream>")


def test_a_duplicate_verdict_in_the_stream_is_refused() -> None:
    """``-count=2`` or a repeated package makes one row of the pair unreachable."""
    lines = [verdict_line("TestA"), verdict_line("TestA"), package_line()]

    with pytest.raises(BaselineError, match="duplicate verdict") as raised:
        reduce_event_stream(lines, source="<stream>")

    assert "line 1, again on line 2" in str(raised.value)


def test_unknown_event_fields_are_ignored() -> None:
    """A Go upgrade adds keys; refusing them would break the oracle for no benefit."""
    lines = [
        event(
            Action="pass",
            Package=PKG,
            Test="TestA",
            Elapsed=0.01,
            FailedBuild="",
            ImportPath=PKG,
            Attempt=1,
        ),
        package_line(),
    ]

    reduction = reduce_event_stream(lines, source="<stream>")

    assert [v.go_id for v in reduction.verdicts] == ["TestA"]


def test_output_events_are_never_mined_for_outcomes() -> None:
    """The toolchain's own ``Action`` is the only source of a verdict.

    ``--- FAIL:`` in an output line is text a test may legitimately print, and a
    reducer that read it would invent verdicts that the toolchain never reported.
    """
    lines = [
        event(Action="output", Package=PKG, Test="TestA", Output="--- FAIL: TestA (0.00s)\\n"),
        verdict_line("TestA"),
        package_line(),
    ]

    reduction = reduce_event_stream(lines, source="<stream>")

    assert [(v.go_id, v.action) for v in reduction.verdicts] == [("TestA", "pass")]


@pytest.mark.parametrize(
    "elapsed",
    [None, "0.5", True, [], {}],
    ids=["absent", "string", "boolean", "array", "object"],
)
def test_an_unusable_elapsed_records_zero_rather_than_inventing_one(elapsed: Any) -> None:
    """Never compared by the contract, so it cannot influence a verdict either way."""
    fields: dict[str, Any] = {"Action": "pass", "Package": PKG, "Test": "TestA"}
    if elapsed is not None:
        fields["Elapsed"] = elapsed

    reduction = reduce_event_stream([event(**fields), package_line()], source="<stream>")

    assert reduction.verdicts[0].elapsed == 0.0


# ---------------------------------------------------------------------------
# 4. Go identity spelling  (regression guard on the contract's join key)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("TestTLSFlags", ("TestTLSFlags", "")),
        ("TestTLSFlags/mTLS_enabled", ("TestTLSFlags", "mTLS_enabled")),
        (
            "TestCreateMasterAuditPolicy/kubelet.get.nodes",
            ("TestCreateMasterAuditPolicy", "kubelet.get.nodes"),
        ),
        (
            "TestCreateMasterAuditPolicy/system:anonymous.get.pods#01",
            ("TestCreateMasterAuditPolicy", "system:anonymous.get.pods#01"),
        ),
        ("TestOuter/middle/inner", ("TestOuter", "middle/inner")),
        ("TestOuter/a/b/c", ("TestOuter", "a/b/c")),
    ],
    ids=["top-level", "one-level", "dotted", "hash-suffix", "nested", "deeply-nested"],
)
def test_a_go_test_id_splits_on_the_first_slash_only(raw: str, expected: tuple[str, str]) -> None:
    """The subtest half keeps its slashes, and the ``#01`` suffix is part of the identity.

    Both matter to the join key. Go de-duplicates identical subtest names with
    ``#NN``, and the audit-policy matrix relies on it: two cases whose
    ``user.verb.object`` name collides are distinguished ONLY by that suffix, so
    stripping it would collapse two of the 620 into one unprovable row.
    """
    assert split_go_test_id(raw) == expected


# ---------------------------------------------------------------------------
# 5. A duplicated identity is rejected wherever it enters  (finding #23)
# ---------------------------------------------------------------------------


def clean_manifest() -> dict[str, Any]:
    """Build a small, valid manifest through the public builder."""
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.1),
        Verdict(package=PKG, test="TestA", subtest="case_one", action="pass", elapsed=0.2),
        Verdict(package=PKG, test="TestB", subtest="", action="pass", elapsed=0.3),
    ]
    return build_manifest(
        verdicts, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS
    )


def with_duplicated_row(manifest: dict[str, Any], index: int = 1) -> dict[str, Any]:
    """Duplicate one row AND keep ``counts`` consistent with the result.

    Keeping the counts honest is the whole point: an inconsistent manifest is already
    caught by the counts check, so a test that left them stale would prove nothing
    about the uniqueness guard.
    """
    duplicated = json.loads(json.dumps(manifest))
    rows = duplicated["verdicts"]
    target = dict(rows[index])
    rows.insert(index + 1, dict(target))
    rows.sort(key=lambda row: (row["package"], row["test"], row["subtest"]))
    counts = duplicated["counts"]
    counts["total"] += 1
    counts[target["action"]] += 1
    bucket = counts["by_package"][target["package"]]
    bucket["total"] += 1
    bucket[target["action"]] += 1
    bucket["subtests" if target["subtest"] else "top_level"] += 1
    return duplicated


def test_validate_manifest_rejects_a_duplicated_identity() -> None:
    """The guard `build_manifest` had and `validate_manifest` did not.

    A manifest reaching ``--check``, read back from disk, or assembled through the
    library API never passes through the builder - which is exactly the path a
    hand-edited artifact takes.
    """
    duplicated = with_duplicated_row(clean_manifest())

    with pytest.raises(BaselineError, match="duplicated \\(package, test, subtest\\)") as raised:
        validate_manifest(duplicated)

    assert "TestA/case_one" in str(raised.value)
    assert "(x2)" in str(raised.value)


def test_the_ordering_and_count_checks_are_blind_to_a_duplicate() -> None:
    """Proves the uniqueness guard cannot be delegated to either existing check.

    ``_validate_row_order`` compares the rows against ``sorted(rows)``, and sorting a
    list holding adjacent duplicates returns it unchanged - so the duplicate is not
    merely missed, it is INVISIBLE. ``counts`` are computed from the same rows, so a
    duplicated row is counted twice on both sides and the totals agree. This test
    exists so that removing the uniqueness guard fails loudly here rather than
    appearing to be covered elsewhere.
    """
    duplicated = with_duplicated_row(clean_manifest())
    rows = duplicated["verdicts"]

    assert rows == sorted(rows, key=lambda row: (row["package"], row["test"], row["subtest"]))
    assert duplicated["counts"]["total"] == len(rows)
    assert duplicated["counts"]["pass"] == sum(1 for row in rows if row["action"] == "pass")


def test_build_manifest_still_rejects_a_duplicate_identity() -> None:
    """The builder's own guard is unchanged: two guards, two entry points."""
    repeated = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.1),
        Verdict(package=PKG, test="TestA", subtest="", action="fail", elapsed=0.2),
    ]

    with pytest.raises(BaselineError, match="duplicate \\(package, test, subtest\\)"):
        build_manifest(repeated, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS)


def test_a_clean_manifest_round_trips_through_validation() -> None:
    """Positive control for the whole schema, so the rejections above mean something."""
    manifest = clean_manifest()

    validate_manifest(manifest)
    validate_manifest(json.loads(json.dumps(manifest)))

    assert manifest["schema_version"] == SCHEMA_VERSION
    assert manifest["packages"] == [PKG]


# ---------------------------------------------------------------------------
# 6. Writing is atomic and leaves nothing behind  (finding #54)
# ---------------------------------------------------------------------------


def test_a_written_manifest_is_valid_json_and_revalidates(tmp_path: Path) -> None:
    """The artifact on disk is the artifact that was validated."""
    manifest = clean_manifest()
    destination = tmp_path / "nested" / "go_baseline.json"

    written = write_manifest_atomic(manifest, destination)

    assert written == destination
    validate_manifest(json.loads(destination.read_text(encoding="utf-8")))
    assert not [path for path in destination.parent.iterdir() if path.name != destination.name]


def test_an_invalid_manifest_is_never_written(tmp_path: Path) -> None:
    """The writer revalidates, so a caller bypassing the builder cannot reach disk.

    And nothing is left behind: a temporary file surviving a rejection would be
    picked up by the boilerplate scanner and, worse, could be mistaken for a
    baseline.
    """
    destination = tmp_path / "go_baseline.json"

    with pytest.raises(BaselineError):
        write_manifest_atomic({"schema_version": SCHEMA_VERSION}, destination)

    assert not destination.exists()
    assert list(tmp_path.iterdir()) == []


def test_an_existing_manifest_survives_a_failed_write(tmp_path: Path) -> None:
    """A rejected regeneration must not destroy the committed baseline.

    Losing it would turn a bad regeneration into a lost gate, which is strictly worse
    than the bad regeneration itself.
    """
    destination = tmp_path / "go_baseline.json"
    write_manifest_atomic(clean_manifest(), destination)
    before = destination.read_text(encoding="utf-8")

    with pytest.raises(BaselineError):
        write_manifest_atomic({"not": "a manifest"}, destination)

    assert destination.read_text(encoding="utf-8") == before
    validate_manifest(json.loads(before))


# ---------------------------------------------------------------------------
# 7. The CLI: selection flags refused, nothing written on failure  (finding #22)
# ---------------------------------------------------------------------------

# Every one of these can shrink the recorded domain, and each used to be forwarded
# to `go test` unexamined because the deny-list held only `-run`.
REFUSED_ARGUMENTS = [
    "-run",
    "-run=TestX",
    "--run=TestX",
    "-skip=TestY",
    "-list=.",
    "-bench=.",
    "-benchtime=1x",
    "-benchmem",
    "-fuzz=FuzzX",
    "-fuzztime=10s",
    "-short",
    "-c",
    "-tags=integration",
    "-cpu=1,2",
    "-failfast",
    "-exec=wrapper",
    "-coverprofile=c.out",
    "-mod=mod",
    "./another/package",
    "TestSomething",
]


@pytest.mark.parametrize("argument", REFUSED_ARGUMENTS, ids=REFUSED_ARGUMENTS)
def test_the_cli_refuses_an_argument_that_could_shrink_the_domain(
    argument: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Refused BEFORE the oracle runs, and nothing is written.

    An allow-list rather than a deny-list, because the cost of missing an entry is a
    silently smaller gate rather than a visible error.
    """
    destination = tmp_path / "go_baseline.json"

    # `--` before the forwarded argument, and NOT for cosmetic reasons: `--packages`
    # is declared `nargs="+"`, so argparse consumes greedily and a bare token after
    # it becomes another PACKAGE rather than a forwarded argument. That is exactly
    # why the separator is tolerated and stripped rather than refused.
    exit_code = main(
        ["--output", str(destination), "--packages", "synthetic/pkg", "--", argument]
    )

    assert exit_code != 0
    assert "refusing the oracle argument" in capsys.readouterr().err
    assert not destination.exists()


@pytest.mark.parametrize(
    "argument",
    ["-count=0", "-count=2", "-count=100"],
    ids=["zero", "two", "hundred"],
)
def test_only_count_one_is_permitted(
    argument: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """0 runs nothing; anything above 1 repeats every test into duplicate triples."""
    exit_code = main(
        ["--output", str(tmp_path / "b.json"), "--packages", "synthetic/pkg", "--", argument]
    )

    assert exit_code != 0
    assert "only `-count=1` is permitted" in capsys.readouterr().err


def test_a_dangling_flag_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """An incomplete flag would consume whatever `go test` saw next - a package path."""
    exit_code = main(
        ["--output", str(tmp_path / "b.json"), "--packages", "synthetic/pkg", "--", "-timeout"]
    )

    assert exit_code != 0
    assert "expects a value and none followed it" in capsys.readouterr().err


def test_the_separator_itself_is_stripped_not_refused(tmp_path: Path) -> None:
    """A bare ``--`` is argparse's end-of-options marker and reaches the screen too.

    It has no meaning for `go test`, so refusing it would reject the very invocation
    shape a caller needs in order to forward anything at all - `--packages` is
    ``nargs="+"`` and would otherwise swallow the next token as a package.
    """
    stream = tmp_path / "events.json"
    stream.write_text("\n".join(green_stream("TestA")) + "\n", encoding="utf-8")
    destination = tmp_path / "go_baseline.json"

    exit_code = main(
        [
            "--event-stream",
            str(stream),
            "--packages",
            "synthetic/pkg",
            "--output",
            str(destination),
            "--no-include-non-go-baseline",
            "--",
        ]
    )

    assert exit_code == 0
    assert json.loads(destination.read_text(encoding="utf-8"))["counts"]["total"] == 1


def test_dash_o_is_this_script_s_output_flag_not_go_s(tmp_path: Path) -> None:
    """``-o`` never reaches the screen: argparse defines it as ``--output``.

    Recorded so the absence of ``-o`` from the refusal list reads as a measured fact
    rather than an oversight. A caller who means `go test -o` gets this script's
    output path, which is argparse's own resolution and is visible immediately -
    the manifest lands somewhere unexpected rather than the domain shrinking
    silently.
    """
    stream = tmp_path / "events.json"
    stream.write_text("\n".join(green_stream("TestA")) + "\n", encoding="utf-8")
    destination = tmp_path / "explicitly-short-flagged.json"

    exit_code = main(
        [
            "--event-stream",
            str(stream),
            "--packages",
            "synthetic/pkg",
            "-o",
            str(destination),
            "--no-include-non-go-baseline",
        ]
    )

    assert exit_code == 0
    assert destination.is_file()


def test_the_environment_variable_is_screened_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """``KUBE_PARITY_ARGS`` reaches the same allow-list as argv.

    A screen that covered only the command line would be bypassed by the variable the
    runner itself reads.
    """
    monkeypatch.setenv("KUBE_PARITY_ARGS", "-run=TestOnlyThisOne")

    exit_code = main(
        ["--output", str(tmp_path / "b.json"), "--packages", "synthetic/pkg"]
    )

    assert exit_code != 0
    assert "refusing the oracle argument '-run=TestOnlyThisOne'" in capsys.readouterr().err


def test_the_cli_builds_a_baseline_from_a_captured_stream(tmp_path: Path) -> None:
    """End to end through the stream route, which is the shape a spec can run offline.

    ``-timeout=30m`` rides along to prove the allow-list forwards as well as refuses;
    a suite that only ever asserted refusals would pass with everything refused.
    """
    stream = tmp_path / "events.json"
    stream.write_text("\n".join(green_stream("TestA", "TestB")) + "\n", encoding="utf-8")
    destination = tmp_path / "go_baseline.json"

    exit_code = main(
        [
            "--event-stream",
            str(stream),
            "--packages",
            "synthetic/pkg",
            "--output",
            str(destination),
            "--no-include-non-go-baseline",
            "--",
            "-timeout=30m",
        ]
    )

    assert exit_code == 0
    written = json.loads(destination.read_text(encoding="utf-8"))
    validate_manifest(written)
    assert written["counts"]["total"] == 2
    assert written["provenance"] == PROVENANCE_GO_TEST_JSON

    # AND --check REFUSES IT, because it is narrow. This is the distinction the
    # review found missing: `validate_manifest` above answers "is this a well-formed
    # manifest?" and says yes, while --check answers "is this the committed parity
    # baseline?" and must say no. A two-row synthetic manifest is internally perfect
    # and asserts nothing about the 3,104 Go verdicts it omits, and a gate that
    # accepted it would report green on a deleted baseline.
    assert main(["--check", "--output", str(destination)]) != 0


def test_the_cli_refuses_a_stream_that_yields_no_verdicts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The end-to-end form of obligation 1, including the default-on non-Go row."""
    stream = tmp_path / "events.json"
    stream.write_text(package_line() + "\n", encoding="utf-8")
    destination = tmp_path / "go_baseline.json"

    exit_code = main(
        ["--event-stream", str(stream), "--output", str(destination), "--packages", "synthetic/pkg"]
    )

    assert exit_code != 0
    assert "ZERO verdicts" in capsys.readouterr().err
    assert not destination.exists()


def test_the_cli_refuses_a_duplicated_manifest_on_check(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``--check`` is the gate a change's committed artifact actually passes through."""
    destination = tmp_path / "go_baseline.json"
    destination.write_text(json.dumps(with_duplicated_row(clean_manifest())), encoding="utf-8")

    exit_code = main(["--check", "--output", str(destination)])

    assert exit_code != 0
    assert "duplicated (package, test, subtest)" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# 8. The measured cardinality guards
# ---------------------------------------------------------------------------


#: The cardinality of EVERY package in the measured scope, pinned independently of
#: the generator's own copy so that editing one without re-measuring fails a test
#: rather than merely changing a constant. Measured by reducing a real
#: `go test -json -count=1 -p 1` stream over all eight Go packages together:
#: 3,104 Go verdicts, 79 top-level and 3,025 subtests, 3,079 pass and 25 skip.
MEASURED_CARDINALITY: Final[dict[str, tuple[int, int, int]]] = {
    "cluster/gce/gci": (648, 8, 640),
    "test/integration/auth": (2179, 43, 2136),
    "test/integration/secrets": (2, 2, 0),
    "test/integration/controlplane/audit": (12, 2, 10),
    "plugin/pkg/auth/authorizer/rbac": (3, 3, 0),
    "plugin/pkg/auth/authorizer/rbac/bootstrappolicy": (15, 15, 0),
    "plugin/pkg/admission/security/podsecurity": (1, 1, 0),
    "plugin/pkg/admission/noderestriction": (244, 5, 239),
}


@pytest.mark.parametrize(
    ("package", "expected"),
    sorted(MEASURED_CARDINALITY.items()),
    ids=sorted(MEASURED_CARDINALITY),
)
def test_the_measured_cardinality_guards_are_the_measured_numbers(
    package: str, expected: tuple[int, int, int]
) -> None:
    """EVERY package in the scope is pinned to its measured total, top-level and subtests.

    AAP §0.7.1.2 fixes the acceptance signal as one-to-one parity against this
    baseline, and the baseline can only carry that weight if it is COMPLETE. It was
    not: `test/integration/auth` was pinned on `top_level` alone and its 2,136
    subtests were absent from the manifest entirely, as were noderestriction's 239.
    A missing subtest is the worst gap available here, because the contract's
    completeness assertion walks the baseline - an identity that is not IN it is
    never required of the ported suite, and its absence is indistinguishable from a
    behaviour that never existed.

    So every package is pinned, on all three numbers, and internal consistency is
    read off the object rather than off the literals: a future edit that changes one
    pin without the others fails here instead of producing a guard whose three
    numbers cannot all be true at once.
    """
    total, top_level, subtests = expected
    guard = PACKAGE_EXPECTATIONS[f"{GO_MODULE_PATH}/{package}"]

    assert guard.total == total, (
        f"{package}: total pinned at {guard.total}, measured {total}"
    )
    assert guard.top_level == top_level, (
        f"{package}: top_level pinned at {guard.top_level}, measured {top_level}"
    )
    assert guard.subtests == subtests, (
        f"{package}: subtests pinned at {guard.subtests}, measured {subtests}"
    )
    assert guard.total == guard.top_level + guard.subtests, (
        f"{package}: the guard is internally inconsistent - "
        f"{guard.total} != {guard.top_level} + {guard.subtests}"
    )
    assert guard.note, (
        f"{package}: the guard carries no note, so a reader cannot re-measure it and would "
        f"have to take the number on trust."
    )


def test_every_package_in_the_scope_carries_a_cardinality_guard() -> None:
    """No package may be left UNPINNED - an unpinned package is where the gap was.

    The two directions are asserted separately because they fail for different
    reasons. A package in the default scope with no guard can lose verdicts silently,
    which is exactly how `test/integration/auth` came to be recorded as 43 rows when
    it emits 2,179. A guard for a package NOT in the scope is dead weight that will
    never fire, and reads to the next person as though something is protected when
    nothing is.
    """
    scope = {spec.removeprefix("./").rstrip("/") for spec in DEFAULT_PACKAGES}
    # The declared non-Go pseudo-package is guarded too - the one Python row is
    # produced identically in both modes and must not be droppable - but it is
    # deliberately absent from DEFAULT_PACKAGES, which is a `go test` package list and
    # nothing else. Comparing it against the Go scope would fail for the wrong reason.
    guarded = {
        key.removeprefix(f"{GO_MODULE_PATH}/")
        for key in PACKAGE_EXPECTATIONS
        if not is_non_go_package(key)
    }
    assert NON_GO_BASELINE_PACKAGE in PACKAGE_EXPECTATIONS, (
        "the non-Go baseline row must carry a cardinality guard of its own, or the one "
        "Python case in the baseline scale could be dropped without failing anything."
    )

    assert scope == guarded, (
        f"the default package scope and the cardinality guards disagree.\n"
        f"  in the scope with NO guard (can lose verdicts silently): {sorted(scope - guarded)}\n"
        f"  guarded but NOT in the scope (a guard that can never fire): "
        f"{sorted(guarded - scope)}"
    )
    assert scope == set(MEASURED_CARDINALITY), (
        f"this module's MEASURED_CARDINALITY table and the default package scope disagree: "
        f"missing {sorted(scope - set(MEASURED_CARDINALITY))}, extra "
        f"{sorted(set(MEASURED_CARDINALITY) - scope)}"
    )


def test_a_short_package_is_refused_by_its_guard() -> None:
    """A shortfall means verdicts were LOST, and recording it would shrink the gate."""
    verdicts = [
        Verdict(package=PKG, test=f"Test{index}", subtest="", action="pass", elapsed=0.0)
        for index in range(3)
    ]

    with pytest.raises(BaselineError, match="cardinality guard violated") as raised:
        build_manifest(
            verdicts,
            provenance=PROVENANCE_GO_TEST_JSON,
            expectations={PKG: PackageExpectation(total=648, note="synthetic")},
        )

    assert "total is 3, expected 648" in str(raised.value)


def test_a_non_green_verdict_is_refused_by_default() -> None:
    """The measured baseline is 100 percent pass with zero failures and zero skips."""
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestB", subtest="", action="fail", elapsed=0.0),
    ]

    with pytest.raises(BaselineError):
        build_manifest(verdicts, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS)


# ---------------------------------------------------------------------------
# 9. The bounded-execution contract (finding F)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("0", 0.0),
        ("30m", 1800.0),
        ("1h30m", 5400.0),
        ("2h", 7200.0),
        ("90s", 90.0),
        ("500ms", 0.5),
        ("banana", None),
        ("", None),
        ("30", None),
        ("30x", None),
    ],
    ids=[
        "unit-less-zero",
        "minutes",
        "compound",
        "hours",
        "seconds",
        "milliseconds",
        "not-a-duration",
        "empty",
        "unit-less-non-zero",
        "unknown-unit",
    ],
)
def test_go_durations_are_parsed_the_way_the_toolchain_parses_them(
    text: str, expected: float | None
) -> None:
    """``-timeout`` must be understood before an outer deadline is derived from it.

    ``None`` is a REFUSAL signal rather than a default, and the distinction matters
    most for ``30`` and ``30x``: Go's ``time.ParseDuration`` rejects a unit-less
    non-zero value and an unknown unit, so accepting either here would compute an
    outer deadline from a value the toolchain is about to reject. ``0`` is parsed
    successfully and returns ``0.0`` on purpose - it is a valid Go duration meaning
    NO TIMEOUT, so it must be recognised in order to be refused rather than treated
    as unparsable noise.
    """
    assert parse_go_duration(text) == expected


@pytest.mark.parametrize(
    "arguments",
    [
        ["-timeout=0"],
        ["-timeout", "0"],
        ["-timeout=-5m"],
        ["-timeout", "-5m"],
        ["-timeout=banana"],
        ["-timeout", "banana"],
    ],
    ids=[
        "zero-joined",
        "zero-separated",
        "negative-joined",
        "negative-separated",
        "unparsable-joined",
        "unparsable-separated",
    ],
)
def test_an_unbounded_or_unparsable_timeout_is_refused(arguments: list[str]) -> None:
    """``-timeout 0`` means NO TIMEOUT in Go, which is the value that must never pass.

    A wedged test binary under ``-timeout 0`` holds the capture pipe open for as long
    as the process lives: in CI that is a job that burns its whole wall-clock
    allowance and reports nothing at all. Both of Go's spellings are asserted,
    because the joined and separated forms travel through different branches and a
    check that covered only one had a one-token bypass.
    """
    with pytest.raises(BaselineError, match="refusing the oracle argument"):
        _resolve_extra_go_args(arguments)


def test_a_missing_timeout_is_injected_and_the_outer_deadline_exceeds_it() -> None:
    """No ``-timeout`` means a BOUND IS ADDED, and the outer deadline is strictly larger.

    Not merely "unbounded is bad": ``go test`` applies a 10-minute PER-PACKAGE
    default, which the integration packages legitimately exceed, so a run with no
    ``-timeout`` is bounded WRONGLY rather than not at all - it fails a healthy
    oracle. Injecting an explicit value puts the bound in the logged command instead
    of leaving it implicit in the toolchain.

    The two bounds must not be equal. Go's own timeout produces a panic with a
    goroutine dump, which is far more useful than a killed process, so the outer
    deadline exists only for the hangs the inner one cannot catch - a toolchain
    wedged while building, or a child still holding the pipe after its binary died.
    """
    arguments, outer = _timeout_budget(())

    assert arguments[0] == f"-timeout={GO_TEST_DEFAULT_TIMEOUT}", (
        f"expected an injected -timeout as the FIRST argument so it appears in the logged "
        f"command; got {arguments!r}"
    )
    inner = parse_go_duration(GO_TEST_DEFAULT_TIMEOUT)
    assert inner is not None
    assert outer == inner + OUTER_TIMEOUT_MARGIN_SECONDS
    assert outer > inner, (
        "the outer deadline must be strictly larger than the Go-side timeout, or it would "
        "pre-empt the goroutine dump that makes a hang diagnosable"
    )


@pytest.mark.parametrize(
    ("arguments", "expected_inner"),
    [(["-timeout=30m"], 1800.0), (["-timeout", "45m"], 2700.0)],
    ids=["joined", "separated"],
)
def test_a_supplied_timeout_is_respected_in_both_spellings(
    arguments: list[str], expected_inner: float
) -> None:
    """A caller's own bound is honoured, and the margin is added to whichever spelling."""
    resolved, outer = _timeout_budget(tuple(arguments))

    assert resolved == tuple(arguments), "a supplied -timeout must not be rewritten"
    assert outer == expected_inner + OUTER_TIMEOUT_MARGIN_SECONDS


def test_a_timed_out_child_takes_its_whole_process_group_with_it() -> None:
    """A timeout kills the GROUP, so no orphan survives holding a port or the pipe.

    ``go test`` is a supervisor: it execs one test binary per package, and the
    integration packages start a real etcd of their own. Killing only the ``go``
    process leaves every descendant running - still holding the capture pipe, its
    data directory and its port, so the NEXT run fails for a reason that has nothing
    to do with the code.

    The tree here is deliberately the same shape: a parent that spawns a grandchild
    which outlives it. Both must be gone, and both must have STOPPED WRITING - a
    process that merely reparented would still be producing output.
    """
    marker = None
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix="blitzy-pgroup-") as scratch:
            marker = Path(scratch) / "alive"
            script = (
                f"( while true; do echo x >> {marker}.child; sleep 0.05; done ) & "
                f"while true; do echo x >> {marker}.parent; sleep 0.05; done"
            )
            process = subprocess.Popen(
                ["bash", "-c", script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                start_new_session=True,
            )
            group = os.getpgid(process.pid)
            time.sleep(0.5)

            members_before = _process_group_members(group)
            assert len(members_before) >= 2, (
                f"the probe did not build a multi-process group (found {members_before}), so it "
                f"would not prove anything about killing one"
            )

            _terminate_process_group(process)
            time.sleep(0.5)

            assert _process_group_members(group) == [], (
                f"process group {group} still has members after termination: "
                f"{_process_group_members(group)}. An orphaned test binary or etcd holds ports "
                f"and temporary directories that the next run needs."
            )

            first = _marker_sizes(marker)
            time.sleep(0.4)
            assert _marker_sizes(marker) == first, (
                "a descendant is still writing after the group was terminated, so it survived "
                "rather than merely being reparented"
            )

            # Idempotent: this runs while an exception is already propagating, so a
            # second call - or a call on an already-reaped process - must not raise
            # and replace the timeout the caller needs to see.
            _terminate_process_group(process)
    finally:
        if process is not None and process.poll() is None:  # pragma: no cover - safety net
            process.kill()


def _process_group_members(group: int) -> list[str]:
    """PIDs currently in ``group``, via ``ps``, or ``[]`` when the group is gone."""
    completed = subprocess.run(
        ["ps", "-o", "pid=", "-g", str(group)],
        capture_output=True,
        text=True,
        check=False,
    )
    return completed.stdout.split()


def _marker_sizes(marker: Path) -> tuple[int, int]:
    """Byte sizes of the parent and child marker files, zero when absent."""
    return tuple(  # type: ignore[return-value]
        path.stat().st_size if path.exists() else 0
        for path in (Path(f"{marker}.parent"), Path(f"{marker}.child"))
    )


# ---------------------------------------------------------------------------
# 10. The vendor-mode contract (finding G)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "goflags",
    ["-mod=mod", "-mod mod", "-mod=readonly", "-mod readonly", "-trimpath -mod=mod", "-x -mod"],
    ids=[
        "joined-mod",
        "separated-mod",
        "joined-readonly",
        "separated-readonly",
        "joined-after-other-flags",
        "bare-mod-with-no-value",
    ],
)
def test_an_inherited_goflags_requesting_a_non_vendor_mode_is_refused(goflags: str) -> None:
    """AAP §0.9.4.2 and §0.8.2: the oracle compiles the VENDORED tree or it does not run.

    The previous check asked only whether the substring ``-mod=`` appeared and, if it
    did, left the value alone - so an inherited ``GOFLAGS=-mod=mod`` satisfied it and
    was handed straight to the toolchain, which is the exact inversion of the freeze
    it was meant to enforce. The separated ``-mod mod`` spelling bypassed it
    completely, since the substring never appeared.

    Refused rather than silently rewritten: a caller who set ``-mod=mod`` wanted
    something this artifact must not produce, and quietly substituting vendor mode
    would hide the conflict from the person best placed to resolve it.
    """
    with pytest.raises(
        BaselineError, match=r"refusing (the inherited GOFLAGS entry|the oracle argument)"
    ):
        _oracle_environment({"GOFLAGS": goflags})


@pytest.mark.parametrize(
    ("goflags", "expected"),
    [
        ("", "-mod=vendor"),
        ("-mod=vendor", "-mod=vendor"),
        # Vendor mode already present but NOT the last token, which is where an
        # append-if-missing check that only looked at the tail would add a second copy.
        ("-mod=vendor -v=true", "-mod=vendor -v=true"),
        ("-v=true", "-v=true -mod=vendor"),
        ("-v=true -mod=vendor -race=true", "-v=true -mod=vendor -race=true"),
    ],
    # No "already-separated" case, and its absence is deliberate: `-mod vendor` in
    # GOFLAGS is REFUSED rather than accepted, because Go requires each GOFLAGS entry
    # to be one self-contained argument. That spelling is covered as a refusal by
    # test_an_inherited_goflags_requesting_a_non_vendor_mode_is_refused and by
    # test_a_separated_flag_value_is_screened_like_a_joined_one, so asserting it here
    # as an accepted form would contradict them.
    ids=["absent", "already-joined", "already-present-not-last", "unrelated-flags", "mixed"],
)
def test_vendor_mode_is_guaranteed_exactly_once_and_other_flags_survive(
    goflags: str, expected: str
) -> None:
    """The child env ends with exactly one ``-mod=vendor``, and nothing else is lost.

    Two properties at once, because either alone is insufficient. Exactly one
    canonical declaration means the toolchain cannot be handed a contradictory pair.
    Preserving the caller's other flags means this corrects the freeze without
    discarding whatever the runner or CI deliberately set - clobbering ``GOFLAGS``
    wholesale would be a different bug with the same appearance of safety.
    """
    resolved = _oracle_environment({"GOFLAGS": goflags} if goflags else {})["GOFLAGS"]

    assert resolved == expected
    assert resolved.split().count("-mod=vendor") == 1, (
        f"expected exactly one -mod=vendor in {resolved!r}; a duplicated or contradictory pair "
        f"leaves which mode wins up to the toolchain's argument order"
    )


@pytest.mark.parametrize(
    "arguments",
    [["-mod=mod"], ["-mod", "mod"], ["-mod=readonly"], ["-mod", "readonly"]],
    ids=["joined-mod", "separated-mod", "joined-readonly", "separated-readonly"],
)
def test_a_forwarded_non_vendor_mod_is_refused_in_both_spellings(
    arguments: list[str],
) -> None:
    """The separated ``-mod mod`` form was the bypass, and is now checked as strictly.

    The value in ``-mod mod`` arrives as its own token and never reaches the ``=``
    branch, so a check written only against ``-mod=...`` refused the joined spelling
    and forwarded the separated one to the toolchain untouched.
    """
    with pytest.raises(BaselineError, match="refusing the oracle argument"):
        _resolve_extra_go_args(arguments)


def test_a_forwarded_vendor_mod_is_accepted_in_both_spellings() -> None:
    """The CONTROL: the permitted value passes, so the guard is not simply refusing ``-mod``."""
    # `-timeout` is injected when the caller forwards none, so the permitted value is
    # asserted as a PREFIX of the resolved arguments rather than as the whole of them.
    assert _resolve_extra_go_args(["-mod=vendor"])[:1] == ("-mod=vendor",)
    assert _resolve_extra_go_args(["-mod", "vendor"])[:2] == ("-mod", "vendor")


# ---------------------------------------------------------------------------
# 11. The skip contract (finding S)
# ---------------------------------------------------------------------------


def test_a_failing_verdict_is_refused_and_no_flag_overrides_it() -> None:
    """A recorded failure becomes a REQUIRED failure, so there is deliberately no override.

    If the baseline recorded a ``fail``, the contract's verdict-equality assertion
    would require the ported suite to fail the same test - the gate would defend the
    regression instead of catching it. ``--allow-non-green`` governs skips only, and
    this asserts that it does NOT extend to failures, which is the whole reason the
    two checks were separated.
    """
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestB", subtest="", action="fail", elapsed=0.0),
    ]

    for allow in (False, True):
        with pytest.raises(BaselineError, match="contains a FAILURE"):
            build_manifest(
                verdicts,
                provenance=PROVENANCE_GO_TEST_JSON,
                allow_non_green=allow,
                expectations=NO_GUARDS,
            )


def test_a_skip_is_always_held_to_the_exact_roster() -> None:
    """A skip is a measured FACT (AAP §0.10.3), recorded verbatim and then pinned.

    Three properties, in the order a caller meets them:

    1. a skip outside the known package or family is refused on EVERY route,
       including with ``--allow-non-green`` - "recorded" must never degrade into
       "unexamined", because a new skip is a test that stopped being exercised and
       that looks exactly like a green run;
    2. the COUNT is exact by default, because a roster that only checked the family
       would let one test start skipping while another stopped and see nothing. A
       single known-family skip is therefore refused without the flag;
    3. and ``--allow-non-green`` waives THE COUNT ONLY, for the ad-hoc regeneration
       of a narrower scope than the one the count describes - as does narrowing the
       cardinality guards, since a caller who supplies its own expectations is by
       definition not running the scope the count describes. Neither waives the family
       check above, and neither reaches a failure.

    WHY THE FLAG IS A WAIVER RATHER THAN AN ENABLER. Skips are recorded without any
    flag, because the measured oracle genuinely skips 25 subtests and requiring a
    flag for the honest regeneration is what previously coupled skip tolerance to
    the failure guard - the practical effect of that coupling was a weaker gate, not
    a stricter one. The roster instead runs on the default route, which is the route
    the committed artifact is actually produced by.
    """
    unknown_skip = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestB", subtest="", action="skip", elapsed=0.0),
    ]

    for allow in (False, True):
        with pytest.raises(BaselineError, match="UNRECOGNISED skip"):
            build_manifest(
                unknown_skip,
                provenance=PROVENANCE_GO_TEST_JSON,
                allow_non_green=allow,
                expectations=NO_GUARDS,
            )

    # The right family and package, but the wrong COUNT.
    one_known_skip = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(
            package=EXPECTED_SKIP_PACKAGE,
            test="TestPodSecurity",
            subtest=f"case_fail_{EXPECTED_SKIP_MARKER}",
            action="skip",
            elapsed=0.0,
        ),
    ]
    with pytest.raises(BaselineError, match=f"has exactly {EXPECTED_SKIP_COUNT}"):
        # No `expectations` override: the count is asserted for a run of the DEFAULT
        # measured scope, which is the route the committed artifact is produced by.
        build_manifest(one_known_skip, provenance=PROVENANCE_GO_TEST_JSON)

    # ...and the waiver records it verbatim rather than refusing it.
    manifest = build_manifest(
        one_known_skip,
        provenance=PROVENANCE_GO_TEST_JSON,
        allow_non_green=True,
        expectations=NO_GUARDS,
    )
    assert counts_of(manifest)["skip"] == 1


def test_the_committed_baseline_records_the_measured_scale(repo_root: Path) -> None:
    """THE ARTIFACT ITSELF: 3,105 verdicts, every subtest present, 25 skips named.

    The committed manifest is what the parity contract actually reads, so its shape
    is asserted directly rather than inferred from the generator that produced it.
    Before this was fixed it held 722 rows: `test/integration/auth` contributed 43
    top-level identities and NONE of its 2,136 subtests, and noderestriction none of
    its 239. The contract's completeness assertion is quantified over the recorded
    rows, so those 2,383 missing identities were never required of the ported suite
    at all - a gap that reads, from the outside, exactly like a passing gate.

    Also asserted: the recorded skips are the measured ones. A baseline that recorded
    zero skips while the oracle skips 25 would require the ported suite to RUN tests
    that cannot pass, which is the mirror image of the same problem.
    """
    manifest = json.loads(
        (repo_root / "python/tests/parity/baseline/go_baseline.json").read_text(
            encoding="utf-8"
        )
    )
    validate_manifest(manifest)

    counts = manifest["counts"]
    assert counts["fail"] == 0, (
        f"the committed baseline records {counts['fail']} failing verdict(s); a recorded "
        f"failure becomes a required failure."
    )
    assert counts["skip"] == EXPECTED_SKIP_COUNT, (
        f"the committed baseline records {counts['skip']} skip(s), measured "
        f"{EXPECTED_SKIP_COUNT}."
    )
    assert counts["total"] == counts["pass"] + counts["skip"]

    for package, expected in sorted(MEASURED_CARDINALITY.items()):
        bucket = counts["by_package"][f"{GO_MODULE_PATH}/{package}"]
        total, top_level, subtests = expected
        assert (bucket["total"], bucket["top_level"], bucket["subtests"]) == expected, (
            f"the committed baseline records {package} as "
            f"{bucket['total']}={bucket['top_level']}t+{bucket['subtests']}s; measured "
            f"{total}={top_level}t+{subtests}s. A missing subtest is never required of the "
            f"ported suite, because the contract's completeness assertion walks these rows."
        )

    skips = [row for row in manifest["verdicts"] if row["action"] == "skip"]
    assert {row["package"] for row in skips} == {EXPECTED_SKIP_PACKAGE}
    assert all(
        EXPECTED_SKIP_MARKER in (row["subtest"] or row["test"]) for row in skips
    ), (
        f"every measured skip is a {EXPECTED_SKIP_MARKER!r} feature-gate case; a skip outside "
        f"that family is a test that stopped being exercised."
    )


# ---------------------------------------------------------------------------
# 12. The non-Go baseline is MEASURED, not asserted (finding Y)
# ---------------------------------------------------------------------------


def _junit(body: str) -> str:
    """Wrap ``body`` in the two-level document pytest actually emits.

    The generator reads the report with ``iter("testcase")``, so the nesting has
    to match what pytest writes rather than the flatter shape some other runners
    produce - otherwise these tests would pass against a document the real parser
    would never see.
    """
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<testsuites>\n"
        '<testsuite name="pytest" errors="0" failures="0" skipped="0" tests="1">\n'
        f"{body}\n"
        "</testsuite>\n"
        "</testsuites>\n"
    )


def _case(*, classname: str = NON_GO_BASELINE_CLASSNAME, name: str = NON_GO_BASELINE_TEST,
          time_attr: str = "0.004", child: str = "") -> str:
    """One ``<testcase>`` element, with an optional outcome child."""
    return f'<testcase classname="{classname}" name="{name}" time="{time_attr}">{child}</testcase>'


def test_the_non_go_baseline_row_is_measured_by_running_the_case() -> None:
    # INVARIANT LOCKED (finding Y): the boilerplate row records what the test
    # ACTUALLY did. It used to be a hard-coded `action="pass", elapsed=None`, which
    # was a claim rather than a measurement - and the case it named was outside
    # pytest collection, so nothing could contradict it. A scanner or fixture
    # regression then left both the suite AND the baseline green.
    verdict = _non_go_baseline_verdict()

    assert verdict.package == NON_GO_BASELINE_PACKAGE
    assert verdict.test == NON_GO_BASELINE_TEST
    assert verdict.subtest == ""
    assert verdict.action == "pass", (
        f"the shipped {NON_GO_BASELINE_RELATIVE_PATH} did not pass when measured; it "
        f"reported {verdict.action!r}. That is a real regression in the licence-header "
        f"gate, not a baseline to regenerate"
    )
    # The distinguishing property: a hard-coded row cannot produce a duration.
    assert verdict.elapsed is not None, (
        "elapsed is None, so this row was not measured. The whole point of finding Y's "
        "fix is that the verdict comes from a real pytest run's JUnit `time` attribute"
    )
    assert verdict.elapsed >= 0.0


def test_a_missing_non_go_case_aborts_instead_of_assuming_a_pass(tmp_path: Path) -> None:
    # INVARIANT LOCKED: absence is never evidence of success. Pointed at a root
    # where the case does not exist, the generator must refuse rather than fall
    # back to the old confident `pass`.
    with pytest.raises(BaselineError) as excinfo:
        _non_go_baseline_verdict(tmp_path)

    message = str(excinfo.value)
    assert NON_GO_BASELINE_RELATIVE_PATH in message
    assert "missing" in message


@pytest.mark.parametrize(
    ("child", "expected"),
    [
        ("", "pass"),
        ('<failure message="boom">assert 1 == 2</failure>', "fail"),
        ('<error message="collection error">ImportError</error>', "fail"),
        ('<skipped message="no fixtures">skipped</skipped>', "skip"),
    ],
    ids=["no-child-is-pass", "failure-is-fail", "error-is-fail", "skipped-is-skip"],
)
def test_every_junit_outcome_maps_to_the_action_it_means(
    tmp_path: Path, child: str, expected: str
) -> None:
    # INVARIANT LOCKED: the outcome vocabulary is complete and each member maps to
    # the action that is TRUE of it. Collapsing `error` into anything but a failure,
    # or treating a `skipped` case as a pass, would let the manifest assert a
    # verdict the run did not produce.
    report = tmp_path / "report.xml"
    report.write_text(_junit(_case(child=child)), encoding="utf-8")

    verdict = _parse_non_go_junit(report, returncode=0)

    assert verdict.action == expected
    assert verdict.package == NON_GO_BASELINE_PACKAGE
    assert verdict.test == NON_GO_BASELINE_TEST


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ("", "found 0"),
        (f"{_case()}\n{_case()}", "found 2"),
    ],
    ids=["zero-testcases", "two-testcases"],
)
def test_a_report_without_exactly_one_case_aborts(
    tmp_path: Path, body: str, fragment: str
) -> None:
    # INVARIANT LOCKED: the row describes ONE case. Zero means the case failed to
    # collect - the exact failure mode finding Y is about - and more than one means
    # it was renamed or parametrized. Reducing either to a single confident row
    # would misrepresent the run.
    report = tmp_path / "report.xml"
    report.write_text(_junit(body), encoding="utf-8")

    with pytest.raises(BaselineError, match=fragment):
        _parse_non_go_junit(report, returncode=0)


def test_a_report_describing_a_different_test_aborts(tmp_path: Path) -> None:
    # INVARIANT LOCKED: identity is asserted, not assumed. Measuring some other
    # test and filing the result under this row would make the parity contract
    # compare unrelated things - and it would do so silently.
    report = tmp_path / "report.xml"
    report.write_text(
        _junit(_case(classname="some.other.module", name="test_something_else")),
        encoding="utf-8",
    )

    with pytest.raises(BaselineError) as excinfo:
        _parse_non_go_junit(report, returncode=0)

    message = str(excinfo.value)
    assert "some.other.module" in message
    assert NON_GO_BASELINE_CLASSNAME in message


def test_malformed_xml_aborts_rather_than_reporting_a_pass(tmp_path: Path) -> None:
    # INVARIANT LOCKED: an unparsable report is not evidence of a passing test.
    report = tmp_path / "report.xml"
    report.write_text("<testsuites><testsuite>truncated", encoding="utf-8")

    with pytest.raises(BaselineError, match="well-formed"):
        _parse_non_go_junit(report, returncode=0)


def test_an_unparsable_time_becomes_none_rather_than_a_fabricated_number(
    tmp_path: Path,
) -> None:
    # INVARIANT LOCKED: where there is no measurement, None is recorded. Inventing
    # a duration would misrepresent where the number came from, which is the same
    # standard the Go reducer applies to an event carrying no Elapsed.
    report = tmp_path / "report.xml"
    report.write_text(_junit(_case(time_attr="not-a-number")), encoding="utf-8")

    verdict = _parse_non_go_junit(report, returncode=0)

    assert verdict.action == "pass"
    assert verdict.elapsed is None


def test_the_committed_baseline_carries_a_measured_boilerplate_row(
    repo_root: Path,
) -> None:
    # INVARIANT LOCKED: the artifact on disk reflects the measurement, so a reader
    # of the committed manifest can tell that the row was produced by running the
    # case. A null elapsed here means the manifest was generated by the old
    # hard-coding path and must be regenerated.
    manifest = json.loads(
        (repo_root / "python/tests/parity/baseline/go_baseline.json").read_text(
            encoding="utf-8"
        )
    )
    rows = [
        row for row in manifest["verdicts"] if row["package"] == NON_GO_BASELINE_PACKAGE
    ]

    assert len(rows) == 1, (
        f"expected exactly one {NON_GO_BASELINE_PACKAGE} row in the committed "
        f"baseline, found {len(rows)}"
    )
    row = rows[0]
    assert row["test"] == NON_GO_BASELINE_TEST
    assert row["action"] == "pass"
    assert row["elapsed"] is not None, (
        "the committed baseline's boilerplate row has a null elapsed, so it was "
        "written by the pre-finding-Y hard-coded path. Regenerate the baseline"
    )


# ---------------------------------------------------------------------------
# 14. Per-family cardinality, provenance honesty and skip retention
#
# The guards that close the remaining half of the parity-integrity finding: a
# package total cannot see a whole subtest FAMILY vanish, and an envelope that
# claims every row came from Go is false the moment a non-Go row is appended.
# ---------------------------------------------------------------------------

def counts_of(manifest: dict[str, Any]) -> dict[str, Any]:
    """The manifest's ``counts`` mapping, typed for indexing.

    `build_manifest` is annotated ``dict[str, object]`` because its VALUES genuinely
    differ in type; narrowing here keeps the assertions readable without weakening
    that annotation or reaching for a `type: ignore`.
    """
    counts = manifest["counts"]
    assert isinstance(counts, dict)
    return counts


def rows_of(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """The manifest's ``verdicts`` rows, typed for indexing."""
    rows = manifest["verdicts"]
    assert isinstance(rows, list)
    return rows


def test_the_cardinality_guards_are_complete_and_internally_consistent() -> None:
    """Every guard declares all three totals AND an exhaustive per-family split.

    Complementary to :func:`test_the_measured_cardinality_guards_are_the_measured_numbers`,
    which pins each package's three numbers one package at a time. This asserts the
    properties of the TABLE: that it covers exactly the expected package set, that
    every entry declares all four fields and a note, that each entry's three totals
    agree with each other and with the sum of its families, and that no family is
    declared twice. It is the check that fails if a future edit re-measures one
    number and forgets the rest - the state the manifest was actually found in.
    """
    shell = PACKAGE_EXPECTATIONS[f"{GO_MODULE_PATH}/cluster/gce/gci"]
    assert shell.total == 648
    assert shell.top_level == 8
    assert shell.subtests == 640
    # Internal consistency as well as individual correctness. Read off the object
    # rather than off the literals above, so a future edit that changes one pin
    # without the others fails here instead of producing a guard whose three numbers
    # cannot all be true at once.
    assert shell.top_level is not None
    assert shell.subtests is not None
    assert shell.total == shell.top_level + shell.subtests

    auth = PACKAGE_EXPECTATIONS[f"{GO_MODULE_PATH}/test/integration/auth"]
    assert auth.total == 2179
    assert auth.top_level == 43
    assert auth.subtests == 2136

    # EVERY covered package declares all three totals AND an exhaustive per-family
    # split, and each package's three totals agree with each other and with the sum
    # of its families. This is the check that fails if a future edit re-measures one
    # number and forgets the rest - the state the manifest was actually found in.
    assert set(PACKAGE_EXPECTATIONS) == {
        f"{GO_MODULE_PATH}/cluster/gce/gci",
        f"{GO_MODULE_PATH}/test/integration/auth",
        f"{GO_MODULE_PATH}/test/integration/secrets",
        f"{GO_MODULE_PATH}/test/integration/controlplane/audit",
        f"{GO_MODULE_PATH}/plugin/pkg/auth/authorizer/rbac",
        f"{GO_MODULE_PATH}/plugin/pkg/auth/authorizer/rbac/bootstrappolicy",
        f"{GO_MODULE_PATH}/plugin/pkg/admission/security/podsecurity",
        f"{GO_MODULE_PATH}/plugin/pkg/admission/noderestriction",
        NON_GO_BASELINE_PACKAGE,
    }
    for package, expectation in PACKAGE_EXPECTATIONS.items():
        assert expectation.total is not None, package
        assert expectation.top_level is not None, package
        assert expectation.subtests is not None, package
        assert expectation.subtest_counts is not None, package
        assert expectation.note, package
        assert expectation.total == expectation.top_level + expectation.subtests, package
        assert len(expectation.subtest_counts) == expectation.top_level, package
        assert (
            sum(count for _, count in expectation.subtest_counts) == expectation.subtests
        ), package
        # Declared once each: a repeated family would make one of the two pairs
        # unreachable and the guard's arithmetic accidental.
        families = [family for family, _ in expectation.subtest_counts]
        assert len(set(families)) == len(families), package

    # The two families the committed manifest was found to be missing entirely.
    audit = PACKAGE_EXPECTATIONS[f"{GO_MODULE_PATH}/test/integration/controlplane/audit"]
    assert dict(audit.subtest_counts or ()) == {
        "TestAudit": 8,
        "TestAuditSensitiveResourceLevels": 2,
    }
    node_restriction = PACKAGE_EXPECTATIONS[
        f"{GO_MODULE_PATH}/plugin/pkg/admission/noderestriction"
    ]
    assert dict(node_restriction.subtest_counts or ())["Test_nodePlugin_Admit"] == 178
    assert dict(auth.subtest_counts or ())["TestNodeRestrictionServiceAccount"] == 5


def test_a_family_that_emitted_nothing_is_refused() -> None:
    """The guard that would have caught the committed manifest's missing subtests.

    A whole matrix vanishing is the failure mode package totals cannot see: with
    only ``total`` declared, dropping ``TestB`` and its subtests merely changes the
    total, which a re-measure would then "correct". The family guard names the
    family instead, so the reader is told WHAT disappeared rather than that a number
    moved.
    """
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestA", subtest="case_one", action="pass", elapsed=0.0),
    ]

    with pytest.raises(BaselineError, match="cardinality guard violated") as raised:
        build_manifest(
            verdicts,
            provenance=PROVENANCE_GO_TEST_JSON,
            expectations={
                PKG: PackageExpectation(
                    subtest_counts=(("TestA", 1), ("TestB", 8)), note="synthetic"
                )
            },
        )

    assert "family 'TestB' emitted NO verdict at all" in str(raised.value)


def test_a_family_short_of_its_declared_subtests_is_refused() -> None:
    """``TestAudit`` recorded as a parent alone: 8 declared, 0 emitted."""
    verdicts = [Verdict(package=PKG, test="TestAudit", subtest="", action="pass", elapsed=0.0)]

    with pytest.raises(BaselineError, match="cardinality guard violated") as raised:
        build_manifest(
            verdicts,
            provenance=PROVENANCE_GO_TEST_JSON,
            expectations={
                PKG: PackageExpectation(subtest_counts=(("TestAudit", 8),), note="synthetic")
            },
        )

    assert "family 'TestAudit' has 0 subtest(s), expected 8" in str(raised.value)


def test_an_undeclared_family_is_refused() -> None:
    """A new test function widens the domain the parity map must cover."""
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestNew", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestNew", subtest="case", action="pass", elapsed=0.0),
    ]

    with pytest.raises(BaselineError, match="cardinality guard violated") as raised:
        build_manifest(
            verdicts,
            provenance=PROVENANCE_GO_TEST_JSON,
            expectations={
                PKG: PackageExpectation(subtest_counts=(("TestA", 0),), note="synthetic")
            },
        )

    assert "family 'TestNew' is present with 1 subtest(s) but is NOT declared" in str(
        raised.value
    )


def test_emitted_count_guards_do_not_apply_to_derived_rows() -> None:
    """Derived mode is a ROSTER, and pinning it to an emitted count would break it.

    ``top_level`` still applies - the roster is knowable from ``^func Test`` - which
    is what keeps derived mode from shrinking unnoticed in the one dimension it can
    be held to.
    """
    roster = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=None),
        Verdict(package=PKG, test="TestB", subtest="", action="pass", elapsed=None),
    ]
    guard = {
        PKG: PackageExpectation(
            total=999,
            top_level=2,
            subtests=997,
            subtest_counts=(("TestA", 900), ("TestB", 97)),
            note="synthetic",
        )
    }

    manifest = build_manifest(roster, provenance=PROVENANCE_DERIVED, expectations=guard)
    assert counts_of(manifest)["total"] == 2

    # The same rows, claimed as measured, are refused - and named.
    with pytest.raises(BaselineError, match="cardinality guard violated") as raised:
        build_manifest(roster, provenance=PROVENANCE_GO_TEST_JSON, expectations=guard)
    assert "total is 2, expected 999" in str(raised.value)

    # And the one dimension derived mode IS held to.
    with pytest.raises(BaselineError, match="top_level is 2, expected 3"):
        build_manifest(
            roster,
            provenance=PROVENANCE_DERIVED,
            expectations={PKG: PackageExpectation(top_level=3, note="synthetic")},
        )


def test_a_recorded_failure_is_refused_by_default() -> None:
    """A recorded `fail` would make the contract REQUIRE that failure forever."""
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(package=PKG, test="TestB", subtest="", action="fail", elapsed=0.0),
    ]

    with pytest.raises(BaselineError, match="contains a FAILURE"):
        build_manifest(verdicts, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS)


def test_a_recorded_skip_is_kept_verbatim_and_announced(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Skip-stays-skip: the measured oracle skips 25 subtests and must keep doing so.

    A skip is RECORDED rather than refused, and it is ANNOUNCED on stderr while being
    recorded. Requiring a flag merely to record one would require it for every honest
    regeneration of the real baseline, and coupling that flag to the failure guard is
    what made the gate weaker rather than stricter - so the two are separate, and this
    asserts the recording half.

    Recorded WITHOUT --allow-non-green on purpose. The exact roster COUNT describes the
    default measured scope, so it is not asserted for this narrowed synthetic stream;
    the roster's FAMILY check is not waived on any route, which is why the skip below is
    a genuine roster member rather than an arbitrary one - see
    :func:`test_a_skip_is_always_held_to_the_exact_roster`.
    """
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(
            package=EXPECTED_SKIP_PACKAGE,
            test="TestPodSecurityGAOnly",
            subtest=f"case_fail_{EXPECTED_SKIP_MARKER}",
            action="skip",
            elapsed=0.0,
        ),
    ]

    manifest = build_manifest(
        verdicts,
        provenance=PROVENANCE_GO_TEST_JSON,
        allow_non_green=True,
        expectations=NO_GUARDS,
    )

    assert counts_of(manifest)["skip"] == 1
    assert counts_of(manifest)["pass"] == 1
    assert {row["action"] for row in rows_of(manifest)} == {"pass", "skip"}
    reported = capsys.readouterr().err
    assert "recording 1 SKIPPED verdict(s) verbatim" in reported
    assert (
        f"SKIP  {EXPECTED_SKIP_PACKAGE} :: TestPodSecurityGAOnly/case_fail_"
        f"{EXPECTED_SKIP_MARKER}" in reported
    )


def test_the_composed_provenance_is_canonical_and_round_trips() -> None:
    """One atom stays plain; several compose in a fixed order, and only that order."""
    assert compose_provenance(PROVENANCE_GO_TEST_JSON) == PROVENANCE_GO_TEST_JSON
    composed = compose_provenance(PROVENANCE_NON_GO_MEASURED, PROVENANCE_GO_TEST_JSON)
    assert composed == f"{PROVENANCE_GO_TEST_JSON}+{PROVENANCE_NON_GO_MEASURED}"
    # Order of arguments cannot change the value: `provenance` must be byte-stable
    # across regenerations or every diff carries a spurious change.
    assert compose_provenance(PROVENANCE_GO_TEST_JSON, PROVENANCE_NON_GO_MEASURED) == composed
    assert compose_provenance(PROVENANCE_GO_TEST_JSON, PROVENANCE_GO_TEST_JSON) == (
        PROVENANCE_GO_TEST_JSON
    )
    assert split_provenance(composed) == (
        PROVENANCE_GO_TEST_JSON,
        PROVENANCE_NON_GO_MEASURED,
    )


@pytest.mark.parametrize(
    ("value", "why"),
    [
        ("", "empty"),
        ("measured", "unknown atom"),
        (f"{PROVENANCE_NON_GO_MEASURED}+{PROVENANCE_GO_TEST_JSON}", "reordered"),
        (f"{PROVENANCE_GO_TEST_JSON}+{PROVENANCE_GO_TEST_JSON}", "repeated"),
        (f" {PROVENANCE_GO_TEST_JSON}", "padded"),
        (f"{PROVENANCE_GO_TEST_JSON}+{PROVENANCE_DERIVED}", "both Go atoms"),
        (None, "not a string"),
    ],
    ids=["empty", "unknown", "reordered", "repeated", "padded", "both-go-atoms", "non-string"],
)
def test_a_non_canonical_provenance_is_refused(value: Any, why: str) -> None:
    """A value that merely LOOKS plausible is refused rather than half-understood."""
    with pytest.raises(BaselineError):
        split_provenance(value)


def test_a_non_go_row_may_not_be_stamped_as_go_output() -> None:
    """THE RECORDED FINDING: the manifest claimed `go_test_json` over a Python row.

    `go test -json` cannot report a Python verdict, so a Go-only provenance is false
    about that row - and invites the reader to believe it about all of them.
    """
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.1),
        Verdict(
            package=NON_GO_BASELINE_PACKAGE,
            test=NON_GO_BASELINE_TEST,
            subtest="",
            action="pass",
            elapsed=None,
        ),
    ]

    with pytest.raises(BaselineError, match="come from a non-Go package") as raised:
        build_manifest(
            verdicts, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS
        )
    assert PROVENANCE_NON_GO_MEASURED in str(raised.value)

    # The same refusal, asserted directly against the helper the builder and the
    # validator both call, so neither call site can be the only thing keeping it.
    with pytest.raises(BaselineError, match="come from a non-Go package"):
        check_provenance_describes_rows(PROVENANCE_GO_TEST_JSON, verdicts)

    # Composed, it is accepted - and the envelope now names both origins.
    manifest = build_manifest(
        verdicts,
        provenance=compose_provenance(
            PROVENANCE_GO_TEST_JSON, PROVENANCE_NON_GO_MEASURED
        ),
        expectations=NO_GUARDS,
    )
    assert manifest["provenance"] == (
        f"{PROVENANCE_GO_TEST_JSON}+{PROVENANCE_NON_GO_MEASURED}"
    )


def test_an_announced_non_go_row_may_not_be_absent() -> None:
    """The mirror image: announced in the envelope, asserted about by nothing."""
    go_only = [Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.1)]

    with pytest.raises(BaselineError, match="no row comes from a non-Go package"):
        build_manifest(
            go_only,
            provenance=compose_provenance(
                PROVENANCE_GO_TEST_JSON, PROVENANCE_NON_GO_MEASURED
            ),
            expectations=NO_GUARDS,
        )


def test_go_rows_must_declare_a_go_atom() -> None:
    """Rows from a Go package were either measured or derived; the manifest says which."""
    verdicts = [
        Verdict(package=PKG, test="TestA", subtest="", action="pass", elapsed=0.1),
        Verdict(
            package=NON_GO_BASELINE_PACKAGE,
            test=NON_GO_BASELINE_TEST,
            subtest="",
            action="pass",
            elapsed=None,
        ),
    ]

    with pytest.raises(BaselineError, match="names no Go atom"):
        build_manifest(
            verdicts,
            provenance=compose_provenance(PROVENANCE_NON_GO_MEASURED),
            expectations=NO_GUARDS,
        )


def test_validate_manifest_rejects_a_hand_edited_provenance() -> None:
    """The read side catches it too: --check never passes through the builder."""
    manifest = clean_manifest()
    manifest["provenance"] = compose_provenance(
        PROVENANCE_GO_TEST_JSON, PROVENANCE_NON_GO_MEASURED
    )

    with pytest.raises(BaselineError, match="no row comes from a non-Go package"):
        validate_manifest(manifest)


def test_an_undeclared_non_import_path_package_is_refused() -> None:
    """A second non-Go tier must be DECLARED, not guessed at from its spelling.

    Without this, an undeclared pseudo-package would be classified as Go and the
    `non_go_measured` atom would go missing from a manifest that needed it - the exact
    defect the atom exists to prevent, reintroduced one tier later.
    """
    assert is_non_go_package(NON_GO_BASELINE_PACKAGE) is True
    assert is_non_go_package(PKG) is False

    with pytest.raises(BaselineError, match="neither a declared non-Go package"):
        is_non_go_package("web/src/hooks")


# ---------------------------------------------------------------------------
# 15. The committed domain, derived-mode containment and argument screening
#
# The guards that keep a DERIVED roster out of the committed artifact, hold that
# artifact to the complete measured domain, and screen every argument source -
# GOFLAGS included - by the same allow-list as the command line.
# ---------------------------------------------------------------------------

def test_a_missing_toolchain_is_reported_rather_than_substituted_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--mode auto` with no Go toolchain FAILS; it does not fall back to derived.

    This is the failure that could have invalidated the whole migration. On any
    machine without Go on PATH - a container, a CI step that forgot to load the
    toolchain - the DEFAULT invocation used to manufacture an all-green baseline from
    source and write it to the committed path, and the parity contract would then
    certify the port against it. Nothing looked wrong: the file was well formed and
    every assertion passed.
    """
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    destination = tmp_path / "go_baseline.json"

    exit_code = main(["--output", str(destination)])

    assert exit_code != 0
    error = capsys.readouterr().err
    assert "no 'go' toolchain on PATH" in error
    assert "nothing to measure" in error
    assert not destination.exists(), "a failed collection must never leave a manifest behind"


def test_derived_mode_requires_an_explicit_acknowledgement(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--mode derived` alone is refused: the caller must say they know what it is."""
    destination = tmp_path / "go_baseline.json"

    exit_code = main(["--mode", "derived", "--output", str(destination)])

    assert exit_code != 0
    assert "--allow-derived-baseline" in capsys.readouterr().err
    assert not destination.exists()


def test_derived_rows_cannot_be_written_to_the_committed_baseline(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Even acknowledged, derived rows may not land at the path the contract reads.

    The check is on the RESOLVED path, so pointing --output at the committed manifest
    by a different spelling does not evade it.
    """
    repo_root = tmp_path / "repo"
    committed = repo_root / "python" / "tests" / "parity" / "baseline" / "go_baseline.json"
    committed.parent.mkdir(parents=True)

    exit_code = main(
        [
            "--mode",
            "derived",
            "--allow-derived-baseline",
            "--repo-root",
            str(repo_root),
            "--output",
            str(committed.parent / "." / "go_baseline.json"),
        ]
    )

    assert exit_code != 0
    error = capsys.readouterr().err
    assert "refusing to write provenance" in error
    assert "COMMITTED baseline" in error
    assert not committed.exists()


def test_check_refuses_a_derived_manifest(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The production check path rejects any provenance but a real oracle run.

    The last barrier, and the one that matters if a derived manifest reaches the
    committed path by some route nobody anticipated - being copied there by hand, for
    instance. `--check` is what a gate runs, so it is where the refusal has to be
    unconditional.
    """
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "provenance": "derived_from_source_inventory",
        "packages": [PKG],
        "counts": {
            "total": 1,
            "pass": 1,
            "fail": 0,
            "skip": 0,
            "by_package": {
                PKG: {
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
            {"package": PKG, "test": "TestA", "subtest": "", "action": "pass", "elapsed": 0.0}
        ],
    }
    destination = tmp_path / "go_baseline.json"
    destination.write_text(json.dumps(manifest), encoding="utf-8")
    # Schema-valid, so only the provenance and domain checks can refuse it.
    validate_manifest(manifest)

    assert main(["--check", "--output", str(destination)]) != 0
    assert "must declare 'go_test_json'" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("arguments", "fragment"),
    [
        (["-mod", "mod"], "requires `-mod=vendor`"),
        (["-mod", "readonly"], "requires `-mod=vendor`"),
        (["-count", "2"], "only `-count=1` is permitted"),
        (["-timeout", "0"], "which in Go means NO TIMEOUT AT ALL"),
        (["-timeout=0"], "which in Go means NO TIMEOUT AT ALL"),
        (["-timeout=0s"], "which in Go means NO TIMEOUT AT ALL"),
        (["-timeout=-5m"], "is negative"),
        (["-timeout=forever"], "is not a Go duration"),
        (["-p", "0"], "must be a positive integer"),
        (["-parallel=0"], "must be a positive integer"),
        (["-v=yes"], "is a boolean flag"),
    ],
    ids=[
        "separated-mod-mod",
        "separated-mod-readonly",
        "separated-count-2",
        "separated-timeout-0",
        "attached-timeout-0",
        "attached-timeout-0s",
        "attached-timeout-negative",
        "attached-timeout-unparsable",
        "separated-p-0",
        "attached-parallel-0",
        "attached-boolean-with-a-value",
    ],
)
def test_a_flag_value_that_would_weaken_the_oracle_is_refused(
    arguments: list[str], fragment: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Both spellings are validated by ONE function, so neither can drift from the other.

    ``-mod mod`` and ``-timeout 0`` were accepted while ``-mod=mod`` and ``-timeout=0``
    were refused: the separated form had only its NAME checked and its value rode
    along. The first turns the frozen vendored build into a network module
    resolution; the second disables the oracle's timeout, so a hung test wedges the
    job instead of failing it.
    """
    destination = tmp_path / "go_baseline.json"

    exit_code = main(["--output", str(destination), "--", *arguments])

    assert exit_code != 0
    assert fragment in capsys.readouterr().err
    assert not destination.exists()


@pytest.mark.parametrize(
    ("goflags", "fragment"),
    [
        ("-run=TestNothing", "not in the allow-list"),
        ("-short", "not in the allow-list"),
        ("-tags=noetcd", "not in the allow-list"),
        ("-count=0", "only `-count=1` is permitted"),
        ("-mod=mod", "requires `-mod=vendor`"),
        ("-timeout=0", "which in Go means NO TIMEOUT AT ALL"),
        ("./some/package", "must be a standalone flag"),
        ("-timeout", "must be self-contained"),
    ],
    ids=[
        "run-filter",
        "short",
        "build-tags",
        "count-zero",
        "mod-mod",
        "timeout-zero",
        "bare-operand",
        "value-less-flag",
    ],
)
def test_inherited_goflags_are_screened_like_command_line_arguments(
    goflags: str, fragment: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GOFLAGS is an argument source, and it used to be screened by nothing at all.

    ``go test`` applies GOFLAGS exactly as if its entries had been typed after the
    subcommand, so ``GOFLAGS=-run=TestNothing`` shrinks the manifest just as silently
    as ``-run`` passed directly - and the previous guard, ``if "-mod=" not in
    goflags``, not only screened nothing but treated an inherited ``-mod=mod`` as
    SATISFYING the vendor requirement it was supposed to enforce.
    """
    monkeypatch.setenv("GOFLAGS", goflags)

    with pytest.raises(BaselineError, match=re.escape(fragment)):
        oracle_environment(os.environ)


@pytest.mark.parametrize(
    ("goflags", "expected"),
    [
        ("", "-mod=vendor"),
        ("-mod=vendor", "-mod=vendor"),
        ("-count=1", "-count=1 -mod=vendor"),
        ("-v -mod=vendor -timeout=30m", "-v -mod=vendor -timeout=30m"),
    ],
    ids=["empty", "already-vendor", "appends-vendor", "preserves-order"],
)
def test_a_conforming_goflags_is_preserved_and_vendor_is_ensured(
    goflags: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing legitimate is lost: conforming entries survive verbatim.

    The positive control for the screening above. A gate that refused every GOFLAGS
    would pass all eight refusal cases and would also break every run where the
    runner or CI set something deliberate.
    """
    monkeypatch.setenv("GOFLAGS", goflags)

    assert oracle_environment(os.environ)["GOFLAGS"] == expected


def test_the_oracle_is_always_bounded_by_an_explicit_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An implicit bound is one nobody can see in the command the log prints.

    Without this the run inherits Go's 10-minute PER-PACKAGE default, which is too
    tight for the integration packages - ``test/integration/auth`` alone takes roughly
    208 seconds - and invisible either way. AAP §0.7.3 names 30m as the budget
    ``make test-integration`` runs under.
    """
    monkeypatch.delenv(ENV_EXTRA_ARGS, raising=False)

    assert resolve_extra_go_args([]) == (f"-timeout={DEFAULT_ORACLE_TIMEOUT}",)
    # A caller's own bound is honoured rather than doubled.
    assert resolve_extra_go_args(["-timeout=45m"]) == ("-timeout=45m",)
    assert resolve_extra_go_args(["-timeout", "45m"]) == ("-timeout", "45m")


def test_a_schema_valid_but_narrow_manifest_is_refused_by_the_domain_check() -> None:
    """`validate_manifest` says yes and `check_committed_domain` says no.

    That difference is the whole finding. Every check in `validate_manifest` is
    INTERNAL - schema keys, row shapes, sorted order, no duplicates, counts that
    agree with the rows - so a one-row manifest is perfectly valid and asserts
    nothing at all. A deleted or truncated baseline therefore passed the gate, and
    the contract, being quantified over the recorded rows, passed with it.
    """
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "provenance": PROVENANCE_GO_TEST_JSON,
        "packages": [PKG],
        "counts": {
            "total": 1,
            "pass": 1,
            "fail": 0,
            "skip": 0,
            "by_package": {
                PKG: {
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
            {"package": PKG, "test": "TestA", "subtest": "", "action": "pass", "elapsed": 0.0}
        ],
    }

    validate_manifest(manifest)

    with pytest.raises(BaselineError, match="does not declare the expected parity domain"):
        check_committed_domain(manifest, source="<synthetic>")


def test_the_committed_manifest_describes_the_complete_measured_domain(
    repo_root: Path,
) -> None:
    """The committed artifact itself, checked by the same function the gate calls.

    INVARIANT LOCKED: the baseline in version control is the one the generator would
    certify - real oracle provenance, the exact expected package set, every pinned
    cardinality, and the measured verdict distribution including the 25 skips. This
    is the test that fails if someone commits a narrowed baseline, and it is the
    reason the numbers in ``PACKAGE_EXPECTATIONS`` are worth pinning at all.
    """
    path = repo_root / "python" / "tests" / "parity" / "baseline" / "go_baseline.json"
    assert path.is_file(), f"the committed parity baseline is missing from {path}"

    manifest = json.loads(path.read_text(encoding="utf-8"))
    validate_manifest(manifest)
    check_committed_domain(manifest, source=str(path))

    # And the totals are the measured ones, read off the artifact rather than
    # recomputed from the pins the check already compared against.
    assert PROVENANCE_GO_TEST_JSON in split_provenance(manifest["provenance"])
    counts = manifest["counts"]
    assert (counts["total"], counts["pass"], counts["fail"], counts["skip"]) == (
        3105,
        3080,
        0,
        25,
    )
    assert len(manifest["verdicts"]) == 3105


def test_a_pass_that_became_a_skip_is_refused_by_the_distribution_check() -> None:
    """"Pass the same way as they pass today" includes the skips, in both directions.

    A regeneration in which a passing test starts skipping keeps the totals and every
    cardinality intact - the row is still there, still counted - and changes only its
    action. Only the pinned pass/skip split can see it.
    """
    # The skip is a genuine roster member (the known procMount family in the one package
    # that skips today), so the roster admits it and the PINNED pass/skip split is what
    # this case is left proving -- which is the point: the totals and cardinalities are
    # all still satisfied, and only the distribution moved.
    verdicts = [
        Verdict(package=EXPECTED_SKIP_PACKAGE, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(
            package=EXPECTED_SKIP_PACKAGE,
            test="TestB",
            subtest=f"case_fail_{EXPECTED_SKIP_MARKER}",
            action="skip",
            elapsed=0.0,
        ),
    ]
    guard = {
        EXPECTED_SKIP_PACKAGE: PackageExpectation(
            total=2, top_level=1, subtests=1, passes=2, skips=0
        )
    }

    with pytest.raises(BaselineError, match="cardinality guard violated") as raised:
        build_manifest(
            verdicts,
            provenance=PROVENANCE_GO_TEST_JSON,
            allow_non_green=True,
            expectations=guard,
        )

    message = str(raised.value)
    assert "passes is 1, expected 2" in message
    assert "skips is 1, expected 0" in message


def test_an_unaccounted_skip_is_refused_but_a_pinned_one_is_recorded() -> None:
    """A skip is recordable exactly where something accounts for it.

    The measured baseline is not uniformly all-pass - ``test/integration/auth`` skips
    25 subtests under disabled alpha/beta feature gates - and AAP §0.10.3 requires a
    skipped test to stay skipped, so a blanket "no skips" rule would have made the
    true baseline unrecordable. The replacement is exact: a pinned count accepts
    exactly that many, and a package nobody measured refuses the skip outright.
    """
    # A recognised skip -- the roster's family check is independent of this one and runs
    # first, so the skip is placed in the known family to leave the PER-PACKAGE pin as the
    # thing under test.
    verdicts = [
        Verdict(package=EXPECTED_SKIP_PACKAGE, test="TestA", subtest="", action="pass", elapsed=0.0),
        Verdict(
            package=EXPECTED_SKIP_PACKAGE,
            test="TestB",
            subtest=f"case_fail_{EXPECTED_SKIP_MARKER}",
            action="skip",
            elapsed=0.0,
        ),
    ]

    with pytest.raises(BaselineError, match="skip count is not pinned"):
        build_manifest(verdicts, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS)

    pinned = {
        EXPECTED_SKIP_PACKAGE: PackageExpectation(
            total=2, top_level=1, subtests=1, passes=1, skips=1
        )
    }
    manifest = build_manifest(
        verdicts, provenance=PROVENANCE_GO_TEST_JSON, expectations=pinned
    )
    assert manifest["counts"] == {
        "total": 2,
        "pass": 1,
        "fail": 0,
        "skip": 1,
        "by_package": {
            EXPECTED_SKIP_PACKAGE: {
                "total": 2,
                "pass": 1,
                "fail": 0,
                "skip": 1,
                "top_level": 1,
                "subtests": 1,
            }
        },
    }


def test_the_derived_diagnostic_remains_runnable_without_becoming_certifiable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The diagnostic survives the guards that were added to stop it becoming a baseline.

    A refusal that also breaks the legitimate use is a half-finished fix, and this is the
    seam where that nearly happened. ``PACKAGE_EXPECTATIONS`` records what the ORACLE
    emits - 2,179 verdicts for ``test/integration/auth`` - while derived rows come from
    ``_SOURCE_INVENTORY``, which deliberately does not transcribe those 2,136 subtest
    names by hand. Applying the oracle's counts to inventory rows is a category error,
    and for a while it made every derived invocation die on a shortfall that was a
    property of the inventory's scope rather than a lost verdict.

    So the mode still runs and still writes SOMEWHERE ELSE, and the three barriers that
    matter are asserted right here alongside it: the provenance is stamped honestly, and
    the same artifact is refused by ``--check``.
    """
    destination = tmp_path / "diagnostic.json"

    assert main(["--mode", "derived", "--allow-derived-baseline", "--output", str(destination)]) == 0
    assert "WARNING: building from the measured source inventory" in capsys.readouterr().err

    document = json.loads(destination.read_text(encoding="utf-8"))
    # The envelope names BOTH atoms, because the diagnostic still appends the one
    # MEASURED non-Go row: a derived-only claim over it would be the very dishonesty
    # compose_provenance() exists to prevent. What matters here is that the derived atom
    # is present, which is exactly what --check and the reader refuse.
    assert PROVENANCE_DERIVED in split_provenance(document["provenance"])
    assert document["counts"]["total"] == len(document["verdicts"]) > 0
    # Every DERIVED row records no duration, because none was measured; a fabricated 0.0
    # would read as one. The single non-Go row is the exception and is not derived: it was
    # produced by RUNNING the case, so its JUnit-reported duration is a measurement and is
    # kept. That is the same distinction the provenance atoms above draw.
    derived_rows = [
        row for row in document["verdicts"] if row["package"] != NON_GO_BASELINE_PACKAGE
    ]
    assert derived_rows, "the derived inventory produced no Go rows at all"
    assert all(row["elapsed"] is None for row in derived_rows)

    # Schema-valid, and refused anyway.
    validate_manifest(document)
    assert main(["--check", "--output", str(destination)]) != 0
    assert "must declare 'go_test_json'" in capsys.readouterr().err


def test_measured_rows_are_still_held_to_the_oracle_cardinalities() -> None:
    """The positive control for the exemption above: it is scoped to provenance, not global.

    If the guard had been dropped outright rather than narrowed to measured rows, F02 and
    F04 would silently reopen - a short oracle run would be recordable again.
    """
    short = [
        Verdict(
            package=f"{GO_MODULE_PATH}/cluster/gce/gci",
            test="TestTLSFlags",
            subtest="",
            action="pass",
            elapsed=0.01,
        )
    ]

    with pytest.raises(BaselineError, match="cardinality guard violated"):
        build_manifest(short, provenance=PROVENANCE_GO_TEST_JSON, allow_non_green=True)

    # The other half of the distinction -- that a DERIVED stream is exempt from the
    # EMITTED counts while still being held to `top_level` -- is owned by
    # test_emitted_count_guards_do_not_apply_to_derived_rows, which asserts both
    # directions on data shaped for it.


# ---------------------------------------------------------------------------
# 16. A narrowed domain cannot overwrite the committed manifest  (invariant 12)
# ---------------------------------------------------------------------------


def test_a_narrowed_domain_cannot_overwrite_the_committed_manifest(tmp_path: Path) -> None:
    """The quiet way to empty the gate: regenerate over one package, keep the same path.

    The refusal names every omitted package, because the whole difficulty of this
    failure mode is that the resulting manifest looks perfect - valid schema, green
    verdicts, honest ``go_test_json`` provenance - and is simply smaller than the
    truth.
    """
    committed = default_baseline_path(tmp_path)

    with pytest.raises(BaselineError, match="refusing to narrow the committed baseline") as raised:
        check_domain_not_narrowed(
            ["./cluster/gce/gci/"], committed, tmp_path, allow_narrow=False
        )

    message = str(raised.value)
    assert f"{GO_MODULE_PATH}/test/integration/auth" in message
    assert f"{GO_MODULE_PATH}/plugin/pkg/admission/noderestriction" in message
    assert "--allow-narrow-domain" in message


def test_a_narrowed_domain_is_permitted_when_it_writes_somewhere_harmless(
    tmp_path: Path,
) -> None:
    """A scratch manifest weakens no gate, so narrowing is never reported there."""
    check_domain_not_narrowed(
        ["./cluster/gce/gci/"],
        tmp_path / "scratch.json",
        tmp_path,
        allow_narrow=False,
    )


def test_the_full_measured_scope_is_never_reported_as_narrowing(tmp_path: Path) -> None:
    """The ordinary, correct invocation must pass the guard in silence."""
    check_domain_not_narrowed(
        list(DEFAULT_PACKAGES),
        default_baseline_path(tmp_path),
        tmp_path,
        allow_narrow=False,
    )


def test_the_deliberate_narrowing_switch_downgrades_the_refusal_to_a_warning(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``--allow-narrow-domain`` exists for the rare deliberate case, and still says so."""
    check_domain_not_narrowed(
        ["./cluster/gce/gci/"],
        default_baseline_path(tmp_path),
        tmp_path,
        allow_narrow=True,
    )

    captured = capsys.readouterr().err
    assert "WARNING" in captured
    assert "--allow-narrow-domain was passed" in captured


def test_the_cli_refuses_a_narrowed_regeneration_of_the_committed_manifest(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """End to end through ``main``: non-zero exit, and NOTHING written.

    The stream handed in is well formed and would build a perfectly valid manifest,
    which is exactly the point: the refusal is about the DOMAIN, not about the data.
    """
    stream = tmp_path / "stream.json"
    stream.write_text(
        "\n".join(green_stream("TestA", package=f"{GO_MODULE_PATH}/cluster/gce/gci")) + "\n",
        encoding="utf-8",
    )
    committed = default_baseline_path(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "--mode",
            "go-test-json",
            "--event-stream",
            str(stream),
            "--packages",
            "./cluster/gce/gci/",
        ]
    )

    assert exit_code != 0
    assert not committed.exists()
    assert "refusing to narrow the committed baseline" in capsys.readouterr().err
