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

"""Session-scoped fixture root of the pytest tier that ports controls V1 to V8.

AAP §0.4.4.1 (the conftest hierarchy) / §0.5.1 (the python/tests/conftest.py
row) / §0.3.2 (harness primitives that must be RECREATED rather than mocked) /
tech-spec §6.6.1.2 (the integration tier's principle: "real components, not
mocks").

INVARIANT LOCKED BY THIS FILE: where the repository is, which etcd and which
kube-apiserver a test may use, that there is exactly ONE etcd per session
reached through a per-run storage prefix, and which record of today's Go
verdicts the parity contract is allowed to read. Nothing here asserts anything
about the eight controls; everything here decides what the modules that DO
assert are handed.

WHAT THIS FILE PORTS, AND FROM WHERE

    Go primitive                                  Fixture here
    --------------------------------------------  ----------------------------
    (KUBE_ROOT, hack/lib/init.sh:29)              repo_root
    kube::etcd::validate (hack/lib/etcd.sh:28)    etcd_binary
    ${KUBE_OUTPUT_BIN}/${platform} layout         apiserver_binary
    framework.EtcdMain(m.Run) + SharedEtcd()      shared_etcd
    (no ancestor - a new migration artifact)      parity_baseline

``test/integration/auth/main_test.py``'s Go counterpart is thirty-five lines
long: ``TestMain`` calls ``framework.EtcdMain(m.Run)`` and every test in the
package then shares one etcd. The identical file exists in
``test/integration/secrets/`` and ``test/integration/controlplane/audit/``, so
"one etcd per package" is the measured unit of sharing. pytest has no per-package
process, and its nearest honest equivalent is the SESSION: one etcd for one
pytest run, with isolation restored by a per-run storage prefix rather than by a
fresh datastore. That is exactly what ``framework.SharedEtcd()`` does today
(``test/integration/framework/controlplane_utils.go:95-99``:
``storagebackend.NewDefaultConfig(path.Join(uuid.New().String(), "registry"),
nil)``), so the ported behaviour is the same behaviour, not a relaxation of it.

WHY EVERY FIXTURE LIVES IN A conftest.py AND NOT IN A TEST MODULE

Under ``--doctest-modules`` a module-, package- or session-scoped autouse
fixture declared inline in a test module can execute TWICE. Nothing in
``python/pyproject.toml`` enables that flag today - and its ``addopts`` comment
records the omission as deliberate - but a fixture that starts a datastore is
not something to leave one command-line flag away from running twice. This file
is the top of a four-level hierarchy:

    tests/conftest.py            <- this file: session-scoped, tier-agnostic
    tests/unit/shell/conftest.py    the KUBE_HOME layout and bash invoker
    tests/integration/conftest.py   the apiserver factory, clients, namespaces
    tests/parity/conftest.py        the baseline index the contract asserts on

A fixture defined here must therefore never be one a lower level will want to
redefine, because a child that shadows a session fixture silently gives two
tiers two different answers to the same question. The names below were chosen
against that rule: each is the ONE answer for the whole tier, and each lower
tier composes rather than replaces it - ``tests/unit/shell/conftest.py`` derives
``<repo_root>/cluster/gce/gci`` from ``repo_root``, and
``tests/integration/conftest.py`` turns ``shared_etcd`` plus
``apiserver_binary`` into ``--etcd-servers`` and ``--etcd-prefix`` flags.

THE STANDARD LIBRARY, AND NOTHING ELSE

This module imports no third-party distribution, not even one of the eighteen
pinned in ``python/requirements-test.txt``. An ImportError in the ROOT
conftest.py aborts the entire session, so the fast unit and config tiers must
not be able to fail over a distribution that only the integration tier needs;
``python/tests/helpers/bash.py`` states the same rule for the same reason. The
one place it shows is the etcd readiness probe, which uses
:mod:`urllib.request` where ``hack/lib/etcd.sh`` uses ``curl`` - the same two
HTTP calls, one fewer import.

WHAT THIS FILE DELIBERATELY DOES NOT DO

* It registers no marker. ``python/pyproject.toml`` declares exactly
  ``integration``, ``shell``, ``config``, ``parity`` and ``slow``, and
  ``addopts`` carries ``--strict-markers``, so an unregistered marker is a
  collection error. :func:`pytest_collection_modifyitems` below APPLIES one of
  those five; it defines none.
* It sets no timeout. ``python/pyproject.toml`` already bounds every test at
  300 s through pytest-timeout, so a ``pytest_configure`` here would be a
  second, competing source of truth.
* It creates no ``python/tests/__init__.py``. ``pythonpath = ["."]`` plus
  ``consider_namespace_packages = true`` make ``tests.fixtures.*`` and
  ``tests.helpers.*`` importable with no package marker at this level.
* It never downloads etcd, never builds a binary and never invokes ``make``.
  Provisioning is ``hack/install-etcd.sh`` and ``make WHAT=...``; a fixture that
  did either would turn a test run into a thirty-minute surprise. Every
  resolution below is a LOOKUP, and its failure is a skip carrying the command
  the developer should run.
* It indexes nothing. :func:`parity_baseline` parses the manifest and stops;
  ``tests/parity/conftest.py`` owns the ``(package, test, subtest)`` index.
"""

from __future__ import annotations

import base64
import contextlib
import getpass
import json
import logging
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from typing import IO, Any, Final

import pytest

# The writer of the artifact this file reads. Imported for its DOMAIN VALIDATOR and
# nothing else: `check_committed_domain` is what `generate_baseline.py --check`
# calls, so reader and writer share one definition of a complete baseline and the
# measured cardinalities live only in `PACKAGE_EXPECTATIONS`. A second copy here
# would be a second thing to drift, which is the defect this import removes rather
# than adds. The module is pure - its argparse and subprocess work all happens
# inside functions - so importing it costs nothing at collection time.
from tests.parity.tools.generate_baseline import BaselineError, check_committed_domain

__all__ = [
    "DEFAULT_ETCD_URL",
    "DEFAULT_POLL_INTERVAL_SECONDS",
    "FOREVER_TEST_TIMEOUT_SECONDS",
    "REQUIRED_ETCD_VERSION",
    "STORAGE_PREFIX_SUFFIX",
    "SharedEtcdInstance",
    "apiserver_binary",
    "etcd_binary",
    "parity_baseline",
    "pytest_collection_modifyitems",
    "repo_root",
    "shared_etcd",
]

# Diagnostics go to the logging module, never to `warnings.warn`, and never to
# stdout. python/pyproject.toml sets `filterwarnings = ["error", ...]`, so a
# warning raised while a fixture tears down would be ESCALATED INTO AN ERROR and
# would mask the real result of the test that happened to be last - the precise
# masking AAP §0.3.2 asks teardown to avoid. `log_level = "INFO"` and
# `junit_logging = "system-out"` in the same file mean everything logged here is
# captured and lands in the JUnit report, so nothing is lost by not warning.
logger: Final[logging.Logger] = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Layout anchors, resolved from __file__ and never from the process CWD
# ---------------------------------------------------------------------------

#: ``<repo_root>/python/tests``: the directory this file lives in.
_TESTS_DIR: Final[Path] = Path(__file__).resolve().parent

#: ``<repo_root>``. This file is ``<repo_root>/python/tests/conftest.py``, so the
#: repository root is two levels up. Derived from ``__file__`` rather than from
#: the working directory because both are legitimate: hack/make-rules/
#: test-python.sh runs pytest with python/ as the working directory (it must -
#: ``testpaths`` and ``pythonpath`` are resolved against rootdir), while a
#: developer may invoke `pytest python/tests/...` from the repository root. A
#: CWD-derived answer would differ between those two and there would be no way
#: to tell which was right.
_REPO_ROOT_FROM_FILE: Final[Path] = _TESTS_DIR.parents[1]

#: Files and directories that must exist beneath a genuine checkout of THIS
#: repository. ``hack/lib/etcd.sh`` is the etcd provisioner every integration
#: fixture is written against and ``cluster/gce/gci`` is the package the shell
#: tier invokes, so a root missing either cannot serve this tier at all. Checked
#: rather than assumed because a silently wrong root produces failures that
#: point everywhere except at the root.
_REPO_ROOT_SENTINELS: Final[tuple[tuple[str, ...], ...]] = (
    ("hack", "lib", "etcd.sh"),
    ("cluster", "gce", "gci"),
)

#: ``<repo_root>/third_party/etcd/etcd``: where ``kube::etcd::install``
#: (hack/lib/etcd.sh:146-192) puts the pinned copy, through the ``etcd`` symlink
#: it creates to ``etcd-v${ETCD_VERSION}-${os}-${arch}``.
_ETCD_RELATIVE_PATH: Final[tuple[str, ...]] = ("third_party", "etcd", "etcd")

#: ``<repo_root>/python/tests/parity/baseline/go_baseline.json``: the default the
#: WRITER uses (``tests/parity/tools/generate_baseline.py``'s
#: ``default_baseline_path``). Reader and writer must resolve the same file.
_BASELINE_RELATIVE_PATH: Final[tuple[str, ...]] = (
    "python",
    "tests",
    "parity",
    "baseline",
    "go_baseline.json",
)

#: The collected subdirectory of ``tests/`` whose items gate real infrastructure,
#: and the marker they are given. The marker name MUST be one of the five declared
#: in python/pyproject.toml, because ``--strict-markers`` makes anything else a
#: collection error. See :func:`pytest_collection_modifyitems`.
_INTEGRATION_DIR_NAME: Final[str] = "integration"
_INTEGRATION_MARKER: Final[str] = "integration"


# ---------------------------------------------------------------------------
# The environment contract: names READ here, defined elsewhere
# ---------------------------------------------------------------------------

#: hack/lib/init.sh:29 computes ``KUBE_ROOT``; hack/verify-spelling.sh:25 and
#: hack/jenkins/benchmark-dockerized.sh:36 export it. Honoured as a FALLBACK
#: only - see :func:`_resolve_repo_root`.
ENV_REPO_ROOT: Final[str] = "KUBE_ROOT"

#: An explicit etcd executable, for an environment that stages the pinned binary
#: somewhere this file would not look. Checked first, and still version-gated.
ENV_ETCD_BINARY: Final[str] = "ETCD_BINARY"

#: hack/lib/etcd.sh:19 - ``ETCD_VERSION=${ETCD_VERSION:-3.6.5}``. Read from the
#: environment first, exactly as the shell does, so one override moves both
#: gates at once.
ENV_ETCD_VERSION: Final[str] = "ETCD_VERSION"

#: hack/lib/etcd.sh:26 exports it and ``framework.GetEtcdURL()``
#: (test/integration/framework/etcd.go:301-303) reads it with the same default.
#: It is the reuse handshake between a developer's ``kube::etcd::start`` session
#: and this fixture.
ENV_ETCD_URL: Final[str] = "KUBE_INTEGRATION_ETCD_URL"

#: hack/lib/etcd.sh:85 - where etcd's stderr goes when ``ARTIFACTS`` is not a
#: directory.
ENV_ETCD_LOGFILE: Final[str] = "ETCD_LOGFILE"

#: The CI artifact directory. hack/lib/etcd.sh:82-83 writes the etcd log there
#: when it exists, and hack/make-rules/test-python.sh mirrors
#: hack/make-rules/test.sh in auto-matching ``KUBE_JUNIT_REPORT_DIR`` to it.
ENV_ARTIFACTS: Final[str] = "ARTIFACTS"

#: An explicit kube-apiserver executable, for a caller that built it elsewhere.
ENV_APISERVER_BINARY: Final[str] = "KUBE_APISERVER_BINARY"

#: hack/lib/init.sh:45 - ``KUBE_OUTPUT_BIN=${KUBE_OUTPUT}/bin``, holding
#: per-platform subdirectories. Exported, so honouring it is honouring the
#: repository's own contract rather than guessing a path.
ENV_OUTPUT_BIN: Final[str] = "KUBE_OUTPUT_BIN"

