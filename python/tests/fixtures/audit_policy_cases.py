# Copyright The Kubernetes Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The V6 audit-level case matrix: 620 expectations, transcribed from Go.

This module is the single definition of the vocabulary the V6 sensitive-resource
audit tests assert against - the 14 request principals, the 23 resource
selectors, the 10 non-resource paths, the four audit levels and their strict
total order - together with the 29 assertion invocations that combine them into
exactly 620 expected outcomes.

It is DATA. It contains no `test_*` function, no `pytest` fixture, no subprocess
invocation, no policy evaluation and no I/O, and it imports nothing outside the
standard library. Deciding whether a generated policy honours these expectations
is the job of the two modules that consume them:

* `tests/unit/shell/test_audit_policy.py` (L1, shell boundary) invokes the real
  `create-master-audit-policy` from `cluster/gce/gci/configure-helper.sh` through
  a subprocess and evaluates the generated policy against every case here.
* `tests/integration/test_audit_sensitive_resources.py` (L2, integration)
  asserts the same levels against audit events emitted by a real API server.

Because both tiers read this module, the principal and selector vocabulary and
the none/metadata/request/response level aliases have exactly one definition and
cannot drift apart while both suites stay green.

Provenance: ported from `cluster/gce/gci/audit_policy_test.go`
(`TestCreateMasterAuditPolicy`, L49-184, plus its `testResources` L191-228,
`testNonResources` L230-244, `expectLevel` L246-263 and `resource` L276-288
helpers). Group and username constants were verified against
`staging/src/k8s.io/apiserver/pkg/authentication/user/user.go` L71-83 and
`staging/src/k8s.io/apiserver/pkg/authentication/serviceaccount/util.go`.

AAP §0.5.1 (this file's transformation-map row) / §0.4.2.1 (the L1 shell-boundary
blueprint that owns the 620-case matrix) / §0.5.5 (shared test data: this module
is consumed by both the L1 and the L2 audit module) / §0.10.2 (the boundary
conditions encoded below, which must port unchanged) / tech-spec §6.4.6
(sensitive-resource audit fidelity, control V6).

Typical use, with the two pytest constructs the shape below deliberately serves
equally - independent cases, one node id each::

    from tests.fixtures import audit_policy_cases as apc

    @pytest.mark.parametrize(
        "case", apc.expand(), ids=[c.id for c in apc.expand()]
    )
    def test_audit_level(case, evaluated_policy):
        assert evaluated_policy.level_for(case) == case.level.wire

and accumulate-and-continue, every failure reported in one run::

    def test_audit_levels(subtests, evaluated_policy):
        for case in apc.expand():
            with subtests.test(case=case.id):
                assert evaluated_policy.level_for(case) == case.level.wire
