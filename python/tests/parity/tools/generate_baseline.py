#!/usr/bin/env python3
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

"""Generator of the parity baseline manifest: what the Go oracle records TODAY.

The migration this repository is undergoing has exactly one stated success
criterion - "All tests should pass the same way as they pass today" - and that
sentence is a claim about outcomes, not about code. A claim about outcomes can
only be checked against a record of them, and before this file existed the only
record was a human-readable table in a Markdown document, which no comparator
can consume. This module produces the machine-readable record instead: it runs
the Go suite with ``go test -json -count=1 <packages>``, reduces the event
stream, and writes ``tests/parity/baseline/go_baseline.json``.

Everything downstream rests on that manifest. ``tests/parity/parity_map.py``
binds each recorded Go identity to its ported counterpart and
``tests/parity/test_parity_contract.py`` asserts completeness, verdict equality
and no-new-failure against it. So the single worst thing this file could do is
succeed quietly while recording less than the oracle actually reported: a short
manifest does not fail the gate, it EMPTIES it, and an empty gate reports green
forever. That is why almost every branch below ends in a raised
:class:`BaselineError` rather than a warning, a default or a shrug.

WHAT COUNTS AS A VERDICT, AND WHY IT MATTERS

``go test -json`` emits one JSON object per line with the fields ``Time``,
``Action``, ``Package``, ``Test``, ``Elapsed`` and ``Output``, plus extras that
newer toolchains add. A VERDICT is only a ``pass`` / ``fail`` / ``skip`` event
carrying a NON-EMPTY ``Test``. The same three actions without ``Test`` are
package-level summaries, and an ``output`` line is never a verdict no matter
what text it contains. Getting this wrong in either direction is fatal in a
quiet way: counting package summaries inflates the manifest with identities no
ported test can ever match, and reading verdicts out of ``output`` text invents
outcomes the toolchain never reported.

THE THREE ID RULES THAT CANNOT BE RELAXED

* Split ``Test`` on the FIRST ``/`` only. Subtest names in the measured scope
  contain ``/`` themselves - ``TestCreateMasterAuditPolicy`` names non-resource
  request paths such as ``/healthz/etcd`` (``audit_policy_test.go`` lines
  164-165 and the ``user.verb.object`` format at line 253), and
  ``TestAuditSensitiveResourceLevels`` prefixes each case with the API version
  ``audit.k8s.io/v1`` (``audit_test.go`` line 1005). Any other split silently
  truncates 282 measured identities.
* Preserve what Go emitted, byte for byte. Spaces are already ``_`` in the
  stream and duplicate siblings already carry ``#01`` / ``#02``. Normalising,
  trimming or prettifying an id breaks the join with ``parity_map.py``.
* Accept any non-empty ``Test``. ``Test_nodePlugin_Admit`` and its siblings in
  ``plugin/pkg/admission/noderestriction`` are legal Go tests with a lowercase
  character after ``Test``, so a ``Test[A-Z]`` assumption would drop them.

``Elapsed`` is recorded and never compared. Runtime is expected to differ
between Go and Python; the contract compares verdicts only.

THREE PROVENANCE ATOMS, NEVER CONFLATED, AND NEVER AVERAGED

``provenance`` is the honesty field of the manifest. It names how the rows were
obtained, using three atoms:

* ``go_test_json`` - the row came from a real oracle run.
* ``derived_from_source_inventory`` - the row came from the measured Go source
  inventory encoded in this module, because no Go toolchain was reachable.
* ``non_go_measured`` - the row is the one non-Go baseline case, the Python
  ``hack/boilerplate`` test, whose measured outcome the Go toolchain cannot
  report because it never runs it.

A manifest whose rows do not share one atom declares the COMPOSED value: the
atoms present, in the fixed order above, joined with ``+`` - so the ordinary
committed artifact reads ``go_test_json+non_go_measured``. That composed form
exists because the alternative was measurably worse: the manifest used to stamp
a single ``go_test_json`` while carrying the appended Python row, which made the
envelope FALSE for that row and, worse, made "every row came from Go" the thing
a reader would reasonably conclude about all of them. :func:`validate_manifest`
now cross-checks the declaration against the rows in both directions, so the
field cannot drift away from what it describes. Every atom is a legitimate input
to the contract; presenting one as another would not be.

COUPLING NOTE - READ BEFORE WIDENING THE PACKAGE LIST

Widening ``KUBE_PARITY_PACKAGES`` widens the manifest's domain, and every new
identity it admits is an identity ``parity_map.py`` has no counterpart for. The
completeness assertion in ``test_parity_contract.py`` will therefore FAIL until
that map is updated in the same change. That is the guard working, not a bug:
the map is explicit precisely so that a rename, an addition or a deletion cannot
slip past unnoticed. Narrowing the list is equally consequential in the other
direction, which is why this module refuses to write a manifest with no
verdicts and applies a declared cardinality guard to every package it does
cover.

WHAT THIS FILE DELIBERATELY DOES NOT DO

* It never writes to the Go tree. The Go suite is the parity ORACLE; no
  ``*_test.go`` is modified, moved, skipped or deleted, and ``go.mod``,
  ``go.sum``, ``go.work`` and ``vendor/`` are untouched, so the vendor
  verification gates keep passing unchanged.
* It never narrows the oracle with ``-run``. A filter that drops verdicts
  drops them from the manifest too, which is indistinguishable from the
  behaviour never having existed.
* It emits only the JSON manifest. JUnit XML for the parity phase belongs to
  ``hack/make-rules/test-parity.sh``, which is the sole entry point; this module
  adds no Make target and no second script.
* It writes no wall-clock timestamp. ``elapsed`` already churns between runs;
  a timestamp would add churn without information.

USAGE

Through the runner, which is how CI reaches it::

    make test-parity                       # or hack/make-rules/test-parity.sh
    KUBE_PARITY_PACKAGES="./cluster/gce/gci/ ./test/integration/auth/" make test-parity

Directly, for a subset or an already-captured stream::

    python3 tests/parity/tools/generate_baseline.py --packages ./cluster/gce/gci/
    go test -json -count=1 ./cluster/gce/gci/ > stream.json
    python3 tests/parity/tools/generate_baseline.py --event-stream stream.json
    python3 tests/parity/tools/generate_baseline.py --check   # validate, write nothing

As a library, which is how ``tests/parity/baseline/`` produces the committed
manifest rather than hand-writing it::

    from tests.parity.tools.generate_baseline import (
        PROVENANCE_DERIVED, PROVENANCE_NON_GO_MEASURED, build_manifest,
        compose_provenance, derive_verdicts_from_source_inventory,
        write_manifest_atomic,
    )

    verdicts = derive_verdicts_from_source_inventory(repo_root)
    manifest = build_manifest(
        verdicts,
        # Composed, not a single atom: `derive_verdicts_from_source_inventory`
        # appends the non-Go row by default, and a manifest carrying it may not
        # claim every row came from Go. `build_manifest` refuses one that does.
        provenance=compose_provenance(PROVENANCE_DERIVED, PROVENANCE_NON_GO_MEASURED),
    )
    write_manifest_atomic(manifest, path)
"""

# AAP §0.4.5 (the parity harness and this generator) / §0.5.1 (the
# tests/parity/tools/generate_baseline.py row) / §0.5.2.4 ("go_baseline.json is
# generated rather than hand-written, and tools/generate_baseline.py is the
# generator") / §0.2.1.9 gap 3 (no machine-readable baseline manifest exists) /
# tech-spec §6.6.3.2 (the required success rate is 100 percent with zero
# FAILURES, which is the invariant enforced here -- note that zero failures is
# NOT zero skips: the measured oracle legitimately skips 25 procMount cases
# whose ProcMountType feature gate is off, and AAP §0.10.3 requires the ported
# suite to skip exactly those, so they are recorded faithfully and pinned to an
# exact roster rather than refused).
#
# INVARIANT LOCKED BY THIS FILE: the manifest records EVERY verdict the Go
# oracle reported, with its identity preserved exactly as the toolchain spelled
# it, or the run fails. Nothing in this module may turn a missing verdict, an
# unreadable line, a duplicate identity or a non-zero oracle exit into a
# smaller-but-valid manifest, because a smaller-but-valid manifest is the one
# outcome that makes the whole parity gate pass vacuously.
#
# NOT COLLECTED AS A TEST, BY DESIGN. The file name matches neither `test_*.py`
# nor `*_test.py`, so pytest ignores it even though it lives under
# `testpaths = ["tests"]`; python/pyproject.toml additionally omits
# `tests/parity/tools/*` from coverage because this is a CLI a shell runner
# executes, never a module a test imports. Do not add a module-level function
# named `test_*` here, and do not add an `__init__.py` beside this file: the
# module resolves as `tests.parity.tools.generate_baseline` through PEP 420
# implicit namespace packages and the `pythonpath = ["."]` entry in
# python/pyproject.toml.

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

__all__ = [
    "DEFAULT_PACKAGES",
    "ENV_BASELINE_FILE",
    "ENV_BASELINE_FILE_ALIAS",
    "ENV_EXTRA_ARGS",
    "ENV_PACKAGES",
    "EXIT_BASELINE_ERROR",
    "EXIT_IO_ERROR",
    "EXIT_OK",
    "GO_MODULE_PATH",
    "GO_PROVENANCE_ATOMS",
    "MODE_AUTO",
    "MODE_DERIVED",
    "MODE_GO_TEST_JSON",
    "NON_GO_BASELINE_PACKAGE",
    "NON_GO_BASELINE_TEST",
    "NON_GO_PACKAGES",
    "PACKAGE_EXPECTATIONS",
    "PROVENANCE_ATOMS",
    "PROVENANCE_DERIVED",
    "PROVENANCE_GO_TEST_JSON",
    "PROVENANCE_NON_GO_MEASURED",
    "PROVENANCE_SEPARATOR",
    "SCHEMA_VERSION",
    "VERDICT_ACTIONS",
    "BaselineError",
    "PackageExpectation",
    "StreamReduction",
    "Verdict",
    "build_manifest",
    "check_domain_not_narrowed",
    "check_go_verdict_domain",
    "check_provenance_describes_rows",
    "compose_provenance",
    "default_baseline_path",
    "derive_verdicts_from_source_inventory",
    "go_rewrite_subtest_name",
    "import_path_for_package_spec",
    "is_non_go_package",
    "main",
    "reduce_event_stream",
    "repo_root_from_file",
    "run_go_test_json",
    "split_go_test_id",
    "split_package_specs",
    "split_provenance",
    "validate_manifest",
    "write_manifest_atomic",
]


# ---------------------------------------------------------------------------
# Schema identity
# ---------------------------------------------------------------------------

#: The manifest shape this module reads and writes. Three consumers join on it -
#: `tests/conftest.py`'s `parity_baseline` fixture, `tests/parity/conftest.py`'s
#: `parity_baseline_index` and `tests/integration/test_auth_package_parity.py`'s
#: roster guard - so it is bumped only when the shape changes in a way that
#: would break them, never for an additive clarification.
SCHEMA_VERSION: Final[str] = "1"

#: The row came from a real `go test -json` event stream.
PROVENANCE_GO_TEST_JSON: Final[str] = "go_test_json"

#: The row came from the measured Go source inventory in this module, because no
#: Go toolchain was reachable. Recorded rather than hidden: a contract that
#: cannot tell measured data from derived data cannot be trusted about either.
PROVENANCE_DERIVED: Final[str] = "derived_from_source_inventory"

#: The row is the one non-Go baseline case - the Python `hack/boilerplate` test,
#: measured by the `unittest` runner ("Ran 1 test in 0.001s / OK") rather than by
#: `go test`. It exists as its own atom because the two Go atoms are both claims
#: about a GO run, and this row was never part of one: stamping it `go_test_json`
#: was false about the row and misleading about the manifest.
PROVENANCE_NON_GO_MEASURED: Final[str] = "non_go_measured"

#: The atoms, in the order a composed value lists them. Order is fixed rather
#: than sorted alphabetically so that `provenance` is byte-stable across runs and
#: a regeneration diff stays legible.
PROVENANCE_ATOMS: Final[tuple[str, ...]] = (
    PROVENANCE_GO_TEST_JSON,
    PROVENANCE_DERIVED,
    PROVENANCE_NON_GO_MEASURED,
)

#: The two atoms that describe a GO row. Exactly one of them may appear in any
#: single manifest: a run either measured the oracle or it did not, and a
#: manifest claiming both would be describing two different domains at once.
GO_PROVENANCE_ATOMS: Final[frozenset[str]] = frozenset(
    {PROVENANCE_GO_TEST_JSON, PROVENANCE_DERIVED}
)

#: Joins the atoms of a composed provenance. `+` and not `,` or ` `: it survives
#: a shell argument, a log line and a JSON string with no quoting, and it reads
#: as addition rather than as a list whose order might matter.
PROVENANCE_SEPARATOR: Final[str] = "+"

#: The only actions that are verdicts. `start`, `run`, `pause`, `cont`, `bench`
#: and `output` are progress, not outcome.
VERDICT_ACTIONS: Final[frozenset[str]] = frozenset({"pass", "fail", "skip"})

#: Go's own name for `TestMain`, which is a package entry point rather than a
#: test: it takes `*testing.M`, emits no verdict event of its own, and has its
#: outcome folded into the package-level event. Measured in all three ported
#: integration packages - `test/integration/auth/main_test.go` line 27,
#: `test/integration/secrets/main_test.go` line 25 and
#: `test/integration/controlplane/audit/main_test.go` line 25 - each declaring
#: `framework.EtcdMain(m.Run)`. Filtered defensively even though a conforming
#: stream never reports it.
_TEST_MAIN: Final[str] = "TestMain"

#: The Go module path, from the `module` directive of the repository's go.mod.
#: Used to turn a relative package pattern such as `./cluster/gce/gci/` - which
#: is what the runner passes - into the import path `go test -json` reports in
#: its `Package` field.
GO_MODULE_PATH: Final[str] = "k8s.io/kubernetes"


# ---------------------------------------------------------------------------
# The runner contract
# ---------------------------------------------------------------------------
# These names belong to hack/make-rules/test-parity.sh. They are read here, not
# defined here, and are deliberately not renamed.

#: The Go oracle package list. The runner defaults it to `./cluster/gce/gci/`
#: and expands it UNQUOTED into a single `--packages` flag, which is why
#: `--packages` accepts several values at once as well as being repeatable.
ENV_PACKAGES: Final[str] = "KUBE_PARITY_PACKAGES"

#: The output manifest path. This is the spelling the committed runner actually
#: uses (`hack/make-rules/test-parity.sh` line 42), so it wins.
ENV_BASELINE_FILE: Final[str] = "KUBE_PARITY_BASELINE"

#: The same setting under the spelling the plan documents. Honoured as a
#: fallback so that either name works and neither silently does nothing;
#: `ENV_BASELINE_FILE` takes precedence when both are set.
ENV_BASELINE_FILE_ALIAS: Final[str] = "KUBE_PARITY_BASELINE_FILE"

#: Extra arguments forwarded to `go test`. Split on whitespace, appended after
#: the flags this module supplies and before the package list.
ENV_EXTRA_ARGS: Final[str] = "KUBE_PARITY_ARGS"

# DELIBERATELY NOT READ HERE: the runner's baseline-skip switch
# (`KUBE_PARITY_SKIP_REGEN`, line 43). When it is set the runner does not invoke
# this script at all, so honouring it here would add a second, competing
# mechanism whose only possible effect is to make a DIRECT invocation exit 0
# having written nothing - the silent no-op this module exists to prevent.
# Correctness never depends on this script having run before: it reads no state
# it wrote, and leaves none behind beyond the manifest itself.


# ---------------------------------------------------------------------------
# Modes and exit codes
# ---------------------------------------------------------------------------

#: Invoke or read a real `go test -json` stream. Fails if none is obtainable.
MODE_GO_TEST_JSON: Final[str] = "go-test-json"

#: Build from the measured source inventory encoded in this module.
#:
#: A DIAGNOSTIC, NEVER A BASELINE. Its rows are read off Go SOURCE and every one of
#: them is stamped `pass`, because reading a function's name cannot tell you what it
#: did. It is useful for answering "does the inventory in this module still match
#: the source tree?" and it is worthless as evidence of behaviour - which is the
#: whole of the engagement's success criterion. It therefore requires
#: `--allow-derived-baseline`, it can never be written over the committed manifest,
#: and `--check` refuses its provenance outright.
MODE_DERIVED: Final[str] = "derived"

#: Require a real run: `go-test-json` when a toolchain is available, and a HARD
#: ERROR when it is not.
#:
#: This mode used to fall back to `derived`, and that fallback is the one bug in
#: this file that could invalidate the entire migration: on any machine without Go
#: on PATH - a container, a CI step that forgot to load the toolchain - the DEFAULT
#: invocation manufactured an all-green baseline from source and wrote it to the
#: committed path, and the parity contract then certified the port against it.
#: Nothing about that outcome looked wrong: the file was well formed, the
#: provenance field said `derived` in the one place nobody was reading, and every
#: assertion passed. AAP §0.11.1 puts the requirement plainly - "Nothing is
#: declared migrated until the baseline says so", proof by EXECUTION and not by
#: reading source - so the absence of a toolchain is now reported as the blocker it
#: is.
MODE_AUTO: Final[str] = "auto"

#: Success.
EXIT_OK: Final[int] = 0

#: A :class:`BaselineError` - any of the fail-loud conditions.
EXIT_BASELINE_ERROR: Final[int] = 1

#: An operating-system failure: unreadable stream, unwritable output. 2 is left
#: to argparse, which uses it for a usage error and exits on its own.
EXIT_IO_ERROR: Final[int] = 3

#: Prefix for every progress and error line. Progress goes to stderr so stdout
#: stays clean for a future machine consumer.
_LOG_PREFIX: Final[str] = "generate_baseline:"

#: How much of an unparsable line to quote back. Long enough to identify the
#: line, short enough that a corrupt multi-megabyte stream cannot flood a log.
_EXCERPT_LIMIT: Final[int] = 200


# ---------------------------------------------------------------------------
# The measured baseline scope
# ---------------------------------------------------------------------------
# The packages whose verdicts the baseline records, as Go package patterns so
# they can be handed to `go test` unchanged. This is the built-in default; the
# runner overrides it through KUBE_PARITY_PACKAGES and normally narrows it to
# the shell tier, which needs no etcd and no built apiserver.
#
# Order is the order the plan enumerates them: the shell-boundary package, the
# three integration packages, then the four mechanism unit packages. The
# manifest itself is sorted by import path, so this order affects only the
# oracle invocation.
#
# NARROWING THIS LIST NARROWS THE GATE, and that is not a figure of speech: the
# contract is quantified over the recorded verdicts, so a manifest regenerated
# over one package asserts nothing whatever about the other seven while still
# validating and still reporting green. The committed manifest is the FULL domain -
# 3104 Go verdicts from a real `--mode go-test-json` capture of all eight packages,
# among them 2136 `test/integration/auth` subtests, 640 shell-tier subtests and 239
# `noderestriction` subtests. A run that narrows the list AND writes to the
# committed path is therefore warned about explicitly by
# `check_domain_not_narrowed`, which REFUSES it unless --allow-narrow-domain is
# passed; narrow regenerations belong in a scratch `--output`.

DEFAULT_PACKAGES: Final[tuple[str, ...]] = (
    "./cluster/gce/gci/",
    "./test/integration/auth/",
    "./test/integration/secrets/",
    "./test/integration/controlplane/audit/",
    "./plugin/pkg/auth/authorizer/rbac/",
    "./plugin/pkg/auth/authorizer/rbac/bootstrappolicy/",
    "./plugin/pkg/admission/security/podsecurity/",
    "./plugin/pkg/admission/noderestriction/",
)

#: The pseudo-package under which the one non-Go baseline row is recorded. NOT a
#: `k8s.io/...` import path, deliberately: the case it names is a Python test,
#: `hack/boilerplate/boilerplate_test.py`. It belongs in the manifest because the
#: plan's baseline scale ends with "and the single Python boilerplate case", and
#: `parity_map.py` binds it as its `NON_GO_BASELINE` entry. Exported so that map
#: can single-source the spelling instead of re-typing it.
#:
#: The row's verdict is MEASURED by running the case (see
#: :func:`_non_go_baseline_verdict`), not asserted from this constant.
NON_GO_BASELINE_PACKAGE: Final[str] = "hack/boilerplate"

#: The identity of that case, matching the ported node id
#: `hack/boilerplate/boilerplate_test.py::test_boilerplate`.
NON_GO_BASELINE_TEST: Final[str] = "test_boilerplate"

#: Every package the manifest may carry that is NOT a Go import path. Declared
#: rather than inferred, because "is this row from a Go run?" is the question the
#: `provenance` cross-check answers, and a rule that guessed from the spelling of
#: a path would answer it differently the day a second non-Go tier appears.
NON_GO_PACKAGES: Final[frozenset[str]] = frozenset({NON_GO_BASELINE_PACKAGE})


class BaselineError(Exception):
    """A condition that must abort baseline generation rather than shrink it.

    Every raise site in this module answers the same question the same way: is
    there any chance this makes the manifest smaller, wronger or less honest than
    the oracle's actual report? If yes, it raises. :func:`main` maps this to
    :data:`EXIT_BASELINE_ERROR`.

    The message is the whole value of the exception, so each one names the
    concrete thing that went wrong - the package, the identity, the path, the
    count, the exit code - because the reader of a CI failure is usually not the
    author of the test that failed.
    """


@dataclass(frozen=True, slots=True)
class Verdict:
    """One outcome the oracle reported, keyed the way the parity contract joins.

    INVARIANT LOCKED: the identity Go emitted survives the round trip. ``test``
    plus ``subtest`` recompose into the raw ``Test`` field byte for byte through
    :attr:`go_id`, so no information is lost by splitting them and none is
    invented by rejoining them.

    Frozen and slotted: the tuple of these that :func:`reduce_event_stream`
    returns is safe to share, and an accidental mutation cannot silently rewrite
    a recorded outcome.

    Attributes:
        package: The Go import path from the event's ``Package`` field, or
            :data:`NON_GO_BASELINE_PACKAGE` for the one non-Go row.
        test: The top-level identity - everything before the first ``/``.
        subtest: Everything after the first ``/``, or ``""`` for a top-level
            verdict. May itself contain ``/``; see :func:`split_go_test_id`.
        action: One of :data:`VERDICT_ACTIONS`.
        elapsed: Seconds, as the stream reported them. ``0.0`` when a verdict
            event carried no ``Elapsed``, and ``None`` in derived mode where no
            duration was measured at all - a fabricated zero would read as a
            measurement. RECORDED, NEVER COMPARED: runtime is expected to differ
            between Go and Python, so the contract compares verdicts only.
    """

    package: str
    test: str
    subtest: str
    action: str
    elapsed: float | None

    @property
    def go_id(self) -> str:
        """The raw ``Test`` field this verdict came from.

        INVARIANT LOCKED: the split is lossless. For the proven representative
        row, ``Verdict(package="k8s.io/kubernetes/cluster/gce/gci",
        test="TestServerOverride",
        subtest="ETCD-SERVERS_is_not_set_-_default_override", ...).go_id`` is
        ``"TestServerOverride/ETCD-SERVERS_is_not_set_-_default_override"``
        exactly.
        """
        if not self.subtest:
            return self.test
        return f"{self.test}/{self.subtest}"

    @property
    def triple(self) -> tuple[str, str, str]:
        """``(package, test, subtest)`` - the uniqueness key and the sort key.

        INVARIANT LOCKED: two verdicts sharing a triple are a defect, not a pair.
        `parity_map.py` and `parity_baseline_index` both key on it, so a
        duplicate would make one of the two rows unreachable and unprovable.
        """
        return (self.package, self.test, self.subtest)

    @property
    def is_top_level(self) -> bool:
        """Whether this is a test function's own verdict rather than a subtest's.

        Go reports a verdict for the parent as well as for each subtest, which is
        why the measured shell package totals 648 = 8 top-level + 640 subtests.
        """
        return not self.subtest

    def to_row(self) -> dict[str, object]:
        """The manifest row: exactly five keys, in the pinned schema.

        INVARIANT LOCKED: the row shape. `parity_baseline_index` treats an extra
        key as churn and a missing key as malformed, so this is the one place the
        row is constructed and :func:`validate_manifest` re-checks the result.
        """
        return {
            "package": self.package,
            "test": self.test,
            "subtest": self.subtest,
            "action": self.action,
            "elapsed": self.elapsed,
        }


