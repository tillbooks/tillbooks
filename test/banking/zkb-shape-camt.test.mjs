// A20 camt import hardened against the SHAPE of a ZKB (Zürcher Kantonalbank) Datalink export.
//
// WHY THIS EXISTS. Every other camt test in this repo builds its XML by hand (`camtXml(...)`), so it
// proves the parser against OUR idea of camt, never against a bank's. These four fixtures copy a ZKB
// camt.053 Datalink export element for element: the namespace, element order and every ZKB-specific
// shape below are exactly as the bank emits them. Every VALUE is invented: names, addresses, IBANs,
// references, statement ids, sequence numbers, dates and amounts. The amounts still reconcile to the
// Rappen (OPBD + net = CLBD, and statements 02 to 04 chain CLBD to OPBD), so the check is meaningful.
// No real account data belongs in this file or its fixtures: this directory ships in the public repo.
//
// WHAT IS ZKB-SPECIFIC HERE (and was NOT covered by the synthetic suite):
//   - the export is **camt.053.001.04 / SPS 1.7** (`<AddtlInf>SPS/1.7/PROD</AddtlInf>`), an older
//     generation than the .08 the synthetic tests use. Version is detected by the `<Stmt>` root, not
//     the namespace suffix, so an older minor version must still parse to the Rappen.
//   - a bare `<Sts>BOOK</Sts>` (ZKB) rather than the `<Sts><Cd>BOOK</Cd></Sts>` the synthetic helper
//     writes.
//   - extra balance types `CLAV` (closing available) and `CCRD` alongside `OPBD`/`CLBD`: the parser
//     must surface ONLY OPBD/CLBD and skip the rest without choking.
//   - a QRR creditor reference carried under `<Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR</Prtry>`
//     with a sibling `<AddtlRmtInf>` (bexio structured hints) the parser ignores.
//   - both an entry-level AND a `TxDtls`-level `<AcctSvcrRef>` on one entry (the D81 identity ladder,
//     on the bank's shape), and a card debit carrying `CCRD`/`<PAN>`.
//
// If ZKB ever changes its serialization, these break. That is the point.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCamt, createBankAccount, importCamt } from '../../dist/core/banking/index.js';
import { setup } from '../payments/support.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};

// The account IBAN (the SWIFT registry's Swiss example IBAN), shared by all four statements.
const ZKB_IBAN = 'CH9300762011623852957';

// What each ZKB-shaped statement parses to (invented amounts, reconciled to the Rappen).
const STATEMENTS = [
  {
    file: 'zkb-shape-camt053-01.xml',
    seq: '214', opbd: 964235, clbd: 976082,
    entry: { cd: 'CRDT', amountMinor: 11847, referenceKind: 'none' },
  },
  {
    file: 'zkb-shape-camt053-02.xml',
    seq: '8', opbd: 1021493, clbd: 1012838,
    entry: { cd: 'DBIT', amountMinor: 8655, referenceKind: 'qrr', referenceValue: '210000000003139471430009017' },
  },
  {
    file: 'zkb-shape-camt053-03.xml',
    seq: '23', opbd: 1012838, clbd: 1145384,
    entry: { cd: 'CRDT', amountMinor: 132546, referenceKind: 'none' },
  },
  {
    file: 'zkb-shape-camt053-04.xml',
    seq: '37', opbd: 1145384, clbd: 1081097,
    entry: { cd: 'DBIT', amountMinor: 64287, referenceKind: 'none' },
  },
];

test('every ZKB-shaped camt.053.001.04 statement parses to the exact Rappen, and reconciles OPBD + net = CLBD', () => {
  for (const spec of STATEMENTS) {
    const parsed = ok(parseCamt(read(spec.file)), spec.file);
    const s = parsed.statement;
    assert.equal(s.messageType, 'camt053', `${spec.file}: detected message type`);
    assert.equal(s.iban, ZKB_IBAN, `${spec.file}: account IBAN`);
    assert.equal(s.electronicSeqNb, spec.seq, `${spec.file}: ElctrncSeqNb`);
    assert.equal(s.openingBalanceMinor, spec.opbd, `${spec.file}: OPBD (Rappen)`);
    assert.equal(s.closingBalanceMinor, spec.clbd, `${spec.file}: CLBD (Rappen)`);
    assert.equal(s.balanceCurrency, 'CHF', `${spec.file}: balance currency`);
    assert.equal(s.skipped.length, 0, `${spec.file}: a BOOK entry was skipped: ${JSON.stringify(s.skipped)}`);
    assert.equal(s.entries.length, 1, `${spec.file}: entry count`);

    const [e] = s.entries;
    assert.equal(e.creditDebit, spec.entry.cd, `${spec.file}: CdtDbtInd`);
    assert.equal(e.amountMinor, spec.entry.amountMinor, `${spec.file}: entry amount (Rappen)`);
    assert.equal(e.currency, 'CHF', `${spec.file}: entry currency`);
    assert.equal(e.referenceKind, spec.entry.referenceKind, `${spec.file}: reference kind`);
    if (spec.entry.referenceValue !== undefined) {
      assert.equal(e.referenceValue, spec.entry.referenceValue, `${spec.file}: reference value`);
    }

    // The parser extracted every amount to the Rappen if and only if OPBD + signed net == CLBD.
    const net = (e.creditDebit === 'CRDT' ? 1 : -1) * e.amountMinor;
    assert.equal(s.openingBalanceMinor + net, s.closingBalanceMinor, `${spec.file}: OPBD + net != CLBD`);
  }
});

