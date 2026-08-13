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

"""The V6 audit-policy generator, proved case by case: 620 evaluated levels.

The port of ``TestCreateMasterAuditPolicy``
(cluster/gce/gci/audit_policy_test.go L49-184), which is 620 of the 648 cases the
``cluster/gce/gci`` package reports and therefore the single largest block of the
Go suite this migration has to reproduce.

AAP §0.4.2.1 (the L1 shell-boundary blueprint that owns this matrix) / §0.5.1 and
§0.5.2.1 (this file's transformation-map row) / §0.10.2 (the boundary conditions
that must port unchanged) / §0.7.1.3 (100% line and branch on security-invariant
decision logic) - tech-spec §6.6.1.1, which records the property this whole tier
exists to preserve: the test "proves the shipped shell generator, not a
re-implementation".

INVARIANT LOCKED BY THIS MODULE: **F-006-RQ-001** - the audit policy that
``create-master-audit-policy`` (cluster/gce/gci/configure-helper.sh) generates
assigns the intended audit level to every ``(principal, verb, resource-or-path)``
request the Go suite exercises, and above all holds the V6 sensitive-resource
boundary. That boundary is stated here as the COMPLETE PARTITION rather than as a
headline, because the headline has two exceptions and a statement that omits them
cannot be asserted exhaustively:

* ``secrets`` at EXACTLY ``Request`` in all 17 of its cases, and
  ``serviceaccounts/token`` at EXACTLY ``Request`` in both of its own - no
  exceptions;
* ``tokenreviews`` at EXACTLY ``Metadata`` in all 12 - no exceptions;
* ``configmaps`` at EXACTLY ``Metadata``, EXCEPT the exactly-three
  ``(principal, verb, namespace)`` triples of the reviewed kube-system
  high-volume-polling exemption, which are ``None``
  (``apc.KUBE_SYSTEM_CONFIGMAP_EXEMPTIONS``, Go L135 and L158). AAP §0.4.2.1
  itself scopes the requirement as "configmaps(**default**) ... MUST be metadata";
* ``clusterroles`` at EXACTLY ``RequestResponse`` under every mutating verb - AAP
  §0.10.2's boundary - and EXACTLY ``Request`` under ``get``/``list``/``watch``,
  which the generated policy lowers one rule earlier because read responses can be
  large (Go L180 versus L181);
* and every rule above ``None`` omitting the ``RequestReceived`` stage.

Both exception sets are held as data and asserted for EQUALITY, so neither can
widen a case at a time while a prose note keeps describing the original shape.

WHAT THE GO TEST ACTUALLY ASSERTS, AND WHY THIS MODULE IS NOT A YAML TEST

The Go test never inspects the generated YAML's shape. It loads the policy with
``auditpolicy.LoadPolicyFromFile``, builds ``auditpolicy.NewPolicyRuleEvaluator``
and asks that evaluator, 620 times, what level a request would be recorded at.
The assertions are therefore about EVALUATED OUTCOMES, which is a far stronger
statement than "the file contains the text ``secrets``": it holds the whole
ordered first-match rule list accountable, including which earlier rule
intercepts a request before the one a reader would expect.

EXACTLY WHAT THE PARITY CLAIM COVERS, AND WHAT IT DOES NOT

Stated precisely, because a ported evaluator invites a broader reading than the
evidence supports:

* PROVEN, by execution: the policy the SHIPPED generator writes assigns, for each
  of the 620 requests the Go oracle exercises, the same level the Go oracle
  asserts. That is established twice over -- once by :func:`test_audit_level`
  against the ported evaluator, and once by
  :func:`test_the_go_oracle_recorded_the_same_620_verdicts`, which reads the
  verdicts the PRODUCTION Go evaluator actually produced out of the committed
  baseline manifest and requires a one-for-one identity match with a recorded
  ``pass``. Because both sides are compared against the SAME expectation table in
  ``tests.fixtures.audit_policy_cases``, the two evaluators agreeing with that
  table is the two evaluators agreeing with each other -- on these 620 inputs.
* PROVEN, by construction: a document this loader accepts is a document
  kube-apiserver would accept, because :func:`validate_policy` reproduces every
  rule of ``validation.ValidatePolicy`` and aggregates its findings as
  ``ErrorList.ToAggregate`` does.
* NOT CLAIMED: that :class:`PolicyRuleEvaluator` is behaviourally identical to
  ``auditpolicy.NewPolicyRuleEvaluator`` on inputs OUTSIDE this matrix. The
  synthetic-policy cases further down widen the covered surface deliberately --
  wildcards, ``resourceNames``, stage unions, first-match ordering, non-resource
  paths -- but they are this module's own expectations, not the oracle's, so they
  are evidence about the port's internal consistency rather than about
  equivalence. Anything asserted about an input the Go suite does not exercise is
  a statement about this module.

The Kubernetes Python client publishes no audit-policy evaluator, so this module
contains one. That is the single deliberate exception to AAP §0.11.1 B4 ("respect
the freeze"), and it is narrow and explicit:

* ``create-master-audit-policy`` is Bash and stays Bash. It is INVOKED through a
  subprocess against the shipped ``configure-helper.sh`` and the shipped
  ``testdata/kube-apiserver/base.template``, never reimplemented, never edited.
* :func:`load_policy_from_file` is a port of
  staging/src/k8s.io/apiserver/pkg/audit/policy/reader.go.
* :class:`PolicyRuleEvaluator` is a port of
  staging/src/k8s.io/apiserver/pkg/audit/policy/checker.go.

Both ports live HERE, in the one module that consumes them, because the Python
tier's file inventory is fixed by AAP §0.5.1 and this workstream may not add a
file it does not name.

WHY THE EXPECTATIONS ARE IMPORTED AND NOT RESTATED

Every principal, selector, path, level and expected outcome comes from
``tests.fixtures.audit_policy_cases``, which AAP §0.5.5 makes the single
definition shared with the L2 integration tier
(``tests/integration/test_audit_sensitive_resources.py``). Restating any of it
here would let the two tiers drift apart while both stayed green. This module
therefore owns the MECHANISM - generate, load, evaluate - and owns no
expectation.

That module's ``case_ids()`` is also the parity key. Measured in this checkout
rather than assumed (AAP §0.11.1 B2)::

    $ go test -count=1 -run TestCreateMasterAuditPolicy -v ./cluster/gce/gci/
    ... 620 '=== RUN' subtests, ok, 0 failures
    $ ... | sed 's#^=== RUN   TestCreateMasterAuditPolicy/##' > go_names.txt
    # compared element for element against tuple(apc.case_ids()): EQUAL,
    # 620 names in the same order, including all 35 '#NN' suffixes.

:func:`test_audit_level` is parametrized with exactly those ids, so its 620 node
ids line up one-for-one with the Go subtest names recorded in
tests/parity/baseline/go_baseline.json and the not-yet-written
``parity_map.py`` needs no translation table for them.

THREE MEASURED BEHAVIOURS THAT EACH LOOK LIKE A BUG

1. ``base.template`` RENDERED AS ITS OWN TARGET IS A FRAGMENT. Go's
   ``ParseFiles`` names each file's template after its base filename and removes
   the ``{{define}}`` bodies from it, so rendering ``base.template`` as the
   target yields only the stray ``}`` that follows its ``{{end}}``. Sourcing that
   makes bash print ``syntax error near unexpected token `}'`` and ``source``
   alone return 2 - yet the outer ``bash -c`` returns 0, because
   ``mustInvokeFunc`` joins its clauses with ``;`` and ``;`` composition yields
   the LAST command's status. Re-measured here: exit 0, and the generator still
   wrote a valid 187-line, 18-rule policy. So success is judged on the FINAL
   command's status, and that stderr noise is never filtered, asserted on, or
   "fixed". It is also exactly why ``create-master-audit-policy`` is a safe
   caller for a fragment environment: it takes its output path as ``$1`` and
   reads no environment variable at all.

2. ``PyYAML RESOLVES level: None TO THE STRING 'None'``. YAML 1.1 null resolution
   accepts ``null``, ``Null``, ``NULL``, ``~`` and empty - but not ``None``.
   Re-measured here with the pinned PyYAML 6.0.3::

       level: None -> 'None' (str)      level: null -> None
       level: Null -> None              level: ~    -> None

   The ten ``level: None`` rules the generator emits therefore arrive as the
   string ``'None'``, which IS the wire spelling of ``audit.LevelNone``, and
   :data:`VALID_LEVELS` accepts it verbatim. Nothing is coerced, normalised or
   defaulted: a genuine YAML ``null`` is not a string and
   :func:`_require_level` rejects it loudly, because silently mapping a falsy
   level to a default would turn every ``level: None`` rule into a non-match and
   quietly reclassify a tenth of the policy.

3. THE ``omitStages`` ASSERTION IS CONDITIONAL, AND THE CONDITION IS THE
   EVALUATED LEVEL. ``expectLevel`` (L257-261) asserts the level, then asserts
   ``OmitStages`` only ``if auditConfig.Level != audit.LevelNone``. Measured
   shape of the shipped policy: ten rules are ``level: None`` and carry NO
   ``omitStages``, eight are above ``None`` and EVERY one carries
   ``omitStages: ["RequestReceived"]``, and there is no policy-level
   ``omitStages`` key. An unconditional check would fail on the ``None`` rules,
   and a check conditioned on the EXPECTED level would test something the
   oracle does not - so :func:`test_audit_level` conditions on what the
   evaluator returned, exactly as Go does.

ASSERTION SEMANTICS, PRESERVED RATHER THAN COLLAPSED (AAP §0.4.1.2, §0.11.1 B7)

The Go original is deliberately asymmetric and this port keeps the asymmetry:

============================================  ==============  ==================
Go                                            Semantics       Here
============================================  ==============  ==================
L51 ``require.NoError`` (temp dir)            abort           fixture raises
L70 ``require.NoError`` (policy load)         abort           loader raises
L207-209 ``require.NotEmpty`` x3              abort           bare ``assert``
L258 ``assert.Equal`` (level)                 record+continue ``subtests.test``
L260 ``assert.ElementsMatch`` (omitStages)    record+continue ``subtests.test``
============================================  ==============  ==================

Setup breakage must stop the run, because a policy that failed to generate makes
620 findings meaningless. A per-case finding must NOT stop it, because the value
of a 620-case security matrix is seeing every offending case in one run. Each of
the two per-case checks gets its own ``with subtests.test(...)`` block, so a case
whose level is right and whose ``omitStages`` is wrong reports the second
failure rather than being masked by the first passing.

``assert.ElementsMatch`` ignores order, and it has to: Go builds each rule's
unioned stage list from a map, whose iteration order is unspecified. This port
returns a deterministic union but still compares order-insensitively, so the
comparison stays a faithful statement of the contract rather than of an
implementation detail.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

* It needs no etcd and no API server, and starts neither, so
  ``pytest -m "not integration"`` runs all of it.
* It writes nothing under ``cluster/`` and copies no shipped artifact into
  ``python/``. ``base.template`` is read in place; a copy would drift from the
  file this repository ships while both kept passing.
* It contains no key material of any kind, and needs none.
* It asserts no external standards control identifier. The repository enumerates
  none (AAP §0.11.1 B11), so every failure message names the repository's own
  requirement id, :data:`REQUIREMENT_ID`.
* It does not assert the generated policy's LINE COUNT. 187 lines is a measured
  fact about comments and formatting, not a behaviour, and pinning it would fail
  the suite for an edit that changes nothing this control depends on. The rule
  count, which IS structural, is asserted.
"""

from __future__ import annotations

import collections
import functools
import itertools
import json
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final

import pytest
import yaml

from tests.fixtures import audit_policy_cases as apc
from tests.helpers.manifest import ManifestHarnessError

# The tier's harness, whose public API is declared in
# tests/unit/shell/conftest.py's ``__all__``. THE GENERATION LIVES THERE, NOT
# HERE: AAP §0.4.4.1 and §0.9.2 put fixtures in conftest.py and never inline in a
# test module, so ``generated_audit_policy`` -- the module-scoped fixture that runs
# the shipped bash once and hands back the bytes it wrote -- is that file's, and
# this module imports only the value type it yields, the constants it is keyed to,
# and the read-or-raise guard whose own two branches are exercised below.
from tests.unit.shell.conftest import (
    AUDIT_POLICY_FILE_NAME as _conftest_AUDIT_POLICY_FILE_NAME,
)
from tests.unit.shell.conftest import (
    AUDIT_POLICY_FUNC_NAME as _conftest_AUDIT_POLICY_FUNC_NAME,
)
from tests.unit.shell.conftest import (
    GeneratedShellPolicy,
    require_generated_policy_text,
)

# L1 shell-boundary tier: this module invokes the shipped bash generator through
# a subprocess. The marker vocabulary is declared once in python/pyproject.toml
# (integration, shell, config, parity, slow) and ``--strict-markers`` makes any
# other name a collection ERROR, so this is a contract with that file rather than
# a free-form label. Declared explicitly because tests/conftest.py's
# ``pytest_collection_modifyitems`` applies only the ``integration`` marker, and
# only to modules under tests/integration/.
pytestmark = pytest.mark.shell


# ---------------------------------------------------------------------------
# The shipped generator: what is invoked, and with what
# ---------------------------------------------------------------------------

#: The shell function under test, declared at cluster/gce/gci/configure-helper.sh
#: L1156. Imported from the tier conftest rather than restated: the fixture that
#: invokes it lives there (AAP §0.4.4.1 puts fixtures in conftest.py), so the
#: function name, the output filename and the render target have exactly one
#: definition and a rename cannot leave this module naming a stale one.
AUDIT_POLICY_FUNC_NAME: Final[str] = _conftest_AUDIT_POLICY_FUNC_NAME

#: The file the generator is asked to write, named as Go names it
#: (audit_policy_test.go L53). It is a path the function is GIVEN, not a location
#: it derives, so nothing outside the test's own temporary tree is ever touched.
AUDIT_POLICY_FILE_NAME: Final[str] = _conftest_AUDIT_POLICY_FILE_NAME

#: Rules the shipped generator emits. Measured in this checkout, and structural
#: rather than cosmetic: the policy is an ORDERED first-match list, so a lost or
#: inserted rule changes which rule intercepts a request.
GENERATED_RULE_COUNT: Final[int] = 18

#: The repository's own requirement identifier for the V6 audit-fidelity control,
#: quoted in every failure message so a CI failure reads as a requirement
#: violation rather than a value mismatch (AAP §0.7.2).
REQUIREMENT_ID: Final[str] = "F-006-RQ-001"


# ---------------------------------------------------------------------------
# reader.go: the accepted policy envelope
# ---------------------------------------------------------------------------

#: The only group/version ``LoadPolicyFromBytes`` accepts. Go expresses this as
#: ``apiGroupVersionSet`` built from ``auditv1.SchemeGroupVersion`` and reports
#: "unknown group version field %v in policy" for anything else (reader.go
#: L33-38, L85-88).
POLICY_API_VERSION: Final[str] = "audit.k8s.io/v1"

#: The only kind. Go enforces it through the decoder's target type; this port
#: checks it explicitly, because ``yaml.safe_load`` has no scheme to consult.
POLICY_KIND: Final[str] = "Policy"

#: The four levels, in the wire spelling, taken from the SINGLE definition in
#: tests.fixtures.audit_policy_cases so this module cannot disagree with the
#: expectations it is checking. They are exactly Go's ``validLevels``
#: (staging/src/k8s.io/apiserver/pkg/apis/audit/validation/validation.go L54-59):
#: ``None``, ``Metadata``, ``Request``, ``RequestResponse``.
VALID_LEVELS: Final[frozenset[str]] = frozenset(apc.LEVEL_WIRE_STRINGS)

#: Go's ``validOmitStages`` (validation.go L61-66), whose members are declared at
#: staging/src/k8s.io/apiserver/pkg/apis/audit/types.go L65-73. Restated here
#: because only ``RequestReceived`` is part of the V6 expectation vocabulary and
#: therefore only that one is published by the fixtures module; the other three
#: are needed to VALIDATE a policy, not to assert one.
VALID_OMIT_STAGES: Final[frozenset[str]] = frozenset(
    {
        apc.AUDIT_STAGE_REQUEST_RECEIVED,
        "ResponseStarted",
        "ResponseComplete",
        "Panic",
    }
)

#: The level a request is recorded at when NO rule matches: Go's
#: ``DefaultAuditLevel = audit.LevelNone`` (checker.go L27-30). Read from the
#: fixtures module's enum rather than written as a literal.
DEFAULT_AUDIT_LEVEL: Final[str] = apc.AuditLevel.NONE.wire


# ---------------------------------------------------------------------------
# The 620 cases, expanded once at import
# ---------------------------------------------------------------------------
# Module level and evaluated once, not rebuilt per case: ``expand()`` is
# memoised and returns frozen records, so 620 parametrized items and every
# auxiliary test below share one object. Kept as module constants rather than
# inlined into the decorator so that the shape assertions in
# :func:`test_case_matrix_shape_matches_the_oracle` check the very tuple the
# parametrization uses.

_CASES: Final[tuple[apc.AuditPolicyCase, ...]] = apc.expand()

#: The Go subtest names, in the Go suite's order, including ``#NN`` occurrence
#: suffixes. THE PARITY KEY - see the module docstring for the measured
#: element-for-element comparison against a live ``go test -v`` run.
_CASE_IDS: Final[tuple[str, ...]] = apc.case_ids()


# ---------------------------------------------------------------------------
# The policy, as data
#
# Ported from staging/src/k8s.io/apiserver/pkg/apis/audit/types.go: ``Policy``,
# ``PolicyRule`` and ``GroupResources``. Only the fields the evaluator reads are
# modelled, because a field this module carried but never consulted would suggest
# a check that is not happening.
#
# Every record is frozen with slots. Not tidiness: ONE policy is generated per
# module and shared by 620 parametrized items plus every auxiliary test, so a
# mutable rule would make one case able to reclassify another's request - the
# structural isolation AAP §0.7.2 requires of a suite that must pass under
# ``pytest-randomly`` and ``pytest-xdist -n auto``. Absent list fields are the
# EMPTY TUPLE, which is exactly Go's ``nil`` slice for every purpose the
# evaluator has: ``len(...) > 0`` is false for both.
# ---------------------------------------------------------------------------


class AuditPolicyError(AssertionError):
    """A generated audit policy could not be loaded, or is not a valid policy.

    Subclasses ``AssertionError`` for the same reason
    ``tests.helpers.bash.BashInvocationError`` does: one raise then carries
    either of Go's postures depending on how the caller wrote the call. Raised
    from a fixture it aborts every dependent case, which is ``require.NoError``
    at audit_policy_test.go L70; raised inside ``with subtests.test(...)`` it
    would be recorded and the loop would continue.

    It is raised, never returned. Go's loader returns an ``error`` that L70
    turns into a fatal; a Python loader that returned a sentinel could be
    ignored by a caller, and a silently ignored policy-load failure is the one
    failure mode that would make all 620 findings meaningless.
    """


