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

"""V3 test data: the EncryptionConfiguration document and the two V3 constants.

This module single-sources the test DATA of V3, Secrets encryption at rest. Every
value below is transcribed from a measured line of
``test/integration/secrets/encryption_test.go``, the Go test this tier ports, and
nothing is normalised, reordered, tidied or inferred.

PROVENANCE: AAP §0.5.1 (this file's row) / §0.4.4.2 (test data modules) / §0.5.5
(shared test data has exactly one definition site) / §0.10.2 (boundary conditions
that must port unchanged), and tech-spec §6.4.5 (encryption at rest). The ported
lines are ``encryption_test.go`` L46-67, whose own citation style this docstring
follows. The citations are repeated in the comment block below this docstring so
they survive in both places a reader may look: ``help()`` at runtime, and the
source.

WHAT THIS MODULE IS

The single definition site, for the whole Python tier, of three things::

    from tests.fixtures.encryption_config import (
        AESGCM_PREFIX,           # the ciphertext prefix a stored Secret must START with
        PLAINTEXT_CANARY,        # the marker that must be ABSENT from the raw etcd blob
        ENCRYPTION_CONFIG_YAML,  # the document the API server is started with
    )

Two modules consume it, which is precisely why it exists as a module rather than
as literals inside one of them:

* ``tests/integration/test_secrets_encryption.py`` (the L2 integration tier)
  writes ``ENCRYPTION_CONFIG_YAML`` to a temp file and wires it through
  ``--encryption-provider-config``, exactly as the Go oracle does at L87-90, then
  asserts that the raw etcd value begins with ``AESGCM_PREFIX`` and does not
  contain ``PLAINTEXT_CANARY``.
* ``tests/unit/config/test_encryption_provider_config.py`` (the L3 config tier)
  imports the same two constants.

One definition site means an edit propagates instead of diverging. Two copies of
a security constant can drift apart while both tests keep passing, which is the
failure mode this package was created to remove: Go cannot import a ``_test.go``
file across a package boundary and pays for it by copying, and
``encryption_test.go`` says so in a comment on its own key-derivation helper at
L69-72. Python has no such rule, so the copy is unnecessary here.

WHAT THIS MODULE IS NOT

* Not test logic. It asserts nothing and decides nothing. The assertions live in
  the two consumer modules named above; the invariants each constant locks are
  recorded here as comments so that a consumer cannot weaken one by accident.
* Not a pytest fixture, despite the package name. It declares no
  ``@pytest.fixture``: every fixture of this tier lives in a ``conftest.py``.
* Not a test module. Its name does not match ``test_*.py``, so it is imported,
  never collected.
* Not a generator and not a parser. It imports nothing at all, performs no I/O at
  import time, reads no environment variable and touches no ``sys.path``, so
  importing it cannot fail and cannot be the reason a test fails.
* Not two representations of one document. The document is published as TEXT
  only; no parsed-dict twin accompanies it, because two representations of one
  artifact can silently diverge. A consumer that needs the structure parses the
  text itself with the tier's pinned YAML distribution.

NOT THE COMMITTED DEPLOYMENT TEMPLATE

``cluster/gce/manifests/encryption-provider-config.yml`` is a DIFFERENT artifact
and the two must never be merged. That file is the GCE reference template an
operator base64-encodes into an environment variable; the document below is what
a test API server is started with. They differ in every structural respect:

* it declares ``apiVersion`` BEFORE ``kind``; the document below declares
  ``kind`` first;
* it covers a second resource type in addition to ``secrets``; the document
  below covers ``secrets`` alone;
* its strong provider is an envelope provider (KMS v2) with a placeholder
  operator-defined name, a placeholder unix-socket endpoint and a bounded call
  timeout; the document below uses the static-key ``aesgcm`` provider, which
  needs no external plugin socket and is therefore what an integration test can
  actually run;
* it keeps a decrypt-only plaintext fallback provider LAST, present only until a
  storage migration completes; the document below has exactly one provider.

That file is read from disk and asserted against by
``tests/unit/config/test_encryption_provider_config.py``. It is frozen: this
module neither edits it, nor copies it, nor shadows it.

WHAT THIS MODULE DELIBERATELY LEAVES TO OTHERS

* The raw etcd key of a Secret. ``tests/helpers/etcd_raw.py`` owns
  ``etcd_key_for_secret``, and with it the rule that the storage prefix comes
  from the LIVE storage configuration - a per-run UUID followed by ``/registry``
  - and is never hardcoded. Publishing a key template here would invite exactly
  the hardcoding that rule forbids.
* The identifiers of the objects under test. The namespace, the Secret name and
  the Secret's data key belong to the V3 test module that creates them; they are
  its test inputs, not shared data, and are deliberately absent here.
"""

