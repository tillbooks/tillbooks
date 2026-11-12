// Critic round 1 probes for claude/port-aux-durability-2026-10-14 (cd85f3e8): the Thunderbird mbox
// write path and its `lsof` busy check.
//
// `[FINDING ...]` tests assert the behaviour a fix must produce and FAIL on the reviewed head (evidence
// for `docs/critique/port-aux-durability-critic-r1.md`); `[HOLDS]` tests pin a claim that survived.
// A fake `lsof` on PATH stands in for a slow, missing or observed `lsof`; synthetic mboxes only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS, MailStoreBusyError } from '../../dist/core/mail/adapters.js';
import { installEgressProbe } from '../../dist/core/egress/index.js';

const tb = ADAPTERS.thunderbird;
const POSIX = process.platform !== 'win32';
const SEP = 'From - Thu Jul 16 00:00:00 2026\n';
const USER_DRAFT = `${SEP}From: anna@example.invalid\nSubject: Entwurf Anna\n\nmein eigener Entwurf\n\n`;
const TILL_RAW = 'From: praxis@example.invalid\r\nSubject: Re: Termin\r\nMessage-ID: <maildft_1@till.local>\r\nX-Unsent: 1\r\n\r\nGerne Donnerstag.';
const HAS_LSOF = POSIX && spawnSync('lsof', ['-v'], { encoding: 'utf8' }).error === undefined;

/** A directory holding one executable `lsof` with the given shell body. */
function fakeLsof(body) {
  const dir = mkdtempSync(join(tmpdir(), 'till-fake-lsof-'));
  const file = join(dir, 'lsof');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/** Run `fn` with PATH replaced (spawnSync resolves `lsof` through process.env.PATH at call time). */
function withPath(path, fn) {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** A macOS-shaped Thunderbird profile: prefs.js and a `.parentlock`, no Linux `lock` symlink. */
function macProfile() {
  const profile = mkdtempSync(join(tmpdir(), 'till-tb-mac-'));
  writeFileSync(join(profile, 'prefs.js'), '// synthetic profile\n');
  writeFileSync(join(profile, '.parentlock'), '');
  const root = join(profile, 'Mail', 'Local Folders');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  return { profile, root, drafts: join(root, 'Drafts') };
}

/** A child process holding `path` open (as a running Thunderbird holds `.parentlock`) until killed. */
function holdOpen(path) {
  return new Promise((resolveHold, reject) => {
    const child = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(path)}, 'r'); console.log('open'); setInterval(() => {}, 1000);`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.once('data', () => resolveHold(child));
    child.once('error', reject);
  });
}

// --- R1-L1: the busy check FAILS OPEN whenever lsof cannot answer -------------------------------------

test('[FINDING R1-L1] a running Thunderbird on macOS is detected only through lsof; when lsof cannot answer (absent from PATH, timed out) the user`s Drafts mbox is rewritten anyway', { skip: POSIX ? false : 'POSIX only' }, async () => {
  const p = macProfile();
  const holder = await holdOpen(join(p.profile, '.parentlock'));
  const noLsof = mkdtempSync(join(tmpdir(), 'till-no-lsof-'));
  try {
    if (HAS_LSOF) {
      // Non-vacuity: with lsof reachable the same running profile IS refused.
      assert.throws(() => tb.writeDraft(p.root, TILL_RAW), (e) => e instanceof MailStoreBusyError);
    }
    const before = readFileSync(p.drafts);
    let outcome;
    try {
      outcome = withPath(noLsof, () => tb.writeDraft(p.root, TILL_RAW));
    } catch (e) {
      outcome = e;
    }
    assert.ok(
      outcome instanceof Error,
      `with Thunderbird running and lsof unable to answer, the write went through (${String(outcome)}); the file grew ${before.length} -> ${readFileSync(p.drafts).length} bytes`,
    );
    assert.ok(readFileSync(p.drafts).equals(before), 'nothing was written');
  } finally {
    holder.kill();
    rmSync(p.profile, { recursive: true, force: true });
    rmSync(noLsof, { recursive: true, force: true });
  }
});

// --- R1-L2: egress_self_test cannot see the lsof it spawns -------------------------------------------

// Round 2: macOS calls /usr/sbin/lsof by absolute path (the R1-L1 fix), so a fake lsof on PATH never runs there and
// this probe cannot observe anything on darwin. It still bites on Linux; on macOS the same claim is held by
// `[HOLDS R1-L2]` in test/mail/critic-aux-durability-r2.test.mjs through the child_process default-export seam.
const PATH_LSOF = POSIX && process.platform !== 'darwin';

test('[FINDING R1-L2] the E07 egress probe (hard mode, every layer) records the lsof subprocess the mbox write spawns', { skip: PATH_LSOF ? false : 'PATH-resolved lsof only (macOS: see critic-aux-durability-r2 [HOLDS R1-L2])' }, () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'till-lsof-marker-')), 'spawned');
  const shim = fakeLsof(`echo spawned >> '${marker}'\nexit 1`);
  const root = mkdtempSync(join(tmpdir(), 'till-mbox-egress-'));
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  try {
    const probe = installEgressProbe({ hard: true, layers: 'all' });
    try {
      withPath(`${shim}:${process.env.PATH}`, () => tb.writeDraft(root, TILL_RAW));
    } finally {
      probe.uninstall();
    }
    assert.equal(existsSync(marker), true, 'non-vacuity: the mbox write really spawned the lsof found on PATH');
    assert.ok(
      probe.violations.some((v) => v.kind === 'subprocess'),
      `TILL spawned a subprocess during the probe, and the probe recorded ${JSON.stringify(probe.violations)}: egress_self_test reports a clean run over a spawn it exists to intercept`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
    rmSync(join(marker, '..'), { recursive: true, force: true });
  }
});

