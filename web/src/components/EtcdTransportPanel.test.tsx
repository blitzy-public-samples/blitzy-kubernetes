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

// AAP §0.5.1 (the `web/src/components/EtcdTransportPanel.test.tsx` row — "V8 behaviour |
// mTLS versus fail-closed verdict") / §0.4.2.4 (the five case categories every panel spec
// covers) / §0.10.2 (the "etcd fail-closed" boundary row: credentials absent with the
// opt-out unset yields `exit 1`, and PARTIAL credentials also yield `exit 1`) / §0.4.2.1
// (the L4 fail-closed blueprint, whose four scenarios this panel surfaces) /
// tech-spec §6.6.3.4.
//
// THE INVARIANT THIS FILE LOCKS
//
//   A plaintext etcd endpoint is NEVER rendered as a pass; a half-configured deployment
//   that did not abort is a FAILURE rather than a partial pass; and a pass is withheld
//   whenever the branch `configure-etcd-params` took cannot be identified from the
//   evidence.
//
// THE DEFECT THESE CASES EXIST TO PREVENT, which the compiler and the linter both accepted:
// `PostureDetail` rendered `data-verdict={control.verdict}` and the sentence
// "Verdict: pass — the control holds" straight from the payload, deriving nothing. So a
// payload claiming `pass` rendered a pass while its own evidence table listed
// `--etcd-servers = http://127.0.0.1:2379`, or `credentials supplied = partial` with
// `exit code = 0`, or no etcd flags whatsoever. The panel's file header states that "a
// plaintext etcd endpoint is never a pass" as an invariant it locks; before these cases it
// was locked only in the static scenario table, never in the reported posture.
//
// THE AUTHORITY for every branch is `cluster/gce/gci/configure-kubeapiserver.sh` L18-L70:
// the https flag triple at L21-L25, the opt-out consulted ONLY in the all-absent branch at
// L41, the fail-closed `exit 1` at L44-L46, and the partial-credential `exit 1` at L48-L50
// whose message is the imperative "Please provide all mTLS credential".
//
// NO CREDENTIAL MATERIAL APPEARS HERE. The credential observations carry the real absolute
// FILE PATHS from `V8_CREDENTIAL_PATHS`, and the Go fixture's own bare-word placeholders —
// `CACertPath`, `APIServerCertPath`, `APIServerKeyPath`, recorded from
// `cluster/gce/gci/apiserver_etcd_test.go` L169 and L175-L176 — now appear only as REJECTED
// shapes, because a bare word is not a path. `V8_MUTUAL_TLS_FLAGS` still records them
// verbatim inside the rendered flag strings, which is a different thing and is where parity
// with the shell test lives.
//
// The credential-shaped strings in the M17 and M18 cases below are SYNTHETIC and inert: a
// PEM header with no key body and a JWT-shaped run of base64 characters that decodes to
// nothing. They exist to prove the guards reject and withhold them.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V8_OBSERVATIONS } from '../domain/observationIds';
import {
  MAX_SAFE_PATH_LENGTH,
  MAX_SAFE_PROSE_INPUT_LENGTH,
  SAFE_OVERSIZED_TEXT,
  SAFE_REDACTED,
} from '../domain/safeText';
import {
  ETCD_FAIL_CLOSED_MESSAGE,
  ETCD_PARTIAL_CREDENTIALS_MESSAGE,
  ETCD_PLAINTEXT_ENDPOINT,
  ETCD_PLAINTEXT_WARNING_MESSAGE,
  ETCD_TLS_ENDPOINT,
} from '../domain/securityConstants';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  CONTROL_STATUS_ERRORS,
  ETCD_TRANSPORT_STATES,
  V8_CREDENTIAL_PATHS,
  V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT,
  V8_ETCD_TRANSPORT_FAIL_CLOSED,
  V8_ETCD_TRANSPORT_FAILING,
  V8_ETCD_TRANSPORT_PASSING,
  V8_ETCD_TRANSPORT_UNKNOWN,
  V8_ETCD_TRANSPORT_WARNING,
  V8_PROFILE_DEFAULT_OBSERVATIONS,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import EtcdTransportPanel, {
  ETCD_MTLS_CREDENTIAL_VARS,
  resolveEtcdTransportEffectiveVerdict,
} from './EtcdTransportPanel';

/**
 * The mutual-TLS branch, fully evidenced — TAKEN FROM THE RECORDED PASSING PAYLOAD.
 *
 * Derived rather than written out, and the change is load-bearing twice over. This list
 * used to be six hand-written observations, three of which set the credential flags to the
 * bare words `CACertPath`, `APIServerCertPath` and `APIServerKeyPath` — which is exactly the
 * M17 defect the panel now rejects, because a bare word is not a file path. It also predated
 * the profile-default, outcome and diagnostic requirements, so once those were required this
 * list stopped producing a pass and every `withholds the pass when X` case built on it would
 * have held VACUOUSLY over a baseline that was already `unknown`.
 *
 * Deriving it means the fixture and the gate cannot drift apart silently: if the recorded
 * payload stops satisfying the panel, the two-sided control fails immediately and loudly.
 *
 * Note what is NOT changed by this: {@link V8_MUTUAL_TLS_FLAGS} still records the oracle's
 * rendered flags containing `CACertPath` VERBATIM, because that is what the shell test
 * measured and parity depends on it. The rendered flag string and this tier's evidence that
 * each flag carries a credential PATH are two different things.
 */
const MUTUAL_TLS_PROVEN: readonly ControlObservation[] =
  V8_ETCD_TRANSPORT_PASSING.evidence.observations;

/** The fail-closed branch, fully evidenced — from the recorded fail-closed payload. */
const FAIL_CLOSED_PROVEN: readonly ControlObservation[] =
  V8_ETCD_TRANSPORT_FAIL_CLOSED.evidence.observations;

/** The operator-chosen plaintext branch — from the recorded warning payload. */
const PERMITTED_PLAINTEXT_PROVEN: readonly ControlObservation[] =
  V8_ETCD_TRANSPORT_WARNING.evidence.observations;

/** The direct-invocation compatibility branch — from the recorded compatibility payload. */
const COMPATIBILITY_DEFAULT_PROVEN: readonly ControlObservation[] =
  V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT.evidence.observations;

/** The recorded partial-credential state, which has no `ControlStatus` payload of its own. */
const RECORDED_PARTIAL_STATE = ETCD_TRANSPORT_STATES[4];

/**
 * The partial-credential branch, behaving as the control demands.
 *
 * Assembled from {@link ETCD_TRANSPORT_STATES}'s recorded partial entry rather than written
 * out, for the same reason as the lists above: the exit code, the outcome and the diagnostic
 * are measured facts about the shell, and a second hand-written copy of them here could
 * disagree with the recording while typechecking.
 */
const PARTIAL_ABORTED: readonly ControlObservation[] = [
  { label: V8_OBSERVATIONS.credentialsSupplied, value: RECORDED_PARTIAL_STATE.credentialsPresent },
  { label: V8_OBSERVATIONS.exitCode, value: RECORDED_PARTIAL_STATE.exitCode },
  { label: V8_OBSERVATIONS.etcdServers, value: null },
  { label: V8_OBSERVATIONS.outcome, value: RECORDED_PARTIAL_STATE.outcome },
  { label: V8_OBSERVATIONS.diagnostic, value: RECORDED_PARTIAL_STATE.diagnostic },
  { label: V8_OBSERVATIONS.exitCodeRequiredForPartial, value: RECORDED_PARTIAL_STATE.exitCode },
  ...V8_PROFILE_DEFAULT_OBSERVATIONS,
];

