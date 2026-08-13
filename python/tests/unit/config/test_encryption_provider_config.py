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

"""V3 config-schema gate: shape and hygiene of the committed EncryptionConfiguration.

AAP §0.4.2.3 (the L3 config-schema blueprint that specifies this module) / §0.5.1
(this file's row in the test transformation map) / §0.10.2 (boundary conditions
that must port unchanged) / §0.11.1 (the enterprise-standard bar this work is held
to, no user rules being defined for this project) - and tech-spec §6.4.5
(encryption at rest) / §6.2.3.3 (key rotation and storage migration).

CONTROL UNDER TEST: V3, Secrets encryption at rest.

THE ARTEFACT UNDER TEST

``cluster/gce/manifests/encryption-provider-config.yml``, the GCE reference
EncryptionConfiguration template. It is not consumed verbatim from that path: an
operator base64-encodes it into ``ENCRYPTION_PROVIDER_CONFIG`` and, at boot,
``setup-etcd-encryption`` in ``cluster/gce/gci/configure-kubeapiserver.sh``
decodes it to ``/etc/srv/kubernetes/encryption-provider-config.yml`` and points
the kube-apiserver flag ``--encryption-provider-config`` at it. What ships in the
repository is therefore what an operator deploys, which is exactly why its shape
is worth gating.

The template is a READ-ONLY input here. This module decodes it and asserts. It
never edits it, never substitutes a fixture copy for it and never writes anything
anywhere.

REQUIREMENTS LOCKED BY THIS MODULE

* **F-003-RQ-001**, the provider configuration shape: the template covers exactly
  ``secrets`` and ``configmaps``; the STRONG provider is FIRST and ``identity``
  (plaintext) is LAST; the envelope provider declares ``apiVersion: v2``; no
  ``cachesize`` key appears anywhere, that tunable being KMS v1-only and rejected
  by the API server under v2; and the bounded KMS call timeout is ``3s``, the only
  committed bound on the envelope call, asserted as the string it parses as.
* **F-003-RQ-003**, credential hygiene: the KMS endpoint is the documented
  PLACEHOLDER ``unix:///tmp/kms.socket``, and nothing anywhere in the parsed
  document resembles key material - established four independent ways, by shape,
  by entropy, by the absence of any ``secret`` field and by the absence of the two
  V3 literals this tier owns.

NO GO ANCESTOR: THIS IS NEW AUTOMATION, NOT A PORT

The other V3 module in this tier, ``tests/integration/test_secrets_encryption.py``,
ports ``test/integration/secrets/encryption_test.go``. This module ports nothing.
The config-schema half of V3 is verified by HUMAN INSPECTION today, so writing it
down as pytest converts an inspection into a gate without changing one line of
production behaviour. It also cannot put the migration's success criterion at
risk: a check that has no verdict today has no verdict to contradict.

THE PITFALL THIS MODULE IS BUILT AROUND: COMMENTS ARE NOT DATA

The tokens ``cachesize``, ``aesgcm``, ``secret:`` and ``<BASE64_32_BYTE_KEY>`` all
appear in the RAW BYTES of the template - inside YAML comments. ``cachesize``
appears in the note explaining that it is a v1-only tunable; the other three
appear in a commented-out alternative static-key provider block documenting what
an operator would write INSTEAD of the KMS block. PyYAML discards comments, so
none of them survives into the parsed document. Measured against the artefact as
shipped: the raw text contains ``cachesize``, ``aesgcm`` and ``BASE64``, while a
JSON dump of the parse contains none of the three.

Every absence assertion below therefore walks the PARSED STRUCTURE, and not one
greps the raw text. A textual check would FAIL against the artefact as shipped -
not because the artefact is wrong, but because the check would be reading
documentation as if it were configuration. Where the natural shape of an
assertion and the shape of the file disagree like this, the file wins and the
reason is recorded; this paragraph is that record.

One place the distinction needs care: the substring ``secret`` DOES survive the
parse, because the resource name is ``secrets``. The key-material scan therefore
looks for a mapping KEY equal to exactly ``secret`` - the field an aesgcm provider
carries - and never for the substring.

ASSERTION SEMANTICS, KEPT DELIBERATELY ASYMMETRIC

Go's ``t.Fatalf`` (abort now) and ``t.Errorf`` (record and continue) are different
tools, and this port keeps them apart (AAP §0.4.1.2):

* SETUP BREAKAGE ABORTS, through a bare ``assert``. A manifest that is missing,
  unreadable, unparsable or structurally not an EncryptionConfiguration makes
  every finding below meaningless, and reporting five derived failures would bury
  the single fact that matters.
* INDEPENDENT FINDINGS ACCUMULATE, through pytest 9's native ``subtests``.
  Provider ordering, a forbidden ``cachesize``, the endpoint, the timeout and each
  individual string leaf of the document can all be wrong at once, and a security
  gate that stops at the first offender hides the rest.

WHY THERE IS NO parametrize AND NO FIXTURE IN THIS MODULE

* No ``@pytest.mark.parametrize`` over the document's contents. Its cases are
  enumerated at COLLECTION time, which would mean reading the manifest at import
  time; this module performs no I/O at import, so per-case reporting comes from
  ``subtests`` instead. The result is five stable node ids, and stability is a
  contract rather than a preference: ``tests/parity/parity_map.py`` is
  hand-maintained against node ids.
* No fixture and no ``conftest.py`` in this directory. Every fixture of this tier
  lives in a ``conftest.py`` - under ``--doctest-modules`` a module-, package- or
  session-scoped autouse fixture declared inline in a test module can execute
  twice - and the one fixture this module needs already exists: ``repo_root``,
  session-scoped, from ``python/tests/conftest.py``. The manifest is re-read once
  per test rather than cached in a module-level variable; it is a two-kilobyte
  file, and a cache would be precisely the module-level mutable state that makes a
  suite order-dependent.

PURITY. No subprocess, no network, no etcd, no API server, no clock and no write
of any kind: one ``read_text`` of a committed file, and arithmetic. That is what
makes this module part of ``-m "not integration"``, and what makes it safe under
``pytest-randomly`` and under ``pytest-xdist -n auto``.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, Final

import pytest
import yaml

from tests.fixtures.encryption_config import AESGCM_PREFIX, PLAINTEXT_CANARY

# `config` and not `shell`: this module runs no subprocess. The marker vocabulary
# in python/pyproject.toml is exactly `integration`, `shell`, `config`, `parity`
# and `slow`, and `addopts` carries `--strict-markers`, so anything else here
# would be a collection error rather than a typo. Applying it at module level -
# rather than per function - is what makes `-m "not integration"` and `-m config`
# select this file as a whole.
pytestmark = pytest.mark.config

# Every module-level name below is private. Nothing may import from a `test_*.py`
# module - the shared constants of this tier live in `tests/fixtures/` and its
# shared behaviour in `tests/helpers/` - and the leading underscore says so at the
# point of definition instead of in a comment somewhere else.

# ---------------------------------------------------------------------------
# Where the artefact is.
# ---------------------------------------------------------------------------

#: ``cluster/gce/manifests/encryption-provider-config.yml``, as path components to
#: be joined onto the ``repo_root`` fixture.
#:
#: Components rather than a string, so the join is platform-neutral. Relative to
#: ``repo_root`` rather than to ``__file__`` or to the process working directory,
#: because python/tests/conftest.py resolves the repository root once - from its
#: own location, checked against sentinel paths - and is the tier's single answer
#: to that question. It matters here specifically: hack/make-rules/test-python.sh
#: runs pytest from ``python/`` while a developer may run it from the repository
#: root, so a CWD-derived path would differ between the two with no way to tell
#: which was right.
_MANIFEST_RELATIVE_PATH: Final[tuple[str, ...]] = (
    "cluster",
    "gce",
    "manifests",
    "encryption-provider-config.yml",
)

# ---------------------------------------------------------------------------
# The expected document, measured from the artefact as shipped rather than
# transcribed from prose. `yaml.safe_load` of the template returns exactly:
#
#   {"apiVersion": "apiserver.config.k8s.io/v1",
#    "kind": "EncryptionConfiguration",
#    "resources": [{"resources": ["secrets", "configmaps"],
#                   "providers": [{"kms": {"apiVersion": "v2",
#                                          "name": "k8s-kms",
#                                          "endpoint": "unix:///tmp/kms.socket",
#                                          "timeout": "3s"}},
#                                 {"identity": {}}]}]}
# ---------------------------------------------------------------------------

#: The envelope's ``apiVersion`` (manifest L35). It versions the CONFIGURATION
#: DOCUMENT, and is not the version of any provider inside it: the KMS block
#: carries its own, and conflating the two is how a v2 provider ends up
#: configured as v1.
_EXPECTED_API_VERSION: Final[str] = "apiserver.config.k8s.io/v1"

#: The envelope's ``kind`` (manifest L36).
_EXPECTED_KIND: Final[str] = "EncryptionConfiguration"

#: The key naming a resource list. It appears at BOTH nesting levels - once on the
#: envelope, listing resource entries, and once inside each entry, listing the
#: resource types that entry encrypts - which is exactly why it is named here
#: rather than typed twice as a bare literal.
_RESOURCES_KEY: Final[str] = "resources"

#: The key naming an entry's ordered provider list.
_PROVIDERS_KEY: Final[str] = "providers"

#: The resource types the template encrypts, IN ORDER (manifest L41-42).
#:
#: INVARIANT LOCKED (F-003-RQ-001): both entries, and only these two. ``secrets``
#: is the control's whole point and also covers legacy ServiceAccount-token
#: Secrets (type ``kubernetes.io/service-account-token``); ``configmaps`` is
#: covered because configuration routinely carries material that is sensitive in
#: practice. Asserted as an exact list and not as a superset, so that silently
#: DROPPING ``secrets`` fails here rather than being discovered from an etcd
#: snapshot.
_EXPECTED_ENCRYPTED_RESOURCES: Final[tuple[str, ...]] = ("secrets", "configmaps")

#: How many providers the entry declares (manifest L43-64): the strong provider
#: and the decrypt-only plaintext fallback.
_EXPECTED_PROVIDER_COUNT: Final[int] = 2

#: The strong provider's block name (manifest L46). KMS v2 is the shipped choice:
#: it places no ceiling on the number of encrypted Secrets and keeps key
#: management outside the API server.
_STRONG_PROVIDER_KEY: Final[str] = "kms"

#: The plaintext fallback's block name (manifest L64).
_IDENTITY_PROVIDER_KEY: Final[str] = "identity"

#: The only provider block names permitted anywhere in the template.
#:
#: A third kind appearing here is not a style question. The commented-out
#: alternative in the template is a static-key ``aesgcm`` provider whose keys
#: carry raw base64 key material, so an activated third provider block is the
#: most likely route by which key material would arrive in this file - which is
#: why this set is asserted by the credential-hygiene test rather than by the
#: ordering test.
_PERMITTED_PROVIDER_KEYS: Final[frozenset[str]] = frozenset(
    {_STRONG_PROVIDER_KEY, _IDENTITY_PROVIDER_KEY}
)

#: The KMS block's own ``apiVersion`` (manifest L47).
_EXPECTED_KMS_API_VERSION: Final[str] = "v2"

#: The KMS block's ``name`` (manifest L48). A PLACEHOLDER, operator-defined.
_EXPECTED_KMS_NAME: Final[str] = "k8s-kms"

#: The KMS block's ``endpoint`` (manifest L49).
#:
#: INVARIANT LOCKED (F-003-RQ-003): this exact PLACEHOLDER, and nothing an
#: operator actually provisioned. It is one of only two key-material-adjacent
#: literals this repository's tests are permitted to contain, and the reason it is
#: permitted is that it points at nothing: a unix socket under ``/tmp`` that no
#: shipped component creates.
_PLACEHOLDER_KMS_ENDPOINT: Final[str] = "unix:///tmp/kms.socket"

#: The KMS block's ``timeout`` (manifest L50), and the string it parses as.
#:
#: INVARIANT LOCKED (F-003-RQ-001): ``3s``, a Go duration string, bounding every
#: gRPC call the API server makes to the KMS plugin. It is the ONLY committed
#: bound on the envelope call, so an unbounded or wildly larger value converts a
#: sick KMS plugin into a stalled API server. Compared as a STRING and never
#: coerced to a number: PyYAML parses ``3s`` as ``str`` (measured), the API server
#: parses it as a duration, and a test that quietly accepted ``3`` would be
#: accepting a document the API server rejects.
_EXPECTED_KMS_TIMEOUT: Final[str] = "3s"

# ---------------------------------------------------------------------------
# The three key sets that close the document.
#
# Together with the exact resource list, the single resource entry and the closed
# set of provider kinds, these three enumerate EVERY position in the template at
# which a value can sit. That is what makes the credential scan complete rather
# than merely broad: an unexpected field is reported BY NAME, whatever it contains,
# so key material cannot arrive in a place no assertion looks at.
#
# The closure is load-bearing precisely because the shape and entropy heuristics
# have measured limits. A 32-byte AES key base64-encodes to 44 characters and is
# caught twice over - by shape, and at about 4.9 bits per character by entropy -
# but a SHORT, SMALL-ALPHABET encoding is caught by neither: 32 hexadecimal
# characters is below the 40-character shape floor and measures about 3.6 bits per
# character, indistinguishable from ordinary configuration text. No threshold
# tightening fixes that without flagging the template's own legitimate values,
# whose busiest measures 3.950. Enumerating the document instead does fix it, and
# without a single false positive.
# ---------------------------------------------------------------------------

#: Every key the envelope may declare (manifest L35-37).
_EXPECTED_ENVELOPE_KEYS: Final[frozenset[str]] = frozenset(
    {"apiVersion", "kind", _RESOURCES_KEY}
)

#: Every key the single resource entry may declare (manifest L38-43).
_EXPECTED_RESOURCE_ENTRY_KEYS: Final[frozenset[str]] = frozenset(
    {_RESOURCES_KEY, _PROVIDERS_KEY}
)

#: Every key the KMS provider body may declare (manifest L47-50). Each of the four
#: has its value asserted exactly, so pinning the key set pins the whole block.
_EXPECTED_KMS_KEYS: Final[frozenset[str]] = frozenset(
    {"apiVersion", "name", "endpoint", "timeout"}
)

# ---------------------------------------------------------------------------
# What must be absent.
# ---------------------------------------------------------------------------

#: A KMS v1-only tunable (manifest L51-53 documents it, in a comment, as exactly
#: that).
#:
#: INVARIANT LOCKED (F-003-RQ-001): absent from every mapping in the document. The
#: API server rejects it under ``apiVersion: v2`` - "cachesize is not supported in
#: v2" - so its presence does not degrade encryption, it prevents the API server
#: from starting at all. That makes this a boundary worth a gate: the failure
#: shows up at boot, on a control-plane node, rather than in review.
_FORBIDDEN_KMS_V2_KEY: Final[str] = "cachesize"

#: The mapping key an aesgcm provider carries its raw base64 key under.
#:
#: INVARIANT LOCKED (F-003-RQ-003): no mapping anywhere in the document has this
#: key. Matched as an EXACT KEY and never as a substring, because the resource
#: name ``secrets`` contains it and a substring test would flag the correctly
#: configured template.
_KEY_MATERIAL_FIELD_NAME: Final[str] = "secret"

#: A base64 blob of about the length key material produces.
#:
#: A 32-byte AES-GCM key base64-encodes to 44 characters, so the floor is set
#: BELOW that, at 40, to catch a near-miss encoding (a differently sized key, a
#: truncated paste) rather than only the exact expected length. The character
#: class is deliberately narrow, and none of the template's legitimate string
#: values can match it: the longest is ``unix:///tmp/kms.socket`` at 22
#: characters, and it contains ``:`` and ``/``, which the class excludes.
#:
#: The anchors are retained verbatim from the specification of this check, and
#: :meth:`re.Pattern.fullmatch` is used rather than :meth:`re.Pattern.match` so
#: that the trailing newline ``$`` would otherwise tolerate cannot smuggle a blob
#: past the gate.
_BASE64_BLOB_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9+/]{40,}={0,2}$")

#: Only strings at least this long are entropy-scanned. Below it the measure is
#: dominated by sampling noise - a four-character string cannot have high entropy
#: whatever it contains - and a false alarm on a short legitimate value would
#: teach the reader to ignore this test, which is worse than not having it. Short
#: strings are still shape-checked against :data:`_BASE64_BLOB_PATTERN`, so
#: nothing goes unexamined.
_ENTROPY_SCAN_MIN_LENGTH: Final[int] = 20

# ---------------------------------------------------------------------------
# Raw-artefact credential scan (F-003-RQ-003, the COMMENT blind spot)
# ---------------------------------------------------------------------------
# Everything above walks the PARSED document, which is the right way to assert
# structure - and is blind to exactly one thing: a YAML comment. The parser
# discards comments, so key material pasted into one is invisible to every leaf,
# shape and entropy check in this module. The artefact ships with a large
# commented-out alternative provider block (lines 54-59), which is precisely
# where a hurried operator would paste a real key "just to try it".
#
# WHAT THIS SCAN IS NOT. It does not grep the raw text for `cachesize`, `aesgcm`,
# `secret:` or `<BASE64_32_BYTE_KEY>`. Those four tokens are legitimately present
# in that comment block, so a token scan would fail against the artefact exactly
# as shipped and correct - which is why the structural checks above exist. This
# scan looks for the SHAPE of a credential instead, which is orthogonal: no
# amount of explanatory prose about a key looks like a key.
#
# CALIBRATED AGAINST THE SHIPPED FILE, not assumed. Measured: the artefact
# contains exactly three base64-alphabet tokens of 20+ characters
# (`/etc/srv/kubernetes/encryption`, `cluster/gce/gci/configure`,
# `EncryptionConfiguration`), whose worst entropy is 3.644 against a 4.0 ceiling
# - a comfortable margin, and zero false positives today.
#
# THE ALPHABET RESTRICTION IS LOAD-BEARING. Applying the leaf-value entropy
# ceiling to raw WHITESPACE-delimited tokens produces three false positives,
# because file paths mix many distinct characters and score above 4.0
# (`/etc/srv/kubernetes/encryption-provider-config.yml` measures 4.201). Real
# base64 key material cannot contain `.`, `-`, `_`, `<` or `:`, so restricting
# the token alphabet to base64's own excludes paths and dotted identifiers
# structurally rather than by a fudged threshold.
#
# EVERY RULE BELOW IS LOAD-BEARING - verified by measuring each against
# representative credentials, where each is caught by exactly one rule:
#   * a random 32-byte base64 key (44 chars)      -> blob shape only
#   * the AES-GCM 16-byte test key (24 chars)     -> entropy only (4.054); too
#     short for the 40-character blob pattern
#   * a 32-character hex digest                   -> hex rule only (entropy 3.640)
#   * a PEM header                                -> PEM rule only (entropy 0.000)
#   * a JWT                                       -> JWT rule only

#: A PEM armour header of any type - private keys, certificates, EC parameters.
_PEM_BLOCK_PATTERN: Final[re.Pattern[str]] = re.compile(r"-----BEGIN [A-Z0-9 ]*-----")

#: A JWT: the `eyJ` signature of a base64url-encoded `{"` header, then at least
#: one dot-separated base64url segment. Catches ServiceAccount tokens, which are
#: the credential most likely to be pasted into a Kubernetes config by mistake.
_JWT_PATTERN: Final[re.Pattern[str]] = re.compile(r"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}")

#: 32+ hex characters: a digest, a hex-encoded key, or an IV. Deliberately
#: separate from the entropy rule, which a hex string evades - a 32-character hex
#: digest measures only 3.640 bits per character because its alphabet is 16 wide.
_HEX_BLOB_PATTERN: Final[re.Pattern[str]] = re.compile(r"[0-9a-fA-F]{32,}")

#: Candidate credential tokens in raw text: runs drawn purely from base64's
#: alphabet, with optional padding. See the alphabet-restriction note above.
_RAW_CREDENTIAL_TOKEN_PATTERN: Final[re.Pattern[str]] = re.compile(
    rf"[A-Za-z0-9+/]{{{_ENTROPY_SCAN_MIN_LENGTH},}}={{0,2}}"
)

#: The two documented placeholders, excised before scanning. NARROW BY DESIGN: an
#: allow-list is how a credential scan gets quietly disabled, so it holds exactly
#: these two literals, both of which the module already asserts positively
#: elsewhere (the endpoint by equality, the key field by absence).
#:
#: Honest note: neither is flagged by any rule above as they stand -
#: `<BASE64_32_BYTE_KEY>` contains `<`, `>` and `_`, and `unix:///tmp/kms.socket`
#: contains `.` and `:`, so both fall outside the token alphabet. The excision is
#: therefore defensive rather than currently load-bearing: it keeps a future rule
#: from flagging the very placeholders this template is designed to ship, without
#: widening what is tolerated today.
_RAW_SCAN_ALLOWED_PLACEHOLDERS: Final[tuple[str, ...]] = (
    "<BASE64_32_BYTE_KEY>",
    "unix:///tmp/kms.socket",
)

#: The Shannon-entropy ceiling, in bits per character, for a scanned string.
#:
#: Measured against the artefact and against real key material rather than chosen
#: by feel. Of the template's eight string values the three at least
#: :data:`_ENTROPY_SCAN_MIN_LENGTH` characters long measure 3.588
#: (``EncryptionConfiguration``), 3.732 (``unix:///tmp/kms.socket``) and 3.950
#: (``apiserver.config.k8s.io/v1``) bits per character. For comparison the
#: shortest key-material literal this repository permits anywhere - the documented
#: non-secret aesgcm test key owned by ``tests/fixtures/encryption_config.py`` -
#: measures 4.054, and a base64-encoded random 32-byte key averages 4.89 over 200
#: samples with a measured minimum of 4.52.
#:
#: 4.0 therefore sits inside the measured gap [3.950, 4.054]: it is the tightest
#: ceiling that admits every legitimate value in the template while rejecting even
#: the least random key material in the repository. The comparison is strict
#: (``<``), and the margin above the busiest legitimate value is deliberately thin
#: - a new high-entropy string in a deployment template is a thing a reviewer
#: should have to look at, and this gate fails closed.
#:
#: KNOWN LIMIT, stated rather than glossed: entropy per character discriminates
#: poorly for SHORT strings over SMALL alphabets. Measured over 200 samples each, a
#: base64-encoded random 16-byte key (24 characters) averages 4.22 but dips to
#: 3.80, and 32 hexadecimal characters average 3.61 - below this ceiling, and below
#: the 40-character floor of :data:`_BASE64_BLOB_PATTERN` as well. Lowering the
#: ceiling to reach them would flag ``apiserver.config.k8s.io/v1``. What closes
#: that gap is not a better threshold but the three key sets above: with the
#: document fully enumerated, a value can only exist where an assertion already
#: looks at it.
_MAX_PERMITTED_ENTROPY_BITS_PER_CHAR: Final[float] = 4.0


# ---------------------------------------------------------------------------
# Loading, and the setup-breakage boundary.
#
# Everything in this section ABORTS on failure with a bare `assert`, and every
# message it raises begins with "SETUP". That prefix is the contract between this
# section and a reader of a CI log: a SETUP failure says the document could not be
# examined, while a message naming F-003-RQ-001 or F-003-RQ-003 says the document
# WAS examined and is wrong. Collapsing the two would make a checkout problem
# indistinguishable from a security regression.
# ---------------------------------------------------------------------------


def _manifest_path(repo_root: Path) -> Path:
    """Absolute path of the committed EncryptionConfiguration template."""
    return repo_root.joinpath(*_MANIFEST_RELATIVE_PATH)


def _raw_manifest_text(repo_root: Path) -> str:
    """The committed template as raw text, comments and all.

    Deliberately NOT routed through :func:`_load_manifest`: the whole purpose is to
    see what the YAML parser throws away.

    Aborts rather than accumulating a finding when the file cannot be read, for the
    same reason as :func:`_load_manifest` - there is then no artefact to make a
    statement about.
    """
    __tracebackhide__ = True

    path = _manifest_path(repo_root)
    assert path.is_file(), (
        f"SETUP: {path} is not a file, so the raw-artefact credential scan has nothing "
        f"to examine."
    )
    return path.read_text(encoding="utf-8")


def _scan_raw_for_credential_material(text: str) -> dict[str, list[str]]:
    """Find credential-SHAPED material in raw text, by rule.

    The documented placeholders are excised first, then each rule is applied to
    what remains. Results are keyed by rule so a failure names WHICH shape was
    found - a PEM block and a high-entropy token are different incidents needing
    different responses.

    Args:
        text: The raw artefact text, comments included.

    Returns:
        A mapping from rule name to the matching evidence, in first-seen order.
        A rule with no findings is absent from the mapping, so an empty mapping
        means the artefact is clean.
    """
    scanned = text
    for placeholder in _RAW_SCAN_ALLOWED_PLACEHOLDERS:
        scanned = scanned.replace(placeholder, " ")

    findings: dict[str, list[str]] = {}

    def record(rule: str, evidence: str) -> None:
        bucket = findings.setdefault(rule, [])
        if evidence not in bucket:
            bucket.append(evidence)

    for match in _PEM_BLOCK_PATTERN.finditer(scanned):
        record("pem-block", match.group(0))
    for match in _JWT_PATTERN.finditer(scanned):
        record("jwt", match.group(0)[:32] + "...")
    for match in _HEX_BLOB_PATTERN.finditer(scanned):
        record("hex-blob", match.group(0))

    for match in _RAW_CREDENTIAL_TOKEN_PATTERN.finditer(scanned):
        token = match.group(0)
        if _BASE64_BLOB_PATTERN.fullmatch(token) is not None:
            record("base64-blob-shape", token)
            continue
        entropy = _shannon_entropy_bits_per_char(token)
        if entropy >= _MAX_PERMITTED_ENTROPY_BITS_PER_CHAR:
            record("high-entropy-token", f"{token} ({entropy:.3f} bits/char)")

    for label, literal in (
        ("aesgcm-ciphertext-prefix", AESGCM_PREFIX),
        ("plaintext-canary", PLAINTEXT_CANARY),
    ):
        if literal in scanned:
            record(label, literal)

    return findings


def _load_manifest(repo_root: Path) -> Mapping[str, Any]:
    """Decode the committed template, or abort as setup breakage.

    Aborts - rather than accumulating a finding - when the file is missing, is not
    a file, cannot be decoded as UTF-8, is not valid YAML, or does not parse to a
    mapping. None of those is a statement about the security posture of the
    document; each is a statement that there is no document to make one about.

    ``yaml.safe_load`` and never ``yaml.load``: the input is a committed
    deployment artefact, and the safe loader constructs only standard scalars,
    sequences and mappings. It is also correct here for a second reason - the
    template is a SINGLE YAML document with no ``---`` separators, so the
    single-document loader is the one that matches the file.
    """
    __tracebackhide__ = True

    path = _manifest_path(repo_root)
    assert path.is_file(), (
        f"SETUP: the committed EncryptionConfiguration template is missing at {path}. "
        "This module asserts the shape of that artefact; without it there is nothing "
        "to assert. Check that repo_root resolved to a genuine checkout."
    )

    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:  # pragma: no cover - I/O failure
        pytest.fail(f"SETUP: cannot read {path} as UTF-8 text: {error!r}")

    try:
        document = yaml.safe_load(raw)
    except yaml.YAMLError as error:
        pytest.fail(
            f"SETUP: {path} is not valid YAML and cannot be decoded: {error!r}. "
            "A template the API server cannot parse is a deployment defect, but it "
            "is not a finding this module can attribute to a requirement."
        )

    assert isinstance(document, Mapping), (
        f"SETUP: {path} must decode to a YAML mapping, got {type(document).__name__}. "
        "An EncryptionConfiguration is a mapping with `apiVersion`, `kind` and "
        f"`{_RESOURCES_KEY}` at its top level."
    )
    return document


def _encrypted_resource_entry(document: Mapping[str, Any]) -> Mapping[str, Any]:
    """Validate the envelope and return its single resource entry, or abort.

    The envelope - ``apiVersion``, ``kind`` and exactly one entry under
    ``resources`` - is treated as setup breakage rather than as a finding. A
    document with the wrong ``kind`` is not a misconfigured EncryptionConfiguration;
    it is not an EncryptionConfiguration, and every assertion this module would go
    on to make about providers, endpoints and key material would be reporting the
    absence of a document rather than a property of one.
    """
    __tracebackhide__ = True

    assert document.get("apiVersion") == _EXPECTED_API_VERSION, (
        f"SETUP: envelope apiVersion must be {_EXPECTED_API_VERSION!r}, got "
        f"{document.get('apiVersion')!r}. This versions the configuration document "
        "itself; the KMS provider carries its own apiVersion separately."
    )
    assert document.get("kind") == _EXPECTED_KIND, (
        f"SETUP: envelope kind must be {_EXPECTED_KIND!r}, got {document.get('kind')!r}."
    )

    entries = document.get(_RESOURCES_KEY)
    assert isinstance(entries, list), (
        f"SETUP: top-level `{_RESOURCES_KEY}` must be a list of resource entries, got "
        f"{type(entries).__name__}."
    )
    assert len(entries) == 1, (
        f"SETUP: expected exactly 1 top-level `{_RESOURCES_KEY}` entry, found "
        f"{len(entries)}. This module asserts the shape of the single committed "
        "entry; a template that has grown a second one needs its assertions "
        "extended deliberately, not silently applied to entry zero."
    )

    entry = entries[0]
    assert isinstance(entry, Mapping), (
        f"SETUP: the `{_RESOURCES_KEY}` entry must be a mapping, got "
        f"{type(entry).__name__}."
    )
    return entry


def _providers(entry: Mapping[str, Any]) -> list[Any]:
    """Return the entry's ordered provider list, or abort as setup breakage.

    Provider ORDER is a security property and is asserted by
    :func:`test_strong_provider_first_identity_last`. Provider list EXISTENCE is
    not: without a list there is no order to assert, so its absence aborts here.
    """
    __tracebackhide__ = True

    providers = entry.get(_PROVIDERS_KEY)
    assert isinstance(providers, list), (
        f"SETUP: `{_PROVIDERS_KEY}` must be a list, got {type(providers).__name__}. "
        "Provider order is the whole point of the list, so an unordered mapping "
        "cannot express this configuration."
    )
    assert providers, (
        f"SETUP: `{_PROVIDERS_KEY}` is empty. An EncryptionConfiguration with no "
        "provider configures nothing, and the API server rejects it."
    )
    return providers


def _provider_keys(provider: object) -> tuple[str, ...]:
    """Block names declared by one provider entry, in document order.

    A well-formed provider entry is a single-key mapping - ``kms:``, ``identity:``
    - so the expected result is a one-tuple. Anything else is returned as it is
    rather than rejected here, so that the caller can report WHAT it found: an
    empty tuple for a non-mapping, a longer tuple for an entry that fused two
    providers into one block. Both are findings, and a helper that raised would
    turn a reportable finding into an error with no value attached.
    """
    if isinstance(provider, Mapping):
        return tuple(str(key) for key in provider)
    return ()


def _kms_provider_body(document: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return the sole KMS provider body, or abort as setup breakage.

    Located by SEARCHING the provider list rather than by assuming index zero, so
    that this module's field assertions - endpoint, timeout, provider apiVersion -
    stay independent of its ORDERING assertion. A regression that moved
    ``identity`` in front of ``kms`` should fail exactly one test, the one that
    owns provider ordering, instead of cascading through every test that needs to
    read a KMS field.
    """
    __tracebackhide__ = True

    bodies = [
        provider[_STRONG_PROVIDER_KEY]
        for provider in _providers(_encrypted_resource_entry(document))
        if isinstance(provider, Mapping) and _STRONG_PROVIDER_KEY in provider
    ]
    assert len(bodies) == 1, (
        f"SETUP: expected exactly one `{_STRONG_PROVIDER_KEY}` provider block, found "
        f"{len(bodies)}. Provider ORDERING and the set of PERMITTED provider kinds "
        "are findings owned by test_strong_provider_first_identity_last and "
        "test_no_real_key_material_committed respectively; this abort only reports "
        "that there is no single KMS block whose fields could be read."
    )

    body = bodies[0]
    assert isinstance(body, Mapping), (
        f"SETUP: the `{_STRONG_PROVIDER_KEY}` provider body must be a mapping, got "
        f"{type(body).__name__}."
    )
    return body


