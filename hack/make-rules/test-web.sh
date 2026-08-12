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

# Runs the React (Vitest) test tier under web/ in jsdom.
# Usage: hack/make-rules/test-web.sh [OPTIONS] [VITEST TARGETS]
#
# AAP §0.4.6 / §0.5.1 / §0.9.1.2 / §0.9.1.4, tech-spec §6.6.3.4
#
# INVARIANT LOCKED BY THIS FILE: the React tier always executes as a single
# non-watching `vitest run` against exactly the dependency set
# web/package-lock.json records, reports through the repository's EXISTING
# KUBE_JUNIT_REPORT_DIR contract as web.xml, and propagates the suite's verdict
# unaltered - neither a coverage percentage nor a report-writing step can change
# it.
#
# WHY THIS FILE EXISTS. `make test-web` (build/root/Makefile) dispatches here,
# and hack/jenkins/test-dockerized.sh runs that target after `make test-python`.
# CI is external Kubernetes test-infra (Prow) driving those same dockerized
# entry points, so extending this surface is what makes the new tier a real gate
# (AAP §0.4.6, §0.8.1.5). Nothing else registers it: there is no
# .github/workflows/ in this repository and none is created.
#
# THREE PROPERTIES ARE LOAD-BEARING AND MUST SURVIVE EVERY EDIT.
#
#   1. Machine-readable reporting. The EXISTING KUBE_JUNIT_REPORT_DIR variable
#      is reused - never renamed, never shadowed by a new spelling - and it
#      auto-matches CI's ARTIFACTS exactly as hack/make-rules/test.sh:78-82 and
#      hack/make-rules/verify.sh do. A new variable name would silently take
#      TestGrid, the go.k8s.io/triage clusterer and Spyglass dark while this
#      script still reported success.
#
#   2. Coverage is collected and reported but NEVER gated (AAP §0.7.1.3,
#      §0.9.3). See runTests: the thresholds web/vitest.config.ts declares are
#      neutralised on the command line, because Vitest exits non-zero on an
#      unmet threshold even when every test passed.
#
#   3. A single non-watching run. AAP §0.9.3 excludes watch modes from all
#      automated execution, so this script always passes `run` and exports
#      CI=true. The in-page runner mode, its screenshot and viewport matchers,
#      and any cross-engine matrix are out of scope (AAP §0.8.2; tech-spec
#      §6.6.1.3 records user-agent automation and cross-engine runs as not
#      applicable to this repository). The tier runs in jsdom.
#
# Vitest 4 removals honoured here by construction (AAP §0.2.2.2): the `basic`
# reporter no longer exists and fails at load with ERR_LOAD_URL /
# loadCustomReporterModule, so `default` is used - combined with `junit` for CI;
# the two coverage toggles that used to select files implicitly are gone, so
# web/vitest.config.ts carries an explicit include list and this script does not
# second-guess it; and the pool-sizing family - thread and fork minima and
# maxima, the pool-options bag and the two single-worker shorthands - is
# superseded by --maxWorkers, which is the only worker knob referenced below.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/../..
source "${KUBE_ROOT}/hack/lib/init.sh"
# init.sh sources util, logging, version, golang and etcd, but deliberately not
# node.sh (measured at hack/lib/init.sh:48-56), so the Node provisioner is
# sourced explicitly here - the order hack/make-rules/test-cmd.sh:32-35
# establishes for an extra library.
source "${KUBE_ROOT}/hack/lib/node.sh"

# The Go environment helper that hack/make-rules/test.sh:24 calls is
# deliberately NOT called here. That runner needs it because it runs `go test`;
# this tier runs Node and needs no Go toolchain, no GOPATH and no module cache.
# Calling it would make a Go-less image fail a tier that has nothing to do with
# Go.

# Node tooling must never prompt and must never open a watcher in automation
# (AAP §0.9.4.1, §0.9.3). hack/lib/node.sh:136 also exports this, and stating it
# again here is deliberate belt and braces: the guarantee then holds even if
# provisioning is short-circuited or that file is ever refactored. It is
# unconditional rather than ${CI:-true} on purpose - a stray CI=false in the
# environment would let Vitest start a watcher and wedge a gate that can never
# finish.
export CI=true

set -x

