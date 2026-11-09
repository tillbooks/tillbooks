// A41.3 re-cut v3, ONE HOLDER TRUTH (spec "A41.3 re-cut v3", revision 4): the probes the section lists. Every door
// that puts a receipt's bytes onto a booking-kind record, or moves an assigned file row off its line, is driven with
// an assigned file, over a PERSON row and an ENGINE row:
//  - machine variants (an agent under an open dial, a plugin running as a person, a person approving an agent's
//    draft) are refused receipt_assigned with nothing written;
//  - a person over a PERSON row: refused under the default belege.assigned_move = refuse, moved under `move`;
//  - a person over an ENGINE row: always proceeds, person_overrode (never blocks);
//  - a person's capture_commit: always releases, capture_committed.
// Plus the full-rollback probe per composite door, the draft-holder probe, the GL archive non-holder, R4-1 (the
// bytes stay blocked), the bexio documents step, repointFileLinks, and the SQL writer guard.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { makeContext } from '../../dist/core/context.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { attachBytes, getFileContent, repointFileLinks } from '../../dist/core/files/index.js';
import { addVorschlagHolders, draftReceiptHolders, HOLD_READ_CAPABILITY } from '../../dist/core/files/receiptGuard.js';
import { BELEG_READ_CAPABILITY } from '../../dist/core/banking/belegMatch.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { personBlocked } from '../../dist/core/banking/belegAssignmentStore.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { must, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, entryCount, TELCO } from './n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, activeOf, assignmentsOf, verb } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

let seq = 0;

/** A world with a PERSON row (`person`) or an ENGINE row (`engine`) on line `held`, the agent's dials open. */
function world(source) {
  seq += 1;
  const tag = `h${seq}`;
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: `rb-${tag}` }));
  at(t, '2026-07-20T08:00:00.000Z');
  let held;
  let r;
  if (source === 'person') {
    [held] = debits(t, [1910], { from: '2026-04-01' });
    r = receipt(t, { amount: 1910, vendor: TELCO, date: '2026-03-01' });
    must(assignBeleg(t, held, [r.fileId]));
  } else {
    [held] = debits(t, [90000], { from: '2026-07-19' });
    r = confirmedReceipt(t, { amount: 90000, vendor: TELCO, date: '2026-07-19' });
    reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  }
  assert.equal(activeOf(t, held)?.source, source === 'person' ? 'person' : 'engine_unique', 'precondition: the row stands');
  for (const capability of ['post', 'pay', 'close-period', 'customize', 'spesen']) {
    getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability, level: 'auto', idempotencyKey: `${tag}-dial-${capability}` });
  }
  const vendor = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: 'Neben AG', idempotencyKey: `${tag}-v` })).contact.id;
  return { t, held, r, tag, vendor };
}

const sha = (t, fileId) => t.store.db.prepare('SELECT sha256 FROM stored_file WHERE id = ?').get(fileId).sha256;
const rows = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);
const filedOnLine = (t, line) => t.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ?").get(t.workspaceId, line).n;
const snapshot = (w) => ({
  files: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n,
  home: w.t.store.db.prepare('SELECT entity_kind, entity_id FROM stored_file WHERE id = ?').get(w.r.fileId),
  rows: rows(w.t, w.held),
  decisions: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ? AND superseded_at IS NULL').get(w.t.workspaceId).n,
  entries: entryCount(w.t),
  bills: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(w.t.workspaceId).n,
  lines: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM expense_line WHERE workspace_id = ?').get(w.t.workspaceId).n,
  releases: w.t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'beleg_release'").get(w.t.workspaceId).n,
});

/** The channels an act runs through: three machine channels and the person. */
const CHANNELS = {
  agent: (w, name, input) => handleRest(name, { workspaceId: w.t.workspaceId, ...input }, { ...w.t.deps, actor: 'agent' }).body,
  plugin: (w, name, input) => withinPluginCall('user_1', () => getAction(name).run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId, ...input })),
  approved_draft: (w, name, input) => {
    const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
    const drafted = enqueueDraftedAction(agentCtx, { actionTool: name, payload: { workspaceId: w.t.workspaceId, ...input }, dialCapability: null, idempotencyKey: `${w.tag}-draft-${name}` });
    if (!drafted.ok) return drafted;
    return getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: drafted.actionId });
  },
  person: (w, name, input) => getAction(name).run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId, ...input }),
};

/** A draft vendor bill to file onto. */
const draftBill = (w) =>
  must(CHANNELS.person(w, 'create_vendor_bill', { vendorId: w.vendor, billDate: '2026-04-02', amountMinor: 1910, amountIsGross: true, expenseAccountId: w.t.acc('6570'), idempotencyKey: `${w.tag}-db` })).vendorBillId;

