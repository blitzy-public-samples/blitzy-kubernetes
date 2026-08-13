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

# AAP §0.5.1 / §0.4.3 (L5 Tooling Unit, AAP §0.4.1.1) / §0.2.1.9 (the measured
# gap) / §0.10.1 (backward compatibility in test utilities) / tech-spec §6.6.3.1
# (the 49 hack/verify-*.sh gates), §6.6.3.4 (the documentation convention).

"""The header gate that admits this migration, asserted against the shipped gate.

UNDER TEST: ``hack/boilerplate/boilerplate.py`` - the sole implementation behind
``hack/verify-boilerplate.sh``, which is itself one of the repository's
``hack/verify-*.sh`` checks and is listed in ``hack/make-rules/verify.sh``'s
``QUICK_PATTERNS``. The real checker and the real ``boilerplate.*.txt`` templates
are exercised through ``repo_root``; nothing here re-implements the matching
logic, because a test that asserts against a re-implementation proves nothing
about the gate that actually runs.

GAP CLOSED (AAP §0.2.1.9): "No Apache-2.0 boilerplate gate covering ``.py``,
``.ts``, or ``.tsx``." The significance of this module is out of all proportion
to its size - ADDING ANY FILE TO THIS REPOSITORY FAILS A QUALITY GATE UNLESS THAT
GATE CAN SEE THE NEW EXTENSIONS - so it is the executable guard on the mechanism
that admits the rest of the Python and React trees.

COMPLEMENTS, AND DELIBERATELY DOES NOT DUPLICATE,
``hack/boilerplate/boilerplate_test.py``. That module owns exactly one question:
does a scan of ``hack/boilerplate/test/`` report exactly the known-bad fixtures?
Its expected list is asserted THERE and nowhere else, so growing the fixture set
touches one assertion instead of two. This module owns the MECHANISM instead -
registration, per-extension detection, exclusion, the boundary conditions and the
stdout contract - over a ``tmp_path`` tree it builds and owns. It never reads
``hack/boilerplate/test/``, which is in any case a ``skipped_names`` entry and so
invisible to a walk.

INVARIANTS LOCKED BY THIS MODULE, in the order the tests appear:

1.  The ``.py``, ``.ts`` and ``.tsx`` reference headers are REGISTERED with the
    gate, and the six pre-existing extensions survive unchanged (AAP §0.10.1).
2.  The new templates are the canonical year-less Apache-2.0 block, and ``.tsx``
    genuinely needs its own template because ``file_extension`` reports ``tsx``.
3.  A conforming header PASSES and a corrupted one FAILS, for each of ``.py``,
    ``.ts`` and ``.tsx``, at real migration paths. This is the invariant the AAP
    §0.5.1 row names.
4.  The gate ACCUMULATES findings: one bad file never hides the others.
5.  ``python/tests/**`` and ``web/src/**`` are GATED, not skipped - the property
    the entire migration rests on.
6.  ``web/node_modules``, ``python/.venv`` and ``__pycache__`` stay EXCLUDED while
    sources beside them stay gated.
7.  ``.ts``/``.tsx`` admit NO prologue, while ``.py`` still tolerates a shebang.
8.  The copyright year cutoff is 2025: year-less and 2014-2025 pass, 2026 fails.
9.  The blank line after the header is part of the contract, and a truncated
    header fails.
10. Only extensions owning a ``boilerplate.<ext>.txt`` template are gated.
11. ``main()`` returns 0 and prints one bare offending path per line - the exact
    contract ``hack/verify-boilerplate.sh`` reads.
12. This file itself satisfies the gate it verifies.

RULES: ``review_rules`` reports "No user rules provided." for this project, so no
rule is cited and none is invented; the work is held to the AAP §0.11.1
enterprise-standard bar instead. Every assertion below reflects behaviour that
was EXECUTED and MEASURED against the shipped checker rather than inferred from
its documentation - where the two disagreed, the code won.

STRUCTURE, and why it is what it is:

* No test class and no ``unittest.TestCase``. ``testify/suite`` has zero uses
  across all 2,853 ``*_test.go`` files, so a class-based idiom would be foreign
  here - and migrating away from ``unittest`` is the whole point of the sibling
  conversion (AAP §0.9.2).
* No pytest marker. ``python/pyproject.toml`` declares exactly ``integration``,
  ``shell``, ``config``, ``parity`` and ``slow``, and ``--strict-markers`` makes
  anything else a collection error. Unmarked keeps this module inside the fast
  ``-m "not integration"`` tier, which needs no etcd and no API server.
* No autouse fixture. This directory is granted no ``conftest.py`` (AAP §0.4.4.1
  enumerates the hierarchy and omits it), and under ``--doctest-modules`` an
  autouse fixture declared inline in a test module can execute twice. Every
  fixture below is function-scoped and explicitly requested, which makes that
  hazard impossible by construction rather than by convention.
* Standard library plus ``pytest``, and nothing else. No new distribution enters
  the tier for a module whose subject is a stdlib-only 300-line script.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import types
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any, Final

import pytest

# ---------------------------------------------------------------------------
# The measured contract of the checker, named once and asserted below
# ---------------------------------------------------------------------------

#: ``argv[0]`` installed while ``boilerplate.py`` is executed. Its module scope
#: runs ``args = parser.parse_args()``, so whatever ``sys.argv`` holds at that
#: moment is parsed: under ``pytest -q`` argparse would abort the session with
#: ``SystemExit(2): unrecognized arguments: -q``. One harmless element is enough,
#: because argparse reads ``argv[0]`` only to spell its own usage message.
_SANITISED_ARGV_PROG: Final[str] = "boilerplate.py"

#: Basename of the checker inside ``hack/boilerplate``.
_CHECKER_FILENAME: Final[str] = "boilerplate.py"

#: Extensions this migration adds coverage for. ``py`` is here rather than in
#: :data:`PREEXISTING_EXTENSIONS` because it is the extension the new Python tier
#: is written in, and its detection is what AAP §0.5.1 asks this module to prove.
MIGRATION_EXTENSIONS: Final[tuple[str, ...]] = ("py", "ts", "tsx")

#: Extensions the checker handled before this workstream. AAP §0.10.1 requires
#: that extending the gate not change its behaviour for these, so their continued
#: registration is asserted rather than assumed. Measured on the source branch as
#: exactly ``Dockerfile``, ``Makefile``, ``generatego``, ``go``, ``py``, ``sh``.
PREEXISTING_EXTENSIONS: Final[tuple[str, ...]] = (
    "Dockerfile",
    "Makefile",
    "generatego",
    "go",
    "sh",
)

#: The complete registry after this workstream: the six above plus ``ts`` and
#: ``tsx``. Eight, reached with ZERO code change, because ``get_refs()`` globs
#: ``boilerplate.*.txt`` and takes the extension from the file name.
EXPECTED_REGISTERED_EXTENSIONS: Final[tuple[str, ...]] = tuple(
    sorted({*MIGRATION_EXTENSIONS, *PREEXISTING_EXTENSIONS})
)

#: Generated and vendored trees of the two new tiers that must stay outside the
#: gate. Load-bearing: measured WITHOUT them, files under both directories are
#: gated, so their absence would fail the gate on third-party code.
EXCLUDED_MIGRATION_TREES: Final[tuple[str, ...]] = ("web/node_modules", "python/.venv")

#: Generated cache directory that must stay outside the gate. Recorded separately
#: because it is excluded twice over: the checker prunes any directory whose name
#: starts with ``__`` regardless, so its explicit registration is belt-and-braces
#: rather than the mechanism. The behavioural assertion is therefore the primary
#: one, and stays correct either way.
EXCLUDED_CACHE_DIR: Final[str] = "__pycache__"

#: Real paths from the AAP §0.5.1 file map, used to prove the new trees are
#: gated. Repository-relative and deliberately literal: the point is that THESE
#: paths, the ones the migration actually creates, are visible to the gate.
REPRESENTATIVE_SOURCE_PATHS: Final[tuple[str, ...]] = (
    "python/tests/unit/tooling/test_boilerplate_headers.py",
    "python/tests/conftest.py",
    "python/tests/helpers/bash.py",
    "web/src/setupTests.ts",
    "web/src/components/PostureDashboard.test.tsx",
    "web/src/test/msw/handlers.ts",
)

# ---------------------------------------------------------------------------
# The hermetic tree: migration-shaped paths, built under tmp_path
# ---------------------------------------------------------------------------

#: Files that must PASS, keyed by repository-relative path with the extension
#: whose reference header they carry. Paths are taken from the AAP §0.5.1 map so
#: the test proves the real thing rather than a convenient stand-in.
CONFORMING_TREE: Final[dict[str, str]] = {
    "python/tests/unit/tooling/sample.py": "py",
    "python/tests/conftest.py": "py",
    "python/tests/helpers/bash.py": "py",
    "web/src/setupTests.ts": "ts",
    "web/src/test/msw/handlers.ts": "ts",
    "web/src/components/Sample.tsx": "tsx",
}

#: Files inside the generated and vendored trees. Each is written with a
#: DELIBERATELY CORRUPTED header, which is what makes the exclusion assertions
#: mean something: if an exclusion ever broke, these would surface as offenders
#: instead of the test passing on an empty set for the wrong reason.
EXCLUDED_TREE: Final[dict[str, str]] = {
    "web/node_modules/pkg/index.ts": "ts",
    "python/.venv/lib/mod.py": "py",
    "python/tests/__pycache__/mod.py": "py",
}

#: Files whose extension owns no ``boilerplate.<ext>.txt`` template. They must
#: never be selected. Not in scope to gate, and no template exists for them.
UNREGISTERED_TREE: Final[tuple[str, ...]] = (
    "python/tests/unit/tooling/data.json",
    "python/tests/fixtures/templates/kube_env.j2",
)

#: A body per extension, plausible for the language and long enough that the file
#: exceeds the reference: a file shorter than the reference short-circuits to
#: False before the comparison, which would let a case pass for the wrong reason.
EXTENSION_BODIES: Final[dict[str, str]] = {
    "py": "SAMPLE = 1\n",
    "ts": "export const sample = 1;\n",
    "tsx": "export const Sample = (): null => null;\n",
}

#: Marker injected into the MIDDLE of a header to corrupt it - the same technique
#: the repository's own ``hack/boilerplate/test/fail.*`` fixtures use. Injecting
#: rather than truncating is what makes the mismatch trip the exact-list-equality
#: comparison instead of the "smaller than reference" short-circuit, so a
#: corrupted case fails for the reason the test claims it does.
CORRUPTION_MARKER: Final[str] = "BLITZY HEADER CORRUPTION MARKER"

#: 0-based index the corruption is injected at: inside the licence block, past
#: the copyright line so the year-normalisation pass is still exercised.
CORRUPTION_INDEX: Final[int] = 3


def _load_boilerplate(boilerplate_dir: Path) -> types.ModuleType:
    """Execute the real ``boilerplate.py`` as an anonymous module.

    ``hack/boilerplate`` is not on ``python/pyproject.toml``'s ``pythonpath``, so
    a bare ``import boilerplate`` cannot work from here; the checker is loaded
    from its path instead.

    Two measured hazards shape this function:

    * ``args = parser.parse_args()`` runs at MODULE SCOPE, so ``sys.argv`` is
      replaced before :meth:`exec_module` and restored in a ``finally`` - the
      restore is in a ``finally`` precisely so a failing load cannot leave the
      host process holding a sanitised argv.
    * The module is NOT inserted into :data:`sys.modules`. Leaving the import
      system untouched is what makes this module safe under ``pytest-xdist`` and
      ``pytest-randomly``, and what keeps it independent of
      ``hack/boilerplate/boilerplate_test.py``, which does register the name.

    Args:
        boilerplate_dir: The real ``hack/boilerplate`` directory.

    Returns:
        A freshly executed module object.
    """
    __tracebackhide__ = True

    # Setup breakage, not a finding: abort immediately (the `t.Fatalf` analogue).
    assert sys.argv != [_SANITISED_ARGV_PROG], (
        "sys.argv still holds the sanitised single-element list from an earlier "
        "load, so a previous test leaked it: boilerplate.py parses argv at module "
        "scope and every loader must restore what it replaced"
    )

    checker = boilerplate_dir / _CHECKER_FILENAME
    assert checker.is_file(), (
        f"the checker under test is missing at {checker}: this module exercises "
        "the shipped hack/boilerplate/boilerplate.py and never a copy of it"
    )

    spec = importlib.util.spec_from_file_location("tests_tooling_boilerplate", checker)
    # Two assertions rather than one conjunction: a failure then says WHICH half
    # of the spec importlib declined to build, and mypy narrows `spec` and
    # `spec.loader` away from None for the calls below.
    assert spec is not None, f"importlib could not build a module spec for {checker}"
    assert spec.loader is not None, (
        f"the module spec for {checker} carries no loader, so it cannot be executed"
    )
    module = importlib.util.module_from_spec(spec)

    original_argv = sys.argv
    sys.argv = [_SANITISED_ARGV_PROG]
    try:
        spec.loader.exec_module(module)
    finally:
        sys.argv = original_argv
    return module


@pytest.fixture
def boilerplate_dir(repo_root: Path) -> Path:
    """The real ``hack/boilerplate`` directory, resolved from ``repo_root``.

    ``repo_root`` is the session-scoped fixture in ``python/tests/conftest.py``,
    which derives the checkout root from its own ``__file__`` and checks
    sentinels. Deriving the path from it rather than from the process working
    directory or from this file's own ``__file__`` arithmetic is what lets the
    module run identically from the repository root and from ``python/``.

    A missing directory is setup breakage and aborts.
    """
    __tracebackhide__ = True
    directory = repo_root / "hack" / "boilerplate"
    assert directory.is_dir(), (
        f"hack/boilerplate is missing beneath {repo_root}: the reference headers "
        "and the checker both live there and neither is copied into python/"
    )
    return directory


@pytest.fixture
def boilerplate(boilerplate_dir: Path) -> Iterator[types.ModuleType]:
    """A freshly loaded checker whose ``args`` are already pointed at the real
    templates.

    Fresh per test on purpose: the module is 300 lines of standard library, so a
    reload costs almost nothing and buys complete isolation between tests that
    each rewrite ``args``.

    ``rootdir`` is deliberately left as the checker's own default and every test
    overrides it with an ABSOLUTE ``tmp_path``. A relative, non-``"."`` rootdir
    would be doubled - ``get_files`` emits rootdir-prefixed paths and
    ``normalize_files`` re-joins any non-absolute path onto rootdir again - which
    makes every file unopenable and reports all of them as false offenders.

    Teardown closes ``verbose_out``. The checker binds it at IMPORT time to an
    open ``/dev/null`` handle when ``verbose`` is falsey, so a later ``args``
    patch never redirects it and, left open, it would leak a file descriptor per
    test and could raise a ``ResourceWarning`` that this tier's
    ``filterwarnings = ["error"]`` turns into a failure.
    """
    module = _load_boilerplate(boilerplate_dir)

    # Widened to Any for the assignment only. mypy resolves attribute READS on a
    # ModuleType to Any through its __getattr__, but rejects an attribute
    # ASSIGNMENT - and a module loaded from a path has no stub to check against, so
    # there is nothing more precise to say. The name records that this is a
    # deliberate widening rather than an oversight.
    dynamic: Any = module
    dynamic.args = types.SimpleNamespace(
        filenames=[],
        rootdir=str(boilerplate_dir.parent.parent),
        boilerplate_dir=str(boilerplate_dir),
        verbose=False,
    )
    try:
        yield module
    finally:
        stream = getattr(module, "verbose_out", None)
        if stream is not None and stream is not sys.stderr and not stream.closed:
            stream.close()


@pytest.fixture
def refs(boilerplate: types.ModuleType) -> dict[str, list[str]]:
    """The reference headers, read from the real templates by the real
    ``get_refs()``.

    ``get_refs()`` reads whatever ``args.boilerplate_dir`` names, so the
    :func:`boilerplate` fixture must have set ``args`` first - it has.
    """
    return boilerplate.get_refs()


@pytest.fixture
def regexs(boilerplate: types.ModuleType) -> dict[str, re.Pattern[str]]:
    """The checker's own compiled patterns, including the year regex."""
    return boilerplate.get_regexs()


