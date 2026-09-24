/**
 * A04, opening balances: the position a book starts from.
 *
 * A Swiss business rarely adopts a ledger on 1 January of year one with a zero balance sheet. It
 * switches mid-year, or migrates with balances already on the books, and without a seeded opening
 * position every statement above this (A08) and every return (A07) is wrong from the first day.
 *
 * NO SECOND POSTING PATH (P3). `setOpeningBalances` builds lines and hands them to A02 `postEntry`,
 * which is what makes the opening entry balanced (§H-LEDGER), immutable once posted (§H-AUDIT),
 * idempotent (§H-IDEMPOTENT), period-aware (§H-PERIOD) and capability-gated (A24). A04 mints NO
 * capability check and NO lock check of its own: those rejections ride out of `postEntry` unchanged,
 * because re-coding a condition here would give it two names on two surfaces.
 *
 * THE DIFFERENCE IS NEVER SILENTLY PLUGGED, and that is a statutory position rather than a taste.
 * OR Art. 958c Abs. 1 Ziff. 2 requires the Rechnungslegung to be `vollständig`, and Abs. 2 requires
 * the Bestand of each Bilanz position to be evidenced `durch ein Inventar oder auf andere Art`. A
 * delta absorbed into a clearing account behind a green tick is exactly the shape that satisfies a
 * balance check while failing both. So an unbalanced set is REFUSED with its signed Rappen
 * difference, and the caller books the delta only by naming a clarification account explicitly.
 *
 * WHAT THE BALANCE CHECK CANNOT DETECT, stated plainly rather than sold as reconciliation: it
 * compares Sigma debit against Sigma credit and nothing else. A set that balances is not a set that
 * is RIGHT. Two accounts transposed, a whole position missing from both sides, a figure short by the
 * same amount on each side, or a debit that belongs on the credit side of a different account all
 * balance perfectly. Only the source document reconciles those, which is why `import_opening_balances`
 * reports its per-account lines and its unmapped rows to the caller instead of announcing a
 * successful reconciliation. A verb that summed its own output and called the agreement a check
 * would be A07's `reconciled: true` again.
 *
 * 9100 Eröffnungsbilanz is NOT in A01's shipped KMU seed and this capability does not add it. A19
 * already resolves it by number and answers `needs_account` when it is missing; A04 resolves any
 * caller-named clarification account the same way and answers `unknown_account`. An account invented
 * on the fly would be a chart entry no Treuhänder agreed to.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, optionalText } from './inputGuards.js';
import { postEntry } from './postEntry.js';
import type { LineInput } from './postEntry.js';
import { fiscalYearOf } from './periods.js';
import { baseCurrencyOf } from '../fx/rates.js';

/**
 * KMU 9100 Eröffnungsbilanz, the classic clearing account for an opening position.
 *
 * It is a RECOMMENDATION and never a default: `setOpeningBalances` names it in the `unbalanced`
 * rejection so a caller is not left guessing at the way out, and books against it only when the
 * caller passes it as `differenceAccount`. Same number and same absence from the seed as A19's
 * `OPENING_BALANCE_ACCOUNT_NUMBER`, deliberately: both capabilities book an Eröffnungsbilanz and
 * two different clearing accounts would split one position across two lines of equity.
 */
export const OPENING_CONTRA_ACCOUNT_NUMBER = '9100';