/** An employee's draft expense claim. */
const draftClaim = (w) => {
  const employeeId = must(CHANNELS.person(w, 'hr_employee_upsert', { employee: { firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01' }, idempotencyKey: `${w.tag}-emp` })).employeeId;
  return must(CHANNELS.person(w, 'expense_claim_create', { employeeId, title: 'Reise', idempotencyKey: `${w.tag}-claim` })).claimId;
};

/** The doors: each `prep` runs as a person (outside the snapshot), `act` through the channel under test. */
const DOORS = {
  'P1 book_bank_line attach to another line': {
    prep: (w) => debits(w.t, [1910], { from: '2026-05-10' })[0],
    act: (w, run, other) => run(w, 'book_bank_line', { bankTxnId: other, target: { kind: 'accounts', legs: [{ accountId: w.t.acc('6570'), amountMinor: 1910 }] }, attach: [{ fileId: w.r.fileId }], idempotencyKey: `${w.tag}-bbl` }),
  },
  'P2 files_link onto a booked line': {
    prep: (w) => {
      const [line] = debits(w.t, [1910], { from: '2026-05-15' });
      bookAsProposed(w.t, line);
      return line;
    },
    act: (w, run, line) => run(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `${w.tag}-flb` }),
  },
  'files_link onto another OPEN line': {
    prep: (w) => debits(w.t, [1910], { from: '2026-05-20' })[0],
    act: (w, run, line) => run(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `${w.tag}-flo` }),
  },
  'files_link onto a DRAFT bill': {
    prep: (w) => draftBill(w),
    act: (w, run, bill) => run(w, 'files_link', { fileId: w.r.fileId, entityKind: 'vendor_bill', entityId: bill, idempotencyKey: `${w.tag}-fld` }),
  },
  'files_link MOVING the assigned row to a contact': {
    prep: () => null,
    act: (w, run) => run(w, 'files_link', { fileId: w.r.fileId, entityKind: 'contact', entityId: w.vendor, idempotencyKey: `${w.tag}-flc` }),
  },
  'post_entry attach': {
    prep: () => null,
    act: (w, run) =>
      run(w, 'post_entry', { date: '2026-04-05', source: 'manual', description: 'Beleg', lines: [{ account: w.t.acc('6570'), debit: 1910 }, { account: w.t.acc('1020'), credit: 1910 }], attach: [{ fileId: w.r.fileId }], idempotencyKey: `${w.tag}-pe` }),
  },
  'create_vendor_bill receiptRef': {
    prep: () => null,
    act: (w, run) => run(w, 'create_vendor_bill', { vendorId: w.vendor, billDate: '2026-04-03', amountMinor: 1910, amountIsGross: true, expenseAccountId: w.t.acc('6570'), receiptRef: w.r.fileId, idempotencyKey: `${w.tag}-cvb` }),
  },
  'create_vendor_bill attach': {
    prep: () => null,
    act: (w, run) => run(w, 'create_vendor_bill', { vendorId: w.vendor, billDate: '2026-04-03', amountMinor: 1910, amountIsGross: true, expenseAccountId: w.t.acc('6570'), attach: [{ fileId: w.r.fileId }], idempotencyKey: `${w.tag}-cva` }),
  },
  'record_expense receiptRef': {
    prep: () => null,
    act: (w, run) => run(w, 'record_expense', { vendorId: w.vendor, billDate: '2026-04-03', amountMinor: 1910, amountIsGross: true, expenseAccountId: w.t.acc('6570'), receiptRef: w.r.fileId, idempotencyKey: `${w.tag}-rer` }),
  },
  'record_expense attach': {
    prep: () => null,
    act: (w, run) => run(w, 'record_expense', { vendorId: w.vendor, billDate: '2026-04-03', amountMinor: 1910, amountIsGross: true, expenseAccountId: w.t.acc('6570'), attach: [{ fileId: w.r.fileId }], idempotencyKey: `${w.tag}-rea` }),
  },
  'attach_receipt onto a draft bill': {
    prep: (w) => draftBill(w),
    act: (w, run, bill) => run(w, 'attach_receipt', { vendorBillId: bill, receiptRef: w.r.fileId, idempotencyKey: `${w.tag}-ar` }),
  },
  'expense_line_upsert receiptDocumentId': {
    prep: (w) => draftClaim(w),
    act: (w, run, claimId) => run(w, 'expense_line_upsert', { claimId, line: { expenseDate: '2026-04-04', category: 'travel', amountMinor: 1910, receiptDocumentId: w.r.fileId }, idempotencyKey: `${w.tag}-elu` }),
  },
  'files_new_version of the assigned file': {
    prep: () => null,
    act: (w, run) => run(w, 'files_new_version', { fileId: w.r.fileId, contentBase64: Buffer.from(`neue Fassung ${w.tag}`).toString('base64'), mime: 'image/png', idempotencyKey: `${w.tag}-nv` }),
  },
};

/** The doors the full-rollback probe drives (a composite: a booking or a record written before its link). */
const COMPOSITE = ['P1 book_bank_line attach to another line', 'post_entry attach', 'expense_line_upsert receiptDocumentId'];

for (const source of ['person', 'engine']) {
  for (const [door, d] of Object.entries(DOORS)) {
    for (const channel of ['agent', 'plugin', 'approved_draft']) {
      test(`${source} row, ${door}: a machine act (${channel}) is refused receipt_assigned and writes nothing`, () => {
        const w = world(source);
        const ctxArg = d.prep(w);
        const before = snapshot(w);
        const res = d.act(w, CHANNELS[channel], ctxArg);
        assert.equal(res.ok, false, JSON.stringify(res).slice(0, 240));
        assert.equal(res.error, 'receipt_assigned', JSON.stringify(res).slice(0, 240));
        assert.ok(Array.isArray(res.holders) && res.holders.some((h) => h.bankTxnId === w.held && typeof h.assignmentId === 'string'), 'the refusal names { bankTxnId, assignmentId }');
        assert.deepEqual(snapshot(w), before, 'nothing written');
      });
    }
    test(`${source} row, ${door}: a person act ${source === 'person' ? 'is refused under the default refuse' : 'overrides the engine row (person_overrode, never blocks)'}`, () => {
      const w = world(source);
      const ctxArg = d.prep(w);
      const before = snapshot(w);
      const res = d.act(w, CHANNELS.person, ctxArg);
      if (source === 'person') {
        assert.equal(res.error, 'receipt_assigned', JSON.stringify(res).slice(0, 240));
        assert.deepEqual(snapshot(w), before, 'nothing written');
      } else {
        assert.equal(res.ok, true, JSON.stringify(res).slice(0, 240));
        assert.deepEqual(rows(w.t, w.held), [['engine_unique', 'released', 'person_overrode']]);
        assert.equal(personBlocked(w.t.ctx, w.held, w.r.fileId), false, 'an override never blocks');
      }
    });
    if (source === 'person') {
      test(`person row, ${door}: under belege.assigned_move = move the receipt moves (person_moved) and the line is open, holding no file`, () => {
        const w = world('person');
        must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
        const ctxArg = d.prep(w);
        const res = d.act(w, CHANNELS.person, ctxArg);
        assert.equal(res.ok, true, JSON.stringify(res).slice(0, 240));
        assert.deepEqual(rows(w.t, w.held), [['person', 'released', 'person_moved']]);
        // A new version keeps its record by definition (E00): the new head stays on the line, unassigned; every
        // other door leaves the line holding no file.
        assert.equal(filedOnLine(w.t, w.held), door === 'files_new_version of the assigned file' ? 1 : 0, 'the old line holds no assigned file');
        assert.equal(personBlocked(w.t.ctx, w.held, w.r.fileId), false, 'a move never blocks');
        if (door === 'files_new_version of the assigned file') {
          // Owner, 07.11.2026 (E00 kept): the new version stays on the line without a capture; the line waits for a
          // person (fail-safe): no engine pairing, no autobook after a pass.
          const head = w.t.store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ?").get(w.t.workspaceId, w.held).id;
          assert.equal(w.t.store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ? AND document_id = ?').get(w.t.workspaceId, head).n, 0, 'no capture for the new version');
          autopilot(w.t).tick();
          reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
          assert.deepEqual(assignmentsOf(w.t, w.held).filter((a) => a.state === 'active'), [], 'the engine pairs nothing with the line');
          assert.equal(decisionOf(w.t, w.held), undefined, 'autobook does not book it');
        }
      });
    }
  }
}

for (const door of COMPOSITE) {
  test(`FULL ROLLBACK (${door}): under move, a later refusal of the same act (files.duplicate_beleg = refuse) leaves nothing behind`, () => {
    const w = world('person');
    must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
    must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'refuse', reason: 'test', idempotencyKey: `${w.tag}-dup` }));
    const ctxArg = DOORS[door].prep(w);
    // The same bytes start evidencing a posted entry (a twin), so the receipt guard refuses the act's link.
    const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
    const twin = must(CHANNELS.person(w, 'files_upload', { contentBase64: content.contentBase64, mime: 'image/png', filename: 'z.png', title: 'Zwilling', idempotencyKey: `${w.tag}-tw` })).file.id;
    const entry = must(postEntry(w.t.ctx, { date: '2026-02-02', source: 'manual', description: 'Zwilling', idempotencyKey: `${w.tag}-te`, lines: [{ account: w.t.acc('6570'), debit: 500 }, { account: w.t.acc('1020'), credit: 500 }] })).entryId;
    w.t.store.db.prepare("UPDATE stored_file SET entity_kind = 'journal_entry', entity_id = ? WHERE id = ?").run(entry, twin);
    const before = snapshot(w);
    const res = DOORS[door].act(w, CHANNELS.person, ctxArg);
    assert.equal(res.ok, false, JSON.stringify(res).slice(0, 240));
    assert.equal(res.error, 'receipt_already_booked', JSON.stringify(res).slice(0, 240));
    assert.deepEqual(snapshot(w), before, 'the assignment active, the line filed, no booking, no release');
    assert.equal(filedOnLine(w.t, w.held), 1);
  });
}