def _header(refs: dict[str, list[str]], extension: str) -> str:
    """The reference header for ``extension`` as text, taken from the LIVE
    templates.

    Never a hardcoded copy: a copy would drift from the shipped template and the
    test would then assert against yesterday's licence text.
    """
    return "\n".join(refs[extension])


def _conforming(refs: dict[str, list[str]], extension: str) -> str:
    """A file that must PASS: the reference header, then a body.

    The mandatory blank line after the header is reproduced for free, because the
    reference's own final ``splitlines()`` entry is empty and the join therefore
    ends with a newline that the body's leading newline completes.
    """
    return _header(refs, extension) + "\n" + EXTENSION_BODIES[extension]


def _corrupted(refs: dict[str, list[str]], extension: str) -> str:
    """A file that must FAIL, corrupted in the middle rather than truncated."""
    lines = list(refs[extension])
    lines[CORRUPTION_INDEX:CORRUPTION_INDEX] = [CORRUPTION_MARKER, ""]
    return "\n".join(lines) + "\n" + EXTENSION_BODIES[extension]


def _write(root: Path, relative: str, text: str) -> Path:
    """Materialise ``text`` at ``root / relative``, creating parents."""
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


def _build_migration_tree(root: Path, refs: dict[str, list[str]]) -> None:
    """Build the hermetic migration-shaped tree beneath ``root``.

    Three groups, each with a job: conforming sources that must be selected and
    must pass; corrupt-headered files inside the generated trees that must never
    be selected at all; and unregistered extensions that must never be selected
    because no template claims them.
    """
    for relative, extension in CONFORMING_TREE.items():
        _write(root, relative, _conforming(refs, extension))
    for relative, extension in EXCLUDED_TREE.items():
        _write(root, relative, _corrupted(refs, extension))
    for relative in UNREGISTERED_TREE:
        _write(root, relative, "{}\n")


