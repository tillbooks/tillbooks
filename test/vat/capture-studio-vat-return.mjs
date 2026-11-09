/**
 * Re-record the A07 Studio fixtures from the live engine.
 *
 *   npm run build && node test/vat/capture-studio-vat-return.mjs
 *
 * Every file written here is a RECORDING of `studio-vat-return-world.mjs`, never a hand-written
 * literal, and `studio-vat-return-fixture.test.mjs` replays the same world and fails the moment the
 * two disagree on any VALUE. On a tax form that discipline is not a nicety: A07 shipped three
 * filing-grade defects that each came back `reconciled: true`, and a hand-typed fixture would have
 * agreed with every one of them.
 */

import { writeFileSync } from 'node:fs';

import {
  liveEffektivSoll,
  liveDrift,
  liveEmpty,
  liveSaldo,
  liveSaldoSplit,
  liveIstRefusal,
  liveNeedsConfig,
  liveFiled,
  liveSettlement,
} from './studio-vat-return-world.mjs';

const target = (name) => new URL(`../../app/src/surfaces/VatReturn/${name}`, import.meta.url);

function write(name, payload) {
  writeFileSync(target(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`captured ${name}\n`);
}

const healthy = liveEffektivSoll();
write('vat-return.fixture.json', healthy.return);
write('vat-periods.fixture.json', healthy.periods);

write('vat-return.drift.fixture.json', liveDrift());

const empty = liveEmpty();
write('vat-return.empty.fixture.json', empty.return);

const saldo = liveSaldo();
write('vat-return.saldo.fixture.json', saldo.return);
write('vat-periods.saldo.fixture.json', saldo.periods);

write('vat-return.saldo-split.fixture.json', liveSaldoSplit());
write('vat-return.ist-refusal.fixture.json', liveIstRefusal());
write('vat-return.needs-config.fixture.json', liveNeedsConfig().return);

const filed = liveFiled();
write('vat-periods.filed.fixture.json', filed.periods);

const settlement = liveSettlement();
write('vat-settlement.fixture.json', settlement.preview);
write('vat-settlement.posted.fixture.json', settlement.posted);
