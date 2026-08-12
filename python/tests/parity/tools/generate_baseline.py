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

TWO PROVENANCES, NEVER CONFLATED

``provenance`` is the honesty field of the manifest. ``go_test_json`` means
every row came from a real oracle run. ``derived_from_source_inventory`` means
the rows came from the measured Go source inventory encoded in this module,
because no Go toolchain was reachable. Both are legitimate inputs to the
contract; presenting the second as the first would not be.

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
        PROVENANCE_DERIVED, build_manifest,
        derive_verdicts_from_source_inventory, write_manifest_atomic,
    )

    verdicts = derive_verdicts_from_source_inventory(repo_root)
    manifest = build_manifest(verdicts, provenance=PROVENANCE_DERIVED)
    write_manifest_atomic(manifest, path)
"""

# AAP §0.4.5 (the parity harness and this generator) / §0.5.1 (the
# tests/parity/tools/generate_baseline.py row) / §0.5.2.4 ("go_baseline.json is
# generated rather than hand-written, and tools/generate_baseline.py is the
# generator") / §0.2.1.9 gap 3 (no machine-readable baseline manifest exists) /
# tech-spec §6.6.3.2 (the required success rate is 100 percent with zero
# failures, which is the all-green invariant enforced here).
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
import subprocess
import sys
import tempfile
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
    "MODE_AUTO",
    "MODE_DERIVED",
    "MODE_GO_TEST_JSON",
    "NON_GO_BASELINE_PACKAGE",
    "NON_GO_BASELINE_TEST",
    "PACKAGE_EXPECTATIONS",
    "PROVENANCE_DERIVED",
    "PROVENANCE_GO_TEST_JSON",
    "SCHEMA_VERSION",
    "VERDICT_ACTIONS",
    "BaselineError",
    "PackageExpectation",
    "StreamReduction",
    "Verdict",
    "build_manifest",
    "check_go_verdict_domain",
    "default_baseline_path",
    "derive_verdicts_from_source_inventory",
    "go_rewrite_subtest_name",
    "import_path_for_package_spec",
    "main",
    "reduce_event_stream",
    "repo_root_from_file",
    "run_go_test_json",
    "split_go_test_id",
    "split_package_specs",
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

#: Every row came from a real `go test -json` event stream.
PROVENANCE_GO_TEST_JSON: Final[str] = "go_test_json"

#: Every row came from the measured Go source inventory in this module, because
#: no Go toolchain was reachable. Recorded rather than hidden: a contract that
#: cannot tell measured data from derived data cannot be trusted about either.
PROVENANCE_DERIVED: Final[str] = "derived_from_source_inventory"

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
MODE_DERIVED: Final[str] = "derived"

#: Prefer a real run; fall back to `derived` ONLY when no Go toolchain is
#: present, saying so loudly on stderr and setting `provenance` accordingly.
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
#: `hack/boilerplate/boilerplate_test.py`, whose measured baseline is
#: "Ran 1 test in 0.001s / OK". It belongs in the manifest because the plan's
#: baseline scale ends with "and the single Python boilerplate case", and
#: `parity_map.py` binds it as its `NON_GO_BASELINE` entry. Exported so that map
#: can single-source the spelling instead of re-typing it.
NON_GO_BASELINE_PACKAGE: Final[str] = "hack/boilerplate"

#: The identity of that case, matching the ported node id
#: `hack/boilerplate/boilerplate_test.py::test_boilerplate`.
NON_GO_BASELINE_TEST: Final[str] = "test_boilerplate"


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


@dataclass(frozen=True, slots=True)
class PackageExpectation:
    """A declared cardinality guard for one package.

    INVARIANT LOCKED: a measured count changes only through an explicit edit
    here. Silent drift is exactly the failure this guard exists to catch - a
    build that stops compiling one test file, a filter that quietly excludes a
    matrix, a rename that halves a subtest count. Any field left ``None`` is
    deliberately unconstrained, which is how a package whose subtest cardinality
    was never measured avoids being pinned to a number nobody counted.

    Attributes:
        total: Required number of verdicts, or ``None``.
        top_level: Required number of top-level identities, or ``None``.
        subtests: Required number of subtest verdicts, or ``None``.
        note: Where the numbers come from, quoted in the failure message so the
            reader can re-measure rather than guess.
    """

    total: int | None = None
    top_level: int | None = None
    subtests: int | None = None
    note: str = ""


#: The declared, overridable cardinality guards.
#:
#: Both entries are measured rather than quoted. `cluster/gce/gci` was re-run in
#: this session with `go test -json -count=1 ./cluster/gce/gci/`, whose stream
#: reduced to 648 verdicts - 8 top-level and 640 subtests, all `pass` - with the
#: per-function subtest split 2/2/2/2/0/2/10/620 (TestEncryptionProviderConfig is
#: flat and declares no `t.Run` at all, which is why one of the eight
#: contributes no subtest). `test/integration/auth` has 44 `^func Test`
#: declarations of which one is `TestMain`, leaving 43 identities.
#:
#: `test/integration/auth` constrains ONLY `top_level`. Several of its 43 tests
#: do declare subtests, and that cardinality has never been measured here, so
#: pinning `total` would invent a number.
PACKAGE_EXPECTATIONS: Final[Mapping[str, PackageExpectation]] = {
    f"{GO_MODULE_PATH}/cluster/gce/gci": PackageExpectation(
        total=648,
        top_level=8,
        subtests=640,
        note=(
            "measured: go test -json -count=1 ./cluster/gce/gci/ reduces to 648 verdicts "
            "(8 top-level + 640 subtests), per function 2/2/2/2/0/2/10/620"
        ),
    ),
    f"{GO_MODULE_PATH}/test/integration/auth": PackageExpectation(
        top_level=43,
        note=(
            "measured: 44 '^func Test' declarations in test/integration/auth minus TestMain "
            "(main_test.go:27), which emits no verdict event"
        ),
    ),
}


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

    INVARIANT LOCKED: ``-mod=vendor`` is present and a caller's ``GOFLAGS`` is
    APPENDED TO, never overwritten. Dependencies are vendored and builds are
    offline-capable, so a run that resolved modules from the network could
    silently alter what the oracle compiles - and clobbering an inherited
    ``GOFLAGS`` would discard whatever the runner or CI deliberately set.
    """
    env = dict(base)
    goflags = env.get("GOFLAGS", "")
    if "-mod=" not in goflags:
        env["GOFLAGS"] = f"{goflags} -mod=vendor".strip()
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

    command = [resolved, "test", "-json", "-count=1", *extra_args, *packages]
    printable = " ".join(command)
    _log(f"running the Go oracle: {printable}")
    _log(f"working directory: {repo_root}")

    child_env = _oracle_environment(os.environ if env is None else env)

    with tempfile.TemporaryDirectory(prefix="go-baseline-stream-") as scratch:
        stream_path = Path(scratch) / "go-test.json"
        with stream_path.open("w", encoding="utf-8") as sink:
            # shell=False (the default) with an argument list: no word splitting,
            # no glob expansion and no injection surface from a package name. A
            # `shell=True` string would give all three away for nothing.
            completed = subprocess.run(
                command,
                cwd=str(repo_root),
                env=child_env,
                stdout=sink,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
        raw = stream_path.read_text(encoding="utf-8")

    stderr_text = (completed.stderr or "").strip()
    if stderr_text:
        # Surfaced, never swallowed: a build error appears here and nowhere else.
        _log("go test stderr follows")
        print(stderr_text, file=sys.stderr)

    reduction = reduce_event_stream(raw.splitlines(), source=f"`{printable}`")

    if completed.returncode != 0:
        failed = [v.go_id for v in reduction.verdicts if v.action == "fail"]
        failing_packages = sorted(
            pkg for pkg, status in reduction.package_status.items() if status != "pass"
        )
        raise BaselineError(
            f"the Go oracle exited {completed.returncode} for packages "
            f"{list(packages)} and yielded {len(reduction.verdicts)} verdicts "
            f"({len(failed)} of them failing). "
            f"Non-passing packages: {failing_packages or 'none reported'}. "
            f"Failing tests: {failed[:20] or 'none reported'}"
            f"{' (and more)' if len(failed) > 20 else ''}. "
            f"A non-zero oracle exit with no failing verdict usually means a BUILD error, a "
            f"TestMain abort or a panic outside any test - see the stderr above. The measured "
            f"baseline is 100 percent pass with zero failures and zero skips, so this must be "
            f"fixed rather than recorded."
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
# the top-level names and by reducing a real `go test -json` stream for the shell
# package's subtests. Nothing is estimated, rounded or inferred: where a subtest
# cardinality was never measured, the test is recorded as a top-level verdict
# only, which is why `TestAudit` contributes one row rather than an invented
# handful.
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
            note=(
                "TOP-LEVEL ONLY, DELIBERATELY: audit_test.go declares t.Run at lines 398 and "
                "405 over a matrix whose cardinality has not been measured here, so recording "
                "a subtest count would be a fabrication. A real oracle run supplies the "
                "subtests and records provenance=go_test_json"
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
    4. EVERY REQUESTED PACKAGE IS PRESENT. A misspelled or silently-empty package
       contributes nothing, and a domain that is missing a package cannot be told
       apart from a domain where that package's behaviours never existed.

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
            f"The measured baseline is 100 percent pass with zero failures and zero skips, "
            f"so this must be fixed rather than recorded."
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
    summarised = set(reduction.package_status) | packages_with_verdicts
    # A recursive pattern names a SUBTREE, so any package beneath it satisfies it.
    # Requiring the root itself to report an outcome would fail every `/...` run,
    # since the root directory usually holds no tests of its own.
    absent = [
        package
        for package in requested
        if package not in summarised
        and not any(seen.startswith(f"{package}/") for seen in summarised)
    ]
    if absent:
        raise BaselineError(
            f"{len(absent)} requested package(s) produced no outcome in {reduction.source}: "
            f"{absent}. Packages seen: {sorted(summarised)}. A requested package that "
            f"contributes nothing is either misspelled or holds no tests, and either way the "
            f"manifest's declared domain would be narrower than the domain that was asked "
            f"for - which the parity contract cannot tell apart from those behaviours never "
            f"having existed."
        )


def _non_go_baseline_verdict() -> Verdict:
    """The single non-Go baseline row.

    INVARIANT LOCKED: the one Python case in the baseline scale is present
    regardless of which Go packages were run. It is appended by an explicit,
    default-on switch rather than inferred from a stream, because letting a
    ``go test`` invocation decide whether a Python test is recorded is exactly how
    a narrow regeneration would drop it by accident.

    ``elapsed`` is ``None``: the measured baseline is the unittest runner's
    "Ran 1 test in 0.001s / OK", which is a suite total rather than a per-test
    duration reported by the Go toolchain, and inventing one would misrepresent
    where the number came from.
    """
    return Verdict(
        package=NON_GO_BASELINE_PACKAGE,
        test=NON_GO_BASELINE_TEST,
        subtest="",
        action="pass",
        elapsed=None,
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


def _check_all_green(verdicts: Sequence[Verdict], *, source_label: str) -> None:
    """Refuse a baseline that is not 100 percent pass, naming EVERY offender.

    INVARIANT LOCKED: the measured baseline is 100 percent pass with zero failures
    and zero skips, and a regeneration that quietly records a regression turns the
    contract's "verdict equality" assertion into a rubber stamp - a test that
    fails today would then be required to fail tomorrow.

    Every offender is listed rather than the first, for the same reason the ported
    RBAC test accumulates findings instead of aborting: one report per run is worth
    more than one bisection per finding.
    """
    offenders = [v for v in verdicts if v.action != "pass"]
    if not offenders:
        return
    rendered = "\n".join(
        f"  {v.action.upper():5} {v.package} :: {v.go_id}" for v in offenders
    )
    fail_count = sum(1 for v in offenders if v.action == "fail")
    skip_count = sum(1 for v in offenders if v.action == "skip")
    raise BaselineError(
        f"refusing to record a baseline that is not all-green: {len(offenders)} of "
        f"{len(verdicts)} verdicts are non-passing ({fail_count} fail, {skip_count} skip) "
        f"from {source_label or 'the requested source'}.\n{rendered}\n"
        f"The measured baseline is 100 percent pass with zero failures and zero skips, so "
        f"fix the offenders rather than recording them. If a non-green baseline is genuinely "
        f"intended - a test that is legitimately skipped today and must stay skipped - pass "
        f"--allow-non-green, which records the true actions verbatim so skip-stays-skip "
        f"remains provable."
    )


def _check_cardinality(
    breakdown: Mapping[str, Mapping[str, int]],
    expectations: Mapping[str, PackageExpectation],
) -> None:
    """Enforce the declared per-package cardinality guards.

    INVARIANT LOCKED: a measured count cannot drift silently. Only packages
    actually present are checked, so a deliberately narrow regeneration is not
    punished for the packages it did not run; a package present but short of its
    declared count aborts.
    """
    problems: list[str] = []
    for package, expectation in expectations.items():
        counts = breakdown.get(package)
        if counts is None:
            continue
        for field, actual in (
            ("total", counts["total"]),
            ("top_level", counts["top_level"]),
            ("subtests", counts["subtests"]),
        ):
            wanted = getattr(expectation, field)
            if wanted is not None and actual != wanted:
                problems.append(
                    f"  {package}: {field} is {actual}, expected {wanted}"
                    + (f" ({expectation.note})" if expectation.note else "")
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
        )


def build_manifest(
    verdicts: Iterable[Verdict],
    *,
    provenance: str,
    allow_non_green: bool = False,
    expectations: Mapping[str, PackageExpectation] | None = None,
    source_label: str = "",
) -> dict[str, object]:
    """Assemble the manifest, refusing every shape that would weaken the gate.

    INVARIANT LOCKED: a manifest that exists is a manifest that is complete,
    deterministic, all-green (unless explicitly allowed otherwise) and internally
    consistent. Each check below closes one way a caller could otherwise end up
    with a smaller artifact and no error.

    Args:
        verdicts: The reduced or derived verdicts, in any order.
        provenance: :data:`PROVENANCE_GO_TEST_JSON` or :data:`PROVENANCE_DERIVED`.
        allow_non_green: Permit ``fail`` / ``skip`` rows. Off by default.
        expectations: Cardinality guards, defaulting to
            :data:`PACKAGE_EXPECTATIONS`. Pass an empty mapping to run without
            guards - only sensible for a synthetic stream in a unit check.
        source_label: The command or path the verdicts came from, quoted in
            failure messages.

    Returns:
        The manifest, with exactly the five pinned envelope keys.

    Raises:
        BaselineError: On an unknown provenance, an empty verdict set, a duplicate
            identity, a non-green baseline, or a cardinality violation.
    """
    if provenance not in {PROVENANCE_GO_TEST_JSON, PROVENANCE_DERIVED}:
        raise BaselineError(
            f"unknown provenance {provenance!r}: expected {PROVENANCE_GO_TEST_JSON!r} for a "
            f"real oracle run or {PROVENANCE_DERIVED!r} for the measured source inventory. "
            f"This field is how a reader tells measured data from derived data, so it may "
            f"not be improvised."
        )

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

    if not allow_non_green:
        _check_all_green(ordered, source_label=source_label)

    breakdown = _package_breakdown(ordered)
    _check_cardinality(
        breakdown, PACKAGE_EXPECTATIONS if expectations is None else expectations
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

    provenance = manifest["provenance"]
    if provenance not in {PROVENANCE_GO_TEST_JSON, PROVENANCE_DERIVED}:
        raise BaselineError(
            f"provenance must be {PROVENANCE_GO_TEST_JSON!r} or {PROVENANCE_DERIVED!r}, "
            f"got {provenance!r}"
        )

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
            f"{MODE_GO_TEST_JSON}: require a real stream. {MODE_DERIVED}: build from the "
            f"measured source inventory. {MODE_AUTO} (default): prefer a real run, falling "
            "back to derived only when no Go toolchain is present, saying so on stderr and "
            "recording it in the manifest's provenance."
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
            "Record `fail` and `skip` verdicts instead of refusing them. OFF BY DEFAULT: the "
            "measured baseline is 100 percent pass with zero failures and zero skips, and "
            "silently recording a regression would make the contract require it forever. The "
            "true actions are always recorded verbatim, so skip-stays-skip stays provable."
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
            # The separated form, `-timeout 30m`. The flag itself was already
            # allowed, so its value rides along - except for -count, checked below.
            if expecting_value_for == "count" and argument != _REQUIRED_COUNT_VALUE:
                raise BaselineError(
                    f"refusing the oracle argument `-count {argument}`: only "
                    f"`-count={_REQUIRED_COUNT_VALUE}` is permitted. 0 runs nothing and "
                    f"anything above 1 repeats every test, producing duplicate "
                    f"(package, test, subtest) triples that the contract cannot key on."
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
            value = argument.split("=", 1)[1]
            if name == "count" and value != _REQUIRED_COUNT_VALUE:
                raise BaselineError(
                    f"refusing the oracle argument {argument!r}: only "
                    f"`-count={_REQUIRED_COUNT_VALUE}` is permitted. 0 runs nothing and "
                    f"anything above 1 repeats every test, producing duplicate "
                    f"(package, test, subtest) triples that the contract cannot key on."
                )
            if name == "mod" and value != "vendor":
                raise BaselineError(
                    f"refusing the oracle argument {argument!r}: this repository vendors its "
                    f"dependencies and §0.9.4.2 requires `-mod=vendor`, so any other value "
                    f"would attempt a download the build is not permitted to make."
                )
            continue

        # A boolean flag needs no value; the rest take the next token.
        if name not in {"v", "race", "json"}:
            expecting_value_for = name

    if expecting_value_for:
        raise BaselineError(
            f"refusing the oracle arguments {collected}: `-{expecting_value_for}` expects a "
            f"value and none followed it. An incomplete flag would consume whatever `go test` "
            f"saw next, which here is a package path."
        )

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


def _run_check(output: Path) -> int:
    """Validate an existing manifest, writing nothing.

    INVARIANT LOCKED: the committed artifact is verifiable without regenerating it,
    which is what lets a gate confirm the manifest a change actually commits rather
    than one it could have produced.
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
    counts = decoded["counts"]
    _log(
        f"OK: {output} is a valid schema {SCHEMA_VERSION} manifest - "
        f"{counts['total']} verdicts ({counts['pass']} pass, {counts['fail']} fail, "
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
    obtained. In ``auto`` mode the fallback to derived data is announced on stderr
    AND stamped in the manifest, so derived data can never be read as measured
    data - which is the whole reason the field exists.

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
        if args.include_non_go_baseline:
            verdicts.append(_non_go_baseline_verdict())
        return tuple(verdicts), PROVENANCE_GO_TEST_JSON, label

    mode = args.mode
    if mode == MODE_AUTO:
        if shutil.which(args.go_binary) is None:
            _log(
                f"WARNING: no {args.go_binary!r} toolchain on PATH, so --mode {MODE_AUTO} is "
                f"FALLING BACK to {MODE_DERIVED}. The manifest will record "
                f"provenance={PROVENANCE_DERIVED!r}: its rows come from the measured Go "
                f"source inventory, not from a run of the oracle. Load the toolchain and "
                f"re-run to produce a measured baseline."
            )
            mode = MODE_DERIVED
        else:
            mode = MODE_GO_TEST_JSON

    if mode == MODE_DERIVED:
        verdicts = list(
            derive_verdicts_from_source_inventory(
                repo_root,
                packages=packages,
                include_non_go_baseline=args.include_non_go_baseline,
            )
        )
        return tuple(verdicts), PROVENANCE_DERIVED, "the measured source inventory"

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
    if args.include_non_go_baseline:
        verdicts.append(_non_go_baseline_verdict())
    return tuple(verdicts), PROVENANCE_GO_TEST_JSON, reduction.source


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
        extra_go_args = _resolve_extra_go_args(forwarded)
        verdicts, provenance, source_label = _collect_verdicts(
            args,
            repo_root=repo_root,
            packages=packages,
            packages_explicit=packages_explicit,
            forwarded=extra_go_args,
        )
        manifest = build_manifest(
            verdicts,
            provenance=provenance,
            allow_non_green=args.allow_non_green,
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
