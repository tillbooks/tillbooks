/**
 * E04 joins C00's three integration points, and each is asserted end to end through the REAL verbs
 * (US-E04.5 / US-E04.6, spec §7 "Existing tests that must still pass"):
 *
 *   1. ERASURE: `contacts_anonymise` purges every mail-index row referencing the erased identity
 *      (threads, messages, drafts, custom field values on those threads) in ONE transaction, while
 *      the mail store on disk stays bit-identical. The coverage-drift guard holds C00's purge to
 *      E04's own table list, so a fifth mail table cannot land without joining erasure.
 *   2. MERGE: `contacts_merge` re-points `mail_message.contact_id` and `mail_thread.contact_id`
 *      like any other live FK, so a merged person's mail follows the survivor.
 *   3. TIMELINE: `contacts_timeline` unions indexed mail (subject + direction, NEVER a body) into
 *      the activities read model at query time, and writes zero `contact_activity` rows doing it.
 *
 * All under the OP6 egress probe, like every mail suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { installEgressProbe } from './egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { MAIL_TABLES } = await import('../../dist/core/mail/schema.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore, sampleMessages } = await import('./fixtures.mjs');

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, call };
}

/** A contact with an indexed maildir world, a draft, and a bounded label on the thread. */
function indexedContactWorld() {
  const w = world();
  const contact = w.call('create_contact', {
    partyRole: 'customer',
    name: 'Klient Muster',
    email: 'klient@example.org',
    idempotencyKey: 'ec-ct',
  });
  const root = tempStoreDir();
  const paths = makeMaildirStore(root, sampleMessages());
  const account = w.call('mail_connect', {
    adapter: 'thunderbird',
    storePath: root,
    address: 'praxis@example.ch',
    idempotencyKey: 'ec-conn',
  });
  w.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'ec-re' });
  const thread = w.call('mail_threads_list', { contactId: contact.contact.id }).items[0];
  w.call('mail_draft_write', { threadId: thread.id, body: 'Gerne.', idempotencyKey: 'ec-d' });
  const field = w.call('define_field', {
    entityKind: 'mail_thread',
    key: 'triage',
    labelI18n: { 'de-CH': 'Triage', en: 'Triage' },
    type: 'select',
    options: ['dringend', 'normal'],
    idempotencyKey: 'ec-f',
  });
  // The fixture actor is `agent`, so the def lands as a P8 draft; the human release is part of the
  // real path this fixture drives.
  w.call('confirm_field', { fieldDefId: field.fieldDef.fieldDefId, idempotencyKey: 'ec-fc' });
  w.call('set_field_value', {
    entityKind: 'mail_thread',
    entityId: thread.id,
    fieldKey: 'triage',
    value: 'dringend',
    idempotencyKey: 'ec-v',
  });
  return { ...w, contactId: contact.contact.id, threadId: thread.id, paths, root };
}

test('E04/C00 erasure: contacts_anonymise purges the whole mail identity and touches no store byte', () => {
  const w = indexedContactWorld();
  const storeBytes = readFileSync(w.paths['thread-1-msg-1@example.org']);
  const labelled = w.deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM custom_field_value WHERE entity_kind = 'mail_thread' AND entity_id = ?`)
    .get(w.threadId).n;
  assert.equal(labelled, 1, 'the fixture never labelled its thread, so the purge below proves nothing');

  const erased = w.call('contacts_anonymise', { contactId: w.contactId, idempotencyKey: 'ec-anon' });
  assert.equal(erased.ok, true, JSON.stringify(erased));
  assert.deepEqual(erased.mailPurged, { threads: 1, messages: 3, drafts: 1, fieldValues: 1 });

  // Zero rows referencing the person survive anywhere in the cluster (revDSG Art. 6): a labelled
  // thread erases as completely as an unlabelled one.
  const db = w.deps.store.db;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_thread WHERE contact_id = ?').get(w.contactId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_message WHERE contact_id = ?').get(w.contactId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_draft WHERE thread_id = ?').get(w.threadId).n, 0);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM custom_field_value WHERE entity_kind = 'mail_thread' AND entity_id = ?`).get(w.threadId).n,
    0,
  );
  // The unrelated newsletter thread survives: erasure is scoped to the person, not the account.
  assert.equal(w.call('mail_threads_list', {}).items.length, 1);
  // The mail STORE is bit-identical: TILL erased what TILL derived, and nothing else.
  assert.deepEqual(readFileSync(w.paths['thread-1-msg-1@example.org']), storeBytes);
});

