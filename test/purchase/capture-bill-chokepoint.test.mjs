/**
 * A31, THE BILL CHOKEPOINT (`src/core/purchase/billMerge.ts`, critic R3-M1, the three-FAIL redesign).
 *
 * Three critic rounds found one defect class through three different writers of bill fields (R1-M1 an
 * earlier payload, R2-M1 the bytes' read under a payload, R3-M1 the bytes' RE-read after a payload).
 * So the bill is merged in ONE function, and this file holds that structurally:
 *
 *  1. A POSITIVE GATE: the engine source is scanned, and any module other than `billMerge.ts` that
 *     writes `capture_fields` or `capture_qr_payloads` fails it. Inside `billMerge.ts`, the private row
 *     writer is called only from `mergeBill` and `applyTypedField`, and the typed path refuses bill
 *     provenance at runtime.
 *  2. The R3-M1 cases, named: a re-read after a takeover is a TRUE no-op (no row, no audit entry, no
 *     timestamp), and a retired vendor match stays retired.
 *  3. A PROPERTY TEST: seeded random sequences of (bytes re-read, operator payload, agent payload, typed
 *     correction) over a PDF capture and a raster capture never leave live bill fields of two different
 *     bills, and repeating any step, or re-reading the bytes, never changes the outcome.
 *
 * Synthetic payloads only: SIX IG v2.3 Annex A example 2 (published) and SIX's published sample IBAN
 * with invented creditors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureIntake, captureExtract, getCapture } from '../../dist/core/purchase/index.js';
import { applyTypedField, BILL_KEYS, TYPED_ONLY_KEYS } from '../../dist/core/purchase/billMerge.js';
import { CAPTURE_FIELD_KEYS } from '../../dist/core/purchase/captureEnums.js';
import { billIdentity } from '../../dist/core/purchase/qrbill/identity.js';
import { decodeSwissQrBill } from '../../dist/core/purchase/qrbill/decode.js';
import { decodedBillFields } from '../../dist/core/purchase/qrbill/fields.js';
import { locateSpcPayload, parseSpcPayload } from '../../dist/core/purchase/captureParse.js';
import { createContact } from '../../dist/core/sales/index.js';
import { buildScorReference } from '../../dist/core/sales/qrbill.js';
import { setup } from './support.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');
const CHOKEPOINT = 'src/core/purchase/billMerge.ts';

// --- 1. The positive gate -----------------------------------------------------------------------
//
// THE SCAN IS LEXICAL, so a statement that builds its table name at RUNTIME is invisible to it. Five
// engine writers do, and each may reach `capture_fields` / `capture_qr_payloads` without a literal name.
// Every one is STRUCTURAL: it moves, deletes or re-keys rows wholesale and never states, merges or
// decides a bill, so none can put two bills on one capture. They are named here so that a future
// dynamic writer that DOES state bill fields is a visible decision, not a silent bypass (critic R4):
//
//  1. `src/core/data/portability.ts` restore wipe (`loadIntoNewWorkspace`, `DELETE FROM "${table}"`):
//     clears the fresh workspace's seeded scaffold before a load; deletes, writes no field.
//  2. `src/core/data/portability.ts` `loadTable` (`INSERT INTO "${table}"`) and
//     `remapCopiedWorkspaceIds` (`UPDATE "${table}" SET "<column>"`): the restore copies rows the
//     chokepoint already merged, verbatim, and the env_copy re-point rewrites only id tokens through
//     the G04 id chokepoint; neither touches a value's meaning or which rows are live.
//  3. `src/core/landscape/copy.ts` `deleteWorkspace` (`DELETE FROM "${table}" WHERE rowid = ?`): drops a
//     whole workspace from an env_copy target before a mandate refresh.
//  4. `src/core/migration/testmandant.ts` `hardDeleteWorkspace` (`DELETE FROM ${name} ...`): the G12
//     test-mandate reset, every row of the mandate across every tenant-scoped table.
//  5. `src/core/sales/contactMerge.ts` (`UPDATE ${fk.table} SET ${fk.column}`): re-points declared
//     contact references, from the fixed `MERGE_REPOINT_FKS` list, which names no capture table today.
//
// A sixth `INSERT INTO "${table}"` (`portability.ts` `insertRows`) writes the backup SNAPSHOT file, not
// the book. Anything that would merge, supersede or retire a bill row goes through `billMerge.ts`.

/** A statement that writes one of the two bill-bearing tables, however it is spelled. */
const WRITES_BILL_TABLES = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(capture_fields|capture_qr_payloads)\b/gi;

