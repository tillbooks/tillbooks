// D185, the settlement socket: `import_settlement` through the owner's template.
//
// SYNTHETIC DATA ONLY (see support.mjs): an invented platform, processor, people, ids and amounts.
//
// The money-path INVARIANTS are marked [INVARIANT ...] for the non-author critic (CLAUDE.md: the
// append-only, idempotent-on-ROWS and §H-TENANT assertions are confirmed by a non-author). Each says
// in its comment which code it guards, so a mutation of that code fails it.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importSettlement, setSettlementTemplate, getSettlementTemplate, readSettlementDocument, parseExactMinor } from '../../dist/core/settlement/index.js';
import { computeVatReturn } from '../../dist/core/vat/abrechnung.js';
import { lockPeriod } from '../../dist/core/ledger/periods.js';
import { reverseEntry } from '../../dist/core/ledger/reverseEntry.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { listBankInbox, bookBankLine, setBankStandard } from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { importLines, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { lockHolder } from '../support/lock-holder.mjs';
import { settlementWorld, setTemplate, julyFile, rows, legsOf, balanceOf, must, refused, SYSTEM, PROCESSOR, TINY_PDF_BASE64, templateKinds } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const minor = (x) => parseExactMinor(x);
const byId = (res, id) => res.events.find((e) => e.id === id);

/** The file's own VAT sums, from the fixture, never from the engine. */
function fileVat(doc) {
  let output = 0;
  let input = 0;
  let outputBase = 0;
  for (const e of doc.events) {
    if (e.vat === null) continue;
    if (e.kind === 'sale' || e.kind === 'refund') {
      output += minor(e.vat.amount);
      outputBase += minor(e.net);
    } else {
      input -= minor(e.vat.amount);
    }
  }
  return { output, input, outputBase };
}

// ================================================================================================
// 1. The format: exact amounts, per-event refusals, a wrong schema refuses the file
// ================================================================================================

test('amounts are read exactly from their decimal spelling, never through a float', () => {
  assert.equal(parseExactMinor(10.81), 1081);
  assert.equal(parseExactMinor(0.29), 29, '0.29 * 100 is 28.999999999999996 as a float');
  assert.equal(parseExactMinor(1.005 + 0), null, 'three places refuse');
  assert.equal(parseExactMinor('-54.05'), -5405);
  assert.equal(parseExactMinor('10.8'), 1080);
  assert.equal(parseExactMinor(-0), 0);
  assert.equal(parseExactMinor(1e-7), null, 'an exponent spelling refuses');
  assert.equal(parseExactMinor('1e3'), null);
  assert.equal(parseExactMinor('+5.00'), null);
  assert.equal(parseExactMinor(' 5.00'), null);
  assert.equal(parseExactMinor(10.815), null);
  assert.equal(parseExactMinor(Number.NaN), null);
  assert.equal(parseExactMinor(null), null);
});

test('a malformed event refuses on its own, with a code and a sentence; unknown fields are ignored', () => {
  const doc = {
    schema: 'till-settlement/v1',
    source: { system: 'X', processor: 'Y', extra: 'ignored' },
    unknownTopLevel: { anything: true },
    events: [
      { id: 'ok-1', kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 10.81, net: 10, vat: { amount: 0.81 }, futureField: 1 },
      { kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 1, net: 1, vat: null },
      { id: 'dup', kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 1, net: 1, vat: null },
      { id: 'dup', kind: 'sale', day: '2026-07-02', currency: 'CHF', amount: 2, net: 2, vat: null },
      { id: 'bad-day', kind: 'sale', day: '2026-02-30', currency: 'CHF', amount: 1, net: 1, vat: null },
      { id: 'eur', kind: 'sale', day: '2026-07-01', currency: 'EUR', amount: 1, net: 1, vat: null },
      { id: 'kind', kind: 'chargeback', day: '2026-07-01', currency: 'CHF', amount: 1, net: 1, vat: null },
      { id: 'places', kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 1.005, net: 1.005, vat: null },
      { id: 'sum', kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 10.82, net: 10, vat: { amount: 0.81 } },
      'not an object',
    ],
  };
  const read = readSettlementDocument(doc, 'CHF');
  assert.equal(read.ok, true);
  assert.deepEqual(read.document.events.map((e) => e.id), ['ok-1']);
  const codes = read.document.refused.map((r) => [r.index, r.id, r.code]);
  assert.deepEqual(codes, [
    [1, null, 'missing_id'],
    [2, 'dup', 'duplicate_id'],
    [3, 'dup', 'duplicate_id'],
    [4, 'bad-day', 'invalid_day'],
    [5, 'eur', 'currency_mismatch'],
    [6, 'kind', 'unknown_kind'],
    [7, 'places', 'invalid_amount'],
    [8, 'sum', 'amount_mismatch'],
    [9, null, 'invalid_event'],
  ]);
  for (const r of read.document.refused) assert.ok(typeof r.reason === 'string' && r.reason.length > 10, `${r.code} carries a sentence`);
  assert.equal(read.document.system, 'x', 'source names are matched trimmed and lower case');
});

test('a schema other than till-settlement/v1 refuses the whole file; so does a file without its source', () => {
  const t = settlementWorld();
  setTemplate(t);
  const before = rows(t.store, t.workspaceId);
  refused(importSettlement(t.ctx, { settlement: { ...julyFile(), schema: 'till-settlement/v2' }, idempotencyKey: 's1' }), 'unsupported_schema');
  refused(importSettlement(t.ctx, { settlement: { ...julyFile(), source: { system: 'Kurswerk' } }, idempotencyKey: 's2' }), 'invalid_settlement');
  refused(importSettlement(t.ctx, { content: 'not json', idempotencyKey: 's3' }), 'invalid_settlement');
  refused(importSettlement(t.ctx, { idempotencyKey: 's4' }), 'invalid_input');
  assert.deepEqual(rows(t.store, t.workspaceId), before, 'nothing written');
});

