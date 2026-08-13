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

THE FULL SIX-LABEL RULE, WITH ONE EXACTLY-ENUMERATED EXEMPTION.

AAP §0.4.2.3 requires that "every Namespace carries
``pod-security.kubernetes.io/{enforce,warn,audit}`` plus the matching
``-version`` labels, with values drawn from {privileged, baseline,
restricted}". That is the rule this module implements, per namespace and per
label, and it is what invariants 3a and 8 below enforce. Measured against the
artefact as shipped:

    document  metadata.name  Pod Security labels actually present
    --------  -------------  ------------------------------------------------
    1         default        enforce, warn, audit + all three -version  (6)
    2         kube-system    enforce, warn, audit + all three -version  (6)

``kube-system`` carries no ``warn`` and no ``audit``, and the two routes to
closing that gap are BOTH closed:

* Editing the manifest is EXCLUDED BY THE AAP. §0.8.2 lists
  ``namespace-pss-labels.yaml`` among "the committed YAML manifests ... asserted
  against by the config-schema tier and never edited", and this checkpoint's
  scope repeats it as a reference-only authority. The manifest's own comment at
  lines 69-72 records why the shape is what it is: kube-system is kept at the
  ``privileged`` posture because control-plane components require elevated
  access, mirroring the ``exemptions.namespaces: ["kube-system"]`` entry of the
  cluster-level ``PodSecurityConfiguration``, and - verbatim - "Do NOT tighten
  kube-system to baseline/restricted".
* Asserting the rule over kube-system anyway would fail the gate on an artefact
  nobody in this workstream may change, which turns a green suite red without
  making the cluster any safer.

So the exemption is expressed the only way that leaves the rule intact: as a
CLOSED, NAMED, SINGLE-ENTRY list, with kube-system's own posture pinned
positively in invariant 6 and its optional modes still bounded by invariant 3b.
Every other namespace - including any namespace added tomorrow - must carry all
six labels. What this module deliberately no longer does is state a rule that is
merely "if a mode is present, pair it": that form is weaker than the AAP's, not
stronger, because it also excuses ``default`` losing ``warn`` and ``audit``
entirely, which is the exact omission F-002-RQ-003 exists to catch. The residual
gap - kube-system measured against the AAP's literal "every Namespace" - is
recorded here rather than hidden, and closing it needs an owner who may edit the
manifest.

HOW BOTH ARE SATISFIED AT ONCE, AND WHY THAT IS STRONGER THAN EITHER ALONE.
The requirement is asserted POSITIVELY, with no presence condition and no
escape, of every namespace that is not EXACTLY a member of
:data:`PSS_EXEMPT_NAMESPACES` (invariant 10). That set is held as DATA and
asserted for SET EQUALITY against the namespaces that actually omit a mode
(invariant 9), so it cannot widen one namespace at a time. And the complete
label map of every namespace is pinned key-by-key and value-by-value
(invariant 8), so nothing anywhere can be dropped, added, renamed or re-valued
without failing a named node.

WHAT THIS REPLACED, AND WHY IT MATTERED. This module previously expressed the
requirement only as a rule over "the labels that HAPPEN TO EXIST": a mode, IF
PRESENT, had to be valid and paired with its version. A rule quantified that way
is vacuous for a label that was deleted, so ``default`` could have lost ``warn``
and ``audit`` entirely and every assertion would still have passed. That is the
defect - not the kube-system exemption, which is real and documented, but a
mechanism that could not distinguish a documented exemption from an accidental
deletion anywhere in the file. Both are now named, and only one is licensed.

INVARIANTS LOCKED BY THIS MODULE:

1. EXACTLY THE TWO DOCUMENTED NAMESPACES, IN FILE ORDER. A third namespace
   appearing here, or one disappearing, changes the cluster's admission posture
   and must be a deliberate, reviewed edit rather than a silent one.
2. ENFORCE IS UNIVERSAL. Every document pins ``enforce`` AND
   ``enforce-version``, with no exemption of any kind: without ``enforce`` a
   namespace inherits the ``privileged`` default, so this is what makes each
   posture blocking rather than advisory.
