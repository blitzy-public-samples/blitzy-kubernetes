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

# This script lints and typechecks each Python file of the test tier under
# python/ by `ruff` and `mypy`.
# Usage: `hack/verify-python.sh`.
#
# With no arguments the whole python/ tree is checked. One or more paths may be
# given instead - repository-relative or tier-relative - and then only those are
# checked:
#
#   hack/verify-python.sh                            # the whole tier
#   hack/verify-python.sh python/tests/conftest.py   # one file
#   hack/verify-python.sh python/tests/unit          # one directory
#   WHAT=python make verify                          # through the aggregator
#
# The WHAT selector works because hack/make-rules/verify.sh's
# is-explicitly-chosen (L123-135) strips the `verify-` prefix and the extension
# from this filename. That same file discovers this script through its
# `hack/verify-*.sh` glob (L242), so it needs no registration anywhere, and it
# wraps the run in juLog with -fail="^ERROR: " (L147). Every line this script
# writes to announce a failure therefore begins with "ERROR: ", and every
# finding is written to stderr, which is the stream juLog records into the JUnit
# report. This script is deliberately absent from that file's QUICK_PATTERNS
# (L81-98), so `make quick-verify` prints "Skipping verify-python.sh in quick
# mode" - which is correct, and not a defect.
#
# AAP §0.5.1 (the hack/verify-python.sh row: "ruff plus mypy over python/;
# auto-registered by verify.sh's hack/verify-*.sh glob") / §0.8.1.5 (in scope) /
# §0.4.6 (gate wiring: creating this file "registers them automatically and
# verify.sh itself needs no edit") / §0.6.1.1 (the ruff 0.16.2 and mypy 2.3.0
# pins) / §0.9.3 (coverage is collected and reported but never gated, so nothing
# here gates on a percentage) / tech-spec §6.6.3.4 (the documentation convention
# this file follows).
#
# INVARIANT LOCKED BY THIS FILE: every Python file of the migrated test tier is
# lint-clean and type-clean under the exactly-pinned ruff and mypy from
# python/requirements-test.txt, judged solely by the configuration in
# python/pyproject.toml - and it is only ever checked, never rewritten.
#
# Modelled on hack/verify-shellcheck.sh, this repository's pattern for a
# pinned-tool verify gate. It runs no tests: `make test-python` does that
# through hack/make-rules/test-python.sh.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd -P)"
source "${KUBE_ROOT}/hack/lib/init.sh"
# hack/lib/init.sh sources util.sh, logging.sh, version.sh, golang.sh and
# etcd.sh, and deliberately not python.sh, so the Python provisioner is sourced
# here by the consumer - the same way hack/install-protoc.sh sources
# hack/lib/protoc.sh and hack/verify-web.sh sources hack/lib/node.sh.
source "${KUBE_ROOT}/hack/lib/python.sh"

# required versions for this script. These are not decoration: they are the
# versions whose findings this gate speaks for, and python/requirements-test.txt
# is their single source of truth. Keep them in sync with that manifest - the
# cross-check further down enforces it rather than trusting this comment.
RUFF_VERSION="0.16.2"
readonly RUFF_VERSION
MYPY_VERSION="2.3.0"
readonly MYPY_VERSION

# No ruff rule is disabled here, so there is deliberately no `disabled=()` array
# to drift out of sync with anything. Rule selection and suppression belong in
# python/pyproject.toml's [tool.ruff.lint] tables, so that a developer running
# `ruff check` by hand sees exactly what this gate sees.

# comma separate for naming which gates failed. Only the FIRST character of IFS
# separates the fields of "$*", so the separator is one character and every gate
# name is a single word - `join_by ', '` would still produce "ruff,mypy".
join_by() {
  local IFS="$1";
  shift;
  echo "$*";
}

# ensure we're linting the k8s source tree
cd "${KUBE_ROOT}"