test('capture_commit: a person always releases (capture_committed, person row and engine row, under refuse); an agent of a person row is refused', () => {
  for (const source of ['person', 'engine']) {
    const w = world(source);
    const res = CHANNELS.person(w, 'capture_commit', { captureId: w.r.captureId, target: { kind: 'vendor_bill', vendorId: w.vendor, billDate: '2026-04-01', expenseAccountId: w.t.acc('6570') }, idempotencyKey: `${w.tag}-cc` });
    assert.equal(res.ok, true, `${source}: ${JSON.stringify(res).slice(0, 240)}`);
    assert.deepEqual(rows(w.t, w.held), [[source === 'person' ? 'person' : 'engine_unique', 'released', 'capture_committed']]);
    assert.equal(filedOnLine(w.t, w.held), 0);
  }
  const w = world('person');
  const before = snapshot(w);
  const res = CHANNELS.agent(w, 'capture_commit', { captureId: w.r.captureId, target: { kind: 'vendor_bill', vendorId: w.vendor, billDate: '2026-04-01', expenseAccountId: w.t.acc('6570') }, idempotencyKey: `${w.tag}-cca` });
  assert.equal(res.error, 'receipt_assigned');
  assert.deepEqual(snapshot(w), before);
});

test('the drop link (attachBytes, the redemption core): the assigned bytes onto a booked line, machine refused, person refused under refuse', () => {
  const w = world('person');
  const [line] = debits(w.t, [1910], { from: '2026-05-25' });
  bookAsProposed(w.t, line);
  const bytes = Buffer.from(must(getFileContent(w.t.ctx, { fileId: w.r.fileId })).contentBase64, 'base64');
  const file = { bytes, mime: 'image/png', filename: 'drop.png', sha256: sha(w.t, w.r.fileId) };
  const before = snapshot(w);
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  assert.equal(w.t.store.tx(() => attachBytes(agentCtx, file, 'bank_txn', line)).error, 'receipt_assigned');
  assert.equal(w.t.store.tx(() => attachBytes(w.t.ctx, file, 'bank_txn', line)).error, 'receipt_assigned');
  assert.deepEqual(snapshot(w), before);
});

test('a twin of the assigned bytes onto a NON-booking record (a contact) is no holder move: allowed for anyone, nothing released', () => {
  const w = world('person');
  const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
  const twin = must(CHANNELS.person(w, 'files_upload', { contentBase64: content.contentBase64, mime: 'image/png', filename: 't.png', title: 'Kopie', idempotencyKey: `${w.tag}-ct` })).file.id;
  const res = CHANNELS.agent(w, 'files_link', { fileId: twin, entityKind: 'contact', entityId: w.vendor, idempotencyKey: `${w.tag}-ctl` });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
  assert.deepEqual(rows(w.t, w.held), [['person', 'active', null]]);
});

test('drafted card: an agent\'s Vorschlag attaching an assigned receipt is refused at approval naming { bankTxnId, assignmentId }; after "Lösen" the approval runs', () => {
  const w = world('person');
  const [other] = debits(w.t, [1910], { from: '2026-05-12' });
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  const drafted = must(
    enqueueDraftedAction(agentCtx, {
      actionTool: 'book_bank_line',
      payload: { workspaceId: w.t.workspaceId, bankTxnId: other, target: { kind: 'accounts', legs: [{ accountId: w.t.acc('6570'), amountMinor: 1910 }] }, attach: [{ fileId: w.r.fileId }], idempotencyKey: `${w.tag}-dc` },
      dialCapability: null,
      idempotencyKey: `${w.tag}-dc-row`,
    }),
  );
  const approve = () => getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: drafted.actionId });
  const refused = approve();
  assert.equal(refused.error, 'receipt_assigned');
  assert.deepEqual(refused.holders.map((h) => [h.bankTxnId, typeof h.assignmentId]), [[w.held, 'string']]);
  assert.equal(w.t.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(drafted.actionId).status, 'pending', 'the Vorschlag stays pending');
  must(verb(w.t, 'release_beleg', { bankTxnId: w.held }));
  const ran = approve();
  assert.equal(ran.ok, true, JSON.stringify(ran).slice(0, 200));
  assert.equal(decisionOf(w.t, other)?.state, 'booked');
});

test('files.duplicate_beleg = allow and a person\'s bookAgain do not pass an assigned receipt', () => {
  const w = world('person');
  must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'allow', reason: 'test', idempotencyKey: `${w.tag}-allow` }));
  const [line] = debits(w.t, [1910], { from: '2026-05-30' });
  bookAsProposed(w.t, line);
  const res = CHANNELS.person(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, bookAgain: true, overrideReason: 'trotzdem', idempotencyKey: `${w.tag}-ba` });
  assert.equal(res.error, 'receipt_assigned');
  assert.deepEqual(rows(w.t, w.held), [['person', 'active', null]]);
});

test('belege.assigned_move reads refuse by default and is human-only', () => {
  const w = world('person');
  const got = must(getAction('settings_get').run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId, key: 'belege.assigned_move' }));
  assert.equal(got.setting?.value ?? got.value, 'refuse');
  assert.equal(CHANNELS.agent(w, 'settings_set', { key: 'belege.assigned_move', value: 'move', reason: 'x', idempotencyKey: `${w.tag}-ag` }).error, 'human_only');
});

test('a move onto a DRAFT bill: the old line never re-pairs or autobooks the same receipt while the draft holds it', () => {
  const w = world('person');
  must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
  must(settingsSet(w.t.ctx, { key: 'belege.autobook_figure_trust', value: 'agent', reason: 'test', idempotencyKey: `${w.tag}-tr` }));
  const bill = draftBill(w);
  // A twin of the bytes onto the draft bill (attach_receipt files a second row: the draft holds the bytes).
  must(CHANNELS.person(w, 'attach_receipt', { vendorBillId: bill, receiptRef: w.r.fileId, idempotencyKey: `${w.tag}-arm` }));
  assert.deepEqual(rows(w.t, w.held), [['person', 'released', 'person_moved']]);
  autopilot(w.t).tick();
  reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
  assert.deepEqual(assignmentsOf(w.t, w.held).filter((a) => a.state === 'active'), [], 'the draft bill holds the bytes: no re-pairing');
  assert.equal(decisionOf(w.t, w.held), undefined);
});

test('a move of one file of a TWO-file group unfiles both from the old line', () => {
  const w = world('person');
  must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
  const [line2] = debits(w.t, [1920], { from: '2026-04-08' });
  const a = receipt(w.t, { amount: 1920, vendor: TELCO, date: '2026-03-02' });
  const b = receipt(w.t, { amount: 1920, vendor: TELCO, date: '2026-03-03' });
  must(assignBeleg(w.t, line2, [a.fileId, b.fileId]));
  assert.equal(filedOnLine(w.t, line2), 2);
  const [other] = debits(w.t, [1920], { from: '2026-05-05' });
  bookAsProposed(w.t, other);
  must(CHANNELS.person(w, 'files_link', { fileId: a.fileId, entityKind: 'bank_txn', entityId: other, idempotencyKey: `${w.tag}-g` }));
  assert.deepEqual(rows(w.t, line2), [['person', 'released', 'person_moved']]);
  assert.equal(filedOnLine(w.t, line2), 0, 'the whole group left the old line');
});

