// The A1 composer's request, composed by the REAL engine (A02 §6, D152 amendment: the Studio does no VAT math).
//
// The Studio's "Neue Buchung" takes a GROSS Betrag and asks `compose_entry` to expand it: the engine derives
// the VAT leg, stamps the trace and answers the exact `post_entry` lines, which the Studio posts verbatim.
// `app/src/surfaces/Journal/composerPayload.ts` is the one pure module that turns what is on screen into
// that request (`composeSatz` + `composeLines`). This suite imports it as it ships (Node strips its types)
// and holds the whole path to the engine:
//
//  1. every request it builds over a sweep of Rappen edge amounts, every code kind, both sides and a saldo
//     workspace composes to lines that POST (`reconcileAndStampVat` accepts them), and
//  2. the rows the engine stores for them are EXACTLY the rows it stores for `buildVatLines` (the engine's
//     own expansion) on the same booking: the same accounts, amounts, sides and the same stamped trace.
//
// Every workspace, account default and figure here is synthetic, invented for the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry, saveDraft, getEntry } from '../../dist/core/ledger/index.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { buildVatLines, computeLineTax } from '../../dist/core/vat/index.js';
import { createCostCenter } from '../../dist/core/accounts/index.js';
import { setup } from './support.mjs';

// A computed specifier, so the root type check does not pull the Studio's TypeScript into its program.
const COMPOSER = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerPayload.ts', import.meta.url))).href;
const composer = await import(COMPOSER);
const { composeSatz, composeLines, satzFromIntent, opensDerived } = composer;

const DATE = '2026-03-02';

/** The gross amounts swept, in Rappen: the brief's Rappen edges plus a few rounding-sensitive ones. */
const AMOUNTS = [10770, 5, 100, 9999995, 1, 99, 1081, 123457, 8100, 107];

function accountsOf(ctx) {
  return ctx.store.db
    .prepare('SELECT id, number, type, vat_code_default, cost_center_allowed FROM account WHERE workspace_id = ?')
    .all(ctx.workspaceId)
    .map((r) => ({ id: r.id, number: r.number, type: r.type, vatCodeDefault: r.vat_code_default, costCenterAllowed: r.cost_center_allowed === 1 }));
}

function world(method) {
  const w = setup({ method });
  // An Anlagekonto the chart gives a default code: the investment purchase (Vorsteuer Ziffer 405).
  w.store.db.prepare("UPDATE account SET vat_code_default = 'VST-I' WHERE workspace_id = ? AND number = '1500'").run(w.workspaceId);
  const accounts = accountsOf(w.ctx);
  const byNumber = (n) => {
    const a = accounts.find((x) => x.number === n);
    assert.ok(a, `the seeded chart has no ${n}`);
    return a;
  };
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return { ...w, accounts, byNumber, accountOf: (id) => byId.get(id) };
}

function kindOf(ctx, code) {
  const row = ctx.store.db.prepare('SELECT kind FROM tax_code WHERE workspace_id = ? AND code = ?').get(ctx.workspaceId, code);
  return row === undefined ? null : row.kind;
}

