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

// AAP §0.5.1 (the web/vite.config.ts row, whose entire specification is
// "react() plugin") / §0.4.6 (test configuration and gate wiring) ·
// tech-spec §6.6.1.3 (jsdom only: this repository has no browser-based or
// graphical client, so browser automation, cross-browser runs and visual
// regression are not applicable to it).
//
// INVARIANT LOCKED. This file is the single definition site for the React/JSX
// transform used by the React test tier. Vitest reads vitest.config.ts in
// preference to vite.config.ts when both are present, so this default export
// exists precisely to be composed into that sibling with `mergeConfig` instead
// of having the transform restated there: two independent declarations of one
// transform would be free to drift apart.
//
// Three properties below are load-bearing and must survive any future edit.
//
//   1. THE OBJECT FORM, never a callback. `defineConfig` also accepts a
//      synchronous or an async factory, and either would typecheck here, but
//      `mergeConfig` requires two already-resolved plain objects: handing it a
//      callback fails immediately with "Cannot merge config in form of
//      callback" (verified against the pinned vite 8.2.1). The shape of this
//      default export is therefore an interface requirement between this file
//      and vitest.config.ts, not a stylistic preference.
//
//   2. NOTHING FROM NODE. web/tsconfig.node.json lists this module as one of
//      its two inputs and typechecks it with `"types": []`, and AAP §0.6.1.2
//      pins no @types/node — so this module imports no Node built-in and reads
//      no Node-only global: no directory or filename magic variable, and no
//      environment object. Against an empty ambient type set any of them would
//      fail the typecheck outright, which is what keeps the rule enforced
//      rather than merely stated.
//
//   3. NOTHING BEYOND THE TRANSFORM. No server, build, preview, resolve, css,
//      define or base section, because nothing in this tier is served, bundled
//      or previewed (AAP §0.8.2) and hack/make-rules/test-web.sh only ever runs
//      `vitest run`. The `test` block — jsdom, setupFiles, and the explicit
//      `coverage.include` that Vitest 4 now requires (AAP §0.2.2.2) — belongs
//      to vitest.config.ts, which is where AAP §0.5.1 assigns it. Every key
//      Vitest 4 removed is likewise absent from this file by construction.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // @vitejs/plugin-react 6.0.5 (AAP §0.6.1.2): the React 19 automatic JSX
  // runtime and Fast Refresh transform, matching `"jsx": "react-jsx"` in
  // web/tsconfig.json so components and specs need no `import React`.
  plugins: [react()],
});
