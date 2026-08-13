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

/**
 * The ONE bounded sanitizer every externally supplied string passes through
 * before it becomes DOM text.
 *
 * AAP §0.11.1 ("no secrets, ever" and "never weaken a boundary condition") /
 * §0.10.2 (the boundary conditions the panels assert) / §0.5.1 (the
 * `web/src/**` rows) / §0.8.1.2 / tech-spec §6.6.3.3.
 *
 * WHY THIS MODULE EXISTS. Every panel in this tier renders three classes of
 * string it did not author:
 *
 *   1. per-control prose — `summary`, `detail`, `findings[].message`,
 *      `findings[].subject`, `warnings[]`;
 *   2. transport and parser failure text — an HTTP `Status` body's `message`
 *      and `reason`, a `statusText`, a network `DOMException` message;
 *   3. evidence the panel has no row for — an unrecognised observation's own
 *      `label` and `value`.
 *
 * All three arrive from outside the component and all three end up as document
 * text, so each is a channel by which a credential placed in a payload becomes
 * a credential in the DOM, in every screenshot of it and in every snapshot
 * taken of it. Exactly one panel — {@link ../components/TokenHygienePanel} —
 * guarded those channels; the other eight and the aggregate dashboard did not,
 * and each had to be trusted to reinvent the same rules. This module is that
 * guard, promoted to one place so there is one definition to read, one to
 * review and one to change.
 *
 * WHAT IT DOES NOT DO, deliberately. It does not decide what is evidence. A
 * value this module cannot render safely is replaced by {@link SAFE_REDACTED},
 * never dropped: silence would read as "nothing was reported", which is a
 * different claim from "something was reported that must not be shown", and the
 * two demand different verdicts. Nothing here rounds, reorders, re-parses or
 * re-interprets a value either — a boundary condition is compared against the
 * value the server sent, and this module is only ever asked how to DISPLAY it.
 *
 * THE OVER-REDACTION RULE IS NOT A BLANKET RULE, and that asymmetry is the
 * subtlest thing in this file. Redacting a value because its LABEL sounds
 * sensitive is correct for a projected token and wrong for the V6 audit table,
 * whose row `audit level for secrets in namespace secret-audit-request` carries
 * the value `Request` — the single most consequential measured value in the
 * whole tier. Blanket label-driven redaction would erase it, and erasing
 * evidence is the quieter form of the same mistake as leaking it. Label-driven
 * redaction therefore lives in {@link safeSensitiveValue} and is applied ONLY
 * where a field is credential-BEARING by contract; every other value goes
 * through {@link safeObservationValue}, which redacts on the SHAPE of the value
 * rather than on the wording of its label.
 *
 * This module depends on NOTHING — no React, no hook, no fixture — so it can be
 * imported by every component, by the hooks and by the recorded fixtures without
 * creating a cycle.
 */

/**
 * Rendered in place of a value that must not be shown.
 *
 * A fixed, unmistakable token rather than an empty string, so a reader can tell
 * "withheld" from "absent" and a spec can assert on it.
 */
export const SAFE_REDACTED = '[redacted]';

/**
 * Rendered for a reported-but-empty string.
 *
 * `""` is a MEASURED value and a different fact from `null` and from "not
 * reported"; an empty table cell would read as the latter.
 */
export const SAFE_EMPTY_STRING_LABEL = '(empty string)';

/**
 * Rendered in place of text so large that it is not plausibly a message.
 *
 * The whole value is replaced rather than truncated, because a truncated blob is
 * still a leaked prefix of that blob.
 */
export const SAFE_OVERSIZED_TEXT = '[withheld: unexpectedly large text]';

/** Appended when prose is shortened to {@link MAX_SAFE_PROSE_LENGTH}. */
export const SAFE_PROSE_ELISION = ' […]';

/**
 * Longest string VALUE rendered verbatim.
 *
 * Anything longer is redacted rather than shortened: a measured value this long
 * is not a measurement a reader can use, and shortening it would leave a prefix
 * of whatever it actually was. 200 is the bound the V4 panel already applied to
 * its own values, kept unchanged so promoting the guard changes no verdict.
 */
export const MAX_SAFE_VALUE_LENGTH = 200;