"""

# AAP §0.5.1 / §0.4.2.1 / §0.10.2 / tech-spec §6.4.6
#
# INVARIANT LOCKED BY THIS FILE: the V6 audit level assigned to every
# (principal, verb, resource-or-path) request the Go suite exercises - 620 of
# them, in the Go suite's own order and under the Go suite's own subtest names -
# and, above all, the sensitive-resource boundary that control V6 exists to
# hold: `secrets` and `serviceaccounts/token` at EXACTLY `Request`, `configmaps`
# and `tokenreviews` at EXACTLY `Metadata`, RBAC objects at `RequestResponse` for
# mutating verbs, and the strict total order None < Metadata < Request <
# RequestResponse that makes a silent downgrade of any of them impossible.
#
# Raising `secrets` or `serviceaccounts/token` to `RequestResponse` here would
# not fail a test - it would make the suite demand that the API server log
# secret bodies and issued bearer tokens. Lowering either to `Metadata` would
# make it accept the loss of forensic detail the V6 remediation restored. Both
# directions are silent, which is why the values live in one reviewed place.
#
# WHY THE STRUCTURE IS AN INVOCATION TABLE AND NOT A GRID. The matrix is
# characterised in AAP §0.5.1 as "14-principal by 24-selector", which is a
# description of its ingredients rather than of its shape: a 14x24 grid would
# produce 336 cases with different names. The measured shape, re-derived from
# the Go source and confirmed against a live run, is 29 separate assertion
# invocations, each pairing ONE expected level with its own small set of
# principals, verbs and targets, and each expanding user -> verb -> target:
#
#   27 at.testResources(...)    expand to 340 resource cases
#    2 at.testNonResources(...) expand to 280 non-resource cases
#                               ------------------------------
#                                          620 cases
#
# and 620 + 20 sibling subtests + 8 top-level tests is the 648 the package
# reports (AAP §0.3.1.5).
#
# MEASURED, NOT ASSUMED (AAP §0.11.1, "Evidence over assumption"). Every count
# in this file was taken from the Go suite, not from prose:
#
#   $ grep -c 'at\.test' cluster/gce/gci/audit_policy_test.go          -> 29
#   $ grep -c 'at\.testResources' cluster/gce/gci/audit_policy_test.go -> 27
#   $ sed -n '94,116p' ...audit_policy_test.go | grep -c '= resource(' -> 23
#   $ go test -count=1 -v -run TestCreateMasterAuditPolicy ./cluster/gce/gci/
#       -> ok, 620 '=== RUN' subtests, 0 failures
#       -> 35 names carry a '#NN' suffix, 585 distinct base names, 0 collisions
#
# The plan's prose describes 30 invocations (28 of them `testResources`); the
# repository measures 29 (27 of them `testResources`), and the plan's own
# per-invocation table has exactly 29 rows summing to 620. The measured 29 is
# what this file transcribes, because the code is authoritative where code and
# prose disagree (AAP §0.10.1).
#
# THE COUNT CONSTANTS AT THE END OF THIS FILE ARE LITERALS ON PURPOSE. They are
# what the Go suite measured, so a consumer asserting `len(expand()) ==
# TOTAL_CASE_COUNT` is comparing this port against the oracle. Deriving them
# from `expand()` would make that assertion compare the port against itself and
# quietly accept any transcription error.

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from functools import cache
from types import MappingProxyType
from typing import Final

__all__ = [
    "ALL_NON_RESOURCE_PATHS",
    "ALL_PRINCIPALS",
    "ALL_SELECTORS",
    "ANONYMOUS",
    "APISERVER",
    "API_VERSION",
    "AUDIT_STAGE_REQUEST_RECEIVED",
    "AUTOSCALER",
    "CLUSTER_ROLES",
    "CONFIGMAPS",
    "CONTROLLER",
    "DEFAULT_SA",
    "DEPLOYMENTS",
    "DUPLICATE_SUFFIXED_ID_COUNT",
    "ENDPOINTS",
    "ENDPOINT_CONTROLLER",
    "EVENTS",
    "EXPECTED_OMIT_STAGES",
    "FOOBARBAZ",
    "FOOBARS",
    "GROUP_ALL_AUTHENTICATED",
    "GROUP_ALL_SERVICE_ACCOUNTS",
    "GROUP_ALL_UNAUTHENTICATED",
    "GROUP_MASTERS",
    "GROUP_NODES",
    "HEALTH_AND_VERSION_PATHS",
    "INGRESS",
    "INVOCATIONS",
    "INVOCATION_COUNT",
    "KUBELET",
    "KUBEPROXY",
    "LEVEL_ORDER",
    "LEVEL_RANK",
    "LEVEL_WIRE_STRINGS",
    "NAMESPACES",
    "NAMESPACE_CONTROLLER",
    "NAMESPACE_FINAL",
    "NAMESPACE_STATUS",
    "NODE",
    "NODES",
    "NODE_METRICS",
    "NODE_STATUS",
    "NON_RESOURCE_CASE_COUNT",
    "NON_RESOURCE_INVOCATION_COUNT",
    "NON_RESOURCE_PATH_COUNT",
    "NON_RESOURCE_VERBS",
    "NO_OMIT_STAGES",
    "NPD",
    "NPD_SA",
    "OBSERVABILITY_AND_DISCOVERY_PATHS",
    "PODS",
    "POD_METRICS",
    "POD_STATUS",
    "PRINCIPALS_BY_GO_LOCAL",
    "PRINCIPAL_COUNT",
    "RESOURCE_CASE_COUNT",
    "RESOURCE_INVOCATION_COUNT",
    "SA_TOKENS",
    "SCHEDULER",
    "SECRETS",
    "SELECTORS_BY_GO_LOCAL",
    "SELECTOR_COUNT",
    "SENSITIVE_RESOURCE_EXPECTATIONS",
    "SENSITIVE_RESOURCE_LEVELS",
    "SERVICES",
    "SERVICE_ACCOUNT_GROUP_PREFIX",
    "SERVICE_ACCOUNT_USERNAME_PREFIX",
    "SERVICE_STATUS",
    "SYS_CONFIGMAPS",
    "SYS_ENDPOINTS",
    "TOKEN_REVIEWS",
    "TOTAL_CASE_COUNT",
    "UNIQUE_BASE_NAME_COUNT",
    "AuditLevel",
    "AuditPolicyCase",
    "Invocation",
    "InvocationKind",
    "Principal",
    "ResourceSelector",
    "SensitiveResourceExpectation",
    "case_ids",
    "cases_by_invocation",
    "expand",
    "non_resource_cases",
    "resource",
    "resource_cases",
    "service_account_principal",
]


# ---------------------------------------------------------------------------
# Audit levels and their strict total order
#
# Ported from the `none` / `metadata` / `request` / `response` aliases at
# cluster/gce/gci/audit_policy_test.go L120-125, which name
# audit.LevelNone / LevelMetadata / LevelRequest / LevelRequestResponse.
# ---------------------------------------------------------------------------


class AuditLevel(Enum):
    """An audit level, valued by the exact string the audit policy carries.

    The member VALUES are the wire strings, verbatim, because that is what a
    consumer compares against: the `level:` field of a rule in the policy YAML
    generated by `create-master-audit-policy`, and the `level` field of an
    `audit.k8s.io/v1` Event observed by the integration tier. `RequestResponse`
    is deliberately NOT spelled `Response` even though the Go test's local alias
    is `response` - the alias is a Go identifier, the wire string is a contract.

    The members are ordered from least to most disclosure, and comparison
    operators are defined on that order, so the total order the V6 control
    depends on is directly assertable::

        assert AuditLevel.NONE < AuditLevel.METADATA < AuditLevel.REQUEST
        assert AuditLevel.REQUEST < AuditLevel.RESPONSE

    Comparison is defined only against another `AuditLevel`; comparing to a
    string returns `NotImplemented` and raises `TypeError`, so a consumer cannot
    accidentally order the wire strings lexicographically - which would put
    "Metadata" < "None" < "Request" < "RequestResponse" and silently invert the
    part of the order that matters most.
    """

    NONE = "None"
    METADATA = "Metadata"
    REQUEST = "Request"
    RESPONSE = "RequestResponse"

    @property
    def wire(self) -> str:
        """The exact string this level appears as in a policy or an audit event."""
        return self.value

    @property
    def rank(self) -> int:
        """Position in the disclosure order: 0 for `None` .. 3 for `RequestResponse`.

        Read from `LEVEL_RANK`, so the order has exactly one definition and a
        consumer can assert against either spelling of it.
        """
        return LEVEL_RANK[self]

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, AuditLevel):
            return NotImplemented
        return self.rank < other.rank

    def __le__(self, other: object) -> bool:
        if not isinstance(other, AuditLevel):
            return NotImplemented
        return self.rank <= other.rank

    def __gt__(self, other: object) -> bool:
        if not isinstance(other, AuditLevel):
            return NotImplemented
        return self.rank > other.rank

    def __ge__(self, other: object) -> bool:
        if not isinstance(other, AuditLevel):
            return NotImplemented
        return self.rank >= other.rank

    def __str__(self) -> str:
        """The wire string, so a level interpolates readably into a message."""
        return self.value


# The strict total order, as data. AAP §0.4.2.1 requires this ordering to be
# asserted "as a strict total order so no future edit can silently downgrade a
# level", and `hypothesis` is pinned in python/requirements-test.txt for exactly
# that property test - which lives in the consuming module, not here.
#
# Least to most disclosure: None logs nothing, Metadata logs who did what to
# what, Request adds the submitted object, RequestResponse adds the returned
# object. The gap between the last two is the whole of the V6 trade-off.
LEVEL_ORDER: Final[tuple[AuditLevel, ...]] = (
    AuditLevel.NONE,
    AuditLevel.METADATA,
    AuditLevel.REQUEST,
    AuditLevel.RESPONSE,
)

# Integer rank per level, derived from LEVEL_ORDER so the two cannot disagree.
# MappingProxyType, not dict: a consumer holding this cannot mutate the order
# out from under a test running beside it under `pytest-xdist -n auto`.
LEVEL_RANK: Final[Mapping[AuditLevel, int]] = MappingProxyType(
    {level: rank for rank, level in enumerate(LEVEL_ORDER)}
)

# The four wire strings in disclosure order. Asserting against this catches a
# renamed member; asserting against LEVEL_ORDER catches a reordered one.
LEVEL_WIRE_STRINGS: Final[tuple[str, ...]] = tuple(level.value for level in LEVEL_ORDER)


# ---------------------------------------------------------------------------
# The second per-case expectation: omitted stages
# ---------------------------------------------------------------------------

# `expectLevel` (audit_policy_test.go L246-263) asserts TWO things per case, and
# a port that keeps only the first halves the assertion density AAP §0.7.2
# requires be preserved:
#
#     assert.Equal(t, expected, auditConfig.Level)
#     if auditConfig.Level != audit.LevelNone {
#         assert.ElementsMatch(t, auditConfig.OmitStages,
#             []audit.Stage{audit.StageRequestReceived})
#     }
#
# Every rule the generator emits at a level other than None carries
# `omitStages: ["RequestReceived"]`, which suppresses the event recorded when the
# request arrives and keeps one event per request instead of two. A rule that
# lost it would double the audit volume without adding information; a rule that
# gained an extra omitted stage would drop a real event.
#
# The literal is named here so the consumer never hardcodes it, and
# `AuditPolicyCase.expected_omit_stages` applies the `Level != None` condition so
# the consumer does not re-derive that either.
AUDIT_STAGE_REQUEST_RECEIVED: Final[str] = "RequestReceived"

# What OmitStages must equal for a case whose level is not None. Compare as a
# SET or a sorted sequence: the Go assertion is ElementsMatch, which ignores
# order.
EXPECTED_OMIT_STAGES: Final[tuple[str, ...]] = (AUDIT_STAGE_REQUEST_RECEIVED,)

# What OmitStages is not asserted against at all when the level is None: the Go
# test skips the check entirely, because a rule that logs nothing has no stages
# to omit. Exposed as its own constant so `expected_omit_stages` returning an
# empty tuple reads as "nothing is asserted" rather than as "assert empty".
NO_OMIT_STAGES: Final[tuple[str, ...]] = ()


# ---------------------------------------------------------------------------
# The V6 sensitive-resource boundary
#
# AAP §0.10.2 tabulates these as boundary conditions that "must port unchanged";
# AAP §0.11.1 forbids weakening any of them to make a test pass. They are
# exposed as data so the L1 shell tier and the L2 integration tier assert the
# same numbers from the same source.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SensitiveResourceExpectation:
    """The audit level a sensitive resource must be recorded at, and why.

    Frozen, so a consumer cannot adjust an expectation in place and leave the
    suite green for the wrong reason.

    Attributes:
        resource: The resource as the policy names it, `resource` or
            `resource/subresource` - `secrets`, `serviceaccounts/token`,
            `configmaps`, `tokenreviews`, `clusterroles`.
        group: The API group, empty for the core group. Part of the identity of a
            resource: `tokenreviews` in `authentication.k8s.io` and
            `clusterroles` in `rbac.authorization.k8s.io` are not core objects.
        verbs: The verbs this expectation covers. EMPTY MEANS "every verb not
            already claimed by an earlier entry", mirroring the first-match-wins
            evaluation of the policy's own ordered rule list.
        level: The level required for those verbs.
        rationale: Why this level and not a neighbouring one, in the terms the
            shipped generator itself uses.
    """

    resource: str
    group: str
    verbs: tuple[str, ...]
    level: AuditLevel
    rationale: str


# The boundary, in the generated policy's own rule order, so that reading these
# entries top to bottom reproduces how a request is actually classified.
#
# The rationale text is not invented here: `create-master-audit-policy` in
# cluster/gce/gci/configure-helper.sh carries the same reasoning as comments
# above the rules themselves, and AAP §0.11.1 ("Cite only what the repository
# states") is why it is reproduced rather than paraphrased or embellished. No
# external control identifier is asserted anywhere in this module, because the
# repository enumerates none.
SENSITIVE_RESOURCE_EXPECTATIONS: Final[tuple[SensitiveResourceExpectation, ...]] = (
    SensitiveResourceExpectation(
        resource="secrets",
        group="",
        verbs=(),
        level=AuditLevel.REQUEST,
        rationale=(
            "Raised from Metadata to Request to restore forensic detail on who read or "
            "mutated a Secret. Request records the request object but never the response "
            "object, so read paths (get/list/watch) carry the payload only in the omitted "
            "response and never log secret data; create/update request bodies do carry "
            ".data/.stringData, and logging that request object is the explicitly accepted "
            "trade-off of Request over RequestResponse, which would log the response body "
            "as well and double the exposure."
        ),
    ),
    SensitiveResourceExpectation(
        resource="serviceaccounts/token",
        group="",
        verbs=(),
        level=AuditLevel.REQUEST,
        rationale=(
            "Raised from Metadata to Request alongside secrets, and fully credential-safe "
            "at this level: the issued bearer token is returned only in the response, which "
            "Request omits, so no token is ever written to the audit log."
        ),
    ),
    SensitiveResourceExpectation(
        resource="configmaps",
        group="",
        verbs=(),
        level=AuditLevel.METADATA,
        rationale=(
            "ConfigMaps can carry sensitive or binary data but are NOT part of the V6 "
            "Secrets/ServiceAccount-token raise, so they stay pinned to Metadata - the "
            "highest level that records the operation without logging any payload."
        ),
    ),
    SensitiveResourceExpectation(
        resource="tokenreviews",
        group="authentication.k8s.io",
        verbs=(),
        level=AuditLevel.METADATA,
        rationale=(
            "TokenReviews carry a credential in the request body, so they stay pinned to "
            "Metadata for the same reason as configmaps: the operation is recorded, the "
            "payload is not."
        ),
    ),
    SensitiveResourceExpectation(
        resource="clusterroles",
        group="rbac.authorization.k8s.io",
        verbs=("get", "list", "watch"),
        level=AuditLevel.REQUEST,
        rationale=(
            "A known-API read. The policy lowers reads of every known API from "
            "RequestResponse to Request one rule earlier than its known-API default, "
            "because get and list responses can be large. This entry precedes the default "
            "below for exactly the same reason it precedes it in the policy."
        ),
    ),
    SensitiveResourceExpectation(
        resource="clusterroles",
        group="rbac.authorization.k8s.io",
        verbs=(),
        level=AuditLevel.RESPONSE,
        rationale=(
            "The known-API default, and the level RBAC objects must be recorded at for "
            "every mutating verb: a change to a ClusterRole is a change to the "
            "authorization surface itself, so both the submitted and the resulting object "
            "are logged."
        ),
    ),
)

# The headline boundary as a flat mapping, for a consumer that asserts one level
# per resource - the L2 integration module reads it to check the level of an
# observed audit event.
#
# READ THE CLUSTERROLES ENTRY CAREFULLY. `RequestResponse` is the level for
# MUTATING verbs; reads of the same resource are deliberately `Request`, as the
# two clusterroles entries above record. That is not a contradiction and must not
# be "fixed" in either direction: the AAP §0.10.2 boundary is that RBAC objects
# reach RequestResponse when they are changed.
#
# PER-CASE EXPECTATIONS DO NOT COME FROM HERE. Every one of the 620 cases takes
# its level from the invocation that declares it, so this mapping can never
# override a transcribed expectation - a global default that outranked the
# invocation table would be exactly the silent downgrade this file exists to
# prevent.
#
# WHICH IS NOT A TECHNICALITY, MEASURED OVER THE EXPANSION:
#
#   secrets                35 -> 17 cases, all Request
#   serviceaccounts/token         2 cases, all Request
#   tokenreviews                 12 cases, all Metadata
#   clusterroles                 28 cases: 12 Request (reads, Go L180)
#                                          16 RequestResponse (writes, Go L181)
#   configmaps                   35 cases: 32 Metadata
#                                           3 None   (Go L135, L158)
#
# Those three `None` configmaps cases are deliberate and are not a hole in the
# control: they are `configmaps` in KUBE-SYSTEM read by `system:unsecured` and by
# `cluster-autoscaler`, whose polling is high-volume enough that the generator
# drops it, and the Go suite asserts the drop explicitly so that it can never
# widen unnoticed. The same principals reading `configmaps` in `default` are
# recorded at Metadata (Go L136, L159), which is the assertion that the exemption
# stays scoped to kube-system.
#
# So the invariant a consumer should assert over the expansion is that configmaps
# and tokenreviews NEVER EXCEED Metadata - `case.level <= AuditLevel.METADATA`,
# which holds for all 47 of them - and NOT that every such case equals Metadata,
# which is false for exactly those three and would report a false failure. The
# exact per-case equality assertion is the one against `case.level`, which comes
# from the invocation and is checked for all 620 cases anyway.
SENSITIVE_RESOURCE_LEVELS: Final[Mapping[str, AuditLevel]] = MappingProxyType(
    {
        "secrets": AuditLevel.REQUEST,
        "serviceaccounts/token": AuditLevel.REQUEST,
        "configmaps": AuditLevel.METADATA,
        "tokenreviews": AuditLevel.METADATA,
        "clusterroles": AuditLevel.RESPONSE,
    }
)


# ---------------------------------------------------------------------------
# Well-known group and username constants
#
# Transcribed from staging/src/k8s.io/apiserver/pkg/authentication/user/user.go
# L71-83 and .../authentication/serviceaccount/util.go. Restated here rather than
# imported because this tier depends on the Kubernetes Python client, which does
# not publish these Go constants - and because the strings ARE the contract the
# generated policy matches on: `users:` and `userGroups:` in a policy rule are
# compared to exactly these values.
# ---------------------------------------------------------------------------

GROUP_ALL_AUTHENTICATED: Final[str] = "system:authenticated"
GROUP_ALL_UNAUTHENTICATED: Final[str] = "system:unauthenticated"
GROUP_MASTERS: Final[str] = "system:masters"
GROUP_NODES: Final[str] = "system:nodes"
GROUP_ALL_SERVICE_ACCOUNTS: Final[str] = "system:serviceaccounts"

# `MakeUsername(ns, name)` is ServiceAccountUsernamePrefix + ns + ":" + name and
# `MakeNamespaceGroupName(ns)` is ServiceAccountGroupPrefix + ns. Both prefixes
# already end in a colon, which is why `service_account_principal` concatenates
# only one separator.
SERVICE_ACCOUNT_USERNAME_PREFIX: Final[str] = "system:serviceaccount:"
SERVICE_ACCOUNT_GROUP_PREFIX: Final[str] = "system:serviceaccounts:"


# ---------------------------------------------------------------------------
# The 14 request principals
#
# Ported from cluster/gce/gci/audit_policy_test.go L74-89. Each constant is the
# mechanical UPPER_SNAKE transliteration of its Go local, and the Go local is
# named in a trailing comment, so the invocation table further down transcribes
# one-to-one against the Go source. PRINCIPALS_BY_GO_LOCAL indexes them by the
# verbatim Go identifier for the same reason.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Principal:
    """A requesting identity: the `user.Info` the audit policy is evaluated for.

    Frozen and hashable, so a principal can key a mapping and cannot be edited by
    one test in a way another test would inherit - the structural isolation
    AAP §0.7.2 requires for a suite that must pass under `pytest-randomly` and
    `pytest-xdist -n auto`.

    Groups are load-bearing, not decoration. Several rules the generator emits
    select on `userGroups:` rather than on `users:` - the node status rule matches
    `system:nodes`, so `kubelet` and `system:node:node-123` are audited alike
    because of their group and not their name. A principal transcribed without its
    groups would be classified by a different rule and would silently assert the
    wrong level.

    Attributes:
        name: The username, exactly as the policy's `users:` field would spell it.
        groups: The groups, in the Go source's order. Order carries no meaning for
            rule matching but is preserved so the transcription stays diffable
            against the Go source.
    """

    name: str
    groups: tuple[str, ...]

    def __str__(self) -> str:
        """The username, which is what a subtest name and a failure message need."""
        return self.name


def service_account_principal(namespace: str, name: str) -> Principal:
    """Build the principal for a ServiceAccount, the way the API server does.

    The port of `serviceaccount.UserInfo(namespace, name, "")` from
    staging/src/k8s.io/apiserver/pkg/authentication/serviceaccount/util.go, whose
    two components are:

    * `MakeUsername(namespace, name)` -> `system:serviceaccount:<ns>:<name>`
    * `MakeGroupNames(namespace)` -> `[system:serviceaccounts,
      system:serviceaccounts:<ns>]`, in that order

    The Go call passes an empty UID, which the audit policy never matches on, so
    this port takes no UID parameter rather than accepting one and discarding it.

    Deriving the four ServiceAccount principals through one helper rather than
    hand-writing four literals is deliberate: the namespace appears in both the
    username and the second group, and a hand-written copy is exactly where those
    two would drift apart - producing a principal that authenticates as one
    namespace and is authorized as another.

    Args:
        namespace: The ServiceAccount's namespace. Must be non-empty.
        name: The ServiceAccount's name. Must be non-empty.

    Returns:
        The `Principal` for that ServiceAccount.

    Raises:
        ValueError: If either argument is empty. `MakeUsername` would happily
            produce `system:serviceaccount::default`, which matches no rule and
            would make a test pass for the wrong reason.
    """
    if not namespace:
        raise ValueError("a ServiceAccount principal needs a namespace, got an empty string")
    if not name:
        raise ValueError("a ServiceAccount principal needs a name, got an empty string")
    return Principal(
        name=f"{SERVICE_ACCOUNT_USERNAME_PREFIX}{namespace}:{name}",
        groups=(GROUP_ALL_SERVICE_ACCOUNTS, f"{SERVICE_ACCOUNT_GROUP_PREFIX}{namespace}"),
    )


# Go local: anonymous - newUserInfo(user.Anonymous, user.AllUnauthenticated).
# The only unauthenticated principal in the matrix, and the reason the policy's
# levels have to hold for requests that carry no credential at all.
ANONYMOUS: Final[Principal] = Principal(
    name="system:anonymous",
    groups=(GROUP_ALL_UNAUTHENTICATED,),
)

# Go local: kubeproxy - newUserInfo(user.KubeProxy, user.AllAuthenticated).
KUBEPROXY: Final[Principal] = Principal(
    name="system:kube-proxy",
    groups=(GROUP_ALL_AUTHENTICATED,),
)

# Go local: ingress - newUserInfo("system:unsecured", user.AllAuthenticated,
# user.SystemPrivilegedGroup). Named `ingress` in the Go source but called
# `system:unsecured`; the name is transcribed, not corrected.
INGRESS: Final[Principal] = Principal(
    name="system:unsecured",
    groups=(GROUP_ALL_AUTHENTICATED, GROUP_MASTERS),
)

# Go local: kubelet - newUserInfo("kubelet", user.AllAuthenticated,
# user.NodesGroup). A bare `kubelet` username, which the policy's node rules
# match by name; NODE below is matched by group instead.
KUBELET: Final[Principal] = Principal(
    name="kubelet",
    groups=(GROUP_ALL_AUTHENTICATED, GROUP_NODES),
)

# Go local: node - newUserInfo("system:node:node-123", user.AllAuthenticated,
# user.NodesGroup). The `system:node:<name>` form a real kubelet authenticates
# as, which no rule names explicitly - it is classified through system:nodes.
NODE: Final[Principal] = Principal(
    name="system:node:node-123",
    groups=(GROUP_ALL_AUTHENTICATED, GROUP_NODES),
)

# Go local: controller - newUserInfo(user.KubeControllerManager,
# user.AllAuthenticated).
CONTROLLER: Final[Principal] = Principal(
    name="system:kube-controller-manager",
    groups=(GROUP_ALL_AUTHENTICATED,),
)

# Go local: scheduler - newUserInfo(user.KubeScheduler, user.AllAuthenticated).
SCHEDULER: Final[Principal] = Principal(
    name="system:kube-scheduler",
    groups=(GROUP_ALL_AUTHENTICATED,),
)

# Go local: apiserver - newUserInfo(user.APIServerUser,
# user.SystemPrivilegedGroup). Note it is in system:masters and NOT in
# system:authenticated, exactly as the Go source declares it.
APISERVER: Final[Principal] = Principal(
    name="system:apiserver",
    groups=(GROUP_MASTERS,),
)

# Go local: autoscaler - newUserInfo("cluster-autoscaler",
# user.AllAuthenticated). The one principal whose name carries no `system:`
# prefix.
AUTOSCALER: Final[Principal] = Principal(
    name="cluster-autoscaler",
    groups=(GROUP_ALL_AUTHENTICATED,),
)

# Go local: npd - newUserInfo("system:node-problem-detector",
# user.AllAuthenticated). The node-problem-detector as a named user; NPD_SA below
# is the same component running as a ServiceAccount, and the matrix exercises
# both because the policy names both.
NPD: Final[Principal] = Principal(
    name="system:node-problem-detector",
    groups=(GROUP_ALL_AUTHENTICATED,),
)

# Go local: npdSA - serviceaccount.UserInfo("kube-system",
# "node-problem-detector", "").
NPD_SA: Final[Principal] = service_account_principal("kube-system", "node-problem-detector")

# Go local: namespaceController - serviceaccount.UserInfo("kube-system",
# "namespace-controller", ""). The only principal the deletecollection rule
# names.
NAMESPACE_CONTROLLER: Final[Principal] = service_account_principal(
    "kube-system", "namespace-controller"
)

# Go local: endpointController - serviceaccount.UserInfo("kube-system",
# "endpoint-controller", "").
ENDPOINT_CONTROLLER: Final[Principal] = service_account_principal(
    "kube-system", "endpoint-controller"
)

# Go local: defaultSA - serviceaccount.UserInfo("default", "default", ""). The
# least-privileged authenticated identity in the matrix, and the one whose
# secrets and serviceaccounts/token levels matter most.
DEFAULT_SA: Final[Principal] = service_account_principal("default", "default")


# The Go `allUsers` slice (audit_policy_test.go L89), in ITS ORDER.
#
# THE ORDER IS LOAD-BEARING. `testNonResources` iterates users as its outer loop,
# so this sequence fixes the order of all 280 non-resource cases and therefore
# the order in which their ids appear. Reordering these 14 entries would leave
# every case and every level correct while shuffling 280 ids away from the
# baseline manifest, which the parity contract compares element for element.
ALL_PRINCIPALS: Final[tuple[Principal, ...]] = (
    ANONYMOUS,
    KUBEPROXY,
    INGRESS,
    KUBELET,
    NODE,
    CONTROLLER,
    SCHEDULER,
    APISERVER,
    AUTOSCALER,
    NPD,
    NPD_SA,
    NAMESPACE_CONTROLLER,
    ENDPOINT_CONTROLLER,
    DEFAULT_SA,
)

# The same 14 principals keyed by the VERBATIM Go local identifier, including its
# original camelCase. This is the one-to-one bridge back to the source: a
# reviewer diffing this module against audit_policy_test.go L74-89 can look up
# `npdSA` rather than having to know it transliterates to NPD_SA. Insertion order
# is the `allUsers` order, so iterating this mapping is equivalent to iterating
# ALL_PRINCIPALS.
PRINCIPALS_BY_GO_LOCAL: Final[Mapping[str, Principal]] = MappingProxyType(
    {
        "anonymous": ANONYMOUS,
        "kubeproxy": KUBEPROXY,
        "ingress": INGRESS,
        "kubelet": KUBELET,
        "node": NODE,
        "controller": CONTROLLER,
        "scheduler": SCHEDULER,
        "apiserver": APISERVER,
        "autoscaler": AUTOSCALER,
        "npd": NPD,
        "npdSA": NPD_SA,
        "namespaceController": NAMESPACE_CONTROLLER,
        "endpointController": ENDPOINT_CONTROLLER,
        "defaultSA": DEFAULT_SA,
    }
)


# ---------------------------------------------------------------------------
# The resource selector, and the 23 selectors the matrix uses
#
# Ported from the `Resource` struct and the `resource(kind, nsGroupSub...)`
# constructor at cluster/gce/gci/audit_policy_test.go L272-288, and from the 23
# declarations at L94-116.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ResourceSelector:
    """The resource half of a request: what object kind is being acted on.

    Frozen and hashable for the same isolation reason as `Principal`.

    Field order mirrors the Go `Resource` struct's own field list, and every field
    defaults to the empty string exactly as the Go zero value does. An empty
    string is meaningful and is not a missing value: an empty `namespace` means a
    cluster-scoped request, an empty `group` means the core API group, and an
    empty `subresource` means the resource itself.

    Attributes:
        resource: The resource kind - `secrets`, `nodes`, `clusterroles`.
        namespace: The namespace, or `""` for a cluster-scoped request.
        group: The API group, or `""` for the core group.
        subresource: The subresource - `status`, `token`, `finalize` - or `""`.
    """

    resource: str
    namespace: str = ""
    group: str = ""
    subresource: str = ""

    @property
    def policy_resource(self) -> str:
        """The `resource[/subresource]` spelling a policy rule uses.

        `secrets`, but `serviceaccounts/token` and `nodes/status`. This is the key
        into `SENSITIVE_RESOURCE_LEVELS`, and it is the ONE place the subresource
        appears in a derived string - it is deliberately absent from `audit_name`
        below, because the Go subtest name omits it.
        """
        if self.subresource:
            return f"{self.resource}/{self.subresource}"
        return self.resource

    @property
    def audit_name(self) -> str:
        """The object component of a case id: `resource`, or `resource:namespace`.

        The port of the resource branch of `expectLevel`
        (audit_policy_test.go L246-253)::

            obj = attrs.GetResource()
            if attrs.GetNamespace() != "" {
                obj = obj + ":" + attrs.GetNamespace()
            }

        NEITHER THE SUBRESOURCE NOR THE API GROUP APPEARS HERE. That is not an
        omission in this port, it is what the Go source does, and it is the reason
        35 of the 620 ids need a `#NN` suffix: `nodes` and `nodes/status` both
        render `nodes`; `namespaces`, `namespaces/status` and `namespaces/finalize`
        all render `namespaces`; `serviceaccounts/token` renders
        `serviceaccounts:default`; `foos` and `foos/baz` both render
        `foos:default`. Adding either component would make every id unique, remove
        all 35 suffixes and put this port permanently out of step with the
        baseline manifest.
        """
        if self.namespace:
            return f"{self.resource}:{self.namespace}"
        return self.resource

    def __str__(self) -> str:
        """The policy spelling, which is the most informative in a message."""
        return self.policy_resource


def resource(kind: str, *ns_group_sub: str) -> ResourceSelector:
    """Build a `ResourceSelector` with the Go constructor's positional semantics.

    The port of `resource(kind string, nsGroupSub ...string)`
    (audit_policy_test.go L276-288). The variadic tail is POSITIONAL and its order
    is namespace, group, subresource - which reads oddly next to the struct's own
    field order and is precisely why it is ported rather than reinvented: the 23
    declarations below are transcribed argument for argument from the Go source,
    so a helper with different positions would silently relabel a namespace as a
    group.

        resource("nodes")                                 -> cluster-scoped, core
        resource("endpoints", "default")                   -> namespace only
        resource("podmetrics", "default", "metrics.k8s.io") -> namespace + group
        resource("nodes", "", "", "status")                 -> subresource only

    Args:
        kind: The resource kind. Must be non-empty.
        *ns_group_sub: Up to three positional strings: namespace, group,
            subresource. Each omitted position defaults to `""`.

    Returns:
        The `ResourceSelector` those arguments describe.

    Raises:
        ValueError: If `kind` is empty, or if more than three tail arguments are
            supplied. Go silently ignores a fourth argument; this port refuses it,
            because a fourth argument can only be a transcription error and
            dropping it silently would discard part of a selector.
    """
    if not kind:
        raise ValueError("a resource selector needs a kind, got an empty string")
    if len(ns_group_sub) > 3:
        raise ValueError(
            "resource() accepts at most three positional arguments after the kind "
            f"(namespace, group, subresource), got {len(ns_group_sub)}: {ns_group_sub!r}"
        )
    namespace = ns_group_sub[0] if len(ns_group_sub) > 0 else ""
    group = ns_group_sub[1] if len(ns_group_sub) > 1 else ""
    subresource = ns_group_sub[2] if len(ns_group_sub) > 2 else ""
    return ResourceSelector(
        resource=kind,
        namespace=namespace,
        group=group,
        subresource=subresource,
    )


# The 23 selectors, in declaration order, transcribed one line per Go line from
# audit_policy_test.go L94-116. The Go local is named on each so the invocation
# table transcribes one-to-one.
#
# Counted, not assumed:
#   $ sed -n '94,116p' cluster/gce/gci/audit_policy_test.go | grep -c '= resource('
#   23
# The AAP characterises the matrix as using 24 selectors; the source declares 23.

NODES: Final[ResourceSelector] = resource("nodes")  # Go local: nodes
NODE_STATUS: Final[ResourceSelector] = resource("nodes", "", "", "status")  # nodeStatus
ENDPOINTS: Final[ResourceSelector] = resource("endpoints", "default")  # endpoints
SYS_ENDPOINTS: Final[ResourceSelector] = resource("endpoints", "kube-system")  # sysEndpoints
SERVICES: Final[ResourceSelector] = resource("services", "default")  # services
SERVICE_STATUS: Final[ResourceSelector] = resource(
    "services", "default", "", "status"
)  # serviceStatus
CONFIGMAPS: Final[ResourceSelector] = resource("configmaps", "default")  # configmaps
SYS_CONFIGMAPS: Final[ResourceSelector] = resource("configmaps", "kube-system")  # sysConfigmaps
NAMESPACES: Final[ResourceSelector] = resource("namespaces")  # namespaces
NAMESPACE_STATUS: Final[ResourceSelector] = resource(
    "namespaces", "", "", "status"
)  # namespaceStatus
NAMESPACE_FINAL: Final[ResourceSelector] = resource(
    "namespaces", "", "", "finalize"
)  # namespaceFinal
POD_METRICS: Final[ResourceSelector] = resource(
    "podmetrics", "default", "metrics.k8s.io"
)  # podMetrics
NODE_METRICS: Final[ResourceSelector] = resource(
    "nodemetrics", "", "metrics.k8s.io"
)  # nodeMetrics
PODS: Final[ResourceSelector] = resource("pods", "default")  # pods
POD_STATUS: Final[ResourceSelector] = resource("pods", "default", "", "status")  # podStatus

# The V6 headline. `secrets` in the core group, namespaced, no subresource: the
# selector whose expected level is `Request` in every invocation that names it.
SECRETS: Final[ResourceSelector] = resource("secrets", "default")  # secrets

# The other half of the V6 raise. Note it is the `token` SUBRESOURCE of
# `serviceaccounts`, so its policy spelling is `serviceaccounts/token` while its
# audit name is the bare `serviceaccounts:default`.
SA_TOKENS: Final[ResourceSelector] = resource(
    "serviceaccounts", "default", "", "token"
)  # saTokens

# Cluster-scoped and in authentication.k8s.io: a TokenReview carries a credential
# in its request body and stays pinned at `Metadata`.
TOKEN_REVIEWS: Final[ResourceSelector] = resource(
    "tokenreviews", "", "authentication.k8s.io"
)  # tokenReviews

DEPLOYMENTS: Final[ResourceSelector] = resource("deployments", "default", "apps")  # deployments

# Cluster-scoped RBAC: reads are `Request`, mutations are `RequestResponse`.
CLUSTER_ROLES: Final[ResourceSelector] = resource(
    "clusterroles", "", "rbac.authorization.k8s.io"
)  # clusterRoles

# Events are dropped entirely (`None`) for performance, which is why an
# events-only invocation exists to prove the drop is deliberate.
EVENTS: Final[ResourceSelector] = resource("events", "default")  # events

# An UNKNOWN API group. `foos` and `foos/baz` in example.com stand in for a CRD
# the generator has never heard of, so they fall through every known-API rule to
# the policy's final catch-all and must be recorded at `Metadata`. This is the
# unknown-API default, and it is the reason a newly installed CRD cannot silently
# become unaudited.
FOOBARS: Final[ResourceSelector] = resource("foos", "default", "example.com")  # foobars
FOOBARBAZ: Final[ResourceSelector] = resource(
    "foos", "default", "example.com", "baz"
)  # foobarbaz


# All 23 selectors in Go declaration order.
ALL_SELECTORS: Final[tuple[ResourceSelector, ...]] = (
    NODES,
    NODE_STATUS,
    ENDPOINTS,
    SYS_ENDPOINTS,
    SERVICES,
    SERVICE_STATUS,
    CONFIGMAPS,
    SYS_CONFIGMAPS,
    NAMESPACES,
    NAMESPACE_STATUS,
    NAMESPACE_FINAL,
    POD_METRICS,
    NODE_METRICS,
    PODS,
    POD_STATUS,
    SECRETS,
    SA_TOKENS,
    TOKEN_REVIEWS,
    DEPLOYMENTS,
    CLUSTER_ROLES,
    EVENTS,
    FOOBARS,
    FOOBARBAZ,
)

# The same 23 selectors keyed by the verbatim Go local identifier, for the same
# reviewer-facing reason as PRINCIPALS_BY_GO_LOCAL.
SELECTORS_BY_GO_LOCAL: Final[Mapping[str, ResourceSelector]] = MappingProxyType(
    {
        "nodes": NODES,
        "nodeStatus": NODE_STATUS,
        "endpoints": ENDPOINTS,
        "sysEndpoints": SYS_ENDPOINTS,
        "services": SERVICES,
        "serviceStatus": SERVICE_STATUS,
        "configmaps": CONFIGMAPS,
        "sysConfigmaps": SYS_CONFIGMAPS,
        "namespaces": NAMESPACES,
        "namespaceStatus": NAMESPACE_STATUS,
        "namespaceFinal": NAMESPACE_FINAL,
        "podMetrics": POD_METRICS,
        "nodeMetrics": NODE_METRICS,
        "pods": PODS,
        "podStatus": POD_STATUS,
        "secrets": SECRETS,
        "saTokens": SA_TOKENS,
        "tokenReviews": TOKEN_REVIEWS,
        "deployments": DEPLOYMENTS,
        "clusterRoles": CLUSTER_ROLES,
        "events": EVENTS,
        "foobars": FOOBARS,
        "foobarbaz": FOOBARBAZ,
    }
)


# ---------------------------------------------------------------------------
# Non-resource requests
# ---------------------------------------------------------------------------

# The two path groups, transcribed from the two `at.testNonResources(...)` calls
# at audit_policy_test.go L164-165. EACH GROUP HAS EXACTLY FIVE PATHS, counted
# from the source rather than read from prose:
#
#   $ sed -n '164p' ...audit_policy_test.go | grep -o '"/[^"]*"' | wc -l   -> 5
#   $ sed -n '165p' ...audit_policy_test.go | grep -o '"/[^"]*"' | wc -l   -> 5
#
# The count is load-bearing arithmetic: 2 calls x 14 users x 2 verbs x 5 paths is
# 280, which with the 340 resource cases makes 620. Reading either group as six
# paths yields 336 non-resource cases and 676 in total, and every id after the
# first extra path shifts against the baseline manifest.

# Unauthenticated liveness and discovery endpoints, recorded at `None`: they are
# polled constantly and reveal nothing, so auditing them would bury real events.
# Matched in the policy by the prefix patterns /healthz*, /version and /swagger*.
HEALTH_AND_VERSION_PATHS: Final[tuple[str, ...]] = (
    "/healthz",
    "/healthz/etcd",
    "/swagger-2.0.0.json",
    "/swagger-2.0.0.pb-v1.gz",
    "/version",
)

# Everything else non-resource, recorded at `Metadata` by the policy's final
# catch-all: `/logs` can expose node log content and `/apis/policy` is a real API
# surface, so the fact that these are NOT in the `None` group above is the
# assertion. `/healthz` is excluded above by an explicit prefix rule; nothing
# excludes these.
OBSERVABILITY_AND_DISCOVERY_PATHS: Final[tuple[str, ...]] = (
    "/logs",
    "/openapi/v2",
    "/apis/policy",
    "/metrics",
    "/api",
)

# All ten distinct non-resource paths, in the order the two invocations use them.
ALL_NON_RESOURCE_PATHS: Final[tuple[str, ...]] = (
    *HEALTH_AND_VERSION_PATHS,
    *OBSERVABILITY_AND_DISCOVERY_PATHS,
)

# The verbs `testNonResources` hardcodes as its middle loop
# (audit_policy_test.go L232). They are IMPLICIT in the Go call - no invocation
# passes them - so they are named here rather than repeated in the two
# non-resource rows of the invocation table. `post` and not `create`: a
# non-resource request carries an HTTP method, not a Kubernetes verb.
NON_RESOURCE_VERBS: Final[tuple[str, ...]] = ("get", "post")

# The API version every case declares. `testResources` hardcodes
# `APIVersion: "v1"` on the attributes it builds (audit_policy_test.go L219) and
# `testNonResources` leaves it empty; both are reproduced by
# `AuditPolicyCase.attributes()`, which omits it for a non-resource request. No
# policy rule in the generated file matches on the API version, so this value is
# carried for fidelity with the Go harness rather than because a level depends on
# it.
API_VERSION: Final[str] = "v1"


# ---------------------------------------------------------------------------
# The assertion invocations
#
# Ported from the 29 `at.testResources(...)` and `at.testNonResources(...)` calls
# at cluster/gce/gci/audit_policy_test.go L132-183, and from the two expansion
# loops that consume them (`testResources` L191-228, `testNonResources`
# L230-244).
# ---------------------------------------------------------------------------


class InvocationKind(Enum):
    """Which Go helper an invocation was written against.

    The distinction is not cosmetic - the two helpers differ in what they iterate
    and in the attributes they build:

    * `RESOURCE` -> `at.testResources(level, users..., verbs..., resources...)`,
      which builds attributes with `ResourceRequest: true`, a namespace, an API
      group, an API version, a resource and a subresource.
    * `NON_RESOURCE` -> `at.testNonResources(level, users, paths...)`, which
      builds attributes with `ResourceRequest: false` and a path, hardcodes the
      verbs to `get` and `post`, and sets none of the resource fields.
    """

    RESOURCE = "resource"
    NON_RESOURCE = "non_resource"


@dataclass(frozen=True, slots=True)
class Invocation:
    """One `at.test*` call: one expected level over a small cross product.

    Every field is a tuple, and the record is frozen, so the table below is
    read-only shared data for the whole session.

    Attributes:
        go_line: The line in `cluster/gce/gci/audit_policy_test.go` this row was
            transcribed from. Carried so a failing case points a reader at the Go
            line that declares its expectation, not merely at this file.
        kind: Which helper, and therefore how the row expands.
        level: THE EXPECTED LEVEL FOR EVERY CASE THIS ROW PRODUCES. Read from the
            row, never from a default and never from
            `SENSITIVE_RESOURCE_LEVELS` - the invocation is the authority.
        principals: The identities, in the Go argument order. Outermost loop.
        verbs: The verbs, in the Go argument order. Middle loop.
        selectors: The resource selectors for a `RESOURCE` row, else empty.
            Innermost loop.
        paths: The non-resource paths for a `NON_RESOURCE` row, else empty.
            Innermost loop.
        expected_case_count: The number of cases this row must produce, taken
            from the migration plan's per-invocation table, which was itself
            derived from the Go suite. Checked against the product of the
            dimensions at construction time, so a mistranscribed argument list
            fails immediately rather than silently changing the total.
    """

    go_line: int
    kind: InvocationKind
    level: AuditLevel
    principals: tuple[Principal, ...]
    verbs: tuple[str, ...]
    expected_case_count: int
    selectors: tuple[ResourceSelector, ...] = ()
    paths: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        """Validate the row, porting the Go harness's own preconditions.

        `testResources` opens with three `require.NotEmpty` assertions
        (audit_policy_test.go L207-209) - a case needs a verb, a user and a
        resource - because its argument list is variadic `interface{}` and a
        mistyped call would otherwise expand to nothing and report success
        vacuously. Python's typed tuples remove the type confusion but not the
        empty-tuple hazard, so the checks are ported.

        The `expected_case_count` cross-check is additional, and it is the reason
        this table can be trusted: it compares the count transcribed from the
        plan against the product of the dimensions transcribed from the Go call.
        A dropped selector or a duplicated verb changes the product and fails
        here, at import, instead of changing the suite's total silently.

        Raises:
            ValueError: If any dimension is empty, if the target collection does
                not match `kind`, or if the dimensions do not multiply out to
                `expected_case_count`.
        """
        where = f"invocation transcribed from audit_policy_test.go L{self.go_line}"
        if not self.principals:
            raise ValueError(f"{where}: needs at least one principal")
        if not self.verbs:
            raise ValueError(f"{where}: needs at least one verb")
        if self.kind is InvocationKind.RESOURCE:
            if not self.selectors:
                raise ValueError(f"{where}: a resource invocation needs at least one selector")
            if self.paths:
                raise ValueError(f"{where}: a resource invocation must not carry paths")
        else:
            if not self.paths:
                raise ValueError(f"{where}: a non-resource invocation needs at least one path")
            if self.selectors:
                raise ValueError(f"{where}: a non-resource invocation must not carry selectors")
        if self.case_count != self.expected_case_count:
            raise ValueError(
                f"{where}: expands to {self.case_count} cases "
                f"({len(self.principals)} principals x {len(self.verbs)} verbs x "
                f"{len(self.targets)} targets) but the transcribed expectation is "
                f"{self.expected_case_count}"
            )

    @property
    def targets(self) -> tuple[ResourceSelector, ...] | tuple[str, ...]:
        """The innermost loop's items: the selectors, or the paths."""
        if self.kind is InvocationKind.RESOURCE:
            return self.selectors
        return self.paths

    @property
    def case_count(self) -> int:
        """How many cases this row expands to: principals x verbs x targets."""
        return len(self.principals) * len(self.verbs) * len(self.targets)


