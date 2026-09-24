/**
 * A16's one table (§4). Everything else this capability does is a pure read.
 *
 * A16 is a read model over `document` and `payment_allocation`, both of which A11 and A14 own, so
 * the only thing it stores is the workspace's own view preference: where the aging buckets cut. The
 * boundaries are a DACH reporting convention and NOT a statutory figure (§3), which is exactly why
 * they are configurable while the open amount behind them is not.
 *
 * ONE ROW PER WORKSPACE, and an ABSENT row means the shipped default `[30, 60, 90]`. A default that
 * is written on first read would make "this workspace has never configured its buckets" and "this
 * workspace deliberately chose the default" indistinguishable, and it would turn every read of the
 * OP-Liste into a write. So the absence carries the meaning, and `configured` reports which of the
 * two a caller is looking at.
 *
 * The boundaries are stored as a JSON array rather than as columns, because the number of buckets is
 * itself the thing being configured: a four-column table would fix the bucket count at four, which
 * is the one property §6b explicitly makes flexible.
 *
 * `idempotency_key` records WHICH key last changed the row, and nothing more. It is deliberately not
 * the replay mechanism: `workspace_id` is the PRIMARY KEY and the row is replaced in place, so the
 * row can only ever remember the MOST RECENT key. Answering replays from it made a late retry of an
 * older key unrecognisable, and that retry silently rolled a newer edit back. §H-IDEMPOTENT is
 * therefore served by the store's `idempotency` side table, which remembers every completed key,
 * the same way every other key-carrying write in the engine does it.
 *
 * The row is REPLACED in place on a genuine change, never appended to: a boundary set is a current
 * preference and has no ledger meaning, so there is no §H-AUDIT immutability claim here and no
 * trigger pretending otherwise.
 */

export const DEBTORS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS aging_bucket_config (
  workspace_id         TEXT PRIMARY KEY REFERENCES workspace(id),
  boundaries_days_json TEXT NOT NULL,
  idempotency_key      TEXT,
  updated_at           TEXT NOT NULL
);
`;