/**
 * Longest PROSE rendered, after redaction.
 *
 * Generous on purpose. The longest recorded `detail` in this tier is 500
 * characters, so this bound never touches a legitimate message; it exists to
 * stop an unbounded server string from becoming an unbounded DOM node. Prose is
 * shortened with {@link SAFE_PROSE_ELISION} rather than redacted whole, because
 * a message's opening sentences are the part a reader needs and every
 * credential SHAPE has already been removed before the cut is made.
 */
export const MAX_SAFE_PROSE_LENGTH = 2000;

/**
 * Ceiling on the input this module will inspect at all.
 *
 * Beyond it the value is replaced by {@link SAFE_OVERSIZED_TEXT} without being
 * scanned. Scanning first and cutting afterwards is the safe order for ordinary
 * text (see {@link safeProse}); for text this size the honest report is that
 * something unexpected arrived, not a two-thousand-character excerpt of it.
 */
export const MAX_SAFE_PROSE_INPUT_LENGTH = 8192;

/**
 * Longest label rendered verbatim, for evidence a panel has no row for.
 *
 * Shorter than a value's bound because a label is an identifier, not a message:
 * the recorded identities in {@link ./observationIds} are all well under this.
 */
export const MAX_SAFE_LABEL_LENGTH = 120;

/** Longest credential FILE PATH accepted by {@link isSafeAbsolutePath}. */
export const MAX_SAFE_PATH_LENGTH = 512;

/**
 * Labels whose value is treated as credential-bearing and never rendered.
 *
 * Invariant locked (AAP §0.11.1, "no secrets, ever"): a projected token and a
 * private-key path are live credentials, and a rendered one sits in the DOM.
 * Matching is by label so the guard holds even for evidence the panel does not
 * otherwise recognise.
 *
 * APPLIED ONLY THROUGH {@link safeSensitiveValue}. See the module note: applied
 * blanketly this pattern would redact `secrets audit level`, `unrelated secret
 * read` and every V3 row whose identity names a key, destroying the very
 * evidence those controls turn on.
 */
export const SENSITIVE_LABEL_PATTERN = /token|secret|key|password|credential|bearer/i;

/**
 * A substring shaped like a compact JSON Web Token: three or more base64url
 * segments of at least eight characters each, separated by dots.
 *
 * Expressed as a shape rather than by matching a well-known header prefix, so
 * this file contains no fragment of a token and the guard still catches one
 * whose header differs.
 *
 * UNANCHORED, AND THAT IS THE POINT. An anchored pattern only ever matches a
 * whole string, so it sees nothing in `token=<jwt>`, `(<jwt>)`, `"<jwt>"` or
 * `Bearer <jwt>.` — which is how a credential stays on screen while a guard
 * reports that it looked.
 *
 * `{2,}` trailing segments rather than exactly two, so a four-segment
 * (encrypted) token is consumed whole instead of leaving its final segment
 * behind. The eight-character floor per segment is what keeps ordinary dotted
 * identifiers out of the guard's way: `kubernetes.io.serviceaccount.name`,
 * `pod-security.admission.config.k8s.io`, `apiserver.config.k8s.io/v1` and
 * `audit.k8s.io/v1` all contain a segment shorter than eight, so none can match.
 */
export const CREDENTIAL_SHAPED_VALUE = /[\w-]{8,}(?:\.[\w-]{8,}){2,}/;

/**
 * The same shape, global, used ONLY for replacement.
 *
 * A separate instance because a `g` regex carries a mutable `lastIndex`, and
 * sharing one between `test` and `replace` makes each call depend on the last.
 */
const CREDENTIAL_SHAPED_VALUE_GLOBAL = new RegExp(CREDENTIAL_SHAPED_VALUE.source, 'g');

/**
 * PEM armour, from the BEGIN marker to its END marker or to the end of the text.
 *
 * The armour is what makes a certificate, a private key and a CA bundle
 * recognisable without knowing which of the three arrived, and the alternation
 * covers the truncated case: an unterminated block is redacted to the end rather
 * than left rendered because its closing line went missing.
 */
const PEM_ARMOURED_BLOCK = /-----BEGIN[\s\S]*?(?:-----END[^\n]*?-----|$)/g;

