/**
 * G22 leg 2 (D129), the N4 half of the engine: the four A38 probes and the six A38/A20 validations
 * that answered `needs_a38` until this landing, each driven through the REAL verbs (accrual_create /
 * post / reverse, provision_create / post / release, vat_mark_filed, vat_settlement_post, post_entry,
 * create_bank_account) and read back through `evaluateProbe` / `evaluateValidation`, plus the five
 * A38 reads registered in `VERB_EVIDENCE`.
 *
 * The bank statement row is inserted directly: the A20 importer needs a camt file whose dates are
 * the fixture's, and the validation under test READS the table `bank_statement` the importer writes
 * (`closing_balance_minor`, `to_date`, `last_page_ind`), so the read is what is proven here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const { ledgerPorts } = await import('../../dist/core/ledger/index.js');
const chk = await import('../../dist/core/checklists/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const { evaluateProbe, evaluateValidation, VERB_EVIDENCE, verbEvidenceOf, readMemoOf, TEST_KINDS_TEMPLATE } = chk;

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

let seq = 0;
const key = (tag) => `a38p-${tag}-${(seq += 1)}`;

const FY = { label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' };
const Q1 = { label: '2026-Q1', periodStart: '2026-01-01', periodEnd: '2026-03-31' };

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Nomadik GmbH', `${seed}-ws`);
  deps.store.db.prepare('UPDATE workspace SET legal_form = ? WHERE id = ?').run('gmbh', workspaceId);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const ctx = makeContext(deps.store, { workspaceId, actor: 'studio', clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }) });
  return { deps, wid: workspaceId, accId, call, ctx };
}

function effektiv(w) {
  must(w.call('vat_seed_defaults', {}), 'seed');
  must(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
}

/** One taxable sale and one deductible purchase inside a quarter (the A38 settlement fixture's shape). */
function quarterActivity(w, { saleNet, purchaseNet, saleDate, purchaseDate }) {
  must(
    w.call('post_entry', {
      date: saleDate,
      source: 'manual',
      description: 'Beratung',
      idempotencyKey: key('sale'),
      lines: [
        { account: w.accId('1100'), debit: Math.round(saleNet * 1.081) },
        { account: w.accId('3200'), credit: saleNet, taxCode: 'UST81' },
        { account: w.accId('2200'), credit: Math.round(saleNet * 0.081) },
      ],
    }),
    'sale',
  );
  must(
    w.call('post_entry', {
      date: purchaseDate,
      source: 'manual',
      description: 'Material',
      idempotencyKey: key('purchase'),
      lines: [
        { account: w.accId('4000'), debit: purchaseNet, taxCode: 'VST-M' },
        { account: w.accId('1170'), debit: Math.round(purchaseNet * 0.081) },
        { account: w.accId('2000'), credit: Math.round(purchaseNet * 1.081) },
      ],
    }),
    'purchase',
  );
}

const QUARTERS = [
  { label: '2026-Q1', saleNet: 4_000_000, purchaseNet: 1_000_000, saleDate: '2026-02-10', purchaseDate: '2026-03-05' },
  { label: '2026-Q2', saleNet: 5_000_000, purchaseNet: 2_000_000, saleDate: '2026-05-15', purchaseDate: '2026-05-20' },
  { label: '2026-Q3', saleNet: 3_000_000, purchaseNet: 500_000, saleDate: '2026-08-12', purchaseDate: '2026-09-03' },
  { label: '2026-Q4', saleNet: 6_000_000, purchaseNet: 1_500_000, saleDate: '2026-11-11', purchaseDate: '2026-12-02' },
];

function yearOfActivity(w) {
  for (const q of QUARTERS) quarterActivity(w, q);
}

const ACCRUAL = { kind: 'accrued_expense', periodEnd: '2026-12-31', amountMinor: 180_000, contraAccount: '6500', description: 'Strom Dezember, Rechnung im Januar' };
const PROVISION = { reason: 'garantie', periodEnd: '2026-12-31', amountMinor: 500_000, provisionAccount: '2330', expenseAccount: '6800', description: 'Garantiefälle Geschäftsjahr 2026' };

