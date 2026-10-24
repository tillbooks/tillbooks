// The private-data guard and file contract of scripts/marketing-screenshots.mjs. The screenshots ship
// on the public website, so the guard that keeps real books out of them is asserted, not assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  assertDbInsideTemp,
  shotFileName,
  buildManifest,
  SURFACES,
  LOCALES,
  THEMES,
} from '../../scripts/lib/marketing-shots.mjs';

test('a db inside the temp dir is accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-shots-test-'));
  try {
    assert.ok(assertDbInsideTemp(dir, join(dir, 'till.db')).endsWith('till.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real books and anything outside the temp dir are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-shots-test-'));
  try {
    for (const p of [
      join(homedir(), '.till', 'till.db'),
      join(homedir(), '.till', 'till-nomadik.db'),
      join(tmpdir(), 'elsewhere.db'),
      join(dir, '..', 'escape.db'),
      dir,
      '',
      ':memory:',
    ]) {
      assert.throws(() => assertDbInsideTemp(dir, p), /refusing/, p);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink inside the temp dir that points outside it is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-shots-test-'));
  const outside = mkdtempSync(join(tmpdir(), 'till-shots-outside-'));
  try {
    mkdirSync(join(outside, 'books'));
    symlinkSync(join(outside, 'books'), join(dir, 'link'));
    assert.throws(() => assertDbInsideTemp(dir, join(dir, 'link', 'till.db')), /outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('file names follow <surface>-<en|de>-<theme>.webp and reject unknown parts', () => {
  assert.equal(shotFileName('overview', 'de-CH', 'dark'), 'overview-de-dark.webp');
  assert.equal(shotFileName('qr-invoice', 'en', 'light'), 'qr-invoice-en-light.webp');
  assert.throws(() => shotFileName('nope', 'en', 'light'));
  assert.throws(() => shotFileName('overview', 'fr', 'light'));
  assert.throws(() => shotFileName('overview', 'en', 'sepia'));
});

test('every surface carries alt text in every locale, and the manifest picks the image locale', () => {
  for (const s of SURFACES) for (const l of LOCALES) assert.ok(s.alt[l]?.length > 20, `${s.id} ${l}`);
  const entries = [];
  for (const s of SURFACES) for (const l of LOCALES) for (const t of THEMES) {
    entries.push({ file: shotFileName(s.id, l, t), surface: s.id, locale: l, theme: t, width: 2880, height: 1800 });
  }
  const m = buildManifest(entries, { seedToday: '2026-10-20' });
  assert.equal(Object.keys(m.images).length, SURFACES.length * LOCALES.length * THEMES.length);
  assert.equal(m.images['journal-de-light.webp'].alt, SURFACES.find((s) => s.id === 'journal').alt['de-CH']);
  assert.equal(m.images['journal-en-dark.webp'].width, 2880);
});
