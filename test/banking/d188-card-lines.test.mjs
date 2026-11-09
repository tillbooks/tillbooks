// D188 (A39 §21): card-line rules. A debit-card purchase and a bank fee arrive with no counterparty name and
// no IBAN; the counterparty is DERIVED from the booking text (the merchant after the masked card number, the
// account's own bank for a fee), read wherever the counterparty is read (the rule rung, history, the miner,
// the backtest, the booking's rule check, autobook, the inbox). Beside it: the draft-time screen of
// set_bank_standard, the vendor prefix match of the Beleg-Abgleich, the exchange read from an older line's
// text, and the VAT note on an untaxed booking.
//
// SYNTHETIC BY CONSTRUCTION: every text below is invented in the SHAPE of a Swiss debit-card statement (a
// masked card number, a merchant, a ZIP or shop number, a foreign amount and a rate); every merchant,
// amount, rate, date and IBAN is made up here (the bank account is the published sample IBAN of
// bank-inbox-support.mjs). Every line is invented for this file.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard, prevalidateSetBankStandard, readLiveRule } from '../../dist/core/banking/bankStandards.js';
import { backtestRule, mineRules } from '../../dist/core/banking/ruleMiner.js';
import { lineCounterpartyOf } from '../../dist/core/banking/bankProposals.js';
import { cardKeyOf, cardMerchantOf, feePatternsOf, matchesFeeText } from '../../dist/core/banking/derivedCounterparty.js';
import { BANK_FEE_TEXTS_DEFAULT } from '../../dist/core/banking/feeTexts.js';
import { corroboratedTextFx, readLineFactsMap } from '../../dist/core/banking/statementFacts.js';
import { autobookEligibility } from '../../dist/core/banking/autobook.js';
import { evidenceContext, evidenceForBooking } from '../../dist/core/banking/belegEvidence.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { approveDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { getAction } from '../../dist/api/registry.js';
import { listNotes, setNote } from '../../dist/core/hausbuch/notes.js';
import { handleRest } from '../../dist/api/rest.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { world, importLines, must, refused, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { receipt, confirmedReceipt } from './a41-beleg-support.mjs';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';

afterEach(assertClaimInvariantHolds);

// --- Invented texts in the shape of a Swiss debit-card statement ---------------------------------------
const CARD = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711';
const RENDER = `${CARD}, RENDER.COM 94107`;
const MONGO = `${CARD}, MONGODBCLOUD, USD 8.71, Kurs 0.812345`;
const SHOP = `${CARD}, SHOPIFY* 527600011`;
const OLD_FX = `${CARD}, WOLKENDIENST, USD 19.54, Kurs 0.836233`;
const MAINT = 'Account maintenance';
const CARD_FEE = 'Fee for Beispielbank Visa Debit Card no. xxxx 4711';
const EFV = 'Eidgenössische Finanzverwaltung';
const EFV_IBAN = 'CH4431999123000889012';

let n = 0;
/** One statement of lines with NO counterparty (only a text), unless `name`/`iban` is given. */
function stmt(t, specs) {
  n += 1;
  const dates = specs.map((s) => s.date).sort();
  const res = importLines(t, {
    statementId: `D188-${n}`,
    seqNb: String(n),
    from: dates[0],
    to: dates[dates.length - 1],
    entries: specs.map((s, i) => ({ ref: `D${n}L${i + 1}`, cd: s.cd ?? 'DBIT', amountMinor: s.amount, date: s.date, ustrd: s.text, ...(s.name ? { name: s.name } : {}), ...(s.iban ? { iban: s.iban } : {}) })),
  });
  return specs.map((_, i) => res.lines[`D${n}L${i + 1}`]);
}

const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];
const keyOf = (t, id) => lineCounterpartyOf(t.ctx, readBankTxn(t.ctx, id), readBankTxnDetail(t.ctx, id))?.key ?? null;
const book = (t, id, number, amount) =>
  must(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc(number), amountMinor: amount }] }, idempotencyKey: `bk-${id}` }));
const runAs = (t, actor) => (verb, input) => getAction(verb).run({ ...t.deps, actor }, input);

// ================================================================================================
// 1. The derivation, pure
// ================================================================================================