@dataclass(frozen=True, slots=True)
class GroupResources:
    """One entry of a rule's ``resources`` list. Go: ``audit.GroupResources``.

    Attributes:
        group: The API group this entry selects. ``""`` IS MEANINGFUL and denotes
            the core group; it is not "unset". Matched by exact equality against
            the request's API group (checker.go L194).
        resources: The ``resource`` or ``resource/subresource`` spellings this
            entry selects. EMPTY MEANS EVERY RESOURCE IN THE GROUP - checker.go
            L195-197 returns a match immediately - which is how the generator's
            two "known APIs" rules cover eighteen groups without naming a single
            resource.
        resource_names: Object names this entry is narrowed to. Empty means every
            name (checker.go L199).
    """

    group: str
    resources: tuple[str, ...] = ()
    resource_names: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PolicyRule:
    """One rule of the ordered policy list. Go: ``audit.PolicyRule``.

    Attributes:
        level: The level a matching request is recorded at, in the WIRE spelling
            - ``None``, ``Metadata``, ``Request`` or ``RequestResponse``. A
            string and not an enum member, deliberately: this is what the policy
            file carries, and keeping it as read means the string ``'None'`` that
            PyYAML produces for ``level: None`` is never quietly reinterpreted.
        users: Usernames the rule selects. Empty means every user.
        user_groups: Groups the rule selects; a request matches if ANY of its
            groups is listed. Empty means every group.
        verbs: Verbs the rule selects. Empty means every verb.
        namespaces: Namespaces the rule selects, where a cluster-scoped request
            presents the EMPTY STRING (checker.go L174). Empty means every
            namespace.
        resources: Resource selectors; see :class:`GroupResources`.
        non_resource_urls: Path specifications for non-resource requests.
        omit_stages: Stages not to emit an event for. After the evaluator is
            constructed this holds the UNION of the policy-level list and the
            rule's own (checker.go L34-36).
        omit_managed_fields: Rule-level override of the policy default;
            ``None`` means "not specified", which is Go's nil pointer
            (checker.go L86-92).
    """

    level: str
    users: tuple[str, ...] = ()
    user_groups: tuple[str, ...] = ()
    verbs: tuple[str, ...] = ()
    namespaces: tuple[str, ...] = ()
    resources: tuple[GroupResources, ...] = ()
    non_resource_urls: tuple[str, ...] = ()
    omit_stages: tuple[str, ...] = ()
    omit_managed_fields: bool | None = None


@dataclass(frozen=True, slots=True)
class AuditPolicy:
    """A loaded audit policy. Go: ``audit.Policy``.

    Attributes:
        rules: The rules IN FILE ORDER. Order is the whole semantics of the
            document: evaluation is ordered first-match, so a rule's position
            decides which requests ever reach the rules below it.
        omit_stages: The policy-level stage list, unioned into every rule at
            evaluator construction and returned unchanged when no rule matches.
        omit_managed_fields: The policy-level default.
    """

    rules: tuple[PolicyRule, ...]
    omit_stages: tuple[str, ...] = ()
    omit_managed_fields: bool = False


@dataclass(frozen=True, slots=True)
class RequestAttributes:
    """The request a policy is evaluated against. Go: ``authorizer.Attributes``.

    Only the accessors ``ruleMatches`` and its two helpers call are modelled:
    ``GetUser().GetName()``, ``GetUser().GetGroups()``, ``GetVerb()``,
    ``IsResourceRequest()``, ``GetNamespace()``, ``GetAPIGroup()``,
    ``GetResource()``, ``GetSubresource()``, ``GetName()`` and ``GetPath()``.

    Every field defaults to the Go zero value so a synthetic request states only
    what it is about, and ``api_version`` is carried for fidelity with the Go
    harness - which sets ``APIVersion: "v1"`` on resource requests (L219) and
    leaves it empty on non-resource ones - even though no rule matches on it.

    Attributes:
        user: The username, or ``None`` for a request that carries no user at
            all. ``None`` is modelled because Go checks ``user == nil``
            explicitly (checker.go L98, L103) and those two branches are part of
            the decision logic AAP §0.7.1.3 requires be fully covered.
        groups: The user's groups.
        verb: The verb, lower case, as a policy spells it.
        namespace: The namespace, or ``""`` for a cluster-scoped request.
        api_group: The API group, or ``""`` for the core group.
        api_version: The API version. Carried, never matched on.
        resource: The resource kind.
        subresource: The subresource, or ``""``.
        name: The object name. The Go harness never sets it, so every ported
            case presents ``""``; it is modelled because ``resourceNames``
            matching reads it.
        resource_request: Whether this is a resource request. Decides which of
            the two matchers can succeed.
        path: The request path, for a non-resource request.
    """

    user: str | None = None
    groups: tuple[str, ...] = ()
    verb: str = ""
    namespace: str = ""
    api_group: str = ""
    api_version: str = ""
    resource: str = ""
    subresource: str = ""
    name: str = ""
    resource_request: bool = False
    path: str = ""


@dataclass(frozen=True, slots=True)
class RequestAuditConfig:
    """What the evaluator decided. Go: ``auditinternal.RequestAuditConfig``.

    Attributes:
        level: The level, in the wire spelling.
        omit_stages: The stages not to emit, order-insensitive by contract -
            Go's assertion is ``ElementsMatch`` because it builds this from a
            map.
        omit_managed_fields: Whether managed fields are stripped from logged
            bodies. Ported for completeness of ``EvaluatePolicyRule``; the Go
            test does not assert it, and neither does :func:`test_audit_level`.
    """

    level: str
    omit_stages: tuple[str, ...] = ()
    omit_managed_fields: bool = False


# ---------------------------------------------------------------------------
# reader.go: load a generated policy, and fail loudly on anything else
# ---------------------------------------------------------------------------
# The port of ``LoadPolicyFromFile`` / ``LoadPolicyFromBytes``
# (staging/src/k8s.io/apiserver/pkg/audit/policy/reader.go L46-101) together with
# ``validation.ValidatePolicy``
# (staging/src/k8s.io/apiserver/pkg/apis/audit/validation/validation.go L28-133)
# IN FULL - every branch of it, not a subset.
#
# WHAT IS PORTED. All of it. Go decodes through a scheme, strictly and then
# leniently, then calls ``validation.ValidatePolicy`` and returns
# ``err.ToAggregate()``. This port uses ``yaml.safe_load`` - there is no scheme to
# consult - and then :func:`validate_policy`, which reproduces every rule of
# ``ValidatePolicy`` (staging/src/k8s.io/apiserver/pkg/apis/audit/validation/
# validation.go) and AGGREGATES its findings exactly as ``ErrorList.ToAggregate``
# does, so a policy with three problems reports three rather than one.
#
# The aggregation is not cosmetic. The whole claim this module makes is that the
# 620 outcomes below are the outcomes the API SERVER would produce, and a loader
# that accepted a document kube-apiserver refuses to load would evaluate a policy
# that never ships - a green suite over a control plane that will not boot. The
# constraints most easily lost are exactly the ones a generated document is most
# likely to break: a ``nonResourceURLs`` entry that stops beginning with ``/``,
# a wildcard that stops being the final character, a rule that acquires both
# ``nonResourceURLs`` and ``resources``, a group name written as
# ``rbac.authorization.k8s.io/v1beta1`` instead of ``rbac.authorization.k8s.io``,
# and a ``resourceNames`` narrowing with no ``resources`` to narrow.
#
# TYPE checks stay where they are - in the readers below - and raise on the first
# problem, because Go's DECODER also stops at the first structural failure; a
# document whose ``verbs`` is a mapping never reaches ``ValidatePolicy`` in Go
# either. VALUE checks are what aggregate.
#
# ORDER OF CHECKS mirrors Go's: envelope, then the policy-level fields, then the
# rules' types, then ``ValidatePolicy`` over the whole decoded policy, and only
# then the "0 rules" refusal - reader.go L88-96 in that order, which is why an
# empty ``rules: []`` reports Go's own message rather than a field error.


def _require_mapping(value: object, *, where: str) -> Mapping[str, object]:
    """Return ``value`` as a mapping, or raise naming ``where``.

    Raises:
        AuditPolicyError: if ``value`` is not a mapping. A YAML document that
            decoded to a list or a scalar is not a policy, and proceeding would
            report a missing ``apiVersion`` for something that was never an
            envelope.
    """
    __tracebackhide__ = True
    if not isinstance(value, dict):
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {where} must be a mapping, got "
            f"{type(value).__name__} ({value!r})"
        )
    return value


def _require_string_list(value: object, *, where: str) -> tuple[str, ...]:
    """Return an optional YAML string list as a tuple, or raise naming ``where``.

    An absent key is the empty tuple, which is Go's ``nil`` slice: every check in
    ``ruleMatches`` asks ``len(...) > 0``, so absent and empty behave alike. A
    key that is PRESENT but not a list of strings is a defect and is refused
    rather than coerced.

    Raises:
        AuditPolicyError: if ``value`` is neither absent nor a list of strings.
    """
    __tracebackhide__ = True
    if value is None:
        return ()
    if not isinstance(value, list):
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {where} must be a list of strings, got "
            f"{type(value).__name__} ({value!r})"
        )
    items: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str):
            raise AuditPolicyError(
                f"{REQUIREMENT_ID}: {where}[{index}] must be a string, got "
                f"{type(item).__name__} ({item!r})"
            )
        items.append(item)
    return tuple(items)


def _require_level(value: object, *, where: str) -> str:
    """Return a rule's level verbatim, or raise naming ``where``.

    THE ``level: None`` HAZARD LIVES HERE, and it is handled by doing nothing
    clever. PyYAML resolves ``level: None`` to the STRING ``'None'``, which is
    the wire spelling of ``audit.LevelNone`` and a member of
    :data:`VALID_LEVELS`, so it is returned unchanged. A genuine YAML ``null``
    - ``null``, ``Null``, ``NULL``, ``~`` or an empty value - decodes to Python
    ``None``, is not a string, and is refused. Mapping it to a default instead
    would silently turn a rule that drops events into a rule that matches
    nothing.

    Raises:
        AuditPolicyError: if the level is absent, is not a string, or is not one
            of the four valid levels. Go reports the same two conditions as
            ``Required`` and ``NotSupported`` (validation.go L68-77).
    """
    __tracebackhide__ = True
    if not isinstance(value, str):
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {where} is required and must be one of "
            f"{sorted(VALID_LEVELS)}, got {type(value).__name__} ({value!r}). Note that "
            "'level: None' decodes to the STRING 'None', which is valid, while 'level: null' "
            "decodes to Python None, which is not."
        )
    if value not in VALID_LEVELS:
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {where} must be one of {sorted(VALID_LEVELS)}, got {value!r}"
        )
    return value


def _require_omit_stages(value: object, *, where: str) -> tuple[str, ...]:
    """Return an optional stage list, or raise naming ``where``.

    Raises:
        AuditPolicyError: if the value is not a list of strings, or names a stage
            outside Go's ``validOmitStages``. A misspelled stage would silently
            stop omitting the stage it meant to omit, which for
            ``RequestReceived`` means doubling the audit volume of every rule
            above ``None``.
    """
    __tracebackhide__ = True
    stages = _require_string_list(value, where=where)
    for index, stage in enumerate(stages):
        if stage not in VALID_OMIT_STAGES:
            raise AuditPolicyError(
                f"{REQUIREMENT_ID}: {where}[{index}] must be one of "
                f"{sorted(VALID_OMIT_STAGES)}, got {stage!r}"
            )
    return stages


def _require_optional_bool(value: object, *, where: str) -> bool | None:
    """Return an optional boolean, preserving the absent/present distinction.

    ``None`` means the key was absent, which is Go's nil ``*bool`` and the signal
    that the policy-level default applies (checker.go L86-92). It is therefore
    NOT collapsed to ``False``.

    Raises:
        AuditPolicyError: if the value is present and not a boolean.
    """
    __tracebackhide__ = True
    if value is None:
        return None
    if not isinstance(value, bool):
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {where} must be a boolean, got "
            f"{type(value).__name__} ({value!r})"
        )
    return value


def _require_group_resources(value: object, *, where: str) -> tuple[GroupResources, ...]:
    """Return a rule's ``resources`` list, or raise naming ``where``.

    Raises:
        AuditPolicyError: if the value is not a list of mappings, or if an
            entry's ``group`` is not a string.
    """
    __tracebackhide__ = True
    if value is None:
        return ()
    if not isinstance(value, list):
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {where} must be a list of group-resource mappings, got "
            f"{type(value).__name__} ({value!r})"
        )
    entries: list[GroupResources] = []
    for index, item in enumerate(value):
        entry = _require_mapping(item, where=f"{where}[{index}]")
        group = entry.get("group", "")
        if not isinstance(group, str):
            raise AuditPolicyError(
                f"{REQUIREMENT_ID}: {where}[{index}].group must be a string, got "
                f"{type(group).__name__} ({group!r}). The empty string is the core group."
            )
        entries.append(
            GroupResources(
                group=group,
                resources=_require_string_list(
                    entry.get("resources"), where=f"{where}[{index}].resources"
                ),
                resource_names=_require_string_list(
                    entry.get("resourceNames"), where=f"{where}[{index}].resourceNames"
                ),
            )
        )
    return tuple(entries)


# ---------------------------------------------------------------------------
# The DNS-1123 subdomain rule a non-empty API group must satisfy
# ---------------------------------------------------------------------------
# Go reaches this through ``validation.NameIsDNSSubdomain(group, false)``
# (staging/src/k8s.io/apimachinery/pkg/api/validation/generic.go L42-48), which
# with ``prefix=false`` is exactly ``validation.IsDNS1123Subdomain``
# (staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go L196-207).

DNS1123_SUBDOMAIN_MAX_LENGTH: Final[int] = 253
"""Go: ``validation.DNS1123SubdomainMaxLength`` (util/validation/validation.go L191)."""

_DNS1123_LABEL_FMT: Final[str] = "[a-z0-9]([-a-z0-9]*[a-z0-9])?"
"""Go: ``dns1123LabelFmt`` (util/validation/validation.go L155), byte for byte."""

_DNS1123_SUBDOMAIN_FMT: Final[str] = _DNS1123_LABEL_FMT + r"(\." + _DNS1123_LABEL_FMT + ")*"
"""Go: ``dns1123SubdomainFmt`` (util/validation/validation.go L184), byte for byte."""

_DNS1123_SUBDOMAIN_RE: Final[re.Pattern[str]] = re.compile(_DNS1123_SUBDOMAIN_FMT)
"""Compiled once. Matched with :meth:`re.Pattern.fullmatch`, NEVER with ``^...$``.

Go anchors the pattern as ``"^" + fmt + "$"`` and ``$`` there means end of text.
Python's ``$`` also matches just BEFORE a trailing newline, so ``^foo$`` would
accept ``"foo\\n"`` - a group name with a stray newline - where Go refuses it.
``fullmatch`` has Go's semantics exactly, which is why it is used instead.
"""

_DNS1123_SUBDOMAIN_ERROR_MSG: Final[str] = (
    "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, "
    "'-' or '.', and must start and end with an alphanumeric character"
)
"""Go: ``dns1123SubdomainErrorMsg`` (util/validation/validation.go L185)."""


def _name_is_dns_subdomain(value: str) -> tuple[str, ...]:
    """Return Go's messages for ``value``, empty when it is a valid subdomain.

    Go: ``IsDNS1123Subdomain`` (util/validation/validation.go L198-207), which
    appends up to two messages - the length one and the pattern one - and whose
    caller joins them with ``","``.

    THE LENGTH IS MEASURED IN BYTES, not characters, because Go's ``len`` on a
    string counts bytes. The distinction can only matter for a non-ASCII value,
    which fails the pattern either way, so the accept/reject outcome is identical
    in every case; measuring bytes simply keeps the reported message identical
    too.

    Args:
        value: The API group name, known to be non-empty by the caller.

    Returns:
        The messages, in Go's order.
    """
    messages: list[str] = []
    if len(value.encode("utf-8")) > DNS1123_SUBDOMAIN_MAX_LENGTH:
        # Go: MaxLenError (util/validation/validation.go L425-427).
        messages.append(f"must be no more than {DNS1123_SUBDOMAIN_MAX_LENGTH} characters")
    if _DNS1123_SUBDOMAIN_RE.fullmatch(value) is None:
        # Go: RegexError(msg, fmt, "example.com") (util/validation/validation.go
        # L430-443), whose one-example form is reproduced verbatim.
        messages.append(
            f"{_DNS1123_SUBDOMAIN_ERROR_MSG} (e.g. 'example.com', "
            f"regex used for validation is '{_DNS1123_SUBDOMAIN_FMT}')"
        )
    return tuple(messages)


def _require_rule(value: object, *, where: str) -> PolicyRule:
    """Return one policy rule, or raise naming ``where``.

    TYPES ONLY, AND DELIBERATELY SO. This is the DECODER half, and Go's decoder
    stops at the first structural failure - a rule whose ``verbs`` is a mapping
    never reaches ``ValidatePolicy`` there either, so each reader below raises
    rather than collecting. The VALUE checks are Go's ``validatePolicyRule``, they
    run over the whole decoded policy in :func:`validate_policy`, and they
    AGGREGATE, exactly as ``ErrorList.ToAggregate`` does. Applying any of them here
    as well would abort the aggregate at the first offending rule and report one
    finding where Go reports all of them.

    Raises:
        AuditPolicyError: for any malformed field; see the individual readers.
    """
    __tracebackhide__ = True
    rule = _require_mapping(value, where=where)
    policy_rule = PolicyRule(
        level=_require_level(rule.get("level"), where=f"{where}.level"),
        users=_require_string_list(rule.get("users"), where=f"{where}.users"),
        user_groups=_require_string_list(rule.get("userGroups"), where=f"{where}.userGroups"),
        verbs=_require_string_list(rule.get("verbs"), where=f"{where}.verbs"),
        namespaces=_require_string_list(rule.get("namespaces"), where=f"{where}.namespaces"),
        resources=_require_group_resources(rule.get("resources"), where=f"{where}.resources"),
        non_resource_urls=_require_string_list(
            rule.get("nonResourceURLs"), where=f"{where}.nonResourceURLs"
        ),
        omit_stages=_require_omit_stages(rule.get("omitStages"), where=f"{where}.omitStages"),
        omit_managed_fields=_require_optional_bool(
            rule.get("omitManagedFields"), where=f"{where}.omitManagedFields"
        ),
    )
    return policy_rule


def _validate_non_resource_urls(urls: Sequence[str], *, where: str) -> list[str]:
    """Port of ``validateNonResourceURLs`` (validation.go L79-95).

    Three rules, in Go's own order, and the third is the subtle one:

    * a bare ``"*"`` is accepted outright and skipped (L82-84);
    * every other entry must begin with ``/`` (L86-88). Without this a rule
      intended for ``/healthz`` and written ``healthz`` matches nothing, and a
      policy that silently matches nothing is exactly a silent downgrade;
    * a ``*`` may appear ONLY as the final character (L90-92). Go tests
      ``url[:len(url)-1]``, i.e. everything but the last character, so
      ``/api/*/pods`` is rejected while ``/api/*`` is not. The empty string is
      guarded first, because ``url[:len(url)-1]`` on ``""`` would be
      out of range in Go's own reading.

    Returns:
        The findings, as complete sentences, in Go's order.
    """
    findings: list[str] = []
    for index, url in enumerate(urls):
        if url == "*":
            continue
        if not url.startswith("/"):
            findings.append(
                f"{where}[{index}]: {url!r} -- non-resource URL rules must begin with a "
                f"'/' character"
            )
        if url != "" and "*" in url[:-1]:
            findings.append(
                f"{where}[{index}]: {url!r} -- non-resource URL wildcards '*' must be the "
                f"final character of the rule"
            )
    return findings


def _validate_group_resources(
    group_resources: Sequence[GroupResources], *, where: str
) -> list[str]:
    """Port of ``validateResources`` (validation.go L97-118).

    * A NON-EMPTY group must be a valid DNS subdomain. The empty string is the
      core API group and is exempt (L100). Go's own comment names the mistake this
      catches: ``rbac.authorization.k8s.io/v1beta1`` is rejected and
      ``rbac.authorization.k8s.io`` is the valid one - a group name is not a
      GroupVersion, and the generated policy names eighteen groups.
    * ``resourceNames`` with no ``resources`` is rejected (L112-114): a narrowing
      with nothing to narrow selects every resource in the group rather than the
      named objects the author intended, which is a silent WIDENING.

    Note that Go reports both under ``fldPath.Child("group")`` /
    ``Child("resourceNames")`` WITHOUT an index, so two offending entries produce
    two findings on the same path; the index is added here because a reader with
    eighteen entries needs to know which one.
    """
    findings: list[str] = []
    for index, entry in enumerate(group_resources):
        if entry.group:
            # Through :func:`_name_is_dns_subdomain`, which renders Go's own two
            # messages: a SINGLE source for the rule, so the aggregate cannot drift
            # from the message text or from Go's matching semantics. Two properties
            # are load bearing there and are why a local `re.match` is not used:
            # the length is measured in BYTES, as Go's `len` on a string is, and the
            # pattern is applied with `fullmatch`, because Python's `$` also matches
            # just before a trailing newline while Go's does not - so `^...$` with
            # `.match()` would accept a group name ending in "\n" that the API
            # server refuses.
            for message in _name_is_dns_subdomain(entry.group):
                findings.append(
                    f"{where}[{index}].group: {entry.group!r} -- {message} (an API group is "
                    f"a group name such as 'rbac.authorization.k8s.io', never a GroupVersion "
                    f"such as 'rbac.authorization.k8s.io/v1')"
                )
        if entry.resource_names and not entry.resources:
            findings.append(
                f"{where}[{index}].resourceNames: {list(entry.resource_names)!r} -- using "
                f"resourceNames requires at least one resource; without one the entry "
                f"selects EVERY resource in the group instead of the named objects"
            )
    return findings


