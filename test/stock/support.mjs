// Test support for D01 (inventory / stock). A fresh in-memory store with a pinned clock and a real
// A03 period port (so the period-lock invariant bites), a stock-tracked item with a D00 cost price
// and reorder point, and a location. The valuation posts against the shipped KMU seed's 1200/4200.

import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { createItem } from '../../dist/core/sales/index.js';
import { upsertStockLocation } from '../../dist/core/stock/index.js';

export const AT = '2026-07-01T00:00:00.000Z';

function accountId(store, workspaceId, number) {
  return store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
}

/**
 * A workspace with the KMU chart and REAL period locks, one stock-tracked item (cost 2000 Rappen,
 * reorder point 5) and one location. `at(iso)` opens the same world on another day (for the lock case).
 */
export function setup({ costMinor = 2000, reorder = 5 } = {}) {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Lager GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'u1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });

  const item = createItem(ctx, { name: 'Widget', defaultUnitPriceMinor: 5000, idempotencyKey: 'it1' });
  if (!item.ok) throw new Error(`item failed: ${JSON.stringify(item)}`);
  store.db
    .prepare('UPDATE item SET track_stock = 1, cost_price_minor = ?, reorder_point_qty = ? WHERE id = ?')
    .run(costMinor, reorder, item.item.id);

  const loc = upsertStockLocation(ctx, { name: 'Hauptlager', idempotencyKey: 'loc1' });
  if (!loc.ok) throw new Error(`location failed: ${JSON.stringify(loc)}`);

  const acc = (number) => accountId(store, workspaceId, number);
  return {
    store,
    deps,
    ctx,
    clock,
    ids,
    workspaceId,
    itemId: item.item.id,
    locId: loc.location.id,
    acc,
    at: (iso) => makeContext(store, { workspaceId, actor: 'u1', clock: fixedClock(iso), ids, ...ledgerPorts({ store, workspaceId, ids }) }),
  };
}

/** A second workspace in the SAME database, the only shape in which a §H-TENANT claim means anything. */
export function secondWorkspace(t, name = 'Nachbar GmbH') {
  const workspaceId = createWorkspace(t.deps, { name }).workspaceId;
  const ctx = makeContext(t.store, { workspaceId, actor: 'u2', clock: t.clock, ids: t.ids, ...ledgerPorts({ store: t.store, workspaceId, ids: t.ids }) });
  const item = createItem(ctx, { name: 'Gadget', defaultUnitPriceMinor: 3000, idempotencyKey: 'it2' });
  t.store.db.prepare('UPDATE item SET track_stock = 1, cost_price_minor = ? WHERE id = ?').run(1500, item.item.id);
  const loc = upsertStockLocation(ctx, { name: 'Nebenlager', idempotencyKey: 'loc2' });
  return { ctx, workspaceId, itemId: item.item.id, locId: loc.location.id };
}

/** Every row of every table, so "nothing changed" is a claim about the database and not a feeling. */
export function snapshot(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  return JSON.stringify(out);
}

/** Row counts for a workspace, so an idempotency claim is asserted on ROWS not a return value. */
export function counts(store, workspaceId) {
  const one = (sql) => store.db.prepare(sql).get(workspaceId).n;
  return {
    movements: one('SELECT COUNT(*) AS n FROM stock_movement WHERE workspace_id = ?'),
    runs: one('SELECT COUNT(*) AS n FROM stock_valuation_run WHERE workspace_id = ?'),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    stockEntries: store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'stock'").get(workspaceId).n,
    reversals: store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'reversal'").get(workspaceId).n,
  };
}

/** The net movement on one account number across every POSTED entry in the workspace, in base Rappen. */
export function accountNet(store, workspaceId, number) {
  return store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number).net;
}

/** The legs of an entry as { number, debit, credit }, for reconciling a posting. */
export function legsOf(store, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit
         FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number`,
    )
    .all(entryId);
}