// ================================================================================================
// 2. The template: missing, incomplete, defaults, validity
// ================================================================================================

test('no template refuses settlement_template_missing; an unmapped kind refuses settlement_template_incomplete; nothing is written', () => {
  const t = settlementWorld();
  const before = rows(t.store, t.workspaceId);
  const missing = refused(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'm1' }), 'settlement_template_missing');
  assert.equal(missing.system, 'kurswerk');
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { sale: { action: 'book', accountId: t.acc('3400'), taxCode: 'UST81' } }, idempotencyKey: 'partial' }));
  const incomplete = refused(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'm2' }), 'settlement_template_incomplete');
  assert.deepEqual(incomplete.unmappedKinds, ['refund', 'processing_fee', 'service_fee', 'third_party_payout', 'third_party_payout_reversal']);
  const after = rows(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries, 'no entry');
  assert.equal(after.events, 0);
});

test('a template fills its defaults (payouts and reserve skip, other attention) and refuses a bad account or code', () => {
  const t = settlementWorld();
  const saved = must(setSettlementTemplate(t.ctx, { system: ' KURSWERK ', processor: 'zahlfix', clearingAccountId: t.acc('1095'), kinds: {}, idempotencyKey: 'd1' }));
  assert.equal(saved.changed, true);
  const kinds = saved.template.kinds;
  assert.deepEqual([kinds.bank_payout, kinds.bank_payout_summary, kinds.reserve, kinds.other, kinds.sale], [
    { action: 'skip' },
    { action: 'skip' },
    { action: 'skip' },
    { action: 'attention' },
    { action: 'unmapped' },
  ]);
  const again = must(setSettlementTemplate(t.ctx, { system: 'kurswerk', processor: 'ZAHLFIX', clearingAccountId: t.acc('1095'), kinds: {}, idempotencyKey: 'd2' }));
  assert.equal(again.changed, false, 'the same template in force: a no-op');
  assert.equal(again.templateId, saved.templateId, 'one template per source, matched case-insensitively');
  assert.equal(rows(t.store, t.workspaceId).templateChanges, 1, 'a no-op writes no history row');
  refused(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('3400'), kinds: {}, idempotencyKey: 'd3' }), 'invalid_account');
  refused(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { sale: { action: 'book', accountId: t.acc('1095'), taxCode: null } }, idempotencyKey: 'd4' }), 'invalid_account');
  refused(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { sale: { action: 'book', accountId: t.acc('3400'), taxCode: 'NOPE' } }, idempotencyKey: 'd5' }), 'unknown_tax_code');
  refused(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { chargeback: { action: 'skip' } }, idempotencyKey: 'd6' }), 'invalid_input');
  const read = must(getSettlementTemplate(t.ctx, {}));
  assert.equal(read.templates.length, 1);
  assert.equal(read.templates[0].template.clearingAccountNumber, '1095');
});

test('[INVARIANT tax kinds] a template refuses a Bezugsteuer or Einfuhrsteuer code (tax_code_unsupported): a settlement books VAT a supplier charged', () => {
  // Guards `BOOKABLE_TAX_KINDS` in template.ts (read by `checkTemplate` at save and at every import):
  // with `reverse_charge` or `import` in it, a stated VAT would be booked as Bezugsteuer or Einfuhrsteuer,
  // which the platform never charged.
  const t = settlementWorld();
  for (const [taxCode, kind] of [['BEZUG', 'reverse_charge'], ['IMPORT', 'import']]) {
    const row = t.store.db.prepare('SELECT kind, active FROM tax_code WHERE workspace_id = ? AND code = ? ORDER BY valid_from DESC LIMIT 1').get(t.workspaceId, taxCode);
    assert.deepEqual(row, { kind, active: 1 }, `premise: ${taxCode} is a live ${kind} code of the workspace`);
    const res = refused(
      setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { service_fee: { action: 'book', accountId: t.acc('6940'), taxCode } }, idempotencyKey: `tk-${taxCode}` }),
      'tax_code_unsupported',
    );
    assert.equal(res.field, 'kinds.service_fee.taxCode');
    assert.equal(res.kind, kind);
  }
  assert.equal(rows(t.store, t.workspaceId).templates, 0, 'no template saved');
});

// ================================================================================================
// 3. The worked file: one of every kind, exact VAT, every entry balances
// ================================================================================================

