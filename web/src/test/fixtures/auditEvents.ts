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

// Recorded `audit.k8s.io/v1` audit-event payloads, in WIRE shape, for the React
// test tier's V6 (sensitive-resource audit fidelity) coverage.
//
// AAP §0.5.1 (the web/src/test/fixtures/auditEvents.ts row: "Recorded
// `audit.k8s.io/v1` event payloads", sourced from test/utils/audit.go) /
// §0.5.2.5 (React-tier fixture detail, including the requirement for one
// non-`secrets` event that DOES carry a response object) / §0.5.5 (shared test
// data has exactly ONE definition site) / §0.4.2.4 (the L6/L7 React blueprints:
// AuditFidelityPanel and ConfidentialityRedaction) / §0.10.2 (boundary
// conditions that must port unchanged) / tech-spec §6.6.3.4 (every fixture
// states the invariant it locks).
//
// Requirements locked by this module: F-006-RQ-001 (the generated audit policy's
// per-resource levels), F-006-RQ-002 (sensitive-resource audit event emission
// and level projection) and F-006-RQ-003 (audit fidelity enabled by default).
//
// WHAT THIS FILE IS
//   The recorded data behind the V6 audit-fidelity panel and, critically, behind
//   the presentation-layer confidentiality guard. Every value below is
//   transcribed from a measured line of
//   test/integration/controlplane/audit/audit_test.go,
//   test/utils/audit.go or cluster/gce/gci/audit_policy_test.go. The Go suite
//   stays the parity oracle (AAP §0.8.2 deletes no `*_test.go`); this file
//   records what that oracle asserts so the React tier can assert the same
//   invariants at the presentation layer.
//
// WHAT THIS FILE IS NOT
//   It is not a generator, not a source of truth and not a validator. It holds
//   pure data plus two pure builders. It exports no predicate that decides
//   whether an event violates the confidentiality guard, deliberately: a
//   component test that asked this fixture "is this a violation?" and then
//   asserted the component agreed would be testing the fixture, not the
//   component. The guard is asserted against the RENDERED output, using this
//   data as input.
//
// THE THREE PROPERTIES THAT MATTER MOST
//   1. WIRE SHAPE, NOT THE GO PROJECTION. `test/utils/audit.go` L151-156
//      flattens `requestObject`/`responseObject` to presence BOOLEANS
//      (`if e.ResponseObject != nil { event.ResponseObject = true }`) so its
//      structs compare cheaply. Here they are OBJECTS or the key is ABSENT.
//      Collapsing them back to booleans would make the confidentiality guard
//      inexpressible in the React tier while every spec stayed green.
//   2. ABSENCE IS AN OMITTED KEY. Never `undefined`, never `null`. A presence
//      check (`'responseObject' in event`, or `event.responseObject !== undefined`)
//      is only meaningful if absence is modelled by omission.
//   3. THE GUARD ACCUMULATES. The Go guard
//      (test/integration/controlplane/audit/audit_test.go L1043-1047) uses
//      `t.Errorf`, not `t.Fatalf`, so EVERY offending event is reported in one
//      run. The React mirror must therefore use `expect.soft(...)` inside its
//      loop rather than a plain, hard-throwing `expect`, or it will hide every
//      offender after the first. This is the assertion-semantics translation
//      required by AAP §0.4.1.2.
//
// A NOTE ON DETERMINISM (AAP §0.7.2)
//   Every value here is a frozen literal: no clock is read, no identifier is
//   generated and no pseudo-random value is drawn, so two runs of any spec that
//   consumes this module see byte-identical input and the suite stays green under
//   randomised file ordering and parallel workers. The timestamps and audit
//   identifiers below are fixed strings for exactly that reason.

import {
  AUTHORIZATION_DECISION_ANNOTATION,
  type AuditEvent,
  type AuditLevel,
  type AuditPayload,
} from '../../hooks/useAuditEvents';

// ---------------------------------------------------------------------------
// SECTION 1 -- Recorded identifiers.
//
// Single definition site (AAP §0.5.5): the namespaces, object names, principal
// and API versions below are used by every builder and every table in this file,
// so an edit propagates instead of diverging.
// ---------------------------------------------------------------------------

/**
 * Namespace the V6 policy raises to `Request` for the `secrets` resource,
 * recorded from `test/integration/controlplane/audit/audit_test.go` L991-995
 * (the `secrets-request` case) and from `auditPolicyPattern` L109-113.
 *
 * INVARIANT LOCKED (F-006-RQ-002): the level is namespace-scoped, so the
 * namespace name is part of the recorded contract, not decoration.
 */
export const SECRET_AUDIT_REQUEST_NAMESPACE = 'secret-audit-request';

/**
 * Namespace the V6 policy holds at `RequestResponse` for the RBAC `roles` and
 * `rolebindings` resources, recorded from `audit_test.go` L996-1001 (the
 * `rbac-response` case) and from `auditPolicyPattern` L114-118.
 */
export const RBAC_AUDIT_RESPONSE_NAMESPACE = 'rbac-audit-response';

/**
 * The principal every recorded V6 event is attributed to, recorded from
 * `audit_test.go` L125 (`auditTestUser = "system:apiserver"`).
 *
 * On the wire this is `user.username`. The Go projection flattens the whole
 * `user` object down to this one string (`event.User = e.User.Username`,
 * test/utils/audit.go L142), which is why no `uid` or `groups` is recorded
 * below: neither is measured, and AAP §0.11.1 ("evidence over assumption")
 * forbids inventing one.
 */
export const AUDIT_TEST_USERNAME = 'system:apiserver';

/** Secret the V6 secrets case creates, updates and deletes (`audit_test.go` L744). */
export const AUDIT_SECRET_NAME = 'audit-secret';

/** Role the V6 RBAC case creates, updates and deletes (`audit_test.go` L764). */
export const AUDIT_ROLE_NAME = 'audit-role';

/** RoleBinding the V6 RBAC case creates, updates and deletes (`audit_test.go` L782). */
export const AUDIT_ROLE_BINDING_NAME = 'audit-rolebinding';

/**
 * The audit-log versions the V6 integration test runs against, recorded from
 * `audit_test.go` L126-128.
 *
 * EXACTLY ONE ENTRY, and that is the recorded fact rather than a simplification:
 * the Go `versions` map is a single-key map, so this is a one-element tuple and
 * not an open-ended list. It is typed against `AuditEvent['apiVersion']` so the
 * two can never drift apart -- adding a version here without widening the hook's
 * literal union fails `tsc --noEmit`.
 */
export const AUDIT_LOG_VERSIONS = ['audit.k8s.io/v1'] as const satisfies readonly AuditEvent['apiVersion'][];

/**
 * The two sensitive-resource case names, recorded from `audit_test.go`
 * L984-1002 (`sensitiveTestCases[].name`).
 */
export type SensitiveResourceCaseName = 'secrets-request' | 'rbac-response';

