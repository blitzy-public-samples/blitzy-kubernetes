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


def test_teardown_keeps_the_other_contents_of_a_pre_existing_caller_directory(
    repo_root: Path, tmp_path: Path
) -> None:
    """A directory the caller already had must not be deleted wholesale.

    This is the one deliberate departure from Go's ``os.RemoveAll(c.kubeHome)``:
    Go only ever receives a ``MkdirTemp`` path of its own making, whereas this
    harness accepts ``kube_home=``. Cleaning up after itself is right; removing a
    directory whose other contents it never inspected is not.

    The directory arrives EMPTY -- a non-empty one is refused outright, see
    :func:`test_a_non_empty_kube_home_is_refused` -- so what teardown must preserve
    is the directory ITSELF, and what it must remove is every entry the case put
    inside it. Anything the caller adds while the case is running is preserved too,
    because it was never recorded as created here.
    """
    home = tmp_path / "caller-owned"
    home.mkdir()

    case = _make_case(repo_root, kube_home=home)
    assert (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).is_dir()

    # Written AFTER construction, so it is something the harness never created and
    # therefore never tracked -- the case teardown must not touch it.
    keeper = home / "the-callers-own-file.txt"
    keeper.write_text("must survive teardown", encoding="utf-8")

    case.tear_down()

    assert home.is_dir(), "a pre-existing caller directory must not be removed"
    assert keeper.read_text(encoding="utf-8") == "must survive teardown"
    assert not (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).exists()
    assert not (home / MANIFEST_DESTINATION_RELATIVE_PATH[0]).exists()
    assert not (home / CASE_OWNERSHIP_MARKER).exists()


def test_teardown_keeps_the_caller_supplied_root_and_removes_only_what_it_created(
    repo_root: Path, tmp_path: Path
) -> None:
    """A LAYOUT ROOT the caller already had is not evidence that the harness made it.

    THE DATA LOSS THIS LOCKS OUT. The superseded teardown removed ``KUBE_HOME/etc``
    and ``KUBE_HOME/kube-manifests`` whole, because those are the two layout roots.
    But a root is not evidence of authorship, so a caller who passed a ``kube_home``
    it owned had directories deleted that this harness had never created.

    Two independent defences now close that, and this asserts the second of them: a
    non-empty caller-supplied root is refused outright
    (:func:`test_a_non_empty_kube_home_is_refused`), AND teardown removes only the
    entries it recorded creating, leaving the caller's own directory in place. The
    directory the caller supplied therefore survives while everything the harness
    brought into existence beneath it - both layout roots and the generator's output
    inside them - is gone.
    """
    home = tmp_path / "caller-owned-empty"
    home.mkdir()

    case = _make_case(repo_root, kube_home=home)
    # The harness created both layout roots below the caller's directory.
    assert (home / Path(*MANIFEST_DESTINATION_RELATIVE_PATH)).is_dir()
    assert (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).is_dir()

    case.tear_down()

    assert home.is_dir(), "a directory the caller supplied must survive teardown"
    assert not (home / MANIFEST_DESTINATION_RELATIVE_PATH[0]).exists(), (
        "the layout roots the harness created must be removed"
    )
    assert not (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).exists()
    assert not (home / CASE_OWNERSHIP_MARKER).exists()


def test_a_non_empty_kube_home_is_refused(repo_root: Path, tmp_path: Path) -> None:
    """An explicit ``kube_home=`` that already holds anything is refused at construction.

    THE HAZARD THIS CLOSES. Teardown removes what the case created; a pre-existing
    entry would either have to be reasoned about -- which is how a caller's data gets
    deleted, and the earlier behaviour did exactly that by removing the ``etc/``
    layout root by name -- or left behind, which reintroduces the isolation hazard the
    marker exists to prevent. Requiring emptiness removes the question, and costs
    nothing: every real call site passes ``base_dir=tmp_path`` or a fresh
    subdirectory.
    """
    home = tmp_path / "not-empty"
    home.mkdir()
    unrelated = home / MANIFEST_DESTINATION_RELATIVE_PATH[0] / "somebody-elses"
    unrelated.mkdir(parents=True)
    precious = unrelated / "keep.txt"
    precious.write_text("must survive", encoding="utf-8")

    with pytest.raises(ManifestHarnessError, match="is not empty"):
        _make_case(repo_root, kube_home=home)

    # Nothing was created, and nothing the caller had was disturbed.
    assert precious.read_text(encoding="utf-8") == "must survive"
    assert not (home / CASE_OWNERSHIP_MARKER).exists()
    assert not (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).exists()


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
    """Two cases sharing a KUBE_HOME lets one read what the other left: a pass proving nothing.

    The first case's own tree is what makes the directory non-empty, so the second
    construction is refused for exactly the reason emptiness is required.
    """
    home = tmp_path / "shared"
    first = _make_case(repo_root, kube_home=home)

    with pytest.raises(ManifestHarnessError, match="is not empty"):
        _make_case(repo_root, kube_home=home)

    first.tear_down()


