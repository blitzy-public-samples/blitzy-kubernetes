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

"""Raw etcd reader that bypasses the API server, plus the storage-key builder.

Port of two Go primitives that belong together and were only kept apart because
Go had no way to share them:

  * ``GetEtcdClients``, test/integration/utils.go:69-72, which returns a raw
    etcd client together with a KV view over it, and
  * ``etcdKeyForSecret``, test/integration/secrets/encryption_test.go:69-75,
    which builds the key the apiserver storage layer really wrote to.

WHAT THIS MODULE IS FOR

V3 - Secrets are encrypted at rest - is the one control whose proof cannot be
obtained from the API server. The API server decrypts transparently on read, so
asking it for the Secret returns the plaintext whether or not encryption is
configured at all: a test that only used the client would pass on a completely
unencrypted cluster. The assertion therefore has to read the STORED BYTES, out
of etcd, on a connection that never goes near the apiserver. That read is what
this module provides, and it is the only reason it exists.

THE MIGRATION'S ONE FREE WIN, TAKEN HERE

``encryption_test.go`` carries its own private copy of the key builder and says
so on the function itself: Go will not let one package import another package's
``_test.go`` file, so the identical helper in the neighbouring transformation
package is unreachable and the logic is duplicated. Every duplicate is a place
where a key derivation can drift away from the one the storage layer actually
uses while each copy separately keeps passing.

Python has no such rule. This module is the ONE definition of that derivation
for the whole tier, imported by whoever needs it, so the drift has nowhere to
start. That is not a stylistic improvement; it is the reason the AAP puts this
file in tests/helpers/ rather than inline in the V3 test module.

THE TWO BOUNDARY CONDITIONS THAT LIVE HERE

1. THE STORAGE PREFIX COMES FROM THE LIVE CONFIGURATION. Never from a literal.
   The prefix embeds a per-run UUID, so a hardcoded guess names a key that does
   not exist, the scan comes back empty, and V3's "exactly one etcd entry"
   assertion fails - for entirely the wrong reason. A test that fails because
   the test is wrong, while reading as though the control is broken, is the most
   expensive failure mode there is. :func:`etcd_key_for_secret` therefore takes
   the prefix as a REQUIRED argument with no default and no fallback.
2. THE SCAN IS BOUNDED AT THIRTY SECONDS. The Go original wraps its read in
   ``context.WithTimeout(context.Background(), 30*time.Second)``, so an
   unreachable or wedged datastore becomes a failure rather than a hung job.
   :data:`DEFAULT_SCAN_TIMEOUT_SECONDS` carries that bound, a caller may
   SHORTEN it, and :func:`_validated_budget` refuses to let anyone lengthen it.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

* It asserts nothing about cardinality. The Go oracle's four V3 checks are not
  equally severe: ``len(resp.Kvs) != 1`` is ``t.Fatalf`` and ABORTS, while the
  ciphertext-prefix check, the plaintext-absence check and the round-trip check
  are ``t.Errorf`` and ACCUMULATE. Asserting "exactly one" in here would move
  the abort out of the test that owns it and flatten that asymmetry. This module
  hands back exactly what etcd returned - however many entries that is - and the
  consumer applies the asymmetry.
* It owns no cryptographic constant. ``AESGCM_PREFIX`` and ``PLAINTEXT_CANARY``
  belong to tests/fixtures/encryption_config.py, and so does the non-secret
  aesgcm fixture key; that module states the same division from its side.
  Copying either constant here would give the tier two definitions of one
  boundary condition, and the point of a single definition site is that there is
  exactly one place to weaken.
* It logs nothing, and it has no logger. Every value this module handles is the
  stored form of a Secret. A debug log of one would put the very bytes the
  control exists to protect into a CI artifact - and if the control were broken,
  that log would be the plaintext itself. Rendering a value into a FAILURE
  message is the consumer's decision and mirrors the Go oracle at
  encryption_test.go:137; volunteering it from in here is not.
* It provisions nothing. etcd 3.6.5 is installed by hack/install-etcd.sh under
  hack/lib/etcd.sh's pin, and located by the ``etcd_binary`` fixture in
  tests/conftest.py. This module is handed an endpoint and uses it.
* It declares no fixture. ``raw_etcd_client`` as a FIXTURE belongs to
  tests/integration/conftest.py and wraps the context manager below, both
  because installation is the fixture's job and because a module-, package- or
  session-scoped autouse fixture declared inline in an ordinary module can
  execute twice under ``--doctest-modules``.
* It declares no test, so this module contributes nothing to collection.

WHY etcd3gw, AND WHAT THAT IMPLIES

etcd3gw 2.7.0 is the pinned client. It speaks etcd's gRPC-gateway HTTP/JSON API
rather than gRPC, which is why the ``shared_etcd`` fixture in
tests/conftest.py deliberately listens on ``http://127.0.0.1:<port>`` where
``framework.RunCustomEtcd`` uses a unix socket: an HTTP gateway client cannot
dial a unix socket, and V3 needs a read that bypasses the API server more than
it needs a particular transport. The repository's own integration provisioner,
``kube::etcd::start`` at hack/lib/etcd.sh:76-94, already listens on TCP and
already talks to that same HTTP gateway, so this follows the repository rather
than departing from it. The legacy ``etcd3`` package tops out at 0.12.0 and is
unmaintained and ``python-etcd3`` does not resolve on PyPI, so there is no
alternative to substitute even if one were wanted.

USAGE

    from tests.fixtures.encryption_config import AESGCM_PREFIX, PLAINTEXT_CANARY
    from tests.helpers.etcd_raw import etcd_key_for_secret, raw_etcd_client

    key = etcd_key_for_secret(shared_etcd.prefix, namespace, "encrypted-secret")
    with raw_etcd_client(shared_etcd.url) as kv:
        entries = kv.scan_prefix(key)

    # The consumer owns the asymmetry: this one ABORTS ...
    assert len(entries) == 1, f"F-003-RQ-002: expected exactly one etcd entry for {key!r}"
    # ... and these ACCUMULATE, in the caller's subtests block.
    stored = entries[0].value
    assert stored.startswith(AESGCM_PREFIX.encode())
    assert PLAINTEXT_CANARY.encode() not in stored
"""

