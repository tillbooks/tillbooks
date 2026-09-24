/**
 * D01 automation surface (§6b / §7): the low-stock event is registered, and the two period-end
 * statutory verbs are on the denylist so no rule can fire them, while the movement verbs stay
 * automatable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTOMATION_EVENT_IDS, automationEventDef } from '../../dist/core/automation/events.js';
import { isNotAutomatable } from '../../dist/core/automation/denylist.js';

test('stock.low_stock_reached is a registered automation event that rides stock_move', () => {
  assert.ok(AUTOMATION_EVENT_IDS.includes('stock.low_stock_reached'));
  const def = automationEventDef('stock.low_stock_reached');
  assert.equal(def.emittedBy, 'stock_move');
  assert.equal(def.entityKind, 'item');
  // The null-collapse path: a movement that does not cross resolves this to null and emits nothing.
  assert.equal(def.entityIdPath, 'result.lowStockReachedItemId');
});

test('a rule can never name stock_run_valuation or stock_stocktake_commit (denylist), but may name the movement verbs', () => {
  assert.equal(isNotAutomatable('stock_run_valuation'), true);
  assert.equal(isNotAutomatable('stock_stocktake_commit'), true);
  assert.equal(isNotAutomatable('stock_move'), false);
  assert.equal(isNotAutomatable('stock_location_upsert'), false);
});
