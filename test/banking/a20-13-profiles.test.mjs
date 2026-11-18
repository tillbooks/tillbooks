// A20 §13.4 (D205): import profiles as a file format (`till-import-profile/v1`) and a typed built-in
// catalogue checked at load. get_bank_csv_mapping answers the saved mapping as a profile; set_bank_csv_mapping
// takes one, so a mapping exports and imports as a file. No workspace profile table.
//
// SYNTHETIC DATA ONLY: every header and mapping below is invented here (the ZKB headers are the observed
// layout the built-in profile names, no row of any export).

import test from 'node:test';
import assert from 'node:assert/strict';

import { BANK_STATEMENT_PROFILES, profileFor, presetFor, readBankStatementProfile, getBankCsvMapping, setBankCsvMapping, CSV_PRESET_IDS } from '../../dist/core/banking/csvMapping.js';
import { bankCsvPreview } from '../../dist/core/banking/statementImport.js';
import { readImportProfileEnvelope, IMPORT_PROFILE_FORMAT } from '../../dist/core/tabular/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { world, must, refused, secondWorkspace, SAVINGS_IBAN } from './bank-inbox-support.mjs';

const ZKB_HEADERS = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const CUSTOM = { columns: { bookingDate: 'Buchungstag', amount: 'Betrag CHF', text: 'Text' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
let n = 0;
const key = () => `prof-${(n += 1)}`;

test('the built-in catalogue: typed till-import-profile/v1 files, one per known id, each mapping read back at load', () => {
  assert.deepEqual(BANK_STATEMENT_PROFILES.map((p) => p.id), [...CSV_PRESET_IDS]);
  for (const p of BANK_STATEMENT_PROFILES) {
    assert.equal(p.format, IMPORT_PROFILE_FORMAT);
    assert.equal(p.kind, 'bank_statement');
    assert.ok(must(readBankStatementProfile(p)), 'a built-in reads as a profile file');
    for (const h of Object.values(p.mapping.columns)) assert.ok(p.match.headers.includes(h), `${p.id} matches every header it maps`);
  }
  const zkb = profileFor(ZKB_HEADERS);
  assert.equal(zkb.id, 'zkb_account_statement');
  assert.equal(zkb.label, 'ZKB eBanking, Account statement (CSV)');
  assert.deepEqual(presetFor(ZKB_HEADERS).mapping, zkb.mapping, 'the A20 §12 preset is the profile');
  zkb.mapping.columns.bookingDate = 'changed';
  assert.equal(profileFor(ZKB_HEADERS).mapping.columns.bookingDate, 'Date', 'a copy: the catalogue cannot be changed through it');
  assert.equal(profileFor(ZKB_HEADERS.slice(1)), null, 'a file missing one header is not that layout');
});

test('the envelope is checked field by field; a settlement profile is no bank mapping; every mapped column must be matched', () => {
  const good = { format: IMPORT_PROFILE_FORMAT, kind: 'bank_statement', id: 'my_bank', label: 'Meine Bank', match: { headers: ['Buchungstag', 'Betrag CHF', 'Text'] }, mapping: CUSTOM };
  assert.equal(readBankStatementProfile(good).ok, true);
  const cases = [
    [{ ...good, format: 'till-import-profile/v2' }, 'profile.format'],
    [{ ...good, kind: 'something' }, 'profile.kind'],
    [{ ...good, id: 'Has Spaces' }, 'profile.id'],
    [{ ...good, label: '' }, 'profile.label'],
    [{ ...good, match: { headers: [] } }, 'profile.match.headers'],
    [{ ...good, kind: 'settlement_table' }, 'profile.kind'],
    [{ ...good, match: { headers: ['Buchungstag'] } }, 'profile.match.headers'],
    [{ ...good, mapping: { columns: { nope: 'x' }, dateFormat: 'dd.mm.yyyy' } }, 'mapping.columns.nope'],
  ];
  for (const [raw, field] of cases) assert.equal(refused(readBankStatementProfile(raw), 'invalid_input').field, field, field);
  assert.equal(readImportProfileEnvelope({ ...good, kind: 'settlement_table' }).profile.kind, 'settlement_table', 'the envelope itself serves both kinds');
});

test('a mapping exports and imports as a file: get answers the profile, set takes it, the round trip is exact', () => {
  const t = world();
  assert.equal(must(getBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId })).profile, null);
  // A built-in saved as a profile reads back as that built-in.
  must(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, profile: profileFor(ZKB_HEADERS), idempotencyKey: key() }));
  const zkb = must(getBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId }));
  assert.deepEqual([zkb.profile.id, zkb.profile.kind, zkb.profile.format], ['zkb_account_statement', 'bank_statement', IMPORT_PROFILE_FORMAT]);
  assert.deepEqual(zkb.mapping, profileFor(ZKB_HEADERS).mapping);
  // A mapping of the person's own is `custom`, labelled with the Bankkonto's name, and travels to another account.
  must(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: CUSTOM, idempotencyKey: key() }));
  const own = must(getBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId })).profile;
  assert.deepEqual([own.id, own.label, own.match.headers], ['custom', 'Geschäftskonto', ['Buchungstag', 'Betrag CHF', 'Text']]);
  const file = JSON.parse(JSON.stringify(own));
  const other = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: key() }));
  must(setBankCsvMapping(t.ctx, { bankAccountId: other.bankAccountId, profile: file, idempotencyKey: key() }));
  assert.deepEqual(must(getBankCsvMapping(t.ctx, { bankAccountId: other.bankAccountId })).mapping, own.mapping);
});

test('exactly one of mapping or profile; the preview names the profile it recognised; §H-TENANT holds', () => {
  const t = world();
  assert.equal(refused(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: CUSTOM, profile: profileFor(ZKB_HEADERS), idempotencyKey: key() }), 'invalid_input').field, 'mapping');
  assert.equal(refused(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, idempotencyKey: key() }), 'invalid_input').field, 'mapping');
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: `${ZKB_HEADERS.map((h) => `"${h}"`).join(';')}\n"02.03.2026";"x";"";"";"Z1";"";"";"10.00";"02.03.2026";"10.00";"";""\n` }));
  assert.deepEqual(pv.profile, { id: 'zkb_account_statement', label: 'ZKB eBanking, Account statement (CSV)' });
  must(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: CUSTOM, idempotencyKey: key() }));
  const b = secondWorkspace(t);
  refused(getBankCsvMapping(b.ctx, { bankAccountId: t.bankAccountId }), 'needs_bank_account');
  refused(setBankCsvMapping(b.ctx, { bankAccountId: t.bankAccountId, profile: profileFor(ZKB_HEADERS), idempotencyKey: key() }), 'needs_bank_account');
});
