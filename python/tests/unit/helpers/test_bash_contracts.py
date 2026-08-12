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

"""Contract tests for ``tests.helpers.bash``: the failure paths, not the happy path.

AAP §0.5.1 (the ``python/tests/helpers/bash.py`` row) / §0.4.2.1 (the L1
shell-boundary and L4 fail-closed blueprints this helper serves) / §0.3.2 ("run
for real -- never mocked": these tests invoke the real ``bash``) / §0.7.2
(assertion density, structural isolation, parallel safety) / tech-spec §6.6.3.4
(the documentation convention).

INVARIANTS LOCKED BY THIS MODULE, each one a property a consumer test silently
depends on and none of which a happy-path test would notice losing:

1. A BLANK OR HOSTILE SHELL FUNCTION NAME IS REFUSED. A blank name makes bash
   source the scripts, run nothing and exit 0 -- a false pass in a security test.
   A name carrying a shell metacharacter is appended to the script as a command
   word, so it could terminate the source chain and run something else.
2. A FILESYSTEM PATH CANNOT ALTER THE PROGRAM. Paths travel as positional
   parameters, so a directory whose name contains ``$(...)``, a backtick, a quote
   or a space is read as text and never evaluated.
3. THE RAW-ARGUMENT SEAM ACCEPTS ONLY THE ORACLE'S OWN TOKENS, and the quoting
   case that seam exists for still behaves exactly as the Go oracle requires.
4. A TIMEOUT IS A FAILURE, NOT A HANG. Python has no ``-race`` and no goleak, so
   the bound is the substitute and it must fire.
5. THE TWO GO FAILURE POSTURES BOTH SURVIVE: ``check=True`` aborts like
   ``t.Fatalf``; ``check=False`` returns a non-zero exit as data, which is the
   only shape the V8 fail-closed assertions can be written against.
6. THE PARENT ENVIRONMENT IS NEVER MUTATED, which is what makes the tier safe
   under ``pytest-xdist`` and ``pytest-randomly``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tests.helpers.bash import (
    ALLOWED_RAW_ARGUMENT_TOKENS,
    BashInvocationError,
    must_invoke_func,
    must_invoke_func_with_args,
    run_bash,
    try_invoke_func,
)

pytestmark = pytest.mark.shell

#: A directory name carrying every metacharacter that would matter if a path were
#: interpolated into a ``bash -c`` string: a command substitution, a backtick
#: substitution, a single quote, a double quote and a space. If any of these were
#: evaluated, the marker file named inside the substitution would appear.
HOSTILE_DIR_NAME = "hos$(touch INJECTED)`touch INJECTED_BACKTICK`'q\"q dir"

#: The marker a successful injection would create.
INJECTION_MARKER = "INJECTED"


@pytest.fixture
def hostile_home(tmp_path: Path) -> Path:
    """A directory whose NAME alone would be enough to inject, were paths interpolated."""
    home = tmp_path / HOSTILE_DIR_NAME
    home.mkdir()
    return home


def _probe_scripts(home: Path) -> tuple[Path, Path]:
    """Write a minimal ``kube-env`` and a script declaring ``probe-func`` inside ``home``."""
    env_script = home / "kube-env"
    env_script.write_text("PROBE_VALUE=from-kube-env\n", encoding="utf-8")
    script = home / "probe.sh"
    script.write_text('probe-func() { echo "probe ran with ${PROBE_VALUE}"; }\n', encoding="utf-8")
    return env_script, script


# ---------------------------------------------------------------------------
# 1. Function-name validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    ["", "   ", "\t"],
    ids=["empty", "spaces", "tab"],
)
def test_blank_function_name_is_refused(name: str, tmp_path: Path) -> None:
    """A blank name would exit 0 having asserted nothing -- the false pass F-006/F-008 cannot afford."""
    env_script, script = _probe_scripts(tmp_path)

    with pytest.raises(BashInvocationError, match="FALSE PASS"):
        must_invoke_func(
            name,
            env_script_path=env_script,
            script_names=[str(script)],
            cwd=str(tmp_path),
        )


@pytest.mark.parametrize(
    "name",
    [
        "probe-func; touch INJECTED",
        "$(touch INJECTED)",
        "`touch INJECTED`",
        "probe func",
        "probe-func|cat",
        "probe-func&",
        "probe-func>out",
        "1leading-digit",
        "probe'func",
        'probe"func',
    ],
    ids=[
        "semicolon-command",
        "command-substitution",
        "backtick-substitution",
        "embedded-space",
        "pipe",
        "background",
        "redirect",
        "leading-digit",
        "single-quote",
        "double-quote",
    ],
)
def test_hostile_function_name_is_refused_before_bash_runs(name: str, tmp_path: Path) -> None:
    """A name is appended as a command word, so a metacharacter must never reach bash."""
    env_script, script = _probe_scripts(tmp_path)

    with pytest.raises(BashInvocationError, match="refusing to invoke the shell function name"):
        must_invoke_func(
            name,
            env_script_path=env_script,
            script_names=[str(script)],
            cwd=str(tmp_path),
        )

    assert not (tmp_path / INJECTION_MARKER).exists(), (
        "the refused name still managed to run a command: the validation happens before bash"
    )


@pytest.mark.parametrize(
    "name",
    [
        "create-master-audit-policy",
        "start-kube-apiserver",
        "configure-etcd-params",
        "setup-etcd-encryption",
        "append_or_replace_prefixed_line",
    ],
)
def test_every_shell_function_in_the_ported_surface_is_accepted(name: str, tmp_path: Path) -> None:
    """The validation must not reject a real name: these five are the whole ported surface."""
    env_script, script = _probe_scripts(tmp_path)
    script.write_text(f"{name}() {{ echo ran; }}\n", encoding="utf-8")

    result = must_invoke_func(
        name,
        env_script_path=env_script,
        script_names=[str(script)],
        cwd=str(tmp_path),
    )

    assert result.returncode == 0
    assert "ran" in result.stdout


# ---------------------------------------------------------------------------
# 2. Hostile paths cannot alter the program
# ---------------------------------------------------------------------------


def test_hostile_path_is_read_as_text_not_evaluated(hostile_home: Path, tmp_path: Path) -> None:
    """A path containing $(), backticks, quotes and a space must not be expanded (CWE-78)."""
    env_script, script = _probe_scripts(hostile_home)

    result = must_invoke_func(
        "probe-func",
        env_script_path=env_script,
        script_names=[str(script)],
        cwd=str(tmp_path),
    )

    assert result.returncode == 0
    assert "probe ran with from-kube-env" in result.stdout
    # The script text must reference positional parameters, never the path.
    assert result.script == 'source "$1" ;source "$2" ;probe-func'
    assert HOSTILE_DIR_NAME not in result.script
    for candidate in (tmp_path, hostile_home, Path.cwd()):
        assert not (candidate / INJECTION_MARKER).exists()
        assert not (candidate / "INJECTED_BACKTICK").exists()


def test_hostile_path_survives_the_fail_closed_posture(hostile_home: Path, tmp_path: Path) -> None:
    """try_invoke_func builds the same chain, so the same guarantee has to hold there."""
    env_script, script = _probe_scripts(hostile_home)
    script.write_text('probe-func() { echo "to stderr" >&2; return 1; }\n', encoding="utf-8")

    result = try_invoke_func(
        "probe-func",
        env_script_path=env_script,
        script_names=[str(script)],
        cwd=str(tmp_path),
    )

    assert result.returncode == 1
    assert result.stderr.strip() == "to stderr"
    assert result.stdout == ""
    assert not (tmp_path / INJECTION_MARKER).exists()


# ---------------------------------------------------------------------------
# 3. The raw-argument seam
# ---------------------------------------------------------------------------


def test_raw_argument_seam_preserves_the_oracle_quoting_case(tmp_path: Path) -> None:
    """The seam exists for this case: bash must strip the single quotes the token carries.

    Ports the fifth case of ``append_or_replace_prefixed_line_test.go`` L88-93:
    the prefix arrives as the eight characters ``'"$argon2id$v=19"'`` and the file
    must end up holding ``"$argon2id$v=19"admin``. Quoting the token here would
    deliver the single quotes to the shell function and change the result.
    """
    script = tmp_path / "helper.sh"
    script.write_text(
        "append_or_replace_prefixed_line() { printf '%s%s\\n' \"$2\" \"$3\" >>\"$1\"; }\n",
        encoding="utf-8",
    )
    target = tmp_path / "out file.txt"
    target.write_text("", encoding="utf-8")

    must_invoke_func_with_args(
        "append_or_replace_prefixed_line",
        ['\'"$argon2id$v=19"\'', "admin"],
        target_path=target,
        cwd=str(tmp_path),
        script="helper.sh",
    )

    assert target.read_text(encoding="utf-8") == '"$argon2id$v=19"admin\n'


@pytest.mark.parametrize(
    "token",
    [
        "$(touch INJECTED)",
        "`touch INJECTED`",
        "; touch INJECTED",
        "$HOME",
        "arbitrary",
        "",
    ],
    ids=[
        "command-substitution",
        "backtick-substitution",
        "command-separator",
        "variable-expansion",
        "unlisted-plain-token",
        "empty",
    ],
)
def test_raw_argument_seam_refuses_anything_outside_the_enumeration(
    token: str, tmp_path: Path
) -> None:
    """The seam is raw by necessity, so it is closed by enumeration rather than escaping."""
    script = tmp_path / "helper.sh"
    script.write_text("append_or_replace_prefixed_line() { :; }\n", encoding="utf-8")
    target = tmp_path / "out.txt"
    target.write_text("", encoding="utf-8")

    with pytest.raises(BashInvocationError, match="refusing to substitute"):
        must_invoke_func_with_args(
            "append_or_replace_prefixed_line",
            [token, "admin"],
            target_path=target,
            cwd=str(tmp_path),
            script="helper.sh",
        )

    assert not (tmp_path / INJECTION_MARKER).exists()


def test_raw_argument_enumeration_is_exactly_the_oracle_vocabulary() -> None:
    """Widening the seam must be a deliberate act, so the set itself is asserted."""
    observed = set(ALLOWED_RAW_ARGUMENT_TOKENS)

    assert observed == {"hello", "world", "admin", '\'"$argon2id$v=19"\''}


def test_raw_argument_seam_accepts_a_hostile_target_path(tmp_path: Path) -> None:
    """The path is a positional parameter, so any path is safe -- including a hostile one."""
    script = tmp_path / "helper.sh"
    script.write_text(
        "append_or_replace_prefixed_line() { printf '%s%s\\n' \"$2\" \"$3\" >>\"$1\"; }\n",
        encoding="utf-8",
    )
    hostile = tmp_path / HOSTILE_DIR_NAME
    hostile.mkdir()
    target = hostile / "target file.txt"
    target.write_text("", encoding="utf-8")

    result = must_invoke_func_with_args(
        "append_or_replace_prefixed_line",
        ["hello", "world"],
        target_path=target,
        cwd=str(tmp_path),
        script="helper.sh",
    )

    assert target.read_text(encoding="utf-8") == "helloworld\n"
    assert HOSTILE_DIR_NAME not in result.script
    assert not (tmp_path / INJECTION_MARKER).exists()


# ---------------------------------------------------------------------------
# 4. Bounds
# ---------------------------------------------------------------------------


def test_timeout_becomes_a_failure_naming_the_script(tmp_path: Path) -> None:
    """A hang has to become a legible failure: Python has no -race and no goleak."""
    with pytest.raises(BashInvocationError, match=r"exceeded its .*timeout and was killed"):
        run_bash("echo before-the-hang; sleep 30", cwd=str(tmp_path), timeout=0.5)


@pytest.mark.parametrize("budget", [0, -1, -0.5], ids=["zero", "negative-int", "negative-float"])
def test_non_positive_timeout_is_refused(budget: float, tmp_path: Path) -> None:
    """An unbounded invocation would wedge the session, so the bound cannot be disabled."""
    with pytest.raises(BashInvocationError, match="non-positive timeout"):
        run_bash("true", cwd=str(tmp_path), timeout=budget)


# ---------------------------------------------------------------------------
# 5. The two Go failure postures
# ---------------------------------------------------------------------------


def test_checked_non_zero_exit_aborts_like_t_fatalf(tmp_path: Path) -> None:
    """check=True is the t.Fatalf posture, and the message carries the captured output."""
    with pytest.raises(BashInvocationError) as caught:
        run_bash(
            "echo diagnostic-line; exit 7",
            cwd=str(tmp_path),
            requirement="F-008-RQ-001",
        )

    message = str(caught.value)
    assert "exit status 7" in message
    assert "diagnostic-line" in message
    assert "F-008-RQ-001" in message


def test_tolerated_non_zero_exit_is_data_like_the_v8_scenarios_need(tmp_path: Path) -> None:
    """check=False must return the exit code, because F-008-RQ-001 asserts it is exactly 1."""
    result = run_bash(
        "echo out; echo err >&2; exit 1",
        cwd=str(tmp_path),
        check=False,
        merge_streams=False,
    )

    assert result.returncode == 1
    assert result.stdout.strip() == "out"
    assert result.stderr.strip() == "err"
    assert result.streams_merged is False


def test_merged_streams_reproduce_combined_output(tmp_path: Path) -> None:
    """MODE ONE merges the streams exactly as Go's CombinedOutput does."""
    result = run_bash("echo out; echo err >&2", cwd=str(tmp_path), merge_streams=True)

    assert result.stderr == ""
    assert result.streams_merged is True
    assert "out" in result.stdout
    assert "err" in result.stdout


