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

WHY THE GENERATOR IS READ RATHER THAN RUN. The heredocs that produce this file live
inside the ``create-master-auth`` function (declared at configure-helper.sh:820) behind
the guard ``if [[ -n "${ADMISSION_CONTROL:-}" ]]`` (L1065), and they write to the
ABSOLUTE, ROOT-OWNED path ``/etc/srv/kubernetes/admission_controller_config.yaml``.
Invoking the function would therefore need root, would write outside the test sandbox,
and would drag in the rest of that large function's side effects - all three
unacceptable for a pure unit module whose only writable location is ``tmp_path``. So
this module STATICALLY EXTRACTS the heredoc bodies from the script text and parses
them. It runs no subprocess, starts no server, needs no etcd, and never creates, reads
or writes anything under ``/etc``. The one place real Bash is invoked is the
shell-boundary tier, ``python/tests/unit/shell/``, through a sandboxed ``KUBE_HOME``;
this module is deliberately not that tier.

Static extraction is only sound while the extracted text is LITERAL, so that soundness
is asserted rather than assumed: :func:`generated_admission_config` fails if the
assembled text contains a ``${...}`` shell expansion, which is the signal that the
approach has quietly stopped being valid and the shell tier must take over.

WHAT THE EXTRACTOR MUST GET RIGHT, measured rather than inferred (AAP §0.11.1 B2).
Exactly four heredocs in the script target the admission configuration file:

===========  ======  ==========  ============  =======================================
Opening      Indent  Redirect    Body lines    Status
===========  ======  ==========  ============  =======================================
L1069        4       ``>``       3             UNCONDITIONAL - the envelope
L1076        4       ``>>``      10            UNCONDITIONAL - ``ResourceQuota``
L1094        4       ``>>``      15            UNCONDITIONAL - ``PodSecurity``
L1141        6       ``>>``      8             CONDITIONAL - ``ImagePolicyWebhook``
===========  ======  ==========  ============  =======================================

The L1141 block sits inside ``if [[ "${ADMISSION_CONTROL:-}" == *"ImagePolicyWebhook"* ]]``
(L1112) - one level deeper, hence indent 6 - so it is emitted only when an operator
requests that plugin. Including it would assert a shape the shipped default never
produces, so it is excluded. A fifth heredoc (L1121) targets
``gcp_image_review.kubeconfig``; filtering on the target file name excludes it before
indentation is even consulted. Those line numbers are PROVENANCE ONLY and are never
asserted - they drift with unrelated edits. The non-brittle equivalent is the
structural assertion in
:func:`test_extractor_sees_exactly_the_unconditional_heredocs`, which fails loudly if
the block count, the nesting or the redirect operators ever change, instead of silently
including or dropping a block.

INVARIANTS LOCKED, one per test:

1. THE EXTRACTOR SEES EXACTLY THE UNCONDITIONAL BLOCKS - four blocks target the file,
   three are unconditional, exactly one truncates and it is the first in file order,
   the excluded one is nested deeper and is the ``ImagePolicyWebhook`` block.
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
from typing import TYPE_CHECKING, Any, Final

import pytest
import yaml

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from pathlib import Path

# L3 config-schema tier: pure decode-and-assert, no subprocess, no etcd, no API server.
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

#: The heredoc opening line, anchored on the file the generator writes.
#:
#: THE PATH BELOW IS A PATTERN, NEVER AN OPERAND. It is matched as TEXT against lines
#: of the generator's source and is never passed to ``open``, ``Path`` or any other
#: filesystem call: the only path this module reads is the generator itself, and the
#: only path it writes is ``tmp_path``. Anchoring on the target file name is the FIRST
#: discriminator and is what keeps the neighbouring ``gcp_image_review.kubeconfig``
#: heredoc out of the result set - a looser pattern would sweep it in and the assembled
#: YAML would then contain a kubeconfig.
#:
#: ``[ \t]*`` for the indent rather than ``\s*`` because the indent width is
#: load-bearing (it is the conditional-block discriminator) and must count only real
#: indentation characters. ``(>>?)`` captures truncate-versus-append, the second
#: discriminator: the single truncating redirect marks where the document begins.
HEREDOC_OPENING_PATTERN: Final = re.compile(
    r"^(?P<indent>[ \t]*)cat\s*<<EOF\s*(?P<redirect>>>?)\s*"
    r"/etc/srv/kubernetes/admission_controller_config\.yaml\s*$"
)