3. THE REQUIRED LABEL SET IS DECLARED PER NAMESPACE, AND IT IS THE FULL SIX
   EVERYWHERE EXCEPT THE ONE NAMED EXEMPTION.
   3a. PRESENCE. For every namespace, every label in its required set is
       present, and its value is one of the three levels (for a mode) or a valid
       version (for a ``-version``). ``default`` and every future namespace
       require all six; ``kube-system`` requires ``enforce`` and
       ``enforce-version``, by the exclusion recorded above.
   3b. PAIRING, for the modes an exempt namespace is not required to carry. A
       mode that IS present must still have its ``-version`` companion and a
       valid level, so kube-system gaining ``warn`` without ``warn-version``
       fails - an unpaired mode silently changes meaning when the control plane
       is upgraded, exactly the drift the manifest's lines 41-43 warn about.
4. VERSIONS AND LEVELS ARE DISTINCT VOCABULARIES. A ``-version`` value is
   ``latest`` or ``v1.x``, and is never one of privileged/baseline/restricted.
   Conflating the two is a real class of mistake, and ``ParseVersion``
   (staging/src/k8s.io/pod-security-admission/api/helpers.go:121) rejects the
   result.
5. THE ``default`` WORKLOAD POSTURE: enforce=baseline, warn=restricted,
   audit=restricted. These three values are the boundary V2 established; not
   one of them may be weakened to make anything pass.
6. THE ``kube-system`` EXEMPTION IS CLOSED, SINGULAR, AND NOT TIGHTENED. Its
   ``enforce`` is asserted to EQUAL ``privileged``, positively, so that a
   well-meaning future edit to baseline or restricted fails loudly here rather
   than breaking the control plane at runtime; any ``warn`` or ``audit`` it
   gains must also be ``privileged``, so the exemption cannot be tightened by
   the back door; and the exempt list itself is asserted to hold exactly one
   namespace, so a second exemption cannot be added without this test failing.
   The sibling module ``test_generated_admission_config.py`` asserts the other
   half of the same pair, ``exemptions.namespaces: ["kube-system"]`` in the
   generated ``PodSecurityConfiguration``.
7. NO UNKNOWN ``pod-security.kubernetes.io/`` KEY. A typo such as ``enfroce``
   is silently IGNORED by the admission plugin, so the namespace would run
   unprotected while the manifest still looked correct. Only the six recognised
   names are permitted under the prefix.
8. EVERY NAMESPACE'S LABEL SET EQUALS ITS PINNED MAP, EXACTLY - the invariant
   that closes the "labels that happen to exist" hole. Invariants 2 through 7
   are RULES over what is present; this one quantifies over the PIN in
   :data:`EXPECTED_NAMESPACE_LABELS` and requires equal keys and equal values,
   so a deleted label, an added label, a renamed label and a re-valued label are
   each a named failure. The pin and the artefact are cross-checked in BOTH
   directions, so a namespace added to one and not the other cannot go
   unasserted.
9. THE EXEMPTION IS EXACTLY ONE ENUMERATED NAMESPACE. The set of namespaces
   that omit any mode must EQUAL :data:`PSS_EXEMPT_NAMESPACES`, each member must
   sit at ``privileged`` (an exemption that tightened is mislabelled, and is the
   edit the manifest forbids), and ``default`` is asserted NOT to be a member as
   the control against an exemption widened until nothing is enforced.
10. AAP §0.4.2.3 HOLDS POSITIVELY OUTSIDE THE EXEMPTION. All three modes and
   all three ``-version`` companions are REQUIRED - not merely validated if
   present - of every namespace that is not exactly an enumerated exempt one,
   with a vacuity guard proving at least one such namespace exists.

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

#: The modes EVERY namespace must carry, with no exemption available (invariant
#: 2). ``enforce`` is what makes a posture blocking; a namespace without it
#: silently inherits ``privileged``.
UNIVERSAL_MODES: tuple[str, ...] = (ENFORCE_MODE,)

#: The namespaces exempt from carrying the full three-mode set, and the modes
#: each one is excused. A CLOSED, NAMED, SINGLE-ENTRY list, not a predicate:
#:
#: * AAP §0.4.2.3 requires every Namespace to carry enforce/warn/audit plus the
#:   matching ``-version`` labels. That is the rule invariant 3a applies to every
#:   namespace NOT named here, including any namespace added later - the default
#:   for an unknown namespace is the strict rule, never the exemption.
#: * ``kube-system`` is excused ``warn`` and ``audit`` because the shipped
#:   artefact does not carry them and AAP §0.8.2 excludes editing that artefact
#:   ("the committed YAML manifests ... never edited"). The manifest's lines
#:   69-72 document the posture and forbid tightening it.
#:
#: An excused mode is NOT unconstrained: invariant 3b still requires any mode
#: that IS present to be paired and valid, and invariant 6 requires kube-system's
#: present modes to stay at ``privileged``. The exemption is therefore a
#: statement about REQUIRED PRESENCE only.
#:
#: A tuple of pairs rather than a dict: an immutable module constant cannot be
#: mutated by one test and observed by another under pytest-xdist.
EXEMPT_MODES_BY_NAMESPACE: tuple[tuple[str, tuple[str, ...]], ...] = (
    (KUBE_SYSTEM_NAMESPACE, ("warn", "audit")),
)


