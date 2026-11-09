// E00 over the wire: the A24 split that the whole retention rail rests on, measured rather than argued.
//
// `test/access/permission-boundary.test.mjs` already derives its coverage from `ACTIONS`, so E00's
// twelve verbs are held to the generic rules (a denial refuses on BOTH doors and writes nothing) with
// nobody editing this file. What that suite cannot state is the PRODUCT claim, and there are now three,
// two of them owner decisions taken on 30.07.2026 after the critic measured what the first one cost.
//
//   1. A BOOKKEEPER files, tags and supersedes every voucher in the workspace, and cannot shorten a
//      statutory retention or erase a business record. One role, two answers, and it holds only because
//      `files_set_retention` and `files_delete` require `manage_settings` on top of the filing right
//      while the other ten do not.
//
//   2. F8: A TREUHÄNDER CAN ATTACH THE BELEG FOR AN ENTRY IT CAN POST. E00's writes were all
//      `manage_master_data`, which that role deliberately does not hold, so the fiduciary who keeps the
//      books could post an entry and was refused the upload of its Buchungsbeleg. `files_upload` and its
//      siblings now sit on E00's own `manage_files`, which all three editable built-ins hold, and
//      `files_link` INHERITS THE TARGET'S OWN WRITE RIGHT through G00's registry, exactly as
//      `set_field_value` does: linking to a journal entry costs `post`, to a contact
//      `manage_master_data`. Widening `manage_master_data` instead would have handed the Treuhänder the
//      contacts, items and bank-account registers, which is the mandate boundary D50 was decided on.
//
//   3. F7: A VIEWER SEES THE FILING AND CANNOT DOWNLOAD IT. `read_master_data` covers the list, and the
//      BYTES need `read_file_content`, which neither anchor grants. Before the split a read-only invite
//      could fetch every file's content, reproduced end to end with an AHV number in the payload.
//
// If someone later "simplifies" any of the three to one flat capability, every generic rule stays green
// and this file goes red.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { ENTITY_KIND_IDS } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const B64 = Buffer.from('%PDF-1.4 Beleg').toString('base64');

/** A workspace whose `agent` seat has been narrowed to `role`, through the product's own flow. */
function agentHolding(role, seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Ablage GmbH', `${seed}-ws`);
  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: `${seed}@muster.ch`,
    role,
    idempotencyKey: `${seed}-invite`,
  });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const seat = getAction('list_members')
    .run(deps, { workspaceId })
    .members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the provisioning flip did not seat the agent');
  assert.equal(getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role }).ok, true);
  // THE LINE THAT MAKES THIS FIXTURE MEAN ANYTHING. Provisioning and narrowing are done BY the owner;
  // the calls under test are made by the narrowed seat. Left as `studio`, every assertion below would
  // measure the owner and every refusal test would pass for the wrong reason: it did, on the first run,
  // and three tests reported that a bookkeeper may erase a retained business record.
  deps.actor = 'agent';
  return { deps, workspaceId };
}

const call = (fixture, name, input) => getAction(name).run(fixture.deps, { workspaceId: fixture.workspaceId, ...input });

function uploadAs(fixture, seed) {
  const res = call(fixture, 'files_upload', {
    title: `Beleg ${seed}`,
    filename: `${seed}.pdf`,
    mime: 'application/pdf',
    contentBase64: B64,
    idempotencyKey: `${seed}-up`,
  });
  assert.equal(res.ok, true, `upload failed: ${JSON.stringify(res)}`);
  return res.file;
}

test('the declarations themselves: the filing right, the two elevated ones, and the content one', () => {
  // The declaration read off the single source, so each claim below is about POLICY and not only about
  // one fixture's outcome.
  assert.deepEqual(requiredCapabilitiesFor('files_upload', {}), ['manage_files']);
  assert.deepEqual(requiredCapabilitiesFor('files_update', {}), ['manage_files']);
  assert.deepEqual(requiredCapabilitiesFor('files_new_version', {}), ['manage_files']);
  assert.deepEqual(requiredCapabilitiesFor('folders_upsert', {}), ['manage_files']);
  assert.deepEqual(requiredCapabilitiesFor('files_set_retention', {}), ['manage_files', 'manage_settings']);
  assert.deepEqual(requiredCapabilitiesFor('files_delete', {}), ['manage_files', 'manage_settings']);
  // F7: the list and the bytes are two different disclosures and two different declarations.
  assert.deepEqual(requiredCapabilitiesFor('files_search', {}), ['read_master_data']);
  assert.deepEqual(requiredCapabilitiesFor('files_list_linked', {}), ['read_master_data']);
  assert.deepEqual(requiredCapabilitiesFor('folders_list', {}), ['read_master_data']);
  assert.deepEqual(requiredCapabilitiesFor('files_get_content', {}), ['read_master_data', 'read_file_content']);
});

