#!/usr/bin/env bash

# Copyright 2014 The Kubernetes Authors.
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

# This script checks boilerplate header for all files.
# Usage: `hack/verify-boilerplate.sh`.
#
# A single file may be checked by passing its path, e.g.
# `hack/verify-boilerplate.sh web/src/App.tsx`: arguments are forwarded
# verbatim to hack/boilerplate/boilerplate.py.
#
# Coverage is driven by the reference templates that sit beside that checker,
# named hack/boilerplate/boilerplate.<ext>.txt. boilerplate.py's get_refs()
# globs them and takes each extension from the file name, so dropping in a
# template is all it takes to register one -- there is no extension list in
# this wrapper to edit. `.ts` and `.tsx` are covered by boilerplate.ts.txt and
# boilerplate.tsx.txt.
#
# Headers on newly added files must be year-less: `Copyright The Kubernetes
# Authors.` with no year. boilerplate.py's get_dates() still accepts a year up
# to 2025 on files that already carry one -- which is why this script's own
# 2014 header passes -- but a newly added file must not include one.
#
# For `.ts` and `.tsx` the header must be the literal first bytes of the file:
# no shebang, no leading blank line, no `"use client";` and no
# `/* eslint-disable */` above it. boilerplate.py strips build constraints only
# for Go and shebangs only for shell and Python, so nothing is stripped for
# TypeScript and anything preceding the header fails the check.
#
# Generated and vendored trees -- web/node_modules, python/.venv, __pycache__
# and the pre-existing entries -- are excluded through boilerplate.py's
# skipped_names, not here.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT=$(dirname "${BASH_SOURCE[0]}")/..

boilerDir="${KUBE_ROOT}/hack/boilerplate"
boiler="${boilerDir}/boilerplate.py"

files_need_boilerplate=()
while IFS=$'\n' read -r line; do
  files_need_boilerplate+=( "$line" )
done < <("${boiler}" "$@")

# Run boilerplate check
if [[ ${#files_need_boilerplate[@]} -gt 0 ]]; then
  for file in "${files_need_boilerplate[@]}"; do
    echo "Boilerplate header is wrong for: ${file}" >&2
  done

  exit 1
fi
