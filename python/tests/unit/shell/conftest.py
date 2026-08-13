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

"""Fixture root of the L1 shell-boundary and L4 fail-closed tiers.

AAP §0.4.4.1 (the conftest hierarchy: "python/tests/unit/shell/conftest.py --
``kube_home``, ``render_kube_env``, ``manifest_case`` ... and ``bash_invoke``") /
§0.5.1 (this file's CREATE row, source cluster/gce/gci/configure_helper_test.go)
/ §0.4.2.1 (the five L1 and L4 blueprints these fixtures serve) /
tech-spec §6.6.1.1, which records the property the whole tier exists to
preserve: the test "proves the shipped shell generator, not a re-implementation".

INVARIANT LOCKED BY THIS FILE: every subprocess of this tier runs the SHIPPED
bash from ``cluster/gce/gci`` with that directory as its working directory, from
a ``KUBE_HOME`` this test alone owns, with a ``kube-env`` rendered from the
SHIPPED templates by a renderer that reproduces Go's ``text/template`` output
byte for byte. Nothing here asserts anything about controls V1 to V8; everything
here decides what the five modules that DO assert are handed.

WHAT THIS FILE PORTS, AND FROM WHERE

    Go primitive (cluster/gce/gci/)                 Fixture or member here
    ----------------------------------------------  -------------------------
    os.Getwd() as `go test`'s working directory     gci_cwd
    os.MkdirTemp + manifestSources/Destination      kube_home
    mustCreateEnv (configure_helper_test.go L125)   render_kube_env
    text/template ParseFiles + ExecuteTemplate      render_kube_env.__call__
    newManifestTestCase (L50-80) + tearDown (L155)  manifest_case
    mustInvokeFunc (L108-123)                       ShellManifestCase.invoke_func
    mustLoadPodFromManifest (L144-153)              ShellManifestCase.load_pod...
    exec.Command("bash", "-c", ...) + CombinedOutput bash_invoke

``configure_helper_test.go`` contains ZERO test functions: it is a pure harness
imported by every test in its package, so nothing in this file is a ported test
-- it is a ported FIXTURE, and the five sibling modules of tests/unit/shell/
stand to it exactly as that package's tests stand to their harness.

THE WORKING DIRECTORY IS A CONTRACT, NOT A CONVENIENCE

Every invocation runs with ``cwd`` = ``<repo_root>/cluster/gce/gci``, for two
independent reasons, either sufficient:

* ``mustInvokeFunc`` sources its scripts by BARE RELATIVE NAME --
  ``source "configure-helper.sh"`` -- so any other working directory fails to
  source them;
* the consumers name the kube-env templates relatively too --
  ``"testdata/kube-apiserver/base.template"`` -- and Go's ``ParseFiles``
  resolves those against the same directory.

:func:`gci_cwd` is that directory, derived from the session ``repo_root``
fixture, and :func:`manifest_case` and :func:`bash_invoke` default to it so no
call site has to remember.

TWO TEMPLATE ROOTS, AND THEY ARE DIFFERENT DIRECTORIES

* ``<repo>/cluster/gce/manifests`` holds ``kube-apiserver.manifest``, the POD
  manifest copied into ``KUBE_HOME``. Go reaches it as
  ``filepath.Join(filepath.Dir(os.Getwd()), "manifests")``, climbing to
  ``cluster/gce`` FIRST -- so it is emphatically not ``cluster/gce/gci/manifests``,
  which does not exist.
* ``<repo>/cluster/gce/gci/testdata/kube-apiserver`` holds the trio
  ``base.template``, ``etcd.template`` and ``kms.template`` that render
  ``kube-env``.

Neither root is computed here: ``tests.helpers.manifest`` derives both from a
caller-supplied ``repo_root`` (``gci_package_dir`` and
``pod_manifest_template_dir``), so there is exactly one derivation of each in
the tree and conflating them is not possible from this file.

THE FOUR SHIPPED ARTIFACTS ARE READ, NEVER COPIED AND NEVER WRITTEN

``cluster/gce/manifests/kube-apiserver.manifest`` and the three
``testdata/kube-apiserver/*.template`` files are read-only inputs. Nothing here
writes anything under ``cluster/``, and no ``.template`` file is reproduced
under ``python/``: a duplicate would drift from the artifact this repository
ships while both copies kept passing, and ``testdata`` is one of
``skipped_names`` in hack/boilerplate/boilerplate.py, so a copy under python/
would be header-gated when the original is not. The same rule covers the
scripts: ``configure-helper.sh`` and ``configure-kubeapiserver.sh`` are invoked,
never edited and never rewritten in Python.

WHY THE TEMPLATE LANGUAGE IS IMPLEMENTED HERE, WITH THE STANDARD LIBRARY

``tests.helpers.manifest`` deliberately owns no template language: it publishes
the :class:`~tests.helpers.manifest.KubeEnvRenderer` Protocol and states that
the implementation is this file's ``render_kube_env``. There is no third-party
engine to delegate to either -- ``jinja2`` is absent from the eighteen exact
pins in python/requirements-test.txt, and
tests/fixtures/templates/kube_env.j2 says so itself and uses Go ``{{.Field}}``
syntax despite its extension. So :func:`_execute_template` below is a strict
subset of Go's ``text/template``, covering exactly the five constructs the four
templates use: ``{{define "name"}}...{{end}}``,
``{{template "name" .Field}}``, ``{{.Field}}``, the bare ``{{.}}`` and
``{{if .Field}}...{{end}}``. Anything else RAISES rather than rendering
something plausible.

It was validated by DIFFERENTIAL TESTING against Go itself rather than by
inspection: a golden renderer built with the repository's own go1.25.4 toolchain
and this implementation produce byte-identical output for ``etcd.template``,
``kms.template`` with the KMS block on and off, ``base.template`` as its own
target, and ``kube_env.j2``. Three semantics that make that possible are worth
naming, because each is easy to "tidy" into a mismatch:

* NO WHITESPACE TRIMMING. Go trims only for the explicit ``{{- -}}`` forms,
  which none of these templates uses, so the newline after every action and
  inside every ``{{if}}`` body survives verbatim.
* ``ParseFiles`` names each file's template after its BASE FILENAME and REMOVES
  the ``{{define}}`` bodies from it. That is why rendering ``base.template`` as
  its own target yields only the stray ``}`` that follows its ``{{end}}``.
* Go truthiness for ``{{if}}``: ``false``, the empty string, zero and an empty
  container are false. A bool must therefore reach the renderer AS a bool --
  ``kms.template`` guards a block with ``{{if .CloudKMSIntegration}}``, and the
  string "False" is non-empty and would render the block a false flag must omit.

A VERIFIED BEHAVIOUR THAT LOOKS LIKE A BUG, AND MUST BE LEFT ALONE

The clauses are joined with ``;`` and there is NO ``set -e``, exactly as
``mustInvokeFunc`` builds them. One consequence is measured and load-bearing:
``test_audit_policy.py`` renders ``base.template`` as its own target, so its
``kube-env`` is the two-byte fragment ``}\\n`` plus a newline. Sourcing that
prints ``syntax error near unexpected token `}'`` and ``source`` alone returns
2 -- yet the outer ``bash -c`` returns 0, because ``;`` composition yields the
LAST command's status, and ``create-master-audit-policy`` still writes its
valid 187-line, 18-rule policy. So: judge success on the FINAL command's exit
status, which is what the ``CombinedOutput``-style posture of
``tests.helpers.bash`` already does, and never filter, assert on, or fail
because of that stderr noise. Do not "fix" it with ``set -e`` or ``&&``; either
would turn a passing oracle case into a failure that says nothing about the
control under test.

WHAT THIS FILE DELIBERATELY DOES NOT DO

* It runs no subprocess itself. ``tests.helpers.bash`` is the single boundary at
  which this tier meets ``bash`` and owns the timeout, the environment copy, the
  stream handling and the two failure postures; :class:`BashInvoker` only binds
  the working directory and the one seam that module has no signature for -- a
  shell function invoked WITH arguments, which the audit-policy case needs.
* It redefines no session fixture. python/tests/conftest.py owns ``repo_root``,
  ``etcd_binary``, ``apiserver_binary``, ``shared_etcd`` and
  ``parity_baseline``; this file consumes ``repo_root`` and nothing else, so no
  tier can get two different answers to the same question. It asks for no etcd
  and no API server, because this tier needs neither -- ``pytest -m "not
  integration"`` must run all of it.
* It registers no marker and adds no collection hook. python/pyproject.toml
  declares exactly ``integration``, ``shell``, ``config``, ``parity`` and
  ``slow`` with ``--strict-markers``, and the tier's modules declare
  ``pytestmark = pytest.mark.shell`` themselves.
* It defaults, sanitises and injects NOTHING into the environment the shipped
  script sees. ``TestTLSFlags``'s "mTLS disabled" case renders its ``kube-env``
  from an empty environment and expects the PLAINTEXT endpoint, which is
  reachable only because ``configure-etcd-params`` carries a function-local
  ``:-true`` compatibility shim for direct unit-test invocation, while the L4
  module proves the same absent-credential condition exits 1 in the deployment
  path. Both truths must hold at once; one helpful default here would quietly
  break the first.
* It holds no shared mutable state. Every fixture below is function-scoped and
  rooted in ``tmp_path`` except :func:`gci_cwd`, which is an immutable path.
  Python offers no ``-race`` and no ``goleak`` analogue, so isolation has to be
  structural: that is what makes this tier honest under ``pytest-randomly`` and
  safe under ``pytest-xdist -n auto``.
* It contains no key material. Every credential-shaped value in this tier is a
  placeholder echoing its own field name, exactly as the Go tables write them,
  because the shipped script only tests those variables for emptiness.

WHY EVERY FIXTURE OF THIS TIER LIVES HERE AND NOT IN A TEST MODULE

Under ``--doctest-modules`` a module-, package- or session-scoped autouse
fixture declared inline in a test module can execute TWICE. That flag is absent
from ``addopts`` today and its omission is recorded there as deliberate, but a
fixture that lays out a ``KUBE_HOME`` and runs a generator is not something to
leave one command-line flag away from running twice.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeAlias

import pytest

from tests.fixtures.etcd_env_cases import (
    KubeAPIServerEnv,
    KubeAPIServerETCDEnv,
    TemplateContext,
)

# Imported as a MODULE rather than as four names, so that
# ``bash.must_invoke_func`` and :meth:`BashInvoker.must_invoke_func` can never be
# confused for one another at a call site inside this file.
from tests.helpers import bash
from tests.helpers.manifest import (
    ENV_SCRIPT_FILE_NAME,
    MANIFEST_DESTINATION_RELATIVE_PATH,
    MANIFEST_SOURCES_RELATIVE_PATH,
    TEMP_DIR_PREFIX,
    KubeEnvRenderer,
    ManifestHarnessError,
    ManifestTestCase,
    PodManifest,
    gci_package_dir,
    run_as_user,
)

__all__ = [
    "KUBE_ENV_J2_RELATIVE_PATH",
    "KUBE_ENV_J2_TARGET",
    "BashInvoker",
    "KubeEnvRenderFactory",
    "ManifestCaseFactory",
    "ShellManifestCase",
    "bash_invoke",
    "gci_cwd",
    "kube_home",
    "manifest_case",
    "render_kube_env",
]

# ---------------------------------------------------------------------------
# The one template that is NOT shipped under cluster/
# ---------------------------------------------------------------------------
# tests/fixtures/templates/kube_env.j2 is the L4 fail-closed environment. It
# exists because ETCD_APISERVER_ALLOW_INSECURE -- the variable that selects
# between the plaintext-with-WARNING branch and the exit-1 branch -- appears in
# none of the three shipped templates, so no combination of them can express the
# four fail-closed scenarios. Held as path SEGMENTS relative to the repository
# root, and resolved from the ``repo_root`` fixture like every other path here.
KUBE_ENV_J2_RELATIVE_PATH: Final[tuple[str, ...]] = (
    "python",
    "tests",
    "fixtures",
    "templates",
    "kube_env.j2",
)

# Its render TARGET, which is a template NAME and therefore its base filename:
# Go's ParseFiles names each parsed template that way, and the file defines no
# inner template, so its whole body IS the template.
KUBE_ENV_J2_TARGET: Final[str] = "kube_env.j2"


# ---------------------------------------------------------------------------
# A strict subset of Go's text/template, on the standard library alone
# ---------------------------------------------------------------------------
# Validated by differential testing against go1.25.4, not by inspection -- see
# the module docstring. Five constructs, because the four templates use five;
# anything else raises. An unsupported action that rendered as empty text would
# produce a kube-env missing a `readonly` line, and the shell test would then
# fail for a reason unrelated to the control it was written to check.

#: One ``{{ ... }}`` action. Non-greedy so adjacent actions on one line stay
#: separate, and DOTALL so an action broken across lines is still one action.
_ACTION_PATTERN: Final[re.Pattern[str]] = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)

#: ``template "name"`` with an optional argument expression after it.
_INVOCATION_PATTERN: Final[re.Pattern[str]] = re.compile(r'\Atemplate\s+"([^"]+)"\s*(\S*)\Z')

#: ``define "name"``.
_DEFINITION_PATTERN: Final[re.Pattern[str]] = re.compile(r'\Adefine\s+"([^"]+)"\Z')

#: ``if <expression>``.
_CONDITIONAL_PATTERN: Final[re.Pattern[str]] = re.compile(r"\Aif\s+(\S+)\Z")

#: The action that closes a ``define`` or an ``if``.
_END_ACTION: Final[str] = "end"


@dataclass(frozen=True)
class _Literal:
    """Text outside any action, emitted verbatim including every newline."""

    text: str


@dataclass(frozen=True)
class _Substitution:
    """``{{.Field}}``, or the bare ``{{.}}`` when ``path`` is empty."""

    path: tuple[str, ...]
    action: str


@dataclass(frozen=True)
class _Invocation:
    """``{{template "name" .Field}}``: render an associated template.

    ``argument`` is ``None`` for ``{{template "name"}}``, which Go renders with a
    nil dot, and an empty tuple for ``{{template "name" .}}``, which passes the
    whole dot. The shipped trio uses ``{{ template "base" .KubeHome }}``, whose
    argument is a STRING -- which is why ``base.template`` dereferences the bare
    ``{{.}}`` for ``readonly KUBE_HOME=``.
    """

    name: str
    argument: tuple[str, ...] | None
    action: str


@dataclass(frozen=True)
class _Conditional:
    """``{{if .Field}}...{{end}}``, evaluated with Go's truthiness."""

    path: tuple[str, ...]
    body: tuple[_Node, ...]
    action: str