/** The BEGIN marker alone, for the cheap presence test. */
const PEM_MARKER = '-----BEGIN';

/**
 * A padded base64 run of at least sixteen characters that also LOOKS like encoded
 * binary rather than like an identifier.
 *
 * The padding narrows the rule, and the leading assertion narrows it again. Padding
 * alone was not enough, and the counter-example is a real recorded string rather
 * than a hypothetical: the Pod Security warning
 * `securityContext.allowPrivilegeEscalation=false` puts a 24-character run of
 * base64-alphabet letters immediately before an `=`, so a padding-only rule
 * redacted the middle of a genuine Kubernetes admission message. Destroying
 * recorded evidence to chase a shape is the opposite of the point — AAP §0.11.1 is
 * "evidence over assumption", and a sanitizer that mangles ordinary prose pushes
 * panels back to inventing their own wording.
 *
 * The assertion requires the run to contain a DIGIT or a `+`. Those are the
 * signatures of encoded binary and the two things a camelCase identifier never has:
 * `allowPrivilegeEscalation`, `RuntimeDefault` and `seccompProfile` are letters
 * only, while base64 of a 32-byte key carries one or the other with probability
 * above 99.9 %. The recorded non-secret test key `c2VjcmV0IGlzIHNlY3VyZQ==` carries
 * digits and is still matched.
 *
 * `/` is deliberately NOT a signal even though base64 uses it, because it is also a
 * path separator and a label-key separator: `pod-security.kubernetes.io/` before an
 * `=` would otherwise be read as encoded binary. The remaining gap — a sixteen-
 * character run of letters only, which is twelve bytes and not key material anyone
 * pastes — is covered by the length bound in {@link safeObservationValue}, which
 * withholds ANY string over {@link MAX_SAFE_VALUE_LENGTH} whatever its shape, and by
 * {@link safeSensitiveValue}'s label-driven redaction for fields documented to carry
 * a credential.
 *
 * Unpadded base64 is deliberately NOT matched: a long unpadded alphanumeric run is
 * indistinguishable from a Go test-function name such as
 * `TestPodSecurityEnforceBaselineRejectsPrivileged`, and redacting those would
 * discard evidence to chase a shape that never arrives.
 */
const PADDED_BASE64_BLOB = /(?=[A-Za-z0-9+/]*[0-9+])[A-Za-z0-9+/]{16,}={1,2}/g;

/**
 * The same shape, non-global, for the presence test.
 *
 * Separate from the replacement instance for the reason given on
 * {@link CREDENTIAL_SHAPED_VALUE_GLOBAL}: a `g` regex carries a mutable
 * `lastIndex`, so a shared instance would make each `test` depend on the last.
 */
const PADDED_BASE64_BLOB_TEST = new RegExp(PADDED_BASE64_BLOB.source);

/**
 * Characters that must never reach the document: C0 and C1 controls, the
 * zero-width and bidirectional-override range, and the Unicode line and
 * paragraph separators.
 *
 * Collapsed to a single space rather than deleted, so two words separated only
 * by a newline do not fuse into one. The bidirectional overrides matter for the
 * same reason the controls do: they let a payload reorder what a reader sees
 * without changing what the string contains, which would let a rendered value
 * lie about itself.
 */
const UNRENDERABLE_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069]/g;

/** Runs of whitespace, collapsed so layout cannot be driven from a payload. */
const WHITESPACE_RUN = /\s{2,}/g;

/**
 * The shape of an absolute POSIX file path.
 *
 * One or more `/`-led segments of ordinary path characters, with an optional
 * trailing slash. Absolute because every credential path a kube-apiserver flag
 * carries is absolute (`configure-helper.sh` renders them under
 * `/etc/srv/kubernetes/pki`), and requiring the leading slash is what makes PEM
 * content, a token, a URL and a bare word all fail the test rather than being
 * accepted as "some path".
 */
const ABSOLUTE_POSIX_PATH = /^(?:\/[A-Za-z0-9._@+-]+)+\/?$/;

