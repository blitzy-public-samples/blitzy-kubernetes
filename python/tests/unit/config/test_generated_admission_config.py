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

"""Config-schema tests for the GENERATED cluster-level admission controller configuration.

AAP §0.4.2.3 / §0.5.1 / §0.10.2 (V2) - tech-spec §6.4.4.3 (Pod Security modes /
zero-downtime rollout). The generator's own comment block, immediately above the
envelope heredoc, cites ``tech-spec §6.4.4.3 / AAP §0.4.1, V2``; this module follows
the sections the artifact itself cites rather than choosing its own.

INVARIANT LOCKED BY THIS MODULE: **F-002-RQ-001** - the ``admission_controller_config.yaml``
that ``cluster/gce/gci/configure-helper.sh`` generates configures the ``PodSecurity``
admission plugin with ``enforce=baseline``, ``warn=restricted``, ``audit=restricted``,
all three pinned to version ``latest``, and exempts exactly the one namespace
``kube-system``.

THE GENERATOR IS BOTH RUN AND READ, AND THE TWO RESULTS MUST AGREE.

The heredocs that produce this file live inside the ``create-master-auth`` function
(declared at configure-helper.sh:820) behind the guard
``if [[ -n "${ADMISSION_CONTROL:-}" ]]`` (L1065), and they write to the ABSOLUTE path
``/etc/srv/kubernetes/admission_controller_config.yaml`` - unlike
``create-master-audit-policy``, which takes its destination as ``$1`` and is directly
sandboxable. A test must not write to ``/etc``: it would not be hermetic, not
parallel-safe under pytest-xdist, and would fail wherever the tester is not root.

So this module derives the generated document TWICE, by two independent routes, and
requires them to be byte-identical:

* AUTHORITATIVELY, by RUNNING the shipped generator under real bash through a
  GENERATION SEAM - a copy of ``configure-helper.sh`` in ``tmp_path`` whose only
  difference is that the ``/etc/`` output prefix points inside the sandbox. Bash is
  then the interpreter of bash, so control flow, quoted-versus-unquoted heredoc
  delimiters, ``$VAR`` and ``${VAR}`` expansion, command substitution, backticks and
  arithmetic are all HONOURED rather than approximated. The seam's fidelity is
  proven, not assumed: reversing its one substitution must restore the shipped file
  byte for byte (:func:`test_the_generation_seam_changes_only_the_destination_prefix`).
* AS A CROSS-CHECK, by STATICALLY EXTRACTING the heredoc bodies from the script text
  and concatenating them in Python. This route is pure - no subprocess, no server, no
  etcd - and it is a genuinely useful second opinion, but on its own it can only be a
  MODEL: the extractor understands indentation and the ``${`` guard and nothing else
  about bash.

:func:`test_real_bash_generates_the_document_the_static_extractor_models` is the
differential that keeps the model honest, and the reason both routes are kept.
Measured: moving the PodSecurity heredoc inside a guard that defaults to false -
which deletes the entire V2 control from what ships, while leaving the ``cat <<EOF``
line at the same indentation - is INVISIBLE to the static route and fails the runtime
route immediately. That is what a model of bash cannot do, and it is why the runtime
document is the authoritative one.

The literal-text soundness check on the static route is retained as an early warning:
:func:`generated_admission_config` fails if the assembled text contains a ``${...}``
shell expansion, which says the model has stopped being valid even before the
differential reports the divergence.

The subprocess-bearing tests carry ``@pytest.mark.shell`` in addition to this
module's ``config`` marker, so the tier they really belong to is declared rather than
implied. Neither marker is ``integration``, so all of them still run under
``pytest -m "not integration"``, and nothing here needs etcd or an API server.

WHAT THE EXTRACTOR MUST GET RIGHT, measured rather than inferred (AAP §0.11.1 B2).
Exactly four heredocs in the script target the admission configuration file, and their
conditionality is read from the script's CONTROL FLOW - the ``if``/``fi`` frames open at
the opening line - never from how far the line happens to be indented:

===========  ==========  ============  ==============  =============================
Opening      Redirect    Body lines    Guard depth     Status
===========  ==========  ============  ==============  =============================
L1069        ``>``       3             1               UNCONDITIONAL - the envelope
L1076        ``>>``      10            1               UNCONDITIONAL - ``ResourceQuota``
L1094        ``>>``      15            1               UNCONDITIONAL - ``PodSecurity``
L1141        ``>>``      8             2               CONDITIONAL - ``ImagePolicyWebhook``
===========  ==========  ============  ==============  =============================

All four sit inside ``if [[ -n "${ADMISSION_CONTROL:-}" ]]`` (L1065), which is what
"unconditional" means here: emitted on every GCE master that configures admission
control at all. The L1141 block sits inside a SECOND frame,
``if [[ "${ADMISSION_CONTROL:-}" == *"ImagePolicyWebhook"* ]]`` (L1112), so it is
emitted only when an operator requests that plugin; including it would assert a shape
the shipped default never produces, so it is excluded. A fifth heredoc (L1121) targets
``gcp_image_review.kubeconfig``; filtering on the target file name excludes it before
conditionality is considered at all.

WHY CONTROL FLOW AND NOT INDENTATION. This module previously classified blocks by the
width of their leading whitespace, anchored on the truncating block. That is cosmetic:
bash is perfectly happy to place a guarded heredoc at the same indent as an unguarded
one, and the extractor then read both as unconditional - so the ``PodSecurity`` block
could have been moved behind a default-false guard and this gate would still have
extracted it, assembled it and approved it. Conditionality is now the guard chain
:func:`scan_heredocs` derives, and the guard itself is MATCHED against
:data:`ADMISSION_CONTROL_GUARD_PATTERN` rather than merely counted, so a changed
condition aborts instead of being absorbed.

Those line numbers are PROVENANCE ONLY and are never asserted - they drift with
unrelated edits. The non-brittle equivalent is the structural assertion in
:func:`test_extractor_sees_exactly_the_unconditional_heredocs`, which fails loudly if
the block count, the guard chains, the delimiter form or the redirect operators ever
change, instead of silently including or dropping a block.

INVARIANTS LOCKED, one per test:

1. THE EXTRACTOR SEES EXACTLY THE UNCONDITIONAL BLOCKS - four blocks target the file,
   three are guarded only by the admission-control test, exactly one truncates and it
   is the first in file order, the excluded one is enclosed by one further frame and is
   the ``ImagePolicyWebhook`` block, and every block uses the plain ``<<EOF`` form
   whose body bash terminates only at a line that IS ``EOF``.
2. THE ASSEMBLED TEXT IS LITERAL and carries no conditional plugin.
3. THE OUTER ENVELOPE IS THE STABLE ONE - ``apiserver.config.k8s.io/v1`` /
   ``AdmissionConfiguration`` with a plugin list.
4. THE PODSECURITY PLUGIN DECLARES THE STABLE INNER ENVELOPE -
   ``pod-security.admission.config.k8s.io/v1`` / ``PodSecurityConfiguration``. A
   DIFFERENT API group from the outer one; conflating the two is the classic error
   here, so both are asserted separately and by name.
5. THE SIX DEFAULTS ARE ENFORCE=BASELINE, WARN=RESTRICTED, AUDIT=RESTRICTED, EACH
   PINNED TO ``latest`` - and each is asserted PRESENT before it is compared, because
   ``SetDefaults_PodSecurityDefaults``
   (staging/src/k8s.io/pod-security-admission/admission/api/v1/defaults.go) substitutes
   ``privileged`` for every mode left unset. An omitted key is therefore not neutral:
   it silently means "no enforcement", which is exactly the weakness V2 closed.
6. THE ONLY EXEMPTION IS ``kube-system`` - compared by exact list equality so an added
   exemption fails rather than passing unnoticed.
7. THE ASSEMBLED TEXT IS A VALID STANDALONE FILE - it round-trips through ``tmp_path``
   byte for byte and re-parses to the same document.
8. THE READER IMPLEMENTS BASH'S RULES, tested adversarially rather than only against the
   one well-behaved script it reads: the exact terminator rule for ``<<WORD`` and the
   tabs-only rule for ``<<-WORD``, every spelling of a quoted delimiter, every spelling
   of "write this heredoc to the target" and of "do not", guard classification from the
   shell's own control flow in eleven cases the indentation heuristic answered wrongly,
   and a three-way self-check that the scan of the real generator is internally
   consistent.

WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not assert the ``ResourceQuota``
block's contents: that block is part of the assembled document and must not be dropped
from the assembly, but its ``limitedResources`` are outside F-002-RQ-001. It does not
assert that ``ImagePolicyWebhook`` is absent from the SHIPPED RUNTIME file, because it
is legitimately present when an operator requests it - only that the extractor excluded
it. And it does not assert the ORDER of the plugin list, which F-002-RQ-001 says
nothing about; the measured order is ``[ResourceQuota, PodSecurity]``, which is exactly
why every lookup here is by ``name`` and never by index.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import pytest
import yaml

from tests.helpers.bash import run_bash

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

# L3 config-schema tier: decode-and-assert, no etcd and no API server. The four
# generation-seam tests at the end additionally carry @pytest.mark.shell, because they
# invoke real bash through tests.helpers.bash.run_bash - declared rather than implied,
# since a module claiming purity while spawning a subprocess is the kind of quiet
# mismatch this suite exists to prevent. Both markers are non-integration, so the whole
# module still runs under `pytest -m "not integration"`.
# The vocabulary is declared once in python/pyproject.toml (integration, shell, config,
# parity, slow) and --strict-markers makes any other name a collection ERROR, so this
# is a contract with that file and not a free-form label. Declared here explicitly
# because tests/conftest.py's pytest_collection_modifyitems applies only the
# `integration` marker, and only to modules under tests/integration/.
pytestmark = pytest.mark.config

# ---------------------------------------------------------------------------
# Measured constants. Everything below was verified by execution against the
# committed generator; nothing here is inferred (AAP §0.11.1 B2).
# ---------------------------------------------------------------------------

#: Named in every assertion message so a CI failure reads as a requirement violation
#: rather than a value mismatch (AAP §0.7.2).
REQUIREMENT: Final = "F-002-RQ-001"

#: The shipped generator, as path COMPONENTS joined onto the session-scoped
#: ``repo_root`` fixture. Components rather than a string so the join is
#: platform-agnostic, and ``repo_root`` rather than ``__file__`` arithmetic or the
#: working directory so there is exactly one answer for the whole tier.
GENERATOR_PATH_PARTS: Final = ("cluster", "gce", "gci", "configure-helper.sh")

#: The file the generator writes, matched as TEXT against a redirection target.
#:
#: THIS IS A PATTERN, NEVER AN OPERAND. It is compared against words of the
#: generator's source and is never passed to ``open``, ``Path`` or any other
#: filesystem call: the only path this module reads is the generator itself, and the
#: only path it writes is ``tmp_path``. Anchoring on the target file name is the
#: FIRST discriminator and is what keeps the neighbouring
#: ``gcp_image_review.kubeconfig`` heredoc out of the result set - a looser rule
#: would sweep it in and the assembled YAML would then contain a kubeconfig.
ADMISSION_CONFIG_TARGET: Final = "/etc/srv/kubernetes/admission_controller_config.yaml"

#: The heredoc delimiter the generator uses.
#:
#: TERMINATION IS BASH'S RULE, NOT A TRIMMED COMPARISON. For ``<<WORD`` the body
#: ends at a line that IS the delimiter exactly - no leading and no trailing
#: whitespace - and only ``<<-WORD`` strips anything, and then only leading TABS.
#: A ``strip()``-based comparison accepts ``  EOF  `` and ``\tEOF``, neither of
#: which bash accepts for ``<<EOF``: it would keep reading, so the block this
#: module extracted would not be the block bash executes. See
#: :func:`_heredoc_body_ends_at`.
HEREDOC_DELIMITER: Final = "EOF"

#: Truncating (``>``) opens the document; appending (``>>``) extends it.
TRUNCATING_REDIRECT: Final = ">"

#: The one guard the generated document legitimately sits behind, as the generator
#: writes it (``configure-helper.sh`` line 1065). Every heredoc that targets the
#: admission configuration is inside this ``if`` and nothing deeper: that is what
#: "unconditional" means for this module - emitted on every GCE master that
#: configures admission control at all.
#:
#: MATCHED, NOT ASSUMED. If the condition itself changes - ``-n`` to ``-z``, a
#: different variable, an added ``&&`` - the guard chain no longer matches and the
#: extractor aborts rather than assembling a document whose emission condition
#: nobody re-read.
ADMISSION_CONTROL_GUARD_PATTERN: Final = re.compile(
    r'^\[\[\s+-n\s+"\$\{ADMISSION_CONTROL:-\}"\s+\]\]$'
)

#: Shell keywords that OPEN a frame, and whether entering that frame is conditional.
#:
#: ``if``, ``case`` and the three loop keywords are conditional: a command inside
#: one runs only when a test succeeds or a list is non-empty. ``function`` and a
#: brace group are not - they are structure, not choice - but they must still be
#: tracked, because an untracked ``}`` would pop a conditional frame that is still
#: open and every block after that point would be misattributed.
_CONDITIONAL_OPENERS: Final[frozenset[str]] = frozenset({"if", "case", "for", "while", "until"})

#: Keywords that CLOSE a frame, mapped to the openers they may close. A mismatch is
#: reported rather than absorbed: it means the scanner has lost track of the script,
#: and a scanner that has lost track produces confident nonsense.
_CLOSERS: Final[dict[str, frozenset[str]]] = {
    "fi": frozenset({"if"}),
    "esac": frozenset({"case"}),
    "done": frozenset({"for", "while", "until"}),
}

#: Tokens after which the NEXT token is in command position, so a word matching a
#: keyword there is that keyword rather than an argument. ``echo if`` must not open
#: a frame, and ``[[ -f done ]]`` must not close one.
_COMMAND_POSITION_AFTER: Final[frozenset[str]] = frozenset(
    {";", ";;", "&&", "||", "|", "&", "(", ")", "{", "}", "then", "else", "do", "!", "elif",
     "if", "while", "until", "time"}
)

#: Shell operators the tokenizer emits as tokens of their own, longest first so
#: ``<<<`` is never read as ``<<`` plus ``<`` - the difference between a here-STRING
#: and a here-DOCUMENT, and the reason the seven ``read -ra FLAGS <<< "$1"`` lines in
#: the generator do not each look like an unterminated heredoc.
_OPERATORS: Final[tuple[str, ...]] = (
    "<<<", "<<-", "<<", ">>", ">&", ">", "<", "&&", "||", ";;", ";", "|", "&", "(", ")",
)

#: Measured block census. Asserted, not assumed: if the generator is ever refactored
#: so that these change, the structural test FAILS and a human decides what the new
#: shape means, instead of the extractor silently including or dropping a block.
EXPECTED_TARGET_BLOCKS: Final = 4
EXPECTED_UNCONDITIONAL_BLOCKS: Final = 3
EXPECTED_TRUNCATING_BLOCKS: Final = 1

#: The plugin whose block is guarded and therefore excluded from the assembly.
CONDITIONAL_PLUGIN_NAME: Final = "ImagePolicyWebhook"

#: Outer envelope - the AdmissionConfiguration document itself.
ADMISSION_CONFIG_API_VERSION: Final = "apiserver.config.k8s.io/v1"
ADMISSION_CONFIG_KIND: Final = "AdmissionConfiguration"

#: Inner envelope - a DIFFERENT API group from the outer one.
POD_SECURITY_API_VERSION: Final = "pod-security.admission.config.k8s.io/v1"
POD_SECURITY_KIND: Final = "PodSecurityConfiguration"

#: Plugin names. ``PodSecurity`` is the subject of F-002-RQ-001; ``ResourceQuota`` is
#: asserted present only, because it is a fact of the assembled document.
POD_SECURITY_PLUGIN_NAME: Final = "PodSecurity"
RESOURCE_QUOTA_PLUGIN_NAME: Final = "ResourceQuota"

#: The six ``defaults`` keys and their required values, as an immutable tuple of pairs
#: rather than a dict: module-level mutable state would be shared across tests and
#: across ``pytest-xdist`` workers (AAP §0.11.1 B10).
#:
#: The levels are the constants in
#: staging/src/k8s.io/pod-security-admission/api/constants.go (``privileged`` /
#: ``baseline`` / ``restricted``) and ``VersionLatest``. ``warn`` and ``audit`` are
#: STRICTER than ``enforce`` on purpose: tech-spec §6.4.4.3's zero-downtime rollout
#: reports ``restricted`` violations without rejecting the workloads that commit them,
#: while ``enforce`` holds the line at ``baseline``. Relaxing either to make a run
#: green would undo V2 (AAP §0.11.1 B8).
EXPECTED_DEFAULTS: Final[tuple[tuple[str, str], ...]] = (
    ("enforce", "baseline"),
    ("enforce-version", "latest"),
    ("warn", "restricted"),
    ("warn-version", "latest"),
    ("audit", "restricted"),
    ("audit-version", "latest"),
)

#: The three ``exemptions`` keys and their required values. Empty for principals and
#: runtime classes, and exactly one namespace.
#:
#: ``namespaces: ["kube-system"]`` is the CLUSTER-LEVEL half of one documented
#: control-plane exemption. Its NAMESPACE-LEVEL half is the ``kube-system`` Namespace's
#: ``pod-security.kubernetes.io/enforce: privileged`` label in
#: cluster/manifests/namespace-pss-labels.yaml, asserted by the sibling module
#: tests/unit/config/test_namespace_pss_labels.py, whose own comment records that the
#: two mirror each other. Adding a second namespace here would silently widen the
#: exemption on one side only, so the comparison below is exact.
EXPECTED_EXEMPTIONS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("usernames", ()),
    ("runtimeClasses", ()),
    ("namespaces", ("kube-system",)),
)


# ---------------------------------------------------------------------------
# The extractor. Pure functions over the script text; no I/O except the single
# read of the generator, and no state that outlives a call.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ShellFrame:
    """One open shell compound command at some point in the script.

    Frozen: a frame is a record of what the scanner saw, and a mutable one could be
    edited by a later line into describing something that never happened.

    Attributes:
        keyword: The opener as the script spells it - ``if``, ``elif``, ``else``,
            ``case``, ``for``, ``while``, ``until`` - or ``group`` for a brace group
            and a function body. ``elif``/``else`` REPLACE the ``if`` they continue
            rather than nesting inside it, because they are alternatives in one
            construct: the depth of a command in an ``else`` arm is the same as in
            the ``then`` arm.
        condition: The condition as written, joined with single spaces, or ``""``
            for ``else``, a loop head this module does not need, or a group. Carried
            so the guard can be MATCHED rather than merely counted.
        opening_line: One-based line of the opener, for failure legibility.
        conditional: Whether reaching a command inside this frame depends on a test
            or on a list being non-empty. False for a function body and a brace
            group, which are structure rather than choice.
    """

    keyword: str
    condition: str
    opening_line: int
    conditional: bool


@dataclass(frozen=True)
class HeredocBlock:
    """One ``cat <<EOF >…admission_controller_config.yaml`` block in the generator.

    Frozen so that a block cannot be edited after extraction: the census assertions
    and the assembly both read the same objects, and a mutable record would let one
    of them change what the other sees.

    Attributes:
        opening_line: One-based line number of the ``cat <<EOF …`` line. Carried for
            FAILURE LEGIBILITY - it puts a reviewer straight on the offending line -
            and never asserted against, because line numbers drift.
        redirect: ``>`` (truncate, opens the document) or ``>>`` (append, extends it).
        target: The redirection target as written, unquoted. This is the FIRST
            discriminator: it is what tells the admission-configuration blocks apart
            from the ``gcp_image_review.kubeconfig`` block three lines away, which is
            otherwise an identical ``cat <<EOF`` in the same ``if`` branch.
        delimiter: The heredoc word, unquoted - ``EOF`` for every form the generator
            uses.
        dash: Whether the operator was ``<<-``, which is the ONLY form under which
            bash strips anything from the delimiter line, and then only leading tabs.
        quoted: Whether the delimiter was quoted or escaped (``<<'EOF'``, ``<<"EOF"``,
            ``<<\\EOF``), which suppresses expansion inside the body. Recorded because
            it changes what the body MEANS: an unquoted body containing ``${...}`` is
            a template, and this module refuses to read a template statically.
        closing_line: One-based line number of the terminating delimiter, or ``None``
            when the block is unterminated - which would mean the script no longer
            parses as bash and is reported as setup breakage.
        body: The heredoc body, verbatim and without the delimiter lines.
        guards: The CONDITIONAL frames enclosing the opener, outermost first. This is
            the conditionality of the block, derived from the script's actual control
            flow: ``()`` means the block is emitted whenever the enclosing function
            runs, one frame means it sits behind one test, and more means it is
            nested deeper. Indentation is deliberately NOT recorded, because it was
            the previous discriminator and it is cosmetic: bash is happy to place a
            guarded heredoc at the same indent as an unguarded one, and this module
            then approved a block the generator would not necessarily emit.
    """

    opening_line: int
    redirect: str
    target: str
    delimiter: str
    dash: bool
    quoted: bool
    closing_line: int | None
    body: tuple[str, ...]
    guards: tuple[ShellFrame, ...]

    @property
    def truncates(self) -> bool:
        """True when this block OPENS the generated document rather than extending it."""
        return self.redirect == TRUNCATING_REDIRECT

    @property
    def is_terminated(self) -> bool:
        """True when a closing delimiter was found for this block."""
        return self.closing_line is not None

    @property
    def guard_conditions(self) -> tuple[str, ...]:
        """The enclosing conditions as written, outermost first."""
        return tuple(frame.condition for frame in self.guards)


def read_generator_text(repo_root: Path) -> str:
    """Return the text of the shipped generator.

    The generator is a READ-ONLY committed input (AAP §0.11.1 B4): this module extracts
    from it and asserts against it, and never edits it or re-implements it in Python -
    re-implementing it would forfeit the whole point, which is that the tests exercise
    the artifact that actually ships.

    Aborts rather than accumulating: with no script there is nothing for any assertion
    in this module to mean.

    Args:
        repo_root: The repository root, from the session-scoped ``repo_root`` fixture.

    Returns:
        The full text of ``cluster/gce/gci/configure-helper.sh``.
    """
    __tracebackhide__ = True
    relative = "/".join(GENERATOR_PATH_PARTS)
    path = repo_root.joinpath(*GENERATOR_PATH_PARTS)
    assert path.is_file(), (
        f"{REQUIREMENT}: SETUP BREAKAGE - the shipped generator {relative} is not a file "
        f"under the repository root {repo_root} (resolved to {path}). This module reads "
        f"that script to recover the admission configuration it generates, so without it "
        f"no assertion here means anything."
    )
    text = path.read_text(encoding="utf-8")
    assert text.strip(), (
        f"{REQUIREMENT}: SETUP BREAKAGE - {relative} is empty, so no heredoc can be "
        f"extracted from it."
    )
    return text


def _tokenize_shell_line(
    line: str, *, carry: str = "", open_quote: str = ""
) -> tuple[list[str], str, str, bool]:
    """Split one physical line into shell tokens, honouring quotes and comments.

    A RESTRICTED tokenizer, and restricted on purpose: it exists to answer two
    questions - which words are in command position, and where does a heredoc open -
    and it answers them the way bash does for the constructs this generator actually
    uses. It is not a shell, and every construct it cannot account for is reported by
    :func:`scan_heredocs` as setup breakage rather than guessed at.

    What it handles, each because the generator contains it:

    * ``'...'`` and ``"..."`` quoting, INCLUDING strings that span lines. The
      generator embeds a multi-line Python program inside a single-quoted string
      (lines 1912-1932), and a tokenizer that reset its quote state at each newline
      read that program's ``for attempt in range(...)`` as a shell ``for`` loop -
      leaving a frame open that nothing ever closed and misattributing the guard
      chain of everything after it. Quote state therefore crosses lines, which is
      what ``open_quote`` and ``carry`` are for.
    * Backslash escapes outside single quotes, and a trailing backslash as a line
      continuation.
    * ``#`` as a comment only at the start of a word. ``${VAR#prefix}`` and
      ``${VAR##*/}`` are parameter expansions, not comments, and the generator uses
      both.
    * ``${...}`` and ``$(...)`` as opaque single tokens. Their contents are balanced
      by construction, and treating them as text is what stops a keyword inside a
      command substitution from opening a frame that nothing closes.
    * The operators in :data:`_OPERATORS`, longest match first, so ``<<<`` is a
      here-string and never ``<<`` plus ``<``.

    Quotes are KEPT in the token so a heredoc delimiter's quoting survives; a caller
    comparing against a keyword unquotes first, which is why ``echo "if"`` cannot
    open a frame.

    Args:
        line: One physical line, without its newline.
        carry: A partial token from the previous physical line, when the logical line
            continues.
        open_quote: The quote character still open from the previous physical line, or
            ``""``.

    Returns:
        ``(tokens, carry, open_quote, continues)``. ``carry`` and ``open_quote`` are
        the state to pass to the next physical line; ``continues`` is True when the
        line ended in an unescaped backslash. The logical line is complete when
        ``continues`` is False and ``open_quote`` is empty.
    """
    tokens: list[str] = []
    current = carry
    index = 0
    length = len(line)
    continues = False

    def flush() -> None:
        nonlocal current
        if current:
            tokens.append(current)
            current = ""

    if open_quote:
        closing = line.find(open_quote, index)
        while closing != -1 and open_quote == '"' and closing > 0 and line[closing - 1] == "\\":
            closing = line.find(open_quote, closing + 1)
        if closing == -1:
            # Still inside the string. Keep it as one token, with the newline, so a
            # keyword on this line cannot be read as shell.
            return [], current + line + "\n", open_quote, False
        current += line[: closing + 1]
        index = closing + 1
        open_quote = ""

    while index < length:
        char = line[index]

        if char == "\\":
            if index + 1 == length:
                # An unescaped trailing backslash: the logical line continues.
                continues = True
                index += 1
                continue
            current += line[index : index + 2]
            index += 2
            continue

        if char == "#" and not current:
            break  # A comment, and it runs to the end of the line.

        if char in "'\"":
            closing = line.find(char, index + 1)
            while closing != -1 and char == '"' and line[closing - 1] == "\\":
                closing = line.find(char, closing + 1)
            if closing == -1:
                # An unterminated quote: the string continues on the next line.
                return tokens, current + line[index:] + "\n", char, False
            current += line[index : closing + 1]
            index = closing + 1
            continue

        if char == "$" and index + 1 < length and line[index + 1] in "{(":
            opener = line[index + 1]
            closer = "}" if opener == "{" else ")"
            depth = 0
            cursor = index + 1
            while cursor < length:
                if line[cursor] == opener:
                    depth += 1
                elif line[cursor] == closer:
                    depth -= 1
                    if depth == 0:
                        break
                cursor += 1
            if cursor >= length:
                current += line[index:]
                index = length
                continue
            current += line[index : cursor + 1]
            index = cursor + 1
            continue

        if char.isspace():
            flush()
            index += 1
            continue

        operator = next((op for op in _OPERATORS if line.startswith(op, index)), None)
        if operator is not None:
            flush()
            tokens.append(operator)
            index += len(operator)
            continue

        if char in "{}":
            # Braces are tokens only when they stand alone as words: `${x}` was
            # consumed above, and `foo{bar}` and `{}` are words.
            if not current and (index + 1 == length or line[index + 1].isspace()):
                tokens.append(char)
                index += 1
                continue
            current += char
            index += 1
            continue

        current += char
        index += 1

    if continues:
        return tokens, current, "", True
    flush()
    return tokens, "", "", False


def _unquote(token: str) -> str:
    """The token's literal text, with one layer of quoting or escaping removed."""
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "'\"":
        return token[1:-1]
    if token.startswith("\\"):
        return token[1:]
    return token


def _is_quoted(token: str) -> bool:
    """Whether the token carried quoting or escaping, which suppresses expansion."""
    return (len(token) >= 2 and token[0] == token[-1] and token[0] in "'\"") or token.startswith(
        "\\"
    )


def _heredoc_body_ends_at(line: str, delimiter: str, *, dash: bool) -> bool:
    """Whether ``line`` is the terminating delimiter line, by BASH's rule.

    ``<<WORD`` requires the line to BE the word - no leading whitespace, no trailing
    whitespace, nothing else. ``<<-WORD`` strips leading TABS only, and never spaces.
    This is the whole of the rule, and the reason it is a function rather than a
    ``strip()`` call: a trimmed comparison accepts ``   EOF``, ``EOF   `` and
    ``\\tEOF`` under ``<<EOF``, and bash accepts none of them. It would keep reading
    to the next candidate, so the body this module extracted, the census it asserts
    and the document it assembles would all describe a script bash does not run.
    """
    candidate = line.lstrip("\t") if dash else line
    return candidate == delimiter


def scan_heredocs(script_text: str) -> tuple[HeredocBlock, ...]:
    """Scan the script's real control flow and return every heredoc it opens.

    THIS REPLACES AN INDENTATION HEURISTIC, and the reason is not tidiness. A block's
    conditionality is a property of the ``if``/``fi`` structure enclosing it, and
    bash does not care about indentation: a guarded heredoc re-indented to the
    unguarded level read as unconditional, and a PodSecurity block moved behind a
    default-false guard would have been extracted, assembled and approved by every
    assertion in this module. Conditionality is now derived from the frames actually
    open at the opening line.

    HOW IT WORKS. One pass over physical lines, joining logical lines across
    unescaped backslashes, tracking a stack of :class:`ShellFrame`. Heredoc bodies
    are consumed whole and never interpreted, so a ``fi`` inside a YAML body cannot
    close a frame. A word is treated as a keyword only in command position and only
    unquoted.

    WHAT IT REFUSES. Anything that means it has lost track of the script: a closer
    with no matching opener, a closer whose opener is of the wrong kind, an
    unterminated heredoc, or a non-empty frame stack at end of file. Each of those
    would leave the guard chains after that point wrong, and a wrong guard chain is
    exactly the failure this scanner exists to prevent - so it aborts instead.

    Args:
        script_text: The generator's full text.

    Returns:
        Every heredoc block in FILE ORDER, each carrying the conditional frames that
        enclose it. Filtering to the ones this module cares about is
        :func:`extract_target_heredocs`'s job.

    Raises:
        AssertionError: Through :func:`pytest.fail`, on any structure the scanner
            cannot account for.
    """
    __tracebackhide__ = True
    lines = script_text.splitlines()
    frames: list[ShellFrame] = []
    blocks: list[HeredocBlock] = []
    # A pending `if`/`elif` whose condition is still being read: bash allows `then`
    # on a later line, and the generator uses both forms.
    pending_condition: list[str] | None = None
    index = 0

    while index < len(lines):
        first_line_number = index + 1
        tokens: list[str] = []
        carry = ""
        open_quote = ""
        while index < len(lines):
            line_tokens, carry, open_quote, continues = _tokenize_shell_line(
                lines[index], carry=carry, open_quote=open_quote
            )
            tokens.extend(line_tokens)
            index += 1
            # A logical line ends only when neither a backslash nor an open quote
            # carries it onward. Ending it at the newline instead is what let a
            # multi-line Python string inside the generator be read as shell.
            if not continues and not open_quote:
                break

        command_position = True
        position = 0
        pending_heredocs: list[tuple[str, bool, bool]] = []
        redirect_targets: list[tuple[str, str]] = []

        while position < len(tokens):
            token = tokens[position]
            word = _unquote(token)

            if token in ("<<", "<<-") and position + 1 < len(tokens):
                delimiter_token = tokens[position + 1]
                pending_heredocs.append(
                    (_unquote(delimiter_token), token == "<<-", _is_quoted(delimiter_token))
                )
                position += 2
                command_position = False
                continue

            if token in (">", ">>") and position + 1 < len(tokens):
                redirect_targets.append((token, _unquote(tokens[position + 1])))
                position += 2
                command_position = False
                continue

            if word == "{" and token == word:
                # A brace GROUP or a function body. Not gated on command position:
                # `function name {` and `name() {` both put the brace after a word,
                # and an unpushed frame would let the matching `}` pop a conditional
                # frame that is still open - silently shifting every guard chain
                # after it.
                frames.append(
                    ShellFrame(
                        keyword="group",
                        condition="",
                        opening_line=first_line_number,
                        conditional=False,
                    )
                )
                position += 1
                command_position = True
                continue

            if word == "}" and token == word:
                if not frames or frames[-1].keyword != "group":
                    pytest.fail(
                        f"{REQUIREMENT}: SETUP BREAKAGE - `}}` at line "
                        f"{first_line_number} of the generator closes "
                        f"{frames[-1].keyword if frames else 'nothing'}, not a brace group "
                        f"or function body. The scanner has lost track of the script."
                    )
                frames.pop()
                position += 1
                command_position = True
                continue

            if command_position and token == word:
                if word in ("if", "elif"):
                    if word == "elif":
                        if not frames or frames[-1].keyword not in ("if", "elif", "else"):
                            pytest.fail(
                                f"{REQUIREMENT}: SETUP BREAKAGE - `elif` at line "
                                f"{first_line_number} of the generator continues no open `if`. "
                                f"The scanner has lost track of the script, so every guard "
                                f"chain after this point would be wrong."
                            )
                        frames.pop()
                    pending_condition = []
                    frames.append(
                        ShellFrame(
                            keyword=word,
                            condition="",
                            opening_line=first_line_number,
                            conditional=True,
                        )
                    )
                    position += 1
                    command_position = True
                    continue

                if word == "then":
                    if pending_condition is not None and frames:
                        frames[-1] = ShellFrame(
                            keyword=frames[-1].keyword,
                            condition=" ".join(pending_condition),
                            opening_line=frames[-1].opening_line,
                            conditional=True,
                        )
                        pending_condition = None
                    position += 1
                    command_position = True
                    continue

                if word == "else":
                    if not frames or frames[-1].keyword not in ("if", "elif"):
                        pytest.fail(
                            f"{REQUIREMENT}: SETUP BREAKAGE - `else` at line "
                            f"{first_line_number} of the generator continues no open `if`."
                        )
                    replaced = frames.pop()
                    frames.append(
                        ShellFrame(
                            keyword="else",
                            condition=f"! ({replaced.condition})",
                            opening_line=first_line_number,
                            conditional=True,
                        )
                    )
                    position += 1
                    command_position = True
                    continue

                if word in ("case", "for", "while", "until"):
                    frames.append(
                        ShellFrame(
                            keyword=word,
                            condition="",
                            opening_line=first_line_number,
                            conditional=word in _CONDITIONAL_OPENERS,
                        )
                    )
                    position += 1
                    command_position = word in ("while", "until")
                    continue

                if word in _CLOSERS:
                    expected = _CLOSERS[word]
                    if not frames:
                        pytest.fail(
                            f"{REQUIREMENT}: SETUP BREAKAGE - `{word}` at line "
                            f"{first_line_number} of the generator closes nothing. The "
                            f"scanner cannot account for the script's structure, so the "
                            f"conditionality it would report is unreliable."
                        )
                    # `elif`/`else` stand in for the `if` they continue.
                    open_kind = frames[-1].keyword
                    normalised = "if" if open_kind in ("elif", "else") else open_kind
                    if normalised not in expected:
                        pytest.fail(
                            f"{REQUIREMENT}: SETUP BREAKAGE - `{word}` at line "
                            f"{first_line_number} of the generator closes a "
                            f"`{frames[-1].keyword}` opened at line "
                            f"{frames[-1].opening_line}, which it cannot close."
                        )
                    frames.pop()
                    position += 1
                    command_position = True
                    continue

            if pending_condition is not None and token not in (";", "then"):
                pending_condition.append(token)

            command_position = token in _COMMAND_POSITION_AFTER
            position += 1

        # Heredoc bodies belong to the logical line that opened them, are read in
        # the order the operators appeared, and are never interpreted as shell.
        for delimiter, dash, quoted in pending_heredocs:
            body: list[str] = []
            closing_line: int | None = None
            while index < len(lines):
                if _heredoc_body_ends_at(lines[index], delimiter, dash=dash):
                    closing_line = index + 1
                    index += 1
                    break
                body.append(lines[index])
                index += 1
            redirect, target = redirect_targets[0] if redirect_targets else ("", "")
            blocks.append(
                HeredocBlock(
                    opening_line=first_line_number,
                    redirect=redirect,
                    target=target,
                    delimiter=delimiter,
                    dash=dash,
                    quoted=quoted,
                    closing_line=closing_line,
                    body=tuple(body),
                    guards=tuple(frame for frame in frames if frame.conditional),
                )
            )

    if frames:
        pytest.fail(
            f"{REQUIREMENT}: SETUP BREAKAGE - the generator ends with "
            f"{len(frames)} unclosed shell frame(s): "
            f"{[(frame.keyword, frame.opening_line) for frame in frames]}. Either the "
            f"script no longer parses as bash, or it uses a construct this scanner does "
            f"not model - and in the second case the guard chains it reported are not "
            f"trustworthy either. Extend the scanner rather than relaxing this check."
        )
    return tuple(blocks)


def extract_target_heredocs(script_text: str) -> tuple[HeredocBlock, ...]:
    """Every heredoc in ``script_text`` that targets the admission config file.

    Discrimination is on the TARGET FILE NAME, which is what keeps the neighbouring
    ``gcp_image_review.kubeconfig`` heredoc out of the result: it is a ``cat <<EOF``
    block in the same ``if`` branch, and a rule that matched on ``cat <<EOF`` alone
    would fold a kubeconfig into the assembled YAML.

    Args:
        script_text: The generator's full text.

    Returns:
        The matching blocks in FILE ORDER. Order is part of the contract - the
        truncating block opens the document and the appending blocks extend it, so
        assembling them out of order would produce different YAML.
    """
    __tracebackhide__ = True
    return tuple(
        block
        for block in scan_heredocs(script_text)
        if block.redirect in (">", ">>") and block.target == ADMISSION_CONFIG_TARGET
    )


def split_unconditional_blocks(
    blocks: Sequence[HeredocBlock],
) -> tuple[tuple[HeredocBlock, ...], tuple[HeredocBlock, ...]]:
    """Split ``blocks`` by their ACTUAL guard chain, not by how they are indented.

    THE DISCRIMINATOR IS SHELL CONTROL FLOW. A block is unconditional when the only
    conditional frame enclosing it is the one guard the generated document
    legitimately sits behind - ``[[ -n "${ADMISSION_CONTROL:-}" ]]``, matched against
    :data:`ADMISSION_CONTROL_GUARD_PATTERN` rather than merely counted - and
    conditional when it is nested deeper. So a PodSecurity block moved behind an
    added guard is classified as conditional, drops out of the assembly, and fails
    the census and every value assertion below, which is exactly what should happen
    to a block whose emission has quietly become optional.

    Aborts if the truncating block is missing, duplicated or not first, if any block
    has no guard at all, or if any block's outermost guard is not the expected one:
    each of those means the document's emission condition is no longer the one this
    module verified, and every downstream assertion would be reading a shape nobody
    checked.

    Args:
        blocks: Blocks targeting the admission config file, in file order.

    Returns:
        ``(unconditional, conditional)``, both in file order.
    """
    __tracebackhide__ = True
    assert blocks, (
        f"{REQUIREMENT}: SETUP BREAKAGE - no heredoc in the generator targets the "
        f"admission configuration file {ADMISSION_CONFIG_TARGET}. Either the generator "
        f"stopped producing it or it is now written some other way."
    )
    truncating = [block for block in blocks if block.truncates]
    assert len(truncating) == EXPECTED_TRUNCATING_BLOCKS, (
        f"{REQUIREMENT}: SETUP BREAKAGE - expected exactly {EXPECTED_TRUNCATING_BLOCKS} "
        f"truncating ('{TRUNCATING_REDIRECT}') heredoc to open the generated document, "
        f"found {len(truncating)} at line(s) "
        f"{[block.opening_line for block in truncating]}. More than one means the "
        f"document is rewritten part-way through and the assembly below would not be "
        f"what ships."
    )
    assert blocks[0].truncates, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the FIRST heredoc targeting the admission "
        f"configuration file (line {blocks[0].opening_line}) appends "
        f"('{blocks[0].redirect}') rather than truncating, so the document does not begin "
        f"where this module assembles it from. The truncating block is at line "
        f"{truncating[0].opening_line}."
    )

    unguarded = [block.opening_line for block in blocks if not block.guards]
    assert not unguarded, (
        f"{REQUIREMENT}: SETUP BREAKAGE - block(s) at line(s) {unguarded} sit behind no "
        f"condition at all. Every heredoc targeting the admission configuration is "
        f"expected to be inside the `{ADMISSION_CONTROL_GUARD_PATTERN.pattern}` guard, so "
        f"a block outside it means the generator's structure changed and a human must "
        f"decide what the new shape means."
    )
    misguarded = [
        (block.opening_line, block.guards[0].condition)
        for block in blocks
        if ADMISSION_CONTROL_GUARD_PATTERN.match(block.guards[0].condition) is None
    ]
    assert not misguarded, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the outermost guard of block(s) {misguarded} is "
        f"not the expected admission-control guard "
        f"({ADMISSION_CONTROL_GUARD_PATTERN.pattern}). The condition under which the "
        f"generated document is written has changed, so what this module calls "
        f"'unconditional' would no longer be what a master actually receives."
    )

    unconditional = tuple(block for block in blocks if len(block.guards) == 1)
    conditional = tuple(block for block in blocks if len(block.guards) > 1)
    return unconditional, conditional


