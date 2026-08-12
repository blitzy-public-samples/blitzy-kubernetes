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

"""kube-apiserver etcd/KMS environment types and the six measured flag cases.

This module is the Python equivalent of the two anonymous environment structs the
Go shell-boundary tests build their ``kube-env`` from, plus the case table the
etcd tests iterate:

    ``kubeAPIServeETCDEnv``  cluster/gce/gci/apiserver_etcd_test.go lines 26-43
                             (16 fields) -> :class:`KubeAPIServerETCDEnv`
    ``kubeAPIServerEnv``     cluster/gce/gci/apiserver_kms_test.go lines 39-45
                             (5 fields)  -> :class:`KubeAPIServerEnv`

WHAT THIS MODULE IS

Data, and only data. It holds no assertion, no ``test_`` function, no pytest
fixture, no subprocess call and no file I/O; importing it costs nothing and can
never be the reason a test fails. The behaviour under test is Bash - the
``configure-etcd-params`` function of cluster/gce/gci/configure-kubeapiserver.sh,
invoked through the shipped ``testdata/kube-apiserver/{base,etcd,kms}.template``
trio - and the modules that invoke it and assert on its output are
tests/unit/shell/test_apiserver_etcd.py, test_apiserver_kms.py and
test_etcd_failclosed.py. The KUBE_HOME layout, the template renderer and the
bash invoker are ported separately in tests/helpers/manifest.py and
tests/helpers/bash.py; none of that logic is duplicated here.

HOW THE PIECES FIT

The Go harness renders a ``kube-env`` file from one of the shipped templates with
the environment struct as the template data, sources it together with
configure-helper.sh and configure-kubeapiserver.sh, runs ``start-kube-apiserver``,
then decodes the emitted static-pod manifest and searches the container command
line (cluster/gce/gci/configure_helper_test.go, ``mustCreateEnv`` and
``mustInvokeFunc``). Go's ``text/template`` addresses the struct by its exported
Go field names, so each class here exposes :meth:`to_template_context`, which
re-establishes exactly those names - see the template-context contract below.

AAP §0.5.1 (this file's CREATE row) / AAP §0.4.2.1 (the V8 shell-boundary
blueprint) / tech-spec §2.1.8 (the ``":-true"`` backward-compatibility shim) /
tech-spec §6.2.4.6 (etcd access-control hardening, control V8).

INVARIANT LOCKED BY THIS MODULE: the six ported cases assert what the Go table
asserts, with the same environments and the same expected flag substrings - and
in particular the ``mTLS disabled`` case keeps a COMPLETELY EMPTY environment and
still expects the PLAINTEXT etcd endpoint. That expectation is not a weakness in
the port; it is the behaviour the shipped script has, for the reason recorded on
:data:`TLS_FLAGS_CASES`. Populating that environment, or "correcting" its
expectation to https, would silently retire the compatibility shim from test
coverage while appearing to strengthen the suite.
"""

# The V8 fail-closed scenarios are NOT here. This module supplies only what the
# shipped templates can express, and ETCD_APISERVER_ALLOW_INSECURE appears in
# none of them; the four fail-closed scenarios set it through
# tests/fixtures/templates/kube_env.j2 and are asserted by
# tests/unit/shell/test_etcd_failclosed.py. Keeping the two apart is deliberate:
# see the note on :data:`TLS_FLAGS_CASES`.

import re
from dataclasses import dataclass, replace
from typing import TypeAlias

# The data Go's text/template receives, keyed by exported Go field name.
#
# ``object`` rather than ``str`` for the value type, and that is load-bearing
# rather than lax: ``kms.template`` guards a block with ``{{if
# .CloudKMSIntegration}}``, and Go's template truthiness treats a bool false as
# false but ANY non-empty string as true. A context that had stringified the flag
# to "False" would therefore render the block that a false flag must omit. The
# bool must stay a bool all the way to the renderer, so the value type must admit
# more than ``str``.
TemplateContext: TypeAlias = dict[str, object]

