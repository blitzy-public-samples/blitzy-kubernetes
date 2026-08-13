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

"""The four V8 etcd fail-closed scenarios: NEW automation, not a port.

``configure-etcd-params`` (cluster/gce/gci/configure-kubeapiserver.sh line 18)
decides how the API server reaches etcd. Three of its outcomes are security
outcomes, and until now all four scenarios below were verified BY HAND: there is
no Go test for the fail-closed path, which is why AAP §0.7.1.4 counts this module
and the V5 webhook-posture module as the migration's two genuine assurance gains
rather than as reproductions. Everything here therefore has no baseline verdict
to match -- these four cases are ADDITIONS to tests/parity/parity_map.py, and the
parity contract must not be handed a Go counterpart for any of them, because none
exists.

INVARIANT LOCKED BY THIS MODULE: the API-server-to-etcd transport FAILS CLOSED.
When the six etcd mTLS credentials are absent and the deployment has not
explicitly opted out, the generator REFUSES and exits 1 rather than talking
plaintext to etcd; when they are only PARTIALLY present it also exits 1, because
a half-configured deployment must fail rather than silently downgrade. The two
success branches are asserted alongside them so that the module cannot pass by
merely being unable to configure anything at all.

WHAT EACH SCENARIO PROVES, AND WHICH REQUIREMENT IT ENFORCES

    all-credentials-present     mTLS is selected and the three file flags carry
                                the configured paths            F-008-RQ-001
    all-absent-fail-closed      the refusal is printed AND the exit status is 1,
                                with NO plaintext endpoint       F-008-RQ-002
    partial-credentials         a partial credential set ALSO exits 1 -- the
                                subtle branch                    F-008-RQ-003
    all-absent-allow-insecure   the documented local/dev opt-out still works,
                                warning loudly and never refusing F-008-RQ-002

=============================================================================
THREE MEASURED FACTS ABOUT THE SHIPPED SCRIPT. Each one silently empties this
module if it is "tidied". All three were re-verified against the code and then
proven by running it, not taken on trust.
=============================================================================

1. THE FUNCTION TAKES A NAMEREF, SO IT MUST BE CALLED WITH A VARIABLE *NAME*.

   Line 19 is ``local -n params_ref=$1``. A nameref binds to a name, not to a
   value, so the only invocation that observes anything is the one in
   :data:`NAMEREF_INVOCATION`: declare the variable, pass its NAME, then echo it.
   A bare ``configure-etcd-params`` with no argument does not fail loudly --
   measured, it prints ``local: not a valid identifier``, leaves the variable
   unset and STILL EXITS 0, so a module that called it that way would report four
   passes while asserting nothing about any flag. That is why the two
   success scenarios additionally assert the echoed parameter string is NON-EMPTY
   (:attr:`FailClosedScenario.params_echoed`): it is the standing proof that the
   nameref call shape still works, positioned so that breaking it turns the suite
   red instead of vacuously green.

2. THE ERROR AND THE WARNING GO TO **STDOUT**, NOT STDERR.

   AAP §0.10.2 describes the refusal as "stderr containing ...". The shipped code
   emits it with a plain ``echo`` and no ``>&2`` -- line 43 for the WARNING, line
   45 for the refusal ERROR, line 49 for the partial-credential ERROR -- so all
   three arrive on STDOUT. Under the enterprise bar this suite is held to
   (AAP §0.11.1: where documentation and code disagree, THE CODE WINS) the code
   is authoritative, and it was confirmed by execution: stderr is EMPTY for all
   four scenarios. So every text assertion here matches against
   :attr:`tests.helpers.bash.BashResult.output`, which is stdout AND stderr
   concatenated. Matching stderr alone would make all three message assertions
   vacuously false while the exit-code assertions carried on passing.

   Do NOT "correct" this to ``result.stderr`` to agree with the prose, and do not
   add ``>&2`` to the shipped script to agree with it either -- the second would
   be a behaviour change to a hardened artifact, made to satisfy a comment.

3. ``${ETCD_APISERVER_ALLOW_INSECURE:-true}`` USES ``:-``, SO EMPTY == UNSET.

   Line 41 tests the opt-out with ``:-``, which substitutes the default when the
   variable is unset **or empty**. Rendering ``AllowInsecureEtcd`` as ``""``
   therefore selects ``true`` -- the INSECURE branch, the exact opposite of what a
   fail-closed test needs, and it would do so while looking like the strictest
   possible setting. Measured: an empty value produces the WARNING and the
   plaintext endpoint and exits 0. Hence :data:`ALLOW_INSECURE_FALSE` is the
   literal string ``"false"`` and the two fail-closed scenarios use it. Never
   substitute the empty string, and never omit the key.

=============================================================================
DO NOT RECONCILE THIS MODULE WITH ``test_apiserver_etcd.py``. BOTH ARE RIGHT.
=============================================================================

``test_apiserver_etcd.py::test_tls_flags[mtls-disabled]`` supplies an entirely
empty environment, expects the PLAINTEXT endpoint
``--etcd-servers=http://127.0.0.1:2379``, and passes. This module asserts that
absent credentials produce ``exit 1``. Those look contradictory and are not, for
one measured reason: ``cluster/gce/gci/testdata/kube-apiserver/etcd.template``
sets no ``ETCD_APISERVER_ALLOW_INSECURE`` at all -- all sixteen of its lines were
checked -- so that test reaches the function-local ``:-true``
backward-compatibility shim which tech-spec §2.1.8 documents as existing SOLELY
for direct-invocation contexts that never load the GCE profiles. The script's own
comment at lines 27-40 names ``apiserver_etcd_test.go`` as one of those contexts.
This module renders tests/fixtures/templates/kube_env.j2 with the literal
``false``, which is what both shipped profiles set
(cluster/gce/config-default.sh line 446 and config-test.sh line 492), so it
reaches the deployment path and the fail-closed branch.

AAP §0.10.4 names this the requirement most likely to be broken by a well-meaning
agent, so the obligations are spelled out:

* do NOT add an ``exit 1`` expectation to ``test_apiserver_etcd.py``;
* do NOT add ``ETCD_APISERVER_ALLOW_INSECURE`` to the shipped ``etcd.template``,
  and do not add a seventeenth field to
  :class:`~tests.fixtures.etcd_env_cases.KubeAPIServerETCDEnv`, which is a
  faithful mirror of the sixteen-field Go struct -- the opt-out reaches bash
  through ``extra={"AllowInsecureEtcd": ...}``, which
  :meth:`KubeEnvRenderFactory.context` is the declared supplier of;
* do NOT weaken any ``returncode == 1`` assertion below to make the other module
  agree. The PRESERVATION NOTE on
  :data:`tests.fixtures.etcd_env_cases.TLS_FLAGS_CASES` states the same pact from
  the other side and names this file; the two must be edited together or not at
  all.

THE PAIRING THIS MODULE COMPLETES, AND THE HALF IT LEAVES ALONE

F-008-RQ-002 has two halves and they are asserted in two places, by design. This
module proves the RUNTIME behaviour: given the opt-out, which branch
``configure-etcd-params`` takes and what it exits with. It does NOT assert that
the shipped GCE profiles default the opt-out to ``false`` -- that is the boundary
half, and ``python/tests/unit/config/test_audit_and_etcd_profile_defaults.py``
owns it, parametrized over ``config-default`` and ``config-test`` so a one-sided
edit fails exactly one named node id.

Neither half substitutes for the other, and the reason is the shim: because
``configure-etcd-params`` defaults the opt-out to ``true`` when it is unset, the
fail-closed posture of a real deployment rests entirely on those profile
defaults. A run of this module alone would prove that the script CAN refuse
without proving that any shipped profile ever asks it to; a run of that module
alone would prove the default is set without proving the script honours it.

WHAT THIS MODULE DELIBERATELY DOES NOT DO

* It re-implements nothing. The credential logic is Bash and stays Bash: the
  shipped ``configure-kubeapiserver.sh`` is sourced and invoked, so what is
  proven is the generator this repository actually ships. A Python paraphrase
  could drift while both halves kept passing.
* It writes nothing under ``cluster/``. The script and the profiles are read-only
  inputs; the only file written is the rendered ``kube-env``, inside this test's
  own ``tmp_path``.
* It needs no etcd and no API server, declares only ``pytest.mark.shell``, and so
  runs in full under ``pytest -m "not integration"``.
* It contains no key material. Every credential value is a placeholder echoing
  its own field name, exactly as the Go tables write them, which is sufficient
  because the script tests those six variables only for EMPTINESS and copies only
  the three ``*_PATH`` values into flags.
* It holds no shared mutable state: the scenario table is frozen, the ``KUBE_HOME``
  is per test, and the environment of the parent process is never mutated. That is
  what makes it honest under ``pytest-randomly`` and safe under
  ``pytest-xdist -n auto``, which are this tier's deliberate substitutes for
  ``-race`` and goleak.
* It defines exactly ONE test function and collects exactly FOUR node ids. The
  nameref proof and the negative assertions live inside those four cases rather
  than in extra tests, so the module's contribution to the parity map stays the
  four scenarios it is specified to add.
"""

