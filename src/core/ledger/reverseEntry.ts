/**
 * A02, `reverseEntry`: the one legal correction (OR 957a).
 *
 * A posted entry is never edited or deleted. It is corrected by posting its faithful mirror: debits
 * and credits swapped, cost centers and the VAT trace carried (the tax base/amount negated), so the
 * target and its reversal net to zero on every account AND cost center AND tax line. Reversal
 * delegates to `postEntry`, so it is the same single posting path, balanced and immutable by
 * construction. An entry is reversed once; a retry with the same key replays the original reversal.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry, VAT_SETTLEMENT_SOURCE, FX_SOURCE } from './postEntry.js';
import type { LineInput } from './postEntry.js';
import { requireString, optionalDate, optionalText } from './inputGuards.js';
import { ACCRUAL_SOURCE, PROVISION_SOURCE } from '../accruals/lines.js';

export interface ReverseEntryInput {
  entryId: string;
  date?: string;
  description?: string;
  idempotencyKey: string;
}

interface OriginalRow {
  id: string;
  status: string;
  source: string;
  date: string;
  description: string | null;
  reverses_entry_id: string | null;
}

/**
 * The sources whose reversal belongs to ONE verb, by name. A `vat_settlement` entry (A38) has a row
 * beside it in `vat_settlement` that must move to `reversed` in the same transaction as the mirror
 * posts; the raw `reverse_entry` tool knows nothing of that row, so reversing the entry through it
 * leaves the row `posted` with no reversal id, after which `vat_settlement_reverse` says
 * `already_reversed` and `vat_settlement_post` says `already_posted`, and the period can never be
 * settled again (critic finding, 2026-09-09). So the raw tool refuses `owned_by {verb}` and only the
 * owning verb, through `reverseOwnedEntry`, reaches the mirror: the same discipline that keeps the
 * source itself off `POST_ENTRY_SOURCES`.
 *
 * A38's other two sources joined the map at the N2 integration, on the same critic's second finding
 * (HIGH, 2026-09-09): reversing B (an accrual's automatic Rückbuchung) through the raw tool returned
 * ok while the `accrual` row stayed `posted`, after which `accrual_reverse` minted a FIFTH entry and
 * 2300 sat at -180'000 across five; reversing a provision's formation returned ok while
 * `provision_get` kept the full balance and `provision_release` stayed admitted. So `accrual` belongs
 * to `accrual_reverse` (the pair's own Rückbuchung is minted under that owner too) and `provision`
 * resolves by ROW: the formation to `provision_reverse`, a release entry (one with a
 * `provision_release` row behind it) to `provision_release_reverse`. A value is either the verb or a
 * resolver over the entry, because one source can carry two shapes.
 *
 * The MIRRORS are owned too. A `source='reversal'` entry inherits the owner of the entry it reverses
 * (walked to the root of the chain), so the raw tool refuses B, D and a release-undo exactly as it
 * refuses A, C, the formation and the release: an owned pair stays a pair.
 *
 * A22's `fx` joined on the same critic's third finding (BLOCKING, 2026-09-10): the revaluation run
 * mints A and its next-period reversal B, and the revert mints the Storno C and its reversal D, all
 * with a run row (`fx_revaluation`) beside them that the raw tool knows nothing of. Reversing B raw
 * returned ok while the row still read `storno_entry_id null`, after which `fx_revaluation_reverse`
 * answered ok too and the open period carried 6949 = +8'000 and 1000 = 952'000 instead of 0 and
 * 960'000. So `fx` belongs to `fx_revaluation_reverse`, and the run mints B and D under that owner.
 *
 * A39 L3 (the lean bank inbox, lean critic C1) added the two money-path sources, each by ROW, and a
 * resolver may now answer `null` (no owner: anyone may reverse it):
 *   - `camt` (an entry booked from a bank line) belongs to `reopen_bank_line` while a live bank-line
 *     decision names it, or once it has a posted reversal (so its Storno cannot be reversed raw); a
 *     legacy camt entry no live decision names and nothing reversed stays reversible (C16a).
 *   - `payment` belongs to `reverse_payment` when a `payment` row names the entry: the raw journal
 *     "Stornieren" of a payment used to leave the payment `posted` and its invoice `settled` beside a
 *     Storno (C1). A `post_entry` with source `payment` and no payment row stays reversible.
 * And for EVERY caller, the owners included, an entry a LIVE bank-line claim holds refuses `owned_by
 * reopen_bank_line` naming the line (`claimHolderOf` below): `reopen_bank_line` supersedes its decision
 * (releasing the claims) before it reverses, so a transfer whose other leg the other account's line
 * still holds refuses there too, naming that line (C5).
 *
 * The governance check of 28.09.2026 added the three document sources, each by ROW, on the same defect
 * the accrual and payment cases had (`test/ledger/document-entry-ownership.test.mjs`):
 *   - `purchase` belongs to `void_vendor_bill` when a `vendor_bill` row names the entry. Measured: the
 *     raw Storno of a posted bill returned ok, the bill still read `posted` with its full amount open,
 *     `list_vendor_bills` answered `reconciled: false`, and `void_vendor_bill` then refused
 *     `already_reversed` for good.
 *   - `invoice` and `credit_note` belong to `transition_document` (its `to: 'cancelled'` edge) when a
 *     `document` row names the entry as its `posted_entry_id`. The raw Storno left the invoice `issued`
 *     with its open item on a 1100 that had netted to zero, and the cancel refused `already_reversed`.
 *     `invoice` stays on `POST_ENTRY_SOURCES`, so an entry no document names stays reversible (C16a's
 *     reasoning for `payment`).
 *   - `asset_depreciation` belongs to `asset_depreciation_run_reverse` and `inventory_valuation` to
 *     `inventory_valuation_reverse`, each when its run row names the entry as `journal_entry_id`
 *     (owner decision, 28.09.2026: the sources with an undo verb join now). Measured: the raw Storno
 *     left the run `posted`, and the run's own reverse then refused `already_reversed` for good, so
 *     the asset kept a depreciation the journal no longer carried and the next valuation measured
 *     against a baseline that was gone.
 *   - `landed_cost` belongs to `landed_cost_reverse` when a voucher names the entry as
 *     `journal_entry_id` (D141 follow-up 2: J04's undo verb existed all along).
 *   - `expense_claim` belongs to `expense_claim_reverse` when a claim names the entry as its
 *     `posted_entry_id` (D168, 14.10.2026, the D141.3 follow-up: E02 gained its undo verb). Measured
 *     before: the raw Storno of an approved claim's posting returned ok, the claim still read
 *     `approved`, and `expense_claim_reimburse` would then have paid a liability 2260 no longer carried.
 *   - `dunning` belongs to `dunning_fee_reverse` when a dunning run names the entry as its
 *     `fee_entry_id` (D169, 14.10.2026, the D141.3 follow-up: A15 gained its fee undo verb). Measured
 *     before: the raw Storno of a run's fee returned ok and nothing knew; an unsent letter still
 *     mailed the fee as demanded.
 *   - `asset_acquisition` and `asset_disposal` belong to `asset_transaction_reverse` when an
 *     acquisition, additional-capitalisation, opening or disposal `asset_transaction` row names the
 *     entry (D170, 14.10.2026, the D141.3 follow-up: the asset register gained its undo verb). Measured
 *     before: the raw Storno of an acquisition returned ok, the asset stayed `active` at full cost, the
 *     OP11 reconciliation drifted by the cost, and depreciation kept charging an asset the GL no longer
 *     carried.
 *   - `import` belongs to `wage_journal_reverse` when a `wage_journal_posts` row names the entry as
 *     its `posted_entry_id` (D171, 14.10.2026, the D141.3 follow-up: A34 gained its undo verb). The
 *     source is shared with the import-sourced openings, which stay raw: ownership is by row only.
 *     Measured before: the raw Storno of a wage journal returned ok and the hand-off history still
 *     listed the posting as standing.
 * The row-backed sources with NO undo verb (the import-sourced openings) are still reversible raw and
 * still strand their row: owning them would leave no way back at all, which is a design call recorded
 * in `docs/critique/governance-dial-and-owned-reversals.md` and D141.3.
 */
