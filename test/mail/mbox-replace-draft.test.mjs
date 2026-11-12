// E06 regenerate on a Thunderbird mbox `Drafts` file: the file is the USER'S, holding drafts TILL never
// wrote. `replaceDraft` used to truncate and rewrite it in place (no temp, no fsync) and re-serialise
// every message, so a crash mid-write could wipe all of the user's drafts and even a clean run changed
// bytes TILL never owned. These tests use a SYNTHETIC mbox with invented foreign drafts (no real mail).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ADAPTERS, DraftGoneError, MailStoreBusyError, MailStoreChangedError } from '../../dist/core/mail/adapters.js';
import { withFsEvents } from '../core/fs-event-spy.mjs';

const tb = ADAPTERS.thunderbird;
const SEP = 'From - Thu Jul 16 00:00:00 2026\n';

/** Three invented foreign drafts around TILL's draft at index 1, with the bytes a naive rewrite breaks. */
function foreignMbox() {
  const latin1Body = Buffer.concat([
    Buffer.from('From: anna@example.invalid\nSubject: Entwurf Anna\nContent-Type: text/plain; charset=iso-8859-1\n\nGr', 'latin1'),
    Buffer.from([0xfc, 0xdf]), // "üß" in Latin-1: invalid as UTF-8, mangled by a utf8 round trip
    Buffer.from('e aus Bern\n\n', 'latin1'),
  ]);
  const escaped = Buffer.from('From: beat@example.invalid\r\nSubject: Entwurf Beat\r\n\r\nZeile eins\r\n>>From the archive, twice escaped\r\n\r\n', 'latin1');
  const till = Buffer.from('From: praxis@example.invalid\nSubject: Re: Termin\nMessage-ID: <draft_1.run_1@till.local>\nX-Unsent: 1\n\nalter TILL-Entwurf\n\n', 'utf8');
  const last = Buffer.from('From: carla@example.invalid\nSubject: Entwurf Carla\n\nohne Leerzeile am Ende', 'utf8');
  const parts = [Buffer.from('X-Mozilla-Preamble: kept\n'), Buffer.from(SEP), latin1Body, Buffer.from(SEP), till, Buffer.from(SEP), escaped, Buffer.from(SEP), last];
  return { bytes: Buffer.concat(parts), latin1Body, escaped, last };
}

function store() {
  const root = mkdtempSync(join(tmpdir(), 'till-mbox-'));
  const { bytes, latin1Body, escaped, last } = foreignMbox();
  const drafts = join(root, 'Drafts');
  writeFileSync(drafts, bytes);
  chmodSync(drafts, 0o600);
  return { root, drafts, bytes, latin1Body, escaped, last };
}

/** TILL's draft in the synthetic mbox: its Message-ID proves it (the body hash is not needed here). */
const TILL_ID = { draftId: 'draft_1', bodySha256: 'not-used' };

const NEW_DRAFT = 'From: praxis@example.invalid\r\nSubject: Re: Termin\r\nX-Unsent: 1\r\n\r\nneuer Entwurf\r\nFrom here on, escaped\r\n';