/**
 * The idempotency-key namespace that MARKS an entry as the workspace's opening position.
 *
 * `journal_entry` has no column for "this is the opening entry" and A04 adds none (the schema is
 * shared money-path territory). The source alone cannot carry the marker: A19's bank opening balance
 * posts `source='import'` too, and keying on the source would make A19's entry read as the
 * workspace's opening position and then refuse the real one. So the marker is this prefix on the key
 * A04 hands `postEntry`, which is unique per workspace by the same index that makes the post
 * idempotent.
 *
 * WHAT ACTUALLY KEEPS A19 OUT IS THE `:<year>:` SEGMENT, NOT THIS STRING, and the difference matters
 * because the old wording credited the prefix ("which A19's own `bank-opening:` prefix cannot collide
 * with in either direction") for safety it does not provide. A04 matches
 * `opening-balances:<year>:%`; A19 writes `bank-opening:<bankAccountId>:%`. Renaming this constant to
 * `bank-opening` outright, so the two prefixes are IDENTICAL, still does not let A19's entry be read
 * as the opening position, because a bank account id is never a four-digit year. Measured: the whole
 * suite stays green through that rename apart from one test that hardcodes the literal key.
 *
 * So the prefix is legibility, and the year segment is the discriminator. The test below pins the
 * segment rather than the string, because pinning the string would assert the wrong property.
 *
 * WHAT THIS COSTS, said out loud and CORRECTED, because the first version of this paragraph had it
 * exactly backwards. The marker is a string convention, not a constraint. A caller with direct
 * `post_entry` access can mint an entry under this prefix by hand, and it would then read as the
 * opening position. That is not a privilege boundary: such a caller already has `post` and can book
 * anything.
 *
 * The claim that used to sit here, that `get_opening_balances` therefore "reports what the ledger
 * holds rather than what only this verb wrote", was FALSE, and measurement said so: the entry branch
 * renders the marked ENTRY's own lines and nothing else. With A19 having opened the same bank account
 * for CHF 5'000.00 and A04 for CHF 12'500.00, the verb reported 12'500.00 while the ledger held
 * 17'500.00. The read is scoped to the opening entry BY DESIGN, since a net-of-everything read would
 * sweep in ordinary transactions that merely share the opening date, but that is the opposite of
 * reporting the ledger and the comment may not claim both.
 *
 * The double-count itself is now refused on the WRITE side (`account_already_has_balance`), which is
 * where it can still be prevented rather than merely described.
 */
export const OPENING_KEY_PREFIX = 'opening-balances';

/** One account's opening position. Exactly one side, positive integer Rappen (P2), or 0.00 for none. */
export interface OpeningLineInput {
  /** The account, by id or by number. Resolved id-first; both are refused if the chart has neither. */
  account: string;
  debitMinor?: number;
  creditMinor?: number;
}

export interface SetOpeningBalancesInput {
  /** The adoption date. Defaults to the start of the fiscal year the clock is in. */
  asOf?: string;
  lines: OpeningLineInput[];
  /** The clarification account an explicit difference is booked to, by id or number. */
  differenceAccount?: string;
  /** The Beleg this position is traced to (OR 957a Abs. 2 Ziff. 2 Belegnachweis). Stored as `ref`. */
  reference?: string;
  description?: string;
  idempotencyKey: string;
}

/** A refused post, carried out of the idempotency transaction so the caller's key never burns. */
class OpeningPostFailure {
  constructor(readonly result: Result) {}
}

/** The fiscal-year start `MM-DD` of this workspace, A00's setting, defaulting the way A03 defaults it. */
function fiscalYearStartOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/** The calendar day before an ISO `YYYY-MM-DD`. Pure date arithmetic, the same helper A03 uses. */
function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: string;
}

/**
 * Resolve an account within THIS workspace, by id first and then by number.
 *
 * The `workspace_id` fence here is load-bearing and is the one §H-TENANT depends on: without it the
 * id branch would resolve a neighbouring workspace's account outright, and the number branch would
 * degenerate to "the first workspace in the file that happens to have a 1020". The A04 tenant test
 * mints the neighbour FIRST precisely so the second failure mode is visible rather than masked.
 *
 * Accepting BOTH spellings is deliberate: `postEntry` takes ids, a migration CSV carries numbers, and
 * the Studio grid renders numbers. Making every caller pre-resolve would push a chart lookup into
 * each of them, and a caller that got it wrong would post against the wrong account silently.
 */
function resolveAccount(ctx: WorkspaceContext, account: string): AccountRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT id, number, name, type FROM account WHERE workspace_id = ? AND (id = ? OR number = ?) ORDER BY (id = ?) DESC LIMIT 1',
    )
    .get(ctx.workspaceId, account, account, account) as AccountRow | undefined;
}

/**
 * Does `account` (id OR number) name a postable account in THIS workspace's chart? The ONE definition
 * of "postable", shared so the migration layer's group-row skip (G18) uses exactly the same §H-TENANT
 * resolution the poster does: a bexio Bilanz group subtotal has no postable account, so it resolves to
 * false and the import skips it instead of inventing a chart entry no Treuhänder agreed to.
 */
export function accountIsPostable(ctx: WorkspaceContext, account: string): boolean {
  return resolveAccount(ctx, account) !== undefined;
}