# ---------------------------------------------------------------------------
# Shared flag literals
# ---------------------------------------------------------------------------
# Three strings appear in more than one place - a case environment and that same
# case's expectation, or a comment explaining a branch - so each is named once
# here and referenced everywhere else. They are values measured from the shipped
# script, not choices this module is free to make.

# configure-kubeapiserver.sh lines 53-54: with ETCD_SERVERS unset the script
# falls back to this override, so the flag is the observable proof that the
# events store was not silently pointed at the main etcd.
DEFAULT_ETCD_SERVERS_OVERRIDES_FLAG = "--etcd-servers-overrides=/events#http://127.0.0.1:4002"

# configure-kubeapiserver.sh line 42: the plaintext loopback fallback, reachable
# only through the shim documented on :data:`TLS_FLAGS_CASES`.
PLAINTEXT_ETCD_SERVERS_FLAG = "--etcd-servers=http://127.0.0.1:2379"

# configure-kubeapiserver.sh line 22: the mutually-authenticated endpoint, which
# is also the ETCD_SERVERS value the mTLS case supplies.
MTLS_ETCD_SERVERS_ENDPOINT = "https://127.0.0.1:2379"


@dataclass(frozen=True)
class KubeAPIServerETCDEnv:
    """The 16-field ``kubeAPIServeETCDEnv`` of apiserver_etcd_test.py's Go ancestor.

    One instance is one rendering of ``testdata/kube-apiserver/etcd.template``:
    fifteen ``readonly`` assignments plus the ``base`` template invoked with
    :attr:`kube_home`. Fields are declared in Go's own order and every one of
    them defaults to the empty string, so ``KubeAPIServerETCDEnv()`` is the exact
    analogue of Go's zero value - which is what the two zero-value cases in the
    table below are built from, and what a template variable being *absent from
    the environment* means to the script under test.

    Frozen, because a case table is shared by every test that reads it: a case
    that could be mutated in place would leak into whichever test ran next, and
    the tier runs under pytest-randomly precisely so ordering cannot be relied
    upon. :meth:`with_runtime` returns a copy rather than mutating, which is the
    Python answer to the two assignments the Go harness makes to its own copy of
    the struct.
    """

    # -- Runtime-injected, left empty by every case (see :meth:`with_runtime`) --

    # -> base.template's bare ``{{.}}`` -> ``readonly KUBE_HOME=...``. The Go
    # harness assigns the temporary directory it created; case data never does.
    kube_home: str = ""
    # -> ``readonly KUBE_API_SERVER_RUNASUSER=...``. The Go harness assigns
    # ``strconv.Itoa(os.Getuid())``; case data never does.
    kube_api_server_run_as_user: str = ""

    # -- etcd endpoint and override --

    # -> ``readonly ETCD_SERVERS=...``. Empty selects the script's own default,
    # https for the mTLS branch and http for the plaintext branch.
    etcd_servers: str = ""
    # -> ``readonly ETCD_SERVERS_OVERRIDES=...`` (note: the Go field is singular,
    # the shell variable plural; both spellings are as shipped).
    etcd_servers_override: str = ""

    # -- The six etcd mTLS credentials --
    #
    # These six, and only these six, are what configure-etcd-params branches on
    # (configure-kubeapiserver.sh lines 21-51): all six present selects mTLS, all
    # six absent selects the plaintext-or-abort branch, and any other combination
    # is a partial configuration that exits 1. The mapping is genuinely
    # non-obvious and is worth reading twice, because the shipped template
    # crosses the two naming schemes - the API server's own key/cert pair renders
    # into the ETCD_APISERVER_SERVER_* variables while the etcd key/cert pair
    # renders into the ETCD_APISERVER_CLIENT_* variables:
    #
    #     ca_key          -> ETCD_APISERVER_CA_KEY
    #     ca_cert         -> ETCD_APISERVER_CA_CERT
    #     api_server_key  -> ETCD_APISERVER_SERVER_KEY
    #     api_server_cert -> ETCD_APISERVER_SERVER_CERT
    #     etcd_key        -> ETCD_APISERVER_CLIENT_KEY
    #     etcd_cert       -> ETCD_APISERVER_CLIENT_CERT
    ca_key: str = ""
    ca_cert: str = ""

    # -> ``readonly ETCD_APISERVER_CA_CERT_PATH=...``, emitted as
    # ``--etcd-cafile``. A path, not key material: see the note below on why no
    # field here ever holds a credential.
    ca_cert_path: str = ""

    api_server_key: str = ""
    api_server_cert: str = ""

    # -> ``readonly ETCD_APISERVER_CLIENT_CERT_PATH=...``, emitted as
    # ``--etcd-certfile``. Crossed naming again: an ``api_server_*`` field
    # renders into a ``CLIENT`` variable, because from etcd's point of view the
    # API server *is* the client.
    api_server_cert_path: str = ""
    # -> ``readonly ETCD_APISERVER_CLIENT_KEY_PATH=...``, emitted as
    # ``--etcd-keyfile``.
    api_server_key_path: str = ""

    etcd_key: str = ""
    etcd_cert: str = ""

    # -- Storage options, each gated independently by a ``-n`` test --

    # -> ``readonly STORAGE_BACKEND=...``, emitted as ``--storage-backend``.
    storage_backend: str = ""
    # -> ``readonly STORAGE_MEDIA_TYPE=...``, emitted as ``--storage-media-type``.
    storage_media_type: str = ""
    # -> ``readonly ETCD_COMPACTION_INTERVAL_SEC=...``, emitted as
    # ``--etcd-compaction-interval=${ETCD_COMPACTION_INTERVAL_SEC}s``. The
    # trailing ``s`` is appended by the script itself, which matters for the
    # expectation recorded on :data:`STORAGE_OPTIONS_CASES`.
    compaction_interval: str = ""

    # NOTE ON KEY MATERIAL: every credential-shaped value in the table below is a
    # literal echo of its own field name ("CAKey", "ETCDCert", ...), exactly as
    # the Go table writes it. The script only tests these variables for
    # emptiness and copies the *path* variables into flags, so a placeholder is
    # sufficient - no real key, certificate or token appears anywhere in this
    # module, and none is needed for the assertions to mean what they say.

    def to_template_context(self) -> TemplateContext:
        """Return the render context keyed by ``etcd.template``'s Go identifiers.

        The 16 keys are exactly the 16 identifiers the shipped templates
        dereference - the 15 in ``etcd.template`` plus ``KubeHome``, which
        reaches ``base.template`` through ``{{ template "base" .KubeHome }}`` and
        arrives there as the bare ``{{.}}``. Nothing else may be added and
        nothing may be renamed: an unknown key is inert, but a MISSING or
        misspelled one makes the rendered ``kube-env`` silently omit a
        ``readonly`` line, and the shell test then fails for a reason that has
        nothing to do with what it was written to check.

        Snake_case is this module's Python-facing spelling and these Go
        identifiers are the wire format; declaring the mapping here, immediately
        beside the field definitions, is what stops the two representations
        drifting apart.
        """
        return {
            "KubeHome": self.kube_home,
            "KubeAPIServerRunAsUser": self.kube_api_server_run_as_user,
            "ETCDServers": self.etcd_servers,
            "ETCDServersOverride": self.etcd_servers_override,
            "CAKey": self.ca_key,
            "CACert": self.ca_cert,
            "CACertPath": self.ca_cert_path,
            "APIServerKey": self.api_server_key,
            "APIServerCert": self.api_server_cert,
            "APIServerCertPath": self.api_server_cert_path,
            "APIServerKeyPath": self.api_server_key_path,
            "ETCDKey": self.etcd_key,
            "ETCDCert": self.etcd_cert,
            "StorageBackend": self.storage_backend,
            "StorageMediaType": self.storage_media_type,
            "CompactionInterval": self.compaction_interval,
        }

    def with_runtime(self, kube_home: str, run_as_user: str) -> "KubeAPIServerETCDEnv":
        """Return a copy carrying the two values only the running test knows.

        The Go harness performs precisely these two assignments on its own copy
        of the case's struct immediately before rendering - ``tc.env.KubeHome =
        c.kubeHome`` and ``tc.env.KubeAPIServerRunAsUser =
        strconv.Itoa(os.Getuid())`` (apiserver_etcd_test.go lines 73-74, 130-131
        and 195-196). A temporary directory and a uid are properties of the run,
        never of the case, so the table leaves both empty and the consumer fills
        them in here.

        A copy, not a mutation: the case table is module-level and shared, so
        mutating it would make one test's KUBE_HOME visible to the next.
        """
        return replace(self, kube_home=kube_home, kube_api_server_run_as_user=run_as_user)