/**
 * A `key = value` or `key: value` assignment whose KEY names a credential.
 *
 * CLOSES THE LARGEST GAP IN A SHAPE-ONLY SANITIZER. Everything above recognises a
 * credential by its ENCODING — PEM armour, a dotted JWT, a padded base64 blob — and
 * a short opaque secret has no encoding to recognise. `password=hunter2` is eight
 * ordinary characters; no entropy or structure rule can distinguish it from prose,
 * so it passed through untouched into live DOM alerts. React escaping prevents
 * script injection, not disclosure (CWE-200).
 *
 * The KEY is the signal instead of the value, which is what makes this reliable: a
 * backend that names a field `password` has told us the next token is one. The label
 * is preserved and only the value is replaced, so the message still says WHAT was
 * withheld — "password=[redacted]" is more useful to an operator than a message with
 * a hole in it, and it cannot leak.
 *
 * Word boundaries matter and were chosen deliberately: `\bkey\b` does not match
 * `keyfile`, so `--etcd-keyfile=/etc/srv/kubernetes/pki/etcd-client.key` keeps its
 * path — a path is not a credential, and redacting it would destroy the evidence the
 * V8 panel exists to show.
 */
const SENSITIVE_ASSIGNMENT =
  /\b(token|secret|key|password|passwd|pwd|credential|credentials|bearer|apikey|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)\]}]+)/gi;

/**
 * The `user:password@` userinfo of a URI.
 *
 * A connection string is the other way a short opaque secret reaches a log without
 * looking like one: `postgres://svc:s3cr3t@db.internal:5432/posture` is a perfectly
 * ordinary error-message fragment and the password sits in the middle of it. Matched
 * only when the userinfo actually contains a `:` — that is, only when a password is
 * present — so `https://foo.bar.example.com` and a plain `user@host` are untouched.
 */
const URI_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/g;

/**
 * A long opaque single-token run: 16 or more `[A-Za-z0-9_]` characters carrying at
 * least one digit and at least one letter.
 *
 * Catches the credentials that carry no padding and no dots — an AWS-style access key
 * id, an unpadded base64url token, a hex API key — which the padded-base64 rule above
 * explicitly declines to match.
 *
 * THE CHARACTER CLASS EXCLUDES `-` AND `.` ON PURPOSE, and that is what keeps this
 * precise rather than destructive. Both are separators in the identifiers this tier
 * legitimately renders, so excluding them breaks those identifiers into short runs
 * that cannot match:
 *   * a UUID `a3f05d29-5b83-4e72-9d14-8c60a7be215f` — longest run is 8, and audit IDs
 *     are rendered for correlation, so redacting them would remove a real affordance;
 *   * a version `v1.34.0-blitzy`, a namespace `psa-enforce-baseline`, a label
 *     `pod-security.kubernetes.io/enforce` — all broken into short, letter-only runs.
 * Requiring BOTH a digit and a letter excludes ordinary long words and plain decimal
 * numbers such as a byte count or a timestamp.
 */