/** Does this workspace have a chart at all? P9: the CTA is A01, not a per-account complaint. */
function hasChart(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT 1 AS present FROM account WHERE workspace_id = ? LIMIT 1')
    .get(ctx.workspaceId) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Is this posted entry still STANDING on the accounts, or has a storno cancelled it?
 *
 * "Reversed" is NOT "a reversal row exists", and the difference is a money defect rather than a
 * nicety. A02 lets a reversal itself be reversed, and it should: that is how an operator un-does a
 * storno booked in error. In `entry_1 <- entry_2 <- entry_3` the last two net to zero on every
 * account, so entry_1's amounts are back on the books and the position is LIVE again. Measured, not
 * reasoned about: after the double storno, 1020 reads 1'250'000 once more.
 *
 * So the question is reversal DEPTH. An even chain (0, 2, 4 ...) leaves the entry standing; an odd
 * one cancels it. A predicate that merely asked whether a reversal existed would call the revived
 * position dead, let `setOpeningBalances` stack a SECOND opening entry on top of a live one, and
 * double-count every account in it, which is the exact shape this capability exists to prevent.
 *
 * THE WALK TERMINATES by construction and needs no iteration cap: `postEntry` refuses a second
 * reversal of the same target (`already_reversed`), so the chain is linear rather than branching, and
 * a reversal can only name a target that was already posted when it was written, so the chain runs
 * strictly backwards through creation order and cannot close a cycle.
 *
 * The `workspace_id` fence here is NAMED, NOT CLAIMED. `entryId` only ever arrives from a query that
 * is already fenced, and `reverses_entry_id` references a globally unique entry id, so no foreign row
 * can match. Measured: neutralising it fails nothing in the whole suite. It is here so the query does
 * not rely on its caller for tenancy, and it is not offered as a guard any mutation can redden.
 *
 * The `status = 'posted'` filter is deliberate but is NOT claimed as a guard a mutation can redden:
 * no shipped path can write a non-posted row carrying `reverses_entry_id`, because `saveDraft`
 * hard-codes that column NULL and `postEntry` sets it only inside the transaction that flips the row
 * to posted. Measured on the fixtures: zero such rows. It is there so that a future draft-reversal
 * path cannot silently make a pending storno cancel a live position.
 */
function isLive(ctx: WorkspaceContext, entryId: string): boolean {
  const nextReversal = ctx.store.db.prepare(
    "SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted'",
  );
  let current = entryId;
  let depth = 0;
  for (;;) {
    const row = nextReversal.get(ctx.workspaceId, current) as { id: string } | undefined;
    if (row === undefined) return depth % 2 === 0;
    current = row.id;
    depth += 1;
  }
}

/**
 * The entry holding this fiscal year's opening position, or `undefined`. §H-TENANT fence is real.
 *
 * NEWEST FIRST, and reversed entries skipped. Both halves matter. Skipping the reversed ones is what
 * makes the remedy that `opening_balance_already_set` prescribes (a storno plus a fresh import under
 * a new key) actually reachable: an entry stays `posted` after it is reversed, correctly, because the
 * ledger is append-only, so matching on `status` alone matched a dead position forever. Ordering
 * newest-first is what makes this "the CURRENT position" rather than "the first one ever seeded": a
 * corrected position is by definition the later one.
 *
 * Through A04's own verbs at most one candidate is ever live, because this same predicate guards the
 * write. More than one can exist only via a hand-minted `post_entry` under this key prefix, the cost
 * the `OPENING_KEY_PREFIX` docblock states out loud, and there the newest is the caller's latest word.
 */
function existingOpeningEntry(
  ctx: WorkspaceContext,
  year: string,
): { id: string; date: string; ref: string | null } | undefined {
  const candidates = ctx.store.db
    .prepare(
      `SELECT id, date, ref FROM journal_entry
        WHERE workspace_id = ? AND status = 'posted' AND source = 'import'
          AND idempotency_key LIKE ?
        ORDER BY date DESC, id DESC`,
    )
    .all(ctx.workspaceId, `${OPENING_KEY_PREFIX}:${year}:%`) as {
    id: string;
    date: string;
    ref: string | null;
  }[];
  return candidates.find((candidate) => isLive(ctx, candidate.id));
}

/** Is fiscal year N sealed by A03's year-close? That is what makes N+1's position a carried one. */
function isYearSealed(ctx: WorkspaceContext, year: string): boolean {
  const row = ctx.store.db
    .prepare(
      "SELECT 1 AS sealed FROM period_lock WHERE workspace_id = ? AND period = ? AND kind = 'hard' AND reason = 'year_close'",
    )
    .get(ctx.workspaceId, year) as { sealed: number } | undefined;
  return row !== undefined;
}

interface OccupiedAccountRow {
  number: string;
  balanceMinor: number;
}

/**
 * Accounts in the caller's OWN set that already carry a balance on the opening date.
 *
 * A line in an opening set asserts "this account starts at X". If the account already holds
 * something as of that date, posting the line does not state the position, it ADDS to one, and the
 * book ends up carrying both. Measured on the two documented onboarding paths: A19
 * `set_bank_opening_balance` for CHF 5'000.00 followed by A04 for CHF 12'500.00 left 1020 holding
 * 17'500.00 while the read model reported 12'500.00, with a phantom 9100 leg nobody asked for.
 *
 * DELIBERATELY NOT A19-AWARE. The predicate asks the ledger what an account holds, so it catches
 * A19's bank opening, a hand-minted `post_entry`, and anything a later capability books against the
 * same account, without A04 having to know that any of them exist. Teaching A04 to recognise A19's
 * key prefix would couple two capabilities and still miss the third.
 *
 * The CLARIFICATION account is not passed in here, and that exemption is the point rather than an
 * oversight: 9100 Eröffnungsbilanz is a clearing account that is meant to accumulate (A19 credits it
 * too), and it asserts no opening position of its own. Refusing on it would break the documented
 * `differenceAccount` way out for every workspace where A19 happened to run first.
 *
 * A DATE WINDOW ALONE IS THE WRONG INSTRUMENT, and the storno path is what proves it. `reverseEntry`
 * dates a correction TODAY rather than on the original's date, so a plain `date <= asOf` sum sees an
 * opening entry booked on 1 January and NOT the storno that cancelled it in July. It would then
 * refuse the very re-seed the correction exists to enable, which is the F1 defect wearing a different
 * hat. So liveness decides, not the calendar: reversal rows are skipped outright
 * (`reverses_entry_id IS NULL`) and every candidate is run through `isLive`, which nets a cancelled
 * entry to nothing whatever date its storno carries and correctly revives a double-reversed one.
 *
 * The `e.workspace_id` fence here is NAMED, NOT CLAIMED, for the same reason as `isLive`'s: the
 * `l.account_id IN (...)` filter already carries ids resolved inside this workspace, and another
 * tenant's lines reference their own account ids, so no foreign row can match. Measured:
 * neutralising it fails nothing in the whole suite.
 */
function accountsAlreadyHoldingBalance(
  ctx: WorkspaceContext,
  accountIds: string[],
  asOf: string,
): OccupiedAccountRow[] {
  if (accountIds.length === 0) return [];
  const placeholders = accountIds.map(() => '?').join(', ');
  const rows = ctx.store.db
    .prepare(
      `SELECT e.id AS entryId, a.number AS number,
              SUM(l.base_debit_minor - l.base_credit_minor) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date <= ?
          AND e.reverses_entry_id IS NULL
          AND l.account_id IN (${placeholders})
        GROUP BY e.id, a.id
        ORDER BY a.number`,
    )
    .all(ctx.workspaceId, asOf, ...accountIds) as { entryId: string; number: string; net: number }[];

  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!isLive(ctx, row.entryId)) continue;
    totals.set(row.number, (totals.get(row.number) ?? 0) + row.net);
  }
  return [...totals]
    .filter(([, balanceMinor]) => balanceMinor !== 0)
    .map(([number, balanceMinor]) => ({ number, balanceMinor }));
}