# Coverage collection, opt-in, mirroring KUBE_COVER at
# hack/make-rules/test.sh:65.
KUBE_WEB_COVER=${KUBE_WEB_COVER:-n} # set to 'y' to enable coverage collection
# The directory to save the coverage report to, if generating one. If unset, the
# reportsDirectory in web/vitest.config.ts (web/coverage/) is used unchanged -
# that name is load-bearing, because the repository-root .gitignore ignores it
# and web/tsconfig.json excludes it by exactly that name.
KUBE_WEB_COVER_REPORT_DIR=${KUBE_WEB_COVER_REPORT_DIR:-}
# Vitest --maxWorkers: a worker count or a percentage such as 50%. Empty means
# no --maxWorkers is passed at all, leaving Vitest's own default in place.
KUBE_WEB_MAX_WORKERS=${KUBE_WEB_MAX_WORKERS:-}
# Extra arguments for vitest, expanded with eval below so that embedded quoted
# strings survive, exactly as KUBE_TEST_ARGS is at hack/make-rules/test.sh:142.
KUBE_VITEST_ARGS=${KUBE_VITEST_ARGS:-}
# Create a junit-style XML test report in this directory if set.
KUBE_JUNIT_REPORT_DIR=${KUBE_JUNIT_REPORT_DIR:-}
# If KUBE_JUNIT_REPORT_DIR is unset, and ARTIFACTS is set, then have them match.
if [[ -z "${KUBE_JUNIT_REPORT_DIR:-}" && -n "${ARTIFACTS:-}" ]]; then
    export KUBE_JUNIT_REPORT_DIR="${ARTIFACTS}"
fi

set +x

# The ARTIFACTS auto-match above is not optional, and it is not duplicated
# defensively: hack/jenkins/test-dockerized.sh deliberately does NOT export
# KUBE_JUNIT_REPORT_DIR, because every runner is expected to auto-match it
# itself. Delete the block and CI reporting goes dark without a single error
# message.
#
# KUBE_WEB_COVER and KUBE_JUNIT_REPORT_DIR are also named in this target's help
# text in build/root/Makefile, so those two spellings are a published contract.

# kube::test::web::usage writes this runner's help to stderr. Nothing is
# modified.
#
# Every line below begins with a non-whitespace character on purpose:
# kube::log::usage_from_stdin reads with the default IFS
# (hack/lib/logging.sh:121-127), which strips leading whitespace, so hanging
# indentation would collapse. Column alignment WITHIN a line survives and is
# used instead.
kube::test::web::usage() {
  kube::log::usage_from_stdin <<EOF
usage: $0 [OPTIONS] [VITEST TARGETS]

Runs the React (Vitest) test tier from web/ under jsdom. With no TARGETS the
whole tier runs, resolved from the include pattern in web/vitest.config.ts.

OPTIONS
-h               print this help and exit
-c               collect V8 coverage; same as KUBE_WEB_COVER=y
-t <pattern>     only run tests whose name matches <pattern>
-w <workers>     Vitest --maxWorkers: a count, or a percentage such as 50%

TARGETS
Filename filters, passed to Vitest verbatim, for example:
src/components/RbacWildcardPanel.test.tsx
A target that exists relative to your current directory is made absolute first,
so web/src/... typed at the repository root works as well as src/... typed in
web/. Filters are substring matches against the spec paths, so a mistyped one is
reported as "No test files found" and FAILS the run rather than passing quietly.
Use -- to pass any other flag straight through, for example: -- --silent

ENVIRONMENT
KUBE_WEB_COVER             'y' collects V8 coverage; default n
KUBE_WEB_COVER_REPORT_DIR  where to write it; web/coverage/ if unset
KUBE_WEB_MAX_WORKERS       as -w
KUBE_VITEST_ARGS           extra vitest arguments, eval-expanded
KUBE_JUNIT_REPORT_DIR      write web.xml here; auto-matches ARTIFACTS
KUBE_VERBOSE               verbosity of the progress output
NODE_BIN, NPM_BIN          the node and npm to provision with
KUBE_WEB_DIR               the tier's root; web/ by default

Coverage is collected and reported but NEVER gated: the thresholds declared in
web/vitest.config.ts are advisory, so no percentage can fail this script.
Setting KUBE_JUNIT_REPORT_DIR also disables colour, because ANSI escapes corrupt
the JUnit XML.
This runner only ever performs a single non-watching run, in jsdom. For an
interactive session use the scripts in web/package.json by hand.

EXAMPLES
make test-web                                            # the usual entry point
hack/make-rules/test-web.sh                              # the whole tier
hack/make-rules/test-web.sh src/hooks/useControlStatus.test.ts
hack/make-rules/test-web.sh -t "renders the pass affordance"
hack/make-rules/test-web.sh -w 1                         # one worker
KUBE_WEB_COVER=y hack/make-rules/test-web.sh             # with coverage
KUBE_JUNIT_REPORT_DIR=/tmp/artifacts hack/make-rules/test-web.sh
EOF
}

