/**
 * A31, WHICH BILL a Swiss QR Code states (critic R6-M1, the owner rule "corrections belong to their
 * bill"). Pure, no I/O.
 *
 * The bill chokepoint (`../billMerge.ts`) must tell "the same bill again" from "a different bill": the
 * same bill never touches a correction, a different winning bill resets every bill key. Round 6 showed
 * that neither the raw text nor "the latest evidence" can answer it: the same symbol read by two readers
 * differs in its line breaks (IG §4.1.4 allows CR+LF and LF), and a LOSING payload's evidence is the
 * latest without ever being the bill on the capture. So identity is decided by what the bill SAYS.
 *
 * THE IDENTITY is the sha256 of a canonical list of the payment facts that make a bill this bill, read
 * by POSITION from the SPC element list (IG v2.3 Table 8), so the stored bytes' text-layer read and a
 * supplied payload of the same paper agree whatever their decoder:
 *
 *   iban            element 3        all whitespace removed, upper case
 *   creditor        elements 4 to 10 address type, name, street or address line 1, building number or
 *                                    address line 2, postal code, town, country: each NFC-normalised,
 *                                    trimmed, inner whitespace collapsed to one space, lower case
 *                                    (country upper case)
 *   amount          element 18       integer Rappen when it parses (`1000.00` and `1000.0` are one
 *                                    amount), `open` when empty, else the normalised text
 *   currency        element 19       upper case
 *   reference type  element 27       upper case
 *   reference       element 28       all whitespace removed, upper case
 *   message         element 29       the unstructured message (Ustrd): normalised, lower case
 *   billing info    element 31       the Swico StrdBkgInf, whole: normalised, lower case; counted only
 *                                    after the `EPD` trailer and when it opens with `//` (a text layer
 *                                    may run on past the symbol's last element, and that text is not
 *                                    the bill)
 *
 * Since v2 (critic R7-L1) the message and the billing information are part of it: two NON bills of one
 * creditor with the same amount (monthly rent, a membership) differ only there, and a correction to
 * October must not carry into November. Both are fixed text of the symbol, so the two readers of one
 * paper still agree. NOT part of it, deliberately: the line breaks and whitespace (normalised away),
 * the ultimate debtor (elements 20 to 26: the payer, not the bill's issuer), the trailer and the
 * alternative procedures (elements 32 and 33). An amount-only difference IS a different bill. Returns
 * null when the text is not an SPC payload at all.
 *
 * THE VERSION IS PART OF THE VALUE (`v2:<sha256>`): an identity stored by another version (v1 was a bare
 * hex digest) is neither equal nor different to a current one, it is UNKNOWN (`isCurrentIdentity`), so
 * the bill chokepoint re-derives the identity of the bill on the capture instead of comparing.
 */

import { createHash } from 'node:crypto';

import { amountToRappen } from '../captureParse.js';

/** Bumped whenever the canonical list changes; a stored identity of another version reads as unknown. */
const IDENTITY_VERSION = 'v2';

/** Was `stored` computed by THIS version? Anything else (a v1 bare digest, NULL) must be re-derived. */
export function isCurrentIdentity(stored: string | null | undefined): stored is string {
  return typeof stored === 'string' && stored.startsWith(`${IDENTITY_VERSION}:`);
}

export function billIdentity(payload: string): string | null {
  const elements = payload.replace(/\r\n?/g, '\n').split('\n');
  const at = (i: number): string => (elements[i] ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (at(0) !== 'SPC') return null;
  const compact = (i: number): string => at(i).replace(/\s+/g, '').toUpperCase();
  const lower = (i: number): string => at(i).toLowerCase();
  const rawAmount = at(18);
  const minor = rawAmount === '' ? null : amountToRappen(rawAmount);
  const amount = rawAmount === '' ? 'open' : minor !== null ? String(minor) : rawAmount;
  const canonical = [
    IDENTITY_VERSION,
    compact(3),
    at(4).toUpperCase(),
    lower(5),
    lower(6),
    lower(7),
    lower(8),
    lower(9),
    at(10).toUpperCase(),
    amount,
    at(19).toUpperCase(),
    at(27).toUpperCase(),
    compact(28),
    lower(29),
    at(30) === 'EPD' && at(31).startsWith('//') ? lower(31) : '',
  ];
  return `${IDENTITY_VERSION}:${createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')}`;
}
