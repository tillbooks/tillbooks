// G08's config.json and diagnostics journal are replaced DURABLY (unique temp in the same directory,
// fsync, rename, directory fsync). Before, both wrote a fixed `<file>.tmp` and renamed it with no
// fsync, so a power cut could surface an empty or torn preference file, and the two faces (MCP and
// REST) could interleave on one shared temp name. Clearing the journal syncs the directory so "off
// means gone" survives a power cut too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { supportPaths, readConfig, writeCapture, appendEntry, readJournal, clearJournal, JOURNAL_CAP } from '../../dist/core/support/index.js';
import { withFsEvents } from '../core/fs-event-spy.mjs';

function paths() {
  return supportPaths(mkdtempSync(join(tmpdir(), 'till-support-durable-')));
}

test('writeCapture replaces config.json through a fsynced temp, a rename and a directory fsync, keeping foreign keys', () => {
  const p = paths();
  try {
    writeFileSync(p.configPath, `${JSON.stringify({ futureKey: { keep: true } })}\n`);
    const { result, events } = withFsEvents(() => writeCapture(p, true));
    assert.equal(result.ok, true);
    assert.equal(events.some((e) => e.op === 'writeFile' && e.path === resolve(p.configPath)), false, 'never written in place');
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === resolve(p.configPath));
    assert.ok(rename >= 0);
    assert.notEqual(events[rename].from, resolve(`${p.configPath}.tmp`), 'not the old shared temp name');
    assert.ok(events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === events[rename].from));
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(p.dir)));
    assert.equal(readConfig(p).capture, true);
    assert.deepEqual(readConfig(p).rest, { futureKey: { keep: true } });
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('a crash at the config rename keeps the previous preference readable, and fails private (capture stays off)', () => {
  const p = paths();
  try {
    assert.equal(writeCapture(p, false).ok, true);
    const before = readFileSync(p.configPath, 'utf8');
    const { result } = withFsEvents(() => writeCapture(p, true), {
      beforeRename: () => {
        throw Object.assign(new Error('simulated power cut'), { code: 'EIO' });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'config_not_writable');
    assert.equal(readFileSync(p.configPath, 'utf8'), before);
    assert.equal(readConfig(p).configReadable, true);
    assert.equal(readConfig(p).capture, false);
    assert.deepEqual(readdirSync(p.dir).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('journal compaction replaces the file durably and keeps the newest entries', () => {
  const p = paths();
  try {
    const entry = (i) => ({ at: `2026-09-24T00:00:${String(i % 60).padStart(2, '0')}.000Z`, kind: 'error', message: `e${i}` });
    for (let i = 0; i < JOURNAL_CAP * 2; i += 1) appendEntry(p, entry(i));
    const { events } = withFsEvents(() => appendEntry(p, entry(999)));
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === resolve(p.journalPath));
    assert.ok(rename >= 0, 'the over-long journal was compacted by a rename');
    assert.ok(events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === events[rename].from));
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(p.dir)));
    const read = readJournal(p);
    assert.equal(read.entries.length, JOURNAL_CAP);
    assert.equal(read.entries[read.entries.length - 1].message, 'e999');
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('clearing the journal syncs the directory so the deletion survives a power cut', () => {
  const p = paths();
  try {
    appendEntry(p, { at: '2026-09-24T00:00:00.000Z', kind: 'error', message: 'x' });
    const { events } = withFsEvents(() => clearJournal(p));
    assert.equal(existsSync(p.journalPath), false);
    assert.ok(events.some((e) => e.op === 'fsync' && e.path === resolve(p.dir)));
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