test('[INVARIANT balance] every booked event is ONE balanced entry: clearing = amount, contra = -net, VAT = -vat; the journal as a whole balances', () => {
  // Guards `linesFor` (the three legs and their sides) and A02's §H-LEDGER check behind it.
  const t = settlementWorld();
  setTemplate(t);
  const doc = julyFile();
  const res = must(importSettlement(t.ctx, { settlement: doc, idempotencyKey: 'j1' }));
  assert.equal(res.booked, 9, JSON.stringify(res.events.filter((e) => e.outcome !== 'booked')));
  assert.equal(res.skipped, 5, 'reserve, other and three payouts');
  assert.equal(res.refused, 0);
  assert.deepEqual(res.needsAttention, ['zf_oth_0001']);
  assert.deepEqual(res.warnings, doc.warnings, 'the file warnings pass through');

  for (const e of doc.events) {
    const outcome = byId(res, e.id);
    if (outcome.outcome !== 'booked') continue;
    const legs = legsOf(t.store, outcome.entryId);
    const debit = legs.reduce((s, l) => s + l.debit, 0);
    const credit = legs.reduce((s, l) => s + l.credit, 0);
    assert.equal(debit, credit, `${e.id}: the entry balances`);
    const signed = (number) => legs.filter((l) => l.number === number).reduce((s, l) => s + l.debit - l.credit, 0);
    assert.equal(signed('1095'), minor(e.amount), `${e.id}: the clearing account carries amount`);
    const vat = e.vat === null ? 0 : minor(e.vat.amount);
    const vatNumber = e.kind === 'sale' || e.kind === 'refund' ? '2200' : '1170';
    assert.equal(signed(vatNumber), 0 - vat, `${e.id}: the VAT account carries -vat`);
    const contra = legs.find((l) => l.taxCode !== null);
    assert.equal(contra.debit - contra.credit, 0 - minor(e.net), `${e.id}: the contra account carries -net`);
    assert.equal(Math.abs(contra.taxAmount), Math.abs(vat), `${e.id}: the trace carries the file's VAT`);
    const row = t.store.db.prepare('SELECT date, source, ref, description FROM journal_entry WHERE id = ?').get(outcome.entryId);
    assert.equal(row.date, e.day);
    assert.equal(row.source, 'import');
    assert.equal(row.ref, e.document?.number ?? null);
    if (e.counterparty !== undefined) assert.match(row.description, new RegExp(e.counterparty));
  }
  const whole = t.store.db
    .prepare('SELECT SUM(l.base_debit_minor) AS d, SUM(l.base_credit_minor) AS c FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?')
    .get(t.workspaceId);
  assert.equal(whole.d, whole.c, 'the journal as a whole balances');
  const kept = t.store.db.prepare('SELECT refs_json FROM settlement_event WHERE workspace_id = ? AND event_id = ?').get(t.workspaceId, 'kw:sale:1001');
  assert.deepEqual(JSON.parse(kept.refs_json), { zahlfixChargeId: 'zf_ch_0001' }, 'the external refs are kept with the event');
  assert.equal(res.totals.sale.booked, 2);
  assert.equal(res.totals.sale.amountMinor, 32430);
  assert.equal(res.totals.bank_payout.skipped, 2);
});

test('[INVARIANT vat] the MWST-Abrechnung shows the file\'s exact output and input VAT and the output base', () => {
  // Guards the hint hand-off in `linesFor` (taxAmount = the file's VAT) and `vatFits`: a stamp of the
  // engine's own arithmetic on another Rappen would move these totals off the file's sums.
  const t = settlementWorld();
  setTemplate(t);
  const doc = julyFile();
  must(importSettlement(t.ctx, { settlement: doc, idempotencyKey: 'v1' }));
  const vat = must(computeVatReturn(t.ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  const expected = fileVat(doc);
  assert.equal(expected.output, 2349);
  assert.equal(expected.input, 1409);
  assert.equal(vat.totalTaxDueMinor, expected.output, 'output VAT to the Rappen');
  assert.equal(vat.totalInputTaxMinor, expected.input, 'input VAT to the Rappen');
  const ziffer303 = vat.lines.find((l) => l.code === '303');
  assert.equal(ziffer303.baseMinor, expected.outputBase, 'the base of the sales, net of the refund');
  assert.equal(ziffer303.taxMinor, expected.output);
});

test('the 0.00 payout: a sale fully offset by its fee and coach transfer pays out nothing, and its output VAT is still owed', () => {
  const t = settlementWorld();
  setTemplate(t);
  const res = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'z1' }));
  const zero = byId(res, 'zf_po_0002');
  assert.equal(zero.outcome, 'skipped');
  assert.equal(zero.amountMinor, 0);
  const sale = byId(res, 'kw:sale:2001');
  assert.equal(sale.outcome, 'booked');
  assert.equal(legsOf(t.store, sale.entryId).find((l) => l.number === '2200').credit, 810, 'the output VAT is on 2200');
  const cycle = ['kw:sale:2001', 'zf_bt_0002:fee', 'zf_tr_0002'].map((id) => byId(res, id).amountMinor).reduce((s, x) => s + x, 0);
  assert.equal(cycle, 0, 'the sale, its fee and its coach transfer net to zero on the clearing account');
});

