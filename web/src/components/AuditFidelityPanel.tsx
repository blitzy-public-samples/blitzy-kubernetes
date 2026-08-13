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

// AAP §0.5.1 / §0.4.2.4 (L6 React tier, V6) / tech-spec §6.4.6.
//
// The presentation surface for V6 — sensitive-resource audit fidelity, feature
// F-006, requirements F-006-RQ-002 and F-006-RQ-003.
//
// NO PARITY ANCESTOR. This tier ports nothing. `blitzy/documentation/Project
// Guide.md` L133 records that "This is a control-plane/configuration project
// with **no UI surface**", so there is no prior component, no prior spec and no
// prior markup to be faithful to. AAP §0.10.3 resolves that explicitly: the
// React tier's parity anchor is "the REST and CLI behaviour it surfaces rather
// than a pre-existing UI test suite". Every audit level named below is therefore
// transcribed from a measured line of the Go oracle — which this workstream
// never deletes, because the DELETE set of AAP §0.5.1 is empty by design — and
// nothing is invented:
//
//   * cluster/gce/gci/audit_policy_test.go — the level aliases at L120-125, the
//     fourteen principals at L74-89, the resource selectors at L94-117 and the
//     assertions themselves at L132-183. Every row of
//     AUDIT_LEVEL_EXPECTATIONS below carries the exact line it came from, and
//     renders it, so the table can be re-checked against the oracle by reading
//     it rather than by trusting it.
//   * test/integration/controlplane/audit/audit_test.go — the observed-event
//     expectations of `secretAuditRequestEvents` (namespace
//     `secret-audit-request`, L812-851) and `rbacAuditResponseEvents`
//     (namespace `rbac-audit-response`, L859-948), plus the confidentiality
//     guard at L1043-1047, whose Go form accumulates with `t.Errorf` so that
//     EVERY offending event is reported in one run rather than only the first.
//   * test/utils/audit.go L151-156, which flattens `ResponseObject` to a
//     presence boolean for Go-side struct comparison only. That flattening is a
//     Go-test detail and must not leak into the client: the wire carries the
//     object, web/src/hooks/useAuditEvents.ts models the wire, and this
//     component reads only the PRESENCE of a payload — never its contents.
//
// INVARIANT LOCKED BY THIS COMPONENT (tech-spec §6.6.3.4 requires that it be
// stated, and AAP §0.10.2 forbids that it be weakened):
//
//   The per-resource audit level rendered for `secrets` is exactly `Request`
//   and never `RequestResponse`, and the level ordering
//   `None < Metadata < Request < RequestResponse` is a STRICT TOTAL ORDER that
//   can never be silently downgraded.
//
// HOW THAT ORDERING IS KEPT AN ORDERING RATHER THAN A LABEL SET.
// `AuditLevel` is a union, and a union is unordered, so rendering a bare level
// name would present four peers and lose the relation entirely — at which point
// a regression that promoted `secrets` to `RequestResponse` (writing Secret
// response bodies into the audit log) or demoted it to `Metadata` (losing the
// forensic record) would render as just another value. Three measures prevent
// that, and none of them re-states the order:
//
//   1. The order has exactly ONE definition site, `AUDIT_LEVEL_ORDER` in
//      web/src/hooks/useAuditEvents.ts, which is IMPORTED here. There is no
//      local copy of it to drift, and `auditLevelRank` derives every rank from
//      that array by index.
//   2. Every rendered level carries its ordinal — "Request (3 of 4)" — so a
//      lower level can never display as equivalent to, or better than, a higher
//      one, and the legend spells the relation out in full.
//   3. `describeLevelDeviation` compares an OBSERVED event
//      against the required `Request` using those ranks and reports an
//      over-collection and an under-collection as two DIFFERENT findings. A
//      panel that only checked inequality could not tell a leak from a gap.
//
// NO EXTERNAL BENCHMARK IS NAMED ANYWHERE IN THIS FILE. AAP §0.11.1 permits
// citing "only what the repository states", and AAP §0.8.2 records that the
// repository enumerates no benchmark control identifiers, so none is asserted —
// not in an identifier, not in a comment, not in a string, not in an accessible
// name and not in a label. The repository's own requirement identifiers,
// F-006-RQ-002 and F-006-RQ-003, are used in their place. The thematic
// "standards alignment" prose of blitzy/documentation/Project Guide.md §5 is a
// status-document narrative and is deliberately NOT carried into this component.
//
// DEPENDENCY DISCIPLINE (AAP §0.11.1, "respect the surviving freeze").
// The imports below are `react` and the two sibling hook modules, all three
// already fixed by AAP §0.6.1.2 and web/package.json. No design system, no
// component library, no CSS framework, no router, no data-fetching library and
// no icon set is introduced, so web/package-lock.json stays in step and
// `npm ci` keeps working. No Node global is referenced — @types/node is
// deliberately absent from this tier — and no `fetch` call is made here: every
// byte of data reaches this component either through a prop or through
// `useControlStatus`.
import { useCallback, useId, useMemo, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';

import {
  readCount,
  readNumber,
  readString,
  selectObservation,
  strictestVerdict,
  type EffectiveVerdict,
} from '../domain/evidence';
import { V6_OBSERVATIONS, v6ResourceLevelObservation } from '../domain/observationIds';
import {
  describeStatusReason,
  safeLabel,
  safeObservationValue,
  safeProse,
} from '../domain/safeText';
import type { AuditEvent, AuditLevel } from '../hooks/useAuditEvents';
import {
  AUDIT_LEVEL_ORDER,
  isConfidentialAuditIdentity,
  resolveAuditResourceIdentity,
} from '../hooks/useAuditEvents';
import type {
  ControlId,
  ControlObservation,
  ControlStatus,
  ControlStatusError,
  ControlVerdict,
  UseControlStatusResult,
} from '../hooks/useControlStatus';
import { selectControlStatus, useControlStatus } from '../hooks/useControlStatus';
import { REFRESH_UNAVAILABLE_TITLE, resolveRefreshHandler } from './refreshContract';
import {
  useLiveRegionRole,
  usePanelLabelId,
  usePanelSubheading,
  useRendersOwnHeading,
} from './embeddedPanel';

/**
 * The control this panel reports on.
 *
 * Annotated as `ControlId` rather than left as a bare string so that a typo
 * cannot compile: the identifier must be one of the eight members of
 * `CONTROL_IDS` declared in web/src/hooks/useControlStatus.ts.
 */
const AUDIT_FIDELITY_CONTROL_ID: ControlId = 'V6';

/**
 * The repository's own requirement identifiers this panel covers.
 *
 * F-006-RQ-002 is sensitive-resource audit event emission and level projection;
 * F-006-RQ-003 is the audit-fidelity profile default. Naming them makes a
 * failure read as a requirement violation rather than as a value mismatch,
 * which is the "failure legibility" criterion of AAP §0.7.2.
 */
const COVERED_REQUIREMENT_IDS: readonly string[] = Object.freeze([
  'F-006-RQ-002',
  'F-006-RQ-003',
]);

/** Path of the shell-tier oracle every generated-policy row is measured from. */
const POLICY_ORACLE = 'cluster/gce/gci/audit_policy_test.go';

/** Path of the integration-tier oracle every observed-event row is measured from. */
const AUDIT_ORACLE = 'test/integration/controlplane/audit/audit_test.go';

/**
 * The resource whose level is the load-bearing V6 boundary condition.
 *
 * Held as a constant because three separate places must agree on it: the
 * expectation rows, the observed-event guard and the legend.
 */
const SECRETS_RESOURCE = 'secrets';

/**
 * The level `secrets` must be audited at — exactly this, never more and never
 * less.
 *
 * `Request` records the request object and omits the response object, so a read
 * never writes secret data to the audit log while a write still leaves a
 * forensic record. That the request body survives on create and update is the
 * explicitly accepted trade-off recorded in the integration oracle at
 * L1040-1042, not a defect. Promoting this to `RequestResponse` would begin
 * logging Secret response bodies; demoting it to `Metadata` would erase the
 * forensic record.
 */
const SECRETS_REQUIRED_LEVEL: AuditLevel = 'Request';

/**
 * The two node identities of the generated-policy matrix, in the order the
 * policy oracle declares them (L77-78).
 *
 * Extracted so the rows that share a principal group reference one list instead
 * of repeating it, which is what stops a future edit from updating one copy and
 * leaving another behind.
 */
const NODE_PRINCIPALS: readonly string[] = Object.freeze([
  'kubelet',
  'system:node:node-123',
]);

/**
 * The four non-privileged workload identities that share the widest block of
 * the generated-policy matrix (policy oracle L177-181), in declaration order
 * (L87, L74, L83, L85).
 */
const WORKLOAD_PRINCIPALS: readonly string[] = Object.freeze([
  'system:serviceaccount:default:default',
  'system:anonymous',
  'system:node-problem-detector',
  'system:serviceaccount:kube-system:namespace-controller',
]);

/**
 * One measured expectation: the audit level the policy assigns to a
 * (principal set, verb set, resource selector) cell of the oracle's matrix.
 *
 * Exported because the `expectations` prop of {@link AuditFidelityPanelProps}
 * accepts a list of these, and a caller that declares the list with an explicit
 * type annotation needs the type. Nothing else in this module is exported.
 *
 * Invariant locked: a single resource may legitimately carry DIFFERENT levels
 * for different verbs and for different principals, so the unit of this type is
 * one matrix cell rather than one resource. `clusterroles` is the worked
 * example — `Request` on `get`/`list`/`watch` and `RequestResponse` on
 * `create`/`update`/`patch`/`delete` — and `configmaps` in `kube-system` is the
 * second, sitting at `None` for some principals and `Metadata` for others.
 * Collapsing either into one row per resource would force a choice between two
 * measured truths, and whichever was dropped would be a silently weakened
 * boundary condition.
 */
export interface AuditLevelExpectation {
  /**
   * Stable identifier for the row, unique within a list. Used as the React key
   * and as the row's `id`, so it must not collide.
   */
  readonly id: string;
  /**
   * The resource selector exactly as the policy names it, including any
   * subresource — `secrets`, `serviceaccounts/token`, `clusterroles`.
   */
  readonly resource: string;
  /**
   * The API group. The empty string is the core group, and is rendered as such
   * rather than as an absent value, because "core" is a real answer.
   */
  readonly apiGroup: string;
  /** Human-readable scope, e.g. `namespace default` or `cluster-scoped`. */
  readonly scope: string;
  /** The verbs this cell covers, in oracle order. */
  readonly verbs: readonly string[];
  /** The principals this cell covers, in oracle order. */
  readonly principals: readonly string[];
  /** The level the policy assigns. Rendered with its ordinal, never bare. */
  readonly level: AuditLevel;
  /**
   * Where the row was measured — a repository path and line range. Rendered, so
   * the table cites its own evidence and can be re-verified by reading it.
   */
  readonly measuredIn: string;
  /**
   * The observation identity under which THIS CHECK reports the level it observed, when
   * one exists.
   *
   * M6 — THIS IS WHAT SEPARATES EXPECTED FROM OBSERVED. Every row's `level` is
   * transcribed from an oracle: it is what the policy is REQUIRED to assign, and it is
   * true of the repository whether or not any check ran. The table nevertheless carried a
   * column headed "Audit level" and a caption reading "Measured per-resource audit
   * levels", so a reader saw nineteen rows of static expectations presented as nineteen
   * measurements. Rows that the integration check actually reports carry an identity here
   * and render the observed value beside the required one; rows measured only by the shell
   * generator carry none and say so, rather than borrowing the credibility of the ones
   * that were measured.
   */
  readonly observedIdentity?: string;
}

/**
 * The measured per-resource audit levels, transcribed cell by cell from the
 * oracle.
 *
 * Every row cites the line it came from and nothing is rounded, merged,
 * reordered or inferred. Read as a whole the table establishes the V6 boundary
 * conditions of AAP §0.10.2:
 *
 *   * `secrets` appears FOUR times — three cells of the generated policy plus
 *     the integration expectation — and is `Request` in every one of them.
 *     There is no cell in which it is `RequestResponse`, which is the invariant
 *     this component exists to make visible.
 *   * `serviceaccounts/token` is `Request`, for the same reason: at `Request`
 *     the issued credential, which appears only in the response, is never
 *     written to the log.
 *   * `configmaps` is `Metadata` in the default namespace, and in `kube-system`
 *     is `None` or `Metadata` depending on the principal — both measured, both
 *     kept.
 *   * `tokenreviews` is `Metadata`.
 *   * `clusterroles` is `Request` on reads and `RequestResponse` on writes.
 *   * `roles` and `rolebindings` are `RequestResponse`, the level RBAC objects
 *     stay at for full forensic detail.
 */
const AUDIT_LEVEL_EXPECTATIONS: readonly AuditLevelExpectation[] = Object.freeze([
  {
    id: 'secrets-node-read',
    resource: SECRETS_RESOURCE,
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['get']),
    principals: NODE_PRINCIPALS,
    level: 'Request',
    measuredIn: `${POLICY_ORACLE} L143`,
  },
  {
    id: 'secrets-apiserver-write',
    resource: SECRETS_RESOURCE,
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['get', 'create', 'update']),
    principals: Object.freeze(['system:apiserver']),
    level: 'Request',
    measuredIn: `${POLICY_ORACLE} L156`,
  },
  {
    id: 'secrets-workload-write',
    resource: SECRETS_RESOURCE,
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['get', 'create', 'update']),
    principals: WORKLOAD_PRINCIPALS,
    level: 'Request',
    measuredIn: `${POLICY_ORACLE} L178`,
  },
  {
    id: 'secrets-observed-write',
    resource: SECRETS_RESOURCE,
    apiGroup: '',
    scope: 'namespace secret-audit-request',
    verbs: Object.freeze(['create', 'update', 'delete']),
    principals: Object.freeze(['system:apiserver']),
    level: 'Request',
    measuredIn: `${AUDIT_ORACLE} L812-851`,
    observedIdentity: v6ResourceLevelObservation('', [SECRETS_RESOURCE], 'secret-audit-request'),
  },
  {
    id: 'serviceaccount-token-create',
    resource: 'serviceaccounts/token',
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['create']),
    principals: Object.freeze(['system:serviceaccount:default:default', 'system:apiserver']),
    level: 'Request',
    measuredIn: `${POLICY_ORACLE} L179`,
  },
  {
    id: 'configmaps-default-unsecured-read',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['get']),
    principals: Object.freeze(['system:unsecured']),
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L136`,
  },
  {
    id: 'configmaps-default-autoscaler',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['get', 'update']),
    principals: Object.freeze(['cluster-autoscaler']),
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L159`,
  },
  {
    id: 'configmaps-default-workload',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace default',
    verbs: Object.freeze(['get', 'create', 'update']),
    principals: WORKLOAD_PRINCIPALS,
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L177`,
  },
  {
    id: 'configmaps-kube-system-unsecured-read',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace kube-system',
    verbs: Object.freeze(['get']),
    principals: Object.freeze(['system:unsecured']),
    level: 'None',
    measuredIn: `${POLICY_ORACLE} L135`,
  },
  {
    id: 'configmaps-kube-system-autoscaler',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace kube-system',
    verbs: Object.freeze(['get', 'update']),
    principals: Object.freeze(['cluster-autoscaler']),
    level: 'None',
    measuredIn: `${POLICY_ORACLE} L158`,
  },
  {
    id: 'configmaps-kube-system-node-read',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace kube-system',
    verbs: Object.freeze(['get']),
    principals: NODE_PRINCIPALS,
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L142`,
  },
  {
    id: 'configmaps-kube-system-apiserver',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace kube-system',
    verbs: Object.freeze(['get', 'create', 'update']),
    principals: Object.freeze(['system:apiserver']),
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L155`,
  },
  {
    id: 'configmaps-kube-system-workload',
    resource: 'configmaps',
    apiGroup: '',
    scope: 'namespace kube-system',
    verbs: Object.freeze(['get', 'create', 'update']),
    principals: WORKLOAD_PRINCIPALS,
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L177`,
  },
  {
    id: 'tokenreviews-workload',
    resource: 'tokenreviews',
    apiGroup: 'authentication.k8s.io',
    scope: 'cluster-scoped',
    verbs: Object.freeze(['get', 'create', 'update']),
    principals: WORKLOAD_PRINCIPALS,
    level: 'Metadata',
    measuredIn: `${POLICY_ORACLE} L177`,
  },
  {
    id: 'clusterroles-read',
    resource: 'clusterroles',
    apiGroup: 'rbac.authorization.k8s.io',
    scope: 'cluster-scoped',
    verbs: Object.freeze(['get', 'list', 'watch']),
    principals: WORKLOAD_PRINCIPALS,
    level: 'Request',
    measuredIn: `${POLICY_ORACLE} L180`,
  },
  {
    id: 'clusterroles-write',
    resource: 'clusterroles',
    apiGroup: 'rbac.authorization.k8s.io',
    scope: 'cluster-scoped',
    verbs: Object.freeze(['create', 'update', 'patch', 'delete']),
    principals: WORKLOAD_PRINCIPALS,
    level: 'RequestResponse',
    measuredIn: `${POLICY_ORACLE} L181`,
  },
  {
    id: 'roles-write',
    resource: 'roles',
    apiGroup: 'rbac.authorization.k8s.io',
    scope: 'namespace rbac-audit-response',
    verbs: Object.freeze(['create', 'update', 'delete']),
    principals: Object.freeze(['system:apiserver']),
    level: 'RequestResponse',
    measuredIn: `${AUDIT_ORACLE} L859-948`,
    // `roles` and `rolebindings` share ONE observation, because the policy rule names
    // both together and the check reports the rule rather than the resource.
    observedIdentity: v6ResourceLevelObservation(
      'rbac.authorization.k8s.io',
      ['roles', 'rolebindings'],
      'rbac-audit-response',
    ),
  },
  {
    id: 'rolebindings-write',
    resource: 'rolebindings',
    apiGroup: 'rbac.authorization.k8s.io',
    scope: 'namespace rbac-audit-response',
    verbs: Object.freeze(['create', 'update', 'delete']),
    principals: Object.freeze(['system:apiserver']),
    level: 'RequestResponse',
    measuredIn: `${AUDIT_ORACLE} L859-948`,
    observedIdentity: v6ResourceLevelObservation(
      'rbac.authorization.k8s.io',
      ['roles', 'rolebindings'],
      'rbac-audit-response',
    ),
  },
]);

