/**
 * D178 E3, capability parity of what the new targets REVEAL (security review of 1de8bcd23).
 *
 * The preview of a Spesen target (`compose_entry` with a bank line and `target.kind 'expense_claims'`)
 * answers the claims: employee, title, amounts. The preview of a contact target answers the contact's name.
 * So each asks the read right of what it reveals, exactly as the verbs that read those records declare:
 * `hr.read` (`expense_claim_get`, `expense_claim_list`) and `read_master_data` (`get_contact`). The bank
 * picker's Spesen list is `expense_claim_list` itself, gated on `hr.read`. Held at BOTH halves: the A24
 * boundary (a role holding the books, the VAT and the bank inbox but not the personnel is refused, the
 * capability named) and the engine (`composeBankLine` asserts the same before it reads the line), so the
 * declaration and the verb cannot disagree. Synthetic data only.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { composeBankLine } from '../../dist/core/banking/bankBooking.js';
import { approveClaim } from '../../dist/core/hr/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { world, importLines, must, rowCounts, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { addEmployee, submittedClaim, capCtx } from '../hr/support.mjs';

afterEach(assertClaimInvariantHolds);

/** A workspace whose `agent` seat holds exactly `capabilities` (the declared-gate suite's shape). */
function seatHolding(capabilities, seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Rollen GmbH', `e3p-${seed}`);
  must(getAction('invite_member').run(deps, { workspaceId, email: `${seed}@muster.ch`, role: 'bookkeeper', idempotencyKey: `e3p-i-${seed}` }), 'invite');
  const role = must(getAction('define_role').run(deps, { workspaceId, name: 'Genau diese Rechte', capabilities, idempotencyKey: `e3p-d-${seed}` }), 'role');
  const seat = getAction('list_members').run(deps, { workspaceId }).members.find((m) => m.actorId === 'agent');
  must(getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role: role.roleId }), 'set_role');
  const owner = { ...deps, actor: 'studio' };
  return { deps: { ...deps, actor: 'agent' }, owner, workspaceId };
}

const BANK_READS = ['read_sales', 'read_books', 'read_vat'];
const spesenPreview = (workspaceId) => ({ workspaceId, mode: 'expand', bankTxnId: 'btx_unknown', target: { kind: 'expense_claims', claimIds: ['clm_unknown'] } });
const contactPreview = (workspaceId) => ({ workspaceId, mode: 'expand', bankTxnId: 'btx_unknown', target: { kind: 'contact', contactId: 'ct_unknown' } });

test('A24 declares it: the Spesen preview asks hr.read, the contact preview read_master_data, the others neither', () => {
  assert.deepEqual(requiredCapabilitiesFor('compose_entry', { bankTxnId: 'x', target: { kind: 'expense_claims' } }), [...BANK_READS, 'hr.read']);
  assert.deepEqual(requiredCapabilitiesFor('compose_entry', { bankTxnId: 'x', target: { kind: 'contact' } }), [...BANK_READS, 'read_master_data']);
  assert.deepEqual(requiredCapabilitiesFor('compose_entry', { bankTxnId: 'x', target: { kind: 'open_item' } }), BANK_READS);
  assert.deepEqual(requiredCapabilitiesFor('expense_claim_list', {}), ['hr.read']);
});

test('the boundary: a seat with the books, the VAT and the bank inbox but no hr.read is refused the Spesen preview and the picker list', () => {
  const seat = seatHolding(BANK_READS, 'nohr');
  const preview = getAction('compose_entry').run(seat.deps, spesenPreview(seat.workspaceId));
  assert.deepEqual([preview.error, preview.capability], ['permission_denied', 'hr.read']);
  const listed = getAction('expense_claim_list').run(seat.deps, { workspaceId: seat.workspaceId, status: 'approved' });
  assert.deepEqual([listed.error, listed.capability], ['permission_denied', 'hr.read']);
  const contact = getAction('compose_entry').run(seat.deps, contactPreview(seat.workspaceId));
  assert.deepEqual([contact.error, contact.capability], ['permission_denied', 'read_master_data']);
  // The other bank previews stay on the bank inbox's read right.
  const other = getAction('compose_entry').run(seat.deps, { workspaceId: seat.workspaceId, mode: 'expand', bankTxnId: 'btx_unknown', target: { kind: 'open_item', documentId: 'doc_unknown' } });
  assert.equal(other.error, 'not_found', 'past the gate, the read runs and finds no such line');
});

