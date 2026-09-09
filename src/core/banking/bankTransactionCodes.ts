/**
 * Swiss Bank Transaction Codes (BTC), the "business case code" in Swiss usage.
 *
 * `<BkTxCd>` is a mandatory C-level element in camt.052/053/054 and is structured as three separate
 * ISO 20022 external code sets: Domain (`Domn/Cd`), Family (`Domn/Fmly/Cd`) and Sub-Family
 * (`Domn/Fmly/SubFmlyCd`). Module 2 classifies statement entries from this triple, so the values
 * here are load-bearing for reconciliation.
 *
 * Source of the values: the SIX workbook "List of BTC codes used in Switzerland"
 * (btc-codes-sps-en.xlsx), linked from the SIX ISO 20022 page and retrieved 2026-07-19. The full
 * extract lives verbatim at `test/fixtures/btc-codes-sps-ch.json`; `test/banking/` asserts that the
 * constants below never drift from it. See `docs/planning/btc-swiss-bank-transaction-codes.md` for
 * the provenance note and the open questions.
 *
 * ORIENTATION, the thing that is easy to invert: the Issued/Received prefix is stated from the
 * account holder's point of view, and for direct debits it is the opposite of the naive reading.
 * `IDDT` ("Issued Direct Debits") is the collection WE initiated as creditor, so it CREDITS us.
 * `RDDT` ("Received Direct Debits") is a collection someone else initiated against us, so it DEBITS
 * us. The workbook's own Swiss Market Individualization column pins this: IDDT/PMDD reads "Credit
 * from direct debit", RDDT/PMDD reads "Debit from direct debit".
 *
 * CONFIDENCE: every code value below is quoted from the workbook and is `verified`. What is NOT
 * always verified is the mapping from a code to a named Swiss scheme. The workbook names no scheme:
 * it has no eBill, LSV+, BDD or CH-DD row. Where this module asserts such a mapping it is marked
 * `inferred`, and callers must not present an inferred mapping to a user as fact.
 */

/** The confidence attached to a scheme mapping, never to the code value itself. */
export type BtcConfidence = 'verified' | 'inferred';

/** A fully qualified Bank Transaction Code: the Domain/Family/Sub-Family triple. */
export interface BankTransactionCode {
  readonly domain: string;
  readonly family: string;
  readonly subFamily: string;
}

/** A code paired with what we claim it means, and how well that claim is evidenced. */
export interface BtcClassification {
  readonly code: BankTransactionCode;
  /** Direction on our own account. */
  readonly effect: 'credit' | 'debit';
  readonly meaning: string;
  readonly confidence: BtcConfidence;
  /** Present when `confidence` is `inferred`: what is missing, so nobody mistakes it for evidence. */
  readonly caveat?: string;
}

const PMNT = 'PMNT';

function btc(family: string, subFamily: string): BankTransactionCode {
  return Object.freeze({ domain: PMNT, family, subFamily });
}

/**
 * Incoming QR-bill payment: a credit transfer received carrying a structured reference.
 *
 * VERIFIED. The workbook's mandatory sheet gives PMNT/RCDT/VCOM the individualization "Incoming
 * payment with structured reference, QR-IBAN incoming payment, domestic SCOR incoming payment",
 * which covers both QR-bill flavours (QR-IBAN with QR reference, and IBAN with SCOR reference).
 */
export const BTC_QR_BILL_INCOMING: BtcClassification = Object.freeze({
  code: btc('RCDT', 'VCOM'),
  effect: 'credit',
  meaning: 'Incoming payment with structured reference (QR-IBAN or domestic SCOR), i.e. a paid QR-bill',
  confidence: 'verified',
});

/**
 * Money collected by direct debit landing on our account, we being the creditor.
 *
 * The code is VERIFIED (PMNT/IDDT/PMDD, "Credit from direct debit"). The mapping to the named Swiss
 * schemes is INFERRED: the workbook names no scheme, and PMDD is the only domestic direct debit
 * sub-family it offers, the siblings being SEPA (ESDD, BBDD) or cross-border (XBDD). So LSV+/BDD,
 * PostFinance CH-DD and eBill Direct Debit are all expected to book here.
 *
 * This is also the code that separates eBill Direct Debit from a paid QR-bill. Business Rules SPS
 * 2026 v3.3 ch. 4.3.1 states, for eBill Direct Debit, that the distinction from QR-bill/eBill
 * incoming payments is recognisable by the differing BTC, and ch. 4.3.2 adds that the BTC is used as
 * additional collection and distinction logic. Neither passage names the code. The contrast holds
 * regardless: a direct debit credit is IDDT/PMDD, a paid QR-bill is RCDT/VCOM.
 */
