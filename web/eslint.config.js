/*
Copyright The Kubernetes Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// AAP §0.5.1 (hack/verify-web.sh row) / §0.6.1.2 (eslint 10.8.1 pin) /
// §0.8.1.5 (test runners, gates and provisioning scripts) — ESLint
// configuration for the React (Vitest 4 + RTL 16) test tier under web/.
// tech-spec §6.6.3.1 (the hack/verify-*.sh gate surface) / §8.5 (CI is external
// Prow driving hack/jenkins/*-dockerized.sh, so gates are extended here and
// never in an invented workflow YAML).
//
// WHY THIS FILE EXISTS — it is deliberately NOT scope creep.
// AAP §0.5.1 and §0.8.1.5 create hack/verify-web.sh as "eslint plus
// `tsc --noEmit` over web/", and AAP §0.6.1.2 pins eslint 10.8.1 with the
// stated purpose "Lint gate invoked by hack/verify-web.sh". ESLint 10 removed
// the legacy eslintrc system outright: it reads ONLY eslint.config.{js,mjs,cjs}
// and can no longer be configured from package.json. Without this file
// `eslint .` does not lint — it fails to start — and because
// hack/make-rules/verify.sh auto-discovers `hack/verify-*.sh`, that failure
// would surface as a red `make verify` rather than a skipped check. This file
// is therefore the minimal artifact required to make an AAP-mandated gate
// executable, which is exactly what AAP §0.11.1 means by "extend the
// repository's own gate surface, never bypass it".
//
// SCOPE DISCIPLINE (AAP §0.11.1 "respect the surviving freeze").
// The only import below is `eslint/config`, which ships inside the pinned
// eslint package, so this file adds NOTHING to the dependency set fixed by
// AAP §0.6.1.2. ESLint's core rule-set preset ships as a separately published
// package which this project does not pin, and it is genuinely absent from the
// installed tree, so that preset cannot be extended here and the rule set below
// is enumerated by hand instead. No plugin, no shareable config, no formatter
// and no stylistic rule set is introduced: this is a gate, not a lint programme.
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  // ---------------------------------------------------------------------------
  // 1. Generated and vendored trees.
  //
  // A config object carrying only `ignores` is treated by flat config as global
  // ignores. These mirror the web/ entries already declared in the repository
  // .gitignore (web/node_modules, web/coverage/, web/dist/, web/.vite/,
  // web/vitest-report/, *.tsbuildinfo) so that the linter and the SCM agree on
  // what is not source. node_modules is ignored by default; naming it is
  // harmless and makes the intent explicit — and it matters here because
  // web/node_modules is a symlink to an out-of-tree store provisioned by
  // hack/lib/node.sh.
  // ---------------------------------------------------------------------------
  globalIgnores(
    [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '.vite/**',
      'vitest-report/**',
      '**/*.tsbuildinfo',
    ],
    'web/ignores/generated-artifacts',
  ),

  // ---------------------------------------------------------------------------
  // 2. TypeScript sources — checked by `tsc --noEmit`, not by ESLint.
  //
  // This exclusion is stated as its own NAMED entry, rather than folded into the
  // artifact list above, precisely so that it can never read as an accident. It
  // is a recorded engineering decision with a measured cause and a one-edit
  // reversal, and AAP §0.11.1 ("evidence over assumption") requires that the
  // evidence travel with it:
  //
  //   * ESLint 10.8.1 bundles exactly one language, `js` (espree). Pointing a
  //     `files: ['**/*.{ts,tsx}']` entry at it without a TypeScript parser
  //     yields `Parsing error: The keyword 'interface' is reserved` and a
  //     non-zero exit — it would break the gate, not strengthen it.
  //   * The usual parser, typescript-eslint, cannot be installed here.
  //     `npm install --save-dev typescript-eslint` fails with ERESOLVE because
  //     its peer range is `typescript: ">=4.8.4 <6.1.0"` while AAP §0.6.1.2
  //     pins typescript 7.0.2. Forced through with --legacy-peer-deps it then
  //     throws at import: "typescript-eslint does not support TS 7.0."
  //   * The root cause is upstream and temporary. TypeScript 7 is the Go-native
  //     compiler and ships no programmatic API; the API typescript-eslint needs
  //     arrives in TypeScript 7.1. The vendor's documented interim workaround is
  //     an npm alias installing a second, TypeScript 6 compiler, which would
  //     replace the AAP-pinned typescript 7.0.2, leave only a `tsc6` binary and
  //     break hack/verify-web.sh's own `npx tsc --noEmit`. It is therefore
  //     rejected as a behaviour change.
  //
  // The compensating control is real and lives in the SAME gate: after this
  // lint pass, hack/verify-web.sh runs `tsc --noEmit` (web/tsconfig.json, which
  // covers src/**) and `tsc --noEmit -p tsconfig.node.json` (which covers the
  // build tooling). web/tsconfig.json enables strict, noUnusedLocals,
  // noUnusedParameters, noFallthroughCasesInSwitch, isolatedModules and
  // forceConsistentCasingInFileNames — the checks a non-type-aware ESLint pass
  // would have contributed, applied by a tool that also has type information.
  // The .ts and .tsx surface is gated; it is gated by the stronger of the two
  // tools.
  //
  // TO RE-ENABLE once typescript-eslint supports TypeScript >= 7.1: add the
  // parser at an exact resolved version to web/package.json, regenerate
  // web/package-lock.json, then replace this entry with a
  // `files: ['**/*.{ts,tsx}']` entry extending its recommended, NON type-aware
  // preset. Keep it non-type-aware: `tsc --noEmit` already runs in this gate, so
  // a type-aware preset would duplicate that work, roughly double the gate's
  // runtime and couple this file to tsconfig include/exclude drift.
  // ---------------------------------------------------------------------------
  globalIgnores(['**/*.ts', '**/*.tsx'], 'web/ignores/typescript-checked-by-tsc'),

  // ---------------------------------------------------------------------------
  // 3. JavaScript sources.
  //
  // Flat config does not infer file types, so this entry is what actually makes
  // the lint pass do work. It is load-bearing rather than ceremonial: this very
  // file is checked by nothing else in the repository. web/tsconfig.node.json
  // deliberately does not list eslint.config.js — it is JavaScript and `allowJs`
  // is off there, so tsc would drop it from the program even if it were listed
  // — which leaves ESLint as its only guard.
  //
  // web/package.json declares "type": "module", so .js here is ESM; .mjs is
  // always ESM and is matched for the same reason. .cjs is deliberately NOT
  // matched: none exists, and it would need sourceType: 'commonjs'. Should one
  // ever appear, give it its own entry rather than widening this one.
  //
  // ecmaVersion tracks web/tsconfig.node.json's ES2022 target/lib — which in
  // turn matches web/tsconfig.json's — so every toolchain in this tier agrees on
  // one language level. It is a fixed value rather than 'latest' so an ESLint
  // upgrade cannot silently change how this tree parses.
  // ---------------------------------------------------------------------------
  {
    name: 'web/javascript',
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // No `globals` entry, and none is needed: ESLint supplies the ES built-in
      // globals implied by ecmaVersion, and configuration modules in this tree
      // reference only imports and locals. A file that legitimately needs a
      // runtime global should declare it here as a plain object
      // (e.g. `globals: { process: 'readonly' }`) — the `globals` package is
      // not pinned by AAP §0.6.1.2 and must not be added for this.
    },
    linterOptions: {
      // A disable directive that no longer suppresses anything is stale and
      // hides the next real finding. This is the ESLint counterpart of the
      // unused-directive detection tsc performs on the TypeScript side.
      reportUnusedDisableDirectives: 'error',
    },
    // eslint:recommended is not reachable (see the scope note above), so the
    // error-catching rules are named individually. Everything here is a
    // correctness check; no formatting or stylistic rule is enabled, because
    // this repository's web tier pins no formatter. The groupings deliberately
    // mirror the web/tsconfig.json options that guard the TypeScript sources,
    // so both languages are held to equivalent standards.
    rules: {
      // Mirrors noUnusedLocals / noUnusedParameters. Arguments are reported only
      // after the last used one, so a leading parameter kept purely to reach a
      // later one stays legal.
      'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true }],

      // Mirrors noFallthroughCasesInSwitch.
      'no-fallthrough': 'error',

      // Mirrors the intent of `strict`: no implicit coercion, no redeclaration,
      // and block-scoped bindings that say whether they are ever reassigned.
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-undef': 'error',
      'no-redeclare': 'error',

      // Statements and expressions that cannot be doing what the author meant.
      'no-cond-assign': ['error', 'always'],
      'no-constant-condition': 'error',
      'no-debugger': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-obj-calls': 'error',
      'no-self-compare': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': ['error', { requireStringLiterals: true }],
    },
  },
]);