const OPAQUE_TOKEN_RUN = /(?=[A-Za-z0-9_]{16,})(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*/g;

/**
 * Replaces every recognisable credential shape in `text` with
 * {@link SAFE_REDACTED}.
 *
 * Order matters, and each step is ordered against the one after it:
 *   1. PEM armour first, because a base64 body inside a block would otherwise be
 *      redacted piecemeal and leave the armour lines on screen looking like a
 *      rendered certificate.
 *   2. URI userinfo before the token rules, so a password inside a connection string
 *      is removed as part of the URI rather than leaving a mangled fragment.
 *   3. Sensitive assignments before the opaque-run rule, so the label survives and
 *      only its value is replaced.
 *   4. The encoding-shaped rules last, over whatever remains.
 *
 * A DENYLIST OF FOUR RULES IS STILL A DENYLIST, and that is stated rather than
 * glossed: this is defence in depth for text that a panel has decided to render, not
 * a proof that no secret can ever appear in backend prose. The structural protection
 * is that every panel's diagnosis is composed from LOCAL text plus enumerated,
 * allowlisted fields — see {@link describeStatusReason} — so a withheld message
 * costs context and never the explanation itself.
 */
function redactCredentialShapes(text: string): string {
  return text
    .replace(PEM_ARMOURED_BLOCK, SAFE_REDACTED)
    .replace(URI_USERINFO, `$1${SAFE_REDACTED}@`)
    .replace(SENSITIVE_ASSIGNMENT, `$1$2${SAFE_REDACTED}`)
    .replace(CREDENTIAL_SHAPED_VALUE_GLOBAL, SAFE_REDACTED)
    .replace(PADDED_BASE64_BLOB, SAFE_REDACTED)
    .replace(OPAQUE_TOKEN_RUN, SAFE_REDACTED);
}

/**
 * Removes unrenderable characters, collapses whitespace runs and trims.
 *
 * Applied to every string this module renders, including ones it then redacts,
 * so that a control character can never survive by hiding in a value that
 * happened to pass the shape checks.
 */
function flatten(text: string): string {
  return text.replace(UNRENDERABLE_CHARACTERS, ' ').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Non-global test twins of the three shape rules that are declared with `g`.
 *
 * A `g` regex carries a mutable `lastIndex`, so calling `.test()` on the rule used for
 * replacement would make the answer depend on how many times it had been called before
 * — the same hazard {@link PADDED_BASE64_BLOB_TEST} exists to avoid. These share the
 * rules' sources, so a rule edited above cannot leave its predicate behind.
 */
const SENSITIVE_ASSIGNMENT_TEST = new RegExp(SENSITIVE_ASSIGNMENT.source, 'i');
const URI_USERINFO_TEST = new RegExp(URI_USERINFO.source);
const OPAQUE_TOKEN_RUN_TEST = new RegExp(OPAQUE_TOKEN_RUN.source);

/**
 * Whether `text` contains something shaped like a credential.
 *
 * Exported so a caller that must make a DECISION about a value — rather than
 * render it — can ask the same question this module answers, instead of writing
 * a second, drifting copy of these patterns.
 *
 * IT MUST TEST EVERY SHAPE {@link redactCredentialShapes} REPLACES, and it has to be
 * kept that way deliberately, because the two are consulted at different depths. The
 * callers that render prose sanitize it surgically; {@link safeLabel},
 * {@link safeObservationValue} and {@link isSafeAbsolutePath} instead consult THIS
 * predicate and, when it answers false, return the value VERBATIM. A shape known to
 * the sanitizer but missing here therefore does not degrade to a partial redaction —
 * it leaks the whole value into the document. That is not hypothetical: when the
 * assignment, URI-userinfo and opaque-run rules were added to the sanitizer without
 * being added here, `safeLabel('password=hunter2')` returned its input unchanged.
 */
export function containsCredentialShape(text: string): boolean {
  return (
    text.includes(PEM_MARKER) ||
    CREDENTIAL_SHAPED_VALUE.test(text) ||
    PADDED_BASE64_BLOB_TEST.test(text) ||
    SENSITIVE_ASSIGNMENT_TEST.test(text) ||
    URI_USERINFO_TEST.test(text) ||
    OPAQUE_TOKEN_RUN_TEST.test(text)
  );
}

/**
 * Renders externally supplied PROSE safely.
 *
 * Invariant locked: the returned string contains no control character, no
 * bidirectional override, no recognisable credential shape, and no more than
 * {@link MAX_SAFE_PROSE_LENGTH} characters. Ordinary prose is returned
 * unchanged, which is what keeps a server's own explanation of a failure
 * legible — a sanitizer that mangled every message would push panels back to
 * inventing their own wording, and an invented message cannot say what actually
 * went wrong.
 *
 * REDACT BEFORE CUTTING. Shortening first would let a credential straddle the
 * cut and leave its prefix on screen, so the shape rules run over the whole
 * string and the length bound is applied to the result.
 *
 * @param text - the externally supplied text, or anything at all: a non-string
 *   yields the empty string, so a caller cannot render `undefined`.
 * @returns text that is safe to place in the document.
 */
export function safeProse(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  if (text.length > MAX_SAFE_PROSE_INPUT_LENGTH) {
    return SAFE_OVERSIZED_TEXT;
  }
  const redacted = flatten(redactCredentialShapes(text));
  if (redacted.length <= MAX_SAFE_PROSE_LENGTH) {
    return redacted;
  }
  // Cut to leave room for the elision so the RESULT is exactly the bound, which
  // is what makes this function idempotent: sanitizing already-sanitized text
  // must be a no-op, or a value passing through both the hook boundary and a
  // render site would collect a second elision marker.
  const kept = redacted.slice(0, MAX_SAFE_PROSE_LENGTH - SAFE_PROSE_ELISION.length).trimEnd();
  return `${kept}${SAFE_PROSE_ELISION}`;
}

/**
 * Renders an externally supplied LABEL safely.
 *
 * A label identifies a measurement, so it is bounded harder than prose and
 * redacted whole when it carries a credential shape: an identifier that looks
 * like a token is not an identifier, and there is nothing in it worth showing.
 *
 * @param label - the label, or anything at all.
 * @returns a label safe to place in the document, or {@link SAFE_REDACTED}.
 */
export function safeLabel(label: unknown): string {
  if (typeof label !== 'string') {
    return SAFE_REDACTED;
  }
  const flattened = flatten(label);
  if (flattened.length === 0) {
    return SAFE_EMPTY_STRING_LABEL;
  }
  if (flattened.length > MAX_SAFE_LABEL_LENGTH || containsCredentialShape(flattened)) {
    return SAFE_REDACTED;
  }
  return flattened;
}

/**
 * Renders a measured observation VALUE safely, on the strength of its shape.
 *
 * `null` renders as the token `null` because the hook documents it as a
 * representable measured value rather than a missing one, and the V4 control
 * turns on the difference: a `pod` sub-claim reported `null` is proof of an
 * unbound token, while an absent one proves nothing. An empty string renders as
 * {@link SAFE_EMPTY_STRING_LABEL} for the same reason. Numbers and booleans are
 * stringified and never reinterpreted.
 *
 * A string is redacted — not shortened — when it is longer than
 * {@link MAX_SAFE_VALUE_LENGTH} or carries a credential shape.
 *
 * @param value - the measured value.
 * @returns display text for the value.
 */
export function safeObservationValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  const flattened = flatten(value);
  if (flattened.length === 0) {
    return SAFE_EMPTY_STRING_LABEL;
  }
  if (flattened.length > MAX_SAFE_VALUE_LENGTH || containsCredentialShape(flattened)) {
    return SAFE_REDACTED;
  }
  return flattened;
}

/**
 * Renders a value that is credential-BEARING by contract.
 *
 * Adds label-driven redaction on top of {@link safeObservationValue}: any string
 * whose label matches {@link SENSITIVE_LABEL_PATTERN} is withheld whatever its
 * shape, because the contract — not the content — is what makes it a credential.
 * A `null` and a number still render, because neither can be a credential and
 * both are load-bearing evidence: `null` proves absence, and a number is a
 * count, a status code or a timeout.
 *
 * Use this for a field documented to carry a token, a key or a credential file
 * path. Use {@link safeObservationValue} for everything else — see the module
 * note on why this is not the default.
 *
 * @param label - the observation's label, used only to classify.
 * @param value - the measured value.
 * @returns display text for the value.
 */
export function safeSensitiveValue(
  label: string,
  value: string | number | boolean | null,
): string {
  if (value === null || typeof value !== 'string') {
    return safeObservationValue(value);
  }
  const flattened = flatten(value);
  if (flattened.length === 0) {
    return SAFE_EMPTY_STRING_LABEL;
  }
  return SENSITIVE_LABEL_PATTERN.test(label) ? SAFE_REDACTED : safeObservationValue(value);
}

/**
 * Whether `value` is a bounded, absolute POSIX file path and nothing else.
 *
 * Invariant locked (the V8 credential-flag half of AAP §0.10.2): a measurement
 * that claims to be a credential FILE PATH is only evidence of mutual TLS if it
 * is actually shaped like a path. Before this test, any non-empty string
 * satisfied `--etcd-cafile is supplied` — so a PEM body, a token or the word
 * `no` earned a pass for the strongest posture the control has, and the value
 * was then rendered.
 *
 * Rejected, deliberately and in this order: a non-string; the empty string;
 * anything longer than {@link MAX_SAFE_PATH_LENGTH}; anything carrying a control
 * character, whitespace or a credential shape; anything relative; and any path
 * containing a `.` or `..` segment, which cannot be the literal path a rendered
 * flag was measured to carry.
 *
 * @param value - the measured value.
 * @returns `true` only for a path safe both to trust and to display.
 */
export function isSafeAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value.length > MAX_SAFE_PATH_LENGTH) {
    return false;
  }
  if (flatten(value) !== value || /\s/.test(value) || containsCredentialShape(value)) {
    return false;
  }
  if (!ABSOLUTE_POSIX_PATH.test(value)) {
    return false;
  }
  return !value.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * The final segment of a validated absolute path, for display.
 *
 * A basename names the artifact — `etcd-apiserver-client.key` — without putting
 * the deployment's directory layout on screen, which is the most a reader needs
 * in order to tell a CA file from a client key. Anything that is not a valid
 * absolute path yields {@link SAFE_REDACTED} rather than a guess.
 *
 * @param value - the measured value.
 * @returns the basename, or {@link SAFE_REDACTED}.
 */