# ---------------------------------------------------------------------------
# Provenance: the honesty field, and the rules that keep it true
# ---------------------------------------------------------------------------


def is_non_go_package(package: str) -> bool:
    """Whether ``package`` names a non-Go tier rather than a Go import path.

    INVARIANT LOCKED: the Go / non-Go split is DECLARED, and an undeclared
    non-import-path package is an error rather than a silent Go row. The
    declaration is :data:`NON_GO_PACKAGES`; the structural test - a Go import path
    begins with a dotted domain segment, as every ``k8s.io/...`` path does - is
    applied only to catch a package that is plainly not an import path yet was
    never declared. Without that second half, adding a second pseudo-package
    would classify it as Go and the ``non_go_measured`` atom would go missing
    from a manifest that needed it, which is the exact defect this whole
    mechanism exists to prevent.

    Args:
        package: The package field of a row.

    Returns:
        True for a declared non-Go package.

    Raises:
        BaselineError: If ``package`` is undeclared and does not look like a Go
            import path.
    """
    if package in NON_GO_PACKAGES:
        return True
    first_segment = package.split("/", 1)[0]
    if "." not in first_segment:
        raise BaselineError(
            f"package {package!r} is neither a declared non-Go package "
            f"({sorted(NON_GO_PACKAGES)}) nor a Go import path - a Go import path opens "
            f"with a dotted domain segment such as {GO_MODULE_PATH.split('/', 1)[0]!r}, and "
            f"{first_segment!r} has no dot. Classifying it as Go would let a non-Go row be "
            f"recorded as measured Go output. Declare it in NON_GO_PACKAGES, in the same "
            f"change that adds the tier it belongs to."
        )
    return False


def compose_provenance(*atoms: str) -> str:
    """Compose the manifest-level ``provenance`` from the atoms actually used.

    INVARIANT LOCKED: the envelope names EVERY way its rows were obtained, and
    names them in a fixed order so two runs over the same domain produce the same
    string. A single-atom manifest keeps its plain atom - ``go_test_json`` still
    means exactly what it always meant - so nothing that reads the homogeneous
    form has to change; only a genuinely mixed manifest reads
    ``go_test_json+non_go_measured``.

    Args:
        *atoms: Atoms from :data:`PROVENANCE_ATOMS`. Repeats are collapsed;
            empty strings and ``None``-like values are rejected rather than
            skipped, because a caller that lost track of one atom must not
            silently produce a narrower claim.

    Returns:
        The atom itself when there is one, else the atoms joined by
        :data:`PROVENANCE_SEPARATOR` in :data:`PROVENANCE_ATOMS` order.

    Raises:
        BaselineError: On no atoms, an unknown atom, or both Go atoms at once.
    """
    unknown = sorted({atom for atom in atoms if atom not in PROVENANCE_ATOMS})
    if unknown:
        raise BaselineError(
            f"unknown provenance atom(s) {unknown}: expected values from "
            f"{list(PROVENANCE_ATOMS)}. This field is how a reader tells measured data from "
            f"derived data, so it may not be improvised."
        )
    present = set(atoms)
    if not present:
        raise BaselineError(
            "refusing to compose an EMPTY provenance: a manifest that does not say how its "
            "rows were obtained cannot be told apart from one whose rows were invented."
        )
    go_atoms = sorted(present & GO_PROVENANCE_ATOMS)
    if len(go_atoms) > 1:
        raise BaselineError(
            f"a manifest may declare at most one Go provenance atom, got {go_atoms}. A run "
            f"either measured the oracle or expanded the source inventory; claiming both "
            f"would describe two different domains in one artifact, and a reader could not "
            f"tell which rows belonged to which."
        )
    return PROVENANCE_SEPARATOR.join(
        atom for atom in PROVENANCE_ATOMS if atom in present
    )


def split_provenance(value: object) -> tuple[str, ...]:
    """Decompose a manifest ``provenance`` value into its atoms.

    INVARIANT LOCKED: the composed form round-trips through
    :func:`compose_provenance` unchanged, so a hand-edited value that merely
    LOOKS plausible - reordered, repeated, padded, or naming an unknown atom - is
    refused rather than half-understood.

    Args:
        value: The envelope's ``provenance`` field, as decoded from JSON.

    Returns:
        The atoms, in :data:`PROVENANCE_ATOMS` order.

    Raises:
        BaselineError: If ``value`` is not a string, or is not exactly what
            :func:`compose_provenance` would have produced for its atoms.
    """
    if not isinstance(value, str) or not value:
        raise BaselineError(
            f"provenance must be a non-empty string composed from {list(PROVENANCE_ATOMS)}, "
            f"got {value!r}"
        )
    atoms = tuple(value.split(PROVENANCE_SEPARATOR))
    canonical = compose_provenance(*atoms)
    if canonical != value:
        raise BaselineError(
            f"provenance {value!r} is not in canonical form: expected {canonical!r}. The "
            f"atoms are listed in a fixed order, without repeats and without padding, so "
            f"that the field is byte-stable across regenerations."
        )
    return tuple(atom for atom in PROVENANCE_ATOMS if atom in set(atoms))


def check_provenance_describes_rows(provenance: str, verdicts: Sequence[Verdict]) -> None:
    """Require the declared ``provenance`` to describe the rows, in both directions.

    INVARIANT LOCKED: the honesty field cannot drift away from the rows it
    describes. Two directions, because each catches a different lie:

    1. A NON-GO ROW WITH NO ``non_go_measured`` ATOM. This is the recorded defect:
       the committed manifest carried the Python ``hack/boilerplate`` row while
       declaring ``go_test_json`` alone, so the envelope was false about that row
       and misleading about every other one.
    2. A ``non_go_measured`` ATOM WITH NO NON-GO ROW. The mirror image, and just
       as bad in a quieter way - a reader would believe the Python case is
       recorded, and the parity contract quantifies over the ROWS, so the case
       would be asserted about by nothing at all.

    A Go atom is likewise required whenever any Go row is present, because those
    rows had to come from somewhere and only the two Go atoms say where.

    Args:
        provenance: The composed value about to be written, or read back.
        verdicts: The rows it claims to describe.

    Raises:
        BaselineError: On any of the three mismatches, naming the offending rows.
    """
    atoms = set(split_provenance(provenance))
    non_go_rows = [verdict for verdict in verdicts if is_non_go_package(verdict.package)]
    go_rows = [verdict for verdict in verdicts if not is_non_go_package(verdict.package)]

    if non_go_rows and PROVENANCE_NON_GO_MEASURED not in atoms:
        raise BaselineError(
            f"{len(non_go_rows)} row(s) come from a non-Go package "
            f"({sorted({v.package for v in non_go_rows})}) but provenance {provenance!r} does "
            f"not include {PROVENANCE_NON_GO_MEASURED!r}. `go test -json` cannot report a "
            f"Python verdict, so declaring a Go-only provenance over these rows states "
            f"something untrue about them and invites the reader to believe it about all of "
            f"them. Compose the provenance with compose_provenance()."
        )
    if PROVENANCE_NON_GO_MEASURED in atoms and not non_go_rows:
        raise BaselineError(
            f"provenance {provenance!r} declares {PROVENANCE_NON_GO_MEASURED!r} but no row "
            f"comes from a non-Go package ({sorted(NON_GO_PACKAGES)}). The parity contract is "
            f"quantified over the ROWS, so a case that is announced in the envelope and "
            f"absent from the rows is asserted about by nothing."
        )
    if go_rows and not (atoms & GO_PROVENANCE_ATOMS):
        raise BaselineError(
            f"provenance {provenance!r} names no Go atom "
            f"({sorted(GO_PROVENANCE_ATOMS)}) yet {len(go_rows)} row(s) come from Go "
            f"packages ({sorted({v.package for v in go_rows})[:5]}). Those rows were either "
            f"measured or derived, and the manifest must say which."
        )


@dataclass(frozen=True, slots=True)
class PackageExpectation:
    """A declared cardinality guard for one package.

    INVARIANT LOCKED: a measured count changes only through an explicit edit
    here. Silent drift is exactly the failure this guard exists to catch - a
    build that stops compiling one test file, a filter that quietly excludes a
    matrix, a rename that halves a subtest count. Any field left ``None`` is
    deliberately unconstrained, which is how a package whose subtest cardinality
    was never measured avoids being pinned to a number nobody counted.

    WHICH FIELDS APPLY IN WHICH MODE, AND WHY THAT DIFFERS. ``top_level`` is
    knowable from Go SOURCE - it is the ``^func Test`` roster minus ``TestMain`` -
    so it is enforced against measured AND derived rows alike. ``total``,
    ``subtests`` and ``subtest_counts`` describe verdicts a run EMITS, and the
    names of most subtests are computed at runtime from table data, so derived
    mode cannot enumerate them without inventing them; those three are therefore
    enforced only against rows whose provenance is
    :data:`PROVENANCE_GO_TEST_JSON`. The distinction is not a loophole - it is
    what lets derived mode stay honest about being a roster while a measured
    manifest is held to the full emitted domain, which is precisely the shortfall
    that let 239 noderestriction subtests and 8 ``TestAudit`` subtests go missing
    from a manifest that nonetheless declared itself measured.

    Attributes:
        total: Required number of verdicts, or ``None``. Measured rows only.
        top_level: Required number of top-level identities, or ``None``. Both modes.
        subtests: Required number of subtest verdicts, or ``None``. Measured only.
        subtest_counts: Required subtest count for each named top-level FAMILY as
            ``(family, count)`` pairs in declaration order, or ``None`` to leave
            the per-family split unconstrained. Measured rows only. A tuple of
            pairs rather than a dict because this is module-level state shared by
            every caller and every pytest-xdist worker: an immutable declaration
            cannot be edited by one reader and observed by another. A family
            declared here and absent from the rows is a failure - that is the
            guard that catches a whole matrix vanishing - and a family present in
            the rows but undeclared is a failure too, because a new test function
            changes the domain the parity map has to cover.
        passes: Required number of ``pass`` verdicts, or ``None``.
        skips: Required number of ``skip`` verdicts, or ``None``. Pinned to an
            EXACT number rather than to zero, because the measured baseline is not
            uniformly all-pass: ``test/integration/auth`` really does skip 25
            subtests today, and "pass the same way as they pass today" means a
            skip must stay a skip. Pinning the count is what makes a NEW skip - a
            test that silently stopped running - a failure, while the 25 that are
            genuinely skipped remain recordable.
        note: Where the numbers come from, quoted in the failure message so the
            reader can re-measure rather than guess.
    """

    total: int | None = None
    top_level: int | None = None
    subtests: int | None = None
    subtest_counts: tuple[tuple[str, int], ...] | None = None
    passes: int | None = None
    skips: int | None = None
    note: str = ""


#: The declared, overridable cardinality guards - one per package the baseline
#: covers, and one per subtest FAMILY within it.
#:
#: EVERY NUMBER HERE WAS MEASURED, not quoted. Two commands produced all of them,
#: and re-running either reproduces them:
#:
#:     go test -json -count=1 ./cluster/gce/gci/ \
#:         ./plugin/pkg/auth/authorizer/rbac/ \
#:         ./plugin/pkg/auth/authorizer/rbac/bootstrappolicy/ \
#:         ./plugin/pkg/admission/security/podsecurity/ \
#:         ./plugin/pkg/admission/noderestriction/
#:     go test -json -count=1 -p 1 -timeout 30m ./test/integration/secrets/ \
#:         ./test/integration/auth/ ./test/integration/controlplane/audit/
#:
#: WHY EVERY PACKAGE IS PINNED NOW. Two entries used to be pinned and six were not,
#: and the six unpinned ones were exactly where the baseline was wrong: the manifest
#: recorded ``test/integration/auth`` as 43 verdicts when the package actually emits
#: 2,179, because only its top-level identities had ever been enumerated and its
#: 2,136 subtests were absent altogether. A missing subtest is the most dangerous
#: kind of gap this artifact can have - the parity contract's completeness assertion
#: walks the baseline, so an identity that is not IN the baseline is never required
#: of the ported suite, and its absence is indistinguishable from a behaviour that
#: never existed. Pinning the cardinality of every package is what makes that gap
#: impossible to reopen quietly.
#:
#: WHY THE PER-FAMILY SPLIT EXISTS AS WELL. Package totals alone were measurably
#: insufficient: a manifest that recorded the five `noderestriction` parents and
#: none of their 239 subtests, and the two `controlplane/audit` parents without
#: `TestAudit`'s 8, satisfied every guard that existed because no guard named a
#: family. So the split is now declared: a family that emitted nothing, emitted a
#: different number, or appeared without being declared all abort. `subtest_counts`
#: is exhaustive per package - families with no subtests are declared as 0 rather
#: than omitted, so "declared but absent" and "present but undeclared" are both
#: decidable.
#:
#: The reduction, measured: 3,104 verdicts across 8 Go packages - 79 top-level and
#: 3,025 subtests - of which 3,079 pass and 25 skip, with zero failures, plus the
#: one measured non-Go row. The ``cluster/gce/gci`` per-function subtest split is
#: 2/2/2/2/0/2/10/620 (``TestEncryptionProviderConfig`` is flat and declares no
#: ``t.Run`` at all, which is why one of the eight contributes no subtest).
#: ``test/integration/auth``'s subtest count is dominated by three 686-case tables:
#: ``TestPodSecurity``, ``TestPodSecurityGAOnly`` and ``TestPodSecurityWebhook``.
#:
#: WHAT THE 25 SKIPS ARE, named so a 26th is a question rather than a shrug.
#: `TestPodSecurityGAOnly` (test/integration/auth/podsecurity_test.go:78) disables
#: every alpha and beta feature gate, and `podsecuritytest.Run`
#: (staging/src/k8s.io/pod-security-admission/test/run.go:398-401) calls
#: `t.Skipf("features required for failure cases are disabled: %v", ...)` for any
#: `_fail_<check>` subtest whose failure cases need a disabled gate - the 24
#: `_fail_procMount` subtests plus one `_fail_procMount_restricted`. AAP §0.10.3
#: requires a skipped test to stay skipped, so they are recorded verbatim and both
#: their count and their family are pinned. That split is FEATURE-GATE DEPENDENT and
#: the pin is deliberate about it: a run with ProcMountType enabled reports the same
#: 43 identities and the same 2,179 verdicts with those 25 rows as `pass`. Pinning
#: `skips` therefore refuses a regeneration taken under different gates, which is the
#: intended behaviour rather than a limitation - the baseline is the record of how
#: THIS checkout behaves under its DEFAULT gates, and a differently gated capture is a
#: different measurement wearing the same name. :func:`_check_cardinality` says so in
#: its diagnostic, so the operator is told which of the two they are looking at.
#:
#: `total`, `subtests` and `subtest_counts` are enforced against MEASURED Go rows
#: only; `top_level` is enforced always. See :class:`PackageExpectation` for why.
PACKAGE_EXPECTATIONS: Final[Mapping[str, PackageExpectation]] = {
    f"{GO_MODULE_PATH}/cluster/gce/gci": PackageExpectation(
        total=648,
        top_level=8,
        subtests=640,
        subtest_counts=(
            ("TestAppendOrReplacePrefix", 10),
            ("TestCreateMasterAuditPolicy", 620),
            ("TestEncryptionProviderConfig", 0),
            ("TestEncryptionProviderFlag", 2),
            ("TestKMSIntegration", 2),
            ("TestServerOverride", 2),
            ("TestStorageOptions", 2),
            ("TestTLSFlags", 2),
        ),
        passes=648,
        skips=0,
        note=(
            "measured: reduces to 648 verdicts (8 top-level + 640 subtests), per function "
            "2/2/2/2/0/2/10/620. TestEncryptionProviderConfig is flat and declares no "
            "t.Run at all, which is why one of the eight contributes no subtest"
        ),
    ),
    f"{GO_MODULE_PATH}/test/integration/auth": PackageExpectation(
        total=2179,
        top_level=43,
        subtests=2136,
        subtest_counts=(
            ("TestAliceNotForbiddenOrUnauthorized", 0),
            ("TestAuthModeAlwaysAllow", 0),
            ("TestAuthModeAlwaysDeny", 0),
            ("TestAuthnToKAS", 2),
            ("TestAuthorizationAttributeDetermination", 0),
            ("TestAuthzConfig", 0),
            ("TestBobIsForbidden", 0),
            ("TestBootstrapTokenAuth", 3),
            ("TestBootstrapping", 0),
            ("TestConstrainedImpersonation", 4),
            ("TestConstrainedImpersonationDisabled", 2),
            ("TestDiscoveryUpgradeBootstrapping", 0),
            ("TestDynamicClientBuilder", 0),
            ("TestGetsSelfAttributes", 8),
            ("TestGetsSelfAttributesError", 2),
            ("TestImpersonateIsForbidden", 0),
            ("TestImpersonateWithUID", 3),
            ("TestKindAuthorization", 0),
            ("TestLocalSubjectAccessReview", 0),
            ("TestMonitoringURLs", 1),
            ("TestMultiWebhookAuthzConfig", 0),
            ("TestNamespaceAuthorization", 0),
            ("TestNodeAuthorizer", 0),
            ("TestNodeRestrictionCrossNodeDenied", 0),
            ("TestNodeRestrictionServiceAccount", 5),
            ("TestNodeRestrictionServiceAccountAudience", 23),
            ("TestPodSecurity", 686),
            ("TestPodSecurityEnforceBaselineRejectsPrivileged", 0),
            ("TestPodSecurityGAOnly", 686),
            ("TestPodSecurityWebhook", 686),
            ("TestRBAC", 4),
            ("TestRBACContextContamination", 0),
            ("TestRBACNoWildcardOutsideSystemMasters", 0),
            ("TestReadOnlyAuthorization", 0),
            ("TestSelfSubjectAccessReview", 0),
            ("TestServiceAccountAnnotationDeprecation", 1),
            ("TestServiceAccountTokenBoundAndAudienced", 0),
            ("TestServiceAccountTokenCreate", 20),
            ("TestSloppySANCertificates", 0),
            ("TestSubjectAccessReview", 0),
            ("TestUnknownUserIsUnauthorized", 0),
            ("TestWebhookTokenAuthenticator", 0),
            ("TestWebhookTokenAuthenticatorCustomDial", 0),
        ),
        passes=2154,
        skips=25,
        note=(
            "measured: 2179 verdicts. 43 top-level identities - 44 '^func Test' "
            "declarations minus TestMain (main_test.go:27), which emits no verdict event - "
            "and 2136 subtests, of which 25 TestPodSecurityGAOnly procMount cases report "
            "skip while the package still passes. Three tables dominate the subtests at "
            "686 each: TestPodSecurity, TestPodSecurityGAOnly, TestPodSecurityWebhook"
        ),
    ),
    f"{GO_MODULE_PATH}/test/integration/secrets": PackageExpectation(
        total=2,
        top_level=2,
        subtests=0,
        subtest_counts=(
            ("TestSecrets", 0),
            ("TestSecretsAreEncryptedAtRest", 0),
        ),
        passes=2,
        skips=0,
        note=(
            "measured: 2 flat top-level verdicts, TestSecrets and "
            "TestSecretsAreEncryptedAtRest, no t.Run anywhere; TestMain excluded"
        ),
    ),
    f"{GO_MODULE_PATH}/test/integration/controlplane/audit": PackageExpectation(
        total=12,
        top_level=2,
        subtests=10,
        subtest_counts=(
            ("TestAudit", 8),
            ("TestAuditSensitiveResourceLevels", 2),
        ),
        passes=12,
        skips=0,
        note=(
            "measured: 12 verdicts (2 top-level + 10 subtests). TestAudit contributes 8 "
            "subtests (audit_test.go t.Run at lines 398 and 405) and "
            "TestAuditSensitiveResourceLevels 2, the latter parametrized over audit versions "
            "and spelling the API version into the id - which is why the id split takes the "
            "first separator only"
        ),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/auth/authorizer/rbac": PackageExpectation(
        total=3,
        top_level=3,
        subtests=0,
        subtest_counts=(
            ("TestAuthorizer", 0),
            ("TestRuleMatches", 0),
            ("TestSubjectLocator", 0),
        ),
        passes=3,
        skips=0,
        note=(
            "measured: 3 flat verdicts"
        ),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/auth/authorizer/rbac/bootstrappolicy": PackageExpectation(
        total=15,
        top_level=15,
        subtests=0,
        subtest_counts=(
            ("TestBootstrapClusterRoleBindings", 0),
            ("TestBootstrapClusterRoles", 0),
            ("TestBootstrapClusterRolesWithFeatureGatesEnabled", 0),
            ("TestBootstrapControllerRoleBindings", 0),
            ("TestBootstrapControllerRoles", 0),
            ("TestBootstrapNamespaceRoleBindings", 0),
            ("TestBootstrapNamespaceRoles", 0),
            ("TestClusterRoleLabel", 0),
            ("TestClusterRoleVerbsConsistency", 0),
            ("TestControllerRoleLabel", 0),
            ("TestControllerRoleVerbsConsistency", 0),
            ("TestEditViewRelationship", 0),
            ("TestNamespaceRoleVerbsConsistency", 0),
            ("TestNoStarsForControllers", 0),
            ("TestNodeRuleVerbsConsistency", 0),
        ),
        passes=15,
        skips=0,
        note=(
            "measured: 15 flat verdicts"
        ),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/admission/security/podsecurity": PackageExpectation(
        total=1,
        top_level=1,
        subtests=0,
        subtest_counts=(
            ("TestConvert", 0),
        ),
        passes=1,
        skips=0,
        note=(
            "measured: 1 flat verdict"
        ),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/admission/noderestriction": PackageExpectation(
        total=244,
        top_level=5,
        subtests=239,
        subtest_counts=(
            ("TestAdmitPVCStatus", 10),
            ("TestAdmitResourceSlice", 30),
            ("Test_getModifiedLabels", 10),
            ("Test_nodePlugin_Admit", 178),
            ("Test_nodePlugin_Admit_OwnerReference", 11),
        ),
        passes=244,
        skips=0,
        note=(
            "measured: 244 verdicts (5 top-level + 239 subtests). Three identities carry a "
            "lowercase character after 'Test', which is legal Go and the reason nothing "
            "here assumes a Test[A-Z] shape. Some ids nest a second '/' "
            "(TestAdmitResourceSlice/<case>/<case>). The subtests were absent from the "
            "manifest entirely before this pin"
        ),
    ),
    NON_GO_BASELINE_PACKAGE: PackageExpectation(
        total=1,
        top_level=1,
        subtests=0,
        subtest_counts=((NON_GO_BASELINE_TEST, 0),),
        passes=1,
        skips=0,
        note=(
            "measured: python3 -m unittest boilerplate_test reports 'Ran 1 test in "
            "0.001s / OK' - one case, no subtests. Guarded in BOTH modes because the "
            "row is produced identically either way"
        ),
    ),
}

#: The EXACT roster of verdicts the measured baseline records as ``skip``, as
#: ``(package, go_id)``.
#:
#: WHY AN EXACT ROSTER AND NOT A COUNT. AAP §0.10.3 defines behaviour parity as
#: "any skipped or known-failing test retains identical status", so a skip is a
#: FACT about today that the ported suite must reproduce - not an inconvenience to
#: be tolerated. A count alone would let one test start skipping while another
#: stopped, and the total would still be 25. Naming them is what makes
#: skip-stays-skip and pass-stays-pass separately provable.
#:
#: All 25 are ``procMount`` cases in ``test/integration/auth``'s Pod Security
#: tables, which skip because the ProcMountType feature gate is not enabled in the
#: test server.
EXPECTED_SKIP_COUNT: Final[int] = 25

#: The substring every measured skip's identity contains. Held as a rule rather
#: than 25 literals because the case names carry generated ordinals; the COUNT is
#: pinned exactly above, and this asserts they are all the same known feature-gate
#: family rather than an unrelated test that started skipping.
EXPECTED_SKIP_MARKER: Final[str] = "procMount"

