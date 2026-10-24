/**
 * The context strip's reads: what the selected line's consequence is made of, fetched from the engine
 * when the line is selected and never computed here. Each hook reads ONE verb, keyed on exactly the facts
 * its answer depends on, and drops an answer that arrives for a line that is no longer selected.
 *
 *   useEntry           get_entry (the entry a line matches or was booked to)
 *   useBatch           get_payment_batch (the run a debit pays)
 *   useLedgerLines     general_ledger on the bank's ledger account (the entries a line can match)
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import type { JournalEntryView, JournalLineView } from '../../../../src/core/ledger/reads';
import type { BankInboxLine } from './model';
import { lineDate, parseInbox, shiftDate } from './model';

export interface EntryDetail {
  entry: JournalEntryView;
  lines: readonly JournalLineView[];
}

export function useEntry(workspaceId: string, entryId: string | null): { entry: EntryDetail | null; loading: boolean; failed: boolean } {
  const client = useClient();
  const [state, setState] = useState<{ id: string | null; entry: EntryDetail | null; failed: boolean }>({ id: null, entry: null, failed: false });
  useEffect(() => {
    if (entryId === null) return undefined;
    let live = true;
    void client.call('get_entry', { workspaceId, entryId }).then((response) => {
      if (!live) return;
      if (isErr(response.body)) setState({ id: entryId, entry: null, failed: true });
      else setState({ id: entryId, entry: { entry: response.body.entry, lines: response.body.lines }, failed: false });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, entryId]);
  if (entryId === null) return { entry: null, loading: false, failed: false };
  return state.id === entryId ? { entry: state.entry, loading: false, failed: state.failed } : { entry: null, loading: true, failed: false };
}

/**
 * D167 polish 10: the entries the DECIDED rows in view were booked to, read once each (`get_entry`), so a
 * Gebucht row can say on its one line what it booked: "Gebucht auf 6570 Informatik · Vorsteuer 8.1 %". A
 * read that fails leaves that row with its kind in words, never an error on the row.
 */
