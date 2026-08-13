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

// Specs for the shared sanitizer every externally supplied string passes through
// before it becomes DOM text.
//
// AAP §0.11.1 ("no secrets, ever"; "never weaken a boundary condition") /
// §0.7.1.3 (100 % line and branch on decision logic that encodes a security
// invariant) / §0.5.1 (the `web/src/**` rows) · tech-spec §6.6.3.3.
//
// THIS MODULE'S EDGE CASES ARE NOT REACHABLE FROM THE RECORDED FIXTURES, which is
// why it has specs of its own rather than being covered only through the panels.
// A recorded payload never contains PEM armour, a bidirectional override, an
// eight-kilobyte message or a relative credential path -- and those are exactly
// the inputs the guard exists for. Testing it only through a panel would leave
// every one of them unexercised while the coverage figure looked healthy.
//
// THE TWO-SIDED CONTRACT. Half of these specs prove that dangerous text is
// withheld; the other half prove that ORDINARY RECORDED VALUES SURVIVE UNCHANGED.
// Both directions are load-bearing: a sanitizer that redacted `Request` would
// destroy the single most consequential measured value in the V6 control, and
// AAP §0.11.1 treats discarding reported evidence as the same class of mistake as
// leaking it.
//
// NO CREDENTIAL MATERIAL APPEARS HERE. The token-shaped and key-shaped strings
// below are built from repeated filler characters, so they carry the SHAPE the
// guard recognises and no secret at all.

import { describe, expect, it } from 'vitest';

import type { ControlStatus } from '../hooks/useControlStatus';
import {
  CONTROL_STATUS_FIXTURES,
  V2_RESTRICTED_WARNINGS,
  V8_ETCD_TRANSPORT_WARNING,
  V2_POD_SECURITY_WARNING,
} from '../test/fixtures/controlStatus';
import {
  AESGCM_PREFIX,
  AUDIT_LEVEL_ORDER,
  ETCD_TLS_ENDPOINT,
  PLAINTEXT_CANARY,
} from './securityConstants';
import {
  KUBERNETES_STATUS_REASONS,
  MAX_SAFE_LABEL_LENGTH,
  MAX_SAFE_PATH_LENGTH,
  MAX_SAFE_PROSE_INPUT_LENGTH,
  MAX_SAFE_PROSE_LENGTH,
  MAX_SAFE_VALUE_LENGTH,
  SAFE_EMPTY_STRING_LABEL,
  SAFE_OVERSIZED_TEXT,
  SAFE_PROSE_ELISION,
  SAFE_REDACTED,
  SAFE_UNRECOGNISED_REASON,
  containsCredentialShape,
  describeStatusReason,
  isSafeAbsolutePath,
  safeLabel,
  safeObservationValue,
  safePathBasename,
  safeProse,
  safeSensitiveValue,
} from './safeText';

/** A compact-JWT SHAPE built from filler: three long dot-separated segments. */
const TOKEN_SHAPED = ['a'.repeat(12), 'b'.repeat(16), 'c'.repeat(20)].join('.');

/**
 * A padded-base64 SHAPE built from filler, the length a 32-byte key encodes to.
 *
 * The filler MIXES DIGITS WITH LETTERS on purpose, because that is what encoded binary
 * looks like and it is what tells a key apart from an identifier. A letters-only run of
 * the same length is `allowPrivilegeEscalation`-shaped, and redacting those destroyed
 * the middle of a real recorded Pod Security warning -- see the case below that pins
 * that exact string.
 */
const KEY_SHAPED = `${'Ab1cD2'.repeat(7)}A=`;

/** PEM armour with a filler body. */
const PEM_SHAPED = `-----BEGIN CERTIFICATE-----\n${'Z'.repeat(60)}\n-----END CERTIFICATE-----`;

/** A credential path exactly as `configure-helper.sh` renders it. */
const REAL_CREDENTIAL_PATH = '/etc/srv/kubernetes/pki/etcd-apiserver-client.key';

