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

# This script lints and typechecks each source file of the React test tier under
# web/ by `eslint` and `tsc --noEmit`.
# Usage: `hack/verify-web.sh`.
#
# With no arguments the whole web/ tree is checked. One or more paths may be
# given instead - repository-relative or tier-relative - and then only those are
# checked:
#
#   hack/verify-web.sh                            # the whole tier
#   hack/verify-web.sh web/src/setupTests.ts      # one file
#   hack/verify-web.sh web/src/components         # one directory
#   WHAT=web make verify                          # through the aggregator
#
# The WHAT selector works because hack/make-rules/verify.sh's
# is-explicitly-chosen (L123-135) strips the `verify-` prefix and the extension
# from this filename. That same file discovers this script through its
# `hack/verify-*.sh` glob (L242), so it needs no registration anywhere, and it
# wraps the run in juLog with -fail="^ERROR: " (L147). Every line this script
# writes to announce a failure therefore begins with "ERROR: ", and every finding
# is written to stderr, which is the stream juLog records into the JUnit report.
# This script is deliberately absent from that file's QUICK_PATTERNS (L81-98), so
# `make quick-verify` prints "Skipping verify-web.sh in quick mode" - which is
# correct, and not a defect.
#
# AAP §0.5.1 (the hack/verify-web.sh row: "eslint plus `tsc --noEmit` over web/;
# auto-registered by verify.sh's hack/verify-*.sh glob") / §0.8.1.5 (in scope) /
# §0.4.6 (gate wiring: creating this file "registers them automatically and
# verify.sh itself needs no edit") / §0.6.1.2 (the eslint 10.8.1 and typescript
# 7.0.2 pins) / §0.3.4.3 and §0.9.4.1 (the Node runtime arrives through
# hack/lib/node.sh rather than as a pinned build/dependencies.yaml artifact, so
# hack/verify-external-dependencies-version.sh stays unaffected, and every Node
# tool runs with CI=true) / §0.8.2 and §0.9.3 (no test run, no coverage gate, no
# watch mode, no browser automation and no visual regression is reachable from
# here) / tech-spec §6.6.3.4 (the documentation convention this file follows).
#
# INVARIANT LOCKED BY THIS FILE: every source file of the migrated React test
# tier is lint-clean under the exactly-pinned eslint and type-clean under the
# exactly-pinned tsc, judged solely by the configuration in web/eslint.config.js,
# web/tsconfig.json and web/tsconfig.node.json - and it is only ever checked,
# never rewritten.
#
# Modelled on hack/verify-shellcheck.sh, this repository's pattern for a
# pinned-tool verify gate, and kept structurally identical to its sibling
# hack/verify-python.sh so that the two differ only in toolchain. It runs no
# tests: `make test-web` does that through hack/make-rules/test-web.sh.

set -o errexit
set -o nounset
set -o pipefail

KUBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd -P)"
source "${KUBE_ROOT}/hack/lib/init.sh"
# hack/lib/init.sh sources util.sh, logging.sh, version.sh, golang.sh and
# etcd.sh, and deliberately not node.sh, so the Node provisioner is sourced here
# by the consumer - the same way hack/install-protoc.sh sources
# hack/lib/protoc.sh and hack/verify-python.sh sources hack/lib/python.sh.
source "${KUBE_ROOT}/hack/lib/node.sh"

# required versions for this script. These are not decoration: they are the
# versions whose findings this gate speaks for, and web/package.json is their
# single source of truth. Keep them in sync with that manifest - the cross-check
# further down enforces it rather than trusting this comment.
ESLINT_VERSION="10.8.1"
readonly ESLINT_VERSION
TYPESCRIPT_VERSION="7.0.2"
readonly TYPESCRIPT_VERSION