# Resolve KUBE_PYTHON_DIR, KUBE_PYTHON_VENV_DIR, KUBE_PYTHON_REQUIREMENTS and
# KUBE_PYTHON_VENV_BIN. This creates nothing and touches no network.
kube::python::dirs

# The python/ tree lands file by file during the migration, so it may not be
# here yet. A gate for a tree that has not arrived must not fail the whole of
# `make verify`: it reports and succeeds.
if [[ ! -d "${KUBE_PYTHON_DIR}" ]]; then
  kube::log::status "no python/ tree found at ${KUBE_PYTHON_DIR}; nothing to verify"
  exit 0
fi

# The tier root, canonicalised, so that the containment test in python_relative
# cannot be fooled by a `python/../python` spelling or by a symlinked checkout.
python_root="$(cd "${KUBE_PYTHON_DIR}" && pwd -P)"
readonly python_root

# if KUBE_JUNIT_REPORT_DIR is set, disable colorized output.
# Colorized output causes malformed XML in the JUNIT report.
colorize=true
if [[ -n "${KUBE_JUNIT_REPORT_DIR:-}" ]]; then
  colorize=false
  # Belt and braces for every other process this script starts - pip while
  # provisioning, for instance - whose output lands in the same report. Both
  # gates honour NO_COLOR, and they are additionally passed explicit flags below.
  export NO_COLOR=1
fi
readonly colorize

# python_relative prints the path ${1} expressed relative to the tier root, so
# that it can be handed to ruff and mypy from inside python/. On return that
# relative path has been printed, or nothing has been printed to stdout, an
# actionable ERROR:-prefixed message is on stderr and the status is non-zero
# because ${1} does not exist or lies outside the one tree this gate owns.
#
# Three spellings are accepted, in this order of preference: as given - which,
# the working directory now being the repository root, is the repository-relative
# spelling `make verify` and every failure message uses - then explicitly
# repository-relative for a caller that started elsewhere, then tier-relative for
# a caller standing in python/. realpath(1) is deliberately not used: this
# repository does not depend on it, and `cd ... && pwd -P` is the portable
# equivalent that KUBE_ROOT itself is built from.
python_relative() {
  local given=$1
  local candidate resolved

  for candidate in "${given}" "${KUBE_ROOT}/${given}" "${python_root}/${given}"; do
    [[ -e "${candidate}" ]] || continue

    if [[ -d "${candidate}" ]]; then
      resolved="$(cd "${candidate}" && pwd -P)"
    else
      resolved="$(cd "$(dirname "${candidate}")" && pwd -P)/$(basename "${candidate}")"
    fi

    case "${resolved}" in
      "${python_root}")
        echo "."
        return 0
        ;;
      "${python_root}"/*)
        echo "${resolved#"${python_root}/"}"
        return 0
        ;;
    esac

    kube::log::usage \
      "ERROR: ${given} resolves to ${resolved}, which is outside ${KUBE_PYTHON_DIR}." \
      "hack/verify-python.sh covers the python/ tree only. Shell scripts are checked by" \
      "hack/verify-shellcheck.sh, Go by hack/verify-gofmt.sh and the web tier by hack/verify-web.sh."
    return 1
  done

  kube::log::usage \
    "ERROR: no such file or directory: ${given}" \
    "Give a path inside python/, either repository-relative (python/tests/conftest.py) or" \
    "tier-relative (tests/conftest.py), or give no path at all to check the whole tier."
  return 1
}

# The paths handed to both gates, each relative to the tier root.
targets=()
if [[ "$#" -gt 0 ]]; then
  # Explicit paths. Every one is resolved and its containment checked before any
  # tool starts, so a typo is reported as a typo rather than as a lint failure.
  # Unlike the default below they are NOT filtered against .gitignore: asking for
  # a path explicitly is reason enough to check it.
  target_errors=0
  for argument in "$@"; do
    if relative="$(python_relative "${argument}")"; then
      targets+=("${relative}")
    else
      target_errors=$((target_errors + 1))
    fi
  done
  if [[ "${target_errors}" -ne 0 ]]; then
    exit 1
  fi
else
  # The whole tier: every Python file, excluding
  # - the virtual environment. It is generated, holds thousands of third-party
  #   files, and by default is a symlink to an out-of-tree store that find(1)
  #   will not descend into anyway; the exclusion still earns its keep when an
  #   operator sets KUBE_PYTHON_VENV_STORE to build the environment in place.
  # - generated caches. Running this gate creates .ruff_cache/ and .mypy_cache/
  #   inside the tier, and `make test-python` creates .pytest_cache/ and
  #   __pycache__/, so all four are excluded here for the same reason
  #   python/pyproject.toml excludes them from ruff and mypy themselves.
  # - anything git-ignored, for the reason hack/verify-shellcheck.sh L61 gives:
  #   there is no need to lint untracked files. `git check-ignore` also fails
  #   with 128 outside a work tree, and that is treated as "not ignored" - the
  #   same conservative direction that file takes.
  while IFS=$'\n' read -r python_file; do
    git check-ignore -q "${python_file}" ||
      targets+=("${python_file#"${python_root}/"}")
  done < <(find "${python_root}" -type f -name '*.py' \
    -not \( \
      -path "${python_root}/.venv/*" -o \
      -path '*/__pycache__/*'        -o \
      -path '*/.pytest_cache/*'      -o \
      -path '*/.mypy_cache/*'        -o \
      -path '*/.ruff_cache/*'        \
    \) | sort)

  if [[ "${#targets[@]}" -eq 0 ]]; then
    kube::log::status \
      "no Python sources under ${KUBE_PYTHON_DIR}; nothing to verify (migration in progress)"
    exit 0
  fi
fi

# manifest_pin prints the version python/requirements-test.txt pins for the
# distribution ${1}. On return that version has been printed, or nothing has
# been printed because the manifest does not exist or does not pin it. The
# pattern is anchored at the start of a line so the prose in that file's comments
# cannot match, and only the first pin is reported because pip honours only the
# first.
manifest_pin() {
  local distribution=$1
  local pinned

  [[ -f "${KUBE_PYTHON_REQUIREMENTS}" ]] || return 0

  pinned="$(sed -n -E \
    "s/^[[:space:]]*${distribution}[[:space:]]*==[[:space:]]*([^[:space:];#]+).*/\\1/p" \
    "${KUBE_PYTHON_REQUIREMENTS}")"
  awk 'NR == 1 { print }' <<<"${pinned}"
}

