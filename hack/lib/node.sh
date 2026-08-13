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

# A set of helpers for provisioning Node.js and npm dependencies for web tests
#
# AAP §0.5.1 (the hack/lib/node.sh row: "Node and npm provisioning plus npm
# ci") / §0.8.1.5 (in scope) / §0.3.3 and §0.9.4.1 (the Node v22.23.2 and npm
# 11.18.0 runtimes this tier was verified against) / §0.3.4.3 and §0.6.1.3
# (this script is the alternative to a pinned build/dependencies.yaml artifact:
# the target runtime is provisioned here rather than pinned as a container
# image, so no zeitgeist entry is required and
# hack/verify-external-dependencies-version.sh stays unaffected) /
# tech-spec §6.6.3.4 (the documentation convention this file follows).
#
# INVARIANT LOCKED BY THIS FILE: the React (Vitest) test tier always runs
# against exactly the dependency set web/package-lock.json records, installed
# with `npm ci` and never with `npm install`, so no test run can mutate the
# lockfile, and provisioning converges on repeat invocation instead of
# accumulating.
#
# Four properties make that claim hold rather than merely state it:
#   * THE INSTALLED TREE IS ASSERTED, not assumed. A stamp only records that some
#     run once installed from a lockfile with this hash, so the fast path also
#     reconciles every locked package and every root pin against what is on disk
#     (kube::node::internal::tree_matches_lock) and reinstalls on any mismatch.
#   * THE SELECTED RUNTIME IS THE ONE THAT RUNS. npm and every launcher in
#     web/node_modules/.bin begin `#!/usr/bin/env node`, so ${NODE_BIN} is put
#     first on ${PATH} once validated, and kube::node::exec gives a caller the same
#     guarantee for a single command.
#   * NOTHING UNOWNED IS DELETED, AND NOTHING IS DELETED BEFORE ITS REPLACEMENT IS
#     IN PLACE. The store is staged and then swapped in by rename, the previous
#     tree is discarded only afterwards, and every removal goes through
#     kube::node::internal::safe_rm, which canonicalises the path, refuses the
#     repository, ${HOME}, filesystem roots and anything containing the checkout,
#     and requires this library's ownership marker (or an npm-installed tree, or an
#     empty directory).
#   * NOTHING RACES. The mutating work is serialised with flock, because parallel
#     clones and concurrent gates can reach one store at once and an unserialised
#     install would replace a tree another process is reading from.
#
# THE VERSION OF RECORD. This repository pins no Node version anywhere - there
# is no .nvmrc, no .tool-versions and no `engines` field (AAP §0.3.3 and
# §0.2.1.1 measured all three). NODE_VERSION and NPM_VERSION below therefore
# restate no existing pin: they ARE the migration decision, and this file is its
# artifact of record. That is precisely why they are named, pinned and
# overridable rather than left implicit in whatever the host happens to ship.
#
# Modelled on hack/lib/etcd.sh: this file only defines variables and functions.
# It performs NO work when sourced - no validation, no install, no network
# access, no directory change - and it deliberately does NOT set errexit,
# nounset or pipefail, because it is sourced into a caller's shell and must not
# change the caller's shell options. For the same reason it does not source
# hack/lib/init.sh: init.sh sets those three options *before* its own
# kube::init::loaded short-circuit, so even re-sourcing it would leak them into
# a caller that had not opted in.
#
# Every failure path here returns a non-zero status after writing an actionable
# message to stderr. Nothing calls `exit`, unlike kube::etcd::validate, so a
# caller always decides for itself what a provisioning failure means.
#
# Usage:
#   source hack/lib/init.sh   # optional; supplies the kube::log::* helpers
#   source hack/lib/node.sh   #           this file uses when they are available
#   kube::node::setup_env     # validate, npm ci, and put node_modules/.bin on PATH
#   vitest run                # resolved from web/node_modules/.bin
#
# or, when ${PATH} must not be touched:
#   kube::node::dirs
#   kube::node::install
#   "${KUBE_NODE_MODULES_BIN}/vitest" run
#
# PUBLIC API
#   kube::node::setup_env            validate + ensure_deps + activate
#   kube::node::validate             node and npm are present and new enough
#   kube::node::ensure_deps          install the locked set (stamp- and
#                                    tree-guarded, lock-serialised)
#   kube::node::activate             put web/node_modules/.bin on ${PATH}
#   kube::node::dirs                 resolve the KUBE_WEB_DIR / KUBE_NODE_* paths
#   kube::node::install              validate + ensure_deps
#   kube::node::ensure_modules       compatibility spelling of ensure_deps
#   kube::node::externalize_modules  keep web/node_modules a symlink out of tree
#   kube::node::module_store         echo where the real node_modules lives
#   kube::node::run                  run an npm script from web/
#   kube::node::exec                 run one command under the SELECTED node runtime
#   kube::node::loaded               sourcing sentinel
#
# Two naming families are exposed on purpose, over one implementation.
# hack/verify-web.sh and hack/make-rules/test-web.sh call kube::node::dirs and
# kube::node::ensure_modules and read ${KUBE_WEB_DIR}; kube::node::install and
# kube::node::externalize_modules are the spellings this project's environment
# documentation publishes. Dropping either family would break `make verify` and
# `make test-web`, so both are maintained and kept in lockstep.

# Short-circuit if node.sh has already been sourced.
[[ $(type -t kube::node::loaded) == function ]] && return 0

# The root of the build/dist directory. This is the only variable this file
# introduces into a caller's environment when it is unset; the ${VAR:-default}
# form keeps it safe under `set -o nounset` and honours a caller that already
# resolved it (every caller that sourced hack/lib/init.sh has).
KUBE_ROOT="${KUBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"

# The Node.js and npm executables. Overriding either is how a caller points this
# tier at a runtime that is not first on ${PATH}.
#
# THE OVERRIDE IS HONOURED ALL THE WAY DOWN, which takes deliberate work: npm
# itself, and every launcher in web/node_modules/.bin (eslint, tsc, vitest), begins
# `#!/usr/bin/env node`, so each of them resolves the FIRST node on ${PATH} rather
# than the one validated here. Validating one runtime and executing another is a
# silent lie, so kube::node::validate prepends the selected runtime's directory to
# ${PATH} once it has checked it, and kube::node::exec runs a single command with
# the same guarantee for a caller who would rather not touch ${PATH} at all.
NODE_BIN=${NODE_BIN:-node}
NPM_BIN=${NPM_BIN:-npm}

# The Node.js version of record: the runtime this tier was built and verified
# against, per AAP §0.3.3 and §0.9.4.1. It is enforced as a FLOOR, exactly the
# way hack/lib/etcd.sh enforces ETCD_VERSION - a newer runtime is accepted, an
# older one is refused with an actionable message rather than silently
# tolerated. KUBE_NODE_MIN_VERSION is the spelling this library published
# first; the two name the same floor and are kept in lockstep, so either may be
# used as the override.
NODE_VERSION=${NODE_VERSION:-${KUBE_NODE_MIN_VERSION:-22.23.2}}
KUBE_NODE_MIN_VERSION=${KUBE_NODE_MIN_VERSION:-${NODE_VERSION}}

# The npm version of record, from the same measurement and enforced as a floor
# for the same reason. npm ships with Node.js, so a mismatch here normally means
# npm was upgraded in place; the message says so rather than just failing.
NPM_VERSION=${NPM_VERSION:-${KUBE_NPM_MIN_VERSION:-11.18.0}}
KUBE_NPM_MIN_VERSION=${KUBE_NPM_MIN_VERSION:-${NPM_VERSION}}

# Root of the React test tier. Override it before sourcing this file.
KUBE_WEB_DIR=${KUBE_WEB_DIR:-${KUBE_ROOT}/web}

# The two manifests npm reads. These are derived rather than overridable on
# purpose: npm resolves both relative to its --prefix, so a separate override
# would be recorded here and then quietly ignored by npm itself.
KUBE_NODE_PACKAGE_JSON="${KUBE_WEB_DIR}/package.json"
KUBE_NODE_PACKAGE_LOCK="${KUBE_WEB_DIR}/package-lock.json"

