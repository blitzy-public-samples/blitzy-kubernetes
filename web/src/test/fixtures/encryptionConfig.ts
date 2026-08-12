/*
Copyright The Kubernetes Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Recorded EncryptionConfiguration document shapes and V3 (Secrets encryption at
// rest) constants for the React test tier.
//
// AAP §0.5.1 (the web/src/test/fixtures/encryptionConfig.ts row) / §0.5.2.5
// (React-tier fixture detail) / §0.5.5 (shared test data has exactly ONE
// definition site) / §0.10.2 (boundary conditions that must port unchanged) /
// tech-spec §6.4.5 (encryption at rest) / tech-spec §6.6.3.4 (every fixture
// states the invariant it locks).
//
// WHAT THIS FILE IS
//   The foundational fixture of web/src/test/fixtures: it imports nothing, and
//   it is the single definition site of AESGCM_PREFIX and PLAINTEXT_CANARY for
//   the whole React tier. web/src/test/msw/handlers.ts replays these shapes so
//   the component tier asserts against the real recorded contracts rather than
//   invented ones, and web/src/test/fixtures/controlStatus.ts imports the two
//   constants when its V3 evidence needs them. Because there is exactly one
//   definition site, an edit here propagates instead of diverging.
//
// WHAT THIS FILE IS NOT
//   It is not a source of truth and it is not a generator. Every value below is
//   transcribed from a measured line of one of the two artifacts named in the
//   section headers. Nothing is normalised, tidied, reordered or inferred: the
//   two artifacts are FROZEN (AAP §0.8.2 lists the deployment manifest as out of
//   scope for modification), so this file records them and never edits them.
//
// THE MOST IMPORTANT PROPERTY OF THIS FILE
//   It records TWO DISTINCT documents that must never be merged. The committed
//   GCE deployment manifest and the V3 integration test's inline configuration
//   are different artifacts that diverge in THREE independent ways — key order,
//   resources list, and provider list (enumerated per section below). Collapsing
//   them into one fixture would misrepresent the deployment while still
//   typechecking, so they are exported under deliberately dissimilar names and
//   given distinct types that are not assignable to one another.

// ---------------------------------------------------------------------------
// SECTION 1 — The V3 constants. Single definition site (AAP §0.5.5).
//
// Both are recorded from test/integration/secrets/encryption_test.go, which is
// the Go parity oracle for V3.
// ---------------------------------------------------------------------------

/**
 * Ciphertext prefix the API server's aesgcm transformer writes ahead of every
 * encrypted value, recorded from `test/integration/secrets/encryption_test.go`
 * L48 (`aesGCMPrefix`).
 *
 * INVARIANT LOCKED (F-003-RQ-002): a stored Secret is ciphertext, not plaintext.
 *
 * MATCHING SEMANTICS — this is a PREFIX match and nothing else. The Go oracle
 * asserts it with `bytes.HasPrefix` at L136, so any consumer of this constant
 * must test the START of the raw value:
 *   * NOT equality — the bytes after the prefix are the ciphertext body, so an
 *     equality test would break on every legitimate value;
 *   * NOT a substring search — that would also succeed when the prefix merely
 *     occurs somewhere inside an otherwise unencrypted blob, which is precisely
 *     the failure this assertion exists to catch.
 * The `v1:key1:` tail is part of the recorded value: `v1` is the transformer's
 * wire version and `key1` is the key name declared by the inline configuration
 * in SECTION 4, so the prefix also proves WHICH key encrypted the value.
 */
export { AESGCM_PREFIX } from '../../domain/securityConstants';

/**
 * Known plaintext marker written as the Secret's value and then asserted ABSENT
 * from the raw etcd blob. Recorded from
 * `test/integration/secrets/encryption_test.go` L66 (`plaintextCanary`).
 *
 * INVARIANT LOCKED (F-003-RQ-002): the negative half of the encryption proof.
 * The Go oracle asserts absence with `bytes.Contains` at L141. Without this
 * check a passing prefix test proves only that a prefix was WRITTEN — it does
 * not prove the body was actually encrypted. The two assertions are therefore a
 * pair, and a consumer that renders one verdict must render both.
 */
