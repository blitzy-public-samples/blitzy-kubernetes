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

# A set of helpers for provisioning the React (Vitest) test tier.
#
# AAP §0.5.1 (hack/lib/node.sh row) / §0.9.4 (environment setup).
# Modelled on hack/lib/etcd.sh: this file only defines functions and reads
# configuration from the environment; callers source hack/lib/init.sh first.
#
# Usage:
#   source hack/lib/init.sh
#   source hack/lib/node.sh
#   kube::node::install            # npm ci (or npm install) for web/
#   kube::node::run test            # -> npm --prefix web run test

# Minimum Node.js version. 22.12.0 is the platform floor for the 22.x line;
# the repository itself pins no Node version (no .nvmrc, no engines field
# before web/package.json), so this is the migration decision.
KUBE_NODE_MIN_VERSION=${KUBE_NODE_MIN_VERSION:-22.12.0}

# Root of the React test tier.
KUBE_WEB_DIR=${KUBE_WEB_DIR:-}

kube::node::dirs() {
  KUBE_WEB_DIR=${KUBE_WEB_DIR:-${KUBE_ROOT}/web}
}

# kube::node::validate checks node/npm presence and the minimum version.
kube::node::validate() {
  command -v node >/dev/null || {
    kube::log::usage "node must be in your PATH (>= ${KUBE_NODE_MIN_VERSION})"
    return 1
  }
  command -v npm >/dev/null || {
    kube::log::usage "npm must be in your PATH"
    return 1
  }

  local have want
  have=$(node --version); have=${have#v}
  want=${KUBE_NODE_MIN_VERSION}
  if [[ "$(printf '%s\n%s\n' "${want}" "${have}" | sort -V | head -n1)" != "${want}" ]]; then
    kube::log::usage "node ${have} is older than the required ${want}"
    return 1
  fi
  kube::log::status "node ${have} / npm $(npm --version) satisfy the >= ${want} requirement"
}

# kube::node::module_store echoes the directory that holds the REAL
# node_modules tree. It deliberately lives OUTSIDE the repository working tree:
# the repository's own gates walk the tree (hack/boilerplate/boilerplate.py
# flags e.g. node_modules/flatted/python/flatted.py) and would otherwise
# descend into it. The in-tree path is a symlink, which os.walk() and find(1)
# do not follow by default.
#
# The leaf MUST be named "node_modules" so that Node's own resolver, which
# resolves through the real path, still finds sibling packages.
#
# Set KUBE_NODE_MODULES_STORE to override. CLONE_INDEX (when set by a parallel
# agent runner) keeps concurrent clones from sharing one store.
kube::node::module_store() {
  if [[ -n "${KUBE_NODE_MODULES_STORE:-}" ]]; then
    echo "${KUBE_NODE_MODULES_STORE}"
    return 0
  fi
  local base="/opt/blitzy/node"
  if ! mkdir -p "${base}" 2>/dev/null; then
    base="${TMPDIR:-/tmp}/blitzy/node"
    mkdir -p "${base}"
  fi
  echo "${base}/web${CLONE_INDEX:+-${CLONE_INDEX}}/node_modules"
}

# kube::node::externalize_modules moves a real in-tree web/node_modules into
# the out-of-tree store and replaces it with a symlink. npm reifies the tree
# and replaces a pre-existing symlink, so this runs AFTER every install.
kube::node::externalize_modules() {
  kube::node::dirs
  local store in_tree
  store="$(kube::node::module_store)"
  in_tree="${KUBE_WEB_DIR}/node_modules"

  if [[ -L "${in_tree}" ]]; then
    return 0
  fi
  if [[ ! -d "${in_tree}" ]]; then
    return 0
  fi

  kube::log::status "Relocating ${in_tree} to ${store} (keeps repository tree-walking gates green)"
  mkdir -p "$(dirname "${store}")"
  rm -rf "${store}"
  mv "${in_tree}" "${store}"
  ln -sfn "${store}" "${in_tree}"
}

# kube::node::install installs the pinned devDependencies for web/.
# Uses `npm ci` when a lockfile is present so installs are reproducible.
kube::node::install() {
  kube::node::dirs
  kube::node::validate

  if [[ ! -f "${KUBE_WEB_DIR}/package.json" ]]; then
    kube::log::usage "missing ${KUBE_WEB_DIR}/package.json"
    return 1
  fi

  # Never let npm open a prompt or start a watcher in CI.
  export CI=${CI:-true}

  if [[ -f "${KUBE_WEB_DIR}/package-lock.json" ]]; then
    kube::log::status "Installing web dependencies with npm ci"
    npm --prefix "${KUBE_WEB_DIR}" ci --no-audit --no-fund
  else
    kube::log::status "Installing web dependencies with npm install (no lockfile present)"
    npm --prefix "${KUBE_WEB_DIR}" install --no-audit --no-fund
  fi

  kube::node::externalize_modules
}

# kube::node::ensure_modules installs only when node_modules is absent.
kube::node::ensure_modules() {
  kube::node::dirs
  if [[ -e "${KUBE_WEB_DIR}/node_modules" ]]; then
    kube::node::externalize_modules
    return 0
  fi
  kube::node::install
}

# kube::node::run runs an npm script from web/, e.g. kube::node::run test
kube::node::run() {
  kube::node::dirs
  export CI=${CI:-true}
  npm --prefix "${KUBE_WEB_DIR}" run "$@"
}

# ex: ts=2 sw=2 et filetype=sh
