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

"""Token-file identities of the V7 NodeRestriction port: three fake credentials, one CSV body.

The Python (pytest) tier ports the Go security-regression surface for controls V1
through V8. This module is the DATA half of the V7 port. It carries the three
token-file identities that ``test/integration/auth/node_test.go``
``TestNodeRestrictionCrossNodeDenied`` (line 1591) declares inline, and renders them
into the exact ``--token-auth-file`` body that test writes.

Consumed by ``tests/integration/test_node_restriction.py`` (F-007 / V7), which starts a
kube-apiserver with ``--authorization-mode Node,RBAC``, ``--token-auth-file <path>`` and
``--enable-admission-plugins NodeRestriction``, then asserts that the node1 identity may
neither mutate node2's Node object nor read a Secret unrelated to its own pods, while it
retains read and status-update access to its OWN Node object.

The three identities are what make those four assertions mean anything:

* ``MASTER_IDENTITY`` is in ``system:masters``, so it is the superuser that SEEDS the
  Namespace, both Node objects and the unrelated Secret. Without a superuser the seeding
  fails and every later assertion becomes untestable.
* ``NODE1_IDENTITY`` is ``system:node:node1`` in ``system:nodes``, the identity whose
  requests the Node authorizer and the NodeRestriction admission plugin scope to node1.
  It is the SUBJECT of both denials and of both positive controls.
* ``NODE2_IDENTITY`` is ``system:node:node2`` in ``system:nodes``. The V7 test never
  builds a client for it, yet the row must exist so that node2 is a real, distinct node
  identity rather than an unknown name - and ``NODE2_NAME`` is the Node object the
  consumer must SEED BEFORE the cross-node call (see the invariant note below).

What this module is NOT:

* Not test logic. Nothing here decides whether V7 passes; the assertions live in the
  consuming test module.
* Not a pytest fixture, despite the package name. Every ``@pytest.fixture`` of this tier
  lives in a ``conftest.py``. ``write_token_csv`` therefore writes to a destination the
  CALLER owns - ``tmp_path`` - and never creates a temporary file of its own, even though
  the Go original calls ``os.CreateTemp``: in pytest the consumer owns isolation.
* Not a client factory. Turning a token into an authenticated client is the job of the
  ``client_for_token`` fixture in ``tests/integration/conftest.py``. This module imports
  nothing from ``kubernetes``, reads no environment variable, and performs no I/O at
  import time.

Usage::

    from tests.fixtures import tokens

    token_file = tokens.write_token_csv(tmp_path / "tokens.csv")
    superuser = client_for_token(tokens.MASTER_IDENTITY.token)
    node1 = client_for_token(tokens.NODE1_IDENTITY.token)

    # ORDER MATTERS: seed node2 before asserting that node1 cannot mutate it.
    seed_node(superuser, tokens.NODE1_NAME)
    seed_node(superuser, tokens.NODE2_NAME)
"""

# AAP §0.5.1 / §0.4.4.2 / tech-spec §6.6 (V7 / F-007)
#
# INVARIANT LOCKED BY THIS FILE: the three token-file identities of the V7 port and the
# byte-exact CSV body they render to. Every value is measured from
# test/integration/auth/node_test.go lines 1593-1607 and is reproduced verbatim - not
# normalised, not sorted, not re-cased, not reformatted.
#
# WHY EACH PART IS LOAD-BEARING. Weakening any of the following makes the V7 denials pass
# for the wrong reason, which is worse than a failing test because it is silent:
#
#   * The username/uid pairs. system:node:node1 with uid3 and system:node:node2 with uid4
#     are what let the Node authorizer tell the two nodes apart; admin with uid1 in
#     "system:masters" is what makes the seeding client a superuser. Change a username, a
#     uid or a group and the "Forbidden" results stop proving node scoping.
#   * The DOUBLE QUOTES around the group column, which are part of the file rather than
#     Go string syntax. The apiserver parses this file with encoding/csv and then splits
#     the fourth field on "," to obtain the group list - see NewCSV in
#     staging/src/k8s.io/apiserver/pkg/authentication/token/tokenfile/tokenfile.go, which
#     requires at least three columns and reads groups only when a fourth is present. The
#     quotes are what keep a multi-group value ONE csv field; encoding/csv strips them
#     before the split. Rendering them away, or letting a csv writer re-quote them, changes
#     the file the apiserver reads.
#   * The ABSENCE of a trailing newline. The Go original is a single
#     tokenFile.WriteString(strings.Join([...], "\n")) at line 1603-1607, so the body ends
#     immediately after the last "system:nodes". token_csv() reproduces that exactly.
#   * node2's identity being EXPORTED even though the V7 test builds no node2 client. The
#     related §0.10.2 boundary condition - NodeRestriction ordering - requires the node2
#     Node object to exist BEFORE node1 attempts to update it, otherwise the apiserver
#     answers NotFound (404) instead of the deterministic Forbidden (403) the assertion
#     needs. The ordering itself belongs to the consumer's fixture; this module's part of
#     the contract is to expose NODE2_IDENTITY and NODE2_NAME so the consumer CAN seed it.
#
# Because those values are load-bearing, TokenIdentity validates them on construction: an
# empty field, an embedded quote or newline, or a comma in the token, username or uid
# raises at import time rather than silently producing a token file with a different
# number of columns than the apiserver expects.

