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

# WHETHER THE CALLER IS AN AUTOMATED RUN, captured BEFORE any library is sourced.
# hack/lib/node.sh exports CI=true unconditionally so that Vitest can never
# start a watcher, so ${CI} inside this script says nothing
# about how it was invoked and cannot be used to tell an interactive developer
# from CI. The inherited value is therefore recorded here, once, while it still
# means that. BUILD_NUMBER and PROW_JOB_ID are consulted too: pytest 9 itself
# treats CI or BUILD_NUMBER, set to a NON-EMPTY value, as "in CI" (AAP §0.2.2.1),
# and PROW_JOB_ID is what this repository's external test-infra sets.
KUBE_WEB_CALLER_CI="${CI:-}"
if [[ -z "${KUBE_WEB_CALLER_CI}" ]]; then
  KUBE_WEB_CALLER_CI="${BUILD_NUMBER:-}"
fi
if [[ -z "${KUBE_WEB_CALLER_CI}" ]]; then
  KUBE_WEB_CALLER_CI="${PROW_JOB_ID:-}"
fi
readonly KUBE_WEB_CALLER_CI


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
# Extra arguments for vitest. Tokenised below by kube::test::web::split_args,
# which honours embedded quoted strings WITHOUT evaluating them; see the note
# above that function for why `eval` is deliberately not used here even though
# hack/make-rules/test.sh:143 spells the equivalent that way.
KUBE_VITEST_ARGS=${KUBE_VITEST_ARGS:-}
# Whether a run that finds NO specs may be reported as a pass. Default 'n': an
# empty tier is a test-gate failure, because "the suite passed" and "the suite
# was deleted" must never look the same to CI. Set to 'y' ONLY as a deliberate,
# temporary local migration exemption; it is refused when ${CI} is set and it
# never applies once a target is named.
KUBE_WEB_ALLOW_NO_TESTS=${KUBE_WEB_ALLOW_NO_TESTS:-n}
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
KUBE_VITEST_ARGS           extra vitest arguments, quote-aware split and
                           never shell-evaluated
KUBE_WEB_ALLOW_NO_TESTS    'y' excuses an EMPTY tier locally; default n, and
                           refused when CI is set or a target is given
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

# The terminator line kube::test::web::split_args writes after the tokens, and
# the reason its VALUE is irrelevant: the caller drops the last line positionally
# rather than matching on it, so a token that happens to equal this string is
# still carried correctly. It is checked only to prove the stream is complete.
readonly KUBE_ARGS_SENTINEL='--- end of arguments ---'

