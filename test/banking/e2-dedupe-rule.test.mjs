// D178 point 19 (owner, 21.10.2026; spec A20 §11.4): the possible-duplicate rule itself
// (`statementDedupe.ts`), without a store. Under `ask` (the default) nothing across formats is dropped;
// under `auto_strong` only the bank's own reference on the same booking date with the same money drops a
// line, and two DIFFERENT bank references never do (critic R2-2). A candidate needs the same money, a
// counterparty that does not contradict (the IBAN when both carry one, else a shared name word, else money
// and date alone) and a date within three days, the minimum over both dates of each side (critic L1). Every
// candidate is named, the nearest first, and naming never uses a stored line up (critic R2-6). The cost is
// near-linear in the lines on both sides (critic M5).
//
// SYNTHETIC DATA ONLY: every line is invented here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideLines, nameTokens, NEAR_DAYS, ABSORB_BOOKING_DAYS, MAX_CANDIDATES } from '../../dist/core/banking/statementDedupe.js';

const DAY0 = Math.round(Date.parse('2026-10-01T00:00:00Z') / 86_400_000);
const iso = (day) => new Date((DAY0 + day) * 86_400_000).toISOString().slice(0, 10);

function stored(id, { family = 'camt', b = 0, v = b, money = 'DBIT|450|CHF', bankRef = null, iban = null, name = null, order = 0 } = {}) {
  return {
    id,
    order,
    family,
    bookingDay: b === null ? null : DAY0 + b,
    valueDay: v === null ? null : DAY0 + v,
    bookingDate: b === null ? null : iso(b),
    valueDate: v === null ? null : iso(v),
    money,
    bankRef,
    iban,
    names: nameTokens(name),
  };
}
function incoming(index, { b = 0, v = b, money = 'DBIT|450|CHF', bankRef = null, iban = null, name = null } = {}) {
  return { index, bookingDay: b === null ? null : DAY0 + b, valueDay: v === null ? null : DAY0 + v, money, bankRef, iban, names: nameTokens(name) };
}
const decide = (family, s, i, extra = {}) => decideLines({ family, mode: 'ask', stored: s, incoming: i, exactClaimed: new Set(), ...extra });
const first = (d) => (d?.kind === 'flag' ? d.candidates[0] : undefined);

test('the windows: a bank reference proves on the same booking date (auto_strong); a candidate lies within three days; at most ten are named', () => {
  assert.equal(ABSORB_BOOKING_DAYS, 0);
  assert.equal(NEAR_DAYS, 3);
  assert.equal(MAX_CANDIDATES, 10);
});

test('ask (the default): nothing across formats is dropped, even the bank reference on the same day is flagged', () => {
  const out = decide('mt940', [stored('c1', { bankRef: 'R1' })], [incoming(0, { bankRef: 'R1' })]);
  assert.deepEqual(out.get(0), { kind: 'flag', candidates: [{ bankTxnId: 'c1', reason: 'shared_reference' }] });
});

test('auto_strong: only the bank reference with the same money on the same booking date drops; two different bank references never do (R2-2)', () => {
  const strong = { mode: 'auto_strong' };
  assert.deepEqual(decide('mt940', [stored('c1', { bankRef: 'R1' })], [incoming(0, { bankRef: 'R1' })], strong).get(0), { kind: 'absorb', existingBankTxnId: 'c1' });
  assert.equal(decide('mt940', [stored('c1', { bankRef: 'R1' })], [incoming(0, { b: 1, bankRef: 'R1' })], strong).get(0).kind, 'flag', 'a day apart is asked');
  assert.equal(decide('mt940', [stored('c1', { bankRef: 'R1' })], [incoming(0, { b: null, v: 0, bankRef: 'R1' })], strong).get(0).kind, 'flag', 'no booking date: asked');
  const other = decide('mt940', [stored('c1', { bankRef: 'R1' })], [incoming(0, { bankRef: 'R2' })], strong).get(0);
  assert.deepEqual(other, { kind: 'flag', candidates: [{ bankTxnId: 'c1', reason: 'same_date' }] }, 'another bank reference: asked, never dropped');
  assert.equal(decide('csv', [stored('c1', { bankRef: 'R1' })], [incoming(0)], strong).get(0).kind, 'flag', 'a CSV is never dropped across formats');
  // One stored line drops one line of an import; a second line with the same reference is asked.
  const twice = decide('mt940', [stored('c1', { bankRef: 'R1' })], [incoming(0, { bankRef: 'R1' }), incoming(1, { bankRef: 'R1' })], strong);
  assert.equal(twice.get(0).kind, 'absorb');
  assert.equal(twice.get(1).kind, 'flag');
});

