/**
 * G05 §10, dispatch texts and the cross-document send log (spec §10.7 / §10.8).
 *
 * What this suite holds, in the spec's own order: the save-time `unknown_variable` refusal per
 * kind naming the valid set; the naturally-idempotent claim TESTED (a value-identical re-upsert
 * leaves the row byte-identical, `updated_at` included); the built-in default fallback (a preview
 * never fails for lack of a saved text, and says `defaulted`); the preview's per-recipient
 * cardinality (one message per debtor on a run) and the OWNING verbs' P9 flag names; the log rows
 * the three send verbs append (sent / degraded / failed / artifact_created), that an idempotent
 * retry appends NO second row, and that the run-level transport degradation is logged; §H-TENANT
 * on both new tables; the G00 saved-view seam on `list_dispatches`; and the P3-by-omission /
 * append-only guards asserted STRUCTURALLY over the module's own source, because the invariant
 * ("no path to A02/A14, no engine write mutates a `dispatches` row") is about what the code cannot
 * do, and the cheapest honest probe is that the code does not say it.
 *
 * SEND SEMANTICS ARE ASSERTED UNCHANGED where it is cheapest to see: the outbound subject a logged
 * `sent` row records is the verb's own (`invoiceEmailSubject`), never a saved dispatch text (spec
 * §0 item 8a: this pass wires the LOG, not the resolution).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { DISPATCH_VARIABLES } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace, recordingRelay } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function world(key = 'dsp') {
  const deps = freshDeps();
  const ws = mintWorkspace(deps, 'Versand AG', `${key}-ws`);
  return { deps, ...ws };
}

/** An issued CHF invoice for a contact (optionally without an email), returning both ids. */
function issuedInvoice(deps, workspaceId, seed, { email = 'kunde@example.ch' } = {}) {
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Versand AG',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  const contact = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Muster GmbH',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      ...(email === null ? {} : { email }),
      idempotencyKey: `${seed}-contact`,
    }),
    'create_contact',
  ).contact.id;
  const doc = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: contact,
      currency: 'CHF',
      dueDate: '2026-08-15',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `${seed}-doc`,
    }),
    'create_document',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: doc, idempotencyKey: `${seed}-issue` }), 'issue_invoice');
  return { contactId: contact, invoiceId: doc };
}