#: One parsed node of a template body.
_Node: TypeAlias = _Literal | _Substitution | _Invocation | _Conditional

#: A parse set: template NAME to parsed body. Populated exactly as Go's
#: ``ParseFiles`` populates one -- every file contributes its own body under its
#: base filename, plus one entry per ``{{define}}`` it carries.
_TemplateSet: TypeAlias = dict[str, tuple[_Node, ...]]


def _parse_field_expression(expression: str, *, origin: str, action: str) -> tuple[str, ...]:
    """Parse ``.``, ``.Field`` or ``.Outer.Inner`` into a lookup path.

    Returns the empty tuple for the bare ``.``, which addresses the dot itself.

    Raises:
        ManifestHarnessError: for anything else -- a variable (``$x``), a
            function call, a literal or a pipeline. Those are valid Go template
            syntax that this subset does not implement, and rendering them as
            empty text would silently drop an assignment.
    """
    __tracebackhide__ = True
    if expression == ".":
        return ()
    if not expression.startswith(".") or expression.endswith("."):
        raise ManifestHarnessError(
            f"unsupported template expression {expression!r} in action {{{{{action}}}}} of "
            f"{origin}. This renderer implements the strict subset the shipped templates use: "
            "a field reference such as '.KubeHome' or the bare dot '.'. Variables, pipelines, "
            "function calls and literals are deliberately not implemented, because rendering "
            "one as empty text would silently omit a readonly assignment."
        )
    segments = tuple(expression[1:].split("."))
    for segment in segments:
        if not segment.isidentifier():
            raise ManifestHarnessError(
                f"invalid field name {segment!r} in action {{{{{action}}}}} of {origin}: the "
                "shipped templates dereference exported Go identifiers such as "
                "'.EncryptionProviderConfigPath'."
            )
    return segments


def _tokenize(text: str) -> list[tuple[bool, str]]:
    """Split template text into ``(is_action, payload)`` tokens, in order.

    Literal runs keep every byte, including the newlines around each action:
    Go trims whitespace only for the explicit ``{{- -}}`` forms, which none of
    these templates uses, and a renderer that trimmed would differ from the
    oracle on every line.
    """
    tokens: list[tuple[bool, str]] = []
    position = 0
    for match in _ACTION_PATTERN.finditer(text):
        if match.start() > position:
            tokens.append((False, text[position : match.start()]))
        tokens.append((True, match.group(1).strip()))
        position = match.end()
    if position < len(text):
        tokens.append((False, text[position:]))
    return tokens


def _parse_nodes(
    tokens: Sequence[tuple[bool, str]],
    index: int,
    *,
    origin: str,
    terminated: bool,
) -> tuple[tuple[_Node, ...], int, _TemplateSet]:
    """Parse tokens into nodes until the end of input or a matching ``{{end}}``.

    Args:
        tokens: The token stream from :func:`_tokenize`.
        index: Where to start.
        origin: The file being parsed, for error messages.
        terminated: True while parsing the body of a ``define`` or an ``if``, so
            that ``{{end}}`` closes this level instead of being an error.

    Returns:
        ``(nodes, next_index, definitions)``. Definitions are returned rather
        than nested, because Go hoists every ``{{define}}`` into the parse set
        and REMOVES it from the body of the file that carried it.

    Raises:
        ManifestHarnessError: on an unsupported or unbalanced action.
    """
    __tracebackhide__ = True
    nodes: list[_Node] = []
    definitions: _TemplateSet = {}

    while index < len(tokens):
        is_action, payload = tokens[index]
        if not is_action:
            nodes.append(_Literal(payload))
            index += 1
            continue

        if payload == _END_ACTION:
            if terminated:
                return tuple(nodes), index + 1, definitions
            raise ManifestHarnessError(
                f"unexpected {{{{end}}}} in {origin}: it closes no 'define' or 'if' block."
            )

        definition = _DEFINITION_PATTERN.match(payload)
        if definition is not None:
            if terminated:
                raise ManifestHarnessError(
                    f"nested {{{{{payload}}}}} in {origin}: Go rejects a define inside another "
                    "block, and so does this renderer. base.template declares its 'base' "
                    "template at the top level of the file."
                )
            body, index, nested = _parse_nodes(
                tokens, index + 1, origin=origin, terminated=True
            )
            definitions.update(nested)
            definitions[definition.group(1)] = body
            continue

        conditional = _CONDITIONAL_PATTERN.match(payload)
        if conditional is not None:
            path = _parse_field_expression(
                conditional.group(1), origin=origin, action=payload
            )
            body, index, nested = _parse_nodes(
                tokens, index + 1, origin=origin, terminated=True
            )
            definitions.update(nested)
            nodes.append(_Conditional(path, body, payload))
            continue

        invocation = _INVOCATION_PATTERN.match(payload)
        if invocation is not None:
            expression = invocation.group(2)
            argument = (
                _parse_field_expression(expression, origin=origin, action=payload)
                if expression
                else None
            )
            nodes.append(_Invocation(invocation.group(1), argument, payload))
            index += 1
            continue

        if payload.startswith(("else", "range ", "with ", "block ", "define ", "template ")):
            raise ManifestHarnessError(
                f"unsupported action {{{{{payload}}}}} in {origin}. This renderer implements "
                "define, template, if, a field reference and the bare dot -- the five "
                "constructs the shipped templates use -- and refuses the rest loudly rather "
                "than rendering something plausible."
            )

        nodes.append(_Substitution(_parse_field_expression(payload, origin=origin, action=payload), payload))
        index += 1

    if terminated:
        raise ManifestHarnessError(
            f"unbalanced template block in {origin}: a 'define' or 'if' is missing its "
            "{{end}}."
        )
    return tuple(nodes), index, definitions