test('reason table: "Lösen" records person on a person row and person_rejected on an engine row, both block; no implicit release blocks', () => {
  const p = world('person');
  must(verb(p.t, 'release_beleg', { bankTxnId: p.held }));
  assert.deepEqual(rows(p.t, p.held), [['person', 'released', 'person']]);
  assert.equal(personBlocked(p.t.ctx, p.held, p.r.fileId), true);
  const e = world('engine');
  must(verb(e.t, 'release_beleg', { bankTxnId: e.held }));
  assert.deepEqual(rows(e.t, e.held), [['engine_unique', 'released', 'person_rejected']]);
  assert.equal(personBlocked(e.t.ctx, e.held, e.r.fileId), true);
  // An implicit release (the line ignored by a person): never blocks.
  const i = world('engine');
  must(getAction('ignore_bank_line').run({ ...i.t.deps, actor: 'user_1' }, { workspaceId: i.t.workspaceId, bankTxnId: i.held, reason: 'booked_elsewhere', note: 'x', idempotencyKey: 'ri' }));
  assert.equal(personBlocked(i.t.ctx, i.held, i.r.fileId), false);
});

test('R4-1: a rejected receipt discarded and re-dropped (a new file id, the same bytes) stays blocked for that line, under agent trust', () => {
  const w = world('engine');
  must(settingsSet(w.t.ctx, { key: 'belege.autobook_figure_trust', value: 'agent', reason: 'test', idempotencyKey: `${w.tag}-tr` }));
  must(verb(w.t, 'release_beleg', { bankTxnId: w.held }));
  const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
  must(CHANNELS.person(w, 'capture_discard', { captureId: w.r.captureId, reason: 'neu', idempotencyKey: `${w.tag}-d` }));
  // An agent re-drops the very bytes and reads them again: an agent alone, under agent trust.
  const again = must(CHANNELS.agent(w, 'capture_document', { contentBase64: content.contentBase64, mime: 'image/png', filename: 'wieder.png', idempotencyKey: `${w.tag}-re` }));
  must(CHANNELS.agent(w, 'capture_extract', { captureId: again.captureId, source: 'agent', fields: [{ key: 'amount', value: { minor: 90000, currency: 'CHF' }, confidence: 'high' }, { key: 'vendor_name', value: TELCO, confidence: 'high' }, { key: 'invoice_date', value: '2026-07-19', confidence: 'high' }], idempotencyKey: `${w.tag}-rx` }));
  reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
  assert.deepEqual(assignmentsOf(w.t, w.held).filter((a) => a.state === 'active'), [], 'the rejected bytes never come back to this line');
});

test('a receipt filed on a GL archive entry is no holder: it still pairs and books on its TILL line', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: 'gl-rb' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'test', idempotencyKey: 'gl-sc' }));
  must(getAction('grant_rule_autobook').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, standardId: t.ruleId, idempotencyKey: 'gl-g' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const [line] = debits(t, [1450], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1450, vendor: TELCO, date: '2026-07-19' });
  // A twin of the bytes on an archived bexio booking (the mirror's comparison base).
  const content = must(getFileContent(t.ctx, { fileId: r.fileId }));
  const twin = must(getAction('files_upload').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: content.contentBase64, mime: 'image/png', filename: 'bexio.png', title: 'bexio', idempotencyKey: 'gl-tw' })).file.id;
  t.store.db.prepare("UPDATE stored_file SET entity_kind = 'gl_archive_entry', entity_id = 'gla_synthetic' WHERE id = ?").run(twin);
  autopilot(t).tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
});

test('FULL ROLLBACK (capture_commit): a person commit releases first, then the bill\'s attach is refused (files.duplicate_beleg = refuse): nothing behind', () => {
  const w = world('person');
  must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'refuse', reason: 'test', idempotencyKey: `${w.tag}-dup` }));
  const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
  const twin = must(CHANNELS.person(w, 'files_upload', { contentBase64: content.contentBase64, mime: 'image/png', filename: 'z.png', title: 'Zwilling', idempotencyKey: `${w.tag}-tw` })).file.id;
  const entry = must(postEntry(w.t.ctx, { date: '2026-02-02', source: 'manual', description: 'Zwilling', idempotencyKey: `${w.tag}-te`, lines: [{ account: w.t.acc('6570'), debit: 500 }, { account: w.t.acc('1020'), credit: 500 }] })).entryId;
  w.t.store.db.prepare("UPDATE stored_file SET entity_kind = 'journal_entry', entity_id = ? WHERE id = ?").run(entry, twin);
  const before = snapshot(w);
  const status = () => w.t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(w.r.captureId).status;
  const was = status();
  const res = CHANNELS.person(w, 'capture_commit', { captureId: w.r.captureId, target: { kind: 'vendor_bill', vendorId: w.vendor, billDate: '2026-04-01', expenseAccountId: w.t.acc('6570') }, idempotencyKey: `${w.tag}-ccr` });
  assert.equal(res.ok, false, JSON.stringify(res).slice(0, 240));
  assert.equal(res.error, 'receipt_already_booked', JSON.stringify(res).slice(0, 240));
  assert.deepEqual(snapshot(w), before, 'the assignment active, the line filed, no bill, no release');
  assert.equal(filedOnLine(w.t, w.held), 1);
  assert.equal(status(), was, 'the capture is not committed');
});

test('capture_commit to an EXPENSE line: a person releases (capture_committed), person row and engine row; an agent is refused', () => {
  for (const source of ['person', 'engine']) {
    const w = world(source);
    const claimId = draftClaim(w);
    const res = CHANNELS.person(w, 'capture_commit', { captureId: w.r.captureId, target: { kind: 'expense_line', claimId, category: 'travel', expenseDate: '2026-04-04' }, idempotencyKey: `${w.tag}-cce` });
    assert.equal(res.ok, true, `${source}: ${JSON.stringify(res).slice(0, 240)}`);
    assert.deepEqual(rows(w.t, w.held), [[source === 'person' ? 'person' : 'engine_unique', 'released', 'capture_committed']]);
    assert.equal(filedOnLine(w.t, w.held), 0);
  }
  const w = world('engine');
  const claimId = draftClaim(w);
  const before = snapshot(w);
  const res = CHANNELS.agent(w, 'capture_commit', { captureId: w.r.captureId, target: { kind: 'expense_line', claimId, category: 'travel', expenseDate: '2026-04-04' }, idempotencyKey: `${w.tag}-cea` });
  assert.equal(res.error, 'receipt_assigned', JSON.stringify(res).slice(0, 240));
  assert.deepEqual(snapshot(w), before);
});

test('after a person_moved the line is open, holds no file, and the engine may pair ANOTHER receipt with it', () => {
  const w = world('person');
  must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
  const [line] = debits(w.t, [1910], { from: '2026-05-16' });
  bookAsProposed(w.t, line);
  must(CHANNELS.person(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `${w.tag}-ml` }));
  assert.deepEqual(rows(w.t, w.held), [['person', 'released', 'person_moved']]);
  assert.equal(filedOnLine(w.t, w.held), 0);
  assert.equal(personBlocked(w.t.ctx, w.held, w.r.fileId), false);
  // A second receipt for the same line: the pass pairs it.
  const heldDate = w.t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(w.held)?.booking_date ?? '2026-04-01';
  const next = confirmedReceipt(w.t, { amount: 1910, vendor: TELCO, date: heldDate });
  reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
  const active = assignmentsOf(w.t, w.held).filter((a) => a.state === 'active');
  assert.equal(active.length, 1, JSON.stringify(assignmentsOf(w.t, w.held)).slice(0, 300));
  assert.equal(active[0].source, 'engine_unique');
  const files = w.t.store.db.prepare('SELECT file_id FROM beleg_assignment_file WHERE assignment_id = ?').all(active[0].id).map((f) => f.file_id);
  assert.deepEqual(files, [next.fileId]);
});