#: hack/lib/init.sh:46 - ``THIS_PLATFORM_BIN=${KUBE_ROOT}/_output/bin``, a
#: symlink hack/lib/golang.sh:669 points at the host platform's binaries.
ENV_THIS_PLATFORM_BIN: Final[str] = "THIS_PLATFORM_BIN"

#: The baseline manifest path, in the spelling the committed writer uses
#: (tests/parity/tools/generate_baseline.py's ``ENV_BASELINE_FILE``). It WINS
#: over the alias below, because that module resolves its output the same way and
#: writer and reader must land on the same file.
ENV_PARITY_BASELINE: Final[str] = "KUBE_PARITY_BASELINE"

#: The same setting under the spelling AAP §0.7 documents, honoured as a
#: fallback so that neither name can be set to no effect.
ENV_PARITY_BASELINE_ALIAS: Final[str] = "KUBE_PARITY_BASELINE_FILE"


# ---------------------------------------------------------------------------
# etcd: the values hack/lib/etcd.sh pins, mirrored rather than reinvented
# ---------------------------------------------------------------------------

#: hack/lib/etcd.sh:19. Also the pin registered in build/dependencies.yaml and
#: consumed by cluster/gce/manifests/etcd.manifest, which is why it is a
#: MINIMUM rather than an equality: ``kube::etcd::validate`` compares with
#: ``-gt`` against this floor and accepts anything newer.
REQUIRED_ETCD_VERSION: Final[str] = "3.6.5"

#: hack/lib/etcd.sh:20-21.
DEFAULT_ETCD_HOST: Final[str] = "127.0.0.1"
DEFAULT_ETCD_PORT: Final[int] = 2379

#: hack/lib/etcd.sh:26 and test/integration/framework/etcd.go:63 - the same
#: default on both sides of the language boundary.
DEFAULT_ETCD_URL: Final[str] = f"http://{DEFAULT_ETCD_HOST}:{DEFAULT_ETCD_PORT}"

#: hack/lib/etcd.sh:25 explains the spelling: etcd itself complains when
#: ``ETCD_LOG_LEVEL`` is set in addition to the command-line argument, so the
#: level travels as a flag and the shell's variable is deliberately named
#: ``ETCD_LOGLEVEL``. Only the flag is used here.
ETCD_LOG_LEVEL: Final[str] = "warn"

#: 8 GiB, from ``framework.RunCustomEtcd``
#: (test/integration/framework/etcd.go:136-137). A session that exercises the
#: whole ported surface writes far less than this; the flag is carried across so
#: a long run cannot hit the 2 GiB default quota and start failing writes for a
#: reason that has nothing to do with the control under test.
ETCD_QUOTA_BACKEND_BYTES: Final[int] = 8 * 1024 * 1024 * 1024

#: ``framework.SharedEtcd()`` builds ``path.Join(uuid, "registry")``. The suffix
#: is what the apiserver's storage layer expects to own; the UUID in front of it
#: is what keeps two runs - and two pytest-xdist workers - from ever colliding.
STORAGE_PREFIX_SUFFIX: Final[str] = "registry"


# ---------------------------------------------------------------------------
# Shared timing defaults, defined ONCE for the whole tier
# ---------------------------------------------------------------------------

#: 30 s. Two independent Go sources agree on it: ``testContext``
#: (test/integration/auth/main_test.go:31-35) bounds every request in the ported
#: auth package with ``context.WithTimeout(context.Background(), 30*time.Second)``,
#: and ``wait.ForeverTestTimeout``
#: (staging/src/k8s.io/apimachinery/pkg/util/wait/wait.go:37) is
#: ``time.Second * 30``. ``tests/helpers/polling.py`` and
#: ``tests/integration/conftest.py`` consume this; a second definition elsewhere
#: would be a divergence waiting to happen.
#:
#: It is deliberately NOT the same number as pytest-timeout's 300 s in
#: python/pyproject.toml: this bounds ONE operation, that bounds a whole test.
FOREVER_TEST_TIMEOUT_SECONDS: Final[float] = 30.0

#: 500 ms - the interval ``TestAuditSensitiveResourceLevels`` passes to
#: ``wait.Poll`` while it waits for audit events to converge. Named separately
#: from the readiness interval below because they answer to different origins
#: and must be able to move independently.
DEFAULT_POLL_INTERVAL_SECONDS: Final[float] = 0.5


# ---------------------------------------------------------------------------
# Budgets internal to this file. Private: nothing outside it should couple to
# how long etcd is given to boot or to die.
# ---------------------------------------------------------------------------

#: 20 s, from ``kube::util::wait_for_url "${KUBE_INTEGRATION_ETCD_URL}/health"
#: "etcd: " 0.25 80`` (hack/lib/etcd.sh:92): 80 attempts at 0.25 s. The Go
#: framework spends the same order of time differently - 300 dials at 100 ms, or
#: 30 s (test/integration/framework/etcd.go:232-249) - and either is ample; the
#: shell's numbers are used because the shell is what this fixture's transport
#: follows.
_ETCD_READY_TIMEOUT_SECONDS: Final[float] = 20.0
_ETCD_READY_POLL_INTERVAL_SECONDS: Final[float] = 0.25

#: 5 s, from ``framework.RunCustomEtcd``'s stop function
#: (test/integration/framework/etcd.go:209-216): SIGTERM, then five seconds, then
#: kill. Matched exactly so a slow shutdown behaves the same in both tiers.
_ETCD_TERM_GRACE_SECONDS: Final[float] = 5.0

#: How long a killed etcd is given to be reaped before teardown gives up and
#: reports it. Short: SIGKILL is not refusable, so anything beyond this is a
#: kernel-level problem the test run cannot fix but MUST report.
_ETCD_KILL_GRACE_SECONDS: Final[float] = 5.0

#: How long teardown waits for the listening socket to become bindable again.
#: A closed listener is released immediately in practice - this bound exists so
#: that the leak assertion measures a leak rather than a scheduling hiccup.
_PORT_RELEASE_TIMEOUT_SECONDS: Final[float] = 5.0

#: Per-attempt budget for one readiness probe, and for the single ``--version``
#: invocation. Small on purpose: these are loopback calls to a local process, and
#: the enclosing deadline is what governs how long we keep retrying.
_PROBE_TIMEOUT_SECONDS: Final[float] = 1.0

#: hack/lib/etcd.sh:93 - ``curl -fs -X POST "${URL}/v3/kv/put" -d '{"key":
#: "X3Rlc3Q=", "value": ""}'``. ``X3Rlc3Q=`` is base64 for ``_test``. This is the
#: shell's own smoke check and it is carried over for a reason that matters more
#: here than there: it is the only proof that the HTTP v3 GATEWAY - not merely
#: the gRPC port - is serving, and the gateway is what ``etcd3gw`` speaks. The
#: key sits outside every per-run storage prefix, so it can never be mistaken for
#: an object the apiserver wrote.
_ETCD_SMOKE_PUT_PATH: Final[str] = "/v3/kv/put"
_ETCD_SMOKE_PUT_KEY: Final[str] = "_test"

#: Prefix for the ISOLATED probe key used against a REUSED etcd.
#:
#: A borrowed datastore belongs to somebody else, so the shell's shared ``_test``
#: key is the wrong thing to write there: two concurrent runs, or a developer
#: watching that key, would see each other. The reuse probe therefore writes
#: ``<this prefix><run uuid>`` instead, which no other run and no apiserver can
#: collide with, and which is still outside every per-run STORAGE prefix so it can
#: never be mistaken for an object the apiserver wrote.
_ETCD_REUSE_PROBE_KEY_PREFIX: Final[str] = "_blitzy_parity_gateway_probe/"

#: The health endpoint and the value etcd reports when it is serving. Measured
#: against etcd 3.6.5: ``{"health":"true","reason":""}``. The value is a STRING
#: in the JSON gateway's projection, so a boolean ``True`` is accepted too rather
#: than making this brittle across versions.
_ETCD_HEALTH_PATH: Final[str] = "/health"
_ETCD_HEALTH_KEY: Final[str] = "health"

#: The version endpoint and the key carrying the SERVER's version. Measured against
#: etcd 3.6.5: ``{"etcdserver":"3.6.5","etcdcluster":"3.6.0"}``. ``etcdserver`` is
#: the one that matters - ``etcdcluster`` is the negotiated cluster protocol version
#: and is legitimately lower than the binary's own.
_ETCD_VERSION_PATH: Final[str] = "/version"
_ETCD_SERVER_VERSION_KEY: Final[str] = "etcdserver"

#: Characters of the etcd log quoted into a startup-failure message. Enough to
#: carry the reason ("bind: address already in use", a corrupt data dir) without
#: burying the failure in a wall of JSON.
_LOG_TAIL_CHARS: Final[int] = 2000

#: Every thread this module starts would carry this prefix, and the teardown leak
#: check asserts none survives. It starts none - etcd's stderr is redirected to a
#: file rather than pumped by a reader thread, which is how the goroutine
#: ``framework.RunCustomEtcd`` needs a ``sync.WaitGroup`` to manage simply does
#: not exist here. The assertion stays as a regression guard for the next edit.
_THREAD_NAME_PREFIX: Final[str] = "kube-shared-etcd-"

#: The temp-directory prefix ``framework.RunCustomEtcd`` uses for etcd's data
#: (test/integration/framework/etcd.go:73), carried over so that a directory left
#: behind by an interrupted run is identifiable as this harness's.
_ETCD_DATA_DIR_PREFIX: Final[str] = "integration_test_etcd_data"

#: How many times to reselect a port and respawn when etcd loses the bind race.
#:
#: Four, because the failure is independent per attempt and narrow to begin with,
#: so four attempts reduce an already-rare flake to a negligible one while bounding
#: the worst case at four spawn attempts rather than an unbounded retry that could
#: hide a genuine, permanent inability to bind. Only a bind failure is retried -
#: see :func:`_looks_like_a_port_conflict`.
_ETCD_PORT_ATTEMPTS: Final[int] = 4

#: The executable this tier means when it says "the API server".
_APISERVER_BINARY_NAME: Final[str] = "kube-apiserver"

#: uname -m to GOARCH, mirroring ``kube::util::host_arch``
#: (hack/lib/util.sh:158-190) case for case, including its ``i?86 -> x86``
#: spelling. Mirrored rather than improved: a Python answer that disagreed with
#: the shell's would look for binaries in a directory the build never wrote.
_GOARCH_BY_MACHINE: Final[Mapping[str, str]] = MappingProxyType(
    {
        "x86_64": "amd64",
        "i686_64": "amd64",
        "i386_64": "amd64",
        "amd64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
        "armv7l": "arm",
        "armv6l": "arm",
        "i686": "x86",
        "i386": "x86",
        "s390x": "s390x",
        "ppc64le": "ppc64le",
    }
)

#: The manifest key whose emptiness would make the parity gate vacuous. See
#: :func:`_load_parity_baseline`.
_BASELINE_VERDICTS_KEY: Final[str] = "verdicts"

#: hack/lib/etcd.sh:32 and :66 - the guidance the repository already gives a
#: developer whose etcd is missing or too old. Reused verbatim so the message a
#: pytest skip prints is the message that developer has read before.
_INSTALL_ETCD_GUIDANCE: Final[str] = (
    "You can use 'hack/install-etcd.sh' to install a copy in third_party/."
)

#: AAP §0.9.4.2's build command, quoted exactly, plus the free-disk figure the
#: same section records. A skip that names the command is a skip a developer can
#: act on without leaving the terminal.
_BUILD_APISERVER_GUIDANCE: Final[str] = (
    'Build it with: KUBE_GIT_VERSION=v1.34.0-blitzy make WHAT="cmd/kube-apiserver '
    'cmd/kube-controller-manager cmd/kubeadm" (needs about 5 GB of free disk).'
)


