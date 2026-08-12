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

# Runs the Python (pytest) test tier.
# Usage: `hack/make-rules/test-python.sh [pytest args...]` or `make test-python`.
#
# AAP §0.5.1 (hack/make-rules/test-python.sh row) / §0.9.1.1 (commands).
# Follows the reporting contract of hack/make-rules/test.sh: when
# KUBE_JUNIT_REPORT_DIR (or CI's ARTIFACTS) is set, JUnit XML is written there
# so TestGrid / triage / Spyglass keep working.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/../..
source "${KUBE_ROOT}/hack/lib/init.sh"
source "${KUBE_ROOT}/hack/lib/python.sh"

# Marker selection, e.g. KUBE_PYTHON_TEST_MARKERS="not integration".
KUBE_PYTHON_TEST_MARKERS=${KUBE_PYTHON_TEST_MARKERS:-}
# Parallelism: pytest-xdist worker count ("auto", "0" to disable, or a number).
KUBE_PYTHON_TEST_WORKERS=${KUBE_PYTHON_TEST_WORKERS:-0}
# Coverage collection, mirroring KUBE_COVER for the Go tier (default off).
KUBE_PYTHON_COVER=${KUBE_PYTHON_COVER:-n}

KUBE_JUNIT_REPORT_DIR=${KUBE_JUNIT_REPORT_DIR:-}
if [[ -z "${KUBE_JUNIT_REPORT_DIR:-}" && -n "${ARTIFACTS:-}" ]]; then
  KUBE_JUNIT_REPORT_DIR="${ARTIFACTS}"
fi

kube::python::dirs
kube::python::install

pytest_args=("$@")
if [[ -n "${KUBE_PYTHON_TEST_MARKERS}" ]]; then
  pytest_args+=("-m" "${KUBE_PYTHON_TEST_MARKERS}")
fi
if [[ "${KUBE_PYTHON_TEST_WORKERS}" != "0" ]]; then
  pytest_args+=("-n" "${KUBE_PYTHON_TEST_WORKERS}")
fi
if [[ "${KUBE_PYTHON_COVER}" =~ ^[yY]$ ]]; then
  pytest_args+=("--cov=tests" "--cov-report=term-missing" "--cov-report=xml")
fi
if [[ -n "${KUBE_JUNIT_REPORT_DIR}" ]]; then
  mkdir -p "${KUBE_JUNIT_REPORT_DIR}"
  pytest_args+=("--junitxml=${KUBE_JUNIT_REPORT_DIR}/python.xml")
fi

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

# The etcd binary and control-plane binaries the integration tier needs.
if [[ -d "${KUBE_ROOT}/third_party/etcd" ]]; then
  PATH="${PATH}:${KUBE_ROOT}/third_party/etcd"
  export PATH
fi

kube::log::status "Running Python tests: pytest ${pytest_args[*]:-}"
rc=0
(
  cd "${KUBE_PYTHON_DIR}"
  "${KUBE_PYTHON_VENV_DIR}/bin/python" -m pytest "${pytest_args[@]:+${pytest_args[@]}}"
) || rc=$?

# pytest exit code 5 means "no tests were collected". During the Go -> Python
# migration the tree is populated incrementally, so an empty tier is reported
# loudly but is not a failure. Any other non-zero code is a real failure.
if [[ ${rc} -eq 5 ]]; then
  kube::log::status "WARNING: no Python tests collected yet under ${KUBE_PYTHON_DIR}/tests (migration in progress)"
  rc=0
fi

exit ${rc}