def _selected(boilerplate: types.ModuleType, root: Path) -> set[str]:
    """Repository-relative paths the checker SELECTS when walking ``root``.

    Uses the real ``get_files(refs)``, which is the only correct way to choose
    files: calling ``file_passes`` on an unregistered extension raises
    ``KeyError`` instead of returning a verdict.
    """
    boilerplate.args.filenames = []
    boilerplate.args.rootdir = str(root)
    chosen = boilerplate.get_files(boilerplate.get_refs())
    return {Path(path).resolve().relative_to(root.resolve()).as_posix() for path in chosen}


def _run_gate(
    boilerplate: types.ModuleType,
    capsys: pytest.CaptureFixture[str],
    root: Path,
    filenames: Sequence[str] = (),
) -> tuple[int, list[str]]:
    """Run the checker's ``main()`` over ``root`` and collect what it reported.

    Args:
        boilerplate: The loaded checker.
        capsys: Captures the offender list, which ``main()`` writes to stdout.
        root: An ABSOLUTE root to walk. Absolute because a relative,
            non-``"."`` rootdir is doubled and turns every file into a false
            offender.
        filenames: Explicit files to check instead of walking, absolute for the
            same reason.

    Returns:
        The return code and the reported offender lines, sorted.
    """
    boilerplate.args.filenames = list(filenames)
    boilerplate.args.rootdir = str(root)
    return_code = boilerplate.main()
    captured = capsys.readouterr()
    return return_code, sorted(line for line in captured.out.splitlines() if line)