# AAP §0.5.1 (the python/tests/helpers/etcd_raw.py row: "Raw etcd prefix scan
# via etcd3gw", sourced from test/integration/utils.go:70) / §0.4.2.2 (the V3
# integration blueprint, whose hard constraint reads "the etcd key MUST be
# derived from the LIVE storage prefix (a per-run UUID plus "/registry") and
# NEVER hardcoded to "registry"", and whose error case bounds the raw scan by a
# 30 s deadline) / §0.10.2 (the boundary conditions that must port unchanged:
# storage-key derivation, ciphertext cardinality, and prefix-not-equality
# matching) / §0.3.2 (harness primitives recreated rather than mocked) /
# tech-spec §6.4.5 (encryption at rest) and §6.6.1.2 ("real components, not
# mocks": this reads a real etcd, and the bytes it returns are the bytes a real
# API server really stored).
#
# INVARIANT LOCKED BY THIS FILE: a raw read reaches etcd at a key derived from
# the LIVE storage prefix and never from the literal "registry"; it returns the
# stored bytes verbatim, in etcd's own order, undecoded and uncounted; it cannot
# outlive a thirty-second budget; and the connection it opened is closed whether
# the read succeeded, failed or raised. Weaken the prefix rule and V3 fails for
# the wrong reason. Decode the bytes and V3 can pass on plaintext. Drop the
# close and Python's analogue of the leaked goroutine the Go original guards
# against comes back, with no race detector and no goleak to notice.

# WHAT etcd3gw 2.7.0'S SURFACE ACTUALLY IS, verified by introspecting the pinned
# distribution and by exercising it against a live etcd 3.6.5 rather than read
# from its documentation. Recorded so the next reader does not repeat it:
#
#   * `Etcd3Client(host='localhost', port=2379, protocol='http', ca_cert=None,
#     cert_key=None, cert_cert=None, timeout=None, api_path=<$ETCD3GW_API_PATH>,
#     session=None)`. Host and port are taken SEPARATELY, not as a URL, which is
#     why :func:`_split_endpoint` exists.
#   * There is NO `Etcd3Client.close()`. The closable object is the requests
#     Session on `.session`, and closing it is this port's `defer Close()`.
#   * `get_prefix(key_prefix)` returns `list[tuple[bytes, KeyValue]]` - the VALUE
#     FIRST and the metadata second, which is the opposite of the (key, value)
#     order a reader expects, and the single easiest thing to get backwards here.
#     The value is base64-decoded to `bytes`; `metadata["key"]` is likewise
#     decoded to `bytes`; and `value` is POPPED OUT of the metadata mapping, so
#     it is readable only from the tuple. `create_revision`, `mod_revision` and
#     `version` arrive as decimal STRINGS because the gateway serialises int64
#     as JSON strings.
#   * A prefix matching nothing yields `[]`, never a raised error.
#   * Order is etcd's own key-ascending range order: keys written out of order
#     came back sorted, and `sort_order=None` is SortNone, which is exactly what
#     Go's `clientv3.WithPrefix()` with no sort option asks for.
#   * A non-UTF-8 value - `b"\x00\x80\xff\xfe..."` - round-tripped byte-identical.
#     That is the property ciphertext depends on, so it was measured rather than
#     assumed.
#   * `timeout` reaches requests and is honoured per HTTP operation: a blackhole
#     address with `timeout=1.0` raised at 1.00s, and a closed port raised at
#     0.00s. It is NOT a total deadline, which is why :meth:`RawEtcdKV.scan_prefix`
#     recomputes the remaining budget before each of the two calls it makes.
#   * `api_path` is resolved LAZILY through an extra `GET <base>/version`, so the
#     first read costs two HTTP round trips. This module never passes `api_path`,
#     which keeps both etcd3gw's own discovery and its `$ETCD3GW_API_PATH`
#     override working, and accounts for the extra call inside the budget.
#   * Transport failures surface as `etcd3gw.exceptions.Etcd3Exception`
#     subclasses (`ConnectionFailedError`, `ConnectionTimeoutError`,
#     `InternalServerError`, ...). `Etcd3Exception` is NOT an `OSError`; the
#     `requests` exceptions that etcd3gw does not translate DO derive from
#     `OSError`. Catching both, and nothing wider, covers the transport without
#     importing `requests` - which is etcd3gw's dependency, not one of the
#     eighteen this tier pins.
#   * `get()` raises a DeprecationWarning for unknown keyword arguments, and
#     python/pyproject.toml sets `filterwarnings = ["error", ...]`, so an
#     unknown kwarg would FAIL a test rather than warn. Only documented
#     arguments are passed below. For the same reason nothing here reads
#     `etcd3gw.__version__`, whose accessor is itself deprecated.
#   * The distribution ships a `py.typed` marker, so it type-checks under mypy
#     with no override in python/pyproject.toml and no `ignore_missing_imports`.

import contextlib
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

from etcd3gw import Etcd3Client
from etcd3gw.exceptions import Etcd3Exception

__all__ = [
    "DEFAULT_SCAN_TIMEOUT_SECONDS",
    "EtcdKeyValue",
    "RawEtcdError",
    "RawEtcdKV",
    "etcd_key_for",
    "etcd_key_for_secret",
    "raw_etcd_client",
    "read_prefix",
]

#: The requirement this module serves, named in every failure it raises.
#:
#: AAP §0.7.2 asks that a failure read as a requirement violation rather than as
#: a value mismatch, because the person reading a CI failure in a security suite
#: is frequently not the person who wrote the test. ``F-003-RQ-002`` is V3's
#: ciphertext-at-rest identifier - the requirement that a Secret's stored bytes
#: are ciphertext - which is the only requirement a raw etcd read serves.
_RQ: Final[str] = "F-003-RQ-002"

