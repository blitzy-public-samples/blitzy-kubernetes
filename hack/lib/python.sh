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

# A set of helpers for provisioning an isolated Python environment for tests
#
# AAP §0.5.1 (the hack/lib/python.sh row: "Virtual-environment creation plus
# pinned dependency install") / §0.8.1.5 (in scope) / §0.9.4.3 (why this is a
# library rather than a one-line `python -m venv`: python3-venv and python3-pip
# have no apt installation candidate in the target image, so the environment has
# to be created without pip and pip bootstrapped afterwards) / §0.3.4.3 and
# §0.6.1.3 (this script is the alternative to a pinned build/dependencies.yaml
# artifact, so no zeitgeist entry is required and
# hack/verify-external-dependencies-version.sh stays unaffected) /
# tech-spec §6.6.3.4 (the documentation convention this file follows).
#
# INVARIANT LOCKED BY THIS FILE: the Python (pytest) test tier always runs from
# an isolated virtual environment built from the hash-locked graph
# python/requirements-test.lock - which pins the exact manifest
# python/requirements-test.txt plus every transitive artifact by digest - never
# from the system interpreter, and provisioning converges on repeat invocation
# instead of accumulating.
#
# Three properties make that claim hold rather than merely state it:
#   * NOTHING UNVERIFIED IS EXECUTED. The pip bootstrap artifact is pinned by
#     version and digest, and the dependency install runs under
#     `pip --require-hashes`, so a substituted artifact fails the install.
#   * NOTHING UNOWNED IS DELETED. Every recursive removal goes through
#     kube::python::internal::safe_rm, which canonicalises the path, refuses the
#     repository, ${HOME}, filesystem roots and anything containing the checkout,
#     and requires this library's own ownership marker (or an empty directory, or a
#     pyvenv.cfg) before removing anything. KUBE_PYTHON_VENV and
#     KUBE_PYTHON_VENV_STORE are environment-controlled, so this is a gate rather
#     than a sanity check.
#   * NOTHING RACES. The mutating work is serialised with flock on a lock file
#     beside the store, because parallel clones and concurrent gates can reach one
#     store at once and an unserialised rebuild would delete a tree another
#     process is installing into.
#
# Modelled on hack/lib/etcd.sh: this file only defines variables and functions.
# It performs NO work when sourced - no validation, no environment creation, no
# install, no network access - and it deliberately does NOT set errexit,
# nounset or pipefail, because it is sourced into a caller's shell and must not
# change the caller's shell options. For the same reason it does not source
# hack/lib/init.sh: init.sh sets those three options *before* its own
# kube::init::loaded short-circuit, so even re-sourcing it would leak them into
# a caller that had not opted in.
#
# Usage:
#   source hack/lib/init.sh     # optional; supplies the kube::log::* and
#   source hack/lib/python.sh   # kube::util::* helpers used when available
#   kube::python::setup_env     # validate, create, install, and put on PATH
#   pytest ...                  # resolved from the virtual environment
#
# or, when ${PATH} must not be touched:
#   kube::python::dirs
#   kube::python::install
#   "${KUBE_PYTHON_VENV_BIN}/python" -m pytest ...
#
# PUBLIC API
#   kube::python::setup_env             validate + ensure_venv + install + activate
#   kube::python::validate              a suitable interpreter exists
#   kube::python::ensure_venv           create the isolated environment if absent
#   kube::python::install_requirements  install the hash-locked graph (stamp- and
#                                       graph-guarded, lock-serialised)
#   kube::python::activate              put the environment on ${PATH}
#   kube::python::dirs                  resolve the KUBE_PYTHON_* path variables
#   kube::python::install               ensure_venv + install_requirements
#   kube::python::create_venv           compatibility spelling of ensure_venv
#   kube::python::interpreter           echo the interpreter that builds the venv
#   kube::python::bin                   echo the virtual environment's python
#   kube::python::venv_store            echo where the real environment lives
#   kube::python::loaded                sourcing sentinel
#
# Two naming families are exposed on purpose, over one implementation.
# hack/verify-python.sh, hack/make-rules/test-python.sh and
# hack/make-rules/test-parity.sh call kube::python::dirs and
# kube::python::install and read ${KUBE_PYTHON_DIR} and ${KUBE_PYTHON_VENV_DIR};
# python/requirements-test.txt and python/pyproject.toml document
# KUBE_PYTHON_MIN_VERSION and KUBE_PYTHON_VERSION by name. Dropping either
# family would break `make verify`, `make test-python` and `make test-parity`,
# so both are maintained and kept in lockstep.

# Short-circuit if python.sh has already been sourced.
[[ $(type -t kube::python::loaded) == function ]] && return 0

# The root of the build/dist directory. This is the only variable this file
# introduces into a caller's environment when it is unset; the ${VAR:-default}
# form keeps it safe under `set -o nounset` and honours a caller that already
# resolved it (every caller that sourced hack/lib/init.sh has).
KUBE_ROOT="${KUBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"

# The interpreter used to build the virtual environment. Every Python shebang in
# this repository is `#!/usr/bin/env python3`, so python3 is the default.
PYTHON_BIN=${PYTHON_BIN:-python3}

# The MINIMUM Python version - the floor, not the version in use. 3.10 is
# pytest 9's floor: support for Python 3.9 was dropped after its end of life
# (AAP §0.2.2.1). Interpreters verified against this tier: 3.12.3 (AAP §0.3.3)
# and 3.12.13 (measured while writing this file).
# Never lower this to make provisioning succeed on an older interpreter; supply
# a newer interpreter instead. python/pyproject.toml and
# python/requirements-test.txt both name KUBE_PYTHON_MIN_VERSION, so the two
# spellings are kept in lockstep and either may be used as the override.
PYTHON_MIN_VERSION=${PYTHON_MIN_VERSION:-${KUBE_PYTHON_MIN_VERSION:-3.10}}
KUBE_PYTHON_MIN_VERSION=${KUBE_PYTHON_MIN_VERSION:-${PYTHON_MIN_VERSION}}

# The PREFERRED Python minor series to provision. The repository pins no Python
# version anywhere - there is no .python-version, tox.ini or setup.py - so this
# is the migration decision recorded in AAP §0.9.4.1 and referenced by
# python/pyproject.toml. It is a preference and not a requirement: any
# interpreter meeting PYTHON_MIN_VERSION is accepted, so an image without this
# exact series still provisions. See kube::python::interpreter.
KUBE_PYTHON_VERSION=${KUBE_PYTHON_VERSION:-3.12}

# Paths. These are resolved once here, the way hack/lib/etcd.sh resolves
# KUBE_INTEGRATION_ETCD_URL at source time, and are re-asserted by
# kube::python::dirs, which every entry point calls. Override them in the
# environment BEFORE sourcing this file.
KUBE_PYTHON_DIR=${KUBE_PYTHON_DIR:-${KUBE_ROOT}/python}
KUBE_PYTHON_VENV=${KUBE_PYTHON_VENV:-${KUBE_PYTHON_VENV_DIR:-${KUBE_PYTHON_DIR}/.venv}}
KUBE_PYTHON_VENV_DIR=${KUBE_PYTHON_VENV}
KUBE_PYTHON_REQUIREMENTS=${KUBE_PYTHON_REQUIREMENTS:-${KUBE_PYTHON_DIR}/requirements-test.txt}

# The fully resolved, hash-locked graph the environment is actually installed
# from. python/requirements-test.txt pins the 18 DIRECT distributions and
# documents why each is there; this file pins those plus every transitive one and
# records the digest of every artifact each pin may be satisfied by, so
# `pip install --require-hashes` refuses a substituted or tampered artifact
# instead of installing it. Exact direct pins cannot give that guarantee on their
# own, because 40 of the 58 distributions are selected transitively and are named
# nowhere in the manifest.
KUBE_PYTHON_LOCK=${KUBE_PYTHON_LOCK:-${KUBE_PYTHON_DIR}/requirements-test.lock}

# Installing WITHOUT the lock - and therefore without hash checking - has to be
# asked for explicitly. It exists for one legitimate case: a caller who pointed
# KUBE_PYTHON_REQUIREMENTS at a manifest of their own, for which no lock has been
# generated. It is never the default, and it always warns.
KUBE_PYTHON_ALLOW_UNLOCKED=${KUBE_PYTHON_ALLOW_UNLOCKED:-n}

# The one derived value callers need, exported so that hack/verify-python.sh and
# hack/make-rules/test-python.sh can invoke ruff, mypy and pytest by absolute
# path without depending on ${PATH} ordering (the hack/lib/etcd.sh L26 pattern).
export KUBE_PYTHON_VENV_BIN="${KUBE_PYTHON_VENV}/bin"