test('the read side: an assignment-held receipt is no candidate for another line with the same figures', () => {
  const w = world('engine');
  const [other] = debits(w.t, [90000], { from: '2026-07-19' });
  const inboxLine = (id) => must(listBankInbox(w.t.ctx, { bankTxnId: id, status: 'all' })).lines[0];
  const ids = (inboxLine(other).belegCandidates ?? []).flatMap((g) => g.files.map((f) => f.fileId));
  assert.equal(ids.includes(w.r.fileId), false, 'the held receipt is offered to no other line');
  must(verb(w.t, 'release_beleg', { bankTxnId: w.held }));
  const freed = (inboxLine(other).belegCandidates ?? []).flatMap((g) => g.files.map((f) => f.fileId));
  assert.equal(freed.includes(w.r.fileId), true, 'once released, the receipt is a candidate again');
});

test('D4 the liveness transition: a line holding a twin of assigned bytes is refused when it becomes live, for anyone', () => {
  for (const channel of ['agent', 'person']) {
    const w = world('person');
    must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
    const [other] = debits(w.t, [1910], { from: '2026-05-02' });
    // Legacy state (filed before v3): a twin of the assigned bytes already sits on the open line.
    const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
    const twin = must(CHANNELS.person(w, 'files_upload', { contentBase64: content.contentBase64, mime: 'image/png', filename: 'l.png', title: 'Zwilling', idempotencyKey: `${w.tag}-lt` })).file.id;
    w.t.store.db.prepare("UPDATE stored_file SET entity_kind = 'bank_txn', entity_id = ? WHERE id = ?").run(other, twin);
    const before = snapshot(w);
    const res = CHANNELS[channel](w, 'book_bank_line', { bankTxnId: other, target: { kind: 'accounts', legs: [{ accountId: w.t.acc('6570'), amountMinor: 1910 }] }, idempotencyKey: `${w.tag}-lv` });
    assert.equal(res.error, 'receipt_assigned', `${channel}: ${JSON.stringify(res).slice(0, 240)}`);
    assert.deepEqual(snapshot(w), before, `${channel}: nothing booked, nothing released`);
    assert.equal(decisionOf(w.t, other), undefined);
  }
});

test('D7 the drafted card lists the assignment hold, under files.duplicate_beleg = allow too', () => {
  const w = world('person');
  const [open] = debits(w.t, [1910], { from: '2026-05-03' });
  const names = (verb, input) => draftReceiptHolders(w.t.ctx, verb, input).filter((h) => h.entityKind === 'beleg_assignment').map((h) => [h.bankTxnId, typeof h.assignmentId]);
  const onOpen = { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: open };
  const toContact = { fileId: w.r.fileId, entityKind: 'contact', entityId: w.vendor };
  const version = { fileId: w.r.fileId, contentBase64: Buffer.from('v2').toString('base64'), mime: 'image/png' };
  assert.deepEqual(names('files_link', onOpen), [[w.held, 'string']], 'onto an open line');
  assert.deepEqual(names('files_link', toContact), [[w.held, 'string']], 'moving it to a contact');
  assert.deepEqual(names('files_new_version', version), [[w.held, 'string']], 'a new version');
  assert.deepEqual(names('files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: w.held }), [], 'its own line is no hold');
  must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'allow', reason: 'test', idempotencyKey: `${w.tag}-al` }));
  assert.deepEqual(names('files_link', onOpen), [[w.held, 'string']], 'allow drops no assignment hold');
});

test('D16 capture intake of assigned bytes with no live capture answers alreadyBooked naming the assignment', () => {
  const w = world('person');
  const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
  // The capture is set aside by SQL (a legacy row): the assignment keeps its file, the bytes have no live capture.
  w.t.store.db.prepare("UPDATE captures SET status = 'discarded' WHERE id = ?").run(w.r.captureId);
  const again = must(CHANNELS.person(w, 'capture_document', { contentBase64: content.contentBase64, mime: 'image/png', filename: 'nochmals.png', idempotencyKey: `${w.tag}-in` }));
  assert.equal(again.alreadyBooked, true, JSON.stringify(again).slice(0, 300));
  assert.ok(again.holders.some((h) => h.entityKind === 'beleg_assignment' && h.bankTxnId === w.held && typeof h.assignmentId === 'string'), JSON.stringify(again.holders));
});

test('list_drafted_actions: the card carries an assignment hold as { entityKind, entityId, reservedBy, assignmentId, bankTxnId, source }, no file id', () => {
  const w = world('person');
  const [open] = debits(w.t, [1910], { from: '2026-05-04' });
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  const input = { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: open, idempotencyKey: `${w.tag}-cd` };
  const drafted = must(enqueueDraftedAction(agentCtx, { actionTool: 'files_link', payload: { workspaceId: w.t.workspaceId, ...input }, dialCapability: null, idempotencyKey: `${w.tag}-cd-row` }));
  // What the transport seam stores for the card (agent-gate: `draftReceiptHolders` of the drafted call).
  w.t.store.tx(() => addVorschlagHolders(w.t.ctx, drafted.actionId, draftReceiptHolders(w.t.ctx, 'files_link', input)));
  const listed = must(getAction('list_drafted_actions').run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId }));
  const card = listed.actions.find((a) => a.actionId === drafted.actionId);
  const assignmentId = activeOf(w.t, w.held).id;
  assert.deepEqual(card.receiptHolders, [{ entityKind: 'beleg_assignment', entityId: w.held, reservedBy: null, assignmentId, bankTxnId: w.held, source: 'person' }]);
  // The same shape the approval's refusal names.
  const refused = getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: drafted.actionId });
  assert.equal(refused.error, 'receipt_assigned');
  assert.deepEqual(refused.holders.map((h) => [h.assignmentId, h.bankTxnId, h.source]), [[assignmentId, w.held, 'person']]);
});

// --- r4 C1 (I-E): ONE redaction of holders for a seat without the receipt read right ------------------

/** Seat the local agent as a member whose role lacks `read_master_data` (the e3-permissions shape, as C1). */
function seatWithoutReceipts(w, capabilities) {
  const owner = { ...w.t.deps, actor: 'studio' };
  const role = must(getAction('define_role').run(owner, { workspaceId: w.t.workspaceId, name: `Ohne Belege ${w.tag}`, capabilities, idempotencyKey: `${w.tag}-role` }));
  must(getAction('invite_member').run(owner, { workspaceId: w.t.workspaceId, email: `${w.tag}@muster.ch`, role: 'bookkeeper', idempotencyKey: `${w.tag}-inv` }));
  const seat = (getAction('list_members').run(owner, { workspaceId: w.t.workspaceId }).members ?? []).find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'precondition: the agent is a member');
  must(getAction('set_role').run(owner, { workspaceId: w.t.workspaceId, memberId: seat.memberId, role: role.roleId }));
}