def _with_copyright_year(
    refs: dict[str, list[str]], extension: str, year: int | None
) -> str:
    """A conforming file whose copyright line carries ``year``, or none at all.

    The year is spliced into the reference itself rather than into a hand-written
    header, so the case differs from the passing case in exactly one respect.
    """
    lines = list(refs[extension])
    if year is not None:
        lines = [
            line.replace(
                "Copyright The Kubernetes Authors.",
                f"Copyright {year} The Kubernetes Authors.",
            )
            for line in lines
        ]
    return "\n".join(lines) + "\n" + EXTENSION_BODIES[extension]


# ---------------------------------------------------------------------------
# 1. Registration
# ---------------------------------------------------------------------------


def test_reference_templates_register_the_new_extensions(
    refs: dict[str, list[str]], subtests: pytest.Subtests
) -> None:
    # INVARIANT LOCKED: the .py, .ts and .tsx Apache-2.0 reference headers are
    # registered with the header gate, AND the six pre-existing extensions
    # survive unchanged (AAP §0.10.1, backward compatibility in test utilities).
    #
    # Subtests rather than a plain loop because every missing extension must be
    # reported in ONE run - the accumulate-and-continue semantic of Go's
    # `t.Errorf`. A bare assert inside the loop would abort at the first gap and
    # hide the rest, and "which extensions are unregistered?" is precisely the
    # question a failure here has to answer.
    #
    # Registration only. Nothing here asserts a code change, because there is
    # none to assert: get_refs() globs boilerplate.*.txt and derives the
    # extension from the file name, so dropping in two templates registers two
    # extensions. Measured: six keys on the source branch, eight here.
    for extension in MIGRATION_EXTENSIONS:
        with subtests.test(extension=extension, role="migration"):
            assert extension in refs, (
                f"the header gate does not recognise .{extension}: no "
                f"hack/boilerplate/boilerplate.{extension}.txt reference template "
                "is registered, so every new file with that extension is invisible "
                "to hack/verify-boilerplate.sh"
            )

    for extension in PREEXISTING_EXTENSIONS:
        with subtests.test(extension=extension, role="pre-existing"):
            assert extension in refs, (
                f"the pre-existing extension {extension} lost its reference "
                "template: extending the gate must not change its behaviour for "
                "anything it already handled"
            )

    assert sorted(refs) == list(EXPECTED_REGISTERED_EXTENSIONS), (
        "the registered extension set is not exactly the expected eight - an "
        f"unexpected addition or removal changes what the gate walks: {sorted(refs)}"
    )
    assert len(refs) == len(EXPECTED_REGISTERED_EXTENSIONS), (
        f"expected {len(EXPECTED_REGISTERED_EXTENSIONS)} registered extensions, "
        f"found {len(refs)}"
    )


# ---------------------------------------------------------------------------
# 2. The new templates are the canonical block, and .tsx needs its own
# ---------------------------------------------------------------------------