function rows(deps, workspaceId) {
  return deps.store.db
    .prepare('SELECT * FROM dispatches WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId);
}

// --- dispatch_text_upsert: the save-time control -------------------------------------------------

test('G05 §10: an unknown variable is refused at SAVE time, naming the offender and the valid set', () => {
  const { deps, workspaceId } = world('uv');
  for (const kind of ['invoice', 'quote', 'dunning_run']) {
    const res = call(deps, 'dispatch_text_upsert', {
      workspaceId,
      documentKind: kind,
      locale: 'de-CH',
      subject: 'Betreff {{not_a_variable}}',
      body: 'Text.',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unknown_variable');
    assert.equal(res.variable, 'not_a_variable');
    assert.deepEqual(res.valid, [...DISPATCH_VARIABLES[kind]], `${kind} names its own registry`);
  }
  // Nothing was written on any refusal.
  const n = deps.store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_texts WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(n, 0);
});

test('G05 §10: credit_note has no dispatch text by design, and a bad locale is refused', () => {
  const { deps, workspaceId } = world('cn');
  const kind = call(deps, 'dispatch_text_upsert', {
    workspaceId,
    documentKind: 'credit_note',
    locale: 'de-CH',
    subject: 'S',
    body: 'B',
  });
  assert.equal(kind.ok, false);
  assert.equal(kind.error, 'unknown_document_kind');
  const locale = call(deps, 'dispatch_text_upsert', {
    workspaceId,
    documentKind: 'invoice',
    locale: 'de-DE',
    subject: 'S',
    body: 'B',
  });
  assert.equal(locale.ok, false);
  assert.equal(locale.error, 'invalid_locale');
});

test('G05 §10: a value-identical re-upsert is a FULL no-op (row byte-identical, updated_at included)', () => {
  const { deps, workspaceId } = world('noop');
  const input = {
    workspaceId,
    documentKind: 'invoice',
    locale: 'de-CH',
    subject: 'Rechnung {{invoice_number}}',
    body: 'Guten Tag {{contact_name}}',
  };
  must(call(deps, 'dispatch_text_upsert', input), 'first upsert');
  const before = deps.store.db.prepare('SELECT * FROM dispatch_texts WHERE workspace_id = ?').all(workspaceId);
  const second = must(call(deps, 'dispatch_text_upsert', input), 'second upsert');
  assert.equal(second.unchanged, true);
  const after = deps.store.db.prepare('SELECT * FROM dispatch_texts WHERE workspace_id = ?').all(workspaceId);
  assert.deepEqual(after, before, 'the value-identical re-upsert touched the row');

  // A CHANGED value re-asserts the slot (still one row) and moves updated_at.
  must(call(deps, 'dispatch_text_upsert', { ...input, body: 'Neuer Text {{contact_name}}' }), 'changed upsert');
  const changed = deps.store.db.prepare('SELECT * FROM dispatch_texts WHERE workspace_id = ?').all(workspaceId);
  assert.equal(changed.length, 1, 'the slot accumulated a second row');
  assert.equal(changed[0].body, 'Neuer Text {{contact_name}}');
});

// --- dispatch_preview: the pure read -------------------------------------------------------------

test('G05 §10: the sample preview resolves the saved text, and the built-in default when none is saved', () => {
  const { deps, workspaceId } = world('pv');
  const before = must(call(deps, 'dispatch_preview', { workspaceId, documentKind: 'invoice' }), 'default preview');
  assert.equal(before.sample, true);
  assert.equal(before.messages.length, 1);
  assert.equal(before.messages[0].defaulted, true, 'no saved text: the built-in default answers');
  assert.ok(before.messages[0].subject.length > 0);
  assert.ok(!before.messages[0].subject.includes('{{'), 'sample variables are filled');

  must(
    call(deps, 'dispatch_text_upsert', {
      workspaceId,
      documentKind: 'invoice',
      locale: 'de-CH',
      subject: 'Eigener Betreff {{invoice_number}}',
      body: 'Eigener Text {{contact_name}}',
    }),
    'upsert',
  );
  const after = must(call(deps, 'dispatch_preview', { workspaceId, documentKind: 'invoice' }), 'saved preview');
  assert.equal(after.messages[0].defaulted, false);
  assert.ok(after.messages[0].subject.startsWith('Eigener Betreff'));
});

test('G05 §10: a real-invoice preview fills the variables from the read model and mutates nothing', () => {
  const { deps, workspaceId } = world('pvi');
  const { contactId, invoiceId } = issuedInvoice(deps, workspaceId, 'pvi');
  must(
    call(deps, 'dispatch_text_upsert', {
      workspaceId,
      documentKind: 'invoice',
      locale: 'de-CH',
      subject: 'Rechnung {{invoice_number}} über {{amount_total}}',
      body: 'Guten Tag {{contact_name}}, fällig am {{due_date}}.',
    }),
    'upsert',
  );
  const snap = JSON.stringify(deps.store.db.prepare('SELECT * FROM dispatches').all());
  const res = must(
    call(deps, 'dispatch_preview', { workspaceId, documentKind: 'invoice', documentId: invoiceId }),
    'preview',
  );
  assert.equal(res.messages.length, 1);
  const msg = res.messages[0];
  assert.equal(msg.contactId, contactId);
  assert.equal(msg.recipient, 'kunde@example.ch');
  // CHF 1'000.00 net + 8.1% MWST = CHF 1'081.00, the read model's own already-computed total.
  assert.match(msg.subject, /^Rechnung R-\d{4}-\d+ über CHF 1'081\.00$/);
  assert.equal(msg.body, 'Guten Tag Muster GmbH, fällig am 15.08.2026.');
  assert.deepEqual(msg.flags, []);
  assert.equal(
    JSON.stringify(deps.store.db.prepare('SELECT * FROM dispatches').all()),
    snap,
    'the preview wrote a log row',
  );
});

test("G05 §10: a missing recipient email carries the OWNING verb's flag name, never a synonym", () => {
  const { deps, workspaceId } = world('flag');
  const { invoiceId } = issuedInvoice(deps, workspaceId, 'flag', { email: null });
  const res = must(
    call(deps, 'dispatch_preview', { workspaceId, documentKind: 'invoice', documentId: invoiceId }),
    'preview',
  );
  assert.deepEqual(res.messages[0].flags, ['needs_customer_email'], "A11's own P9 name");
});

test('G05 §10: a dunning-run preview yields one message per debtor, narrowable to one via contactId', () => {
  const { deps, workspaceId } = world('pvd');
  // Two overdue debtors, one run. The fixture clock is 2026-07-16; due 2026-06-01 is 45 days over.
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  const debtor = (name, key) =>
    must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name, email: `${key}@example.ch`, idempotencyKey: key }),
      'create_contact',
    ).contact.id;
  const a = debtor('Alpha AG', 'pvd-a');
  const b = debtor('Beta AG', 'pvd-b');
  for (const [contactId, key] of [
    [a, 'pvd-doc-a'],
    [b, 'pvd-doc-b'],
  ]) {
    const doc = must(
      call(deps, 'create_document', {
        workspaceId,
        type: 'invoice',
        contactId,
        currency: 'CHF',
        dueDate: '2026-06-01',
        lines: [{ description: 'Beratung', unitPriceMinor: 50000, taxCode: 'UST81' }],
        idempotencyKey: key,
      }),
      'create_document',
    ).document.id;
    must(call(deps, 'issue_invoice', { workspaceId, invoiceId: doc, idempotencyKey: `${key}-i` }), 'issue');
  }
  const runId = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'pvd-run' }), 'propose').runId;
  const all = must(call(deps, 'dispatch_preview', { workspaceId, documentKind: 'dunning_run', runId }), 'preview');
  assert.equal(all.messages.length, 2, 'one message per debtor');
  assert.ok(all.messages.every((m) => m.subject.length > 0 && !m.subject.includes('{{')));
  const narrowed = must(
    call(deps, 'dispatch_preview', { workspaceId, documentKind: 'dunning_run', runId, contactId: b }),
    'narrowed preview',
  );
  assert.equal(narrowed.messages.length, 1);
  assert.equal(narrowed.messages[0].contactId, b);
});