# kube::test::web::is_workers succeeds when $1 is a value Vitest accepts for
# --maxWorkers: a positive integer, or a percentage of the available CPUs.
# Nothing is modified.
kube::test::web::is_workers() {
  [[ "${1}" =~ ^[0-9]+$ || "${1}" =~ ^[0-9]+%$ ]]
}

# -t is accepted here, rather than left to the caller as a pass-through flag,
# because getopts stops at the first non-option argument: without it,
# `test-web.sh -t renders` would be rejected as an unknown option before Vitest
# ever saw it. Everything else still reaches Vitest through -- or
# KUBE_VITEST_ARGS.
name_filter_args=()
while getopts "hct:w:" opt ; do
  case ${opt} in
    h)
      kube::test::web::usage
      exit 0
      ;;
    c)
      KUBE_WEB_COVER=y
      ;;
    t)
      # Last -t wins: Vitest takes a single name pattern, so accumulating them
      # would hand it two mutually exclusive filters.
      name_filter_args=("-t" "${OPTARG}")
      ;;
    w)
      KUBE_WEB_MAX_WORKERS="${OPTARG}"
      if ! kube::test::web::is_workers "${KUBE_WEB_MAX_WORKERS}"; then
        kube::log::usage "'$0': argument to -w must be a positive number or a percentage such as 50%"
        kube::test::web::usage
        exit 1
      fi
      ;;
    :)
      kube::log::usage "Option -${OPTARG} <value>"
      kube::test::web::usage
      exit 1
      ;;
    ?)
      kube::test::web::usage
      exit 1
      ;;
  esac
done
shift $((OPTIND - 1))

# The same validation for the environment spelling, so `make test-web
# KUBE_WEB_MAX_WORKERS=lots` fails with a sentence instead of a Vitest stack.
if [[ -n "${KUBE_WEB_MAX_WORKERS}" ]] && ! kube::test::web::is_workers "${KUBE_WEB_MAX_WORKERS}"; then
  kube::log::usage \
    "'$0': KUBE_WEB_MAX_WORKERS must be a positive number or a percentage such as 50%," \
    "got '${KUBE_WEB_MAX_WORKERS}'"
  kube::test::web::usage
  exit 1
fi

# Resolve KUBE_WEB_DIR, KUBE_NODE_PACKAGE_JSON and KUBE_NODE_PACKAGE_LOCK, and
# export KUBE_NODE_MODULES_BIN. This creates nothing, installs nothing and
# touches no network, so it is safe to call before the preconditions are checked
# - and the checks need those paths (hack/lib/node.sh:338-355 names this runner
# as one of its callers).
kube::node::dirs

# Use eval to preserve embedded quoted strings.
#
# KUBE_VITEST_ARGS contains arguments for vitest (like --silent or
# --coverage.reporter=text) and is passed before the targets, which is where
# Vitest's own CLI documents its options.
vitestargs=()
eval "vitestargs=(${KUBE_VITEST_ARGS:-})"