export { PLAINTEXT_CANARY } from '../../domain/securityConstants';

// RE-EXPORTED, NOT REDEFINED. Both constants above now have exactly one definition
// `web/src/domain/securityConstants.ts`, and this module re-exports them so that every
// existing importer of the fixture keeps working while the DEPENDENCY DIRECTION is
// corrected: production code reads the domain, and the fixture reads the domain too.
//
// Before this, `web/src/components/EncryptionAtRestPanel.tsx` imported both from
// HERE -- production code importing test code. Beyond having to ship a fixture
// module, that made
// a FIXTURE the source of truth for a security constant: the moment someone edited the
// recorded prefix to express a negative case, the panel's notion of a valid prefix
// moved
// with it, and the test meant to catch that agreed with the bug.
//
// The documentation above each constant is retained here because it records the
// PROVENANCE of the recorded value -- the Go file and line it was measured from --
// which
// is a fixture concern. The value itself is the domain's.

// ---------------------------------------------------------------------------
// SECTION 2 — Local structural types.
//
// Declared locally on purpose. There is no EncryptionConfiguration type in
// web/src/hooks and no shared-types module in this tier, so none is imported
// and none is invented (AAP §0.11.1, "evidence over assumption").
//
// The types are deliberately stronger than the data needs. Literal and TUPLE
// types are used so that `tsc --noEmit` PROVES the recorded orderings instead of
// merely permitting them: reordering the providers of the deployment shape below
// so that `identity` came first is a COMPILE ERROR (TS2353), not a silent
// weakening. That is how AAP §0.10.2's "never weaken a boundary condition" is
// enforced here — mechanically, by the gate, rather than by a comment nobody
// re-reads.
// ---------------------------------------------------------------------------

/** The one `apiVersion` both recorded documents declare. */
export type EncryptionConfigApiVersion = 'apiserver.config.k8s.io/v1';

/** The one `kind` both recorded documents declare. */
export type EncryptionConfigKind = 'EncryptionConfiguration';

/**
 * Requirement identifiers used by this fixture, taken from the repository's own
 * requirement vocabulary and from no other source. No external benchmark or
 * hardening-guide control identifier is asserted anywhere in this tier, because
 * AAP §0.10.1 records that the repository enumerates none — so naming one here
 * would be an invention dressed up as a citation.
 *
 *   F-003-RQ-001 — the encrypted `resources` list.
 *   F-003-RQ-002 — Secrets are ciphertext at rest.
 *   F-003-RQ-003 — provider ordering: strong provider first, `identity` last.
 */
export type EncryptionRequirementId =
  | 'F-003-RQ-001'
  | 'F-003-RQ-002'
  | 'F-003-RQ-003';

/**
 * A KMS **v2** provider block.
 *
 * `cachesize` is absent from this type BY ASSERTION, not by omission: the
 * deployment manifest records at L51–53 that it is a KMS v1-only tunable which
 * the API server rejects for v2 ("cachesize is not supported in v2"). Because
 * the type has no such member, adding one to the recorded value is a compile
 * error rather than a config that would be rejected at boot.
 */
export interface KmsV2Provider {
  readonly kms: {
    /** Pinned to the v2 envelope API; v2 is what makes `cachesize` invalid. */
    readonly apiVersion: 'v2';
    /** Operator-defined provider name. */
    readonly name: string;
    /** Placeholder unix socket; the real plugin socket is provisioned out of band. */
    readonly endpoint: string;
    /** Bounded gRPC call budget to the KMS plugin, expressed as a duration string. */
    readonly timeout: string;
  };
}

/**
 * A static-key aesgcm provider block. Used only by the integration-test shape in
 * SECTION 4, which needs no external KMS socket.
 */
export interface AesGcmProvider {
  readonly aesgcm: {
    readonly keys: readonly {
      readonly name: string;
      readonly secret: string;
    }[];
  };
}