# Where the REAL virtual environment is materialised. It lives OUTSIDE the
# repository working tree by default and ${KUBE_PYTHON_VENV} is a symlink to it,
# because a third-party dependency tree inside the working tree is visible to
# every tool that walks it. hack/boilerplate/boilerplate.py now skips
# python/.venv explicitly, so hack/verify-boilerplate.sh alone would be satisfied
# by an in-tree environment; the store stays out of tree for the broader reasons
# that survive that skip - `find`-based helpers, editor and grep-based tooling,
# `git status` noise, and the several thousand third-party files a reviewer would
# otherwise have to reason about. Neither os.walk() nor find(1) follows a
# symlinked directory, so the symlink keeps all of them looking at the tier
# itself. .gitignore covers both spellings, and python/pyproject.toml records the
# same decision from the other side.
#
# Set KUBE_PYTHON_VENV_STORE to override. Setting it to ${KUBE_PYTHON_VENV}
# creates the environment in place, with no symlink, for callers whose tree is
# not subject to those tools. CLONE_INDEX, when a parallel runner sets it, keeps
# concurrent clones from sharing (and deleting) one another's store.
KUBE_PYTHON_VENV_STORE=${KUBE_PYTHON_VENV_STORE:-}

# The pip that is bootstrapped into the freshly created (and deliberately
# pip-less) environment, pinned by VERSION and by DIGEST as a pair.
#
# It is a pair on purpose: the version alone names a mutable download, and this
# step executes what it downloads. The digest is what makes the artifact
# immutable, so overriding KUBE_PYTHON_PIP_VERSION REQUIRES overriding
# KUBE_PYTHON_PIP_SHA256 in the same breath - a version bump with a stale digest
# fails closed rather than installing something unverified.
#
# 26.2.1 is the measured version of the environment this tier was verified in.
KUBE_PYTHON_PIP_VERSION=${KUBE_PYTHON_PIP_VERSION:-26.2.1}
KUBE_PYTHON_PIP_SHA256=${KUBE_PYTHON_PIP_SHA256:-71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e}

# A local copy of that wheel, preferred over any download when it is present and
# its digest matches. This is the offline and air-gapped path: an image that
# pre-seeds the artifact never reaches the network at all.
KUBE_PYTHON_PIP_WHEEL=${KUBE_PYTHON_PIP_WHEEL:-}

# Where that wheel is fetched from when no local copy is available. Derived from
# the pinned version rather than written out, so the two cannot drift, and
# verified against KUBE_PYTHON_PIP_SHA256 before anything executes it. An
# override must be an https:// URL; see kube::python::internal::pip_wheel_url.
KUBE_PYTHON_PIP_URL=${KUBE_PYTHON_PIP_URL:-}

# How long to wait for another process's provisioning to finish before giving up,
# in seconds. Provisioning is serialised with flock (see
# kube::python::internal::with_lock) because several clones and several gates can
# reach the same store at once, and an unserialised rebuild would let one process
# delete a tree another is installing into.
KUBE_PYTHON_LOCK_TIMEOUT=${KUBE_PYTHON_LOCK_TIMEOUT:-600}

# The file that marks a directory as belonging to THIS library. Removal requires
# it (see kube::python::internal::safe_rm), which is what makes "delete the store
# and start again" incapable of deleting a directory this library did not create.
KUBE_PYTHON_STORE_MARKER_NAME=".kube-python-store"

