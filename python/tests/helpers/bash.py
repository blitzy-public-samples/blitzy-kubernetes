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

"""Subprocess invoker for the SHIPPED bash generators: the port of ``mustInvokeFunc``.

This module is the single boundary at which the Python test tier meets the real
hardening scripts, ``cluster/gce/gci/configure-helper.sh`` (3,765 lines) and
``cluster/gce/gci/configure-kubeapiserver.sh`` (520 lines). It runs them through
``bash`` exactly as the Go harness does. It re-implements none of them, and it
must never begin to: the whole value of the shell tier is that it proves the
generator this repository actually ships, not a Python paraphrase of it that can
drift while both halves keep passing. A behaviour that is awkward to reach is
reached by invoking more faithfully, never by reproducing the logic here.

THREE POSTURES, DELIBERATELY DISTINCT

Go's harness carries two failure postures, and the ported V8 tier needs a third
call shape. Collapsing any of them into another destroys a distinction that a
real test depends on, so each is its own documented entry point:

``must_invoke_func``          MODE ONE, the L1 shell-boundary posture. Ports
                              ``mustInvokeFunc``: builds the ``source`` chain,
                              MERGES stdout and stderr the way Go's
                              ``CombinedOutput`` does, and RAISES on a non-zero
                              exit the way ``t.Fatalf`` aborts. The majority of
                              call sites, and the one that must fail loudly.
``try_invoke_func``           MODE TWO, the L4 fail-closed posture. Same script,
                              but stdout and stderr stay SEPARATE and a non-zero
                              exit is DATA, returned rather than raised. The V8
                              fail-closed scenarios assert ``returncode == 1``
                              AND that a specific refusal message was emitted;
                              neither assertion can be written against a helper
                              that raises or that merges the streams.
``must_invoke_func_with_args`` MODE THREE, the raw positional posture. Sources
                              ``configure-helper.sh`` relative and unquoted and
                              passes positional arguments through UNQUOTED, as
                              ``append_or_replace_prefixed_line_test.go`` does.

``run_bash`` underlies all three and is public for the same reason: a call site
that needs an ad-hoc script still gets the timeout, the environment copy and the
decoding rules for free. Its defaults are the LOUD ones -- ``check=True`` and
``merge_streams=True``, i.e. ``CombinedOutput`` plus ``t.Fatalf``. The tolerant
posture has to be asked for by name, so that a reader can tell which posture a
call site chose by reading the call and nothing else.

WHY A NON-ZERO EXIT RAISES ``BashInvocationError``, WHICH IS AN ``AssertionError``

Go distinguishes ``t.Fatalf`` (abort this test now) from ``t.Errorf`` (record the
finding and carry on), and the ported suite needs both: a broken positive control
must abort, while a security enumeration must report every offender in one run.
``BashInvocationError`` subclasses ``AssertionError`` so that one raise serves
both. Unwrapped, it aborts the test like ``t.Fatalf``. Wrapped in
``with subtests.test(...)``, pytest's subtests fixture catches it, reports that
one case and lets the loop continue -- ``t.Errorf`` semantics, from the same
call. A bespoke exception hierarchy would have broken the second half.

ISOLATION AND DETERMINISM ARE EXPLICIT HERE, NOT INHERITED

Go runs its unit tier under ``-race`` and detects leaked goroutines with goleak.
Python has neither, so the equivalent guarantees are written out by hand:

* Every invocation is bounded by a timeout, defaulting to
  ``DEFAULT_TIMEOUT_SECONDS`` and overridable per call, so a hung ``bash``
  becomes a legible failure naming the script rather than a wedged session.
* ``os.environ`` is never mutated. Overrides are merged over a fresh copy, which
  is what makes a scenario that varies ``ETCD_APISERVER_ALLOW_INSECURE`` safe
  under ``pytest-xdist`` workers and ``pytest-randomly`` ordering.
* The working directory is always supplied by the caller, never derived from the
  process CWD, so a run does not depend on where it was started.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

It computes no repository root. ``python/tests/conftest.py`` owns the
``repo_root`` fixture and ``python/tests/unit/shell/conftest.py`` derives the
package directory from it and passes it in as ``cwd``. A helper that guessed its
own root would silently disagree with the fixture that everything else uses.

It declares no fixture -- ``bash_invoke`` lives in the shell tier's conftest.py,
because a module-, package- or session-scoped autouse fixture declared inline in
an ordinary module can execute twice under ``--doctest-modules``.

It declares no test, so it contributes nothing to collection.

It imports nothing but the standard library, which is what keeps the shell tier
runnable with a bash interpreter and no other pin installed.
"""

# AAP §0.5.1 (the python/tests/helpers/bash.py row: "Subprocess bash invoker
# capturing stdout, stderr, return code", source cluster/gce/gci/
# configure_helper_test.go mustInvokeFunc) / §0.4.2.1 (the L1 shell-boundary
# blueprints and the L4 fail-closed blueprint that needs the exit code and
# stderr as data) / §0.3.2 ("run for real -- never mocked": the bash hardening
# scripts are invoked through subprocess.run(["bash", "-c", ...]) exactly as
# ManifestTestCase.mustInvokeFunc does today) / tech-spec §6.6.1.1, which
# records the property this module exists to preserve: the test "proves the
# shipped shell generator, not a re-implementation".
#
# INVARIANT LOCKED BY THIS FILE: the shipped bash is executed, never
# reproduced; the two Go failure postures both survive the language change
# (merged-and-abort for L1, separated-and-tolerated for L4); positional
# arguments reach bash EXACTLY as written, unquoted; and no invocation can hang
# without bound, orphan a child or leak an environment variable into the parent.

