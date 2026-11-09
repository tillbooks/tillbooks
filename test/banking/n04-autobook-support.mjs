// N04 (D183) test support: a bank world with a granted Buchungsregel, the scheduler's autobook step and a
// clock the scenario moves. SYNTHETIC DATA ONLY: the counterparties are invented names on invented IBANs
// (TELCO_IBAN, the published samples); `iban: null` imports a name-only line, every statement is spelled by hand (bank-inbox-support.mjs) and every
// amount is invented.

import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { world, importLines, must, TELCO_IBAN } from './bank-inbox-support.mjs';

export const TELCO = 'Fernmeldewerk Beispiel AG';
export { TELCO_IBAN };

/** The inbox proposal of one line. */
export const proposalOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0].proposal;

/** Move the shared clock (every context and the registry deps read it). */
export function at(t, iso) {
  t.clock.now = () => iso;
}

let seq = 0;
/** The next free day per book (keyed by the store: a spread world is a new object over the same book). */
const cursor = new WeakMap();
/** Days between two lines: wider than the duplicate check's near-date window. */
const STRIDE = 5;

const dayAfter = (iso, n) => new Date(Date.parse(`${iso}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Import `amounts` as debit lines of one counterparty, one line every STRIDE days, each statement covering
 * only its own days (so no statement overlaps another, and equal amounts are far enough apart that no line
 * reads as a possible duplicate). The days run on from 2026-01-05 per world, or from `from`. Answers the
 * line ids in order.
 */
export function debits(t, amounts, { name = TELCO, iban = TELCO_IBAN, from, ustrd, cd = 'DBIT' } = {}) {
  seq += 1;
  const start = from ?? cursor.get(t.store) ?? '2026-01-05';
  const dates = amounts.map((_, i) => dayAfter(start, i * STRIDE));
  cursor.set(t.store, dayAfter(start, amounts.length * STRIDE));
  const res = importLines(t, {
    statementId: `N04-${seq}`,
    seqNb: String(seq),
    from: dates[0],
    to: dates[dates.length - 1],
    // The bank's own reference is unique per line: a shared one would read as the same movement.
    entries: amounts.map((a, i) => ({ ref: `N04S${seq}L${i + 1}`, cd, name, ...(iban === null ? {} : { iban }), amountMinor: a, date: dates[i], ...(ustrd ? { ustrd } : {}) })),
  });
  return amounts.map((_, i) => res.lines[`N04S${seq}L${i + 1}`]);
}

/** A world with a complete Buchungsregel (TELCO -> 6570) and the offer threshold at `offerAfter`. */
export function ruleWorld({ offerAfter = 3, account = '6570', taxCode = null } = {}) {
  const t = world();
  const [first] = debits(t, [1000]);
  const ruleId = must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc(account), taxCode, idempotencyKey: 'rule-v1' })).standard.id;
  must(settingsSet(t.ctx, { key: 'rules.autobook_offer_after', value: offerAfter, reason: 'N04 test', idempotencyKey: `oa-${offerAfter}` }));
  return { ...t, ruleId, firstLine: first };
}

/** Book a line exactly as the inbox proposes it (a clean use when a rule proposes it). */
export function bookAsProposed(t, id, ctx = t.ctx) {
  return must(bookBankLine(ctx, { bankTxnId: id, target: proposalOf(t, id).target, idempotencyKey: `clean-${id}` }));
}

/** The scheduler over the world's deps, with only the N04 steps on (no G01, miner, bank or Belegeingang). */
export function autopilot(t) {
  const scheduler = createScheduler(t.deps, {
    listWorkspaceIds: () => [t.workspaceId],
    runDue: () => undefined,
    bankAutoSync: false,
    ruleMiner: false,
    belegeingang: false,
  });
  return { tick: () => scheduler.autopilotTickOnce(t.workspaceId), scheduler };
}

/** Every autobook_run row of the world, oldest first. */
export const runs = (t) => t.store.db.prepare('SELECT * FROM autobook_run WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);

/** The live decision of a line, or undefined. */
export const decisionOf = (t, id) =>
  t.store.db.prepare('SELECT * FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL').get(t.workspaceId, id);

/** How many posted entries the world holds. */
export const entryCount = (t) => t.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(t.workspaceId).n;