/**
 * The authorizer verdict recorded on every V6 event
 * (`AuthorizeDecision: "allow"`, `audit_test.go` L825 and its eight siblings).
 *
 * Module-private on purpose: consumers read the value off an event through
 * `AUTHORIZATION_DECISION_ANNOTATION`, which is the hook's exported key, so
 * exporting a second constant here would create a second thing to keep in step.
 * The literal `'allow'` is written once, here.
 */
const AUDIT_DECISION_ALLOW = 'allow';

/**
 * The Secret's only `data` value: base64 of the three-letter string `"val"`,
 * recorded from `audit_test.go` L745
 * (`Data: map[string][]byte{"key": []byte("val")}`).
 *
 * NO SECRETS, EVER (AAP §0.11.1). This is obviously synthetic -- it decodes to
 * three lower-case letters, it protects nothing, it matches no provider's
 * credential format, and it is the only base64 blob in this file. No bearer
 * token, PEM block, API key or certificate appears anywhere here.
 */
const AUDIT_SECRET_SYNTHETIC_DATA_VALUE = 'dmFs';

// ---------------------------------------------------------------------------
// SECTION 1b -- The wire-to-flat translation, stated once.
//
// `test/utils/audit.go`'s own `AuditEvent` (L36-58) is a FLATTENED TEST
// PROJECTION, not the wire event, and `testEventFromInternalFiltered` (L136-182)
// is the authority on how one becomes the other. Read in the direction this file
// needs -- wire from flat -- every row of that mapping is:
//
//   flat `Level`, `Stage`, `RequestURI`, `Verb`  -> the same names, camelCased
//   flat `User` (a plain string)                 -> `user.username`   (L142)
//   flat `Code`                                  -> `responseStatus.code` (L149)
//   flat `Resource`, `Namespace`                 -> `objectRef.resource`,
//                                                   `objectRef.namespace` (L145-146)
//   flat `AuthorizeDecision`                     -> `annotations` indexed by
//                                                   AUTHORIZATION_DECISION_ANNOTATION (L162)
//   flat `RequestObject bool`                    -> `requestObject` OBJECT, or the
//                                                   key is absent  (L154-156)
//   flat `ResponseObject bool`                   -> `responseObject` OBJECT, or the
//                                                   key is absent  (L151-153)
//   flat `ImpersonatedUser`                      -> `impersonatedUser.username` (L158)
//   flat `ImpersonatedGroups` (one string)       -> `impersonatedUser.groups`, a
//                                                   string ARRAY  (L159-160)
//
// THE IMPERSONATION ROW IS THE EASIEST ONE TO GET WRONG. The Go side does
// `sort.Strings(e.ImpersonatedUser.Groups)` then `strings.Join(..., ",")`, so its
// struct holds ONE comma-separated string. That is a Go-side convenience for
// cheap struct comparison; the wire carries an array and `AuditUserInfo.groups`
// is typed `string[]` accordingly. No recorded V6 event impersonates anybody, so
// no fixture below sets `impersonatedUser` at all -- the key is omitted rather
// than set to an empty object. The row is written down here so that if a future
// recorded event ever needs it, it is added as an ARRAY and never as the flat
// comma-joined string.
//
// TWO FIELDS EXIST ON THE WIRE BUT ARE NOT PARITY-RELEVANT.
//   * `auditID`. The projection at L137-142 initialises its struct with exactly
//     Level, Stage, RequestURI, Verb and User: it NEVER reads `e.AuditID`, so the
//     flat struct's `ID` field is left unset and the oracle's
//     `reflect.DeepEqual` comparison (L208) never sees it. The field is
//     nonetheless a real part of an `audit.k8s.io/v1` event and every fixture
//     below carries a realistic literal value, because an event without one would
//     misrepresent the wire. But NOTHING in this tier may treat `auditID` as a
//     parity-relevant field: do not assert a specific value, do not derive a
//     verdict from it, and do not use it to match an event against the baseline.
//     Its legitimate uses are a stable React list key and human-readable
//     correlation in a rendered table.
//   * `objectRef.name`. The flat struct has no `Name` field at all, so the same
//     rule applies. It is recorded below where the measured URI names an object,
//     because a panel showing "which object" needs it, but it is not a parity
//     field either.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SECTION 2 -- Recorded request and response bodies.
//
// PRESENCE is what the parity oracle measures: `test/utils/audit.go` L151-156
// records only `RequestObject bool` / `ResponseObject bool`.
//
// REQUEST bodies below carry the objects the measured operations actually
// construct and pass (`secretOperations` L742-755, `rbacOperations` L762-800), so
// they are traceable evidence. Server-populated fields -- `uid`,
// `resourceVersion`, `creationTimestamp` -- are deliberately absent: they are not
// recorded anywhere in the cited sources, and inventing them would breach
// "evidence over assumption" for no gain, since no assertion in this tier reads
// them.
//
// RESPONSE bodies are CAPTURED API-SERVER OUTPUT -- see the capture note on
// {@link AUDIT_RBAC_RESPONSE_CAPTURE} below. They are the bytes a real
// kube-apiserver wrote into a real audit log at `RequestResponse` for exactly the
// six measured operations. Two earlier attempts at this field were both wrong and
// are recorded here so neither is retried: reusing the corresponding REQUEST
// object (which no server returns), and then a self-describing presence MARKER
// (which is not an API-server response either, and which put a
// `audit.k8s.io`-shaped key nobody ships into the real `responseObject` wire
// field). The oracle records only that a body existed, so nothing here is
// parity-relevant -- but a fixture that occupies a wire field must hold wire
// data, and now it does.
//
// Consumers read body PRESENCE and never contents, which is exactly the fact the
// oracle supports.
// ---------------------------------------------------------------------------

/**
 * The Secret body sent by the V6 create and update, recorded from
 * `audit_test.go` L743-746.
 *
 * INVARIANT LOCKED (F-006-RQ-002, the accepted trade-off): at `Request` the API
 * server records the REQUEST object, so a Secret write does log `.data`. That is
 * the explicitly accepted cost of `Request` over `RequestResponse`
 * (`audit_test.go` L1040-1042), not a defect to be "fixed" by deleting this
 * body -- deleting it would make the fixture assert a control that is not the
 * one the system implements.
 */
function auditSecretRequestBody(namespace: string): AuditPayload {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: AUDIT_SECRET_NAME, namespace },
    data: { key: AUDIT_SECRET_SYNTHETIC_DATA_VALUE },
  };
}

/**
 * The Role body sent by the V6 RBAC create and update, recorded from
 * `audit_test.go` L763-766.
 *
 * INVARIANT LOCKED (F-006-RQ-002): RBAC objects carry no secret material, which
 * is precisely why the policy holds them at `RequestResponse` for full forensic
 * detail (`auditPolicyPattern`'s own comment at L103-108 and its rule at L114-118). A reader can confirm
 * that from this body: a verb, an API group and a resource name, nothing more.
 */
