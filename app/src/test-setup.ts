/**
 * Test setup, loaded once before the suites.
 *
 * Brings in the jest-dom matchers (`toBeInTheDocument`, ...), registers the jest-axe
 * `toHaveNoViolations` matcher on Vitest's `expect`, and installs the console guard that turns
 * stray `console.error`/`console.warn` output into a failing test.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { beforeEach, expect, onTestFinished } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';
import { installConsoleGuard } from './test-console';
import { memoryStorage } from './lib/test-support';

expect.extend(toHaveNoViolations);

// Every test gets a real, empty `localStorage`.
//
// This is not tidiness. Under Node 22+ the runtime ships its own `localStorage` global, it survives
// jsdom's, and it throws on `getItem` unless the process was started with `--localstorage-file`.
// Every suite that mounted `WorkspaceProvider` was therefore hitting the "storage is unavailable"
// catch instead of the storage it meant to test, and Node printed a `--localstorage-file` warning
// into the suite's stderr for the trouble. Installing the same in-memory Storage the persistence
// suites already use makes the behaviour identical on Node 20, 22 and 25, and empties it between
// tests so one suite cannot seed another. A suite that wants its own handle still calls
// `installMemoryStorage()` itself: a suite-level `beforeEach` runs after this one and wins.
beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });

  // The cleanup net: Testing Library's teardown runs even when an `afterEach` throws.
  //
  // Testing Library registers its own auto-cleanup `afterEach` when it is imported, and that would
  // be enough if `afterEach` hooks were independent. They are not. Vitest reverses them under the
  // default `sequence.hooks: "stack"`, and `callSuiteHook` iterates them with a bare
  // `for ... await hook()` and no per-hook `try`, so the first hook that throws aborts every hook
  // registered before it. Auto-cleanup is registered first here, so it was reliably the casualty:
  // the failed test's tree stayed in `document.body` and the NEXT test queried it. One real defect,
  // two red tests, the second one naming a file that was fine. It happened twice, in DocumentDetail
  // and in CompanyProfile, before the harness itself was suspected.
  //
  // `onTestFinished` is the slot that cannot be skipped: the runner calls those hooks after the
  // whole afterEach chain whether or not it threw, and wraps each one in its own `try/catch`
  // (`callTestHooks`). So this holds for ANY number of afterEach hooks in ANY order, which a
  // reordering of today's two would not: it would be correct until someone added a third.
  //
  // `cleanup()` is idempotent (it empties its own mounted-root list), so on the ordinary green path
  // Testing Library has already run and this is a no-op. `src/test-console.cascade.test.tsx` is the
  // regression test, and it fails without these three lines.
  onTestFinished(() => {
    cleanup();
  });
});

// Stderr is a signal channel, not a scratchpad. A suite that is expected to print warnings cannot
// tell you when a new one appears, which is how a React act(...) warning and a real
// missing-translation defect ended up sharing the same scroll-back unread. Anything a test really
// does expect opts in with `allowConsole()` from `./test-console`.
installConsoleGuard();

// `findBy`/`waitFor` default to 1s, which is plenty on an idle machine and not enough when the
// whole suite saturates every core: two tests flaked exactly there (F9). The budget stays inside
// the per-test timeout raised in `vitest.config.ts`, so a real hang still surfaces as one legible
// per-test timeout instead of a cascade of waitFor failures.
//
// Raised 4s -> 10s on 29.07.2026, when D00 grew the Studio suite and the CI node-20 job began
// failing ONE test per run at 4s while node 22 and every local run stayed green. The failing test
// MOVED between runs (BankAccounts B7, then Journal's permission-denied Post control), which is the
// signature of a slow runner rather than a defect: a real missing element fails everywhere, not on
// one runtime, and not a different one each time.
configure({ asyncUtilTimeout: 10_000 });