# THE CONFIGURATION THIS GATE SPEAKS FOR MUST EXIST.
#
# Everything below is reached only when there is at least one Python input to
# check (the empty-tier case has already exited 0 above), and from that point on
# an absent python/pyproject.toml is a HARD FAILURE rather than a silent
# fallback. Both tools would otherwise run on their own defaults: ruff would
# apply its default rule selection instead of the [tool.ruff.lint] tables, and
# mypy would run without the strict settings, the mypy_path, the
# namespace_packages and the explicit_package_bases that make this tier
# typecheckable at all - so the gate would approve code against rules nobody
# chose. The pinned manifest is required for the same reason: it is what
# hack/lib/python.sh installs, so without it there is no pinned tool to speak
# for, and the version assertion below would have nothing to compare against.
if [[ ! -f "${KUBE_PYTHON_DIR}/pyproject.toml" ]]; then
  kube::log::usage \
    "ERROR: ${#targets[@]} Python path(s) exist under ${KUBE_PYTHON_DIR}, but ${KUBE_PYTHON_DIR}/pyproject.toml is missing." \
    "ruff and mypy take their WHOLE configuration from that file, so running them without it would" \
    "check this tier against default rule sets rather than the ones it declares - an approval that means nothing." \
    "Restore python/pyproject.toml from version control before running this gate."
  exit 1
fi

