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

"""KUBE_HOME layout, template copy and pod-manifest load: the port of ``ManifestTestCase``.

This is the harness the whole shell-boundary tier stands on. Its Go ancestor,
``ManifestTestCase`` in cluster/gce/gci/configure_helper_test.go, contains no
test of its own and is imported by every test in that package; the five ported
modules of tests/unit/shell/ stand in the same relation to this one. What it
does is lay out a throwaway ``KUBE_HOME``, put the shipped pod manifest where
the shipped generator expects to find it, run the generator, and hand back the
manifest the generator produced -- so that a test can assert on the artifact
this repository really ships rather than on a Python paraphrase of it.

THE DIRECTORY LAYOUT IS THE CONTRACT, NOT DECORATION

Every path this module builds is dictated by the script under test, and each one
was read out of the shipped source rather than inferred:

* ``configure-kubeapiserver.sh:299`` reads its input from
  ``${KUBE_HOME}/kube-manifests/kubernetes/gci-trusty``, so
  :attr:`ManifestTestCase.manifest_sources` must be exactly that and must exist
  before the generator runs.
* ``configure-kubeapiserver.sh:393-432`` rewrites that copy IN PLACE with a
  succession of ``sed -i`` substitutions. The copy is therefore consumed
  destructively, which is why a fresh one is made per case and why sharing a
  ``KUBE_HOME`` between two cases would let the first silently corrupt the
  second.
* ``configure-kubeapiserver.sh:435`` copies the finished manifest to
  ``${ETC_MANIFESTS:-/etc/kubernetes/manifests}``, and ``ETC_MANIFESTS`` is set
  by testdata/kube-apiserver/base.template:15 to
  ``${KUBE_HOME}/etc/kubernetes/manifests``. That directory must exist too: the
  script uses ``cp``, which does not create its destination. Get this wrong and
  the generator writes nowhere the assertions can see -- or fails outright --
  and the resulting failure says nothing about the control under test.

TWO TEMPLATE ROOTS, AND THEY ARE NOT THE SAME DIRECTORY

Conflating them is the easiest mistake to make here, so they are named
separately and derived separately:

* THE POD-MANIFEST ROOT is ``<repo>/cluster/gce/manifests``, holding the
  ``kube-apiserver.manifest`` that is copied into ``KUBE_HOME``. Go reaches it
  as ``filepath.Join(filepath.Dir(os.Getwd()), "manifests")``
  (configure_helper_test.go L66-71): the working directory of ``go test`` is the
  package directory ``cluster/gce/gci``, so ``filepath.Dir`` climbs to
  ``cluster/gce`` FIRST and only then appends ``manifests``. Resolving it one
  level too deep -- ``cluster/gce/gci/manifests`` -- yields a directory that
  does not exist, and :func:`pod_manifest_template_dir` reproduces the climb
  literally so the mistake cannot be made silently.
* THE KUBE-ENV TEMPLATE ROOT is the entirely separate
  ``<repo>/cluster/gce/gci/testdata/kube-apiserver/``, holding the trio
  ``base.template``, ``etcd.template`` and ``kms.template`` that render the
  ``kube-env`` file. Those arrive as the variadic ``templates...`` argument of
  ``mustInvokeFunc`` and are named relative to the package directory, exactly as
  the Go tests write them.

Both roots are derived from a ``repo_root`` the CALLER supplies. This module
calls neither ``os.getcwd()`` nor reads ``__file__``: python/tests/conftest.py
owns the ``repo_root`` fixture, and a helper that computed its own answer could
disagree with the fixture everything else uses.

FOUR SHIPPED ARTIFACTS ARE CONSUMED AS-IS AND NEVER DUPLICATED

``cluster/gce/manifests/kube-apiserver.manifest`` and the three
``testdata/kube-apiserver/*.template`` files are read-only inputs. They are
referenced by path, copied only into a throwaway ``KUBE_HOME``, and never
reproduced under python/. Two independent reasons, either sufficient:

* a duplicate would drift from the artifact this repository actually ships,
  while both the copy and the original kept passing their own assertions;
* ``testdata`` is one of ``skipped_names`` in hack/boilerplate/boilerplate.py,
  so the originals are exempt from the Apache-2.0 header gate. A copy under
  python/ would be walked and gated, and would have to carry a header the
  original does not -- guaranteeing the two differ from the first commit.

The same rule covers the scripts: ``configure-helper.sh`` and
``configure-kubeapiserver.sh`` are invoked, never edited and never rewritten in
Python.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

It does not implement a template language. Go renders ``kube-env`` with
``text/template``; the Jinja2 port of that renderer is
python/tests/fixtures/templates/kube_env.j2, owned by the sibling fixtures
package. :meth:`ManifestTestCase.create_env` therefore takes a
:class:`KubeEnvRenderer` the caller supplies, and
:meth:`ManifestTestCase.write_env_script` takes already-rendered text. Owning
the template language here would put two copies of it in the tree.

It does not run subprocesses itself. tests/helpers/bash.py is the single
boundary at which this tier meets ``bash``, and it owns the timeout, the
environment copy, the stream handling and the two distinct failure postures.
:meth:`ManifestTestCase.run_func` delegates to its ``must_invoke_func``.
Re-implementing ``subprocess.run`` here would fork behaviour that exists to be
shared.

It adds no environment defaulting, no sanitising and no "helpful" variable
injection. What the caller supplies is exactly what the shipped script sees.
This is load-bearing rather than fastidious: ``TestTLSFlags``'s "mTLS disabled"
case renders its ``kube-env`` from an EMPTY environment and expects the
plaintext endpoint ``--etcd-servers=http://127.0.0.1:2379``, which is reachable
only because ``configure-etcd-params`` carries a function-local ``:-true``
compatibility shim for direct unit-test invocation. The separate V8 fail-closed
module proves that the same absent-credential condition exits 1 in the
deployment path. Both truths must hold at once, and a single injected default
here would quietly break the first.

It declares no pytest fixture. ``kube_home``, ``render_kube_env`` and
``manifest_case`` belong to tests/unit/shell/conftest.py, which wraps this
module -- because a module-, package- or session-scoped autouse fixture declared
inline in an ordinary module can execute twice under ``--doctest-modules``.

It declares no test, so it contributes nothing to collection, and it imports
nothing but the standard library and tests.helpers.bash, which is what keeps the
shell tier runnable with a bash interpreter and no etcd, no API server and no
network.
"""

# AAP §0.5.1 (the python/tests/helpers/manifest.py row: "KUBE_HOME layout,
# template copy, pod-manifest load", source cluster/gce/gci/
# configure_helper_test.go ManifestTestCase) / §0.4.2.1 (the L1 shell-boundary
# blueprints, whose five modules all reach the shipped generator through this
# harness) / §0.4.4.2, which states that
# cluster/gce/gci/testdata/kube-apiserver/{base,etcd,kms}.template are
# "Referenced, not copied" and "must never be duplicated into Python, because a
# duplicate would silently diverge from the artifact actually shipped" /
# tech-spec §6.6.1.1, which records the property the tier exists to preserve:
# the test "proves the shipped shell generator, not a re-implementation".
#
# INVARIANT LOCKED BY THIS FILE: the KUBE_HOME layout the shipped generator
# reads and writes is reproduced EXACTLY (sources at
# kube-manifests/kubernetes/gci-trusty, destination at
# etc/kubernetes/manifests); the pod-manifest root and the kube-env template
# root stay DISTINCT and are both derived from a caller-supplied repository
# root; the four shipped artifacts are consumed as-is and never duplicated; a
# setup failure RAISES rather than degrading into a later, less legible one (the
# t.Fatalf posture); and every case gets its own KUBE_HOME, removed on teardown
# even when the test fails, so the tier is safe under pytest-xdist and
# pytest-randomly.

import contextlib
import json
import os
import shutil
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final, Protocol

from tests.helpers.bash import CONFIGURE_HELPER_SCRIPT, BashResult, must_invoke_func

__all__ = [
    "BASE_TEMPLATE_RELATIVE_PATH",
    "ENV_SCRIPT_FILE_NAME",
    "ETCD_TEMPLATE_RELATIVE_PATH",
    "ETCD_TEMPLATE_TARGET",
    "GCI_PACKAGE_RELATIVE_PATH",
    "KMS_TEMPLATE_RELATIVE_PATH",
    "KMS_TEMPLATE_TARGET",
    "KUBE_APISERVER_CONFIG_SCRIPT_NAME",
    "KUBE_APISERVER_MANIFEST_FILE_NAME",
    "KUBE_APISERVER_SCRIPT_NAMES",
    "KUBE_APISERVER_START_FUNC_NAME",
    "KUBE_ENV_TEMPLATE_RELATIVE_DIR",
    "MANIFEST_DESTINATION_RELATIVE_PATH",
    "MANIFEST_SOURCES_RELATIVE_PATH",
    "POD_MANIFEST_DIR_NAME",
    "TEMP_DIR_PREFIX",
    "Container",
    "HostPathVolumeSource",
    "KubeEnvRenderer",
    "ManifestHarnessError",
    "ManifestTestCase",
    "PodManifest",
    "PodSpec",
    "Volume",
    "VolumeMount",
    "gci_package_dir",
    "manifest_test_case",
    "parse_pod_manifest",
    "pod_manifest_template_dir",
    "run_as_user",
]

# ---------------------------------------------------------------------------
# Constants ported from the Go package
# ---------------------------------------------------------------------------
# Each is the Python spelling of a Go identifier, cited beside it. The VALUES
# are dictated by the shipped scripts and templates; renaming a Python constant
# is safe, changing a value is not.

# Go: `envScriptFileName`, configure_helper_test.go L34. The file mustCreateEnv
# writes into KUBE_HOME and mustInvokeFunc sources first. The name matters to
# nothing but the two of them -- the scripts read the VARIABLES it defines, not
# the file -- so it is kept identical for continuity with the Go harness and
# with anyone reading a failure message from either suite.
ENV_SCRIPT_FILE_NAME: Final[str] = "kube-env"