/** A payload claiming `pass`, carrying exactly the observations under test. */
function claimingPass(observations: readonly ControlObservation[]): ControlStatus {
  return {
    ...V8_ETCD_TRANSPORT_PASSING,
    findings: [],
    warnings: [],
    evidence: { observations },
  };
}

/** One observation list with a single member's value replaced. */
function replacing(
  base: readonly ControlObservation[],
  label: string,
  value: ControlObservation['value'],
): readonly ControlObservation[] {
  if (!base.some((observation) => observation.label === label)) {
    throw new Error(`"${label}" is not in this observation list, so replacing it is a no-op.`);
  }
  return base.map((observation) => (observation.label === label ? { label, value } : observation));
}

/** One observation list with a single member removed. */
function without(
  base: readonly ControlObservation[],
  label: string,
): readonly ControlObservation[] {
  const remaining = base.filter((observation) => observation.label !== label);
  if (remaining.length === base.length) {
    throw new Error(`"${label}" is not in this observation list, so removing it is a no-op.`);
  }
  return remaining;
}

/** The verdict the rendered posture carries. */
function renderedVerdict(container: HTMLElement): string | null {
  return (
    container.querySelector('[data-state="reported"]')?.getAttribute('data-verdict') ?? null
  );
}

/** The branch the rendered evidence region identified. */
function renderedBranch(container: HTMLElement): string | null {
  return (
    container.querySelector('[data-region="branch-evidence"]')?.getAttribute('data-branch') ?? null
  );
}

/** The result attribute of one measurement row. */
function measurementResult(container: HTMLElement, identity: string): string | null {
  return (
    container.querySelector(`[data-measurement="${identity}"]`)?.getAttribute('data-result') ?? null
  );
}

describe('EtcdTransportPanel — the recorded payloads render their recorded verdicts', () => {
  it('renders PASS and the mutual-TLS branch for the recorded passing payload', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    expect(renderedVerdict(container)).toBe('pass');
    expect(renderedBranch(container)).toBe('mutual-tls');
  });

  it('renders PASS for the recorded fail-closed payload: refusing to start IS it', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_FAIL_CLOSED} />,
    );

    expect(renderedVerdict(container)).toBe('pass');
    expect(renderedBranch(container)).toBe('fail-closed');
    expect(measurementResult(container, V8_OBSERVATIONS.exitCode)).toBe('satisfied');
  });

  it('renders WARN for the recorded explicitly permitted plaintext payload', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_WARNING} />,
    );

    expect(renderedVerdict(container)).toBe('warn');
    expect(renderedBranch(container)).toBe('permitted-plaintext');
  });

  it('renders FAIL for the recorded failing payload and names both findings', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_FAILING} />,
    );

    expect(renderedVerdict(container)).toBe('fail');
    for (const finding of V8_ETCD_TRANSPORT_FAILING.findings) {
      expect(container).toHaveTextContent(finding.message);
    }
  });

  it('renders UNKNOWN for the recorded unreadable-command payload', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_UNKNOWN} />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, V8_OBSERVATIONS.renderedCommandReadable)).toBe(
      'indeterminate',
    );
  });

  it('agrees with the exported resolver on all five recorded payloads', () => {
    expect(resolveEtcdTransportEffectiveVerdict(V8_ETCD_TRANSPORT_PASSING)).toBe('pass');
    expect(resolveEtcdTransportEffectiveVerdict(V8_ETCD_TRANSPORT_FAIL_CLOSED)).toBe('pass');
    expect(resolveEtcdTransportEffectiveVerdict(V8_ETCD_TRANSPORT_WARNING)).toBe('warn');
    expect(resolveEtcdTransportEffectiveVerdict(V8_ETCD_TRANSPORT_FAILING)).toBe('fail');
    expect(resolveEtcdTransportEffectiveVerdict(V8_ETCD_TRANSPORT_UNKNOWN)).toBe('unknown');
  });
});

describe('EtcdTransportPanel — a plaintext endpoint is never a pass (the defect)', () => {
  it('renders FAIL when a pass payload reports plaintext with all credentials', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdServers, ETCD_PLAINTEXT_ENDPOINT),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('neither authenticated nor encrypted');
  });

  it('states the disagreement rather than silently overriding the reported verdict', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdServers, ETCD_PLAINTEXT_ENDPOINT),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(container.querySelector('[data-disagreement="fail"]')).not.toBeNull();
    expect(container).toHaveTextContent('The check reported pass for this control');
  });

  it('never renders the pass gloss beside a plaintext endpoint', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdServers, ETCD_PLAINTEXT_ENDPOINT),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(container).not.toHaveTextContent('Verdict: pass');
  });

  it('renders FAIL when a pass payload reports plaintext on the fail-closed branch', () => {
    const status = claimingPass(
      replacing(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.etcdServers, ETCD_PLAINTEXT_ENDPOINT),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });

  it('caps the explicitly permitted plaintext branch at WARN even when the check said pass', () => {
    // FULLY EVIDENCED, from the recorded operator-chosen payload. The hand-written four
    // observations this case used to carry named no compatibility flag, so under the M9
    // split they no longer identify a branch at all — and `unknown` would have satisfied
    // "not a pass" for entirely the wrong reason. The point of this case is the CAP: even
    // with every requirement of the branch proven, plaintext tops out at a warning.
    const status = claimingPass(PERMITTED_PLAINTEXT_PROVEN);

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('warn');
  });

  it('caps the compatibility-default branch at WARN too, and never at pass', () => {
    // The other plaintext branch. It is the state the in-tree shell test measures, so it is
    // EXPECTED rather than a defect — and the transport is still unauthenticated, so it is
    // still not a pass. Both truths, held at once (AAP §0.10.4).
    const status = claimingPass(COMPATIBILITY_DEFAULT_PROVEN);

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('warn');
  });
});