// --- The send log: what the three send verbs append ----------------------------------------------

test('G05 §10: send_invoice logs ONE sent row in the same write, and a same-key retry never double-logs', () => {
  const { deps, workspaceId } = world('si');
  const { contactId, invoiceId } = issuedInvoice(deps, workspaceId, 'si');
  // A saved text exists, and the SENT row still records the verb's own subject: this pass wires
  // the log, not the resolution (spec §0 item 8a), and the log must say what actually left.
  must(
    call(deps, 'dispatch_text_upsert', {
      workspaceId,
      documentKind: 'invoice',
      locale: 'de-CH',
      subject: 'Eigener Betreff {{invoice_number}}',
      body: 'Eigener Text',
    }),
    'upsert',
  );
  deps.emailRelay = recordingRelay();
  const input = { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'si-send' };
  const first = must(call(deps, 'send_invoice', input), 'send_invoice');
  assert.equal(first.transmitted, true);
  const logged = rows(deps, workspaceId);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].document_kind, 'invoice');
  assert.equal(logged[0].document_id, invoiceId);
  assert.equal(logged[0].contact_id, contactId);
  assert.equal(logged[0].recipient_email, 'kunde@example.ch');
  assert.equal(logged[0].channel, 'smtp');
  assert.equal(logged[0].outcome, 'sent');
  assert.equal(logged[0].dispatch_text_defaulted, 1);
  assert.equal(logged[0].subject_resolved, deps.emailRelay.sent[0].subject, 'the row records what left');
  assert.ok(!logged[0].subject_resolved.startsWith('Eigener Betreff'), 'the saved text did not drive the send');

  const replay = must(call(deps, 'send_invoice', input), 'replay');
  assert.deepEqual(replay, first, 'the replay returns the original result');
  assert.equal(rows(deps, workspaceId).length, 1, 'the retried send appended a second log row');
  assert.equal(deps.emailRelay.sent.length, 1, 'the retry transmitted');
});

test('G05 §10: a send_invoice with no transport logs a degraded row with the P9 reason, refusal unchanged', () => {
  const { deps, workspaceId } = world('deg');
  const { invoiceId } = issuedInvoice(deps, workspaceId, 'deg');
  const res = call(deps, 'send_invoice', { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'deg-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_email_config');
  assert.equal(res.transmitted, false);
  const logged = rows(deps, workspaceId);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].outcome, 'degraded');
  assert.equal(logged[0].degrade_reason, 'needs_email_config');
});

