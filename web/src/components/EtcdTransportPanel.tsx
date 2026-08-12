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

// The React presentation surface for V8 — etcd mutual-TLS transport (F-008).
//
// AAP §0.5.1 / §0.4.2.4 (L6 React tier, V8) / tech-spec §6.2.4.6.
//
// NO PARITY ANCESTOR — AND THAT IS A MEASURED FACT, NOT AN OMISSION.
//   blitzy/documentation/Project Guide.md L133 records that this is a
//   "control-plane/configuration project with **no UI surface**", and
//   tech-spec §6.6.1.3 marks UI automation and cross-browser testing as not
//   applicable. There is therefore no Go, Ginkgo or browser test to port into
//   this file: AAP §0.4.1.1 states that the React tier's "parity ancestry is
//   the REST and CLI behaviour it surfaces". What this panel surfaces is the
//   shell behaviour of `configure-etcd-params`, and its two measured origins
//   are cited on every constant below:
//
//     * cluster/gce/gci/configure-kubeapiserver.sh L18-L70 — the shipped
//       generator `configure-etcd-params`, which this file never re-implements
//       (AAP §0.8.2 lists the Bash hardening scripts as out of scope for
//       modification, and AAP §0.4.1.1 keeps the shell tier invoking the real
//       script so the test "proves the shipped shell generator").
//     * cluster/gce/gci/apiserver_etcd_test.go L158-L215 — `TestTLSFlags`, the
//       unit oracle that measures it. Its two subtests, "mTLS enabled" and
//       "mTLS disabled", are the recorded evidence for the flag strings and the
//       two endpoints reproduced here.
//
// COMPONENT INVARIANT LOCKED HERE (AAP §0.10.2, "boundary conditions that must
// port unchanged"; AAP §0.11.1, "never weaken a boundary condition to make a
// test pass"):
//
//   A plaintext etcd endpoint is NEVER a pass. Absent credentials under a
//   hardened profile is a fail-closed outcome — `configure-etcd-params` aborts
//   the boot with `exit 1` — and PARTIAL credentials are a failure, not a
//   partial pass.
//
// THE PANEL'S SEMANTICS, STATED ONCE AND APPLIED UNIFORMLY.
//   Each scenario row answers ONE question: did `configure-etcd-params` behave
//   as F-008 requires for that input? It does NOT answer "does this deployment
//   end up speaking mutual TLS", because those two questions disagree on
//   exactly one input and conflating them is how a real control gets lost. The
//   rule that follows from the semantics, and that every verdict below obeys:
//
//     A scenario that PRODUCES A PLAINTEXT ENDPOINT is never a pass.
//
//   The one input where the two questions disagree is `no-certs-hardened`, and
//   AAP §0.4.2.4 requires this file to be explicit about which reading it
//   chose and why. THE READING CHOSEN IS "THE CONTROL FAILS CLOSED", SO THAT
//   SCENARIO RENDERS AS `pass`. Three reasons, each checkable:
//
//     1. It produces NO endpoint at all — the boot aborts before one is
//        configured — so rendering it as satisfied is not rendering a plaintext
//        fallback as satisfied. The guard above stays intact.
//     2. F-008-RQ-003 is the fail-closed requirement itself. `exit 1` is the
//        required behaviour, so the control holds. AAP §0.4.2.1's L4 blueprint
//        files this input under the shell's "Error cases" while requiring the
//        ported test to PASS on `returncode == 1`, which is the same reading.
//     3. The repository already reads it this way: Project Guide.md L156
//        records V8 as "✅ Pass (config)" on the strength of the committed
//        fail-closed wiring, with only live certificate and network
//        verification outstanding.
//
//   `partial-credentials` is `fail` under the SAME semantics rather than in
//   spite of them, and the evidence is in the shell rather than in taste:
//   `ETCD_APISERVER_ALLOW_INSECURE` is consulted ONLY in the all-absent branch
//   (configure-kubeapiserver.sh L41). No opt-out reaches the partial branch,
//   whose message is the imperative "Please provide all mTLS credential"
//   (L49). A half-configured deployment is an operator misconfiguration that
//   the control catches, not a posture the control tolerates — so it is
//   reported as a failure, never as a partial pass.
//
// WHAT THIS FILE IS NOT.
//   It does not call `fetch`: data access belongs to
//   web/src/hooks/useControlStatus.ts, which is this file's only internal
//   import and the single definition site of every posture type used here.
//   It introduces no design system, no CSS framework, no icon library and no
//   stylesheet — markup is plain and semantic, `className` and `data-*` are
//   left as styling hooks, and no `style` attribute appears, so a verdict is
//   conveyed by TEXT and never by colour alone. It asserts no external
//   benchmark or hardening-guide control number, because the repository
//   enumerates none (tech-spec §2.5.3, AAP §0.11.1 "cite only what the
//   repository states"); the identifiers used are the repository's own,
//   F-008-RQ-001 through F-008-RQ-003. It carries no certificate, key or
//   credential material: the only path-shaped strings below are the literal
//   placeholder values of the Go fixture (`kubeAPIServeETCDEnv`,
//   apiserver_etcd_test.go L26-L43) and the only variable NAMES are the six
//   the shell tests for.
import { useId, useState, type ChangeEvent, type ReactElement } from 'react';

import {
  readBoolean,
  readNumber,
  readString,
  selectObservation,
  strictestVerdict,
  type EffectiveVerdict,
} from '../domain/evidence';
import { V8_OBSERVATIONS } from '../domain/observationIds';
import { ETCD_PLAINTEXT_ENDPOINT, ETCD_TLS_ENDPOINT } from '../domain/securityConstants';
import {
  selectControlStatus,
  useControlStatus,
  type ControlFinding,
  type ControlObservation,
  type ControlStatus,
  type ControlStatusError,
  type ControlVerdict,
  type UseControlStatusResult,
} from '../hooks/useControlStatus';
import { REFRESH_UNAVAILABLE_TITLE, resolveRefreshHandler } from './refreshContract';

/**
 * The control this panel reports on.
 *
 * `satisfies` rather than a type annotation on purpose: it validates the value
 * against the roster in web/src/hooks/useControlStatus.ts while keeping the
 * literal type, so passing it to `useControlStatus` and `selectControlStatus`
 * stays exact.
 */
export const ETCD_TRANSPORT_CONTROL_ID = 'V8' satisfies ControlStatus['controlId'];

/**
 * The six etcd mutual-TLS credentials `configure-etcd-params` tests for, in the
 * order the shell tests them (configure-kubeapiserver.sh L21 and L26).
 *
 * Invariant locked: SIX, all-or-nothing. The shell requires every one of them
 * to be non-empty for the mutual-TLS branch and every one of them to be empty
 * for the fallback branch; any other combination is the partial branch, which
 * aborts. Rendering the list is what lets an operator see which of the three
 * branches their deployment is in.
 *
 * These are variable NAMES, never values. No credential material appears in
 * this tier (AAP §0.8.2, §0.11.1).
 */
export const ETCD_MTLS_CREDENTIAL_VARS = [
  'ETCD_APISERVER_CA_KEY',
  'ETCD_APISERVER_CA_CERT',
  'ETCD_APISERVER_SERVER_KEY',
  'ETCD_APISERVER_SERVER_CERT',
  'ETCD_APISERVER_CLIENT_KEY',
  'ETCD_APISERVER_CLIENT_CERT',
] as const;

