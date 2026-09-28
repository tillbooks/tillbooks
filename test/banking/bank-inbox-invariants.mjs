// A39's line-level invariant DETECTORS, one definition each, driven by the invariant suite AND by
// its mutation proofs (the D85 shape of test/api/invariants.mjs: a mutation test written against a
// copy of a detector proves the copy, not the gate). Each returns human-readable violations, empty
// when the invariant holds.

/**
 * Every bank line link and its decision, keyed by link id. The SUPERSESSION stamp is kept apart: it is
 * the one thing a decision may gain after it is written (once), so a comparison has to know which
 * columns may move.
 */
export function linkRows(store, workspaceId) {
  const rows = store.db
    .prepare(
      `SELECT l.*, d.state, d.target_kind, d.entry_id, d.payment_id, d.journal_line_id, d.ignore_reason, d.note,
              d.remainder_mode, d.remainder_minor, d.accept_difference, d.difference_minor,
              d.superseded_at, d.superseded_by, d.supersede_reason, d.link_id AS decision_link
         FROM bank_txn_link l LEFT JOIN bank_line_decision d ON d.link_id = l.id
        WHERE l.workspace_id = ? ORDER BY l.rowid`,
    )
    .all(workspaceId);
  const out = {};
  for (const r of rows) {
    const { superseded_at, superseded_by, supersede_reason, decision_link, ...fixed } = r;
    out[r.id] = { fixed: JSON.stringify(fixed), stamp: superseded_at === null ? null : JSON.stringify([superseded_at, superseded_by, supersede_reason]), hasDecision: decision_link !== null };
  }
  return out;
}

/**
 * APPEND-ONLY ON LINKS (spec A39 §0 item 3): no link that existed may be removed, none of its decision
 * facts may change, and a supersession stamp, once written, never changes again. A LEGACY link (no
 * decision row) may gain its adopted decision; every other field still may not move.
 */
export function linkViolations(before, after) {
  const out = [];
  for (const [id, row] of Object.entries(before)) {
    const now = after[id];
    if (now === undefined) {
      out.push(`DELETED link ${id}; links are superseded, never deleted`);
      continue;
    }
    if (row.hasDecision && now.fixed !== row.fixed) out.push(`MUTATED link ${id}; a decision is immutable`);
    if (row.stamp !== null && now.stamp !== row.stamp) out.push(`RE-STAMPED link ${id}; a supersession is written once`);
  }
  return out;
}

/** EXACTLY ONE ACTIVE DECISION PER LINE: a line with two live answers is the double booking itself. */
export function multiActiveViolations(store, workspaceId) {
  return store.db
    .prepare(
      `SELECT d.bank_txn_id AS txn, COUNT(*) AS n
         FROM bank_line_decision d
        WHERE d.workspace_id = ? AND d.superseded_at IS NULL
        GROUP BY d.bank_txn_id HAVING COUNT(*) > 1`,
    )
    .all(workspaceId)
    .map((r) => `line ${r.txn} has ${r.n} active links; exactly one may be active`);
}

/**
 * AN ENTRY LEG BACKS AT MOST ONE ACTIVE LINE (critic A39-1/A39-2, A39R2-1/4/6/8), read straight off the
 * rows, independent of the engine's own claim reader. There is ONE claim model (critic A39R2-1): every
 * link has a decision (pre-A39 ones are adopted), and a live decision's claims are its rows, so:
 *   - every link has a decision row (an unadopted pre-A39 link is a violation once adoption has run);
 *   - no journal line is claimed by two live claims;
 *   - every live booked or matched decision claims at least one leg, and its legs sum to the line's
 *     signed amount less the accepted difference (a leg left over, or taken from elsewhere, is a gap);
 *   - every claim sits on its own line's Bankkonto ledger account, in the line's workspace;
 *   - no claim is live while its decision is superseded.
 */
export function legClaimViolations(store, workspaceId) {
  const db = store.db;
  const out = [];
  for (const r of db
    .prepare('SELECT l.id FROM bank_txn_link l WHERE l.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.link_id = l.id)')
    .all(workspaceId)) {
    out.push(`link ${r.id} has no decision (not adopted)`);
  }
  for (const h of db
    .prepare(
      `SELECT journal_line_id AS leg, COUNT(DISTINCT bank_txn_id) AS n FROM bank_line_claim
        WHERE workspace_id = ? AND released_at IS NULL GROUP BY journal_line_id HAVING COUNT(DISTINCT bank_txn_id) > 1`,
    )
    .all(workspaceId)) {
    out.push(`leg ${h.leg} backs ${h.n} active lines; an entry leg backs at most one`);
  }
  for (const d of db
    .prepare(
      `SELECT d.link_id AS link, d.difference_minor AS diff,
              CASE WHEN t.credit_debit = 'CRDT' THEN t.amount_minor ELSE -t.amount_minor END AS line,
              (SELECT COUNT(*) FROM bank_line_claim c WHERE c.link_id = d.link_id AND c.released_at IS NULL) AS n,
              (SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) FROM bank_line_claim c
                 JOIN journal_line jl ON jl.id = c.journal_line_id WHERE c.link_id = d.link_id AND c.released_at IS NULL) AS claimed
         FROM bank_line_decision d JOIN bank_txn t ON t.id = d.bank_txn_id
        WHERE d.workspace_id = ? AND d.superseded_at IS NULL AND d.state IN ('booked', 'matched')`,
    )
    .all(workspaceId)) {
    if (d.n === 0) out.push(`decision ${d.link} is booked or matched but claims no leg`);
    else if (d.claimed !== d.line - (d.diff ?? 0)) out.push(`decision ${d.link} claims ${d.claimed} for a line of ${d.line} (difference ${d.diff ?? 0})`);
  }
  for (const o of db
    .prepare(
      `SELECT c.journal_line_id AS leg FROM bank_line_claim c
         JOIN bank_txn t ON t.id = c.bank_txn_id
         JOIN bank_account ba ON ba.id = t.bank_account_id
         JOIN journal_line jl ON jl.id = c.journal_line_id
         JOIN journal_entry e ON e.id = jl.entry_id
        WHERE c.workspace_id = ? AND (jl.account_id <> ba.ledger_account_id OR e.workspace_id <> c.workspace_id)`,
    )
    .all(workspaceId)) {
    out.push(`claim on leg ${o.leg} is not on its line's Bankkonto ledger account`);
  }
  for (const o of db
    .prepare(
      `SELECT c.journal_line_id AS leg FROM bank_line_claim c JOIN bank_line_decision d ON d.link_id = c.link_id
        WHERE c.workspace_id = ? AND c.released_at IS NULL AND d.superseded_at IS NOT NULL`,
    )
    .all(workspaceId)) {
    out.push(`claim on leg ${o.leg} outlived its superseded decision`);
  }
  return out;
}