def _parse_template_files(paths: Sequence[Path]) -> _TemplateSet:
    """Parse files into one associated set, as ``template.ParseFiles`` does.

    Each file contributes its own body under its BASE FILENAME -- which is what
    makes ``"etcd.template"`` a usable render target -- plus one entry per
    ``{{define}}`` it carries. A later file wins a name clash, exactly as Go's
    parse set behaves, so listing ``base.template`` first (as every consumer
    does) leaves its ``base`` definition available to the templates that invoke
    it.

    Raises:
        ManifestHarnessError: if a file cannot be read or cannot be parsed.
    """
    __tracebackhide__ = True
    templates: _TemplateSet = {}
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to read the kube-env template {path}: {exc}"
            ) from exc
        nodes, _, definitions = _parse_nodes(
            _tokenize(text), 0, origin=os.fspath(path), terminated=False
        )
        templates.update(definitions)
        templates[path.name] = nodes
    return templates


def _lookup(dot: object, path: Sequence[str], *, action: str) -> object:
    """Resolve a field path against the current dot.

    Raises:
        ManifestHarnessError: if a segment is missing, or if the dot is not a
            mapping. Go reports both as template errors when the data is a
            struct; with a map it would print "<no value>" instead, which would
            put that literal text into a ``readonly`` assignment and leave the
            shell test failing for an unrelated-looking reason. Raising names the
            missing key instead.
    """
    __tracebackhide__ = True
    cursor = dot
    for segment in path:
        if not isinstance(cursor, Mapping):
            raise ManifestHarnessError(
                f"cannot evaluate field {segment!r} of action {{{{{action}}}}}: the render "
                f"context at that point is {type(cursor).__name__}, not a mapping. Note that "
                "'{{ template \"base\" .KubeHome }}' sets the dot to a STRING, so only the bare "
                "'{{.}}' is valid inside base.template."
            )
        if segment not in cursor:
            raise ManifestHarnessError(
                f"the render context has no key {segment!r}, required by action "
                f"{{{{{action}}}}}. Available keys: {sorted(cursor)}. Build the context from "
                "KubeAPIServerETCDEnv.to_template_context() or its KMS sibling, whose keys are "
                "the exact Go identifiers the shipped templates dereference."
            )
        cursor = cursor[segment]
    return cursor


def _format_value(value: object, *, action: str) -> str:
    """Format one value the way Go's template output does.

    A bool renders as the LOWERCASE ``true``/``false`` Go prints, which is
    load-bearing: tests/fixtures/templates/kube_env.j2 must emit the literal
    ``false`` for ``readonly ETCD_APISERVER_ALLOW_INSECURE=``, because
    ``configure-kubeapiserver.sh`` reads it as
    ``${ETCD_APISERVER_ALLOW_INSECURE:-true}`` and bash substitutes that default
    for an empty value as well as an unset one -- so anything but ``false``
    selects the permissive branch.

    Raises:
        ManifestHarnessError: for ``None`` and for any type the shipped
            templates never carry. Go would render a nil map value as the literal
            "<no value>"; refusing is better than writing that into a
            ``readonly`` line.
    """
    __tracebackhide__ = True
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    raise ManifestHarnessError(
        f"cannot render {value!r} ({type(value).__name__}) for action {{{{{action}}}}}: a "
        "kube-env assignment carries a string, or a bool for a '{{if}}' guard. None in "
        "particular is refused, because Go would emit the literal '<no value>' into the "
        "generated script; pass an empty string for an absent value, which is what the "
        "shipped templates and the script's own -z tests expect."
    )


def _is_true(value: object, *, action: str) -> bool:
    """Apply Go's ``{{if}}`` truthiness.

    False for ``false``, the empty string, zero and an empty container; true
    otherwise. The distinction matters for ``kms.template``, which guards its
    ``CLOUD_KMS_INTEGRATION`` and ``ENCRYPTION_PROVIDER_CONFIG`` blocks this way.

    Raises:
        ManifestHarnessError: for a type Go's ``isTrue`` cannot evaluate.
    """
    __tracebackhide__ = True
    if isinstance(value, bool):
        return value
    if isinstance(value, (str, bytes, list, tuple, dict, set, frozenset)):
        return len(value) > 0
    if isinstance(value, (int, float)):
        return value != 0
    raise ManifestHarnessError(
        f"cannot evaluate {value!r} ({type(value).__name__}) as the condition of action "
        f"{{{{{action}}}}}: Go's template truthiness covers bools, strings, numbers and "
        "containers, and this renderer refuses anything else rather than guessing."
    )


def _render_nodes(nodes: Sequence[_Node], dot: object, templates: _TemplateSet) -> str:
    """Render parsed nodes with ``dot`` as the current data."""
    __tracebackhide__ = True
    chunks: list[str] = []
    for node in nodes:
        if isinstance(node, _Literal):
            chunks.append(node.text)
        elif isinstance(node, _Substitution):
            chunks.append(
                _format_value(_lookup(dot, node.path, action=node.action), action=node.action)
            )
        elif isinstance(node, _Conditional):
            condition = _lookup(dot, node.path, action=node.action)
            if _is_true(condition, action=node.action):
                chunks.append(_render_nodes(node.body, dot, templates))
        else:
            if node.name not in templates:
                raise ManifestHarnessError(
                    f"action {{{{{node.action}}}}} invokes template {node.name!r}, which is not "
                    f"in the parse set. Available: {sorted(templates)}. Pass every template file "
                    "the target depends on -- base.template first, since etcd.template and "
                    "kms.template both invoke the 'base' template it defines."
                )
            inner_dot = (
                dot if node.argument is None else _lookup(dot, node.argument, action=node.action)
            )
            chunks.append(_render_nodes(templates[node.name], inner_dot, templates))
    return "".join(chunks)


def _execute_template(
    target: str,
    templates: Sequence[Path],
    context: Mapping[str, object],
) -> str:
    """Parse ``templates`` and render ``target``, the port of Go's two-step render.

    Ports ``template.ParseFiles(templates...)`` followed by
    ``t.ExecuteTemplate(f, target, env)`` (configure_helper_test.go L132-139).
    ``target`` is a template NAME and ``templates`` are FILE PATHS: the two are
    different kinds of string, and keeping them apart is what lets
    ``base.template`` be parsed without ever being the target.

    Raises:
        ManifestHarnessError: if a file cannot be read or parsed, if ``target``
            is not in the parse set, or if rendering hits an unsupported
            construct, a missing key or an unrenderable value.
    """
    __tracebackhide__ = True
    parse_set = _parse_template_files(templates)
    if target not in parse_set:
        raise ManifestHarnessError(
            f"no template named {target!r} was parsed from "
            f"{[os.fspath(path) for path in templates]}; the parse set holds "
            f"{sorted(parse_set)}. A target is a template NAME -- the base filename of a "
            "parsed file, or the name of a '{{define}}' one of them carries."
        )
    return _render_nodes(parse_set[target], context, parse_set)


# ---------------------------------------------------------------------------
# render_kube_env: the mustCreateEnv port and the tier's KubeEnvRenderer
# ---------------------------------------------------------------------------