/**
 * The environment variable that selects between the fail-closed branch and the
 * plaintext fallback (configure-kubeapiserver.sh L41).
 *
 * Both GCE reference profiles default it to `false` — measured at
 * cluster/gce/config-default.sh L446 and cluster/gce/config-test.sh L492, each
 * spelled `${ETCD_APISERVER_ALLOW_INSECURE:-false}` — and cluster/gce/util.sh
 * L1168 propagates it through `kube-env`, which together is F-008-RQ-002.
 */
export const ETCD_ALLOW_INSECURE_VAR = 'ETCD_APISERVER_ALLOW_INSECURE';

/**
 * One `kube-apiserver` flag the mutual-TLS branch appends, together with where
 * its value comes from and how the unit oracle measured it.
 */
export interface EtcdTransportFlag {
  /** The flag name, without a value — for example `--etcd-cafile`. */
  readonly flag: string;
  /**
   * The shell variable the flag's value is read from
   * (configure-kubeapiserver.sh L23-L25). Rendered so an operator can tell
   * which `kube-env` entry to fix.
   */
  readonly source: string;
  /**
   * The flag exactly as `TestTLSFlags` "mTLS enabled" measured it
   * (apiserver_etcd_test.go L180-L182). The right-hand sides are the Go
   * fixture's own placeholder strings — `CACertPath`, `APIServerCertPath`,
   * `APIServerKeyPath` (L169, L175-L176) — and are deliberately not
   * plausible-looking paths, so nothing here can be mistaken for a real
   * deployment value.
   */
  readonly measuredExample: string;
}

/** Identifier of one measured `configure-etcd-params` input. */
export type EtcdTransportScenarioId =
  | 'full-mtls'
  | 'no-certs-hardened'
  | 'allow-insecure'
  | 'unset-compat-default'
  | 'partial-credentials';

/**
 * One measured input to `configure-etcd-params` and everything the shell does
 * with it.
 *
 * Every member is transcribed from a numbered line of
 * cluster/gce/gci/configure-kubeapiserver.sh or
 * cluster/gce/gci/apiserver_etcd_test.go. Nothing is summarised, softened or
 * inferred: AAP §0.11.1 requires evidence over assumption, and the two
 * artifacts are frozen, so this file records them and never edits them.
 */
export interface EtcdTransportScenario {
  /** Stable identifier, also the `<select>` option value and `data-scenario`. */
  readonly id: EtcdTransportScenarioId;
  /** Short human-readable title; the article's accessible name. */
  readonly title: string;
  /** The input: which credentials are set, and how the toggle is set. */
  readonly condition: string;
  /**
   * The verdict this panel renders, under the semantics stated in the file
   * header. A scenario that produces a plaintext endpoint is never `pass`.
   */
  readonly verdict: ControlVerdict;
  /** Why that verdict, in one sentence an operator can act on. */
  readonly verdictReason: string;
  /**
   * The etcd endpoint the branch configures, or `null` when the branch aborts
   * before configuring one. `null` is a REPRESENTABLE value here, exactly as in
   * {@link ControlObservation}: "no endpoint" and "endpoint not reported" are
   * different facts and are rendered differently.
   */
  readonly endpoint: string | null;
  /** The `--etcd-servers` flag as rendered, or `null` when the branch aborts. */
  readonly etcdServersFlag: string | null;
  /** The mutual-TLS flag triple, empty for every branch that appends none. */
  readonly tlsFlags: readonly EtcdTransportFlag[];
  /**
   * The diagnostic the shell writes, verbatim and complete, or `null` when the
   * branch writes none. Verbatim because the operator searches for these words
   * in a boot log, and because AAP §0.10.2 lists the fail-closed message as a
   * boundary condition that must port unchanged.
   */
  readonly operatorMessage: string | null;
  /**
   * `1` when the branch calls `exit 1` (configure-kubeapiserver.sh L46, L50),
   * `null` when the function returns and `start-kube-apiserver` continues.
   */
  readonly exitCode: 1 | null;
  /** What the deployment ends up doing. */
  readonly outcome: string;
  /** The repository's own requirement identifiers this input covers. */
  readonly requirementIds: readonly string[];
  /** The caveat that stops this row from being read out of context. */
  readonly note: string;
}

/**
 * The mutual-TLS flag triple, transcribed from configure-kubeapiserver.sh
 * L23-L25 and measured by `TestTLSFlags` "mTLS enabled"
 * (apiserver_etcd_test.go L180-L182).
 *
 * Invariant locked: THREE flags, and the certificate-authority flag reads the
 * CA path while the client flags read the CLIENT paths. The shell reads
 * ETCD_APISERVER_CA_CERT_PATH for `--etcd-cafile` but
 * ETCD_APISERVER_CLIENT_CERT_PATH and ETCD_APISERVER_CLIENT_KEY_PATH for
 * `--etcd-certfile` and `--etcd-keyfile`; those are three different variables
 * and the pairing is not interchangeable.
 */
const ETCD_MTLS_FLAGS: readonly EtcdTransportFlag[] = [
  {
    flag: '--etcd-cafile',
    source: 'ETCD_APISERVER_CA_CERT_PATH',
    measuredExample: '--etcd-cafile=CACertPath',
  },
  {
    flag: '--etcd-certfile',
    source: 'ETCD_APISERVER_CLIENT_CERT_PATH',
    measuredExample: '--etcd-certfile=APIServerCertPath',
  },
  {
    flag: '--etcd-keyfile',
    source: 'ETCD_APISERVER_CLIENT_KEY_PATH',
    measuredExample: '--etcd-keyfile=APIServerKeyPath',
  },
];

/**
 * The diagnostic the plaintext-fallback branch writes
 * (configure-kubeapiserver.sh L43), verbatim.
 *
 * Shared by the two scenarios that reach that branch — the explicit opt-out and
 * the unset toggle — because the shell writes ONE message for both. Two copies
 * could drift apart and would misrepresent the script.
 */
const PLAINTEXT_FALLBACK_WARNING =
  'WARNING: ALL of ETCD_APISERVER_CA_KEY, ETCD_APISERVER_CA_CERT, ' +
  'ETCD_APISERVER_SERVER_KEY, ETCD_APISERVER_SERVER_CERT, ' +
  'ETCD_APISERVER_CLIENT_KEY and ETCD_APISERVER_CLIENT_CERT are missing, ' +
  'mTLS between etcd server and kube-apiserver is not enabled.';

/**
 * The plaintext endpoint both fallback scenarios configure (L42).
 *
 * Read from the shared domain module rather than written a second time, so the
 * literal has ONE definition site across the tier (AAP §0.5.5).
 */
const PLAINTEXT_ENDPOINT = ETCD_PLAINTEXT_ENDPOINT;

/** What the deployment does once the fallback branch has run. */
const PLAINTEXT_OUTCOME =
  'kube-apiserver starts and speaks plaintext to etcd over the loopback ' +
  'interface. The transport is not mutually authenticated.';

/**
 * The five measured inputs to `configure-etcd-params`, in the order the panel
 * renders them: the required posture first, then the fail-closed guarantee,
 * then the two plaintext branches, then the misconfiguration.
 *
 * The first four are the four scenarios Project Guide.md L139 records as
 * operationally verified — "hardened (no certs) → exit 1; dev
 * (ALLOW_INSECURE=true) → plaintext loopback; unset → unit-test-compat default;
 * full mTLS → https + --etcd-cafile/certfile/keyfile". The fifth, partial
 * credentials, is the branch AAP §0.4.2.1 singles out as the subtle one.
 *
 * Exported so that the paired spec can drive its assertions from the same
 * single definition site instead of restating the values, which is the property
 * AAP §0.5.5 requires of shared test data.
 */