def assemble_admission_config(blocks: Sequence[HeredocBlock]) -> str:
    """Concatenate the bodies of ``blocks``, in order, into the generated document.

    The envelope block must come first because it carries the ``plugins:`` key that the
    others append list items to; ``blocks`` is therefore expected in file order, which
    is the order :func:`extract_target_heredocs` returns. A trailing newline is added
    because the shell redirection that writes each body leaves one, so the file on a
    real master ends with one too.

    Args:
        blocks: The unconditional blocks, in file order.

    Returns:
        The assembled YAML document text.
    """
    __tracebackhide__ = True
    body_lines = [line for block in blocks for line in block.body]
    assert body_lines, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the blocks selected for assembly have no body "
        f"lines between them, so there is no generated document to assert on."
    )
    return "\n".join(body_lines) + "\n"


#: Every character that makes an UNQUOTED heredoc body a template rather than content.
#: Measured, not assumed: all five openers in the generator are ``cat <<EOF`` with an
#: UNQUOTED delimiter (configure-helper.sh lines 1069, 1076, 1094, 1121, 1141), so Bash
#: performs parameter expansion, command substitution and arithmetic expansion inside
#: them. A guard testing only for ``${`` therefore misses four of the five forms:
#:
#:   ``$NAME``      bare parameter expansion - the commonest form, and invisible to '${'
#:   ``${NAME}``    braced parameter expansion - the only form the previous guard caught
#:   ``$(cmd)``     command substitution
#:   ```cmd```      backtick command substitution, the older spelling of the same thing
#:   ``$((expr))``  arithmetic expansion
#:
#: A single unescaped ``$`` or backtick is sufficient to catch all five, because each
#: form begins with one of those two characters. ``\$`` and ``\```` are escaped and
#: produce a literal, so the lookbehind excludes them - that is a real distinction, not
#: a nicety: an escaped dollar in a body is still literal content.
#:
#: EXACT AND FALSE-POSITIVE FREE, measured against the artefact: the three unconditional
#: bodies (3, 10 and 15 lines) contain ZERO unescaped ``$`` and ZERO backticks, so this
#: strict form flags nothing today and flags any future templating immediately.
_SHELL_EXPANSION_RE: Final = re.compile(r"(?<!\\)[$`]")