#: The one package the measured skips come from.
EXPECTED_SKIP_PACKAGE: Final[str] = f"{GO_MODULE_PATH}/test/integration/auth"


@dataclass(frozen=True, slots=True)
class StreamReduction:
    """The result of reducing one ``go test -json`` stream.

    Package-level outcomes are kept apart from verdicts rather than discarded,
    because they are genuinely useful - a package that reports `fail` while every
    one of its verdicts reports `pass` means the failure was a build error, a
    `TestMain` abort or a panic outside any test, and a reader given only the
    verdicts would conclude the run was clean.

    INVARIANT LOCKED: a package-level summary is never promoted to a verdict. It
    carries no ``Test``, so no ported test could ever be bound to it, and
    admitting one would add an identity the contract can only fail on.

    Attributes:
        verdicts: Every ``pass`` / ``fail`` / ``skip`` event with a non-empty
            ``Test``, in stream order, ``TestMain`` excluded.
        package_status: Import path to terminal action, from the same three
            actions carrying no ``Test``.
        event_count: Non-blank lines successfully decoded, for the record.
        source: Where the stream came from, quoted in failure messages.
    """

    verdicts: tuple[Verdict, ...]
    package_status: Mapping[str, str]
    event_count: int
    source: str


# ---------------------------------------------------------------------------
# Identity handling
# ---------------------------------------------------------------------------


def split_go_test_id(raw: str) -> tuple[str, str]:
    """Split a Go ``Test`` field into its top-level identity and its subtest.

    INVARIANT LOCKED: subtest names may themselves contain ``/``, so the FIRST
    separator is the only one that delimits the top-level identity. This is not a
    hypothetical - 282 of the measured identities depend on it:

    * 280 of ``TestCreateMasterAuditPolicy``'s 620 subtests name a non-resource
      request path, and every one of the ten paths at ``audit_policy_test.go``
      lines 164-165 begins with ``/`` while four carry a second one, so
      ``TestCreateMasterAuditPolicy/system:anonymous.get./healthz/etcd`` must
      yield the subtest ``system:anonymous.get./healthz/etcd`` entire.
    * Both of ``TestAuditSensitiveResourceLevels``' subtests are prefixed with
      the API version by ``t.Run(fmt.Sprintf("%s.%s", version, tc.name), ...)``
      at ``audit_test.go`` line 1005, so
      ``TestAuditSensitiveResourceLevels/audit.k8s.io/v1.secrets-request`` must
      yield ``audit.k8s.io/v1.secrets-request``.

    ``str.partition`` is used rather than ``split``: ``split("/")`` shatters both
    families, ``rsplit`` keeps the wrong half, and ``split("/", 1)[-1]`` loses the
    distinction between a top-level id and a subtest whose name is the whole
    field. Nothing else is done to the value - no strip, no case change, no
    re-encoding - because Go has already applied its own rewrites (spaces to
    ``_``) and its own de-duplication (``#01``, ``#02``), and the manifest must
    record what it emitted.

    Args:
        raw: The event's ``Test`` field, non-empty.

    Returns:
        ``(test, subtest)``, where ``subtest`` is ``""`` for a top-level verdict.

    Raises:
        BaselineError: If ``raw`` is empty, or its top-level component is - a
            ``Test`` field of ``"/foo"`` has no identity to bind a ported test to.
    """
    if not raw:
        raise BaselineError(
            "refusing to record a verdict with an empty Test field: a verdict "
            "requires a non-empty identity, and an event without one is a "
            "package-level summary rather than a test outcome"
        )
    test, _, subtest = raw.partition("/")
    if not test:
        raise BaselineError(
            f"cannot split Go test id {raw!r}: the component before the first '/' is empty, "
            f"so there is no top-level identity to record"
        )
    return test, subtest


def go_rewrite_subtest_name(desc: str) -> str:
    """Apply Go's subtest-name rewrite to a verbatim ``t.Run`` description.

    INVARIANT LOCKED: a name declared in Go source and the name Go REPORTS are
    not the same string, and the manifest must hold the reported one. Go's
    ``(*T).Run`` rewrites each space in a subtest name to an underscore, so the
    description ``"ETCD-SERVERS is not set - default override"`` at
    ``apiserver_etcd_test.go`` line 52 is reported as
    ``ETCD-SERVERS_is_not_set_-_default_override``, which is exactly the id the
    proven representative baseline row carries.

    SCOPE, STATED HONESTLY: this implements the space rule and nothing else. Go
    additionally escapes non-printable and non-ASCII runes, and appends ``#NN``
    to disambiguate duplicate siblings. Neither applies to this corpus - every
    measured description is printable ASCII, and no description repeats within
    its own test function - so no further rule is implemented and none is
    guessed. The one family that DOES need ``#NN`` is
    ``TestCreateMasterAuditPolicy``, whose ids arrive from
    ``tests.fixtures.audit_policy_cases`` already carrying the suffix Go applies.

    APPLY ONLY TO VERBATIM DESCRIPTIONS. Names read from an event stream are
    already rewritten; passing one through here is harmless only because the
    rewrite is idempotent on rewritten input, and relying on that would still be
    a category error. :func:`reduce_event_stream` never calls this.

    Args:
        desc: A ``t.Run`` description exactly as the Go source spells it.

    Returns:
        The subtest name Go reports for it.
    """
    return desc.replace(" ", "_")


def repo_root_from_file() -> Path:
    """Locate the repository root from this file's own location, never from CWD.

    INVARIANT LOCKED: the root is a property of the checkout, not of where the
    caller happened to stand. The runner invokes this script with an absolute
    path while ``cd``-ed elsewhere, and a CWD-derived root would resolve to a
    different tree - or to none. This mirrors how the tier's session fixtures
    resolve ``repo_root``.

    ``parents[4]`` walks up from
    ``<root>/python/tests/parity/tools/generate_baseline.py``: tools, parity,
    tests, python, root.

    Returns:
        The absolute, symlink-resolved repository root.
    """
    return Path(__file__).resolve().parents[4]


def default_baseline_path(repo_root: Path) -> Path:
    """The committed manifest's canonical location.

    INVARIANT LOCKED: writer and readers agree on one path. The runner overrides
    it through :data:`ENV_BASELINE_FILE`, and the tier's ``parity_baseline``
    fixture honours the same variable, so the default has to match what those
    readers fall back to.

    Args:
        repo_root: The repository root.

    Returns:
        ``<repo_root>/python/tests/parity/baseline/go_baseline.json``.
    """
    return repo_root / "python" / "tests" / "parity" / "baseline" / "go_baseline.json"


def split_package_specs(values: Iterable[str]) -> tuple[str, ...]:
    """Flatten package specifications that arrived as shell words or a CSV.

    INVARIANT LOCKED: a package list that reaches this script as one string still
    selects every package it names. ``hack/make-rules/test-parity.sh`` expands
    ``KUBE_PARITY_PACKAGES`` UNQUOTED into a single ``--packages`` flag - the
    ``shellcheck disable=SC2086`` at line 63 marks that as deliberate - so the
    value can arrive as several argv entries, as one whitespace-joined string, or
    as a comma-separated list a human typed. Treating any of those as one opaque
    package name would run the oracle over nothing and produce an empty manifest.

    Duplicates are collapsed while first-seen order is preserved: handing the same
    package to ``go test`` twice would report its verdicts twice, and duplicate
    triples are a hard error later - correctly, but for a reason the user did not
    intend.

    Args:
        values: Raw ``--packages`` values, or the split environment default.

    Returns:
        The de-duplicated package specifications, in first-seen order.
    """
    flattened: list[str] = []
    for value in values:
        for chunk in value.replace(",", " ").split():
            if chunk and chunk not in flattened:
                flattened.append(chunk)
    return tuple(flattened)


def import_path_for_package_spec(spec: str) -> str:
    """Map a Go package pattern onto the import path the stream reports.

    INVARIANT LOCKED: a cardinality guard and a derived-mode inventory lookup key
    on the same string the oracle's ``Package`` field carries. The runner passes
    patterns relative to the repository root (``./cluster/gce/gci/``) while
    ``go test -json`` reports import paths (``k8s.io/kubernetes/cluster/gce/gci``),
    so without this mapping the 648-verdict guard would simply never fire and a
    derived run would find no inventory.

    Handles the four shapes that occur in practice: a relative pattern with or
    without ``./`` and a trailing ``/``, a recursive ``/...`` pattern (reduced to
    its root, since a guard on a subtree root is the closest honest
    approximation), and a full import path, which is returned unchanged and is
    recognised by its first segment containing a dot - no Go standard-library or
    intra-module directory does, and every module path does.

    Args:
        spec: A Go package pattern or import path.

    Returns:
        The import path, or ``""`` if ``spec`` names nothing.
    """
    value = spec.strip()
    if not value:
        return ""
    if value.endswith("/..."):
        value = value[: -len("/...")]
    elif value == "..." or value == "./...":
        return GO_MODULE_PATH
    value = value.rstrip("/")
    if value.startswith("./"):
        value = value[2:]
    if value in {"", "."}:
        return GO_MODULE_PATH
    if value == GO_MODULE_PATH or value.startswith(f"{GO_MODULE_PATH}/"):
        return value
    if "." in value.split("/", 1)[0]:
        return value
    return f"{GO_MODULE_PATH}/{value}"


def _log(message: str) -> None:
    """Report progress on stderr, keeping stdout free for machine consumers."""
    print(f"{_LOG_PREFIX} {message}", file=sys.stderr)


def _excerpt(text: str) -> str:
    """Bound a quoted line so one corrupt stream cannot flood a CI log."""
    stripped = text.rstrip("\n")
    if len(stripped) <= _EXCERPT_LIMIT:
        return stripped
    return f"{stripped[:_EXCERPT_LIMIT]}... [truncated, {len(stripped)} chars]"


# ---------------------------------------------------------------------------
# Reducing a `go test -json` event stream
# ---------------------------------------------------------------------------


def reduce_event_stream(lines: Iterable[str], *, source: str = "<stream>") -> StreamReduction:
    """Reduce a ``go test -json`` event stream to verdicts and package outcomes.

    INVARIANT LOCKED: every verdict the oracle reported appears exactly once, and
    nothing that is not a verdict appears at all. The three ways that can go
    wrong are all fatal here rather than tolerated:

    * A non-blank line that is not valid JSON aborts the reduction. Skipping it
      would silently drop however many verdicts it contained, and a truncated
      final line is precisely how a killed or redirected run manifests.
    * A ``pass`` / ``fail`` / ``skip`` event with no ``Test`` is recorded as
      package status, never as a verdict. It carries no identity a ported test
      could be bound to.
    * A repeated ``(package, test, subtest)`` triple aborts. The contract keys on
      that triple, so a duplicate makes one of the two rows unprovable.

    Unrecognised fields are ignored rather than rejected. Newer toolchains add
    keys - ``FailedBuild`` and ``ImportPath`` among them - and a reducer that
    refused unknown keys would break on a Go upgrade for no benefit, since the
    six fields it does read are stable.

    ``output`` events are never mined for outcomes, however plausible their text.
    The toolchain's own ``Action`` is the only source of a verdict.

    Args:
        lines: The stream's lines. Materialised internally, both because the
            whole stream must be captured before parsing to avoid the exit-141
            hazard of a partially consumed pipe, and so a failure can say whether
            the offending line was the last one.
        source: A human-readable origin - a file path or the oracle command -
            quoted in every failure message.

    Returns:
        The reduction. Callers check ``verdicts`` for emptiness themselves;
        emptiness is a policy decision made in :func:`build_manifest`, because a
        legitimately empty *sub*-stream is conceivable while an empty *manifest*
        never is.

    Raises:
        BaselineError: On an unparsable line, an unusable event shape, or a
            duplicate triple.
    """
    materialised = list(lines)
    last_index = len(materialised) - 1

    verdicts: list[Verdict] = []
    package_status: dict[str, str] = {}
    seen: dict[tuple[str, str, str], int] = {}
    event_count = 0

    for index, raw_line in enumerate(materialised):
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            truncation_hint = (
                " The stream appears TRUNCATED: this was its final line, which is what a "
                "killed, disk-full or partially redirected oracle run looks like."
                if index == last_index
                else ""
            )
            raise BaselineError(
                f"unparsable JSON on line {index + 1} of {source}: {exc}. "
                f"Line content: {_excerpt(raw_line)!r}.{truncation_hint} "
                f"Refusing to skip it: a skipped line silently drops every verdict it "
                f"carried, which is the one failure mode the parity gate cannot detect."
            ) from exc

        if not isinstance(event, dict):
            raise BaselineError(
                f"line {index + 1} of {source} decoded to {type(event).__name__}, not a JSON "
                f"object: `go test -json` emits one object per line. "
                f"Line content: {_excerpt(raw_line)!r}"
            )

        event_count += 1
        action = event.get("Action")
        if not isinstance(action, str) or action not in VERDICT_ACTIONS:
            # start / run / pause / cont / bench / output, plus anything a future
            # toolchain adds: progress, not outcome.
            continue

        package = event.get("Package")
        if not isinstance(package, str) or not package:
            raise BaselineError(
                f"line {index + 1} of {source} reports action {action!r} with no Package "
                f"field, so the outcome cannot be attributed. "
                f"Line content: {_excerpt(raw_line)!r}"
            )

        raw_test = event.get("Test")
        if raw_test is None or raw_test == "":
            # The package-level summary. Recorded separately; never a verdict.
            previous_status = package_status.get(package)
            if previous_status is not None:
                # A conforming stream emits exactly ONE terminal action per package.
                # A second one means the package was listed twice on the command
                # line, or two streams were concatenated - and because this is a
                # mapping, the later action SILENTLY OVERWRITES the earlier. A
                # `fail` followed by a `pass` therefore erased the failure, which is
                # the precise shape #21 exists to close: the run's own summary said
                # the package failed and the manifest recorded it as clean.
                raise BaselineError(
                    f"line {index + 1} of {source} reports a SECOND terminal action for "
                    f"package {package!r}: {previous_status!r} then {action!r}. Exactly one "
                    f"is expected per package, and keeping the later one would let a `fail` "
                    f"be overwritten by a `pass`. Re-run the oracle with each package listed "
                    f"once, and do not concatenate streams."
                )
            package_status[package] = action
            continue
        if not isinstance(raw_test, str):
            raise BaselineError(
                f"line {index + 1} of {source} reports a non-string Test field of type "
                f"{type(raw_test).__name__}. Line content: {_excerpt(raw_line)!r}"
            )

        test, subtest = split_go_test_id(raw_test)
        if test == _TEST_MAIN:
            # Belt and braces: a conforming stream never emits a verdict for the
            # package entry point, and the manifest must never carry one.
            continue

        elapsed = event.get("Elapsed")
        if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)):
            # Absent or unusable: 0.0 records "the event carried no duration"
            # without pretending a duration was measured elsewhere. Never
            # compared, so this cannot influence a verdict either way. `bool` is
            # excluded explicitly because it is a subclass of `int`.
            elapsed_seconds = 0.0
        else:
            elapsed_seconds = float(elapsed)

        verdict = Verdict(
            package=package,
            test=test,
            subtest=subtest,
            action=action,
            elapsed=elapsed_seconds,
        )
        previous = seen.get(verdict.triple)
        if previous is not None:
            raise BaselineError(
                f"duplicate verdict for {verdict.package} :: {verdict.go_id!r} in {source}: "
                f"first seen on line {previous}, again on line {index + 1}. "
                f"The parity contract keys on (package, test, subtest), so one of the two "
                f"outcomes would be unreachable. Re-run the oracle with -count=1 and without "
                f"repeating a package on the command line."
            )
        seen[verdict.triple] = index + 1
        verdicts.append(verdict)

    return StreamReduction(
        verdicts=tuple(verdicts),
        package_status=dict(package_status),
        event_count=event_count,
        source=source,
    )


# ---------------------------------------------------------------------------
# Running the oracle
# ---------------------------------------------------------------------------


def _oracle_environment(base: Mapping[str, str]) -> dict[str, str]:
    """Build the child environment, keeping the repository's Go freeze intact.

    INVARIANT LOCKED: ``-mod=vendor`` is present, and every inherited ``GOFLAGS``
    entry has passed the SAME allow-list and value checks as an argument written on
    the command line.

    GOFLAGS IS AN ARGUMENT SOURCE, NOT A DECORATION, and treating it as one is the
    fix. ``go test`` reads it exactly as if its entries had been typed after the
    subcommand, so ``GOFLAGS=-run=TestNothing``, ``GOFLAGS=-short``,
    ``GOFLAGS=-tags=noetcd`` and ``GOFLAGS=-count=0`` each shrink the manifest with
    no error and no trace - the same class of silent domain narrowing
    :func:`_resolve_extra_go_args` exists to refuse. The previous guard was
    ``if "-mod=" not in goflags``, which did not screen a single entry and, worse,
    treated an inherited ``-mod=mod`` as satisfying the vendor requirement: the one
    value that means the opposite of what was being enforced.

    Nothing legitimate is lost. Entries that pass are preserved verbatim, so
    whatever the runner or CI deliberately set still applies, and ``-mod=vendor`` is
    appended when absent rather than replacing the list.

    Args:
        base: The environment to derive from, normally ``os.environ``.

    Returns:
        The child environment.

    Raises:
        BaselineError: If an inherited ``GOFLAGS`` entry is not an allowed flag, or
            carries a value that would weaken the oracle.
    """
    env = dict(base)
    inherited = env.get("GOFLAGS", "").split()

    for entry in inherited:
        if not entry.startswith("-"):
            raise BaselineError(
                f"refusing the inherited GOFLAGS entry {entry!r}: every entry must be a "
                f"standalone flag, which is what the Go toolchain documents and requires. A "
                f"bare word here is read as a package or an operand and would widen or break "
                f"the run. Fix GOFLAGS in the environment that launched this generator."
            )
        name = _flag_name(entry)
        if name not in _ALLOWED_GO_TEST_FLAGS:
            raise BaselineError(
                f"refusing the inherited GOFLAGS entry {entry!r}: `-{name}` is not in the "
                f"allow-list {sorted(_ALLOWED_GO_TEST_FLAGS)}. GOFLAGS is applied by `go "
                f"test` exactly as if it had been typed on the command line, so a selection, "
                f"listing, skipping, tag, benchmark or fuzz flag there shrinks the baseline "
                f"just as silently as one passed directly - and a verdict missing from the "
                f"baseline cannot be told apart from a behaviour that never existed. Unset "
                f"it, or narrow the run honestly with --packages."
            )
        if "=" in entry:
            validate_go_flag_value(entry, name, entry.split("=", 1)[1])
        elif name not in _BOOLEAN_GO_TEST_FLAGS:
            raise BaselineError(
                f"refusing the inherited GOFLAGS entry {entry!r}: `-{name}` takes a value and "
                f"GOFLAGS entries must be self-contained (`-{name}=<value>`), because the "
                f"toolchain does not pair one entry with the next. As written it would be "
                f"rejected by `go test`, and a run that fails to start produces no baseline."
            )

    if not any(_flag_name(entry) == "mod" for entry in inherited):
        inherited.append(f"-mod={_REQUIRED_MOD_VALUE}")
    env["GOFLAGS"] = " ".join(inherited)
    return env


