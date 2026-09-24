// A20 camt import: the ZKB (Zürcher Kantonalbank) camt.054 collective-booking (Sammelbuchung) shape.
//
// WHY THIS EXISTS. The sibling `zkb-shape-camt.test.mjs` covers four ZKB-shaped camt.053 statements
// (the bank's structure, invented values): single-entry day-end statements. A camt.054 (ZKB Datalink
// order type Z54/ZS4/ZQR) is the shape most likely to expose a parser edge case,
// because it is where the bank fans a COLLECTIVE credit out into its underlying QR-bill payments: one
// booked `Ntry` (the single line that also lands on the camt.053) carrying a `Btch` header plus many
// `TxDtls`, each with its own amount and QRR/SCOR reference. The camt parser must fan that one entry
// out into one `bank_txn` per `TxDtls` (D81), summing to the entry amount exactly (integer Rappen) or
// refusing the whole message.
//
// THE FIXTURE (`fixtures/zkb-camt054-01-sammelbuchung-qrr.xml`) is SYNTHETIC: every value is invented
// (its header says so plainly), built to the SIX SPS Cash Management guidelines and the ZKB Datalink
// shape. A future shape change is modelled with invented values too, keeping these assertions. All
// parties, IBANs and references are fixed fictitious test values; the amounts are the fact under test
// (1500.00 + 2750.50 + 999.95 == 5250.45).
//
// WHAT THIS SHAPE PROVED (and camt.053 could not): the real ISO 20022 notification element is
// `Ntfctn`, not the malformed `Ntfcn` a prior parser revision detected. Because the repo's own
// hand-built camt.054 test XML used the same malformed spelling, the parser accepted only its own
// invented shape and REJECTED every real bank camt.054 with "no notification element found". A
// faithful, ISO-shaped fixture is exactly what surfaced that. The `Ntfctn`-vs-`Ntfcn` regression is
// pinned below so nobody re-introduces the typo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCamt, createBankAccount, importCamt } from '../../dist/core/banking/index.js';
import { setup } from '../payments/support.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const FILE = 'zkb-camt054-01-sammelbuchung-qrr.xml';

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};

// The account IBAN (the account the notification is FOR), shared with the camt.053 suite.
const ZKB_IBAN = 'CH9300762011623852957';

// The three underlying payments the collective credit fans out into, in document order.
const DETAILS = [
  { amountMinor: 150000, referenceKind: 'qrr', referenceValue: '210000000003139471430009017', acctSvcrRef: 'ZKB2026041500000778-01', payerName: 'Robert Schneider AG' },
  { amountMinor: 275050, referenceKind: 'qrr', referenceValue: '210000000003456789012345675', acctSvcrRef: 'ZKB2026041500000778-02', payerName: 'Muster Handels GmbH' },
  { amountMinor: 99995, referenceKind: 'scor', referenceValue: 'RF18539007547034', acctSvcrRef: 'ZKB2026041500000778-03', payerName: 'Baumann + Partner' },
];
const ENTRY_AMOUNT_MINOR = 525045; // == DETAILS' amounts summed, and the collective Ntry Amt.

test('the ZKB camt.054 Sammelbuchung fans out into one entry per TxDtls, summing to the collective amount', () => {
  const s = ok(parseCamt(read(FILE)), FILE).statement;

  assert.equal(s.messageType, 'camt054', 'a real camt.054 must be detected as camt.054 (Ntfctn element)');
  assert.equal(s.iban, ZKB_IBAN, 'account IBAN');
  assert.equal(s.skipped.length, 0, `no entry was skipped: ${JSON.stringify(s.skipped)}`);

  // camt.054 carries no Bal element at all (SPS 2.3 p.53): opening/closing are absent, never invented.
  assert.equal(s.openingBalanceMinor, null, 'camt.054 has no opening balance');
  assert.equal(s.closingBalanceMinor, null, 'camt.054 has no closing balance');

  // The single collective credit fanned out into exactly one row per TxDtls (D81).
  assert.equal(s.entries.length, DETAILS.length, 'one parsed entry per TxDtls');

  let sum = 0;
  for (let i = 0; i < DETAILS.length; i++) {
    const e = s.entries[i];
    const d = DETAILS[i];
    assert.equal(e.creditDebit, 'CRDT', `detail ${i}: a collective credit`);
    assert.equal(e.currency, 'CHF', `detail ${i}: currency`);
    assert.equal(e.amountMinor, d.amountMinor, `detail ${i}: TxDtls amount (Rappen)`);
    assert.equal(e.referenceKind, d.referenceKind, `detail ${i}: reference kind`);
    assert.equal(e.referenceValue, d.referenceValue, `detail ${i}: reference value`);
    assert.equal(e.payerName, d.payerName, `detail ${i}: debtor name`);
    // Each TxDtls carries its OWN AcctSvcrRef (p.76): the D81 identity key is per transaction, so the
    // three fanned rows never collide on one shared booking reference.
    assert.equal(e.entryKey, `asr:${d.acctSvcrRef}`, `detail ${i}: per-transaction identity key`);
    sum += e.amountMinor;
  }

  // The parser accounted for the whole collective booking to the Rappen: the fan-out sums exactly to
  // the entry Amt. (The parser refuses the message otherwise; that path is asserted below.)
  assert.equal(sum, ENTRY_AMOUNT_MINOR, 'the three TxDtls sum to the collective entry Amt');
});

