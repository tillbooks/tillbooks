/**
 * E06's behavioural suite, under the OP6 egress probe like every suite in this cluster.
 *
 * THE CONSENT GATE IS THE LOAD-BEARING PRIVACY CONTROL and it is measured here, not trusted
 * (spec §8): across consent flag, `groundInLedger` parameter, in-engine RBAC and sender
 * resolution, `draft_run.grounded` is true IFF the contact resolved AND their own flag is on AND
 * the parameter did not force it off AND the actor holds `read_sales`. The RECORDING adapter makes
 * the prompt itself assertable, so "no ledger fact reaches an ungrounded prompt" is a string
 * check, not a hope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const { ok, err } = await import('../../dist/core/result.js');
const { registerRuntime, resetRuntimeRegistration } = await import('../../dist/core/voice/index.js');
const { generateDraft } = await import('../../dist/core/drafting/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore } = await import('../mail/fixtures.mjs');
const { stubManifest, outboundCorpus } = await import('../voice/fixtures.mjs');
const { recordingAdapter, inboundAsk } = await import('./fixtures.mjs');

/**
 * A full drafting world: a consented (or not) contact, an on-disk Maildir with the 21-message
 * outbound corpus plus one inbound question, an indexed account, a selected model, and (unless
 * told otherwise) a built voice profile and an issued invoice for the contact.
 */
function world({ consent = true, buildVoice = true, invoiceMinor = 20000, ask = undefined } = {}) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  const { adapter, prompts } = recordingAdapter();
  registerRuntime(adapter, stubManifest());

  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Klient Muster',
    email: 'klient@example.org',
    idempotencyKey: 'w-ct',
  });
  if (consent) {
    const updated = call('update_contact', {
      contactId: contact.contact.id,
      patch: { ledgerGroundingEnabled: true },
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
  }

  const root = tempStoreDir('till-e06-');
  const messages = outboundCorpus(21);
  messages.push(ask ?? inboundAsk());
  const paths = makeMaildirStore(root, messages);
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'w-c' });
  assert.equal(call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'w-r' }).ok, true);
  assert.equal(call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'w-s' }).ok, true);
  if (buildVoice) {
    const built = call('voice_build', { accountId: account.accountId, idempotencyKey: 'w-b' });
    assert.equal(built.ok, true, JSON.stringify(built));
  }

  let invoiceNumber = null;
  if (invoiceMinor !== null) {
    const doc = call('create_document', {
      type: 'invoice',
      contactId: contact.contact.id,
      lines: [{ description: 'Beratung', quantity: 1, unitPriceMinor: invoiceMinor }],
      idempotencyKey: 'w-doc',
    });
    const issued = call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'w-iss' });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    invoiceNumber = issued.document?.number ?? call('get_document', { documentId: doc.document.id }).document.number;
  }

  const threads = call('mail_threads_list', { bucket: 'needs_reply' });
  const thread = threads.items.find((t) => t.contactId === contact.contact.id);
  assert.ok(thread !== undefined, 'the fixture inbound thread did not resolve to the contact');

  return { deps, workspaceId, call, contactId: contact.contact.id, accountId: account.accountId, root, paths, thread, prompts, invoiceNumber };
}

test('E06 US-E06.2: a consented contact grounds, the facts are real, and the prompt carries them', () => {
  const w = world();
  const generated = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'g-1' });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.grounded, true);
  assert.equal(generated.run.status, 'ok');
  assert.ok(generated.run.promptSha256.length === 64);
  assert.ok(generated.factsCount >= 2, `the ledger facts never reached the composition: ${JSON.stringify(generated)}`);
  const prompt = w.prompts.at(-1);
  assert.match(prompt, /Fakten aus der Buchhaltung/, 'the grounded prompt carries no ledger section');
  assert.match(prompt, /CHF 200\.00/, 'the grounded prompt carries no ledger figure');
  assert.ok(prompt.includes(`Rechnung ${w.invoiceNumber}`), 'the open invoice never reached the prompt');
  // The generate RESPONSE deliberately returns neither the draft body nor the facts strings
  // (containment: the idempotency replay row serialises this result into SQLite).
  assert.equal('body' in generated, false, 'draft_generate returned the draft body: the replay row would persist it');
  assert.equal('factsUsed' in generated, false, 'draft_generate returned facts strings: the replay row would persist them');
  // The draft itself is in the Drafts folder, readable via draft_list ON DEMAND.
  const listed = w.call('draft_list', { threadId: w.thread.id });
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].draftGone, false);
  assert.match(listed.runs[0].body, /ENTWURF \d/, 'the pane cannot read the draft back on demand');
});