def run_go_test_json(
    packages: Sequence[str],
    *,
    repo_root: Path,
    extra_args: Sequence[str] = (),
    go_binary: str = "go",
    env: Mapping[str, str] | None = None,
) -> StreamReduction:
    """Run the Go oracle and reduce its event stream.

    INVARIANT LOCKED: the oracle is run whole, captured whole, and its failures
    are reported rather than absorbed.

    THE EXIT-141 HAZARD, AVOIDED STRUCTURALLY. A ``go test`` stream piped into a
    consumer that stops reading early - ``head`` being the classic - kills the
    producer with SIGPIPE and yields exit status 141, which reads exactly like a
    test failure and truncates the stream at the same time. The whole stream is
    therefore written to a temporary file and only then parsed, which is the same
    thing ``hack/make-rules/test.sh`` does at lines 230-239 when it passes
    ``--jsonfile`` to ``gotestsum`` instead of piping. Nothing here slices,
    ``head``s or short-reads the child's output.

    NO ``-run`` FILTER, EVER. A filter that excludes tests excludes their
    verdicts from the manifest, and a verdict missing from the manifest is
    indistinguishable from a behaviour that never existed. ``extra_args`` exists
    for flags such as ``-timeout`` or ``-p``; a caller who smuggles ``-run``
    through it is defeating the purpose of the artifact.

    ``-count=1`` disables result caching, which is the determinism model the plan
    names: a cached ``ok (cached)`` line reports no per-test events at all, so a
    cached run would reduce to an empty manifest.

    Args:
        packages: Go package patterns, already flattened.
        repo_root: Working directory for the child, so relative patterns resolve.
        extra_args: Additional ``go test`` arguments, inserted before the packages.
        go_binary: The toolchain binary; overridable for a non-PATH toolchain.
        env: Base environment, defaulting to this process's.

    Returns:
        The reduction of the captured stream.

    Raises:
        BaselineError: If the toolchain is absent, or the oracle exits non-zero.
        OSError: If the child cannot be started or its capture file cannot be read.
    """
    resolved = shutil.which(go_binary)
    if resolved is None:
        raise BaselineError(
            f"Go toolchain {go_binary!r} not found on PATH, so the oracle cannot be run. "
            f"Load it first (the repository pins its version in .go-version) or, if this "
            f"checkout genuinely has no toolchain, pass --mode {MODE_DERIVED} to build the "
            f"manifest from the measured source inventory - which records "
            f"provenance={PROVENANCE_DERIVED!r} so the difference stays visible."
        )

    bounded_args, outer_deadline = _timeout_budget(extra_args)
    command = [resolved, "test", "-json", "-count=1", *bounded_args, *packages]
    printable = " ".join(command)
    _log(f"running the Go oracle: {printable}")
    _log(f"working directory: {repo_root}")
    _log(f"outer deadline: {outer_deadline:.0f}s (Go -timeout plus a margin)")

    child_env = _oracle_environment(os.environ if env is None else env)

    with tempfile.TemporaryDirectory(prefix="go-baseline-stream-") as scratch:
        stream_path = Path(scratch) / "go-test.json"
        with stream_path.open("w", encoding="utf-8") as sink:
            # shell=False (the default) with an argument list: no word splitting,
            # no glob expansion and no injection surface from a package name. A
            # `shell=True` string would give all three away for nothing.
            #
            # start_new_session=True makes the child the LEADER of its own process
            # group, which is what lets a timeout kill `go test`, every per-package
            # test binary it exec'd and any etcd those started, with one killpg -
            # and what guarantees the signal cannot travel back to this process or
            # to the pytest session that invoked it.
            process = subprocess.Popen(
                command,
                cwd=str(repo_root),
                env=child_env,
                stdout=sink,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            try:
                _, captured_stderr = process.communicate(timeout=outer_deadline)
            except subprocess.TimeoutExpired:
                # Kill the GROUP before raising, so nothing survives this failure
                # holding a port, a data directory or the capture pipe. Then read
                # back whatever the stream captured, because a partial stream names
                # the test that was running when everything stopped - which is the
                # single most useful fact about a hang.
                _terminate_process_group(process)
                partial = stream_path.read_text(encoding="utf-8", errors="replace")
                last_lines = [line for line in partial.splitlines() if line.strip()][-5:]
                raise BaselineError(
                    f"the Go oracle exceeded this script's outer deadline of "
                    f"{outer_deadline:.0f}s and its whole process group was terminated "
                    f"(SIGTERM then SIGKILL). Command: {printable}\n"
                    f"The Go-side `-timeout` should have fired FIRST and produced a goroutine "
                    f"dump, so reaching this bound means the toolchain was wedged building, a "
                    f"child outlived its test binary and held the capture pipe, or the binary "
                    f"ignored its own alarm. No manifest is written: a truncated stream would "
                    f"record a smaller domain than the one that was asked for, and the parity "
                    f"contract cannot tell that apart from tests that never existed.\n"
                    f"Last stream lines before termination:\n"
                    + ("\n".join(f"  {line}" for line in last_lines) or "  (stream was empty)")
                ) from None
        raw = stream_path.read_text(encoding="utf-8")

    stderr_text = (captured_stderr or "").strip()
    if stderr_text:
        # Surfaced, never swallowed: a build error appears here and nowhere else.
        _log("go test stderr follows")
        print(stderr_text, file=sys.stderr)

    reduction = reduce_event_stream(raw.splitlines(), source=f"`{printable}`")

    if process.returncode != 0:
        failed = [v.go_id for v in reduction.verdicts if v.action == "fail"]
        failing_packages = sorted(
            pkg for pkg, status in reduction.package_status.items() if status != "pass"
        )
        raise BaselineError(
            f"the Go oracle exited {process.returncode} for packages "
            f"{list(packages)} and yielded {len(reduction.verdicts)} verdicts "
            f"({len(failed)} of them failing). "
            f"Non-passing packages: {failing_packages or 'none reported'}. "
            f"Failing tests: {failed[:20] or 'none reported'}"
            f"{' (and more)' if len(failed) > 20 else ''}. "
            f"A non-zero oracle exit with no failing verdict usually means a BUILD error, a "
            f"TestMain abort or a panic outside any test - see the stderr above. The measured "
            f"baseline has ZERO FAILURES, so this must be fixed rather than recorded. Skips "
            f"are a different matter: the oracle legitimately skips {EXPECTED_SKIP_COUNT} "
            f"{EXPECTED_SKIP_MARKER!r} cases, which are recorded verbatim and pinned to an "
            f"exact roster."
        )

    _log(
        f"decoded {reduction.event_count} events -> {len(reduction.verdicts)} verdicts "
        f"across {len({v.package for v in reduction.verdicts})} package(s)"
    )
    return reduction


# ---------------------------------------------------------------------------
# The measured source inventory (derived mode)
# ---------------------------------------------------------------------------
# Every identity below was measured on this branch, by grepping `^func Test` for
# the top-level names and by reducing a real `go test -json` stream for the
# subtests. Nothing is estimated, rounded or inferred: where a subtest cardinality
# is not recorded below, the test contributes a top-level verdict only rather than
# an invented handful.
#
# DERIVED MODE IS A NARROWER DOMAIN THAN THE ORACLE, ON PURPOSE, AND THE
# `provenance` FIELD IS WHAT SAYS SO. A full capture of the eight default packages
# in this checkout reduces to 3104 Go verdicts - among them 2136 `test/integration/auth`
# subtests and 239 `noderestriction` subtests, whose names are computed at runtime
# from table data and cannot be established by reading the source. Derived mode
# therefore records those packages' top-level identities only, and a manifest built
# that way is stamped `derived_from_source_inventory` precisely so a reader can tell
# it apart from the complete measured domain. Only a real
# `--mode go-test-json` run may claim `go_test_json`, and the committed manifest is
# one: it carries every subtest the oracle emitted.
#
# Two matrices are NOT transcribed here. They already have an owner in
# tests/fixtures/, and a second copy is a second thing to drift:
#   * TestCreateMasterAuditPolicy's 620 ids come from
#     tests.fixtures.audit_policy_cases.case_ids(), each already carrying its
#     `user.verb.object` name and Go's `#NN` de-duplication suffix. Verified
#     against a real oracle run: the two sequences are equal as sets AND in
#     order, all 620.
#   * The six kube-apiserver etcd flag ids come from
#     tests.fixtures.etcd_env_cases, whose ETCDEnvCase carries the Go `desc`
#     verbatim and reports the emitted name through `.go_subtest_name`.

#: Sentinel naming the fixture that owns a subtest matrix, resolved at build time.
_FIXTURE_AUDIT_POLICY_CASES: Final[str] = "audit_policy_cases:case_ids"
_FIXTURE_ETCD_SERVER_OVERRIDE: Final[str] = "etcd_env_cases:SERVER_OVERRIDE_CASES"
_FIXTURE_ETCD_STORAGE_OPTIONS: Final[str] = "etcd_env_cases:STORAGE_OPTIONS_CASES"
_FIXTURE_ETCD_TLS_FLAGS: Final[str] = "etcd_env_cases:TLS_FLAGS_CASES"

#: What each fixture-owned matrix must yield. A shortfall is a hard error, never
#: a shorter manifest.
_FIXTURE_EXPECTED_COUNTS: Final[Mapping[str, int]] = {
    _FIXTURE_AUDIT_POLICY_CASES: 620,
    _FIXTURE_ETCD_SERVER_OVERRIDE: 2,
    _FIXTURE_ETCD_STORAGE_OPTIONS: 2,
    _FIXTURE_ETCD_TLS_FLAGS: 2,
}


@dataclass(frozen=True, slots=True)
class _MeasuredTest:
    """One measured Go test function and the subtests measured beneath it.

    INVARIANT LOCKED: a subtest name is rewritten exactly once, or not at all,
    according to which form it was declared in.

    Exactly one of the three subtest sources is used per entry, and they are
    separate fields rather than one field with a flag because the distinction is
    the whole point: ``verbatim_descs`` holds strings as GO SOURCE spells them and
    must be passed through :func:`go_rewrite_subtest_name`, ``go_subtest_names``
    holds strings as GO REPORTS them and must not be touched, and ``fixture``
    defers to the module that already owns the matrix. Collapsing them would make
    it possible to double-rewrite a name or to ship an un-rewritten one, and
    either produces an id no ported test can be bound to.

    Attributes:
        test: The top-level identity, exactly as ``func`` declares it.
        verbatim_descs: ``t.Run`` descriptions from Go source; rewritten on use.
        go_subtest_names: Names already in emitted form; used as-is.
        fixture: A ``_FIXTURE_*`` sentinel, or ``""``.
        note: Why the entry looks the way it does, especially when it has no
            subtests.
    """

    test: str
    verbatim_descs: tuple[str, ...] = ()
    go_subtest_names: tuple[str, ...] = ()
    fixture: str = ""
    note: str = ""


#: `cluster/gce/gci` - the shell-boundary package. 8 top-level + 640 subtests.
_GCI_TESTS: Final[tuple[_MeasuredTest, ...]] = (
    _MeasuredTest(test="TestServerOverride", fixture=_FIXTURE_ETCD_SERVER_OVERRIDE),
    _MeasuredTest(test="TestStorageOptions", fixture=_FIXTURE_ETCD_STORAGE_OPTIONS),
    _MeasuredTest(test="TestTLSFlags", fixture=_FIXTURE_ETCD_TLS_FLAGS),
    _MeasuredTest(
        test="TestEncryptionProviderFlag",
        verbatim_descs=(
            "ENCRYPTION_PROVIDER_CONFIG is set",
            "ENCRYPTION_PROVIDER_CONFIG is not set",
        ),
        note="apiserver_kms_test.go lines 58 and 63",
    ),
    _MeasuredTest(
        test="TestEncryptionProviderConfig",
        note=(
            "FLAT BY MEASUREMENT: apiserver_kms_test.go line 105 declares no t.Run at all, "
            "so it contributes its own verdict and no subtest. This is the reason the "
            "package's 8 top-level tests yield 640 rather than 656 subtests, and it must "
            "not be 'corrected' by inventing a pair to match its siblings"
        ),
    ),
    _MeasuredTest(
        test="TestKMSIntegration",
        verbatim_descs=(
            "CLOUD_KMS_INTEGRATION is set",
            "CLOUD_KMS_INTEGRATION is not set",
        ),
        note="apiserver_kms_test.go lines 154 and 171",
    ),
    _MeasuredTest(
        test="TestAppendOrReplacePrefix",
        verbatim_descs=(
            "simple string and empty file",
            "simple string and non empty file",
            "simple string and file already contains prefix",
            "simple string and file already contains prefix with content between the "
            "prefix and suffix",
            "simple string and file already contains prefix with prefix == suffix",
            "string with quotes and = and empty file",
            "string with quotes and = and non empty file",
            "string with quotes and = and file already contains prefix",
            "string with quotes and = and file already contains prefix with content "
            "between the prefix and suffix",
            "string with quotes and = and file already contains prefix with prefix == suffix",
        ),
        note=(
            "append_or_replace_prefixed_line_test.go lines 37, 44, 56, 70, 83, 96, 103, "
            "115, 129 and 142, in declaration order"
        ),
    ),
    _MeasuredTest(test="TestCreateMasterAuditPolicy", fixture=_FIXTURE_AUDIT_POLICY_CASES),
)

#: `test/integration/auth` - 43 identities. 44 `^func Test` declarations minus
#: `TestMain`, which is the package entry point and emits no verdict.
#:
#: TOP-LEVEL ONLY IN DERIVED MODE. A measured run emits 2136 subtests beneath
#: these 43 - 686 each under TestPodSecurity, TestPodSecurityGAOnly and
#: TestPodSecurityWebhook alone - built at run time from the pod-security fixture
#: matrix, so derived mode records the roster and nothing beneath it. The measured
#: per-family counts live in PACKAGE_EXPECTATIONS and are enforced against a
#: measured run, which is what stops a measured manifest from shipping the roster
#: alone. 25 of those subtests are legitimately SKIPPED today
#: (TestPodSecurityGAOnly/..._fail_procMount) and are recorded as `skip` verbatim,
#: because skip-stays-skip is a parity outcome rather than a defect.
_AUTH_TESTS: Final[tuple[_MeasuredTest, ...]] = tuple(
    _MeasuredTest(test=name)
    for name in (
        "TestAliceNotForbiddenOrUnauthorized",
        "TestAuthModeAlwaysAllow",
        "TestAuthModeAlwaysDeny",
        "TestAuthnToKAS",
        "TestAuthorizationAttributeDetermination",
        "TestAuthzConfig",
        "TestBobIsForbidden",
        "TestBootstrapTokenAuth",
        "TestBootstrapping",
        "TestConstrainedImpersonation",
        "TestConstrainedImpersonationDisabled",
        "TestDiscoveryUpgradeBootstrapping",
        "TestDynamicClientBuilder",
        "TestGetsSelfAttributes",
        "TestGetsSelfAttributesError",
        "TestImpersonateIsForbidden",
        "TestImpersonateWithUID",
        "TestKindAuthorization",
        "TestLocalSubjectAccessReview",
        "TestMonitoringURLs",
        "TestMultiWebhookAuthzConfig",
        "TestNamespaceAuthorization",
        "TestNodeAuthorizer",
        "TestNodeRestrictionCrossNodeDenied",
        "TestNodeRestrictionServiceAccount",
        "TestNodeRestrictionServiceAccountAudience",
        "TestPodSecurity",
        "TestPodSecurityEnforceBaselineRejectsPrivileged",
        "TestPodSecurityGAOnly",
        "TestPodSecurityWebhook",
        "TestRBAC",
        "TestRBACContextContamination",
        "TestRBACNoWildcardOutsideSystemMasters",
        "TestReadOnlyAuthorization",
        "TestSelfSubjectAccessReview",
        "TestServiceAccountAnnotationDeprecation",
        "TestServiceAccountTokenBoundAndAudienced",
        "TestServiceAccountTokenCreate",
        "TestSloppySANCertificates",
        "TestSubjectAccessReview",
        "TestUnknownUserIsUnauthorized",
        "TestWebhookTokenAuthenticator",
        "TestWebhookTokenAuthenticatorCustomDial",
    )
)

#: The full measured inventory, keyed by import path.
_SOURCE_INVENTORY: Final[Mapping[str, tuple[_MeasuredTest, ...]]] = {
    f"{GO_MODULE_PATH}/cluster/gce/gci": _GCI_TESTS,
    f"{GO_MODULE_PATH}/test/integration/auth": _AUTH_TESTS,
    f"{GO_MODULE_PATH}/test/integration/secrets": (
        _MeasuredTest(test="TestSecrets", note="secrets_test.go line 43"),
        _MeasuredTest(test="TestSecretsAreEncryptedAtRest", note="encryption_test.go line 80"),
    ),
    f"{GO_MODULE_PATH}/test/integration/controlplane/audit": (
        _MeasuredTest(
            test="TestAudit",
            go_subtest_names=(
                "audit.k8s.io/v1.RequestResponse.false",
                "audit.k8s.io/v1.Metadata.true",
                "audit.k8s.io/v1.Request.true",
                "audit.k8s.io/v1.RequestResponse.true",
                "cross-group-audit.k8s.io/v1.Request.create-audit-request",
                "cross-group-audit.k8s.io/v1.RequestResponse.create-audit-response",
                "cross-group-audit.k8s.io/v1.Request.update-audit-request",
                "cross-group-audit.k8s.io/v1.RequestResponse.update-audit-response",
            ),
            note=(
                "MEASURED, not transcribed from the source: audit_test.go declares t.Run at "
                "lines 398 and 405 over a matrix these eight names were read off a real "
                "`go test -json -count=1 ./test/integration/controlplane/audit/` capture in "
                "this checkout (12 verdicts: 2 top-level + 10 subtests, all pass). They are "
                "recorded here in EMITTED form so derived mode covers the package's real "
                "domain instead of understating it; every name embeds '/', which is why the id "
                "split takes the first separator only"
            ),
        ),
        _MeasuredTest(
            test="TestAuditSensitiveResourceLevels",
            go_subtest_names=(
                "audit.k8s.io/v1.secrets-request",
                "audit.k8s.io/v1.rbac-response",
            ),
            note=(
                "audit_test.go line 1005 runs t.Run(fmt.Sprintf('%s.%s', version, tc.name)) "
                "over the single-entry versions map at lines 126-128 and the two cases named "
                "at lines 991 and 997. Both ids contain '/', which is why the id split takes "
                "the first separator only"
            ),
        ),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/auth/authorizer/rbac": (
        _MeasuredTest(test="TestAuthorizer"),
        _MeasuredTest(test="TestRuleMatches"),
        _MeasuredTest(test="TestSubjectLocator"),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/auth/authorizer/rbac/bootstrappolicy": (
        _MeasuredTest(test="TestNoStarsForControllers"),
        _MeasuredTest(test="TestControllerRoleLabel"),
        _MeasuredTest(test="TestControllerRoleVerbsConsistency"),
        _MeasuredTest(test="TestEditViewRelationship"),
        _MeasuredTest(test="TestBootstrapNamespaceRoles"),
        _MeasuredTest(test="TestBootstrapNamespaceRoleBindings"),
        _MeasuredTest(test="TestBootstrapClusterRoles"),
        _MeasuredTest(test="TestBootstrapClusterRolesWithFeatureGatesEnabled"),
        _MeasuredTest(test="TestBootstrapClusterRoleBindings"),
        _MeasuredTest(test="TestBootstrapControllerRoles"),
        _MeasuredTest(test="TestBootstrapControllerRoleBindings"),
        _MeasuredTest(test="TestClusterRoleLabel"),
        _MeasuredTest(test="TestNodeRuleVerbsConsistency"),
        _MeasuredTest(test="TestClusterRoleVerbsConsistency"),
        _MeasuredTest(test="TestNamespaceRoleVerbsConsistency"),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/admission/security/podsecurity": (
        _MeasuredTest(test="TestConvert"),
    ),
    f"{GO_MODULE_PATH}/plugin/pkg/admission/noderestriction": (
        # Three of these have a lowercase character after `Test`, which is legal
        # Go and the reason nothing here assumes a `Test[A-Z]` shape.
        #
        # TOP-LEVEL ONLY IN DERIVED MODE, for the same reason as the auth package:
        # a measured run emits 239 subtests beneath these five (178 under
        # Test_nodePlugin_Admit), named from table data at run time. The measured
        # counts are declared in PACKAGE_EXPECTATIONS and enforced against a
        # measured run.
        _MeasuredTest(test="Test_nodePlugin_Admit"),
        _MeasuredTest(test="Test_nodePlugin_Admit_OwnerReference"),
        _MeasuredTest(test="Test_getModifiedLabels"),
        _MeasuredTest(test="TestAdmitPVCStatus"),
        _MeasuredTest(test="TestAdmitResourceSlice"),
    ),
}


def _ensure_fixtures_importable(repo_root: Path) -> None:
    """Put ``<repo_root>/python`` on ``sys.path`` so ``tests.fixtures`` resolves.

    INVARIANT LOCKED: derived mode single-sources its two big matrices even when
    this script is executed by absolute path. Run as
    ``python3 <root>/python/tests/parity/tools/generate_baseline.py``, ``sys.path[0]``
    is the ``tools`` directory, so ``tests.fixtures`` is not importable - and the
    fallback would be to transcribe 620 audit ids here, which is precisely the
    duplication the fixture package exists to prevent.

    This is the only mutation of interpreter state in the module, it happens
    inside a function rather than at import time, it is idempotent, and it appends
    rather than prepends so it cannot shadow a caller's own ``tests`` package.
    """
    python_dir = str(repo_root / "python")
    if python_dir not in sys.path:
        sys.path.append(python_dir)


def _fixture_subtest_names(fixture: str, repo_root: Path) -> tuple[str, ...]:
    """Resolve a fixture-owned subtest matrix to its Go-emitted names.

    INVARIANT LOCKED: a fixture that cannot be imported, or that yields the wrong
    number of cases, aborts the run. The alternative - an empty or partial matrix -
    would produce a manifest that is short by up to 620 rows and still parses,
    which is the exact shape of a vacuous parity gate.

    Args:
        fixture: A ``_FIXTURE_*`` sentinel.
        repo_root: Used to make ``tests.fixtures`` importable.

    Returns:
        The subtest names, in the fixture's declared order.

    Raises:
        BaselineError: On an import failure, an unknown sentinel, or a count that
            does not match :data:`_FIXTURE_EXPECTED_COUNTS`.
    """
    _ensure_fixtures_importable(repo_root)
    expected = _FIXTURE_EXPECTED_COUNTS[fixture]

    try:
        if fixture == _FIXTURE_AUDIT_POLICY_CASES:
            from tests.fixtures import audit_policy_cases

            names: tuple[str, ...] = tuple(audit_policy_cases.case_ids())
        elif fixture in {
            _FIXTURE_ETCD_SERVER_OVERRIDE,
            _FIXTURE_ETCD_STORAGE_OPTIONS,
            _FIXTURE_ETCD_TLS_FLAGS,
        }:
            from tests.fixtures import etcd_env_cases

            group = {
                _FIXTURE_ETCD_SERVER_OVERRIDE: etcd_env_cases.SERVER_OVERRIDE_CASES,
                _FIXTURE_ETCD_STORAGE_OPTIONS: etcd_env_cases.STORAGE_OPTIONS_CASES,
                _FIXTURE_ETCD_TLS_FLAGS: etcd_env_cases.TLS_FLAGS_CASES,
            }[fixture]
            # `.go_subtest_name` already applies Go's space rewrite to `.desc`, so
            # the rewrite is NOT applied a second time here.
            names = tuple(case.go_subtest_name for case in group)
        else:  # pragma: no cover - guarded by _FIXTURE_EXPECTED_COUNTS above
            raise BaselineError(f"unknown subtest fixture sentinel {fixture!r}")
    except ImportError as exc:
        raise BaselineError(
            f"cannot import the fixture that owns {fixture!r} from "
            f"{repo_root / 'python'}: {exc}. Derived mode single-sources its case "
            f"matrices from tests.fixtures rather than transcribing them, so a failed "
            f"import must abort: continuing would emit a manifest short by "
            f"{expected} verdicts, which still parses and would let the parity contract "
            f"pass over behaviours it never checked."
        ) from exc

    if len(names) != expected:
        raise BaselineError(
            f"fixture {fixture!r} yielded {len(names)} case(s), expected exactly {expected}. "
            f"Either the fixture changed - in which case re-measure the Go oracle and update "
            f"_FIXTURE_EXPECTED_COUNTS and PACKAGE_EXPECTATIONS together, in one change - or "
            f"it is being read wrongly. Refusing to emit a short manifest either way."
        )
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise BaselineError(
            f"fixture {fixture!r} yielded duplicate subtest names {duplicates[:10]}: Go "
            f"de-duplicates sibling subtests with a '#NN' suffix, so a genuine duplicate "
            f"means the fixture is not reproducing the emitted ids"
        )
    return names


def derive_verdicts_from_source_inventory(
    repo_root: Path,
    *,
    packages: Sequence[str] = DEFAULT_PACKAGES,
    include_non_go_baseline: bool = True,
) -> tuple[Verdict, ...]:
    """Build verdicts from the measured Go source inventory, with no toolchain.

    INVARIANT LOCKED: derived rows are complete for the packages they claim, and
    are never mistaken for measured ones. Completeness is enforced by refusing any
    requested package the inventory does not cover and by checking every
    fixture-owned matrix against its expected count; honesty is enforced by the
    caller stamping ``provenance`` as :data:`PROVENANCE_DERIVED`, which is the
    only value :func:`build_manifest` will accept for these rows.

    ``elapsed`` is ``None`` on every derived row. No duration was measured, and a
    fabricated ``0.0`` would read as one.

    Args:
        repo_root: The repository root, used to make ``tests.fixtures`` importable.
        packages: Package patterns or import paths to cover.
        include_non_go_baseline: Whether to append the single non-Go row.

    Returns:
        The verdicts, in inventory order. Ordering for the manifest is applied by
        :func:`build_manifest`.

    Raises:
        BaselineError: If a requested package has no measured inventory, if a
            fixture matrix is missing or the wrong size, or if the request selects
            nothing at all.
    """
    requested = split_package_specs(packages)
    if not requested:
        raise BaselineError(
            "no packages requested, so there is nothing to derive. Pass --packages, set "
            f"{ENV_PACKAGES}, or accept the built-in measured scope: {list(DEFAULT_PACKAGES)}"
        )

    verdicts: list[Verdict] = []
    unknown: list[str] = []

    for spec in requested:
        import_path = import_path_for_package_spec(spec)
        entries = _SOURCE_INVENTORY.get(import_path)
        if entries is None:
            unknown.append(f"{spec} -> {import_path}")
            continue
        for entry in entries:
            verdicts.append(
                Verdict(
                    package=import_path,
                    test=entry.test,
                    subtest="",
                    action="pass",
                    elapsed=None,
                )
            )
            if entry.fixture:
                subtests = _fixture_subtest_names(entry.fixture, repo_root)
            elif entry.verbatim_descs:
                # Go source descriptions: the emitted name is the rewritten one.
                subtests = tuple(
                    go_rewrite_subtest_name(desc) for desc in entry.verbatim_descs
                )
            else:
                # Already-emitted names, or none measured at all.
                subtests = entry.go_subtest_names
            for subtest in subtests:
                verdicts.append(
                    Verdict(
                        package=import_path,
                        test=entry.test,
                        subtest=subtest,
                        action="pass",
                        elapsed=None,
                    )
                )

    if unknown:
        raise BaselineError(
            f"no measured source inventory for {unknown}. Derived mode may only emit rows "
            f"somebody actually counted, so an unmapped package aborts rather than "
            f"contributing nothing. Cover it by measuring a real oracle run - "
            f"`go test -json -count=1 <package>` with --mode {MODE_GO_TEST_JSON} - or add it "
            f"to _SOURCE_INVENTORY from measured evidence. Inventory covers: "
            f"{sorted(_SOURCE_INVENTORY)}"
        )

    if include_non_go_baseline:
        verdicts.append(_non_go_baseline_verdict())

    _log(
        f"derived {len(verdicts)} verdicts from the measured source inventory for "
        f"{len({v.package for v in verdicts})} package(s)"
    )
    return tuple(verdicts)


def check_go_verdict_domain(
    reduction: StreamReduction,
    *,
    packages: Sequence[str],
    require_requested: bool,
) -> None:
    """Prove a reduced Go stream describes a COMPLETE, PASSING verdict domain.

    Called on both Go routes before anything is appended to the rows, because the
    two failures it closes are invisible afterwards.

    FOUR OBLIGATIONS, each closing a shape that previously produced a manifest:

    1. AT LEAST ONE REAL GO VERDICT. A stream that yields none - a package with no
       test files, a `-run` filter that matched nothing, a `go vet`-only
       invocation, an empty file - used to be rescued by the appended non-Go
       baseline row, and :func:`build_manifest` only ever rejected ZERO rows. The
       result was a one-row manifest, written without complaint, that satisfied
       every parity assertion vacuously: the contract quantifies over the recorded
       verdicts, so a baseline holding one Python case asserts nothing about the
       648 Go cases it silently dropped. The non-Go row is a SUPPLEMENT to a
       measured Go domain and may never be the whole of one.
    2. EVERY PACKAGE THAT PRODUCED VERDICTS REPORTS A TERMINAL ACTION. A package
       whose tests appear but whose summary does not is a stream that ended
       mid-package - exactly how a killed, truncated or partially redirected run
       manifests when the truncation happens to land on a line boundary, where
       :func:`reduce_event_stream`'s JSON check cannot see it.
    3. EVERY TERMINAL ACTION IS ``pass``. This is the case the reduction was
       already computing and the caller was throwing away: a package that reports
       `fail` while every one of its verdicts reports `pass` means the failure was
       a BUILD ERROR, a ``TestMain`` abort or a panic outside any test. The rows
       look perfect. Recording them would pin a baseline taken from a run the
       toolchain itself called failed. The run route's exit-code check does not
       cover this, because a package-level failure does not always give `go test` a
       non-zero exit in a multi-package run, and the stream route has no exit code
       at all.
    4. EVERY REQUESTED PACKAGE PRODUCED AT LEAST ONE VERDICT. Not "reported an
       outcome" - a VERDICT. ``go test`` emits a package-level summary and exits 0
       for a package that ran nothing at all ("no test files", every test file
       excluded by a build tag, a filter that matched nothing), so accepting a
       summary as evidence of presence let a requested package contribute zero rows
       while the manifest still declared it in scope. A declared package with no
       rows makes every assertion about it vacuous, which the contract cannot tell
       apart from those behaviours never having existed.

    Args:
        reduction: The reduced stream.
        packages: The package PATTERNS whose presence is required by obligation 4,
            in whatever spelling the caller used. Each is normalised through
            :func:`import_path_for_package_spec` before comparison, because the
            runner passes repository-relative patterns (``./cluster/gce/gci/``)
            while the stream reports import paths
            (``k8s.io/kubernetes/cluster/gce/gci``) - comparing the two directly
            makes obligation 4 fire on every well-formed run, which is how this was
            first caught.
        require_requested: Whether obligation 4 applies. True for a run this
            process launched, where ``packages`` IS the ``go test`` argument list.
            False for a caller-supplied stream whose package list was not stated,
            where the recorded scope is whatever the stream happens to describe.

    Raises:
        BaselineError: On any of the four, naming what was seen.
    """
    if not reduction.verdicts:
        raise BaselineError(
            f"the Go oracle produced ZERO verdicts from {reduction.source} "
            f"({reduction.event_count} events decoded, package summaries: "
            f"{dict(sorted(reduction.package_status.items())) or 'none'}). "
            f"Refusing to build a baseline from it, with or without the non-Go row: a "
            f"manifest whose only row is the Python boilerplate case satisfies every "
            f"parity assertion VACUOUSLY, because the contract is quantified over the "
            f"recorded verdicts. Check that the packages actually contain tests, that the "
            f"stream is the whole stream, and that no filter excluded everything."
        )

    packages_with_verdicts = {verdict.package for verdict in reduction.verdicts}
    unsummarised = sorted(packages_with_verdicts - set(reduction.package_status))
    if unsummarised:
        raise BaselineError(
            f"{len(unsummarised)} package(s) in {reduction.source} reported verdicts but no "
            f"terminal package action: {unsummarised}. `go test -json` closes every package "
            f"with one, so its absence means the stream ENDED MID-PACKAGE - a killed, "
            f"disk-full or partially redirected run whose truncation landed on a line "
            f"boundary, where a JSON check cannot see it. Every verdict after that point is "
            f"missing, and a missing verdict is indistinguishable from a behaviour that "
            f"never existed. Re-capture the stream."
        )

    non_passing = sorted(
        f"{package}={status}"
        for package, status in reduction.package_status.items()
        if status != "pass"
    )
    if non_passing:
        failing_verdicts = [v.go_id for v in reduction.verdicts if v.action != "pass"]
        raise BaselineError(
            f"{len(non_passing)} package(s) in {reduction.source} did not pass: "
            f"{non_passing}. Non-passing verdicts: "
            f"{failing_verdicts[:20] or 'NONE - every individual test passed'}"
            f"{' (and more)' if len(failing_verdicts) > 20 else ''}. "
            f"A package that fails while all of its tests pass is a BUILD ERROR, a TestMain "
            f"abort or a panic outside any test: the rows look perfect and the run was not. "
            f"The measured baseline has ZERO FAILURES, so this must be fixed rather than "
            f"recorded."
        )

    if not require_requested:
        return

    # Normalised, and de-duplicated afterwards: `cluster/gce/gci` and
    # `./cluster/gce/gci/` are the same package asked for twice.
    requested = tuple(
        dict.fromkeys(
            path for path in (import_path_for_package_spec(spec) for spec in packages) if path
        )
    )
    # VERDICTS, NOT SUMMARIES. This used to be `package_status | packages_with_verdicts`,
    # which a package-level summary alone satisfied - and `go test` emits a summary for a
    # package that ran NOTHING ("no test files", or every test excluded), then exits 0. A
    # requested package could therefore contribute zero verdicts and still be counted as
    # present, which is the exact vacuity this obligation exists to refuse: the manifest
    # would declare the package in its domain while asserting nothing whatsoever about it.
    #
    # A recursive pattern names a SUBTREE, so a verdict from any package beneath it
    # satisfies it. Requiring the root itself to emit verdicts would fail every `/...`
    # run, since the root directory usually holds no tests of its own.
    silent = [
        package
        for package in requested
        if package not in packages_with_verdicts
        and not any(seen.startswith(f"{package}/") for seen in packages_with_verdicts)
    ]
    if silent:
        summarised_only = sorted(
            package
            for package in silent
            if package in reduction.package_status
            or any(seen.startswith(f"{package}/") for seen in reduction.package_status)
        )
        raise BaselineError(
            f"{len(silent)} requested package(s) produced NO VERDICT in {reduction.source}: "
            f"{silent}. Packages that produced verdicts: {sorted(packages_with_verdicts)}. "
            f"Of the silent ones, {summarised_only or 'none'} did report a package-level "
            f"summary, which means `go test` ran them and they emitted no test outcome at "
            f"all - 'no test files', a build that excluded every test file, or a filter that "
            f"matched nothing. A summary is not a verdict: a package present in the "
            f"manifest's declared domain but contributing no rows makes every assertion "
            f"about it vacuous, which the parity contract cannot tell apart from those "
            f"behaviours never having existed."
        )


#: Wall-clock ceiling for the non-Go baseline measurement. The case it runs is a
#: single directory scan over a handful of fixture files - the measured baseline is
#: "1 passed in 0.13s" - so a minute is generous by two orders of magnitude and a
#: run that exceeds it is wedged rather than slow.
NON_GO_BASELINE_TIMEOUT_SECONDS: Final[float] = 60.0

#: Path of the non-Go baseline case, relative to the repository root.
NON_GO_BASELINE_RELATIVE_PATH: Final[str] = "hack/boilerplate/boilerplate_test.py"

#: JUnit `classname` pytest emits for that case. Derived from its path, so it is
#: the dotted form of NON_GO_BASELINE_RELATIVE_PATH without the suffix. Asserted
#: rather than assumed, because a silently different classname would mean the
#: parsed testcase is not the one this row claims to describe.
NON_GO_BASELINE_CLASSNAME: Final[str] = "hack.boilerplate.boilerplate_test"

#: JUnit child element -> the action it means. A `<testcase>` with NO child
#: element is a pass; this is the whole outcome vocabulary pytest emits.
_JUNIT_OUTCOME_TAGS: Final[Mapping[str, str]] = {
    "failure": "fail",
    "error": "fail",
    "skipped": "skip",
}


def _non_go_baseline_verdict(repo_root: Path | None = None) -> Verdict:
    """The single non-Go baseline row, MEASURED by executing the case.

    INVARIANT LOCKED: the one Python case in the baseline scale is present
    regardless of which Go packages were run, AND its recorded verdict is the one
    the test actually produced. It is appended by an explicit, default-on switch
    rather than inferred from a stream, because letting a ``go test`` invocation
    decide whether a Python test is recorded is exactly how a narrow regeneration
    would drop it by accident.

    THIS USED TO RETURN A HARD-CODED ``pass``. That made the row a claim rather
    than a measurement, and it was the more dangerous half of a pair: the case it
    names was also outside pytest's collection, so nothing executed it and nothing
    could contradict the claim. A scanner or fixture regression - precisely the one
    AAP §0.5.5 warns about, where adding ``hack/boilerplate/test/fail.ts`` and
    ``fail.tsx`` changes the expected offender list - would leave the suite green
    AND the baseline asserting green. Both halves are now closed: the case is
    collected via ``testpaths`` in ``python/pyproject.toml``, and this function
    runs it and reads the outcome out of real JUnit XML.

    A failure here is NOT swallowed into a ``fail`` row that a later regeneration
    would enshrine as required. :func:`_check_no_failures` refuses a manifest
    containing any failure, so a genuinely failing case aborts generation - which
    is the intended behaviour: the baseline records what passes today, and a
    regression must be fixed rather than recorded.

    Its provenance atom is :data:`PROVENANCE_NON_GO_MEASURED`, contributed to the
    envelope by whichever route appended it. That row IS measured - by the
    ``unittest``/pytest runner - so it is not derived data; what it is not is Go
    data, which is why it needs an atom of its own rather than borrowing either Go
    one. ``elapsed`` is taken from the JUnit ``time`` attribute rather than
    invented, for the same reason.

    Args:
        repo_root: Repository root. Defaults to :func:`repo_root_from_file`.

    Returns:
        The measured verdict, with ``elapsed`` taken from the JUnit ``time``
        attribute rather than invented.

    Raises:
        BaselineError: If the case cannot be located, cannot be executed, or does
            not report exactly one identifiable testcase. Every one of these is a
            reason to abort rather than to fall back to an assumed ``pass``.
    """
    root = repo_root_from_file() if repo_root is None else repo_root
    test_path = root / NON_GO_BASELINE_RELATIVE_PATH
    if not test_path.is_file():
        raise BaselineError(
            f"the non-Go baseline case is missing at {test_path}. This row records the "
            f"measured outcome of {NON_GO_BASELINE_RELATIVE_PATH}, so it cannot be "
            f"produced without it. Either restore the file or regenerate with "
            f"--no-include-non-go-baseline and accept a manifest that omits the case."
        )

    with tempfile.TemporaryDirectory(prefix="blitzy-non-go-baseline-") as tmpdir:
        report = Path(tmpdir) / "non-go-baseline.xml"
        # -p no:randomly and -p no:xdist: the measurement must be a single,
        # deterministic, in-process run. Randomised order is meaningless for one
        # test and xdist would add a worker handshake to a sub-second scan.
        # --junitxml is the ONLY channel read; stdout is captured for diagnostics.
        command = (
            sys.executable,
            "-m",
            "pytest",
            str(test_path),
            "-p",
            "no:randomly",
            "-p",
            "no:xdist",
            "--junitxml",
            str(report),
        )
        try:
            # Fixed argv and shell=False: nothing here is caller-controlled.
            completed = subprocess.run(
                command,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=NON_GO_BASELINE_TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError as exc:
            raise BaselineError(
                f"could not execute pytest to measure the non-Go baseline case: {exc}. "
                f"The interpreter running this generator ({sys.executable}) must have "
                f"pytest importable; activate python/.venv or install the pinned set "
                f"from python/requirements-test.txt."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise BaselineError(
                f"measuring the non-Go baseline case exceeded "
                f"{NON_GO_BASELINE_TIMEOUT_SECONDS:g}s and was terminated. The case is a "
                f"single scan of hack/boilerplate/test/, so this is a wedged process "
                f"rather than a slow one; nothing was recorded."
            ) from exc

        if not report.is_file():
            raise BaselineError(
                f"pytest produced no JUnit report at {report} while measuring the "
                f"non-Go baseline case (exit {completed.returncode}). Without it there "
                f"is no measured outcome to record.\n"
                f"--- pytest stdout ---\n{completed.stdout}\n"
                f"--- pytest stderr ---\n{completed.stderr}"
            )
        verdict = _parse_non_go_junit(report, returncode=completed.returncode)

    return verdict


def _parse_non_go_junit(report: Path, *, returncode: int) -> Verdict:
    """Reduce the non-Go JUnit report to exactly one :class:`Verdict`.

    INVARIANT LOCKED: the row describes the case it claims to describe. The
    cardinality and the identity are both asserted, because a report holding zero
    testcases (a collection error) or more than one (a renamed or parametrized
    test) would otherwise be reduced to a confident single row that no longer
    corresponds to ``NON_GO_BASELINE_TEST``.

    Args:
        report: Path of the JUnit XML pytest wrote.
        returncode: pytest's exit status, quoted in diagnostics so a reader can
            tell a clean "test failed" from an internal error.

    Returns:
        The measured verdict.

    Raises:
        BaselineError: If the report is unparsable, or does not hold exactly one
            testcase with the expected classname and name.
    """
    try:
        tree = ElementTree.parse(report)
    except ElementTree.ParseError as exc:
        raise BaselineError(
            f"the JUnit report for the non-Go baseline case at {report} is not "
            f"well-formed XML: {exc} (pytest exit {returncode}). A malformed report is "
            f"not evidence of a passing test."
        ) from exc

    cases = list(tree.getroot().iter("testcase"))
    if len(cases) != 1:
        raise BaselineError(
            f"expected exactly 1 testcase in the non-Go baseline report, found "
            f"{len(cases)} (pytest exit {returncode}). This row records ONE case, "
            f"{NON_GO_BASELINE_CLASSNAME}.{NON_GO_BASELINE_TEST}; a different count "
            f"means the case was renamed, parametrized, or failed to collect, and the "
            f"manifest must not paper over that."
        )

    case = cases[0]
    classname = case.get("classname", "")
    name = case.get("name", "")
    if classname != NON_GO_BASELINE_CLASSNAME or name != NON_GO_BASELINE_TEST:
        raise BaselineError(
            f"the non-Go baseline report describes "
            f"{classname!r}.{name!r} but this row records "
            f"{NON_GO_BASELINE_CLASSNAME!r}.{NON_GO_BASELINE_TEST!r}. Recording a "
            f"verdict measured from a DIFFERENT test than the one named would make the "
            f"parity contract compare unrelated things."
        )

    # A testcase with no outcome child passed. `skipped` is a legitimate measured
    # property, not a failure, so it is carried through as `skip`; the skip roster
    # check then decides whether it is an EXPECTED skip.
    action = "pass"
    for child in case:
        mapped = _JUNIT_OUTCOME_TAGS.get(child.tag)
        if mapped is not None:
            action = mapped
            break

    # `time` is pytest's own measurement. Absent or unparsable means there is no
    # measurement to record, and None is the honest value - the same convention
    # the Go reducer uses for a verdict event carrying no Elapsed.
    elapsed: float | None
    raw_time = case.get("time")
    try:
        elapsed = None if raw_time is None else float(raw_time)
    except ValueError:
        elapsed = None

    return Verdict(
        package=NON_GO_BASELINE_PACKAGE,
        test=NON_GO_BASELINE_TEST,
        subtest="",
        action=action,
        elapsed=elapsed,
    )


# ---------------------------------------------------------------------------
# Assembling and checking the manifest
# ---------------------------------------------------------------------------


def _package_breakdown(verdicts: Sequence[Verdict]) -> dict[str, dict[str, int]]:
    """Count verdicts per package, including the top-level / subtest split.

    INVARIANT LOCKED: the measured boundary conditions are auditable from the
    artifact alone. Recording ``top_level`` and ``subtests`` alongside the action
    totals is what lets a reader confirm the shell package's 8-plus-640 shape
    without re-deriving it from 648 rows, and it is what a package-granularity
    retention rule in `parity_map.py` reads.
    """
    breakdown: dict[str, dict[str, int]] = {}
    for verdict in verdicts:
        bucket = breakdown.setdefault(
            verdict.package,
            {"total": 0, "pass": 0, "fail": 0, "skip": 0, "top_level": 0, "subtests": 0},
        )
        bucket["total"] += 1
        bucket[verdict.action] += 1
        bucket["top_level" if verdict.is_top_level else "subtests"] += 1
    return breakdown


def _check_no_failures(verdicts: Sequence[Verdict], *, source_label: str) -> None:
    """Refuse a baseline that records a FAILURE, naming EVERY offender.

    INVARIANT LOCKED: zero ``fail`` rows, and there is deliberately NO flag that
    overrides this. A regeneration that quietly records a regression turns the
    contract's verdict-equality assertion into a rubber stamp - a test that fails
    today would then be REQUIRED to fail tomorrow, and the gate would defend the
    bug.

    A FAILURE AND A SKIP ARE NOT THE SAME FACT, which is why they are checked
    separately. A failure is a regression: nothing legitimises it. A skip is a
    measured property of today's suite - AAP §0.4.1.2 maps Go's ``t.Skip`` to
    "skipped, not failed" and §0.10.3 requires a skipped test to retain identical
    status - and the measured oracle genuinely skips: ``test/integration/auth``
    reports 25 skipped ``TestPodSecurityGAOnly/..._fail_procMount`` subtests while
    the package itself still passes. Conflating the two is why this generator
    previously could not ingest its own oracle's real output, and coupling the two
    to one switch made the gate WEAKER rather than stricter, because every honest
    regeneration then had to wave the failure guard through as well. Skips are
    instead recorded verbatim, held to the exact measured roster by
    :func:`_check_skip_roster`, required to be accounted for by
    :func:`_check_unpinned_skips`, and announced by
    :func:`_report_recorded_skips`.

    Every offender is listed rather than the first, for the same reason the ported
    RBAC test accumulates findings instead of aborting: one report per run is worth
    more than one bisection per finding.
    """
    offenders = [v for v in verdicts if v.action == "fail"]
    if not offenders:
        return
    rendered = "\n".join(f"  FAIL  {v.package} :: {v.go_id}" for v in offenders)
    raise BaselineError(
        f"refusing to record a baseline that contains a FAILURE: {len(offenders)} of "
        f"{len(verdicts)} verdicts report `fail` from "
        f"{source_label or 'the requested source'}.\n{rendered}\n"
        f"The measured baseline is zero failures (tech-spec §6.6.3.2), so fix the offenders "
        f"rather than recording them - a recorded failure becomes a REQUIRED failure, and the "
        f"parity contract would then defend the regression instead of catching it. There is "
        f"deliberately no flag to override this."
    )


def _check_unpinned_skips(
    verdicts: Sequence[Verdict],
    expectations: Mapping[str, PackageExpectation],
    *,
    source_label: str,
) -> None:
    """Refuse a ``skip`` in a package whose skip count is not pinned.

    INVARIANT LOCKED: a skip is recordable only where it is ACCOUNTED FOR. The
    measured baseline is not uniformly all-pass - ``test/integration/auth`` skips
    25 subtests under disabled alpha/beta feature gates - and AAP §0.10.3 requires
    a skipped test to stay skipped, so a blanket "no skips" rule would make the
    true baseline unrecordable. The replacement is exact rather than blanket:
    :data:`PACKAGE_EXPECTATIONS` pins each default package's skip count, so a NEW
    skip in a pinned package fails :func:`_check_cardinality` with a number, and a
    skip in a package nobody measured fails HERE unless the caller says it is
    intended.

    That leaves no silent path for a test that quietly stopped running, which is
    the regression a global boolean was reaching for and could not express.
    """
    offenders = [
        v
        for v in verdicts
        if v.action == "skip" and getattr(expectations.get(v.package), "skips", None) is None
    ]
    if not offenders:
        return
    rendered = "\n".join(f"  SKIP  {v.package} :: {v.go_id}" for v in offenders)
    unpinned = sorted({v.package for v in offenders})
    raise BaselineError(
        f"refusing to record {len(offenders)} skip verdict(s) from "
        f"{source_label or 'the requested source'} in package(s) whose skip count is not "
        f"pinned: {unpinned}.\n{rendered}\n"
        f"A skip that nothing accounts for cannot be told apart from a test that silently "
        f"stopped running. Either the skip is a regression, in which case fix it, or it is "
        f"the measured truth, in which case measure the package and pin its `skips` in "
        f"PACKAGE_EXPECTATIONS in the same change. Pass --allow-non-green to record it "
        f"verbatim without pinning - useful for an ad-hoc regeneration of a package outside "
        f"the default scope, never for the committed baseline."
    )


def _report_recorded_skips(verdicts: Sequence[Verdict]) -> None:
    """Announce every ``skip`` the baseline is about to record, without refusing it.

    INVARIANT LOCKED: a skip is never silent. It is a legitimate recorded outcome -
    the contract requires a test skipped today to stay skipped - but it is also the
    outcome most easily created by accident, by a missing feature gate, an absent
    binary or an unmet environment precondition. Naming each one on stderr is what
    makes "these 25 are the same 25 as last time" a thing a reviewer can check
    against the diff, rather than something they have to take on trust.
    """
    skipped = [v for v in verdicts if v.action == "skip"]
    if not skipped:
        return
    _log(
        f"recording {len(skipped)} SKIPPED verdict(s) verbatim, so skip-stays-skip stays "
        f"provable. Confirm each is skipped for the same reason it was before:"
    )
    for verdict in skipped:
        _log(f"  SKIP  {verdict.package} :: {verdict.go_id}")


def _family_breakdown(verdicts: Sequence[Verdict]) -> dict[str, dict[str, int]]:
    """Count subtests per top-level FAMILY, per package.

    INVARIANT LOCKED: a family that emitted verdicts is visible to the guard even
    when it emitted only its own. Every top-level identity appears as a key, with
    0 when it declares no subtest, so a matrix that vanished entirely reads as
    ``620 -> 0`` rather than as a family the breakdown never mentions - which is
    how ``TestAudit``'s eight subtests and ``Test_nodePlugin_Admit``'s 178 went
    unnoticed in a manifest that still looked plausible.
    """
    families: dict[str, dict[str, int]] = {}
    for verdict in verdicts:
        counts = families.setdefault(verdict.package, {})
        counts.setdefault(verdict.test, 0)
        if not verdict.is_top_level:
            counts[verdict.test] += 1
    return families


def _check_skip_roster(
    verdicts: Sequence[Verdict], *, source_label: str, enforce_count: bool = True
) -> None:
    """Hold the ``skip`` verdicts to the EXACT measured roster.

    INVARIANT LOCKED: today's skips are a recorded fact, not a tolerance. AAP
    §0.10.3 requires that "any skipped or known-failing test retains identical
    status", so the ported suite must skip exactly what the Go suite skips - which
    means the baseline has to state exactly what that is.

    A COUNT ALONE WOULD NOT DO. If one test started skipping while another stopped,
    the total would still be 25 and nothing would notice; the ported suite would
    then be required to skip the wrong test and to run one that cannot pass. So both
    the count and the family are asserted: every skip must come from the one package
    that has them and must be the known ``procMount`` feature-gate case. Anything
    else is a NEW skip, and a new skip is a test that stopped being exercised -
    which is a silent loss of coverage that looks like a green run.

    Args:
        verdicts: The rows about to be recorded.
        source_label: The command or path they came from, quoted in failures.
        enforce_count: Assert the EXACT count as well as the family. Left on by
            default; :func:`build_manifest` switches it off for a stream whose Go
            rows are not measured (derived mode) or that is running without
            cardinality guards (a synthetic stream in a unit check), because
            neither carries the full measured scope the count describes.

    Raises:
        BaselineError: If the skip count differs, or any skip is outside the known
            package or family.
    """
    skips = [v for v in verdicts if v.action == "skip"]
    unexpected = [
        v
        for v in skips
        if v.package != EXPECTED_SKIP_PACKAGE or EXPECTED_SKIP_MARKER not in v.go_id
    ]
    if unexpected:
        rendered = "\n".join(f"  SKIP  {v.package} :: {v.go_id}" for v in unexpected)
        raise BaselineError(
            f"refusing to record {len(unexpected)} UNRECOGNISED skip(s) from "
            f"{source_label or 'the requested source'}:\n{rendered}\n"
            f"Every skip in the measured baseline is a {EXPECTED_SKIP_MARKER!r} case in "
            f"{EXPECTED_SKIP_PACKAGE} (the ProcMountType feature gate is not enabled in the "
            f"test server). A skip anywhere else is a test that STOPPED being exercised, which "
            f"looks like a green run and is a silent loss of coverage. Investigate it; if it is "
            f"genuinely intended, widen EXPECTED_SKIP_PACKAGE/EXPECTED_SKIP_MARKER in the same "
            f"reviewed change that introduces it."
        )
    if enforce_count and len(skips) != EXPECTED_SKIP_COUNT:
        raise BaselineError(
            f"refusing to record a baseline with {len(skips)} skip(s) from "
            f"{source_label or 'the requested source'}: the measured baseline has exactly "
            f"{EXPECTED_SKIP_COUNT}. MORE means a test stopped being exercised; FEWER means one "
            f"that skips today now runs, which is a behaviour change the ported suite would be "
            f"required to reproduce and could not. Re-measure and update EXPECTED_SKIP_COUNT "
            f"deliberately, in the same reviewed change."
        )


def _check_cardinality(
    breakdown: Mapping[str, Mapping[str, int]],
    families: Mapping[str, Mapping[str, int]],
    expectations: Mapping[str, PackageExpectation],
    *,
    go_rows_are_measured: bool,
) -> None:
    """Enforce the declared per-package and per-family cardinality guards.

    INVARIANT LOCKED: a measured count cannot drift silently. Only packages
    actually present are checked, so a deliberately narrow regeneration is not
    punished for the packages it did not run; a package present but short of its
    declared count aborts, and so does a package whose per-family split has
    changed even when its total happens to still add up.

    THE "ONLY PACKAGES PRESENT" RULE IS NOT A HOLE, but it was one while nothing
    else pinned the domain: a manifest could omit a package entirely and satisfy
    every guard in this function. :func:`check_committed_domain` closes that from
    the other side by requiring the COMMITTED manifest to carry the exact expected
    package set, so the two together leave no path to a smaller artifact - this
    function keeps ad-hoc narrow regenerations usable, and that one keeps the
    committed artifact whole.


    WHY THE GATING IS PER PACKAGE AND PER FIELD. ``top_level`` is a source-level
    fact and is enforced always. ``total``, ``subtests`` and ``subtest_counts``
    describe EMITTED verdicts, so for Go packages they are enforced only when the
    Go rows were measured (``go_rows_are_measured``); a derived manifest is a
    roster by construction and pinning it to an emitted count would make derived
    mode unusable rather than honest. Non-Go packages are enforced in full in both
    modes, because their one row is produced identically either way.

    Args:
        breakdown: Per-package totals, from :func:`_package_breakdown`.
        families: Per-package, per-family subtest counts, from
            :func:`_family_breakdown`.
        expectations: The declared guards.
        go_rows_are_measured: Whether the Go rows came from a real oracle run.

    Raises:
        BaselineError: Naming every violation found, not merely the first.
    """
    problems: list[str] = []
    for package, expectation in expectations.items():
        counts = breakdown.get(package)
        if counts is None:
            continue
        emitted_counts_apply = go_rows_are_measured or is_non_go_package(package)
        checks: list[tuple[str, int]] = [("top_level", counts["top_level"])]
        if emitted_counts_apply:
            checks += [
                ("total", counts["total"]),
                ("subtests", counts["subtests"]),
                ("passes", counts["pass"]),
                ("skips", counts["skip"]),
            ]
        for field, actual in checks:
            wanted = getattr(expectation, field)
            if wanted is not None and actual != wanted:
                problems.append(
                    f"  {package}: {field} is {actual}, expected {wanted}"
                    + (f" ({expectation.note})" if expectation.note else "")
                )
        if expectation.subtest_counts is None or not emitted_counts_apply:
            continue
        observed = families.get(package, {})
        declared = dict(expectation.subtest_counts)
        for family, wanted_subtests in expectation.subtest_counts:
            if family not in observed:
                problems.append(
                    f"  {package}: family {family!r} emitted NO verdict at all, expected "
                    f"1 top-level plus {wanted_subtests} subtest(s). A family that "
                    f"disappears takes every identity beneath it out of the parity domain, "
                    f"and an identity the manifest never records is indistinguishable from "
                    f"a behaviour that never existed."
                )
            elif observed[family] != wanted_subtests:
                problems.append(
                    f"  {package}: family {family!r} has {observed[family]} subtest(s), "
                    f"expected {wanted_subtests}"
                )
        for family in sorted(set(observed) - set(declared)):
            problems.append(
                f"  {package}: family {family!r} is present with {observed[family]} "
                f"subtest(s) but is NOT declared. A new test function widens the domain the "
                f"parity map must cover, so it is recorded here deliberately rather than "
                f"absorbed silently."
            )
    if problems:
        raise BaselineError(
            "cardinality guard violated:\n"
            + "\n".join(problems)
            + "\nThese counts are measured, not aspirational. A shortfall means verdicts were "
            "lost - a build that stopped compiling a test file, a filter that excluded a "
            "matrix, a fixture that returned less than it owns - and recording it would "
            "shrink the parity gate to whatever survived. If the Go suite genuinely changed, "
            "re-measure it and edit PACKAGE_EXPECTATIONS in the same change, so the new "
            "number is a decision rather than a drift."
            "\nONE LEGITIMATE CAUSE IS NOT A REGRESSION AND IS WORTH RULING OUT FIRST: the "
            "pass/skip split of test/integration/auth is FEATURE-GATE DEPENDENT. The 25 skips "
            "are TestPodSecurityGAOnly's ProcMountType fixtures, so a machine that enables "
            "that gate reports the same 43 identities and the same 2179 verdicts with fewer "
            "skips and more passes. That is a different environment, not a different suite: "
            "the baseline records how this checkout behaves under its DEFAULT gates, which is "
            "what the parity criterion is measured against, so regenerate under the default "
            "gates rather than re-pinning these numbers to a gated run."
        )


def build_manifest(
    verdicts: Iterable[Verdict],
    *,
    provenance: str,
    allow_non_green: bool = False,
    expectations: Mapping[str, PackageExpectation] | None = None,
    covers_default_scope: bool = True,
    source_label: str = "",
) -> dict[str, object]:
    """Assemble the manifest, refusing every shape that would weaken the gate.

    INVARIANT LOCKED: a manifest that exists is a manifest that is complete,
    deterministic, free of failures, honest about its skips and internally
    consistent. Each check below closes one way a caller could otherwise end up
    with a smaller artifact and no error.

    Args:
        verdicts: The reduced or derived verdicts, in any order.
        provenance: A value composed from :data:`PROVENANCE_ATOMS` - normally
            through :func:`compose_provenance`, which is what keeps a mixed
            manifest from claiming every row came from Go.
        allow_non_green: Permit a ``skip`` whose package does not pin a skip count.
            Off by default. ``skip`` rows are always recorded verbatim, held to the
            exact measured roster and reported on stderr; ``fail`` rows are refused
            unconditionally and no flag overrides that - see
            :func:`_check_no_failures` for why the two are not one switch.
        expectations: Cardinality guards, defaulting to
            :data:`PACKAGE_EXPECTATIONS` for measured rows and to no guards for
            derived ones (see below). Pass an empty mapping to run without
            guards - only sensible for a synthetic stream in a unit check.
        covers_default_scope: Whether this run covers the FULL default package
            scope. The exact skip count is a property of that scope, so a caller
            who named its own packages - or narrowed the cardinality guards - is
            not held to it. The roster's FAMILY check applies either way.
        source_label: The command or path the verdicts came from, quoted in
            failure messages.

    Returns:
        The manifest, with exactly the five pinned envelope keys.

    Raises:
        BaselineError: On an unknown or non-canonical provenance, a provenance
            that does not describe the rows, an empty verdict set, a duplicate
            identity, ANY failing verdict, an unrecognised, unaccounted or
            miscounted skip, or a cardinality violation.
    """
    atoms = set(split_provenance(provenance))

    ordered = sorted(verdicts, key=lambda v: v.triple)

    if not ordered:
        raise BaselineError(
            f"refusing to write a manifest with zero verdicts (source: "
            f"{source_label or 'unspecified'}). An empty baseline does not fail the parity "
            f"contract - it EMPTIES it, because every assertion the contract makes is "
            f"quantified over the recorded verdicts. Check that the oracle actually ran, that "
            f"the package list is not empty or misspelled, and that the event stream was not "
            f"truncated."
        )

    seen: set[tuple[str, str, str]] = set()
    duplicates: list[str] = []
    for verdict in ordered:
        if verdict.triple in seen:
            duplicates.append(f"{verdict.package} :: {verdict.go_id}")
        seen.add(verdict.triple)
    if duplicates:
        raise BaselineError(
            f"duplicate (package, test, subtest) triples: {sorted(set(duplicates))}. The "
            f"contract keys on that triple, so one row of each pair would be unreachable and "
            f"unprovable. Source: {source_label or 'unspecified'}"
        )

    check_provenance_describes_rows(provenance, ordered)

    resolved_expectations = PACKAGE_EXPECTATIONS if expectations is None else expectations
    go_rows_are_measured = PROVENANCE_GO_TEST_JSON in atoms

    # A FAILURE IS NEVER RECORDED, AND THERE IS NO FLAG FOR IT. `allow_non_green`
    # governs SKIPS only: a skip is a measured property of today's suite that AAP
    # §0.10.3 requires the ported suite to reproduce, while a failure is a
    # regression that recording would turn into a requirement.
    _check_no_failures(ordered, source_label=source_label)
    # Skips ARE recorded verbatim -- skip-stays-skip is a first-class parity
    # outcome -- but "recorded" must never degrade into "unexamined", so they are
    # announced, held to the exact measured roster, and required to be ACCOUNTED FOR
    # by the package they came from. The three checks are independent: the roster
    # knows the one family that legitimately skips today, and the per-package pin
    # knows which packages have a measured skip count at all.
    _report_recorded_skips(ordered)
    _check_skip_roster(
        ordered,
        source_label=source_label,
        # The COUNT describes the DEFAULT measured scope, so it is asserted only for a
        # run of that scope: `covers_default_scope` says the caller did not name its own
        # packages, `expectations is None` says it did not narrow the guards, and
        # measured Go rows say the stream came from a real oracle. A narrower ad-hoc
        # regeneration, a derived stream and a synthetic stream in a unit check all
        # carry a different number legitimately. The FAMILY half of the roster is not
        # gated on any of this - it applies on every route.
        enforce_count=(
            not allow_non_green
            and go_rows_are_measured
            and covers_default_scope
            and expectations is None
        ),
    )
    if not allow_non_green:
        _check_unpinned_skips(ordered, resolved_expectations, source_label=source_label)

    breakdown = _package_breakdown(ordered)
    _check_cardinality(
        breakdown,
        _family_breakdown(ordered),
        resolved_expectations,
        go_rows_are_measured=go_rows_are_measured,
    )

    manifest: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "provenance": provenance,
        "packages": sorted(breakdown),
        "counts": {
            "total": len(ordered),
            "pass": sum(1 for v in ordered if v.action == "pass"),
            "fail": sum(1 for v in ordered if v.action == "fail"),
            "skip": sum(1 for v in ordered if v.action == "skip"),
            "by_package": breakdown,
        },
        "verdicts": [v.to_row() for v in ordered],
    }
    return manifest


_ENVELOPE_KEYS: Final[frozenset[str]] = frozenset(
    {"schema_version", "provenance", "packages", "counts", "verdicts"}
)

_ROW_KEYS: Final[frozenset[str]] = frozenset({"package", "test", "subtest", "action", "elapsed"})

_COUNT_KEYS: Final[frozenset[str]] = frozenset({"total", "pass", "fail", "skip", "by_package"})


def validate_manifest(manifest: object) -> None:
    """Check a manifest against the pinned schema, independently of how it was made.

    INVARIANT LOCKED: whatever reaches disk - or is read back from it - is a shape
    the three downstream readers can consume, and is internally consistent with
    itself. This is what ``--check`` runs, and :func:`write_manifest_atomic` runs it
    again immediately before writing, so a manifest built through the library API
    by a caller who skipped :func:`build_manifest` cannot bypass it either.

    Internal consistency is checked rather than assumed because a manifest whose
    ``counts`` disagree with its ``verdicts`` is worse than one with no counts at
    all: a reader that trusts the summary would conclude the suite is bigger, or
    greener, than the rows say.

    Args:
        manifest: The decoded manifest.

    Raises:
        BaselineError: On any violation, naming the offending key, row or count.
    """
    if not isinstance(manifest, dict):
        raise BaselineError(
            f"manifest must be a JSON object, got {type(manifest).__name__}"
        )

    present = set(manifest)
    if present != set(_ENVELOPE_KEYS):
        missing = sorted(_ENVELOPE_KEYS - present)
        extra = sorted(present - _ENVELOPE_KEYS)
        raise BaselineError(
            f"manifest envelope must hold exactly {sorted(_ENVELOPE_KEYS)}; "
            f"missing={missing}, unexpected={extra}. The shape is pinned because "
            f"parity_baseline_index reads it positionally: an extra key is churn and a "
            f"missing one is malformed."
        )

    schema_version = manifest["schema_version"]
    if not isinstance(schema_version, str) or not schema_version:
        raise BaselineError(
            f"schema_version must be a non-empty string, got {schema_version!r}"
        )
    if schema_version != SCHEMA_VERSION:
        raise BaselineError(
            f"manifest declares schema_version {schema_version!r} but this generator reads "
            f"and writes {SCHEMA_VERSION!r}. Regenerate the manifest rather than editing the "
            f"version, so the shape and the declaration cannot disagree."
        )

    # Canonical form first, then - once the rows are decoded - whether the value
    # actually describes them. Both halves are needed: a syntactically valid
    # provenance can still be false about the rows, which is exactly how the
    # committed manifest came to declare `go_test_json` over a Python row.
    provenance = manifest["provenance"]
    split_provenance(provenance)

    rows = manifest["verdicts"]
    if not isinstance(rows, list):
        raise BaselineError(f"verdicts must be a JSON array, got {type(rows).__name__}")
    if not rows:
        raise BaselineError(
            "verdicts is empty: an empty baseline satisfies every parity assertion "
            "vacuously, which is indistinguishable from having no gate at all"
        )

    verdicts: list[Verdict] = []
    for index, row in enumerate(rows):
        verdicts.append(_validated_row(row, index))

    _validate_row_uniqueness(verdicts)
    _validate_row_order(verdicts)
    check_provenance_describes_rows(str(provenance), verdicts)
    _validate_counts(manifest["counts"], verdicts)
    _validate_packages(manifest["packages"], verdicts)


def _validated_row(row: object, index: int) -> Verdict:
    """Check one manifest row and return it as a :class:`Verdict`.

    INVARIANT LOCKED: the row-level boundary conditions - the exact five keys, the
    verdict action domain, the absence of ``TestMain``, and a ``test`` value with
    no ``/`` in it. The last is the read-side proof that the id split took the
    first separator only: a ``/`` surviving in ``test`` means a subtest name was
    mistaken for an identity.
    """
    where = f"verdicts[{index}]"
    if not isinstance(row, dict):
        raise BaselineError(f"{where} must be a JSON object, got {type(row).__name__}")

    keys = set(row)
    if keys != set(_ROW_KEYS):
        raise BaselineError(
            f"{where} must hold exactly {sorted(_ROW_KEYS)}; "
            f"missing={sorted(_ROW_KEYS - keys)}, unexpected={sorted(keys - _ROW_KEYS)}"
        )

    package = row["package"]
    test = row["test"]
    subtest = row["subtest"]
    action = row["action"]
    elapsed = row["elapsed"]

    for name, value in (("package", package), ("test", test), ("subtest", subtest)):
        if not isinstance(value, str):
            raise BaselineError(
                f"{where}.{name} must be a string, got {type(value).__name__}: {value!r}"
            )
    if not isinstance(package, str) or not package:
        raise BaselineError(f"{where}.package must be a non-empty string")
    if not isinstance(test, str) or not test:
        raise BaselineError(f"{where}.test must be a non-empty string")
    if not isinstance(subtest, str):  # pragma: no cover - covered by the loop above
        raise BaselineError(f"{where}.subtest must be a string")

    if "/" in test:
        raise BaselineError(
            f"{where}.test is {test!r}, which contains '/'. The top-level identity is "
            f"everything BEFORE the first '/', and a '/' surviving here means a subtest name "
            f"was recorded as an identity - the exact corruption that split_go_test_id's "
            f"first-separator rule exists to prevent, and that would break 282 measured ids."
        )
    if test == _TEST_MAIN:
        raise BaselineError(
            f"{where} records {_TEST_MAIN!r}, which is a package entry point rather than a "
            f"test: it emits no verdict event and has no ported counterpart, so it must not "
            f"appear in the manifest"
        )

    if action not in VERDICT_ACTIONS:
        raise BaselineError(
            f"{where}.action is {action!r}, expected one of {sorted(VERDICT_ACTIONS)}"
        )
    if isinstance(elapsed, bool) or not (elapsed is None or isinstance(elapsed, (int, float))):
        raise BaselineError(
            f"{where}.elapsed must be a number or null, got {type(elapsed).__name__}: "
            f"{elapsed!r}"
        )

    return Verdict(
        package=package,
        test=test,
        subtest=subtest,
        action=str(action),
        elapsed=None if elapsed is None else float(elapsed),
    )


def _validate_row_uniqueness(verdicts: Sequence[Verdict]) -> None:
    """Require every ``(package, test, subtest)`` triple to appear exactly once.

    INVARIANT LOCKED: every recorded identity is reachable. The contract keys on the
    triple, so a duplicate makes one row of the pair unprovable - and if the two
    carry different actions, WHICH one the contract compares against is decided by
    a dictionary insertion order rather than by anything a reader can see.

    THIS CHECK IS SEPARATE FROM THE ORDERING CHECK ON PURPOSE, because the ordering
    check cannot substitute for it. :func:`_validate_row_order` compares the row
    order against ``sorted(rows)``, and sorting a list that already holds adjacent
    duplicates returns it unchanged - so a duplicated row is not merely missed, it
    is INVISIBLE to that comparison. ``counts`` cannot catch it either: they are
    computed from the same rows, so a duplicated row is counted twice on both sides
    and the totals agree. :func:`build_manifest` did reject duplicates, but a
    manifest reaching ``--check``, or read back from disk, or assembled by a caller
    using the library API directly, never passed through it - which is exactly the
    path a hand-edited artifact takes.
    """
    counted = Counter(verdict.triple for verdict in verdicts)
    duplicates = sorted(triple for triple, seen in counted.items() if seen > 1)
    if duplicates:
        rendered = [
            f"{package} :: {test}{'/' + subtest if subtest else ''} (x{counted[triple]})"
            for triple in duplicates
            for package, test, subtest in [triple]
        ]
        raise BaselineError(
            f"{len(duplicates)} duplicated (package, test, subtest) identit(ies) in "
            f"verdicts: {rendered[:20]}"
            f"{' (and more)' if len(rendered) > 20 else ''}. The parity contract keys on "
            f"that triple, so one row of each pair is unreachable, and if the two disagree "
            f"on `action` the comparison silently depends on which was indexed last. "
            f"Regenerate the manifest rather than de-duplicating by hand."
        )


def _validate_row_order(verdicts: Sequence[Verdict]) -> None:
    """Require the deterministic ``(package, test, subtest)`` ordering.

    INVARIANT LOCKED: two runs over the same outcomes produce byte-identical
    output apart from ``elapsed``. Order is what makes a regeneration diff
    readable, and an unstable order would bury a single genuine change in
    hundreds of spurious ones - which is how a real regression gets approved.
    """
    expected = sorted(verdicts, key=lambda v: v.triple)
    if [v.triple for v in verdicts] != [v.triple for v in expected]:
        for position, (actual, wanted) in enumerate(zip(verdicts, expected, strict=True)):
            if actual.triple != wanted.triple:
                raise BaselineError(
                    f"verdicts are not sorted by (package, test, subtest): verdicts"
                    f"[{position}] is {actual.triple}, expected {wanted.triple}. "
                    f"Regenerate the manifest; ordering is what keeps a diff legible."
                )


def _validate_counts(counts: object, verdicts: Sequence[Verdict]) -> None:
    """Require ``counts`` to agree with ``verdicts``, including per package.

    INVARIANT LOCKED: the summary cannot lie about the rows. A reader that trusts
    a stale or hand-edited total would conclude the baseline is larger, or
    greener, than it is.
    """
    if not isinstance(counts, dict):
        raise BaselineError(f"counts must be a JSON object, got {type(counts).__name__}")
    keys = set(counts)
    if keys != set(_COUNT_KEYS):
        raise BaselineError(
            f"counts must hold exactly {sorted(_COUNT_KEYS)}; "
            f"missing={sorted(_COUNT_KEYS - keys)}, unexpected={sorted(keys - _COUNT_KEYS)}"
        )

    for key, actual in (
        ("total", len(verdicts)),
        ("pass", sum(1 for v in verdicts if v.action == "pass")),
        ("fail", sum(1 for v in verdicts if v.action == "fail")),
        ("skip", sum(1 for v in verdicts if v.action == "skip")),
    ):
        declared = counts[key]
        if not isinstance(declared, int) or isinstance(declared, bool) or declared != actual:
            raise BaselineError(
                f"counts.{key} is {declared!r} but the verdict array holds {actual}"
            )

    declared_breakdown = counts["by_package"]
    if not isinstance(declared_breakdown, dict):
        raise BaselineError(
            f"counts.by_package must be a JSON object, got "
            f"{type(declared_breakdown).__name__}"
        )
    recomputed = _package_breakdown(verdicts)
    if set(declared_breakdown) != set(recomputed):
        raise BaselineError(
            f"counts.by_package covers {sorted(declared_breakdown)} but the verdict array "
            f"covers {sorted(recomputed)}"
        )
    for package, wanted in recomputed.items():
        declared_bucket = declared_breakdown[package]
        if not isinstance(declared_bucket, dict) or declared_bucket != wanted:
            raise BaselineError(
                f"counts.by_package[{package!r}] is {declared_bucket!r} but the verdict array "
                f"yields {wanted!r}"
            )


def _validate_packages(packages: object, verdicts: Sequence[Verdict]) -> None:
    """Require ``packages`` to be the sorted, distinct packages of ``verdicts``.

    INVARIANT LOCKED: the declared domain of the manifest is exactly the domain
    its rows cover. A package listed with no rows would let a reader believe it
    was checked; a package with rows but unlisted would hide it from a
    domain-level assertion.
    """
    if not isinstance(packages, list) or not all(isinstance(p, str) for p in packages):
        raise BaselineError(f"packages must be an array of strings, got {packages!r}")
    covered = sorted({v.package for v in verdicts})
    if packages != covered:
        raise BaselineError(
            f"packages is {packages} but the verdict array covers {covered} "
            f"(the list must be exactly the distinct packages, sorted)"
        )


def write_manifest_atomic(manifest: Mapping[str, object], path: Path) -> Path:
    """Serialise and install the manifest atomically, or not at all.

    INVARIANT LOCKED: a half-written manifest that still parses would let the
    parity gate pass vacuously. So the content is fully built and fully validated
    BEFORE anything touches the target, it is written to a temporary file in the
    SAME directory - ``os.replace`` is atomic only within one filesystem - flushed
    and ``fsync``-ed so the bytes are durable before the rename, and only then
    moved into place. A crash at any point leaves the previous manifest intact and
    no partial file behind, because the temporary file is removed on every
    exception path.

    Serialisation is fixed and explicit: ``indent=2`` for a reviewable diff,
    ``sort_keys=True`` so key order cannot vary between interpreters,
    ``ensure_ascii=False`` so a non-ASCII identity is stored as itself rather than
    as an escape, and a trailing newline so the file is well-formed for
    line-oriented tools. No wall-clock timestamp is written anywhere: ``elapsed``
    already churns between runs, and a timestamp would add churn without
    information.

    Args:
        manifest: The manifest to write. Re-validated here.
        path: The target file. Parent directories are created.

    Returns:
        The resolved path written.

    Raises:
        BaselineError: If the manifest does not satisfy :func:`validate_manifest`.
        OSError: If the directory cannot be created or the file cannot be written.
    """
    validate_manifest(dict(manifest))

    payload = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    target = path.expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)

    handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - closed explicitly below
        mode="w",
        encoding="utf-8",
        newline="\n",
        dir=str(target.parent),
        prefix=f".{target.name}.",
        suffix=".tmp",
        delete=False,
    )
    temp_path = Path(handle.name)
    try:
        with handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    except BaseException:
        # Includes KeyboardInterrupt and SystemExit on purpose: a stray
        # `.go_baseline.json.<rand>.tmp` in a committed directory is noise a
        # reviewer has to reason about, and it must not survive any exit path.
        # `missing_ok` covers the one benign case, a failure after the rename.
        temp_path.unlink(missing_ok=True)
        raise

    _log(f"wrote {len(payload)} bytes to {target}")
    return target


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    """Declare the CLI the runner and a human both drive.

    INVARIANT LOCKED: the runner's invocation works verbatim.
    ``hack/make-rules/test-parity.sh`` calls
    ``generate_baseline.py --output <path> --packages ${KUBE_PARITY_PACKAGES}`` with
    the variable expanded UNQUOTED, so ``--packages`` must accept several values in
    one flag as well as being repeatable - which is why it is
    ``nargs="+"`` with ``action="extend"`` and not ``action="append"``, the latter
    dying with "unrecognized arguments" on the runner's own default.
    """
    parser = argparse.ArgumentParser(
        prog="generate_baseline.py",
        description=(
            "Generate the parity baseline manifest from the Go oracle. Reduces "
            "`go test -json -count=1 <packages>` to a machine-readable record of every "
            "verdict the suite reports today, which is what the parity contract compares "
            "the ported Python and React suites against."
        ),
        epilog=(
            "Environment: "
            f"{ENV_PACKAGES} supplies the default package list; "
            f"{ENV_BASELINE_FILE} (or {ENV_BASELINE_FILE_ALIAS}) the default output path; "
            f"{ENV_EXTRA_ARGS} extra `go test` arguments. Unrecognised trailing arguments "
            "are forwarded to `go test` as well."
        ),
    )
    parser.add_argument(
        "--packages",
        action="extend",
        nargs="+",
        metavar="PATTERN",
        default=None,
        help=(
            "Go package patterns. Repeatable, and a single value may itself be a "
            "whitespace- or comma-separated list, because shell variables arrive that way. "
            f"Default: ${ENV_PACKAGES} if set, else the built-in measured scope "
            f"({len(DEFAULT_PACKAGES)} packages)."
        ),
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            f"Manifest path. Default: ${ENV_BASELINE_FILE} or ${ENV_BASELINE_FILE_ALIAS} if "
            "set, else <repo-root>/python/tests/parity/baseline/go_baseline.json."
        ),
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Repository root. Default: derived from this file's own location, never from the "
            "working directory, so the runner can invoke it from anywhere."
        ),
    )
    parser.add_argument(
        "--event-stream",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Reduce an already-captured `go test -json` stream instead of running the "
            "oracle. Use '-' for standard input."
        ),
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read the `go test -json` stream from standard input.",
    )
    parser.add_argument(
        "--mode",
        choices=(MODE_GO_TEST_JSON, MODE_DERIVED, MODE_AUTO),
        default=MODE_AUTO,
        help=(
            f"{MODE_GO_TEST_JSON}: require a real stream. {MODE_AUTO} (default): the same, "
            f"reporting a missing Go toolchain as an error rather than substituting anything "
            f"for it. {MODE_DERIVED}: build rows from the Go source inventory and stamp them "
            f"all `pass` - a DIAGNOSTIC only, requiring --allow-derived-baseline, refused by "
            f"--check, and never writable to the committed manifest."
        ),
    )
    parser.add_argument(
        "--allow-derived-baseline",
        action="store_true",
        help=(
            f"Acknowledge that --mode {MODE_DERIVED} produces source-derived rows that were "
            "never executed. Required for that mode, and never sufficient to write the "
            "committed manifest or to satisfy --check."
        ),
    )
    parser.add_argument(
        "--go-binary",
        default="go",
        metavar="NAME",
        help="Go toolchain binary to look up on PATH. Default: go.",
    )
    parser.add_argument(
        "--allow-non-green",
        action="store_true",
        help=(
            f"WAIVE THE EXACT SKIP COUNT, for an ad-hoc regeneration of a narrower scope "
            f"than the measured one. `skip` verdicts need no flag to be recorded: they are "
            f"recorded verbatim, announced on stderr, and held to the measured roster "
            f"({EXPECTED_SKIP_COUNT} {EXPECTED_SKIP_MARKER!r} cases in "
            f"{EXPECTED_SKIP_PACKAGE}), because a test skipped today must stay skipped. This "
            f"flag waives the COUNT half of that roster only - a skip from an unrecognised "
            f"package or family is refused on every route - and it does NOT cover `fail` "
            f"verdicts, which are refused unconditionally: a recorded failure becomes a "
            f"REQUIRED failure and the contract would defend the regression. True actions are "
            f"always recorded verbatim, so skip-stays-skip and pass-stays-pass stay separately "
            f"provable (AAP §0.10.3). It also waives the per-package requirement that a "
            f"skip come from a package whose skip count is pinned in PACKAGE_EXPECTATIONS, "
            f"which is useful for an ad-hoc regeneration of a package outside the default "
            f"scope and never for the committed baseline."
        ),
    )
    parser.add_argument(
        "--allow-narrow-domain",
        action="store_true",
        help=(
            "Permit a run whose package list is narrower than the measured scope to overwrite "
            "the COMMITTED manifest. OFF BY DEFAULT, and refused rather than warned about: the "
            "contract is quantified over the recorded verdicts, so a narrow regeneration writes "
            "a valid, green manifest that silently drops every identity of the packages it "
            "omitted. Send narrow runs to a scratch --output instead; this switch exists for "
            "the rare case where shrinking the committed baseline is genuinely intended."
        ),
    )
    parser.add_argument(
        "--include-non-go-baseline",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Include the single non-Go baseline row - the hack/boilerplate Python case. On by "
            "default so a narrow regeneration cannot drop it by accident; pass "
            "--no-include-non-go-baseline to omit it deliberately."
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Validate the manifest at --output against the pinned schema and exit non-zero on "
            "any violation. Writes nothing and runs no test."
        ),
    )
    return parser