# The invocation table: all 29 calls, in Go source order, each preceded by the
# call it was transcribed from so the two can be diffed line by line. The Go
# source's own explanatory comments are carried in place - they are the record of
# why the V6 levels are what they are, and AAP §0.11.1 ("Cite only what the
# repository states") is why they are reproduced rather than paraphrased.
#
# ORDER IS LOAD-BEARING TWICE OVER. Rows expand in this order and each row
# expands principals -> verbs -> targets, which together fix the order of all 620
# ids and therefore the `#NN` suffix that lands on each repeated name. The 280
# non-resource cases sit in the MIDDLE of the sequence (rows 19 and 20, Go
# L164-165), not at either end; moving them would renumber nothing but would
# reorder the manifest comparison.
INVOCATIONS: Final[tuple[Invocation, ...]] = (
    # 1. Go L132: at.testResources(none, kubeproxy, "watch", endpoints,
    #             sysEndpoints, services, serviceStatus)
    # kube-proxy watches endpoints and services constantly; auditing that traffic
    # would drown the log. `serviceStatus` renders the same audit name as
    # `services`, which is where the first `#01` suffix comes from.
    Invocation(
        go_line=132,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(KUBEPROXY,),
        verbs=("watch",),
        selectors=(ENDPOINTS, SYS_ENDPOINTS, SERVICES, SERVICE_STATUS),
        expected_case_count=4,
    ),
    # 2. Go L133: at.testResources(request, kubeproxy, "watch", nodes, pods)
    Invocation(
        go_line=133,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(KUBEPROXY,),
        verbs=("watch",),
        selectors=(NODES, PODS),
        expected_case_count=2,
    ),
    # 3. Go L135: at.testResources(none, ingress, "get", sysConfigmaps)
    Invocation(
        go_line=135,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(INGRESS,),
        verbs=("get",),
        selectors=(SYS_CONFIGMAPS,),
        expected_case_count=1,
    ),
    # 4. Go L136: at.testResources(metadata, ingress, "get", configmaps)
    # The pair 3/4 is the assertion that the kube-system exemption is scoped to
    # kube-system: the same principal reading the same resource in `default` is
    # recorded at Metadata.
    Invocation(
        go_line=136,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.METADATA,
        principals=(INGRESS,),
        verbs=("get",),
        selectors=(CONFIGMAPS,),
        expected_case_count=1,
    ),
    # 5. Go L138: at.testResources(none, kubelet, node, "get", nodes, nodeStatus)
    # `nodes` and `nodeStatus` share an audit name, so each principal here
    # produces a bare name and a `#01`.
    Invocation(
        go_line=138,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(KUBELET, NODE),
        verbs=("get",),
        selectors=(NODES, NODE_STATUS),
        expected_case_count=4,
    ),
    # Go L139-141, verbatim:
    #   secrets are raised from Metadata to Request by create-master-audit-policy
    #   per the V6 mandate (tech-spec §6.4.6, AAP §0.6.3 / §0.5.1); a get carries
    #   no payload in the (omitted) response object, so read paths log no secret
    #   data. sysConfigmaps stays Metadata.
    #
    # 6. Go L142: at.testResources(metadata, kubelet, node, "get", sysConfigmaps)
    Invocation(
        go_line=142,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.METADATA,
        principals=(KUBELET, NODE),
        verbs=("get",),
        selectors=(SYS_CONFIGMAPS,),
        expected_case_count=2,
    ),
    # 7. Go L143: at.testResources(request, kubelet, node, "get", secrets)
    # THE V6 BOUNDARY. A node reading a Secret is recorded at Request, not
    # Metadata. Pairing it with row 6 on the same principals and the same verb is
    # what proves the raise is scoped to secrets rather than applied broadly.
    Invocation(
        go_line=143,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(KUBELET, NODE),
        verbs=("get",),
        selectors=(SECRETS,),
        expected_case_count=2,
    ),
    # 8. Go L144: at.testResources(response, kubelet, node, "create", deployments,
    #             pods)
    Invocation(
        go_line=144,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.RESPONSE,
        principals=(KUBELET, NODE),
        verbs=("create",),
        selectors=(DEPLOYMENTS, PODS),
        expected_case_count=4,
    ),
    # 9. Go L146: at.testResources(none, controller, scheduler, endpointController,
    #             "get", "update", sysEndpoints)
    # The leader-election path: these three principals hammer the kube-system
    # endpoints object, so it is dropped for them - and only for them, and only in
    # kube-system, as rows 10 and 11 assert.
    Invocation(
        go_line=146,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(CONTROLLER, SCHEDULER, ENDPOINT_CONTROLLER),
        verbs=("get", "update"),
        selectors=(SYS_ENDPOINTS,),
        expected_case_count=6,
    ),
    # 10. Go L147: at.testResources(request, controller, scheduler,
    #              endpointController, "get", endpoints)
    Invocation(
        go_line=147,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(CONTROLLER, SCHEDULER, ENDPOINT_CONTROLLER),
        verbs=("get",),
        selectors=(ENDPOINTS,),
        expected_case_count=3,
    ),
    # 11. Go L148: at.testResources(response, controller, scheduler,
    #              endpointController, "update", endpoints)
    # Same principals, same resource, different verb, different level: a read is
    # Request because responses can be large, a write is RequestResponse.
    Invocation(
        go_line=148,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.RESPONSE,
        principals=(CONTROLLER, SCHEDULER, ENDPOINT_CONTROLLER),
        verbs=("update",),
        selectors=(ENDPOINTS,),
        expected_case_count=3,
    ),
    # 12. Go L150: at.testResources(none, apiserver, "get", namespaces,
    #              namespaceStatus, namespaceFinal)
    # All three selectors render the audit name `namespaces`, which is the only
    # name in the matrix repeated three times: it produces
    # `system:apiserver.get.namespaces`, then the same name with `#01`, then with
    # `#02`.
    Invocation(
        go_line=150,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(APISERVER,),
        verbs=("get",),
        selectors=(NAMESPACES, NAMESPACE_STATUS, NAMESPACE_FINAL),
        expected_case_count=3,
    ),
    # Go L151-154, verbatim:
    #   secrets audited at Request per the V6 mandate (§6.4.6, AAP §0.6.3 /
    #   §0.5.1): Request records the request object but omits the response object,
    #   so get/list never log secret data; create/update log the request body (the
    #   accepted trade-off, AAP §0.2.4). sysConfigmaps stays Metadata.
    #
    # 13. Go L155: at.testResources(metadata, apiserver, "get", "create",
    #              "update", sysConfigmaps)
    Invocation(
        go_line=155,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.METADATA,
        principals=(APISERVER,),
        verbs=("get", "create", "update"),
        selectors=(SYS_CONFIGMAPS,),
        expected_case_count=3,
    ),
    # 14. Go L156: at.testResources(request, apiserver, "get", "create", "update",
    #              secrets)
    # THE V6 BOUNDARY, across a read and two writes. The most privileged principal
    # in the matrix gets no exemption from the secrets raise.
    Invocation(
        go_line=156,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(APISERVER,),
        verbs=("get", "create", "update"),
        selectors=(SECRETS,),
        expected_case_count=3,
    ),
    # 15. Go L158: at.testResources(none, autoscaler, "get", "update",
    #              sysConfigmaps, sysEndpoints)
    Invocation(
        go_line=158,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(AUTOSCALER,),
        verbs=("get", "update"),
        selectors=(SYS_CONFIGMAPS, SYS_ENDPOINTS),
        expected_case_count=4,
    ),
    # 16. Go L159: at.testResources(metadata, autoscaler, "get", "update",
    #              configmaps)
    Invocation(
        go_line=159,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.METADATA,
        principals=(AUTOSCALER,),
        verbs=("get", "update"),
        selectors=(CONFIGMAPS,),
        expected_case_count=2,
    ),
    # 17. Go L160: at.testResources(response, autoscaler, "update", endpoints)
    Invocation(
        go_line=160,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.RESPONSE,
        principals=(AUTOSCALER,),
        verbs=("update",),
        selectors=(ENDPOINTS,),
        expected_case_count=1,
    ),
    # 18. Go L162: at.testResources(none, controller, "get", "list", podMetrics,
    #              nodeMetrics)
    # metrics.k8s.io is high-volume telemetry, dropped for the controller manager.
    Invocation(
        go_line=162,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(CONTROLLER,),
        verbs=("get", "list"),
        selectors=(POD_METRICS, NODE_METRICS),
        expected_case_count=4,
    ),
    # 19. Go L164: at.testNonResources(none, allUsers, "/healthz",
    #              "/healthz/etcd", "/swagger-2.0.0.json",
    #              "/swagger-2.0.0.pb-v1.gz", "/version")
    # 14 principals x 2 implicit verbs x 5 paths = 140. Asserted for EVERY
    # principal including system:anonymous, because these endpoints are reachable
    # unauthenticated and their exemption must hold for an unauthenticated caller.
    Invocation(
        go_line=164,
        kind=InvocationKind.NON_RESOURCE,
        level=AuditLevel.NONE,
        principals=ALL_PRINCIPALS,
        verbs=NON_RESOURCE_VERBS,
        paths=HEALTH_AND_VERSION_PATHS,
        expected_case_count=140,
    ),
    # 20. Go L165: at.testNonResources(metadata, allUsers, "/logs",
    #              "/openapi/v2", "/apis/policy", "/metrics", "/api")
    # 14 x 2 x 5 = 140. The complement of row 19: everything non-resource that is
    # NOT exempt is recorded at Metadata, `/logs` most pointedly.
    Invocation(
        go_line=165,
        kind=InvocationKind.NON_RESOURCE,
        level=AuditLevel.METADATA,
        principals=ALL_PRINCIPALS,
        verbs=NON_RESOURCE_VERBS,
        paths=OBSERVABILITY_AND_DISCOVERY_PATHS,
        expected_case_count=140,
    ),
    # 21. Go L167: at.testResources(none, node, apiserver, defaultSA, anonymous,
    #              "get", "list", "create", "patch", "update", "delete", events)
    # Events are dropped for performance regardless of principal or verb: 4
    # principals x 6 verbs x 1 selector = 24.
    Invocation(
        go_line=167,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.NONE,
        principals=(NODE, APISERVER, DEFAULT_SA, ANONYMOUS),
        verbs=("get", "list", "create", "patch", "update", "delete"),
        selectors=(EVENTS,),
        expected_case_count=24,
    ),
    # 22. Go L169: at.testResources(request, kubelet, node, npd, npdSA, "update",
    #              "patch", nodeStatus, podStatus)
    # Node and pod status updates are high-volume and can be large, so responses
    # are not logged: Request, not RequestResponse. Two of these principals match
    # the rule by name and two by the system:nodes group, which is why all four are
    # exercised.
    Invocation(
        go_line=169,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(KUBELET, NODE, NPD, NPD_SA),
        verbs=("update", "patch"),
        selectors=(NODE_STATUS, POD_STATUS),
        expected_case_count=16,
    ),
    # 23. Go L171: at.testResources(request, namespaceController,
    #              "deletecollection", pods, namespaces)
    # A namespace deletion cascades into a deletecollection whose response would
    # be enormous, so the response is omitted.
    Invocation(
        go_line=171,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(NAMESPACE_CONTROLLER,),
        verbs=("deletecollection",),
        selectors=(PODS, NAMESPACES),
        expected_case_count=2,
    ),
    # Go L173-176, verbatim:
    #   configmaps, sysConfigmaps and tokenReviews remain Metadata (§6.4.6, AAP
    #   §0.6.3), while secrets and serviceaccounts/token are raised to Request per
    #   the V6 mandate (AAP §0.6.3 / §0.5.1). Request omits the response object, so
    #   a token's issued credential (response-only) and secret read payloads
    #   (response-only) are never written to the audit log.
    #
    # 24. Go L177: at.testResources(metadata, defaultSA, anonymous, npd,
    #              namespaceController, "get", "create", "update", configmaps,
    #              sysConfigmaps, tokenReviews)
    # 4 principals x 3 verbs x 3 selectors = 36. Rows 24 through 28 form the
    # heart of the V6 assertion: the same four principals and overlapping verbs,
    # partitioned by resource into four different levels.
    Invocation(
        go_line=177,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.METADATA,
        principals=(DEFAULT_SA, ANONYMOUS, NPD, NAMESPACE_CONTROLLER),
        verbs=("get", "create", "update"),
        selectors=(CONFIGMAPS, SYS_CONFIGMAPS, TOKEN_REVIEWS),
        expected_case_count=36,
    ),
    # 25. Go L178: at.testResources(request, defaultSA, anonymous, npd,
    #              namespaceController, "get", "create", "update", secrets)
    # THE V6 BOUNDARY, one level above row 24 on the same principals and verbs.
    # 4 x 3 x 1 = 12.
    Invocation(
        go_line=178,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(DEFAULT_SA, ANONYMOUS, NPD, NAMESPACE_CONTROLLER),
        verbs=("get", "create", "update"),
        selectors=(SECRETS,),
        expected_case_count=12,
    ),
    # 26. Go L179: at.testResources(request, defaultSA, apiserver, "create",
    #              saTokens)
    # THE V6 BOUNDARY for token issuance. Request is credential-safe here: the
    # issued token exists only in the response, which Request omits.
    Invocation(
        go_line=179,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(DEFAULT_SA, APISERVER),
        verbs=("create",),
        selectors=(SA_TOKENS,),
        expected_case_count=2,
    ),
    # 27. Go L180: at.testResources(request, defaultSA, anonymous, npd,
    #              namespaceController, "get", "list", "watch", sysEndpoints,
    #              podMetrics, pods, clusterRoles, deployments)
    # Known-API READS: 4 x 3 x 5 = 60, all Request because get and list responses
    # can be large. `clusterRoles` appears here at Request and in row 28 at
    # RequestResponse; both are correct and neither may be normalised to the
    # other.
    Invocation(
        go_line=180,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.REQUEST,
        principals=(DEFAULT_SA, ANONYMOUS, NPD, NAMESPACE_CONTROLLER),
        verbs=("get", "list", "watch"),
        selectors=(SYS_ENDPOINTS, POD_METRICS, PODS, CLUSTER_ROLES, DEPLOYMENTS),
        expected_case_count=60,
    ),
    # 28. Go L181: at.testResources(response, defaultSA, anonymous, npd,
    #              namespaceController, "create", "update", "patch", "delete",
    #              sysEndpoints, podMetrics, pods, clusterRoles, deployments)
    # Known-API MUTATIONS: 4 x 4 x 5 = 80, all RequestResponse - the known-API
    # default, and the level a change to a ClusterRole must be recorded at.
    Invocation(
        go_line=181,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.RESPONSE,
        principals=(DEFAULT_SA, ANONYMOUS, NPD, NAMESPACE_CONTROLLER),
        verbs=("create", "update", "patch", "delete"),
        selectors=(SYS_ENDPOINTS, POD_METRICS, PODS, CLUSTER_ROLES, DEPLOYMENTS),
        expected_case_count=80,
    ),
    # 29. Go L183: at.testResources(metadata, defaultSA, anonymous, npd,
    #              namespaceController, "get", "list", "watch", "create",
    #              "update", "patch", "delete", foobars, foobarbaz)
    # THE UNKNOWN-API DEFAULT: 4 x 7 x 2 = 56. `foos` in example.com matches no
    # known-API rule, so every verb falls through to the policy's final catch-all
    # at Metadata - a CRD is never silently unaudited. Both selectors render the
    # audit name `foos:default`, so all 28 names in this row repeat once, adding 28
    # of the 35 `#NN` suffixes.
    Invocation(
        go_line=183,
        kind=InvocationKind.RESOURCE,
        level=AuditLevel.METADATA,
        principals=(DEFAULT_SA, ANONYMOUS, NPD, NAMESPACE_CONTROLLER),
        verbs=("get", "list", "watch", "create", "update", "patch", "delete"),
        selectors=(FOOBARS, FOOBARBAZ),
        expected_case_count=56,
    ),
)