test('ZKB camt.054: the two QRR references (27 digits) and the one SCOR (RF) reference are each extracted', () => {
  const s = ok(parseCamt(read(FILE))).statement;
  const qrr = s.entries.filter((e) => e.referenceKind === 'qrr');
  const scor = s.entries.filter((e) => e.referenceKind === 'scor');
  assert.equal(qrr.length, 2, 'two QRR details');
  assert.equal(scor.length, 1, 'one SCOR detail');
  for (const e of qrr) assert.equal(e.referenceValue.length, 27, 'a QR reference is 27 digits');
  assert.match(scor[0].referenceValue, /^RF\d\d/, 'an ISO 11649 creditor reference starts RF + two check digits');
});

test('ZKB camt.054: a collective entry whose TxDtls do NOT sum to the entry Amt is refused, not truncated', () => {
  const raw = read(FILE);
  // Move the collective entry Amt off by one Rappen; the three TxDtls now under-account for it. The
  // Ccy-qualified entry-level Amt is unique (Btch uses <TtlAmt>, the summary uses a bare <Amt>), so
  // this rewrites only the figure the fan-out is checked against.
  const broken = raw.replace('<Amt Ccy="CHF">5250.45</Amt>', '<Amt Ccy="CHF">5250.44</Amt>');
  assert.notEqual(broken, raw, 'the mutation must actually change the entry Amt');
  const res = parseCamt(broken);
  assert.equal(res.ok, false, 'a batch this parser cannot reconcile to the Rappen must be refused');
  assert.equal(res.error, 'schema_invalid');
  // Pin the refusal to the SUM-CHECK specifically, not just any schema_invalid: without this a broken
  // camt.054 detection (a different schema_invalid) would satisfy the test for the wrong reason.
  assert.match(res.reason, /TxDtls sum to 525045 but the entry Amt is 525044/, 'refused for the sum mismatch');
});

test('REGRESSION: the notification element is the real ISO Ntfctn, and the malformed Ntfcn is NOT camt.054', () => {
  const raw = read(FILE);
  // The fixture is faithful to the wire: it carries <Ntfctn>, never the dropped-t <Ntfcn> typo.
  assert.ok(raw.includes('<Ntfctn>'), 'the fixture must use the real ISO element Ntfctn');
  assert.ok(!/<Ntfcn[\s>]/.test(raw), 'the fixture must not carry the malformed Ntfcn spelling');
  // And a document whose notification element is the old malformed spelling is not detected as
  // camt.054 at all: this is the bug the fixture exposed, pinned so no alias for the typo creeps back.
  const malformed =
    '<Document><BkToCstmrDbtCdtNtfctn><GrpHdr><MsgId>M</MsgId></GrpHdr>' +
    `<Ntfcn><Id>N</Id><Acct><Id><IBAN>${ZKB_IBAN}</IBAN></Id></Acct></Ntfcn>` +
    '</BkToCstmrDbtCdtNtfctn></Document>';
  const res = parseCamt(malformed);
  assert.equal(res.ok, false, 'the malformed Ntfcn spelling is not a recognised camt message');
  assert.equal(res.error, 'schema_invalid');
});

// --- money path: importing the collective notification books one bank_txn per underlying payment ----

function zkbAccount() {
  const t = setup();
  const bank = ok(
    createBankAccount(t.ctx, {
      name: 'ZKB Geschäftskonto',
      iban: ZKB_IBAN,
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'zkb-bank-054',
    }),
    'createBankAccount',
  );
  return { ...t, bankAccountId: bank.bankAccountId };
}

test('importing the ZKB Sammelbuchung books one bank_txn per TxDtls, and a re-import is a no-op', () => {
  const t = zkbAccount();
  const countTxns = () =>
    t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const countStatements = () =>
    t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(t.workspaceId).n;

  const res = ok(
    importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read(FILE), idempotencyKey: 'zkb-054' }),
    `import ${FILE}`,
  );
  assert.equal(res.txnCount, DETAILS.length, 'one booked bank_txn per underlying payment');
  assert.equal(res.duplicate, false, 'first import must not be a duplicate');
  assert.equal(countTxns(), DETAILS.length, 'three bank_txn rows, one per TxDtls');
  assert.equal(countStatements(), 1, 'one bank_statement for the notification');

  // Re-import under a FRESH idempotency key: dedupe is on the statement CONTENT (Stmt/Id + page), not
  // the key, so the collective booking is not fanned out a second time.
  const replay = ok(
    importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read(FILE), idempotencyKey: 'zkb-054-replay' }),
    `re-import ${FILE}`,
  );
  assert.equal(replay.duplicate, true, 're-importing the same content is recognised as a duplicate');
  assert.equal(countTxns(), DETAILS.length, 're-importing the Sammelbuchung doubled the bank_txn rows');
  assert.equal(countStatements(), 1, 're-importing minted a second bank_statement');
});

test('a ZKB camt.054 imported into the WRONG account IBAN is refused, and nothing is booked', () => {
  const t = setup();
  const other = ok(
    createBankAccount(t.ctx, {
      name: 'Falsches Konto',
      iban: 'CH4431999123000889012',
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'wrong-bank-054',
    }),
  );
  const res = importCamt(t.ctx, {
    bankAccountId: other.bankAccountId,
    xml: read(FILE),
    idempotencyKey: 'zkb-054-mismatch',
  });
  assert.equal(res.ok, false, 'an IBAN mismatch must be refused');
  assert.equal(res.error, 'iban_mismatch');
  const n = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(n, 0, 'a refused import must book nothing');
});