def _resolve_packages(requested: Sequence[str] | None) -> tuple[tuple[str, ...], bool]:
    """Choose the package list: CLI, then environment, then the measured scope.

    Returns:
        ``(packages, explicit)``. ``explicit`` is True when the caller NAMED the
        packages, on the command line or through the environment, and False when the
        measured default scope was used. The distinction matters to
        :func:`check_go_verdict_domain`: a named package that produced no outcome is
        a misspelling or an empty package and must abort, whereas the full default
        scope cannot be required of a caller-supplied stream that was legitimately
        captured from one package.
    """
    if requested:
        return split_package_specs(requested), True
    from_env = os.environ.get(ENV_PACKAGES, "").strip()
    if from_env:
        return split_package_specs([from_env]), True
    return DEFAULT_PACKAGES, False


def check_domain_not_narrowed(
    packages: Sequence[str],
    output: Path,
    repo_root: Path,
    *,
    allow_narrow: bool,
) -> None:
    """Refuse a narrow regeneration that would REPLACE the committed manifest.

    THE HAZARD THIS CLOSES, and it is the one the committed manifest was caught by
    once already: every assertion the parity contract makes is quantified over the
    recorded verdicts, so a manifest is a gate exactly as wide as its domain.
    Regenerating with a narrowed package list - ``--packages ./cluster/gce/gci/``,
    or ``KUBE_PARITY_PACKAGES`` set to the shell tier because it needs no etcd and
    no built apiserver - writes a perfectly valid, perfectly green, perfectly
    ``go_test_json`` manifest that silently DROPS every identity of the packages it
    omitted. Nothing downstream can tell that apart from those behaviours never
    having existed, and the contract goes on reporting green over the remainder.
    That is the same class of defect as recording zero verdicts, which
    :func:`check_go_verdict_domain` already refuses - only quieter, because what
    survives still looks complete.

    A WARNING WOULD NOT BE ENOUGH. This module logs progress to stderr, where CI
    keeps thousands of lines; the failure mode is a manifest that was overwritten
    weeks ago by a run nobody re-read. So the narrow-plus-committed-path
    combination RAISES, and the deliberate case has an explicit switch
    (``--allow-narrow-domain``) which downgrades it to a loud warning. Narrowing
    while writing somewhere else is always fine and is never reported: a scratch
    manifest cannot weaken a gate.

    Both halves of the hazard must be present for either outcome: a domain
    narrower than :data:`DEFAULT_PACKAGES` AND the committed default output path.

    Args:
        packages: The effective package list, in whatever spelling the caller used.
        output: The resolved output path.
        repo_root: The repository root, used to locate the committed manifest.
        allow_narrow: Permit the narrowing, recording it as a warning instead.

    Raises:
        BaselineError: When the run would narrow the committed manifest and
            ``allow_narrow`` is False.
    """
    default_paths = {import_path_for_package_spec(spec) for spec in DEFAULT_PACKAGES}
    requested_paths = {import_path_for_package_spec(spec) for spec in packages}
    omitted = sorted(default_paths - requested_paths)
    if not omitted:
        return
    try:
        writing_committed = output.resolve() == default_baseline_path(repo_root).resolve()
    except OSError:  # pragma: no cover - resolve() on an unreachable parent
        writing_committed = False
    if not writing_committed:
        return

    consequence = (
        f"this run covers a NARROWER domain than the measured scope and writes the COMMITTED "
        f"manifest {output}. Omitted package(s): {omitted}. Every identity they hold would "
        f"disappear from the baseline, and the parity contract - which is quantified over the "
        f"recorded verdicts - would then report green while asserting nothing about them."
    )
    remedy = (
        f"Drop --packages / {ENV_PACKAGES} so the full measured scope runs "
        f"({len(DEFAULT_PACKAGES)} packages; the three integration packages need etcd on "
        f"PATH), or send a deliberately narrow run somewhere harmless with --output, or pass "
        f"--allow-narrow-domain if shrinking the committed baseline really is the intent."
    )
    if allow_narrow:
        _log(f"WARNING: {consequence} Proceeding because --allow-narrow-domain was passed.")
        return
    raise BaselineError(f"refusing to narrow the committed baseline: {consequence} {remedy}")