test('cardMerchantOf: the segment after the masked card number, up to the next comma, verbatim: no token removed', () => {
  assert.equal(cardMerchantOf(RENDER), 'RENDER.COM 94107');
  assert.equal(cardMerchantOf(MONGO), 'MONGODBCLOUD');
  assert.equal(cardMerchantOf(SHOP), 'SHOPIFY* 527600011', 'the reference after a star is kept: it tells shops apart');
  assert.equal(cardMerchantOf('Kauf/Dienstleistung vom 03.07.2026 Karten Nr. XXXX1234, MIGROS BEISPIELDORF 8000'), 'MIGROS BEISPIELDORF 8000');
  assert.equal(cardMerchantOf('Mastercard 5412XXXXXXXX9876 GOOGLE*CLOUD 4455'), 'GOOGLE*CLOUD 4455');
  assert.equal(cardMerchantOf(`${CARD}, PAYPAL *NETFLIX 4029357733`), 'PAYPAL *NETFLIX 4029357733');
  assert.notEqual(cardMerchantOf(`${CARD}, PAYPAL *NETFLIX`), cardMerchantOf(`${CARD}, PAYPAL *SPOTIFY`));
  // The owner's shapes: the postcode stays in the key (zero removal), so one merchant at one address is one key.
  assert.deepEqual([cardKeyOf(cardMerchantOf(RENDER)), cardKeyOf(cardMerchantOf(MONGO))], ['render com 94107', 'mongodbcloud']);
});

test('cardMerchantOf: NO KEY rather than a guess: no card word, no masked number, a card FEE, a date or amount first, digits only', () => {
  assert.equal(cardMerchantOf('Zahlung Referenz xxxx 1234, MUSTER AG'), null, 'a masked number without a card word is a reference');
  assert.equal(cardMerchantOf('Visa Debit Gutschrift MUSTER AG'), null, 'a card word without a masked number has no anchor');
  assert.equal(cardMerchantOf(CARD_FEE), null, 'the card fee names the card and nothing after it');
  assert.equal(cardMerchantOf(`${CARD}, USD 12.00, 01.07.2026, Kurs 0.9`), null, 'an amount in the merchant place: no key, never the next segment');
  assert.equal(cardMerchantOf('Debitkarte ****1234, 12.07.2026 14:02, BÄCKEREI MUSTER'), null, 'a date in the merchant place: no key, never the next segment');
  assert.equal(cardMerchantOf(`${CARD}, 94107 12345`), null);
  assert.equal(cardMerchantOf(null), null);
  assert.equal(cardMerchantOf(''), null);
  assert.equal(cardMerchantOf(`${CARD}, X 12`), null, 'one letter is no name');
  // A sender's free text cannot make the reader backtrack: long mask-like runs answer at once.
  const started = Date.now();
  for (const evil of ['x'.repeat(480) + '!', 'Visa ' + 'xx '.repeat(160) + '1', 'card ' + '*'.repeat(490), 'Visa 4567' + 'X'.repeat(480) + '12']) cardMerchantOf(evil);
  for (const evil of ['Fee for ' + 'a'.repeat(450) + ' Visa Debit Card no. xxxx 1234!', 'Fee for ' + 'x '.repeat(200)]) matchesFeeText(evil, feePatternsOf(BANK_FEE_TEXTS_DEFAULT));
  assert.ok(Date.now() - started < 300, `took ${Date.now() - started} ms`);
});

/**
 * THE PROPERTY (critic r2, the closed-world re-cut): different businesses never share a key. Each row is a
 * set of merchant segments that are DIFFERENT businesses, in the shapes that merged in rounds 1 and 2
 * (digit names, other scripts, currency-code words, clause words, chain branches, facilitators, legal forms,
 * towns). Splitting is allowed (and counted), a merge is the one failure.
 */