/**
 * The one piece of real key material AAP §0.11.1 permits anywhere in this repository:
 * the documented NON-SECRET AES-GCM test key, shared with
 * `test/integration/controlplane/transformation/secrets_transformation_test.go`.
 */
const RECORDED_TEST_KEY = 'c2VjcmV0IGlzIHNlY3VyZQ==';

describe('safeProse — externally supplied prose', () => {
  it('returns ordinary prose unchanged', () => {
    // The decisive property in the permissive direction. A server's own
    // explanation of a failure is the most useful thing on the error line, so a
    // guard that mangled it would push every panel back to inventing wording.
    const recorded =
      'Both offending pods were rejected with 403 Forbidden by the PodSecurity ' +
      'admission plugin, and nothing was persisted.';

    expect(safeProse(recorded)).toBe(recorded);
  });

  it.each([
    ['a newline', 'first\nsecond', 'first second'],
    ['a tab', 'first\tsecond', 'first second'],
    ['a NUL', 'first\u0000second', 'first second'],
    ['a zero-width space', 'first\u200Bsecond', 'first second'],
    ['a right-to-left override', 'first\u202Esecond', 'first second'],
    ['a line separator', 'first\u2028second', 'first second'],
  ])('collapses %s to a single space', (_label, raw, expected) => {
    // Collapsed rather than deleted: deleting would fuse two words into one, and
    // a bidirectional override would otherwise let a payload reorder what a
    // reader sees without changing what the string contains.
    expect(safeProse(raw)).toBe(expected);
  });

  it('trims and collapses runs of whitespace so layout cannot be driven from a payload', () => {
    expect(safeProse('   spaced     out   ')).toBe('spaced out');
  });

  it.each([
    ['a token shape', `authorization: Bearer ${TOKEN_SHAPED}`],
    ['a token shape in punctuation', `("${TOKEN_SHAPED}")`],
    ['PEM armour', `attached: ${PEM_SHAPED}`],
    ['a padded base64 blob', `key material ${KEY_SHAPED} was rejected`],
  ])('redacts %s', (_label, raw) => {
    const sanitized = safeProse(raw);

    expect(sanitized).toContain(SAFE_REDACTED);
    expect(sanitized).not.toContain(TOKEN_SHAPED);
    expect(sanitized).not.toContain(KEY_SHAPED);
    expect(sanitized).not.toContain('-----BEGIN');
  });

  it('redacts unterminated PEM armour to the end of the text', () => {
    // A truncated block is the case a marker-pair pattern misses, and a rendered
    // half-certificate is still a rendered certificate.
    const sanitized = safeProse(`-----BEGIN PRIVATE KEY-----${'Q'.repeat(40)}`);

    expect(sanitized).toBe(SAFE_REDACTED);
  });

  it('withholds text too large to be a message rather than excerpting it', () => {
    expect(safeProse('x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1))).toBe(SAFE_OVERSIZED_TEXT);
  });

  it('bounds long prose to exactly the limit and marks the elision', () => {
    const sanitized = safeProse('y'.repeat(MAX_SAFE_PROSE_LENGTH + 500));

    expect(sanitized).toHaveLength(MAX_SAFE_PROSE_LENGTH);
    expect(sanitized.endsWith(SAFE_PROSE_ELISION)).toBe(true);
  });

  it('is idempotent, so text sanitized at the hook and again at the render site is stable', () => {
    // The reason the cut leaves room for the elision. Without it, a value passing
    // through both boundaries would collect a second marker and drift on every
    // hop.
    const once = safeProse('z'.repeat(MAX_SAFE_PROSE_LENGTH + 500));

    expect(safeProse(once)).toBe(once);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', { message: 'nope' }],
  ])('yields the empty string for %s, so no caller can render it', (_label, value) => {
    expect(safeProse(value)).toBe('');
  });

  it('yields the empty string for the empty string', () => {
    expect(safeProse('')).toBe('');
  });
});

describe('safeLabel — externally supplied identities', () => {
  it('returns a recorded observation identity unchanged', () => {
    expect(safeLabel('secrets events carrying a responseObject')).toBe(
      'secrets events carrying a responseObject',
    );
  });

  it('reports an empty label as empty rather than as absent', () => {
    expect(safeLabel('')).toBe(SAFE_EMPTY_STRING_LABEL);
  });

  it.each([
    ['a non-string', 7],
    ['a token shape', TOKEN_SHAPED],
    ['an over-long identity', 'l'.repeat(MAX_SAFE_LABEL_LENGTH + 1)],
  ])('withholds %s', (_label, value) => {
    expect(safeLabel(value)).toBe(SAFE_REDACTED);
  });
});

describe('safeObservationValue — measured values, judged by shape', () => {
  it('renders an explicit null as the token null', () => {
    // "Reported as null" and "not reported" are different claims and the V4
    // control turns on the difference (AAP §0.10.2).
    expect(safeObservationValue(null)).toBe('null');
  });

  it.each([
    ['a number', 403, '403'],
    ['zero', 0, '0'],
    ['true', true, 'true'],
    ['false', false, 'false'],
  ])('stringifies %s without reinterpreting it', (_label, value, expected) => {
    expect(safeObservationValue(value)).toBe(expected);
  });

  it('distinguishes a reported empty string from an absent value', () => {
    expect(safeObservationValue('')).toBe(SAFE_EMPTY_STRING_LABEL);
  });

  it.each([
    ['an audit level', AUDIT_LEVEL_ORDER[2]],
    ['the level ordering', AUDIT_LEVEL_ORDER.join(' < ')],
    ['a Pod Security label key', 'pod-security.kubernetes.io/enforce'],
    ['the aesgcm transformer prefix', AESGCM_PREFIX],
    ['the plaintext canary', PLAINTEXT_CANARY],
    ['a live storage prefix', '00000000-0000-0000-0000-000000000000/registry'],
    ['the mutual-TLS endpoint', ETCD_TLS_ENDPOINT],
    ['a ServiceAccount subject', 'system:serviceaccount:myns-v4:test-svcacct'],
    ['an admission config apiVersion', 'pod-security.admission.config.k8s.io/v1'],
    ['a credential file path', REAL_CREDENTIAL_PATH],
  ])('leaves %s exactly as measured', (_label, value) => {
    // THE NO-FALSE-POSITIVE CONTRACT, asserted against real recorded values
    // rather than against invented ones. Each of these is evidence some control
    // turns on; redacting any of them would break the control it belongs to.
    expect(safeObservationValue(value)).toBe(value);
  });

  it.each([
    ['a token shape', TOKEN_SHAPED],
    ['a padded base64 blob', KEY_SHAPED],
    ['PEM armour', PEM_SHAPED],
    ['a value longer than the bound', 'v'.repeat(MAX_SAFE_VALUE_LENGTH + 1)],
  ])('withholds %s whole rather than shortening it', (_label, value) => {
    // Redacted and not truncated: a shortened credential is still a leaked
    // prefix of that credential.
    expect(safeObservationValue(value)).toBe(SAFE_REDACTED);
  });
});

describe('safeSensitiveValue — values that are credential-bearing by contract', () => {
  it.each([
    ['token issued', 'a-token-value'],
    ['--etcd-keyfile', REAL_CREDENTIAL_PATH],
    ['kms provider secret', 'anything at all'],
    ['bearer credential', 'anything at all'],
  ])('withholds a string under the sensitive label %s whatever its shape', (label, value) => {
    expect(safeSensitiveValue(label, value)).toBe(SAFE_REDACTED);
  });

  it.each([
    ['a null', null, 'null'],
    ['a number', 1, '1'],
    ['a boolean', false, 'false'],
  ])('still renders %s under a sensitive label, because neither can be a credential', (
    _label,
    value,
    expected,
  ) => {
    expect(safeSensitiveValue('token issued', value)).toBe(expected);
  });

  it('reports a reported-but-empty credential field as empty', () => {
    expect(safeSensitiveValue('--etcd-cafile', '')).toBe(SAFE_EMPTY_STRING_LABEL);
  });

  it('falls through to shape-only judgement for a label that is not credential-bearing', () => {
    expect(safeSensitiveValue('outcome', 'fail-closed')).toBe('fail-closed');
    expect(safeSensitiveValue('outcome', TOKEN_SHAPED)).toBe(SAFE_REDACTED);
  });

  it('does NOT redact a value merely because its label mentions secrets', () => {
    // The asymmetry that makes label-driven redaction opt-in. Applied blanketly
    // it would erase the V6 audit table's own measured level -- the single most
    // consequential value in that control.
    expect(safeObservationValue('Request')).toBe('Request');
    expect(safeSensitiveValue('secrets audit level', 'Request')).toBe(SAFE_REDACTED);
  });
});

describe('isSafeAbsolutePath — the V8 credential-flag guard', () => {
  it.each([
    ['/etc/srv/kubernetes/pki/etcd-apiserver-ca.crt'],
    ['/etc/srv/kubernetes/pki/etcd-apiserver-client.crt'],
    [REAL_CREDENTIAL_PATH],
    ['/var/lib/kubelet/pki/kubelet-client-current.pem'],
  ])('accepts the absolute deployment path %s', (path) => {
    expect(isSafeAbsolutePath(path)).toBe(true);
  });

  it.each([
    ['a bare word', 'CACertPath'],
    ['a relative path', 'etc/srv/kubernetes/pki/ca.crt'],
    ['the empty string', ''],
    ['a non-string', 7],
    ['a path with whitespace', '/etc/srv/kubernetes/pki/ca file.crt'],
    ['a path with a newline', '/etc/srv/kubernetes/pki/ca.crt\n'],
    ['a dot segment', '/etc/srv/./pki/ca.crt'],
    ['a parent segment', '/etc/srv/../pki/ca.crt'],
    ['PEM content', PEM_SHAPED],
    ['a token shape', TOKEN_SHAPED],
    ['a URL', 'https://127.0.0.1:2379'],
    ['an over-long path', `/${'p'.repeat(MAX_SAFE_PATH_LENGTH)}`],
  ])('rejects %s', (_label, value) => {
    // THE FALSE-PASS THIS GUARD CLOSES. Before it, any non-empty string satisfied
    // "--etcd-cafile is supplied", so a PEM body, a token or the word `no` earned
    // a pass for the strongest posture V8 has.
    expect(isSafeAbsolutePath(value)).toBe(false);
  });
});

describe('safePathBasename — naming the artifact without the layout', () => {
  it('returns the final segment of a validated path', () => {
    expect(safePathBasename(REAL_CREDENTIAL_PATH)).toBe('etcd-apiserver-client.key');
  });

  it('tolerates a trailing slash', () => {
    expect(safePathBasename('/etc/srv/kubernetes/pki/')).toBe('pki');
  });

  it.each([['CACertPath'], ['relative/path.crt'], [''], [PEM_SHAPED]])(
    'withholds %s rather than guessing a basename',
    (value) => {
      expect(safePathBasename(value)).toBe(SAFE_REDACTED);
    },
  );
});

describe('containsCredentialShape — the shared question', () => {
  it.each([[TOKEN_SHAPED], [KEY_SHAPED], [PEM_SHAPED]])('recognises %s', (value) => {
    expect(containsCredentialShape(value)).toBe(true);
  });

  it.each([
    [AESGCM_PREFIX],
    ['pod-security.kubernetes.io/enforce'],
    ['audit.k8s.io/v1'],
    [REAL_CREDENTIAL_PATH],
    ['TestPodSecurityEnforceBaselineRejectsPrivileged'],
  ])('does not recognise the recorded value %s', (value) => {
    // The last entry is the reason unpadded base64 is deliberately NOT matched: a
    // long alphanumeric run is indistinguishable from a Go test-function name,
    // and redacting those would discard evidence to chase a shape that never
    // arrives.
    expect(containsCredentialShape(value)).toBe(false);
  });

  it('is stateless across calls, so a repeated question gets the same answer', () => {
    // A `g`-flagged regex carries a mutable lastIndex; sharing one between a test
    // and a replacement makes each call depend on the last.
    expect(containsCredentialShape(KEY_SHAPED)).toBe(true);
    expect(containsCredentialShape(KEY_SHAPED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE SANITIZER MUST NOT DESTROY RECORDED EVIDENCE (AAP §0.11.1).
//
// This block is the permissive half of the contract, and it exists because the
// restrictive half quietly broke it once. A padding-only base64 rule redacted the middle
// of the real Pod Security warning
// `securityContext.allowPrivilegeEscalation=false` -- a 24-character run of
// base64-alphabet letters immediately before an `=` -- so a panel rendered
// `securityContext.[redacted]false` for a genuine Kubernetes admission message.
//
// A per-pattern unit test could not have caught that: the pattern did exactly what it
// said. Only a sweep over the RECORDED corpus catches it, so this block walks every
// string in every recorded payload and requires the sanitizer to be the identity over
// all of them. Every later phase that tightens a rule is held to it.
// ---------------------------------------------------------------------------

describe('safeProse over the recorded corpus', () => {
  /**
   * Every recorded variant map, including the two measured `warn` payloads.
   *
   * `CONTROL_STATUS_FIXTURES` covers passing, failing and unknown for all eight
   * controls; the two warn payloads are keyed separately in the fixture because only V2
   * and V8 have a measured middle outcome, and V2's is the payload whose text the
   * padding-only rule damaged, so leaving it out would have left the sweep blind to the
   * very regression it exists to catch.
   */
  const RECORDED_VARIANTS: readonly Record<string, ControlStatus>[] = [
    ...Object.values(CONTROL_STATUS_FIXTURES),
    { V2: V2_POD_SECURITY_WARNING, V8: V8_ETCD_TRANSPORT_WARNING },
  ];

  /** Every server-supplied prose string in every recorded payload, with its origin. */
  const RECORDED_PROSE: readonly (readonly [string, string])[] = RECORDED_VARIANTS.flatMap((variant) =>
    Object.entries(variant).flatMap(([controlId, status]: [string, ControlStatus]) => {
      const strings: (readonly [string, string])[] = [[`${controlId}.summary`, status.summary]];
      if (status.detail !== undefined) {
        strings.push([`${controlId}.detail`, status.detail]);
      }
      status.warnings.forEach((warning, index) => {
        strings.push([`${controlId}.warnings[${String(index)}]`, warning]);
      });
      status.findings.forEach((finding, index) => {
        strings.push([`${controlId}.findings[${String(index)}].message`, finding.message]);
      });
      return strings;
    }),
  );

  it('sweeps a non-trivial corpus, so a green result means something', () => {
    // A guard over an empty list passes vacuously. This is the floor: eight controls
    // across four variants, each with a summary at minimum.
    expect(RECORDED_PROSE.length).toBeGreaterThan(60);
  });

  it('returns every recorded prose string unchanged', () => {
    // Softly, one assertion per string: a tightened rule that damages several should
    // report all of them in one run rather than only the first.
    for (const [origin, text] of RECORDED_PROSE) {
      expect.soft(safeProse(text), origin).toBe(text);
    }
  });

  it('recognises no credential shape in any recorded prose string', () => {
    for (const [origin, text] of RECORDED_PROSE) {
      expect.soft(containsCredentialShape(text), origin).toBe(false);
    }
  });

  it('keeps the Pod Security warning that a padding-only base64 rule destroyed', () => {
    // Pinned as its own case, naming the exact substring, so the regression is
    // identifiable from the spec name alone rather than only from a sweep failure.
    for (const warning of V2_RESTRICTED_WARNINGS) {
      expect.soft(safeProse(warning)).toContain(
        'securityContext.allowPrivilegeEscalation=false',
      );
      expect.soft(safeProse(warning)).not.toContain(SAFE_REDACTED);
    }
  });

  it('still redacts the recorded non-secret AES test key out of prose', () => {
    // The restrictive half, over the one piece of real key material AAP §0.11.1 permits
    // to appear anywhere in this repository. Loosening the rule must not have cost this.
    const sanitized = safeProse(`the provider key is ${RECORDED_TEST_KEY} and nothing else`);

    expect(sanitized).not.toContain(RECORDED_TEST_KEY);
    expect(sanitized).toContain(SAFE_REDACTED);
    expect(sanitized).toContain('the provider key is');
  });
});

// ---------------------------------------------------------------------------------
// Section 6 - CWE-200: prose arriving from the control plane
//
// AAP §0.4.2.4 / tech-spec §6.6.3.3. LOCKS: an API-server message, reason or detail is
// attacker-influenced text, so no panel may render it verbatim. Two mechanisms enforce
// that and this section pins both.
//
// WHY THIS SECTION EXISTS AT ALL. The panels previously routed every server string
// through `safeProse`, which is a DENYLIST: it removes the credential shapes it knows.
// A denylist is sound only where the value space is open-ended prose. It is the wrong
// tool for `reason`, whose value space is CLOSED - nineteen constants declared in
// staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go - because there a denylist
// leaks anything it fails to recognise while an allowlist leaks nothing at all. The two
// groups below therefore test two different guarantees, not one guarantee twice.
// ---------------------------------------------------------------------------------

describe('credential shapes are removed from open-ended prose', () => {
  // Every vector here reached the DOM unaltered before the fix. Each names the shape
  // rule that now catches it, so a rule deleted in a future edit fails a named case
  // rather than silently widening the leak.
  const VECTORS: ReadonlyArray<readonly [string, string, string]> = [
    ['bare assignment', 'the request carried password=hunter2 in its body', 'hunter2'],
    ['colon assignment', 'upstream replied token: abc123def456ghi789', 'abc123def456ghi789'],
    [
      'quoted assignment',
      'the client sent api_key = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"',
      'sk_live_4eC39HqLyjWDarjtT1zdp7dc',
    ],
    [
      'URI userinfo',
      'dial postgres://svc:s3cr3tpassword@db.internal:5432/posture failed',
      's3cr3tpassword',
    ],
    ['opaque token run', 'presented identity AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['padded base64', 'authorization header was dGhpc2lzYXNlY3JldHRva2Vu', 'dGhpc2lzYXNlY3JldHRva2Vu'],
  ];

  it.each(VECTORS)('removes a %s', (_shape, prose, secret) => {
    const sanitized = safeProse(prose);
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain(SAFE_REDACTED);
  });

  it.each(VECTORS)('reports a %s as credential-shaped', (_shape, prose) => {
    // THE PREDICATE MUST AGREE WITH THE SANITIZER, and this case exists because it once
    // did not. `safeProse` redacts surgically, but `safeLabel` and
    // `safeObservationValue` consult this predicate and return the value VERBATIM when
    // it answers false. So a shape the sanitizer knows and the predicate does not is
    // not a weaker redaction — it is no redaction at all, through a different entry
    // point. When the assignment, URI-userinfo and opaque-run rules were first added to
    // the sanitizer alone, `safeLabel('password=hunter2')` returned its own input.
    expect(containsCredentialShape(prose)).toBe(true);
  });

  it.each(VECTORS)('redacts a %s reaching a label or observation value', (_shape, prose, secret) => {
    // The consequence of the agreement above, asserted at the two entry points that
    // depend on it, so the guarantee is pinned where it is actually consumed rather
    // than only on the predicate that happens to implement it.
    expect(safeLabel(prose)).not.toContain(secret);
    expect(safeObservationValue(prose)).not.toContain(secret);
  });

  // CONTROLS. Redaction that swallows legitimate diagnostics is its own outage: the
  // reader loses the sentence that tells them WHY a control failed. Each of these is a
  // real string this system emits, taken from the shipped manifests, the Go tests or
  // the shell generator, and each must survive byte for byte.
  const PRESERVED: ReadonlyArray<readonly [string, string]> = [
    ['an admission refusal', 'pods "privileged-pod" is forbidden: violates PodSecurity "baseline:latest"'],
    ['an etcd client flag', '--etcd-keyfile=/etc/srv/kubernetes/pki/etcd-client.key'],
    ['a UUID storage prefix', 'a3f05d29-5b83-4e72-9d14-8c60a7be215f'],
    ['a namespace name', 'psa-enforce-baseline'],
    ['a Pod Security label', 'pod-security.kubernetes.io/enforce=baseline'],
    ['a release marker', 'v1.34.0-blitzy'],
    ['a transport summary', 'mTLS between etcd server and kube-apiserver is required'],
    ['a not-found message', 'secrets "audit-secret" not found'],
    ['a scan summary', '12 events scanned in 3400 milliseconds'],
  ];

  it.each(PRESERVED)('leaves %s untouched', (_what, prose) => {
    expect(safeProse(prose)).toBe(prose);
    expect(containsCredentialShape(prose)).toBe(false);
  });

  it.each(PRESERVED)('still renders %s as a label and an observation value', (_what, prose) => {
    // THE COST OF WIDENING THE PREDICATE, held down explicitly. Because a true answer
    // redacts the WHOLE label or value rather than part of it, a rule that is one
    // character too greedy does not blur a value — it erases a namespace name, a
    // provider prefix or an audit id that a panel exists to display. Every string here
    // is one this tier really renders, so an over-broad rule fails a named case.
    if (prose.length <= MAX_SAFE_VALUE_LENGTH) {
      expect(safeObservationValue(prose)).toBe(prose);
    }
    if (prose.length <= MAX_SAFE_LABEL_LENGTH) {
      expect(safeLabel(prose)).toBe(prose);
    }
  });
});

describe('describeStatusReason allowlists the closed StatusReason set', () => {
  it('passes through every reason apimachinery declares', () => {
    // Transcribed from the authoritative Go constants. A reason dropped from this list
    // would be silently refused at runtime, which would read to an operator as a broken
    // server rather than as a missing entry, so the whole set is asserted at once.
    expect(KUBERNETES_STATUS_REASONS).toContain('Forbidden');
    expect(KUBERNETES_STATUS_REASONS).toContain('NotFound');
    expect(KUBERNETES_STATUS_REASONS).toContain('Unauthorized');
    expect(KUBERNETES_STATUS_REASONS).toHaveLength(19);
    for (const reason of KUBERNETES_STATUS_REASONS) {
      expect(describeStatusReason(reason)).toBe(reason);
    }
  });

  it('refuses anything outside the set, including credential-free text', () => {
    // THE POINT OF THE ALLOWLIST. None of these carries a shape any denylist could
    // detect - `hunter2` is eight ordinary characters - yet all of them are attacker
    // supplied. Only membership testing keeps them out.
    for (const hostile of [
      'hunter2',
      'Forbidden ',
      'forbidden',
      'FORBIDDEN',
      'Forbidden; token=abc',
      '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----',
      'z'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    ]) {
      expect(describeStatusReason(hostile)).toBe(SAFE_UNRECOGNISED_REASON);
    }
  });

  it('refuses non-string input rather than coercing it', () => {
    // A malformed body can put any JSON type in `reason`. Coercion would stringify an
    // object's contents straight into the document, so the type is required exactly.
    for (const value of [undefined, null, 42, true, {}, ['Forbidden'], { reason: 'Forbidden' }]) {
      expect(describeStatusReason(value)).toBe(SAFE_UNRECOGNISED_REASON);
    }
  });

  it('never emits a marker that could be mistaken for a real reason', () => {
    // The sentinel has to be visibly not-a-reason, or an operator reading the panel
    // would treat a refusal as a verdict the server actually sent.
    expect(KUBERNETES_STATUS_REASONS).not.toContain(SAFE_UNRECOGNISED_REASON);
    expect(SAFE_UNRECOGNISED_REASON).toContain('[');
  });
});