#: The scan deadline, in seconds: thirty, and thirty is not a round number
#: chosen here.
#:
#: PORTS ``context.WithTimeout(context.Background(), 30*time.Second)`` at
#: test/integration/secrets/encryption_test.go:123, which bounds the one raw read
#: V3 performs.
#:
#: BOUNDARY CONDITION (AAP §0.10.2, §0.4.2.2). It may be SHORTENED - a check that
#: wants to prove an unreachable endpoint fails fast passes a second or two - and
#: it may NOT be lengthened: see :func:`_validated_budget`, which enforces that
#: rather than trusting it. This differs deliberately from the per-call
#: ``timeout`` of tests/helpers/bash.py, which is a harness backstop a slow
#: caller may legitimately raise. This one is a ported assertion bound, and a
#: caller that could widen it could turn a wedged datastore back into a wedged
#: job.
DEFAULT_SCAN_TIMEOUT_SECONDS: Final[float] = 30.0

#: The resource path segment of a Secret's storage key.
#:
#: The apiserver storage layer writes a core-group object at
#: ``/<prefix>/<resource>/<namespace>/<name>``, so for a Secret the third segment
#: is exactly this. Named once here so that :func:`etcd_key_for_secret` and its
#: documentation cannot disagree about it.
_SECRETS_RESOURCE: Final[str] = "secrets"

#: The endpoint schemes an HTTP gateway client can speak.
#:
#: ``etcd3gw`` builds ``<protocol>://<host>:<port>`` and hands the result to
#: requests, so anything else - and in particular the ``unix://`` endpoint
#: ``framework.RunCustomEtcd`` uses - cannot work. Rejecting it by name here
#: turns that into one legible message instead of a requests error about an
#: unsupported adapter.
_SUPPORTED_SCHEMES: Final[frozenset[str]] = frozenset({"http", "https"})


class RawEtcdError(AssertionError):
    """A raw etcd read could not be performed, or was asked for incorrectly.

    Subclasses ``AssertionError`` deliberately, so that one raise carries both of
    Go's failure postures depending on how the caller wrote the call:

    * unwrapped, it aborts the test, which is ``t.Fatalf`` - and ``t.Fatalf`` is
      exactly what encryption_test.go:117 and :127 use for "failed to create
      etcd client" and "failed to read secret from etcd";
    * inside ``with subtests.test(...)``, pytest's subtests fixture catches it,
      reports that one case and lets the loop continue, which is ``t.Errorf``.

    Every message this class carries names the requirement identifier, the key
    or prefix involved and the deadline budget, because those three are what
    distinguish "the datastore is unreachable" from "the key derivation is
    wrong" - and the second is a broken test masquerading as a broken control.

    It is raised for a transport failure, for a deadline that expired, and for a
    call this module can tell is malformed before it reaches the wire: a blank
    storage prefix, a key segment containing a path separator, an endpoint that
    is not an ``http``/``https`` URL, a budget outside the ported bound, a
    half-supplied client-certificate pair, or a read attempted on a client that
    is already closed. It is NOT raised for an empty result: a prefix matching
    nothing is DATA, and V3's cardinality assertion is the consumer's to make.
    """


@dataclass(frozen=True)
class EtcdKeyValue:
    """One key/value pair exactly as etcd returned it. Frozen: a record, not a buffer.

    The analogue of one element of ``resp.Kvs`` in
    test/integration/secrets/encryption_test.go:131-141, narrowed to the two
    fields the ported assertions read. The Go type also carries create and mod
    revisions, a version and a lease; no ported assertion looks at any of them,
    and a field nothing reads is a field nothing notices going wrong.

    Attributes:
        key: The full etcd key, as bytes. Undecoded, because a key is only ever
            compared or reported, never parsed.
        value: The STORED BYTES at that key, verbatim - for a Secret under an
            active encryption provider, the ciphertext. Bytes rather than
            ``str`` is a correctness requirement and not a preference: V3
            asserts a byte prefix and a byte-substring absence, and text
            decoding either raises on ciphertext or replaces the undecodable
            parts, so the ciphertext-prefix check could then fail on a correctly
            encrypted Secret, or the plaintext-absence check could pass on an
            unencrypted one. Both are verdict changes.
    """

    key: bytes
    value: bytes

    def __repr__(self) -> str:
        """Render the key in full and the value as a LENGTH, never as content.

        Deliberate, and the one place this module departs from a plain dataclass.
        A repr is reached incidentally - by pytest's assertion introspection, by
        an f-string on a list of entries, by a debugger - and an incidental
        render of this object would put a Secret's stored bytes into a CI
        artifact. If the control were broken those bytes would be the plaintext
        itself, so the incidental path is exactly the path that must not carry
        them.

        Nothing is hidden from an assertion by this. Every ported check reads
        :attr:`value` explicitly, and a consumer that wants the bytes in its own
        failure message writes them there - which is precisely what the Go oracle
        does at encryption_test.go:137 with ``got %q``. The choice here is only
        about what happens when nobody asked.
        """
        return f"{type(self).__name__}(key={self.key!r}, value=<{len(self.value)} bytes>)"


def _validated_segment(value: str, label: str, *, allow_separator: bool) -> str:
    """Trim the separators around one key segment and refuse anything unusable.

    A key is assembled from four segments, and every way of getting one wrong
    produces a syntactically perfect key that addresses a different object. The
    read then returns nothing, and "nothing stored there" is indistinguishable
    from "the object was never created" - so the check has to happen here, before
    the wire, where the argument that was wrong can still be named.

    Leading and trailing separators are stripped, which is what normalises the
    two real storage-prefix shapes onto one. Interior separators are preserved:
    they are legitimate inside a storage prefix (``<uuid>/registry``) and inside a
    group-qualified resource (``rbac.authorization.k8s.io/clusterroles``), and
    rewriting them would mean deciding on the caller's behalf what the storage
    layer did.

    Whitespace is NOT stripped from a non-blank value. A prefix carrying a stray
    space is a caller defect, and quietly repairing it would hide the defect
    while changing the key that gets read; a value that is entirely blank is
    rejected outright instead.

    Args:
        value: The raw segment.
        label: The parameter name, for the failure message.
        allow_separator: Whether an interior ``/`` is legitimate. False for a
            namespace and a name, neither of which may contain one.

    Returns:
        The segment with its surrounding separators removed.

    Raises:
        RawEtcdError: If the segment is blank, becomes empty once its separators
            are trimmed, or holds an interior separator it is not allowed.
    """
    __tracebackhide__ = True
    if not value or not value.strip():
        raise RawEtcdError(
            f"{_RQ}: {label} must be a non-empty string, got {value!r}. "
            "The storage prefix comes from the LIVE storage configuration "
            "(shared_etcd.prefix, which embeds a per-run UUID); it has no default here "
            "because a guessed prefix addresses a key that does not exist, and the "
            "empty scan that follows reads as a broken control rather than a broken test."
        )
    trimmed = value.strip("/")
    if not trimmed:
        raise RawEtcdError(
            f"{_RQ}: {label} is only separators ({value!r}), so it contributes no path "
            "segment and the resulting key would address the wrong object."
        )
    if not allow_separator and "/" in trimmed:
        raise RawEtcdError(
            f"{_RQ}: {label} may not contain '/', got {value!r}. A namespace and an "
            "object name cannot contain a path separator, so one here would silently "
            "shift the key into a different part of the keyspace."
        )
    return trimmed


