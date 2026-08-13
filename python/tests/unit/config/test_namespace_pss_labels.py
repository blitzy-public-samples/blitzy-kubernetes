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

"""Config-schema tests for ``cluster/manifests/namespace-pss-labels.yaml`` (control V2).

AAP §0.4.2.3 (the L3 config-schema blueprint for this module) / §0.5.1 (this
module's row: "enforce/warn/audit plus ``-version`` labels; values in
{privileged, baseline, restricted}") / §0.10.2 (the boundary conditions that
must port unchanged) / §0.7.2 (failure legibility: every message names its
requirement id) / tech-spec §6.4.4.3 (Pod Security modes / zero-downtime
rollout) - the section the manifest itself cites at its line 17.

REQUIREMENT LOCKED BY THIS MODULE: **F-002-RQ-003**, the declarative Pod
Security Admission posture pinned by the committed namespace manifest. AAP
§0.7.1.4 records the namespace-label half of V2 as NEW config-schema
automation, because it is verified today by human inspection only. This module
therefore converts an inspection into a gate, and it changes no production
behaviour whatsoever: the manifest is a READ-ONLY input, decoded and asserted
against, never edited and never replaced by a fixture copy.

THE AAP PROSE AND THE SHIPPED ARTEFACT DISAGREE; THE ARTEFACT WINS.

AAP §0.4.2.3 describes this module as asserting that "every Namespace carries
``pod-security.kubernetes.io/{enforce,warn,audit}`` plus the matching
``-version`` labels". Measured against the artefact as shipped, that statement
is FALSE, and a module implementing it literally would FAIL against this
repository:

    document  metadata.name  labels actually present
    --------  -------------  ------------------------------------------------
    1         default        enforce, warn, audit + all three -version  (6)
    2         kube-system    enforce + enforce-version ONLY             (2)

``kube-system`` carries no ``warn`` and no ``audit`` BY DOCUMENTED DESIGN. The
manifest's own comment at lines 69-72 states that kube-system is kept at the
``privileged`` posture because control-plane components require elevated
access, that this mirrors the ``exemptions.namespaces: ["kube-system"]`` entry
of the cluster-level ``PodSecurityConfiguration``, and - verbatim - "Do NOT
tighten kube-system to baseline/restricted".

So the correction is NOT to relax this module into a trivial pass, and it is
emphatically NOT to "fix" the manifest: adding ``warn``/``audit`` to
kube-system would tighten the control-plane exemption, which is a production
behaviour change and out of scope. The correction is to assert the real,
STRONGER invariant the artefact actually embodies - the mode/version PAIRING
rule in invariant 3 below.

INVARIANTS LOCKED BY THIS MODULE:

1. EXACTLY THE TWO DOCUMENTED NAMESPACES, IN FILE ORDER. A third namespace
   appearing here, or one disappearing, changes the cluster's admission posture
   and must be a deliberate, reviewed edit rather than a silent one.
2. ENFORCE IS UNIVERSAL. Every document pins ``enforce`` AND
   ``enforce-version``. This is the part of the AAP prose that IS true of every
   namespace, and it is what makes each posture blocking rather than advisory.
3. EVERY PRESENT MODE IS PAIRED WITH ITS VERSION - the real content of
   F-002-RQ-003. For each namespace and each of the three modes: if the mode
   label is present then its value is one of the three levels AND its
   ``-version`` companion is present too. An unpaired mode is the actual defect
   this requirement guards against, because a mode with no pinned version
   silently drifts when the control plane is upgraded - exactly the drift the
   manifest's own lines 41-43 warn about.
4. VERSIONS AND LEVELS ARE DISTINCT VOCABULARIES. A ``-version`` value is
   ``latest`` or ``v1.x``, and is never one of privileged/baseline/restricted.
   Conflating the two is a real class of mistake, and ``ParseVersion``
   (staging/src/k8s.io/pod-security-admission/api/helpers.go:121) rejects the
   result.
5. THE ``default`` WORKLOAD POSTURE: enforce=baseline, warn=restricted,
   audit=restricted. These three values are the boundary V2 established; not
   one of them may be weakened to make anything pass.
6. THE ``kube-system`` EXEMPTION HOLDS AND IS NOT TIGHTENED: its ``enforce`` is
   asserted to EQUAL ``privileged``, positively, so that a well-meaning future
   edit to baseline or restricted fails loudly here rather than breaking the
   control plane at runtime. The sibling module
   ``test_generated_admission_config.py`` asserts the other half of the same
   pair, ``exemptions.namespaces: ["kube-system"]`` in the generated
   ``PodSecurityConfiguration``.
7. NO UNKNOWN ``pod-security.kubernetes.io/`` KEY. A typo such as ``enfroce``
   is silently IGNORED by the admission plugin, so the namespace would run
   unprotected while the manifest still looked correct. Only the six recognised
   names are permitted under the prefix.

ABORT VERSUS ACCUMULATE (AAP §0.4.1.2, the Go ``t.Fatalf``/``t.Errorf`` split).
This module has no Go ancestor, so the intent rather than the letter is ported.
:func:`_load_namespace_documents` validates only the artefact's SHAPE and does
so with a bare ``assert`` or :func:`pytest.fail`, because a missing, unparsable
or wrongly-shaped manifest is setup breakage and continuing would emit
cascading noise. Every enumeration over namespaces and modes instead runs
inside ``pytest.Subtests`` blocks, so a run in which BOTH namespaces are broken
names BOTH of them - a bare ``assert`` in a plain loop would stop at the first
and hide the second. Deliberately, shape validation never inspects label
CONTENT: that is precisely what keeps a content defect attributable to its own
namespace and mode instead of aborting the tests that would have reported it.
Where the case list is a FIXED table instead of an artefact-driven enumeration,
``@pytest.mark.parametrize`` with explicit ``ids`` is used, which yields one
independently reported node per case and a stable node id -
``python/tests/parity/parity_map.py`` is a hand-maintained live dependency on
node-id stability (AAP §0.5.5).

PURITY (L3 tier). No subprocess, no network, no etcd, no API server, no writes
and no frozen clock. The only I/O is one read of one committed file, performed
inside test bodies rather than at import time, so collection is side-effect
free. No fixture is declared here either: every value this module needs is a
module constant or is derived by a pure function, which sidesteps the
``--doctest-modules`` hazard that can execute an inline module-, package- or
session-scoped autouse fixture twice, and keeps the module safe under
pytest-randomly and pytest-xdist with no shared mutable state to leak.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml

pytestmark = pytest.mark.config

#: The artefact under test, relative to the ``repo_root`` session fixture.
#: Joined onto that fixture rather than derived from ``__file__`` or the current
#: working directory, so the module resolves identically however pytest is
#: invoked. ``python/tests/conftest.py`` names this very path in ``repo_root``'s
#: docstring as one of the paths consumers join onto it.
MANIFEST_RELATIVE_PARTS: tuple[str, ...] = (
    "cluster",
    "manifests",
    "namespace-pss-labels.yaml",
)

#: ``labelPrefix``, staging/src/k8s.io/pod-security-admission/api/constants.go:38.
#: The manifest cites the same constants file at its lines 26-27.
PSS_LABEL_PREFIX = "pod-security.kubernetes.io/"

#: The three Pod Security admission modes, from the label constants at
#: constants.go:40-45 (``EnforceLevelLabel``, ``WarnLevelLabel``,
#: ``AuditLevelLabel`` and their ``*VersionLabel`` companions).
PSS_MODES: tuple[str, ...] = ("enforce", "warn", "audit")

#: The mode every namespace must pin (invariant 2). Named rather than repeated
#: as a literal so the universal-mode rule has exactly one definition.
ENFORCE_MODE = "enforce"

#: ``LevelPrivileged``/``LevelBaseline``/``LevelRestricted``, constants.go:22-24,
#: which are also the only values ``Level.Valid()`` accepts (helpers.go:108-116).
#: A frozenset: an immutable module constant cannot be mutated by one test and
#: observed by another, which matters under pytest-randomly and pytest-xdist.
PSS_LEVELS: frozenset[str] = frozenset({"privileged", "baseline", "restricted"})

#: ``VersionLatest``, constants.go:33 - the one non-numeric version accepted.
PSS_VERSION_LATEST = "latest"

#: ``versionRegexp``, helpers.go:118, reproduced VERBATIM. Deliberately not the
#: looser ``^v1\.\d+$``: in Python ``\d`` also matches non-ASCII decimal digits
#: and tolerates leading zeros, so that form would accept ``v1.034`` and
#: ``v1.\u0663\u0664`` - both of which ``ParseVersion`` rejects. Copying the
#: upstream character classes keeps this module exactly as strict as the plugin
#: it protects, and never more permissive.
PSS_VERSION_PATTERN = re.compile(r"^v1\.([0-9]|[1-9][0-9]*)$")

#: The six labels the admission plugin recognises under the prefix
#: (constants.go:40-45). Built from :data:`PSS_MODES` rather than typed out, so
#: the recognised set and the enumerated set cannot drift apart. Anything else
#: under the prefix is a typo the plugin would silently ignore (invariant 7).
RECOGNISED_PSS_LABELS: frozenset[str] = frozenset(
    f"{PSS_LABEL_PREFIX}{mode}{suffix}" for mode in PSS_MODES for suffix in ("", "-version")
)

#: The namespaces the manifest declares, in file order (invariant 1). Measured
#: from the artefact, not assumed: two documents, ``default`` then
#: ``kube-system``.
EXPECTED_NAMESPACES: tuple[str, ...] = ("default", "kube-system")

#: The primary built-in workload namespace, which carries the full posture.
DEFAULT_NAMESPACE = "default"

#: The control-plane namespace carrying the documented exemption.
KUBE_SYSTEM_NAMESPACE = "kube-system"

#: The workload posture V2 established for ``default`` (invariant 5). A tuple of
#: pairs rather than a dict: immutable, and directly consumable as parametrize
#: argument values with the mode names doubling as the node ids.
DEFAULT_NAMESPACE_POSTURE: tuple[tuple[str, str], ...] = (
    ("enforce", "baseline"),
    ("warn", "restricted"),
    ("audit", "restricted"),
)

#: The level ``kube-system`` must keep (invariant 6). Tightening this to
#: baseline or restricted would break control-plane components that legitimately
#: require elevated access, which is why the assertion is a positive equality.
KUBE_SYSTEM_ENFORCE_LEVEL = "privileged"

#: Cited in failure messages so a CI reader can open the artefact immediately.
MANIFEST_DISPLAY_PATH = "/".join(MANIFEST_RELATIVE_PARTS)


def _mode_label(mode: str) -> str:
    """The fully qualified level label for ``mode``, e.g. ``.../enforce``."""
    return f"{PSS_LABEL_PREFIX}{mode}"


def _mode_version_label(mode: str) -> str:
    """The fully qualified version label for ``mode``, e.g. ``.../enforce-version``."""
    return f"{PSS_LABEL_PREFIX}{mode}-version"


def _load_namespace_documents(repo_root: Path) -> tuple[Mapping[str, Any], ...]:
    """Decode the committed manifest and validate its SHAPE only.

    ABORT semantics (the Go ``t.Fatalf`` role, AAP §0.4.1.2): a manifest that is
    missing, unparsable, of the wrong document count, or missing the
    ``metadata.name`` / ``metadata.labels`` structure every assertion indexes
    into is SETUP BREAKAGE. Reporting it once and stopping is strictly more
    useful than letting eight tests each rediscover it.

    What this function deliberately does NOT check is label CONTENT. Levels,
    versions, pairing and unknown keys are all left to the tests below, which
    accumulate through ``pytest.Subtests`` and can therefore attribute every
    finding to its namespace and mode. Validating content here would abort the
    very run that was supposed to enumerate the offenders.

    ``yaml.safe_load_all`` and never ``yaml.safe_load``: the artefact is a
    multi-document stream and ``safe_load`` raises ``ComposerError`` on its
    ``---`` separators. ``safe_load*`` and never ``yaml.load``, because a test
    must not be able to construct arbitrary Python objects from a manifest.

    Args:
        repo_root: The repository root, from the session-scoped ``repo_root``
            fixture in ``python/tests/conftest.py``.

    Returns:
        The namespace documents in file order.
    """
    __tracebackhide__ = True

    manifest = repo_root.joinpath(*MANIFEST_RELATIVE_PARTS)
    assert manifest.is_file(), (
        f"F-002-RQ-003: the Pod Security namespace manifest is missing from {manifest}. "
        f"This module asserts against the committed artefact {MANIFEST_DISPLAY_PATH} and "
        f"never against a fixture copy, so there is nothing to fall back to."
    )

    try:
        stream = list(yaml.safe_load_all(manifest.read_text(encoding="utf-8")))
    except yaml.YAMLError as error:
        pytest.fail(
            f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} is not parsable as a YAML document "
            f"stream, so its Pod Security posture cannot be verified at all: {error}"
        )

    # A trailing `---` yields a None document; it carries no posture, so drop it
    # rather than counting it and reporting a misleading document count.
    documents = tuple(document for document in stream if document is not None)

    assert len(documents) == len(EXPECTED_NAMESPACES), (
        f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} must declare exactly "
        f"{len(EXPECTED_NAMESPACES)} Namespace documents "
        f"({', '.join(EXPECTED_NAMESPACES)}); found {len(documents)}. Adding or removing a "
        f"namespace here changes the cluster's admission posture and must be a reviewed edit."
    )

    for position, document in enumerate(documents, start=1):
        assert isinstance(document, Mapping), (
            f"F-002-RQ-003: document {position} of {MANIFEST_DISPLAY_PATH} decodes to "
            f"{type(document).__name__} rather than a mapping, so it is not a Namespace object."
        )
        metadata = document.get("metadata")
        assert isinstance(metadata, Mapping), (
            f"F-002-RQ-003: document {position} of {MANIFEST_DISPLAY_PATH} has no `metadata` "
            f"mapping, so the namespace it labels cannot be identified."
        )
        name = metadata.get("name")
        # Two assertions rather than one compound condition, so the message names
        # which of the two mistakes was made: a missing or non-string name, or a
        # present but empty one.
        assert isinstance(name, str), (
            f"F-002-RQ-003: document {position} of {MANIFEST_DISPLAY_PATH} has no string "
            f"`metadata.name` (found {type(name).__name__}); Pod Security labels only take "
            f"effect on a named namespace."
        )
        assert name != "", (
            f"F-002-RQ-003: document {position} of {MANIFEST_DISPLAY_PATH} has an empty "
            f"`metadata.name`; Pod Security labels only take effect on a named namespace."
        )
        labels = metadata.get("labels")
        assert isinstance(labels, Mapping), (
            f"F-002-RQ-003: namespace {name!r} in {MANIFEST_DISPLAY_PATH} has no "
            f"`metadata.labels` mapping, so it pins no Pod Security posture at all."
        )
        for key in labels:
            assert isinstance(key, str), (
                f"F-002-RQ-003: namespace {name!r} in {MANIFEST_DISPLAY_PATH} carries a "
                f"non-string label key {key!r}; Kubernetes label keys are strings."
            )

    return documents


def _labelled_namespaces(repo_root: Path) -> tuple[tuple[str, Mapping[str, Any]], ...]:
    """``(namespace_name, labels)`` for every document, in file order.

    The values stay ``Any`` rather than being narrowed to ``str`` because that is
    what the YAML genuinely yields: an unquoted ``enforce-version: 1.34`` decodes
    to a float. Pretending otherwise in the annotation would hide exactly the
    mistake invariant 4 exists to catch, so the type is honest here and the
    tests below check value types where a failure is attributable.
    """
    __tracebackhide__ = True

    return tuple(
        (str(document["metadata"]["name"]), document["metadata"]["labels"])
        for document in _load_namespace_documents(repo_root)
    )


def _labels_for(repo_root: Path, namespace: str) -> Mapping[str, Any]:
    """The label mapping of one named namespace, aborting if it is absent.

    Absence is setup breakage for the per-namespace tests: invariant 1 already
    owns the roster, so a second accumulated failure here would be noise rather
    than a new finding.
    """
    __tracebackhide__ = True

    for name, labels in _labelled_namespaces(repo_root):
        if name == namespace:
            return labels

    pytest.fail(
        f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} declares no namespace named {namespace!r}, "
        f"so the posture this test locks cannot be evaluated."
    )


def test_manifest_declares_exactly_two_namespace_documents(repo_root: Path) -> None:
    """INVARIANT 1: the manifest declares exactly ``default`` then ``kube-system``.

    ABORT semantics: this is the roster the other seven tests are written
    against, so a mismatch here is the finding, and the enumerating tests would
    only echo it.

    Order is asserted, not just membership. ``kubectl apply`` processes the
    stream in order, and reviewing a posture change is materially easier when
    the workload namespace and the exempted control-plane namespace keep a fixed
    position in the file.
    """
    documents = _load_namespace_documents(repo_root)
    names = tuple(str(document["metadata"]["name"]) for document in documents)

    assert names == EXPECTED_NAMESPACES, (
        f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} must declare exactly the namespaces "
        f"{list(EXPECTED_NAMESPACES)} in that order; found {list(names)}. A namespace added "
        f"or removed here changes which workloads Pod Security admission blocks, so it must "
        f"be a deliberate, reviewed edit - and any new namespace needs the full "
        f"enforce/warn/audit label block, per the manifest's own note at lines 50-51."
    )


@pytest.mark.parametrize("namespace", EXPECTED_NAMESPACES, ids=list(EXPECTED_NAMESPACES))
def test_namespace_document_declares_the_core_v1_namespace_envelope(
    repo_root: Path, namespace: str
) -> None:
    """INVARIANT 1 (envelope): each document is a core/v1 Namespace carrying labels.

    Parametrized rather than accumulated because the roster is a FIXED table, so
    each namespace becomes its own independently reported node with a stable id
    (``[default]`` / ``[kube-system]``) that ``parity_map.py`` can name.

    The envelope matters as much as the labels: Pod Security admission reads
    these labels off a Namespace object, so a document that decoded as anything
    else would apply no posture at all while still looking plausible in review.
    """
    documents = _load_namespace_documents(repo_root)
    document = next(
        candidate
        for candidate in documents
        if str(candidate["metadata"]["name"]) == namespace
    )

    assert document.get("apiVersion") == "v1", (
        f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} declares "
        f"apiVersion {document.get('apiVersion')!r}; Pod Security labels are read from a "
        f"core/v1 Namespace, so it must be 'v1'."
    )
    assert document.get("kind") == "Namespace", (
        f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} declares kind "
        f"{document.get('kind')!r}; it must be 'Namespace' for these labels to have any effect."
    )
    assert len(document["metadata"]["labels"]) > 0, (
        f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} carries an empty "
        f"label mapping, so it pins no Pod Security posture and silently inherits the "
        f"`privileged` default."
    )


def test_every_namespace_pins_enforce_and_its_version(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 2: every namespace pins ``enforce`` AND ``enforce-version``.

    This is the one part of the AAP §0.4.2.3 prose that IS true of every document
    in the shipped artefact, and it is the part that makes a posture blocking
    rather than merely advisory: without ``enforce`` a namespace inherits the
    ``privileged`` default and accepts breakout-prone pods.

    ACCUMULATE semantics: one subtest per (namespace, label), so a manifest that
    dropped the pair from BOTH namespaces reports all four findings in one run
    instead of stopping at the first.
    """
    for namespace, labels in _labelled_namespaces(repo_root):
        for label in (_mode_label(ENFORCE_MODE), _mode_version_label(ENFORCE_MODE)):
            with subtests.test(namespace=namespace, label=label):
                assert label in labels, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} is "
                    f"missing the required label {label!r}. Every namespace must pin "
                    f"`{ENFORCE_MODE}` and its version; without the level the namespace "
                    f"falls back to the `privileged` default, and without the version its "
                    f"policy drifts on control-plane upgrade."
                )