# AAP §0.5.1 (the python/tests/fixtures/encryption_config.py row: "The inline
# EncryptionConfiguration plus AESGCM_PREFIX and PLAINTEXT_CANARY constants") /
# §0.4.4.2 (test data modules) / §0.5.5 (shared test data has exactly ONE
# definition site) / §0.10.2 (boundary conditions that must port unchanged) /
# tech-spec §6.4.5 (encryption at rest).
#
# INVARIANT LOCKED BY THIS FILE: the three values that make the V3 proof mean
# something are recorded here EXACTLY as the Go oracle records them, once each.
# The prefix is matched as a prefix, the canary is asserted absent, and the
# document is the bytes the API server is actually started with. Weakening any
# one of them leaves a green test that no longer proves Secrets are encrypted at
# rest, which is why each carries the invariant it locks rather than only a
# value.
#
# THE ONE PIECE OF KEY MATERIAL HERE IS NOT A CREDENTIAL. The aesgcm key in the
# document below is the same non-secret test fixture used by
# test/integration/controlplane/transformation/secrets_transformation_test.go -
# NOT a real credential. That statement is the Go source's own, recorded at
# encryption_test.go L51-52, and it is carried across verbatim because it is the
# reason this value is permitted to exist in the repository at all. It is the
# ONLY key material this module contains: no second key, no certificate, no
# token and no other high-entropy literal appears anywhere below (AAP §0.11.1,
# "no secrets, ever").

# ---------------------------------------------------------------------------
# The two V3 boundary constants.
#
# Both names are a contract, not a preference: tests/helpers/etcd_raw.py owns no
# cryptographic constant and states that AESGCM_PREFIX and PLAINTEXT_CANARY
# belong to this module, and tests/fixtures/__init__.py documents the import by
# name. Renaming either breaks a consumer that cannot see this file.
# ---------------------------------------------------------------------------

# Ported from test/integration/secrets/encryption_test.go L48 (`aesGCMPrefix`).
#
# INVARIANT LOCKED (V3): the stored value of a Secret must BEGIN WITH this
# prefix, which proves the write went through the aesgcm transformer rather than
# the plaintext pass-through path.
#
# MATCHING SEMANTICS - a PREFIX match, and nothing else. The Go oracle asserts it
# with bytes.HasPrefix at L136, and AAP §0.10.2 records why both obvious
# alternatives are wrong:
#   * NOT equality. The bytes after the prefix are the ciphertext body, so an
#     equality test would break on any legitimate change to that body.
#   * NOT a substring search. That also succeeds when the prefix merely occurs
#     somewhere inside an otherwise unencrypted blob, which is the exact failure
#     this assertion exists to catch.
#
# The `v1:key1:` tail is part of the recorded value and is not decoration: `v1`
# is the transformer's wire version and `key1` is the key name the document below
# declares, so the prefix also proves WHICH key encrypted the value.
AESGCM_PREFIX: str = "k8s:enc:aesgcm:v1:key1:"