def _validated_budget(timeout: float) -> float:
    """Check a scan budget against the ported thirty-second bound.

    BOUNDARY CONDITION ENFORCED, not merely documented (AAP §0.10.2). The Go
    original bounds its raw read at exactly thirty seconds
    (encryption_test.go:123). A caller may SHORTEN that - a check proving an
    unreachable endpoint fails fast wants a second, not thirty - and may not
    lengthen it, because a budget a caller can widen is not a bound: the wedged
    datastore the Go timeout exists to catch would simply wedge the pytest
    session instead, and pytest-timeout's 300 s session backstop can then only
    report that the test hung, not what it was waiting for.

    Refusing rather than clamping is the deliberate choice. Silently clamping
    would let a caller believe it had sixty seconds and leave the mismatch to be
    discovered by a flake.

    Args:
        timeout: The requested budget in seconds.

    Returns:
        The budget, unchanged, when it is acceptable.

    Raises:
        RawEtcdError: If the budget is not a number at all, is not a positive
            finite number, or exceeds :data:`DEFAULT_SCAN_TIMEOUT_SECONDS`.
    """
    __tracebackhide__ = True
    # THE COERCION IS GUARDED, because it is the first thing a caller's value
    # touches. `float(None)`, `float("30s")` and `float([30])` raise TypeError or
    # ValueError, and every one of those escaped this module as itself - so a
    # helper documented to raise only RawEtcdError leaked two other exception types
    # from its very first line, and the failure named neither the parameter nor the
    # bound it was being checked against.
    try:
        budget = float(timeout)
    except (TypeError, ValueError) as exc:
        raise RawEtcdError(
            f"{_RQ}: scan timeout must be a number of seconds, got {timeout!r} "
            f"({type(timeout).__name__}): {exc}."
        ) from exc
    # Rejects NaN as well: every comparison with NaN is false, so `budget > 0` is
    # false for it and it is caught by the first branch rather than slipping
    # through into a request timeout that never fires.
    if not budget > 0.0:
        raise RawEtcdError(
            f"{_RQ}: scan timeout must be a positive number of seconds, got {timeout!r}."
        )
    if budget > DEFAULT_SCAN_TIMEOUT_SECONDS:
        raise RawEtcdError(
            f"{_RQ}: scan timeout {budget}s exceeds the ported bound of "
            f"{DEFAULT_SCAN_TIMEOUT_SECONDS}s (test/integration/secrets/"
            "encryption_test.go:123 wraps the raw read in a 30 s context). The bound may "
            "be shortened for a check that wants to fail fast; it may not be lengthened, "
            "because then a wedged datastore hangs the run instead of failing it."
        )
    return budget


def _split_endpoint(url: str) -> tuple[str, int, str]:
    """Split ``<scheme>://<host>:<port>`` for a client that takes the parts apart.

    ``Etcd3Client`` accepts ``host``, ``port`` and ``protocol`` separately while
    the ``shared_etcd`` fixture and the API server's ``--etcd-servers`` flag both
    speak whole URLs, so exactly one place has to bridge the two. Doing it here
    means every consumer bridges it identically.

    ``urlsplit`` supplies the bracket-stripped hostname, which is the form
    ``Etcd3Client`` wants: its ``base_url`` re-adds the brackets itself when the
    host contains a colon, so an IPv6 endpoint survives the round trip.

    Args:
        url: An absolute endpoint URL, ``http://127.0.0.1:2379`` or the ``https``
            equivalent.

    Returns:
        ``(host, port, scheme)``.

    Raises:
        RawEtcdError: If the scheme is absent or unsupported, or the host or port
            is missing. A ``unix://`` endpoint is rejected by name: it is what
            ``framework.RunCustomEtcd`` uses and what an HTTP gateway client
            cannot dial, which is the whole reason the ``shared_etcd`` fixture
            listens on TCP.
    """
    __tracebackhide__ = True
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError as exc:
        # urlsplit defers port parsing to attribute access, so a non-numeric or
        # out-of-range port only fails here.
        raise RawEtcdError(
            f"{_RQ}: etcd endpoint {url!r} carries an unusable port: {exc}"
        ) from exc
    if parts.scheme not in _SUPPORTED_SCHEMES:
        raise RawEtcdError(
            f"{_RQ}: etcd endpoint {url!r} must use one of "
            f"{sorted(_SUPPORTED_SCHEMES)}, got {parts.scheme!r}. etcd3gw speaks etcd's "
            "HTTP gateway and cannot dial a unix socket, which is why the shared_etcd "
            "fixture exposes http://127.0.0.1:<port> rather than the unix endpoint "
            "framework.RunCustomEtcd uses. Pass shared_etcd.url."
        )
    if not parts.hostname or port is None:
        raise RawEtcdError(
            f"{_RQ}: etcd endpoint {url!r} must carry both a host and a port, as "
            "shared_etcd.url does."
        )
    return parts.hostname, port, parts.scheme


