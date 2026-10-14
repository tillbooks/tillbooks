/**
 * The bank inbox's one VAT read: `compose_entry` (`expand`) for the drafted `accounts` decision on a line,
 * the same verb the Journal composer asks (D152 amendment). The request is `bankComposeRequest`'s; this
 * hook only sends it and keeps the answer.
 *
 * ONLY THE ANSWER FOR THE REQUEST ON SCREEN COUNTS. Every answer is stored with the signature of the request
 * it answered and read only while that signature is still the current one, so a slow answer for an earlier
 * split, code or line can never stand in for this one (the composer's critic C3 rule). While the current
 * answer is in flight the state is `pending`, and a surface shows nothing: never the previous figure.
 *
 * THE GATE. `compose_entry` needs `read_books` AND `read_vat` (A24, ALL-OF). A person without both is not
 * asked for a preview the engine would refuse: the state is `denied`, and the strip shows no split.
 *
 * FOREIGN CURRENCY (critic F1, medium). `book_bank_line` refuses VAT on a line whose currency is not the
 * books' base currency (`unsupported`, `vat_on_foreign_currency_bank_line`), and `compose_entry` takes no
 * currency, so it would happily compose a split for a booking that can never post. A request with a taxed
 * leg therefore waits for the base currency (`get_company_profile`, read once per client and workspace, the
 * Journal composer's read) and is NOT sent for a foreign-currency line: the state is `foreign`, and the
 * surface says the engine's own sentence instead of a figure.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type TillClient } from '../../lib/client';
import { useCapabilities } from '../../lib/capabilities';
import type { BankComposeRequest, ComposeAnswer } from './bankCompose';
import { composeSignature, requestIsTaxed } from './bankCompose';

/** The capabilities `compose_entry` is gated on (`actionCapabilities.ts`). */
export const COMPOSE_CAPABILITIES = ['read_books', 'read_vat'] as const;

/** The currency the books are kept in when the profile cannot say (the engine's default, as the Journal reads it). */
const DEFAULT_BASE_CURRENCY = 'CHF';

/** One `get_company_profile` read per client and workspace; a failed read is not kept, so the next mount retries. */
const baseReads = new WeakMap<TillClient, Map<string, Promise<string>>>();

function readBaseCurrency(client: TillClient, workspaceId: string): Promise<string> {
  let byWorkspace = baseReads.get(client);
  if (byWorkspace === undefined) {
    byWorkspace = new Map();
    baseReads.set(client, byWorkspace);
  }
  const known = byWorkspace.get(workspaceId);
  if (known !== undefined) return known;
  const forget = () => byWorkspace?.delete(workspaceId);
  const read = client.call('get_company_profile', { workspaceId }).then(
    ({ body }) => {
      if (isErr(body)) {
        forget();
        return DEFAULT_BASE_CURRENCY;
      }
      const base = (body.profile as { baseCurrency?: string | null } | undefined)?.baseCurrency ?? null;
      return base !== null && base !== '' ? base : DEFAULT_BASE_CURRENCY;
    },
    () => {
      forget();
      return DEFAULT_BASE_CURRENCY;
    },
  );
  byWorkspace.set(workspaceId, read);
  return read;
}

/** The books' base currency, or null while it is being read (only read when `needed`). */
export function useBaseCurrency(workspaceId: string, needed: boolean): string | null {
  const client = useClient();
  const [state, setState] = useState<{ workspaceId: string; base: string } | null>(null);
  useEffect(() => {
    if (!needed) return undefined;
    let live = true;
    void readBaseCurrency(client, workspaceId).then((base) => {
      if (live) setState({ workspaceId, base });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, needed]);
  return state !== null && state.workspaceId === workspaceId ? state.base : null;
}

export type BankComposeState =
  /** Nothing to ask: no request (no leg with an account and an amount, no date, no ledger account). */
  | { status: 'none' }
  /** The person lacks `read_books` or `read_vat`. */
  | { status: 'denied' }
  /** A taxed leg on a line in a currency other than the books' base: `book_bank_line` refuses it, nothing is asked. */
  | { status: 'foreign' }
  /** The answer for the current request is not in yet (or the base currency a taxed request waits for). */
  | { status: 'pending' }
  /** The read itself was refused (a transport failure, an invalid request), for the current request. */
  | { status: 'failed'; error: Err }
  /** The engine's answer for the current request: its lines, captions and verdict. */
  | { status: 'answered'; answer: ComposeAnswer };

/**
 * Ask the engine for the current request, debounced by `debounceMs` (the split editor waits for the typing
 * to settle, as the composer does; the strip asks at once). `currency` is the bank line's own currency.
 */
export function useBankCompose(
  workspaceId: string,
  request: BankComposeRequest | null,
  opts: { debounceMs?: number; currency: string },
): BankComposeState {
  const client = useClient();
  const { can } = useCapabilities();
  const allowed = COMPOSE_CAPABILITIES.every((c) => can(c));
  const taxed = request !== null && requestIsTaxed(request);
  const base = useBaseCurrency(workspaceId, allowed && taxed);
  const foreign = taxed && base !== null && opts.currency !== base;
  const send = allowed && request !== null && (!taxed || (base !== null && !foreign));
  const signature = composeSignature(workspaceId, request);
  const debounceMs = opts.debounceMs ?? 0;
  const [answer, setAnswer] = useState<{ signature: string; body: ComposeAnswer | Err } | null>(null);

  useEffect(() => {
    if (!send || request === null) return undefined;
    let live = true;
    const ask = () => {
      client
        .call('compose_entry', { workspaceId, mode: 'expand', date: request.date, lines: request.lines })
        .then(
          ({ body }) => {
            if (live) setAnswer({ signature, body: body as unknown as ComposeAnswer | Err });
          },
          () => {
            if (live) setAnswer({ signature, body: { ok: false, error: 'transport_error' } as Err });
          },
        );
    };
    const timer = debounceMs > 0 ? setTimeout(ask, debounceMs) : null;
    if (timer === null) ask();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
    // Keyed on the signature, which names the workspace and everything the request carries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, signature, send, debounceMs]);

  if (!allowed) return { status: 'denied' };
  if (request === null) return { status: 'none' };
  if (foreign) return { status: 'foreign' };
  if (!send || answer === null || answer.signature !== signature) return { status: 'pending' };
  if (isErr(answer.body)) return { status: 'failed', error: answer.body };
  if (answer.body.mode !== 'expand') return { status: 'pending' };
  return { status: 'answered', answer: answer.body };
}