/**
 * The 1-based ordinal of a level within the imported order.
 *
 * Invariant locked: the rank is DERIVED from `AUDIT_LEVEL_ORDER` by index, so
 * the order has exactly one definition site and this module holds no second
 * copy of it to drift. Reordering that array reorders every rank, every rendered
 * ordinal and every comparison below in one edit — which is the property that
 * makes a downgrade detectable rather than merely discouraged.
 *
 * @param level - any of the four `audit.k8s.io/v1` levels.
 * @returns 1 for the least verbose level through 4 for the most verbose.
 */
function auditLevelRank(level: AuditLevel): number {
  return AUDIT_LEVEL_ORDER.indexOf(level) + 1;
}

/**
 * Renders a level as its name AND its position in the order, e.g.
 * `Request (3 of 4)`.
 *
 * Invariant locked: no level is ever rendered bare. A bare name presents the
 * four levels as unordered peers, at which point a lower level reads as
 * equivalent to a higher one and a silent downgrade becomes invisible. The
 * ordinal travels with the name everywhere a level is displayed.
 *
 * @param level - the level to describe.
 * @returns the level name followed by its ordinal out of the total.
 */
function describeAuditLevel(level: AuditLevel): string {
  return `${level} (${auditLevelRank(level)} of ${AUDIT_LEVEL_ORDER.length})`;
}

/**
 * The order written out as a relation, e.g.
 * `None < Metadata < Request < RequestResponse`.
 *
 * Joined from the imported array rather than typed out, for the same
 * single-definition-site reason as {@link auditLevelRank}.
 */
const AUDIT_LEVEL_ORDER_LEGEND = AUDIT_LEVEL_ORDER.join(' < ');

/**
 * Narrows a raw form value back to an {@link AuditLevel}.
 *
 * A `<select>` hands back a plain string, and the filter state is a level or the
 * unfiltered sentinel. Recognition is by exact match against the imported order
 * — nothing is trimmed, case-folded or coerced into matching, because a level
 * this component cannot name is one it must not silently treat as a known one.
 *
 * @param value - the raw value read from the form control.
 * @returns `true` only when `value` is one of the four known levels.
 */
function isAuditLevel(value: string): value is AuditLevel {
  return AUDIT_LEVEL_ORDER.some((level) => level === value);
}

/**
 * The filter value meaning "do not filter".
 *
 * The empty string is used because that is what an unselected `<option>` value
 * naturally carries, and because it can never collide with a level name.
 */
const ALL_LEVELS_VALUE = '';

/** The filter state: a specific level, or the unfiltered sentinel. */
type AuditLevelFilterValue = AuditLevel | typeof ALL_LEVELS_VALUE;

/**
 * Reports how an OBSERVED `secrets` event deviates from its required level, or
 * `undefined` when it does not deviate.
 *
 * Invariant locked: over-collection and under-collection are reported as two
 * DIFFERENT findings, distinguished by comparing ranks rather than by testing
 * inequality. A level above `Request` means the response body reached the audit
 * log, which is a confidentiality failure; a level below it means the forensic
 * record was lost, which is a coverage failure. A check that only asked "is it
 * different?" could not tell a leak from a gap, and an operator would not know
 * which way to act.
 *
 * @param observed - the level actually recorded on the event.
 * @returns a sentence naming the deviation, or `undefined` when the level is
 *   exactly the required one.
 */
function describeLevelDeviation(
  observed: AuditLevel,
  required: AuditLevel,
  because?: string,
): string | undefined {
  const observedRank = auditLevelRank(observed);
  const requiredRank = auditLevelRank(required);
  if (observedRank === requiredRank) {
    return undefined;
  }

  // The rationale is appended when the caller has one. `REQUIRED_LEVEL_ROWS`
  // carries a `because` per resource explaining why THAT resource sits where it
  // does, and it is the part an operator needs in order to act: "below the required
  // RequestResponse" says what happened, "RBAC objects are held UP at the most
  // verbose level for forensics" says why it matters.
  const rationale = because === undefined || because === '' ? '' : ` Required because ${because}.`;

  if (observedRank > requiredRank) {
    return (
      `Audited at ${describeAuditLevel(observed)}, above the required ` +
      `${describeAuditLevel(required)}. ${describeOverCollection(observed)}${rationale}`
    );
  }
  return (
    `Audited at ${describeAuditLevel(observed)}, below the required ` +
    `${describeAuditLevel(required)}. A level below the required one drops the forensic ` +
    `record this resource is audited for.${rationale}`
  );
}