class _HarnessError(RuntimeError):
    """A LOUD condition: the environment is present but wrong, so nothing is skipped.

    Raised when the repository root does not look like this repository, when a
    spawned etcd never became ready, and when the parity baseline exists but
    cannot be trusted. Every one of those would otherwise degrade into a test
    that passes for the wrong reason, which is the single failure mode this
    migration cannot tolerate: a gate that reports green because it asserted
    nothing.
    """


class _ArtifactUnavailableError(Exception):
    """A required external artifact is absent or too old, so the tier SKIPS.

    Carries the message a fixture hands to :func:`pytest.skip`, including the
    provisioning command. Distinct from :class:`_HarnessError` on purpose: "etcd
    is not installed on this machine" is a statement about the machine, and
    failing the build over it would make the unit and config tiers unrunnable
    everywhere except CI. "The baseline is corrupt" is a statement about the
    repository, and skipping over THAT would hide it.
    """


@dataclass(frozen=True)
class SharedEtcdInstance:
    """The etcd every integration test in a session shares, and how to reach it.

    PORTS: the pair ``framework.SharedEtcd()`` (the storage config: server list
    plus a per-run prefix) and the URL half of ``framework.EtcdMain`` (the
    instance itself). Frozen because three sibling conftests and seven test
    modules read it: a mutable session-scoped object shared that widely is a
    cross-test channel, and AAP §0.7.2 asks for isolation that is structural
    rather than incidental.

    THE PREFIX IS A BOUNDARY CONDITION, NOT AN IMPLEMENTATION DETAIL

    ``prefix`` is ``"<uuid>/registry"`` - a fresh UUID for every session, exactly
    as ``framework.SharedEtcd()`` produces through
    ``path.Join(uuid.New().String(), "registry")``. It carries NO leading slash,
    also exactly as the Go value does.

    A raw etcd read must build its key from THIS value and never from the literal
    ``"registry"``. ``test/integration/secrets/encryption_test.go:69-75`` says so
    in its own comment and shows the shape:

        etcdKeyForSecret(storagePrefix, namespace, name) =
            "/" + storagePrefix + "/secrets/" + namespace + "/" + name

    Note the LEADING SLASH the caller adds, and note that the UUID is already
    inside ``storagePrefix``. Hardcoding ``registry`` reads a key that does not
    exist, and V3's "exactly one key/value pair" assertion then fails for
    entirely the wrong reason - the most expensive kind of failure, because it
    looks like a broken control rather than a broken test.

    Attributes:
        url: ``http://127.0.0.1:<port>``. Pass to the API server as
            ``--etcd-servers=<url>``, and split with :attr:`host` / :attr:`port`
            for ``etcd3gw``, whose client takes the two separately.
        prefix: The storage prefix described above. Pass to the API server as
            ``--etcd-prefix=<prefix>``.
        data_dir: The directory holding ``data/`` and the etcd log, removed at
            teardown. ``None`` when an already-running etcd was REUSED, because
            this session did not create it and must not delete it.
        log_file: Where etcd's stderr went. ``None`` for a reused instance.
        pid: The etcd process id this session spawned; ``None`` when reused.
        reused: True when an etcd that was already listening was adopted. Exposed
            because it changes what teardown is allowed to do, and because a test
            proving the reuse path needs to be able to see it.
    """

    url: str
    prefix: str
    data_dir: Path | None
    log_file: Path | None
    pid: int | None
    reused: bool

    @property
    def host(self) -> str:
        """The host component of :attr:`url`, for a client that wants it split out.

        ``etcd3gw.client(host=..., port=...)`` takes the two apart, so deriving
        them here keeps every consumer from re-parsing the URL slightly
        differently.
        """
        return _split_host_port(self.url)[0]

    @property
    def port(self) -> int:
        """The port component of :attr:`url`. See :attr:`host`."""
        return _split_host_port(self.url)[1]


# ---------------------------------------------------------------------------
# Repository root
# ---------------------------------------------------------------------------


def _missing_repo_root_sentinels(candidate: Path) -> tuple[str, ...]:
    """Return the sentinel paths MISSING beneath ``candidate``; empty means valid.

    Returning what is missing rather than a bare boolean is deliberate: the
    failure message can then name the file it looked for, which is the difference
    between "that is not the repository root" and a developer guessing.
    """
    missing: list[str] = []
    for parts in _REPO_ROOT_SENTINELS:
        if not candidate.joinpath(*parts).exists():
            missing.append("/".join(parts))
    return tuple(missing)


def _resolve_repo_root() -> Path:
    """Resolve the repository root, preferring ``__file__`` over the environment.

    INVARIANT LOCKED: every tier answers "where is the repository?" identically,
    and answers it from this file's own location.

    ``KUBE_ROOT`` is honoured, because the repository's own scripts export it
    (hack/verify-spelling.sh:25, hack/jenkins/benchmark-dockerized.sh:36) and a
    developer may well have it set. It is honoured as a FALLBACK, not as an
    override: when the ``__file__``-derived root is a valid checkout, that value
    wins and a disagreement is reported. Anything else would let a stale exported
    variable point this tier at a different checkout - a mistake that produces
    tests which pass against code nobody is editing.

    The environment value is used only when the derived one is NOT a valid
    checkout, which is the one situation where it can actually help: a copy of
    this file outside the tree it belongs to.

    Raises:
        _HarnessError: when neither candidate looks like this repository. Loud,
            with the sentinel it could not find, because every downstream failure
            from a wrong root is misleading.
    """
    derived = _REPO_ROOT_FROM_FILE
    derived_missing = _missing_repo_root_sentinels(derived)

    configured_text = os.environ.get(ENV_REPO_ROOT, "").strip()
    configured = Path(configured_text).resolve() if configured_text else None

    if not derived_missing:
        if configured is not None and configured != derived:
            logger.warning(
                "%s=%s disagrees with the root derived from %s (%s); using the derived "
                "value, because this file's own location cannot be stale.",
                ENV_REPO_ROOT,
                configured,
                __file__,
                derived,
            )
        return derived

    if configured is not None and _missing_repo_root_sentinels(configured) == ():
        logger.warning(
            "%s (derived from %s) is not a checkout of this repository (missing %s); "
            "falling back to %s=%s.",
            derived,
            __file__,
            ", ".join(derived_missing),
            ENV_REPO_ROOT,
            configured,
        )
        return configured

    raise _HarnessError(
        f"cannot locate the repository root: {derived}, derived from {__file__}, is "
        f"missing {', '.join(derived_missing)}"
        + (
            f", and {ENV_REPO_ROOT}={configured} is missing "
            f"{', '.join(_missing_repo_root_sentinels(configured))}"
            if configured is not None
            else f", and {ENV_REPO_ROOT} is not set"
        )
        + ". This file must live at <repo_root>/python/tests/conftest.py; every fixture "
        "in the tier resolves paths beneath the value it returns."
    )


# ---------------------------------------------------------------------------
# Versions: the same arithmetic on both sides of the language boundary
# ---------------------------------------------------------------------------

#: Leading digits of one dotted component. ``kube::etcd::version`` pipes each
#: component through awk's ``%03d``, and awk coerces a trailing non-numeric
#: suffix away, so ``3.6.5-rc.0`` yields the same key as ``3.6.5``. Matched here
#: so a pre-release binary is judged the same by both gates.
_LEADING_DIGITS: Final[re.Pattern[str]] = re.compile(r"\A(\d+)")


def _parse_version_triple(text: str) -> tuple[int, int, int] | None:
    """Parse ``"3.6.5"`` into ``(3, 6, 5)``, or return None if it is not a version.

    Mirrors ``kube::etcd::version`` (hack/lib/etcd.sh:72-74), which is
    ``awk -F . '{ printf("%d%03d%03d\\n", $1, $2, $3) }'``. Two of that
    implementation's properties are load-bearing and are reproduced rather than
    tidied up:

    * A missing component is zero. awk's ``$3`` is empty for ``"3.6"`` and
      ``%03d`` renders it ``000``, so ``ETCD_VERSION=3.6`` means 3.6.0.
    * A trailing suffix is ignored. ``%03d`` of ``"5-rc0"`` is ``005``.

    A component that does not START with a digit has no numeric value in awk
    either, but there it silently becomes zero; here it returns None so the caller
    can report the unparsable text instead of comparing against a fabricated
    number.
    """
    components = text.strip().split(".")
    if not components or not components[0]:
        return None
    numbers: list[int] = []
    for component in components[:3]:
        match = _LEADING_DIGITS.match(component.strip())
        if match is None:
            return None
        numbers.append(int(match.group(1)))
    while len(numbers) < 3:
        numbers.append(0)
    return (numbers[0], numbers[1], numbers[2])


def _version_key(version: tuple[int, int, int]) -> int:
    """Collapse a version triple into one comparable integer.

    ``major * 10**6 + minor * 10**3 + patch`` is exactly what
    ``printf("%d%03d%03d")`` produces in ``kube::etcd::version``, so a version
    this function accepts is a version the shell gate accepts and vice versa.
    """
    major, minor, patch = version
    return major * 1_000_000 + minor * 1_000 + patch