/** What the drawer sends and gets back: the Studio's request, expanded by `compose_entry`. */
function compose(w, composed, derive = true, date = DATE, entryId) {
  const r = composeEntry(w.ctx, { mode: 'expand', date, ...(entryId !== undefined ? { entryId } : {}), lines: composeLines(composed, derive, date) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

let seq = 0;
function post(ctx, lines, date = DATE) {
  seq += 1;
  return postEntry(ctx, { date, source: 'manual', idempotencyKey: `composer-${seq}`, lines });
}

/** The stored rows of an entry, as comparable strings (account, amounts, trace, cost centre). */
function storedRows(ctx, entryId) {
  return ctx.store.db
    .prepare('SELECT account_id, cost_center_id, debit_minor, credit_minor, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ?')
    .all(entryId)
    .map((r) => [r.account_id, r.cost_center_id, r.debit_minor, r.credit_minor, r.tax_code, r.tax_base_minor, r.tax_amount_minor, r.supply_date].join('|'))
    .sort();
}

/** `buildVatLines` for the same booking, mirrored for the unnatural side, with its zero legs dropped. */
function referenceLines(ctx, { baseAccount, counterAccount, amountMinor, taxCode, direction, mirrored }) {
  const kind = taxCode === '' ? null : kindOf(ctx, taxCode);
  const lines = buildVatLines(ctx, {
    counterAccount,
    revenueOrExpenseAccount: baseAccount,
    amountMinor,
    // Bezugsteuer's paid amount IS the base: the foreign supplier charged no Swiss VAT.
    amountIsGross: kind !== 'reverse_charge',
    taxCode: taxCode === '' ? null : taxCode,
    direction,
    supplyDate: DATE,
  }).filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  if (!mirrored) return lines;
  return lines.map(({ debit, credit, ...rest }) => ({ ...rest, ...(credit !== undefined ? { debit: credit } : {}), ...(debit !== undefined ? { credit: debit } : {}) }));
}

/** `decompose` of a stored entry, and the Studio's own reading of it. */
function reopen(w, entryId) {
  const d = composeEntry(w.ctx, { mode: 'decompose', entryId });
  assert.equal(d.ok, true, JSON.stringify(d));
  return { ...d, satz: opensDerived(d, w.accountOf) ? satzFromIntent(d.intent, w.accountOf, d.date) : null };
}

/**
 * The bookings swept. `soll`/`haben` are the satz the person types; `base`/`counter`/`direction`/`mirrored`
 * say how the same booking is spelled to `buildVatLines`.
 */
const EFFEKTIV_CASES = [
  { name: 'Vorsteuer on an expense (6500 an 1020, VST-M)', soll: '6500', haben: '1020', taxCode: 'VST-M', base: '6500', counter: '1020', direction: 'input' },
  { name: 'Vorsteuer Investitionen to 1171 (1500 an 1020, VST-I)', soll: '1500', haben: '1020', taxCode: 'VST-I', base: '1500', counter: '1020', direction: 'input' },
  { name: 'Umsatzsteuer 8.1 on a revenue (1100 an 3400, UST81)', soll: '1100', haben: '3400', taxCode: 'UST81', base: '3400', counter: '1100', direction: 'output' },
  { name: 'Umsatzsteuer 2.6 on a revenue (1100 an 3200, UST26)', soll: '1100', haben: '3200', taxCode: 'UST26', base: '3200', counter: '1100', direction: 'output' },
  { name: 'ausgenommen (1100 an 3400, AUSGENOMMEN)', soll: '1100', haben: '3400', taxCode: 'AUSGENOMMEN', base: '3400', counter: '1100', direction: 'output' },
  { name: 'Export befreit (1100 an 3400, EXPORT0)', soll: '1100', haben: '3400', taxCode: 'EXPORT0', base: '3400', counter: '1100', direction: 'output' },
  { name: 'Bezugsteuer, paired 2200/1170 legs (6500 an 1020, BEZUG)', soll: '6500', haben: '1020', taxCode: 'BEZUG', base: '6500', counter: '1020', direction: 'input' },
  { name: 'Einfuhrsteuer on 1170 (6500 an 1020, IMPORT)', soll: '6500', haben: '1020', taxCode: 'IMPORT', base: '6500', counter: '1020', direction: 'input' },
  { name: 'no code at all (6500 an 1020, Ohne MWST)', soll: '6500', haben: '1020', taxCode: '', base: '6500', counter: '1020', direction: 'input' },
  { name: 'the unnatural side: a supplier refund (1020 an 6500, VST-M)', soll: '1020', haben: '6500', taxCode: 'VST-M', base: '6500', counter: '1020', direction: 'input', mirrored: true },
  { name: 'the unnatural side: a revenue reduction (3400 an 1100, UST81)', soll: '3400', haben: '1100', taxCode: 'UST81', base: '3400', counter: '1100', direction: 'output', mirrored: true },
];

const SALDO_CASES = [
  { name: 'saldo: non-deductible Vorsteuer folds into the gross (6500 an 1020, VST-M)', soll: '6500', haben: '1020', taxCode: 'VST-M', base: '6500', counter: '1020', direction: 'input' },
  { name: 'saldo: Bezugsteuer owed, not deductible (6500 an 1020, BEZUG)', soll: '6500', haben: '1020', taxCode: 'BEZUG', base: '6500', counter: '1020', direction: 'input' },
  { name: 'saldo: Einfuhrsteuer as a cost (6500 an 1020, IMPORT)', soll: '6500', haben: '1020', taxCode: 'IMPORT', base: '6500', counter: '1020', direction: 'input' },
  { name: 'saldo: Umsatzsteuer on a revenue (1100 an 3400, UST81)', soll: '1100', haben: '3400', taxCode: 'UST81', base: '3400', counter: '1100', direction: 'output' },
  { name: 'saldo: the unnatural side (1020 an 6500, VST-M)', soll: '1020', haben: '6500', taxCode: 'VST-M', base: '6500', counter: '1020', direction: 'input', mirrored: true },
];

function sweep(method, cases) {
  for (const c of cases) {
    test(`${method}: ${c.name}, every swept amount composes, posts and stores what buildVatLines stores`, () => {
      const w = world(method);
      for (const amountMinor of AMOUNTS) {
        const composed = composeSatz(
          { soll: w.byNumber(c.soll).id, haben: w.byNumber(c.haben).id, amountMinor, taxCode: c.taxCode, costCenter: '' },
          w.accountOf,
        );
        // The code rides the side the satz says it does, never both.
        assert.equal(composed.filter((l) => l.taxCode !== '').length, c.taxCode === '' ? 0 : 1);
        const answer = compose(w, composed);
        assert.deepEqual(answer.verdict, { ok: true }, `${c.name} @ ${amountMinor}: the engine refused ${JSON.stringify(answer)}`);
        const mine = post(w.ctx, answer.lines);
        assert.equal(mine.ok, true, `${c.name} @ ${amountMinor}: the engine refused its own composed lines ${JSON.stringify(mine)}`);

        const reference = referenceLines(w.ctx, {
          baseAccount: w.byNumber(c.base).id,
          counterAccount: w.byNumber(c.counter).id,
          amountMinor,
          taxCode: c.taxCode,
          direction: c.direction,
          mirrored: c.mirrored === true,
        });
        const theirs = post(w.ctx, reference);
        assert.equal(theirs.ok, true, `${c.name} @ ${amountMinor}: the buildVatLines reference did not post ${JSON.stringify(theirs)}`);
        assert.deepEqual(storedRows(w.ctx, mine.entryId), storedRows(w.ctx, theirs.entryId), `${c.name} @ ${amountMinor}`);
      }
    });
  }
}

sweep('effektiv', EFFEKTIV_CASES);
sweep('saldo', SALDO_CASES);

test('the trace rides the NET base line, the VAT leg is plain, the counter books the gross (107.70 VST-M)', () => {
  const w = world('effektiv');
  const composed = composeSatz({ soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: 10770, taxCode: 'VST-M', costCenter: '' }, w.accountOf);
  // What the Studio SENDS: intent only, no figure of its own.
  assert.deepEqual(composeLines(composed, true, DATE), [
    { account: w.byNumber('6500').id, side: 'debit', amount: 10770, gross: true, taxCode: 'VST-M', supplyDate: DATE },
    { account: w.byNumber('1020').id, side: 'credit', amount: 10770, gross: true },
  ]);
  const answer = compose(w, composed);
  assert.deepEqual(answer.lines, [
    { account: w.byNumber('6500').id, debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: DATE },
    { account: w.byNumber('1170').id, debit: 807 },
    { account: w.byNumber('1020').id, credit: 10770 },
  ]);
  assert.deepEqual(answer.captions[0], {
    ok: true, derived: true, kind: 'input', deductible: true, rateBp: 810, formLine: '400', net: 9963, tax: 807, gross: 10770,
    vatAccount: w.byNumber('1170').id, vatLegs: [{ account: w.byNumber('1170').id, debit: 807, credit: 0 }], folded: false, keepsOwnAccount: true,
  });
  assert.equal(answer.captions[1], null);
  assert.equal(post(w.ctx, answer.lines).ok, true);
});

test('the gross-split tax is stamped where net-forward would differ by a Rappen, and the engine answers it', () => {
  const w = world('effektiv');
  // Find a gross whose gross split differs from the net-forward figure on the same net: the case the
  // engine's hint exists for. Searched, not hand-picked, so the test cannot pass on a lucky constant.
  let found = null;
  for (let gross = 100; gross < 20000 && found === null; gross += 1) {
    const g = computeLineTax(w.ctx, { amountMinor: gross, amountIsGross: true, taxCode: 'VST-M', supplyDate: DATE });
    const n = computeLineTax(w.ctx, { amountMinor: g.netMinor, amountIsGross: false, taxCode: 'VST-M', supplyDate: DATE });
    if (g.taxMinor !== n.taxMinor) found = { gross, tax: g.taxMinor, net: g.netMinor };
  }
  assert.ok(found, 'no gross in range splits differently from its net-forward figure: the probe is measuring nothing');
  const composed = composeSatz({ soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: found.gross, taxCode: 'VST-M', costCenter: '' }, w.accountOf);
  const answer = compose(w, composed);
  assert.equal(answer.lines[0].taxAmount, found.tax);
  const r = post(w.ctx, answer.lines);
  assert.equal(r.ok, true, JSON.stringify(r));
  const base = getEntry(w.ctx, { entryId: r.entryId }).lines.find((l) => l.account === w.byNumber('6500').id);
  assert.equal(base.taxAmount, found.tax);
  assert.equal(base.taxBase, found.net);
  assert.equal(base.debit, found.net);
});

test('a cost centre rides the person\'s own account only, never the VAT leg or the counter', () => {
  const w = world('effektiv');
  const cc = createCostCenter(w.ctx, { code: 'K1', name: 'Vertrieb' });
  assert.equal(cc.ok, true);
  const composed = composeSatz({ soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: 10770, taxCode: 'VST-M', costCenter: cc.costCenterId }, w.accountOf);
  const r = post(w.ctx, compose(w, composed).lines);
  assert.equal(r.ok, true);
  const lines = getEntry(w.ctx, { entryId: r.entryId }).lines;
  const ccOf = (n) => lines.find((l) => l.account === w.byNumber(n).id).costCenter;
  assert.equal(ccOf('6500'), cc.costCenterId);
  assert.equal(ccOf('1170'), null);
  assert.equal(ccOf('1020'), null);
});

test('critic C2: a cost centre on a deductible Einfuhrsteuer line has no line to ride, so the engine refuses rather than drop it', () => {
  const w = world('effektiv');
  const composed = composeSatz({ soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: 5000, taxCode: 'IMPORT', costCenter: 'cc_x' }, w.accountOf);
  const refused = compose(w, composed);
  assert.equal(refused.composed, false);
  assert.equal(refused.verdict.error, 'cost_center_unplaced');
  assert.equal(refused.verdict.line, 0);
  assert.deepEqual(refused.lines, []);
  // Under saldo the assessed tax folds into the expense, so the same centre has its line and rides it.
  const s = world('saldo');
  const cc = createCostCenter(s.ctx, { code: 'K1', name: 'Vertrieb' });
  const saldoLines = composeSatz({ soll: s.byNumber('6500').id, haben: s.byNumber('1020').id, amountMinor: 5000, taxCode: 'IMPORT', costCenter: cc.costCenterId }, s.accountOf);
  const folded = compose(s, saldoLines);
  assert.deepEqual(folded.verdict, { ok: true });
  assert.equal(post(s.ctx, folded.lines).ok, true);
});

test('a satz with no MWST-bearing side carries no code and no cost centre, whatever the state held (1021 an 1020)', () => {
  const w = world('effektiv');
  w.store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('acc_x1021', ?, '1021', 'Sparkonto', 'asset')").run(w.workspaceId);
  const accounts = accountsOf(w.ctx);
  const accountOf = (id) => accounts.find((a) => a.id === id);
  const composed = composeSatz({ soll: 'acc_x1021', haben: w.byNumber('1020').id, amountMinor: 50000, taxCode: 'VST-M', costCenter: 'cc_stale' }, accountOf);
  assert.deepEqual(composed.map((l) => [l.taxCode, l.costCenter]), [['', ''], ['', '']]);
  const answer = compose(w, composed);
  assert.deepEqual(answer.verdict, { ok: true });
  assert.equal(post(w.ctx, answer.lines).ok, true);
});

test('Aufteilen: a Sammelbuchung over three taxed lines and an untaxed one posts, each leg as buildVatLines books it', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  const composed = [
    { accountId: id('6500'), side: 'debit', amountMinor: 10770, taxCode: 'VST-M', costCenter: '' },
    { accountId: id('1500'), side: 'debit', amountMinor: 216200, taxCode: 'VST-I', costCenter: '' },
    { accountId: id('6500'), side: 'debit', amountMinor: 5, taxCode: 'BEZUG', costCenter: '' },
    { accountId: id('6900'), side: 'debit', amountMinor: 1000, taxCode: '', costCenter: '' },
    { accountId: id('1020'), side: 'credit', amountMinor: 10770 + 216200 + 5 + 1000, taxCode: '', costCenter: '' },
  ];
  const answer = compose(w, composed);
  assert.deepEqual(answer.verdict, { ok: true }, JSON.stringify(answer));
  const r = post(w.ctx, answer.lines);
  assert.equal(r.ok, true, JSON.stringify(r));
  // The non-counter rows equal the union of each taxed line's own buildVatLines rows, counter excluded.
  const counter = id('1020');
  const expected = [];
  for (const line of composed.slice(0, 3)) {
    expected.push(...referenceLines(w.ctx, { baseAccount: line.accountId, counterAccount: counter, amountMinor: line.amountMinor, taxCode: line.taxCode, direction: 'input', mirrored: false }).filter((l) => l.account !== counter));
  }
  expected.push({ account: id('6900'), debit: 1000 });
  expected.push({ account: counter, credit: 10770 + 216200 + 5 + 1000 });
  const ref = post(w.ctx, expected);
  assert.equal(ref.ok, true, JSON.stringify(ref));
  assert.deepEqual(storedRows(w.ctx, r.entryId), storedRows(w.ctx, ref.entryId));
});

test('the manual path: a line on 1170 turns derivation off and the entry posts exactly as typed', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  const composed = [
    { accountId: id('6500'), side: 'debit', amountMinor: 9963, taxCode: 'VST-M', costCenter: '' },
    { accountId: id('1170'), side: 'debit', amountMinor: 807, taxCode: '', costCenter: '' },
    { accountId: id('1020'), side: 'credit', amountMinor: 10770, taxCode: '', costCenter: '' },
  ];
  // What the Studio sends on the manual path: plain lines as booked, no trace (the gate stamps it).
  assert.deepEqual(composeLines(composed, false, DATE), [
    { account: id('6500'), debit: 9963, taxCode: 'VST-M', supplyDate: DATE },
    { account: id('1170'), debit: 807 },
    { account: id('1020'), credit: 10770 },
  ]);
  const answer = compose(w, composed, false);
  assert.deepEqual(answer.lines, [
    { account: id('6500'), debit: 9963, taxCode: 'VST-M', supplyDate: DATE, taxBase: 9963, taxAmount: 807 },
    { account: id('1170'), debit: 807 },
    { account: id('1020'), credit: 10770 },
  ]);
  // The manual caption is the net-forward readout of the booked amount.
  assert.equal(answer.captions[0].derived, false);
  assert.deepEqual([answer.captions[0].net, answer.captions[0].tax, answer.captions[0].gross], [9963, 807, 10770]);
  assert.equal(post(w.ctx, answer.lines).ok, true);
  // M5: the import code on the 1170 line itself, the Einfuhrsteuer path the grid keeps.
  const imp = [
    { accountId: id('1170'), side: 'debit', amountMinor: 4321, taxCode: 'IMPORT', costCenter: '' },
    { accountId: id('1020'), side: 'credit', amountMinor: 4321, taxCode: '', costCenter: '' },
  ];
  assert.equal(post(w.ctx, compose(w, imp, false).lines).ok, true);
});

test('the engine refuses rather than guesses: an unknown code, a chart missing its VAT account', () => {
  const w = world('effektiv');
  const composed = composeSatz({ soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: 10770, taxCode: 'NOPE', costCenter: '' }, w.accountOf);
  const unknown = compose(w, composed);
  assert.equal(unknown.composed, false);
  assert.equal(unknown.verdict.error, 'unknown_tax_code');
  assert.equal(unknown.verdict.line, 0);
  assert.equal(unknown.captions[0].error, 'unknown_tax_code', 'the line carries its own refusal for the control beside it');
  // The same booking with the 1170 account gone from the chart: named, never booked elsewhere.
  w.store.db.prepare("DELETE FROM account WHERE workspace_id = ? AND number = '1170'").run(w.workspaceId);
  const ok = composeSatz({ soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: 10770, taxCode: 'VST-M', costCenter: '' }, w.accountOf);
  const missing = compose(w, ok);
  assert.equal(missing.verdict.error, 'vat_account_missing');
  assert.equal(missing.verdict.number, '1170');
});

test('C8: isTaxBearing is Erfolgskonto OR an asset 1200 to 1299 or 1400 to 1799 (Vorräte, Anlagevermögen), never a VAT account', () => {
  const w = world('effektiv');
  const bearing = (n) => composer.isTaxBearing(w.byNumber(n));
  // 1200 Vorräte takes MWST since the owner widened the range to 12xx (04.10.2026).
  for (const n of ['3400', '3200', '6500', '6800', '1200', '1500', '1510', '1520', '1530']) assert.equal(bearing(n), true, n);
  // Never: liquid funds, receivables, the VAT accounts, and 1300 Aktive Rechnungsabgrenzung (accruals and
  // adjusting entries, where a code would invite a second Vorsteuer claim; owner, 04.10.2026).
  for (const n of ['1000', '1020', '1060', '1100', '1170', '1171', '1300', '2000', '2200', '2800']) assert.equal(bearing(n), false, n);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1300', type: 'asset', vatCodeDefault: 'VST-M' }), false);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1399', type: 'asset' }), false);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1400', type: 'asset' }), true);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1199', type: 'asset' }), false);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1299', type: 'asset' }), true);
  // Never a VAT or a bank account: the shipped chart's only row the widening added is 1200 Vorräte, an asset,
  // so the range reaches no VAT account (1170/1171/2200 sit outside it), no liquid funds (10xx, where a bank's
  // ledger account sits) and not 1300 Rechnungsabgrenzung.
  assert.deepEqual(w.accounts.filter((a) => composer.isVatAssetAccount(a) && /^1[23]\d{2}$/.test(a.number)).map((a) => `${a.number}:${a.type}`), ['1200:asset']);
  for (const n of [...composer.VAT_ACCOUNT_NUMBERS, '1000', '1020', '1100', '1300']) assert.equal(composer.isVatAssetAccount({ number: n, type: 'asset' }), false, n);
  // The range is the chart's, and the type must say asset: a 16xx or 17xx asset qualifies, an 18xx does not.
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1600', type: 'asset' }), true);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1799', type: 'asset' }), true);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1800', type: 'asset' }), false);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1400', type: 'liability' }), false);
  // A Bankkonto's own ledger account never qualifies, even inside the range (critic L2): a custom chart may
  // link a Bankkonto to 1500. `markBankLedgers` marks it off a `list_bank_accounts` answer.
  const ledgers = composer.bankLedgerIdsOf({ ok: true, bankAccounts: [{ ledgerAccountId: w.byNumber('1500').id }, { ledgerAccountId: null }] });
  assert.deepEqual([...ledgers], [w.byNumber('1500').id]);
  const marked = composer.markBankLedgers([w.byNumber('1500'), w.byNumber('1510')], ledgers);
  assert.equal(composer.isTaxBearing(marked[0]), false);
  assert.equal(composer.isTaxBearing(marked[1]), true);
  assert.equal(composer.isTaxBearing({ id: 'x', number: '6500', type: 'expense', bankLedger: true }), false);
  assert.equal(composer.bankLedgerIdsOf({ ok: false, error: 'permission_denied' }).size, 0);
  // A default code is a pre-fill, never a reason to qualify.
  assert.equal(composer.isTaxBearing({ id: 'x', number: '1060', type: 'asset', vatCodeDefault: 'VST-M' }), false);
});