# Go: `kubeAPIServerManifestFileName`, apiserver_kms_test.go L34. Both the name
# of the shipped pod manifest under cluster/gce/manifests/ and the name
# configure-kubeapiserver.sh:380 expects inside the sources directory.
KUBE_APISERVER_MANIFEST_FILE_NAME: Final[str] = "kube-apiserver.manifest"

# Go: `kubeAPIServerConfigScriptName`, apiserver_kms_test.go L35. Sourced
# SECOND, after configure-helper.sh, and named relatively so it resolves against
# the package directory exactly as it does for `go test`.
KUBE_APISERVER_CONFIG_SCRIPT_NAME: Final[str] = "configure-kubeapiserver.sh"

# Go: `kubeAPIServerStartFuncName`, apiserver_kms_test.go L36. The shell
# function every ported apiserver case invokes; it is the function that performs
# the substitutions and the final copy.
KUBE_APISERVER_START_FUNC_NAME: Final[str] = "start-kube-apiserver"

# The script list every apiserver consumer passes, in ORDER, as
# `[]string{"configure-helper.sh", kubeAPIServerConfigScriptName}` -- see
# apiserver_etcd_test.go L78, L135, L200 and apiserver_kms_test.go L83, L119,
# L191. Order is load-bearing: configure-kubeapiserver.sh calls functions
# defined by configure-helper.sh, so sourcing it first leaves them undefined.
# `configure-helper.sh` is taken from tests.helpers.bash rather than restated,
# so the two modules cannot drift on the spelling of the same script.
KUBE_APISERVER_SCRIPT_NAMES: Final[tuple[str, str]] = (
    CONFIGURE_HELPER_SCRIPT,
    KUBE_APISERVER_CONFIG_SCRIPT_NAME,
)

# Go: the prefix of `os.MkdirTemp("", "configure-helper-test")`,
# configure_helper_test.go L58. Retained so a leaked directory is attributable
# to this tier no matter which language created it.
TEMP_DIR_PREFIX: Final[str] = "configure-helper-test"

# Go: configure_helper_test.go L64, and the directory
# configure-kubeapiserver.sh:299 reads its input from. Held as path SEGMENTS
# rather than a string so joining cannot go wrong on any platform.
MANIFEST_SOURCES_RELATIVE_PATH: Final[tuple[str, str, str]] = (
    "kube-manifests",
    "kubernetes",
    "gci-trusty",
)

# Go: configure_helper_test.go L73 and L102, and the value base.template:15
# gives ETC_MANIFESTS. configure-kubeapiserver.sh:435 copies the finished
# manifest here with `cp`, which does not create its destination, so the
# directory is created during setup.
MANIFEST_DESTINATION_RELATIVE_PATH: Final[tuple[str, str, str]] = (
    "etc",
    "kubernetes",
    "manifests",
)

# The Go package directory, relative to the repository root. It is the working
# directory `go test` uses, and therefore the working directory the ported
# invocations must use: the scripts and the templates are all named relative to
# it.
GCI_PACKAGE_RELATIVE_PATH: Final[tuple[str, str, str]] = ("cluster", "gce", "gci")

# The final segment of the POD-MANIFEST root, appended to the PARENT of the
# package directory -- `filepath.Join(filepath.Dir(currentPath), "manifests")`,
# configure_helper_test.go L70-71. Named apart from
# :data:`GCI_PACKAGE_RELATIVE_PATH` because the two are joined to different
# bases, which is exactly the confusion this module refuses to make possible.
POD_MANIFEST_DIR_NAME: Final[str] = "manifests"

# ---------------------------------------------------------------------------
# The kube-env template trio: PATH REFERENCES ONLY
# ---------------------------------------------------------------------------
# These name the three shipped templates as the Go tests name them -- relative
# to the package directory -- and nothing here reproduces their CONTENT. The
# files are read by the caller's renderer, never copied into python/ and never
# edited.

# The directory holding the trio, relative to the package directory.
KUBE_ENV_TEMPLATE_RELATIVE_DIR: Final[str] = "testdata/kube-apiserver"

# Go: "testdata/kube-apiserver/base.template", passed first in every consumer.
# It defines a template named `base` (`{{define "base"}}` ... `{{end}}`) which
# the other two invoke; it is never itself the render TARGET, which is why no
# target constant accompanies it.
BASE_TEMPLATE_RELATIVE_PATH: Final[str] = f"{KUBE_ENV_TEMPLATE_RELATIVE_DIR}/base.template"

# Go: "testdata/kube-apiserver/etcd.template", the sixteen-field etcd
# environment used by TestServerOverride, TestStorageOptions and TestTLSFlags.
ETCD_TEMPLATE_RELATIVE_PATH: Final[str] = f"{KUBE_ENV_TEMPLATE_RELATIVE_DIR}/etcd.template"

# Go: "testdata/kube-apiserver/kms.template", the five-field encryption
# environment used by TestEncryptionProviderFlag, TestEncryptionProviderConfig
# and TestKMSIntegration.
KMS_TEMPLATE_RELATIVE_PATH: Final[str] = f"{KUBE_ENV_TEMPLATE_RELATIVE_DIR}/kms.template"

# The render TARGETS, and they are template NAMES rather than paths. Go's
# `template.ParseFiles` names each parsed template after its base filename, so
# `mustCreateEnv`'s `target` argument is "etcd.template" or "kms.template" --
# the file's BASENAME, not the path that was parsed. Keeping the two kinds of
# string separate is why :meth:`ManifestTestCase.create_env` takes a target and
# a list of template paths as distinct arguments.
ETCD_TEMPLATE_TARGET: Final[str] = "etcd.template"
KMS_TEMPLATE_TARGET: Final[str] = "kms.template"


class ManifestHarnessError(AssertionError):
    """A setup, render or load step of the manifest harness failed.

    Every ``must*`` method of the Go harness ends in ``t.Fatalf``: a harness that
    could not lay out its ``KUBE_HOME``, could not copy the shipped manifest or
    could not decode what the generator produced has invalidated every later
    assertion in that test, so it stops the test rather than letting it fail
    somewhere less informative. This exception is that posture.

    It subclasses ``AssertionError`` for the same reason
    ``tests.helpers.bash.BashInvocationError`` does, and the two are
    interchangeable to a caller for exactly that reason: raised plainly it aborts
    the test, which is ``t.Fatalf``; raised inside ``with subtests.test(...)`` it
    is caught by pytest's subtests fixture, reported as that one case, and the
    surrounding loop continues, which is ``t.Errorf``. One raise serves both
    postures, so a bespoke hierarchy would have cost the second.
    """


class KubeEnvRenderer(Protocol):
    """Renders one ``kube-env`` script. Supplied by the caller, never owned here.

    The contract of Go's two-step render (configure_helper_test.go L132-139)::

        t, err := template.ParseFiles(templates...)
        err = t.ExecuteTemplate(f, target, env)

    collapsed into one call. The three arguments are positional-only, so any
    three-parameter callable conforms whatever it names its parameters -- which
    matters because the implementation is a pytest fixture
    (``render_kube_env`` in tests/unit/shell/conftest.py) built on
    tests/fixtures/templates/kube_env.j2, and a Protocol that pinned the names
    would dictate that fixture's internals.

    Args:
        target: The template NAME to render, ``"etcd.template"`` or
            ``"kms.template"``. A name, not a path: Go names each parsed template
            after its base filename, and the target selects among the parsed set.
        templates: ABSOLUTE paths of the template files to parse, in the order
            the caller listed them -- ``base.template`` first, since the other
            two invoke the ``base`` template it defines. Already resolved and
            already confirmed to exist by :meth:`ManifestTestCase.create_env`,
            so an implementation may open them directly.
        context: The render data, keyed by the EXPORTED GO FIELD NAMES the
            shipped templates dereference (``KubeHome``,
            ``KubeAPIServerRunAsUser``, ``ETCDServers``, ``CloudKMSIntegration``
            and so on). Values are ``object`` rather than ``str`` on purpose:
            ``kms.template`` guards a block with ``{{if .CloudKMSIntegration}}``,
            and a bool stringified on the way to the renderer would be a
            non-empty string, which Go template truthiness counts as TRUE -- so
            the block would render for a case that switched the integration off.

    Returns:
        The rendered script text, written verbatim to ``KUBE_HOME/kube-env``.
    """

    def __call__(
        self,
        target: str,
        templates: Sequence[Path],
        context: Mapping[str, object],
        /,
    ) -> str:
        """Render ``target`` from ``templates`` with ``context``."""
        ...


def run_as_user() -> str:
    """Return the current uid as a string: the port of ``strconv.Itoa(os.Getuid())``.

    Every consumer sets ``env.KubeAPIServerRunAsUser`` to this immediately before
    rendering (apiserver_etcd_test.go L74, L131, L196; apiserver_kms_test.go
    L76, L112, L183), because the generated pod manifest carries a
    ``"runAsUser"`` taken from ``KUBE_API_SERVER_RUNASUSER`` and the value has to
    be one that exists on the machine running the test.

    A FUNCTION rather than a module-level constant, deliberately. A constant
    would freeze the uid at import time, which is both a module-level piece of
    ambient state and wrong the moment a caller drops privileges between import
    and invocation. Go re-reads it at every call site; so does this.
    """
    return str(os.getuid())


