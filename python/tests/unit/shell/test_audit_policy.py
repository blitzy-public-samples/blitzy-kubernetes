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
boundary: ``secrets`` and ``serviceaccounts/token`` at EXACTLY ``Request``,
``configmaps`` and ``tokenreviews`` at EXACTLY ``Metadata``, RBAC objects at
``RequestResponse`` for mutating verbs, and every rule above ``None`` omitting
the ``RequestReceived`` stage.

WHAT THE GO TEST ACTUALLY ASSERTS, AND WHY THIS MODULE IS NOT A YAML TEST

The Go test never inspects the generated YAML's shape. It loads the policy with
``auditpolicy.LoadPolicyFromFile``, builds ``auditpolicy.NewPolicyRuleEvaluator``
and asks that evaluator, 620 times, what level a request would be recorded at.
The assertions are therefore about EVALUATED OUTCOMES, which is a far stronger
statement than "the file contains the text ``secrets``": it holds the whole
ordered first-match rule list accountable, including which earlier rule
intercepts a request before the one a reader would expect.

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
L70 ``require.NoError`` (policy load)         abort           fixture raises
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

import os
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final

import pytest
import yaml
from hypothesis import given, settings
from hypothesis import strategies as st

from tests.fixtures import audit_policy_cases as apc
from tests.helpers.bash import CONFIGURE_HELPER_SCRIPT
from tests.helpers.manifest import BASE_TEMPLATE_RELATIVE_PATH

# The tier's harness. ``ManifestCaseFactory`` and ``KubeEnvRenderFactory`` are
# both declared in tests/unit/shell/conftest.py's ``__all__``, i.e. they are its
# public API rather than internals, and they are imported here rather than
# consumed through the ``manifest_case`` and ``render_kube_env`` FIXTURES for one
# structural reason: those fixtures are function-scoped, this module needs the
# policy generated ONCE for 620 parametrized items, and a module-scoped fixture
# may not depend on a function-scoped one. See :func:`generated_audit_policy`.
from tests.unit.shell.conftest import KubeEnvRenderFactory, ManifestCaseFactory

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
#: L1156. It takes ``path="${1}"`` and an optional ``policy="${2:-}"`` and reads
#: NO environment variable, which is why a fragment ``kube-env`` cannot break it.
AUDIT_POLICY_FUNC_NAME: Final[str] = "create-master-audit-policy"

#: The file the generator is asked to write, named as Go names it
#: (audit_policy_test.go L53). It is a path the function is GIVEN, not a location
#: it derives, so nothing outside the test's own temporary tree is ever touched.
AUDIT_POLICY_FILE_NAME: Final[str] = "audit_policy.yaml"

#: The ``kube-env`` render target, as the Go call spells it (L65). ``base.template``
#: is rendered as its OWN target here - see the module docstring's first measured
#: behaviour - unlike the etcd and KMS cases, which render a sibling template that
#: invokes the ``base`` template this file defines.
BASE_TEMPLATE_TARGET: Final[str] = "base.template"

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
# (staging/src/k8s.io/apiserver/pkg/audit/policy/reader.go L46-101), plus the
# subset of ``validation.ValidatePolicy`` that guards the values this control
# depends on: a rule's level must be one of the four (validation.go L68-77) and
# every omitted stage must be one of the four (validation.go L61-66).
#
# WHAT IS PORTED AND WHAT IS NOT. Go decodes through a scheme, strictly and then
# leniently, and aggregates every validation error before returning. This port
# uses ``yaml.safe_load`` - there is no scheme to consult - and raises on the
# FIRST problem it finds. The difference is in reporting, not in outcome: the
# AAP blueprint's requirement is that "a malformed or missing policy file must
# fail loudly, never silently pass", and every input Go rejects is rejected
# here. What is deliberately NOT ported is the rest of ``ValidatePolicy``: the
# non-resource-URL and resource shape checks constrain policies a human might
# write, whereas the only policy this module loads is one the shipped generator
# just produced, and its resource shapes are asserted far more directly by the
# 620 evaluated outcomes.
#
# ORDER OF CHECKS mirrors Go's: envelope, then the policy-level fields, then the
# rules, and only then the "0 rules" refusal - which is why an empty ``rules: []``
# reports Go's own message rather than a field error.


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