test('F8: the link gate is a function of the TARGET, resolved through G00 rather than restated', () => {
  // The rule and not just its outcome, per kind. This is the assertion that would go red if somebody
  // replaced the lookup with a table in A24: the answers below are `editCapabilityForKind`'s answers,
  // and `set_field_value` is measured beside them to prove the two really are one source.
  //
  // The EXPECTED rows are the policy, written out so the assertion is not circular; the LOOP runs over
  // the registry itself. This loop used to name seven of the nine registered kinds by hand, which meant
  // a kind added next year would ship ungated by any assertion here without anything going red. Now a
  // registered kind with no row FAILS, which is the one moment somebody states what attaching to the
  // new kind is supposed to cost.
  const EXPECTED = new Map([
    ['journal_entry', 'post'],
    ['payment', 'pay'],
    ['document', 'issue'],
    ['contact', 'manage_master_data'],
    ['item', 'manage_master_data'],
    ['bank_account', 'manage_master_data'],
    ['account', 'manage_chart'],
    ['cost_center', 'manage_chart'],
    ['automation_rule', 'manage_automations'],
    // A17: attaching the Beleg to a Kreditorenrechnung costs what every A17 write costs. `post` is
    // the capability `attach_receipt` itself gates on (D60's rule, `actionCapabilities.ts`), so the
    // receipt POINTER and the receipt FILE cannot cost different rights.
    ['vendor_bill', 'post'],
    // A15: attaching data to a Mahnlauf costs what operating one costs. `dun` is the capability the
    // run's own writes gate on, so a custom field or a linked file on a run is never a side door.
    ['dunning_run', 'dun'],
    // A12: attaching a contract or an order confirmation to a Serie costs what every A12 write
    // costs. `issue` is the capability the schedule's own edits gate on (`actionCapabilities.ts`),
    // so the file and the schedule cannot cost different rights.
    ['recurring_schedule', 'issue'],
    // A21: attaching data to an Abgleich row costs what recording one costs. `pay` is the
    // capability the queue's own writes gate on (`record_incoming_credit`), so a review note or a
    // linked advice on a match is exactly as hard to write as the match decision it annotates.
    ['reconciliation_match', 'pay'],
    // A20: attaching data to an imported transaction costs what deciding one costs. `pay` is the
    // capability `confirm_match`/`create_entry_for_txn` both gate on (alongside `post`), so a
    // review note or a linked advice on a bank txn is exactly as hard to write as the settlement
    // decision it annotates.
    ['bank_txn', 'pay'],
    // A18: attaching data to a payment batch costs what drafting one costs. `pay` is the capability
    // `create_payment_batch` gates on, so a purpose note or a linked advice on a batch is exactly as
    // hard to write as the batch itself.
    ['payment_batch', 'pay'],
    // A23: attaching a file to the mandate itself (an engagement letter on the client book) costs
    // what governing the mandate costs. `manage_settings` is the capability `archive_workspace`
    // gates on, and the self-tenant rule means the target can only ever be the CURRENT workspace.
    ['workspace', 'manage_settings'],
    // A25: attaching a file to a review event (a supporting document behind a flag) costs what
    // writing the review costs. `review` is the capability the event's own writes (comment/flag/
    // approve) gate on, so a linked file on a review is exactly as hard to write as the review itself.
    ['entry_review', 'review'],
    // G10: attaching data to a Zuordnungsvorlage (a "Mandant" note, a source-system version tag)
    // costs what writing the template costs. `manage_import` is the capability
    // `migration_save_map_template` gates on, so an annotation on a template is exactly as hard to
    // write as the template it annotates.
    ['migration_map_template', 'manage_import'],
    // G09: attaching a file to a migration plan or step (a signed cutover checklist, a source export
    // kept as the Beleg) costs what operating the harness costs. `manage_import` is the capability
    // the plan's and step's own writes gate on, so a linked file on either is exactly as hard to
    // write as the plan it annotates.
    ['migration_plan', 'manage_import'],
    ['migration_step', 'manage_import'],
    // G11: attaching a file to a persisted Eröffnungsprüfung (the signed Prüfbericht, a Treuhänder's
    // working paper behind a waiver) costs what producing the check costs. `manage_import` is the
    // capability every G11 write gates on, so a linked file on a check is exactly as hard to write
    // as the check it evidences; the snapshot and its hash stay append-only regardless.
    ['migration_check', 'manage_import'],
    // G19: attaching a file to an export manifest (a scan of the source contract that sets the
    // deletion clock, a screenshot of the export screen) costs what recording the manifest costs.
    // `manage_import` is the capability every G19 manifest write gates on, so a linked file on a
    // manifest is exactly as hard to write as the manifest it evidences.
    ['migration_extraction_manifest', 'manage_import'],
    // G13: attaching data to an archived entry (a Treuhänder's Prüfvermerk, a supporting document
    // found during due diligence) costs what importing the archive costs. `commit_migration` is the
    // capability `gl_archive_import` gates on, so an annotation on imported history is exactly as
    // hard to write as the import that minted it; the archived VALUES themselves sit behind
    // BEFORE-triggers and no capability reaches them at all.
    ['gl_archive_entry', 'commit_migration'],
    // B00: attaching a contract or an offer to a project (or a phase) costs what editing the project
    // costs. `manage_master_data` is the capability every B00 write gates on, so a linked file or a
    // custom field on a project is exactly as hard to write as the project it annotates.
    ['project', 'manage_master_data'],
    ['project_phase', 'manage_master_data'],
    // E03: attaching a file or a custom field to a task costs what writing the task costs.
    // `tasks.write` is the capability four of the five E03 writes gate on (the fifth, completion,
    // additionally allows the assignee IN-ENGINE, which no attachment path inherits), so an
    // annotation on a task is exactly as hard to write as the task it annotates.
    ['task', 'tasks.write'],
    // B01: attaching a file or a custom field to a time entry (an expense receipt behind the hours,
    // a client sign-off sheet) costs what capturing the time costs. `time.write` is the capability
    // the entry lifecycle gates on, so an annotation on captured time is exactly as hard to write
    // as the entry it annotates.
    ['time_entry', 'time.write'],
    // C01: attaching a file or a custom field to a deal (a signed NDA, an "Umsatzquelle" select)
    // costs what writing the deal costs. `deals.write` is the capability every C01 write gates on,
    // so an annotation on a deal is exactly as hard to write as the deal it annotates; the frozen
    // §H-FX trio and the DEAL_STATUSES machine stay single-sourced on the row regardless.
    ['deal', 'deals.write'],
    // D01: attaching a file or a custom field to a stock location or a stocktake session (a zone
    // plan, the signed Inventur sheet filed as the E00 Bestandesnachweis) costs what writing the
    // register costs. `manage_master_data` is the capability each kind's own writes gate on, so an
    // annotation is exactly as hard to write as the row it annotates.
    ['stock_location', 'manage_master_data'],
    ['stocktake', 'manage_master_data'],
    // C02: attaching a file or a custom field to a quote or a quote line (a signed acceptance PDF, a
    // "Projekt-Referenz" select) costs what writing the quote costs. `issue` is the capability every
    // C02 write gates on (a quote rides A10's document machine), so an annotation on a quote is
    // exactly as hard to write as the quote it annotates.
    ['quote', 'issue'],
    ['quote_line', 'issue'],
    // D03: attaching a file or a custom field to a sales order or a delivery note (the rendered
    // Lieferschein Beleg filed on the note, a "Frachtführer" text) costs what writing the order
    // costs. `issue` is the capability every D03 write gates on (the sales-document write capability
    // C02/A11 use), so an annotation is exactly as hard to write as the order it annotates. The
    // Lieferschein's own OR 958f retention is set by `delivery_note_render`, not by the link.
    ['sales_order', 'issue'],
    ['delivery_note', 'issue'],
    // A32: annotating an eBill delivery (a "Freigabe-Referenz" file or a "Kanal-Notiz" field) costs
    // what preparing the delivery costs (`issue`, the capability `ebill_prepare` gates on, the
    // `delivery_note` reasoning one kind over). The payload bytes and the mirrored partner status stay
    // single-sourced and no link reaches them.
    ['ebill_delivery', 'issue'],
    // A33: linking a file to an EBICS channel (the INI letter, a fetched statement, a contract PDF) or
    // to an order-log row costs what the channel's own writes cost, `pay` (the banking-write capability
    // `bank_channel_connect`/`bank_sync` gate on, the `payment_batch` reasoning one kind over). No link
    // reaches key material, the state enum or the protocol parameters, which stay fixed (§6b).
    ['ebics_connection', 'pay'],
    ['ebics_order', 'pay'],
    // A37: the managed (bLink) channel and its order log, the EBICS twins one rail over. Linking a
    // file or a custom field to a managed connection or an order-log row costs what the channel's own
    // writes cost, `pay` (the banking-write capability `bank_channel_connect`/`bank_sync` gate on). No
    // link reaches a consent reference, a scope, or the state enum, which stay fixed (§6b).
    ['managed_connection', 'pay'],
    ['managed_order', 'pay'],
    // D02: attaching a file or a custom field to a purchase order (a supplier quote PDF, an internal
    // requisition reference) costs what writing the PO costs. `manage_master_data` is the capability
    // every D02 write gates on (D02 posts nothing, P3), so an annotation on a PO is exactly as hard to
    // write as the PO it annotates.
    ['po', 'manage_master_data'],
    // E02: attaching a file or a custom field to an employee/absence costs what writing the record
    // costs (`hr.manage`, the capability every roster/absence write gates on), and to an expense
    // claim costs `spesen.submit` (its base drafting write). So a contract PDF on an employee or a
    // receipt annotation on a claim is exactly as hard to write as the record it annotates; the AHV
    // number and the claim status machine stay single-sourced and no link reaches them.
    ['employee', 'hr.manage'],
    ['absence', 'hr.manage'],
    ['expense_claim', 'spesen.submit'],
    // B04: attaching a file or a custom field to a retainer costs what writing the mandate costs
    // (`retainer.manage`, the capability every retainer write gates on), so a contract PDF on a
    // mandate is exactly as hard to write as the mandate it annotates.
    ['retainer', 'retainer.manage'],
    // E01: attaching a file or a custom field to a signature request costs what writing the request
    // costs (`sign.write`, the capability every sign_requests_* write gates on), so an annotation on
    // a request is exactly as hard to write as the request it annotates.
    ['sign_request', 'sign.write'],
    // F02: annotating a portal grant (a file or a custom field) costs what writing the grant costs
    // (`portal.manage`, the capability its lifecycle writes gate on).
    ['portal_grant', 'portal.manage'],
    // F01: attaching a file or a custom field to a report_run (a "Mandant" or "Freigabe erteilt" tag
    // on a filed run, the retained artifact linked into E00) costs what producing the run costs.
    // `reports.run` is the capability `reports_run` gates on, so an annotation on a run is exactly as
    // hard to write as the run it annotates.
    ['report_run', 'reports.run'],
    // F03: annotating a remittance advice (a file or a custom field) costs what filing the advice
    // costs (`portal.manage`, the capability `vendor_portal_remittance_create` gates on).
    ['remittance_advice', 'portal.manage'],
    // E04: attaching a file or a bounded custom field to a mail thread costs what drafting against
    // it costs (`mail.write`, the capability the thread's own writes gate on). Annotating Art. 321
    // correspondence is exactly as hard as writing into it, and no softer domain may ever answer.
    ['mail_thread', 'mail.write'],
    // G04: annotating a backup-history row (a "Reason" tag or a "Keep until" date, spec §6b) costs
    // what writing the backup costs (`manage_data_export`, the capability create_backup/
    // export_workspace/delete_backup all gate on), so a field on a backup is exactly as hard to write
    // as the backup it annotates. There is no softer read domain for the portability surface, which is
    // why `READ_FOR_EDIT_CAPABILITY` carries the `manage_data_export -> manage_data_export` self-map.
    ['backup', 'manage_data_export'],
    // G05: attaching a file (the LOGO rides exactly this link) or a custom field to a document
    // template costs what writing the template costs (`manage_document_templates`, the capability
    // every G05 write gates on), so branding the workspace's outward face through the link is
    // exactly as hard as branding it through the verb.
    ['document_template', 'manage_document_templates'],
    // G06: attaching data to a delivered inbox item costs what minting one costs. The row is
    // produced by the automation engine's delivery action (`notifications_deliver` gates on
    // `manage_automations`), so annotating a delivery artifact is exactly as hard as managing the
    // rules that mint it; reading resolves through the existing read_automations twin.
    ['inbox_item', 'manage_automations'],
    // G07: the attachment-only saved-search hook rides the workspace table's self-tenant shape, so
    // linking a file to it (or writing a bounded custom field on it) annotates the workspace itself
    // and costs what governing the workspace costs, the same answer the `workspace` row gives.
    ['global_search', 'manage_settings'],
    // G02: attaching a file or a custom field to an installed plugin costs what managing the plugin
    // costs. A plugin's own writes gate on `manage_plugins` (installing third-party code is owner-only
    // by default), so annotating one is exactly as hard; reading resolves through the existing
    // `manage_plugins -> read_master_data` twin.
    ['plugin', 'manage_plugins'],
    // G05 §10: linking a file to a send-log row (say, a customer's complaint PDF on a disputed
    // send) costs exactly what annotating the row costs, the entities.ts reasoning verbatim.
    ['dispatch', 'manage_dispatch_texts'],
    // A31: a capture is a document-store record, so linking a file to one costs the E00 write right.
    ['capture', 'manage_files'],
    // A34: a payroll hand-off export is personnel data (the roster leaves the app as the artifact),
    // so linking a file to one costs what writing the hand-off costs (`hr.manage`, the capability the
    // export gates on), the E02 reasoning; reading resolves through the `hr.manage -> hr.read` twin.
    ['payroll_handoff', 'hr.manage'],
    // H00: a fixed-asset category is plain master data, so linking a file to one (or writing a custom
    // field on it) costs what editing the category costs (`manage_master_data`, the capability every
    // asset_category write gates on), exactly the entities.ts editCapability for the kind.
    ['asset_category', 'manage_master_data'],
    // H01: a fixed asset is master data carrying a financial baseline, so linking a file to one (a
    // purchase invoice, a photo, a warranty document) or writing a custom field on it costs what
    // editing the asset costs (`manage_master_data`, the capability every asset write gates on),
    // exactly the entities.ts editCapability for the kind.
    ['asset', 'manage_master_data'],
    // I00: a requisition is a plain operational document (no money path), so linking a file to one (or
    // writing a custom field on it) costs what editing the requisition costs (`manage_master_data`, the
    // capability every requisition write gates on), exactly the entities.ts editCapability for the kind.
    ['requisition', 'manage_master_data'],
    // J00: a warehouse is plain master data, so linking a file to one (or writing a custom field on
    // it) costs what editing the warehouse costs (`manage_master_data`, the capability every warehouse
    // write gates on), exactly the entities.ts editCapability for the kind. Locations ride the
    // `stock_location` kind above.
    ['warehouse', 'manage_master_data'],
    // J01: a lot and a serial are plain master data, so linking a file to one (or writing a custom
    // field on it) costs what editing the record costs (`manage_master_data`, the capability every
    // J01 write gates on), exactly the entities.ts editCapability for each kind.
    ['lot', 'manage_master_data'],
    ['serial', 'manage_master_data'],
    // H05: a fixed-asset location is plain master data, so linking a file to one (a floor plan, a
    // lease document) or writing a custom field on it costs what editing the location costs
    // (`manage_master_data`, the capability every asset_location write gates on), exactly the
    // entities.ts editCapability for the kind. The transfer history is not a link surface (it rides
    // the `asset` kind), so no second row is added.
    ['asset_location', 'manage_master_data'],
    // I02: attaching the delivery note, the packing list or a photo of damaged goods to a
    // Wareneingang costs what editing the receipt costs (`manage_master_data`, the capability all
    // eight I02 writes gate on), exactly the entities.ts editCapability for the kind. Deliberately
    // NOT `post`: the receipt document is not itself the money path, it is the paperwork beside it,
    // and the movement it recognises is written by J02's `inventory_move`, which carries its own
    // gate. Anyone who may record the receipt may attach the note that evidences it, and nobody who
    // may not record one gains a side door by attaching a file to it.
    ['goods_receipt', 'manage_master_data'],
    // G20: attaching a file to an implementation project, a task or a sign-off (a signed go/no-go
    // sheet, a source-cancellation retention bundle) costs what running the implementation costs.
    // `manage_implementation` is the capability every G20 project/task write gates on (the sign-off
    // VERB rides commit_migration, but the sign-off ENTITY's annotations are governance data on a
    // project record, so they take the project capability), so a linked file on any of the three is
    // exactly as hard to write as the project it evidences.
    ['implementation_project', 'manage_implementation'],
    ['implementation_task', 'manage_implementation'],
    ['implementation_signoff', 'manage_implementation'],
  ]);
  assert.deepEqual(
    [...EXPECTED.keys()].filter((kind) => !ENTITY_KIND_IDS.includes(kind)),
    [],
    'an EXPECTED row names a kind the registry no longer has',
  );
  for (const kind of ENTITY_KIND_IDS) {
    const expected = EXPECTED.get(kind);
    assert.ok(expected !== undefined, `${kind} is registered but has no EXPECTED row here: state what linking to it costs`);
    assert.deepEqual(requiredCapabilitiesFor('files_link', { entityKind: kind }), [expected], `files_link on ${kind}`);
    assert.deepEqual(
      requiredCapabilitiesFor('set_field_value', { entityKind: kind }),
      requiredCapabilitiesFor('files_link', { entityKind: kind }),
      `${kind}: attaching a FILE and writing a custom FIELD must cost the same, or one of them is a side door`,
    );
  }
  // Fails CLOSED on a kind that is not registered: no built-in holds `manage_custom_fields`, and the
  // verb itself then answers `unknown_entity_kind`.
  assert.deepEqual(requiredCapabilitiesFor('files_link', { entityKind: 'unicorn' }), ['manage_custom_fields']);
  assert.deepEqual(requiredCapabilitiesFor('files_link', {}), ['manage_custom_fields']);
});