def _validate_omit_stages(stages: Sequence[str], *, where: str) -> list[str]:
    """Port of ``validateOmitStages`` (validation.go L120-134).

    The type readers already refuse a non-string stage and an unrecognised one,
    so this exists to make the AGGREGATED report complete: a policy whose second
    rule omits a misspelled stage must be reported alongside every other finding
    rather than being the one that happened to raise first.
    """
    return [
        f"{where}[{index}]: {stage!r} -- allowed stages are "
        f"{sorted(VALID_OMIT_STAGES)}"
        for index, stage in enumerate(stages)
        if stage not in VALID_OMIT_STAGES
    ]


def _validate_rule(rule: PolicyRule, *, where: str) -> list[str]:
    """Port of ``validatePolicyRule`` (validation.go L37-52).

    The four field validators, then THE SELECTOR-MIXING RULE (L44-48): a rule with
    ``nonResourceURLs`` may carry neither ``resources`` nor ``namespaces``,
    because "rules cannot apply to both regular resources and non-resource URLs".

    That rule is the one whose absence mattered most here. ``ruleMatches``
    (checker.go) dispatches on ``IsResourceRequest()``: a rule carrying both
    selectors can only ever match through ONE of them, so the other half is dead
    and its author's intent is silently discarded. The generated policy has
    separate resource and non-resource rules precisely to avoid it, and a future
    edit that merged two of them would change which requests are audited while
    every level in the matrix still looked right.
    """
    findings = _validate_level(rule.level, where=f"{where}.level")
    findings += _validate_non_resource_urls(
        rule.non_resource_urls, where=f"{where}.nonResourceURLs"
    )
    findings += _validate_group_resources(rule.resources, where=f"{where}.resources")
    findings += _validate_omit_stages(rule.omit_stages, where=f"{where}.omitStages")

    if rule.non_resource_urls and (rule.resources or rule.namespaces):
        findings.append(
            f"{where}.nonResourceURLs: {list(rule.non_resource_urls)!r} -- rules cannot "
            f"apply to both regular resources and non-resource URLs (this rule also "
            f"declares "
            f"{'resources' if rule.resources else ''}"
            f"{' and ' if rule.resources and rule.namespaces else ''}"
            f"{'namespaces' if rule.namespaces else ''}, and only one of the two selector "
            f"families can ever match a given request)"
        )
    return findings


def _validate_level(level: str, *, where: str) -> list[str]:
    """Port of ``validateLevel`` (validation.go L67-77).

    The type reader has already refused a non-string and an unrecognised level, so
    like :func:`_validate_omit_stages` this exists for completeness of the
    aggregate. Go distinguishes ``Required`` (empty) from ``NotSupported``
    (unknown) and so does this.
    """
    if level == "":
        return [f"{where}: required"]
    if level not in VALID_LEVELS:
        return [f"{where}: {level!r} -- supported values: {sorted(VALID_LEVELS)}"]
    return []


def validate_policy(policy: AuditPolicy) -> None:
    """Port of ``validation.ValidatePolicy`` plus ``ErrorList.ToAggregate``.

    Go collects every finding across the policy-level ``omitStages`` and all rules
    and returns them as one aggregate (validation.go L28-35, reader.go L88-90).
    This reproduces that: EVERY finding, in Go's order, in one exception.

    INVARIANT LOCKED: a policy this loader accepts is a policy kube-apiserver
    would accept. That is what makes the 620 evaluated outcomes below evidence
    about the API server rather than about this module - a loader that admitted a
    document the server refuses to load would evaluate a policy that never ships.

    Raises:
        AuditPolicyError: naming every violation found, one per line.
    """
    __tracebackhide__ = True
    findings = _validate_omit_stages(policy.omit_stages, where="omitStages")
    for index, rule in enumerate(policy.rules):
        findings += _validate_rule(rule, where=f"rules[{index}]")

    if not findings:
        return

    rendered = "\n".join(f"  - {finding}" for finding in findings)
    raise AuditPolicyError(
        f"{REQUIREMENT_ID}: the audit policy is invalid and kube-apiserver would refuse to "
        f"load it -- {len(findings)} violation(s) of "
        f"validation.ValidatePolicy:\n{rendered}"
    )


def load_policy_from_bytes(policy_definition: bytes | str) -> AuditPolicy:
    """Decode and validate an audit policy document. Go: ``LoadPolicyFromBytes``.

    Args:
        policy_definition: The document, as read from disk or written by a test.

    Returns:
        The loaded :class:`AuditPolicy`, rules in file order.

    Raises:
        AuditPolicyError: if the document is not valid YAML, is not a mapping,
            does not declare ``apiVersion: audit.k8s.io/v1`` and
            ``kind: Policy``, has no ``rules`` list, declares zero rules, or
            carries a malformed field.
    """
    __tracebackhide__ = True
    try:
        document = yaml.safe_load(policy_definition)
    except yaml.YAMLError as exc:
        raise AuditPolicyError(f"{REQUIREMENT_ID}: failed decoding the audit policy: {exc}") from exc

    policy = _require_mapping(document, where="the audit policy document")

    api_version = policy.get("apiVersion")
    if api_version != POLICY_API_VERSION:
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: unknown group version field {api_version!r} in policy, wanted "
            f"{POLICY_API_VERSION!r}"
        )
    kind = policy.get("kind")
    if kind != POLICY_KIND:
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: unknown kind field {kind!r} in policy, wanted {POLICY_KIND!r}"
        )

    omit_stages = _require_omit_stages(policy.get("omitStages"), where="omitStages")
    omit_managed_fields = _require_optional_bool(
        policy.get("omitManagedFields"), where="omitManagedFields"
    )

    rules_value = policy.get("rules")
    if not isinstance(rules_value, list):
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: rules must be a list of policy rules, got "
            f"{type(rules_value).__name__} ({rules_value!r})"
        )
    rules = tuple(
        _require_rule(item, where=f"rules[{index}]") for index, item in enumerate(rules_value)
    )

    # reader.go L88-90: ValidatePolicy runs over the whole decoded policy and its
    # ErrorList is returned as ONE aggregate, BEFORE the 0-rules refusal below.
    # The order matters and is Go's: a document that is both invalid and empty
    # reports its validation findings, not "loaded illegal policy with 0 rules".
    validate_policy(
        AuditPolicy(
            rules=rules,
            omit_stages=omit_stages,
            omit_managed_fields=bool(omit_managed_fields),
        )
    )

    if not rules:
        # Go's exact message (reader.go L96), because it is the one an operator
        # searching the API server logs will already have seen.
        raise AuditPolicyError(f"{REQUIREMENT_ID}: loaded illegal policy with 0 rules")

    return AuditPolicy(
        rules=rules,
        omit_stages=omit_stages,
        omit_managed_fields=bool(omit_managed_fields),
    )


def load_policy_from_file(file_path: str | os.PathLike[str]) -> AuditPolicy:
    """Read and load a policy file. Go: ``LoadPolicyFromFile``.

    Args:
        file_path: Path to the generated policy.

    Returns:
        The loaded :class:`AuditPolicy`.

    Raises:
        AuditPolicyError: if the path is empty, if the file cannot be read - a
            missing file and a directory both land here, as they do in Go, whose
            ``os.ReadFile`` fails for either - or if the contents are not a valid
            policy.
    """
    __tracebackhide__ = True
    path = os.fspath(file_path)
    if not path:
        # Go: "file path not specified" (reader.go L47-49). Checked before the
        # read because an empty path produces an errno that names no file.
        raise AuditPolicyError(f"{REQUIREMENT_ID}: audit policy file path not specified")
    try:
        policy_definition = Path(path).read_bytes()
    except OSError as exc:
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: failed to read audit policy file {path!r}: {exc}"
        ) from exc
    try:
        return load_policy_from_bytes(policy_definition)
    except AuditPolicyError as exc:
        # Go appends ": from file %v" so a failure names the artifact as well as
        # the defect (reader.go L56-58).
        raise AuditPolicyError(f"{exc}: from file {path}") from exc


# ---------------------------------------------------------------------------
# checker.go: decide what level a request is recorded at
# ---------------------------------------------------------------------------
# The port of staging/src/k8s.io/apiserver/pkg/audit/policy/checker.go
# (``NewPolicyRuleEvaluator`` L33-38, ``unionStages`` L40-52,
# ``EvaluatePolicyRule`` L64-80, ``isOmitManagedFields`` L86-92, ``ruleMatches``
# L95-132, ``ruleMatchesNonResource`` L135-148, ``pathMatches`` L151-165 and
# ``ruleMatchesResource`` L168-217).
#
# THIS IS THE SECURITY-INVARIANT DECISION LOGIC of AAP §0.7.1.3 and it is held to
# 100% line and branch coverage. The shipped policy does not reach every branch -
# no rule it emits uses ``*``, ``*/subresource``, ``resource/*`` or
# ``resourceNames``, and its final catch-all rule means no request ever falls
# through to the default level - so the synthetic policies at the end of this
# module drive the rest. They exist for coverage of the PORT; every statement
# about the shipped generator is made by the 620 cases.
#
# THREE DEPARTURES FROM THE GO TEXT, each deliberate and each preserving
# behaviour exactly:
#
# 1. Go MUTATES the policy in ``NewPolicyRuleEvaluator``, assigning the unioned
#    stage list back into ``policy.Rules[i].OmitStages``. This port builds a new
#    tuple of rules and leaves the loaded policy pristine, because one policy is
#    shared by 620 items and a shared mutable structure is precisely what
#    AAP §0.7.2 forbids. Nothing observable changes: the evaluator is the only
#    reader of the unioned list.
# 2. Go's ``unionStages`` collects into a map and therefore returns the stages in
#    an unspecified order - which is why the oracle asserts with
#    ``ElementsMatch``. This port returns first-seen order, which is
#    deterministic, and the assertion still compares order-insensitively so it
#    remains a statement about the contract rather than about this
#    implementation.
# 3. ``if gr.Group == apiGroup { ... }`` is written as ``if group != ...:
#    continue``, and ``if len(gr.ResourceNames) == 0 || hasString(...)`` as its
#    negation with a ``continue``. Same decisions, same order, two fewer levels
#    of nesting - and the lint gate's SIM rules reject the nested-``if`` form.
#
# The ordering of the checks is NOT a departure and is not negotiable: it is what
# decides which rule intercepts a request, and therefore what level the request
# is recorded at.


def _union_stages(*stage_lists: Sequence[str]) -> tuple[str, ...]:
    """Union stage lists, preserving first-seen order. Go: ``unionStages``.

    A dict is used as an ordered set - the same structure Go uses, minus the
    randomised iteration. Callers compare the result order-insensitively.
    """
    union: dict[str, None] = {}
    for stages in stage_lists:
        for stage in stages:
            union[stage] = None
    return tuple(union)


def _has_string(values: Sequence[str], value: str) -> bool:
    """Membership, kept as its own function so the port reads like the original.

    Go: ``hasString`` (checker.go L220-227).
    """
    return value in values


def _path_matches(path: str, spec: str) -> bool:
    """Whether a non-resource path matches one specification. Go: ``pathMatches``.

    The three accepted forms, in Go's order (checker.go L151-165):

    * ``*`` matches every path;
    * an exact match;
    * a trailing ``*``, matched as a PREFIX. Go computes the prefix with
      ``strings.TrimRight(spec, "*")``, which is a CUTSET trim - it removes every
      trailing ``*``, not just one - and ``str.rstrip("*")`` is its exact
      equivalent.

    Measured against the shipped policy: ``/healthz*`` is what makes both
    ``/healthz`` and ``/healthz/etcd`` unaudited, and ``/swagger*`` covers both
    swagger paths, so the prefix form carries 6 of the 10 non-resource paths in
    the matrix.
    """
    if spec == "*":
        return True
    if spec == path:
        return True
    return spec.endswith("*") and path.startswith(spec.rstrip("*"))


def _rule_matches_non_resource(rule: PolicyRule, attrs: RequestAttributes) -> bool:
    """Whether a rule's non-resource URLs match. Go: ``ruleMatchesNonResource``.

    A RESOURCE request can never match a non-resource rule (checker.go L136-138),
    which is what keeps the generator's ``/healthz*`` rule from swallowing API
    traffic.

    Go's ``for``/``return true``/``return false`` (L141-147) is written as
    ``any(...)``, which short-circuits identically and is what the lint gate's
    SIM110 requires; the decision is unchanged.
    """
    if attrs.resource_request:
        return False
    return any(_path_matches(attrs.path, spec) for spec in rule.non_resource_urls)


def _rule_matches_resource(rule: PolicyRule, attrs: RequestAttributes) -> bool:
    """Whether a rule's resource fields match. Go: ``ruleMatchesResource``.

    In Go's order (checker.go L168-217):

    1. a NON-resource request can never match (L169-171);
    2. if the rule names namespaces, the request's namespace must be one of them,
       where a cluster-scoped request presents the EMPTY STRING (L173-177) - the
       comment on that line is "Non-namespaced resources use the empty string",
       and it is why ``namespaces: ["kube-system"]`` does not match a request for
       a cluster-scoped object;
    3. a rule with namespaces but NO resources matches every resource in them
       (L178-180);
    4. the resource is combined with its subresource as
       ``resource/subresource`` (L185-189), which is how ``nodes/status`` is
       named in a policy;
    5. for each entry whose group matches EXACTLY - ``""`` being the core group,
       so a rule for the core group never matches ``metrics.k8s.io`` (L194) - an
       entry with no resources matches everything in that group (L195-197), and
       otherwise each named resource is tried under the ``resourceNames`` guard
       (L199) against three forms: exact or ``*`` (L201), ``*/subresource``
       (L205) and ``resource/*`` (L209).
    """
    if not attrs.resource_request:
        return False

    if rule.namespaces and not _has_string(rule.namespaces, attrs.namespace):
        return False
    if not rule.resources:
        return True

    combined_resource = attrs.resource
    if attrs.subresource:
        combined_resource = f"{attrs.resource}/{attrs.subresource}"

    for group_resources in rule.resources:
        if group_resources.group != attrs.api_group:
            continue
        if not group_resources.resources:
            return True
        for resource_spec in group_resources.resources:
            if group_resources.resource_names and not _has_string(
                group_resources.resource_names, attrs.name
            ):
                continue
            # Go: `res == combinedResource || res == "*"`. Written as a membership
            # test because the lint gate's SIM109 rejects repeated equality
            # comparisons against the same operand; the decision is identical.
            if resource_spec in (combined_resource, "*"):
                return True
            if (
                attrs.subresource
                and resource_spec.startswith("*/")
                and attrs.subresource == resource_spec.removeprefix("*/")
            ):
                return True
            if resource_spec.endswith("/*") and attrs.resource == resource_spec.removesuffix("/*"):
                return True
    return False


def _rule_matches(rule: PolicyRule, attrs: RequestAttributes) -> bool:
    """Whether a rule matches a request. Go: ``ruleMatches`` (checker.go L95-132).

    The three selector checks are filters - each can only reject - and then
    exactly ONE of three terminal branches decides the answer:

    * ``namespaces`` or ``resources`` present -> the resource matcher decides,
      and its verdict is RETURNED (L123-125);
    * else ``nonResourceURLs`` present -> the non-resource matcher decides
      (L127-129);
    * else the rule matches EVERYTHING, resource requests and non-resource
      requests alike (L131).

    That last branch is not a curiosity: it is how the generator's final rule
    ``{level: Metadata, omitStages: [RequestReceived]}`` gives every unclaimed
    request a level, and it is why no request in the whole 620-case matrix ever
    reaches the default level.

    A rule with BOTH resource selectors and non-resource URLs would have its
    non-resource URLs ignored here - Go's ``ValidatePolicy`` rejects that
    combination outright, which is why the if/elif/else shape is safe as well as
    faithful.
    """
    if rule.users and (attrs.user is None or not _has_string(rule.users, attrs.user)):
        return False

    if rule.user_groups:
        if attrs.user is None:
            return False
        matched = False
        for group in attrs.groups:
            if _has_string(rule.user_groups, group):
                matched = True
                break
        if not matched:
            return False

    if rule.verbs and not _has_string(rule.verbs, attrs.verb):
        return False

    if rule.namespaces or rule.resources:
        return _rule_matches_resource(rule, attrs)

    if rule.non_resource_urls:
        return _rule_matches_non_resource(rule, attrs)

    return True


def _is_omit_managed_fields(rule: PolicyRule, policy_default: bool) -> bool:
    """Resolve the effective ``omitManagedFields``. Go: ``isOmitManagedFields``.

    A rule-level value overrides the policy default; ``None`` means the rule did
    not specify one (checker.go L86-92).
    """
    if rule.omit_managed_fields is None:
        return policy_default
    return rule.omit_managed_fields


class PolicyRuleEvaluator:
    """Evaluates requests against a loaded policy. Go: ``policyRuleEvaluator``.

    Immutable once built, and that is what makes ONE evaluator safe to share
    across 620 parametrized items and every auxiliary test in this module: it
    holds only tuples of frozen records, so no case can influence another's
    verdict and no ``pytest-xdist`` worker can observe a half-updated rule list.
    """

    __slots__ = ("_omit_managed_fields", "_omit_stages", "_rules")

    def __init__(self, policy: AuditPolicy) -> None:
        """Build an evaluator. Go: ``NewPolicyRuleEvaluator`` (checker.go L33-38).

        Each rule's ``omitStages`` becomes the union of the policy-level list and
        the rule's own. Go writes that union back into the policy; this builds new
        rules and leaves the policy untouched - see the section comment above for
        why.

        Args:
            policy: The loaded policy. Not modified.
        """
        self._rules: Final[tuple[PolicyRule, ...]] = tuple(
            replace(rule, omit_stages=_union_stages(policy.omit_stages, rule.omit_stages))
            for rule in policy.rules
        )
        self._omit_stages: Final[tuple[str, ...]] = policy.omit_stages
        self._omit_managed_fields: Final[bool] = policy.omit_managed_fields

    @property
    def rules(self) -> tuple[PolicyRule, ...]:
        """The rules with their stage lists already unioned, in file order."""
        return self._rules

    def evaluate(self, attrs: RequestAttributes) -> RequestAuditConfig:
        """Decide how a request is audited. Go: ``EvaluatePolicyRule`` (L64-80).

        Ordered FIRST-MATCH: the first rule that matches wins and no later rule
        is consulted. When nothing matches, the request is recorded at
        :data:`DEFAULT_AUDIT_LEVEL` - ``None``, Go's ``DefaultAuditLevel`` - with
        the POLICY-level stage list, not an empty one.

        Args:
            attrs: The request.

        Returns:
            The level, the stages to omit and the managed-fields decision.
        """
        for rule in self._rules:
            if _rule_matches(rule, attrs):
                return RequestAuditConfig(
                    level=rule.level,
                    omit_stages=rule.omit_stages,
                    omit_managed_fields=_is_omit_managed_fields(rule, self._omit_managed_fields),
                )
        return RequestAuditConfig(
            level=DEFAULT_AUDIT_LEVEL,
            omit_stages=self._omit_stages,
            omit_managed_fields=self._omit_managed_fields,
        )