test('G05 §10: a failed transport logs a failed row with the transport reason', () => {
  const { deps, workspaceId } = world('fail');
  const { invoiceId } = issuedInvoice(deps, workspaceId, 'fail');
  deps.emailRelay = recordingRelay({ ok: false, reason: 'smtp_down' });
  const res = call(deps, 'send_invoice', { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'fail-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'email_send_failed');
  const logged = rows(deps, workspaceId);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].outcome, 'failed');
  assert.equal(logged[0].degrade_reason, 'smtp_down');
});

test('G05 §10: quotes_send logs artifact_only/artifact_created (the designed OSS completion), replay-safe', () => {
  const { deps, workspaceId } = world('qs');
  const contactId = must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Offerte AG', idempotencyKey: 'qs-c' }),
    'create_contact',
  ).contact.id;
  const quoteId = must(
    call(deps, 'quotes_create', {
      workspaceId,
      contactId,
      validUntil: '2027-01-31',
      lines: [{ description: 'Leistung', unitPriceMinor: 20000 }],
      idempotencyKey: 'qs-q',
    }),
    'quotes_create',
  ).document.id;
  const input = { workspaceId, quoteId, idempotencyKey: 'qs-send' };
  const sent = must(call(deps, 'quotes_send', input), 'quotes_send');
  assert.equal(sent.transmitted, false);
  const logged = rows(deps, workspaceId);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].document_kind, 'quote');
  assert.equal(logged[0].channel, 'artifact_only');
  assert.equal(logged[0].outcome, 'artifact_created');
  assert.equal(logged[0].contact_id, contactId);
  must(call(deps, 'quotes_send', input), 'replay');
  assert.equal(rows(deps, workspaceId).length, 1, 'the replay double-logged');
});

test('G05 §10: send_dunning_run logs one row per debtor when sent, and one degraded row when no transport exists', () => {
  const { deps, workspaceId } = world('sdr');
  const { invoiceId } = issuedInvoice(deps, workspaceId, 'sdr');
  // Make it overdue by re-dating: cheaper than a second fixture; the run derives from the OP list.
  deps.store.db
    .prepare('UPDATE document SET due_date = ? WHERE workspace_id = ? AND id = ?')
    .run('2026-06-01', workspaceId, invoiceId);
  const runId = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'sdr-p' }), 'propose').runId;
  must(call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'sdr-i' }), 'issue');

  // No transport: the run-level degradation is one log row with the verb's own reason.
  const degraded = call(deps, 'send_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'sdr-s1' });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.error, 'needs_email_config');
  let logged = rows(deps, workspaceId).filter((r) => r.document_kind === 'dunning_run');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].outcome, 'degraded');
  assert.equal(logged[0].degrade_reason, 'needs_email_config');
  assert.equal(logged[0].dunning_run_id, runId);

  // With a transport, the debtor's letter goes and the sent row carries the letter's own subject.
  deps.emailRelay = recordingRelay();
  const sent = must(call(deps, 'send_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'sdr-s2' }), 'send');
  assert.equal(sent.transmitted, 1);
  logged = rows(deps, workspaceId).filter((r) => r.document_kind === 'dunning_run' && r.outcome === 'sent');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].recipient_email, 'kunde@example.ch');
  assert.equal(logged[0].subject_resolved, deps.emailRelay.sent[0].subject);

  // The same-key replay of the fully sent run appends nothing.
  must(call(deps, 'send_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'sdr-s2' }), 'replay');
  assert.equal(
    rows(deps, workspaceId).filter((r) => r.document_kind === 'dunning_run').length,
    2,
    'the replay double-logged',
  );
});

// --- list_dispatches: the Protokoll read model ---------------------------------------------------