import contextlib
import os
import re
import shlex
import signal
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

__all__ = [
    "ALLOWED_RAW_ARGUMENT_TOKENS",
    "CONFIGURE_HELPER_SCRIPT",
    "DEFAULT_TIMEOUT_SECONDS",
    "BashInvocationError",
    "BashResult",
    "must_invoke_func",
    "must_invoke_func_with_args",
    "run_bash",
    "shell_quote",
    "try_invoke_func",
]

# The interpreter, and it is bash rather than sh on purpose. The hardening
# scripts use `local -r`, `[[ ]]`, arrays and `${x:-}` throughout, all of which
# are bashisms; running them under a POSIX shell would fail for reasons that
# have nothing to do with the control under test. Kept private so that it is
# documentation rather than a knob: a caller must not be able to substitute a
# different shell and still claim the shipped generator was proven.
_BASH_EXECUTABLE: Final[str] = "bash"

# The one script MODE THREE sources, matching the literal in
# append_or_replace_prefixed_line_test.go:166. Relative on purpose: it resolves
# against the caller's `cwd`, which is the package directory, exactly as it does
# for `go test`.
CONFIGURE_HELPER_SCRIPT: Final[str] = "configure-helper.sh"

# Per-invocation wall-clock bound, in seconds.
#
# Chosen to sit well inside the tier's own bound rather than near it:
# python/pyproject.toml sets pytest-timeout's `timeout = 300`, which bounds a
# whole TEST, and the heaviest shell invocation in the ported surface is
# `start-kube-apiserver` sourcing a 3,765-line script -- measured in
# milliseconds, since the Go package completes all 648 of its cases in about
# 0.8s. A bound this far below 300 guarantees the SUBPROCESS timeout fires
# first, and that matters because this one names the script that hung while the
# session-level backstop can only report that the test did.
#
# Raise it for one slow call with the per-call `timeout` argument. Do not raise
# this default to accommodate a single caller: that would blind every other one.
DEFAULT_TIMEOUT_SECONDS: Final[float] = 60.0


class BashInvocationError(AssertionError):
    """A bash invocation failed, timed out, or was asked for incorrectly.

    Subclasses ``AssertionError`` deliberately, so that a single raise carries
    both of Go's failure postures depending on how the caller wrote the call:

    * unwrapped, it aborts the test, which is ``t.Fatalf``;
    * inside ``with subtests.test(...)``, pytest's subtests fixture catches it,
      reports that one case and lets the loop continue, which is ``t.Errorf``.

    Raised for a non-zero exit only when the caller asked to be checked. The V8
    fail-closed scenarios need a non-zero exit as data and use
    :func:`try_invoke_func`, which never raises for that reason.
    """


@dataclass(frozen=True)
class BashResult:
    """What one bash invocation produced. Frozen: a recorded result, not a buffer.

    Attributes:
        returncode: The exit status of ``bash``. ``0`` on success. The V8
            fail-closed scenarios assert this is exactly ``1``.
        stdout: Decoded standard output. When ``streams_merged`` is true this
            holds stdout AND stderr interleaved, because that is what Go's
            ``CombinedOutput`` returns.
        stderr: Decoded standard error, and ALWAYS the empty string when
            ``streams_merged`` is true -- there is no second stream to report,
            since bash wrote both into one pipe. Read ``streams_merged`` before
            concluding anything from an empty ``stderr``; a caller that needs
            the two apart must use :func:`try_invoke_func` or pass
            ``merge_streams=False``.
        script: The exact string handed to ``bash -c``. Carried so that a
            failure message can reproduce the invocation verbatim, and so that
            a test can assert on the shape of the script it built.
        streams_merged: Whether stderr was redirected into stdout.
    """

    returncode: int
    stdout: str
    stderr: str
    script: str
    streams_merged: bool

    @property
    def output(self) -> str:
        """Everything the script wrote, in one string, for use in a message.

        With merged streams this is simply ``stdout``. With separated streams it
        is ``stdout`` followed by ``stderr``, each newline-terminated so the two
        never run together on one line and an empty stream contributes nothing.
        """
        chunks: list[str] = []
        for chunk in (self.stdout, self.stderr):
            if not chunk:
                continue
            chunks.append(chunk if chunk.endswith("\n") else chunk + "\n")
        return "".join(chunks)


def _indent(text: str) -> str:
    """Indent captured output by four spaces so it cannot be mistaken for a field."""
    if not text:
        return "    <no output>"
    return "\n".join(f"    {line}" for line in text.rstrip("\n").split("\n"))


def _render_context(
    script: str,
    cwd: str | os.PathLike[str],
    requirement: str | None,
    argv: Sequence[str] = (),
) -> list[str]:
    """Build the common lines of a failure message: requirement, cwd, script.

    ``requirement`` is the identifier of the requirement the call site enforces,
    for example ``F-008-RQ-001`` for the V8 fail-closed path. Naming it makes a
    CI failure read as a requirement violation rather than a value mismatch,
    which matters most to the reader of a security failure who did not write the
    test.
    """
    lines: list[str] = []
    if requirement:
        lines.append(f"  requirement: {requirement}")
    lines.append(f"  cwd: {os.fspath(cwd)}")
    lines.append(f"  script: {script}")
    if argv:
        # Rendered with shlex.quote so a path containing a space or a quote is
        # unambiguous in the message. This is presentation only -- the values
        # reached bash as separate argv entries and were never quoted for it.
        lines.append("  positional arguments: " + " ".join(shlex.quote(item) for item in argv))
    return lines


