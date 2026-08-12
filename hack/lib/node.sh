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
#   kube::node::ensure_deps          install the locked set (stamp-guarded)
#   kube::node::activate             put web/node_modules/.bin on ${PATH}
#   kube::node::dirs                 resolve the KUBE_WEB_DIR / KUBE_NODE_* paths
#   kube::node::install              validate + ensure_deps
#   kube::node::ensure_modules       compatibility spelling of ensure_deps
#   kube::node::externalize_modules  keep web/node_modules a symlink out of tree
#   kube::node::module_store         echo where the real node_modules lives
#   kube::node::run                  run an npm script from web/
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
# symlink to it, because this repository's own gates walk the tree:
# skipped_names in hack/boilerplate/boilerplate.py does not list node_modules,
# so a real in-tree tree makes hack/verify-boilerplate.sh report every
# unlicensed file inside it (for instance node_modules/flatted/python/flatted.py)
# and exit 1. Neither os.walk() nor find(1) follows a symlinked directory, so
# the symlink keeps those gates green. .gitignore covers both spellings.
#
# The leaf MUST be named "node_modules": Node's resolver walks real paths, so a
# differently named leaf would stop sibling packages resolving.
#
# Set KUBE_NODE_MODULES_STORE to override. Setting it to
# ${KUBE_WEB_DIR}/node_modules materialises the tree in place, with no symlink,
# for a checkout that is not subject to those gates. CLONE_INDEX, when a
# parallel runner sets it, keeps concurrent clones from sharing (and deleting)
# one another's store.
KUBE_NODE_MODULES_STORE=${KUBE_NODE_MODULES_STORE:-}

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

# kube::node::internal::log_status writes a top-level status line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::status does. On
# return the line has been written or suppressed by verbosity, and the status is
# 0. Guarded for the same reason as log_error above.
kube::node::internal::log_status() {
  if [[ $(type -t kube::log::status) == function && -n "${KUBE_VERBOSE:-}" ]]; then
    kube::log::status "$@"
    return 0
  fi

  local message
  if (( ${KUBE_VERBOSE:-2} < ${V:-0} )); then
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
# return the line has been written or suppressed, and the status is 0.
kube::node::internal::log_info() {
  if [[ $(type -t kube::log::info) == function && -n "${KUBE_VERBOSE:-}" ]]; then
    kube::log::info "$@"
    return 0
  fi

  local message
  if (( ${KUBE_VERBOSE:-2} < ${V:-0} )); then
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

# kube::node::internal::safe_rm removes the path $1, refusing values that are
# obviously not ours. On return the path is gone, or nothing has been removed
# and the status is non-zero. `rm -rf` against an unexpected value is the one
# irreversible mistake a provisioner can make, so this guard is deliberate
# rather than defensive.
kube::node::internal::safe_rm() {
  local target=${1:-}

  case "${target}" in
    '' | '/' | '.' | '..' | '~' | '*')
      kube::node::internal::log_error \
        "refusing to remove the suspicious path '${target}'." \
        "This is a bug in hack/lib/node.sh or an unsafe KUBE_WEB_DIR / KUBE_NODE_MODULES_STORE value."
      return 1
      ;;
  esac

  rm -rf "${target}"
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
    "Relocating ${in_tree} to ${store} (keeps the repository's tree-walking gates green)"

  if ! mkdir -p "$(dirname "${store}")"; then
    kube::node::internal::log_error \
      "could not create $(dirname "${store}") to hold the node_modules tree." \
      "Set KUBE_NODE_MODULES_STORE to a writable directory outside the repository working tree."
    return 1
  fi

  # The freshly installed tree supersedes whatever the store held.
  kube::node::internal::safe_rm "${store}" || return 1

  if ! mv "${in_tree}" "${store}"; then
    kube::node::internal::log_error \
      "could not move ${in_tree} to ${store}." \
      "The dependency tree is still in the repository working tree, which makes hack/verify-boilerplate.sh walk it and fail." \
      "Move it aside by hand, or set KUBE_NODE_MODULES_STORE=${in_tree} to keep it in place deliberately."
    return 1
  fi

  if ! ln -sfn "${store}" "${in_tree}"; then
    kube::node::internal::log_error \
      "could not link ${in_tree} to ${store}, so the installed tree is no longer visible to npm or Node." \
      "Create the symlink by hand, or set KUBE_NODE_MODULES_STORE=${in_tree} and reinstall."
    return 1
  fi
  return 0
}

# kube::node::validate checks that this host can run the React test tier. On
# return node and npm are both present and at or above their required versions,
# or an actionable message naming the detected version, the required version and
# the fix has been written to stderr and the status is non-zero. Nothing is
# created, nothing is installed, no network is used and ${PATH} is untouched.
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

  if [[ -n "${want}" ]] && kube::node::internal::modules_present &&
    [[ -f "${stamp}" ]] && [[ "$(cat "${stamp}" 2>/dev/null)" == "${want}" ]]; then
    V=4 kube::node::internal::log_info \
      "the locked npm dependency set from ${KUBE_NODE_PACKAGE_LOCK} is already installed"
    return 0
  fi

  kube::node::internal::log_status \
    "Installing the locked npm dependency set from ${KUBE_NODE_PACKAGE_LOCK}"

  # --prefix instead of a `cd`, so this never changes the caller's working
  # directory. --no-audit and --no-fund keep a provisioning step from making
  # extra registry calls and printing funding notices into a gate's output.
  if ! "${NPM_BIN}" --prefix "${KUBE_WEB_DIR}" ci --no-audit --no-fund; then
    kube::node::internal::log_error \
      "'${NPM_BIN} --prefix ${KUBE_WEB_DIR} ci' failed, so the React test tier is not provisioned." \
      "This step needs network access to the npm registry." \
      "If the failure names an out-of-sync lockfile, then ${KUBE_NODE_PACKAGE_LOCK} and ${KUBE_NODE_PACKAGE_JSON} genuinely disagree and must be reconciled and committed; this step will not rewrite the lockfile for you." \
      "Nothing was recorded, so the install will be retried on the next run."
    # npm can leave a partial tree behind. Keep the tree-walking gates green by
    # externalising whatever is there, and leave no stamp calling it good.
    kube::node::externalize_modules || true
    return 1
  fi

  # npm has just replaced the symlink with a real in-tree directory.
  kube::node::externalize_modules || return 1

  if ! kube::node::internal::modules_present; then
    kube::node::internal::log_error \
      "'${NPM_BIN} ci' reported success but ${KUBE_NODE_MODULES_BIN} is still missing." \
      "Remove ${KUBE_WEB_DIR}/node_modules and re-run to install from scratch."
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
  "${NPM_BIN}" --prefix "${KUBE_WEB_DIR}" run "$@"
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