#: The heredoc delimiter the generator uses. A body ends at the first line whose
#: ``strip()`` equals this, which is how bash terminates a non-quoted ``<<EOF``.
HEREDOC_DELIMITER: Final = "EOF"

#: Truncating (``>``) opens the document; appending (``>>``) extends it.
TRUNCATING_REDIRECT: Final = ">"

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
class HeredocBlock:
    """One ``cat <<EOF >…admission_controller_config.yaml`` block in the generator.

    Frozen so that a block cannot be edited after extraction: the census assertions
    and the assembly both read the same objects, and a mutable record would let one
    of them change what the other sees.

    Attributes:
        opening_line: One-based line number of the ``cat <<EOF …`` line. Carried for
            FAILURE LEGIBILITY - it puts a reviewer straight on the offending line -
            and never asserted against, because line numbers drift.
        indent: Width of the leading whitespace on the opening line. Load-bearing:
            the guarded ``ImagePolicyWebhook`` block is nested one level deeper than
            the unconditional ones, so this is the discriminator between them.
        redirect: ``>`` (truncate, opens the document) or ``>>`` (append, extends it).
        closing_line: One-based line number of the terminating delimiter, or ``None``
            when the block is unterminated - which would mean the script no longer
            parses as bash and is reported as setup breakage.
        body: The heredoc body, verbatim and without the delimiter lines.
    """

    opening_line: int
    indent: int
    redirect: str
    closing_line: int | None
    body: tuple[str, ...]

    @property
    def truncates(self) -> bool:
        """True when this block OPENS the generated document rather than extending it."""
        return self.redirect == TRUNCATING_REDIRECT

    @property
    def is_terminated(self) -> bool:
        """True when a closing delimiter was found for this block."""
        return self.closing_line is not None


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


def extract_target_heredocs(script_text: str) -> tuple[HeredocBlock, ...]:
    """Extract every heredoc in ``script_text`` that targets the admission config file.

    Discrimination is on the TARGET FILE NAME first (see
    :data:`HEREDOC_OPENING_PATTERN`), which is what keeps the neighbouring
    ``gcp_image_review.kubeconfig`` heredoc out of the result: it is a ``cat <<EOF``
    block in the same ``if`` branch and a pattern that matched on ``cat <<EOF`` alone
    would fold a kubeconfig into the assembled YAML.

    Scanning resumes AFTER the closing delimiter, never at the line following the
    opening. That matters twice: a body line can then never be mistaken for an opening
    line, and an unterminated block cannot spin the loop.

    Args:
        script_text: The generator's full text.

    Returns:
        The matching blocks in FILE ORDER. Order is part of the contract - the
        truncating block opens the document and the appending blocks extend it, so
        assembling them out of order would produce different YAML.
    """
    lines = script_text.splitlines()
    blocks: list[HeredocBlock] = []
    index = 0
    while index < len(lines):
        match = HEREDOC_OPENING_PATTERN.match(lines[index])
        if match is None:
            index += 1
            continue
        body: list[str] = []
        closing_line: int | None = None
        cursor = index + 1
        while cursor < len(lines):
            if lines[cursor].strip() == HEREDOC_DELIMITER:
                closing_line = cursor + 1
                break
            body.append(lines[cursor])
            cursor += 1
        blocks.append(
            HeredocBlock(
                opening_line=index + 1,
                indent=len(match.group("indent")),
                redirect=match.group("redirect"),
                closing_line=closing_line,
                body=tuple(body),
            )
        )
        index = cursor + 1
    return tuple(blocks)