# ---------------------------------------------------------------------------
# Walking the parsed document.
#
# Both walkers carry a path so that a failure names WHERE it was found. A message
# reading "$.resources[0].providers[0].kms" is actionable; one reading "somewhere
# in the document" sends the reader back to the file to search by hand.
#
# `str` is tested before `list`/`tuple` in the leaf walker because a `str` is
# itself a sequence: without that order a string would be walked character by
# character, forever - each character being another one-character string.
# ---------------------------------------------------------------------------


def _iter_mappings_with_path(
    node: object, path: str = "$"
) -> Iterator[tuple[str, Mapping[Any, Any]]]:
    """Yield ``(path, mapping)`` for every mapping in the tree, root included."""
    if isinstance(node, Mapping):
        yield path, node
        for key, value in node.items():
            yield from _iter_mappings_with_path(value, f"{path}.{key}")
    elif isinstance(node, (list, tuple)):
        for index, item in enumerate(node):
            yield from _iter_mappings_with_path(item, f"{path}[{index}]")


def _iter_string_leaves_with_path(node: object, path: str = "$") -> Iterator[tuple[str, str]]:
    """Yield ``(path, value)`` for every string VALUE in the tree.

    Values only, never keys. A mapping key is part of the schema - ``apiVersion``,
    ``endpoint``, ``timeout`` - and is fixed by what the API server understands,
    whereas a value is what an operator supplies and is therefore where key
    material would arrive. Scanning keys as well would add nothing and would put
    the schema's own vocabulary through an entropy test.
    """
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, Mapping):
        for key, value in node.items():
            yield from _iter_string_leaves_with_path(value, f"{path}.{key}")
    elif isinstance(node, (list, tuple)):
        for index, item in enumerate(node):
            yield from _iter_string_leaves_with_path(item, f"{path}[{index}]")