def test_failed_setup_removes_only_a_directory_the_harness_created(
    repo_root: Path, tmp_path: Path
) -> None:
    """A constructor failure must leak nothing it created and must not touch what it did not.

    ROLLBACK IS UNCONDITIONAL, which is the second half of the ownership fix. It used
    to run only when the harness had created the KUBE_HOME root, so a failure part
    way through setting up a CALLER-supplied directory left the ownership marker and
    a half-built layout behind -- state that then made the directory look like
    another case's tree to the next construction, and that no teardown would ever
    remove because no object owned it.

    ``kube_home`` here is a fresh empty directory, which is the only shape an
    explicit KUBE_HOME may take, so what must survive is the directory itself and
    what must be gone is every entry the failed constructor created.
    """
    home = tmp_path / "caller-owned"
    home.mkdir()

    with pytest.raises(ManifestHarnessError):
        ManifestTestCase(
            repo_root=repo_root,
            manifest="this-manifest-does-not-exist.manifest",
            func_name=KUBE_APISERVER_START_FUNC_NAME,
            kube_home=home,
        )

    assert home.is_dir()
    # The marker is claimed before the failing copy step, so this is the entry that
    # used to be left behind.
    assert not (home / CASE_OWNERSHIP_MARKER).exists()
    assert not (home / MANIFEST_SOURCES_RELATIVE_PATH[0]).exists()
    assert not (home / MANIFEST_DESTINATION_RELATIVE_PATH[0]).exists()
    assert sorted(entry.name for entry in home.iterdir()) == []

    # And because nothing was left behind, the directory is usable again -- which is
    # the practical consequence of rolling back rather than leaking.
    case = _make_case(repo_root, kube_home=home)
    case.tear_down()


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


# ---------------------------------------------------------------------------
# 3b. Kubernetes CUSTOM SCALARS: where the OpenAPI type string is not the decoder
# ---------------------------------------------------------------------------
# The generated Python models describe two Kubernetes scalars more loosely than the
# Go decoder they stand for: `resource.Quantity` is `dict(str, str)` on
# resources.limits/requests, and `intstr.IntOrString` is `object` on a probe port.
# Both occur in the shipped manifest, and both are values the generator SUBSTITUTES,
# so accepting whatever the OpenAPI string allows would let this harness bless a
# document the API server refuses at boot.


@pytest.mark.parametrize(
    "quantity",
    ["250m", "1", "0", "1.5", "1.5Gi", "512Mi", "2k", "100n", "1e3", "1E-3", "+2", "-1", ".5", "3."],
    ids=lambda value: f"accepts-{value}",
)
def test_a_valid_quantity_is_accepted(quantity: str) -> None:
    """Every form ``ParseQuantity`` accepts must pass, or a valid manifest is failed.

    The grammar is <signedNumber><suffix> with suffix drawn from the binary prefixes
    (Ki..Ei), the decimal ones (n u m k M G T P E) or an e/E exponent -- and the
    number itself may be written ``3.`` or ``.5``.
    """
    validate_pod_document(
        _pod(spec__containers__0__resources={"requests": {"cpu": quantity}}), source="probe"
    )


@pytest.mark.parametrize(
    "quantity",
    ["not-a-quantity", "", "250mm", "1.2.3", "100K", "10Gib", "m", "1 000", "0x10", "1e", True],
    ids=lambda value: f"rejects-{value!r}",
)
def test_an_invalid_quantity_is_rejected(quantity: object) -> None:
    """A resources value Go would reject must be reported here, naming the field.

    ``cpu: not-a-quantity`` is the case that motivated this: it is "a string", so the
    OpenAPI walk accepted it while ``resource.Quantity.UnmarshalJSON`` fails the whole
    document. ``100K`` is included because the decimal suffix is lower-case ``k`` --
    upper-case ``K`` is not a quantity, and treating it as one would be the same
    defect in the opposite direction.
    """
    with pytest.raises(ManifestHarnessError, match=r"resource\.Quantity|Quantity"):
        validate_pod_document(
            _pod(spec__containers__0__resources={"requests": {"cpu": quantity}}), source="probe"
        )


@pytest.mark.parametrize(
    "port",
    [443, 8080, "https", "named-port", None, 0, 2147483647],
    ids=lambda value: f"accepts-{value!r}",
)
def test_a_valid_probe_port_is_accepted(port: object) -> None:
    """``IntOrString`` accepts a quoted name, an int32, or null. All three must pass."""
    validate_pod_document(
        _pod(spec__containers__0__livenessProbe__httpGet__port=port), source="probe"
    )


@pytest.mark.parametrize(
    "port",
    [True, 1.5, 1.0, 2147483648, -2147483649, [443], {"port": 443}],
    ids=lambda value: f"rejects-{value!r}",
)
def test_an_invalid_probe_port_is_rejected(port: object) -> None:
    """A probe port Go would reject must be reported, naming the field.

    ``{{secure_port}}`` is substituted by the shipped generator, so a botched
    substitution really can land a boolean, a fraction or a fragment of JSON here.
    ``1.0`` is rejected with ``1.5`` because ``encoding/json`` parses an int32 target
    from the literal text and a decimal point fails there whatever the value is.
    """
    with pytest.raises(ManifestHarnessError, match=r"IntOrString|int32"):
        validate_pod_document(
            _pod(spec__containers__0__livenessProbe__httpGet__port=port), source="probe"
        )


def test_the_custom_scalar_check_reaches_every_occurrence_not_just_the_first() -> None:
    """The check is keyed on (model, attribute), so it applies wherever the field appears.

    A readiness probe is validated exactly as a liveness probe is, and a `limits`
    mapping exactly as `requests`. Keying on a concrete field path would have covered
    only the places this module happened to look.
    """
    with pytest.raises(ManifestHarnessError, match=r"readinessProbe\.httpGet\.port"):
        validate_pod_document(
            _pod(
                spec__containers__0__readinessProbe={
                    "httpGet": {"scheme": "HTTPS", "host": "127.0.0.1", "port": 1.5, "path": "/"}
                }
            ),
            source="probe",
        )

    with pytest.raises(ManifestHarnessError, match="limits"):
        validate_pod_document(
            _pod(spec__containers__0__resources={"limits": {"memory": "lots"}}), source="probe"
        )


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
