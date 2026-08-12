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

// AAP §0.5.1 (the `web/src/components/PodSecurityPanel.tsx` row — "V2
// behaviour: Pass and fail plus warning surfacing") / §0.4.2.4 (L6 React tier,
// V2 — every panel covers a happy path, an edge case, an error case, loading and
// empty states, and an interaction case driving refresh) / §0.7.1.3 (the >= 80 %
// line-and-branch floor for the React tier) / tech-spec §6.4.4.3 (Pod Security
// enforcement — `enforce=baseline` rejects privileged and hostPID pods;
// `warn=restricted` admits but warns).
//
// NO PARITY ANCESTOR. This tier ports nothing. `blitzy/documentation/Project
// Guide.md` L133 records that this is "a control-plane/configuration project
// with **no UI surface**", and tech-spec §6.6.1.3 marks UI automation and
// cross-browser testing not applicable, so there is no predecessor UI test suite
// to reproduce. AAP §0.10.3 therefore anchors this tier's fidelity on the
// ADMISSION BEHAVIOUR it surfaces rather than on a prior UI. The behaviour is
// read from the Go oracle, which this workstream never deletes (AAP §0.5.1 — the
// DELETE set is empty by design):
//
//   `test/integration/auth/podsecurity_test.go` L363-457,
//   `TestPodSecurityEnforceBaselineRejectsPrivileged`:
//
//     * L390-397  namespace `psa-enforce-baseline` labelled
//                 `pod-security.kubernetes.io/enforce: baseline`.
//     * L399-412  pod `privileged-pod` (`securityContext.privileged: true`) is
//                 asserted rejected via `apierrors.IsForbidden`, i.e. HTTP 403.
//     * L414-424  pod `hostpid-pod` (`spec.hostPID: true`) likewise.
//     * L426-433  namespace `psa-warn-restricted` labelled
//                 `pod-security.kubernetes.io/warn: restricted`.
//     * L441-451  pod `warn-pod` — a plain pod, violating `restricted` yet
//                 compliant with `baseline` — is asserted ADMITTED (`err != nil`
//                 is the failure), because `enforce` is left at the cluster
//                 default `privileged`: unset levels default to
//                 `api.LevelPrivileged` per
//                 `staging/src/k8s.io/pod-security-admission/admission/api/v1/defaults.go`.
//     * L452-456  and yet at least one warning must have been recorded —
//                 "expected at least one Pod Security warning under
//                 warn=restricted, got none".
//
// The label vocabulary rendered below is taken verbatim from
// `staging/src/k8s.io/pod-security-admission/api/constants.go`; no shorthand is
// invented for it.
//
// RULES STATUS (AAP §0.11). `review_rules` returns exactly one line — "No user
// rules provided." — and that single line is the whole rules document; it was
// read in full and confirmed. NO user-specified rules exist for this project, so
// none is cited and none is invented. AAP §0.11.1's enterprise-standard bar
// governs instead, and the three items that bind this file are:
//
//   * "Never weaken a boundary condition to make a test pass" — a WARNING IS A
//     THIRD, DISTINCT AFFORDANCE. See {@link VERDICT_HEADINGS}.
//   * "Never weaken a boundary condition" — the rejection code is 403 and the
//     reason is `Forbidden`. See {@link ENFORCEMENT_REJECTIONS}.
//   * "Cite only what the repository states" — the repository enumerates no
//     external benchmark or hardening-guide control number, so this file asserts
//     none anywhere: not in an identifier, a comment, a rendered string or an
//     accessible name. The repository's own requirement identifiers are used
//     instead. See {@link COVERED_REQUIREMENT_IDS}.
//
// DEPENDENCY DISCIPLINE. The only imports are `react` and this tier's single
// type-definition site, `../hooks/useControlStatus`. No design system, no CSS
// framework, no icon library, no router and no data-fetching library is
// introduced, so web/package.json and web/package-lock.json stay in step. There
// is also NO styling at all — no stylesheet exists anywhere under web/, AAP
// §0.5.1 creates no `.css` row, and web/vitest.config.ts sets `css: false`, so a
// class name here would reference nothing and a style import would be a
// dependency this plan does not sanction. The markup is plain and semantic, and
// meaning is carried by TEXT rather than by colour, which satisfies "colour is
// never the sole indicator of meaning" by construction.
import { useId, type ReactNode } from 'react';

