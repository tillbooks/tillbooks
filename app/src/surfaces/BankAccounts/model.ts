/**
 * The A19 read-model types and the pure helpers the Bankkonten surface renders through.
 *
 * NOTHING HERE IS INVENTED. Every field appears in the fixtures under this directory, and
 * `test/banking/studio-bank-accounts-fixture.test.mjs` pins those to the live engine VALUE for value,
 * asserts the key set exactly, and asserts the ABSENCE of the fields a surface might be tempted to
 * read. The last of those is the sharpest: three phantom permission fields (`canPost`, `canManage`,
 * `canUnlock`) were found in this Studio, read off responses that have never carried them, each
 * tested `x !== false`, so an absent field meant permanently `true`. `list_bank_accounts` carries no
 * permission field either, and this surface therefore gates nothing on one.
 *
 * THE QR-IID RANGE IS A HINT HERE AND A FACT IN THE ENGINE. `is_qr_iban` is derived by
 * `core/setup/iban.ts` from the IID the IBAN carries, and `validate_iban` is deliberately NOT an MCP
 * tool, so the browser cannot ask the engine to classify an IBAN it has not saved yet. The editor
 * still owes the operator the explainer BEFORE they commit, so the two boundary constants are
 * restated below, as a hint whose authority is always the saved row's own `isQrIban`.
 * `test/banking/studio-qr-iid-range.test.mjs` reads these two numbers off this file and compares them
 * to the engine's exported `QR_IID_MIN` / `QR_IID_MAX`, so the restatement cannot drift.
 */

/** SIX, "Swiss QR-bill: Technical information about the QR-IID and QR-IBAN" v1.1, §1.3.2. */
export const QR_IID_MIN = 30000;
export const QR_IID_MAX = 31999;

/** One Bankkonto, exactly as `list_bank_accounts` and `get_bank_account` return it. */
export interface BankAccount {
  id: string;
  name: string;
  iban: string;
  isQrIban: boolean;
  /** SIX §3.1 and §3.3.1: a QR-IBAN may only be credited. A18 must never debit one. */
  receiveOnly: boolean;
  currency: string;
  ledgerAccountId: string;
  /** Resolved to the chart NUMBER, so no raw id reaches the screen. Null if the account vanished. */
  ledgerAccountNumber: string | null;
  openingBalanceMinor: number | null;
  openingBalanceDate: string | null;
  openingEntryId: string | null;
  archived: boolean;
  createdAt: string;
}

