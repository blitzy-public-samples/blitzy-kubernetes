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

"""Contract tests for ``tests.helpers.manifest``: teardown ownership and decoder equivalence.

AAP §0.5.1 (the ``python/tests/helpers/manifest.py`` row: the ``ManifestTestCase``
port) / §0.4.4.1 (the shell tier's ``KUBE_HOME`` layout) / §0.7.2 (structural
isolation and parallel safety) / §0.10.1 ("maintain test isolation using per-test
resources") / tech-spec §6.6.3.4 (the documentation convention).

INVARIANTS LOCKED BY THIS MODULE:

1. TEARDOWN REMOVES ONLY WHAT THIS HARNESS PREPARED. A directory carrying no
   ownership marker is refused; a symlink is refused rather than followed; a
   caller-supplied directory that already existed keeps its other contents.
   Without this, a ``kube_home=`` argument is a recursive delete of whatever the
   caller happened to name -- or, through a symlink, of somewhere else entirely.
2. THE WHOLE EMITTED POD IS VALIDATED, not just the fields the typed views model.
   Go decodes the complete artefact through the v1.Pod scheme, so a wrong JSON
   type anywhere in it fails there; a port that checked only ``apiVersion``,
   ``kind`` and the container command would pass documents the oracle rejects.
3. UNKNOWN KEYS ARE IGNORED, because Go's decoder is used in non-strict mode.
   Rejecting them would be stricter than the oracle and would fail on a manifest
   carrying a field newer than the pinned client's models.
4. A CLEANUP FAILURE NEVER REPLACES A TEST'S FINDING, and is never silently
   discarded either.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tests.helpers.manifest import (
    CASE_OWNERSHIP_MARKER,
    KUBE_APISERVER_MANIFEST_FILE_NAME,
    KUBE_APISERVER_START_FUNC_NAME,
    MANIFEST_DESTINATION_RELATIVE_PATH,
    MANIFEST_SOURCES_RELATIVE_PATH,
    ManifestHarnessError,
    ManifestTestCase,
    manifest_test_case,
    parse_pod_manifest,
    validate_pod_document,
)

pytestmark = pytest.mark.shell

#: A minimal but structurally complete v1.Pod, shaped like the artefact the
#: shipped generator emits: the same envelope, the same nested probe, ports,
#: resources, security context, volume and volume mount. Every mutation below
#: perturbs exactly one field of it, so a rejection is attributable.
_VALID_POD: dict[str, object] = {
    "apiVersion": "v1",
    "kind": "Pod",
    "metadata": {
        "name": "kube-apiserver",
        "namespace": "kube-system",
        "labels": {"tier": "control-plane", "component": "kube-apiserver"},
    },
    "spec": {
        "securityContext": {
            "runAsUser": 1000,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
        "priorityClassName": "system-node-critical",
        "priority": 2000001000,
        "hostNetwork": True,
        "containers": [
            {
                "name": "kube-apiserver",
                "image": "registry/kube-apiserver-amd64:tag",
                "command": ["/go-runner", "/usr/local/bin/kube-apiserver", "--etcd-servers=x"],
                "resources": {"requests": {"cpu": "250m"}},
                "livenessProbe": {
                    "httpGet": {
                        "scheme": "HTTPS",
                        "host": "127.0.0.1",
                        "port": 443,
                        "path": "/livez",
                    },
                    "initialDelaySeconds": 45,
                    "timeoutSeconds": 15,
                },
                "ports": [{"name": "https", "containerPort": 443, "hostPort": 443}],
                "volumeMounts": [
                    {"name": "srvkube", "mountPath": "/etc/srv/kubernetes", "readOnly": True}
                ],
            }
        ],
        "volumes": [{"name": "srvkube", "hostPath": {"path": "/etc/srv/kubernetes"}}],
    },
}


def _pod(**mutations: object) -> dict[str, object]:
    """Deep-copy the valid Pod and apply one dotted-path mutation per keyword.

    Keys use ``__`` for a path separator and a bare integer segment for a list
    index, so ``spec__containers__0__command`` addresses the container command.
    """
    document = json.loads(json.dumps(_VALID_POD))
    for path, value in mutations.items():
        segments = path.split("__")
        cursor: object = document
        for segment in segments[:-1]:
            key: object = int(segment) if segment.isdigit() else segment
            cursor = cursor[key]  # type: ignore[index]
        last = segments[-1]
        if last.isdigit():
            cursor[int(last)] = value  # type: ignore[index]
        else:
            cursor[last] = value  # type: ignore[index]
    return document


def _make_case(repo_root: Path, **kwargs: object) -> ManifestTestCase:
    """Build a case against the real repository templates."""
    return ManifestTestCase(
        repo_root=repo_root,
        manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
        func_name=KUBE_APISERVER_START_FUNC_NAME,
        **kwargs,  # type: ignore[arg-type]
    )


@pytest.fixture
def repo_root() -> Path:
    """The repository root, derived from this file rather than from the process CWD."""
    return Path(__file__).resolve().parents[4]


# ---------------------------------------------------------------------------
# 1. Teardown ownership
# ---------------------------------------------------------------------------


def test_teardown_removes_a_kube_home_the_harness_created(repo_root: Path, tmp_path: Path) -> None:
    """base_dir= is the owned shape: the whole subdirectory goes, exactly as Go's tearDown does."""
    case = _make_case(repo_root, base_dir=tmp_path)
    home = case.kube_home

    assert home.is_dir()
    assert (home / CASE_OWNERSHIP_MARKER).is_file(), "setup must claim the tree it prepared"

    case.tear_down()

    assert not home.exists()
    assert tmp_path.is_dir(), "the parent the caller owns must survive"