def _resolve_output(requested: Path | None, repo_root: Path) -> Path:
    """Choose the output path: CLI, then either environment spelling, then default.

    INVARIANT LOCKED: writer and reader resolve the same file. The committed runner
    spells the variable ``KUBE_PARITY_BASELINE`` while the plan documents
    ``KUBE_PARITY_BASELINE_FILE``; both are honoured, with the code-pinned spelling
    winning, so neither can be set to no effect.
    """
    if requested is not None:
        return requested
    for key in (ENV_BASELINE_FILE, ENV_BASELINE_FILE_ALIAS):
        value = os.environ.get(key, "").strip()
        if value:
            return Path(value)
    return default_baseline_path(repo_root)


def _flag_name(argument: str) -> str:
    """Reduce ``-count=1`` / ``--count=1`` / ``-count`` to the bare name ``count``.

    Go's flag package accepts one or two leading dashes interchangeably and both
    ``-flag=value`` and ``-flag value``, so a check keyed on the literal spelling is
    a check with three trivial bypasses. Everything is normalised to the name alone
    before any decision is taken.
    """
    stripped = argument.lstrip("-")
    return stripped.split("=", 1)[0]


#: The ONLY `go test` flags this generator will forward, by bare name.
#:
#: AN ALLOW-LIST RATHER THAN A DENY-LIST, and the difference is the whole fix. The
#: previous deny-list held exactly one entry, `-run`, which left every other way of
#: changing WHICH tests run wide open - and each of them produces a smaller manifest
#: with no error, because a verdict that was never emitted is indistinguishable from
#: a behaviour that never existed:
#:
#:   * `-skip` excludes by pattern, the exact complement of `-run`.
#:   * `-list` PRINTS test names and runs nothing, so the stream carries no verdicts.
#:   * `-bench` / `-benchtime` / `-benchmem` select benchmarks; §0.8.2 puts the 137
#:     benchmark files and the one fuzz target outside the parity domain outright.
#:   * `-fuzz` runs a fuzz target instead of the suite.
#:   * `-short` makes `testing.Short()` true, and a test that calls `t.Skip` under it
#:     turns from a `pass` verdict into a `skip` - a CHANGED result, which is the one
#:     thing the contract exists to catch.
#:   * `-c` compiles the test binary without running it. Zero verdicts.
#:   * `-tags` excludes whole test FILES at build time, silently.
#:   * `-cpu=1,2` runs every test once per value, which produces duplicate triples.
#:   * `-failfast` stops at the first failure, truncating the domain.
#:   * `-count=0` runs nothing; `-count=2` duplicates every triple.
#:
#: The allowed set is confined to flags that cannot change the identity or the
#: presence of a verdict. `-count` is allowed only as exactly 1, which is the value
#: §0.9.2 requires anyway for determinism, and `-timeout`, `-p`, `-parallel`, `-v`,
#: `-race` and `-mod=vendor` change how the run is executed, never what it contains.
_ALLOWED_GO_TEST_FLAGS: Final[frozenset[str]] = frozenset(
    {"count", "mod", "p", "parallel", "race", "timeout", "v", "json"}
)