# ---------------------------------------------------------------------------
# The expanded cases
#
# Ported from the expansion loops of `testResources` (L211-227) and
# `testNonResources` (L231-243) and from the naming half of `expectLevel`
# (L246-254).
# ---------------------------------------------------------------------------

# The separator Go's testing package inserts between a repeated subtest name and
# its occurrence number. `(*T).Run` delegates to `matcher.unique`, which returns
# the plain name the first time it sees it and `fmt.Sprintf("%s#%02d", name, n)`
# on every later occurrence, where n counts the occurrences already seen. Two
# digits, zero-padded: `#01`, not `#1`.
_DUPLICATE_ID_SEPARATOR: Final[str] = "#"


@dataclass(frozen=True, slots=True)
class AuditPolicyCase:
    """One expected outcome: this principal, this verb, this target, this level.

    620 of these are the whole contract of control V6's shell-boundary tier. The
    record is frozen and every field is a scalar or an immutable record, so the
    tuple `expand()` returns is safe to share across a whole session, including
    across `pytest-xdist` workers.

    Deliberately NOT bound to a pytest construct. The record carries its own `id`,
    so it drives `@pytest.mark.parametrize(..., ids=[c.id for c in cases])` for
    independent cases and a `with subtests.test(case=c.id)` loop for
    accumulate-and-continue reporting, with no reshaping and no import of pytest
    here. Both matter: AAP §0.4.1.2 maps Go's `t.Errorf` (record and continue) onto
    subtests and its `t.Fatalf` (abort) onto a bare assert, and a fixture module
    that forced one shape would take that choice away from the test author.

    Attributes:
        id: The unique case identifier, equal to the Go subtest name including any
            `#NN` occurrence suffix. THIS IS THE PARITY KEY: the baseline manifest
            records verdicts against these strings.
        base_name: The identifier before de-duplication, `user.verb.object`. Not
            unique - 34 base names occur more than once.
        occurrence: How many earlier cases shared this `base_name`. 0 for the
            first, so `id == base_name` exactly when `occurrence == 0`.
        level: The audit level this request must be recorded at.
        principal: The requesting identity.
        verb: The verb, lower case, as the policy spells it.
        selector: The resource selector for a resource request, else `None`.
        path: The path for a non-resource request, else `""`.
        resource_request: `True` for a resource request, `False` for a
            non-resource one. Mirrors `authorizer.AttributesRecord.ResourceRequest`
            and is what decides which of `selector` and `path` is populated.
        api_version: `"v1"` for a resource request, `""` for a non-resource one,
            reproducing the Go harness exactly.
        go_line: The line of `cluster/gce/gci/audit_policy_test.go` whose
            invocation declares this expectation.
        invocation_index: The 0-based position of that invocation in
            `INVOCATIONS`.
    """

    id: str
    base_name: str
    occurrence: int
    level: AuditLevel
    principal: Principal
    verb: str
    selector: ResourceSelector | None
    path: str
    resource_request: bool
    api_version: str
    go_line: int
    invocation_index: int

    @property
    def expected_omit_stages(self) -> tuple[str, ...]:
        """`("RequestReceived",)`, or `()` when the level is `None`.

        The port of the conditional half of `expectLevel`
        (audit_policy_test.go L259-261): the Go test asserts `OmitStages` only when
        the evaluated level is not `LevelNone`. An empty tuple therefore means
        "the Go test asserts nothing here", NOT "assert that OmitStages is empty" -
        `NO_OMIT_STAGES` is named for exactly that reading. Compare
        order-insensitively; the Go assertion is `ElementsMatch`.
        """
        if self.level is AuditLevel.NONE:
            return NO_OMIT_STAGES
        return EXPECTED_OMIT_STAGES

    @property
    def target_name(self) -> str:
        """The object component of `base_name`: the path, or `resource[:namespace]`."""
        if self.selector is None:
            return self.path
        return self.selector.audit_name

    def attributes(self) -> Mapping[str, object]:
        """The request attributes to evaluate the policy against.

        A one-to-one, read-only rendering of the `authorizer.AttributesRecord` the
        Go harness builds - L214-223 for a resource request, L234-239 for a
        non-resource one - with Go field names lower-cased and snake-cased:

            user, verb, namespace, api_group, api_version, resource,
            subresource, resource_request, path

        Both shapes carry all nine keys so a consumer can index without probing,
        and the fields the corresponding Go branch leaves at their zero value are
        the empty string here, exactly as they are there. That symmetry matters:
        `namespace: ""` on a non-resource request is what the Go record actually
        contains, and a policy evaluator must see the same thing.

        Returns:
            An immutable mapping. A fresh `MappingProxyType` over a fresh dict per
            call, so a consumer may keep it without any risk of aliasing this
            module's data.
        """
        selector = self.selector
        return MappingProxyType(
            {
                "user": self.principal.name,
                "groups": self.principal.groups,
                "verb": self.verb,
                "namespace": selector.namespace if selector is not None else "",
                "api_group": selector.group if selector is not None else "",
                "api_version": self.api_version,
                "resource": selector.resource if selector is not None else "",
                "subresource": selector.subresource if selector is not None else "",
                "resource_request": self.resource_request,
                "path": self.path,
            }
        )

    def __str__(self) -> str:
        """The id, which is how a case is referred to everywhere else."""
        return self.id