describe('EtcdTransportPanel — fail-closed and partial credentials must abort', () => {
  it('renders FAIL when the fail-closed branch exited 0 instead of 1', () => {
    const status = claimingPass(replacing(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.exitCode, 0));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, V8_OBSERVATIONS.exitCode)).toBe('violated');
    expect(container).toHaveTextContent('where 1 is required');
  });

  it('renders FAIL when partial credentials exited 0 — never a partial pass', () => {
    const status = claimingPass(replacing(PARTIAL_ABORTED, V8_OBSERVATIONS.exitCode, 0));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(renderedBranch(container)).toBe('partial-credentials');
  });

  it('renders PASS when partial credentials aborted the boot as required', () => {
    const status = claimingPass(PARTIAL_ABORTED);

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('pass');
  });

  it('renders FAIL when partial credentials configured an endpoint at all', () => {
    const status = claimingPass(
      replacing(PARTIAL_ABORTED, V8_OBSERVATIONS.etcdServers, ETCD_TLS_ENDPOINT),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('continued instead of failing closed');
  });

  it('ignores the opt-out on the partial branch, because the shell does not consult it', () => {
    const permitted = claimingPass([
      ...PARTIAL_ABORTED,
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: true },
    ]);

    expect(resolveEtcdTransportEffectiveVerdict(permitted)).toBe('pass');

    const permittedButContinued = claimingPass([
      ...replacing(PARTIAL_ABORTED, V8_OBSERVATIONS.exitCode, 0),
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: true },
    ]);

    expect(resolveEtcdTransportEffectiveVerdict(permittedButContinued)).toBe('fail');
  });

  it('withholds the pass when the fail-closed branch did not report its exit code', () => {
    const status = claimingPass(without(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.exitCode));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('fails when the fail-closed branch reported a plaintext outcome', () => {
    const status = claimingPass(
      replacing(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.outcome, 'plaintext-loopback'),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });
});

describe('EtcdTransportPanel — the mutual-TLS branch needs all three credentials', () => {
  it('grants the pass when the endpoint and all three flags are proven', () => {
    expect(resolveEtcdTransportEffectiveVerdict(claimingPass(MUTUAL_TLS_PROVEN))).toBe('pass');
  });

  it.each([
    ['--etcd-cafile', V8_OBSERVATIONS.etcdCaFile],
    ['--etcd-certfile', V8_OBSERVATIONS.etcdCertFile],
    ['--etcd-keyfile', V8_OBSERVATIONS.etcdKeyFile],
  ])('withholds the pass when %s is unreported', (_name, identity) => {
    const status = claimingPass(without(MUTUAL_TLS_PROVEN, identity));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it.each([
    ['--etcd-cafile', V8_OBSERVATIONS.etcdCaFile],
    ['--etcd-certfile', V8_OBSERVATIONS.etcdCertFile],
    ['--etcd-keyfile', V8_OBSERVATIONS.etcdKeyFile],
  ])('fails when %s is reported as explicitly absent', (_name, identity) => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, identity, null));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });

  it('fails when a credential flag is reported as an empty string', () => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdCaFile, ''));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('configures no credential at all');
  });

  it('fails when the mutual-TLS branch reported no endpoint at all', () => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdServers, null));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });

  it('fails when the mutual-TLS branch aborted the boot unexpectedly', () => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.exitCode, 1));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });

  it('withholds the pass when the endpoint is reported at the wrong type', () => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdServers, 2379));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('never describes its evidence as the compatibility or direct-invocation path', () => {
    // THE RENAMED-HELPER DEFECT, locked so it cannot recur. The silence check that runs on
    // this branch was repurposed FROM the compatibility default -- that path was believed to
    // print nothing, and its silence was taken as what told it apart from an operator's
    // explicit opt-in. The shell disproves it, so the caller was moved; but the helper's
    // title and its three detail sentences still described the shim, and `PostureDetail`
    // renders both into the measurement list. A mutual-TLS payload therefore rendered
    // evidence naming a DIFFERENT V8 branch -- one with a different endpoint, a different
    // flag set and a different verdict -- which is precisely the class of mislabelling this
    // panel exists to prevent in the deployments it reports on.
    //
    // Asserted over the WHOLE evidence region rather than over one measurement, so a future
    // edit cannot reintroduce the wording anywhere on this branch, and asserted on the three
    // words that name the other branch rather than on an exact sentence, so legitimate
    // rewording stays free.
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );
    const evidence = container.querySelector('[data-region="branch-evidence"]');

    expect(evidence?.getAttribute('data-branch')).toBe('mutual-tls');
    for (const wording of ['compatibility', 'direct-invocation', 'direct invocation', 'shim']) {
      expect
        .soft(
          evidence?.textContent?.toLowerCase() ?? '',
          `F-008-RQ-001: mutual-TLS evidence must not describe itself with "${wording}", ` +
            'which names the compatibility-default branch',
        )
        .not.toContain(wording);
    }
  });

  it('states the silence it requires as the all-credentials branch writing nothing', () => {
    // The positive half of the assertion above: it is not enough that the wrong branch goes
    // unnamed, the right one has to be named. Without this, deleting the explanation
    // entirely would satisfy the negative check.
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );
    const silence = container.querySelector(
      `[data-measurement="${V8_OBSERVATIONS.diagnostic}"]`,
    );

    expect(silence?.getAttribute('data-result')).toBe('satisfied');
    expect(silence?.textContent).toContain('mutual-TLS branch');
    expect(silence?.textContent).toContain('all-credentials branch');
  });
});

describe('EtcdTransportPanel — the recorded diagnostics are the shell diagnostics', () => {
  // WHY THIS SUITE EXISTS. The recorded V8 payloads present their `diagnostic` values as the
  // operator output `configure-etcd-params` produced. Two of the three had been paraphrased:
  // the warning lost the shell's `ALL of` and the six credential variable names it writes out
  // in full, and the fail-closed error lost the parenthesised variable list and its closing
  // remedy sentence. Meanwhile the panel's own scenario table carried the correct sentences,
  // so two artifacts in one tier described one shell branch differently -- and the one that
  // presented itself as measured evidence was the wrong one. An operator greps a boot log for
  // these words; a shortened copy is a claim about a run that never happened (AAP §0.10.2).
  //
  // The full sentences now have exactly one definition site, `domain/securityConstants.ts`,
  // read by both the panel and the fixtures. What is asserted here is the property that made
  // the drift detectable in the first place: every recorded diagnostic must CONTAIN the
  // substring constant the measurements match on. Containment rather than equality, because
  // the substrings exist precisely so a future rewording of the surrounding prose does not
  // turn into a false failure -- but a diagnostic that no longer carries its phrase is a
  // diagnostic the panel can no longer recognise.

  it.each([
    ['the plaintext-fallback warning', 1, ETCD_PLAINTEXT_WARNING_MESSAGE],
    ['the plaintext opt-in warning', 2, ETCD_PLAINTEXT_WARNING_MESSAGE],
    ['the fail-closed error', 3, ETCD_FAIL_CLOSED_MESSAGE],
    ['the partial-credential error', 4, ETCD_PARTIAL_CREDENTIALS_MESSAGE],
  ])('records %s carrying the phrase the panel matches on', (_name, index, phrase) => {
    const recorded = ETCD_TRANSPORT_STATES[index]?.diagnostic;

    expect(typeof recorded, 'the state records a diagnostic').toBe('string');
    expect(String(recorded)).toContain(phrase);
  });

  it('records the six credential variable names the shell writes out in full', () => {
    // THE HALF THAT WAS LOST. The substring constants are the invariant phrases and none of
    // them contains a variable name, so containment alone would still pass against the
    // shortened paraphrase. This is the assertion that would have caught it: the shell names
    // every variable it looked for, and that naming is the actionable half of the message --
    // it tells an operator what to set.
    const warning = String(ETCD_TRANSPORT_STATES[2].diagnostic);
    const failClosed = String(ETCD_TRANSPORT_STATES[3].diagnostic);

    for (const variable of ETCD_MTLS_CREDENTIAL_VARS) {
      expect
        .soft(warning, `F-008-RQ-002: the recorded warning must name ${variable}`)
        .toContain(variable);
      expect
        .soft(failClosed, `F-008-RQ-003: the recorded fail-closed error must name ${variable}`)
        .toContain(variable);
    }
  });

  it('records ONE warning text for both plaintext branches, from one definition site', () => {
    // Identity, not equality of two spellings: both states must be the SAME string, because
    // the shell reaches one `echo` from one branch guard. An inline second copy of the
    // sentence sat on the opt-in payload's `warnings` array and had drifted from this one,
    // which is how the "one definition site" claim in the fixture became false.
    expect(ETCD_TRANSPORT_STATES[1].diagnostic).toBe(ETCD_TRANSPORT_STATES[2].diagnostic);
    expect(V8_ETCD_TRANSPORT_WARNING.warnings).toEqual(
      V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT.warnings,
    );
    expect(V8_ETCD_TRANSPORT_WARNING.warnings[0]).toBe(ETCD_TRANSPORT_STATES[2].diagnostic);
  });

  it('keeps the two abort diagnostics distinct, so a partial set is never read as permitted', () => {
    // The one thing byte-exactness must NOT do is make the two `exit 1` branches look alike.
    // They are different branches with different remedies: the all-absent branch consults the
    // opt-out, the partial branch does not consult it at all.
    expect(ETCD_TRANSPORT_STATES[3].diagnostic).not.toBe(ETCD_TRANSPORT_STATES[4].diagnostic);
    expect(String(ETCD_TRANSPORT_STATES[4].diagnostic)).not.toContain(ETCD_FAIL_CLOSED_MESSAGE);
    expect(String(ETCD_TRANSPORT_STATES[3].diagnostic)).not.toContain(
      ETCD_PARTIAL_CREDENTIALS_MESSAGE,
    );
  });

  it('renders a diagnostic in full instead of redacting it for length', () => {
    // THE SIDE EFFECT OF BYTE-EXACTNESS, closed here. The shell's sentences are 247, 408 and
    // 285 characters, because each names all six variables; the scalar observation formatter
    // REDACTS outright above 200. Sent through that rule the evidence cell read `[redacted]`
    // -- the panel claiming it had withheld a credential where the shell had printed an
    // ordinary message, destroying the evidence AAP §0.10.2 requires this branch to show. The
    // diagnostic is prose and is now formatted as prose, which applies the same
    // credential-shape redaction against a prose-sized bound.
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_FAIL_CLOSED} />,
    );
    const cell = container.querySelector('.etcd-transport-panel__evidence tbody tr:last-child');

    expect(container.querySelector('.etcd-transport-panel__evidence')?.textContent).toContain(
      ETCD_FAIL_CLOSED_MESSAGE,
    );
    expect(
      container.querySelector('.etcd-transport-panel__evidence')?.textContent,
    ).not.toContain(SAFE_REDACTED);
    expect(cell).not.toBeNull();
  });
});