def find_shell_expansions(text: str) -> tuple[tuple[int, str], ...]:
    """Locate every line of ``text`` carrying an unescaped ``$`` or backtick.

    Returns line NUMBERS as well as content because the whole point of the guard is to
    send a reader to the offending line of the generator; "the text contains an
    expansion" without saying where is a finding nobody can act on.

    Args:
        text: The assembled heredoc body text.

    Returns:
        A tuple of ``(1-based line number, line)`` for each offending line, in order.
        Empty when the text is fully literal.
    """
    return tuple(
        (number, line)
        for number, line in enumerate(text.splitlines(), start=1)
        if _SHELL_EXPANSION_RE.search(line) is not None
    )


def generated_admission_config(repo_root: Path) -> Mapping[str, Any]:
    """Recover and parse the admission configuration the generator emits by default.

    "By default" means with ``ADMISSION_CONTROL`` set - the outer guard - and without
    ``ImagePolicyWebhook`` requested, which is the shape every GCE master gets unless an
    operator asks for that plugin.

    Every failure here is SETUP BREAKAGE and aborts, because a document that could not
    be recovered or parsed makes each of the value assertions downstream vacuous rather
    than merely wrong.

    Args:
        repo_root: The repository root, from the session-scoped ``repo_root`` fixture.

    Returns:
        The parsed ``AdmissionConfiguration`` document.
    """
    __tracebackhide__ = True
    blocks = extract_target_heredocs(read_generator_text(repo_root))
    unconditional, _ = split_unconditional_blocks(blocks)
    text = assemble_admission_config(unconditional)
    # Static extraction is sound only while the extracted text is literal. A shell
    # expansion here would mean the bodies are templates rather than content, so the
    # right response is to fail loudly and move the assertion to the shell tier - not to
    # guess at a substitution. Every expansion form is rejected, not just '${': the
    # heredocs are UNQUOTED, so `$NAME`, `$(cmd)`, backticks and `$((expr))` all expand
    # too, and each would make this reader assert against a template.
    expansions = find_shell_expansions(text)
    assert not expansions, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the generated admission configuration now "
        f"contains {len(expansions)} line(s) with an unescaped '$' or backtick, so its "
        f"text is no longer literal and reading it statically is no longer valid. The "
        f"heredocs are unquoted (cat <<EOF), so these expand on a real master. Assert it "
        f"from the shell-boundary tier (tests/unit/shell/) against the real generator "
        f"instead.\n"
        f"--- offending lines ---\n"
        + "\n".join(f"  {number}: {line}" for number, line in expansions)
        + f"\n--- assembled ---\n{text}"
    )
    document = yaml.safe_load(text)
    assert isinstance(document, dict), (
        f"{REQUIREMENT}: SETUP BREAKAGE - the assembled admission configuration did not "
        f"parse to a YAML mapping (got {type(document).__name__}). The heredoc bodies are "
        f"probably being assembled in the wrong order or one of them is missing.\n"
        f"--- assembled ---\n{text}"
    )
    return document


