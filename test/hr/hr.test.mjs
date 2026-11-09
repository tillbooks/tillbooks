// E02 behaviour: capability gating, AHV masking, self-scoping reads, the receipt threshold, the VAT
// trace, an FX line, absence overlap and validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  upsertEmployee,
  getEmployee,
  listEmployees,
  recordAbsence,
  listAbsences,
  createClaim,
  upsertLine,
  submitClaim,
  approveClaim,
  listClaims,
} from '../../dist/core/hr/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { setup, addEmployee, submittedClaim, capCtx } from './support.mjs';

// --- capability gating --------------------------------------------------------------------------

test('E02: hr_employee_upsert requires hr.manage', () => {
  const t = setup();
  const noRights = capCtx(t, 'nobody', []);
  const res = upsertEmployee(noRights, { employee: { firstName: 'A', lastName: 'B', employmentPct: 50, startsOn: '2026-01-01' }, idempotencyKey: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'permission_denied');
});

test('E02: writing ahv_nr needs hr.sensitive; hr.manage alone is refused; and it is masked on read', () => {
  const t = setup();
  const manageOnly = capCtx(t, 'mgr', ['hr.manage']);
  // hr.manage without hr.sensitive: writing the AHV number is refused, nothing written.
  const refused = upsertEmployee(manageOnly, { employee: { firstName: 'A', lastName: 'B', employmentPct: 50, startsOn: '2026-01-01', ahvNr: '756.1234.5678.90' }, idempotencyKey: 'a1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'forbidden');

  // With hr.sensitive it is stored; a read WITHOUT sensitivity masks it.
  const sensitive = capCtx(t, 'hr', ['hr.manage', 'hr.sensitive']);
  const made = upsertEmployee(sensitive, { employee: { firstName: 'A', lastName: 'B', employmentPct: 50, startsOn: '2026-01-01', ahvNr: '756.1234.5678.90' }, idempotencyKey: 'a2' });
  assert.equal(made.ok, true);
  assert.equal(made.employee.ahvNr, '756.1234.5678.90', 'the writer, holding sensitive, sees it');

  const masked = getEmployee(capCtx(t, 'reader', ['hr.read']), { employeeId: made.employeeId, includeSensitive: true });
  assert.equal(masked.ok, true);
  assert.equal(masked.employee.ahvNr, '756-...', 'a non-sensitive reader gets the mask');
  assert.equal(masked.employee.ahvRestricted, true);

  const revealed = getEmployee(capCtx(t, 'hr', ['hr.read', 'hr.sensitive']), { employeeId: made.employeeId, includeSensitive: true });
  assert.equal(revealed.employee.ahvNr, '756.1234.5678.90', 'a sensitive reader who asks sees it');
});

test('E02: claim writes require spesen.submit, approve/reject require spesen.approve', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const noRights = capCtx(t, 'nobody', ['hr.read']);
  assert.equal(createClaim(noRights, { employeeId, title: 'x', idempotencyKey: 'c' }).error, 'permission_denied');
  const submitter = capCtx(t, 'sub', ['spesen.submit']);
  const created = createClaim(submitter, { employeeId, title: 'x', idempotencyKey: 'c2' });
  assert.equal(created.ok, true);
  // approve needs spesen.approve (and post): a submitter cannot approve.
  const approve = approveClaim(submitter, { claimId: created.claimId, confirm: true, idempotencyKey: 'a' });
  assert.equal(approve.error, 'permission_denied');
});

// --- self-scoping reads -------------------------------------------------------------------------

test('E02: hr_absence_list self-scopes to the caller`s own linked employee without hr.manage', () => {
  const t = setup();
  const me = addEmployee(t.ctx, { actorRef: 'alice', name: 'Alice', idempotencyKey: 'me' }, 'me');
  const other = addEmployee(t.ctx, { actorRef: 'bob', name: 'Bob', idempotencyKey: 'ot' }, 'ot');
  assert.equal(recordAbsence(t.ctx, { employeeId: me.employeeId, kind: 'vacation', fromDate: '2026-07-01', toDate: '2026-07-03', idempotencyKey: 'ab-me' }).ok, true);
  assert.equal(recordAbsence(t.ctx, { employeeId: other.employeeId, kind: 'sick', fromDate: '2026-07-02', toDate: '2026-07-04', idempotencyKey: 'ab-ot' }).ok, true);

  // Alice, holding only hr.read, sees ONLY her own absence.
  const alice = capCtx(t, 'alice', ['hr.read']);
  const mine = listAbsences(alice, {});
  assert.equal(mine.ok, true);
  assert.equal(mine.selfScoped, true);
  assert.equal(mine.absences.length, 1);
  assert.equal(mine.absences[0].employeeId, me.employeeId);

  // Asking for Bob's id does not widen: still only her own (empty).
  const probing = listAbsences(alice, { employeeId: other.employeeId });
  assert.equal(probing.absences.length, 0);

  // An hr.manage holder sees both.
  const manager = capCtx(t, 'mgr', ['hr.read', 'hr.manage']);
  assert.equal(listAbsences(manager, {}).absences.length, 2);
});

test('E02: expense_claim_list self-scopes; spesen.approve opens the queue', () => {
  const t = setup();
  const mine = addEmployee(t.ctx, { actorRef: 'alice', name: 'Alice' }, 'me');
  submittedClaim(t.ctx, mine.employeeId, { claimant: 'alice' }, 'c-alice');
  const other = addEmployee(t.ctx, { actorRef: 'bob', name: 'Bob' }, 'ot');
  submittedClaim(t.ctx, other.employeeId, { claimant: 'bob' }, 'c-bob');

  const alice = capCtx(t, 'alice', ['hr.read']);
  const own = listClaims(alice, {});
  assert.equal(own.selfScoped, true);
  assert.equal(own.claims.length, 1, 'Alice sees only her own claim');

  const approver = capCtx(t, 'boss', ['hr.read', 'spesen.approve']);
  assert.equal(listClaims(approver, {}).claims.length, 2, 'the approver sees the whole queue');
});

// --- receipt threshold, VAT trace, FX, validation -----------------------------------------------

test('E02: a line over the receipt threshold blocks submit until a receipt is attached', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const created = createClaim(t.ctx, { employeeId, title: 'Gross', idempotencyKey: 'c' });
  const claimId = created.claimId;
  // CHF 60 (> CHF 50 threshold), no receipt.
  assert.equal(upsertLine(t.ctx, { claimId, line: { expenseDate: '2026-06-15', category: 'meals', amountMinor: 6000 }, idempotencyKey: 'l' }).ok, true);
  const blocked = submitClaim(t.ctx, { claimId, idempotencyKey: 's1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'receipt_required');
  assert.deepEqual(blocked.lineIds.length, 1);
});

test('E02: empty claim cannot be submitted; invalid category/kind/pct/dates are rejected', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const c = createClaim(t.ctx, { employeeId, title: 'x', idempotencyKey: 'c' });
  assert.equal(submitClaim(t.ctx, { claimId: c.claimId, idempotencyKey: 's' }).error, 'empty_claim');
  assert.equal(upsertLine(t.ctx, { claimId: c.claimId, line: { expenseDate: '2026-06-15', category: 'nope', amountMinor: 100 }, idempotencyKey: 'l' }).error, 'invalid_category');
  assert.equal(recordAbsence(t.ctx, { employeeId, kind: 'holiday', fromDate: '2026-07-01', toDate: '2026-07-02', idempotencyKey: 'ab' }).error, 'invalid_kind');
  assert.equal(upsertEmployee(t.ctx, { employee: { firstName: 'A', lastName: 'B', employmentPct: 0, startsOn: '2026-01-01' }, idempotencyKey: 'e1' }).error, 'invalid_pct');
  assert.equal(upsertEmployee(t.ctx, { employee: { firstName: 'A', lastName: 'B', employmentPct: 50, startsOn: '2026-05-01', endsOn: '2026-01-01' }, idempotencyKey: 'e2' }).error, 'invalid_dates');
});

test('E02: the per-line VAT trace is stored as values and the posting carries it', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  const created = createClaim(capCtx(t, 'claimant', ['spesen.submit']), { employeeId, title: 'VAT', idempotencyKey: 'c' });
  const claimId = created.claimId;
  // CHF 40 gross at the 8.1% input rate: net 3700, tax 300 (VST-M is the seeded input code).
  const line = upsertLine(capCtx(t, 'claimant', ['spesen.submit']), { claimId, line: { expenseDate: '2026-06-15', category: 'supplies', amountMinor: 4000, taxCode: 'VST-M' }, idempotencyKey: 'l' });
  assert.equal(line.ok, true, JSON.stringify(line));
  const stored = t.store.db.prepare('SELECT tax_code, tax_base_minor, tax_amount_minor, amount_base_minor FROM expense_line WHERE id = ?').get(line.lineId);
  assert.equal(stored.tax_code, 'VST-M');
  assert.equal(stored.tax_base_minor + stored.tax_amount_minor, stored.amount_base_minor, 'net + tax == gross');
  assert.ok(stored.tax_amount_minor > 0, 'input VAT was split off');

  submitClaim(capCtx(t, 'claimant', ['spesen.submit']), { claimId, idempotencyKey: 's' });
  const approved = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'a' });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  // 1170 Vorsteuer carries the tax.
  const vat = t.store.db.prepare("SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor),0) net FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.number = '1170'").get(approved.postedEntryId);
  assert.equal(vat.net, stored.tax_amount_minor, 'the posted Vorsteuer equals the stored trace');
});