if [[ ! -f "${KUBE_PYTHON_REQUIREMENTS}" ]]; then
  kube::log::usage \
    "ERROR: ${#targets[@]} Python path(s) exist under ${KUBE_PYTHON_DIR}, but ${KUBE_PYTHON_REQUIREMENTS} is missing." \
    "That manifest is what hack/lib/python.sh installs, so there is no pinned ruff or mypy for this gate to speak for." \
    "Restore python/requirements-test.txt from version control before running this gate."
  exit 1
fi

# Track every gate that fails, and the aggregate status, so that both gates run
# and one report names all of the problems - the hack/verify-shellcheck.sh
# L110-119 accumulate-rather-than-abort pattern.
#
# ${res} keeps the FIRST non-zero status rather than the last, so the exit code
# names the first thing that went wrong while ${failed_gates} names all of them.
# The two ..._findings flags are narrower than "this gate failed": they are set
# only when a gate actually ran and reported something, which is what decides
# whether the remediation advice at the end is applicable. A gate that could not
# run at all has already been told how to reinstall itself.
res=0
failed_gates=()
ruff_findings=false
mypy_findings=false

# The pins above and the manifest must agree. The manifest is what actually gets
# installed, so a gate claiming a different version is speaking for a tool it did
# not pin. This is the same class of assertion
# hack/verify-external-dependencies-version.sh makes for pinned artifacts, and it
# is what turns the "keep them in sync" comment above into something enforced.
for pin in "ruff:${RUFF_VERSION}" "mypy:${MYPY_VERSION}"; do
  distribution="${pin%%:*}"
  expected="${pin##*:}"
  pinned="$(manifest_pin "${distribution}")"
  if [[ -z "${pinned}" ]]; then
    # The manifest exists (checked above) but pins nothing for this tool, so
    # nothing enforces which version gets installed. Fatal for the same reason a
    # mismatch is: the gate would speak for whatever pip happened to resolve.
    kube::log::usage \
      "ERROR: ${KUBE_PYTHON_REQUIREMENTS} pins no version for ${distribution}, so this gate cannot" \
      "speak for a known version of it. Add '${distribution}==${expected}' to that manifest, which is" \
      "the single source of truth for what hack/lib/python.sh installs."
    failed_gates+=("${distribution}-version-pin")
    res=1
  elif [[ "${pinned}" != "${expected}" ]]; then
    kube::log::usage \
      "ERROR: ${distribution} is pinned at ${pinned} in ${KUBE_PYTHON_REQUIREMENTS}," \
      "but hack/verify-python.sh expects ${expected}, so this gate no longer speaks for" \
      "the tool that gets installed. That manifest is the single source of truth:" \
      "set ${distribution^^}_VERSION to ${pinned} in the same change that moved the pin."
    failed_gates+=("${distribution}-version-pin")
    res=1
  fi
done

# A missing or too-old interpreter is the one failure this gate cannot work
# around. kube::python::validate names the detected version, the >= 3.10 floor
# that pytest 9 imposes and how to fix it, all ERROR:-prefixed, so a developer
# never sees a bare `set -e` trace instead of an explanation.
if ! kube::python::validate; then
  exit 1
fi

# Provision the tier rather than failing when the gates are absent. This creates
# the isolated virtual environment if it is missing and installs the pinned
# manifest into it, and it is stamp-guarded on that manifest, so a second run is
# a no-op. Nothing is installed into the system interpreter, and nothing is added
# to hack/tools - that is a Go module, and a Python tool there would enter the Go
# module graph. No entry in build/dependencies.yaml is needed either, because no
# new pinned external artifact is introduced.
if [[ ! -x "${KUBE_PYTHON_VENV_BIN}/python" ]]; then
  kube::log::status \
    "the Python lint and type gates are not provisioned yet; installing them with hack/lib/python.sh"
fi
if ! kube::python::install; then
  kube::log::usage \
    "ERROR: could not provision the Python lint and type gates in ${KUBE_PYTHON_VENV_DIR}." \
    "The pinned set is ${KUBE_PYTHON_REQUIREMENTS}, and installing it needs access to the" \
    "Python package index. Reproduce with: hack/verify-python.sh"
  exit 1
