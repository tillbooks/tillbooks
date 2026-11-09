/**
 * Transport seams for LOADING-state tests, so the correct form of the test is the easy one.
 *
 * Why this exists. Every surface here initialises `loading` to `true`, which means the skeleton is
 * on screen from the very first commit, before any effect has fired. A test that renders a surface
 * against a never-answering transport and asserts `role="status"` therefore proves nothing about
 * the read: the same assertion passes over a surface whose effect never ran, whose workspace guard
 * silently swallowed the call, or which has no read at all. The skeleton is the DEFAULT, not
 * evidence. Twelve tests across ten files were written in exactly that shape, and each one would
 * have stayed green while its surface quietly stopped asking the engine for anything.
 *
 * `watchReads` closes that hole in one line: the test waits for the action it is asserting over to
 * have actually been asked for, and only then claims the skeleton is a load in progress. The failure
 * message names what the surface DID ask, so a broken read reads as a broken read rather than as a
 * mystery timeout.
 *
 *     const transport = watchReads(neverSettles);
 *     render(<Surface />);            // with `new TillClient(transport)` in scope
 *     await transport.started('list_accounts');
 *     expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
 *
 * The wait goes BEFORE the assertion on purpose. Asserting first and waiting afterwards would still
 * pass on a surface that renders a skeleton and only later decides to read.
 */
import { waitFor } from '@testing-library/react';

import type { RestResponse, Transport } from './lib/client';

/**
 * A transport that never answers, so the surface stays in its loading state for the whole test.
 *
 * Pair it with `watchReads` rather than using it alone: on its own it cannot tell a load in flight
 * apart from a load that never started.
 */
export const neverSettles: Transport = () => new Promise<RestResponse>(() => {});

/** A transport that answers nothing for `action` and delegates every other action to `inner`. */
export function hang(action: string, inner: Transport): Transport {
  return (a, input) => (a === action ? neverSettles(a, input) : inner(a, input));
}

export interface WatchedTransport extends Transport {
  /** Every action the tree has asked for, in the order it asked. */
  readonly asked: string[];
  /**
   * Resolve once `action` has been asked for at least `times` times.
   *
   * Rejects with the list of actions that WERE asked, which is the difference between "the read is
   * slow" and "the surface never issued it".
   */
  started(action: string, times?: number): Promise<void>;
}

/** Wrap a transport so a LOADING test can prove the read it asserts over really started. */
export function watchReads(inner: Transport): WatchedTransport {
  const asked: string[] = [];
  const started = (action: string, times = 1): Promise<void> =>
    waitFor(() => {
      const seen = asked.filter((a) => a === action).length;
      if (seen < times) {
        throw new Error(
          `Expected the tree to have asked for "${action}" at least ${times}x while its loading ` +
            `state was on screen, but it asked ${seen}x. Actions asked so far: ` +
            `${asked.length === 0 ? '(none at all)' : asked.join(', ')}.`,
        );
      }
    });
  const call: Transport = (action, input) => {
    asked.push(action);
    return inner(action, input);
  };
  return Object.assign(call, { asked, started });
}