export const ETCD_TRANSPORT_SCENARIOS: readonly EtcdTransportScenario[] = [
  {
    id: 'full-mtls',
    title: 'Full mutual TLS',
    condition:
      'All six etcd mutual-TLS credentials are set. The insecure-fallback ' +
      'toggle is not consulted on this branch.',
    verdict: 'pass',
    verdictReason:
      'The API-server-to-etcd transport is mutually authenticated over https, ' +
      'which is the required posture.',
    endpoint: ETCD_TLS_ENDPOINT,
    etcdServersFlag: `--etcd-servers=${ETCD_TLS_ENDPOINT}`,
    tlsFlags: ETCD_MTLS_FLAGS,
    operatorMessage: null,
    exitCode: null,
    outcome:
      'kube-apiserver starts with a mutually authenticated etcd client and no ' +
      'plaintext path is configured.',
    requirementIds: ['F-008-RQ-001'],
    note:
      'The endpoint shown is this branch default, ${ETCD_SERVERS:-https://127.0.0.1:2379} ' +
      '(configure-kubeapiserver.sh L22); a deployment that sets ETCD_SERVERS ' +
      'gets its own value, and TestTLSFlags sets it to this same string ' +
      '(apiserver_etcd_test.go L174).',
  },
  {
    id: 'no-certs-hardened',
    title: 'No credentials, hardened profile',
    condition:
      'None of the six credentials is set and ETCD_APISERVER_ALLOW_INSECURE is ' +
      'not "true" — which is the committed default on both GCE reference ' +
      'profiles.',
    verdict: 'pass',
    verdictReason:
      'The control fails closed. The boot aborts instead of downgrading, so no ' +
      'endpoint weaker than mutual TLS is ever configured.',
    endpoint: null,
    etcdServersFlag: null,
    tlsFlags: [],
    operatorMessage:
      'ERROR: ALL etcd mTLS credentials (ETCD_APISERVER_CA_KEY, ' +
      'ETCD_APISERVER_CA_CERT, ETCD_APISERVER_SERVER_KEY, ' +
      'ETCD_APISERVER_SERVER_CERT, ETCD_APISERVER_CLIENT_KEY, ' +
      'ETCD_APISERVER_CLIENT_CERT) are missing and ' +
      'ETCD_APISERVER_ALLOW_INSECURE is not set to true; refusing to fall back ' +
      'to plaintext etcd for a hardened profile. Provide etcd mTLS ' +
      'credentials, or set ETCD_APISERVER_ALLOW_INSECURE=true for local/dev.',
    exitCode: 1,
    outcome:
      'configure-etcd-params calls exit 1 and kube-apiserver never starts. The ' +
      'remedy is to provide the six credentials, not to relax the toggle.',
    requirementIds: ['F-008-RQ-002', 'F-008-RQ-003'],
    note:
      'This is the branch a profile-driven deployment takes when etcd ' +
      'certificates are absent, and it is the reason the plaintext fallback is ' +
      'disabled by default everywhere. Rendered as a pass because the ' +
      'requirement under test is the fail-closed guarantee itself, not the ' +
      'presence of mutual TLS.',
  },
  {
    id: 'allow-insecure',
    title: 'Plaintext fallback, explicitly opted in',
    condition:
      'None of the six credentials is set and ETCD_APISERVER_ALLOW_INSECURE is ' +
      'explicitly "true".',
    verdict: 'warn',
    verdictReason:
      'The transport is plaintext. The opt-out is documented for local and ' +
      'development use, so this is neither a clean pass nor a control failure.',
    endpoint: PLAINTEXT_ENDPOINT,
    etcdServersFlag: `--etcd-servers=${PLAINTEXT_ENDPOINT}`,
    tlsFlags: [],
    operatorMessage: PLAINTEXT_FALLBACK_WARNING,
    exitCode: null,
    outcome: PLAINTEXT_OUTCOME,
    requirementIds: ['F-008-RQ-002'],
    note:
      'Reachable only by overriding the profile default: both GCE reference ' +
      'profiles ship ETCD_APISERVER_ALLOW_INSECURE=false and ' +
      'cluster/gce/util.sh propagates it through kube-env.',
  },
  {
    id: 'unset-compat-default',
    title: 'Toggle unset — unit-test-compatibility default',
    condition:
      'None of the six credentials is set and ETCD_APISERVER_ALLOW_INSECURE is ' +
      'unset entirely, so the function-local ":-true" default in the shell ' +
      'takes effect (configure-kubeapiserver.sh L41).',
    verdict: 'warn',
    verdictReason:
      'The same plaintext transport as the explicit opt-out, reached without ' +
      'anyone opting in. A plaintext endpoint is never a clean pass.',
    endpoint: PLAINTEXT_ENDPOINT,
    etcdServersFlag: `--etcd-servers=${PLAINTEXT_ENDPOINT}`,
    tlsFlags: [],
    operatorMessage: PLAINTEXT_FALLBACK_WARNING,
    exitCode: null,
    outcome: PLAINTEXT_OUTCOME,
    requirementIds: ['F-008-RQ-002'],
    note:
      'NOT the intended production posture. The ":-true" default is a ' +
      'backward-compatibility shim for direct-invocation contexts that never ' +
      'load the GCE profiles — specifically the in-tree unit tests ' +
      'apiserver_etcd_test.go and apiserver_kms_test.go, which call the ' +
      'function with neither etcd credentials nor the hardened profile ' +
      'variables (configure-kubeapiserver.sh L36-L40). It is why TestTLSFlags ' +
      '"mTLS disabled" legitimately expects --etcd-servers=' +
      'http://127.0.0.1:2379 (apiserver_etcd_test.go L185-L188) while a ' +
      'hardened profile with no credentials still demands exit 1. Both are ' +
      'true at once and neither may be "fixed" into the other.',
  },
  {
    id: 'partial-credentials',
    title: 'Partial credentials',
    condition:
      'At least one of the six credentials is set and at least one is not — a ' +
      'half-configured deployment.',
    verdict: 'fail',
    verdictReason:
      'Mutual TLS cannot be established from an incomplete credential set, and ' +
      'no opt-out reaches this branch, so it is a failure and never a partial ' +
      'pass.',
    endpoint: null,
    etcdServersFlag: null,
    tlsFlags: [],
    operatorMessage:
      'ERROR: Some of ETCD_APISERVER_CA_KEY, ETCD_APISERVER_CA_CERT, ' +
      'ETCD_APISERVER_SERVER_KEY, ETCD_APISERVER_SERVER_CERT, ' +
      'ETCD_APISERVER_CLIENT_KEY and ETCD_APISERVER_CLIENT_CERT are missing, ' +
      'mTLS between etcd server and kube-apiserver cannot be enabled. Please ' +
      'provide all mTLS credential.',
    exitCode: 1,
    outcome:
      'configure-etcd-params calls exit 1 and kube-apiserver never starts. The ' +
      'deployment must supply every missing credential.',
    requirementIds: ['F-008-RQ-001', 'F-008-RQ-003'],
    note:
      'ETCD_APISERVER_ALLOW_INSECURE is read only on the all-absent branch ' +
      '(configure-kubeapiserver.sh L41), so setting it cannot turn a ' +
      'half-configured deployment into a plaintext boot. There is no silent ' +
      'downgrade available here, by design.',
  },
];

