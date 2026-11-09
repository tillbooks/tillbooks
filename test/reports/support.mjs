// Test support for A08 (financial statements: Saldenbilanz, Bilanz, Erfolgsrechnung, Kontoblatt).
//
// A08 is a pure read model (Pattern P5) over the journal A02 wrote, so this fixture posts through
// the REAL `postEntry` and never inserts a `journal_line` by hand. A statement computed over rows
// that no writer produced would agree with nothing, and the whole capability is the claim that the
// four reports and the ledger say the same thing.
//
// THE FIXTURE IS DELIBERATELY AWKWARD, for the reason A07's critic found the hard way: a single-sign,
// single-section book agrees with a wrong calculation by luck. So the books below carry
//
//   - a DEBIT on an income account (3800 Erlösminderungen) and a CREDIT on an expense account
//     (4900 erhaltene Skonti), so a sign or `Math.abs` bug cannot survive;
//   - accounts in six different Bilanz/ER sections, so an allocation bug that preserves the grand
//     total still moves a section subtotal;
//   - an opening carry dated in the prior year, so the period window has something to exclude and
//     something to carry;
//   - a DRAFT, which must never reach a figure (§H-AUDIT).
//
// Every expected figure below is written out as a literal, not recomputed from the same helper the
// code under test uses. The chart is the shipped KMU seed and nothing is added to it.

import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry, saveDraft, ledgerPorts } from '../../dist/core/ledger/index.js';
import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';

export const AT = '2026-07-19T00:00:00.000Z';

/** The reporting window every case uses unless it says otherwise: Q1 2026. */
export const PERIOD = { periodStart: '2026-01-01', periodEnd: '2026-03-31' };
/** The prior quarter, for the comparison column (US-A08.5). */
export const PRIOR = { periodStart: '2025-10-01', periodEnd: '2025-12-31' };

/**
 * One workspace with the shipped KMU chart, in a store the caller can put a SECOND workspace into.
 *
 * `secondWorkspace` shares this store on purpose. A §H-TENANT test that builds a fresh `SqliteStore`
 * per workspace proves nothing: the two databases are separate files and both workspaces are minted
 * `ws_1`, so neutralising the workspace filter still passes. That defect shipped in A07's tenant
 * test and is exactly what this shape prevents.
 */
export function setup({ at = AT, name = 'Muster Grafik GmbH' } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  assertChartIsExactlyTheSeed(store, workspaceId);
  return {
    store,
    deps,
    ctx,
    clock,
    ids,
    workspaceId,
    acc: (number) => accountId(store, workspaceId, number),
    /** A context on the same workspace with A03's real period port, for the close/lock cases. */
    withRealPeriods: () =>
      makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) }),
  };
}

/**
 * A SECOND workspace inside the SAME database. Mint it FIRST in a tenant test: a neutralised
 * workspace filter on a `.get()` degenerates to "whichever row comes first", so a test that mints
 * the other tenant last can pass while the filter does nothing at all.
 */
export function secondWorkspace(t, name = 'Nachbar AG') {
  const workspaceId = createWorkspace(t.deps, { name }).workspaceId;
  const ctx = makeContext(t.store, { workspaceId, actor: 'user_2', clock: t.clock, ids: t.ids });
  return { ctx, workspaceId, acc: (number) => accountId(t.store, workspaceId, number) };
}

function accountId(store, workspaceId, number) {
  return store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(workspaceId, number)?.id;
}

/**
 * The chart every A08 case runs against is EXACTLY the shipped seed.
 *
 * A08 buckets accounts into statutory sections BY NUMBER, so a fixture carrying one hand-made
 * account is a fixture where the section map can be wrong about the product and right about the
 * test. A14's support file learned this after every one of its posting-account assertions turned out
 * to be true of an invented chart; the same trap is live here and worse, because a statement is
 * nothing but a bucketing of the chart.
 */
function assertChartIsExactlyTheSeed(store, workspaceId) {
  const rows = store.db
    .prepare('SELECT number, name, type FROM account WHERE workspace_id = ? ORDER BY number')
    .all(workspaceId);
  const expected = [...KMU_CORE_SEED]
    .map((a) => ({ number: a.number, name: a.name, type: a.type }))
    .sort((x, y) => x.number.localeCompare(y.number));
  assert.deepEqual(rows, expected, 'the A08 fixture chart must be the shipped seed and nothing else');
}

