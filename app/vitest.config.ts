import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest runs the component and unit suites in jsdom. It transforms with esbuild (no type-checking),
 * so it never touches the compiled engine and never needs the root `dist/` build.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // CSS imports are stubbed out: the smoke tests assert structure and a11y, not styling, and the
    // token stylesheet lives outside the app root. Nothing that renders in a test imports CSS anyway.
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    // Under full-suite parallel load a userEvent-heavy test (CompanyProfile's success form,
    // EntryDrawer's unbalanced rejection) can genuinely need more than vitest's 5s default: the
    // work is real, the machine is just saturated by the sibling workers. The budget is raised so
    // load cannot masquerade as failure; a hang still fails, only later. Pairs with the
    // `asyncUtilTimeout` raise in `src/test-setup.ts`, which governs `findBy`/`waitFor`.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The gate runs locally on a shared box that degrades after many runs (CI is disabled). Uncapped,
    // vitest forks one worker per core and the workers starve each other: a11y/settle-sensitive tests
    // (AccountDrawer's "SETTLED open drawer", Dunning's policy editor) then time out or run axe on a
    // half-rendered DOM and flake, even though the code is correct. Cap the pool so a settle-heavy
    // test keeps enough headroom; on this 8-core box 4 workers is still real parallelism. Pairs with
    // the raised timeouts above. See the kaizen note on gate flakes under load.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
