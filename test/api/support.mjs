// Test support for the Phase E API surface (MCP tools + REST twins over the shared registry).
// A fresh in-memory store with a pinned clock and a deterministic id sequence, so the SAME sequence
// of actions on two stores yields byte-identical Results (which is what the parity test asserts).

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { getAction } from '../../dist/api/registry.js';

export const AT = '2026-07-16T00:00:00.000Z';

/** A fresh, deterministic ApiDeps (its own store, pinned clock, fresh id sequence, agent actor). */
export function freshDeps() {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  return { store, clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
}

/** Mint a workspace through the registry and return its id plus an account-id lookup by number. */
export function mintWorkspace(deps, name = 'Acme GmbH', idempotencyKey = 'ws') {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey });
  const workspaceId = res.workspaceId;
  const accId = (number) =>
    deps.store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
      .get(workspaceId, number).id;
  return { workspaceId, accId };
}

/**
 * A test email transport for the `EmailRelayPort` seam on `ApiDeps`.
 *
 * It RECORDS every message handed to it, so "did this actually transmit?" is a question about
 * evidence rather than about a return value. There is no transport in the MIT core, deliberately:
 * a `workspace.email_relay` mode names one but is not one, and the stub that used to sit behind that
 * column returned `{ok:true}` without sending anything, which let `send_invoice` write a `sent` row
 * into the audit trail for an email that never left. A fixture that wants a send must therefore
 * inject a transport explicitly, where the reader can see it.
 *
 * `outcome` may be a function `(msg, callNumber) => {ok}` to vary the answer per call.
 */
export function recordingRelay(outcome = { ok: true }) {
  const sent = [];
  return {
    sent,
    send(msg) {
      sent.push(msg);
      return typeof outcome === 'function' ? outcome(msg, sent.length) : outcome;
    },
  };
}

/** A balanced two-line manual post: debit expense 6500, credit cash 1000. */
export function manualPost(accId, idempotencyKey = 'p-1', amount = 5000) {
  return {
    date: '2026-03-01',
    description: 'Büromaterial bar bezahlt',
    source: 'manual',
    idempotencyKey,
    lines: [
      { account: accId('6500'), debit: amount },
      { account: accId('1000'), credit: amount },
    ],
  };
}
