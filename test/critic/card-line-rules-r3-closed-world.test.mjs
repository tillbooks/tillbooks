// Critic r3 on D188 (A39 §21.1, the closed-world re-cut): attacks on the card key and the fee key.
//
// SYNTHETIC BY CONSTRUCTION: every text, merchant, town, bank name, amount and date is invented here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cardMerchantOf, cardKeyOf, feePatternsOf, matchesFeeText } from '../../dist/core/banking/derivedCounterparty.js';
import { BANK_FEE_TEXTS_DEFAULT } from '../../dist/core/banking/feeTexts.js';

const CARD = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711';
const key = (s) => {
  const m = cardMerchantOf(`${CARD}, ${s}`);
  return m === null ? null : cardKeyOf(m);
};
function assertNoMerge(texts) {
  const keys = texts.map(key);
  const given = keys.filter((k) => k !== null);
  assert.equal(new Set(given).size, given.length, `merged: ${JSON.stringify(Object.fromEntries(texts.map((t, i) => [t, keys[i]])))}`);
}

test('[HELD] case and Unicode edges split, never merge: ß/ss, Turkish i, Greek final sigma, marks, zero-width joiners', () => {
  assertNoMerge(['STRASSE BAR', 'STRAßE BAR']);
  assertNoMerge(['İSTANBUL GRILL', 'ISTANBUL GRILL', 'ıSTANBUL GRILL']);
  assertNoMerge(['ΟΔΟΣ ΚΑΦΕ', 'οδοσ καφε']);
  assertNoMerge(['Café', 'Cafe', 'Cafè']);
  assertNoMerge(['AB SHOP', 'A‌B SHOP']);
  assertNoMerge(['A.B SHOP', 'AB SHOP']);
  assertNoMerge(['SHOP 1', 'SHOP 2', 'SHOP']);
});

test('[HELD, benign] what the fold does merge is one name written two ways: punctuation runs, width, compatibility forms', () => {
  assert.equal(key('A.B SHOP'), key('A-B SHOP'));
  assert.equal(key('SHOP  BAR'), key('SHOP BAR'));
  assert.equal(key('SHOP １'), key('SHOP 1'));
  assert.equal(key('ﬀ SHOP'), key('ff SHOP'));
});

test('[HELD] the segment ends at the first comma; an FX clause after it never enters the key, and an amount or date in the merchant place is no key', () => {
  assert.equal(key('RENDER.COM 94107, USD 19.54, Kurs 0.836233'), key('RENDER.COM 94107, USD 22.10, Kurs 0.841000'));
  for (const s of ['USD 19.54, RENDER.COM', '01.07.2026, RENDER.COM', '12.07.2026 14:02, BAECKEREI', '4711 BEISPIELSTADT', 'PAYPAL *', '']) assert.equal(key(s), null, s);
});

test('[HELD] fee key: the closed list matches WHOLE texts only; <bank> takes no comma and at most 40 characters', () => {
  const P = feePatternsOf(BANK_FEE_TEXTS_DEFAULT);
  for (const t of ['Account maintenance', 'account  MAINTENANCE.', 'Kontoführung', 'Kontofuehrung', 'Fee for Beispielbank Visa Debit Card no. xxxx 4711', 'Gebuehr fuer Beispielbank Debitkarte Nr. XXXX1234']) {
    assert.equal(matchesFeeText(t, P), true, t);
  }
  for (const t of [
    'Kontoführung Juli',
    'Account maintenance refund',
    'Fee for Beispielbank Visa Debit Card no. xxxx 4711, RENDER.COM',
    'Fee for, Beispielbank Visa Debit Card no. xxxx 4711',
    `Fee for ${'B'.repeat(41)} Visa Debit Card no. xxxx 4711`,
    'Fee for Beispielbank Visa Debit Card no. 4711',
    `${CARD}, Account maintenance`,
    'Preis für Konzertkarte Tonhalle',
    'Gebühr für Tageskarte',
  ]) {
    assert.equal(matchesFeeText(t, P), false, t);
  }
  // A user pattern's regex metacharacters are literal.
  assert.equal(matchesFeeText('Spesen xx', feePatternsOf('Spesen (.*)')), false);
  assert.equal(matchesFeeText('Spesen (.*)', feePatternsOf('Spesen (.*)')), true);
  const started = Date.now();
  for (let i = 0; i < 200; i++) matchesFeeText(`Fee for ${'a '.repeat(240)}`, P);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test('[HELD] one chokepoint: only lineCounterpartyOf derives; the hausbuch scope folds with the same cardKeyOf', () => {
  const roots = ['src', 'app/src'];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'node_modules') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        const src = readFileSync(p, 'utf8');
        for (const sym of ['derivedCounterpartyOf(', 'cardMerchantOf(', 'cardKeyOf(', 'matchesFeeText(', 'feePatternsOf(']) {
          if (src.includes(sym) && !p.endsWith('derivedCounterparty.ts')) hits.push(`${p}:${sym}`);
        }
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(hits.sort(), ['src/core/banking/bankProposals.ts:derivedCounterpartyOf(', 'src/core/hausbuch/notes.ts:cardKeyOf(']);
});