@dataclass(frozen=True)
class KubeAPIServerEnv:
    """The 5-field ``kubeAPIServerEnv`` of apiserver_kms_test.py's Go ancestor.

    One instance is one rendering of ``testdata/kube-apiserver/kms.template``,
    the sibling of ``etcd.template``: it invokes the same ``base`` template with
    :attr:`kube_home` and then emits the encryption-provider assignments. Its
    consumer is tests/unit/shell/test_apiserver_kms.py, which ports
    ``TestEncryptionProviderFlag`` (2 cases), ``TestEncryptionProviderConfig``
    (flat, no subtests) and ``TestKMSIntegration`` (2 cases). Those assertions
    and their case tables belong to that module; this class is only the
    environment they render from, and it lives here so that the two template
    contexts of one shipped trio are declared side by side and cannot drift
    apart independently.
    """

    # -> base.template's bare ``{{.}}`` -> ``readonly KUBE_HOME=...``. Runtime
    # injected, exactly as for the etcd environment.
    kube_home: str = ""
    # -> ``readonly KUBE_API_SERVER_RUNASUSER=...``. Runtime injected.
    kube_api_server_run_as_user: str = ""

    # -> ``ENCRYPTION_PROVIDER_CONFIG_PATH=...``, emitted unconditionally. Note
    # that neither this assignment nor ``ENCRYPTION_PROVIDER_CONFIG`` below is
    # declared ``readonly``: measured across the shipped trio, those two are the
    # only non-``readonly`` assignments of the 38 (base 19, etcd 15, kms 2+2).
    # The Go tests set this to ``<kube_home>/encryption-provider-config.yaml``
    # and assert the emitted ``--encryption-provider-config=<that path>``; being
    # derived from the run's temporary directory, it is supplied by the consumer
    # and never baked into a case.
    encryption_provider_config_path: str = ""

    # -> ``ENCRYPTION_PROVIDER_CONFIG=...``, guarded by
    # ``{{if .EncryptionProviderConfig}}`` so an empty value omits the
    # assignment entirely rather than exporting an empty one.
    #
    # BASE64 TEXT, not YAML. The Go tests pass
    # ``base64.StdEncoding.EncodeToString([]byte("foo"))`` - that is, the four
    # characters ``Zm9v`` - and ``TestEncryptionProviderConfig``
    # (apiserver_kms_test.go lines 105-139) then reads the file the script wrote
    # and asserts its bytes equal exactly ``b"foo"``. The assertion is the
    # base64-to-file decode round trip: it proves the shipped script decodes
    # what it is handed instead of writing the encoding through verbatim, so the
    # value stored here must stay ENCODED or the round trip proves nothing.
    encryption_provider_config: str = ""

    # -> ``readonly CLOUD_KMS_INTEGRATION=true``, guarded by
    # ``{{if .CloudKMSIntegration}}``.
    #
    # The only non-string field in either environment, and it must remain a real
    # bool. ``False`` has to reach the renderer as Go-falsey so the guarded block
    # is OMITTED - an omitted assignment, not ``CLOUD_KMS_INTEGRATION=false``,
    # because the script tests the variable for presence. Any stringification on
    # the way (``"False"``) would be a non-empty string, which Go's template
    # truthiness counts as TRUE, and the block would render for a case that
    # switched the integration off. This is why :data:`TemplateContext` is typed
    # with an ``object`` value.
    cloud_kms_integration: bool = False

    def to_template_context(self) -> TemplateContext:
        """Return the render context keyed by ``kms.template``'s Go identifiers.

        Five keys for five identifiers: ``KubeHome`` (reaching ``base.template``
        via ``{{ template "base" .KubeHome }}``), ``EncryptionProviderConfigPath``,
        ``EncryptionProviderConfig``, ``CloudKMSIntegration`` and
        ``KubeAPIServerRunAsUser``. Two of them are dereferenced only inside an
        ``{{if}}``, which does not make them optional - a missing key is a
        missing assignment, and the same failure-for-the-wrong-reason applies as
        for the etcd context.
        """
        return {
            "KubeHome": self.kube_home,
            "KubeAPIServerRunAsUser": self.kube_api_server_run_as_user,
            "EncryptionProviderConfigPath": self.encryption_provider_config_path,
            "EncryptionProviderConfig": self.encryption_provider_config,
            "CloudKMSIntegration": self.cloud_kms_integration,
        }

    def with_runtime(self, kube_home: str, run_as_user: str) -> "KubeAPIServerEnv":
        """Return a copy carrying the run's KUBE_HOME and uid.

        The Go tests build this struct with ``KubeHome: c.kubeHome`` and
        ``KubeAPIServerRunAsUser: strconv.Itoa(os.Getuid())`` at construction
        (apiserver_kms_test.go lines 74-79 and 110-115); the same two values,
        supplied the same way as for :meth:`KubeAPIServerETCDEnv.with_runtime`,
        so that a declared environment stays free of run-specific paths.
        """
        return replace(self, kube_home=kube_home, kube_api_server_run_as_user=run_as_user)