# kube::test::web::resolve_target echoes the Vitest target $1, rewritten to an
# absolute path when - and only when - that is needed for it to still mean the
# same thing after the working directory changes to web/. Nothing is modified.
#
# Vitest matches a positional argument as a substring of each spec's path, and
# MEASURED behaviour is that the repository-root spelling web/src/x.test.tsx
# matches nothing once web/ is the working directory (the run then fails with
# "No test files found"), whereas an absolute path and a bare substring both
# match. Resolution order:
#   1. an option, or already absolute -> unchanged;
#   2. exists from the caller's cwd   -> made absolute, so web/src/... typed at
#      the repository root keeps working;
#   3. anything else                  -> unchanged, so it stays a substring
#      filter and Vitest owns the diagnostic rather than this script guessing.
kube::test::web::resolve_target() {
  local target=${1:-}

  if [[ -z "${target}" || "${target}" == -* || "${target}" == /* ]]; then
    echo "${target}"
    return 0
  fi
  if [[ -e "${target}" ]]; then
    echo "$(cd "$(dirname "${target}")" && pwd -P)/$(basename "${target}")"
    return 0
  fi
  echo "${target}"
}

# Rewrite the remaining positional arguments in place, preserving their ORDER -
# unlike hack/make-rules/test.sh:154-162, which may reorder because `go test`
# requires its flags first. Vitest's parser accepts flags anywhere, and order
# matters here for the opposite reason: a name pattern must stay adjacent to the
# option that introduces it.
#
# The value of a name-filter option is never treated as a path, so
# `-- -t src` cannot be turned into an absolute path by an unlucky collision
# with a directory of that name.
targets=()
previous_arg=""
for arg; do
  if [[ "${previous_arg}" == "-t" || "${previous_arg}" == "--testNamePattern" ]]; then
    targets+=("${arg}")
  else
    targets+=("$(kube::test::web::resolve_target "${arg}")")
  fi
  previous_arg="${arg}"
done
set -- "${targets[@]+${targets[@]}}"

# kube::test::web::abs_dir creates the directory $1 and echoes its absolute,
# symlink-resolved path. On return the directory exists and an absolute path has
# been printed, or an actionable message has been written and the status is
# non-zero.
#
# Absolute is the whole point: runTests invokes Vitest with web/ as the working
# directory, so a RELATIVE report directory would silently deposit its output
# under web/ instead of where the caller asked. Resolving before the directory
# change is what stops that. mkdir -p first, mirroring
# hack/make-rules/test.sh:183, so that pwd -P has something to resolve.
kube::test::web::abs_dir() {
  local dir=${1:?a directory is required}

  if ! mkdir -p "${dir}"; then
    kube::log::usage "'$0': could not create the report directory '${dir}'"
    return 1
  fi
  (cd "${dir}" && pwd -P)
}

# kube::test::web::spec_count echoes the number of Vitest specs in the tier. On
# return a non-negative integer has been printed and nothing has been modified.
#
# The two -name patterns mirror the include pattern in web/vitest.config.ts,
# src/**/*.test.{ts,tsx}. find does the walking rather than a shell glob, because
# ** only recurses when globstar is enabled and this script deliberately changes
# no shell option. The -d test is deliberate too: find on a missing path exits
# non-zero and, under `set -o errexit -o pipefail`, would abort the script
# instead of reporting an empty tier. wc pads its output on some platforms, hence
# the tr.
kube::test::web::spec_count() {
  if [[ ! -d "${KUBE_WEB_DIR}/src" ]]; then
    echo 0
    return 0
  fi

  local count
  count=$(find "${KUBE_WEB_DIR}/src" -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' \) | wc -l | tr -d '[:space:]')
  echo "${count:-0}"
}

# kube::test::web::check_tier verifies that there is a React test tier to run. On
# return everything Vitest needs is present, or an actionable message naming the
# missing path has been written and the status is non-zero. Nothing is created,
# installed or downloaded.
#
# Shaped after checkEtcdOnPath() at hack/make-rules/test-integration.sh:109-116
# and called before any provisioning: the tier is populated file by file during
# the migration, so a missing piece must read as one clear sentence rather than
# as a `set -u` trace from somewhere deep inside npm.
kube::test::web::check_tier() {
  kube::log::status "Checking the React test tier in ${KUBE_WEB_DIR}"

  if [[ ! -d "${KUBE_WEB_DIR}" ]]; then
    kube::log::status "Cannot find the React test tree, cannot run the web tests."
    kube::log::usage "Expected a directory at '${KUBE_WEB_DIR}'." \
      "Set KUBE_WEB_DIR if the tier lives elsewhere."
    return 1
  fi

  if [[ ! -f "${KUBE_NODE_PACKAGE_JSON}" ]]; then
    kube::log::status "Cannot find the web manifest, cannot run the web tests."
    kube::log::usage "Expected '${KUBE_NODE_PACKAGE_JSON}', which pins this tier's dependency set." \
      "Restore it from version control, or set KUBE_WEB_DIR if the tier lives elsewhere."
    return 1
  fi

  if [[ ! -f "${KUBE_NODE_PACKAGE_LOCK}" ]]; then
    kube::log::status "Cannot find the web lockfile, cannot run the web tests."
    kube::log::usage "Expected '${KUBE_NODE_PACKAGE_LOCK}': provisioning uses 'npm ci', which installs" \
      "exactly what the lockfile records and cannot run without one." \
      "There is deliberately no fallback to the lockfile-rewriting alternative:" \
      "a test run must never change the file that makes this tier reproducible."
    return 1
  fi

  # Without this file Vitest silently falls back to web/vite.config.ts, losing
  # the jsdom environment, the setup file, the spec include pattern and the
  # coverage include list - so the suite would appear to run while asserting
  # nothing. A missing configuration is therefore fatal, not a warning.
  local config_found=""
  local candidate
  for candidate in vitest.config.ts vitest.config.mts vitest.config.js vitest.config.mjs; do
    if [[ -f "${KUBE_WEB_DIR}/${candidate}" ]]; then
      config_found="${candidate}"
      break
    fi
  done
  if [[ -z "${config_found}" ]]; then
    kube::log::status "Cannot find the Vitest configuration, cannot run the web tests."
    kube::log::usage "Expected '${KUBE_WEB_DIR}/vitest.config.ts', which supplies the jsdom environment," \
      "the setup file, the spec include pattern and the explicit coverage include list." \
      "Without it Vitest would fall back to vite.config.ts and run the specs under the wrong settings."
    return 1
  fi

  return 0
}

runTests() {
  # Report directories are resolved to absolute paths HERE, before the working
  # directory changes to web/, and a failure to create one is FATAL rather than
  # merely logged. Losing the JUnit report silently would take TestGrid, the
  # go.k8s.io/triage clusterer and Spyglass dark while the run still reported
  # success, which is precisely the failure mode the reporting contract exists to
  # prevent - so `|| return 1` is deliberate.
  #
  # The file name is fixed at web.xml by AAP §0.4.6 and §0.9.1.2 and is repeated
  # in this target's Makefile help text. --reporter=default is passed
  # unconditionally below and `junit` is ADDED to it, because a lone junit
  # reporter would leave the console silent; `basic` is never used, having been
  # removed in Vitest 4 where it now fails at load (AAP §0.2.2.2).
  local -a junit_args=()
  if [[ -n "${KUBE_JUNIT_REPORT_DIR}" ]]; then
    local junit_report_dir
    junit_report_dir=$(kube::test::web::abs_dir "${KUBE_JUNIT_REPORT_DIR}") || return 1
    junit_args+=(
      "--reporter=junit"
      "--outputFile.junit=${junit_report_dir}/web.xml"
    )

    # If KUBE_JUNIT_REPORT_DIR is set, disable colorized output. Colorized
    # output causes malformed XML in the JUNIT report - the same hazard
    # hack/verify-shellcheck.sh:87-92 documents for shellcheck. Vitest copies a
    # failing test's console output into the report, so an ANSI escape reaches
    # the XML unless colour is off at the source. Both variables are exported
    # because the toolchain honours either, and neither has a CLI equivalent
    # that Vitest's parser accepts.
    export NO_COLOR=1
    export FORCE_COLOR=0
  fi

  # Coverage is a SECONDARY, DERIVED signal and is NEVER a gate (AAP §0.7.1.3,
  # §0.9.3): no percentage may make this script exit non-zero.
  #
  # That takes an explicit act here, not merely the absence of one.
  # web/vitest.config.ts declares coverage thresholds, and MEASURED behaviour is
  # that Vitest exits 1 on an unmet threshold even when every test passed,
  # printing "ERROR: Coverage for lines (0%) does not meet global threshold
  # (80%)". Zeroing the four floors on the command line keeps them declared in
  # the configuration - where AAP §0.5.4 puts them, as the advisory record - while
  # making them incapable of gating, which is what AAP §0.9.3 requires. They are
  # advisory for a second reason too: Vitest 4 rewrote the V8 provider with
  # AST-aware remapping, so its line and branch numbers are not comparable with
  # earlier releases and any floor is read as re-baselined against it.
  #
  # The zeroing is UNCONDITIONAL, and it is appended LAST of all - after the
  # caller's own arguments. Both details are load-bearing, and both were settled
  # by experiment rather than assumption:
  #   * unconditional, because coverage can also be switched on through
  #     KUBE_VITEST_ARGS or a -- pass-through, and the guarantee has to hold on
  #     those paths too. It is safe when coverage is off - MEASURED: these four
  #     options alone neither enable collection nor raise an error;
  #   * last, because the bare boolean --coverage REPLACES the coverage object
  #     built from any --coverage.<key> argument that preceded it. MEASURED:
  #     `--coverage.thresholds.lines=0 ... --coverage` re-arms the configured
  #     floors and exits 1, while `--coverage ... --coverage.thresholds.lines=0`
  #     collects coverage and exits 0. Placing these last is therefore the only
  #     ordering under which no --coverage from any source can re-arm a floor.
  # The consequence is deliberate: a floor cannot be enforced THROUGH this
  # runner. Run vitest directly from web/ to enforce one on purpose.
  local -a threshold_args=(
    "--coverage.thresholds.lines=0"
    "--coverage.thresholds.functions=0"
    "--coverage.thresholds.branches=0"
    "--coverage.thresholds.statements=0"
  )

  # coverage.include is NOT passed. Vitest 4 removed the toggle that used to
  # select files implicitly, so the explicit include list in web/vitest.config.ts
  # is the single source of truth; overriding it from here would quietly change
  # which files the report covers. Only the report directory is overridable, and
  # only when a caller asks for it by name.
  local cover_msg="without code coverage"
  local -a cover_args=()
  if [[ ${KUBE_WEB_COVER} =~ ^[yY]$ ]]; then
    cover_msg="with code coverage"
    cover_args+=("--coverage")
    if [[ -n "${KUBE_WEB_COVER_REPORT_DIR}" ]]; then
      local cover_report_dir
      cover_report_dir=$(kube::test::web::abs_dir "${KUBE_WEB_COVER_REPORT_DIR}") || return 1
      kube::log::status "Saving coverage output in '${cover_report_dir}'"
      cover_args+=("--coverage.reportsDirectory=${cover_report_dir}")
    fi
  fi

  # --maxWorkers is the only worker knob Vitest 4 still has: it consolidated the
  # thread and fork maxima, deleted the minima and the pool-options bag, and
  # replaced the single-worker shorthands with `--maxWorkers=1` (AAP §0.2.2.2).
  # `isolate` is left exactly as web/vitest.config.ts sets it - a fresh
  # environment per spec file is, with the worker count, the substitute this
  # project accepts for Go's -race (AAP §0.4.1.2), so this runner never negates
  # it.
  local -a worker_args=()
  if [[ -n "${KUBE_WEB_MAX_WORKERS}" ]]; then
    worker_args+=("--maxWorkers=${KUBE_WEB_MAX_WORKERS}")
  fi

  # The tier is populated file by file during the migration, so an EMPTY tier is
  # reported loudly and treated as a pass, exactly as the Python runner treats
  # pytest's "no tests collected". Vitest exits 1 on an empty run otherwise, and
  # that would fail `make test-web` for a tier that has nothing to say yet.
  #
  # The exemption is withheld the moment the caller names a target: a mistyped
  # filter must still fail rather than be excused as an empty tier. That is the
  # difference between graceful degradation and a suite that can never fail.
  local -a no_tests_args=()
  local spec_count
  spec_count=$(kube::test::web::spec_count)
  if [[ "${spec_count}" -eq 0 ]]; then
    if [[ $# -eq 0 ]]; then
      kube::log::status \
        "WARNING: no Vitest specs found under ${KUBE_WEB_DIR}/src (migration in progress)" \
        "Expected files matching src/**/*.test.{ts,tsx}, the include pattern in ${KUBE_WEB_DIR}/vitest.config.ts."
      no_tests_args+=("--passWithNoTests")
    else
      kube::log::status \
        "WARNING: no Vitest specs exist under ${KUBE_WEB_DIR}/src, but targets were given" \
        "The run will report no test files found, which is a genuine failure rather than an empty tier."
    fi
  elif [[ ! -f "${KUBE_WEB_DIR}/src/setupTests.ts" ]]; then
    # web/vitest.config.ts declares setupFiles: ['./src/setupTests.ts'], and a
    # missing setup file makes every spec fail with a bare "Cannot find module"
    # instead of anything that names the cause. Say so plainly, then let Vitest
    # own the verdict.
    kube::log::status \
      "WARNING: ${KUBE_WEB_DIR}/src/setupTests.ts is missing" \
      "${KUBE_WEB_DIR}/vitest.config.ts declares it in setupFiles, so every spec will fail to load until it exists."
  fi

  # Provision the runtime and the locked dependency set: kube::node::setup_env
  # validates node and npm against their floors, runs `npm ci` - and never the
  # lockfile-rewriting alternative, so no test run can mutate
  # web/package-lock.json - keeps web/node_modules a symlink to a store outside
  # the working tree so the repository's tree-walking gates stay green, and puts
  # web/node_modules/.bin on PATH. It is stamp-guarded, so a warm tree costs
  # nothing, and it returns rather than exits - hence the guard, which turns a
  # provisioning failure into one more sentence of context instead of an errexit
  # stack trace.
  if ! kube::node::setup_env; then
    kube::log::status "Cannot provision the React test tier, cannot run the web tests."
    kube::log::usage "See the message above for the step that failed." \
      "'source hack/lib/init.sh; source hack/lib/node.sh; kube::node::install' provisions the tier on its own."
    return 1
  fi

  # Resolve the binary rather than trusting PATH order, which is why
  # hack/lib/node.sh exports KUBE_NODE_MODULES_BIN. `npx` is deliberately NOT
  # used: it would fetch a package from the network when the local copy is
  # missing, so a broken tree could silently run some other Vitest than the one
  # web/package-lock.json pins.
  local vitest_bin="${KUBE_NODE_MODULES_BIN}/vitest"
  if [[ ! -x "${vitest_bin}" ]]; then
    kube::log::status "Cannot find the pinned vitest executable, cannot run the web tests."
    kube::log::usage "Expected an executable at '${vitest_bin}'." \
      "Remove ${KUBE_WEB_DIR}/node_modules and re-run to reinstall the locked set from ${KUBE_NODE_PACKAGE_LOCK}."
    return 1
  fi

  # `run` is always present and is never omitted: it is what makes this a single
  # non-watching execution (AAP §0.9.3). The caller's arguments come after this
  # runner's own, so that they can override them - with the single deliberate
  # exception of the coverage floors, which are appended after everything for the
  # reason given above.
  local -a vitest_cmd=(
    "${vitest_bin}" run
    "--reporter=default"
    "${junit_args[@]:+${junit_args[@]}}"
    "${cover_args[@]:+${cover_args[@]}}"
    "${worker_args[@]:+${worker_args[@]}}"
    "${no_tests_args[@]:+${no_tests_args[@]}}"
    "${vitestargs[@]:+${vitestargs[@]}}"
    "${name_filter_args[@]:+${name_filter_args[@]}}"
    "$@"
    "${threshold_args[@]:+${threshold_args[@]}}"
  )

  kube::log::status "Running React tests ${cover_msg} in ${KUBE_WEB_DIR}"

  # Vitest resolves web/vitest.config.ts, and the setup file and include pattern
  # inside it, relative to its own root, so web/ MUST be the working directory.
  # kube::util::run-in restores the previous one afterwards, and kube::log::run
  # takes only a simple command because it is a subshell ending in exec
  # (hack/lib/logging.sh:174-181) - hence the pre-built array.
  #
  # `&& rc=$? || rc=$?` captures the status instead of letting errexit abort, so
  # the verdict is returned rather than thrown away. Nothing downstream may
  # rewrite it: hack/jenkins/test-dockerized.sh runs the make targets under
  # `set -o errexit`, and that propagation is what fails the CI job.
  local rc=0
  kube::util::run-in "${KUBE_WEB_DIR}" \
      kube::log::run "${vitest_cmd[@]}" \
    && rc=$? || rc=$?

  return "${rc}"
}

# No cleanup trap: this script starts no server, writes no temporary state and
# leaves no background process. Its only outputs are the report files the caller
# asked for, which must survive.
kube::test::web::check_tier

# KUBE_WEB_DIR is normalised only after check_tier has confirmed it exists.
# init.sh:29 already makes KUBE_ROOT absolute, so the default is absolute too;
# this covers a caller who overrode KUBE_WEB_DIR with a relative path, which
# would otherwise stop resolving the moment the working directory becomes web/.
# kube::node::dirs re-derives the manifest paths and re-exports
# KUBE_NODE_MODULES_BIN from the normalised value.
KUBE_WEB_DIR=$(cd "${KUBE_WEB_DIR}" && pwd -P)
kube::node::dirs

runTests "$@"