const DIFFERENT_BUSINESSES = [
  // r1: digit names and scripts
  ['Ladenkette-1234 Beispielstadt', 'Tankstelle-5678 Beispielstadt', 'Beispielstadt'],
  ['1PASSWORTDIENST BEISPIELSTADT', '24STUNDENSHOP BEISPIELSTADT', 'PASSWORTDIENST BEISPIELSTADT'],
  ['Καφενείο Ήλιος ATHINA', 'Ταβέρνα Θάλασσα ATHINA', 'ATHINA'],
  ['Кофейня Север', 'Пекарня Север'],
  ['喫茶 山田', '書店 山田'],
  ['مطعم البحر', 'مخبز البحر'],
  // r2: currency-code words, at either end
  ['TOP PIZZA BEISPIELSTADT', 'MAD PIZZA BEISPIELSTADT', 'ALL PIZZA BEISPIELSTADT', 'PIZZA BEISPIELSTADT'],
  ['CAFE BOB', 'CAFE TOP', 'CAFE'],
  ['CUP CAKE', 'TRY CAKE', 'CAKE'],
  ['USD RENDER', 'RENDER'],
  ['EUR TRANS LOGISTIK', 'TRANS LOGISTIK'],
  ['CHF MOBIL', 'MOBIL'],
  // r2: clause words as names
  ['RATE MY PLATE', 'MY PLATE', 'PLATE'],
  ['FEE FIGHTERS', 'FIGHTERS'],
  ['KURS AG', 'AG KURS', 'KURSWERK'],
  ['SETTLED COFFEE', 'COFFEE'],
  ['KOMMISSION VERLAG', 'VERLAG'],
  // chain branches and towns
  ['MIGROS BEISPIELSTADT', 'MIGROS MUSTERDORF', 'COOP BEISPIELSTADT'],
  ['Tankstelle 9012 Beispielstadt', 'Tankstelle 1111 Musterdorf'],
  ['BAECKEREI MUSTER', 'BÄCKEREI MUSTER', 'BACKEREI MUSTER'],
  ['MÜLLER AG', 'MUELLER AG', 'MULLER AG'],
  ['Café Zentral', 'Cafe Zentral'],
  // facilitators
  ['PAYPAL *NETFLIX', 'PAYPAL *SPOTIFY', 'PAYPAL *AB12CD', 'PAYPAL *XY34ZZ', 'PAYPAL NETFLIX SPOTIFY'],
  ['SQ *COFFEEBAR', 'SQ *TEABAR'],
  ['SUMUP *VELOWERK', 'SUMUP *SKIWERK'],
  ['SHOPIFY* 527600011', 'SHOPIFY* 527600022', 'SHOPIFY'],
  ['GOOGLE*CLOUD', 'GOOGLE*YOUTUBE'],
  ['AMZN Mktp DE*2K3L45', 'AMZN Mktp DE*9Z8Y77'],
  // legal forms and short words are names too
  ['MUSTER AG', 'MUSTER GMBH', 'MUSTER'],
  ['AB DRUCK', 'DRUCK'],
  ['THE SHOP', 'SHOP'],
  // digits inside and at the start
  ['7-ELEVEN', '7-TWELVE'],
  ['3M SCHWEIZ', '4M SCHWEIZ'],
  ['A1 TELEKOM', 'A2 TELEKOM'],
  ['24/7 SHOP', 'SHOP 24 7'],
  // punctuation is folded, never letters
  ['RENDER.COM', 'RENDERCOM'],
  ['O’NEILL BAR', 'ONEILL BAR'],
  ['DR. MED. MUSTER', 'DR MED MUSTERMANN'],
  // a generic name plus a postcode or number: never one key (the zero-removal rule)
  ['HOTEL 2000', 'HOTEL'],
  ['HOTEL 4051', 'HOTEL 8001', 'HOTEL 3000 BERN'],
  ['GARAGE 12', 'GARAGE 13'],
  ['ZÜRI-BEIZ', 'ZÜRIBEIZ'],
];

test('[PROPERTY, critic r1+r2] across ~40 sets of different businesses, no two share a key (split or no key, never a merge)', () => {
  const key = (s) => {
    const m = cardMerchantOf(`${CARD}, ${s}`);
    return m === null ? null : cardKeyOf(m);
  };
  let keyed = 0;
  for (const set of DIFFERENT_BUSINESSES) {
    const keys = set.map(key);
    const given = keys.filter((k) => k !== null);
    keyed += given.length;
    assert.equal(new Set(given).size, given.length, `merged: ${JSON.stringify(Object.fromEntries(set.map((s, i) => [s, keys[i]])))}`);
  }
  // Across sets too: no key of one row equals a key of another row (rows are different businesses as well,
  // except the deliberately shared words such as a bare town, which each row keys only once).
  const owner = new Map();
  for (const [row, set] of DIFFERENT_BUSINESSES.entries()) {
    for (const s of set) {
      const k = key(s);
      if (k === null) continue;
      const seen = owner.get(k);
      if (seen !== undefined && seen.text !== s) assert.fail(`"${s}" (row ${row}) and "${seen.text}" (row ${seen.row}) share ${k}`);
      owner.set(k, { row, text: s });
    }
  }
  assert.ok(keyed >= 90, `the probe keys most of its rows (${keyed}), so it is not vacuous`);
});

test('the closed rule keeps no heuristic: what is no key, and what is one name written two ways', () => {
  const key = (s) => {
    const m = cardMerchantOf(`${CARD}, ${s}`);
    return m === null ? null : cardKeyOf(m);
  };
  for (const s of ['PAYPAL *', 'ABC*', '1234 BEISPIELSTADT', 'X 12', '4455', '', 'USD 19.54', '01.07.2026']) assert.equal(key(s), null, s);
  // Only what is the SAME text after the fold is one key: punctuation, width, a ligature, a trailing number.
  assert.equal(key('RENDER.COM 94107'), key('RENDER-COM 94107'));
  assert.equal(key('ＲＥＮＤＥＲ'), key('RENDER'));
  assert.equal(key('ﬁnca'), key('finca'));
  assert.notEqual(key('RENDER.COM 94107'), key('RENDER.COM 10001'), 'no token is removed, a postcode neither');
  assert.equal(key('HOTEL 4051'), 'hotel 4051');
  // A reference after a star is never removed.
  assert.notEqual(key('PAYPAL *123456'), key('PAYPAL *654321'));
  assert.equal(key('PAYPAL *123456'), 'paypal 123456');
});