def test_missing_script_is_reported_and_not_swallowed(tmp_path: Path) -> None:
    """A source chain naming a file that is not there must fail, not silently do nothing."""
    env_script = tmp_path / "kube-env"
    env_script.write_text("", encoding="utf-8")

    with pytest.raises(BashInvocationError, match="bash invocation failed"):
        must_invoke_func(
            "probe-func",
            env_script_path=env_script,
            script_names=[str(tmp_path / "absent.sh")],
            cwd=str(tmp_path),
        )


# ---------------------------------------------------------------------------
# 6. Isolation
# ---------------------------------------------------------------------------


def test_environment_overrides_never_reach_the_parent(tmp_path: Path) -> None:
    """A scenario that varies ETCD_APISERVER_ALLOW_INSECURE must not leak into the worker."""
    key = "BLITZY_BASH_HELPER_PROBE"
    assert key not in os.environ

    result = run_bash(f'echo "${key}"', cwd=str(tmp_path), env={key: "scenario-value"})

    assert result.stdout.strip() == "scenario-value"
    assert key not in os.environ, "the helper mutated os.environ, which breaks xdist isolation"


def test_working_directory_is_the_callers_choice_only(tmp_path: Path) -> None:
    """The helper derives no directory of its own, so a run cannot depend on where it started."""
    before = Path.cwd()

    result = run_bash("pwd", cwd=str(tmp_path))

    assert Path(result.stdout.strip()).resolve() == tmp_path.resolve()
    assert Path.cwd() == before
