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

"""Contract tests for the generated ``kube-env``: shell quoting, and template strictness.

Provenance: AAP §0.4.4.1 / §0.4.4.2 (the kube-env renderer and its Jinja/Go-template
subset are fixtures, so their behaviour must be provable on its own) / AAP §0.9.1.1
(the runner accepts pytest arguments, ``--basetemp`` among them, so the KUBE_HOME this
tier renders is externally influenced) / AAP §0.11.1 (no unsafe data-to-code path, and
evidence over assumption) / tech-spec §6.6.3.4 (provenance citation plus a named
invariant on every Blitzy-authored test).

INVARIANT LOCKED BY THIS MODULE, in two halves.

QUOTING. Every value substituted into a generated ``kube-env`` reaches bash as
EXACTLY ITSELF, one word, with no expansion and no statement boundary. The shell tier
writes a script and then has bash ``source`` it, so each ``readonly VAR={{.Field}}``
is a crossing from data into code: unquoted, a value with a space splits the
assignment and executes the rest, and one with ``$(…)``, a backtick or ``${…}`` is
EVALUATED. ``KubeHome`` comes from ``tmp_path``, hence from ``--basetemp``, so the
path is not this tier's to choose. The proof below is behavioural: each hostile value
is rendered, SOURCED BY REAL BASH, and the variable's value read back.

FIDELITY. Quoting must not have changed what the renderer writes for the values the
ported cases actually carry, because the same renderer renders the three SHIPPED
templates and its output has to match Go's ``text/template`` byte for byte. That is
asserted directly rather than assumed.

STRICTNESS. Two constructs Go rejects or renders differently must not be silently
accepted: an unmatched ``{{`` (Go: ``unclosed action``) and an argument-less
``{{template "name"}}`` (Go: a nil dot, so a bare ``{{.}}`` inside the invoked
template renders the literal ``<no value>``).

NOTHING HERE TOUCHES ``cluster/``. The shipped templates are read, never written; the
only files created are inside the test's own ``tmp_path``.
"""

# AAP §0.4.6 (the renderer is a fixture in python/tests/unit/shell/conftest.py) /
# AAP §0.8.1.1 (this module's own CREATE row, python/tests/unit/shell/test_*.py) /
# tech-spec §6.6.1.1 (the shell-boundary tier proves the shipped generator by
# invoking real bash, which is what makes a quoting claim checkable rather than
# argued).

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pytest

from tests.fixtures.etcd_env_cases import KubeAPIServerETCDEnv
from tests.helpers.bash import shell_quote
from tests.helpers.manifest import (
    BASE_TEMPLATE_RELATIVE_PATH,
    ETCD_TEMPLATE_RELATIVE_PATH,
    ETCD_TEMPLATE_TARGET,
    ManifestHarnessError,
)

if TYPE_CHECKING:
    from pathlib import Path

    from tests.unit.shell.conftest import BashInvoker, KubeEnvRenderFactory

# Real bash is invoked, and neither etcd nor an API server is needed, so `shell` is
# the only marker -- registered in python/pyproject.toml, which runs under
# `--strict-markers`.
pytestmark = pytest.mark.shell

#: Values that are ordinary text to a human and CODE to an unquoted bash assignment.
#:
#: Every entry was chosen for a distinct mechanism rather than for variety:
#:
#:   space                 word splitting -- `readonly V=a b` assigns "a" and then
#:                         tries to run `b`
#:   command substitution  `$(…)` and backticks are expanded inside an unquoted
#:                         assignment, so the value would be the OUTPUT of a command
#:   parameter expansion   `${HOME}` would be substituted, silently changing the value
#:   semicolon / newline   ends the assignment and begins a statement
#:   single and double     quote characters, which is where a naive `'…'` wrapper
#:   quotes                breaks and `shlex.quote`'s close-escape-reopen does not
#:   glob                  `*` would be pathname-expanded against the cwd
#:   comment marker        `#` at the start of a word begins a comment
_HOSTILE_VALUES: Final[tuple[tuple[str, str], ...]] = (
    ("space", "two words"),
    ("command-substitution", "before$(touch /tmp/blitzy-should-not-exist)after"),
    ("backticks", "before`id`after"),
    ("parameter-expansion", "value-${HOME}-end"),
    ("semicolon", "value;echo INJECTED"),
    ("newline", "first\necho INJECTED"),
    ("single-quote", "it's a value"),
    ("double-quote", 'say "hello"'),
    ("both-quotes", """mix'ed "quotes" here"""),
    ("glob", "*"),
    ("comment", "#not-a-comment"),
    ("ampersand", "value&echo INJECTED"),
    ("pipe", "value|echo INJECTED"),
    ("dollar-at", "$@"),
    ("empty", ""),
)

