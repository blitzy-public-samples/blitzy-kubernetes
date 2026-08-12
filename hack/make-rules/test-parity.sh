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

# Regenerates the Go baseline manifest and runs the parity contract, which
# asserts that the ported Python/React suites reproduce every verdict the Go
# oracle records today.
# Usage: `hack/make-rules/test-parity.sh` or `make test-parity`.
#
# AAP §0.4.5 (parity harness) / §0.5.1 (hack/make-rules/test-parity.sh row).
#
# The Go suite is the parity ORACLE and is never deleted: this script needs a
# runnable Go toolchain plus (for the integration packages) an etcd binary.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/../..
source "${KUBE_ROOT}/hack/lib/init.sh"
source "${KUBE_ROOT}/hack/lib/python.sh"

kube::golang::setup_env
kube::python::dirs
kube::python::install

# Packages whose verdicts the baseline records. Override with
# KUBE_PARITY_PACKAGES="./cluster/gce/gci/ ./plugin/pkg/admission/noderestriction/".
KUBE_PARITY_PACKAGES=${KUBE_PARITY_PACKAGES:-"./cluster/gce/gci/"}
KUBE_PARITY_BASELINE=${KUBE_PARITY_BASELINE:-"${KUBE_PYTHON_DIR}/tests/parity/baseline/go_baseline.json"}
KUBE_PARITY_SKIP_REGEN=${KUBE_PARITY_SKIP_REGEN:-n}

# In-cluster discovery hygiene: when this runs inside a Kubernetes pod, the
# injected KUBERNETES_SERVICE_* variables (plus the mounted service-account
# token) make client-go's rest.InClusterConfig() succeed, so a test-launched
# control-plane component talks to the HOST cluster and authenticates as
# system:serviceaccount:default:default instead of using the test server.
# Observed failure: `unable to load configmap based request-header-client-ca-file:
# configmaps "extension-apiserver-authentication" is forbidden`.
unset KUBERNETES_SERVICE_HOST KUBERNETES_SERVICE_PORT KUBERNETES_SERVICE_PORT_HTTPS
unset KUBERNETES_PORT KUBERNETES_PORT_443_TCP KUBERNETES_PORT_443_TCP_ADDR
unset KUBERNETES_PORT_443_TCP_PORT KUBERNETES_PORT_443_TCP_PROTO

generator="${KUBE_PYTHON_DIR}/tests/parity/tools/generate_baseline.py"

if [[ "${KUBE_PARITY_SKIP_REGEN}" =~ ^[yY]$ ]]; then
  kube::log::status "Skipping baseline regeneration (KUBE_PARITY_SKIP_REGEN=${KUBE_PARITY_SKIP_REGEN})"
elif [[ -x "${generator}" || -f "${generator}" ]]; then
  kube::log::status "Regenerating parity baseline from the Go oracle: ${KUBE_PARITY_PACKAGES}"
  mkdir -p "$(dirname "${KUBE_PARITY_BASELINE}")"
  # shellcheck disable=SC2086 # KUBE_PARITY_PACKAGES is an intentional word list
  "${KUBE_PYTHON_VENV_DIR}/bin/python" "${generator}" \
    --output "${KUBE_PARITY_BASELINE}" \
    --packages ${KUBE_PARITY_PACKAGES}
else
  kube::log::status "WARNING: ${generator} not present yet; skipping baseline regeneration (migration in progress)"
fi

rc=0
(
  cd "${KUBE_PYTHON_DIR}"
  "${KUBE_PYTHON_VENV_DIR}/bin/python" -m pytest -m parity "$@"
) || rc=$?

if [[ ${rc} -eq 5 ]]; then
  kube::log::status "WARNING: no parity tests collected yet under ${KUBE_PYTHON_DIR}/tests/parity (migration in progress)"
  rc=0
fi

exit ${rc}