const MARKER = { entityKind: 'receipt_held', entityId: null, reservedBy: null };
const viaRest = (w, name, input) => handleRest(name, { workspaceId: w.t.workspaceId, ...input }, { ...w.t.deps, actor: 'agent' }).body;
const viaMcp = (w, name, input) => JSON.parse(callTool({ ...w.t.deps, actor: 'agent' }, name, { workspaceId: w.t.workspaceId, ...input }).content[0].text);

test('r4 C1: the receipt read right the redaction asks is the A41 read right', () => {
  assert.equal(HOLD_READ_CAPABILITY, BELEG_READ_CAPABILITY);
});

test('r4 C1: the refusal names an assignment hold only to a seat that reads receipts; any other seat gets one marker, same refusal (REST and MCP)', () => {
  for (const [transport, call] of [['rest', viaRest], ['mcp', viaMcp]]) {
    const w = world('person');
    const [line] = debits(w.t, [1910], { from: '2026-05-21' });
    bookAsProposed(w.t, line);
    // A reading seat first: the hold in full.
    const full = call(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `${w.tag}-${transport}-a` });
    assert.equal(full.error, 'receipt_assigned', `${transport}: ${JSON.stringify(full).slice(0, 200)}`);
    assert.deepEqual(full.holders.map((h) => [h.entityKind, h.bankTxnId, typeof h.assignmentId, h.source]), [['beleg_assignment', w.held, 'string', 'person']]);
    seatWithoutReceipts(w, ['read_books', 'read_sales', 'post', 'pay', 'manage_files']);
    const before = snapshot(w);
    const res = call(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `${w.tag}-${transport}-b` });
    assert.equal(res.error, 'receipt_assigned', `${transport}: still refused ${JSON.stringify(res).slice(0, 200)}`);
    assert.deepEqual(res.holders, [MARKER], `${transport}: no line, id or source`);
    assert.equal(JSON.stringify(res).includes(w.held), false, `${transport}: the line id appears nowhere in the refusal`);
    assert.deepEqual(snapshot(w), before);
  }
});

test('r4 C1: the drafted card shows a seat without receipts one marker (REST and MCP); a reading seat the full hold', () => {
  const w = world('person');
  const [line] = debits(w.t, [1910], { from: '2026-05-22' });
  bookAsProposed(w.t, line);
  getAction('set_agent_dial').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, capability: 'close-period', level: 'ask', idempotencyKey: `${w.tag}-dial-cp` });
  const drafted = viaRest(w, 'files_link', { fileId: w.r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `${w.tag}-cl` });
  assert.equal(typeof drafted.actionId, 'string', `precondition: drafted ${JSON.stringify(drafted).slice(0, 200)}`);
  const cardOf = (body) => (body.actions ?? []).find((a) => a.actionId === drafted.actionId);
  const reading = must(getAction('list_drafted_actions').run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId }));
  assert.ok(cardOf(reading).receiptHolders.some((h) => h.entityKind === 'beleg_assignment' && h.bankTxnId === w.held && typeof h.assignmentId === 'string' && h.source === 'person'));
  seatWithoutReceipts(w, ['read_books', 'read_sales']);
  for (const [transport, call] of [['rest', viaRest], ['mcp', viaMcp]]) {
    const card = cardOf(call(w, 'list_drafted_actions', {}));
    assert.ok(card !== undefined, `${transport}: the card is listed`);
    assert.deepEqual(card.receiptHolders.filter((h) => h.entityKind === 'beleg_assignment' || h.entityKind === 'receipt_held'), [MARKER], `${transport}: one marker`);
    assert.equal(JSON.stringify(card.receiptHolders).includes(w.held), false, `${transport}: the line id appears nowhere on the card's holders`);
  }
});

test('repointFileLinks refuses a non-contact kind and writes nothing; a contact merge passes', () => {
  const w = world('person');
  const before = snapshot(w);
  assert.throws(() => repointFileLinks(w.t.ctx, { entityKind: 'bank_txn', fromId: w.held, toId: 'btxn_other' }), /invalid_input/);
  assert.deepEqual(snapshot(w), before);
  assert.equal(repointFileLinks(w.t.ctx, { entityKind: 'contact', fromId: w.vendor, toId: w.vendor + 'x' }), 0);
});

test('the bexio documents step: an assigned file is skipped and reported, the free one links, nothing released', () => {
  const w = world('person');
  const call = (name, input) => getAction(name).run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, ...input });
  const content = must(getFileContent(w.t.ctx, { fileId: w.r.fileId }));
  const assignedTwin = must(call('files_upload', { contentBase64: content.contentBase64, mime: 'text/csv', filename: 'a.csv', title: 'Beleg a', idempotencyKey: 'bx-a' })).file.id;
  const free = must(call('files_upload', { contentBase64: Buffer.from('a,b\n1,2\n').toString('base64'), mime: 'text/csv', filename: 'b.csv', title: 'Beleg b', idempotencyKey: 'bx-b' })).file.id;
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: 'bx-plan' })).planId;
  must(call('migration_discover_source', { fileIds: [assignedTwin, free], planId }));
  w.t.store.db.prepare("UPDATE migration_source_file SET data_classes = '[\"documents\"]' WHERE plan_id = ?").run(planId);
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'documents', include: true }], idempotencyKey: 'bx-scope' }));
  const stepId = scope.steps.find((s) => s.dataClass === 'documents').stepId;
  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'bx-trial' }));
  const committed = must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'bx-commit' }));
  assert.deepEqual(committed.skippedAssigned, [{ fileId: assignedTwin, bankTxnId: w.held }]);
  assert.deepEqual(committed.created, [free]);
  assert.deepEqual(rows(w.t, w.held), [['person', 'active', null]]);
});

// --- The SQL writer guard (paper H1/H4): every statement that writes a file's link, or an assignment row, is named --

const ROOT = new URL('../../src', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
/** The function a source offset sits in (the nearest preceding `function name(`). */
const enclosing = (text, at) => {
  const before = text.slice(0, at);
  const m = [...before.matchAll(/function (\w+)\s*[(<]/g)].at(-1);
  return m === undefined ? '<module>' : m[1];
};

/**
 * A TypeScript tokenizer just good enough for the guard: comments become spaces (offsets kept), and every string or
 * template literal is a span. A template's `${...}` stays in its span verbatim (a dynamic part), with nested literals
 * inside it handled. r4: replaces the regex comment strip, which also ate `//` inside strings.
 */
function scanSource(src) {
  const out = src.split('');
  const spans = [];
  const stack = []; // modes: { kind: 'tpl', start } | { kind: 'expr', depth }
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const top = stack.at(-1);
    const c = src[i];
    if (top?.kind === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); if (!stack.some((m) => m.kind === 'tpl')) spans.push({ start: top.start, end: i + 1 }); i += 1; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'expr', depth: 0 }); i += 2; continue; }
      i += 1;
      continue;
    }
    // code, or a template expression
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (!stack.some((m) => m.kind === 'tpl')) spans.push({ start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '`') { stack.push({ kind: 'tpl', start: i }); i += 1; continue; }
    if (c === '/') {
      let p = i - 1;
      while (p >= 0 && /\s/.test(src[p])) p -= 1;
      if (p < 0 || '(,=:[!&|?{};'.includes(src[p]) || /\b(return|typeof)$/.test(src.slice(Math.max(0, p - 6), p + 1))) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j += 1;
        }
        i = j + 1;
        continue;
      }
    }
    if (top?.kind === 'expr') {
      if (c === '{') top.depth += 1;
      if (c === '}') { if (top.depth === 0) { stack.pop(); i += 1; continue; } top.depth -= 1; }
    }
    i += 1;
  }
  return { text: out.join(''), spans };
}

