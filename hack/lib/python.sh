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

# A set of helpers for provisioning the Python (pytest) test tier.
#
# AAP §0.5.1 (hack/lib/python.sh row) / §0.9.4 (environment setup).
# Modelled on hack/lib/etcd.sh: this file only defines functions and reads
# configuration from the environment; callers source hack/lib/init.sh first.
#
# Usage:
#   source hack/lib/init.sh
#   source hack/lib/python.sh
#   kube::python::install          # create venv (if needed) + install pinned deps
#   "$(kube::python::bin)" -m pytest ...

# The Python minor series the migration targets. The repository pins no Python
# version, so this is the migration decision recorded in AAP §0.9.4.1.
# pytest 9 requires >= 3.10; do not go below that floor.
KUBE_PYTHON_VERSION=${KUBE_PYTHON_VERSION:-3.12}
KUBE_PYTHON_MIN_VERSION=${KUBE_PYTHON_MIN_VERSION:-3.10}

# Where the tree-visible virtual environment appears.
KUBE_PYTHON_VENV_DIR=${KUBE_PYTHON_VENV_DIR:-}

# Root of the Python test tier.
KUBE_PYTHON_DIR=${KUBE_PYTHON_DIR:-}

kube::python::dirs() {
  KUBE_PYTHON_DIR=${KUBE_PYTHON_DIR:-${KUBE_ROOT}/python}
  KUBE_PYTHON_VENV_DIR=${KUBE_PYTHON_VENV_DIR:-${KUBE_PYTHON_DIR}/.venv}
}

# kube::python::venv_store echoes the directory that holds the REAL virtual
# environment. It deliberately lives OUTSIDE the repository working tree: the
# repository's own gates walk the tree (hack/boilerplate/boilerplate.py,
# hack/verify-shellcheck.sh, ...) and would otherwise descend into
# site-packages. The tree-visible path is a symlink, which os.walk() and
# find(1) do not follow by default.
#
# Set KUBE_PYTHON_VENV_STORE to override. CLONE_INDEX (when set by a parallel
# agent runner) keeps concurrent clones from sharing one store.
kube::python::venv_store() {
  if [[ -n "${KUBE_PYTHON_VENV_STORE:-}" ]]; then
    echo "${KUBE_PYTHON_VENV_STORE}"
    return 0
  fi
  local base="/opt/blitzy/venv"
  if ! mkdir -p "${base}" 2>/dev/null; then
    base="${TMPDIR:-/tmp}/blitzy/venv"
    mkdir -p "${base}"
  fi
  echo "${base}/k8s-python-tier${CLONE_INDEX:+-${CLONE_INDEX}}"
}

# kube::python::interpreter echoes an interpreter for KUBE_PYTHON_VERSION,
# preferring an exact minor match and falling back to any python3 that meets
# KUBE_PYTHON_MIN_VERSION.
kube::python::interpreter() {
  local candidate
  for candidate in "python${KUBE_PYTHON_VERSION}" python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      if "${candidate}" -c "import sys; sys.exit(0 if sys.version_info[:2] == tuple(int(p) for p in \"${KUBE_PYTHON_VERSION}\".split('.')) else 1)" 2>/dev/null; then
        command -v "${candidate}"
        return 0
      fi
    fi
  done

  # uv-managed interpreters (python-build-standalone) are used when the distro
  # ships no package for the target minor version.
  if command -v uv >/dev/null 2>&1; then
    local uv_python
    if uv_python=$(uv python find "${KUBE_PYTHON_VERSION}" 2>/dev/null); then
      echo "${uv_python}"
      return 0
    fi
  fi

  for candidate in python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1 &&
      "${candidate}" -c "import sys; sys.exit(0 if sys.version_info >= tuple(int(p) for p in \"${KUBE_PYTHON_MIN_VERSION}\".split('.')) else 1)" 2>/dev/null; then
      kube::log::status "python${KUBE_PYTHON_VERSION} not found; falling back to $(command -v "${candidate}") ($("${candidate}" -V 2>&1))"
      command -v "${candidate}"
      return 0
    fi
  done

  kube::log::usage "no python interpreter >= ${KUBE_PYTHON_MIN_VERSION} found; install python${KUBE_PYTHON_VERSION} (or 'uv python install ${KUBE_PYTHON_VERSION}')"
  return 1
}

# kube::python::bin echoes the venv python, creating the venv if needed.
kube::python::bin() {
  kube::python::dirs
  if [[ ! -x "${KUBE_PYTHON_VENV_DIR}/bin/python" ]]; then
    kube::python::create_venv >&2
  fi
  echo "${KUBE_PYTHON_VENV_DIR}/bin/python"
}

kube::python::create_venv() {
  kube::python::dirs

  local store interpreter
  store="$(kube::python::venv_store)"
  interpreter="$(kube::python::interpreter)"

  if [[ ! -x "${store}/bin/python" ]]; then
    kube::log::status "Creating Python virtual environment in ${store} using ${interpreter}"
    rm -rf "${store}"
    "${interpreter}" -m venv "${store}"
    "${store}/bin/python" -m pip install --quiet --upgrade pip setuptools wheel
  fi

  mkdir -p "$(dirname "${KUBE_PYTHON_VENV_DIR}")"
  if [[ -e "${KUBE_PYTHON_VENV_DIR}" && ! -L "${KUBE_PYTHON_VENV_DIR}" ]]; then
    # A real in-tree venv breaks the repository's tree-walking gates; relocate.
    kube::log::status "Relocating in-tree venv ${KUBE_PYTHON_VENV_DIR} out of the repository walk"
    rm -rf "${KUBE_PYTHON_VENV_DIR}"
  fi
  ln -sfn "${store}" "${KUBE_PYTHON_VENV_DIR}"

  kube::log::status "Python venv ready: $("${KUBE_PYTHON_VENV_DIR}/bin/python" -V 2>&1) at ${KUBE_PYTHON_VENV_DIR} -> ${store}"
}

# kube::python::install creates the venv and installs the pinned test
# dependencies from python/requirements-test.txt.
kube::python::install() {
  kube::python::dirs
  kube::python::create_venv

  local requirements="${KUBE_PYTHON_DIR}/requirements-test.txt"
  if [[ ! -f "${requirements}" ]]; then
    kube::log::usage "missing ${requirements}"
    return 1
  fi

  kube::log::status "Installing pinned Python test dependencies from ${requirements}"
  "${KUBE_PYTHON_VENV_DIR}/bin/python" -m pip install --progress-bar off -r "${requirements}"
  "${KUBE_PYTHON_VENV_DIR}/bin/python" -m pip check
}

# kube::python::validate fails when the tier is not usable.
kube::python::validate() {
  kube::python::dirs
  if [[ ! -x "${KUBE_PYTHON_VENV_DIR}/bin/python" ]]; then
    kube::log::usage "Python venv missing; run: source hack/lib/python.sh && kube::python::install"
    return 1
  fi
  "${KUBE_PYTHON_VENV_DIR}/bin/python" -c "import pytest, sys; print('pytest', pytest.__version__, 'on', sys.version.split()[0])"
}

# ex: ts=2 sw=2 et filetype=sh