test('a bookkeeper files, tags, supersedes and reads: the everyday half is fully open', () => {
  const fixture = agentHolding('bookkeeper', 'bk');
  const folder = call(fixture, 'folders_upsert', { name: 'Belege', idempotencyKey: 'bk-f' });
  assert.equal(folder.ok, true, JSON.stringify(folder));

  const file = uploadAs(fixture, 'bk');
  assert.equal(call(fixture, 'files_update', { fileId: file.id, patch: { tags: ['beleg'] } }).ok, true);
  assert.equal(
    call(fixture, 'files_new_version', { fileId: file.id, contentBase64: B64, idempotencyKey: 'bk-v' }).ok,
    true,
  );
  assert.equal(call(fixture, 'files_search', { q: 'beleg' }).ok, true);
  assert.equal(call(fixture, 'files_get_content', { fileId: file.id }).ok, true);
  assert.equal(call(fixture, 'folders_list', {}).ok, true);
});

test('the SAME bookkeeper cannot shorten a retention or erase a record', () => {
  const fixture = agentHolding('bookkeeper', 'bk2');
  const file = uploadAs(fixture, 'bk2');

  const retention = call(fixture, 'files_set_retention', {
    fileId: file.id,
    retentionUntil: '2030-12-31',
    idempotencyKey: 'bk2-r',
  });
  assert.equal(retention.ok, false);
  assert.equal(retention.error, 'permission_denied');
  assert.equal(retention.capability, 'manage_settings', 'the refusal names the capability that was missing');

  const removal = call(fixture, 'files_delete', { fileId: file.id, idempotencyKey: 'bk2-d' });
  assert.equal(removal.ok, false);
  assert.equal(removal.error, 'permission_denied');
  assert.equal(removal.capability, 'manage_settings');

  // And nothing moved: the file is still there, still readable, still unretained.
  const still = call(fixture, 'files_search', {});
  assert.equal(still.files.length, 1);
  assert.equal(still.files[0].retentionUntil, null);
  assert.equal(still.files[0].pendingDelete, false);
});

