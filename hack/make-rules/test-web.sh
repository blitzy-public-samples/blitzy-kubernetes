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

# Runs the React (Vitest) test tier.
# Usage: `hack/make-rules/test-web.sh [vitest args...]` or `make test-web`.
#
# AAP §0.5.1 (hack/make-rules/test-web.sh row) / §0.9.1.2 (commands).
#
# Vitest 4 notes honoured here (AAP §0.2.2.2):
#   * the `basic` reporter was REMOVED -> use `default` (+ `junit` for CI).
#   * watch mode is never used in automation: always `vitest run`.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/../..
source "${KUBE_ROOT}/hack/lib/init.sh"
source "${KUBE_ROOT}/hack/lib/node.sh"

# Coverage collection, mirroring KUBE_COVER for the Go tier (default off).
KUBE_WEB_COVER=${KUBE_WEB_COVER:-n}

KUBE_JUNIT_REPORT_DIR=${KUBE_JUNIT_REPORT_DIR:-}
if [[ -z "${KUBE_JUNIT_REPORT_DIR:-}" && -n "${ARTIFACTS:-}" ]]; then
  KUBE_JUNIT_REPORT_DIR="${ARTIFACTS}"
fi

kube::node::dirs
kube::node::ensure_modules

export CI=${CI:-true}

vitest_args=("run" "--reporter=default")
if [[ "${KUBE_WEB_COVER}" =~ ^[yY]$ ]]; then
  vitest_args+=("--coverage")
fi
if [[ -n "${KUBE_JUNIT_REPORT_DIR}" ]]; then
  mkdir -p "${KUBE_JUNIT_REPORT_DIR}"
  vitest_args+=("--reporter=junit" "--outputFile.junit=${KUBE_JUNIT_REPORT_DIR}/web.xml")
fi

# During the Go -> Python/React migration the tier is populated incrementally.
# An empty tier is reported loudly but is not a failure; once specs exist the
# run fails normally on any failing spec.
# NOTE: the directory test is deliberate - `find` on a missing path returns
# non-zero and would abort this script under `set -o errexit -o pipefail`.
web_test_count=0
if [[ -d "${KUBE_WEB_DIR}/src" ]]; then
  web_test_count=$(find "${KUBE_WEB_DIR}/src" \
    -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | wc -l)
fi
if [[ "${web_test_count}" -eq 0 ]]; then
  kube::log::status "WARNING: no Vitest specs found under ${KUBE_WEB_DIR}/src (migration in progress)"
  vitest_args+=("--passWithNoTests")
elif [[ ! -f "${KUBE_WEB_DIR}/src/setupTests.ts" ]]; then
  # vitest.config.ts declares setupFiles: ['./src/setupTests.ts']; a missing
  # setup file produces a confusing module-resolution error, so say so plainly.
  kube::log::status "WARNING: ${KUBE_WEB_DIR}/src/setupTests.ts is missing but vitest.config.ts references it"
fi

kube::log::status "Running web tests: vitest ${vitest_args[*]} $*"
(
  cd "${KUBE_WEB_DIR}"
  npx vitest "${vitest_args[@]}" "$@"
)
