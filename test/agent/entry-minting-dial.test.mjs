/**
 * The dial governs every verb that mints a journal entry (governance check, 28.09.2026).
 *
 * `dialMap.ts` states the rule in its own words: every verb that mints an entry, an original posting
 * or a reversing one, belongs under the `post` dial capability (or under the family whose act it is:
 * `issue` for the document freeze, `go-live` for the cutover). Three verbs broke it and were reached by
 * an agent seat at the default `ask` with NO Vorschlag:
 *
 *  - `void_vendor_bill` reverses a posted bill's purchase entry through `reverseEntry`;
 *  - `record_expense` posts a vendor bill straight to the ledger (the one-step twin of the governed
 *    `post_vendor_bill`);
 *  - `transition_document` with `to: 'issued'` runs the SAME poster the governed `issue_invoice`
 *    runs (issue_invoice is a wrapper over it), and with `to: 'cancelled'` reverses the posted entry,
 *    so the governed verb was bypassable by naming its engine.
 *
 * Driven through the REAL transport dispatch (`callTool`), never `action.run`, because the seam IS the
 * thing under test. HOW IT BITES: delete `void_vendor_bill` from `DIAL_CAPABILITY_FOR_ACTION` and the
 * first test's call executes (`drafted` undefined, the bill reads `void`, a reversal sits in the
 * journal); delete the `transition_document` input rule and the invoice issues with a number and an
 * entry on the agent's say-so. The structural twin (`dial-covers-entry-minting.test.mjs`) is what
 * catches the NEXT such verb before anyone writes a test like this one for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { dialCapabilityForCall } from '../../dist/core/agent/index.js';
import { RECURRING_GOVERNED_PATCH_KEYS } from '../../dist/core/agent/dialMap.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function mcp(deps, name, args) {
  return JSON.parse(callTool(deps, name, args).content[0].text);
}

/** The human decider (studio) acts through the registry directly: no session, no dial. */
function human(deps, name, input) {
  const res = getAction(name).run({ ...deps, actor: 'studio' }, input);
  return res;
}