def test_teardown_is_idempotent(repo_root: Path, tmp_path: Path) -> None:
    """manifest_test_case may already have torn the case down; a second call must be harmless."""
    case = _make_case(repo_root, base_dir=tmp_path)

    case.tear_down()
    case.tear_down()


def test_teardown_keeps_a_pre_existing_caller_directorys_other_contents(
    repo_root: Path, tmp_path: Path
) -> None:
    """A directory the caller already had must not be deleted wholesale.

    This is the one deliberate departure from Go's ``os.RemoveAll(c.kubeHome)``:
    Go only ever receives a ``MkdirTemp`` path of its own making, whereas this
    harness accepts ``kube_home=``. Cleaning up after itself is right; removing a
    directory whose other contents it never inspected is not.
    """
    home = tmp_path / "caller-owned"
    home.mkdir()
    keeper = home / "the-callers-own-file.txt"
    keeper.write_text("must survive teardown", encoding="utf-8")

    case = _make_case(repo_root, kube_home=home)
    assert (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).is_dir()

    case.tear_down()

    assert home.is_dir(), "a pre-existing caller directory must not be removed"
    assert keeper.read_text(encoding="utf-8") == "must survive teardown"
    assert not (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).exists()
    assert not (home / MANIFEST_DESTINATION_RELATIVE_PATH[0]).exists()
    assert not (home / CASE_OWNERSHIP_MARKER).exists()


def test_symlinked_kube_home_is_refused_at_construction(repo_root: Path, tmp_path: Path) -> None:
    """Following a caller-supplied link and then removing the result is the destructive path."""
    precious = tmp_path / "precious"
    precious.mkdir()
    (precious / "keep.txt").write_text("must survive", encoding="utf-8")
    link = tmp_path / "link-home"
    link.symlink_to(precious, target_is_directory=True)

    with pytest.raises(ManifestHarnessError, match="is a symlink"):
        _make_case(repo_root, kube_home=link)

    assert (precious / "keep.txt").read_text(encoding="utf-8") == "must survive"


def test_teardown_refuses_a_tree_that_lost_its_ownership_marker(
    repo_root: Path, tmp_path: Path
) -> None:
    """Without the marker the harness cannot prove it prepared the tree, so it must not remove it."""
    case = _make_case(repo_root, base_dir=tmp_path)
    home = case.kube_home
    (home / CASE_OWNERSHIP_MARKER).unlink()

    with pytest.raises(ManifestHarnessError, match="carries no"):
        case.tear_down()

    assert home.is_dir(), "the tree must be left in place when ownership cannot be proved"


def test_teardown_refuses_a_kube_home_replaced_by_a_symlink_mid_test(
    repo_root: Path, tmp_path: Path
) -> None:
    """The second line of the same defence: the path may become a link after construction."""
    case = _make_case(repo_root, base_dir=tmp_path)
    home = case.kube_home
    precious = tmp_path / "precious"
    precious.mkdir()
    (precious / "keep.txt").write_text("must survive", encoding="utf-8")

    import shutil

    shutil.rmtree(home)
    home.symlink_to(precious, target_is_directory=True)

    with pytest.raises(ManifestHarnessError, match="SYMLINK"):
        case.tear_down()

    assert (precious / "keep.txt").read_text(encoding="utf-8") == "must survive"
    home.unlink()


def test_a_kube_home_already_holding_a_case_tree_is_refused(
    repo_root: Path, tmp_path: Path
) -> None:
    """Two cases sharing a KUBE_HOME lets one read what the other left: a pass proving nothing."""
    home = tmp_path / "shared"
    first = _make_case(repo_root, kube_home=home)

    with pytest.raises(ManifestHarnessError, match="already contains"):
        _make_case(repo_root, kube_home=home)

    first.tear_down()