def gci_package_dir(repo_root: str | os.PathLike[str]) -> Path:
    """Return ``<repo_root>/cluster/gce/gci``: the working directory the scripts need.

    This is the directory ``go test`` runs the package in, and therefore the
    ``cwd`` every ported invocation must use. Both the script names
    (``configure-helper.sh``, ``configure-kubeapiserver.sh``) and the template
    paths (``testdata/kube-apiserver/...``) are written relative to it by the Go
    tests, and they are kept relative here so the same strings keep working.

    ``repo_root`` is a parameter rather than something computed from
    ``os.getcwd()`` or ``__file__``: python/tests/conftest.py owns the
    ``repo_root`` fixture, and a second, independent derivation could disagree
    with it.

    Args:
        repo_root: The repository root.

    Returns:
        The absolute, resolved package directory.

    Raises:
        ManifestHarnessError: if the directory does not exist, which means
            ``repo_root`` is not a checkout of this repository. Reported here
            rather than left to a later "No such file or directory" from bash,
            because a wrong root produces a cascade of unrelated-looking
            failures.
    """
    __tracebackhide__ = True
    package_dir = Path(repo_root).resolve() / Path(*GCI_PACKAGE_RELATIVE_PATH)
    if not package_dir.is_dir():
        raise ManifestHarnessError(
            f"the Go package directory {package_dir} does not exist: repo_root "
            f"{os.fspath(repo_root)!r} does not look like a checkout of this repository. "
            "The shipped scripts and the kube-env templates are named RELATIVE to "
            "cluster/gce/gci, so nothing in the shell tier can run without it."
        )
    return package_dir


def pod_manifest_template_dir(repo_root: str | os.PathLike[str]) -> Path:
    """Return ``<repo_root>/cluster/gce/manifests``: the POD-MANIFEST template root.

    Ports ``manifestTemplateDir`` (configure_helper_test.go L66-71) and
    reproduces its derivation literally -- climb from the package directory to
    its PARENT, then append ``manifests``::

        gceDir := filepath.Dir(currentPath)              // cluster/gce
        c.manifestTemplateDir = filepath.Join(gceDir, "manifests")

    INVARIANT PRESERVED: the result is ``cluster/gce/manifests`` and never
    ``cluster/gce/gci/manifests``. Those are different directories and only the
    first exists; resolving one level too deep is the classic failure in this
    port, so the climb is written out here once instead of being open-coded at
    each call site. This root holds the pod manifest that is COPIED into
    ``KUBE_HOME``; the kube-env templates live somewhere else entirely, under
    ``cluster/gce/gci/testdata/kube-apiserver/``.

    Args:
        repo_root: The repository root.

    Returns:
        The absolute, resolved pod-manifest template directory.

    Raises:
        ManifestHarnessError: if the package directory does not exist, or if the
            derived root is not a directory.
    """
    __tracebackhide__ = True
    # .parent is filepath.Dir of the package directory: cluster/gce, NOT
    # cluster/gce/gci. The name of the local mirrors the Go local for the sake
    # of anyone reading the two side by side.
    gce_dir = gci_package_dir(repo_root).parent
    template_dir = gce_dir / POD_MANIFEST_DIR_NAME
    if not template_dir.is_dir():
        raise ManifestHarnessError(
            f"the pod-manifest template directory {template_dir} does not exist. It is "
            "derived as the PARENT of cluster/gce/gci plus 'manifests' -- that is, "
            "cluster/gce/manifests, which is NOT cluster/gce/gci/manifests."
        )
    return template_dir


# ---------------------------------------------------------------------------
# The generated pod manifest, as the assertions need to see it
# ---------------------------------------------------------------------------
# Go decodes the generated file into a real `v1.Pod`:
#
#   runtime.DecodeInto(legacyscheme.Codecs.UniversalDecoder(), json, &c.pod)
#   (configure_helper_test.go L150)
#
# and TestKMSIntegration records what that buys -- "By this point, we can be sure
# that kube-apiserver manifest is a valid POD" (apiserver_kms_test.go L198).
#
# The port deliberately does NOT use the Kubernetes Python client for this. The
# shell tier must stay runnable with a bash interpreter and nothing else -- no
# etcd, no API server, no network, and no API-client pin -- and pulling
# `kubernetes` in here would make the tier's importability depend on a
# distribution none of its assertions need. What the consumers actually require
# of the decoded pod is three shapes, no more:
#
#   1. " ".join(pod.Spec.Containers[0].Command)   -- substring want / dontWant
#      (apiserver_etcd_test.go L85-90, L142-153, L207-212)
#   2. pod.Spec.Volumes, searched by name         -- kmssocket
#      (apiserver_kms_test.go L200-210)
#   3. pod.Spec.Containers[0].VolumeMounts, by name
#      (apiserver_kms_test.go L212-222)
#
# So the JSON is parsed with the standard library and wrapped in the small typed
# views below, which cover exactly those three shapes and carry the untouched
# mapping alongside for anything else a future assertion needs. The structural
# validation the decoder performed is kept as explicit checks, because a
# generator that emitted something that is not a Pod must fail loudly here rather
# than surface as a puzzling KeyError later.


def _frozen(mapping: Mapping[str, object]) -> Mapping[str, object]:
    """Return a read-only VIEW of ``mapping``, so a parsed manifest cannot be edited.

    The views below are frozen dataclasses; a plainly mutable ``raw`` dict inside
    one would undermine that, since a test could edit what a later assertion
    reads. Nested containers are left exactly as parsed -- deep-freezing JSON
    would buy nothing here, because each case parses its own file.
    """
    return MappingProxyType(dict(mapping))


def _require_mapping(value: object, *, field: str, source: str) -> Mapping[str, object]:
    """Return ``value`` as a JSON object, or raise naming the field and the file."""
    __tracebackhide__ = True
    if not isinstance(value, dict):
        raise ManifestHarnessError(
            f"generated manifest {source} is not a valid Pod: {field} should be a JSON "
            f"object, got {type(value).__name__}"
        )
    return value


def _require_list(value: object, *, field: str, source: str) -> list[object]:
    """Return ``value`` as a JSON array, or raise naming the field and the file."""
    __tracebackhide__ = True
    if not isinstance(value, list):
        raise ManifestHarnessError(
            f"generated manifest {source} is not a valid Pod: {field} should be a JSON "
            f"array, got {type(value).__name__}"
        )
    return value


def _require_str(value: object, *, field: str, source: str) -> str:
    """Return ``value`` as a string, or raise naming the field and the file."""
    __tracebackhide__ = True
    if not isinstance(value, str):
        raise ManifestHarnessError(
            f"generated manifest {source} is not a valid Pod: {field} should be a string, "
            f"got {type(value).__name__}"
        )
    return value


@dataclass(frozen=True)
class HostPathVolumeSource:
    """A ``hostPath`` volume source: the port of ``v1.HostPathVolumeSource``.

    ``TestKMSIntegration`` asserts on both fields of the ``kmssocket`` volume --
    the path ``/var/run/kmsplugin`` and the type ``DirectoryOrCreate``, which the
    Go case builds as ``&dirOrCreate`` from
    ``v1.HostPathType(v1.HostPathDirectoryOrCreate)`` (apiserver_kms_test.go
    L143-145, L159-162).

    Attributes:
        path: The host path. Always present in the shipped manifest.
        type: The host-path type, or ``None`` when the key is absent -- the
            analogue of Go's nil ``*HostPathType``. Several volumes in
            cluster/gce/manifests/kube-apiserver.manifest legitimately omit it
            (``srvkube``, ``etcssl``), so ``None`` is a real value and not an
            error.
        raw: The volume source exactly as parsed, read-only.
    """

    path: str
    type: str | None
    raw: Mapping[str, object]


@dataclass(frozen=True)
class VolumeMount:
    """A container volume mount: the port of ``v1.VolumeMount``.

    ``TestKMSIntegration`` compares the mount found by name against
    ``v1.VolumeMount{Name: socketName, MountPath: socketPath}``
    (apiserver_kms_test.go L165-168) -- so name and mount path are what the
    assertion needs, and ``read_only`` is carried because the generated JSON
    states it explicitly (configure-kubeapiserver.sh:505 emits
    ``"readOnly": false``).

    Attributes:
        name: The mount name, which is the name of the volume it mounts.
        mount_path: The path inside the container.
        read_only: Whether the mount is read-only. ``False`` when the key is
            absent, matching Go's zero value.
        raw: The mount exactly as parsed, read-only.
    """

    name: str
    mount_path: str
    read_only: bool
    raw: Mapping[str, object]


@dataclass(frozen=True)
class Volume:
    """A pod volume: the port of ``v1.Volume``.

    Attributes:
        name: The volume name.
        host_path: The ``hostPath`` source, or ``None`` if the volume has another
            kind of source. Every volume in the shipped manifest is a
            ``hostPath``, so ``None`` here means the generated manifest changed
            shape -- which is a finding, not something to paper over.
        raw: The volume exactly as parsed, read-only. Anything a future
            assertion needs beyond name and host path is reachable through this.
    """

    name: str
    host_path: HostPathVolumeSource | None
    raw: Mapping[str, object]