test('C8: 1500 an 1020, 10\'810.00, VST-I posts 1500 10\'000.00, 1171 810.00, 1020 10\'810.00, the trace on 1500', () => {
  const w = world('effektiv');
  w.store.db.prepare("UPDATE account SET vat_code_default = NULL WHERE workspace_id = ? AND number = '1500'").run(w.workspaceId);
  const composed = composeSatz({ soll: w.byNumber('1500').id, haben: w.byNumber('1020').id, amountMinor: 1081000, taxCode: 'VST-I', costCenter: '' }, w.accountOf);
  const r = post(w.ctx, compose(w, composed).lines);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = getEntry(w.ctx, { entryId: r.entryId }).lines.map((l) => [w.accountOf(l.account).number, l.debit, l.credit, l.taxCode, l.taxBase, l.taxAmount]);
  assert.deepEqual(rows, [
    ['1500', 1000000, 0, 'VST-I', 1000000, 81000],
    ['1171', 81000, 0, null, null, null],
    ['1020', 0, 1081000, null, null, null],
  ]);
});

test('C10: a straddle draft (supply 15.12.2023, entry 10.01.2024) reopens at its stored Leistungsdatum and posts with the 7.7% figures and the old Ziffer', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  const ENTRY = '2024-01-10';
  const SUPPLY = '2023-12-15';
  // The December supply, invoiced in January: UST81 at the 7.7% era on a gross of 107.70.
  const stored = [
    { account: id('1100'), debit: 10770 },
    { account: id('3400'), credit: 10000, taxCode: 'UST81', taxBase: 10000, taxAmount: 770, supplyDate: SUPPLY },
    { account: id('2200'), credit: 770 },
  ];
  // Saved through the product's own door (save_draft), the way an agent or the Studio leaves it.
  const draft = saveDraft(w.ctx, { date: ENTRY, lines: stored, idempotencyKey: 'straddle' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const read = getEntry(w.ctx, { entryId: draft.entryId }).lines;
  assert.equal(read.find((l) => l.taxCode === 'UST81').supplyDate, SUPPLY, 'get_entry reports the stored Leistungsdatum');
  assert.equal(read.find((l) => l.taxCode === null).supplyDate, null);

  const d = reopen(w, draft.entryId);
  assert.equal(d.roundTrips, true, 'priced at its own era, the draft decomposes and re-expands to exactly its stored lines');
  assert.ok(d.satz);
  assert.equal(d.satz.supplyDate, SUPPLY);
  const again = composeSatz(d.satz, w.accountOf);
  const answer = compose(w, again, true, ENTRY, draft.entryId);
  assert.deepEqual(answer.lines.find((l) => l.taxCode === 'UST81'), { account: id('3400'), credit: 10000, taxCode: 'UST81', taxBase: 10000, taxAmount: 770, supplyDate: SUPPLY });

  const r = postEntry(w.ctx, { entryId: draft.entryId, date: ENTRY, source: 'manual', idempotencyKey: 'straddle-post', lines: answer.lines });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = w.store.db.prepare("SELECT supply_date, tax_base_minor, tax_amount_minor FROM journal_line WHERE entry_id = ? AND tax_code = 'UST81'").get(r.entryId);
  assert.deepEqual(row, { supply_date: SUPPLY, tax_base_minor: 10000, tax_amount_minor: 770 });
  // The Ziffer vintage follows the stored supply date: 302 (the 7.7% family), not the 2024 303.
  assert.equal(computeLineTax(w.ctx, { amountMinor: 10000, amountIsGross: false, taxCode: 'UST81', supplyDate: row.supply_date }).formLine, '302');
  assert.equal(computeLineTax(w.ctx, { amountMinor: 10000, amountIsGross: false, taxCode: 'UST81', supplyDate: ENTRY }).formLine, '303');

  // The bite: priced at the ENTRY date instead, the same satz composes to 8.07 and is not the draft.
  const atEntry = composeSatz({ ...d.satz, supplyDate: '' }, w.accountOf);
  const wrong = compose(w, atEntry, true, ENTRY);
  assert.notDeepEqual(wrong.lines.find((l) => l.taxCode === 'UST81').taxAmount, 770);
});

test('critic C3: the request names everything it was composed for, and any difference is a different request', () => {
  const w = world('effektiv');
  const base = { soll: w.byNumber('6500').id, haben: w.byNumber('1020').id, amountMinor: 10770, taxCode: 'VST-M', costCenter: '' };
  const sig = (satz, date = DATE) => JSON.stringify(composeLines(composeSatz(satz, w.accountOf), true, date));
  const at = sig(base);
  assert.equal(sig({ ...base }), at);
  assert.notEqual(sig(base, '2023-06-30'), at, 'the date');
  for (const change of [{ taxCode: 'VST-I' }, { amountMinor: 10771 }, { supplyDate: '2023-06-30' }, { haben: w.byNumber('1000').id }]) {
    assert.notEqual(sig({ ...base, ...change }), at, JSON.stringify(change));
  }
});

test('reopening: an A1 draft decomposes to its Buchungssatz, and the satz re-composes to exactly the stored lines', () => {
  const w = world('effektiv');
  for (const [soll, haben, code] of [['6500', '1020', 'VST-M'], ['1100', '3400', 'UST81'], ['6500', '1020', 'BEZUG'], ['6500', '1020', ''], ['1020', '6500', 'VST-M']]) {
    const composed = composeSatz({ soll: w.byNumber(soll).id, haben: w.byNumber(haben).id, amountMinor: 10770, taxCode: code, costCenter: '' }, w.accountOf);
    seq += 1;
    const draft = saveDraft(w.ctx, { date: DATE, lines: compose(w, composed).lines, idempotencyKey: `draft-${seq}` });
    assert.equal(draft.ok, true);
    const d = reopen(w, draft.entryId);
    assert.equal(d.roundTrips, true, `${soll} an ${haben} ${code}`);
    assert.ok(d.satz, `${soll} an ${haben} ${code}: not a satz`);
    assert.deepEqual([d.satz.soll, d.satz.haben, d.satz.amountMinor, d.satz.taxCode], [w.byNumber(soll).id, w.byNumber(haben).id, 10770, code]);
    const again = compose(w, composeSatz(d.satz, w.accountOf), true, DATE, draft.entryId);
    const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
    const sig = (l) => [l.account, l.debit || 0, l.credit || 0, l.taxCode ?? null, l.taxBase ?? null, l.taxAmount ?? null, l.costCenter ?? null].join('|');
    assert.deepEqual(again.lines.map(sig).sort(), stored.map(sig).sort(), `${soll} an ${haben} ${code}`);
    // And it promotes with the lines it stored.
    seq += 1;
    assert.equal(postEntry(w.ctx, { entryId: draft.entryId, date: DATE, source: 'manual', idempotencyKey: `promote-${seq}`, lines: again.lines }).ok, true);
  }
});

test('reopening: a pre-A1 draft typed net-forward (6500 net, 1170 tax, 1020 gross) decomposes and round-trips', () => {
  // A net-forward tax is always the gross split of net + tax (the split lands between the exact figure
  // and its rounding), so every such old draft is the A1 derivation of its gross. Swept rather than
  // asserted: the claim is what makes it safe to show an old draft as a satz. The old draft carries no
  // trace, so it is the gross the engine recovers, and the pairing that is checked, not a stored hint.
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  for (let n = 1; n < 40000; n += 37) {
    const f = computeLineTax(w.ctx, { amountMinor: n, amountIsGross: false, taxCode: 'VST-M', supplyDate: DATE });
    const old = [{ account: id('6500'), debit: n, taxCode: 'VST-M', taxBase: n, taxAmount: f.taxMinor }, { account: id('1020'), credit: n + f.taxMinor }];
    if (f.taxMinor > 0) old.splice(1, 0, { account: id('1170'), debit: f.taxMinor });
    seq += 1;
    const draft = saveDraft(w.ctx, { date: DATE, lines: old, idempotencyKey: `old-${seq}` });
    const d = reopen(w, draft.entryId);
    assert.equal(d.roundTrips, true, `net ${n}`);
    assert.ok(d.satz, `net ${n}: an old three-line draft is a satz`);
    assert.equal(d.satz.amountMinor, n + f.taxMinor);
  }
});

test('reopening: a draft that is not a satz opens on the manual path VERBATIM and posts as stored', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  // Paid half from the bank and half from the till: two counters, so no Buchungssatz can say it.
  const old = [
    { account: id('6500'), debit: 9963, taxCode: 'VST-M' },
    { account: id('1170'), debit: 807 },
    { account: id('1020'), credit: 5000 },
    { account: id('1000'), credit: 5770 },
  ];
  const draft = saveDraft(w.ctx, { date: DATE, lines: old, idempotencyKey: 'two-counters' });
  assert.equal(draft.ok, true);
  const d = reopen(w, draft.entryId);
  assert.equal(d.satz, null);
  // No trace was stored, so the expansion (which stamps one) is not the stored lines: verbatim it is.
  assert.equal(d.roundTrips, false);
  const answer = composeEntry(w.ctx, { mode: 'expand', date: DATE, entryId: draft.entryId, lines: d.lines });
  assert.deepEqual(answer.verdict, { ok: true });
  assert.equal(postEntry(w.ctx, { entryId: draft.entryId, date: DATE, source: 'manual', idempotencyKey: 'two-counters-promote', lines: answer.lines }).ok, true);
});

