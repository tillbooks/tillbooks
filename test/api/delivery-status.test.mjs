/**
 * M00: `delivery_status` and the runtime-state singleton it reads.
 *
 * The verb describes the PROCESS, not a tenant, so these assertions drive the module singleton the
 * host populates (mode, bound host/port, studio-served, the scheduler line) and confirm the verb
 * mirrors it, plus that it reads the schema generation straight off the store. Every test resets the
 * singleton first so one mode never leaks into the next.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import {
  getDeliveryRuntime,
  setDeliveryRuntime,
  setSchedulerStatus,
  resetDeliveryRuntime,
  DELIVERY_MODES,
  RUNTIME_MODE_ENV,
  TILL_VERSION,
} from '../../dist/api/runtime-state.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { freshDeps } from './support.mjs';

const status = (deps) => getAction('delivery_status').run(deps, {});

test('delivery_status: fresh process reports mode=mcp and no listener', () => {
  resetDeliveryRuntime();
  const deps = freshDeps();
  const res = status(deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.mode, 'mcp');
  assert.equal(res.host, null);
  assert.equal(res.port, null);
  assert.equal(res.studioServed, false);
  assert.equal(res.version, TILL_VERSION);
  assert.deepEqual(res.scheduler, { enabled: false, lastTickAt: null, nextTickAt: null });
});

test('delivery_status: reports the schema generation off the open store', () => {
  resetDeliveryRuntime();
  const deps = freshDeps();
  // A freshly opened store is migrated to the current generation on open (PRAGMA user_version).
  assert.equal(status(deps).schemaGeneration, SCHEMA_GENERATION);
});

test('delivery_status: reflects a bound till-up listener', () => {
  resetDeliveryRuntime();
  setDeliveryRuntime({ mode: 'up', host: '127.0.0.1', port: 8788, studioServed: true });
  const res = status(freshDeps());
  assert.equal(res.mode, 'up');
  assert.equal(res.host, '127.0.0.1');
  assert.equal(res.port, 8788);
  assert.equal(res.studioServed, true);
});

test('delivery_status: reflects the scheduler line', () => {
  resetDeliveryRuntime();
  setSchedulerStatus({ enabled: true, lastTickAt: '2026-07-16T00:00:00.000Z', nextTickAt: '2026-07-16T00:01:00.000Z' });
  const res = status(freshDeps());
  assert.equal(res.scheduler.enabled, true);
  assert.equal(res.scheduler.lastTickAt, '2026-07-16T00:00:00.000Z');
  assert.equal(res.scheduler.nextTickAt, '2026-07-16T00:01:00.000Z');
});

test('delivery_status: TILL_RUNTIME_MODE=agent_session is the ONLY env that flips the default mode', () => {
  const prior = process.env[RUNTIME_MODE_ENV];
  try {
    process.env[RUNTIME_MODE_ENV] = 'agent_session';
    resetDeliveryRuntime();
    assert.equal(status(freshDeps()).mode, 'agent_session');

    // A typo or any other value never opts in: the residency caveat is never claimed by accident.
    process.env[RUNTIME_MODE_ENV] = 'agent';
    resetDeliveryRuntime();
    assert.equal(status(freshDeps()).mode, 'mcp');
  } finally {
    if (prior === undefined) delete process.env[RUNTIME_MODE_ENV];
    else process.env[RUNTIME_MODE_ENV] = prior;
    resetDeliveryRuntime();
  }
});

test('delivery_status: the mode enum is exactly the four delivery modes and every one is reportable', () => {
  assert.deepEqual([...DELIVERY_MODES].sort(), ['agent_session', 'mcp', 'serve', 'up']);
  for (const mode of DELIVERY_MODES) {
    resetDeliveryRuntime();
    setDeliveryRuntime({ mode });
    assert.equal(status(freshDeps()).mode, mode);
  }
  resetDeliveryRuntime();
});

test('delivery_status: is a pre-workspace read (no workspaceId required, readOnly)', () => {
  const action = getAction('delivery_status');
  assert.equal(action.kind, 'read');
  assert.ok(!action.inputSchema.required.includes('workspaceId'));
  // A snapshot is a snapshot: getDeliveryRuntime returns a copy, not the live object.
  resetDeliveryRuntime();
  const a = getDeliveryRuntime();
  a.mode = 'up';
  assert.equal(getDeliveryRuntime().mode, 'mcp', 'the snapshot must not alias the singleton');
});
