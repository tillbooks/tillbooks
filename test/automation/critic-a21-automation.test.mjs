// The A21 critic's F1/F2 probes (31.07.2026), ADOPTED and INVERTED after D77.
//
// The critic demonstrated, on rows, that a stored G01 rule could write `confirmed: true` into its
// template once and (F1) settle a medium-confidence match with the auto-apply dial OFF, or (F2)
// reverse a human's settlement and repoint the money onto another debtor, both triggered by A21's
// own events. D77 answered: `apply_qr_match` and `override_qr_match` join the denylist (the
// who-may-act logic: their `confirmed` gates a JUDGMENT about whose money arrived, not a dispatch;
// D70's send verbs keep rule-supplied confirmation because a send dispatches an artefact the
// invariants bound). These are the same worlds the critic built, now asserting refusal at SAVE
// time AND at FIRE time, with the rows unchanged.
//
// The fire-time half stores the rule the way `denylist-fire-time.test.mjs` does: saved through the
// public verb naming a legal action, then re-aimed by SQL, which is exactly the shape a pre-D77
// row in a real database has. Without that half, the save-time refusal would be the only
// enforcement and a legacy row would still fire.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/rules.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};

/** A workspace with VAT, a customer, an issued CHF 1'081.00 invoice and a registered Bankkonto. */
function qrWorld(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Abgleich AG', `${seed}-ws`);
  ok(call(deps, 'vat_configure', {
    workspaceId, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: `${seed}-vat`,
  }), 'vat_configure');
  const contact = ok(call(deps, 'create_contact', {
    workspaceId, partyRole: 'customer', name: 'Muster AG', idempotencyKey: `${seed}-c`,
  }), 'create_contact');
  const created = ok(call(deps, 'create_document', {
    workspaceId, type: 'invoice', contactId: contact.contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${seed}-doc`,
  }), 'create_document');
  const issued = ok(call(deps, 'transition_document', {
    workspaceId, documentId: created.document.id, to: 'issued', idempotencyKey: `${seed}-iss`,
  }), 'transition_document');
  const bank = ok(call(deps, 'create_bank_account', {
    workspaceId, name: 'PostFinance', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF',
    ledgerAccountId: accId('1020'), idempotencyKey: `${seed}-bank`,
  }), 'create_bank_account');
  return {
    deps, workspaceId, accId,
    invoiceId: issued.document.id,
    reference: buildQrrReference(issued.document.number),
    bankAccountId: bank.bankAccountId,
  };
}

const paymentsOf = (w) =>
  w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?')
    .get(w.workspaceId).n;

const runRows = (w) =>
  w.deps.store.db
    .prepare(
      `SELECT rule_id, status, error_code, action_tool FROM automation_run
        WHERE workspace_id = ? ORDER BY started_at, id`,
    )
    .all(w.workspaceId);

/** A rule saved through the public verb, then aimed at a denied verb the way a pre-D77 row would be. */
function storeLegacyRule(w, { event, tool, template }) {
  const created = ok(
    call(w.deps, 'create_automation_rule', {
      workspaceId: w.workspaceId,
      name: 'aus der Zeit vor D77',
      trigger: { event },
      action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } },
      idempotencyKey: `legacy-${tool}`,
    }),
    'create_automation_rule',
  );
  w.deps.store.db
    .prepare('UPDATE automation_rule SET action_tool = ?, action_input = ? WHERE workspace_id = ? AND id = ?')
    .run(tool, JSON.stringify(template), w.workspaceId, created.rule.ruleId);
  return created.rule.ruleId;
}

test('F1 adopted: apply_qr_match is refused at SAVE time, per D77', () => {
  const w = qrWorld('f1s');
  assert.ok(NOT_AUTOMATABLE.has('apply_qr_match'), 'D77 puts apply_qr_match on the denylist');
  const refused = call(w.deps, 'create_automation_rule', {
    workspaceId: w.workspaceId,
    name: 'Auto-Abgleich',
    trigger: { event: 'qr_match.needs_review' },
    action: {
      tool: 'apply_qr_match',
      inputTemplate: {
        creditId: '{{result.credit.creditId}}',
        invoiceId: '{{result.credit.score.invoiceId}}',
        mode: 'full',
        confirmed: true,
      },
    },
    idempotencyKey: 'f1s-rule',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'action_not_automatable');
});

test('F1 adopted: a pre-D77 stored rule with confirmed:true is refused at FIRE time, rows unchanged', () => {
  const w = qrWorld('f1f');
  const ruleId = storeLegacyRule(w, {
    event: 'qr_match.needs_review',
    tool: 'apply_qr_match',
    template: {
      creditId: '{{result.credit.creditId}}',
      invoiceId: '{{result.credit.score.invoiceId}}',
      mode: 'full',
      confirmed: true,
    },
  });

  const before = paymentsOf(w);
  // The critic's exact trigger: a credit CHF 500.00 SHORT, medium/amount_short, the case the spec
  // says waits for a human on the Review lane. The recording succeeds; the rule must not.
  const recorded = ok(call(w.deps, 'record_incoming_credit', {
    workspaceId: w.workspaceId,
    bankAccountId: w.bankAccountId,
    amountMinor: 58100,
    valueDate: '2026-03-01',
    reference: w.reference,
    idempotencyKey: 'f1f-credit',
  }), 'record_incoming_credit');
  assert.equal(recorded.credit.score.confidence, 'medium');

  const runs = runRows(w);
  assert.equal(runs.length, 1, `exactly one firing was expected: ${JSON.stringify(runs)}`);
  assert.equal(runs[0].rule_id, ruleId);
  assert.equal(runs[0].action_tool, 'apply_qr_match');
  assert.equal(runs[0].status, 'failed', `the fire path executed a denied verb: ${JSON.stringify(runs)}`);
  assert.equal(runs[0].error_code, 'action_not_automatable');

  // The rows the critic measured, now unchanged: no payment, the row still open, nothing on 3805.
  assert.equal(paymentsOf(w), before, 'an unattended payment was posted');
  const queue = ok(call(w.deps, 'list_unmatched_incoming', { workspaceId: w.workspaceId }));
  const row = queue.items.find((i) => i.creditId === recorded.credit.creditId);
  assert.equal(row.status, 'open', 'the review row was decided by a stored rule');
  const writeOff = w.deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor), 0) AS n FROM journal_line l
         JOIN account a ON a.id = l.account_id
        WHERE a.workspace_id = ? AND a.number = '3805'`,
    )
    .get(w.workspaceId).n;
  assert.equal(writeOff, 0, 'a write-off was booked unattended');
});

test('F2 adopted: override_qr_match is refused at SAVE and FIRE time, and the settlement survives', () => {
  const w = qrWorld('f2');
  assert.ok(NOT_AUTOMATABLE.has('override_qr_match'), 'D77 puts override_qr_match on the denylist');

  // Save time.
  const refused = call(w.deps, 'create_automation_rule', {
    workspaceId: w.workspaceId,
    name: 'Auto-Umbuchung',
    trigger: { event: 'qr_match.applied' },
    action: { tool: 'override_qr_match', inputTemplate: { creditId: 'x', invoiceId: 'y', confirmed: true } },
    idempotencyKey: 'f2-rule',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'action_not_automatable');

  // Fire time: the critic's world verbatim, a second debtor's invoice as the redirect target.
  const other = ok(call(w.deps, 'create_contact', {
    workspaceId: w.workspaceId, partyRole: 'customer', name: 'Andere AG', idempotencyKey: 'f2-c2',
  }));
  const otherDoc = ok(call(w.deps, 'create_document', {
    workspaceId: w.workspaceId, type: 'invoice', contactId: other.contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'f2-doc2',
  }));
  const otherInvoice = ok(call(w.deps, 'transition_document', {
    workspaceId: w.workspaceId, documentId: otherDoc.document.id, to: 'issued', idempotencyKey: 'f2-iss2',
  })).document.id;
  const ruleId = storeLegacyRule(w, {
    event: 'qr_match.applied',
    tool: 'override_qr_match',
    template: { creditId: '{{input.creditId}}', invoiceId: otherInvoice, confirmed: true },
  });

  const recorded = ok(call(w.deps, 'record_incoming_credit', {
    workspaceId: w.workspaceId,
    bankAccountId: w.bankAccountId,
    amountMinor: 108100,
    valueDate: '2026-03-01',
    reference: w.reference,
    idempotencyKey: 'f2-credit',
  }), 'record_incoming_credit');

  // A human settles the credit against the invoice its own QRR names. That is the whole human act.
  ok(call(w.deps, 'apply_qr_match', {
    workspaceId: w.workspaceId,
    creditId: recorded.credit.creditId,
    invoiceId: w.invoiceId,
    mode: 'partial',
    confirmed: true,
    idempotencyKey: 'f2-apply',
  }), 'apply_qr_match');

  const runs = runRows(w).filter((r) => r.action_tool === 'override_qr_match');
  assert.equal(runs.length, 1, 'the qr_match.applied firing was expected');
  assert.equal(runs[0].rule_id, ruleId);
  assert.equal(runs[0].status, 'failed', `a stored rule redirected a settlement: ${JSON.stringify(runs)}`);
  assert.equal(runs[0].error_code, 'action_not_automatable');

  // The rows the critic measured, now unchanged: the human's settlement stands, nothing reversed.
  const queue = ok(call(w.deps, 'list_unmatched_incoming', { workspaceId: w.workspaceId }));
  const row = queue.items.find((i) => i.creditId === recorded.credit.creditId);
  assert.equal(row.status, 'applied');
  assert.equal(row.invoiceId, w.invoiceId, 'the credit was redirected off the invoice its QRR names');
  assert.deepEqual(row.reversedPaymentIds, [], 'a reversing payment was written unattended');
});

test('F1/F2 control, kept from the critic: set_qr_auto_apply is refused at save time too', () => {
  const w = qrWorld('f3');
  const refused = call(w.deps, 'create_automation_rule', {
    workspaceId: w.workspaceId,
    name: 'Dial an',
    trigger: { event: 'qr_match.needs_review' },
    action: { tool: 'set_qr_auto_apply', inputTemplate: { autoApply: true } },
    idempotencyKey: 'f3-rule',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'action_not_automatable');
});