#: The one value `-count` may take. See :data:`_ALLOWED_GO_TEST_FLAGS`.
_REQUIRED_COUNT_VALUE: Final[str] = "1"

#: The flags in :data:`_ALLOWED_GO_TEST_FLAGS` that are BOOLEAN, so a bare
#: occurrence needs no following value. Everything else consumes the next token
#: when it is written in the separated form.
_BOOLEAN_GO_TEST_FLAGS: Final[frozenset[str]] = frozenset({"v", "race", "json"})

#: The one value `-mod` may take, in `GOFLAGS` or as a forwarded argument.
#: AAP §0.9.4.2 requires vendor mode for every Go invocation and §0.8.2 freezes the
#: dependency graph, so this is a constant rather than a default.
_REQUIRED_MOD_VALUE: Final[str] = "vendor"

#: The `-timeout` injected when a caller supplies none, chosen from the measured
#: cost of the domain rather than picked round: `test/integration/auth` alone takes
#: about 208 s, and the full eight-package oracle run measured in this session
#: completed well inside 40 minutes. `make test-integration` uses `-timeout 30m`
#: for the integration packages alone; 40m covers those plus the shell and unit
#: packages in one invocation with headroom for a slower machine.
#:
#: WHY A DEFAULT AT ALL. `go test` applies a 10-minute per-package timeout by
#: default, which the integration packages can legitimately exceed - so a run with
#: no `-timeout` is not "unbounded", it is bounded WRONGLY, and it fails a healthy
#: oracle. Injecting an explicit value makes the bound visible in the logged command
#: instead of implicit in the toolchain.
GO_TEST_DEFAULT_TIMEOUT: Final[str] = "40m"

#: The oracle's own `-timeout`, used when the caller forwards none. An ALIAS of
#: :data:`GO_TEST_DEFAULT_TIMEOUT` rather than a second value, because two defaults
#: for one bound is how a run ends up timed out by whichever constant the code path
#: happened to reach. AAP §0.7.3 names 30m as the budget `make test-integration`
#: runs under for the integration packages alone; this scope adds the shell and unit
#: packages to the same invocation, which is why the shared value is larger.
DEFAULT_ORACLE_TIMEOUT: Final[str] = GO_TEST_DEFAULT_TIMEOUT

#: Seconds added to the Go-side timeout to obtain this process's OUTER deadline.
#:
#: The two bounds are deliberately not equal. Go's `-timeout` is enforced by the
#: test binary and produces a proper panic with a goroutine dump, which is far more
#: useful than a killed process - so the outer deadline must fire only if the inner
#: one did NOT, meaning the binary is wedged, the toolchain is stuck compiling, or a
#: child process is holding the pipe open. The margin is generous because `go test`
#: also has to build, and a cold build of the integration packages is minutes of
#: work before the first test runs.
OUTER_TIMEOUT_MARGIN_SECONDS: Final[float] = 600.0

#: Seconds to wait for a timed-out process group to die on SIGTERM before SIGKILL.
#: Short, because by this point the run has already blown its deadline; non-zero,
#: because SIGTERM lets `go test` and any etcd it started remove their temporary
#: directories, and a SIGKILL that skips that leaves the workspace littered.
PROCESS_GROUP_TERM_GRACE_SECONDS: Final[float] = 10.0

#: Go duration unit suffixes and their length in seconds, longest suffix first so
#: `ms` is matched before `s`. Transcribed from Go's `time.ParseDuration`, which is
#: what `-timeout` is parsed by.
_GO_DURATION_UNITS: Final[tuple[tuple[str, float], ...]] = (
    ("ns", 1e-9),
    ("us", 1e-6),
    # Both micro spellings, because Go's own unit table carries both: U+00B5 MICRO
    # SIGN and U+03BC GREEK SMALL LETTER MU. Accepting only one would refuse a value
    # the toolchain accepts, and this function's `None` is a REFUSAL rather than a
    # shrug, so a false refusal here would abort a legitimate run.
    ("\u00b5s", 1e-6),
    ("\u03bcs", 1e-6),
    ("ms", 1e-3),
    ("s", 1.0),
    ("m", 60.0),
    ("h", 3600.0),
)


def parse_go_duration(text: str) -> float | None:
    """Parse a Go duration such as ``30m``, ``1h30m`` or ``500ms`` into seconds.

    Mirrors ``time.ParseDuration`` closely enough for the one decision that depends
    on it: whether a ``-timeout`` is a finite POSITIVE bound. A bare ``0`` is
    accepted and returns ``0.0``, which the caller refuses - in Go, ``-timeout 0``
    means NO timeout at all, so it is the single most dangerous value here and must
    not be mistaken for "a very short one".

    Returns:
        The duration in seconds, or ``None`` when the text is not a duration this
        function can vouch for. ``None`` is a REFUSAL signal, never a default: a
        value that cannot be parsed must not be assumed benign.
    """
    candidate = text.strip()
    if not candidate:
        return None
    if candidate.lstrip("+-").isdigit() and float(candidate) == 0:
        # Go accepts a unit-less zero, and only zero. It means "no timeout".
        return 0.0

    total = 0.0
    index = 0
    matched_any = False
    while index < len(candidate):
        digits = index
        if candidate[digits] in "+-":
            # ONLY at the very start. Go reads the sign once, before its component
            # loop, so `1h-30m` is an "invalid duration" there rather than a
            # subtraction. Accepting it here would compute an outer deadline from a
            # value `go test` is about to reject.
            if index != 0:
                return None
            digits += 1
        start = digits
        while digits < len(candidate) and (candidate[digits].isdigit() or candidate[digits] == "."):
            digits += 1
        if digits == start:
            return None
        try:
            magnitude = float(candidate[index:digits])
        except ValueError:
            return None
        for suffix, seconds in _GO_DURATION_UNITS:
            if candidate.startswith(suffix, digits):
                total += magnitude * seconds
                index = digits + len(suffix)
                matched_any = True
                break
        else:
            return None
    return total if matched_any else None


def _require_bounded_timeout(argument: str, value: str) -> float:
    """Refuse a ``-timeout`` that is not a finite POSITIVE duration.

    ``-timeout 0`` is the dangerous one and the reason this exists: in Go it means
    NO timeout, so a hung test binary holds the pipe open for as long as the process
    lives. In CI that is a job that burns its whole wall-clock allowance and reports
    nothing; locally it is a run that never returns. An unparsable value is refused
    for the same reason - ``go test`` would reject it, but only AFTER this script had
    computed an outer deadline from a value it did not understand.

    Returns:
        The timeout in seconds, for the caller to derive its outer deadline from.

    Raises:
        BaselineError: On zero, negative, or unparsable durations.
    """
    seconds = parse_go_duration(value)
    if seconds is None:
        raise BaselineError(
            f"refusing the oracle argument {argument!r}: {value!r} is not a Go duration this "
            f"script can parse, so no outer deadline could be derived from it. Use a form "
            f"`time.ParseDuration` accepts, such as `30m`, `1h30m` or `90s`."
        )
    if seconds <= 0:
        raise BaselineError(
            f"refusing the oracle argument {argument!r}: a `-timeout` of {value!r} is "
            f"{'ZERO, which in Go means NO TIMEOUT AT ALL' if seconds == 0 else 'negative'}. "
            f"A wedged test binary would then hold the capture pipe open indefinitely - in CI "
            f"that is a job that burns its entire wall-clock allowance and reports nothing. "
            f"Pass a finite positive duration, or pass none and accept the default "
            f"{GO_TEST_DEFAULT_TIMEOUT}."
        )
    return seconds


def _timeout_budget(extra_args: Sequence[str]) -> tuple[tuple[str, ...], float]:
    """Return the oracle arguments with a guaranteed ``-timeout``, and the outer deadline.

    TWO BOUNDS, DELIBERATELY UNEQUAL. The inner one is Go's own ``-timeout``, which
    the test binary enforces and reports as a panic with a goroutine dump - by far
    the most useful diagnostic available for a hang. The outer one is this process's
    ``communicate`` deadline, and it exists only for the failures the inner bound
    cannot catch: a toolchain wedged while building, a child that outlived the test
    binary and still holds the pipe, or a binary that ignored its own alarm.

    :data:`OUTER_TIMEOUT_MARGIN_SECONDS` separates them so the inner bound always
    fires first on an ordinary hang. If the outer one fires, something is wrong in a
    way the goroutine dump would not have explained anyway.

    Returns:
        ``(arguments, outer_deadline_seconds)``. The arguments are returned rather
        than mutated in place so the injected default appears in the logged command
        and the caller cannot forget to use it.
    """
    for index, argument in enumerate(extra_args):
        if _flag_name(argument) != "timeout":
            continue
        if "=" in argument:
            inner = _require_bounded_timeout(argument, argument.split("=", 1)[1])
        elif index + 1 < len(extra_args):
            inner = _require_bounded_timeout(
                f"-timeout {extra_args[index + 1]}", extra_args[index + 1]
            )
        else:
            raise BaselineError(
                f"refusing the oracle arguments {list(extra_args)}: `-timeout` expects a value "
                f"and none followed it."
            )
        return tuple(extra_args), inner + OUTER_TIMEOUT_MARGIN_SECONDS

    injected = (f"-timeout={GO_TEST_DEFAULT_TIMEOUT}", *extra_args)
    inner = _require_bounded_timeout(injected[0], GO_TEST_DEFAULT_TIMEOUT)
    _log(
        f"no -timeout was supplied; injecting {injected[0]} so the run is bounded by the "
        f"toolchain rather than by go test's 10-minute per-package default, which the "
        f"integration packages legitimately exceed"
    )
    return injected, inner + OUTER_TIMEOUT_MARGIN_SECONDS


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    """Kill the timed-out child's whole PROCESS GROUP, SIGTERM then SIGKILL.

    THE GROUP, NOT THE PROCESS. ``go test`` is a supervisor: it builds and then
    execs one test binary per package, and the integration packages start a real
    etcd of their own. Killing only the ``go`` process leaves every one of those
    orphaned - still holding the capture pipe, still holding its data directory,
    still holding a port that the next run needs. The child is therefore started
    with ``start_new_session=True`` so it LEADS its own group, which is what makes
    one ``killpg`` sufficient and what guarantees the signal cannot reach this
    process or the pytest session that invoked it.

    SIGTERM first, with a short grace period, because ``go test`` and etcd both
    clean up their temporary directories on it; SIGKILL only for whatever ignored
    that. Every failure mode here is swallowed deliberately: this runs while an
    exception is already being raised, and a secondary error from a process that has
    ALREADY exited must not replace the timeout the caller needs to see.
    """
    try:
        group = os.getpgid(process.pid)
    except (ProcessLookupError, PermissionError, OSError):
        # Already reaped, or not ours to signal. Either way there is no group left.
        return

    for signal_number, wait_for in (
        (signal.SIGTERM, PROCESS_GROUP_TERM_GRACE_SECONDS),
        (signal.SIGKILL, PROCESS_GROUP_TERM_GRACE_SECONDS),
    ):
        try:
            os.killpg(group, signal_number)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            process.wait(timeout=wait_for)
            return
        except subprocess.TimeoutExpired:
            continue