test('a viewer reads the filing and writes nothing at all', () => {
  const fixture = agentHolding('viewer', 'vw');
  assert.equal(call(fixture, 'files_search', {}).ok, true);
  assert.equal(call(fixture, 'folders_list', {}).ok, true);
  const refused = call(fixture, 'files_upload', { contentBase64: B64, idempotencyKey: 'vw-u' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'manage_files');
});

test('F7: a viewer sees that a file exists and cannot download a single byte of it', () => {
  // THE REPRODUCTION, kept as the test. An owner files a document carrying personal data; a read-only
  // invite then lists it, reads its title, size, checksum and retention date, and is refused the bytes.
  // Before F7 the same call answered `ok` with the payload in it.
  const owner = freshDeps();
  owner.actor = 'studio';
  const { workspaceId } = mintWorkspace(owner, 'Ablage GmbH', 'f7-ws');
  const personal = Buffer.from('AHV 756.1234.5678.97, Lohnabrechnung Juli').toString('base64');
  const stored = getAction('files_upload').run(owner, {
    workspaceId,
    title: 'Lohnabrechnung',
    filename: 'lohn.pdf',
    contentBase64: personal,
    idempotencyKey: 'f7-up',
  });
  assert.equal(stored.ok, true, JSON.stringify(stored));

  const invited = getAction('invite_member').run(owner, {
    workspaceId,
    email: 'f7@muster.ch',
    role: 'viewer',
    idempotencyKey: 'f7-invite',
  });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const seat = getAction('list_members')
    .run(owner, { workspaceId })
    .members.find((m) => m.actorId === 'agent');
  assert.equal(getAction('set_role').run(owner, { workspaceId, memberId: seat.memberId, role: 'viewer' }).ok, true);
  const viewer = { ...owner, actor: 'agent' };

  // The LIST is open, deliberately: knowing a Lohnabrechnung was filed is not reading it.
  const listed = getAction('files_search').run(viewer, { workspaceId });
  assert.equal(listed.ok, true);
  assert.equal(listed.files.length, 1);
  assert.equal(listed.files[0].title, 'Lohnabrechnung');

  const refused = getAction('files_get_content').run(viewer, { workspaceId, fileId: stored.file.id });
  assert.equal(refused.ok, false, 'the reproduction: this answered ok with the AHV number in the payload');
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'read_file_content');
  assert.equal(refused.contentBase64, undefined);
});