def plugin_names(document: Mapping[str, Any]) -> tuple[str, ...]:
    """Return the ``name`` of every entry in the document's plugin list, in order.

    Aborts when ``plugins`` is missing or is not a list: the plugin list is the whole
    payload of an ``AdmissionConfiguration``, and without it there is no PodSecurity
    block to find.

    Args:
        document: The parsed ``AdmissionConfiguration`` document.

    Returns:
        The declared plugin names, in document order.
    """
    __tracebackhide__ = True
    plugins = document.get("plugins")
    assert isinstance(plugins, list), (
        f"{REQUIREMENT}: the generated AdmissionConfiguration has no 'plugins' list "
        f"(got {type(plugins).__name__}), so it configures no admission plugin at all - "
        f"PodSecurity included."
    )
    return tuple(
        str(entry.get("name")) for entry in plugins if isinstance(entry, dict) and "name" in entry
    )


def pod_security_configuration(document: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return the ``PodSecurity`` plugin's ``configuration``, located BY NAME.

    NEVER BY INDEX. The measured plugin list is ``[ResourceQuota, PodSecurity]``, so
    ``plugins[0]`` is the ResourceQuota entry and an index-based lookup would assert
    PodSecurity's requirements against a resource-quota block - and would keep passing
    or failing for reasons that have nothing to do with Pod Security. Order is not part
    of F-002-RQ-001 and is deliberately not asserted anywhere in this module; by-name
    lookup is what makes that safe.

    Aborts when the plugin is absent or declared more than once. Absent means Pod
    Security is not configured at all, which is the V2 weakness itself; duplicated means
    two blocks compete and which one the API server honours is not something a test
    should guess at.

    Args:
        document: The parsed ``AdmissionConfiguration`` document.

    Returns:
        The ``PodSecurityConfiguration`` mapping.
    """
    __tracebackhide__ = True
    plugins = document.get("plugins")
    assert isinstance(plugins, list), (
        f"{REQUIREMENT}: the generated AdmissionConfiguration has no 'plugins' list "
        f"(got {type(plugins).__name__}), so the {POD_SECURITY_PLUGIN_NAME} plugin cannot "
        f"be configured."
    )
    matches = [
        entry
        for entry in plugins
        if isinstance(entry, dict) and entry.get("name") == POD_SECURITY_PLUGIN_NAME
    ]
    assert len(matches) == 1, (
        f"{REQUIREMENT}: expected exactly one plugin named '{POD_SECURITY_PLUGIN_NAME}' in "
        f"the generated AdmissionConfiguration, found {len(matches)}. Declared plugins: "
        f"{list(plugin_names(document))}. None means Pod Security is not enforced at all; "
        f"more than one means competing configurations."
    )
    configuration = matches[0].get("configuration")
    assert isinstance(configuration, dict), (
        f"{REQUIREMENT}: the '{POD_SECURITY_PLUGIN_NAME}' plugin carries no "
        f"'configuration' mapping (got {type(configuration).__name__}). Without it every "
        f"mode falls back to the built-in default of 'privileged'."
    )
    return configuration


# ---------------------------------------------------------------------------
# 1. The extractor sees exactly the unconditional heredocs
# ---------------------------------------------------------------------------


def test_extractor_sees_exactly_the_unconditional_heredocs(repo_root: Path) -> None:
    """INVARIANT: the generator's unconditional blocks are exactly the ones assembled.

    This is the mandatory structural assertion, and it is the reason the rest of the
    module can be trusted. It pins the SHAPE of the generator - how many heredocs target
    the admission configuration, how many are unconditional, which one opens the
    document, and that the excluded one is the guarded ``ImagePolicyWebhook`` block -
    without pinning a single line number, which would drift on any unrelated edit above.

    A refactor of the generator therefore FAILS HERE, loudly, and a human decides what
    the new shape means. The alternative - an extractor that quietly returns whatever it
    happens to find - would leave a silent coverage hole: drop the PodSecurity block and
    every value assertion below would vanish with it rather than fail.

    Abort semantics throughout (the ``t.Fatalf`` half of the split): each of these
    failures invalidates every other assertion in the module, so there is nothing to be
    gained by continuing.
    """
    blocks = extract_target_heredocs(read_generator_text(repo_root))

    assert len(blocks) == EXPECTED_TARGET_BLOCKS, (
        f"{REQUIREMENT}: expected exactly {EXPECTED_TARGET_BLOCKS} heredocs targeting the "
        f"generated admission configuration, found {len(blocks)} at line(s) "
        f"{[block.opening_line for block in blocks]}. The count is asserted so that a new "
        f"or removed block is a visible failure rather than a silent change of what this "
        f"module asserts on."
    )

    unterminated = [block.opening_line for block in blocks if not block.is_terminated]
    assert not unterminated, (
        f"{REQUIREMENT}: SETUP BREAKAGE - heredoc(s) opened at line(s) {unterminated} are "
        f"never closed by a '{HEREDOC_DELIMITER}' line, so the generator no longer parses "
        f"as bash and the extracted bodies are truncated."
    )

    truncating = [block for block in blocks if block.truncates]
    assert len(truncating) == EXPECTED_TRUNCATING_BLOCKS, (
        f"{REQUIREMENT}: expected exactly {EXPECTED_TRUNCATING_BLOCKS} truncating "
        f"('{TRUNCATING_REDIRECT}') redirect among the {len(blocks)} blocks, found "
        f"{len(truncating)} at line(s) {[block.opening_line for block in truncating]}."
    )
    assert blocks[0].truncates, (
        f"{REQUIREMENT}: the first block in file order (line {blocks[0].opening_line}) must "
        f"be the truncating one that OPENS the document; it redirects with "
        f"'{blocks[0].redirect}'."
    )

    unconditional, conditional = split_unconditional_blocks(blocks)

    assert len(unconditional) == EXPECTED_UNCONDITIONAL_BLOCKS, (
        f"{REQUIREMENT}: expected exactly {EXPECTED_UNCONDITIONAL_BLOCKS} blocks guarded "
        f"only by the admission-control test, found {len(unconditional)} at line(s) "
        f"{[block.opening_line for block in unconditional]}."
    )
    assert len(conditional) == EXPECTED_TARGET_BLOCKS - EXPECTED_UNCONDITIONAL_BLOCKS, (
        f"{REQUIREMENT}: expected exactly "
        f"{EXPECTED_TARGET_BLOCKS - EXPECTED_UNCONDITIONAL_BLOCKS} guarded block(s) to be "
        f"excluded, found {len(conditional)} at line(s) "
        f"{[block.opening_line for block in conditional]}."
    )

    # THE DISCRIMINATOR IS THE GUARD CHAIN, NOT THE INDENT. Every kept block is
    # enclosed by exactly one conditional frame and it is the admission-control guard;
    # every excluded block is enclosed by that guard AND at least one more. This is
    # what makes "unconditional" mean "emitted on every master that configures
    # admission control", and it is why re-indenting a guarded block can no longer
    # sweep it into the assembly: indentation is not consulted at all.
    for block in unconditional:
        assert len(block.guards) == 1, (
            f"{REQUIREMENT}: the block at line {block.opening_line} was selected as "
            f"unconditional but sits inside {len(block.guards)} conditional frame(s): "
            f"{[(frame.keyword, frame.opening_line, frame.condition) for frame in block.guards]}."
        )
        assert ADMISSION_CONTROL_GUARD_PATTERN.match(block.guards[0].condition), (
            f"{REQUIREMENT}: the block at line {block.opening_line} is guarded by "
            f"{block.guards[0].condition!r}, not by the expected admission-control test "
            f"{ADMISSION_CONTROL_GUARD_PATTERN.pattern}."
        )
    for block in conditional:
        assert len(block.guards) > 1, (
            f"{REQUIREMENT}: the block at line {block.opening_line} was excluded from the "
            f"assembly yet is enclosed by {len(block.guards)} conditional frame(s), so the "
            f"discriminator no longer distinguishes guarded from unguarded emission."
        )
        assert block.guards[0].condition == unconditional[0].guards[0].condition, (
            f"{REQUIREMENT}: the excluded block at line {block.opening_line} does not share "
            f"the outer admission-control guard "
            f"({block.guards[0].condition!r} vs "
            f"{unconditional[0].guards[0].condition!r}), so it is being dropped for some "
            f"reason other than being nested inside that guard."
        )

    # Bash's delimiter rule, asserted on the blocks themselves: the generator uses the
    # plain `<<EOF` form, whose body ends only at a line that IS `EOF`. A block that
    # switched to `<<-EOF` would change what terminates it, so the form is pinned.
    for block in blocks:
        assert block.delimiter == HEREDOC_DELIMITER, (
            f"{REQUIREMENT}: the block at line {block.opening_line} uses delimiter "
            f"{block.delimiter!r}, not {HEREDOC_DELIMITER!r}."
        )
        assert not block.dash, (
            f"{REQUIREMENT}: the block at line {block.opening_line} opens with `<<-`, which "
            f"strips leading tabs from its body and its delimiter line. The census and the "
            f"assembly are written against the plain `<<` form, so the change must be a "
            f"reviewed one."
        )

    # The one thing that identifies the excluded block as the RIGHT one to exclude.
    for block in conditional:
        body = "\n".join(block.body)
        assert CONDITIONAL_PLUGIN_NAME in body, (
            f"{REQUIREMENT}: the block at line {block.opening_line} was excluded from the "
            f"assembly on nesting grounds, but its body does not configure "
            f"'{CONDITIONAL_PLUGIN_NAME}' - so something OTHER than the known guarded "
            f"plugin is being dropped, and the generated document this module asserts on "
            f"is no longer the one that ships.\n--- excluded body ---\n{body}"
        )


# ---------------------------------------------------------------------------
# 2. The assembled text is literal, and carries no conditional plugin
# ---------------------------------------------------------------------------


def test_assembled_configuration_is_literal_and_excludes_the_conditional_plugin(
    repo_root: Path,
) -> None:
    """INVARIANT: the assembled document is literal text and holds no guarded plugin.

    Two properties, both load-bearing for this tier's existence.

    LITERAL: the three unconditional bodies contain no shell expansion of ANY form, so
    reading them statically yields exactly the bytes a real master receives. The moment
    that stops being true, a static reader is asserting against a template rather than
    against content, and the assertion must move to the shell tier.

    "Of any form" is the load-bearing part. The heredoc delimiters are UNQUOTED
    (``cat <<EOF``, measured at configure-helper.sh lines 1069, 1076 and 1094), so Bash
    expands ``$NAME``, ``${NAME}``, ``$(cmd)``, ``` `cmd` ``` and ``$((expr))`` alike. A
    guard testing only for ``${`` would pass a body templated with a bare ``$NAME`` -
    the commonest spelling of all - and this module would then assert confident values
    about a document no master ever receives. See :func:`find_shell_expansions`.

    NO GUARDED PLUGIN: ``ImagePolicyWebhook`` is absent from the assembly. This is
    deliberately NOT a claim that the plugin is absent from the shipped runtime file -
    it is legitimately configured when an operator requests it. The claim is only that
    the DEFAULT shape this module asserts on does not include it, which is what makes
    those assertions describe what every master gets rather than one optional variant.
    """
    blocks = extract_target_heredocs(read_generator_text(repo_root))
    unconditional, conditional = split_unconditional_blocks(blocks)
    assembled = assemble_admission_config(unconditional)

    expansions = find_shell_expansions(assembled)
    assert not expansions, (
        f"{REQUIREMENT}: the assembled admission configuration contains {len(expansions)} "
        f"line(s) with an unescaped '$' or backtick, so its heredoc bodies are no longer "
        f"literal and static extraction is no longer a valid way to recover them. The "
        f"delimiters are unquoted (cat <<EOF), so every expansion form applies - not just "
        f"'${{'.\n"
        f"--- offending lines ---\n"
        + "\n".join(f"  {number}: {line}" for number, line in expansions)
        + f"\n--- assembled ---\n{assembled}"
    )
    assert CONDITIONAL_PLUGIN_NAME not in assembled, (
        f"{REQUIREMENT}: '{CONDITIONAL_PLUGIN_NAME}' leaked into the assembled default "
        f"configuration. Its heredoc is guarded and is emitted only when an operator "
        f"requests the plugin, so including it would assert a shape the shipped default "
        f"never produces.\n--- assembled ---\n{assembled}"
    )
    # The guarded block must have been DROPPED, not merely absent from the script: if it
    # disappeared upstream, the exclusion above proves nothing and the two independent
    # discriminators this module relies on would have collapsed to one.
    assert conditional, (
        f"{REQUIREMENT}: no guarded heredoc was excluded from the assembly, so the "
        f"'{CONDITIONAL_PLUGIN_NAME}' block is no longer present in the generator. The "
        f"exclusion this test asserts is then vacuous - re-derive the block census in "
        f"test_extractor_sees_exactly_the_unconditional_heredocs before trusting it."
    )
    assert assembled.endswith("\n"), (
        f"{REQUIREMENT}: the assembled configuration does not end with a newline, so it "
        f"does not match what shell redirection writes to disk."
    )


# ---------------------------------------------------------------------------
# 3. The outer envelope is the stable AdmissionConfiguration one
# ---------------------------------------------------------------------------


def test_generator_emits_stable_admission_configuration_envelope(repo_root: Path) -> None:
    """INVARIANT: the generated document is a stable v1 ``AdmissionConfiguration``.

    The envelope is what allows the plugin blocks to be hosted at all, and the generator
    says so in its own comment. A pre-release group here (``…/v1alpha1``,
    ``…/v1beta1``) would be silently dropped or rejected by a released API server
    depending on version, so the group is pinned to the stable one.

    ``ResourceQuota`` is asserted PRESENT and no further: it is a fact of the assembled
    document and dropping it from the assembly would mean the parsed plugin list is not
    the one that ships, but its ``limitedResources`` are outside F-002-RQ-001 and are
    not this module's business.
    """
    document = generated_admission_config(repo_root)

    assert document.get("apiVersion") == ADMISSION_CONFIG_API_VERSION, (
        f"{REQUIREMENT}: the generated admission configuration declares apiVersion "
        f"{document.get('apiVersion')!r}, expected {ADMISSION_CONFIG_API_VERSION!r} - the "
        f"stable envelope required to host the PodSecurity plugin block."
    )
    assert document.get("kind") == ADMISSION_CONFIG_KIND, (
        f"{REQUIREMENT}: the generated admission configuration declares kind "
        f"{document.get('kind')!r}, expected {ADMISSION_CONFIG_KIND!r}."
    )

    names = plugin_names(document)
    assert POD_SECURITY_PLUGIN_NAME in names, (
        f"{REQUIREMENT}: the generated admission configuration declares no "
        f"'{POD_SECURITY_PLUGIN_NAME}' plugin. Declared: {list(names)}. Pod Security is "
        f"then unconfigured cluster-wide and every namespace falls back to 'privileged'."
    )
    assert RESOURCE_QUOTA_PLUGIN_NAME in names, (
        f"{REQUIREMENT}: the generated admission configuration declares no "
        f"'{RESOURCE_QUOTA_PLUGIN_NAME}' plugin. Declared: {list(names)}. Its block is one "
        f"of the three unconditional heredocs, so its absence means the assembly no longer "
        f"reflects the document that ships."
    )
    assert len(names) == len(set(names)), (
        f"{REQUIREMENT}: the generated admission configuration declares a plugin name more "
        f"than once: {list(names)}. Which duplicate an API server honours is not something "
        f"a test should guess at."
    )


# ---------------------------------------------------------------------------
# 4. The PodSecurity plugin declares the stable inner envelope
# ---------------------------------------------------------------------------


def test_pod_security_plugin_declares_stable_configuration_envelope(repo_root: Path) -> None:
    """INVARIANT: the PodSecurity block is a stable v1 ``PodSecurityConfiguration``.

    The inner ``apiVersion`` is a DIFFERENT API group from the outer one -
    ``pod-security.admission.config.k8s.io/v1`` inside
    ``apiserver.config.k8s.io/v1`` - and conflating the two is the classic error when
    editing this file by hand. Both are therefore asserted, separately and by their own
    names, in this module.

    The plugin is located by ``name``; see :func:`pod_security_configuration` for why an
    index-based lookup would silently read the wrong block.
    """
    document = generated_admission_config(repo_root)
    configuration = pod_security_configuration(document)

    assert configuration.get("apiVersion") == POD_SECURITY_API_VERSION, (
        f"{REQUIREMENT}: the {POD_SECURITY_PLUGIN_NAME} configuration declares apiVersion "
        f"{configuration.get('apiVersion')!r}, expected {POD_SECURITY_API_VERSION!r}. Note "
        f"this is NOT the outer {ADMISSION_CONFIG_API_VERSION!r} envelope group - the two "
        f"are different API groups and must not be conflated."
    )
    assert configuration.get("kind") == POD_SECURITY_KIND, (
        f"{REQUIREMENT}: the {POD_SECURITY_PLUGIN_NAME} configuration declares kind "
        f"{configuration.get('kind')!r}, expected {POD_SECURITY_KIND!r}."
    )


# ---------------------------------------------------------------------------
# 5. The six defaults: enforce=baseline, warn/audit=restricted, all at latest
# ---------------------------------------------------------------------------


def test_pod_security_defaults_enforce_baseline_warn_audit_restricted(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT: all six PodSecurity defaults are declared, and declared explicitly.

    THE BOUNDARY THIS TEST OWNS, and why none of it may be relaxed to make a run green:
    ``enforce=baseline`` rejects privileged and breakout-prone pods at the API boundary,
    while ``warn=restricted`` and ``audit=restricted`` report the stricter standard
    without rejecting workloads that violate it - tech-spec §6.4.4.3's zero-downtime
    rollout. All three versions are pinned to ``latest``.

    WHY PRESENCE IS ASSERTED BEFORE VALUE. ``SetDefaults_PodSecurityDefaults`` in
    staging/src/k8s.io/pod-security-admission/admission/api/v1/defaults.go substitutes
    ``LevelPrivileged`` for every mode left unset. An omitted key is therefore not
    neutral - it silently means "no enforcement", which is precisely the weakness V2
    closed. A check that tolerated absence would be worth nothing, so each key is
    asserted present on its own before it is compared.

    ACCUMULATE, DO NOT ABORT (the ``t.Errorf`` half of the split). Each key is checked
    inside its own subtest, so a single run names EVERY deviation. If a future edit
    downgrades ``warn`` and ``audit`` together, one run reports both rather than hiding
    the second behind the first - and a reviewer sees the true blast radius instead of
    one symptom of it.
    """
    configuration = pod_security_configuration(generated_admission_config(repo_root))

    # Abort: with no defaults block at all, every mode is 'privileged' and the six
    # subtests below would each report the same single root cause six times over.
    defaults = configuration.get("defaults")
    assert isinstance(defaults, dict), (
        f"{REQUIREMENT}: the {POD_SECURITY_PLUGIN_NAME} configuration declares no "
        f"'defaults' mapping (got {type(defaults).__name__}). Every mode then falls back "
        f"to 'privileged' and Pod Security enforces nothing."
    )

    for key, expected in EXPECTED_DEFAULTS:
        with subtests.test(defaults_key=key):
            assert key in defaults, (
                f"{REQUIREMENT}: PodSecurity defaults.{key} is ABSENT. Absence is not "
                f"neutral: SetDefaults_PodSecurityDefaults substitutes 'privileged' for an "
                f"unset mode (and 'latest' for an unset version), so omitting this key "
                f"silently disables the control instead of leaving it undecided. Expected "
                f"{expected!r}. Declared keys: {sorted(defaults)}."
            )
            assert defaults[key] == expected, (
                f"{REQUIREMENT}: PodSecurity defaults.{key} is {defaults[key]!r}, expected "
                f"{expected!r}. enforce must hold at 'baseline' and warn/audit at "
                f"'restricted', each pinned to 'latest' (tech-spec §6.4.4.3). Do not relax "
                f"this value to make the suite pass."
            )

    with subtests.test("defaults declares exactly the six documented keys"):
        expected_keys = sorted(key for key, _ in EXPECTED_DEFAULTS)
        assert sorted(defaults) == expected_keys, (
            f"{REQUIREMENT}: PodSecurity defaults declares {sorted(defaults)}, expected "
            f"exactly {expected_keys}. An extra key is rejected by the "
            f"{POD_SECURITY_KIND} schema, and a misspelt one leaves the mode it was meant "
            f"to set at 'privileged'."
        )


# ---------------------------------------------------------------------------
# 6. The only exemption is kube-system
# ---------------------------------------------------------------------------


def test_pod_security_exempts_only_kube_system(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT: exactly one namespace is exempt, and no principal or runtime class is.

    ``namespaces: ["kube-system"]`` is the documented control-plane exemption: those
    components require elevated access. It is the CLUSTER-LEVEL half of one control -
    its namespace-level half is the ``kube-system`` Namespace's
    ``pod-security.kubernetes.io/enforce: privileged`` label in
    cluster/manifests/namespace-pss-labels.yaml, asserted by the sibling module
    tests/unit/config/test_namespace_pss_labels.py. The two mirror each other by design,
    and that manifest's own comment says so, so widening either side alone would leave
    the cluster in a state neither file describes.

    Comparison is EXACT list equality rather than membership: an added namespace, or a
    username or runtime class carved out here, is an exemption nobody reviewed, and a
    membership check would wave it through.

    Accumulating over the three keys for the same reason as the defaults above - a run
    that carves out both a username and a second namespace must report both.
    """
    configuration = pod_security_configuration(generated_admission_config(repo_root))

    # Abort: an absent exemptions block cannot be compared key by key, and its absence is
    # one finding rather than three.
    exemptions = configuration.get("exemptions")
    assert isinstance(exemptions, dict), (
        f"{REQUIREMENT}: the {POD_SECURITY_PLUGIN_NAME} configuration declares no "
        f"'exemptions' mapping (got {type(exemptions).__name__}), so the documented "
        f"kube-system control-plane exemption is not expressed at the cluster level."
    )

    for key, expected in EXPECTED_EXEMPTIONS:
        with subtests.test(exemptions_key=key):
            assert key in exemptions, (
                f"{REQUIREMENT}: PodSecurity exemptions.{key} is ABSENT. The block is "
                f"written out in full so that each carve-out is visible and reviewable; "
                f"expected {list(expected)!r}. Declared keys: {sorted(exemptions)}."
            )
            assert exemptions[key] == list(expected), (
                f"{REQUIREMENT}: PodSecurity exemptions.{key} is {exemptions[key]!r}, "
                f"expected exactly {list(expected)!r}. Every entry here is a namespace, "
                f"principal or runtime class that bypasses Pod Security entirely, so the "
                f"comparison is exact and additions must be justified, not absorbed."
            )

    with subtests.test("exemptions declares exactly the three documented keys"):
        expected_keys = sorted(key for key, _ in EXPECTED_EXEMPTIONS)
        assert sorted(exemptions) == expected_keys, (
            f"{REQUIREMENT}: PodSecurity exemptions declares {sorted(exemptions)}, expected "
            f"exactly {expected_keys}."
        )


# ---------------------------------------------------------------------------
# 7. The assembled text is a valid standalone file
# ---------------------------------------------------------------------------


def test_assembled_configuration_round_trips_through_a_file(
    repo_root: Path, tmp_path: Path
) -> None:
    """INVARIANT: the recovered text is a self-contained file, not just parseable string.

    The three heredoc bodies are written to ONE file on a real master by three
    successive redirections, so what matters is that their concatenation stands alone.
    Materialising it and re-reading proves that: byte-identical on the way back, and
    re-parsing to the same document the in-memory path produced.

    ``tmp_path`` is the ONLY location this module writes, and pytest gives each test -
    and each ``pytest-xdist`` worker - its own, so parallel runs cannot contend
    (AAP §0.11.1 B10). The real generator's target is an absolute, root-owned path under
    ``/etc``; a test that wrote there would need root, would escape the sandbox and
    would have every worker fighting over one file.
    """
    blocks = extract_target_heredocs(read_generator_text(repo_root))
    unconditional, _ = split_unconditional_blocks(blocks)
    assembled = assemble_admission_config(unconditional)

    materialised = tmp_path / "admission_controller_config.yaml"
    materialised.write_text(assembled, encoding="utf-8")
    written = materialised.read_text(encoding="utf-8")

    assert written == assembled, (
        f"{REQUIREMENT}: the materialised admission configuration does not match the "
        f"assembled text byte for byte, so the recovered document is not what a file on "
        f"disk would hold."
    )

    reparsed = yaml.safe_load(written)
    assert reparsed == generated_admission_config(repo_root), (
        f"{REQUIREMENT}: the materialised admission configuration re-parses to a different "
        f"document than the in-memory assembly, so one of the two paths is not reading the "
        f"generated configuration faithfully.\n--- materialised ---\n{written}"
    )


# ---------------------------------------------------------------------------
# THE REAL-BASH GENERATION SEAM
# ---------------------------------------------------------------------------
# Everything above assembles the document by EXTRACTING heredoc bodies as text and
# concatenating them in Python. That buys purity and it is a genuinely useful
# cross-check, but it can only ever be a MODEL of what bash does: the extractor
# understands indentation and the `${` guard, and it does not understand bash
# control flow, quoted-versus-unquoted heredoc delimiters, `$VAR` and `${VAR}`
# expansion, command substitution, backticks, or arithmetic. Any of those could
# change the file a real master receives while the extracted text stayed byte for
# byte identical - and the module would report a pass.
#
# So the AUTHORITATIVE assertions below run the SHIPPED generator under real bash
# and read the file it actually writes. Bash is then the interpreter of bash, which
# is the only way the semantics above are guaranteed rather than approximated. AAP
# §0.5.1's row for this file speaks of "the GENERATED admission_controller_config.
# yaml", and this is what generating it means.
#
# WHY A SEAM IS NEEDED AT ALL. `create-master-auth` writes to the absolute path
# /etc/srv/kubernetes/admission_controller_config.yaml - unlike
# `create-master-audit-policy`, which takes its destination as `$1` and is
# therefore directly sandboxable. A test must not write to /etc: it would not be
# hermetic, not parallel-safe under pytest-xdist, and would fail on any machine
# where the tester is not root. The seam redirects the destination and NOTHING
# else, and its fidelity is asserted rather than asserted-to-be-true - see
# :func:`test_the_generation_seam_changes_only_the_destination_prefix`.

#: The absolute directory prefix the shipped generator writes into. Substituting
#: this ONE literal is the entire seam.
GENERATOR_OUTPUT_PREFIX: Final = "/etc/"

#: The generator function that emits the admission configuration.
GENERATOR_FUNCTION: Final = "create-master-auth"

#: Path of the generated document RELATIVE to the sandbox root, i.e. the shipped
#: absolute path with its leading slash removed.
GENERATED_CONFIG_RELATIVE_PARTS: Final = (
    "etc",
    "srv",
    "kubernetes",
    "admission_controller_config.yaml",
)

#: An ``ADMISSION_CONTROL`` value that opens the guard without requesting the
#: conditional plugin. The exact plugin list is immaterial to the assertions - the
#: generator only tests it for emptiness and for the ImagePolicyWebhook substring -
#: but PodSecurity and NodeRestriction are named because they are the V2 and V7
#: plugins the shipped profiles enable.
ADMISSION_CONTROL_WITHOUT_CONDITIONAL: Final = (
    "NamespaceLifecycle,LimitRanger,PodSecurity,NodeRestriction"
)

#: An ``ADMISSION_CONTROL`` value containing the substring that opens the nested
#: guard, so the conditional block is exercised by real bash control flow.
ADMISSION_CONTROL_WITH_CONDITIONAL: Final = (
    f"{ADMISSION_CONTROL_WITHOUT_CONDITIONAL},{CONDITIONAL_PLUGIN_NAME}"
)

#: A placeholder webhook URL. It is a NON-SECRET fixture and never contacted: the
#: generator only interpolates it into a heredoc, which is the point - it proves
#: real ``${VAR}`` expansion inside a here-document, one of the semantics the
#: static extractor cannot model.
IMAGE_VERIFICATION_URL_PLACEHOLDER: Final = "https://127.0.0.1:9002/review"

#: The generator's own error text when the conditional plugin is requested with no
#: URL, matched as a stable substring so a rewording that preserves the refusal
#: does not fail the gate.
MISSING_URL_ERROR_FRAGMENT: Final = "GCP_IMAGE_VERIFICATION_URL was not provided"


@dataclass(frozen=True)
class GeneratedConfig:
    """What one real-bash run of the generator produced."""

    #: Exit status of the whole ``bash -c`` invocation.
    returncode: int
    #: stdout, captured separately so a diagnostic is attributable to its stream.
    stdout: str
    #: stderr, likewise. The generator writes its ImagePolicyWebhook notices here.
    stderr: str
    #: Text of the generated document, or ``None`` when no file was written -
    #: which is itself an assertable outcome, not an error.
    text: str | None


def _install_generation_seam(repo_root: Path, sandbox: Path) -> Path:
    """Copy the shipped generator into ``sandbox``, redirecting its output prefix only.

    THE ONE TRANSFORMATION: every occurrence of the literal
    :data:`GENERATOR_OUTPUT_PREFIX` becomes ``<sandbox>/etc/``. Nothing else is
    touched - not a guard, not a heredoc, not a delimiter, not an expansion - so
    what runs is the shipped bash with a different destination. The transformation
    is uniform and therefore exactly reversible, which is what lets
    :func:`test_the_generation_seam_changes_only_the_destination_prefix` prove it
    changed nothing but paths.

    Redirecting the WHOLE ``/etc/`` prefix rather than only the
    ``/etc/srv/kubernetes`` sub-path is deliberate belt-and-braces: the generator
    also writes ``/etc/gce.conf``, ``/etc/gcp_authn.config`` and
    ``/etc/gcp_authz.config`` on other paths through the function, and a test must
    not be able to touch any of them on the host even if a future edit reaches one.

    Args:
        repo_root: Session-scoped repository root.
        sandbox: A ``tmp_path``-rooted directory. The output tree is created
            beneath it before the run, because bash redirection creates files but
            not their parent directories.

    Returns:
        Path of the transformed script inside the sandbox.
    """
    __tracebackhide__ = True
    original = read_generator_text(repo_root)
    assert GENERATOR_OUTPUT_PREFIX in original, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the shipped generator contains no "
        f"{GENERATOR_OUTPUT_PREFIX!r} literal, so the generation seam has nothing to redirect "
        f"and a run of it could write outside the sandbox. The generator's output paths have "
        f"changed shape; re-derive the seam before trusting any assertion below."
    )

    redirected = original.replace(GENERATOR_OUTPUT_PREFIX, f"{sandbox}{GENERATOR_OUTPUT_PREFIX}")
    script_path = sandbox / GENERATOR_PATH_PARTS[-1]
    script_path.write_text(redirected, encoding="utf-8")

    # Bash redirection creates the FILE, never its parent directory, so the output
    # tree must exist first. Created from the same components the reader uses, so
    # the two cannot disagree about where the document lands.
    (sandbox / Path(*GENERATED_CONFIG_RELATIVE_PARTS).parent).mkdir(parents=True, exist_ok=True)
    return script_path


def _generate_admission_config(
    repo_root: Path, sandbox: Path, *, env: Mapping[str, str]
) -> GeneratedConfig:
    """Run the SHIPPED generator under real bash and return what it wrote.

    ``env`` is the complete environment of the run. It is deliberately explicit and
    minimal: the generator branches on ``ADMISSION_CONTROL`` and
    ``GCP_IMAGE_VERIFICATION_URL``, and passing only what a scenario means to set
    keeps an inherited variable from the tester's shell out of the verdict.

    ``check=False`` because a non-zero exit is an OUTCOME here, not harness
    breakage: one scenario exists specifically to prove the generator ABORTS when
    the conditional plugin is requested without its URL. ``merge_streams=False``
    because the generator writes its ImagePolicyWebhook notices to stderr with
    ``1>&2``, and attributing them is part of what is asserted.
    """
    __tracebackhide__ = True
    script_path = _install_generation_seam(repo_root, sandbox)
    generated = sandbox / Path(*GENERATED_CONFIG_RELATIVE_PARTS)

    result = run_bash(
        f'set -u; source "$1"; {GENERATOR_FUNCTION}',
        argv=(str(script_path),),
        cwd=sandbox,
        env=dict(env),
        check=False,
        merge_streams=False,
        requirement=REQUIREMENT,
    )
    return GeneratedConfig(
        returncode=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
        text=generated.read_text(encoding="utf-8") if generated.is_file() else None,
    )


@pytest.mark.shell
def test_the_generation_seam_changes_only_the_destination_prefix(
    repo_root: Path, tmp_path: Path
) -> None:
    """The seam is FAITHFUL: reversing its one substitution restores the shipped bytes.

    A seam is only as trustworthy as the proof that it changed nothing that
    matters, and "we only meant to change the path" is not a proof. The
    substitution is uniform, so it is exactly reversible: replacing
    ``<sandbox>/etc/`` back with ``/etc/`` must yield the shipped file BYTE FOR
    BYTE. If it does, then every guard, every heredoc, every delimiter and every
    expansion in the script that runs is the shipped one, and the only thing the
    sandbox changed is where the output lands.

    Also asserted: the substitution actually happened. A seam that silently
    substituted nothing would run the shipped script against the real ``/etc``,
    which on a machine where the tester is root would write to the host - the
    single worst outcome available here, and the reason this is a positive
    assertion rather than a comment.
    """
    original = read_generator_text(repo_root)
    script_path = _install_generation_seam(repo_root, tmp_path)
    transformed = script_path.read_text(encoding="utf-8")

    substitutions = original.count(GENERATOR_OUTPUT_PREFIX)
    assert substitutions > 0, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the seam substituted nothing, so the generator would "
        f"run against the real {GENERATOR_OUTPUT_PREFIX!r} and could write to the host."
    )
    assert transformed.count(f"{tmp_path}{GENERATOR_OUTPUT_PREFIX}") == substitutions, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the seam redirected "
        f"{transformed.count(f'{tmp_path}{GENERATOR_OUTPUT_PREFIX}')} of {substitutions} "
        f"{GENERATOR_OUTPUT_PREFIX!r} occurrences. Any occurrence left un-redirected is a write "
        f"that escapes the sandbox."
    )
    assert transformed.replace(f"{tmp_path}{GENERATOR_OUTPUT_PREFIX}", GENERATOR_OUTPUT_PREFIX) == (
        original
    ), (
        f"{REQUIREMENT}: SETUP BREAKAGE - reversing the seam's substitution does NOT restore "
        f"the shipped generator byte for byte, so the script that runs differs from the shipped "
        f"one by more than its output prefix. Every assertion about 'what the generator emits' "
        f"would then be about a modified generator."
    )


@pytest.mark.shell
def test_real_bash_generates_the_document_the_static_extractor_models(
    repo_root: Path, tmp_path: Path
) -> None:
    """DIFFERENTIAL: the runtime document EQUALS the statically assembled one, exactly.

    THE ASSERTION THAT MAKES THE STATIC MODEL TRUSTWORTHY, and the one that fails
    the moment it stops being. Every pure test above reads a document Python
    assembled by concatenating extracted heredoc bodies; this one reads the document
    real bash actually wrote, and requires the two to be byte-identical.

    That closes the gap the extractor cannot close by itself. The extractor models
    indentation and the ``${`` guard; it does NOT model bash control flow, quoted
    versus unquoted delimiters, ``$VAR`` and ``${VAR}`` expansion, command
    substitution, backticks or arithmetic. Introduce any of those into a heredoc
    body and the extracted text is unchanged while the emitted text is not - so the
    static tests stay green and the shipped file has drifted. This test is what
    turns that silent drift into a named failure, and it is why the static
    machinery is kept rather than deleted: two independent derivations of the same
    artefact, required to agree.

    Run WITHOUT the conditional plugin, because the statically assembled document is
    the unconditional blocks only. The conditional branch has its own test.
    """
    generated = _generate_admission_config(
        repo_root,
        tmp_path,
        env={"ADMISSION_CONTROL": ADMISSION_CONTROL_WITHOUT_CONDITIONAL},
    )

    assert generated.returncode == 0, (
        f"{REQUIREMENT}: the shipped {GENERATOR_FUNCTION} exited "
        f"{generated.returncode} rather than 0 with ADMISSION_CONTROL set and no conditional "
        f"plugin requested.\n  stdout: {generated.stdout!r}\n  stderr: {generated.stderr!r}"
    )
    assert generated.text is not None, (
        f"{REQUIREMENT}: the shipped {GENERATOR_FUNCTION} wrote NO admission configuration at "
        f"{'/'.join(GENERATED_CONFIG_RELATIVE_PARTS)} even though ADMISSION_CONTROL was set. "
        f"The V2 PodSecurity defaults reach a real master through this file only.\n"
        f"  stdout: {generated.stdout!r}\n  stderr: {generated.stderr!r}"
    )

    unconditional, _ = split_unconditional_blocks(
        extract_target_heredocs(read_generator_text(repo_root))
    )
    assembled = assemble_admission_config(unconditional)

    assert generated.text == assembled, (
        f"{REQUIREMENT}: the document REAL BASH wrote differs from the one the static extractor "
        f"assembles. The runtime text is authoritative - it is what a master receives - so the "
        f"extractor's model of the generator is now wrong, and every pure assertion in this "
        f"module is reading something that does not ship. Likely causes: a heredoc body gained "
        f"a `$VAR`, a command substitution, a backtick or an arithmetic expansion; a delimiter "
        f"was quoted or unquoted; or a block moved inside or outside a guard.\n"
        f"--- real bash wrote ---\n{generated.text}\n"
        f"--- static extractor assembled ---\n{assembled}"
    )


@pytest.mark.shell
def test_the_runtime_document_carries_the_v2_pod_security_defaults(
    repo_root: Path, tmp_path: Path, subtests: pytest.Subtests
) -> None:
    """The V2 boundary values hold in the document REAL BASH writes, not only in the model.

    AAP §0.10.2 fixes the workload posture at enforce=baseline with warn and audit
    at restricted, and AAP §0.5.1 requires ``exemptions.namespaces`` to be exactly
    ``["kube-system"]``. Those are asserted above against the statically assembled
    document; here they are asserted against the RUNTIME one, so the boundary is
    proven on the artefact a master actually receives.

    Not redundant with the differential above. That test proves the two derivations
    AGREE; this one proves the runtime derivation is CORRECT. Two documents can
    agree and both be wrong - if a heredoc body were edited, the extractor would
    faithfully reproduce the new text and the differential would pass - so the
    values themselves must be asserted on the runtime side too.

    ACCUMULATE semantics: one subtest per default and per exemption, so a run in
    which several were weakened names all of them.
    """
    generated = _generate_admission_config(
        repo_root,
        tmp_path,
        env={"ADMISSION_CONTROL": ADMISSION_CONTROL_WITHOUT_CONDITIONAL},
    )
    assert generated.text is not None, (
        f"{REQUIREMENT}: the shipped {GENERATOR_FUNCTION} wrote no admission configuration, so "
        f"the V2 defaults cannot be evaluated.\n  stderr: {generated.stderr!r}"
    )

    document = yaml.safe_load(generated.text)
    assert isinstance(document, dict), (
        f"{REQUIREMENT}: the generated document decodes to {type(document).__name__}, not a "
        f"mapping. kube-apiserver would refuse to load it.\n{generated.text}"
    )

    with subtests.test(field="envelope"):
        assert (document.get("apiVersion"), document.get("kind")) == (
            ADMISSION_CONFIG_API_VERSION,
            ADMISSION_CONFIG_KIND,
        ), (
            f"{REQUIREMENT}: the generated document's envelope is "
            f"{(document.get('apiVersion'), document.get('kind'))!r}, expected "
            f"{(ADMISSION_CONFIG_API_VERSION, ADMISSION_CONFIG_KIND)!r}. The stable v1 "
            f"AdmissionConfiguration envelope is what allows the PodSecurity plugin block to be "
            f"hosted at all."
        )

    configuration = pod_security_configuration(document)
    defaults = configuration.get("defaults")
    assert isinstance(defaults, dict), (
        f"{REQUIREMENT}: the generated PodSecurityConfiguration has no `defaults` mapping "
        f"({defaults!r}). Every mode then falls back to `privileged` "
        f"(pod-security-admission/admission/api/v1/defaults.go) and V2 is not in force."
    )
    for key, expected in EXPECTED_DEFAULTS:
        with subtests.test(default=key):
            assert defaults.get(key) == expected, (
                f"{REQUIREMENT}: the RUNTIME-generated PodSecurityConfiguration sets "
                f"defaults.{key} to {defaults.get(key)!r}, expected {expected!r}. This is a V2 "
                f"boundary (AAP §0.10.2) asserted on the document a master receives, and it "
                f"must not be weakened to make anything pass."
            )

    exemptions = configuration.get("exemptions")
    assert isinstance(exemptions, dict), (
        f"{REQUIREMENT}: the generated PodSecurityConfiguration has no `exemptions` mapping "
        f"({exemptions!r}), so the documented kube-system carve-out cannot be verified."
    )
    for key, expected_list in EXPECTED_EXEMPTIONS:
        with subtests.test(exemption=key):
            assert exemptions.get(key) == list(expected_list), (
                f"{REQUIREMENT}: the RUNTIME-generated PodSecurityConfiguration sets "
                f"exemptions.{key} to {exemptions.get(key)!r}, expected {list(expected_list)!r}. "
                f"An extra exempt namespace, username or runtime class is a hole in V2 that no "
                f"other assertion in this suite would see."
            )


@pytest.mark.shell
def test_the_guard_and_the_conditional_branch_are_real_bash_control_flow(
    repo_root: Path, tmp_path: Path, subtests: pytest.Subtests
) -> None:
    """Three RUNTIME scenarios proving the generator's control flow, not a model of it.

    The static extractor infers conditionality from INDENTATION - a deliberate
    heuristic, and a heuristic is exactly what cannot be trusted about control flow.
    These three scenarios let bash decide instead, and each one is a behaviour the
    extractor cannot express at all:

    1. ``ADMISSION_CONTROL`` UNSET: the outer ``if [[ -n ... ]]`` guard is false and
       NO file is written. Not an empty file - no file. A generator that emitted an
       empty or partial document here would leave a master with an
       AdmissionConfiguration it could not load, and indentation says nothing about
       this case.
    2. ``ADMISSION_CONTROL`` CONTAINING ``ImagePolicyWebhook`` with its URL set: the
       nested guard opens, the fourth heredoc is appended, and ``${VAR}`` is
       EXPANDED inside a here-document - the single clearest thing static text
       extraction cannot do. The expansion is asserted on the emitted bytes.
    3. The same plugin requested with NO URL: the generator ABORTS with exit 1 and
       an explanatory diagnostic on stderr. A fail-closed error path, asserted as an
       equality on the exit status rather than "non-zero", because 2 from a sourcing
       error and 127 from an undefined function are also non-zero and neither is the
       generator refusing.

    ACCUMULATE semantics: the three scenarios are independent, so all three are
    reported in one run.
    """
    with subtests.test(scenario="guard-closed-no-admission-control"):
        sandbox = tmp_path / "guard-closed"
        sandbox.mkdir()
        generated = _generate_admission_config(repo_root, sandbox, env={})
        assert generated.returncode == 0, (
            f"{REQUIREMENT}: with ADMISSION_CONTROL unset the generator must complete "
            f"normally, not fail; it exited {generated.returncode}.\n"
            f"  stderr: {generated.stderr!r}"
        )
        assert generated.text is None, (
            f"{REQUIREMENT}: with ADMISSION_CONTROL unset NO admission configuration may be "
            f"written, and one was:\n{generated.text}\nAn empty or partial "
            f"AdmissionConfiguration is worse than none - kube-apiserver would fail to load it."
        )

    with subtests.test(scenario="conditional-plugin-with-url"):
        sandbox = tmp_path / "conditional-on"
        sandbox.mkdir()
        generated = _generate_admission_config(
            repo_root,
            sandbox,
            env={
                "ADMISSION_CONTROL": ADMISSION_CONTROL_WITH_CONDITIONAL,
                "GCP_IMAGE_VERIFICATION_URL": IMAGE_VERIFICATION_URL_PLACEHOLDER,
            },
        )
        assert generated.returncode == 0, (
            f"{REQUIREMENT}: requesting {CONDITIONAL_PLUGIN_NAME} WITH its URL must succeed; "
            f"the generator exited {generated.returncode}.\n  stderr: {generated.stderr!r}"
        )
        assert generated.text is not None, (
            f"{REQUIREMENT}: requesting {CONDITIONAL_PLUGIN_NAME} produced no admission "
            f"configuration at all.\n  stderr: {generated.stderr!r}"
        )
        assert CONDITIONAL_PLUGIN_NAME in generated.text, (
            f"{REQUIREMENT}: {CONDITIONAL_PLUGIN_NAME} was requested through ADMISSION_CONTROL "
            f"and real bash took the nested guard, yet the emitted document does not name it. "
            f"The conditional block is no longer appended:\n{generated.text}"
        )
        kubeconfig = sandbox / "etc" / "srv" / "kubernetes" / "gcp_image_review.kubeconfig"
        assert kubeconfig.is_file(), (
            f"{REQUIREMENT}: the {CONDITIONAL_PLUGIN_NAME} branch must also emit "
            f"gcp_image_review.kubeconfig, which the admission config references by path; it "
            f"is absent from {sandbox}."
        )
        assert IMAGE_VERIFICATION_URL_PLACEHOLDER in kubeconfig.read_text(encoding="utf-8"), (
            f"{REQUIREMENT}: ${{GCP_IMAGE_VERIFICATION_URL}} was NOT expanded into the emitted "
            f"kubeconfig. Real bash expansion inside a here-document is precisely what static "
            f"text extraction cannot model, so this assertion is the reason this tier runs the "
            f"generator rather than reading it.\n{kubeconfig.read_text(encoding='utf-8')}"
        )

    with subtests.test(scenario="conditional-plugin-without-url-fails-closed"):
        sandbox = tmp_path / "conditional-no-url"
        sandbox.mkdir()
        generated = _generate_admission_config(
            repo_root,
            sandbox,
            env={"ADMISSION_CONTROL": ADMISSION_CONTROL_WITH_CONDITIONAL},
        )
        assert generated.returncode == 1, (
            f"{REQUIREMENT}: requesting {CONDITIONAL_PLUGIN_NAME} with no "
            f"GCP_IMAGE_VERIFICATION_URL must ABORT with exit 1; the generator exited "
            f"{generated.returncode}. Equality rather than 'non-zero' on purpose: 2 from a "
            f"sourcing error and 127 from an undefined function are also non-zero and neither "
            f"is the generator refusing.\n  stderr: {generated.stderr!r}"
        )
        assert MISSING_URL_ERROR_FRAGMENT in generated.stderr, (
            f"{REQUIREMENT}: the refusal must explain itself on STDERR, and "
            f"{MISSING_URL_ERROR_FRAGMENT!r} is absent. The generator writes this diagnostic "
            f"with `1>&2`, so a message that moved to stdout means the diagnostic channel "
            f"changed.\n  stdout: {generated.stdout!r}\n  stderr: {generated.stderr!r}"
        )
