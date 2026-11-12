// The landscape control file and its audit chain are written DURABLY: the audit record is appended
// and fsynced first, then the control file is replaced whole through a temp file, fsync, rename and a
// directory fsync. The old code rewrote environments.json in place with writeFileSync, so a crash
// mid-write could leave a truncated file that readLandscape refuses as unreadable, bricking every
// env_* verb; and neither write was synced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeLandscape, readLandscape, CONTROL_FILE_NAME, AUDIT_FILE_NAME } from '../../dist/core/landscape/index.js';
import { withFsEvents } from '../core/fs-event-spy.mjs';

const AT = '2026-09-24T00:00:00.000Z';

function first(dir) {
  return writeLandscape(
    dir,
    { version: 1, environments: {}, active: 'main' },
    { at: AT, actor: 'owner', action: 'bootstrap', target: 'landscape', outcome: 'bootstrap' },
    null,
  );
}

test('writeLandscape fsyncs the audit append, then replaces the control file via temp + fsync + rename + directory fsync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-control-'));
  try {
    const prior = first(dir);
    const control = resolve(join(dir, CONTROL_FILE_NAME));
    const audit = resolve(join(dir, AUDIT_FILE_NAME));
    const { events } = withFsEvents(() =>
      writeLandscape(dir, { version: 1, environments: {}, active: 'develop' }, { at: AT, actor: 'owner', action: 'env_switch', target: 'develop', outcome: 'switched' }, prior.audit_head),
    );
    assert.equal(events.some((e) => e.op === 'writeFile' && e.path === control), false, 'the control file is never rewritten in place');
    const auditSync = events.findIndex((e) => e.op === 'fsync' && e.path === audit);
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === control);
    assert.ok(auditSync >= 0, 'the audit append was fsynced');
    assert.ok(rename > auditSync, 'the audit record is durable before the control file that names it is published');
    const tmp = events[rename].from;
    assert.equal(resolve(join(tmp, '..')), resolve(dir), 'the temp file lives in the same directory (rename stays atomic)');
    assert.ok(events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === tmp), 'the temp file was fsynced before the rename');
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(dir)), 'the directory was fsynced after the rename');
    assert.equal(readLandscape(dir).active, 'develop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash at the control-file rename leaves the previous control file whole (never truncated) and no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-control-'));
  try {
    const prior = first(dir);
    const control = join(dir, CONTROL_FILE_NAME);
    const before = readFileSync(control, 'utf8');
    assert.throws(
      () =>
        withFsEvents(
          () => writeLandscape(dir, { version: 1, environments: {}, active: 'develop' }, { at: AT, actor: 'owner', action: 'env_switch', target: 'develop', outcome: 'switched' }, prior.audit_head),
          {
            beforeRename: () => {
              throw new Error('simulated power cut');
            },
          },
        ),
      /simulated power cut/,
    );
    assert.equal(readFileSync(control, 'utf8'), before, 'the control file is byte-identical to the last good one');
    assert.doesNotThrow(() => JSON.parse(readFileSync(control, 'utf8')));
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'the temp file was cleaned up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