function engineSources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) engineSources(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function writersIn(source) {
  return [...source.matchAll(WRITES_BILL_TABLES)].map((m) => m[1]);
}

test('GATE: the scan bites on every spelling of a write (it proves itself on synthetic sources)', () => {
  for (const sample of [
    "db.prepare('INSERT INTO capture_fields (id) VALUES (?)')",
    'db.prepare(`insert or ignore into "capture_fields" (id) values (?)`)',
    "db.prepare('UPDATE capture_fields SET superseded = 1')",
    "db.prepare('DELETE FROM capture_qr_payloads WHERE id = ?')",
    "db.prepare('REPLACE INTO capture_fields VALUES (?)')",
  ]) {
    assert.equal(writersIn(sample).length, 1, `the scan misses: ${sample}`);
  }
  assert.equal(writersIn("db.prepare('SELECT * FROM capture_fields WHERE id = ?')").length, 0, 'a read is not a write');
});

test('GATE: no engine module but the chokepoint writes capture_fields or capture_qr_payloads', () => {
  const offenders = [];
  let chokepointWrites = 0;
  for (const file of engineSources()) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const hits = writersIn(readFileSync(file, 'utf8'));
    if (rel === CHOKEPOINT) chokepointWrites = hits.length;
    else if (hits.length > 0) offenders.push(`${rel}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `bill fields are written outside the chokepoint:\n${offenders.join('\n')}`);
  assert.ok(chokepointWrites >= 3, 'the chokepoint itself must hold the writes (non-vacuous)');
});

test('GATE: inside the chokepoint, the private row writer is reached only from mergeBill and applyTypedField', () => {
  const source = readFileSync(join(ROOT, CHOKEPOINT), 'utf8');
  const fnAt = (name) => {
    const at = source.indexOf(`export function ${name}(`);
    assert.ok(at >= 0, `${name} is missing`);
    return at;
  };
  const spans = ['applyTypedField', 'mergeBill'].map((name) => {
    const start = fnAt(name);
    const next = source.indexOf('\nexport function ', start + 1);
    const nextFn = source.indexOf('\nfunction ', start + 1);
    const end = Math.min(...[next, nextFn, source.length].filter((n) => n > 0));
    return [start, end];
  });
  const calls = [...source.matchAll(/\bwriteRow\(/g)].map((m) => m.index).filter((i) => !source.slice(Math.max(0, i - 9), i).includes('function'));
  assert.ok(calls.length >= 2);
  for (const at of calls) {
    assert.ok(spans.some(([s, e]) => at > s && at < e), `writeRow is called outside mergeBill/applyTypedField at offset ${at}`);
  }
});

test('GATE: the typed path refuses bill provenance at runtime (no typed value can pose as the bytes\' read)', () => {
  const t = setup();
  const r = captureIntake(t.ctx, { contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]).toString('base64'), mime: 'image/png', filename: 'x.png', idempotencyKey: 'g' });
  assert.equal(r.ok, true);
  for (const provenance of ['qr', 'swico']) {
    assert.throws(() => applyTypedField(t.ctx, r.captureId, { key: 'amount', value: { minor: 1, currency: 'CHF' }, provenance, confidence: 'high' }), /bill provenance/);
  }
});

test('GATE: every capture field key is classified exactly once, bill key or typed-only, and no reader emits a typed-only key', () => {
  for (const key of CAPTURE_FIELD_KEYS) {
    assert.ok(BILL_KEYS.has(key) !== TYPED_ONLY_KEYS.has(key), `${key} must be exactly one of BILL_KEYS / TYPED_ONLY_KEYS`);
  }
  assert.equal(BILL_KEYS.size + TYPED_ONLY_KEYS.size, CAPTURE_FIELD_KEYS.length, 'a classified key that is not a capture field key');
  for (const payload of [BILL_A, BILL_B, BILL_C]) {
    const decoded = decodeSwissQrBill(payload);
    const emitted = [...decodedBillFields(decoded.bill, 'operator').map((f) => f.key), ...parseSpcPayload(locateSpcPayload(payload)).fields.map((f) => f.key)];
    for (const key of emitted) assert.ok(BILL_KEYS.has(key), `a reader emits ${key}, which is not a bill key`);
  }
});

// --- Fixtures -------------------------------------------------------------------------------------

// SIX IG v2.3 Annex A, example 2 (Table 18): QR-IBAN, QRR, Swico S1 with the UID /30/, a message.
const BILL_A = [
  'SPC', '0200', '1', 'CH4431999123000889012',
  'S', 'Max Muster & Söhne', 'Musterstrasse', '123', '8000', 'Seldwyla', 'CH',
  '', '', '', '', '', '', '',
  '1949.75', 'CHF',
  'S', 'Simon Muster', 'Musterstrasse', '1', '8000', 'Seldwyla', 'CH',
  'QRR', '210000000003139471430009017', 'Order from 15.10.2020', 'EPD',
  '//S1/10/1234/11/201021/30/102673386/32/7.7/40/0:30',
  'eBill/B/simon.muster@example.com',
].join('\r\n');

function plainBill({ name, amount, tp, seed }) {
  return [
    'SPC', '0200', '1', 'CH9300762011623852957',
    'S', name, 'Seeweg', '12', '6000', 'Luzern', 'CH',
    '', '', '', '', '', '', '',
    amount, 'CHF',
    '', '', '', '', '', '', '',
    tp, tp === 'SCOR' ? buildScorReference(seed) : '', '', 'EPD',
  ].join('\n');
}
const BILL_B = plainBill({ name: 'Richtige Firma GmbH', amount: '250.40', tp: 'SCOR', seed: 'PROPB1' });
const BILL_C = plainBill({ name: 'Offene Firma AG', amount: '', tp: 'NON' });
const BILLS = { A: BILL_A, B: BILL_B, C: BILL_C };

let rasterSeed = 0;
function raster() {
  rasterSeed += 1;
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, (rasterSeed >> 8) & 0xff, rasterSeed & 0xff, 3, 1]).toString('base64');
}

function intakePdf(t, n) {
  // A unique first line keeps the bytes distinct (intake dedupes on content) without touching the payload.
  const text = `Rechnung ${n}\n${BILL_A}`;
  const r = captureIntake(t.ctx, { contentBase64: Buffer.from(text, 'utf8').toString('base64'), mime: 'application/pdf', filename: `r${n}.pdf`, idempotencyKey: `pdf-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.captureId;
}

function intakeRaster(t, n) {
  const r = captureIntake(t.ctx, { contentBase64: raster(), mime: 'image/png', filename: `r${n}.png`, idempotencyKey: `png-${n}` });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.captureId;
}

const fieldsOf = (t, captureId) => getCapture(t.ctx, { captureId }).fields;
const isBillRow = (f) => f.qrPayloadId !== null || f.provenance === 'qr' || f.provenance === 'swico';
const liveMap = (fields) => Object.fromEntries(fields.filter((f) => !f.superseded).map((f) => [f.key, JSON.stringify(f.value)]));
const auditCount = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(t.workspaceId).n;

/** Everything a step could change: every row (live and history), the evidence rows, the audit trail. */
function snapshot(t, captureId) {
  const capture = getCapture(t.ctx, { captureId });
  return {
    rows: capture.fields.length,
    live: liveMap(capture.fields),
    payloads: capture.qrPayloads.length,
    audit: auditCount(t),
    updatedAt: capture.capture.updatedAt,
  };
}

// --- 2. The R3-M1 cases, named ------------------------------------------------------------------

test('R3-M1 after an operator payload took the bill over, re-reading the bytes is a TRUE no-op: no row, no audit, no timestamp', () => {
  const t = setup();
  const captureId = intakePdf(t, 'r3');
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: BILL_C }).ok, true);
  const before = snapshot(t, captureId);
  assert.equal(before.live.amount, undefined);
  assert.equal(before.live.reference, undefined);
  for (let i = 0; i < 3; i += 1) assert.equal(captureExtract(t.ctx, { captureId, source: 'qr' }).ok, true);
  assert.deepEqual(snapshot(t, captureId), before, 'the bytes\' re-read changed the capture');
});

test('R3-M1 a vendor match the payload retired stays retired across re-reads (the match follows the winning bill)', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Muster Söhne', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'v' });
  assert.equal(vendor.ok, true);
  const captureId = intakePdf(t, 'vm');
  assert.equal(liveMap(fieldsOf(t, captureId)).vendor_contact_id, JSON.stringify(vendor.contact.id), 'the bytes\' UID matched the vendor');
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: BILL_B }).ok, true);
  assert.equal(liveMap(fieldsOf(t, captureId)).vendor_contact_id, undefined, 'bill B carries no UID: the bytes\' vendor match is retired');
  assert.equal(captureExtract(t.ctx, { captureId, source: 'qr' }).ok, true);
  assert.equal(liveMap(fieldsOf(t, captureId)).vendor_contact_id, undefined, 'the re-read resurrected the retired vendor');
  // And when the bill the bytes carry is supplied back by the operator, its vendor match comes with it.
  assert.equal(captureExtract(t.ctx, { captureId, source: 'operator', qrPayload: BILL_A }).ok, true);
  assert.equal(liveMap(fieldsOf(t, captureId)).vendor_contact_id, JSON.stringify(vendor.contact.id));
});

