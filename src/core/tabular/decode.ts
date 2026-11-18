/**
 * A20 §13.1 (D205): bytes to text for every tabular export TILL reads (a bank CSV, a settlement table, a
 * migration file). Moved here unchanged from `banking/csvStatement.ts`, which re-exports it.
 *
 * A forced encoding wins; else a UTF-8 BOM; else strict UTF-8; else Windows-1252, the legacy single-byte
 * export many Swiss e-banking CSVs still are. Pure: no store, no clock, no `node:fs`.
 */

/** The encodings a caller may force (auto-detection otherwise). */
export const TABULAR_ENCODINGS = ['utf-8', 'windows-1252'] as const;
export type TabularEncoding = (typeof TABULAR_ENCODINGS)[number];

/** The encoding the bytes were read in (`utf-8-bom` when a BOM said so). */
export type DetectedTextEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252';

/** Bytes to text: a forced encoding, else a UTF-8 BOM, else strict UTF-8, else Windows-1252. */
export function decodeTextBytes(bytes: Uint8Array, forced?: TabularEncoding): { text: string; encoding: DetectedTextEncoding } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (forced === 'windows-1252') return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  if (bom) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  if (forced === 'utf-8') return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}