test('[critic r1 L-a, r2 F1] the fee key is a CLOSED list of whole texts: a phrase, a suffix or a bare Visa is no fee', () => {
  const t = world();
  const [parking, price, charges, concert, visa, gift, juli, account, cardFee, kontof] = stmt(t, [
    { text: 'Fee for parking Beispielhof', amount: 800, date: '2026-07-02' },
    { text: 'Preis für Zahlung Muster', amount: 300, date: '2026-07-02' },
    { text: 'Charges for courier Beispiel', amount: 1500, date: '2026-07-02' },
    { text: 'Preis für Konzertkarte Tonhalle', amount: 12000, date: '2026-07-02' },
    { text: 'Fee for visa application', amount: 9000, date: '2026-07-02' },
    { text: 'Gebühr für Tageskarte', amount: 1400, date: '2026-07-02' },
    { text: 'Kontoführung Juli', amount: 200, date: '2026-07-03' },
    { text: MAINT, amount: 500, date: '2026-07-03' },
    { text: CARD_FEE, amount: 300, date: '2026-07-03' },
    { text: 'Kontoführung', amount: 200, date: '2026-07-03' },
  ]);
  for (const id of [parking, price, charges, concert, visa, gift, juli]) assert.equal(keyOf(t, id), null, id);
  for (const id of [account, cardFee, kontof]) assert.equal(keyOf(t, id), 'bank:00762', id);
});

test('fee patterns: anchored at both ends, both umlaut spellings, a final full stop; <card> is required where it stands', () => {
  const p = feePatternsOf(BANK_FEE_TEXTS_DEFAULT);
  for (const text of [MAINT, 'ACCOUNT MAINTENANCE.', CARD_FEE, 'Fee for ZKB Visa Debit Card no. xxxx 5870', 'Kontoführung', 'Kontoführung'.replace('ü', 'ue') /* the two-letter spelling a bank text may use */, 'Gebühr für ZKB Debitkarte Nr. XXXX1234', 'Frais de tenue de compte']) {
    assert.equal(matchesFeeText(text, p), true, text);
  }
  for (const text of ['Account maintenances', 'Rückerstattung Kontoführung', 'Kontoführung Juli', 'Fee for ZKB Visa Debit Card', 'Fee for ZKB Visa Debit Card no. 1234', 'Fee for ZKB, Muster Visa Debit Card no. xxxx 5870', '']) {
    assert.equal(matchesFeeText(text, p), false, text);
  }
  assert.equal(matchesFeeText(MAINT, feePatternsOf('')), false, 'an empty setting is no fee list');
});

// ================================================================================================
// 2. The acceptance run: rules, the miner, the backtest, bulk, receipts, older facts, VAT
// ================================================================================================

