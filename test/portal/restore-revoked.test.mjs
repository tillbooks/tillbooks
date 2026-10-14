/**
 * D161.2: a restore never makes a revoked or expired portal link live again.
 *
 * The defect: a backup is a picture of the book at one moment. A link the owner revokes AFTER that
 * moment (it leaked, the customer left) is still live in the picture. Restored into an empty book (the
 * disaster recovery: the laptop died), the grant kept its token hash and its `sent_at`, so the revoked
 * link opened the restored book again. Beside the original the copy already landed revoked (the token
 * hash is taken), but nothing a restore can read tells it about a revocation that happened after the
 * snapshot.
 *
 * The rule (D157 liveness, applied to restore): a restored grant that was handed over lands as a
 * DRAFT again (`minted_draft = 1`, `sent_at` cleared), so its token opens nothing until a person
 * hands it over again with `portal_grant_send` (governed under `share`). A revoked grant stays
 * revoked and an expired one stays expired, on every path: beside the original, into an empty book,
 * and for an old-shaped snapshot whose rows predate the marker.
 *
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const callFor = (deps, workspaceId) => (name, input) => getAction(name).run(deps, { workspaceId, ...input });

/** Can this token open anything? The customer page for a customer grant, the PO read for a vendor one. */
function opens(deps, workspaceId, token, kind) {
  if (kind === 'customer') return getAction('portal_resolve').run(deps, { token }).ok === true;
  return callFor(deps, workspaceId)('vendor_portal_pos', { grantToken: token }).ok === true;
}

/** A book with one sent customer grant, one vendor grant (live at mint), a backup taken while both were live. */
function bookWithLiveLinks(dir) {
  const deps = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b') };
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const c = call('create_contact', { partyRole: 'customer', name: 'Kundin AG', idempotencyKey: 'c' });
  const v = call('create_contact', { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'v' });
  const cust = call('portal_grant_create', { contactId: c.contact.id, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'g' });
  assert.equal(call('portal_grant_send', { grantId: cust.grantId, confirmed: true, idempotencyKey: 's' }).ok, true);
  const vend = call('vendor_portal_grant', { contactId: v.contact.id, expiresAt: '2026-09-30', idempotencyKey: 'vg' });
  assert.equal(vend.ok, true, JSON.stringify(vend));
  assert.equal(opens(deps, workspaceId, cust.tokenOnce, 'customer'), true, 'premise: the customer link is live');
  assert.equal(opens(deps, workspaceId, vend.tokenOnce, 'vendor'), true, 'premise: the vendor link is live');
  const bkp = call('create_backup', { idempotencyKey: 'bk' });
  assert.equal(bkp.ok, true, JSON.stringify(bkp));
  return { deps, workspaceId, call, cust, vend, bkp };
}

