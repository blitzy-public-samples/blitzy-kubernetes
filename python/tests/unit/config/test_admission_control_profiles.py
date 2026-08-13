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

"""Both GCE profiles must keep ``PodSecurity`` and ``NodeRestriction`` enabled.

AAP §0.4.2.3 / §0.5.1 / §0.10.2 (V2 + V7) — tech-spec §6.4.4.1 (admission
controller catalog), §6.4.4.3 (Pod Security modes).

Those are the sections the profiles under test cite themselves, which is why they
are the ones cited here. ``cluster/gce/config-default.sh:373`` reads ``# See
tech-spec §6.4.4.1 (admission controller catalog) and §6.4.4.3 (Pod Security
modes).`` and ``cluster/gce/config-test.sh:416-417`` reads ``# NodeRestriction
(AAP V7) + PodSecurity (AAP V2) must both be active on every profile — mirrors
config-default.sh.``

INVARIANTS LOCKED BY THIS MODULE

1. **F-002-RQ-002** — ``PodSecurity`` is in the effective ``ADMISSION_CONTROL``
   chain of *both* GCE profiles, so Pod Security admission is active wherever a
   cluster is brought up from this repository.
2. **F-007-RQ-001** — ``NodeRestriction`` is in the effective
   ``ADMISSION_CONTROL`` chain of *both* GCE profiles, so a kubelet is confined
   to its own node's objects wherever a cluster is brought up.
3. **The parse is non-vacuous.** A test that silently matches nothing reports
   "passed", and a security gate that passes while asserting nothing is worse
   than no gate at all. See THE TRAP below: this is not a hypothetical.

WHY BOTH PROFILES, EVERY TIME — THE FAILURE MODE BEING GUARDED

The two cases are parametrized rather than folded into one assertion because the
failure this module exists to catch is a **ONE-SIDED EDIT**: hardening
``config-default.sh`` while leaving ``config-test.sh`` weak (or the reverse)
leaves the test profile insecure while the default profile stays green. That is
exactly the shape AAP §0.10.2 records under "Profile defaults". Consequently the
requirement is never relaxed to "present on at least one profile" — each profile
is its own named node id, so a one-sided edit fails visibly and *names the
offending profile in the failure*.

THE TRAP — WHY THE PARSER LOOKS OVER-BUILT FOR A "GREP FOR A VARIABLE"

Measured, not assumed (AAP §0.11.1 "evidence over assumption"). The same
variable is assigned in three different shapes across the two files:

    config-default.sh:374   ADMISSION_CONTROL=NamespaceLifecycle,...,PodSecurity
                            ...at column 0 and UNQUOTED
    config-default.sh:379   ADMISSION_CONTROL="${ADMISSION_CONTROL},Mutating..."
    config-default.sh:382   ADMISSION_CONTROL="${ADMISSION_CONTROL},ResourceQuota"
    config-test.sh:418        ADMISSION_CONTROL='NamespaceLifecycle,...,PodSecurity'
                            ...INDENTED TWO SPACES and SINGLE-QUOTED
    config-test.sh:420        ADMISSION_CONTROL="${ADMISSION_CONTROL},...,ResourceQuota"
    config-test.sh:422        ADMISSION_CONTROL=${KUBE_ADMISSION_CONTROL}

A ``^ADMISSION_CONTROL=`` pattern — the obvious first attempt — matches three
lines in ``config-default.sh`` and **zero lines in** ``config-test.sh``, because
every assignment there sits inside an ``if`` block and is therefore indented.
Measured: 3 and 0. Without the vacuity guard in
:func:`_load_admission_control`, that regression would not fail the suite; it
would silently reduce half of this gate to an empty list and report success. The
guard is mandatory, not defensive decoration.

The line numbers above are provenance only. They are recorded in comments and
are deliberately never asserted on: line numbers drift with unrelated edits, and
a test that pins them would fail for reasons that have nothing to do with either
requirement.

TIER CONSTRAINTS — THIS IS THE PURE L3 CONFIG TIER

No subprocess, no ``bash``, no shell evaluation, no network, no etcd, no API
server, no writes, and no I/O at import time. The two profiles are **read-only
committed inputs**: they are parsed and asserted upon, never edited, and never
reimplemented in Python — they are Bash by design, and rewriting them would be a
behaviour change rather than a test (AAP §0.8.2). Real Bash is invoked by the
shell-boundary tier under ``python/tests/unit/shell/``; this is not that tier,
which is why nothing here imports :mod:`subprocess`.

ON THE DUPLICATED PARSER

``test_audit_and_etcd_profile_defaults.py`` parses the same two profiles and
needs the same assignment semantics. That duplication is deliberate and
scope-bounded: the AAP declares no shared shell-profile-parsing helper — the
eight ``tests.helpers.*`` modules are ``bash``, ``manifest``, ``polling``,
``apierrors``, ``audit_log``, ``warnings``, ``etcd_raw`` and ``jwtclaims``, none
of which parses shell variables — and this directory is fixed at six test
modules with no ``conftest.py`` and no ``__init__.py``. The parser below is
therefore module-private by design; it is specified precisely enough
(:func:`_shell_assignments`) that both modules behave identically without
sharing code.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pytest

pytestmark = pytest.mark.config


# ---------------------------------------------------------------------------
# What is under test, named exactly as the repository names it
# ---------------------------------------------------------------------------

#: The shell variable holding the kube-apiserver admission chain in both GCE
#: profiles. ``cluster/gce/util.sh:1161`` renders it into the master environment
#: as ``ADMISSION_CONTROL: $(yaml-quote "${ADMISSION_CONTROL:-}")``, and
#: ``cluster/gce/gci/configure-kubeapiserver.sh:260-261`` then turns that into the
#: API server's own flag: ``params+=" --enable-admission-plugins=${ADMISSION_CONTROL}"``.
#: That two-hop path is why this variable is worth a gate — a plugin missing from
#: it is a plugin the API server is never told to enable.
_ADMISSION_CONTROL: Final[str] = "ADMISSION_CONTROL"

#: The operator opt-out. ``config-test.sh:415`` guards the shipped defaults with
#: ``if [[ -z "${KUBE_ADMISSION_CONTROL:-}" ]]; then``, and its ``else`` arm at
#: L422 assigns ``ADMISSION_CONTROL=${KUBE_ADMISSION_CONTROL}`` verbatim. That
#: arm is taken ONLY when an operator supplies their own list, so it is not the
#: shipped default and is excluded from the effective chain below. Its presence
#: is correct behaviour and must never be reported as a defect.
_OPERATOR_OVERRIDE: Final[str] = "KUBE_ADMISSION_CONTROL"

#: ``<repo_root>/cluster/gce`` — where both profiles live.
_PROFILE_DIR: Final[tuple[str, str]] = ("cluster", "gce")

#: The plugin each requirement demands, paired with the requirement it locks, so
#: a failure reads as a requirement violation rather than a value mismatch
#: (AAP §0.7.2, "failure legibility"). Both names are the exact
#: ``const PluginName`` of the plugin that implements them:
#: ``plugin/pkg/admission/security/podsecurity/admission.go:59`` and
#: ``plugin/pkg/admission/noderestriction/admission.go:59``. Kubernetes plugin
#: names are case-sensitive, so these strings are compared exactly.
_REQUIRED_PLUGINS: Final[tuple[tuple[str, str], ...]] = (
    ("PodSecurity", "F-002-RQ-002"),
    ("NodeRestriction", "F-007-RQ-001"),
)

#: Vacuity floor for the resolved chain. Both profiles declare 11 plugins in
#: their base assignment and reach 14 once the appends are applied (measured),
#: so a floor of 5 is far below the real value and cannot fail on an ordinary
#: edit, while still catching a parser regression that resolves to a stub list.
#: It is deliberately NOT an equality check: asserting the exact count would
#: turn every legitimate addition to the chain into a failure of this module.
_MIN_PLUGIN_COUNT: Final[int] = 5

#: A line whose first non-whitespace character is ``#``. Such a line is a comment
#: and never an assignment — which matters here because both profiles carry
#: comments that *mention* the variable and the plugins immediately above the
#: real assignment (``config-default.sh:370-373``, ``config-test.sh:416-417``).
_COMMENT_LINE_RE: Final[re.Pattern[str]] = re.compile(r"^[ \t]*#")

#: A trailing comment on an UNQUOTED right-hand side. ``#`` only begins a comment
#: when it follows whitespace, so ``VAR=#literal`` keeps its value — and a ``#``
#: inside quotes is never reached, because a quoted value is unwrapped first.
_TRAILING_COMMENT_RE: Final[re.Pattern[str]] = re.compile(r"[ \t]+#.*$")

#: The two quoting forms a value may carry. Bare values are the third form.
_QUOTES: Final[tuple[str, str]] = ('"', "'")


@dataclass(frozen=True)
class _AdmissionControl:
    """One profile's ``ADMISSION_CONTROL``, parsed and resolved.

    Frozen, and holding tuples rather than lists, so a parsed profile cannot be
    mutated by one test and observed by another. That is what keeps this module
    safe under ``pytest-randomly`` and ``pytest-xdist`` (AAP §0.7.2).
    """

    #: Every right-hand side found, in file order, already unquoted.
    assignments: tuple[str, ...]

    #: How many of those were *base* assignments — ones that do not reference
    #: the variable being assigned. Zero means the parser found only appends,
    #: which cannot yield a trustworthy chain.
    base_count: int

    #: The resolved chain: appends applied in file order, split on commas.
    plugins: tuple[str, ...]


# ---------------------------------------------------------------------------
# The parser. A targeted regex plus quote stripping - never shell evaluation
# ---------------------------------------------------------------------------


def _expansion_pattern(name: str) -> str:
    """Return a regex matching every reference to shell variable ``name``.

    Covers ``${NAME}``, the default-expansion forms ``${NAME:-x}``,
    ``${NAME:=x}``, ``${NAME:?x}`` and ``${NAME:+x}``, and the brace-less
    ``$NAME``. The negative lookahead is load-bearing: without it ``$NAME`` would
    also match inside ``$NAME_SUFFIX``.

    Detection and substitution share this one definition on purpose. If they
    could disagree, a reference could be classified as an append and then not be
    substituted, leaving a literal ``${ADMISSION_CONTROL}`` token sitting in the
    resolved plugin list — a silent corruption that no assertion here would name.
    """
    escaped = re.escape(name)
    braced = r"\$\{" + escaped + r"(?::[-=?+][^}]*)?\}"
    bare = r"\$" + escaped + r"(?![0-9A-Za-z_])"
    return f"{braced}|{bare}"


def _references(text: str, name: str) -> bool:
    """Whether ``text`` expands shell variable ``name``."""
    return re.search(_expansion_pattern(name), text) is not None


def _expand(text: str, name: str, value: str) -> str:
    """Substitute ``value`` for every reference to ``name`` in ``text``.

    The replacement is supplied as a callable so that a value containing a
    backslash or a ``\\g`` sequence is inserted literally instead of being
    interpreted as a regex template.
    """
    return re.sub(_expansion_pattern(name), lambda _match: value, text)


def _unwrap_value(raw: str) -> str:
    """Strip one layer of shell quoting from an assignment's right-hand side.

    Handles the three forms both profiles actually use: double-quoted,
    single-quoted, and bare. Exactly one matching outer quote pair is removed and
    the inner content is left untouched; anything after the closing quote (a
    trailing comment, for instance) is discarded, as the shell would.

    A bare value has any trailing comment removed and is then stripped of
    surrounding whitespace. An unterminated quote yields the remainder of the
    line, which is what makes the malformed input visible to the vacuity guard
    rather than silently plausible.
    """
    if raw[:1] in _QUOTES:
        quote = raw[0]
        closing = raw.find(quote, 1)
        return raw[1:closing] if closing != -1 else raw[1:]
    return _TRAILING_COMMENT_RE.sub("", raw).strip()


def _shell_assignments(text: str, name: str) -> tuple[str, ...]:
    """Every value assigned to shell variable ``name`` in ``text``, in file order.

    The specification this satisfies, point by point:

    * **Leading indentation is tolerated** (``^[ \\t]*``). This is the single
      thing that makes ``config-test.sh``'s indented assignments visible at all;
      see THE TRAP in the module docstring.
    * ``export NAME=...`` is accepted, since it is an assignment too.
    * **No whitespace is allowed around the ``=``**, because the shell allows
      none: ``NAME = value`` is a command invocation, not an assignment.
    * **The name is anchored**, so ``KUBE_ADMISSION_CONTROL=`` can never be read
      as an ``ADMISSION_CONTROL`` assignment even though it contains it as a
      substring — and neither can ``config-test.sh:415``'s ``if [[ -z ... ]]``
      guard, which mentions the variable inside a test expression.
    * **Comment lines are skipped** before matching.

    Deliberately NOT done: no ``shlex.split`` of the line, no ``bash``, no
    ``subprocess``, and no attempt to evaluate the script. A targeted regex plus
    quote stripping is auditable and side-effect free; evaluating the shell would
    breach the pure-tier constraint and could execute arbitrary logic from a file
    this module is only supposed to read.

    Values spanning multiple lines via a ``\\`` continuation are not joined.
    Neither profile uses one for this variable (measured), and a future one would
    truncate the value — which the vacuity guard's floor is there to catch rather
    than absorb.
    """
    pattern = re.compile(r"^[ \t]*(?:export[ \t]+)?" + re.escape(name) + r"=(?P<value>.*)$")
    values: list[str] = []
    for line in text.splitlines():
        if _COMMENT_LINE_RE.match(line):
            continue
        match = pattern.match(line)
        if match is not None:
            values.append(_unwrap_value(match.group("value")))
    return tuple(values)


def _resolve_effective_value(
    assignments: tuple[str, ...], name: str, override: str
) -> tuple[str, int]:
    """Fold ``assignments`` into the shipped default value, and count the bases.

    Each assignment is classified and handled in file order, exactly as the shell
    would execute them:

    * **Override** — references ``override``. This is ``config-test.sh:422``'s
      ``ADMISSION_CONTROL=${KUBE_ADMISSION_CONTROL}``, the ``else`` arm of the
      ``KUBE_ADMISSION_CONTROL`` guard. It is the operator opt-out path, taken
      only when an operator supplies their own list, so it is **not the shipped
      default** and is skipped. Skipping it is the whole reason this function
      needs to know the override's name.
    * **Append** — references ``name`` itself, so the accumulated value is
      substituted in.
    * **Base** — references neither, so it replaces the accumulated value and is
      counted. A later base legitimately resets the chain, as the shell would.

    Returns the resolved value and the number of base assignments seen.
    """
    accumulated = ""
    base_count = 0
    for value in assignments:
        if _references(value, override):
            continue
        if _references(value, name):
            accumulated = _expand(value, name, accumulated)
        else:
            accumulated = value
            base_count += 1
    return accumulated, base_count


def _split_plugins(value: str) -> tuple[str, ...]:
    """Split a comma-separated admission chain into exact plugin names.

    Whitespace around a name is not part of it, and an empty element is not a
    plugin, so both are removed. Every surviving name is compared verbatim, which
    is what keeps ``PodSecurityPolicy`` from ever satisfying a ``PodSecurity``
    assertion.
    """
    candidates = (token.strip() for token in value.split(","))
    return tuple(token for token in candidates if token)


def _profile_path(repo_root: Path, profile_filename: str) -> Path:
    """Absolute path to a GCE profile, resolved from the ``repo_root`` fixture.

    Derived from the session-scoped fixture rather than from the process working
    directory or from ``__file__`` arithmetic, so the answer is the same whether
    pytest is invoked from ``python/`` by ``hack/make-rules/test-python.sh`` or
    from the repository root by a developer.
    """
    return repo_root.joinpath(*_PROFILE_DIR, profile_filename)


def _load_admission_control(profile_path: Path) -> _AdmissionControl:
    """Parse one profile's admission chain, aborting if the parse is untrustworthy.

    THE VACUITY GUARD. Every assertion here is a bare ``assert`` — the analogue
    of Go's ``t.Fatalf`` — because each one reports *setup breakage* rather than a
    security finding, and continuing past it would produce a verdict that means
    nothing. A membership assertion against an empty list passes, so without
    these four checks a parser regression would turn this gate into a no-op and
    report success while asserting nothing at all.

    The four conditions, in the order a failure would occur:

    1. the profile exists and is a file;
    2. it has content;
    3. at least one ``ADMISSION_CONTROL`` assignment was found — the check that
       catches THE TRAP;
    4. at least one of those was a *base* assignment, and the resolved chain is
       plausibly long.
    """
    __tracebackhide__ = True

    assert profile_path.is_file(), (
        f"GCE profile {profile_path} is missing or is not a file. "
        "F-002-RQ-002 and F-007-RQ-001 are asserted against the committed "
        "profiles, so neither requirement can be evaluated without it."
    )

    text = profile_path.read_text(encoding="utf-8")
    assert text.strip(), (
        f"GCE profile {profile_path} is empty. Both F-002-RQ-002 and "
        "F-007-RQ-001 would vacuously 'pass' against no content."
    )

    assignments = _shell_assignments(text, _ADMISSION_CONTROL)
    assert assignments, (
        f"no {_ADMISSION_CONTROL} assignment found in {profile_path}. This is a "
        "PARSER regression, not a profile change: the assignments in "
        "config-test.sh are indented inside an 'if' block and single-quoted, so "
        "a '^ADMISSION_CONTROL=' pattern matches none of them. Refusing to "
        "report a pass, because membership assertions against an empty chain "
        "would succeed and this gate would silently assert nothing."
    )

    effective, base_count = _resolve_effective_value(
        assignments, _ADMISSION_CONTROL, _OPERATOR_OVERRIDE
    )
    assert base_count >= 1, (
        f"only append or override assignments to {_ADMISSION_CONTROL} were found "
        f"in {profile_path} ({len(assignments)} in total, 0 of them a base "
        "assignment). The shipped default chain cannot be reconstructed from "
        "appends alone, so no verdict on F-002-RQ-002 or F-007-RQ-001 is possible."
    )

    plugins = _split_plugins(effective)
    assert len(plugins) >= _MIN_PLUGIN_COUNT, (
        f"{_ADMISSION_CONTROL} in {profile_path} resolved to only "
        f"{len(plugins)} plugin(s) ({plugins!r}), below the sanity floor of "
        f"{_MIN_PLUGIN_COUNT}. Both profiles ship 14. A chain this short means "
        "the parse is wrong, so a membership result would be meaningless."
    )

    return _AdmissionControl(
        assignments=assignments, base_count=base_count, plugins=plugins
    )


# ---------------------------------------------------------------------------
# The tests
# ---------------------------------------------------------------------------

#: Both GCE profiles, as two separately named cases.
#:
#: Single source of truth for these node ids. ``python/tests/parity/parity_map.py``
#: is hand-maintained and pins node ids (AAP §0.5.5), so the ids are explicit
#: rather than derived from the filenames: renaming a file must not silently
#: rename a node id, and every test in this module must expose the same two ids.
_OVER_BOTH_PROFILES: Final[pytest.MarkDecorator] = pytest.mark.parametrize(
    "profile_filename",
    ["config-default.sh", "config-test.sh"],
    ids=["config-default", "config-test"],
)


@_OVER_BOTH_PROFILES
def test_profile_admission_control_is_parseable(
    repo_root: Path, profile_filename: str
) -> None:
    # INVARIANT: this module's own parse of the profile is non-vacuous, so the
    # membership verdicts below are trustworthy. Promoted to a named test of its
    # own - rather than left as a precondition of the membership test - so that a
    # parser regression is reported as a parser regression instead of surfacing
    # as a confusing "plugin missing" failure against a profile that in fact
    # still lists it.
    parsed = _load_admission_control(_profile_path(repo_root, profile_filename))

    # Both profiles reach their chain as one base assignment plus appends, so a
    # trustworthy parse finds strictly more assignments than bases. Asserted as a
    # relationship rather than as the measured 3-and-1, so that adding or
    # removing an append is not a failure of this module.
    assert len(parsed.assignments) >= parsed.base_count >= 1, (
        f"{profile_filename}: expected at least one base {_ADMISSION_CONTROL} "
        f"assignment among {len(parsed.assignments)} total, got "
        f"{parsed.base_count}."
    )


@_OVER_BOTH_PROFILES
def test_profile_enables_pod_security_and_node_restriction(
    repo_root: Path, profile_filename: str, subtests: pytest.Subtests
) -> None:
    # INVARIANT LOCKED: F-002-RQ-002 (PodSecurity) and F-007-RQ-001
    # (NodeRestriction) are BOTH present in the effective ADMISSION_CONTROL chain
    # of THIS profile. Parametrized over both profiles, so hardening one while
    # leaving the other weak - the one-sided edit of AAP §0.10.2 - fails, and
    # fails naming the profile at fault.
    parsed = _load_admission_control(_profile_path(repo_root, profile_filename))

    # The two plugins are independent findings, so they accumulate: a profile
    # missing both must report both in a single run rather than hiding the second
    # behind the first. This is the pytest analogue of Go's `t.Errorf`, and the
    # deliberate counterpart to the aborting `t.Fatalf`-style asserts that guard
    # the parse in _load_admission_control (AAP §0.4.1.2).
    for plugin, requirement in _REQUIRED_PLUGINS:
        with subtests.test(msg="admission-plugin-enabled", plugin=plugin):
            # Exact membership of a tuple of names, never a substring search over
            # the joined chain: `"PodSecurity" in ("PodSecurityPolicy",)` is
            # False, and it must stay False. Kubernetes plugin names are
            # case-sensitive, and a substring match would let an unrelated plugin
            # whose name merely starts with the same characters satisfy a
            # security requirement.
            assert plugin in parsed.plugins, (
                f"{requirement} VIOLATED: admission plugin {plugin!r} is not "
                f"enabled in {profile_filename}. Resolved "
                f"{_ADMISSION_CONTROL} chain: {list(parsed.plugins)!r}. Both "
                "GCE profiles must enable PodSecurity (F-002-RQ-002) and "
                "NodeRestriction (F-007-RQ-001); a profile that drops one is "
                "the one-sided edit this module exists to catch."
            )
