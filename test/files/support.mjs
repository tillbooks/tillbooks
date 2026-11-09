// Test support for E00 (file management).
//
// A workspace born with the KMU chart, plus a second workspace in the SAME store so §H-TENANT is
// tested against a real neighbour rather than against an empty database. The actor is chosen per
// context on purpose: E00's delete verb is P8 draft-gated for the D13 `agent` actor and not for a
// human at the Studio, so a suite that could not pick its actor could not tell the two apart.
//
// A RECORDING AUDIT PORT is wired, because two E00 verbs stamp the A03 chain and "it stamped one" is
// a claim about a side effect that no return value carries.

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';

export const AT = '2026-07-16T00:00:00.000Z';

/** Every audit event the context recorded, so an emission is evidence rather than an assumption. */
export function recordingAudit() {
  const events = [];
  return { events, record: (event) => events.push(event) };
}

export function setup({ actor = 'studio', at = AT, fiscalYearStart } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const created = createWorkspace(deps, {
    name: 'Acme AG',
    ...(fiscalYearStart === undefined ? {} : { fiscalYearStart }),
  });
  const workspaceId = created.workspaceId;
  const audit = recordingAudit();
  const ctx = makeContext(store, { workspaceId, actor, clock, ids, audit });
  return { ctx, store, workspaceId, deps, audit, clock, ids, AT: at };
}

/** A second context on the same store, so a tenant boundary is crossed for real. */
export function newWorkspace(deps, name, { actor = 'studio' } = {}) {
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  return makeContext(deps.store, { workspaceId, actor, clock: deps.clock, ids: deps.ids });
}

/** The same store and workspace seen by a different actor, for the P8 staging split. */
export function asActor(fixture, actor) {
  return makeContext(fixture.store, {
    workspaceId: fixture.workspaceId,
    actor,
    clock: fixture.clock,
    ids: fixture.ids,
    audit: fixture.audit,
  });
}

/**
 * The same store and workspace seen at a LATER moment.
 *
 * The retention rail is the only thing in E00 that depends on the calendar, and it depends on it
 * twice: the statutory floor is derived from the clock at LINK time, and the delete guard compares
 * against the clock at DELETE time. A fixture that re-seeded at the later date would move both, so the
 * lock would recede ten years ahead of every attempt to test it and the guard would never be reached.
 * Seeding once and then moving only the reader's clock is what makes "refused on the last day,
 * permitted the day after" a statement about the guard rather than about the fixture.
 */
export function atTime(fixture, at, { actor = 'studio' } = {}) {
  return makeContext(fixture.store, {
    workspaceId: fixture.workspaceId,
    actor,
    clock: fixedClock(at),
    ids: fixture.ids,
    audit: fixture.audit,
  });
}

/** Bytes as the wire carries them. */
export function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Row counts, because every idempotency claim in this suite is asserted on ROWS. */
export function counts(store, workspaceId) {
  const one = (sql) => store.db.prepare(sql).get(workspaceId).n;
  return {
    files: one('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?'),
    blobs: one('SELECT COUNT(*) AS n FROM stored_file_blob WHERE workspace_id = ?'),
    folders: one('SELECT COUNT(*) AS n FROM file_folder WHERE workspace_id = ?'),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    lines: one(
      'SELECT COUNT(*) AS n FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id WHERE je.workspace_id = ?',
    ),
  };
}