def _render_failure(
    result: BashResult,
    cwd: str | os.PathLike[str],
    requirement: str | None,
    argv: Sequence[str] = (),
) -> str:
    """Render the message for a non-zero exit the caller asked to be checked.

    Mirrors what the Go harness prints on the same event -- ``t.Logf("%q", bs)``
    for the captured output, then ``t.Fatalf`` naming the command -- and adds the
    exit status, which Go leaves inside the wrapped ``*exec.ExitError``. The
    output is always included: a failure whose diagnostics were dropped costs a
    second run to reproduce.
    """
    lines = [f"bash invocation failed: exit status {result.returncode} (wanted 0)"]
    lines.extend(_render_context(result.script, cwd, requirement, argv))
    if result.streams_merged:
        lines.append("  combined output (stdout and stderr merged):")
        lines.append(_indent(result.stdout))
    else:
        lines.append("  stdout:")
        lines.append(_indent(result.stdout))
        lines.append("  stderr:")
        lines.append(_indent(result.stderr))
    return "\n".join(lines)


#: The exact set of shell function names in the ported surface.
#:
#: Every name a test may ask for is a shell function declared by one of the two
#: shipped hardening scripts, and every one matches this pattern: a leading
#: letter or underscore, then letters, digits, underscores and hyphens. The
#: measured names are ``create-master-audit-policy``, ``start-kube-apiserver``,
#: ``configure-etcd-params``, ``setup-etcd-encryption`` and
#: ``append_or_replace_prefixed_line``.
#:
#: The pattern is what makes the name safe to interpolate into the script string:
#: it admits no whitespace, no ``$``, no backtick, no quote, no ``;``, no ``&``
#: and no ``|``, so a name cannot terminate the command it is appended to and
#: start another. Validating is preferred to quoting here because Go appends the
#: name bare (``args += c.manifestFuncName``) and a quoted name would not be
#: expanded as a command word at all.
_FUNC_NAME_PATTERN: Final[re.Pattern[str]] = re.compile(r"\A[A-Za-z_][A-Za-z0-9_-]*\Z")

#: The ONLY argument tokens :func:`must_invoke_func_with_args` substitutes raw.
#:
#: MODE THREE exists because five of the ten cases of
#: ``append_or_replace_prefixed_line_test.go`` pass the prefix as the literal
#: eight characters ``'"$argon2id$v=19"'`` -- single quotes included -- and expect
#: bash to strip those quotes so the function receives ``"$argon2id$v=19"``.
#: Quoting the argument here would deliver the single quotes to the function and
#: change the file contents, so the substitution must stay raw.
#:
#: Raw substitution into a ``bash -c`` string is a command-injection seam, and it
#: is closed by ENUMERATION rather than by escaping: the seam accepts only the
#: four tokens the Go oracle actually passes. Anything else is refused, so a value
#: derived from a filename, an environment variable or a fixture parameter can
#: never reach it. Widening this set is a deliberate, reviewable act, and a new
#: entry must be a literal the Go oracle passes.
#:
#: Measured from ``append_or_replace_prefixed_line_test.go`` L28-146: the prefixes
#: are ``hello`` and ``'"$argon2id$v=19"'``, the suffixes are ``world`` and
#: ``admin``. The file path is NOT here -- it travels as a positional argument,
#: see :func:`must_invoke_func_with_args`.
ALLOWED_RAW_ARGUMENT_TOKENS: Final[frozenset[str]] = frozenset(
    {
        "hello",
        "world",
        "admin",
        '\'"$argon2id$v=19"\'',
    }
)

def shell_quote(value: str) -> str:
    """Return ``value`` as ONE shell word that expands to exactly itself.

    THE ONE QUOTING PRIMITIVE OF THIS TIER, and the reason it exists rather than
    being open-coded at each site. The shell tier GENERATES a ``kube-env`` script and
    then has bash ``source`` it, so every value that reaches a ``readonly VAR=…``
    assignment crosses from DATA into CODE. Unquoted, a value containing a space
    splits the assignment and turns the remainder into a command; one containing
    ``$(…)``, a backtick or ``${…}`` is EVALUATED, because bash expands all three
    inside an unquoted (and inside a double-quoted) assignment; one containing ``;``
    or a newline ends the assignment and starts a statement. That is CWE-78, and it
    is not hypothetical here: ``KubeHome`` is derived from pytest's ``tmp_path``, which
    is derived from ``--basetemp`` -- an argument the runner accepts and therefore an
    externally chosen path.

    ``shlex.quote`` is the implementation because it is the standard library's
    audited answer and because of a property that matters as much as the safety: it
    is a NO-OP for every value made only of ``[A-Za-z0-9_@%+=:,./-]``. Every value
    the ported shell tests actually carry is in that set -- ``/tmp/pytest-of-root/…``
    paths, ``https://127.0.0.1:2379``, base64 such as ``Zm9v``, placeholder
    identifiers such as ``CACertPath``, ``false`` -- so the rendered ``kube-env`` stays
    BYTE-IDENTICAL to what Go's ``text/template`` writes for all of them, and the
    renderer's fidelity to the oracle is preserved. Quoting appears only where a
    value would otherwise have been interpreted, and there the interpretation was
    the bug.

    Single quotes are what ``shlex.quote`` emits, and single quotes are what makes
    the guarantee total: inside them bash performs NO expansion at all, and an
    embedded ``'`` is handled by closing, escaping and reopening. There is therefore
    no value -- including one containing quotes of both kinds, a newline, or a NUL-free
    binary smear -- that can escape the word.

    Args:
        value: The text the generated script must see, exactly.

    Returns:
        A single shell word. Safe values are returned unchanged; anything else is
        single-quoted.
    """
    return shlex.quote(value)


