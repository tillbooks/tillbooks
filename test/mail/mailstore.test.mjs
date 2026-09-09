/**
 * E04's engine behaviour: the adapter round trip, the derived index, the self-healing property,
 * staleness, draft write-back idempotency, erasure, and §H-TENANT isolation, ALL UNDER THE OP6
 * EGRESS PROBE (spec §8 "the Art. 321 / OP6 fixture, the one that matters"): the entire loop
 * (connect → reindex → threadsList → threadGet → draftWrite) runs with sockets rigged to fail
 * hard, and the suite's last test asserts the probe recorded ZERO attempts, so no catch anywhere
 * in the engine can have swallowed one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installEgressProbe } from './egress-probe.mjs';

// Installed BEFORE the engine is imported, so even a module-load-time dial-home would be caught.
const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const {
  connectMailStore,
  listMailAccounts,
  reindexMailStore,
  listMailThreads,
  getMailThread,
  writeMailDraft,
  listMailDrafts,
  purgeMailForContact,
  bodySha256,
} = await import('../../dist/core/mail/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore, makeAppleMailStore, makeMboxStore, sampleMessages, rfc822 } =
  await import('./fixtures.mjs');

/** A fresh workspace with a context for direct engine calls, plus the registry for C00 seeding. */
function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, ctx, call };
}

/** A connected + indexed maildir world with a matching C00 contact. */
function indexedWorld() {
  const w = world();
  const contact = w.call('create_contact', {
    partyRole: 'customer',
    name: 'Klient Muster',
    email: 'klient@example.org',
    idempotencyKey: 'mail-ct',
  });
  const root = tempStoreDir();
  const messages = sampleMessages();
  const paths = makeMaildirStore(root, messages);
  const connected = connectMailStore(w.ctx, {
    adapter: 'thunderbird',
    storePath: root,
    address: 'praxis@example.ch',
    idempotencyKey: 'mail-conn',
  });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const reindexed = reindexMailStore(w.ctx, { accountId: connected.accountId, idempotencyKey: 'mail-re1' });
  assert.equal(reindexed.ok, true, JSON.stringify(reindexed));
  return { ...w, root, messages, paths, accountId: connected.accountId, contactId: contact.contact.id, reindexed };
}

test('E04 connect: refuses a missing path, a shapeless path, and a bad adapter, each by name', () => {
  const { ctx } = world();
  const missing = connectMailStore(ctx, { adapter: 'thunderbird', storePath: '/nonexistent/mail', address: 'a@b.ch' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'needs_mailstore');

  const empty = tempStoreDir();
  const shapeless = connectMailStore(ctx, { adapter: 'thunderbird', storePath: empty, address: 'a@b.ch' });
  assert.equal(shapeless.ok, false);
  assert.equal(shapeless.error, 'unknown_mail_adapter');

  const badAdapter = connectMailStore(ctx, { adapter: 'gmail', storePath: empty, address: 'a@b.ch' });
  assert.equal(badAdapter.ok, false);
  assert.equal(badAdapter.error, 'invalid_input', 'a provider name must never become an adapter');
});

test('E04 connect: idempotent under the key AND under the natural (store, address) identity', () => {
  const { ctx } = world();
  const root = tempStoreDir();
  makeMaildirStore(root, sampleMessages());
  const first = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c1' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  const replay = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c1' });
  assert.equal(replay.accountId, first.accountId, 'the same key must answer the original row');
  const rekeyed = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c2' });
  assert.equal(rekeyed.accountId, first.accountId, 'the same store under a new key is still ONE account');
  assert.equal(rekeyed.created, false);

  // A second DIFFERENT account is allowed: mail_account is many-per-workspace (US-E04.1 Boundary).
  const second = tempStoreDir();
  makeMaildirStore(second, sampleMessages('zweit@example.ch'));
  const other = connectMailStore(ctx, { adapter: 'thunderbird', storePath: second, address: 'zweit@example.ch', idempotencyKey: 'c3' });
  assert.equal(other.ok, true);
  assert.equal(other.created, true);
  const listed = listMailAccounts(ctx);
  assert.equal(listed.accounts.length, 2);
});