@dataclass(frozen=True)
class Container:
    """A pod container: the port of the ``v1.Container`` fields the consumers read.

    Attributes:
        name: The container name, ``kube-apiserver`` for the one container the
            generated manifest defines.
        command: The command, as a tuple so the view stays immutable. The port of
            ``v1.Container.Command``; an absent key yields an empty tuple, which
            is Go's nil slice.
        volume_mounts: The container's volume mounts, in manifest order.
        raw: The container exactly as parsed, read-only.
    """

    name: str
    command: tuple[str, ...]
    volume_mounts: tuple[VolumeMount, ...]
    raw: Mapping[str, object]

    @property
    def command_line(self) -> str:
        """The command joined by single spaces: ``strings.Join(..., " ")``.

        The exact string every flag assertion in the ported etcd and KMS modules
        is written against -- ``execArgs`` in the Go originals
        (apiserver_etcd_test.go L85, L142, L207; apiserver_kms_test.go L89).

        INVARIANT PRESERVED: joining and then testing for a SUBSTRING is what
        makes ``dontWant`` meaningful. ``TestStorageOptions``'s second case
        asserts that ``--storage-backend`` appears nowhere at all
        (apiserver_etcd_test.go L118-122), which is an assertion about the whole
        command line rather than about any single argument, so the join must
        happen before the search and the separator must be a single space.
        """
        return " ".join(self.command)

    def volume_mount(self, name: str) -> VolumeMount | None:
        """Return the mount called ``name``, or ``None`` if there is none.

        Ports the search of ``TestKMSIntegration`` (apiserver_kms_test.go
        L212-218), which walks ``VolumeMounts`` and keeps the first entry whose
        name matches.

        INVARIANT PRESERVED: absence is reported as ``None`` rather than as an
        error, because absence is what one of the two cases asserts. With
        ``CLOUD_KMS_INTEGRATION`` unset the Go test leaves ``gotVolumeMount`` at
        its zero value and compares it against a zero-value expectation, so
        "there is no kmssocket mount" is a PASS there. A lookup that raised on a
        miss could not express that case.
        """
        for mount in self.volume_mounts:
            if mount.name == name:
                return mount
        return None


@dataclass(frozen=True)
class PodSpec:
    """A pod spec: the port of the ``v1.PodSpec`` fields the consumers read.

    Attributes:
        containers: The containers, in manifest order. The consumers read
            ``containers[0]``.
        volumes: The pod volumes, in manifest order.
        raw: The spec exactly as parsed, read-only -- ``securityContext``,
            ``hostNetwork``, ``priorityClassName`` and everything else the
            generated manifest carries is reachable here without widening this
            view.
    """

    containers: tuple[Container, ...]
    volumes: tuple[Volume, ...]
    raw: Mapping[str, object]

    def volume(self, name: str) -> Volume | None:
        """Return the volume called ``name``, or ``None`` if there is none.

        Ports the search of ``TestKMSIntegration`` (apiserver_kms_test.go
        L200-206). ``None`` for a miss for the same reason as
        :meth:`Container.volume_mount`: the negative case asserts absence.
        """
        for volume in self.volumes:
            if volume.name == name:
                return volume
        return None


@dataclass(frozen=True)
class PodManifest:
    """A decoded static-pod manifest: the port of ``ManifestTestCase.pod``.

    Attributes:
        api_version: The manifest's ``apiVersion``, ``v1``.
        kind: The manifest's ``kind``, ``Pod``.
        spec: The pod spec.
        raw: The whole document exactly as parsed, read-only, so ``metadata`` and
            anything else is reachable without widening these views.
    """

    api_version: str
    kind: str
    spec: PodSpec
    raw: Mapping[str, object]


def _parse_host_path(
    value: object,
    *,
    field: str,
    source: str,
) -> HostPathVolumeSource:
    """Parse one ``hostPath`` volume source."""
    __tracebackhide__ = True
    raw = _require_mapping(value, field=field, source=source)
    host_type = raw.get("type")
    return HostPathVolumeSource(
        path=_require_str(raw.get("path"), field=f"{field}.path", source=source),
        # Absent means Go's nil *HostPathType. Present-but-not-a-string is a
        # malformed manifest and is reported rather than coerced.
        type=None
        if host_type is None
        else _require_str(host_type, field=f"{field}.type", source=source),
        raw=_frozen(raw),
    )


def _parse_volume(value: object, *, field: str, source: str) -> Volume:
    """Parse one entry of ``spec.volumes``."""
    __tracebackhide__ = True
    raw = _require_mapping(value, field=field, source=source)
    host_path = raw.get("hostPath")
    return Volume(
        name=_require_str(raw.get("name"), field=f"{field}.name", source=source),
        host_path=None
        if host_path is None
        else _parse_host_path(host_path, field=f"{field}.hostPath", source=source),
        raw=_frozen(raw),
    )


def _parse_volume_mount(value: object, *, field: str, source: str) -> VolumeMount:
    """Parse one entry of ``spec.containers[*].volumeMounts``."""
    __tracebackhide__ = True
    raw = _require_mapping(value, field=field, source=source)
    read_only = raw.get("readOnly", False)
    if not isinstance(read_only, bool):
        raise ManifestHarnessError(
            f"generated manifest {source} is not a valid Pod: {field}.readOnly should be a "
            f"boolean, got {type(read_only).__name__}"
        )
    return VolumeMount(
        name=_require_str(raw.get("name"), field=f"{field}.name", source=source),
        mount_path=_require_str(raw.get("mountPath"), field=f"{field}.mountPath", source=source),
        read_only=read_only,
        raw=_frozen(raw),
    )


def _parse_container(value: object, *, field: str, source: str) -> Container:
    """Parse one entry of ``spec.containers``."""
    __tracebackhide__ = True
    raw = _require_mapping(value, field=field, source=source)

    # An absent `command` is Go's nil slice, which joins to the empty string. A
    # present one must be an array of STRINGS, because v1.Container.Command is
    # []string and the decoder would reject anything else; a number left in there
    # by a botched substitution has to be a failure, not a silently stringified
    # argument.
    command_field = f"{field}.command"
    command_raw = raw.get("command", [])
    command = tuple(
        _require_str(entry, field=f"{command_field}[{index}]", source=source)
        for index, entry in enumerate(
            _require_list(command_raw, field=command_field, source=source)
        )
    )

    mounts_field = f"{field}.volumeMounts"
    mounts_raw = raw.get("volumeMounts", [])
    volume_mounts = tuple(
        _parse_volume_mount(entry, field=f"{mounts_field}[{index}]", source=source)
        for index, entry in enumerate(_require_list(mounts_raw, field=mounts_field, source=source))
    )

    return Container(
        name=_require_str(raw.get("name"), field=f"{field}.name", source=source),
        command=command,
        volume_mounts=volume_mounts,
        raw=_frozen(raw),
    )


def parse_pod_manifest(text: str, *, source: str | os.PathLike[str] = "<manifest>") -> PodManifest:
    """Decode a generated static-pod manifest into the typed views above.

    Ports the decode half of ``mustLoadPodFromManifest``
    (cluster/gce/gci/configure_helper_test.go L144-153)::

        json, err := os.ReadFile(c.manifestDestination)
        runtime.DecodeInto(legacyscheme.Codecs.UniversalDecoder(), json, &c.pod)

    INVARIANT PRESERVED: decoding is a real check, not a convenience. Go's
    decoder rejects a document that is not a ``v1.Pod``, which is what licenses
    the comment in ``TestKMSIntegration`` -- "By this point, we can be sure that
    kube-apiserver manifest is a valid POD" (apiserver_kms_test.go L198). That
    guarantee is retained by asserting the envelope explicitly here, so a
    generator that emitted a truncated or non-Pod document fails on this line,
    naming the file, rather than three assertions later with a ``KeyError``.

    ``apiVersion``/``kind`` are checked rather than merely read because the
    substitutions the generator performs are textual: an unsubstituted
    ``{{placeholder}}`` or a stray comma yields a document that is either invalid
    JSON or not a Pod, and both are findings about the shipped script.

    Public because it is useful without a bash run: a test can hand it the bytes
    of a manifest from anywhere, and it makes this module's own behaviour
    provable without a subprocess.

    Args:
        text: The manifest text, which is JSON. The shipped template
            cluster/gce/manifests/kube-apiserver.manifest is JSON, and the
            generator only substitutes into it, so the output is JSON too.
        source: Path or label to name in any failure message. Defaults to a
            placeholder for callers parsing text that has no path.

    Returns:
        The decoded :class:`PodManifest`.

    Raises:
        ManifestHarnessError: if the text is not JSON, is not a JSON object, is
            not a ``v1`` ``Pod``, has no ``spec``, has no container, or has a
            field of the wrong JSON type.
    """
    __tracebackhide__ = True
    described = os.fspath(source)

    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        # Go prints the whole document on a decode failure ("Failed to decode
        # manifest:\n%s\nerror: %v"), and so does this: when a textual
        # substitution has gone wrong, the only useful diagnostic is the text
        # that resulted. Truncating it would cost a second run to recover.
        raise ManifestHarnessError(
            f"failed to decode generated manifest {described} as JSON: {exc}\n"
            f"manifest text was:\n{text}"
        ) from exc

    root = _require_mapping(document, field="the document", source=described)
    api_version = _require_str(root.get("apiVersion"), field="apiVersion", source=described)
    kind = _require_str(root.get("kind"), field="kind", source=described)
    if (api_version, kind) != ("v1", "Pod"):
        raise ManifestHarnessError(
            f"generated manifest {described} is not a v1 Pod: got apiVersion={api_version!r} "
            f"kind={kind!r}. The shipped template declares apiVersion v1 and kind Pod, and the "
            "generator only substitutes into it, so anything else means the substitutions "
            "corrupted the document."
        )

    spec_raw = _require_mapping(root.get("spec"), field="spec", source=described)
    containers = tuple(
        _parse_container(entry, field=f"spec.containers[{index}]", source=described)
        for index, entry in enumerate(
            _require_list(spec_raw.get("containers", []), field="spec.containers", source=described)
        )
    )
    if not containers:
        # Every consumer reads Containers[0]. Reporting the empty list here names
        # the cause; letting it through would surface as an IndexError inside
        # whichever assertion happened to run first.
        raise ManifestHarnessError(
            f"generated manifest {described} declares no container, but every assertion in the "
            "shell tier reads spec.containers[0] -- the generated manifest is unusable."
        )

    volumes = tuple(
        _parse_volume(entry, field=f"spec.volumes[{index}]", source=described)
        for index, entry in enumerate(
            _require_list(spec_raw.get("volumes", []), field="spec.volumes", source=described)
        )
    )

    return PodManifest(
        api_version=api_version,
        kind=kind,
        spec=PodSpec(containers=containers, volumes=volumes, raw=_frozen(spec_raw)),
        raw=_frozen(root),
    )