def test_present_modes_are_paired_with_a_version(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 3: a present mode has a valid level AND a ``-version`` companion.

    THE REAL CONTENT OF F-002-RQ-003, and the correction to the AAP §0.4.2.3
    prose. The prose claims all three modes appear on every namespace; the
    shipped artefact gives ``kube-system`` only ``enforce``, by the documented
    design recorded at the manifest's lines 69-72. Asserting the prose literally
    would fail against the repository, and simply deleting the check would
    weaken the module to a trivial pass. The pairing rule is the invariant the
    artefact genuinely embodies, and it is STRONGER than the prose: it holds for
    any future namespace regardless of which subset of modes it chooses, and it
    catches the defect that actually matters - a mode with no pinned version,
    which silently changes meaning when the control plane is upgraded, exactly
    the drift the manifest's lines 41-43 warn about.

    ACCUMULATE semantics: one subtest per (namespace, mode), so every offending
    pair is named in a single run. Modes that are absent are skipped rather than
    failed - that is what makes the ``kube-system`` exemption expressible without
    weakening anything.
    """
    for namespace, labels in _labelled_namespaces(repo_root):
        for mode in PSS_MODES:
            level_label = _mode_label(mode)
            if level_label not in labels:
                # Absent by design for kube-system's warn/audit (manifest lines
                # 69-72). Invariant 2 separately guarantees `enforce` is never
                # absent, so this branch can never excuse a missing enforce.
                continue

            with subtests.test(namespace=namespace, mode=mode):
                level = labels[level_label]
                assert level in PSS_LEVELS, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{level_label!r} to {level!r}, which is not one of the three Pod "
                    f"Security levels {sorted(PSS_LEVELS)} defined in "
                    f"pod-security-admission/api/constants.go."
                )

                version_label = _mode_version_label(mode)
                assert version_label in labels, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{level_label!r} to {level!r} but pins no {version_label!r}. An "
                    f"unpaired mode silently changes meaning when the control plane is "
                    f"upgraded; pin the version (`latest`, or the cluster minor such as "
                    f"'v1.34' in production)."
                )


def test_mode_version_values_are_versions_not_levels(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 4: a ``-version`` value is ``latest`` or ``v1.x``, never a level.

    Levels and versions are two distinct vocabularies that share a label prefix
    and differ by one suffix, which makes transposing them easy and the result
    hard to see in review. ``ParseVersion``
    (pod-security-admission/api/helpers.go:118-121) accepts only ``latest`` or
    ``v1.x``, so ``enforce-version: restricted`` is rejected there - this test
    catches it in the manifest instead.

    The level check is asserted explicitly and separately from the pattern check
    so the failure message can say which of the two mistakes was made.

    ACCUMULATE semantics: one subtest per (namespace, mode).
    """
    for namespace, labels in _labelled_namespaces(repo_root):
        for mode in PSS_MODES:
            version_label = _mode_version_label(mode)
            if version_label not in labels:
                # Pairing is invariant 3's responsibility; this test only judges
                # the values of the version labels that are present.
                continue

            with subtests.test(namespace=namespace, mode=mode):
                version = labels[version_label]

                assert isinstance(version, str), (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{version_label!r} to the {type(version).__name__} {version!r}; an "
                    f"unquoted value such as `v1.34`'s numeric form decodes to a non-string "
                    f"and is not a valid label value. Quote it."
                )
                assert version not in PSS_LEVELS, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{version_label!r} to {version!r}, which is a policy LEVEL, not a policy "
                    f"VERSION. The two vocabularies are distinct: a version is 'latest' or "
                    f"'v1.x'; a level belongs on {_mode_label(mode)!r}."
                )

                is_valid_version = (
                    version == PSS_VERSION_LATEST or PSS_VERSION_PATTERN.match(version) is not None
                )
                assert is_valid_version, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{version_label!r} to {version!r}. ParseVersion "
                    f"(pod-security-admission/api/helpers.go:118) accepts only "
                    f"{PSS_VERSION_LATEST!r} or a `v1.x` minor such as 'v1.34'."
                )