test('[ACCEPTANCE] card and fee lines: the miner offers a rule after three bookings; the rule backtests OK and books the next line sure and in bulk', () => {
  const t = world();
  const [r1, r2, r3, m1, f1, f2, efv] = stmt(t, [
    { text: RENDER, amount: 1900, date: '2026-07-02' },
    { text: RENDER, amount: 1900, date: '2026-07-05' },
    { text: RENDER, amount: 2100, date: '2026-07-09' },
    { text: MONGO, amount: 716, date: '2026-07-10' },
    { text: MAINT, amount: 500, date: '2026-07-11' },
    { text: CARD_FEE, amount: 300, date: '2026-07-11' },
    { text: 'Rückerstattung MWST', amount: 12345, date: '2026-07-12', cd: 'CRDT', name: EFV, iban: EFV_IBAN },
  ]);
  // The keys: the merchant, the own bank (the sample IBAN's institution id), the real counterparty untouched.
  assert.equal(keyOf(t, r1), 'card:render com 94107');
  assert.equal(keyOf(t, m1), 'card:mongodbcloud');
  assert.equal(keyOf(t, f1), 'bank:00762');
  assert.equal(keyOf(t, f2), 'bank:00762', 'both fee texts are the same bank');
  assert.equal(keyOf(t, efv), `iban:${EFV_IBAN}`);
  // The inbox shows the derived counterparty BESIDE what the bank stated (nothing), never in its place.
  const shown = lineOf(t, r1);
  assert.deepEqual(shown.counterparty, { name: null, iban: null });
  assert.deepEqual(shown.derivedCounterparty, { kind: 'card', label: 'RENDER.COM 94107' });
  assert.deepEqual(lineOf(t, f1).derivedCounterparty, { kind: 'bank_fee', label: 'Geschäftskonto' });
  assert.equal(lineOf(t, efv).derivedCounterparty, null);

  // History learns: after one booking the next Render line proposes it (learned).
  book(t, r1, '6570', 1900);
  assert.equal(lineOf(t, r2).proposal.reasonCode, 'history');
  book(t, r2, '6570', 1900);
  book(t, r3, '6570', 2100);

  // The miner groups the three by the derived key and offers ONE rule.
  const mined = must(mineRules(t.ctx));
  const g = mined.groups.find((x) => x.counterpartyKey === 'card:render com 94107');
  assert.ok(g, JSON.stringify(mined.groups));
  assert.deepEqual([g.repeats, g.outcome, g.direction], [3, 'drafted', 'out']);
  const row = t.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(g.actionId);
  assert.equal(JSON.parse(row.payload_json).label, 'RENDER.COM 94107', 'the Vorschlag names the merchant');

  // A fourth Render line: the backtest of a rule saved from it is OK (no `no_counterparty`).
  const [r4] = stmt(t, [{ text: RENDER, amount: 2300, date: '2026-07-16' }]);
  const bt = must(backtestRule(t.ctx, { recipe: { bankTxnId: r4, accountId: t.acc('6570') }, since: '2026-07-01' }));
  assert.deepEqual([bt.counterpartyKey, bt.hits, bt.identical, bt.openLines], ['card:render com 94107', 3, 3, 1]);

  // The person approves the mined rule; the next line proposes `sure` (Regel) and is bulk-bookable.
  const approved = approveDraftedAction(t.ctx, runAs(t, 'user_1'), { actionId: g.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const next = lineOf(t, r4);
  assert.deepEqual([next.proposal.reasonCode, next.proposal.certainty, next.bulkBookable], ['standard', 'sure', true]);
  const rule = readLiveRule(t.ctx, next.proposal.reasonParams.standardId);
  assert.deepEqual([rule.counterparty_key, rule.counterparty_label], ['card:render com 94107', 'RENDER.COM 94107']);
  // Booking it through the rule passes the booking's own counterparty check.
  must(bookBankLine(t.ctx, { bankTxnId: r4, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: 'r4-rule' }));

  // The fee lines: one rule from one fee line books the other fee text too.
  must(setBankStandard(t.ctx, { bankTxnId: f1, accountId: t.acc('6900'), taxCode: null, idempotencyKey: 'fee-rule' }));
  assert.deepEqual([lineOf(t, f2).proposal.reasonCode, lineOf(t, f2).proposal.certainty], ['standard', 'sure']);
});

test('[ACCEPTANCE] receipts: a MongoDB receipt is a candidate (prefix), an older line without facts compares its USD receipt, and the VAT on an untaxed booking is noted', () => {
  const t = world();
  const [m1, old] = stmt(t, [
    { text: MONGO, amount: 716, date: '2026-07-10' },
    { text: OLD_FX, amount: 1660, date: '2026-07-12' },
  ]);
  // An older line: imported before D178 facts (no fact row at all).
  t.store.db.prepare('DELETE FROM bank_txn_fact WHERE workspace_id = ? AND bank_txn_id = ?').run(t.workspaceId, old);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_fact WHERE bank_txn_id = ?').get(old).n, 0);

  const mongo = receipt(t, { amount: 871, currency: 'USD', vendor: 'MongoDB Limited', date: '2026-07-09', vat: 65 });
  const cloud = receipt(t, { amount: 1954, currency: 'USD', vendor: 'Wolkendienst Inc.', date: '2026-07-11' });

  const mLine = lineOf(t, m1);
  assert.equal(mLine.belegCandidates.length, 1, JSON.stringify(mLine.belegCandidates));
  assert.deepEqual(mLine.belegCandidates[0].files.map((f) => f.fileId), [mongo.fileId]);
  assert.deepEqual(mLine.belegCandidates[0].match.counterparty, 'name_prefix');
  assert.equal(mLine.belegCandidates[0].match.amount, 'transaction_currency');

  // The older line reads its USD amount and rate from the text (read-only, `fromText`).
  const facts = readLineFactsMap(t.ctx, [old]).get(old);
  assert.deepEqual([facts.instructed, facts.exchange.rate, facts.fromText], [{ amountMinor: 1954, currency: 'USD' }, '0.836233', true]);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_fact WHERE bank_txn_id = ?').get(old).n, 0, 'nothing is written');
  const oLine = lineOf(t, old);
  assert.deepEqual(oLine.belegCandidates.map((g) => [g.files[0].fileId, g.match.amount, g.match.counterparty]), [[cloud.fileId, 'transaction_currency', 'name']]);
  // The engine's evidence judges the attached USD receipt as fitting (no `beleg_amount_differs`).
  const ec = evidenceContext(t.ctx);
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 1660 }] };
  const ev = evidenceForBooking(t.ctx, ec, readBankTxn(t.ctx, old), readBankTxnDetail(t.ctx, old), facts, target, [{ fileId: cloud.fileId }]);
  assert.equal(ev.belege[0].amountAgrees, true);
  assert.ok(!ev.reasons.includes('beleg_amount_differs'), ev.reasons.join());

  // The MongoDB receipt states USD 0.65 VAT; the CHF booking taxes no leg: a NOTE with the figure, never check.
  const mt = { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 716 }] };
  const mFacts = readLineFactsMap(t.ctx, [m1]).get(m1);
  const vev = evidenceForBooking(t.ctx, ec, readBankTxn(t.ctx, m1), readBankTxnDetail(t.ctx, m1), mFacts, mt, [{ fileId: mongo.fileId }]);
  assert.ok(vev.reasons.includes('vat_not_booked'), vev.reasons.join());
  assert.deepEqual([vev.vat.belegMinor, vev.vat.computedMinor, vev.vat.currency, vev.vat.untaxed], [65, 0, 'USD', true]);
  assert.equal(vev.certainty, 'check', 'no engine proposal on a first line: check by that reason, not by the VAT');
  assert.ok(!vev.reasons.includes('vat_differs'));
});

