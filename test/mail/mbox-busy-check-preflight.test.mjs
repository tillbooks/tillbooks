// The Thunderbird mbox busy check after critic round 1 (R1-L1, R1-L4): a check that cannot answer
// FAILS CLOSED with a named reason, and the check plus the read of the user's Drafts mbox run BEFORE
// the ledger transaction (`prepareWrite`), with the rename-time change check still the last guard.
// Synthetic mboxes only.
//
// THE SEAM (critic R2-T1). macOS calls `/usr/sbin/lsof` by absolute path, so a fake `lsof` on PATH
// never runs there. The adapter spawns through the `node:child_process` DEFAULT export (the R1-L2
// fix, the object E07's probe wraps), so these tests wrap `childProcess.spawnSync` on that same object
// and answer every `lsof` spawn themselves, on every platform. No PATH, no env var, no production hook.

import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS, MailStoreBusyError, MailStoreChangedError, PreparedDraftWrite, recheckPreparedWrite } from '../../dist/core/mail/adapters.js';

const tb = ADAPTERS.thunderbird;
const SEP = 'From - Thu Jul 16 00:00:00 2026\n';
const USER_DRAFT = `${SEP}From: anna@example.invalid\nSubject: Entwurf Anna\n\nmein eigener Entwurf\n\n`;
const TILL_RAW = 'From: praxis@example.invalid\r\nSubject: Re: Termin\r\nX-Unsent: 1\r\n\r\nGerne Donnerstag.';
// Windows has no lsof: the `parent.lock` open test is the evidence there.
const POSIX = process.platform !== 'win32';

const isLsof = (command) => typeof command === 'string' && /(^|\/)lsof$/.test(command);

/** Run `fn` with every `lsof` spawn answered by `answer(command, argv, options)`; any other spawn passes through. */
function withLsof(answer, fn) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = function fakeSpawnSync(command, argv, options) {
    if (isLsof(command)) return answer(command, argv, options);
    return original.call(this, command, argv, options);
  };
  try {
    return fn();
  } finally {
    childProcess.spawnSync = original;
  }
}

const lsofAnswers = (status, stdout = '') => () => ({ status, stdout, stderr: '', signal: null, pid: 0, output: [] });
const lsofTimesOut = () => ({
  status: null,
  stdout: '',
  stderr: '',
  signal: 'SIGTERM',
  pid: 0,
  output: [],
  error: Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' }),
});

function mbox() {
  const root = mkdtempSync(join(tmpdir(), 'till-mbox-pre-'));
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  return { root, drafts: join(root, 'Drafts') };
}