# ---------------------------------------------------------------------------
# Case identity
# ---------------------------------------------------------------------------

# One run of anything that is not a lowercase letter or a digit collapses to one
# hyphen. Compiled once at import; the substitution itself is pure.
_NON_ALPHANUMERIC_RUN = re.compile(r"[^0-9a-z]+")


def case_id_from_desc(desc: str) -> str:
    """Derive a pytest parametrize id from a Go subtest description.

    Lowercase the description, collapse each run of non-alphanumeric characters
    to a single hyphen, then strip any leading or trailing hyphen. Pure: same
    input, same output, no state.

    This is the tier's single definition of that rule, which matters because the
    ids it produces are addressable identifiers rather than cosmetics. They are
    what ``pytest "...::test_tls_flags[mtls-enabled]"`` selects, what
    tests/parity/parity_map.py binds each Go verdict to, and - since a mistyped
    ``-m``/``-k`` selector merely deselects everything and reports "no tests
    collected" instead of erroring - what a typo would silently empty. Deriving
    every id from one function means an id can never drift from the description
    it names.

    The six descriptions in this module map as follows, and the last two are
    fixed points that tests/parity/parity_map.py refers to by name:

        ETCD-SERVERS is not set - default override
            -> etcd-servers-is-not-set-default-override
        ETCD-SERVERS and ETCD_SERVERS_OVERRIDES are set
            -> etcd-servers-and-etcd-servers-overrides-are-set
        storage options are supplied      -> storage-options-are-supplied
        storage options are not supplied  -> storage-options-are-not-supplied
        mTLS enabled                      -> mtls-enabled
        mTLS disabled                     -> mtls-disabled

    :raises ValueError: if the rule yields nothing, which happens only for a
        description with no letter or digit in it at all (``"---"``). None of the
        six descriptions is anywhere near that, but an empty id would be an
        unaddressable test node, and the failure it caused would surface far from
        its cause - as a selector that mysteriously matches nothing. Refusing at
        the point of derivation keeps the diagnosis local.
    """
    case_id = _NON_ALPHANUMERIC_RUN.sub("-", desc.lower()).strip("-")
    if not case_id:
        raise ValueError(
            f"cannot derive a test id from {desc!r}: a description must contain at least one "
            f"letter or digit, or the resulting pytest node id would be empty"
        )
    return case_id