#: Values every ported case actually carries. All of them lie inside
#: ``shlex.quote``'s ``[A-Za-z0-9_@%+=:,./-]`` safe set, so the rendered text must be
#: byte-identical to Go's -- which is what keeps the renderer a faithful port while
#: the hostile values above are neutralised.
#:
#: ``/events#http://127.0.0.1:4002`` is deliberately ABSENT even though it appears in
#: the ported expectations: it is the SCRIPT's own default for
#: ``--etcd-servers-overrides`` (configure-kubeapiserver.sh line 75), never a value
#: this renderer writes. The Go table sets ``ETCDServersOverride`` to the plain
#: identifier ``ETCDServersOverrides`` (apiserver_etcd_test.go L60), so no rendered
#: value in this tier contains a ``#`` -- checked, not assumed.
_REAL_VALUES: Final[tuple[str, ...]] = (
    "/tmp/pytest-of-root/pytest-1/test_tls_flags_mtls_enabled_0",
    "https://127.0.0.1:2379",
    "http://127.0.0.1:2379",
    "CACertPath",
    "APIServerCertPath",
    "Zm9v",
    "false",
    "true",
    "etcd3",
    "application/vnd.kubernetes.protobuf",
    "1000",
)

#: How the value under test is read back out of the sourced script. `printf %s`
#: rather than `echo` so no trailing newline and no `-e`/`-n` interpretation can
#: alter what is compared.
_READ_BACK_SCRIPT: Final[str] = 'source "$1" ;printf %s "${ETCD_APISERVER_CA_CERT_PATH}"'


def _render_with_ca_cert_path(
    render_kube_env: KubeEnvRenderFactory,
    value: str,
) -> Path:
    """Render this tier's ``kube_env.j2`` with ``value`` as ``CACertPath``.

    ``CACertPath`` is the carrier because ``configure-etcd-params`` copies it
    verbatim into ``--etcd-cafile`` (configure-kubeapiserver.sh line 23) with no
    ``:-`` default and no validation, so it is the field whose value most directly
    becomes shell text. ``AllowInsecureEtcd`` is supplied because kube_env.j2's
    fourteenth variable has no counterpart in the Go struct and
    :meth:`KubeEnvRenderFactory.context` is its declared supplier.
    """
    __tracebackhide__ = True
    context = render_kube_env.context(
        KubeAPIServerETCDEnv(ca_cert_path=value),
        extra={"AllowInsecureEtcd": "false"},
    )
    return render_kube_env.write(
        render_kube_env.kube_env_j2_target,
        [render_kube_env.kube_env_j2],
        context,
    )


