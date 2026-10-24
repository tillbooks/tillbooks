/**
 * CRITIC PROBES, round 2 (bank-parity E1, the Belegnummer). Non-author. Synthetic by construction: every ref,
 * amount and date is drawn from a seeded generator.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROPERTY: under ANY interleaving of migrated imports (plain integers, bexio refs, repeated bexio refs = split
 * pieces, free text), native posts, reversals, and changes of all four numbering settings, in two workspaces
 * of one book, no operation throws, and after every operation:
 *  1. a number (series, number) or a display is read by several entries ONLY when all are adopted pieces of
 *     ONE voucher (same non-null voucher_ref);
 *  2. an adopted number is the number the entry's own ref names, and only a migrated entry adopts;
 *  3. per series, TILL's assigned numbers are one gap-free run and the counter stands right after it;
 *  4. a posted entry without a number exists only while a catch-up is owed (the pending marker) or mode is off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { migratedVoucherOf } from '../../dist/core/ledger/entryNumber.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AT = '2026-07-16T00:00:00.000Z';

function world() {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const ids = sequenceIdGen();
  const ctxs = {};
  for (const ws of ['wa', 'wb']) {
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, 'CHF', '07-01', ?)").run(ws, ws, AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, '6500', 'Büro', 'expense')").run(`${ws}_6500`, ws);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, '1020', 'Bank', 'asset')").run(`${ws}_1020`, ws);
    ctxs[ws] = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids });
  }
  return { store, ctxs };
}

function violations(store) {
  const db = store.db;
  const out = [];
  const shared = (col) =>
    db
      .prepare(
        `SELECT workspace_id, ${col} AS k, COUNT(*) AS c, SUM(origin = 'adopted') AS ad, COUNT(DISTINCT voucher_ref) AS v, SUM(voucher_ref IS NULL) AS nul
           FROM journal_entry_number GROUP BY workspace_id, ${col} HAVING c > 1`,
      )
      .all();
  for (const r of shared("series || '|' || number")) {
    if (!(r.ad === r.c && r.v === 1 && r.nul === 0)) out.push(`number ${r.workspace_id}/${r.k} read by ${r.c} entries not of one voucher`);
  }
  for (const r of shared('display')) {
    if (!(r.ad === r.c && r.v === 1 && r.nul === 0)) out.push(`display ${r.workspace_id}/${r.k} read by ${r.c} entries not of one voucher`);
  }
  for (const r of db
    .prepare(
      `SELECT n.entry_id, n.number, n.display, n.voucher_ref, e.ref, e.source, e.idempotency_key FROM journal_entry_number n
         JOIN journal_entry e ON e.id = n.entry_id WHERE n.origin = 'adopted'`,
    )
    .all()) {
    const v = migratedVoucherOf(r.ref);
    if (r.source !== 'import') out.push(`a ${r.source} entry ${r.entry_id} adopted ${r.display}`);
    if (v === null || v.number !== r.number) out.push(`${r.entry_id} adopted ${r.number} but its ref is ${JSON.stringify(r.ref)}`);
  }
  for (const s of db.prepare('SELECT DISTINCT workspace_id, series FROM journal_entry_number').all()) {
    const assigned = db
      .prepare("SELECT number FROM journal_entry_number WHERE workspace_id = ? AND series = ? AND origin = 'assigned' ORDER BY number")
      .all(s.workspace_id, s.series)
      .map((r) => r.number);
    for (let i = 1; i < assigned.length; i += 1) {
      if (assigned[i] !== assigned[i - 1] + 1) out.push(`${s.workspace_id}/${s.series}: assigned gap ${assigned[i - 1]} -> ${assigned[i]}`);
    }
    const counter = db
      .prepare("SELECT next_value FROM document_number_seq WHERE workspace_id = ? AND type = 'journal' AND year = ?")
      .get(s.workspace_id, s.series)?.next_value;
    const highest = db.prepare('SELECT MAX(number) AS m FROM journal_entry_number WHERE workspace_id = ? AND series = ?').get(s.workspace_id, s.series).m;
    if (assigned.length > 0 && counter !== assigned.at(-1) + 1) out.push(`${s.workspace_id}/${s.series}: counter ${counter} after assigned ${assigned.at(-1)}`);
    if (counter !== undefined && counter <= highest) out.push(`${s.workspace_id}/${s.series}: counter ${counter} not above the highest ${highest}`);
  }
  for (const ws of ['wa', 'wb']) {
    const unnumbered = db
      .prepare("SELECT COUNT(*) AS n FROM journal_entry e WHERE e.workspace_id = ? AND e.status = 'posted' AND NOT EXISTS (SELECT 1 FROM journal_entry_number n WHERE n.entry_id = e.id)")
      .get(ws).n;
    const pending = db.prepare('SELECT COUNT(*) AS n FROM journal_numbering_pending WHERE workspace_id = ?').get(ws).n;
    if (unnumbered > 0 && pending === 0) out.push(`${ws}: ${unnumbered} posted entries without a number and no catch-up owed`);
  }
  return out;
}

const SETTING_VALUES = {
  'ledger.belegnummer_mode': ['continue_migrated', 'continue_migrated', 'from_start', 'per_fiscal_year', 'off'],
  'ledger.belegnummer_start': [1, 5, 40, 100],
  'ledger.belegnummer_prefix': ['', '', 'B', 'B-', 'X.', '2026-', '7.'],
  'ledger.belegnummer_split_voucher': ['share', 'suffix', 'first_keeps'],
};

test('[R2 PROPERTY] 200 seeded histories: no throw, one voucher per shared number, adopted = own ref, assigned gap-free, nothing silently unnumbered', (t) => {
  const failures = [];
  const stats = { adopted: 0, sharedNumbers: 0, suffixed: 0, refusedSettings: 0, assigned: 0 };
  for (let seed = 1; seed <= 200 && failures.length < 5; seed += 1) {
    const r = rng(seed);
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const { store, ctxs } = world();
    const refsSeen = [];
    const posted = { wa: [], wb: [] };
    const trace = [];
    for (let step = 0; step < 60; step += 1) {
      const ws = r() < 0.75 ? 'wa' : 'wb';
      const ctx = ctxs[ws];
      const date = `${pick(['2025', '2026'])}-${pick(['01', '03', '06', '07', '09', '12'])}-${pick(['01', '15', '28'])}`;
      const lines = (amt) => [
        { account: `${ws}_6500`, debit: amt },
        { account: `${ws}_1020`, credit: amt },
      ];
      const roll = r();
      let op;
      try {
        if (roll < 0.45) {
          let ref;
          const kind = r();
          if (kind < 0.3) ref = String(1 + Math.floor(r() * 30));
          else if (kind < 0.7) ref = `${pick(['Manuelle Buchung', 'Bank Buchung'])} ${1 + Math.floor(r() * 4)} (${1 + Math.floor(r() * 30)})`;
          else if (kind < 0.9 && refsSeen.length > 0) ref = pick(refsSeen);
          else ref = pick(['Rechnung (12)', 'B-7', '', '0042']);
          if (ref !== '') refsSeen.push(ref);
          op = `${ws} import ${JSON.stringify(ref)} ${date}`;
          const res = postEntry(ctx, { date, source: 'import', idempotencyKey: `s${step}`, ...(ref === '' ? {} : { ref }), lines: lines(100 + step) });
          if (!res.ok) throw new Error(`import refused ${JSON.stringify(res)}`);
          posted[ws].push(res.entryId);
        } else if (roll < 0.65) {
          op = `${ws} native ${date}`;
          const res = postEntry(ctx, { date, source: 'manual', idempotencyKey: `s${step}`, lines: lines(100 + step) });
          if (!res.ok) throw new Error(`native refused ${JSON.stringify(res)}`);
          posted[ws].push(res.entryId);
        } else if (roll < 0.75 && posted[ws].length > 0) {
          const target = pick(posted[ws]);
          op = `${ws} reverse ${target}`;
          const res = reverseEntry(ctx, { entryId: target, idempotencyKey: `s${step}` });
          if (res.ok) posted[ws].push(res.reversalId);
          else if (!['already_reversed', 'not_posted', 'is_reversal', 'reversal_of_reversal'].includes(res.error)) op += ` -> ${res.error}`;
        } else {
          const key = pick(Object.keys(SETTING_VALUES));
          const value = pick(SETTING_VALUES[key]);
          op = `${ws} set ${key}=${JSON.stringify(value)}`;
          const res = settingsSet(ctx, { key, value, reason: 'fuzz', idempotencyKey: `s${step}` });
          if (!res.ok) { op += ` -> ${res.error}${res.display ? ` ${res.display}` : ''}`; stats.refusedSettings += 1; }
        }
      } catch (e) {
        trace.push(op);
        failures.push(`seed ${seed} step ${step}: ${op} THREW ${e.message}\n    ${trace.slice(-12).join('\n    ')}`);
        break;
      }
      trace.push(op);
      const v = violations(store);
      if (v.length > 0) {
        failures.push(`seed ${seed} step ${step}: ${v.join('; ')}\n    ${trace.slice(-12).join('\n    ')}`);
        break;
      }
    }
    const db = store.db;
    stats.adopted += db.prepare("SELECT COUNT(*) AS n FROM journal_entry_number WHERE origin = 'adopted'").get().n;
    stats.assigned += db.prepare("SELECT COUNT(*) AS n FROM journal_entry_number WHERE origin = 'assigned'").get().n;
    stats.sharedNumbers += db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM journal_entry_number GROUP BY workspace_id, series, number HAVING COUNT(*) > 1)').get().n;
    stats.suffixed += db.prepare("SELECT COUNT(*) AS n FROM journal_entry_number WHERE display LIKE '%.%' AND origin = 'adopted' AND display NOT LIKE 'X.%' AND display NOT LIKE '7.%'").get().n;
    store.close();
  }
  t.diagnostic(JSON.stringify(stats));
  assert.deepEqual(failures, [], failures.join('\n'));
});
