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
//   3. `describeSecretsLevelDeviation` compares an OBSERVED `secrets` event
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

import type { AuditEvent, AuditLevel } from '../hooks/useAuditEvents';
import { AUDIT_LEVEL_ORDER } from '../hooks/useAuditEvents';
import type {
  ControlId,
  ControlStatus,
  ControlStatusError,
  ControlVerdict,
  UseControlStatusResult,
} from '../hooks/useControlStatus';
import { selectControlStatus, useControlStatus } from '../hooks/useControlStatus';

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
function describeSecretsLevelDeviation(observed: AuditLevel): string | undefined {
  const observedRank = auditLevelRank(observed);
  const requiredRank = auditLevelRank(SECRETS_REQUIRED_LEVEL);
  if (observedRank > requiredRank) {
    return (
      `Audited at ${describeAuditLevel(observed)}, above the required ` +
      `${describeAuditLevel(SECRETS_REQUIRED_LEVEL)}. A level above the required one records ` +
      `the response body, so the payload reached the audit log.`
    );
  }
  if (observedRank < requiredRank) {
    return (
      `Audited at ${describeAuditLevel(observed)}, below the required ` +
      `${describeAuditLevel(SECRETS_REQUIRED_LEVEL)}. A level below the required one drops the ` +
      `forensic record of the change.`
    );
  }
  return undefined;
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
  if (event.objectRef?.resource !== SECRETS_RESOURCE) {
    return NO_FINDINGS;
  }
  const findings: string[] = [];
  if (event.responseObject !== undefined) {
    findings.push(SECRETS_RESPONSE_BODY_FINDING);
  }
  const deviation = describeSecretsLevelDeviation(event.level);
  if (deviation !== undefined) {
    findings.push(deviation);
  }
  return findings;
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
  const objectRef = event.objectRef;
  if (objectRef === undefined) {
    return `non-resource request ${event.requestURI}`;
  }
  const selector =
    objectRef.subresource === undefined || objectRef.subresource === ''
      ? objectRef.resource
      : `${objectRef.resource}/${objectRef.subresource}`;
  const group =
    objectRef.apiGroup === undefined || objectRef.apiGroup === '' ? 'core' : objectRef.apiGroup;
  const scope =
    objectRef.namespace === undefined || objectRef.namespace === ''
      ? 'cluster-scoped'
      : `namespace ${objectRef.namespace}`;
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
const LEVELS_TABLE_CAPTION = 'Measured per-resource audit levels';
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
  return (
    <p
      className="audit-fidelity-panel__state audit-fidelity-panel__state--loading"
      role="status"
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
 * says outright that no verdict is available. `role="alert"` rather than
 * `role="status"` because a failed posture check is assertive: it must be
 * announced without waiting for the operator to reach it.
 *
 * The status code and the server's own `reason` are rendered when present and
 * simply omitted when they are not. `httpStatus` is absent exactly for a
 * transport failure, where no response — and therefore no status — ever existed;
 * inventing a zero there would report a status the server never sent.
 */
function AuditFidelityError({ error, labelId }: AuditFidelityErrorProps): ReactElement {
  return (
    <p
      className="audit-fidelity-panel__state audit-fidelity-panel__state--error"
      role="alert"
      aria-labelledby={labelId}
      data-error-kind={error.kind}
    >
      <strong id={labelId}>{ERROR_LABEL}</strong>{' '}
      <span className="audit-fidelity-panel__error-message">{error.message}</span>
      {error.httpStatus === undefined ? null : (
        <span className="audit-fidelity-panel__error-status">
          {` HTTP status ${error.httpStatus}.`}
        </span>
      )}
      {error.reason === undefined ? null : (
        <span className="audit-fidelity-panel__error-reason">{` Reason: ${error.reason}.`}</span>
      )}
      <span className="audit-fidelity-panel__state-detail">
        {' No verdict is available for this control, and this is not a pass.'}
      </span>
    </p>
  );
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
}

/**
 * The verdict affordance: one of four mutually exclusive outcomes.
 *
 * Invariant locked: an absent control resolves to `unknown`, never to `pass`.
 * `selectControlStatus` returns `undefined` when the payload does not mention
 * the control, and treating that silence as success would let this panel report
 * a clean control on evidence it never received.
 *
 * `data-verdict` carries the resolved verdict so a stylesheet can distinguish
 * the four outcomes without this component inventing colour classes, and so
 * colour is never the sole carrier of meaning: the affordance text states the
 * verdict in words regardless of how it is styled.
 */
function AuditFidelityVerdict({ control, labelId }: AuditFidelityVerdictProps): ReactElement {
  const verdict: ControlVerdict = control === undefined ? 'unknown' : control.verdict;
  const summary = control === undefined ? ABSENT_CONTROL_SUMMARY : control.summary;
  const presentation = VERDICT_PRESENTATION[verdict];
  return (
    <p
      className="audit-fidelity-panel__state audit-fidelity-panel__state--verdict"
      role="status"
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
  const baseId = useId();
  const findingsHeadingId = `${baseId}-findings-heading`;
  const warningsHeadingId = `${baseId}-warnings-heading`;
  const reportedRequirements = control.requirementIds;
  return (
    <div className="audit-fidelity-panel__reported">
      {control.detail === undefined ? null : (
        <p className="audit-fidelity-panel__detail">{control.detail}</p>
      )}
      {reportedRequirements === undefined || reportedRequirements.length === 0 ? null : (
        <p className="audit-fidelity-panel__reported-requirements">
          {`Requirements reported by the server: ${reportedRequirements.join(', ')}.`}
        </p>
      )}
      {control.observedAt === undefined ? null : (
        <p className="audit-fidelity-panel__observed-at">{`Evaluated at ${control.observedAt}.`}</p>
      )}
      {control.findings.length === 0 ? null : (
        <section className="audit-fidelity-panel__findings" aria-labelledby={findingsHeadingId}>
          <h3 id={findingsHeadingId}>{FINDINGS_HEADING}</h3>
          <ul>
            {control.findings.map((finding, index) => (
              <li key={`finding-${index}`}>
                <span className="audit-fidelity-panel__finding-message">{finding.message}</span>
                {finding.subject === undefined ? null : (
                  <span className="audit-fidelity-panel__finding-subject">
                    {` Object: ${finding.subject}.`}
                  </span>
                )}
                {finding.requirementId === undefined ? null : (
                  <span className="audit-fidelity-panel__finding-requirement">
                    {` Requirement: ${finding.requirementId}.`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {control.warnings.length === 0 ? null : (
        <section className="audit-fidelity-panel__warnings" aria-labelledby={warningsHeadingId}>
          <h3 id={warningsHeadingId}>{WARNINGS_HEADING}</h3>
          <ul>
            {control.warnings.map((warning, index) => (
              <li key={`warning-${index}`}>{warning}</li>
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

/** Props of the measured level table. */
interface AuditLevelTableProps {
  /** The rows to render, already filtered. Never empty; the caller guards that. */
  readonly expectations: readonly AuditLevelExpectation[];
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
function AuditLevelTable({ expectations }: AuditLevelTableProps): ReactElement {
  return (
    <table className="audit-fidelity-panel__levels-table">
      <caption>{LEVELS_TABLE_CAPTION}</caption>
      <thead>
        <tr>
          <th scope="col">Resource selector</th>
          <th scope="col">Scope</th>
          <th scope="col">Verbs</th>
          <th scope="col">Principals</th>
          <th scope="col">Audit level</th>
          <th scope="col">Measured in</th>
        </tr>
      </thead>
      <tbody>
        {expectations.map((expectation) => (
          <tr
            key={expectation.id}
            data-expectation={expectation.id}
            data-audit-level={expectation.level}
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
            <td>{expectation.measuredIn}</td>
          </tr>
        ))}
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
              <td>{event.verb}</td>
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
 *     `<section>` named by an `<h3>`, and each table is named by its
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
}: AuditFidelityPanelViewProps): ReactElement {
  // One base per instance, suffixed per element, so two panels on one page never
  // collide and so no identifier depends on render order.
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const levelsHeadingId = `${baseId}-levels-heading`;
  const eventsHeadingId = `${baseId}-events-heading`;
  const verdictLabelId = `${baseId}-verdict-label`;
  const loadingLabelId = `${baseId}-loading-label`;
  const errorLabelId = `${baseId}-error-label`;
  const levelsEmptyLabelId = `${baseId}-levels-empty-label`;
  const eventsEmptyLabelId = `${baseId}-events-empty-label`;
  const filterId = `${baseId}-level-filter`;

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
    <section className="audit-fidelity-panel" aria-labelledby={headingId}>
      <h2 className="audit-fidelity-panel__heading" id={headingId}>
        {PANEL_HEADING}
      </h2>
      <p className="audit-fidelity-panel__requirements">
        {`Requirements covered: ${COVERED_REQUIREMENT_IDS.join(', ')}.`}
      </p>
      <div className="audit-fidelity-panel__controls">
        <button className="audit-fidelity-panel__refresh" type="button" onClick={result.refresh}>
          {REFRESH_LABEL}
        </button>
      </div>

      {result.status === 'loading' && <AuditFidelityLoading labelId={loadingLabelId} />}
      {result.status === 'error' && (
        <AuditFidelityError error={result.error} labelId={errorLabelId} />
      )}
      {result.status === 'success' && (
        <AuditFidelityVerdict control={control} labelId={verdictLabelId} />
      )}
      {control === undefined ? null : <AuditFidelityControlDetail control={control} />}

      <section className="audit-fidelity-panel__levels-region" aria-labelledby={levelsHeadingId}>
        <h3 id={levelsHeadingId}>{LEVELS_HEADING}</h3>
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
            role="status"
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
          <AuditLevelTable expectations={visibleExpectations} />
        )}
      </section>

      {events === undefined ? null : (
        <section className="audit-fidelity-panel__events-region" aria-labelledby={eventsHeadingId}>
          <h3 id={eventsHeadingId}>{EVENTS_HEADING}</h3>
          {events.length === 0 ? (
            <p
              className="audit-fidelity-panel__state audit-fidelity-panel__state--empty"
              role="status"
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
}: ConnectedAuditFidelityPanelProps): ReactElement {
  const result = useControlStatus(AUDIT_FIDELITY_CONTROL_ID);
  return <AuditFidelityPanelView result={result} expectations={expectations} events={events} />;
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
}: AuditFidelityPanelProps): ReactElement {
  if (result === undefined) {
    return <ConnectedAuditFidelityPanel expectations={expectations} events={events} />;
  }
  return <AuditFidelityPanelView result={result} expectations={expectations} events={events} />;
}