// --- R1-L4: the ledger's write lock is held across the lsof spawn -------------------------------------

test('[FINDING R1-L4] mail_draft_write holds the ledger write lock across the lsof spawn, so another process`s write fails busy when lsof is slow', { skip: PATH_LSOF ? false : 'PATH-resolved lsof only (macOS: see critic-aux-durability-r2 [HOLDS R1-L4])' }, async () => {
  const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
  const { fixedClock } = await import('../../dist/core/clock.js');
  const { sequenceIdGen } = await import('../../dist/core/ids.js');
  const { makeContext } = await import('../../dist/core/context.js');
  const { connectMailStore, reindexMailStore, listMailThreads, writeMailDraft } = await import('../../dist/core/mail/index.js');
  const { mintWorkspace } = await import('../api/support.mjs');
  const { makeMboxStore, sampleMessages } = await import('./fixtures.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'till-lock-'));
  const ledger = join(dir, 'till.db');
  const started = join(dir, 'lsof-started');
  // A slow lsof (a loaded machine, a large process table): 6 s, inside the 10 s timeout TILL allows.
  const shim = fakeLsof(`touch '${started}'\nsleep 6\nexit 1`);
  const clock = fixedClock('2026-07-16T00:00:00.000Z');
  const deps = { store: new SqliteStore({ location: ledger, clock }), clock, ids: sequenceIdGen(), actor: 'agent' };
  try {
    const { workspaceId } = mintWorkspace(deps);
    const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
    const root = join(dir, 'mail');
    mkdirSync(root);
    makeMboxStore(root, sampleMessages());
    writeFileSync(join(root, 'Drafts'), USER_DRAFT); // the user already has a Drafts mbox (the usual case)
    const connected = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c' });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(reindexMailStore(ctx, { accountId: connected.accountId, idempotencyKey: 'r' }).ok, true);
    const thread = listMailThreads(ctx, {}).items[0];

    // The other face: waits for the lsof spawn, then tries one write with the ledger's 5 s busy timeout.
    const otherScript = `
      const Database = require(${JSON.stringify(fileURLToPath(new URL('../../node_modules/better-sqlite3/lib/index.js', import.meta.url)))});
      const fs = require('fs');
      const until = Date.now() + 20000;
      while (!fs.existsSync(${JSON.stringify(started)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const db = new Database(${JSON.stringify(ledger)}, { timeout: 5000 });
      const t = Date.now();
      try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); console.log(JSON.stringify({ ok: true, waitedMs: Date.now() - t })); }
      catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, waitedMs: Date.now() - t })); }
    `;
    const other = spawn(process.execPath, ['-e', otherScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    other.stdout.on('data', (d) => (out += d));
    const exited = new Promise((r) => other.once('exit', r));

    const written = withPath(`${shim}:${process.env.PATH}`, () => writeMailDraft(ctx, { threadId: thread.id, body: 'Gerne Donnerstag.', idempotencyKey: 'w' }));
    // Adjusted by the implementation (R1-L1 + R1-L4): the lsof spawn is now bounded at 2 s and a busy
    // check that cannot answer FAILS CLOSED, so this 6 s lsof makes the write a named refusal
    // (mail_store_busy, reason mail_client_unknown) instead of a write. Either way the lock question
    // below is the finding.
    assert.ok(
      written.ok === true || (written.error === 'mail_store_busy' && written.reason === 'mail_client_unknown'),
      JSON.stringify(written),
    );
    await exited;
    assert.equal(existsSync(started), true, 'non-vacuity: the draft write spawned the slow lsof');
    const seen = JSON.parse(out.trim());
    assert.equal(seen.ok, true, `the other process's write failed ${seen.code} after ${seen.waitedMs} ms: the IMMEDIATE transaction was held across the lsof spawn (timeout 10 s > busy timeout 5 s)`);
  } finally {
    deps.store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

// --- R1-L5: a crash mid-replace leaves a full hidden copy of the user's Drafts, forever ----------------

test('[FINDING R1-L5] a crash at the mbox rename leaves a hidden full copy of the user`s Drafts beside it, and no later write removes it', { skip: POSIX ? false : 'POSIX only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'till-mbox-crash-'));
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  const adapters = new URL('../../dist/core/mail/adapters.js', import.meta.url).href;
  // A process killed at the rename (power cut, OOM kill, `kill -9`): the temp file is already durable.
  const crash = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(to).endsWith('/Drafts')) process.kill(process.pid, 'SIGKILL'); return rename(from, to); };
    syncBuiltinESMExports();
    const { ADAPTERS } = await import(${JSON.stringify(adapters)});
    ADAPTERS.thunderbird.writeDraft(${JSON.stringify(root)}, ${JSON.stringify(TILL_RAW)});
  `;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', crash], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', `the crash was staged: ${r.stderr}`);
    const strays = () => readdirSync(root).filter((n) => n.startsWith('.Drafts.') && n.endsWith('.tmp'));
    assert.equal(strays().length, 1, 'non-vacuity: the killed write left its temp file');
    assert.match(readFileSync(join(root, strays()[0]), 'utf8'), /mein eigener Entwurf/, 'the temp file is a full copy of the user`s own drafts');

    tb.writeDraft(root, TILL_RAW); // the next, successful write
    assert.deepEqual(strays(), [], 'a second copy of the user`s mail stays in their Thunderbird folder after the next write (OP6: no second copy of the mail)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