test('[INVARIANT vat] a gross-split VAT one Rappen off the net-forward figure books the FILE\'s Rappen; a VAT the code cannot produce refuses vat_not_exact for that event only; VAT without a code refuses vat_unmapped', () => {
  // Guards the hint hand-off (taxAmount) in `linesFor`: a fee of 1.00 gross is 0.07 VAT on 0.93 by the
  // gross split, while 0.93 net-forward would be 0.08. Without the hint the B2 gate stamps 0.08 and
  // refuses the entry; with it the return reads 0.07, the file's figure.
  const t = settlementWorld();
  setTemplate(t);
  const file = {
    schema: 'till-settlement/v1',
    source: { system: SYSTEM, processor: PROCESSOR },
    events: [
      { id: 'x-1', kind: 'sale', day: '2026-07-02', currency: 'CHF', amount: 10.83, net: 10, vat: { amount: 0.83 } },
      { id: 'x-2', kind: 'sale', day: '2026-07-02', currency: 'CHF', amount: 10.81, net: 10, vat: { amount: 0.81 } },
      { id: 'x-3', kind: 'sale', day: '2026-07-02', currency: 'CHF', amount: 9.19, net: 10, vat: { amount: -0.81 } },
      { id: 'gs-1', kind: 'processing_fee', day: '2026-07-02', currency: 'CHF', amount: -1, net: -0.93, vat: { amount: -0.07 } },
    ],
  };
  const res = must(importSettlement(t.ctx, { settlement: file, idempotencyKey: 'x1' }));
  const gross = byId(res, 'gs-1');
  assert.equal(gross.outcome, 'booked', JSON.stringify(gross));
  assert.equal(legsOf(t.store, gross.entryId).find((l) => l.number === '1170').debit, 7, 'the file\'s 0.07, not the net-forward 0.08');
  const vat = must(computeVatReturn(t.ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  assert.equal(vat.totalInputTaxMinor, 7);
  assert.equal(vat.totalTaxDueMinor, 81, 'only x-2 is owed');
  assert.equal(byId(res, 'x-1').code, 'vat_not_exact');
  assert.equal(byId(res, 'x-2').outcome, 'booked');
  assert.equal(byId(res, 'x-3').code, 'vat_not_exact', 'a VAT against its base is never booked');
  const t2 = settlementWorld();
  must(setSettlementTemplate(t2.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t2.acc('1095'), kinds: { sale: { action: 'book', accountId: t2.acc('3400'), taxCode: null } }, idempotencyKey: 'nocode' }));
  const unmapped = must(importSettlement(t2.ctx, { settlement: { ...file, events: [file.events[1]] }, idempotencyKey: 'x2' }));
  assert.equal(unmapped.events[0].code, 'vat_unmapped');
  assert.equal(rows(t2.store, t2.workspaceId).events, 0);
});

test('[INVARIANT vat] vat: null under an INPUT code books the gross untaxed beside a VAT-carrying event of the same kind; a sale with vat: null under an OUTPUT code still refuses', () => {
  // Guards the `vat: null` input branch in `linesFor`. Removed, the unregistered seller's payout and the
  // untaxed fee refuse vat_not_exact (a real producer file could never fully book); widened to every
  // code kind, the untaxed sale would book with no output VAT owed on it.
  const t = settlementWorld();
  setTemplate(t);
  const file = {
    schema: 'till-settlement/v1',
    source: { system: SYSTEM, processor: PROCESSOR },
    events: [
      { id: 'tp-reg', kind: 'third_party_payout', day: '2026-07-05', currency: 'CHF', amount: -86.48, net: -80, vat: { amount: -6.48 } },
      { id: 'tp-unreg', kind: 'third_party_payout', day: '2026-07-05', currency: 'CHF', amount: -54.05, net: -54.05, vat: null },
      { id: 'fee-untaxed', kind: 'processing_fee', day: '2026-07-06', currency: 'CHF', amount: -0.95, net: -0.95, vat: null },
      { id: 'sale-untaxed', kind: 'sale', day: '2026-07-06', currency: 'CHF', amount: 50, net: 50, vat: null },
    ],
  };
  const res = must(importSettlement(t.ctx, { settlement: file, idempotencyKey: 'vn1' }));
  assert.equal(byId(res, 'tp-reg').outcome, 'booked');
  for (const id of ['tp-unreg', 'fee-untaxed']) {
    const o = byId(res, id);
    assert.equal(o.outcome, 'booked', `${id}: ${JSON.stringify(o)}`);
    const legs = legsOf(t.store, o.entryId);
    assert.equal(legs.length, 2, `${id}: the clearing account and the contra account, no VAT line`);
    assert.ok(legs.every((l) => l.taxCode === null && l.taxAmount === null), `${id}: no VAT trace`);
    const signed = (number) => legs.filter((l) => l.number === number).reduce((s, l) => s + l.debit - l.credit, 0);
    const e = file.events.find((x) => x.id === id);
    assert.equal(signed('1095'), minor(e.amount));
    assert.equal(legs.find((l) => l.number !== '1095').debit, 0 - minor(e.amount), `${id}: the gross is the net`);
  }
  const sale = byId(res, 'sale-untaxed');
  assert.equal(sale.outcome, 'refused');
  assert.equal(sale.code, 'vat_not_exact', 'a sale the output code taxes is never booked without its VAT');
  const vat = must(computeVatReturn(t.ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  assert.equal(vat.totalInputTaxMinor, 648, 'only the registered seller\'s VAT is deducted');
  assert.equal(vat.totalTaxDueMinor, 0);
});

// ================================================================================================
// 4. Idempotency on the external id, the amended event, the call key
// ================================================================================================

test('[INVARIANT idempotent-on-rows] importing the same file again books nothing: every event already_imported, no new row anywhere', () => {
  // Guards the `settlement_event` lookup in `importSettlement` (the external id) and its unique index:
  // removing the lookup makes the second call post a second entry per event.
  const t = settlementWorld();
  setTemplate(t);
  const first = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'i1' }));
  const after = rows(t.store, t.workspaceId);
  const second = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'i2' }));
  assert.equal(second.booked, 0);
  assert.equal(second.alreadyImported, first.booked);
  assert.deepEqual(rows(t.store, t.workspaceId), after, 'a new call key books nothing twice');
  for (const e of second.events.filter((x) => x.outcome === 'already_imported')) {
    assert.equal(e.entryId, byId(first, e.id).entryId, `${e.id}: names the entry booked the first time`);
  }
  const replay = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'i1' }));
  assert.deepEqual(replay, first, 'the same call key replays the first report');
  assert.deepEqual(rows(t.store, t.workspaceId), after);
  // The table itself refuses a second row for one external id, and refuses an edit or a delete.
  const one = t.store.db.prepare('SELECT * FROM settlement_event WHERE workspace_id = ? LIMIT 1').get(t.workspaceId);
  assert.throws(() => t.store.db.prepare('INSERT INTO settlement_event SELECT \'dup\', workspace_id, source_system, source_processor, event_id, kind, day, currency, amount_minor, net_minor, vat_minor, entry_id, document_number, counterparty, refs_json, created_by, created_at FROM settlement_event WHERE id = ?').run(one.id), /UNIQUE/);
  assert.throws(() => t.store.db.prepare('UPDATE settlement_event SET amount_minor = 1 WHERE id = ?').run(one.id), /append-only/);
  assert.throws(() => t.store.db.prepare('DELETE FROM settlement_event WHERE id = ?').run(one.id), /append-only/);
});