import {
  selectControlStatus,
  useControlStatus,
  type ControlFinding,
  type ControlId,
  type ControlObservation,
  type ControlStatus,
  type ControlStatusError,
  type ControlVerdict,
  type UseControlStatusResult,
} from '../hooks/useControlStatus';

/** The control this panel reports on. */
const CONTROL_ID: ControlId = 'V2';

/** Accessible name of the panel's landmark, and its visible heading. */
const PANEL_TITLE = 'Pod Security enforcement (V2)';

/** One-line statement of what the panel reports, rendered under the heading. */
const PANEL_DESCRIPTION =
  'Namespace-scoped Pod Security admission: an enforced level rejects violating pods outright, ' +
  'while a warned level admits them and objects.';

/**
 * The repository's own requirement identifiers this panel covers, used when the
 * server attributes none itself.
 *
 * `F-002-RQ-001` is the generated admission configuration (`enforce=baseline`,
 * `warn`/`audit=restricted`), `F-002-RQ-002` is `PodSecurity` appearing in
 * `ADMISSION_CONTROL` on both profiles, and `F-002-RQ-003` is the namespace
 * label set. These are the repository's identifiers and nothing else: no
 * external benchmark or hardening-guide control number is asserted, because the
 * repository enumerates none (AAP §0.11.1, "cite only what the repository
 * states"; tech-spec §2.5.3).
 */
const COVERED_REQUIREMENT_IDS: readonly string[] = [
  'F-002-RQ-001',
  'F-002-RQ-002',
  'F-002-RQ-003',
];

/**
 * The label key prefix, verbatim from `pod-security-admission/api/constants.go`
 * (`labelPrefix`).
 */
const LABEL_PREFIX = 'pod-security.kubernetes.io/';

/** `EnforceLevelLabel`. */
const ENFORCE_LABEL = `${LABEL_PREFIX}enforce`;
/** `WarnLevelLabel`. */
const WARN_LABEL = `${LABEL_PREFIX}warn`;

/** The namespace the oracle enforces `baseline` in (`podsecurity_test.go` L390). */
const ENFORCE_NAMESPACE = 'psa-enforce-baseline';
/** The namespace the oracle warns at `restricted` in (`podsecurity_test.go` L431). */
const WARN_NAMESPACE = 'psa-warn-restricted';
/** The pod the oracle admits under `warn=restricted` (`podsecurity_test.go` L441). */
const WARN_POD = 'warn-pod';

/**
 * The HTTP status an admission rejection carries.
 *
 * Invariant locked (AAP §0.10.2): the oracle asserts rejection through
 * `apierrors.IsForbidden`, which is HTTP 403 and no other code. A rejection with
 * any other status, or one whose cause is something other than the admission
 * decision, is NOT this control working and must never render as a pass — which
 * is why this value is a named constant rather than an inline literal.
 *
 * DISAMBIGUATION, and this is the easiest thing in this file to get subtly
 * wrong: this 403 is an OBSERVED ADMISSION REJECTION and is the control working
 * correctly. It is a completely different fact from a 403 returned by the
 * posture status endpoint itself, which means this client was refused and no
 * verdict exists — see {@link PostureRequestFailure}. The two are kept apart in
 * the code by living in different components, and apart in the user interface by
 * wording that never overlaps: everything about this constant is labelled
 * "admission rejection", and everything about a failed request is labelled
 * "status endpoint".
 */
const ADMISSION_REJECTION_STATUS = 403;

/**
 * The `reason` an admission rejection carries — the wire-level counterpart of
 * the oracle's `apierrors.IsForbidden` check.
 */
const ADMISSION_REJECTION_REASON = 'Forbidden';

/** One pod the enforced level must reject, and why. */
interface EnforcementRejection {
  /** Pod name, as the oracle creates it. */
  readonly pod: string;
  /** The field that violates the enforced level. */
  readonly violation: string;
  /** HTTP status of the rejection. */
  readonly status: number;
  /** `reason` of the rejection. */
  readonly reason: string;
}