def validate_go_flag_value(argument: str, name: str, value: str) -> None:
    """Refuse an allowed flag carrying a value that would weaken the oracle.

    INVARIANT LOCKED, AND IT APPLIES TO EVERY SOURCE AND EVERY SPELLING. The
    allow-list decides which flags may be forwarded; this decides what they may
    SAY. Both halves are needed, and only having the first is how three bypasses
    survived:

    * ``-mod mod`` in the separated form. The attached form ``-mod=mod`` was
      refused, but the separated one only had its NAME checked and its value rode
      along unexamined - so the vendored, offline-capable build this repository
      freezes could be turned into a network module resolution, silently changing
      what the oracle compiles.
    * ``-timeout=0``. ``timeout`` is an allowed flag and its value was never
      looked at, and ``0`` is precisely how ``go test`` is told to run without a
      timeout. A hung oracle then wedges the job instead of failing it, and AAP
      §0.7.3 requires the run to be bounded.
    * ``GOFLAGS`` entirely. See :func:`_oracle_environment`.

    Args:
        argument: The argument as written, quoted in the message.
        name: Its bare name from :func:`_flag_name`.
        value: Its value.

    Raises:
        BaselineError: On any value that changes the domain, the dependency
            resolution or the boundedness of the run.
    """
    if name == "count" and value != _REQUIRED_COUNT_VALUE:
        raise BaselineError(
            f"refusing the oracle argument {argument!r}: only "
            f"`-count={_REQUIRED_COUNT_VALUE}` is permitted. 0 runs nothing and anything "
            f"above 1 repeats every test, producing duplicate (package, test, subtest) "
            f"triples that the contract cannot key on."
        )
    if name == "mod" and value != _REQUIRED_MOD_VALUE:
        raise BaselineError(
            f"refusing the oracle argument {argument!r}: this repository vendors its "
            f"dependencies and §0.9.4.2 requires `-mod=vendor`, so any other value would "
            f"attempt a download the build is not permitted to make - and would let the "
            f"oracle compile against a dependency graph that is not the frozen one."
        )
    if name == "timeout":
        # Delegated rather than duplicated: `_require_bounded_timeout` is what the
        # outer deadline is derived from, so one refusal message covers both, and a
        # value this validator accepted could never be one that function rejects.
        _require_bounded_timeout(argument, value)
    if name in {"p", "parallel"} and (not value.isdigit() or int(value) < 1):
        raise BaselineError(
            f"refusing the oracle argument {argument!r}: `-{name}` must be a positive "
            f"integer, and {value!r} is not. Zero or a negative value is either rejected "
            f"by the toolchain or read as 'unlimited', neither of which is a decision "
            f"this generator should make silently."
        )
    if name in _BOOLEAN_GO_TEST_FLAGS and value not in {"true", "false"}:
        raise BaselineError(
            f"refusing the oracle argument {argument!r}: `-{name}` is a boolean flag, so its "
            f"only values are `true` and `false`. {value!r} would be rejected by the "
            f"toolchain, and a run that fails to start produces no baseline at all."
        )


def _resolve_extra_go_args(forwarded: Sequence[str]) -> tuple[str, ...]:
    """Collect extra `go test` arguments, forwarding only the demonstrably benign.

    INVARIANT LOCKED: no forwarded argument can change WHICH tests run or WHETHER a
    verdict is emitted. Anything outside :data:`_ALLOWED_GO_TEST_FLAGS` is refused
    with the reason, rather than being handed to the toolchain to shrink the
    manifest quietly.

    Positional arguments are refused too: a bare package path here would be added
    to the ones ``--packages`` resolved, silently widening a domain that the
    manifest then declares as though it had been chosen.

    Raises:
        BaselineError: On any argument that is not an allowed flag, and on
            ``-count`` with a value other than 1.
    """
    collected: list[str] = []
    from_env = os.environ.get(ENV_EXTRA_ARGS, "").strip()
    if from_env:
        collected.extend(from_env.split())
    collected.extend(forwarded)

    # A bare `--` is argparse's end-of-options marker and is the natural way a
    # caller separates forwarded `go test` flags from this script's own. It reaches
    # here through parse_known_args, carries no meaning for `go test`, and is
    # dropped rather than refused - refusing it would reject the documented
    # invocation shape for a token with no effect.
    collected = [argument for argument in collected if argument != "--"]

    expecting_value_for = ""
    for argument in collected:
        if expecting_value_for:
            # The separated form, `-timeout 30m`. Its value goes through EXACTLY the
            # same validator as the attached form: checking only the name here is
            # what let `-mod mod` and `-timeout 0` through while `-mod=mod` and
            # `-timeout=0` were refused.
            validate_go_flag_value(
                f"-{expecting_value_for} {argument}", expecting_value_for, argument
            )
            expecting_value_for = ""
            continue

        if not argument.startswith("-"):
            raise BaselineError(
                f"refusing the oracle argument {argument!r}: only `go test` FLAGS may be "
                f"forwarded, and a positional argument here is read by the toolchain as an "
                f"extra package. That widens the run without widening what --packages "
                f"resolved, so the manifest would declare a domain nobody chose. Pass "
                f"packages with --packages."
            )

        name = _flag_name(argument)
        if name not in _ALLOWED_GO_TEST_FLAGS:
            raise BaselineError(
                f"refusing the oracle argument {argument!r}: `-{name}` is not in the "
                f"allow-list {sorted(_ALLOWED_GO_TEST_FLAGS)}. Selection, listing, skipping, "
                f"benchmark and fuzz flags are refused because every test they exclude is a "
                f"verdict missing from the baseline, which the parity contract cannot tell "
                f"apart from a behaviour that never existed - and a flag that merely LOOKS "
                f"harmless is refused too, because the cost of being wrong is a silently "
                f"smaller gate. Narrow the run with --packages instead, which narrows the "
                f"manifest's declared domain honestly."
            )

        if "=" in argument:
            validate_go_flag_value(argument, name, argument.split("=", 1)[1])
            continue

        # A boolean flag needs no value; the rest take the next token.
        if name not in _BOOLEAN_GO_TEST_FLAGS:
            expecting_value_for = name

    if expecting_value_for:
        raise BaselineError(
            f"refusing the oracle arguments {collected}: `-{expecting_value_for}` expects a "
            f"value and none followed it. An incomplete flag would consume whatever `go test` "
            f"saw next, which here is a package path."
        )

    # AN EXPLICIT, POSITIVE, FINITE BOUND ALWAYS. Without this the run inherits Go's
    # implicit 10-minute per-package default, which is both invisible in the command
    # line the log prints and too tight for the integration packages
    # (`test/integration/auth` alone takes roughly 208 seconds). AAP §0.7.3 names 30m as
    # the budget `make test-integration` runs under, so that is the default here too.
    if not any(_flag_name(argument) == "timeout" for argument in collected):
        collected.append(f"-timeout={DEFAULT_ORACLE_TIMEOUT}")

    if collected:
        _log(f"forwarding extra `go test` arguments: {collected}")
    return tuple(collected)


def _read_stream_lines(path: Path | None, use_stdin: bool) -> tuple[list[str], str]:
    """Read a captured event stream FULLY before any parsing happens.

    INVARIANT LOCKED: the exit-141 hazard cannot bite. The stream is consumed
    whole - never sliced, never short-read - so a producer on the other end of a
    pipe is never killed by SIGPIPE mid-write, which would truncate the stream and
    report 141 as though a test had failed.
    """
    if use_stdin or (path is not None and str(path) == "-"):
        return sys.stdin.read().splitlines(), "<stdin>"
    if path is None:  # pragma: no cover - guarded by the caller
        raise BaselineError("no event stream requested")
    if not path.is_file():
        raise BaselineError(
            f"event stream {path} does not exist or is not a file. Capture one with "
            f"`go test -json -count=1 <packages> > {path}` - redirect to a FILE rather than "
            f"piping, so a partially consumed pipe cannot truncate it."
        )
    return path.read_text(encoding="utf-8").splitlines(), str(path)


def check_committed_domain(manifest: Mapping[str, object], *, source: str) -> None:
    """Prove a manifest describes the WHOLE expected domain, not merely a consistent one.

    :func:`validate_manifest` answers "is this a well-formed manifest?" and nothing
    more, and that is exactly the gap this closes. Every check there is INTERNAL -
    schema keys, row shapes, sorted order, no duplicates, counts that agree with the
    rows - so a manifest holding one row is perfectly valid and asserts nothing at
    all. A deleted, truncated or narrowly regenerated baseline therefore passed
    ``--check``, and the parity contract, being quantified over the recorded rows,
    passed with it. That is not a gate that can fail.

    FOUR OBLIGATIONS, all of them EXTERNAL - measured facts the artifact is compared
    against rather than derived from:

    1. PROVENANCE IS A REAL ORACLE RUN. ``derived`` rows are read off source and
       stamped ``pass`` wholesale, so a derived manifest is an assertion that
       everything passes made by something that ran nothing.
    2. THE PACKAGE SET IS EXACTLY THE EXPECTED ONE. Not a subset and not a superset:
       a missing package is a silently narrower gate, and an unexpected one is a
       domain nobody chose to measure.
    3. EVERY PACKAGE MATCHES ITS PINNED CARDINALITY - total, top-level, subtest,
       pass and skip counts alike. This is where a manifest recording 43 rows for a
       package that emits 2,179 of them fails.
    4. THE VERDICT DISTRIBUTION IS THE MEASURED ONE. Zero failures, and exactly the
       measured pass and skip totals, so a regeneration cannot quietly turn a
       passing test into a skipped one - "pass the same way as they pass today"
       includes the skips.

    Args:
        manifest: An already schema-validated manifest.
        source: Where it came from, quoted in every message.

    Raises:
        BaselineError: On any of the four, naming exactly what differs.
    """
    # THE PROVENANCE IS READ AS ATOMS, NOT AS A STRING. The committed manifest carries
    # one measured non-Go row alongside the Go ones, so its honest envelope is the
    # COMPOSED value `go_test_json+non_go_measured` - a string equality test against
    # `go_test_json` would reject the only honest spelling and, worse, would reward the
    # dishonest one. What actually matters is the two atoms: the Go rows must claim a
    # real oracle run, and the derived atom must be absent.
    provenance = manifest.get("provenance")
    atoms = set(split_provenance(provenance))
    if PROVENANCE_GO_TEST_JSON not in atoms or PROVENANCE_DERIVED in atoms:
        raise BaselineError(
            f"{source} records provenance={provenance!r}, and a parity-gated baseline must "
            f"declare {PROVENANCE_GO_TEST_JSON!r} for its Go rows and must not declare "
            f"{PROVENANCE_DERIVED!r}. Rows built any other way were not produced by "
            f"running the suite: {PROVENANCE_DERIVED!r} in particular reads Go source and "
            f"stamps every row `pass`, which is an assertion that everything passes made by "
            f"something that ran nothing. Regenerate it by executing the oracle. A measured "
            f"non-Go row is declared with {PROVENANCE_NON_GO_MEASURED!r} alongside the Go "
            f"atom - see compose_provenance() - and is accepted here."
        )

    expected_packages = sorted(PACKAGE_EXPECTATIONS)
    packages = manifest.get("packages")
    actual_packages = sorted(packages) if isinstance(packages, list) else []
    if actual_packages != expected_packages:
        missing = sorted(set(expected_packages) - set(actual_packages))
        unexpected = sorted(set(actual_packages) - set(expected_packages))
        raise BaselineError(
            f"{source} does not declare the expected parity domain. Missing: "
            f"{missing or 'none'}. Unexpected: {unexpected or 'none'}. The committed baseline "
            f"must cover every package in PACKAGE_EXPECTATIONS - the eight Go packages of the "
            f"measured scope plus the non-Go {NON_GO_BASELINE_PACKAGE!r} row - because a "
            f"package absent from the manifest is a package the contract says nothing about, "
            f"which it cannot tell apart from one whose behaviours never existed. If the "
            f"scope genuinely changed, edit PACKAGE_EXPECTATIONS in the same change so the "
            f"new domain is a decision rather than a drift."
        )

    counts = manifest.get("counts")
    by_package = counts.get("by_package") if isinstance(counts, Mapping) else None
    if not isinstance(by_package, Mapping):
        raise BaselineError(
            f"{source} carries no counts.by_package breakdown, so its per-package "
            f"cardinalities cannot be checked at all."
        )
    breakdown = {
        package: dict(bucket)
        for package, bucket in by_package.items()
        if isinstance(bucket, Mapping)
    }
    # The per-family split is read from the ROWS, because `counts.by_package` records
    # package totals only. Both are checked: a manifest can carry the right totals and
    # still have lost a whole subtest FAMILY to a rename.
    rows = manifest.get("verdicts")
    recorded = [
        Verdict(
            package=str(row["package"]),
            test=str(row["test"]),
            subtest=str(row.get("subtest") or ""),
            action=str(row["action"]),
            elapsed=None,
        )
        for row in rows
        if isinstance(row, Mapping)
    ] if isinstance(rows, list) else []
    _check_cardinality(
        breakdown,
        _family_breakdown(recorded),
        PACKAGE_EXPECTATIONS,
        # The committed manifest is a MEASURED artifact by definition -- this function
        # has already refused any other provenance -- so every emitted count applies,
        # per-family split included.
        go_rows_are_measured=True,
    )

    expected_total = sum(e.total or 0 for e in PACKAGE_EXPECTATIONS.values())
    expected_pass = sum(e.passes or 0 for e in PACKAGE_EXPECTATIONS.values())
    expected_skip = sum(e.skips or 0 for e in PACKAGE_EXPECTATIONS.values())
    actual = {
        key: counts.get(key) if isinstance(counts, Mapping) else None
        for key in ("total", "pass", "fail", "skip")
    }
    wanted = {"total": expected_total, "pass": expected_pass, "fail": 0, "skip": expected_skip}
    if actual != wanted:
        raise BaselineError(
            f"{source} does not carry the measured verdict distribution: expected {wanted}, "
            f"found {actual}. These totals are the sum of the pinned per-package numbers, so "
            f"a mismatch means either a package is short or an action changed - a pass that "
            f"became a skip is exactly the regression 'pass the same way as they pass today' "
            f"forbids, and a recorded failure would make the contract require that failure "
            f"forever."
        )


def _run_check(output: Path) -> int:
    """Validate an existing manifest, writing nothing.

    INVARIANT LOCKED: the committed artifact is verifiable without regenerating it,
    which is what lets a gate confirm the manifest a change actually commits rather
    than one it could have produced - and the verification is of the DOMAIN as well
    as the schema, so a manifest that is merely self-consistent cannot pass.
    """
    if not output.is_file():
        raise BaselineError(
            f"--check found no manifest at {output}. Generate one first, or point --check at "
            f"the right path with --output."
        )
    try:
        decoded = json.loads(output.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BaselineError(f"{output} is not valid JSON: {exc}") from exc
    validate_manifest(decoded)
    check_committed_domain(decoded, source=str(output))
    counts = decoded["counts"]
    _log(
        f"OK: {output} is a valid schema {SCHEMA_VERSION} manifest over the complete parity "
        f"domain - {counts['total']} verdicts ({counts['pass']} pass, {counts['fail']} fail, "
        f"{counts['skip']} skip) across {len(decoded['packages'])} package(s), "
        f"provenance={decoded['provenance']}"
    )
    return EXIT_OK


def _collect_verdicts(
    args: argparse.Namespace,
    *,
    repo_root: Path,
    packages: Sequence[str],
    packages_explicit: bool,
    forwarded: Sequence[str],
) -> tuple[tuple[Verdict, ...], str, str]:
    """Obtain verdicts by the selected route, and report which route was taken.

    INVARIANT LOCKED: ``provenance`` always matches how the rows were actually
    obtained, ROW GROUP BY ROW GROUP. In ``auto`` mode the fallback to derived data
    is announced on stderr AND stamped in the manifest, so derived data can never
    be read as measured data - which is the whole reason the field exists. The
    appended non-Go row contributes its own atom through
    :func:`compose_provenance` rather than inheriting the Go one, because it never
    came from a Go run and stamping it as though it had was false about that row
    and misleading about the rest.

    Returns:
        ``(verdicts, provenance, source_label)``.
    """
    stream_requested = args.stdin or args.event_stream is not None
    if args.stdin and args.event_stream is not None and str(args.event_stream) != "-":
        raise BaselineError(
            "--stdin and --event-stream are mutually exclusive: pass one source, or use "
            "--event-stream - to mean standard input"
        )

    if stream_requested:
        if args.mode == MODE_DERIVED:
            raise BaselineError(
                f"--mode {MODE_DERIVED} builds from the measured source inventory and reads "
                f"no stream, but an event stream was supplied. Drop the stream, or use "
                f"--mode {MODE_GO_TEST_JSON} to reduce it."
            )
        lines, label = _read_stream_lines(args.event_stream, args.stdin)
        reduction = reduce_event_stream(lines, source=label)
        _log(
            f"reduced {reduction.event_count} events from {label} -> "
            f"{len(reduction.verdicts)} verdicts"
        )
        # BEFORE the non-Go row is appended, never after: the whole point is that a
        # stream yielding no Go verdicts must not be rescued into a one-row
        # manifest. `require_requested` is False here because a caller-supplied
        # stream was captured from a package list this process never chose - unless
        # the caller stated one, in which case honouring it is what catches a
        # stream that does not contain what was asked for.
        check_go_verdict_domain(
            reduction, packages=packages, require_requested=packages_explicit
        )
        verdicts = list(reduction.verdicts)
        atoms = [PROVENANCE_GO_TEST_JSON]
        if args.include_non_go_baseline:
            verdicts.append(_non_go_baseline_verdict())
            atoms.append(PROVENANCE_NON_GO_MEASURED)
        return tuple(verdicts), compose_provenance(*atoms), label

    mode = args.mode
    if mode == MODE_AUTO:
        if shutil.which(args.go_binary) is None:
            # NO FALLBACK. This used to become `derived` with a warning, and the
            # warning was the entire safeguard: on a machine without Go the DEFAULT
            # invocation wrote an all-green baseline invented from source to the
            # committed path, and the parity contract then certified the port
            # against it. A missing toolchain is a blocker, not a degraded mode.
            raise BaselineError(
                f"no {args.go_binary!r} toolchain on PATH, so the Go oracle cannot be run "
                f"and there is nothing to measure. The baseline records what the suite DOES "
                f"today, which is knowable only by executing it, so --mode {MODE_AUTO} "
                f"reports this rather than inventing rows: load the toolchain the repository "
                f"pins in .go-version (`. /etc/profile.d/go.sh` in this image) and re-run, "
                f"or reduce an already-captured stream with --event-stream. "
                f"--mode {MODE_DERIVED} exists only as a source-inventory DIAGNOSTIC, needs "
                f"--allow-derived-baseline, and cannot be written to the committed manifest."
            )
        mode = MODE_GO_TEST_JSON

    if mode == MODE_DERIVED:
        if not args.allow_derived_baseline:
            raise BaselineError(
                f"--mode {MODE_DERIVED} builds rows from the Go SOURCE INVENTORY and stamps "
                f"every one of them `pass`, because reading a test's name cannot tell you "
                f"what it did. That is a diagnostic - useful for checking this module's "
                f"inventory against the source tree - and it is not a baseline: the "
                f"engagement's success criterion is that the ported suite behaves as the Go "
                f"suite BEHAVES, which only execution establishes. Pass "
                f"--allow-derived-baseline to acknowledge that, and note that the result "
                f"still cannot be written to the committed manifest and still fails --check."
            )
        _log(
            f"WARNING: building from the measured source inventory. Every row will be "
            f"stamped `pass` because no test was run, and the manifest will record "
            f"provenance={PROVENANCE_DERIVED!r}. This is a DIAGNOSTIC, not a parity "
            f"baseline: --check refuses this provenance and the committed manifest cannot "
            f"be written from it."
        )
        verdicts = list(
            derive_verdicts_from_source_inventory(
                repo_root,
                packages=packages,
                include_non_go_baseline=args.include_non_go_baseline,
            )
        )
        atoms = [PROVENANCE_DERIVED]
        if args.include_non_go_baseline:
            atoms.append(PROVENANCE_NON_GO_MEASURED)
        return (
            tuple(verdicts),
            compose_provenance(*atoms),
            "the measured source inventory",
        )

    reduction = run_go_test_json(
        packages,
        repo_root=repo_root,
        extra_args=forwarded,
        go_binary=args.go_binary,
    )
    # `packages` IS the argument list this process handed to `go test`, so every
    # entry must have produced an outcome. A zero-exit run can still be missing a
    # package - `go test` reports "no test files" and exits 0 - and it can still
    # hold a package-level failure whose tests all passed.
    check_go_verdict_domain(reduction, packages=packages, require_requested=True)
    verdicts = list(reduction.verdicts)
    atoms = [PROVENANCE_GO_TEST_JSON]
    if args.include_non_go_baseline:
        verdicts.append(_non_go_baseline_verdict())
        atoms.append(PROVENANCE_NON_GO_MEASURED)
    return tuple(verdicts), compose_provenance(*atoms), reduction.source


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point: generate or validate the baseline manifest.

    INVARIANT LOCKED: every failure mode is reported as a non-zero exit with an
    actionable message, and none of them can produce a written manifest. The
    ``__main__`` guard below is the only place ``sys.exit`` is called, so this
    function is callable from a test or another tool without terminating the
    interpreter.

    Args:
        argv: Arguments excluding the program name; ``None`` means ``sys.argv[1:]``.

    Returns:
        :data:`EXIT_OK`, :data:`EXIT_BASELINE_ERROR` or :data:`EXIT_IO_ERROR`.
        argparse exits with 2 on a usage error before this returns.
    """
    parser = _build_arg_parser()
    args, forwarded = parser.parse_known_args(None if argv is None else list(argv))

    try:
        repo_root = (
            args.repo_root.expanduser().resolve()
            if args.repo_root is not None
            else repo_root_from_file()
        )
        output = _resolve_output(args.output, repo_root)

        if args.check:
            return _run_check(output.expanduser())

        packages, packages_explicit = _resolve_packages(args.packages)
        # BEFORE the oracle is invoked and before anything is written: a run that
        # would shrink the committed baseline must cost nothing and change nothing.
        check_domain_not_narrowed(
            packages, output, repo_root, allow_narrow=args.allow_narrow_domain
        )
        extra_go_args = _resolve_extra_go_args(forwarded)
        verdicts, provenance, source_label = _collect_verdicts(
            args,
            repo_root=repo_root,
            packages=packages,
            packages_explicit=packages_explicit,
            forwarded=extra_go_args,
        )
        # THE COMMITTED PATH IS RESERVED FOR MEASURED ROWS. Checked before the
        # manifest is built, so a derived run cannot even reach the writer: the
        # committed manifest is what the parity contract reads, and a file at that
        # path claiming every test passes on the strength of having read their names
        # is the single most damaging artifact this tool could produce.
        if provenance != PROVENANCE_GO_TEST_JSON:
            committed = default_baseline_path(repo_root)
            if output.expanduser().resolve() == committed.resolve():
                raise BaselineError(
                    f"refusing to write provenance={provenance!r} rows to the COMMITTED "
                    f"baseline {committed}. That file is what the parity contract reads, so a "
                    f"manifest there asserts what the Go suite does today - and these rows "
                    f"were not produced by running it. Write the diagnostic somewhere else "
                    f"with --output, or run the oracle."
                )

        manifest = build_manifest(
            verdicts,
            provenance=provenance,
            allow_non_green=args.allow_non_green,
            covers_default_scope=not packages_explicit,
            source_label=source_label,
        )
        written = write_manifest_atomic(manifest, output)
        # Summarised from the verdicts rather than by re-reading the envelope, so
        # the closing line cannot disagree with the rows that were just written.
        actions = [v.action for v in verdicts]
        _log(
            f"baseline ready: {len(actions)} verdicts "
            f"({actions.count('pass')} pass, {actions.count('fail')} fail, "
            f"{actions.count('skip')} skip) across "
            f"{len({v.package for v in verdicts})} package(s), "
            f"provenance={provenance}, at {written}"
        )
        return EXIT_OK
    except BaselineError as exc:
        _log(f"ERROR: {exc}")
        return EXIT_BASELINE_ERROR
    except OSError as exc:
        _log(f"ERROR: {exc}")
        return EXIT_IO_ERROR


if __name__ == "__main__":
    sys.exit(main())