test('[INVARIANT append-only] the same id with different money refuses event_amended naming what changed; the posted entry is never touched', () => {
  // Guards `amendments` and the refusal before any posting: an amended event must never post a second
  // entry, edit the first, or reverse it.
  const t = settlementWorld();
  setTemplate(t);
  const first = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'a1' }));
  const entryId = byId(first, 'kw:sale:1001').entryId;
  const legsBefore = legsOf(t.store, entryId);
  const before = rows(t.store, t.workspaceId);
  const amended = julyFile();
  amended.events[0] = { ...amended.events[0], amount: 217.28, net: 201, vat: { amount: 16.28 } };
  amended.events[1] = { ...amended.events[1], kind: 'service_fee' };
  const res = must(importSettlement(t.ctx, { settlement: amended, idempotencyKey: 'a2' }));
  const sale = byId(res, 'kw:sale:1001');
  assert.equal(sale.outcome, 'refused');
  assert.equal(sale.code, 'event_amended');
  assert.equal(sale.entryId, entryId);
  assert.deepEqual(sale.changed.map((c) => c.field), ['amountMinor', 'netMinor', 'vatMinor']);
  assert.deepEqual(sale.changed[0], { field: 'amountMinor', was: 21620, now: 21728 });
  assert.deepEqual(byId(res, 'zf_bt_0001:fee').changed, [{ field: 'kind', was: 'processing_fee', now: 'service_fee' }]);
  assert.deepEqual(legsOf(t.store, entryId), legsBefore, 'the posted entry is unchanged');
  assert.deepEqual(rows(t.store, t.workspaceId), before, 'nothing written');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id IS NOT NULL').get(t.workspaceId).n, 0, 'nothing reversed');
  // A person's correction is a reversing entry; the event stays booked, so a re-import still books nothing.
  must(reverseEntry(t.ctx, { entryId, idempotencyKey: 'rev-1' }));
  const again = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'a3' }));
  assert.equal(byId(again, 'kw:sale:1001').outcome, 'already_imported');
});

test('[INVARIANT race] a second TILL process cannot book an event between the import\'s lookup of its external id and its write', async () => {
  // Guards that the `settlement_event` lookup runs INSIDE the per-event IMMEDIATE transaction that posts
  // and inserts. With the lookup outside it, the other process (the Studio beside `till mcp`, D12) takes
  // the write lock right after the lookup missed and records the same event; this call then posts, hits
  // the UNIQUE index on its insert and dies with a raw SqliteError midway through the file. With the
  // lookup inside, the lock is held from the lookup to the commit, the other process waits, and its late
  // insert of the same external id is the one that is ignored.
  const path = join(mkdtempSync(join(tmpdir(), 'till-settlement-')), 'till.db');
  const t = settlementWorld({ location: path });
  setTemplate(t);
  const sale = (id, day) => ({ id, kind: 'sale', day, currency: 'CHF', amount: 10.81, net: 10, vat: { amount: 0.81 } });
  const file = (events) => ({ schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, events });
  const pre = must(importSettlement(t.ctx, { settlement: file([sale('race-0', '2026-07-01')]), idempotencyKey: 'race-pre' }));
  const otherEntry = pre.events[0].entryId;
  const insert = `INSERT OR IGNORE INTO settlement_event (id, workspace_id, source_system, source_processor, event_id, kind, day, currency, amount_minor, net_minor, vat_minor, entry_id, document_number, counterparty, refs_json, created_by, created_at)
    VALUES ('stlevt_other', '${t.workspaceId}', 'kurswerk', 'zahlfix', 'race-1', 'sale', '2026-07-02', 'CHF', 1081, 1000, 81, '${otherEntry}', NULL, NULL, NULL, 'other-process', '2026-07-02T00:00:00.000Z')`;
  const holder = await lockHolder(path, { holdMs: 300, inTransaction: `db.exec(${JSON.stringify(insert)});` });
  const prepare = t.store.db.prepare;
  let took = null;
  t.store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (!/FROM settlement_event WHERE workspace_id = \? AND source_system/.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, prop) {
        if (prop !== 'get') return Reflect.get(target, prop);
        return (...args) => {
          if (took === null && args.includes('race-1')) took = holder.take(500);
          return target.get(...args);
        };
      },
    });
  };
  let res;
  try {
    res = importSettlement(t.ctx, { settlement: file([sale('race-1', '2026-07-02')]), idempotencyKey: 'race-1' });
  } finally {
    delete t.store.db.prepare;
  }
  await holder.done;
  assert.equal(took, false, 'the other process could not take the write lock between the lookup and the write');
  must(res);
  assert.equal(res.events[0].outcome, 'booked', JSON.stringify(res.events[0]));
  const stored = t.store.db.prepare('SELECT id, entry_id FROM settlement_event WHERE workspace_id = ? AND event_id = ?').all(t.workspaceId, 'race-1');
  assert.deepEqual(stored, [{ id: stored[0].id, entry_id: res.events[0].entryId }], 'one row for the event, this call\'s; the late insert was ignored');
  t.store.close();
});

// ================================================================================================
// 5. Periods, tenants, attachments, the two faces, the agent seat
// ================================================================================================

test('[INVARIANT period] an event into a locked period refuses period_locked on its own; the others book', () => {
  // Guards that the period refusal of `postEntry` reaches the event's outcome and rolls back only that
  // event's transaction (no settlement_event row, no entry), never the file.
  const t = settlementWorld({ realPeriods: true });
  setTemplate(t);
  must(lockPeriod(t.ctx, { period: '2026-06', kind: 'soft', reason: 'Juni abgeschlossen', idempotencyKey: 'lock-06' }));
  const file = {
    schema: 'till-settlement/v1',
    source: { system: SYSTEM, processor: PROCESSOR },
    events: [
      { id: 'jun-1', kind: 'sale', day: '2026-06-30', currency: 'CHF', amount: 10.81, net: 10, vat: { amount: 0.81 } },
      { id: 'jul-1', kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 21.62, net: 20, vat: { amount: 1.62 } },
    ],
  };
  const res = must(importSettlement(t.ctx, { settlement: file, idempotencyKey: 'p1' }));
  assert.equal(byId(res, 'jun-1').outcome, 'refused');
  assert.equal(byId(res, 'jun-1').code, 'period_locked');
  assert.equal(byId(res, 'jul-1').outcome, 'booked');
  const stored = t.store.db.prepare('SELECT event_id FROM settlement_event WHERE workspace_id = ?').all(t.workspaceId).map((r) => r.event_id);
  assert.deepEqual(stored, ['jul-1'], 'the refused event left no row behind');
});