/**
 * The fiscal years up to and including `throughYear` that carry postings but were never closed.
 *
 * This is the diagnosis that turns `carried_position_unbalanced` from a complaint into an
 * instruction: an unclosed prior year leaves its result on Erfolgsrechnung accounts, which a balance
 * sheet does not carry, and that residue is the gap. Bounded by walking from the first posted entry's
 * fiscal year rather than by reading every entry's date, so a long ledger costs one MIN and one
 * `period_lock` probe per year.
 */
function unclosedYearsThrough(ctx: WorkspaceContext, throughYear: string, fyStart: string): string[] {
  const first = ctx.store.db
    .prepare("SELECT MIN(date) AS first FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(ctx.workspaceId) as { first: string | null } | undefined;
  if (first === undefined || first.first === null) return [];
  const years: string[] = [];
  for (let y = Number(fiscalYearOf(first.first, fyStart)); y <= Number(throughYear); y += 1) {
    if (!isYearSealed(ctx, String(y))) years.push(String(y));
  }
  return years;
}

interface PreparedOpening {
  lines: LineInput[];
  debitMinor: number;
  creditMinor: number;
  differenceMinor: number;
}

/**
 * Validate and resolve the caller's set into posting lines, without touching the difference yet.
 *
 * A 0.00 row is SKIPPED rather than refused: an account with no opening position is not a position,
 * and a grid that renders every account in the chart would otherwise be unusable. A row with both
 * sides set, a negative, or a fraction of a Rappen is refused, because each of those is a caller
 * meaning something the ledger cannot represent.
 *
 * An account named TWICE is refused (`duplicate_account`) on the RESOLVED account, so naming 1020
 * once by id and once by number is caught too. OR Art. 958c Abs. 1 Ziff. 7 forbids offsetting
 * Aktiven against Passiven, and two rows for one account mean the caller either double-counted or
 * pre-netted: summing them here would make the books show a position the Beleg does not.
 */
function prepareLines(
  ctx: WorkspaceContext,
  input: SetOpeningBalancesInput,
): { ok: true; prepared: PreparedOpening } | { ok: false; error: Result } {
  const lines: LineInput[] = [];
  const seen = new Map<string, string>();
  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const line of input.lines) {
    if (typeof line !== 'object' || line === null || typeof line.account !== 'string' || line.account.length === 0) {
      return { ok: false, error: err('invalid_line', { reason: 'each line names an account' }) };
    }
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    for (const [side, value] of [['debitMinor', debit], ['creditMinor', credit]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        return {
          ok: false,
          error: err('invalid_line', { account: line.account, field: side, reason: 'integer Rappen, not negative' }),
        };
      }
    }
    if (debit > 0 && credit > 0) {
      return {
        ok: false,
        error: err('invalid_line', {
          account: line.account,
          reason: 'an opening position is one side, never both',
        }),
      };
    }

    const resolved = resolveAccount(ctx, line.account);
    if (resolved === undefined) return { ok: false, error: err('unknown_account', { account: line.account }) };
    if (seen.has(resolved.id)) {
      return { ok: false, error: err('duplicate_account', { account: line.account, number: resolved.number }) };
    }
    seen.set(resolved.id, resolved.number);

    // 0.00 on both sides: the caller listed the account and left it empty. Nothing to post.
    if (debit === 0 && credit === 0) continue;

    debitTotal += BigInt(debit);
    creditTotal += BigInt(credit);
    lines.push(debit > 0 ? { account: resolved.id, debit } : { account: resolved.id, credit });
  }

  return {
    ok: true,
    prepared: {
      lines,
      debitMinor: Number(debitTotal),
      creditMinor: Number(creditTotal),
      differenceMinor: Number(debitTotal - creditTotal),
    },
  };
}