test('the boundary: with hr.read (and read_master_data) the previews run, and the picker list names the claimant', () => {
  const seat = seatHolding([...BANK_READS, 'hr.read', 'spesen.approve', 'read_master_data'], 'withhr');
  assert.equal(getAction('compose_entry').run(seat.deps, spesenPreview(seat.workspaceId)).error, 'not_found');
  assert.equal(getAction('compose_entry').run(seat.deps, contactPreview(seat.workspaceId)).error, 'not_found');
  // A submitted claim, drafted by the owner seat: the approver's list names its claimant.
  const emp = must(getAction('hr_employee_upsert').run(seat.owner, { workspaceId: seat.workspaceId, employee: { firstName: 'Anna', lastName: 'Beispiel', employmentPct: 80, startsOn: '2026-01-01' }, idempotencyKey: 'e3p-emp' }), 'employee');
  const claim = must(getAction('expense_claim_create').run(seat.owner, { workspaceId: seat.workspaceId, employeeId: emp.employeeId, title: 'Zugreise Bern', idempotencyKey: 'e3p-c' }), 'claim');
  must(getAction('expense_line_upsert').run(seat.owner, { workspaceId: seat.workspaceId, claimId: claim.claimId, line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000 }, idempotencyKey: 'e3p-l' }), 'line');
  must(getAction('expense_claim_submit').run(seat.owner, { workspaceId: seat.workspaceId, claimId: claim.claimId, idempotencyKey: 'e3p-s' }), 'submit');
  const listed = must(getAction('expense_claim_list').run(seat.deps, { workspaceId: seat.workspaceId, status: 'submitted' }), 'list');
  assert.deepEqual(listed.claims.map((c) => [c.title, c.employeeName]), [['Zugreise Bern', 'Anna Beispiel']]);
});

test('the engine half: composeBankLine asserts the same rights before it reads anything, and with them answers the claims', () => {
  const t = world();
  const { employeeId } = addEmployee(t.ctx, { firstName: 'Anna', lastName: 'Beispiel' }, 'emp-perm');
  const c = submittedClaim(t.ctx, employeeId, { amountMinor: 4000, title: 'Zugreise Bern' }, 'pc');
  must(approveClaim(t.ctx, { claimId: c.claimId, confirm: true, idempotencyKey: 'pa' }), 'approve');
  const line = importLines(t, { statementId: 'e3perm', entries: [{ ref: 'SP', amountMinor: 4000, cd: 'DBIT', name: 'Anna Beispiel' }] }).lines['SP'];
  const counts = rowCounts(t.store, t.workspaceId);
  const reader = capCtx(t, 'reader', BANK_READS);
  const denied = composeBankLine(reader, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: [c.claimId] } });
  assert.deepEqual([denied.error, denied.capability], ['permission_denied', 'hr.read']);
  assert.equal(denied.booking, undefined, 'no claim field leaves a refused read');
  const contactDenied = composeBankLine(reader, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId } });
  assert.deepEqual([contactDenied.error, contactDenied.capability], ['permission_denied', 'read_master_data']);
  const hr = capCtx(t, 'hr-reader', [...BANK_READS, 'hr.read']);
  const shown = must(composeBankLine(hr, { bankTxnId: line, target: { kind: 'expense_claims', claimIds: [c.claimId] } }), 'with hr.read');
  assert.deepEqual(shown.booking.claims.map((x) => [x.claimId, x.title, x.totalMinor]), [[c.claimId, 'Zugreise Bern', 4000]]);
  assert.equal(shown.booking.bookable, false, 'reading is not booking: the dry run is refused without spesen.approve and pay');
  assert.equal(shown.booking.blockedBy, 'permission_denied');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), counts, 'no read wrote a row');
});