/**
 * Names what an OVER-COLLECTING level actually records, so the finding says what
 * was disclosed rather than merely that a rank was exceeded.
 *
 * DERIVED FROM THE OBSERVED LEVEL, NOT FROM THE REQUIRED ONE. The previous text
 * asserted "records the response body" for every over-collection, which is only
 * true when the observed level is `RequestResponse`: a `configmaps` row required at
 * `Metadata` and observed at `Request` over-collects by recording the REQUEST body,
 * and telling an operator to look for a response body there sends them after
 * something that is not present.
 *
 * @param observed - the level actually recorded.
 * @returns a sentence naming what that level writes into the log.
 */
function describeOverCollection(observed: AuditLevel): string {
  switch (observed) {
    case 'RequestResponse':
      return 'This level records the response body, so the payload reached the audit log.';
    case 'Request':
      return 'This level records the request body, so submitted content reached the audit log.';
    case 'Metadata':
      return 'This level records request metadata, so more was logged than this resource requires.';
    case 'None':
      // Unreachable while `None` is the lowest rank, so nothing can over-collect at
      // it. Stated rather than defaulted, because a `switch` that silently fell
      // through would be the place a reordered AUDIT_LEVEL_ORDER went unnoticed.
      return 'This level records nothing, so it cannot over-collect.';
  }
}

/**
 * The finding raised when an observed `secrets` event carries a response body.
 *
 * This is the presentation-layer statement of the guard the integration oracle
 * asserts at L1043-1047. The body itself is never rendered — only the fact that
 * one exists — so surfacing the finding cannot itself disclose the payload.
 */
const SECRETS_RESPONSE_BODY_FINDING =
  'A response body was recorded. At the required level the response object is omitted, so its ' +
  'presence means the level was raised and the payload reached the audit log.';

/** Shared empty list, so an event with no findings keeps a stable identity. */
const NO_FINDINGS: readonly string[] = Object.freeze([]);

/**
 * Raised when an event's resource identity cannot be established (C1).
 *
 * A finding rather than a silent fail-closed, because an unidentifiable event is a defect
 * in the audit report and the reader needs to know the checks below it were applied on an
 * assumption. The hook's own reason is appended, so the sentence names WHICH of the
 * unreadable shapes arrived rather than merely that one did.
 */
const UNCERTAIN_IDENTITY_FINDING =
  'The event\u2019s resource identity could not be established, so it is treated as a ' +
  'Secret event and every confidentiality check below was applied to it:';

/**
 * Rendered in the target column of an event whose identity cannot be established (C1).
 *
 * A phrase rather than whichever half of the identity happened to be readable. Showing
 * `configmaps` for an event whose `requestURI` said `secrets` would make the row look
 * ordinary beside a finding raised precisely because the two disagreed.
 */
const UNCERTAIN_TARGET_TEXT = 'target could not be established';

/**
 * Every audit-fidelity finding raised by one observed event, in report order.
 *
 * Invariant locked: findings ACCUMULATE. The Go guard uses `t.Errorf`, which
 * records and continues, so a single event may report both a response body and
 * a level deviation and every offending event in a page is reported rather than
 * only the first. Returning a list, and rendering all of it, preserves that.
 *
 * Only `secrets` is checked here, because `secrets` is the resource whose level
 * is a load-bearing boundary condition. `roles`, `rolebindings` and the write
 * verbs of `clusterroles` are measured at the most verbose level deliberately,
 * so a response body on those is correct rather than a finding.
 *
 * @param event - one observed event, exactly as the server returned it.
 * @returns the findings, or an empty list when the event is compliant.
 */
function auditEventFindings(event: AuditEvent): readonly string[] {
  // C1 — THE IDENTITY IS RESOLVED, NOT READ OFF `objectRef.resource`.
  //
  // The early return used to be `event.objectRef?.resource !== SECRETS_RESOURCE`, an
  // expression with two outcomes where three are needed. "This is not a Secret" and "I
  // cannot tell what this is" both took the return, so every one of these skipped every
  // check and reported no finding:
  //
  //   * `objectRef: { name: 's' }` — referenced something, unreadably.
  //   * `objectRef: 'secrets'` — not an object at all.
  //   * `objectRef` absent while `requestURI` is a Secret path — identity knowable from
  //     the other field, and it says Secret.
  //   * `requestURI` naming secrets while `objectRef.resource` says configmaps — two
  //     statements that disagree, so neither can be believed.
  //
  // `isConfidentialAuditIdentity` returns `true` for a resolved `secrets` identity AND for
  // every uncertain one, so all four are now checked. The shared model is imported rather
  // than restated: two copies of a confidentiality rule is one copy too many.
  const identity = resolveAuditResourceIdentity(event);
  if (!isConfidentialAuditIdentity(identity)) {
    return NO_FINDINGS;
  }
  const findings: string[] = [];
  if (identity.kind === 'uncertain') {
    // Reported in its own right, not merely used as a reason to keep checking. An event
    // whose identity cannot be established is a defect in the audit report itself, and the
    // reader needs to know that the checks below were applied on a fail-closed assumption
    // rather than to a confirmed Secret event.
    findings.push(`${UNCERTAIN_IDENTITY_FINDING} ${identity.reason}.`);
  }
  if (event.responseObject !== undefined) {
    findings.push(SECRETS_RESPONSE_BODY_FINDING);
  }
  // Correct to use the Secrets requirement here: this call site is per OBSERVED
  // `secrets` EVENT, whose required level is by definition SECRETS_REQUIRED_LEVEL.
  const deviation = describeLevelDeviation(event.level, SECRETS_REQUIRED_LEVEL);
  if (deviation !== undefined) {
    findings.push(deviation);
  }
  return findings;
}

/** Selects the singular or plural form for a count, so no sentence reads "1 events". */
function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * The `objectRef` identity of the ONE per-resource level row whose value is a
 * load-bearing boundary condition.
 *
 * Built through the shared identity builder rather than spelled out, so the
 * fixtures, the payloads and this panel name the measurement identically and
 * compare it with `===`.
 */
const SECRETS_LEVEL_ROW_IDENTITY = v6ResourceLevelObservation(
  '',
  [SECRETS_RESOURCE],
  'secret-audit-request',
);

/**
 * One per-resource level row whose value is a boundary condition of AAP §0.10.2.
 *
 * M6 — WHY A LIST AND NOT ONE ROW. The panel used to require the aggregate `secrets`
 * level and, conditionally, the single `secrets` policy row. Every other measured row —
 * the issued-token level, the metadata level, the RBAC forensic level — was rendered and
 * then ignored by the verdict, so a payload could report `serviceaccounts/token` at
 * `RequestResponse`, which writes issued credentials into the audit log, and still pass
 * on the strength of its `secrets` row alone.
 *
 * The four below are exactly the rows this control MEASURES that §0.10.2 pins:
 *
 *   * `secrets` at `Request` — the response object is omitted, which is the control.
 *   * `serviceaccounts/token` at `Request` — same reasoning for an issued credential.
 *   * `configmaps` at `Metadata` in the namespace the policy scopes to that level. The
 *     same resource legitimately sits at three other levels in three other namespaces,
 *     which is the policy proving its selection is namespace-scoped, so the row is
 *     required BY NAMESPACE and not by resource name.
 *   * `roles` and `rolebindings` at `RequestResponse` — held UP deliberately for
 *     forensics. Requiring it is what stops a blanket-downgrade passing.
 *
 * §0.10.2 also pins `tokenreviews` at `Metadata` and `clusterroles` at
 * `RequestResponse`. Neither is measured by THIS control — both belong to the shell-tier
 * generator matrix (`python/tests/unit/shell/test_audit_policy.py`) — so requiring them
 * here would make a pass unreachable rather than stricter, which is a different defect
 * and not a fix.
 */
interface RequiredLevelRow {
  /** The observation identity, built through the shared builder. */
  readonly identity: string;
  /** The level the row must report, exactly. */
  readonly level: AuditLevel;
  /** Why the level is load-bearing, for the rendered detail. */
  readonly because: string;
}

/** The four control-defining per-resource level rows. */
const REQUIRED_LEVEL_ROWS: readonly RequiredLevelRow[] = Object.freeze([
  {
    identity: SECRETS_LEVEL_ROW_IDENTITY,
    level: SECRETS_REQUIRED_LEVEL,
    because: 'at this level the response object is omitted, so a Secret body is never logged',
  },
  {
    identity: v6ResourceLevelObservation('', ['serviceaccounts/token'], 'create-audit-request'),
    level: 'Request',
    because:
      'an issued token appears only in the response, so a higher level would write the ' +
      'credential itself into the audit log',
  },
  {
    identity: v6ResourceLevelObservation('', ['configmaps'], 'webhook-audit-metadata'),
    level: 'Metadata',
    because:
      'this is the namespace the policy scopes to Metadata; the same resource sits at ' +
      'other levels in other namespaces by design',
  },
  {
    identity: v6ResourceLevelObservation(
      'rbac.authorization.k8s.io',
      ['roles', 'rolebindings'],
      'rbac-audit-response',
    ),
    level: 'RequestResponse',
    because:
      'RBAC objects are held UP at the most verbose level for forensics, so a downgrade ' +
      'here is a loss of evidence rather than a tightening',
  },
]);

/** The level order as the payload must report it: the canonical relation, verbatim. */
const REQUIRED_LEVEL_ORDERING = AUDIT_LEVEL_ORDER.join(' < ');

/**
 * One measured fact a V6 pass rests on, and what became of it.
 *
 * `indeterminate` and `violated` are kept apart deliberately: the first is a gap in
 * the report and withholds a pass, the second is a finding and forces a failure.
 * Collapsing them would either invent violations out of silence or hide real ones.
 */
interface AuditMeasurement {
  /** The observation identity, rendered so the row cites what it read. */
  readonly identity: string;
  /** What the measurement establishes, in a reader's words. */
  readonly title: string;
  /** The outcome. */
  readonly result: 'satisfied' | 'violated' | 'indeterminate';
  /** Why, in one sentence. Never carries an audited payload. */
  readonly detail: string;
}

/** Shared empty list, so a payload with no observations allocates nothing. */
const NO_OBSERVATIONS: readonly ControlObservation[] = Object.freeze([]);

/**
 * Requires one observation to be exactly the given level.
 *
 * A level ABOVE the required one and a level BELOW it are reported as two different
 * violations, by rank rather than by inequality, for the same reason
 * {@link describeLevelDeviation} does it for events: above means the response
 * body reached the audit log, below means the forensic record was lost, and an
 * operator has to know which way to act.
 */
function requireLevel(
  observations: readonly ControlObservation[],
  identity: string,
  title: string,
  required: AuditLevel,
  because?: string,
): AuditMeasurement {
  const observed = readString(observations, identity);
  if (observed.state !== 'reported') {
    return { identity, title, result: 'indeterminate', detail: observed.reason };
  }
  if (observed.value === required) {
    return {
      identity,
      title,
      result: 'satisfied',
      detail: `Audited at exactly ${describeAuditLevel(required)}.`,
    };
  }
  if (!isAuditLevel(observed.value)) {
    return {
      identity,
      title,
      result: 'indeterminate',
      detail:
        `Reported as a level this panel cannot name, so it cannot be ranked against ` +
        `${describeAuditLevel(required)}.`,
    };
  }
  // The ACTUAL required level and the row's own rationale, not the Secrets
  // requirement. This helper is called for four rows requiring three different
  // levels; passing `SECRETS_REQUIRED_LEVEL` here described a clusterroles row
  // required at RequestResponse as deviating from Request, so the verdict was right
  // and the remediation guidance was wrong.
  const deviation = describeLevelDeviation(observed.value, required, because);
  return {
    identity,
    title,
    result: 'violated',
    detail: deviation ?? `Audited at ${describeAuditLevel(observed.value)}.`,
  };
}