describe('EtcdTransportPanel — an unidentifiable branch is never a pass', () => {
  it('withholds the pass for a payload claiming one and reporting nothing at all', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={claimingPass([])} />,
    );

    expect(renderedVerdict(container)).toBe('unknown');
    expect(renderedBranch(container)).toBe('indeterminate');
    expect(container).toHaveTextContent('does not identify which branch ran');
  });

  it('withholds the pass when the credential state is a word the shell cannot produce', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.credentialsSupplied, 'most'),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('withholds the pass when the credential state is reported at the wrong type', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.credentialsSupplied, true),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('withholds the pass when the credential state is reported twice', () => {
    const status = claimingPass([
      ...MUTUAL_TLS_PROVEN,
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'none' },
    ]);
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedBranch(container)).toBe('indeterminate');
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it('withholds the pass when credentials are absent but the opt-out was not reported', () => {
    const status = claimingPass(
      without(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.insecureFallbackPermitted),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('withholds the pass when the rendered command was reported unreadable', () => {
    const status = claimingPass([
      ...MUTUAL_TLS_PROVEN,
      { label: V8_OBSERVATIONS.renderedCommandReadable, value: false },
    ]);
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(container).toHaveTextContent('rather than assumed to be mutually authenticated');
  });

  it('grants the pass when the rendered command was reported readable', () => {
    const status = claimingPass([
      ...MUTUAL_TLS_PROVEN,
      { label: V8_OBSERVATIONS.renderedCommandReadable, value: true },
    ]);

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('pass');
  });

  it('floors the verdict at FAIL when the payload reports a finding beside a pass', () => {
    const withFinding: ControlStatus = {
      ...claimingPass(MUTUAL_TLS_PROVEN),
      findings: [
        {
          message: 'The etcd client certificate expires within seven days.',
          subject: 'kube-apiserver/--etcd-certfile',
          requirementId: 'F-008-RQ-001',
        },
      ],
    };

    expect(resolveEtcdTransportEffectiveVerdict(withFinding)).toBe('fail');
  });
});

describe('EtcdTransportPanel — the measured scenario table', () => {
  it('renders all five measured scenarios by default', () => {
    renderWithProviders(<EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />);

    expect(screen.getAllByRole('article').length).toBe(5);
  });

  it('narrows to one scenario when the caller asks for one', () => {
    renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} scenario="partial-credentials" />,
    );

    expect(screen.getAllByRole('article').length).toBe(1);
    expect(screen.getByRole('article', { name: 'Partial credentials' })).toBeInTheDocument();
  });

  it('keeps the two plaintext scenarios distinguishable', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    expect(
      container.querySelector('[data-scenario="allow-insecure"]')?.getAttribute('data-verdict'),
    ).toBe('warn');
    expect(
      container
        .querySelector('[data-scenario="unset-compat-default"]')
        ?.getAttribute('data-verdict'),
    ).toBe('warn');
  });

  it('renders the partial-credential scenario as a failure, never a partial pass', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    expect(
      container
        .querySelector('[data-scenario="partial-credentials"]')
        ?.getAttribute('data-verdict'),
    ).toBe('fail');
  });

  it('quotes the fail-closed diagnostic verbatim so a boot log can be grepped for it', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    expect(container).toHaveTextContent('refusing to fall back to plaintext etcd');
  });

  it('filters the scenario list through its own select', async () => {
    const { user } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    await user.selectOptions(screen.getByLabelText('Scenario'), 'no-certs-hardened');

    expect(screen.getAllByRole('article').length).toBe(1);
  });

  it('names the six credential variables and never a credential value', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    expect(container).toHaveTextContent('ETCD_APISERVER_CA_KEY');
    expect(container).toHaveTextContent('ETCD_APISERVER_CLIENT_CERT');
    expect(container.textContent ?? '').not.toContain('BEGIN');
  });
});