export type OwnerResolver = (ctx: WorkspaceContext, entryId: string) => string | null;

/**
 * The bank line whose LIVE claim holds a leg of `entryId`, or null (A39 L3). Exported for the reads that
 * must say so BEFORE a raw Storno is offered (`list_payments`, critic M3 lean).
 */
export function claimHolderOf(ctx: WorkspaceContext, entryId: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT bank_txn_id AS t FROM bank_line_claim WHERE workspace_id = ? AND entry_id = ? AND released_at IS NULL ORDER BY rowid LIMIT 1')
    .get(ctx.workspaceId, entryId) as { t: string } | undefined;
  return row?.t ?? null;
}

/** An invoice's or credit note's entry belongs to the document's own cancel while the document names it. */
function documentOwner(ctx: WorkspaceContext, entryId: string): string | null {
  const doc = ctx.store.db
    .prepare('SELECT 1 AS p FROM document WHERE workspace_id = ? AND posted_entry_id = ? LIMIT 1')
    .get(ctx.workspaceId, entryId);
  return doc !== undefined ? DOCUMENT_REVERSAL_OWNER : null;
}

/** The owner token of a document's entry: the verb whose `to: 'cancelled'` edge reverses it. */
export const DOCUMENT_REVERSAL_OWNER = 'transition_document';