/** Post a balanced entry by ACCOUNT NUMBER, so a fixture reads like a journal and not like ids. */
export function post(t, { date, key, ref, description, currency, fxRate, source = 'manual', lines }) {
  const res = postEntry(t.ctx, {
    date,
    source,
    idempotencyKey: key,
    ...(ref !== undefined ? { ref } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(fxRate !== undefined ? { fxRate } : {}),
    lines: lines.map((l) => ({
      account: t.acc(l.n),
      ...(l.debit !== undefined ? { debit: l.debit } : {}),
      ...(l.credit !== undefined ? { credit: l.credit } : {}),
    })),
  });
  if (!res.ok) throw new Error(`post failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * The canonical A08 books: an opening carry in 2025 plus nine Q1-2026 movements and one draft.
 *
 * Every figure is integer Rappen. The literals the tests assert against are in `EXPECTED` below and
 * are worked out by hand from this list, never by calling the code under test.
 */
export function seedBooks(t, { loss = false } = {}) {
  // A04 opening balances, dated the last day of the prior year: ordinary posted lines (§4), which is
  // why nothing here is a special "opening" row type.
  post(t, {
    date: '2025-12-31',
    key: 'opening',
    ref: 'EB-2026',
    description: 'Eröffnungsbilanz',
    lines: [
      { n: '1000', debit: 500000 },
      { n: '1020', debit: 2000000 },
      { n: '1500', debit: 1200000 },
      { n: '2000', credit: 700000 },
      { n: '2400', credit: 1000000 },
      { n: '2800', credit: 2000000 },
    ],
  });

  post(t, {
    date: '2026-01-15',
    key: 'rev-1',
    ref: 'RE-0001',
    description: 'Beratungshonorar',
    lines: [
      { n: '1100', debit: 1081000 },
      { n: '3400', credit: 1000000 },
      { n: '2200', credit: 81000 },
    ],
  });
  post(t, {
    date: '2026-02-03',
    key: 'rev-2',
    ref: 'RE-0002',
    description: 'Warenverkauf',
    lines: [
      { n: '1020', debit: 540500 },
      { n: '3200', credit: 500000 },
      { n: '2200', credit: 40500 },
    ],
  });
  // A DEBIT on an income account. Without this the whole income side is one sign and a calculation
  // that flips it agrees with the fixture.
  post(t, {
    date: '2026-02-10',
    key: 'rabatt',
    ref: 'GS-0001',
    description: 'Nachträglicher Rabatt',
    lines: [
      { n: '3800', debit: 30000 },
      { n: '1100', credit: 30000 },
    ],
  });
  post(t, {
    date: '2026-02-25',
    key: 'lohn',
    description: 'Loehne Februar',
    lines: [
      { n: '5000', debit: 600000 },
      { n: '1020', credit: 600000 },
    ],
  });
  post(t, {
    date: '2026-03-05',
    key: 'office',
    description: 'Bürokosten',
    lines: [
      { n: '6500', debit: 120000 },
      { n: '1020', credit: 120000 },
    ],
  });
  post(t, {
    date: '2026-03-31',
    key: 'abschreibung',
    description: 'Abschreibung Maschinen',
    lines: [
      { n: '6800', debit: 200000 },
      { n: '1500', credit: 200000 },
    ],
  });
  // A CREDIT on an expense account: the mirror of the 3800 case on the cost side.
  post(t, {
    date: '2026-03-10',
    key: 'skonto',
    description: 'Erhaltener Skonto',
    lines: [
      { n: '2000', debit: 15000 },
      { n: '4900', credit: 15000 },
    ],
  });
  post(t, {
    date: '2026-03-20',
    key: 'zins',
    description: 'Kreditzins',
    lines: [
      { n: '6900', debit: 25000 },
      { n: '1020', credit: 25000 },
    ],
  });

  if (loss) {
    post(t, {
      date: '2026-03-28',
      key: 'grossausgabe',
      description: 'Ausserordentlicher Aufwand',
      lines: [
        { n: '6700', debit: 1000000 },
        { n: '1020', credit: 1000000 },
      ],
    });
  }

  // §H-AUDIT: a draft must never reach a figure. It is deliberately enormous, so a report that
  // counts it is off by an amount nobody could mistake for a rounding difference.
  const draft = saveDraft(t.ctx, {
    date: '2026-03-15',
    idempotencyKey: 'draft-1',
    lines: [
      { account: t.acc('6500'), debit: 99999900 },
      { account: t.acc('1020'), credit: 99999900 },
    ],
  });
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft)}`);
  return { draftEntryId: draft.entryId };
}

/**
 * Every figure the profit fixture (`seedBooks(t)`) must produce, worked out by hand from the entry
 * list above. Written as literals so a test compares the code against ARITHMETIC and not against a
 * second call to the same code.
 */
export const EXPECTED = {
  /** Bilanz at 2026-03-31: account number -> presentation balance (positive on the account's side). */
  balances: {
    '1000': 500000,
    '1020': 1795500, // 2000000 + 540500 - 600000 - 120000 - 25000
    '1100': 1051000, // 1081000 - 30000
    '1500': 1000000, // 1200000 - 200000
    '2000': 685000, //  700000 - 15000
    '2200': 121500, //   81000 + 40500
    '2400': 1000000,
    '2800': 2000000,
  },
  bilanz: {
    umlaufvermoegen: 3346500, // 500000 + 1795500 + 1051000
    anlagevermoegen: 1000000,
    uebrige_aktiven: 0,
    kurzfristiges_fremdkapital: 806500, // 685000 + 121500
    langfristiges_fremdkapital: 1000000,
    eigenkapital: 2540000, // 2000000 Kapital + 540000 Jahresergebnis
    uebrige_passiven: 0,
    aktiven: 4346500,
    passiven: 4346500,
  },
  /** Erfolgsrechnung Q1 2026, every position signed as its CONTRIBUTION TO PROFIT (credit - debit). */
  erfolgsrechnung: {
    netto_erloese: 1470000, // 1000000 + 500000 - 30000
    bestandes_aenderungen: 0,
    materialaufwand: 15000, // the 4900 Skonto is a credit, so it ADDS to profit
    personalaufwand: -600000,
    uebriger_betrieblicher_aufwand: -120000,
    abschreibungen: -200000,
    finanzergebnis: -25000,
    betriebsfremder_erfolg: 0,
    ausserordentlicher_erfolg: 0,
    direkte_steuern: 0,
    uebrige_positionen: 0,
    reingewinn: 540000,
  },
  /**
   * Saldenbilanz Q1 2026 grand totals. The 2025-12-31 opening entry falls OUTSIDE the window, so it
   * lands in the opening column and contributes nothing to the period debit/credit totals.
   *
   * 1081000 + 540500 + 30000 + 600000 + 120000 + 200000 + 15000 + 25000 = 2611500.
   */
  trial: {
    debit: 2611500,
    credit: 2611500,
    /** Σ opening and Σ closing are both zero: a balanced ledger nets to nothing across all accounts. */
    opening: 0,
    closing: 0,
  },
};

/**
 * A BROKEN IMPORTER: a posted entry whose lines do not balance, written straight to the tables.
 *
 * Every reconciliation flag A08 reports used to survive being replaced by the literal `true`, and no
 * test had ever observed one as `false`. The reason was not that the flags are fake, it is that a
 * book written through `postEntry` satisfies them by construction: `postEntry` refuses an unbalanced
 * entry, and the `posted_immutable` triggers refuse a `DELETE` of a posted line or an `INSERT` into
 * a posted entry. So the state the flags exist to detect looked unreachable.
 *
 * It is not. The flags' own docstring says what they guard: "the paths that DO NOT go through
 * `postEntry`: a restored file, a migration, a future importer". The triggers all key on
 * `OLD.status = 'posted'`, and the schema comment beside them says why: "A posting writes its rows
 * while the entry is still 'draft' and flips to 'posted' as the last step, so these triggers never
 * fire on the legitimate post." An importer does the same three steps, and if it gets the arithmetic
 * wrong nothing stops it. That is what this writes, and it is the honest shape of the failure: a
 * corrupt database, not a reporting bug.
 *
 * Deliberately NOT routed through `postEntry`, and this is the one fixture in A08 that may do that.
 */
export function importRawEntry(t, { id = 'bad_entry', date, lines }) {
  const db = t.store.db;
  db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at)
     VALUES (?, ?, ?, 'draft', 'import', ?)`,
  ).run(id, t.workspaceId, date, AT);
  lines.forEach((line, i) => {
    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;
    db.prepare(
      `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency,
                                 base_debit_minor, base_credit_minor)
       VALUES (?, ?, ?, ?, ?, 'CHF', ?, ?)`,
    ).run(`${id}_line_${i}`, id, t.acc(line.n), debit, credit, debit, credit);
  });
  db.prepare('UPDATE journal_entry SET status = ? WHERE id = ?').run('posted', id);
  const status = db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(id).status;
  assert.equal(status, 'posted', 'the corrupt-import fixture did not actually post: the case would be vacuous');
  return id;
}

/** The common case: one posted line with nothing on the other side. */
export function importUnbalancedEntry(t, { id, date, number, debit = 0, credit = 0 }) {
  return importRawEntry(t, { ...(id !== undefined ? { id } : {}), date, lines: [{ n: number, debit, credit }] });
}

/**
 * The net movement on one account number, computed the long way round straight off `journal_line`.
 *
 * Deliberately NOT the helper the read models use. Two derivations that call the same function agree
 * by construction and prove nothing; these two agree only if the statement and the ledger really say
 * the same thing. Debit-positive, POSTED only, workspace-fenced.
 */
export function ledgerNet(store, workspaceId, number, { from, to } = {}) {
  const clauses = ["a.workspace_id = ?", "a.number = ?", "e.status = 'posted'"];
  const params = [workspaceId, number];
  if (from !== undefined) {
    clauses.push('e.date >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    clauses.push('e.date <= ?');
    params.push(to);
  }
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE ${clauses.join(' AND ')}`,
    )
    .get(...params).net;
}

/** Find a section by key in a `sections` array. */
export function sectionFor(result, key) {
  const found = result.sections.find((s) => s.key === key);
  assert.ok(found !== undefined, `no section ${key} in ${result.sections.map((s) => s.key).join(', ')}`);
  return found;
}

/** Find a trial-balance / general-ledger row by account number. */
export function rowFor(result, number) {
  return result.rows.find((r) => r.account.number === number);
}