import pathlib
from dataclasses import dataclass
from typing import Final

__all__ = [
    "GROUP_SYSTEM_MASTERS",
    "GROUP_SYSTEM_NODES",
    "MASTER_IDENTITY",
    "NODE1_IDENTITY",
    "NODE1_NAME",
    "NODE2_IDENTITY",
    "NODE2_NAME",
    "NODE_USERNAME_PREFIX",
    "TOKEN_IDENTITIES",
    "TOKEN_MASTER",
    "TOKEN_NODE1",
    "TOKEN_NODE2",
    "TokenIdentity",
    "token_csv",
    "write_token_csv",
]

# Define credentials. Fake values for testing.
#
# That sentence is carried across verbatim from node_test.go line 1593, and it is the whole
# truth about these three strings: they are bearer tokens for an ephemeral, per-test
# kube-apiserver whose token file is written into pytest's tmp_path and deleted with it.
# They authenticate nothing that exists outside a test process. No real secret, key,
# certificate or endpoint appears in this module, and no further credential-shaped literal
# may be added to it.
#
# Go names, for the reader diffing against the original: tokenMaster (line 1594),
# tokenNode1 (line 1595), tokenNode2 (line 1596).
TOKEN_MASTER: Final[str] = "master-token"
TOKEN_NODE1: Final[str] = "node1-token"
TOKEN_NODE2: Final[str] = "node2-token"

# Group values, exactly as they appear inside the quoted fourth column of each row.
# system:masters is the group the apiserver hardwires to superuser authorization;
# system:nodes is the group the Node authorizer scopes to a single node's objects.
GROUP_SYSTEM_MASTERS: Final[str] = "system:masters"
GROUP_SYSTEM_NODES: Final[str] = "system:nodes"

# The prefix the apiserver requires on a node identity's username. It is also the single
# source from which NODE1_NAME and NODE2_NAME are derived below, so a Node object name and
# the username that owns it can never disagree.
NODE_USERNAME_PREFIX: Final[str] = "system:node:"

# Characters that would corrupt the rendered token file if they appeared inside a field:
# a double quote would open or close a csv field in the wrong place, and either newline
# character would split one record into two. Validated by TokenIdentity.__post_init__.
_CSV_HOSTILE_CHARACTERS: Final[tuple[str, ...]] = ('"', "\n", "\r")

# The csv field separator. Only the group column may legitimately contain one, because
# that column is quoted and is split on this character to produce the group list.
_CSV_FIELD_SEPARATOR: Final[str] = ","

# The csv record separator. Deliberately used with str.join and never appended, which is
# what gives token_csv() its no-trailing-newline property.
_CSV_RECORD_SEPARATOR: Final[str] = "\n"