test('ZKB QRR: the QR creditor reference travels under Prtry=QRR, the AddtlRmtInf sibling is ignored', () => {
  const s = ok(parseCamt(read('zkb-shape-camt053-02.xml'))).statement;
  const [e] = s.entries;
  assert.equal(e.referenceKind, 'qrr');
  assert.equal(e.referenceValue, '210000000003139471430009017');
  assert.equal(e.referenceValue.length, 27, 'a QR reference is 27 digits');
});

test('ZKB extra balance types (CLAV, CCRD) are skipped; only OPBD and CLBD are surfaced', () => {
  // The raw file carries CLAV (and one carries CCRD); the parser must not mistake either for OPBD/CLBD.
  const raw = read('zkb-shape-camt053-01.xml');
  assert.ok(raw.includes('<Cd>CLAV</Cd>'), 'fixture should still carry the CLAV balance');
  const s = ok(parseCamt(raw)).statement;
  assert.equal(s.openingBalanceMinor, 964235);
  assert.equal(s.closingBalanceMinor, 976082);
});

test('ZKB entry+TxDtls AcctSvcrRef: the D81 identity key prefers the entry-level AcctSvcrRef', () => {
  const s = ok(parseCamt(read('zkb-shape-camt053-01.xml'))).statement;
  // Entry-level AcctSvcrRef is TESTREF0000000001 (an invented stand-in for ZKB's order ref); the identity
  // ladder uses `asr:` from the entry level, never the TxDtls-level ref.
  assert.match(s.entries[0].entryKey, /^asr:/, 'entry identity should come from AcctSvcrRef');
});

test('a bare <Sts>BOOK</Sts> (ZKB) is accepted as booked, not skipped as an unsupported status', () => {
  const raw = read('zkb-shape-camt053-01.xml');
  assert.ok(raw.includes('<Sts>BOOK</Sts>'), 'fixture should carry the bare (no <Cd>) status form');
  const s = ok(parseCamt(raw)).statement;
  assert.equal(s.entries.length, 1);
  assert.equal(s.skipped.length, 0);
});

// --- money path: importing the ZKB-shaped statements is idempotent on ROWS -------------------------------

function zkbAccount() {
  const t = setup();
  const bank = ok(
    createBankAccount(t.ctx, {
      name: 'ZKB Geschäftskonto',
      iban: ZKB_IBAN,
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'zkb-bank',
    }),
    'createBankAccount',
  );
  return { ...t, bankAccountId: bank.bankAccountId };
}

test('importing the four ZKB-shaped statements books one bank_txn each, and a re-import is a no-op', () => {
  const t = zkbAccount();
  const countTxns = () =>
    t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const countStatements = () =>
    t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(t.workspaceId).n;

  for (const spec of STATEMENTS) {
    const res = ok(
      importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read(spec.file), idempotencyKey: `zkb-${spec.seq}` }),
      `import ${spec.file}`,
    );
    assert.equal(res.txnCount, 1, `${spec.file}: expected exactly one booked bank_txn`);
    assert.equal(res.duplicate, false, `${spec.file}: first import must not be a duplicate`);
  }
  assert.equal(countTxns(), STATEMENTS.length, 'one bank_txn per statement');
  assert.equal(countStatements(), STATEMENTS.length, 'one bank_statement per file');

  // Re-import every statement under a fresh idempotency key: dedupe is on the CONTENT (Stmt/Id +
  // ElctrncSeqNb + page), not the key, so nothing is booked twice.
  for (const spec of STATEMENTS) {
    ok(
      importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read(spec.file), idempotencyKey: `zkb-${spec.seq}-replay` }),
      `re-import ${spec.file}`,
    );
  }
  assert.equal(countTxns(), STATEMENTS.length, 're-importing the statements doubled the bank_txn rows');
  assert.equal(countStatements(), STATEMENTS.length, 're-importing minted a second bank_statement');
});

test('a ZKB-shaped statement imported into the WRONG account IBAN is refused, and nothing is booked', () => {
  const t = setup();
  const other = ok(
    createBankAccount(t.ctx, {
      name: 'Falsches Konto',
      iban: 'CH4431999123000889012',
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'wrong-bank',
    }),
  );
  const res = importCamt(t.ctx, {
    bankAccountId: other.bankAccountId,
    xml: read('zkb-shape-camt053-01.xml'),
    idempotencyKey: 'zkb-mismatch',
  });
  assert.equal(res.ok, false, 'an IBAN mismatch must be refused');
  assert.equal(res.error, 'iban_mismatch');
  const n = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(n, 0, 'a refused import must book nothing');
});