function auditRoleBody(namespace: string): AuditPayload {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: AUDIT_ROLE_NAME, namespace },
    rules: [{ verbs: ['get'], apiGroups: [''], resources: ['pods'] }],
  };
}

/**
 * The RoleBinding body sent by the V6 RBAC create and update, recorded from
 * `audit_test.go` L781-793.
 *
 * The `roleRef` deliberately names a Role that the measured operation sequence
 * has already deleted: RoleBindings permit dangling references because
 * resolution happens at authorization time (`audit_test.go` L774-780). Recording
 * it faithfully keeps the fixture honest about what the oracle exercises.
 */
function auditRoleBindingBody(namespace: string): AuditPayload {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: AUDIT_ROLE_BINDING_NAME, namespace },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: AUDIT_ROLE_NAME,
    },
    subjects: [
      {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'User',
        name: 'audit-user',
      },
    ],
  };
}

/**
 * The body of every recorded delete, recorded from the `metav1.DeleteOptions{}`
 * argument at `audit_test.go` L753 (Secret), L771 (Role) and L798
 * (RoleBinding).
 *
 * The measured value is the EMPTY options struct, so only `kind` appears here.
 * `apiVersion` is deliberately not asserted: the cited sources do not record
 * which group version the options are serialised under, and guessing one would
 * be an invention. This is why a delete still carries a request object -- the
 * options are the request body -- which is exactly what the oracle's
 * `RequestObject: true` on all three deletes records.
 */
const AUDIT_DELETE_OPTIONS_BODY: AuditPayload = { kind: 'DeleteOptions' };

/**
 * The `metadata.managedFields[].manager` the capture produced.
 *
 * Kubernetes derives the field manager from the client's user agent, so this names the
 * client that performed the capture and nothing about the system under test. It is
 * recorded as a constant rather than repeated as a literal so a reader meets the
 * explanation once and cannot mistake it for a value the oracle asserts.
 */
const AUDIT_CAPTURE_FIELD_MANAGER = 'blitzy-audit-capture';

/**
 * How the six RBAC `responseObject` bodies below were obtained.
 *
 * THEY ARE CAPTURED, NOT COMPOSED. A real `kube-apiserver` built from this tree
 * (`_output/bin/kube-apiserver`, `v1.34.0-blitzy`) was run against a real `etcd`
 * 3.6.5 under an audit policy holding
 * `rbac.authorization.k8s.io` `roles` and `rolebindings` at `RequestResponse` in the
 * namespace `rbac-audit-response` -- the same rule as `auditPolicyPattern`'s last
 * entry (`audit_test.go` L113-L118). The six operations of `rbacOperations`
 * (`audit_test.go` L762-L800) were then replayed exactly: a `Role` named
 * `audit-role` carrying the single `get`/core/`pods` rule and a `RoleBinding` named
 * `audit-rolebinding` whose `roleRef` names that Role and whose one subject is the
 * user `audit-user`, each created, updated with the identical object and deleted with
 * empty `DeleteOptions`. The response codes observed were 201, 200, 200 and 201, 200,
 * 200, matching `rbacAuditResponseEvents` (L859-L935) exactly, and all six events
 * carried both a `requestObject` and a `responseObject` at level `RequestResponse`,
 * matching the oracle's `RequestObject: true` / `ResponseObject: true`.
 *
 * WHY CAPTURE RATHER THAN COMPOSE. `test/utils/audit.go` L151-156 reduces every
 * audited body to a BOOLEAN -- `if e.ResponseObject != nil { event.ResponseObject =
 * true }` -- so the oracle proves a body existed and says nothing about its contents.
 * That is a licence to record nothing, NOT a licence to record anything: this file
 * models the WIRE event, and `responseObject` is a real `audit.k8s.io/v1` member, so
 * whatever sits in it is read as bytes an API server produced. Two earlier fillings
 * were not: the corresponding REQUEST object (a create response carries `uid`,
 * `resourceVersion` and `creationTimestamp` a request cannot have, and a delete
 * response is not the target object at all), and then a self-describing marker keyed
 * `audit.k8s.io.blitzy/body` -- honest about its own emptiness, but still a
 * test-only value wearing an API-group-shaped key inside the field itself. Capturing
 * the bodies removes the choice: there is nothing left to decide.
 *
 * WHAT THE CAPTURE SETTLED that could not previously be written down. The delete
 * responses are a `Status` with `status: 'Success'` and a `details` block naming the
 * deleted object's `name`, `group`, `kind` and `uid`. An earlier comment in this file
 * recorded that no `Status` shape appeared in any cited source and that guessing one
 * would be an invention -- correct at the time, and now simply measured.
 *
 * WHICH FIELDS ARE CAPTURE-SPECIFIC, stated so nothing here is over-read. `uid`,
 * `resourceVersion`, `creationTimestamp` and `managedFields[].time` are whatever that
 * one run produced, and `managedFields[].manager` is the capturing client's user
 * agent (`blitzy-audit-capture`), which is why it is that and not a Go client name.
 * NONE of them is parity-relevant, because the oracle compares presence only, and no
 * assertion in this tier reads any of them. They are kept rather than stripped for the
 * same reason the rest is: a body with its server-populated fields removed would be a
 * shape no server returns, which is the defect this replaces.
 *
 * NO CONFIDENTIAL MATERIAL IS PRESENT, and that is structural rather than lucky:
 * `roles` and `rolebindings` carry no secret material, which is exactly why the audit
 * policy holds them at `RequestResponse` in the first place. The `secrets` events in
 * this file still omit `responseObject` entirely.
 */
export const AUDIT_RBAC_RESPONSE_CAPTURE =
  'kube-apiserver v1.34.0-blitzy (_output/bin) + etcd 3.6.5, audit policy ' +
  'RequestResponse on rbac.authorization.k8s.io roles+rolebindings, replaying ' +
  'audit_test.go rbacOperations L762-L800';

/**
 * The `Role` the API server returned from the measured create and update.
 *
 * Both verbs returned the identical object: the update re-sends the same Role, so it
 * is a no-op that leaves `resourceVersion` where it was. Recorded once and used for
 * both, because two copies of one measured body could only drift.
 *
 * @param namespace - the namespace the capture ran in; pass
 *   {@link RBAC_AUDIT_RESPONSE_NAMESPACE} to reproduce the recorded case.
 * @returns the captured response body.
 */