class KubeEnvRenderFactory:
    """Builds render contexts, renders ``kube-env`` and writes it into ``KUBE_HOME``.

    The port of ``mustCreateEnv`` (cluster/gce/gci/configure_helper_test.go
    L125-142) and, at the same time, the one implementation of
    :class:`~tests.helpers.manifest.KubeEnvRenderer` in this repository -- that
    Protocol names this fixture as its implementation, and that module owns no
    template language precisely so there is only one.

    THE TWO ENTRY POINTS ARE NOT INTERCHANGEABLE, and the split is the Protocol's:

    * :meth:`__call__` RENDERS AND RETURNS TEXT, writing nothing. That is what
      the Protocol requires, because
      :meth:`tests.helpers.manifest.ManifestTestCase.create_env` writes the
      returned text itself through ``write_env_script`` -- into ITS ``KUBE_HOME``,
      which for a case built by :func:`manifest_case` is not the one this factory
      is bound to. A ``__call__`` that also wrote would write to the wrong
      directory and then be written again to the right one.
    * :meth:`write` renders AND writes, and returns the PATH. That is what a
      caller with no manifest case needs -- the L4 fail-closed module, which
      renders tests/fixtures/templates/kube_env.j2 and then hands the path
      straight to ``bash_invoke``.

    Bound to the ``kube_home`` fixture and to ``gci_cwd``: relative template
    names resolve against the latter, so the strings the Go tests write
    (``"testdata/kube-apiserver/base.template"``) keep working unchanged.
    """

    def __init__(self, *, package_dir: Path, kube_home: Path, repo_root: Path) -> None:
        """Bind the working directory, the default ``KUBE_HOME`` and the repository root.

        Args:
            package_dir: ``<repo>/cluster/gce/gci``, the directory relative
                template names resolve against -- the ``gci_cwd`` fixture.
            kube_home: Default destination directory for :meth:`write` -- the
                ``kube_home`` fixture.
            repo_root: The repository root, used only to locate
                :attr:`kube_env_j2`.
        """
        self._package_dir: Final[Path] = package_dir
        self._kube_home: Final[Path] = kube_home
        self._repo_root: Final[Path] = repo_root

    @property
    def package_dir(self) -> Path:
        """``<repo>/cluster/gce/gci``: what relative template names resolve against."""
        return self._package_dir

    @property
    def kube_home(self) -> Path:
        """The default directory :meth:`write` writes ``kube-env`` into."""
        return self._kube_home

    @property
    def kube_env_j2(self) -> Path:
        """Absolute path of tests/fixtures/templates/kube_env.j2, the L4 environment.

        Exposed because the fail-closed module needs the file and must not
        rediscover where it lives: resolved from ``repo_root`` here, once, like
        every other path in this tier. Render it with :data:`KUBE_ENV_J2_TARGET`.

        Raises:
            ManifestHarnessError: if the file is missing, which means ``repo_root``
                is not a checkout that carries this test tier.
        """
        __tracebackhide__ = True
        candidate = self._repo_root.joinpath(*KUBE_ENV_J2_RELATIVE_PATH)
        if not candidate.is_file():
            raise ManifestHarnessError(
                f"the fail-closed kube-env template {candidate} does not exist. It is the only "
                "kube-env template not shipped under cluster/, and it is what makes "
                "ETCD_APISERVER_ALLOW_INSECURE expressible -- none of the three shipped "
                "templates carries that variable."
            )
        return candidate

    @property
    def kube_env_j2_target(self) -> str:
        """The render target for :attr:`kube_env_j2`, which is its base filename."""
        return KUBE_ENV_J2_TARGET

    def as_renderer(self) -> KubeEnvRenderer:
        """Return this factory typed as the Protocol ``tests.helpers.manifest`` consumes.

        A one-line, type-checked statement of the conformance
        :meth:`tests.helpers.manifest.ManifestTestCase.create_env` depends on, so
        that a change to :meth:`__call__`'s signature fails the type gate here --
        where the reason is obvious -- rather than at a call site that merely
        passes a renderer along.
        """
        return self

    def context(
        self,
        env: KubeAPIServerETCDEnv | KubeAPIServerEnv,
        *,
        kube_home: str | os.PathLike[str] | None = None,
        extra: Mapping[str, object] | None = None,
    ) -> TemplateContext:
        """Build a render context from a declared environment plus the run's own values.

        Ports the two assignments every Go consumer makes to its copy of the case
        struct immediately before rendering -- ``tc.env.KubeHome = c.kubeHome``
        and ``tc.env.KubeAPIServerRunAsUser = strconv.Itoa(os.Getuid())``
        (apiserver_etcd_test.go L73-74, L130-131, L195-196; apiserver_kms_test.go
        L74-79, L110-115) -- by delegating to the dataclass's own ``with_runtime``
        and ``to_template_context``. The keys are therefore the exact exported Go
        identifiers the shipped templates dereference, declared once in
        tests/fixtures/etcd_env_cases.py and never restated here.

        THIS METHOD IS THE DECLARED SUPPLIER OF ``AllowInsecureEtcd``, through
        ``extra``. tests/fixtures/templates/kube_env.j2 dereferences fourteen
        variables: thirteen that ``KubeAPIServerETCDEnv.to_template_context()``
        already produces, plus ``AllowInsecureEtcd``, which has NO counterpart in
        the sixteen-field Go struct and must not be given one -- that dataclass is
        a faithful mirror of ``kubeAPIServeETCDEnv`` and adding a seventeenth
        field would end that. So the fail-closed module passes
        ``extra={"AllowInsecureEtcd": "false"}`` and the mirror stays exact.

        ``extra`` is merged LAST and therefore wins, which also makes any single
        key overridable -- a case needing a uid other than the running one passes
        ``extra={"KubeAPIServerRunAsUser": "0"}`` rather than needing a parameter
        for it.

        Args:
            env: The declared environment: a
                :class:`~tests.fixtures.etcd_env_cases.KubeAPIServerETCDEnv` for
                ``etcd.template`` and for kube_env.j2, or a
                :class:`~tests.fixtures.etcd_env_cases.KubeAPIServerEnv` for
                ``kms.template``. Required, and not defaulted to an empty
                context: Go always renders from a struct, and an implicit empty
                environment would render a kube-env whose missing keys surface as
                render errors far from the call that caused them.
            kube_home: The ``KUBE_HOME`` to declare; defaults to
                :attr:`kube_home`. Pass a manifest case's own ``kube_home`` when
                rendering for one, since that is the tree the generator reads and
                writes.
            extra: Keys merged over the result, for a variable no Go struct
                carries.

        Returns:
            A fresh mutable mapping. Fresh on every call, because the case tables
            are module-level and frozen: handing back anything shared would let
            one test's KUBE_HOME reach the next.
        """
        home = self._kube_home if kube_home is None else Path(kube_home)
        context = env.with_runtime(os.fspath(home), run_as_user()).to_template_context()
        if extra:
            context.update(extra)
        return context

    def resolve_templates(
        self,
        templates: Sequence[str | os.PathLike[str]],
    ) -> tuple[Path, ...]:
        """Resolve template paths against :attr:`package_dir` and confirm each exists.

        Relative names resolve against the package directory, which is what
        ``template.ParseFiles`` does with the working directory of ``go test`` --
        so ``"testdata/kube-apiserver/etcd.template"`` keeps working verbatim. An
        absolute path is honoured as given, which is how :attr:`kube_env_j2`
        travels.

        Existence is checked HERE so a mistyped name is reported as a mistyped
        name, naming the directory that holds the shipped trio, rather than as
        whatever the parser happens to say about an empty file.

        Raises:
            ManifestHarnessError: if ``templates`` is empty or names a file that
                does not exist.
        """
        __tracebackhide__ = True
        if not templates:
            raise ManifestHarnessError(
                "no kube-env templates were given; at least one is required. The consumers pass "
                "'testdata/kube-apiserver/base.template' first, because etcd.template and "
                "kms.template both invoke the 'base' template it defines."
            )
        resolved: list[Path] = []
        for template in templates:
            candidate = Path(template)
            if not candidate.is_absolute():
                candidate = self._package_dir / candidate
            if not candidate.is_file():
                raise ManifestHarnessError(
                    f"kube-env template {candidate} does not exist. Relative names resolve "
                    f"against {self._package_dir}, where the shipped trio lives in "
                    "testdata/kube-apiserver/ as base.template, etcd.template and kms.template; "
                    "the fail-closed template is reached through the kube_env_j2 property."
                )
            resolved.append(candidate)
        return tuple(resolved)

    def __call__(
        self,
        target: str,
        templates: Sequence[str | os.PathLike[str]],
        context: Mapping[str, object],
        /,
    ) -> str:
        """Render ``target`` from ``templates`` with ``context``, and return the TEXT.

        The :class:`~tests.helpers.manifest.KubeEnvRenderer` implementation:
        three positional-only arguments, rendered text out, nothing written. See
        the class docstring for why writing here would be wrong.

        Raises:
            ManifestHarnessError: if ``target`` is blank, if a template is
                missing, or if parsing or rendering fails.
        """
        __tracebackhide__ = True
        if not target.strip():
            raise ManifestHarnessError(
                "target must name the template to render -- 'etcd.template', 'kms.template', "
                f"'base.template' or {KUBE_ENV_J2_TARGET!r} -- and it is a template NAME rather "
                f"than a path, got {target!r}."
            )
        return _execute_template(target, self.resolve_templates(templates), context)

    def write(
        self,
        target: str,
        templates: Sequence[str | os.PathLike[str]],
        context: Mapping[str, object],
        *,
        kube_home: str | os.PathLike[str] | None = None,
    ) -> Path:
        """Render ``target`` and write it to ``<kube_home>/kube-env``, returning the path.

        The complete ``mustCreateEnv`` port for a caller with no manifest case:
        Go creates ``filepath.Join(c.kubeHome, envScriptFileName)``, executes the
        template into it and returns ``f.Name()``, and so does this.

        Args:
            target: The template NAME to render.
            templates: The template FILES to parse, ``base.template`` first when
                the target invokes it.
            context: The render data; see :meth:`context`.
            kube_home: Destination directory, defaulting to :attr:`kube_home`.

        Returns:
            The path written, ``<kube_home>/kube-env``.

        Raises:
            ManifestHarnessError: if rendering fails, if the render is blank, if
                the destination directory does not exist, or if the write fails.
        """
        __tracebackhide__ = True
        rendered = self(target, templates, context)
        if not rendered.strip():
            # No legitimate target renders blank. Even the "mTLS disabled" case
            # renders every `readonly` line of etcd.template, with empty VALUES,
            # and base.template as its own target still yields the stray '}' that
            # follows its {{end}}. A blank file would leave KUBE_HOME unset for
            # the shipped generator, which then fails for an unrelated-looking
            # reason.
            raise ManifestHarnessError(
                f"rendering target {target!r} produced no content, so no {ENV_SCRIPT_FILE_NAME} "
                "was written: a blank environment would leave KUBE_HOME unset for the shipped "
                "generator. Note that an empty ENVIRONMENT still renders every assignment, with "
                "empty values."
            )
        home = self._kube_home if kube_home is None else Path(kube_home)
        if not home.is_dir():
            raise ManifestHarnessError(
                f"cannot write {ENV_SCRIPT_FILE_NAME}: {home} is not an existing directory. Pass "
                "a manifest case's kube_home, or omit the argument to use the kube_home fixture."
            )
        destination = home / ENV_SCRIPT_FILE_NAME
        try:
            destination.write_text(rendered, encoding="utf-8")
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to write the {ENV_SCRIPT_FILE_NAME} script to {destination}: {exc}"
            ) from exc
        return destination


# ---------------------------------------------------------------------------
# The one source-chain shape tests.helpers.bash has no signature for
# ---------------------------------------------------------------------------


def _chain_with_arguments(
    env_script_path: str | os.PathLike[str],
    script_names: Sequence[str | os.PathLike[str]],
    func_name: str,
    arguments: Sequence[str | os.PathLike[str]],
) -> tuple[str, tuple[str, ...]]:
    """Build the ``mustInvokeFunc`` source chain for a function called WITH arguments.

    ``tests.helpers.bash`` owns every other shape, and this one is composed here
    only because its public API has no signature for it: ``must_invoke_func``
    appends a BARE function name and rejects one carrying whitespace, so the Go
    audit shape ``create-master-audit-policy <policyFile>``
    (audit_policy_test.go L57) cannot be expressed as a function name -- and
    must not be, since that rejection is a real guard against a name that could
    terminate the source chain.

    The chain keeps the shape ``mustInvokeFunc`` builds -- a space before every
    ``;``, nothing between the clauses -- and extends the same principle bash.py
    already applies to paths: NOTHING TEST-SUPPLIED IS INTERPOLATED INTO THE
    SCRIPT TEXT. The function name and each argument travel as POSITIONAL
    PARAMETERS, so the text is::

        source "$1" ;source "$2" ;"$3" "$4"

    with ``$1`` the kube-env, ``$2`` the script, ``$3`` the function name and
    ``$4`` its argument. Measured: bash resolves ``"$3"`` as a command word and
    finds the sourced FUNCTION, and the invocation writes the expected
    187-line, 18-rule audit policy. Because a parameter is expanded exactly once
    to its literal value, no spelling of a path -- ``$(...)``, a backtick, an
    embedded quote -- can be re-parsed as shell code, which is strictly stronger
    than validating the name and interpolating it.

    Args:
        env_script_path: The rendered ``kube-env``, sourced first.
        script_names: Scripts to source, in order, after it. Relative names
            resolve against the caller's ``cwd``.
        func_name: The shell function to call.
        arguments: Positional arguments for the function, normally one path.

    Returns:
        ``(script, argv)`` ready for :func:`tests.helpers.bash.run_bash`.

    Raises:
        ManifestHarnessError: if ``func_name`` is blank -- bash would report
            "command not found" and exit 127, which is loud but says nothing
            about the function that was meant to run -- or if ``script_names`` is
            empty, which would leave nothing to define the function.
    """
    __tracebackhide__ = True
    if not func_name.strip():
        raise ManifestHarnessError(
            "refusing to invoke a blank shell function name: bash would source the scripts, "
            "report 'command not found' and exit 127, naming nothing useful."
        )
    if not script_names:
        raise ManifestHarnessError(
            f"script_names is empty, so nothing would define {func_name!r}. Pass the scripts to "
            "source, in order, because configure-kubeapiserver.sh calls functions defined by "
            "configure-helper.sh."
        )
    argv = [os.fspath(env_script_path), *(os.fspath(script) for script in script_names)]
    clauses = "".join(f'source "${index}" ;' for index in range(1, len(argv) + 1))
    argv.append(func_name)
    script = f'{clauses}"${len(argv)}"'
    for argument in arguments:
        argv.append(os.fspath(argument))
        script += f' "${len(argv)}"'
    return script, tuple(argv)


