/**
 * N01 US-N01.5, the security review's follow-up: the idempotency keys only TILL mints are not a
 * caller's to use.
 *
 * A verb another verb dispatches under a SYSTEM-derived key (a G01 firing's `auto:...`, an A12 tick's
 * `recurring:...`) keeps its replay when its key already holds another call's arguments, because that
 * record can only be the system's own earlier act. That holds only if no caller can write under such a
 * key first. So every transport door (`runGoverned` / `runGovernedAsync`: MCP, REST, the Studio's local
 * HTTP) and a plugin's `host_call` refuse a caller's key with a reserved prefix, writing nothing.
 *
 * Held here: (1) every system key builder produces a reserved prefix, and every prefix has a builder
 * (the A12 tick keys are read off a real auto-issuing tick: they stay inline template literals so the
 * K1 guard `test/style/inner-writes-use-internal-scope.test.mjs` keeps seeing their derivation);
 * (2) the doors refuse such a key for every actor and write nothing; (3) the sweep over every write
 * scenario finds no NESTED dispatch whose key is neither reserved, nor inside a composite's
 * `innerWrite`, nor an approval replay of a Vorschlag's own key, so a new system dispatcher with an
 * unreserved derived key fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest, handleRestAsync } from '../../dist/api/rest.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { runPluginToolCall } from '../../dist/core/plugins/index.js';
import {
  RESERVED_IDEMPOTENCY_KEY_PREFIXES,
  reservedKeyPrefix,
} from '../../dist/core/store/idempotencyArgs.js';
import { derivedIdempotencyKey } from '../../dist/core/automation/fire.js';
import { autoSyncKey } from '../../dist/core/banking/ebics/autoSync.js';
import { autobookKey } from '../../dist/core/banking/autobook.js';
import { scheduleRunKey } from '../../dist/core/ledger/vorlageSchedule.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';
import { SCENARIOS, fixture } from './conformance-contract.mjs';

function rowCounts(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  return out;
}

/** Capture every NESTED write dispatch's claim while `fn` runs (the store marks every dispatch). */
function nestedClaimsDuring(fn) {
  const original = SqliteStore.prototype.withIdempotencyArgs;
  const stack = [];
  const nested = [];
  SqliteStore.prototype.withIdempotencyArgs = function (claim, inner) {
    if (stack.length > 0 && claim !== null) nested.push({ claim, inInnerWrite: this.idempotencyScope('probe') !== 'probe', store: this });
    stack.push(claim);
    try {
      return original.call(this, claim, inner);
    } finally {
      stack.pop();
    }
  };
  try {
    fn();
  } finally {
    SqliteStore.prototype.withIdempotencyArgs = original;
  }
  return nested;
}