function vatReady(deps, workspaceId) {
  assert.equal(human(deps, 'vat_seed_defaults', { workspaceId }).ok, true);
  assert.equal(human(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
}

function billInput(deps, workspaceId, accId, seed) {
  vatReady(deps, workspaceId);
  const vendor = human(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${seed}-vendor` });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  return {
    workspaceId,
    vendorId: vendor.contact.id,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    vendorReference: `LG-${seed}-0042`,
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    idempotencyKey: `${seed}-bill`,
  };
}

function draftInvoice(deps, workspaceId, seed) {
  vatReady(deps, workspaceId);
  const c = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Kunde AG', idempotencyKey: `${seed}-c` });
  assert.equal(c.ok, true, JSON.stringify(c));
  const doc = human(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId: c.contact.id,
    currency: 'CHF',
    dueDate: '2026-08-31',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${seed}-doc`,
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  return doc.document.id;
}

const entryCount = (deps, workspaceId) =>
  deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;

const docRow = (deps, workspaceId, id) =>
  deps.store.db.prepare('SELECT status, number, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?').get(workspaceId, id);

test('the three verbs resolve to a dial capability, and each carries its consequence sentence', () => {
  assert.equal(dialCapabilityForCall('void_vendor_bill', { vendorBillId: 'vb_1' }), 'post');
  assert.equal(dialCapabilityForCall('record_expense', { vendorId: 'c_1' }), 'post');
  assert.equal(dialCapabilityForCall('transition_document', { documentId: 'd_1', to: 'issued' }), 'issue');
  assert.equal(dialCapabilityForCall('transition_document', { documentId: 'd_1', to: 'cancelled' }), 'post');
  // Critic B1 (claude/rmap-land): a quote's accepted edge is quotes_accept, governed under issue (D161).
  assert.equal(dialCapabilityForCall('transition_document', { documentId: 'd_1', to: 'accepted' }), 'issue');
  // The other non-posting edges stay ungoverned: a sent, declined or confirmed document mints nothing.
  for (const to of ['sent', 'declined', 'confirmed']) {
    assert.equal(dialCapabilityForCall('transition_document', { documentId: 'd_1', to }), undefined, to);
  }
  for (const name of ['void_vendor_bill', 'record_expense', 'transition_document']) {
    assert.equal(typeof getAction(name).consequence, 'string', `${name}: states its consequence`);
    assert.ok(getAction(name).consequence.length > 20);
  }
});

test('an agent void_vendor_bill at ask DRAFTS: the bill stays posted, no reversal; approval voids it once', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const posted = human(deps, 'record_expense', billInput(deps, workspaceId, accId, 'vvb'));
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const before = entryCount(deps, workspaceId);

  const voided = mcp(deps, 'void_vendor_bill', { workspaceId, vendorBillId: posted.vendorBillId, reason: 'Doppelt', idempotencyKey: 'agent-void' });
  assert.equal(voided.ok, true, JSON.stringify(voided));
  assert.equal(voided.drafted, true, 'void_vendor_bill is governed: it drafts at ask, never executes');
  assert.equal(voided.dialCapability, 'post');
  const bill = deps.store.db.prepare('SELECT status, reversal_entry_id FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(workspaceId, posted.vendorBillId);
  assert.deepEqual({ ...bill }, { status: 'posted', reversal_entry_id: null }, 'the agent alone reversed nothing');
  assert.equal(entryCount(deps, workspaceId), before, 'no reversing entry was minted');

  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: voided.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const after = deps.store.db.prepare('SELECT status FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(workspaceId, posted.vendorBillId);
  assert.equal(after.status, 'void', 'the approved void lands');
  assert.equal(entryCount(deps, workspaceId), before + 1, 'exactly one reversal');
  deps.store.close();
});

test('an agent record_expense at ask DRAFTS: no bill, no entry', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const input = billInput(deps, workspaceId, accId, 're');
  const before = entryCount(deps, workspaceId);
  const res = mcp(deps, 'record_expense', input);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, true, 'record_expense posts to the ledger: it drafts at ask');
  assert.equal(res.dialCapability, 'post');
  assert.equal(entryCount(deps, workspaceId), before);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(workspaceId).n, 0);
  deps.store.close();
});

test('an agent transition_document to issued DRAFTS under issue: no number, no entry (issue_invoice is not bypassable)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const invoiceId = draftInvoice(deps, workspaceId, 'td-i');
  const before = entryCount(deps, workspaceId);

  const res = mcp(deps, 'transition_document', { workspaceId, documentId: invoiceId, to: 'issued', idempotencyKey: 'agent-issue' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, true, 'issuing through the engine verb drafts exactly like issue_invoice');
  assert.equal(res.dialCapability, 'issue');
  assert.deepEqual({ ...docRow(deps, workspaceId, invoiceId) }, { status: 'draft', number: null, posted_entry_id: null });
  assert.equal(entryCount(deps, workspaceId), before);
  deps.store.close();
});

test('an agent transition_document to cancelled on an issued invoice DRAFTS under post: the entry stands', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const invoiceId = draftInvoice(deps, workspaceId, 'td-c');
  const issued = human(deps, 'issue_invoice', { workspaceId, invoiceId, idempotencyKey: 'h-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const before = entryCount(deps, workspaceId);

  const res = mcp(deps, 'transition_document', { workspaceId, documentId: invoiceId, to: 'cancelled', idempotencyKey: 'agent-cancel' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, true, 'cancelling a posted invoice mints its reversal: it drafts at ask');
  assert.equal(res.dialCapability, 'post');
  assert.equal(docRow(deps, workspaceId, invoiceId).status, 'issued');
  assert.equal(entryCount(deps, workspaceId), before, 'no reversal was minted');
  deps.store.close();
});

test('the human path is untouched: studio void_vendor_bill executes at once and opens no session', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const posted = human(deps, 'record_expense', billInput(deps, workspaceId, accId, 'hv'));
  const res = mcp({ ...deps, actor: 'studio' }, 'void_vendor_bill', { workspaceId, vendorBillId: posted.vendorBillId, idempotencyKey: 'studio-void' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.drafted, true);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ?').get(workspaceId).n, 0);
  deps.store.close();
});

// --- A12: the auto-issuing schedule (measured 28.09.2026: an agent created one with autoIssue and ran
// the tick, and two numbered invoices posted with no Vorschlag, because the tick invokes issue_invoice
// internally as the schedule author, outside the seam). HOW IT BITES: delete the two recurring rules
// from INPUT_KEYED_DIAL_RULES and the first test finds issued invoices after the tick.

function recurringInput(deps, workspaceId, seed, extra = {}) {
  vatReady(deps, workspaceId);
  const c = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Abo AG', idempotencyKey: `${seed}-c` });
  return {
    workspaceId,
    contactId: c.contact.id,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-06-01',
    idempotencyKey: `${seed}-s`,
    ...extra,
  };
}

const issuedInvoices = (deps, workspaceId) =>
  deps.store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'invoice' AND status <> 'draft'").get(workspaceId).n;

test('an agent create_recurring_schedule with autoIssue DRAFTS under issue; the tick then issues nothing', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const res = mcp(deps, 'create_recurring_schedule', recurringInput(deps, workspaceId, 'ai', { autoIssue: true }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.drafted, true, 'an auto-issuing schedule is governed where it is authored');
  assert.equal(res.dialCapability, 'issue');
  // D161: the agent's own tick is a Vorschlag under issue, so the tick that would issue is the person's
  // (or the scheduler's); it finds no schedule, because the agent's was only proposed.
  const proposed = mcp(deps, 'run_due_recurring', { workspaceId });
  assert.equal(proposed.drafted, true, JSON.stringify(proposed));
  const tick = human(deps, 'run_due_recurring', { workspaceId });
  assert.equal(tick.ok, true, JSON.stringify(tick));
  assert.equal(issuedInvoices(deps, workspaceId), 0, 'no invoice was issued on the agent\'s say-so');
  assert.equal(entryCount(deps, workspaceId), 0);
  deps.store.close();
});

test('a draft-only schedule stays free for the agent: it executes, and its tick makes review drafts that mint nothing', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const res = mcp(deps, 'create_recurring_schedule', recurringInput(deps, workspaceId, 'do'));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.drafted, true, 'no autoIssue: nothing the tick does mints an entry');
  // D161: the tick runs at the person's (or the scheduler's) door; the agent's own tick is a Vorschlag.
  const tick = human(deps, 'run_due_recurring', { workspaceId });
  assert.equal(tick.ok, true, JSON.stringify(tick));
  const reviewDrafts = deps.store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'invoice' AND status = 'draft'").get(workspaceId).n;
  assert.ok(reviewDrafts > 0, 'the tick made review drafts');
  assert.equal(issuedInvoices(deps, workspaceId), 0);
  assert.equal(entryCount(deps, workspaceId), 0, 'review drafts only');
  deps.store.close();
});

test('an agent update_recurring_schedule that turns autoIssue on, retargets the template or retimes the cadence DRAFTS; a payment-terms patch does not', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const created = human(deps, 'create_recurring_schedule', recurringInput(deps, workspaceId, 'up'));
  assert.equal(created.ok, true, JSON.stringify(created));
  const scheduleId = created.scheduleId ?? created.schedule?.id;
  assert.equal(typeof scheduleId, 'string', JSON.stringify(created));

  const on = mcp(deps, 'update_recurring_schedule', { workspaceId, scheduleId, patch: { autoIssue: true } });
  assert.equal(on.drafted, true, JSON.stringify(on));
  assert.equal(on.dialCapability, 'issue');
  const other = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Andere AG', idempotencyKey: 'up-o' });
  const retarget = mcp(deps, 'update_recurring_schedule', { workspaceId, scheduleId, patch: { contactId: other.contact.id } });
  assert.equal(retarget.drafted, true, JSON.stringify(retarget));
  // The cadence decides WHEN an auto-issuing schedule issues (non-author critic F3, owner decision
  // 28.09.2026): retiming to one invoice a day from today drafts too.
  for (const patch of [{ interval: 'custom', customDays: 1 }, { anchorDate: '2026-07-16' }, { endDate: '2027-12-31' }, { maxOccurrences: 99 }]) {
    const retimed = mcp(deps, 'update_recurring_schedule', { workspaceId, scheduleId, patch });
    assert.equal(retimed.drafted, true, `${JSON.stringify(patch)}: ${JSON.stringify(retimed)}`);
  }
  const terms = mcp(deps, 'update_recurring_schedule', { workspaceId, scheduleId, patch: { dueDays: 45 } });
  assert.equal(terms.ok, true, JSON.stringify(terms));
  assert.notEqual(terms.drafted, true, 'payment terms decide nothing about which invoices are issued, or when');
  deps.store.close();
});

