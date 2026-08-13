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

COLLECTED AS PART OF THE PYTHON TIER. ``python/pyproject.toml`` lists this file
as its second ``testpaths`` entry, so ``make test-python`` - and a bare ``pytest``
run from ``python/`` - execute it alongside ``python/tests/**``. That entry is
load-bearing rather than cosmetic: this module holds the ONLY exact-equality
assertion over the scanner's expected offender list, and while it sat outside
``testpaths`` nothing ran it, so a scanner or fixture regression could not fail
anything. In particular the ripple AAP §0.5.5 records - that adding
``hack/boilerplate/test/fail.ts`` and ``fail.tsx`` changes
:data:`EXPECTED_FAILING_FILES` - was unenforced. Its verdict is also MEASURED into
the parity baseline by ``python/tests/parity/tools/generate_baseline.py``, which
runs this file and reads the outcome from real JUnit XML instead of assuming it.

It still runs standalone, from its own directory::

    $ python3 -m pytest boilerplate_test.py

and unchanged from the repository root, because the fixture directory is resolved
relative to ``__file__`` rather than to the current directory::

    $ python3 -m pytest hack/boilerplate/boilerplate_test.py
"""

import importlib.util
import io
import os
import sys
import types

# Directory holding the pass/fail header fixtures. Resolved from __file__ so the
# test is independent of the caller's working directory (AAP §0.7.2 isolation).
FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test")

# The scanner under test, resolved the same way, so this module always exercises
# the SHIPPED hack/boilerplate/boilerplate.py and never a copy of it.
CHECKER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "boilerplate.py")

# The identity the scanner is executed under. Deliberately NOT "boilerplate":
# see load_checker_anonymously() for why the real name is left alone.
ANONYMOUS_MODULE_NAME = "boilerplate_test_isolated_checker"

# The name the production helper occupies when something imports it normally.
# This test asserts it is left exactly as found.
PRODUCTION_MODULE_NAME = "boilerplate"

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


def load_checker_anonymously():
    """Execute the real boilerplate.py as a module nothing else can reach.

    Locks the invariant that running this test changes no process-global state.
    Two properties, and the reason for each:

    * THE IMPORT SYSTEM IS NOT TOUCHED. spec_from_file_location plus
      module_from_spec plus exec_module executes the file without registering
      anything in sys.modules, so a caller that already imported the production
      helper keeps its object, and a caller that has not still does not have one
      afterwards. The previous importlib.import_module / importlib.reload pair
      did the opposite: it left "boilerplate" registered, and on a second run it
      re-executed the module IN PLACE, so any other holder of that object
      silently observed a different args and a different verbose_out. That makes
      the outcome depend on import order, which is the one thing a gate test
      must never do.
    * THE MODULE IS FRESH. Executing the file gives a module whose module-scope
      argparse call has just run against whatever argv the caller set, which is
      what the reload was reaching for - obtained here without the shared-state
      cost.

    Returns:
        A freshly executed module object, unregistered and reachable only
        through the returned reference.
    """
    spec = importlib.util.spec_from_file_location(ANONYMOUS_MODULE_NAME, CHECKER_PATH)
    # Two assertions rather than one conjunction, so a failure says WHICH half
    # importlib declined to build.
    assert spec is not None, f"importlib could not build a module spec for {CHECKER_PATH}"
    assert spec.loader is not None, (
        f"the module spec for {CHECKER_PATH} carries no loader, so it cannot be executed"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def close_streams_opened_by(module):
    """Close every stream ``module`` bound at import time; report which ones.

    Locks the invariant that this test leaks no file descriptor. boilerplate.py
    once read::

        verbose_out = sys.stderr if args.verbose else open("/dev/null", "w")

    so a non-verbose import opened a handle at MODULE SCOPE and nothing ever
    closed it; patching ``args.verbose`` afterwards could not redirect it either,
    because ``verbose_out`` was already bound, so the handle stayed open for the
    life of the interpreter, once per load. The scanner now binds a
    ``_DiscardingWriter`` on that branch, which owns no descriptor, so the sweep
    finds nothing to close on a non-verbose load - see the assertion at the end of
    the case, which pins exactly that.

    The sweep is kept, and kept GENERIC rather than a hard-coded ``verbose_out``
    close, so that a real stream added to the scanner later is cleaned up and
    reported without this test needing to learn its name.

    The interpreter's own streams are excluded by IDENTITY. That exclusion matters
    for the verbose load, where ``verbose_out`` is ``sys.stderr`` ITSELF and closing
    it would take stderr away from the whole process rather than from this test.

    Args:
        module: The loaded scanner.

    Returns:
        The sorted attribute names whose streams this call closed.
    """
    interpreter_streams = [
        stream
        for stream in (
            sys.stdout,
            sys.stderr,
            sys.stdin,
            sys.__stdout__,
            sys.__stderr__,
            sys.__stdin__,
        )
        if stream is not None
    ]

    closed = []
    for name in dir(module):
        value = getattr(module, name, None)
        if not isinstance(value, io.IOBase) or value.closed:
            continue
        if any(value is stream for stream in interpreter_streams):
            continue
        value.close()
        closed.append(name)
    return sorted(closed)


def test_boilerplate(monkeypatch, capsys):
    """Locks the invariant that the Apache-2.0 header gate detects exactly the
    known-bad fixtures and no others, across .go, .py, .ts and .tsx.

    Both halves of the assertion matter: ``main()`` must still report success
    (it reports offenders on stdout rather than through its exit status), and
    the reported set must equal EXPECTED_FAILING_FILES exactly. An exact
    equality is deliberate - a subset, superset, membership or length check
    would let a silently undetected bad header, or a falsely accused good one,
    slip through.

    It also locks the isolation invariant the migration owes: loading the
    scanner leaves sys.modules exactly as it was found and leaks no file
    descriptor. Those post-conditions are asserted here rather than in a test of
    their own because this file's single case is a pinned row of the parity
    baseline (``hack/boilerplate`` / ``test_boilerplate``, one verdict), and a
    second test function would make that manifest under-describe the file.
    """
    # boilerplate.py calls parse_args() at module level, so it inherits the host
    # process's argv on import. Under `pytest -q` that aborts collection with
    # SystemExit(2): "unrecognized arguments: -q". Sanitise argv FIRST, then
    # load so parse_args() runs against the clean argv, and only then patch the
    # parsed args.
    monkeypatch.setattr(sys, "argv", ["boilerplate.py"])
    monkeypatch.chdir(FIXTURE_DIR)

    # A stand-in for "somebody already imported the production helper", which is
    # the case that used to be destroyed. If the loader registered the real name
    # it would clobber this object, so the identity check at the end is a direct
    # test of that and not a restatement of the loader's implementation.
    planted = types.SimpleNamespace(marker="pre-existing sys.modules entry")
    monkeypatch.setitem(sys.modules, PRODUCTION_MODULE_NAME, planted)

    # Snapshotted and restored explicitly, so the guarantee holds even if a
    # future edit to the loader starts registering something. monkeypatch would
    # restore the planted entry on its own; this covers the real caller, who
    # planted nothing and whose sys.modules must come back untouched anyway.
    absent = object()
    preexisting = sys.modules.get(PRODUCTION_MODULE_NAME, absent)

    boilerplate = load_checker_anonymously()
    try:
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

        # Read before the teardown below mutates anything, so what is asserted
        # afterwards is the state the LOAD left rather than the state the
        # cleanup produced.
        registered_names = {
            PRODUCTION_MODULE_NAME: sys.modules.get(PRODUCTION_MODULE_NAME, absent),
            ANONYMOUS_MODULE_NAME: sys.modules.get(ANONYMOUS_MODULE_NAME, absent),
        }
    finally:
        # In a finally so a failed assertion above still cleans up: a leaked
        # descriptor or a clobbered sys.modules entry would otherwise outlive
        # this test and be observed by whatever runs next.
        closed_streams = close_streams_opened_by(boilerplate)
        if preexisting is absent:
            sys.modules.pop(PRODUCTION_MODULE_NAME, None)
        else:
            sys.modules[PRODUCTION_MODULE_NAME] = preexisting

    # The pre-existing entry is the SAME OBJECT, not merely an equal one: a
    # re-executed module compares equal to nothing in particular, so identity is
    # the only check that can tell "untouched" from "replaced".
    assert registered_names[PRODUCTION_MODULE_NAME] is planted

    # And the scanner was never published under any name, so no other module can
    # have reached the copy this test executed.
    assert registered_names[ANONYMOUS_MODULE_NAME] is absent

    # NOTHING TO CLOSE, AND THAT IS THE POINT NOW. boilerplate.py used to bind
    # `verbose_out` to `open("/dev/null", "w")` on a non-verbose load, leaking one
    # descriptor per import with nothing ever closing it; it now binds a
    # `_DiscardingWriter`, which owns no descriptor at all. So the invariant this
    # asserts is unchanged - this test leaks no file descriptor - while the way the
    # scanner satisfies it is stronger: the leak was removed at its source rather
    # than swept up afterwards. The sweep itself is kept because it is generic, so a
    # real stream added to the scanner later is still cleaned up and would appear
    # here, turning this equality red rather than leaking silently.
    assert closed_streams == []
    assert not isinstance(boilerplate.verbose_out, io.IOBase)