def _paths_of_mappings_declaring(document: Mapping[str, Any], key: str) -> list[str]:
    """Paths of every mapping in ``document`` that declares ``key``.

    The whole document is walked rather than only the place the key is expected,
    because "not where I looked" is a weaker statement than "nowhere". A forbidden
    tunable pasted one level up, or into the identity block, is still a document
    the API server rejects.
    """
    return [path for path, mapping in _iter_mappings_with_path(document) if key in mapping]


def _shannon_entropy_bits_per_char(value: str) -> float:
    """Shannon entropy of ``value`` over its own characters, in bits per character.

    Zero for the empty string, which has no distribution to measure. The measure
    is per character rather than total so that the threshold is independent of
    length: a long low-entropy sentence and a short low-entropy word both score
    low, while base64 of random bytes scores high at any length worth scanning.
    """
    if not value:
        return 0.0

    length = len(value)
    return -sum(
        (count / length) * math.log2(count / length) for count in Counter(value).values()
    )


# ---------------------------------------------------------------------------
# The gate.
#
# Five tests, five stable node ids, each owning one invariant. They are separate
# functions rather than one sweep because a CI reader should be able to tell from
# the FAILING NAME which property of the template regressed, and because each
# should be able to fail without disabling the others.
# ---------------------------------------------------------------------------