def etcd_key_for(storage_prefix: str, resource: str, namespace: str, name: str) -> str:
    """Build the raw etcd key of a namespaced object, as the storage layer wrote it.

    PORTS the general form of ``etcdKeyForSecret``,
    test/integration/secrets/encryption_test.go:69-75, which is
    ``"/" + storagePrefix + "/secrets/" + namespace + "/" + name``. The resource
    segment is a parameter here because the derivation is not specific to
    Secrets; :func:`etcd_key_for_secret` is the named case the ported surface
    actually uses.

    INVARIANT PRESERVED: the key is built from the storage prefix the caller was
    given by the LIVE storage configuration, and this function has no default,
    no fallback and no inference for that prefix. The live prefix embeds a
    per-run UUID - ``framework.SharedEtcd()`` at
    test/integration/framework/controlplane_utils.go:96 builds it as
    ``path.Join(uuid.New().String(), "registry")`` - so a hardcoded guess names a
    key that does not exist. The scan then returns nothing and V3's "exactly one
    etcd entry" assertion fails while the control is perfectly healthy. Nothing
    below examines, completes or second-guesses the prefix it is handed.

    LEADING-SLASH NORMALISATION, and why it is not cosmetic. Both prefix shapes
    are real in this repository:

    * ``framework.SharedEtcd()`` yields ``<uuid>/registry``, with NO leading
      slash. This is the V3 path, and it is the shape
      :attr:`~tests.conftest.SharedEtcdInstance.prefix` carries.
    * ``StartTestServer`` yields ``path.Join("/", uuid, "registry")`` at
      test/integration/framework/test_server.go:159 - WITH a leading slash.

    Go's concatenation is correct for the first and produces ``//<uuid>/...`` for
    the second, which is a different key. Both are normalised here to exactly one
    leading slash, so the result is byte-identical to the Go original for the
    shape the Go original is given, and correct rather than doubled for the
    other. Trailing separators are trimmed for the same reason.

    Internal separators are left alone. ``path.Join`` cleans its result, so a
    live prefix cannot contain a doubled separator, and silently rewriting the
    middle of a caller's prefix would be this function deciding what the storage
    layer did - which is the one thing it must never do.

    Args:
        storage_prefix: The live storage prefix, with or without a leading
            slash - typically ``<uuid>/registry``. Required, and rejected when
            blank.
        resource: The resource path segment, for example ``secrets``. An
            internal separator is accepted because a non-core group is stored
            group-qualified, as in ``rbac.authorization.k8s.io/clusterroles``.
        namespace: The object's namespace. May not contain a separator, because
            a namespace name cannot.
        name: The object's name. May not contain a separator, for the same
            reason.

    Returns:
        ``/<storage_prefix>/<resource>/<namespace>/<name>``, with exactly one
        separator between segments and exactly one leading separator.

    Raises:
        RawEtcdError: If any argument is blank, or if ``namespace`` or ``name``
            contains a separator. All four are rejected rather than tolerated:
            each one silently yields a well-formed key that points somewhere
            else, and the resulting empty scan is indistinguishable from a
            genuinely missing object.
    """
    __tracebackhide__ = True
    prefix = _validated_segment(storage_prefix, "storage_prefix", allow_separator=True)
    return "/".join(
        (
            "",
            prefix,
            _validated_segment(resource, "resource", allow_separator=True),
            _validated_segment(namespace, "namespace", allow_separator=False),
            _validated_segment(name, "name", allow_separator=False),
        )
    )


def etcd_key_for_secret(storage_prefix: str, namespace: str, name: str) -> str:
    """Build the raw etcd key of a Secret. The single definition site for the tier.

    PORTS ``etcdKeyForSecret``, test/integration/secrets/encryption_test.go:69-75,
    signature for signature. That function exists as a private copy inside a Go
    test file only because Go cannot import a helper across a ``_test.go``
    boundary, and its own comment records the copy. This is that helper, written
    once: tests/fixtures/encryption_config.py states the same division from its
    side, deliberately publishing no key template of its own so that there is
    nowhere else for a hardcoded prefix to appear.

    INVARIANT PRESERVED: ``storage_prefix`` is required and comes from the live
    storage configuration - ``shared_etcd.prefix``, never the literal
    ``registry``. See :func:`etcd_key_for`, which this delegates to unchanged.

    Args:
        storage_prefix: The live storage prefix, ``<uuid>/registry``, with or
            without a leading slash.
        namespace: The Secret's namespace.
        name: The Secret's name.

    Returns:
        ``/<storage_prefix>/secrets/<namespace>/<name>``.

    Raises:
        RawEtcdError: On a blank argument, or a separator inside ``namespace`` or
            ``name``.
    """
    __tracebackhide__ = True
    return etcd_key_for(storage_prefix, _SECRETS_RESOURCE, namespace, name)