# AAP §0.4.2.1 (the L4 "configure-etcd-params fail-closed" blueprint: happy path
# with all six credentials, error cases for absent and for PARTIAL credentials,
# the ALLOW_INSECURE=true edge case, and the profile-default boundary asserted in
# the L3 module) / AAP §0.4.1.1 layer L4 ("Shell Fail-Closed Scenario ...
# exit-code assertions") / AAP §0.5.1 (this file's CREATE row, source
# cluster/gce/gci/configure-kubeapiserver.sh:18, "New automation of the four
# currently-manual V8 runtime scenarios, including the partial-credential exit 1
# branch") / AAP §0.5.2.1 (assertion focus: returncode == 1 for BOTH the
# all-absent and the partial branches, plus a stderr substring match on the
# refusal -- corrected to combined output per the code-wins ruling above) /
# AAP §0.7.1.4 (V8's four manual scenarios are one of the two genuine automation
# gains) / AAP §0.10.2 (the etcd fail-closed and profile-default boundary rows) /
# AAP §0.10.4 (the compatibility-shim paradox) / tech-spec §2.1.8 (the
# function-local ":-true" shim) / tech-spec §6.2.4.6 (etcd access-control
# hardening, control V8, feature F-008).

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import pytest

from tests.fixtures.etcd_env_cases import (
    MTLS_ETCD_SERVERS_ENDPOINT,
    PLAINTEXT_ETCD_SERVERS_FLAG,
    KubeAPIServerETCDEnv,
)
from tests.helpers.manifest import ENV_SCRIPT_FILE_NAME, KUBE_APISERVER_CONFIG_SCRIPT_NAME