export function safePathBasename(value: unknown): string {
  if (!isSafeAbsolutePath(value)) {
    return SAFE_REDACTED;
  }
  // Derived by slicing rather than by indexing a split list, deliberately. An
  // index needs a "what if the list was empty" branch that {@link
  // isSafeAbsolutePath} has already made unreachable, and an unreachable guard is
  // worse than no guard because no test can reach it. Here the path is known
  // absolute, so `lastIndexOf` cannot return -1 and the slice cannot be empty.
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  return withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf('/') + 1);
}

/* ------------------------------------------------------------------------ *
 * Allowlisted structured evidence
 * ------------------------------------------------------------------------ */

/**
 * Every `Status.reason` the Kubernetes API server can send.
 *
 * TRANSCRIBED, NOT GUESSED. These are the nineteen `StatusReason` constants declared
 * in `staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/types.go`, which is the only
 * place that defines them. `reason` is an ENUMERATION rather than prose, so it can be
 * allowlisted outright — and allowlisting is categorically stronger than sanitizing:
 * a value that is not on this list is not rendered at all, so there is nothing for a
 * pattern to miss.
 *
 * This is the structural half of the CWE-200 fix. The sanitizer that guards free
 * text is a denylist of credential shapes, and a denylist can only ever remove what
 * it recognises; every field that CAN be enumerated is therefore enumerated instead,
 * so the surface a denylist has to cover shrinks to the one field that is genuinely
 * free text.
 */
