import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorkspace,
  setFiscalConfig,
  setVatMethod,
  setCreditorProfile,
  getCompanyProfile,
} from '../../dist/core/setup/index.js';
import { postEntry, saveDraft } from '../../dist/core/ledger/index.js';
import { setup, computeIban } from './support.mjs';

test('createWorkspace mints a workspace with CHF / 01-01 defaults', () => {
  const { store, deps } = setup();
  const res = createWorkspace(deps, { name: 'Acme GmbH' });
  assert.equal(res.ok, true);
  assert.ok(res.workspaceId);
  const row = store.db.prepare('SELECT * FROM workspace WHERE id = ?').get(res.workspaceId);
  assert.equal(row.name, 'Acme GmbH');
  assert.equal(row.base_currency, 'CHF');
  assert.equal(row.fiscal_year_start, '01-01');
});

test('createWorkspace is born with the KMU chart seeded', () => {
  const { store, deps } = setup();
  const ws = createWorkspace(deps, { name: 'Acme' }).workspaceId;
  const count = store.db.prepare('SELECT COUNT(*) AS c FROM account WHERE workspace_id = ?').get(ws).c;
  assert.ok(count >= 30, `expected the chart seeded on create, got ${count} accounts`);
});

test('createWorkspace rejects a blank name', () => {
  const { deps } = setup();
  assert.equal(createWorkspace(deps, { name: '   ' }).error, 'invalid_name');
  assert.equal(createWorkspace(deps, { name: '' }).error, 'invalid_name');
});

test('createWorkspace validates enums and the fiscal-year format', () => {
  const { deps } = setup();
  assert.equal(createWorkspace(deps, { name: 'X', legalForm: 'llc' }).error, 'invalid_legal_form');
  assert.equal(createWorkspace(deps, { name: 'X', baseCurrency: 'GBP' }).error, 'invalid_currency');
  assert.equal(createWorkspace(deps, { name: 'X', fiscalYearStart: '2026-01' }).error, 'invalid_fiscal_year_start');
  assert.equal(createWorkspace(deps, { name: 'X', legalForm: 'gmbh', baseCurrency: 'EUR', fiscalYearStart: '04-01' }).ok, true);
});

test('createWorkspace is idempotent on its key', () => {
  const { store, deps } = setup();
  const a = createWorkspace(deps, { name: 'X', idempotencyKey: 'k' });
  const b = createWorkspace(deps, { name: 'Y', idempotencyKey: 'k' });
  assert.deepEqual(b, a);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM workspace').get().c, 1);
});

test('setFiscalConfig refuses a currency or fiscal-year change once a posted entry exists', () => {
  const { store, deps, ctxFor } = setup();
  const ws = createWorkspace(deps, { name: 'X' }).workspaceId;
  const ctx = ctxFor(ws);
  assert.equal(setFiscalConfig(ctx, { fiscalYearStart: '04-01' }).ok, true);

  // createWorkspace already seeded the KMU chart; post against the seeded accounts.
  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [{ account: acc('6500'), debit: 100 }, { account: acc('1000'), credit: 100 }],
  });

  assert.equal(setFiscalConfig(ctx, { fiscalYearStart: '07-01' }).error, 'needs_empty_ledger');
  assert.equal(setFiscalConfig(ctx, { baseCurrency: 'EUR' }).error, 'needs_empty_ledger');
  // legal form is not currency/period-bearing, so it stays editable
  assert.equal(setFiscalConfig(ctx, { legalForm: 'ag' }).ok, true);
});

test('getCompanyProfile reports the SAME lock setFiscalConfig enforces (§H-FX)', () => {
  const { store, deps, ctxFor } = setup();
  const ws = createWorkspace(deps, { name: 'X' }).workspaceId;
  const ctx = ctxFor(ws);

  // An empty ledger: nothing is locked, and the engine agrees by accepting the write.
  assert.equal(getCompanyProfile(ctx).profile.ledgerLocked, false);
  assert.equal(setFiscalConfig(ctx, { baseCurrency: 'EUR' }).ok, true);

  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  postEntry(ctx, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [{ account: acc('6500'), debit: 100 }, { account: acc('1000'), credit: 100 }],
  });

  // One posted entry later the read reports the lock, and the write refuses. The read and the
  // write must never disagree: that is what made the Studio lock dead code.
  assert.equal(getCompanyProfile(ctx).profile.ledgerLocked, true);
  assert.equal(setFiscalConfig(ctx, { baseCurrency: 'CHF' }).error, 'needs_empty_ledger');
  assert.equal(setFiscalConfig(ctx, { fiscalYearStart: '07-01' }).error, 'needs_empty_ledger');
});