/**
 * Seed the workspace's opening position as ONE balanced, posted, immutable, idempotent entry.
 *
 * The sign discipline is the part worth reading twice. `differenceMinor` is Sigma debit MINUS Sigma
 * credit, so it is positive when the set is debit-heavy. A debit-heavy set needs MORE CREDIT to
 * balance, so the clarification line is a CREDIT of that magnitude, and the mirror holds. Taking the
 * absolute value anywhere in here would put both cases on the same side while every total still tied
 * out, which is precisely the class of defect that survives a total-level check.
 */
export function setOpeningBalances(ctx: WorkspaceContext, input: SetOpeningBalancesInput): Result {
  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.reference, 'reference') ??
    optionalText(input.description, 'description');
  if (guard) return guard;
  if (input.asOf !== undefined && (typeof input.asOf !== 'string' || !ISO_DATE.test(input.asOf))) {
    return err('invalid_input', { field: 'asOf' });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return err('invalid_input', { field: 'lines', reason: 'an opening position has at least one line' });
  }
  // P9: an unseeded chart is one answer with one CTA (A01), not a complaint about the first account.
  if (!hasChart(ctx)) return err('needs_chart', { reason: 'seed the chart of accounts first' });

  const fyStart = fiscalYearStartOf(ctx);
  const asOf = input.asOf ?? `${fiscalYearOf(ctx.clock.now().slice(0, 10), fyStart)}-${fyStart}`;
  const year = fiscalYearOf(asOf, fyStart);

  // §H-IDEMPOTENT before the state-dependent guards, the order `postEntry` and `createAccount` use:
  // a retry of the exact same call must replay its ORIGINAL result, never meet `already_set`.
  //
  // The replay is memoised under this verb's OWN scope rather than rebuilt from the entry, because
  // the conformance gate requires the second call to return a byte-identical Result and a
  // hand-reconstructed one drifts from the first the moment a field is added here. It did: the first
  // version of this returned a short `{entryId, asOf, year, differenceMinor, replayed}` and the gate
  // caught the mismatch. `postEntry` keeps its own memo under the namespaced key below, so there are
  // two rows and each replays its own layer.
  const entryKey = `${OPENING_KEY_PREFIX}:${year}:${input.idempotencyKey}`;
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'set_opening_balances');
  if (replayed !== undefined) return replayed;

  // US-A04.4 boundary: A03 owns the close and the retained-earnings posting, A04 only surfaces what
  // it produced. Once the prior year is sealed, this year's position IS the carried one, and posting
  // a second opening entry on top would book the prior year's result twice in two equity lines.
  const priorYear = String(Number(year) - 1);
  if (isYearSealed(ctx, priorYear)) {
    return err('carried_forward', {
      year,
      carriedFromYear: priorYear,
      reason: 'the prior year is closed, so this year opens on the carried balance sheet',
    });
  }

  const existing = existingOpeningEntry(ctx, year);
  if (existing !== undefined) {
    return err('opening_balance_already_set', {
      entryId: existing.id,
      year,
      asOf: existing.date,
      reason: 'a correction is a reversing entry plus a fresh import under a new key, never an edit',
    });
  }

  const prep = prepareLines(ctx, input);
  if (!prep.ok) return prep.error;
  const { lines, debitMinor, creditMinor, differenceMinor } = prep.prepared;

  // Checked BEFORE the clarification line is pushed, which is what exempts the difference account.
  // A storno composes correctly with this: a reversed position nets to zero on every account, so
  // re-seeding after a correction is not blocked by the entry that was corrected.
  const occupied = accountsAlreadyHoldingBalance(ctx, lines.map((line) => line.account), asOf);
  if (occupied.length > 0) {
    return err('account_already_has_balance', {
      asOf,
      accounts: occupied,
      reason:
        'seeding an opening position onto an account that already carries a balance on that date would double-count it: reverse the entry that put it there (a bank opening balance from A19 is the usual one) or leave the account out of this set',
    });
  }

  if (differenceMinor !== 0) {
    if (input.differenceAccount === undefined) {
      return err('unbalanced', {
        differenceMinor,
        debitMinor,
        creditMinor,
        differenceAccountHint: OPENING_CONTRA_ACCOUNT_NUMBER,
        reason: 'name a clarification account to book the difference explicitly',
      });
    }
    const clarification = resolveAccount(ctx, input.differenceAccount);
    if (clarification === undefined) {
      return err('unknown_account', { account: input.differenceAccount, role: 'differenceAccount' });
    }
    // Debit-heavy (positive) needs more CREDIT; credit-heavy (negative) needs more DEBIT.
    lines.push(
      differenceMinor > 0
        ? { account: clarification.id, credit: differenceMinor }
        : { account: clarification.id, debit: -differenceMinor },
    );
  }

  if (lines.length < 2) {
    return err('invalid_input', {
      field: 'lines',
      reason: 'an opening position needs at least two non-zero sides',
    });
  }

  // The post runs INSIDE the memo so the caller's whole Result is what a retry replays, and a
  // rejection escapes by THROWING rather than returning, so a refused post never burns the key. Same
  // shape A03's year-close uses, and for the same reason: a caller whose post was refused for a
  // locked period must be able to retry the identical call once the period reopens.
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'set_opening_balances', () => {
      const posted = postEntry(ctx, {
        date: asOf,
        source: 'import',
        description: input.description ?? `Eröffnungsbilanz per ${asOf}`,
        // OR 957a Abs. 2 Ziff. 2, the Belegnachweis: the caller's own reference to the source
        // document rides on the entry, so the opening position can be walked back to the Inventar
        // OR 958c Abs. 2 asks for. Optional, because the entry's source and key already trace
        // provenance (§4).
        ...(input.reference !== undefined ? { ref: input.reference } : {}),
        lines,
        idempotencyKey: entryKey,
      });
      // Every A02 rejection rides out unchanged: `permission_denied` (A24), `period_locked`
      // (§H-PERIOD), `unbalanced` from the posting core. Re-coding any of them here would give one
      // condition two names on two surfaces.
      if (!posted.ok) throw new OpeningPostFailure(posted);
      return ok({
        entryId: posted.entryId,
        asOf,
        year,
        differenceMinor,
        debitMinor,
        creditMinor,
        lineCount: lines.length,
      });
    });
  } catch (e) {
    if (e instanceof OpeningPostFailure) return e.result;
    throw e;
  }
}