# ---------------------------------------------------------------------------
# F12: a hostile value crosses into bash as data, never as code
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [value for _, value in _HOSTILE_VALUES],
    ids=[case_id for case_id, _ in _HOSTILE_VALUES],
)
def test_a_hostile_value_sources_back_as_itself(
    value: str,
    render_kube_env: KubeEnvRenderFactory,
    bash_invoke: BashInvoker,
) -> None:
    """REAL BASH sources the generated script and the variable holds the literal value.

    This is the whole quoting claim, made behaviourally. A renderer that emitted the
    value unquoted would fail here in one of three visible ways: bash would report a
    syntax error (semicolon, newline, quote), the variable would hold the OUTPUT of a
    command (``$(…)``, backticks) or a substituted environment variable
    (``${HOME}``), or the assignment would split and the value would be truncated
    (space).

    ``printf %s`` reads it back rather than ``echo`` so that no trailing newline and
    no ``-e`` interpretation can stand in for a difference.
    """
    env_script = _render_with_ca_cert_path(render_kube_env, value)

    result = bash_invoke.run_bash(
        _READ_BACK_SCRIPT,
        argv=(str(env_script),),
        check=False,
        merge_streams=False,
        requirement="F-008-RQ-001",
    )

    assert result.returncode == 0, (
        f"sourcing the generated kube-env failed with exit {result.returncode}; an unquoted "
        f"value turns the assignment into syntax.\n  value: {value!r}\n"
        f"  stderr: {result.stderr!r}\n  script: {env_script}"
    )
    assert result.stdout == value, (
        f"the sourced value differs from what was rendered, so the value was INTERPRETED "
        f"rather than read.\n  rendered: {value!r}\n  sourced:  {result.stdout!r}\n"
        f"  script: {env_script}"
    )


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param("x$(touch {canary})y", id="command-substitution"),
        pytest.param("x`touch {canary}`y", id="backticks"),
        pytest.param("x;touch {canary}", id="semicolon"),
        pytest.param("x&&touch {canary}", id="and-list"),
        pytest.param("x|touch {canary}", id="pipeline"),
        pytest.param("x\ntouch {canary}", id="newline"),
        pytest.param("x$(echo $(touch {canary}))y", id="nested-substitution"),
    ],
)
def test_an_embedded_command_is_never_executed(
    payload: str,
    render_kube_env: KubeEnvRenderFactory,
    bash_invoke: BashInvoker,
    tmp_path: Path,
) -> None:
    """The strongest form of the claim: the side effect the payload asks for does NOT happen.

    Comparing strings proves the value was not replaced. This proves the command was
    not RUN, which is the part that matters on a CI worker. Each payload asks bash to
    create a file by a different mechanism -- substitution, a command list, a pipeline,
    a statement on the next line -- and the file must not exist after the generated
    script has been sourced.
    """
    canary = tmp_path / "embedded-command-ran"
    value = payload.format(canary=canary)
    env_script = _render_with_ca_cert_path(render_kube_env, value)

    result = bash_invoke.run_bash(
        _READ_BACK_SCRIPT,
        argv=(str(env_script),),
        check=False,
        merge_streams=False,
        requirement="F-008-RQ-001",
    )

    assert result.returncode == 0, (
        f"sourcing the generated kube-env failed: {result.stderr!r} (script {env_script})"
    )
    assert not canary.exists(), (
        f"{canary} was created, so the command embedded in the rendered value was EXECUTED "
        f"when the generated kube-env was sourced. Rendered value: {value!r}"
    )
    assert result.stdout == value, (
        f"the sourced value differs from what was rendered.\n  rendered: {value!r}\n"
        f"  sourced:  {result.stdout!r}"
    )


def test_the_rendered_assignment_is_syntactically_valid_bash(
    render_kube_env: KubeEnvRenderFactory,
    bash_invoke: BashInvoker,
) -> None:
    """``bash -n`` parses the generated script for every hostile value.

    A separate check from sourcing it, and a cheaper one: it catches the class of
    breakage where the file does not even parse, without depending on what the
    variable ends up holding.
    """
    for case_id, value in _HOSTILE_VALUES:
        env_script = _render_with_ca_cert_path(render_kube_env, value)
        result = bash_invoke.run_bash(
            'bash -n "$1"',
            argv=(str(env_script),),
            check=False,
            merge_streams=False,
            requirement="F-008-RQ-001",
        )
        assert result.returncode == 0, (
            f"the kube-env rendered for {case_id} does not parse as bash: {result.stderr!r}"
        )


# ---------------------------------------------------------------------------
# F12: and the quoting did not change what a real value renders to
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", _REAL_VALUES, ids=lambda value: value)
def test_a_real_value_is_rendered_unchanged(value: str) -> None:
    """Every value the ported cases carry passes through ``shell_quote`` untouched.

    This is what keeps the renderer a faithful port of Go's ``text/template``: the
    generated kube-env for every real case is byte-identical to the oracle's, so
    quoting cannot have introduced a difference where there was no hazard. It is
    asserted on the primitive rather than on a rendered file because that is where
    the property lives.
    """
    assert shell_quote(value) == value