export const KUBERNETES_STATUS_REASONS: readonly string[] = Object.freeze([
  'AlreadyExists',
  'BadRequest',
  'Conflict',
  'Expired',
  'Forbidden',
  'Gone',
  'InternalError',
  'Invalid',
  'MethodNotAllowed',
  'NotAcceptable',
  'NotFound',
  'RequestEntityTooLarge',
  'ServerTimeout',
  'ServiceUnavailable',
  'StorageReadError',
  'Timeout',
  'TooManyRequests',
  'Unauthorized',
  'UnsupportedMediaType',
]);

/** Rendered in place of a `reason` that is not a recognised Kubernetes value. */
export const SAFE_UNRECOGNISED_REASON = '[unrecognised reason]';

/**
 * Renders a `Status.reason` from the ALLOWLIST, never as prose.
 *
 * A recognised reason is returned verbatim, because it is one of nineteen fixed
 * tokens and carries no attacker-controlled content. Anything else — free text a
 * backend put in the field, a value from a newer API version, an empty string —
 * yields {@link SAFE_UNRECOGNISED_REASON}, so this function can never place
 * server-chosen characters in the document.
 *
 * Contrast with passing `reason` through {@link safeProse}, which is what the panels
 * did: that renders whatever the server sent minus any credential shape the denylist
 * happens to recognise, and a short opaque secret has no shape to recognise. An
 * allowlist has no such gap.
 *
 * @param reason - the raw `reason` field, or anything at all.
 * @returns the allowlisted token, or {@link SAFE_UNRECOGNISED_REASON}.
 */
export function describeStatusReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    return SAFE_UNRECOGNISED_REASON;
  }
  return KUBERNETES_STATUS_REASONS.includes(reason) ? reason : SAFE_UNRECOGNISED_REASON;
}
