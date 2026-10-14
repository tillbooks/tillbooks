/**
 * The jest-axe matcher on Vitest's `expect` (registered in `./test-setup.ts`).
 *
 * `@types/jest-axe` declares `toHaveNoViolations` on the global `jest.Matchers`. Vitest up to 3
 * bridged that namespace into its own `Assertion`; Vitest 4 dropped the bridge, so the matcher is
 * declared on Vitest's own types here, the way Vitest documents custom matchers.
 */
import 'vitest';

interface AxeMatchers<R = unknown> {
  toHaveNoViolations(): R;
}

declare module 'vitest' {
  interface Assertion<T = any> extends AxeMatchers<T> {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
