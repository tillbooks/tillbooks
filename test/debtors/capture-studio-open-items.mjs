/**
 * Re-record the A16 Studio fixtures from the live engine.
 *
 *   npm run build && node test/debtors/capture-studio-open-items.mjs
 *
 * Every file written here is a RECORDING of `studio-open-items-world.mjs`, never a hand-written
 * literal, and `studio-open-items-fixture.test.mjs` replays the same world and fails the moment the
 * two disagree on any VALUE. Keys and kinds are not enough: eight hand-typed account names in three
 * other Studio suites were wrong against the shipped chart while every kind matched.
 */

import { writeFileSync } from 'node:fs';

import { liveOpenItems, liveMixedCurrency, liveMismatch } from './studio-open-items-world.mjs';

const target = (name) => new URL(`../../app/src/surfaces/OpenItems/${name}`, import.meta.url);

function write(name, payload) {
  writeFileSync(target(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`captured ${name}\n`);
}

const healthy = liveOpenItems();
write('list-open-items.fixture.json', healthy.items);
write('aging-report.fixture.json', healthy.aging);
write('customer-balance.fixture.json', healthy.balance);
write('aging-bucket-config.fixture.json', healthy.config);
write('list-open-items.mixed.fixture.json', liveMixedCurrency());
write('list-open-items.mismatch.fixture.json', liveMismatch());
