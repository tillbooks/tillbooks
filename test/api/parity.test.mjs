// Parity by construction: the SAME input driven through the MCP tool handler and the REST handler,
// against two fresh identical in-memory stores (same pinned clock, same id sequence), must yield
// deeply-equal Results. This is the deliverable that proves the two faces cannot diverge.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, recordingRelay } from './support.mjs';

/** Run a tool through the MCP path and decode the JSON content block back to a Result. */
function viaMcp(deps, name, input) {
  const res = callTool(deps, name, input);
  assert.equal(res.content[0].type, 'text');
  return JSON.parse(res.content[0].text);
}

/** Run a tool through the REST path and return the response body (the Result). */
function viaRest(deps, name, input) {
  return handleRest(name, input, deps).body;
}

test('MCP and REST produce identical Results across a representative write flow', () => {
  const mcp = freshDeps();
  const rest = freshDeps();

  // Drive both faces with the exact same input; assert the two Results match at every step.
  const step = (name, input) => {
    const m = viaMcp(mcp, name, input);
    const r = viaRest(rest, name, input);
    assert.deepEqual(m, r, `parity mismatch for ${name}: ${JSON.stringify({ m, r })}`);
    return m;
  };

  // create_workspace (deps-based verb): mints ws_1 identically in both stores.
  const ws = step('create_workspace', { name: 'Acme GmbH', idempotencyKey: 'ws-1' });
  assert.equal(ws.ok, true);
  const workspaceId = ws.workspaceId;

  // The KMU chart is seeded deterministically, so an account's id matches across both stores.
  const accId = (store, number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  const expense = accId(mcp.store, '6500');
  const cash = accId(mcp.store, '1000');
  assert.equal(expense, accId(rest.store, '6500'), 'account ids must be identical across the two stores');

  // A35: the fixture actor is the agent seat and BOTH faces now route its dial-governed writes
  // through the transport dispatch, so the flow grants post + issue to auto first (the D103
  // ceremony, identical on both faces): the parity claim is about the faces, not about the dial.
  // F1: a dial grant is a HUMAN act, so it runs as the studio seat on each face (identically), and
  // the parity flow below then exercises the granted agent seat.
  for (const [name, key] of [['post', 'dial-post'], ['issue', 'dial-issue'], ['send', 'dial-send']]) {
    const gm = viaMcp({ ...mcp, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: name, level: 'auto', idempotencyKey: key });
    const gr = viaRest({ ...rest, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: name, level: 'auto', idempotencyKey: key });
    assert.deepEqual(gm, gr, `grant parity mismatch for ${name}`);
    assert.equal(gm.ok, true);
  }

  const post = step('post_entry', {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'post-1',
    lines: [
      { account: expense, debit: 5000 },
      { account: cash, credit: 5000 },
    ],
  });
  assert.equal(post.ok, true);
  const entryId = post.entryId;

  // Idempotent replay: the same key replays the same Result on both faces.
  step('post_entry', {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'post-1',
    lines: [
      { account: expense, debit: 5000 },
      { account: cash, credit: 5000 },
    ],
  });

  step('reverse_entry', { workspaceId, entryId, idempotencyKey: 'rev-1' });

  step('save_draft', {
    workspaceId,
    date: '2026-03-02',
    idempotencyKey: 'draft-1',
    lines: [{ account: expense, debit: 100 }],
  });

  step('close_month', { workspaceId, period: '2026-05', idempotencyKey: 'cm-1' });
  step('lock_period', { workspaceId, period: '2026-06', kind: 'soft', idempotencyKey: 'lp-1' });

  step('vat_configure', {
    workspaceId,
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    idempotencyKey: 'vat-1',
  });
  step('vat_code_upsert', {
    workspaceId,
    code: 'UST81',
    kind: 'output',
    rateBp: 810,
    formLine: '303',
    idempotencyKey: 'code-1',
  });

  // A06 read tool: the same computeLineTax the GUI readout uses, driven through both faces. A
  // read-only preview has no idempotency key and writes nothing, so it lives here (parity), not in
  // the conformance write scenarios.
  const preview = step('vat_preview', {
    workspaceId,
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    supplyDate: '2024-06-15',
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.taxMinor, 8100);
  assert.equal(preview.grossMinor, 108100);

  // M3: a malformed supply date is the same structured rejection on both faces, never a silent
  // current-rate fallback (a mistyped '15.06.2023' must not book 8.1% where its era says 7.7%).
  const badDate = step('vat_preview', {
    workspaceId,
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    supplyDate: '15.06.2023',
  });
  assert.equal(badDate.ok, false);
  assert.equal(badDate.error, 'invalid_date');

  const con = step('create_contact', { workspaceId, partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'con-1' });
  step('archive_contact', { workspaceId, contactId: con.contact.id });
  step('unarchive_contact', { workspaceId, contactId: con.contact.id });
  const it = step('create_item', { workspaceId, name: 'Beratung', defaultUnitPriceMinor: 15000, idempotencyKey: 'item-1' });
  step('archive_item', { workspaceId, itemId: it.item.id });
  step('unarchive_item', { workspaceId, itemId: it.item.id });

  // A10 document lifecycle: a full quote walk (issue posts nothing, so no A11 poster is needed for
  // parity) plus a convert, driven identically through both faces. Deterministic ids keep the two
  // stores byte-identical.
  const doc = step('create_document', {
    workspaceId,
    type: 'quote',
    contactId: con.contact.id,
    lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000 }],
    idempotencyKey: 'doc-1',
  });
  const documentId = doc.document.id;
  step('update_document', { workspaceId, documentId, patch: { notes: 'Angebot v2' }, idempotencyKey: 'doc-upd-1' });
  step('transition_document', { workspaceId, documentId, to: 'issued', idempotencyKey: 'doc-iss-1' });
  step('transition_document', { workspaceId, documentId, to: 'sent', idempotencyKey: 'doc-snd-1' });
  step('transition_document', { workspaceId, documentId, to: 'accepted', idempotencyKey: 'doc-acc-1' });
  step('convert_document', { workspaceId, documentId, toType: 'order', idempotencyKey: 'doc-cvt-1' });
  step('get_document', { workspaceId, documentId });
  step('list_documents', { workspaceId, type: 'quote' });

  // A11 invoice walk: create -> issue (POSTS via the delegate) -> get_document(include qr/pdf) ->
  // send. Both faces post the same balanced entry, derive the same QRR reference, and render the same
  // PDF bytes (deterministic clock + ids), so every Result is deeply equal.
  step('set_creditor_profile', {
    workspaceId,
    creditorName: 'Acme GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const inv = step('create_document', {
    workspaceId,
    type: 'invoice',
    contactId: con.contact.id,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'inv-1',
  });
  const invoiceId = inv.document.id;
  const issued = step('issue_invoice', { workspaceId, invoiceId, idempotencyKey: 'inv-iss-1' });
  assert.equal(issued.ok, true);
  assert.equal(issued.document.status, 'issued');
  step('get_document', { workspaceId, documentId: invoiceId, include: ['qr', 'pdf', 'history'] });
  // Wire an identical transport into BOTH faces, then send with a confirmation (P8). These two lines
  // used to be `UPDATE workspace SET email_relay = 'local'`, which reached a stub that returned
  // `{ok:true}` without sending anything: parity then held over a transmission neither face made.
  // The transport is injected where it can be seen, and each face's double is asked what it got.
  mcp.emailRelay = recordingRelay();
  rest.emailRelay = recordingRelay();
  // The address goes on alongside the email, because a customer with no structured address produces
  // an invoice with NO payment part. That used to send anyway, printing "kein IBAN konfiguriert" as
  // the reason even though this workspace configures a valid QR-IBAN twenty lines up, so the two
  // faces were being compared on a PDF that lied identically on both. `send_invoice` now refuses an
  // invoice a customer cannot pay, which makes the address a fixture requirement.
  step('update_contact', {
    workspaceId,
    contactId: con.contact.id,
    patch: {
      email: 'billing@kunde.example',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    },
  });
  const sent = step('send_invoice', { workspaceId, invoiceId, confirmed: true, idempotencyKey: 'inv-snd-1' });
  assert.equal(sent.ok, true);
  assert.equal(sent.transmitted, true);
  // Parity of the CLAIM is not enough: both faces must have put the same real message on the wire.
  assert.equal(mcp.emailRelay.sent.length, 1, 'the MCP face must have transmitted exactly once');
  assert.deepEqual(
    rest.emailRelay.sent,
    mcp.emailRelay.sent,
    'the two faces must hand the transport byte-identical messages, PDF included',
  );

  // The account reactivate twin, driven through both faces (cash carried postings; archive/unarchive
  // are orthogonal to that and must stay identical MCP vs REST).
  step('archive_account', { workspaceId, accountId: cash });
  step('unarchive_account', { workspaceId, accountId: cash });

  // A read tool, to confirm computed reads are identical too.
  step('list_journal', { workspaceId });
  step('get_audit_log', { workspaceId });

  // A year-close: the sealing path (source='close') is reached only through this tool, never post_entry.
  step('close_year', { workspaceId, year: '2026', idempotencyKey: 'cy-1' });
});

