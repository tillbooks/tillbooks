/**
 * Re-record the A17 Studio fixtures from the live engine.
 *
 *   npm run build && node test/purchase/capture-studio-bills.mjs
 *
 * Every file written here is a RECORDING of `studio-bills-world.mjs`, never a hand-written literal,
 * and `studio-bills-fixture.test.mjs` replays the same world and fails the moment the two disagree
 * on any VALUE (the A16 pairing, for the A16 reason: hand-typed fixtures agree with their author).
 */

import { writeFileSync } from 'node:fs';

import { liveBills, liveMismatch, livePreview } from './studio-bills-world.mjs';

const target = (name) => new URL(`../../app/src/surfaces/Bills/${name}`, import.meta.url);

function write(name, payload) {
  writeFileSync(target(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`captured ${name}\n`);
}

write('list-vendor-bills.fixture.json', liveBills().list);
write('list-vendor-bills.mismatch.fixture.json', liveMismatch());
write('vat-preview.fixture.json', livePreview());
