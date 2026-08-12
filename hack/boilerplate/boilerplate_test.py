#!/usr/bin/env python3

# Copyright 2016 The Kubernetes Authors.
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

"""Gate test for the Apache-2.0 licence-header scanner (``boilerplate.py``).

Provenance: AAP §0.4.3 / §0.5.3 (express this test as a plain pytest function
and grow its expected list for the new ``.ts``/``.tsx`` fixtures) and tech-spec
§6.6.3.4 (every Blitzy-authored or Blitzy-modified test carries an inline
provenance citation plus a comment naming the invariant it locks).

Run it from the ``hack/boilerplate`` directory::

    $ python3 -m pytest boilerplate_test.py

It also runs unchanged from the repository root, because the fixture directory
is resolved relative to ``__file__`` rather than to the current directory::

    $ python3 -m pytest hack/boilerplate/boilerplate_test.py
"""

import importlib
import os
import sys
import types

# Directory holding the pass/fail header fixtures. Resolved from __file__ so the
# test is independent of the caller's working directory (AAP §0.7.2 isolation).
FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test")

# The complete set of fixtures the scanner must report as badly-headed, sorted.
# Sort order is fail.go < fail.py < fail.ts < fail.tsx < fail_2026.go because
# "." (46) sorts before "_" (95) and "ts" is a prefix of "tsx". The "././"
# double prefix is produced by normalize_files(), which joins args.rootdir (".")
# onto each walked path ("./fail.go").
EXPECTED_FAILING_FILES = [
    "././fail.go",
    "././fail.py",
    "././fail.ts",
    "././fail.tsx",
    "././fail_2026.go",
]


def test_boilerplate(monkeypatch, capsys):
    """Locks the invariant that the Apache-2.0 header gate detects exactly the
    known-bad fixtures and no others, across .go, .py, .ts and .tsx.

    Both halves of the assertion matter: ``main()`` must still report success
    (it reports offenders on stdout rather than through its exit status), and
    the reported set must equal EXPECTED_FAILING_FILES exactly. An exact
    equality is deliberate - a subset, superset, membership or length check
    would let a silently undetected bad header, or a falsely accused good one,
    slip through.
    """
    # boilerplate.py calls parse_args() at module level, so it inherits the host
    # process's argv on import. Under `pytest -q` that aborts collection with
    # SystemExit(2): "unrecognized arguments: -q". Sanitise argv FIRST, then
    # (re)import so parse_args() re-runs against the clean argv, and only then
    # patch the parsed args.
    monkeypatch.setattr(sys, "argv", ["boilerplate.py"])
    monkeypatch.chdir(FIXTURE_DIR)

    if "boilerplate" in sys.modules:
        boilerplate = importlib.reload(sys.modules["boilerplate"])
    else:
        boilerplate = importlib.import_module("boilerplate")

    # Scan only the fixture directory, taking the reference headers from its
    # parent. These are the same four values the pre-pytest version supplied.
    monkeypatch.setattr(
        boilerplate,
        "args",
        types.SimpleNamespace(
            filenames=[],
            rootdir=".",
            boilerplate_dir="../",
            verbose=True,
        ),
    )

    ret = boilerplate.main()
    assert ret == 0

    # main() prints one offending path per line; split() normalises the
    # scanner's non-deterministic emission order and any trailing whitespace.
    output = sorted(capsys.readouterr().out.split())

    assert output == EXPECTED_FAILING_FILES