/**
 * The plaintext passthrough provider, serialised as `identity: {}`.
 *
 * `Record<string, never>` models the empty mapping exactly: it accepts `{}` and
 * rejects any member, which matches the recorded document and prevents a
 * consumer from quietly parameterising a provider that has no parameters.
 */
export interface IdentityProvider {
  readonly identity: Record<string, never>;
}

// ---------------------------------------------------------------------------
// SECTION 3 — Shape A: the committed GCE DEPLOYMENT manifest.
//
// Recorded from `cluster/gce/manifests/encryption-provider-config.yml`, document
// body L35–64. That file is frozen (AAP §0.8.2): this section transcribes it and
// must never restructure, reorder or "normalise" it.
//
// DIVERGENCE FROM SHAPE B (SECTION 4) — all three differences are deliberate:
//   1. key order    — `apiVersion` FIRST here (L35), `kind` first in Shape B;
//   2. resources    — ['secrets', 'configmaps'] here, ['secrets'] in Shape B;
//   3. providers    — [kms, identity] here, [aesgcm] in Shape B.
// ---------------------------------------------------------------------------

/**
 * The committed deployment document's shape.
 *
 * The provider list is a fixed two-element TUPLE, ordered strong-provider-first
 * and `identity`-last. That is the whole point of the type: the ordering is a
 * security boundary, so it is expressed where the compiler can enforce it.
 */
export interface DeploymentEncryptionConfiguration {
  readonly apiVersion: EncryptionConfigApiVersion;
  readonly kind: EncryptionConfigKind;
  readonly resources: readonly [
    {
      /** Ordered exactly as recorded: `secrets` first, then `configmaps`. */
      readonly resources: readonly ['secrets', 'configmaps'];
      /** Strong provider FIRST, plaintext passthrough LAST. Enforced positionally. */
      readonly providers: readonly [KmsV2Provider, IdentityProvider];
    },
  ];
}

/**
 * EncryptionConfiguration as shipped for the GCE reference deployment, recorded
 * from `cluster/gce/manifests/encryption-provider-config.yml` L35–64.
 *
 * INVARIANTS LOCKED
 *
 *   F-003-RQ-001 — `resources` is exactly ['secrets', 'configmaps'] (L41, L42),
 *   in that order. `secrets` also covers legacy ServiceAccount-token Secrets
 *   (type kubernetes.io/service-account-token), which is why it leads the list.
 *
 *   F-003-RQ-003 — provider ORDER. The manifest states the mechanism at L19–22:
 *   the FIRST provider encrypts all new writes, and ALL listed providers are
 *   tried in order when decrypting. Two consequences follow, and both are the
 *   reason this list is a tuple rather than an array:
 *     * the strong provider MUST be first. If `identity` were first, every new
 *       write would be stored in plaintext and NOTHING would be encrypted — the
 *       document would still be valid, the API server would still boot, and the
 *       control would be silently dead.
 *     * `identity` MUST be last, and is present only as a decrypt-only fallback
 *       so Secrets written before encryption was enabled remain readable during
 *       the storage migration. The manifest records at L60–63 that it is removed
 *       once that migration completes, after which plaintext is no longer
 *       accepted.
 *
 *   No `cachesize` key — asserted, not merely absent. See `KmsV2Provider`.
 *
 * CONTAINS NO KEY MATERIAL, deliberately. The manifest's aesgcm alternative is
 * commented out at L54–59 with the placeholder `<BASE64_32_BYTE_KEY>`, so the
 * committed document declares `kms` plus `identity` and nothing else. The
 * endpoint below is the manifest's own placeholder socket path; a real KMS plugin
 * socket and any real key are supplied out of band and are never committed.
 *
 * The document TEXT is intentionally not duplicated here — only its shape. The
 * frozen file on disk stays the single source of the bytes, so this fixture
 * cannot drift from it in whitespace or comments.
 */