/**
 * The `<select>` value that shows every scenario instead of one.
 *
 * A literal type rather than a bare string so that {@link ScenarioFilter} stays
 * exact and no other string can be assigned to the filter state by mistake.
 */
const ALL_SCENARIOS = 'all' as const;

/** What the scenario filter may hold: the sentinel, or one scenario. */
type ScenarioFilter = typeof ALL_SCENARIOS | EtcdTransportScenarioId;

/**
 * Plain-language gloss for each verdict, keyed by the union in
 * web/src/hooks/useControlStatus.ts.
 *
 * Invariant locked: FOUR distinct outcomes, and the gloss for `warn` describes
 * neither a pass nor a fail. The verdict word itself is always rendered
 * alongside the gloss, so the outcome is legible as text and is never carried by
 * colour alone — which matters here because this tier ships no stylesheet at
 * all.
 *
 * `Record<ControlVerdict, string>` rather than a partial map: adding a verdict
 * upstream becomes a compile error here instead of a missing gloss at runtime.
 */
const VERDICT_DESCRIPTION: Record<ControlVerdict, string> = {
  pass: 'the control holds',
  fail: 'the control is violated',
  warn: 'permitted, and objected to',
  unknown: 'no trustworthy evidence was obtained',
};

/**
 * Occupies the required `refresh` member when a caller hands this panel a
 * pre-resolved {@link ControlStatus}.
 *
 * It intentionally performs no work, and that is the correct behaviour rather
 * than a gap: a pre-resolved status did not come from a request this panel
 * issued, so there is nothing for it to re-issue. It is also never the handler
 * the button calls — that branch resolves refresh availability from the caller's
 * own handler, so with no handler the button is DISABLED and carries a title
 * saying why, rather than looking operable and doing nothing.
 */
const NO_REFRESH_AVAILABLE = (): void => undefined;

/**
 * Renders one measured observation value as text.
 *
 * Invariant locked: NOTHING is rounded, truncated, re-scaled or re-parsed — the
 * value is surfaced as the server sent it — and no state renders as the bare
 * text `null`, `undefined` or an empty cell. An explicit `null` is a
 * REPRESENTABLE value in {@link ControlObservation} rather than a missing one,
 * so it is described rather than hidden, and an empty string is described for
 * the same reason.
 *
 * @param value - the observation value, verbatim from the wire.
 * @returns text safe to render in a table cell.
 */
function formatObservationValue(value: ControlObservation['value']): string {
  if (value === null) {
    return 'reported as null';
  }
  if (value === '') {
    return 'reported as an empty string';
  }
  return typeof value === 'string' ? value : String(value);
}

/** The scheme prefix a mutually authenticated etcd endpoint carries. */
const TLS_SCHEME = 'https://';

/** The scheme prefix a plaintext etcd endpoint carries. Never a pass. */
const PLAINTEXT_SCHEME = 'http://';

/** Shared empty list, so a payload with no observations allocates nothing. */
const NO_OBSERVATIONS: readonly ControlObservation[] = Object.freeze([]);

/**
 * Which branch of `configure-etcd-params` the reported evidence describes.
 *
 * The three input branches of the shell are `all`, `none` and `partial`
 * credentials, and the `none` branch splits on the opt-out, so four reachable
 * outcomes plus `indeterminate` for evidence that does not identify a branch at
 * all. Named after the outcome rather than the input, because the outcome is what
 * a reader has to act on.
 */
type EtcdBranch =
  | 'mutual-tls'
  | 'fail-closed'
  | 'permitted-plaintext'
  | 'partial-credentials'
  | 'indeterminate';

/**
 * One measured fact the V8 verdict rests on, and what became of it.
 *
 * `indeterminate` and `violated` are kept apart deliberately: the first is a gap in
 * the report and withholds a pass, the second is a finding and forces a failure.
 */
interface EtcdMeasurement {
  /** The observation identity, so a row cites exactly what it read. */
  readonly identity: string;
  /** What the measurement establishes, in a reader's words. */
  readonly title: string;
  /** The outcome. */
  readonly result: 'satisfied' | 'violated' | 'indeterminate';
  /** Why, in one sentence. */
  readonly detail: string;
}

/** Everything the panel derives from one payload's evidence. */
interface EtcdTransportEvidence {
  /** See {@link EtcdBranch}. */
  readonly branch: EtcdBranch;
  /** One row per measurement the branch requires. */
  readonly measurements: readonly EtcdMeasurement[];
  /** The verdict the evidence alone supports. */
  readonly verdict: EffectiveVerdict;
}

/** Builds one measurement row. */
function measurement(
  identity: string,
  title: string,
  result: EtcdMeasurement['result'],
  detail: string,
): EtcdMeasurement {
  return { identity, title, result, detail };
}

/**
 * Requires an observation to be a string beginning with `expected`.
 *
 * Reported `null` is a positive statement that no endpoint was configured, which is
 * correct on the two aborting branches and a violation on the mutual-TLS branch, so
 * it is distinguished from silence rather than folded into it.
 */
function requireEndpointScheme(
  observations: readonly ControlObservation[],
  expected: string,
  title: string,
): EtcdMeasurement {
  const identity = V8_OBSERVATIONS.etcdServers;
  const found = selectObservation(observations, identity);
  if (found.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', found.reason);
  }
  if (found.value.value === null) {
    return measurement(
      identity,
      title,
      'violated',
      'No endpoint was configured, so no mutually authenticated transport exists.',
    );
  }
  const endpoint = readString(observations, identity);
  if (endpoint.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', endpoint.reason);
  }
  if (endpoint.value.startsWith(expected)) {
    return measurement(
      identity,
      title,
      'satisfied',
      `The endpoint is addressed over ${expected.replace('://', '')}.`,
    );
  }
  return measurement(
    identity,
    title,
    'violated',
    endpoint.value.startsWith(PLAINTEXT_SCHEME)
      ? 'The endpoint is plaintext, so the transport is neither authenticated nor encrypted.'
      : 'The endpoint does not use the required scheme.',
  );
}

/** Requires the endpoint to be absent, which is what an aborting branch produces. */
function requireNoEndpoint(observations: readonly ControlObservation[]): EtcdMeasurement {
  const identity = V8_OBSERVATIONS.etcdServers;
  const title = 'no etcd endpoint was configured';
  const found = selectObservation(observations, identity);
  if (found.state === 'unreported') {
    return measurement(
      identity,
      title,
      'satisfied',
      'No endpoint was reported, which is consistent with a branch that aborts before ' +
        'configuring one.',
    );
  }
  if (found.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', found.reason);
  }
  if (found.value.value === null) {
    return measurement(identity, title, 'satisfied', 'The endpoint is explicitly absent.');
  }
  return measurement(
    identity,
    title,
    'violated',
    'An endpoint was configured on a branch that must abort before configuring one, so the ' +
      'deployment continued instead of failing closed.',
  );
}

/** Requires one of the three mutual-TLS flags to carry a path. */
function requireTlsFlag(
  observations: readonly ControlObservation[],
  identity: string,
): EtcdMeasurement {
  const title = `${identity} is supplied`;
  const found = selectObservation(observations, identity);
  if (found.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', found.reason);
  }
  if (found.value.value === null) {
    return measurement(
      identity,
      title,
      'violated',
      'The flag was reported as absent, so the transport is missing one of the three ' +
        'credentials mutual TLS requires.',
    );
  }
  const path = readString(observations, identity);
  if (path.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', path.reason);
  }
  return path.value.length > 0
    ? measurement(identity, title, 'satisfied', 'The flag carries a path.')
    : measurement(
        identity,
        title,
        'violated',
        'The flag was reported empty, which configures no credential at all.',
      );
}