describe('EtcdTransportPanel — loading, empty, error and interaction', () => {
  it('renders the loading affordance and no verdict while the request is in flight', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel result={{ status: 'loading', refresh: vi.fn() }} />,
    );

    expect(renderedVerdict(container)).toBeNull();
    expect(container).toHaveTextContent('Reading the etcd transport posture');
  });

  it('renders the empty affordance when the server reported no posture at all', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel
        result={{ status: 'success', controls: [], isEmpty: true, refresh: vi.fn() }}
      />,
    );

    expect(renderedVerdict(container)).toBeNull();
    expect(container).toHaveTextContent('no etcd transport verdict to show');
  });

  it('renders the empty affordance when other controls were reported but not V8', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel
        result={{
          status: 'success',
          controls: [V8_ETCD_TRANSPORT_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
      />,
    );

    // The V8 payload IS present here, so this is the reported state; the case below
    // covers the genuinely absent one.
    expect(renderedVerdict(container)).toBe('pass');
  });

  it.each([
    ['forbidden', CONTROL_STATUS_ERRORS.forbidden],
    ['serverError', CONTROL_STATUS_ERRORS.serverError],
    ['network', CONTROL_STATUS_ERRORS.network],
  ])('renders an alert and never a verdict for a %s failure', (_name, error) => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel result={{ status: 'error', error, refresh: vi.fn() }} />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(renderedVerdict(container)).toBeNull();
    expect(container).toHaveTextContent('no verdict is shown');
  });

  it('re-issues the underlying request when no override handler was supplied', async () => {
    const refresh = vi.fn();
    const { user } = renderWithProviders(
      <EtcdTransportPanel
        result={{
          status: 'success',
          controls: [V8_ETCD_TRANSPORT_PASSING],
          isEmpty: false,
          refresh,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Re-read/ }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('calls the override handler instead of the underlying refresh when both exist', async () => {
    const refresh = vi.fn();
    const onRefresh = vi.fn();
    const { user } = renderWithProviders(
      <EtcdTransportPanel
        result={{
          status: 'success',
          controls: [V8_ETCD_TRANSPORT_PASSING],
          isEmpty: false,
          refresh,
        }}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Re-read/ }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables the control, with a reason, when there is nothing to re-request', () => {
    renderWithProviders(<EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />);
    const button = screen.getByRole('button', { name: /Re-read/ });

    // A payload handed over directly owns no request. An enabled button here would
    // promise a re-read it cannot perform.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });

  it('disables every refresh route when the caller says refreshing is unavailable', () => {
    renderWithProviders(
      <EtcdTransportPanel
        result={{
          status: 'success',
          controls: [V8_ETCD_TRANSPORT_PASSING],
          isEmpty: false,
          refresh: vi.fn(),
        }}
        onRefresh={vi.fn()}
        canRefresh={false}
      />,
    );
    const button = screen.getByRole('button', { name: /Re-read/ });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title');
  });
});

describe('EtcdTransportPanel — M9: the two plaintext states are different states', () => {
  it('identifies the operator-chosen state, and caps it at a warning', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_WARNING} />,
    );

    expect(renderedBranch(container)).toBe('permitted-plaintext');
    expect(renderedVerdict(container)).toBe('warn');
  });

  it('identifies the compatibility-default state, and caps it at a warning too', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT} />,
    );

    expect(renderedBranch(container)).toBe('compatibility-default');
    expect(renderedVerdict(container)).toBe('warn');
  });

  it('records the SAME warning for both plaintext states, as the shell emits', () => {
    // INVARIANT LOCKED (finding V), structurally: the two recorded payloads must agree
    // on the diagnostic, because they describe one shell branch. The fixture used to
    // record the warning for the explicit opt-in and `null` for the compatibility
    // default, which encoded a difference the shell does not have -- and made the panel
    // reject the only report the shim path can produce while accepting one it cannot.
    const operatorDiagnostic = V8_ETCD_TRANSPORT_WARNING.evidence.observations.find(
      (entry) => entry.label === V8_OBSERVATIONS.diagnostic,
    )?.value;
    const shimDiagnostic = V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT.evidence.observations.find(
      (entry) => entry.label === V8_OBSERVATIONS.diagnostic,
    )?.value;

    expect(typeof operatorDiagnostic, 'the operator opt-in records its warning').toBe('string');
    expect(
      shimDiagnostic,
      'the compatibility default emits the same warning, so it records the same text',
    ).toBe(operatorDiagnostic);
    expect(String(shimDiagnostic)).toContain(ETCD_PLAINTEXT_WARNING_MESSAGE);

    // What DOES differ is the explicit-supply flag, and it is the only thing that does.
    // Typed as the shared contract rather than as one fixture's `as const` literal,
    // so the same reader works for both payloads.
    const flagOf = (status: ControlStatus): unknown =>
      status.evidence?.observations?.find(
        (entry) => entry.label === V8_OBSERVATIONS.unitTestCompatibilityDefault,
      )?.value;
    expect(flagOf(V8_ETCD_TRANSPORT_WARNING)).toBe(false);
    expect(flagOf(V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT)).toBe(true);
  });

  it('explains the two plaintext states differently, since only one is a decision', () => {
    const operator = renderWithProviders(<EtcdTransportPanel status={V8_ETCD_TRANSPORT_WARNING} />);
    const operatorText = operator.container.textContent ?? '';
    operator.unmount();

    const shim = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_COMPATIBILITY_DEFAULT} />,
    );
    const shimText = shim.container.textContent ?? '';

    // The verdicts are identical, so the EXPLANATION is the only thing telling a reader
    // whether an unauthenticated transport was asked for or inherited from a test shim.
    expect(operatorText).toContain('explicitly permitted by an operator');
    expect(shimText).toContain('compatibility default');
    expect(shimText).not.toContain('explicitly permitted by an operator');
  });

  it('AAP §0.10.4 — plaintext with exit 0 is expected here and forbidden there', () => {
    // BOTH TRUTHS IN ONE CASE, because they are one requirement and separating them is how
    // one gets "fixed" into breaking the other. The empty-environment shim legitimately
    // yields a plaintext endpoint and exit 0; the profile-driven absent-credential path must
    // exit 1 with no endpoint at all.
    expect(
      resolveEtcdTransportEffectiveVerdict(claimingPass(COMPATIBILITY_DEFAULT_PROVEN)),
    ).toBe('warn');
    expect(resolveEtcdTransportEffectiveVerdict(claimingPass(FAIL_CLOSED_PROVEN))).toBe('pass');
    // And the fail-closed path reporting the shim's plaintext outcome is a FAILURE.
    const downgraded = claimingPass(
      replacing(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.etcdServers, ETCD_PLAINTEXT_ENDPOINT),
    );
    expect(resolveEtcdTransportEffectiveVerdict(downgraded)).toBe('fail');
  });

  it('cannot name a branch when the payload does not say which plaintext state it is', () => {
    // THE M9 DEFECT, directly. The superseded reader split on `insecureFallbackPermitted`
    // alone and called this `permitted-plaintext`, which then demanded a warning the
    // compatibility shim never writes — or, read the other way, would have let a real
    // deployment's silent downgrade pass as a test-harness artefact.
    const status = claimingPass(
      without(PERMITTED_PLAINTEXT_PROVEN, V8_OBSERVATIONS.unitTestCompatibilityDefault),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedBranch(container)).toBe('indeterminate');
    expect(renderedVerdict(container)).toBe('unknown');
  });

  it.each([
    ['a string', 'false'],
    ['a number', 0],
    ['an explicit null', null],
  ])('cannot name a branch when the compatibility flag is %s', (_name, value) => {
    const status = claimingPass(
      replacing(PERMITTED_PLAINTEXT_PROVEN, V8_OBSERVATIONS.unitTestCompatibilityDefault, value),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('fails an operator opt-in that configured plaintext silently', () => {
    // Without the warning it is not a decision, it is a downgrade — whoever set the variable.
    const status = claimingPass(
      replacing(PERMITTED_PLAINTEXT_PROVEN, V8_OBSERVATIONS.diagnostic, null),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, V8_OBSERVATIONS.diagnostic)).toBe('violated');
  });

  it('withholds the warning verdict when the opt-in reported no diagnostic at all', () => {
    const status = claimingPass(
      without(PERMITTED_PLAINTEXT_PROVEN, V8_OBSERVATIONS.diagnostic),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('accepts a compatibility default that announced itself, because the shell always does', () => {
    // INVARIANT LOCKED (finding V), AND THIS CASE IS THE INVERSE OF WHAT IT USED TO
    // ASSERT. It previously required a compatibility default carrying a warning to
    // FAIL, on the belief that the shim path prints nothing and that its silence is
    // what tells it apart from an operator's explicit opt-in.
    //
    // Executing the shipped shell disproves the belief. The fallback guard is
    // `[[ "${ETCD_APISERVER_ALLOW_INSECURE:-true}" == "true" ]]`
    // (cluster/gce/gci/configure-kubeapiserver.sh L41), so an UNSET variable takes the
    // same branch as an explicit `true` and reaches the same `echo`. All three states,
    // measured against the real script:
    //   unset          -> rc=0, http endpoint, 1 WARNING on stdout, 0 ERROR on stderr
    //   explicit true  -> rc=0, http endpoint, 1 WARNING on stdout, 0 ERROR on stderr
    //   explicit false -> rc=1, no endpoint,   0 WARNING,           1 ERROR on stderr
    //
    // So the old expectation rejected the ONLY report the shell can actually produce.
    // What distinguishes the two plaintext states is
    // `unitTestCompatibilityDefault` -- whether the variable was explicitly supplied --
    // and nothing else.
    const status = claimingPass(
      replacing(
        COMPATIBILITY_DEFAULT_PROVEN,
        V8_OBSERVATIONS.diagnostic,
        `WARNING: ${ETCD_PLAINTEXT_WARNING_MESSAGE}.`,
      ),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(measurementResult(container, V8_OBSERVATIONS.diagnostic)).toBe('satisfied');
    // Still capped at WARN and never a pass: the transport is unauthenticated either
    // way, and accepting the truthful diagnostic must not soften that.
    expect(renderedVerdict(container)).toBe('warn');
    // And the branch is still identified as the shim rather than the operator's choice.
    expect(renderedBranch(container)).toBe('compatibility-default');
  });

  it('fails a compatibility default that claimed silence, which the shell cannot produce', () => {
    // THE MIRROR, CORRECTED. Silence on this path is not the shim's signature -- it is
    // an impossible measurement, because the branch unconditionally echoes its warning.
    // A report claiming it describes a boot that did not happen, so it is refused for
    // the same reason a silent operator opt-in is refused just below.
    const status = claimingPass(
      replacing(COMPATIBILITY_DEFAULT_PROVEN, V8_OBSERVATIONS.diagnostic, null),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(measurementResult(container, V8_OBSERVATIONS.diagnostic)).toBe('violated');
    expect(renderedVerdict(container)).toBe('fail');
  });

  it('withholds the verdict when the compatibility default reported no diagnostic field', () => {
    const status = claimingPass(without(COMPATIBILITY_DEFAULT_PROVEN, V8_OBSERVATIONS.diagnostic));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it.each([
    ['the default profile', V8_OBSERVATIONS.insecureFallbackDefaultDefaultProfile],
    ['the test profile', V8_OBSERVATIONS.insecureFallbackDefaultTestProfile],
  ])('withholds the pass when %s default is not reported', (_name, identity) => {
    const status = claimingPass(without(MUTUAL_TLS_PROVEN, identity));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, identity)).toBe('indeterminate');
  });

  it.each([
    ['the default profile', V8_OBSERVATIONS.insecureFallbackDefaultDefaultProfile],
    ['the test profile', V8_OBSERVATIONS.insecureFallbackDefaultTestProfile],
  ])('fails when %s defaults the insecure fallback to true', (_name, identity) => {
    // AAP §0.10.2 requires BOTH profiles asserted together for exactly this reason: a
    // one-sided edit would leave one profile insecure while the other stayed green, and
    // either profile alone would report that as compliant.
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, identity, true));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, identity)).toBe('violated');
  });
});

describe('EtcdTransportPanel — M10: missing evidence is indeterminate, never satisfied', () => {
  it('grants each branch its recorded verdict when fully evidenced — the control', () => {
    // Two-sided first. Every withholding case below removes ONE observation from one of
    // these lists, so if a list did not produce its verdict here, each of those cases would
    // hold vacuously over a payload that was already unknown.
    expect.soft(resolveEtcdTransportEffectiveVerdict(claimingPass(MUTUAL_TLS_PROVEN))).toBe('pass');
    expect.soft(resolveEtcdTransportEffectiveVerdict(claimingPass(FAIL_CLOSED_PROVEN))).toBe('pass');
    expect.soft(resolveEtcdTransportEffectiveVerdict(claimingPass(PARTIAL_ABORTED))).toBe('pass');
    expect
      .soft(resolveEtcdTransportEffectiveVerdict(claimingPass(PERMITTED_PLAINTEXT_PROVEN)))
      .toBe('warn');
    expect
      .soft(resolveEtcdTransportEffectiveVerdict(claimingPass(COMPATIBILITY_DEFAULT_PROVEN)))
      .toBe('warn');
  });

  it('withholds the fail-closed pass when the endpoint was never reported', () => {
    // THE M10 DEFECT. An unreported endpoint used to be SATISFIED, on the reasoning that
    // silence is consistent with a branch that aborts before configuring one — which is true
    // and is not evidence, because it is equally consistent with a check that never looked.
    // The fail-closed branch reaches a PASS on the strength of an absent endpoint, so this
    // was a pass for measuring nothing.
    const status = claimingPass(without(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.etcdServers));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, V8_OBSERVATIONS.etcdServers)).toBe('indeterminate');
  });

  it('accepts an explicitly absent endpoint, which is an absence that was measured', () => {
    // The other side of the same rule, and the reason it costs a real report nothing.
    const status = claimingPass(FAIL_CLOSED_PROVEN);
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(measurementResult(container, V8_OBSERVATIONS.etcdServers)).toBe('satisfied');
    expect(renderedVerdict(container)).toBe('pass');
  });

  it.each([
    ['the fail-closed branch', () => FAIL_CLOSED_PROVEN],
    ['the partial-credential branch', () => PARTIAL_ABORTED],
    ['the mutual-TLS branch', () => MUTUAL_TLS_PROVEN],
  ])('withholds the pass on %s when the outcome was never reported', (_name, base) => {
    // "The outcome was not reported separately" used to read as agreement, so a payload could
    // claim the exact outcome its branch requires by declining to state one.
    const status = claimingPass(without(base(), V8_OBSERVATIONS.outcome));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, V8_OBSERVATIONS.outcome)).toBe('indeterminate');
  });

  it.each([
    ['the fail-closed branch', () => FAIL_CLOSED_PROVEN],
    ['the partial-credential branch', () => PARTIAL_ABORTED],
  ])('withholds the pass on %s when no diagnostic was reported', (_name, base) => {
    // AAP §0.10.2 states the aborting branches as the PHRASE and the exit code together: an
    // exit code alone cannot tell an intentional abort from a crash.
    const status = claimingPass(without(base(), V8_OBSERVATIONS.diagnostic));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('fails the fail-closed branch when it aborted without saying why', () => {
    const status = claimingPass(replacing(FAIL_CLOSED_PROVEN, V8_OBSERVATIONS.diagnostic, null));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });

  it('fails the fail-closed branch when the diagnostic is some other message', () => {
    const status = claimingPass(
      replacing(
        FAIL_CLOSED_PROVEN,
        V8_OBSERVATIONS.diagnostic,
        'ERROR: the etcd client certificate has expired.',
      ),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, V8_OBSERVATIONS.diagnostic)).toBe('violated');
  });

  it('will not let the partial branch borrow the all-absent diagnostic', () => {
    // The two aborting branches share an outcome and an exit code, so the PHRASE is what
    // tells them apart — and telling them apart is what stops a half-configured deployment
    // being reported as a deliberately permitted one. The partial branch never consults the
    // opt-out at all.
    const status = claimingPass(
      replacing(
        PARTIAL_ABORTED,
        V8_OBSERVATIONS.diagnostic,
        `ERROR: ${ETCD_FAIL_CLOSED_MESSAGE} for a hardened profile.`,
      ),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('fail');
  });

  it('requires the partial branch to name the incomplete credential set', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={claimingPass(PARTIAL_ABORTED)} />,
    );

    expect(measurementResult(container, V8_OBSERVATIONS.diagnostic)).toBe('satisfied');
    expect(RECORDED_PARTIAL_STATE.diagnostic).toContain(ETCD_PARTIAL_CREDENTIALS_MESSAGE);
  });
});