// ================================================================================================
// 3. The draft-time screen, the settings, autobook
// ================================================================================================

test('set_bank_standard refuses at DRAFT time exactly what the approval would refuse; a card line now drafts', () => {
  const t = world();
  const [card, nobody] = stmt(t, [
    { text: RENDER, amount: 1900, date: '2026-07-02' },
    { text: 'Zahlung gemäss Auftrag', amount: 4000, date: '2026-07-03' },
  ]);
  // Direct, engine-level: the screen answers the save's own refusal.
  refused(prevalidateSetBankStandard(t.ctx, { bankTxnId: nobody, accountId: t.acc('6570'), idempotencyKey: 'p1' }) ?? { ok: true }, 'no_counterparty');
  refused(prevalidateSetBankStandard(t.ctx, { bankTxnId: card, accountId: 'acc_nowhere', idempotencyKey: 'p2' }) ?? { ok: true }, 'not_found');
  assert.equal(prevalidateSetBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6570'), matchText: 'render', idempotencyKey: 'p3' }), undefined);
  // The dry run wrote nothing.
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard WHERE workspace_id = ?').get(t.workspaceId).n, 0);
  // Through the agent seat: the refusal comes back undrafted; the card line drafts.
  const agent = (bankTxnId, key) => handleRest('set_bank_standard', { workspaceId: t.workspaceId, bankTxnId, accountId: t.acc('6570'), matchText: 'render', idempotencyKey: key, agentReason: 'immer gleich' }, { ...t.deps, actor: 'agent' }).body;
  const bad = agent(nobody, 'ag-1');
  assert.equal(bad.drafted, undefined, JSON.stringify(bad).slice(0, 300));
  assert.match(JSON.stringify(bad), /no_counterparty/);
  const good = agent(card, 'ag-2');
  assert.equal(good.drafted, true, JSON.stringify(good).slice(0, 300));
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = 'set_bank_standard'").get(t.workspaceId).n, 1);
});

test('bank.derive_counterparty off: only what the bank stated counts; a rule saved under a derived key goes silent', () => {
  const t = world();
  const [a, b] = stmt(t, [
    { text: RENDER, amount: 1900, date: '2026-07-02' },
    { text: RENDER, amount: 1900, date: '2026-07-05' },
  ]);
  must(setBankStandard(t.ctx, { bankTxnId: a, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'r' }));
  assert.equal(lineOf(t, b).proposal.reasonCode, 'standard');
  must(settingsSet(t.ctx, { key: 'bank.derive_counterparty', value: 'off', reason: 'D188 test', idempotencyKey: 'off' }));
  assert.equal(keyOf(t, b), null);
  assert.equal(lineOf(t, b).derivedCounterparty, null);
  assert.notEqual(lineOf(t, b).proposal.reasonCode, 'standard');
  refused(setBankStandard(t.ctx, { bankTxnId: b, accountId: t.acc('6570'), idempotencyKey: 'r2' }), 'no_counterparty');
});

test('bank.fee_texts is the fee list: extended, a new wording is the bank; emptied, only the bank code remains', () => {
  const t = world();
  const [x] = stmt(t, [{ text: 'Monatspauschale Privatkonto Plus', amount: 900, date: '2026-07-02' }]);
  assert.equal(keyOf(t, x), null);
  must(settingsSet(t.ctx, { key: 'bank.fee_texts', value: `${BANK_FEE_TEXTS_DEFAULT}; Monatspauschale Privatkonto Plus`, reason: 'D188 test', idempotencyKey: 'ft' }));
  assert.equal(keyOf(t, x), 'bank:00762');
  must(settingsSet(t.ctx, { key: 'bank.fee_texts', value: '', reason: 'D188 test', idempotencyKey: 'ft0' }));
  assert.equal(keyOf(t, x), null);
});

test('the own bank: a Swiss IBAN keys by its institution id; a known institution reads by its short name', () => {
  const t = world();
  // A second Bankkonto on an invented account number at institution 00700 (check digits computed here).
  const bban = '00700' + '110009876543';
  const numeric = [...`${bban}CH00`].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join('');
  const check = String(98n - (BigInt(numeric) % 97n)).padStart(2, '0');
  const iban = `CH${check}${bban}`;
  const acc = must(createBankAccount(t.ctx, { name: 'Zweitkonto', iban, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'zk' }), 'second account');
  const res = importLines(t, { statementId: 'D188-ZK', iban, entries: [{ ref: 'ZK1', cd: 'DBIT', amountMinor: 500, date: '2026-07-04', ustrd: MAINT }] }, { bankAccountId: acc.bankAccountId });
  const id = res.lines.ZK1;
  assert.equal(keyOf(t, id), 'bank:00700');
  assert.deepEqual(lineOf(t, id).derivedCounterparty, { kind: 'bank_fee', label: 'ZKB' });
});

test('autobook: a derived key books unattended only as rules.autobook_derived_keys allows (default all, the owner\'s pick; bank_fees; off)', () => {
  const t = world();
  const [card, fee] = stmt(t, [
    { text: RENDER, amount: 1900, date: '2026-07-02' },
    { text: MAINT, amount: 500, date: '2026-07-03' },
  ]);
  const cardRule = readLiveRule(t.ctx, must(setBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'c' })).standard.id);
  const feeRule = readLiveRule(t.ctx, must(setBankStandard(t.ctx, { bankTxnId: fee, accountId: t.acc('6900'), taxCode: null, idempotencyKey: 'f' })).standard.id);
  // The default, `all` (owner, 09.11.2026): both may, after a grant.
  assert.deepEqual(autobookEligibility(t.ctx, cardRule), { eligible: true, kind: 'complete' });
  assert.deepEqual(autobookEligibility(t.ctx, feeRule), { eligible: true, kind: 'complete' });
  // `bank_fees`: the own bank's fee rule may, the card merchant's may not.
  must(settingsSet(t.ctx, { key: 'rules.autobook_derived_keys', value: 'bank_fees', reason: 'D188 test', idempotencyKey: 'b' }));
  assert.deepEqual(autobookEligibility(t.ctx, cardRule), { eligible: false, reason: 'derived_key' });
  assert.deepEqual(autobookEligibility(t.ctx, feeRule), { eligible: true, kind: 'complete' });
  // `off`: neither.
  must(settingsSet(t.ctx, { key: 'rules.autobook_derived_keys', value: 'off', reason: 'D188 test', idempotencyKey: 'o' }));
  assert.deepEqual(autobookEligibility(t.ctx, cardRule), { eligible: false, reason: 'derived_key' });
  assert.deepEqual(autobookEligibility(t.ctx, feeRule), { eligible: false, reason: 'derived_key' });
  // A NAME key stays out whatever the setting says (`name_key`, N04 unchanged).
  must(settingsSet(t.ctx, { key: 'rules.autobook_derived_keys', value: 'all', reason: 'D188 test', idempotencyKey: 'a' }));
  const [named] = stmt(t, [{ text: 'Rechnung Juli', amount: 3000, date: '2026-07-04', name: 'Muster Beispiel AG' }]);
  const nameRule = readLiveRule(t.ctx, must(setBankStandard(t.ctx, { bankTxnId: named, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'n' })).standard.id);
  assert.deepEqual(autobookEligibility(t.ctx, nameRule), { eligible: false, reason: 'name_key' });
});