export const DEPLOYMENT_ENCRYPTION_CONFIG = {
  apiVersion: 'apiserver.config.k8s.io/v1',
  kind: 'EncryptionConfiguration',
  resources: [
    {
      resources: ['secrets', 'configmaps'],
      providers: [
        // 1) STRONG PROVIDER FIRST — encrypts every new write (L46–50).
        {
          kms: {
            apiVersion: 'v2',
            name: 'k8s-kms',
            endpoint: 'unix:///tmp/kms.socket',
            timeout: '3s',
          },
        },
        // 2) identity LAST — decrypt-only plaintext fallback (L64).
        { identity: {} },
      ],
    },
  ],
} as const satisfies DeploymentEncryptionConfiguration;

// ---------------------------------------------------------------------------
// SECTION 4 — Shape B: the V3 INTEGRATION TEST's inline configuration.
//
// Recorded from `test/integration/secrets/encryption_test.go` L53–64
// (`encryptionConfigYAML`). The Go oracle writes this document to a temp file and
// passes it to the test API server via --encryption-provider-config, which is why
// it selects the static-key aesgcm provider: aesgcm needs no external KMS plugin,
// so the test runs with nothing to provision and no unix socket to connect to.
//
// This is a SEPARATE artifact from Shape A and is exported under a separate name
// and a separate, non-interchangeable type. See the three-way divergence noted in
// SECTION 3.
// ---------------------------------------------------------------------------

/**
 * The integration test's inline document shape.
 *
 * `kind` is declared before `apiVersion`, which is the REVERSE of Shape A. The
 * order is preserved rather than tidied because property declaration order is
 * observable: `Object.keys` and `JSON.stringify` both emit these keys in
 * declaration order, so a consumer that serialises this fixture reproduces the
 * recorded document rather than a re-ordered lookalike.
 *
 * The provider list is a ONE-element tuple. There is no `identity` provider in
 * this document, so the type makes adding one a compile error: an `identity`
 * fallback would let the round-trip assertion pass even if the value had been
 * stored in plaintext, which would defeat the test.
 */
export interface IntegrationEncryptionConfiguration {
  readonly kind: EncryptionConfigKind;
  readonly apiVersion: EncryptionConfigApiVersion;
  readonly resources: readonly [
    {
      /** `secrets` only — `configmaps` is deliberately absent from this document. */
      readonly resources: readonly ['secrets'];
      /** A single static-key provider; no plaintext fallback exists here. */
      readonly providers: readonly [AesGcmProvider];
    },
  ];
}

/**
 * EncryptionConfiguration applied by the V3 integration test, recorded from
 * `test/integration/secrets/encryption_test.go` L53–64.
 *
 * INVARIANT LOCKED (F-003-RQ-002): this is the configuration under which Secrets
 * must come back as ciphertext. The key name `key1` declared here is what makes
 * AESGCM_PREFIX's `...:key1:` tail meaningful — the prefix names the key that
 * performed the encryption, so the two values are a matched pair.
 *
 * ABOUT THE KEY MATERIAL BELOW — it is NOT a credential. The Go source records at
 * L51–52 that it is the same non-secret test fixture already used by
 * `test/integration/controlplane/transformation/secrets_transformation_test.go`.
 * It is a published, deliberately weak test vector that decodes to a short
 * human-readable phrase, it protects nothing, and it is the only key material
 * permitted anywhere in this tier (AAP §0.11.1, "no secrets, ever"). No real key,
 * certificate, token or bearer credential appears in this file.
 */
export const INTEGRATION_AESGCM_ENCRYPTION_CONFIG = {
  kind: 'EncryptionConfiguration',
  apiVersion: 'apiserver.config.k8s.io/v1',
  resources: [
    {
      resources: ['secrets'],
      providers: [
        {
          aesgcm: {
            keys: [{ name: 'key1', secret: 'c2VjcmV0IGlzIHNlY3VyZQ==' }],
          },
        },
      ],
    },
  ],
} as const satisfies IntegrationEncryptionConfiguration;