# kube::python::internal::log_error writes an actionable, ERROR:-prefixed
# message to stderr. On return the message has been written and nothing else has
# changed; the status is always 0 so callers control their own exit code.
#
# It prefers this repository's kube::log::usage and falls back to a plain echo,
# because a consumer may have sourced only this file: kube::log::usage is safe
# on its own, but kube::log::info and kube::log::status both evaluate
# `(( KUBE_VERBOSE < V ))` and die with "KUBE_VERBOSE: unbound variable" under
# `set -o nounset` when hack/lib/logging.sh was never sourced.
kube::python::internal::log_error() {
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

# kube::python::internal::level echoes the verbosity level $1 when it is a plain
# decimal integer, and the fallback $2 otherwise. On return one decimal integer
# has been printed and nothing has been modified.
#
# This exists because ${KUBE_VERBOSE} and ${V} are ENVIRONMENT-CONTROLLED and
# were previously interpolated straight into `(( ... ))`. Bash arithmetic
# EVALUATES its operands, so a value such as `x[$(...)]` executes the command
# substitution inside it - a read-only log call became an execution path. Every
# comparison below therefore runs on a validated digit string, and the raw value
# is never handed to an arithmetic context.
kube::python::internal::level() {
  local raw=${1:-}
  local fallback=${2:?a fallback level is required}

  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    echo "${raw}"
  else
    echo "${fallback}"
  fi
}

# kube::python::internal::verbosity_is_sane succeeds when ${KUBE_VERBOSE} and ${V}
# are either unset/empty or plain decimal integers. On return the status says so
# and nothing has been modified.
#
# It gates DELEGATION to kube::log::info and kube::log::status, which evaluate
# `(( KUBE_VERBOSE < V ))` themselves (hack/lib/logging.sh): passing an unvalidated
# value on to them would simply move the arithmetic-evaluation problem one file
# away instead of closing it.
kube::python::internal::verbosity_is_sane() {
  [[ -z "${KUBE_VERBOSE:-}" || "${KUBE_VERBOSE:-}" =~ ^[0-9]+$ ]] || return 1
  [[ -z "${V:-}" || "${V:-}" =~ ^[0-9]+$ ]] || return 1
  return 0
}

# kube::python::internal::level_suppresses succeeds when the current ${V} exceeds
# the current ${KUBE_VERBOSE}, i.e. when a message at that level must be
# suppressed. On return the status says so and nothing has been modified. Both
# values are validated before any arithmetic runs.
kube::python::internal::level_suppresses() {
  local verbose level
  verbose=$(kube::python::internal::level "${KUBE_VERBOSE:-}" 2)
  level=$(kube::python::internal::level "${V:-}" 0)

  (( verbose < level ))
}

# kube::python::internal::log_status writes a top-level status line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::status does. On
# return the line has been written or suppressed by verbosity, and the status is
# 0. Guarded for the same reason as log_error above, and additionally guarded on
# the two verbosity variables being sane integers.
kube::python::internal::log_status() {
  if [[ $(type -t kube::log::status) == function && -n "${KUBE_VERBOSE:-}" ]] &&
    kube::python::internal::verbosity_is_sane; then
    kube::log::status "$@"
    return 0
  fi

  local message
  if kube::python::internal::level_suppresses; then
    return 0
  fi
  for message in "$@"; do
    echo "+++ ${message}"
  done
  return 0
}

# kube::python::internal::log_info writes a non-top-level line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::info does, so
# `V=4 kube::python::internal::log_info ...` stays quiet on a normal run. On
# return the line has been written or suppressed, and the status is 0. Guarded on
# sane verbosity values for the reason verbosity_is_sane gives.
kube::python::internal::log_info() {
  if [[ $(type -t kube::log::info) == function && -n "${KUBE_VERBOSE:-}" ]] &&
    kube::python::internal::verbosity_is_sane; then
    kube::log::info "$@"
    return 0
  fi

  local message
  if kube::python::internal::level_suppresses; then
    return 0
  fi
  for message in "$@"; do
    echo "${message}"
  done
  return 0
}

# kube::python::internal::version turns dotted version strings into zero-padded
# sortable integers, one per line, so they can be compared with -gt and -lt. On
# return each argument has been printed in that form. Taken from
# kube::etcd::version (hack/lib/etcd.sh L72-74) so that version comparison
# behaves identically across this repository's provisioners.
kube::python::internal::version() {
  printf '%s\n' "${@}" | awk -F . '{ printf("%d%03d%03d\n", $1, $2, $3) }'
}

# kube::python::internal::interpreter_version echoes the "X.Y.Z" version of the
# interpreter named by $1. On return the version has been printed, or nothing
# has been printed and the status is non-zero because $1 could not report one.
# The interpreter is asked directly rather than parsed out of `python -V`, so
# pre-release and vendor-suffixed builds cannot confuse the comparison.
kube::python::internal::interpreter_version() {
  "${1}" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null
}

# kube::python::internal::meets_floor succeeds when the "X.Y.Z" version $1 is at
# or above PYTHON_MIN_VERSION. On return the status says so and nothing has been
# modified.
#
# Every interpreter-selection pass runs through this, including the passes that
# match the preferred KUBE_PYTHON_VERSION series: the floor is a boundary
# condition, so raising PYTHON_MIN_VERSION above KUBE_PYTHON_VERSION must reject
# the preferred series rather than silently accept an interpreter below the floor.
kube::python::internal::meets_floor() {
  local full=${1:-}

  [[ -n "${full}" ]] || return 1
  [[ $(kube::python::internal::version "${PYTHON_MIN_VERSION}") -le $(kube::python::internal::version "${full}") ]]
}

# kube::python::internal::canonical echoes the absolute, symlink-resolved form of
# the path $1, whether or not it exists. On return one absolute path has been
# printed, or nothing has been printed and the status is non-zero because the
# path is empty or its parent cannot be resolved.
#
# Every safety decision below is taken on the CANONICAL path, never on the string
# a caller supplied: `${store}/../../..`, `python/.venv/..` and a symlink to `/`
# all name something entirely different from what they look like, and a guard
# that compares strings is defeated by each of them.
kube::python::internal::canonical() {
  local path=${1:-}

  [[ -n "${path}" ]] || return 1

  if [[ -d "${path}" ]]; then
    (cd "${path}" 2>/dev/null && pwd -P) && return 0
    return 1
  fi

  # A path that does not exist yet (or is a symlink to nothing): resolve the
  # deepest existing ancestor and re-attach the remainder, so the result is still
  # absolute and still free of `..` and symlinks.
  local parent leaf resolved
  parent=$(dirname "${path}")
  leaf=$(basename "${path}")
  if [[ "${parent}" == "${path}" ]]; then
    echo "${path}"
    return 0
  fi
  resolved=$(kube::python::internal::canonical "${parent}") || return 1
  echo "${resolved%/}/${leaf}"
}

# kube::python::internal::is_ancestor succeeds when the canonical path $1 is $2 or
# contains it. On return the status says so and nothing has been modified. Used to
# refuse a removal target that would take the repository, ${HOME} or a filesystem
# root with it.
kube::python::internal::is_ancestor() {
  local candidate=${1:-}
  local descendant=${2:-}

  [[ -n "${candidate}" && -n "${descendant}" ]] || return 1
  [[ "${candidate}" == "${descendant}" || "${descendant}" == "${candidate%/}/"* ]]
}

# kube::python::internal::assert_removable succeeds when the path $1 is one this
# library may recursively remove. On return the status says so; a refusal has
# written an actionable message and removed nothing.
#
# `rm -rf` against an unexpected value is the one irreversible mistake a
# provisioner can make, and both KUBE_PYTHON_VENV and KUBE_PYTHON_VENV_STORE are
# environment-controlled, so this is a hard gate rather than a sanity check. Four
# conditions, all required:
#
#   1. the canonical path is not a filesystem root and has at least two
#      components, so `/`, `/opt` and `/home` can never be targets;
#   2. it is neither ${HOME}, nor the repository root, nor an ANCESTOR of the
#      repository root - a store that contained the checkout would take the
#      checkout with it;
#   3. it is not inside the repository working tree, with exactly one exception:
#      ${KUBE_PYTHON_VENV} itself, which is the in-tree path this library owns;
#   4. it carries this library's ownership marker, OR it is an empty directory, OR
#      it is a virtual environment (it has a pyvenv.cfg). A directory that is none
#      of those three belongs to somebody else and is refused.
kube::python::internal::assert_removable() {
  local target=${1:-}
  local what=${2:-the path}

  local canonical
  if ! canonical=$(kube::python::internal::canonical "${target}"); then
    kube::python::internal::log_error \
      "refusing to remove ${what} '${target}': it could not be resolved to an absolute path." \
      "This is a bug in hack/lib/python.sh or an unsafe KUBE_PYTHON_VENV / KUBE_PYTHON_VENV_STORE value."
    return 1
  fi

  # 1. depth. "/x" has one component and is still too close to the root to be a
  # plausible dependency store; two is the shallowest this library ever creates.
  local trimmed=${canonical#/}
  if [[ "${canonical}" != /* || -z "${trimmed}" || "${trimmed}" != */* ]]; then
    kube::python::internal::log_error \
      "refusing to remove ${what} '${canonical}': it is a filesystem root or too close to one." \
      "Set KUBE_PYTHON_VENV_STORE to a dedicated directory such as /opt/blitzy/venv/k8s-python-tier."
    return 1
  fi

  # 2. never ${HOME}, the repository, or anything containing the repository.
  local repo_root home_dir
  repo_root=$(kube::python::internal::canonical "${KUBE_ROOT}") || repo_root=""
  home_dir=$(kube::python::internal::canonical "${HOME:-/nonexistent}") || home_dir=""
  if [[ -n "${home_dir}" && "${canonical}" == "${home_dir}" ]] ||
    { [[ -n "${repo_root}" ]] && kube::python::internal::is_ancestor "${canonical}" "${repo_root}"; }; then
    kube::python::internal::log_error \
      "refusing to remove ${what} '${canonical}': it is your home directory, the repository root," \
      "or a directory that CONTAINS the repository at '${repo_root}'." \
      "Set KUBE_PYTHON_VENV_STORE to a dedicated directory outside the working tree."
    return 1
  fi

  # 3. inside the working tree, only the one path this library owns.
  local venv_canonical
  venv_canonical=$(kube::python::internal::canonical "${KUBE_PYTHON_VENV}") || venv_canonical=""
  if [[ -n "${repo_root}" ]] &&
    kube::python::internal::is_ancestor "${repo_root}" "${canonical}" &&
    [[ "${canonical}" != "${venv_canonical}" ]]; then
    kube::python::internal::log_error \
      "refusing to remove ${what} '${canonical}': it is inside the repository working tree" \
      "and is not the virtual-environment path '${venv_canonical}' this library owns." \
      "Nothing was removed."
    return 1
  fi

  # 4. ownership. Absent is fine - there is nothing to remove.
  if [[ ! -e "${canonical}" ]]; then
    return 0
  fi
  if [[ -f "${canonical}/${KUBE_PYTHON_STORE_MARKER_NAME}" || -f "${canonical}/pyvenv.cfg" ]]; then
    return 0
  fi
  if [[ -d "${canonical}" ]] && [[ -z "$(ls -A "${canonical}" 2>/dev/null)" ]]; then
    return 0
  fi

  kube::python::internal::log_error \
    "refusing to remove ${what} '${canonical}': it is not empty, it is not a virtual environment" \
    "(no pyvenv.cfg) and it carries no '${KUBE_PYTHON_STORE_MARKER_NAME}' marker, so this library did not create it." \
    "Move it aside by hand if you meant to replace it, or point KUBE_PYTHON_VENV_STORE somewhere else." \
    "Nothing was removed."
  return 1
}

# kube::python::internal::mark_store records this library's ownership of the
# directory $1 by writing ${KUBE_PYTHON_STORE_MARKER_NAME} into it. On return the
# marker exists, or it does not and the status is non-zero. The marker is what
# later removals require, so writing it is part of creating a store rather than
# an afterthought.
kube::python::internal::mark_store() {
  local store=${1:?a store path is required}

  [[ -d "${store}" ]] || return 1
  {
    echo "# Created by hack/lib/python.sh for the Kubernetes Python (pytest) test tier."
    echo "# Its presence is what permits this library to remove and rebuild this directory."
    echo "# Delete the directory rather than this file if you want it rebuilt from scratch."
    echo "repository=${KUBE_ROOT}"
    echo "clone_index=${CLONE_INDEX:-}"
  } >"${store}/${KUBE_PYTHON_STORE_MARKER_NAME}" 2>/dev/null || return 1
  return 0
}

# kube::python::internal::safe_rm removes the directory tree $1 after
# kube::python::internal::assert_removable has approved it. On return the path is
# gone, or nothing has been removed and the status is non-zero.
kube::python::internal::safe_rm() {
  local target=${1:-}
  local what=${2:-the path}

  kube::python::internal::assert_removable "${target}" "${what}" || return 1

  local canonical
  canonical=$(kube::python::internal::canonical "${target}") || return 1
  rm -rf "${canonical}"
}

# kube::python::internal::with_lock runs the function named by $2 (with any
# further arguments) while holding an exclusive lock on the file $1. On return the
# function has run and its status is this function's status, or the lock could not
# be taken within ${KUBE_PYTHON_LOCK_TIMEOUT} seconds and the status is non-zero.
#
# Provisioning MUTATES a store that several processes can reach at once - parallel
# clones sharing one store, `make verify` and `make test-python` racing, a second
# gate starting while the first installs. Without serialisation one process can
# delete or rebuild the tree another is installing into, which is a corrupt
# environment that reports success. The body runs in a subshell holding the lock
# on a dedicated file descriptor, the canonical flock idiom; every effect this
# library has is on the filesystem, so nothing is lost by the subshell.
#
# flock is not universally present. When it is missing the work still runs, and
# says once that it is unserialised, because refusing to provision at all would
# be a worse outcome than provisioning without the guard.
kube::python::internal::with_lock() {
  local lockfile=${1:?a lock file path is required}
  shift

  if ! command -v flock >/dev/null 2>&1; then
    V=3 kube::python::internal::log_info \
      "flock is not available, so provisioning is not serialised; a concurrent run could race"
    "$@"
    return $?
  fi

  if ! mkdir -p "$(dirname "${lockfile}")" 2>/dev/null; then
    V=3 kube::python::internal::log_info \
      "could not create $(dirname "${lockfile}") for the provisioning lock; continuing unserialised"
    "$@"
    return $?
  fi

  local timeout
  timeout=$(kube::python::internal::level "${KUBE_PYTHON_LOCK_TIMEOUT}" 600)

  (
    if ! flock -w "${timeout}" 9; then
      kube::python::internal::log_error \
        "timed out after ${timeout}s waiting for the Python provisioning lock ${lockfile}." \
        "Another process is provisioning the same environment. Wait for it to finish, or set" \
        "KUBE_PYTHON_VENV_STORE to a store of your own (CLONE_INDEX does this automatically for" \
        "parallel clones)."
      exit 1
    fi
    "$@"
  ) 9>"${lockfile}"
}

# kube::python::internal::venv_usable succeeds when $1 is a virtual environment
# this library can install into: its interpreter is executable and pip works
# inside it. On return the status says so and nothing has been modified. Testing
# pip rather than only the interpreter matters because the environment is
# created with --without-pip, so "interpreter present" alone does not mean the
# environment is finished.
kube::python::internal::venv_usable() {
  local venv=${1:-}

  [[ -n "${venv}" ]] || return 1
  [[ -x "${venv}/bin/python" ]] || return 1
  "${venv}/bin/python" -m pip --version >/dev/null 2>&1
}

# kube::python::internal::requirements_hash echoes a SHA-256 over the pinned
# manifest AND the hash-locked graph. On return the hash has been printed, or
# nothing has been printed and the status is non-zero because the manifest is
# missing or no hashing utility is available. A missing hash is not an error for
# callers: it only means the install step cannot be skipped and will simply run
# again.
#
# BOTH files, concatenated, because the environment is installed from the lock and
# cross-checked against the manifest: a stamp over the manifest alone would let an
# edited lock be mistaken for the installed one.
kube::python::internal::requirements_hash() {
  [[ -f "${KUBE_PYTHON_REQUIREMENTS}" ]] || return 1

  local -a inputs=("${KUBE_PYTHON_REQUIREMENTS}")
  [[ -f "${KUBE_PYTHON_LOCK}" ]] && inputs+=("${KUBE_PYTHON_LOCK}")

  if command -v sha256sum >/dev/null 2>&1; then
    cat "${inputs[@]}" | sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    cat "${inputs[@]}" | shasum -a 256 | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    cat "${inputs[@]}" | openssl dgst -sha256 | awk '{ print $NF }'
  else
    return 1
  fi
}

# kube::python::internal::graph_matches succeeds when the distributions installed
# in ${KUBE_PYTHON_VENV} are exactly what the manifest and the lock describe. On
# return the status says so; a mismatch has written a report naming every offender
# and nothing has been modified.
#
# THIS IS WHAT THE STAMP FAST PATH IS WORTH. A stamp records only that some run
# once installed from files with this hash; it says nothing about what is in the
# environment NOW. A store that was hand-modified, partially upgraded by another
# tool, or warmed by a previous batch from a different lock would keep its stamp
# and quietly run a different toolchain than the one every gate reports. So the
# fast path asserts the graph itself, and a mismatch rebuilds instead of trusting
# the stamp.
#
# Four assertions, chosen so that no environment-marker evaluation is needed - the
# lock is a forked, universal resolution and evaluating its markers here would
# duplicate a resolver:
#   1. every DIRECT pin in the manifest appears in the lock at the same version
#      (the two files agree - otherwise the lock is stale and must be regenerated);
#   2. every direct pin is installed at exactly that version;
#   3. every UNCONDITIONAL lock entry (no marker, so it applies to every
#      interpreter) is installed;
#   4. every installed distribution the lock names is at one of the versions the
#      lock records for it.
# Distributions the lock does not name at all are ignored, because a virtual
# environment legitimately carries seed packages (pip, setuptools, wheel) that are
# no part of this tier's graph.
kube::python::internal::graph_matches() {
  local venv_python="${KUBE_PYTHON_VENV_BIN}/python"

  [[ -x "${venv_python}" ]] || return 1
  [[ -f "${KUBE_PYTHON_REQUIREMENTS}" ]] || return 1
  [[ -f "${KUBE_PYTHON_LOCK}" ]] || return 1

  "${venv_python}" - "${KUBE_PYTHON_REQUIREMENTS}" "${KUBE_PYTHON_LOCK}" <<'PYTHON_GRAPH_CHECK'
"""Compare the installed distribution graph with the manifest and the lock.

Called by kube::python::internal::graph_matches in hack/lib/python.sh. Prints one
line per offender to stderr and exits 1; prints nothing and exits 0 when the
environment matches. Uses only the standard library, so it runs in an environment
that has nothing installed yet.
"""

import re
import sys
from importlib import metadata

PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;#\\]+)\s*(?:;\s*(.*?))?\s*\\?$")


def normalise(name):
    """PEP 503 normalisation, so PyJWT, pyjwt and py_jwt compare equal."""
    return re.sub(r"[-_.]+", "-", name).lower()


def pins(path):
    """Yield (normalised name, version, marker) for every pin in a requirements file."""
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.startswith("--"):
                continue
            match = PIN.match(stripped)
            if match:
                yield normalise(match.group(1)), match.group(2), (match.group(3) or "").strip()


manifest_path, lock_path = sys.argv[1], sys.argv[2]

direct = {}
for name, version, _ in pins(manifest_path):
    direct.setdefault(name, version)

locked = {}
unconditional = {}
for name, version, marker in pins(lock_path):
    locked.setdefault(name, set()).add(version)
    if not marker:
        unconditional.setdefault(name, version)

installed = {}
for distribution in metadata.distributions():
    raw = distribution.metadata["Name"]
    if raw:
        installed[normalise(raw)] = distribution.version

problems = []

for name, version in sorted(direct.items()):
    if name not in locked:
        problems.append(
            f"{name}=={version} is pinned in the manifest but absent from the lock"
        )
    elif version not in locked[name]:
        problems.append(
            f"{name}: manifest pins {version}, lock records "
            f"{sorted(locked[name])} - the lock is stale"
        )
    if name not in installed:
        problems.append(f"{name}=={version} is pinned but NOT installed")
    elif installed[name] != version:
        problems.append(f"{name}: installed {installed[name]}, pinned {version}")

for name, version in sorted(unconditional.items()):
    if name not in direct and name not in installed:
        problems.append(f"{name}=={version} is locked unconditionally but NOT installed")

for name, version in sorted(installed.items()):
    if name in locked and version not in locked[name]:
        problems.append(
            f"{name}: installed {version}, lock records {sorted(locked[name])}"
        )

if problems:
    print(
        "the installed Python distributions do not match "
        f"{manifest_path} and {lock_path}:",
        file=sys.stderr,
    )
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    sys.exit(1)
PYTHON_GRAPH_CHECK
}

# kube::python::internal::requirements_stamp echoes the path of the file that
# records which manifest the environment was last built from. On return the path
# has been printed; the file itself may or may not exist. It lives inside the
# environment so that deleting the environment discards the record with it, and
# so that nothing is written into the repository working tree.
kube::python::internal::requirements_stamp() {
  echo "${KUBE_PYTHON_VENV}/.requirements.sha256"
}

# kube::python::internal::pip_wheel_name echoes the canonical file name of the
# pinned pip wheel. On return that name has been printed. The name is not
# cosmetic: pip refuses to install a wheel whose file name is not a valid wheel
# name ("Invalid wheel filename (wrong number of parts)"), so a downloaded copy
# has to be saved under exactly this name.
kube::python::internal::pip_wheel_name() {
  echo "pip-${KUBE_PYTHON_PIP_VERSION}-py3-none-any.whl"
}

# kube::python::internal::pip_wheel_url echoes the URL the pinned pip wheel is
# fetched from. On return one https:// URL has been printed, or nothing has been
# printed and the status is non-zero because an override was unusable.
#
# The default is DERIVED from ${KUBE_PYTHON_PIP_VERSION} so the URL and the
# version cannot drift apart. An override is treated as DATA: it must be an
# https:// URL and must not look like a command-line option, so it cannot smuggle
# a flag into the fetch. It is not trusted beyond that - whatever arrives is
# checked against ${KUBE_PYTHON_PIP_SHA256} before anything runs it, which is what
# makes an override safe to offer at all.
kube::python::internal::pip_wheel_url() {
  local override=${KUBE_PYTHON_PIP_URL:-}

  if [[ -z "${override}" ]]; then
    echo "https://files.pythonhosted.org/packages/py3/p/pip/$(kube::python::internal::pip_wheel_name)"
    return 0
  fi

  if [[ "${override}" == -* ]]; then
    kube::python::internal::log_error \
      "refusing the KUBE_PYTHON_PIP_URL value '${override}': it starts with '-' and would be read as an option." \
      "Pass a plain https:// URL."
    return 1
  fi
  if [[ "${override}" != https://* ]]; then
    kube::python::internal::log_error \
      "refusing the KUBE_PYTHON_PIP_URL value '${override}': the pip bootstrap artifact must be fetched over https." \
      "Pass an https:// URL, or pre-seed the wheel locally and point KUBE_PYTHON_PIP_WHEEL at it."
    return 1
  fi
  echo "${override}"
}

# kube::python::internal::sha256 echoes the SHA-256 of the file $1. On return the
# digest has been printed in lower case, or nothing has been printed and the
# status is non-zero because no hashing utility is available.
kube::python::internal::sha256() {
  local file=${1:?a file is required}

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${file}" | awk '{ print $NF }'
  else
    return 1
  fi
}

# kube::python::internal::verify_digest succeeds when the file $1 hashes to
# ${KUBE_PYTHON_PIP_SHA256}. On return the status says so; a mismatch has written
# an actionable message. A host with no hashing utility CANNOT verify, and that is
# treated as a failure rather than waved through: an unverified artifact is
# exactly what this check exists to refuse.
kube::python::internal::verify_digest() {
  local file=${1:?a file is required}
  local what=${2:-the artifact}

  local actual
  if ! actual=$(kube::python::internal::sha256 "${file}"); then
    kube::python::internal::log_error \
      "cannot verify ${what}: no sha256sum, shasum or openssl was found on this host." \
      "The pip bootstrap artifact is only used when its digest matches ${KUBE_PYTHON_PIP_SHA256}," \
      "so install one of those utilities, or pre-seed a verified wheel with KUBE_PYTHON_PIP_WHEEL."
    return 1
  fi
  if [[ "${actual}" != "${KUBE_PYTHON_PIP_SHA256}" ]]; then
    kube::python::internal::log_error \
      "digest mismatch for ${what} (${file})." \
      "expected sha256 ${KUBE_PYTHON_PIP_SHA256}" \
      "actual   sha256 ${actual}" \
      "Nothing was executed. If you deliberately changed KUBE_PYTHON_PIP_VERSION, set" \
      "KUBE_PYTHON_PIP_SHA256 to that release's published digest in the same change; a version" \
      "bump with a stale digest is meant to fail here rather than install something unverified."
    return 1
  fi
  return 0
}

# kube::python::internal::bootstrap_pip installs pip into the virtual
# environment rooted at $1. On return `python -m pip` works inside that
# environment, or an actionable message has been written to stderr, the status
# is non-zero, and pip is still absent.
#
# INVARIANT LOCKED BY THIS FUNCTION: nothing is executed that has not been
# verified against a committed digest. This step runs code from outside the
# repository into a fresh environment, which makes it the one place in this
# library where a supply-chain substitution would go unnoticed, so the artifact is
# pinned by VERSION and DIGEST as a pair and a mismatch is fatal.
#
# Three paths, in order of decreasing trust:
#   1. ensurepip - bundled with the interpreter, needs no network and no digest
#      check because nothing was fetched. Its failure is deliberately NOT fatal:
#      the target image ships the ensurepip module but not its bundled wheel
#      (observed: FileNotFoundError ... ensurepip/_bundled/pip-*.whl), which is
#      the missing-python3-pip gap AAP §0.9.4.3 records. That is also why the
#      environment is created with --without-pip - a plain `python -m venv` runs
#      ensurepip internally and fails outright on such an image.
#   2. a LOCAL copy of the pinned wheel, named by ${KUBE_PYTHON_PIP_WHEEL}. This
#      is the offline and air-gapped path: an image that pre-seeds the artifact
#      never reaches the network. Still digest-checked, because "local" is not
#      the same as "verified".
#   3. the pinned wheel, fetched over https, digest-checked, then installed with
#      --no-index so the installation itself resolves nothing further.
#
# The wheel is executed by running pip from INSIDE the wheel
# (`python <wheel>/pip install --no-index <wheel>`), which is pip's own documented
# way to install itself into an environment that has no pip. A `get-pip.py`
# executed straight from a mutable, versionless URL is what this replaces.
kube::python::internal::bootstrap_pip() {
  local venv=${1:?a virtual environment path is required}
  local venv_python="${venv}/bin/python"

  if "${venv_python}" -m pip --version >/dev/null 2>&1; then
    V=4 kube::python::internal::log_info "pip is already present in ${venv}"
    return 0
  fi

  if "${venv_python}" -m ensurepip --upgrade --default-pip >/dev/null 2>&1; then
    V=3 kube::python::internal::log_info "bootstrapped pip into ${venv} with ensurepip"
    return 0
  fi
  V=3 kube::python::internal::log_info \
    "ensurepip could not provide pip (no bundled wheel in this image); using the pinned pip ${KUBE_PYTHON_PIP_VERSION} wheel"

  local tmpdir
  if ! tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t kube-python.XXXXXX); then
    kube::python::internal::log_error \
      "could not create a temporary directory for the pip bootstrap artifact." \
      "Check that \${TMPDIR:-/tmp} exists and is writable."
    return 1
  fi

  local wheel_name wheel source_description
  wheel_name=$(kube::python::internal::pip_wheel_name)
  wheel="${tmpdir}/${wheel_name}"

  if [[ -n "${KUBE_PYTHON_PIP_WHEEL}" ]]; then
    if [[ ! -f "${KUBE_PYTHON_PIP_WHEEL}" ]]; then
      kube::python::internal::log_error \
        "KUBE_PYTHON_PIP_WHEEL is set to '${KUBE_PYTHON_PIP_WHEEL}', which is not a file." \
        "Point it at a local copy of ${wheel_name}, or unset it to fetch the pinned wheel."
      rm -rf "${tmpdir}"
      return 1
    fi
    # Copied under the canonical wheel name: pip validates the file name and
    # rejects anything that is not a well-formed wheel name.
    if ! cp "${KUBE_PYTHON_PIP_WHEEL}" "${wheel}"; then
      kube::python::internal::log_error \
        "could not copy ${KUBE_PYTHON_PIP_WHEEL} into ${tmpdir}."
      rm -rf "${tmpdir}"
      return 1
    fi
    source_description="the local pip wheel ${KUBE_PYTHON_PIP_WHEEL}"
  else
    local url
    if ! url=$(kube::python::internal::pip_wheel_url); then
      rm -rf "${tmpdir}"
      return 1
    fi
    source_description="the pinned pip wheel from ${url}"

    local fetched=n
    if [[ $(type -t kube::util::download_file) == function ]]; then
      kube::util::download_file "${url}" "${wheel}" >/dev/null 2>&1 && fetched=y
    elif command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 --keepalive-time 2 "${url}" -o "${wheel}" && fetched=y
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "${wheel}" "${url}" && fetched=y
    else
      kube::python::internal::log_error \
        "no downloader is available to fetch pip: kube::util::download_file, curl and wget are all absent." \
        "Source hack/lib/init.sh before hack/lib/python.sh, install curl, or pre-seed the wheel and" \
        "point KUBE_PYTHON_PIP_WHEEL at it."
      rm -rf "${tmpdir}"
      return 1
    fi

    if [[ "${fetched}" != y ]]; then
      kube::python::internal::log_error \
        "could not download pip ${KUBE_PYTHON_PIP_VERSION} from ${url}." \
        "This step needs network access; the interpreter in this image cannot bootstrap pip on its own." \
        "Re-run once connectivity is restored, or pre-seed the wheel and point KUBE_PYTHON_PIP_WHEEL at it."
      rm -rf "${tmpdir}"
      return 1
    fi
  fi

  if ! kube::python::internal::verify_digest "${wheel}" "${source_description}"; then
    rm -rf "${tmpdir}"
    return 1
  fi
  V=4 kube::python::internal::log_info \
    "verified ${source_description}: sha256 ${KUBE_PYTHON_PIP_SHA256}"

  # pip installs itself by running out of its own wheel. --no-index and
  # --no-cache-dir keep this step from resolving or reusing anything else, so the
  # only artifact involved is the one just verified.
  if ! "${venv_python}" "${wheel}/pip" install \
    --no-index --no-cache-dir --disable-pip-version-check --no-warn-script-location \
    "${wheel}" >/dev/null; then
    kube::python::internal::log_error \
      "installing the verified pip ${KUBE_PYTHON_PIP_VERSION} wheel with ${venv_python} failed, so ${venv} has no pip." \
      "Re-run with V=3 for more detail, or provide an interpreter whose ensurepip works."
    rm -rf "${tmpdir}"
    return 1
  fi

  rm -rf "${tmpdir}"
  V=3 kube::python::internal::log_info \
    "bootstrapped pip ${KUBE_PYTHON_PIP_VERSION} into ${venv} from ${source_description}"
  return 0
}

# kube::python::internal::link_venv exposes the real environment $1 at
# ${KUBE_PYTHON_VENV}. On return ${KUBE_PYTHON_VENV} resolves to $1, or an
# actionable message has been written and the status is non-zero. A real
# directory already sitting at ${KUBE_PYTHON_VENV} is relocated out of the way
# first, because an in-tree environment breaks the repository's tree-walking
# gates (see the KUBE_PYTHON_VENV_STORE comment above).
kube::python::internal::link_venv() {
  local store=${1:?a store path is required}

  # An operator can point the store at the tree-visible path to build the
  # environment in place; there is nothing to link in that case.
  if [[ "${store}" == "${KUBE_PYTHON_VENV}" ]]; then
    return 0
  fi

  if ! mkdir -p "$(dirname "${KUBE_PYTHON_VENV}")"; then
    kube::python::internal::log_error \
      "could not create $(dirname "${KUBE_PYTHON_VENV}") to hold the virtual environment link."
    return 1
  fi

  if [[ -e "${KUBE_PYTHON_VENV}" && ! -L "${KUBE_PYTHON_VENV}" ]]; then
    # Only a discardable thing may be discarded here. assert_removable inside
    # safe_rm requires an empty directory, a virtual environment (pyvenv.cfg) or
    # this library's own marker, so a caller who put something else at this path
    # gets an explanation instead of losing it.
    kube::python::internal::log_status \
      "Replacing the in-tree environment ${KUBE_PYTHON_VENV} with a link to ${store}"
    kube::python::internal::safe_rm "${KUBE_PYTHON_VENV}" \
      "the in-tree virtual environment" || return 1
  fi

  if ! ln -sfn "${store}" "${KUBE_PYTHON_VENV}"; then
    kube::python::internal::log_error \
      "could not link ${KUBE_PYTHON_VENV} to ${store}." \
      "Set KUBE_PYTHON_VENV_STORE=${KUBE_PYTHON_VENV} to build the environment in place instead."
    return 1
  fi
  return 0
}

# kube::python::dirs resolves the KUBE_PYTHON_* path variables and exports
# KUBE_PYTHON_VENV_BIN. On return KUBE_PYTHON_DIR, KUBE_PYTHON_VENV,
# KUBE_PYTHON_VENV_DIR, KUBE_PYTHON_REQUIREMENTS and KUBE_PYTHON_VENV_BIN are all
# non-empty and mutually consistent. It creates nothing, touches no network and
# is safe to call any number of times.
#
# It re-asserts the same defaults the configuration block above applies, so a
# caller that unset one of them still gets a coherent set. hack/verify-python.sh,
# hack/make-rules/test-python.sh and hack/make-rules/test-parity.sh call this
# before reading those variables.
kube::python::dirs() {
  KUBE_PYTHON_DIR=${KUBE_PYTHON_DIR:-${KUBE_ROOT}/python}
  KUBE_PYTHON_VENV=${KUBE_PYTHON_VENV:-${KUBE_PYTHON_VENV_DIR:-${KUBE_PYTHON_DIR}/.venv}}
  # KUBE_PYTHON_VENV_DIR is the spelling the in-repo consumers read; the two name
  # the same directory by definition, so this is an assignment and not a default.
  KUBE_PYTHON_VENV_DIR=${KUBE_PYTHON_VENV}
  KUBE_PYTHON_REQUIREMENTS=${KUBE_PYTHON_REQUIREMENTS:-${KUBE_PYTHON_DIR}/requirements-test.txt}
  export KUBE_PYTHON_VENV_BIN="${KUBE_PYTHON_VENV}/bin"
  return 0
}

# kube::python::venv_store echoes the directory that holds the real virtual
# environment. On return the path has been printed and its parent exists, or an
# actionable message has been written and the status is non-zero. It creates the
# parent directory but not the environment itself.
kube::python::venv_store() {
  if [[ -n "${KUBE_PYTHON_VENV_STORE:-}" ]]; then
    echo "${KUBE_PYTHON_VENV_STORE}"
    return 0
  fi

  # Preferred location, then a temporary-directory fallback for hosts where it
  # cannot be created (an unprivileged developer machine, typically).
  local base="/opt/blitzy/venv"
  if ! mkdir -p "${base}" 2>/dev/null; then
    base="${TMPDIR:-/tmp}/blitzy/venv"
    if ! mkdir -p "${base}"; then
      kube::python::internal::log_error \
        "could not create a directory to hold the virtual environment (tried /opt/blitzy/venv and ${base})." \
        "Set KUBE_PYTHON_VENV_STORE to a writable directory outside the repository working tree."
      return 1
    fi
  fi

  echo "${base}/k8s-python-tier${CLONE_INDEX:+-${CLONE_INDEX}}"
}

# kube::python::interpreter echoes the interpreter used to build the virtual
# environment. On return an executable interpreter meeting PYTHON_MIN_VERSION has
# been printed, or nothing has been printed, an actionable message has been
# written and the status is non-zero. Nothing is created and no network is used.
#
# Three passes, in order of preference:
#   1. an exact KUBE_PYTHON_VERSION minor match on ${PATH};
#   2. a uv-managed build of that series, because a distribution may ship no
#      package for it (uv is only queried, never asked to download);
#   3. anything at or above PYTHON_MIN_VERSION, which is the real floor.
# ${PYTHON_BIN} is tried first within each pass, so an explicit override wins.
kube::python::interpreter() {
  local candidate resolved full

  for candidate in "${PYTHON_BIN}" "python${KUBE_PYTHON_VERSION}" python3 python; do
    resolved=$(command -v "${candidate}" 2>/dev/null) || continue
    full=$(kube::python::internal::interpreter_version "${resolved}") || continue
    kube::python::internal::meets_floor "${full}" || continue
    if [[ "${full%.*}" == "${KUBE_PYTHON_VERSION}" ]]; then
      echo "${resolved}"
      return 0
    fi
  done

  if command -v uv >/dev/null 2>&1; then
    if resolved=$(uv python find "${KUBE_PYTHON_VERSION}" 2>/dev/null) && [[ -x "${resolved}" ]]; then
      full=$(kube::python::internal::interpreter_version "${resolved}") || full=""
      if kube::python::internal::meets_floor "${full}"; then
        V=3 kube::python::internal::log_info "using the uv-managed Python ${full}: ${resolved}"
        echo "${resolved}"
        return 0
      fi
    fi
  fi

  for candidate in "${PYTHON_BIN}" python3 python; do
    resolved=$(command -v "${candidate}" 2>/dev/null) || continue
    full=$(kube::python::internal::interpreter_version "${resolved}") || continue
    kube::python::internal::meets_floor "${full}" || continue
    V=3 kube::python::internal::log_info \
      "python${KUBE_PYTHON_VERSION} was not found; using ${resolved} (${full}), which meets the >= ${PYTHON_MIN_VERSION} floor"
    echo "${resolved}"
    return 0
  done

  kube::python::internal::log_error \
    "no Python interpreter >= ${PYTHON_MIN_VERSION} was found in your PATH." \
    "The Python test tier needs Python ${KUBE_PYTHON_VERSION} (>= ${PYTHON_MIN_VERSION}, the floor pytest 9 imposes)." \
    "Install it, or set PYTHON_BIN to the interpreter you want to use, for example: PYTHON_BIN=/usr/bin/python3.12 make test-python"
  return 1
}

# kube::python::validate checks that this host can build the Python test tier.
# On return an interpreter meeting PYTHON_MIN_VERSION exists, or an actionable
# message naming the detected version, the required floor and the fix has been
# written to stderr and the status is non-zero. Nothing is created, nothing is
# installed, no network is used and ${PATH} is untouched.
#
# ${PYTHON_BIN} is the fast path. When it is missing or too old the exhaustive
# search in kube::python::interpreter is consulted before failing, so a host that
# has a usable interpreter under another name is never rejected. The floor itself
# is never relaxed.
kube::python::validate() {
  kube::python::dirs

  local resolved full
  if resolved=$(command -v "${PYTHON_BIN}" 2>/dev/null); then
    full=$(kube::python::internal::interpreter_version "${resolved}") || full=""
    if kube::python::internal::meets_floor "${full}"; then
      V=4 kube::python::internal::log_info \
        "python ${full} (${resolved}) meets the >= ${PYTHON_MIN_VERSION} floor"
      return 0
    fi
    if [[ -n "${full}" ]]; then
      V=3 kube::python::internal::log_info \
        "Detected Python version: ${full} (${resolved}), below the required ${PYTHON_MIN_VERSION}; looking for another interpreter"
    fi
  fi

  # kube::python::interpreter emits the actionable message when it finds nothing.
  if ! resolved=$(kube::python::interpreter); then
    return 1
  fi
  full=$(kube::python::internal::interpreter_version "${resolved}") || full="unknown"
  V=3 kube::python::internal::log_info \
    "${PYTHON_BIN} is unsuitable or absent; the tier will be built with ${resolved} (${full})"
  return 0
}

# kube::python::ensure_venv creates the isolated virtual environment for the
# Python test tier if it does not already exist. On return
# ${KUBE_PYTHON_VENV}/bin/python is executable and pip works inside it, or an
# actionable message has been written to stderr, the status is non-zero and no
# half-provisioned environment has been left behind for a later run to mistake
# for a good one. It installs no test dependencies - that is
# kube::python::install_requirements - and it does not modify ${PATH}.
#
# Already provisioned is the common case and short-circuits before anything is
# created, so calling this repeatedly is cheap. The environment is created with
# --without-pip and pip is bootstrapped afterwards; see
# kube::python::internal::bootstrap_pip for why.
kube::python::ensure_venv() {
  kube::python::dirs

  if kube::python::internal::venv_usable "${KUBE_PYTHON_VENV}"; then
    V=4 kube::python::internal::log_info \
      "the Python virtual environment ${KUBE_PYTHON_VENV} is already provisioned"
    return 0
  fi

  local store
  store=$(kube::python::venv_store) || return 1

  # Everything below MUTATES the store, so it runs under the provisioning lock.
  # The check above is deliberately outside it: the common case is "already
  # provisioned", and that must not queue behind another clone's install.
  kube::python::internal::with_lock "${store}.lock" \
    kube::python::internal::ensure_venv_locked "${store}"
}

# kube::python::internal::ensure_venv_locked is the mutating body of
# kube::python::ensure_venv and must only be called while the provisioning lock
# for $1 is held. On return it guarantees exactly what kube::python::ensure_venv
# does.
kube::python::internal::ensure_venv_locked() {
  local store=${1:?a store path is required}

  # Re-checked under the lock: another process may have finished provisioning
  # while this one waited, in which case there is nothing left to do beyond
  # claiming ownership of a store an older revision of this library may have
  # created without a marker, so that a later rebuild is permitted.
  if kube::python::internal::venv_usable "${KUBE_PYTHON_VENV}"; then
    V=4 kube::python::internal::log_info \
      "the Python virtual environment ${KUBE_PYTHON_VENV} was provisioned while this run waited"
    if [[ -d "${store}" && ! -f "${store}/${KUBE_PYTHON_STORE_MARKER_NAME}" ]]; then
      kube::python::internal::mark_store "${store}" || true
    fi
    return 0
  fi

  local interpreter
  interpreter=$(kube::python::interpreter) || return 1

  if kube::python::internal::venv_usable "${store}"; then
    V=4 kube::python::internal::log_info "reusing the existing virtual environment in ${store}"
    # An environment created by an older revision of this library has no
    # ownership marker. Write one now so a later rebuild is permitted.
    if [[ ! -f "${store}/${KUBE_PYTHON_STORE_MARKER_NAME}" ]]; then
      kube::python::internal::mark_store "${store}" || true
    fi
  else
    local version
    version=$(kube::python::internal::interpreter_version "${interpreter}") || version="unknown"
    kube::python::internal::log_status \
      "Creating the Python virtual environment in ${store} using ${interpreter} (${version})"

    if ! mkdir -p "$(dirname "${store}")"; then
      kube::python::internal::log_error \
        "could not create $(dirname "${store}") to hold the virtual environment." \
        "Set KUBE_PYTHON_VENV_STORE to a writable directory outside the repository working tree."
      return 1
    fi

    # Discard any earlier partial attempt so creation starts from a clean slate.
    # safe_rm refuses a directory this library does not own, so a store pointed at
    # somebody else's data is reported rather than deleted.
    kube::python::internal::safe_rm "${store}" "the virtual-environment store" || return 1

    if ! "${interpreter}" -m venv --without-pip "${store}"; then
      kube::python::internal::log_error \
        "creating a virtual environment with '${interpreter} -m venv --without-pip ${store}' failed." \
        "Confirm that ${interpreter} can create virtual environments (the venv module must be present)." \
        "On Debian and Ubuntu the module ships in the python3-venv package."
      kube::python::internal::safe_rm "${store}" "the virtual-environment store"
      return 1
    fi

    # Claim ownership as soon as the directory is a virtual environment, so every
    # later cleanup path - including the two immediately below - is permitted to
    # remove exactly this tree and nothing else.
    kube::python::internal::mark_store "${store}" || true

    if ! kube::python::internal::bootstrap_pip "${store}"; then
      # bootstrap_pip has already explained the failure. Remove the environment
      # so the next run retries instead of inheriting one that has no pip.
      kube::python::internal::safe_rm "${store}" "the virtual-environment store"
      return 1
    fi
  fi

  kube::python::internal::link_venv "${store}" || return 1

  if ! kube::python::internal::venv_usable "${KUBE_PYTHON_VENV}"; then
    kube::python::internal::log_error \
      "the virtual environment at ${KUBE_PYTHON_VENV} is still not usable after provisioning ${store}." \
      "Remove ${KUBE_PYTHON_VENV} and ${store} and re-run to rebuild from scratch."
    return 1
  fi

  local ready
  ready=$(kube::python::internal::interpreter_version "${KUBE_PYTHON_VENV_BIN}/python") || ready="unknown"
  V=3 kube::python::internal::log_info \
    "Python virtual environment ready: ${ready} at ${KUBE_PYTHON_VENV} -> ${store}"
  return 0
}

# kube::python::create_venv is the compatibility spelling of
# kube::python::ensure_venv, kept because it was this library's original public
# name. On return it guarantees exactly what kube::python::ensure_venv does.
kube::python::create_venv() {
  kube::python::ensure_venv
}

# kube::python::install_requirements installs the exactly-pinned manifest
# ${KUBE_PYTHON_REQUIREMENTS} into the virtual environment, creating the
# environment first if needed. On return every pin in the manifest is installed
# and `pip check` reports no broken requirements, or an actionable message has
# been written to stderr and the status is non-zero. ${PATH} is not modified.
#
# WHAT IS INSTALLED: the hash-locked graph ${KUBE_PYTHON_LOCK}, with
# `--require-hashes`, so every artifact - including the 40 transitive ones the
# manifest never names - must match a digest recorded in the repository. The
# manifest is cross-checked against the lock rather than installed directly; the
# two disagreeing means the lock is stale, which is reported rather than resolved
# by guessing. Installing without the lock has to be asked for by name through
# KUBE_PYTHON_ALLOW_UNLOCKED=y.
#
# The work is stamp-guarded AND graph-checked: the SHA-256 of the manifest and the
# lock together is recorded inside the environment (the hack/lib/etcd.sh L160-163
# "already installed" pattern), and the fast path additionally asserts that the
# INSTALLED distributions still match both files. A stamp alone would let a
# hand-modified or differently-warmed store keep reporting success while running a
# different toolchain, so a stamp that matches a graph that does not triggers a
# reinstall. The stamp is written only after a successful install AND a successful
# post-install graph check, so any failure is retried next time.
#
# The mutating work is serialised with the provisioning lock, because several
# clones and several gates can reach one store at once; the fast path deliberately
# runs outside it so a warm environment never waits.
#
# pip is invoked as `python -m pip` inside the environment, never as a bare pip,
# so nothing can be installed into the system interpreter.
kube::python::install_requirements() {
  kube::python::dirs

  if [[ ! -f "${KUBE_PYTHON_REQUIREMENTS}" ]]; then
    kube::python::internal::log_error \
      "missing ${KUBE_PYTHON_REQUIREMENTS}: the pinned Python test manifest does not exist." \
      "Nothing was installed, and the virtual environment at ${KUBE_PYTHON_VENV} was left intact." \
      "Point KUBE_PYTHON_REQUIREMENTS at the manifest, or create python/requirements-test.txt."
    return 1
  fi

  # The FAST PATH, and the only thing that runs outside the lock: an environment
  # whose stamp matches AND whose installed graph matches the manifest and the lock
  # needs nothing done to it, and must not queue behind another clone's install.
  local want stamp
  want=$(kube::python::internal::requirements_hash) || want=""
  stamp=$(kube::python::internal::requirements_stamp)

  if [[ -n "${want}" && -f "${stamp}" ]] && [[ "$(cat "${stamp}" 2>/dev/null)" == "${want}" ]]; then
    if kube::python::internal::graph_matches; then
      V=4 kube::python::internal::log_info \
        "the pinned Python test dependencies from ${KUBE_PYTHON_LOCK} are already installed"
      return 0
    fi
    kube::python::internal::log_status \
      "The stamp at ${stamp} matches but the installed distributions do not; reinstalling"
  fi

  local store
  store=$(kube::python::venv_store) || return 1
  kube::python::internal::with_lock "${store}.lock" \
    kube::python::internal::install_requirements_locked "${store}" "${want}" "${stamp}"
}

# kube::python::internal::install_requirements_locked is the mutating body of
# kube::python::install_requirements and must only be called while the provisioning
# lock for $1 is held. $2 is the expected stamp value and $3 the stamp path. On
# return it guarantees exactly what kube::python::install_requirements does.
kube::python::internal::install_requirements_locked() {
  local store=${1:?a store path is required}
  local want=${2:-}
  local stamp=${3:?a stamp path is required}

  kube::python::internal::ensure_venv_locked "${store}" || return 1

  # Re-checked under the lock: another process may have installed the same set
  # while this one waited.
  if [[ -n "${want}" && -f "${stamp}" ]] && [[ "$(cat "${stamp}" 2>/dev/null)" == "${want}" ]] &&
    kube::python::internal::graph_matches; then
    V=4 kube::python::internal::log_info \
      "the pinned Python test dependencies were installed while this run waited"
    return 0
  fi

  # WHAT IS INSTALLED FROM, and why it is the lock rather than the manifest.
  # python/requirements-test.lock is the fully resolved graph with a SHA-256 for
  # every artifact each pin may be satisfied by, so --require-hashes refuses a
  # substituted or tampered artifact rather than installing it. The manifest pins
  # only the 18 direct distributions; installing from it would leave 40 transitive
  # artifacts unverified and free to resolve differently on any future run.
  local -a install_args=()
  local source_file
  if [[ -f "${KUBE_PYTHON_LOCK}" ]]; then
    source_file="${KUBE_PYTHON_LOCK}"
    install_args=("--require-hashes" "-r" "${KUBE_PYTHON_LOCK}")
  elif [[ "${KUBE_PYTHON_ALLOW_UNLOCKED}" =~ ^[yY]$ ]]; then
    source_file="${KUBE_PYTHON_REQUIREMENTS}"
    install_args=("-r" "${KUBE_PYTHON_REQUIREMENTS}")
    kube::python::internal::log_status \
      "WARNING: installing from ${KUBE_PYTHON_REQUIREMENTS} WITHOUT hash checking, because" \
      "KUBE_PYTHON_ALLOW_UNLOCKED=${KUBE_PYTHON_ALLOW_UNLOCKED} and no lock exists at ${KUBE_PYTHON_LOCK}." \
      "Transitive versions and artifact contents are then whatever the index serves today."
  else
    kube::python::internal::log_error \
      "missing ${KUBE_PYTHON_LOCK}: the hash-locked dependency graph does not exist, so the" \
      "pinned set cannot be installed reproducibly." \
      "Regenerate it from the manifest with:" \
      "  uv pip compile ${KUBE_PYTHON_REQUIREMENTS} --generate-hashes --universal --python-version 3.10 -o ${KUBE_PYTHON_LOCK}" \
      "or, to install the manifest alone and accept unverified transitive artifacts, re-run with" \
      "KUBE_PYTHON_ALLOW_UNLOCKED=y. Nothing was installed."
    return 1
  fi

  kube::python::internal::log_status \
    "Installing the pinned Python test dependencies from ${source_file}"
  if ! "${KUBE_PYTHON_VENV_BIN}/python" -m pip install \
    --disable-pip-version-check --progress-bar off "${install_args[@]}"; then
    kube::python::internal::log_error \
      "installing ${source_file} into ${KUBE_PYTHON_VENV} failed." \
      "This step needs network access to the Python package index." \
      "If the failure names a hash mismatch, then an artifact does not match the digest recorded in" \
      "${KUBE_PYTHON_LOCK} - treat that as a supply-chain finding, not as a lock to regenerate." \
      "Re-run once connectivity is restored; nothing was recorded, so the install will be retried."
    return 1
  fi

  # An integrity assertion rather than decoration: AAP §0.6 records `pip check`
  # reporting "No broken requirements found." for exactly this pin set, so a
  # conflict here is a real regression in the manifest and not noise.
  if ! "${KUBE_PYTHON_VENV_BIN}/python" -m pip check; then
    kube::python::internal::log_error \
      "'pip check' reported broken requirements in ${KUBE_PYTHON_VENV} after installing ${source_file}." \
      "The pinned set is expected to be internally consistent, so treat this as a manifest regression." \
      "Nothing was recorded, so the install will be retried on the next run."
    return 1
  fi

  # The graph is asserted AFTER the install as well as before it, so a stamp is
  # only ever written over an environment that has been shown to match. Without
  # this, a partially applied install would be stamped as good and the fast path
  # would trust it on every subsequent run.
  if [[ -f "${KUBE_PYTHON_LOCK}" ]] && ! kube::python::internal::graph_matches; then
    kube::python::internal::log_error \
      "the installed distributions still do not match ${KUBE_PYTHON_REQUIREMENTS} and ${KUBE_PYTHON_LOCK}" \
      "after installing (the report above names each one)." \
      "Nothing was recorded, so the install will be retried. If the mismatch is a STALE LOCK, regenerate it:" \
      "  uv pip compile ${KUBE_PYTHON_REQUIREMENTS} --generate-hashes --universal --python-version 3.10 -o ${KUBE_PYTHON_LOCK}" \
      "If it is a modified store, remove ${KUBE_PYTHON_VENV} and ${store} and re-run to rebuild from scratch."
    return 1
  fi

  if [[ -n "${want}" ]] && ! echo "${want}" >"${stamp}" 2>/dev/null; then
    V=3 kube::python::internal::log_info \
      "could not record ${stamp}; the pinned set will be reinstalled on the next run"
  fi
  return 0
}

# kube::python::install provisions the Python test tier: it creates the virtual
# environment if needed and installs the pinned test dependencies into it. On
# return "${KUBE_PYTHON_VENV_BIN}/python -m pytest" is usable, or an actionable
# message has been written to stderr and the status is non-zero. ${PATH} is
# deliberately left alone - use kube::python::setup_env when you want it changed.
#
# This is the entry point hack/verify-python.sh, hack/make-rules/test-python.sh
# and hack/make-rules/test-parity.sh call, so its name and behaviour are a
# contract. The environment is created by kube::python::install_requirements,
# which calls kube::python::ensure_venv itself.
kube::python::install() {
  kube::python::dirs
  kube::python::install_requirements
}

# kube::python::bin echoes the path of the virtual environment's interpreter,
# provisioning the environment first when it is missing. On return an executable
# path has been printed on stdout, or nothing has been printed to stdout and the
# status is non-zero. Provisioning output goes to stderr so that
# "$(kube::python::bin)" captures the path and nothing else.
kube::python::bin() {
  kube::python::dirs

  if ! kube::python::internal::venv_usable "${KUBE_PYTHON_VENV}"; then
    kube::python::ensure_venv >&2 || return 1
  fi
  echo "${KUBE_PYTHON_VENV_BIN}/python"
}

# kube::python::activate puts the virtual environment on ${PATH}. On return
# ${KUBE_PYTHON_VENV_BIN} is the first ${PATH} entry and appears exactly once,
# VIRTUAL_ENV points at the environment, and pytest, ruff and mypy resolve to the
# pinned copies; otherwise an actionable message has been written and the status
# is non-zero with ${PATH} unchanged. It provisions nothing.
#
# Calling this twice, or sourcing this file twice, must not add a second copy of
# the directory to ${PATH}, so membership is tested before prepending.
kube::python::activate() {
  kube::python::dirs

  if ! kube::python::internal::venv_usable "${KUBE_PYTHON_VENV}"; then
    kube::python::internal::log_error \
      "the Python virtual environment ${KUBE_PYTHON_VENV} is not usable, so it cannot be activated." \
      "Run 'kube::python::setup_env' (or 'make test-python') to provision it first."
    return 1
  fi

  if [[ ":${PATH}:" != *":${KUBE_PYTHON_VENV_BIN}:"* ]]; then
    PATH="${KUBE_PYTHON_VENV_BIN}:${PATH}"
    export PATH
    # Forget any interpreter this shell resolved before the change.
    hash -r 2>/dev/null || true
    V=3 kube::python::internal::log_info "added the Python test tier to PATH: ${KUBE_PYTHON_VENV_BIN}"
  fi

  # The two things the environment's own bin/activate script does, minus the
  # interactive prompt handling: PYTHONHOME would override the environment's
  # module search path and break it.
  export VIRTUAL_ENV="${KUBE_PYTHON_VENV}"
  unset PYTHONHOME 2>/dev/null || true
  return 0
}

# kube::python::setup_env will check that a suitable Python interpreter is
# available, create the isolated virtual environment for the Python test tier if
# it does not exist, install the exactly-pinned manifest into it, and put it on
# ${PATH}. It is the single call a hack/ script needs, and it is safe to call
# repeatedly because every step short-circuits once satisfied. On failure the
# step that failed has written an actionable message to stderr and its status is
# returned unchanged.
#
# Outputs:
#   env-var KUBE_PYTHON_VENV_BIN points at the virtual environment's bin dir
#   env-var VIRTUAL_ENV points at the virtual environment root
#   env-var PATH is prefixed with the virtual environment's bin dir, exactly once
#   the environment at ${KUBE_PYTHON_VENV} exists with the pinned set installed
kube::python::setup_env() {
  kube::python::dirs
  kube::python::validate || return $?
  kube::python::ensure_venv || return $?
  kube::python::install_requirements || return $?
  kube::python::activate || return $?
  return 0
}

# Marker function to indicate python.sh has been fully sourced
kube::python::loaded() {
  return 0
}

# ex: ts=2 sw=2 et filetype=sh