test('replaceDraft rewrites ONLY its own message; every foreign draft survives byte for byte, and the mode is kept', () => {
  const s = store();
  try {
    const ref = tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID);
    assert.equal(ref, 'Drafts#1', 'the positional locator is stable');
    const after = readFileSync(s.drafts);
    assert.ok(after.subarray(0, s.bytes.indexOf(SEP) + SEP.length + s.latin1Body.length).equals(s.bytes.subarray(0, s.bytes.indexOf(SEP) + SEP.length + s.latin1Body.length)), 'the preamble and the Latin-1 draft are byte-identical');
    assert.ok(after.includes(s.escaped), 'the CRLF draft with a twice-escaped >>From line is byte-identical');
    assert.ok(after.subarray(after.length - s.last.length).equals(s.last), 'the last draft (no trailing newline) is byte-identical');
    assert.equal(after.includes(Buffer.from('alter TILL-Entwurf')), false, 'the old TILL draft is gone');
    assert.match(tb.readBody(s.root, 'Drafts#1'), /neuer Entwurf/);
    assert.match(tb.readBody(s.root, 'Drafts#1'), /\n>?From here on, escaped/);
    assert.match(tb.readBody(s.root, 'Drafts#2'), /Entwurf Beat/, 'the other locators did not shift');
    if (process.platform !== 'win32') assert.equal(statSync(s.drafts).mode & 0o777, 0o600, 'the file mode is preserved');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the mbox is never written in place: temp in the same directory, fsync, rename, directory fsync', () => {
  const s = store();
  try {
    const { events } = withFsEvents(() => tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID));
    const drafts = resolve(s.drafts);
    assert.equal(events.some((e) => (e.op === 'writeFile' || e.op === 'truncate') && e.path === drafts), false, 'no in-place truncate or rewrite');
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === drafts);
    assert.ok(rename >= 0);
    assert.equal(resolve(events[rename].from, '..'), resolve(s.root), 'the temp file is in the same directory');
    assert.ok(events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === events[rename].from));
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(s.root)));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a crash at the rename leaves the user`s mbox byte-identical and no temp file behind', () => {
  const s = store();
  try {
    assert.throws(() =>
      withFsEvents(() => tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID), {
        beforeRename: () => {
          throw new Error('simulated power cut');
        },
      }),
    );
    assert.ok(readFileSync(s.drafts).equals(s.bytes));
    assert.deepEqual(readdirSync(s.root), ['Drafts']);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a draft saved into the mbox between TILL`s read and its write is never overwritten: refused, nothing written', () => {
  const s = store();
  try {
    const drafts = resolve(s.drafts);
    let appended = false;
    assert.throws(
      () =>
        withFsEvents(() => tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID), {
          afterFsync: (path) => {
            // The temp file just became durable; Thunderbird saves a draft before the rename.
            if (!appended && path !== drafts && path.endsWith('.tmp')) {
              appended = true;
              appendFileSync(s.drafts, `${SEP}From: dora@example.invalid\nSubject: Entwurf Dora\n\nneu gespeichert\n\n`);
            }
          },
        }),
      (e) => e instanceof MailStoreChangedError,
    );
    assert.equal(appended, true, 'the race was really staged');
    const after = readFileSync(s.drafts, 'latin1');
    assert.match(after, /Entwurf Dora/, 'the draft saved meanwhile is still there');
    assert.match(after, /alter TILL-Entwurf/, 'TILL wrote nothing');
    assert.deepEqual(readdirSync(s.root), ['Drafts']);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