// --- VERB_EVIDENCE ------------------------------------------------------------------------------

test('the five A38 reads are registered preview evidence and bind a canonical hash', () => {
  const w = world('evidence');
  effektiv(w);
  for (const verb of ['accrual_list', 'provision_list', 'vat_settlement_preview', 'tax_provision_preview', 'vat_annual_reconciliation']) {
    assert.equal(typeof VERB_EVIDENCE[verb], 'function', `${verb} registered`);
  }
  const memo = readMemoOf(w.ctx, TEST_KINDS_TEMPLATE, FY);
  const drafts = verbEvidenceOf(w.ctx, 'accrual_list', FY, memo);
  assert.equal(drafts.ok, true);
  assert.match(drafts.ref, /^accrual_list:[0-9a-f]{64}$/);
  assert.deepEqual(drafts.payload.accruals, []);
  must(w.call('accrual_create', { ...ACCRUAL, idempotencyKey: key('d') }), 'draft');
  const after = verbEvidenceOf(w.ctx, 'accrual_list', FY, memo);
  assert.notEqual(after.hash, drafts.hash, 'a new draft moves the preview hash');
  const settlement = verbEvidenceOf(w.ctx, 'vat_settlement_preview', Q1, memo);
  assert.equal(settlement.ok, true);
  assert.equal(settlement.payload.period, '2026-Q1');
  const tax = verbEvidenceOf(w.ctx, 'tax_provision_preview', FY, memo);
  assert.equal(tax.ok, true);
  assert.equal(tax.payload.periodEnd, '2026-12-31');
  const recon = verbEvidenceOf(w.ctx, 'vat_annual_reconciliation', FY, memo);
  assert.equal(recon.ok, true);
  assert.equal(recon.payload.year, '2026');
});

// --- The probes -----------------------------------------------------------------------------------

