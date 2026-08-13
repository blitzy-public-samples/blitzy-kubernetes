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

"""The two hardened GCE profile defaults: advanced audit ON, insecure etcd OFF.

AAP §0.4.2.3 / §0.5.1 / §0.10.2 (V6 + V8) — tech-spec §6.4.6 (audit levels),
§6.4.5 (encryption / etcd transport). The artifacts under test cite those
sections themselves: ``cluster/gce/config-default.sh`` says "See tech-spec
§6.4.6 (audit levels)" immediately above the audit assignment, and both profiles
say "etcd transport hardening (AAP V8, tech-spec §6.2.4.6)" immediately above
the etcd assignment. Only sections the repository actually states are cited
here, and no standards control identifier is asserted anywhere in this module,
because the repository enumerates none (AAP §0.11.1 bar item B11).

INVARIANTS LOCKED BY THIS MODULE — three, and the third is what makes the
second trustworthy:

1. F-006-RQ-003. ``ENABLE_APISERVER_ADVANCED_AUDIT`` ships a default of
   ``true`` on BOTH GCE reference profiles. Without it, advanced
   (policy-based) API-server audit logging is off, so the hardened audit
   policy that ``create-master-audit-policy`` generates — the one that raises
   Secrets and ServiceAccount-token operations to the Request level — is never
   applied and ``--audit-policy-file`` is never wired. The V6 generator can be
   perfect and still audit nothing.
2. F-008-RQ-002. ``ETCD_APISERVER_ALLOW_INSECURE`` ships a default of
   ``false`` on BOTH profiles. A ``true`` default would let
   ``configure-etcd-params`` take its plaintext branch when etcd mTLS
   credentials are absent, so the API server would fall back to
   ``http://127.0.0.1:2379`` instead of failing closed — which defeats V8's
   mutual-TLS transport outright.
3. THE VALUE IS READ FROM AN ASSIGNMENT, NEVER FROM A COMMENT. Both profiles
   carry a prose line that literally contains
   ``ETCD_APISERVER_ALLOW_INSECURE=true`` (the documented local/dev opt-in), so
   a parser that failed to skip comment lines would read ``true`` from prose
   and assert the exact OPPOSITE of invariant 2 — a false pass on the most
   security-sensitive check in this file. Invariant 3 is asserted, not assumed.

WHY BOTH PROFILES, EACH AS ITS OWN PARAMETRIZED CASE

AAP §0.10.2 records the boundary as "``ETCD_APISERVER_ALLOW_INSECURE=false``
and ``ENABLE_APISERVER_ADVANCED_AUDIT=true`` on BOTH GCE profiles", because a
one-sided edit "would leave the test profile insecure while the default profile
stayed green". Parametrizing over the profiles with the ids ``config-default``
and ``config-test`` makes that visible in the report: a one-sided break fails
exactly one named node id, and a both-sided break fails two. This assertion is
never to be relaxed to "on at least one profile".

THE PAIRING THIS MODULE COMPLETES

``python/tests/unit/shell/test_etcd_failclosed.py`` proves the RUNTIME
behaviour of ``configure-etcd-params``
(``cluster/gce/gci/configure-kubeapiserver.sh``): with etcd credentials absent
and the flag not ``"true"``, it refuses to fall back to plaintext etcd and
exits 1. THIS module proves the SHIPPED DEFAULT that selects that branch. The
two are complementary and neither substitutes for the other — note that the
shell function carries a deliberate function-local ``":-true"``
backward-compatibility shim for direct unit-test invocation, so the fail-closed
posture of a real deployment rests entirely on the profile defaults asserted
here. AAP §0.7.1.4 records the profile-default half of V8 as having no
automated test today, verified only by inspection, so this module is a genuine
automation gain rather than a port.

TIER DISCIPLINE — L3 CONFIG-SCHEMA UNIT

Pure by construction: no subprocess, no ``bash``, no network, no etcd, no API
server, and nothing written anywhere. ``pytest -m "not integration"`` runs it.
The two profiles are READ-ONLY committed inputs (AAP §0.11.1 bar item B4): this
module parses their text and asserts, it never edits them, and it never
re-implements shell in Python. The shell-boundary tier that does invoke bash
lives in ``python/tests/unit/shell/`` and is a different folder on purpose.

WHY THE PARSER BELOW IS MODULE-PRIVATE AND DUPLICATED ON PURPOSE

``python/tests/unit/config/test_admission_control_profiles.py`` parses the same
two profiles and needs the same parsing semantics. The duplication is
deliberate and scope-bounded: the AAP declares no shared shell-profile-parsing
helper — the eight ``tests.helpers.*`` modules are ``bash``, ``manifest``,
``polling``, ``apierrors``, ``audit_log``, ``warnings``, ``etcd_raw`` and
``jwtclaims``, and none of them parses shell variables — and this folder is
fixed at six test modules with no ``conftest.py`` and no ``__init__.py``. Two
independent implementations of a specified behaviour are the intended shape
here; do not "fix" it by inventing a shared module.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final, NamedTuple

import pytest

# The only marker this module may carry. python/pyproject.toml declares exactly
# five (integration, shell, config, parity, slow) and addopts carries
# --strict-markers, so anything else is a hard collection error. The root
# conftest.py applies `integration` by path and deliberately infers none of the
# other four, so `config` has to be declared right here.
pytestmark = pytest.mark.config


# ---------------------------------------------------------------------------
# What is under test, and what the answer has to be
# ---------------------------------------------------------------------------

#: The V6 switch. cluster/gce/config-default.sh L423 and config-test.sh L474 at
#: the time of writing. Line numbers appear in this module ONLY as provenance,
#: in comments and failure messages; nothing asserts one, because they drift
#: with unrelated edits and an assertion on them would be brittle noise.
AUDIT_ENABLED_VARIABLE: Final[str] = "ENABLE_APISERVER_ADVANCED_AUDIT"

#: The V8 fail-closed switch. config-default.sh L446 and config-test.sh L492.
#: Its adjacent prose lines — config-default.sh L445 and config-test.sh L491 —
#: are the comment decoys invariant 3 defends against.
INSECURE_ETCD_VARIABLE: Final[str] = "ETCD_APISERVER_ALLOW_INSECURE"


class RequiredDefault(NamedTuple):
    """One profile default this module locks, with the requirement it serves.

    A named tuple rather than a bare pair so that a failure message can state
    the requirement identifier and the security consequence of getting it
    wrong: a reader of a red CI job for a security test is frequently not the
    author of the test (AAP §0.7.2, failure legibility).
    """

    #: The shell variable name, exactly as the profiles spell it.
    variable: str
    #: The shipped default, compared with case-sensitive STRING equality. Never
    #: coerced through ``bool()``: ``"false"`` is a truthy Python string, so a
    #: truthiness helper here would silently invert F-008-RQ-002.
    expected: str
    #: The requirement identifier this row enforces.
    requirement: str
    #: What goes wrong in a real deployment when the default is not ``expected``.
    consequence: str


#: Exactly the two variables AAP §0.10.2 puts inside this module's boundary, and
#: no others. Sibling profile knobs (ADVANCED_AUDIT_LOG_MODE,
#: ENCRYPTION_PROVIDER_CONFIG, the audit log tunables) are outside
#: F-006-RQ-003 and F-008-RQ-002 and are deliberately not asserted here; other
#: modules in this folder own their own requirements.
REQUIRED_DEFAULTS: Final[tuple[RequiredDefault, ...]] = (
    RequiredDefault(
        variable=AUDIT_ENABLED_VARIABLE,
        expected="true",
        requirement="F-006-RQ-003",
        consequence=(
            "advanced (policy-based) API-server audit logging would be OFF by default, so the "
            "hardened policy generated by create-master-audit-policy in "
            "cluster/gce/gci/configure-helper.sh would never be applied and "
            "--audit-policy-file would never be wired; the V6 audit-level guarantees would "
            "then hold over a policy nothing reads"
        ),
    ),
    RequiredDefault(
        variable=INSECURE_ETCD_VARIABLE,
        expected="false",
        requirement="F-008-RQ-002",
        consequence=(
            "configure-etcd-params in cluster/gce/gci/configure-kubeapiserver.sh would take "
            "its plaintext branch whenever the etcd mTLS credentials are absent, letting the "
            "API server fall back to plaintext etcd (http://127.0.0.1:2379) instead of "
            "refusing to start, which defeats V8's mutual-TLS transport entirely"
        ),
    ),
)

#: The two GCE reference profiles under test. Each entry is simultaneously the
#: parametrization id (so a failure names the profile that broke) and the file
#: stem beneath ``cluster/gce/`` (so :func:`_profile_path` needs no second
#: table that could drift out of step with the ids).
PROFILE_STEMS: Final[tuple[str, str]] = ("config-default", "config-test")


# ---------------------------------------------------------------------------
# The parser. Specified by AAP §0.4.2.3 and built for the form the profiles
# ACTUALLY use, not for an idealised `VAR=value` (bar item B2 -- evidence over
# assumption). The measured form is
#
#     ENABLE_APISERVER_ADVANCED_AUDIT=${ENABLE_APISERVER_ADVANCED_AUDIT:-true} # true, false
#
# so three things are true at once: the shipped default is the literal after
# `:-` inside a parameter expansion, there is a trailing `# true, false`
# comment to discard, and a neighbouring PROSE line carries the same variable
# name with the opposite value.
# ---------------------------------------------------------------------------

#: A POSIX shell variable name, used to recognise the parameter expansion that
#: carries the default. Anchored to identifier characters so that a `${...}`
#: form this module has no evidence for cannot be silently reinterpreted.
_SHELL_IDENTIFIER: Final[str] = r"[A-Za-z_][A-Za-z0-9_]*"

#: The characters bash treats as a word separator before an inline `#`. A `#`
#: NOT preceded by one of these does not start a comment: `VAR=a#b` really does
#: assign `a#b`, and `${ETCD_SERVERS_OVERRIDES:-/events#http://127.0.0.1:4002}`
#: on the same script really does keep its `#`.
_COMMENT_SEPARATORS: Final[tuple[str, str]] = (" ", "\t")

#: The quote characters stripped as one matching outer pair. Both forms occur in
#: these profiles: config-default.sh L416 quotes its right-hand side, L423 does
#: not, and L401 additionally prefixes `export`.
_QUOTE_CHARACTERS: Final[tuple[str, str]] = ('"', "'")


def _assignment_pattern(name: str) -> re.Pattern[str]:
    """Match an assignment to ``name``, tolerating indentation and ``export``.

    ``^[ \\t]*`` and not ``^``: an assignment may be indented, as
    ``cluster/gce/config-test.sh`` L418 already is, so anchoring hard to column
    zero would stop matching the day one of these lines moves inside a
    conditional block. ``export`` is optional for the same measured reason —
    ``config-default.sh`` L401 uses it — and the name is escaped rather than
    trusted, on principle.

    The trailing ``(?P<rhs>.*)`` deliberately captures the WHOLE remainder of
    the line, comment and all; discarding the comment is
    :func:`_strip_inline_comment`'s job and is done with quote awareness that a
    regex cannot express.
    """
    return re.compile(rf"^[ \t]*(?:export[ \t]+)?{re.escape(name)}=(?P<rhs>.*)$")


def _strip_inline_comment(right_hand_side: str) -> str:
    """Drop a trailing ``#`` comment from a right-hand side, respecting quotes.

    Implements bash's actual rule rather than "cut at the first ``#``": a
    comment begins only at a ``#`` that is outside quotes AND preceded by a
    space or a tab. Both halves matter on these very files — the measured lines
    end in ``} # true, false`` (stripped), while
    ``${ETCD_SERVERS_OVERRIDES:-/events#http://127.0.0.1:4002}`` elsewhere in
    the tree contains a ``#`` that must survive.
    """
    quote: str | None = None
    for index, character in enumerate(right_hand_side):
        if quote is not None:
            # Inside a quoted run nothing is special except its own closer.
            if character == quote:
                quote = None
            continue
        if character in _QUOTE_CHARACTERS:
            quote = character
            continue
        if (
            character == "#"
            and index > 0
            and right_hand_side[index - 1] in _COMMENT_SEPARATORS
        ):
            return right_hand_side[:index]
    return right_hand_side


def _unquote(value: str) -> str:
    """Strip exactly ONE matching outer quote pair, double or single."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in _QUOTE_CHARACTERS:
        return value[1:-1]
    return value


def _shell_assignments(text: str, name: str) -> list[str]:
    """Every right-hand side assigned to ``name`` on a NON-COMMENT line, in order.

    COMMENT LINES ARE SKIPPED BEFORE ANY MATCHING IS ATTEMPTED, which is the
    first of three independent defences behind invariant 3 of this module's
    docstring. ``cluster/gce/config-default.sh`` L445 reads
    ``# ETCD_APISERVER_ALLOW_INSECURE=true before invoking the profile.`` and
    ``config-test.sh`` L491 reads ``# ETCD_APISERVER_ALLOW_INSECURE=true.``;
    both are prose documenting the local/dev opt-in. A parser that matched
    first and filtered later would read ``true`` from prose and report the
    OPPOSITE of F-008-RQ-002 as a pass.

    The other two defences are stated here because a future edit that weakens
    one while trusting the others is exactly how this returns: the ``^[ \\t]*``
    anchor in :func:`_assignment_pattern` also refuses a leading ``#``, and the
    "exactly one assignment" guard in the test fires if a decoy is ever read
    alongside the real assignment. Each was verified to fail this module's own
    assertions when removed. DO NOT rely on any one of them alone.

    Returns every match rather than the first, so the caller can see the shape
    of what it is asserting on instead of trusting that there was exactly one.
    """
    pattern = _assignment_pattern(name)
    right_hand_sides: list[str] = []
    for line in text.splitlines():
        candidate = line.lstrip()
        if not candidate or candidate.startswith("#"):
            continue
        match = pattern.match(line)
        if match is not None:
            right_hand_sides.append(match.group("rhs"))
    return right_hand_sides


def _shell_default(text: str, name: str) -> str | None:
    """The default ``text`` ships for ``name``, or ``None`` when it ships none.

    ``None`` is a first-class answer and the caller MUST treat it as a failure
    (see the vacuity guard in the test below). Returning it, rather than an
    empty string or a guess, is what turns a renamed or reformatted assignment
    into a red test instead of a comparison that never happens.

    Resolution order, each step justified by a measured form:

    1. The LAST non-comment assignment wins, which is bash's own semantics for
       a variable assigned more than once.
    2. The trailing inline comment is discarded (``} # true, false``).
    3. One matching outer quote pair is removed, so ``"${V:-false}"`` and
       ``${V:-false}`` resolve identically.
    4. A ``${NAME:-default}`` or ``${NAME-default}`` expansion yields its
       literal default. Returning the raw ``${...}`` text here instead would
       make every comparison below fail for the wrong reason.
    5. A plain literal (``VAR=false``) is returned as it stands, so the helper
       is correct for a profile that ever stops using an expansion.
    6. Any other ``${...}`` shape — no default at all, or a default taken from
       a DIFFERENT variable — yields ``None`` rather than a value this module
       has no evidence for. Loud beats clever.
    """
    right_hand_sides = _shell_assignments(text, name)
    if not right_hand_sides:
        return None

    value = _unquote(_strip_inline_comment(right_hand_sides[-1]).strip()).strip()
    if not value.startswith("${"):
        return value

    expansion = re.fullmatch(
        rf"\$\{{(?P<variable>{_SHELL_IDENTIFIER})(?::-|-)(?P<default>.*)\}}",
        value,
    )
    if expansion is None or expansion.group("variable") != name:
        return None
    return _unquote(expansion.group("default").strip()).strip()


# ---------------------------------------------------------------------------
# Locating and reading the profiles. No I/O happens at import time: every path
# is resolved from the session-scoped `repo_root` fixture inside the test, never
# from the process working directory and never from __file__ arithmetic here.
# ---------------------------------------------------------------------------


def _profile_path(repo_root: Path, profile: str) -> Path:
    """``<repo_root>/cluster/gce/<profile>.sh`` for one of :data:`PROFILE_STEMS`."""
    return repo_root / "cluster" / "gce" / f"{profile}.sh"


def _read_profile(path: Path) -> str:
    """Read a profile script, ABORTING loudly if it is missing or empty.

    This is the ``t.Fatalf`` half of the translation: a profile that cannot be
    read is setup breakage, not a finding, and continuing would produce
    assertions about an empty string that "pass" by parsing nothing.
    """
    __tracebackhide__ = True
    assert path.is_file(), (
        f"SETUP: the GCE profile {path} does not exist. This module asserts the shipped "
        f"defaults of cluster/gce/config-default.sh and cluster/gce/config-test.sh, resolved "
        f"from the session-scoped `repo_root` fixture in python/tests/conftest.py; a missing "
        f"file means the path or the checkout is wrong, not that a requirement is satisfied."
    )
    text = path.read_text(encoding="utf-8")
    assert text.strip(), (
        f"SETUP: the GCE profile {path} is empty. Every assertion below would then be "
        f"vacuous, so this aborts instead."
    )
    return text


# ---------------------------------------------------------------------------
# The test. One parametrized case per profile; inside a case, the two variables
# ACCUMULATE through pytest 9's native subtests.
#
# This module has no Go ancestor, so the intent of Go's t.Fatalf / t.Errorf
# split is applied rather than a line of it ported (AAP §0.4.1.2):
#
#   t.Fatalf  ->  a bare `assert` outside any subtest. Setup breakage and the
#                 vacuity guard abort, because there is nothing meaningful left
#                 to check once the artifact cannot be read or parsed.
#   t.Errorf  ->  `with subtests.test(...)`. A wrong VALUE is a finding, and one
#                 run must report BOTH findings rather than stopping at the
#                 first, exactly as the V1 port reports every offending
#                 ClusterRole.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("profile", list(PROFILE_STEMS), ids=list(PROFILE_STEMS))
def test_hardened_audit_and_etcd_profile_defaults(
    profile: str,
    repo_root: Path,
    subtests: pytest.Subtests,
) -> None:
    """Locks F-006-RQ-003 and F-008-RQ-002 on one profile; prose answers for neither.

    * ``ENABLE_APISERVER_ADVANCED_AUDIT`` ships a default of ``true``, so the
      hardened audit policy V6 generates is actually applied (F-006-RQ-003).
    * ``ETCD_APISERVER_ALLOW_INSECURE`` ships a default of ``false``, so
      ``configure-etcd-params`` fails closed instead of falling back to
      plaintext etcd (F-008-RQ-002).
    * Both values are read from an ASSIGNMENT and never from the commented
      local/dev opt-in that both profiles carry in prose.
    """
    profile_path = _profile_path(repo_root, profile)
    text = _read_profile(profile_path)

    # ---- abort tier: shape and vacuity, before a single value is compared ----
    #
    # The vacuity guard is mandatory (AAP §0.4.2.3). Without it, a regex that
    # stopped matching would hand `None` to a comparison that never ran, and
    # this module would report green having verified nothing at all -- the
    # failure mode a security test can least afford.
    defaults: dict[str, str] = {}
    for required in REQUIRED_DEFAULTS:
        right_hand_sides = _shell_assignments(text, required.variable)
        default = _shell_default(text, required.variable)

        assert default is not None, (
            f"VACUITY GUARD ({required.requirement}): no shipped default for "
            f"{required.variable} could be read from {profile_path}. Non-comment assignments "
            f"found: {right_hand_sides!r}. The measured form is "
            f"`{required.variable}=${{{required.variable}:-{required.expected}}}` "
            f"(cluster/gce/config-default.sh L423 and L446, cluster/gce/config-test.sh L474 "
            f"and L492 when this module was written -- provenance only, never asserted). "
            f"Either the assignment was renamed, removed or reformatted, or it now defaults "
            f"through a different variable. This ABORTS rather than skipping the comparison, "
            f"because a skipped comparison would look like a pass."
        )
        assert len(right_hand_sides) == 1, (
            f"SHAPE ({required.requirement}): expected exactly ONE non-comment assignment to "
            f"{required.variable} in {profile_path}, found {len(right_hand_sides)}: "
            f"{right_hand_sides!r}. The measured shape of both hardened profiles is a single "
            f"assignment per variable. With more than one, the effective default depends on "
            f"evaluation order -- possibly on a conditional this module cannot see -- so it "
            f"can no longer be decided by reading the file and a human must review the change."
        )
        defaults[required.variable] = default

    # ---- accumulate tier: the two findings, both reported in one run ----
    for required in REQUIRED_DEFAULTS:
        with subtests.test(profile=profile, variable=required.variable):
            observed = defaults[required.variable]
            assert observed == required.expected, (
                f"{required.requirement} VIOLATED in {profile_path}: {required.variable} ships "
                f"a default of {observed!r}, expected {required.expected!r} (compared as a "
                f"case-sensitive string; never coerced with bool(), under which the truthy "
                f'Python string "false" would invert this very check). Consequence: '
                f"{required.consequence}. Both hardened GCE profiles must agree -- a one-sided "
                f"edit would leave one profile insecure while the other stayed green (AAP "
                f"§0.10.2), which is why this test runs once per profile. Fix the profile; do "
                f"NOT relax this assertion."
            )

    # ---- the negative half of F-008-RQ-002: prose cannot answer for policy ----
    #
    # The two-line proof that the value above came from an assignment and not
    # from the comment decoy. Both checks use a SYNTHETIC commented assignment
    # rather than matching the profile's own prose, so rewording a comment can
    # never fail this test -- only losing comment immunity can. The real
    # profiles already carry such a line today (config-default.sh L445,
    # config-test.sh L491), which is precisely why the property is asserted
    # instead of assumed.
    with subtests.test(profile=profile, check="comment-immunity"):
        # Deliberately the OPPOSITE of the value resolved above, so this check
        # can never be vacuous: were a commented assignment ever read, the
        # resolved default would visibly change.
        opposite = "false" if defaults[INSECURE_ETCD_VARIABLE] == "true" else "true"
        commented_assignment = f"# {INSECURE_ETCD_VARIABLE}={opposite}\n"

        assert _shell_default(commented_assignment, INSECURE_ETCD_VARIABLE) is None, (
            f"F-008-RQ-002 (comment immunity): a COMMENTED assignment "
            f"({commented_assignment.strip()!r}) was read as a shipped default. Both GCE "
            f"profiles document the local/dev opt-in in prose that literally contains "
            f"{INSECURE_ETCD_VARIABLE}=true, so a parser that reads comments asserts the "
            f"exact opposite of F-008-RQ-002 and passes while doing it."
        )
        assert (
            _shell_default(text + "\n" + commented_assignment, INSECURE_ETCD_VARIABLE)
            == defaults[INSECURE_ETCD_VARIABLE]
        ), (
            f"F-008-RQ-002 (comment immunity): appending the commented assignment "
            f"{commented_assignment.strip()!r} to {profile_path} changed the default this "
            f"module reads. Comment lines are skipped BEFORE any matching is attempted "
            f"precisely so that prose can never override the assignment; that ordering has "
            f"regressed."
        )