export function useEntries(workspaceId: string, entryIds: readonly string[]): ReadonlyMap<string, EntryDetail> {
  const client = useClient();
  const [cache, setCache] = useState<ReadonlyMap<string, EntryDetail>>(new Map());
  const key = [...new Set(entryIds)].sort().join(',');
  useEffect(() => {
    const wanted = key === '' ? [] : key.split(',');
    const missing = wanted.filter((id) => !cache.has(id));
    if (missing.length === 0) return undefined;
    let live = true;
    void Promise.all(
      missing.map(async (entryId) => {
        const response = await client.call('get_entry', { workspaceId, entryId });
        return isErr(response.body) ? null : ([entryId, { entry: response.body.entry, lines: response.body.lines }] as const);
      }),
    ).then((got) => {
      if (!live) return;
      setCache((prev) => {
        const next = new Map(prev);
        for (const pair of got) if (pair !== null) next.set(pair[0], pair[1]);
        return next;
      });
    });
    return () => {
      live = false;
    };
    // `cache` is read, not watched: a landed answer must not start the reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, key]);
  return cache;
}

export interface BatchDetail {
  executionDate: string | null;
  status: string;
  totalMinor: number | null;
  items: { vendorName: string | null; amountMinor: number; currency: string }[];
}

export function useBatch(workspaceId: string, batchId: string | null): BatchDetail | null {
  const client = useClient();
  const [state, setState] = useState<{ id: string | null; batch: BatchDetail | null }>({ id: null, batch: null });
  useEffect(() => {
    if (batchId === null) return undefined;
    let live = true;
    void client.call('get_payment_batch', { workspaceId, batchId }).then((response) => {
      if (!live || isErr(response.body)) return;
      const b = (response.body as Record<string, unknown>).batch as Record<string, unknown> | undefined;
      if (b === undefined) return;
      const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
      setState({
        id: batchId,
        batch: {
          executionDate: typeof b.executionDate === 'string' ? b.executionDate : null,
          status: typeof b.status === 'string' ? b.status : '',
          totalMinor: typeof b.ctrlSumMinor === 'number' ? b.ctrlSumMinor : null,
          items: items.map((it) => ({
            vendorName: typeof it.vendorName === 'string' ? it.vendorName : null,
            amountMinor: Number(it.amountMinor ?? 0),
            currency: typeof it.currency === 'string' ? it.currency : 'CHF',
          })),
        },
      });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, batchId]);
  return batchId !== null && state.id === batchId ? state.batch : null;
}

/** One posting on the bank's ledger account: a candidate for "Mit bestehender Buchung abgleichen". */
export interface LedgerCandidate {
  entryId: string;
  date: string;
  description: string | null;
  ref: string | null;
  /** Signed on the bank account: + money in, - money out (debit - credit). */
  signedMinor: number;
}

/** The postings on the bank's ledger account within 30 days of the line (general_ledger, A08). */
export function useLedgerLines(workspaceId: string, line: BankInboxLine, bankLedgerId: string | null): { candidates: LedgerCandidate[]; loading: boolean; failed: boolean } {
  const client = useClient();
  const [state, setState] = useState<{ key: string; candidates: LedgerCandidate[]; failed: boolean }>({ key: '', candidates: [], failed: false });
  const date = lineDate(line);
  const key = JSON.stringify([line.bankTxnId, bankLedgerId, date]);
  useEffect(() => {
    if (bankLedgerId === null || date === null) return undefined;
    let live = true;
    void client
      .call('general_ledger', { workspaceId, accountId: bankLedgerId, periodStart: shiftDate(date, -30), periodEnd: shiftDate(date, 30) })
      .then((response) => {
        if (!live) return;
        if (isErr(response.body)) {
          setState({ key, candidates: [], failed: true });
          return;
        }
        const lines = Array.isArray((response.body as Record<string, unknown>).lines) ? ((response.body as Record<string, unknown>).lines as Record<string, unknown>[]) : [];
        const byEntry = new Map<string, LedgerCandidate>();
        for (const l of lines) {
          const entryId = typeof l.entryId === 'string' ? l.entryId : null;
          if (entryId === null) continue;
          const signed = Number(l.debitMinor ?? 0) - Number(l.creditMinor ?? 0);
          const prior = byEntry.get(entryId);
          byEntry.set(entryId, {
            entryId,
            date: typeof l.date === 'string' ? l.date : '',
            description: typeof l.description === 'string' ? l.description : null,
            ref: typeof l.ref === 'string' ? l.ref : null,
            signedMinor: (prior?.signedMinor ?? 0) + signed,
          });
        }
        setState({ key, candidates: [...byEntry.values()], failed: false });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, key]);
  if (bankLedgerId === null || date === null) return { candidates: [], loading: false, failed: false };
  return state.key === key ? { candidates: state.candidates, loading: false, failed: state.failed } : { candidates: [], loading: true, failed: false };
}

const NO_CLAIMS: ReadonlySet<string> = new Set();

/**
 * The entries the decided lines of ONE Bankkonto already hold (booked or matched), so the link chooser
 * marks them taken instead of letting the engine refuse `entry_already_linked`. Claims are per bank leg
 * (critic A39-1): the far side of an own-account transfer is held by the OTHER account's line, so the
 * read is scoped to this account. Up to five pages per state; a longer history only loses the mark,
 * never the engine's guard.
 */
export function useClaimedEntries(workspaceId: string, bankAccountId: string): ReadonlySet<string> {
  const client = useClient();
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: NO_CLAIMS });
  useEffect(() => {
    let live = true;
    void (async () => {
      const ids = new Set<string>();
      for (const status of ['booked', 'matched'] as const) {
        let cursor: string | null = null;
        for (let page = 0; page < 5; page += 1) {
          const input: Record<string, unknown> = { workspaceId, bankAccountId, status, limit: 200, ...(cursor !== null ? { cursor } : {}) };
          const response = await client.call('list_bank_inbox', input);
          const parsed: ReturnType<typeof parseInbox> = isErr(response.body) ? null : parseInbox(response.body);
          if (parsed === null) break;
          for (const l of parsed.lines) if (l.decision?.entryId != null) ids.add(l.decision.entryId);
          cursor = parsed.nextCursor;
          if (cursor === null) break;
        }
      }
      if (live) setState({ key: `${workspaceId}:${bankAccountId}`, ids });
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, bankAccountId]);
  return state.key === `${workspaceId}:${bankAccountId}` ? state.ids : NO_CLAIMS;
}
