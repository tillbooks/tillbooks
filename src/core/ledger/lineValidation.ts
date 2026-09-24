/**
 * Shared line-field validation for A02.
 *
 * Both `postEntry` and `saveDraft` write `journal_line` rows, so both must reject a line whose shape
 * would corrupt the money path or throw at the SQL bind: a non-integer or negative debit/credit, a
 * non-integer tax base/amount (negatives allowed: a reversal stores a negated trace), a non-string
 * tax code / cost centre, a tax code that does not EXIST in this workspace (F1: existence is checked
 * for EVERY line on every path, reversals included; only the ACTIVE check is posting-path-specific
 * and lives in the post gate), or an account / cost centre that does not exist in this workspace
 * (§H-TENANT). This does NOT check balance or the one-side rule: those are posting-only and live in
 * `postEntry`, because a draft is deliberately allowed to be unbalanced or one-sided.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import type { LineInput } from './postEntry.js';
import { optionalDate } from './inputGuards.js';

function nonNegativeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function optionalInteger(value: number | undefined): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function optionalNonEmptyString(value: string | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

export function validateLineFields(ctx: WorkspaceContext, lines: LineInput[]): Err | null {
  if (!Array.isArray(lines)) {
    return err('invalid_line', { reason: 'lines must be an array' });
  }

  for (const line of lines) {
    if (typeof line !== 'object' || line === null || typeof line.account !== 'string' || line.account.length === 0) {
      return err('invalid_line', { reason: 'each line needs a non-empty account id' });
    }
    if (!nonNegativeInteger(line.debit) || !nonNegativeInteger(line.credit)) {
      return err('invalid_line', { account: line.account, reason: 'amounts must be non-negative integer Rappen' });
    }
    if (!optionalInteger(line.taxBase) || !optionalInteger(line.taxAmount)) {
      return err('invalid_line', { account: line.account, reason: 'tax base/amount must be integer Rappen' });
    }
    // A13 §4b.3: the stated base is SHAPE-checked here beside its siblings; the source gate,
    // all-or-none rule and balance check are posting-only and live in postEntry (a draft persists
    // no base column at all, so the field is inert there).
    if (!nonNegativeInteger(line.baseAmountMinor)) {
      return err('invalid_line', {
        account: line.account,
        reason: 'baseAmountMinor must be a non-negative integer Rappen amount',
      });
    }
    if (!optionalNonEmptyString(line.taxCode) || !optionalNonEmptyString(line.costCenter)) {
      return err('invalid_line', { account: line.account, reason: 'taxCode / costCenter must be non-empty strings' });
    }
    // F2: a PRESENT-but-malformed Leistungsdatum is a structured rejection, never silently the
    // entry date (that coercion would book the wrong era's rate, the M3 no-go).
    if (optionalDate(line.supplyDate, 'supplyDate') !== null) {
      return err('invalid_line', { account: line.account, reason: 'supplyDate must be a valid YYYY-MM-DD date' });
    }

    // F1: a tax code must EXIST in this workspace on EVERY path that writes journal_line, the
    // reversal door included (the literal 'none' sentinel is the no-VAT marker, not a code). The
    // no-codes-at-all workspace stays the P9 `needs_vat_config`, mirroring resolveTax, so the agent
    // and the human share one code path into A05's setup. Archived codes pass HERE (drafts and
    // faithful reversals of historical entries need them); new postings reject them in the gate.
    if (line.taxCode !== undefined && line.taxCode !== 'none') {
      const code = ctx.store.db
        .prepare('SELECT 1 FROM tax_code WHERE workspace_id = ? AND code = ?')
        .get(ctx.workspaceId, line.taxCode);
      if (code === undefined) {
        const anyCode = ctx.store.db
          .prepare('SELECT 1 FROM tax_code WHERE workspace_id = ? LIMIT 1')
          .get(ctx.workspaceId);
        if (anyCode === undefined) return err('needs_vat_config');
        return err('unknown_tax_code', { taxCode: line.taxCode });
      }
    }

    const account = ctx.store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, line.account) as { id: string } | undefined;
    if (account === undefined) {
      return err('invalid_account', { account: line.account });
    }

    if (line.costCenter !== undefined) {
      const costCenter = ctx.store.db
        .prepare('SELECT id FROM cost_center WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, line.costCenter) as { id: string } | undefined;
      if (costCenter === undefined) {
        return err('invalid_cost_center', { costCenter: line.costCenter });
      }
    }
  }

  return null;
}