@dataclass(frozen=True)
class TokenIdentity:
    """One record of a kube-apiserver ``--token-auth-file`` CSV, as a frozen value.

    Frozen because these are measured constants: a test that could mutate
    ``NODE1_IDENTITY.uid`` in place could silently change what a later test in the same
    session proves. Construction validates every field, so an identity that cannot render
    to a well-formed csv record cannot exist.

    Attributes:
        token: The bearer token, column 1. Presented as ``Authorization: Bearer <token>``
            and used by the apiserver as the map key for this identity.
        username: The user name the apiserver attributes to the token, column 2. For a node
            identity this is ``system:node:<node-name>``.
        uid: The user UID, column 3.
        groups: The RAW, UNQUOTED content of column 4. Held as the single string the
            apiserver actually splits rather than as a pre-split list, because that is the
            byte sequence the file must contain; ``group_names`` exposes the split view.
    """

    token: str
    username: str
    uid: str
    groups: str

    def __post_init__(self) -> None:
        """Reject any field that would render an ill-formed or ambiguous csv record.

        This is the mechanical guard on the invariant this module exists to protect: the
        rendered file must have exactly four columns per record, the fourth of which is
        quoted. A field carrying a quote, a newline, or - for the first three columns - a
        comma would change the column count that
        ``tokenfile.NewCSV`` sees while leaving every test that reads these constants
        looking perfectly healthy. Failing at import is the loud alternative.

        Raises:
            ValueError: If any field is empty, if any field contains a double quote or a
                newline, or if the token, username or uid contains a comma.
        """
        columns: tuple[tuple[str, str], ...] = (
            ("token", self.token),
            ("username", self.username),
            ("uid", self.uid),
            ("groups", self.groups),
        )

        for name, value in columns:
            if not value:
                raise ValueError(
                    f"TokenIdentity.{name} must be a non-empty string; the apiserver "
                    f"token-file parser treats an empty token column as a record to skip "
                    f"and an empty identity column as a nameless user"
                )
            for character in _CSV_HOSTILE_CHARACTERS:
                if character in value:
                    raise ValueError(
                        f"TokenIdentity.{name}={value!r} contains {character!r}, which "
                        f"would change the column or record boundaries of the rendered "
                        f"token file"
                    )

        # The group column is the ONLY one allowed to contain a comma: it is quoted
        # precisely so that a multi-group value stays one csv field, which the apiserver
        # then splits on the comma. A comma anywhere else adds a column.
        for name, value in columns[:3]:
            if _CSV_FIELD_SEPARATOR in value:
                raise ValueError(
                    f"TokenIdentity.{name}={value!r} contains "
                    f"{_CSV_FIELD_SEPARATOR!r}, which would add a column to the rendered "
                    f"token file; only the quoted group column may contain one"
                )

    @property
    def group_names(self) -> tuple[str, ...]:
        """The groups the apiserver attributes to this identity.

        Mirrors ``strings.Split(record[3], ",")`` in ``tokenfile.NewCSV``: the quoted
        fourth column is one csv field, and the apiserver splits it on commas to obtain the
        group list. Returned as a tuple so a consumer cannot mutate shared test data.
        """
        return tuple(self.groups.split(_CSV_FIELD_SEPARATOR))

    @property
    def is_node(self) -> bool:
        """Whether this identity is a kubelet identity, i.e. one the Node authorizer scopes."""
        return self.username.startswith(NODE_USERNAME_PREFIX)

    @property
    def node_name(self) -> str:
        """The name of the Node object this identity owns, derived from its username.

        Derived rather than stored, so the Node object a test seeds and the identity that
        is allowed to act on it are guaranteed to be the same node. A second, hand-written
        copy of ``node1`` could drift from ``system:node:node1`` and turn a Forbidden
        assertion into a NotFound one.

        Raises:
            ValueError: If this identity is not a node identity, which makes the request
                meaningless rather than merely unanswerable.
        """
        if not self.is_node:
            raise ValueError(
                f"{self.username!r} is not a node identity, so it owns no Node object; a "
                f"node name can only be derived from a username prefixed "
                f"{NODE_USERNAME_PREFIX!r}"
            )
        return self.username.removeprefix(NODE_USERNAME_PREFIX)

    @property
    def csv_row(self) -> str:
        """This identity as one line of the token file, quotes intact.

        The expression below is deliberately shaped like the Go line it ports, so the two
        can be read side by side::

            fmt.Sprintf(`%s,admin,uid1,"system:masters"`, tokenMaster)

        The double quotes are literal file content, written directly rather than through a
        csv writer, because a csv writer would quote by its own rules - stripping the
        quotes from a single-group value or escaping them - and the file the apiserver reads
        would no longer be the file the Go test wrote.
        """
        return f'{self.token},{self.username},{self.uid},"{self.groups}"'