/** One chart account, as A01's `list_accounts` answers it. `name`, never `label`. */
export interface ChartAccount {
  id: string;
  number: string;
  /** A01's spelling. The payments read model says `label`: they are not the same field. */
  name: string;
  type: string;
  archived: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function nullableNum(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseBankAccount(value: unknown): BankAccount | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const name = str(value.name);
  const iban = str(value.iban);
  const currency = str(value.currency);
  const ledgerAccountId = str(value.ledgerAccountId);
  const ledgerAccountNumber = nullableStr(value.ledgerAccountNumber);
  const openingBalanceMinor = nullableNum(value.openingBalanceMinor);
  const openingBalanceDate = nullableStr(value.openingBalanceDate);
  const openingEntryId = nullableStr(value.openingEntryId);
  const createdAt = str(value.createdAt);

  if (id === null || name === null || iban === null || currency === null) return null;
  if (ledgerAccountId === null || createdAt === null) return null;
  if (ledgerAccountNumber === undefined || openingBalanceDate === undefined) return null;
  if (openingBalanceMinor === undefined || openingEntryId === undefined) return null;
  if (typeof value.isQrIban !== 'boolean' || typeof value.receiveOnly !== 'boolean') return null;
  if (typeof value.archived !== 'boolean') return null;

  return {
    id,
    name,
    iban,
    isQrIban: value.isQrIban,
    receiveOnly: value.receiveOnly,
    currency,
    ledgerAccountId,
    ledgerAccountNumber,
    openingBalanceMinor,
    openingBalanceDate,
    openingEntryId,
    archived: value.archived,
    createdAt,
  };
}

/** `list_bank_accounts`, or null when the payload is not the shape the engine promises. */
export function parseBankAccounts(body: Record<string, unknown>): BankAccount[] | null {
  if (!Array.isArray(body.bankAccounts)) return null;
  const out: BankAccount[] = [];
  for (const raw of body.bankAccounts) {
    const row = parseBankAccount(raw);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

/** `get_bank_account`, or null when the payload is not the shape the engine promises. */
export function parseOneBankAccount(body: Record<string, unknown>): BankAccount | null {
  return parseBankAccount(body.bankAccount);
}

/** `list_accounts`, or null when the payload is not the shape the engine promises. */
export function parseChart(body: Record<string, unknown>): ChartAccount[] | null {
  if (!Array.isArray(body.accounts)) return null;
  const out: ChartAccount[] = [];
  for (const raw of body.accounts) {
    if (!isRecord(raw)) return null;
    const id = str(raw.id);
    const number = str(raw.number);
    const name = str(raw.name);
    const type = str(raw.type);
    if (id === null || number === null || name === null || type === null) return null;
    if (typeof raw.archived !== 'boolean') return null;
    out.push({ id, number, name, type, archived: raw.archived });
  }
  return out;
}

// --- pure helpers ------------------------------------------------------------------------------------

/** Strip the spaces an operator pastes, and upper-case, which is what the engine stores. */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * A hint at whether an IBAN is a QR-IBAN, for the explainer the editor shows BEFORE the save.
 *
 * Structural only: Swiss IBANs put the five-digit IID in positions 5 to 9, and SIX reserves 30000 to
 * 31999 for QR-IIDs. It answers false for anything that is not a plausible Swiss IBAN, because a
 * wrong "this is a QR-IBAN" claim is worse than a missing one. The saved row's `isQrIban` is the
 * fact; this is a courtesy so the operator is not surprised by a chip after committing.
 */
export function looksLikeQrIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^(CH|LI)\d{2}\d{5}/.test(iban)) return false;
  const iid = Number.parseInt(iban.slice(4, 9), 10);
  return Number.isInteger(iid) && iid >= QR_IID_MIN && iid <= QR_IID_MAX;
}

/**
 * The masked form for the list: country, check digits, the leading IID group and the last group.
 *
 * That is the part an operator recognises an account by, and the full value rides a CopyButton
 * beside it rather than a `title` attribute, which is hover-only and therefore not an affordance.
 */
export function maskIban(value: string): string {
  const iban = normalizeIban(value);
  if (iban.length < 13) return iban;
  return `${iban.slice(0, 4)} ${iban.slice(4, 8)} ...${iban.slice(-4)}`;
}

/** Group an IBAN in fours for reading. The clipboard always gets the unformatted value. */
export function groupIban(value: string): string {
  return normalizeIban(value).replace(/(.{4})/g, '$1 ').trim();
}

/**
 * The QR-IBAN completeness note's predicate (INV-6), and the design's central A19 idea.
 *
 * SIX §3.1: "A QR-IBAN can only be used for incoming payments. Payments debiting a QR-IBAN are not
 * anticipated. That is why there must always be an IBAN in addition to a QR-IBAN." So a register
 * holding a QR-IBAN and no plain IBAN is BROKEN, and nobody finds out until A18's pain.001 debit
 * picker comes up empty, which is the "an affordance is unreachable and nobody knows why" defect
 * class delivered a wave late.
 *
 * NO CURRENCY QUALIFIER. An earlier draft required the plain IBAN to be in the same currency, which
 * is an invention beyond the source and lets a workspace holding a CHF QR-IBAN and one EUR plain
 * IBAN pass the check while still having nothing it could debit in francs.
 */
export function qrIbanRegisterIsIncomplete(accounts: readonly BankAccount[]): boolean {
  const live = accounts.filter((account) => !account.archived);
  return live.some((account) => account.isQrIban) && !live.some((account) => !account.isQrIban);
}

/**
 * The live QR-IBAN ids, sorted. This is what a dismissal of the completeness note is a claim ABOUT.
 *
 * Sorted so the stored form is stable: `list_bank_accounts` makes no ordering promise this surface
 * is entitled to rely on, and a dismissal that re-appeared because two rows came back in the other
 * order would be a worse defect than the one it fixes.
 */
export function liveQrIbanIds(accounts: readonly BankAccount[]): string[] {
  return accounts
    .filter((account) => !account.archived && account.isQrIban)
    .map((account) => account.id)
    .sort();
}

/**
 * Whether a stored dismissal still covers the register as it stands (F3).
 *
 * The note's dismissal used to be one boolean per workspace, so the sentence written in both the
 * design (§7.2) and this surface's own header, "the note returns if a further QR-IBAN is
 * registered", was simply false: nothing cleared it and nothing keyed it to the register. A
 * suppressed warning about a condition that has since changed is a UI asserting a fact it has not
 * rechecked, and the fact here is the one the whole feature exists for.
 *
 * A dismissal covers a register when every live QR-IBAN was already there when it was dismissed. A
 * NEW QR-IBAN is outside the claim, so the note returns, which is the design's own sentence.
 *
 * That subset rule alone is not enough, and the missing half is not obvious: registering a plain
 * IBAN and later archiving it leaves the live QR-IBAN set completely unchanged while the register
 * goes from complete to broken again. The caller therefore FORGETS the dismissal whenever the
 * register is complete, so a dismissal can never be banked against a future breakage. The two rules
 * together are what make the promised sentence true.
 */
export function dismissalCoversRegister(
  dismissed: readonly string[] | null,
  accounts: readonly BankAccount[],
): boolean {
  if (dismissed === null) return false;
  const covered = new Set(dismissed);
  return liveQrIbanIds(accounts).every((id) => covered.has(id));
}

/** The asset accounts the linked-account picker may offer: exactly what the engine will accept. */
export function assetAccounts(chart: readonly ChartAccount[]): ChartAccount[] {
  return chart.filter((account) => account.type === 'asset' && !account.archived);
}

/** The state of 9100 Eröffnungsbilanz in the chart, which decides whether Buchen is reachable. */
export type OpeningAccountState = 'present' | 'archived' | 'missing';

/**
 * Resolve 9100 from a chart read that INCLUDED archived rows.
 *
 * The two absent reasons get two different recoveries, and collapsing them was a real defect in the
 * design's first draft: it would have sent an operator to `/accounts` to create a 9100 that already
 * exists, where they would meet a duplicate-number rejection with no hint that reactivating is the
 * fix. The engine distinguishes them (`reason: 'missing' | 'archived'`) and so does this.
 */
export function openingAccountState(chart: readonly ChartAccount[]): OpeningAccountState {
  const row = chart.find((account) => account.number === OPENING_BALANCE_ACCOUNT_NUMBER);
  if (row === undefined) return 'missing';
  return row.archived ? 'archived' : 'present';
}

/**
 * 9100's row id, when the chart holds one at all (archived or not).
 *
 * The reactivation recovery needs the id, because `unarchive_account` addresses an account by id and
 * not by number. Derived from the SAME chart read `openingAccountState` judges, so the id offered and
 * the state shown can never describe two different rows.
 */
export function openingAccountId(chart: readonly ChartAccount[]): string | null {
  return chart.find((account) => account.number === OPENING_BALANCE_ACCOUNT_NUMBER)?.id ?? null;
}

/** KMU 9100 Eröffnungsbilanz. In NO shipped chart: A04 owns seeding it, and A19 never invents it. */
export const OPENING_BALANCE_ACCOUNT_NUMBER = '9100';

/**
 * The name and type the surface offers to create 9100 AS, shown before the click and sent unchanged.
 *
 * Owner decision D43: the engine's refusal stands (A19 resolves 9100 by number and answers
 * `needs_account`; nothing is invented on the fly), and what ships instead is a one-click offer with
 * the number and the name on screen BEFORE the click, through the ordinary `create_account` path.
 * The constants live here so the sentence the operator reads and the payload the engine receives are
 * the same two strings, rather than a label that could drift from what is actually created.
 *
 * `equity` because an Eröffnungsbilanz is the counter-position to the assets a book opens with. A19's
 * own conformance fixture and the A04 module both create it as equity, and a different type here
 * would put the opening position outside the balance sheet's equity block.
 */
export const OPENING_BALANCE_ACCOUNT_NAME = 'Eröffnungsbilanz';
export const OPENING_BALANCE_ACCOUNT_TYPE = 'equity';

/**
 * What `preview_bank_opening_balance` answers, as the Studio renders it (owner decision D43/B2).
 *
 * `baseAmountMinor` is the engine's figure and the reason the verb exists: it is shown BEFORE Buchen,
 * and Buchen posts an immutable journal entry whose only correction is a reversing entry. The Studio
 * NEVER multiplies the amount by the rate to produce it. The parse below is as strict as every other
 * one in this file, so a payload that changed shape renders nothing rather than `undefined`.
 */
export interface OpeningPreview {
  baseCurrency: string;
  baseAmountMinor: number;
  /** False for 0.00, which records the intent and books no entry at all. */
  posts: boolean;
  /** Present only when a conversion actually happened, exactly as the posting discloses it. */
  fxRate: string | null;
}

export function parseOpeningPreview(body: Record<string, unknown>): OpeningPreview | null {
  const baseCurrency = str(body.baseCurrency);
  const baseAmountMinor = body.baseAmountMinor;
  if (baseCurrency === null) return null;
  if (typeof baseAmountMinor !== 'number' || !Number.isInteger(baseAmountMinor)) return null;
  if (typeof body.posts !== 'boolean') return null;
  return {
    baseCurrency,
    baseAmountMinor,
    posts: body.posts,
    fxRate: typeof body.fxRate === 'string' ? body.fxRate : null,
  };
}

/** The `invalid_iban.reason` codes the engine answers with, mapped to their own sentence. */
export function ibanErrorKey(reason: unknown): string {
  return reason === 'missing' ? 'bank.error.invalidIban.missing' : 'bank.error.invalidIban.structure';
}

/** Parse a `CHF 1'234.56`-shaped input into integer Rappen, or null. Never a float. */
export function parseAmountMinor(value: string): number | null {
  const cleaned = value.replace(/['\s]/g, '').replace(',', '.');
  const match = /^(-?\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const negative = match[1].startsWith('-');
  const whole = Math.abs(Number.parseInt(match[1], 10));
  const rappen = Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10);
  const minor = whole * 100 + rappen;
  return negative ? -minor : minor;
}