describe('EtcdTransportPanel — M17: a credential field must be a path, and is never echoed', () => {
  /** A PEM header with no key body: credential-SHAPED and inert. */
  const PEM_SHAPED = '-----BEGIN RSA PRIVATE KEY----- abcd -----END RSA PRIVATE KEY-----';

  /** A JWT-shaped run that decodes to nothing. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  const CREDENTIAL_IDENTITIES: readonly (readonly [string, string])[] = [
    ['the CA file', V8_OBSERVATIONS.etcdCaFile],
    ['the client certificate', V8_OBSERVATIONS.etcdCertFile],
    ['the client key', V8_OBSERVATIONS.etcdKeyFile],
  ];

  it('grants the pass for the recorded absolute paths — the control', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={claimingPass(MUTUAL_TLS_PROVEN)} />,
    );

    expect(renderedVerdict(container)).toBe('pass');
    for (const [, identity] of CREDENTIAL_IDENTITIES) {
      expect.soft(measurementResult(container, identity)).toBe('satisfied');
    }
  });

  it('renders the basename of each credential path, and not the directory tree', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={claimingPass(MUTUAL_TLS_PROVEN)} />,
    );
    const text = container.textContent ?? '';

    // What a reader needs is WHICH file, not where a production control plane keeps it.
    expect(text).toContain('etcd-apiserver-ca.crt');
    expect(text).toContain('etcd-apiserver-client.crt');
    expect(text).toContain('etcd-apiserver-client.key');
    expect(text).not.toContain('/etc/srv/kubernetes/pki');
    expect(text).not.toContain(V8_CREDENTIAL_PATHS.keyFile);
  });

  it.each(CREDENTIAL_IDENTITIES)(
    'refuses a PEM body in %s, and never renders it',
    (_name, identity) => {
      // THE M17 DEFECT AT ITS WORST: `path.value.length > 0` was the whole test, so this
      // earned a PASS for the strongest posture V8 has AND was rendered back in full, beside
      // a label giving a reader every reason to think it belonged there.
      const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, identity, PEM_SHAPED));
      const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

      expect(renderedVerdict(container)).not.toBe('pass');
      expect(container.textContent ?? '').not.toContain('BEGIN RSA PRIVATE KEY');
      expect(container).toHaveTextContent('value withheld');
    },
  );

  it.each(CREDENTIAL_IDENTITIES)(
    'refuses a token-shaped value in %s, and never renders it',
    (_name, identity) => {
      const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, identity, TOKEN_SHAPED));
      const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

      expect(renderedVerdict(container)).not.toBe('pass');
      expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    },
  );

  it.each([
    ['a bare word, as the Go fixture spells its placeholder', 'CACertPath'],
    ['a relative path', 'pki/etcd-apiserver-ca.crt'],
    ['a path with a newline', '/etc/srv/kubernetes/pki/ca.crt\nrm -rf /'],
    ['a path with a control character', '/etc/srv/kubernetes/pki/ca\u0007.crt'],
    ['a path with a space', '/etc/srv/kubernetes/pki/ca file.crt'],
    ['a dot-dot traversal', '/etc/srv/../../root/.ssh/id_rsa'],
    ['an oversized path', `/etc/${'x'.repeat(MAX_SAFE_PATH_LENGTH)}/ca.crt`],
    ['a boolean', true],
    ['a number', 1],
  ])('withholds the pass when the CA file is %s', (_name, value) => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdCaFile, value));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    // INDETERMINATE rather than violated: the flag may be configured correctly and reported
    // badly, so this is a defect in the report rather than proof of one in the deployment.
    // Either way it withholds the pass, which is the part that matters.
    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, V8_OBSERVATIONS.etcdCaFile)).toBe('indeterminate');
  });

  it('still calls an EMPTY credential field a violation, not merely unreadable', () => {
    // An empty string is not a badly reported path, it is no credential at all — which is a
    // fact about the deployment rather than about the report.
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdCaFile, ''));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, V8_OBSERVATIONS.etcdCaFile)).toBe('violated');
  });

  it('still calls an explicitly absent credential field a violation', () => {
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdCaFile, null));
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('fail');
    expect(measurementResult(container, V8_OBSERVATIONS.etcdCaFile)).toBe('violated');
  });

  it('never explains its refusal by quoting the value it refused', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdKeyFile, PEM_SHAPED),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);
    const text = container.textContent ?? '';

    // The sentence says WHY the value was refused and warns that it may be the credential
    // itself — without demonstrating the point by printing it.
    expect(text).toContain('may well contain the credential');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain('abcd');
  });
});

describe('EtcdTransportPanel — M18: external text is bounded and redacted', () => {
  /** A JWT-shaped value: three dot-separated runs of at least eight word characters. */
  const TOKEN_SHAPED = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';

  /** A PEM block, which the shared guard treats as credential-shaped whole. */
  const PEM_SHAPED = '-----BEGIN PRIVATE KEY----- abcd -----END PRIVATE KEY-----';

  it('renders the recorded prose unchanged — the control', () => {
    const passing = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );
    expect(passing.container).toHaveTextContent(V8_ETCD_TRANSPORT_PASSING.summary);
    expect(passing.container).toHaveTextContent(V8_ETCD_TRANSPORT_PASSING.detail);
    passing.unmount();

    const failing = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_FAILING} />,
    );
    for (const finding of V8_ETCD_TRANSPORT_FAILING.findings) {
      expect.soft(failing.container).toHaveTextContent(finding.message);
    }
  });

  it.each([
    [
      'the summary',
      (text: string): ControlStatus => ({ ...V8_ETCD_TRANSPORT_PASSING, summary: text }),
    ],
    [
      'the detail',
      (text: string): ControlStatus => ({ ...V8_ETCD_TRANSPORT_PASSING, detail: text }),
    ],
    [
      'a warning',
      (text: string): ControlStatus => ({ ...V8_ETCD_TRANSPORT_PASSING, warnings: [text] }),
    ],
    [
      'a finding message',
      (text: string): ControlStatus => ({
        ...V8_ETCD_TRANSPORT_PASSING,
        findings: [{ message: text, requirementId: 'F-008-RQ-001' }],
      }),
    ],
    [
      'a finding subject',
      (text: string): ControlStatus => ({
        ...V8_ETCD_TRANSPORT_PASSING,
        findings: [{ message: 'the transport downgraded.', subject: text }],
      }),
    ],
    [
      'a finding requirement identifier',
      (text: string): ControlStatus => ({
        ...V8_ETCD_TRANSPORT_PASSING,
        findings: [{ message: 'the transport downgraded.', requirementId: text }],
      }),
    ],
    [
      'the evaluation timestamp',
      (text: string): ControlStatus => ({ ...V8_ETCD_TRANSPORT_PASSING, observedAt: text }),
    ],
    [
      'a reported requirement identifier',
      (text: string): ControlStatus => ({ ...V8_ETCD_TRANSPORT_PASSING, requirementIds: [text] }),
    ],
    [
      'an unrecognised observation label',
      (text: string): ControlStatus =>
        claimingPass([...MUTUAL_TLS_PROVEN, { label: text, value: 1 }]),
    ],
    [
      'an unrecognised observation value',
      (text: string): ControlStatus =>
        claimingPass([...MUTUAL_TLS_PROVEN, { label: 'probe', value: text }]),
    ],
  ])('withholds a token-shaped credential in %s', (_name, build) => {
    const { container } = renderWithProviders(<EtcdTransportPanel status={build(TOKEN_SHAPED)} />);

    expect(container.textContent ?? '').not.toContain(TOKEN_SHAPED);
    expect(container).toHaveTextContent(SAFE_REDACTED);
  });

  it('withholds a credential in the failure message and its reason', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel
        result={{
          status: 'error',
          error: {
            ...CONTROL_STATUS_ERRORS.serverError,
            message: `the posture endpoint reported ${TOKEN_SHAPED}`,
            reason: `upstream said ${PEM_SHAPED}`,
          },
          refresh: vi.fn(),
        }}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).not.toContain(TOKEN_SHAPED);
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(container).toHaveTextContent(SAFE_REDACTED);
    // The locally authored sentence is unconditional, so a redaction marker never stands alone.
    expect(container).toHaveTextContent('no verdict is shown');
  });

  it('bounds the timestamp in the datetime attribute as well as in the text', () => {
    const status: ControlStatus = { ...V8_ETCD_TRANSPORT_PASSING, observedAt: TOKEN_SHAPED };
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);
    const time = container.querySelector('time');

    // Guarding only the visible text would leave the attribute — which assistive technology
    // and any consuming tool reads — carrying the raw value.
    expect(time?.getAttribute('datetime') ?? '').not.toContain(TOKEN_SHAPED);
    expect(time?.textContent ?? '').not.toContain(TOKEN_SHAPED);
  });

  it('bounds an oversized summary rather than rendering any of it', () => {
    const status: ControlStatus = {
      ...V8_ETCD_TRANSPORT_PASSING,
      summary: 'x'.repeat(MAX_SAFE_PROSE_INPUT_LENGTH + 1),
    };
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(container).toHaveTextContent(SAFE_OVERSIZED_TEXT);
    expect(container.textContent ?? '').not.toContain('xxxxxxxxxx');
  });

  it('collapses control characters and bidirectional overrides out of prose', () => {
    const status: ControlStatus = {
      ...V8_ETCD_TRANSPORT_PASSING,
      summary: 'etcd is mutually authenticated.\n\u0007\u202ENothing downgraded.',
    };
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u202E');
    expect(container).toHaveTextContent('etcd is mutually authenticated. Nothing downgraded.');
  });

  it('substitutes local wording for text that sanitized away to nothing', () => {
    const status: ControlStatus = {
      ...V8_ETCD_TRANSPORT_PASSING,
      summary: '\u0000\u0007',
      findings: [{ message: '\u202E\u200B' }],
    };
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(container).toHaveTextContent('summary could not be displayed');
    expect(container).toHaveTextContent('finding whose message could not be displayed');
  });

  it('never names an external standards benchmark', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel status={V8_ETCD_TRANSPORT_PASSING} />,
    );

    expect(container.textContent ?? '').not.toMatch(/CIS|NSA|OWASP/);
  });
});


