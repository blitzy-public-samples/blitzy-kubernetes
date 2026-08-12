#!/usr/bin/env bash

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

# Runs the Python (pytest) test tier that ports the Go security-regression
# surface for controls V1 through V8.
# Usage: hack/make-rules/test-python.sh [OPTIONS] [PYTEST TARGETS]
#
# AAP §0.4.6 / §0.5.1 / §0.9.1.1 / §0.9.1.4, tech-spec §6.6.3.4
#
# INVARIANT LOCKED BY THIS FILE: the pytest tier always runs from its own
# pinned virtual environment, reports through the repository's EXISTING
# KUBE_JUNIT_REPORT_DIR contract, and propagates its verdict unaltered.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/../..
source "${KUBE_ROOT}/hack/lib/init.sh"
source "${KUBE_ROOT}/hack/lib/python.sh"

set -x

# Coverage collection, opt-in, mirroring KUBE_COVER at hack/make-rules/test.sh:65.
KUBE_PYTHON_COVER=${KUBE_PYTHON_COVER:-n} # set to 'y' to enable coverage collection
# The directory to save the coverage report to, if generating one. If unset, a
# semi-predictable temporary directory is used (hack/make-rules/test.sh:211-215).
KUBE_PYTHON_COVER_REPORT_DIR=${KUBE_PYTHON_COVER_REPORT_DIR:-}
# Marker expression handed to pytest's -m, e.g. "not integration". Empty means
# NO -m flag is passed at all, so no tier is ever silently deselected. The
# registered vocabulary is integration, shell, config, parity and slow
# (python/pyproject.toml). KUBE_PYTEST_MARKERS is the AAP §0.9.1.1 spelling and
# is honoured as an alias; see the naming note below.
KUBE_PYTHON_TEST_MARKERS=${KUBE_PYTHON_TEST_MARKERS:-${KUBE_PYTEST_MARKERS:-}}
# pytest-xdist worker count: "auto", "logical", or a number. "0" means run in a
# single process and pass no -n at all. KUBE_PYTEST_PARALLEL is the AAP §0.9.1.1
# spelling and is honoured as an alias.
KUBE_PYTHON_TEST_WORKERS=${KUBE_PYTHON_TEST_WORKERS:-${KUBE_PYTEST_PARALLEL:-0}}
# Extra arguments for pytest, expanded with eval below so that embedded quoted
# strings survive, exactly as KUBE_TEST_ARGS is at hack/make-rules/test.sh:142.
KUBE_PYTEST_ARGS=${KUBE_PYTEST_ARGS:-}
# Create a junit-style XML test report in this directory if set.
KUBE_JUNIT_REPORT_DIR=${KUBE_JUNIT_REPORT_DIR:-}
# If KUBE_JUNIT_REPORT_DIR is unset, and ARTIFACTS is set, then have them match.
if [[ -z "${KUBE_JUNIT_REPORT_DIR:-}" && -n "${ARTIFACTS:-}" ]]; then
    export KUBE_JUNIT_REPORT_DIR="${ARTIFACTS}"
fi

set +x

# TWO NAMING FAMILIES, ONE IMPLEMENTATION - deliberate, not accidental.
# python/pyproject.toml documents this runner as owning KUBE_PYTHON_COVER,
# KUBE_PYTHON_TEST_WORKERS and KUBE_PYTHON_TEST_MARKERS, and
# hack/make-rules/test-parity.sh reuses the same plumbing, so those spellings
# are a contract. AAP §0.9.1.1 names KUBE_PYTEST_MARKERS and
# KUBE_PYTEST_PARALLEL. Both are accepted, over one implementation, for the
# reason hack/lib/python.sh:68-75 gives for doing the same: dropping either
# family would break a caller. The KUBE_PYTHON_* spelling wins when both are
# set, because it is the one another file's documentation points at.