def test_ts_and_tsx_references_are_the_canonical_apache_block(
    boilerplate: types.ModuleType, refs: dict[str, list[str]]
) -> None:
    # INVARIANT LOCKED: the new .ts and .tsx templates are the canonical
    # year-less Apache-2.0 block the repository already uses for Go, not a
    # hand-typed variant of it - and .tsx genuinely requires its own template.
    #
    # Byte-identity with the Go template is the strongest available statement:
    # it means the licence text of the React tier cannot drift from the licence
    # text of the rest of the repository.
    assert refs["ts"] == refs["go"], (
        "the .ts reference header is not byte-identical to the .go reference "
        "header, so the TypeScript tier would carry a variant licence block"
    )
    assert refs["tsx"] == refs["go"], (
        "the .tsx reference header is not byte-identical to the .go reference "
        "header, so the React tier would carry a variant licence block"
    )

    # Shape of the C-style block. Asserted line by line rather than as one blob
    # because a failure then names the line that drifted.
    assert refs["ts"][0] == "/*", "the .ts reference must open with a /* comment"
    assert refs["ts"][1] == "Copyright The Kubernetes Authors.", (
        "the .ts copyright line must be YEAR-LESS: the gate's final accepted year "
        "is 2025, so a header carrying a later year is an offender"
    )
    assert refs["ts"][7] == "    http://www.apache.org/licenses/LICENSE-2.0", (
        "the .ts licence URL line must be indented by exactly four spaces with no "
        "comment prefix - the comparison is exact list equality, so whitespace is "
        "part of the contract"
    )
    assert refs["ts"][14] == "*/", "the .ts reference must close the comment block"
    assert refs["ts"][15] == "", (
        "the .ts reference must end with an empty entry: that empty line is what "
        "requires a blank line between the header and the first statement"
    )
    assert len(refs["ts"]) == 16, (
        f"the .ts reference must be 16 lines, found {len(refs['ts'])}"
    )

    # Shape of the hash-style block used by the Python tier.
    assert refs["py"][0] == "# Copyright The Kubernetes Authors.", (
        "the .py copyright line must be YEAR-LESS and hash-prefixed"
    )
    assert refs["py"][12] == "# limitations under the License.", (
        "the .py reference must end its licence text with the limitations line"
    )
    assert refs["py"][13] == "", (
        "the .py reference must end with an empty entry, requiring a blank line "
        "after the header"
    )
    assert len(refs["py"]) == 14, (
        f"the .py reference must be 14 lines, found {len(refs['py'])}"
    )

    # WHY TWO TEMPLATES ARE REQUIRED, and not one. file_extension() takes the
    # text after the LAST dot, so a .tsx file resolves to "tsx" and would raise
    # KeyError - never silently fall back to "ts" - if only boilerplate.ts.txt
    # existed. This is the assertion that stops someone deleting one template as
    # a duplicate of the other.
    assert boilerplate.file_extension("Foo.tsx") == "tsx", (
        "a .tsx file must resolve to the tsx extension, which is why "
        "boilerplate.tsx.txt is required in addition to boilerplate.ts.txt"
    )
    assert boilerplate.file_extension("Foo.tsx") != "ts", (
        "a .tsx file must NOT resolve to ts: a single ts template would never be "
        "consulted for JSX"
    )
    assert boilerplate.file_extension("Foo.ts") == "ts", (
        "a .ts file must resolve to the ts extension"
    )


# ---------------------------------------------------------------------------
# 3. The core case named by the AAP §0.5.1 row
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("extension", "relative_path", "conforming"),
    [
        ("py", "python/tests/unit/tooling/sample.py", True),
        ("py", "python/tests/unit/tooling/sample.py", False),
        ("ts", "web/src/setupTests.ts", True),
        ("ts", "web/src/setupTests.ts", False),
        ("tsx", "web/src/components/Sample.tsx", True),
        ("tsx", "web/src/components/Sample.tsx", False),
    ],
    ids=["py-pass", "py-fail", "ts-pass", "ts-fail", "tsx-pass", "tsx-fail"],
)
def test_reference_headers_are_detected_across_the_new_trees(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    regexs: dict[str, re.Pattern[str]],
    tmp_path: Path,
    extension: str,
    relative_path: str,
    conforming: bool,
) -> None:
    # INVARIANT LOCKED: a file carrying the reference header PASSES and a file
    # whose header has been corrupted FAILS, for each of .py, .ts and .tsx, at
    # the real migration paths of AAP §0.5.1. This is the invariant the AAP row
    # for this module names in so many words.
    #
    # Both halves are needed. The passing half alone would also hold for a gate
    # that approves everything; the failing half alone would also hold for a gate
    # that approves nothing. Parametrized rather than accumulated because the six
    # cases are INDEPENDENT - each is separately addressable as
    # `...::test_reference_headers_are_detected_across_the_new_trees[ts-fail]`.
    content = (
        _conforming(refs, extension) if conforming else _corrupted(refs, extension)
    )
    target = _write(tmp_path, relative_path, content)

    verdict = bool(boilerplate.file_passes(str(target), refs, regexs))

    assert verdict is conforming, (
        f"the header gate returned {verdict} for a "
        f"{'conforming' if conforming else 'corrupted'} .{extension} header at "
        f"{relative_path}; expected {conforming}. A conforming header must be "
        "accepted or the migration cannot add files, and a corrupted one must be "
        "rejected or the gate is decorative"
    )


# ---------------------------------------------------------------------------
# 4. Findings accumulate
# ---------------------------------------------------------------------------


def test_gate_reports_every_offender_in_one_run(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    subtests: pytest.Subtests,
) -> None:
    # INVARIANT LOCKED: the gate ACCUMULATES findings - one bad file does not
    # hide the others. A checker that stopped at the first offender would let a
    # developer fix one header, re-run, and be surprised again, and a reviewer
    # would never see the true size of the problem.
    offending = {
        "python/tests/unit/tooling/broken.py": "py",
        "web/src/broken.ts": "ts",
        "web/src/components/Broken.tsx": "tsx",
    }
    clean = {
        "python/tests/unit/tooling/sample.py": "py",
        "web/src/setupTests.ts": "ts",
        "web/src/components/Sample.tsx": "tsx",
    }
    for relative, extension in offending.items():
        _write(tmp_path, relative, _corrupted(refs, extension))
    for relative, extension in clean.items():
        _write(tmp_path, relative, _conforming(refs, extension))

    return_code, reported = _run_gate(boilerplate, capsys, tmp_path)
    reported_relative = {
        Path(line).resolve().relative_to(tmp_path.resolve()).as_posix()
        for line in reported
    }

    assert return_code == 0, (
        "main() must report success even when it finds offenders; the exit status "
        f"is hack/verify-boilerplate.sh's job, not its own (got {return_code})"
    )

    # Subtests: the accumulate-and-continue semantic. Each missing offender is
    # reported separately, so a regression that hides two of the three is fully
    # described in one run rather than truncated at the first.
    for relative in offending:
        with subtests.test(offender=relative):
            assert relative in reported_relative, (
                f"the gate did not report {relative}, whose header is corrupted: a "
                "missed offender is a licence header that reaches the branch "
                f"unchecked. Reported: {sorted(reported_relative)}"
            )

    # A false positive is setup-level breakage, not one finding among many, so it
    # aborts (the `t.Fatalf` analogue) rather than accumulating.
    falsely_accused = sorted(reported_relative & set(clean))
    assert not falsely_accused, (
        f"the gate reported conforming files as offenders: {falsely_accused}. A "
        "false positive is worse than a miss - it trains reviewers to ignore the "
        "gate"
    )



# ---------------------------------------------------------------------------
# 5. The new trees are gated, not skipped
# ---------------------------------------------------------------------------


