// Copyright The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Minimal, dependency-free ESLint 10 flat configuration so that
// `hack/verify-web.sh` has an executable lint gate from the first commit
// onward (AAP §0.5.1, hack/verify-web.sh row).
//
// Deliberately imports nothing: the AAP pins an exact devDependency set
// (§0.6.1.2) and this file must not add to it.
//
// WHY .ts/.tsx ARE NOT LINTED HERE (and are typechecked instead):
// ESLint 10 bundles only the `js` language (espree), so it cannot parse
// TypeScript syntax. The usual answer, `typescript-eslint`, currently declares
// `typescript: ">=4.8.4 <6.1.0"` as a peer, which is incompatible with the
// AAP-pinned TypeScript 7.0.2 - installing it would either break peer
// resolution or require --legacy-peer-deps. TypeScript files are therefore
// fully checked by `tsc --noEmit` (both tsconfig.json and tsconfig.node.json),
// which hack/verify-web.sh runs alongside this lint pass. Revisit once
// typescript-eslint declares TypeScript 7 support.
export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '**/*.tsbuildinfo',
      // See the header comment: TypeScript is gated by `tsc --noEmit`.
      '**/*.ts',
      '**/*.tsx',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
];
