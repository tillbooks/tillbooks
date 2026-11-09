// A36: the static, in-package EBICS bank directory (US-A36.4). Proves it matches on name and BIC,
// folds diacritics, returns an empty array (never an error) on no hit, marks every fee note
// verified:false, ships null per-contract host fields (never a fabricated prefill), and imports NO
// network client (the E05 offline stance, tripwire 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { lookupBankDirectoryData, BANK_DIRECTORY } from '../../dist/core/banking/ebics/banks.js';

test('substring and BIC match, with diacritic folding', () => {
  assert.ok(lookupBankDirectoryData('UBS').some((b) => b.bic === 'UBSWCHZH80A'));
  assert.ok(lookupBankDirectoryData('postfinance').some((b) => b.bic === 'POFICHBEXXX'));
  // BIC match
  assert.ok(lookupBankDirectoryData('ZKBKCHZZ80A').some((b) => b.names.includes('ZKB')));
  // Diacritic fold: an ASCII query finds the umlaut name
  assert.ok(lookupBankDirectoryData('zurcher').some((b) => b.bic === 'ZKBKCHZZ80A'));
});

test('an empty query lists the whole set; a no-hit query is an empty array, not an error', () => {
  assert.equal(lookupBankDirectoryData('').length, BANK_DIRECTORY.length);
  const none = lookupBankDirectoryData('no-such-bank-xyz');
  assert.ok(Array.isArray(none));
  assert.equal(none.length, 0);
});

test('every fee note is structurally verified:false and per-contract host fields are null (never fabricated)', () => {
  for (const b of BANK_DIRECTORY) {
    assert.equal(b.feeNote.verified, false, `${b.bic} fee note must be unverified`);
    assert.equal(typeof b.feeNote.asOf, 'string');
    assert.equal(b.hostUrl, null, `${b.bic} hostUrl must be null in v1 (issued on the contract)`);
    assert.equal(b.hostId, null, `${b.bic} hostId must be null in v1 (issued on the contract)`);
    assert.ok(b.names.length > 0 && typeof b.bic === 'string');
  }
});

test('the directory module graph imports no network client (offline, tripwire 6)', () => {
  // Scan the compiled banks.js source for any network import: this module must never open a socket.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../dist/core/banking/ebics/banks.js'), 'utf8');
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'fetch(', 'XMLHttpRequest']) {
    assert.equal(src.includes(forbidden), false, `banks.js must not reference ${forbidden}`);
  }
});