def _case_id(base_name: str, occurrence: int) -> str:
    """Apply Go's subtest de-duplication to one base name.

    Reproduces `matcher.unique` from Go's `testing` package: the first occurrence
    of a name is reported bare, and every later occurrence is suffixed with its
    zero-padded, two-digit occurrence number.

        kubelet.get.nodes          <- occurrence 0
        kubelet.get.nodes#01       <- occurrence 1

    This is not cosmetic. 35 of the 620 ids carry a suffix because the object
    component of a name omits the subresource and the API group, so `nodes` and
    `nodes/status` collide by design. Without the suffix those 35 ids would be
    duplicates, `@pytest.mark.parametrize` would silently disambiguate them with
    its own scheme, and the parity contract could not line the suite up
    620-for-620 against the recorded baseline.

    Args:
        base_name: The `user.verb.object` name.
        occurrence: How many earlier cases shared it; 0 for the first.

    Returns:
        The unique case id.

    Raises:
        ValueError: If `occurrence` is negative.
    """
    if occurrence < 0:
        raise ValueError(f"occurrence must not be negative, got {occurrence}")
    if occurrence == 0:
        return base_name
    return f"{base_name}{_DUPLICATE_ID_SEPARATOR}{occurrence:02d}"


@cache
def expand() -> tuple[AuditPolicyCase, ...]:
    """Expand `INVOCATIONS` into the 620 expected cases, in the Go suite's order.

    Pure and total: it reads only this module's own frozen data, performs no I/O,
    and returns the same tuple of the same immutable records on every call.
    Memoised with `functools.cache`, so the expansion happens at most once per
    interpreter and every caller shares one object - which is what makes it safe
    for a session-scoped fixture to hand out and for parallel workers to hold.

    The iteration order reproduces the two Go helpers exactly, and the order IS
    part of the contract:

    * invocations in Go source order;
    * within each, principals (outermost), then verbs, then targets (innermost);
    * ids de-duplicated in that order, so which occurrence of a repeated name
      receives `#01` is fixed.

    Returns:
        The 620 cases. Compare `len(...)` against `TOTAL_CASE_COUNT` rather than
        against a literal, and the ids against the baseline manifest.
    """
    cases: list[AuditPolicyCase] = []
    # Occurrences seen so far per base name, which is how the `#NN` suffix is
    # assigned. A plain dict, because insertion order is irrelevant here - only
    # the counts are - and lookups happen in expansion order.
    seen: dict[str, int] = {}

    for invocation_index, invocation in enumerate(INVOCATIONS):
        is_resource = invocation.kind is InvocationKind.RESOURCE
        for principal in invocation.principals:
            for verb in invocation.verbs:
                for target in invocation.targets:
                    # The two branches are kept explicit, and each asserts the
                    # target type it expects, so a row whose `kind` disagrees with
                    # its payload can never quietly produce a case of the wrong
                    # shape. `Invocation.__post_init__` already rules this out for
                    # the table below; these guards keep `expand()` correct for any
                    # row a consumer builds itself.
                    selector: ResourceSelector | None
                    if is_resource:
                        if not isinstance(target, ResourceSelector):
                            raise TypeError(
                                f"invocation from audit_policy_test.go L{invocation.go_line} "
                                f"is a resource invocation but carries the target {target!r}"
                            )
                        selector = target
                        path = ""
                        target_name = target.audit_name
                        api_version = API_VERSION
                    else:
                        if not isinstance(target, str):
                            raise TypeError(
                                f"invocation from audit_policy_test.go L{invocation.go_line} "
                                f"is a non-resource invocation but carries the target "
                                f"{target!r}"
                            )
                        selector = None
                        path = target
                        target_name = target
                        # `testNonResources` builds attributes with no APIVersion,
                        # so the zero value is reproduced rather than "v1".
                        api_version = ""

                    base_name = f"{principal.name}.{verb}.{target_name}"
                    occurrence = seen.get(base_name, 0)
                    seen[base_name] = occurrence + 1
                    cases.append(
                        AuditPolicyCase(
                            id=_case_id(base_name, occurrence),
                            base_name=base_name,
                            occurrence=occurrence,
                            level=invocation.level,
                            principal=principal,
                            verb=verb,
                            selector=selector,
                            path=path,
                            resource_request=is_resource,
                            api_version=api_version,
                            go_line=invocation.go_line,
                            invocation_index=invocation_index,
                        )
                    )

    return tuple(cases)