test('MCP and REST agree on a rejected Result (unbalanced post) and REST maps it to 422', () => {
  const mcp = freshDeps();
  const rest = freshDeps();
  const wsM = viaMcp(mcp, 'create_workspace', { name: 'Acme GmbH', idempotencyKey: 'ws-1' });
  viaRest(rest, 'create_workspace', { name: 'Acme GmbH', idempotencyKey: 'ws-1' });
  const workspaceId = wsM.workspaceId;
  // A35: grant post -> auto on both faces so the ENGINE'S unbalanced rejection is what crosses the
  // wire (at the default ask the dial would draft before the balance check ever ran).
  viaMcp({ ...mcp, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'dial-post' });
  viaRest({ ...rest, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'dial-post' });
  const expense = mcp.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(workspaceId, '6500').id;

  const input = {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'bad-1',
    lines: [
      { account: expense, debit: 5000 },
      { account: expense, credit: 4000 },
    ],
  };
  const m = viaMcp(mcp, 'post_entry', input);
  const restResp = handleRest('post_entry', input, rest);
  assert.equal(m.ok, false);
  assert.equal(m.error, 'unbalanced');
  assert.deepEqual(m, restResp.body);
  assert.equal(restResp.status, 422, 'a verb rejection is 422');
});

test('an unknown REST action is 404 with a structured body', () => {
  const deps = freshDeps();
  const resp = handleRest('no_such_action', {}, deps);
  assert.equal(resp.status, 404);
  assert.equal(resp.body.ok, false);
  assert.equal(resp.body.error, 'unknown_action');
});