// ================================================================================================
// 4. The vendor match and the text FX: false-positive probes
// ================================================================================================

test('vendor prefix: FALSE-POSITIVE PROBES: common words, short words, the card prefix, the remittance', () => {
  const t = world();
  const [swisscom, visaLine, plain, dbline] = stmt(t, [
    { text: `${CARD}, SWISSCOMSHOP 3050`, amount: 4990, date: '2026-07-10' },
    { text: `${CARD}, BEISPIEL KIOSK`, amount: 1200, date: '2026-07-11' },
    { text: 'Rechnung MONGODBCLOUD Juli', amount: 716, date: '2026-07-12', name: 'Datenhalle Beispiel AG', iban: EFV_IBAN },
    { text: `${CARD}, DBXPRESS 77`, amount: 3300, date: '2026-07-13' },
  ]);
  receipt(t, { amount: 4990, currency: 'CHF', vendor: 'Swiss Post', date: '2026-07-10' });
  // A receipt from the card network or the card's bank never fits every card line by the card prefix.
  receipt(t, { amount: 1200, currency: 'CHF', vendor: 'Visa Beispielbank', date: '2026-07-11' });
  // A prefix is read against the counterparty only, never the remittance of a named line.
  receipt(t, { amount: 716, currency: 'CHF', vendor: 'MongoDB Limited', date: '2026-07-12' });
  // Two letters ("DB") never prefix-match.
  receipt(t, { amount: 3300, currency: 'CHF', vendor: 'DB Schenker', date: '2026-07-13' });
  for (const id of [swisscom, visaLine, plain, dbline]) assert.deepEqual(lineOf(t, id).belegCandidates, [], id);
});

