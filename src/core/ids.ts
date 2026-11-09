/**
 * Id generation, injected.
 *
 * Ids are prefixed so a bare id says what it identifies (`entry_...`, `ws_...`). Production draws
 * randomness from `crypto.randomUUID`; tests use `sequenceIdGen` so fixtures read `entry_1`,
 * `entry_2` and idempotency/audit assertions stay deterministic.
 */

import { randomUUID } from 'node:crypto';

export interface IdGen {
  next(prefix: string): string;
}

export const systemIdGen: IdGen = {
  next: (prefix) => `${prefix}_${randomUUID()}`,
};

/** A deterministic generator with an independent counter per prefix. */
export function sequenceIdGen(): IdGen {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
}