test('E06 consent asymmetry: the flag is the ONLY thing that can turn grounding on', () => {
  // Consent OFF: no parameter can turn grounding on, including an explicit true.
  const off = world({ consent: false });
  for (const [key, input] of [
    ['a-1', { threadId: off.thread.id }],
    ['a-2', { threadId: off.thread.id, groundInLedger: true }],
  ]) {
    const generated = off.call('draft_generate', { ...input, idempotencyKey: key });
    assert.equal(generated.ok, true, JSON.stringify(generated));
    assert.equal(generated.grounded, false, `grounded despite consent OFF (${key})`);
    assert.equal(generated.factsCount, 0);
  }
  // And no ledger fact reached ANY of those prompts: no ledger section, no figure, ever.
  for (const prompt of off.prompts.filter((p) => p.includes('Neue Nachricht'))) {
    assert.doesNotMatch(prompt, /Fakten aus der Buchhaltung/, 'an ungrounded prompt grew a ledger section');
    assert.doesNotMatch(prompt, /CHF \d/, 'a ledger figure reached an ungrounded prompt');
  }

  // Consent ON: the parameter may force grounding OFF (more private is always allowed)...
  const on = world();
  const forcedOff = on.call('draft_generate', { threadId: on.thread.id, groundInLedger: false, idempotencyKey: 'a-3' });
  assert.equal(forcedOff.ok, true);
  assert.equal(forcedOff.grounded, false);
  assert.doesNotMatch(on.prompts.at(-1), /CHF \d/, 'groundInLedger:false still leaked a figure');
  // ...and consent revocation makes the NEXT draft ungrounded with no residue (spec §8).
  assert.equal(on.call('update_contact', { contactId: on.contactId, patch: { ledgerGroundingEnabled: false } }).ok, true);
  const revoked = on.call('draft_generate', { threadId: on.thread.id, idempotencyKey: 'a-4' });
  assert.equal(revoked.grounded, false);
  assert.equal(revoked.factsCount, 0);
  assert.doesNotMatch(on.prompts.at(-1), /CHF \d/, 'revocation left a residue in the next prompt');
});

test('E06 unknown sender: a thread that resolves to no contact never grounds, whatever any flag says', () => {
  const w = world({ ask: inboundAsk({ id: 'unknown-1@nowhere.example', clientAddress: 'unbekannt@nowhere.example' }) });
  const threads = w.call('mail_threads_list', { bucket: 'needs_reply' });
  const unknown = threads.items.find((t) => t.contactId === null);
  assert.ok(unknown !== undefined, 'the unknown-sender fixture thread is missing');
  const generated = w.call('draft_generate', { threadId: unknown.id, groundInLedger: true, idempotencyKey: 'u-1' });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.grounded, false, 'an unresolved sender was grounded: we quoted a balance at a guess');
  assert.doesNotMatch(w.prompts.at(-1), /CHF \d/);
});

test('E06 RBAC laundering: without read_sales, grounded is always false and no fact reaches the prompt', () => {
  const w = world();
  // Engine-level, with a capability port that denies exactly A16's read domain: the actor holds
  // draft.write (the registry gate) but may not see the books.
  const noBooks = {
    assert: (capability) =>
      capability === 'read_sales' ? err('permission_denied', { capability }) : ok(),
  };
  const ctx = makeContext(w.deps.store, {
    workspaceId: w.workspaceId,
    actor: 'agent',
    clock: w.deps.clock,
    ids: w.deps.ids,
    capabilities: noBooks,
  });
  const generated = generateDraft(ctx, { threadId: w.thread.id, idempotencyKey: 'rb-1' });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.grounded, false, 'a holder without read_sales laundered the books through a draft');
  assert.equal(generated.factsCount, 0);
  assert.doesNotMatch(w.prompts.at(-1), /CHF \d/, 'a ledger figure reached the prompt past RBAC');
});