def _require_rule(value: object, *, where: str) -> PolicyRule:
    """Return one policy rule, or raise naming ``where``.

    Raises:
        AuditPolicyError: for any malformed field; see the individual readers.
    """
    __tracebackhide__ = True
    rule = _require_mapping(value, where=where)
    return PolicyRule(
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
# Generating the policy: the bare struct-literal harness, run once
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GeneratedAuditPolicy:
    """What one run of the shipped generator produced.

    Attributes:
        text: The policy file's contents, read before the case's ``KUBE_HOME``
            was removed. Carried so the shape assertions can decode the SHIPPED
            BYTES rather than re-deriving them from :attr:`policy`, which would
            only prove the loader self-consistent.
        policy: The loaded policy.
        combined_output: Everything the invocation wrote, stdout and stderr
            merged as Go's ``CombinedOutput`` returns them. Carried purely as
            diagnostics, so a failure message can quote it. Deliberately NOT
            asserted on: it contains the bash syntax error the fragment
            ``kube-env`` provokes, and pinning that would fail the suite for a
            template change that has nothing to do with control V6.
    """

    text: str
    policy: AuditPolicy
    combined_output: str


def _require_generated_policy_text(
    policy_file: Path,
    *,
    returncode: int,
    combined_output: str,
) -> str:
    """Read the generated policy file, or raise because nothing was generated.

    A separate function rather than an inline check inside the fixture, so that
    the refusal is itself testable - see
    :func:`test_a_generator_that_writes_nothing_is_a_failure`. The guard matters
    because the invocation exits 0 even though its ``kube-env`` is unparseable
    (see the module docstring): exit status alone is therefore NOT sufficient
    evidence that the generator ran, and without this check a generator that
    silently stopped writing would leave 620 cases erroring on a missing file
    with no explanation.

    Args:
        policy_file: Where the generator was told to write.
        returncode: The invocation's exit status, quoted in the message.
        combined_output: The invocation's merged output, quoted in the message.

    Returns:
        The file's contents.

    Raises:
        AuditPolicyError: if no file exists at ``policy_file``.
    """
    __tracebackhide__ = True
    if not policy_file.is_file():
        raise AuditPolicyError(
            f"{REQUIREMENT_ID}: {AUDIT_POLICY_FUNC_NAME} exited {returncode} but wrote no policy "
            f"to {policy_file}. Combined output:\n{combined_output}"
        )
    return policy_file.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def generated_audit_policy(
    repo_root: Path,
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[GeneratedAuditPolicy]:
    """Run the shipped ``create-master-audit-policy`` ONCE and load its output.

    PORTS: audit_policy_test.go L50-70 in full - the ``os.MkdirTemp`` plus the
    BARE ``ManifestTestCase`` struct literal (L53-58), ``defer c.tearDown()``
    (L59), the ``mustInvokeFunc`` call (L62-67) and the ``LoadPolicyFromFile``
    that follows it (L69-70), including both ``require.NoError`` aborts.

    INVARIANT LOCKED: the policy the 620 cases are judged against is the one the
    SHIPPED bash generator just wrote, from the SHIPPED
    ``testdata/kube-apiserver/base.template``, into a directory this module alone
    owns - never a fixture copy and never a Python re-implementation
    (tech-spec §6.6.1.1).

    THE BARE SHAPE, AND WHY IT MATTERS. The Go harness is a struct literal that
    sets only ``t``, ``kubeHome`` and ``manifestFuncName``, so
    ``mustCopyFromTemplate``, ``mustCopyAuxFromTemplate`` and
    ``mustCreateManifestDstDir`` never run and ``mustLoadPodFromManifest`` is
    never called. ``manifest_case`` is therefore invoked with NO ``manifest``,
    which is the shape ``ManifestCaseFactory`` supports for exactly this caller.
    Only ONE script is sourced - ``configure-helper.sh`` - because that is where
    the function is declared and the apiserver configuration script plays no part
    here.

    WHY MODULE SCOPE, AND WHY THE FIXTURES ARE NOT USED. 620 parametrized items
    share this policy; generating it per item would run bash 620 times to produce
    620 identical files. A module-scoped fixture may not depend on a
    function-scoped one, and ``manifest_case``, ``render_kube_env`` and
    ``kube_home`` are all function-scoped, so this fixture composes the tier's own
    ``ManifestCaseFactory`` and ``KubeEnvRenderFactory`` - both exported from
    tests/unit/shell/conftest.py - over the session-scoped ``repo_root`` and
    ``tmp_path_factory``. It reproduces every guarantee those fixtures give:
    a ``KUBE_HOME`` created inside a pytest-owned temporary directory, unique to
    this module, and torn down in a ``finally`` whether the tests passed or
    failed.

    The result is FROZEN and the evaluator built from it is immutable, so sharing
    is safe under ``pytest-randomly`` and ``pytest-xdist -n auto``.

    WHAT SUCCESS MEANS HERE. Rendering ``base.template`` as its own target yields
    a fragment that bash cannot parse, so the invocation's captured output
    contains a syntax error and the ``source`` clause alone would return 2 - while
    the invocation as a whole returns 0 and the generator writes a valid policy.
    That is measured, expected, and left exactly as the oracle leaves it: nothing
    is filtered, no ``set -e`` is added and the ``;`` separators are not changed
    to ``&&``. ``ShellManifestCase.run_func`` checks the FINAL status and raises
    ``BashInvocationError`` on a non-zero exit, which is the ``t.Fatalf`` of
    configure_helper_test.go L120.

    Yields:
        The generated policy, its text and the invocation's combined output.

    Raises:
        tests.helpers.bash.BashInvocationError: if the generator exits non-zero
            or times out. Aborts every dependent case, which is what
            ``require.NoError`` does.
        AuditPolicyError: if the generator wrote no file, or wrote something that
            is not a valid ``audit.k8s.io/v1`` Policy.
    """
    package_dir = repo_root / "cluster" / "gce" / "gci"
    base_dir = tmp_path_factory.mktemp("audit-policy")
    renderer = KubeEnvRenderFactory(
        package_dir=package_dir,
        # Never written to: the bare shape renders into the CASE's own KUBE_HOME,
        # which ManifestCaseFactory creates below and passes to write() explicitly.
        # A directory is still required, and base_dir is the one this module owns.
        kube_home=base_dir,
        repo_root=repo_root,
    )
    factory = ManifestCaseFactory(
        repo_root=repo_root,
        package_dir=package_dir,
        base_dir=base_dir,
        renderer=renderer,
    )
    try:
        # No `manifest=`: the BARE shape of audit_policy_test.go L54-58.
        case = factory(func_name=AUDIT_POLICY_FUNC_NAME)
        policy_file = case.kube_home / AUDIT_POLICY_FILE_NAME

        # The port of L62-67. The render context carries the single field the Go
        # struct literal sets, `kubeAPIServerEnv{KubeHome: c.kubeHome}`; rendering
        # base.template as its own target dereferences no field at all, so this is
        # the whole environment the oracle supplies. The output path travels as a
        # POSITIONAL ARGUMENT and is never interpolated into the script text.
        result = case.invoke_func(
            {"KubeHome": os.fspath(case.kube_home)},
            [CONFIGURE_HELPER_SCRIPT],
            BASE_TEMPLATE_TARGET,
            (BASE_TEMPLATE_RELATIVE_PATH,),
            path_args=(policy_file,),
            requirement=REQUIREMENT_ID,
        )

        text = _require_generated_policy_text(
            policy_file, returncode=result.returncode, combined_output=result.stdout
        )
        # The port of L69-70: a load failure aborts, because 620 findings against
        # a policy that did not load would all be about nothing.
        policy = load_policy_from_file(policy_file)
        yield GeneratedAuditPolicy(text=text, policy=policy, combined_output=result.stdout)
    finally:
        # The analogue of `defer c.tearDown()`: unconditional, so a failing test
        # still gives its tree back instead of accumulating one per xdist worker.
        factory.tear_down_all()


@pytest.fixture(scope="module")
def audit_policy_evaluator(generated_audit_policy: GeneratedAuditPolicy) -> PolicyRuleEvaluator:
    """The evaluator the 620 cases are judged by. Ports L127-130's ``auditTester``.

    Built once and shared, exactly as the Go test builds one evaluator and hands
    it to every subtest through the ``auditTester`` struct. Safe to share because
    :class:`PolicyRuleEvaluator` is immutable.
    """
    return PolicyRuleEvaluator(generated_audit_policy.policy)


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
    """
    assert len(_CASES) == apc.TOTAL_CASE_COUNT, (
        f"{REQUIREMENT_ID}: the shared case table expands to {len(_CASES)} cases, but the Go "
        f"suite measures {apc.TOTAL_CASE_COUNT}. The 620 node ids of test_audit_level are the "
        "parity key recorded in tests/parity/baseline/go_baseline.json."
    )
    assert len(apc.resource_cases()) == apc.RESOURCE_CASE_COUNT
    assert len(apc.non_resource_cases()) == apc.NON_RESOURCE_CASE_COUNT
    assert apc.RESOURCE_CASE_COUNT + apc.NON_RESOURCE_CASE_COUNT == apc.TOTAL_CASE_COUNT

    # The invocation table's own shape: 29 = 27 + 2, counted in the Go source with
    # `grep -c 'at\\.testResources('` (27) and `grep -c 'at\\.testNonResources('`
    # (2). Re-verified in this checkout; the plan's prose says 30 and 28, and the
    # code is authoritative where code and prose disagree.
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


def test_generated_policy_has_the_shape_the_oracle_loads(
    generated_audit_policy: GeneratedAuditPolicy,
    subtests: pytest.Subtests,
) -> None:
    """The shipped generator wrote a loadable ``audit.k8s.io/v1`` Policy.

    INVARIANT LOCKED: the artifact the 620 cases are judged against is the
    envelope Go's loader accepts, with the ordered rule list intact, and the
    measured ``omitStages`` asymmetry that makes :func:`test_audit_level`'s second
    assertion conditional rather than unconditional.

    The document is re-decoded from the bytes the generator WROTE rather than
    read back off :attr:`GeneratedAuditPolicy.policy`, which would only prove the
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

    policy = generated_audit_policy.policy
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
    audit_policy_evaluator: PolicyRuleEvaluator,
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
    config = audit_policy_evaluator.evaluate(_attributes_for(case))

    with subtests.test(case=case.id, assertion="level"):
        assert config.level == case.level.wire, _level_failure(case, config)

    if config.level != DEFAULT_AUDIT_LEVEL:
        with subtests.test(case=case.id, assertion="omitStages"):
            assert sorted(config.omit_stages) == sorted(apc.EXPECTED_OMIT_STAGES), (
                _omit_stages_failure(case, config)
            )


# ---------------------------------------------------------------------------
# The V6 boundary, spelled out in one place
# ---------------------------------------------------------------------------
# The 620 cases already cover every one of these, spread across the matrix. This
# probe exists so that the five values AAP §0.10.2 tabulates as "boundary
# conditions that must port unchanged" are ALSO asserted somewhere a reader can
# find them, driven from the shared SENSITIVE_RESOURCE_LEVELS mapping rather than
# from levels written here.
#
# The verb is part of each probe and is not interchangeable: the policy's
# "known APIs" rules split get/list/watch (Request) from everything else
# (RequestResponse), so `clusterroles` reaches RequestResponse only under a
# mutating verb. Every probe uses the `default` ServiceAccount, which is the
# principal the corresponding Go invocation uses.

_SENSITIVE_BOUNDARY_PROBES: Final[
    tuple[tuple[apc.ResourceSelector, str, int], ...]
] = (
    # Go L178: at.testResources(request, defaultSA, ..., "get", ..., secrets)
    (apc.SECRETS, "get", 178),
    # Go L179: at.testResources(request, defaultSA, apiserver, "create", saTokens)
    (apc.SA_TOKENS, "create", 179),
    # Go L177: at.testResources(metadata, defaultSA, ..., "get", ..., configmaps, ...)
    (apc.CONFIGMAPS, "get", 177),
    # Go L177, same invocation: ... tokenReviews
    (apc.TOKEN_REVIEWS, "get", 177),
    # Go L181: at.testResources(response, defaultSA, ..., "create", ..., clusterRoles, ...)
    (apc.CLUSTER_ROLES, "create", 181),
)


def test_sensitive_resources_sit_at_exactly_their_documented_level(
    audit_policy_evaluator: PolicyRuleEvaluator,
    subtests: pytest.Subtests,
) -> None:
    """The five V6 boundary values, asserted in one legible place.

    INVARIANT LOCKED: ``secrets`` ``Request``; ``serviceaccounts/token``
    ``Request``; ``configmaps`` ``Metadata``; ``tokenreviews`` ``Metadata``;
    ``clusterroles`` ``RequestResponse``. EXACTLY those, in both directions.
    Raising ``secrets`` to ``RequestResponse`` would make the API server log
    secret bodies and issued bearer tokens; lowering it to ``Metadata`` would
    give up the forensic detail the V6 remediation restored. Both directions are
    silent, which is why the expected values live in one reviewed place -
    ``tests.fixtures.audit_policy_cases.SENSITIVE_RESOURCE_LEVELS`` - and are
    read from there here.

    Findings accumulate: five boundaries, and a reader must see all of them.
    """
    probed = {selector.policy_resource for selector, _verb, _line in _SENSITIVE_BOUNDARY_PROBES}
    assert probed == set(apc.SENSITIVE_RESOURCE_LEVELS), (
        f"{REQUIREMENT_ID}: the probes cover {sorted(probed)} but the documented boundary is "
        f"{sorted(apc.SENSITIVE_RESOURCE_LEVELS)}. Every documented sensitive resource must be "
        "probed here."
    )

    for selector, verb, go_line in _SENSITIVE_BOUNDARY_PROBES:
        expected = apc.SENSITIVE_RESOURCE_LEVELS[selector.policy_resource]
        attrs = RequestAttributes(
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
        with subtests.test(resource=selector.policy_resource, verb=verb):
            config = audit_policy_evaluator.evaluate(attrs)
            assert config.level == expected.wire, (
                f"{REQUIREMENT_ID}: {selector.policy_resource!r} under verb {verb!r} is recorded "
                f"at {config.level!r} but must be recorded at EXACTLY {expected.wire!r} "
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


@settings(max_examples=64, deadline=None, database=None)
@given(
    first=st.sampled_from(apc.LEVEL_ORDER),
    second=st.sampled_from(apc.LEVEL_ORDER),
    third=st.sampled_from(apc.LEVEL_ORDER),
)
def test_audit_level_order_axioms_hold_for_every_triple(
    first: apc.AuditLevel,
    second: apc.AuditLevel,
    third: apc.AuditLevel,
) -> None:
    """The order is irreflexive, trichotomous, antisymmetric and transitive.

    INVARIANT LOCKED: that ``AuditLevel``'s comparison operators really define a
    strict total order, rather than merely happening to order the four members the
    way :func:`test_audit_levels_form_a_strict_total_order` checks. Property-based
    because the axioms are statements about ALL triples, and ``hypothesis`` is
    pinned in python/requirements-test.txt for exactly this invariant.

    Deliberately cheap: the domain has four members, so 64 examples cover every
    one of the 64 triples several times over and the test cannot distort the
    620-case runtime. ``database=None`` keeps hypothesis from writing an example
    database into the working tree, and no fixture is requested, so no
    function-scoped-fixture health check applies.
    """
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
            f"{REQUIREMENT_ID}: the ordering is not transitive: {first.wire} < {second.wire} < "
            f"{third.wire} but not {first.wire} < {third.wire}"
        )

    # The rank and the operators are two spellings of one order, so they must
    # agree; a test that trusted only one could not catch the other drifting.
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
        "namespaces-entry-is-not-a-string",
        "apiVersion: audit.k8s.io/v1\nkind: Policy\n"
        "rules: [{level: Metadata, namespaces: [null]}]\n",
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

    Without it, a loader that rejected EVERYTHING would pass all 29 negative
    cases - which is the classic way a validation suite ends up asserting nothing.
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
    generated_audit_policy: GeneratedAuditPolicy,
    tmp_path: Path,
) -> None:
    """Loading the generated text from a fresh file yields the same rules.

    Proves that :func:`load_policy_from_file` and :func:`load_policy_from_bytes`
    agree, which is what lets the negative cases above use the bytes entry point
    while the fixture uses the file one.
    """
    copy = tmp_path / AUDIT_POLICY_FILE_NAME
    copy.write_text(generated_audit_policy.text, encoding="utf-8")
    assert load_policy_from_file(copy) == generated_audit_policy.policy


def test_a_generator_that_writes_nothing_is_a_failure(tmp_path: Path) -> None:
    """Exit 0 is not evidence that the generator ran; a written file is.

    The invocation exits 0 even though its ``kube-env`` is an unparseable
    fragment, so :func:`_require_generated_policy_text` is what turns "the
    generator silently stopped writing" into a named failure instead of 620 cases
    erroring on a missing file.
    """
    missing = tmp_path / AUDIT_POLICY_FILE_NAME
    with pytest.raises(AuditPolicyError, match="wrote no policy to"):
        _require_generated_policy_text(missing, returncode=0, combined_output="syntax error")

    missing.write_text(_VALID_MINIMAL_POLICY, encoding="utf-8")
    assert (
        _require_generated_policy_text(missing, returncode=0, combined_output="")
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
# covered by the same fixture.
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


@pytest.fixture(scope="module")
def synthetic_evaluator() -> PolicyRuleEvaluator:
    """An evaluator over :data:`_SYNTHETIC_POLICY`.

    Module-scoped and immutable for the same reason the generated one is: shared
    by several tests, mutated by none.
    """
    return PolicyRuleEvaluator(load_policy_from_bytes(_SYNTHETIC_POLICY))


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
    synthetic_evaluator: PolicyRuleEvaluator,
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
            assert synthetic_evaluator.evaluate(attrs).level == expected, description


def test_synthetic_policy_falls_through_to_the_default_level(
    synthetic_evaluator: PolicyRuleEvaluator,
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
            config = synthetic_evaluator.evaluate(attrs)
            assert config.level == DEFAULT_AUDIT_LEVEL, description
            assert config.omit_stages == ("ResponseStarted",), (
                "an unmatched request must carry the POLICY-level omitStages, not an empty list"
            )
            assert config.omit_managed_fields is True


def test_synthetic_policy_non_resource_wildcard(
    synthetic_evaluator: PolicyRuleEvaluator,
) -> None:
    """``nonResourceURLs: ["*"]`` matches any path, and only non-resource requests.

    INVARIANT LOCKED: ``pathMatches``'s ``spec == "*"`` arm (checker.go L153-155),
    which the shipped policy never uses - it spells its wildcards as the prefix
    forms ``/healthz*`` and ``/swagger*`` - together with
    ``ruleMatchesNonResource``'s refusal to match a resource request.
    """
    config = synthetic_evaluator.evaluate(
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


def test_synthetic_policy_unions_the_policy_and_rule_stage_lists(
    synthetic_evaluator: PolicyRuleEvaluator,
) -> None:
    """A rule's stages are the UNION with the policy's. Go: ``unionStages``.

    INVARIANT LOCKED: ``NewPolicyRuleEvaluator``'s one act (checker.go L34-36).
    The shipped policy declares no policy-level ``omitStages``, so against it the
    union is indistinguishable from the rule's own list and a port that simply
    ignored the policy level would pass all 620 cases. Compared as SETS because
    Go's own order here is unspecified.
    """
    rules = synthetic_evaluator.rules
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


def test_synthetic_policy_resolves_omit_managed_fields_per_rule(
    synthetic_evaluator: PolicyRuleEvaluator,
) -> None:
    """A rule-level ``omitManagedFields`` overrides the policy default.

    INVARIANT LOCKED: ``isOmitManagedFields`` (checker.go L86-92). Ported for
    completeness of ``EvaluatePolicyRule``; the Go test asserts nothing about it,
    which is exactly why it is asserted here rather than left as unexercised code
    in a security-critical evaluator.
    """
    # Rule 2 sets it to false against a policy default of true.
    overridden = synthetic_evaluator.evaluate(_resource_request("pods", subresource="log"))
    assert overridden.level == apc.AuditLevel.REQUEST.wire
    assert overridden.omit_managed_fields is False

    # Rule 1 sets nothing, so the policy default applies.
    inherited = synthetic_evaluator.evaluate(
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
    synthetic_evaluator: PolicyRuleEvaluator,
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
            synthetic_evaluator.evaluate(
                _resource_request("configmaps", verb="create", name="ingress-uid")
            ).level
            == DEFAULT_AUDIT_LEVEL
        )

    with subtests.test(check="a cluster-scoped request against a namespaced rule"):
        # Rule 4 names namespace "kube-system"; a cluster-scoped request presents
        # "" and must not match it.
        assert (
            synthetic_evaluator.evaluate(_resource_request("nodes", namespace="")).level
            == DEFAULT_AUDIT_LEVEL
        )

    with subtests.test(check="a non-resource request against a namespaced rule"):
        # Rule 4 has namespaces, so ruleMatchesResource decides - and it refuses a
        # non-resource request outright. Rule 5's "*" then claims it.
        assert (
            synthetic_evaluator.evaluate(
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