# Ported from test/integration/secrets/encryption_test.go L66
# (`plaintextCanary`).
#
# INVARIANT LOCKED (V3): this string is written as the Secret's value and must
# then be ABSENT from the raw etcd blob. It is the negative half of the
# encryption proof - without it, a passing prefix assertion proves only that A
# PREFIX WAS WRITTEN, not that the body was encrypted. The Go oracle asserts
# absence with bytes.Contains at L141, so the two assertions are a pair: a
# consumer that reports one verdict must report both.
#
# The value is deliberately a fixed, recognisable marker rather than random
# bytes: a failure has to name what leaked, and a reader of a CI log has to be
# able to grep an etcd blob for it by hand.
PLAINTEXT_CANARY: str = "BLITZY_PLAINTEXT_CANARY"

# ---------------------------------------------------------------------------
# The inline EncryptionConfiguration document.
# ---------------------------------------------------------------------------

# Ported BYTE-FOR-BYTE from test/integration/secrets/encryption_test.go L53-64
# (`encryptionConfigYAML`), which is a Go raw string literal.
#
# INVARIANT LOCKED (V3): the API server under test is started with
# --encryption-provider-config pointing at exactly these bytes, so the behaviour
# the L2 test proves is the behaviour of THIS document. Five properties are
# load-bearing and none of them may be tidied:
#   * The LEADING newline. The Go literal's opening backtick is followed
#     immediately by a line break, and these exact bytes - leading newline
#     included - are what the oracle writes to disk at L88.
#   * `kind:` BEFORE `apiVersion:`. This document declares them in that order;
#     the committed deployment template declares them the other way round, and
#     that ordering difference is one of the ways the two are told apart.
#   * Exactly ONE entry under the inner `resources:` list, `secrets`.
#   * Exactly ONE provider, the static-key `aesgcm` provider, and it is FIRST.
#     The first provider in the list encrypts every new write, so a strong
#     provider anywhere but first would mean new writes are not encrypted.
#   * The two-space and four-space indentation of the original, and the trailing
#     newline.
#
# A plain triple-quoted literal, deliberately: textwrap.dedent would strip the
# indentation and so change the document, and an implicitly concatenated
# sequence of quoted lines would put the newlines under an author's control
# rather than the source's.
ENCRYPTION_CONFIG_YAML: str = """
kind: EncryptionConfiguration
apiVersion: apiserver.config.k8s.io/v1
resources:
  - resources:
    - secrets
    providers:
    - aesgcm:
        keys:
        - name: key1
          secret: c2VjcmV0IGlzIHNlY3VyZQ==
"""

# ---------------------------------------------------------------------------
# The literals the document above is built from.
#
# Each is a verbatim literal already present in
# test/integration/secrets/encryption_test.go and is published only so that a
# consumer asserting the document's shape does not retype it. Nothing here is
# invented, and nothing here describes the committed deployment template.
# ---------------------------------------------------------------------------

# From encryption_test.go L54, the document's `kind:` value.
ENCRYPTION_CONFIG_KIND: str = "EncryptionConfiguration"

# From encryption_test.go L55, the document's `apiVersion:` value. It versions the
# configuration document itself, and is not the version of any provider inside it.
ENCRYPTION_CONFIG_API_VERSION: str = "apiserver.config.k8s.io/v1"

# From encryption_test.go L62, the aesgcm key's `name:`. It appears twice in the
# Go source - here and inside `aesGCMPrefix` at L48 - so publishing it lets a
# consumer assert that correspondence instead of hardcoding "key1" a second
# time. The prefix names the key that encrypted a value, so the two must agree.
AESGCM_KEY_NAME: str = "key1"

# From encryption_test.go L63, the aesgcm key's `secret:`. See the note above:
# this is the documented NON-SECRET test fixture shared with
# test/integration/controlplane/transformation/secrets_transformation_test.go,
# and it is published so that a consumer checking the document carries the
# permitted value rather than transcribing key material of its own.
AESGCM_KEY_SECRET_BASE64: str = "c2VjcmV0IGlzIHNlY3VyZQ=="