@dataclass(frozen=True)
class ETCDEnvCase:
    """One row of a Go table: an environment plus what its flags must and must not say.

    ASSERTION STYLE, and it is not incidental. The Go tests join the decoded
    pod's container command into a single string -
    ``strings.Join(c.pod.Spec.Containers[0].Command, " ")`` - and then use
    ``strings.Contains`` for each expectation (apiserver_etcd_test.go lines
    85-90, 142-153 and 207-212). So :attr:`want` and :attr:`dont_want` hold flag
    SUBSTRINGS of that joined command line, not parsed flags and not whole
    arguments. Two consequences a port must not tidy away:

    * A :attr:`dont_want` entry is deliberately a bare flag name with no value,
      which is what makes "this flag is absent entirely" expressible.
    * A :attr:`want` entry may be a strict prefix of what is actually rendered.
      See the compaction interval on :data:`STORAGE_OPTIONS_CASES`.

    Rewriting either as an equality check against a parsed flag list would turn
    green cases red for reasons that have nothing to do with the behaviour under
    test.
    """

    #: The Go subtest description, verbatim. Kept alongside :attr:`case_id`
    #: because the parity contract has to speak both spellings at once: the
    #: baseline manifest records Go's name and the ported run reports pytest's.
    desc: str

    #: The rendered environment. Required rather than defaulted, so that a case
    #: whose environment is empty says so in as many words - the two zero-value
    #: rows of the Go table omit the field, and an omission is exactly what must
    #: not be able to happen silently here.
    env: KubeAPIServerETCDEnv

    #: Flag substrings that MUST appear in the joined command line.
    want: tuple[str, ...] = ()

    #: Flag substrings that must NOT appear. Empty for every case but one.
    dont_want: tuple[str, ...] = ()

    @property
    def case_id(self) -> str:
        """The pytest parametrize id, derived from :attr:`desc`.

        Derived rather than stored: an id that cannot be written down cannot be
        transcribed wrongly, so it and the description it names can never
        disagree. Consumers read it exactly as they would a field::

            @pytest.mark.parametrize("case", TLS_FLAGS_CASES, ids=lambda c: c.case_id)
        """
        return case_id_from_desc(self.desc)

    @property
    def go_subtest_name(self) -> str:
        """The subtest name ``t.Run(tc.desc, ...)`` produces for this case.

        Go rewrites each space in a subtest name to an underscore, so
        ``"mTLS enabled"`` is reported as ``mTLS_enabled`` and
        ``"ETCD-SERVERS is not set - default override"`` as
        ``ETCD-SERVERS_is_not_set_-_default_override``. Verified against the
        measured baseline: ``go test -v -run 'TestServerOverride|TestStorageOptions|
        TestTLSFlags' ./cluster/gce/gci/`` reports all six under exactly these
        names, so this property reproduces them rather than approximating them.

        It exists so tests/parity/parity_map.py can bind a baseline entry -
        ``(package, "TestTLSFlags", "mTLS_enabled")`` - to the ported node id
        without a second hand-maintained spelling of either. Go additionally
        appends ``#01`` to disambiguate duplicate names; none of the six
        descriptions here repeats within its own test function, so no
        disambiguation applies and none is invented.
        """
        return self.desc.replace(" ", "_")