/**
 * Requires the reported exit code to be exactly `expected`.
 *
 * THE PARTIAL-CREDENTIAL BRANCH IS THE SUBTLE ONE (AAP §0.10.2): a half-configured
 * deployment must exit 1 unconditionally, and the opt-out is not even consulted
 * there, so observing it continue is a distinct failure from observing plaintext
 * with no credentials at all.
 */
function requireExitCode(
  observations: readonly ControlObservation[],
  expected: number,
  title: string,
): EtcdMeasurement {
  const identity = V8_OBSERVATIONS.exitCode;
  const observed = readNumber(observations, identity);
  if (observed.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', observed.reason);
  }
  if (observed.value === expected) {
    return measurement(
      identity,
      title,
      'satisfied',
      `configure-etcd-params exited ${String(expected)}, as the branch requires.`,
    );
  }
  return measurement(
    identity,
    title,
    'violated',
    `configure-etcd-params exited ${String(observed.value)} where ${String(expected)} is ` +
      'required, so the boot did not behave as the control demands.',
  );
}

/** Requires the reported outcome word to be exactly `expected`. */
function requireOutcome(
  observations: readonly ControlObservation[],
  expected: string,
): EtcdMeasurement {
  const identity = V8_OBSERVATIONS.outcome;
  const title = `the reported outcome is ${expected}`;
  const found = selectObservation(observations, identity);
  if (found.state === 'unreported') {
    return measurement(identity, title, 'satisfied', 'The outcome was not reported separately.');
  }
  const observed = readString(observations, identity);
  if (observed.state !== 'reported') {
    return measurement(identity, title, 'indeterminate', observed.reason);
  }
  return observed.value === expected
    ? measurement(identity, title, 'satisfied', `The outcome is ${expected}.`)
    : measurement(
        identity,
        title,
        'violated',
        `The outcome is ${observed.value}, not ${expected}.`,
      );
}

/**
 * Reads which branch the evidence describes.
 *
 * `credentials supplied` is the discriminator, exactly as the shell's own `if` chain
 * is, and only the three words the shell can produce are recognised. Anything else —
 * a fourth word, a boolean, a duplicate, silence — is `indeterminate`, because a
 * branch this panel cannot name is one whose requirements it cannot check.
 */
function readBranch(observations: readonly ControlObservation[]): EtcdBranch {
  const credentials = readString(observations, V8_OBSERVATIONS.credentialsSupplied);
  if (credentials.state !== 'reported') {
    return 'indeterminate';
  }
  if (credentials.value === 'all') {
    return 'mutual-tls';
  }
  if (credentials.value === 'partial') {
    return 'partial-credentials';
  }
  if (credentials.value !== 'none') {
    return 'indeterminate';
  }
  const permitted = readBoolean(observations, V8_OBSERVATIONS.insecureFallbackPermitted);
  if (permitted.state !== 'reported') {
    return 'indeterminate';
  }
  return permitted.value ? 'permitted-plaintext' : 'fail-closed';
}

/**
 * Derives the V8 evidence verdict from the branch the payload describes.
 *
 * INVARIANT LOCKED, and it is the rule the whole panel is built around: A PLAINTEXT
 * ETCD ENDPOINT IS NEVER A PASS. The four branches and what each requires:
 *
 *   * `mutual-tls` — an `https` endpoint AND all three credential flags. This is the
 *     required posture, and it is the only branch that can be a pass on the strength
 *     of a configured endpoint.
 *   * `fail-closed` — exit 1, no endpoint, outcome `fail-closed`. A PASS for the
 *     control: refusing to start is F-008-RQ-003 working, not a regression. Exit 0
 *     here is a VIOLATION — it is the silent downgrade the control exists to
 *     prevent.
 *   * `partial-credentials` — exit 1 and no endpoint. Exit 0 is a violation, and no
 *     opt-out reaches this branch, so it is never a partial pass.
 *   * `permitted-plaintext` — WARN at best. The operator asked for it, so it is not a
 *     control failure, but the transport genuinely is unauthenticated and a warning
 *     is the strongest thing that can honestly be said.
 *
 * A plaintext endpoint observed on any OTHER branch is a failure, checked after the
 * branch requirements so that no branch can quietly permit one.
 */
function buildEtcdEvidence(observations: readonly ControlObservation[]): EtcdTransportEvidence {
  const branch = readBranch(observations);
  const readable = selectObservation(observations, V8_OBSERVATIONS.renderedCommandReadable);
  const measurements: EtcdMeasurement[] = [];

  if (readable.state !== 'unreported') {
    const flag = readBoolean(observations, V8_OBSERVATIONS.renderedCommandReadable);
    measurements.push(
      flag.state !== 'reported'
        ? measurement(
            V8_OBSERVATIONS.renderedCommandReadable,
            'the rendered API server command was legible',
            'indeterminate',
            flag.reason,
          )
        : measurement(
            V8_OBSERVATIONS.renderedCommandReadable,
            'the rendered API server command was legible',
            flag.value ? 'satisfied' : 'indeterminate',
            flag.value
              ? 'The command was read, so the etcd flags below were observed rather than assumed.'
              : 'The command was not readable, so no etcd flag was observed and the transport ' +
                'is unknown rather than assumed to be mutually authenticated.',
          ),
    );
  }

  if (branch === 'mutual-tls') {
    measurements.push(
      requireEndpointScheme(observations, TLS_SCHEME, `etcd is addressed over ${TLS_SCHEME}`),
      requireTlsFlag(observations, V8_OBSERVATIONS.etcdCaFile),
      requireTlsFlag(observations, V8_OBSERVATIONS.etcdCertFile),
      requireTlsFlag(observations, V8_OBSERVATIONS.etcdKeyFile),
      requireExitCode(observations, 0, 'the API server was allowed to start'),
    );
  } else if (branch === 'fail-closed') {
    measurements.push(
      requireExitCode(observations, 1, 'the boot aborted rather than downgrading'),
      requireNoEndpoint(observations),
      requireOutcome(observations, 'fail-closed'),
    );
  } else if (branch === 'partial-credentials') {
    measurements.push(
      requireExitCode(observations, 1, 'a half-configured deployment aborted the boot'),
      requireNoEndpoint(observations),
    );
  } else if (branch === 'permitted-plaintext') {
    measurements.push(
      requireEndpointScheme(
        observations,
        PLAINTEXT_SCHEME,
        'the explicitly permitted plaintext endpoint was configured',
      ),
      requireOutcome(observations, 'plaintext-loopback'),
    );
  } else {
    measurements.push(
      measurement(
        V8_OBSERVATIONS.credentialsSupplied,
        'the branch configure-etcd-params took is identified',
        'indeterminate',
        'The evidence does not identify which branch ran, so the requirements of a branch ' +
          'cannot be checked and no posture is confirmed.',
      ),
    );
  }

  const violated = measurements.some((entry) => entry.result === 'violated');
  const allSatisfied = measurements.every((entry) => entry.result === 'satisfied');
  let verdict: EffectiveVerdict;
  if (violated) {
    verdict = 'fail';
  } else if (branch === 'permitted-plaintext') {
    // Never a pass: the transport is unauthenticated even though it was asked for.
    verdict = allSatisfied ? 'warn' : 'unknown';
  } else {
    verdict = allSatisfied ? 'pass' : 'unknown';
  }

  // No separate "and a plaintext endpoint is never a pass" override is applied here,
  // and none is needed: every branch that can reach `pass` requires either an `https`
  // endpoint (`mutual-tls`) or the ABSENCE of one (`fail-closed`, `partial-credentials`),
  // so a plaintext endpoint is already a violation on each of them. An extra guard would
  // be an unreachable branch, which is worse than no guard because it cannot be tested.
  return { branch, measurements, verdict };
}

