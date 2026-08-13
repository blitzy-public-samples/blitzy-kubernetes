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

"""V3 shell-boundary gate: the encryption-provider flag, its decoded file and the KMS socket.

AAP §0.4.2.1 (the L1 shell-boundary blueprint for this module: "Port
``TestEncryptionProviderFlag`` (2), ``TestEncryptionProviderConfig`` (flat),
``TestKMSIntegration`` (2)") / §0.5.1 (this file's CREATE row, source
``cluster/gce/gci/apiserver_kms_test.go``) / §0.5.2.1 ("five cases ... a
byte-exact file-content comparison proving the base64 decode") / §0.10.2
(boundary conditions that must port unchanged) / §0.11.1 (the
enterprise-standard bar this work is held to, NO user rules being defined for
this project - ``review_rules`` returns "No user rules provided.") - and
tech-spec §6.6.1.1, which records the property the whole tier exists to
preserve: the test "proves the shipped shell generator, not a
re-implementation".

CONTROL UNDER TEST: V3, Secrets encryption at rest - specifically the boot-time
half of it, ``setup-etcd-encryption`` in
``cluster/gce/gci/configure-kubeapiserver.sh`` (the function begins at line
459), which decodes the operator-supplied EncryptionConfiguration to disk,
points ``--encryption-provider-config`` at it, and - when the KMS integration is
switched on - grants the API server a host-path socket to reach the KMS plugin
through.

WHAT IS PORTED, LINE FOR LINE

    Go (cluster/gce/gci/apiserver_kms_test.go)      This module
    ---------------------------------------------   ----------------------------
    TestEncryptionProviderFlag    L47, 2 subtests   test_encryption_provider_flag
    TestEncryptionProviderConfig  L105, FLAT        test_encryption_provider_config
    TestKMSIntegration            L141, 2 subtests  test_kms_integration
    kubeAPIServerEnv              L39-45            tests.fixtures.etcd_env_cases
                                                    .KubeAPIServerEnv
    kubeAPIServer* constants      L33-37            tests.helpers.manifest
    newManifestTestCase + tearDown                  manifest_case fixture
    mustInvokeFunc / mustCreateEnv                  ShellManifestCase.invoke_func
    mustLoadPodFromManifest                         .load_pod_from_manifest()

Five cases in total, contributing THREE top-level identities and exactly FOUR
subtest verdicts to the 648-case shell-boundary baseline.

THE FLAT TEST IS FLAT, AND THAT IS A PARITY CONSTRAINT RATHER THAN A STYLE

``TestEncryptionProviderConfig`` (L105-139) contains no ``t.Run``: measured, not
assumed - ``t.Run`` occurs in the whole 225-line file only at L70 (inside
``TestEncryptionProviderFlag``) and L177 (inside ``TestKMSIntegration``). The
committed baseline agrees: ``python/tests/parity/baseline/go_baseline.json``
holds one row for ``TestEncryptionProviderConfig`` with an EMPTY ``subtest``
field and no subtest rows beneath it, while the other two carry two subtest rows
each.

So :func:`test_encryption_provider_config` carries NO
``@pytest.mark.parametrize`` - not even a single-case one. A parametrized
single case would collect as ``test_encryption_provider_config[...]`` and report
a subtest verdict the baseline does not contain, which is exactly what the parity
contract's completeness and verdict-equality assertions exist to catch. Its node
id must stay bracket-free.

ASSERTION SEMANTICS: SIX ABORT, TWO ACCUMULATE - MEASURED, NOT INFERRED

``grep -c 't\\.Fatalf'`` over the Go file yields 6 and ``grep -c 't\\.Errorf'``
yields 2, and the split is not arbitrary:

* The SIX ``t.Fatalf`` calls are the three switch branches of
  ``TestEncryptionProviderFlag`` (L95, L97, L99) and the three checks of the flat
  ``TestEncryptionProviderConfig`` (L127, L132, L137). Go aborts the test at each,
  so those port to bare ``assert`` statements, which abort on the first failure in
  declaration order.
* The TWO ``t.Errorf`` calls are ``TestKMSIntegration``'s two
  ``reflect.DeepEqual`` comparisons - the volume at L208-210 and the volume mount
  at L220-222. ``t.Errorf`` RECORDS and CONTINUES, so a broken generator reports
  BOTH the missing volume and the missing mount from one run. They therefore port
  to two ``pytest.Subtests`` blocks (native to pytest 9; there is no
  ``pytest-subtests`` pin), one per comparison. A bare ``assert`` on the volume
  would hide a mount regression behind a volume regression, and that fidelity loss
  is precisely what the AAP forbids.

BOUNDARY CONDITIONS THAT MUST NOT SOFTEN

* THE DECODED FILE IS COMPARED AS BYTES AND MUST EQUAL EXACTLY ``b"foo"``. The Go
  original is ``bytes.Equal(got, []byte("foo"))`` over ``os.ReadFile`` output
  (L130-138). Read in binary, compare to bytes, and do not decode to ``str``, do
  not ``.strip()`` and do not compare against ``"foo"``: the shipped script
  redirects ``base64 --decode`` straight to the file
  (configure-kubeapiserver.sh:489), so a trailing newline appearing there would be
  a real regression in the decode path and this assertion is what catches it.
* FLAG ASSERTIONS ARE SUBSTRING CONTAINMENT, NEVER EQUALITY. The Go original
  joins the container command with single spaces and calls ``strings.Contains``
  (L89-99). Equality against a whole command line would break on any unrelated
  flag the generator adds, and the "absent" case is only expressible as a
  substring test in the first place.
* THE CONFIG PATH IS ``<kube_home>/encryption-provider-config.yaml`` IN ALL THREE
  FUNCTIONS, always (L77, L109, L184). It is per-case, being rooted in that case's
  throwaway ``KUBE_HOME``, so it is derived at run time and never a literal.
* ``CloudKMSIntegration`` MUST REACH THE RENDERER AS A REAL ``bool``. It is the
  only non-string field of the five-field environment and it guards
  ``{{if .CloudKMSIntegration}}`` in the shipped ``kms.template``. Go's template
  truthiness counts any non-empty string as true, so a stringified ``"False"``
  would render ``readonly CLOUD_KMS_INTEGRATION=true`` for a case that switched
  the integration OFF - and the socket volume would appear where the test asserts
  its absence. ``KubeAPIServerEnv.cloud_kms_integration`` is typed ``bool`` for
  this reason and nothing here stringifies it.

WHAT IS RUN FOR REAL, AND WHAT IS NOT MOCKED

Nothing is mocked. Every case sources the SHIPPED ``configure-helper.sh`` and
``configure-kubeapiserver.sh`` from this checkout through ``bash``, from a
``KUBE_HOME`` the case alone owns, with a ``kube-env`` rendered from the SHIPPED
``testdata/kube-apiserver/base.template`` and ``kms.template``. Those four
artefacts are read-only inputs: they are never edited, never duplicated under
``python/`` and never re-implemented in Python. The KMS plugin itself is not
mocked either - and does not need to be, because what is under test is whether
the generator grants the socket, not whether anything answers on it.

No etcd, no API server, no network. ``pytest -m "not integration"`` runs every
case here.

NO KEY MATERIAL. The only credential-shaped value in the module is
``base64("foo") == "Zm9v"``, which is the Go table's own placeholder, and the
socket path ``/var/run/kmsplugin``, which is a directory name. The AAP's
permitted AES-GCM test key belongs to the V3 INTEGRATION tier and is deliberately
absent here.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import pytest

from tests.fixtures.etcd_env_cases import KubeAPIServerEnv, case_id_from_desc
from tests.helpers.manifest import (
    BASE_TEMPLATE_RELATIVE_PATH,
    KMS_TEMPLATE_RELATIVE_PATH,
    KMS_TEMPLATE_TARGET,
    KUBE_APISERVER_MANIFEST_FILE_NAME,
    KUBE_APISERVER_SCRIPT_NAMES,
    KUBE_APISERVER_START_FUNC_NAME,
    Container,
    PodManifest,
)

if TYPE_CHECKING:
    from pathlib import Path

    # Type-only, so no conftest module is imported at run time while the
    # signatures below still typecheck under `mypy .` from python/. The three
    # names are the public surface of tests/unit/shell/conftest.py that this
    # module consumes: the two fixture factories and the case object they build.
    from tests.unit.shell.conftest import (
        KubeEnvRenderFactory,
        ManifestCaseFactory,
        ShellManifestCase,
    )

# L1 shell-boundary tier: this module invokes the shipped bash generators through
# a subprocess. `shell` is one of the exactly five markers python/pyproject.toml
# declares (integration, shell, config, parity, slow) and `--strict-markers`
# makes any other name a collection ERROR, so this line is a contract with that
# file rather than a free-form label. Nothing else is applied: the tier needs
# neither etcd nor an API server.
pytestmark = pytest.mark.shell


# ---------------------------------------------------------------------------
# Constants. Every value is either quoted from the Go file with its line number
# or measured against the shipped script; nothing here is inferred.
# ---------------------------------------------------------------------------

#: Quoted in every assertion message so a CI failure reads as a requirement
#: violation rather than a value mismatch (AAP §0.7.2). ``F-003-RQ-001`` is V3's
#: provider-configuration requirement; the AAP assigns the shell-boundary half of
#: V3 no identifier of its own, and this is the requirement these assertions
#: serve, because a correctly shaped provider configuration that never reaches
#: the API server is not in force. No CIS or NSA control number is cited, here or
#: anywhere: the repository enumerates none, so none is asserted (AAP §0.11.1).
_RQ: Final[str] = "F-003-RQ-001"

#: The basename of the decoded EncryptionConfiguration inside a case's
#: ``KUBE_HOME``. Go writes it as the literal second argument of
#: ``filepath.Join(c.kubeHome, "encryption-provider-config.yaml")`` at L77, L109
#: and L184 - the same basename in all three functions - and the shipped script
#: honours whatever ``ENCRYPTION_PROVIDER_CONFIG_PATH`` names
#: (configure-kubeapiserver.sh:487), defaulting to
#: ``/etc/srv/kubernetes/encryption-provider-config.yml`` only when the variable
#: is unset. The full path is per-case and therefore derived at run time by
#: :func:`_config_path`, never written down.
ENCRYPTION_PROVIDER_CONFIG_FILE_NAME: Final[str] = "encryption-provider-config.yaml"

#: Go: ``encryptionConfigFlag``, L49. Searched for as a SUBSTRING of the joined
#: container command, which is what makes "the flag is absent entirely"
#: expressible at all.
ENCRYPTION_CONFIG_FLAG: Final[str] = "--encryption-provider-config"

#: The bytes the shipped script must write to the configuration file. Go:
#: ``want := []byte("foo")``, L135, compared with ``bytes.Equal``, L136.
DECODED_ENCRYPTION_PROVIDER_CONFIG: Final[bytes] = b"foo"

#: What the operator supplies in ``ENCRYPTION_PROVIDER_CONFIG``: Go's
#: ``base64.StdEncoding.EncodeToString([]byte("foo"))`` at L59, L114 and L185,
#: which is the four characters ``Zm9v``. COMPUTED rather than transcribed, for
#: the same reason Go computes it: the encoding and the expected decoded bytes
#: then cannot drift apart. Standard base64 with padding is exactly what
#: ``base64.StdEncoding`` and ``base64 --decode`` both speak.
ENCRYPTION_PROVIDER_CONFIG_B64: Final[str] = base64.b64encode(
    DECODED_ENCRYPTION_PROVIDER_CONFIG
).decode("ascii")

#: Go: ``socketPath``, L143. The host directory the KMS plugin's Unix socket
#: lives in, and the value configure-kubeapiserver.sh:504 sets as
#: ``default_kms_socket_dir``. A directory name, not a credential.
KMS_SOCKET_PATH: Final[str] = "/var/run/kmsplugin"

#: Go: ``socketName``, L145. The name of BOTH the pod volume and the container
#: volume mount the generator emits (configure-kubeapiserver.sh:505-506), which
#: is why one constant serves both lookups.
KMS_SOCKET_NAME: Final[str] = "kmssocket"

#: Go: ``dirOrCreate = v1.HostPathType(v1.HostPathDirectoryOrCreate)``, L144.
#: Asserted as the wire string the generator emits, because the ported
#: :class:`~tests.helpers.manifest.HostPathVolumeSource` carries the decoded
#: manifest's value rather than a client enum. ``DirectoryOrCreate`` rather than
#: ``Directory`` is load-bearing: the socket directory may not exist yet on a
#: freshly booted master, and ``Directory`` would fail the pod instead of
#: creating it.
HOST_PATH_DIRECTORY_OR_CREATE: Final[str] = "DirectoryOrCreate"


# ---------------------------------------------------------------------------
# Case tables. One frozen dataclass per Go table, in Go source order.
# ---------------------------------------------------------------------------
# Tuples rather than lists, because a parametrize argument set that something
# could append to is one that can differ between two runs of the same suite. The
# declared order is preserved deliberately so a case's position is reproducible
# even though pytest-randomly shuffles the order tests EXECUTE in.
#
# The tables live here rather than in tests/fixtures/etcd_env_cases.py by that
# module's own decision: it owns the ENVIRONMENT the cases render from
# (KubeAPIServerEnv) and records that "those assertions and their case tables
# belong to that module" - this one.


@dataclass(frozen=True)
class _EncryptionProviderFlagCase:
    """One row of the ``TestEncryptionProviderFlag`` table (L52-67).

    Two rows only, and they are complements: an operator-supplied configuration
    must produce the flag pointing at the decoded file, and no configuration must
    produce no flag at all. There is no third state - the shipped script either
    took its ``setup-etcd-encryption`` branch or it did not.
    """

    #: The Go subtest description, verbatim. Kept beside :attr:`case_id` because
    #: the parity contract has to speak both spellings at once: the baseline
    #: records Go's name and the ported run reports pytest's.
    desc: str

    #: What reaches ``ENCRYPTION_PROVIDER_CONFIG``: base64 text, or the empty
    #: string for "not set". Empty is meaningful rather than merely absent -
    #: ``{{if .EncryptionProviderConfig}}`` in the shipped ``kms.template`` omits
    #: the assignment entirely for it, so the script sees an UNSET variable and
    #: not an empty one.
    encryption_provider_config: str

    #: Whether the joined container command must contain the flag. Go:
    #: ``wantFlag``.
    want_flag: bool

    @property
    def case_id(self) -> str:
        """The pytest parametrize id, derived from :attr:`desc`.

        Derived rather than stored, so an id and the description it names can
        never disagree. The derivation is
        ``tests.fixtures.etcd_env_cases.case_id_from_desc``, the tier's single
        definition of that rule, and these two ids are a public contract:
        tests/parity/parity_map.py binds each Go verdict to one of them, and a
        mistyped ``-k`` selector merely deselects everything rather than
        erroring, so a silently renamed id would silently empty this test.
        """
        return case_id_from_desc(self.desc)

    @property
    def go_subtest_name(self) -> str:
        """The subtest name ``t.Run(tc.desc, ...)`` reports for this case.

        Go rewrites each space to an underscore, so
        ``"ENCRYPTION_PROVIDER_CONFIG is set"`` is reported as
        ``ENCRYPTION_PROVIDER_CONFIG_is_set``. Verified against the measured
        oracle: ``go test -v -run TestEncryptionProviderFlag
        ./cluster/gce/gci/`` reports exactly these two names, and both appear
        verbatim in the committed baseline. Neither description repeats within its
        function, so Go appends no ``#NN`` disambiguation suffix and none is
        invented here.
        """
        return self.desc.replace(" ", "_")


#: ``TestEncryptionProviderFlag`` - L52-67.
#:
#: INVARIANT LOCKED: an operator-supplied EncryptionConfiguration reaches the API
#: server, and its absence leaves the flag off rather than pointing at a file
#: that was never written. A flag pointing at a missing file would fail the API
#: server closed, and a silently absent flag would run the cluster with
#: PLAINTEXT secrets at rest - the very weakness V3 closes - so both directions
#: are asserted.
ENCRYPTION_PROVIDER_FLAG_CASES: tuple[_EncryptionProviderFlagCase, ...] = (
    _EncryptionProviderFlagCase(
        desc="ENCRYPTION_PROVIDER_CONFIG is set",
        encryption_provider_config=ENCRYPTION_PROVIDER_CONFIG_B64,
        want_flag=True,
    ),
    _EncryptionProviderFlagCase(
        desc="ENCRYPTION_PROVIDER_CONFIG is not set",
        # Go writes the empty string explicitly (L64) rather than omitting the
        # field, and so does this: "deliberately not set" and "happened to be
        # forgotten" must not look alike in a security test.
        encryption_provider_config="",
        want_flag=False,
    ),
)


@dataclass(frozen=True)
class _ExpectedVolume:
    """The ``v1.Volume`` literal of the KMS table (L156-164), as wire values.

    Go compares the whole struct with ``reflect.DeepEqual``, so the name, the
    host path and the host-path TYPE are all pinned. The fields are held as the
    strings the decoded manifest carries rather than as client enums, because
    that is what :class:`~tests.helpers.manifest.HostPathVolumeSource` exposes -
    and because the manifest is the artefact the generator actually wrote.
    """

    name: str
    host_path: str
    host_path_type: str


@dataclass(frozen=True)
class _ExpectedVolumeMount:
    """The ``v1.VolumeMount`` literal of the KMS table (L165-168), as wire values.

    Go's literal sets only ``Name`` and ``MountPath``, but ``reflect.DeepEqual``
    compares every field, so ``ReadOnly`` is pinned to its zero value too - and
    the shipped generator emits ``"readOnly": false`` explicitly
    (configure-kubeapiserver.sh:505), which is what makes that comparison pass
    today. :attr:`read_only` therefore defaults to ``False`` and IS asserted: the
    socket is bidirectional, so a read-only mount would break the envelope call
    at run time while every other assertion still passed.
    """

    name: str
    mount_path: str
    read_only: bool = False


@dataclass(frozen=True)
class _KMSIntegrationCase:
    """One row of the ``TestKMSIntegration`` table (L147-174).

    HOW "NONE" IS EXPRESSED, AND WHY IT IS NOT A ZERO-VALUE COMPARISON. Go
    declares ``var gotVolume v1.Volume``, scans ``pod.Spec.Volumes`` for one named
    ``kmssocket``, and compares the result with ``reflect.DeepEqual(gotVolume,
    tc.wantVolume)``. The second row leaves ``wantVolume`` at its ZERO VALUE, so
    that comparison passes exactly when the scan found nothing and ``gotVolume``
    was never assigned. The equivalent - and the clearer statement of the same
    thing - is ``None`` here and an absence-by-name assertion in the test, which
    is what :meth:`tests.helpers.manifest.PodSpec.volume` returning ``None`` for
    a miss is designed to express. Constructing a "zero-valued volume" to compare
    against would be a translation of Go's mechanism rather than of its meaning.
    """

    #: The Go subtest description, verbatim.
    desc: str

    #: Go: ``cloudKMSIntegration``. A real ``bool``, and it must stay one all the
    #: way to the renderer; see the module docstring.
    cloud_kms_integration: bool

    #: The pod volume that must exist, or ``None`` when none may.
    want_volume: _ExpectedVolume | None = None

    #: The container volume mount that must exist, or ``None`` when none may.
    want_volume_mount: _ExpectedVolumeMount | None = None

    @property
    def case_id(self) -> str:
        """The pytest parametrize id, derived from :attr:`desc`. See above."""
        return case_id_from_desc(self.desc)

    @property
    def go_subtest_name(self) -> str:
        """The subtest name ``t.Run(tc.desc, ...)`` reports: spaces to underscores."""
        return self.desc.replace(" ", "_")


#: ``TestKMSIntegration`` - L147-174.
#:
#: INVARIANT LOCKED: the KMS socket is granted when, and ONLY when, the cloud KMS
#: integration is switched on. Granting it unconditionally would mount a host
#: path into the API server for every cluster that does not use KMS; failing to
#: grant it when the integration IS on would leave the envelope provider unable
#: to reach its plugin, which fails encryption at rest closed at boot.
KMS_INTEGRATION_CASES: tuple[_KMSIntegrationCase, ...] = (
    _KMSIntegrationCase(
        desc="CLOUD_KMS_INTEGRATION is set",
        cloud_kms_integration=True,
        want_volume=_ExpectedVolume(
            name=KMS_SOCKET_NAME,
            host_path=KMS_SOCKET_PATH,
            host_path_type=HOST_PATH_DIRECTORY_OR_CREATE,
        ),
        want_volume_mount=_ExpectedVolumeMount(
            name=KMS_SOCKET_NAME,
            mount_path=KMS_SOCKET_PATH,
        ),
    ),
    _KMSIntegrationCase(
        desc="CLOUD_KMS_INTEGRATION is not set",
        # Go's row omits both expectations, leaving them at their zero values;
        # the defaults above are ``None``, which is the same statement.
        cloud_kms_integration=False,
    ),
)


# ---------------------------------------------------------------------------
# The body all three functions share (L71-87, L106-124, L178-197)
# ---------------------------------------------------------------------------


def _config_path(kube_home: Path) -> Path:
    """``<kube_home>/encryption-provider-config.yaml``: the port of the three joins.

    One derivation for all three Go call sites (L77, L109, L184), so the path the
    environment DECLARES and the path an assertion READS BACK cannot disagree.
    They must not: the flat case asserts on the file at this path while the flag
    case asserts that the rendered command line names it, and a second spelling
    would let one of the two silently address a file nothing ever wrote.
    """
    return kube_home / ENCRYPTION_PROVIDER_CONFIG_FILE_NAME


def _run_generator(
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
    *,
    encryption_provider_config: str,
    cloud_kms_integration: bool = False,
) -> tuple[ShellManifestCase, Path]:
    """Run the SHIPPED generator once, and return its case and configuration path.

    The four steps every one of the three Go functions performs, in their order
    (L71-87 being the fullest example):

    1. ``newManifestTestCase(t, kubeAPIServerManifestFileName,
       kubeAPIServerStartFuncName, nil)`` - a throwaway ``KUBE_HOME`` laid out as
       the generator expects, with the shipped ``kube-apiserver.manifest`` copied
       in and the destination directory created. ``defer c.tearDown()`` is the
       fixture's own teardown, which runs whether the test passed or failed.
    2. The five-field ``kubeAPIServerEnv`` (L39-45). ``KubeHome`` and
       ``KubeAPIServerRunAsUser`` are injected by
       :meth:`KubeEnvRenderFactory.context`, exactly as the Go functions assign
       ``c.kubeHome`` and ``strconv.Itoa(os.Getuid())`` at construction; the three
       remaining fields are this call's arguments.
    3. ``mustInvokeFunc(e, []string{"configure-helper.sh",
       kubeAPIServerConfigScriptName}, "kms.template",
       "testdata/kube-apiserver/base.template",
       "testdata/kube-apiserver/kms.template")`` - render ``kube-env`` from the
       SHIPPED templates, source the SHIPPED scripts and call
       ``start-kube-apiserver``. The target is a template NAME; the two trailing
       arguments are paths RELATIVE to ``cluster/gce/gci``, which the fixtures
       resolve because that directory is also the working directory of every
       invocation. ``base.template`` comes first because ``kms.template`` invokes
       the ``base`` template it defines.
    4. ``mustLoadPodFromManifest()`` is NOT performed here. Two of the three Go
       functions call it and the flat one does not - it asserts on the file system
       instead - so the caller decides, and no manifest is decoded for a test that
       has no use for one.

    A non-zero exit or a timeout raises, which is the ``t.Fatalf`` posture of
    ``mustInvokeFunc`` (configure_helper_test.go L117-121): a generator that did
    not run is a broken test rather than a failed assertion, and it must not be
    reported as a control violation.

    Args:
        manifest_case: The tier's case factory fixture.
        render_kube_env: The tier's ``kube-env`` renderer fixture.
        encryption_provider_config: ``ENCRYPTION_PROVIDER_CONFIG``: base64 text,
            or ``""`` for "not set".
        cloud_kms_integration: ``CLOUD_KMS_INTEGRATION``. A real ``bool``, passed
            through unstringified so the shipped template's ``{{if}}`` sees Go
            falsity for ``False``.

    Returns:
        The prepared case, whose ``load_pod_from_manifest()`` the caller may
        invoke, and the configuration path the environment declared.
    """
    __tracebackhide__ = True
    shell_case = manifest_case(
        manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
        func_name=KUBE_APISERVER_START_FUNC_NAME,
    )
    config_path = _config_path(shell_case.kube_home)
    env = KubeAPIServerEnv(
        encryption_provider_config_path=str(config_path),
        encryption_provider_config=encryption_provider_config,
        cloud_kms_integration=cloud_kms_integration,
    )
    shell_case.invoke_func(
        render_kube_env.context(env, kube_home=shell_case.kube_home),
        KUBE_APISERVER_SCRIPT_NAMES,
        KMS_TEMPLATE_TARGET,
        (BASE_TEMPLATE_RELATIVE_PATH, KMS_TEMPLATE_RELATIVE_PATH),
        requirement=_RQ,
    )
    return shell_case, config_path


def _apiserver_container(pod: PodManifest) -> Container:
    """``c.pod.Spec.Containers[0]``: the one container the generated manifest defines.

    Go indexes the slice directly (L89, L213) and would PANIC on an empty one.
    This raises a legible assertion instead, which cannot change any verdict -
    the condition it reports is the condition Go crashes on - but does mean a
    structurally wrong manifest is reported as a structurally wrong manifest
    rather than as ``IndexError: tuple index out of range``.

    The manifest reaching this point has already been validated against the
    ``v1.Pod`` schema by ``load_pod_from_manifest``, so this is the one shape
    assumption that validation does not cover.
    """
    __tracebackhide__ = True
    containers = pod.spec.containers
    assert containers, (
        f"{_RQ}: the generated kube-apiserver manifest declares NO containers, so there is no "
        "command line to assert on. The shipped generator emits exactly one container named "
        f"'kube-apiserver'; got spec.containers={list(containers)!r}."
    )
    return containers[0]


# ---------------------------------------------------------------------------
# TestEncryptionProviderFlag (apiserver_kms_test.go L47-103): 2 cases, ABORTING
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", ENCRYPTION_PROVIDER_FLAG_CASES, ids=lambda c: c.case_id)
def test_encryption_provider_flag(
    case: _EncryptionProviderFlagCase,
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """F-003-RQ-001: the decoded EncryptionConfiguration is wired to the API server.

    INVARIANT LOCKED: ``--encryption-provider-config`` appears in the generated
    kube-apiserver command line pointing at the file ``setup-etcd-encryption``
    decoded, and appears NOWHERE when no configuration was supplied. Encryption at
    rest is in force only if the flag reaches the process, so the positive half is
    what makes V3 real; and a flag naming a file nothing wrote would fail the API
    server closed at boot, so the negative half matters just as much.

    PORTS: ``TestEncryptionProviderFlag`` (L47-103), both subtests.

    ASSERTION SEMANTICS: ABORTING. Go's three-branch ``switch`` (L93-100) ends
    every branch in ``t.Fatalf``, so each check below is a bare ``assert`` and the
    first failure ends the case. The branches map one for one, and their ORDER is
    preserved:

    * L94-95 ``wantFlag && !flagIsInArg`` -> the first assert of the want-flag
      path;
    * L98-99 ``wantFlag && flagIsInArg && !Contains(execArgs, flag)`` -> the
      second assert of that path, which is reachable only once the first has
      passed, exactly as the switch orders them;
    * L96-97 ``!wantFlag && flagIsInArg`` -> the assert of the other path.

    CONTAINMENT, NEVER EQUALITY. Go joins the command with single spaces and uses
    ``strings.Contains``; ``command_line`` is that join. Equality against the whole
    command line would turn this case red for any unrelated flag the generator
    adds, and "the flag is absent entirely" is not expressible as an equality at
    all.
    """
    shell_case, config_path = _run_generator(
        manifest_case,
        render_kube_env,
        encryption_provider_config=case.encryption_provider_config,
    )
    pod = shell_case.load_pod_from_manifest()

    # Go: `execArgs := strings.Join(c.pod.Spec.Containers[0].Command, " ")` (L89)
    # and `flag := fmt.Sprintf("%s=%s", encryptionConfigFlag,
    # e.EncryptionProviderConfigPath)` (L91).
    exec_args = _apiserver_container(pod).command_line
    flag = f"{ENCRYPTION_CONFIG_FLAG}={config_path}"

    if case.want_flag:
        assert ENCRYPTION_CONFIG_FLAG in exec_args, (
            f"{_RQ}: {case.desc}, so the generated command line must contain "
            f"{ENCRYPTION_CONFIG_FLAG!r}. Without it the API server stores secrets in PLAINTEXT "
            f"however well formed the configuration is. Got: {exec_args!r}"
        )
        assert flag in exec_args, (
            f"{_RQ}: {case.desc}, so the generated command line must contain the flag with its "
            f"value, {flag!r}. The bare flag name is present, so the flag is being emitted with a "
            f"DIFFERENT path than the one setup-etcd-encryption decoded to - which points the API "
            f"server at a file nothing wrote. Got: {exec_args!r}"
        )
    else:
        assert ENCRYPTION_CONFIG_FLAG not in exec_args, (
            f"{_RQ}: {case.desc}, so the generated command line must NOT contain "
            f"{ENCRYPTION_CONFIG_FLAG!r} at all. Emitting it with no configuration to decode "
            f"names a file that was never written and fails the API server closed at boot. "
            f"Got: {exec_args!r}"
        )


# ---------------------------------------------------------------------------
# TestEncryptionProviderConfig (apiserver_kms_test.go L105-139): FLAT, ABORTING
# ---------------------------------------------------------------------------
# THERE IS DELIBERATELY NO @pytest.mark.parametrize BELOW, AND NONE MAY BE ADDED.
#
# The Go original contains no `t.Run`: measured, not assumed - `t.Run` occurs in
# the whole 225-line file only at L70 and L177, both outside L105-139. So this
# function contributes ONE top-level verdict and ZERO subtest verdicts to the
# 648-case baseline, and python/tests/parity/baseline/go_baseline.json already
# records it that way: a single row whose `subtest` field is empty, with no
# subtest rows beneath it.
#
# Parametrizing it - even with a single case - would collect it as
# `test_encryption_provider_config[...]` and report a subtest verdict the baseline
# does not contain, which the parity contract's completeness and verdict-equality
# assertions exist to catch. The node id must stay bracket-free.
#
# The AAP's blueprint also notes the negative half of this behaviour, that an
# absent configuration must not create the file. It is already covered by
# test_encryption_provider_flag's "is not set" case, which proves the flag is
# never emitted, and adding a second case here to restate it would break the flat
# shape for no additional coverage.


def test_encryption_provider_config(
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """F-003-RQ-001: the base64 EncryptionConfiguration is DECODED onto disk, byte for byte.

    INVARIANT LOCKED: ``setup-etcd-encryption``
    (cluster/gce/gci/configure-kubeapiserver.sh, the function begins at line 459)
    base64-DECODES what the operator supplied in ``ENCRYPTION_PROVIDER_CONFIG``
    and writes the plain bytes to ``ENCRYPTION_PROVIDER_CONFIG_PATH``. This is the
    decode ROUND TRIP: ``Zm9v`` goes in and exactly ``foo`` must come out. Were
    the encoding written through verbatim, or written with anything appended, the
    API server would be handed a file that is not an EncryptionConfiguration at
    all - and would refuse to start, taking encryption at rest down with it.

    PORTS: ``TestEncryptionProviderConfig`` (L105-139), which is FLAT. See the
    block comment above for why no parametrization may be added.

    ASSERTION SEMANTICS: ABORTING. All three checks are ``c.t.Fatalf`` in the
    original - L127 for the ``os.Stat``, L132 for the read, L137 for the byte
    comparison - so all three are bare ``assert`` statements here and the first
    failure ends the test. The read cannot fail separately in Python the way
    ``os.ReadFile`` can in Go: an unreadable file raises ``OSError`` from
    ``read_bytes()``, which pytest reports as an error on this test, so no check is
    lost.

    THE COMPARISON IS BYTES AGAINST BYTES, AND MUST STAY THAT WAY. Go writes
    ``bytes.Equal(got, []byte("foo"))`` over raw ``os.ReadFile`` output. The file
    is therefore opened in BINARY mode here and compared to
    ``DECODED_ENCRYPTION_PROVIDER_CONFIG``. Decoding to ``str``, calling
    ``.strip()``, or comparing against ``"foo"`` would each silently accept a
    trailing newline - and the shipped script pipes ``base64 --decode`` straight
    into the file with a plain redirect (configure-kubeapiserver.sh:489), so a
    newline appearing there would be a genuine regression in the decode path
    rather than cosmetic noise. This assertion is what catches it.
    """
    _, config_path = _run_generator(
        manifest_case,
        render_kube_env,
        encryption_provider_config=ENCRYPTION_PROVIDER_CONFIG_B64,
    )

    # Go: `if _, err := os.Stat(p); err != nil { c.t.Fatalf(...) }` (L126-128).
    # `is_file` rather than `exists`: a directory at this path would satisfy Stat
    # in Go too, but it cannot satisfy the read that follows, and reporting the
    # wrong kind of object here is more useful than an OSError two lines later.
    assert config_path.is_file(), (
        f"{_RQ}: the generated configuration must be written to {config_path}, but no file is "
        "there. setup-etcd-encryption honours ENCRYPTION_PROVIDER_CONFIG_PATH "
        "(configure-kubeapiserver.sh:487) and decodes ENCRYPTION_PROVIDER_CONFIG into it "
        f"(:489); nothing arrived. Directory contents: "
        f"{sorted(p.name for p in config_path.parent.iterdir())!r}"
    )

    # Go: `got, err := os.ReadFile(p)` (L130). BINARY, so nothing normalises a
    # line ending or re-encodes anything on the way in.
    got = config_path.read_bytes()

    # Go: `want := []byte("foo")` / `if !bytes.Equal(got, want)` (L135-138).
    assert got == DECODED_ENCRYPTION_PROVIDER_CONFIG, (
        f"{_RQ}: {config_path} must hold the DECODED configuration exactly - "
        f"{DECODED_ENCRYPTION_PROVIDER_CONFIG!r} - because "
        f"ENCRYPTION_PROVIDER_CONFIG was {ENCRYPTION_PROVIDER_CONFIG_B64!r}. Got {got!r} "
        f"({len(got)} bytes, want {len(DECODED_ENCRYPTION_PROVIDER_CONFIG)}). Equal to the "
        "base64 input means the encoding was written through without being decoded; longer by "
        "one byte usually means a newline was appended. Either way the API server is handed "
        "something that is not an EncryptionConfiguration."
    )


# ---------------------------------------------------------------------------
# TestKMSIntegration (apiserver_kms_test.go L141-225): 2 cases, ACCUMULATING
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", KMS_INTEGRATION_CASES, ids=lambda c: c.case_id)
def test_kms_integration(
    case: _KMSIntegrationCase,
    subtests: pytest.Subtests,
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """F-003-RQ-001: the KMS plugin socket is granted when, and only when, KMS is on.

    INVARIANT LOCKED: with ``CLOUD_KMS_INTEGRATION`` set, the generated static-pod
    manifest declares a ``kmssocket`` host-path volume at ``/var/run/kmsplugin``
    of type ``DirectoryOrCreate`` and mounts it into the API server container at
    the same path; with the integration unset, NEITHER exists. The envelope
    provider reaches its plugin over a Unix socket in that directory, so without
    the pair encryption at rest cannot come up - and with it granted
    unconditionally every cluster that does not use KMS would carry a host mount
    into its API server for nothing. ``DirectoryOrCreate`` rather than
    ``Directory`` is part of the invariant: on a freshly booted master the
    directory may not exist yet, and ``Directory`` would fail the pod instead of
    creating it.

    PORTS: ``TestKMSIntegration`` (L141-225), both subtests.

    ASSERTION SEMANTICS: ACCUMULATING, AND THIS IS THE ONE BEHAVIOURAL CORRECTION
    THIS MODULE ENCODES. The original's two checks are ``t.Errorf`` (L209 for the
    volume, L221 for the volume mount), not ``t.Fatalf`` - measured, ``grep -c
    't\\.Errorf'`` over the file yields exactly 2. ``t.Errorf`` records the finding
    and CONTINUES, so one Go run reports a missing volume AND a missing mount. The
    two ``subtests`` blocks below reproduce that: each is reported independently
    and a failure in the first does not prevent the second from running. A bare
    ``assert`` on the volume would hide a mount regression behind a volume
    regression - the fidelity loss the AAP forbids - and would also be the wrong
    diagnosis to hand an operator, because the volume and the mount are emitted by
    two different lines of the generator (configure-kubeapiserver.sh:505 and :506)
    and can fail independently.

    HOW "NONE" IS ASSERTED. Go declares ``var gotVolume v1.Volume``, scans for one
    named ``kmssocket`` and compares the result against ``tc.wantVolume`` with
    ``reflect.DeepEqual``; for the unset case that expectation is the ZERO VALUE,
    so the comparison passes precisely when the scan found nothing. The equivalent
    statement - and the clearer one - is that no volume and no mount of that name
    is present, which is what
    :meth:`tests.helpers.manifest.PodSpec.volume` and
    :meth:`tests.helpers.manifest.Container.volume_mount` returning ``None`` for a
    miss are designed to express. Nothing here constructs a zero-valued volume to
    compare against.
    """
    shell_case, _ = _run_generator(
        manifest_case,
        render_kube_env,
        # Go supplies the encoded configuration in BOTH rows (L185): the KMS cases
        # differ only in CLOUD_KMS_INTEGRATION, so the encryption provider is
        # configured either way and the socket is the only variable.
        encryption_provider_config=ENCRYPTION_PROVIDER_CONFIG_B64,
        cloud_kms_integration=case.cloud_kms_integration,
    )
    # By this point the manifest has been decoded and validated against the v1.Pod
    # schema, so it is a valid pod - the same guarantee the Go comment at L198
    # records after mustLoadPodFromManifest.
    pod = shell_case.load_pod_from_manifest()
    container = _apiserver_container(pod)

    # Go L200-206 and L212-218: both searches happen BEFORE either comparison, so
    # neither assertion can be skipped because the other's lookup raised.
    got_volume = pod.spec.volume(KMS_SOCKET_NAME)
    got_volume_mount = container.volume_mount(KMS_SOCKET_NAME)

    # ---- the first t.Errorf (L208-210): the pod volume --------------------
    with subtests.test("volume"):
        want_volume = case.want_volume
        if want_volume is None:
            assert got_volume is None, (
                f"{_RQ}: {case.desc}, so the generated manifest must declare NO volume named "
                f"{KMS_SOCKET_NAME!r}. Granting the KMS host path to a cluster that does not use "
                f"KMS mounts {KMS_SOCKET_PATH} into the API server for nothing. Got "
                f"{got_volume!r}; volumes present: {[v.name for v in pod.spec.volumes]!r}"
            )
        else:
            # The lookup is BY name, so DeepEqual's Name comparison is satisfied
            # by construction and is not restated as a tautological assertion.
            assert got_volume is not None, (
                f"{_RQ}: {case.desc}, so the generated manifest must declare a volume named "
                f"{KMS_SOCKET_NAME!r} (configure-kubeapiserver.sh:506). Without it the envelope "
                "provider has no path to its plugin socket and encryption at rest cannot come up. "
                f"Volumes present: {[v.name for v in pod.spec.volumes]!r}"
            )
            assert got_volume.host_path is not None, (
                f"{_RQ}: {case.desc}, so volume {KMS_SOCKET_NAME!r} must have a hostPath source "
                f"at {want_volume.host_path!r}. It has some other kind of source, which cannot "
                f"expose the plugin's socket from the node. Got {got_volume.raw!r}"
            )
            assert got_volume.host_path.path == want_volume.host_path, (
                f"{_RQ}: {case.desc}, so volume {KMS_SOCKET_NAME!r} must expose host path "
                f"{want_volume.host_path!r}, which is where the KMS plugin creates its socket. "
                f"Got {got_volume.host_path.path!r}"
            )
            assert got_volume.host_path.type == want_volume.host_path_type, (
                f"{_RQ}: {case.desc}, so volume {KMS_SOCKET_NAME!r} must declare hostPath type "
                f"{want_volume.host_path_type!r}. On a freshly booted master "
                f"{want_volume.host_path} may not exist yet, and any stricter type fails the pod "
                f"rather than creating the directory. Got {got_volume.host_path.type!r}"
            )

    # ---- the second t.Errorf (L220-222): the container volume mount -------
    with subtests.test("volumeMount"):
        want_mount = case.want_volume_mount
        if want_mount is None:
            assert got_volume_mount is None, (
                f"{_RQ}: {case.desc}, so container {container.name!r} must have NO volumeMount "
                f"named {KMS_SOCKET_NAME!r}. Got {got_volume_mount!r}; mounts present: "
                f"{[m.name for m in container.volume_mounts]!r}"
            )
        else:
            assert got_volume_mount is not None, (
                f"{_RQ}: {case.desc}, so container {container.name!r} must mount "
                f"{KMS_SOCKET_NAME!r} (configure-kubeapiserver.sh:505). The pod volume alone is "
                "not reachable from inside the container, so the envelope call would still fail. "
                f"Mounts present: {[m.name for m in container.volume_mounts]!r}"
            )
            assert got_volume_mount.mount_path == want_mount.mount_path, (
                f"{_RQ}: {case.desc}, so volumeMount {KMS_SOCKET_NAME!r} must be mounted at "
                f"{want_mount.mount_path!r} - the same path the plugin uses on the host, because "
                "the socket address is absolute on both sides. Got "
                f"{got_volume_mount.mount_path!r}"
            )
            # Go's literal leaves ReadOnly at its zero value and reflect.DeepEqual
            # compares it, so false is pinned rather than unspecified. It is a real
            # requirement: the socket is bidirectional, and a read-only mount would
            # break the envelope call at run time with every other assertion here
            # still passing.
            assert got_volume_mount.read_only == want_mount.read_only, (
                f"{_RQ}: {case.desc}, so volumeMount {KMS_SOCKET_NAME!r} must have "
                f"readOnly={want_mount.read_only!r}. The KMS socket is written to as well as "
                f"read from. Got readOnly={got_volume_mount.read_only!r}"
            )