// --- 3. The property test -------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failing sequence is reproducible from its seed. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every value each bill can state, from BOTH readers of it (the strict decoder of a supplied payload and
 * the text-layer parser of the stored bytes), plus the vendor its UID matches. A live bill row must equal
 * one bill's value for its key.
 */
function billValues(vendorId) {
  const out = {};
  for (const [name, payload] of Object.entries(BILLS)) {
    const values = {};
    const decoded = decodeSwissQrBill(payload);
    assert.equal(decoded.ok, true, `fixture ${name} must decode`);
    for (const f of decodedBillFields(decoded.bill, 'operator')) values[f.key] = JSON.stringify(f.value);
    const parsed = parseSpcPayload(locateSpcPayload(payload));
    for (const f of parsed.fields) {
      const v = JSON.stringify(f.value);
      assert.ok(values[f.key] === undefined || values[f.key] === v, `fixture ${name}: the two readers disagree on ${f.key}`);
      values[f.key] = v;
    }
    if (parsed.swicoUid !== null || decoded.bill.swico?.uid) values.vendor_contact_id = JSON.stringify(vendorId);
    out[name] = values;
  }
  return out;
}

const STEPS = [
  { name: 'reread', run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'qr' }) },
  ...['A', 'B', 'C'].flatMap((b) => [
    { name: `op${b}`, payload: [BILLS[b], 'operator'], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'operator', qrPayload: BILLS[b] }) },
    { name: `ag${b}`, payload: [BILLS[b], 'agent'], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'agent', qrPayload: BILLS[b] }) },
  ]),
  // The SAME bills read with the other line breaks (IG §4.1.4 allows CR+LF and LF; readers differ).
  { name: 'opA_lf', payload: [BILL_A.replace(/\r\n/g, '\n'), 'operator'], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'operator', qrPayload: BILL_A.replace(/\r\n/g, '\n') }) },
  { name: 'opB_crlf', payload: [BILL_B.replace(/\n/g, '\r\n'), 'operator'], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'operator', qrPayload: BILL_B.replace(/\n/g, '\r\n') }) },
  { name: 'agB_crlf', payload: [BILL_B.replace(/\n/g, '\r\n'), 'agent'], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'agent', qrPayload: BILL_B.replace(/\n/g, '\r\n') }) },
  { name: 'typedAmount', typedOperator: ['amount', { minor: 77700, currency: 'CHF' }], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'operator', fields: [{ key: 'amount', value: { minor: 77700, currency: 'CHF' } }] }) },
  { name: 'typedOpReference', typedOperator: ['reference_type', 'NON'], run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'operator', fields: [{ key: 'reference_type', value: 'NON' }] }) },
  { name: 'typedAgentName', run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'agent', fields: [{ key: 'vendor_name', value: 'Getippt AG', confidence: 'medium' }] }) },
  { name: 'typedAgentDue', run: (t, c) => captureExtract(t.ctx, { captureId: c, source: 'agent', fields: [{ key: 'due_date', value: '2026-09-30', confidence: 'high' }] }) },
];