/** The owner token of a vendor bill's purchase entry. */
export const VENDOR_BILL_REVERSAL_OWNER = 'void_vendor_bill';

/** The owner token of an H04 depreciation run's journal. */
export const DEPRECIATION_RUN_REVERSAL_OWNER = 'asset_depreciation_run_reverse';

/** The owner token of a J06 inventory valuation run's journal (an opening run included). */
export const INVENTORY_VALUATION_REVERSAL_OWNER = 'inventory_valuation_reverse';

/** The owner token of a J04 landed-cost voucher's allocation journal (D141 follow-up 2). */
export const LANDED_COST_REVERSAL_OWNER = 'landed_cost_reverse';

/** The owner token of an E02 expense claim's approve posting (D168). */
export const EXPENSE_CLAIM_REVERSAL_OWNER = 'expense_claim_reverse';

/** The owner token of an A15 dunning run's fee entry (D169). */
export const DUNNING_FEE_REVERSAL_OWNER = 'dunning_fee_reverse';

/** The owner token of an H02/H06/H07 asset event's entry (acquisition, capitalisation, opening, disposal; D170). */
export const ASSET_TRANSACTION_REVERSAL_OWNER = 'asset_transaction_reverse';

/** D170: an asset event's entry belongs to the register's undo verb while an ORIGINAL event row names it
 * (a compensating `*_reversal` row names a mirror, which is owned through the walk anyway). */
function assetEventOwner(types: readonly string[]): OwnerResolver {
  return (ctx, entryId) => {
    const row = ctx.store.db
      .prepare(`SELECT 1 AS p FROM asset_transaction WHERE workspace_id = ? AND journal_entry_id = ? AND type IN (${types.map(() => '?').join(', ')}) LIMIT 1`)
      .get(ctx.workspaceId, entryId, ...types);
    return row !== undefined ? ASSET_TRANSACTION_REVERSAL_OWNER : null;
  };
}

/** The owner token of an A34 wage journal posting's entry (D171). */
export const WAGE_JOURNAL_REVERSAL_OWNER = 'wage_journal_reverse';