def test_the_rendered_script_for_a_real_value_contains_the_bare_assignment(
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """End to end: a real path renders as ``readonly …=/the/path``, with no quotes added."""
    real = "/tmp/pytest-of-root/pytest-1/test_case_0"
    env_script = _render_with_ca_cert_path(render_kube_env, real)

    text = env_script.read_text(encoding="utf-8")

    assert f"readonly ETCD_APISERVER_CA_CERT_PATH={real}\n" in text, text


def test_a_hostile_value_is_visibly_quoted_in_the_generated_text(
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """The complement: where a hazard exists, the quoting is there to see in the file.

    Asserted so that a regression cannot pass by having made the behavioural test
    above vacuous -- for instance by rejecting the value instead of quoting it.
    """
    env_script = _render_with_ca_cert_path(render_kube_env, "two words")

    text = env_script.read_text(encoding="utf-8")

    assert "readonly ETCD_APISERVER_CA_CERT_PATH='two words'\n" in text, text


# ---------------------------------------------------------------------------
# F13: the renderer is as strict as Go's parser, and no stricter
# ---------------------------------------------------------------------------


def test_an_unmatched_opening_delimiter_is_refused(
    render_kube_env: KubeEnvRenderFactory,
    tmp_path: Path,
) -> None:
    """``{{`` with no ``}}`` is ``unclosed action`` to Go, so it must not render as text.

    Emitting the opener verbatim produced a kube-env that was missing the intended
    substitution AND carried ``{{`` inside a ``readonly`` assignment -- a template the
    oracle refuses outright, rendered without complaint, whose shell test then failed
    somewhere else entirely.
    """
    broken = tmp_path / "broken.template"
    broken.write_text("readonly KUBE_HOME={{.KubeHome\n", encoding="utf-8")

    with pytest.raises(ManifestHarnessError, match="unclosed action"):
        render_kube_env("broken.template", [broken], {"KubeHome": "/tmp/x"})


def test_a_stray_closing_delimiter_is_still_literal_text(
    render_kube_env: KubeEnvRenderFactory,
    tmp_path: Path,
) -> None:
    """``}}`` alone means nothing to Go's parser either, so refusing it would over-tighten.

    base.template ends with ``{{end}}}`` -- a real stray brace in a shipped artefact --
    so this is not a hypothetical: rejecting an unmatched closer would fail the oracle's
    own templates.
    """
    fine = tmp_path / "fine.template"
    fine.write_text("readonly A=1}}\nreadonly B={{.KubeHome}}\n", encoding="utf-8")

    rendered = render_kube_env("fine.template", [fine], {"KubeHome": "/tmp/x"})

    assert rendered == "readonly A=1}}\nreadonly B=/tmp/x\n"


def test_an_argument_less_template_invocation_is_refused(
    render_kube_env: KubeEnvRenderFactory,
    tmp_path: Path,
) -> None:
    """``{{template "name"}}`` is refused rather than given the current dot.

    Go renders it with a NIL dot, so a bare ``{{.}}`` inside the invoked template
    yields the literal ``<no value>`` -- which in base.template's body would put that
    text into ``readonly KUBE_HOME=``. Passing the current dot instead is a different
    program that succeeds against data Go never supplied, so the two renderers would
    disagree while both reported success. No shipped template uses the form.
    """
    template = tmp_path / "invoke.template"
    template.write_text(
        '{{define "inner"}}readonly KUBE_HOME={{.}}\n{{end}}{{template "inner"}}',
        encoding="utf-8",
    )

    with pytest.raises(ManifestHarnessError, match="NO argument"):
        render_kube_env("invoke.template", [template], {"KubeHome": "/tmp/x"})


def test_an_explicit_dot_argument_is_still_accepted(
    render_kube_env: KubeEnvRenderFactory,
    tmp_path: Path,
) -> None:
    """``{{template "name" .}}`` and ``{{template "name" .Field}}`` both keep working.

    The refusal above must be confined to the argument-less form: the shipped trio
    invokes ``{{ template "base" .KubeHome }}``, and rejecting that would empty the
    whole L1 tier.
    """
    template = tmp_path / "invoke.template"
    template.write_text(
        '{{define "inner"}}readonly KUBE_HOME={{.}}\n{{end}}{{template "inner" .KubeHome}}',
        encoding="utf-8",
    )

    rendered = render_kube_env("invoke.template", [template], {"KubeHome": "/tmp/x"})

    assert rendered == "readonly KUBE_HOME=/tmp/x\n"


def test_the_three_shipped_templates_still_parse_and_render(
    render_kube_env: KubeEnvRenderFactory,
    kube_home: Path,
) -> None:
    """The strictness changes must not have touched the artefacts that actually ship.

    ``etcd.template`` invokes ``base`` with an explicit argument and its own text
    contains no unmatched delimiter, so both refusals above must leave it alone. This
    is the regression guard for the two changes, expressed against the real files
    rather than against a fixture copy of them.
    """
    context = render_kube_env.context(KubeAPIServerETCDEnv(ca_cert_path="CACertPath"))

    rendered = render_kube_env(
        ETCD_TEMPLATE_TARGET,
        (BASE_TEMPLATE_RELATIVE_PATH, ETCD_TEMPLATE_RELATIVE_PATH),
        context,
    )

    assert f"readonly KUBE_HOME={kube_home}\n" in rendered
    assert "readonly ETCD_APISERVER_CA_CERT_PATH=CACertPath\n" in rendered
