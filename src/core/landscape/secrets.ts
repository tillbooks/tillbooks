/**
 * THE SECRET-NEUTRALIZATION FLOOR (D-ENV-5, canon finding #1). Phase B, money-path adjacent.
 *
 * On ANY copy out of a source environment, regardless of the sanitization LEVEL (raw included), every
 * live access secret is neutralized in the target BEFORE the target is made selectable, so a copied
 * environment can never touch a real bank or move real money. This is the floor under all three
 * sanitization levels; only a loud, owner-only, audited override (`retainSecrets`) lifts it, for a
 * genuine full-fidelity debug.
 *
 * WHAT COUNTS AS A SECRET HERE. TILL is credential-free BY DESIGN: EBICS private keys live in a
 * passphrase-encrypted keystore FILE, never in SQLite (`banking/ebics/schema.ts`); portal and e-accept
 * tokens are stored only as SHA-256 hashes (`portal/schema.ts`, `document.accept_token_hash`); the
 * managed rail (A37 bLink) holds only an OPAQUE relay handle that resolves to the customer's Provider
 * Token relay-side (`banking/managed/schema.ts`). So the DB carries LOCATORS and HASHES, not key
 * material. But a locator (`ebics_connection.key_ref`) that still points at a real keystore, a relay
 * consent handle (`managed_connection.consent_ref`) that still resolves to a live token, or a session
 * transport key is exactly the "ability to act on the outside world" the floor exists to sever, and a
 * token hash is a held-token oracle. Every one is neutralized.
 *
 * TWO LAYERS, so a schema that grows a new secret column cannot silently leak it:
 *   1. `SECRET_COLUMNS` is the CURATED registry, each entry with a strategy and a documented reason.
 *      `neutralizeSecrets` applies it.
 *   2. `findUnclassifiedSecretColumns` is the DRIFT TRIPWIRE: it scans the live schema for any column
 *      whose NAME matches a high-signal secret pattern and is neither curated here nor in a table a
 *      copy never carries. A test asserts it is empty, so a future secret-bearing column forces a
 *      classification rather than travelling into a copy unnoticed.
 *
 * The identity/operational/restore-excluded tables (`user`, `workspace_member`, `invite`,
 * `idempotency`, `backups`, `agent_dial`) are NEVER carried into a copy target at all (the
 * `portability.ts` snapshot/restore exclusions), so `invite.token` (the one plaintext token in the
 * schema) can never reach a copy. They are listed here only so the tripwire can account for them.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

/** How one secret column is neutralized. */
export type SecretStrategy =
  /** Set the column to NULL (a nullable column: the honest "this env holds no such secret"). */
  | 'null'
  /** Replace with a fresh random value (a NOT NULL / UNIQUE column that cannot be nulled). */
  | 'randomize';

export interface SecretColumn {
  readonly table: string;
  readonly column: string;
  readonly strategy: SecretStrategy;
  /** Why this column is a secret and how neutralizing it severs the outside-world capability. */
  readonly why: string;
}

/**
 * THE CURATED SECRET REGISTRY. Derived by grepping the base schema (`store/schema.ts`) and every
 * module schema for bank-feed credentials (A36/A37), EBICS key material and locators (A33), OAuth/API
 * tokens, webhook secrets, and any column named like token/secret/credential/passphrase/key/apikey.
 * Every column that survived that grep as a genuine access secret is here; every other pattern match
 * is a natural/business key or reference, documented at `findUnclassifiedSecretColumns`.
 */
export const SECRET_COLUMNS: readonly SecretColumn[] = [
  {
    table: 'ebics_connection',
    column: 'key_ref',
    strategy: 'null',
    why: 'A locator into the OS keychain / encrypted EBICS keystore. Retaining it lets a copy resolve and sign with the real subscriber keys, i.e. transact with the bank. Nulled: the copy has no key to act with.',
  },
  {
    table: 'ebics_connection',
    column: 'bank_key_hashes',
    strategy: 'null',
    why: 'The HPB-verified bank public-key fingerprints. Not private, but part of an active connection`s trust state; cleared as defense in depth so a copied connection carries nothing it can act on.',
  },
  {
    table: 'managed_connection',
    column: 'consent_ref',
    strategy: 'null',
    why: 'The OPAQUE relay-side consent handle that resolves to the customer`s live Provider Token (A37 bLink). It is the single thing that lets the managed rail move money; nulled, the copy cannot reach the relay.',
  },
  {
    table: 'portal_grant',
    column: 'token_hash',
    strategy: 'randomize',
    why: 'SHA-256 of a live portal-access token. A held token still resolves against a raw copy; randomizing it (NOT NULL UNIQUE, so it cannot be nulled) breaks every outstanding link so no real token opens the copy.',
  },
  {
    table: 'document',
    column: 'accept_token_hash',
    strategy: 'null',
    why: 'SHA-256 of a single-use e-accept token on an issued document. Nulled so no outstanding accept link resolves against the copy.',
  },
  {
    table: 'agent_session',
    column: 'transport_key',
    strategy: 'null',
    why: 'A per-session agent transport key. Nulled so a copied env carries no live agent-transport credential.',
  },
];

/**
 * Tables a copy NEVER carries (the `portability.ts` snapshot/restore exclusions): identity
 * (`user`, `workspace_member`, `invite`), operational (`idempotency`, `backups`) and the fail-closed
 * `agent_dial`. `invite.token` (a plaintext token) lives here, which is why it needs no neutralization:
 * it is dropped on the way in, never reaching a target. Kept in sync with `portability.ts` by the
 * `landscape-copy` test, which asserts none of these appears in a copy.
 */
export const NEVER_COPIED_TABLES: ReadonlySet<string> = new Set([
  'user',
  'workspace_member',
  'invite',
  'idempotency',
  'backups',
  'agent_dial',
]);