function auditRoleResponseBody(namespace: string): AuditPayload {
  return {
    kind: 'Role',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    metadata: {
      name: AUDIT_ROLE_NAME,
      namespace,
      uid: '1a12fd12-b303-4f00-8764-08d40842be98',
      resourceVersion: '92',
      creationTimestamp: '2026-08-13T16:37:06Z',
      managedFields: [
        {
          manager: AUDIT_CAPTURE_FIELD_MANAGER,
          operation: 'Update',
          apiVersion: 'rbac.authorization.k8s.io/v1',
          time: '2026-08-13T16:37:06Z',
          fieldsType: 'FieldsV1',
          fieldsV1: { 'f:rules': {} },
        },
      ],
    },
    rules: [{ verbs: ['get'], apiGroups: [''], resources: ['pods'] }],
  };
}

/**
 * The `RoleBinding` the API server returned from the measured create and update.
 *
 * Note the field ORDER the server chose -- `subjects` before `roleRef` -- which is the
 * reverse of the order the request body sends them in. Recorded as returned, because
 * the point of a captured body is that nothing about it was decided here.
 *
 * @param namespace - the namespace the capture ran in.
 * @returns the captured response body.
 */
function auditRoleBindingResponseBody(namespace: string): AuditPayload {
  return {
    kind: 'RoleBinding',
    apiVersion: 'rbac.authorization.k8s.io/v1',
    metadata: {
      name: AUDIT_ROLE_BINDING_NAME,
      namespace,
      uid: '70448bd2-ee64-4baf-b46f-981ad32967d2',
      resourceVersion: '94',
      creationTimestamp: '2026-08-13T16:37:06Z',
      managedFields: [
        {
          manager: AUDIT_CAPTURE_FIELD_MANAGER,
          operation: 'Update',
          apiVersion: 'rbac.authorization.k8s.io/v1',
          time: '2026-08-13T16:37:06Z',
          fieldsType: 'FieldsV1',
          fieldsV1: { 'f:roleRef': {}, 'f:subjects': {} },
        },
      ],
    },
    subjects: [
      { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: 'audit-user' },
    ],
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: AUDIT_ROLE_NAME },
  };
}

/**
 * The `Status` the API server returned from a measured RBAC delete.
 *
 * THE SHAPE THAT COULD NOT BE GUESSED. A delete returns neither the target object nor
 * the request's `DeleteOptions`: it returns a success `Status` whose `details` name
 * what was removed. `metadata` is present and empty, exactly as captured.
 *
 * @param kind - the plural lower-case resource, `'roles'` or `'rolebindings'`, as the
 *   server reports it in `details.kind`.
 * @param name - the deleted object's name.
 * @param uid - the deleted object's uid, as captured.
 * @returns the captured response body.
 */
function auditDeleteStatusResponseBody(
  kind: string,
  name: string,
  uid: string,
): AuditPayload {
  return {
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Success',
    details: { name, group: 'rbac.authorization.k8s.io', kind, uid },
  };
}


// ---------------------------------------------------------------------------
// SECTION 3 -- The THREE secrets events, at level `Request`.
//
// Recorded from `secretAuditRequestEvents`,
// test/integration/controlplane/audit/audit_test.go L812-852. The count was
// verified by counting the `Level:` keys in that exact range: THREE.
//
// WHY THREE EXPECTED AND NOT FOUR -- AND WHY FOUR ARE LOGGED.
// `secretOperations` (L742-755) performs FOUR calls -- create, GET, update,
// delete -- and the oracle expects three events. The reason is recorded in that
// function's own comment at L739-L741: "the get is intentionally not asserted
// (CheckAuditLines ignores unmatched log lines)". So the fourth event IS WRITTEN
// TO THE AUDIT LOG; it is simply absent from the expected table, and
// `CheckAuditLinesFiltered` (test/utils/audit.go L92-L130) is a PRESENCE check
// that marks expectations off against the stream and ignores every line it did
// not expect.
//
// The distinction is load-bearing rather than pedantic. The audit LEVEL decides
// what a recorded event CONTAINS, never whether one exists: at `Request` the API
// server records the request object and never the response object, and a read
// carries its payload only in the RESPONSE -- so the Secret GET is logged with no
// Secret data in it whatsoever, which is the whole point of choosing `Request`.
// That makes the GET the single most valuable event in the stream for the
// confidentiality guard, because it is a `secrets` event that the expected table
// does not contain.
//
// The builder below therefore returns the THREE ASSERTED events and nothing else,
// so it stays a faithful mirror of `secretAuditRequestEvents` -- adding a fourth
// expectation would fail against the real audit log for a namespace whose policy
// never promised one. The logged-but-unasserted GET lives in
// {@link secretsRequestUnassertedAuditEvents} and reaches consumers through
// {@link ALL_OBSERVED_AUDIT_EVENTS}.
//
// WHY NO RESPONSE OBJECT (F-006-RQ-002, AAP §0.10.2). Recorded from the source
// comment at `audit_test.go` L802-811 and asserted by the guard at L1043-1047:
// `secrets` sit at EXACTLY `Request`, never `RequestResponse`, precisely so the
// response body -- which would duplicate the Secret payload plus
// server-populated fields -- is never written to the audit log. Every event
// below therefore OMITS the `responseObject` key. Not `undefined`, not `null`:
// omitted, so a presence check means something.
//
// Timestamps are frozen synthetic literals. `testEventFromInternalFiltered`
// projects NEITHER timestamp (test/utils/audit.go L136-142), so no measured
// value exists to record; their only contract is that
// `requestReceivedTimestamp <= stageTimestamp` within an event and that the nine
// events in this file ascend in the order the operations ran.
// ---------------------------------------------------------------------------

/**
 * Builds the three expected `secrets` audit events for a namespace, mirroring
 * the Go builder `secretAuditRequestEvents(namespace)` (`audit_test.go` L812).
 *
 * INVARIANT LOCKED (F-006-RQ-002): `secrets` are audited at exactly `Request`;
 * a Secret audit event carries a `requestObject` on writes and NEVER a
 * `responseObject`.
 *
 * Parameterised by namespace for the same reason the Go builder is: the audit
 * policy is namespace-scoped, so the namespace is an input to the expectation
 * rather than a constant of it. {@link SECRETS_REQUEST_AUDIT_EVENTS} is this
 * function applied to the recorded namespace.
 *
 * Returns a FRESH array of fresh objects on every call, which is what makes it
 * safe to hand to a spec that mutates its input: no two callers can observe each
 * other's edits, so the suite stays order-independent under `pytest-randomly`'s
 * React-tier equivalent (randomised file order and parallel workers).
 *
 * @param namespace - the namespace the audit policy raises to `Request`; pass
 *   {@link SECRET_AUDIT_REQUEST_NAMESPACE} to reproduce the recorded case.
 * @returns the three events, ordered create, update, delete.
 */