interface PositionRow {
  id: string;
  number: string;
  name: string;
  type: string;
  net: number;
}

function toLine(row: PositionRow): Record<string, unknown> {
  return {
    accountId: row.id,
    number: row.number,
    name: row.name,
    type: row.type,
    debitMinor: row.net > 0 ? row.net : 0,
    creditMinor: row.net < 0 ? -row.net : 0,
  };
}

/**
 * Read the opening position for a fiscal year: what was seeded, or what the prior close carried.
 *
 * THE CARRY-FORWARD QUERY DELIBERATELY INCLUDES `source='close'` ENTRIES, and that is the opposite
 * of what a P&L report must do. A08's Erfolgsrechnung went all-zero after a year close because it
 * summed the close's own zeroing lines into the year it was reporting on. The BALANCE SHEET is the
 * mirror case: A03's close moves the result 2979 -> 2970, and that movement is exactly what makes
 * year N+1's equity right. Filtering it out would open the new year with 2979 still holding the
 * result and 2970 empty, which is the same figure in the wrong line of equity.
 *
 * It also restricts to balance-sheet account types, and THE OLD JUSTIFICATION FOR THAT WAS WRONG.
 * It read "the close already zeroed the P&L, so those types would add only rows that net to zero".
 * Nothing enforces it: `hardCloseYear` does not require year N-1 to be closed before year N. Close
 * 2026 while 2025 is still open and 3000 still carries 2025's revenue, which this filter then drops,
 * so the carried position comes back short by exactly that residue. Measured: 600'000 debit against
 * 100'000 credit, `ok: true`, on a 5'000.00 franc gap.
 *
 * So the restriction now rests on a CHECK rather than on an assumption. The totals are compared and a
 * position that does not tie out is REFUSED (`carried_position_unbalanced`), naming the signed
 * difference and the open years that caused it, because A08's Bilanz built on this would not foot
 * either and an opening position is the one thing every report above it is computed over. This is the
 * mirror of the write side, which already refuses an unbalanced set rather than plugging it.
 *
 * THE ROOT CAUSE IS NOT PATCHED HERE, deliberately. Whether A03 should refuse to close year N while
 * N-1 is open is A03's contract to change, and changing it from this file could break behaviour that
 * capability owns. A04 keeps its own promise instead: it never hands on a position that does not
 * balance.
 *
 * ONE §H-TENANT FENCE, on `journal_entry.workspace_id`, and it is the only one that can bite. The
 * `account` join is reached exclusively through this workspace's own lines, so a second fence on
 * `account.workspace_id` would be unreachable by construction: it is not left out by oversight, and
 * claiming it as defence in depth would be claiming a guard that no mutation can turn red.
 *
 * That fence now has a TEST that turns it red. It had none, which is the awkward part of having
 * called it load-bearing: neutralising it changed nothing any suite could see. With a neighbour
 * holding 7'777.00 on its own 1020, the unfenced carry reports 777700 where 10000 is right.
 *
 * The ENTRY-branch fence a few lines up (`e.workspace_id = ? AND e.id = ?`) is the opposite case and
 * is named rather than claimed: `entry.id` only ever arrives from `existingOpeningEntry`, which is
 * already fenced, so no mutation can turn it red. Measured: neutralising it fails nothing in the
 * whole suite. It stays because the query should not depend on its caller for tenancy, but it buys
 * no coverage and is not offered as defence in depth.
 */