/**
 * The same document as `INTEGRATION_AESGCM_ENCRYPTION_CONFIG`, recorded verbatim
 * as text from `test/integration/secrets/encryption_test.go` L53–64.
 *
 * WHY BOTH FORMS EXIST — AAP §0.3.2 requires the React tier's MSW handlers to
 * replay the EncryptionConfiguration **YAML**, not a re-serialised approximation
 * of it. Keeping the recorded text beside the recorded structure means a handler
 * never has to hand-roll YAML, which is the only way the two could diverge.
 *
 * The leading and trailing newlines are part of the recorded value: the Go
 * constant is a raw string literal whose backtick is followed immediately by a
 * line break, and those exact bytes are what the oracle writes to disk at L88.
 */
export const INTEGRATION_AESGCM_ENCRYPTION_CONFIG_YAML = `
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
`;

// ---------------------------------------------------------------------------
// SECTION 5 — Supporting recorded values.
//
// All recorded from `test/integration/secrets/encryption_test.go`. These exist so
// the React tier can render V3 evidence that matches what the oracle actually
// exercises, instead of inventing plausible-looking object names.
// ---------------------------------------------------------------------------

/** The Secret the V3 oracle creates, and the data key it stores the canary under. */
export interface EncryptedSecretTarget {
  readonly namespace: string;
  readonly name: string;
  readonly dataKey: string;
}

/**
 * The objects the V3 oracle actually exercises, recorded from
 * `test/integration/secrets/encryption_test.go` L102 (namespace), L107 (Secret
 * name) and L108 (data key).
 *
 * The Secret's value is PLAINTEXT_CANARY, which is what ties this fixture to the
 * two constants in SECTION 1.
 */
export const ENCRYPTED_SECRET_TARGET = {
  namespace: 'secret-encryption',
  name: 'encrypted-secret',
  dataKey: 'api_key',
} as const satisfies EncryptedSecretTarget;

/**
 * Builds the raw etcd key for a Secret exactly as the API server's storage layer
 * does: `/<storagePrefix>/secrets/<namespace>/<name>`. Recorded from
 * `test/integration/secrets/encryption_test.go` L73–75 (`etcdKeyForSecret`).
 *
 * WHY `storagePrefix` IS A PARAMETER AND NEVER A LITERAL — this is the trap the
 * Go source documents at L69–71. The live prefix embeds a per-run UUID and looks
 * like `<uuid>/registry`, so it MUST be read from the running configuration. A
 * hardcoded `registry` addresses a key that does not exist; the raw read then
 * returns zero entries and the "exactly one key/value pair" assertion fails for
 * entirely the wrong reason: it reports a missing object while encryption itself
 * is working perfectly. That is the worst kind of failure — it looks like a
 * security regression and is not one. Taking the prefix as an argument is what
 * makes it impossible, which is why this is a builder and not a constant.
 *
 * @param storagePrefix Prefix read from the live storage configuration, without
 *   surrounding slashes, e.g. `"<uuid>/registry"`.
 * @param namespace Namespace of the Secret.
 * @param name Name of the Secret.
 * @returns The absolute etcd key, always beginning with a single `/`.
 * @throws RangeError if any argument is empty or blank, or if `storagePrefix`
 *   carries a leading or trailing `/`.
 *
 * The Go original performs no validation, because a malformed prefix there is
 * caught immediately by the surrounding assertions. Nothing here surrounds this
 * helper, so the guards below make the same class of mistake fail loudly and
 * legibly rather than silently producing a key with an empty or doubled segment.
 * The function stays pure and deterministic: same inputs, same output, no clock,
 * no randomness, no IO.
 */
export function etcdKeyForSecret(
  storagePrefix: string,
  namespace: string,
  name: string,
): string {
  const segments: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'storagePrefix', value: storagePrefix },
    { label: 'namespace', value: namespace },
    { label: 'name', value: name },
  ];

  for (const segment of segments) {
    if (segment.value.trim() === '') {
      throw new RangeError(
        `etcdKeyForSecret: ${segment.label} must be a non-empty value; ` +
          'an empty segment yields a key that matches nothing in etcd',
      );
    }
  }

  if (storagePrefix.startsWith('/') || storagePrefix.endsWith('/')) {
    throw new RangeError(
      `etcdKeyForSecret: storagePrefix ${JSON.stringify(storagePrefix)} must not ` +
        'have a leading or trailing "/"; the separators are added here and a ' +
        'duplicated one produces a key no stored object uses',
    );
  }

  return `/${storagePrefix}/secrets/${namespace}/${name}`;
}