@pytest.mark.parametrize(
    ("mode", "expected_level"),
    DEFAULT_NAMESPACE_POSTURE,
    ids=[mode for mode, _ in DEFAULT_NAMESPACE_POSTURE],
)
def test_default_namespace_enforces_baseline(
    repo_root: Path, mode: str, expected_level: str
) -> None:
    """INVARIANT 5: ``default`` is enforce=baseline, warn=restricted, audit=restricted.

    These three values ARE the workload posture control V2 established, and they
    are boundaries: none may be relaxed to make anything pass. ``enforce`` sits
    at ``baseline`` rather than ``restricted`` deliberately - the manifest's
    lines 33-39 describe the zero-downtime rollout in which ``warn`` and
    ``audit`` run at the stricter ``restricted`` level first, so violations
    surface as warnings and audit annotations before anything blocks. Raising
    ``enforce`` to ``restricted`` here would reject running workloads that the
    soak has not yet cleared; lowering ``warn``/``audit`` to ``baseline`` would
    blind the soak that makes the eventual tightening safe.

    Parametrized over a FIXED table with explicit ids (``[enforce]``,
    ``[warn]``, ``[audit]``), so each of the three boundaries is an
    independently reported node and all three are checked even if one fails.
    """
    labels = _labels_for(repo_root, DEFAULT_NAMESPACE)
    label = _mode_label(mode)

    assert labels.get(label) == expected_level, (
        f"F-002-RQ-003: namespace {DEFAULT_NAMESPACE!r} in {MANIFEST_DISPLAY_PATH} must set "
        f"{label!r} to {expected_level!r}; found {labels.get(label)!r}. This is the workload "
        f"posture control V2 established (enforce=baseline with warn and audit at restricted, "
        f"per the rollout described at the manifest's lines 33-39) and it must not be weakened."
    )