test('an lsof that fails (an unexpected status) refuses the write as mail_client_unknown, writing nothing', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    const before = readFileSync(m.drafts);
    assert.throws(
      () => withLsof(lsofAnswers(2), () => tb.writeDraft(m.root, TILL_RAW)),
      (e) => e instanceof MailStoreBusyError && e.reason === 'mail_client_unknown' && /status 2/.test(e.evidence),
    );
    assert.ok(readFileSync(m.drafts).equals(before), 'nothing was written');
    // Non-vacuity: an lsof that answers "nobody" (status 1) lets the same write through.
    assert.equal(withLsof(lsofAnswers(1), () => tb.writeDraft(m.root, TILL_RAW)), 'Drafts#1');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an lsof slower than its bound is cut off well under the 5 s busy timeout and refused as mail_client_unknown', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    let timeout;
    assert.throws(
      () => withLsof((_c, _a, options) => ((timeout = options?.timeout), lsofTimesOut()), () => tb.writeDraft(m.root, TILL_RAW)),
      (e) => e instanceof MailStoreBusyError && e.reason === 'mail_client_unknown' && /did not answer within/.test(e.evidence),
    );
    // Node enforces the bound the adapter asks for: it must exist and sit well under the 5 s busy timeout.
    assert.ok(typeof timeout === 'number' && timeout > 0 && timeout < 4000, `lsof was spawned with timeout ${String(timeout)} ms`);
    assert.equal(readFileSync(m.drafts, 'utf8'), USER_DRAFT, 'nothing was written');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('prepareWrite carries a refusal to the write that consumes it, and never throws itself', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    const prepared = withLsof(lsofAnswers(2), () => tb.prepareWrite(m.root));
    assert.ok(prepared instanceof PreparedDraftWrite);
    assert.throws(() => tb.writeDraft(m.root, TILL_RAW, prepared), (e) => e instanceof MailStoreBusyError && e.reason === 'mail_client_unknown');
    assert.equal(readFileSync(m.drafts, 'utf8'), USER_DRAFT, 'nothing was written');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

// --- D172, `mail.mbox_client_guard` (critic R2-M1) -----------------------------------------------------

test('D172 guard refuse_running: an lsof that cannot answer lets the write through and the snapshot names why; a proven holder is still refused', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    const prepared = withLsof(lsofTimesOut, () => tb.prepareWrite(m.root, undefined, 'refuse_running'));
    assert.ok(prepared instanceof PreparedDraftWrite);
    assert.equal(prepared.refusal, undefined);
    assert.match(prepared.unanswered ?? '', /did not answer within/);
    assert.equal(tb.writeDraft(m.root, TILL_RAW, prepared), 'Drafts#1');
    const held = withLsof(lsofAnswers(0, '4242\n'), () => tb.prepareWrite(m.root, undefined, 'refuse_running'));
    assert.throws(() => tb.writeDraft(m.root, TILL_RAW, held), (e) => e instanceof MailStoreBusyError && e.reason === 'mail_client_running');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('D172 guard off: no lsof is asked, and the rename-time change check still refuses a Drafts file that moved', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    let asked = 0;
    const prepared = withLsof(() => ((asked += 1), lsofAnswers(0, '4242\n')()), () => tb.prepareWrite(m.root, undefined, 'off'));
    assert.equal(asked, 0, 'the off guard spawns no lsof');
    assert.equal(prepared.refusal, undefined);
    appendFileSync(m.drafts, `${SEP}From: beat@example.invalid\nSubject: neu\n\nThunderbird hat gespeichert\n\n`);
    assert.throws(() => tb.writeDraft(m.root, TILL_RAW, prepared), (e) => e instanceof MailStoreChangedError);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('D172 guard refuse (the default): prepareWrite without a guard refuses an unanswered check', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    const prepared = withLsof(lsofTimesOut, () => tb.prepareWrite(m.root));
    assert.equal(prepared.guard, 'refuse');
    assert.ok(prepared.refusal instanceof MailStoreBusyError && prepared.refusal.reason === 'mail_client_unknown');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

// --- critic R2-L1: the re-check right before the write -------------------------------------------------

test('recheckPreparedWrite asks lsof again under the same guard: a holder that appeared since the first check is refused, the first read is kept', { skip: POSIX ? false : 'POSIX only' }, () => {
  const m = mbox();
  try {
    const prepared = withLsof(lsofAnswers(1), () => tb.prepareWrite(m.root));
    assert.equal(prepared.refusal, undefined);
    const clear = withLsof(lsofAnswers(1), () => recheckPreparedWrite(prepared));
    assert.equal(clear.refusal, undefined);
    assert.equal(clear.snapshot, prepared.snapshot, 'the rename-time check still compares against the first read');
    const busy = withLsof(lsofAnswers(0, '4242\n'), () => recheckPreparedWrite(prepared));
    assert.throws(() => tb.writeDraft(m.root, TILL_RAW, busy), (e) => e instanceof MailStoreBusyError && e.reason === 'mail_client_running');
    assert.equal(readFileSync(m.drafts, 'utf8'), USER_DRAFT, 'nothing was written');
    assert.equal(recheckPreparedWrite(undefined), undefined);
    assert.equal(recheckPreparedWrite(busy), busy, 'a snapshot that already carries a refusal is returned as it is');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a change to the Drafts mbox after prepareWrite is refused at the rename (the last guard holds)', () => {
  const m = mbox();
  try {
    const prepared = tb.prepareWrite(m.root);
    assert.ok(prepared instanceof PreparedDraftWrite);
    appendFileSync(m.drafts, `${SEP}From: beat@example.invalid\nSubject: neu\n\nThunderbird hat gespeichert\n\n`);
    const before = readFileSync(m.drafts);
    assert.throws(() => tb.writeDraft(m.root, TILL_RAW, prepared), (e) => e instanceof MailStoreChangedError);
    assert.ok(readFileSync(m.drafts).equals(before), 'the change Thunderbird made is kept, nothing was written');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an object posing as a prepared snapshot is ignored: the write checks and reads for itself', () => {
  const m = mbox();
  try {
    const forged = { mboxPath: m.drafts, snapshot: { read: Buffer.alloc(0), readStat: undefined, readHash: 'x' }, refusal: undefined };
    assert.equal(tb.writeDraft(m.root, TILL_RAW, forged), 'Drafts#1');
    assert.match(readFileSync(m.drafts, 'utf8'), /mein eigener Entwurf/, 'the user`s draft was read and kept, not replaced by the forged empty read');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a Maildir store needs no preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'till-maildir-pre-'));
  try {
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(root, 'INBOX', sub), { recursive: true });
    assert.equal(tb.prepareWrite(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