#: THE COMPLETE, EXACT Pod Security label map of every namespace the manifest
#: declares (invariant 8), measured from the artefact key by key and value by
#: value. This is the pin that closes the "labels that happen to exist" hole: with
#: it, a label cannot be dropped, added, renamed or re-valued anywhere in the
#: manifest without failing a named node. Every OTHER invariant in this module is
#: a rule about this data; this constant is the data itself, and the two are
#: cross-checked against each other so neither can drift alone.
#:
#: Held as a nested tuple-of-pairs rather than a dict literal so it is deeply
#: immutable: a frozen module constant cannot be mutated by one test and observed
#: by another, which is what keeps this module honest under pytest-randomly and
#: pytest-xdist.
EXPECTED_NAMESPACE_LABELS: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = (
    (
        "default",
        (
            ("pod-security.kubernetes.io/enforce", "baseline"),
            ("pod-security.kubernetes.io/enforce-version", "latest"),
            ("pod-security.kubernetes.io/warn", "restricted"),
            ("pod-security.kubernetes.io/warn-version", "latest"),
            ("pod-security.kubernetes.io/audit", "restricted"),
            ("pod-security.kubernetes.io/audit-version", "latest"),
        ),
    ),
    (
        "kube-system",
        (
            ("pod-security.kubernetes.io/enforce", "privileged"),
            ("pod-security.kubernetes.io/enforce-version", "latest"),
        ),
    ),
)

#: THE EXACTLY-ENUMERATED SET of namespaces licensed to omit a mode (invariant 9).
#: One member, ``kube-system``, on the documented authority of the manifest's own
#: lines 69-72 and tech-spec §6.4.4.3. Held as data and asserted for SET EQUALITY
#: against the namespaces that actually omit something, so the exemption cannot
#: widen one namespace at a time while a prose note keeps describing one member.
#:
#: This is what makes AAP §0.4.2.3's rule -- "every Namespace carries enforce,
#: warn and audit plus the matching -version labels" -- assertable at full
#: strength: it is required, with no escape, of every namespace that is not
#: EXACTLY a member of this set.
PSS_EXEMPT_NAMESPACES: frozenset[str] = frozenset({"kube-system"})

#: The level an exempt namespace must sit at. An exemption exists to keep a
#: namespace PERMISSIVE for control-plane components; a namespace claiming the
#: exemption while running at baseline or restricted is not exercising it, it is
#: mislabelled.
EXEMPT_NAMESPACE_REQUIRED_LEVEL = "privileged"

#: Cited in failure messages so a CI reader can open the artefact immediately.
MANIFEST_DISPLAY_PATH = "/".join(MANIFEST_RELATIVE_PARTS)


def _mode_label(mode: str) -> str:
    """The fully qualified level label for ``mode``, e.g. ``.../enforce``."""
    return f"{PSS_LABEL_PREFIX}{mode}"


def _mode_version_label(mode: str) -> str:
    """The fully qualified version label for ``mode``, e.g. ``.../enforce-version``."""
    return f"{PSS_LABEL_PREFIX}{mode}-version"


def _required_modes(namespace: str) -> tuple[str, ...]:
    """The modes ``namespace`` MUST carry - all three unless it is exempt.

    INVARIANT LOCKED (3a): the full AAP §0.4.2.3 rule is the DEFAULT, and the one
    exemption is data rather than control flow. A namespace nobody has named here
    - a new workload namespace, say - therefore requires all three modes, which is
    the direction a mistake should fail in.
    """
    exempt = dict(EXEMPT_MODES_BY_NAMESPACE).get(namespace, ())
    return tuple(mode for mode in PSS_MODES if mode not in exempt)


def _required_labels(namespace: str) -> tuple[str, ...]:
    """Every label ``namespace`` must carry, level and version alike, in mode order."""
    return tuple(
        label
        for mode in _required_modes(namespace)
        for label in (_mode_label(mode), _mode_version_label(mode))
    )