/**
 * How a failed assertion behaves in the Go oracle, preserved so the React tier
 * can distinguish the two rather than treating every failure alike.
 *
 *   'abort'      — `t.Fatalf`: the run stops immediately. Reserved for a broken
 *                  precondition, where every later assertion would be reading
 *                  meaningless data and reporting it would only add noise.
 *   'accumulate' — `t.Errorf`: the failure is recorded and the test continues, so
 *                  ONE run reports EVERY finding.
 *
 * AAP §0.10.2 requires this asymmetry to port unchanged. Collapsing both into a
 * single construct is the specific regression to avoid: it would hide every
 * finding after the first.
 */
export type EncryptionAssertionSeverity = 'abort' | 'accumulate';

/** One recorded assertion of the V3 oracle, with its severity and provenance. */
export interface EncryptionAtRestAssertion {
  /** Stable identifier for consumers to key off; not a Go symbol. */
  readonly id: string;
  /** Requirement this assertion enforces. */
  readonly requirement: EncryptionRequirementId;
  /** Line of `test/integration/secrets/encryption_test.go` this is recorded from. */
  readonly goLine: number;
  /** The Go call used, which is what determines `severity`. */
  readonly goCall: 't.Fatalf' | 't.Errorf';
  /** Behaviour on failure — see EncryptionAssertionSeverity. */
  readonly severity: EncryptionAssertionSeverity;
  /** The invariant, stated as the outcome that must hold. */
  readonly description: string;
}

/**
 * The four assertions of `TestSecretsAreEncryptedAtRest`, in source order, with
 * the Go severity of each preserved.
 *
 * Recorded from `test/integration/secrets/encryption_test.go` L131, L136, L141
 * and L150. All four enforce F-003-RQ-002, matching the mapping AAP §0.5.1 gives
 * the V3 row.
 *
 * ASSERTION DENSITY IS PART OF THE CONTRACT (AAP §0.7.2): there are exactly four,
 * and a port that renders fewer has weakened the control even if it still passes.
 * Note the shape of the set — one positive proof (ciphertext prefix present), one
 * negative proof (plaintext absent), one cardinality proof (exactly one stored
 * object), and one round-trip proof (the API server still returns the plaintext).
 * Drop any one and the remaining three can all pass while encryption is broken or
 * while the read simply targeted the wrong key.
 */
export const ENCRYPTION_AT_REST_ASSERTIONS = [
  {
    id: 'single-etcd-entry',
    requirement: 'F-003-RQ-002',
    goLine: 131,
    goCall: 't.Fatalf',
    severity: 'abort',
    description:
      'the raw prefix scan returns exactly one key/value pair for the Secret; ' +
      'any other count means the key was derived wrongly and every later ' +
      'assertion would be reading the wrong object',
  },
  {
    id: 'aesgcm-prefix-present',
    requirement: 'F-003-RQ-002',
    goLine: 136,
    goCall: 't.Errorf',
    severity: 'accumulate',
    description:
      'the stored value BEGINS WITH AESGCM_PREFIX, proving it is ciphertext ' +
      'produced by the declared key rather than a plaintext write',
  },
  {
    id: 'plaintext-canary-absent',
    requirement: 'F-003-RQ-002',
    goLine: 141,
    goCall: 't.Errorf',
    severity: 'accumulate',
    description:
      'PLAINTEXT_CANARY does NOT appear anywhere in the raw blob; this is the ' +
      'negative half of the proof, without which a written prefix alone would ' +
      'be mistaken for encryption',
  },
  {
    id: 'plaintext-round-trip',
    requirement: 'F-003-RQ-002',
    goLine: 150,
    goCall: 't.Errorf',
    severity: 'accumulate',
    description:
      'reading the Secret back through the API server returns the original ' +
      'plaintext, proving encryption at rest is transparent to clients and that ' +
      'the published contract is unchanged',
  },
] as const satisfies readonly EncryptionAtRestAssertion[];
