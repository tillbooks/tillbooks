// A00 remainder: bootstrapWorkspace (parse -> create + configure, idempotent, never fabricate),
// updateCompanyProfile (uid / mwst_no shape), and createWorkspace's A03 audit-log genesis stamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import {
  createWorkspace,
  bootstrapWorkspace,
  parseBootstrapDescription,
  updateCompanyProfile,
  getCompanyProfile,
} from '../../dist/core/setup/index.js';
import { getAuditLog, ledgerPorts } from '../../dist/core/ledger/index.js';
import { getVatConfig } from '../../dist/core/vat/index.js';

const AT = '2026-07-16T00:00:00.000Z';
function deps() {
  return { store: new SqliteStore({ clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen() };
}

test('createWorkspace stamps a workspace-create genesis row in the A03 audit chain', () => {
  const d = deps();
  const created = createWorkspace(d, { name: 'Acme GmbH' });
  const ctx = makeContext(d.store, { workspaceId: created.workspaceId, clock: d.clock, ids: d.ids, ...ledgerPorts({ store: d.store, workspaceId: created.workspaceId, ids: d.ids }) });
  const log = getAuditLog(ctx, {});
  assert.equal(log.ok, true);
  assert.equal(log.chainVerified, true);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].action, 'create');
  assert.equal(log.rows[0].entityKind, 'workspace');
  assert.equal(log.rows[0].entityId, created.workspaceId);
});

test('bootstrapWorkspace parses a description and configures VAT, reporting applied + needs', () => {
  const d = deps();
  const res = bootstrapWorkspace(d, {
    description: "Muster GmbH, VAT-registered CHE-123.456.789 MWST, effective method, accrual",
    idempotencyKey: 'b1',
  });
  assert.equal(res.ok, true);
  assert.ok(res.workspaceId);
  assert.ok(res.applied.includes('legalForm'));
  assert.ok(res.applied.includes('vatMethod'));
  assert.ok(res.applied.includes('mwstNo'));

  const ctx = makeContext(d.store, { workspaceId: res.workspaceId, clock: d.clock, ids: d.ids });
  const cfg = getVatConfig(ctx).config;
  assert.equal(cfg.method, 'effektiv');
  assert.equal(cfg.timing, 'soll', 'accrual maps to soll');
  assert.equal(cfg.registered, true);
  assert.equal(cfg.vatNumber, 'CHE-123.456.789 MWST');
});

test('bootstrapWorkspace never fabricates a QR-IBAN or an MWST-Nr: absent ones land in needs', () => {
  const d = deps();
  const res = bootstrapWorkspace(d, {
    description: "Einzelfirma Muster, saldo method",
    idempotencyKey: 'b1',
  });
  assert.equal(res.ok, true);
  // No MWST number in the description: it is NOT invented, it is a need.
  assert.ok(res.needs.includes('mwstNo'), 'a missing MWST-Nr is a need, never fabricated');
  // An IBAN of either kind is never derivable from prose. It is asked for as `creditorIban`, not
  // `qrIban`: a plain IBAN gives a valid SCOR bill, so demanding a QR-IBAN would state a
  // requirement that does not exist (M-2).
  assert.ok(res.needs.includes('creditorIban'), 'a creditor IBAN is never derivable from prose');
  assert.ok(res.needs.includes('creditorAddress'));
  const ctx = makeContext(d.store, { workspaceId: res.workspaceId, clock: d.clock, ids: d.ids });
  assert.equal(getCompanyProfile(ctx).profile.mwstNo, null, 'no fabricated MWST number was stored');
  assert.equal(getCompanyProfile(ctx).profile.creditorIban, null);
});

test('bootstrapWorkspace is idempotent on its key: the same instruction returns the same workspace', () => {
  const d = deps();
  const a = bootstrapWorkspace(d, { description: 'Muster AG, effective, CHF', idempotencyKey: 'b1' });
  const b = bootstrapWorkspace(d, { description: 'Muster AG, effective, CHF', idempotencyKey: 'b1' });
  assert.equal(a.workspaceId, b.workspaceId, 'no second workspace is minted');
  const count = d.store.db.prepare('SELECT COUNT(*) AS c FROM workspace').get();
  assert.equal(count.c, 1);
});

test('bootstrapWorkspace requires a parseable name', () => {
  const d = deps();
  const res = bootstrapWorkspace(d, { description: ', , ,', idempotencyKey: 'b1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_name');
});

test('parseBootstrapDescription lifts the MWST number verbatim, never invents one', () => {
  const withNo = parseBootstrapDescription('GmbH, CHE-123.456.789');
  assert.equal(withNo.mwstNo, 'CHE-123.456.789 MWST');
  assert.equal(withNo.registered, true);
  const withoutNo = parseBootstrapDescription('Einzelfirma Muster');
  assert.equal(withoutNo.mwstNo, undefined, 'no number present, none invented');
});

test('updateCompanyProfile validates the uid and mwst_no shapes', () => {
  const d = deps();
  const created = createWorkspace(d, { name: 'Acme GmbH' });
  const ctx = makeContext(d.store, { workspaceId: created.workspaceId, clock: d.clock, ids: d.ids });

  assert.equal(updateCompanyProfile(ctx, { uid: 'CHE-123456789' }).error, 'invalid_uid');
  assert.equal(updateCompanyProfile(ctx, { mwstNo: 'CHE-123.456.789' }).error, 'invalid_mwst_no', 'missing MWST suffix');

  const okRes = updateCompanyProfile(ctx, { uid: 'CHE-123.456.789', mwstNo: 'CHE-123.456.789 MWST', legalForm: 'gmbh' });
  assert.equal(okRes.ok, true);
  const profile = getCompanyProfile(ctx).profile;
  assert.equal(profile.uid, 'CHE-123.456.789');
  assert.equal(profile.mwstNo, 'CHE-123.456.789 MWST');
  assert.equal(profile.legalForm, 'gmbh');
});