# ---------------------------------------------------------------------------
# The six measured cases
# ---------------------------------------------------------------------------
# One tuple per Go test function, each in Go source order: TestServerOverride
# (apiserver_etcd_test.go line 45), TestStorageOptions (line 95), TestTLSFlags
# (line 158). Tuples rather than lists because a parametrize argument set that
# something could append to is a parametrize argument set that can change
# between two runs of the same suite; and the declared order is preserved
# deliberately, so that a case's position is reproducible even though
# pytest-randomly shuffles the order in which tests execute.

#: ``TestServerOverride`` - the events-store override
#:
#: INVARIANT LOCKED: the events keyspace is addressed explicitly. With
#: ETCD_SERVERS unset the script must still emit an override, and when an
#: override IS supplied it must be the supplied one, so neither a missing
#: configuration nor a present one can quietly route events at the main store.
SERVER_OVERRIDE_CASES: tuple[ETCDEnvCase, ...] = (
    ETCDEnvCase(
        desc="ETCD-SERVERS is not set - default override",
        # Zero-value environment: the Go row omits ``env`` entirely. With
        # ETCD_SERVERS empty the script takes its first override branch
        # (configure-kubeapiserver.sh lines 53-54) and substitutes its own
        # default.
        env=KubeAPIServerETCDEnv(),
        want=(DEFAULT_ETCD_SERVERS_OVERRIDES_FLAG,),
    ),
    ETCDEnvCase(
        desc="ETCD-SERVERS and ETCD_SERVERS_OVERRIDES are set",
        # Both set, so the script takes the elif branch (lines 55-56) and must
        # pass the supplied override through untouched. The values are literal
        # echoes of the Go field names, exactly as the Go table writes them.
        env=KubeAPIServerETCDEnv(
            etcd_servers="ETCDServers",
            etcd_servers_override="ETCDServersOverrides",
        ),
        want=("--etcd-servers-overrides=ETCDServersOverrides",),
    ),
)

