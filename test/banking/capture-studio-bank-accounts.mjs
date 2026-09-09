/**
 * Re-record the A19 Studio fixtures from the live engine.
 *
 *   npm run build && node test/banking/capture-studio-bank-accounts.mjs
 *
 * Every file written here is a RECORDING of `studio-bank-accounts-world.mjs`, never a hand-written
 * literal, and `studio-bank-accounts-fixture.test.mjs` replays the same world and fails the moment
 * the two disagree on any VALUE.
 */

import { writeFileSync } from 'node:fs';

import {
  liveBankAccounts,
  liveQrOnlyRegister,
  livePreviewOpeningBalance,
} from './studio-bank-accounts-world.mjs';

const target = (name) => new URL(`../../app/src/surfaces/BankAccounts/${name}`, import.meta.url);

function write(name, payload) {
  writeFileSync(target(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`captured ${name}\n`);
}

const world = liveBankAccounts();
write('list-bank-accounts.fixture.json', world.active);
write('list-bank-accounts.archived.fixture.json', world.withArchived);
write('get-bank-account.fixture.json', world.one);
write('list-accounts-with-9100.fixture.json', world.chart);
write('list-bank-accounts.qr-only.fixture.json', liveQrOnlyRegister());
write('preview-bank-opening-balance.fixture.json', livePreviewOpeningBalance());