fi

venv_python="${KUBE_PYTHON_VENV_BIN}/python"
readonly venv_python

# tool_version prints the version of the ruff or mypy installed in the virtual
# environment. On return "X.Y.Z" has been printed, or nothing has been printed
# and the status is non-zero because the module is not installed there. Both
# tools report `<name> <version>[ ...]` - mypy appends "(compiled: yes)" - so the
# second field of the first line is the version.
tool_version() {
  local module=$1
  local reported

  reported="$("${venv_python}" -m "${module}" --version 2>/dev/null)" || return 1
  awk 'NR == 1 { print $2 }' <<<"${reported}"
}

# assert_gate_available reports whether the gate ${1}, pinned at ${2}, can run,
# having been given its installed version as ${3}. On return the status says so,
# and an absent gate or a version that has drifted from the pin has produced an
# ERROR:-prefixed explanation naming the fix.
#
# AN EXACT-VERSION MISMATCH IS FATAL, NOT A WARNING. hack/verify-shellcheck.sh
# L78-86 can afford a detect-then-decide posture because it reports findings from
# whatever shellcheck it finds; this gate cannot, because its verdict is what
# `make verify` reports. A near version enforces a near rule set - ruff and mypy
# both add, remove and re-scope diagnostics between patch releases - so approving
# on one means approving code that the PINNED tool may reject, which is a gate
# that speaks for a tool nobody installed. The pinned version is installed by
# hack/lib/python.sh from ${KUBE_PYTHON_REQUIREMENTS}, so a mismatch means the
# environment is stale rather than that the developer is unlucky, and rebuilding
# it is a one-line fix rather than a reason to lower the bar.
assert_gate_available() {
  local gate=$1
  local pinned=$2
  local installed=$3

  if [[ -z "${installed}" ]]; then
    kube::log::usage \
      "ERROR: ${gate} is not installed in ${KUBE_PYTHON_VENV_DIR}, so that gate could not run." \
      "${gate} is pinned at ${pinned} in ${KUBE_PYTHON_REQUIREMENTS}." \
      "Rebuild the environment with: rm -rf ${KUBE_PYTHON_VENV_DIR} && hack/verify-python.sh"
    return 1
  fi

  if [[ "${installed}" != "${pinned}" ]]; then
    kube::log::usage \
      "ERROR: ${gate} ${installed} is installed, but ${pinned} is pinned in ${KUBE_PYTHON_REQUIREMENTS}," \
      "so this gate would speak for a tool that is not the one this tier pins." \
      "Findings from a different version are not interchangeable: neither approval nor rejection carries over." \
      "Rebuild the environment with: rm -rf ${KUBE_PYTHON_VENV_DIR} && hack/verify-python.sh"
    return 1
  fi
  return 0
}

# Both gates are run from inside the tier root, taking their whole configuration
# from python/pyproject.toml. That working directory is required rather than
# tidy: mypy discovers its configuration from the current directory instead of
# walking up from the files it is given, and its mypy_path, namespace_packages
# and explicit_package_bases settings there are what stop the tier's several
# conftest.py files colliding as `Duplicate module named "conftest"`.
#
# Their findings are redirected to stderr, because that is the stream juLog
# records and greps for "^ERROR: " when building the JUnit failure message.
ruff_installed="$(tool_version ruff)" || ruff_installed=""
if ! assert_gate_available "ruff" "${RUFF_VERSION}" "${ruff_installed}"; then
  failed_gates+=("ruff")
  res=1