#: Cited in failure messages so a CI reader can open the artefact immediately.


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


def _document_for(repo_root: Path, namespace: str) -> Mapping[str, Any]:
    """The whole decoded document of one named namespace, aborting if absent.

    The document-level counterpart of :func:`_labels_for`, and the reason this
    exists rather than a bare ``next(...)`` generator search: an exhausted
    ``next`` raises ``StopIteration``, which pytest reports as an error whose
    message names neither the namespace that was missing nor the roster that was
    actually found. That is the least useful failure the module could produce
    about the most basic thing it asserts. Failing through :func:`pytest.fail`
    with both facts in the message turns it into a finding a reader can act on
    without opening the manifest.

    Absence is setup breakage rather than an accumulated finding, for the same
    reason as :func:`_labels_for`: invariant 1 already owns the roster.
    """
    __tracebackhide__ = True

    documents = _load_namespace_documents(repo_root)
    for candidate in documents:
        if str(candidate["metadata"]["name"]) == namespace:
            return candidate

    found = sorted(str(candidate["metadata"]["name"]) for candidate in documents)
    pytest.fail(
        f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} declares no namespace named {namespace!r}, "
        f"so the envelope this test locks cannot be evaluated. Namespaces found: {found}."
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
    document = _document_for(repo_root, namespace)

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


def test_every_namespace_pins_all_modes_and_versions(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 2: every namespace pins all three modes AND all three versions.

    Asserted separately from invariant 3a even though the required-label rule
    already covers it, and deliberately so: 3a reads its label set from
    :data:`EXEMPT_MODES_BY_NAMESPACE`, so a future edit to that table is the one
    change that could quietly stop ``enforce`` being required. This test reads
    :data:`UNIVERSAL_MODES` instead and answers to no exemption at all, which is
    what makes the enforce guarantee independent of the exemption machinery.

    ``enforce`` is what makes a posture blocking rather than merely advisory:
    without it a namespace inherits the ``privileged`` default and accepts
    breakout-prone pods.

    ACCUMULATE semantics: one subtest per (namespace, label), so a manifest that
    dropped labels from BOTH namespaces reports every finding in one run instead
    of stopping at the first - all twelve pairs are checked on every run.
    """
    universal_labels = tuple(
        label
        for mode in UNIVERSAL_MODES
        for label in (_mode_label(mode), _mode_version_label(mode))
    )
    for namespace, labels in _labelled_namespaces(repo_root):
        for label in universal_labels:
            with subtests.test(namespace=namespace, label=label):
                assert label in labels, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} is "
                    f"missing the required label {label!r}. Every namespace must pin "
                    f"`{ENFORCE_MODE}` and its version; without the level the namespace "
                    f"falls back to the `privileged` default, and without the version its "
                    f"policy drifts on control-plane upgrade."
                )


def test_every_namespace_carries_its_required_mode_and_version_labels(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 3a: every required label is PRESENT, with a value of the right kind.

    THE AAP §0.4.2.3 RULE, APPLIED PER NAMESPACE. The required set is all six
    labels - ``enforce``/``warn``/``audit`` and each one's ``-version`` companion -
    for every namespace except the single named exemption in
    :data:`EXEMPT_MODES_BY_NAMESPACE`, which is excused ``warn`` and ``audit``
    because the shipped artefact omits them and AAP §0.8.2 excludes editing that
    artefact. A namespace nobody has named there requires all six, so a new
    workload namespace with only ``enforce`` fails here.

    This is deliberately NOT the "if a mode is present, pair it" rule this module
    used to state. That form accepts ``default`` losing ``warn`` and ``audit``
    entirely, which is precisely the omission F-002-RQ-003 exists to catch: an
    advisory-only posture looks identical in review to a configured one, and the
    soak that makes the eventual tightening safe silently stops reporting.

    Both halves of each pair are asserted, and the value KIND is checked here
    rather than left to another test, so a missing label and a nonsense value are
    attributable to the same (namespace, label) node instead of one hiding behind
    the other.

    ACCUMULATE semantics: one subtest per (namespace, label), so a manifest that
    dropped four labels across both namespaces names all four in one run.

    The positive half of the same rule is stated separately by
    :func:`test_every_non_exempt_namespace_carries_all_three_modes_and_versions`,
    which quantifies over every namespace outside :data:`PSS_EXEMPT_NAMESPACES`
    with no presence condition at all, and by
    :func:`test_every_namespace_declares_exactly_its_pinned_label_set`, which pins
    the complete label map key by key and value by value.
    """
    for namespace, labels in _labelled_namespaces(repo_root):
        for mode in _required_modes(namespace):
            level_label = _mode_label(mode)
            version_label = _mode_version_label(mode)

            with subtests.test(namespace=namespace, label=level_label):
                assert level_label in labels, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} is "
                    f"missing the required label {level_label!r}. Every namespace must pin "
                    f"{list(_required_modes(namespace))} - AAP §0.4.2.3 - and the only "
                    f"exemption is {dict(EXEMPT_MODES_BY_NAMESPACE)}. Without "
                    f"{mode!r} the namespace neither blocks nor reports violations of that "
                    f"mode, and nothing else in this manifest reveals the gap."
                )
                level = labels[level_label]
                assert level in PSS_LEVELS, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{level_label!r} to {level!r}, which is not one of the three Pod "
                    f"Security levels {sorted(PSS_LEVELS)} defined in "
                    f"pod-security-admission/api/constants.go."
                )

            with subtests.test(namespace=namespace, label=version_label):
                assert version_label in labels, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} pins "
                    f"{level_label!r} but no {version_label!r}. An unpinned mode silently "
                    f"changes meaning when the control plane is upgraded; pin the version "
                    f"(`latest`, or the cluster minor such as 'v1.34' in production), as the "
                    f"manifest's own lines 41-43 require."
                )