test('critic C4: a coded line with no VAT leg is NOT a satz, and the engine reads it as net, never as gross', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  // An agent's two-line Vorschlag: 1100 an 3400 100.00 UST81, no 2200 leg.
  const stored = [
    { account: id('1100'), debit: 10000 },
    { account: id('3400'), credit: 10000, taxCode: 'UST81' },
  ];
  const draft = saveDraft(w.ctx, { date: DATE, lines: stored, idempotencyKey: 'agent-vorschlag' });
  assert.equal(draft.ok, true);
  const d = reopen(w, draft.entryId);
  // Read as gross it would be 3400 92.51 + 2200 7.49, read as net it needs a 2200 leg the draft lacks:
  // neither reproduces it, so the engine pairs nothing and it is not a satz.
  assert.equal(d.roundTrips, false);
  assert.equal(d.satz, null);
  // On the manual path the lines go back verbatim, and the engine reads the tagged 100.00 as the NET base:
  // it expects 8.10 on 2200 and refuses, rather than any figure being re-priced in the Studio.
  const answer = composeEntry(w.ctx, { mode: 'expand', date: DATE, entryId: draft.entryId, lines: d.lines });
  assert.equal(answer.verdict.error, 'vat_trace_unreconciled');
  assert.equal(answer.verdict.expectedMinor, 810);
  const r = postEntry(w.ctx, { entryId: draft.entryId, date: DATE, source: 'manual', idempotencyKey: 'agent-promote', lines: answer.lines });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vat_trace_unreconciled');
  assert.equal(r.expectedMinor, 810);
});