#: ``$0`` for every ``bash -c`` invocation this module makes.
#:
#: ``bash -c SCRIPT NAME ARG…`` binds ``NAME`` to ``$0`` and the remaining words
#: to ``$1``, ``$2`` and so on. A descriptive ``$0`` is what bash prints in its
#: own diagnostics, so a shell error names this harness rather than reading
#: ``bash: line 1:``.
_ARGV0: Final[str] = "kube-shell-harness"

# How long a timed-out process GROUP is given to die after SIGTERM before it is
# sent SIGKILL. Small on purpose: by this point the invocation has already
# overrun its whole budget, so the only question left is whether the shell gets
# to run its traps before it is destroyed.
_GROUP_KILL_GRACE_SECONDS: Final[float] = 2.0


def _terminate_process_group(process: "subprocess.Popen[str]") -> None:
    """Reap a timed-out bash invocation together with every descendant it left.

    ``run_bash`` starts bash with ``start_new_session=True``, so bash is the
    leader of its own process group and the group id equals its pid. Signalling
    the GROUP is what reaches a backgrounded grandchild; signalling the pid alone
    (which is all ``subprocess.run``'s timeout does) would leave one running and
    holding the captured pipe open.

    ``SIGTERM`` first, so a shell with a trap can still run it, then ``SIGKILL``
    after :data:`_GROUP_KILL_GRACE_SECONDS`. ``os.killpg`` is called only with
    the pid of the process this module itself just spawned, so it can never
    address an unrelated group. ``ProcessLookupError`` and ``PermissionError``
    are both benign races -- the group finished, or it was never created because
    the exec failed -- and fall back to signalling the process directly.

    Args:
        process: The invocation to reap. Must have been started with
            ``start_new_session=True``.
    """
    group = process.pid

    def signal_group(sig: int) -> None:
        try:
            os.killpg(group, sig)
        except (ProcessLookupError, PermissionError):
            # The group is gone, or was never created because the exec failed.
            # Fall back to the pid, and tolerate that dying first too.
            with contextlib.suppress(ProcessLookupError):
                process.kill()

    signal_group(signal.SIGTERM)
    try:
        process.wait(timeout=_GROUP_KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        signal_group(signal.SIGKILL)


def _require_func_name(func_name: str) -> str:
    """Validate a shell function name before it is interpolated into a script.

    Two distinct failures are refused here, and the second is a security
    property rather than a convenience.

    A BLANK name leaves the script ending at its final ``;``, so bash sources the
    scripts, runs nothing, exits 0, and the invocation reports success while
    having asserted nothing at all. That is a false pass in a security test, so
    it is refused here rather than discovered later.

    A name carrying SHELL METACHARACTERS would be appended to the ``source``
    chain as raw text and could terminate that command and begin another --
    ``foo; rm -rf /`` or ``$(id)`` reach bash as a command substitution, and
    wrapping the name in quotes is not an option because Go appends it bare and a
    quoted word would not be expanded as a command name. Only
    :data:`_FUNC_NAME_PATTERN` is accepted, which admits every name in the ported
    surface and no metacharacter at all.

    Raises:
        BashInvocationError: if ``func_name`` is blank or does not match
            :data:`_FUNC_NAME_PATTERN`.
    """
    __tracebackhide__ = True
    stripped = func_name.strip()
    if not stripped:
        raise BashInvocationError(
            "refusing to invoke a blank shell function name: bash would source the "
            "scripts, run nothing, exit 0 and report a FALSE PASS"
        )
    if _FUNC_NAME_PATTERN.match(func_name) is None:
        raise BashInvocationError(
            f"refusing to invoke the shell function name {func_name!r}: it is appended to the "
            f"script text as a command word, so a name carrying whitespace, '$', a backtick, a "
            f"quote, ';', '&' or '|' could terminate the source chain and run something else. "
            f"Accepted shape: a leading letter or underscore followed by letters, digits, "
            f"underscores and hyphens (for example 'create-master-audit-policy')."
        )
    return func_name


def _require_raw_arguments(args: Sequence[str]) -> tuple[str, ...]:
    """Restrict MODE THREE's raw-substitution seam to the enumerated fixture tokens.

    See :data:`ALLOWED_RAW_ARGUMENT_TOKENS` for why the seam has to stay raw and
    why enumeration - rather than escaping - is what closes it.

    Raises:
        BashInvocationError: if any token is not in
            :data:`ALLOWED_RAW_ARGUMENT_TOKENS`.
    """
    __tracebackhide__ = True
    rejected = [argument for argument in args if argument not in ALLOWED_RAW_ARGUMENT_TOKENS]
    if rejected:
        raise BashInvocationError(
            f"refusing to substitute {rejected!r} into a bash -c script unquoted: this seam is "
            f"raw by necessity - the Go oracle passes '\\'\"$argon2id$v=19\"\\'' and expects bash "
            f"to strip the single quotes - so it accepts ONLY the tokens that oracle passes: "
            f"{sorted(ALLOWED_RAW_ARGUMENT_TOKENS)}. A value derived from a path, an environment "
            f"variable or a fixture parameter must never reach it. Pass a file path through the "
            f"target_path argument, which travels as a positional parameter and is never "
            f"interpolated."
        )
    return tuple(args)


def _build_source_chain(
    env_script_path: str | os.PathLike[str],
    script_names: Sequence[str],
    func_name: str,
) -> tuple[str, tuple[str, ...]]:
    """Build the ``source`` chain of ``mustInvokeFunc`` and the argv it reads paths from.

    Ports the string assembly of ``mustInvokeFunc``
    (cluster/gce/gci/configure_helper_test.go L110-114)::

        args := fmt.Sprintf("source %q ;", envScriptPath)
        for _, script := range scriptNames {
            args += fmt.Sprintf("source %q ;", script)
        }
        args += c.manifestFuncName

    Three details of that shape are reproduced exactly, because a failure
    message here has to be comparable with the Go one:

    * a SPACE precedes each ``;``, and nothing separates one ``source`` clause
      from the next, so the chain reads ``... ;source "$1" ;``;
    * the function name is appended with NO separator, directly after the last
      ``;``;
    * each sourced path is one double-quoted word, so a path containing a space
      is still a single argument to ``source``.

    PATHS ARE NOT INTERPOLATED. They travel as POSITIONAL PARAMETERS -- ``$1``,
    ``$2``, ``$3`` -- and the script text references those parameters instead. The
    difference matters: bash performs parameter expansion, command substitution
    and arithmetic expansion INSIDE double quotes, so an interpolated path
    containing ``$(...)``, a backtick or ``$VAR`` would be EVALUATED rather than
    read as text, and an embedded ``"`` would end the quoted word and let the rest
    of the path be parsed as shell code. A positional parameter is expanded
    exactly once, to its literal value, and ``"$1"`` cannot be re-parsed however
    the value is spelled. Paths here derive from ``tmp_path``, so they follow
    pytest's ``--basetemp`` and the test's own name -- values a fixture, a
    parametrize id or an environment variable can influence -- which is precisely
    why they are kept out of the program text.

    ``source "$1"`` is behaviourally identical to ``source "<literal>"`` for every
    value in the ported surface: ``source`` receives one word either way. A
    relative name such as ``configure-helper.sh`` is still searched on ``$PATH``
    and then in the working directory exactly as before, because the word bash
    sees is the same string.

    Script names stay RELATIVE, exactly as ``apiserver_etcd_test.go`` and
    ``apiserver_kms_test.go`` write them, and resolve against the caller's
    ``cwd``.

    Returns:
        ``(script, argv)`` -- the text for ``bash -c`` and the positional
        arguments it reads, in order, ready to pass to :func:`run_bash`.
    """
    argv = [os.fspath(env_script_path), *(os.fspath(script) for script in script_names)]
    clauses = [f'source "${index}" ;' for index in range(1, len(argv) + 1)]
    return "".join(clauses) + func_name, tuple(argv)


def run_bash(
    script: str,
    *,
    cwd: str | os.PathLike[str],
    argv: Sequence[str] = (),
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    check: bool = True,
    merge_streams: bool = True,
    requirement: str | None = None,
) -> BashResult:
    """Run one bash script string and return what it produced.

    Ports the execution half of ``mustInvokeFunc``
    (cluster/gce/gci/configure_helper_test.go L115-122) and is the single place
    this module talks to the operating system, so the timeout, the environment
    copy and the decoding rules hold for every posture.

    INVARIANT PRESERVED: the script is handed to ``bash -c`` as ONE argument
    string, which is what lets a ``source`` chain and a function call live in a
    single invocation. There is no ``shell=True`` (that would interpose
    ``/bin/sh``), the script is never split into an argv list (that would make
    the ``source`` chain unparseable), and ``sh`` is never substituted for
    ``bash``.

    Args:
        script: The exact text for ``bash -c``.
        argv: Positional parameters the script reads as ``$1``, ``$2`` and so on.
            This is the ONLY way a filesystem path should reach a script: bash
            expands a positional parameter exactly once, to its literal value, so
            ``"$1"`` cannot be re-parsed as shell code however the value is
            spelled -- whereas an interpolated path would undergo command,
            parameter and arithmetic expansion even inside double quotes. ``$0``
            is fixed at :data:`_ARGV0` so a shell diagnostic names this harness.
        cwd: Directory to run in. Supplied by the caller and never derived here:
            the shipped scripts and the ``testdata/...`` templates are named
            relatively, so for ``configure-helper.sh`` and
            ``configure-kubeapiserver.sh`` this is ``<repo>/cluster/gce/gci``.
            ``python/tests/conftest.py`` owns ``repo_root``; this module owns no
            notion of where the repository is.
        env: Overrides merged over a COPY of ``os.environ``. The parent's
            environment is never mutated, which is what makes a scenario that
            varies ``ETCD_APISERVER_ALLOW_INSECURE`` or the six etcd credential
            variables safe under ``pytest-xdist`` and ``pytest-randomly``.
        timeout: Seconds to allow. ``None`` uses
            :data:`DEFAULT_TIMEOUT_SECONDS`.
        check: When true (the default), a non-zero exit raises. This is the
            ``t.Fatalf`` posture, and it is the default so that a caller has to
            ASK to tolerate failure.
        merge_streams: When true (the default), stderr is redirected into stdout,
            reproducing Go's ``CombinedOutput``; ``BashResult.stderr`` is then
            the empty string. Pass ``False`` to keep the two apart.
        requirement: Identifier of the requirement this call enforces, quoted in
            any failure message.

    Returns:
        The :class:`BashResult` for the invocation.

    Raises:
        BashInvocationError: on a non-zero exit when ``check`` is true; when the
            script exceeds its timeout; when ``timeout`` is not positive; or
            when ``bash`` cannot be executed at all.
    """
    __tracebackhide__ = True

    budget = DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout
    if budget <= 0:
        raise BashInvocationError(
            f"refusing to run bash with a non-positive timeout ({budget}s): an "
            "invocation must be bounded, because Python has no analogue of Go's "
            "-race or goleak and an unbounded hang would wedge the session"
        )

    # A COPY, always. Mutating os.environ would leak into every other test in
    # this process, and under pytest-xdist into every test the worker runs next.
    child_env = dict(os.environ)
    if env is not None:
        child_env.update(env)

    # CombinedOutput() interleaves the two streams into one buffer; STDOUT here
    # is that redirection. With merge_streams=False the streams stay separable,
    # which is the capability the V8 fail-closed assertions are built on.
    stderr_target = subprocess.STDOUT if merge_streams else subprocess.PIPE

    try:
        # Popen with start_new_session, rather than subprocess.run, for ONE
        # reason: run() kills only the IMMEDIATE child when its timeout expires,
        # and bash routinely has descendants -- a `source`d generator that
        # backgrounds work, or a pipeline whose right-hand side outlives the
        # left. Those grandchildren would survive as orphans holding the pipe
        # open. Python offers no analogue of Go's goleak (AAP §0.7.2), so "no
        # lingering subprocess" has to be enforced here, deliberately, rather
        # than assumed. start_new_session=True makes bash a session and process-
        # group leader, so _terminate_process_group can reap the whole tree.
        process = subprocess.Popen(
            [_BASH_EXECUTABLE, "-c", script, _ARGV0, *argv],
            cwd=os.fspath(cwd),
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=stderr_target,
            # errors="replace" so a stray byte in a generated manifest degrades
            # to U+FFFD instead of raising a UnicodeDecodeError that would mask
            # whatever the test was actually asserting.
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
    except OSError as exc:
        lines = [f"could not execute {_BASH_EXECUTABLE!r}: {exc}"]
        lines.extend(_render_context(script, cwd, requirement, argv))
        raise BashInvocationError("\n".join(lines)) from exc

    with process:
        try:
            captured_stdout, captured_stderr = process.communicate(timeout=budget)
        except subprocess.TimeoutExpired as exc:
            # Reap the GROUP, not just bash, then drain the pipes so no reader
            # is left blocked and nothing is reported as an unraisable
            # ResourceWarning at interpreter shutdown.
            _terminate_process_group(process)
            try:
                partial_stdout, _ = process.communicate(timeout=_GROUP_KILL_GRACE_SECONDS)
            except subprocess.TimeoutExpired:  # pragma: no cover - group is dead by now
                partial_stdout = ""
            partial = partial_stdout or (exc.output if isinstance(exc.output, str) else "")
            lines = [f"bash invocation exceeded its {budget}s timeout and was killed"]
            lines.extend(_render_context(script, cwd, requirement, argv))
            lines.append("  output captured before the kill:")
            lines.append(_indent(partial))
            raise BashInvocationError("\n".join(lines)) from exc

    result = BashResult(
        returncode=process.returncode,
        stdout=captured_stdout or "",
        stderr="" if merge_streams else (captured_stderr or ""),
        script=script,
        streams_merged=merge_streams,
    )

    if check and result.returncode != 0:
        raise BashInvocationError(_render_failure(result, cwd, requirement, argv))
    return result


# MODE ONE. Ports ManifestTestCase.mustInvokeFunc,
# cluster/gce/gci/configure_helper_test.go L108-123, whose two halves are the
# string assembly (L110-114) and the merged-output, fatal-on-error execution
# (L115-122).
#
# INVARIANT PRESERVED: the shipped bash generator is what runs, the streams are
# merged exactly as CombinedOutput merges them, and a non-zero exit ABORTS -- the
# t.Fatalf posture. This is the posture of every L1 caller (test_apiserver_etcd,
# test_apiserver_kms, test_audit_policy) and of the manifest helper beside this
# module, because a generator that failed to run has produced no manifest and
# every later assertion in that test would be meaningless.
def must_invoke_func(
    func_name: str,
    *,
    env_script_path: str | os.PathLike[str],
    script_names: Sequence[str],
    cwd: str | os.PathLike[str],
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    requirement: str | None = None,
) -> BashResult:
    """Source the ``kube-env`` script and the named scripts, then call ``func_name``.

    The resulting script has the shape ``mustInvokeFunc`` builds -- one line, with
    a space before every ``;``, nothing between the clauses, and the function name
    hard against the final ``;``::

        source "/tmp/kube-env" ;source "configure-helper.sh" ;start-kube-apiserver

    Args:
        func_name: Shell function to call once every script is sourced, for
            example ``start-kube-apiserver`` or ``create-master-audit-policy``.
            Appended bare, with no separator, exactly as Go appends
            ``c.manifestFuncName``.
        env_script_path: Path to the rendered ``kube-env`` file, sourced first so
            the scripts see the environment the case set up. Written by
            ``mustCreateEnv`` in Go and by the shell tier's ``render_kube_env``
            fixture here.
        script_names: Scripts to source, IN ORDER, after ``kube-env``. Relative
            names resolve against ``cwd``, which is how the Go tests write them
            (``["configure-helper.sh", "configure-kubeapiserver.sh"]``).
        cwd: Directory to run in -- ``<repo>/cluster/gce/gci`` for the shipped
            hardening scripts.
        env: Overrides merged over a copy of ``os.environ``.
        timeout: Seconds to allow; ``None`` uses
            :data:`DEFAULT_TIMEOUT_SECONDS`.
        requirement: Identifier of the requirement enforced, quoted on failure.

    Returns:
        The :class:`BashResult`, whose ``stdout`` holds the MERGED output and
        whose ``stderr`` is therefore always empty. Go discards this buffer into
        ``t.Logf``; it is returned here so a caller can assert on it without a
        second invocation.

    Raises:
        BashInvocationError: if ``func_name`` is blank, if the invocation exceeds
            its timeout, or if bash exits non-zero -- the ``t.Fatalf`` analogue.
    """
    __tracebackhide__ = True
    script, argv = _build_source_chain(
        env_script_path, script_names, _require_func_name(func_name)
    )
    return run_bash(
        script,
        cwd=cwd,
        argv=argv,
        env=env,
        timeout=timeout,
        check=True,
        merge_streams=True,
        requirement=requirement,
    )


# MODE TWO. No single Go ancestor function: it exists because the four V8
# fail-closed scenarios of configure-etcd-params
# (cluster/gce/gci/configure-kubeapiserver.sh:18) are performed by hand today,
# and AAP §0.4.2.1 automates them.
#
# INVARIANT PRESERVED: a non-zero exit is an OUTCOME, not a harness failure, and
# stderr is readable on its own. F-008-RQ-001 requires that missing etcd
# credentials with ETCD_APISERVER_ALLOW_INSECURE unset make the script refuse to
# fall back to plaintext etcd -- asserted as returncode == 1 AND a specific
# refusal on stderr (AAP §0.10.2 names the stream, and the shipped script emits
# both fail-closed ERRORs with `>&2`; configure-kubeapiserver.sh lines 45 and
# 49), and the partial-credential branch must exit 1 too. Neither assertion is
# writable against a helper that raises on non-zero or that merges the streams,
# which is exactly why this posture is separate from MODE ONE rather than a flag
# on it.
def try_invoke_func(
    func_name: str,
    *,
    env_script_path: str | os.PathLike[str],
    script_names: Sequence[str],
    cwd: str | os.PathLike[str],
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    requirement: str | None = None,
) -> BashResult:
    """Invoke like :func:`must_invoke_func`, but treat a non-zero exit as data.

    Identical script construction, two deliberate differences:

    * stdout and stderr are captured SEPARATELY, so a test can assert on a
      specific diagnostic without matching it against the script's normal
      chatter -- and, more importantly here, so that WHICH STREAM carries it is
      itself assertable. For ``configure-etcd-params`` the stream is part of the
      requirement, not an implementation detail: AAP §0.10.2, §0.4.2.1 and
      §0.5.2.1 each place the "refusing to fall back to plaintext etcd" refusal on
      STDERR, and the shipped script writes both fatal ERRORs with ``>&2`` while
      keeping the non-fatal WARNING on stdout. A caller that matched the merged
      concatenation would be satisfied by either stream and so could not tell a
      correct refusal from one that regressed onto stdout;
    * the result is RETURNED whatever the exit code. Nothing about a non-zero
      exit raises here, because for a fail-closed control a non-zero exit is the
      behaviour being proven.

    Harness failures still raise: a timeout, a non-positive timeout, or a bash
    that cannot be executed are not scenario outcomes and must not be mistaken
    for one.

    Args:
        func_name: Shell function to call, for example ``configure-etcd-params``.
        env_script_path: Rendered ``kube-env`` path, sourced first. The
            fail-closed scenarios vary the six etcd credential variables and
            ``ETCD_APISERVER_ALLOW_INSECURE`` through this file, through ``env``,
            or through both.
        script_names: Scripts to source, in order, after ``kube-env``.
        cwd: Directory to run in -- ``<repo>/cluster/gce/gci``.
        env: Overrides merged over a copy of ``os.environ``.
        timeout: Seconds to allow; ``None`` uses
            :data:`DEFAULT_TIMEOUT_SECONDS`.
        requirement: Identifier of the requirement enforced, quoted if a HARNESS
            failure message is produced.

    Returns:
        The :class:`BashResult` with ``returncode``, ``stdout`` and ``stderr``
        all populated independently and ``streams_merged`` false.

    Raises:
        BashInvocationError: if ``func_name`` is blank, if the invocation exceeds
            its timeout, or if bash cannot be executed. NEVER for a non-zero exit.
    """
    __tracebackhide__ = True
    script, argv = _build_source_chain(
        env_script_path, script_names, _require_func_name(func_name)
    )
    return run_bash(
        script,
        cwd=cwd,
        argv=argv,
        env=env,
        timeout=timeout,
        check=False,
        merge_streams=False,
        requirement=requirement,
    )


# MODE THREE. Ports the invocation in TestAppendOrReplacePrefix,
# cluster/gce/gci/append_or_replace_prefixed_line_test.go L166-171:
#
#   args := fmt.Sprintf("source configure-helper.sh; append_or_replace_prefixed_line %s %s %s",
#       f.Name(), tc.prefix, tc.suffix)
#
# INVARIANT PRESERVED: the ARGUMENT TOKENS reach bash EXACTLY as the case wrote
# them. Five of that test's ten cases pass the prefix as the eight characters
# '"$argon2id$v=19"' -- single quotes included -- and expect the file to end up
# holding "$argon2id$v=19"admin, which only happens because bash strips those
# single quotes and the $ sequences never reach the shell unquoted. Quoting those
# tokens here would deliver the literal single quotes to the function, change the
# file contents and fail those cases. The separator is also different from MODE
# ONE: ';' with NO preceding space, then one space before the function name.
#
# TWO SEAMS ARE CLOSED WITHOUT DISTURBING THAT INVARIANT:
#
#   * the FILE PATH travels as a POSITIONAL PARAMETER and is referenced as "$2",
#     never interpolated. The Go original writes the path with %s straight into
#     the program text, which is safe for a `CreateTemp` name and unsafe in
#     general: under pytest the path derives from `tmp_path`, hence from
#     --basetemp and the test's own name, so a directory containing $(...), a
#     backtick or a quote would be EVALUATED by bash rather than read. A
#     positional parameter is expanded once, to its literal value.
#   * the SCRIPT NAME is a positional parameter too, referenced as "$1", so the
#     one remaining interpolated element of MODE THREE is gone as well.
#   * the ARGUMENT TOKENS stay raw, and the seam is closed by ENUMERATION: only
#     the four literals the Go oracle passes are accepted. See
#     ALLOWED_RAW_ARGUMENT_TOKENS.
def must_invoke_func_with_args(
    func_name: str,
    args: Sequence[str],
    *,
    target_path: str | os.PathLike[str],
    cwd: str | os.PathLike[str],
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    script: str = CONFIGURE_HELPER_SCRIPT,
    requirement: str | None = None,
) -> BashResult:
    """Source one script and call ``func_name`` with a path plus RAW positional tokens.

    The resulting script has the shape the Go original builds, with the two path
    elements referenced as positional parameters rather than interpolated::

        source "$1"; append_or_replace_prefixed_line "$2" '"$argon2id$v=19"' admin

    which bash executes with ``$1`` bound to ``configure-helper.sh`` and ``$2`` to
    the target file. The function therefore receives exactly the same three words
    the Go original passes it.

    Args:
        func_name: Shell function to call, for example
            ``append_or_replace_prefixed_line``. Validated by
            :func:`_require_func_name`.
        args: Argument tokens AFTER the path, substituted VERBATIM and separated
            by single spaces. They are PRE-QUOTED, TEST-CONTROLLED literals:
            whatever quoting bash should apply is already part of the string, and
            this function adds and removes nothing. Restricted to
            :data:`ALLOWED_RAW_ARGUMENT_TOKENS`, so no value derived from outside
            the test can reach this seam.
        target_path: The file the function operates on, passed as ``$2`` and never
            interpolated. Any path is safe here, including one containing spaces,
            quotes, ``$(...)`` or backticks.
        cwd: Directory to run in. ``script`` is relative, so this must be the
            directory holding it -- ``<repo>/cluster/gce/gci``.
        env: Overrides merged over a copy of ``os.environ``.
        timeout: Seconds to allow; ``None`` uses
            :data:`DEFAULT_TIMEOUT_SECONDS`.
        script: Script to source, written relative exactly as the Go original
            writes it, and passed as ``$1``. Defaults to
            :data:`CONFIGURE_HELPER_SCRIPT`, the only script that test sources.
        requirement: Identifier of the requirement enforced, quoted on failure.

    Returns:
        The :class:`BashResult` with MERGED output in ``stdout``, matching the
        ``CombinedOutput`` the Go original captures into its ``stderr`` variable.

    Raises:
        BashInvocationError: if ``func_name`` is blank or carries a shell
            metacharacter, if any token in ``args`` is outside
            :data:`ALLOWED_RAW_ARGUMENT_TOKENS`, if the invocation exceeds its
            timeout, or if bash exits non-zero -- the ``t.Fatalf`` analogue.
    """
    __tracebackhide__ = True
    # RAW SUBSTITUTION OF THE TOKENS, AND IT MUST STAY RAW.
    #
    # Go writes %s here, not %q, and no shlex.quote belongs on the next line.
    # append_or_replace_prefixed_line_test.go passes the prefix '"$argon2id$v=19"'
    # WITH its single quotes and expects bash to strip them, so the function
    # receives "$argon2id$v=19" and the file ends up holding
    # "$argon2id$v=19"admin. shlex.quote would wrap that in another layer, the
    # literal single quotes would reach the function, and five of the ten ported
    # cases would fail with contents that differ by exactly those quotes.
    # Tidying this up is not a cleanup; it is a silent weakening of the case that
    # exists specifically to cover quoting and '='.
    #
    # What makes it safe is the allow-list, not escaping: only the four literals
    # the oracle passes get here at all.
    tokens = _require_raw_arguments(args)
    parts = ['source "$1";', _require_func_name(func_name), '"$2"', *tokens]
    return run_bash(
        " ".join(parts),
        cwd=cwd,
        argv=(os.fspath(script), os.fspath(target_path)),
        env=env,
        timeout=timeout,
        check=True,
        merge_streams=True,
        requirement=requirement,
    )