export function getOpeningBalances(ctx: WorkspaceContext, input: { year?: string | number } = {}): Result {
  const fyStart = fiscalYearStartOf(ctx);
  const year =
    input.year === undefined ? fiscalYearOf(ctx.clock.now().slice(0, 10), fyStart) : String(input.year);
  if (!/^\d{4}$/.test(year)) return err('invalid_input', { field: 'year' });
  const asOf = `${year}-${fyStart}`;
  const baseCurrency = baseCurrencyOf(ctx);

  const entry = existingOpeningEntry(ctx, year);
  if (entry !== undefined) {
    const rows = ctx.store.db
      .prepare(
        `SELECT a.id AS id, a.number AS number, a.name AS name, a.type AS type,
                SUM(l.base_debit_minor - l.base_credit_minor) AS net
           FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id
           JOIN account a ON a.id = l.account_id
          WHERE e.workspace_id = ? AND e.id = ?
          GROUP BY a.id
          ORDER BY a.number`,
      )
      .all(ctx.workspaceId, entry.id) as PositionRow[];
    const lines = rows.map(toLine);
    return ok({
      year,
      asOf: entry.date,
      source: 'entry',
      entryId: entry.id,
      // The Belegnachweis, READ BACK. OR 957a Abs. 2 Ziff. 2 puts "der Belegnachweis für die
      // einzelnen Buchungsvorgänge" on the books and OR 958c Abs. 2 requires the Bestand of each
      // Bilanz position to be evidenced "durch ein Inventar oder auf andere Art" (both verified
      // verbatim against the consolidated SR 220). This module cites Abs. 2 to justify REFUSING an
      // unbalanced set, so leaving the Inventar pointer write-only used the argument in one
      // direction and not the other. A pointer nobody can read back is not a Nachweis.
      reference: entry.ref,
      carriedFromYear: null,
      // §H-AUDIT: a posted position has no edit path. The Studio reads this rather than deciding for
      // itself, so the GUI and a direct MCP call cannot disagree about whether the grid is open.
      editable: false,
      lines,
      totalDebitMinor: lines.reduce((s, l) => s + (l.debitMinor as number), 0),
      totalCreditMinor: lines.reduce((s, l) => s + (l.creditMinor as number), 0),
      baseCurrency,
    });
  }

  const priorYear = String(Number(year) - 1);
  if (isYearSealed(ctx, priorYear)) {
    const priorEnd = dayBefore(asOf);
    const rows = ctx.store.db
      .prepare(
        `SELECT a.id AS id, a.number AS number, a.name AS name, a.type AS type,
                SUM(l.base_debit_minor - l.base_credit_minor) AS net
           FROM journal_entry e
           JOIN journal_line l ON l.entry_id = e.id
           JOIN account a ON a.id = l.account_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date <= ?
            AND a.type IN ('asset', 'liability', 'equity')
          GROUP BY a.id
         HAVING net != 0
          ORDER BY a.number`,
      )
      .all(ctx.workspaceId, priorEnd) as PositionRow[];
    const lines = rows.map(toLine);
    const totalDebitMinor = lines.reduce((s, l) => s + (l.debitMinor as number), 0);
    const totalCreditMinor = lines.reduce((s, l) => s + (l.creditMinor as number), 0);

    // §H-LEDGER on the READ side. A carried position that does not tie out is not a position, and
    // handing it on as `ok` would put an unbalanced Bilanz under every report above this one.
    const differenceMinor = totalDebitMinor - totalCreditMinor;
    if (differenceMinor !== 0) {
      return err('carried_position_unbalanced', {
        year,
        carriedFromYear: priorYear,
        differenceMinor,
        totalDebitMinor,
        totalCreditMinor,
        unclosedYears: unclosedYearsThrough(ctx, priorYear, fyStart),
        // Phrased so it stays true when `unclosedYears` comes back empty: the refusal is grounded in
        // the measured difference, and the usual cause is offered as a lead rather than asserted.
        reason:
          'the carried balance sheet does not tie out, so it is not handed on. The usual cause is a prior year that was never closed, whose result still sits on Erfolgsrechnung accounts that a balance sheet does not carry: see unclosedYears',
      });
    }

    return ok({
      year,
      asOf,
      source: 'carried_forward',
      entryId: null,
      // A carried position is derived from the close, so it points at no Inventar of its own.
      reference: null,
      carriedFromYear: priorYear,
      // US-A04.4: carried, not something to re-key. A03 owns the close and the result posting.
      editable: false,
      lines,
      totalDebitMinor,
      totalCreditMinor,
      baseCurrency,
    });
  }

  return ok({
    year,
    asOf,
    source: 'none',
    entryId: null,
    reference: null,
    carriedFromYear: null,
    editable: true,
    lines: [],
    totalDebitMinor: 0,
    totalCreditMinor: 0,
    baseCurrency,
  });
}