# The one derived value callers need, exported so that a consumer can invoke
# eslint, tsc or vitest by absolute path without depending on ${PATH} ordering
# (the hack/lib/etcd.sh L26 pattern of exporting a single derived value).
export KUBE_NODE_MODULES_BIN="${KUBE_WEB_DIR}/node_modules/.bin"

# Node tooling must never prompt and must never start a watcher in automation:
# AAP §0.9.4.1 requires CI=true for all Node tooling, and AAP §0.9.3 makes watch
# modes forbidden in automated execution. This is deliberately unconditional
# rather than ${CI:-true}: a stray CI=false in the environment would let vitest
# start a watcher and wedge a gate that can never finish. For an interactive
# session run `npx vitest` directly, which AAP §0.9.1.2 records as a local
# developer convenience only.
export CI=true

# Where the REAL node_modules tree is materialised. It lives OUTSIDE the
# repository working tree by default and ${KUBE_WEB_DIR}/node_modules is a
# symlink to it, because a 254-package third-party tree inside the working tree is
# visible to every tool that walks it. hack/boilerplate/boilerplate.py now skips
# web/node_modules explicitly, so hack/verify-boilerplate.sh alone would be
# satisfied by an in-tree tree; the store stays out of tree for the broader reasons
# that survive that skip - `find`-based helpers, editor and grep-based tooling,
# `git status` noise, and the tens of thousands of files (for instance
# node_modules/flatted/python/flatted.py) a reviewer would otherwise have to reason
# about. Neither os.walk() nor find(1) follows a symlinked directory, so the
# symlink keeps all of them looking at the tier itself, and .gitignore covers both
# spellings.
#
# The leaf MUST be named "node_modules": Node's resolver walks real paths, so a
# differently named leaf would stop sibling packages resolving. That is enforced
# rather than documented - see kube::node::internal::assert_store.
#
# Set KUBE_NODE_MODULES_STORE to override. Setting it to
# ${KUBE_WEB_DIR}/node_modules materialises the tree in place, with no symlink,
# for a checkout that is not subject to those tools. CLONE_INDEX, when a
# parallel runner sets it, keeps concurrent clones from sharing (and deleting)
# one another's store.
KUBE_NODE_MODULES_STORE=${KUBE_NODE_MODULES_STORE:-}

# How long to wait for another process's provisioning to finish before giving up,
# in seconds. Provisioning is serialised with flock (see
# kube::node::internal::with_lock) because several clones and several gates can
# reach the same store at once, and an unserialised install would let one process
# replace a tree another is reading from.
KUBE_NODE_LOCK_TIMEOUT=${KUBE_NODE_LOCK_TIMEOUT:-900}

# The file that marks a store as belonging to THIS library. Removal requires it
# (see kube::node::internal::safe_rm), which is what makes "replace the store"
# incapable of deleting a directory this library did not create. It is rewritten
# after every install, because `npm ci` deletes the whole tree first.
KUBE_NODE_STORE_MARKER_NAME=".kube-node-store"

# ---------------------------------------------------------------------------
# BOUNDED NETWORK AND PROCESS LIFECYCLES
# ---------------------------------------------------------------------------
# `npm ci` runs BEFORE any React test, in every gate that touches this tier, and
# it talks to a registry this repository does not control. Without an end-to-end
# deadline, a connection that is accepted and then never spoken on wedges
# `make test-web` and `hack/verify-web.sh` indefinitely - silently, because npm's
# progress output is suppressed here, so the job looks busy rather than broken.

# Milliseconds npm waits for a single registry request, passed as --fetch-timeout.
# npm's own unit is milliseconds, and it is kept in npm's unit rather than
# converted so that what is configured here is exactly what npm is told.
KUBE_NODE_FETCH_TIMEOUT_MS=${KUBE_NODE_FETCH_TIMEOUT_MS:-60000}

# Attempts npm makes per failed request. Bounded because npm's default retry
# behaviour multiplies the wall clock, and the whole-install ceiling below bounds
# the sum rather than any one attempt.
KUBE_NODE_FETCH_RETRIES=${KUBE_NODE_FETCH_RETRIES:-3}

# Seconds for the WHOLE `npm ci`, covering every request, every extraction and
# every lifecycle script the lockfile names. The loosest bound of the three by
# design: a cold install of the 254-package set is minutes of legitimate work.
KUBE_NODE_INSTALL_TIMEOUT=${KUBE_NODE_INSTALL_TIMEOUT:-1800}

# kube::node::internal::bounded runs "$@" under a wall-clock ceiling of $1 seconds
# and returns its EXACT exit status - or reports the timeout and returns the status
# timeout(1) gave.
#
# Exact propagation matters because a failed install and a STALLED one need
# different responses from a human (reconcile the lockfile versus fix the link),
# and collapsing both to 1 would erase the distinction precisely where it counts.
#
# timeout(1) is not one program, and this is measured rather than assumed: GNU
# coreutils returns 124 when it fires, while the uutils Rust reimplementation
# shipped as coreutils-from-uutils on Ubuntu 25.10 returns 125 whenever
# --kill-after is given. Both are recognised, with 137 (128+SIGKILL) from the
# escalation. When timeout(1) is absent the command still runs, unbounded, with a
# warning: losing the bound must not mean losing the ability to provision.
kube::node::internal::bounded() {
  local seconds=${1:?a ceiling in seconds is required}
  shift

  if [[ ! "${seconds}" =~ ^[1-9][0-9]*$ ]]; then
    kube::node::internal::log_error \
      "internal: a bounded command needs a positive integer ceiling, got '${seconds}'."
    return 1
  fi

  # timeout(1) is an EXTERNAL program, so it can only ever execute an external
  # command: handed the name of a shell function it fails with 127 "command not
  # found" and the bound silently becomes a broken call. That failure mode is
  # indistinguishable from a missing binary in a log, so it is refused loudly
  # here rather than left to surface as a mystery 127 from a provisioning step.
  # Callers that need to bound work expressed as a function must invert the
  # nesting - call the function, and bound the external command INSIDE it, which
  # is exactly what kube::node::ensure_deps does with kube::node::exec.
  if [[ $(type -t "${1:-}") == function ]]; then
    kube::node::internal::log_error \
      "internal: '$1' is a shell function, which timeout(1) cannot execute (it would exit 127)." \
      "Bound the external command inside the function instead of bounding the function."
    return 1
  fi

  if ! command -v timeout >/dev/null 2>&1; then
    kube::node::internal::log_error \
      "timeout(1) was not found, so '$1' runs with NO deadline." \
      "A stalled npm registry read will wedge this gate rather than failing it." \
      "Install coreutils to restore the bound."
    "$@"
    return $?
  fi

  local rc=0
  timeout --signal=TERM --kill-after=30s "${seconds}s" "$@" || rc=$?
  if [[ "${rc}" -eq 124 || "${rc}" -eq 125 || "${rc}" -eq 137 ]]; then
    kube::node::internal::log_error \
      "'$1' exceeded its ${seconds}s deadline and was terminated (timeout exited ${rc})." \
      "This is a stalled network or process rather than a dependency problem: the step was" \
      "still running, not failing. Check connectivity to the npm registry, then re-run;" \
      "nothing was recorded, so provisioning will be retried." \
      "Raise KUBE_NODE_INSTALL_TIMEOUT only if the link is genuinely that slow."
  fi
  return "${rc}"
}