# ---------------------------------------------------------------------------
# Interpreting the generated policy: pure, memoised, and NOT a fixture
# ---------------------------------------------------------------------------
# The GENERATION is a fixture and lives in tests/unit/shell/conftest.py, because
# AAP §0.4.4.1 and §0.9.2 put fixtures in conftest.py and never inline in a test
# module: `generated_audit_policy` runs the shipped bash once per module and hands
# back the bytes it wrote. What it deliberately does NOT do is load them, because
# the loader and the evaluator are the ports of reader.go and checker.go and this
# module's frozen specification requires they stay here.
#
# So the two derivations below are ORDINARY IMMUTABLE VALUES rather than fixtures,
# which is the right shape for them on their own merits: each is a pure function of
# an immutable string, returning frozen dataclasses, memoised so that 620
# parametrized items parse the policy ONCE between them rather than 620 times.
# `maxsize=1` because there is exactly one generated policy per module, and the key
# is the policy TEXT, so a different policy can never be served a cached evaluator
# built from another. Nothing here holds mutable state, so `pytest-randomly` order
# and `pytest-xdist` workers (separate processes, separate caches) are both safe.


@functools.lru_cache(maxsize=1)
def _loaded_policy(policy_text: str) -> AuditPolicy:
    """Load the generated policy once. Ports audit_policy_test.go L69-70.

    Memoised on the text, so the 620 cases and the shape assertions share one
    parse. A load failure aborts every caller, which is what Go's
    ``require.NoError`` does: 620 findings against a policy that did not load
    would all be about nothing.
    """
    return load_policy_from_bytes(policy_text)


@functools.lru_cache(maxsize=1)
def _evaluator_for(policy_text: str) -> PolicyRuleEvaluator:
    """The evaluator the 620 cases are judged by. Ports L127-130's ``auditTester``.

    Built once and shared, exactly as the Go test builds one evaluator and hands it
    to every subtest through the ``auditTester`` struct. Safe to share because
    :class:`PolicyRuleEvaluator` is immutable.
    """
    return PolicyRuleEvaluator(_loaded_policy(policy_text))


@pytest.fixture(scope="module")
def audit_policy_evaluator(
    generated_audit_policy: GeneratedShellPolicy,
) -> PolicyRuleEvaluator:
    """The shared evaluator, as a fixture, for the cases that read it declaratively.

    A thin wrapper over :func:`_evaluator_for` rather than a second construction
    path: the memoised function is what guarantees the policy is parsed ONCE for
    the whole module, and a fixture that built its own evaluator would quietly
    reintroduce the 620-parse cost this module removed. Module-scoped for the same
    reason, and safe to share because :class:`PolicyRuleEvaluator` is immutable -
    which is also what keeps it correct under ``pytest-randomly`` and
    ``pytest-xdist`` (AAP §0.7.2).
    """
    return _evaluator_for(generated_audit_policy.text)


def _attributes_for(case: apc.AuditPolicyCase) -> RequestAttributes:
    """Build the request attributes for one case. Ports L214-223 and L234-239.

    The two Go branches are kept distinct because the records they build differ in
    more than one field: a resource request carries the namespace, group,
    ``APIVersion: "v1"``, resource and subresource with no path, while a
    non-resource request carries only the path and leaves the API version empty.
    Neither branch ever sets ``Name``, so every ported case presents ``""`` - and
    that is why no case in the matrix exercises ``resourceNames``.

    ``AuditPolicyCase.attributes()`` renders the same nine fields as an untyped
    mapping; this builds from the case's TYPED fields instead so the hot path
    needs no narrowing casts, and
    :func:`test_typed_attributes_agree_with_the_shared_mapping` asserts the two
    agree for all 620 cases so they cannot drift.
    """
    selector = case.selector
    if selector is None:
        return RequestAttributes(
            user=case.principal.name,
            groups=case.principal.groups,
            verb=case.verb,
            api_version=case.api_version,
            resource_request=False,
            path=case.path,
        )
    return RequestAttributes(
        user=case.principal.name,
        groups=case.principal.groups,
        verb=case.verb,
        namespace=selector.namespace,
        api_group=selector.group,
        api_version=case.api_version,
        resource=selector.resource,
        subresource=selector.subresource,
        resource_request=True,
    )


def _describe_request(case: apc.AuditPolicyCase) -> str:
    """Render a case's request for a failure message, in the oracle's own terms.

    Names the principal, the verb and the target the way the Go subtest name and
    the policy do - the policy spelling INCLUDES the subresource, which the
    subtest name omits, so a failure on ``kubelet.get.nodes#01`` says
    ``nodes/status`` and the reader is not left guessing which of the two
    identically named cases failed.
    """
    selector = case.selector
    if selector is None:
        return f"principal={case.principal.name!r} verb={case.verb!r} path={case.path!r}"
    return (
        f"principal={case.principal.name!r} groups={list(case.principal.groups)} "
        f"verb={case.verb!r} resource={selector.policy_resource!r} "
        f"group={selector.group!r} namespace={selector.namespace!r}"
    )


def _level_failure(case: apc.AuditPolicyCase, config: RequestAuditConfig) -> str:
    """The message for a case recorded at the wrong level."""
    __tracebackhide__ = True
    return (
        f"{REQUIREMENT_ID}: the generated audit policy records this request at "
        f"{config.level!r} but it must be recorded at {case.level.wire!r}. "
        f"{_describe_request(case)}. case={case.id!r}, expectation declared at "
        f"cluster/gce/gci/audit_policy_test.go L{case.go_line}."
    )


def _omit_stages_failure(case: apc.AuditPolicyCase, config: RequestAuditConfig) -> str:
    """The message for a rule above ``None`` that omits the wrong stages."""
    __tracebackhide__ = True
    return (
        f"{REQUIREMENT_ID}: this request is recorded at {config.level!r}, so the matching rule "
        f"must omit exactly {list(apc.EXPECTED_OMIT_STAGES)} - one event per request instead of "
        f"two - but it omits {list(config.omit_stages)}. {_describe_request(case)}. "
        f"case={case.id!r}, expectation declared at "
        f"cluster/gce/gci/audit_policy_test.go L{case.go_line}."
    )


# ---------------------------------------------------------------------------
# The matrix and the generated artifact: setup, with ABORT semantics
# ---------------------------------------------------------------------------


def test_case_matrix_shape_matches_the_oracle() -> None:
    """The imported matrix is still the 620 cases the Go suite measured.

    INVARIANT LOCKED: the parity contract's cardinality. AAP §0.11.1 B1 makes the
    620 node ids of :func:`test_audit_level` a public contract, so a silent change
    to the shared case table - a dropped selector, a duplicated verb, a renamed
    principal - must fail HERE, loudly and once, rather than by quietly changing
    how many cases the suite reports.

    BARE ASSERTS, DELIBERATELY. This is the port of the three
    ``require.NotEmpty`` calls at audit_policy_test.go L207-209 and of the arithmetic
    the counts in tests.fixtures.audit_policy_cases record: setup breakage, which
    ABORTS. A matrix of the wrong size makes every per-case finding suspect, so
    accumulating past it would be reporting 620 results about the wrong thing.

    The counts are compared against that module's literal constants rather than
    against numbers written here, because those literals were taken from the Go
    suite - so this is a comparison against the oracle and not against itself.
    And every one of those literals is additionally re-derived FROM THE SHIPPED
    ORACLE SOURCE by :func:`test_matrix_vocabulary_matches_the_go_source`, so no
    number here rests on a comment claiming it was measured once.
    """
    assert len(_CASES) == apc.TOTAL_CASE_COUNT, (
        f"{REQUIREMENT_ID}: the shared case table expands to {len(_CASES)} cases, but the Go "
        f"suite measures {apc.TOTAL_CASE_COUNT}. The 620 node ids of test_audit_level are the "
        "parity key recorded in tests/parity/baseline/go_baseline.json."
    )
    assert len(apc.resource_cases()) == apc.RESOURCE_CASE_COUNT
    assert len(apc.non_resource_cases()) == apc.NON_RESOURCE_CASE_COUNT
    assert apc.RESOURCE_CASE_COUNT + apc.NON_RESOURCE_CASE_COUNT == apc.TOTAL_CASE_COUNT

    # The invocation table's own shape: INVOCATION_COUNT = RESOURCE_INVOCATION_COUNT
    # + NON_RESOURCE_INVOCATION_COUNT, i.e. one record per `at.testResources(` and
    # `at.testNonResources(` call site in audit_policy_test.go L132-183. The
    # literals are NOT justified here by prose: the companion test below counts
    # those call sites in the shipped Go file and requires them to agree, which is
    # what turns "measured once during planning" into "measured on every run".
    assert len(apc.INVOCATIONS) == apc.INVOCATION_COUNT
    resource_invocations = [
        invocation
        for invocation in apc.INVOCATIONS
        if invocation.kind is apc.InvocationKind.RESOURCE
    ]
    assert len(resource_invocations) == apc.RESOURCE_INVOCATION_COUNT
    assert (
        len(apc.INVOCATIONS) - len(resource_invocations) == apc.NON_RESOURCE_INVOCATION_COUNT
    )

    # THE PUBLISHED VOCABULARY CARDINALITIES, each asserted against the collection
    # it describes. Without these three the aggregate 620 could hold while the
    # matrix's declared shape drifted underneath it - a fifteenth principal
    # balanced by a dropped selector still expands to a different 620, and every
    # id would shift with it.
    assert len(apc.ALL_PRINCIPALS) == apc.PRINCIPAL_COUNT, (
        f"{REQUIREMENT_ID}: the matrix declares {len(apc.ALL_PRINCIPALS)} principals but "
        f"PRINCIPAL_COUNT is {apc.PRINCIPAL_COUNT}. The 14 principals are the `allUsers` slice "
        "of audit_policy_test.go L89 and the user component of every one of the 620 ids."
    )
    assert len({principal.name for principal in apc.ALL_PRINCIPALS}) == apc.PRINCIPAL_COUNT, (
        f"{REQUIREMENT_ID}: two principals share a name, so the id space collapses: the id is "
        "`<user>.<verb>.<object>`, and a duplicated user silently re-points cases at one "
        "another while keeping the total at 620."
    )
    assert len(apc.ALL_SELECTORS) == apc.SELECTOR_COUNT, (
        f"{REQUIREMENT_ID}: the matrix declares {len(apc.ALL_SELECTORS)} resource selectors but "
        f"SELECTOR_COUNT is {apc.SELECTOR_COUNT}. These are the `resource(...)` declarations of "
        "audit_policy_test.go L94-116, and they carry the V6 boundary targets - secrets, "
        "serviceaccounts/token, configmaps, tokenreviews and clusterroles."
    )
    assert len(apc.ALL_NON_RESOURCE_PATHS) == apc.NON_RESOURCE_PATH_COUNT, (
        f"{REQUIREMENT_ID}: the matrix declares {len(apc.ALL_NON_RESOURCE_PATHS)} non-resource "
        f"paths but NON_RESOURCE_PATH_COUNT is {apc.NON_RESOURCE_PATH_COUNT}. They are the two "
        "five-path groups of audit_policy_test.go L164-165."
    )
    assert len(set(apc.ALL_NON_RESOURCE_PATHS)) == apc.NON_RESOURCE_PATH_COUNT, (
        f"{REQUIREMENT_ID}: a non-resource path is repeated across the two groups, which would "
        "make one group's expected level unreachable - Go reports the second occurrence as a "
        "`#01` duplicate of the first, at whichever level came first."
    )

    # THE TWO FIVE-PATH GROUPS, asserted separately from their union. The split is
    # load-bearing rather than cosmetic: the first group is expected at `None` and
    # the second at `Metadata` (audit_policy_test.go L164 and L165), so moving one
    # path between them changes 28 expected levels while leaving the count at 10.
    assert len(apc.HEALTH_AND_VERSION_PATHS) == 5, (
        f"{REQUIREMENT_ID}: the health/version group holds "
        f"{len(apc.HEALTH_AND_VERSION_PATHS)} paths, expected 5 (audit_policy_test.go L164). "
        "Every path in this group is expected at `None`."
    )
    assert len(apc.OBSERVABILITY_AND_DISCOVERY_PATHS) == 5, (
        f"{REQUIREMENT_ID}: the observability/discovery group holds "
        f"{len(apc.OBSERVABILITY_AND_DISCOVERY_PATHS)} paths, expected 5 "
        "(audit_policy_test.go L165). Every path in this group is expected at `Metadata`."
    )
    assert not set(apc.HEALTH_AND_VERSION_PATHS) & set(apc.OBSERVABILITY_AND_DISCOVERY_PATHS), (
        f"{REQUIREMENT_ID}: the two non-resource groups overlap. They carry DIFFERENT expected "
        "levels - `None` and `Metadata` - so a shared path would assert both at once."
    )

    # The non-resource arithmetic, spelled out because it is the half of the 620
    # that no selector participates in: `testNonResources` (audit_policy_test.go
    # L230-243) hardcodes its own two verbs and loops users x verbs x paths.
    assert len(apc.NON_RESOURCE_VERBS) == 2, (
        f"{REQUIREMENT_ID}: `testNonResources` hardcodes exactly the two verbs "
        f"{list(apc.NON_RESOURCE_VERBS)} at audit_policy_test.go L232; the matrix declares "
        f"{len(apc.NON_RESOURCE_VERBS)}."
    )
    assert (
        apc.NON_RESOURCE_INVOCATION_COUNT
        * apc.PRINCIPAL_COUNT
        * len(apc.NON_RESOURCE_VERBS)
        * len(apc.HEALTH_AND_VERSION_PATHS)
        == apc.NON_RESOURCE_CASE_COUNT
    ), (
        f"{REQUIREMENT_ID}: the non-resource product "
        f"{apc.NON_RESOURCE_INVOCATION_COUNT} invocations x {apc.PRINCIPAL_COUNT} principals x "
        f"{len(apc.NON_RESOURCE_VERBS)} verbs x {len(apc.HEALTH_AND_VERSION_PATHS)} paths does "
        f"not equal NON_RESOURCE_CASE_COUNT ({apc.NON_RESOURCE_CASE_COUNT}). Both non-resource "
        "invocations pass all 14 principals and a five-path group, so 2x14x2x5 = 280 is the "
        "only shape that reconciles with the 620 total."
    )

    # The port of L207-209: `testResources` refuses a call with no verb, no user
    # or no resource, because its variadic `interface{}` signature would otherwise
    # let a mistyped call expand to nothing and report success vacuously.
    for invocation in apc.INVOCATIONS:
        where = f"invocation from audit_policy_test.go L{invocation.go_line}"
        assert invocation.principals, f"{where}: testcases must have a user"
        assert invocation.verbs, f"{where}: testcases must have a verb"
        assert invocation.targets, f"{where}: resource testcases must have a resource"

    # The ids must be unique: 620 items whose ids collided would be silently
    # renamed by pytest and would stop matching the baseline manifest.
    assert len(set(_CASE_IDS)) == apc.TOTAL_CASE_COUNT
    assert len(_CASE_IDS) == len(_CASES)
    # The `#NN` occurrence suffixes, counted through the public `occurrence` field
    # that DUPLICATE_SUFFIXED_ID_COUNT is defined in terms of, and cross-checked
    # against the rendered ids so that a suffix which stopped being APPLIED - not
    # merely counted - is caught too.
    repeated = [case for case in _CASES if case.occurrence != 0]
    assert len(repeated) == apc.DUPLICATE_SUFFIXED_ID_COUNT, (
        f"{REQUIREMENT_ID}: {apc.DUPLICATE_SUFFIXED_ID_COUNT} of the Go subtest names carry a "
        "'#NN' occurrence suffix, because the object component of a name omits the subresource "
        "and the API group. Losing the suffixes would put these ids permanently out of step "
        "with the recorded baseline."
    )
    for case in repeated:
        assert case.id != case.base_name, (
            f"{REQUIREMENT_ID}: case {case.base_name!r} is occurrence {case.occurrence} of a "
            "repeated name, so its id must carry the suffix Go's testing package appends."
        )
    assert len({case.base_name for case in _CASES}) == apc.UNIQUE_BASE_NAME_COUNT


def test_matrix_vocabulary_matches_the_go_source(repo_root: Path) -> None:
    """Every published matrix cardinality is re-counted in the shipped Go oracle.

    INVARIANT LOCKED: the matrix's declared shape is the shape
    ``cluster/gce/gci/audit_policy_test.go`` actually has - on every run, not once
    during planning. :func:`test_case_matrix_shape_matches_the_oracle` compares the
    Python matrix against the fixture module's literals; this test compares those
    literals against the ORACLE ITSELF, so the pair closes the loop and neither
    side can drift without a named failure.

    WHY THIS EXISTS. The four cardinalities below were previously justified by a
    comment saying they had been counted and that "the code is authoritative"
    where the plan's prose disagreed. A comment cannot fail, so a later edit to
    either the Go table or the fixture would have been caught only if it also
    changed the 620 aggregate - and a fifteenth principal balanced by a dropped
    selector does not. Reading the oracle here makes the disagreement itself
    executable: if the Go source ever holds 28 resource invocations or 24
    selectors, THIS test names the difference, rather than the suite silently
    asserting one shape while the oracle has another.

    READ-ONLY, AND TEXTUAL BY NECESSITY. The oracle is a Go file and this tier has
    no Go parser, so the count is a line-oriented scan for the four declaration
    forms the file uses: ``at.testResources(`` and ``at.testNonResources(`` call
    sites, ``= resource(`` selector declarations, and the ``allUsers = []user.Info``
    roster. Each pattern is anchored on the spelling the file actually uses, and a
    reformatting that broke a pattern would fail loudly here rather than silently
    counting zero - the assertions are equalities against non-zero expectations.

    ABORT semantics: a mismatch invalidates every one of the 620 per-case
    expectations, so this is setup breakage and uses bare asserts.
    """
    oracle = repo_root / "cluster" / "gce" / "gci" / "audit_policy_test.go"
    assert oracle.is_file(), (
        f"{REQUIREMENT_ID}: the Go oracle {oracle} is missing. It is the source of every "
        "expectation in this module and is READ-ONLY input; it must never be moved, renamed or "
        "deleted (AAP §0.8.2 keeps the DELETE column of the transformation map empty)."
    )
    lines = oracle.read_text(encoding="utf-8").splitlines()

    resource_call_sites = [line for line in lines if "at.testResources(" in line]
    non_resource_call_sites = [line for line in lines if "at.testNonResources(" in line]
    # `nodes = resource("nodes")` and its 22 siblings, all inside the single `var`
    # block at L94-116. `resource(` also appears in the helper's own declaration at
    # L276, which is why the pattern requires the assignment.
    selector_declarations = [line for line in lines if "= resource(" in line]
    principal_rosters = [line for line in lines if "allUsers = []user.Info{" in line]

    assert len(resource_call_sites) == apc.RESOURCE_INVOCATION_COUNT, (
        f"{REQUIREMENT_ID}: the Go oracle makes {len(resource_call_sites)} `at.testResources(` "
        f"calls but the matrix declares RESOURCE_INVOCATION_COUNT="
        f"{apc.RESOURCE_INVOCATION_COUNT}. Re-measure both and reconcile against the "
        f"{apc.TOTAL_CASE_COUNT}-case total, which is the parity key: an invocation gained or "
        "lost changes which cases exist, not merely how many."
    )
    assert len(non_resource_call_sites) == apc.NON_RESOURCE_INVOCATION_COUNT, (
        f"{REQUIREMENT_ID}: the Go oracle makes {len(non_resource_call_sites)} "
        f"`at.testNonResources(` calls but the matrix declares NON_RESOURCE_INVOCATION_COUNT="
        f"{apc.NON_RESOURCE_INVOCATION_COUNT}."
    )
    assert (
        len(resource_call_sites) + len(non_resource_call_sites) == apc.INVOCATION_COUNT
    ), (
        f"{REQUIREMENT_ID}: the Go oracle makes "
        f"{len(resource_call_sites) + len(non_resource_call_sites)} invocations in total but the "
        f"matrix declares INVOCATION_COUNT={apc.INVOCATION_COUNT}."
    )
    assert len(selector_declarations) == apc.SELECTOR_COUNT, (
        f"{REQUIREMENT_ID}: the Go oracle declares {len(selector_declarations)} `resource(...)` "
        f"selectors but the matrix declares SELECTOR_COUNT={apc.SELECTOR_COUNT}. A selector "
        "added to the oracle without being ported here would leave its cases unasserted "
        "entirely."
    )
    assert len(principal_rosters) == 1, (
        f"{REQUIREMENT_ID}: expected exactly one `allUsers = []user.Info{{` roster in the Go "
        f"oracle, found {len(principal_rosters)}. The principal vocabulary is read from that "
        "one line (L89)."
    )
    # The roster is a single line listing every principal local, so the entry count
    # is the number of comma-separated names between the braces.
    roster = principal_rosters[0].split("{", 1)[1].rsplit("}", 1)[0]
    roster_entries = [entry.strip() for entry in roster.split(",") if entry.strip()]
    assert len(roster_entries) == apc.PRINCIPAL_COUNT, (
        f"{REQUIREMENT_ID}: the Go oracle's `allUsers` roster lists {len(roster_entries)} "
        f"principals but the matrix declares PRINCIPAL_COUNT={apc.PRINCIPAL_COUNT}. Every "
        "non-resource case is expanded over that roster, so its size scales 280 of the "
        f"{apc.TOTAL_CASE_COUNT} cases."
    )
    # Both `testNonResources` call sites pass a five-path group, which is what makes
    # 2 x 14 x 2 x 5 = 280. Counted as the string arguments after the level and the
    # user slice: `at.testNonResources(level, allUsers, "/p1", ... "/p5")`.
    for line in non_resource_call_sites:
        paths = [token for token in line.split('"') if token.startswith("/")]
        assert len(paths) == len(apc.HEALTH_AND_VERSION_PATHS), (
            f"{REQUIREMENT_ID}: a `at.testNonResources(` call site passes {len(paths)} paths, "
            f"expected {len(apc.HEALTH_AND_VERSION_PATHS)}. Both groups are five paths wide in "
            f"the oracle; the offending line is: {line.strip()!r}"
        )
    oracle_paths = [
        token
        for line in non_resource_call_sites
        for token in line.split('"')
        if token.startswith("/")
    ]
    assert sorted(oracle_paths) == sorted(apc.ALL_NON_RESOURCE_PATHS), (
        f"{REQUIREMENT_ID}: the non-resource paths in the Go oracle are {sorted(oracle_paths)} "
        f"but the matrix declares {sorted(apc.ALL_NON_RESOURCE_PATHS)}. A path that differs by "
        "one character asserts a level for a request the API server never sees."
    )