export const BTC_DIRECT_DEBIT_COLLECTED: BtcClassification = Object.freeze({
  code: btc('IDDT', 'PMDD'),
  effect: 'credit',
  meaning: 'Credit from a direct debit we collected as creditor (expected: LSV+/BDD, CH-DD, eBill Direct Debit)',
  confidence: 'inferred',
  caveat:
    'The code and its "Credit from direct debit" gloss are verified. The mapping to LSV+/BDD, CH-DD ' +
    'and eBill Direct Debit is inferred: SIX names no scheme in the BTC workbook, and the Business ' +
    'Rules confirm only that eBill Direct Debit differs from QR-bill by BTC without naming it. ' +
    'Because these schemes are expected to share this code, BTC alone does not separate eBill Direct ' +
    'Debit from LSV+/BDD. Use <NtryRef> for that: LSV+/BDD carries the ESR participant number, ' +
    'CH-DD carries the RS-PID, eBill Direct Debit reuses the QR-bill variants (BR v3.3 ch. 4.3.1).',
});

/** A direct debit someone else collected from us, i.e. we are the debtor. VERIFIED. */
export const BTC_DIRECT_DEBIT_PAID: BtcClassification = Object.freeze({
  code: btc('RDDT', 'PMDD'),
  effect: 'debit',
  meaning: 'Debit from a direct debit collected against us',
  confidence: 'verified',
});

/**
 * Returns, chargebacks and reversals. Every code and gloss here is quoted from the workbook, so all
 * are VERIFIED. Module 2 must treat each of these as an entry that undoes an earlier one, which on
 * our ledger means a reversing entry, never a destructive edit of the original.
 */
export const BTC_REVERSALS: readonly BtcClassification[] = Object.freeze([
  Object.freeze({
    code: btc('IDDT', 'RCDD'),
    effect: 'debit' as const,
    meaning: 'Reversal due to payment cancellation request, on a direct debit we collected',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('IDDT', 'UPDD'),
    effect: 'debit' as const,
    meaning: 'Reversal due to return or unpaid direct debit, on a direct debit we collected',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('IDDT', 'PRDD'),
    effect: 'debit' as const,
    meaning: 'Reversal due to payment reversal, on a direct debit we collected',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('RDDT', 'PRDD'),
    effect: 'credit' as const,
    meaning: 'Reversal due to payment reversal, on a direct debit collected against us',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('ICDT', 'RRTN'),
    effect: 'credit' as const,
    meaning: 'Chargeback of a credit transfer we issued (returned payment)',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('IRCT', 'RRTN'),
    effect: 'credit' as const,
    meaning: 'Reversal of an instant payment we issued, due to an undeliverable transfer or revocation',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('RRCT', 'RRTN'),
    effect: 'debit' as const,
    meaning: 'Chargeback of an instant payment received, due to an undeliverable transfer or revocation',
    confidence: 'verified' as const,
  }),
  Object.freeze({
    code: btc('RCHQ', 'CQRV'),
    effect: 'debit' as const,
    meaning: 'Cheque reversal (chargeback of a cheque credited to us)',
    confidence: 'verified' as const,
  }),
]);

/** Render a code as the canonical `PMNT/RCDT/VCOM` form used in logs and specs. */
export function formatBtc(code: BankTransactionCode): string {
  return `${code.domain}/${code.family}/${code.subFamily}`;
}

/** Structural equality of two codes. */
export function btcEquals(a: BankTransactionCode, b: BankTransactionCode): boolean {
  return a.domain === b.domain && a.family === b.family && a.subFamily === b.subFamily;
}

/** True when the code denotes a return, chargeback or reversal. */
export function isReversalBtc(code: BankTransactionCode): boolean {
  return BTC_REVERSALS.some((r) => btcEquals(r.code, code));
}