test('repro: a link revoked AFTER the backup does not open the book a disaster-recovery restore brings back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd161-portal-'));
  try {
    const w = bookWithLiveLinks(dir);
    // The owner revokes both links after last night's backup.
    assert.equal(w.call('portal_grant_revoke', { grantId: w.cust.grantId, idempotencyKey: 'r' }).ok, true);
    assert.equal(w.call('vendor_portal_revoke', { grantId: w.vend.grantId, idempotencyKey: 'vr' }).ok, true);
    assert.equal(opens(w.deps, w.workspaceId, w.cust.tokenOnce, 'customer'), false);

    // The laptop dies; last night's backup is restored into an empty book.
    const fresh = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b2') };
    const restored = getAction('restore_backup').run(fresh, { source: w.bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    // Critic F2 (D157.1, nothing breaks silently): the restore says how many links wait for a person.
    assert.equal(restored.portalLinksAwaitingHandover, 2);
    assert.equal(opens(fresh, restored.workspaceId, w.cust.tokenOnce, 'customer'), false, 'the revoked customer link opened the restored book');
    assert.equal(opens(fresh, restored.workspaceId, w.vend.tokenOnce, 'vendor'), false, 'the revoked vendor link opened the restored book');
    const statuses = callFor(fresh, restored.workspaceId)('portal_grant_list', {}).grants.map((g) => [g.kind, g.status]).sort();
    assert.deepEqual(statuses, [['customer', 'draft'], ['vendor', 'draft']]);
    fresh.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restored link opens again only when a person hands it over again (portal_grant_send, confirmed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd161-portal-'));
  try {
    const w = bookWithLiveLinks(dir);
    const fresh = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b2') };
    const restored = getAction('restore_backup').run(fresh, { source: w.bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const call = callFor(fresh, restored.workspaceId);
    const grants = call('portal_grant_list', {}).grants;
    for (const g of grants) {
      const token = g.kind === 'customer' ? w.cust.tokenOnce : w.vend.tokenOnce;
      assert.equal(opens(fresh, restored.workspaceId, token, g.kind), false, `${g.kind}: dormant after the restore`);
      assert.equal(call('portal_grant_send', { grantId: g.id }).error, 'needs_confirmation', 'an unconfirmed send must not reopen it');
      assert.equal(opens(fresh, restored.workspaceId, token, g.kind), false);
      assert.equal(call('portal_grant_send', { grantId: g.id, confirmed: true, idempotencyKey: `re-${g.id}` }).ok, true);
      assert.equal(opens(fresh, restored.workspaceId, token, g.kind), true, `${g.kind}: the person's hand-over reopens the same link`);
    }
    fresh.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revoked and expired grants in the backup stay dead beside the original and in an empty book, and cannot be re-sent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd161-portal-'));
  try {
    const deps = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b') };
    const { workspaceId } = mintWorkspace(deps);
    const call = callFor(deps, workspaceId);
    const c = call('create_contact', { partyRole: 'customer', name: 'Kundin AG', idempotencyKey: 'c' });
    const v = call('create_contact', { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'v' });
    const cust = call('portal_grant_create', { contactId: c.contact.id, scopes: [{ kind: 'all_invoices' }], expiresAt: '2026-09-30', idempotencyKey: 'g' });
    call('portal_grant_send', { grantId: cust.grantId, confirmed: true, idempotencyKey: 's' });
    call('portal_grant_revoke', { grantId: cust.grantId, idempotencyKey: 'r' });
    const vend = call('vendor_portal_grant', { contactId: v.contact.id, expiresAt: '2026-09-30', idempotencyKey: 'vg' });
    call('vendor_portal_revoke', { grantId: vend.grantId, idempotencyKey: 'vr' });
    // An expired vendor grant: the clock's day is 2026-07-16.
    const expiredVendor = call('vendor_portal_grant', { contactId: v.contact.id, expiresAt: '2026-08-01', idempotencyKey: 've' });
    deps.store.db.prepare("UPDATE portal_grant SET expires_at = '2026-07-01' WHERE id = ?").run(expiredVendor.grantId);
    const bkp = call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));

    const fresh = { ...freshDeps(), actor: 'studio', backupDir: join(dir, 'b2') };
    const empty = getAction('restore_backup').run(fresh, { source: bkp.artifactRef, newWorkspaceName: 'Neu AG', confirmed: true });
    const beside = getAction('restore_backup').run(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    for (const [d, r] of [[fresh, empty], [deps, beside]]) {
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.portalLinksAwaitingHandover, 0, 'a revoked or expired grant is not a link a person can hand over again');
      const rc = callFor(d, r.workspaceId);
      assert.equal(opens(d, r.workspaceId, cust.tokenOnce, 'customer'), false);
      assert.equal(opens(d, r.workspaceId, vend.tokenOnce, 'vendor'), false);
      assert.equal(opens(d, r.workspaceId, expiredVendor.tokenOnce, 'vendor'), false);
      const grants = rc('portal_grant_list', {}).grants;
      for (const g of grants) {
        assert.notEqual(g.status, 'active');
        assert.equal(rc('portal_grant_send', { grantId: g.id, confirmed: true, idempotencyKey: `x-${g.id}` }).ok, false, `${g.status} grant re-sent`);
      }
      assert.deepEqual(grants.map((g) => g.status).sort(), d === fresh ? ['expired', 'revoked', 'revoked'] : ['revoked', 'revoked', 'revoked']);
    }
    fresh.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
