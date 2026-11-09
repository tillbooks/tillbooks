/**
 * The harness's own regression test: ONE failing test must never take its neighbour with it.
 *
 * The defect this pins. Vitest runs `afterEach` hooks in reverse registration order
 * (`sequence.hooks` defaults to `"stack"`, see `resolveConfig`), and `callSuiteHook` iterates them
 * with a bare `for ... await hook()` and no per-hook `try`. So the FIRST hook that throws aborts
 * every hook registered before it, including Testing Library's auto-`cleanup`. The failed test's
 * tree then stays in `document.body` and the next test queries it: one real failure, two red tests,
 * and the second one names a file that is not broken.
 *
 * That is not hypothetical. `src/test-console.ts` throws on unexpected console output, and it is
 * registered after `@testing-library/react`, so it ran first and swallowed the cleanup every time
 * it fired. It cost two separate investigations (DocumentDetail's FX panel, CompanyProfile's
 * Firmenprofil heading) before the amplifier itself was seen.
 *
 * The fix in `src/test-setup.ts` is an `onTestFinished` cleanup net rather than a hook reordering,
 * so these two tests are deliberately written against the PROPERTY and not against today's hook
 * list: the second pair uses an ordinary throwing `afterEach` that has nothing to do with the
 * console guard. Add a third throwing hook tomorrow and this file still holds.
 *
 * `it.fails` here is an assertion, not a mute button: if the guard ever stopped failing on stray
 * console output, the first test would PASS and Vitest would then fail it for passing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const GUARD_LEAK = 'cascade-probe-guard-leak';
const HOOK_LEAK = 'cascade-probe-hook-leak';

/** What every follower in this file claims: it started against a body nobody else left behind. */
function expectCleanBody(testId: string): void {
  expect(screen.queryByTestId(testId)).toBeNull();
  expect(document.body.querySelector(`[data-testid="${testId}"]`)).toBeNull();
  expect(document.body.children).toHaveLength(0);
}

describe('a test failed by the CONSOLE GUARD leaves no DOM behind', () => {
  it.fails('FAILS ON PURPOSE: stray console output while a tree is mounted', () => {
    render(<p data-testid={GUARD_LEAK}>the failed test's tree</p>);
    // The guard fails this test for exactly this line. Nothing else in the test is wrong.
    console.error('cascade probe: a deliberate, unexpected console.error');
  });

  it('the next test starts against an empty document.body', () => {
    expectCleanBody(GUARD_LEAK);
  });
});

describe('a test failed by ANY throwing afterEach leaves no DOM behind', () => {
  describe('inner suite whose own afterEach throws', () => {
    // Registered on the INNER suite, so it aborts before the file-level hooks are even reached:
    // the console guard is not involved, and neither is its ordering.
    afterEach(() => {
      throw new Error('cascade probe: a deliberate afterEach failure');
    });

    it.fails('FAILS ON PURPOSE: mounts a tree, then its afterEach throws', () => {
      render(<p data-testid={HOOK_LEAK}>the failed test's tree</p>);
    });
  });

  it('the next test starts against an empty document.body', () => {
    expectCleanBody(HOOK_LEAK);
  });
});