# No eslint rule is disabled here, so there is deliberately no `disabled=()`
# array to drift out of sync with anything. Rule selection and suppression belong
# in web/eslint.config.js, and compiler strictness in web/tsconfig.json, so that
# a developer running `npm --prefix web run lint` by hand sees exactly what this
# gate sees.
#
# One consequence of that configuration is worth stating here, because it is why
# this gate runs two tools rather than one: web/eslint.config.js globally ignores
# **/*.ts and **/*.tsx - ESLint 10 bundles only espree, and typescript-eslint's
# peer range excludes the pinned TypeScript 7 - so `tsc --noEmit` is the ONLY
# gate the TypeScript surface gets. A run that quietly skipped it would leave
# .ts and .tsx unchecked altogether, which is why the tsc pass below runs even
# when eslint has already failed.

# comma separate for naming which gates failed. Only the FIRST character of IFS
# separates the fields of "$*", so the separator is one character and every gate
# name is a single word - `join_by ', '` would still produce "eslint,tsc".
join_by() {
  local IFS="$1";
  shift;
  echo "$*";
}

# ensure we're linting the k8s source tree
cd "${KUBE_ROOT}"

# Node tooling must never prompt and must never start a watcher inside a gate
# (AAP §0.9.4.1): a hung prompt in CI is indistinguishable from a wedged job.
# hack/lib/node.sh exports this too; it is repeated here so the requirement is
# visible at the point of use and holds even for a future refactor that stops
# this script from sourcing that library.
export CI=true

# Resolve KUBE_WEB_DIR, KUBE_NODE_PACKAGE_JSON, KUBE_NODE_PACKAGE_LOCK and
# KUBE_NODE_MODULES_BIN. This creates nothing and touches no network.
kube::node::dirs

# The web/ tree lands file by file during the migration, so it may not be here
# yet. A gate for a tree that has not arrived must not fail the whole of
# `make verify`: it reports and succeeds.
if [[ ! -d "${KUBE_WEB_DIR}" ]]; then
  kube::log::status "no web/ tree found at ${KUBE_WEB_DIR}; nothing to verify"
  exit 0
fi

# The tier root, canonicalised, so that the containment test in web_relative
# cannot be fooled by a `web/../web` spelling or by a symlinked checkout.
web_root="$(cd "${KUBE_WEB_DIR}" && pwd -P)"
readonly web_root

# if KUBE_JUNIT_REPORT_DIR is set, disable colorized output.
# Colorized output causes malformed XML in the JUNIT report.
colorize=true
if [[ -n "${KUBE_JUNIT_REPORT_DIR:-}" ]]; then
  colorize=false
  # Belt and braces for every other process this script starts - npm while
  # provisioning, for instance - whose output lands in the same report. npm and
  # eslint both honour NO_COLOR, and both gates are additionally passed explicit
  # flags below.
  export NO_COLOR=1
fi
readonly colorize

