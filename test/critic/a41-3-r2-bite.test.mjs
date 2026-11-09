// Critic A41.3 r2 (non-author), probe group B: the r2 mutation run left N2 green (the QR trust checking only
// that the AMOUNT came from the QR, the r1 S1/S2 fix undone for QR receipts). This probe holds today and goes
// red under N2.
//
// SYNTHETIC BY CONSTRUCTION: invented amounts and dates; the QR bill is a hand-written SPC payload on the
// published sample IBAN the N04 support already uses.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO, TELCO_IBAN } from '../banking/n04-autobook-support.mjs';
import { assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const spc = (amount, message) =>
  [
    'SPC', '0200', '1', TELCO_IBAN,
    'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH',
    '', '', '', '', '', '', '',
    (amount / 100).toFixed(2), 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', message, 'EPD',
  ].join('\n');

test('B5 (N2 bite): an agent types a due date onto a person-brought QR receipt to move it into a later line\'s window; the QR trust is void and nothing books', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-b5' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-b5' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'critic', idempotencyKey: 'sc-b5' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const ap = autopilot(t);
  const qr = must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc(1595, 'Rechnung'), 'utf8').toString('base64'), mime: 'application/pdf', filename: 'b5.pdf', idempotencyKey: 'b5-in' }));
  at(t, '2026-09-10T08:00:00.000Z');
  const [later] = debits(t, [1595], { from: '2026-09-09' });
  ap.tick();
  assert.deepEqual(assignmentsOf(t, later), [], 'precondition: dated by its intake day, the receipt is out of the later line\'s window');
  must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: qr.captureId, source: 'agent', fields: [{ key: 'due_date', value: '2026-09-09', confidence: 'high' }], idempotencyKey: 'b5-x' }));
  ap.tick();
  assert.deepEqual(assignmentsOf(t, later), [], 'a typed date beside the QR figures is not the code\'s');
  assert.equal(decisionOf(t, later), undefined);
});