@cache
def resource_cases() -> tuple[AuditPolicyCase, ...]:
    """The 340 resource cases, in expansion order.

    Returns:
        Every case with `resource_request` true. Compare `len(...)` against
        `RESOURCE_CASE_COUNT`.
    """
    return tuple(case for case in expand() if case.resource_request)


@cache
def non_resource_cases() -> tuple[AuditPolicyCase, ...]:
    """The 280 non-resource cases, in expansion order.

    Returns:
        Every case with `resource_request` false. Compare `len(...)` against
        `NON_RESOURCE_CASE_COUNT`.
    """
    return tuple(case for case in expand() if not case.resource_request)


@cache
def case_ids() -> tuple[str, ...]:
    """Every case id, in expansion order - the parity key sequence.

    This tuple is what a Go run of `TestCreateMasterAuditPolicy` prints as its
    `=== RUN` subtest names, in the same order, and what
    `tests/parity/baseline/go_baseline.json` records verdicts against. Comparing
    it element for element against the baseline is the strongest available check
    that this port kept all 620 behaviours and lost none.

    Returns:
        620 unique ids.
    """
    return tuple(case.id for case in expand())


@cache
def cases_by_invocation() -> tuple[tuple[AuditPolicyCase, ...], ...]:
    """The cases grouped by their invocation, aligned with `INVOCATIONS`.

    Element i holds the cases produced by `INVOCATIONS[i]`, in expansion order, so
    a consumer can assert per-invocation counts and per-invocation levels without
    re-deriving the grouping - and so a level that is correct in aggregate but
    attributed to the wrong Go line is still caught.

    Returns:
        29 tuples, one per invocation, together holding all 620 cases.
    """
    grouped: list[list[AuditPolicyCase]] = [[] for _ in INVOCATIONS]
    for case in expand():
        grouped[case.invocation_index].append(case)
    return tuple(tuple(group) for group in grouped)