def test_kube_system_keeps_privileged_exemption(repo_root: Path) -> None:
    """INVARIANT 6: ``kube-system`` keeps ``enforce: privileged``.

    Asserted POSITIVELY - equality against ``privileged`` rather than merely
    "not restricted" - so that a well-meaning future edit tightening the
    control-plane namespace fails loudly here instead of breaking control-plane
    components at runtime, which legitimately require elevated access. The
    manifest's lines 69-72 state the rule verbatim: "Do NOT tighten kube-system
    to baseline/restricted".

    This is one half of a pair. The exemption deliberately mirrors the
    ``exemptions.namespaces: ["kube-system"]`` entry of the cluster-level
    ``PodSecurityConfiguration``, and the sibling module
    ``test_generated_admission_config.py`` asserts that other half. Both must
    agree: a namespace label that tightened while the cluster-level exemption
    stayed, or the reverse, is precisely the inconsistency that makes a posture
    change unreviewable.

    Not parametrized and not accumulated: this is a single named boundary, so a
    bare assertion is the most legible form it can take.
    """
    labels = _labels_for(repo_root, KUBE_SYSTEM_NAMESPACE)
    label = _mode_label(ENFORCE_MODE)

    assert labels.get(label) == KUBE_SYSTEM_ENFORCE_LEVEL, (
        f"F-002-RQ-003: namespace {KUBE_SYSTEM_NAMESPACE!r} in {MANIFEST_DISPLAY_PATH} must "
        f"set {label!r} to {KUBE_SYSTEM_ENFORCE_LEVEL!r}; found {labels.get(label)!r}. This is "
        f"the DOCUMENTED control-plane exemption (manifest lines 69-72, mirroring "
        f"exemptions.namespaces: ['kube-system'] in the generated PodSecurityConfiguration). "
        f"Do NOT tighten kube-system to baseline or restricted: its components require "
        f"elevated access and would be rejected at the API boundary."
    )