def _require_bare_filename(name: str, *, what: str) -> str:
    """Reject an empty name or one carrying a path separator.

    Both the Go harness and this port join these names into ``KUBE_HOME`` paths
    and into the sources directory the shipped script reads. A name containing a
    separator would place the file somewhere the generator does not look -- or,
    with ``..``, outside ``KUBE_HOME`` entirely, where teardown would not remove
    it. Every real value is a bare filename such as ``kube-apiserver.manifest``.
    """
    __tracebackhide__ = True
    if not name or name != Path(name).name:
        raise ManifestHarnessError(
            f"{what} must be a bare filename with no path separator, got {name!r}. It is "
            "joined into KUBE_HOME and into the sources directory the shipped generator "
            "reads, so a path here would write outside the tree the case owns."
        )
    return name


class ManifestTestCase:
    """One throwaway ``KUBE_HOME`` and the shipped generator run against it.

    The port of ``ManifestTestCase`` and its constructor ``newManifestTestCase``
    (cluster/gce/gci/configure_helper_test.go L37-106). Constructing one performs
    the whole of the Go constructor's work, in the same order:

    1. obtain a ``KUBE_HOME`` (L58-63);
    2. compute the sources and destination paths and the pod-manifest template
       path (L64-73);
    3. ``mustCopyFromTemplate`` -- create the sources directory and copy the
       shipped pod manifest into it (L75, L82-90);
    4. ``mustCopyAuxFromTemplate`` -- copy any auxiliary manifests (L76, L92-99);
    5. ``mustCreateManifestDstDir`` -- create the destination directory the
       generator's final ``cp`` needs (L77, L101-106).

    A ``KUBE_HOME`` PER CASE, never shared, and removed by :meth:`tear_down`
    whether the test passed or failed -- which is why
    :func:`manifest_test_case` is the recommended entry point: its ``finally``
    is the analogue of Go's ``defer c.tearDown()``. Sharing one between cases
    would not merely be untidy: ``configure-kubeapiserver.sh`` rewrites the
    copied manifest IN PLACE with ``sed -i``, so the second case would read what
    the first left behind. Isolation here is what makes the tier safe under
    ``pytest-xdist -n auto`` and meaningful under ``pytest-randomly``.

    THE FAILURE POSTURE IS GO'S. Every step above is a ``must*`` method ending
    in ``t.Fatalf``, and every one of them raises :class:`ManifestHarnessError`
    here. Nothing degrades to a warning: a harness that could not put the
    manifest where the generator reads it has invalidated every assertion that
    follows.

    Typical use, mirroring apiserver_etcd_test.go L71-90::

        with manifest_test_case(
            repo_root=repo_root,
            manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
            func_name=KUBE_APISERVER_START_FUNC_NAME,
            base_dir=tmp_path,
            renderer=render_kube_env,
        ) as case:
            context = env.with_runtime(str(case.kube_home), run_as_user()).to_template_context()
            case.invoke_func(
                context,
                KUBE_APISERVER_SCRIPT_NAMES,
                ETCD_TEMPLATE_TARGET,
                (BASE_TEMPLATE_RELATIVE_PATH, ETCD_TEMPLATE_RELATIVE_PATH),
            )
            pod = case.load_pod_from_manifest()
            assert "--etcd-servers=https://127.0.0.1:2379" in pod.spec.containers[0].command_line

    Note what the caller supplies and this class never invents: the repository
    root, the render context (including ``KubeHome`` and the uid) and the
    renderer. Nothing is defaulted into the environment the shipped script sees
    -- see the module docstring on the ``mTLS disabled`` case, which passes only
    because an empty environment stays empty.
    """

    def __init__(
        self,
        *,
        repo_root: str | os.PathLike[str],
        manifest: str,
        func_name: str,
        aux_manifests: Sequence[str] = (),
        kube_home: str | os.PathLike[str] | None = None,
        base_dir: str | os.PathLike[str] | None = None,
        renderer: KubeEnvRenderer | None = None,
    ) -> None:
        """Lay out a fresh ``KUBE_HOME`` and copy the shipped manifest into it.

        Args:
            repo_root: The repository root, from which both template roots are
                derived. Supplied rather than computed: python/tests/conftest.py
                owns the ``repo_root`` fixture.
            manifest: The pod manifest's bare filename, normally
                :data:`KUBE_APISERVER_MANIFEST_FILE_NAME`. Ports Go's
                ``manifest`` field: it names both the file copied out of
                ``cluster/gce/manifests`` and the file expected under
                ``etc/kubernetes/manifests`` afterwards.
            func_name: The shell function the case invokes, normally
                :data:`KUBE_APISERVER_START_FUNC_NAME`. Ports
                ``manifestFuncName``.
            aux_manifests: Additional bare filenames to copy from the
                pod-manifest root into the sources directory. Ports
                ``auxManifests``; every current consumer passes ``nil``, and the
                parameter is carried because the Go signature has it and a
                consumer of a multi-manifest generator would need it.
            kube_home: Use EXACTLY this directory as ``KUBE_HOME``, creating it
                if absent. Mutually exclusive with ``base_dir``. Pass a
                SUBDIRECTORY of ``tmp_path`` rather than ``tmp_path`` itself:
                :meth:`tear_down` removes this directory, because the case owns
                its ``KUBE_HOME`` exactly as the Go harness does.
            base_dir: Create a uniquely-named ``KUBE_HOME`` INSIDE this
                directory, which is the shape to use with pytest's ``tmp_path``:
                uniqueness is guaranteed even if one test builds several cases,
                and teardown can only ever remove the subdirectory this case
                created. Mutually exclusive with ``kube_home``.
            renderer: Default :class:`KubeEnvRenderer` for
                :meth:`create_env` and :meth:`invoke_func`, so the shell tier's
                ``render_kube_env`` fixture is bound once by the factory instead
                of at every call. Optional: a caller that only ever uses
                :meth:`write_env_script` needs none, and either method may
                override it per call.

        Raises:
            ManifestHarnessError: if both ``kube_home`` and ``base_dir`` are
                given; if ``manifest``, ``func_name`` or an entry of
                ``aux_manifests`` is unusable; if either template root is
                missing; if ``KUBE_HOME`` cannot be created or already holds a
                case's tree; or if a copy or ``mkdir`` fails. A ``KUBE_HOME``
                this constructor created itself is removed before the error
                propagates, so a failed setup leaks nothing -- there is no
                object left for the caller to tear down.
        """
        __tracebackhide__ = True

        self._manifest: Final[str] = _require_bare_filename(manifest, what="manifest")
        if not func_name.strip():
            raise ManifestHarnessError(
                "func_name must name the shell function to invoke (for example "
                f"{KUBE_APISERVER_START_FUNC_NAME!r}), got {func_name!r}. A blank name would "
                "let bash source the scripts, run nothing, exit 0 and report a FALSE PASS."
            )
        self._func_name: Final[str] = func_name
        self._aux_manifests: Final[tuple[str, ...]] = tuple(
            _require_bare_filename(name, what="every entry of aux_manifests")
            for name in aux_manifests
        )
        self._renderer = renderer

        # Both roots, validated. Kept apart from each other and derived
        # separately, because they ARE different directories: see the module
        # docstring and pod_manifest_template_dir.
        self._repo_root: Final[Path] = Path(repo_root).resolve()
        self._package_dir: Final[Path] = gci_package_dir(self._repo_root)
        self._manifest_template_dir: Final[Path] = pod_manifest_template_dir(self._repo_root)
        self._manifest_template: Final[Path] = self._manifest_template_dir / self._manifest

        self._kube_home, self._created_kube_home = self._resolve_kube_home(kube_home, base_dir)

        # Ported verbatim from L64 and L73. The generator reads the first
        # (configure-kubeapiserver.sh:299) and its final `cp` writes into the
        # parent of the second (:435, via ETC_MANIFESTS from base.template:15).
        self._manifest_sources: Final[Path] = self._kube_home.joinpath(
            *MANIFEST_SOURCES_RELATIVE_PATH
        )
        self._manifest_destination: Final[Path] = self._kube_home.joinpath(
            *MANIFEST_DESTINATION_RELATIVE_PATH, self._manifest
        )

        self._pod: PodManifest | None = None

        try:
            self._copy_from_template()
            self._copy_aux_from_template()
            self._create_manifest_dst_dir()
        except BaseException:
            # Go leaks its temp directory when a must* step calls t.Fatalf,
            # because the deferred tearDown is only registered once the
            # constructor has returned. Nothing asserts on that leak, so it is
            # not preserved: a directory this constructor created is removed
            # before the failure propagates, which keeps /tmp clean across an
            # xdist run. A directory the CALLER named is left alone -- removing
            # it would be a surprise, and pytest's tmp_path already handles it.
            if self._created_kube_home:
                shutil.rmtree(self._kube_home, ignore_errors=True)
            raise

    # -- setup, ported step by step from the Go constructor -------------------

    def _resolve_kube_home(
        self,
        kube_home: str | os.PathLike[str] | None,
        base_dir: str | os.PathLike[str] | None,
    ) -> tuple[Path, bool]:
        """Return the ``KUBE_HOME`` to use and whether this object created it.

        Ports ``os.MkdirTemp("", "configure-helper-test")``
        (configure_helper_test.go L58-63) and widens it in exactly one direction:
        the PARENT may be chosen. Go always uses the system temp directory
        because ``go test`` has nothing better; under pytest the better answer is
        ``tmp_path``, which is per-test, inspectable after a failure and cleaned
        up by pytest's own retention policy.

        The three ways of asking are mutually exclusive by construction, so no
        call site can be ambiguous about which directory the case owns.
        """
        __tracebackhide__ = True
        if kube_home is not None and base_dir is not None:
            raise ManifestHarnessError(
                "pass kube_home= or base_dir=, not both: kube_home names the directory to use "
                "as KUBE_HOME, base_dir names the directory to create a unique KUBE_HOME inside. "
                "Accepting both would leave it unclear which directory the case owns and which "
                "one tear_down removes."
            )

        if kube_home is not None:
            explicit = Path(kube_home)
            if explicit.exists() and not explicit.is_dir():
                raise ManifestHarnessError(
                    f"kube_home {explicit} exists and is not a directory, so it cannot hold the "
                    "case's KUBE_HOME tree."
                )
            try:
                explicit.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise ManifestHarnessError(
                    f"failed to create KUBE_HOME at {explicit}: {exc}"
                ) from exc
            self._reject_existing_case_tree(explicit)
            # Not "created by us" even when the mkdir above made it: the caller
            # named this path, so a failed setup leaves it for the caller (and
            # for pytest's tmp_path retention) to deal with.
            return explicit.resolve(), False

        parent: str | None = None
        if base_dir is not None:
            parent_path = Path(base_dir)
            if not parent_path.is_dir():
                raise ManifestHarnessError(
                    f"base_dir {parent_path} is not an existing directory, so no KUBE_HOME can be "
                    "created inside it."
                )
            parent = os.fspath(parent_path)

        try:
            # prefix rather than a fixed name, so several cases inside one test
            # cannot collide. `dir=None` reproduces Go's empty first argument:
            # the system temporary directory.
            created = tempfile.mkdtemp(prefix=TEMP_DIR_PREFIX, dir=parent)
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to create a temporary KUBE_HOME (prefix {TEMP_DIR_PREFIX!r}, parent "
                f"{parent or 'system temp'}): {exc}"
            ) from exc
        return Path(created).resolve(), True

    def _reject_existing_case_tree(self, candidate: Path) -> None:
        """Refuse a ``KUBE_HOME`` that already holds another case's tree.

        Isolation has to be structural rather than hoped for. Two cases sharing a
        ``KUBE_HOME`` is not a tidiness problem: ``configure-kubeapiserver.sh``
        rewrites the copied manifest in place, and a stale manifest left at the
        destination could be loaded and asserted against even if the second
        generator run never wrote one -- a pass that proves nothing. A reused
        directory is therefore refused here, before any of it can happen.
        """
        __tracebackhide__ = True
        for marker in (ENV_SCRIPT_FILE_NAME, MANIFEST_SOURCES_RELATIVE_PATH[0]):
            if (candidate / marker).exists():
                raise ManifestHarnessError(
                    f"kube_home {candidate} already contains {marker!r}, so it is another case's "
                    "KUBE_HOME. Each case needs its own: the shipped generator rewrites the "
                    "copied manifest in place, so a shared tree lets one case read what another "
                    "left behind. Use base_dir= for a unique directory, or pass a fresh "
                    "subdirectory of tmp_path."
                )

    def _copy_file(self, src: Path, dst: Path, *, what: str) -> None:
        """Copy file CONTENT from ``src`` to ``dst``, the port of ``copyFile``.

        Ports ``copyFile`` (configure_helper_test.go L161-179), which opens the
        source, creates the destination and streams the bytes -- content only, no
        metadata. ``shutil.copyfile`` has precisely those semantics, which is why
        it is used rather than ``shutil.copy`` or ``copy2``: the destination must
        end up owned and writable by the test process, because the generator
        rewrites it in place with ``sed -i``, and inheriting the source's mode
        bits is not something to rely on for that.
        """
        __tracebackhide__ = True
        try:
            shutil.copyfile(src, dst)
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to copy {what} {src} to KUBE_HOME at {dst}: {exc}"
            ) from exc

    def _copy_from_template(self) -> None:
        """Create the sources directory and copy the shipped pod manifest into it.

        Ports ``mustCopyFromTemplate`` (configure_helper_test.go L82-90).

        INVARIANT PRESERVED: the file copied is the artifact this repository
        ships, ``cluster/gce/manifests/<manifest>``, read at the moment the case
        runs. It is not duplicated under python/ and there is no fixture copy of
        it, so a change to the shipped manifest reaches this tier immediately
        instead of leaving a stale copy passing its own assertions.
        """
        __tracebackhide__ = True
        try:
            self._manifest_sources.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to create the manifest sources directory {self._manifest_sources}: {exc}"
                " -- configure-kubeapiserver.sh:299 reads its input from exactly this path."
            ) from exc

        if not self._manifest_template.is_file():
            raise ManifestHarnessError(
                f"the shipped pod manifest {self._manifest_template} does not exist. It is "
                f"resolved as <repo>/cluster/gce/{POD_MANIFEST_DIR_NAME}/{self._manifest} -- note "
                "that this root is cluster/gce/manifests and NOT cluster/gce/gci/manifests."
            )
        self._copy_file(
            self._manifest_template,
            self._manifest_sources / self._manifest,
            what="the shipped pod manifest",
        )

    def _copy_aux_from_template(self) -> None:
        """Copy each auxiliary manifest into the sources directory.

        Ports ``mustCopyAuxFromTemplate`` (configure_helper_test.go L92-99),
        including its source directory: auxiliary manifests come from the
        POD-MANIFEST root beside the main manifest, never from the kube-env
        template directory.
        """
        __tracebackhide__ = True
        for name in self._aux_manifests:
            source = self._manifest_template_dir / name
            if not source.is_file():
                raise ManifestHarnessError(
                    f"auxiliary manifest {source} does not exist; aux_manifests entries are "
                    f"resolved against the pod-manifest root {self._manifest_template_dir}."
                )
            self._copy_file(
                source,
                self._manifest_sources / name,
                what=f"auxiliary manifest {name!r}",
            )

    def _create_manifest_dst_dir(self) -> None:
        """Create ``KUBE_HOME/etc/kubernetes/manifests``.

        Ports ``mustCreateManifestDstDir`` (configure_helper_test.go L101-106).

        INVARIANT PRESERVED: the directory must exist BEFORE the generator runs.
        ``configure-kubeapiserver.sh:435`` finishes with
        ``cp "${src_file}" "${ETC_MANIFESTS:-/etc/kubernetes/manifests}"``, and
        ``cp`` does not create its destination directory -- so without this step
        the generator fails at its last line and the failure looks like anything
        but a missing directory.
        """
        __tracebackhide__ = True
        destination_dir = self._manifest_destination.parent
        try:
            destination_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to create the manifest destination directory {destination_dir}: {exc} -- "
                "configure-kubeapiserver.sh:435 copies the generated manifest here with `cp`, "
                "which does not create its destination."
            ) from exc

    # -- what the case is, as read-only views --------------------------------

    @property
    def repo_root(self) -> Path:
        """The repository root this case was built from, resolved."""
        return self._repo_root

    @property
    def package_dir(self) -> Path:
        """``<repo>/cluster/gce/gci``: the ``cwd`` every invocation runs in.

        Public because the V8 fail-closed tier needs it. That tier asserts on a
        non-zero exit and on a specific diagnostic, so it composes this case's
        :attr:`env_script_path` and this directory with
        ``tests.helpers.bash.try_invoke_func`` itself rather than through
        :meth:`run_func`, which raises on a non-zero exit by design. Exposing the
        two paths is what lets that tier reuse the layout without this module
        growing a second failure posture that duplicates bash.py's.
        """
        return self._package_dir

    @property
    def manifest(self) -> str:
        """The pod manifest's bare filename. Ports the ``manifest`` field."""
        return self._manifest

    @property
    def func_name(self) -> str:
        """The shell function this case invokes. Ports ``manifestFuncName``."""
        return self._func_name

    @property
    def aux_manifests(self) -> tuple[str, ...]:
        """The auxiliary manifest filenames. Ports ``auxManifests``."""
        return self._aux_manifests

    @property
    def kube_home(self) -> Path:
        """The case's ``KUBE_HOME``. Ports the ``kubeHome`` field.

        Every consumer puts this into the render context as ``KubeHome``
        (apiserver_etcd_test.go L73; apiserver_kms_test.go L75), which is how the
        rendered ``kube-env`` points the generator at the same tree this case
        reads back from. Plainly exposed for a second reason too: the flat
        ``TestEncryptionProviderConfig`` case reads
        ``<kube_home>/encryption-provider-config.yaml`` directly and asserts its
        bytes, so a caller must be able to reach arbitrary files under here.
        """
        return self._kube_home

    @property
    def manifest_sources(self) -> Path:
        """``KUBE_HOME/kube-manifests/kubernetes/gci-trusty``. Ports ``manifestSources``.

        The directory ``configure-kubeapiserver.sh:299`` reads its input from.
        """
        return self._manifest_sources

    @property
    def manifest_source_path(self) -> Path:
        """The copied manifest inside :attr:`manifest_sources`.

        Not a field of the Go struct, which recomputes this join at L87. Named
        here because it is the file the generator rewrites in place with
        ``sed -i`` (configure-kubeapiserver.sh:393-432) -- the reason a fresh
        copy is made per case, and a useful thing to be able to inspect when a
        substitution is under suspicion.
        """
        return self._manifest_sources / self._manifest

    @property
    def manifest_destination(self) -> Path:
        """``KUBE_HOME/etc/kubernetes/manifests/<manifest>``. Ports ``manifestDestination``.

        Where the generator's final ``cp`` lands, and therefore what
        :meth:`load_pod_from_manifest` reads.
        """
        return self._manifest_destination

    @property
    def manifest_template_dir(self) -> Path:
        """``<repo>/cluster/gce/manifests``. Ports ``manifestTemplateDir``.

        The POD-MANIFEST root. Not the kube-env template root, which is
        ``<repo>/cluster/gce/gci/testdata/kube-apiserver/``.
        """
        return self._manifest_template_dir

    @property
    def manifest_template(self) -> Path:
        """The shipped pod manifest that gets copied. Ports ``manifestTemplate``."""
        return self._manifest_template

    @property
    def env_script_path(self) -> Path:
        """``KUBE_HOME/kube-env``: the path :meth:`create_env` writes and bash sources.

        The value ``mustCreateEnv`` returns (configure_helper_test.go L141). This
        is a PATH, computed from the layout, and it exists only after
        :meth:`create_env` or :meth:`write_env_script` has run -- which
        :meth:`run_func` checks before invoking anything. Public so the V8
        fail-closed tier can source the same file through
        ``tests.helpers.bash.try_invoke_func``; see :attr:`package_dir`.
        """
        return self._kube_home / ENV_SCRIPT_FILE_NAME

    @property
    def renderer(self) -> KubeEnvRenderer | None:
        """The default renderer bound at construction, if any."""
        return self._renderer

    @property
    def pod(self) -> PodManifest:
        """The manifest loaded by the last :meth:`load_pod_from_manifest` call.

        Ports the ``pod`` field. Go starts it at the zero value of ``v1.Pod``, so
        reading it before the load yields an empty pod whose ``Containers[0]``
        panics; here it raises with a message that says what to do instead,
        because a silent empty pod would let an assertion pass for the wrong
        reason -- ``dontWant`` against an empty command line succeeds.
        """
        __tracebackhide__ = True
        if self._pod is None:
            raise ManifestHarnessError(
                "no manifest has been loaded yet: call load_pod_from_manifest() after "
                "invoke_func(). Asserting against an unloaded pod would silently pass any "
                "'must not contain' check."
            )
        return self._pod

    # -- rendering the kube-env script ---------------------------------------

    def _resolve_templates(
        self,
        templates: Sequence[str | os.PathLike[str]],
    ) -> tuple[Path, ...]:
        """Resolve template paths against the package directory and confirm each exists.

        The Go tests name the templates relative to their working directory --
        ``"testdata/kube-apiserver/base.template"`` -- and ``template.ParseFiles``
        resolves them against that same directory. The package directory plays
        that role here, so the identical strings keep working and
        :data:`BASE_TEMPLATE_RELATIVE_PATH` and its siblings can be passed
        straight through. An absolute path is honoured as given.

        Existence is checked HERE rather than left to the renderer, so a mistyped
        path is reported as a mistyped path naming the directory that holds the
        trio, instead of as whatever error the caller's template engine happens to
        raise.

        INVARIANT PRESERVED: the templates are RESOLVED and READ, never copied.
        There is no ``.template`` file anywhere under python/, and there must not
        be: ``testdata`` is skipped by hack/boilerplate/boilerplate.py, so a copy
        under python/ would be header-gated when the original is not, and the two
        would differ from the first commit.
        """
        __tracebackhide__ = True
        if not templates:
            raise ManifestHarnessError(
                "no kube-env templates were given; at least one is required -- the consumers "
                f"pass {BASE_TEMPLATE_RELATIVE_PATH!r} first, because the other templates invoke "
                "the 'base' template it defines."
            )

        resolved: list[Path] = []
        for template in templates:
            candidate = Path(template)
            if not candidate.is_absolute():
                candidate = self._package_dir / candidate
            if not candidate.is_file():
                raise ManifestHarnessError(
                    f"kube-env template {candidate} does not exist. Relative names are resolved "
                    f"against the package directory {self._package_dir}, where the shipped trio "
                    f"lives in {KUBE_ENV_TEMPLATE_RELATIVE_DIR}/ as base.template, etcd.template "
                    "and kms.template."
                )
            resolved.append(candidate)
        return tuple(resolved)

    def write_env_script(self, content: str) -> Path:
        """Write ``content`` verbatim to ``KUBE_HOME/kube-env`` and return its path.

        The file half of ``mustCreateEnv`` (configure_helper_test.go L126-129,
        L141) without the rendering half, for a caller that already has the text
        -- one that rendered it elsewhere, or one deliberately exercising a
        hand-written environment.

        VERBATIM is the whole point. Nothing is appended, nothing is defaulted and
        no variable is injected, because the script under test must see exactly
        what the case decided it should see. ``TestTLSFlags``'s "mTLS disabled"
        case depends on that: its environment is empty of etcd credentials and the
        expected result is the plaintext endpoint, so a single helpful default
        here would change the outcome of a test whose point is that outcome.

        Args:
            content: The exact text to write.

        Returns:
            The path written, :attr:`env_script_path`.

        Raises:
            ManifestHarnessError: if the file cannot be written.
        """
        __tracebackhide__ = True
        destination = self.env_script_path
        try:
            destination.write_text(content, encoding="utf-8")
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to write the {ENV_SCRIPT_FILE_NAME} script to {destination}: {exc}"
            ) from exc
        return destination

    def create_env(
        self,
        context: Mapping[str, object],
        target: str,
        templates: Sequence[str | os.PathLike[str]],
        *,
        renderer: KubeEnvRenderer | None = None,
    ) -> Path:
        """Render the ``kube-env`` script and write it. The port of ``mustCreateEnv``.

        Ports ``mustCreateEnv`` (cluster/gce/gci/configure_helper_test.go
        L125-142)::

            f, err := os.Create(filepath.Join(c.kubeHome, envScriptFileName))
            t, err := template.ParseFiles(templates...)
            err = t.ExecuteTemplate(f, target, env)
            return f.Name()

        INVARIANT PRESERVED: the TARGET and the TEMPLATE PATHS stay separate
        arguments, because they are different kinds of string. Go's
        ``ParseFiles`` names each parsed template after its base filename, so the
        target is a NAME that selects among the parsed set -- ``"etcd.template"``
        -- while ``templates`` are the FILES to parse, and ``base.template`` is
        among them without ever being the target, since the other two invoke it
        through ``{{ template "base" .KubeHome }}``. Collapsing the two into one
        argument would make that relationship inexpressible.

        The rendering itself belongs to the caller's :class:`KubeEnvRenderer`.
        This module owns no template language: the Jinja2 port lives in
        python/tests/fixtures/templates/kube_env.j2 and is driven by the shell
        tier's ``render_kube_env`` fixture.

        Args:
            context: The render data, keyed by the exported Go field names the
                shipped templates dereference -- what
                ``KubeAPIServerETCDEnv.to_template_context()`` and its KMS
                sibling produce. Named ``context`` rather than ``env``, which Go
                calls it, so that it cannot be confused with the PROCESS
                environment overrides :meth:`run_func` accepts.
            target: The template name to render, for example
                :data:`ETCD_TEMPLATE_TARGET`.
            templates: The template files to parse, in order, ``base.template``
                first. Relative names resolve against :attr:`package_dir`.
            renderer: Renderer for this call, overriding the one bound at
                construction.

        Returns:
            The path of the written script, :attr:`env_script_path`.

        Raises:
            ManifestHarnessError: if no renderer is available, if ``target`` is
                blank, if ``templates`` is empty or names a file that does not
                exist, if the renderer fails, or if it returns something other
                than a non-empty string.
        """
        __tracebackhide__ = True
        if not target.strip():
            raise ManifestHarnessError(
                "target must name the template to render, for example "
                f"{ETCD_TEMPLATE_TARGET!r} or {KMS_TEMPLATE_TARGET!r}, got {target!r}. It is a "
                "template NAME, not a path: Go names each parsed template after its base "
                "filename, and this port keeps that spelling."
            )

        chosen = renderer if renderer is not None else self._renderer
        if chosen is None:
            raise ManifestHarnessError(
                "no KubeEnvRenderer is available: pass renderer= to this call or bind one when "
                "constructing the case. This module deliberately implements no template "
                "language -- the kube-env renderer lives in the fixtures package, so that the "
                "template language has exactly one implementation in the tree."
            )

        resolved = self._resolve_templates(templates)
        try:
            rendered = chosen(target, resolved, context)
        except Exception as exc:
            # Go fails the test on either half of the render (L134 for a parse
            # error, L138 for an execute error). The same posture, with the
            # target and the parsed files named so the failure is actionable;
            # the original error is chained rather than swallowed.
            raise ManifestHarnessError(
                f"failed to render {ENV_SCRIPT_FILE_NAME} for target {target!r} from "
                f"{[os.fspath(path) for path in resolved]}: {exc}"
            ) from exc

        if not isinstance(rendered, str):
            raise ManifestHarnessError(
                f"the KubeEnvRenderer returned {type(rendered).__name__}, not str, for target "
                f"{target!r}. It must return the rendered script text, which is written verbatim "
                f"to {ENV_SCRIPT_FILE_NAME}."
            )
        if not rendered.strip():
            # No legitimate case renders an empty environment. Even the "mTLS
            # disabled" case renders every `readonly` line of etcd.template with
            # EMPTY VALUES -- an empty FILE means the renderer selected nothing,
            # and sourcing it would leave KUBE_HOME unset and the generator
            # failing for an unrelated-looking reason. write_env_script() remains
            # available for a caller that genuinely wants exact bytes.
            raise ManifestHarnessError(
                f"rendering target {target!r} produced no content. An empty {ENV_SCRIPT_FILE_NAME} "
                "would leave KUBE_HOME unset for the shipped generator; note that a case with an "
                "empty ENVIRONMENT still renders every assignment, with empty values."
            )
        return self.write_env_script(rendered)

    # -- running the shipped generator ---------------------------------------

    def run_func(
        self,
        script_names: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        requirement: str | None = None,
    ) -> BashResult:
        """Source the already-written ``kube-env`` and the scripts, then call the function.

        The execution half of ``mustInvokeFunc`` (configure_helper_test.go
        L108-123), delegated in full to ``tests.helpers.bash.must_invoke_func``:
        that module builds the ``source`` chain character for character, merges
        stdout and stderr the way Go's ``CombinedOutput`` does, bounds the call
        with a timeout and raises on a non-zero exit, which is the ``t.Fatalf``
        posture. None of that is re-implemented here -- a second copy of the
        subprocess handling would fork the two failure postures bash.py exists to
        own.

        A tolerant variant is deliberately absent. The V8 fail-closed scenarios
        need a non-zero exit as DATA and need stderr separately, so they call
        ``tests.helpers.bash.try_invoke_func`` with this case's
        :attr:`env_script_path` and :attr:`package_dir`. Adding a second posture
        here would duplicate that decision in two modules.

        Args:
            script_names: Scripts to source, IN ORDER, after ``kube-env``.
                Normally :data:`KUBE_APISERVER_SCRIPT_NAMES`. Relative names
                resolve against :attr:`package_dir`, which is the ``cwd`` used.
            env: PROCESS environment overrides, merged by bash.py over a copy of
                ``os.environ`` -- distinct from the template ``context``, and
                passed through untouched. Nothing is defaulted, sanitised or
                injected on the way: what the caller supplies is what the shipped
                script sees.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            requirement: Identifier of the requirement this call enforces, quoted
                in any failure message so a CI failure reads as a requirement
                violation.

        Returns:
            The :class:`BashResult`, whose ``stdout`` holds the merged output.

        Raises:
            ManifestHarnessError: if no ``kube-env`` has been written yet, or if
                ``script_names`` is empty.
            tests.helpers.bash.BashInvocationError: if the invocation times out
                or exits non-zero.
        """
        __tracebackhide__ = True
        env_script = self.env_script_path
        if not env_script.is_file():
            raise ManifestHarnessError(
                f"no {ENV_SCRIPT_FILE_NAME} has been written to {env_script}: call create_env() or "
                "write_env_script() first. Sourcing a missing file would abort bash before the "
                "generator ran, and the failure would not mention the environment."
            )
        if not script_names:
            raise ManifestHarnessError(
                "script_names is empty, so nothing would define "
                f"{self._func_name!r} -- pass the scripts to source, normally "
                f"{list(KUBE_APISERVER_SCRIPT_NAMES)}, in that order because "
                f"{KUBE_APISERVER_CONFIG_SCRIPT_NAME} calls functions defined by "
                f"{CONFIGURE_HELPER_SCRIPT}."
            )

        return must_invoke_func(
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
        renderer: KubeEnvRenderer | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        requirement: str | None = None,
    ) -> BashResult:
        """Render the environment, then run the shipped generator. ``mustInvokeFunc``.

        The complete port of ``mustInvokeFunc`` (cluster/gce/gci/
        configure_helper_test.go L108-123), whose first act is to call
        ``mustCreateEnv``. The parameter order follows the Go signature
        ``mustInvokeFunc(env, scriptNames, targetTemplate, templates...)`` so the
        two read alike side by side; the variadic tail becomes an explicit
        sequence.

        The consumer shape this reproduces, from apiserver_etcd_test.go L76-82::

            c.mustInvokeFunc(tc.env,
                []string{"configure-helper.sh", kubeAPIServerConfigScriptName},
                "etcd.template",
                "testdata/kube-apiserver/base.template",
                "testdata/kube-apiserver/etcd.template")

        INVARIANT PRESERVED: the SHIPPED generator runs. What executes is
        ``cluster/gce/gci/configure-helper.sh`` and
        ``cluster/gce/gci/configure-kubeapiserver.sh`` from this checkout, read at
        the moment the case runs, against the shipped pod manifest and the shipped
        templates. Nothing about the generator is reproduced in Python, which is
        the property that makes a passing assertion evidence about what this
        repository ships.

        Args:
            context: Render data for the ``kube-env`` script; see
                :meth:`create_env`.
            script_names: Scripts to source, in order; see :meth:`run_func`.
            target_template: The template name to render, for example
                :data:`ETCD_TEMPLATE_TARGET`.
            templates: The template files to parse, ``base.template`` first.
            renderer: Renderer for this call, overriding the bound one.
            env: Process environment overrides, passed through untouched.
            timeout: Seconds to allow; ``None`` uses bash.py's default.
            requirement: Identifier of the requirement enforced.

        Returns:
            The :class:`BashResult` of the invocation.

        Raises:
            ManifestHarnessError: for any render or setup failure; see
                :meth:`create_env` and :meth:`run_func`.
            tests.helpers.bash.BashInvocationError: if the invocation times out
                or exits non-zero.
        """
        __tracebackhide__ = True
        self.create_env(context, target_template, templates, renderer=renderer)
        return self.run_func(script_names, env=env, timeout=timeout, requirement=requirement)

    def load_pod_from_manifest(self) -> PodManifest:
        """Read and decode the generated manifest. The port of ``mustLoadPodFromManifest``.

        Ports ``mustLoadPodFromManifest`` (cluster/gce/gci/
        configure_helper_test.go L144-153). Reads
        :attr:`manifest_destination` -- the file the generator's final ``cp``
        produced -- decodes it, stores the result on :attr:`pod` as Go stores it
        on ``c.pod``, and returns it so a caller can bind it in one line.

        Re-reading is deliberate: what is decoded is what the generator WROTE, not
        what this harness copied in, which is what makes the assertions evidence
        about the generator rather than about the copy.

        Returns:
            The decoded :class:`PodManifest`.

        Raises:
            ManifestHarnessError: if the destination is missing or unreadable, or
                if what it holds is not a valid ``v1`` ``Pod``.
        """
        __tracebackhide__ = True
        destination = self._manifest_destination
        try:
            text = destination.read_text(encoding="utf-8")
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to read the generated manifest {destination}: {exc} -- the generator did "
                f"not produce it. Check that {self._func_name!r} ran (invoke_func) and that "
                f"KubeHome in the render context is {self._kube_home}, since "
                "configure-kubeapiserver.sh:435 copies the manifest to ETC_MANIFESTS, which "
                "base.template derives from KUBE_HOME."
            ) from exc

        pod = parse_pod_manifest(text, source=destination)
        self._pod = pod
        return pod

    def tear_down(self) -> None:
        """Remove the whole ``KUBE_HOME`` tree. The port of ``tearDown``.

        Ports ``tearDown`` (cluster/gce/gci/configure_helper_test.go L155-159),
        which is ``os.RemoveAll(c.kubeHome)`` and a ``t.Fatalf`` if that fails.

        Idempotent, exactly as ``os.RemoveAll`` is: removing an already-removed
        tree is not an error, so calling this after :func:`manifest_test_case`
        has already done so is harmless.

        The case owns its ``KUBE_HOME`` and removes it unconditionally, including
        one supplied through ``kube_home=``. A caller with other files to keep
        should pass a subdirectory of ``tmp_path`` rather than ``tmp_path``
        itself.

        Raises:
            ManifestHarnessError: if the tree exists and cannot be removed. Not
                silently ignored: an undeletable tree is a real problem -- a
                leaked subprocess holding a file, most likely -- and every
                subsequent run would inherit it.
        """
        __tracebackhide__ = True
        if not self._kube_home.exists():
            return
        try:
            shutil.rmtree(self._kube_home)
        except OSError as exc:
            raise ManifestHarnessError(
                f"failed to tear down KUBE_HOME {self._kube_home}: {exc}"
            ) from exc