const GUARDED = new Set(['stored_file', 'beleg_assignment', 'beleg_assignment_file']);
const WRITE_HEAD = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+["`[]?(\$\{[^}]*\}|[\w.]+)["`\]]?/gi;
const unquote = (t) => t.replace(/["`[\]]/g, '').split('.').at(-1).toLowerCase();
const LINK_COL = /\bentity_(kind|id)\b/i;

/** Split a parenthesised list at its top-level commas. */
const topLevel = (s) => {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
};
/** The text inside the parenthesis that opens at `from` (or null). */
const paren = (s, from) => {
  if (s[from] !== '(') return null;
  let depth = 0;
  for (let k = from; k < s.length; k++) {
    if (s[k] === '(') depth += 1;
    if (s[k] === ')') { depth -= 1; if (depth === 0) return { inner: s.slice(from + 1, k), end: k + 1 }; }
  }
  return null;
};

/**
 * Classify every SQL write in one source. Answers `{ link, assign, dynamicTable }` as lists of
 * `{ at, why }`. Fail-closed: a statement on `stored_file` whose link columns cannot be read (a dynamic SET list, a
 * dynamic column or value list, a concatenated tail, no column list) counts as a LINK WRITER, so it needs a name.
 */
function classifyWrites(src) {
  const { text, spans } = scanSource(src);
  const found = { link: [], assign: [], dynamicTable: [] };
  for (const sp of spans) {
    const lit = text.slice(sp.start + 1, sp.end - 1);
    // A literal followed by `+` is concatenated: its tail is dynamic.
    const concat = /^\s*\+/.test(text.slice(sp.end, sp.end + 20));
    for (const m of lit.matchAll(WRITE_HEAD)) {
      const at = sp.start + 1 + m.index;
      const rawTable = m[2];
      const body = lit.slice(m.index + m[0].length);
      if (rawTable.startsWith('${')) {
        found.dynamicTable.push({ at, why: `${m[1].toUpperCase()} into a dynamic table ${rawTable}` });
        continue;
      }
      const table = unquote(rawTable);
      if (table === 'beleg_assignment' || table === 'beleg_assignment_file') {
        found.assign.push({ at, why: `${m[1].toUpperCase()} ${table}` });
        continue;
      }
      if (table !== 'stored_file') continue;
      const head = m[1].toUpperCase();
      const dynamicTail = concat;
      if (head.startsWith('UPDATE')) {
        const set = /^\s*SET\b([\s\S]*?)(\bWHERE\b|$)/i.exec(body);
        const setList = set === null ? body : set[1];
        if (set === null || setList.includes('${') || (dynamicTail && set[2] === '')) found.link.push({ at, why: 'UPDATE stored_file with a SET list the guard cannot read' });
        else if (LINK_COL.test(setList.replace(/["`[\]]/g, ''))) found.link.push({ at, why: 'UPDATE stored_file SET entity_*' });
        continue;
      }
      // INSERT / REPLACE
      const open = body.search(/\S/);
      const cols = open === -1 ? null : paren(body, open);
      if (cols === null || cols.inner.includes('${')) {
        found.link.push({ at, why: 'INSERT INTO stored_file without a readable column list' });
        continue;
      }
      const names = topLevel(cols.inner).map((c) => c.replace(/["`[\]]/g, '').toLowerCase());
      const idx = names.flatMap((n, k) => (LINK_COL.test(n) ? [k] : []));
      const rest = body.slice(cols.end);
      const conflict = /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\s+SET\b([\s\S]*)$/i.exec(rest);
      if (conflict !== null && (conflict[1].includes('${') || LINK_COL.test(conflict[1].replace(/["`[\]]/g, '')))) {
        found.link.push({ at, why: 'INSERT ... ON CONFLICT DO UPDATE SET entity_* (or a dynamic SET)' });
        continue;
      }
      if (idx.length === 0) continue;
      const values = /^\s*VALUES\s*/i.exec(rest);
      if (values === null) {
        found.link.push({ at, why: 'INSERT INTO stored_file ... SELECT naming entity_*' });
        continue;
      }
      const vals = paren(rest, values[0].length);
      if (vals === null || vals.inner.includes('${') || dynamicTail) {
        found.link.push({ at, why: 'INSERT INTO stored_file with a VALUES list the guard cannot read' });
        continue;
      }
      const v = topLevel(vals.inner);
      if (idx.some((k) => (v[k] ?? '').toUpperCase() !== 'NULL')) found.link.push({ at, why: 'INSERT INTO stored_file with a non-NULL link' });
    }
    // An ON CONFLICT DO UPDATE whose INSERT head sits in another literal, or a DO UPDATE on its own: fail closed when
    // it names the link columns.
    if (/\bDO\s+UPDATE\s+SET\b/i.test(lit) && !WRITE_HEAD.test(lit) && LINK_COL.test(lit)) {
      found.link.push({ at: sp.start, why: 'a DO UPDATE SET entity_* whose INSERT the guard cannot see' });
    }
    WRITE_HEAD.lastIndex = 0;
  }
  return { ...found, text };
}

/** Every writer, with why it is allowed. Enforced: it reaches `holdPlan`. Exempt: the reason the paper names. */
const LINK_WRITERS = {
  'core/files/files.ts#linkFile': 'enforced: holdPlan before the guard, applyHoldPlan first in run',
  'core/files/files.ts#newFileVersion': 'enforced: holdPlan (act version) for every target kind',
  'core/files/files.ts#repointFileLinks': 'exempt: a merged CONTACT only, asserted in the body (no caller today)',
  'core/banking/belegAssignment.ts#unfileFromLine': 'exempt: inside a person release through closeAssignment (release_beleg / replace)',
  'core/banking/belegHold.ts#applyHoldPlan': 'exempt: the release unfiling of a plan, after closeAssignment',
  'core/files/files.ts#updateFile': 'exempt: a DYNAMIC SET list (r4) of title, tags, folder_id and pending_delete only, asserted below',
};
const ASSIGNMENT_WRITERS = {
  'core/banking/belegAssignmentStore.ts#insertAssignment': 'the two writers (I-B)',
  'core/banking/belegAssignmentStore.ts#closeAssignment': 'the one state writer',
  'core/store/migrations.ts#migratePersonFiledReceipts': 'generation 19, the one-time I-G step',
  'core/banking/belegAssignmentSchema.ts#<module>': 'the schema trigger that mirrors a row\'s state onto its files (active 1 -> 0 only)',
};
/**
 * r4: every write into a DYNAMIC table name is named, with why it never writes a link or an assignment of its own
 * choosing. A new one fails the guard until it is named here.
 */
const DYNAMIC_TABLE_WRITERS = {
  'core/data/portability.ts#insertRows': 'the book copy (export/import, D23): every table restored as it was, an identical book, no new link',
  'core/data/portability.ts#loadTable': 'the book copy into a workspace (D23): the same rows, ids remapped, no new link',
  'core/data/portability.ts#remapCopiedWorkspaceIds': 'env_copy: re-maps WORKSPACE ids of copied rows to their copied workspace; never a file link nor an assignment cell (remapNeverWrites, asserted below and probed)',
  'core/sales/contactMerge.ts#mergeContacts': 'MERGE_REPOINT_FKS: contact foreign keys only (asserted below: no stored_file, no assignment table)',
  'core/agent/trace.ts#purgeAgentTraceForStrings': 'agent_call / agent_turn / agent_action text columns only (a redaction)',
  'core/landscape/secrets.ts#neutralizeSecrets': 'clears secret columns in a landscape copy (no link column)',
  'core/landscape/sanitize.ts#scaleMoney': 'money columns of a sanitized copy (no link column)',
  'core/landscape/sanitize.ts#applySanitization': 'PII and free-text columns of a sanitized copy (no link column)',
};

test('SQL WRITER GUARD, the classifier itself sees every construct (r4 blind spots)', () => {
  const cases = [
    ["db.prepare(`UPDATE stored_file SET entity_kind = ?, entity_id = ? WHERE id = ?`)", 'link'],
    ['db.prepare(\'UPDATE "stored_file" SET "entity_id" = ? WHERE id = ?\')', 'link'],
    ['db.prepare(`UPDATE [stored_file] SET entity_kind = NULL`)', 'link'],
    ['db.prepare(`UPDATE main.stored_file SET entity_id = ?`)', 'link'],
    ['db.prepare(`UPDATE OR IGNORE stored_file SET entity_id = ?`)', 'link'],
    ['db.prepare(`UPDATE stored_file SET ${sets.join(", ")} WHERE id = ?`)', 'link'],
    ["db.prepare('UPDATE stored_file SET ' + cols.join(', '))", 'link'],
    ['db.prepare(`INSERT INTO stored_file (id, entity_kind, entity_id) SELECT id, entity_kind, entity_id FROM other`)', 'link'],
    ['db.prepare(`INSERT INTO stored_file (id, title) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET entity_id = excluded.entity_id`)', 'link'],
    ['db.prepare(`INSERT OR REPLACE INTO stored_file (id, entity_kind, entity_id) VALUES (?, ?, ?)`)', 'link'],
    ['db.prepare(`REPLACE INTO "stored_file" (id, entity_kind) VALUES (?, ?)`)', 'link'],
    ['db.prepare(`INSERT INTO stored_file (${cols}) VALUES (${marks})`)', 'link'],
    ['db.prepare(`INSERT INTO stored_file VALUES (?, ?, ?)`)', 'link'],
    ['db.prepare(`INSERT INTO stored_file (id, entity_kind, entity_id) VALUES (?, NULL, NULL)`)', null],
    ['db.prepare(`UPDATE stored_file SET title = ? WHERE id = ?`)', null],
    ['// UPDATE stored_file SET entity_id = ? (prose in a comment)', null],
    ['const url = "https://x"; db.prepare(`UPDATE stored_file SET entity_id = ?`)', 'link'],
    ['db.prepare(`INSERT INTO "beleg_assignment" (id) VALUES (?)`)', 'assign'],
    ['db.prepare(`UPDATE beleg_assignment_file SET active = 0`)', 'assign'],
    ['db.prepare(`UPDATE ${table} SET ${col} = ?`)', 'dynamicTable'],
    ['db.prepare(`INSERT INTO "${t}" (a) VALUES (?)`)', 'dynamicTable'],
  ];
  for (const [src, kind] of cases) {
    const got = classifyWrites(src);
    const kinds = ['link', 'assign', 'dynamicTable'].filter((k) => got[k].length > 0);
    assert.deepEqual(kinds, kind === null ? [] : [kind], src);
  }
});

test('SQL WRITER GUARD: only the named statements write a file\'s link, and only the named ones write an assignment', () => {
  const links = new Set();
  const assigns = new Set();
  const dynamic = new Set();
  // r4: the whole tree, core/migration/ and core/landscape/ and the book copies included.
  for (const file of walk(ROOT)) {
    const rel = file.slice(ROOT.length + 1);
    const got = classifyWrites(readFileSync(file, 'utf8'));
    const site = (at) => `${rel}#${enclosing(got.text, at)}`;
    for (const f of got.link) links.add(site(f.at));
    for (const f of got.assign) assigns.add(site(f.at));
    for (const f of got.dynamicTable) dynamic.add(site(f.at));
  }
  assert.deepEqual([...links].sort(), Object.keys(LINK_WRITERS).sort(), 'a file-link writer the map does not name, or a named one gone');
  assert.deepEqual([...assigns].sort(), Object.keys(ASSIGNMENT_WRITERS).sort(), 'an assignment writer the map does not name, or a named one gone');
  assert.deepEqual([...dynamic].sort(), Object.keys(DYNAMIC_TABLE_WRITERS).sort(), 'a write into a dynamic table the map does not name, or a named one gone');
  const mergeFks = readFileSync(`${ROOT}/core/sales/contactMerge.ts`, 'utf8');
  const fkList = mergeFks.slice(mergeFks.indexOf('const MERGE_REPOINT_FKS'), mergeFks.indexOf('];', mergeFks.indexOf('const MERGE_REPOINT_FKS')));
  for (const t of GUARDED) assert.equal(new RegExp(`table: '${t}'`).test(fkList), false, `MERGE_REPOINT_FKS never names ${t}`);
  const files = readFileSync(`${ROOT}/core/files/files.ts`, 'utf8');
  const update = files.slice(files.indexOf('export function updateFile('), files.indexOf('\nexport function', files.indexOf('export function updateFile(') + 10));
  const pushed = [...update.matchAll(/sets\.push\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(pushed, ["'title = ?'", "'tags = ?'", "'folder_id = ?'", "'pending_delete = ?'"], 'updateFile sets only metadata, never entity_*');
  const repoint = files.slice(files.indexOf('export function repointFileLinks'), files.indexOf('UPDATE stored_file SET entity_id', files.indexOf('export function repointFileLinks')));
  assert.match(repoint, /if \(def\.kind !== 'contact'\) throw/, 'the contact assertion precedes the write');
  // A41.3 follow-ups (code critic LOW a): the workspace-id re-map checks REMAP_NEVER_WRITES before its one write.
  const port = readFileSync(`${ROOT}/core/data/portability.ts`, 'utf8');
  const remapBody = port.slice(port.indexOf('export function remapCopiedWorkspaceIds('), port.indexOf('\nexport function', port.indexOf('export function remapCopiedWorkspaceIds(') + 10));
  const check = remapBody.indexOf('if (remapNeverWrites(table, name))');
  assert.ok(check > 0 && check < remapBody.indexOf('db.prepare(`UPDATE'), 'remapCopiedWorkspaceIds asserts remapNeverWrites before its write');
  for (const [site, fn] of [['core/files/files.ts', 'linkFile'], ['core/files/files.ts', 'newFileVersion'], ['core/purchase/capture.ts', 'captureCommit'], ['core/banking/belegAssignment.ts', 'assignBelegFile']]) {
    const text = readFileSync(`${ROOT}/${site}`, 'utf8');
    const body = text.slice(text.indexOf(`export function ${fn}(`), text.indexOf('\nexport function', text.indexOf(`export function ${fn}(`) + 10));
    assert.match(body, /holdPlan\(ctx/, `${fn} decides the hold plan`);
    assert.match(body, /applyHoldPlan\(ctx/, `${fn} writes it`);
  }
  assert.doesNotMatch(readFileSync(`${ROOT}/core/files/receiptGuard.ts`, 'utf8'), /export function liveReceiptHolders/, 'the old holder read is gone');
});
