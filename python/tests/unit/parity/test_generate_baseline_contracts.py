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
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from tests.parity.tools.generate_baseline import (
    GO_MODULE_PATH,
    NON_GO_BASELINE_PACKAGE,
    NON_GO_BASELINE_TEST,
    PACKAGE_EXPECTATIONS,
    PROVENANCE_GO_TEST_JSON,
    SCHEMA_VERSION,
    BaselineError,
    PackageExpectation,
    Verdict,
    build_manifest,
    check_go_verdict_domain,
    main,
    reduce_event_stream,
    split_go_test_id,
    validate_manifest,
    write_manifest_atomic,
)

if TYPE_CHECKING:
    from pathlib import Path

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
        non_go_only, provenance=PROVENANCE_GO_TEST_JSON, expectations=NO_GUARDS
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

    with pytest.raises(BaselineError, match="produced no outcome") as raised:
        check_go_verdict_domain(
            reduction,
            packages=["synthetic/pkg", "synthetic/absent"],
            require_requested=True,
        )

    assert f"{GO_MODULE_PATH}/synthetic/absent" in str(raised.value)


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

    # And --check accepts what was just written.
    assert main(["--check", "--output", str(destination)]) == 0


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


def test_the_measured_cardinality_guards_are_the_measured_numbers() -> None:
    """AAP §0.7.1.2: 648 verdicts as 8 top-level plus 640 subtests, and 43 auth identities.

    Pinned here as well as in the generator so that editing one without re-measuring
    fails a test rather than merely changing a constant. ``test/integration/auth``
    constrains only ``top_level`` because its subtest cardinality was never measured,
    and pinning a total nobody counted would be inventing one.
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
    assert auth.top_level == 43
    assert auth.total is None
    assert auth.subtests is None


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