/**
 * The verdict this panel renders, which is not always the verdict the check
 * reported.
 *
 * INVARIANT LOCKED — A PASS MUST BE EARNED, and every rule only ever moves the
 * outcome in the safe direction:
 *
 *   1. A plaintext endpoint on a branch that must not produce one, a missing TLS
 *      flag, a partial credential set that did not exit 1, or a finding the check
 *      attached — each is a FAILURE, whatever verdict arrived.
 *   2. A reported pass is downgraded to UNKNOWN when the branch cannot be identified
 *      or its requirements were not all demonstrated. A payload reporting `pass` and
 *      nothing else has shown nothing.
 *   3. The explicitly permitted plaintext branch is a WARNING at best and can never
 *      be a pass, because the transport really is unauthenticated.
 *   4. Otherwise the STRICTEST of the reported verdict and the evidence verdict
 *      stands.
 *
 * Exported because the aggregate dashboard must count, filter and summarise the SAME
 * verdict this panel renders.
 *
 * @param control - the payload for this control, exactly as the hook parsed it.
 * @returns the verdict the panel renders for that payload.
 */
export function resolveEtcdTransportEffectiveVerdict(control: ControlStatus): EffectiveVerdict {
  const evidence = buildEtcdEvidence(control.evidence?.observations ?? NO_OBSERVATIONS);
  if (control.verdict === 'fail' || evidence.verdict === 'fail' || control.findings.length > 0) {
    return 'fail';
  }
  if (control.verdict === 'pass') {
    return evidence.verdict;
  }
  return strictestVerdict([control.verdict, evidence.verdict]);
}

/** How each measurement result opens its sentence. */
const MEASUREMENT_RESULT_WORDS: Record<EtcdMeasurement['result'], string> = {
  satisfied: 'Established:',
  violated: 'Violated:',
  indeterminate: 'Not established:',
};

/** Accessible name of the region holding the branch measurements. */
const BRANCH_EVIDENCE_LABEL = 'What this etcd transport verdict rests on';

/** How each branch is named in the rendered evidence region. */
const BRANCH_WORDS: Record<EtcdBranch, string> = {
  'mutual-tls': `all six credentials supplied, so etcd is addressed at ${ETCD_TLS_ENDPOINT}`,
  'fail-closed': 'credentials absent and the insecure fallback not permitted, so the boot aborts',
  'permitted-plaintext':
    'the insecure fallback explicitly permitted, so etcd is addressed at ' +
    ETCD_PLAINTEXT_ENDPOINT,
  'partial-credentials': 'credentials only partially supplied, which must abort the boot',
  indeterminate: 'not identified by the reported evidence',
};

/** Props of {@link EtcdTransportPanel}. */
export interface EtcdTransportPanelProps {
  /**
   * A pre-resolved hook state. When supplied, this panel renders it and issues
   * no request of its own, which is how a spec drives the loading, empty and
   * error states deterministically.
   */
  readonly result?: UseControlStatusResult;
  /**
   * A single pre-resolved control payload, as a shorthand for the successful
   * arm. Ignored when `result` is supplied, because `result` is the more
   * specific instruction.
   */
  readonly status?: ControlStatus;
  /**
   * Invoked by the re-request button INSTEAD of the hook's own `refresh`, never
   * alongside it, so one press is one request. When omitted, the button calls
   * whichever `refresh` the current state carries; when neither can re-request
   * anything the button is disabled and carries a title saying why.
   */
  readonly onRefresh?: () => void;
  /**
   * Whether refreshing can re-request anything at all.
   *
   * `false` disables this panel's refresh affordance and explains why, which is how an
   * aggregate surface that was handed its posture directly keeps every control's button
   * consistent with its own. Defaults to `true`, so a panel used on its own is unaffected.
   */
  readonly canRefresh?: boolean;
  /**
   * Show only this scenario initially instead of all five. The `<select>`
   * remains usable, so this is an initial value and not a lock.
   */
  readonly scenario?: EtcdTransportScenarioId;
}

/** Props shared by the presentational half of this module. */
interface EtcdTransportPanelViewProps {
  /** The state to render. Never fetched here. */
  readonly result: UseControlStatusResult;
  /** See {@link EtcdTransportPanelProps.onRefresh}. */
  readonly onRefresh?: () => void;
  /** See {@link EtcdTransportPanelProps.canRefresh}. */
  readonly canRefresh?: boolean;
  /** See {@link EtcdTransportPanelProps.scenario}. */
  readonly scenario?: EtcdTransportScenarioId;
}

/**
 * One reported violation.
 *
 * Every finding is rendered, never only the first: the Go oracle reports every
 * offender in a single run, and a list that stopped at one would hide the rest.
 */
function FindingItem({ finding }: { readonly finding: ControlFinding }): ReactElement {
  return (
    <li className="etcd-transport-panel__finding">
      {finding.message}
      {finding.subject !== undefined ? <> Object: {finding.subject}.</> : null}
      {finding.requirementId !== undefined ? <> Violates {finding.requirementId}.</> : null}
    </li>
  );
}

/**
 * The error affordance.
 *
 * Invariant locked: NO VERDICT IS REACHABLE FROM HERE. `ControlStatusError`
 * carries no control payload, so a 403 or a 500 renders this element and can
 * never render a pass. The server's own status code and reason are shown
 * verbatim, because "forbidden" and "the server broke" are different operator
 * problems with different remedies. `role="alert"` rather than a silent block,
 * so the failure is announced.
 */