else
  kube::log::status \
    "Linting ${#targets[@]} Python path(s) under ${KUBE_PYTHON_DIR} with ruff ${ruff_installed}"
  # No --fix and no --unsafe-fixes, by design: a verify gate reports, an
  # update-* script rewrites. --force-exclude makes python/pyproject.toml's
  # extend-exclude authoritative even for a path named explicitly on the
  # command line, so the virtual environment and the caches stay out of scope
  # however this script is invoked.
  ruff_command=("${venv_python}" -m ruff check --force-exclude)
  if ${colorize}; then
    ruff_command+=("--color=auto")
  else
    ruff_command+=("--color=never")
  fi

  ruff_result=0
  (
    cd "${python_root}"
    "${ruff_command[@]}" "${targets[@]}"
  ) >&2 || ruff_result=$?

  if [[ "${ruff_result}" -ne 0 ]]; then
    kube::log::usage \
      "ERROR: ruff ${ruff_installed} reported lint findings under ${KUBE_PYTHON_DIR} (exit ${ruff_result})."
    failed_gates+=("ruff")
    ruff_findings=true
    if [[ "${res}" -eq 0 ]]; then
      res="${ruff_result}"
    fi
  fi
fi

# mypy runs even when ruff failed, so that one invocation surfaces every class of
# problem instead of only the first.
mypy_installed="$(tool_version mypy)" || mypy_installed=""
if ! assert_gate_available "mypy" "${MYPY_VERSION}" "${mypy_installed}"; then
  failed_gates+=("mypy")
  res=1
else
  kube::log::status \
    "Typechecking ${#targets[@]} Python path(s) under ${KUBE_PYTHON_DIR} with mypy ${mypy_installed}"
  mypy_command=("${venv_python}" -m mypy)
  if ! ${colorize}; then
    # ruff spells this --color=never; mypy 2.3.0 has no --color flag at all and
    # ruff 0.16.2 has no --no-color, so neither switch is interchangeable.
    mypy_command+=("--no-color-output")
  fi

  mypy_result=0
  (
    cd "${python_root}"
    "${mypy_command[@]}" "${targets[@]}"
  ) >&2 || mypy_result=$?

  if [[ "${mypy_result}" -ne 0 ]]; then
    kube::log::usage \
      "ERROR: mypy ${mypy_installed} reported type findings under ${KUBE_PYTHON_DIR} (exit ${mypy_result})."
    failed_gates+=("mypy")
    mypy_findings=true
    if [[ "${res}" -eq 0 ]]; then
      res="${mypy_result}"
    fi
  fi
fi

# print a message based on the result
if [[ "${res}" -eq 0 ]]; then
  kube::log::status \
    "Congratulations! The Python test tier passes ruff ${ruff_installed} and mypy ${mypy_installed} :-)"
else
  {
    echo
    echo "ERROR: the Python test tier failed these gates: $(join_by ',' "${failed_gates[@]:-unknown}")"
    echo
    echo 'Please review the above findings. You can test via "./hack/verify-python.sh", or'
    echo 'narrow it to one path with "./hack/verify-python.sh python/tests/<path>".'
    # Only advise a fix for a gate that actually produced findings: telling a
    # developer to run `ruff --fix` over a mypy error, or over a ruff that is not
    # even installed, sends them the wrong way.
    if ${ruff_findings}; then
      echo 'This gate never rewrites a file. The lint findings above are fixable with:'
      echo "  ${KUBE_PYTHON_VENV_DIR}/bin/ruff check --fix ${KUBE_PYTHON_DIR}"
      echo 'The formatter is offered to authors and is deliberately not gated here:'
      echo "  ${KUBE_PYTHON_VENV_DIR}/bin/ruff format ${KUBE_PYTHON_DIR}"
      echo 'Rule selection lives in python/pyproject.toml under [tool.ruff.lint].'
    fi
    if ${mypy_findings}; then
      echo 'Type findings are not auto-fixable: correct or annotate the code. The settings'
      echo 'that produced them live in python/pyproject.toml under [tool.mypy].'
    fi
    echo 'The two tool versions live in python/requirements-test.txt. In general please'
    echo 'prefer fixing the finding over adding a "# noqa" or a "# type: ignore" (if your'
    echo 'reviewer is okay with it): RUF100 and warn_unused_ignores each flag one of those'
    echo 'the moment it stops suppressing anything.'
    echo
  } >&2
fi

# preserve the result
exit "${res}"