def test_encrypts_secrets_and_configmaps(repo_root: Path, subtests: pytest.Subtests) -> None:
    """F-003-RQ-001: the template encrypts exactly `secrets` and `configmaps`.

    INVARIANT LOCKED: the resource coverage of V3, plus the envelope that gives it
    meaning. Encryption at rest protects only the resource types listed here, so a
    dropped entry silently returns that resource type to plaintext in etcd with
    every other assertion in this module still green - the KMS block would be
    perfectly configured and simply not applied to Secrets any more.

    Both directions are asserted, and deliberately: membership, once per expected
    type, so a removal names what was removed; and exact ordered equality, so an
    ADDITION is also surfaced. An addition is not necessarily wrong, but it widens
    what the KMS plugin is asked to wrap and is a decision that belongs in review
    rather than in a diff nobody was gated on.

    The envelope check rides in through `_encrypted_resource_entry`: `apiVersion`,
    `kind` and the single resource entry abort as SETUP breakage, because a
    document that is not an EncryptionConfiguration has no resource coverage to be
    right or wrong about.
    """
    entry = _encrypted_resource_entry(_load_manifest(repo_root))

    declared = entry.get(_RESOURCES_KEY)
    assert isinstance(declared, list), (
        f"SETUP: the entry's `{_RESOURCES_KEY}` must be a list of resource types, got "
        f"{type(declared).__name__}."
    )

    for expected in _EXPECTED_ENCRYPTED_RESOURCES:
        with subtests.test(resource=expected):
            assert expected in declared, (
                f"F-003-RQ-001: `{expected}` is not covered by the committed "
                f"EncryptionConfiguration ({declared!r}). Encryption at rest applies "
                f"ONLY to the listed resource types, so `{expected}` would be stored "
                "in etcd as plaintext."
            )

    with subtests.test(check="exact-resource-list"):
        assert tuple(declared) == _EXPECTED_ENCRYPTED_RESOURCES, (
            "F-003-RQ-001: the covered resource list must be exactly "
            f"{list(_EXPECTED_ENCRYPTED_RESOURCES)!r}, got {declared!r}. A removal "
            "returns a resource type to plaintext; an addition widens what the KMS "
            "plugin is asked to wrap. Either way the change belongs in review, so "
            "update this expectation deliberately rather than relaxing the assertion."
        )