if TYPE_CHECKING:
    from pathlib import Path

    from tests.helpers.bash import BashResult

    # Imported for annotations only. The fixtures themselves are supplied by
    # python/tests/unit/shell/conftest.py, which pytest has already imported
    # under its own module identity; naming the classes under TYPE_CHECKING
    # types the call sites below without importing that module a second time at
    # runtime.
    from tests.unit.shell.conftest import BashInvoker, KubeEnvRenderFactory

# This tier invokes the shipped bash generators through a subprocess and needs
# neither etcd nor an API server, so `shell` is the only marker -- and it is
# registered in python/pyproject.toml, which runs under `--strict-markers` so an
# invented one would be a collection error rather than a silent no-op.
pytestmark = pytest.mark.shell

# ---------------------------------------------------------------------------
# The invocation, which is the whole reason this module cannot use either of the
# two ordinary postures
# ---------------------------------------------------------------------------
# `tests.helpers.bash.must_invoke_func` and `try_invoke_func` both append a BARE
# function name, which cannot express a nameref call; `must_invoke_func` also
# merges the streams and raises on a non-zero exit, and an exit of 1 is precisely
# what two of these scenarios assert. python/tests/unit/shell/conftest.py names
# the remaining seam explicitly -- "run_bash for the nameref call shape
# configure-etcd-params requires" -- so this module builds that one script string
# and passes it to `bash_invoke.run_bash` with `check=False` and
# `merge_streams=False`.
#
# THE SHAPE IS LOAD-BEARING, CHARACTER FOR CHARACTER:
#
#   * `source "$1" ;source "$2" ;` reproduces the chain
#     `tests.helpers.bash._build_source_chain` builds -- a space before each `;`,
#     nothing between the clauses -- so a failure here reads the same as a
#     failure from the ordinary postures.
#   * The two paths travel as POSITIONAL PARAMETERS, never interpolated. bash
#     performs parameter expansion, command substitution and arithmetic expansion
#     inside double quotes, so an interpolated path containing `$(...)`, a
#     backtick or a quote would be EVALUATED rather than read; `"$1"` is expanded
#     exactly once to its literal value. These paths derive from `tmp_path`, hence
#     from `--basetemp` and the test's own name, so keeping them out of the
#     program text is not hypothetical hygiene.
#   * `params=""` declares the variable the nameref binds to. Without it the
#     function still runs and still exits 0 while observing nothing.
#   * `configure-etcd-params params` passes the NAME, with no `$`. The shipped
#     script calls it exactly this way at line 90.
#   * `echo "$params"` is how the accumulated flags become observable at all. It
#     never runs on the two fail-closed paths, because `exit 1` precedes it --
#     which is itself part of what those two scenarios assert.
#   * There is NO `set -e` and the separators stay `;`. The tier's harness records
#     both as measured decisions: `;` composition yields the LAST command's
#     status, and `&&` or `set -e` would change which status is reported.
NAMEREF_INVOCATION: Final[str] = (
    'source "$1" ;source "$2" ;params="";configure-etcd-params params;echo "$params"'
)

