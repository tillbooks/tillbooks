/**
 * The console guard: an unexpected `console.error` or `console.warn` during a test FAILS that test.
 *
 * Why this exists. A suite whose stderr is expected to carry warnings has no signal left. This one
 * carried a React `act(...)` warning on every run for long enough that a real missing-translation
 * defect (`[i18n] missing translation for ...`) sat in the same scroll-back unnoticed. Both are
 * `console.error` calls; only one of them was known about, and nothing distinguished them.
 *
 * So the rule is inverted: silence is the default, and noise is a failure unless a test says out
 * loud that it wants it. The guard deliberately does NOT stub the console away: the captured text
 * is replayed inside the failure message, so a genuine warning is louder than before, not quieter.
 *
 * Opting in, from inside the test that provokes the message:
 *
 * ```ts
 * it('falls back for an unmapped error code', () => {
 *   allowConsole(/missing translation for "errors\.some_new_code"/);
 *   ...
 * });
 * ```
 *
 * `allowConsole` is per-test: the allowances and the capture buffer are cleared before each test, so
 * one suite can never hand another suite a licence to be noisy.
 */
import { beforeEach, afterEach, onTestFinished, expect } from 'vitest';

type Method = 'error' | 'warn';

interface Allowance {
  pattern: RegExp;
  method: Method | 'any';
}

interface Captured {
  method: Method;
  text: string;
}

const allowances: Allowance[] = [];
const captured: Captured[] = [];

/**
 * The quarantine: known, already-diagnosed noise in a file whose owner has not landed the fix yet.
 *
 * This is a debt register, not an escape hatch. Every entry names one file, one narrowly matched
 * message, and the fix that retires it. It exists because the guard was introduced while another
 * branch held the file, and it should be shorter after every session, never longer. Prefer an
 * `allowConsole()` call inside the test itself: that is a claim the test makes about its own
 * behaviour, whereas an entry here is a promise someone else still owes.
 *
 * Empty is the goal state, and it is the current one: the single entry this register was created
 * for (a DocumentDetail act(...) escape in the QR loading test) has been paid off. An empty
 * register means every suite is held to the guard with no exceptions.
 */
const QUARANTINE: { file: string; pattern: RegExp; owedFix: string }[] = [];

function isQuarantined(entry: Captured): boolean {
  const path = (expect.getState().testPath ?? '').replace(/\\/g, '/');
  return QUARANTINE.some((q) => path.endsWith(q.file) && q.pattern.test(entry.text));
}

/**
 * Declare that this test EXPECTS a console message matching `pattern`, so the guard lets it through.
 *
 * Call it inside the test (or a `beforeEach` scoped to one `describe`), before the code that logs.
 * Pass `method` to pin the allowance to `error` or `warn`; the default accepts either.
 */
export function allowConsole(pattern: RegExp, method: Method | 'any' = 'any'): void {
  allowances.push({ pattern, method });
}

/** Render one console call the way it reached the terminal, so the failure message is greppable. */
function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function isAllowed(entry: Captured): boolean {
  return allowances.some(
    (a) => (a.method === 'any' || a.method === entry.method) && a.pattern.test(entry.text),
  );
}

/**
 * Install the guard for the whole run. Called once from `test-setup.ts`, so every suite is covered
 * rather than only the one that happened to be noisy on the day someone looked.
 */
export function installConsoleGuard(): void {
  // The originals are captured and restored by hand rather than through `vi.spyOn`, so a test that
  // calls `vi.restoreAllMocks()` cannot quietly uninstall the guard halfway through the run.
  const original: Record<Method, typeof console.error> = {
    error: console.error,
    warn: console.warn,
  };

  const restore = () => {
    console.error = original.error;
    console.warn = original.warn;
  };

  beforeEach(() => {
    allowances.length = 0;
    captured.length = 0;
    (['error', 'warn'] as const).forEach((method) => {
      console[method] = (...args: unknown[]) => {
        captured.push({ method, text: format(args) });
      };
    });
    // Belt and braces. The `afterEach` below is where the real console normally comes back, but a
    // hook that throws ahead of it can skip it (see the raise-in-`onTestFinished` note there). An
    // `onTestFinished` hook cannot be skipped that way, so the terminal gets its console back even
    // on the run where everything else went wrong. Restoring twice is a plain reassignment.
    onTestFinished(restore);
  });

  afterEach(() => {
    restore();

    const unexpected = captured.filter((entry) => !isAllowed(entry) && !isQuarantined(entry));
    // Expected messages are swallowed on purpose: they were declared, so printing them would put
    // the noise back. Everything else is replayed in full inside the thrown error.
    captured.length = 0;
    allowances.length = 0;
    if (unexpected.length === 0) return;

    const detail = unexpected
      .map((entry, i) => `${i + 1}. console.${entry.method}: ${entry.text}`)
      .join('\n\n');
    // The act(...) hint is worth its space only when an act(...) warning is what happened; on any
    // other message it would be advice about the wrong problem.
    const actHint = unexpected.some((entry) => entry.text.includes('not wrapped in act'))
      ? 'That act(...) warning means a state update escaped the test: await the thing the ' +
        'component is actually waiting on (findBy*, waitFor) instead of asserting and returning. '
      : '';
    const message =
      `Unexpected console output during this test (${unexpected.length}).\n\n${detail}\n\n` +
      actHint +
      'If the message is genuinely expected, say so in the test with ' +
      "`allowConsole(/pattern/)` from `src/test-console.ts`.";

    // Raised from `onTestFinished`, NOT thrown from here, and that is the whole difference between
    // a guard and an amplifier.
    //
    // Vitest reverses `afterEach` under the default `sequence.hooks: "stack"`, and `callSuiteHook`
    // walks the hooks with a bare `for ... await hook()` and no per-hook `try`. So a hook that
    // throws here aborts every afterEach registered before it, which is Testing Library's
    // auto-cleanup (registered by the RTL import in `test-setup.ts`, which precedes
    // `installConsoleGuard()`). The failed test's tree survived in `document.body` and the NEXT
    // test queried it, so one real defect read as two, in two different files. It cost two separate
    // investigations before the guard was recognised as the thing multiplying them.
    //
    // `onTestFinished` hooks run after the whole afterEach chain and the runner wraps EACH ONE in
    // its own `try/catch` (`callTestHooks`), so this failure lands on the test that earned it and
    // can abort nothing. The verdict is still formed above, in `afterEach`, because that is where
    // the original console has to be back before anything unmounts and where `testPath` is still
    // set for the quarantine lookup.
    onTestFinished(() => {
      throw new Error(message);
    });
  });
}
