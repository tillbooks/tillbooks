/**
 * N01 US-N01.5: a verb's ARGUMENT IDENTITY, the one identity both replay paths compare (the registry
 * boundary through `claimIdempotencyArgs`, the drafted action in `enqueueDraftedAction`).
 *
 * It is `idempotencyArgsIdentity` (`src/core/store/idempotencyArgs.ts`, where the canonical form is
 * decided) plus the one per-verb transport field: the confirm flag an APPROVAL replay injects
 * (`APPROVAL_CONFIRMS_FIELD`, D156 point 5). Approving a Vorschlag IS the human confirmation, so the
 * replay carries `confirmed: true` the drafted payload did not; were the flag hashed, the approved act
 * would stand for different arguments than the call it approved, and the agent's own retry of that
 * call would refuse. Its own module so the store never imports the dial map.
 *
 * `freeTextPolicy` reads the D172 setting `idempotency.hash_free_text` for the workspace (default
 * `exclude`), so the comparison a workspace runs is the one its owner chose.
 */

import type { WorkspaceContext } from '../context.js';
import {
  HASH_FREE_TEXT_SETTING,
  HASH_FREE_TEXT_VALUES,
  idempotencyArgsIdentity,
  idempotencyArgsHash,
  type ArgsIdentity,
  type FreeTextPolicy,
} from '../store/idempotencyArgs.js';
import { getSetting } from '../settings/settings.js';
import { APPROVAL_CONFIRMS_FIELD } from './dialMap.js';
import { SECRET_ARG_FIELDS } from './secretArgs.js';

function transportOf(verb: string): string[] {
  const confirm = APPROVAL_CONFIRMS_FIELD[verb];
  return confirm === undefined ? [] : [confirm];
}

/**
 * D198 (security review, 12.11.2026): a verb's SECRET arguments, from the one registry (`secretArgs.ts`, re-cut
 * R7). A plain hash of a credential in `idempotency_args` would let anyone holding the book test a guessed
 * token offline, so the field is replaced by whether it was given: the same key with a token and without one
 * still differs, while the value never reaches the book.
 */

function withoutSecrets(verb: string, input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const fields = SECRET_ARG_FIELDS[verb];
  if (fields === undefined) return input;
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) {
    const given = typeof out[f] === 'string' && (out[f] as string).length > 0;
    delete out[f];
    out[`${f}Given`] = given;
  }
  return out;
}

export function verbArgsIdentity(verb: string, input: Readonly<Record<string, unknown>>): ArgsIdentity {
  return idempotencyArgsIdentity(withoutSecrets(verb, input), transportOf(verb));
}

export function verbArgsHash(verb: string, input: Readonly<Record<string, unknown>>): string {
  return idempotencyArgsHash(withoutSecrets(verb, input), transportOf(verb));
}

/** The workspace's `idempotency.hash_free_text`, or the default when it cannot be read. */
export function freeTextPolicy(ctx: WorkspaceContext): FreeTextPolicy {
  try {
    const value = getSetting<string>(ctx, HASH_FREE_TEXT_SETTING);
    return (HASH_FREE_TEXT_VALUES as readonly string[]).includes(value) ? (value as FreeTextPolicy) : 'exclude';
  } catch {
    return 'exclude';
  }
}