# ---------------------------------------------------------------------------
# The measured counts
#
# LITERALS, NOT DERIVED VALUES, AND DELIBERATELY SO. Each is what the Go suite
# reports, so `len(expand()) == TOTAL_CASE_COUNT` compares this port against the
# oracle. Writing `TOTAL_CASE_COUNT = len(expand())` would turn every such
# assertion into a tautology that accepts any transcription error, and would also
# force the expansion to run at import time.
#
# Provenance, from a run rather than from prose (AAP §0.11.1, "Evidence over
# assumption"):
#
#   $ go test -count=1 -v -run TestCreateMasterAuditPolicy ./cluster/gce/gci/
#   $ ... | grep -c '^=== RUN   TestCreateMasterAuditPolicy/'      -> 620
#   $ ... | grep -c '#'                                            ->  35
#   $ ... | sed 's/#[0-9][0-9]*$//' | sort -u | wc -l              -> 585
#   $ ... | sort | uniq -d | wc -l                                 ->   0
# ---------------------------------------------------------------------------

# Every case the matrix expects: the number this port must reproduce exactly.
TOTAL_CASE_COUNT: Final[int] = 620

# Resource requests, from the 27 `at.testResources` invocations.
RESOURCE_CASE_COUNT: Final[int] = 340

# Non-resource requests: 2 invocations x 14 principals x 2 verbs x 5 paths.
NON_RESOURCE_CASE_COUNT: Final[int] = 280

# Distinct `user.verb.object` names before de-duplication. 585 + 35 == 620, and
# 620 - 585 == 35 duplicate instances spread over 34 repeated names - one name,
# `system:apiserver.get.namespaces`, occurs three times and so contributes two.
UNIQUE_BASE_NAME_COUNT: Final[int] = 585

# Ids carrying a `#NN` suffix, i.e. cases whose `occurrence` is non-zero.
DUPLICATE_SUFFIXED_ID_COUNT: Final[int] = 35

# Shape of the invocation table. 29 and 27, measured with
# `grep -c 'at\.test'` and `grep -c 'at\.testResources'`; the plan's prose says 30
# and 28, and the code is authoritative.
INVOCATION_COUNT: Final[int] = 29
RESOURCE_INVOCATION_COUNT: Final[int] = 27
NON_RESOURCE_INVOCATION_COUNT: Final[int] = 2

# Shape of the vocabulary: 14 principals, 23 selectors, 10 non-resource paths.
PRINCIPAL_COUNT: Final[int] = 14
SELECTOR_COUNT: Final[int] = 23
NON_RESOURCE_PATH_COUNT: Final[int] = 10