# ---------------------------------------------------------------------------
# manifest_case: newManifestTestCase, in both of its measured shapes
# ---------------------------------------------------------------------------


class ShellManifestCase:
    """One ``KUBE_HOME`` and the shipped generator run against it, in either shape.

    Wraps :class:`tests.helpers.manifest.ManifestTestCase` for the FULL shape and
    stands alone for the BARE one, presenting one surface either way so a test
    module never branches on which it holds.

    THE TWO SHAPES ARE BOTH IN THE ORACLE, which is why both are supported:

    * THE FULL SHAPE is ``newManifestTestCase(t, kubeAPIServerManifestFileName,
      kubeAPIServerStartFuncName, nil)`` (apiserver_etcd_test.go L71,
      apiserver_kms_test.go L71): it copies ``kube-apiserver.manifest`` out of
      ``cluster/gce/manifests`` into ``KUBE_HOME/kube-manifests/kubernetes/
      gci-trusty``, creates ``KUBE_HOME/etc/kubernetes/manifests`` for the
      generator's final ``cp``, and can therefore
      :meth:`load_pod_from_manifest`.
    * THE BARE SHAPE is the struct literal ``ManifestTestCase{t: t, kubeHome:
      baseDir, manifestFuncName: ...}`` (audit_policy_test.go L54-58). Only three
      fields are set, so ``mustCopyFromTemplate``, ``mustCopyAuxFromTemplate``
      and ``mustCreateManifestDstDir`` are never called and no manifest is ever
      loaded. ``create-master-audit-policy`` writes to a path it is GIVEN, so it
      needs neither directory, and forcing a manifest copy on that caller would
      make the port less faithful, not more convenient.

    A ``KUBE_HOME`` PER CASE, never shared, and removed on teardown whether the
    test passed or failed. Not tidiness: ``configure-kubeapiserver.sh`` rewrites
    the copied manifest IN PLACE with ``sed -i``, so a shared tree would let one
    case read what another left behind -- and a stale manifest at the destination
    could be loaded and asserted against even if this case's generator run never
    wrote one, which is a pass that proves nothing.
    """

    def __init__(
        self,
        *,
        func_name: str,
        kube_home: Path,
        package_dir: Path,
        renderer: KubeEnvRenderFactory,
        case: ManifestTestCase | None = None,
    ) -> None:
        """Bind one case. Built by :class:`ManifestCaseFactory`, not directly.

        Args:
            func_name: The shell function this case invokes. Ports
                ``manifestFuncName``.
            kube_home: The case's ``KUBE_HOME``; for the full shape this is the
                wrapped case's own directory.
            package_dir: ``<repo>/cluster/gce/gci``, the ``cwd`` of every
                invocation.
            renderer: The tier's ``render_kube_env``, used for the bare shape's
                environment and bound into the wrapped case for the full one.
            case: The wrapped harness for the full shape; ``None`` for the bare
                shape.
        """
        self._func_name: Final[str] = func_name
        self._kube_home: Final[Path] = kube_home
        self._package_dir: Final[Path] = package_dir
        self._renderer: Final[KubeEnvRenderFactory] = renderer
        self._case: Final[ManifestTestCase | None] = case

    @property
    def func_name(self) -> str:
        """The shell function this case invokes. Ports ``manifestFuncName``."""
        return self._func_name

    @property
    def kube_home(self) -> Path:
        """The case's ``KUBE_HOME``. Ports the ``kubeHome`` field.

        Put into the render context as ``KubeHome`` so the generator reads and
        writes the same tree the assertions read back, and exposed plainly
        because the flat ``TestEncryptionProviderConfig`` case reads
        ``<kube_home>/encryption-provider-config.yaml`` directly.
        """
        return self._kube_home

    @property
    def package_dir(self) -> Path:
        """``<repo>/cluster/gce/gci``: the ``cwd`` every invocation runs in."""
        return self._package_dir

    @property
    def env_script_path(self) -> Path:
        """``<kube_home>/kube-env``: what :meth:`create_env` writes and bash sources.

        The value ``mustCreateEnv`` returns. A path, computed from the layout: it
        exists only once :meth:`create_env` has run, which :meth:`run_func`
        checks before invoking anything.
        """
        if self._case is not None:
            return self._case.env_script_path
        return self._kube_home / ENV_SCRIPT_FILE_NAME

    @property
    def manifest(self) -> str | None:
        """The pod manifest's filename, or ``None`` for the bare shape."""
        return None if self._case is None else self._case.manifest

    @property
    def harness(self) -> ManifestTestCase | None:
        """The wrapped :class:`~tests.helpers.manifest.ManifestTestCase`, if any.

        Exposed so a full-shape caller can reach the paths only that harness
        computes -- ``manifest_sources``, ``manifest_source_path`` and
        ``manifest_destination`` -- without this wrapper restating derivations
        that already have exactly one definition.
        """
        return self._case

    @property
    def pod(self) -> PodManifest:
        """The manifest loaded by the last :meth:`load_pod_from_manifest` call.

        Raises:
            ManifestHarnessError: for the bare shape, or before a load. Go starts
                its ``pod`` field at the zero value, where reading
                ``Containers[0]`` panics; raising here keeps a 'must not contain'
                assertion from passing against an empty pod.
        """
        __tracebackhide__ = True
        if self._case is None:
            raise ManifestHarnessError(self._bare_shape_message("pod"))
        return self._case.pod

    def create_env(
        self,
        context: Mapping[str, object],
        target: str,
        templates: Sequence[str | os.PathLike[str]],
    ) -> Path:
        """Render the ``kube-env`` script into this case's ``KUBE_HOME``.

        Ports ``mustCreateEnv``. The TARGET and the TEMPLATE PATHS stay separate
        arguments because they are different kinds of string: the target is a
        NAME selecting among the parsed set, while ``base.template`` is parsed
        without ever being a target because the other two invoke the ``base``
        template it defines.

        Returns:
            :attr:`env_script_path`.

        Raises:
            ManifestHarnessError: if rendering or writing fails.
        """
        __tracebackhide__ = True
        if self._case is not None:
            return self._case.create_env(context, target, templates)
        return self._renderer.write(target, templates, context, kube_home=self._kube_home)

    def run_func(
        self,
        script_names: Sequence[str],
        *,
        path_args: Sequence[str | os.PathLike[str]] = (),
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        requirement: str | None = None,
    ) -> bash.BashResult:
        """Source the written ``kube-env`` and the scripts, then call the function.

        The execution half of ``mustInvokeFunc``, delegated to
        ``tests.helpers.bash``: that module builds the ``source`` chain character
        for character, merges stdout and stderr as Go's ``CombinedOutput`` does,
        bounds the call and raises on a non-zero exit, which is the ``t.Fatalf``
        posture. None of it is reimplemented here.

        A TOLERANT POSTURE IS DELIBERATELY ABSENT. The V8 fail-closed scenarios
        need a non-zero exit as DATA and need the streams apart, so they call
        ``bash_invoke.try_invoke_func`` (or ``bash_invoke.run_bash`` for the
        nameref call shape) with this case's :attr:`env_script_path` and
        :attr:`package_dir`. One posture per entry point keeps that decision in
        one place.

        Args:
            script_names: Scripts to source, IN ORDER, after ``kube-env`` --
                normally ``KUBE_APISERVER_SCRIPT_NAMES``. Order is load-bearing:
                ``configure-kubeapiserver.sh`` calls functions defined by
                ``configure-helper.sh``. Relative names resolve against
                :attr:`package_dir`.
            path_args: Positional arguments for the function, normally the single
                path ``create-master-audit-policy`` writes to. Empty for every
                other case.
            env: PROCESS environment overrides, merged by bash.py over a copy of
                ``os.environ`` and passed through untouched -- distinct from the
                template context, and nothing is defaulted or injected on the way.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            requirement: Requirement identifier quoted in any failure message, so
                a CI failure reads as a requirement violation.

        Returns:
            The :class:`~tests.helpers.bash.BashResult`, whose ``stdout`` holds
            the merged output.

        Raises:
            ManifestHarnessError: if no ``kube-env`` has been written yet, or if
                ``script_names`` is empty.
            tests.helpers.bash.BashInvocationError: on a timeout or a non-zero
                exit.
        """
        __tracebackhide__ = True
        env_script = self.env_script_path
        if not env_script.is_file():
            raise ManifestHarnessError(
                f"no {ENV_SCRIPT_FILE_NAME} has been written to {env_script}: call create_env() "
                "or invoke_func() first. Sourcing a missing file would abort bash before the "
                "generator ran, and the failure would not mention the environment."
            )
        if not script_names:
            raise ManifestHarnessError(
                f"script_names is empty, so nothing would define {self._func_name!r}."
            )

        if path_args:
            # Bypassing ManifestTestCase.run_func on purpose: its delegate takes a
            # bare function name. The composed chain is identical apart from the
            # trailing arguments; see :func:`_chain_with_arguments`.
            script, argv = _chain_with_arguments(
                env_script, script_names, self._func_name, path_args
            )
            return bash.run_bash(
                script,
                cwd=self._package_dir,
                argv=argv,
                env=env,
                timeout=timeout,
                check=True,
                merge_streams=True,
                requirement=requirement,
            )

        if self._case is not None:
            return self._case.run_func(
                script_names, env=env, timeout=timeout, requirement=requirement
            )
        return bash.must_invoke_func(
            self._func_name,
            env_script_path=env_script,
            script_names=script_names,
            cwd=self._package_dir,
            env=env,
            timeout=timeout,
            requirement=requirement,
        )

    def invoke_func(
        self,
        context: Mapping[str, object],
        script_names: Sequence[str],
        target_template: str,
        templates: Sequence[str | os.PathLike[str]],
        *,
        path_args: Sequence[str | os.PathLike[str]] = (),
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        requirement: str | None = None,
    ) -> bash.BashResult:
        """Render the environment, then run the shipped generator. ``mustInvokeFunc``.

        The complete port of ``mustInvokeFunc`` (configure_helper_test.go
        L108-123), whose first act is ``mustCreateEnv``. The parameter order
        follows the Go signature ``mustInvokeFunc(env, scriptNames,
        targetTemplate, templates...)`` so the two read alike side by side, with
        the variadic tail an explicit sequence.

        INVARIANT PRESERVED: the SHIPPED generator runs. What executes is
        ``cluster/gce/gci/configure-helper.sh`` and
        ``configure-kubeapiserver.sh`` from this checkout, read at the moment the
        case runs, against the shipped pod manifest and the shipped templates.

        Returns:
            The :class:`~tests.helpers.bash.BashResult` of the invocation.

        Raises:
            ManifestHarnessError: for any render or setup failure.
            tests.helpers.bash.BashInvocationError: on a timeout or a non-zero
                exit.
        """
        __tracebackhide__ = True
        self.create_env(context, target_template, templates)
        return self.run_func(
            script_names,
            path_args=path_args,
            env=env,
            timeout=timeout,
            requirement=requirement,
        )

    def load_pod_from_manifest(self) -> PodManifest:
        """Read and decode the generated manifest. ``mustLoadPodFromManifest``.

        Re-reading the destination is deliberate: what is decoded is what the
        generator WROTE, not what the harness copied in, which is what makes the
        assertions evidence about the generator.

        Raises:
            ManifestHarnessError: for the bare shape, which has no manifest and
                no destination directory; or if the destination is missing or
                does not hold a valid ``v1`` ``Pod``.
        """
        __tracebackhide__ = True
        if self._case is None:
            raise ManifestHarnessError(self._bare_shape_message("load_pod_from_manifest()"))
        return self._case.load_pod_from_manifest()

    def tear_down(self) -> None:
        """Remove this case's ``KUBE_HOME``. The port of ``tearDown``.

        Ports ``os.RemoveAll(c.kubeHome)``. For the full shape the wrapped
        harness does it, proving ownership through the marker file it wrote. For
        the bare shape the directory came from ``mkdtemp`` inside the test's own
        ``tmp_path``, so this object is the only thing that has ever held it and
        no marker is needed -- but a SYMLINK is still refused rather than
        followed, because removing a resolved link would delete whatever it
        points at.

        Idempotent, exactly as ``os.RemoveAll`` is, so calling it after the
        fixture already has is harmless.

        Raises:
            ManifestHarnessError: if the tree exists and cannot be removed. Not
                ignored: an undeletable tree usually means a leaked subprocess is
                still holding a file open, and every later run inherits it.
        """
        __tracebackhide__ = True
        if self._case is not None:
            self._case.tear_down()
            return
        if self._kube_home.is_symlink():
            raise ManifestHarnessError(
                f"refusing to tear down KUBE_HOME {self._kube_home}: it is a SYMLINK, so removing "
                "it recursively would delete whatever it points at. It was a real directory when "
                "the case was created, so something replaced it during the test."
            )
        if not self._kube_home.exists():
            return
        try:
            shutil.rmtree(self._kube_home)
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to tear down KUBE_HOME {self._kube_home}: {exc}"
            ) from exc

    def _bare_shape_message(self, member: str) -> str:
        """Explain why ``member`` is unavailable on a case built without a manifest."""
        return (
            f"{member} is not available on this case: it was created without a manifest, which is "
            "the BARE shape of audit_policy_test.go L54-58 -- no pod manifest is copied and no "
            "etc/kubernetes/manifests directory is created, so there is nothing to decode. Pass "
            "manifest=KUBE_APISERVER_MANIFEST_FILE_NAME to manifest_case() for a case that "
            "generates a pod manifest."
        )