/**
 * The two rejections `enforce=baseline` is required to produce, exactly as
 * measured from the oracle (`podsecurity_test.go` L399-424).
 *
 * Declarative rather than derived from the response so that each row is
 * individually queryable and present in every rendered state: this is the
 * control's specification, and a panel that could omit it when the server said
 * nothing would be unable to show what was expected of a failing control.
 */
const ENFORCEMENT_REJECTIONS: readonly EnforcementRejection[] = [
  {
    pod: 'privileged-pod',
    violation: 'securityContext.privileged: true',
    status: ADMISSION_REJECTION_STATUS,
    reason: ADMISSION_REJECTION_REASON,
  },
  {
    pod: 'hostpid-pod',
    violation: 'spec.hostPID: true',
    status: ADMISSION_REJECTION_STATUS,
    reason: ADMISSION_REJECTION_REASON,
  },
];

/** The three accepted level values (`api.Level`: privileged, baseline, restricted). */
const ACCEPTED_LEVELS: readonly string[] = ['privileged', 'baseline', 'restricted'];

/**
 * `api.VersionLatest`. The default `SetDefaults_PodSecurityDefaults` applies to
 * every `-version` label when it is unset.
 */
const LATEST_VERSION = 'latest';

/** One row of the namespace label vocabulary. */
interface PodSecurityLabelRow {
  /** The full label key. Never abbreviated. */
  readonly label: string;
  /** The value the repository's configuration carries for it. */
  readonly value: string;
  /** What the label does. */
  readonly effect: string;
}

/**
 * The six `pod-security.kubernetes.io/` labels, named exactly as
 * `pod-security-admission/api/constants.go` declares them —
 * `EnforceLevelLabel`, `EnforceVersionLabel`, `WarnLevelLabel`,
 * `WarnVersionLabel`, `AuditLevelLabel` and `AuditVersionLabel`.
 *
 * The level values are the ones the repository commits (`enforce=baseline`,
 * `warn`/`audit=restricted`), each drawn from {@link ACCEPTED_LEVELS}; the
 * `-version` values are `api.VersionLatest`.
 */
const LABEL_VOCABULARY: readonly PodSecurityLabelRow[] = [
  {
    label: `${LABEL_PREFIX}enforce`,
    value: 'baseline',
    effect: 'Rejects a violating pod at admission.',
  },
  {
    label: `${LABEL_PREFIX}enforce-version`,
    value: LATEST_VERSION,
    effect: 'Pins the policy version the enforced level is evaluated against.',
  },
  {
    label: `${LABEL_PREFIX}warn`,
    value: 'restricted',
    effect: 'Admits a violating pod and returns a warning to the client.',
  },
  {
    label: `${LABEL_PREFIX}warn-version`,
    value: LATEST_VERSION,
    effect: 'Pins the policy version the warned level is evaluated against.',
  },
  {
    label: `${LABEL_PREFIX}audit`,
    value: 'restricted',
    effect: 'Admits a violating pod and records an audit annotation.',
  },
  {
    label: `${LABEL_PREFIX}audit-version`,
    value: LATEST_VERSION,
    effect: 'Pins the policy version the audited level is evaluated against.',
  },
];

/**
 * The heading rendered for each verdict.
 *
 * INVARIANT LOCKED, and it is the load-bearing one in this file (AAP §0.11.1,
 * "never weaken a boundary condition to make a test pass"): `warn` has its OWN
 * heading, textually unlike both `pass` and `fail`. Under `warn=restricted` the
 * oracle requires the pod to be ADMITTED — no error — and simultaneously
 * requires at least one warning to have been surfaced. Rendering that as a
 * failure is wrong, and rendering it as a clean pass is equally wrong, because
 * each of those loses one half of the assertion. It gets a third affordance.
 *
 * A `Record` keyed on the union rather than a `switch` is deliberate: the four
 * arms are exhaustive by TYPE, so there is no unreachable default branch to
 * depress the branch coverage this tier is held to (AAP §0.7.1.3), and adding a
 * fifth verdict upstream would fail `tsc` here rather than silently fall through
 * to a default.
 */
const VERDICT_HEADINGS: Record<ControlVerdict, string> = {
  pass: 'Enforcement verified',
  fail: 'Enforcement violated',
  warn: 'Admitted with warnings',
  unknown: 'Posture unknown',
};