test('E06 §H-IDEMPOTENT: one key is one draft_run row and ONE message in the Drafts folder', () => {
  const w = world();
  const first = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'i-1' });
  const second = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'i-1' });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, 'the replay diverged from the original');
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM draft_run WHERE workspace_id = ?').get(w.workspaceId).n,
    1,
  );
  const draftsDir = join(w.root, 'Drafts', 'cur');
  assert.equal(readdirSync(draftsDir).length, 1, 'a second Drafts message appeared under one key');
  // A FRESH key on the same thread is a second draft (a new attempt is a new fact).
  const third = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'i-2' });
  assert.equal(third.ok, true);
  assert.notEqual(third.draftRunId, first.draftRunId);
});

test('E06 refusals: nothing_to_reply_to, needs_voice_profile, source_changed, needs_local_runtime', () => {
  const w = world();
  // A thread whose newest message is OUTBOUND (one of the corpus reply threads).
  const done = w.call('mail_threads_list', { bucket: 'done' });
  assert.ok(done.items.length > 0);
  const refusedOutbound = w.call('draft_generate', { threadId: done.items[0].id, idempotencyKey: 'r-1' });
  assert.equal(refusedOutbound.ok, false);
  assert.equal(refusedOutbound.error, 'nothing_to_reply_to');

  // source_changed: the inbound message changes on disk under the index.
  const askPath = w.paths['ask-1@example.org'];
  writeFileSync(askPath, inboundAsk({ body: 'Guten Tag, ich habe meine Frage geändert.' }).raw);
  const refusedStale = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'r-2' });
  assert.equal(refusedStale.ok, false);
  assert.equal(refusedStale.error, 'source_changed');
  // Reindex heals it: the same thread drafts again under a fresh key.
  assert.equal(w.call('mail_reindex', { accountId: w.accountId, idempotencyKey: 'r-heal' }).ok, true);
  assert.equal(w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'r-3' }).ok, true);

  // needs_voice_profile: a world with no profile built.
  const voiceless = world({ buildVoice: false, invoiceMinor: null });
  const refusedVoiceless = voiceless.call('draft_generate', { threadId: voiceless.thread.id, idempotencyKey: 'r-4' });
  assert.equal(refusedVoiceless.ok, false);
  assert.equal(refusedVoiceless.error, 'needs_voice_profile');

  // needs_local_runtime: nothing registered, and the FAILED WORK IS ON THE RECORD (a draft_run
  // row with the honest status), never a silent loss (US-E06.1 Error).
  resetRuntimeRegistration();
  const refusedRuntime = voiceless.call('draft_generate', { threadId: voiceless.thread.id, idempotencyKey: 'r-5' });
  assert.equal(refusedRuntime.ok, false);
  // Without an adapter there is also no profile fallback question: profile refusal comes first in
  // THIS world (no profile), so use the first world, which has one.
  resetRuntimeRegistration();
  const refusedRuntime2 = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'r-6' });
  assert.equal(refusedRuntime2.ok, false);
  assert.equal(refusedRuntime2.error, 'needs_local_runtime');
  const recorded = w.deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM draft_run WHERE workspace_id = ? AND status = 'needs_local_runtime'`)
    .get(w.workspaceId).n;
  assert.equal(recorded, 1, 'the needs_local_runtime run is not on the record');
});

test('E06 US-E06.4: regenerate writes a NEW run, REPLACES the Drafts message, and respects draft_gone', () => {
  const w = world();
  const first = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'rg-1' });
  assert.equal(first.ok, true);
  const draftsDir = join(w.root, 'Drafts', 'cur');
  assert.equal(readdirSync(draftsDir).length, 1);

  const regenerated = w.call('draft_regenerate', { draftRunId: first.draftRunId, hint: 'kürzer bitte', idempotencyKey: 'rg-2' });
  assert.equal(regenerated.ok, true, JSON.stringify(regenerated));
  assert.notEqual(regenerated.draftRunId, first.draftRunId, 'regenerate must mint a NEW run row');
  assert.match(w.prompts.at(-1), /kürzer bitte/, 'the hint never reached the prompt');
  // ONE message in the Drafts folder: replaced, not added (US-E06.4 Happy).
  assert.equal(readdirSync(draftsDir).length, 1, 'regenerate added a second Drafts message');
  // The prior run row is RETAINED (append-only in spirit): the sequence stays interpretable.
  const runs = w.call('draft_list', { threadId: w.thread.id });
  assert.equal(runs.runs.length, 2);
  // Grounding was RE-READ, not inherited: both runs grounded (consent unchanged).
  assert.equal(regenerated.grounded, true);

  // draft_gone: the human deletes the draft in their own client; TILL does not re-create it.
  const draftRef = w.deps.store.db
    .prepare('SELECT store_ref FROM mail_draft WHERE workspace_id = ? LIMIT 1')
    .get(w.workspaceId).store_ref;
  unlinkSync(join(w.root, draftRef));
  const gone = w.call('draft_regenerate', { draftRunId: regenerated.draftRunId, idempotencyKey: 'rg-3' });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, 'draft_gone');
  assert.equal(readdirSync(draftsDir).length, 0, 'draft_gone re-created the deleted draft');
});

test('E06 US-E06.3: draft_list reads bodies on demand and surfaces modelChanged honestly', () => {
  const w = world();
  assert.equal(w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'l-1' }).ok, true);
  const before = w.call('draft_list', { threadId: w.thread.id });
  assert.equal(before.runs[0].modelChanged, false);
  assert.equal(before.runs[0].grounded, true);

  // A different model registers: the stale draft says so rather than being mysterious.
  const { adapter } = recordingAdapter();
  registerRuntime({ ...adapter, modelRef: 'other-model-q8' }, stubManifest());
  const after = w.call('draft_list', { threadId: w.thread.id });
  assert.equal(after.runs[0].modelChanged, true, 'a model mismatch is not surfaced');
  // The report-builder path reads NO bodies (metadata only) yet lists the same runs.
  const preview = w.call('reports_preview', { source: 'draft_runs', columns: ['status', 'grounded', 'modelRef'] });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].status, 'ok');
  assert.equal('body' in preview.rows[0], false, 'the report source leaked a draft body');
});

test('E06 §H-TENANT: a foreign thread, run, and list answer as if they did not exist', () => {
  const w = world();
  const generated = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 't-1' });
  assert.equal(generated.ok, true);

  const other = mintWorkspace(w.deps, 'Fremd AG', 'ws-b');
  const callB = (name, input) => getAction(name).run(w.deps, { workspaceId: other.workspaceId, ...input });
  const foreignGenerate = callB('draft_generate', { threadId: w.thread.id, idempotencyKey: 't-2' });
  assert.equal(foreignGenerate.ok, false);
  assert.equal(foreignGenerate.error, 'not_found');
  const foreignRegenerate = callB('draft_regenerate', { draftRunId: generated.draftRunId, idempotencyKey: 't-3' });
  assert.equal(foreignRegenerate.ok, false);
  assert.equal(foreignRegenerate.error, 'not_found');
  const foreignList = callB('draft_list', {});
  assert.equal(foreignList.ok, true);
  assert.equal(foreignList.runs.length, 0, 'a neighbour can see draft runs across the tenant fence');
});

test('E06 revDSG erasure: contacts_anonymise purges the draft runs with the person, in one transaction', () => {
  // No open invoice: an unsettled claim is an overriding interest and C00 rightly refuses to erase.
  const w = world({ invoiceMinor: null });
  assert.equal(w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: 'e-1' }).ok, true);
  const erased = w.call('contacts_anonymise', { contactId: w.contactId, idempotencyKey: 'e-anon' });
  assert.equal(erased.ok, true, JSON.stringify(erased));
  assert.equal(erased.draftRunsPurged.draftRuns, 1, 'the draft run did not go with the person');
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM draft_run WHERE thread_id = ?').get(w.thread.id).n,
    0,
  );
});

test('E06 OP6: none of the above opened a socket', () => {
  resetRuntimeRegistration();
  assert.deepEqual(probe.violations, []);
});