class ManifestCaseFactory:
    """Creates :class:`ShellManifestCase` objects and remembers them for teardown.

    The port of the two lines every consumer opens a case with
    (apiserver_etcd_test.go L71-72)::

        c := newManifestTestCase(t, kubeAPIServerManifestFileName, kubeAPIServerStartFuncName, nil)
        defer c.tearDown()

    ``defer`` runs whether the test passes, fails or aborts; the fixture's
    ``yield`` teardown is that guarantee, and it is why every case is recorded
    here as it is built. A test may build several -- ``TestTLSFlags`` builds one
    per subtest -- so each gets its own uniquely named ``KUBE_HOME`` and all of
    them are torn down.

    Every ``KUBE_HOME`` is created INSIDE the test's ``tmp_path``, which makes
    isolation structural rather than dependent on teardown running: pytest owns
    that directory, so even a case that somehow escaped teardown could not leak
    into another test or another ``pytest-xdist`` worker. Note that the
    ``kube_home`` FIXTURE is deliberately not reused as a case's ``KUBE_HOME``:
    it pre-creates the two layout directories, and
    ``ManifestTestCase._reject_existing_case_tree`` rightly refuses a directory
    that already holds another case's tree.
    """

    def __init__(
        self,
        *,
        repo_root: Path,
        package_dir: Path,
        base_dir: Path,
        renderer: KubeEnvRenderFactory,
    ) -> None:
        """Bind the roots every case is derived from.

        Args:
            repo_root: The repository root, from which
                ``tests.helpers.manifest`` derives both template roots.
            package_dir: ``<repo>/cluster/gce/gci``, the ``cwd`` of every
                invocation.
            base_dir: The directory each case's ``KUBE_HOME`` is created inside --
                the test's ``tmp_path``.
            renderer: The tier's ``render_kube_env``.
        """
        self._repo_root: Final[Path] = repo_root
        self._package_dir: Final[Path] = package_dir
        self._base_dir: Final[Path] = base_dir
        self._renderer: Final[KubeEnvRenderFactory] = renderer
        self._cases: list[ShellManifestCase] = []

    @property
    def cases(self) -> tuple[ShellManifestCase, ...]:
        """The cases built so far, in creation order."""
        return tuple(self._cases)

    def __call__(
        self,
        *,
        func_name: str,
        manifest: str | None = None,
        aux_manifests: Sequence[str] = (),
    ) -> ShellManifestCase:
        """Build one case, in the full shape or the bare one.

        Args:
            func_name: The shell function the case invokes -- normally
                ``KUBE_APISERVER_START_FUNC_NAME``, or
                ``"create-master-audit-policy"`` for the audit generator. Pass a
                function's ARGUMENTS through ``path_args`` on
                :meth:`ShellManifestCase.run_func` rather than appending them
                here: they travel as positional parameters and are never
                interpolated into the script text.
            manifest: The pod manifest's bare filename, normally
                ``KUBE_APISERVER_MANIFEST_FILE_NAME``. Omit it for the BARE shape
                of audit_policy_test.go L54-58, which copies no manifest and
                creates no destination directory.
            aux_manifests: Additional manifests to copy into the sources
                directory. Only meaningful with ``manifest``; every current
                consumer passes none, and the parameter exists because the Go
                signature has it.

        Returns:
            The prepared case, already recorded for teardown.

        Raises:
            ManifestHarnessError: if ``func_name`` is blank, if ``aux_manifests``
                is given without ``manifest``, or if setup fails.
        """
        __tracebackhide__ = True
        if not func_name.strip():
            raise ManifestHarnessError(
                "func_name must name the shell function to invoke, for example "
                f"'start-kube-apiserver', got {func_name!r}. A blank name would let bash source "
                "the scripts, run nothing, exit 0 and report a FALSE PASS."
            )

        if manifest is None:
            if aux_manifests:
                raise ManifestHarnessError(
                    f"aux_manifests={list(aux_manifests)!r} was given without a manifest. The "
                    "auxiliary manifests are copied into KUBE_HOME/kube-manifests/kubernetes/"
                    "gci-trusty, which the bare shape deliberately does not create, so they would "
                    "have nowhere to go."
                )
            try:
                # mkdtemp inside tmp_path, with the Go harness's own prefix, so a
                # test that builds several bare cases cannot have them collide and
                # a retained directory is attributable to this tier.
                kube_home = Path(tempfile.mkdtemp(prefix=TEMP_DIR_PREFIX, dir=self._base_dir))
            except OSError as exc:
                raise ManifestHarnessError(
                    f"failed to create a KUBE_HOME inside {self._base_dir}: {exc}"
                ) from exc
            case = ShellManifestCase(
                func_name=func_name,
                kube_home=kube_home,
                package_dir=self._package_dir,
                renderer=self._renderer,
            )
            self._cases.append(case)
            return case

        harness = ManifestTestCase(
            repo_root=self._repo_root,
            manifest=manifest,
            func_name=func_name,
            aux_manifests=aux_manifests,
            base_dir=self._base_dir,
            renderer=self._renderer.as_renderer(),
        )
        case = ShellManifestCase(
            func_name=func_name,
            kube_home=harness.kube_home,
            package_dir=harness.package_dir,
            renderer=self._renderer,
            case=harness,
        )
        self._cases.append(case)
        return case

    def tear_down_all(self) -> None:
        """Tear every case down, most recent first, and report anything that failed.

        LIFO, which is ``defer``'s order, so a case built inside another's
        lifetime goes first. Every case is attempted even if an earlier one
        raised -- stopping at the first failure would leak the rest -- and the
        failures are then reported together.

        A teardown failure is not swallowed. An undeletable ``KUBE_HOME`` means
        something is still holding a file open, and reported as nothing at all
        that leak stays invisible until it breaks an unrelated test. It is also
        not allowed to hide a test's own finding: pytest reports a fixture
        teardown error ALONGSIDE the failure of the test it belongs to, never
        instead of it.

        Raises:
            ManifestHarnessError: if any case failed to tear down.
        """
        __tracebackhide__ = True
        failures: list[str] = []
        for case in reversed(self._cases):
            try:
                case.tear_down()
            except Exception as exc:
                # Broad on purpose: every remaining case must still be attempted,
                # so no failure mode may end the loop early. Nothing is
                # swallowed -- each is collected and reported below.
                failures.append(f"{case.kube_home}: {exc}")
        self._cases.clear()
        if failures:
            raise ManifestHarnessError(
                "failed to tear down "
                f"{len(failures)} manifest case KUBE_HOME tree(s): {'; '.join(failures)}. A "
                "subprocess still holding a file open there is the usual cause."
            )


