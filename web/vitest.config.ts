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

// AAP §0.4.6 (test configuration and gate wiring) / §0.5.1 (the
// web/vitest.config.ts row: the jsdom environment, setupFiles, and the
// explicit coverage include list Vitest 4 now demands) / §0.5.4 (test
// configuration updates) · tech-spec §6.6.1.3 (this repository ships no
// graphical client, so user-agent automation, cross-engine runs and visual
// regression are all recorded as not applicable to it).
//
// INVARIANT LOCKED. The React tier -- L6 component/interaction specs and L7
// contract specs -- executes in jsdom against ONE shared MSW server, in a
// fresh isolated environment per spec file, with coverage measured but NEVER
// gating.
//
// This configuration is deliberately small, and its omissions are as
// load-bearing as its settings. hack/make-rules/test-web.sh is the only
// automated caller: it always runs `vitest run`, never a watching mode, and
// layers the reporter, coverage and worker-count flags on top of this file.
// Anything declared here in those three areas would fight the runner and, in
// doing so, the JUnit artifact that TestGrid, the triage clusterer and
// Spyglass consume. Hence five deliberate absences:
//
//   * NO `reporters` key. The runner always passes `--reporter=default`, and
//     adds `--reporter=junit` with `--outputFile.junit=<dir>/web.xml` when
//     KUBE_JUNIT_REPORT_DIR is set -- which hack/make-rules/test.sh
//     auto-matches to CI's ARTIFACTS. `default` is also the documented
//     replacement for the one reporter Vitest 4 deleted outright, whose name
//     now fails at load with ERR_LOAD_URL / loadCustomReporterModule
//     (AAP §0.2.2.2, §0.9.1.2).
//   * NO stop-the-run-after-N-failures key. AAP §0.4.1.2 maps Go's `t.Errorf`
//     (record the failure and keep going) onto `expect.soft`, and Go's
//     `t.Fatalf` (abort immediately) onto a throwing `expect`. Cutting the run
//     short collapses that distinction, hiding every finding after the first
//     and breaking, for one, V1's requirement that EVERY offending
//     ClusterRole is reported in a single run.
//   * NO re-run-a-failed-test key. A second attempt lets a genuinely failing
//     security assertion pass, converting a real regression into a flake --
//     precisely what AAP §0.11.1 ("never weaken a boundary condition to make
//     a test pass") forbids.
//   * NO worker-count key, leaving `--maxWorkers` the runner's to supply.
//   * NO coverage `enabled` flag; see the coverage block below.
//
// Vitest 4 removals (AAP §0.2.2.2) are honoured here by construction, so none
// of the following appears: the two coverage toggles that used to select files
// implicitly and skip empty lines; the multi-project field and its companion
// file, superseded by `test.projects`, which this single-project tier has no
// use for; the per-glob pool and per-glob environment selectors, superseded
// the same way; the three dependency-handling flags that moved beneath
// `server.deps.*`; the pool-sizing family -- thread and fork minima and
// maxima, the pool-options bag, and the two single-worker shorthands --
// superseded by `maxWorkers` plus `isolate`; and every key belonging to the
// in-page runner mode, together with its screenshot and viewport matchers,
// which AAP §0.4.1.1 and §0.8.2 place out of scope.
//
// THE SIBLING SPECIFIER BELOW CARRIES ITS FILE EXTENSION, and that was a fix.
//
// It used to be extensionless, and Vite 8.2.1 printed a forward-compatibility
// notice about it on every run: a future major intends to load configuration
// natively, where an extensionless relative specifier will no longer resolve.
// The notice was informational and the run exited 0, so it had been documented
// here as accepted -- on the measured grounds that naming the file
// `./vite.config.ts` made `npx tsc --noEmit -p tsconfig.node.json`, which
// hack/verify-web.sh runs, report TS5097: "An import path can only end with a
// '.ts' extension when 'allowImportingTsExtensions' is enabled".
//
// TS5097 names its own remedy, and that remedy costs nothing here.
// `allowImportingTsExtensions` requires `noEmit` or `emitDeclarationOnly`, and
// web/tsconfig.node.json already sets `noEmit: true` because it exists purely to
// TYPECHECK the two build-tooling modules -- nothing is ever emitted from it.
// Enabling the option there is therefore not a relaxation of a check; it is
// telling the compiler what is already true of this project.
//
// Both halves were then re-measured: `tsc --noEmit -p tsconfig.node.json` exits 0,
// and `vitest run` prints no notice at all where it previously printed three lines
// of one. A warning eliminated rather than accepted.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Composed rather than restated, so `plugins: [react()]` keeps exactly one
// definition site. web/vite.config.ts default-exports the plain object form
// specifically to make this possible -- `mergeConfig` rejects a callback
// configuration outright -- and Vitest reads this file in preference to
// vite.config.ts when both are present, so without the merge the React 19 JSX
// transform would silently vanish from every spec. If the merge ever
// misbehaves, correct vite.config.ts back to the object form; never duplicate
// the plugin list here.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // jsdom 30.0.1 (AAP §0.6.1.2). tech-spec §6.6.1.3 records that there is
      // no graphical client to drive, so the alternative in-page environment
      // is out of scope (AAP §0.4.1.1, §0.8.2).
      environment: 'jsdom',

      // Bare `describe` / `it` / `expect` / `vi` in the specs, paired with
      // "vitest/globals" in web/tsconfig.json's `types` allow-list so those
      // same names also typecheck (AAP §0.2.2.3).
      globals: true,

      // The single wiring point for the entire tier: the
      // @testing-library/jest-dom matchers; `afterEach(cleanup)`, so rendered
      // nodes and their listeners never leak from one spec into the next; the
      // shared MSW 2 server lifecycle (listen, then reset handlers after each
      // test, then close); and the three globals jsdom does not implement --
      // IntersectionObserver, matchMedia and window.scrollTo
      // (AAP §0.2.2.3, §0.4.4.3).
      setupFiles: ['./src/setupTests.ts'],

      // Stated explicitly instead of inherited from the default glob: specs
      // sit beside the components and hooks they cover, and nothing outside
      // src/ is a spec (AAP §0.8.1.2).
      include: ['src/**/*.test.{ts,tsx}'],

      // A fresh environment per spec file. AAP §0.4.1.2 records that neither
      // Python nor JavaScript has a true analogue of Go's `-race` and names
      // this option, together with the worker count, as the substitute -- so
      // it is pinned here rather than left to a default that a future edit
      // could invert. It must never be negated.
      isolate: true,

      // Generous on purpose. AAP §0.11.1 forbids weakening a boundary
      // condition to make a test pass, and a limit tight enough to cut short
      // a legitimate `waitFor` / `vi.waitFor` convergence check does exactly
      // that in reverse: it turns a sound wait into a spurious failure.
      testTimeout: 10000,
      hookTimeout: 10000,

      // Clears recorded calls between tests while leaving implementations
      // intact, and is deliberately the ONLY mock-lifecycle option set here.
      // `setupFiles` runs once per spec FILE, whereas the options that restore
      // spies or undo stubbed globals and environment values run after EVERY
      // test; enabling any of those would dismantle what the setup file
      // installed once, leaving every test after the first in a file running
      // against a half-torn-down environment -- for instance without the
      // jsdom globals above. Vitest 4 additionally narrowed mock restoration
      // to `vi.spyOn` mocks alone, no longer resetting plain mock functions or
      // automocks (AAP §0.2.2.2), which makes that failure subtler still to
      // diagnose.
      clearMocks: true,

      coverage: {
        // @vitest/coverage-v8 4.1.10, major-locked to the runner (AAP
        // §0.3.4.2 lockstep note). Vitest 4 rewrote this provider with
        // AST-aware remapping, so its line and branch numbers are not
        // comparable with earlier releases and the floors below are read as
        // re-baselined against it (AAP §0.2.2.2, §0.7.1.3).
        provider: 'v8',

        // MANDATORY AND EXPLICIT. Vitest 4 removed the toggle that used to
        // pull in every matching file implicitly, so coverage now reports only
        // what is listed here. Without this line an entirely untested
        // component would be absent from the report rather than scoring zero
        // in it, which would quietly flatter the floors below
        // (AAP §0.2.2.2, §0.5.1, §0.5.4, §0.9.1.2).
        include: ['src/**/*.{ts,tsx}'],

        // Measure the components and hooks, not the specs that exercise them
        // nor the harness that supports them: counting either inflates the
        // figure the floors are set against.
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/setupTests.ts'],

        // `text` for the terminal table, `html` for local inspection, `lcov`
        // for machine consumption beside the JUnit artifact.
        reporter: ['text', 'html', 'lcov'],

        // EXACTLY this name. The repository-root .gitignore ignores
        // `web/coverage/`, and web/tsconfig.json excludes `coverage` by that
        // same name, so any other directory would become both a candidate
        // commit and a typecheck input.
        reportsDirectory: './coverage',

        // NO `thresholds` KEY, DELIBERATELY, AND THE ABSENCE IS THE POINT.
        //
        // AAP §0.7.1.3 sets this tier's advisory floor at 80% line and branch,
        // and §0.5.4 puts the coverage configuration in this file -- but
        // §0.9.3
        // is unambiguous that coverage is NOT a gate and that no job may fail on
        // a percentage. MEASURED behaviour of a declared threshold: Vitest exits
        // 1 on an unmet floor even when every test passed, printing "ERROR:
        // Coverage for lines (0%) does not meet global threshold (80%)". A
        // declared threshold is therefore an ACTIVE gate, not a note.
        //
        // Declaring one here and neutralising it from the runner -- which is
        // what this file and hack/make-rules/test-web.sh used to do between them
        // -- left configuration that looks enforced, cannot be enforced through
        // the canonical entry point, and reads differently depending on which of
        // the two files you happen to open. Recording the floor as prose removes
        // that contradiction: the number below has exactly one meaning, and
        // `make test-web` and a direct `vitest run --coverage` now agree.
        //
        // THE ADVISORY FLOOR, FOR THE RECORD: 80% lines and 80% branches over
        // the `include` list above, re-baselined against Vitest 4's rewritten
        // AST-aware V8 provider, whose line and branch numbers are not
        // comparable with earlier releases (AAP §0.2.2.2, §0.7.1.3). It is a
        // DERIVED engineering judgement and not a user requirement: the prompt
        // states no coverage number and neither does the repository, which
        // tech-spec §1.2.3 and §6.6.3.2 both record as N/A. To measure against
        // it deliberately, name it on the command line from web/:
        //
        //   vitest run --coverage --coverage.thresholds.lines=80 \
        //              --coverage.thresholds.branches=80
        //
        // Note the absent `enabled` flag too: collection stays off unless
        // `--coverage` or the `test:coverage` script asks for it, matching the
        // repository's own posture of KUBE_COVER defaulting to n in
        // hack/make-rules/test.sh and KUBE_WEB_COVER likewise in
        // hack/make-rules/test-web.sh.
      },
    },
  }),
);