/** The sentence announced alongside each verdict heading. */
const VERDICT_EXPLANATIONS: Record<ControlVerdict, string> = {
  pass: 'The enforced level rejected every violating pod and the warned level objected as expected.',
  fail: 'At least one required rejection or warning did not occur.',
  warn:
    'The operation was permitted and the server objected to it. This is neither a clean pass nor ' +
    'a failure: the warned level is expected to admit the pod and still return a warning.',
  unknown:
    'No trustworthy evidence was obtained, so no verdict is claimed. Absent evidence is not a pass.',
};

/**
 * Appended to the failure explanation to point at where the detail actually is.
 *
 * Three pointers rather than one, because a failure can be substantiated in two
 * different places and occasionally in neither, and a fixed sentence would send
 * the reader somewhere empty. AAP §0.7.2's "failure legibility" criterion exists
 * for exactly this: the person reading a failure is often not the person who
 * wrote the test, so the failure has to say where to look. In particular a
 * verdict downgraded by {@link resolveVerdict} has NO findings to read — its
 * whole substance is the warning-channel region — so it must not be sent to a
 * findings list that was never rendered.
 */
const FAIL_POINTERS = {
  findings: ' See the reported findings.',
  warnChannel: ' See the warning channel check below.',
  none: ' The server reported no further detail.',
} as const;

/**
 * Chooses the pointer that matches what is actually on screen.
 *
 * Ordered by specificity of the evidence rendered: a findings list first, then
 * the warning-channel region, then an explicit admission that neither exists.
 */
function failPointer(findingCount: number, warnChannelEmpty: boolean): string {
  if (findingCount > 0) {
    return FAIL_POINTERS.findings;
  }
  if (warnChannelEmpty) {
    return FAIL_POINTERS.warnChannel;
  }
  return FAIL_POINTERS.none;
}

/**
 * The full announced sentence for a verdict.
 *
 * Only the failure arm is elaborated, because it is the only one that refers the
 * reader elsewhere.
 */
function explainVerdict(
  verdict: ControlVerdict,
  findingCount: number,
  warnChannelEmpty: boolean,
): string {
  if (verdict === 'fail') {
    return VERDICT_EXPLANATIONS.fail + failPointer(findingCount, warnChannelEmpty);
  }
  return VERDICT_EXPLANATIONS[verdict];
}

/**
 * Rendered when the warned level reports no warning at all.
 *
 * This mirrors the oracle's own message (`podsecurity_test.go` L454): a warned
 * level that admits the pod and stays silent has lost the control, so an empty
 * warning channel is itself a failure rather than a quiet success.
 */
const EMPTY_WARN_CHANNEL_MESSAGE =
  `Expected at least one Pod Security warning under ${WARN_LABEL}=restricted, and none was ` +
  `surfaced. A warned level that admits ${WARN_POD} without objecting to it does not exercise ` +
  'the control.';

/** Accessible name and visible text of the re-request control. */
const REFRESH_LABEL = 'Re-check Pod Security enforcement';

/**
 * Renders one {@link ControlObservation} value as text.
 *
 * Invariant locked: `null` is rendered as the literal word `null`, and that is a
 * DELIBERATE departure from the usual advice never to show `null` in a user
 * interface. `ControlObservation.value` documents `null` as a REPRESENTABLE
 * value rather than a missing one — the V4 oracle asserts that two token
 * sub-claims are exactly `null` — so blanking it would erase an assertion by
 * making "reported as null" indistinguishable from "not reported". Absent
 * observations are handled by omitting the row entirely, never by blanking a
 * value. Nothing here rounds, re-scales or re-parses; every value is surfaced
 * exactly as it arrived.
 */
function formatObservationValue(value: ControlObservation['value']): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return value;
}

/**
 * The verdict actually rendered, together with why it may differ from the
 * server's.
 *
 * Invariant locked (AAP §0.11.1, "never weaken a boundary condition to make a
 * test pass"): a `warn` verdict carrying an EMPTY warning list is downgraded to
 * `fail`. The oracle requires at least one warning under `warn=restricted`
 * (`podsecurity_test.go` L452-456), so silence there is a failure of the control
 * and not a quieter kind of success. This is the only place the rendered verdict
 * departs from the reported one, and it only ever moves in the strict direction.
 */