test('E04 reindex: derives threads and messages, resolves the contact, stores NO body', () => {
  const w = indexedWorld();
  assert.equal(w.reindexed.indexed, 4);
  assert.equal(w.reindexed.skipped, 0);

  const threads = listMailThreads(w.ctx, {});
  assert.equal(threads.ok, true);
  assert.equal(threads.items.length, 2, 'four messages thread into the conversation plus the newsletter');
  const conversation = threads.items.find((t) => t.subject === 'Terminverschiebung');
  assert.ok(conversation !== undefined);
  assert.equal(conversation.messageCount, 3);
  assert.equal(conversation.contactId, w.contactId, 'the sender address resolves to the C00 contact');
  assert.equal(conversation.bucket, 'needs_reply', 'newest message is inbound and no draft exists');

  // OP6 index-never-copy: the raw SQLite rows hold locators and hashes, never the correspondence.
  const rows = w.deps.store.db.prepare('SELECT * FROM mail_message').all();
  assert.equal(rows.length, 4);
  const firstRaw = w.messages[0].raw;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      assert.equal(String(value).includes('Können wir den Termin verschieben'), false, 'a body reached SQLite');
    }
  }
  assert.equal(rows.some((r) => r.body_sha256 === bodySha256(firstRaw)), true, 'the hash is stored instead');
});

test('E04 reindex: an unknown sender stays indexed with a null contact (not an error)', () => {
  const w = indexedWorld();
  const newsletter = listMailThreads(w.ctx, {}).items.find((t) => t.subject === 'Fachzeitschrift Juli');
  assert.ok(newsletter !== undefined);
  assert.equal(newsletter.contactId, null);
});

test('E04 reindex: empty store indexes to zero, malformed messages are skipped and counted', () => {
  const { ctx } = world();
  const root = tempStoreDir();
  makeMaildirStore(root, []);
  const connected = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'a@b.ch', idempotencyKey: 'e1' });
  const empty = reindexMailStore(ctx, { accountId: connected.accountId });
  assert.equal(empty.ok, true);
  assert.equal(empty.indexed, 0);

  // One malformed file must not cost the user their morning (US-E04.2 Error).
  writeFileSync(join(root, 'INBOX', 'cur', 'broken.fixture:2,S'), 'this is not an rfc822 message');
  const partial = reindexMailStore(ctx, { accountId: connected.accountId });
  assert.equal(partial.ok, true);
  assert.equal(partial.indexed, 0);
  assert.equal(partial.skipped, 1);
  assert.deepEqual(Object.keys(partial.skippedReasons), ['unparseable']);
});

test('E04 self-healing: a message deleted in the mail client leaves the index on the next reindex', () => {
  const w = indexedWorld();
  unlinkSync(w.paths['newsletter-7@verlag.example']);
  const again = reindexMailStore(w.ctx, { accountId: w.accountId });
  assert.equal(again.ok, true);
  assert.equal(again.removed, 1, 'the store is the authority and the index is derived');
  const threads = listMailThreads(w.ctx, {});
  assert.equal(threads.items.length, 1, 'the emptied thread went with its last message');
  // And a repeat with nothing changed is a no-op: same index, nothing removed.
  const third = reindexMailStore(w.ctx, { accountId: w.accountId });
  assert.equal(third.removed, 0);
  assert.equal(third.indexed, 3);
});

test('E04 threadGet: bodies come back byte-identical from the store, on demand', () => {
  const w = indexedWorld();
  const thread = listMailThreads(w.ctx, {}).items.find((t) => t.subject === 'Terminverschiebung');
  const got = getMailThread(w.ctx, { threadId: thread.id });
  assert.equal(got.ok, true);
  assert.equal(got.messages.length, 3);
  const bodies = got.messages.map((m) => m.body);
  assert.deepEqual(bodies, [w.messages[0].raw, w.messages[1].raw, w.messages[2].raw], 'byte-identical round trip');
  assert.equal(got.messages.every((m) => m.stale === undefined), true);
});