def test_generated_policy_has_the_shape_the_oracle_loads(
    generated_audit_policy: GeneratedShellPolicy,
    subtests: pytest.Subtests,
) -> None:
    """The shipped generator wrote a loadable ``audit.k8s.io/v1`` Policy.

    INVARIANT LOCKED: the artifact the 620 cases are judged against is the
    envelope Go's loader accepts, with the ordered rule list intact, and the
    measured ``omitStages`` asymmetry that makes :func:`test_audit_level`'s second
    assertion conditional rather than unconditional.

    The document is re-decoded from the bytes the generator WROTE rather than
    read back off the loaded policy, which would only prove the
    loader self-consistent.

    Per-rule findings ACCUMULATE: eight rules must each carry
    ``omitStages: ["RequestReceived"]`` and ten must carry none, and a reader
    fixing that needs to see every offending rule, not the first.
    """
    document = yaml.safe_load(generated_audit_policy.text)
    assert isinstance(document, dict), (
        f"{REQUIREMENT_ID}: {AUDIT_POLICY_FUNC_NAME} must write a YAML mapping, got "
        f"{type(document).__name__}"
    )
    assert document.get("apiVersion") == POLICY_API_VERSION
    assert document.get("kind") == POLICY_KIND
    assert sorted(document) == ["apiVersion", "kind", "rules"], (
        f"{REQUIREMENT_ID}: the generated policy declares top-level keys {sorted(document)}. "
        "It carries no policy-level omitStages, which is why every rule above None has to "
        "declare its own."
    )
    assert len(document["rules"]) == GENERATED_RULE_COUNT, (
        f"{REQUIREMENT_ID}: the generated policy has {len(document['rules'])} rules, expected "
        f"{GENERATED_RULE_COUNT}. Evaluation is ordered first-match, so a lost or inserted rule "
        "changes which rule intercepts a request."
    )

    policy = _loaded_policy(generated_audit_policy.text)
    assert len(policy.rules) == GENERATED_RULE_COUNT
    assert policy.omit_stages == (), (
        f"{REQUIREMENT_ID}: the generated policy must declare no policy-level omitStages, got "
        f"{list(policy.omit_stages)}"
    )
    assert policy.omit_managed_fields is False

    # THE MEASURED ASYMMETRY. Asserted over every rule rather than by index, so
    # that it keeps holding if a rule is ever reordered - what must not change is
    # that a rule above None omits RequestReceived and a None rule omits nothing.
    for index, rule in enumerate(policy.rules):
        with subtests.test(rule=index, level=rule.level):
            if rule.level == DEFAULT_AUDIT_LEVEL:
                assert rule.omit_stages == (), (
                    f"{REQUIREMENT_ID}: rules[{index}] is at level {DEFAULT_AUDIT_LEVEL!r}, which "
                    f"emits no event at all, so it declares no omitStages; got "
                    f"{list(rule.omit_stages)}"
                )
            else:
                assert sorted(rule.omit_stages) == sorted(apc.EXPECTED_OMIT_STAGES), (
                    f"{REQUIREMENT_ID}: rules[{index}] is at level {rule.level!r}, so it must omit "
                    f"exactly {list(apc.EXPECTED_OMIT_STAGES)} - one event per request instead of "
                    f"two - but it omits {list(rule.omit_stages)}"
                )

    with subtests.test("every level in the generated policy is one of the four"):
        assert {rule.level for rule in policy.rules} <= VALID_LEVELS


def test_typed_attributes_agree_with_the_shared_mapping() -> None:
    """:func:`_attributes_for` renders exactly ``AuditPolicyCase.attributes()``.

    INVARIANT LOCKED: this module reads the request through the case's TYPED
    fields, for the mundane reason that the typed path needs no narrowing casts
    to satisfy the type gate, while ``attributes()`` is the untyped rendering the
    shared fixtures module publishes for both audit tiers. Asserting they agree
    for all 620 cases is what stops the two spellings of the same nine
    ``authorizer.AttributesRecord`` fields from drifting apart - a drift that
    would otherwise show up as the L1 and L2 tiers evaluating subtly different
    requests while both stayed green.

    Bare asserts: a mismatch here is a defect in this port's plumbing, not a
    finding about the generated policy, and there is nothing to be gained from
    seeing it 620 times.
    """
    for case in _CASES:
        attrs = _attributes_for(case)
        mapping = case.attributes()
        where = f"case={case.id!r}"
        assert mapping["user"] == attrs.user, where
        assert mapping["groups"] == attrs.groups, where
        assert mapping["verb"] == attrs.verb, where
        assert mapping["namespace"] == attrs.namespace, where
        assert mapping["api_group"] == attrs.api_group, where
        assert mapping["api_version"] == attrs.api_version, where
        assert mapping["resource"] == attrs.resource, where
        assert mapping["subresource"] == attrs.subresource, where
        assert mapping["resource_request"] == attrs.resource_request, where
        assert mapping["path"] == attrs.path, where
        # The Go harness never sets `Name` on the records it builds, which is why
        # no case in this matrix exercises `resourceNames` matching and why the
        # synthetic policy below has to.
        assert attrs.name == "", where


# ---------------------------------------------------------------------------
# The 620 cases: the port of TestCreateMasterAuditPolicy itself
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", _CASES, ids=_CASE_IDS)
def test_audit_level(
    case: apc.AuditPolicyCase,
    generated_audit_policy: GeneratedShellPolicy,
    subtests: pytest.Subtests,
) -> None:
    """One request, evaluated against the shipped policy. Ports ``expectLevel``.

    INVARIANT LOCKED: **F-006-RQ-001** for this one ``(principal, verb, target)``
    request - the level the shipped ``create-master-audit-policy`` policy records
    it at, and, when that level is above ``None``, the single stage the matching
    rule omits. Across the 620 parametrizations this is the whole of the V6
    sensitive-resource boundary: ``secrets`` and ``serviceaccounts/token`` at
    exactly ``Request``, ``configmaps`` and ``tokenreviews`` at exactly
    ``Metadata``, RBAC objects at ``RequestResponse`` for mutating verbs, and
    every high-volume low-risk path at ``None``.

    NODE IDS ARE THE PARITY CONTRACT. The ids come from
    ``tests.fixtures.audit_policy_cases.case_ids()``, which was compared
    element-for-element against a live ``go test -v`` run of
    ``TestCreateMasterAuditPolicy`` and found EQUAL - 620 names, same order, all
    35 ``#NN`` suffixes. So a caller can address a case exactly as the oracle
    names it::

        pytest "tests/unit/shell/test_audit_policy.py::test_audit_level[cluster-autoscaler.get./api]"

    Copy an id from ``--collect-only`` rather than typing it: a mistyped id
    selects nothing and pytest reports "no tests ran" rather than an error.

    BOTH ASSERTIONS ACCUMULATE, in their own subtest blocks, because the Go
    original uses testify's ``assert`` for both (L258, L260) and not ``require``.
    A case whose level is right and whose ``omitStages`` is wrong must report the
    second finding rather than have it masked, and across the suite every
    offending case must be visible in one run.

    THE SECOND ASSERTION IS CONDITIONED ON THE EVALUATED LEVEL, not the expected
    one - ``if auditConfig.Level != audit.LevelNone`` (L259). The two coincide
    while the suite is green, and they must not be conflated: a rule that both
    lost its level and lost its stages should report both, and a rule that
    correctly records nothing has no stages to omit.

    ``sorted(...)`` on both sides is ``assert.ElementsMatch``: Go builds the
    unioned stage list from a map, so order carries no meaning and asserting on
    it would assert an implementation detail.
    """
    config = _evaluator_for(generated_audit_policy.text).evaluate(_attributes_for(case))

    with subtests.test(case=case.id, assertion="level"):
        assert config.level == case.level.wire, _level_failure(case, config)

    if config.level != DEFAULT_AUDIT_LEVEL:
        with subtests.test(case=case.id, assertion="omitStages"):
            assert sorted(config.omit_stages) == sorted(apc.EXPECTED_OMIT_STAGES), (
                _omit_stages_failure(case, config)
            )


# ---------------------------------------------------------------------------
# The differential: this evaluator against the PRODUCTION Go evaluator
# ---------------------------------------------------------------------------
# WHY THIS IS NEEDED AT ALL. Every assertion above runs the ported
# :class:`PolicyRuleEvaluator`, so on its own the matrix proves that the shipped
# policy plus THIS port yield the expected levels. It does not, by itself, prove
# that the port and ``auditpolicy.NewPolicyRuleEvaluator`` agree -- a port with a
# matching defect in both the evaluator and an expectation would pass.
#
# WHAT CLOSES IT, WITHOUT ADDING A GO FILE. The committed baseline manifest
# `tests/parity/baseline/go_baseline.json` is the reduced output of a real
# `go test -json` run, so each of its 620 `TestCreateMasterAuditPolicy/<name>`
# rows is a verdict the PRODUCTION evaluator produced. A Go subtest passes exactly
# when `assert.Equal(t, expected, auditConfig.Level)` held (audit_policy_test.go
# L258), and `expected` there is the level this suite transcribes into
# `tests.fixtures.audit_policy_cases`. So:
#
#   Go recorded pass for case X       => Go's evaluator returned expected[X]
#   test_audit_level passes for X     => this evaluator returned expected[X]
#   identities are 1:1 and complete   => no case is unaccounted for
#   ------------------------------------------------------------------------
#   therefore the two evaluators agree on all 620 inputs.
#
# The third line is what this test contributes, and it is the line that cannot be
# skipped: a differential over a subset is not a differential. AAP §0.5 fixes the
# file inventory and names no new `.go` file, so a purpose-built Go differential
# program is not available to this workstream; reading the recorded output of the
# production evaluator is, and it is the same evidence.

#: The committed baseline manifest, relative to the repository root.
_GO_BASELINE_RELATIVE_PATH: Final[tuple[str, ...]] = (
    "python",
    "tests",
    "parity",
    "baseline",
    "go_baseline.json",
)

#: The Go package and top-level identity whose subtests this module ports.
_GO_BASELINE_PACKAGE: Final[str] = "k8s.io/kubernetes/cluster/gce/gci"
_GO_BASELINE_TEST: Final[str] = "TestCreateMasterAuditPolicy"