test('F8: a treuhaender posts an entry AND attaches its Buchungsbeleg', () => {
  // THE REPRODUCTION, kept as the test. This role holds `post` and not `manage_master_data`, so before
  // F8 both `files_upload` and `files_link` refused it: the fiduciary who keeps the books could post the
  // entry and not attach the document an audit asks to see.
  const fixture = agentHolding('treuhaender', 'th');
  const accounts = call(fixture, 'list_accounts', {}).accounts;
  const bank = accounts.find((a) => a.number === '1020') ?? accounts[0];
  const revenue = accounts.find((a) => a.number === '3000') ?? accounts[1];
  const entry = call(fixture, 'post_entry', {
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'th-e',
    lines: [
      { account: bank.id, debit: 12000 },
      { account: revenue.id, credit: 12000 },
    ],
  });
  assert.equal(entry.ok, true, `the mandate cannot post, so this test proves nothing: ${JSON.stringify(entry)}`);

  const filed = uploadAs(fixture, 'th');
  const linked = call(fixture, 'files_link', {
    fileId: filed.id,
    entityKind: 'journal_entry',
    entityId: entry.entryId,
    idempotencyKey: 'th-l',
  });
  assert.equal(linked.ok, true, `the Beleg could not be attached: ${JSON.stringify(linked)}`);
  assert.equal(linked.retentionDerived, true, 'and it picked up the OR 958f lock on the way in');
  assert.equal(linked.file.retentionUntil, '2036-12-31');

  // It can read the bytes back, which is the availability half of OR 958f Abs. 3 for the role most
  // likely to be asked to produce them.
  assert.equal(call(fixture, 'files_get_content', { fileId: filed.id }).ok, true);
  assert.equal(call(fixture, 'files_new_version', { fileId: filed.id, contentBase64: B64, idempotencyKey: 'th-v' }).ok, true);
  assert.equal(call(fixture, 'folders_upsert', { name: 'Belege', idempotencyKey: 'th-f' }).ok, true);
});