test('accruals_posted: a draft holds the row, the posted pair flips it with its entry ids and the reversal date, the Storno pair un-flips it', () => {
  const w = world('accruals');
  assert.deepEqual(evaluateProbe(w.ctx, 'accruals_posted', FY).found, false, 'nothing on file');
  const draft = must(w.call('accrual_create', { ...ACCRUAL, idempotencyKey: key('d') }), 'draft');
  const held = evaluateProbe(w.ctx, 'accruals_posted', FY);
  assert.equal(held.found, false);
  assert.deepEqual(held.detail.draftIds, [draft.accrual.id]);
  const posted = must(w.call('accrual_post', { accrualId: draft.accrual.id, idempotencyKey: key('p') }), 'post');
  const live = evaluateProbe(w.ctx, 'accruals_posted', FY);
  assert.equal(live.found, true);
  assert.deepEqual(live.entryIds, [posted.entryId, posted.reversalEntryId]);
  assert.equal(live.reversalDate, '2027-01-01');
  // A second draft re-holds the row: "no draft left" is half of the condition.
  const second = must(w.call('accrual_create', { ...ACCRUAL, amountMinor: 1_000, idempotencyKey: key('d2') }), 'draft 2');
  assert.equal(evaluateProbe(w.ctx, 'accruals_posted', FY).found, false);
  must(w.call('accrual_discard', { accrualId: second.accrual.id, idempotencyKey: key('x') }), 'discard');
  assert.equal(evaluateProbe(w.ctx, 'accruals_posted', FY).found, true);
  must(w.call('accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: key('r') }), 'reverse');
  const gone = evaluateProbe(w.ctx, 'accruals_posted', FY);
  assert.equal(gone.found, false);
  assert.deepEqual(gone.detail.reversedIds, [draft.accrual.id]);
});

test('provisions_posted and tax_provision_posted are disjoint: garantie feeds the first, steuern the second, a release dated the period end counts', () => {
  const w = world('provisions');
  assert.equal(evaluateProbe(w.ctx, 'provisions_posted', FY).found, false);
  assert.equal(evaluateProbe(w.ctx, 'tax_provision_posted', FY).found, false);
  const tax = must(w.call('provision_create', { ...PROVISION, reason: 'steuern', expenseAccount: '8900', description: 'Steuerrückstellung 2026', amountMinor: 300_000, idempotencyKey: key('t') }), 'tax draft');
  must(w.call('provision_post', { provisionId: tax.provision.id, idempotencyKey: key('tp') }), 'tax post');
  assert.equal(evaluateProbe(w.ctx, 'tax_provision_posted', FY).found, true, 'the tax row sees the steuern provision');
  assert.equal(evaluateProbe(w.ctx, 'provisions_posted', FY).found, false, 'the general row does not count the steuern provision');
  const draft = must(w.call('provision_create', { ...PROVISION, idempotencyKey: key('g') }), 'garantie draft');
  assert.equal(evaluateProbe(w.ctx, 'provisions_posted', FY).found, false, 'a draft holds the row');
  const posted = must(w.call('provision_post', { provisionId: draft.provision.id, idempotencyKey: key('gp') }), 'garantie post');
  const live = evaluateProbe(w.ctx, 'provisions_posted', FY);
  assert.equal(live.found, true);
  assert.deepEqual(live.entryIds, [posted.entryId]);
  // A release dated the period end is the period's act as well (row 10b: gebucht oder aufgelöst).
  const w2 = world('release');
  const earlier = must(w2.call('provision_create', { ...PROVISION, periodEnd: '2025-12-31', description: 'Garantiefälle Geschäftsjahr 2025', idempotencyKey: key('e') }), 'earlier draft');
  must(w2.call('provision_post', { provisionId: earlier.provision.id, idempotencyKey: key('ep') }), 'earlier post');
  assert.equal(evaluateProbe(w2.ctx, 'provisions_posted', FY).found, false, 'formed last year, nothing this year');
  const released = must(w2.call('provision_release', { provisionId: earlier.provision.id, date: '2026-12-31', amountMinor: 200_000, targetAccount: '6800', idempotencyKey: key('rel') }), 'release');
  const viaRelease = evaluateProbe(w2.ctx, 'provisions_posted', FY);
  assert.equal(viaRelease.found, true);
  assert.deepEqual(viaRelease.entryIds, [released.entryId]);
  must(w2.call('provision_release_reverse', { releaseId: released.releaseId, idempotencyKey: key('rr') }), 'release reverse');
  assert.equal(evaluateProbe(w2.ctx, 'provisions_posted', FY).found, false, 'a reversed release no longer counts');
});

test('vat_settlement_posted: one period on a MWST-Periode run, the per-period table on a year run', () => {
  const w = world('settle');
  const bare = evaluateProbe(w.ctx, 'vat_settlement_posted', FY);
  assert.equal(bare.found, null, 'no A05 configuration');
  assert.equal(bare.reason, 'needs_vat_config');
  effektiv(w);
  yearOfActivity(w);
  const nothing = evaluateProbe(w.ctx, 'vat_settlement_posted', FY);
  assert.equal(nothing.found, false);
  assert.equal(nothing.detail.periods.length, 4);
  assert.deepEqual(nothing.detail.unfiled, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  for (const q of QUARTERS) must(w.call('vat_mark_filed', { period: q.label, idempotencyKey: key('file') }), `file ${q.label}`);
  const filed = evaluateProbe(w.ctx, 'vat_settlement_posted', FY);
  assert.equal(filed.found, false);
  assert.deepEqual(filed.detail.unsettledFiled, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.equal(evaluateProbe(w.ctx, 'vat_settlement_posted', Q1).found, false);
  const q1 = must(w.call('vat_settlement_post', { period: '2026-Q1', idempotencyKey: key('s') }), 'settle Q1');
  const one = evaluateProbe(w.ctx, 'vat_settlement_posted', Q1);
  assert.equal(one.found, true);
  assert.deepEqual(one.entryIds, [q1.entryId]);
  assert.equal(one.detail.settlementId, q1.settlementId);
  const partial = evaluateProbe(w.ctx, 'vat_settlement_posted', FY);
  assert.equal(partial.found, false);
  assert.deepEqual(partial.detail.unsettledFiled, ['2026-Q2', '2026-Q3', '2026-Q4']);
  assert.equal(partial.detail.periods[0].settled, true);
  assert.equal(partial.detail.periods[0].netMinor, q1.netMinor);
  for (const label of ['2026-Q2', '2026-Q3', '2026-Q4']) must(w.call('vat_settlement_post', { period: label, idempotencyKey: key('s') }), `settle ${label}`);
  const all = evaluateProbe(w.ctx, 'vat_settlement_posted', FY);
  assert.equal(all.found, true);
  assert.equal(all.entryIds.length, 4);
  must(w.call('vat_settlement_reverse', { settlementId: q1.settlementId, idempotencyKey: key('rv') }), 'reverse Q1');
  assert.equal(evaluateProbe(w.ctx, 'vat_settlement_posted', FY).found, false, 'a reversed settlement re-opens the year row');
  assert.equal(evaluateProbe(w.ctx, 'vat_settlement_posted', Q1).found, false);
});

// --- The validations -------------------------------------------------------------------------------

test('accruals_reversed: a hand-typed Abgrenzung without its reversal fails, an A38 pair passes by construction', () => {
  const w = world('reversed');
  assert.equal(evaluateValidation(w.ctx, 'accruals_reversed', FY).result, 'pass', 'nothing on 1300 or 2300');
  const draft = must(w.call('accrual_create', { ...ACCRUAL, idempotencyKey: key('d') }), 'draft');
  must(w.call('accrual_post', { accrualId: draft.accrual.id, idempotencyKey: key('p') }), 'post');
  const pair = evaluateValidation(w.ctx, 'accruals_reversed', FY);
  assert.equal(pair.result, 'pass');
  assert.equal(pair.figures.account2300Minor, 0);
  must(
    w.call('post_entry', {
      date: '2026-12-31',
      source: 'manual',
      description: 'Abgrenzung von Hand',
      idempotencyKey: key('hand'),
      lines: [{ account: w.accId('1300'), debit: 50_000 }, { account: w.accId('3200'), credit: 50_000 }],
    }),
    'hand-typed',
  );
  const stuck = evaluateValidation(w.ctx, 'accruals_reversed', FY);
  assert.equal(stuck.result, 'fail');
  assert.equal(stuck.figures.account1300Minor, 50_000);
  assert.equal(stuck.figures.asOf, '2027-01-01');
});

test('vat_accounts_zero, vat_declared_equals_books and umsatzabstimmung over a filed and settled year', () => {
  const w = world('vatzero');
  effektiv(w);
  yearOfActivity(w);
  const open = evaluateValidation(w.ctx, 'vat_accounts_zero', FY);
  assert.equal(open.result, 'fail');
  assert.deepEqual(open.figures.nonZero, ['1170', '2200']);
  assert.equal(open.figures.lastSettlement, null);
  const unfiled = evaluateValidation(w.ctx, 'vat_declared_equals_books', FY);
  assert.equal(unfiled.result, 'unavailable');
  assert.equal(unfiled.reason, 'unfiled_periods');
  assert.equal(evaluateValidation(w.ctx, 'umsatzabstimmung', FY).reason, 'unfiled_periods');
  for (const q of QUARTERS) must(w.call('vat_mark_filed', { period: q.label, idempotencyKey: key('file') }), `file ${q.label}`);
  const declared = evaluateValidation(w.ctx, 'vat_declared_equals_books', FY);
  assert.equal(declared.result, 'pass', JSON.stringify(declared.figures));
  assert.equal(declared.figures.output.differenceMinor, 0);
  assert.equal(declared.figures.input.differenceMinor, 0);
  assert.equal(declared.figures.output.bookedMinor, QUARTERS.reduce((s, q) => s + Math.round(q.saleNet * 0.081), 0));
  const umsatz = evaluateValidation(w.ctx, 'umsatzabstimmung', FY);
  assert.equal(umsatz.result, 'pass', JSON.stringify(umsatz.figures));
  assert.equal(umsatz.figures.declaredZiffer200Minor, QUARTERS.reduce((s, q) => s + q.saleNet, 0));
  for (const q of QUARTERS) must(w.call('vat_settlement_post', { period: q.label, idempotencyKey: key('s') }), `settle ${q.label}`);
  const settled = evaluateValidation(w.ctx, 'vat_accounts_zero', FY);
  assert.equal(settled.result, 'pass', JSON.stringify(settled.figures));
  assert.deepEqual(settled.figures.nonZero, []);
  assert.equal(settled.figures.lastSettlement.period, '2026-Q4');
  assert.equal(evaluateValidation(w.ctx, 'vat_declared_equals_books', FY).result, 'pass', 'the settlement transfers are excluded from the booked side');

  // Revenue outside the returns, posted BEFORE the periods are filed (a filed period is hard-locked):
  // the Umsatzabstimmung warns with the difference and its hash moves, declared-equals-books does not.
  const w2 = world('umsatz-off');
  effektiv(w2);
  yearOfActivity(w2);
  must(
    w2.call('post_entry', {
      date: '2026-12-30',
      source: 'manual',
      description: 'Ertrag ohne MWST-Code',
      idempotencyKey: key('untaxed'),
      lines: [{ account: w2.accId('1100'), debit: 100_000 }, { account: w2.accId('3200'), credit: 100_000 }],
    }),
    'untaxed revenue',
  );
  for (const q of QUARTERS) must(w2.call('vat_mark_filed', { period: q.label, idempotencyKey: key('file2') }), `file ${q.label}`);
  const off = evaluateValidation(w2.ctx, 'umsatzabstimmung', FY);
  assert.equal(off.result, 'fail');
  assert.equal(off.figures.differenceMinor, 100_000);
  assert.notEqual(off.hash, umsatz.hash, 'the acknowledgement hash moves with the figures');
  assert.equal(evaluateValidation(w2.ctx, 'vat_declared_equals_books', FY).result, 'pass');
});

test('tax_provision_plausible: unavailable without a provision, passes on the helper figure, fails outside the band', () => {
  const w = world('tax');
  effektiv(w);
  yearOfActivity(w);
  const none = evaluateValidation(w.ctx, 'tax_provision_plausible', FY);
  assert.equal(none.result, 'unavailable');
  assert.equal(none.reason, 'no_tax_provision');
  const preview = must(w.call('tax_provision_preview', { periodEnd: '2026-12-31' }), 'preview');
  assert.ok(preview.proposedMinor > 0, 'the fixture year carries a profit');
  const draft = must(w.call('provision_create', { ...preview.proposedDraft, idempotencyKey: key('t') }), 'draft from the helper');
  must(w.call('provision_post', { provisionId: draft.provision.id, idempotencyKey: key('tp') }), 'post');
  const after = must(w.call('tax_provision_preview', { periodEnd: '2026-12-31' }), 'preview after');
  assert.equal(after.proposedMinor, 0, 'the helper now counts the posted provision as an instalment (the edge the validation corrects for)');
  const plausible = evaluateValidation(w.ctx, 'tax_provision_plausible', FY);
  assert.equal(plausible.result, 'pass', JSON.stringify(plausible.figures));
  assert.equal(plausible.figures.expectedMinor, preview.proposedMinor);
  assert.equal(plausible.figures.differenceMinor, 0);
  const w2 = world('tax-off');
  effektiv(w2);
  yearOfActivity(w2);
  const p2 = must(w2.call('tax_provision_preview', { periodEnd: '2026-12-31' }), 'preview 2');
  const big = must(w2.call('provision_create', { ...p2.proposedDraft, amountMinor: p2.proposedMinor * 3, idempotencyKey: key('b') }), 'oversized');
  must(w2.call('provision_post', { provisionId: big.provision.id, idempotencyKey: key('bp') }), 'post');
  const off = evaluateValidation(w2.ctx, 'tax_provision_plausible', FY);
  assert.equal(off.result, 'fail');
  assert.equal(off.figures.postedMinor, p2.proposedMinor * 3);
  assert.equal(off.figures.expectedMinor, p2.proposedMinor);
});

test('bank_balance_matches: the A20 statement covering the period end wins and the row names it; none on file and nothing typed is unavailable, never a pass', () => {
  const w = world('bank');
  const nothing = evaluateValidation(w.ctx, 'bank_balance_matches', FY);
  assert.equal(nothing.result, 'unavailable');
  assert.equal(nothing.reason, 'no_statement_no_typed_balance');
  assert.equal(nothing.figures.source, 'none');
  assert.equal(nothing.figures.typedItemId, 'bank_balance_typed');
  must(
    w.call('post_entry', {
      date: '2026-06-01',
      source: 'manual',
      description: 'Einzahlung',
      idempotencyKey: key('in'),
      lines: [{ account: w.accId('1020'), debit: 1_234_560 }, { account: w.accId('2800'), credit: 1_234_560 }],
    }),
    'deposit',
  );
  const account = must(
    w.call('create_bank_account', { name: 'ZKB Geschäft', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: w.accId('1020'), idempotencyKey: key('ba') }),
    'bank account',
  );
  const bankAccountId = account.bankAccount?.id ?? account.id ?? account.bankAccountId;
  assert.ok(bankAccountId, `bank account id in ${JSON.stringify(account)}`);
  const insert = w.deps.store.db.prepare(
    `INSERT INTO bank_statement (id, workspace_id, bank_account_id, message_type, statement_id, page_number, last_page_ind, content_hash, from_date, to_date, opening_balance_minor, closing_balance_minor, balance_currency, txn_count, imported_by, imported_at)
     VALUES (?, ?, ?, 'camt.053', ?, 1, 1, '', ?, ?, ?, ?, 'CHF', 0, 'studio', ?)`,
  );
  // A statement that ends before the year end does not cover it: still unavailable.
  insert.run('stmt-nov', w.wid, bankAccountId, 'ZKB-2026-11', '2026-11-01', '2026-11-30', 0, 1_234_560, '2026-12-01T00:00:00.000Z');
  assert.equal(evaluateValidation(w.ctx, 'bank_balance_matches', FY).result, 'unavailable');
  insert.run('stmt-dec', w.wid, bankAccountId, 'ZKB-2026-12', '2026-12-01', '2026-12-31', 1_234_560, 1_234_560, '2027-01-02T00:00:00.000Z');
  const matched = evaluateValidation(w.ctx, 'bank_balance_matches', FY);
  assert.equal(matched.result, 'pass', JSON.stringify(matched.figures));
  assert.equal(matched.figures.source, 'statement');
  assert.equal(matched.figures.accounts[0].statementId, 'stmt-dec');
  assert.equal(matched.figures.accounts[0].ledgerAccount, '1020');
  assert.equal(matched.figures.accounts[0].differenceMinor, 0);
  must(
    w.call('post_entry', {
      date: '2026-12-31',
      source: 'manual',
      description: 'Spesen',
      idempotencyKey: key('out'),
      lines: [{ account: w.accId('6500'), debit: 10_000 }, { account: w.accId('1020'), credit: 10_000 }],
    }),
    'withdrawal',
  );
  const off = evaluateValidation(w.ctx, 'bank_balance_matches', FY);
  assert.equal(off.result, 'fail');
  assert.deepEqual(off.figures.mismatched, ['ZKB Geschäft']);
  assert.equal(off.figures.accounts[0].differenceMinor, 10_000);
});