// Critic M1, rebuilt: an unchanged reopened Aufteilen draft re-composes to its stored gross-split trace and
// posts, because the ENGINE recovers the gross from the stored trace and expands it again; the Studio holds
// no trace at all. The reopen runs through the Studio's own `gridLineFromCompose` / `gridComposed`.
const MODEL = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href;
const { gridLineFromCompose, effectiveLines, gridComposed, editGridLine } = await import(MODEL);

/** The grid's composed lines for these grid lines, without the React key. */
const composedOf = (gridLines) => gridComposed(effectiveLines(gridLines)).map(({ key: _key, ...l }) => l);

test('critic M1: an unchanged reopened Aufteilen draft re-composes to its stored gross-split trace and posts', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  // The Aufteilen draft the critic found: 6500 VST-M at a gross of 1.00 splits 0.93 + 0.07, where
  // net-forward on 0.93 is 0.08. Saved derived, exactly as the Studio saves it.
  const typed = [
    { accountId: id('6500'), side: 'debit', amountMinor: 100, taxCode: 'VST-M', costCenter: '' },
    { accountId: id('6570'), side: 'debit', amountMinor: 1000, taxCode: '', costCenter: '' },
    { accountId: id('1020'), side: 'credit', amountMinor: 1100, taxCode: '', costCenter: '' },
  ];
  const draft = saveDraft(w.ctx, { date: DATE, lines: compose(w, typed).lines, idempotencyKey: 'm1-draft' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
  const base = stored.find((l) => l.taxCode === 'VST-M');
  assert.deepEqual([base.debit, base.taxBase, base.taxAmount], [93, 93, 7], 'fixture sanity: the gross-split trace is stored');
  assert.equal(computeLineTax(w.ctx, { amountMinor: 93, amountIsGross: false, taxCode: 'VST-M', supplyDate: DATE }).taxMinor, 8, 'and net-forward differs');

  const d = reopen(w, draft.entryId);
  assert.equal(d.roundTrips, true);
  assert.equal(d.satz, null, 'three lines: the derived grid, not a satz');
  const grid = d.intent.map((l) => gridLineFromCompose(l, d.date, false));
  assert.deepEqual(grid.map((l) => [l.debit, l.credit, l.taxCode]), [['1.00', '', 'VST-M'], ['10.00', '', ''], ['', '11.00', '']]);
  const answer = compose(w, composedOf(grid), true, DATE, draft.entryId);
  assert.deepEqual(answer.lines.find((l) => l.taxCode === 'VST-M'), { account: id('6500'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7, supplyDate: DATE });
  const posted = postEntry(w.ctx, { entryId: draft.entryId, date: DATE, source: 'manual', idempotencyKey: 'm1-post', lines: answer.lines });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const row = w.store.db.prepare("SELECT tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? AND tax_code = 'VST-M'").get(draft.entryId);
  assert.deepEqual(row, { tax_base_minor: 93, tax_amount_minor: 7, supply_date: DATE }, 'the posted trace IS the stored one');
});

test('the manual verbatim path: an untouched stored line is sent exactly as stored, an edited one exactly as shown', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n).id;
  // Two hint-traced VST-M lines whose legs an agent merged into ONE 1170 line: no pairing can say it, so
  // it does not round-trip and reopens verbatim. Each line's 0.07 is its gross-split hint; net-forward on
  // 0.93 is 0.08, so only the stored hints reconcile with the 0.14 leg.
  const old = [
    { account: id('6500'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7 },
    { account: id('6570'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7 },
    { account: id('1170'), debit: 14 },
    { account: id('1020'), credit: 200 },
  ];
  const draft = saveDraft(w.ctx, { date: DATE, lines: old, idempotencyKey: 'merged-leg' });
  const d = reopen(w, draft.entryId);
  assert.equal(d.roundTrips, false);
  const grid = d.lines.map((l) => gridLineFromCompose(l, d.date, true));
  const verbatim = compose(w, composedOf(grid), false, DATE, draft.entryId);
  assert.deepEqual(verbatim.verdict, { ok: true }, JSON.stringify(verbatim));
  // Edit the first line's amount and back: the row is now what is ON SCREEN, so the gate prices it
  // net-forward (0.08) and the merged 0.14 leg no longer reconciles. The engine says so; the Studio
  // does not re-derive anything to hide it.
  const edited = grid.map((l, i) => (i === 0 ? editGridLine(l, { debit: '0.93' }) : l));
  assert.equal(edited[0].verbatim, null);
  const refused = compose(w, composedOf(edited), false, DATE, draft.entryId);
  assert.equal(refused.verdict.error, 'vat_trace_unreconciled');
});
