/**
 * The Art. 321 prompt-containment fixture (spec §8), the E05 sentinel scan extended to E06's
 * whole composition path: after a full GROUNDED generate whose prompt provably carried both the
 * client's words and a ledger figure, a byte-scan of the raw SQLite file finds ZERO trace of
 * either composition input. The prompt existed in memory, for the length of one call.
 *
 * Two sentinels, one per source of secrecy:
 *   - the MAIL sentinel rides the client's message body. It reaches the prompt (asserted) and the
 *     completion (the recording adapter quotes the prompt tail) and the Drafts FOLDER (where it
 *     belongs, beside the mail it answers), and must never reach the DATABASE: not via a
 *     draft_run column, not via the idempotency replay row, not via any stray path.
 *   - the LEDGER sentinel is the FORMATTED figure `CHF 4'271.93`. The books legitimately hold the
 *     integer 427193; the formatted string exists only in the prompt and factsUsed, so a raw-file
 *     hit could only be a persisted composition string. (The spec's original "ledger memo"
 *     phrasing is reconciled: a memo lives in the journal by design, so the honest sentinel is
 *     the string only the COMPOSITION produces.)
 *
 * Under the OP6 egress probe like every suite in this cluster.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');
const { registerRuntime, resetRuntimeRegistration } = await import('../../dist/core/voice/index.js');
const { tempStoreDir, makeMaildirStore } = await import('../mail/fixtures.mjs');
const { stubManifest, outboundCorpus } = await import('../voice/fixtures.mjs');
const { recordingAdapter, inboundAsk } = await import('./fixtures.mjs');

test('E06 Art. 321: a grounded generate leaves no composition byte in the SQLite file', () => {
  const mailSentinel = 'SENTINEL-321-E06-Zwischenstand-vom-neunten-September';
  const ledgerSentinel = "4'271.93"; // the FORMATTED figure: only the composition produces it

  const location = join(mkdtempSync(join(tmpdir(), 'till-e06-db-')), 'till.sqlite');
  const store = new SqliteStore({ location, clock: fixedClock('2026-07-16T00:00:00.000Z') });
  const deps = { store, clock: fixedClock('2026-07-16T00:00:00.000Z'), ids: sequenceIdGen(), actor: 'agent' };
  const created = getAction('create_workspace').run(deps, { name: 'Sentinel Praxis', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId: created.workspaceId, ...input });

  const { adapter, prompts } = recordingAdapter();
  registerRuntime(adapter, stubManifest());

  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Klient Muster',
    email: 'klient@example.org',
    ledgerGroundingEnabled: true,
    idempotencyKey: 'sn-ct',
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  assert.equal(
    call('update_contact', { contactId: contact.contact.id, patch: { ledgerGroundingEnabled: true } }).ok,
    true,
  );

  const root = tempStoreDir('till-e06-sentinel-');
  const messages = outboundCorpus(21);
  messages.push(
    inboundAsk({ body: `Guten Tag, ${mailSentinel}: wie ist der Stand meiner Rechnung? Freundliche Grüsse` }),
  );
  makeMaildirStore(root, messages);
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'sn-c' });
  assert.equal(call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'sn-r' }).ok, true);
  assert.equal(call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'sn-s' }).ok, true);
  assert.equal(call('voice_build', { accountId: account.accountId, idempotencyKey: 'sn-b' }).ok, true);

  // The invoice whose FORMATTED total is the ledger sentinel: the books hold 427193, the integer.
  const doc = call('create_document', {
    type: 'invoice',
    contactId: contact.contact.id,
    lines: [{ description: 'Beratung September', quantity: 1, unitPriceMinor: 427193 }],
    idempotencyKey: 'sn-doc',
  });
  assert.equal(call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'sn-iss' }).ok, true);

  const threads = call('mail_threads_list', { bucket: 'needs_reply' });
  const thread = threads.items.find((t) => t.contactId === contact.contact.id);
  const generated = call('draft_generate', { threadId: thread.id, idempotencyKey: 'sn-g' });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.grounded, true);

  // NON-VACUOUS: both sentinels really travelled through the composition in memory.
  const prompt = prompts.at(-1);
  assert.match(prompt, new RegExp(mailSentinel), 'the mail sentinel never reached the prompt: the scan proves nothing');
  assert.ok(prompt.includes(ledgerSentinel), 'the ledger figure never reached the prompt: the scan proves nothing');
  assert.ok(generated.factsCount >= 1, 'no fact entered the composition: the scan proves nothing');
  // And the completion (which quotes the prompt tail) reached the Drafts FOLDER, where it belongs.
  const listed = call('draft_list', { threadId: thread.id });
  assert.equal(listed.runs[0].draftGone, false);

  // THE SCAN: WAL checkpointed, store closed, raw bytes. Zero composition bytes in the database.
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  store.close();
  const bytes = readFileSync(location);
  assert.equal(
    bytes.includes(Buffer.from(mailSentinel, 'utf8')),
    false,
    'a client-mail byte reached the SQLite file: the prompt (or the replay row, or a draft body) was persisted',
  );
  assert.equal(
    bytes.includes(Buffer.from(ledgerSentinel, 'utf8')),
    false,
    'a FORMATTED composition figure reached the SQLite file: a facts string was persisted',
  );
  // Sanity: the books DO hold the integer form (the probe scans the right file).
  assert.equal(bytes.includes(Buffer.from('427193', 'utf8')), true, 'the scan is aimed at the wrong file');

  resetRuntimeRegistration();
});

test('E06 OP6: the containment fixture opened no socket', () => {
  assert.deepEqual(probe.violations, []);
});
