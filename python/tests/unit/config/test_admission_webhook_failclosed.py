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

"""Config-schema tests for V5: the admission webhook must fail CLOSED.

AAP §0.4.2.3 / §0.5.1 / §0.10.2 (V5) — tech-spec §6.4.4 (admission control)

REQUIREMENT LOCKED BY THIS MODULE: F-005-RQ-001.

WHY THIS MODULE ASSERTS THE WHOLE WEBHOOK SHAPE RATHER THAN ONE FIELD. V5 had
NO AUTOMATED TEST BEFORE THIS MODULE. AAP §0.3.1.1 lists F-005 as a "config
assertion - no Go test exists today" and §0.7.1.4 records it as locked by
"nothing - inspection only", so there is no Go ancestor to port and no prior
assertion density to preserve. Every field below was therefore held only by a
human reading the file. This module converts that eyeball check into a CI gate,
which is a change in ASSURANCE and not in behaviour: not one line of production
configuration is touched (AAP §0.8.2 keeps the committed manifests read-only).
Because the check being replaced covered the whole document, this module does
too - a single-field test would silently drop the rest of what inspection used
to catch.

INVARIANTS LOCKED BY THIS MODULE:

1. THE WEBHOOK FAILS CLOSED. ``failurePolicy: Fail``. ``Ignore`` makes the
   webhook fail-OPEN, admitting PersistentVolumes unmutated whenever the
   endpoint is unreachable, which is exactly the weakness V5 closed.
2. THE BOUNDING FIELDS ARE UNCHANGED. ``timeoutSeconds: 5`` as an int, and
   ``sideEffects: None`` - the *string* (see the PyYAML note below).
3. THE REVIEW VERSION IS PINNED. ``admissionReviewVersions: ["v1"]`` exactly,
   so re-admitting the deprecated ``v1beta1`` fails here first.
4. THE BLAST RADIUS IS UNCHANGED. Exactly one rule, matching only CREATE on
   core/v1 ``persistentvolumes``, and exactly one CEL match condition
   (``only-gce``) so non-GCE volumes never reach the endpoint.
5. NO REAL CA CERTIFICATE IS COMMITTED. ``caBundle`` is the substitution
   placeholder ``__CLOUD_PVL_ADMISSION_CA_CERT__`` and is not a base64 blob.
6. THIS IS THE ONLY ``failurePolicy`` UNDER ``cluster/``. The field assertions
   above cannot see a SECOND, fail-open webhook being added elsewhere in the
   deployment tree; invariant 6 is what catches that.

TWO MEASURED FACTS THAT CONTRADICT THE NATURAL ASSUMPTION. Both are recorded
here and again at their assertions, because both are things a future
maintainer would otherwise "simplify" into a defect:

* ``sideEffects`` DECODES TO THE PYTHON STRING ``"None"``, NOT TO ``None``.
  PyYAML resolves a null only from ``null``, ``~``, ``Null``, ``NULL`` or an
  empty value; the bare token ``None`` is not one of them. The value is the
  Kubernetes ``SideEffectClass`` enum member whose name collides with Python's
  keyword. Measured: ``repr`` is ``'None'`` and ``type`` is ``str``. So
  ``assert webhook["sideEffects"] is None`` FAILS against the shipped file.
* ``only-gce`` IS A ``matchConditions`` ENTRY, NOT A ``rules[]`` ENTRY. It is a
  CEL expression evaluated after the rules match, so it is asserted under
  ``matchConditions`` below. Prose that calls it a "rule" is loose language,
  not a second admission rule.

TIER. L3 config-schema (``pytest.mark.config``): pure decode-and-assert. No
subprocess, no network, no etcd, no API server, and nothing is written - the
manifest and the ``cluster/`` walk are read-only. ``pytest -m "not
integration"`` runs it, and it needs no infrastructure at all.

ASSERTION SEMANTICS. With no Go ancestor there is no ``t.Fatalf``/``t.Errorf``
split to port, so the intent behind it is applied instead (AAP §0.4.1.2). A
missing or unparseable manifest, a wrong ``kind`` or a webhook count other than
one is SETUP BREAKAGE: it means this module is not looking at what it thinks it
is, every downstream field assertion would be meaningless, and it ABORTS. The
independent posture fields accumulate through ``pytest.Subtests`` instead, so
one run reports every deviation rather than only the first - the analogue of
``t.Errorf``, which matters because a reader of a CI failure needs the full
list of what regressed.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final

import pytest
import yaml

pytestmark = pytest.mark.config


# ---------------------------------------------------------------------------
# Measured expectations. Every literal below was read out of the shipped
# 25-line manifest with yaml.safe_load and recorded before any assertion was
# written; none is inferred from documentation. Mappings are wrapped in
# MappingProxyType and sequences are tuples so that no test can mutate a shared
# expectation and leak into another test under pytest-randomly or -n auto.
# ---------------------------------------------------------------------------

#: The requirement identifier every failure message names, so a CI failure reads
#: as a requirement violation rather than a value mismatch (AAP §0.7.2). Only
#: identifiers the repository itself states are cited here.
_REQUIREMENT: Final = "F-005-RQ-001"

#: Path components of the committed manifest, relative to the repository root.
#: Joined onto the session-scoped ``repo_root`` fixture rather than derived from
#: ``__file__`` or the process working directory, so the module is addressable
#: from any invocation directory.
_MANIFEST_PARTS: Final = (
    "cluster",
    "gce",
    "addons",
    "cloud-pvl-admission",
    "mutating-webhook-configuration.yaml",
)

#: The same path as one POSIX string, for messages and for the scan guard below.
_MANIFEST_RELATIVE_POSIX: Final = "/".join(_MANIFEST_PARTS)

#: Root of the subtree the sole-declaration invariant covers. DERIVED from
#: _MANIFEST_PARTS rather than written out again, so the scan root and the
#: expected hit path can never drift apart and leave the guard checking for a
#: file the walk never visits.
_CLUSTER_DIR_NAME: Final = _MANIFEST_PARTS[0]

_EXPECTED_API_VERSION: Final = "admissionregistration.k8s.io/v1"
_EXPECTED_KIND: Final = "MutatingWebhookConfiguration"

#: Carried by BOTH ``metadata.name`` and ``webhooks[0].name`` in the shipped
#: file. Asserted in both places and then asserted to agree.
_EXPECTED_NAME: Final = "cloud-pvl-admission.k8s.io"

#: The fail-closed posture itself. The one value in this module whose regression
#: is a security regression rather than a drift.
_EXPECTED_FAILURE_POLICY: Final = "Fail"
_FAIL_OPEN_FAILURE_POLICY: Final = "Ignore"

#: An int in the shipped file, not the string "5". The only committed bound on
#: how long admission waits for this endpoint.
_EXPECTED_TIMEOUT_SECONDS: Final = 5

#: THE STRING "None", not Python's None. See the module docstring: PyYAML does
#: not resolve the bare token ``None`` to a null, and this is the Kubernetes
#: SideEffectClass enum value. Do not "simplify" the assertion that uses this
#: into an ``is None`` comparison - it would fail against the shipped file.
_EXPECTED_SIDE_EFFECTS: Final = "None"

#: Exact list equality, so adding the deprecated "v1beta1" fails.
_EXPECTED_ADMISSION_REVIEW_VERSIONS: Final = ("v1",)

#: ``webhooks[0].rules[0]``, field for field. The list-valued fields are kept
#: separate from the scalar ``scope`` so each can be compared against the right
#: shape without branching inside the assertion loop.
_EXPECTED_RULE_LIST_FIELDS: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {
        # The core API group, which YAML spells as the empty string.
        "apiGroups": ("",),
        "apiVersions": ("v1",),
        # CREATE only: this webhook defaults a new PersistentVolume and has no
        # business intercepting updates or deletes.
        "operations": ("CREATE",),
        "resources": ("persistentvolumes",),
    }
)
_EXPECTED_RULE_SCOPE: Final = "*"

#: Every key the rule is allowed to carry. Asserted as a set so that an added
#: field - a widened ``operations`` sibling, a ``resourceNames`` narrowing that
#: silently changes meaning - is caught rather than ignored.
_EXPECTED_RULE_KEYS: Final = frozenset({*_EXPECTED_RULE_LIST_FIELDS, "scope"})

#: ``webhooks[0].matchConditions[0]``. A CEL match condition, NOT a rules[]
#: entry: it is evaluated after the rule matches and is what keeps non-GCE
#: PersistentVolumes from ever reaching the endpoint.
_EXPECTED_MATCH_CONDITION: Final[Mapping[str, str]] = MappingProxyType(
    {
        "name": "only-gce",
        "expression": "has(object.spec.gcePersistentDisk)",
    }
)

_EXPECTED_CLIENT_CONFIG_URL: Final = "https://127.0.0.1:9001/admit"

#: The substitution token the deployment tooling replaces at cluster turn-up.
#: Asserting it exactly is how this module enforces that no real CA certificate
#: is ever committed to the tree.
_CA_BUNDLE_PLACEHOLDER: Final = "__CLOUD_PVL_ADMISSION_CA_CERT__"

#: A plausible base64 body: the shape a real, DER-encoded CA certificate takes
#: once base64-encoded into ``caBundle``. Used as a NEGATIVE assertion, so that
#: substituting real key material fails this module even if someone also
#: "updates" the placeholder constant above. 40 characters is far below the
#: length of any real certificate and far above any placeholder, and the
#: placeholder itself cannot match because it contains underscores.
_BASE64_BODY_PATTERN: Final = re.compile(r"^[A-Za-z0-9+/]{40,}={0,2}$")

#: The token whose declarations are counted across ``cluster/``.
_FAILURE_POLICY_TOKEN: Final = "failurePolicy"

#: The one declaration that may exist, as it is written in the shipped file.
#: Compared against the stripped line so that re-indentation is not a failure
#: but a changed VALUE is.
_EXPECTED_FAILURE_POLICY_DECLARATION: Final = (
    f"{_FAILURE_POLICY_TOKEN}: {_EXPECTED_FAILURE_POLICY}"
)

#: Coarse tripwire against a degenerate walk. 259 files were measured under
#: ``cluster/`` in this tree, so this floor sits far below the real count and
#: ordinary additions or removals never approach it - while a walk that was
#: pointed at the wrong root, or that excluded everything, trips it
#: immediately. The precise vacuity guard is the membership assertion beside
#: it; this one exists because a count of zero must never read as "no
#: violations found".
_CLUSTER_SCAN_FILE_FLOOR: Final = 100


# ---------------------------------------------------------------------------
# Read-only helpers. Plain module-level functions rather than fixtures: this
# folder carries no conftest.py, and pytest can execute a module-, package- or
# session-scoped autouse fixture declared inline in a test module twice under
# --doctest-modules (AAP §0.4.4.1). Nothing here caches, so no state is shared
# between tests and the module holds no mutable state at all.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _TokenHit:
    """One occurrence of a scanned token, located precisely enough to act on."""

    relative_path: str
    line_number: int
    line: str

    def render(self) -> str:
        """``path:line: text`` - the same shape a grep hit takes, on purpose."""
        return f"{self.relative_path}:{self.line_number}: {self.line.strip()}"


@dataclass(frozen=True)
class _TreeScan:
    """The complete result of one read-only text scan of a directory tree.

    ``scanned`` and ``unreadable`` are carried alongside ``hits`` because a scan
    that found nothing is indistinguishable from a scan that read nothing unless
    the caller can see how much was actually read. A file that could not be read
    is RECORDED rather than silently skipped, for the same reason.
    """

    hits: tuple[_TokenHit, ...]
    scanned: frozenset[str]
    unreadable: tuple[str, ...]

    @property
    def files_scanned(self) -> int:
        """How many files were opened and searched."""
        return len(self.scanned)

    def render_hits(self) -> str:
        """Every hit, one per line - never just a count."""
        if not self.hits:
            return "  (no occurrence found)"
        return "\n".join(f"  - {hit.render()}" for hit in self.hits)


def _scan_tree_for_token(root: Path, token: str, *, relative_to: Path) -> _TreeScan:
    """Recursively search every file under ``root`` for ``token``.

    Pure Python, deliberately: shelling out to ``grep`` would put a subprocess in
    a tier defined as subprocess-free (AAP §0.5.2.2) and would tie the assertion
    to a tool whose recursion and binary-file rules differ between platforms.

    Symlinks are skipped rather than followed. ``cluster/gce/{cos,custom,ubuntu}``
    are all symlinks to ``cluster/gce/gci``, so following them would report the
    same declaration three extra times and turn a passing invariant into a
    phantom failure. ``Path.rglob`` does not descend into a symlinked directory,
    and the explicit check documents that and covers a future symlink to a file.

    Bytes are read and decoded with ``errors="replace"`` rather than
    ``errors="ignore"``: replacement preserves both the line structure - so a
    reported line number is accurate - and the separation between bytes, so a
    dropped byte can never fuse ``failure`` and ``Policy`` into a hit that is not
    in the file. On the file that cannot be decoded at all, the residual risk is
    a FALSE FAILURE rather than a false pass, which is the safe direction.

    Args:
        root: Directory to walk. Every regular file beneath it is read.
        token: Literal substring to search for. Not a regular expression: the
            invariant is about a YAML key appearing at all, and a pattern would
            invite a subtle mismatch with the ``grep`` measurement it reproduces.
        relative_to: Directory the reported paths are made relative to, so that
            messages name repository paths and never absolute build paths.

    Returns:
        The hits in a stable path order, the set of files actually read, and the
        files that could not be read.
    """
    hits: list[_TokenHit] = []
    scanned: set[str] = set()
    unreadable: list[str] = []

    for candidate in sorted(root.rglob("*")):
        if candidate.is_symlink() or not candidate.is_file():
            continue

        relative_path = candidate.relative_to(relative_to).as_posix()
        try:
            raw = candidate.read_bytes()
        except OSError as exc:
            unreadable.append(f"{relative_path} ({exc})")
            continue

        scanned.add(relative_path)
        text = raw.decode("utf-8", errors="replace")
        if token not in text:
            continue

        for number, line in enumerate(text.splitlines(), start=1):
            if token in line:
                hits.append(
                    _TokenHit(relative_path=relative_path, line_number=number, line=line)
                )

    return _TreeScan(
        hits=tuple(hits),
        scanned=frozenset(scanned),
        unreadable=tuple(unreadable),
    )


def _load_manifest(repo_root: Path) -> Mapping[str, object]:
    """Decode the committed webhook manifest, or ABORT.

    Every failure below is setup breakage rather than a posture finding: if the
    document cannot be read or is not a mapping, this module is not looking at
    the artefact it claims to speak for, and continuing would report field
    failures that say nothing about the deployed posture. Hence ``pytest.fail``
    (abort) and not an accumulated subtest.

    The manifest is opened read-only and never rewritten: AAP §0.8.2 keeps the
    committed manifests out of scope for modification, and a test that repaired
    its own input would assert nothing.
    """
    path = repo_root.joinpath(*_MANIFEST_PARTS)

    if not path.is_file():
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: the committed admission-webhook manifest is "
            f"missing. Expected a regular file at {_MANIFEST_RELATIVE_POSIX} (resolved to "
            f"{path}). Nothing can be held to a fail-closed posture while the artefact that "
            f"declares it is absent."
        )

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} could not be read: "
            f"{exc}"
        )

    try:
        document = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} is not parseable "
            f"YAML: {exc}. The API server would reject it too, so this is a broken artefact "
            f"rather than a weakened posture."
        )

    if not isinstance(document, dict):
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} decoded to "
            f"{type(document).__name__}, expected a single YAML mapping. A multi-document "
            f"or list-rooted file is not a MutatingWebhookConfiguration."
        )

    return document


def _sole_webhook(document: Mapping[str, object]) -> Mapping[str, object]:
    """Return the one and only webhook entry, or ABORT.

    Cardinality is checked here rather than assumed anywhere else. Every field
    assertion in this module reads ``webhooks[0]``, so a second entry would leave
    the additional webhook entirely unasserted - it could be fail-open and this
    module would still be green. That makes the count setup breakage, and it
    aborts.
    """
    kind = document.get("kind")
    if kind != _EXPECTED_KIND:
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} declares kind "
            f"{kind!r}, expected {_EXPECTED_KIND!r}. This module asserts the posture of a "
            f"mutating admission webhook; a different kind means it is asserting nothing."
        )

    webhooks = document.get("webhooks")
    if not isinstance(webhooks, list):
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
            f"{type(webhooks).__name__} under 'webhooks', expected a list."
        )

    if len(webhooks) != 1:
        names = [entry.get("name") for entry in webhooks if isinstance(entry, dict)]
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} declares "
            f"{len(webhooks)} webhooks {names!r}, expected exactly 1. Every posture "
            f"assertion in this module reads webhooks[0], so any additional entry would go "
            f"completely unasserted and could be fail-open while this module stayed green. "
            f"Assert the new entry explicitly instead of relaxing this check."
        )

    webhook = webhooks[0]
    if not isinstance(webhook, dict):
        pytest.fail(
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
            f"{type(webhook).__name__} at webhooks[0], expected a mapping."
        )

    return webhook


def _load_sole_webhook(repo_root: Path) -> Mapping[str, object]:
    """Decode the manifest and return its single webhook entry, or ABORT.

    Re-read per test rather than cached in a module global: eight reads of a
    700-byte committed file cost nothing, and a cache would be exactly the shared
    mutable state that makes a suite order-dependent under pytest-randomly and
    unsafe under ``-n auto``.
    """
    return _sole_webhook(_load_manifest(repo_root))


# ---------------------------------------------------------------------------
# Tests. Plain module-level functions, never a unittest.TestCase class: the
# repository's own 2,853 Go test files use testify/suite exactly zero times, so a
# class-based idiom would be foreign here (AAP §0.9.2). Node ids are therefore
# the bare function names, which python/tests/parity/parity_map.py depends on
# being stable - rename one and the parity map must be updated in the same
# change.
# ---------------------------------------------------------------------------


def test_webhook_configuration_envelope_is_the_expected_document(repo_root: Path) -> None:
    """INVARIANT: this module is asserting the artefact the cluster actually ships.

    Identity before posture. Everything else in this module reads
    ``webhooks[0]``, so the envelope - API version, kind, name, and a webhook
    count of exactly one - decides whether those reads mean anything. All of it
    is therefore SETUP BREAKAGE and aborts on the first failure: a report that
    ``failurePolicy`` is missing from a document that is not even a
    MutatingWebhookConfiguration would be noise, not a finding.

    The name is asserted in BOTH places it appears and then asserted to agree,
    because the addon manager reconciles by ``metadata.name`` while the API
    server reports admission decisions by the webhook's own name. A divergence
    between them makes a rejection untraceable back to this configuration.
    """
    document = _load_manifest(repo_root)

    # Aborts on a wrong kind or a webhook count other than one.
    webhook = _sole_webhook(document)

    api_version = document.get("apiVersion")
    assert api_version == _EXPECTED_API_VERSION, (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} declares apiVersion "
        f"{api_version!r}, expected {_EXPECTED_API_VERSION!r}. The v1 admission registration "
        f"API is the one whose fail-closed semantics this module asserts."
    )

    metadata = document.get("metadata")
    assert isinstance(metadata, dict), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
        f"{type(metadata).__name__} under 'metadata', expected a mapping."
    )

    configuration_name = metadata.get("name")
    assert configuration_name == _EXPECTED_NAME, (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} declares "
        f"metadata.name {configuration_name!r}, expected {_EXPECTED_NAME!r}. The addon "
        f"manager reconciles this object by that name, so renaming it orphans the deployed "
        f"configuration rather than updating it."
    )

    webhook_name = webhook.get("name")
    assert webhook_name == _EXPECTED_NAME, (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} declares "
        f"webhooks[0].name {webhook_name!r}, expected {_EXPECTED_NAME!r}. The API server "
        f"attributes admission decisions to this name."
    )

    assert configuration_name == webhook_name, (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} names the configuration "
        f"{configuration_name!r} but its webhook {webhook_name!r}. They must agree, or a "
        f"rejection reported by the API server cannot be traced back to this file."
    )


def test_webhook_fails_closed(repo_root: Path) -> None:
    """INVARIANT: ``failurePolicy: Fail``. THIS IS THE CONTROL V5 ADDED.

    Given its own test rather than folded into the accumulating posture test
    below, so that this one regression always gets its own line in a CI report
    and is never read as one item in a list of drifts. It is not a drift.

    A bare assert, because there is exactly one thing to say: with ``Ignore``
    every PersistentVolume creation that the webhook fails to answer is admitted
    unmutated, silently, and the cluster reports nothing. That is the fail-open
    weakness V5 closed. If this assertion fails, restore the manifest - do not
    relax the assertion (AAP §0.10.2).
    """
    webhook = _load_sole_webhook(repo_root)

    failure_policy = webhook.get("failurePolicy")
    assert failure_policy == _EXPECTED_FAILURE_POLICY, (
        f"{_REQUIREMENT} VIOLATED - THE WEBHOOK NO LONGER FAILS CLOSED: "
        f"{_MANIFEST_RELATIVE_POSIX} declares failurePolicy {failure_policy!r}, expected "
        f"{_EXPECTED_FAILURE_POLICY!r}. With {_FAIL_OPEN_FAILURE_POLICY!r} - or with the "
        f"field absent, which the API server defaults to {_FAIL_OPEN_FAILURE_POLICY!r} - the "
        f"webhook FAILS OPEN: every PersistentVolume CREATE that this endpoint cannot answer, "
        f"because it is down, unreachable or past its timeout, is admitted UNMUTATED and "
        f"nothing is reported. That is precisely the weakness this control closed. Restore "
        f"{_EXPECTED_FAILURE_POLICY!r} in the manifest; never weaken this assertion to make "
        f"the gate pass."
    )


def test_webhook_timeout_and_side_effects_bounded(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT: ``timeoutSeconds: 5`` as an int, and ``sideEffects: "None"``.

    The two fields that bound what failing closed COSTS. The timeout is the only
    committed bound on how long a PersistentVolume CREATE waits for this endpoint
    before the fail-closed policy rejects it, so inflating it converts a
    fail-closed webhook into a request-latency amplifier; removing it lets the
    API server apply its own default instead of the reviewed one. ``sideEffects``
    tells the API server that a dry-run request needs no special handling, and
    getting it wrong makes dry-run results untrustworthy.

    Accumulating through subtests rather than aborting: these two are
    independent, so a run that reports only the first would hide the second, and
    a reader of the CI failure needs both (AAP §0.4.1.2, the ``t.Errorf``
    analogue).

    THE TYPE ASSERTIONS ARE NOT PEDANTRY. ``timeoutSeconds: "5"`` is a YAML
    string that the API server rejects, and it would satisfy a value-only
    comparison written loosely. ``type(...) is int`` and not
    ``isinstance(..., int)`` because ``bool`` is a subclass of ``int`` in Python,
    so ``timeoutSeconds: true`` would pass an isinstance check.
    """
    webhook = _load_sole_webhook(repo_root)

    with subtests.test(field="timeoutSeconds"):
        timeout_seconds = webhook.get("timeoutSeconds")
        assert timeout_seconds == _EXPECTED_TIMEOUT_SECONDS, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares timeoutSeconds "
            f"{timeout_seconds!r}, expected {_EXPECTED_TIMEOUT_SECONDS!r}. This is the only "
            f"committed bound on how long a PersistentVolume CREATE waits for this endpoint "
            f"before the fail-closed policy rejects it. Raising it makes every stalled "
            f"admission that much slower; omitting it hands the decision to the API server's "
            f"default instead of the reviewed value."
        )
        assert type(timeout_seconds) is int, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares timeoutSeconds as "
            f"{type(timeout_seconds).__name__}, expected a YAML integer. A quoted "
            f"'{_EXPECTED_TIMEOUT_SECONDS}' is a string and the API server rejects it, and "
            f"'true' is a bool, which Python would let pass an isinstance(int) check."
        )

    with subtests.test(field="sideEffects"):
        side_effects = webhook.get("sideEffects")
        # MEASURED, and the opposite of the natural assumption: this is the
        # PYTHON STRING "None". PyYAML resolves a null only from null, ~, Null,
        # NULL or an empty value, so the bare token None stays a string - and
        # here it is the Kubernetes SideEffectClass enum member that happens to
        # share a name with Python's keyword. `is None` would FAIL against the
        # shipped file. Do not "simplify" this comparison.
        assert side_effects == _EXPECTED_SIDE_EFFECTS, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares sideEffects "
            f"{side_effects!r}, expected the string {_EXPECTED_SIDE_EFFECTS!r}. The declared "
            f"class tells the API server this webhook mutates nothing outside the object "
            f"under review, which is what makes a dry-run request safe to send to it. Any "
            f"other class - or a YAML null, which is NOT what the shipped file carries - "
            f"changes that contract."
        )
        assert isinstance(side_effects, str), (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares sideEffects as "
            f"{type(side_effects).__name__}, expected a string. The Kubernetes "
            f"SideEffectClass value is the literal token None, which YAML does NOT resolve "
            f"to a null; a genuine null here means the field was rewritten as 'null' or '~'."
        )