test('E04 threadGet: a mutated message is flagged stale, a vanished one reports message_moved', () => {
  const w = indexedWorld();
  const thread = listMailThreads(w.ctx, {}).items.find((t) => t.subject === 'Terminverschiebung');

  const mutatedPath = w.paths['thread-1-msg-1@example.org'];
  writeFileSync(mutatedPath, readFileSync(mutatedPath, 'utf8').replace('verschieben', 'absagen'));
  unlinkSync(w.paths['thread-1-msg-3@example.org']);

  const got = getMailThread(w.ctx, { threadId: thread.id });
  assert.equal(got.ok, true, 'the thread still renders the rest (P9)');
  const byId = new Map(got.messages.map((m) => [m.messageId, m]));
  assert.equal(byId.get('thread-1-msg-1@example.org').stale, true, 'a changed body must never come back silently');
  assert.equal(byId.get('thread-1-msg-3@example.org').error, 'message_moved');
  assert.equal(byId.get('thread-1-msg-2@example.ch').stale, undefined);
});

test('E04 draftWrite: one Drafts message per idempotency key, however many times it is called', () => {
  const w = indexedWorld();
  const thread = listMailThreads(w.ctx, {}).items.find((t) => t.subject === 'Terminverschiebung');
  const first = writeMailDraft(w.ctx, { threadId: thread.id, body: 'Gerne Donnerstag 14 Uhr.', idempotencyKey: 'd1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = writeMailDraft(w.ctx, { threadId: thread.id, body: 'Gerne Donnerstag 14 Uhr.', idempotencyKey: 'd1' });
  assert.equal(replay.draftId, first.draftId);

  // Exactly ONE file landed in the Drafts folder: a duplicate draft in a therapist's Drafts
  // folder is a real harm, not a cosmetic one (US-E04.4 Boundary).
  const draftFiles = readdirSync(join(w.root, 'Drafts', 'cur'));
  assert.equal(draftFiles.length, 1);
  const raw = readFileSync(join(w.root, 'Drafts', 'cur', draftFiles[0]), 'utf8');
  assert.match(raw, /To: klient@example\.org/);
  assert.match(raw, /Subject: Re: Terminverschiebung/);
  assert.match(raw, /In-Reply-To: <thread-1-msg-3@example\.org>/);
  assert.match(raw, /Gerne Donnerstag 14 Uhr\./);

  // The row holds the locator and the hash, not the body; the thread now reads as drafted.
  const drafts = listMailDrafts(w.ctx, { threadId: thread.id });
  assert.equal(drafts.drafts.length, 1);
  assert.equal(drafts.drafts[0].bodySha256, bodySha256(raw));
  const after = listMailThreads(w.ctx, {}).items.find((t) => t.id === thread.id);
  assert.equal(after.bucket, 'drafted');
});

test('E04 draftWrite: an unwritable Drafts folder is a structured refusal, never a 500', () => {
  const w = indexedWorld();
  const thread = listMailThreads(w.ctx, {}).items.find((t) => t.subject === 'Terminverschiebung');
  rmSync(w.root, { recursive: true, force: true });
  const refused = writeMailDraft(w.ctx, { threadId: thread.id, body: 'x', idempotencyKey: 'd-broken' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'drafts_not_writable');
  assert.equal(listMailDrafts(w.ctx, {}).drafts.length, 0, 'a refused write persists nothing');
});

test('E04 buckets: an answered thread reads done, a drafted one reads drafted', () => {
  const { ctx } = world();
  const root = tempStoreDir();
  const answered = [
    {
      id: 'q@x.org',
      raw: rfc822({
        from: 'frage@x.org', to: 'praxis@example.ch', subject: 'Frage',
        messageId: 'q@x.org', date: 'Mon, 13 Jul 2026 08:00:00 +0200', body: 'Frage?',
      }),
    },
    {
      id: 'a@example.ch',
      raw: rfc822({
        from: 'praxis@example.ch', to: 'frage@x.org', subject: 'Re: Frage',
        messageId: 'a@example.ch', inReplyTo: 'q@x.org', references: ['q@x.org'],
        date: 'Mon, 13 Jul 2026 09:00:00 +0200', body: 'Antwort.',
      }),
    },
  ];
  makeMaildirStore(root, answered);
  const connected = connectMailStore(ctx, { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'b1' });
  reindexMailStore(ctx, { accountId: connected.accountId });
  const items = listMailThreads(ctx, {}).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].bucket, 'done', 'the newest message is our own reply: nothing to answer');
  assert.deepEqual(listMailThreads(ctx, { bucket: 'needs_reply' }).items, []);
});

test('E04 adapters: Apple Mail .emlx and Thunderbird mbox round-trip the same world', () => {
  for (const [adapter, build] of [
    ['apple_mail', makeAppleMailStore],
    ['thunderbird', makeMboxStore],
  ]) {
    const { ctx } = world();
    const root = tempStoreDir();
    const messages = sampleMessages();
    build(root, messages);
    const connected = connectMailStore(ctx, { adapter, storePath: root, address: 'praxis@example.ch', idempotencyKey: `rt-${adapter}` });
    assert.equal(connected.ok, true, `${adapter}: ${JSON.stringify(connected)}`);
    const indexed = reindexMailStore(ctx, { accountId: connected.accountId });
    assert.equal(indexed.indexed, 4, `${adapter} indexed ${indexed.indexed}`);
    const thread = listMailThreads(ctx, {}).items.find((t) => t.subject === 'Terminverschiebung');
    const got = getMailThread(ctx, { threadId: thread.id });
    // mbox strips trailing newlines per message; compare modulo that, byte-identical otherwise.
    const norm = (s) => s.replace(/\s+$/, '').replace(/\r\n/g, '\n');
    assert.deepEqual(
      got.messages.map((m) => norm(m.body)),
      [norm(messages[0].raw), norm(messages[1].raw), norm(messages[2].raw)],
      `${adapter} round trip`,
    );
    // And the draft lands in the store's own dialect of a Drafts folder.
    const draft = writeMailDraft(ctx, { threadId: thread.id, body: 'Antwort folgt.', idempotencyKey: `rtd-${adapter}` });
    assert.equal(draft.ok, true, `${adapter}: ${JSON.stringify(draft)}`);
  }
});

test('E04 §H-TENANT: a foreign workspace sees nothing and reaches nothing', () => {
  const w = indexedWorld();
  const otherDeps = w.deps;
  const other = mintWorkspace(otherDeps, 'Zweite GmbH', 'ws2');
  const otherCtx = makeContext(otherDeps.store, { workspaceId: other.workspaceId, actor: 'agent', clock: otherDeps.clock, ids: otherDeps.ids });

  assert.deepEqual(listMailAccounts(otherCtx).accounts, []);
  assert.deepEqual(listMailThreads(otherCtx, {}).items, []);
  const thread = listMailThreads(w.ctx, {}).items[0];
  const cross = getMailThread(otherCtx, { threadId: thread.id });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found', 'a foreign id answers exactly as a nonexistent one');
  const crossDraft = writeMailDraft(otherCtx, { threadId: thread.id, body: 'x', idempotencyKey: 'x1' });
  assert.equal(crossDraft.error, 'not_found');
  const crossReindex = reindexMailStore(otherCtx, { accountId: w.accountId });
  assert.equal(crossReindex.error, 'not_found');
});

test('E04 erasure: purgeMailForContact erases every row for the person, and only for the person', () => {
  const w = indexedWorld();
  const thread = listMailThreads(w.ctx, {}).items.find((t) => t.subject === 'Terminverschiebung');
  writeMailDraft(w.ctx, { threadId: thread.id, body: 'Entwurf.', idempotencyKey: 'purge-d' });
  const storeBytes = readFileSync(w.paths['thread-1-msg-1@example.org']);

  const purged = purgeMailForContact(w.ctx, [w.contactId]);
  assert.equal(purged.threads, 1);
  assert.equal(purged.messages, 3);
  assert.equal(purged.drafts, 1);

  const left = listMailThreads(w.ctx, {});
  assert.equal(left.items.length, 1, 'the unrelated newsletter thread survives');
  assert.equal(left.items[0].subject, 'Fachzeitschrift Juli');
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM mail_message WHERE contact_id = ?').get(w.contactId).n, 0);

  // The mail STORE is untouched: TILL erases what TILL derived (US-E04.5 Boundary).
  assert.deepEqual(readFileSync(w.paths['thread-1-msg-1@example.org']), storeBytes);
});

test('E04 OP6: the whole loop above opened ZERO sockets, and the probe was live to see one', () => {
  // The probe was installed before the engine was even imported. If any code path in connect,
  // reindex, threadGet, draftWrite, purge, or a dependency they pull in had dialled out, hard mode
  // would have thrown AND the record below would carry it, catch blocks notwithstanding.
  assert.deepEqual(
    probe.violations.map((v) => `${v.kind} ${v.target}`),
    [],
    'the mail engine attempted egress',
  );
});
