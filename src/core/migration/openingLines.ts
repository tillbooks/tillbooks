/**
 * G18, the ONE place a migration opening-balances source row becomes a posting line, shared so the
 * G09 commit (`steps.ts` commitRoute) and the G11 `trial_balance` control (`controls/trialBalance.ts`)
 * "see one number." The two used to mirror the field mapping by hand; a single builder makes the
 * lockstep structural instead of a comment both sides must remember to honour.
 *
 * Two readings live here, and BOTH must stay lockstepped:
 *   1. Explicit debit/credit (already minor): the interim `account,debitMinor,creditMinor` shape and
 *      German `soll`/`haben`. Read UNCHANGED from what the branch did before, so no existing shape
 *      regresses.
 *   2. A signed `Saldo`/`balance` (major units): a bexio Saldenliste/Bilanz states ONE signed figure
 *      per account. Split it the Swiss way: debit carries a positive balance (assets/expenses), credit
 *      a negative one (equity/liabilities/income). This is the turnkey path that retires
 *      `scripts/migration/saldenliste-to-opening.mjs`.
 *
 * Group rows (a bexio Bilanz is hierarchical: `Kontoart = "Gruppe"` subtotals sit beside postable
 * leaves) have no postable account, so importing one double-counts its children. "Postable" is
 * resolved through the SAME §H-TENANT lookup the poster uses (`accountIsPostable`): a row whose account
 * is not in this workspace's chart is SKIPPED and RECORDED (owner decision, 2026-08-29), never turned
 * into a phantom opening line and never silently dropped. The balanced control is the safety net: a
 * wrongly skipped real account leaves the kept set unbalanced and `trial_balance_balanced` fails loud.
 */

import type { WorkspaceContext } from '../context.js';
import type { ParsedRow } from './adapters/parse.js';
import { parseMinor } from './crudCommit.js';
// Deep import, not via ledger/index: `accountIsPostable` is a read helper, not a ledger verb, and the
// P3 guard (test/ledger/p3-guard.test.mjs) asserts the public ledger surface is EXACTLY its verbs.
import { accountIsPostable } from '../ledger/openingBalances.js';
import { normalizeToken } from './locale/registry.js';

/** One resolved opening line, plus the source-row ref for the row-level audit trail (spec §4). */
export interface OpeningLine {
  readonly ref: string;
  readonly account: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

/** A source row that produced no line, with the reason, so the operator SEES it (never silent). */
export interface SkippedOpeningRow {
  readonly ref: string;
  readonly account: string;
  readonly reason: 'not_postable' | 'invalid_balance';
}

export interface OpeningLinesResult {
  readonly lines: OpeningLine[];
  readonly skipped: SkippedOpeningRow[];
}

// Normalized-token aliases (via `normalizeToken`, so case/locale spelling all match one door). The
// debit/credit tokens are exactly what commitRoute read before; `account` and `balance` extend that
// same idiom so a raw bexio `Kontonummer;Name;Saldo` reads with no preprocessing.
const ACCOUNT_ALIASES = ['account', 'konto', 'kontonummer', 'nummer', 'kontonr', 'compte', 'conto'];
const DEBIT_ALIASES = ['debitminor', 'soll'];
const CREDIT_ALIASES = ['creditminor', 'haben'];
const BALANCE_ALIASES = ['balance', 'saldo', 'solde', 'saldochf', 'betrag'];

/** A stable ref for a source row: the same `row:<index>` convention the step verbs use. */
function rowRef(index: number): string {
  return `row:${index}`;
}

/** Build a normalized-token -> value view of a raw parsed row (first spelling of a token wins). */
function tokenView(row: ParsedRow): Map<string, string> {
  const byToken = new Map<string, string>();
  for (const [header, value] of Object.entries(row)) {
    const token = normalizeToken(header);
    if (!byToken.has(token)) byToken.set(token, value);
  }
  return byToken;
}

/** First non-empty value among the aliases, or undefined. */
function pick(view: Map<string, string>, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = view.get(alias);
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Split a signed major-unit `Saldo` into minor debit/credit. Returns `'invalid'` for a figure that
 * cannot be represented in Rappen without rounding (P2: never round here), so the caller records it
 * rather than silently zeroing it.
 */
function splitSignedBalance(raw: string): { debitMinor: number; creditMinor: number } | 'invalid' {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith('-');
  const magnitude = negative ? trimmed.slice(1).trim() : trimmed;
  const minor = parseMinor(undefined, magnitude);
  if (minor === 'invalid' || minor === null) return 'invalid';
  return { debitMinor: negative ? 0 : minor, creditMinor: negative ? minor : 0 };
}

/**
 * Turn the parsed opening-balances rows into postable lines plus a recorded skip list. The single
 * source of truth for both the commit and the G11 control.
 */
export function buildOpeningLines(ctx: WorkspaceContext, rows: readonly ParsedRow[]): OpeningLinesResult {
  const lines: OpeningLine[] = [];
  const skipped: SkippedOpeningRow[] = [];

  rows.forEach((row, index) => {
    const ref = rowRef(index);
    const view = tokenView(row);
    const account = (pick(view, ACCOUNT_ALIASES) ?? '').trim();
    if (account === '') return; // no account to post against: dropped, exactly as before.

    // Explicit debit/credit are already minor and read UNCHANGED. They win over a balance column.
    const explicitDebit = Number(pick(view, DEBIT_ALIASES) ?? 0) || 0;
    const explicitCredit = Number(pick(view, CREDIT_ALIASES) ?? 0) || 0;

    let debitMinor: number;
    let creditMinor: number;
    if (explicitDebit !== 0 || explicitCredit !== 0) {
      debitMinor = explicitDebit;
      creditMinor = explicitCredit;
    } else {
      const balanceRaw = pick(view, BALANCE_ALIASES);
      if (balanceRaw === undefined) return; // no debit/credit and no balance: nothing to post (unchanged).
      const split = splitSignedBalance(balanceRaw);
      if (split === 'invalid') {
        skipped.push({ ref, account, reason: 'invalid_balance' });
        return;
      }
      debitMinor = split.debitMinor;
      creditMinor = split.creditMinor;
    }

    if (debitMinor === 0 && creditMinor === 0) return; // a zero position posts nothing (unchanged).

    // Group / non-postable: no phantom line, no silent drop. Recorded and skipped (owner decision).
    if (!accountIsPostable(ctx, account)) {
      skipped.push({ ref, account, reason: 'not_postable' });
      return;
    }

    lines.push({ ref, account, debitMinor, creditMinor });
  });

  return { lines, skipped };
}