def test_admission_review_versions_pinned_to_v1(repo_root: Path) -> None:
    """INVARIANT: ``admissionReviewVersions == ["v1"]``, exactly.

    Exact list equality rather than a membership test, deliberately. The API
    server negotiates the FIRST version in this list that it also supports, so
    re-adding the deprecated ``v1beta1`` would not remove ``v1`` - it would
    quietly widen the wire contract this webhook is reviewed against, and a
    ``"v1" in versions`` assertion would stay green throughout. A single bare
    assert, because a list is one value.
    """
    webhook = _load_sole_webhook(repo_root)

    review_versions = webhook.get("admissionReviewVersions")
    assert review_versions == list(_EXPECTED_ADMISSION_REVIEW_VERSIONS), (
        f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares "
        f"admissionReviewVersions {review_versions!r}, expected exactly "
        f"{list(_EXPECTED_ADMISSION_REVIEW_VERSIONS)!r}. Adding a version widens the wire "
        f"contract the endpoint is reviewed against; removing v1 leaves nothing the API "
        f"server can negotiate, and under failurePolicy Fail that rejects every matching "
        f"request."
    )


def test_webhook_scoped_to_persistentvolume_create(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT: exactly one rule, and it matches ONLY CREATE on core/v1 persistentvolumes.

    The blast radius of failing closed. Under ``failurePolicy: Fail`` this rule
    decides which requests get rejected when the endpoint is unavailable, so
    widening any field here converts an outage of one addon into an outage of
    whatever was added: ``operations: ["*"]`` would start blocking deletes,
    ``resources: ["*"]`` would block the whole core API group. That is why every
    field is pinned and why the key set is pinned too.

    Rule CARDINALITY aborts - a second rule would be entirely unasserted, just
    like a second webhook. The FIELDS accumulate, so one run names every widened
    field rather than only the first.
    """
    webhook = _load_sole_webhook(repo_root)

    rules = webhook.get("rules")
    assert isinstance(rules, list), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
        f"{type(rules).__name__} under webhooks[0].rules, expected a list."
    )
    assert len(rules) == 1, (
        f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares {len(rules)} rules, "
        f"expected exactly 1. Every additional rule widens what a fail-closed outage "
        f"rejects, and this module only asserts rules[0], so the rest would go unasserted. "
        f"Rules found: {rules!r}"
    )

    rule = rules[0]
    assert isinstance(rule, dict), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
        f"{type(rule).__name__} at webhooks[0].rules[0], expected a mapping."
    )

    for field, expected in _EXPECTED_RULE_LIST_FIELDS.items():
        with subtests.test(field=field):
            observed = rule.get(field)
            assert observed == list(expected), (
                f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares "
                f"rules[0].{field} {observed!r}, expected exactly {list(expected)!r}. Under "
                f"failurePolicy {_EXPECTED_FAILURE_POLICY!r} this field decides which "
                f"requests are rejected while the endpoint is unavailable, so widening it "
                f"turns an addon outage into an outage of everything newly matched."
            )

    with subtests.test(field="scope"):
        scope = rule.get("scope")
        assert scope == _EXPECTED_RULE_SCOPE, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares rules[0].scope "
            f"{scope!r}, expected {_EXPECTED_RULE_SCOPE!r}. PersistentVolumes are "
            f"cluster-scoped, so narrowing this to 'Namespaced' would stop the webhook "
            f"matching anything at all and silently disable the control."
        )

    with subtests.test(field="__keys__"):
        observed_keys = frozenset(rule)
        assert observed_keys == _EXPECTED_RULE_KEYS, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares rule fields "
            f"{sorted(observed_keys)!r}, expected exactly {sorted(_EXPECTED_RULE_KEYS)!r}. "
            f"Unexpected: {sorted(observed_keys - _EXPECTED_RULE_KEYS)!r}. Missing: "
            f"{sorted(_EXPECTED_RULE_KEYS - observed_keys)!r}. A field this module does not "
            f"assert can change the rule's meaning while every assertion above stays green."
        )


def test_only_gce_match_condition_present(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT: exactly one CEL match condition, ``only-gce``, on the GCE PD field.

    NOTE ON PLACEMENT, because the prose calls this a "rule": ``only-gce`` is a
    ``matchConditions`` entry, NOT an entry in ``rules[]``. The two are different
    mechanisms - ``rules`` selects on group, version, resource and operation,
    while ``matchConditions`` evaluates CEL against the object AFTER the rule has
    matched. Asserting it under ``rules[]`` would assert nothing and would leave
    this condition unguarded, so do not "correct" it into that field.

    Why it matters under a fail-closed policy: the rule above matches every
    PersistentVolume CREATE, and this condition is the only thing narrowing that
    to GCE persistent disks. Remove or widen it and an outage of this endpoint
    starts rejecting PersistentVolume creation for every other storage backend in
    the cluster.

    Cardinality aborts; the two fields accumulate.
    """
    webhook = _load_sole_webhook(repo_root)

    match_conditions = webhook.get("matchConditions")
    assert isinstance(match_conditions, list), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
        f"{type(match_conditions).__name__} under webhooks[0].matchConditions, expected a "
        f"list. Absent entirely, EVERY PersistentVolume CREATE would reach this endpoint - "
        f"and under failurePolicy {_EXPECTED_FAILURE_POLICY!r} an outage would reject all of "
        f"them, not just the GCE ones."
    )
    assert len(match_conditions) == 1, (
        f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares "
        f"{len(match_conditions)} match conditions, expected exactly 1. Conditions are "
        f"ANDed, so an extra one narrows the webhook further and can disable the control "
        f"without changing a single field this module asserts. Found: {match_conditions!r}"
    )

    condition = match_conditions[0]
    assert isinstance(condition, dict), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
        f"{type(condition).__name__} at webhooks[0].matchConditions[0], expected a mapping."
    )

    for field, expected_value in _EXPECTED_MATCH_CONDITION.items():
        with subtests.test(field=field):
            observed = condition.get(field)
            assert observed == expected_value, (
                f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares "
                f"matchConditions[0].{field} {observed!r}, expected {expected_value!r}. This "
                f"CEL condition - NOT a rules[] entry - is the only thing confining a "
                f"fail-closed outage of this endpoint to GCE persistent disks."
            )

    with subtests.test(field="__keys__"):
        observed_keys = frozenset(condition)
        expected_keys = frozenset(_EXPECTED_MATCH_CONDITION)
        assert observed_keys == expected_keys, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares match-condition "
            f"fields {sorted(observed_keys)!r}, expected exactly {sorted(expected_keys)!r}. "
            f"Unexpected: {sorted(observed_keys - expected_keys)!r}. Missing: "
            f"{sorted(expected_keys - observed_keys)!r}"
        )