export const OWNED_REVERSAL_SOURCES: Readonly<Record<string, string | OwnerResolver>> = {
  [VAT_SETTLEMENT_SOURCE]: 'vat_settlement_reverse',
  [ACCRUAL_SOURCE]: 'accrual_reverse',
  [FX_SOURCE]: 'fx_revaluation_reverse',
  [PROVISION_SOURCE]: (ctx, entryId) => {
    const release = ctx.store.db
      .prepare('SELECT id FROM provision_release WHERE workspace_id = ? AND entry_id = ?')
      .get(ctx.workspaceId, entryId) as { id: string } | undefined;
    return release === undefined ? 'provision_reverse' : 'provision_release_reverse';
  },
  camt: (ctx, entryId) => {
    const live = ctx.store.db
      .prepare('SELECT 1 AS p FROM bank_line_decision WHERE workspace_id = ? AND entry_id = ? AND superseded_at IS NULL LIMIT 1')
      .get(ctx.workspaceId, entryId);
    if (live !== undefined) return 'reopen_bank_line';
    // D178 E3 (critic E3-R2-1, D141.3): a VAT clearing of a received Anzahlung (applied to an invoice, or
    // corrected for a refund) is owned by the bank line while the Guthaben's payment stands: reversed alone
    // it would put the tax on 2200 twice. `reopen_bank_line` reverses it with the payment (the payment is
    // reversed first, so this clause no longer holds when the reopen gets to the clearing).
    const clearing = ctx.store.db
      .prepare(
        `SELECT 1 AS p FROM bank_anzahlung_vat_clearing c JOIN payment pay ON pay.workspace_id = c.workspace_id AND pay.id = c.payment_id
          WHERE c.workspace_id = ? AND c.entry_id = ? AND pay.status = 'posted' LIMIT 1`,
      )
      .get(ctx.workspaceId, entryId);
    if (clearing !== undefined) return 'reopen_bank_line';
    const reversed = ctx.store.db
      .prepare("SELECT 1 AS p FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted' LIMIT 1")
      .get(ctx.workspaceId, entryId);
    return reversed !== undefined ? 'reopen_bank_line' : null;
  },
  purchase: (ctx, entryId) => {
    const bill = ctx.store.db
      .prepare('SELECT 1 AS p FROM vendor_bill WHERE workspace_id = ? AND entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return bill !== undefined ? VENDOR_BILL_REVERSAL_OWNER : null;
  },
  invoice: documentOwner,
  credit_note: documentOwner,
  asset_depreciation: (ctx, entryId) => {
    const run = ctx.store.db
      .prepare('SELECT 1 AS p FROM asset_depreciation_run WHERE workspace_id = ? AND journal_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return run !== undefined ? DEPRECIATION_RUN_REVERSAL_OWNER : null;
  },
  inventory_valuation: (ctx, entryId) => {
    const run = ctx.store.db
      .prepare('SELECT 1 AS p FROM inventory_valuation_run WHERE workspace_id = ? AND journal_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return run !== undefined ? INVENTORY_VALUATION_REVERSAL_OWNER : null;
  },
  // D141 follow-up 2: the row-backed source that had an undo verb all along. A raw Storno left the voucher
  // `allocated` and its receipt layers carrying a capitalised cost the GL no longer did.
  landed_cost: (ctx, entryId) => {
    const voucher = ctx.store.db
      .prepare('SELECT 1 AS p FROM landed_cost_voucher WHERE workspace_id = ? AND journal_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return voucher !== undefined ? LANDED_COST_REVERSAL_OWNER : null;
  },
  // D168: by ROW. A claim names its approve posting as `posted_entry_id`; an `expense_claim` entry no
  // claim names stays reversible raw (C16a's reasoning for `payment`).
  expense_claim: (ctx, entryId) => {
    const claim = ctx.store.db
      .prepare('SELECT 1 AS p FROM expense_claim WHERE workspace_id = ? AND posted_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return claim !== undefined ? EXPENSE_CLAIM_REVERSAL_OWNER : null;
  },
  // D169: by ROW. A run names its fee posting as `fee_entry_id`; a `dunning` entry no run names stays
  // reversible raw (C16a's reasoning for `payment`). The key is A15's `DUNNING_SOURCE`, spelled out
  // because importing it from the dunning module would close an import cycle through A02.
  dunning: (ctx, entryId) => {
    const run = ctx.store.db
      .prepare('SELECT 1 AS p FROM dunning_run WHERE workspace_id = ? AND fee_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return run !== undefined ? DUNNING_FEE_REVERSAL_OWNER : null;
  },
  // D170: by ROW. An `asset_acquisition` entry (acquisition, capitalisation or opening) or an
  // `asset_disposal` entry no event row names stays reversible raw (C16a's reasoning for `payment`).
  asset_acquisition: assetEventOwner(['acquisition', 'additional_capitalisation', 'opening']),
  asset_disposal: assetEventOwner(['disposal']),
  // D171: by ROW, never by source. `import` is shared: A04's opening balances and the migration openings
  // post it too, and those stay reversible raw (their own undo is `migration_rollback_step`). Only an
  // entry a `wage_journal_posts` row names belongs to `wage_journal_reverse`; the key is A34's
  // `WAGE_JOURNAL_SOURCE`, spelled out because importing it from the payroll module would close an
  // import cycle through A02.
  import: (ctx, entryId) => {
    const posting = ctx.store.db
      .prepare('SELECT 1 AS p FROM wage_journal_posts WHERE workspace_id = ? AND posted_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return posting !== undefined ? WAGE_JOURNAL_REVERSAL_OWNER : null;
  },
  payment: (ctx, entryId) => {
    const payment = ctx.store.db
      .prepare('SELECT 1 AS p FROM payment WHERE workspace_id = ? AND journal_entry_id = ? LIMIT 1')
      .get(ctx.workspaceId, entryId);
    return payment !== undefined ? 'reverse_payment' : null;
  },
};

const ORIGINAL_SQL = 'SELECT id, status, source, date, description, reverses_entry_id FROM journal_entry WHERE workspace_id = ? AND id = ?';

/** The chain of mirrors is short by construction (A, B; C, D; release, undo); the bound is a guard, not a limit. */
const MAX_MIRROR_HOPS = 8;

/**
 * Who owns the reversal of `original`, or null when anyone may reverse it. A mirror is resolved
 * through what it mirrors: a `reversal` of an owned entry is owned by the same verb.
 */
function ownerOf(ctx: WorkspaceContext, original: OriginalRow): { verb: string; ownedEntryId: string; source: string } | null {
  let row = original;
  for (let hops = 0; row.source === 'reversal' && row.reverses_entry_id !== null && hops < MAX_MIRROR_HOPS; hops += 1) {
    const parent = ctx.store.db.prepare(ORIGINAL_SQL).get(ctx.workspaceId, row.reverses_entry_id) as OriginalRow | undefined;
    if (parent === undefined) break;
    row = parent;
  }
  const rule = OWNED_REVERSAL_SOURCES[row.source];
  if (rule === undefined) return null;
  const verb = typeof rule === 'string' ? rule : rule(ctx, row.id);
  return verb === null ? null : { verb, ownedEntryId: row.id, source: row.source };
}

interface ReversalRow {
  id: string;
  idempotency_key: string | null;
}

interface OriginalLineRow {
  account_id: string;
  cost_center_id: string | null;
  debit_minor: number;
  credit_minor: number;
  base_debit_minor: number;
  base_credit_minor: number;
  currency: string;
  fx_rate: string | null;
  tax_code: string | null;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
  supply_date: string | null;
}

/**
 * What a successful reversal sends back: the id of the MIRROR entry, never the target's.
 *
 * The name matters more here than almost anywhere else in A02, which is why it is declared. Both
 * success paths answer with `reversalId` (a fresh reversal, and an idempotent replay of one), and so
 * does the `already_reversed` rejection. A consumer that read `entryId` here, the name the two
 * neighbouring verbs use, would have got `unknown` from the open `Result` and `undefined` on screen.
 */
export type ReverseEntryOk = {
  /** The id of the reversing entry now posted. Stable across an idempotent retry of the same key. */
  readonly reversalId: string;
};

/** The reversal every caller reaches, the `reverse_entry` tool included: an owned source is refused. */
export function reverseEntry(ctx: WorkspaceContext, input: ReverseEntryInput): Result<ReverseEntryOk> {
  return reverse(ctx, input, null);
}

/**
 * The reversal an OWNING verb performs on its own source. Not registered as a tool, not reachable
 * through one, and not on the ledger index (the P3 guard pins that list): an owning verb imports it
 * by module path. `owner` is a code-level argument, never an input field, so it cannot be forged over
 * the MCP or REST boundary.
 */
export function reverseOwnedEntry(ctx: WorkspaceContext, input: ReverseEntryInput, owner: string): Result<ReverseEntryOk> {
  return reverse(ctx, input, owner);
}

/**
 * The scopes an ENGINE-INTERNAL composite reverses an entry under (K1, 04.10.2026), the reversal twin of
 * `postEntryInternal`. A reversal's identity is `(target, key)`, so a composite that reverses an entry
 * the public `reverse_entry` can also reach, under a key DERIVED from its own (`migrollback:<step>:<key>`),
 * could be pre-empted: a caller reversed the same entry first under that key (at a date of its own
 * choosing) and the composite replayed it as its own reversal. Under an internal scope the identity is
 * `(scope, target, key)`, a shape no public call can produce. A closed literal union, never an input field.
 */
export const K1_INTERNAL_REVERSE_SCOPES = ['migration_rollback_step_internal'] as const;
export type InternalReverseScope = (typeof K1_INTERNAL_REVERSE_SCOPES)[number];

/** `reverseEntry` under an engine-internal scope. Not on any wire and not on the ledger index. */
export function reverseEntryInternal(ctx: WorkspaceContext, input: ReverseEntryInput, scope: InternalReverseScope): Result<ReverseEntryOk> {
  return reverse(ctx, input, null, scope);
}

function reverse(ctx: WorkspaceContext, input: ReverseEntryInput, owner: string | null, scope: InternalReverseScope | null = null): Result<ReverseEntryOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.entryId, 'entryId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalDate(input.date, 'date') ??
    optionalText(input.description, 'description');
  if (guard) return guard;

  const original = ctx.store.db.prepare(ORIGINAL_SQL).get(ctx.workspaceId, input.entryId) as OriginalRow | undefined;
  if (original === undefined) {
    return err('not_found', { entryId: input.entryId });
  }
  if (original.status !== 'posted') {
    return err('not_posted', { entryId: input.entryId });
  }
  // A39 L3: a leg a live bank-line decision holds is released only by that line's own undo, for EVERY
  // caller (the owning verbs too): the Storno would otherwise leave the line reading booked or matched
  // on money that is gone.
  const holder = claimHolderOf(ctx, input.entryId);
  if (holder !== null) {
    return err('owned_by', {
      verb: 'reopen_bank_line',
      bankTxnId: holder,
      entryId: input.entryId,
      source: original.source,
      ownedEntryId: input.entryId,
      ownedSource: original.source,
    });
  }
  const owned = ownerOf(ctx, original);
  if (owned !== null && owner !== owned.verb) {
    return err('owned_by', { verb: owned.verb, entryId: input.entryId, source: original.source, ownedEntryId: owned.ownedEntryId, ownedSource: owned.source });
  }

  // The reversal's idempotency identity is (this target, this key). Folding the target into the key
  // keeps two reversals of DIFFERENT entries that happen to share a client key from colliding in the
  // shared reverse_entry namespace (which would make the second a silent no-op returning the wrong
  // reversal). JSON-encoding the pair is an injective, delimiter-safe encoding of (target, key).
  const scopedKey = JSON.stringify(scope === null ? [input.entryId, input.idempotencyKey] : [scope, input.entryId, input.idempotencyKey]);

  // An entry is reversed at most once. If a reversal already exists and it carries this same scoped
  // key, the caller is retrying, so replay it; otherwise the entry is genuinely already reversed.
  const existing = ctx.store.db
    .prepare('SELECT id, idempotency_key FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?')
    .get(ctx.workspaceId, input.entryId) as ReversalRow | undefined;
  if (existing !== undefined) {
    if (existing.idempotency_key === scopedKey) {
      return ok({ reversalId: existing.id });
    }
    return err('already_reversed', { reversalId: existing.id });
  }

  const originalLines = ctx.store.db
    .prepare(
      'SELECT account_id, cost_center_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor, currency, fx_rate, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ?',
    )
    .all(input.entryId) as OriginalLineRow[];

  const mirror: LineInput[] = originalLines.map((line) => {
    const m: LineInput =
      line.debit_minor > 0
        ? { account: line.account_id, credit: line.debit_minor }
        : { account: line.account_id, debit: line.credit_minor };
    // §H-FX (A13 §4b.2, shape S7): a FOREIGN entry's mirror RESTATES the stored base amounts
    // verbatim, on the other side, through the stated-base seam. For every entry whose bases came
    // from the side-total allocation this is bit-identical to re-allocating (the mirror's side
    // totals and line order match, so `allocateBase` reproduces the same figures); for an entry
    // that STATED its bases (a partial credit note's released-base slices) it is the only correct
    // answer: a cancelled partial must give back exactly the base slice it took, and a fresh
    // allocation would give back a different one. A base-currency entry states nothing, exactly as
    // before, so the pre-A13 write path is untouched byte for byte.
    if (line.fx_rate !== null) {
      m.baseAmountMinor = line.debit_minor > 0 ? line.base_debit_minor : line.base_credit_minor;
    }
    if (line.cost_center_id !== null) m.costCenter = line.cost_center_id;
    if (line.tax_code !== null) {
      m.taxCode = line.tax_code;
      if (line.tax_base_minor !== null) m.taxBase = -line.tax_base_minor;
      if (line.tax_amount_minor !== null) m.taxAmount = -line.tax_amount_minor;
      // The Leistungsdatum is carried EXPLICITLY, for the same reason the original's FX rate is
      // (see below) and not merely for tidiness: it selects the ESTV Ziffer VINTAGE. A December
      // 2023 supply reversed in 2026 must credit back the Ziffer it was declared on (302), not
      // today's (303). Reversed without it, the target and its mirror land on DIFFERENT form lines
      // and neither cancels, while every account and the 2200 reconciliation still net to zero.
      if (line.supply_date !== null) m.supplyDate = line.supply_date;
    }
    return m;
  });

  // A reversal is dated today (OR 957a: correct in the open period), not the original date, unless the
  // caller chooses a date. Description carries the original's, locale-neutral (P11); the GUI renders
  // the localized "Storno" treatment from the reversal glyph and cross-link.
  const description = input.description ?? original.description ?? undefined;

  // §H-FX: the mirror carries the ORIGINAL's currency and rate, passed EXPLICITLY rather than looked
  // up. Two reasons, both load-bearing. A reversal must undo the CHF the books actually carry, and
  // today's rate would undo a different number. And a correction must never be blocked by a rate
  // that has gone stale or was never recorded for the correction's date: an entry you cannot reverse
  // is an entry you can only fix by editing, which §H-AUDIT forbids.
  const first = originalLines[0];
  const currency = first?.currency ?? undefined;
  const fxRate = first?.fx_rate ?? undefined;

  const posted = postEntry(ctx, {
    date: input.date ?? ctx.clock.now().slice(0, 10),
    source: 'reversal',
    reversesEntryId: input.entryId,
    idempotencyKey: scopedKey,
    lines: mirror,
    ...(description !== undefined ? { description } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(fxRate !== undefined && fxRate !== null ? { fxRate } : {}),
  });
  if (!posted.ok) return posted;
  return ok({ reversalId: posted.entryId });
}