export function secretsRequestAuditEvents(namespace: string): AuditEvent[] {
  const collectionURI = `/api/v1/namespaces/${namespace}/secrets`;
  const objectURI = `${collectionURI}/${AUDIT_SECRET_NAME}`;

  return [
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: '2f6c1d84-9a3b-4c17-8f0e-5d71b2c48a91',
      level: 'Request',
      stage: 'ResponseComplete',
      // L817: fmt.Sprintf("/api/v1/namespaces/%s/secrets", namespace)
      requestURI: collectionURI,
      verb: 'create',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:02.512431Z',
      stageTimestamp: '2026-02-17T09:14:02.549118Z',
      objectRef: {
        resource: 'secrets',
        namespace,
        // No `name`: a create posts to the collection URI, and the oracle's flat
        // struct has no Name field at all (test/utils/audit.go L36-58), so the
        // name is not a parity-relevant field in either direction.
        apiGroup: '',
        apiVersion: 'v1',
      },
      responseStatus: { code: 201 },
      requestObject: auditSecretRequestBody(namespace),
      // responseObject: intentionally ABSENT -- see the section header.
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: '4b8e7a02-1c5d-4e93-9a26-7f0c3d81b64e',
      level: 'Request',
      stage: 'ResponseComplete',
      // L829: .../secrets/audit-secret
      requestURI: objectURI,
      verb: 'update',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:03.104772Z',
      stageTimestamp: '2026-02-17T09:14:03.138905Z',
      objectRef: {
        resource: 'secrets',
        namespace,
        name: AUDIT_SECRET_NAME,
        apiGroup: '',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      requestObject: auditSecretRequestBody(namespace),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: '6d1f93b5-2e48-4a70-8c39-1b5e7a026f4d',
      level: 'Request',
      stage: 'ResponseComplete',
      // L841: the SAME URI as the update -- recorded, not a copy-paste slip.
      requestURI: objectURI,
      verb: 'delete',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:03.702240Z',
      stageTimestamp: '2026-02-17T09:14:03.741366Z',
      objectRef: {
        resource: 'secrets',
        namespace,
        name: AUDIT_SECRET_NAME,
        apiGroup: '',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      // A delete's request body is the DeleteOptions, which is why the oracle
      // records RequestObject: true here too (L847).
      requestObject: AUDIT_DELETE_OPTIONS_BODY,
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
  ];
}

/**
 * Builds the `secrets` audit event the oracle CAUSES but does not assert: the
 * Secret read from `secretOperations` (`audit_test.go` L750-L751).
 *
 * INVARIANT LOCKED (F-006-RQ-002): a Secret READ is audited at `Request` and
 * carries NEITHER a `requestObject` (a GET has no request body) NOR a
 * `responseObject` (the level forbids it). It is the event that proves the
 * confidentiality guard is scanning the stream rather than the expectations,
 * because no expected-events table contains it.
 *
 * WHY IT IS SEPARATE FROM THE EXPECTED SET, AND MUST STAY SEPARATE. The two sets
 * answer different questions and the Go oracle keeps them apart on purpose. The
 * expected set is checked for PRESENCE -- every entry must be found, and
 * `audit_test.go` L1021-L1024 fails the wait loop while any is missing. The
 * observed stream is checked for a PROHIBITION -- L1039-L1046 iterates
 * `missingReport.AllEvents` and reports every `secrets` event carrying a response
 * object. Merging them would break both directions at once: this GET would become
 * an expectation the recorded policy never promised, and the guard would go back
 * to scanning only what it already expected.
 *
 * Timestamps sit between the recorded create and update, matching the order the
 * operations ran. Like every timestamp in this file they are frozen synthetic
 * literals, because `testEventFromInternalFiltered` projects neither timestamp
 * (test/utils/audit.go L133-L148) and so no measured value exists to record.
 *
 * @param namespace - the namespace the audit policy raises to `Request`; pass
 *   {@link SECRET_AUDIT_REQUEST_NAMESPACE} to reproduce the recorded case.
 * @returns the single logged-but-unasserted read event, in a fresh array.
 */
export function secretsRequestUnassertedAuditEvents(namespace: string): AuditEvent[] {
  return [
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: '8a4c2e17-5b93-4d06-9f81-3c7e0a52d9b6',
      level: 'Request',
      stage: 'ResponseComplete',
      requestURI: `/api/v1/namespaces/${namespace}/secrets/${AUDIT_SECRET_NAME}`,
      verb: 'get',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:02.803556Z',
      stageTimestamp: '2026-02-17T09:14:02.831094Z',
      objectRef: {
        resource: 'secrets',
        namespace,
        name: AUDIT_SECRET_NAME,
        apiGroup: '',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      // requestObject: ABSENT -- a GET carries no request body.
      // responseObject: ABSENT -- `Request` never records one. This event is the
      // reason the guard has something to find that the expectations do not hold.
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
  ];
}


// ---------------------------------------------------------------------------
// SECTION 4 -- The SIX RBAC events, at level `RequestResponse`.
//
// Recorded from `rbacAuditResponseEvents`, `audit_test.go` L859-935. The count
// was verified by counting the `Level:` keys in that exact range: SIX.
//
// SIX, NOT THREE. The case is named `rbac-response`, which reads like one trio,
// and the natural assumption is a single resource. The measured function returns
// TWO trios -- `roles` create/update/delete AND `rolebindings`
// create/update/delete -- because the policy raises BOTH resources
// (`auditPolicyPattern` L114-118 lists `["roles", "rolebindings"]`) and
// `rbacOperations` L762-800 exercises both. Recording only three would silently
// halve the RBAC coverage.
//
// WHY THESE KEEP BOTH BODIES (F-006-RQ-002). Recorded from `auditPolicyPattern`
// L103-108 and `rbacAuditResponseEvents`' own comment at L854-858: RBAC objects
// carry no secret material, so they stay at `RequestResponse` for full forensic
// detail. Every event below therefore carries BOTH `requestObject` AND
// `responseObject`.
//
// THIS IS ALSO THE CONFIDENTIALITY GUARD'S CONTROL GROUP (AAP §0.5.2.5).
// web/src/components/ConfidentialityRedaction.test.tsx must prove the UI redacts
// ONLY what it should. A fixture set in which nothing carried a response object
// would let a component that blanket-hides every response body pass, which is a
// different (and wrong) behaviour. These six events are the required non-`secrets`
// events that DO carry one. DO NOT "tidy" them away, and do not strip their
// response bodies: doing so would disarm the control group and the redaction
// test would stop proving anything.
// ---------------------------------------------------------------------------

/**
 * Builds the six expected RBAC audit events for a namespace, mirroring the Go
 * builder `rbacAuditResponseEvents(namespace)` (`audit_test.go` L859).
 *
 * INVARIANT LOCKED (F-006-RQ-002): `roles` and `rolebindings` are audited at
 * exactly `RequestResponse`, and BOTH resources are covered -- three events each,
 * six in total.
 *
 * Returns a FRESH array of fresh objects on every call, for the isolation reason
 * given on {@link secretsRequestAuditEvents}.
 *
 * @param namespace - the namespace the audit policy holds at `RequestResponse`;
 *   pass {@link RBAC_AUDIT_RESPONSE_NAMESPACE} to reproduce the recorded case.
 * @returns the six events, ordered roles create/update/delete then rolebindings
 *   create/update/delete, matching the recorded order.
 */
export function rbacResponseAuditEvents(namespace: string): AuditEvent[] {
  // The FULL measured prefix, recorded from L864 and its five siblings. It is
  // `/apis/<group>/v1/...`, not `/api/v1/...`: RBAC is a named API group, so the
  // path is plural `apis` and carries the group. Getting this wrong would make
  // every URI assertion in the tier wrong in the same direction and therefore
  // invisible.
  const groupPrefix = `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}`;
  const rolesCollectionURI = `${groupPrefix}/roles`;
  const roleObjectURI = `${rolesCollectionURI}/${AUDIT_ROLE_NAME}`;
  const roleBindingsCollectionURI = `${groupPrefix}/rolebindings`;
  const roleBindingObjectURI = `${roleBindingsCollectionURI}/${AUDIT_ROLE_BINDING_NAME}`;

  return [
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: '8a25c470-3f61-4b8d-95e2-0c7d4b19f38a',
      level: 'RequestResponse',
      stage: 'ResponseComplete',
      requestURI: rolesCollectionURI,
      verb: 'create',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:05.118742Z',
      stageTimestamp: '2026-02-17T09:14:05.152903Z',
      objectRef: {
        resource: 'roles',
        namespace,
        apiGroup: 'rbac.authorization.k8s.io',
        apiVersion: 'v1',
      },
      responseStatus: { code: 201 },
      requestObject: auditRoleBody(namespace),
      responseObject: auditRoleResponseBody(namespace),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: '9c47e18b-4a72-4d61-8b03-6e29f5c07a1d',
      level: 'RequestResponse',
      stage: 'ResponseComplete',
      requestURI: roleObjectURI,
      verb: 'update',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:05.701318Z',
      stageTimestamp: '2026-02-17T09:14:05.734255Z',
      objectRef: {
        resource: 'roles',
        namespace,
        name: AUDIT_ROLE_NAME,
        apiGroup: 'rbac.authorization.k8s.io',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      requestObject: auditRoleBody(namespace),
      responseObject: auditRoleResponseBody(namespace),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: 'a3f05d29-5b83-4e72-9d14-8c60a7be215f',
      level: 'RequestResponse',
      stage: 'ResponseComplete',
      requestURI: roleObjectURI,
      verb: 'delete',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:06.284907Z',
      stageTimestamp: '2026-02-17T09:14:06.319140Z',
      objectRef: {
        resource: 'roles',
        namespace,
        name: AUDIT_ROLE_NAME,
        apiGroup: 'rbac.authorization.k8s.io',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      requestObject: AUDIT_DELETE_OPTIONS_BODY,
      // The oracle records ResponseObject: true for this delete (L895) and records only
      // PRESENCE, so its contents had to come from somewhere else -- and this is the
      // event that shows why capturing beats composing. An earlier comment here reasoned
      // that neither a `Status` nor the target object could be substituted, because no
      // `Status` shape appeared in any cited source and a delete does not return its
      // target. Both halves were right. The capture settles it: a delete returns a
      // success `Status` whose `details` name what was removed.
      responseObject: auditDeleteStatusResponseBody(
        'roles',
        AUDIT_ROLE_NAME,
        '1a12fd12-b303-4f00-8764-08d40842be98',
      ),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: 'b5921ec4-6c94-4f83-8e25-9d71b8cf3260',
      level: 'RequestResponse',
      stage: 'ResponseComplete',
      requestURI: roleBindingsCollectionURI,
      verb: 'create',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:06.872455Z',
      stageTimestamp: '2026-02-17T09:14:06.906618Z',
      objectRef: {
        resource: 'rolebindings',
        namespace,
        apiGroup: 'rbac.authorization.k8s.io',
        apiVersion: 'v1',
      },
      responseStatus: { code: 201 },
      requestObject: auditRoleBindingBody(namespace),
      responseObject: auditRoleBindingResponseBody(namespace),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: 'c7d43fa1-7da5-4092-9f36-0e82c9d04371',
      level: 'RequestResponse',
      stage: 'ResponseComplete',
      requestURI: roleBindingObjectURI,
      verb: 'update',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:07.455201Z',
      stageTimestamp: '2026-02-17T09:14:07.489773Z',
      objectRef: {
        resource: 'rolebindings',
        namespace,
        name: AUDIT_ROLE_BINDING_NAME,
        apiGroup: 'rbac.authorization.k8s.io',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      requestObject: auditRoleBindingBody(namespace),
      responseObject: auditRoleBindingResponseBody(namespace),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
    {
      apiVersion: 'audit.k8s.io/v1',
      kind: 'Event',
      auditID: 'd9e650b3-8eb6-41a3-8047-1f93dae15482',
      level: 'RequestResponse',
      stage: 'ResponseComplete',
      requestURI: roleBindingObjectURI,
      verb: 'delete',
      user: { username: AUDIT_TEST_USERNAME },
      requestReceivedTimestamp: '2026-02-17T09:14:08.038612Z',
      stageTimestamp: '2026-02-17T09:14:08.072944Z',
      objectRef: {
        resource: 'rolebindings',
        namespace,
        name: AUDIT_ROLE_BINDING_NAME,
        apiGroup: 'rbac.authorization.k8s.io',
        apiVersion: 'v1',
      },
      responseStatus: { code: 200 },
      requestObject: AUDIT_DELETE_OPTIONS_BODY,
      // The captured `Status`, as above. The uid differs from the Role's because it is a
      // different object: recording one uid for both would be the first invention back.
      responseObject: auditDeleteStatusResponseBody(
        'rolebindings',
        AUDIT_ROLE_BINDING_NAME,
        '70448bd2-ee64-4baf-b46f-981ad32967d2',
      ),
      annotations: { [AUTHORIZATION_DECISION_ANNOTATION]: AUDIT_DECISION_ALLOW },
    },
  ];
}


// ---------------------------------------------------------------------------
// SECTION 5 -- The recorded collections.
//
// Each constant is its builder applied to the recorded namespace, rather than a
// second copy of the same data written out by hand. That is deliberate: with one
// definition site (AAP §0.5.5) a correction to a URI, verb or status code cannot
// land in the builder and miss the constant. The initialisers below are pure
// calls into functions declared above -- no IO, no global mutation, no clock and
// no randomness -- so importing this module has no observable effect beyond
// binding names.
//
// All four are typed `readonly AuditEvent[]`. `readonly` is the point: a spec
// that spliced or sorted a shared fixture in place would leak that edit into
// every later spec in the same worker, and the compiler now refuses. A consumer
// that genuinely needs a mutable array should call the builder, which hands back
// a fresh one, or spread the constant.
// ---------------------------------------------------------------------------

/**
 * The three recorded `secrets` events in namespace
 * {@link SECRET_AUDIT_REQUEST_NAMESPACE}.
 *
 * INVARIANT LOCKED (F-006-RQ-002): every event here has `objectRef.resource ===
 * 'secrets'`, `level === 'Request'`, and NO `responseObject` key.
 */
export const SECRETS_REQUEST_AUDIT_EVENTS: readonly AuditEvent[] =
  secretsRequestAuditEvents(SECRET_AUDIT_REQUEST_NAMESPACE);

/**
 * The six recorded RBAC events in namespace
 * {@link RBAC_AUDIT_RESPONSE_NAMESPACE} -- three `roles` and three
 * `rolebindings`.
 *
 * INVARIANT LOCKED (F-006-RQ-002): every event here is at `RequestResponse` and
 * carries BOTH a `requestObject` and a `responseObject`. This is the redaction
 * test's control group (AAP §0.5.2.5).
 */
export const RBAC_RESPONSE_AUDIT_EVENTS: readonly AuditEvent[] =
  rbacResponseAuditEvents(RBAC_AUDIT_RESPONSE_NAMESPACE);

/**
 * The `secrets` events the oracle logs WITHOUT asserting -- the Secret read.
 *
 * Kept as its own named constant rather than folded into the observed stream so
 * that a spec can state the property that matters directly: this event is in
 * {@link ALL_OBSERVED_AUDIT_EVENTS} and is NOT in
 * {@link SECRETS_REQUEST_AUDIT_EVENTS}. That difference is what makes the
 * observed stream a genuine superset instead of a synonym.
 */
export const SECRETS_REQUEST_UNASSERTED_AUDIT_EVENTS: readonly AuditEvent[] =
  secretsRequestUnassertedAuditEvents(SECRET_AUDIT_REQUEST_NAMESPACE);

/**
 * The complete observed audit stream -- ALL TEN events, in the order the measured
 * operations ran: the Secret create, the UNASSERTED Secret read, the Secret
 * update and delete, then the six RBAC events.
 *
 * WHY THIS EXISTS, AND WHY A CONSUMER MUST PREFER IT.
 * The Go guard does NOT scan the expected-events table. It scans
 * `missingReport.AllEvents` (`audit_test.go` L1028 and L1038-1040), which
 * `test/utils/audit.go` L122 appends to for EVERY decoded audit line -- a
 * SUPERSET of the expectations. The recorded reason is stated at
 * `audit_test.go` L1041-L1043: a future regression to `RequestResponse` is then
 * caught "even if the expected-events table were changed to match". The
 * presentation mirror inherits that property only if it inspects EVERY event it
 * received or rendered, not just the ones it expected, so this collection is the
 * correct input for ConfidentialityRedaction and for any panel-wide assertion.
 *
 * IT IS A SUPERSET IN FACT AND NOT ONLY IN INTENT. It contains
 * {@link SECRETS_REQUEST_UNASSERTED_AUDIT_EVENTS} -- the Secret GET that
 * `secretOperations` performs at `audit_test.go` L750-L751 and that its own
 * comment at L739-L741 records as "intentionally not asserted". While this
 * collection was merely the two expected sets concatenated, a guard scanning it
 * scanned exactly the events it already expected, which is the one thing the Go
 * comment says the guard must not do: an expected-events table edited to match a
 * regression would have taken the guard's only evidence with it. Now there is a
 * `secrets` event in the stream that no expectation holds, so the guard has
 * something to catch that the expectations cannot hide.
 *
 * INVARIANT LOCKED (F-006-RQ-002, the confidentiality guard mirrored from
 * `audit_test.go` L1043-1047): across this whole collection, NO event whose
 * `objectRef.resource` is `'secrets'` carries a `responseObject`, and AT LEAST
 * ONE non-`secrets` event does. Assert it with `expect.soft` inside the loop --
 * the Go original uses `t.Errorf`, so it reports every offender rather than
 * stopping at the first.
 *
 * NOT A FIXTURE, BY DESIGN: this file ships no `secrets` event carrying a
 * `responseObject`, because that is the violation state rather than recorded
 * data. A spec needing a negative example builds one locally from
 * {@link secretsRequestAuditEvents}, e.g.
 * `{ ...secretsRequestAuditEvents('ns')[0], responseObject: { kind: 'Secret' } }`.
 */
export const ALL_OBSERVED_AUDIT_EVENTS: readonly AuditEvent[] = [
  // Interleaved rather than concatenated, because the stream is chronological and
  // the read happened between the create and the update.
  ...SECRETS_REQUEST_AUDIT_EVENTS.slice(0, 1),
  ...SECRETS_REQUEST_UNASSERTED_AUDIT_EVENTS,
  ...SECRETS_REQUEST_AUDIT_EVENTS.slice(1),
  ...RBAC_RESPONSE_AUDIT_EVENTS,
];

// ---------------------------------------------------------------------------
// SECTION 6 -- The recorded case table.
//
// Recorded from `sensitiveTestCases`, `audit_test.go` L984-1002, plus the
// subtest-id form at L1005: fmt.Sprintf("%s.%s", version, tc.name). Exported so
// a React spec can name its cases exactly as the parity map names them, which is
// what keeps AAP §0.4.5's explicit Go-identifier-to-node-id mapping checkable by
// a human reading either side.
// ---------------------------------------------------------------------------

/** One recorded sensitive-resource case, with its expectations attached. */
export interface SensitiveResourceCase {
  /** The Go subtest's case name. */
  readonly name: SensitiveResourceCaseName;
  /** The namespace whose policy rule the case exercises. */
  readonly namespace: string;
  /** The level the policy evaluates for this case's resources. */
  readonly level: AuditLevel;
  /** The resources the policy rule names, in the recorded order. */
  readonly resources: readonly string[];
  /** The full Go subtest identifier, `${version}.${caseName}`. */
  readonly subtestId: string;
  /**
   * Whether events in this case carry a `responseObject`. `false` for `secrets`
   * is the confidentiality guard restated as data.
   */
  readonly carriesResponseObject: boolean;
  /** The recorded expected events for the case. */
  readonly events: readonly AuditEvent[];
  /** Where the expectations were recorded from. */
  readonly recordedFrom: string;
}

/**
 * The two recorded sensitive-resource cases, in the order `audit_test.go`
 * declares them.
 *
 * INVARIANT LOCKED (F-006-RQ-002): the pair is the whole V6 integration surface
 * -- one resource pinned DOWN to `Request` for confidentiality and one held UP at
 * `RequestResponse` for forensics. Both halves matter: keeping only the first
 * would let a blanket-redacting UI pass, and keeping only the second would drop
 * the guard entirely.
 *
 * Annotated `readonly SensitiveResourceCase[]` rather than frozen with
 * `as const`, deliberately. Under `as const` the element type degrades to a union
 * of one-element tuple types, and `cases[i].resources.includes('secrets')` --
 * the obvious way for a panel to look a case up -- then fails to compile with
 * "argument of type '\"secrets\"' is not assignable to parameter of type
 * 'never'". The annotation keeps the array immutable and keeps excess-property
 * checking, while leaving the table usable by the consumers it exists for.
 */
export const SENSITIVE_RESOURCE_CASES: readonly SensitiveResourceCase[] = [
  {
    name: 'secrets-request',
    namespace: SECRET_AUDIT_REQUEST_NAMESPACE,
    level: 'Request',
    resources: ['secrets'],
    subtestId: 'audit.k8s.io/v1.secrets-request',
    carriesResponseObject: false,
    events: SECRETS_REQUEST_AUDIT_EVENTS,
    recordedFrom:
      'test/integration/controlplane/audit/audit_test.go L812-852 (secretAuditRequestEvents)',
  },
  {
    name: 'rbac-response',
    namespace: RBAC_AUDIT_RESPONSE_NAMESPACE,
    level: 'RequestResponse',
    resources: ['roles', 'rolebindings'],
    subtestId: 'audit.k8s.io/v1.rbac-response',
    carriesResponseObject: true,
    events: RBAC_RESPONSE_AUDIT_EVENTS,
    recordedFrom:
      'test/integration/controlplane/audit/audit_test.go L859-935 (rbacAuditResponseEvents)',
  },
];


// ---------------------------------------------------------------------------
// SECTION 7 -- The recorded per-resource level table and the level aliases.
//
// Recorded from `auditPolicyPattern`, `audit_test.go` L59-120: TEN rules, listed
// here in file order. This is the data an audit-fidelity panel renders when it
// shows "which resource is audited at which level", and it is recorded rather
// than derived so the panel cannot quietly disagree with the policy the oracle
// feeds the API server.
// ---------------------------------------------------------------------------

/** One rule of the recorded audit policy. */
export interface AuditPolicyRuleRecord {
  /** The level the rule assigns. */
  readonly level: AuditLevel;
  /** The namespaces the rule is scoped to, in the recorded order. */
  readonly namespaces: readonly string[];
  /** The API group; the empty string is the core group, as the policy comments it. */
  readonly apiGroup: string;
  /** The resources the rule names, in the recorded order. */
  readonly resources: readonly string[];
}

/**
 * The ten recorded audit-policy rules, in the order `auditPolicyPattern`
 * declares them.
 *
 * INVARIANT LOCKED (F-006-RQ-001 and F-006-RQ-002, AAP §0.10.2): the sensitive
 * resources sit at EXACTLY the levels recorded here. Two entries are
 * load-bearing and must never be edited to a higher level:
 *   * `secrets` in `secret-audit-request` at `Request` -- raising it to
 *     `RequestResponse` would start writing Secret response bodies to the audit
 *     log, which is the exact weakness V6 closed;
 *   * `serviceaccounts/token` in `create-audit-request` at `Request` -- same
 *     reasoning, applied to issued tokens.
 * The `create-audit-response` and `webhook-audit-*` rules deliberately cover the
 * same resources at OTHER levels in OTHER namespaces; that is the policy proving
 * its level selection is namespace-scoped, not a contradiction.
 *
 * Annotated `readonly AuditPolicyRuleRecord[]` rather than frozen with `as
 * const`, for the reason spelled out on {@link SENSITIVE_RESOURCE_CASES}: a
 * per-resource level table exists to be filtered by resource name, and `as const`
 * would make `rule.resources.includes('secrets')` a compile error. The array
 * stays immutable and excess-property-checked; only the needless literal
 * narrowing is given up.
 */
export const AUDIT_POLICY_RULES: readonly AuditPolicyRuleRecord[] = [
  {
    level: 'RequestResponse',
    namespaces: ['no-webhook-namespace'],
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'Metadata',
    namespaces: ['webhook-audit-metadata'],
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'Request',
    namespaces: ['webhook-audit-request'],
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'RequestResponse',
    namespaces: ['webhook-audit-response'],
    apiGroup: '',
    resources: ['configmaps'],
  },
  {
    level: 'Request',
    namespaces: ['create-audit-request'],
    apiGroup: '',
    resources: ['serviceaccounts/token'],
  },
  {
    level: 'RequestResponse',
    namespaces: ['create-audit-response'],
    apiGroup: '',
    resources: ['serviceaccounts/token'],
  },
  {
    level: 'Request',
    namespaces: ['update-audit-request'],
    apiGroup: 'apps',
    resources: ['deployments/scale'],
  },
  {
    level: 'RequestResponse',
    namespaces: ['update-audit-response'],
    apiGroup: 'apps',
    resources: ['deployments/scale'],
  },
  {
    level: 'Request',
    namespaces: [SECRET_AUDIT_REQUEST_NAMESPACE],
    apiGroup: '',
    resources: ['secrets'],
  },
  {
    level: 'RequestResponse',
    namespaces: [RBAC_AUDIT_RESPONSE_NAMESPACE],
    apiGroup: 'rbac.authorization.k8s.io',
    resources: ['roles', 'rolebindings'],
  },
];

/** A shell-side level alias paired with the wire level it denotes. */
export interface AuditLevelAlias {
  /** The alias as the shell-boundary unit test spells it. */
  readonly alias: 'none' | 'metadata' | 'request' | 'response';
  /** The `audit.k8s.io/v1` level the alias denotes. */
  readonly level: AuditLevel;
}

/**
 * The four level aliases, recorded from `cluster/gce/gci/audit_policy_test.go`
 * L119-124, listed in STRICTLY ASCENDING order of verbosity:
 * `None < Metadata < Request < RequestResponse`.
 *
 * INVARIANT LOCKED (F-006-RQ-001, AAP §0.10.2): that ordering is a STRICT TOTAL
 * ORDER, and INDEX ORDER HERE IS THE INVARIANT. It is recorded as an ordered
 * structure precisely so a future edit cannot silently downgrade a level: a
 * comparison written as "index of actual >= index of required" keeps working
 * only while this array stays sorted, so reordering it breaks loudly instead of
 * quietly weakening every level assertion in the tier.
 *
 * The aliases matter because the Go shell-boundary test and the wire use
 * different spellings for the same four values -- `response` is
 * `RequestResponse` -- and a table that mixed the two would compare a shell alias
 * against a wire level and always find them unequal.
 *
 * Index order deliberately matches `AUDIT_LEVEL_ORDER` in
 * web/src/hooks/useAuditEvents.ts, which remains the single definition site of
 * the ordering itself; this table adds only the alias mapping and is not a second
 * copy of it.
 */
export const AUDIT_LEVEL_ALIASES = [
  { alias: 'none', level: 'None' },
  { alias: 'metadata', level: 'Metadata' },
  { alias: 'request', level: 'Request' },
  { alias: 'response', level: 'RequestResponse' },
] as const satisfies readonly AuditLevelAlias[];