/** The keys an auto-issuing A12 tick dispatches its create and its issue under, read off a real tick. */
function a12TickKeys() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const human = (name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);
  assert.equal(human('vat_seed_defaults', { workspaceId }).ok, true);
  assert.equal(human('set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  const contact = human('create_contact', { workspaceId, partyRole: 'customer', name: 'Abo AG', idempotencyKey: 'rk-c' });
  const schedule = human('create_recurring_schedule', {
    workspaceId,
    contactId: contact.contact.id,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-16',
    dueDays: 30,
    autoIssue: true,
    idempotencyKey: 'rk-s',
  });
  assert.equal(schedule.ok, true, JSON.stringify(schedule));
  let ticked;
  const nested = nestedClaimsDuring(() => {
    ticked = human('run_due_recurring', { workspaceId });
  });
  assert.equal(ticked.results[0].outcome, 'issued', JSON.stringify(ticked));
  deps.store.close();
  return {
    create: nested.find((n) => n.claim.verb === 'create_document')?.claim.key,
    issue: nested.find((n) => n.claim.verb === 'issue_invoice')?.claim.key,
  };
}

test('every system key builder mints a reserved prefix, and every reserved prefix has its builder', () => {
  const tick = a12TickKeys();
  const minted = {
    'auto:': derivedIdempotencyKey('rule_1', 'document.issued:doc_1'),
    'recurring:': tick.create,
    'recurring_issue:': tick.issue,
    'a36-auto-': autoSyncKey('conn_1', '2026-07-16', 1),
    // N04 (D183): an automatic booking of a granted rule, and a Dauerbuchung's period.
    'autobook:': autobookKey('agrant_1', 'btxn_1'),
    'schedule:': scheduleRunKey('bstd_1', '2026-07'),
  };
  assert.deepEqual(Object.keys(minted).sort(), [...RESERVED_IDEMPOTENCY_KEY_PREFIXES].sort());
  for (const [prefix, key] of Object.entries(minted)) {
    assert.equal(reservedKeyPrefix(key), prefix, `${key} must carry the reserved prefix ${prefix}`);
  }
  // The Studio's own A36 keys and an ordinary caller key are not reserved.
  for (const key of ['a36-sync-conn_1', 'a36-press-1', 'p-1', 'doc-create-abc', 'automatic', 'recurringx']) {
    assert.equal(reservedKeyPrefix(key), undefined, key);
  }
});

test('every transport door refuses a reserved key for every actor, and writes nothing', async () => {
  for (const actor of ['agent', 'studio']) {
    const deps = { ...freshDeps(), actor };
    const { workspaceId, accId } = mintWorkspace(deps, 'Acme GmbH', `ws-${actor}`);
    const before = rowCounts(deps.store);
    for (const key of [derivedIdempotencyKey('rule_x', 'ev'), 'recurring:rsched_x:2026-07-01', 'recurring_issue:rsched_x:2026-07-01', autoSyncKey('c', '2026-07-16', 1)]) {
      const input = { workspaceId, ...manualPost(accId, key) };
      const faces = {
        rest: handleRest('post_entry', input, deps).body,
        restAsync: (await handleRestAsync('post_entry', input, deps)).body,
        mcp: JSON.parse(callTool(deps, 'post_entry', input).content[0].text),
      };
      for (const [face, res] of Object.entries(faces)) {
        assert.equal(res.ok, false, `${actor} ${face} ${key}: a reserved key must not run`);
        assert.equal(res.error, 'invalid_input', `${actor} ${face}: ${JSON.stringify(res)}`);
        assert.equal(res.field, 'idempotencyKey');
        assert.equal(res.reason, 'reserved_prefix');
      }
    }
    assert.deepEqual(rowCounts(deps.store), before, `${actor}: a refused reserved key wrote a row`);
    // An ordinary key still passes the door (the agent seat drafts, the studio seat posts).
    const fine = handleRest('post_entry', { workspaceId, ...manualPost(accId, `fine-${actor}`) }, deps).body;
    assert.equal(fine.ok, true, JSON.stringify(fine));
    deps.store.close();
  }
});

test('a plugin host_call with a reserved key is refused before dispatch', () => {
  const fx = fixture();
  try {
    const invoke = (tool, input, asActor) => getAction(tool).run({ ...fx.deps, actor: asActor }, input);
    const call = (key) =>
      runPluginToolCall(invoke, {
        grantedScopes: ['mcp_tool:create_saved_view'],
        pluginActor: 'studio',
        tool: 'create_saved_view',
        input: { workspaceId: fx.workspaceId, entityKind: 'contact', name: 'Plugin Sicht', idempotencyKey: key },
      });
    const before = rowCounts(fx.deps.store);
    const refused = call('auto:rule_1:0123456789abcdef');
    assert.equal(refused.error, 'invalid_input', JSON.stringify(refused));
    assert.equal(refused.reason, 'reserved_prefix');
    assert.deepEqual(rowCounts(fx.deps.store), before);
    const fine = call('plugin-view-1');
    assert.equal(fine.ok, true, JSON.stringify(fine));
  } finally {
    fx.deps.store.close();
  }
});

test('the registry itself (the system\'s own dispatch) still runs a reserved key', () => {
  // The door is the transport, not `action.run`: G01, A12 and the scheduler dispatch through the
  // registry directly and must keep minting these keys.
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const res = getAction('post_entry').run({ ...deps, actor: 'studio' }, { workspaceId, ...manualPost(accId, 'recurring:rsched_1:2026-07-01') });
  assert.equal(res.ok, true, JSON.stringify(res));
  deps.store.close();
});

/**
 * N01: the CALLER's dispatchers. Their nested dispatches are not the system's: every item IS a single call
 * the caller could have made directly through the transport seam, under the caller's own key (post_entries,
 * call_tool) or one derived from it (book_bank_lines, `<key>:<bankTxnId>`). Such a key must stay a public
 * key that REFUSES other arguments (US-N01.5), which an unreserved nested claim does; a reserved prefix
 * would wrongly let it replay. Measured on rows in `test/api/n01-agent-ergonomics.test.mjs`.
 */
const CALLER_DISPATCHERS = new Set(['book_bank_lines', 'post_entries', 'call_tool']);

test('every NESTED dispatch in the write scenarios runs under a reserved key, inside an innerWrite, or as an approval replay', () => {
  // The store marks every write dispatch (`withIdempotencyArgs`); a nested one is any made while
  // another is running. Recorded here for every write verb's scenario, so a system dispatcher added
  // later with an unreserved derived key fails this test.
  const problems = [];
  let reserved = 0;
  {
    for (const action of ACTIONS.filter((a) => a.kind === 'write')) {
      const scenario = SCENARIOS[action.name];
      if (scenario === undefined || CALLER_DISPATCHERS.has(action.name)) continue;
      const fx = fixture();
      try {
        const input = scenario(fx);
        const nested = nestedClaimsDuring(() => action.run(fx.deps, input));
        for (const n of nested) {
          if (reservedKeyPrefix(n.claim.key) !== undefined) {
            reserved += 1;
            continue;
          }
          if (n.inInnerWrite) continue;
          const approval = fx.deps.store.db
            .prepare('SELECT 1 FROM agent_action WHERE idempotency_key = ? OR payload_json LIKE ?')
            .get(n.claim.key, `%${JSON.stringify(n.claim.key).slice(1, -1)}%`);
          if (approval !== undefined) continue;
          problems.push(`${action.name}: nested ${n.claim.verb} under the unreserved key ${JSON.stringify(n.claim.key)}`);
        }
      } finally {
        fx.deps.store.close();
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(reserved > 0, 'the sweep must see at least one system dispatch under a reserved key');
});

// --- Security review: a claim is keyed only on an AUTHENTICATED workspace ------------------------------

test('a pre-workspace verb is never claimed: no record under an empty workspace, its engine memo decides', () => {
  const deps = freshDeps();
  const first = getAction('create_workspace').run(deps, { name: 'Erste GmbH', idempotencyKey: 'ws-pre' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const again = getAction('create_workspace').run(deps, { name: 'Andere GmbH', idempotencyKey: 'ws-pre' });
  assert.notEqual(again.error, 'idempotency_key_conflict', 'no registry claim answers for a pre-workspace verb');
  assert.equal(deps.store.db.prepare("SELECT COUNT(*) AS n FROM idempotency_args WHERE workspace_id = ''").get().n, 0);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_args').get().n, 0);
  deps.store.close();
});

test('a token-authenticated call is never claimed: it records nothing under the workspace it names and answers no conflict before its token is checked', () => {
  const fx = fixture();
  try {
    const input = SCENARIOS.quotes_accept(fx);
    const args = () => fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_args WHERE caller_key = ?').get(input.idempotencyKey).n;
    // The person accepts the quote under K (authenticated in this workspace): K is spent here.
    const accepted = getAction('quotes_accept').run({ ...fx.deps, actor: 'studio' }, input);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(args(), 1);
    // An unauthenticated caller names this workspace, a bogus token and K with other arguments: the
    // verb decides, never a registry conflict that would answer before it, and C02 checks the token
    // before any replay of its own memo (scoped by the token's hash).
    const probe = getAction('quotes_accept').run(fx.deps, { workspaceId: fx.workspaceId, token: 'kein-gueltiges-token', idempotencyKey: input.idempotencyKey });
    assert.equal(probe.error, 'invalid_token', `a bogus token was answered before its check: ${JSON.stringify(probe)}`);
    // And a token call never records a claim, so it cannot pre-claim a key in a workspace it named.
    const squat = getAction('quotes_decline').run(fx.deps, { workspaceId: fx.workspaceId, token: 'kein-gueltiges-token', idempotencyKey: 'k-squat' });
    assert.equal(squat.ok, false);
    assert.equal(fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM idempotency_args WHERE caller_key = 'k-squat'").get().n, 0);
  } finally {
    fx.deps.store.close();
  }
});