def test_ca_bundle_is_a_placeholder(repo_root: Path, subtests: pytest.Subtests) -> None:
    """INVARIANT: the client config points at the loopback endpoint and carries NO real CA.

    This is where the no-secrets-ever rule is ENFORCED rather than merely stated
    (AAP §0.11.1). ``caBundle`` must be the substitution token the deployment
    tooling replaces at cluster turn-up, and the negative assertion beside it
    rejects anything shaped like base64-encoded certificate material - so pasting
    a real CA in fails this gate even if the expected constant were "updated" to
    match, because the shape check does not depend on the expected value.

    The URL is asserted too: an endpoint moved off loopback would send admission
    review bodies, which contain the full PersistentVolume object, across the
    network to something this configuration never reviewed.

    All three accumulate, so one run reports every deviation.
    """
    webhook = _load_sole_webhook(repo_root)

    client_config = webhook.get("clientConfig")
    assert isinstance(client_config, dict), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} has a "
        f"{type(client_config).__name__} under webhooks[0].clientConfig, expected a mapping."
    )

    with subtests.test(field="url"):
        url = client_config.get("url")
        assert url == _EXPECTED_CLIENT_CONFIG_URL, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares clientConfig.url "
            f"{url!r}, expected {_EXPECTED_CLIENT_CONFIG_URL!r}. Admission review bodies "
            f"carry the whole object under review, so moving this endpoint off loopback "
            f"sends them somewhere this configuration has not reviewed."
        )

    with subtests.test(field="caBundle"):
        ca_bundle = client_config.get("caBundle")
        assert ca_bundle == _CA_BUNDLE_PLACEHOLDER, (
            f"{_REQUIREMENT} VIOLATED: {_MANIFEST_RELATIVE_POSIX} declares "
            f"clientConfig.caBundle {ca_bundle!r}, expected the substitution placeholder "
            f"{_CA_BUNDLE_PLACEHOLDER!r}. The deployment tooling replaces that token at "
            f"cluster turn-up; a committed value means real trust material, or a stale "
            f"certificate that will fail TLS verification, is now in the tree."
        )

    with subtests.test(field="caBundle-is-not-certificate-material"):
        ca_bundle = client_config.get("caBundle")
        assert isinstance(ca_bundle, str), (
            f"{_REQUIREMENT} SETUP BREAKAGE: {_MANIFEST_RELATIVE_POSIX} declares "
            f"clientConfig.caBundle as {type(ca_bundle).__name__}, expected a string."
        )
        # Whitespace is removed first so that a folded or block-scalar base64
        # body cannot evade the shape check by carrying newlines.
        compact = re.sub(r"\s+", "", ca_bundle)
        assert not _BASE64_BODY_PATTERN.fullmatch(compact), (
            f"{_REQUIREMENT} VIOLATED - REAL KEY MATERIAL IN THE TREE: "
            f"{_MANIFEST_RELATIVE_POSIX} declares a clientConfig.caBundle of "
            f"{len(compact)} characters that is shaped like base64-encoded certificate "
            f"material. Only the placeholder {_CA_BUNDLE_PLACEHOLDER!r} belongs in a "
            f"committed manifest; certificate issuance is a deployment-time step, and no "
            f"real CA, key or token may be committed."
        )


