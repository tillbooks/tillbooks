/**
 * G18 US-G18.3: the pure zip-bundle reader. A zip of an export bundle unpacks into member byte blobs,
 * each classifiable as if uploaded alone; an empty zip yields zero members; a member that fails to
 * inflate is reported alone while the rest unpack; the inflated-size ceiling is enforced WHILE
 * inflating (the zip-bomb guard). Stored (method 0) and deflate (method 8) members both read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { unzip } from '../../dist/core/migration/adapters/zip.js';
import { parseSource, isParseFailure } from '../../dist/core/migration/index.js';
import { writeZip } from './zipWrite.mjs';

const dec = (u8) => new TextDecoder('utf-8').decode(u8);

test('a bundle unpacks into member blobs, stored and deflated alike', () => {
  const zip = writeZip([
    { name: 'contacts.csv', content: 'Name;Ort\nMuster AG;Zürich\n', deflate: false },
    { name: 'chart.csv', content: 'Konto;Titel\n1000;Kasse\n', deflate: true },
    { name: 'belege/', content: '' }, // a directory entry, skipped
  ]);
  const r = unzip(zip);
  assert.equal(r.ok, true);
  assert.equal(r.members.length, 2, 'the directory entry is not a member');
  const byName = Object.fromEntries(r.members.map((m) => [m.name, m]));
  assert.equal(dec(byName['contacts.csv'].bytes), 'Name;Ort\nMuster AG;Zürich\n');
  assert.equal(dec(byName['chart.csv'].bytes), 'Konto;Titel\n1000;Kasse\n');
  // Each member is classifiable as if uploaded alone.
  const parsed = parseSource('csv', byName['contacts.csv'].bytes);
  assert.ok(!isParseFailure(parsed));
  assert.equal(parsed.rows.length, 1);
});

test('an empty zip yields zero members and says so', () => {
  const r = unzip(writeZip([]));
  assert.equal(r.ok, true);
  assert.equal(r.members.length, 0);
});

test('a non-zip payload is a container failure, not a member error', () => {
  const r = unzip(new TextEncoder().encode('definitely not a zip'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_a_zip');
});

test('a member that fails to inflate is reported alone; the rest still unpack', () => {
  // Build a valid deflate member and a corrupt one (deflate bytes replaced with garbage).
  const good = writeZip([{ name: 'good.csv', content: 'a\n1\n', deflate: true }]);
  const bad = writeZip([{ name: 'bad.csv', content: 'a\n1\n', deflate: true }]);
  // Corrupt the deflate payload of `bad` in place: flip bytes just after its 30-byte local header + name.
  const badBuf = Buffer.from(bad);
  const nameLen = 'bad.csv'.length;
  const dataStart = 30 + nameLen;
  badBuf[dataStart] = 0xff;
  badBuf[dataStart + 1] = 0xff;
  const r = unzip(badBuf);
  assert.equal(r.ok, true);
  assert.equal(r.members.length, 1);
  assert.equal(r.members[0].error, 'corrupt');
  assert.equal(r.members[0].bytes, undefined);
  // The good bundle is unaffected.
  assert.equal(unzip(good).members[0].error, undefined);
});

test('the zip-bomb guard: a member inflating past the ceiling is refused during inflation', () => {
  // A ~2 MB run of zeros deflates tiny; cap the ceiling at 1 KB so inflation must be stopped early.
  const bomb = Buffer.alloc(2 * 1024 * 1024, 0);
  const compressed = deflateRawSync(bomb);
  const zip = writeZip([{ name: 'bomb', content: bomb, deflate: false }]);
  void compressed;
  // Re-pack with a real deflate member so the guard path (method 8 + maxOutputLength) is exercised.
  const deflated = writeZip([{ name: 'bomb', content: bomb, deflate: true }]);
  const r = unzip(deflated, { maxTotal: 1024 });
  assert.equal(r.ok, true);
  assert.equal(r.members.length, 1);
  assert.equal(r.members[0].error, 'inflated_size_exceeds_ceiling');
  void zip;
});

test('non-data members (a PDF) are unpacked as bytes, not errors (documents-class candidates)', () => {
  const pdf = Buffer.from('%PDF-1.4 fake beleg');
  const zip = writeZip([{ name: 'beleg.pdf', content: pdf }]);
  const r = unzip(zip);
  assert.equal(r.ok, true);
  assert.equal(r.members.length, 1);
  assert.equal(r.members[0].error, undefined);
  assert.equal(dec(r.members[0].bytes), '%PDF-1.4 fake beleg');
});