test('R2-5: every governed recurring patch key drafts ON ITS OWN, and the list is the one D141 names', () => {
  // Pinned as a set, so dropping a key (the critic removed lines, currency and customDays and 217 tests
  // stayed green) fails here, and each key is exercised alone through the rule.
  assert.deepEqual(
    [...RECURRING_GOVERNED_PATCH_KEYS].sort(),
    ['anchorDate', 'contactId', 'currency', 'customDays', 'endDate', 'interval', 'lines', 'maxOccurrences', 'templateDocumentId'],
  );
  for (const key of RECURRING_GOVERNED_PATCH_KEYS) {
    assert.equal(dialCapabilityForCall('update_recurring_schedule', { scheduleId: 's_1', patch: { [key]: null } }), 'issue', key);
  }
  for (const key of ['dueDays', 'name', 'notes']) {
    assert.equal(dialCapabilityForCall('update_recurring_schedule', { scheduleId: 's_1', patch: { [key]: 'x' } }), undefined, key);
  }
  assert.equal(dialCapabilityForCall('update_recurring_schedule', { scheduleId: 's_1', patch: { autoIssue: true } }), 'issue');
  assert.equal(dialCapabilityForCall('update_recurring_schedule', { scheduleId: 's_1', patch: { autoIssue: false } }), undefined);
});
