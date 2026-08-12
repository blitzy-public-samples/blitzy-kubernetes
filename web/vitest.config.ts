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

// AAP §0.4.6 / §0.5.4 — Vitest 4 configuration for the React component and
// contract tiers (L6/L7).
//
// Vitest 4 notes that this configuration deliberately honours (AAP §0.2.2.2):
//   * `coverage.all` and `coverage.ignoreEmptyLines` were REMOVED, so
//     `coverage.include` must be stated explicitly.
//   * the `basic` reporter was REMOVED; use `default` (optionally combined
//     with `junit` for CI).
//   * `workspace`, `poolMatchGlobs`, `environmentMatchGlobs`, `minWorkers`,
//     `poolOptions`, `singleThread`/`singleFork` were removed — use
//     `test.projects` / `maxWorkers` / `isolate` instead.
//   * jsdom is used deliberately: Browser Mode, visual regression and
//     cross-browser testing are out of scope (AAP §0.8.2).
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // `default` replaces the removed `basic` reporter; hack/make-rules/test-web.sh
    // adds `junit` plus --outputFile.junit when KUBE_JUNIT_REPORT_DIR is set.
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      // MANDATORY in Vitest 4 (coverage.all was removed).
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/setupTests.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'cobertura'],
      reportsDirectory: './coverage',
    },
  },
});