def test_failed_setup_removes_only_a_directory_the_harness_created(
    repo_root: Path, tmp_path: Path
) -> None:
    """A constructor failure must leak nothing it created and must not touch what it did not."""
    home = tmp_path / "caller-owned"
    home.mkdir()
    keeper = home / "keep.txt"
    keeper.write_text("must survive", encoding="utf-8")

    with pytest.raises(ManifestHarnessError):
        ManifestTestCase(
            repo_root=repo_root,
            manifest="this-manifest-does-not-exist.manifest",
            func_name=KUBE_APISERVER_START_FUNC_NAME,
            kube_home=home,
        )

    assert home.is_dir()
    assert keeper.read_text(encoding="utf-8") == "must survive"


# ---------------------------------------------------------------------------
# 2. Cleanup failure is attached, never substituted
# ---------------------------------------------------------------------------


def test_cleanup_failure_is_attached_to_the_bodys_own_failure(
    repo_root: Path, tmp_path: Path
) -> None:
    """The finding the test made must propagate, and the leak must still be reported.

    Suppressing the cleanup error hides a leaked tree until it breaks an unrelated
    test; raising it replaces a security finding with a housekeeping one. A note
    on the original exception is the only outcome that keeps both.
    """
    def body_fails_and_cleanup_fails_too() -> None:
        with manifest_test_case(
            repo_root=repo_root,
            manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
            func_name=KUBE_APISERVER_START_FUNC_NAME,
            base_dir=tmp_path,
        ) as case:
            # Break teardown the way a real leak does -- remove the proof of
            # ownership so cleanup must refuse -- then fail the body.
            (case.kube_home / CASE_OWNERSHIP_MARKER).unlink()
            raise AssertionError("the finding the test made")

    with pytest.raises(AssertionError, match="the finding the test made") as caught:
        body_fails_and_cleanup_fails_too()

    notes = getattr(caught.value, "__notes__", [])
    assert any("cleanup ALSO failed" in note for note in notes), (
        "the teardown failure was discarded, so a leaked KUBE_HOME would be invisible"
    )


def test_successful_body_propagates_a_cleanup_failure(repo_root: Path, tmp_path: Path) -> None:
    """With nothing to protect, a cleanup failure is the finding and must be raised."""
    def body_succeeds_but_cleanup_fails() -> None:
        with manifest_test_case(
            repo_root=repo_root,
            manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
            func_name=KUBE_APISERVER_START_FUNC_NAME,
            base_dir=tmp_path,
        ) as case:
            (case.kube_home / CASE_OWNERSHIP_MARKER).unlink()

    with pytest.raises(ManifestHarnessError, match="carries no"):
        body_succeeds_but_cleanup_fails()


# ---------------------------------------------------------------------------
# 3. Whole-document decoder equivalence
# ---------------------------------------------------------------------------


def test_the_valid_pod_is_accepted(tmp_path: Path) -> None:
    """The positive control: the shape the generator emits must decode cleanly."""
    pod = parse_pod_manifest(json.dumps(_VALID_POD), source="probe")

    assert (pod.api_version, pod.kind) == ("v1", "Pod")
    assert pod.spec.containers[0].name == "kube-apiserver"
    assert pod.spec.volumes[0].host_path is not None


@pytest.mark.parametrize(
    ("case_id", "document", "expected"),
    [
        ("hostNetwork-as-string", _pod(spec__hostNetwork="yes"), "spec.hostNetwork"),
        ("priority-as-string", _pod(spec__priority="2000001000"), "spec.priority"),
        ("priority-as-float", _pod(spec__priority=2000001000.5), "spec.priority"),
        (
            "probe-timeout-as-string",
            _pod(spec__containers__0__livenessProbe__timeoutSeconds="15"),
            "livenessProbe.timeoutSeconds",
        ),
        (
            "probe-timeout-as-boolean",
            _pod(spec__containers__0__livenessProbe__timeoutSeconds=True),
            "livenessProbe.timeoutSeconds",
        ),
        (
            "containerPort-as-string",
            _pod(spec__containers__0__ports__0__containerPort="443"),
            "ports[0].containerPort",
        ),
        ("label-value-as-number", _pod(metadata__labels__tier=7), "metadata.labels"),
        ("metadata-as-array", _pod(metadata=[1, 2]), "metadata"),
        ("securityContext-as-string", _pod(spec__securityContext="strict"), "spec.securityContext"),
        (
            "seccompProfile-type-as-number",
            _pod(spec__securityContext__seccompProfile__type=1),
            "seccompProfile.type",
        ),
        ("volumes-as-object", _pod(spec__volumes={"name": "srvkube"}), "spec.volumes"),
        (
            "hostPath-path-as-number",
            _pod(spec__volumes__0__hostPath__path=5),
            "hostPath.path",
        ),
        (
            "resources-requests-as-array",
            _pod(spec__containers__0__resources__requests=["cpu"]),
            "resources.requests",
        ),
        (
            "volumeMount-readOnly-as-string",
            _pod(spec__containers__0__volumeMounts__0__readOnly="true"),
            "volumeMounts[0].readOnly",
        ),
        (
            "runAsUser-as-string",
            _pod(spec__securityContext__runAsUser="1000"),
            "securityContext.runAsUser",
        ),
    ],
    ids=lambda value: value if isinstance(value, str) and "." not in value else None,
)
def test_a_wrong_json_type_anywhere_in_the_pod_is_rejected(
    case_id: str, document: dict[str, object], expected: str
) -> None:
    """Go decodes the WHOLE artefact, so a field the typed views never read must still fail.

    Every field named here sits OUTSIDE the views this module models -- the
    security context, both probes, the ports, the resource requests, the labels --
    which is precisely why a partial parser passed documents the oracle rejects.
    """
    with pytest.raises(ManifestHarnessError, match=r"v1\.Pod schema") as caught:
        parse_pod_manifest(json.dumps(document), source="probe")

    assert expected in str(caught.value), (
        f"{case_id}: the message must name the offending field path"
    )