def test_failure_policy_declared_exactly_once_under_cluster(repo_root: Path) -> None:
    """INVARIANT: ``cluster/`` declares ``failurePolicy`` exactly ONCE, and it is ``Fail``.

    THE ONLY ASSERTION IN THIS MODULE THAT CAN SEE A SECOND WEBHOOK. Every test
    above reads one known file, so all of them stay green when somebody adds a
    brand-new fail-open MutatingWebhookConfiguration somewhere else under
    ``cluster/``. Counting declarations across the whole deployment tree is what
    catches that, and it is why this test exists at all.

    Pure Python, no subprocess: this tier is defined as subprocess-free
    (AAP §0.5.2.2), and ``grep``'s recursion, symlink and binary-file rules vary
    between platforms while ``pathlib`` does not. Measured to agree exactly with
    ``grep -rn failurePolicy cluster/`` on this tree: 259 files read, one hit,
    same path, same line.

    THREE GUARDS AGAINST A VACUOUS PASS, because "no occurrences found" and "no
    files read" would otherwise be indistinguishable - and a test that passes
    because it read nothing is worse than no test:
      1. every file under ``cluster/`` was readable;
      2. the file that is KNOWN to contain the token was actually visited;
      3. the number of files read clears a floor far below the measured count.

    The declaration's VALUE is asserted, not its line number. A future comment
    inserted above it must not fail this gate, whereas a change from ``Fail``
    must - so the check is semantic rather than positional.
    """
    cluster_dir = repo_root / _CLUSTER_DIR_NAME
    assert cluster_dir.is_dir(), (
        f"{_REQUIREMENT} SETUP BREAKAGE: {_CLUSTER_DIR_NAME}/ is not a directory under "
        f"{repo_root}. The sole-declaration invariant cannot be evaluated over a tree that "
        f"is not there, and it must never be reported as satisfied by default."
    )

    scan = _scan_tree_for_token(
        cluster_dir, _FAILURE_POLICY_TOKEN, relative_to=repo_root
    )

    # Guard 1: an unreadable file is a hole in the scan, so it is reported rather
    # than skipped in silence.
    assert not scan.unreadable, (
        f"{_REQUIREMENT} SETUP BREAKAGE: {len(scan.unreadable)} file(s) under "
        f"{_CLUSTER_DIR_NAME}/ could not be read, so the sole-declaration invariant was "
        f"evaluated over an incomplete tree: {list(scan.unreadable)!r}"
    )

    # Guard 2: the precise, non-brittle vacuity check. If the walk is misrooted,
    # misconfigured or excluding everything, the one file that certainly contains
    # the token will be absent from the scanned set.
    assert _MANIFEST_RELATIVE_POSIX in scan.scanned, (
        f"{_REQUIREMENT} SETUP BREAKAGE - VACUOUS SCAN: the walk of {_CLUSTER_DIR_NAME}/ "
        f"read {scan.files_scanned} file(s) but never visited "
        f"{_MANIFEST_RELATIVE_POSIX}, the file known to declare "
        f"{_FAILURE_POLICY_TOKEN}. Any 'exactly one occurrence' verdict from this scan "
        f"would be meaningless."
    )

    # Guard 3: coarse tripwire against a degenerate walk.
    assert scan.files_scanned >= _CLUSTER_SCAN_FILE_FLOOR, (
        f"{_REQUIREMENT} SETUP BREAKAGE - VACUOUS SCAN: the walk of {_CLUSTER_DIR_NAME}/ "
        f"read only {scan.files_scanned} file(s), below the floor of "
        f"{_CLUSTER_SCAN_FILE_FLOOR}. 259 were measured in this tree, so a count this low "
        f"means the walk is broken rather than that the tree shrank."
    )

    # The invariant itself. Every location is rendered, not just the count, so the
    # failure is actionable without re-running a search by hand.
    assert len(scan.hits) == 1, (
        f"{_REQUIREMENT} VIOLATED: {_FAILURE_POLICY_TOKEN} is declared "
        f"{len(scan.hits)} time(s) under {_CLUSTER_DIR_NAME}/ across "
        f"{scan.files_scanned} file(s) read, expected exactly 1 - the fail-closed "
        f"declaration in {_MANIFEST_RELATIVE_POSIX}. Every additional declaration is an "
        f"admission webhook whose failure posture nothing in this suite asserts, and a "
        f"single fail-open one reopens the weakness V5 closed. All occurrences found:\n"
        f"{scan.render_hits()}"
    )

    hit = scan.hits[0]
    assert hit.relative_path == _MANIFEST_RELATIVE_POSIX, (
        f"{_REQUIREMENT} VIOLATED: the sole {_FAILURE_POLICY_TOKEN} declaration under "
        f"{_CLUSTER_DIR_NAME}/ is in {hit.relative_path!r}, expected "
        f"{_MANIFEST_RELATIVE_POSIX!r}. The declaration moving file means the reviewed "
        f"webhook configuration is no longer the one that carries the posture."
    )
    assert hit.line.strip() == _EXPECTED_FAILURE_POLICY_DECLARATION, (
        f"{_REQUIREMENT} VIOLATED: the sole {_FAILURE_POLICY_TOKEN} declaration under "
        f"{_CLUSTER_DIR_NAME}/ reads {hit.line.strip()!r} at {hit.render()}, expected "
        f"{_EXPECTED_FAILURE_POLICY_DECLARATION!r}. The value, not the line number, is what "
        f"is asserted here, so re-indenting or documenting the field is fine and changing "
        f"what it declares is not."
    )