function resolveVerdict(status: ControlStatus): {
  readonly verdict: ControlVerdict;
  readonly warnChannelEmpty: boolean;
} {
  const warnChannelEmpty = status.verdict === 'warn' && status.warnings.length === 0;
  return { verdict: warnChannelEmpty ? 'fail' : status.verdict, warnChannelEmpty };
}

/** Props of {@link LabelledRegion}. */
interface LabelledRegionProps {
  /** Visible heading, and the region's accessible name. */
  readonly title: string;
  /** Region body. */
  readonly children: ReactNode;
}

/**
 * A nested landmark with an accessible name.
 *
 * A `section` is only exposed as a `region` once it HAS a name, so the heading is
 * wired to it with `aria-labelledby` rather than merely placed inside it. That is
 * what makes every block of this panel reachable by role and name.
 */
function LabelledRegion({ title, children }: LabelledRegionProps): ReactNode {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
    </section>
  );
}

/** Props of {@link PanelFrame}. */
interface PanelFrameProps {
  /**
   * Re-request handler. Absent in the pre-resolved form, where the panel owns no
   * request of its own to re-issue.
   */
  readonly refresh?: (() => void) | undefined;
  /** Requirement identifiers to attribute the panel's contents to. */
  readonly requirementIds: readonly string[];
  /** Panel body: one of the loading, error, empty or resolved states. */
  readonly children: ReactNode;
}

/**
 * The panel's landmark, heading, requirement attribution and re-request control.
 *
 * Shared by every state so that the landmark, its accessible name and the
 * refresh affordance are present whether the panel is loading, broken, empty or
 * resolved. A refresh control that vanished exactly when a request had failed
 * would be unusable at the only moment it matters.
 */
function PanelFrame({ refresh, requirementIds, children }: PanelFrameProps): ReactNode {
  const titleId = useId();

  const handleRefresh = (): void => {
    if (refresh === undefined) {
      // Pre-resolved form: the caller supplied a status directly and did not
      // supply a handler, so there is nothing to re-issue. The control stays
      // present and operable rather than disappearing, because its absence in
      // one form and presence in another would be the inconsistency.
      return;
    }
    refresh();
  };

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>{PANEL_TITLE}</h2>
      <p>{PANEL_DESCRIPTION}</p>
      <p>{`Requirements covered: ${requirementIds.join(', ')}`}</p>
      <button type="button" onClick={handleRefresh}>
        {REFRESH_LABEL}
      </button>
      {children}
    </section>
  );
}

/**
 * The enforced level's required rejections.
 *
 * Every row is a `th scope="row"` keyed on the pod name, so each of the two
 * measured rejections is individually addressable, and each renders BOTH the
 * status code and the reason.
 */