# kube::test::web::split_args splits $1 into one argument per line on stdout,
# honouring single quotes, double quotes and backslash escapes, and EVALUATING
# NOTHING. On return the tokens have been printed, or an actionable message has
# been written and the status is non-zero because a quote was left unterminated.
#
# WHY NOT `eval`. hack/make-rules/test.sh:143 spells this as
# `eval "testargs=(${KUBE_TEST_ARGS:-})"`, and that is precisely the shape this
# function exists to avoid: `eval` hands the value of an ENVIRONMENT VARIABLE to
# the shell parser, so `KUBE_VITEST_ARGS='$(rm -rf ~)'` executes, `>file`
# redirects and `;` chains - none of which is an argument to Vitest. This
# tokeniser reproduces the ONE property that spelling was there for (an embedded
# quoted string such as -t 'renders the pass affordance' arrives as a single
# argument) and gives up every other shell behaviour on purpose: command
# substitution, parameter expansion, globbing, redirection and word chaining are
# inert here and their characters reach Vitest as typed.
kube::test::web::split_args() {
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
      "ERROR: KUBE_VITEST_ARGS ends inside an unterminated ${quote} quote, so its arguments" \
      "cannot be split unambiguously. Nothing was run and nothing was guessed." \
      "Close the quote, for example: KUBE_VITEST_ARGS=\"-t 'renders the pass affordance'\""
    return 1
  fi
  if ${started}; then
    tokens+=("${token}")
  fi

  # THE CARRIER: a COUNT line, then one token per line, then a fixed sentinel.
  # Both framing lines are load-bearing, because the caller reads this through a
  # command substitution, which strips TRAILING newlines:
  #   * the sentinel keeps a trailing EMPTY token from vanishing, so
  #     KUBE_VITEST_ARGS="-k ''" still arrives as two arguments rather than a lone -k;
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

# KUBE_VITEST_ARGS contains arguments for vitest (like --silent or
# --coverage.reporter=text) and is passed before the targets, which is where
# Vitest's own CLI documents its options.
#
# Collected through a command substitution rather than a process substitution so
# that a rejected value FAILS THE RUN: `mapfile < <(...)` cannot see the child's
# exit status, and silently dropping a malformed argument list would leave a
# caller believing their filter was applied.
vitestargs=()
if [[ -n "${KUBE_VITEST_ARGS:-}" ]]; then
  vitest_arg_stream=$(kube::test::web::split_args "${KUBE_VITEST_ARGS}") || exit 1
  mapfile -t vitest_arg_lines <<<"${vitest_arg_stream}"
  vitest_arg_want=${vitest_arg_lines[0]}
  vitest_arg_last=$(( ${#vitest_arg_lines[@]} - 1 ))
  if [[ "${vitest_arg_lines[vitest_arg_last]}" != "${KUBE_ARGS_SENTINEL}" ]]; then
    kube::log::usage \
      "ERROR: the KUBE_VITEST_ARGS argument stream was truncated before its terminator." \
      "Nothing was run and nothing was guessed. This is a bug in $0."
    exit 1
  fi
  for (( vitest_arg_i = 1; vitest_arg_i < vitest_arg_last; vitest_arg_i++ )); do
    vitestargs+=("${vitest_arg_lines[vitest_arg_i]}")
  done
  if [[ "${#vitestargs[@]}" -ne "${vitest_arg_want}" ]]; then
    kube::log::usage \
      "ERROR: KUBE_VITEST_ARGS split into ${#vitestargs[@]} arguments but ${vitest_arg_want} were expected," \
      "which happens when one of them contains a newline. Nothing was run and nothing was guessed." \
      "Remove the newline: Vitest arguments are single-line values."
    exit 1
  fi
  unset vitest_arg_stream vitest_arg_lines vitest_arg_want vitest_arg_last vitest_arg_i
fi

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

# kube::test::web::flag_name echoes the bare name of the Vitest option $1:
# --watch=true -> watch, -w -> w, --browser.enabled -> browser. Both the `=value`
# form and the leading dashes are stripped, and a dotted sub-option is reduced to
# its namespace, because a check keyed on the literal spelling has that many
# trivial bypasses.
kube::test::web::flag_name() {
  local stripped=${1#-}
  stripped=${stripped#-}
  stripped=${stripped%%=*}
  echo "${stripped%%.*}"
}

# kube::test::web::takes_value returns 0 when the Vitest option named $1 carries a
# value, and non-zero otherwise. Nothing is modified.
#
# WHY THIS EXISTS. Vitest accepts BOTH `--opt=value` and `--opt value`, and the two
# spellings mean the same thing to its parser. A policy that reads a value only from
# `${arg#*=}` therefore inspects one of them and waves the other through, which is not
# a narrower check but no check at all: `--testTimeout=0` was refused while
# `--testTimeout 0` removed the same bound silently. Every option whose VALUE decides
# whether it is acceptable has to be listed here so both spellings reach the same
# policy.
#
# `-t` and `--testNamePattern` are listed too, and they are the reason this is a
# separate predicate rather than a case arm. Their values are never policed -- a name
# filter can only narrow the run -- but they must be CONSUMED, or a pattern that
# happens to look like an option is inspected as one and a legitimate
# `-t --watch-behaviour` is refused for a flag nobody passed.
kube::test::web::takes_value() {
  case "$1" in
    watch|w|testTimeout|hookTimeout|teardownTimeout|reporter|maxWorkers|t|testNamePattern)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# kube::test::web::is_option_like returns 0 when the token $1 reads as an option rather
# than as a value. Nothing is modified.
#
# A leading `-` is the signal, with ONE deliberate exception: a negative number is a
# value, not an option. Without the exception `--testTimeout -1` would leave its value
# unconsumed and unexamined -- and -1 disables the timeout in Vitest exactly as 0 does,
# so that is the one bypass this predicate exists to close. A bare `-` is treated as a
# value because it is not an option either.
kube::test::web::is_option_like() {
  case "$1" in
    -[0-9]*|-.[0-9]*)
      return 1 ;;
    -?*)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# kube::test::web::reject_forbidden_args refuses any caller-supplied Vitest option
# that would let this gate SUCCEED WITHOUT RUNNING THE SPECS, wait for input
# forever, or remove a bound the tier depends on. On return either every argument
# is permitted, or an actionable message has been written and the status is
# non-zero.
#
# WHY, AND WHY THE `run` SUBCOMMAND IS NOT ENOUGH. This runner always passes
# `run`, which is what makes the invocation non-watching (AAP §0.9.3) - but Vitest
# honours an explicit `--watch` after it, so `run --watch` watches. A watching gate
# in CI is a job that consumes its whole wall-clock allowance in silence and
# reports nothing, which is the single worst outcome available here.
#
# THE OTHER CLASSES:
#   * SUCCEEDING WITHOUT SPECS. `--passWithNoTests` makes "every spec was deleted"
#     indistinguishable from "every spec passed". This runner takes deliberate care
#     over that verdict - kube::test::web::spec_count, the empty-tier exemption
#     gated on KUBE_WEB_ALLOW_NO_TESTS and refused in CI - and a caller-supplied
#     flag would bypass every bit of it.
#   * REMOVING THE PER-TEST BOUND. `--testTimeout 0` and `--hookTimeout 0` - in either
#     spelling, and for zero or any negative value - mean NO timeout in Vitest, so a
#     hung test or a hung `beforeAll` waits forever. Those bounds (10000 ms each in
#     web/vitest.config.ts) are the React tier's analogue of pytest-timeout, and the
#     1800-second outer ceiling is a poor substitute: it turns a wedged test from a
#     ten-second failure into half an hour of silence. `--teardownTimeout` is refused
#     on the same terms.
#   * OUT-OF-SCOPE RUNNERS. `--browser`, `--browser.enabled` and `--standalone`
#     switch to Browser Mode or a standalone server. AAP §0.8.2 puts browser
#     automation, cross-browser testing and visual regression outside this project
#     outright; §0.4.1.1 fixes the tier as jsdom. A browser run here would need a
#     provider package that is deliberately not installed, so it fails obscurely
#     rather than clearly.
#   * A REPORTER THAT NO LONGER EXISTS. `basic` was REMOVED in Vitest 4 (AAP
#     §0.2.2.2, §0.9.1.2) and fails at load with ERR_LOAD_URL /
#     loadCustomReporterModule - a startup crash that reads like a configuration
#     error rather than a bad flag. Named here so the diagnostic is the real one.
#
# WHAT IS DELIBERATELY STILL ALLOWED. `-t`/`--testNamePattern` and a positional
# path filter narrow the run, but Vitest exits 1 when a filter matches no spec, and
# this runner treats that as the genuine failure it is - so a mistyped filter fails
# rather than passing quietly. `--bail` can only make the gate stricter.
#
# BOTH SPELLINGS ARE POLICED, and the loop below is indexed rather than `for arg in`
# for exactly that reason. Vitest accepts `--opt=value` and `--opt value`
# interchangeably, and this policy used to read a value only from `${arg#*=}` - so
# every value-dependent rule inspected one spelling and waved the other through.
# `--testTimeout 0`, `--hookTimeout 0` and `--reporter basic` all passed a gate that
# refused `--testTimeout=0`, `--hookTimeout=0` and `--reporter=basic`. That is not a
# narrower check, it is an absent one: the first two removed the 10-second per-test and
# per-hook bounds and left only the 1800-second outer ceiling, so a hung test burned
# half an hour before anything noticed, and the third reached the removed reporter's
# opaque startup crash by the one route the runner had promised to name clearly.
# kube::test::web::takes_value now normalises the two forms to one value before any rule
# reads it, and the value token is CONSUMED so it cannot then be re-inspected as an
# option in its own right.
kube::test::web::reject_forbidden_args() {
  local -a args=("$@")
  local -i index=0
  local -i count=${#args[@]}
  local arg name reason value spelling

  while (( index < count )); do
    arg=${args[index]}
    name=$(kube::test::web::flag_name "${arg}")
    reason=""

    # ONE NORMALISATION, THEN THE RULES. `value` is the option's value however it was
    # spelled, or the empty string when it genuinely has none; `spelling` is what a
    # diagnostic quotes back, so a refusal names what the caller actually typed rather
    # than a reconstruction of it.
    value=""
    spelling=${arg}
    if kube::test::web::takes_value "${name}"; then
      if [[ "${arg}" == *=* ]]; then
        value=${arg#*=}
      elif (( index + 1 < count )) && ! kube::test::web::is_option_like "${args[index + 1]}"; then
        value=${args[index + 1]}
        spelling="${arg} ${value}"
        # Consumed: the value is this option's, not an argument of its own.
        index+=1
      fi
    fi

    case "${name}" in
      watch|w)
        # `--watch=false` is the explicit OFF form and is harmless; only a watching
        # value is refused, so a caller may be redundantly explicit. A BARE `--watch`
        # is a watching value, which is why the default below is "true" rather than
        # the empty string.
        if [[ -z "${value}" ]]; then
          value="true"
        fi
        if [[ "${value}" != "false" && "${value}" != "0" ]]; then
          reason="it makes Vitest watch for file changes and never return, so in CI it consumes the whole wall-clock allowance in silence"
        fi
        ;;
      ui)
        reason="it opens the interactive Vitest UI, which never returns and cannot report a verdict to a Makefile" ;;
      standalone)
        reason="it starts Vitest as a standalone server that waits for work instead of running the suite" ;;
      browser)
        reason="browser automation, cross-browser testing and visual regression are outside this project (AAP §0.8.2) and this tier is fixed to jsdom (AAP §0.4.1.1); the provider package is deliberately not installed, so a browser run fails obscurely rather than clearly" ;;
      passWithNoTests)
        reason="it makes 'every spec was deleted' indistinguishable from 'every spec passed', bypassing the empty-tier handling this runner exists to provide (use KUBE_WEB_ALLOW_NO_TESTS=y locally, which is refused in CI)" ;;
      testTimeout|hookTimeout|teardownTimeout)
        # ZERO AND EVERY NEGATIVE MEAN "NO TIMEOUT" in Vitest, so both are refused, and
        # the value is read from the normalisation above rather than from `=` alone.
        # teardownTimeout is here for the same reason as the other two: a teardown that
        # never returns wedges the run just as thoroughly as a test that never returns.
        if [[ "${value}" =~ ^-?[0-9]+$ ]] && (( value <= 0 )); then
          reason="a ${name} of ${value} means NO timeout in Vitest, so a hung test, hook or teardown waits forever; that bound is this tier's analogue of pytest-timeout"
        fi
        ;;
      reporter)
        if [[ "${value}" == "basic" ]]; then
          reason="the 'basic' reporter was REMOVED in Vitest 4 (AAP §0.2.2.2) and fails at load with ERR_LOAD_URL / loadCustomReporterModule, which reads like a configuration error rather than a bad flag; use 'default'"
        fi
        ;;
    esac

    if [[ -n "${reason}" ]]; then
      kube::log::usage \
        "ERROR: refusing the Vitest argument '${spelling}': ${reason}." \
        "This gate exists to prove the React tier RAN and PASSED, so an argument that can" \
        "produce a zero exit status - or no exit at all - without that being true is rejected" \
        "before Vitest starts. Both spellings are checked: '--option=value' and" \
        "'--option value' mean the same thing to Vitest and are refused alike." \
        "Nothing was run. Remove the argument, or narrow the run with a" \
        "path filter or -t, both of which fail when they match nothing."
      return 1
    fi

    index+=1
  done
  return 0
}