def test_the_go_oracle_recorded_the_same_620_verdicts(
    repo_root: Path,
    audit_policy_evaluator: PolicyRuleEvaluator,
    subtests: pytest.Subtests,
) -> None:
    """The DIFFERENTIAL against the production Go evaluator, over all 620 identities.

    INVARIANT LOCKED: this module's ported evaluator and
    ``auditpolicy.NewPolicyRuleEvaluator`` agree on every request the Go oracle
    exercises -- established through the verdicts the production evaluator actually
    produced, read out of the committed baseline manifest, rather than through a
    re-implementation asserting against itself.

    Four assertions, and the first three are what make the fourth mean anything:

    1. COMPLETENESS in one direction: every recorded Go subtest identity has a
       Python counterpart. A Go case with no counterpart is a behaviour this port
       silently dropped.
    2. COMPLETENESS in the other: every Python case id appears in the recording. A
       Python case with no Go counterpart is an expectation nobody else holds, and
       it would make the differential a subset comparison.
    3. Every recorded verdict is ``pass``. If Go recorded a failure the manifest
       would be describing a broken oracle, and "the two agree" would be a claim
       about two broken things.
    4. This evaluator returns the transcribed level for the same identity. With 1-3
       in place, that is agreement between the two evaluators.

    Findings accumulate per identity, because a divergence is normally a class of
    cases rather than one, and the shape of the class is the diagnosis.
    """
    manifest_path = repo_root.joinpath(*_GO_BASELINE_RELATIVE_PATH)
    assert manifest_path.is_file(), (
        f"{REQUIREMENT_ID}: SETUP BREAKAGE - the committed baseline manifest is missing at "
        f"{manifest_path}. It is the recorded output of the PRODUCTION Go evaluator and the "
        f"only evidence in this tier that the ported evaluator agrees with it; regenerate it "
        f"with python/tests/parity/tools/generate_baseline.py."
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    recorded: dict[str, str] = {
        str(row["subtest"]): str(row["action"])
        for row in manifest["verdicts"]
        if row["package"] == _GO_BASELINE_PACKAGE
        and row["test"] == _GO_BASELINE_TEST
        and row["subtest"]
    }
    expected_by_id = {case.id: case for case in _CASES}

    # 1 and 2: the identity sets must be equal, and each direction is a different
    # defect, so each is reported separately.
    missing_from_python = sorted(set(recorded) - set(expected_by_id))
    assert not missing_from_python, (
        f"{REQUIREMENT_ID}: {len(missing_from_python)} Go subtest identity/identities recorded "
        f"in the baseline have no counterpart in this module, so their behaviour is not ported "
        f"at all: {missing_from_python[:10]}"
        f"{' ...' if len(missing_from_python) > 10 else ''}"
    )
    missing_from_go = sorted(set(expected_by_id) - set(recorded))
    assert not missing_from_go, (
        f"{REQUIREMENT_ID}: {len(missing_from_go)} case(s) in this module have no recorded Go "
        f"verdict, so the differential would be a subset comparison rather than a proof: "
        f"{missing_from_go[:10]}{' ...' if len(missing_from_go) > 10 else ''}"
    )
    assert len(recorded) == apc.RESOURCE_CASE_COUNT + apc.NON_RESOURCE_CASE_COUNT, (
        f"{REQUIREMENT_ID}: the baseline records {len(recorded)} subtests for "
        f"{_GO_BASELINE_TEST} but the measured matrix is "
        f"{apc.RESOURCE_CASE_COUNT + apc.NON_RESOURCE_CASE_COUNT} cases. An equal-but-shrunken "
        f"pair of sets would still satisfy the two assertions above."
    )

    # 3 and 4, per identity.
    for case_id, action in sorted(recorded.items()):
        case = expected_by_id[case_id]
        with subtests.test(case=case_id):
            assert action == "pass", (
                f"{REQUIREMENT_ID}: the Go oracle recorded {action!r} for {case_id!r}. The "
                f"differential compares this evaluator against a GREEN oracle; a recorded "
                f"failure means the manifest describes a broken oracle, so agreement with it "
                f"would prove nothing."
            )
            config = audit_policy_evaluator.evaluate(_attributes_for(case))
            assert config.level == case.level.wire, (
                f"{REQUIREMENT_ID}: DIVERGENCE from the production evaluator for {case_id!r}. "
                f"Go recorded a pass, which means auditpolicy.NewPolicyRuleEvaluator returned "
                f"{case.level.wire!r} (audit_policy_test.go L258 asserts equality against that "
                f"value); this module's PolicyRuleEvaluator returned {config.level!r} for the "
                f"same request against the same generated policy. One of the two ports -- "
                f"reader.go or checker.go -- has diverged."
            )


# ---------------------------------------------------------------------------
# The V6 boundary, as an EXHAUSTIVE CLOSED-SET PARTITION
# ---------------------------------------------------------------------------
# WHAT WAS HERE BEFORE, AND WHY IT WAS NOT ENOUGH. This section used to hold five
# probes - one `(resource, verb)` pair per sensitive resource - each asserting that
# the pair sat at the resource's headline level. Every probe passed, and every
# probe had been chosen from a COMPLIANT row: `configmaps` under `get` in the
# `default` namespace (Metadata) while three kube-system rows in the same matrix
# sit at `None`, and `clusterroles` under `create` (RequestResponse) while twelve
# read rows sit at `Request`. A boundary stated as five compliant rows is not a
# boundary: it cannot distinguish "the rule holds" from "at least one row happens
# to satisfy it", and it says nothing at all about the rows that do not.
#
# WHAT REPLACES IT. The complete partition, asserted over EVERY sensitive-resource
# case in the matrix, with both exceptions promoted from prose into data that is
# itself asserted for EQUALITY:
#
#   secrets                17 cases -> Request,         no exceptions
#   serviceaccounts/token   2 cases -> Request,         no exceptions
#   tokenreviews           12 cases -> Metadata,        no exceptions
#   configmaps             35 cases -> Metadata, EXCEPT exactly the 3 triples in
#                                     apc.KUBE_SYSTEM_CONFIGMAP_EXEMPTIONS -> None
#   clusterroles           28 cases -> RequestResponse, EXCEPT the 12 whose verb is
#                                     in apc.KNOWN_API_READ_VERBS -> Request
#
# 94 cases, every one of them classified by `apc.required_sensitive_level`, and the
# per-resource per-level cardinality pinned by `apc.SENSITIVE_RESOURCE_PARTITION`
# so an exhaustive check cannot become vacuous by losing cases.
#
# THE EXPECTED LEVELS ARE NOT READ FROM `case.level`. They are computed from the
# partition and compared against what the SHIPPED POLICY's evaluator returns, so
# this is an independent statement about the artefact rather than a restatement of
# the transcription. `test_case_matrix_shape_matches_the_oracle` separately proves
# the transcription itself, and the two agreeing is what makes either meaningful.


def _sensitive_resource_cases() -> tuple[apc.AuditPolicyCase, ...]:
    """Every case in the matrix whose resource is one of the five sensitive ones."""
    return tuple(
        case
        for case in _CASES
        if case.selector is not None
        and case.selector.policy_resource in apc.SENSITIVE_RESOURCE_PARTITION
    )


def test_the_sensitive_resource_partition_holds_for_every_case(
    audit_policy_evaluator: PolicyRuleEvaluator,
    subtests: pytest.Subtests,
) -> None:
    """INVARIANT LOCKED: **F-006-RQ-001** over the WHOLE sensitive-resource surface.

    Every one of the 94 sensitive-resource requests in the matrix is evaluated
    against the shipped policy and required to sit at EXACTLY the level
    :func:`tests.fixtures.audit_policy_cases.required_sensitive_level` assigns it.
    Exactly, in both directions: raising ``secrets`` to ``RequestResponse`` would
    make the API server log secret bodies and issued bearer tokens, and lowering it
    to ``Metadata`` would give up the forensic detail the V6 remediation restored.
    Both are silent failures, which is why the expected value is computed rather
    than probed.

    Findings ACCUMULATE, one subtest per case, because a partition that has drifted
    has usually drifted in more than one place and a reader needs the whole shape
    of the drift rather than its alphabetically first instance.
    """
    sensitive = _sensitive_resource_cases()

    # A vacuity guard first. An exhaustive assertion over an empty or shrunken set
    # is worse than no assertion, because it looks complete.
    expected_total = sum(
        count
        for levels in apc.SENSITIVE_RESOURCE_PARTITION.values()
        for count in levels.values()
    )
    assert len(sensitive) == expected_total, (
        f"{REQUIREMENT_ID}: the matrix holds {len(sensitive)} sensitive-resource cases but the "
        f"measured partition accounts for {expected_total}. An exhaustive boundary check over "
        f"the wrong number of cases proves nothing, so this is setup breakage rather than a "
        f"finding: re-measure the partition in tests/fixtures/audit_policy_cases.py."
    )

    for case in sensitive:
        assert case.selector is not None  # narrowed by _sensitive_resource_cases
        resource = case.selector.policy_resource
        required = apc.required_sensitive_level(
            resource, case.principal.name, case.verb, case.selector.namespace
        )
        with subtests.test(case=case.id):
            config = audit_policy_evaluator.evaluate(_attributes_for(case))
            assert config.level == required.wire, (
                f"{REQUIREMENT_ID}: {resource!r} requested by {case.principal.name!r} with verb "
                f"{case.verb!r} in namespace {case.selector.namespace!r} is recorded at "
                f"{config.level!r} but the V6 boundary requires EXACTLY {required.wire!r} "
                f"(declared at cluster/gce/gci/audit_policy_test.go L{case.go_line}). "
                f"The complete partition, including both of its exception sets, is "
                f"tests.fixtures.audit_policy_cases.required_sensitive_level."
            )


def test_the_sensitive_resource_partition_cardinality_is_exact(
    audit_policy_evaluator: PolicyRuleEvaluator,
    subtests: pytest.Subtests,
) -> None:
    """INVARIANT LOCKED: how MANY cases sit at each level, per resource.

    The case-by-case assertion above cannot see a case that has disappeared, and it
    cannot see one that has migrated from the rule to the exception while its own
    expectation migrated with it. Counting closes both: the levels the SHIPPED
    POLICY actually assigns are tallied per resource and compared against the
    measured partition.

    The tally is built from the evaluator's answers rather than from
    ``required_sensitive_level``, so this is not a tautology - if the shipped policy
    moved twelve ``clusterroles`` reads up to ``RequestResponse``, the count changes
    here even though the total stays 28.
    """
    observed: dict[str, collections.Counter[str]] = collections.defaultdict(
        collections.Counter
    )
    for case in _sensitive_resource_cases():
        assert case.selector is not None
        config = audit_policy_evaluator.evaluate(_attributes_for(case))
        observed[case.selector.policy_resource][config.level] += 1

    for resource, expected_levels in apc.SENSITIVE_RESOURCE_PARTITION.items():
        with subtests.test(resource=resource):
            assert dict(observed[resource]) == dict(expected_levels), (
                f"{REQUIREMENT_ID}: the shipped policy records {resource!r} as "
                f"{dict(observed[resource])} across the matrix, but the measured V6 partition "
                f"is {dict(expected_levels)}. A changed count means cases moved between the "
                f"rule and its exception, which is the shape a silent widening takes."
            )


def test_the_kube_system_configmap_exemption_is_exactly_the_enumerated_set(
    audit_policy_evaluator: PolicyRuleEvaluator,
) -> None:
    """INVARIANT LOCKED: the ONLY sensitive requests recorded at ``None``.

    THE EXEMPTION THAT MUST NOT WIDEN. Three ``configmaps`` requests in the whole
    620-case matrix are dropped rather than recorded, because two principals poll
    kube-system configmaps at a volume the generator drops
    (audit_policy_test.go L135 and L158). That is a deliberate, reviewed narrowing,
    and the way a deliberate narrowing becomes an accidental one is by widening a
    case at a time while a prose note keeps describing the original three.

    So the exemption is asserted as SET EQUALITY against the evaluator's own
    answers: a fourth dropped case fails, a removed one fails, and a principal,
    verb or namespace that drifts fails. Bare asserts rather than subtests -- a
    changed exemption set invalidates the partition above, so there is nothing to
    accumulate alongside it.

    The scoping control is asserted too: the same two principals reading
    ``configmaps`` in the DEFAULT namespace must still be recorded at ``Metadata``
    (Go L136, L159). Without it the exemption could grow to cover the principal
    everywhere while this test still saw exactly three kube-system triples.
    """
    dropped: set[tuple[str, str, str]] = set()
    for case in _sensitive_resource_cases():
        assert case.selector is not None
        config = audit_policy_evaluator.evaluate(_attributes_for(case))
        if config.level == apc.AuditLevel.NONE.wire:
            dropped.add((case.principal.name, case.verb, case.selector.namespace))

    assert dropped == set(apc.KUBE_SYSTEM_CONFIGMAP_EXEMPTIONS), (
        f"{REQUIREMENT_ID}: the shipped policy drops {sorted(dropped)} among sensitive "
        f"resources, but the reviewed exemption is exactly "
        f"{sorted(apc.KUBE_SYSTEM_CONFIGMAP_EXEMPTIONS)} -- the high-volume kube-system "
        f"configmaps polling recorded at audit_policy_test.go L135 and L158. Any addition is "
        f"a new blind spot in the audit record; any removal is a change to the shipped "
        f"generator's behaviour."
    )
    assert all(namespace == "kube-system" for _user, _verb, namespace in dropped), (
        f"{REQUIREMENT_ID}: a sensitive-resource request outside kube-system is being dropped: "
        f"{sorted(dropped)}. The exemption exists for kube-system polling volume and must "
        f"never escape that namespace."
    )

    # THE SCOPING CONTROL. The same principals in the `default` namespace stay at
    # Metadata, which is what proves the exemption is about the namespace rather
    # than about the principal.
    for principal_name, verb, _namespace in sorted(apc.KUBE_SYSTEM_CONFIGMAP_EXEMPTIONS):
        principal = next(
            candidate for candidate in apc.ALL_PRINCIPALS if candidate.name == principal_name
        )
        config = audit_policy_evaluator.evaluate(
            RequestAttributes(
                user=principal.name,
                groups=principal.groups,
                verb=verb,
                namespace=apc.CONFIGMAPS.namespace,
                api_group=apc.CONFIGMAPS.group,
                api_version=apc.API_VERSION,
                resource=apc.CONFIGMAPS.resource,
                subresource=apc.CONFIGMAPS.subresource,
                resource_request=True,
            )
        )
        assert config.level == apc.AuditLevel.METADATA.wire, (
            f"{REQUIREMENT_ID}: {principal_name!r} performing {verb!r} on configmaps in "
            f"{apc.CONFIGMAPS.namespace!r} is recorded at {config.level!r}, but must be "
            f"{apc.AuditLevel.METADATA.wire!r} (audit_policy_test.go L136, L159). The "
            f"kube-system exemption has escaped its namespace."
        )


def test_clusterroles_reads_and_writes_are_split_at_exactly_the_known_api_verbs(
    audit_policy_evaluator: PolicyRuleEvaluator,
    subtests: pytest.Subtests,
) -> None:
    """INVARIANT LOCKED: which verbs put an RBAC object at ``RequestResponse``.

    AAP §0.10.2 records ``clusterroles`` at exactly ``RequestResponse``, and the
    generated policy delivers that for every MUTATING verb while lowering
    ``get``/``list``/``watch`` to ``Request`` one rule earlier because those
    responses can be large (audit_policy_test.go L180 versus L181). Both halves
    matter and each fails silently on its own: a write recorded at ``Request``
    loses the resulting authorization surface from the audit record, and a read
    promoted to ``RequestResponse`` starts logging whole ClusterRole listings.

    The split is asserted at the VERB, over every clusterroles case, so it is the
    boundary itself that is locked rather than one example of it on each side.
    """
    for case in _sensitive_resource_cases():
        assert case.selector is not None
        if case.selector.policy_resource != "clusterroles":
            continue
        reading = case.verb in apc.KNOWN_API_READ_VERBS
        required = apc.AuditLevel.REQUEST if reading else apc.AuditLevel.RESPONSE
        with subtests.test(verb=case.verb, case=case.id):
            config = audit_policy_evaluator.evaluate(_attributes_for(case))
            assert config.level == required.wire, (
                f"{REQUIREMENT_ID}: clusterroles under verb {case.verb!r} is recorded at "
                f"{config.level!r}; a "
                f"{'read' if reading else 'mutating verb'} must be recorded at "
                f"{required.wire!r} (audit_policy_test.go "
                f"L{180 if reading else 181})."
            )


def test_the_headline_mapping_is_the_partition_rule_not_a_cherry_picked_row(
    audit_policy_evaluator: PolicyRuleEvaluator,
    subtests: pytest.Subtests,
) -> None:
    """The flat ``SENSITIVE_RESOURCE_LEVELS`` mapping is kept honest.

    That mapping is what the L2 integration module reads to check the level of an
    observed audit event, so it has to state the RULE rather than a value that
    happens to hold somewhere. Here each entry is required to be the level the
    partition assigns to a NON-EXEMPT request for that resource -- for
    ``configmaps`` a namespace outside the exemption, for ``clusterroles`` a
    mutating verb -- and to be the level the shipped policy actually returns for it.

    It also asserts that the mapping's key set is exactly the partition's, so a
    sixth sensitive resource cannot be added to one and forgotten in the other.
    """
    assert set(apc.SENSITIVE_RESOURCE_LEVELS) == set(apc.SENSITIVE_RESOURCE_PARTITION), (
        f"{REQUIREMENT_ID}: SENSITIVE_RESOURCE_LEVELS covers "
        f"{sorted(apc.SENSITIVE_RESOURCE_LEVELS)} but the partition covers "
        f"{sorted(apc.SENSITIVE_RESOURCE_PARTITION)}. The two must name the same resources."
    )

    # One non-exempt representative per resource: the `default` ServiceAccount, a
    # mutating verb, and the resource's own selector. Every one of these is a real
    # row of the matrix (Go L177-L181).
    representatives: tuple[tuple[apc.ResourceSelector, str, int], ...] = (
        (apc.SECRETS, "create", 178),
        (apc.SA_TOKENS, "create", 179),
        (apc.CONFIGMAPS, "create", 177),
        (apc.TOKEN_REVIEWS, "create", 177),
        (apc.CLUSTER_ROLES, "create", 181),
    )
    covered = {selector.policy_resource for selector, _verb, _line in representatives}
    assert covered == set(apc.SENSITIVE_RESOURCE_LEVELS), (
        f"{REQUIREMENT_ID}: the representatives cover {sorted(covered)}, not "
        f"{sorted(apc.SENSITIVE_RESOURCE_LEVELS)}."
    )

    for selector, verb, go_line in representatives:
        resource = selector.policy_resource
        headline = apc.SENSITIVE_RESOURCE_LEVELS[resource]
        required = apc.required_sensitive_level(
            resource, apc.DEFAULT_SA.name, verb, selector.namespace
        )
        with subtests.test(resource=resource, verb=verb):
            assert required == headline, (
                f"{REQUIREMENT_ID}: the partition assigns {resource!r} under verb {verb!r} the "
                f"level {required.wire!r} while SENSITIVE_RESOURCE_LEVELS declares "
                f"{headline.wire!r}. The flat mapping must state the rule, not an exception."
            )
            config = audit_policy_evaluator.evaluate(
                RequestAttributes(
                    user=apc.DEFAULT_SA.name,
                    groups=apc.DEFAULT_SA.groups,
                    verb=verb,
                    namespace=selector.namespace,
                    api_group=selector.group,
                    api_version=apc.API_VERSION,
                    resource=selector.resource,
                    subresource=selector.subresource,
                    resource_request=True,
                )
            )
            assert config.level == headline.wire, (
                f"{REQUIREMENT_ID}: {resource!r} under verb {verb!r} is recorded at "
                f"{config.level!r} but must be recorded at EXACTLY {headline.wire!r} "
                f"(declared at cluster/gce/gci/audit_policy_test.go L{go_line})"
            )


# ---------------------------------------------------------------------------
# The level ordering: a strict total order, so nothing can be downgraded quietly
# ---------------------------------------------------------------------------


def test_audit_levels_form_a_strict_total_order() -> None:
    """``None < Metadata < Request < RequestResponse``, and the wire spellings.

    INVARIANT LOCKED: the disclosure order AAP §0.4.2.1 asks be asserted "as a
    strict total order so no future edit can silently downgrade a level". Every
    V6 expectation is a statement about a POSITION in this order - ``secrets`` at
    ``Request`` means "more than Metadata, less than RequestResponse" - so if the
    order itself could be edited, every one of the 620 assertions would lose its
    meaning while continuing to pass.

    Also asserts the four WIRE strings, because a renamed member and a reordered
    one are different defects and only one of them is caught by the chain. In
    particular ``RequestResponse`` is deliberately not spelled ``Response`` even
    though the Go test's local alias for it is ``response``: the alias is a Go
    identifier, the wire string is the contract, and the audit policy carries the
    latter.

    Separated from :func:`test_audit_level` so its node id cannot be confused with
    one of the 620, and asserted with bare asserts because a broken ordering
    invalidates the whole matrix.
    """
    assert (
        apc.AuditLevel.NONE
        < apc.AuditLevel.METADATA
        < apc.AuditLevel.REQUEST
        < apc.AuditLevel.RESPONSE
    ), (
        f"{REQUIREMENT_ID}: the audit levels must order strictly from least to most disclosure; "
        f"got ranks {[level.rank for level in apc.LEVEL_ORDER]}"
    )
    assert apc.LEVEL_WIRE_STRINGS == ("None", "Metadata", "Request", "RequestResponse")
    assert [level.rank for level in apc.LEVEL_ORDER] == [0, 1, 2, 3]
    assert apc.AuditLevel.NONE.wire == DEFAULT_AUDIT_LEVEL
    # Lexicographic order is NOT this order, and confusing the two would invert
    # exactly the comparison V6 depends on: sorted() puts "Metadata" before
    # "None". Asserted so nobody "simplifies" a level comparison into a string
    # comparison.
    assert sorted(apc.LEVEL_WIRE_STRINGS) != list(apc.LEVEL_WIRE_STRINGS)


def test_audit_level_order_axioms_hold_for_every_triple(subtests: pytest.Subtests) -> None:
    """The order is irreflexive, trichotomous, antisymmetric and transitive.

    INVARIANT LOCKED: that ``AuditLevel``'s comparison operators really define a
    strict total order, rather than merely happening to order the four members the
    way :func:`test_audit_levels_form_a_strict_total_order` checks.

    EXHAUSTIVE AND DETERMINISTIC, which is the whole point. The axioms are
    statements about ALL triples, and the domain is FOUR members - so the complete
    truth table is ``itertools.product(LEVEL_ORDER, repeat=3)``, all 64 triples,
    enumerated in a fixed order. A property-based strategy sampling the same
    domain would be strictly weaker: sampling 64 examples from 64 triples does not
    cover all 64 (it draws with replacement and shrinks toward simple values), so a
    defect confined to one triple could pass and then fail on a later run. When the
    domain is small enough to enumerate, enumerating it is not just cheaper than
    sampling - it is the only formulation whose claim of exhaustiveness is true.

    Cheap enough not to distort the 620-case runtime: 64 triples of pure integer
    comparisons. No fixture beyond ``subtests`` is requested and nothing is
    written, so the test is order-independent and xdist-safe by construction.

    ACCUMULATE semantics: one subtest per triple, so a broken ordering reports
    EVERY triple it breaks in a single run rather than only the first. The axioms
    are independent findings about independent triples, which is exactly the
    accumulate case (AAP §0.4.1.2); the whole-order assertions that must abort live
    in :func:`test_audit_levels_form_a_strict_total_order`.
    """
    triples = tuple(itertools.product(apc.LEVEL_ORDER, repeat=3))
    # The guard against a silently emptied enumeration: 4 levels cubed is 64, and
    # if LEVEL_ORDER ever shrank this test would keep passing while examining
    # almost nothing.
    assert len(triples) == len(apc.LEVEL_ORDER) ** 3 == 64, (
        f"{REQUIREMENT_ID}: expected the complete truth table of "
        f"{len(apc.LEVEL_ORDER)}**3 triples, got {len(triples)}"
    )

    for first, second, third in triples:
        with subtests.test(first=first.wire, second=second.wire, third=third.wire):
            # Irreflexivity, and its consequence for <= / >=.
            assert not first < first
            assert not first > first
            assert first <= first
            assert first >= first

            # Trichotomy: exactly one of <, ==, > holds for any pair.
            relations = [first < second, first == second, first > second]
            assert relations.count(True) == 1, (
                f"{REQUIREMENT_ID}: exactly one of <, == and > must hold for "
                f"({first.wire}, {second.wire}); got {relations}"
            )

            # Antisymmetry, both directions.
            assert (first < second) == (second > first)
            assert (first <= second) == (second >= first)

            # Transitivity, which is what forbids a cycle among the four levels.
            if first < second and second < third:
                assert first < third, (
                    f"{REQUIREMENT_ID}: the ordering is not transitive: {first.wire} < "
                    f"{second.wire} < {third.wire} but not {first.wire} < {third.wire}"
                )

            # The rank and the operators are two spellings of one order, so they
            # must agree; a test that trusted only one could not catch the other
            # drifting.
            assert (first < second) == (first.rank < second.rank)


# ---------------------------------------------------------------------------
# The loader: a malformed or missing policy must fail LOUDLY
# ---------------------------------------------------------------------------
# AAP §0.4.2.1's error case for this blueprint, in its own words: "a malformed or
# missing policy file must fail loudly, never silently pass". A loader that
# tolerated a defect would let a broken generator produce a policy the evaluator
# read as "no rules match", and every one of the 620 cases whose expectation is
# `None` would still pass - a suite reporting 280 green results about a policy
# that audits nothing.
#
# The regexes below are matched against the raised message, so each case also
# asserts that the message names WHICH field is wrong. Every entry corresponds to
# a distinct refusal in the loader.

_VALID_MINIMAL_POLICY: Final[str] = """
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
    omitStages: ["RequestReceived"]
"""

_MALFORMED_POLICIES: Final[tuple[tuple[str, str, str], ...]] = (
    (
        "document-is-a-list",
        "- level: Metadata\n",
        "must be a mapping",
    ),
    (
        "document-is-a-scalar",
        "just a string\n",
        "must be a mapping",
    ),
    (
        "not-yaml",
        "apiVersion: [audit.k8s.io/v1\nkind: Policy\n",
        "failed decoding the audit policy",
    ),
    (
        "wrong-api-version",
        "apiVersion: audit.k8s.io/v2\nkind: Policy\nrules: [{level: Metadata}]\n",
        "unknown group version field",
    ),
    (
        "missing-api-version",
        "kind: Policy\nrules: [{level: Metadata}]\n",
        "unknown group version field",
    ),
    (
        "wrong-kind",
        "apiVersion: audit.k8s.io/v1\nkind: NotAPolicy\nrules: [{level: Metadata}]\n",
        "unknown kind field",
    ),
    (
        "missing-rules",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n",
        "rules must be a list of policy rules",
    ),
    (
        "rules-is-a-mapping",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: {level: Metadata}\n",
        "rules must be a list of policy rules",
    ),
    (
        "zero-rules",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: []\n",
        "loaded illegal policy with 0 rules",
    ),
    (
        "rule-is-a-scalar",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: ['Metadata']\n",
        "rules.0. must be a mapping",
    ),
    (
        "missing-level",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{verbs: ['get']}]\n",
        "rules.0..level is required and must be one of",
    ),
    (
        # `level: null` is the trap PyYAML sets: `level: None` is the STRING
        # 'None' and valid, while every YAML spelling of null decodes to Python
        # None and is not a level at all.
        "level-is-yaml-null",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: null}]\n",
        "rules.0..level is required and must be one of",
    ),
    (
        "level-is-unknown",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: Everything}]\n",
        "got 'Everything'",
    ),
    (
        "level-is-lowercase",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: request}]\n",
        "got 'request'",
    ),
    (
        "omit-stages-is-a-scalar",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, omitStages: RequestReceived}]\n",
        "rules.0..omitStages must be a list of strings",
    ),
    (
        "omit-stages-entry-is-not-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: Metadata, omitStages: [7]}]\n",
        "rules.0..omitStages.0. must be a string",
    ),
    (
        "omit-stages-entry-is-unknown",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, omitStages: ['RequestRecieved']}]\n",
        "got 'RequestRecieved'",
    ),
    (
        "policy-omit-stages-entry-is-unknown",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nomitStages: ['Everything']\n"
        "rules: [{level: Metadata}]\n",
        "omitStages.0. must be one of",
    ),
    (
        "users-is-a-scalar",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: Metadata, users: kubelet}]\n",
        "rules.0..users must be a list of strings",
    ),
    (
        "verbs-entry-is-not-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: Metadata, verbs: [true]}]\n",
        "rules.0..verbs.0. must be a string",
    ),
    (
        "resources-is-a-mapping",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: {group: ''}}]\n",
        "must be a list of group-resource mappings",
    ),
    (
        "resources-entry-is-a-scalar",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: ['secrets']}]\n",
        "rules.0..resources.0. must be a mapping",
    ),
    (
        "resources-entry-group-is-not-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: 3}]}]\n",
        "resources.0..group must be a string",
    ),
    (
        "resources-entry-resources-is-a-scalar",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: '', resources: secrets}]}]\n",
        "resources.0..resources must be a list of strings",
    ),
    (
        "resources-entry-resource-names-entry-is-not-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: '', resourceNames: [1]}]}]\n",
        "resourceNames.0. must be a string",
    ),
    (
        "non-resource-urls-is-a-scalar",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, nonResourceURLs: /healthz}]\n",
        "nonResourceURLs must be a list of strings",
    ),
    (
        # A NUMBER, not `null`. Go's decoder refuses a JSON number in a string
        # list, so this case belongs in a roster whose framing is "Go refuses
        # these too"; `null` in a string list is the one place the two loaders
        # disagree and it is pinned separately by
        # `test_loader_is_stricter_than_go_about_a_null_string_list_entry`.
        "namespaces-entry-is-not-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, namespaces: [7]}]\n",
        "rules.0..namespaces.0. must be a string",
    ),
    (
        "rule-omit-managed-fields-is-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, omitManagedFields: 'true'}]\n",
        "rules.0..omitManagedFields must be a boolean",
    ),
    (
        "policy-omit-managed-fields-is-a-number",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nomitManagedFields: 1\n"
        "rules: [{level: Metadata}]\n",
        "omitManagedFields must be a boolean",
    ),
    # ---------------------------------------------------------------------
    # validation.ValidatePolicy's value checks: documents that DECODE
    # cleanly and are still refused, because the API server refuses them
    # ---------------------------------------------------------------------
    # Every case below is well-formed YAML with well-typed fields, so the
    # structural readers above pass it through untouched. What refuses it is
    # the ported ``ValidatePolicy`` - and what makes each case matter is that
    # `kube-apiserver` runs the same validator over `--audit-policy-file` and
    # exits rather than start. A loader that accepted these would report a
    # green V6 suite for a policy that takes the control plane down at boot.
    (
        # validation.go L86-88.
        "non-resource-url-missing-leading-slash",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: None, nonResourceURLs: ['healthz']}]\n",
        "rules.0..nonResourceURLs.0..*must begin with a '/' character",
    ),
    (
        # The empty string reaches the leading-'/' refusal and NOT the
        # wildcard one, because Go guards the slice with `url != ""` (L90).
        "non-resource-url-is-the-empty-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: None, nonResourceURLs: ['']}]\n",
        "rules.0..nonResourceURLs.0..*must begin with a '/' character",
    ),
    (
        # validation.go L90-92. `/healthz*` is legal, so the boundary being
        # pinned is "final character", not "contains a wildcard".
        "non-resource-url-wildcard-is-not-final",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: None, nonResourceURLs: ['/healthz*/detail']}]\n",
        "nonResourceURLs.0..*must be the final character of the rule",
    ),
    (
        # Two trailing wildcards: the LAST one is final, the one before it is
        # not, which is the off-by-one this case exists to catch.
        "non-resource-url-has-two-trailing-wildcards",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: None, nonResourceURLs: ['/swagger**']}]\n",
        "nonResourceURLs.0..*must be the final character of the rule",
    ),
    (
        # Go's own worked example (validation.go L104-105): a group VERSION
        # pasted where a group belongs.
        "resources-group-is-a-group-version",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: RequestResponse, resources: "
        "[{group: 'rbac.authorization.k8s.io/v1beta1', resources: ['clusterroles']}]}]\n",
        "resources.0..group.*a lowercase RFC 1123 subdomain must consist of lower "
        "case alphanumeric characters",
    ),
    (
        "resources-group-is-not-lower-case",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: 'Apps', resources: ['deployments']}]}]\n",
        "resources.0..group.*a lowercase RFC 1123 subdomain must consist of lower "
        "case alphanumeric characters",
    ),
    (
        # 254 bytes: one past DNS1123_SUBDOMAIN_MAX_LENGTH, and otherwise a
        # perfectly well-formed subdomain, so ONLY the length check can refuse
        # it. Its 253-byte sibling is accepted by
        # `test_loader_accepts_the_shapes_validate_policy_permits`.
        "resources-group-is-one-byte-too-long",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: Metadata, resources: "
        "[{group: '" + "a" * (DNS1123_SUBDOMAIN_MAX_LENGTH + 1) + "', resources: ['x']}]}]\n",
        f"resources.0..group.*must be no more than {DNS1123_SUBDOMAIN_MAX_LENGTH} "
        "characters",
    ),
    (
        # validation.go L111-113. A name with no resource to name it in
        # matches nothing, so the rule silently does nothing at all.
        "resource-names-without-resources",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: Metadata, resources: "
        "[{group: '', resourceNames: ['ingress-uid']}]}]\n",
        "resources.0..resourceNames.*using resourceNames requires at least one resource",
    ),
    (
        # validation.go L45-49, the resources half.
        "non-resource-urls-together-with-resources",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: None, nonResourceURLs: "
        "['/version'], resources: [{group: '', resources: ['secrets']}]}]\n",
        "rules.0..nonResourceURLs.*rules cannot apply to both regular resources and "
        "non-resource URLs",
    ),
    (
        # The namespaces half of the same check - and deliberately with the
        # '*' URL, which the SHAPE check skips. It proves the combined check
        # is reached independently of the shape check rather than as a side
        # effect of it.
        "non-resource-urls-together-with-namespaces",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: None, nonResourceURLs: ['*'], namespaces: ['kube-system']}]\n",
        "rules.0..nonResourceURLs.*rules cannot apply to both regular resources and "
        "non-resource URLs",
    ),
)


