/**
 * Re-record the A08 Studio fixtures from the live engine.
 *
 *   npm run build && node test/reports/capture-studio-reports.mjs
 *
 * Every file written here is a RECORDING of `studio-reports-world.mjs`, never a hand-written literal,
 * and `studio-reports-fixture.test.mjs` replays the same world and fails the moment the two disagree
 * on any VALUE. Keys and kinds are not enough: eight hand-typed account names in three other Studio
 * suites were wrong against the shipped chart while every kind matched, and on a statement surface
 * the same mistake would put a wrong statutory heading on a document a Treuhänder reads.
 */

import { writeFileSync } from 'node:fs';

import {
  liveStatements,
  liveComparison,
  liveEmpty,
  liveLedgerNoMovement,
  liveMismatch,
  liveCsvExport,
} from './studio-reports-world.mjs';

const target = (name) => new URL(`../../app/src/surfaces/Reports/${name}`, import.meta.url);

function write(name, payload) {
  writeFileSync(target(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`captured ${name}\n`);
}

const healthy = liveStatements();
write('trial-balance.fixture.json', healthy.trial);
write('balance-sheet.fixture.json', healthy.balance);
write('income-statement.fixture.json', healthy.income);
write('general-ledger.fixture.json', healthy.ledger);
write('list-accounts.fixture.json', healthy.accounts);

const compared = liveComparison();
write('trial-balance.compare.fixture.json', compared.trial);
write('balance-sheet.compare.fixture.json', compared.balance);
write('income-statement.compare.fixture.json', compared.income);

const empty = liveEmpty();
write('trial-balance.empty.fixture.json', empty.trial);
write('balance-sheet.empty.fixture.json', empty.balance);
write('income-statement.empty.fixture.json', empty.income);

write('general-ledger.no-movement.fixture.json', liveLedgerNoMovement());

const mismatch = liveMismatch();
write('trial-balance.mismatch.fixture.json', mismatch.trial);
write('balance-sheet.mismatch.fixture.json', mismatch.balance);

write('export-statement.csv.fixture.json', liveCsvExport());