def split_unconditional_blocks(
    blocks: Sequence[HeredocBlock],
) -> tuple[tuple[HeredocBlock, ...], tuple[HeredocBlock, ...]]:
    """Split ``blocks`` into the unconditionally emitted ones and the guarded ones.

    The discriminator is INDENTATION, anchored on the single truncating block: that
    block opens the document, so whatever nesting level it sits at is the level at
    which the generator emits unconditionally. Anything nested deeper is inside a
    guard. Deriving the level from the script instead of hardcoding ``4`` means a
    wholesale re-indentation of the function does not break the extractor, while a
    change to the NESTING - which is what actually changes the semantics - still does.

    Aborts if the truncating block is missing, duplicated, or not first: each of those
    means the document no longer has one unambiguous beginning, and every downstream
    assertion would be reading a shape nobody verified.

    Args:
        blocks: Blocks targeting the admission config file, in file order.

    Returns:
        ``(unconditional, conditional)``, both in file order.
    """
    __tracebackhide__ = True
    assert blocks, (
        f"{REQUIREMENT}: SETUP BREAKAGE - no heredoc in the generator targets the "
        f"admission configuration file. Either the generator stopped producing it or the "
        f"opening-line pattern no longer matches the way it is written."
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
    unconditional_indent = blocks[0].indent
    unconditional = tuple(block for block in blocks if block.indent == unconditional_indent)
    conditional = tuple(block for block in blocks if block.indent != unconditional_indent)
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
    # guess at a substitution.
    assert "${" not in text, (
        f"{REQUIREMENT}: SETUP BREAKAGE - the generated admission configuration now "
        f"contains a shell expansion ('${{'), so its text is no longer literal and "
        f"reading it statically is no longer valid. Assert it from the shell-boundary "
        f"tier (tests/unit/shell/) against the real generator instead.\n"
        f"--- assembled ---\n{text}"
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
        f"{REQUIREMENT}: expected exactly {EXPECTED_UNCONDITIONAL_BLOCKS} unconditional "
        f"blocks at nesting indent {blocks[0].indent}, found {len(unconditional)} at "
        f"line(s) {[block.opening_line for block in unconditional]}."
    )
    assert len(conditional) == EXPECTED_TARGET_BLOCKS - EXPECTED_UNCONDITIONAL_BLOCKS, (
        f"{REQUIREMENT}: expected exactly "
        f"{EXPECTED_TARGET_BLOCKS - EXPECTED_UNCONDITIONAL_BLOCKS} guarded block(s) to be "
        f"excluded, found {len(conditional)} at line(s) "
        f"{[block.opening_line for block in conditional]}."
    )

    # Every kept block sits at the same nesting level as the block that opens the
    # document; every excluded block is nested DEEPER, which is what "inside a guard"
    # looks like. A guarded block re-indented to the unconditional level would be
    # silently swept into the assembly, so the direction is asserted and not just the
    # inequality.
    assert {block.indent for block in unconditional} == {blocks[0].indent}, (
        f"{REQUIREMENT}: the blocks selected as unconditional do not all share the "
        f"document-opening indent {blocks[0].indent}: "
        f"{sorted({block.indent for block in unconditional})}."
    )
    shallow_conditional = [
        block.opening_line for block in conditional if block.indent <= blocks[0].indent
    ]
    assert not shallow_conditional, (
        f"{REQUIREMENT}: block(s) at line(s) {shallow_conditional} were excluded from the "
        f"assembly yet are not nested deeper than the unconditional level "
        f"{blocks[0].indent}, so the indentation discriminator no longer distinguishes "
        f"guarded from unguarded emission. Re-derive the discriminator rather than "
        f"widening it."
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

    LITERAL: the three unconditional bodies contain no ``${...}`` expansion, so reading
    them statically yields exactly the bytes a real master receives. The moment that
    stops being true, a static reader is asserting against a template rather than
    against content, and the assertion must move to the shell tier.

    NO GUARDED PLUGIN: ``ImagePolicyWebhook`` is absent from the assembly. This is
    deliberately NOT a claim that the plugin is absent from the shipped runtime file -
    it is legitimately configured when an operator requests it. The claim is only that
    the DEFAULT shape this module asserts on does not include it, which is what makes
    those assertions describe what every master gets rather than one optional variant.
    """
    blocks = extract_target_heredocs(read_generator_text(repo_root))
    unconditional, conditional = split_unconditional_blocks(blocks)
    assembled = assemble_admission_config(unconditional)

    assert "${" not in assembled, (
        f"{REQUIREMENT}: the assembled admission configuration contains a shell expansion "
        f"('${{'), so its heredoc bodies are no longer literal and static extraction is no "
        f"longer a valid way to recover them.\n--- assembled ---\n{assembled}"
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