test('ledgerLocked is per workspace, never leaked across the tenant boundary (§H-TENANT)', () => {
  const { store, deps, ctxFor } = setup();
  const a = createWorkspace(deps, { name: 'A' }).workspaceId;
  const b = createWorkspace(deps, { name: 'B' }).workspaceId;
  const ctxA = ctxFor(a);
  const ctxB = ctxFor(b);
  const acc = (ws, n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  postEntry(ctxA, {
    date: '2026-03-01',
    description: 'x',
    source: 'manual',
    idempotencyKey: 'p',
    lines: [{ account: acc(a, '6500'), debit: 100 }, { account: acc(a, '1000'), credit: 100 }],
  });
  assert.equal(getCompanyProfile(ctxA).profile.ledgerLocked, true);
  assert.equal(getCompanyProfile(ctxB).profile.ledgerLocked, false);
  assert.equal(setFiscalConfig(ctxB, { baseCurrency: 'EUR' }).ok, true);
});

test('a DRAFT entry does not lock: only a posted one does', () => {
  const { store, deps, ctxFor } = setup();
  const ws = createWorkspace(deps, { name: 'X' }).workspaceId;
  const ctx = ctxFor(ws);
  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  // A real draft via the real verb: a posted entry cannot be demoted to one (the immutability
  // trigger refuses the UPDATE), which is exactly the guarantee that makes this the honest fixture.
  assert.equal(
    saveDraft(ctx, {
      date: '2026-03-01',
      description: 'draft',
      idempotencyKey: 'd',
      lines: [{ account: acc('6500'), debit: 100 }, { account: acc('1000'), credit: 100 }],
    }).ok,
    true,
  );
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM journal_entry WHERE status = 'draft'").get().c, 1);
  assert.equal(getCompanyProfile(ctx).profile.ledgerLocked, false);
  assert.equal(setFiscalConfig(ctx, { baseCurrency: 'EUR' }).ok, true);
});

test('setVatMethod persists method + timing and validates them', () => {
  const { deps, ctxFor } = setup();
  const ctx = ctxFor(createWorkspace(deps, { name: 'X' }).workspaceId);
  assert.equal(setVatMethod(ctx, { vatMethod: 'saldo', vatAccounting: 'soll' }).ok, true);
  assert.equal(getCompanyProfile(ctx).profile.vatMethod, 'saldo');
  assert.equal(getCompanyProfile(ctx).profile.vatAccounting, 'soll');
  assert.equal(setVatMethod(ctx, { vatMethod: 'bogus', vatAccounting: 'soll' }).error, 'invalid_vat_method');
  assert.equal(setVatMethod(ctx, { vatMethod: 'none', vatAccounting: 'nope' }).error, 'invalid_vat_accounting');
});

test('setCreditorProfile accepts a valid QR-IBAN with a structured address', () => {
  const { deps, ctxFor } = setup();
  const ctx = ctxFor(createWorkspace(deps, { name: 'X' }).workspaceId);
  const qrIban = computeIban('CH', '31999123000889012');
  const res = setCreditorProfile(ctx, {
    creditorName: 'Acme GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
    qrIban,
  });
  assert.equal(res.ok, true);
  const { profile } = getCompanyProfile(ctx);
  assert.equal(profile.creditorIban, qrIban);
  assert.equal(profile.creditorAddress.town, 'Zürich');
});

test('setCreditorProfile accepts a plain IBAN, and rejects an invalid one and an incomplete address', () => {
  const { deps, ctxFor } = setup();
  const ctx = ctxFor(createWorkspace(deps, { name: 'X' }).workspaceId);
  const address = { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' };
  // M-2: a plain IBAN is a legitimate creditor IBAN (it yields a SCOR reference), so it is STORED.
  // This assertion used to demand `not_a_qr_iban` here, which is what made the SCOR path unreachable.
  assert.equal(setCreditorProfile(ctx, { creditorName: 'Acme', address, qrIban: 'CH9300762011623852957' }).ok, true);
  assert.equal(getCompanyProfile(ctx).profile.creditorIban, 'CH9300762011623852957');
  // What is refused is an IBAN that is not an IBAN.
  assert.equal(setCreditorProfile(ctx, { creditorName: 'Acme', address, qrIban: 'CH00nonsense' }).error, 'invalid_iban');
  assert.equal(
    setCreditorProfile(ctx, { creditorName: 'Acme', address: { ...address, town: '' } }).error,
    'needs_structured_address',
  );
});
