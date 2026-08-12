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
# an isolated virtual environment built from the exactly-pinned manifest
# python/requirements-test.txt, never from the system interpreter, and
# provisioning converges on repeat invocation instead of accumulating.
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
#   kube::python::install_requirements  install the pinned manifest (stamp-guarded)
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

# The one derived value callers need, exported so that hack/verify-python.sh and
# hack/make-rules/test-python.sh can invoke ruff, mypy and pytest by absolute
# path without depending on ${PATH} ordering (the hack/lib/etcd.sh L26 pattern).
export KUBE_PYTHON_VENV_BIN="${KUBE_PYTHON_VENV}/bin"

# Where the REAL virtual environment is materialised. It lives OUTSIDE the
# repository working tree by default and ${KUBE_PYTHON_VENV} is a symlink to it,
# because the repository's own gates walk the tree: skipped_names in
# hack/boilerplate/boilerplate.py does not list .venv, so a real in-tree
# environment makes hack/verify-boilerplate.sh report every unlicensed .py file
# under site-packages and exit 1. Neither os.walk() nor find(1) follows a
# symlinked directory, so the symlink keeps those gates green.
# python/pyproject.toml records the same decision from the other side.
#
# Set KUBE_PYTHON_VENV_STORE to override. Setting it to ${KUBE_PYTHON_VENV}
# creates the environment in place, with no symlink, for callers whose tree is
# not subject to those gates. CLONE_INDEX, when a parallel runner sets it, keeps
# concurrent clones from sharing (and deleting) one another's store.
KUBE_PYTHON_VENV_STORE=${KUBE_PYTHON_VENV_STORE:-}