/**
 * THE CONFIDENTIALITY GUARD, as one number.
 *
 * The count of observed `secrets` events carrying a `responseObject` MUST be zero.
 * Any other value is a Secret body written into the audit log, which is precisely
 * the disclosure V6 exists to prevent, so it is a VIOLATION and forces a failure
 * however the check itself scored the control.
 *
 * A `null` count is NOT zero and must never be read as one. The recorded
 * indeterminate payload carries `null` exactly because no event was seen at all,
 * and "no Secret event carried a response body because no Secret event existed" is
 * emphatically not a pass.
 */
function requireResponseObjectCount(observations: readonly ControlObservation[]): AuditMeasurement {
  const identity = V6_OBSERVATIONS.secretsResponseObjectCount;
  const title = `no observed ${SECRETS_RESOURCE} event carries a response body`;
  const observed = readCount(observations, identity);
  if (observed.state !== 'reported') {
    return {
      identity,
      title,
      result: 'indeterminate',
      detail: `${observed.reason} A count that was not reported is not a count of zero.`,
    };
  }
  if (observed.value === 0) {
    return {
      identity,
      title,
      result: 'satisfied',
      detail: 'The check scanned the observed events and found no recorded response body.',
    };
  }
  return {
    identity,
    title,
    result: 'violated',
    detail:
      `${String(observed.value)} observed ${SECRETS_RESOURCE} ` +
      `${plural(observed.value, 'event', 'events')} carried a response body, so the payload ` +
      'reached the audit log.',
  };
}

/**
 * Requires the reported level ordering to be the canonical strict total order.
 *
 * The ordering is carried as a VALUE rather than as a boolean so that it can be
 * compared: a reordering fails here, whereas a bare `true` would be unverifiable
 * prose that no check could contradict.
 */
function requireLevelOrdering(observations: readonly ControlObservation[]): AuditMeasurement {
  const identity = V6_OBSERVATIONS.levelOrdering;
  const title = `the level order is ${REQUIRED_LEVEL_ORDERING}`;
  const observed = readString(observations, identity);
  if (observed.state !== 'reported') {
    return { identity, title, result: 'indeterminate', detail: observed.reason };
  }
  return observed.value === REQUIRED_LEVEL_ORDERING
    ? { identity, title, result: 'satisfied', detail: 'The reported order is the required order.' }
    : {
        identity,
        title,
        result: 'violated',
        detail:
          'The reported order is not the required order, so a level could be silently ' +
          'downgraded without any single level looking wrong.',
      };
}

/**
 * Requires that at least one audit event was scanned.
 *
 * NOW REQUIRED OUTRIGHT rather than conditional on being reported (M6). Its absence used
 * to be treated as "normal rather than suspicious", but the completeness measurement below
 * needs it as a denominator: without an observed count there is no way to check that the
 * observed stream is a superset of the expected set, and "the levels are right" said over
 * a log nobody confirmed had any events in it is a policy document rather than a
 * measurement.
 *
 * Zero is `indeterminate` and never `violated`: an empty audit log is an unverified
 * control, not a broken one.
 */
function requireEventsObserved(
  observations: readonly ControlObservation[],
): AuditMeasurement {
  const identity = V6_OBSERVATIONS.auditEventsObserved;
  const title = 'at least one audit event was scanned';
  const count = readCount(observations, identity);
  if (count.state !== 'reported') {
    return { identity, title, result: 'indeterminate', detail: count.reason };
  }
  return {
    identity,
    title,
    result: count.value > 0 ? 'satisfied' : 'indeterminate',
    detail:
      count.value > 0
        ? `${String(count.value)} ${plural(count.value, 'event', 'events')} scanned.`
        : 'No audit event was scanned, so the guard had nothing to inspect.',
  };
}

/**
 * Requires that EVERY expected audit event was observed (M6, F-006-RQ-002).
 *
 * THIS IS THE MEASUREMENT THAT TURNS A POLICY TABLE INTO A VERIFICATION. A count of
 * observed events proves that auditing is on; it proves nothing about WHICH events
 * arrived, so ten events that are all the wrong ten satisfied every check this panel used
 * to make. The Go oracle does not accept that: `test/utils/audit.go` L86 and L93 poll
 * until every expected event has been seen and otherwise fail with a missing-events report
 * naming each absent one.
 *
 * `false` IS NOT UNCONDITIONALLY A VIOLATION, and the condition is the observed count:
 *
 *   * `false` alongside events that DID arrive means the wrong events arrived — a policy
 *     rule did not fire while others did. That is a defect, so it is `violated`.
 *   * `false` alongside NO events at all is the same fact the observed-count row already
 *     reports: nothing was scanned. An empty audit log is an unverified control, not a
 *     broken one, so it is `indeterminate`. Counting it as a violation would turn an
 *     unexercised control into a failing one, and would report the single gap twice —
 *     once honestly and once as a finding it is not.
 *
 * Silence is indeterminate either way.
 */
function requireExpectedEventsObserved(
  observations: readonly ControlObservation[],
): AuditMeasurement {
  const identity = V6_OBSERVATIONS.expectedEventsObserved;
  const title = 'every expected audit event was observed';
  const found = selectObservation(observations, identity);
  if (found.state !== 'reported') {
    return { identity, title, result: 'indeterminate', detail: found.reason };
  }
  const { value } = found.value;
  if (typeof value !== 'boolean') {
    return {
      identity,
      title,
      result: 'indeterminate',
      detail:
        'The completeness verdict was not reported as a boolean, so whether every ' +
        'expected event arrived cannot be read.',
    };
  }
  if (value) {
    return {
      identity,
      title,
      result: 'satisfied',
      detail: 'Every expected audit event was observed, so each policy rule fired.',
    };
  }
  const observed = readCount(observations, V6_OBSERVATIONS.auditEventsObserved);
  const nothingScanned = observed.state === 'reported' && observed.value === 0;
  return nothingScanned
    ? {
        identity,
        title,
        result: 'indeterminate',
        detail:
          'No audit event arrived at all, so the expected set is unobserved because the ' +
          'log was empty rather than because a rule failed to fire.',
      }
    : {
        identity,
        title,
        result: 'violated',
        detail:
          'At least one expected audit event was never observed while others were, so a ' +
          'policy rule did not fire and the levels below are unverified for it.',
      };
}

/**
 * Requires a coherent expected-event count, and checks it against the observed one.
 *
 * The count is the DENOMINATOR of the completeness verdict: without it, "every expected
 * event was observed" is an unauditable assertion. The coherence check is the second half
 * — the observed stream is documented as a SUPERSET of the expected set (`audit_test.go`
 * L1038-L1039), so observing fewer events than were expected contradicts a completeness
 * verdict of `true` and is a violation whichever of the two is wrong.
 */
function requireExpectedEventCount(
  observations: readonly ControlObservation[],
): AuditMeasurement {
  const identity = V6_OBSERVATIONS.expectedEventCount;
  const title = 'the expected-event count is reported and coherent';
  const expected = readNumber(observations, identity);
  if (expected.state !== 'reported') {
    return { identity, title, result: 'indeterminate', detail: expected.reason };
  }
  // DELIBERATELY `readNumber` PLUS A LOCAL GUARD, WHERE THE OBSERVED COUNTS USE
  // `readCount`. The two counts fail for different reasons and so carry different
  // verdicts. This one is the panel's own claim about what SHOULD be audited, so a
  // value that cannot be the size of a set is a CONTRADICTION in the claim and is
  // `violated`. An OBSERVED count that cannot be a count means the measuring
  // apparatus is broken, which makes the control unproven rather than refuted, so
  // those sites read through `readCount` and surface `indeterminate` instead.
  if (!Number.isInteger(expected.value) || expected.value <= 0) {
    return {
      identity,
      title,
      result: 'violated',
      detail:
        'The expected-event count is not a positive whole number, so it cannot be the ' +
        'size of a set of events.',
    };
  }
  const observed = readCount(observations, V6_OBSERVATIONS.auditEventsObserved);
  if (observed.state === 'reported' && observed.value < expected.value) {
    // THE EMPTY-LOG EXEMPTION, shared with `requireExpectedEventsObserved`. A shortfall
    // against the expected count is a CONTRADICTION only when events actually arrived: the
    // observed stream is a superset of the expected set, so 8 observed against 9 expected
    // cannot both be true. Zero observed is a different fact entirely — the log was empty,
    // which the observed-count row above already reports as indeterminate. Calling that a
    // violation would convert "this check did not run" into "this control is broken", and
    // would make the recorded no-events payload FAIL where it must be UNKNOWN.
    if (observed.value === 0) {
      return {
        identity,
        title,
        result: 'indeterminate',
        detail:
          `${String(expected.value)} events were expected and none arrived at all, so the ` +
          'count is unverified because the log was empty rather than because it disagrees.',
      };
    }
    return {
      identity,
      title,
      result: 'violated',
      detail:
        `${String(observed.value)} ${plural(observed.value, 'event', 'events')} were ` +
        `observed against ${String(expected.value)} expected. The observed stream is a ` +
        'superset of the expected set, so fewer observed than expected is a contradiction.',
    };
  }
  return {
    identity,
    title,
    result: 'satisfied',
    detail: `${String(expected.value)} events were expected, and at least that many arrived.`,
  };
}

/**
 * The measurements a V6 pass rests on, in the order a reader needs them.
 *
 * TEN required measurements, every one of them an exact value from AAP §0.10.2 or the
 * completeness contract of `test/utils/audit.go`:
 *
 *   * the aggregate `secrets` level, the response-body count and the level ordering;
 *   * that at least one event was scanned, that the expected-event count is coherent, and
 *     that EVERY expected event was observed — the three that turn a policy table into a
 *     verification;
 *   * the four control-defining per-resource level rows of {@link REQUIRED_LEVEL_ROWS}.
 *
 * NOTHING IS CONDITIONAL ANY MORE, and that is the substance of the M6 fix. Every one of
 * the last seven used to be either absent from the verdict entirely or included only when
 * the payload happened to report it — which made a pass available to a payload that simply
 * reported less.
 */
function buildAuditMeasurements(
  observations: readonly ControlObservation[],
): readonly AuditMeasurement[] {
  return [
    requireLevel(
      observations,
      V6_OBSERVATIONS.secretsAuditLevel,
      `${SECRETS_RESOURCE} are audited at exactly ${SECRETS_REQUIRED_LEVEL}`,
      SECRETS_REQUIRED_LEVEL,
    ),
    requireResponseObjectCount(observations),
    requireLevelOrdering(observations),
    requireEventsObserved(observations),
    requireExpectedEventCount(observations),
    requireExpectedEventsObserved(observations),
    ...REQUIRED_LEVEL_ROWS.map((row) =>
      requireLevel(
        observations,
        row.identity,
        `the policy rule for ${row.identity} projects at ${row.level} \u2014 ${row.because}`,
        row.level,
        row.because,
      ),
    ),
  ];
}

/**
 * The verdict the EVIDENCE alone supports, folding in what this panel measured for
 * itself from the observed events.
 *
 * INVARIANT LOCKED — A LOCAL CONFIDENTIALITY VIOLATION IS A FAILURE, whatever the
 * server said. This is the whole point of computing anything here: the panel already
 * detected, per event, that a `secrets` event carried a response body or sat at the
 * wrong level, and it rendered those findings in a table cell while leaving the
 * headline verdict at the value the server sent. A rendered PASS beside a rendered
 * confidentiality violation is not a display inconsistency — it is the panel
 * contradicting its own evidence, and a reader who trusts the headline is told the
 * control holds when this panel has proof it does not.
 *
 * @param measurements - the reported measurements, from {@link buildAuditMeasurements}.
 * @param localFindingCount - findings this panel derived from the observed events.
 */