/** A child process that holds `path` open until killed; resolves once the file is open. */
function holdOpen(path) {
  return new Promise((resolveHold, reject) => {
    const child = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(path)}, 'r'); console.log('open'); setInterval(() => {}, 1000);`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.once('data', () => resolveHold(child));
    child.once('error', reject);
  });
}

const HAS_LSOF = process.platform !== 'win32' && spawnSync('lsof', ['-v'], { encoding: 'utf8' }).error === undefined;

test('refused, nothing written, when another process (Thunderbird) holds the Drafts mbox open', { skip: HAS_LSOF ? false : 'lsof is not available here' }, async () => {
  const s = store();
  const child = await holdOpen(s.drafts);
  try {
    assert.throws(() => tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID), (e) => e instanceof MailStoreBusyError && /pid/.test(e.message));
    assert.ok(readFileSync(s.drafts).equals(s.bytes));
    assert.deepEqual(readdirSync(s.root), ['Drafts']);
  } finally {
    child.kill();
    rmSync(s.root, { recursive: true, force: true });
  }
  // Non-vacuity: with the holder gone, the same replace goes through.
  const t = store();
  try {
    tb.replaceDraft(t.root, 'Drafts#1', NEW_DRAFT, TILL_ID);
    assert.match(tb.readBody(t.root, 'Drafts#1'), /neuer Entwurf/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('refused when the Thunderbird PROFILE the mbox lives in is running (the profile lock holds a live pid)', { skip: process.platform === 'win32' ? 'POSIX lock symlink' : false }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'till-tb-profile-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    writeFileSync(join(profile, 'prefs.js'), '// synthetic profile\n');
    const root = join(profile, 'Mail', 'Local Folders');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'Drafts'), foreignMbox().bytes);
    const before = readFileSync(join(root, 'Drafts'));
    symlinkSync(`127.0.0.1:+${child.pid}`, join(profile, 'lock'));
    assert.throws(() => tb.replaceDraft(root, 'Drafts#1', NEW_DRAFT, TILL_ID), (e) => e instanceof MailStoreBusyError && /running/.test(e.message));
    assert.ok(readFileSync(join(root, 'Drafts')).equals(before));
    // A STALE lock (its pid gone) is not a running Thunderbird.
    child.kill();
    await new Promise((r) => child.once('exit', r));
    tb.replaceDraft(root, 'Drafts#1', NEW_DRAFT, TILL_ID);
    assert.match(tb.readBody(root, 'Drafts#1'), /neuer Entwurf/);
  } finally {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});

// --- writeDraft: the same durability and refusal rules (item E), and the API errors (item D) --------

test('writeDraft appends to the user`s mbox through temp + fsync + rename, keeping every foreign draft and the mode', () => {
  const s = store();
  try {
    const drafts = resolve(s.drafts);
    const { result: ref, events } = withFsEvents(() => tb.writeDraft(s.root, NEW_DRAFT));
    assert.equal(ref, 'Drafts#4', 'the new draft is the fifth message');
    assert.equal(events.some((e) => (e.op === 'writeFile' || e.op === 'truncate') && e.path === drafts), false, 'no in-place write');
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === drafts);
    assert.ok(rename >= 0 && events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === events[rename].from));
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(s.root)));
    const after = readFileSync(s.drafts);
    assert.ok(after.subarray(0, s.bytes.length).equals(s.bytes), 'every existing byte is kept, the draft is appended');
    assert.match(tb.readBody(s.root, ref), /neuer Entwurf/);
    if (process.platform !== 'win32') assert.equal(statSync(s.drafts).mode & 0o777, 0o600);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('writeDraft creates a missing mbox Drafts file as 0600, and refuses while Thunderbird runs on the profile', { skip: process.platform === 'win32' ? 'POSIX lock symlink' : false }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'till-tb-profile-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    writeFileSync(join(profile, 'prefs.js'), '// synthetic profile\n');
    const root = join(profile, 'Mail', 'Local Folders');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'INBOX'), `${SEP}From: a@example.invalid\n\nhallo\n\n`);
    symlinkSync(`127.0.0.1:+${child.pid}`, join(profile, 'lock'));
    assert.throws(() => tb.writeDraft(root, NEW_DRAFT), (e) => e instanceof MailStoreBusyError);
    assert.deepEqual(readdirSync(root).sort(), ['INBOX'], 'nothing was written');
    child.kill();
    await new Promise((r) => child.once('exit', r));
    assert.equal(tb.writeDraft(root, NEW_DRAFT), 'Drafts#0');
    assert.equal(statSync(join(root, 'Drafts')).mode & 0o777, 0o600);
  } finally {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a Maildir draft is staged under tmp/, renamed into cur/, and cur/ is fsynced', () => {
  const root = mkdtempSync(join(tmpdir(), 'till-maildir-'));
  try {
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(root, 'INBOX', sub), { recursive: true });
    writeFileSync(join(root, 'INBOX', 'cur', '1.x:2,S'), 'From: a@example.invalid\n\nhallo\n');
    const { result: ref, events } = withFsEvents(() => tb.writeDraft(root, NEW_DRAFT));
    const file = resolve(root, ref);
    assert.match(ref, /^Drafts[\\/]cur[\\/]/);
    const into = events.findIndex((e) => e.op === 'rename' && e.to === file);
    assert.ok(into >= 0);
    assert.match(events[into].from, /[\\/]Drafts[\\/]tmp[\\/]/, 'delivered from tmp/, the Maildir way');
    assert.ok(events.slice(into + 1).some((e) => e.op === 'fsync' && e.path === resolve(root, 'Drafts', 'cur')), 'cur/ was fsynced after the move');
    assert.equal(readFileSync(file, 'utf8'), NEW_DRAFT);
    assert.deepEqual(readdirSync(join(root, 'Drafts', 'tmp')), [], 'nothing is left in tmp/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an Apple Mail draft is written through a fsynced temp and a rename, then the folder is fsynced', () => {
  const root = mkdtempSync(join(tmpdir(), 'till-applemail-'));
  try {
    const { result: ref, events } = withFsEvents(() => ADAPTERS.apple_mail.writeDraft(root, NEW_DRAFT));
    const file = resolve(root, ref);
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === file);
    assert.ok(rename >= 0 && events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === events[rename].from));
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(file, '..')));
    assert.equal(events.some((e) => e.op === 'writeFile' && e.path === file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the draft verbs answer mail_store_busy and mail_store_changed by name, writing nothing, instead of drafts_not_writable', { skip: process.platform === 'win32' ? 'POSIX lock symlink' : false }, async () => {
  const { makeContext } = await import('../../dist/core/context.js');
  const { connectMailStore, reindexMailStore, listMailThreads, writeMailDraft, replaceMailDraft } = await import('../../dist/core/mail/index.js');
  const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
  const { makeMboxStore, sampleMessages } = await import('./fixtures.mjs');

  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const profile = mkdtempSync(join(tmpdir(), 'till-tb-profile-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    writeFileSync(join(profile, 'prefs.js'), '// synthetic profile\n');
    const root = join(profile, 'Mail', 'Local Folders');
    mkdirSync(root, { recursive: true });
    makeMboxStore(root, sampleMessages());
    const connected = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c' });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(reindexMailStore(ctx, { accountId: connected.accountId, idempotencyKey: 'r' }).ok, true);
    const thread = listMailThreads(ctx, {}).items[0];
    const drafts = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM mail_draft').get().n;

    symlinkSync(`127.0.0.1:+${child.pid}`, join(profile, 'lock'));
    const busy = writeMailDraft(ctx, { threadId: thread.id, body: 'Gerne Donnerstag.', idempotencyKey: 'w1' });
    assert.equal(busy.ok, false);
    assert.equal(busy.error, 'mail_store_busy');
    assert.match(busy.evidence, /running/);
    assert.equal(drafts(), 0, 'no draft row for a refused write');
    rmSync(join(profile, 'lock'));

    const written = writeMailDraft(ctx, { threadId: thread.id, body: 'Gerne Donnerstag.', idempotencyKey: 'w2' });
    assert.equal(written.ok, true, JSON.stringify(written));

    // The Drafts file changes between the read and the rename (Thunderbird saved a draft meanwhile).
    const draftsFile = join(root, 'Drafts');
    let raced = false;
    const { result: changed } = withFsEvents(
      () => replaceMailDraft(ctx, { draftId: written.draftId, body: 'Lieber Freitag.', idempotencyKey: 'rp1' }),
      {
        afterFsync: (path) => {
          if (!raced && path.endsWith('.tmp')) {
            raced = true;
            appendFileSync(draftsFile, `${SEP}From: dora@example.invalid\n\nneu\n\n`);
          }
        },
      },
    );
    assert.equal(raced, true);
    assert.equal(changed.ok, false);
    assert.equal(changed.error, 'mail_store_changed');
    assert.match(readFileSync(draftsFile, 'utf8'), /Gerne Donnerstag/, 'the previous draft is untouched');
  } finally {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});

// --- identity, not position (critic F1) ---------------------------------------------------------------

test('after a compaction shifted the locator onto the USER`s draft, replace finds TILL`s draft by identity and leaves the user`s draft alone', () => {
  const s = store();
  try {
    // The user deletes the Latin-1 draft at #0 in Thunderbird and the folder is compacted: TILL's
    // draft moves to #0 and #1 now names the user's CRLF draft.
    const offsets = [];
    for (let i = s.bytes.indexOf(SEP); i !== -1; i = s.bytes.indexOf(SEP, i + 1)) offsets.push(i);
    const compacted = Buffer.concat([s.bytes.subarray(0, offsets[0]), s.bytes.subarray(offsets[1])]);
    writeFileSync(s.drafts, compacted);
    const ref = tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID);
    assert.equal(ref, 'Drafts#0', 'the locator follows the draft to where it really is');
    const after = readFileSync(s.drafts);
    assert.ok(after.includes(s.escaped), 'the user`s CRLF draft at the old locator is byte-identical');
    assert.match(tb.readBody(s.root, 'Drafts#0'), /neuer Entwurf/);
    assert.equal(after.includes(Buffer.from('alter TILL-Entwurf')), false);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('when TILL`s draft is gone from the mbox (sent), replace refuses with DraftGoneError and writes nothing', () => {
  const s = store();
  try {
    const offsets = [];
    for (let i = s.bytes.indexOf(SEP); i !== -1; i = s.bytes.indexOf(SEP, i + 1)) offsets.push(i);
    const sent = Buffer.concat([s.bytes.subarray(0, offsets[1]), s.bytes.subarray(offsets[2])]);
    writeFileSync(s.drafts, sent);
    assert.throws(() => tb.replaceDraft(s.root, 'Drafts#1', NEW_DRAFT, TILL_ID), (e) => e instanceof DraftGoneError);
    assert.ok(readFileSync(s.drafts).equals(sent), 'nothing was written');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the critic`s repro: TILL draft #0, user saves own draft #1, user sends TILL`s draft; replace answers draft_gone and the user`s draft survives', async () => {
  const { makeContext } = await import('../../dist/core/context.js');
  const { connectMailStore, reindexMailStore, listMailThreads, writeMailDraft, replaceMailDraft } = await import('../../dist/core/mail/index.js');
  const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
  const { makeMboxStore, sampleMessages } = await import('./fixtures.mjs');
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const root = mkdtempSync(join(tmpdir(), 'till-mbox-shift-'));
  try {
    makeMboxStore(root, sampleMessages());
    const c = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c' });
    assert.equal(reindexMailStore(ctx, { accountId: c.accountId, idempotencyKey: 'r' }).ok, true);
    const thread = listMailThreads(ctx, {}).items[0];
    const w = writeMailDraft(ctx, { threadId: thread.id, body: 'TILL Entwurf eins', idempotencyKey: 'w' });
    assert.equal(w.ok, true, JSON.stringify(w));
    const draftsFile = join(root, 'Drafts');
    const userDraft = `${SEP}From: praxis@example.ch\nSubject: Privat, erfunden\n\nUSER OWN DRAFT - must survive\n\n`;
    writeFileSync(draftsFile, readFileSync(draftsFile, 'latin1') + userDraft, 'latin1');
    // The user sends TILL's draft from Thunderbird: after compaction it has left Drafts, and #0 is theirs.
    const bytes = readFileSync(draftsFile, 'utf8');
    writeFileSync(draftsFile, bytes.slice(bytes.indexOf('From - ', 1)));
    const before = readFileSync(draftsFile);

    const r = replaceMailDraft(ctx, { draftId: w.draftId, body: 'TILL Entwurf zwei', idempotencyKey: 'rp' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'draft_gone');
    assert.ok(readFileSync(draftsFile).equals(before), 'the user`s own draft is untouched, byte for byte');

    // And when TILL's draft is still there, only behind the user's draft, it is found and replaced.
    const w2 = writeMailDraft(ctx, { threadId: thread.id, body: 'TILL Entwurf drei', idempotencyKey: 'w2' });
    assert.equal(w2.ok, true);
    const ok2 = replaceMailDraft(ctx, { draftId: w2.draftId, body: 'TILL Entwurf vier', idempotencyKey: 'rp2' });
    assert.equal(ok2.ok, true, JSON.stringify(ok2));
    const final = readFileSync(draftsFile, 'utf8');
    assert.match(final, /USER OWN DRAFT - must survive/);
    assert.match(final, /TILL Entwurf vier/);
    assert.doesNotMatch(final, /TILL Entwurf drei/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Maildir and Apple Mail replace only a file that proves to be TILL`s draft; a renamed draft is found, a foreign file is never removed', () => {
  // Maildir: the client renamed TILL's draft (a flag change); the stored locator now names nothing.
  const root = mkdtempSync(join(tmpdir(), 'till-maildir-id-'));
  try {
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(root, 'INBOX', sub), { recursive: true });
    const ref = tb.writeDraft(root, 'From: praxis@example.invalid\nMessage-ID: <draft_9@till.local>\n\nalt\n');
    const renamed = resolve(root, `${ref}S`);
    renameSync(resolve(root, ref), renamed);
    writeFileSync(join(root, 'Drafts', 'cur', '1.user:2,D'), 'From: praxis@example.invalid\n\nUSER OWN DRAFT\n');
    const newRef = tb.replaceDraft(root, ref, 'From: praxis@example.invalid\nMessage-ID: <draft_9.r2@till.local>\n\nneu\n', { draftId: 'draft_9', bodySha256: 'x' });
    assert.equal(existsSync(renamed), false, 'the renamed TILL draft was the one replaced');
    assert.match(readFileSync(resolve(root, newRef), 'utf8'), /neu/);
    assert.equal(readFileSync(join(root, 'Drafts', 'cur', '1.user:2,D'), 'utf8'), 'From: praxis@example.invalid\n\nUSER OWN DRAFT\n');
    // A locator that names the user's file is refused rather than obeyed.
    assert.throws(() => tb.replaceDraft(root, 'Drafts/cur/1.user:2,D', 'x', { draftId: 'draft_404', bodySha256: 'y' }), (e) => e instanceof DraftGoneError);
    assert.ok(existsSync(join(root, 'Drafts', 'cur', '1.user:2,D')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const apple = mkdtempSync(join(tmpdir(), 'till-apple-id-'));
  try {
    const mine = ADAPTERS.apple_mail.writeDraft(apple, 'From: praxis@example.invalid\nMessage-ID: <draft_7@till.local>\n\nalt\n');
    const users = ADAPTERS.apple_mail.writeDraft(apple, 'From: praxis@example.invalid\n\nUSER OWN DRAFT\n');
    // The locator wrongly names the user's file: it is not TILL's, so TILL's own draft is looked up.
    const newRef = ADAPTERS.apple_mail.replaceDraft(apple, users, 'From: praxis@example.invalid\nMessage-ID: <draft_7.r2@till.local>\n\nneu\n', { draftId: 'draft_7', bodySha256: 'y' });
    assert.match(ADAPTERS.apple_mail.readBody(apple, newRef), /neu/);
    assert.throws(() => ADAPTERS.apple_mail.replaceDraft(apple, users, 'x', { draftId: 'draft_404', bodySha256: 'y' }), (e) => e instanceof DraftGoneError);
    assert.ok(existsSync(resolve(apple, users)), 'the user`s draft file was not removed');
    assert.equal(existsSync(resolve(apple, mine)), false, 'the locator was wrong, but TILL`s own draft was found and replaced');
  } finally {
    rmSync(apple, { recursive: true, force: true });
  }
});

test('locateDraft reads by identity: after a compaction it returns TILL`s draft and its new locator, never the message now at the old position', () => {
  const s = store();
  try {
    const offsets = [];
    for (let i = s.bytes.indexOf(SEP); i !== -1; i = s.bytes.indexOf(SEP, i + 1)) offsets.push(i);
    writeFileSync(s.drafts, Buffer.concat([s.bytes.subarray(0, offsets[0]), s.bytes.subarray(offsets[1])]));
    assert.match(tb.readBody(s.root, 'Drafts#1'), /Entwurf Beat/, 'positionally, #1 is now the user`s draft');
    const found = tb.locateDraft(s.root, 'Drafts#1', TILL_ID);
    assert.equal(found.storeRef, 'Drafts#0');
    assert.match(found.raw, /alter TILL-Entwurf/);
    // Gone: TILL's draft removed from the folder.
    const now = readFileSync(s.drafts);
    const at = [];
    for (let i = now.indexOf(SEP); i !== -1; i = now.indexOf(SEP, i + 1)) at.push(i);
    writeFileSync(s.drafts, Buffer.concat([now.subarray(0, at[0]), now.subarray(at[1])]));
    assert.equal(tb.locateDraft(s.root, 'Drafts#0', TILL_ID), undefined);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
