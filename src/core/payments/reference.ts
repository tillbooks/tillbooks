/**
 * A14 §3.1, the payment reference: three regimes, not one.
 *
 * A payment reference is the ONE input that can settle a match on its own, and it exists in only
 * two structured forms. Which one an invoice carries is decided by the IBAN it was issued against
 * (SIX "Swiss Implementation Guidelines for the QR-bill" v2.3, ch. 2.12 and Annex B, fetched
 * 2026-07-25 from six-group.com):
 *
 *  | Regime | When                                         | What matching may do    |
 *  |--------|----------------------------------------------|-------------------------|
 *  | QRR    | issued against a QR-IBAN                      | settle a match          |
 *  | SCOR   | issued against a normal IBAN, ISO 11649       | settle a match          |
 *  | NON    | issued against a normal IBAN, no reference    | RANK only, never settle |
 *
 * The third regime is the one a matching UI usually forgets and it is the common one for a
 * freelancer who never requested a QR-IBAN. So this module CLASSIFIES what it was given rather than
 * assuming a form, and it draws the single most important line on the whole surface:
 *
 *   **A 27-digit string whose check digit fails is a TYPO, and it is reported as one. It never
 *   silently degrades into free text, because free text ranks and a confident-looking amount-only
 *   match on a mistyped reference is how money lands on the wrong invoice.**
 *
 * ONE DERIVATION, not two. The check-digit primitives and the reference BUILDERS live in A11's
 * `src/core/sales/qrbill.ts`, because A11 issues the references this module recognises. A14
 * re-exports them rather than carrying a second copy: if the two ever disagreed about a check digit,
 * an invoice would quote a reference its own payment matcher rejects. What lives HERE is the part
 * A11 has no reason to own, which is the classification of whatever a payer, a bank advice or a
 * later camt import actually handed us.
 */

import {
  mod10RecursiveCheckDigit,
  isValidQrrReference,
  isValidScorReference,
  buildQrrReference,
  buildScorReference,
  iso11649CheckDigits,
} from '../sales/qrbill.js';

export {
  mod10RecursiveCheckDigit,
  isValidQrrReference,
  isValidScorReference,
  buildQrrReference,
  buildScorReference,
  iso11649CheckDigits,
};

/** How a reference was classified. `none` is the NON regime: nothing structured was given. */
export type ReferenceKind = 'qrr' | 'scor' | 'free_text' | 'none';

export interface ClassifiedReference {
  kind: ReferenceKind;
  /** The normalised value (spaces stripped, SCOR upper-cased), or null for `none`. */
  value: string | null;
  /** False only for a structured reference whose check digits fail. Free text is always valid. */
  valid: boolean;
  /** `reference_check_digit` when a structured reference failed its own check, else null. */
  error: string | null;
}

/**
 * Classify whatever the payer's advice, the e-banking screen, or a later camt import handed us.
 *
 * The order of the tests is the whole design. A 27-digit numeric string is COMMITTED to the QRR
 * regime before its check digit is examined, and an `RF`-shaped string is committed to SCOR the
 * same way, so a failing check digit comes back as `kind:'qrr'` with `valid:false` rather than
 * falling through to `free_text`. Only a string that was never structured to begin with is free
 * text, and free text is accepted quietly: it is a ranking hint, never an error.
 */
export function classifyReference(input: string | null | undefined): ClassifiedReference {
  if (typeof input !== 'string') return { kind: 'none', value: null, valid: true, error: null };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: 'none', value: null, valid: true, error: null };

  // A structured reference travels with blocking spaces on paper and without them on the wire.
  const compact = trimmed.replace(/\s+/g, '');

  if (/^\d{27}$/.test(compact)) {
    const valid = isValidQrrReference(compact);
    return { kind: 'qrr', value: compact, valid, error: valid ? null : 'reference_check_digit' };
  }
  if (/^[Rr][Ff]/.test(compact)) {
    const upper = compact.toUpperCase();
    const valid = isValidScorReference(upper);
    // `RF` alone, or `RF` plus junk, is not a Creditor Reference anybody typed on purpose: it is
    // free text that happens to start with two letters. Only an RF-SHAPED string is committed to
    // the SCOR regime and told its check digits are wrong.
    if (/^RF\d{2}[A-Z0-9]{1,21}$/.test(upper)) {
      return { kind: 'scor', value: upper, valid, error: valid ? null : 'reference_check_digit' };
    }
  }
  return { kind: 'free_text', value: trimmed, valid: true, error: null };
}

/**
 * Redisplay a reference the way it is printed (PT3). The QR reference groups in blocks of FIVE with
 * the partial group at the LEFT: verified against the guidelines' own figure, which prints the
 * 27-digit example as `21 00000 00003 13947 14300 09017`. The Creditor Reference groups in blocks
 * of four from the left, the ISO 11649 convention it shares with the IBAN.
 */
export function formatReference(kind: ReferenceKind, value: string): string {
  if (kind === 'qrr') {
    const head = value.length % 5;
    const groups: string[] = [];
    if (head > 0) groups.push(value.slice(0, head));
    for (let i = head; i < value.length; i += 5) groups.push(value.slice(i, i + 5));
    return groups.join(' ');
  }
  if (kind === 'scor') {
    return (value.match(/.{1,4}/g) ?? [value]).join(' ');
  }
  return value;
}