function summariseAuditEvidence(
  measurements: readonly AuditMeasurement[],
  localFindingCount: number,
): EffectiveVerdict {
  if (localFindingCount > 0) {
    return 'fail';
  }
  if (measurements.some((measurement) => measurement.result === 'violated')) {
    return 'fail';
  }
  return measurements.every((measurement) => measurement.result === 'satisfied')
    ? 'pass'
    : 'unknown';
}

/** Every audit-fidelity finding this panel derived from the observed events. */
function localEventFindings(events: readonly AuditEvent[]): readonly string[] {
  return events.flatMap((event) => auditEventFindings(event));
}

/**
 * The verdict this panel renders, which is not always the verdict the check
 * reported.
 *
 * INVARIANT LOCKED — A PASS MUST BE EARNED, and every rule only ever moves the
 * outcome in the safe direction:
 *
 *   1. A local confidentiality violation — a `secrets` event carrying a response
 *      body, or one audited above or below `Request` — is a FAILURE. So is a
 *      reported response-body count above zero, and so is a finding the check
 *      attached.
 *   2. A reported pass is downgraded to UNKNOWN when the three required
 *      measurements were not all demonstrated, or when the check reported that it
 *      scanned no events at all. An empty audit log is not evidence that Secret
 *      responses go unlogged.
 *   3. Otherwise the STRICTEST of the reported verdict and the evidence verdict
 *      stands, so `warn` and `unknown` stay distinct and neither becomes a pass.
 *
 * Exported because the aggregate dashboard must count, filter and summarise the SAME
 * verdict this panel renders; a dashboard deriving it from `status.verdict` would
 * disagree with its own children.
 *
 * @param control - the payload for this control, exactly as the hook parsed it.
 * @param events - observed events, when the caller supplied any. Their local
 *   findings are folded in; an empty list contributes none.
 * @returns the verdict the panel renders for that payload.
 */
export function resolveAuditFidelityEffectiveVerdict(
  control: ControlStatus,
  events: readonly AuditEvent[] = [],
): EffectiveVerdict {
  const measurements = buildAuditMeasurements(control.evidence?.observations ?? NO_OBSERVATIONS);
  const evidence = summariseAuditEvidence(measurements, localEventFindings(events).length);
  if (control.verdict === 'fail' || evidence === 'fail' || control.findings.length > 0) {
    return 'fail';
  }
  if (control.verdict === 'pass') {
    return evidence;
  }
  return strictestVerdict([control.verdict, evidence]);
}

/**
 * Describes which audited payloads an event recorded, WITHOUT rendering either
 * of them.
 *
 * Invariant locked: presence only, never contents. `requestObject` and
 * `responseObject` are inspectable objects on the wire, and a panel that
 * interpolated one into markup would disclose exactly what the audit level was
 * chosen to withhold. This function reads `!== undefined` and returns prose, so
 * there is no code path from a payload to the DOM.
 *
 * @param event - one observed event.
 * @returns a sentence naming which of the two bodies were recorded.
 */
function describeRecordedPayloads(event: AuditEvent): string {
  const request = event.requestObject === undefined ? 'not recorded' : 'recorded';
  const response = event.responseObject === undefined ? 'not recorded' : 'recorded';
  return `Request body ${request}; response body ${response}.`;
}

/**
 * Describes what an observed event acted on.
 *
 * Handles the three shapes the wire actually produces: a namespaced resource, a
 * cluster-scoped resource, and a non-resource request, which carries no
 * `objectRef` at all (the integration oracle's projection guards it with a nil
 * check, which is why the field is optional).
 *
 * @param event - one observed event.
 * @returns a human-readable target description; never `undefined` and never the
 *   text `undefined`.
 */
function describeAuditEventTarget(event: AuditEvent): string {
  // C1 — DESCRIBED FROM THE RESOLVED IDENTITY, so the target column cannot say
  // `configmaps` about an event whose findings were raised because its identity could not
  // be believed. Every interpolated part is bounded (M18): a target is assembled entirely
  // from server strings, and all four of them used to be rendered verbatim.
  const identity = resolveAuditResourceIdentity(event);
  if (identity.kind === 'uncertain') {
    return UNCERTAIN_TARGET_TEXT;
  }
  if (identity.kind === 'non-resource') {
    return `non-resource request ${safeObservationValue(identity.requestURI)}`;
  }
  const selector =
    identity.subresource === undefined || identity.subresource === ''
      ? safeObservationValue(identity.resource)
      : `${safeObservationValue(identity.resource)}/${safeObservationValue(identity.subresource)}`;
  const rawGroup = event.objectRef?.apiGroup;
  const group =
    rawGroup === undefined || rawGroup === '' ? 'core' : safeObservationValue(rawGroup);
  const scope =
    identity.namespace === undefined || identity.namespace === ''
      ? 'cluster-scoped'
      : `namespace ${safeObservationValue(identity.namespace)}`;
  return `${selector} (${group}, ${scope})`;
}

/** How one {@link ControlVerdict} is presented. */
interface VerdictPresentation {
  /** The short affordance text, e.g. `Pass`. */
  readonly label: string;
  /** One sentence explaining what the verdict means for this control. */
  readonly description: string;
}

/**
 * The four verdicts and their affordances.
 *
 * Invariant locked, and it is the single most important behavioural rule in this
 * folder: an error or unknown verdict can NEVER render the pass affordance. Two
 * structural properties enforce that rather than a convention:
 *
 *   1. The map is a `Record<ControlVerdict, VerdictPresentation>`, so it is
 *      exhaustive over the union and needs no fallback branch. There is no
 *      "default" arm that could resolve to `pass`.
 *   2. `UseControlStatusResult`'s error arm carries no `controls` member at all,
 *      so no verdict is even reachable from a failed request — the error
 *      affordance renders instead, and reading a verdict there would be a
 *      compile error under `strict`.
 *
 * An absent control resolves to `unknown` and not to `pass`, because the Go
 * oracle pairs every negative assertion with a positive control precisely so a
 * check that cannot tell "no evidence" from "good evidence" is never mistaken
 * for one that can.
 */
const VERDICT_PRESENTATION: Readonly<Record<ControlVerdict, VerdictPresentation>> = Object.freeze({
  pass: {
    label: 'Pass',
    description:
      'Every sensitive resource is audited at its measured level, and no audited response body ' +
      'was recorded for a resource that must omit one.',
  },
  fail: {
    label: 'Fail',
    description:
      'At least one sensitive resource deviates from its measured level. Each deviation is ' +
      'listed below.',
  },
  warn: {
    label: 'Warning',
    description:
      'The check completed and the server objected to it. A warning is neither a pass nor a ' +
      'fail: read the warnings below before relying on this verdict.',
  },
  unknown: {
    label: 'Unknown',
    description:
      'No trustworthy evidence was obtained, so no verdict can be given. This is not a pass: ' +
      'treat the control as unverified until evidence is available.',
  },
});

/** Summary substituted when a successful response does not mention this control. */
const ABSENT_CONTROL_SUMMARY =
  'The server responded successfully but reported nothing about this control.';

/**
 * The visible, stable accessible names every affordance is addressed by.
 *
 * Held as named constants for two reasons. First, each is referenced by both the
 * markup and this documentation, so a spec can be written against one source.
 * Second, every one of them is rendered as VISIBLE text and then referenced with
 * `aria-labelledby`, rather than hidden in an `aria-label`: a name that is also
 * on screen means an operator reading the panel and an assistive technology
 * announcing it receive the same words, and it keeps every affordance reachable
 * by role plus accessible name without a single test identifier anywhere in this
 * file.
 */
const PANEL_HEADING = 'Sensitive-resource audit fidelity';
/** Names the nested region holding the measured level table. */
const LEVELS_HEADING = 'Per-resource audit levels';
/** Names the nested region holding the observed events. */
const EVENTS_HEADING = 'Observed audit events';
/** Names the verdict live region. */
const VERDICT_LABEL = 'Verdict';
/** Names the in-flight live region. */
const LOADING_LABEL = 'Checking audit fidelity';
/** Names the failure alert. */
const ERROR_LABEL = 'Audit fidelity check failed';
/** Names the live region shown when no level rows are visible. */
const LEVELS_EMPTY_LABEL = 'No audit levels to display';
/** Names the live region shown when no observed events are available. */
const EVENTS_EMPTY_LABEL = 'No observed audit events to display';
/** Accessible name of the re-request control. */
const REFRESH_LABEL = 'Refresh audit fidelity';
/** Accessible name of the level filter. */
const FILTER_LABEL = 'Filter by audit level';
/** Label of the filter option that applies no filter. */
const ALL_LEVELS_OPTION_LABEL = 'All audit levels';
/** Accessible name of the measured level table. */
const LEVELS_TABLE_CAPTION = 'Required per-resource audit levels, and what this check observed';

/**
 * How each measurement result opens its sentence.
 *
 * `Record` over the union rather than a partial map, so a new result is a compile
 * error here instead of an unlabelled row. The three words are deliberately
 * different: "not established" is a gap and "violated" is a finding, and a reader
 * must never have to guess which of the two they are looking at.
 */
type MeasurementResult = AuditMeasurement['result'];

const MEASUREMENT_RESULT_WORDS: Readonly<Record<MeasurementResult, string>> = Object.freeze({
  satisfied: 'Established:',
  violated: 'Violated:',
  indeterminate: 'Not established:',
});

/** Accessible name of the list of findings this panel derived from the observed events. */
const LOCAL_FINDINGS_LABEL = 'Audit fidelity findings derived from the observed events';
/** Accessible name of the observed event table. */
const EVENTS_TABLE_CAPTION = 'Observed audit events and their recorded payloads';
/** Names the nested region listing reported violations. */
const FINDINGS_HEADING = 'Audit fidelity findings';
/** Names the nested region listing server warnings. */
const WARNINGS_HEADING = 'Server warnings';

/** Props of the in-flight affordance. */
interface AuditFidelityLoadingProps {
  /** Identifier of the visible element that names this live region. */
  readonly labelId: string;
}

/**
 * The in-flight affordance.
 *
 * Invariant locked: this is a THIRD state, distinguishable from both a pass and
 * an empty result. It renders no verdict at all, so a request still in flight
 * can never be read as a clean bill of health, and it says so in words rather
 * than by omission.
 */
function AuditFidelityLoading({ labelId }: AuditFidelityLoadingProps): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  return (
    <p
      className="audit-fidelity-panel__state audit-fidelity-panel__state--loading"
      role={liveStatusRole}
      aria-labelledby={labelId}
    >
      <strong id={labelId}>{LOADING_LABEL}</strong>{' '}
      <span className="audit-fidelity-panel__state-detail">
        No verdict is available yet. The measured levels below are static reference data and are
        unaffected by this request.
      </span>
    </p>
  );
}

/** Props of the failure affordance. */
interface AuditFidelityErrorProps {
  /** The transport or contract failure, exactly as the hook reported it. */
  readonly error: ControlStatusError;
  /** Identifier of the visible element that names this alert. */
  readonly labelId: string;
}