def test_strong_provider_first_identity_last(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """F-003-RQ-001: the strong provider is FIRST and `identity` is LAST.

    INVARIANT LOCKED: which provider encrypts. The API server uses the FIRST
    provider in the list to encrypt every new write, and tries ALL listed providers
    in order when decrypting. Two consequences follow, and this test exists for
    both:

    * `identity` FIRST would mean nothing is encrypted. Every new write would go
      through the plaintext transformer while the KMS block sat below it looking
      correctly configured, and a reviewer reading the file would see a KMS
      endpoint, a v2 apiVersion and a bounded timeout - all true, all inert.
    * `identity` LAST is what keeps already-plaintext Secrets readable during the
      storage migration that follows enablement (tech-spec §6.2.3.3). It is a
      decrypt-only fallback, and the template's own comments record that it should
      be REMOVED once that migration completes.

    Asserted POSITIONALLY - ``[0]`` and ``[-1]`` - because position is the
    mechanism. A membership test ("the list contains a kms block") would pass on
    the exact configuration this test exists to reject.

    The provider COUNT is a finding rather than setup breakage: a third provider
    is a real configuration to report, and the positional assertions remain
    meaningful beside it, so it must not abort them.
    """
    providers = _providers(_encrypted_resource_entry(_load_manifest(repo_root)))

    with subtests.test(check="provider-count"):
        assert len(providers) == _EXPECTED_PROVIDER_COUNT, (
            f"F-003-RQ-001: expected {_EXPECTED_PROVIDER_COUNT} providers (the strong "
            f"provider and the decrypt-only `{_IDENTITY_PROVIDER_KEY}` fallback), found "
            f"{len(providers)}: {[_provider_keys(p) for p in providers]!r}."
        )

    with subtests.test(check="strong-provider-first"):
        assert _provider_keys(providers[0]) == (_STRONG_PROVIDER_KEY,), (
            "F-003-RQ-001: the FIRST provider must be the single-key block "
            f"`{_STRONG_PROVIDER_KEY}`, found {_provider_keys(providers[0])!r}. The "
            "first provider encrypts every new write, so anything else here - "
            f"`{_IDENTITY_PROVIDER_KEY}` above all - means new Secrets are written to "
            "etcd unencrypted while the rest of this document still reads as correct."
        )

    with subtests.test(check="identity-provider-last"):
        assert _provider_keys(providers[-1]) == (_IDENTITY_PROVIDER_KEY,), (
            "F-003-RQ-001: the LAST provider must be the single-key block "
            f"`{_IDENTITY_PROVIDER_KEY}`, found {_provider_keys(providers[-1])!r}. It is "
            "the decrypt-only plaintext fallback that keeps already-stored Secrets "
            "readable until the storage migration completes (tech-spec §6.2.3.3)."
        )

    last = providers[-1]
    identity_body = last.get(_IDENTITY_PROVIDER_KEY) if isinstance(last, Mapping) else None

    with subtests.test(check="identity-body-is-mapping"):
        assert isinstance(identity_body, Mapping), (
            f"F-003-RQ-001: `{_IDENTITY_PROVIDER_KEY}` must be an empty MAPPING (`{{}}`), "
            f"got {identity_body!r}. Written as a bare `{_IDENTITY_PROVIDER_KEY}:` with "
            "no value it parses as null, which is not the same document."
        )

    with subtests.test(check="identity-body-empty"):
        assert identity_body == {}, (
            f"F-003-RQ-001: `{_IDENTITY_PROVIDER_KEY}` must be exactly `{{}}`, got "
            f"{identity_body!r}. The plaintext provider is configurationless; anything "
            "inside it is a key nothing reads."
        )


def test_no_cachesize_under_kms_v2(repo_root: Path, subtests: pytest.Subtests) -> None:
    """F-003-RQ-001: no `cachesize` anywhere, because the KMS provider is v2.

    INVARIANT LOCKED: the template starts. `cachesize` is a KMS v1-only tunable and
    the API server REJECTS it under `apiVersion: v2` ("cachesize is not supported
    in v2"), so its presence does not weaken encryption - it stops the API server
    from booting, on a control-plane node, after the change has shipped. The two
    halves are asserted together because neither means much alone: the forbidden
    key matters BECAUSE the provider is v2, and the provider being v2 is what makes
    the key forbidden.

    THIS CHECK IS DELIBERATELY STRUCTURAL, NOT TEXTUAL. The string `cachesize`
    appears in the template's RAW BYTES - twice, at L51 and L53 - inside the
    comment that explains it is v1-only and shows the v1 spelling. PyYAML discards
    comments, so it does not survive into the parse. A `grep` of the file, or an
    `in raw_text` test, would therefore FAIL against the artefact exactly as
    shipped and correct: it would be reading the documentation as configuration.
    The walk below asks the only question that matters to the API server - is there
    a MAPPING KEY named `cachesize` anywhere in the parsed document.

    Nor does this test assert that the explanatory comment is present. Requiring it
    would make deleting a comment a security failure, which is not true, and would
    reintroduce the raw-text dependency this note exists to remove.
    """
    document = _load_manifest(repo_root)

    # Resolved OUTSIDE the subtest blocks, deliberately. `_kms_provider_body` aborts
    # on setup breakage, and an abort raised INSIDE `with subtests.test(...)` would be
    # captured by that context manager and demoted to a subtest failure - which is
    # precisely the abort-versus-accumulate collapse this module's docstring rules
    # out. Hoisting it keeps a SETUP failure aborting and a finding accumulating.
    kms = _kms_provider_body(document)

    with subtests.test(check="kms-provider-is-v2"):
        assert kms.get("apiVersion") == _EXPECTED_KMS_API_VERSION, (
            f"F-003-RQ-001: the `{_STRONG_PROVIDER_KEY}` provider must declare "
            f"apiVersion {_EXPECTED_KMS_API_VERSION!r}, got "
            f"{kms.get('apiVersion')!r}. v2 is the shipped choice: no ceiling on the "
            "number of encrypted Secrets, and key management kept outside the API "
            "server."
        )

    with subtests.test(check="no-cachesize-anywhere"):
        offenders = _paths_of_mappings_declaring(document, _FORBIDDEN_KMS_V2_KEY)
        assert offenders == [], (
            f"F-003-RQ-001: `{_FORBIDDEN_KMS_V2_KEY}` is a KMS v1-only tunable and the "
            f"API server rejects it under apiVersion {_EXPECTED_KMS_API_VERSION!r}, but "
            f"it is declared at {offenders!r}. This does not weaken encryption - it "
            "prevents the API server from starting. Remove the key; do not switch the "
            "provider to v1 to accommodate it."
        )


def test_placeholder_endpoint_and_bounded_timeout(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """F-003-RQ-003 and F-003-RQ-001: placeholder endpoint, bounded KMS timeout.

    INVARIANT LOCKED, two of them, in the one block of the document that carries
    operator-supplied values:

    * The endpoint stays the documented PLACEHOLDER `unix:///tmp/kms.socket`
      (F-003-RQ-003). A real socket path committed here would name a deployment's
      internal layout in a public repository, and the placeholder is safe precisely
      because it points at nothing a shipped component creates. Real KMS
      provisioning is out-of-band, through the base64 `ENCRYPTION_PROVIDER_CONFIG`
      environment variable.
    * The timeout stays `3s` (F-003-RQ-001), the ONLY committed bound on the
      envelope call. Every Secret write and read passes through a gRPC call to the
      KMS plugin, so without a bound a sick plugin becomes a stalled API server.

    The timeout's TYPE is asserted separately from its value. PyYAML parses `3s` as
    a string; the API server parses it as a Go duration. A bare `3` would parse as
    an integer, and a test that coerced before comparing would accept a document
    the API server rejects - so the string-ness is part of the assertion, not an
    implementation detail of it.

    The KMS block is located by searching for it, not by taking `providers[0]`, so
    that a provider-ORDER regression fails only the test that owns ordering.
    """
    kms = _kms_provider_body(_load_manifest(repo_root))

    with subtests.test(field="apiVersion"):
        assert kms.get("apiVersion") == _EXPECTED_KMS_API_VERSION, (
            f"F-003-RQ-001: KMS apiVersion must be {_EXPECTED_KMS_API_VERSION!r}, got "
            f"{kms.get('apiVersion')!r}."
        )

    with subtests.test(field="name"):
        assert kms.get("name") == _EXPECTED_KMS_NAME, (
            f"F-003-RQ-001: KMS provider name must be {_EXPECTED_KMS_NAME!r}, got "
            f"{kms.get('name')!r}. The name is operator-facing and is referenced by the "
            "plugin deployment, so it is part of the committed contract."
        )

    with subtests.test(field="endpoint"):
        assert kms.get("endpoint") == _PLACEHOLDER_KMS_ENDPOINT, (
            "F-003-RQ-003: the KMS endpoint must remain the documented PLACEHOLDER "
            f"{_PLACEHOLDER_KMS_ENDPOINT!r}, got {kms.get('endpoint')!r}. A real socket "
            "path must never be committed; operators supply it out-of-band through the "
            "base64 ENCRYPTION_PROVIDER_CONFIG environment variable."
        )

    with subtests.test(field="timeout-is-string"):
        assert isinstance(kms.get("timeout"), str), (
            "F-003-RQ-001: the KMS timeout must be a duration STRING such as "
            f"{_EXPECTED_KMS_TIMEOUT!r}, got {type(kms.get('timeout')).__name__} "
            f"({kms.get('timeout')!r}). A bare number parses as an integer and the API "
            "server rejects it, so the quoting is load-bearing."
        )

    with subtests.test(field="timeout-value"):
        assert kms.get("timeout") == _EXPECTED_KMS_TIMEOUT, (
            f"F-003-RQ-001: the KMS timeout must be {_EXPECTED_KMS_TIMEOUT!r}, got "
            f"{kms.get('timeout')!r}. It is the only committed bound on the envelope "
            "gRPC call; raising or removing it converts a sick KMS plugin into a "
            "stalled API server."
        )


def test_no_real_key_material_committed(repo_root: Path, subtests: pytest.Subtests) -> None:
    """F-003-RQ-003: no committed value anywhere resembles key material.

    INVARIANT LOCKED: "no secrets, ever" is ENFORCED here rather than merely
    stated. This is the one test in the module that does not assert a known good
    value; it asserts the absence of a class of value, five independent ways, so
    that a key arriving by any of the plausible routes is caught:

    1. NO `secret` FIELD. That is the mapping key a static-key `aesgcm` provider
       carries its raw base64 key under, so its presence anywhere is the direct
       signature of committed key material. Matched as an EXACT KEY: the resource
       name `secrets` contains the substring, and a substring test would flag the
       correctly configured template.
    2. NO PROVIDER KIND BEYOND `kms` AND `identity`. Activating the commented-out
       `aesgcm` alternative is the most likely way key material would arrive in
       this file, so the permitted set is closed rather than open.
    3. NO UNEXPECTED FIELD ANYWHERE - the structural closure. The envelope, the
       resource entry and the KMS body each declare a known, exact key set, and
       every value inside those key sets is asserted exactly elsewhere in this
       module. With the document enumerated this way, a committed value can only
       exist somewhere an assertion already looks at it.
    4. NO BASE64 BLOB. Shape-checked against a narrow character class with a floor
       BELOW the 44 characters a 32-byte AES key encodes to, so a differently sized
       or truncated key is caught too, and not only the exact expected length.
    5. NO HIGH-ENTROPY STRING. The backstop for a key that evades the shape test -
       an unpadded or line-wrapped encoding, a token that is not base64 at all.
       Random material is dense in a way configuration is not.

    Checks 4 and 5 are HEURISTICS with measured limits, and the limits are the
    reason check 3 exists. Both catch a base64-encoded 32-byte key comfortably
    (44 characters; about 4.9 bits per character), and neither catches a short
    small-alphabet encoding such as 32 hexadecimal characters, which is under the
    shape floor and measures about 3.6 - indistinguishable from configuration text.
    Tightening either threshold to reach it would flag the template's own busiest
    legitimate value at 3.950. So the heuristics cover material in an unexpected
    PLACE, and the closure covers material of an unexpected SHAPE; neither is
    sufficient alone, and together they leave nowhere to hide.

    Plus the two V3 literals this tier owns, imported from
    `tests.fixtures.encryption_config` rather than retyped here, so that renaming
    or changing either propagates instead of leaving a stale copy behind: the
    aesgcm CIPHERTEXT PREFIX and the PLAINTEXT CANARY. Neither belongs in a
    deployment template - the prefix is a runtime artefact of an encrypted etcd
    value and names the key that produced it, and the canary is test data - so
    either appearing here would mean captured runtime state or test fixtures had
    leaked into a shipped artefact.

    STRUCTURAL, NOT TEXTUAL, for the same reason as the `cachesize` check: the raw
    template contains `aesgcm`, `secret:` and `<BASE64_32_BYTE_KEY>` inside the
    commented-out alternative provider block at L54-59, and a text scan would fail
    against the artefact exactly as shipped and correct.
    """
    document = _load_manifest(repo_root)
    leaves = list(_iter_string_leaves_with_path(document))

    # A guard against a VACUOUS scan, which is the one failure mode a negative test
    # cannot report on itself: with no leaves, every per-leaf subtest below passes
    # while examining nothing. Note precisely what it guards. No document with a
    # valid envelope can reach it - `_load_manifest` and `_encrypted_resource_entry`
    # have already asserted `apiVersion` and `kind`, which are two string leaves -
    # so this fires only if the WALKER regresses. That is exactly the case worth an
    # assertion: a broken walker turns this whole test green and silent.
    assert leaves, (
        "SETUP: the parsed document contains no string values, so the key-material "
        "scan below would pass without examining anything. Since a valid envelope "
        "always contributes `apiVersion` and `kind`, reaching this means "
        "_iter_string_leaves_with_path has regressed, not that the document is empty."
    )

    # 1. The aesgcm key field, by exact key name, anywhere in the tree.
    with subtests.test(check="no-secret-field"):
        secret_fields = _paths_of_mappings_declaring(document, _KEY_MATERIAL_FIELD_NAME)
        assert secret_fields == [], (
            f"F-003-RQ-003: a `{_KEY_MATERIAL_FIELD_NAME}` field is declared at "
            f"{secret_fields!r}. That is the field a static-key `aesgcm` provider "
            "carries raw base64 key material under. Key material is supplied "
            "out-of-band through the base64 ENCRYPTION_PROVIDER_CONFIG environment "
            "variable and is NEVER committed."
        )

    # 2. The provider kinds, as a closed set. A third kind is the likeliest route
    #    by which a key would arrive, so it is checked here and not with ordering.
    providers = _providers(_encrypted_resource_entry(document))
    for index, provider in enumerate(providers):
        keys = _provider_keys(provider)

        with subtests.test(check="provider-is-single-key-block", index=index):
            assert len(keys) == 1, (
                f"F-003-RQ-003: provider[{index}] must be a mapping with exactly one "
                f"block name, found {keys!r}. Two provider kinds fused into one entry "
                "hide which of them encrypts."
            )

        with subtests.test(check="provider-kind-permitted", index=index):
            assert set(keys) <= _PERMITTED_PROVIDER_KEYS, (
                f"F-003-RQ-003: provider[{index}] declares {keys!r}; only "
                f"{sorted(_PERMITTED_PROVIDER_KEYS)!r} are permitted in the committed "
                "template. The commented-out `aesgcm` alternative carries raw base64 "
                "key material, so activating a third provider kind here is how a key "
                "gets committed."
            )

    # 3. The structural closure. Reported per level so a failure names WHICH level
    #    grew a field, and lists the field, rather than merely saying the document
    #    changed shape.
    for level, mapping, permitted in (
        ("envelope", document, _EXPECTED_ENVELOPE_KEYS),
        ("resource-entry", _encrypted_resource_entry(document), _EXPECTED_RESOURCE_ENTRY_KEYS),
        ("kms-provider", _kms_provider_body(document), _EXPECTED_KMS_KEYS),
    ):
        with subtests.test(check="exact-key-set", level=level):
            unexpected = sorted(set(mapping) - permitted)
            missing = sorted(permitted - set(mapping))
            assert (unexpected, missing) == ([], []), (
                f"F-003-RQ-003: the {level} mapping declares unexpected key(s) "
                f"{unexpected!r} and is missing {missing!r}; permitted keys are "
                f"{sorted(permitted)!r}. Every permitted key has its value asserted "
                "exactly elsewhere in this module, so an unexpected one is the only "
                "place a committed value can sit unexamined - which is how key "
                "material short enough to evade the shape and entropy checks would "
                "arrive. Extend this key set deliberately, in a reviewed change, "
                "together with an assertion for the new value."
            )

    # 4. Shape. Every leaf, however short.
    for path, leaf in leaves:
        with subtests.test(check="base64-blob-shape", path=path):
            assert _BASE64_BLOB_PATTERN.fullmatch(leaf) is None, (
                f"F-003-RQ-003: the value at {path} looks like base64-encoded key "
                f"material ({len(leaf)} characters of the base64 alphabet). A 32-byte "
                "AES-GCM key encodes to 44 such characters. Nothing of this shape may "
                "be committed; supply key material out-of-band."
            )

    # 5. Entropy. Only leaves long enough for the measure to mean something; the
    #    shape test above already covers the short ones, so nothing is unexamined.
    for path, leaf in leaves:
        if len(leaf) < _ENTROPY_SCAN_MIN_LENGTH:
            continue
        with subtests.test(check="entropy", path=path):
            entropy = _shannon_entropy_bits_per_char(leaf)
            assert entropy < _MAX_PERMITTED_ENTROPY_BITS_PER_CHAR, (
                f"F-003-RQ-003: the value at {path} carries {entropy:.3f} bits of "
                "entropy per character, at or above the "
                f"{_MAX_PERMITTED_ENTROPY_BITS_PER_CHAR} ceiling, which is what random "
                "key material looks like and configuration does not. For reference the "
                "busiest legitimate value in this template measures 3.950 and a "
                "base64-encoded 32-byte key averages about 4.9. If this is genuinely "
                "not key material, widen the ceiling in a reviewed change - do not "
                "delete the check."
            )

    # And the two V3 literals this tier owns. Substring rather than equality, so a
    # prefix embedded in a longer value is caught too.
    for label, forbidden in (
        ("aesgcm-ciphertext-prefix", AESGCM_PREFIX),
        ("plaintext-canary", PLAINTEXT_CANARY),
    ):
        with subtests.test(check="v3-test-literal-absent", literal=label):
            occurrences = [path for path, leaf in leaves if forbidden in leaf]
            assert occurrences == [], (
                f"F-003-RQ-003: the V3 {label} appears at {occurrences!r}. The "
                "ciphertext prefix is a runtime artefact of an encrypted etcd value "
                "and names the key that produced it; the canary is test data. Either "
                "one in a committed deployment template means runtime state or test "
                "fixtures have leaked into a shipped artefact."
            )


def test_raw_artefact_carries_no_credential_shaped_material(
    repo_root: Path, subtests: pytest.Subtests
) -> None:
    """INVARIANT: no credential-SHAPED material anywhere in the raw file, comments included.

    INVARIANT LOCKED: F-003-RQ-003 over the bytes actually committed, closing the one
    blind spot every other check in this module shares. They all walk the PARSED
    document, and the YAML parser discards comments - so key material pasted into a
    comment is invisible to the leaf scan, the blob-shape scan, the entropy scan and
    the exact-key-set closure alike. It would be committed, reviewed, and pass.

    That is not a hypothetical location. The artefact ships a commented-out
    alternative static-key provider block at lines 54-59 showing exactly where a key
    would go, complete with a `secret:` field and a placeholder - which is precisely
    where a hurried operator pastes a real key to try it, and precisely what this
    test refuses.

    HOW IT AVOIDS FAILING AGAINST THE CORRECT ARTEFACT. It does not grep for
    `cachesize`, `aesgcm`, `secret:` or `<BASE64_32_BYTE_KEY>`; all four are
    legitimately present in that comment block, which is why the checks above are
    structural. This test asserts on credential SHAPE instead - an orthogonal
    property, because explanatory prose about a key does not look like a key. See
    ``_scan_raw_for_credential_material`` for the five rules, the measured
    calibration against this file (worst legitimate token 3.644 bits/char against a
    4.0 ceiling) and the evidence that each rule catches a credential form no other
    rule does.

    ACCUMULATE semantics: one subtest per rule plus a whole-file assertion, so a file
    carrying two different credential shapes reports both rather than only the first.
    """
    raw = _raw_manifest_text(repo_root)

    # A guard against a VACUOUS scan, the same failure mode the parsed scan guards:
    # an empty read would satisfy every rule below while examining nothing.
    assert raw.strip(), (
        f"SETUP: {'/'.join(_MANIFEST_RELATIVE_PATH)} read as empty, so the credential "
        f"scan below would pass without examining anything."
    )

    findings = _scan_raw_for_credential_material(raw)

    for rule in (
        "pem-block",
        "jwt",
        "hex-blob",
        "base64-blob-shape",
        "high-entropy-token",
        "aesgcm-ciphertext-prefix",
        "plaintext-canary",
    ):
        with subtests.test(check="raw-credential-scan", rule=rule):
            assert rule not in findings, (
                f"F-003-RQ-003: the committed template carries material matching the "
                f"{rule!r} rule: {findings[rule]!r}. Key material is supplied out-of-band "
                f"through the base64 ENCRYPTION_PROVIDER_CONFIG environment variable and is "
                f"NEVER committed - including inside a comment, which every other check in "
                f"this module is blind to. Remove it and rotate it: anything committed to "
                f"this repository must be treated as disclosed."
            )

    # The whole-file assertion, so a NEW rule added to the scanner cannot be silently
    # ignored by the fixed rule list above.
    assert findings == {}, (
        f"F-003-RQ-003: the raw credential scan reported findings under rule(s) "
        f"{sorted(findings)}, which the per-rule subtests above do not all enumerate. "
        f"Findings: {findings!r}. Add the new rule to the list above so it is reported "
        f"individually."
    )