function PostureError({ error }: { readonly error: ControlStatusError }): ReactElement {
  return (
    <div className="etcd-transport-panel__state" role="alert" data-state="error">
      <p>The etcd transport posture could not be read, so no verdict is shown.</p>
      <dl className="etcd-transport-panel__facts">
        <dt>Failure</dt>
        <dd>{error.kind}</dd>
        <dt>Message</dt>
        <dd>{error.message}</dd>
        {error.httpStatus !== undefined ? (
          <>
            <dt>HTTP status</dt>
            <dd>{error.httpStatus}</dd>
          </>
        ) : null}
        {error.reason !== undefined ? (
          <>
            <dt>Reason</dt>
            <dd>{error.reason}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * The reported posture for V8, once a trustworthy payload exists.
 *
 * Every value is surfaced as the server sent it. `evidence.observations` is the
 * only evidence member rendered, and deliberately so: it is the generic
 * label-and-value bag AAP §0.4.4 describes as carrying "a rendered etcd
 * transport flag", whereas `audiences`, `requestedTtlSeconds` and
 * `observedExpiry` describe issued credentials and belong to the V4 panel.
 * Rendering them here would invent evidence this control does not report.
 */
function PostureDetail({ control }: { readonly control: ControlStatus }): ReactElement {
  const observations = control.evidence?.observations;
  const evidence = buildEtcdEvidence(observations ?? NO_OBSERVATIONS);
  const verdict = resolveEtcdTransportEffectiveVerdict(control);
  return (
    <div className="etcd-transport-panel__posture" data-state="reported" data-verdict={verdict}>
      <p className="etcd-transport-panel__verdict">
        Verdict: <strong>{verdict}</strong> — {VERDICT_DESCRIPTION[verdict]}
      </p>
      {verdict === control.verdict ? null : (
        <p className="etcd-transport-panel__disagreement" data-disagreement={verdict}>
          {`The check reported ${control.verdict} for this control; the branch evidence below ` +
            `supports ${verdict}, and the weaker of the two is the verdict shown. A plaintext ` +
            'etcd endpoint is never a pass, partial credentials must abort the boot, and ' +
            'silence about a required flag is not evidence that it was supplied.'}
        </p>
      )}
      <section
        className="etcd-transport-panel__evidence-region"
        aria-label={BRANCH_EVIDENCE_LABEL}
        data-region="branch-evidence"
        data-branch={evidence.branch}
      >
        <p>{`Branch: ${BRANCH_WORDS[evidence.branch]}.`}</p>
        <dl className="etcd-transport-panel__measurements">
          {evidence.measurements.map((entry) => (
            <div key={entry.identity} data-measurement={entry.identity} data-result={entry.result}>
              <dt>{entry.title}</dt>
              <dd>{`${MEASUREMENT_RESULT_WORDS[entry.result]} ${entry.detail}`}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="etcd-transport-panel__summary">{control.summary}</p>
      {control.detail !== undefined ? <p>{control.detail}</p> : null}
      {control.requirementIds !== undefined && control.requirementIds.length > 0 ? (
        <p>Requirements covered: {control.requirementIds.join(', ')}</p>
      ) : null}
      {control.findings.length > 0 ? (
        <ul className="etcd-transport-panel__findings" aria-label="Reported findings">
          {control.findings.map((finding, index) => (
            <FindingItem key={`${String(index)}:${finding.subject ?? ''}`} finding={finding} />
          ))}
        </ul>
      ) : null}
      {control.warnings.length > 0 ? (
        <ul className="etcd-transport-panel__warnings" aria-label="Reported warnings">
          {control.warnings.map((warning, index) => (
            <li key={`${String(index)}:${warning}`}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {observations !== undefined && observations.length > 0 ? (
        <table className="etcd-transport-panel__evidence">
          <caption>Evidence reported for etcd transport</caption>
          <thead>
            <tr>
              <th scope="col">Measurement</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {observations.map((observation, index) => (
              <tr key={`${String(index)}:${observation.label}`}>
                <th scope="row">{observation.label}</th>
                <td>{formatObservationValue(observation.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {control.observedAt !== undefined ? (
        <p>
          Observed at <time dateTime={control.observedAt}>{control.observedAt}</time>.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Chooses between the four separately observable states of the posture request:
 * loading, error, empty and reported.
 *
 * Invariant locked: the ONLY path to a verdict runs through a successful payload
 * that actually mentions V8. A payload that omits the control renders the empty
 * affordance, never a pass — the Go oracle pairs every negative assertion with a
 * positive control for exactly this reason, and a surface that cannot tell "no
 * evidence" from "good evidence" also reports success when the whole stack is
 * broken.
 */
function ReportedPosture({ result }: { readonly result: UseControlStatusResult }): ReactElement {
  if (result.status === 'loading') {
    return (
      <p className="etcd-transport-panel__state" role="status" data-state="loading">
        Reading the etcd transport posture…
      </p>
    );
  }
  if (result.status === 'error') {
    return <PostureError error={result.error} />;
  }
  const control = selectControlStatus(result.controls, ETCD_TRANSPORT_CONTROL_ID);
  if (control === undefined) {
    return (
      <p className="etcd-transport-panel__state" role="status" data-state="empty">
        {result.isEmpty
          ? 'The server reported no control posture at all, so there is no etcd transport verdict to show.'
          : 'The server reported other controls but not etcd transport, so there is no verdict to show.'}
      </p>
    );
  }
  return <PostureDetail control={control} />;
}

/**
 * One measured `configure-etcd-params` input, rendered as an individually
 * addressable article.
 *
 * `<article aria-labelledby>` gives every scenario its own accessible name, so
 * each one is reachable by role and name whether all five are shown or the
 * filter has narrowed to one. `data-scenario` and `data-verdict` are styling and
 * telemetry hooks, not the accessible contract.
 */
function ScenarioArticle({ scenario }: { readonly scenario: EtcdTransportScenario }): ReactElement {
  const headingId = useId();
  return (
    <article
      className="etcd-transport-panel__scenario"
      aria-labelledby={headingId}
      data-scenario={scenario.id}
      data-verdict={scenario.verdict}
    >
      <h4 id={headingId}>{scenario.title}</h4>
      <dl className="etcd-transport-panel__facts">
        <dt>Verdict</dt>
        <dd>
          <strong>{scenario.verdict}</strong> — {scenario.verdictReason}
        </dd>
        <dt>Condition</dt>
        <dd>{scenario.condition}</dd>
        <dt>etcd endpoint</dt>
        <dd>
          {scenario.endpoint === null ? (
            'None — the boot aborts before an endpoint is configured.'
          ) : (
            <code>{scenario.endpoint}</code>
          )}
        </dd>
        <dt>Rendered flags</dt>
        <dd>
          {scenario.etcdServersFlag === null ? (
            'None — configure-etcd-params appends no flag on this branch.'
          ) : (
            <ul className="etcd-transport-panel__flags">
              <li>
                <code>{scenario.etcdServersFlag}</code>
              </li>
              {scenario.tlsFlags.map((flag) => (
                <li key={flag.flag}>
                  <code>{flag.measuredExample}</code> — <code>{flag.flag}</code> read from{' '}
                  <code>{flag.source}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Exit status</dt>
        <dd>
          {scenario.exitCode === null
            ? 'The function returns and start-kube-apiserver continues.'
            : `exit ${String(scenario.exitCode)} — kube-apiserver never starts.`}
        </dd>
        <dt>Outcome</dt>
        <dd>{scenario.outcome}</dd>
        <dt>Operator message</dt>
        <dd>
          {scenario.operatorMessage === null ? (
            'None — this branch writes no diagnostic.'
          ) : (
            <samp>{scenario.operatorMessage}</samp>
          )}
        </dd>
        <dt>Requirements</dt>
        <dd>{scenario.requirementIds.join(', ')}</dd>
        <dt>Note</dt>
        <dd>{scenario.note}</dd>
      </dl>
    </article>
  );
}

/**
 * The whole panel, given a state to render.
 *
 * This is the presentational half: it never fetches, so every state it can show
 * is reachable from a prop, which is what makes the loading, empty and error
 * affordances testable without a network.
 *
 * Accessibility contract:
 *   * The panel is a landmark — `<section aria-labelledby>` resolves to a region
 *     with an accessible name — and so is each of its three parts, so a reader
 *     can jump between them.
 *   * Headings run h2 (panel) then h3 (part) then h4 (scenario), with no level
 *     skipped. The panel expects to sit under a page-level h1; the aggregate
 *     dashboard supplies one.
 *   * Every control is a native element: a `<button type="button">` for the
 *     re-request and a labelled `<select>` for the scenario filter, both
 *     keyboard-operable with no key handling of our own.
 *   * The state paragraphs carry `role="status"`, and the error block
 *     `role="alert"`, so a state change is announced rather than silent.
 *   * `aria-busy` marks the posture part while a request is in flight. The
 *     button is never disabled, so it stays reachable in every state.
 */
function EtcdTransportPanelView({
  result,
  onRefresh,
  canRefresh = true,
  scenario,
}: EtcdTransportPanelViewProps): ReactElement {
  // ONE refresh channel, resolved once and used for BOTH the click handler and the
  // disabled state, so the two can never disagree.
  const refresh = resolveRefreshHandler(onRefresh, result.refresh, canRefresh);
  const idPrefix = useId();
  const panelHeadingId = `${idPrefix}-panel`;
  const postureHeadingId = `${idPrefix}-posture`;
  const inputsHeadingId = `${idPrefix}-inputs`;
  const scenariosHeadingId = `${idPrefix}-scenarios`;
  const filterId = `${idPrefix}-scenario-filter`;

  // The filter starts wherever the caller asked, and stays user-controlled
  // afterwards: `scenario` is an initial value, not a lock.
  const [visibleScenario, setVisibleScenario] = useState<ScenarioFilter>(
    scenario ?? ALL_SCENARIOS,
  );

  // Resolved from the scenario roster rather than cast from the event, so the
  // filter can only ever hold a value the roster actually defines and no
  // unreachable defensive branch is needed to prove it.
  const handleScenarioChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const selected = ETCD_TRANSPORT_SCENARIOS.find(
      (candidate) => candidate.id === event.target.value,
    );
    setVisibleScenario(selected === undefined ? ALL_SCENARIOS : selected.id);
  };

  const visibleScenarios =
    visibleScenario === ALL_SCENARIOS
      ? ETCD_TRANSPORT_SCENARIOS
      : ETCD_TRANSPORT_SCENARIOS.filter((candidate) => candidate.id === visibleScenario);

  return (
    <section className="etcd-transport-panel" aria-labelledby={panelHeadingId}>
      <h2 id={panelHeadingId}>V8 — etcd mutual-TLS transport</h2>
      <p>
        The kube-apiserver-to-etcd transport must be mutually authenticated, and a
        deployment that cannot authenticate it must fail closed rather than fall back to
        plaintext.
      </p>
      <p>Requirements covered: F-008-RQ-001, F-008-RQ-002, F-008-RQ-003.</p>

      <section
        className="etcd-transport-panel__reported"
        aria-labelledby={postureHeadingId}
        aria-busy={result.status === 'loading'}
      >
        <h3 id={postureHeadingId}>Reported posture</h3>
        <ReportedPosture result={result} />
        <button
          className="etcd-transport-panel__refresh"
          type="button"
          onClick={refresh}
          disabled={refresh === undefined}
          title={refresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
        >
          Re-read etcd transport posture
        </button>
      </section>

      <section className="etcd-transport-panel__inputs" aria-labelledby={inputsHeadingId}>
        <h3 id={inputsHeadingId}>What configure-etcd-params reads</h3>
        <p>
          All six credentials must be set for the mutual-TLS branch, and all six must be
          absent for the fallback branch. Any other combination is the partial branch,
          which aborts the boot.
        </p>
        <ul className="etcd-transport-panel__credentials" aria-label="etcd mutual-TLS credentials">
          {ETCD_MTLS_CREDENTIAL_VARS.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p>
          Insecure-fallback toggle: <code>{ETCD_ALLOW_INSECURE_VAR}</code>, committed as{' '}
          <code>false</code> on both GCE reference profiles and consulted only when all six
          credentials are absent.
        </p>
      </section>

      <section className="etcd-transport-panel__scenarios" aria-labelledby={scenariosHeadingId}>
        <h3 id={scenariosHeadingId}>Measured behaviour of configure-etcd-params</h3>
        <p>
          Each scenario reports whether the shipped generator behaved as the requirement
          demands for that input, not whether the deployment ended up speaking mutual TLS. A
          scenario that produces a plaintext endpoint is never a pass, and partial
          credentials are a failure rather than a partial pass.
        </p>
        <p className="etcd-transport-panel__filter">
          <label htmlFor={filterId}>Scenario</label>{' '}
          <select id={filterId} value={visibleScenario} onChange={handleScenarioChange}>
            <option value={ALL_SCENARIOS}>All scenarios</option>
            {ETCD_TRANSPORT_SCENARIOS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </p>
        <ul className="etcd-transport-panel__scenario-list" aria-label="etcd transport scenarios">
          {visibleScenarios.map((candidate) => (
            <li key={candidate.id}>
              <ScenarioArticle scenario={candidate} />
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

/**
 * The panel wired to its own data source.
 *
 * Rendered only when no pre-resolved state was supplied, which is why the hook
 * call lives in this component rather than in the default export: a component is
 * either always calling its hooks or not rendered at all, so nothing here can
 * change hook order between renders.
 */
function ConnectedEtcdTransportPanel({
  onRefresh,
  canRefresh,
  scenario,
}: Omit<EtcdTransportPanelViewProps, 'result'>): ReactElement {
  const result = useControlStatus(ETCD_TRANSPORT_CONTROL_ID);
  return (
    <EtcdTransportPanelView
      result={result}
      onRefresh={onRefresh}
      canRefresh={canRefresh}
      scenario={scenario}
    />
  );
}

/**
 * The React presentation surface for V8 — etcd mutual-TLS transport.
 *
 * Renders whichever state it is given, or reads the posture itself when given
 * none, and always renders the five measured `configure-etcd-params` scenarios
 * alongside it.
 *
 * ```tsx
 * <EtcdTransportPanel />                                  // reads V8 itself
 * <EtcdTransportPanel status={reportedV8} />              // pre-resolved
 * <EtcdTransportPanel result={{ status: 'loading', refresh }} />
 * <EtcdTransportPanel scenario="partial-credentials" />   // one scenario
 * ```
 *
 * INVARIANTS LOCKED BY THIS COMPONENT:
 *
 *   1. A plaintext etcd endpoint is never rendered as a pass, and partial
 *      credentials are rendered as a failure rather than a partial pass.
 *   2. A transport or contract failure — 403 and 500 included — renders the
 *      error affordance, and no verdict is reachable from it.
 *   3. A successful payload that does not mention this control renders the empty
 *      affordance, never a pass.
 *   4. No request is issued from this file. Data access belongs to
 *      `useControlStatus`, and supplying `result` or `status` suppresses the
 *      request entirely.
 *
 * @param props - see {@link EtcdTransportPanelProps}. All members are optional.
 * @returns the rendered panel.
 */
export default function EtcdTransportPanel({
  result,
  status,
  onRefresh,
  canRefresh = true,
  scenario,
}: EtcdTransportPanelProps): ReactElement {
  if (result !== undefined) {
    return (
      <EtcdTransportPanelView
        result={result}
        onRefresh={onRefresh}
        canRefresh={canRefresh}
        scenario={scenario}
      />
    );
  }
  if (status !== undefined) {
    // The successful arm, built around exactly the payload supplied. `isEmpty`
    // is false because one control is present, which keeps the shorthand
    // indistinguishable from a real single-control response.
    const resolved: UseControlStatusResult = {
      status: 'success',
      controls: [status],
      isEmpty: false,
      refresh: NO_REFRESH_AVAILABLE,
    };
    // A payload handed over directly owns no request, so ONLY an explicit handler
    // can refresh it; without one the affordance is disabled and explained.
    return (
      <EtcdTransportPanelView
        result={resolved}
        onRefresh={onRefresh}
        canRefresh={canRefresh && onRefresh !== undefined}
        scenario={scenario}
      />
    );
  }
  return (
    <ConnectedEtcdTransportPanel
      onRefresh={onRefresh}
      canRefresh={canRefresh}
      scenario={scenario}
    />
  );
}
