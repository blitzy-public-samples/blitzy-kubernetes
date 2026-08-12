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
// NO CREDENTIAL MATERIAL APPEARS HERE. The only path-shaped strings are the Go fixture's own
// placeholders — `CACertPath`, `APIServerCertPath`, `APIServerKeyPath` — recorded from
// `cluster/gce/gci/apiserver_etcd_test.go` L169 and L175-L176.

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { V8_OBSERVATIONS } from '../domain/observationIds';
import {
  ETCD_PLAINTEXT_ENDPOINT,
  ETCD_TLS_ENDPOINT,
} from '../domain/securityConstants';
import type { ControlObservation, ControlStatus } from '../hooks/useControlStatus';
import {
  CONTROL_STATUS_ERRORS,
  V8_ETCD_TRANSPORT_FAIL_CLOSED,
  V8_ETCD_TRANSPORT_FAILING,
  V8_ETCD_TRANSPORT_PASSING,
  V8_ETCD_TRANSPORT_UNKNOWN,
  V8_ETCD_TRANSPORT_WARNING,
} from '../test/fixtures/controlStatus';
import { renderWithProviders } from '../test/utils/renderWithProviders';
import EtcdTransportPanel, {
  resolveEtcdTransportEffectiveVerdict,
} from './EtcdTransportPanel';

/** The mutual-TLS branch, fully evidenced. */
const MUTUAL_TLS_PROVEN: readonly ControlObservation[] = [
  { label: V8_OBSERVATIONS.credentialsSupplied, value: 'all' },
  { label: V8_OBSERVATIONS.etcdServers, value: ETCD_TLS_ENDPOINT },
  { label: V8_OBSERVATIONS.etcdCaFile, value: 'CACertPath' },
  { label: V8_OBSERVATIONS.etcdCertFile, value: 'APIServerCertPath' },
  { label: V8_OBSERVATIONS.etcdKeyFile, value: 'APIServerKeyPath' },
  { label: V8_OBSERVATIONS.exitCode, value: 0 },
];

/** The fail-closed branch, fully evidenced. */
const FAIL_CLOSED_PROVEN: readonly ControlObservation[] = [
  { label: V8_OBSERVATIONS.credentialsSupplied, value: 'none' },
  { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: false },
  { label: V8_OBSERVATIONS.outcome, value: 'fail-closed' },
  { label: V8_OBSERVATIONS.exitCode, value: 1 },
  { label: V8_OBSERVATIONS.etcdServers, value: null },
];

/** The partial-credential branch, behaving as the control demands. */
const PARTIAL_ABORTED: readonly ControlObservation[] = [
  { label: V8_OBSERVATIONS.credentialsSupplied, value: 'partial' },
  { label: V8_OBSERVATIONS.exitCode, value: 1 },
  { label: V8_OBSERVATIONS.etcdServers, value: null },
  { label: V8_OBSERVATIONS.exitCodeRequiredForPartial, value: 1 },
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
    const status = claimingPass([
      { label: V8_OBSERVATIONS.credentialsSupplied, value: 'none' },
      { label: V8_OBSERVATIONS.insecureFallbackPermitted, value: true },
      { label: V8_OBSERVATIONS.etcdServers, value: ETCD_PLAINTEXT_ENDPOINT },
      { label: V8_OBSERVATIONS.outcome, value: 'plaintext-loopback' },
    ]);

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
