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

# This script lints and typechecks the React test tier under web/.
# Usage: `hack/verify-web.sh`.
#
# AAP §0.5.1 (hack/verify-web.sh row) / §0.4.6 (gate wiring).
# hack/make-rules/verify.sh auto-discovers `hack/verify-*.sh`, so this file
# needs no registration anywhere.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/..
source "${KUBE_ROOT}/hack/lib/init.sh"
source "${KUBE_ROOT}/hack/lib/node.sh"

kube::node::dirs

if [[ ! -f "${KUBE_WEB_DIR}/package.json" ]]; then
  kube::log::status "no web/ tree present; nothing to verify"
  exit 0
fi

kube::node::ensure_modules

export CI=${CI:-true}

kube::log::status "Running eslint over ${KUBE_WEB_DIR}"
(
  cd "${KUBE_WEB_DIR}"
  # No --fix: this is a verification gate, never a mutation.
  npx eslint .
)

ts_files=()
kube::util::read-array ts_files < <(
  find "${KUBE_WEB_DIR}/src" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | sort
)

if [[ ${#ts_files[@]} -eq 0 ]]; then
  kube::log::status "no TypeScript sources under ${KUBE_WEB_DIR}/src; skipping tsc (migration in progress)"
  exit 0
fi

kube::log::status "Running tsc --noEmit over ${#ts_files[@]} TypeScript file(s)"
(
  cd "${KUBE_WEB_DIR}"
  # src/** (tsconfig.json) and the build tooling (tsconfig.node.json) are
  # separate invocations rather than project references, because a referenced
  # composite project may not disable emit (TS6310).
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.node.json
)
