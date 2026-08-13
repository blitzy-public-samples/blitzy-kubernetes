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

"""``append_or_replace_prefixed_line`` drops every prefixed line, then appends one.

AAP §0.4.2.1 (the L1 shell-boundary blueprint for this component) / §0.5.1 and
§0.5.2.1 (this module's CREATE row and its ten-case detail) / §0.3.1.4 (why the
``cluster/gce/gci`` package is in scope at all) / tech-spec §6.6.1.1, which
records the property the whole tier exists to preserve: the test "proves the
shipped shell generator, not a re-implementation".

PORTS: ``TestAppendOrReplacePrefix``,
cluster/gce/gci/append_or_replace_prefixed_line_test.go:28 — one top-level
identity and ten subtests, which are ten of the 648 measured verdicts of the
``k8s.io/kubernetes/cluster/gce/gci`` package that AAP §0.7.1.2 requires this
port to reproduce exactly.

INVARIANT LOCKED BY THIS MODULE: for each of the ten oracle cases, invoking the
SHIPPED ``append_or_replace_prefixed_line`` from
``cluster/gce/gci/configure-helper.sh`` against a file holding known initial
contents leaves that file holding EXACTLY the bytes the Go oracle expects —
every line beginning with the prefix removed from wherever it sat, one canonical
``${prefix}${suffix}`` line appended at the end, and the trailing newline
``echo`` supplies. Nothing here reproduces that behaviour; this module's entire
job is to observe it.

WHY THIS ONE-SCREEN SHELL FUNCTION IS WORTH A GATE

It maintains the API server's static token file. ``configure-helper.sh``
L828-871 calls it once per control-plane identity —
``append_or_replace_prefixed_line "${known_tokens_csv}" "${KUBE_BEARER_TOKEN},"
"admin,admin,system:masters"`` and thirteen siblings for the bootstrap, cloud
controller manager, controller manager, scheduler, cluster autoscaler, proxy,
node problem detector, GLBC, addon manager, konnectivity server and monitoring
principals — with the token itself, plus a comma, as the PREFIX.

That makes the *replace* half a security property rather than a tidiness one. If
a regression left the function appending without first dropping the matching
lines, a rotated token's OLD line would survive in ``known_tokens_csv`` and the
superseded credential would keep authenticating, silently, while a cluster came
up looking healthy. Cases 3, 5, 8 and 10 below are the ones that would catch
that, which is why none of them may be dropped as "redundant with case 2".

WHAT THE SHIPPED IMPLEMENTATION DOES, AND WHY THE LINE MOVES TO THE END

configure-helper.sh L645-656, quoted rather than paraphrased::

    touch "${file}"
    awk -v pfx="${prefix}" 'substr($0,1,length(pfx)) != pfx { print }' "${file}" > "${tmpfile}"
    echo "${prefix}${suffix}" >> "${tmpfile}"
    mv "${tmpfile}" "${file}"

Three consequences that the expected values encode, and that a reader should not
mistake for oddities in the table:

* the match is on the PREFIX ONLY, never on ``${prefix}${suffix}``, so a line is
  dropped whatever follows the prefix. Cases 4 and 9 ("content between the
  prefix and suffix") and cases 5 and 10 ("prefix == suffix") are simply that
  rule applied, not separate behaviours;
* surviving lines keep their relative order and the canonical line is APPENDED,
  so a file that already contained the prefix ends up with that line at the END
  rather than where it was. Cases 3, 5, 8, 9 and 10 all show the replacement
  landing last;
* ``echo`` terminates the appended line, so every expected value ends with a
  newline. That newline is part of the contract, not incidental whitespace.

One environmental consequence matters for the fixture: the function creates its
scratch file with ``mktemp "${dirname}/filtered.XXXX"``, i.e. INSIDE the target
file's own directory. The target must therefore sit somewhere writable, which is
one of two reasons every case gets its own ``tmp_path``.

THE ARGUMENTS REACH BASH UNQUOTED, AND THAT IS THE POINT OF FIVE OF TEN CASES

The oracle builds one command string and interpolates all three arguments raw
(append_or_replace_prefixed_line_test.go:166)::

    args := fmt.Sprintf("source configure-helper.sh; append_or_replace_prefixed_line %s %s %s",
                        f.Name(), tc.prefix, tc.suffix)

``%s``, not ``%q``, and deliberately so. The Pair B prefix is the Go raw string
``'"$argon2id$v=19"'`` — the single quotes are PART OF THE VALUE, bash consumes
them during word splitting, and the function therefore receives
``"$argon2id$v=19"``. That is exactly why cases 6 to 10 expect
``"$argon2id$v=19"admin`` in the file.

So no quoting may be added here. Measured in this repository against the shipped
script, not reasoned about: passing the same token through ``shlex.quote``
still exits 0 and still writes a file — one holding
``'"$argon2id$v=19"'admin`` instead. The failure mode is silent content
corruption, not a loud error, which is why the seam is closed by ENUMERATION
rather than by escaping. ``tests.helpers.bash`` restricts raw substitution to
the four literals this oracle passes (``ALLOWED_RAW_ARGUMENT_TOKENS``), and
:meth:`~tests.unit.shell.conftest.BashInvoker.must_invoke_func_with_args` passes
the SCRIPT NAME and the TARGET PATH as positional parameters — ``"$1"`` and
``"$2"`` — so the one element the Go original does interpolate but that pytest
derives from ``--basetemp`` and the test's own name cannot be evaluated as shell
code either.

HOW THE GO FAILURE POSTURES SURVIVE THE LANGUAGE CHANGE

The oracle's census is four ``t.Fatalf`` and one ``t.Errorf`` (AAP §0.4.1.2):

    Go call                                     Here
    ------------------------------------------  --------------------------------
    t.Fatalf on os.CreateTemp failure           ``tmp_path`` + ``write_text``,
    t.Fatalf on f.WriteString failure           whose OSError aborts the case
    t.Fatalf on CombinedOutput failure          ``must_invoke_func_with_args``
                                                raises ``BashInvocationError``
    t.Fatalf on os.ReadFile failure             ``read_text``, whose OSError
                                                aborts the case
    t.Errorf on the cmp.Diff mismatch           one bare ``assert`` per case

The single ``t.Errorf`` is NOT translated with ``pytest.Subtests``, even though
this suite uses subtests elsewhere for exactly that Go construct. The reason is
structural: each of the oracle's ten cases is an independent ``t.Run``, so each
already owns its own verdict, and ``@pytest.mark.parametrize`` reproduces that
one-verdict-per-case shape directly. Wrapping the comparison in a subtest would
add a second layer of reporting inside a case that contains exactly one
assertion, and would collapse ten node ids into one — which is precisely what
the parity contract must be able to see apart.

THE EXPECTED BYTES ARE COMPARED WHOLE

``got == case.want`` over the full file contents, exactly as the oracle's
``cmp.Diff(string(got), tc.want)`` compares whole strings. No ``strip()``, no
``rstrip()``, no line-list normalisation and no "ignore trailing whitespace":
every expected value ends with a newline, a missing or doubled one is a real
behaviour change in the shipped script, and a comparison that tolerated it would
be a weaker gate than the one being replaced (AAP §0.10.2).

THE NODE IDS ARE A PUBLIC CONTRACT

``python/tests/parity/parity_map.py`` is hand-maintained and pins the mapping
from each Go identifier to its Python counterpart (AAP §0.5.5), so this module's
function name and its ten ids are part of its interface, not an implementation
detail. Consequently the ids are written out as explicit literals carried
alongside the case they name — never left to pytest's auto-generation, and never
computed from ``desc`` at import time, so that rewording a description cannot
silently rename a pinned node id. :func:`_pinned_node_ids` refuses a duplicate,
because pytest would otherwise disambiguate two identical ids by appending an
index and quietly break the mapping.

TIER CONSTRAINTS — THE SIMPLEST MODULE IN THIS DIRECTORY

Alone among the shell tier's modules, this one uses NO ``ManifestTestCase``
harness: no ``KUBE_HOME`` layout, no ``kube-env``, no rendered template and no
pod manifest, because the oracle needs none of them. It reaches ``bash`` through
the ``bash_invoke`` fixture and nothing else, and it creates its file with
``tmp_path``.

It needs no etcd, no API server and no network, so it runs under
``pytest -m "not integration"``. It writes nothing under ``cluster/``: the
shipped script is sourced read-only and the only file written is inside
``tmp_path``. And it holds no shared mutable state — the case table is a tuple
of frozen records and every case gets a fresh directory — which is what makes it
honest under ``pytest-randomly`` and safe under ``pytest-xdist -n auto``, the
substitutes this tier has for Go's ``-race`` (AAP §0.7.2).

ON THE CREDENTIAL-SHAPED LITERAL IN THE TABLE

``'"$argon2id$v=19"'`` is a fixture token transcribed verbatim from the Go
source, where it exists to exercise quoting, ``$`` expansion and ``=`` in one
value. It is an argon2 parameter *header* with no hash, no salt and no secret,
it authenticates nothing, and it is not a credential. No real key material
appears in this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pytest

if TYPE_CHECKING:
    from collections.abc import Sequence

    from tests.unit.shell.conftest import BashInvoker

pytestmark = pytest.mark.shell


# ---------------------------------------------------------------------------
# What is under test, named exactly as the repository names it
# ---------------------------------------------------------------------------

#: The shell function under test, spelled as
#: ``cluster/gce/gci/configure-helper.sh:645`` declares it. Passed to bash as a
#: bare command word, so ``tests.helpers.bash`` validates its shape before it is
#: ever appended to a script.
_SHELL_FUNCTION: Final[str] = "append_or_replace_prefixed_line"

#: The Go identity this module reproduces, and the package whose 648-verdict
#: baseline it contributes ten of. Quoted in every failure message and in the
#: ``requirement`` field of the invocation, so a CI failure names the parity
#: contract that broke rather than only the values that differed
#: (AAP §0.7.2, "failure legibility"). This function is a behavioural-parity
#: guardian rather than the verification artifact of a numbered requirement
#: (AAP §0.3.1.4), so the contract identifier IS the Go identity.
_GO_PACKAGE: Final[str] = "k8s.io/kubernetes/cluster/gce/gci"
_GO_TEST: Final[str] = "TestAppendOrReplacePrefix"
_PARITY_CONTRACT: Final[str] = f"{_GO_PACKAGE}.{_GO_TEST}"

#: Name of the file each case operates on, inside that case's own ``tmp_path``.
#: The oracle uses ``os.CreateTemp("", "append_or_replace_test")``, whose random
#: suffix buys isolation; here the DIRECTORY is already unique per test, so a
#: fixed name is both isolated and legible when a failure leaves it behind for
#: inspection. The prefix is kept for continuity with the oracle.
_TARGET_FILE_NAME: Final[str] = "append_or_replace_test"

# ---------------------------------------------------------------------------
# The two argument pairs, transcribed from the oracle's table
# ---------------------------------------------------------------------------

#: Pair A — the plain case. Nothing in either value is special to bash, so these
#: reach the function unchanged.
_SIMPLE_PREFIX: Final[str] = "hello"
_SIMPLE_SUFFIX: Final[str] = "world"

#: Pair B — the quoting case, and the one value in this module that must not be
#: "tidied". The SINGLE QUOTES ARE PART OF THE VALUE, exactly as the Go raw
#: string ``'"$argon2id$v=19"'`` writes them: bash strips them, so the function
#: receives ``"$argon2id$v=19"`` and the file ends up holding
#: ``"$argon2id$v=19"admin``. Adding a layer of quoting here changes the file
#: contents without changing the exit status — see the module docstring.
_QUOTED_PREFIX: Final[str] = "'\"$argon2id$v=19\"'"
_QUOTED_SUFFIX: Final[str] = "admin"


# ---------------------------------------------------------------------------
# The case table
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _OracleCase:
    """One row of ``TestAppendOrReplacePrefix``'s table, plus its pinned node id.

    Frozen and slotted, so the table is immutable: no case can be edited by one
    test and observed by another, which is what keeps this module honest under
    ``pytest-randomly`` and safe under ``pytest-xdist``.

    The node id travels WITH the case rather than in a parallel list, so the two
    cannot drift out of alignment — a reordering or an insertion carries the id
    along with the values it names.

    Attributes:
        node_id: The pytest parametrize id, pinned as a literal because
            ``parity_map.py`` encodes it. Derived from ``desc`` by lowercasing
            and collapsing every run of non-alphanumeric characters to a single
            ``-``, but written out rather than computed, so rewording ``desc``
            cannot silently rename it.
        desc: The oracle's ``desc`` field, verbatim. Carried so a failure names
            the Go subtest it corresponds to.
        prefix: The prefix argument, EXACTLY as the oracle passes it to bash,
            including any quoting that is part of the value.
        suffix: The suffix argument, likewise.
        initial: The bytes the target file holds before the call. The empty
            string is a real value, not "no setup": the oracle's
            ``os.CreateTemp`` always creates the file, so an empty file must be
            created too.
        want: The complete expected contents afterwards, compared with ``==``.
            Always newline-terminated, because ``echo`` terminates the appended
            line.
    """

    node_id: str
    desc: str
    prefix: str
    suffix: str
    initial: str
    want: str


#: The ten oracle cases, in the oracle's own order: five scenarios against Pair
#: A (append_or_replace_prefixed_line_test.go L36-94) followed by the same five
#: against Pair B (L95-153).
#:
#: Machine-extracted from the Go table rather than retyped, then each case was
#: run against the shipped ``configure-helper.sh`` and its result compared with
#: ``want`` byte for byte — ten of ten matched (AAP §0.11.1, "evidence over
#: assumption"). The five "already contains" rows are what prove the REPLACE
#: half of the contract and must not be pruned as duplicates of the plain
#: append.
_ORACLE_CASES: Final[tuple[_OracleCase, ...]] = (
    _OracleCase(
        node_id="simple-string-and-empty-file",
        desc="simple string and empty file",
        prefix=_SIMPLE_PREFIX,
        suffix=_SIMPLE_SUFFIX,
        initial="",
        want="helloworld\n",
    ),
    _OracleCase(
        node_id="simple-string-and-non-empty-file",
        desc="simple string and non empty file",
        prefix=_SIMPLE_PREFIX,
        suffix=_SIMPLE_SUFFIX,
        initial="jelloworld\nchelloworld\n",
        want="jelloworld\nchelloworld\nhelloworld\n",
    ),
    _OracleCase(
        node_id="simple-string-and-file-already-contains-prefix",
        desc="simple string and file already contains prefix",
        prefix=_SIMPLE_PREFIX,
        suffix=_SIMPLE_SUFFIX,
        # BOTH matching lines are dropped and ONE canonical line is appended, so
        # the count falls from four lines to three. This is the case that proves
        # a rotated token cannot leave a stale duplicate behind.
        initial="helloworld\nhelloworld\njelloworld\nchelloworld\n",
        want="jelloworld\nchelloworld\nhelloworld\n",
    ),
    _OracleCase(
        node_id=(
            "simple-string-and-file-already-contains-prefix-with-content-"
            "between-the-prefix-and-suffix"
        ),
        desc=(
            "simple string and file already contains prefix with content "
            "between the prefix and suffix"
        ),
        prefix=_SIMPLE_PREFIX,
        suffix=_SIMPLE_SUFFIX,
        # "hellocontentsworld" matches on the prefix alone, so awk drops it and
        # the content between prefix and suffix is discarded with it.
        initial="hellocontentsworld\njelloworld\nchelloworld\n",
        want="jelloworld\nchelloworld\nhelloworld\n",
    ),
    _OracleCase(
        node_id="simple-string-and-file-already-contains-prefix-with-prefix-suffix",
        desc="simple string and file already contains prefix with prefix == suffix",
        prefix=_SIMPLE_PREFIX,
        suffix=_SIMPLE_SUFFIX,
        # "hellohello" is still just a prefix match, so it is dropped and
        # replaced by the canonical "helloworld".
        initial="hellohello\njelloworld\nchelloworld\n",
        want="jelloworld\nchelloworld\nhelloworld\n",
    ),
    _OracleCase(
        node_id="string-with-quotes-and-and-empty-file",
        desc="string with quotes and = and empty file",
        prefix=_QUOTED_PREFIX,
        suffix=_QUOTED_SUFFIX,
        initial="",
        # The single quotes of the prefix are gone: bash consumed them. Seeing
        # them here would mean the argument was over-quoted on the way in.
        want='"$argon2id$v=19"admin\n',
    ),
    _OracleCase(
        node_id="string-with-quotes-and-and-non-empty-file",
        desc="string with quotes and = and non empty file",
        prefix=_QUOTED_PREFIX,
        suffix=_QUOTED_SUFFIX,
        initial="jelloworld\nchelloworld\n",
        want='jelloworld\nchelloworld\n"$argon2id$v=19"admin\n',
    ),
    _OracleCase(
        node_id="string-with-quotes-and-and-file-already-contains-prefix",
        desc="string with quotes and = and file already contains prefix",
        prefix=_QUOTED_PREFIX,
        suffix=_QUOTED_SUFFIX,
        # Both matching lines are dropped and ONE canonical line is appended, so
        # a rotated token cannot leave a stale duplicate behind — the Pair B
        # counterpart of case 3, and the shape known_tokens_csv relies on.
        initial='"$argon2id$v=19"admin\n"$argon2id$v=19"admin\nhelloworld\njelloworld\n',
        want='helloworld\njelloworld\n"$argon2id$v=19"admin\n',
    ),
    _OracleCase(
        node_id=(
            "string-with-quotes-and-and-file-already-contains-prefix-with-"
            "content-between-the-prefix-and-suffix"
        ),
        desc=(
            "string with quotes and = and file already contains prefix with "
            "content between the prefix and suffix"
        ),
        prefix=_QUOTED_PREFIX,
        suffix=_QUOTED_SUFFIX,
        initial='"$argon2id$v=19"contentsadmin\nhelloworld\njelloworld\n',
        want='helloworld\njelloworld\n"$argon2id$v=19"admin\n',
    ),
    _OracleCase(
        node_id="string-with-quotes-and-and-file-already-contains-prefix-with-prefix-suffix",
        desc="string with quotes and = and file already contains prefix with prefix == suffix",
        prefix=_QUOTED_PREFIX,
        suffix=_QUOTED_SUFFIX,
        initial='"$argon2id$v=19""$argon2id$v=19"\nhelloworld\njelloworld\n',
        want='helloworld\njelloworld\n"$argon2id$v=19"admin\n',
    ),
)


def _pinned_node_ids(cases: Sequence[_OracleCase]) -> list[str]:
    """Return the cases' pinned node ids, refusing a duplicate.

    Evaluated once, while this module is imported, so a corrupted table is a
    collection error rather than a confusing verdict. The check earns its place:
    given two identical ids pytest silently disambiguates them by appending an
    index, which would leave ``parity_map.py`` pointing at a node id that no
    longer exists while the suite still reported ten passes.

    A list rather than a tuple because that is what ``parametrize`` expects for
    ``ids``.

    Raises:
        AssertionError: if any id appears more than once.
    """
    node_ids = [case.node_id for case in cases]
    duplicates = sorted({node_id for node_id in node_ids if node_ids.count(node_id) > 1})
    if duplicates:
        raise AssertionError(
            f"{_PARITY_CONTRACT}: duplicate parametrize id(s) {duplicates!r} in the "
            f"oracle case table. pytest would disambiguate them by appending an "
            f"index, silently renaming a node id that python/tests/parity/"
            f"parity_map.py pins. Give each case a distinct id derived from its "
            f"own desc."
        )
    return node_ids


#: The ten cases as ten separately named parametrize cases.
#:
#: Values are a list because that is the shape this repository's lint
#: configuration expects (ruff's flake8-pytest-style rules are enabled in
#: python/pyproject.toml); ids come from the table itself, so they cannot fall
#: out of step with the values they name. pytest additionally refuses a mismatch
#: between the number of values and the number of ids, which is the second half
#: of the guard :func:`_pinned_node_ids` starts.
_OVER_ALL_ORACLE_CASES: Final[pytest.MarkDecorator] = pytest.mark.parametrize(
    "case",
    list(_ORACLE_CASES),
    ids=_pinned_node_ids(_ORACLE_CASES),
)


# ---------------------------------------------------------------------------
# Setup, in the one place it can fail
# ---------------------------------------------------------------------------


def _write_target_file(directory: Path, initial: str) -> Path:
    """Create the target file holding ``initial`` inside ``directory``.

    PORTS: ``os.CreateTemp`` plus ``f.WriteString(tc.initialFileContents)`` and
    the two ``t.Fatalf`` calls that guard them
    (append_or_replace_prefixed_line_test.go L157-165). Both failures become an
    ``OSError``, which aborts the case exactly as ``t.Fatalf`` does — this is
    setup breakage, never a finding about the shipped script.

    The file is ALWAYS created, including when ``initial`` is empty. Two of the
    ten cases pass the empty string, and they are testing the function against an
    existing empty file rather than against a missing one; skipping the write
    would exercise the ``touch`` path instead and stop reproducing the oracle.

    ``directory`` must be writable, and per-case: the shipped function creates
    its scratch file with ``mktemp "${dirname}/filtered.XXXX"`` inside the target
    file's own directory before renaming it over the target.

    Args:
        directory: The case's own ``tmp_path``.
        initial: Bytes to place in the file, verbatim.

    Returns:
        Path to the created file.
    """
    __tracebackhide__ = True
    target = directory / _TARGET_FILE_NAME
    target.write_text(initial, encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# The test
# ---------------------------------------------------------------------------


@_OVER_ALL_ORACLE_CASES
def test_append_or_replace_prefix(
    bash_invoke: BashInvoker, tmp_path: Path, case: _OracleCase
) -> None:
    # INVARIANT LOCKED: the SHIPPED append_or_replace_prefixed_line leaves the
    # target file holding EXACTLY the bytes the Go oracle expects — every line
    # beginning with the prefix removed from wherever it sat, one canonical
    # "${prefix}${suffix}" line appended at the end, and the trailing newline
    # echo supplies. Ten cases, one verdict each, matching the oracle's ten
    # independent t.Run subtests one for one.
    target = _write_target_file(tmp_path, case.initial)

    # The SHIPPED bash runs; nothing here reimplements the awk filter.
    # bash_invoke supplies cwd = <repo>/cluster/gce/gci, which is what lets
    # `source "configure-helper.sh"` resolve by its bare relative name exactly as
    # it does under `go test`. The prefix and suffix are handed over RAW, because
    # Pair B's prefix carries quoting that bash must be the one to strip; the
    # script name and the target path travel as positional parameters instead, so
    # a tmp_path containing a shell metacharacter cannot be evaluated.
    result = bash_invoke.must_invoke_func_with_args(
        _SHELL_FUNCTION,
        [case.prefix, case.suffix],
        target_path=target,
        requirement=_PARITY_CONTRACT,
    )

    # PORTS: os.ReadFile plus its t.Fatalf — an OSError here aborts the case.
    got = target.read_text(encoding="utf-8")

    # PORTS: the oracle's single t.Errorf on cmp.Diff. Whole-string equality, so
    # the trailing newline is asserted along with everything else: no strip(), no
    # rstrip(), no line-list comparison. reprs on both sides because the only
    # difference in the failure this guards against may be a newline or a pair of
    # single quotes, neither of which is visible unquoted. The merged bash output
    # is included because the shipped script's own diagnostics are the first
    # thing worth reading when the contents are wrong.
    assert got == case.want, (
        f"{_PARITY_CONTRACT} VIOLATED for subtest {case.desc!r}: "
        f"{_SHELL_FUNCTION} left the file holding {got!r}, expected "
        f"{case.want!r}.\n"
        f"  prefix passed to bash (raw, unquoted): {case.prefix!r}\n"
        f"  suffix passed to bash (raw, unquoted): {case.suffix!r}\n"
        f"  initial contents: {case.initial!r}\n"
        f"  target file: {target}\n"
        f"  bash script: {result.script!r}\n"
        f"  bash output (stdout and stderr merged): {result.output!r}\n"
        f"Expected behaviour: every line beginning with the prefix is dropped, "
        f"then one '<prefix><suffix>' line is appended with a trailing newline "
        f"(cluster/gce/gci/configure-helper.sh:645). If the difference is a pair "
        f"of literal single quotes around the prefix, the argument was quoted on "
        f"the way in and must be passed raw."
    )