# ---------------------------------------------------------------------------
# The opt-out, spelled as literals because the empty string is a trap
# ---------------------------------------------------------------------------
# See measured fact 3 in the module docstring. `:-` treats empty as unset, so
# only these two literals are meaningful and the empty string means `true`.
ALLOW_INSECURE_FALSE: Final[str] = "false"
ALLOW_INSECURE_TRUE: Final[str] = "true"

# The render-context key the opt-out travels under. It is the fourteenth variable
# of tests/fixtures/templates/kube_env.j2 and the only one with no counterpart in
# the sixteen-field Go struct, so it is supplied through
# `KubeEnvRenderFactory.context(..., extra=...)`.
ALLOW_INSECURE_CONTEXT_KEY: Final[str] = "AllowInsecureEtcd"

# ---------------------------------------------------------------------------
# Expected flags and message fragments, all measured from the shipped script
# ---------------------------------------------------------------------------
# configure-kubeapiserver.sh line 22. The endpoint constant is shared with
# tests/fixtures/etcd_env_cases.py so the mTLS endpoint has one definition in the
# tree; only the flag spelling is composed here.
MTLS_ETCD_SERVERS_FLAG: Final[str] = f"--etcd-servers={MTLS_ETCD_SERVERS_ENDPOINT}"

# Lines 23-25. The mapping crosses two naming schemes and must be transcribed
# rather than inferred: `--etcd-cafile` reads ETCD_APISERVER_CA_CERT_PATH
# (context key CACertPath), `--etcd-certfile` reads
# ETCD_APISERVER_CLIENT_CERT_PATH (APIServerCertPath) and `--etcd-keyfile` reads
# ETCD_APISERVER_CLIENT_KEY_PATH (APIServerKeyPath) -- an `api_server_*` value
# lands in a CLIENT variable, because from etcd's point of view the API server is
# the client. Getting any one of these backwards would assert a flag that names
# the wrong file while still passing.
CA_FILE_FLAG: Final[str] = "--etcd-cafile=CACertPath"
CERT_FILE_FLAG: Final[str] = "--etcd-certfile=APIServerCertPath"
KEY_FILE_FLAG: Final[str] = "--etcd-keyfile=APIServerKeyPath"

# Line 45, matched as a STABLE SUBSTRING rather than as the whole sentence: the
# message is 300-odd characters of operator guidance and a whole-string match
# would break on any rewording that left the refusal intact. This is the phrase
# AAP §0.10.2 names, and it is present in the code verbatim.
REFUSAL_FRAGMENT: Final[str] = "refusing to fall back to plaintext etcd"

# Line 49, the partial-credential branch. Two short fragments rather than one
# long one, because "Some of" is what distinguishes this message from the
# all-absent "ALL etcd mTLS credentials" ERROR and "cannot be enabled" is what
# distinguishes it from the WARNING's "is not enabled". Asserting both makes it
# impossible for the wrong branch to satisfy this scenario.
PARTIAL_FRAGMENTS: Final[tuple[str, ...]] = ("Some of", "cannot be enabled")

# Line 43. The local/dev opt-out must remain loud: a silent plaintext fallback
# would be indistinguishable from a working mTLS configuration in a log.
INSECURE_WARNING_FRAGMENT: Final[str] = "WARNING:"

# The negative half of the fail-closed assertion. Deliberately the FULL
# `--etcd-servers=http://` prefix and not a bare `http://`: with ETCD_SERVERS
# empty the script also appends
# `--etcd-servers-overrides=/events#http://127.0.0.1:4002` (lines 53-54), which
# contains `http://` legitimately. A looser fragment would fail the
# all-credentials-present scenario for a reason unrelated to the transport under
# test.
PLAINTEXT_ETCD_SERVERS_PREFIX: Final[str] = "--etcd-servers=http://"