# Validate BOTH sources of caller arguments together - KUBE_VITEST_ARGS and the
# positional ones - so a forbidden flag cannot be smuggled in through whichever
# channel was checked less carefully.
if [[ ${#vitestargs[@]} -gt 0 ]]; then
  kube::test::web::reject_forbidden_args "${vitestargs[@]}" || exit 1
fi
if [[ $# -gt 0 ]]; then
  kube::test::web::reject_forbidden_args "$@" || exit 1
fi

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

  # AN EMPTY TIER IS A FAILURE, AND THAT IS THE POINT. Vitest exits 1 when it
  # finds no spec files, and that verdict is deliberately left standing:
  # --passWithNoTests would make "every spec was deleted" indistinguishable from
  # "every spec passed", so `make test-web` would stay green over a suite that no
  # longer exists. Protecting against exactly that loss is why this runner exists
  # (the Python runner treats pytest's exit 5 the same way).
  #
  # The migration exemption is explicit, narrow and refused in CI: it requires
  # KUBE_WEB_ALLOW_NO_TESTS=y, no target, and ${CI} unset - the same three
  # conditions the Python runner applies, so the two tiers cannot drift.
  local -a no_tests_args=()
  local spec_count
  spec_count=$(kube::test::web::spec_count)
  if [[ "${spec_count}" -eq 0 ]]; then
    if [[ $# -gt 0 ]]; then
      kube::log::status \
        "WARNING: no Vitest specs exist under ${KUBE_WEB_DIR}/src, but targets were given" \
        "The run will report no test files found, which is a genuine failure rather than an empty tier."
    elif [[ -n "${KUBE_VITEST_ARGS:-}" ]]; then
      kube::log::usage \
        "ERROR: no Vitest specs exist under ${KUBE_WEB_DIR}/src, and KUBE_VITEST_ARGS was set" \
        "(${KUBE_VITEST_ARGS}), so this run made a deliberate selection that can match nothing." \
        "That is the same class of mistake as a mistyped target, and the empty-tier exemption is" \
        "deliberately withheld from it."
      return 1
    elif [[ ${KUBE_WEB_ALLOW_NO_TESTS} =~ ^[yY]$ ]] && [[ -z "${KUBE_WEB_CALLER_CI}" ]]; then
      kube::log::status \
        "WARNING: no Vitest specs found under ${KUBE_WEB_DIR}/src, and" \
        "KUBE_WEB_ALLOW_NO_TESTS=${KUBE_WEB_ALLOW_NO_TESTS} is excusing it (migration in progress)." \
        "Expected files matching src/**/*.test.{ts,tsx}, the include pattern in ${KUBE_WEB_DIR}/vitest.config.ts." \
        "This exemption is local-only: it is ignored when a target is given, and refused when the caller's" \
        "\${CI}, \${BUILD_NUMBER} or \${PROW_JOB_ID} is set."
      no_tests_args+=("--passWithNoTests")
    else
      kube::log::usage \
        "ERROR: no Vitest specs exist under ${KUBE_WEB_DIR}/src, so this gate has nothing to run and FAILS." \
        "A run that collects nothing cannot tell a passing suite from a deleted or renamed one." \
        "Expected files matching src/**/*.test.{ts,tsx}, the include pattern in ${KUBE_WEB_DIR}/vitest.config.ts." \
        "While the tier is still being populated file by file, a LOCAL run may pass" \
        "KUBE_WEB_ALLOW_NO_TESTS=y to accept an empty tier; CI never accepts one."
      return 1
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
  # THE OUTER CEILING, a SECOND bound rather than a replacement for Vitest's own
  # testTimeout/hookTimeout (10000 ms each, web/vitest.config.ts). The two catch
  # different things:
  #
  #   * testTimeout bounds ONE TEST and hookTimeout ONE HOOK, and each reports the
  #     hang as a FAILURE naming what hung - the more useful diagnostic, which is
  #     why it must always fire first.
  #   * This ceiling bounds THE WHOLE INVOCATION, for the hangs those structurally
  #     cannot see: a wedge while Vite transforms or resolves the module graph,
  #     before any test starts; a worker that never reports back; an MSW server or
  #     a jsdom timer keeping the event loop alive after the last test finished; and
  #     Vitest failing to enforce its own bound.
  #
  # Sized generously and floored at half an hour, so an ordinary slow run has long
  # since reported its per-test failure. Refused if set to anything that is not a
  # positive integer, because "0" means NO ceiling in timeout(1) and that is the one
  # value a caller must not be able to smuggle in.
  local ceiling=${KUBE_WEB_TEST_CEILING_SECONDS:-1800}
  if [[ ! "${ceiling}" =~ ^[1-9][0-9]*$ ]]; then
    kube::log::usage \
      "ERROR: KUBE_WEB_TEST_CEILING_SECONDS='${ceiling}' is not a positive integer." \
      "0 or empty would mean NO outer ceiling at all, which is exactly what this bound exists" \
      "to prevent. Nothing was run. Pass a whole number of seconds."
    return 1
  fi

  local -a ceiling_cmd=()
  if command -v timeout >/dev/null 2>&1; then
    ceiling_cmd=(timeout --signal=TERM --kill-after=30s "${ceiling}s")
  else
    kube::log::status \
      "WARNING: timeout(1) was not found, so this run has NO outer ceiling." \
      "A wedge during module transformation, or a worker that never reports back, would hang" \
      "this gate rather than failing it. Install coreutils."
  fi

  # Wall-clock start, so that "the ceiling fired" is decided by ELAPSED TIME and not
  # by an exit code alone. MEASURED REASON: timeout(1) is not one program. GNU
  # coreutils returns 124 on timeout; the uutils Rust reimplementation shipped as
  # coreutils-from-uutils on Ubuntu 25.10 - which is what /usr/bin/timeout is here -
  # returns 125 whenever --kill-after is given. 125 in GNU means "timeout itself
  # could not run the command", so accepting it unconditionally would misreport a
  # genuine setup failure as a hang. Requiring the elapsed time to have reached the
  # ceiling removes the ambiguity without a per-implementation special case, and
  # keeps this runner's behaviour identical to the Python one's.
  local ceiling_started_at=${SECONDS}

  local -a vitest_cmd=(
    "${ceiling_cmd[@]:+${ceiling_cmd[@]}}"
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

  # DID THE CEILING FIRE? Two conditions, both required: a status timeout(1) uses
  # for a termination - 124 (GNU), 125 (uutils with --kill-after) or 137
  # (128+SIGKILL) - AND an elapsed time that actually reached the ceiling. The
  # elapsed check is what makes this correct on both implementations and what keeps
  # a genuine "timeout could not exec the command" from being reported as a hang.
  #
  # The message is the diagnostic that survives: this function returns ${rc}, but
  # hack/lib/logging.sh:46 installs a repository-wide `trap kube::log::errexit ERR`
  # whose handler exits 1, so every make-rule reports 1 to its caller regardless of
  # the code it returned. That is the repository's convention and is not changed
  # here - which is exactly why the reason must be in the log rather than encoded in
  # the status.
  local elapsed=$(( SECONDS - ceiling_started_at ))
  if [[ ${#ceiling_cmd[@]} -gt 0 ]] \
      && { [[ "${rc}" -eq 124 ]] || [[ "${rc}" -eq 125 ]] || [[ "${rc}" -eq 137 ]]; } \
      && [[ "${elapsed}" -ge "${ceiling}" ]]; then
    kube::log::usage \
      "ERROR: the React tier exceeded its outer ceiling of ${ceiling}s (ran for ${elapsed}s)" \
      "and was terminated by timeout(1), which exited ${rc}." \
      "Vitest's testTimeout and hookTimeout bound an individual test and hook and should have" \
      "failed first, so reaching this bound means the wedge is somewhere they cannot see: Vite" \
      "transforming or resolving the module graph before any test ran, a worker that never" \
      "reported back, or an MSW server or jsdom timer keeping the event loop alive after the" \
      "last test finished." \
      "Re-run with --maxWorkers=1 --isolate=false to locate it." \
      "Raise KUBE_WEB_TEST_CEILING_SECONDS only once you are satisfied the run is merely slow."
    return "${rc}"
  fi

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