/**
 * The failure affordance.
 *
 * Invariant locked: a refusal is never a pass. This renders for every non-2xx
 * response — 403 and 500 in particular — and for a transport failure, and it
 * says outright that no verdict is available. `role={liveAlertRole}` rather than
 * `role={liveStatusRole}` because a failed posture check is assertive: it must be
 * announced without waiting for the operator to reach it.
 *
 * The status code and the server's own `reason` are rendered when present and
 * simply omitted when they are not. `httpStatus` is absent exactly for a
 * transport failure, where no response — and therefore no status — ever existed;
 * inventing a zero there would report a status the server never sent.
 */
function AuditFidelityError({ error, labelId }: AuditFidelityErrorProps): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). See the note on the status role above.
  const liveAlertRole = useLiveRegionRole('alert');
  return (
    <p
      className="audit-fidelity-panel__state audit-fidelity-panel__state--error"
      role={liveAlertRole}
      aria-labelledby={labelId}
      data-error-kind={error.kind}
    >
      <strong id={labelId}>{ERROR_LABEL}</strong>{' '}
      <span className="audit-fidelity-panel__error-message">{safeErrorMessage(error)}</span>
      {error.httpStatus === undefined ? null : (
        <span className="audit-fidelity-panel__error-status">
          {` HTTP status ${error.httpStatus}.`}
        </span>
      )}
      {error.reason === undefined ? null : (
        <span className="audit-fidelity-panel__error-reason">
          {` Reason: ${describeStatusReason(error.reason)}.`}
        </span>
      )}
      <span className="audit-fidelity-panel__state-detail">
        {' No verdict is available for this control, and this is not a pass.'}
      </span>
    </p>
  );
}

/**
 * The three prose channels this panel renders, each with a local fallback (M18).
 *
 * EVERY ONE OF THEM IS BACKEND PROSE, and all three used to be interpolated verbatim and
 * unbounded — the error message and reason into a live `role={liveAlertRole}` region, and the
 * summary into a `role={liveStatusRole}` one. A control could therefore place a PEM block, a
 * compact token, a bidirectional override or a megabyte of text into any of them.
 *
 * WHY EACH HAS A FALLBACK RATHER THAN RENDERING NOTHING. These three occupy positions the
 * reader depends on: an alert with no message, a verdict with no summary and a finding with
 * no text each read as a rendering fault rather than as withheld content. Local wording in
 * those positions keeps the affordance meaningful and says why it is empty.
 *
 * The detail, timestamp, requirement identifiers and warnings have no fallback, because
 * each of those is optional and simply does not render when it is absent.
 */
const WITHHELD_ERROR_MESSAGE =
  'The check reported a failure whose message could not be displayed.';

/** Fallback for a summary that sanitized away to nothing. */
const WITHHELD_SUMMARY = 'The check reported a verdict whose summary could not be displayed.';

/** Fallback for a finding whose message sanitized away to nothing. */
const WITHHELD_FINDING_MESSAGE =
  'The check reported a finding whose message could not be displayed.';

/**
 * Bounds a failure message, substituting local wording when nothing survives.
 *
 * `kind` and `httpStatus` are deliberately NOT guarded and are rendered elsewhere as they
 * stand: the first is a typed union of this repository's own literals and the second is a
 * number, so neither is external text and guarding either would only obscure that it is a
 * closed set.
 */
function safeErrorMessage(error: ControlStatusError): string {
  const message = safeProse(error.message);
  return message.length > 0 ? message : WITHHELD_ERROR_MESSAGE;
}

/** Bounds a verdict summary, substituting local wording when nothing survives. */
function safeSummary(summary: string): string {
  const bounded = safeProse(summary);
  return bounded.length > 0 ? bounded : WITHHELD_SUMMARY;
}

/** Bounds a finding message, substituting local wording when nothing survives. */
function safeFindingMessage(message: string): string {
  const bounded = safeProse(message);
  return bounded.length > 0 ? bounded : WITHHELD_FINDING_MESSAGE;
}

/** Props of the verdict affordance. */
interface AuditFidelityVerdictProps {
  /**
   * The control payload, or `undefined` when a successful response did not
   * mention this control.
   */
  readonly control: ControlStatus | undefined;
  /** Identifier of the visible element that names this live region. */
  readonly labelId: string;
  /**
   * The observed events this panel was given, whose local findings are folded into
   * the rendered verdict. Empty when none were supplied.
   */
  readonly events: readonly AuditEvent[];
}

/**
 * The verdict affordance: one of four mutually exclusive outcomes.
 *
 * Invariant locked: an absent control resolves to `unknown`, never to `pass`.
 * `selectControlStatus` returns `undefined` when the payload does not mention
 * the control, and treating that silence as success would let this panel report
 * a clean control on evidence it never received.
 *
 * Invariant locked: the verdict is RESOLVED rather than echoed. It is the output of
 * {@link resolveAuditFidelityEffectiveVerdict}, so a `secrets` event carrying a
 * response body, a `secrets` level away from `Request`, a non-zero reported
 * response-body count or an unproven required measurement each move this affordance
 * even when the server scored the control a pass. Echoing `control.verdict` here is
 * what let the panel render PASS while its own event table listed a confidentiality
 * violation two elements below.
 *
 * `data-verdict` carries the resolved verdict so a stylesheet can distinguish
 * the four outcomes without this component inventing colour classes, and so
 * colour is never the sole carrier of meaning: the affordance text states the
 * verdict in words regardless of how it is styled.
 */
function AuditFidelityVerdict({
  control,
  labelId,
  events,
}: AuditFidelityVerdictProps): ReactElement {
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  const verdict: ControlVerdict =
    control === undefined ? 'unknown' : resolveAuditFidelityEffectiveVerdict(control, events);
  const summary =
    control === undefined ? ABSENT_CONTROL_SUMMARY : safeSummary(control.summary);
  const presentation = VERDICT_PRESENTATION[verdict];
  return (
    <p
      className="audit-fidelity-panel__state audit-fidelity-panel__state--verdict"
      role={liveStatusRole}
      aria-labelledby={labelId}
      data-verdict={verdict}
    >
      <strong id={labelId}>{VERDICT_LABEL}</strong>{' '}
      <span className="audit-fidelity-panel__verdict-value">{presentation.label}</span>
      {' — '}
      <span className="audit-fidelity-panel__verdict-summary">{summary}</span>{' '}
      <span className="audit-fidelity-panel__state-detail">{presentation.description}</span>
    </p>
  );
}

/** Props of the measured-evidence block. */
interface AuditMeasurementListProps {
  /** The control payload whose measurements are being interrogated. */
  readonly control: ControlStatus;
  /** The observed events whose local findings are folded in. */
  readonly events: readonly AuditEvent[];
}

/**
 * The measurements a V6 pass rests on, with what became of each.
 *
 * Rendered in every resolved state, not only on failure, because the reader's
 * question is "what was actually checked?" and the answer has to be the same
 * whether the answer is good or bad. Each row carries `data-measurement` and
 * `data-result` so a single measurement is addressable without parsing prose.
 *
 * When the resolved verdict differs from the one the check reported, the
 * disagreement is stated out loud rather than left for a reader to infer from two
 * elements that contradict each other.
 */