def test_an_unknown_key_is_ignored_matching_the_non_strict_decoder() -> None:
    """Go's decoder ignores what its scheme does not know; rejecting it would be stricter."""
    document = _pod()
    document["spec"]["aFieldNewerThanThePinnedClient"] = {"nested": [1, 2]}  # type: ignore[index]

    parse_pod_manifest(json.dumps(document), source="probe")


def test_an_explicit_null_is_accepted_for_an_optional_field() -> None:
    """A JSON null is the wire spelling of an absent optional field, and Go zero-values it."""
    document = _pod()
    document["spec"]["nodeName"] = None  # type: ignore[index]
    document["spec"]["activeDeadlineSeconds"] = None  # type: ignore[index]

    parse_pod_manifest(json.dumps(document), source="probe")


def test_a_non_pod_document_is_rejected() -> None:
    """The envelope check that licenses "we can be sure the manifest is a valid POD"."""
    with pytest.raises(ManifestHarnessError, match="not a v1 Pod"):
        parse_pod_manifest(
            json.dumps({"apiVersion": "v1", "kind": "ConfigMap", "spec": {"containers": []}}),
            source="probe",
        )


def test_a_pod_with_no_container_is_rejected() -> None:
    """Every assertion in the shell tier reads spec.containers[0]."""
    with pytest.raises(ManifestHarnessError, match="declares no container"):
        parse_pod_manifest(json.dumps(_pod(spec__containers=[])), source="probe")


def test_invalid_json_reports_the_text_it_could_not_decode() -> None:
    """When a textual substitution has gone wrong, the resulting text is the only useful clue."""
    with pytest.raises(ManifestHarnessError, match="failed to decode generated manifest"):
        parse_pod_manifest('{"apiVersion": "v1", "kind": "Pod",,}', source="probe")


def test_validate_pod_document_is_usable_without_a_bash_run() -> None:
    """Public on purpose: the guarantee has to be provable without a subprocess."""
    validate_pod_document(_VALID_POD, source="probe")

    with pytest.raises(ManifestHarnessError, match=r"spec\.hostNetwork"):
        validate_pod_document(_pod(spec__hostNetwork="yes"), source="probe")


def test_the_real_shipped_pod_manifest_template_is_json_and_locatable(repo_root: Path) -> None:
    """A guard on the input this harness copies: the artefact under test must exist."""
    template = repo_root / "cluster" / "gce" / "manifests" / KUBE_APISERVER_MANIFEST_FILE_NAME

    assert template.is_file(), f"the shipped pod-manifest template is missing at {template}"
    assert template.read_text(encoding="utf-8").lstrip().startswith("{")


# ---------------------------------------------------------------------------
# 4. Isolation
# ---------------------------------------------------------------------------


def test_two_cases_under_one_base_dir_do_not_collide(repo_root: Path, tmp_path: Path) -> None:
    """base_dir= is the shape to use with tmp_path precisely because it guarantees uniqueness."""
    first = _make_case(repo_root, base_dir=tmp_path)
    second = _make_case(repo_root, base_dir=tmp_path)

    assert first.kube_home != second.kube_home

    first.tear_down()
    assert second.kube_home.is_dir(), "tearing one case down must not disturb the other"
    second.tear_down()


def test_construction_does_not_change_the_working_directory(
    repo_root: Path, tmp_path: Path
) -> None:
    """Nothing here may depend on, or alter, where the run started."""
    before = os.getcwd()

    case = _make_case(repo_root, base_dir=tmp_path)
    case.tear_down()

    assert os.getcwd() == before
