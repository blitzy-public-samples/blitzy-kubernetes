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

"""Package marker making `tests.fixtures` importable: the test DATA of the Python tier.

The Python (pytest) tier ports the Go security-regression surface for controls
V1 through V8. The case matrices and constants those ports assert against live
in this package, and this module is what makes them reachable by name from every
tier: `from tests.fixtures.encryption_config import AESGCM_PREFIX` rather than a
literal copied into each test module that needs it.

This package holds DATA. Three distinctions are load-bearing:

* Not test logic. Assertions live in the `test_*.py` modules that consume these
  values; nothing in this package decides whether a control passes or fails.
* Not pytest fixtures, despite the package name. Every `@pytest.fixture` of this
  tier lives in a `conftest.py`, never inline in a module, because under
  `--doctest-modules` a module-, package- or session-scoped autouse fixture
  declared inline can execute twice. "Fixture" here carries its older sense:
  fixed input data.
* Not a re-export barrel. This module deliberately defines no runtime symbol and
  declares no `__all__`; consumers import `tests.fixtures.<module>` directly.
"""

# AAP §0.5.1 / §0.4.4.2 / tech-spec §6.6
#
# INVARIANT LOCKED BY THIS FILE: every constant and every case matrix in this
# package has EXACTLY ONE definition, importable from every tier that needs it.
# Single-sourcing is the concrete gain from leaving a Go limitation behind: a Go
# `_test.go` file is not importable across packages, so the suite being ported
# had to replicate shared helpers inline and say so - see
# test/integration/secrets/encryption_test.go lines 69-72, where etcdKeyForSecret
# carries exactly that annotation. A regular Python package removes the need,
# and with it the possibility of two copies of one security constant drifting
# apart while both tests stay green.
#
# Two consequences the plan states explicitly, and the reason single-sourcing is
# load-bearing here rather than merely tidy:
#   * audit_policy_cases.py is consumed by BOTH the L1 shell audit module
#     tests/unit/shell/test_audit_policy.py and the L2 integration audit module
#     tests/integration/test_audit_sensitive_resources.py, so the V6 principal
#     and selector vocabulary and the none/metadata/request/response level
#     aliases have one definition rather than two that can silently diverge.
#   * encryption_config.py is consumed by BOTH the L2 encryption module
#     tests/integration/test_secrets_encryption.py and the L3 config module
#     tests/unit/config/test_encryption_provider_config.py, so the V3 aesgcm
#     ciphertext prefix and the plaintext canary have one definition rather than
#     two that can silently diverge.
#
# The rest of the package: etcd_env_cases.py (the kube-apiserver etcd
# environment cases), pss_pods.py (privileged, hostPID and plain pod builders)
# and tokens.py (the token CSV builder), plus templates/, which holds rendering
# input consumed as a file rather than imported.
#
# WHY THIS FILE IS EMPTY OF BEHAVIOUR. It is a package marker and nothing more,
# symmetrical with tests/helpers/__init__.py:
#   * No import of a sibling module. A barrel would make importing any one of
#     these modules drag in all five, and would create an import-order
#     dependency this package must not have.
#   * No import-time side effect - no I/O, no environment read, no logging
#     configuration, no sys.path manipulation. `pythonpath = ["."]` in
#     python/pyproject.toml already puts python/ on sys.path, which is what
#     makes `tests.fixtures` resolve with no install step; repeating it here
#     would be a second, competing mechanism.
#   * No `__all__`, no `__version__`, no package-level logger, no type alias.
#     Importing this package must cost nothing, so it can never be the reason a
#     test fails.
#
# python/tests/ itself deliberately carries no __init__.py - only fixtures/ and
# helpers/ do - so `tests` stays an implicit namespace package resolved through
# that same `pythonpath` entry, with consider_namespace_packages on the pytest
# side and explicit_package_bases on the mypy side handling the rest.