test('G05 §10: list_dispatches filters by outcome and kind, returns the saved texts, and applies a saved view', () => {
  const { deps, workspaceId } = world('ls');
  const contactId = must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Liste AG', idempotencyKey: 'ls-c' }),
    'create_contact',
  ).contact.id;
  const quoteId = must(
    call(deps, 'quotes_create', {
      workspaceId,
      contactId,
      validUntil: '2027-01-31',
      lines: [{ description: 'Leistung', unitPriceMinor: 20000 }],
      idempotencyKey: 'ls-q',
    }),
    'quotes_create',
  ).document.id;
  must(call(deps, 'quotes_send', { workspaceId, quoteId, idempotencyKey: 'ls-send' }), 'quotes_send');
  must(
    call(deps, 'dispatch_text_upsert', { workspaceId, documentKind: 'quote', locale: 'en', subject: 'Quote {{quote_number}}', body: 'Hello {{contact_name}}' }),
    'upsert',
  );

  const all = must(call(deps, 'list_dispatches', { workspaceId }), 'list');
  assert.equal(all.dispatches.length, 1);
  assert.equal(all.dispatches[0].outcome, 'artifact_created');
  assert.equal(all.texts.length, 1, 'the saved slots ride the same read (the §10.5 list shape)');

  const none = must(call(deps, 'list_dispatches', { workspaceId, outcome: 'failed' }), 'filtered');
  assert.equal(none.dispatches.length, 0);
  const badOutcome = call(deps, 'list_dispatches', { workspaceId, outcome: 'exploded' });
  assert.equal(badOutcome.ok, false);

  // The G00 seam, both halves: the stored filter applies, an explicit filter wins over it.
  const viewId = must(
    call(deps, 'create_saved_view', {
      workspaceId,
      entityKind: 'dispatch',
      name: 'Nur Fehlgeschlagene',
      filters: { outcome: 'failed' },
      idempotencyKey: 'ls-view',
    }),
    'create_saved_view',
  ).savedView.viewId;
  const viewed = must(call(deps, 'list_dispatches', { workspaceId, savedViewId: viewId }), 'via view');
  assert.equal(viewed.dispatches.length, 0, 'the stored outcome filter applied');
  const overridden = must(
    call(deps, 'list_dispatches', { workspaceId, savedViewId: viewId, outcome: 'artifact_created' }),
    'explicit over view',
  );
  assert.equal(overridden.dispatches.length, 1, 'the explicit filter won');
});

test('H-TENANT: dispatch texts and log rows are invisible across the workspace boundary', () => {
  const { deps, workspaceId } = world('t1');
  const other = mintWorkspace(deps, 'Fremd AG', 't2-ws').workspaceId;
  must(
    call(deps, 'dispatch_text_upsert', { workspaceId, documentKind: 'invoice', locale: 'de-CH', subject: 'S', body: 'B' }),
    'upsert',
  );
  const contactId = must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Grenze AG', idempotencyKey: 't1-c' }),
    'create_contact',
  ).contact.id;
  const quoteId = must(
    call(deps, 'quotes_create', {
      workspaceId,
      contactId,
      validUntil: '2027-01-31',
      lines: [{ description: 'Leistung', unitPriceMinor: 20000 }],
      idempotencyKey: 't1-q',
    }),
    'quotes_create',
  ).document.id;
  must(call(deps, 'quotes_send', { workspaceId, quoteId, idempotencyKey: 't1-send' }), 'quotes_send');

  const foreign = must(call(deps, 'list_dispatches', { workspaceId: other }), 'foreign list');
  assert.equal(foreign.dispatches.length, 0);
  assert.equal(foreign.texts.length, 0);
});

// --- Structural guards: P3 by omission, append-only ----------------------------------------------

const DISPATCH_SRC = readFileSync(
  fileURLToPath(new URL('../../src/core/customization/dispatch.ts', import.meta.url)),
  'utf8',
);

test('G05 §10: no path from the dispatch module to A02/A14 (P3 by omission, spec §10.7)', () => {
  assert.ok(!/from '\.\.\/ledger\//.test(DISPATCH_SRC), 'dispatch.ts imports from the ledger');
  assert.ok(!/from '\.\.\/payments\//.test(DISPATCH_SRC), 'dispatch.ts imports from payments');
  assert.ok(!DISPATCH_SRC.includes('postEntry'), 'dispatch.ts names the posting door');
});

test('G05 §10: the engine never UPDATEs or DELETEs a dispatches row (append-only through the verbs)', () => {
  // The WHOLE engine source is swept, not just this module: any UPDATE/DELETE naming the table
  // would be the drift. C00's future anonymise redaction is C00-owned and will amend this guard
  // to carve out exactly its one statement when it lands (spec §0 item 8).
  const root = fileURLToPath(new URL('../../src/core/', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(path, 'utf8');
        if (/UPDATE\s+dispatches\b/i.test(src) || /DELETE\s+FROM\s+dispatches\b/i.test(src)) offenders.push(path);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'an engine module mutates the append-only send log');
});
