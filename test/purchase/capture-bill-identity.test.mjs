/**
 * A31, WHICH BILL a QR code states (`qrbill/identity.ts`, critic R6-M1, owner rule "corrections belong to
 * their bill"): the self-attack the coordinator asked for before the critic sees it.
 *
 * "The same bill" is decided by what the bill SAYS (IBAN, creditor, amount or open, currency, reference
 * type and reference, normalised), never by its raw text and never by which evidence row came last. The
 * same bill never touches a correction; a different winning bill discards it as history. Synthetic
 * payloads only: SIX's published sample IBAN and SIX IG v2.3 Annex A example 2, invented creditors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { billIdentity } from '../../dist/core/purchase/qrbill/identity.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

function lines({ name = 'Beispiel Druckerei GmbH', amount = '1000.00', seed = 'ID2026', message = '', debtor = false, trailing = [] } = {}) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    ...(debtor ? ['S', 'Zahler AG', 'Bahnhofstrasse', '1', '8000', 'Zürich', 'CH'] : ['', '', '', '', '', '', '']),
    'SCOR', buildScorReference(seed), message, 'EPD',
    ...trailing,
  ];
}
const lf = (l) => l.join('\n');
const crlf = (l) => l.join('\r\n');

// --- The identity itself --------------------------------------------------------------------------

test('IDENTITY: line endings, trailing whitespace, case, a BOM, the debtor and the alternative procedures do not change which bill it is', () => {
  const base = billIdentity(lf(lines()));
  assert.equal(typeof base, 'string');
  assert.equal(billIdentity(crlf(lines())), base, 'CR+LF and LF are one bill');
  assert.equal(billIdentity(lf(lines()) + '\n'), base, 'a trailing line break');
  assert.equal(billIdentity(lines().map((e) => (e === '' ? e : `${e}  `)).join('\n')), base, 'trailing whitespace on every element');
  assert.equal(billIdentity(lf(lines({ name: 'BEISPIEL  DRUCKEREI gmbh' }))), base, 'the creditor name in another case and spacing');
  assert.equal(billIdentity(`\uFEFF${lf(lines())}`), base, 'a byte-order mark');
  assert.equal(billIdentity(lf(lines({ debtor: true }))), base, 'the ultimate debtor (the payer)');
  assert.equal(billIdentity(lf(lines({ trailing: ['', 'eBill/B/x@example.com'] }))), base, 'an alternative procedure (elements 32 and 33)');
  assert.equal(billIdentity(`${lf(lines())}\nSeite 2 von 2\nZahlbar innert 30 Tagen`), base, 'a text layer running on past the symbol is not billing information');
  assert.match(base, /^v2:[0-9a-f]{64}$/, 'the version is part of the value');
  const scor = buildScorReference('ID2026');
  assert.equal(billIdentity(lf(lines()).replace(scor, scor.toLowerCase())), base, 'a SCOR reference is case-insensitive (IG Table 8)');
});

test('IDENTITY: an amount-only, open-amount, reference, IBAN or creditor difference IS a different bill', () => {
  const base = billIdentity(lf(lines()));
  assert.notEqual(billIdentity(lf(lines({ amount: '1100.00' }))), base, 'amount only');
  assert.notEqual(billIdentity(lf(lines({ amount: '' }))), base, 'an open amount');
  assert.notEqual(billIdentity(lf(lines({ seed: 'OTHER9' }))), base, 'another reference');
  assert.notEqual(billIdentity(lf(lines({ name: 'Andere Druckerei GmbH' }))), base, 'another creditor');
  assert.notEqual(billIdentity(lf(lines()).replace('CH9300762011623852957', 'CH5604835012345678009')), base, 'another IBAN');
  assert.equal(billIdentity(lf(lines({ amount: '1000.00' }))), billIdentity(lf(lines({ amount: '1000.0' }))), 'one amount, two spellings');
  assert.equal(billIdentity('not a QR bill'), null);
  // v2 (critic R7-L1): the message and the Swico billing information say which bill it is.
  assert.notEqual(billIdentity(lf(lines({ message: 'Miete Oktober' }))), billIdentity(lf(lines({ message: 'Miete November' }))), 'another message');
  assert.notEqual(
    billIdentity(lf(lines({ trailing: ['//S1/10/M-2026-10/11/261001'] }))),
    billIdentity(lf(lines({ trailing: ['//S1/10/M-2026-11/11/261001'] }))),
    'another Swico invoice number',
  );
  assert.notEqual(billIdentity(lf(lines({ trailing: ['//S1/10/M-2026-10'] }))), base, 'billing information added');
});

test('IDENTITY: the message and the billing information split on nothing but their content (whitespace, line endings, case, BOM)', () => {
  const swico = '//S1/10/M-2026-10/11/261001';
  const with_ = (message, info) => lines({ message, trailing: [info] });
  const base = billIdentity(lf(with_('Miete Oktober 2026', swico)));
  assert.equal(billIdentity(crlf(with_('Miete Oktober 2026', swico))), base, 'CR+LF');
  assert.equal(billIdentity(lf(with_('  Miete   Oktober 2026  ', `${swico}   `))), base, 'leading, inner and trailing whitespace');
  assert.equal(billIdentity(lf(with_('MIETE OKTOBER 2026', swico.toUpperCase()))), base, 'case');
  assert.equal(billIdentity(`\uFEFF${crlf(with_('Miete Oktober 2026', swico))}\r\n`), base, 'a BOM and a trailing CR+LF');
  assert.equal(billIdentity(lf([...with_('Miete Oktober 2026', swico), 'eBill/B/x@example.com'])), base, 'an alternative procedure after it');
});

// --- The merge, attacked -----------------------------------------------------------------------------

const RASTER = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, n, n, 9]).toString('base64');
const fields = (t, c) => getCapture(t.ctx, { captureId: c }).fields;
const live = (t, c) => Object.fromEntries(fields(t, c).filter((f) => !f.superseded).map((f) => [f.key, f]));
const stored = (t, c) => t.store.db.prepare('SELECT bill_identity FROM captures WHERE id = ?').get(c).bill_identity;
const ok = (r) => assert.equal(r.ok, true, JSON.stringify(r));
const FIX = { minor: 98000, currency: 'CHF' };

function raster(t, n) {
  const r = captureIntake(t.ctx, { contentBase64: RASTER(n), mime: 'image/png', filename: `r${n}.png`, idempotencyKey: `r${n}` });
  ok(r);
  return r.captureId;
}
function pdf(t, n, text) {
  const r = captureIntake(t.ctx, { contentBase64: Buffer.from(`Beleg ${n}\n${text}`, 'utf8').toString('base64'), mime: 'application/pdf', filename: `p${n}.pdf`, idempotencyKey: `p${n}` });
  ok(r);
  return r.captureId;
}
const supply = (t, c, payload, source = 'operator') => ok(captureExtract(t.ctx, { captureId: c, source, qrPayload: payload }));
const correct = (t, c) => ok(captureExtract(t.ctx, { captureId: c, source: 'operator', fields: [{ key: 'amount', value: FIX }] }));
const stands = (t, c, why) => assert.deepEqual(live(t, c).amount?.value, FIX, `${why}: the correction did not stand (${JSON.stringify(live(t, c).amount)})`);

test('SAME BILL: re-supplied with other line breaks, trailing whitespace or an added alternative procedure, the correction stands', () => {
  const t = setup();
  const c = raster(t, 1);
  supply(t, c, lf(lines()));
  correct(t, c);
  supply(t, c, crlf(lines()));
  stands(t, c, 'CR+LF');
  const ws = captureExtract(t.ctx, { captureId: c, source: 'operator', qrPayload: lines().map((e) => (e === '' ? e : `${e} `)).join('\n') });
  // Trailing whitespace may be refused by the strict decoder; refused or merged, the correction stands.
  assert.ok(ws.ok || ws.error === 'qr_payload_invalid', JSON.stringify(ws));
  stands(t, c, 'trailing whitespace');
  supply(t, c, lf(lines({ trailing: ['', 'eBill/B/x@example.com'] })));
  stands(t, c, 'an alternative procedure added');
  assert.equal(fields(t, c).filter((f) => f.supersededReason === 'discarded_with_bill').length, 0, 'nothing was announced as a previous bill');
});

test('SAME BILL: the bytes then a payload of the same paper (both line endings), and a re-read after it, keep the correction', () => {
  const t = setup();
  const c = pdf(t, 2, crlf(lines()));
  const bytesIdentity = stored(t, c);
  assert.equal(bytesIdentity, billIdentity(lf(lines())), 'the intake stored the bytes\' bill identity');
  correct(t, c);
  supply(t, c, lf(lines()));
  stands(t, c, 'operator payload of the same paper (LF)');
  supply(t, c, crlf(lines()));
  stands(t, c, 'operator payload of the same paper (CR+LF)');
  ok(captureExtract(t.ctx, { captureId: c, source: 'qr' }));
  stands(t, c, 'a re-read of the bytes');
  assert.equal(stored(t, c), bytesIdentity);
});

test('SAME BILL: an agent loser in between (payload or other bill) never arms a re-scan or re-read to discard the correction', () => {
  const t = setup();
  const c = pdf(t, 3, lf(lines()));
  correct(t, c);
  const identity = stored(t, c);
  supply(t, c, lf(lines({ name: 'Andere Firma AG', amount: '55.00', seed: 'AGENT7' })), 'agent');
  assert.equal(stored(t, c), identity, 'a losing bill never becomes the bill on the capture');
  ok(captureExtract(t.ctx, { captureId: c, source: 'qr' }));
  stands(t, c, 're-read after an agent loser');
  supply(t, c, lf(lines()), 'agent');
  stands(t, c, 'the agent re-supplies the same bill');
  supply(t, c, crlf(lines()));
  stands(t, c, 'operator re-scan after agent losers');
});

test('DIFFERENT BILL: an amount-only difference discards the correction as history, worded as the previous bill\'s', () => {
  const t = setup();
  const c = raster(t, 4);
  supply(t, c, lf(lines()));
  correct(t, c);
  supply(t, c, lf(lines({ amount: '1100.00' })));
  assert.deepEqual(live(t, c).amount.value, { minor: 110000, currency: 'CHF' });
  assert.deepEqual(fields(t, c).filter((f) => f.supersededReason === 'discarded_with_bill').map((f) => f.value), [FIX]);
});

test('P1, P2, P1: switching back does NOT restore P1\'s discarded correction; it stays visible as history (decided 01.10.2026)', () => {
  const t = setup();
  const c = raster(t, 5);
  const p1 = lf(lines());
  supply(t, c, p1);
  correct(t, c);
  supply(t, c, lf(lines({ name: 'Zweite Firma AG', amount: '2000.00', seed: 'P2X' })));
  supply(t, c, crlf(lines()));
  assert.deepEqual(live(t, c).amount.value, { minor: 100000, currency: 'CHF' }, 'P1 is live again with its own QR amount');
  assert.equal(stored(t, c), billIdentity(p1));
  assert.ok(fields(t, c).some((f) => f.supersededReason === 'discarded_with_bill' && JSON.stringify(f.value) === JSON.stringify(FIX)), 'the correction stays history, to be re-typed');
});

test('LEGACY: a capture whose bill won before the identity was stored (NULL) derives it, so the same bill still keeps the correction', () => {
  const t = setup();
  const c = pdf(t, 6, lf(lines()));
  correct(t, c);
  t.store.db.prepare('UPDATE captures SET bill_identity = NULL WHERE id = ?').run(c);
  ok(captureExtract(t.ctx, { captureId: c, source: 'qr' }));
  stands(t, c, 'legacy re-read (derived from the stored document)');
  supply(t, c, crlf(lines()));
  stands(t, c, 'legacy operator payload of the same paper');
  const r = raster(t, 7);
  supply(t, r, lf(lines()));
  correct(t, r);
  t.store.db.prepare('UPDATE captures SET bill_identity = NULL WHERE id = ?').run(r);
  supply(t, r, crlf(lines()));
  stands(t, r, 'legacy re-scan (derived from the live payload evidence)');
});

test('VERSION: a stored identity of another version (a v1 bare digest) is UNKNOWN: re-derived, never compared as equal or different', () => {
  const t = setup();
  const c = raster(t, 8);
  supply(t, c, lf(lines()));
  correct(t, c);
  // What a v1 build stored: a bare sha256 hex of the old canonical list.
  t.store.db.prepare('UPDATE captures SET bill_identity = ? WHERE id = ?').run('a'.repeat(64), c);
  supply(t, c, crlf(lines()));
  stands(t, c, 'the same bill under a stale v1 identity');
  // A different bill still resets, and the winner stores a current identity.
  supply(t, c, lf(lines({ amount: '1100.00' })));
  assert.deepEqual(live(t, c).amount.value, { minor: 110000, currency: 'CHF' });
  assert.equal(stored(t, c), billIdentity(lf(lines({ amount: '1100.00' }))));
  assert.match(stored(t, c), /^v2:/);
});

test('PDF TEXT LAYER: text after the symbol does not split the bytes\' read from a supplied payload of the same paper', () => {
  const t = setup();
  const c = pdf(t, 9, `${crlf(lines())}\r\nSeite 2 von 2\r\nZahlbar innert 30 Tagen`);
  correct(t, c);
  supply(t, c, lf(lines()));
  stands(t, c, 'the payload of the same paper beside a text layer that runs on');
});