def test_new_source_trees_are_gated_not_skipped(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    tmp_path: Path,
    subtests: pytest.Subtests,
) -> None:
    # INVARIANT LOCKED: python/tests/** and web/src/** are SUBJECT to the header
    # gate. This is the property the entire migration rests on - a tree the gate
    # cannot see is a tree whose licence headers are unenforced, and the failure
    # mode is silent, because an unwalked tree simply produces no findings.
    #
    # Two independent proofs, because either alone could hold for the wrong
    # reason: the exclusion rules do not match these paths, AND the checker
    # actually selects files at them.
    #
    # Subtests: every path that regressed must be named in one run. If a future
    # exclusion entry swallowed two of the six, a bare assert would name one.
    for relative in REPRESENTATIVE_SOURCE_PATHS:
        with subtests.test(path=relative):
            assert not boilerplate.is_skipped(relative), (
                f"{relative} is excluded from the header gate, so nothing enforces "
                "its Apache-2.0 header: an exclusion rule now matches a path the "
                "migration creates"
            )
            substring_hits = [
                entry for entry in boilerplate.skipped_names if entry in relative
            ]
            assert not substring_hits, (
                f"{relative} contains the skipped_names entries {substring_hits} as "
                "substrings; that list is matched with `x in pathname`, so the path "
                "is silently dropped from the gate"
            )

    # The behavioural half: the checker's own selection over a real tree.
    _build_migration_tree(tmp_path, refs)
    selected = _selected(boilerplate, tmp_path)

    for relative in CONFORMING_TREE:
        with subtests.test(selected=relative):
            assert relative in selected, (
                f"the checker did not select {relative} when walking the tree, so "
                "its header would never be compared against the reference"
            )


# ---------------------------------------------------------------------------
# 6. The generated trees stay excluded
# ---------------------------------------------------------------------------


def test_generated_trees_stay_excluded(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # INVARIANT LOCKED: the gate skips the generated and vendored trees of the two
    # new tiers while still gating the sources beside them. Both halves matter -
    # an exclusion wide enough to swallow web/src/ would be worse than no
    # exclusion at all.
    #
    # The BEHAVIOURAL assertion is primary and deliberately so. Every file planted
    # under an excluded tree by _build_migration_tree carries a CORRUPTED header,
    # so if an exclusion ever broke, these paths would be selected and the
    # assertion would fail loudly rather than passing on an empty set.
    _build_migration_tree(tmp_path, refs)
    selected = _selected(boilerplate, tmp_path)

    leaked = sorted(relative for relative in EXCLUDED_TREE if relative in selected)
    assert not leaked, (
        f"the checker selected files inside a generated or vendored tree: {leaked}. "
        "web/node_modules and python/.venv hold third-party code this repository "
        "does not licence, and __pycache__ holds build output; gating any of them "
        "fails hack/verify-boilerplate.sh on files nobody can fix"
    )

    still_gated = sorted(relative for relative in CONFORMING_TREE if relative in selected)
    assert still_gated == sorted(CONFORMING_TREE), (
        "the exclusion is wider than the trees it names: sources under "
        f"python/tests/** and web/src/** stopped being selected. Selected: "
        f"{still_gated}"
    )

    # The registry half. web/node_modules and python/.venv are LOAD-BEARING:
    # measured without them, files under both directories ARE gated. Asserted
    # against the union of the checker's declared exclusion lists rather than
    # against one of them by name, because the mechanism is the checker's to
    # choose - it currently matches these two as anchored path prefixes, which is
    # narrower and better than a substring match - while the invariant "these two
    # trees are declared excluded" is what this module is entitled to pin.
    declared_exclusions = {
        *boilerplate.skipped_names,
        *getattr(boilerplate, "skipped_prefixes", ()),
        *getattr(boilerplate, "skipped_dirs", ()),
    }
    for tree in EXCLUDED_MIGRATION_TREES:
        assert tree in declared_exclusions, (
            f"{tree} is not declared anywhere in the checker's exclusion registry "
            f"{sorted(declared_exclusions)}; that entry is load-bearing, because "
            "without it every file under that tree is gated"
        )

    # __pycache__ is excluded twice over: the checker prunes any directory whose
    # name starts with "__" regardless of the registry, so its explicit entry is
    # belt-and-braces rather than the mechanism. That is exactly why the
    # behavioural assertion above is the primary one for it and no registry
    # membership is required here.
    assert boilerplate.is_skipped(f"python/tests/{EXCLUDED_CACHE_DIR}/mod.py"), (
        f"a file under {EXCLUDED_CACHE_DIR}/ is not excluded, so compiled Python "
        "cache output would be held to the licence-header contract"
    )

    # The exclusion is a REAL FILTER, not merely a walk-pruning optimisation.
    # Naming every excluded file EXPLICITLY - which is exactly what
    # `hack/verify-boilerplate.sh web/node_modules/...` would do, since it forwards
    # its arguments verbatim - must still report nothing, because the filter is
    # applied to explicit arguments too and not only to walked paths. Without this,
    # a single-file invocation would bypass the exclusion and fail the gate on
    # third-party code nobody can fix.
    explicit = [str(tmp_path / relative) for relative in EXCLUDED_TREE]
    return_code, reported = _run_gate(boilerplate, capsys, tmp_path, explicit)
    assert return_code == 0, (
        f"main() returned {return_code} when handed only excluded files; it must "
        "always return 0 and leave the exit status to the wrapper"
    )
    assert not reported, (
        "naming excluded files explicitly reported them as offenders: "
        f"{reported}. The exclusion must filter explicit arguments as well as "
        "walked paths, or `hack/verify-boilerplate.sh <generated file>` fails"
    )

    # Control for the assertion above, so it cannot pass because the explicit-file
    # path reports nothing at all: one corrupt source named in the SAME call must
    # still be reported.
    gated_offender = _write(tmp_path, "web/src/broken.ts", _corrupted(refs, "ts"))
    return_code, reported = _run_gate(
        boilerplate, capsys, tmp_path, [*explicit, str(gated_offender)]
    )
    assert reported == [str(gated_offender)], (
        "the explicit-file path did not report exactly the one corrupt source "
        f"named alongside the excluded files: {reported}. Either the exclusion is "
        "too wide or explicit arguments are not being checked at all"
    )


# ---------------------------------------------------------------------------
# 7. TypeScript admits no prologue; Python still tolerates a shebang
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("extension", "prologue", "expected"),
    [
        ("ts", '"use client";\n\n', False),
        ("ts", "/* eslint-disable */\n", False),
        ("ts", "\n", False),
        ("tsx", "/** @jsxImportSource react */\n", False),
        ("py", "#!/usr/bin/env python3\n\n", True),
        ("py", "#!/usr/bin/env python3\n", True),
    ],
    ids=[
        "ts-use-client",
        "ts-eslint-disable",
        "ts-leading-blank",
        "tsx-jsx-pragma",
        "py-shebang-then-blank",
        "py-shebang-no-blank",
    ],
)
def test_ts_and_tsx_headers_admit_no_prologue(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    regexs: dict[str, re.Pattern[str]],
    tmp_path: Path,
    extension: str,
    prologue: str,
    expected: bool,
) -> None:
    # BOUNDARY CONDITION LOCKED: the checker strips a prologue only for Go build
    # constraints and for shell/Python shebangs. There is NO .ts or .tsx branch,
    # so for TypeScript the reference bytes are the literal required prefix of the
    # file: not a blank line, not "use client", not an eslint directive and not a
    # JSX pragma may precede them.
    #
    # The last two cases are the POSITIVE CONTRAST, and they are in the same test
    # on purpose: the asymmetry between the two languages is the deliberate
    # behaviour being locked, and separating the halves would let someone
    # "normalise" one of them without the other failing. .py tolerates a shebang
    # with or without a following blank line, because the strip branch exists for
    # it.
    #
    # This asymmetry is why every .ts and .tsx file in the React tier must open
    # with the licence block and nothing else. Do not relax this to make a file
    # pass - move the prologue below the header instead.
    target = _write(
        tmp_path,
        f"prologue/sample.{extension}",
        prologue + _conforming(refs, extension),
    )

    verdict = bool(boilerplate.file_passes(str(target), refs, regexs))

    assert verdict is expected, (
        f"a .{extension} file prefixed with {prologue!r} returned {verdict}; "
        f"expected {expected}. The checker strips build constraints only for Go "
        "and shebangs only for shell and Python, so nothing is stripped for "
        "TypeScript and anything preceding the header must fail"
    )