class RawEtcdKV:
    """A bounded, byte-preserving prefix reader over one etcd connection.

    PORTS the ``clientv3.KV`` half of ``GetEtcdClients``,
    test/integration/utils.go:69-72, as it is used at
    test/integration/secrets/encryption_test.go:115-133. Go returns two objects -
    a ``*clientv3.Client`` that owns the connection and a ``clientv3.KV`` view
    that wraps it - and the test closes the first while reading through the
    second. There is no equivalent split to reproduce: ``Etcd3Client`` has no
    ``close()`` at all, and the only closable thing is the HTTP session it holds.
    So the two halves become one object here, and the ownership the Go comment
    describes ("kvClient wraps it") becomes an explicit rule: this instance owns
    the client it was given, including its request timeout and the lifetime of
    its session.

    INVARIANT PRESERVED: a read returns the stored bytes verbatim, in etcd's own
    order, with nothing counted, filtered, sorted, deduplicated or decoded; it
    cannot outrun its budget; and the connection is closed exactly once.

    Obtain one from :func:`raw_etcd_client`, which is the only entry point that
    guarantees the close. Constructing one directly is possible - the
    ``raw_etcd_client`` FIXTURE in tests/integration/conftest.py is expected to
    do exactly that indirectly - but then closing is the caller's obligation, and
    ``contextlib.closing`` satisfies it because :meth:`close` is idempotent.

    Not thread-safe, deliberately and by construction rather than by omission:
    :meth:`scan_prefix` rewrites the client's request timeout as it consumes the
    budget, so two threads sharing one instance would consume each other's
    deadline. That is not a limitation in practice - each test gets its own
    instance from its own fixture, which is what keeps the tier safe under
    ``pytest-xdist`` - and it is stated here because Python has no race detector
    to state it later.
    """

    def __init__(self, client: Etcd3Client, endpoint: str) -> None:
        """Take ownership of an already-constructed client.

        Args:
            client: The etcd3gw client to read through. This instance owns it:
                it mutates the client's ``timeout`` while enforcing a deadline
                and closes the client's session in :meth:`close`. Do not share
                one client between two wrappers.
            endpoint: The endpoint URL, carried only so that a failure message
                can name where the read was attempted. Reconstructing it from
                the client would lose the caller's original spelling, which is
                the spelling the reader of the failure recognises.
        """
        self._client = client
        self._endpoint = endpoint
        self._closed = False
        self._close_error: BaseException | None = None

    @property
    def endpoint(self) -> str:
        """The endpoint this reader was pointed at, as the caller spelled it."""
        return self._endpoint

    @property
    def closed(self) -> bool:
        """Whether the underlying HTTP session has been closed.

        Exposed so that a teardown assertion - the tier's substitute for
        ``goleak``, which has no Python analogue - can prove the connection was
        released rather than assume it. False after a FAILED close, because a
        session that is still open is not closed however hard it was asked to be:
        see :meth:`close` and :attr:`close_error`.
        """
        return self._closed

    @property
    def close_error(self) -> BaseException | None:
        """The exception the last :meth:`close` attempt raised, or ``None``.

        Retained rather than discarded so a teardown assertion can report WHY the
        session is still open, and cleared on a subsequent successful close so a
        retry that works leaves no stale evidence of a failure that no longer holds.
        """
        return self._close_error

    def scan_prefix(
        self,
        key_prefix: str | bytes,
        *,
        timeout: float = DEFAULT_SCAN_TIMEOUT_SECONDS,
    ) -> list[EtcdKeyValue]:
        """Read every key under ``key_prefix``, returning what etcd returned.

        PORTS ``kvClient.Get(ctx, key, clientv3.WithPrefix())`` at
        test/integration/secrets/encryption_test.go:125, together with the
        thirty-second context that bounds it at :123.

        INVARIANT PRESERVED, in four parts:

        * THE RESULT IS NOT ADJUSTED. No sort option is passed, so the order is
          etcd's own key-ascending range order - which is precisely what
          ``WithPrefix()`` without a sort option asks for. Nothing is
          deduplicated, nothing is filtered and nothing is dropped.
        * THE CARDINALITY IS NOT ASSERTED. V3's ``len(resp.Kvs) != 1`` check is
          ``t.Fatalf`` and belongs to the test, not here: this method returns
          zero, one or many and lets the consumer abort on the count. An empty
          result is DATA, not an error - and if it were raised as one, the
          consumer could no longer distinguish "the key derivation is wrong"
          from "encryption is off", because both would arrive as the same
          exception.
        * THE BYTES ARE NOT DECODED. Values come back as :class:`bytes`. Text
          decoding would either raise on ciphertext or substitute replacement
          characters, and either outcome can flip V3's verdict: the
          ciphertext-prefix check could fail on a correctly encrypted Secret, or
          the plaintext-absence check could pass on an unencrypted one.
        * THE BUDGET IS A TOTAL DEADLINE. etcd3gw's ``timeout`` is per HTTP
          operation, and the first read costs two - one lazy ``GET /version`` to
          resolve the gateway's API path, then the range request. So the
          remaining budget is recomputed before each, which makes thirty seconds
          the bound on the whole scan rather than on each half of it.

        Args:
            key_prefix: The prefix to range over - normally the output of
                :func:`etcd_key_for_secret`, which for a single object is the
                object's exact key and therefore matches only it. ``str`` or
                ``bytes``; ASCII either way, because a storage key is a path and
                because etcd3gw derives the range end by incrementing the
                prefix's last byte.
            timeout: The total budget in seconds. Defaults to
                :data:`DEFAULT_SCAN_TIMEOUT_SECONDS`; may be shortened, may not
                be lengthened.

        Returns:
            The matching entries as :class:`EtcdKeyValue` records, in the order
            etcd returned them. Empty when the prefix matches nothing.

        Raises:
            RawEtcdError: On a blank or non-ASCII prefix, a budget outside the
                ported bound, a read attempted after :meth:`close`, a transport
                failure, or an expired deadline. Every message names the prefix
                and the budget, so a failure says whether the datastore was
                unreachable or the key was simply not there.
        """
        __tracebackhide__ = True
        budget = _validated_budget(timeout)
        prefix = _decoded_prefix(key_prefix)
        if self._closed:
            raise RawEtcdError(
                f"{_RQ}: raw etcd read attempted on a closed reader for prefix {prefix!r} "
                f"at {self._endpoint}. The connection was released by close(); open a new "
                "reader with raw_etcd_client()."
            )

        started = time.monotonic()
        try:
            # Resolving the gateway API path is a lazy one-off HTTP GET on first
            # use. It is triggered here, INSIDE the measured window and under the
            # remaining budget, so that the round trip it costs is accounted for
            # rather than added on top of the bound.
            self._client.timeout = self._remaining(started, budget, prefix)
            _ = self._client.api_path
            self._client.timeout = self._remaining(started, budget, prefix)
            raw = self._client.get_prefix(prefix)
        except (Etcd3Exception, OSError, ValueError) as exc:
            # Etcd3Exception: every transport failure etcd3gw translates -
            #   ConnectionFailedError for a refused port, ConnectionTimeoutError
            #   for an expired socket timeout, InternalServerError for a 500.
            # OSError: the requests exceptions etcd3gw does NOT translate, all of
            #   which derive from OSError, plus a bare socket error.
            # ValueError: raised locally, before the wire, when the range end
            #   cannot be derived from the prefix - etcd3gw increments its last
            #   byte, which overflows at 0xFF. UnicodeDecodeError and a malformed
            #   JSON body arrive the same way, ValueError being their base.
            raise RawEtcdError(
                f"{_RQ}: raw etcd prefix scan failed for {prefix!r} at {self._endpoint} "
                f"after {time.monotonic() - started:.2f}s of a {budget}s budget: "
                f"{type(exc).__name__}: {exc}"
            ) from exc

        elapsed = time.monotonic() - started
        if elapsed > budget:
            # A backstop for the gap the per-operation timeouts leave: each HTTP
            # call respected its own share, yet the whole scan still overran.
            raise RawEtcdError(
                f"{_RQ}: raw etcd prefix scan for {prefix!r} at {self._endpoint} took "
                f"{elapsed:.2f}s, exceeding its {budget}s budget "
                "(test/integration/secrets/encryption_test.go:123 bounds the same read at "
                "30 s so that a wedged datastore fails rather than hangs)."
            )

        # etcd3gw hands back (value, metadata) - THE VALUE FIRST - with the key
        # base64-decoded into metadata["key"] and the value popped out of that
        # mapping. Both halves are already bytes; nothing is re-encoded here, and
        # the loop preserves the order etcd chose.
        #
        # THE PROJECTION IS GUARDED, because the rows are WIRE DATA. A gateway that
        # answered 200 with a body this shape does not fit - a proxy's own JSON, a
        # future etcd that renames `key`, a truncated response - produced a bare
        # KeyError, TypeError or unpacking ValueError from a comprehension, none of
        # which is the RawEtcdError this method documents and none of which says
        # which row was malformed. V3's verdict turns on this read, so an
        # unrecognisable response has to be reported as one.
        entries: list[EtcdKeyValue] = []
        for index, row in enumerate(raw):
            try:
                value, metadata = row
                key = metadata["key"]
            except (TypeError, ValueError, KeyError, IndexError) as exc:
                raise RawEtcdError(
                    f"{_RQ}: the raw etcd prefix scan for {prefix!r} at {self._endpoint} "
                    f"returned a row this reader does not recognise at index {index}: "
                    f"{type(exc).__name__}: {exc}. etcd3gw yields (value, metadata) pairs "
                    f"whose metadata carries a decoded 'key'; a different shape means the "
                    f"endpoint is not an etcd v3 gateway, or its response was truncated."
                ) from exc
            entries.append(EtcdKeyValue(key=key, value=value))
        return entries

    def close(self) -> None:
        """Release the HTTP session. Idempotent, and the port of ``defer Close()``.

        PORTS ``defer rawClient.Close()`` at
        test/integration/secrets/encryption_test.go:120, whose comment states its
        purpose: closing the raw client avoids leaked goroutines.

        The leak class differs by language and the obligation does not. Go leaks a
        goroutine and ``go.uber.org/goleak`` catches it at package teardown;
        Python leaks a pooled socket and a file descriptor, and NOTHING catches
        it - there is no goleak analogue, so the AAP names "no lingering threads,
        subprocesses, or open sockets" as the explicit substitute and puts the
        burden on deliberate teardown. That is this method, called from the
        ``finally`` of :func:`raw_etcd_client`, so it runs whether the read
        succeeded, failed or raised.

        Idempotent because a caller may close explicitly and still leave the
        context manager, and because ``contextlib.closing`` around a
        directly-constructed reader would otherwise double-close.

        THE FLAG IS SET ONLY AFTER THE SESSION IS ACTUALLY CLOSED. Setting it first
        made a FAILED close indistinguishable from a successful one: the reader was
        marked closed, every later call returned immediately, and the socket and
        file descriptor the close was supposed to release stayed open with nothing
        left that could release them. Since there is no goleak analogue here, a
        leaked socket has no other detector, so the failure is reported and the
        reader stays open for a retry. :attr:`close_error` retains it either way.

        Raises:
            RawEtcdError: If the session could not be closed. The reader remains
                UNCLOSED so that a caller may retry, and reads continue to be
                permitted, because a reader whose socket is still open is still
                usable.
        """
        if self._closed:
            return
        try:
            self._client.session.close()
        except Exception as exc:
            self._close_error = exc
            raise RawEtcdError(
                f"{_RQ}: failed to release the HTTP session for {self._endpoint}: "
                f"{type(exc).__name__}: {exc}. The reader is left OPEN so the close can be "
                "retried; until it succeeds the pooled socket and its file descriptor are "
                "still held, and this tier has no goleak analogue to catch that later "
                "(test/integration/secrets/encryption_test.go:120 closes the raw client "
                "precisely to avoid the equivalent leak in Go)."
            ) from exc
        self._close_error = None
        self._closed = True

    def _remaining(self, started: float, budget: float, prefix: str) -> float:
        """Return the budget left, refusing to proceed once it is gone.

        Uses :func:`time.monotonic`, never the wall clock: a system-clock
        adjustment mid-scan must not be able to lengthen or shorten a deadline.

        Raises:
            RawEtcdError: When the budget is exhausted, naming the prefix and the
                budget so the failure reads as a deadline rather than as a
                mysterious timeout.
        """
        __tracebackhide__ = True
        remaining = budget - (time.monotonic() - started)
        if remaining <= 0.0:
            raise RawEtcdError(
                f"{_RQ}: raw etcd prefix scan for {prefix!r} at {self._endpoint} exhausted "
                f"its {budget}s budget before completing "
                "(test/integration/secrets/encryption_test.go:123 bounds the same read at "
                "30 s so that a wedged datastore fails rather than hangs)."
            )
        return remaining


