/**
 * A41.3 re-cut v2 (D184), the tables behind "this receipt is the Beleg of this bank line".
 *
 * `beleg_assignment` is THE ONE INPUT the autobook receipt verdict reads (I-A). One row says: receipt group G
 * (its files, `beleg_assignment_file`) is the receipt of bank line L. It names who made it (`source`
 * `engine_unique` with seat `system`, or `person` with the person's actor), its `state` (`active`,
 * `consumed` by a booking, `released` with a `release_reason`) and, once consumed, the entry the booking
 * posted. A row is never deleted; its identity never changes; the state moves only active -> consumed,
 * active -> released, and consumed -> released (`line_reopened`, a reopen takes the booking back). At most ONE
 * active row per line (partial unique index, tenant included).
 *
 * `beleg_assignment_file` holds one row per file of the group with the FIGURE SNAPSHOT the assignment was made
 * on (the capture's sha256, amount, currency and printed VAT). `active` mirrors the parent's state through a
 * trigger (never written by code), and at most one ACTIVE row per file, per capture and per receipt content
 * (sha256), each tenant-bound: one receipt is the Beleg of at most one line at a time.
 *
 * `capture_figure_confirmation` (I-F) is a person's one-click "Zahlen bestätigen": the figures of a capture as
 * the person confirmed them, append-only. Under `belege.autobook_figure_trust = confirmed` only figures a
 * person confirmed (the newest confirmation equals the live figures) or read from a Swiss QR code back an
 * engine assignment.
 *
 * Every table carries `workspace_id` (§H-TENANT) and is a plain `CREATE ... IF NOT EXISTS`, so an existing
 * book gains them on open. `stored_file.linked_by` / `linked_by_seat` (additive) record WHO filed a file on
 * its record and whether that seat was a person at that moment (a plugin call runs as its installer, so the
 * actor alone cannot tell): the store's one-time step (I-G) trusts only a person's filing.
 */
export const BELEG_ASSIGNMENT_RELEASE_REASONS = [
  'person',
  'line_ignored',
  'line_reopened',
  'line_decided',
  'capture_committed',
  'figures_changed',
  'receipt_changed',
  'no_longer_unique',
  'capture_discarded',
  // A41.3 re-cut v3: a person's act that overrode an ENGINE row (never blocks), a person's explicit "Lösen" or
  // replace of an ENGINE row (blocks that pair, like `person` on a person row), a person's move of a PERSON row
  // under belege.assigned_move = move (never blocks).
  'person_overrode',
  'person_rejected',
  'person_moved',
] as const;
export type BelegAssignmentReleaseReason = (typeof BELEG_ASSIGNMENT_RELEASE_REASONS)[number];

/**
 * Critic A41.3 r1 D4 (I-E): the audit actions that record the receipt-assignment history. `get_audit_log` hides
 * them from a seat without the receipt read right (`BELEG_AUDIT_READ_CAPABILITY`, the `belegMatch.ts` read
 * domain). Every writer of these actions uses this list's words (`belegAssignmentStore.ts`, `belegAssignment.ts`,
 * the store's generation 19).
 */
export const BELEG_AUDIT_ACTIONS = ['beleg_assign', 'beleg_consume', 'beleg_release', 'confirm_figures'] as const;
export const BELEG_AUDIT_READ_CAPABILITY = 'read_master_data';

const REASONS_SQL = BELEG_ASSIGNMENT_RELEASE_REASONS.map((r) => `'${r}'`).join(', ');