def test_no_unknown_pod_security_labels(repo_root: Path, subtests: pytest.Subtests) -> None:
    """INVARIANT 7: every ``pod-security.kubernetes.io/`` key is one of the six recognised.

    This is the quietest failure mode in the whole manifest. The admission plugin
    reads six specific keys (constants.go:40-45) and IGNORES anything else under
    the prefix, so a single transposed character - ``enfroce`` for ``enforce`` -
    leaves the namespace running at the ``privileged`` default while the manifest,
    and every review of it, still looks correct. Nothing else in this module would
    catch it: the pairing and level checks only inspect keys they already know.

    Only keys under the Pod Security prefix are judged. Unrelated labels are
    legitimate on a Namespace and are none of this module's business.

    ACCUMULATE semantics: one subtest per (namespace, label), and the keys are
    sorted so the report order is deterministic under pytest-randomly and
    pytest-xdist rather than following the mapping's insertion order.
    """
    for namespace, labels in _labelled_namespaces(repo_root):
        for key in sorted(labels):
            if not key.startswith(PSS_LABEL_PREFIX):
                continue

            with subtests.test(namespace=namespace, label=key):
                assert key in RECOGNISED_PSS_LABELS, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} carries "
                    f"the unrecognised Pod Security label {key!r}. Pod Security admission "
                    f"reads only {sorted(RECOGNISED_PSS_LABELS)} and silently ignores every "
                    f"other key under {PSS_LABEL_PREFIX!r}, so a typo here leaves the "
                    f"namespace at the `privileged` default while appearing to be configured."
                )