def _decoded_prefix(key_prefix: str | bytes) -> str:
    """Normalise a prefix to ``str`` and refuse one that cannot be ranged over.

    ``Etcd3Client`` accepts either type and base64-encodes whatever it is given,
    so the conversion is not about the wire format. It is about the range end:
    etcd3gw derives it by incrementing the prefix's last byte and decoding the
    result as UTF-8, so a non-ASCII prefix fails inside the library with a
    message about bytes rather than about the key that was asked for. Converting
    and checking here produces a message that names the prefix.

    A blank prefix is rejected outright. Ranging from an empty key would sweep
    the entire keyspace: the read would succeed, return every object in the
    datastore, and V3's cardinality check would fail with a number in the
    thousands and no indication that the prefix was the problem.

    Raises:
        RawEtcdError: If the prefix is empty or is not ASCII.
    """
    __tracebackhide__ = True
    if isinstance(key_prefix, bytes):
        try:
            prefix = key_prefix.decode("ascii")
        except UnicodeDecodeError as exc:
            raise RawEtcdError(
                f"{_RQ}: etcd key prefix must be ASCII, got non-ASCII bytes "
                f"({exc.reason} at byte {exc.start}). A storage key is a path built from a "
                "UUID, a resource, a namespace and a name, all of which are ASCII."
            ) from exc
    else:
        prefix = key_prefix
    if not prefix:
        raise RawEtcdError(
            f"{_RQ}: etcd key prefix must not be empty. An empty prefix ranges over the "
            "WHOLE keyspace, so the scan would return every object in the datastore and "
            "the cardinality assertion would fail without saying why. Pass the output of "
            "etcd_key_for_secret()."
        )
    if not prefix.isascii():
        raise RawEtcdError(
            f"{_RQ}: etcd key prefix must be ASCII, got {prefix!r}. etcd3gw derives the "
            "range end by incrementing the prefix's last byte and decoding it, which a "
            "non-ASCII prefix cannot survive."
        )
    return prefix