# ---------------------------------------------------------------------------
# bash_invoke: the two postures of tests.helpers.bash, with the cwd bound
# ---------------------------------------------------------------------------


class BashInvoker:
    """Every way this tier is allowed to reach ``bash``, with ``cwd`` already right.

    A thin binding over ``tests.helpers.bash``, which owns the interpreter, the
    timeout, the environment copy, the stream handling and the two failure
    postures. Nothing about subprocess handling is reimplemented here; what this
    class adds is the working-directory contract -- ``<repo>/cluster/gce/gci``,
    because the scripts and templates are named relative to it -- so no call site
    has to remember it, and one composition that module has no signature for.

    THE TWO POSTURES ARE SEPARATE ENTRY POINTS, NOT A FLAG, exactly as bash.py
    keeps them:

    * :meth:`must_invoke_func` MERGES stdout and stderr, as Go's
      ``CombinedOutput`` does, and RAISES on a non-zero exit, which is
      ``t.Fatalf``. The etcd, KMS and audit modules use it.
    * :meth:`try_invoke_func` keeps the streams APART and treats a non-zero exit
      as DATA. The V8 fail-closed module cannot be written any other way: it
      asserts ``returncode == 1`` TOGETHER with a specific diagnostic, and a
      helper that raised on non-zero or merged the streams would make one of the
      two unassertable.

    :meth:`run_bash` is there for a call shape neither covers.
    ``configure-etcd-params`` takes a NAMEREF -- ``local -n params_ref=$1`` -- so
    it must be invoked as ``params="" ; configure-etcd-params params`` and the
    variable read afterwards, which is a script rather than a function call.
    """

    def __init__(self, *, cwd: Path) -> None:
        """Bind the default working directory.

        Args:
            cwd: ``<repo>/cluster/gce/gci`` -- the ``gci_cwd`` fixture.
        """
        self._cwd: Final[Path] = cwd

    @property
    def cwd(self) -> Path:
        """The default working directory of every invocation."""
        return self._cwd

    def must_invoke_func(
        self,
        func_name: str,
        *,
        env_script_path: str | os.PathLike[str],
        script_names: Sequence[str],
        path_args: Sequence[str | os.PathLike[str]] = (),
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        requirement: str | None = None,
    ) -> bash.BashResult:
        """Source ``kube-env`` and the scripts, call the function, raise on failure.

        The ``mustInvokeFunc`` port: merged streams, non-zero exit raises.

        Args:
            func_name: The shell function to call, appended bare exactly as Go
                appends ``c.manifestFuncName`` when it takes no arguments.
            env_script_path: The rendered ``kube-env``, sourced first.
            script_names: Scripts to source, IN ORDER, after it.
            path_args: Positional arguments for the function. Empty selects
                bash.py's own entry point unchanged; non-empty selects the
                composition of :func:`_chain_with_arguments`, which the audit
                generator needs.
            cwd: Working directory; defaults to :attr:`cwd`.
            env: Process environment overrides, passed through untouched.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            requirement: Requirement identifier quoted on failure.

        Returns:
            The result, with the merged output in ``stdout``.

        Raises:
            tests.helpers.bash.BashInvocationError: on a blank or unsafe function
                name, a timeout, or a non-zero exit.
            ManifestHarnessError: if ``path_args`` is given with a blank function
                name or no scripts.
        """
        __tracebackhide__ = True
        if not path_args:
            return bash.must_invoke_func(
                func_name,
                env_script_path=env_script_path,
                script_names=script_names,
                cwd=self._resolve_cwd(cwd),
                env=env,
                timeout=timeout,
                requirement=requirement,
            )
        script, argv = _chain_with_arguments(
            env_script_path, script_names, func_name, path_args
        )
        return bash.run_bash(
            script,
            cwd=self._resolve_cwd(cwd),
            argv=argv,
            env=env,
            timeout=timeout,
            check=True,
            merge_streams=True,
            requirement=requirement,
        )

    def try_invoke_func(
        self,
        func_name: str,
        *,
        env_script_path: str | os.PathLike[str],
        script_names: Sequence[str],
        path_args: Sequence[str | os.PathLike[str]] = (),
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        requirement: str | None = None,
    ) -> bash.BashResult:
        """Invoke like :meth:`must_invoke_func`, but treat a non-zero exit as data.

        Separated streams and no raise, which is what lets the V8 fail-closed
        module assert ``returncode == 1`` and match the refusal in the same test.
        Which stream a diagnostic lands on is the SHIPPED script's choice and
        worth checking rather than assuming: ``configure-etcd-params`` emits both
        its WARNING and its "refusing to fall back to plaintext etcd" ERROR with
        a bare ``echo``, so they arrive on STDOUT.

        Args:
            func_name: The shell function to call.
            env_script_path: The rendered ``kube-env``, sourced first.
            script_names: Scripts to source, IN ORDER, after it.
            path_args: Positional arguments for the function.
            cwd: Working directory; defaults to :attr:`cwd`.
            env: Process environment overrides, passed through untouched.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            requirement: Requirement identifier quoted on a timeout.

        Returns:
            The result, with ``stdout`` and ``stderr`` apart and ``returncode``
            reported rather than raised on.

        Raises:
            tests.helpers.bash.BashInvocationError: on a blank or unsafe function
                name or a timeout. A non-zero exit is NOT an error here.
            ManifestHarnessError: if ``path_args`` is given with a blank function
                name or no scripts.
        """
        __tracebackhide__ = True
        if not path_args:
            return bash.try_invoke_func(
                func_name,
                env_script_path=env_script_path,
                script_names=script_names,
                cwd=self._resolve_cwd(cwd),
                env=env,
                timeout=timeout,
                requirement=requirement,
            )
        script, argv = _chain_with_arguments(
            env_script_path, script_names, func_name, path_args
        )
        return bash.run_bash(
            script,
            cwd=self._resolve_cwd(cwd),
            argv=argv,
            env=env,
            timeout=timeout,
            check=False,
            merge_streams=False,
            requirement=requirement,
        )

    def must_invoke_func_with_args(
        self,
        func_name: str,
        args: Sequence[str],
        *,
        target_path: str | os.PathLike[str],
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        script: str = bash.CONFIGURE_HELPER_SCRIPT,
        requirement: str | None = None,
    ) -> bash.BashResult:
        """Source one script and call the function with a path plus RAW tokens.

        The shape ``append_or_replace_prefixed_line_test.go`` builds: no
        ``kube-env`` is involved, the target file travels as ``"$2"`` and the
        remaining tokens are substituted VERBATIM because the oracle passes
        ``'"$argon2id$v=19"'`` WITH its single quotes and expects bash to strip
        them. bash.py restricts those tokens to the ones that oracle passes, which
        is what makes a raw seam safe; that restriction is not relaxed here.

        Args:
            func_name: The shell function to call, for example
                ``append_or_replace_prefixed_line``.
            args: Pre-quoted, test-controlled tokens after the path.
            target_path: The file the function operates on, passed as ``$2`` and
                never interpolated.
            cwd: Working directory; defaults to :attr:`cwd`.
            env: Process environment overrides.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            script: The script to source, relative as the oracle writes it.
            requirement: Requirement identifier quoted on failure.

        Returns:
            The result, with merged output in ``stdout``.

        Raises:
            tests.helpers.bash.BashInvocationError: on a blank or unsafe function
                name, a token outside the allow-list, a timeout, or a non-zero
                exit.
        """
        __tracebackhide__ = True
        return bash.must_invoke_func_with_args(
            func_name,
            args,
            target_path=target_path,
            cwd=self._resolve_cwd(cwd),
            env=env,
            timeout=timeout,
            script=script,
            requirement=requirement,
        )

    def run_bash(
        self,
        script: str,
        *,
        argv: Sequence[str] = (),
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
        merge_streams: bool = True,
        requirement: str | None = None,
    ) -> bash.BashResult:
        """Run one bash script string, for a call shape the two postures do not cover.

        The nameref case is the reason this is exposed:
        ``configure-etcd-params`` is declared ``local -n params_ref=$1``, so it
        must be called as ``params="" ; configure-etcd-params params`` and the
        variable read afterwards. A bare call with no argument does NOT fail
        loudly -- measured, it prints ``local: not a valid identifier``, leaves
        the variable unset and still exits 0 -- so the script shape matters.

        KEEP PATHS OUT OF ``script`` AND IN ``argv``. bash performs parameter
        expansion and command substitution inside double quotes, so an
        interpolated path containing ``$(...)``, a backtick or a quote would be
        evaluated rather than read; a positional parameter is expanded exactly
        once to its literal value. Paths here derive from ``tmp_path``, which
        follows ``--basetemp`` and the test's own name.

        Args:
            script: The text for ``bash -c``, referencing ``$1``, ``$2`` ... for
                every path it needs.
            argv: The positional arguments, in order.
            cwd: Working directory; defaults to :attr:`cwd`.
            env: Process environment overrides.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            check: Raise on a non-zero exit. Pass ``False`` when the exit status
                is the assertion.
            merge_streams: Redirect stderr into stdout, as ``CombinedOutput``
                does. Pass ``False`` when a diagnostic must be attributed to one
                stream.
            requirement: Requirement identifier quoted on failure.

        Returns:
            The :class:`~tests.helpers.bash.BashResult`.

        Raises:
            tests.helpers.bash.BashInvocationError: on a timeout, or on a
                non-zero exit when ``check`` is true.
        """
        __tracebackhide__ = True
        return bash.run_bash(
            script,
            cwd=self._resolve_cwd(cwd),
            argv=argv,
            env=env,
            timeout=timeout,
            check=check,
            merge_streams=merge_streams,
            requirement=requirement,
        )

    def _resolve_cwd(self, cwd: str | os.PathLike[str] | None) -> Path:
        """Return the working directory for one call: the override, or the bound one."""
        return self._cwd if cwd is None else Path(cwd)


