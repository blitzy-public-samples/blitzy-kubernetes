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

# This script lints and typechecks the Python test tier under python/.
# Usage: `hack/verify-python.sh`.
#
# AAP §0.5.1 (hack/verify-python.sh row) / §0.4.6 (gate wiring).
# hack/make-rules/verify.sh auto-discovers `hack/verify-*.sh`, so this file
# needs no registration anywhere.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/..
source "${KUBE_ROOT}/hack/lib/init.sh"
source "${KUBE_ROOT}/hack/lib/python.sh"

kube::python::dirs

if [[ ! -d "${KUBE_PYTHON_DIR}" ]]; then
  kube::log::status "no python/ tree present; nothing to verify"
  exit 0
fi

# Count real sources, ignoring the (symlinked, out-of-tree) virtual environment.
py_files=()
kube::util::read-array py_files < <(
  find "${KUBE_PYTHON_DIR}" -name '*.py' -type f \
    -not -path "${KUBE_PYTHON_DIR}/.venv/*" \
    -not -path '*/__pycache__/*' | sort
)

if [[ ${#py_files[@]} -eq 0 ]]; then
  kube::log::status "no Python sources under ${KUBE_PYTHON_DIR}; nothing to verify (migration in progress)"
  exit 0
fi

kube::python::install >/dev/null

venv_python="${KUBE_PYTHON_VENV_DIR}/bin/python"

kube::log::status "Running ruff over ${#py_files[@]} Python file(s)"
(
  cd "${KUBE_PYTHON_DIR}"
  # `ruff check` never rewrites files: no --fix is passed, by design.
  # (`ruff format` is available for authors but is not gated here.)
  "${venv_python}" -m ruff check .
)

kube::log::status "Running mypy over ${KUBE_PYTHON_DIR}"
(
  cd "${KUBE_PYTHON_DIR}"
  "${venv_python}" -m mypy .
)