# ---------------------------------------------------------------------------
# 8. The 2025 copyright-year cutoff
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("year", "expected"),
    [(None, True), (2014, True), (2025, True), (2026, False)],
    ids=["none", "2014", "2025", "2026"],
)
def test_copyright_year_follows_the_2025_cutoff(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    regexs: dict[str, re.Pattern[str]],
    tmp_path: Path,
    year: int | None,
    expected: bool,
) -> None:
    # BOUNDARY CONDITION LOCKED: the checker normalises a copyright year only when
    # that year is one it knows, and the last one it knows is 2025. A year-less
    # header passes, 2014 through 2025 pass on files that already carry one, and
    # 2026 fails.
    #
    # THIS CUTOFF IS PRECISELY WHY EVERY NEW FILE IN THIS MIGRATION CARRIES THE
    # YEAR-LESS HEADER - including this one. A 2026 header would make the new file
    # an offender the moment it landed. The repository keeps its own
    # hack/boilerplate/test/fail_2026.go fixture for the same reason.
    #
    # Both extensions are checked in every case because the rule is
    # extension-independent: the year is normalised on the first matching line
    # whatever the comment syntax around it.
    assert "2025" in boilerplate.get_dates(), (
        "2025 is no longer an accepted copyright year, so files that legitimately "
        f"carry it became offenders: {boilerplate.get_dates()!r}"
    )
    assert "2026" not in boilerplate.get_dates(), (
        "2026 became an accepted copyright year; new files must stay year-less, so "
        f"widening the window silently permits a dated header: {boilerplate.get_dates()!r}"
    )

    for extension in ("py", "ts"):
        target = _write(
            tmp_path,
            f"year/{year}/sample.{extension}",
            _with_copyright_year(refs, extension, year),
        )
        verdict = bool(boilerplate.file_passes(str(target), refs, regexs))
        assert verdict is expected, (
            f"a .{extension} header with copyright year {year} returned {verdict}; "
            f"expected {expected}. The accepted window is 2014 to 2025 inclusive "
            "plus the year-less form, and a newly added file must be year-less"
        )


# ---------------------------------------------------------------------------
# 9. The blank line after the header is part of the contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("extension", ["py", "ts"], ids=["py", "ts"])
def test_trailing_blank_line_is_part_of_the_contract(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    regexs: dict[str, re.Pattern[str]],
    tmp_path: Path,
    extension: str,
) -> None:
    # BOUNDARY CONDITION LOCKED: the reference's final empty line means a BLANK
    # LINE MUST FOLLOW THE HEADER. The comparison is exact list equality after
    # truncating the file to the reference's length, so a file whose first
    # statement sits immediately under the licence block differs from the
    # reference at its last line and fails.
    #
    # Easy to mistake for cosmetic and it is not: it is the single most likely way
    # for a correct-looking header to be rejected, and softening it would mean the
    # gate no longer describes the shape the repository actually ships.
    reference = refs[extension]

    without_blank = _write(
        tmp_path,
        f"blank/no_blank.{extension}",
        "\n".join(reference[:-1]) + "\n" + EXTENSION_BODIES[extension],
    )
    assert bool(boilerplate.file_passes(str(without_blank), refs, regexs)) is False, (
        f"a .{extension} file whose body starts immediately after the licence block "
        "was accepted; the reference ends with an empty line, so a blank line "
        "between the header and the first statement is required"
    )

    with_blank = _write(
        tmp_path,
        f"blank/with_blank.{extension}",
        _conforming(refs, extension),
    )
    assert bool(boilerplate.file_passes(str(with_blank), refs, regexs)) is True, (
        f"a .{extension} file carrying the reference header followed by a blank line "
        "was rejected; that is the exact shape every file in this repository ships"
    )

    truncated = _write(
        tmp_path,
        f"blank/truncated.{extension}",
        "\n".join(reference[:5]) + "\n",
    )
    assert bool(boilerplate.file_passes(str(truncated), refs, regexs)) is False, (
        f"a .{extension} file shorter than the reference was accepted; a truncated "
        "licence block must fail before the comparison, or a file carrying only the "
        "first few lines of the licence would pass"
    )