# ---------------------------------------------------------------------------
# The fixtures
# ---------------------------------------------------------------------------
# Four public fixtures and one supporting path, and nothing autouse: a fixture
# that lays out a KUBE_HOME or runs a generator must be requested explicitly, so
# that a module which needs none pays for none.


@pytest.fixture(scope="session")
def gci_cwd(repo_root: Path) -> Path:
    """``<repo_root>/cluster/gce/gci``: the working directory every invocation needs.

    PORTS: ``os.Getwd()`` as ``go test`` reports it for this package
    (configure_helper_test.go L66), which is what both the script names and the
    template paths in the oracle are written relative to.

    INVARIANT LOCKED: no subprocess of this tier runs anywhere else. Two
    independent reasons, either sufficient: ``mustInvokeFunc`` sources scripts by
    bare relative name, so ``source "configure-helper.sh"`` resolves only from
    here; and the consumers name templates relatively, so
    ``"testdata/kube-apiserver/base.template"`` resolves only from here.

    Derived from the session ``repo_root`` fixture through
    ``tests.helpers.manifest.gci_package_dir``, which is the single derivation of
    this path in the tree and raises if it is missing. NEVER from the process
    working directory: hack/make-rules/test-python.sh runs pytest from python/
    while a developer may run it from the repository root, both are legitimate,
    and a CWD-derived answer would differ between them with no way to tell which
    was right.

    Session-scoped because it is an immutable path and a constant for the run.
    That holds no state and so cannot leak between tests -- everything in this
    tier that DOES hold state is function-scoped and rooted in ``tmp_path``.
    """
    return gci_package_dir(repo_root)


@pytest.fixture
def kube_home(tmp_path: Path) -> Path:
    """A ``KUBE_HOME`` for this test alone, laid out as the shipped generator expects.

    PORTS: ``os.MkdirTemp("", "configure-helper-test")`` plus the two layout
    directories of ``newManifestTestCase`` (configure_helper_test.go L58-64,
    L73, L82-83, L101-105).

    INVARIANT LOCKED: the two directories the shipped generator reads and writes
    exist before it runs, and they are unique to this test:

    * ``kube-manifests/kubernetes/gci-trusty`` -- the SOURCES directory
      ``configure-kubeapiserver.sh:299`` reads its input from;
    * ``etc/kubernetes/manifests`` -- the DESTINATION directory its final ``cp``
      writes into, which must exist because ``cp`` does not create it. The value
      reaches the script as ``ETC_MANIFESTS``, which base.template derives from
      ``KUBE_HOME``.

    Both are joined from the segment tuples ``tests.helpers.manifest`` publishes,
    so the layout has exactly one definition in the tree and this fixture cannot
    drift from the harness that also builds it.

    Rooted in ``tmp_path`` rather than ``tempfile.mkdtemp``, which is the whole
    isolation story of this tier: ``tmp_path`` is unique per test, pytest owns
    its lifetime and retention, and a failure leaves it inspectable. So no two
    tests -- and no two ``pytest-xdist`` workers -- can see each other's tree even
    if a teardown never ran, which is what makes the folder honest under
    ``pytest-randomly``.

    This is for a caller with no manifest case: the V8 fail-closed module renders
    its ``kube-env`` straight into here and hands the path to ``bash_invoke``. A
    case built by :func:`manifest_case` gets its OWN ``KUBE_HOME`` inside
    ``tmp_path`` instead, because ``ManifestTestCase`` refuses a directory that
    already holds a case's tree -- and this one does, by design.
    """
    home = tmp_path / "kube-home"
    home.joinpath(*MANIFEST_SOURCES_RELATIVE_PATH).mkdir(parents=True)
    home.joinpath(*MANIFEST_DESTINATION_RELATIVE_PATH).mkdir(parents=True)
    return home


@pytest.fixture
def render_kube_env(
    repo_root: Path,
    gci_cwd: Path,
    kube_home: Path,
) -> KubeEnvRenderFactory:
    """The tier's ``kube-env`` renderer and render-context builder.

    PORTS: ``mustCreateEnv`` (configure_helper_test.go L125-142) and the
    ``text/template`` pair it wraps, ``ParseFiles`` plus ``ExecuteTemplate``.

    INVARIANT LOCKED: one implementation of
    :class:`~tests.helpers.manifest.KubeEnvRenderer` in this repository, whose
    output is byte-identical to Go's for all four templates -- validated by
    differential testing against the repository's own toolchain, not by reading
    it. See the module docstring for the three semantics that make that true and
    the class docstring for why :meth:`~KubeEnvRenderFactory.__call__` returns
    text while :meth:`~KubeEnvRenderFactory.write` returns a path.

    It is also the DECLARED SUPPLIER of ``AllowInsecureEtcd``, the fourteenth
    variable of tests/fixtures/templates/kube_env.j2, which no Go struct carries:
    :meth:`~KubeEnvRenderFactory.context` merges it from ``extra`` so that
    ``KubeAPIServerETCDEnv`` stays an exact sixteen-field mirror of
    ``kubeAPIServeETCDEnv``.

    Typical use, for a caller with no manifest case::

        context = render_kube_env.context(env, extra={"AllowInsecureEtcd": "false"})
        env_script = render_kube_env.write(
            render_kube_env.kube_env_j2_target, [render_kube_env.kube_env_j2], context
        )

    Requesting it creates the ``kube_home`` tree, since that is where
    :meth:`~KubeEnvRenderFactory.write` writes by default.
    """
    return KubeEnvRenderFactory(
        package_dir=gci_cwd, kube_home=kube_home, repo_root=repo_root
    )


@pytest.fixture
def manifest_case(
    repo_root: Path,
    gci_cwd: Path,
    tmp_path: Path,
    render_kube_env: KubeEnvRenderFactory,
) -> Iterator[ManifestCaseFactory]:
    """Build ``KUBE_HOME`` cases against the shipped generator, and tear them all down.

    PORTS: ``newManifestTestCase`` (configure_helper_test.go L50-80) paired with
    ``defer c.tearDown()`` (L155-159), in both shapes the oracle uses -- the full
    shape of the etcd and KMS tests and the bare struct literal of the audit
    test. See :class:`ShellManifestCase` for what separates them and
    :class:`ManifestCaseFactory` for how each case's ``KUBE_HOME`` is placed.

    INVARIANT LOCKED: one throwaway ``KUBE_HOME`` per case, never shared, always
    removed. ``configure-kubeapiserver.sh`` rewrites the copied manifest in place
    with ``sed -i``, so sharing would let one case read what another left behind,
    and a stale manifest at the destination could be asserted against even when
    this case's generator run wrote nothing -- a pass that proves nothing.

    Typical use, mirroring apiserver_etcd_test.go L71-90::

        case = manifest_case(
            manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
            func_name=KUBE_APISERVER_START_FUNC_NAME,
        )
        context = render_kube_env.context(env, kube_home=case.kube_home)
        case.invoke_func(
            context,
            KUBE_APISERVER_SCRIPT_NAMES,
            ETCD_TEMPLATE_TARGET,
            (BASE_TEMPLATE_RELATIVE_PATH, ETCD_TEMPLATE_RELATIVE_PATH),
        )
        pod = case.load_pod_from_manifest()

    and the bare shape of audit_policy_test.go L54-67::

        case = manifest_case(func_name="create-master-audit-policy")
        case.invoke_func(
            render_kube_env.context(KubeAPIServerEnv(), kube_home=case.kube_home),
            [CONFIGURE_HELPER_SCRIPT],
            "base.template",
            (BASE_TEMPLATE_RELATIVE_PATH,),
            path_args=(policy_file,),
        )

    Yields:
        The factory. Every case it built is torn down afterwards, in reverse
        order, whether the test passed or failed.
    """
    factory = ManifestCaseFactory(
        repo_root=repo_root,
        package_dir=gci_cwd,
        base_dir=tmp_path,
        renderer=render_kube_env,
    )
    try:
        yield factory
    finally:
        # Unconditional, and the analogue of Go's `defer`: a case whose test
        # failed must still give its tree back, or an `xdist` run accumulates
        # them. Inside `finally` so that an exception from the test body cannot
        # skip it.
        factory.tear_down_all()


@pytest.fixture
def bash_invoke(gci_cwd: Path) -> BashInvoker:
    """Reach the shipped bash, in either posture, with the working directory bound.

    PORTS: ``exec.Command("bash", "-c", args)`` with ``CombinedOutput()`` and the
    ``t.Fatalf`` that follows it (configure_helper_test.go L115-121), and the
    tolerant counterpart the four V8 fail-closed scenarios need, which has no Go
    ancestor because they are performed by hand today.

    INVARIANT LOCKED: the SHIPPED bash runs, from the directory that lets it
    resolve its own relative names, and nothing test-supplied is interpolated
    into the script text. Every subprocess of this tier goes through
    ``tests.helpers.bash``: this fixture adds the ``cwd`` and the one composition
    that module has no signature for -- a function invoked WITH arguments, which
    ``create-master-audit-policy`` needs -- and reimplements none of its timeout,
    environment or stream handling.

    Which posture to use, and it is not a preference:

    * :meth:`~BashInvoker.must_invoke_func` for a case that expects success. It
      merges the streams, as ``CombinedOutput`` does, and raises on a non-zero
      exit.
    * :meth:`~BashInvoker.try_invoke_func` when the EXIT STATUS is the assertion.
      ``configure-etcd-params`` must exit 1 both when all six etcd credentials
      are absent and ``ETCD_APISERVER_ALLOW_INSECURE`` is not ``true``, and when
      they are only PARTIALLY present -- asserted together with its refusal
      message, which it emits on stdout.
    * :meth:`~BashInvoker.run_bash` for the nameref call shape
      ``configure-etcd-params`` requires.
    * :meth:`~BashInvoker.must_invoke_func_with_args` for
      ``append_or_replace_prefixed_line``, whose pre-quoted tokens must reach
      bash raw.

    And what NOT to do, because it is measured rather than theoretical: do not add
    ``set -e``, do not change the ``;`` separators to ``&&``, and do not treat
    stderr content as failure. The audit case's ``kube-env`` is a fragment that
    bash reports a syntax error for, ``source`` returns 2, and the invocation
    still exits 0 because ``;`` yields the LAST command's status -- while the
    generator writes its valid policy. Any of those three changes turns a passing
    oracle case into a failure that says nothing about the control under test.
    """
    return BashInvoker(cwd=gci_cwd)