test('[INVARIANT tenant] a template and the booked events are per workspace: the other workspace sees neither', () => {
  // Guards the workspace_id predicate in `readStoredTemplate` and in the settlement_event lookup.
  const t = settlementWorld();
  setTemplate(t);
  must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 't1' }));
  const b = secondWorkspace(t);
  refused(importSettlement(b.ctx, { settlement: julyFile(), idempotencyKey: 't1' }), 'settlement_template_missing');
  assert.deepEqual(must(getSettlementTemplate(b.ctx, {})).templates, []);
  const made = getAction('create_account').run(t.deps, { workspaceId: b.workspaceId, number: '1095', name: 'Durchlaufkonto B', type: 'asset', idempotencyKey: 'b-1095' });
  const fee = getAction('create_account').run(t.deps, { workspaceId: b.workspaceId, number: '6940', name: 'Gebühren B', type: 'expense', idempotencyKey: 'b-6940' });
  assert.ok(made.ok && fee.ok);
  setTemplate(b, b.ctx, b.acc, 'tpl-b');
  const res = must(importSettlement(b.ctx, { settlement: julyFile(), idempotencyKey: 't2' }));
  assert.equal(res.booked, 9, 'the same external ids book again in another workspace: the key is per workspace');
  assert.equal(res.alreadyImported, 0);
});

test('PDF attachments link as Belege to the entries whose document number matches; a re-import links nothing twice', () => {
  const t = settlementWorld();
  setTemplate(t);
  const attachments = [
    { fileName: 'KW-R-0001.pdf', contentBase64: TINY_PDF_BASE64, documentNumber: 'KW-R-0001' },
    { fileName: 'KW-X-9999.pdf', contentBase64: Buffer.from('%PDF-1.4\n% another invented file\n%%EOF\n').toString('base64'), documentNumber: 'KW-X-9999' },
  ];
  const res = must(importSettlement(t.ctx, { settlement: julyFile(), attachments, idempotencyKey: 'f1' }));
  const sale = byId(res, 'kw:sale:1001');
  assert.equal(sale.attached.length, 1);
  const linked = t.store.db.prepare("SELECT entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry'").all(t.workspaceId);
  assert.deepEqual(linked, [{ entity_kind: 'journal_entry', entity_id: sale.entryId }]);
  assert.deepEqual(res.unmatchedAttachments, [{ fileName: 'KW-X-9999.pdf', documentNumber: 'KW-X-9999' }]);
  const files = rows(t.store, t.workspaceId).files;
  must(importSettlement(t.ctx, { settlement: julyFile(), attachments, idempotencyKey: 'f2' }));
  assert.equal(rows(t.store, t.workspaceId).files, files, 'the same bytes on the same entry are not stored again');
  refused(importSettlement(t.ctx, { settlement: julyFile(), attachments: [{ fileName: 'a.txt', contentBase64: Buffer.from('hello').toString('base64'), documentNumber: 'KW-R-0001' }], idempotencyKey: 'f3' }), 'invalid_input');
});

test('an attachment that cannot be linked to an event booked BEFORE is reported on its outcome and stays in unmatchedAttachments', () => {
  // Guards the already_imported branch of `importSettlement`: the attach refusal used to be swallowed
  // (no code, no cause) and its document marked used before the link, so the answer hid a Beleg that was
  // filed nowhere. The failure here is E00's own receipt guard: the same bytes already evidence another
  // entry, and a second booking of a receipt needs a person's override.
  const t = settlementWorld();
  setTemplate(t);
  const pdf = { fileName: 'beleg.pdf', contentBase64: TINY_PDF_BASE64 };
  const first = must(importSettlement(t.ctx, { settlement: julyFile(), attachments: [{ ...pdf, documentNumber: 'KW-R-0002' }], idempotencyKey: 'af1' }));
  assert.equal(byId(first, 'kw:sale:2001').attached.length, 1, 'premise: the bytes evidence the second sale');
  const before = rows(t.store, t.workspaceId);
  const again = must(importSettlement(t.ctx, { settlement: julyFile(), attachments: [{ ...pdf, documentNumber: 'KW-R-0001' }], idempotencyKey: 'af2' }));
  const sale = byId(again, 'kw:sale:1001');
  assert.equal(sale.outcome, 'already_imported', 'the event stays booked: its entry stands');
  assert.equal(sale.entryId, byId(first, 'kw:sale:1001').entryId);
  assert.equal(sale.code, 'attachment_failed', JSON.stringify(sale));
  assert.equal(typeof sale.sentence, 'string');
  assert.equal(sale.cause.error, 'receipt_already_booked', 'the engine refusal behind it is on the outcome');
  assert.equal(sale.attached, undefined);
  assert.deepEqual(again.unmatchedAttachments, [{ fileName: 'beleg.pdf', documentNumber: 'KW-R-0001' }], 'the Beleg filed nowhere is named');
  assert.deepEqual(rows(t.store, t.workspaceId), before, 'nothing written');
});

