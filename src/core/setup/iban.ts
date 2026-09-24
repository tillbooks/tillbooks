/**
 * IBAN and Swiss QR-IBAN validation (A00 creditor profile).
 *
 * A QR-bill (A11) needs a QR-IBAN: a valid IBAN (ISO 7064 mod-97-10) whose QR-IID (the 5-digit
 * institution identifier at positions 5 to 9) falls in 30000 to 31999, per the SIX QR-bill
 * Implementation Guidelines. A plain IBAN is valid but only supports SCOR references, not QRR.
 * Shape only: no bank-directory lookup in the OSS core.
 */

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

export function isValidIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s) || s.length < 15 || s.length > 34) {
    return false;
  }
  // Move the first four characters to the end, map letters to numbers (A=10 .. Z=35), take mod 97.
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const chunk = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of chunk) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * The reserved QR-IID range, named once so the statutory boundary has ONE home.
 *
 * SIX, "Swiss QR-bill: Technical information about the QR-IID and QR-IBAN" v1.1 §1.3.2: "The QR-IID
 * is derived from the institution identification (IID). QR-IIDs consist exclusively of numbers from
 * 30000 to 31999." A19 re-exports these rather than restating the digits, because a statutory range
 * written down twice is a range that can be corrected in one place only.
 */
export const QR_IID_MIN = 30000;
export const QR_IID_MAX = 31999;

export function isQrIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!isValidIban(s) || !(s.startsWith('CH') || s.startsWith('LI'))) {
    return false;
  }
  const qrIid = Number(s.slice(4, 9));
  return qrIid >= QR_IID_MIN && qrIid <= QR_IID_MAX;
}
