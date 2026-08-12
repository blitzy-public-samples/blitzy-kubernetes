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

# WHETHER THE CALLER IS AN AUTOMATED RUN, captured BEFORE any library is sourced.
# a sourced library may export CI for its own tooling (hack/lib/node.sh does,
# so that Vitest can never start a watcher), so ${CI} inside this script says nothing
# about how it was invoked and cannot be used to tell an interactive developer
# from CI. The inherited value is therefore recorded here, once, while it still
# means that. BUILD_NUMBER and PROW_JOB_ID are consulted too: pytest 9 itself
# treats CI or BUILD_NUMBER, set to a NON-EMPTY value, as "in CI" (AAP §0.2.2.1),
# and PROW_JOB_ID is what this repository's external test-infra sets.
KUBE_PYTHON_CALLER_CI="${CI:-}"
if [[ -z "${KUBE_PYTHON_CALLER_CI}" ]]; then
  KUBE_PYTHON_CALLER_CI="${BUILD_NUMBER:-}"
fi
if [[ -z "${KUBE_PYTHON_CALLER_CI}" ]]; then
  KUBE_PYTHON_CALLER_CI="${PROW_JOB_ID:-}"
fi
readonly KUBE_PYTHON_CALLER_CI


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
# Extra arguments for pytest. Tokenised below by kube::test::python::split_args,
# which honours embedded quoted strings WITHOUT evaluating them; see the note
# above that function for why `eval` is deliberately not used here even though
# hack/make-rules/test.sh:143 spells the equivalent that way.
KUBE_PYTEST_ARGS=${KUBE_PYTEST_ARGS:-}
# Whether a run that collects NO tests may be reported as a pass. Default 'n':
# an empty tier is a test-gate failure, because "the suite was deleted" and "the
# suite passed" must never look the same to CI (see runTests). Set to 'y' ONLY
# as a deliberate, temporary local migration exemption; it is refused outright
# when ${CI} is set, and it never applies once a target is named.
KUBE_PYTHON_ALLOW_NO_TESTS=${KUBE_PYTHON_ALLOW_NO_TESTS:-n}
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
python/ itself (tests/...). A mistyped node-id FAILS this script: pytest reports
"no tests ran" (exit 5) and zero collection is treated as a test-gate failure,
so copy ids from \`pytest --collect-only\` output.

ENVIRONMENT
KUBE_PYTHON_COVER             'y' collects coverage; default n
KUBE_PYTHON_COVER_REPORT_DIR  where to write it; a temp dir if unset
KUBE_PYTHON_TEST_MARKERS      as -m; alias KUBE_PYTEST_MARKERS
KUBE_PYTHON_TEST_WORKERS      as -n; alias KUBE_PYTEST_PARALLEL
KUBE_PYTEST_ARGS              extra pytest arguments, quote-aware split and
                              never shell-evaluated
KUBE_PYTHON_ALLOW_NO_TESTS    'y' excuses an EMPTY tier locally; default n, and
                              refused when CI is set or a target/-m is given
KUBE_JUNIT_REPORT_DIR         write python.xml here; auto-matches ARTIFACTS
KUBE_VERBOSE                  verbosity of the progress output

Coverage is reported but NEVER gated: no percentage can fail this script.
Collecting NO tests IS a failure, so a deleted or mis-targeted suite can never
be reported as a pass.
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

# The terminator line kube::test::python::split_args writes after the tokens, and
# the reason its VALUE is irrelevant: the caller drops the last line positionally
# rather than matching on it, so a token that happens to equal this string is
# still carried correctly. It is checked only to prove the stream is complete.
readonly KUBE_ARGS_SENTINEL='--- end of arguments ---'

# kube::test::python::split_args splits $1 into one argument per line on stdout,
# honouring single quotes, double quotes and backslash escapes, and EVALUATING
# NOTHING. On return the tokens have been printed, or an actionable message has
# been written and the status is non-zero because a quote was left unterminated.
#
# WHY NOT `eval`. hack/make-rules/test.sh:143 spells this as
# `eval "testargs=(${KUBE_TEST_ARGS:-})"`, and that is precisely the shape this
# function exists to avoid: `eval` hands the value of an ENVIRONMENT VARIABLE to
# the shell parser, so `KUBE_PYTEST_ARGS='$(rm -rf ~)'` executes, `>file`
# redirects and `;` chains - none of which is an argument to pytest. This
# tokeniser reproduces the ONE property that spelling was there for (an embedded
# quoted string such as -k 'expr with spaces' arrives as a single argument) and
# gives up every other shell behaviour on purpose. Command substitution,
# parameter expansion, globbing, redirection and word chaining are all inert
# here: their characters are literal text and reach pytest as typed.
#
# NUL is impossible in an environment variable, so a newline-delimited stream is
# an unambiguous carrier; mapfile below reads it back exactly.
kube::test::python::split_args() {
  local text=${1:-}
  local -a tokens=()
  local token=""
  local started=false
  local quote=""
  local index char

  for (( index = 0; index < ${#text}; index++ )); do
    char=${text:index:1}
    if [[ -n "${quote}" ]]; then
      # Inside quotes: only the matching quote closes, and only a double-quoted
      # backslash escapes, exactly as bash treats them.
      if [[ "${char}" == "${quote}" ]]; then
        quote=""
      elif [[ "${char}" == $'\\' && "${quote}" == '"' && $((index + 1)) -lt ${#text} ]]; then
        (( index += 1 ))
        token+=${text:index:1}
      else
        token+=${char}
      fi
      continue
    fi
    case "${char}" in
      "'" | '"')
        quote=${char}
        started=true
        ;;
      $'\\')
        if [[ $((index + 1)) -lt ${#text} ]]; then
          (( index += 1 ))
          token+=${text:index:1}
          started=true
        fi
        ;;
      ' ' | $'\t' | $'\n' | $'\r')
        if ${started}; then
          tokens+=("${token}")
          token=""
          started=false
        fi
        ;;
      *)
        token+=${char}
        started=true
        ;;
    esac
  done

  if [[ -n "${quote}" ]]; then
    kube::log::usage \
      "ERROR: KUBE_PYTEST_ARGS ends inside an unterminated ${quote} quote, so its arguments" \
      "cannot be split unambiguously. Nothing was run and nothing was guessed." \
      "Close the quote, for example: KUBE_PYTEST_ARGS=\"-k 'expr with spaces'\""
    return 1
  fi
  if ${started}; then
    tokens+=("${token}")
  fi

  # THE CARRIER: a COUNT line, then one token per line, then a fixed sentinel.
  # Both framing lines are load-bearing, because the caller reads this through a
  # command substitution, which strips TRAILING newlines:
  #   * the sentinel keeps a trailing EMPTY token from vanishing, so
  #     KUBE_PYTEST_ARGS="-k ''" still arrives as two arguments rather than a lone -k;
  #   * the count detects a token containing a newline, the one case in which a
  #     line-per-token carrier would otherwise be ambiguous.
  local element
  printf '%s\n' "${#tokens[@]}"
  for element in ${tokens[@]+"${tokens[@]}"}; do
    printf '%s\n' "${element}"
  done
  printf '%s\n' "${KUBE_ARGS_SENTINEL}"
  return 0
}

# KUBE_PYTEST_ARGS contains arguments for pytest (like -x or -k 'expr') and is
# passed before the targets, which is where pytest expects its options.
#
# The tokens are collected through a command substitution rather than a process
# substitution so that a rejected value FAILS THE RUN: `mapfile < <(...)` cannot
# see the child's exit status, and silently dropping a malformed argument list
# would leave a caller believing their -k filter was applied.
pytestargs=()
if [[ -n "${KUBE_PYTEST_ARGS:-}" ]]; then
  pytest_arg_stream=$(kube::test::python::split_args "${KUBE_PYTEST_ARGS}") || exit 1
  mapfile -t pytest_arg_lines <<<"${pytest_arg_stream}"
  pytest_arg_want=${pytest_arg_lines[0]}
  pytest_arg_last=$(( ${#pytest_arg_lines[@]} - 1 ))
  if [[ "${pytest_arg_lines[pytest_arg_last]}" != "${KUBE_ARGS_SENTINEL}" ]]; then
    kube::log::usage \
      "ERROR: the KUBE_PYTEST_ARGS argument stream was truncated before its terminator." \
      "Nothing was run and nothing was guessed. This is a bug in $0."
    exit 1
  fi
  for (( pytest_arg_i = 1; pytest_arg_i < pytest_arg_last; pytest_arg_i++ )); do
    pytestargs+=("${pytest_arg_lines[pytest_arg_i]}")
  done
  if [[ "${#pytestargs[@]}" -ne "${pytest_arg_want}" ]]; then
    kube::log::usage \
      "ERROR: KUBE_PYTEST_ARGS split into ${#pytestargs[@]} arguments but ${pytest_arg_want} were expected," \
      "which happens when one of them contains a newline. Nothing was run and nothing was guessed." \
      "Remove the newline: pytest arguments are single-line values."
    exit 1
  fi
  unset pytest_arg_stream pytest_arg_lines pytest_arg_want pytest_arg_last pytest_arg_i
fi

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

  # pytest exit code 5 is EXIT_NOTESTSCOLLECTED - "no tests ran".
  #
  # IT IS A FAILURE HERE, AND THAT IS THE POINT. A gate that reports success
  # when it collected nothing cannot tell "the suite passed" from "the suite was
  # deleted, renamed, mis-targeted or excluded by a marker", so deleting the
  # whole tier would keep `make test-python` green - the no-test-loss property
  # this runner exists to protect (AAP §0.4.5's parity contract asserts
  # completeness against the baseline manifest for the same reason). Zero
  # collection therefore propagates, and it ALWAYS propagates when the caller
  # named a target or a marker: a mistyped node id must fail rather than be
  # excused as an empty tier.
  #
  # The migration exemption is explicit, narrow and refused in CI. It requires
  # KUBE_PYTHON_ALLOW_NO_TESTS=y, no target, no marker expression, and ${CI}
  # unset - pytest 9 itself treats CI as set only when non-empty (AAP §0.2.2.1),
  # and the same rule is applied here so the two agree.
  #
  # Every other non-zero code is propagated untouched, which is how a failing
  # tier fails the CI job: hack/jenkins/test-dockerized.sh runs the make targets
  # under `set -o errexit`.
  if [[ ${rc} -eq 5 ]]; then
    local exemption_available=false
    if [[ ${KUBE_PYTHON_ALLOW_NO_TESTS} =~ ^[yY]$ ]] &&
      [[ ${#testcases[@]} -eq 0 ]] &&
      [[ -z "${KUBE_PYTHON_TEST_MARKERS}" ]] &&
      [[ -z "${KUBE_PYTEST_ARGS:-}" ]] &&
      [[ -z "${KUBE_PYTHON_CALLER_CI}" ]]; then
      exemption_available=true
    fi

    if ${exemption_available}; then
      kube::log::status \
        "WARNING: no Python tests were collected under ${KUBE_PYTHON_DIR}, and" \
        "KUBE_PYTHON_ALLOW_NO_TESTS=${KUBE_PYTHON_ALLOW_NO_TESTS} is excusing it (migration in progress)." \
        "This exemption is local-only: it is ignored when a target or -m is given, and refused when the caller's" \
        "\${CI}, \${BUILD_NUMBER} or \${PROW_JOB_ID} is set."
      rc=0
    else
      kube::log::usage \
        "ERROR: pytest collected NO tests under ${KUBE_PYTHON_DIR} (exit 5), which this gate treats as a failure." \
        "A run that collects nothing cannot tell a passing suite from a deleted, renamed or mis-targeted one."
      if [[ ${#testcases[@]} -gt 0 ]]; then
        kube::log::usage \
          "Targets were given (${testcases[*]}), so check them for a typo:" \
          "'${KUBE_PYTHON_VENV_BIN}/python -m pytest --collect-only' from ${KUBE_PYTHON_DIR} lists the node ids verbatim."
      elif [[ -n "${KUBE_PYTHON_TEST_MARKERS}" ]]; then
        kube::log::usage \
          "The marker expression -m '${KUBE_PYTHON_TEST_MARKERS}' selected nothing." \
          "The registered vocabulary is integration, shell, config, parity and slow (python/pyproject.toml)."
      elif [[ -n "${KUBE_PYTEST_ARGS:-}" ]]; then
        kube::log::usage \
          "KUBE_PYTEST_ARGS was set (${KUBE_PYTEST_ARGS}), so this run made a deliberate selection that matched nothing." \
          "A -k expression or a --deselect that selects no test is the same class of mistake as a mistyped target," \
          "and the empty-tier exemption is deliberately withheld from it."
      else
        kube::log::usage \
          "The tier under ${KUBE_PYTHON_DIR}/tests has no collectable tests at all." \
          "While it is still being populated file by file, a LOCAL run may pass" \
          "KUBE_PYTHON_ALLOW_NO_TESTS=y to accept an empty tier; CI never accepts one."
      fi
    fi
  fi

  return "${rc}"
}

# No cleanup trap: this script starts no server and creates no temporary state.
# Its only outputs are the report files the caller asked for, which must survive.
kube::test::python::check_tier

runTests