# kube::node::internal::log_error writes an actionable, ERROR:-prefixed message
# to stderr. On return the message has been written and nothing else has
# changed; the status is always 0 so callers control their own exit code.
#
# It prefers this repository's kube::log::usage and falls back to a plain echo,
# because a consumer may have sourced only this file: kube::log::usage is safe
# on its own, but kube::log::info and kube::log::status both evaluate
# `(( KUBE_VERBOSE < V ))` and die with "KUBE_VERBOSE: unbound variable" under
# `set -o nounset` when hack/lib/logging.sh was never sourced.
kube::node::internal::log_error() {
  local -a lines=()
  local message

  for message in "$@"; do
    if [[ ${#lines[@]} -eq 0 ]]; then
      lines+=("ERROR: ${message}")
    else
      lines+=("${message}")
    fi
  done
  if [[ ${#lines[@]} -eq 0 ]]; then
    return 0
  fi

  if [[ $(type -t kube::log::usage) == function ]]; then
    kube::log::usage "${lines[@]}"
    return 0
  fi
  for message in "${lines[@]}"; do
    echo "${message}" >&2
  done
  return 0
}

# kube::node::internal::level echoes the verbosity level $1 when it is a plain
# decimal integer, and the fallback $2 otherwise. On return one decimal integer
# has been printed and nothing has been modified.
#
# This exists because ${KUBE_VERBOSE} and ${V} are ENVIRONMENT-CONTROLLED and were
# previously interpolated straight into `(( ... ))`. Bash arithmetic EVALUATES its
# operands, so a value such as `x[$(...)]` executes the command substitution inside
# it - a read-only log call became an execution path. Every comparison below
# therefore runs on a validated digit string, and the raw value is never handed to
# an arithmetic context.
kube::node::internal::level() {
  local raw=${1:-}
  local fallback=${2:?a fallback level is required}

  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    echo "${raw}"
  else
    echo "${fallback}"
  fi
}

# kube::node::internal::verbosity_is_sane succeeds when ${KUBE_VERBOSE} and ${V}
# are either unset/empty or plain decimal integers. On return the status says so
# and nothing has been modified.
#
# It gates DELEGATION to kube::log::info and kube::log::status, which evaluate
# `(( KUBE_VERBOSE < V ))` themselves (hack/lib/logging.sh): passing an unvalidated
# value on to them would move the arithmetic-evaluation problem one file away
# instead of closing it.
kube::node::internal::verbosity_is_sane() {
  [[ -z "${KUBE_VERBOSE:-}" || "${KUBE_VERBOSE:-}" =~ ^[0-9]+$ ]] || return 1
  [[ -z "${V:-}" || "${V:-}" =~ ^[0-9]+$ ]] || return 1
  return 0
}

# kube::node::internal::level_suppresses succeeds when the current ${V} exceeds the
# current ${KUBE_VERBOSE}, i.e. when a message at that level must be suppressed. On
# return the status says so and nothing has been modified. Both values are
# validated before any arithmetic runs.
kube::node::internal::level_suppresses() {
  local verbose level
  verbose=$(kube::node::internal::level "${KUBE_VERBOSE:-}" 2)
  level=$(kube::node::internal::level "${V:-}" 0)

  (( verbose < level ))
}

# kube::node::internal::log_status writes a top-level status line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::status does. On
# return the line has been written or suppressed by verbosity, and the status is
# 0. Guarded for the same reason as log_error above, and additionally guarded on
# the two verbosity variables being sane integers.
kube::node::internal::log_status() {
  if [[ $(type -t kube::log::status) == function && -n "${KUBE_VERBOSE:-}" ]] &&
    kube::node::internal::verbosity_is_sane; then
    kube::log::status "$@"
    return 0
  fi

  local message
  if kube::node::internal::level_suppresses; then
    return 0
  fi
  for message in "$@"; do
    echo "+++ ${message}"
  done
  return 0
}

# kube::node::internal::log_info writes a non-top-level line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::info does, so
# `V=4 kube::node::internal::log_info ...` stays quiet on a normal run. On
# return the line has been written or suppressed, and the status is 0. Guarded on
# sane verbosity values for the reason verbosity_is_sane gives.
kube::node::internal::log_info() {
  if [[ $(type -t kube::log::info) == function && -n "${KUBE_VERBOSE:-}" ]] &&
    kube::node::internal::verbosity_is_sane; then
    kube::log::info "$@"
    return 0
  fi

  local message
  if kube::node::internal::level_suppresses; then
    return 0
  fi
  for message in "$@"; do
    echo "${message}"
  done
  return 0
}

# kube::node::internal::version turns dotted version strings into zero-padded
# sortable integers, one per line, so they can be compared with -gt and -lt. On
# return each argument has been printed in that form. Taken from
# kube::etcd::version (hack/lib/etcd.sh L72-74) so that version comparison
# behaves identically across this repository's provisioners.
kube::node::internal::version() {
  printf '%s\n' "${@}" | awk -F . '{ printf("%d%03d%03d\n", $1, $2, $3) }'
}

# kube::node::internal::binary_version echoes the dotted numeric version the
# executable $1 reports. On return that version has been printed, or nothing has
# been printed and the status is non-zero because $1 could not report one.
#
# `node --version` prints a leading "v" (v22.23.2) while `npm --version` does
# not, so the "v" is stripped here; feeding it to the numeric comparator would
# make awk read the major as 0 and every comparison would fail. Any trailing
# non-numeric suffix is dropped too, so a pre-release or vendor build such as
# 22.23.2-nightly compares as 22.23.2 rather than being rejected outright.
kube::node::internal::binary_version() {
  local version

  version=$("${1}" --version 2>/dev/null | head -n 1) || return 1
  version=${version#v}
  version=${version%%[!0-9.]*}
  [[ -n "${version}" ]] || return 1
  echo "${version}"
}

# kube::node::internal::meets_floor succeeds when the dotted version $1 is at or
# above the required dotted version $2. On return the status says so and nothing
# has been modified.
#
# The comparison is numeric, never lexical: "22.9.0" sorts above "22.23.2" as a
# string and below it as a version, and getting that backwards would silently
# accept an older runtime.
kube::node::internal::meets_floor() {
  local have=${1:-}
  local want=${2:-}

  [[ -n "${have}" && -n "${want}" ]] || return 1
  # Fails when the required version is greater than the detected one, exactly as
  # kube::etcd::validate compares ETCD_VERSION (hack/lib/etcd.sh L59).
  if [[ $(kube::node::internal::version "${want}") -gt $(kube::node::internal::version "${have}") ]]; then
    return 1
  fi
  return 0
}

# kube::node::internal::canonical echoes the absolute, symlink-resolved form of the
# path $1, whether or not it exists. On return one absolute path has been printed,
# or nothing has been printed and the status is non-zero because the path is empty
# or its parent cannot be resolved.
#
# Every safety decision below is taken on the CANONICAL path, never on the string a
# caller supplied: `${store}/../../..`, a symlink to `/` and a relative spelling all
# name something different from what they look like, and a guard that compares
# strings is defeated by each of them.
kube::node::internal::canonical() {
  local path=${1:-}

  [[ -n "${path}" ]] || return 1

  if [[ -d "${path}" ]]; then
    (cd "${path}" 2>/dev/null && pwd -P) && return 0
    return 1
  fi

  local parent leaf resolved
  parent=$(dirname "${path}")
  leaf=$(basename "${path}")
  if [[ "${parent}" == "${path}" ]]; then
    echo "${path}"
    return 0
  fi
  resolved=$(kube::node::internal::canonical "${parent}") || return 1
  echo "${resolved%/}/${leaf}"
}

# kube::node::internal::is_ancestor succeeds when the canonical path $1 is $2 or
# contains it. On return the status says so and nothing has been modified.
kube::node::internal::is_ancestor() {
  local candidate=${1:-}
  local descendant=${2:-}

  [[ -n "${candidate}" && -n "${descendant}" ]] || return 1
  [[ "${candidate}" == "${descendant}" || "${descendant}" == "${candidate%/}/"* ]]
}

# kube::node::internal::assert_store succeeds when $1 is a usable node_modules
# store. On return the status says so; a refusal has written an actionable message.
#
# Two properties, both load-bearing rather than stylistic:
#   1. the LEAF is literally "node_modules". Node's resolver walks real paths, so a
#      differently named leaf silently stops sibling packages resolving - a failure
#      that surfaces as a module-not-found error deep inside a test run.
#   2. the store is EITHER outside the repository working tree, OR exactly
#      ${KUBE_WEB_DIR}/node_modules, which is the documented in-place opt out.
#      Anything else inside the tree would be a third-party tree in an unexpected
#      place that the repository's tooling would then walk.
kube::node::internal::assert_store() {
  local store=${1:-}

  local canonical
  if ! canonical=$(kube::node::internal::canonical "${store}"); then
    kube::node::internal::log_error \
      "KUBE_NODE_MODULES_STORE '${store}' could not be resolved to an absolute path." \
      "Set it to a directory whose parent exists."
    return 1
  fi

  if [[ "$(basename "${canonical}")" != "node_modules" ]]; then
    kube::node::internal::log_error \
      "refusing the node_modules store '${canonical}': its last path component must be" \
      "literally 'node_modules', because Node's resolver walks real paths and a differently" \
      "named leaf stops sibling packages resolving." \
      "Set KUBE_NODE_MODULES_STORE=<dir>/node_modules instead."
    return 1
  fi

  local repo_root in_tree
  repo_root=$(kube::node::internal::canonical "${KUBE_ROOT}") || repo_root=""
  in_tree=$(kube::node::internal::canonical "${KUBE_WEB_DIR}/node_modules") || in_tree=""
  if [[ -n "${repo_root}" ]] &&
    kube::node::internal::is_ancestor "${repo_root}" "${canonical}" &&
    [[ "${canonical}" != "${in_tree}" ]]; then
    kube::node::internal::log_error \
      "refusing the node_modules store '${canonical}': it is inside the repository working tree" \
      "at '${repo_root}' and is not the one in-tree path this library supports," \
      "'${in_tree}'." \
      "Set KUBE_NODE_MODULES_STORE to a directory outside the checkout, or to exactly that path" \
      "to materialise the tree in place."
    return 1
  fi
  return 0
}

# kube::node::internal::assert_removable succeeds when the path $1 is one this
# library may recursively remove. On return the status says so; a refusal has
# written an actionable message and removed nothing.
#
# `rm -rf` against an unexpected value is the one irreversible mistake a
# provisioner can make, and both KUBE_WEB_DIR and KUBE_NODE_MODULES_STORE are
# environment-controlled, so this is a hard gate rather than a sanity check. Four
# conditions, all required:
#
#   1. the canonical path is not a filesystem root and has at least two
#      components, so `/`, `/opt` and `/home` can never be targets;
#   2. it is neither ${HOME}, nor the repository root, nor an ANCESTOR of the
#      repository root - a store that contained the checkout would take the
#      checkout with it;
#   3. it is not inside the repository working tree, with exactly one exception:
#      ${KUBE_WEB_DIR}/node_modules, the in-tree path this library owns;
#   4. it carries this library's ownership marker, OR it is a node_modules tree
#      (it has a .package-lock.json, which npm writes into every tree it installs),
#      OR it is empty. A directory that is none of those three belongs to somebody
#      else and is refused - which is what stops an operator-supplied override
#      pointing at real data from being deleted.
kube::node::internal::assert_removable() {
  local target=${1:-}
  local what=${2:-the path}

  local canonical
  if ! canonical=$(kube::node::internal::canonical "${target}"); then
    kube::node::internal::log_error \
      "refusing to remove ${what} '${target}': it could not be resolved to an absolute path." \
      "This is a bug in hack/lib/node.sh or an unsafe KUBE_WEB_DIR / KUBE_NODE_MODULES_STORE value."
    return 1
  fi

  local trimmed=${canonical#/}
  if [[ "${canonical}" != /* || -z "${trimmed}" || "${trimmed}" != */* ]]; then
    kube::node::internal::log_error \
      "refusing to remove ${what} '${canonical}': it is a filesystem root or too close to one." \
      "Set KUBE_NODE_MODULES_STORE to a dedicated directory such as /opt/blitzy/node/web/node_modules."
    return 1
  fi

  local repo_root home_dir
  repo_root=$(kube::node::internal::canonical "${KUBE_ROOT}") || repo_root=""
  home_dir=$(kube::node::internal::canonical "${HOME:-/nonexistent}") || home_dir=""
  if [[ -n "${home_dir}" && "${canonical}" == "${home_dir}" ]] ||
    { [[ -n "${repo_root}" ]] && kube::node::internal::is_ancestor "${canonical}" "${repo_root}"; }; then
    kube::node::internal::log_error \
      "refusing to remove ${what} '${canonical}': it is your home directory, the repository root," \
      "or a directory that CONTAINS the repository at '${repo_root}'." \
      "Set KUBE_NODE_MODULES_STORE to a dedicated directory outside the working tree."
    return 1
  fi

  local in_tree
  in_tree=$(kube::node::internal::canonical "${KUBE_WEB_DIR}/node_modules") || in_tree=""
  if [[ -n "${repo_root}" ]] &&
    kube::node::internal::is_ancestor "${repo_root}" "${canonical}" &&
    [[ "${canonical}" != "${in_tree}" ]]; then
    kube::node::internal::log_error \
      "refusing to remove ${what} '${canonical}': it is inside the repository working tree" \
      "and is not the node_modules path '${in_tree}' this library owns." \
      "Nothing was removed."
    return 1
  fi

  if [[ ! -e "${canonical}" ]]; then
    return 0
  fi
  if [[ -f "${canonical}/${KUBE_NODE_STORE_MARKER_NAME}" || -f "${canonical}/.package-lock.json" ]]; then
    return 0
  fi
  if [[ -d "${canonical}" ]] && [[ -z "$(ls -A "${canonical}" 2>/dev/null)" ]]; then
    return 0
  fi

  kube::node::internal::log_error \
    "refusing to remove ${what} '${canonical}': it is not empty, it is not an npm-installed tree" \
    "(no .package-lock.json) and it carries no '${KUBE_NODE_STORE_MARKER_NAME}' marker, so this" \
    "library did not create it." \
    "Move it aside by hand if you meant to replace it, or point KUBE_NODE_MODULES_STORE somewhere else." \
    "Nothing was removed."
  return 1
}

# kube::node::internal::mark_store records this library's ownership of the store $1
# by writing ${KUBE_NODE_STORE_MARKER_NAME} into it. On return the marker exists, or
# it does not and the status is non-zero.
#
# It has to be rewritten after every install: `npm ci` deletes node_modules in full
# before installing, so the marker - like the lockfile stamp beside it - does not
# survive one.
kube::node::internal::mark_store() {
  local store=${1:?a store path is required}

  [[ -d "${store}" ]] || return 1
  {
    echo "// Created by hack/lib/node.sh for the Kubernetes React (Vitest) test tier."
    echo "// Its presence is what permits this library to replace this tree."
    echo "// Delete the directory rather than this file if you want it rebuilt from scratch."
    echo "// repository=${KUBE_ROOT}"
    echo "// clone_index=${CLONE_INDEX:-}"
  } >"${store}/${KUBE_NODE_STORE_MARKER_NAME}" 2>/dev/null || return 1
  return 0
}

# kube::node::internal::safe_rm removes the path $1 after
# kube::node::internal::assert_removable has approved it. On return the path is
# gone, or nothing has been removed and the status is non-zero.
kube::node::internal::safe_rm() {
  local target=${1:-}
  local what=${2:-the path}

  kube::node::internal::assert_removable "${target}" "${what}" || return 1

  local canonical
  canonical=$(kube::node::internal::canonical "${target}") || return 1
  rm -rf "${canonical}"
}

# kube::node::internal::with_lock runs the function named by $2 (with any further
# arguments) while holding an exclusive lock on the file $1. On return the function
# has run and its status is this function's status, or the lock could not be taken
# within ${KUBE_NODE_LOCK_TIMEOUT} seconds and the status is non-zero.
#
# Provisioning REPLACES a store that several processes can reach at once - parallel
# clones sharing one store, `make verify` and `make test-web` racing, a second gate
# starting while the first installs. Without serialisation one process can replace
# the tree another is reading from, which is a corrupt environment that reports
# success. The body runs in a subshell holding the lock on a dedicated file
# descriptor, the canonical flock idiom; every effect this library has is on the
# filesystem, so nothing is lost by the subshell.
#
# flock is not universally present. When it is missing the work still runs, and says
# once that it is unserialised, because refusing to provision at all would be a
# worse outcome than provisioning without the guard.
kube::node::internal::with_lock() {
  local lockfile=${1:?a lock file path is required}
  shift

  if ! command -v flock >/dev/null 2>&1; then
    V=3 kube::node::internal::log_info \
      "flock is not available, so provisioning is not serialised; a concurrent run could race"
    "$@"
    return $?
  fi

  if ! mkdir -p "$(dirname "${lockfile}")" 2>/dev/null; then
    V=3 kube::node::internal::log_info \
      "could not create $(dirname "${lockfile}") for the provisioning lock; continuing unserialised"
    "$@"
    return $?
  fi

  local timeout
  timeout=$(kube::node::internal::level "${KUBE_NODE_LOCK_TIMEOUT}" 900)

  (
    if ! flock -w "${timeout}" 9; then
      kube::node::internal::log_error \
        "timed out after ${timeout}s waiting for the npm provisioning lock ${lockfile}." \
        "Another process is provisioning the same store. Wait for it to finish, or set" \
        "KUBE_NODE_MODULES_STORE to a store of your own (CLONE_INDEX does this automatically for" \
        "parallel clones)."
      exit 1
    fi
    "$@"
  ) 9>"${lockfile}"
}

# kube::node::internal::runtime_dir echoes the directory holding the SELECTED node
# binary. On return one absolute directory has been printed, or nothing has been
# printed and the status is non-zero because ${NODE_BIN} could not be resolved.
kube::node::internal::runtime_dir() {
  local resolved
  resolved=$(command -v "${NODE_BIN}" 2>/dev/null) || return 1
  kube::node::internal::canonical "$(dirname "${resolved}")"
}

# kube::node::internal::prepend_runtime_path puts the selected runtime's directory
# first on ${PATH}, exactly once. On return every `#!/usr/bin/env node` launcher -
# npm, eslint, tsc, vitest - resolves the runtime this library validated; or the
# runtime could not be resolved and the status is non-zero with ${PATH} unchanged.
#
# This is the whole point of honouring ${NODE_BIN}: validating one runtime and then
# executing a different one, because a launcher's shebang searched ${PATH} instead,
# is a silent lie about which Node the tier ran under. Prepending is idempotent, and
# it is a no-op in the common case where the selected node is already first.
kube::node::internal::prepend_runtime_path() {
  local runtime_dir
  runtime_dir=$(kube::node::internal::runtime_dir) || return 1

  export KUBE_NODE_RUNTIME_DIR="${runtime_dir}"
  if [[ ":${PATH}:" != *":${runtime_dir}:"* ]]; then
    PATH="${runtime_dir}:${PATH}"
    export PATH
    hash -r 2>/dev/null || true
    V=3 kube::node::internal::log_info \
      "put the selected Node.js runtime first on PATH: ${runtime_dir}"
  fi
  return 0
}

# kube::node::exec runs the command "$@" with the selected runtime's directory
# first on the CHILD's ${PATH}, leaving this shell's ${PATH} alone. On return the
# command has run and its status is this function's status.
#
# For a caller that invokes a launcher by absolute path - hack/verify-web.sh and
# hack/make-rules/test-web.sh both do, deliberately, so that ${PATH} order cannot
# decide which eslint or vitest runs - this is how the same guarantee is obtained
# for the runtime those launchers then look up through `env node`.
kube::node::exec() {
  local runtime_dir
  if runtime_dir=$(kube::node::internal::runtime_dir); then
    PATH="${runtime_dir}:${PATH}" "$@"
    return $?
  fi
  "$@"
}

# kube::node::internal::lockfile_hash echoes a SHA-256 of the lockfile the tier
# is installed from. On return the hash has been printed, or nothing has been
# printed and the status is non-zero because the lockfile is missing or no
# hashing utility is available. A missing hash is not an error for callers: it
# only means the install cannot be skipped and will simply run again.
kube::node::internal::lockfile_hash() {
  [[ -f "${KUBE_NODE_PACKAGE_LOCK}" ]] || return 1

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${KUBE_NODE_PACKAGE_LOCK}" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${KUBE_NODE_PACKAGE_LOCK}" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${KUBE_NODE_PACKAGE_LOCK}" | awk '{ print $NF }'
  else
    return 1
  fi
}

# kube::node::internal::lockfile_stamp echoes the path of the file that records
# which lockfile the installed tree was built from. On return the path has been
# printed; the file itself may or may not exist. It lives inside node_modules so
# that discarding the tree discards the record with it, and - because
# node_modules is a symlink to a store outside the working tree - so that
# nothing is written into the repository.
kube::node::internal::lockfile_stamp() {
  echo "${KUBE_WEB_DIR}/node_modules/.kube-lockfile.sha256"
}

# kube::node::internal::modules_present succeeds when an installed dependency
# tree is visible at ${KUBE_WEB_DIR}/node_modules. On return the status says so
# and nothing has been modified. The tests use -d, which follows symlinks, so
# the externalised layout satisfies them exactly as an in-place tree would.
kube::node::internal::modules_present() {
  [[ -d "${KUBE_WEB_DIR}/node_modules" ]] || return 1
  [[ -d "${KUBE_NODE_MODULES_BIN}" ]] || return 1
  return 0
}

# kube::node::internal::tree_matches_lock succeeds when the packages installed under
# ${KUBE_WEB_DIR}/node_modules are exactly what package.json and package-lock.json
# describe. On return the status says so; a mismatch has written a report naming
# every offender and nothing has been modified.
#
# THIS IS WHAT THE STAMP FAST PATH IS WORTH. A stamp records only that some run once
# installed from a lockfile with this hash; it says nothing about what is in the tree
# NOW. A store that was hand-modified, partially upgraded by a stray `npm install`,
# or warmed by a previous batch from a different lockfile would keep its stamp and
# quietly run a different toolchain than the one every gate reports. So the fast path
# asserts the tree itself, and a mismatch reinstalls instead of trusting the stamp.
#
# `npm ls --all` is deliberately NOT used for this. MEASURED: with
# ${KUBE_WEB_DIR}/node_modules a symlink to an out-of-tree store - the supported and
# default layout - `npm ls --all --json` exits 1 with ELSPROBLEMS and reports every
# installed package as `extraneous`, so it cannot distinguish a healthy tree from a
# broken one here. Reading the lockfile and checking each package on disk is both
# exact and immune to that, and it needs no registry access.
#
# Two assertions:
#   1. every ROOT pin in package.json is installed at EXACTLY the pinned version -
#      these 17 are the tier's toolchain, and drift in one of them is precisely the
#      "gate speaks for a version nobody pinned" failure;
#   2. every non-optional package the lockfile declares exists at the path the
#      lockfile gives it, at the version it records. Optional packages are reported
#      only when present-but-wrong, because npm legitimately skips them per platform.
kube::node::internal::tree_matches_lock() {
  [[ -f "${KUBE_NODE_PACKAGE_JSON}" ]] || return 1
  [[ -f "${KUBE_NODE_PACKAGE_LOCK}" ]] || return 1
  [[ -d "${KUBE_WEB_DIR}/node_modules" ]] || return 1

  kube::node::exec "${NODE_BIN}" - \
    "${KUBE_NODE_PACKAGE_JSON}" "${KUBE_NODE_PACKAGE_LOCK}" "${KUBE_WEB_DIR}" <<'NODE_TREE_CHECK'
// Compare the installed npm tree with package.json and package-lock.json.
//
// Called by kube::node::internal::tree_matches_lock in hack/lib/node.sh. Prints one
// line per offender to stderr and exits 1; prints nothing and exits 0 when the tree
// matches. Uses only Node's own modules, so it runs before anything is installed.
"use strict";

const fs = require("fs");
const path = require("path");

const [manifestPath, lockPath, webDir] = process.argv.slice(2);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const manifest = readJson(manifestPath);
const lock = readJson(lockPath);
const problems = [];

const installedVersion = (relativePath) => {
  const file = path.join(webDir, relativePath, "package.json");
  try {
    return readJson(file).version;
  } catch (error) {
    return null;
  }
};

// 1. the root pins, which are the tier's own toolchain.
const roots = Object.assign({}, manifest.dependencies, manifest.devDependencies);
for (const [name, spec] of Object.entries(roots)) {
  const found = installedVersion(path.join("node_modules", name));
  if (found === null) {
    problems.push(`${name}@${spec} is pinned but NOT installed`);
  } else if (found !== spec) {
    problems.push(`${name}: installed ${found}, pinned ${spec}`);
  }
}

// 2. every package the lockfile declares.
for (const [entry, meta] of Object.entries(lock.packages || {})) {
  if (!entry || !meta || !meta.version || meta.link) {
    continue; // the root project entry, or a workspace link
  }
  const found = installedVersion(entry);
  if (found === null) {
    if (!meta.optional && !meta.devOptional) {
      problems.push(`${entry}@${meta.version} is locked but NOT installed`);
    }
    continue;
  }
  if (found !== meta.version) {
    problems.push(`${entry}: installed ${found}, lock records ${meta.version}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `the installed npm packages do not match ${manifestPath} and ${lockPath}:\n`
  );
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.exit(1);
}
NODE_TREE_CHECK
}

# kube::node::dirs resolves the paths this library works with and exports
# KUBE_NODE_MODULES_BIN. On return KUBE_WEB_DIR, KUBE_NODE_PACKAGE_JSON,
# KUBE_NODE_PACKAGE_LOCK and KUBE_NODE_MODULES_BIN are all non-empty and
# mutually consistent. It creates nothing, installs nothing, touches no network
# and is safe to call any number of times.
#
# It re-asserts the same defaults the configuration block above applies, so a
# caller that unset one of them still gets a coherent set. hack/verify-web.sh
# and hack/make-rules/test-web.sh call this before reading ${KUBE_WEB_DIR}.
kube::node::dirs() {
  KUBE_WEB_DIR=${KUBE_WEB_DIR:-${KUBE_ROOT}/web}
  # Derived, not defaulted: npm resolves both from its --prefix, so these two
  # always name the manifests inside ${KUBE_WEB_DIR}.
  KUBE_NODE_PACKAGE_JSON="${KUBE_WEB_DIR}/package.json"
  KUBE_NODE_PACKAGE_LOCK="${KUBE_WEB_DIR}/package-lock.json"
  export KUBE_NODE_MODULES_BIN="${KUBE_WEB_DIR}/node_modules/.bin"
  return 0
}

# kube::node::module_store echoes the directory that holds the real node_modules
# tree. On return the path has been printed and its parent exists, or an
# actionable message has been written and the status is non-zero. It creates the
# parent directory but never the tree itself, and it downloads nothing.
#
# See the KUBE_NODE_MODULES_STORE comment above for why the real tree lives
# outside the repository working tree and why the leaf must stay named
# "node_modules".
kube::node::module_store() {
  if [[ -n "${KUBE_NODE_MODULES_STORE:-}" ]]; then
    # An operator-supplied store is validated before it is ever returned: the leaf
    # has to be named node_modules and the tree has to sit outside the checkout
    # (or be exactly the in-place path). Both are enforced here rather than
    # documented, because every later step - including a removal - trusts this value.
    kube::node::internal::assert_store "${KUBE_NODE_MODULES_STORE}" || return 1
    echo "${KUBE_NODE_MODULES_STORE}"
    return 0
  fi

  # Preferred location, then a temporary-directory fallback for hosts where it
  # cannot be created (an unprivileged developer machine, typically).
  local base="/opt/blitzy/node"
  if ! mkdir -p "${base}" 2>/dev/null; then
    base="${TMPDIR:-/tmp}/blitzy/node"
    if ! mkdir -p "${base}"; then
      kube::node::internal::log_error \
        "could not create a directory to hold node_modules (tried /opt/blitzy/node and ${base})." \
        "Set KUBE_NODE_MODULES_STORE to a writable directory outside the repository working tree."
      return 1
    fi
  fi

  echo "${base}/web${CLONE_INDEX:+-${CLONE_INDEX}}/node_modules"
}

# kube::node::externalize_modules restores the invariant that
# ${KUBE_WEB_DIR}/node_modules is a symlink to a store outside the repository
# working tree. On return that path is either a symlink to the store or absent,
# or an actionable message has been written and the status is non-zero. It
# installs nothing and touches no network.
#
# npm reifies node_modules and replaces a pre-existing symlink with a real
# directory, so this has to run after every install rather than only once. It is
# idempotent: a path that is already a symlink, or absent, is left alone.
kube::node::externalize_modules() {
  kube::node::dirs

  local in_tree="${KUBE_WEB_DIR}/node_modules"

  # Already externalised, or there is nothing to move. Test -L before -d because
  # -d follows symlinks and would report true for the already-correct layout.
  if [[ -L "${in_tree}" ]] || [[ ! -d "${in_tree}" ]]; then
    return 0
  fi

  local store
  store=$(kube::node::module_store) || return 1

  # Pointing the store at the in-tree path is the supported opt out for a
  # checkout that is not subject to the tree-walking gates; nothing to relocate.
  if [[ "${store}" == "${in_tree}" ]]; then
    return 0
  fi

  kube::node::internal::log_status \
    "Relocating ${in_tree} to ${store} (keeps the repository's tree-walking tools out of it)"

  if ! mkdir -p "$(dirname "${store}")"; then
    kube::node::internal::log_error \
      "could not create $(dirname "${store}") to hold the node_modules tree." \
      "Set KUBE_NODE_MODULES_STORE to a writable directory outside the repository working tree."
    return 1
  fi

  # STAGE, THEN SWAP, THEN DISCARD - in that order, and the order is the point.
  #
  # The previous shape deleted the store FIRST and only then moved the new tree in,
  # so an interruption or a failed move left no store at all: a concurrent reader
  # lost its dependency tree, and this clone lost the one it had just installed.
  # Every step below is a rename within one directory, which is atomic, and the old
  # store is only discarded once the new one is in place.
  local staging="${store}.staging.$$"
  local superseded="${store}.superseded.$$"

  kube::node::internal::safe_rm "${staging}" "a leftover staging tree" >/dev/null 2>&1 || true

  if ! mv "${in_tree}" "${staging}"; then
    kube::node::internal::log_error \
      "could not move ${in_tree} to ${staging}." \
      "The dependency tree is still in the repository working tree, where the repository's" \
      "tree-walking tooling will find it." \
      "Move it aside by hand, or set KUBE_NODE_MODULES_STORE=${in_tree} to keep it in place deliberately."
    return 1
  fi

  # Claim ownership of the staged tree before it becomes the store, so the swap
  # below and every later rebuild are permitted to touch exactly this tree.
  kube::node::internal::mark_store "${staging}" || true

  local had_previous=n
  if [[ -e "${store}" ]]; then
    # Approve the removal BEFORE anything is renamed, so an unowned store is
    # reported while the tree is still whole and recoverable.
    if ! kube::node::internal::assert_removable "${store}" "the previous node_modules store"; then
      # Put the installed tree back where it came from: refusing to touch somebody
      # else's store must not also cost this clone its own dependencies.
      mv "${staging}" "${in_tree}" || true
      return 1
    fi
    if ! mv "${store}" "${superseded}"; then
      kube::node::internal::log_error \
        "could not move the previous store ${store} aside." \
        "Nothing was deleted; the freshly installed tree is at ${staging}."
      mv "${staging}" "${in_tree}" || true
      return 1
    fi
    had_previous=y
  fi

  if ! mv "${staging}" "${store}"; then
    kube::node::internal::log_error \
      "could not move ${staging} into place at ${store}." \
      "Nothing was deleted."
    # Restore whatever was there before, then hand the new tree back to the caller's
    # working tree so no state is lost.
    if [[ "${had_previous}" == y ]]; then
      mv "${superseded}" "${store}" || true
    fi
    mv "${staging}" "${in_tree}" || true
    return 1
  fi

  if ! ln -sfn "${store}" "${in_tree}"; then
    kube::node::internal::log_error \
      "could not link ${in_tree} to ${store}, so the installed tree is no longer visible to npm or Node." \
      "The tree itself is intact at ${store}." \
      "Create the symlink by hand, or set KUBE_NODE_MODULES_STORE=${in_tree} and reinstall."
    return 1
  fi

  # Only now, with the new store in place and linked, is the old one discarded.
  if [[ "${had_previous}" == y ]]; then
    kube::node::internal::safe_rm "${superseded}" "the superseded node_modules store" || true
  fi
  return 0
}

# kube::node::validate checks that this host can run the React test tier. On
# return node and npm are both present and at or above their required versions AND
# the selected runtime's directory is first on ${PATH}, or an actionable message
# naming the detected version, the required version and the fix has been written to
# stderr and the status is non-zero. Nothing is created, nothing is installed and no
# network is used.
#
# THE ONE THING IT CHANGES is ${PATH}, and that is deliberate rather than
# incidental: npm and every launcher in web/node_modules/.bin begins
# `#!/usr/bin/env node`, so without this the runtime checked here and the runtime
# that actually executed the tests could be two different binaries whenever
# ${NODE_BIN} names one that is not already first. The change is idempotent and is a
# no-op in the common case.
#
# The floors are never relaxed to let provisioning proceed: an older runtime is
# reported and refused, because "the tests pass on some other Node" is not the
# property this tier is meant to have. NODE_VERSION and NPM_VERSION are the
# documented overrides for an operator who accepts an unverified runtime.
kube::node::validate() {
  kube::node::dirs

  local node_path npm_path node_have npm_have

  if ! node_path=$(command -v "${NODE_BIN}" 2>/dev/null); then
    kube::node::internal::log_error \
      "node must be in your PATH: '${NODE_BIN}' was not found." \
      "The React test tier needs Node.js ${NODE_VERSION} or greater." \
      "Install it, or set NODE_BIN to the executable you want to use, for example: NODE_BIN=/usr/local/bin/node make test-web"
    return 1
  fi

  if ! npm_path=$(command -v "${NPM_BIN}" 2>/dev/null); then
    kube::node::internal::log_error \
      "npm must be in your PATH: '${NPM_BIN}' was not found." \
      "The React test tier needs npm ${NPM_VERSION} or greater; npm normally ships with Node.js (${node_path})." \
      "Install it, or set NPM_BIN to the executable you want to use, for example: NPM_BIN=/usr/local/bin/npm make test-web"
    return 1
  fi

  if ! node_have=$(kube::node::internal::binary_version "${node_path}"); then
    kube::node::internal::log_error \
      "'${node_path} --version' reported no usable version, so Node.js cannot be checked against the required ${NODE_VERSION}." \
      "Confirm that ${node_path} is a working Node.js binary, or set NODE_BIN to one that is."
    return 1
  fi
  if ! kube::node::internal::meets_floor "${node_have}" "${NODE_VERSION}"; then
    kube::node::internal::log_error \
      "Detected Node.js version: ${node_have} (${node_path})." \
      "The React test tier requires Node.js ${NODE_VERSION} or greater - that is the runtime it was verified against." \
      "Install Node.js ${NODE_VERSION} or later, or set NODE_BIN to a newer runtime." \
      "Set NODE_VERSION=<version> only if you deliberately accept an unverified runtime; the floor is never lowered automatically."
    return 1
  fi

  if ! npm_have=$(kube::node::internal::binary_version "${npm_path}"); then
    kube::node::internal::log_error \
      "'${npm_path} --version' reported no usable version, so npm cannot be checked against the required ${NPM_VERSION}." \
      "Confirm that ${npm_path} is a working npm binary, or set NPM_BIN to one that is."
    return 1
  fi
  if ! kube::node::internal::meets_floor "${npm_have}" "${NPM_VERSION}"; then
    kube::node::internal::log_error \
      "Detected npm version: ${npm_have} (${npm_path})." \
      "The React test tier requires npm ${NPM_VERSION} or greater - that is the version it was verified against." \
      "npm ships with Node.js ${node_have}, so upgrade Node.js, run 'npm install -g npm@${NPM_VERSION}', or set NPM_BIN to a newer npm." \
      "Set NPM_VERSION=<version> only if you deliberately accept an unverified npm; the floor is never lowered automatically."
    return 1
  fi

  # The validated runtime becomes the one every `env node` launcher resolves.
  if ! kube::node::internal::prepend_runtime_path; then
    kube::node::internal::log_error \
      "could not resolve the directory holding '${NODE_BIN}', so the validated runtime cannot be" \
      "put first on PATH." \
      "Set NODE_BIN to an executable path, for example NODE_BIN=/usr/local/bin/node."
    return 1
  fi

  V=4 kube::node::internal::log_info \
    "node ${node_have} (${node_path}) and npm ${npm_have} (${npm_path}) meet the >= ${NODE_VERSION} / >= ${NPM_VERSION} floors"
  return 0
}

# kube::node::ensure_deps installs exactly the dependency set
# ${KUBE_NODE_PACKAGE_LOCK} records into ${KUBE_WEB_DIR}. On return
# ${KUBE_WEB_DIR}/node_modules holds that set and is a symlink to a store
# outside the working tree, or an actionable message has been written to stderr,
# the status is non-zero, and no stamp claims a half-installed tree is good.
# ${PATH} is not modified and the caller's working directory is not changed.
#
# `npm ci` and never `npm install`. ci installs precisely what the lockfile
# records and fails when the lockfile and package.json disagree, whereas install
# would rewrite web/package-lock.json - so a test run could silently change the
# very file that makes the tier reproducible. There is deliberately no fallback
# from one to the other: an out-of-sync lockfile is a real defect to report, not
# something to paper over.
#
# The work is stamp-guarded, so `make verify` followed by `make test-web` does
# not reinstall (the hack/lib/etcd.sh L160-163 "already installed" pattern). The
# stamp is written only after a successful install, so any failure is retried.
kube::node::ensure_deps() {
  kube::node::dirs

  if [[ ! -d "${KUBE_WEB_DIR}" ]]; then
    kube::node::internal::log_error \
      "missing ${KUBE_WEB_DIR}: the React test tier directory does not exist, so there is nothing to install." \
      "Expected ${KUBE_NODE_PACKAGE_JSON} and ${KUBE_NODE_PACKAGE_LOCK}." \
      "Nothing was installed and nothing was changed. Set KUBE_WEB_DIR if the tier lives elsewhere."
    return 1
  fi

  if [[ ! -f "${KUBE_NODE_PACKAGE_JSON}" ]]; then
    kube::node::internal::log_error \
      "missing ${KUBE_NODE_PACKAGE_JSON}: npm has no manifest to install from." \
      "Nothing was installed and nothing was changed." \
      "Restore the file from version control, or set KUBE_WEB_DIR if the tier lives elsewhere."
    return 1
  fi

  if [[ ! -f "${KUBE_NODE_PACKAGE_LOCK}" ]]; then
    kube::node::internal::log_error \
      "missing ${KUBE_NODE_PACKAGE_LOCK}: 'npm ci' installs from the lockfile and cannot run without one." \
      "This step deliberately does NOT fall back to 'npm install', because that would write a new lockfile and destroy the reproducible install the tier depends on." \
      "Restore the lockfile from version control, or regenerate it deliberately with 'npm --prefix ${KUBE_WEB_DIR} install' and commit the result." \
      "Nothing was installed and nothing was changed."
    return 1
  fi

  local want stamp
  want=$(kube::node::internal::lockfile_hash) || want=""
  stamp=$(kube::node::internal::lockfile_stamp)

  # The FAST PATH, and the only thing that runs outside the lock: a tree whose stamp
  # matches AND whose installed packages still reconcile with the lockfile needs
  # nothing done to it, and must not queue behind another clone's install.
  if [[ -n "${want}" ]] && kube::node::internal::modules_present &&
    [[ -f "${stamp}" ]] && [[ "$(cat "${stamp}" 2>/dev/null)" == "${want}" ]]; then
    if kube::node::internal::tree_matches_lock; then
      V=4 kube::node::internal::log_info \
        "the locked npm dependency set from ${KUBE_NODE_PACKAGE_LOCK} is already installed"
      return 0
    fi
    kube::node::internal::log_status \
      "The stamp at ${stamp} matches but the installed packages do not; reinstalling"
  fi

  local store
  store=$(kube::node::module_store) || return 1
  kube::node::internal::with_lock "${store}.lock" \
    kube::node::internal::ensure_deps_locked "${want}" "${stamp}"
}

# kube::node::internal::ensure_deps_locked is the mutating body of
# kube::node::ensure_deps and must only be called while the provisioning lock for the
# store is held. $1 is the expected stamp value and $2 the stamp path. On return it
# guarantees exactly what kube::node::ensure_deps does.
kube::node::internal::ensure_deps_locked() {
  local want=${1:-}
  local stamp=${2:?a stamp path is required}

  # Re-checked under the lock: another process may have installed the same set while
  # this one waited.
  if [[ -n "${want}" ]] && kube::node::internal::modules_present &&
    [[ -f "${stamp}" ]] && [[ "$(cat "${stamp}" 2>/dev/null)" == "${want}" ]] &&
    kube::node::internal::tree_matches_lock; then
    V=4 kube::node::internal::log_info \
      "the locked npm dependency set was installed while this run waited"
    return 0
  fi

  kube::node::internal::log_status \
    "Installing the locked npm dependency set from ${KUBE_NODE_PACKAGE_LOCK}"

  # --prefix instead of a `cd`, so this never changes the caller's working
  # directory. --no-audit and --no-fund keep a provisioning step from making
  # extra registry calls and printing funding notices into a gate's output.
  # kube::node::exec so that npm - itself a `#!/usr/bin/env node` script - runs under
  # the runtime this library validated rather than whichever node ${PATH} finds first.
  #
  # BOUNDED TWICE OVER. --fetch-timeout and --fetch-retries bound each REQUEST and
  # give the better diagnostic, so they fire first; the outer timeout(1) ceiling
  # bounds the WHOLE install, which is the failure npm's per-request timers cannot
  # catch - a registry that answers every request slowly, or a postinstall lifecycle
  # script that never returns, keeps npm busy indefinitely without any single
  # request timing out.
  #
  # NESTING ORDER IS LOAD-BEARING: kube::node::exec is the OUTER call and the
  # bound is applied INSIDE it. timeout(1) is an external program, so it can
  # only execute an external command - handed the name of the kube::node::exec
  # shell function it exits 127 "command not found" and npm never runs at all.
  # This way kube::node::exec establishes the runtime ${PATH} first and timeout
  # then bounds the real npm binary underneath it, so both properties hold.
  local npm_rc=0
  kube::node::exec kube::node::internal::bounded "${KUBE_NODE_INSTALL_TIMEOUT}" \
    "${NPM_BIN}" --prefix "${KUBE_WEB_DIR}" ci \
      --no-audit --no-fund \
      --fetch-timeout "${KUBE_NODE_FETCH_TIMEOUT_MS}" \
      --fetch-retries "${KUBE_NODE_FETCH_RETRIES}" || npm_rc=$?
  if [[ "${npm_rc}" -ne 0 ]]; then
    kube::node::internal::log_error \
      "'${NPM_BIN} --prefix ${KUBE_WEB_DIR} ci' failed (exit ${npm_rc}), so the React test tier is not provisioned." \
      "This step needs network access to the npm registry." \
      "If the failure names an out-of-sync lockfile, then ${KUBE_NODE_PACKAGE_LOCK} and ${KUBE_NODE_PACKAGE_JSON} genuinely disagree and must be reconciled and committed; this step will not rewrite the lockfile for you." \
      "Nothing was recorded, so the install will be retried on the next run."
    # npm can leave a partial tree behind - and a TERMINATED npm almost certainly
    # does, since the ceiling can fire at any point in the extraction. Keep it out
    # of the working tree either way, because a real in-tree node_modules makes
    # hack/verify-boilerplate.sh walk 254 packages and fail, and leave no stamp
    # calling the tree good. `|| true` because this cleanup must not mask the
    # install failure that caused it.
    kube::node::externalize_modules || true
    # The EXACT status, not 1: 124/125/137 says the registry stalled, while npm's
    # own codes say the lockfile and manifest disagree. A caller that saw only 1
    # could not tell those apart.
    return "${npm_rc}"
  fi

  # npm has just replaced the symlink with a real in-tree directory.
  kube::node::externalize_modules || return 1

  if ! kube::node::internal::modules_present; then
    kube::node::internal::log_error \
      "'${NPM_BIN} ci' reported success but ${KUBE_NODE_MODULES_BIN} is still missing." \
      "Remove ${KUBE_WEB_DIR}/node_modules and re-run to install from scratch."
    return 1
  fi

  # The tree is reconciled AFTER the install as well as before it, so a stamp is only
  # ever written over a tree that has been shown to match the lockfile. Without this,
  # a partially applied install would be stamped as good and the fast path would
  # trust it on every subsequent run.
  if ! kube::node::internal::tree_matches_lock; then
    kube::node::internal::log_error \
      "the installed packages still do not match ${KUBE_NODE_PACKAGE_LOCK} after 'npm ci'" \
      "(the report above names each one)." \
      "Nothing was recorded, so the install will be retried. Remove ${KUBE_WEB_DIR}/node_modules" \
      "and re-run to install from scratch."
    return 1
  fi

  if [[ -n "${want}" ]] && ! echo "${want}" >"${stamp}" 2>/dev/null; then
    V=3 kube::node::internal::log_info \
      "could not record ${stamp}; the locked set will be reinstalled on the next run"
  fi

  V=3 kube::node::internal::log_info \
    "React test tier ready: the locked set from ${KUBE_NODE_PACKAGE_LOCK} is installed at ${KUBE_WEB_DIR}/node_modules"
  return 0
}

# kube::node::ensure_modules is the compatibility spelling of
# kube::node::ensure_deps, kept because hack/verify-web.sh and
# hack/make-rules/test-web.sh call it by that name. On return it guarantees
# exactly what kube::node::ensure_deps does.
kube::node::ensure_modules() {
  kube::node::ensure_deps
}

# kube::node::install provisions the React test tier: it checks the runtime and
# installs the locked dependency set. On return
# "${KUBE_NODE_MODULES_BIN}/vitest" is usable, or an actionable message has been
# written to stderr and the status is non-zero. ${PATH} is deliberately left
# alone - use kube::node::setup_env when you want it changed.
#
# This is the entry point this project's environment documentation publishes, so
# its name and behaviour are a contract.
kube::node::install() {
  kube::node::dirs
  kube::node::validate || return $?
  kube::node::ensure_deps
}

# kube::node::activate puts the tier's executables on ${PATH}. On return
# ${KUBE_NODE_MODULES_BIN} is the first ${PATH} entry and appears exactly once,
# so eslint, tsc and vitest resolve to the locked copies; otherwise an
# actionable message has been written and the status is non-zero with ${PATH}
# unchanged. It provisions nothing.
#
# Calling this twice, or sourcing this file twice, must not add a second copy of
# the directory to ${PATH}, so membership is tested before prepending.
kube::node::activate() {
  kube::node::dirs

  if ! kube::node::internal::modules_present; then
    kube::node::internal::log_error \
      "${KUBE_NODE_MODULES_BIN} does not exist, so the React test tier cannot be activated." \
      "Run 'kube::node::setup_env' (or 'make test-web') to provision it first."
    return 1
  fi

  if [[ ":${PATH}:" != *":${KUBE_NODE_MODULES_BIN}:"* ]]; then
    PATH="${KUBE_NODE_MODULES_BIN}:${PATH}"
    export PATH
    # Forget any executable this shell resolved before the change.
    hash -r 2>/dev/null || true
    V=3 kube::node::internal::log_info \
      "added the React test tier to PATH: ${KUBE_NODE_MODULES_BIN}"
  fi
  return 0
}

# kube::node::run runs the npm script named by $1 from ${KUBE_WEB_DIR}, passing
# any further arguments through. On return the script has run and its exit
# status is this function's status. It provisions nothing - call
# kube::node::install or kube::node::setup_env first - and it does not change the
# caller's working directory.
#
# Example: kube::node::run test -- --coverage
kube::node::run() {
  kube::node::dirs
  # Through kube::node::exec, so the script runs under the runtime this library
  # selected: npm and every launcher it invokes begin `#!/usr/bin/env node`.
  kube::node::exec "${NPM_BIN}" --prefix "${KUBE_WEB_DIR}" run "$@"
}

# kube::node::setup_env will check that a suitable Node.js and npm are available,
# install exactly the dependency set web/package-lock.json records, and put the
# tier's executables on ${PATH}. It is the single call a hack/ script needs, and
# it is safe to call repeatedly because every step short-circuits once
# satisfied. On failure the step that failed has written an actionable message to
# stderr and its status is returned unchanged.
#
# Outputs:
#   env-var KUBE_NODE_MODULES_BIN points at web/node_modules/.bin
#   env-var CI is true, so no npm or Vitest invocation prompts or starts a watcher
#   env-var PATH is prefixed with web/node_modules/.bin, exactly once
#   web/node_modules holds exactly what web/package-lock.json records, as a
#     symlink to a store outside the repository working tree
kube::node::setup_env() {
  kube::node::dirs
  kube::node::validate || return $?
  kube::node::ensure_deps || return $?
  kube::node::activate || return $?
  return 0
}

# Marker function to indicate node.sh has been fully sourced
kube::node::loaded() {
  return 0
}

# ex: ts=2 sw=2 et filetype=sh