test('[INVARIANT attachment rollback] an attachment that cannot be linked rolls its NEW event back: no journal entry and no settlement_event row; the others book', () => {
  // Guards that `attachAll` runs INSIDE the posting's transaction (`store.tx` around post, insert and
  // attach): moved after the commit, the refused attachment would leave a posted entry and its event row
  // behind, and the outcome would read booked for a Beleg that was never filed.
  const t = settlementWorld();
  setTemplate(t);
  const pdf = { fileName: 'beleg.pdf', contentBase64: TINY_PDF_BASE64 };
  must(importSettlement(t.ctx, { settlement: julyFile(), attachments: [{ ...pdf, documentNumber: 'KW-R-0001' }], idempotencyKey: 'ar1' }));
  const before = rows(t.store, t.workspaceId);
  const file = {
    schema: 'till-settlement/v1',
    source: { system: SYSTEM, processor: PROCESSOR },
    events: [
      { id: 'kw:sale:3001', kind: 'sale', day: '2026-07-20', currency: 'CHF', amount: 10.81, net: 10, vat: { amount: 0.81 }, document: { type: 'client_invoice', number: 'KW-R-0003' } },
      { id: 'kw:sale:3002', kind: 'sale', day: '2026-07-21', currency: 'CHF', amount: 21.62, net: 20, vat: { amount: 1.62 } },
    ],
  };
  const res = must(importSettlement(t.ctx, { settlement: file, attachments: [{ ...pdf, documentNumber: 'KW-R-0003' }], idempotencyKey: 'ar2' }));
  const failed = byId(res, 'kw:sale:3001');
  assert.equal(failed.outcome, 'refused');
  assert.equal(failed.code, 'attachment_failed', JSON.stringify(failed));
  assert.equal(failed.cause.error, 'receipt_already_booked');
  assert.equal(failed.entryId, undefined);
  assert.equal(byId(res, 'kw:sale:3002').outcome, 'booked', 'the other event books');
  const after = rows(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'only the other event posted an entry');
  assert.equal(after.events, before.events + 1, 'only the other event left a settlement_event row');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM settlement_event WHERE workspace_id = ? AND event_id = ?').get(t.workspaceId, 'kw:sale:3001').n, 0);
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND ref = 'KW-R-0003'").get(t.workspaceId).n, 0, 'no entry for the refused event');
  assert.equal(after.files, before.files, 'no file row either');
  assert.deepEqual(res.unmatchedAttachments, [{ fileName: 'beleg.pdf', documentNumber: 'KW-R-0003' }]);
});

test('parity: the MCP verb and its REST twin answer the same report and write the same rows', () => {
  const a = settlementWorld();
  setTemplate(a);
  const viaMcp = getAction('import_settlement').run(a.deps, { workspaceId: a.workspaceId, settlement: julyFile(), idempotencyKey: 'par' });
  const b = settlementWorld();
  setTemplate(b);
  const viaRest = handleRest('import_settlement', { workspaceId: b.workspaceId, settlement: julyFile(), idempotencyKey: 'par' }, b.deps);
  assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
  assert.equal(viaMcp.ok, true);
  const shape = (r) => r.events.map((e) => [e.id, e.outcome, e.code ?? null]);
  assert.deepEqual(shape(viaRest.body), shape(viaMcp));
  assert.deepEqual(viaRest.body.reconciliation, viaMcp.reconciliation);
  assert.deepEqual(rows(b.store, b.workspaceId), rows(a.store, a.workspaceId));
});