# ---------------------------------------------------------------------------
# 10. Only templated extensions are gated
# ---------------------------------------------------------------------------


def test_unregistered_extensions_are_not_gated(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    regexs: dict[str, re.Pattern[str]],
    tmp_path: Path,
) -> None:
    # INVARIANT LOCKED: an extension is gated if and only if it owns a
    # boilerplate.<ext>.txt reference template. .json and .j2 own none - the AAP
    # does not put them in scope - so they must never be selected, and nothing
    # here claims they ought to be.
    #
    # The second half documents a real hazard rather than a nicety. file_passes()
    # indexes refs by extension with no membership test, so calling it directly on
    # an unregistered path raises KeyError instead of returning a verdict. THAT IS
    # WHY FILE SELECTION MUST ALWAYS GO THROUGH get_files(refs): it filters to the
    # registered set first. Recorded as an assertion so a future reader does not
    # "fix" the KeyError into a silent False, which would turn every unregistered
    # file into a reported offender.
    assert "json" not in refs, (
        "an extension template for .json appeared; the migration puts no .json "
        "file under the licence-header gate and none is planned"
    )
    assert "j2" not in refs, (
        "an extension template for .j2 appeared; Jinja2 templates are data files "
        "the migration does not gate"
    )

    _build_migration_tree(tmp_path, refs)
    selected = _selected(boilerplate, tmp_path)

    unregistered_selected = sorted(
        relative for relative in UNREGISTERED_TREE if relative in selected
    )
    assert not unregistered_selected, (
        f"the checker selected files whose extension owns no reference template: "
        f"{unregistered_selected}. Every one of them would raise KeyError inside "
        "file_passes()"
    )
    assert not [path for path in selected if path.endswith((".json", ".j2"))], (
        "a .json or .j2 path reached the selected set by another route: "
        f"{sorted(selected)}"
    )

    json_path = tmp_path / UNREGISTERED_TREE[0]
    with pytest.raises(KeyError, match="json"):
        boilerplate.file_passes(str(json_path), refs, regexs)


# ---------------------------------------------------------------------------
# 11. The stdout contract hack/verify-boilerplate.sh reads
# ---------------------------------------------------------------------------


def test_stdout_contract_consumed_by_verify_boilerplate(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # INVARIANT LOCKED: the exact contract hack/verify-boilerplate.sh depends on.
    # That wrapper holds NO extension list and makes no decision of its own: it
    # invokes boilerplate.py, reads STDOUT line by line into an array, and exits 1
    # when the array is non-empty, printing "Boilerplate header is wrong for:
    # <file>" to stderr for each entry.
    #
    # Three consequences are asserted, and every one of them would break the
    # wrapper if it changed:
    #   * main() returns 0 EVEN WITH OFFENDERS. The exit status is the wrapper's,
    #     not the checker's, so a checker that returned non-zero would abort the
    #     wrapper under `set -o errexit` before it could name the offenders.
    #   * each line is a BARE PATH - no prefix, no decoration, no surrounding
    #     whitespace - because the wrapper interpolates the line verbatim.
    #   * each line NAMES A FILE THAT EXISTS, so the message is actionable.
    _write(
        tmp_path,
        "python/tests/unit/tooling/broken.py",
        _corrupted(refs, "py"),
    )
    _write(tmp_path, "web/src/setupTests.ts", _conforming(refs, "ts"))

    return_code, reported = _run_gate(boilerplate, capsys, tmp_path)

    assert return_code == 0, (
        f"main() returned {return_code} with offenders present; it must return 0 so "
        "hack/verify-boilerplate.sh can read its stdout under `set -o errexit` and "
        "decide the exit status itself"
    )
    assert reported, (
        "main() reported no offenders although a corrupted header was planted; the "
        "wrapper would exit 0 and the bad header would reach the branch"
    )

    for line in reported:
        assert line == line.strip(), (
            f"the reported line {line!r} carries surrounding whitespace; the wrapper "
            "interpolates it verbatim into its message and into no further parsing"
        )
        assert not line.startswith("Boilerplate header is wrong for:"), (
            f"the reported line {line!r} is decorated; that wording belongs to "
            "hack/verify-boilerplate.sh, and emitting it here would double it"
        )
        assert Path(line).is_file(), (
            f"the reported line {line!r} does not name an existing file, so the "
            "wrapper's message would be unactionable"
        )


# ---------------------------------------------------------------------------
# 12. The self-check
# ---------------------------------------------------------------------------


def test_this_module_satisfies_the_gate_it_verifies(
    boilerplate: types.ModuleType,
    refs: dict[str, list[str]],
    regexs: dict[str, re.Pattern[str]],
) -> None:
    # INVARIANT LOCKED: this test file itself carries a conforming, year-less .py
    # Apache-2.0 header. The module is gated by the very tool it exercises, so the
    # cheapest possible proof of that is to point the tool at this file.
    #
    # `with_suffix(".py")` guards the case where __file__ names a compiled artifact
    # rather than the source.
    this_module = Path(__file__).resolve().with_suffix(".py")
    assert this_module.is_file(), (
        f"could not resolve this module's own source file from {__file__!r}"
    )

    assert bool(boilerplate.file_passes(str(this_module), refs, regexs)) is True, (
        f"{this_module.name} does not satisfy the header gate it verifies: its "
        "header has drifted from hack/boilerplate/boilerplate.py.txt, so "
        "hack/verify-boilerplate.sh - and therefore `make verify` - would fail on "
        "this very file. Fix the header to match the reference byte for byte, "
        "keeping it YEAR-LESS; never relax the checker"
    )