test('vendor prefix: the ENGINE never pairs on a prefix match by default (suggest); engine allows it; off is whole words only', () => {
  const t = world();
  const [m1, r1] = stmt(t, [
    { text: `${CARD}, MONGODBCLOUD`, amount: 716, date: '2026-07-10' },
    { text: RENDER, amount: 1900, date: '2026-07-11' },
  ]);
  const active = (line) => t.store.db.prepare("SELECT source FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ? AND state = 'active'").get(t.workspaceId, line);
  confirmedReceipt(t, { amount: 716, currency: 'CHF', vendor: 'MongoDB Limited', date: '2026-07-10' });
  // The control: a whole-word match ("Render") with confirmed figures IS paired by the engine.
  confirmedReceipt(t, { amount: 1900, currency: 'CHF', vendor: 'Render Services, Inc.', date: '2026-07-11' });
  assert.equal(lineOf(t, m1).belegCandidates[0].match.counterparty, 'name_prefix');
  assert.equal(lineOf(t, r1).belegCandidates[0].match.counterparty, 'name');
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(active(r1)?.source, 'engine_unique', 'the whole-word control pairs');
  assert.equal(active(m1), undefined, 'a prefix-only match waits for a person under the default');
  must(settingsSet(t.ctx, { key: 'belege.match_vendor_prefix', value: 'engine', reason: 'D188 test', idempotencyKey: 'vpe' }));
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(active(m1)?.source, 'engine_unique', 'engine: the prefix match may pair unattended');
  must(settingsSet(t.ctx, { key: 'belege.match_vendor_prefix', value: 'off', reason: 'D188 test', idempotencyKey: 'vpo' }));
  const [m2] = stmt(t, [{ text: `${CARD}, MONGODBCLOUD`, amount: 722, date: '2026-07-14' }]);
  receipt(t, { amount: 722, currency: 'CHF', vendor: 'MongoDB Limited', date: '2026-07-14' });
  assert.deepEqual(lineOf(t, m2).belegCandidates, [], 'off: whole words only');
});

test('corroboratedTextFx: answers only when the arithmetic agrees; one amount, one rate', () => {
  const line = { amountMinor: 1660, currency: 'CHF' };
  assert.deepEqual(corroboratedTextFx('X, USD 19.54, Kurs 0.836233', line)?.instructed, { amountMinor: 1954, currency: 'USD' });
  // A rate that does not produce the booked amount is no exchange.
  assert.equal(corroboratedTextFx('X, USD 19.54, Kurs 0.5', line), null);
  // Two foreign amounts, or two rates: ambiguous.
  assert.equal(corroboratedTextFx('X, USD 19.54, EUR 17.00, Kurs 0.836233', line), null);
  assert.equal(corroboratedTextFx('X, USD 19.54, Kurs 0.836233, rate 0.84', line), null);
  // A number that is no currency (a ZIP after a town code) is no money.
  assert.equal(corroboratedTextFx('ZUG 6300, Kurs 0.836233', line), null);
  // No rate at all: nothing.
  assert.equal(corroboratedTextFx('X, USD 19.54', line), null);
});

// ================================================================================================
// 5. Critic r1 L-c: the Hausbuch reads a line's counterparty through the one reader
// ================================================================================================

test('[critic r1 L-c] a house note on a derived counterparty: written by its key, found by the line', () => {
  const t = world();
  const [render, other] = stmt(t, [
    { text: RENDER, amount: 1900, date: '2026-07-02' },
    { text: `${CARD}, Ladenkette-1234 Beispielstadt`, amount: 4210, date: '2026-07-03' },
  ]);
  const written = must(setNote(t.ctx, { text: 'Hosting: immer 6570, ohne MWST', scope: { kind: 'counterparty', ref: 'card:RENDER.COM 94107' }, idempotencyKey: 'note-r' }));
  assert.equal(written.note.scope.ref, 'card:render com 94107', 'the ref is keyed exactly as lineCounterpartyOf keys the line');
  const found = must(listNotes(t.ctx, { counterparty: { bankTxnId: render } })).notes.map((x) => x.text);
  assert.deepEqual(found, ['Hosting: immer 6570, ohne MWST']);
  assert.deepEqual(must(listNotes(t.ctx, { counterparty: { bankTxnId: other } })).notes, [], 'another merchant has no note');
  assert.deepEqual(must(listNotes(t.ctx, { counterparty: { bankTxnId: 'btx_nowhere' } })).notes, []);
  const fee = must(setNote(t.ctx, { text: 'Spesen', scope: { kind: 'counterparty', ref: 'bank:00762' }, idempotencyKey: 'note-f' }));
  assert.equal(fee.note.scope.ref, 'bank:00762');
});