test('an agent seat\'s import drafts a Vorschlag (the post dial) after the same validation, and books on approval', () => {
  const t = settlementWorld();
  setTemplate(t);
  const agentDeps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' };
  // Validated before it is drafted: no template for the source means no Vorschlag at all.
  const other = { ...julyFile(), source: { system: 'Unbekannt', processor: PROCESSOR } };
  const refusedDraft = runGoverned(agentDeps, getAction('import_settlement'), { workspaceId: t.workspaceId, settlement: other, idempotencyKey: 'ag-0' });
  assert.equal(refusedDraft.ok, false);
  assert.equal(refusedDraft.error, 'settlement_template_missing');
  const before = rows(t.store, t.workspaceId);
  const drafted = must(runGoverned(agentDeps, getAction('import_settlement'), { workspaceId: t.workspaceId, settlement: julyFile(), idempotencyKey: 'ag-1' }));
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(rows(t.store, t.workspaceId).entries, before.entries, 'a draft books nothing');
  const approved = must(getAction('approve_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: drafted.actionId }));
  assert.ok(approved, 'approved');
  assert.equal(rows(t.store, t.workspaceId).events, 9, 'the approval booked the file');
});

// ================================================================================================
// 6. The reconciliation with the bank: a one-leg Buchungsregel 1020/1095 and the reserve on 1095
// ================================================================================================

test('[INVARIANT reconciliation] the bank payout lines are proposed sure by a one-leg rule 1020/1095, and after booking them the 1095 residual is the reserve held', () => {
  // Guards the reconciliation signal (expected, booked, payouts, not booked, unexplained) and the claim
  // that the settlement import and the one-leg bank rule together leave exactly the reserve on 1095:
  // booked + bankPayouts = expected - notBooked.
  const t = settlementWorld();
  setTemplate(t);
  const doc = julyFile();
  const res = must(importSettlement(t.ctx, { settlement: doc, idempotencyKey: 'r1' }));
  assert.equal(res.reconciliation.expectedClearingChangeMinor, 0, 'the processor balance ends where it started (the reserve aside, it is all paid out)');
  assert.equal(res.reconciliation.bankPayoutsMinor, -10540);
  assert.equal(res.reconciliation.notBookedByImportMinor, -2000, 'the reserve hold is the amount the import leaves off the clearing account');
  assert.equal(res.reconciliation.bookedClearingChangeMinor, 12540, 'what the file\'s own entries put on 1095');
  assert.equal(res.reconciliation.differenceMinor, 12540);
  assert.equal(res.reconciliation.unexplainedMinor, 0, 'every Rappen of the file is accounted for');
  assert.equal(balanceOf(t.store, t.workspaceId, '1095'), 12540, 'before the bank lines: the booked events');

  // An invented ZKB-style statement: two credits from the processor, the remittance text "STRIPE ...".
  const l = importLines(t, {
    statementId: 'ZKB-INV-07',
    entries: [
      { ref: 'PO1', amountMinor: 6000, cd: 'CRDT', date: '2026-07-21', name: 'Zahlfix Payments Ltd', ustrd: 'STRIPE ZF PO 0001' },
      { ref: 'PO3', amountMinor: 4540, cd: 'CRDT', date: '2026-07-28', name: 'Zahlfix Payments Ltd', ustrd: 'STRIPE ZF PO 0003' },
    ],
  }).lines;
  must(setBankStandard(t.ctx, { bankTxnId: l.PO1, legs: [{ accountId: t.acc('1095'), taxCode: null, amount: { kind: 'rest' } }], label: 'Zahlfix Auszahlung', matchText: 'stripe', idempotencyKey: 'rule' }));
  const inbox = must(listBankInbox(t.ctx, { status: 'open' }));
  for (const id of [l.PO1, l.PO3]) {
    const line = inbox.lines.find((x) => x.bankTxnId === id);
    assert.equal(line.proposal.certainty, 'sure', `${id}: the one-leg rule proposes it sure: ${JSON.stringify(line.proposal)}`);
    assert.equal(line.proposal.reasonCode, 'standard');
    must(bookBankLine(t.ctx, { bankTxnId: id, target: line.proposal.target, idempotencyKey: `book-${id}` }));
  }
  const reserveHeld = 0 - doc.events.filter((e) => e.kind === 'reserve').reduce((s, e) => s + minor(e.amount), 0);
  assert.equal(reserveHeld, 2000);
  assert.equal(balanceOf(t.store, t.workspaceId, '1095'), reserveHeld, 'the 1095 residual is the reserve held');
  const r = res.reconciliation;
  assert.equal(r.bookedClearingChangeMinor + r.bankPayoutsMinor, r.expectedClearingChangeMinor - r.notBookedByImportMinor, 'the signal predicts that residual');
  assert.equal(r.bookedClearingChangeMinor + r.bankPayoutsMinor, reserveHeld);
  // The bank lines are not the file's entries: a re-import under a new key books nothing and reads the
  // same figures, whatever else the clearing account carries by now.
  const after = must(importSettlement(t.ctx, { settlement: doc, idempotencyKey: 'r2' }));
  assert.equal(after.booked, 0);
  assert.deepEqual(after.reconciliation, res.reconciliation);
  const whole = t.store.db
    .prepare('SELECT SUM(l.base_debit_minor) AS d, SUM(l.base_credit_minor) AS c FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?')
    .get(t.workspaceId);
  assert.equal(whole.d, whole.c, 'the journal as a whole still balances');
});

test('[INVARIANT reconciliation] the figures are the file\'s own: an overlapping file, a manual entry and a payout booked after the last day move nothing; a kind switched to skip still counts as booked; an amended event shows as unexplained', () => {
  // Guards `movementOfEntries` (the file's own entries, never a ledger window over its days) and the
  // has-an-entry classification of `notBookedByImportMinor` (never the template in force).
  const t = settlementWorld();
  setTemplate(t);
  const first = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'o1' }));
  const want = first.reconciliation;
  assert.equal(want.bookedClearingChangeMinor, 12540);
  // Another file on overlapping days, a manual entry on 1095 inside the window, and the bank payout of
  // the last day booked two days after it.
  must(importSettlement(t.ctx, { settlement: { schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, events: [{ id: 'other-file-1', kind: 'sale', day: '2026-07-15', currency: 'CHF', amount: 10.81, net: 10, vat: { amount: 0.81 } }] }, idempotencyKey: 'o2' }));
  must(postEntry(t.ctx, { date: '2026-07-16', source: 'manual', description: 'Umbuchung von Hand (erfunden)', idempotencyKey: 'o-manual', lines: [{ account: t.acc('1095'), debit: 5000 }, { account: t.acc('1020'), credit: 5000 }] }));
  must(postEntry(t.ctx, { date: '2026-08-02', source: 'manual', description: 'Auszahlung Zahlfix (erfunden)', idempotencyKey: 'o-payout', lines: [{ account: t.acc('1020'), debit: 4540 }, { account: t.acc('1095'), credit: 4540 }] }));
  const again = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'o3' }));
  assert.deepEqual(again.reconciliation, want, 'nothing outside the file moves its figures');

  // The owner now skips processing fees: the two fees booked in July keep their entries and stay counted.
  const kinds = { ...templateKinds(t), processing_fee: { action: 'skip' } };
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: 'o-skip' }));
  const skipped = must(importSettlement(t.ctx, { settlement: julyFile(), idempotencyKey: 'o4' }));
  for (const id of ['zf_bt_0001:fee', 'zf_bt_0002:fee']) {
    const o = byId(skipped, id);
    assert.equal(o.outcome, 'skipped');
    assert.equal(o.entryId, byId(first, id).entryId, `${id}: the outcome names the entry booked before`);
  }
  assert.deepEqual(skipped.reconciliation, want, 'a booked event is never counted as not booked');

  // An amended sale keeps its entry (21620 on 1095) while the file says 21728: 1.08 unexplained.
  const amended = julyFile();
  amended.events[0] = { ...amended.events[0], amount: 217.28, net: 201, vat: { amount: 16.28 } };
  const changed = must(importSettlement(t.ctx, { settlement: amended, idempotencyKey: 'o5' }));
  assert.equal(byId(changed, 'kw:sale:1001').code, 'event_amended');
  assert.equal(changed.reconciliation.bookedClearingChangeMinor, want.bookedClearingChangeMinor);
  assert.equal(changed.reconciliation.unexplainedMinor, -108, 'the amendment is the gap the signal shows');
});

test('the template accepts account numbers on the wire (the registry boundary resolves them)', () => {
  const t = settlementWorld();
  const kinds = Object.fromEntries(Object.entries(templateKinds(t)).map(([k, v]) => [k, { ...v, accountId: t.store.db.prepare('SELECT number FROM account WHERE id = ?').get(v.accountId).number }]));
  const res = getAction('set_settlement_template').run(t.deps, { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, clearingAccountId: '1095', kinds, idempotencyKey: 'num' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.template.kinds.sale.accountNumber, '3400');
  assert.equal(res.template.clearingAccountNumber, '1095');
});