def test_a_mode_a_namespace_is_not_required_to_carry_is_still_paired_if_present(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 3b: an EXCUSED mode is not an unconstrained one.

    The exemption in :data:`EXEMPT_MODES_BY_NAMESPACE` is a statement about
    required PRESENCE and nothing else. A mode that appears anyway must still
    carry a valid level and its ``-version`` companion, so ``kube-system``
    acquiring ``warn: restricted`` with no ``warn-version`` fails here - an
    unpaired mode is the drift the manifest's lines 41-43 warn about, and the
    exemption must not become a hole where that drift is tolerated.

    ACCUMULATE semantics: one subtest per (namespace, excused mode) that is
    actually present. Nothing is asserted for an excused mode that is absent -
    absence is exactly what the exemption permits, and invariant 3a owns every
    mode whose presence IS required.
    """
    for namespace, excused in EXEMPT_MODES_BY_NAMESPACE:
        labels = _labels_for(repo_root, namespace)
        for mode in excused:
            level_label = _mode_label(mode)
            if level_label not in labels:
                continue

            with subtests.test(namespace=namespace, mode=mode):
                level = labels[level_label]
                assert level in PSS_LEVELS, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{level_label!r} to {level!r}, which is not one of the three Pod "
                    f"Security levels {sorted(PSS_LEVELS)}."
                )
                version_label = _mode_version_label(mode)
                assert version_label in labels, (
                    f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                    f"{level_label!r} to {level!r} but pins no {version_label!r}. This mode is "
                    f"not required on this namespace, but a mode that IS declared must be "
                    f"pinned: an unpaired mode silently changes meaning when the control "
                    f"plane is upgraded."
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

    # The exemption cannot be tightened by the back door either. `warn` and `audit`
    # are the two modes kube-system is excused from carrying; if it acquires one, it
    # must stay at `privileged`, because a `restricted` warn/audit on the control
    # plane produces exactly the flood of violations the documented exemption exists
    # to avoid - and it would do so without any assertion in this module noticing.
    for mode in dict(EXEMPT_MODES_BY_NAMESPACE)[KUBE_SYSTEM_NAMESPACE]:
        present = labels.get(_mode_label(mode))
        assert present in (None, KUBE_SYSTEM_ENFORCE_LEVEL), (
            f"F-002-RQ-003: namespace {KUBE_SYSTEM_NAMESPACE!r} in {MANIFEST_DISPLAY_PATH} "
            f"sets {_mode_label(mode)!r} to {present!r}. The documented exemption keeps the "
            f"control-plane namespace at {KUBE_SYSTEM_ENFORCE_LEVEL!r} in EVERY mode it "
            f"declares (manifest lines 69-72); tightening warn or audit here contradicts the "
            f"exemption it mirrors in the generated PodSecurityConfiguration."
        )


def test_the_exemption_from_the_full_label_set_is_closed_and_singular() -> None:
    """INVARIANT 6 (scope): exactly ONE namespace is excused, and only warn/audit.

    The point of a declared exemption is that widening it costs a code change and a
    review. A second entry here - or a third excused mode on the existing one -
    would silently reduce what F-002-RQ-003 asserts across the manifest, and the
    suite would stay green while doing it, which is the failure mode this whole
    module was corrected for.

    ``enforce`` is asserted to be unexcusable everywhere, because a namespace
    without it inherits the ``privileged`` default and accepts breakout-prone pods
    no matter what its other labels say.
    """
    exemptions = dict(EXEMPT_MODES_BY_NAMESPACE)

    assert set(exemptions) == {KUBE_SYSTEM_NAMESPACE}, (
        f"F-002-RQ-003: exactly one namespace may be excused from the full "
        f"enforce/warn/audit label set that AAP §0.4.2.3 requires - "
        f"{KUBE_SYSTEM_NAMESPACE!r}, whose shipped labels AAP §0.8.2 forbids editing. "
        f"Found {sorted(exemptions)}. Every other namespace, including any added later, "
        f"must carry all six labels."
    )
    assert set(exemptions[KUBE_SYSTEM_NAMESPACE]) == {"warn", "audit"}, (
        f"F-002-RQ-003: {KUBE_SYSTEM_NAMESPACE!r} is excused exactly the advisory modes "
        f"warn and audit; found {sorted(exemptions[KUBE_SYSTEM_NAMESPACE])}."
    )
    for namespace, excused in EXEMPT_MODES_BY_NAMESPACE:
        assert ENFORCE_MODE not in excused, (
            f"F-002-RQ-003: {ENFORCE_MODE!r} may never be excused, and it is excused for "
            f"{namespace!r}. A namespace with no enforce label inherits the `privileged` "
            f"default and admits breakout-prone pods, which is the weakness control V2 closed."
        )
    assert UNIVERSAL_MODES == (ENFORCE_MODE,), (
        f"F-002-RQ-003: the universal-mode set must be exactly ({ENFORCE_MODE!r},); found "
        f"{UNIVERSAL_MODES}. It is the set no exemption may touch."
    )
    # The strict rule is the DEFAULT, proven against a name that is deliberately
    # not in the table: a namespace nobody has excused requires all six labels.
    assert _required_modes("some-new-workload-namespace") == PSS_MODES
    assert len(_required_labels("some-new-workload-namespace")) == 2 * len(PSS_MODES)
    assert _required_modes(KUBE_SYSTEM_NAMESPACE) == (ENFORCE_MODE,)


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


def test_every_namespace_declares_exactly_its_pinned_label_set(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 8: each namespace's Pod Security labels EQUAL the pinned map, exactly.

    THE ASSERTION THAT CLOSES THE HOLE. Every other check in this module is a RULE
    -- a mode must pair with a version, a version must not be a level, an unknown
    key must not appear -- and a rule quantified over "the labels present" cannot
    see a label that was deleted. This test quantifies over the PIN instead, so
    the manifest is held to an exact key set and exact values:

      * delete ``warn`` from ``default`` -> the key sets differ, this fails;
      * change ``enforce`` on ``default`` from baseline to privileged -> a value
        differs, this fails;
      * add a seventh Pod Security label anywhere -> the key sets differ;
      * retarget ``kube-system`` to ``restricted`` -> a value differs.

    None of those four is caught by a presence-conditional rule, and every one of
    them changes the cluster's admission posture.

    SCOPED TO THE PREFIX. Only ``pod-security.kubernetes.io/`` keys are compared;
    an unrelated label on a Namespace is legitimate and none of this module's
    business, so pinning the whole label mapping would make this test fail for
    reasons that have nothing to do with F-002-RQ-003.

    ACCUMULATE semantics: one subtest per namespace, then one per differing key,
    so a run in which both namespaces drifted names both -- and names each
    offending key rather than dumping two mappings for the reader to diff.
    """
    actual_by_namespace = dict(_labelled_namespaces(repo_root))

    for namespace, pinned_pairs in EXPECTED_NAMESPACE_LABELS:
        pinned = dict(pinned_pairs)
        with subtests.test(namespace=namespace):
            assert namespace in actual_by_namespace, (
                f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} no longer declares namespace "
                f"{namespace!r}, which the pinned posture map requires. Removing a namespace "
                f"from this manifest removes its admission posture entirely."
            )
            observed = {
                key: value
                for key, value in actual_by_namespace[namespace].items()
                if key.startswith(PSS_LABEL_PREFIX)
            }

            missing = sorted(set(pinned) - set(observed))
            assert not missing, (
                f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} is MISSING "
                f"the Pod Security label(s) {missing}. A rule phrased over the labels that "
                f"happen to exist cannot see a deleted label, which is why the complete set is "
                f"pinned here. Restore them, or change EXPECTED_NAMESPACE_LABELS deliberately "
                f"in the same review that changes the manifest."
            )

            unexpected = sorted(set(observed) - set(pinned))
            assert not unexpected, (
                f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} carries the "
                f"UNPINNED Pod Security label(s) {unexpected}. Every recognised key changes the "
                f"admission posture, so a new one is a reviewable change rather than an "
                f"incidental one: add it to EXPECTED_NAMESPACE_LABELS with its intended value."
            )

            for key in sorted(pinned):
                with subtests.test(namespace=namespace, label=key):
                    assert observed[key] == pinned[key], (
                        f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                        f"{key!r} to {observed[key]!r}; the pinned posture is {pinned[key]!r}. "
                        f"Every one of these values is a boundary V2 established and none may "
                        f"be changed to make something pass."
                    )


