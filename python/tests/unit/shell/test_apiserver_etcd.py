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

"""The etcd flags the shipped kube-apiserver generator assembles: overrides, storage, mTLS.

Three test functions and six cases, the complete port of
``cluster/gce/gci/apiserver_etcd_test.go``. They contribute 3 top-level
identities and 6 subtest verdicts to the measured 648-case ``cluster/gce/gci``
baseline:

    Go (apiserver_etcd_test.go)            Here
    -------------------------------------  --------------------------------------
    TestServerOverride   L45   (2 cases)   test_server_override
    TestStorageOptions   L95   (2 cases)   test_storage_options
    TestTLSFlags         L158  (2 cases)   test_tls_flags

AAP §0.4.2.1 (the V8 shell-boundary blueprint that specifies this module) /
tech-spec §6.6.1.1 (the property the whole tier exists to preserve: the test
"proves the shipped shell generator, not a re-implementation") /
tech-spec §2.1.8 (the ``":-true"`` backward-compatibility shim) /
tech-spec §6.2.4.6 (etcd access-control hardening, control V8).

INVARIANTS LOCKED BY THIS MODULE

1. **The events keyspace is addressed explicitly** -- ``test_server_override``.
   With ``ETCD_SERVERS`` unset an override is still emitted, and when one IS
   supplied it is passed through untouched, so neither a missing configuration
   nor a present one can quietly route events at the main etcd store.
2. **Each storage flag is emitted if and only if its variable is set** --
   ``test_storage_options``. The absent half is the load-bearing one: it proves
   the generator synthesises no backend, media type or compaction interval of its
   own, which would silently override whatever the API server defaults to.
3. **F-008-RQ-001: the API-server-to-etcd transport is mutually authenticated
   when the credentials are present** -- ``test_tls_flags``. All six etcd mTLS
   credentials present must yield the https endpoint together with all three of
   ``--etcd-cafile``, ``--etcd-certfile`` and ``--etcd-keyfile``, each naming the
   configured path. A missing one of those means an unauthenticated or unverified
   connection to the datastore that holds every Secret in the cluster.

WHAT ACTUALLY RUNS: THE SHIPPED BASH

Nothing here re-implements anything. Every case renders a ``kube-env`` from the
SHIPPED ``testdata/kube-apiserver/{base,etcd}.template`` pair, sources it
together with the SHIPPED ``configure-helper.sh`` and
``configure-kubeapiserver.sh``, runs ``start-kube-apiserver``, then decodes the
static-pod manifest the generator wrote and searches the container command line.
The templates are read, never copied under ``python/``; the scripts are invoked,
never edited and never ported. That is what makes a green verdict here evidence
about the artefact this repository ships rather than about a Python translation of
it. The mechanics -- the throwaway ``KUBE_HOME``, the Go ``text/template``
renderer, the ``bash`` invocation and the manifest decode -- belong to
tests/unit/shell/conftest.py and tests/helpers/, and the case data belongs to
tests/fixtures/etcd_env_cases.py. This module contributes the assertions and
nothing else.

No etcd and no API server are needed: ``pytest -m "not integration"`` runs every
case in this file.

ASSERTION SEMANTICS: ABORT ON THE FIRST FAILURE, MEASURED NOT ASSUMED

The Go ancestor uses ``t.Fatalf`` four times and ``t.Errorf`` not once, so every
assertion there ABORTS its subtest. A bare ``assert`` per parametrized case
reproduces that exactly, and ``pytest.Subtests`` -- the accumulate-and-continue
analogue of ``t.Errorf`` that V1's bootstrap-binding enumeration needs -- would be
wrong here: there is nothing to accumulate, because each of the six cases is an
independent rendering of the generator and is reported under its own node id.

CONTAINMENT, NEVER EQUALITY -- AND THE ``1ss`` THAT PROVES WHY

Every expectation is a SUBSTRING of the joined command line, because the Go
original asserts with ``strings.Contains`` (apiserver_etcd_test.go L87, L144,
L150, L209). Two consequences that a well-meaning tidy-up would break:

* ``--storage-backend`` with no value is how "this flag is absent entirely" is
  expressed. A value-bearing spelling would pass while the flag was present with
  some other value.
* An expectation may be a strict PREFIX of what is rendered.
  ``configure-kubeapiserver.sh:68`` emits
  ``--etcd-compaction-interval=${ETCD_COMPACTION_INTERVAL_SEC}s``, appending a
  literal ``s``, and the supplied interval is ``1s`` -- so the flag the generator
  really writes is ``--etcd-compaction-interval=1ss``, verified by rendering it,
  while the expectation stays ``--etcd-compaction-interval=1s`` and passes on
  containment alone. Do not "correct" the expectation to ``1ss`` (that would
  encode today's double-``s`` as a requirement), do not change the input to a
  bare ``1`` (that tests an input the oracle never used), and do not switch to
  equality (that fails a green case).

⚠ THE PLAINTEXT PARADOX -- DO NOT RECONCILE IT

``test_tls_flags[mtls-disabled]`` renders a COMPLETELY EMPTY environment and
expects the PLAINTEXT endpoint ``--etcd-servers=http://127.0.0.1:2379``. That
reads, at first glance, like a test that blesses an insecure transport. It is
not, and AAP §0.10.4 names it the single subtlest parity requirement in the
migration and the one most likely to be broken by a well-meaning agent.

With all six credentials absent, ``configure-etcd-params`` reaches its all-absent
branch and consults ``${ETCD_APISERVER_ALLOW_INSECURE:-true}``
(configure-kubeapiserver.sh:41). The shipped ``etcd.template`` assigns
``ETCD_APISERVER_ALLOW_INSECURE`` nowhere -- all sixteen of its lines were
checked -- so the ``":-true"`` default applies and the plaintext-with-WARNING
branch is taken. That default is NOT the production posture: the script's own
comment block (L26-40) records it as a backward-compatibility shim for
direct-invocation contexts that never load the GCE profiles, and names
apiserver_etcd_test.go as one of them. Both shipped profiles set
``ETCD_APISERVER_ALLOW_INSECURE=false``, so a real deployment missing its etcd
certificates takes the else branch, prints its refusal and exits 1.

Two truths therefore hold at once and BOTH must stay green:

1. Invoked directly with no environment, as here, the generator yields the
   plaintext endpoint. This case is the shim's only coverage.
2. Invoked with the hardened profile defaults and no credentials, the generator
   FAILS CLOSED with exit 1 -- proved separately by
   tests/unit/shell/test_etcd_failclosed.py, which supplies the variable through
   tests/fixtures/templates/kube_env.j2 because no shipped template can express
   it, and by tests/unit/config/test_audit_and_etcd_profile_defaults.py, which
   locks the ``false`` default on both profiles (F-008-RQ-002).

So: do not populate that case's environment, do not add
``ETCD_APISERVER_ALLOW_INSECURE`` to it, do not "correct" its expectation to
https, and do not mark it ``xfail`` or skip it. Each of those deletes the shim's
only coverage while appearing to harden the suite, and makes the case fail
against the unmodified shipped script -- the definition of a port that has
drifted.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

* It asserts NO exit status. The exit-1 fail-closed path is
  test_etcd_failclosed.py's alone; conflating the two would put one module in
  charge of two contradictory-looking truths and invite exactly the "fix" the
  note above forbids.
* It declares no case data and no environment type. Those live in
  tests/fixtures/etcd_env_cases.py -- one definition, shared with
  test_apiserver_kms.py and test_etcd_failclosed.py -- so a case cannot drift
  from the id the parity map binds it to.
* It defines no fixture. Every fixture of this tier lives in
  tests/unit/shell/conftest.py, because under ``--doctest-modules`` a module-,
  package- or session-scoped autouse fixture declared inline in a test module can
  execute twice.
* It contains no key material. Every credential-shaped value is a placeholder
  echoing its own field name, exactly as the Go table writes it, because the
  shipped script only tests those variables for emptiness and copies the *path*
  variables into flags.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pytest

from tests.fixtures.etcd_env_cases import (
    SERVER_OVERRIDE_CASES,
    STORAGE_OPTIONS_CASES,
    TLS_FLAGS_CASES,
    ETCDEnvCase,
    KubeAPIServerETCDEnv,
)
from tests.helpers.manifest import (
    BASE_TEMPLATE_RELATIVE_PATH,
    ETCD_TEMPLATE_RELATIVE_PATH,
    ETCD_TEMPLATE_TARGET,
    KUBE_APISERVER_MANIFEST_FILE_NAME,
    KUBE_APISERVER_SCRIPT_NAMES,
    KUBE_APISERVER_START_FUNC_NAME,
)

if TYPE_CHECKING:
    # Type-only, so nothing imports a conftest at runtime: pytest owns that
    # module's lifetime, and a second import of it would be a second copy of
    # every class in it.
    from tests.unit.shell.conftest import KubeEnvRenderFactory, ManifestCaseFactory

# The tier marker, and the only one. python/pyproject.toml declares exactly five
# markers under ``--strict-markers``, so a typo here is a collection error rather
# than a silently unmarked test. Deliberately NOT ``integration``: this module
# needs no etcd and no API server, only bash.
pytestmark = pytest.mark.shell

#: The requirement identifier quoted in every failure message and passed to the
#: invoker, so a CI failure reads as a requirement violation rather than a value
#: mismatch -- and so the reader of that failure, who is usually not the author of
#: the test, can find what the assertion protects. F-008-RQ-001 is the etcd
#: mutual-TLS transport requirement, which AAP §0.4.2.1 assigns to this whole
#: module: ``configure-etcd-params`` assembles the override, storage and TLS flags
#: in one pass, so all three functions exercise one requirement's code path.
#: Deliberately a requirement ID from this repository's own specification -- no
#: CIS or NSA control number is asserted anywhere, because none is enumerated in
#: the repository to assert.
_REQUIREMENT: Final[str] = "F-008-RQ-001"


# ---------------------------------------------------------------------------
# Case identity
# ---------------------------------------------------------------------------


def _ids(cases: tuple[ETCDEnvCase, ...]) -> list[str]:
    """Return the explicit parametrize ids of ``cases``, in declaration order.

    The ids are DERIVED from the case table rather than written out here, because
    they are addressable identifiers rather than cosmetics:
    ``tests/parity/parity_map.py`` binds each Go verdict to one of them, and AAP
    §0.4.5 fixes one mapping literally --
    ``("k8s.io/kubernetes/cluster/gce/gci", "TestTLSFlags", "mTLS_enabled")``
    resolves to ``test_apiserver_etcd.py::test_tls_flags[mtls-enabled]``. A second
    hand-written spelling of any id could disagree with the description it names;
    reading them from :attr:`~tests.fixtures.etcd_env_cases.ETCDEnvCase.case_id`
    makes that impossible.

    Explicit rather than left to pytest's own id generation, which would render a
    frozen dataclass as ``case0``/``case1`` -- unaddressable from a ``-k`` or
    ``pytest "file::test[id]"`` selector, and unmappable by the parity contract.
    """
    return [case.case_id for case in cases]


# ---------------------------------------------------------------------------
# The body all three Go functions share, factored once
# ---------------------------------------------------------------------------


def _rendered_exec_args(
    env: KubeAPIServerETCDEnv,
    *,
    case_factory: ManifestCaseFactory,
    renderer: KubeEnvRenderFactory,
) -> str:
    """Run the shipped generator for ``env`` and return its container command line.

    The port of the body every one of the three Go test functions runs -- they are
    IDENTICAL apart from the ``dontWant`` loop that only ``TestStorageOptions``
    has, so the body is written once here and the difference lives in the case
    data (apiserver_etcd_test.go L71-85, L128-142, L193-207). Five steps, in the
    oracle's order:

    1. Open a case in the FULL shape,
       ``newManifestTestCase(t, kubeAPIServerManifestFileName,
       kubeAPIServerStartFuncName, nil)``: a throwaway ``KUBE_HOME`` with the
       shipped ``kube-apiserver.manifest`` copied in and the destination
       directory the generator's final ``cp`` needs. No auxiliary manifests,
       matching Go's ``nil``. Teardown is the ``manifest_case`` fixture's, and it
       runs whether this test passes or fails -- the ``defer c.tearDown()``
       guarantee.
    2. Build the render context, which is where the two runtime-injected fields
       are set. Go assigns them on EVERY case, including the ones whose
       environment is otherwise the zero value: ``tc.env.KubeHome = c.kubeHome``
       and ``tc.env.KubeAPIServerRunAsUser = strconv.Itoa(os.Getuid())``
       (L73-74, L130-131, L195-196). So no case here is truly "empty" either --
       the two zero-value cases have exactly those two fields populated, and
       ``KubeEnvRenderFactory.context`` performs the injection through the frozen
       dataclass's ``dataclasses.replace``-based ``with_runtime``, returning a
       copy so the module-level case table cannot be mutated. ``kube_home`` is
       this case's own tree, so the generator reads and writes what the
       assertions read back.
    3. Invoke the shipped generator, mirroring
       ``mustInvokeFunc(tc.env, []string{"configure-helper.sh",
       kubeAPIServerConfigScriptName}, "etcd.template",
       "testdata/kube-apiserver/base.template",
       "testdata/kube-apiserver/etcd.template")``. Note the shapes of those last
       arguments differ and both are as the oracle writes them: the target is a
       template NAME selected among the parsed set, while the two that follow are
       RELATIVE FILE PATHS -- resolved, like the bare ``source
       configure-helper.sh``, against the working directory
       ``<repo>/cluster/gce/gci``. ``base.template`` is parsed without ever being
       the target, because ``etcd.template`` invokes the ``base`` template it
       defines. A non-zero exit raises, which is the ``t.Fatalf`` posture: this
       module never treats an exit status as data.
    4. Decode the manifest the generator WROTE, not the one the harness copied in
       -- ``mustLoadPodFromManifest``. That is what makes the assertions evidence
       about the generator.
    5. Join the container command with a single space, the port of
       ``strings.Join(c.pod.Spec.Containers[0].Command, " ")`` (L85, L142, L207).
       Joined, not parsed, because every expectation is a substring of exactly
       this string; reformatting it -- normalising whitespace, splitting on ``=``,
       sorting flags -- would silently change what "contains" means.

    ``__tracebackhide__`` is the ``t.Helper()`` analogue: a failure inside the
    harness is reported at the calling test's line, where the case that provoked
    it is visible.

    Args:
        env: The case's declared environment, straight from the shared table.
        case_factory: The tier's ``manifest_case`` fixture.
        renderer: The tier's ``render_kube_env`` fixture.

    Returns:
        The generated pod's container command line as one space-joined string.
    """
    __tracebackhide__ = True

    case = case_factory(
        manifest=KUBE_APISERVER_MANIFEST_FILE_NAME,
        func_name=KUBE_APISERVER_START_FUNC_NAME,
    )
    case.invoke_func(
        renderer.context(env, kube_home=case.kube_home),
        KUBE_APISERVER_SCRIPT_NAMES,
        ETCD_TEMPLATE_TARGET,
        (BASE_TEMPLATE_RELATIVE_PATH, ETCD_TEMPLATE_RELATIVE_PATH),
        requirement=_REQUIREMENT,
    )

    pod = case.load_pod_from_manifest()
    containers = pod.spec.containers
    assert containers, (
        f"{_REQUIREMENT}: the generated pod manifest at "
        f"{case.kube_home} declares NO container, so there is no command line to "
        "assert against. Go indexes Containers[0] and would panic here; failing "
        "with this message instead keeps the diagnosis local to the generator run."
    )
    return " ".join(containers[0].command)


def _assert_flags(case: ETCDEnvCase, exec_args: str) -> None:
    """Assert every ``want`` appears in ``exec_args`` and every ``dont_want`` does not.

    SUBSTRING CONTAINMENT, NEVER EQUALITY, which is the whole of the oracle's
    assertion strategy: ``strings.Contains(execArgs, f)`` for ``want``
    (apiserver_etcd_test.go L87, L144, L209) and its negation for ``dontWant``
    (L150). See the module docstring for the ``1ss`` rendering that makes the
    difference load-bearing rather than stylistic, and for why a bare flag name
    with no value is the only way to express "absent entirely".

    ABORT ON THE FIRST FAILURE, mirroring ``t.Fatalf``: a bare ``assert`` in each
    loop stops the case, exactly as the oracle does. Nothing accumulates.

    Both loops run for all three test functions even though only
    ``test_storage_options`` supplies a ``dont_want`` -- an empty tuple makes that
    loop a no-op, which is precisely what the other two Go functions do by having
    no ``dontWant`` field to iterate.

    The two guards ahead of the loops close false-pass holes rather than adding
    expectations: neither can fail for any of the six ported cases, so neither can
    change a verdict, but each turns a silent vacuous pass into a legible failure.
    A security assertion that passes while asserting nothing is worse than no
    assertion at all -- and an absence assertion is the shape most exposed to it,
    since "not in" is trivially satisfied by an empty string.

    Args:
        case: The case being asserted, quoted by description in every message.
        exec_args: The joined container command line from
            :func:`_rendered_exec_args`.
    """
    __tracebackhide__ = True

    assert case.want or case.dont_want, (
        f"{_REQUIREMENT} ({case.desc}): this case declares neither a want nor a "
        "dont_want expectation, so it would report a pass while asserting nothing "
        "about the generated flags. Every one of the six ported cases carries at "
        "least one; see tests/fixtures/etcd_env_cases.py."
    )
    assert exec_args.strip(), (
        f"{_REQUIREMENT} ({case.desc}): the generated pod's container command line "
        "is empty, so no flag assertion below would mean anything -- an absence "
        "check in particular would pass trivially. The shipped generator always "
        "emits a command, so an empty one means the manifest was not generated by "
        "this run."
    )

    for flag in case.want:
        assert flag in exec_args, (
            f"{_REQUIREMENT} ({case.desc}): got {exec_args!r}, want it to contain "
            f"{flag!r}"
        )

    for flag in case.dont_want:
        assert flag not in exec_args, (
            f"{_REQUIREMENT} ({case.desc}): got {exec_args!r}, but it was not "
            f"expected to contain {flag!r}"
        )


# ---------------------------------------------------------------------------
# TestServerOverride (apiserver_etcd_test.go:45) -- the events-store override
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", SERVER_OVERRIDE_CASES, ids=_ids(SERVER_OVERRIDE_CASES))
def test_server_override(
    case: ETCDEnvCase,
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """INVARIANT: the events keyspace is always addressed explicitly.

    Ports ``TestServerOverride``, both cases:

    * ``etcd-servers-is-not-set-default-override`` -- with ``ETCD_SERVERS`` empty
      the generator takes its first override branch
      (configure-kubeapiserver.sh:53-54) and must substitute its own default,
      ``--etcd-servers-overrides=/events#http://127.0.0.1:4002``. Losing it would
      point the high-churn events keyspace at the main store, whose contents are
      the ones encryption at rest protects.
    * ``etcd-servers-and-etcd-servers-overrides-are-set`` -- with both set the elif
      branch (L55-56) must pass the SUPPLIED override through untouched, so an
      operator's explicit routing is never quietly replaced by the default.
    """
    exec_args = _rendered_exec_args(
        case.env, case_factory=manifest_case, renderer=render_kube_env
    )
    _assert_flags(case, exec_args)


# ---------------------------------------------------------------------------
# TestStorageOptions (apiserver_etcd_test.go:95) -- the three gated storage flags
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", STORAGE_OPTIONS_CASES, ids=_ids(STORAGE_OPTIONS_CASES))
def test_storage_options(
    case: ETCDEnvCase,
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """INVARIANT: each storage flag is emitted if and only if its variable is set.

    Ports ``TestStorageOptions``, the ONLY one of the three Go functions with a
    ``dontWant`` loop (L149-153), so this is the one case pair that exercises both
    the presence and the absence path of :func:`_assert_flags`:

    * ``storage-options-are-supplied`` -- ``--storage-backend=StorageBackend``,
      ``--storage-media-type=StorageMediaType`` and
      ``--etcd-compaction-interval=1s`` must all appear (L59-69 of the script,
      each flag gated independently by its own ``-n`` test).
    * ``storage-options-are-not-supplied`` -- with nothing supplied, none of
      ``--storage-backend``, ``--storage-media-type`` or
      ``--etcd-compaction-interval`` may appear AT ALL. The expectations are bare
      flag names precisely so that a flag present with any value fails.

    THE COMPACTION EXPECTATION IS A PREFIX OF WHAT IS RENDERED, AND THAT IS
    CORRECT AS WRITTEN. ``configure-kubeapiserver.sh:68`` emits
    ``--etcd-compaction-interval=${ETCD_COMPACTION_INTERVAL_SEC}s`` and the case
    supplies ``1s``, so the generator really writes
    ``--etcd-compaction-interval=1ss``. The expectation stays
    ``--etcd-compaction-interval=1s`` and passes on containment, exactly as the Go
    table has it -- see the module docstring for why all three of the tempting
    "fixes" are wrong.
    """
    exec_args = _rendered_exec_args(
        case.env, case_factory=manifest_case, renderer=render_kube_env
    )
    _assert_flags(case, exec_args)


# ---------------------------------------------------------------------------
# TestTLSFlags (apiserver_etcd_test.go:158) -- the etcd transport, control V8
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", TLS_FLAGS_CASES, ids=_ids(TLS_FLAGS_CASES))
def test_tls_flags(
    case: ETCDEnvCase,
    manifest_case: ManifestCaseFactory,
    render_kube_env: KubeEnvRenderFactory,
) -> None:
    """INVARIANT (F-008-RQ-001): present etcd credentials yield a mutually authenticated transport.

    Ports ``TestTLSFlags``. The function name and the id ``mtls-enabled`` are a
    CONTRACT, not a preference: AAP §0.4.5 maps the baseline entry
    ``("k8s.io/kubernetes/cluster/gce/gci", "TestTLSFlags", "mTLS_enabled")`` to
    ``python/tests/unit/shell/test_apiserver_etcd.py::test_tls_flags[mtls-enabled]``
    verbatim, so renaming either breaks the parity contract rather than merely
    reading differently.

    ``mtls-enabled`` -- all six credentials present, so the generator takes its
    mTLS branch (configure-kubeapiserver.sh:21-25) and must emit the https
    endpoint plus the three file flags. THE FLAG NAMES AND THEIR VALUE SOURCES DO
    NOT LINE UP IN THE OBVIOUS WAY, and the mapping is transcribed from the script
    rather than inferred:

        --etcd-cafile    <- ETCD_APISERVER_CA_CERT_PATH      -> CACertPath
        --etcd-certfile  <- ETCD_APISERVER_CLIENT_CERT_PATH  -> APIServerCertPath
        --etcd-keyfile   <- ETCD_APISERVER_CLIENT_KEY_PATH   -> APIServerKeyPath

    The crossing is the shipped ``etcd.template``'s: the API server's own key and
    cert render into the ``..._SERVER_...`` variables while the etcd key and cert
    render into the ``..._CLIENT_...`` ones, because from etcd's point of view the
    API server IS the client. Reading ``--etcd-certfile`` as "the etcd cert" and
    swapping the values would produce a test that passes against a
    misconfiguration.

    ``mtls-disabled`` -- ⚠ **THE PLAINTEXT PARADOX. DO NOT "FIX" THIS CASE.** It
    renders a deliberately EMPTY environment and expects the PLAINTEXT endpoint
    ``--etcd-servers=http://127.0.0.1:2379``, because the shipped
    ``etcd.template`` assigns ``ETCD_APISERVER_ALLOW_INSECURE`` nowhere, so
    ``configure-etcd-params`` evaluates ``${ETCD_APISERVER_ALLOW_INSECURE:-true}``
    (script L41) and takes the plaintext-with-WARNING branch. That ``":-true"`` is
    a documented backward-compatibility shim for direct unit-test invocation
    (tech-spec §2.1.8; the script's own comment at L26-40 names this very file),
    and this case is its ONLY coverage. The hardened deployment path -- absent
    credentials with the profiles' ``ETCD_APISERVER_ALLOW_INSECURE=false``, which
    must print its refusal and exit 1 -- is proved by
    tests/unit/shell/test_etcd_failclosed.py, and the profile defaults themselves
    by tests/unit/config/test_audit_and_etcd_profile_defaults.py. Both truths hold
    at once and both must stay green; this module asserts no exit status at all.
    Populating this environment, adding the insecure-opt-out variable to it, or
    "correcting" the expectation to https would each delete the shim's only
    coverage while appearing to harden the suite, and would fail against the
    unmodified shipped script.
    """
    exec_args = _rendered_exec_args(
        case.env, case_factory=manifest_case, renderer=render_kube_env
    )
    _assert_flags(case, exec_args)