function AuditMeasurementList({ control, events }: AuditMeasurementListProps): ReactElement {
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  const headingId = useId();
  const measurements = buildAuditMeasurements(control.evidence?.observations ?? NO_OBSERVATIONS);
  const localFindings = localEventFindings(events);
  const resolved = resolveAuditFidelityEffectiveVerdict(control, events);
  return (
    <section
      className="audit-fidelity-panel__measurements-region"
      aria-labelledby={headingId}
      data-region="measurements"
    >
      <Subheading id={headingId}>What this verdict rests on</Subheading>
      {resolved === control.verdict ? null : (
        <p className="audit-fidelity-panel__disagreement" data-disagreement={resolved}>
          {`The check reported ${control.verdict} for this control; the evidence below supports ` +
            `${resolved}, and the weaker of the two is the verdict shown. Silence about a ` +
            'required measurement is not agreement with it, and a recorded Secret response ' +
            'body is a failure however the control was scored.'}
        </p>
      )}
      <dl className="audit-fidelity-panel__measurements">
        {measurements.map((measurement) => (
          <div
            key={measurement.identity}
            data-measurement={measurement.identity}
            data-result={measurement.result}
          >
            <dt>{measurement.title}</dt>
            <dd>{`${MEASUREMENT_RESULT_WORDS[measurement.result]} ${measurement.detail}`}</dd>
          </div>
        ))}
      </dl>
      {localFindings.length === 0 ? null : (
        <ul className="audit-fidelity-panel__local-findings" aria-label={LOCAL_FINDINGS_LABEL}>
          {localFindings.map((finding, index) => (
            <li key={`${String(index)}:${finding}`}>{finding}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Props of the reported-evidence block. */
interface AuditFidelityControlDetailProps {
  /** The control payload whose reported evidence is being rendered. */
  readonly control: ControlStatus;
}

/**
 * Everything the server reported about the control beyond its verdict.
 *
 * Invariant locked: findings are rendered in FULL and never truncated to the
 * first one. The Go oracle reports every offender in a single run — its guard
 * uses `t.Errorf`, which records and continues — so showing only the first
 * finding would hide the rest of a multi-object violation and understate the
 * problem.
 *
 * Warnings are rendered as a first-class list rather than folded into the
 * verdict text, because a permitted operation that the server objected to is
 * exactly the `warn` outcome and an operator has to be able to read the server's
 * own words.
 *
 * Every member other than `findings` and `warnings` is optional on the wire, so
 * each is rendered only when present. No stand-in value is invented for an
 * absent field, and the text `undefined` is never rendered.
 */
function AuditFidelityControlDetail({ control }: AuditFidelityControlDetailProps): ReactElement {
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  const baseId = useId();
  const findingsHeadingId = `${baseId}-findings-heading`;
  const warningsHeadingId = `${baseId}-warnings-heading`;
  const reportedRequirements = control.requirementIds;
  return (
    <div className="audit-fidelity-panel__reported">
      {control.detail === undefined ? null : (
        <p className="audit-fidelity-panel__detail">{safeProse(control.detail)}</p>
      )}
      {reportedRequirements === undefined || reportedRequirements.length === 0 ? null : (
        <p className="audit-fidelity-panel__reported-requirements">
          {`Requirements reported by the server: ${reportedRequirements
            .map((identifier) => safeLabel(identifier))
            .join(', ')}.`}
        </p>
      )}
      {control.observedAt === undefined ? null : (
        <p className="audit-fidelity-panel__observed-at">{`Evaluated at ${safeLabel(control.observedAt)}.`}</p>
      )}
      {control.findings.length === 0 ? null : (
        <section className="audit-fidelity-panel__findings" aria-labelledby={findingsHeadingId}>
          <Subheading id={findingsHeadingId}>{FINDINGS_HEADING}</Subheading>
          <ul>
            {control.findings.map((finding, index) => (
              <li key={`finding-${index}`}>
                <span className="audit-fidelity-panel__finding-message">
                  {safeFindingMessage(finding.message)}
                </span>
                {finding.subject === undefined ? null : (
                  <span className="audit-fidelity-panel__finding-subject">
                    {` Object: ${safeLabel(finding.subject)}.`}
                  </span>
                )}
                {finding.requirementId === undefined ? null : (
                  <span className="audit-fidelity-panel__finding-requirement">
                    {` Requirement: ${safeLabel(finding.requirementId)}.`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {control.warnings.length === 0 ? null : (
        <section className="audit-fidelity-panel__warnings" aria-labelledby={warningsHeadingId}>
          <Subheading id={warningsHeadingId}>{WARNINGS_HEADING}</Subheading>
          <ul>
            {control.warnings.map((warning, index) => (
              <li key={`warning-${index}`}>{safeProse(warning)}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Renders a resource selector, folding in its API group.
 *
 * The empty API group is the core group and is rendered as the bare resource
 * name, which is how the policy itself refers to it. A non-empty group is shown
 * in parentheses, because `clusterroles` in `rbac.authorization.k8s.io` and a
 * hypothetical `clusterroles` elsewhere are different resources.
 *
 * @param expectation - the measured row being described.
 * @returns the resource selector as it should be displayed.
 */
function describeExpectationSelector(expectation: AuditLevelExpectation): string {
  return expectation.apiGroup === ''
    ? expectation.resource
    : `${expectation.resource} (${expectation.apiGroup})`;
}

/** Rendered in the observed column of a row this check does not report. */
const NOT_MEASURED_HERE_TEXT = 'Not measured by this check';

/** Rendered in the observed column of a reportable row the payload left out. */
const NOT_REPORTED_TEXT = 'Reportable, but not reported';

/** Prefixed to an observed level that does not equal the required one. */
const LEVEL_MISMATCH_PREFIX = 'differs: ';

/**
 * How one row's observed level reads, and whether it agrees with the requirement.
 *
 * Three outcomes, kept apart because they are three different facts and only the last is a
 * defect: this check does not report the row at all; it could report it and did not; it
 * reported it and the value either matches or does not.
 */
interface ObservedLevelCell {
  /** The text of the cell. */
  readonly text: string;
  /** `data-observed` attribute, so a spec can address the outcome without parsing text. */
  readonly outcome: 'not-measured' | 'unreported' | 'match' | 'mismatch';
}

/**
 * Resolves the observed-level cell for one expectation row (M6).
 *
 * The distinction this function exists to draw: a row with no `observedIdentity` is
 * measured elsewhere — by the shell-tier generator matrix — and saying so is honest, while
 * showing its required level in an "Observed" column would be a fabrication. A row that
 * COULD be reported and was not reads differently again, because that is a gap in this
 * check rather than a property of the row.
 */
function resolveObservedLevel(
  expectation: AuditLevelExpectation,
  observations: readonly ControlObservation[],
): ObservedLevelCell {
  const identity = expectation.observedIdentity;
  if (identity === undefined) {
    return { text: NOT_MEASURED_HERE_TEXT, outcome: 'not-measured' };
  }
  const observed = readString(observations, identity);
  if (observed.state !== 'reported') {
    return { text: NOT_REPORTED_TEXT, outcome: 'unreported' };
  }
  const value = safeObservationValue(observed.value);
  return observed.value === expectation.level
    ? { text: value, outcome: 'match' }
    : { text: `${LEVEL_MISMATCH_PREFIX}${value}`, outcome: 'mismatch' };
}

/** Props of the level table. */
interface AuditLevelTableProps {
  /** The rows to render, already filtered. Never empty; the caller guards that. */
  readonly expectations: readonly AuditLevelExpectation[];
  /**
   * The observations this check reported, used to fill the observed column.
   *
   * Empty when no control payload arrived, in which case every reportable row reads
   * "Reportable, but not reported" — which is the correct answer while a request is in
   * flight or after it failed, and is precisely what the previous single-column table could
   * not express.
   */
  readonly observations: readonly ControlObservation[];
}

/**
 * The measured per-resource audit levels, one row per matrix cell.
 *
 * Invariant locked: every level cell renders its ordinal alongside its name, so
 * the strict total order is visible in the rendered output and not merely
 * encoded in the source. A row that read `Request` and a row that read
 * `RequestResponse` would otherwise look like two equal alternatives.
 *
 * The `<caption>` supplies the table's accessible name, and each row's resource
 * selector is a `<th scope="row">` so an assistive technology announces which
 * resource a level belongs to when reading across. `data-audit-level` mirrors
 * the level as an attribute for styling and for a spec that wants to assert on a
 * row without parsing its text.
 */
function AuditLevelTable({ expectations, observations }: AuditLevelTableProps): ReactElement {
  return (
    <table className="audit-fidelity-panel__levels-table">
      <caption>{LEVELS_TABLE_CAPTION}</caption>
      <thead>
        <tr>
          <th scope="col">Resource selector</th>
          <th scope="col">Scope</th>
          <th scope="col">Verbs</th>
          <th scope="col">Principals</th>
          {/*
            TWO level columns, and the split is the whole of the M6 presentation fix. The
            first is transcribed from an oracle and is true of the repository whether or not
            any check ran; the second is what THIS check reported. One column headed "Audit
            level" presented the first as if it were the second.
          */}
          <th scope="col">Required level</th>
          <th scope="col">Observed level</th>
          <th scope="col">Requirement recorded in</th>
        </tr>
      </thead>
      <tbody>
        {expectations.map((expectation) => {
          const observed = resolveObservedLevel(expectation, observations);
          return (
          <tr
            key={expectation.id}
            data-expectation={expectation.id}
            data-audit-level={expectation.level}
            data-observed={observed.outcome}
          >
            <th scope="row">{describeExpectationSelector(expectation)}</th>
            <td>{expectation.scope}</td>
            <td>{expectation.verbs.join(', ')}</td>
            <td>
              {expectation.principals.length === 0 ? (
                <span className="audit-fidelity-panel__principals-empty">
                  No principal recorded
                </span>
              ) : (
                <ul className="audit-fidelity-panel__principals">
                  {expectation.principals.map((principal) => (
                    <li key={principal}>{principal}</li>
                  ))}
                </ul>
              )}
            </td>
            <td>{describeAuditLevel(expectation.level)}</td>
            <td>{observed.text}</td>
            <td>{expectation.measuredIn}</td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Props of the observed-event table. */
interface ObservedAuditEventTableProps {
  /**
   * The observed events, exactly as the server returned them. Never empty; the
   * caller guards that.
   */
  readonly events: readonly AuditEvent[];
}

/**
 * The observed audit events, with their recorded payloads described but never
 * rendered.
 *
 * Invariant locked, and this is the presentation-layer mirror of the V6
 * confidentiality guard: no audited body is ever written into the DOM. Only
 * `!== undefined` is read, and only prose is emitted, so there is no code path
 * from `requestObject` or `responseObject` to the rendered output — for a
 * `secrets` event or for any other. A `secrets` event that carries a response
 * body is additionally reported as a finding, because at the required level the
 * response object is omitted and its presence means the payload reached the
 * audit log.
 *
 * The React key combines the audit identifier, the stage and the index: one
 * request emits several events across its stages, so the identifier alone is not
 * unique within a page, and a duplicate key would silently drop rows.
 */
function ObservedAuditEventTable({ events }: ObservedAuditEventTableProps): ReactElement {
  return (
    <table className="audit-fidelity-panel__events-table">
      <caption>{EVENTS_TABLE_CAPTION}</caption>
      <thead>
        <tr>
          <th scope="col">Target</th>
          <th scope="col">Verb</th>
          <th scope="col">Audit level</th>
          <th scope="col">Recorded payloads</th>
          <th scope="col">Fidelity findings</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => {
          const findings = auditEventFindings(event);
          return (
            <tr
              key={`${event.auditID}:${event.stage}:${index}`}
              data-audit-level={event.level}
              data-finding-count={findings.length}
            >
              <th scope="row">{describeAuditEventTarget(event)}</th>
              <td>{safeObservationValue(event.verb)}</td>
              <td>{describeAuditLevel(event.level)}</td>
              <td>{describeRecordedPayloads(event)}</td>
              <td>
                {findings.length === 0 ? (
                  <span className="audit-fidelity-panel__no-findings">None</span>
                ) : (
                  <ul className="audit-fidelity-panel__event-findings">
                    {findings.map((finding, findingIndex) => (
                      <li key={`${event.auditID}:${index}:${findingIndex}`}>{finding}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Props of the presentational body, which never touches a hook of its own. */
interface AuditFidelityPanelViewProps {
  /** The resolved control-status lifecycle state. */
  readonly result: UseControlStatusResult;
  /** The measured rows to tabulate, before filtering. */
  readonly expectations: readonly AuditLevelExpectation[];
  /**
   * Observed events to tabulate, or `undefined` to omit the section entirely.
   * An empty list is NOT the same as `undefined`: see
   * {@link AuditFidelityPanelProps.events}.
   */
  readonly events?: readonly AuditEvent[];
  /** Replaces the result's own refresh; see {@link AuditFidelityPanelProps.onRefresh}. */
  readonly onRefresh?: () => void;
  /** Whether refreshing can achieve anything; see {@link AuditFidelityPanelProps.canRefresh}. */
  readonly canRefresh?: boolean;
}

/**
 * The whole panel, rendered from already-resolved state.
 *
 * This is where the layout, the landmarks and the interaction live. It calls no
 * data hook, so it renders identically whether its state came from the network
 * or from a caller — which is what makes the panel deterministically drivable.
 *
 * STRUCTURE, and why every part of it is addressable by role plus accessible
 * name rather than by a test identifier or by raw text:
 *
 *   * the outer `<section>` is named by its `<h2>`, so it resolves to a `region`
 *     named "Sensitive-resource audit fidelity";
 *   * exactly ONE of the loading region, the failure alert and the verdict
 *     region renders, because the three are keyed off the same discriminant;
 *   * the level table and the observed events each sit in their own nested
 *     `<section>` named by an `<Subheading>`, and each table is named by its
 *     `<caption>`;
 *   * the refresh control is a native `<button type="button">` and the filter is
 *     a native `<select>` associated with a real `<label>`, so both are keyboard
 *     operable and correctly named without a single ARIA attribute;
 *   * the four live regions carry `aria-labelledby` pointing at VISIBLE text, so
 *     the name an assistive technology announces is the name on screen.
 *
 * The heading order is h2 then h3 with no level skipped, and the only `<div>`s
 * are the two grouping wrappers for which no semantic element exists.
 */
function AuditFidelityPanelView({
  result,
  expectations,
  events,
  onRefresh,
  canRefresh = true,
}: AuditFidelityPanelViewProps): ReactElement {
  // EMBEDDED-AWARE OWN HEADING (m3), bound once for this component.
  const rendersOwnHeading = useRendersOwnHeading();
  // EMBEDDED-AWARE LIVE REGION (m4). Standalone this element announces; embedded it keeps
  // its text and drops the role, because the dashboard's aggregate region announces the one
  // collection transition and nine simultaneous announcements bury the summary.
  const liveStatusRole = useLiveRegionRole('status');
  // EMBEDDED-AWARE SUBHEADING LEVEL (m3). `h3` when this panel is the page, `h4` when the
  // dashboard has already named the control with an `h3` above it — so the heading run stays
  // monotonic in both documents and a subsection is never a sibling of the control it belongs to.
  const Subheading = usePanelSubheading();
  // One base per instance, suffixed per element, so two panels on one page never
  // collide and so no identifier depends on render order.
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  // EMBEDDED-AWARE REGION NAME (m3). The region is named by whichever heading exists: this
  // panel's own when standalone, the dashboard's control heading when embedded. Without this
  // an embedded panel would point `aria-labelledby` at an id it no longer renders, leaving a
  // region with no accessible name at all.
  const panelLabelId = usePanelLabelId(headingId);
  const levelsHeadingId = `${baseId}-levels-heading`;
  const eventsHeadingId = `${baseId}-events-heading`;
  const verdictLabelId = `${baseId}-verdict-label`;
  const loadingLabelId = `${baseId}-loading-label`;
  const errorLabelId = `${baseId}-error-label`;
  const levelsEmptyLabelId = `${baseId}-levels-empty-label`;
  const eventsEmptyLabelId = `${baseId}-events-empty-label`;
  const filterId = `${baseId}-level-filter`;

  // ONE refresh channel: a caller's handler REPLACES the result's own rather than
  // running alongside it, and an unavailable refresh resolves to `undefined` so the
  // button is disabled and explains itself instead of accepting a dead press.
  const refresh = resolveRefreshHandler(onRefresh, result.refresh, canRefresh);

  const [levelFilter, setLevelFilter] = useState<AuditLevelFilterValue>(ALL_LEVELS_VALUE);

  // Stable across renders so it is safe as a prop, and narrowed through
  // isAuditLevel so an unrecognised value falls back to "no filter" rather than
  // silently emptying the table.
  const handleFilterChange = useCallback((changeEvent: ChangeEvent<HTMLSelectElement>): void => {
    const chosen = changeEvent.target.value;
    setLevelFilter(isAuditLevel(chosen) ? chosen : ALL_LEVELS_VALUE);
  }, []);

  // Filtering never reorders and never rewrites a row: it only selects. The
  // unfiltered case returns the original list by identity rather than a copy.
  const visibleExpectations = useMemo(
    () =>
      levelFilter === ALL_LEVELS_VALUE
        ? expectations
        : expectations.filter((expectation) => expectation.level === levelFilter),
    [expectations, levelFilter],
  );

  // Reachable only from the success arm. The error arm has no `controls` member
  // at all, so this cannot be read from a failed request even by accident.
  const control =
    result.status === 'success'
      ? selectControlStatus(result.controls, AUDIT_FIDELITY_CONTROL_ID)
      : undefined;

  return (
    <section className="audit-fidelity-panel" aria-labelledby={panelLabelId}>
      {/*
        EMBEDDED-AWARE OWN HEADING (m3). See embeddedPanel.tsx: embedded, the dashboard has
        already named this control, so a second title would duplicate the name and restart the
        heading run above its own level.
      */}
      {rendersOwnHeading ? (
        <h2 className="audit-fidelity-panel__heading" id={headingId}>
          {PANEL_HEADING}
        </h2>
      ) : null}
      <p className="audit-fidelity-panel__requirements">
        {`Requirements covered: ${COVERED_REQUIREMENT_IDS.join(', ')}.`}
      </p>
      <div className="audit-fidelity-panel__controls">
        <button
          className="audit-fidelity-panel__refresh"
          type="button"
          onClick={refresh}
          disabled={refresh === undefined}
          title={refresh === undefined ? REFRESH_UNAVAILABLE_TITLE : undefined}
        >
          {REFRESH_LABEL}
        </button>
      </div>

      {result.status === 'loading' && <AuditFidelityLoading labelId={loadingLabelId} />}
      {result.status === 'error' && (
        <AuditFidelityError error={result.error} labelId={errorLabelId} />
      )}
      {result.status === 'success' && (
        <AuditFidelityVerdict control={control} labelId={verdictLabelId} events={events ?? []} />
      )}
      {control === undefined ? null : (
        <AuditMeasurementList control={control} events={events ?? []} />
      )}
      {control === undefined ? null : <AuditFidelityControlDetail control={control} />}

      <section className="audit-fidelity-panel__levels-region" aria-labelledby={levelsHeadingId}>
        <Subheading id={levelsHeadingId}>{LEVELS_HEADING}</Subheading>
        <p className="audit-fidelity-panel__legend">
          {`Audit levels are strictly ordered: ${AUDIT_LEVEL_ORDER_LEGEND}. ` +
            `${SECRETS_RESOURCE} is audited at exactly ` +
            `${describeAuditLevel(SECRETS_REQUIRED_LEVEL)} and never above it, so an audited ` +
            `response body is never recorded for one.`}
        </p>
        <div className="audit-fidelity-panel__filter">
          <label className="audit-fidelity-panel__filter-label" htmlFor={filterId}>
            {FILTER_LABEL}
          </label>
          <select
            className="audit-fidelity-panel__filter-control"
            id={filterId}
            value={levelFilter}
            onChange={handleFilterChange}
          >
            <option value={ALL_LEVELS_VALUE}>{ALL_LEVELS_OPTION_LABEL}</option>
            {AUDIT_LEVEL_ORDER.map((level) => (
              <option key={level} value={level}>
                {describeAuditLevel(level)}
              </option>
            ))}
          </select>
        </div>
        {visibleExpectations.length === 0 ? (
          <p
            className="audit-fidelity-panel__state audit-fidelity-panel__state--empty"
            role={liveStatusRole}
            aria-labelledby={levelsEmptyLabelId}
          >
            <strong id={levelsEmptyLabelId}>{LEVELS_EMPTY_LABEL}</strong>{' '}
            <span className="audit-fidelity-panel__state-detail">
              {levelFilter === ALL_LEVELS_VALUE
                ? 'No measured audit levels were supplied to this panel, so no level can be shown.'
                : `No measured audit level matches the ${levelFilter} filter. Choose ` +
                  `"${ALL_LEVELS_OPTION_LABEL}" to see every level.`}
            </span>
          </p>
        ) : (
          <AuditLevelTable
            expectations={visibleExpectations}
            observations={control?.evidence?.observations ?? NO_OBSERVATIONS}
          />
        )}
      </section>

      {events === undefined ? null : (
        <section className="audit-fidelity-panel__events-region" aria-labelledby={eventsHeadingId}>
          <Subheading id={eventsHeadingId}>{EVENTS_HEADING}</Subheading>
          {events.length === 0 ? (
            <p
              className="audit-fidelity-panel__state audit-fidelity-panel__state--empty"
              role={liveStatusRole}
              aria-labelledby={eventsEmptyLabelId}
            >
              <strong id={eventsEmptyLabelId}>{EVENTS_EMPTY_LABEL}</strong>{' '}
              <span className="audit-fidelity-panel__state-detail">
                No audit event was observed for this control, so no recorded payload can be
                reported.
              </span>
            </p>
          ) : (
            <ObservedAuditEventTable events={events} />
          )}
        </section>
      )}
    </section>
  );
}

/** Props of the hook-connected wrapper. */
interface ConnectedAuditFidelityPanelProps {
  /** Forwarded unchanged to the presentational body. */
  readonly expectations: readonly AuditLevelExpectation[];
  /** Forwarded unchanged to the presentational body. */
  readonly events?: readonly AuditEvent[];
  /** Forwarded unchanged to the presentational body. */
  readonly onRefresh?: () => void;
  /** Forwarded unchanged to the presentational body. */
  readonly canRefresh?: boolean;
}

/**
 * The hook-connected wrapper, mounted only when no pre-resolved state was
 * supplied.
 *
 * This separation is a Rules-of-Hooks requirement rather than a stylistic
 * preference. `useControlStatus` exposes no way to stand down — it takes only a
 * control identifier and always issues its request — so the choice is between
 * calling it conditionally, which is illegal and would desynchronise React's
 * hook order, and mounting it conditionally, which is legal because hook state
 * belongs to a component instance. Splitting the component is the second option:
 * when a caller supplies `result`, this wrapper is never mounted and no request
 * is ever issued, so a caller-driven render performs no network access at all.
 */
function ConnectedAuditFidelityPanel({
  expectations,
  events,
  onRefresh,
  canRefresh = true,
}: ConnectedAuditFidelityPanelProps): ReactElement {
  const result = useControlStatus(AUDIT_FIDELITY_CONTROL_ID);
  return (
    <AuditFidelityPanelView
      result={result}
      expectations={expectations}
      events={events}
      onRefresh={onRefresh}
      canRefresh={canRefresh}
    />
  );
}

/**
 * Everything {@link AuditFidelityPanel} accepts. Every field is optional, so
 * `<AuditFidelityPanel />` is a complete, self-sufficient usage.
 */
export interface AuditFidelityPanelProps {
  /**
   * Pre-resolved control-status state.
   *
   * Supply it to drive the panel deterministically: pass the loading arm to
   * render the in-flight affordance, the error arm to render the failure alert
   * — including a 403 or a 500 with its status code — or the success arm with or
   * without a V6 entry to render a verdict or the unknown affordance. While it
   * is supplied NO request is issued, because the hook-calling child is not
   * mounted.
   *
   * Omit it and the panel queries the V6 control itself through
   * `useControlStatus`. Do not toggle between the two across renders on one
   * instance: presence decides which subtree is mounted, so a change would
   * remount and discard the filter selection.
   */
  readonly result?: UseControlStatusResult;
  /**
   * The measured audit-level rows to tabulate.
   *
   * Defaults to the full measured set transcribed from the Go oracle, which is
   * what production rendering uses. Override it to render a subset, and pass an
   * empty list to render the empty affordance.
   */
  readonly expectations?: readonly AuditLevelExpectation[];
  /**
   * Observed audit events to tabulate.
   *
   * Three distinct meanings, deliberately: `undefined` omits the observed-event
   * section altogether, an empty list renders the section with its empty
   * affordance, and a non-empty list renders one row per event. "Not asked for"
   * and "asked for and none found" are different facts, and a panel that
   * conflated them would report an absence of evidence as evidence of absence.
   *
   * Events are read for the PRESENCE of their audited bodies only. No audited
   * body is ever rendered.
   */
  readonly events?: readonly AuditEvent[];
  /**
   * Called when the refresh control is used, REPLACING the result's own `refresh`
   * rather than running alongside it, so one press is one request. With a
   * pre-resolved state that owns no request and no handler here, the control is
   * disabled and carries a title saying why.
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
}

/**
 * The V6 audit-fidelity posture panel.
 *
 * Renders the verdict for the sensitive-resource audit-fidelity control
 * (F-006-RQ-002, F-006-RQ-003), the measured per-resource audit levels, and —
 * when observed events are supplied — what each event recorded, described
 * without ever rendering an audited payload.
 *
 * THE INVARIANT THIS COMPONENT EXISTS TO MAKE VISIBLE: `secrets` is audited at
 * exactly `Request` and never at `RequestResponse`, and
 * `None < Metadata < Request < RequestResponse` is a strict total order that
 * cannot be silently downgraded. Every rendered level carries its ordinal, the
 * order itself is imported from its single definition site rather than restated,
 * and an observed `secrets` event that sits above or below the required level is
 * reported as a finding that names which way it deviated.
 *
 * @example Production usage — the panel fetches its own state.
 * ```tsx
 * <AuditFidelityPanel />
 * ```
 *
 * @example Driving every state deterministically, with no network access.
 * ```tsx
 * <AuditFidelityPanel result={{ status: 'loading', refresh }} />
 * <AuditFidelityPanel result={{ status: 'error', refresh, error: {
 *   kind: 'http', httpStatus: 403, reason: 'Forbidden', message: 'forbidden',
 * } }} />
 * <AuditFidelityPanel result={{ status: 'success', refresh, isEmpty: true, controls: [] }} />
 * ```
 *
 * @param props - see {@link AuditFidelityPanelProps}; all fields are optional.
 * @returns the rendered panel.
 */
export default function AuditFidelityPanel({
  result,
  expectations = AUDIT_LEVEL_EXPECTATIONS,
  events,
  onRefresh,
  canRefresh = true,
}: AuditFidelityPanelProps): ReactElement {
  if (result === undefined) {
    return (
      <ConnectedAuditFidelityPanel
        expectations={expectations}
        events={events}
        onRefresh={onRefresh}
        canRefresh={canRefresh}
      />
    );
  }
  return (
    <AuditFidelityPanelView
      result={result}
      expectations={expectations}
      events={events}
      onRefresh={onRefresh}
      canRefresh={canRefresh}
    />
  );
}