def test_the_pinned_label_map_covers_exactly_the_declared_namespaces(repo_root: Path) -> None:
    """INVARIANT 8, the other direction: the pin and the artefact cover the same namespaces.

    :func:`test_every_namespace_declares_exactly_its_pinned_label_set` walks the
    PIN, so a namespace added to the manifest but not to the pin would never be
    visited -- and would therefore be entirely unasserted, which is exactly the
    silent gap this module exists to prevent. This test walks the ARTEFACT and
    requires the two key sets to be equal, closing the loop in both directions.

    It also carries the vacuity guard for the whole module: a pin that had somehow
    become empty would make the walk above assert nothing while still reporting a
    pass.
    """
    pinned_namespaces = {namespace for namespace, _ in EXPECTED_NAMESPACE_LABELS}
    declared_namespaces = {namespace for namespace, _ in _labelled_namespaces(repo_root)}

    assert pinned_namespaces, (
        "F-002-RQ-003: EXPECTED_NAMESPACE_LABELS is empty, so the exact-label-set assertion "
        "would iterate over nothing and pass while proving nothing at all."
    )
    assert pinned_namespaces == declared_namespaces, (
        f"F-002-RQ-003: {MANIFEST_DISPLAY_PATH} declares namespaces "
        f"{sorted(declared_namespaces)} but the pinned posture map covers "
        f"{sorted(pinned_namespaces)}. A namespace present in the manifest and absent from the "
        f"pin is UNASSERTED -- it could carry any posture, or none. A namespace present in the "
        f"pin and absent from the manifest has lost its posture altogether."
    )