# The three records, in the order node_test.go writes them (lines 1604-1606). The order is
# reproduced because the rendered body must be byte-identical, and it is also the order a
# reader of either file expects: superuser first, then the two node identities.
#
#   master-token,admin,uid1,"system:masters"
MASTER_IDENTITY: Final[TokenIdentity] = TokenIdentity(
    token=TOKEN_MASTER,
    username="admin",
    uid="uid1",
    groups=GROUP_SYSTEM_MASTERS,
)

#   node1-token,system:node:node1,uid3,"system:nodes"
NODE1_IDENTITY: Final[TokenIdentity] = TokenIdentity(
    token=TOKEN_NODE1,
    username=f"{NODE_USERNAME_PREFIX}node1",
    uid="uid3",
    groups=GROUP_SYSTEM_NODES,
)

#   node2-token,system:node:node2,uid4,"system:nodes"
NODE2_IDENTITY: Final[TokenIdentity] = TokenIdentity(
    token=TOKEN_NODE2,
    username=f"{NODE_USERNAME_PREFIX}node2",
    uid="uid4",
    groups=GROUP_SYSTEM_NODES,
)

# Every identity of the token file, in file order. A tuple rather than a list so a consumer
# cannot append, reorder or clear the shared test data, and so token_csv() has exactly one
# source of records.
TOKEN_IDENTITIES: Final[tuple[TokenIdentity, ...]] = (
    MASTER_IDENTITY,
    NODE1_IDENTITY,
    NODE2_IDENTITY,
)

# The Node object names the consumer seeds, DERIVED from the usernames above rather than
# written a second time: NODE1_NAME is "node1" because NODE1_IDENTITY is system:node:node1,
# and NODE2_NAME is "node2" because NODE2_IDENTITY is system:node:node2. NODE2_NAME is the
# one the §0.10.2 ordering condition is about - it must be created before node1 attempts to
# update node2's status, or the apiserver answers NotFound rather than Forbidden.
NODE1_NAME: Final[str] = NODE1_IDENTITY.node_name
NODE2_NAME: Final[str] = NODE2_IDENTITY.node_name


def token_csv() -> str:
    """Render the complete ``--token-auth-file`` body of the V7 port.

    Ports ``strings.Join([...], "\\n")`` from node_test.go lines 1603-1607, built from
    ``TOKEN_IDENTITIES`` so each value has exactly one definition.

    Returns:
        The three records separated by a single newline each, with the group column quoted
        and with **no trailing newline** - the body ends immediately after the final
        ``"system:nodes"``, exactly as the single ``WriteString`` in the Go original does.
        Appending a newline here would be a change to a shipped artifact's bytes, so the
        separator is only ever joined between records, never added after the last one.
    """
    return _CSV_RECORD_SEPARATOR.join(identity.csv_row for identity in TOKEN_IDENTITIES)


def write_token_csv(path: pathlib.Path) -> pathlib.Path:
    """Write :func:`token_csv` to a destination the caller owns.

    The Go original calls ``os.CreateTemp("", "kubeconfig")`` and leaves the file behind. In
    pytest the consumer owns isolation, so this helper creates nothing of its own: it writes
    where it is told - conventionally ``tmp_path / "tokens.csv"``, which pytest cleans up -
    sets no permissions, and registers no finaliser.

    Args:
        path: The destination file. Its parent directory must already exist, which is true
            of ``tmp_path`` and of any directory below it that the caller created.

    Returns:
        The path written to, so a caller can inline the call where an apiserver's
        ``--token-auth-file`` value is assembled.

    Raises:
        OSError: If the destination cannot be written - it does not exist, is a directory,
            or is not writable. The exception carries the offending path, so it is allowed
            to propagate unwrapped rather than being re-raised with less information.
    """
    # Accepts a str or any os.PathLike from an unannotated caller as well as the Path the
    # signature asks for; for a Path this is an identity conversion.
    destination = pathlib.Path(path)

    # encoding is explicit so the bytes on disk never depend on the ambient locale, and
    # newline="\n" disables the platform line-ending translation that write_text would
    # otherwise apply - together they make the file byte-identical to token_csv().
    destination.write_text(token_csv(), encoding="utf-8", newline="\n")

    return destination
