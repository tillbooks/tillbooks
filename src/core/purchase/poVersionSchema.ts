/**
 * I01 (Advanced Purchase Order): the OP14 versioning + amendment tables, ADDITIVE to D02. I01 never
 * replaces D02's live `purchase_order` / `po_line` tables; it layers an immutable version trail and an
 * amendment lifecycle over them, and only UPDATES the live tables inside the apply transaction.
 *
 * §H-AUDIT: `po_version`, `po_amendment` and `po_amendment_line` are INSERT-ONLY history. A superseded
 * version's snapshot is frozen, never overwritten; an applied amendment is never mutated. The ONE
 * mutable field is `po_version.status` (active -> superseded), which is the single active-version
 * pointer OP14 requires. §H-TENANT: every table carries `workspace_id` and every query scopes by it.
 * Money is integer Rappen (P2). Kept DISJOINT from `purchaseOrderSchema.ts` so concurrent branches
 * never edit one long string.
 *
 * NO CHECK CONSTRAINT on the status columns: the vocabulary lives at the single §H-ENUM source
 * (`poVersionEnums.ts`), validated at the verb boundary, exactly as D02 keeps `PO_STATUS` in one place.
 */

export const PO_VERSION_SCHEMA_SQL = `
-- I01: an immutable snapshot of a purchase order at the moment a version became active (OP14).
-- version_number is 1..N, gap-free per PO. status is 'active' | 'superseded'; exactly one row per
-- po_id is 'active'. header_snapshot / lines_snapshot are the frozen JSON images (§H-AUDIT). A
-- version is created at first-touch materialisation (v1) and on every amendment apply (N+1).
CREATE TABLE IF NOT EXISTS po_version (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspace(id),
  po_id                    TEXT NOT NULL REFERENCES purchase_order(id),
  version_number           INTEGER NOT NULL,
  status                   TEXT NOT NULL,
  header_snapshot          TEXT NOT NULL,
  lines_snapshot           TEXT NOT NULL,
  sent_artifact_ref        TEXT,
  created_from_amendment_id TEXT,
  created_by               TEXT,
  created_at               TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS po_version_number ON po_version (workspace_id, po_id, version_number);
CREATE INDEX IF NOT EXISTS po_version_by_po ON po_version (workspace_id, po_id, version_number);
-- At most ONE active version per PO (OP14 invariant 'exactly-one-active'): a partial UNIQUE index over
-- the active rows makes a second active insert impossible at the storage layer, not just in code.
CREATE UNIQUE INDEX IF NOT EXISTS po_version_one_active ON po_version (workspace_id, po_id) WHERE status = 'active';

-- I01: an amendment header. status walks draft -> (pending_approval) -> applied | rejected | cancelled.
-- from_version_id is the active version at start; to_version_id is set on apply. committed_value_delta_rappen
-- is filled on apply (preview stays pure, P5). idempotency_key rides §H-IDEMPOTENT. At most one
-- non-terminal ('draft' | 'pending_approval') amendment per PO (enforced by the partial index below).
CREATE TABLE IF NOT EXISTS po_amendment (
  id                            TEXT PRIMARY KEY,
  workspace_id                  TEXT NOT NULL REFERENCES workspace(id),
  po_id                         TEXT NOT NULL REFERENCES purchase_order(id),
  from_version_id               TEXT NOT NULL REFERENCES po_version(id),
  to_version_id                 TEXT REFERENCES po_version(id),
  status                        TEXT NOT NULL,
  reason                        TEXT,
  committed_value_delta_rappen  INTEGER,
  created_by                    TEXT,
  submitted_by                  TEXT,
  applied_by                    TEXT,
  rejected_by                   TEXT,
  cancelled_by                  TEXT,
  created_at                    TEXT NOT NULL,
  submitted_at                  TEXT,
  applied_at                    TEXT,
  rejected_at                   TEXT,
  cancelled_at                  TEXT,
  idempotency_key               TEXT
);

CREATE INDEX IF NOT EXISTS po_amendment_by_po ON po_amendment (workspace_id, po_id, created_at);
-- One OPEN amendment per PO: the 'amendment_in_progress' serialisation (US-I01.8) at the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS po_amendment_one_open ON po_amendment (workspace_id, po_id) WHERE status IN ('draft', 'pending_approval');

-- I01: one change operation inside an amendment. op is 'change' | 'add' | 'remove'. po_line_id names
-- the live line for change/remove (NULL for a pure add). The before/after images are captured so the
-- amendment is self-describing for the diff and the audit trail even after the live line moves on.
CREATE TABLE IF NOT EXISTS po_amendment_line (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspace(id),
  amendment_id              TEXT NOT NULL REFERENCES po_amendment(id),
  op                        TEXT NOT NULL,
  po_line_id                TEXT,
  item_id                   TEXT,
  before_qty                INTEGER,
  after_qty                 INTEGER,
  before_unit_price_rappen  INTEGER,
  after_unit_price_rappen   INTEGER,
  before_description        TEXT,
  after_description         TEXT,
  tax_code                  TEXT,
  sort                      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS po_amendment_line_by_amendment ON po_amendment_line (workspace_id, amendment_id, sort);
`;
