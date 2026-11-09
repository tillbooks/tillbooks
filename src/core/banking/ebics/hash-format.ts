/**
 * The ONE bank-letter hash formatter, shared by the INI letter (core) and the Studio's HPB
 * compare-and-confirm block. PURE: no `node:` import, so the Studio bundles it as is.
 *
 * Banks print EBICS hash values as uppercase hexadecimal byte pairs separated by single spaces. ZKB's
 * public sheet *EBICS Verbindungsparameter* prints 8 pairs per line (a SHA-256 value is 32 bytes, so
 * four lines), and A36 §3 step 6 has the panel and the letter print them the same way, so a human
 * compares TILL's screen or letter against the bank's paper line by line, pair by pair.
 */

/** Bytes per printed line, as on ZKB's sheet (A36 §3 step 6, §5). */
export const BANK_HASH_BYTES_PER_LINE = 8;

/**
 * Format a hex hash (any case, whitespace and colons tolerated) as bank-letter lines: uppercase byte
 * pairs, space separated, 8 bytes per line. A malformed value (odd length, non-hex) is returned as a
 * single line unchanged, so a bad input is visible rather than silently reshaped.
 */
export function formatBankHashLines(hex: string, bytesPerLine: number = BANK_HASH_BYTES_PER_LINE): string[] {
  const compact = hex.replace(/[\s:]/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) return [hex];
  const pairs = compact.toUpperCase().match(/.{2}/g) ?? [];
  const lines: string[] = [];
  const per = Number.isInteger(bytesPerLine) && bytesPerLine > 0 ? bytesPerLine : BANK_HASH_BYTES_PER_LINE;
  for (let i = 0; i < pairs.length; i += per) lines.push(pairs.slice(i, i + per).join(' '));
  return lines;
}

/** The same, joined with newlines (the monospace block form). */
export function formatBankHash(hex: string, bytesPerLine: number = BANK_HASH_BYTES_PER_LINE): string {
  return formatBankHashLines(hex, bytesPerLine).join('\n');
}