# web_relative prints the path ${1} expressed relative to the tier root, so that
# it can be handed to eslint from inside web/. On return that relative path has
# been printed, or nothing has been printed to stdout, an actionable
# ERROR:-prefixed message is on stderr and the status is non-zero because ${1}
# does not exist or lies outside the one tree this gate owns.
#
# Three spellings are accepted, in this order of preference: as given - which,
# the working directory now being the repository root, is the repository-relative
# spelling `make verify` and every failure message uses - then explicitly
# repository-relative for a caller that started elsewhere, then tier-relative for
# a caller standing in web/. realpath(1) is deliberately not used: this
# repository does not depend on it, and `cd ... && pwd -P` is the portable
# equivalent that KUBE_ROOT itself is built from.
web_relative() {
  local given=$1
  local candidate resolved

  for candidate in "${given}" "${KUBE_ROOT}/${given}" "${web_root}/${given}"; do
    [[ -e "${candidate}" ]] || continue

    if [[ -d "${candidate}" ]]; then
      resolved="$(cd "${candidate}" && pwd -P)"
    else
      resolved="$(cd "$(dirname "${candidate}")" && pwd -P)/$(basename "${candidate}")"
    fi

    case "${resolved}" in
      "${web_root}")
        echo "."
        return 0
        ;;
      "${web_root}"/*)
        echo "${resolved#"${web_root}/"}"
        return 0
        ;;
    esac

    kube::log::usage \
      "ERROR: ${given} resolves to ${resolved}, which is outside ${KUBE_WEB_DIR}." \
      "hack/verify-web.sh covers the web/ tree only. Shell scripts are checked by" \
      "hack/verify-shellcheck.sh, Go by hack/verify-gofmt.sh and the Python test tier by" \
      "hack/verify-python.sh."
    return 1
  done

  kube::log::usage \
    "ERROR: no such file or directory: ${given}" \
    "Give a path inside web/, either repository-relative (web/src/setupTests.ts) or" \
    "tier-relative (src/setupTests.ts), or give no path at all to check the whole tier."
  return 1
}

# The paths handed to eslint, each relative to the tier root.
targets=()
if [[ "$#" -gt 0 ]]; then
  # Explicit paths. Every one is resolved and its containment checked before any
  # tool starts, so a typo is reported as a typo rather than as a lint failure.
  # Unlike the default below they are NOT filtered against .gitignore: asking for
  # a path explicitly is reason enough to check it.
  target_errors=0
  for argument in "$@"; do
    if relative="$(web_relative "${argument}")"; then
      targets+=("${relative}")
    else
      target_errors=$((target_errors + 1))
    fi
  done
  if [[ "${target_errors}" -ne 0 ]]; then
    exit 1
  fi
else
  # The whole tier: every lintable or typecheckable source file, excluding
  # - the dependency tree. It is generated, holds thousands of third-party files,
  #   and by default is a symlink to an out-of-tree store that find(1) will not
  #   descend into anyway; the exclusion still earns its keep when an operator
  #   sets KUBE_NODE_MODULES_STORE to install the tree in place.
  # - generated output: the @vitest/coverage-v8 report directory named by
  #   web/vitest.config.ts, a Vite build, Vite's own cache and the JUnit report
  #   directory. These mirror the web/ entries in .gitignore and the
  #   globalIgnores in web/eslint.config.js.
  # - anything git-ignored, for the reason hack/verify-shellcheck.sh L61 gives:
  #   there is no need to lint untracked files. `git check-ignore` also fails
  #   with 128 when it cannot answer - for a KUBE_WEB_DIR pointed outside this
  #   work tree, say - and that is treated as "not ignored", the same
  #   conservative direction that file takes. Its diagnostics are discarded
  #   rather than shown: every failure mode leads to the same decision, so the
  #   text adds nothing, and one `fatal:` line per file would otherwise land in
  #   the JUnit report this gate is careful to keep clean.
  #
  # .cjs is enumerated although the tier has none today: web/package.json
  # declares "type": "module", so a CommonJS module would have to use that
  # extension, and it must not be able to enter the tree unchecked.
  while IFS=$'\n' read -r web_file; do
    git check-ignore -q "${web_file}" 2>/dev/null ||
      targets+=("${web_file#"${web_root}/"}")
  done < <(find "${web_root}" -type f \
    \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o \
       -name '*.ts' -o -name '*.tsx' \) \
    -not \( \
      -path "${web_root}/node_modules/*"  -o \
      -path "${web_root}/coverage/*"      -o \
      -path "${web_root}/dist/*"          -o \
      -path "${web_root}/.vite/*"         -o \
      -path "${web_root}/vitest-report/*" \
    \) | sort)

  if [[ "${#targets[@]}" -eq 0 ]]; then
    kube::log::status \
      "no web sources under ${KUBE_WEB_DIR}; nothing to verify (migration in progress)"
    exit 0
  fi
fi

# tsc takes a PROJECT, never a file list: naming files on its command line makes
# it ignore tsconfig.json altogether and fall back to default compiler options,
# which would bury the real diagnostics under invented ones about an unset jsx
# mode and absent global types. So the targets above select WHICH of the tier's
# two projects to typecheck rather than what to hand tsc directly:
#
#   web/tsconfig.json       covers the tier sources     (include: ["src"])
#   web/tsconfig.node.json  covers the build tooling    (include: ["vite.config.ts",
#                                                        "vitest.config.ts"])
#
# They are two separate invocations rather than one solution-style project
# because composite conflicts with --noEmit (TS6304) and a cross-linked composite
# project may not disable emit at all (TS6310); web/tsconfig.json's own header
# records that constraint and that this gate depends on the bare-`tsc` shape.
#
# A path in neither project - web/eslint.config.js, say, which is JavaScript and
# is covered by the eslint pass - selects no project, and that is reported rather
# than silently passing.
check_src_project=false
check_node_project=false
for target in "${targets[@]}"; do
  case "${target}" in
    '.')
      check_src_project=true
      check_node_project=true
      ;;
    src | src/*)
      check_src_project=true
      ;;
    vite.config.ts | vitest.config.ts)
      check_node_project=true
      ;;
  esac
done
readonly check_src_project check_node_project

# THE MANIFESTS THIS GATE SPEAKS FOR MUST EXIST.
#
# This point is reached only when there is at least one web input to check (the
# empty-tier case has already exited 0 above), and from there an absent
# package.json or lockfile is a HARD FAILURE. Without them there is no pinned
# eslint and no pinned tsc for the gate to speak for, `npm ci` cannot install a
# reproducible tree at all, and the version assertions below would have nothing
# to compare against - so the gate would report on whatever versions happened to
# be lying in node_modules.
if [[ ! -f "${KUBE_NODE_PACKAGE_JSON}" ]]; then
  kube::log::usage \
    "ERROR: ${#targets[@]} web path(s) exist under ${KUBE_WEB_DIR}, but ${KUBE_NODE_PACKAGE_JSON} is missing." \
    "That manifest pins eslint and typescript, so without it this gate cannot know which versions it speaks for." \
    "Restore web/package.json from version control before running this gate."
  exit 1
fi

if [[ ! -f "${KUBE_NODE_PACKAGE_LOCK}" ]]; then
  kube::log::usage \
    "ERROR: ${#targets[@]} web path(s) exist under ${KUBE_WEB_DIR}, but ${KUBE_NODE_PACKAGE_LOCK} is missing." \
    "'npm ci' installs from the lockfile and cannot run without one, so the gates cannot be provisioned reproducibly." \
    "Restore web/package-lock.json from version control before running this gate."
  exit 1
fi

# manifest_pin prints the version web/package.json pins for the npm package
# ${1}. On return that version has been printed, or nothing has been printed
# because the manifest does not pin it.
#
# The dependency blocks of web/package.json hold one `"name": "version"` pair per
# line, so a line-anchored sed is enough and this gate acquires no dependency on
# jq, which this repository does not require. Anchoring on the quoted key means a
# version string appearing anywhere else cannot match, and only the first pin is
# reported because the tier declares each package exactly once.
manifest_pin() {
  local package=$1
  local pinned

  [[ -f "${KUBE_NODE_PACKAGE_JSON}" ]] || return 0

  pinned="$(sed -n -E \
    "s/^[[:space:]]*\"${package}\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/p" \
    "${KUBE_NODE_PACKAGE_JSON}")"
  awk 'NR == 1 { print }' <<<"${pinned}"
}

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
eslint_findings=false
tsc_findings=false

# The pins above and the manifest must agree. The manifest is what actually gets
# installed, so a gate claiming a different version is speaking for a tool it did
# not pin. This is the same class of assertion
# hack/verify-external-dependencies-version.sh makes for pinned artifacts, and it
# is what turns the "keep them in sync" comment above into something enforced.
for pin in "eslint:${ESLINT_VERSION}" "typescript:${TYPESCRIPT_VERSION}"; do
  package="${pin%%:*}"
  expected="${pin##*:}"
  pinned="$(manifest_pin "${package}")"
  if [[ -z "${pinned}" ]]; then
    # web/package.json exists (kube::node::dirs resolved it) but pins nothing for
    # this tool, so nothing enforces which version gets installed. Fatal for the
    # same reason a mismatch is: the gate would speak for whatever npm resolved.
    kube::log::usage \
      "ERROR: ${KUBE_NODE_PACKAGE_JSON} pins no version for ${package}, so this gate cannot speak for a" \
      "known version of it. Add \"${package}\": \"${expected}\" to that manifest, which is the single" \
      "source of truth for what 'npm ci' installs."
    failed_gates+=("${package}-version-pin")
    res=1
  elif [[ "${pinned}" != "${expected}" ]]; then
    kube::log::usage \
      "ERROR: ${package} is pinned at ${pinned} in ${KUBE_NODE_PACKAGE_JSON}," \
      "but hack/verify-web.sh expects ${expected}, so this gate no longer speaks for" \
      "the tool that gets installed. That manifest is the single source of truth:" \
      "set ${package^^}_VERSION to ${pinned} in the same change that moved the pin."
    failed_gates+=("${package}-version-pin")
    res=1
  fi
done

# A missing or too-old runtime is the one failure this gate cannot work around.
# kube::node::validate names the detected version, the Node.js 22.23.2 and npm
# 11.18.0 floors hack/lib/node.sh enforces - the runtimes this tier was verified
# against - and how to fix it, all ERROR:-prefixed, so a developer never sees a
# bare `set -e` trace instead of an explanation.
if ! kube::node::validate; then
  exit 1
fi

# Provision the tier rather than failing when the gates are absent. This installs
# exactly the dependency set web/package-lock.json records, with `npm ci` and
# never `npm install` - which would rewrite that lockfile - and it is
# stamp-guarded on the lockfile, so a second run is a no-op. Nothing is installed
# globally, and nothing is added to hack/tools: that is a Go module, and a Node
# tool there would enter the Go module graph. No entry in build/dependencies.yaml
# is needed either, because no new pinned external artifact is introduced.
if [[ ! -d "${KUBE_NODE_MODULES_BIN}" ]]; then
  kube::log::status \
    "the web lint and type gates are not provisioned yet; installing them with hack/lib/node.sh"
fi
if ! kube::node::ensure_modules; then
  kube::log::usage \
    "ERROR: could not provision the web lint and type gates in ${KUBE_WEB_DIR}/node_modules." \
    "The locked set is ${KUBE_NODE_PACKAGE_LOCK}, and installing it needs access to the" \
    "npm registry. Reproduce with: hack/verify-web.sh"
  exit 1
fi

# Both gates are run from the tier's own node_modules/.bin, never through npx:
# npx will fetch a package that is absent from the locked set, so a gate invoked
# that way could end up speaking for a version nobody pinned - and, on a host
# without registry access, hang or fail for a reason that has nothing to do with
# the code under test. Absolute paths also leave ${PATH} untouched, which is why
# kube::node::activate is deliberately not called.
eslint_bin="${KUBE_NODE_MODULES_BIN}/eslint"
readonly eslint_bin
tsc_bin="${KUBE_NODE_MODULES_BIN}/tsc"
readonly tsc_bin


# tool_version prints the version of the eslint or tsc installed in the tier. On
# return "X.Y.Z" has been printed, or nothing has been printed and the status is
# non-zero because that executable is not installed there.
#
# The two report differently - `eslint --version` prints "v10.8.1" while
# `tsc --version` prints "Version 7.0.2" - so the last field of the first line is
# taken and a leading "v" is stripped, which is correct for both.
tool_version() {
  local binary=$1
  local reported

  [[ -x "${binary}" ]] || return 1
  reported="$("${binary}" --version 2>/dev/null)" || return 1
  awk 'NR == 1 { sub(/^v/, "", $NF); print $NF }' <<<"${reported}"
}

# assert_gate_available reports whether the gate ${1}, pinned at ${2}, can run,
# having been given its installed version as ${3}. On return the status says so,
# and an absent gate or a version that has drifted from the pin has produced an
# ERROR:-prefixed explanation naming the fix.
#
# AN EXACT-VERSION MISMATCH IS FATAL, NOT A WARNING. hack/verify-shellcheck.sh
# L78-86 can afford a detect-then-decide posture because it reports findings from
# whatever shellcheck it finds; this gate cannot, because its verdict is what
# `make verify` reports. TypeScript in particular changes what it accepts between
# releases - and it is the ONLY gate covering .ts and .tsx here, since eslint 10
# cannot parse them - so approving on a different tsc means approving code the
# pinned tsc may reject. The pinned version is what `npm ci` installs from
# ${KUBE_NODE_PACKAGE_LOCK}, so a mismatch means the tree is stale rather than
# that the developer is unlucky, and reinstalling it is a one-line fix rather
# than a reason to lower the bar.
assert_gate_available() {
  local gate=$1
  local pinned=$2
  local installed=$3

  if [[ -z "${installed}" ]]; then
    kube::log::usage \
      "ERROR: ${gate} is not installed in ${KUBE_WEB_DIR}/node_modules, so that gate could not run." \
      "${gate} is pinned at ${pinned} in ${KUBE_NODE_PACKAGE_JSON}." \
      "Rebuild the dependency tree with: rm -rf ${KUBE_WEB_DIR}/node_modules && hack/verify-web.sh"
    return 1
  fi

  if [[ "${installed}" != "${pinned}" ]]; then
    kube::log::usage \
      "ERROR: ${gate} ${installed} is installed, but ${pinned} is pinned in ${KUBE_NODE_PACKAGE_JSON}," \
      "so this gate would speak for a tool that is not the one this tier pins." \
      "Findings from a different version are not interchangeable: neither approval nor rejection carries over." \
      "Reinstall the locked tree with: rm -rf ${KUBE_WEB_DIR}/node_modules && hack/verify-web.sh"
    return 1
  fi
  return 0
}

# The lint pass runs from inside the tier root, taking its whole configuration
# from web/eslint.config.js - which is where `npm --prefix web run lint` reads it
# from too, so a developer reproducing a finding by hand sees exactly this. Its
# findings are redirected to stderr, because that is the stream juLog records and
# greps for "^ERROR: " when building the JUnit failure message.
eslint_installed="$(tool_version "${eslint_bin}")" || eslint_installed=""
if ! assert_gate_available "eslint" "${ESLINT_VERSION}" "${eslint_installed}"; then
  failed_gates+=("eslint")
  res=1
else
  kube::log::status \
    "Linting ${#targets[@]} web path(s) under ${KUBE_WEB_DIR} with eslint ${eslint_installed}"
  # No --fix, by design: a verify gate reports, an update-* script rewrites.
  #
  # The two --no-* flags below keep web/eslint.config.js the single authority on
  # what is not linted, instead of duplicating its ignore list here. Both were
  # verified against the pinned eslint 10.8.1 rather than assumed:
  #   --no-warn-ignored              this script enumerates .ts and .tsx so that
  #                                  the tsc projects can be selected, and that
  #                                  config ignores them; without this flag each
  #                                  one is reported as "File ignored because of a
  #                                  matching ignore pattern".
  #   --no-error-on-unmatched-pattern a directory whose files are all ignored -
  #                                  web/src, for instance, which holds only .tsx
  #                                  and .ts - otherwise makes eslint EXIT 2 with
  #                                  "all of the files matching the glob pattern
  #                                  are ignored", so `hack/verify-web.sh
  #                                  web/src/components` would fail for no reason.
  # Neither suppresses a finding: a real violation in a file eslint does lint
  # still fails this gate, and the .ts/.tsx surface is gated by the tsc pass.
  eslint_command=("${eslint_bin}" --no-warn-ignored --no-error-on-unmatched-pattern)
  if ${colorize}; then
    eslint_command+=("--color")
  else
    eslint_command+=("--no-color")
  fi

  eslint_result=0
  (
    cd "${web_root}"
    "${eslint_command[@]}" -- "${targets[@]}"
  ) >&2 || eslint_result=$?

  if [[ "${eslint_result}" -ne 0 ]]; then
    kube::log::usage \
      "ERROR: eslint ${eslint_installed} reported lint findings under ${KUBE_WEB_DIR} (exit ${eslint_result})."
    failed_gates+=("eslint")
    eslint_findings=true
    if [[ "${res}" -eq 0 ]]; then
      res="${eslint_result}"
    fi
  fi
fi

# tsc_project runs `tsc --noEmit` over the project ${1} from inside the tier root.
# On return that project has been typechecked, every diagnostic is on stderr, and
# the status is tsc's own.
#
# web/tsconfig.json is invoked BARE - no -p - because that is the shape its own
# header documents this gate as depending on, and it is what
# `npm --prefix web run typecheck` runs. Any other project is named with -p.
tsc_project() {
  local project=$1
  local -a command=("${tsc_bin}" "--noEmit")

  if [[ "${project}" != "tsconfig.json" ]]; then
    command+=("-p" "${project}")
  fi
  if ! ${colorize}; then
    # tsc has no --color flag at all; --pretty false turns off both colour and
    # the boxed multi-line diagnostic formatting, leaving one plain line per
    # diagnostic - which is what keeps the JUnit XML well formed.
    command+=("--pretty" "false")
  fi

  (
    cd "${web_root}"
    "${command[@]}"
  ) >&2
}

# check_project typechecks the project ${1}, described by ${3}, when ${2} says its
# inputs are present. On return the project has been typechecked, or skipped with
# a status line, and any failure has been recorded in ${res} and ${failed_gates};
# the status is always 0, so one project failing never stops the next from being
# checked.
#
# The input guard is required rather than defensive: tsc fails an input-less
# project outright with "error TS18003: No inputs were found in config file",
# which - in a migration whose files land one at a time - would turn a
# not-yet-arrived tree into a red gate rather than a skipped check.
check_project() {
  local project=$1
  local has_inputs=$2
  local description=$3
  local project_result=0

  if [[ ! -f "${web_root}/${project}" ]]; then
    if ${has_inputs}; then
      # THE PROJECT FILE MUST EXIST ONCE ITS INPUTS DO. Skipping here would leave
      # .ts and .tsx entirely unchecked - eslint 10 cannot parse them and
      # web/eslint.config.js ignores them for that reason - so the gate would
      # approve TypeScript that nothing had typechecked. An absent tsconfig is
      # also not a state the tier can legitimately reach: both projects are
      # committed, so this means one was deleted or moved.
      kube::log::usage \
        "ERROR: there are inputs for ${description} under ${KUBE_WEB_DIR}, but ${KUBE_WEB_DIR}/${project} is missing," \
        "so those inputs would go completely untypechecked - and tsc is the ONLY gate that covers .ts and .tsx here." \
        "Restore ${project} from version control before running this gate."
      failed_gates+=("tsc(${project}-missing)")
      if [[ "${res}" -eq 0 ]]; then
        res=1
      fi
      return 0
    fi
    kube::log::status \
      "no ${project} under ${KUBE_WEB_DIR} and no inputs for it; skipping the typecheck of ${description} (migration in progress)"
    return 0
  fi
  if ! ${has_inputs}; then
    kube::log::status \
      "no inputs for ${project} under ${KUBE_WEB_DIR}; skipping the typecheck of ${description} (migration in progress)"
    return 0
  fi

  kube::log::status "Typechecking ${description} with tsc ${tsc_installed} (${project})"
  tsc_project "${project}" || project_result=$?

  if [[ "${project_result}" -ne 0 ]]; then
    kube::log::usage \
      "ERROR: tsc ${tsc_installed} reported type findings for ${project} under ${KUBE_WEB_DIR} (exit ${project_result})."
    failed_gates+=("tsc(${project})")
    tsc_findings=true
    if [[ "${res}" -eq 0 ]]; then
      res="${project_result}"
    fi
  fi
  return 0
}

# The type pass runs even when eslint failed, so that one invocation surfaces
# every class of problem instead of only the first - and, because .ts and .tsx are
# outside eslint's reach here, skipping it would mean not checking them at all.
tsc_installed="$(tool_version "${tsc_bin}")" || tsc_installed=""
if ! assert_gate_available "typescript" "${TYPESCRIPT_VERSION}" "${tsc_installed}"; then
  failed_gates+=("tsc")
  res=1
else
  # Each project's inputs are tested exactly the way tsc resolves its own
  # "include": web/tsconfig.json takes src/**, and tsconfig.node.json takes the
  # two named config files. find(1) stops at the first hit, so this costs nothing
  # on a large tree.
  src_inputs=false
  if [[ -d "${web_root}/src" ]] &&
    [[ -n "$(find "${web_root}/src" -type f \( -name '*.ts' -o -name '*.tsx' \) -print -quit)" ]]; then
    src_inputs=true
  fi
  readonly src_inputs

  node_inputs=false
  if [[ -f "${web_root}/vite.config.ts" || -f "${web_root}/vitest.config.ts" ]]; then
    node_inputs=true
  fi
  readonly node_inputs

  if ${check_src_project}; then
    check_project "tsconfig.json" "${src_inputs}" "the tier sources under web/src"
  fi
  if ${check_node_project}; then
    check_project "tsconfig.node.json" "${node_inputs}" \
      "the build tooling (web/vite.config.ts and web/vitest.config.ts)"
  fi
  if ! ${check_src_project} && ! ${check_node_project}; then
    kube::log::status \
      "none of the given paths belongs to a TypeScript project, so tsc has nothing to check" \
      "(web/tsconfig.json covers src/**, web/tsconfig.node.json covers vite.config.ts and vitest.config.ts)"
  fi
fi

# print a message based on the result
if [[ "${res}" -eq 0 ]]; then
  kube::log::status \
    "Congratulations! The React test tier passes eslint ${eslint_installed} and tsc ${tsc_installed} :-)"
else
  {
    echo
    echo "ERROR: the React test tier failed these gates: $(join_by ',' "${failed_gates[@]:-unknown}")"
    echo
    echo 'Please review the above findings. You can test via "./hack/verify-web.sh", or'
    echo 'narrow it to one path with "./hack/verify-web.sh web/src/<path>".'
    # Only advise a fix for a gate that actually produced findings: pointing a
    # developer at `eslint --fix` for a type error, or for an eslint that is not
    # even installed, sends them the wrong way.
    if ${eslint_findings}; then
      echo 'This gate never rewrites a file. The lint findings above are fixable with:'
      echo '  npm --prefix web run lint -- --fix'
      echo 'Rule selection lives in web/eslint.config.js. Note that .ts and .tsx are'
      echo 'globally ignored there on purpose and are gated by tsc instead, so a finding'
      echo 'above concerns a .js or .mjs file.'
    fi
    if ${tsc_findings}; then
      echo 'Type findings are not auto-fixable: correct or annotate the code. Reproduce them'
      echo 'from the repository root with "npm --prefix web run typecheck" for web/src, or'
      # The project path is spelled web/tsconfig.node.json rather than
      # tsconfig.node.json because `npm exec`, unlike `npm run`, does NOT change
      # directory into --prefix: the tier-relative spelling fails with TS5058.
      echo 'with "npm --prefix web exec -- tsc --noEmit -p web/tsconfig.node.json" for the'
      echo 'build tooling. The settings that produced them live in web/tsconfig.json and'
      echo 'web/tsconfig.node.json - and a failure naming toBeInTheDocument means the'
      echo '"types" list in web/tsconfig.json has lost @testing-library/jest-dom, which is'
      echo 'to be fixed there rather than worked around here.'
    fi
    echo 'The two tool versions live in web/package.json. In general please prefer fixing'
    echo 'the finding over adding an "eslint-disable" or a "@ts-expect-error" (if your'
    echo 'reviewer is okay with it): reportUnusedDisableDirectives and TypeScript itself'
    echo 'each flag one of those the moment it stops suppressing anything.'
    echo
  } >&2
fi

# preserve the result
exit "${res}"