# In-cluster discovery hygiene: when this runs inside a Kubernetes pod, the
# injected KUBERNETES_SERVICE_* variables (plus the mounted service-account
# token) make client-go's rest.InClusterConfig() succeed, so a test-launched
# control-plane component talks to the HOST cluster and authenticates as
# system:serviceaccount:default:default instead of using the test server.
# Observed failure: `unable to load configmap based request-header-client-ca-file:
# configmaps "extension-apiserver-authentication" is forbidden`.
unset KUBERNETES_SERVICE_HOST KUBERNETES_SERVICE_PORT KUBERNETES_SERVICE_PORT_HTTPS
unset KUBERNETES_PORT KUBERNETES_PORT_443_TCP KUBERNETES_PORT_443_TCP_ADDR
unset KUBERNETES_PORT_443_TCP_PORT KUBERNETES_PORT_443_TCP_PROTO

# kube::test::python::usage writes this runner's help to stderr. Nothing is
# modified.
#
# Every line here begins with a non-whitespace character on purpose:
# kube::log::usage_from_stdin reads with the default IFS
# (hack/lib/logging.sh:121-127), which strips leading whitespace, so hanging
# indentation would collapse. Column alignment WITHIN a line survives, and is
# used instead.
kube::test::python::usage() {
  kube::log::usage_from_stdin <<EOF
usage: $0 [OPTIONS] [PYTEST TARGETS]

Runs the Python (pytest) test tier from python/. With no TARGETS the whole tier
runs, resolved from \`testpaths\` in python/pyproject.toml.

OPTIONS
-h               print this help and exit
-m <expression>  pytest marker expression, e.g. -m "not integration"
-n <workers>     pytest-xdist workers: a number, "auto" or "logical"

Registered markers are integration, shell, config, parity and slow. An empty
marker expression passes no -m at all, so no tier is ever silently deselected.
-n 0 is the default and runs in a single process, passing no -n at all.

TARGETS
Paths or pytest node-ids, passed through verbatim, for example:
tests/unit/shell/test_audit_policy.py
'tests/unit/shell/test_audit_policy.py::test_audit_level[secrets-request]'
Relative paths work both from the repository root (python/tests/...) and from
python/ itself (tests/...). A mistyped node-id is NOT an error - pytest reports
"no tests ran" - so copy ids from \`pytest --collect-only\` output.

ENVIRONMENT
KUBE_PYTHON_COVER             'y' collects coverage; default n
KUBE_PYTHON_COVER_REPORT_DIR  where to write it; a temp dir if unset
KUBE_PYTHON_TEST_MARKERS      as -m; alias KUBE_PYTEST_MARKERS
KUBE_PYTHON_TEST_WORKERS      as -n; alias KUBE_PYTEST_PARALLEL
KUBE_PYTEST_ARGS              extra pytest arguments, eval-expanded
KUBE_JUNIT_REPORT_DIR         write python.xml here; auto-matches ARTIFACTS
KUBE_VERBOSE                  verbosity of the progress output

Coverage is reported but NEVER gated: no percentage can fail this script.
Setting KUBE_JUNIT_REPORT_DIR also disables colour, because ANSI escapes
corrupt the JUnit XML.

EXAMPLES
make test-python                                        # the usual entry point
hack/make-rules/test-python.sh                          # the whole tier
hack/make-rules/test-python.sh -m "not integration"     # no etcd, no apiserver
hack/make-rules/test-python.sh -m integration           # needs etcd + apiserver
hack/make-rules/test-python.sh -n auto tests/unit       # parallel, one subtree
KUBE_PYTHON_COVER=y hack/make-rules/test-python.sh      # with coverage
EOF
}

# kube::test::python::is_workers succeeds when \$1 is a value pytest-xdist
# accepts for -n. Nothing is modified.
kube::test::python::is_workers() {
  [[ "${1}" =~ ^[0-9]+$ || "${1}" == "auto" || "${1}" == "logical" ]]
}

while getopts "hm:n:" opt ; do
  case ${opt} in
    h)
      kube::test::python::usage
      exit 0
      ;;
    m)
      KUBE_PYTHON_TEST_MARKERS="${OPTARG}"
      ;;
    n)
      KUBE_PYTHON_TEST_WORKERS="${OPTARG}"
      if ! kube::test::python::is_workers "${KUBE_PYTHON_TEST_WORKERS}"; then
        kube::log::usage "'$0': argument to -n must be a number, 'auto' or 'logical'"
        kube::test::python::usage
        exit 1
      fi
      ;;
    :)
      kube::log::usage "Option -${OPTARG} <value>"
      kube::test::python::usage
      exit 1
      ;;
    ?)
      kube::test::python::usage
      exit 1
      ;;
  esac
done
shift $((OPTIND - 1))

# Resolve the KUBE_PYTHON_* paths (KUBE_PYTHON_DIR, KUBE_PYTHON_VENV,
# KUBE_PYTHON_VENV_DIR, KUBE_PYTHON_REQUIREMENTS) and export
# KUBE_PYTHON_VENV_BIN. Creates nothing and touches no network, so it is safe to
# call before the preconditions are checked - and the checks need the paths.
kube::python::dirs

# Use eval to preserve embedded quoted strings.
#
# KUBE_PYTEST_ARGS contains arguments for pytest (like -x or -k 'expr') and is
# passed before the targets, which is where pytest expects its options.
pytestargs=()
eval "pytestargs=(${KUBE_PYTEST_ARGS:-})"

# kube::test::python::abs_dir creates the directory $1 and echoes its absolute,
# symlink-resolved path. On return the directory exists and an absolute path has
# been printed, or an actionable message has been written and the status is
# non-zero.
#
# Absolute is the whole point: runTests invokes pytest with python/ as the
# working directory, so a RELATIVE report directory would silently deposit its
# output under python/ instead of where the caller asked. Resolving before the
# directory change is what stops that.
kube::test::python::abs_dir() {
  local dir=${1:?a directory is required}

  if ! mkdir -p "${dir}"; then
    kube::log::usage "'$0': could not create the report directory '${dir}'"
    return 1
  fi
  (cd "${dir}" && pwd -P)
}

# kube::test::python::resolve_target echoes the pytest target $1, rewritten to an
# absolute path when - and only when - that is needed for it to still mean the
# same thing after the working directory changes to python/. Nothing is
# modified.
#
# A target may carry a "::node::id[param]" suffix, which is not part of the path
# and must survive untouched. Resolution order:
#   1. already absolute            -> unchanged;
#   2. exists from the caller's cwd -> made absolute (so `python/tests/...` typed
#      at the repository root keeps working);
#   3. exists from python/          -> unchanged, because pytest will resolve it
#      itself after the directory change (so `tests/...`, the form pytest prints
#      in its own node-ids, keeps working);
#   4. anything else                -> unchanged, so pytest owns the diagnostic
#      rather than this script guessing.
kube::test::python::resolve_target() {
  local target=${1:-}
  local path=${target%%::*}
  local nodeid=${target#"${path}"}

  if [[ -z "${path}" || "${path}" == /* ]]; then
    echo "${target}"
    return 0
  fi
  if [[ -e "${path}" ]]; then
    echo "$(cd "$(dirname "${path}")" && pwd -P)/$(basename "${path}")${nodeid}"
    return 0
  fi
  echo "${target}"
}

# Filter out arguments that start with "-" and move them to pytestargs, so that
# `test-python.sh -- -x tests/unit` and `test-python.sh tests/unit -x` both
# behave, mirroring hack/make-rules/test.sh:154-161.
testcases=()
for arg; do
  if [[ "${arg}" == -* ]]; then
    pytestargs+=("${arg}")
  else
    testcases+=("$(kube::test::python::resolve_target "${arg}")")
  fi
done

# kube::test::python::cover_report_dir echoes the directory the coverage report
# belongs in, without creating it. On return a non-empty path has been printed.
# An unset KUBE_PYTHON_COVER_REPORT_DIR yields a semi-predictable temporary
# directory, exactly as hack/make-rules/test.sh:211-215 does for the Go tier.
kube::test::python::cover_report_dir() {
  if [[ -n "${KUBE_PYTHON_COVER_REPORT_DIR}" ]]; then
    echo "${KUBE_PYTHON_COVER_REPORT_DIR}"
    return 0
  fi
  echo "/tmp/k8s_python_coverage/$(kube::util::sortable_date)"
}

# kube::test::python::check_tier verifies that there is a Python test tier to
# run. On return everything needed is present, or an actionable message naming
# the missing path has been written and the status is non-zero.
#
# Shaped after checkEtcdOnPath() at hack/make-rules/test-integration.sh:109-116,
# and called before any provisioning: the tier is populated file by file during
# the migration, so a missing piece must read as one clear sentence rather than
# as a `set -u` trace from somewhere deep in the provisioner.
kube::test::python::check_tier() {
  kube::log::status "Checking the Python test tier in ${KUBE_PYTHON_DIR}"

  if [[ ! -d "${KUBE_PYTHON_DIR}" ]]; then
    kube::log::status "Cannot find the Python test tree, cannot run the Python tests."
    kube::log::usage "Expected a directory at '${KUBE_PYTHON_DIR}'." \
      "Set KUBE_PYTHON_DIR if the tree lives elsewhere."
    return 1
  fi

  if [[ ! -f "${KUBE_PYTHON_DIR}/pyproject.toml" ]]; then
    kube::log::status "Cannot find the pytest configuration, cannot run the Python tests."
    kube::log::usage "Expected '${KUBE_PYTHON_DIR}/pyproject.toml', which supplies" \
      "testpaths, the marker vocabulary and the JUnit family."
    return 1
  fi

  if [[ ! -f "${KUBE_PYTHON_REQUIREMENTS}" ]]; then
    kube::log::status "Cannot find the pinned test manifest, cannot run the Python tests."
    kube::log::usage "Expected '${KUBE_PYTHON_REQUIREMENTS}'." \
      "Set KUBE_PYTHON_REQUIREMENTS if the manifest lives elsewhere."
    return 1
  fi

  return 0
}

runTests() {
  # Report directories are resolved to absolute paths HERE, before the working
  # directory changes to python/, and a failure to create one is FATAL rather
  # than merely logged. Losing the JUnit report silently would take TestGrid, the
  # go.k8s.io/triage clusterer and Spyglass dark while the run still reported
  # success, which is precisely the failure mode the reporting contract exists to
  # prevent - so `|| return 1` on each is deliberate.
  #
  # The JUnit file name is fixed at python.xml by AAP §0.4.6 and §0.9.1.1, and
  # the EXISTING KUBE_JUNIT_REPORT_DIR variable is reused rather than a new one
  # invented, so CI keeps reading one directory for every tier.
  local -a junit_args=()
  if [[ -n "${KUBE_JUNIT_REPORT_DIR}" ]]; then
    local junit_report_dir
    junit_report_dir=$(kube::test::python::abs_dir "${KUBE_JUNIT_REPORT_DIR}") || return 1
    junit_args+=("--junitxml=${junit_report_dir}/python.xml")
  fi

  # Coverage is a SECONDARY, DERIVED signal and is NEVER a gate (AAP §0.7.1,
  # §0.9.3): no minimum-percentage threshold is passed to pytest-cov, and
  # python/pyproject.toml sets no `fail_under`, so no percentage can make this
  # script exit non-zero. Adding such a threshold here would turn an advisory
  # figure into a gate, and is the one change this block must never grow.
  # --cov=tests matches [tool.coverage.run] source = ["tests"] in that file.
  #
  # The subprocess shell-boundary tier (python/tests/unit/shell/) is measured but
  # excluded from the advisory floors, because the logic under test is Bash: the
  # Python line coverage of a subprocess.run() wrapper is not a meaningful
  # signal. That exclusion lives in python/pyproject.toml, not here.
  local -a cover_args=()
  if [[ ${KUBE_PYTHON_COVER} =~ ^[yY]$ ]]; then
    local cover_report_dir
    cover_report_dir=$(kube::test::python::abs_dir "$(kube::test::python::cover_report_dir)") \
      || return 1
    kube::log::status "Saving coverage output in '${cover_report_dir}'"
    cover_args+=(
      "--cov=tests"
      "--cov-report=term-missing"
      "--cov-report=xml:${cover_report_dir}/coverage.xml"
    )
  fi

  local -a color_args=()
  if [[ -n "${KUBE_JUNIT_REPORT_DIR}" ]]; then
    # If KUBE_JUNIT_REPORT_DIR is set, disable colorized output.
    # Colorized output causes malformed XML in the JUNIT report
    # (hack/verify-shellcheck.sh:87-92 documents the same hazard). pytest
    # captures test output into the report via junit_logging = "system-out", so
    # an ANSI escape reaches the XML unless colour is off at the source.
    color_args+=("--color=no")
    export NO_COLOR=1
  fi

  local -a marker_args=()
  if [[ -n "${KUBE_PYTHON_TEST_MARKERS}" ]]; then
    marker_args+=("-m" "${KUBE_PYTHON_TEST_MARKERS}")
  fi

  # pytest-xdist. 0 means "no -n at all" rather than "-n 0", so a serial run is
  # a plain pytest run. pytest-randomly stays enabled either way: with no -race
  # and no goleak analogue in Python, order randomisation and worker isolation
  # ARE the substitutes (AAP §0.4.1.2), so this script never disables them.
  # pytest-timeout, configured in python/pyproject.toml, turns a hang into a
  # failure - which is why no outer timeout(1) wrapper is used here: it would
  # kill the run before that failure could be reported.
  local -a worker_args=()
  if [[ "${KUBE_PYTHON_TEST_WORKERS}" != "0" ]]; then
    worker_args+=("-n" "${KUBE_PYTHON_TEST_WORKERS}")
  fi

  # Provision the pinned virtual environment. kube::python::install creates it
  # when absent, installs python/requirements-test.txt, and is stamp-guarded so
  # a warm environment costs nothing. It deliberately leaves ${PATH} alone -
  # hack/lib/python.sh:710-714 names this file as one of its callers - so pytest
  # is invoked through ${KUBE_PYTHON_VENV_BIN} below and can never resolve to a
  # system install.
  kube::python::install

  local -a pytest_cmd=(
    "${KUBE_PYTHON_VENV_BIN}/python" -m pytest
    "${color_args[@]:+${color_args[@]}}"
    "${marker_args[@]:+${marker_args[@]}}"
    "${worker_args[@]:+${worker_args[@]}}"
    "${cover_args[@]:+${cover_args[@]}}"
    "${junit_args[@]:+${junit_args[@]}}"
    "${pytestargs[@]:+${pytestargs[@]}}"
    "${testcases[@]:+${testcases[@]}}"
  )

  kube::log::status "Running Python tests in ${KUBE_PYTHON_DIR}"

  # python/pyproject.toml sets testpaths = ["tests"] and pythonpath = ["."],
  # both resolved against pytest's rootdir, so python/ MUST be the working
  # directory. kube::util::run-in restores the previous one afterwards, and
  # kube::log::run takes only a simple command because it is a subshell ending
  # in exec (hack/lib/logging.sh:174-181) - hence the pre-built array.
  local rc=0
  kube::util::run-in "${KUBE_PYTHON_DIR}" \
      kube::log::run "${pytest_cmd[@]}" \
    && rc=$? || rc=$?

  # pytest exit code 5 is EXIT_NOTESTSCOLLECTED - "no tests ran" - and not a
  # failure. The tier is populated file by file during the migration, so an
  # empty tier is reported loudly and treated as a pass; python/pyproject.toml
  # relies on this behaviour by name (it downgrades the matching config-time
  # warning specifically so pytest reaches this clean exit 5 instead of dying
  # with a traceback). Every other non-zero code is propagated untouched, which
  # is how a failing tier fails the CI job: hack/jenkins/test-dockerized.sh runs
  # the make targets under `set -o errexit`.
  if [[ ${rc} -eq 5 ]]; then
    kube::log::status \
      "WARNING: no Python tests collected under ${KUBE_PYTHON_DIR} (migration in progress)"
    rc=0
  fi

  return "${rc}"
}

# No cleanup trap: this script starts no server and creates no temporary state.
# Its only outputs are the report files the caller asked for, which must survive.
kube::test::python::check_tier

runTests