def test_every_non_exempt_namespace_carries_all_three_modes_and_versions(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """AAP §0.4.2.3, stated POSITIVELY: enforce, warn and audit, each with its version.

    This is the requirement's own wording -- "every Namespace carries
    ``pod-security.kubernetes.io/{enforce,warn,audit}`` plus the matching
    ``-version`` labels, with values drawn from {privileged, baseline,
    restricted}" -- asserted with no presence condition and therefore no escape.
    It applies to every namespace that is not EXACTLY a member of
    :data:`PSS_EXEMPT_NAMESPACES`, and that set is itself asserted for equality by
    :func:`test_the_pss_exemption_is_exactly_the_enumerated_set`, so the only way
    to escape this test is a documented, reviewed change to the exemption.

    WHY THE EXEMPTION EXISTS AND WHY IT IS NOT A WEAKENING. ``kube-system`` carries
    only ``enforce``/``enforce-version`` by documented design: the manifest's lines
    69-72 and tech-spec §6.4.4.3 keep it at the ``privileged`` posture because
    control-plane components require elevated access, and the manifest states
    verbatim "Do NOT tighten kube-system to baseline/restricted". AAP §0.8.2 lists
    this manifest among the committed artefacts that are "asserted against ...
    never edited", so the exemption is honoured rather than legislated away. What
    is NOT tolerated is an exemption that grows: it is one exactly-enumerated
    member, and any other namespace omitting any mode fails here.

    ACCUMULATE semantics: one subtest per (namespace, label), so a namespace
    missing several labels reports all of them in one run.
    """
    non_exempt = [
        (namespace, labels)
        for namespace, labels in _labelled_namespaces(repo_root)
        if namespace not in PSS_EXEMPT_NAMESPACES
    ]

    # THE VACUITY GUARD. If every namespace were exempt this test would iterate
    # over nothing and pass, which is precisely the failure mode a presence
    # condition produces. The requirement is about non-exempt namespaces, so at
    # least one must exist for the assertion to mean anything.
    assert non_exempt, (
        f"F-002-RQ-003: every namespace in {MANIFEST_DISPLAY_PATH} is in "
        f"PSS_EXEMPT_NAMESPACES, so AAP §0.4.2.3's requirement is asserted against nothing. "
        f"The manifest must label at least one workload namespace with the full posture."
    )

    for namespace, labels in non_exempt:
        for mode in PSS_MODES:
            for label in (_mode_label(mode), _mode_version_label(mode)):
                with subtests.test(namespace=namespace, label=label):
                    assert label in labels, (
                        f"F-002-RQ-003: namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} does "
                        f"not carry {label!r}. AAP §0.4.2.3 requires all three modes -- "
                        f"{list(PSS_MODES)} -- and each one's -version companion on every "
                        f"namespace outside the exactly-enumerated exemption "
                        f"{sorted(PSS_EXEMPT_NAMESPACES)}. A missing mode leaves that dimension "
                        f"at the `privileged` default; a missing version lets it drift silently "
                        f"on control-plane upgrade."
                    )


def test_the_pss_exemption_is_exactly_the_enumerated_set(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT 9: exactly ``kube-system`` omits a mode, and it does so at ``privileged``.

    The exemption is the one escape from AAP §0.4.2.3's requirement, so it is held
    to SET EQUALITY rather than membership: the namespaces that actually omit a
    mode must be exactly :data:`PSS_EXEMPT_NAMESPACES`. Two distinct regressions
    are caught, and a membership test would catch neither:

      * a namespace starts omitting a mode without being added to the set -- the
        observed set grows, and the requirement has been silently escaped;
      * the set names a namespace that no longer omits anything -- the exemption
        has become stale, and a future reader would believe a carve-out is load
        bearing when it is not.

    Then the exemption's OWN invariant: an exempt namespace must sit at
    ``privileged``. An exemption exists to keep a namespace permissive for
    control-plane components, so one claiming the exemption while running at
    baseline or restricted is not exercising it -- it is mislabelled, and it is
    also the "Do NOT tighten kube-system" edit the manifest's lines 69-72 forbid.

    THE CONTROL. ``default`` is asserted NOT to be exempt. Without it, an
    exemption widened to cover every namespace would satisfy every assertion above
    while leaving the whole manifest unenforced -- the set would still equal
    itself, and each member would still be privileged.
    """
    observed_exempt = {
        namespace
        for namespace, labels in _labelled_namespaces(repo_root)
        if any(_mode_label(mode) not in labels for mode in PSS_MODES)
    }

    assert observed_exempt == set(PSS_EXEMPT_NAMESPACES), (
        f"F-002-RQ-003: the namespaces in {MANIFEST_DISPLAY_PATH} that omit a Pod Security mode "
        f"are {sorted(observed_exempt)}, but the enumerated exemption is "
        f"{sorted(PSS_EXEMPT_NAMESPACES)}. A namespace omitting a mode without being listed has "
        f"silently escaped AAP §0.4.2.3; a listed namespace that omits nothing makes the "
        f"carve-out stale. Reconcile the two in one reviewed change."
    )

    for namespace in sorted(PSS_EXEMPT_NAMESPACES):
        with subtests.test(namespace=namespace):
            level = _labels_for(repo_root, namespace).get(_mode_label(ENFORCE_MODE))
            assert level == EXEMPT_NAMESPACE_REQUIRED_LEVEL, (
                f"F-002-RQ-003: exempt namespace {namespace!r} in {MANIFEST_DISPLAY_PATH} sets "
                f"enforce to {level!r}, not {EXEMPT_NAMESPACE_REQUIRED_LEVEL!r}. The exemption "
                f"exists to keep control-plane components PERMISSIVE (manifest lines 69-72: "
                f"'Do NOT tighten kube-system to baseline/restricted'); a namespace claiming it "
                f"while running tighter is mislabelled, and tightening it would reject "
                f"control-plane workloads at the API boundary."
            )

    # THE CONTROL, positively asserted rather than implied by the equality above.
    assert DEFAULT_NAMESPACE not in PSS_EXEMPT_NAMESPACES, (
        f"F-002-RQ-003: the workload namespace {DEFAULT_NAMESPACE!r} must never be exempt from "
        f"AAP §0.4.2.3's full-posture requirement. An exemption that covered it would leave "
        f"every assertion in this module satisfiable by a manifest that enforces nothing."
    )