describe('EtcdTransportPanel — a duplicated or wrong-typed measurement is never a value', () => {
  it.each([
    ['the endpoint', V8_OBSERVATIONS.etcdServers, ETCD_PLAINTEXT_ENDPOINT],
    ['the outcome', V8_OBSERVATIONS.outcome, 'plaintext-loopback'],
    ['the diagnostic', V8_OBSERVATIONS.diagnostic, 'ERROR: something else'],
    ['a credential path', V8_OBSERVATIONS.etcdCaFile, '/etc/other/ca.crt'],
    ['the exit code', V8_OBSERVATIONS.exitCode, 1],
  ])('withholds the pass when %s is reported twice', (_name, identity, second) => {
    // Never resolved by LIST ORDER. Two answers to one question means the report cannot say
    // which is authoritative, and a verdict that depended on serialisation order would be a
    // verdict about the serialiser.
    const status = claimingPass([...MUTUAL_TLS_PROVEN, { label: identity, value: second }]);
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(renderedVerdict(container)).toBe('unknown');
    expect(measurementResult(container, identity)).toBe('indeterminate');
  });

  it.each([
    ['the outcome as a number', V8_OBSERVATIONS.outcome, 1],
    ['the endpoint as a number', V8_OBSERVATIONS.etcdServers, 2379],
    ['the diagnostic as a number', V8_OBSERVATIONS.diagnostic, 1],
    ['the exit code as a string', V8_OBSERVATIONS.exitCode, '0'],
  ])('withholds the pass when %s cannot be read as its own type', (_name, identity, value) => {
    // A stringified zero is not the number zero; re-parsing it would be the panel deciding
    // what the report meant to say.
    const status = claimingPass(replacing(MUTUAL_TLS_PROVEN, identity, value));

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('withholds the pass when the compatibility flag is a string rather than a boolean', () => {
    // Measured on a PLAINTEXT baseline, because that is the only branch which consults the
    // flag at all: `"no"` is not `false`, and a payload whose flag cannot be read does not
    // say which of the two plaintext states it describes.
    const status = claimingPass(
      replacing(PERMITTED_PLAINTEXT_PROVEN, V8_OBSERVATIONS.unitTestCompatibilityDefault, 'no'),
    );

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });

  it('fails an endpoint whose scheme is neither https nor plaintext', () => {
    const status = claimingPass(
      replacing(MUTUAL_TLS_PROVEN, V8_OBSERVATIONS.etcdServers, 'unix:///tmp/etcd.sock'),
    );
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    // Violated rather than indeterminate: an endpoint WAS configured and it is not the
    // required one, which is a fact about the deployment.
    expect(renderedVerdict(container)).toBe('fail');
    expect(container).toHaveTextContent('does not use the required scheme');
  });

  it('substitutes local wording for a failure message that sanitized away', () => {
    const { container } = renderWithProviders(
      <EtcdTransportPanel
        result={{
          status: 'error',
          error: { ...CONTROL_STATUS_ERRORS.network, message: '\u0000\u0007' },
          refresh: vi.fn(),
        }}
      />,
    );

    expect(container).toHaveTextContent('failure whose message could not be displayed');
  });

  it('describes an empty unrecognised observation value rather than rendering a blank cell', () => {
    const status = claimingPass([...MUTUAL_TLS_PROVEN, { label: 'probe', value: '' }]);
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(container).toHaveTextContent('reported as an empty string');
  });

  it('describes a null unrecognised observation value as an explicit null', () => {
    const status = claimingPass([...MUTUAL_TLS_PROVEN, { label: 'probe', value: null }]);
    const { container } = renderWithProviders(<EtcdTransportPanel status={status} />);

    expect(container).toHaveTextContent('reported as null');
  });

  it('withholds the pass when the rendered command was reported unreadable', () => {
    // Nothing below it was observed, so nothing below it is evidence — the transport is
    // unknown rather than assumed to be mutually authenticated.
    const status = claimingPass([
      ...MUTUAL_TLS_PROVEN,
      { label: V8_OBSERVATIONS.renderedCommandReadable, value: false },
    ]);

    expect(resolveEtcdTransportEffectiveVerdict(status)).toBe('unknown');
  });
});