#: ``TestStorageOptions`` - the three independently gated storage flags
#:
#: INVARIANT LOCKED: each storage flag is emitted if and only if its variable is
#: non-empty. The absent case is the load-bearing half: it proves the script does
#: not synthesise a storage backend, media type or compaction interval of its
#: own, which would silently override whatever the API server defaults to.
STORAGE_OPTIONS_CASES: tuple[ETCDEnvCase, ...] = (
    ETCDEnvCase(
        desc="storage options are supplied",
        env=KubeAPIServerETCDEnv(
            storage_backend="StorageBackend",
            storage_media_type="StorageMediaType",
            compaction_interval="1s",
        ),
        # THE COMPACTION EXPECTATION IS A PREFIX, AND THAT IS CORRECT AS WRITTEN.
        # The script emits
        # ``--etcd-compaction-interval=${ETCD_COMPACTION_INTERVAL_SEC}s``
        # (configure-kubeapiserver.sh line 68), appending a literal ``s``. With
        # ``1s`` supplied the rendered flag is therefore
        # ``--etcd-compaction-interval=1ss`` - verified by executing the
        # substitution - and the Go expectation below matches because the
        # assertion is substring containment, not equality.
        #
        # Keep it exactly as the Go table writes it. "Fixing" it to ``1ss`` would
        # encode today's double-``s`` as a requirement; changing the case's input
        # to a bare ``1`` would test an input the Go table never used; and
        # switching to an equality check would fail a green case. All three would
        # be a behaviour change dressed up as a tidy-up.
        want=(
            "--storage-backend=StorageBackend",
            "--storage-media-type=StorageMediaType",
            "--etcd-compaction-interval=1s",
        ),
    ),
    ETCDEnvCase(
        desc="storage options are not supplied",
        # Zero-value environment. The Go row writes ``kubeAPIServeETCDEnv{}``
        # explicitly here, and it must stay empty: populate any field and the
        # negative assertions below stop proving anything.
        env=KubeAPIServerETCDEnv(),
        # No positive expectation - the Go row supplies no ``want`` at all.
        # ``dont_want`` entries are bare flag NAMES with no value, which is what
        # makes "absent entirely" expressible under substring containment: a
        # value-bearing spelling would pass while the flag was present with some
        # other value.
        dont_want=(
            "--storage-backend",
            "--storage-media-type",
            "--etcd-compaction-interval",
        ),
    ),
)