/**
 * High-signal secret-name patterns for the drift tripwire. Deliberately NARROW: they match the words
 * that genuinely denote a secret (token, secret, credential, passphrase, password, apikey, privkey,
 * webhook, oauth, and the specific `key_ref` / `consent_ref` / `transport_key` / `*_pem` / cipher /
 * private_key / access_token / refresh_token / client_secret), and NOT the many natural/business keys
 * the schema carries (`period_key`, `thread_key`, `entry_key`, `template_key`, `method_key`,
 * `summary_i18n_key`, `key_params`, `idempotency_key`) or the `*_ref` business references
 * (`entity_ref`, `order_ref`, `storage_ref`, ...). A blanket `key`/`ref` match would corrupt real data;
 * the point of the tripwire is to force classification of a NEW genuine secret, not to over-match.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)(token|secret|credential|passphrase|password|apikey|privkey|webhook|oauth)($|_)/i,
  /(access_token|refresh_token|client_secret|private_key|key_ref|consent_ref|transport_key|cipher)/i,
  /(api|access|secret|signing|encryption)[_-]?key/i,
  /_pem$/i,
];

/** Does a column name look like a secret (high-signal)? */
export function looksLikeSecretColumnName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

const CURATED = new Set(SECRET_COLUMNS.map((s) => `${s.table}.${s.column}`));

function allTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
}

/**
 * THE DRIFT TRIPWIRE. Every column whose name matches a secret pattern that is (a) in a table a copy
 * actually carries and (b) NOT in the curated registry. A non-empty result means the schema grew a
 * secret-looking column that the copy path would carry verbatim: classify it in `SECRET_COLUMNS` (or,
 * if it is genuinely not a secret, this function is where the exception is argued). The
 * `landscape-copy` test asserts this returns [], so the floor cannot silently spring a leak.
 */
export function findUnclassifiedSecretColumns(db: Database.Database): string[] {
  // NB: this tripwire is NAME-PATTERN based (it matches column NAMES, not values), so a genuine secret
  // stored in a column whose name does not look secret-like would slip past it. The curated registry
  // above is the real floor; this only forces classification of a NEW secret-NAMED column.
  const out: string[] = [];
  for (const table of allTables(db)) {
    if (NEVER_COPIED_TABLES.has(table)) continue;
    for (const col of columnNames(db, table)) {
      if (!looksLikeSecretColumnName(col)) continue;
      if (CURATED.has(`${table}.${col}`)) continue;
      out.push(`${table}.${col}`);
    }
  }
  return out.sort();
}

export interface NeutralizeSummary {
  /** How many curated secret columns existed in this db and were processed. */
  readonly columnsProcessed: number;
  /** How many rows had a secret value cleared or randomized, across all secret columns. */
  readonly rowsNeutralized: number;
  /** Per `table.column`, the number of rows neutralized (0 when the table/column is empty here). */
  readonly perColumn: Readonly<Record<string, number>>;
}

/**
 * Neutralize every curated secret in `db`, scoped to `workspaceIds` (§H-TENANT: a mandate-scoped copy
 * neutralizes ONLY the copied workspace, so other workspaces in an existing target are untouched). A
 * column whose table lacks `workspace_id` is neutralized unscoped (none of the current secret tables is
 * in that shape, but the guard keeps the function correct if one is ever added).
 *
 * This runs on the TARGET building db, inside the copy`s build-then-swap, so a failure here (which
 * throws) leaves the prior target intact. It touches NO money column and NO posted row, so it can never
 * unbalance the ledger; the copy re-gates afterwards regardless.
 */
export function neutralizeSecrets(db: Database.Database, workspaceIds: readonly string[]): NeutralizeSummary {
  const existing = new Set(allTables(db));
  const perColumn: Record<string, number> = {};
  let columnsProcessed = 0;
  let rowsNeutralized = 0;

  const idList = workspaceIds.length > 0 ? workspaceIds.map(() => '?').join(', ') : null;

  for (const secret of SECRET_COLUMNS) {
    if (!existing.has(secret.table)) continue; // a module whose schema is not present in this db
    const cols = new Set(columnNames(db, secret.table));
    if (!cols.has(secret.column)) continue;
    columnsProcessed += 1;
    const key = `${secret.table}.${secret.column}`;
    perColumn[key] = 0;

    const scoped = cols.has('workspace_id') && idList !== null;
    const whereScope = scoped ? ` WHERE workspace_id IN (${idList})` : '';
    const scopeParams = scoped ? [...workspaceIds] : [];

    if (secret.strategy === 'null') {
      // Only touch rows that actually hold a value, so the count is real and a NULL stays NULL.
      const where = `${whereScope}${whereScope ? ' AND' : ' WHERE'} "${secret.column}" IS NOT NULL`;
      const info = db
        .prepare(`UPDATE "${secret.table}" SET "${secret.column}" = NULL${where}`)
        .run(...scopeParams);
      perColumn[key] = info.changes;
      rowsNeutralized += info.changes;
    } else {
      // randomize: a NOT NULL / UNIQUE column. Rewrite each row's value to a fresh 256-bit random hex
      // so no source value survives and uniqueness holds. Row-by-row because the value differs per row.
      const rows = db
        .prepare(`SELECT rowid AS rid FROM "${secret.table}"${whereScope}`)
        .all(...scopeParams) as { rid: number }[];
      const update = db.prepare(`UPDATE "${secret.table}" SET "${secret.column}" = ? WHERE rowid = ?`);
      for (const r of rows) {
        update.run(randomBytes(32).toString('hex'), r.rid);
      }
      perColumn[key] = rows.length;
      rowsNeutralized += rows.length;
    }
  }

  return { columnsProcessed, rowsNeutralized, perColumn };
}
