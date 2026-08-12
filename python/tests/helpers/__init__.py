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

"""Harness primitives ported from the Go test suite, shared by every tier.

This file is the package marker for ``python/tests/helpers``. Its whole job is
to make that directory a regular Python package, so that the modules beside it
resolve under their fully qualified names and a test can import one primitive
without knowing which tier first needed it::

    from tests.helpers.apierrors import is_forbidden

WHY THE PRIMITIVES LIVE IN A PACKAGE OF THEIR OWN

Go will not let one package import another package's ``_test.go`` file, so the
Go suite has no way to share a test helper across a package boundary and pays
for it by copying. ``test/integration/secrets/encryption_test.go`` derives the
raw etcd key of a Secret from its own local copy of that logic and records, in
a comment on the function itself, that the copy exists only because the
identical helper in a neighbouring package is unreachable. Every such copy is
somewhere the key derivation can drift away from the one the apiserver storage
layer really uses, while each copy on its own keeps passing.

Python has no equivalent rule: a test module imports an ordinary module. So
each primitive is written exactly once in this package and imported wherever it
is needed, and that drift has nowhere to start. Preserving this single-source
property is why a helper belongs here rather than inline in whichever test
module happens to need it first.

WHAT SITS BESIDE THIS FILE

Each module ports one Go harness primitive and is named after the primitive,
never after the test that first called it:

    bash.py       subprocess invoker for the shipped bash generators, from
                  ``mustInvokeFunc`` in
                  cluster/gce/gci/configure_helper_test.go
    manifest.py   KUBE_HOME layout, template copy and pod-manifest load, from
                  ``ManifestTestCase`` in that same file
    polling.py    bounded poll-to-convergence helper, from ``wait.Poll`` in
                  k8s.io/apimachinery
    apierrors.py  status predicates over ``ApiException``, from
                  ``apierrors.IsForbidden`` and its siblings
    audit_log.py  audit-log reader and missing-events report, from
                  ``CheckAuditLines`` in test/utils/audit.go
    warnings.py   lock-guarded warning recorder, from the
                  ``recordingWarningHandler`` in
                  test/integration/auth/svcaccttoken_test.go
    etcd_raw.py   raw etcd prefix scan, from ``GetEtcdClients`` in
                  test/integration/utils.go
    jwtclaims.py  token claim decoding, from ``getPayload``, ``getSubObject``
                  and ``checkExpiration`` in
                  test/integration/auth/svcaccttoken_test.go

``warnings.py`` shadows nothing. Imports are absolute, so a sibling that wants
the standard library's warning machinery still writes ``import warnings`` and
gets it; only ``tests.helpers.warnings`` names the recorder.

WHAT THIS FILE DELIBERATELY DOES NOT DO

It re-exports nothing, and that is a functional decision rather than
minimalism. Importing the modules above from here would make a bare
``import tests.helpers`` pull in the Kubernetes client, etcd3gw and PyJWT
transitively, so the shell tier, which needs ``bash.py`` and a bash
interpreter and nothing else, would stop being importable the moment an
unrelated pin was missing from the environment. It would also impose an import
order on modules that legitimately import one another.

It declares no fixture. Fixtures belong to the tier's conftest.py files, which
are tests/conftest.py, tests/unit/shell/conftest.py,
tests/integration/conftest.py and tests/parity/conftest.py, because a module-,
package- or session-scoped autouse fixture declared inline in an ordinary
module can be executed twice under ``--doctest-modules``.

It declares no test, so this module contributes nothing to collection.

It touches no ``sys.path`` and reads no ``__file__``. python/pyproject.toml
sets ``pythonpath = ["."]`` precisely so that ``tests.helpers.*`` resolves from
python/ with no install step, and python/tests deliberately carries no
``__init__.py`` of its own: ``tests`` is an implicit namespace package, which
``consider_namespace_packages`` in that same file and mypy's
``explicit_package_bases`` beside it are configured to honour.
"""

# AAP §0.5.1 (the python/tests/helpers/__init__.py row, "Package marker") /
# §0.4.4.2 (the eight harness modules enumerated above) / tech-spec §0.4.1.2,
# whose closing row records that Go's "test files are not importable across
# packages" limitation disappears in Python. Capitalising on that is the whole
# reason this package exists.
#
# INVARIANT LOCKED BY THIS FILE: tests.helpers is an importable package whose
# own public surface is EMPTY. dir() must expose no public name, importing it
# must pull in no third-party distribution, and it must collect no test. Add a
# re-export here and every tier silently inherits every helper's dependencies;
# add a fixture here and it can run twice.