test('E02: a foreign-currency line stores the txn amount, the base amount and the rate (§H-FX)', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  assert.equal(recordExchangeRate(t.ctx, { baseCurrency: 'EUR', rate: '0.95', asOf: '2026-06-15', idempotencyKey: 'r' }).ok, true);
  const created = createClaim(t.ctx, { employeeId, title: 'FX', idempotencyKey: 'c' });
  const line = upsertLine(t.ctx, { claimId: created.claimId, line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 2000, currency: 'EUR' }, idempotencyKey: 'l' });
  assert.equal(line.ok, true, JSON.stringify(line));
  const row = t.store.db.prepare('SELECT amount_minor, currency, amount_base_minor, fx_rate FROM expense_line WHERE id = ?').get(line.lineId);
  assert.equal(row.amount_minor, 2000);
  assert.equal(row.currency, 'EUR');
  assert.equal(row.fx_rate, '0.95');
  assert.equal(row.amount_base_minor, 1900, 'EUR 20.00 at 0.95 is CHF 19.00');
});

test('E02: an overlapping absence is ACCEPTED with overlap:true, never merged', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx);
  assert.equal(recordAbsence(t.ctx, { employeeId, kind: 'vacation', fromDate: '2026-07-01', toDate: '2026-07-10', idempotencyKey: 'a1' }).overlap, false);
  const second = recordAbsence(t.ctx, { employeeId, kind: 'sick', fromDate: '2026-07-05', toDate: '2026-07-06', idempotencyKey: 'a2' });
  assert.equal(second.ok, true);
  assert.equal(second.overlap, true, 'the overlap is reported');
  const count = t.store.db.prepare('SELECT COUNT(*) n FROM absence WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(count, 2, 'both rows exist, nothing merged');
});

test('E02: employee list masks AHV for non-sensitive readers', () => {
  const t = setup();
  const sensitive = capCtx(t, 'hr', ['hr.manage', 'hr.sensitive']);
  upsertEmployee(sensitive, { employee: { firstName: 'A', lastName: 'B', employmentPct: 100, startsOn: '2026-01-01', ahvNr: '756.9999.8888.77' }, idempotencyKey: 'e' });
  const list = listEmployees(capCtx(t, 'r', ['hr.read']), { includeSensitive: true });
  assert.equal(list.ok, true);
  assert.equal(list.employees[0].ahvNr, '756-...', 'masked in the list too');
});
