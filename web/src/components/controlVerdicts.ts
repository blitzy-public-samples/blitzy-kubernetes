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

// AAP §0.5.5 (shared test data and shared helpers have ONE definition site) / §0.7.2
// ("failure legibility": one control, one answer) / §0.10.2 (every boundary condition the
// eight resolvers enforce) / tech-spec §6.6.3.4.
//
// THE SINGLE PLACE THE EFFECTIVE VERDICT OF A CONTROL IS DECIDED.
//
// THE DEFECT THIS MODULE EXISTS TO PREVENT. Each panel reconciles what the check REPORTED
// against what it MEASURED, and downgrades the reported verdict when the two disagree: a
// reported `pass` carrying no evidence becomes `unknown`, and a reported `pass` beside a
// plaintext etcd endpoint, a fail-open webhook, a Secret response body in the audit log or
// an attached finding becomes `fail`. The aggregate dashboard, meanwhile, counted, filtered
// and summarised the RAW `status.verdict`. So the surface a reader trusts at a glance could
// report "Pass: 8" over eight panels of which one rendered a failure — the worst possible
// place for the two to disagree, because the aggregate is what gets screenshotted.
//
// HOW THE DISAGREEMENT IS MADE STRUCTURALLY IMPOSSIBLE. Each panel exports the resolver it
// renders from, this module maps every control identifier onto that panel's own resolver,
// and the dashboard uses only this module. There is no second implementation to drift: the
// number in the tally and the badge in the panel are the same function call.
//
// WHY THE REGISTRY LIVES IN THE COMPONENT LAYER RATHER THAN IN web/src/domain. The domain
// modules are React-free by construction and are imported by the fixtures; a registry that
// imported eight React components would drag React into that graph. Keeping it here also
// keeps the import graph ACYCLIC: this module imports the panels, the dashboard imports
// this module and the panels, and no panel imports this module. (The refresh contract in
// ./refreshContract.ts is imported BY the panels and imports nothing, for the same reason.)

import type { ControlId, ControlStatus } from '../hooks/useControlStatus';
import { CONTROL_IDS } from '../hooks/useControlStatus';
import type { EffectiveVerdict } from '../domain/evidence';
import { resolveAuditFidelityEffectiveVerdict } from './AuditFidelityPanel';
import { resolveEncryptionAtRestEffectiveVerdict } from './EncryptionAtRestPanel';
import { resolveEtcdTransportEffectiveVerdict } from './EtcdTransportPanel';
import { resolveNodeIsolationEffectiveVerdict } from './NodeIsolationPanel';
import { resolvePodSecurityEffectiveVerdict } from './PodSecurityPanel';
import { resolveRbacWildcardEffectiveVerdict } from './RbacWildcardPanel';
import { resolveTokenHygieneEffectiveVerdict } from './TokenHygienePanel';
import { resolveWebhookPostureEffectiveVerdict } from './WebhookPosturePanel';

/**
 * How one control's payload is reduced to the verdict its panel renders.
 *
 * A single-argument function on purpose: every resolver must be answerable from the
 * control payload alone, so the dashboard can ask the same question the panel asks
 * without having to reproduce a panel's other props.
 */
export type ControlVerdictResolver = (status: ControlStatus) => EffectiveVerdict;

/**
 * Every control's own resolver, exported by the panel that renders it.
 *
 * `Record<ControlId, ...>` rather than a partial map: a control added to `CONTROL_IDS`
 * without a resolver here is a `tsc --noEmit` error rather than a control silently
 * falling back to its raw reported verdict.
 *
 * V6's exported resolver takes an optional second argument — the observed audit events
 * whose local findings it folds in — so it is adapted here to the one-argument shape. The
 * dashboard renders `AuditFidelityPanel` with no `events` prop, so the panel folds in an
 * empty list too and the two answers are identical rather than merely similar.
 */
export const CONTROL_VERDICT_RESOLVERS: Readonly<Record<ControlId, ControlVerdictResolver>> =
  Object.freeze({
    V1: resolveRbacWildcardEffectiveVerdict,
    V2: resolvePodSecurityEffectiveVerdict,
    V3: resolveEncryptionAtRestEffectiveVerdict,
    V4: resolveTokenHygieneEffectiveVerdict,
    V5: resolveWebhookPostureEffectiveVerdict,
    V6: (status: ControlStatus): EffectiveVerdict => resolveAuditFidelityEffectiveVerdict(status),
    V7: resolveNodeIsolationEffectiveVerdict,
    V8: resolveEtcdTransportEffectiveVerdict,
  });

/**
 * The verdict one control actually holds, including the case where it has no payload.
 *
 * Invariant locked: an absent control is `unknown`, NEVER `pass`. The Go oracle pairs every
 * negative assertion with a positive control for exactly this reason — a check that cannot
 * tell "no evidence" from "good evidence" also passes when the whole authorization stack is
 * broken — and this function is where that distinction is preserved for the aggregate.
 *
 * Invariant locked: the answer is the PANEL'S OWN, obtained from the panel's own exported
 * resolver rather than read off `status.verdict`. A control whose panel downgrades a
 * reported pass is counted as downgraded here too.
 *
 * @param controlId - which control is being judged; selects the resolver.
 * @param status - that control's payload, or `undefined` when the response omitted it.
 * @returns the verdict the control's own panel renders for that payload.
 */
export function resolveEffectiveControlVerdict(
  controlId: ControlId,
  status: ControlStatus | undefined,
): EffectiveVerdict {
  if (status === undefined) {
    return 'unknown';
  }
  return CONTROL_VERDICT_RESOLVERS[controlId](status);
}

/**
 * The roster, re-exported so a consumer iterating the controls and a consumer resolving one
 * of them agree on what the roster is without importing from two modules.
 */
export const RESOLVED_CONTROL_IDS: readonly ControlId[] = CONTROL_IDS;
