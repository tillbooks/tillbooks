// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, saveDraft, deleteDraft, getEntry } from '../../dist/core/ledger/index.js';
import { setup, withVat } from './support.mjs';
import { countOf, errOf, id, obj, okOf } from '../support/narrow.mjs';

/** The `entry` `getEntry` reports, proved to be a success payload carrying an entry object. */
const entryOf = (ctx, entryId) => obj(okOf(getEntry(ctx, { entryId }), 'getEntry').entry, 'getEntry.entry');

const twoLines = (accounts, amt = 5000) => [
  { account: accounts['6500'], debit: amt },
  { account: accounts['1000'], credit: amt },
];

test('saveDraft stores an unbalanced idea without posting it', () => {
  const { ctx, store, accounts } = setup();
  const res = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'half an idea',
    idempotencyKey: 'd1',
    lines: [{ account: accounts['6500'], debit: 5000 }],
  });
  assert.equal(res.ok, true);
  assert.equal(entryOf(ctx, id(res, 'entryId', 'saveDraft')).status, 'draft');
  assert.equal(countOf(store.db, "SELECT COUNT(*) AS c FROM journal_entry WHERE status='posted'"), 0);
});

test('posting a saved draft promotes it in place (same id), not a duplicate', () => {
  const { ctx, store, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'idea',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  const posted = postEntry(ctx, {
    entryId: id(draft, 'entryId', 'saveDraft'),
    date: '2026-03-01',
    description: 'idea',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  assert.equal(posted.ok, true);
  assert.equal(id(posted, 'entryId', 'postEntry'), id(draft, 'entryId', 'saveDraft'));
  assert.equal(entryOf(ctx, id(draft, 'entryId', 'saveDraft')).status, 'posted');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 1);
});

test('deleteDraft hard-deletes a draft and its lines', () => {
  const { ctx, store, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'x',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  assert.equal(deleteDraft(ctx, { entryId: id(draft, 'entryId', 'saveDraft'), idempotencyKey: 'del1' }).ok, true);
  assert.equal(errOf(getEntry(ctx, { entryId: id(draft, 'entryId', 'saveDraft') }), 'getEntry').error, 'not_found');
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_line'), 0);
});

test('a retried delete of an already-deleted draft returns ok, not not_found', () => {
  const { ctx, accounts } = setup();
  const draft = saveDraft(ctx, {
    date: '2026-03-01',
    description: 'x',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  const first = deleteDraft(ctx, { entryId: id(draft, 'entryId', 'saveDraft'), idempotencyKey: 'del1' });
  const second = deleteDraft(ctx, { entryId: id(draft, 'entryId', 'saveDraft'), idempotencyKey: 'del1' });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
});

test('saveDraft cannot target a posted row (draft mutation is fenced)', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  const res = saveDraft(ctx, {
    entryId: id(posted, 'entryId', 'postEntry'),
    date: '2026-03-01',
    description: 'sneaky',
    idempotencyKey: 'd1',
    lines: twoLines(accounts),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_a_draft');
});

test('deleteDraft cannot delete a posted row', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  const res = deleteDraft(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'del1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_a_draft');
});

test('posting an already-posted entryId is rejected (promotion is one-way)', () => {
  const { ctx, accounts } = setup();
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p1',
    lines: twoLines(accounts),
  });
  const again = postEntry(ctx, {
    entryId: id(posted, 'entryId', 'postEntry'),
    date: '2026-03-01',
    description: 'p',
    source: 'manual',
    idempotencyKey: 'p2',
    lines: twoLines(accounts),
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_posted');
});

// C10: the Leistungsdatum survives save_draft. Before this, draft.ts wrote no supply_date column, so a
// straddle draft (a 2023 supply booked in 2024) came back at the entry date and repriced at 8.1%.

/**
 * A taxed draft: 6500 at V81, its Vorsteuer, and the cash leg, the taxed line dated `supplyDate`.
 *
 * @param {ReturnType<typeof setup>['accounts']} accounts
 * @param {ReturnType<typeof withVat>} vat
 * @param {unknown} supplyDate
 */
const taxedDraftLines = (accounts, vat, supplyDate) => [
  {
    account: accounts['6500'],
    debit: 10000,
    taxCode: vat.code,
    taxBase: 10000,
    taxAmount: 810,
    ...(supplyDate === undefined ? {} : { supplyDate: /** @type {string} */ (supplyDate) }),
  },
  { account: vat.vorsteuer, debit: 810 },
  { account: accounts['1000'], credit: 10810 },
];

/**
 * Each stored line's (account, supply_date), in insertion order.
 *
 * @param {ReturnType<typeof setup>['store']} store
 * @param {string} entryId
 * @returns {{ account: string, supplyDate: string | null }[]}
 */
const supplyDates = (store, entryId) =>
  /** @type {{ account: string, supplyDate: string | null }[]} */ (
    store.db
      .prepare('SELECT account_id AS account, supply_date AS supplyDate FROM journal_line WHERE entry_id = ? ORDER BY rowid')
      .all(entryId)
  );

test("C10: saveDraft keeps a taxed line's supplyDate and get_entry reads it back; an absent or untagged one stays NULL", () => {
  const { ctx, store, accounts } = setup();
  const vat = withVat(store);
  // A supply date on an UNTAGGED line describes nothing: postEntry stores NULL there, and so does a draft.
  const lines = taxedDraftLines(accounts, vat, '2023-12-15').map((l, i) => (i === 2 ? { ...l, supplyDate: '2023-12-15' } : l));
  const draftId = id(saveDraft(ctx, { date: '2024-01-10', idempotencyKey: 'c10-a', lines }), 'entryId', 'saveDraft');
  assert.deepEqual(supplyDates(store, draftId), [
    { account: accounts['6500'], supplyDate: '2023-12-15' },
    { account: vat.vorsteuer, supplyDate: null },
    { account: accounts['1000'], supplyDate: null },
  ]);
  const read = okOf(getEntry(ctx, { entryId: draftId }), 'getEntry').lines;
  assert.deepEqual(
    read.map((l) => l.supplyDate),
    ['2023-12-15', null, null],
  );

  // Absent stays NULL, exactly as before.
  const plainId = id(
    saveDraft(ctx, { date: '2024-01-10', idempotencyKey: 'c10-b', lines: taxedDraftLines(accounts, vat, undefined) }),
    'entryId',
    'saveDraft',
  );
  assert.deepEqual(
    supplyDates(store, plainId).map((r) => r.supplyDate),
    [null, null, null],
  );
});

test("C10: saveDraft refuses a malformed supplyDate with postEntry's own refusal, and writes nothing", () => {
  const { ctx, store, accounts } = setup();
  const vat = withVat(store);
  for (const bad of ['15.12.2023', '2023-13-01', '2023-02-30', '', 20231215]) {
    const lines = taxedDraftLines(accounts, vat, bad);
    const drafted = errOf(saveDraft(ctx, { date: '2024-01-10', idempotencyKey: `bad-${String(bad)}`, lines }), 'saveDraft');
    const posted = errOf(
      postEntry(ctx, { date: '2024-01-10', source: 'manual', idempotencyKey: `bad-post-${String(bad)}`, lines }),
      'postEntry',
    );
    assert.equal(drafted.error, 'invalid_line', JSON.stringify(bad));
    assert.deepEqual(drafted, posted, `one validator, one refusal: ${JSON.stringify(bad)}`);
  }
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 0);
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_line'), 0);
});

test('C10: saveDraft stays idempotent on its key with a supplyDate; a re-save under a new key replaces it', () => {
  const { ctx, store, accounts } = setup();
  const vat = withVat(store);
  const first = saveDraft(ctx, { date: '2024-01-10', idempotencyKey: 'c10-k', lines: taxedDraftLines(accounts, vat, '2023-12-15') });
  const draftId = id(first, 'entryId', 'saveDraft');
  // A retry under the SAME key replays the first result and writes nothing, even with another date.
  const retry = saveDraft(ctx, { date: '2024-01-10', idempotencyKey: 'c10-k', lines: taxedDraftLines(accounts, vat, '2023-11-01') });
  assert.deepEqual(retry, first);
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), 1);
  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_line'), 3);
  assert.deepEqual(
    supplyDates(store, draftId).map((r) => r.supplyDate),
    ['2023-12-15', null, null],
  );
  // An edit (the draft's id, a new key) replaces the lines, Leistungsdatum included.
  const edited = saveDraft(ctx, {
    entryId: draftId,
    date: '2024-01-10',
    idempotencyKey: 'c10-k2',
    lines: taxedDraftLines(accounts, vat, undefined),
  });
  assert.equal(id(edited, 'entryId', 'saveDraft'), draftId);
  assert.deepEqual(
    supplyDates(store, draftId).map((r) => r.supplyDate),
    [null, null, null],
  );
});

test("saveDraft stores a no-VAT line ('none', or a code of kind 'none') exactly as postEntry does: no code, no trace, no supply date", () => {
  const { ctx, store, accounts } = setup();
  withVat(store);
  store.db
    .prepare('INSERT INTO tax_code (id, workspace_id, code, kind, rate_bp, esa_form_line, label, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run('tax_ohne', 'ws_1', 'OHNE', 'none', 0, null, 'Ohne MWST');
  for (const code of ['none', 'OHNE']) {
    const lines = [
      { account: accounts['6500'], debit: 100, taxCode: code, supplyDate: '2023-12-20' },
      { account: accounts['1000'], credit: 100 },
    ];
    const draftId = id(saveDraft(ctx, { date: '2026-03-02', idempotencyKey: `none-d-${code}`, lines }), 'entryId', 'saveDraft');
    const postedId = id(postEntry(ctx, { date: '2026-03-02', source: 'manual', idempotencyKey: `none-p-${code}`, lines }), 'entryId', 'postEntry');
    /** @param {string} entryId */
    const rowOf = (entryId) =>
      store.db
        .prepare('SELECT tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? AND debit_minor > 0')
        .get(entryId);
    assert.deepEqual(rowOf(draftId), { tax_code: null, tax_base_minor: null, tax_amount_minor: null, supply_date: null }, code);
    assert.deepEqual(rowOf(draftId), rowOf(postedId), `${code}: the draft row is the posted row`);
  }
});