@contextlib.contextmanager
def manifest_test_case(
    *,
    repo_root: str | os.PathLike[str],
    manifest: str,
    func_name: str,
    aux_manifests: Sequence[str] = (),
    kube_home: str | os.PathLike[str] | None = None,
    base_dir: str | os.PathLike[str] | None = None,
    renderer: KubeEnvRenderer | None = None,
) -> Iterator[ManifestTestCase]:
    """Build a :class:`ManifestTestCase` and guarantee its teardown.

    The port of the pairing every consumer writes on the two lines that open a
    case (apiserver_etcd_test.go L71-72, apiserver_kms_test.go L71-72)::

        c := newManifestTestCase(t, kubeAPIServerManifestFileName, kubeAPIServerStartFuncName, nil)
        defer c.tearDown()

    ``defer`` runs whether the test passes, fails or aborts, and this
    ``finally`` is that guarantee: one temporary ``KUBE_HOME`` per case, always
    removed, which is what keeps the tier safe under ``pytest-xdist -n auto`` and
    honest under ``pytest-randomly``. The recommended entry point for that
    reason; construct :class:`ManifestTestCase` directly only where the lifetime
    is managed some other way, such as a fixture whose own ``yield`` teardown
    calls :meth:`ManifestTestCase.tear_down`.

    Args:
        repo_root: The repository root; see :class:`ManifestTestCase`.
        manifest: The pod manifest's bare filename.
        func_name: The shell function to invoke.
        aux_manifests: Additional manifests to copy into the sources directory.
        kube_home: Use this directory as ``KUBE_HOME``. Mutually exclusive with
            ``base_dir``.
        base_dir: Create a unique ``KUBE_HOME`` inside this directory -- the shape
            to use with pytest's ``tmp_path``.
        renderer: Default renderer for the case.

    Yields:
        The prepared case.

    Raises:
        ManifestHarnessError: if setup fails, or if teardown fails after a body
            that SUCCEEDED. A teardown failure after a body that already raised
            is suppressed, so that the finding the test made is what propagates
            rather than the cleanup problem it caused.
    """
    case = ManifestTestCase(
        repo_root=repo_root,
        manifest=manifest,
        func_name=func_name,
        aux_manifests=aux_manifests,
        kube_home=kube_home,
        base_dir=base_dir,
        renderer=renderer,
    )
    try:
        yield case
    except BaseException:
        # Clean up as far as possible, then re-raise the ORIGINAL exception. A
        # raise from this finally-path would replace the test's actual finding
        # with a cleanup error, which is the one thing teardown must never do.
        with contextlib.suppress(Exception):
            case.tear_down()
        raise
    else:
        case.tear_down()