@pytest.mark.parametrize(
    ("policy_text", "expected_message"),
    [(text, message) for _name, text, message in _MALFORMED_POLICIES],
    ids=[name for name, _text, _message in _MALFORMED_POLICIES],
)
def test_loader_refuses_a_malformed_policy(policy_text: str, expected_message: str) -> None:
    """Every malformed document is refused, and the refusal names the defect.

    INVARIANT LOCKED: the loader never returns a partially understood policy. Each
    case is a document a broken generator could plausibly emit, and each must
    raise rather than yield a policy whose rules quietly match nothing.
    """
    with pytest.raises(AuditPolicyError, match=expected_message):
        load_policy_from_bytes(policy_text)


def test_loader_accepts_the_minimal_valid_policy() -> None:
    """The positive control for :func:`test_loader_refuses_a_malformed_policy`.

    Without it, a loader that rejected EVERYTHING would pass all 39 negative
    cases - which is the classic way a validation suite ends up asserting nothing.
    :func:`test_loader_accepts_the_shapes_validate_policy_permits` extends the
    same guard to the ``ValidatePolicy`` value checks, whose accept side is where
    an over-eager port would break the shipped policy.
    """
    policy = load_policy_from_bytes(_VALID_MINIMAL_POLICY)
    assert len(policy.rules) == 1
    assert policy.rules[0].level == apc.AuditLevel.METADATA.wire
    assert policy.rules[0].omit_stages == apc.EXPECTED_OMIT_STAGES
    assert policy.omit_stages == ()
    assert policy.omit_managed_fields is False
    # `level: None` is the string 'None', and it is a VALID level. This is the one
    # PyYAML behaviour most likely to be "fixed" into a silent defect, so it is
    # asserted rather than merely described.
    dropping = load_policy_from_bytes(
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: [{level: None}]\n"
    )
    assert dropping.rules[0].level == "None"
    assert dropping.rules[0].level == DEFAULT_AUDIT_LEVEL


# ---------------------------------------------------------------------------
# validation.ValidatePolicy: the VALUE rules, aggregated
# ---------------------------------------------------------------------------
# Distinct from the malformed-document table above, which covers the DECODER's
# type rules. These are the rules a well-typed document can still break, and they
# are the ones the API server applies before it will load a policy at all. A
# loader missing them would evaluate a document kube-apiserver refuses - a green
# suite over a control plane that will not boot.

_INVALID_POLICIES: Final[tuple[tuple[str, str, str], ...]] = (
    (
        # validation.go L86-88.
        "non-resource-url-without-a-leading-slash",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, nonResourceURLs: [healthz]}]\n",
        "must begin with a '/' character",
    ),
    (
        # validation.go L90-92: Go tests url[:len(url)-1], so a trailing * is fine
        # and an interior one is not.
        "non-resource-url-with-an-interior-wildcard",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, nonResourceURLs: ['/api/*/pods']}]\n",
        "must be the final character of the rule",
    ),
    (
        # validation.go L100-110, and Go's own example of the mistake.
        "group-written-as-a-group-version",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: rbac.authorization.k8s.io/v1}]}]\n",
        "lowercase RFC 1123 subdomain",
    ),
    (
        "group-with-upper-case",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: RBAC.k8s.io}]}]\n",
        "lowercase RFC 1123 subdomain",
    ),
    (
        # validation.go L112-114: a narrowing with nothing to narrow WIDENS.
        "resource-names-without-resources",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, resources: [{group: '', resourceNames: [audit-secret]}]}]\n",
        "using resourceNames requires at least one resource",
    ),
    (
        # validation.go L44-48.
        "a-rule-mixing-non-resource-urls-and-resources",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, nonResourceURLs: ['/healthz'], "
        "resources: [{group: '', resources: [secrets]}]}]\n",
        "cannot apply to both regular resources and non-resource URLs",
    ),
    (
        # The same rule, reached through `namespaces` rather than `resources`.
        "a-rule-mixing-non-resource-urls-and-namespaces",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, nonResourceURLs: ['/healthz'], namespaces: [default]}]\n",
        "cannot apply to both regular resources and non-resource URLs",
    ),
)


@pytest.mark.parametrize(
    ("policy_text", "expected_message"),
    [(text, message) for _name, text, message in _INVALID_POLICIES],
    ids=[name for name, _text, _message in _INVALID_POLICIES],
)
def test_loader_refuses_a_policy_the_apiserver_would_refuse(
    policy_text: str, expected_message: str
) -> None:
    """Every ``ValidatePolicy`` rule is enforced, and the refusal names the rule.

    INVARIANT LOCKED: a policy this loader accepts is a policy kube-apiserver would
    accept. Each case is a document the shipped generator could plausibly come to
    emit - a ``nonResourceURLs`` entry that lost its leading slash, a wildcard that
    stopped being final, a group name written as a GroupVersion, a
    ``resourceNames`` narrowing with nothing to narrow, or two rules merged into
    one that mixes selector families - and each is refused rather than evaluated.
    """
    with pytest.raises(AuditPolicyError, match=expected_message):
        load_policy_from_bytes(policy_text)


def test_validation_findings_are_aggregated_not_reported_one_at_a_time() -> None:
    """``ErrorList.ToAggregate()``: every finding in one exception (validation.go L28-35).

    Go accumulates across the policy-level ``omitStages`` and every rule and returns
    the whole list; ``reader.go`` L88-90 hands that aggregate straight to the
    caller. A loader that stopped at the first finding would turn one broken
    generator edit into one bisection per problem, and the count of findings is what
    tells a reader whether they have seen all of them.

    Three DIFFERENT rules across TWO rules of the policy, so this cannot pass by
    accident on a loader that merely reports the last finding it saw.
    """
    with pytest.raises(AuditPolicyError) as raised:
        load_policy_from_bytes(
            "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules:\n"
            "- level: Metadata\n"
            "  nonResourceURLs: [healthz, '/api/*/pods']\n"
            "- level: Metadata\n"
            "  resources: [{group: 'BAD.Group', resourceNames: [x]}]\n"
        )

    message = str(raised.value)
    assert "4 violation(s)" in message, message
    assert "must begin with a '/' character" in message
    assert "must be the final character of the rule" in message
    assert "lowercase RFC 1123 subdomain" in message
    assert "using resourceNames requires at least one resource" in message
    # The path is part of the finding, so a reader with eighteen resource entries
    # knows which one.
    assert "rules[0].nonResourceURLs[0]" in message
    assert "rules[1].resources[0].group" in message


def test_validation_accepts_the_forms_the_generated_policy_actually_uses() -> None:
    """THE CONTROL. Without it every case above could pass on a validator that
    refused everything - the classic way a validation suite asserts nothing.

    Each accepted form below appears in the shipped generated policy: a bare ``*``
    non-resource URL, a trailing-wildcard path, the empty core group, a named group
    that IS a valid subdomain, and a ``resourceNames`` narrowing that does name a
    resource.
    """
    policy = load_policy_from_bytes(
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules:\n"
        "- level: None\n"
        "  nonResourceURLs: ['*', '/healthz', '/api*']\n"
        "- level: Metadata\n"
        "  resources:\n"
        "  - group: ''\n"
        "    resources: [secrets]\n"
        "    resourceNames: [audit-secret]\n"
        "  - group: rbac.authorization.k8s.io\n"
        "  namespaces: [default]\n"
    )

    assert len(policy.rules) == 2
    assert policy.rules[0].non_resource_urls == ("*", "/healthz", "/api*")
    assert policy.rules[1].resources[1].group == "rbac.authorization.k8s.io"


def test_the_shipped_generated_policy_passes_validate_policy(
    generated_audit_policy: GeneratedShellPolicy,
) -> None:
    """The generated document itself is valid, asserted directly rather than implied.

    Every one of the 620 evaluated outcomes already loads this file, so a
    ``ValidatePolicy`` violation would fail them all - but it would fail them as 620
    identical errors about the loader rather than as one statement about the
    artefact. This says it once, about the artefact: the policy the shipped
    ``create-master-audit-policy`` writes is one kube-apiserver would accept.
    """
    validate_policy(_loaded_policy(generated_audit_policy.text))


def test_loader_refuses_an_empty_path() -> None:
    """Go: "file path not specified" (reader.go L47-49)."""
    with pytest.raises(AuditPolicyError, match="audit policy file path not specified"):
        load_policy_from_file("")


def test_loader_refuses_a_missing_file(tmp_path: Path) -> None:
    """A path that does not exist is a read failure, as it is for ``os.ReadFile``."""
    missing = tmp_path / "there-is-no-policy-here.yaml"
    with pytest.raises(AuditPolicyError, match="failed to read audit policy file"):
        load_policy_from_file(missing)


def test_loader_refuses_a_directory(tmp_path: Path) -> None:
    """A directory is a read failure too, and must not be reported as bad YAML."""
    with pytest.raises(AuditPolicyError, match="failed to read audit policy file"):
        load_policy_from_file(tmp_path)


def test_loader_names_the_file_a_malformed_policy_came_from(tmp_path: Path) -> None:
    """A defect found in a FILE reports the path as well as the defect.

    Go appends ": from file %v" for the same reason (reader.go L56-58): the reader
    of a CI failure needs to know which artifact was wrong, and in this tier that
    is a path under a per-test temporary directory.
    """
    policy_file = tmp_path / AUDIT_POLICY_FILE_NAME
    policy_file.write_text("apiVersion: audit.k8s.io/v1\nkind: Policy\nrules: []\n")
    with pytest.raises(AuditPolicyError, match="loaded illegal policy with 0 rules"):
        load_policy_from_file(policy_file)
    with pytest.raises(AuditPolicyError, match="from file"):
        load_policy_from_file(policy_file)


def test_loader_round_trips_the_generated_policy_through_a_file(
    generated_audit_policy: GeneratedShellPolicy,
    tmp_path: Path,
) -> None:
    """Loading the generated text from a fresh file yields the same rules.

    Proves that :func:`load_policy_from_file` and :func:`load_policy_from_bytes`
    agree, which is what lets the negative cases above use the bytes entry point
    while the generation fixture uses the file one.
    """
    copy = tmp_path / AUDIT_POLICY_FILE_NAME
    copy.write_text(generated_audit_policy.text, encoding="utf-8")
    assert load_policy_from_file(copy) == _loaded_policy(generated_audit_policy.text)


def test_a_generator_that_writes_nothing_is_a_failure(tmp_path: Path) -> None:
    """Exit 0 is not evidence that the generator ran; a written file is.

    The invocation exits 0 even though its ``kube-env`` is an unparseable
    fragment, so :func:`require_generated_policy_text` is what turns "the
    generator silently stopped writing" into a named failure instead of 620 cases
    erroring on a missing file.

    The refusal is a ``ManifestHarnessError`` and not an :class:`AuditPolicyError`,
    and the distinction is the point rather than an accident of where the function
    lives: nothing was generated, so nothing has been measured about control V6 and
    there is no policy to call malformed. A HARNESS failure and a CONTROL finding
    must stay different types, because only the second is evidence about the
    system under test.
    """
    missing = tmp_path / AUDIT_POLICY_FILE_NAME
    with pytest.raises(ManifestHarnessError, match="wrote no policy to"):
        require_generated_policy_text(missing, returncode=0, combined_output="syntax error")

    missing.write_text(_VALID_MINIMAL_POLICY, encoding="utf-8")
    assert (
        require_generated_policy_text(missing, returncode=0, combined_output="")
        == _VALID_MINIMAL_POLICY
    )


# ---------------------------------------------------------------------------
# The evaluator's remaining branches, driven by one synthetic policy
# ---------------------------------------------------------------------------
# AAP §0.7.1.3 requires 100% line and branch coverage of security-invariant
# decision logic, and this port of checker.go is exactly that. MEASURED: the
# shipped policy reaches most of it but not all - no rule it emits uses ``*``,
# ``*/subresource``, ``resource/*`` or ``resourceNames``; it declares no
# policy-level ``omitStages`` and no ``omitManagedFields``; it has namespaces only
# on rules that also name resources; and its final catch-all rule means no request
# ever falls through to the default level.
#
# So this one hand-written policy drives every remaining branch. It is TINY, it
# lives in this module because the Python tier's file inventory is fixed by
# AAP §0.5.1, and it makes no statement whatsoever about the shipped generator -
# every such statement is made by the 620 cases above. It is written as YAML and
# loaded through the real loader so that the loader's own remaining branches
# (a policy-level stage list, and ``omitManagedFields`` at both levels) are
# covered by the same value.
#
# NOTE THE ABSENCE OF A CATCH-ALL RULE. That is deliberate: it is the only way to
# reach ``EvaluatePolicyRule``'s default return, which is the branch that decides
# what happens to a request no rule claims.