# ---------------------------------------------------------------------------
# The credential sets
# ---------------------------------------------------------------------------
# Each value is a literal echo of its own field name, exactly as the Go tables
# write them. No real key, certificate or token appears here and none is needed:
# the script tests the six credential variables only for emptiness (lines 21 and
# 26) and copies only the three *_PATH values into flags.
#
# The three *_PATH values are MANDATORY for the mTLS branch and are the corollary
# of measured fact 3's sibling: lines 23-25 expand them with NO `:-` default, so
# a scenario that omitted them would render three flags with empty values and
# assert nothing about the files the transport actually uses.
ALL_CREDENTIALS_PRESENT: Final[KubeAPIServerETCDEnv] = KubeAPIServerETCDEnv(
    ca_key="CAKey",
    ca_cert="CACert",
    ca_cert_path="CACertPath",
    api_server_key="APIServerKey",
    api_server_cert="APIServerCert",
    api_server_cert_path="APIServerCertPath",
    api_server_key_path="APIServerKeyPath",
    etcd_key="ETCDKey",
    etcd_cert="ETCDCert",
)

# The zero value, which is what "the deployment has no etcd certificates" means
# to the script. ETCD_SERVERS is left empty too, so the endpoint asserted is the
# script's OWN default for whichever branch it takes -- https on line 22, http on
# line 42 -- rather than something this table chose.
NO_CREDENTIALS: Final[KubeAPIServerETCDEnv] = KubeAPIServerETCDEnv()

# THE SUBTLE BRANCH. Two of the six credentials present and four absent, so
# neither the all-present test on line 21 nor the all-absent test on line 26
# succeeds and the script falls through to its `else` on line 48. The CA pair is
# chosen because it is the most plausible real-world half-configuration -- a
# cluster that provisioned its CA and then failed to issue the server and client
# pairs -- and the three *_PATH values are supplied so that the ONLY reason this
# scenario cannot reach the mTLS branch is the missing credentials themselves.
PARTIAL_CREDENTIALS: Final[KubeAPIServerETCDEnv] = KubeAPIServerETCDEnv(
    ca_key="CAKey",
    ca_cert="CACert",
    ca_cert_path="CACertPath",
    api_server_cert_path="APIServerCertPath",
    api_server_key_path="APIServerKeyPath",
)


# ---------------------------------------------------------------------------
# One scenario
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FailClosedScenario:
    """One runtime scenario of ``configure-etcd-params``: an environment and its verdict.

    Frozen, and the table below is module-level: a scenario that could be mutated
    in place would leak into whichever test ran next, and this tier runs under
    ``pytest-randomly`` precisely so that ordering cannot be relied upon.

    ASSERTION STYLE follows the Go tier's, so that the two read alike even though
    this module has no Go ancestor: :attr:`want` and :attr:`dont_want` hold
    SUBSTRINGS of the invocation's combined output rather than parsed flags. That
    is what makes "this flag is absent entirely" expressible -- a
    :attr:`dont_want` entry can be a bare flag prefix with no value, which an
    equality check against a parsed flag list could not express.
    """

    #: The pytest parametrize id, and therefore the addressable node id: this is
    #: what ``pytest "...::test_etcd_fail_closed[all-absent-fail-closed]"``
    #: selects and what tests/parity/parity_map.py records these four cases under.
    #: Authored rather than derived, because there is no Go subtest description to
    #: derive it from -- these scenarios are new automation. Kept stable for that
    #: reason: renaming one silently empties a selector, since a `-k` or `-m`
    #: mismatch merely reports "no tests collected" instead of erroring.
    case_id: str

    #: What the scenario proves, in one line, quoted in every failure message so
    #: that a CI reader who did not write the test learns the intent immediately.
    summary: str

    #: The requirement this case enforces -- ``F-008-RQ-001``, ``-RQ-002`` or
    #: ``-RQ-003``. Named in every assertion message so a failure reads as a
    #: requirement violation rather than as a value mismatch. These are the
    #: repository's own identifiers; no CIS or NSA control number is asserted
    #: anywhere, because tech-spec §2.5.3 records that the repository enumerates
    #: none.
    requirement: str

    #: The six credential values plus the three paths, as a rendering of
    #: tests/fixtures/templates/kube_env.j2.
    env: KubeAPIServerETCDEnv

    #: ``ETCD_APISERVER_ALLOW_INSECURE``, as one of the two meaningful LITERALS.
    #: Never the empty string -- see measured fact 3.
    allow_insecure: str

    #: The exit status the whole ``bash -c`` invocation must produce. ``1`` for
    #: both fail-closed branches, and it is an equality assertion on purpose: a
    #: "non-zero" assertion would also accept 2 from a sourcing error or 127 from
    #: a function that was never defined, neither of which is the control failing
    #: closed.
    expected_returncode: int

    #: Substrings that MUST appear in the combined output.
    want: tuple[str, ...] = ()

    #: Substrings that must NOT appear. Never empty in this table: every scenario
    #: carries at least one negative, because a positive-only assertion can pass
    #: while a neighbouring branch is broken.
    dont_want: tuple[str, ...] = ()

    #: Whether ``echo "$params"`` is reached, and therefore whether the accumulated
    #: parameter string must be NON-EMPTY. True for the two exit-0 scenarios,
    #: where it is the standing proof that the nameref call shape still works;
    #: False for the two exit-1 scenarios, where ``exit 1`` precedes the echo.
    params_echoed: bool = False