export const BELEG_ASSIGNMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS beleg_assignment (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id    TEXT NOT NULL REFERENCES bank_txn(id),
  source         TEXT NOT NULL CHECK (source IN ('engine_unique', 'person')),
  seat           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'consumed', 'released')),
  release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN (${REASONS_SQL})),
  entry_id       TEXT REFERENCES journal_entry(id),
  closed_at      TEXT,
  closed_by      TEXT,
  CHECK ((state = 'active' AND release_reason IS NULL AND closed_at IS NULL)
      OR (state = 'consumed' AND release_reason IS NULL AND closed_at IS NOT NULL)
      OR (state = 'released' AND release_reason IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS beleg_assignment_one_active_per_line
  ON beleg_assignment (workspace_id, bank_txn_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS beleg_assignment_by_line
  ON beleg_assignment (workspace_id, bank_txn_id, created_at);

CREATE TABLE IF NOT EXISTS beleg_assignment_file (
  assignment_id  TEXT NOT NULL REFERENCES beleg_assignment(id),
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  bank_txn_id    TEXT NOT NULL REFERENCES bank_txn(id),
  file_id        TEXT NOT NULL REFERENCES stored_file(id),
  capture_id     TEXT NOT NULL REFERENCES captures(id),
  sha256         TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL,
  vat_minor      INTEGER,
  -- Critic A41.3 r1 S1/S2: the capture's engine fields (figures and match keys) the row was made on.
  match_json     TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (assignment_id, file_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS beleg_assignment_file_one_active_file
  ON beleg_assignment_file (workspace_id, file_id) WHERE active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS beleg_assignment_file_one_active_capture
  ON beleg_assignment_file (workspace_id, capture_id) WHERE active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS beleg_assignment_file_one_active_bytes
  ON beleg_assignment_file (workspace_id, sha256) WHERE active = 1;
CREATE INDEX IF NOT EXISTS beleg_assignment_file_by_pair
  ON beleg_assignment_file (workspace_id, bank_txn_id, file_id);

CREATE TRIGGER IF NOT EXISTS beleg_assignment_no_delete
  BEFORE DELETE ON beleg_assignment
  BEGIN SELECT RAISE(ABORT, 'beleg_assignment rows are never deleted: release the assignment'); END;
CREATE TRIGGER IF NOT EXISTS beleg_assignment_frozen
  BEFORE UPDATE ON beleg_assignment
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.bank_txn_id IS NOT OLD.bank_txn_id
    OR NEW.source IS NOT OLD.source OR NEW.seat IS NOT OLD.seat OR NEW.created_at IS NOT OLD.created_at
    OR OLD.state = 'released'
    OR (OLD.state = 'consumed' AND NOT (NEW.state = 'released' AND NEW.release_reason = 'line_reopened'))
    OR (OLD.state = 'consumed' AND NEW.entry_id IS NOT OLD.entry_id)
    OR (OLD.state = 'active' AND NEW.state = 'active')
  BEGIN SELECT RAISE(ABORT, 'beleg_assignment: only the state moves, active -> consumed | released, consumed -> released (line_reopened)'); END;
CREATE TRIGGER IF NOT EXISTS beleg_assignment_files_follow
  AFTER UPDATE OF state ON beleg_assignment
  WHEN OLD.state = 'active' AND NEW.state <> 'active'
  BEGIN UPDATE beleg_assignment_file SET active = 0 WHERE workspace_id = NEW.workspace_id AND assignment_id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS beleg_assignment_file_no_delete
  BEFORE DELETE ON beleg_assignment_file
  BEGIN SELECT RAISE(ABORT, 'beleg_assignment_file rows are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS beleg_assignment_file_frozen
  BEFORE UPDATE ON beleg_assignment_file
  WHEN NEW.assignment_id IS NOT OLD.assignment_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.bank_txn_id IS NOT OLD.bank_txn_id
    OR NEW.file_id IS NOT OLD.file_id OR NEW.capture_id IS NOT OLD.capture_id OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.vat_minor IS NOT OLD.vat_minor
    OR NEW.match_json IS NOT OLD.match_json
    OR (OLD.active = 0 AND NEW.active = 1)
  BEGIN SELECT RAISE(ABORT, 'beleg_assignment_file: the snapshot is frozen and an inactive file never becomes active again'); END;

CREATE TABLE IF NOT EXISTS capture_figure_confirmation (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  capture_id    TEXT NOT NULL REFERENCES captures(id),
  sha256        TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL,
  vat_minor     INTEGER,
  -- Critic A41.3 r1 S1/S2: every engine field the person confirmed (figures and match keys), canonical.
  match_json    TEXT NOT NULL,
  confirmed_by  TEXT NOT NULL,
  confirmed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capture_figure_confirmation_by_capture
  ON capture_figure_confirmation (workspace_id, capture_id, confirmed_at);
CREATE TRIGGER IF NOT EXISTS capture_figure_confirmation_no_update
  BEFORE UPDATE ON capture_figure_confirmation
  BEGIN SELECT RAISE(ABORT, 'capture_figure_confirmation is append-only'); END;
CREATE TRIGGER IF NOT EXISTS capture_figure_confirmation_no_delete
  BEFORE DELETE ON capture_figure_confirmation
  BEGIN SELECT RAISE(ABORT, 'capture_figure_confirmation is append-only'); END;
`;

/** I-G: who filed a file on its record, and whether that seat was a person at that moment. */
export const BELEG_ASSIGNMENT_ADDITIVE_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'stored_file', column: 'linked_by', ddl: 'linked_by TEXT' },
  { table: 'stored_file', column: 'linked_by_seat', ddl: "linked_by_seat TEXT CHECK (linked_by_seat IS NULL OR linked_by_seat IN ('person', 'machine'))" },
  // Critic A41.3 follow-ups r1 F1 (I-F): where a stored file's BYTES came from, stamped when the bytes enter the
  // filing (an upload, a new version, a chunked commit, a Vorschlag's pending file released; a twin filing row
  // copies its source's). The same rule as `captures.intake_seat` (`intakeSeatOf` at that moment; a released
  // pending file is its DRAFTER's). NULL on a file from before this build: unknown, which fails closed.
  { table: 'stored_file', column: 'uploaded_by', ddl: 'uploaded_by TEXT' },
  { table: 'stored_file', column: 'intake_seat', ddl: "intake_seat TEXT CHECK (intake_seat IS NULL OR intake_seat IN ('person', 'folder', 'machine'))" },
  // I-F: where a capture's bytes came from (`purchase/intakeSeat.ts`: `person`, `folder` for the Belegeingang
  // scan, `machine` for an agent, a plugin call, the system, or a person's approval of a governed seat's draft).
  // NULL on a capture from before this build: unknown, so its QR figures are not trusted (fail closed).
  // Critic A41.3 r1 S1/S2: the engine-field snapshots (a book opened by an earlier build of this branch gains
  // them NULL; a NULL snapshot never equals a live one, so it fails closed).
  { table: 'beleg_assignment_file', column: 'match_json', ddl: 'match_json TEXT' },
  { table: 'capture_figure_confirmation', column: 'match_json', ddl: 'match_json TEXT' },
  { table: 'captures', column: 'intake_seat', ddl: "intake_seat TEXT CHECK (intake_seat IS NULL OR intake_seat IN ('person', 'folder', 'machine'))" },
];