_SYNTHETIC_POLICY: Final[str] = """
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages: ["ResponseStarted"]
omitManagedFields: true
rules:
  # 0: resourceNames narrows a rule to named objects only.
  - level: Metadata
    omitStages: ["RequestReceived"]
    verbs: ["get"]
    resources:
      - group: ""
        resources: ["configmaps"]
        resourceNames: ["ingress-uid"]
  # 1: the "*/subresource" form, which matches a subresource in any resource.
  - level: Request
    resources:
      - group: ""
        resources: ["*/status"]
  # 2: the "resource/*" form. omitManagedFields overrides the policy default.
  - level: Request
    omitManagedFields: false
    resources:
      - group: ""
        resources: ["pods/*"]
  # 3: the bare "*" resource, scoped to one group.
  - level: RequestResponse
    resources:
      - group: "apps"
        resources: ["*"]
  # 4: namespaces with NO resources - every resource in those namespaces.
  - level: Metadata
    namespaces: ["kube-system"]
  # 5: the "*" non-resource path.
  - level: Metadata
    nonResourceURLs: ["*"]
  # 6: userGroups selection, to reach both the matched and unmatched arms.
  - level: RequestResponse
    userGroups: ["system:masters"]
    resources:
      - group: ""
        resources: ["secrets"]
  # 7: users selection, to reach the "request carries no user" arm.
  - level: Request
    users: ["system:apiserver"]
    verbs: ["deletecollection"]
"""


#: An evaluator over :data:`_SYNTHETIC_POLICY`.
#:
#: AN ORDINARY IMMUTABLE VALUE, not a fixture. Fixture injection buys nothing
#: here -- there is no setup to sequence, no teardown to register and no
#: per-test variation -- and AAP §0.4.4.1 puts fixtures in ``conftest.py``, which
#: this policy has no business travelling to: it is test DATA for the evaluator
#: branches the shipped policy never reaches, and it belongs beside the tests that
#: read it.
#:
#: Built once at import and shared by the seven tests below, which is safe for the
#: same reason the generated evaluator is safe to share: :class:`AuditPolicy`,
#: :class:`PolicyRule` and :class:`PolicyRuleEvaluator` are all frozen, so there is
#: nothing here for one test to mutate and another to observe. Loading it through
#: the REAL loader (rather than constructing the dataclasses directly) is what also
#: covers the loader's own remaining branches -- a policy-level stage list and
#: ``omitManagedFields`` at both levels.
SYNTHETIC_EVALUATOR: Final[PolicyRuleEvaluator] = PolicyRuleEvaluator(
    load_policy_from_bytes(_SYNTHETIC_POLICY)
)


def _resource_request(
    resource: str,
    *,
    verb: str = "get",
    namespace: str = "default",
    api_group: str = "",
    subresource: str = "",
    name: str = "",
    user: str | None = "system:serviceaccount:default:default",
    groups: tuple[str, ...] = (apc.GROUP_ALL_AUTHENTICATED,),
) -> RequestAttributes:
    """A resource request, for the synthetic cases. Defaults are the common case."""
    return RequestAttributes(
        user=user,
        groups=groups,
        verb=verb,
        namespace=namespace,
        api_group=api_group,
        api_version=apc.API_VERSION,
        resource=resource,
        subresource=subresource,
        name=name,
        resource_request=True,
    )


def test_synthetic_policy_wildcard_and_name_matching(
    subtests: pytest.Subtests,
) -> None:
    """The four resource-matching forms the shipped policy never uses.

    INVARIANT LOCKED: this port of ``ruleMatchesResource`` implements Go's four
    forms - exact, ``*``, ``*/subresource`` and ``resource/*`` - and honours
    ``resourceNames`` in both directions. A port that quietly treated ``*`` as a
    literal, or ignored ``resourceNames``, would still pass all 620 cases against
    the shipped policy and would then misjudge the first policy that used either.
    """
    checks: tuple[tuple[str, RequestAttributes, str], ...] = (
        # resourceNames, matching: rule 0 claims only the named ConfigMap.
        (
            "resourceNames matches the requested object",
            _resource_request("configmaps", name="ingress-uid"),
            apc.AuditLevel.METADATA.wire,
        ),
        # "*/status": rule 1, reached because rule 0 needs a named configmap.
        (
            "*/subresource matches any resource's status",
            _resource_request("nodes", namespace="", subresource="status"),
            apc.AuditLevel.REQUEST.wire,
        ),
        # "pods/*": rule 2. Rule 1 is tried first and rejects it, because the
        # subresource is not "status".
        (
            "resource/* matches any subresource of that resource",
            _resource_request("pods", subresource="log"),
            apc.AuditLevel.REQUEST.wire,
        ),
        # A bare "*" in one group: rule 3. Also proves group scoping - rule 1's
        # core-group "*/status" does not reach an `apps` request.
        (
            "* matches every resource in its group",
            _resource_request("deployments", api_group="apps", verb="create"),
            apc.AuditLevel.RESPONSE.wire,
        ),
        # Namespaces with no resources: rule 4's `len(r.Resources) == 0` arm.
        (
            "a namespace rule with no resources matches every resource there",
            _resource_request("endpoints", namespace="kube-system"),
            apc.AuditLevel.METADATA.wire,
        ),
        # userGroups matched: rule 6.
        (
            "userGroups selects a request by group",
            _resource_request(
                "secrets",
                groups=(apc.GROUP_ALL_AUTHENTICATED, apc.GROUP_MASTERS),
                user="admin",
            ),
            apc.AuditLevel.RESPONSE.wire,
        ),
    )
    for description, attrs, expected in checks:
        with subtests.test(check=description):
            assert SYNTHETIC_EVALUATOR.evaluate(attrs).level == expected, description


def test_synthetic_policy_falls_through_to_the_default_level(
    subtests: pytest.Subtests,
) -> None:
    """A request no rule claims is recorded at ``None`` with the POLICY's stages.

    INVARIANT LOCKED: ``EvaluatePolicyRule``'s default return - Go's
    ``DefaultAuditLevel`` plus the policy-level ``OmitStages`` (checker.go L75-79).
    The shipped policy cannot reach it, because its final rule matches everything;
    that is itself worth knowing, and it is why this branch needs a policy without
    a catch-all to be tested at all.

    The three requests below also cover the negative arms of the three selector
    filters: an unlisted ``resourceNames`` object, a user whose groups do not
    include the rule's, and a request that carries NO USER at all - Go's explicit
    ``user == nil`` checks (checker.go L98, L103).
    """
    unclaimed: tuple[tuple[str, RequestAttributes], ...] = (
        (
            "resourceNames does not list this object",
            _resource_request("configmaps", name="some-other-configmap"),
        ),
        (
            "the user's groups do not include the rule's",
            _resource_request("secrets", user="alice", groups=(apc.GROUP_ALL_AUTHENTICATED,)),
        ),
        (
            "the request carries no user at all",
            _resource_request("secrets", user=None, groups=(), verb="deletecollection"),
        ),
    )
    for description, attrs in unclaimed:
        with subtests.test(check=description):
            config = SYNTHETIC_EVALUATOR.evaluate(attrs)
            assert config.level == DEFAULT_AUDIT_LEVEL, description
            assert config.omit_stages == ("ResponseStarted",), (
                "an unmatched request must carry the POLICY-level omitStages, not an empty list"
            )
            assert config.omit_managed_fields is True


def test_synthetic_policy_non_resource_wildcard() -> None:
    """``nonResourceURLs: ["*"]`` matches any path, and only non-resource requests.

    INVARIANT LOCKED: ``pathMatches``'s ``spec == "*"`` arm (checker.go L153-155),
    which the shipped policy never uses - it spells its wildcards as the prefix
    forms ``/healthz*`` and ``/swagger*`` - together with
    ``ruleMatchesNonResource``'s refusal to match a resource request.
    """
    config = SYNTHETIC_EVALUATOR.evaluate(
        RequestAttributes(
            user="system:anonymous",
            groups=(apc.GROUP_ALL_UNAUTHENTICATED,),
            verb="get",
            resource_request=False,
            path="/some/path/no/other/rule/claims",
        )
    )
    assert config.level == apc.AuditLevel.METADATA.wire
    # Rule 5 carries no omitStages of its own, so it inherits exactly the
    # policy-level list - the union with an empty rule list.
    assert config.omit_stages == ("ResponseStarted",)


def test_synthetic_policy_unions_the_policy_and_rule_stage_lists() -> None:
    """A rule's stages are the UNION with the policy's. Go: ``unionStages``.

    INVARIANT LOCKED: ``NewPolicyRuleEvaluator``'s one act (checker.go L34-36).
    The shipped policy declares no policy-level ``omitStages``, so against it the
    union is indistinguishable from the rule's own list and a port that simply
    ignored the policy level would pass all 620 cases. Compared as SETS because
    Go's own order here is unspecified.
    """
    rules = SYNTHETIC_EVALUATOR.rules
    assert set(rules[0].omit_stages) == {"ResponseStarted", apc.AUDIT_STAGE_REQUEST_RECEIVED}, (
        "rule 0 declares RequestReceived and the policy declares ResponseStarted, so the "
        "evaluated rule must omit both"
    )
    assert set(rules[1].omit_stages) == {"ResponseStarted"}, (
        "a rule with no omitStages of its own inherits exactly the policy-level list"
    )
    # The union is idempotent and de-duplicates, which is what makes it a union
    # rather than a concatenation.
    assert _union_stages(("a", "b"), ("b", "c"), ()) == ("a", "b", "c")
    assert _union_stages((), ()) == ()


def test_synthetic_policy_resolves_omit_managed_fields_per_rule() -> None:
    """A rule-level ``omitManagedFields`` overrides the policy default.

    INVARIANT LOCKED: ``isOmitManagedFields`` (checker.go L86-92). Ported for
    completeness of ``EvaluatePolicyRule``; the Go test asserts nothing about it,
    which is exactly why it is asserted here rather than left as unexercised code
    in a security-critical evaluator.
    """
    # Rule 2 sets it to false against a policy default of true.
    overridden = SYNTHETIC_EVALUATOR.evaluate(_resource_request("pods", subresource="log"))
    assert overridden.level == apc.AuditLevel.REQUEST.wire
    assert overridden.omit_managed_fields is False

    # Rule 1 sets nothing, so the policy default applies.
    inherited = SYNTHETIC_EVALUATOR.evaluate(
        _resource_request("nodes", namespace="", subresource="status")
    )
    assert inherited.level == apc.AuditLevel.REQUEST.wire
    assert inherited.omit_managed_fields is True


def test_path_matching_forms(subtests: pytest.Subtests) -> None:
    """``pathMatches``, form by form. Go: checker.go L151-165.

    INVARIANT LOCKED: the trailing-``*`` form is a PREFIX match computed with a
    cutset trim - Go's ``strings.TrimRight(spec, "*")``, whose Python equivalent
    is ``str.rstrip("*")`` and NOT ``removesuffix("*")``. The distinction only
    shows up on a spec ending in several asterisks, and getting it wrong would
    leave a stray ``*`` in the prefix so that nothing matched at all.
    """
    checks: tuple[tuple[str, str, bool], ...] = (
        ("/anything", "*", True),
        ("/version", "/version", True),
        ("/healthz", "/healthz*", True),
        ("/healthz/etcd", "/healthz*", True),
        ("/swagger-2.0.0.json", "/swagger*", True),
        ("/logs", "/swagger*", False),
        ("/logs", "/version", False),
        ("/metrics", "/metrics/", False),
        # The cutset trim: every trailing asterisk is removed, so the prefix here
        # is "/api" and not "/api*".
        ("/apis/policy", "/api**", True),
        ("/healthz", "", False),
    )
    for path, spec, expected in checks:
        with subtests.test(path=path, spec=spec):
            assert _path_matches(path, spec) is expected


def test_a_rule_with_no_selectors_matches_every_request(subtests: pytest.Subtests) -> None:
    """``ruleMatches``'s final ``return true``. Go: checker.go L131.

    INVARIANT LOCKED: a rule that names no user, group, verb, namespace, resource
    or non-resource URL matches EVERYTHING, resource requests and non-resource
    requests alike. That is how the shipped policy's last rule gives every
    unclaimed request a level, and it is asserted directly here - against a
    one-rule policy - because against the shipped policy the same branch is only
    observable through the requests that reach it.
    """
    evaluator = PolicyRuleEvaluator(load_policy_from_bytes(_VALID_MINIMAL_POLICY))
    requests: tuple[tuple[str, RequestAttributes], ...] = (
        ("a resource request", _resource_request("secrets")),
        (
            "a non-resource request",
            RequestAttributes(user="kubelet", verb="post", resource_request=False, path="/logs"),
        ),
        ("a request with no user", RequestAttributes(resource_request=False, path="/")),
    )
    for description, attrs in requests:
        with subtests.test(check=description):
            config = evaluator.evaluate(attrs)
            assert config.level == apc.AuditLevel.METADATA.wire, description
            assert config.omit_stages == apc.EXPECTED_OMIT_STAGES


def test_evaluation_is_ordered_first_match(subtests: pytest.Subtests) -> None:
    """The FIRST matching rule wins, and later rules are not consulted.

    INVARIANT LOCKED: ``EvaluatePolicyRule``'s loop (checker.go L65-73). Ordering
    is the entire semantics of an audit policy: the shipped file drops
    high-volume traffic in its first ten rules precisely so those requests never
    reach the levels below, and a port that scanned for the "best" match, or
    returned the last one, would produce wrong levels for exactly the requests
    the V6 remediation cares about.

    Asserted with two policies that differ ONLY in rule order, so the assertion
    cannot pass for any other reason.
    """
    secrets_rule = (
        "  - level: Request\n"
        "    omitStages: ['RequestReceived']\n"
        "    resources:\n"
        "      - group: ''\n"
        "        resources: ['secrets']\n"
    )
    catch_all = "  - level: Metadata\n    omitStages: ['RequestReceived']\n"
    header = "apiVersion: audit.k8s.io/v1\nkind: Policy\nrules:\n"
    request = _resource_request("secrets")

    with subtests.test(order="specific rule first"):
        evaluator = PolicyRuleEvaluator(load_policy_from_bytes(header + secrets_rule + catch_all))
        assert evaluator.evaluate(request).level == apc.AuditLevel.REQUEST.wire

    with subtests.test(order="catch-all first"):
        shadowed = PolicyRuleEvaluator(load_policy_from_bytes(header + catch_all + secrets_rule))
        assert shadowed.evaluate(request).level == apc.AuditLevel.METADATA.wire, (
            "a catch-all placed first must shadow every rule below it; if it does not, "
            "evaluation is not ordered first-match"
        )


def test_a_verb_or_namespace_a_rule_does_not_name_is_not_matched(
    subtests: pytest.Subtests,
) -> None:
    """The negative arms of the verb and namespace filters.

    INVARIANT LOCKED: ``ruleMatches``'s verb filter (checker.go L117-121) and
    ``ruleMatchesResource``'s namespace filter (L173-177), including the property
    that a CLUSTER-SCOPED request presents the empty namespace and therefore does
    not match a rule naming any namespace. Without that, a rule scoped to
    ``kube-system`` would silently cover cluster-scoped objects.
    """
    with subtests.test(check="a verb the rule does not name"):
        # Rule 0 names verb "get" only, so "create" falls past it; nothing else
        # claims a core-group configmap in the default namespace.
        assert (
            SYNTHETIC_EVALUATOR.evaluate(
                _resource_request("configmaps", verb="create", name="ingress-uid")
            ).level
            == DEFAULT_AUDIT_LEVEL
        )

    with subtests.test(check="a cluster-scoped request against a namespaced rule"):
        # Rule 4 names namespace "kube-system"; a cluster-scoped request presents
        # "" and must not match it.
        assert (
            SYNTHETIC_EVALUATOR.evaluate(_resource_request("nodes", namespace="")).level
            == DEFAULT_AUDIT_LEVEL
        )

    with subtests.test(check="a non-resource request against a namespaced rule"):
        # Rule 4 has namespaces, so ruleMatchesResource decides - and it refuses a
        # non-resource request outright. Rule 5's "*" then claims it.
        assert (
            SYNTHETIC_EVALUATOR.evaluate(
                RequestAttributes(user="kubelet", verb="get", resource_request=False, path="/logs")
            ).level
            == apc.AuditLevel.METADATA.wire
        )


# ---------------------------------------------------------------------------
# Failure legibility: the messages a CI reader actually sees
# ---------------------------------------------------------------------------


def test_failure_messages_name_the_requirement_and_the_request(
    subtests: pytest.Subtests,
) -> None:
    """The two per-case failure messages are complete, for both request shapes.

    INVARIANT LOCKED: AAP §0.7.2's failure-legibility criterion - "every assertion
    carries a message naming the requirement identifier it enforces ... so a
    failure reads as a requirement violation rather than a value mismatch".

    Exercised DIRECTLY, and not as a side effect of a failing assertion, for two
    reasons. First, the assert message is only evaluated when an assert fails, so
    while the suite is green these builders never run - and a builder that raised
    ``AttributeError`` would be discovered on the one day nobody wants a second
    defect, the day a real security regression is being diagnosed. Second, it is
    the only way to check the message content at all.

    Both branches of :func:`_describe_request` are covered: a resource case names
    the resource with its subresource - the spelling the POLICY uses, which the Go
    subtest name omits - and a non-resource case names the path.
    """
    resource_case = next(case for case in _CASES if case.selector is not None)
    non_resource_case = next(case for case in _CASES if case.selector is None)

    for label, case in (("resource", resource_case), ("non-resource", non_resource_case)):
        wrong = RequestAuditConfig(
            level=apc.AuditLevel.RESPONSE.wire,
            omit_stages=("ResponseComplete",),
        )
        with subtests.test(shape=label, message="level"):
            message = _level_failure(case, wrong)
            assert REQUIREMENT_ID in message
            assert case.id in message
            assert case.principal.name in message
            assert repr(case.verb) in message
            assert case.level.wire in message
            assert f"L{case.go_line}" in message
        with subtests.test(shape=label, message="omitStages"):
            message = _omit_stages_failure(case, wrong)
            assert REQUIREMENT_ID in message
            assert case.id in message
            assert apc.AUDIT_STAGE_REQUEST_RECEIVED in message
            assert "ResponseComplete" in message

    with subtests.test(shape="resource", message="describes the policy spelling"):
        selector = resource_case.selector
        assert selector is not None
        assert selector.policy_resource in _describe_request(resource_case)

    with subtests.test(shape="non-resource", message="describes the path"):
        assert non_resource_case.path in _describe_request(non_resource_case)


# ---------------------------------------------------------------------------
# The loader boundary measured against the real Go loader (ported from the
# CONFIGURATION+SCRIPTING review of the same checkpoint).
# ---------------------------------------------------------------------------



def test_loader_agrees_with_go_that_omit_managed_fields_null_means_absent() -> None:
    """The other side of the same boundary: ``null`` is not always a defect.

    INVARIANT LOCKED: ``omitManagedFields: null`` is a nil ``*bool`` in Go, which
    means "the policy-level default applies", NOT ``false``. Both loaders accept
    it, so the strictness above is genuinely confined to string LIST ENTRIES and
    is not a blanket "no nulls" rule that would misread this field.
    """
    policy = load_policy_from_bytes(
        "apiVersion: audit.k8s.io/v1\nkind: Policy\nomitManagedFields: null\n"
        "rules: [{level: Metadata, omitManagedFields: null}]\n"
    )
    assert policy.omit_managed_fields is False, (
        f"{REQUIREMENT_ID}: an absent policy-level omitManagedFields is false at the policy level"
    )
    assert policy.rules[0].omit_managed_fields is None, (
        f"{REQUIREMENT_ID}: an absent RULE-level omitManagedFields must stay None - the signal "
        "that the policy default applies (checker.go L86-92) - and must NOT collapse to False"
    )