test('E04/C00 erasure-coverage drift guard: every E04 table appears in the purge implementation', () => {
  // The build-time half of US-E04.5's Boundary: adding a table to this cluster without adding it
  // to erasure fails HERE, the same way C00 keeps its merge FK list honest. `mail_account` is the
  // one deliberate absence: it names the OPERATOR's own store and address, never the erased
  // person, so erasing it would destroy the practitioner's setup on a client's deletion request.
  const source = readFileSync(
    fileURLToPath(new URL('../../src/core/mail/mailstore.ts', import.meta.url)),
    'utf8',
  );
  const purge = /export function purgeMailForContact[\s\S]*$/.exec(source)?.[0];
  assert.ok(purge !== undefined, 'purgeMailForContact vanished from mailstore.ts');
  for (const table of MAIL_TABLES) {
    if (table === 'mail_account') continue;
    assert.ok(purge.includes(table), `E04 table ${table} is not named in purgeMailForContact: erasure would leave it behind`);
  }
  assert.ok(purge.includes('custom_field_value'), 'the 6b label values are not purged');
  // And C00 really calls it inside the anonymise transaction, not after it.
  const c00 = readFileSync(fileURLToPath(new URL('../../src/core/sales/contactMerge.ts', import.meta.url)), 'utf8');
  const txBlock = /const tx = ctx\.store\.db\.transaction\(\(\) => \{[\s\S]*?\}\);\s*tx\(\);/.exec(
    /export function anonymiseContact[\s\S]*$/.exec(c00)?.[0] ?? '',
  )?.[0];
  assert.ok(txBlock !== undefined, 'the anonymise transaction block was not found');
  assert.ok(txBlock.includes('purgeMailForContact'), 'the mail purge is not inside the anonymise transaction');
});

test('E04/C00 merge: a merged person’s mail follows the survivor, like every live FK', () => {
  const w = indexedContactWorld();
  const survivor = w.call('create_contact', {
    partyRole: 'customer',
    name: 'Klient Muster (Hauptkonto)',
    email: 'klient.muster@example.org',
    idempotencyKey: 'ec-surv',
  });
  const merged = w.call('contacts_merge', {
    sourceId: w.contactId,
    targetId: survivor.contact.id,
    idempotencyKey: 'ec-merge',
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.merged.repointed['mail_message.contact_id'], 3);
  assert.equal(merged.merged.repointed['mail_thread.contact_id'], 1);
  assert.equal(
    w.call('mail_threads_list', { contactId: survivor.contact.id }).items.length,
    1,
    'the thread did not follow the survivor',
  );
});

test('E04/C00 timeline: indexed mail interleaves with manual activities, subject only, zero OP5 rows', () => {
  const w = indexedContactWorld();
  w.call('contacts_log_activity', {
    contactId: w.contactId,
    kind: 'call',
    body: 'Telefonat zur Terminfrage',
    occurredAt: '2026-07-14T07:00:00.000Z',
    idempotencyKey: 'ec-act',
  });

  const timeline = w.call('contacts_timeline', { contactId: w.contactId });
  assert.equal(timeline.ok, true, JSON.stringify(timeline));
  const mail = timeline.activities.filter((a) => a.source === 'mail');
  const manual = timeline.activities.filter((a) => a.source === undefined);
  assert.equal(mail.length, 3, 'the three indexed messages did not reach the timeline');
  assert.equal(manual.length, 1);
  // Interleaved newest-first: msg-3 (Jul 14 07:30Z) > the call (Jul 14 07:00Z) > msg-2 > msg-1.
  assert.deepEqual(
    timeline.activities.map((a) => a.source ?? 'manual'),
    ['mail', 'manual', 'mail', 'mail'],
    'the union is not interleaved by time',
  );
  // Metadata only, never a body (OP6): a mail entry carries the subject and no body field at all.
  for (const entry of mail) {
    assert.equal(entry.kind, 'email');
    assert.equal('body' in entry, false, 'a mail timeline entry grew a body field');
    assert.ok(typeof entry.subject === 'string');
    assert.ok(entry.direction === 'inbound' || entry.direction === 'outbound');
  }
  // E04 writes ZERO contact_activity rows: the one row is the call logged above.
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM contact_activity WHERE contact_id = ?').get(w.contactId).n,
    1,
  );
  // A manual entry's shape is untouched by the union (the C00 contract E04 must not change).
  assert.deepEqual(Object.keys(manual[0]).sort(), ['body', 'contactId', 'createdAt', 'dealId', 'id', 'kind', 'occurredAt', 'userId']);
});

test('E04/C00 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