# Where pip is fetched from when the interpreter cannot bootstrap it itself.
# Used only as a fallback; see kube::python::internal::bootstrap_pip.
KUBE_PYTHON_GET_PIP_URL=${KUBE_PYTHON_GET_PIP_URL:-https://bootstrap.pypa.io/get-pip.py}

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

# kube::python::internal::log_status writes a top-level status line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::status does. On
# return the line has been written or suppressed by verbosity, and the status is
# 0. Guarded for the same reason as log_error above.
kube::python::internal::log_status() {
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

# kube::python::internal::log_info writes a non-top-level line to stdout,
# honouring ${V} and ${KUBE_VERBOSE} exactly as kube::log::info does, so
# `V=4 kube::python::internal::log_info ...` stays quiet on a normal run. On
# return the line has been written or suppressed, and the status is 0.
kube::python::internal::log_info() {
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

# kube::python::internal::safe_rm removes the directory tree $1, refusing paths
# that are obviously not ours. On return the path is gone, or nothing has been
# removed and the status is non-zero. `rm -rf` against an unexpected value is
# the one irreversible mistake a provisioner can make, so this guard is
# deliberate rather than defensive.
kube::python::internal::safe_rm() {
  local target=${1:-}

  case "${target}" in
    '' | '/' | '.' | '..' | '~' | '*')
      kube::python::internal::log_error \
        "refusing to remove the suspicious path '${target}'." \
        "This is a bug in hack/lib/python.sh or an unsafe KUBE_PYTHON_VENV / KUBE_PYTHON_VENV_STORE value."
      return 1
      ;;
  esac

  rm -rf "${target}"
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

# kube::python::internal::requirements_hash echoes a SHA-256 of the pinned
# manifest. On return the hash has been printed, or nothing has been printed and
# the status is non-zero because the manifest is missing or no hashing utility is
# available. A missing hash is not an error for callers: it only means the
# install step cannot be skipped and will simply run again.
kube::python::internal::requirements_hash() {
  [[ -f "${KUBE_PYTHON_REQUIREMENTS}" ]] || return 1

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${KUBE_PYTHON_REQUIREMENTS}" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${KUBE_PYTHON_REQUIREMENTS}" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${KUBE_PYTHON_REQUIREMENTS}" | awk '{ print $NF }'
  else
    return 1
  fi
}

# kube::python::internal::requirements_stamp echoes the path of the file that
# records which manifest the environment was last built from. On return the path
# has been printed; the file itself may or may not exist. It lives inside the
# environment so that deleting the environment discards the record with it, and
# so that nothing is written into the repository working tree.
kube::python::internal::requirements_stamp() {
  echo "${KUBE_PYTHON_VENV}/.requirements.sha256"
}

# kube::python::internal::bootstrap_pip installs pip into the virtual
# environment rooted at $1. On return `python -m pip` works inside that
# environment, or an actionable message has been written to stderr, the status
# is non-zero, and pip is still absent.
#
# Two paths are tried in order, because neither is universally available:
#   1. ensurepip, which needs no network. Its failure is deliberately NOT fatal:
#      the target image ships the ensurepip module but not its bundled wheel
#      (observed: FileNotFoundError ... ensurepip/_bundled/pip-*.whl), which is
#      the missing-python3-pip gap AAP §0.9.4.3 records. That is also why the
#      environment is created with --without-pip - a plain `python -m venv` runs
#      ensurepip internally and fails outright on such an image.
#   2. get-pip.py, which needs network. Fetched with kube::util::download_file
#      when hack/lib/util.sh is loaded, because that helper already retries,
#      and with curl otherwise.
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
    "ensurepip could not provide pip (no bundled wheel in this image); falling back to ${KUBE_PYTHON_GET_PIP_URL}"

  local tmpdir
  if ! tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t kube-python.XXXXXX); then
    kube::python::internal::log_error \
      "could not create a temporary directory to download pip into." \
      "Check that \${TMPDIR:-/tmp} exists and is writable."
    return 1
  fi

  local get_pip="${tmpdir}/get-pip.py"
  local fetched=n
  if [[ $(type -t kube::util::download_file) == function ]]; then
    kube::util::download_file "${KUBE_PYTHON_GET_PIP_URL}" "${get_pip}" >/dev/null 2>&1 && fetched=y
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --keepalive-time 2 "${KUBE_PYTHON_GET_PIP_URL}" -o "${get_pip}" && fetched=y
  else
    kube::python::internal::log_error \
      "neither kube::util::download_file nor curl is available to download pip." \
      "Source hack/lib/init.sh before hack/lib/python.sh, or install curl."
    rm -rf "${tmpdir}"
    return 1
  fi

  if [[ "${fetched}" != y ]]; then
    kube::python::internal::log_error \
      "could not download pip from ${KUBE_PYTHON_GET_PIP_URL}." \
      "This step needs network access; the interpreter in this image cannot bootstrap pip on its own." \
      "Re-run once connectivity is restored, or set KUBE_PYTHON_GET_PIP_URL to a reachable mirror."
    rm -rf "${tmpdir}"
    return 1
  fi

  if ! "${venv_python}" "${get_pip}" --no-warn-script-location >/dev/null; then
    kube::python::internal::log_error \
      "running get-pip.py with ${venv_python} failed, so ${venv} has no pip." \
      "Re-run with V=3 for more detail, or provide an interpreter whose ensurepip works."
    rm -rf "${tmpdir}"
    return 1
  fi

  rm -rf "${tmpdir}"
  V=3 kube::python::internal::log_info "bootstrapped pip into ${venv} with get-pip.py"
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
    kube::python::internal::log_status \
      "Relocating the in-tree environment ${KUBE_PYTHON_VENV} out of the repository walk"
    kube::python::internal::safe_rm "${KUBE_PYTHON_VENV}" || return 1
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

  local interpreter store
  interpreter=$(kube::python::interpreter) || return 1
  store=$(kube::python::venv_store) || return 1

  if kube::python::internal::venv_usable "${store}"; then
    V=4 kube::python::internal::log_info "reusing the existing virtual environment in ${store}"
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
    kube::python::internal::safe_rm "${store}" || return 1

    if ! "${interpreter}" -m venv --without-pip "${store}"; then
      kube::python::internal::log_error \
        "creating a virtual environment with '${interpreter} -m venv --without-pip ${store}' failed." \
        "Confirm that ${interpreter} can create virtual environments (the venv module must be present)." \
        "On Debian and Ubuntu the module ships in the python3-venv package."
      kube::python::internal::safe_rm "${store}"
      return 1
    fi

    if ! kube::python::internal::bootstrap_pip "${store}"; then
      # bootstrap_pip has already explained the failure. Remove the environment
      # so the next run retries instead of inheriting one that has no pip.
      kube::python::internal::safe_rm "${store}"
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
# The work is stamp-guarded: the SHA-256 of the manifest is recorded inside the
# environment, so `make verify` followed by `make test-python` does not reinstall
# (the hack/lib/etcd.sh L160-163 "already installed" pattern). The stamp is
# written only after a successful install, so any failure is retried next time.
#
# pip is invoked as `python -m pip` inside the environment, never as a bare pip,
# so nothing can be installed into the system interpreter.
kube::python::install_requirements() {
  kube::python::dirs
  kube::python::ensure_venv || return 1

  if [[ ! -f "${KUBE_PYTHON_REQUIREMENTS}" ]]; then
    kube::python::internal::log_error \
      "missing ${KUBE_PYTHON_REQUIREMENTS}: the pinned Python test manifest does not exist." \
      "Nothing was installed, and the virtual environment at ${KUBE_PYTHON_VENV} was left intact." \
      "Point KUBE_PYTHON_REQUIREMENTS at the manifest, or create python/requirements-test.txt."
    return 1
  fi

  local want stamp
  want=$(kube::python::internal::requirements_hash) || want=""
  stamp=$(kube::python::internal::requirements_stamp)

  if [[ -n "${want}" && -f "${stamp}" ]] && [[ "$(cat "${stamp}" 2>/dev/null)" == "${want}" ]]; then
    V=4 kube::python::internal::log_info \
      "the pinned Python test dependencies from ${KUBE_PYTHON_REQUIREMENTS} are already installed"
    return 0
  fi

  kube::python::internal::log_status \
    "Installing the pinned Python test dependencies from ${KUBE_PYTHON_REQUIREMENTS}"
  if ! "${KUBE_PYTHON_VENV_BIN}/python" -m pip install \
    --disable-pip-version-check --progress-bar off -r "${KUBE_PYTHON_REQUIREMENTS}"; then
    kube::python::internal::log_error \
      "installing ${KUBE_PYTHON_REQUIREMENTS} into ${KUBE_PYTHON_VENV} failed." \
      "This step needs network access to the Python package index." \
      "Re-run once connectivity is restored; nothing was recorded, so the install will be retried."
    return 1
  fi

  # An integrity assertion rather than decoration: AAP §0.6 records `pip check`
  # reporting "No broken requirements found." for exactly this pin set, so a
  # conflict here is a real regression in the manifest and not noise.
  if ! "${KUBE_PYTHON_VENV_BIN}/python" -m pip check; then
    kube::python::internal::log_error \
      "'pip check' reported broken requirements in ${KUBE_PYTHON_VENV} after installing ${KUBE_PYTHON_REQUIREMENTS}." \
      "The pinned set is expected to be internally consistent, so treat this as a manifest regression." \
      "Nothing was recorded, so the install will be retried on the next run."
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
