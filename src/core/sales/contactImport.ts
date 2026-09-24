/**
 * C00's guided CSV/row import with duplicate detection (US-C00.5): onboarding that does not create
 * the mess `contacts_merge` has to clean up.
 *
 * Rows arrive ALREADY PARSED (the caller reads its own local file; the OSS core does no file I/O and
 * no enrichment, spec §3). Each row is validated like `createContact` and then matched against the
 * existing contacts on three signals: normalised email, exact `vatNumber`, and normalised name +
 * postcode. Matches are NOT auto-merged: they come back in `duplicates[]` with the candidate ids so
 * the operator (or agent) resolves each one deliberately. Re-running the same import under the same
 * `idempotencyKey` is a no-op (§H-IDEMPOTENT).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { createContact, resolveMergeChain } from './contact.js';
import type { ContactRow } from './contact.js';

interface ImportRow {
  name?: string;
  partyRole?: string;
  kind?: string;
  vatNumber?: string;
  email?: string;
  address?: { street?: string; houseNo?: string; zip?: string; city?: string; country?: string };
  roles?: string[];
  segments?: string[];
  lang?: string;
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Match one incoming row against the existing contacts. Returns the candidate ids (never auto-merged).
 * A match on ANY of the three signals is a candidate; exact email or UID is a strong signal, name +
 * postcode is the fuzzy one the operator most needs a chance to reject.
 *
 * TOMBSTONES ARE MATCHED, and skipping them UNDID a merge. Re-importing the same CSV after a dedupe
 * pass presents the retired duplicate's row again: it matches nothing (the only row carrying that
 * email or UID is the tombstone, which was skipped), so it is created fresh and the duplicate is back.
 * A tombstone's identifying fields are still the identifying fields of the party that absorbed it, so
 * a hit on one is reported as a hit on the SURVIVOR (`resolveMergeChain`, deduplicated): the operator
 * reviewing `duplicates[]` gets a candidate id they can actually open.
 */
function findDuplicates(
  ctx: WorkspaceContext,
  existing: readonly ContactRow[],
  row: ImportRow,
): string[] {
  const email = norm(row.email);
  const vat = norm(row.vatNumber);
  const name = norm(row.name);
  const zip = norm(row.address?.zip);
  const hits: string[] = [];
  for (const c of existing) {
    const emailMatch = email !== '' && norm(c.email) === email;
    const vatMatch = vat !== '' && norm(c.vat_number) === vat;
    const nameZipMatch = name !== '' && norm(c.name) === name && zip !== '' && norm(c.address_zip) === zip;
    if (!(emailMatch || vatMatch || nameZipMatch)) continue;
    const survivorId = c.merged_into_id === null ? c.id : resolveMergeChain(ctx, c).id;
    if (!hits.includes(survivorId)) hits.push(survivorId);
  }
  return hits;
}

export function importContacts(
  ctx: WorkspaceContext,
  input: { rows: unknown; idempotencyKey?: string },
): Result {
  if (!Array.isArray(input.rows)) return err('invalid_import_format', { reason: 'rows must be an array' });
  const rows = input.rows as ImportRow[];

  const run = (): Result => {
    const created: string[] = [];
    let skipped = 0;
    const duplicates: { row: number; candidateIds: string[] }[] = [];

    const tx = ctx.store.db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row === null || typeof row !== 'object') {
          throw new ImportRowError(i);
        }
        // The whole current set, re-read each row so a duplicate WITHIN the same file is caught too.
        const existing = ctx.store.db
          .prepare('SELECT * FROM contact WHERE workspace_id = ?')
          .all(ctx.workspaceId) as ContactRow[];
        const dups = findDuplicates(ctx, existing, row);
        if (dups.length > 0) {
          duplicates.push({ row: i, candidateIds: dups });
          skipped++;
          continue;
        }
        const result = createContact(ctx, {
          partyRole: row.partyRole ?? 'customer',
          ...(row.name !== undefined ? { name: row.name } : {}),
          ...(row.kind !== undefined ? { kind: row.kind } : {}),
          ...(row.vatNumber !== undefined ? { vatNumber: row.vatNumber } : {}),
          ...(row.email !== undefined ? { email: row.email } : {}),
          ...(row.address !== undefined ? { address: row.address } : {}),
          ...(row.roles !== undefined ? { roles: row.roles } : {}),
          ...(row.segments !== undefined ? { segments: row.segments } : {}),
          ...(row.lang !== undefined ? { lang: row.lang } : {}),
        });
        if (!result.ok) throw new ImportRowError(i, result.error as string);
        const contact = (result as unknown as { contact: { id: string } }).contact;
        created.push(contact.id);
      }
    });

    try {
      tx();
    } catch (e) {
      if (e instanceof ImportRowError) {
        return err('invalid_import_format', { row: e.row, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
      }
      throw e;
    }

    return ok({ created: created.length, createdIds: created, skipped, duplicates });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'contacts_import', run);
  }
  return run();
}

/** A row that failed validation, carrying its index so the rejection names the first bad row (P9). */
class ImportRowError extends Error {
  constructor(
    readonly row: number,
    readonly detail?: string,
  ) {
    super(`import row ${row} invalid`);
  }
}