test('PROPERTY: one bill live at a time; a typed operator value survives every SAME-bill step and re-read and goes, as history, with a DIFFERENT winning bill; repeats are no-ops', () => {
  const t = setup();
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Muster Söhne', vatNumber: 'CHE-102.673.386 MWST', idempotencyKey: 'v' });
  assert.equal(vendor.ok, true);
  const values = billValues(vendor.contact.id);
  const SEQUENCES = 80;
  const LENGTH = 8;
  for (let seed = 1; seed <= SEQUENCES; seed += 1) {
    const rnd = prng(seed);
    const pdf = rnd() < 0.6;
    const captureId = pdf ? intakePdf(t, `p${seed}`) : intakeRaster(t, `p${seed}`);
    const trail = [pdf ? 'pdf(A)' : 'raster'];
    const done = [];
    const typed = new Map(); // key -> the typed OPERATOR value that must stand from now on
    const invariants = (where) => {
      const fields = fieldsOf(t, captureId);
      // (a) Every live bill row states ONE bill's value.
      const live = fields.filter((f) => !f.superseded && isBillRow(f));
      const candidates = Object.keys(values).filter((b) => live.every((f) => values[b][f.key] === JSON.stringify(f.value)));
      assert.ok(candidates.length > 0, `${where.text}: live bill fields of two bills: ${JSON.stringify(live.map((f) => [f.key, f.value, f.provenance]))}`);
      // (c) Corrections belong to their bill (owner decision 01.10.2026). A typed operator value stands
      // through every SAME-bill step (a re-read, a re-scan of the latest payload, a typed value); when
      // it is gone, the step was a DIFFERENT payload bill that took over, and the value is history with
      // its reason, never deleted.
      for (const [key, value] of [...typed]) {
        const row = fields.find((f) => !f.superseded && f.key === key);
        if (row && JSON.stringify(row.value) === JSON.stringify(value)) continue;
        assert.ok(where.won && !where.sameBill, `${where.text}: the typed operator ${key} was reset by ${where.sameBill ? 'a SAME-bill' : 'a non-winning'} step ${where.step.name}: ${JSON.stringify(row)}`);
        assert.ok(
          fields.some((f) => f.superseded && f.key === key && f.supersededReason === 'discarded_with_bill' && JSON.stringify(f.value) === JSON.stringify(value)) ||
            fields.some((f) => f.superseded && f.key === key && JSON.stringify(f.value) === JSON.stringify(value)),
          `${where.text}: the typed operator ${key} vanished without history`,
        );
        typed.delete(key);
      }
    };
    // WHICH bill a step states: what it SAYS (`billIdentity`), never its raw text (critic R6-M1).
    const identityOf = (step) => (step.payload ? billIdentity(step.payload[0]) : step.name === 'reread' && pdf ? billIdentity(BILL_A) : null);
    const storedIdentity = () => t.store.db.prepare('SELECT bill_identity FROM captures WHERE id = ?').get(captureId).bill_identity;
    const apply = (step, text) => {
      const stated = identityOf(step);
      const before = storedIdentity();
      const hadBill = fieldsOf(t, captureId).some((f) => !f.superseded && isBillRow(f));
      const sameBill = stated !== null && stated === before;
      const r = step.run(t, captureId);
      assert.equal(r.ok, true, `${text}: ${JSON.stringify(r)}`);
      // The step's bill WON when it is now the bill on the capture (a losing one never is).
      const won = stated !== null && !sameBill && storedIdentity() === stated;
      if (stated !== null && !won) assert.equal(storedIdentity(), before, `${text}: a bill that did not win changed the capture's bill identity`);
      // (e) A DIFFERENT bill that took over a capture that HAD a bill leaves no typed value live on any
      // bill key: every one went with the old bill (R5-M1).
      if (won && hadBill) {
        const stray = fieldsOf(t, captureId).filter((f) => !f.superseded && !isBillRow(f) && BILL_KEYS.has(f.key));
        assert.deepEqual(stray.map((f) => [f.key, f.value, f.provenance]), [], `${text}: a typed value on a bill key outlived the different bill ${step.name}`);
      }
      if (step.typedOperator) typed.set(step.typedOperator[0], step.typedOperator[1]);
      invariants({ text, step, sameBill, won });
    };
    for (let i = 0; i < LENGTH; i += 1) {
      const step = STEPS[Math.floor(rnd() * STEPS.length)];
      trail.push(step.name);
      done.push(step);
      const where = `seed ${seed}: ${trail.join(' > ')}`;
      apply(step, where);
      // (d) NON-adjacent repetition: any EARLIER step re-applied later keeps (a) and (c).
      if (done.length > 2 && rnd() < 0.5) {
        const earlier = done[Math.floor(rnd() * (done.length - 1))];
        trail.push(`again:${earlier.name}`);
        apply(earlier, `seed ${seed}: ${trail.join(' > ')}`);
      }

      // (b) Repeating the last applied step, and re-reading the bytes, are no-ops.
      const last = trail.at(-1).startsWith('again:') ? STEPS.find((x) => `again:${x.name}` === trail.at(-1)) : step;
      const settled = snapshot(t, captureId);
      assert.equal(last.run(t, captureId).ok, true);
      assert.deepEqual(snapshot(t, captureId), settled, `${where}: repeating ${last.name} changed the capture`);
      assert.equal(STEPS[0].run(t, captureId).ok, true);
      assert.deepEqual(snapshot(t, captureId), settled, `${where}: a re-read changed the capture`);
    }
  }
});