test('the counterparty: equal IBANs or a shared name word make a candidate; different ones do not; a side that names nobody leaves money and date to decide', () => {
  const IBAN_A = 'CH9300762011623852957';
  const IBAN_B = 'CH5604835012345678009';
  assert.equal(decide('csv', [stored('c1', { iban: IBAN_A })], [incoming(0, { iban: IBAN_A })]).get(0)?.kind, 'flag');
  assert.equal(decide('csv', [stored('c1', { iban: IBAN_A })], [incoming(0, { iban: IBAN_B })]).get(0), undefined, 'two IBANs: two payments');
  assert.equal(decide('csv', [stored('c1', { name: 'Telekom Beispiel AG' })], [incoming(0, { name: 'TELEKOM BEISPIEL' })]).get(0)?.kind, 'flag');
  assert.equal(decide('csv', [stored('c1', { name: 'Kundin Anna Ammann' })], [incoming(0, { name: 'AMMANN ANNA' })]).get(0)?.kind, 'flag');
  assert.equal(decide('csv', [stored('c1', { name: 'Papeterie Lindenhof AG' })], [incoming(0, { name: 'Druckerei Seeblick GmbH' })]).get(0), undefined, 'two names: two payments');
  assert.equal(decide('csv', [stored('c1', { name: 'Papeterie Lindenhof AG' })], [incoming(0)]).get(0)?.kind, 'flag', 'a CSV without a counterparty');
  assert.equal(decide('csv', [stored('c1', { iban: IBAN_A })], [incoming(0, { name: 'Papeterie Lindenhof' })]).get(0)?.kind, 'flag', 'an IBAN on one side, a name on the other: no contradiction');
  // The bank's own reference names the line whatever the names say.
  assert.equal(first(decide('mt940', [stored('c1', { bankRef: 'R1', name: 'Papeterie' })], [incoming(0, { bankRef: 'R1', name: 'Druckerei' })]).get(0)).reason, 'shared_reference');
});

test('the distance is the minimum over both dates of each side (critic L1), and the reason says how near', () => {
  // camt: booked Monday (day 4), bought Thursday (day 0); a CSV carries only the purchase day.
  assert.equal(first(decide('csv', [stored('c1', { b: 4, v: 0 })], [incoming(0, { b: 0, v: null })]).get(0)).reason, 'same_date');
  assert.equal(first(decide('csv', [stored('c1', { b: 2 })], [incoming(0, { b: 0 })]).get(0)).reason, 'near_date');
  assert.equal(decide('csv', [stored('c1', { b: 8, v: 8 })], [incoming(0, { b: 4, v: null })]).get(0), undefined, 'four days is outside the window');
});

test('same format: point 19 never compares a delivery with lines of its own format; coverage decides those (D178 re-cut)', () => {
  // A delivery of the same format is either an EXTENSION (its lines are new) or an OVERLAP, matched one to one
  // on the movement key by statementCoverage.ts. The cross-format rule never second-guesses either.
  for (const family of ['csv', 'mt940', 'camt']) {
    const out = decide(family, [stored('s1', { family, b: 2 })], [incoming(0, { b: 2 })]);
    assert.equal(out.get(0), undefined, `${family} against ${family}: not point 19's question`);
  }
  assert.equal(decide('csv', [stored('c1', { b: 2 })], [incoming(0, { b: 2 })]).get(0)?.kind, 'flag', 'across formats it still asks');
});

test('naming never uses a stored line up (critic R2-6): every new line names every candidate, the nearest first', () => {
  // One stored coffee, three new ones the same day: all three name it.
  const out = decide('csv', [stored('c1')], [incoming(0), incoming(1), incoming(2)]);
  for (const i of [0, 1, 2]) assert.equal(first(out.get(i)).bankTxnId, 'c1');
  // A daily coffee: Thursday's names Wednesday first, then Tuesday and Monday; nothing is consumed for later.
  const week = [stored('mo', { b: 0, order: 0 }), stored('tu', { b: 1, order: 1 }), stored('we', { b: 2, order: 2 })];
  const thu = decide('csv', week, [incoming(0, { b: 3 })]).get(0);
  assert.deepEqual(thu.candidates.map((c) => [c.bankTxnId, c.reason]), [['we', 'near_date'], ['tu', 'near_date'], ['mo', 'near_date']]);
  const wed = decide('csv', week, [incoming(0, { b: 3 }), incoming(1, { b: 2 })]).get(1);
  assert.equal(first(wed).bankTxnId, 'we', "Wednesday's row still names Wednesday's line");
  // At most ten, the nearest.
  const many = Array.from({ length: 30 }, (_, i) => stored(`s${i}`, { b: i % 4, order: i }));
  const capped = decide('csv', many, [incoming(0, { b: 0 })]).get(0);
  assert.equal(capped.candidates.length, MAX_CANDIDATES);
  assert.deepEqual(capped.candidates.map((c) => c.reason), [...Array(8).fill('same_date'), 'near_date', 'near_date'], 'the eight same-day lines first, then the nearest');
});

test('near-linear: 40 000 new lines against 40 000 stored, distinct amounts and all one amount, each well under the bound', () => {
  const N = 40_000;
  const distinct = Array.from({ length: N }, (_, i) => stored(`s${i}`, { b: i % 10, money: `CRDT|${100 + i}|CHF`, bankRef: `R${i}`, order: i }));
  const inDistinct = Array.from({ length: N }, (_, i) => incoming(i, { b: i % 10, money: `CRDT|${100 + i}|CHF`, bankRef: `Q${i}` }));
  let t0 = Date.now();
  const a = decide('mt940', distinct, inDistinct);
  const msDistinct = Date.now() - t0;
  assert.equal(a.size, N, 'every line names its look-alike');
  const same = Array.from({ length: N }, (_, i) => stored(`s${i}`, { order: i }));
  const inSame = Array.from({ length: N }, (_, i) => incoming(i));
  t0 = Date.now();
  const b = decide('mt940', same, inSame);
  const msSame = Date.now() - t0;
  assert.ok([...b.values()].every((d) => d.candidates.length === MAX_CANDIDATES));
  assert.ok(msDistinct < 5000 && msSame < 5000, `distinct ${msDistinct} ms, identical ${msSame} ms`);
});