test('F8: the SAME treuhaender cannot attach a file to a record it may not write', () => {
  // The other half, and the one that makes the inheritance a real gate rather than a widening. This role
  // holds no `manage_master_data`, so a CONTACT is out of reach: linking a file to it must cost exactly
  // what writing the contact costs, and it does. It also still cannot move a statutory date or erase.
  const fixture = agentHolding('treuhaender', 'th2');
  const filed = uploadAs(fixture, 'th2');
  const refused = call(fixture, 'files_link', {
    fileId: filed.id,
    entityKind: 'contact',
    entityId: 'kontakt_1',
    idempotencyKey: 'th2-l',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'manage_master_data');

  const retention = call(fixture, 'files_set_retention', {
    fileId: filed.id,
    retentionUntil: '2040-12-31',
    idempotencyKey: 'th2-r',
  });
  assert.equal(retention.error, 'permission_denied');
  assert.equal(retention.capability, 'manage_settings');
  assert.equal(call(fixture, 'files_delete', { fileId: filed.id, idempotencyKey: 'th2-d' }).capability, 'manage_settings');
});

test('an owner does everything, including the two the bookkeeper could not', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Ablage GmbH', 'ow-ws');
  const fixture = { deps, workspaceId };
  const file = uploadAs(fixture, 'ow');

  assert.equal(
    call(fixture, 'files_set_retention', { fileId: file.id, retentionUntil: '2030-12-31', idempotencyKey: 'ow-r' }).ok,
    true,
  );
  // The retention is in the future now, so the delete is refused on the STATUTORY ground rather than
  // on the permission one. That distinction is the point of running it: a capability check that
  // swallowed the retention check would look identical from the outside if the answer were just false.
  const locked = call(fixture, 'files_delete', { fileId: file.id, idempotencyKey: 'ow-d1' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'retention_locked');

  const other = uploadAs(fixture, 'ow2');
  const removed = call(fixture, 'files_delete', { fileId: other.id, idempotencyKey: 'ow-d2' });
  assert.equal(removed.ok, true);
  assert.equal(removed.deleted, true, 'a studio actor is not P8-staged');
});

test('both doors give the identical answer for an E00 write, refused and accepted alike', async () => {
  // The parity claim, on E00's own verbs: MCP stdio and the REST twins are two thin adapters over ONE
  // array, and a gate that lived in only one of them would be a hole the size of the other.
  const mcpFixture = agentHolding('bookkeeper', 'wire-mcp');
  const restFixture = agentHolding('bookkeeper', 'wire-rest');

  // `handleRest(actionName, input, deps)`: a NAME dispatcher, not a path router. There is no
  // `POST /api/<path>` parsing anywhere in it, which is exactly why the specs' authored REST tables
  // were wrong about the shape (see `test/specs/spec-code-drift.test.mjs` on the route axis).
  const retention = { fileId: 'file_1', retentionUntil: '2030-12-31' };
  const viaMcp = callTool(mcpFixture.deps, 'files_set_retention', {
    workspaceId: mcpFixture.workspaceId,
    ...retention,
  });
  const viaRest = handleRest(
    'files_set_retention',
    { workspaceId: restFixture.workspaceId, ...retention },
    restFixture.deps,
  );
  const mcpBody = JSON.parse(viaMcp.content[0].text);
  assert.equal(mcpBody.error, 'permission_denied');
  assert.equal(viaRest.body.error, 'permission_denied');
  assert.equal(viaRest.status, 422, 'a domain refusal is 422 and never a 500');
  assert.equal(mcpBody.capability, viaRest.body.capability);

  const okViaRest = handleRest('folders_list', { workspaceId: restFixture.workspaceId }, restFixture.deps);
  assert.equal(okViaRest.status, 200);
  assert.equal(okViaRest.body.ok, true);
  assert.ok(Array.isArray(okViaRest.body.folders));
});