def _etcd_version_text(binary: Path) -> str | None:
    """Return the version ``binary`` reports, or None if it cannot be read.

    ``kube::etcd::validate`` (hack/lib/etcd.sh:58) extracts it as
    ``etcd --version | grep Version | head -n 1 | cut -d " " -f 3``. etcd 3.6.5
    prints::

        etcd Version: 3.6.5
        Git SHA: a061450
        Go Version: go1.24.7
        Go OS/Arch: linux/amd64

    so the first ``Version`` line's third whitespace-separated field is ``3.6.5``
    - and ``head -n 1`` is what keeps ``Go Version:`` from being read instead.
    Both streams are searched because a future build could route the banner to
    stderr; the FIRST matching line still wins, so the precedence is unchanged.

    Every failure mode of running an unknown executable is caught and reported as
    None: the candidate is then rejected with a reason rather than crashing the
    session.
    """
    try:
        completed = subprocess.run(
            [str(binary), "--version"],
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in f"{completed.stdout}\n{completed.stderr}".splitlines():
        if "Version" not in line:
            continue
        fields = line.split()
        if len(fields) >= 3:
            return fields[2]
    return None


# ---------------------------------------------------------------------------
# Binary resolution: LOOK UP, never provision
# ---------------------------------------------------------------------------


def _is_executable_file(candidate: Path) -> bool:
    """True when ``candidate`` is a file this process may execute.

    Symlinks are followed - ``third_party/etcd`` is itself a symlink to
    ``etcd-v3.6.5-linux-amd64`` and ``_output/bin`` is a symlink to the host
    platform's output directory, so refusing to follow them would reject the two
    layouts the repository actually produces.
    """
    return candidate.is_file() and os.access(candidate, os.X_OK)


def _deduplicate(paths: Sequence[Path]) -> list[Path]:
    """Order-preserving de-duplication of resolution candidates.

    The candidate lists below overlap by construction - ``THIS_PLATFORM_BIN`` is
    normally a symlink to a path further down the same list - and a duplicate
    would be probed, and reported as rejected, twice.
    """
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in paths:
        key = Path(os.path.normpath(path))
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def _candidate_etcd_binaries(root: Path) -> list[Path]:
    """Every place an etcd executable may legitimately be, in preference order.

    1. ``ETCD_BINARY``, for an environment that stages the pinned binary itself.
    2. ``<root>/third_party/etcd/etcd`` - where ``hack/install-etcd.sh`` puts the
       version pinned in build/dependencies.yaml.
    3. ``etcd`` on ``PATH``.

    ``kube::etcd::validate`` tries PATH first and falls back to
    ``${KUBE_ROOT}/third_party/etcd`` only when the PATH copy is too old
    (hack/lib/etcd.sh:57-69). The order is inverted here, and the inversion is
    deliberate: preferring the repository's own pinned copy makes the tier
    independent of an ambient PATH, and the two orders can only ever disagree
    when BOTH are present and BOTH satisfy the floor - in which case either
    choice passes the same version gate.
    """
    candidates: list[Path] = []
    configured = os.environ.get(ENV_ETCD_BINARY, "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.append(root.joinpath(*_ETCD_RELATIVE_PATH))
    on_path = shutil.which("etcd")
    if on_path:
        candidates.append(Path(on_path))
    return _deduplicate(candidates)


def _resolve_etcd_binary(root: Path) -> Path:
    """Return an etcd executable at or above the pinned version.

    INVARIANT LOCKED: the Python tier and ``kube::etcd::validate`` accept exactly
    the same set of etcd binaries, because they compare the same numbers the same
    way.

    Raises:
        _ArtifactUnavailableError: nothing was found, or everything found was too
            old. The message lists every candidate with the reason it was
            rejected and ends with the repository's own installation guidance.
        _HarnessError: ``ETCD_VERSION`` is set to something that is not a
            version, which is a configuration mistake rather than a missing tool.
    """
    required_text = os.environ.get(ENV_ETCD_VERSION, "").strip() or REQUIRED_ETCD_VERSION
    required = _parse_version_triple(required_text)
    if required is None:
        raise _HarnessError(
            f"{ENV_ETCD_VERSION}={required_text!r} is not a version this gate can "
            f"compare; hack/lib/etcd.sh:19 defaults it to {REQUIRED_ETCD_VERSION}"
        )

    rejected: list[str] = []
    for candidate in _candidate_etcd_binaries(root):
        if not _is_executable_file(candidate):
            rejected.append(f"{candidate}: not an executable file")
            continue
        version_text = _etcd_version_text(candidate)
        if version_text is None:
            rejected.append(f"{candidate}: could not read `etcd --version`")
            continue
        found = _parse_version_triple(version_text)
        if found is None:
            rejected.append(f"{candidate}: unparsable version {version_text!r}")
            continue
        if _version_key(found) < _version_key(required):
            rejected.append(f"{candidate}: version {version_text} is below {required_text}")
            continue
        logger.info("using etcd %s at %s", version_text, candidate)
        return candidate

    detail = "; ".join(rejected) if rejected else "no candidate path exists"
    raise _ArtifactUnavailableError(
        f"etcd {required_text} or greater is required and none was usable ({detail}). "
        f"{_INSTALL_ETCD_GUIDANCE} Or point {ENV_ETCD_BINARY} at an existing copy."
    )


def _host_goos() -> str:
    """GOOS for this host, mirroring ``kube::util::host_os`` (hack/lib/util.sh:141)."""
    return platform.system().lower()


def _host_goarch() -> str:
    """GOARCH for this host, mirroring ``kube::util::host_arch`` (hack/lib/util.sh:158).

    An unmapped machine name is returned unchanged rather than rejected: the
    resolution that consumes it is a filesystem lookup with four other
    candidates, so an exotic architecture degrades to "this one path was not
    found" instead of to an exception on an otherwise healthy host.
    """
    machine = platform.machine().lower()
    return _GOARCH_BY_MACHINE.get(machine, machine)


def _candidate_apiserver_binaries(root: Path) -> list[Path]:
    """Every place a built kube-apiserver may legitimately be, in preference order.

    The layout is not guessed. hack/lib/init.sh:42-46 defines it and EXPORTS it::

        _KUBE_OUTPUT_SUBPATH=${KUBE_OUTPUT_SUBPATH:-_output/local}
        KUBE_OUTPUT=${KUBE_ROOT}/${_KUBE_OUTPUT_SUBPATH}
        KUBE_OUTPUT_BIN=${KUBE_OUTPUT}/bin          # + per-platform subdirs
        THIS_PLATFORM_BIN=${KUBE_ROOT}/_output/bin  # symlink, golang.sh:669

    so the order is: an explicit override, then the two exported variables, then
    the same two paths spelled literally for a caller that exported neither, then
    a bounded glob, then ``PATH``.

    THE GLOB IS BOUNDED ON PURPOSE. ``_output`` also holds ``_output/local/go``,
    the Go build and module cache (hack/lib/golang.sh:19), which contains
    hundreds of thousands of files; an unbounded ``_output/**/kube-apiserver``
    walk would take seconds to minutes on a warm checkout and would do it inside
    fixture setup. The patterns below reach every ``bin`` tree the build writes -
    including a ``KUBE_OUTPUT_SUBPATH`` override such as ``_output/dockerized`` -
    without ever descending into the cache.
    """
    candidates: list[Path] = []

    configured = os.environ.get(ENV_APISERVER_BINARY, "").strip()
    if configured:
        candidates.append(Path(configured))

    platform_bin = os.environ.get(ENV_THIS_PLATFORM_BIN, "").strip()
    if platform_bin:
        candidates.append(Path(platform_bin) / _APISERVER_BINARY_NAME)

    output_bin = os.environ.get(ENV_OUTPUT_BIN, "").strip()
    if output_bin:
        candidates.append(Path(output_bin) / _host_goos() / _host_goarch() / _APISERVER_BINARY_NAME)

    candidates.append(
        root / "_output" / "local" / "bin" / _host_goos() / _host_goarch() / _APISERVER_BINARY_NAME
    )
    candidates.append(root / "_output" / "bin" / _APISERVER_BINARY_NAME)

    for pattern in (
        f"_output/bin/{_APISERVER_BINARY_NAME}",
        f"_output/*/bin/{_APISERVER_BINARY_NAME}",
        f"_output/*/bin/*/*/{_APISERVER_BINARY_NAME}",
    ):
        candidates.extend(sorted(root.glob(pattern)))

    on_path = shutil.which(_APISERVER_BINARY_NAME)
    if on_path:
        candidates.append(Path(on_path))

    return _deduplicate(candidates)


def _resolve_apiserver_binary(root: Path) -> Path:
    """Return a built kube-apiserver, or explain how to build one.

    Nothing is built here. AAP §0.5.1 assigns provisioning to the caller, and a
    fixture that shelled out to ``make`` would put a multi-minute build inside a
    test run - with no output anyone would see until it finished.

    Raises:
        _ArtifactUnavailableError: no candidate exists, carrying the searched
            paths and the exact build command.
    """
    candidates = _candidate_apiserver_binaries(root)
    for candidate in candidates:
        if _is_executable_file(candidate):
            logger.info("using kube-apiserver at %s", candidate)
            return candidate

    searched = ", ".join(str(candidate) for candidate in candidates) or "no candidate path"
    raise _ArtifactUnavailableError(
        f"no built {_APISERVER_BINARY_NAME} was found (searched: {searched}). "
        f"{_BUILD_APISERVER_GUIDANCE} Or point {ENV_APISERVER_BINARY} at an existing "
        "binary."
    )


# ---------------------------------------------------------------------------
# Endpoints, probes and the etcd process itself
# ---------------------------------------------------------------------------


def _split_host_port(url: str) -> tuple[str, int]:
    """Split ``http://host:port`` into its parts, refusing anything incomplete.

    ``etcd3gw.client()`` takes host and port separately, and the API server takes
    the whole URL, so both forms are needed and both must come from one parse.

    Raises:
        _HarnessError: the URL carries no host or no port. Loud rather than
            defaulted: silently substituting 2379 for a missing port is how a test
            ends up talking to a datastore nobody meant it to touch.
    """
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname is None or parsed.port is None:
        raise _HarnessError(
            f"{url!r} is not a usable etcd endpoint: both a host and an explicit port "
            f"are required (for example {DEFAULT_ETCD_URL})"
        )
    return parsed.hostname, parsed.port


def _free_port(host: str = DEFAULT_ETCD_HOST) -> int:
    """Ask the kernel for a free TCP port on ``host`` and return it.

    The technique ``framework.createLocalhostListenerOnFreePort`` uses: bind to
    port 0, read the port the kernel assigned, close the socket, then hand the
    number to the process that will really listen on it.

    There is an inherent race between closing the probe socket and etcd binding the
    number: any bind-0-then-close technique has one. It is narrow - the kernel does
    not reissue a just-assigned ephemeral port immediately - and the alternative is
    worse: hardcoding 2379 would collide with a developer's own
    ``kube::etcd::start`` session, with ``kube::etcd::validate``'s port check, and
    with every other pytest-xdist worker in the same run.

    The race is therefore not avoided but RECOVERED FROM: the caller retries on a
    fresh port when the bind fails, up to :data:`_ETCD_PORT_ATTEMPTS` times, so a
    lost race costs a few hundred milliseconds instead of failing the session. That
    matters most under ``pytest-xdist``, where N workers probing simultaneously is
    exactly the condition that makes a narrow race start happening - and a flake in
    the fixture that starts the datastore would be indistinguishable, to whoever
    reads the CI output, from a real failure of the test that happened to run first.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def _looks_like_a_port_conflict(log_path: Path) -> bool:
    """True when etcd's log says it could not bind its port.

    Deliberately NARROW. Retrying is only correct for a lost port race; every other
    startup failure - a corrupt data directory, a bad flag, a missing shared library
    - must propagate on the first attempt carrying its original diagnostic, because
    retrying it would turn one legible error into four identical ones and delay the
    report by the full readiness timeout each time.

    Matches on the Go runtime's own bind-failure wording, which is what etcd emits
    through ``net.Listen``.
    """
    tail = _read_log_tail(log_path).lower()
    return "address already in use" in tail or "bind: " in tail


def _tcp_reachable(host: str, port: int, timeout: float = _PROBE_TIMEOUT_SECONDS) -> bool:
    """True when something accepts a TCP connection on ``host:port``.

    The reuse handshake, ported from ``startEtcd``
    (test/integration/framework/etcd.go:62-71), which dials
    ``KUBE_INTEGRATION_ETCD_URL`` and adopts whatever answers.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _etcd_healthy(url: str, timeout: float = _PROBE_TIMEOUT_SECONDS) -> bool:
    """True when ``<url>/health`` reports a serving etcd.

    ``kube::etcd::start`` polls this endpoint through
    ``kube::util::wait_for_url`` (hack/lib/etcd.sh:92) and treats any response as
    readiness. This is stricter: the body must actually say the server is healthy,
    because a proxy or a stale listener can answer an HTTP request without there
    being an etcd behind it.

    Every transport and decoding failure means "not ready yet" and is swallowed;
    the caller's deadline is what turns a permanent failure into a reported one.
    """
    try:
        with urllib.request.urlopen(f"{url}{_ETCD_HEALTH_PATH}", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False
    health = payload.get(_ETCD_HEALTH_KEY)
    return health in ("true", True)


def _etcd_server_version(url: str, timeout: float = _PROBE_TIMEOUT_SECONDS) -> str | None:
    """Return the server version ``<url>/version`` reports, or ``None``.

    Every transport and decoding failure means "cannot tell" and yields ``None``;
    the caller decides what that costs.
    """
    try:
        with urllib.request.urlopen(f"{url}{_ETCD_VERSION_PATH}", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    reported = payload.get(_ETCD_SERVER_VERSION_KEY)
    return reported if isinstance(reported, str) and reported.strip() else None


def _etcd_reuse_refusal(url: str, *, probe_key: str = _ETCD_SMOKE_PUT_KEY) -> str | None:
    """Return why ``url`` may NOT be adopted, or ``None`` when it may.

    "SOMETHING ANSWERS" IS NOT "THE RIGHT THING ANSWERS", and the gap between the
    two is what this closes. The reuse path previously adopted any listener whose
    ``/health`` said ``true``, which means a session could silently run its
    integration assertions against an etcd of any version, reached through an
    interface that may not serve the requests those assertions depend on. Two
    concrete consequences, both of which surface far from the cause:

    * VERSION. ``hack/lib/etcd.sh:19`` pins ``ETCD_VERSION`` to 3.6.5 and
      ``build/dependencies.yaml`` registers that pin, and the SPAWN path in this
      file already enforces it through :func:`_resolve_etcd_binary`. Letting the
      reuse path skip it means the same session is version-checked or not depending
      on whether a developer happened to leave an etcd running - and V3's
      assertions read raw storage, where a storage-format difference is exactly the
      kind of thing a pin exists to prevent.
    * TRANSPORT. ``etcd3gw`` 2.7.0 is an HTTP/JSON client that speaks the gRPC
      GATEWAY, so V3's raw read needs ``/v3/kv/*`` to be serving. ``/health``
      answering proves the server is up, not that the gateway is exposed: a listener
      behind a proxy, or an etcd started with the gateway disabled, passes the health
      check and fails the first raw read with an error about JSON that says nothing
      about the real cause. ``kube::etcd::start`` (hack/lib/etcd.sh:93) smoke-writes
      through that very endpoint for the same reason, and this reuses that check.

    The version floor is the SAME resolution the spawn path uses -
    ``$ETCD_VERSION`` if set, else :data:`REQUIRED_ETCD_VERSION` - so a reused and a
    spawned instance are held to one standard rather than two.

    Args:
        url: The candidate endpoint, already known to be reachable and healthy.
        probe_key: The key the gateway write uses. A reused datastore belongs to
            somebody else, so its caller passes an isolated per-run key rather than
            the shell's shared ``_test`` - see :data:`_ETCD_REUSE_PROBE_KEY_PREFIX`.

    Returns:
        ``None`` when the endpoint is adoptable, else a reason naming the check that
        refused it and what the caller can do about it.
    """
    required_text = os.environ.get(ENV_ETCD_VERSION, "").strip() or REQUIRED_ETCD_VERSION
    required = _parse_version_triple(required_text)
    if required is None:
        raise _HarnessError(
            f"{ENV_ETCD_VERSION}={required_text!r} is not a version this gate can compare; "
            f"hack/lib/etcd.sh:19 defaults it to {REQUIRED_ETCD_VERSION}"
        )

    reported = _etcd_server_version(url)
    if reported is None:
        return (
            f"{url}{_ETCD_VERSION_PATH} did not report a server version, so the {required_text} "
            f"floor cannot be checked"
        )
    found = _parse_version_triple(reported)
    if found is None:
        return f"{url}{_ETCD_VERSION_PATH} reported an unparsable version {reported!r}"
    if _version_key(found) < _version_key(required):
        return (
            f"{url} runs etcd {reported}, below the {required_text} this repository pins "
            f"(hack/lib/etcd.sh:19, build/dependencies.yaml)"
        )

    gateway_problem = _etcd_gateway_writable(url, key=probe_key)
    if gateway_problem is not None:
        return (
            f"{url} is healthy and new enough but its HTTP v3 gateway is not usable "
            f"({gateway_problem}); etcd3gw speaks that gateway, so V3's raw read would fail "
            f"later with an error that does not name this cause"
        )
    return None


def _etcd_gateway_writable(
    url: str,
    timeout: float = _PROBE_TIMEOUT_SECONDS,
    key: str = _ETCD_SMOKE_PUT_KEY,
) -> str | None:
    """Write ``key`` through the HTTP v3 gateway; return None on success.

    This is ``curl -fs -X POST "${URL}/v3/kv/put" -d '{"key": "X3Rlc3Q=", "value":
    ""}'`` from hack/lib/etcd.sh:93, and it earns its place for a reason specific
    to this port: ``etcd3gw`` 2.7.0 is an HTTP/JSON client that speaks the gRPC
    GATEWAY, so "the health endpoint answers" is not by itself proof that the
    interface V3's raw read depends on is serving. This proves it, once, at
    startup, instead of letting the first raw read discover it.

    ``key`` is a parameter, not a constant, because the two callers write to
    different datastores. A SPAWNED instance is this session's own, so the shell's
    shared ``_test`` key is exactly right there. A REUSED instance belongs to
    somebody else, so that caller passes an isolated per-run key -- see
    :data:`_ETCD_REUSE_PROBE_KEY_PREFIX`.

    Args:
        url: The etcd base URL.
        timeout: Per-attempt budget for this one call.
        key: The key to write, given as plain text and base64-encoded here
            because the JSON gateway requires base64 for ``key`` and ``value``.

    Returns:
        None when the write succeeded, otherwise a human-readable reason.
    """
    encoded = base64.b64encode(key.encode("utf-8")).decode("ascii")
    body = json.dumps({"key": encoded, "value": ""}).encode("utf-8")
    request = urllib.request.Request(
        f"{url}{_ETCD_SMOKE_PUT_PATH}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return f"{_ETCD_SMOKE_PUT_PATH} answered HTTP {response.status}"
    except (urllib.error.URLError, OSError) as exc:
        return f"{_ETCD_SMOKE_PUT_PATH} failed: {exc}"
    return None


def _wait_for_port_release(
    host: str, port: int, timeout: float = _PORT_RELEASE_TIMEOUT_SECONDS
) -> bool:
    """True once ``host:port`` can be bound again, i.e. the listener is really gone.

    Half of the goleak substitute: a process that has been reaped but whose
    listening socket is still held is a leak that would surface later as a
    mysterious "address already in use" in an unrelated test.

    ``SO_REUSEADDR`` is set for the same reason a server sets it - so that
    connections lingering in TIME_WAIT from the traffic the test itself generated
    do not masquerade as a leaked listener.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind((host, port))
                return True
        except OSError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(_ETCD_READY_POLL_INTERVAL_SECONDS)


def _read_log_tail(path: Path | None, limit: int = _LOG_TAIL_CHARS) -> str:
    """Return the last ``limit`` characters of an etcd log, or a note saying why not.

    Called on the startup-failure path, BEFORE the data directory is removed,
    because the reason etcd refused to start is in that file and the file is about
    to be deleted with it. Never raises: a diagnostic helper that can fail would
    replace the real error with its own.
    """
    if path is None:
        return "<no log file>"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"<could not read {path}: {exc}>"
    return text[-limit:] if text else "<empty>"


def _etcd_log_path(data_dir: Path) -> Path:
    """Choose where etcd's stderr goes, following ``kube::etcd::start``.

    hack/lib/etcd.sh:82-86 writes into ``${ARTIFACTS}`` when that is a directory,
    with the name ``etcd.<node>.<user>.log.DEBUG.<timestamp>.<pid>``, and
    otherwise honours ``ETCD_LOGFILE``. Both are reproduced, including the name,
    so a CI run collects the etcd log exactly where the Go tiers already put it.

    The fallback differs on purpose: the shell's is ``/dev/null`` and this one is
    ``<data_dir>/etcd.log``. A discarded log cannot be quoted into a startup
    failure, and the file lives inside the directory teardown removes anyway, so
    keeping it costs nothing and buys the only diagnostic that matters when etcd
    refuses to boot.

    A stderr stream is never sent to the test's own stdout: a noisy etcd would
    drown the pytest report.
    """
    artifacts = os.environ.get(ENV_ARTIFACTS, "").strip()
    if artifacts and Path(artifacts).is_dir():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        return Path(artifacts) / (
            f"etcd.{platform.node()}.{_current_username()}.log.DEBUG.{stamp}.{os.getpid()}"
        )
    configured = os.environ.get(ENV_ETCD_LOGFILE, "").strip()
    if configured:
        return Path(configured)
    return data_dir / "etcd.log"


def _current_username() -> str:
    """The login name, for the ``ARTIFACTS`` log file name; ``id -un`` in the shell.

    :func:`getpass.getuser` raises when no name can be determined - a real
    possibility in a container with no passwd entry for the running uid - so the
    numeric uid is the fallback. A log FILE NAME is never worth failing a test
    run over.
    """
    try:
        return getpass.getuser()
    except (OSError, KeyError):
        return f"uid{os.getuid()}"


def _etcd_command(binary: Path, url: str, data_dir: Path) -> list[str]:
    """The argv for a private etcd, with every flag traced to its origin.

    ``--advertise-client-urls`` / ``--listen-client-urls`` / ``--data-dir`` /
    ``--log-level`` are ``kube::etcd::start`` (hack/lib/etcd.sh:88) with the URL
    substituted; ``--listen-peer-urls http://127.0.0.1:0`` and
    ``--quota-backend-bytes`` are ``framework.RunCustomEtcd``
    (test/integration/framework/etcd.go:132-137).

    THE PEER FLAG IS NOT OPTIONAL, even though the shell omits it. Without it
    etcd listens for peers on the fixed default port 2380, and this fixture is
    session-scoped in a runner that may be invoked with ``-n auto``: under
    pytest-xdist every worker is its own process with its own session, so two
    workers would start two etcds and the second would fail to bind. Measured:
    with the flag, two instances run side by side and both report healthy; the Go
    framework passes it for the same reason and says so at
    test/integration/framework/etcd.go:130-131.

    Nothing else is added. In particular no TLS flag: the endpoint is loopback
    plaintext, which is what the Go integration tiers use, and V8's mutual-TLS
    behaviour is asserted against the shipped shell in the L1 and L4 tiers rather
    than against a test datastore.
    """
    return [
        str(binary),
        "--advertise-client-urls",
        url,
        "--listen-client-urls",
        url,
        "--listen-peer-urls",
        f"http://{DEFAULT_ETCD_HOST}:0",
        "--data-dir",
        str(data_dir),
        f"--log-level={ETCD_LOG_LEVEL}",
        "--quota-backend-bytes",
        str(ETCD_QUOTA_BACKEND_BYTES),
    ]


def _spawn_etcd(
    binary: Path, url: str, data_dir: Path, log_path: Path
) -> tuple[subprocess.Popen[bytes], IO[bytes]]:
    """Start etcd detached from this process group, with stderr in a file.

    ``start_new_session=True`` makes etcd the leader of its own session and
    process group, so ``os.getpgid(pid) == pid`` and teardown can signal the whole
    GROUP. ``python/tests/helpers/bash.py:349-384`` reaches the same conclusion
    for the shell tier: signalling the pid alone is what leaves something running.

    Returns:
        The process and the open log-file handle, which the caller must close.
        The handle is returned rather than closed here because the child inherits
        the descriptor: closing it early is harmless for the child but loses the
        only reference this side has for flushing order.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("wb")
    try:
        process = subprocess.Popen(
            _etcd_command(binary, url, data_dir),
            stdout=subprocess.DEVNULL,
            stderr=handle,
            start_new_session=True,
        )
    except OSError as exc:
        handle.close()
        raise _HarnessError(f"could not start etcd from {binary}: {exc}") from exc
    return process, handle


def _await_etcd_ready(process: subprocess.Popen[bytes], url: str, log_path: Path) -> None:
    """Block until etcd serves ``/health`` and its v3 gateway accepts a write.

    Two conditions, in the order ``kube::etcd::start`` checks them: readiness
    (hack/lib/etcd.sh:92) and then one real write through the HTTP v3 gateway
    (hack/lib/etcd.sh:93).

    An early exit is detected on every iteration rather than waited out: if the
    process is already gone there is nothing to wait for, and the useful
    information - the bind error, the corrupt data directory - is in the log,
    which is why the log tail is quoted into the failure.

    Raises:
        _HarnessError: etcd exited, or neither condition held before the deadline.
    """
    deadline = time.monotonic() + _ETCD_READY_TIMEOUT_SECONDS
    while True:
        exit_code = process.poll()
        if exit_code is not None:
            raise _HarnessError(
                f"etcd exited with status {exit_code} before it became ready at {url}. "
                f"Last {_LOG_TAIL_CHARS} characters of {log_path}:\n"
                f"{_read_log_tail(log_path)}"
            )
        if _etcd_healthy(url):
            gateway_problem = _etcd_gateway_writable(url)
            if gateway_problem is None:
                return
            logger.debug("etcd at %s is healthy but not writable yet: %s", url, gateway_problem)
        if time.monotonic() >= deadline:
            raise _HarnessError(
                f"etcd at {url} did not become ready within "
                f"{_ETCD_READY_TIMEOUT_SECONDS:.0f}s. Last {_LOG_TAIL_CHARS} characters "
                f"of {log_path}:\n{_read_log_tail(log_path)}"
            )
        time.sleep(_ETCD_READY_POLL_INTERVAL_SECONDS)


def _signal_process_group(process: subprocess.Popen[bytes], number: int) -> None:
    """Send ``number`` to the process group ``process`` leads, ignoring a dead group.

    Only ever called with the pid of a process this module itself spawned with
    ``start_new_session=True``, so the group id is that pid and the signal cannot
    reach anything else - the property ``helpers/bash.py`` documents for the same
    call. A group that has already exited raises :class:`ProcessLookupError`,
    which is the desired outcome arriving early.
    """
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(os.getpgid(process.pid), number)


def _terminate_etcd(process: subprocess.Popen[bytes]) -> int | None:
    """Stop etcd: SIGTERM, five seconds, SIGKILL. Returns the exit status.

    The sequence and the five-second window are ``framework.RunCustomEtcd``'s stop
    function (test/integration/framework/etcd.go:202-226) - SIGTERM, a
    ``time.After(5 * time.Second)`` race against graceful exit, then the context
    cancellation that kills it.

    A NEGATIVE status is the normal outcome and never an error: Python reports a
    signalled child as ``-signal``, and etcd reaped by SIGTERM returns ``-15``
    (measured). The status is returned rather than judged so that teardown can log
    it, exactly as the Go side logs ``"etcd exited"`` with the error it saw.
    """
    _signal_process_group(process, signal.SIGTERM)
    try:
        return process.wait(timeout=_ETCD_TERM_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        logger.info(
            "etcd (pid %d) did not exit within %.0fs of SIGTERM; killing it",
            process.pid,
            _ETCD_TERM_GRACE_SECONDS,
        )
    _signal_process_group(process, signal.SIGKILL)
    try:
        return process.wait(timeout=_ETCD_KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        return None


def _remove_data_dir(data_dir: Path) -> bool:
    """Delete the etcd data directory; log and report rather than raise on failure.

    ``framework.RunCustomEtcd`` ends with ``os.RemoveAll(etcdDataDir)`` and, on
    error, logs ``"Warning: error during etcd cleanup"`` - it does not fail the
    test, because a temp directory that outlives a run is a nuisance while a
    masked test result is a defect. The same choice is made here, with one
    adjustment forced by this tier's configuration: the report goes through
    :mod:`logging` and not through :func:`warnings.warn`, because
    python/pyproject.toml sets ``filterwarnings = ["error", ...]`` and a warning
    raised in teardown would be escalated into an error against whichever test
    happened to run last.
    """
    try:
        shutil.rmtree(data_dir)
    except OSError as exc:
        logger.warning("error during etcd cleanup of %s: %s", data_dir, exc)
        return False
    return True


def _owned_live_threads() -> list[str]:
    """Names of still-running threads this module started. Expected to be empty.

    The third part of the goleak substitute. ``go.uber.org/goleak`` has no Python
    analogue, so the leak classes it would catch are closed structurally instead:
    this fixture starts NO helper thread at all - etcd's stderr goes to a file
    rather than being pumped by a reader, which is precisely the goroutine
    ``framework.RunCustomEtcd`` needs a ``sync.WaitGroup`` to shut down.

    The check is kept even though it can only ever report the empty list today,
    because the edit that adds a background thread is exactly the edit that would
    reintroduce the leak, and it should fail here rather than surface as a hung
    interpreter at the end of a CI run.
    """
    return [
        thread.name
        for thread in threading.enumerate()
        if thread.name.startswith(_THREAD_NAME_PREFIX) and thread.is_alive()
    ]


# ---------------------------------------------------------------------------
# The parity baseline: the record of what the Go oracle reports TODAY
# ---------------------------------------------------------------------------


def _resolve_baseline_path(root: Path) -> Path:
    """Resolve the baseline manifest the same way its WRITER resolves its output.

    INVARIANT LOCKED: reader and writer land on the same file.
    ``tests/parity/tools/generate_baseline.py`` chooses its output path from
    ``KUBE_PARITY_BASELINE``, then ``KUBE_PARITY_BASELINE_FILE``, then
    ``<repo_root>/python/tests/parity/baseline/go_baseline.json``, and states that
    invariant in its own docstring. Both spellings exist because the committed
    runner uses the first and AAP §0.7 documents the second; the code-pinned one
    wins in BOTH places, so neither name can be set to no effect and the two
    sides can never disagree about which file is authoritative.
    """
    for key in (ENV_PARITY_BASELINE, ENV_PARITY_BASELINE_ALIAS):
        configured = os.environ.get(key, "").strip()
        if configured:
            return Path(configured)
    return root.joinpath(*_BASELINE_RELATIVE_PATH)


def _deep_freeze(value: Any) -> Any:
    """Return ``value`` with every nested container made immutable.

    Mappings become :class:`types.MappingProxyType`, sequences become tuples, and
    scalars are returned as they are. Applied to the parity baseline because that
    document is session-scoped shared state: freezing only its outer mapping leaves
    every verdict row, the ``verdicts`` list itself and the nested ``counts`` maps
    writable, which is where all the state a test could perturb actually lives.

    Sets are frozen too, for completeness; ``json.loads`` never produces one, so
    that branch exists so the helper cannot silently pass a mutable container
    through if it is ever pointed at something other than parsed JSON.

    Recursion depth is bounded by the document's own nesting, which the writer emits
    at four levels, so no depth guard is needed.

    Args:
        value: Any parsed-JSON value.

    Returns:
        An immutable equivalent. Tuples replace lists, so consumers iterate and
        index exactly as before but cannot append, assign or sort in place.
    """
    if isinstance(value, Mapping):
        return MappingProxyType({key: _deep_freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_deep_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(value)
    return value


def _load_parity_baseline(path: Path) -> Mapping[str, Any]:
    """Read and structurally sanity-check the baseline manifest.

    THERE IS NO SKIP PATH, AND THAT IS THE FIX. An absent manifest used to skip,
    on the reasoning that a fresh checkout has not run the generator yet - and the
    consequence was that DELETING the committed baseline turned the parity tier
    green. The manifest is a COMMITTED repository artifact, not a machine-local
    tool like the etcd binary: its absence is a statement about the repository, and
    the one thing this migration cannot tolerate is a gate that reports green
    because it asserted nothing. ``generate_baseline.py`` puts it plainly: a short
    manifest "does not fail the gate, it EMPTIES it, and an empty gate reports
    green forever". Absent, unreadable, unparsable, empty, row-less or NARROW - all
    six are :class:`_HarnessError`.

    The structural checks here are the cheap ones: the document parses, it is a
    non-empty JSON object, and it carries a non-empty ``verdicts`` list. The
    DOMAIN check is then delegated to
    ``generate_baseline.check_committed_domain``, which is the same function the
    writer's own ``--check`` gate calls, so the reader and the writer cannot
    disagree about what a complete baseline is and the measured cardinalities have
    exactly one home (``PACKAGE_EXPECTATIONS``). Re-typing those numbers here
    would create a second thing to drift.

    What is still NOT done here: indexing. The ``(package, test, subtest)`` index
    and the completeness, verdict-equality and no-new-failure assertions belong to
    ``tests/parity/conftest.py`` and ``tests/parity/test_parity_contract.py``.
    Validating the domain is not indexing it.

    The returned document is DEEPLY frozen by :func:`_deep_freeze`. It is
    session-scoped and shared by every parity test, and a top-level-only
    ``MappingProxyType`` froze almost none of what matters: the interesting state is
    all nested - the ``verdicts`` list, each verdict row, and the ``counts`` and
    ``by_package`` maps - so ``baseline["verdicts"][0]["action"] = "pass"`` or
    ``baseline["counts"]["by_package"][pkg]["subtests"] = 0`` would have silently
    rewritten what every later test in the session compares against. That is the
    worst class of cross-test interference available here, because it does not
    crash: it makes the contract agree with a mutated expectation, and under
    ``pytest-randomly`` it would agree differently on each run. "Consumers index and
    copy rather than mutate" was a convention, and a convention is not an invariant
    when the object is shared session state.

    Raises:
        _HarnessError: the file is absent, unreadable, not JSON, empty, carries no
            verdict rows, or does not describe the complete measured domain.
    """
    if not path.is_file():
        raise _HarnessError(
            f"the parity baseline manifest {path} does not exist, so there is no record of "
            "today's Go verdicts to compare against - and without it every completeness and "
            "verdict-equality assertion would be vacuous. This is a COMMITTED artifact, so "
            "its absence is a repository error rather than a missing local tool: it is "
            "reported instead of skipped, because skipping would mean deleting the baseline "
            "turns the parity tier green. Regenerate it by executing the oracle: "
            "`python/.venv/bin/python python/tests/parity/tools/generate_baseline.py`, or "
            f"restore it from version control. Set {ENV_PARITY_BASELINE} to read one from "
            "another location."
        )
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise _HarnessError(
            f"the parity baseline manifest {path} could not be read: {exc}"
        ) from exc
    if not raw.strip():
        raise _HarnessError(
            f"the parity baseline manifest {path} is empty. An empty baseline would let "
            "the parity contract pass while asserting nothing, so it is refused rather "
            "than tolerated."
        )
    try:
        document: object = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise _HarnessError(
            f"the parity baseline manifest {path} is not valid JSON: {exc}. Regenerate it "
            "with `make test-parity`; a partially written manifest is never acceptable."
        ) from exc
    if not isinstance(document, dict) or not document:
        raise _HarnessError(
            f"the parity baseline manifest {path} is not a non-empty JSON object (found "
            f"{type(document).__name__}). Its writer emits an object carrying "
            f"schema_version, provenance, counts, packages and {_BASELINE_VERDICTS_KEY!r}."
        )
    verdicts = document.get(_BASELINE_VERDICTS_KEY)
    if not isinstance(verdicts, list) or not verdicts:
        raise _HarnessError(
            f"the parity baseline manifest {path} carries no "
            f"{_BASELINE_VERDICTS_KEY!r} rows, so every completeness and "
            "verdict-equality assertion built on it would be vacuous. Regenerate it "
            "with `make test-parity`."
        )
    # THE DOMAIN, not just the shape. Non-empty is not the same as complete: a
    # manifest holding one row is a perfectly well-formed document that asserts
    # nothing about the 3,104 Go verdicts it omits. The writer's own --check gate
    # calls this same function, so a baseline this fixture accepts is exactly a
    # baseline the generator would certify - one definition, one set of measured
    # numbers, no second copy to drift.
    try:
        check_committed_domain(document, source=str(path))
    except BaselineError as exc:
        raise _HarnessError(
            f"the parity baseline manifest {path} does not describe the complete measured "
            f"parity domain, so the contract built on it would be narrower than the suite it "
            f"claims to cover: {exc} Regenerate it by executing the oracle rather than "
            f"narrowing what is expected of it."
        ) from exc
    logger.info(
        "loaded the parity baseline from %s: %d verdict rows, provenance %r",
        path,
        len(verdicts),
        document.get("provenance", "<unrecorded>"),
    )
    frozen = _deep_freeze(document)
    if not isinstance(frozen, Mapping):  # pragma: no cover - document is a dict above
        raise _HarnessError(
            f"the parity baseline manifest {path} did not survive freezing as a mapping "
            f"(got {type(frozen).__name__}), which should be impossible here."
        )
    return frozen


# ---------------------------------------------------------------------------
# Session fixtures. Everything above exists to keep these five short.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def repo_root() -> Path:
    """The repository root, as a :class:`pathlib.Path`.

    PORTS: ``KUBE_ROOT`` (hack/lib/init.sh:29) - the anchor every shell script in
    this repository computes from its own location before doing anything else.

    INVARIANT LOCKED: one answer, derived from this file's location, for the whole
    tier. ``python/tests/helpers/bash.py`` and ``helpers/manifest.py`` both state
    that they compute no repository root precisely so that this fixture is the
    only place it is decided; ``helpers/manifest.py``'s ``gci_package_dir`` and
    ``pod_manifest_template_dir`` take the value as a parameter for the same
    reason.

    A :class:`~pathlib.Path` and not a string, because every consumer joins onto
    it: ``cluster/gce/gci`` and ``cluster/gce/gci/testdata/kube-apiserver`` (shell
    tier), ``cluster/gce/manifests``, ``cluster/manifests/namespace-pss-labels.yaml``,
    ``cluster/gce/addons/cloud-pvl-admission/mutating-webhook-configuration.yaml``,
    ``cluster/gce/config-default.sh`` and ``config-test.sh`` (config tier),
    ``hack/boilerplate/`` (tooling tier) and ``third_party/etcd`` (integration
    tier).

    Session-scoped because it is a constant for the run - and because a
    function-scoped fixture would re-run the sentinel check once per test for no
    benefit.
    """
    return _resolve_repo_root()


@pytest.fixture(scope="session")
def etcd_binary(repo_root: Path) -> Path:
    """Path to an etcd executable at or above the pinned 3.6.5, else SKIP.

    PORTS: ``kube::etcd::validate`` (hack/lib/etcd.sh:28-70) - the same version
    floor, compared with the same ``major*10^6 + minor*10^3 + patch`` arithmetic
    ``kube::etcd::version`` uses, so the Python gate and the Bash gate accept
    exactly the same binaries. 3.6.5 is also the pin registered in
    build/dependencies.yaml and consumed by cluster/gce/manifests/etcd.manifest.

    INVARIANT LOCKED: a test never runs against an etcd older than the version the
    repository ships with, and never runs against one it downloaded itself.
    Provisioning stays where the repository put it - ``hack/install-etcd.sh``,
    which is what the skip message names - because a fixture that downloaded a
    datastore would be doing release engineering inside a test run.

    A missing or too-old binary SKIPS rather than fails: it is a statement about
    the machine, and failing would make the unit, shell and config tiers
    unrunnable anywhere the integration prerequisites are absent. A malformed
    ``ETCD_VERSION`` still fails loudly, because that is a statement about the
    configuration.
    """
    try:
        return _resolve_etcd_binary(repo_root)
    except _ArtifactUnavailableError as unavailable:
        pytest.skip(str(unavailable))


@pytest.fixture(scope="session")
def apiserver_binary(repo_root: Path) -> Path:
    """Path to a built kube-apiserver, else SKIP with the build command.

    PORTS: the binary half of ``kubeapiservertesting.StartTestServerOrDie`` and
    ``framework.StartTestServer``. Only the binary: the two Go harnesses differ in
    how they are CONFIGURED - one takes ``(t, instanceOptions, flags,
    storageConfig)``, the other a ``TestServerSetup`` with
    ``ModifyServerRunOptions`` - and AAP §0.3.2 collapses both into a single
    flag-list factory in ``tests/integration/conftest.py``. That factory is the
    right place for flags, lifecycles and client configs; this fixture answers
    only "which executable?".

    INVARIANT LOCKED: the integration tier runs the API server built from THIS
    checkout, found where this repository's own build writes it
    (hack/lib/init.sh:42-46, hack/lib/golang.sh:660-676), and never builds it as a
    side effect of collecting tests.

    Skipping rather than building is the whole design: ``make`` here would spend
    minutes inside fixture setup with no visible output, so the skip carries the
    exact command instead.
    """
    try:
        return _resolve_apiserver_binary(repo_root)
    except _ArtifactUnavailableError as unavailable:
        pytest.skip(str(unavailable))


@pytest.fixture(scope="session")
def shared_etcd(request: pytest.FixtureRequest) -> Iterator[SharedEtcdInstance]:
    """One etcd for the whole session, reached through a per-run storage prefix.

    PORTS: ``framework.EtcdMain(m.Run)`` (test/integration/framework/etcd.go:255)
    together with ``framework.SharedEtcd()``
    (test/integration/framework/controlplane_utils.go:95-99). The Go unit of
    sharing is the PACKAGE - ``test/integration/auth/main_test.go`` is thirty-five
    lines that do nothing but this, and ``test/integration/secrets/`` and
    ``test/integration/controlplane/audit/`` carry the identical file. pytest's
    nearest honest equivalent is the session, with isolation restored the same way
    the Go code restores it: a fresh UUID storage prefix per run rather than a
    fresh datastore per test.

    INVARIANT LOCKED: at most one etcd is started per session; it is reachable over
    HTTP so a raw read can bypass the API server; its storage prefix is unique to
    the run; and when the session ends nothing is left behind - no process, no
    listening socket, no temporary directory.

    THE ONE DELIBERATE DIVERGENCE, AND WHY IT IS CONVERGENCE

    ``framework.RunCustomEtcd`` listens on a UNIX SOCKET
    (``unix://<tmpdir>/etcd.sock``). This fixture listens on
    ``http://127.0.0.1:<free port>`` instead, because ``etcd3gw`` 2.7.0 - the pin
    AAP §0.6.1.1 selects for V3's raw ciphertext read, chosen because the legacy
    ``etcd3`` is unmaintained at 0.12.0 - is an HTTP/JSON client for etcd's gRPC
    gateway and cannot dial a unix socket. V3's assertion REQUIRES a read that
    bypasses the API server, so the endpoint has to be reachable over HTTP.

    That is not a departure from the repository: ``kube::etcd::start``
    (hack/lib/etcd.sh:76-94) is this repository's own integration provisioner, it
    listens on TCP, and it talks to etcd over the same HTTP v3 gateway - its
    readiness poll is ``${URL}/health`` and its smoke check is a
    ``POST ${URL}/v3/kv/put``. This fixture follows that file. What changes is the
    TRANSPORT; no assertion changes, and no assertion is made easier to satisfy.

    The port is never the fixed 2379 for a spawned instance: that would collide
    with a developer's own ``kube::etcd::start`` session, with
    ``kube::etcd::validate``'s port check, and with every other pytest-xdist
    worker. It is obtained the way ``createLocalhostListenerOnFreePort`` obtains
    one - bind to port 0, read the assignment, release it.

    REUSE FIRST, exactly as ``startEtcd`` does
    (test/integration/framework/etcd.go:62-71): if something is already answering
    at ``KUBE_INTEGRATION_ETCD_URL`` (default ``http://127.0.0.1:2379``) it is
    adopted and teardown becomes the no-op stop function the Go code returns. This
    keeps a warm ``kube::etcd::start`` session usable and makes the fixture
    idempotent with respect to the developer's environment. The storage prefix is
    still fresh, so adopting a shared datastore cannot make two runs collide.

    AND REUSE IS ADMITTED ON THE SAME EVIDENCE AS A SPAWN, which is the point of
    the third probe. TCP plus ``/health`` proves only that something is listening
    and calls itself healthy; the interface this tier actually needs is the HTTP v3
    GATEWAY, because ``etcd3gw`` speaks nothing else and V3's raw ciphertext read
    is the one assertion that must bypass the API server. A reverse proxy, an
    ``etcd grpc-proxy`` without the JSON gateway, a TLS-only listener or an etcd
    built with ``--enable-grpc-gateway=false`` all answer ``/health`` and then
    refuse ``/v3/kv/put``, and admitting one of those surfaced the problem much
    later as "expected exactly one key/value pair, got 0" - a report about
    encryption for what is really a transport fault. So a reused endpoint must also
    accept a ``/v3/kv/put``, written to an ISOLATED per-run key because the
    datastore is somebody else's, and an endpoint that refuses it is not adopted:
    the fixture falls through and starts a private instance, which is what
    ``startEtcd``'s own "reuse if usable, otherwise start your own" contract
    implies.

    LAZY, and never autouse: a ``pytest -m "not integration"`` run must not start
    a datastore, and the cheapest way to guarantee that is for nothing in the fast
    tiers to request this fixture. ``etcd_binary`` is resolved through
    :meth:`~pytest.FixtureRequest.getfixturevalue` on the spawn path only, rather
    than being declared as a parameter, so an environment that provides etcd as a
    SERVICE - a container, a CI sidecar - is still able to reuse it without a
    local executable, which is precisely what ``startEtcd`` allows by checking for
    a reachable endpoint before it looks for a binary.

    Yields:
        The :class:`SharedEtcdInstance` describing how to reach it. Read
        :attr:`SharedEtcdInstance.prefix` for the storage prefix; it is a boundary
        condition, not a detail - see that class's documentation.
    """
    prefix = f"{uuid.uuid4()}/{STORAGE_PREFIX_SUFFIX}"
    configured_url = os.environ.get(ENV_ETCD_URL, "").strip() or DEFAULT_ETCD_URL
    configured_host, configured_port = _split_host_port(configured_url)

    url_was_requested = bool(os.environ.get(ENV_ETCD_URL, "").strip())

    if _tcp_reachable(configured_host, configured_port) and _etcd_healthy(configured_url):
        # HEALTHY IS NECESSARY AND NOT SUFFICIENT. The version floor and the v3
        # gateway are checked before adoption, so a reused instance is held to the
        # same standard `_resolve_etcd_binary` holds a spawned one to. See
        # `_etcd_reuse_refusal` for what each check costs when it is skipped.
        # THE GATEWAY PROBE USES AN ISOLATED KEY, because the datastore belongs to
        # somebody else: this writes `_blitzy_parity_gateway_probe/<run uuid>` rather
        # than the shell's shared `_test`, which no concurrent run and no apiserver can
        # collide with. Admitting a listener that answers `/health` but does not serve
        # `/v3/kv/put` meant the failure surfaced later, in the middle of the V3 test, as
        # "expected exactly one key/value pair, got 0" - a misleading report about
        # encryption for what is actually a transport problem.
        probe_key = f"{_ETCD_REUSE_PROBE_KEY_PREFIX}{prefix.split('/', 1)[0]}"
        refusal = _etcd_reuse_refusal(configured_url, probe_key=probe_key)
        if refusal is None:
            logger.info(
                "etcd already running at %s and usable; reusing it with prefix %s",
                configured_url,
                prefix,
            )
            # The Go counterpart returns `func() {}` here. This session did not create
            # the instance, so it must not stop it and must not delete its data: the
            # developer's own etcd has to survive the run that borrowed it.
            yield SharedEtcdInstance(
                url=configured_url,
                prefix=prefix,
                data_dir=None,
                log_file=None,
                pid=None,
                reused=True,
            )
            return

        # AN EXPLICIT URL IS AN INSTRUCTION, NOT A HINT. When the operator named the
        # endpoint, quietly spawning a different one would run the suite against
        # something they did not choose and report green about it. When the endpoint
        # is merely this file's default, whatever is listening is a coincidence and
        # falling through to the pinned private binary is the correct repair.
        if url_was_requested:
            raise _HarnessError(
                f"{ENV_ETCD_URL}={configured_url} names an etcd that answers but cannot be "
                f"used: {refusal}. It is not adopted and no substitute is started, because "
                f"you asked for this endpoint: running the suite against a different one "
                f"would report a result about an instance nobody chose. Point "
                f"{ENV_ETCD_URL} at a conforming etcd, or unset it to let this fixture start "
                f"the pinned {REQUIRED_ETCD_VERSION} binary itself."
            )
        logger.info(
            "something is listening at the default %s but it cannot be reused (%s); starting "
            "a private instance instead",
            configured_url,
            refusal,
        )
    elif url_was_requested:
        logger.info(
            "%s=%s is set but nothing healthy is listening there; starting a private "
            "instance instead, as startEtcd does",
            ENV_ETCD_URL,
            configured_url,
        )

    binary: Path = request.getfixturevalue("etcd_binary")

    # `integration_test_etcd_data` is the prefix framework.RunCustomEtcd hands to
    # os.MkdirTemp (test/integration/framework/etcd.go:73, :108), carried over so a
    # directory that ever outlives a crashed run is recognisable as this harness's.
    data_dir = Path(tempfile.mkdtemp(prefix=_ETCD_DATA_DIR_PREFIX))
    try:
        log_path = _etcd_log_path(data_dir)
        # Reselect the port and respawn when - and only when - etcd could not bind.
        # _free_port cannot close the bind-0 race on its own (nothing can), so the
        # race is recovered from here instead. Every other startup failure breaks
        # out on the first attempt with its original diagnostic intact.
        for attempt in range(1, _ETCD_PORT_ATTEMPTS + 1):
            url = f"http://{DEFAULT_ETCD_HOST}:{_free_port()}"
            process, log_handle = _spawn_etcd(binary, url, data_dir / "data", log_path)
            try:
                _await_etcd_ready(process, url, log_path)
            except _HarnessError:
                # Reap this attempt before deciding, so a half-started etcd never
                # holds the port into the next one.
                _terminate_etcd(process)
                log_handle.close()
                if attempt == _ETCD_PORT_ATTEMPTS or not _looks_like_a_port_conflict(log_path):
                    raise
                logger.warning(
                    "etcd could not bind %s (attempt %d of %d); reselecting a port and "
                    "retrying",
                    url,
                    attempt,
                    _ETCD_PORT_ATTEMPTS,
                )
                # A fresh data directory for the retry: the previous attempt exited
                # during startup, and reusing a directory it may have begun writing
                # would turn a port conflict into a corrupt-datastore failure that
                # looks nothing like its cause.
                _remove_data_dir(data_dir / "data")
                continue
            break
    except BaseException:
        # Nothing is running by this point - either the spawn itself failed, or the
        # loop above reaped the attempt it gave up on - but the temp directory
        # already exists and would otherwise outlive the run. Removing it here is
        # what keeps "the fixture failed" from also meaning "the fixture littered".
        _remove_data_dir(data_dir)
        raise

    logger.info(
        "started etcd (pid %d) at %s, data dir %s, log %s, storage prefix %s",
        process.pid,
        url,
        data_dir,
        log_path,
        prefix,
    )
    instance = SharedEtcdInstance(
        url=url,
        prefix=prefix,
        data_dir=data_dir,
        log_file=log_path,
        pid=process.pid,
        reused=False,
    )
    try:
        yield instance
    finally:
        # EVERY cleanup step runs, even when an earlier one raises. Sequentially
        # chained teardown means the first failure silently cancels the rest: a
        # _terminate_etcd that threw would leave the log handle open, the port held
        # and the data directory on disk, and the assertions below - the goleak
        # substitute - would never be reached to say so. Each step is therefore
        # attempted independently and its failure recorded, so teardown reports
        # everything that went wrong rather than only the first thing.
        teardown_failures: list[str] = []

        def _attempt(label: str, action: Callable[[], Any]) -> Any:
            """Run one cleanup step, recording rather than propagating its failure."""
            try:
                return action()
            except Exception as exc:
                teardown_failures.append(f"{label}: {exc!r}")
                return None

        status = _attempt("terminate etcd", lambda: _terminate_etcd(process))
        _attempt("close the etcd log handle", log_handle.close)
        released = _attempt(
            "wait for the port to be released",
            lambda: _wait_for_port_release(instance.host, instance.port),
        )
        removed = _attempt("remove the etcd data directory", lambda: _remove_data_dir(data_dir))
        leaked_threads = _attempt("enumerate this fixture's threads", _owned_live_threads) or ()
        logger.info(
            "etcd (pid %d) exited with status %s; port released=%s, data dir removed=%s",
            process.pid,
            status,
            released,
            removed,
        )

        assert not teardown_failures, (
            "etcd teardown steps raised, so the session cannot claim it left nothing "
            f"behind: {teardown_failures}. Every step was still attempted; the "
            "assertions that follow report which resources are actually leaking."
        )

        # THE goleak SUBSTITUTE (AAP §0.4.1.2: Python has no `-race` and no
        # goleak, so what those tools would have caught is asserted explicitly).
        # These run after every cleanup step precisely so that cleanup completes
        # first and only then reports - the ordering is what lets an assertion be
        # both truthful and non-destructive.
        assert status is not None, (
            f"etcd (pid {process.pid}) survived SIGTERM and SIGKILL and was not reaped "
            f"within {_ETCD_TERM_GRACE_SECONDS + _ETCD_KILL_GRACE_SECONDS:.0f}s; the "
            f"session is leaking a process"
        )
        assert process.poll() is not None, (
            f"etcd (pid {process.pid}) is still running after teardown"
        )
        assert released, (
            f"{instance.host}:{instance.port} could not be bound again within "
            f"{_PORT_RELEASE_TIMEOUT_SECONDS:.0f}s of tearing etcd down; the listening "
            f"socket is leaking and a later run on this port would fail for an "
            f"unrelated-looking reason"
        )
        assert not leaked_threads, (
            f"threads started by this fixture are still alive after teardown: "
            f"{leaked_threads}. This fixture starts none by design - etcd's stderr goes "
            f"to a file rather than being pumped by a reader thread - so a name here "
            f"means a background thread was added without a shutdown path"
        )
        # The data directory completes the set. This fixture's INVARIANT LOCKED says
        # "nothing is left behind - no process, no listening socket, no temporary
        # directory", and the third clause was the one being computed and thrown
        # away: `removed` was assigned, logged and never asserted, so the claim was
        # documented but unenforced. Asserting it costs nothing that the two
        # assertions above do not already cost - each of them equally reports at the
        # end of a session - and an unasserted invariant is indistinguishable from
        # an untrue one. It runs LAST because it is the least consequential of the
        # three: a leaked directory wastes disk, while a leaked process or port
        # poisons the next run.
        assert removed, (
            f"the etcd data directory {data_dir} was not removed, so this session left a "
            f"temporary directory behind and its stated invariant does not hold. Each run "
            f"creates a fresh {_ETCD_DATA_DIR_PREFIX}* directory, so a persistent failure "
            f"here accumulates one datastore per run until the disk fills - and every "
            f"leftover is a copy of whatever the integration tier wrote, including "
            f"encrypted Secret material."
        )


@pytest.fixture(scope="session")
def parity_baseline(repo_root: Path) -> Mapping[str, Any]:
    """The committed record of what the Go oracle reports today, parsed and no more.

    PORTS: nothing - and that absence is the point. This manifest is a NEW artifact
    the migration requires. The engagement's single success criterion is "All tests
    should pass the same way as they pass today", which is a claim about outcomes,
    and before the manifest existed the only record of those outcomes was a
    human-readable table no comparator can consume (AAP §0.2.1.9).

    INVARIANT LOCKED: the parity tier reads the SAME file the generator writes, and
    it can never read a manifest that would let the contract pass vacuously.

    Each row records ``(package, test, subtest, action, elapsed)`` where ``action``
    is ``pass``, ``fail`` or ``skip`` - for example ``{"package":
    "k8s.io/kubernetes/cluster/gce/gci", "test":
    "TestServerOverride/ETCD-SERVERS_is_not_set_-_default_override", "action":
    "pass", "elapsed": 0.06}``. ``elapsed`` is recorded and never compared: runtime
    is expected to differ between Go and Python, and the contract compares verdicts.

    Parsed and NOT interpreted. ``tests/parity/conftest.py`` owns the
    ``(package, test, subtest)`` index and ``tests/parity/test_parity_contract.py``
    owns completeness, verdict equality and no-new-failure. Indexing here would
    give the tree two answers and would violate the rule that a child conftest
    must not need to shadow this one.

    NO SKIP PATH. Every way this can go wrong - the file is absent, unreadable,
    not JSON, empty, row-less, or narrower than the measured domain - is a LOUD
    failure. The baseline is a committed artifact, and a fixture that skipped when
    it was missing meant deleting it turned the parity tier green: precisely the
    hard gate AAP §§0.4.5 and 0.7 require it to be.

    Returns:
        The manifest as a DEEPLY read-only mapping - nested rows, lists and count
        maps included, since it is session-scoped shared state - already checked
        against the complete measured domain.

    Raises:
        _HarnessError: the manifest is absent, unreadable, unparsable, empty,
            carries no verdict rows, or does not describe the complete measured
            domain. Every one of those FAILS loudly and none of them skips: the
            manifest is committed, so it is present in any checkout, and a skipped
            parity gate reads as green to anyone who did not look. Skips here are
            reserved for genuinely external prerequisites - see ``etcd_binary`` and
            ``apiserver_binary``, which are statements about the MACHINE rather than
            about the repository.
    """
    return _load_parity_baseline(_resolve_baseline_path(repo_root))


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------


def _is_integration_item(item_path: Path) -> bool:
    """True when ``item_path`` is inside ``python/tests/integration/``.

    Resolved against this file's own directory and compared COMPONENT BY
    COMPONENT, never by substring. A substring test for ``"integration"`` would
    also match ``tests/unit/parity/`` siblings named after integration concepts,
    and - concretely - a first-component test is what keeps
    ``tests/unit/parity/test_generate_baseline_contracts.py`` (a pure unit test of
    the generator) from being confused with ``tests/parity/`` (the contract
    itself). Getting that wrong would put the generator's own unit tests inside the
    infrastructure-gated tier.
    """
    try:
        relative = item_path.resolve().relative_to(_TESTS_DIR)
    except ValueError:
        return False
    return relative.parts[:1] == (_INTEGRATION_DIR_NAME,)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Apply the ``integration`` marker to every item under ``tests/integration/``.

    APPLIES a marker; REGISTERS none. The vocabulary is declared once, in
    ``python/pyproject.toml`` (``integration``, ``shell``, ``config``, ``parity``,
    ``slow``), and ``--strict-markers`` makes an unregistered name a collection
    error - so this hook can only ever use one of those five.

    WHY ONLY THIS ONE MARKER. ``integration`` is the single marker whose ABSENCE
    has a cost: ``hack/make-rules/test-python.sh -m "not integration"`` is the fast
    path, and an integration test that forgot its marker would be collected there
    and would try to start a real etcd and a real API server in a run that
    promised not to. Adding it here makes that impossible by construction.

    The other four are deliberately left alone, on measured evidence rather than
    taste: ``tests/unit/helpers/test_bash_contracts.py:60`` and
    ``test_manifest_contracts.py:61`` both declare ``pytestmark =
    pytest.mark.shell`` from OUTSIDE any ``shell/`` directory, because they invoke
    bash. This tier therefore marks by what a module DOES, not by where it lives,
    and inferring ``shell``, ``config`` or ``parity`` from a path would contradict
    that and mislabel modules.

    Idempotent: an item that already carries the marker is left untouched, so a
    module that marks itself explicitly - which remains the preferred, most legible
    style - is never marked twice.

    Args:
        items: The collected items, modified in place. pytest passes ``session``
            and ``config`` too; they are not requested because they are not needed,
            and a hook that accepts only what it uses cannot misuse the rest.
    """
    for item in items:
        item_path = getattr(item, "path", None)
        if not isinstance(item_path, Path) or not _is_integration_item(item_path):
            continue
        if any(mark.name == _INTEGRATION_MARKER for mark in item.iter_markers()):
            continue
        item.add_marker(getattr(pytest.mark, _INTEGRATION_MARKER))