function EnforcementRejections(): ReactNode {
  return (
    <LabelledRegion title={`Admission rejections required under ${ENFORCE_LABEL}=baseline`}>
      <p>
        {`In namespace ${ENFORCE_NAMESPACE}, labelled ${ENFORCE_LABEL}=baseline, each of the ` +
          'following pods must be rejected at admission.'}
      </p>
      <table>
        <caption>{`Required admission rejections in ${ENFORCE_NAMESPACE}`}</caption>
        <thead>
          <tr>
            <th scope="col">Pod</th>
            <th scope="col">Violation</th>
            <th scope="col">Admission rejection code</th>
            <th scope="col">Admission rejection reason</th>
          </tr>
        </thead>
        <tbody>
          {ENFORCEMENT_REJECTIONS.map((rejection) => (
            <tr key={rejection.pod}>
              <th scope="row">{rejection.pod}</th>
              <td>{rejection.violation}</td>
              <td>{rejection.status}</td>
              <td>{rejection.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </LabelledRegion>
  );
}

/**
 * The warned level's warnings, surfaced verbatim and in order.
 *
 * Rendered under a heading that is textually unlike anything the failure path
 * uses, because a warning is a distinct outcome rather than a softer failure.
 */
function WarningsRegion({ warnings }: { readonly warnings: readonly string[] }): ReactNode {
  const title = `Warnings surfaced under ${WARN_LABEL}=restricted`;
  return (
    <LabelledRegion title={title}>
      <p>
        {`In namespace ${WARN_NAMESPACE}, labelled ${WARN_LABEL}=restricted, pod ${WARN_POD} was ` +
          'admitted — the enforced level is left at the cluster default privileged — and the ' +
          'server objected to it.'}
      </p>
      <ul aria-label={title}>
        {warnings.map((warning, index) => (
          // The index participates in the key because the warning channel is an
          // ordered list of plain strings that may legitimately repeat, and
          // collapsing duplicates would under-report what the server said.
          <li key={`${String(index)}-${warning}`}>{warning}</li>
        ))}
      </ul>
    </LabelledRegion>
  );
}

/** The warned level admitted the pod and said nothing — a failure of the control. */
function EmptyWarnChannel(): ReactNode {
  return (
    <LabelledRegion title="Warning channel check failed">
      <p>{EMPTY_WARN_CHANNEL_MESSAGE}</p>
    </LabelledRegion>
  );
}

/**
 * Every reported finding, never only the first.
 *
 * The list shape mirrors the oracle's accumulate-and-continue reporting, where
 * each offending object is recorded and the run carries on.
 */
function FindingsRegion({ findings }: { readonly findings: readonly ControlFinding[] }): ReactNode {
  const title = 'Reported findings';
  return (
    <LabelledRegion title={title}>
      <ul aria-label={title}>
        {findings.map((finding: ControlFinding, index) => (
          <li key={`${String(index)}-${finding.message}`}>
            {finding.subject === undefined ? null : <strong>{`${finding.subject}: `}</strong>}
            {finding.message}
            {finding.requirementId === undefined ? null : ` (${finding.requirementId})`}
          </li>
        ))}
      </ul>
    </LabelledRegion>
  );
}

/** The namespace label vocabulary, named exactly as the API constants declare it. */
function LabelVocabulary(): ReactNode {
  return (
    <LabelledRegion title="Namespace label vocabulary">
      <table>
        <caption>{`Namespace labels in the ${LABEL_PREFIX} group`}</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Value</th>
            <th scope="col">Effect</th>
          </tr>
        </thead>
        <tbody>
          {LABEL_VOCABULARY.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
              <td>{row.effect}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{`Accepted level values: ${ACCEPTED_LEVELS.join(', ')}.`}</p>
    </LabelledRegion>
  );
}

/** Measured facts backing the verdict, tabulated verbatim. */
function ObservationsRegion({
  observations,
}: {
  readonly observations: readonly ControlObservation[];
}): ReactNode {
  return (
    <LabelledRegion title="Observed evidence">
      <table>
        <caption>Evidence reported for this control</caption>
        <thead>
          <tr>
            <th scope="col">Measurement</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((observation, index) => (
            <tr key={`${String(index)}-${observation.label}`}>
              <th scope="row">{observation.label}</th>
              <td>{formatObservationValue(observation.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </LabelledRegion>
  );
}


/**
 * The request is in flight.
 *
 * A live region rather than a heading, because this state exists to be announced
 * when it changes and to be replaced as soon as it resolves.
 */
function LoadingState(): ReactNode {
  return <p role="status">Loading Pod Security enforcement posture…</p>;
}

/**
 * The request succeeded but carried nothing about this control.
 *
 * Invariant locked: an absent report is NOT a pass. The two ways of arriving
 * here are distinguished in the text — the server reported no controls at all,
 * or it reported some and this was not among them — because the second is a
 * contract problem worth telling apart from an idle server.
 */
function EmptyState({ isEmpty }: { readonly isEmpty: boolean }): ReactNode {
  const title = 'No Pod Security posture reported';
  return (
    <div role="status">
      <h3>{title}</h3>
      <p>
        {isEmpty
          ? 'The status endpoint reported no controls at all.'
          : `The status endpoint reported other controls but did not mention ${CONTROL_ID}.`}
      </p>
      <p>No verdict is claimed, because no evidence was received.</p>
    </div>
  );
}

/**
 * The posture request itself failed.
 *
 * Invariant locked (AAP §0.11.1, "no false passes"): this is the ONLY thing a
 * non-2xx response can render. `ControlStatusErrorResult` carries no `controls`
 * member at all, so reaching a verdict from a failed request is a `tsc` error
 * under `strict` rather than a code-review question — a 403 or a 500 on the
 * status endpoint is structurally incapable of becoming a pass.
 *
 * DISAMBIGUATION, deliberately restated at the point of use because it is the
 * easiest thing in this file to get subtly wrong. A 403 HERE means the status
 * endpoint refused THIS CLIENT, so nothing whatsoever is known about the
 * control. A 403 in {@link EnforcementRejections} means the API server refused a
 * violating POD, which is the control working exactly as required. Same number,
 * opposite meaning. They are kept apart in the code by living in different
 * components, and apart in the interface by wording that never overlaps: this
 * component says "status endpoint" and never "admission", and that one says
 * "admission rejection" and never "status endpoint".
 */
function PostureRequestFailure({ error }: { readonly error: ControlStatusError }): ReactNode {
  const title = 'Pod Security posture request failed';
  return (
    <div role="alert">
      <h3>{title}</h3>
      <p>{error.message}</p>
      <ul aria-label={title}>
        <li>{`Status endpoint failure kind: ${error.kind}`}</li>
        {error.httpStatus === undefined ? null : (
          <li>{`Status endpoint response code: ${String(error.httpStatus)}`}</li>
        )}
        {error.reason === undefined ? null : (
          <li>{`Status endpoint response reason: ${error.reason}`}</li>
        )}
      </ul>
      <p>
        No verdict is claimed. A refused or failed status request is never a pass, and it says
        nothing either way about how the API server treats a violating pod.
      </p>
    </div>
  );
}

/**
 * The resolved control: its verdict, its evidence and the contract it is held to.
 *
 * The verdict is rendered exactly once, from {@link VERDICT_HEADINGS}, so the
 * three outcomes are mutually exclusive by construction: an admitted-with-warning
 * control shows the `warn` heading and therefore shows NEITHER the failure
 * heading nor the clean-pass heading. That is the invariant this whole component
 * exists to protect.
 */
function ControlBody({ status }: { readonly status: ControlStatus }): ReactNode {
  const { verdict, warnChannelEmpty } = resolveVerdict(status);
  const observations = status.evidence?.observations;
  const hasObservations = observations !== undefined && observations.length > 0;

  return (
    <>
      <h3>{VERDICT_HEADINGS[verdict]}</h3>
      <p role="status">
        {explainVerdict(verdict, status.findings.length, warnChannelEmpty)}
      </p>
      <p>{status.summary}</p>
      {status.detail === undefined ? null : <p>{status.detail}</p>}
      {status.observedAt === undefined ? null : (
        <p>
          {'Observed at '}
          <time dateTime={status.observedAt}>{status.observedAt}</time>
        </p>
      )}

      <EnforcementRejections />

      {/* A warned level that admitted the pod and said nothing has lost the
          control, so that case reports the failure instead of an empty list. */}
      {warnChannelEmpty ? <EmptyWarnChannel /> : null}
      {status.warnings.length > 0 ? <WarningsRegion warnings={status.warnings} /> : null}
      {status.findings.length > 0 ? <FindingsRegion findings={status.findings} /> : null}
      {hasObservations ? <ObservationsRegion observations={observations} /> : null}

      <LabelVocabulary />
    </>
  );
}

/** Props of {@link ResolvedPodSecurityPanel} and {@link ResultPodSecurityPanel}. */
interface ConnectedProps {
  /** See {@link PodSecurityPanelProps.onRefresh}. */
  readonly onRefresh?: (() => void) | undefined;
}

/** Renders a status the caller already holds. */
function ResolvedPodSecurityPanel({
  status,
  onRefresh,
}: ConnectedProps & { readonly status: ControlStatus }): ReactNode {
  return (
    <PanelFrame refresh={onRefresh} requirementIds={status.requirementIds ?? COVERED_REQUIREMENT_IDS}>
      <ControlBody status={status} />
    </PanelFrame>
  );
}

/**
 * Renders one arm of the hook's discriminated union.
 *
 * Narrowing on `status` first is what keeps the four states — loading, error,
 * empty and resolved — separately observable, and what makes a verdict
 * unreachable from the error arm.
 */
function ResultPodSecurityPanel({
  result,
  onRefresh,
}: ConnectedProps & { readonly result: UseControlStatusResult }): ReactNode {
  // An explicit handler REPLACES the panel's own, rather than running alongside
  // it, so a click can never issue two requests.
  const refresh = onRefresh ?? result.refresh;

  if (result.status === 'loading') {
    return (
      <PanelFrame refresh={refresh} requirementIds={COVERED_REQUIREMENT_IDS}>
        <LoadingState />
      </PanelFrame>
    );
  }

  if (result.status === 'error') {
    return (
      <PanelFrame refresh={refresh} requirementIds={COVERED_REQUIREMENT_IDS}>
        <PostureRequestFailure error={result.error} />
      </PanelFrame>
    );
  }

  const status = selectControlStatus(result.controls, CONTROL_ID);
  if (status === undefined) {
    return (
      <PanelFrame refresh={refresh} requirementIds={COVERED_REQUIREMENT_IDS}>
        <EmptyState isEmpty={result.isEmpty} />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame refresh={refresh} requirementIds={status.requirementIds ?? COVERED_REQUIREMENT_IDS}>
      <ControlBody status={status} />
    </PanelFrame>
  );
}

/** Reads the control's posture itself. */
function ConnectedPodSecurityPanel({ onRefresh }: ConnectedProps): ReactNode {
  const result = useControlStatus(CONTROL_ID);
  return <ResultPodSecurityPanel result={result} onRefresh={onRefresh} />;
}

/** Props of {@link PodSecurityPanel}. Every member is optional. */
export interface PodSecurityPanelProps {
  /**
   * A pre-resolved status to render instead of reading one. Takes precedence
   * over {@link PodSecurityPanelProps.result}, being the more specific of the
   * two.
   */
  readonly status?: ControlStatus | undefined;
  /**
   * A hook result to render instead of reading one — the whole discriminated
   * union, so the loading, error and empty arms are renderable too.
   */
  readonly result?: UseControlStatusResult | undefined;
  /**
   * Replaces the re-request handler. This is the only handler available in the
   * pre-resolved form, where the panel owns no request of its own.
   */
  readonly onRefresh?: (() => void) | undefined;
}

/**
 * The presentation surface for V2, Pod Security enforcement.
 *
 * INVARIANT LOCKED BY THIS COMPONENT: an enforced `baseline` level rejects a
 * privileged pod and a hostPID pod with 403 Forbidden, while a warned
 * `restricted` level ADMITS a plain pod and yet surfaces at least one warning —
 * and a warning is neither a failure nor a clean pass. It is rendered as a third,
 * distinct affordance, because collapsing it into either neighbour loses one half
 * of the behaviour the control depends on.
 *
 * Three further invariants follow from that one:
 *
 *   1. A warned level that admits the pod and reports NO warning is a FAILURE,
 *      not a quiet success — the oracle requires at least one warning.
 *   2. A 403 or 500 on the status endpoint renders the failure affordance and
 *      never a verdict, and is kept rigorously distinct from an observed 403
 *      admission rejection, which is the control working correctly.
 *   3. Absent evidence — an empty payload, or a payload that does not mention
 *      this control — is `unknown` or empty, never a pass.
 *
 * Data comes from `useControlStatus`, never from a direct `fetch`: this component
 * performs no I/O of its own. Supplying `status` or `result` renders that instead,
 * which is what lets every state be exercised without a network at all. Because
 * a hook may not be called conditionally, the propped forms are dispatched to
 * sibling components rather than guarded inside one — the choice of COMPONENT is
 * conditional, the hook call inside each is not.
 *
 * @param props - see {@link PodSecurityPanelProps}; all members are optional.
 * @returns the panel's landmark, named for assistive technology.
 */
export default function PodSecurityPanel({
  status,
  result,
  onRefresh,
}: PodSecurityPanelProps): ReactNode {
  if (status !== undefined) {
    return <ResolvedPodSecurityPanel status={status} onRefresh={onRefresh} />;
  }
  if (result !== undefined) {
    return <ResultPodSecurityPanel result={result} onRefresh={onRefresh} />;
  }
  return <ConnectedPodSecurityPanel onRefresh={onRefresh} />;
}