@contextlib.contextmanager
def raw_etcd_client(
    url: str,
    *,
    timeout: float = DEFAULT_SCAN_TIMEOUT_SECONDS,
    ca_cert: str | None = None,
    client_cert: str | None = None,
    client_key: str | None = None,
) -> Iterator[RawEtcdKV]:
    """Open a raw etcd reader, and close it whatever happens next.

    PORTS ``GetEtcdClients(config storagebackend.TransportConfig)`` at
    test/integration/utils.go:69-72 together with the ``defer rawClient.Close()``
    that always accompanies it (encryption_test.go:115-120). Go's input is a
    transport config carrying a server list and, optionally, a CA file and a
    client key pair; the parameters below are that same input, spelled for a
    client that takes its endpoint apart.

    INVARIANT PRESERVED: the session is closed in a ``finally``, so it is
    released when the body returns, when the body raises and when the test is
    interrupted. Go relies on ``defer`` plus goleak to keep that honest; Python
    has neither, so the close is written out rather than assumed.

    Args:
        url: The endpoint, ``http://127.0.0.1:<port>`` - pass
            ``shared_etcd.url``. That fixture exposes TCP rather than the unix
            socket ``framework.RunCustomEtcd`` uses precisely because etcd3gw is
            an HTTP gateway client.
        timeout: The default budget for reads made through this reader, and the
            per-operation socket timeout of the underlying client. Bounded by
            :data:`DEFAULT_SCAN_TIMEOUT_SECONDS`.
        ca_cert: Path to a CA bundle verifying the server, for an ``https``
            endpoint. The Go input's ``TrustedCAFile``. Unused by the ported V3
            path: ``framework.SharedEtcd()`` leaves its transport insecure on
            purpose, documenting that a TLS config there would break the unix
            socket case.
        client_cert: Path to a client certificate. The Go input's ``CertFile``.
        client_key: Path to the matching private key. The Go input's ``KeyFile``.

    Yields:
        A :class:`RawEtcdKV` ready to read.

    Raises:
        RawEtcdError: If the endpoint is not an ``http``/``https`` URL with a
            host and port, if the budget is outside the ported bound, or if
            exactly one of ``client_cert`` and ``client_key`` is supplied.
    """
    __tracebackhide__ = True
    budget = _validated_budget(timeout)
    host, port, scheme = _split_endpoint(url)
    if bool(client_cert) != bool(client_key):
        # etcd3gw attaches a client certificate only when BOTH halves are
        # present, and silently ignores a lone one. A caller who believed it had
        # presented a certificate would then connect without one - a fail-open
        # outcome, which is the posture this suite exists to prevent. Refusing is
        # the only way to make the omission visible.
        raise RawEtcdError(
            f"{_RQ}: client_cert and client_key must be supplied together for {url!r}; got "
            f"client_cert={client_cert!r}, client_key={client_key!r}. etcd3gw ignores a "
            "lone half, so the connection would silently carry no client certificate."
        )

    # `api_path` is deliberately not passed. Omitting it leaves etcd3gw's own
    # lazy discovery in place - and leaves its $ETCD3GW_API_PATH override
    # working, which passing None would defeat, since that environment variable
    # IS the parameter's default.
    client = Etcd3Client(
        host=host,
        port=port,
        protocol=scheme,
        timeout=budget,
        ca_cert=ca_cert,
        cert_cert=client_cert,
        cert_key=client_key,
    )
    reader = RawEtcdKV(client, endpoint=url)
    try:
        yield reader
    finally:
        reader.close()


def read_prefix(
    url: str,
    key_prefix: str | bytes,
    *,
    timeout: float = DEFAULT_SCAN_TIMEOUT_SECONDS,
    ca_cert: str | None = None,
    client_cert: str | None = None,
    client_key: str | None = None,
) -> list[EtcdKeyValue]:
    """Perform one raw prefix scan and close the connection before returning.

    The whole of encryption_test.go:115-133 in a single call, for a caller that
    wants one read rather than a reader: it opens, scans and closes, with the
    close in the ``finally`` of :func:`raw_etcd_client` so a failed scan releases
    the socket just as a successful one does.

    Use it for a one-shot read. Prefer :func:`raw_etcd_client` when a test makes
    several reads, so that one connection serves them all rather than one
    connection - and one gateway-discovery round trip - per read.

    Args:
        url: The endpoint, ``shared_etcd.url``.
        key_prefix: The prefix to range over, from :func:`etcd_key_for_secret`.
        timeout: The total budget for the scan, bounded by
            :data:`DEFAULT_SCAN_TIMEOUT_SECONDS`.
        ca_cert: See :func:`raw_etcd_client`.
        client_cert: See :func:`raw_etcd_client`.
        client_key: See :func:`raw_etcd_client`.

    Returns:
        The matching entries, in etcd's order, uncounted - exactly as
        :meth:`RawEtcdKV.scan_prefix` returns them.

    Raises:
        RawEtcdError: For any of the reasons :func:`raw_etcd_client` and
            :meth:`RawEtcdKV.scan_prefix` raise it.
    """
    __tracebackhide__ = True
    with raw_etcd_client(
        url,
        timeout=timeout,
        ca_cert=ca_cert,
        client_cert=client_cert,
        client_key=client_key,
    ) as reader:
        return reader.scan_prefix(key_prefix, timeout=timeout)