#: ``TestTLSFlags`` - the etcd transport, control V8
#:
#: INVARIANT LOCKED: when all six etcd mTLS credentials are present the transport
#: is mutually authenticated and the three file flags name the configured paths.
#:
#: ==========================================================================
#: PRESERVATION NOTE - AAP §0.4.2.1 and §0.10.4 name this the single subtlest
#: parity requirement in the migration, and the one most likely to be "fixed"
#: into a broken state. Read it before editing either case below.
#: ==========================================================================
#:
#: The ``mTLS disabled`` case renders a COMPLETELY EMPTY environment and expects
#: the PLAINTEXT endpoint ``--etcd-servers=http://127.0.0.1:2379``. That looks,
#: at first glance, like a test that permits an insecure transport. It is not.
#:
#: With all six credentials absent, ``configure-etcd-params`` reaches its
#: all-absent branch and consults ``${ETCD_APISERVER_ALLOW_INSECURE:-true}``
#: (configure-kubeapiserver.sh line 41). That function-local ``":-true"``
#: default is NOT the production posture: tech-spec §2.1.8 documents it as a
#: backward-compatibility shim that exists SOLELY for direct-invocation contexts
#: which never load the GCE profiles - and the script's own comment names
#: apiserver_etcd_test.go and apiserver_kms_test.go as those contexts. Both
#: shipped profiles set ``ETCD_APISERVER_ALLOW_INSECURE=false``
#: (cluster/gce/config-default.sh and config-test.sh), so a real deployment
#: missing its etcd certificates takes the else branch and exits 1 after printing
#: "refusing to fall back to plaintext etcd" (line 45 of the script; the phrase is
#: kept on one line here so that grepping the tree for it finds this note too).
#:
#: Two truths therefore hold at once, and BOTH must stay green:
#:
#:   1. Invoked directly with no environment, as here, the script yields the
#:      plaintext endpoint. This case is the only coverage the shim has.
#:   2. Invoked with the hardened profile defaults and no credentials, the script
#:      fails closed with exit 1. That is proved separately, by the four
#:      scenarios in tests/unit/shell/test_etcd_failclosed.py, which supply
#:      ETCD_APISERVER_ALLOW_INSECURE through
#:      tests/fixtures/templates/kube_env.j2 - the shipped ``etcd.template`` has
#:      no field for it, which is why this module has no seventeenth field.
#:
#: So: do not populate this environment, do not add an insecure-opt-out field to
#: :class:`KubeAPIServerETCDEnv`, and do not "correct" this expectation to https.
#: Each of those would delete the shim's only coverage while appearing to harden
#: the suite, and would make this case fail against the unmodified shipped
#: script - the definition of a port that has drifted.
TLS_FLAGS_CASES: tuple[ETCDEnvCase, ...] = (
    ETCDEnvCase(
        desc="mTLS enabled",
        # All six credentials present, so the script takes its mTLS branch
        # (configure-kubeapiserver.sh lines 21-25). Field order follows the Go
        # row so the two can be diffed line for line. Values are literal echoes
        # of the field names: the script only tests the credentials for
        # emptiness and copies the three *path* values into flags, so no real
        # key material is required - or present.
        env=KubeAPIServerETCDEnv(
            ca_key="CAKey",
            ca_cert="CACert",
            ca_cert_path="CACertPath",
            api_server_key="APIServerKey",
            api_server_cert="APIServerCert",
            etcd_key="ETCDKey",
            etcd_cert="ETCDCert",
            etcd_servers=MTLS_ETCD_SERVERS_ENDPOINT,
            api_server_key_path="APIServerKeyPath",
            api_server_cert_path="APIServerCertPath",
        ),
        # The three file flags read from the *_PATH variables, so the crossed
        # naming of the shipped template surfaces here: ``--etcd-certfile`` and
        # ``--etcd-keyfile`` carry the api_server_*_path values by way of
        # ETCD_APISERVER_CLIENT_{CERT,KEY}_PATH, while ``--etcd-cafile`` carries
        # ca_cert_path. Absence of any one of them would mean an unauthenticated
        # or unverified etcd connection.
        want=(
            f"--etcd-servers={MTLS_ETCD_SERVERS_ENDPOINT}",
            "--etcd-cafile=CACertPath",
            "--etcd-certfile=APIServerCertPath",
            "--etcd-keyfile=APIServerKeyPath",
        ),
    ),
    ETCDEnvCase(
        desc="mTLS disabled",
        # DELIBERATELY EMPTY - see the preservation note above. The Go row omits
        # ``env`` entirely; this is that zero value, spelled out.
        env=KubeAPIServerETCDEnv(),
        want=(PLAINTEXT_ETCD_SERVERS_FLAG,),
    ),
)