# ---------------------------------------------------------------------------
# The four scenarios
# ---------------------------------------------------------------------------
# Manual verification steps until now, and the whole reason this module exists.
# Every verdict below was measured by running the shipped script, not inferred
# from reading it.
FAIL_CLOSED_SCENARIOS: Final[tuple[FailClosedScenario, ...]] = (
    FailClosedScenario(
        case_id="all-credentials-present",
        summary="all six etcd mTLS credentials present: the transport is mutually authenticated",
        requirement="F-008-RQ-001",
        env=ALL_CREDENTIALS_PRESENT,
        # `false` even though this scenario never reaches the opt-out: the
        # hardened profiles set it unconditionally, so the mTLS branch is proven
        # under the SAME environment the fail-closed branch is proven under. A
        # different value here would leave open the possibility that mTLS is
        # reachable only when the opt-out is permissive.
        allow_insecure=ALLOW_INSECURE_FALSE,
        expected_returncode=0,
        want=(
            MTLS_ETCD_SERVERS_FLAG,
            CA_FILE_FLAG,
            CERT_FILE_FLAG,
            KEY_FILE_FLAG,
        ),
        # Neither the plaintext endpoint nor either diagnostic may appear: with
        # all six credentials present the script must take its first branch and
        # say nothing.
        dont_want=(
            PLAINTEXT_ETCD_SERVERS_PREFIX,
            REFUSAL_FRAGMENT,
            INSECURE_WARNING_FRAGMENT,
        ),
        params_echoed=True,
    ),
    FailClosedScenario(
        case_id="all-absent-fail-closed",
        summary=(
            "no etcd mTLS credentials and the opt-out not 'true': the generator refuses and exits 1"
        ),
        requirement="F-008-RQ-002",
        env=NO_CREDENTIALS,
        # THE LITERAL, never "" -- see measured fact 3. An empty value would
        # select the insecure branch and this scenario would then assert the
        # opposite of what it is named for, while still passing its own
        # expectations if they had been written loosely.
        allow_insecure=ALLOW_INSECURE_FALSE,
        expected_returncode=1,
        want=(REFUSAL_FRAGMENT,),
        # The negative half, and it is what gives the scenario teeth: an
        # implementation that printed the refusal and THEN configured plaintext
        # etcd anyway would satisfy the positive assertion alone.
        dont_want=(
            PLAINTEXT_ETCD_SERVERS_PREFIX,
            MTLS_ETCD_SERVERS_FLAG,
        ),
        params_echoed=False,
    ),
    FailClosedScenario(
        case_id="partial-credentials",
        summary=(
            "a PARTIAL credential set exits 1: a half-configured deployment must fail, "
            "never silently downgrade"
        ),
        requirement="F-008-RQ-003",
        env=PARTIAL_CREDENTIALS,
        allow_insecure=ALLOW_INSECURE_FALSE,
        # AAP §0.10.2 singles this out as the subtle branch. It stays an equality
        # assertion on 1 and must not be relaxed to "non-zero, or a warning
        # appeared": a deployment holding half its etcd credentials is the case
        # most likely to be silently downgraded, and this is its only automated
        # guard.
        expected_returncode=1,
        want=PARTIAL_FRAGMENTS,
        dont_want=(
            PLAINTEXT_ETCD_SERVERS_PREFIX,
            MTLS_ETCD_SERVERS_FLAG,
            # The all-absent refusal must NOT appear: it would mean the script
            # mistook a partial set for an empty one, which is the same
            # misclassification in the other direction.
            REFUSAL_FRAGMENT,
        ),
        params_echoed=False,
    ),
    FailClosedScenario(
        case_id="all-absent-allow-insecure",
        summary=(
            "no credentials WITH the explicit local/dev opt-out: plaintext is configured, "
            "loudly, and nothing refuses"
        ),
        # Also F-008-RQ-002: the requirement owns the opt-out variable, and the
        # escape hatch is documented rather than incidental (the script's own
        # comment at lines 27-40, and the ERROR text at line 45 which tells the
        # operator to set it). Proving it still works is what keeps the
        # fail-closed change from having broken local development, and it is the
        # only coverage the permissive path has.
        requirement="F-008-RQ-002",
        env=NO_CREDENTIALS,
        allow_insecure=ALLOW_INSECURE_TRUE,
        expected_returncode=0,
        want=(
            PLAINTEXT_ETCD_SERVERS_FLAG,
            INSECURE_WARNING_FRAGMENT,
        ),
        # The refusal must be absent: if it appeared alongside exit 0 the two
        # branches would have been conflated, and the fail-closed scenario above
        # would no longer distinguish anything.
        dont_want=(
            REFUSAL_FRAGMENT,
            MTLS_ETCD_SERVERS_FLAG,
        ),
        params_echoed=True,
    ),
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _render_fail_closed_env(
    render_kube_env: KubeEnvRenderFactory,
    scenario: FailClosedScenario,
) -> Path:
    """Render this scenario's ``kube-env`` into the test's own ``KUBE_HOME``.

    tests/fixtures/templates/kube_env.j2 is the only kube-env template not
    shipped under ``cluster/``, and it exists for exactly this module: none of the
    three shipped templates carries ``ETCD_APISERVER_ALLOW_INSECURE``, so no
    combination of them can express these four scenarios. The renderer resolves
    the template from the session ``repo_root`` rather than from anything computed
    here, and :meth:`KubeEnvRenderFactory.write` writes into the ``kube_home``
    fixture, which is rooted in this test's ``tmp_path``.

    ``extra`` is the declared and only supplier of the opt-out: adding a
    seventeenth field to :class:`KubeAPIServerETCDEnv` instead would end that
    dataclass's status as an exact mirror of the Go struct.
    """
    __tracebackhide__ = True
    context = render_kube_env.context(
        scenario.env,
        extra={ALLOW_INSECURE_CONTEXT_KEY: scenario.allow_insecure},
    )
    return render_kube_env.write(
        render_kube_env.kube_env_j2_target,
        [render_kube_env.kube_env_j2],
        context,
    )


def _echoed_params(result: BashResult) -> str:
    """Return the final line of stdout, which is what ``echo "$params"`` wrote.

    The echo is the LAST thing :data:`NAMEREF_INVOCATION` runs, so on the two
    paths that reach it the parameter string is the final line of stdout -- after
    the WARNING on the permissive path, and alone on the mTLS path.

    ONLY MEANINGFUL WHEN THE ECHO WAS REACHED, which is why the sole caller guards
    it with :attr:`FailClosedScenario.params_echoed`. On the two fail-closed paths
    ``exit 1`` precedes the echo, so the final line is the ERROR message instead
    and this function would report that -- a distinction the guard keeps, rather
    than this function pretending to detect it and returning something the shell
    never wrote.

    An empty result on a path that SHOULD have reached the echo is the signature
    of a broken nameref call: ``echo ""`` emits a blank line, which is exactly
    what a function that accumulated nothing produces.
    """
    lines = result.stdout.splitlines()
    return lines[-1] if lines else ""


def _report(
    scenario: FailClosedScenario,
    env_script: Path,
    result: BashResult,
) -> str:
    """Render the shared context every assertion message in this module carries.

    A security failure is often read by someone who did not write the test, so
    each message names the requirement and what the scenario proves before it
    shows any value, and reproduces the invocation verbatim so it can be rerun by
    hand. Both streams are shown separately AND labelled, because which stream
    carries a diagnostic is the shipped script's choice: here it is stdout for all
    three messages, and printing them apart is what keeps that visible to the next
    reader instead of hiding it behind a merge.
    """
    return "\n".join(
        (
            f"  requirement:  {scenario.requirement}",
            f"  scenario:     {scenario.case_id} -- {scenario.summary}",
            f"  ALLOW_INSECURE rendered as: {scenario.allow_insecure!r}",
            f"  {ENV_SCRIPT_FILE_NAME}: {env_script}",
            f"  script:       {result.script}",
            f"  returncode:   {result.returncode}",
            f"  stdout:       {result.stdout!r}",
            f"  stderr:       {result.stderr!r}",
        )
    )


# ---------------------------------------------------------------------------
# The test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario",
    FAIL_CLOSED_SCENARIOS,
    ids=lambda scenario: scenario.case_id,
)
def test_etcd_fail_closed(
    scenario: FailClosedScenario,
    render_kube_env: KubeEnvRenderFactory,
    bash_invoke: BashInvoker,
) -> None:
    """The etcd transport FAILS CLOSED: absent or partial credentials exit 1, never plaintext.

    Four independent scenarios, one per branch of ``configure-etcd-params``, each
    asserted with a bare aborting ``assert``. That is the right posture here and
    it is a deliberate choice rather than a default: Go's accumulate-and-continue
    ``t.Errorf`` semantics -- ported elsewhere in this suite as
    ``pytest.Subtests`` -- exist so that a security ENUMERATION reports every
    offender in one run, and there is nothing to enumerate in a single-branch
    scenario. Because each case is its own parametrized test, one failing branch
    already leaves the other three to report independently, so nothing is hidden
    by aborting early.
    """
    env_script = _render_fail_closed_env(render_kube_env, scenario)

    # `check=False` because a non-zero exit is the behaviour under test rather
    # than a harness failure, and `merge_streams=False` because attributing each
    # diagnostic to a stream is what proved the code-wins ruling in the module
    # docstring. `cwd` is left to default to the `gci_cwd` the fixture binds,
    # which is what lets `configure-kubeapiserver.sh` be named relatively -- and
    # both paths travel in `argv`, never interpolated into the script text.
    result = bash_invoke.run_bash(
        NAMEREF_INVOCATION,
        argv=(str(env_script), KUBE_APISERVER_CONFIG_SCRIPT_NAME),
        check=False,
        merge_streams=False,
        requirement=scenario.requirement,
    )
    report = _report(scenario, env_script, result)

    # THE EXIT STATUS. An equality assertion, never "non-zero": 2 from a sourcing
    # error and 127 from an undefined function are also non-zero and neither is
    # the control failing closed.
    #
    # The hint is conditional on which verdict was expected, because the two read
    # in opposite directions and a message that offered both would make the reader
    # work out which half applied: on a fail-closed scenario a 0 means the
    # generator downgraded, while on a success scenario a non-zero means a branch
    # that should have configured the transport aborted instead.
    exit_hint = (
        "an exit of 0 here means the generator DOWNGRADED instead of refusing"
        if scenario.expected_returncode != 0
        else "a non-zero exit here means the generator ABORTED a branch it should have configured"
    )
    assert result.returncode == scenario.expected_returncode, (
        f"{scenario.requirement}: expected exit status {scenario.expected_returncode} from "
        f"configure-etcd-params, got {result.returncode} -- {exit_hint}.\n{report}"
    )

    # THE OUTPUT, matched against stdout AND stderr concatenated. The shipped
    # script emits every diagnostic with a plain `echo`, so all three land on
    # stdout; see measured fact 2 for why this is deliberately not `result.stderr`
    # despite AAP §0.10.2's wording.
    output = result.output
    for expected in scenario.want:
        assert expected in output, (
            f"{scenario.requirement}: expected {expected!r} in the combined output of "
            f"configure-etcd-params and it is absent. Match against the COMBINED output: the "
            f"script writes its ERROR and WARNING with a plain echo, so they arrive on stdout.\n"
            f"{report}"
        )

    # THE NEGATIVE HALVES. Without these a scenario could pass while the branch
    # beside it was broken -- most importantly, a refusal that printed and then
    # configured plaintext etcd anyway would satisfy every positive assertion.
    for forbidden in scenario.dont_want:
        assert forbidden not in output, (
            f"{scenario.requirement}: {forbidden!r} must NOT appear in the output of this "
            f"scenario, and it does. On a fail-closed path a plaintext etcd endpoint means the "
            f"transport was downgraded; on the opt-out path a refusal means the two branches have "
            f"been conflated.\n{report}"
        )

    # THE NAMEREF PROOF, on the two branches that reach `echo "$params"`.
    # `configure-etcd-params` is declared `local -n params_ref=$1`, and a call
    # that gets the nameref wrong exits 0 having accumulated nothing -- so without
    # this assertion the two success scenarios would keep passing while proving
    # nothing at all about any flag.
    if scenario.params_echoed:
        params = _echoed_params(result)
        assert params.strip(), (
            f"{scenario.requirement}: configure-etcd-params echoed an EMPTY parameter string, so "
            f"no flag was accumulated. The function is declared `local -n params_ref=$1`, so it "
            f"must be called with a variable NAME as in "
            f"`params=\"\";configure-etcd-params params;echo \"$params\"` -- an empty result here "
            f"means that call shape has been broken, and every flag assertion above would then be "
            f"vacuous.\n{report}"
        )
