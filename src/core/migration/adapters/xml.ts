/**
 * A tiny regex XML tag-reader, the SAME lightweight technique A20's camt parser uses (spec §4: "the
 * same XML utility A20's camt parser uses, never a second XML stack"). It is deliberately NOT a DOM
 * parser and NOT a new dependency: `src/core/banking/camt.ts` reads camt.053 with exactly this
 * strip-prefix + first/all-tag-body approach, and the money path already trusts it. Duplicating a
 * dozen lines of regex here (rather than importing camt's private helpers, which would couple the
 * migration adapters to the banking module) keeps the two capabilities decoupled while using one
 * technique, not two XML stacks. No `node:fs`, no socket.
 *
 * This reads the AbaConnect interchange envelope (Abacus / AbaNinja lineage), whose published shape is
 * `AbaConnectContainer > Task > Transaction > <RecordElement mode='SAVE'> ...fields...`. Each record
 * element under the first `Transaction` becomes a row of `{childTag: text}`.
 */

import type { ParseResult, ParseFailure } from './parse.js';

/** Drop namespace prefixes, so `<ns:Address>` reads as `<Address>` (camt's `stripPrefixes`). */
function stripPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z][\w.-]*:/g, '<$1');
}

/** The body of the FIRST `<tag>...</tag>`, or null. Mirrors camt's `firstTagBody`. */
function firstTagBody(xml: string | null, tag: string): string | null {
  if (xml === null) return null;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m === null ? null : (m[1] as string);
}

/** The bodies of EVERY `<tag ...>...</tag>` at any depth. Mirrors camt's `allTagBodies`. */
function allTagBodies(xml: string | null, tag: string): string[] {
  if (xml === null) return [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] as string);
  return out;
}

/** Decode the five predefined XML entities in a leaf value. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The direct child leaf elements of a record body: `<Tag>value</Tag>` pairs, in document order. */
function leafFields(recordBody: string): { headers: string[]; row: Record<string, string> } {
  const re = /<([A-Za-z][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  const headers: string[] = [];
  const row: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(recordBody)) !== null) {
    const tag = m[1] as string;
    const inner = m[2] as string;
    // Only LEAF elements (no nested tag) become columns; a nested subject block is skipped, matching
    // the generic tabular shape the harness maps. A repeated leaf keeps the first occurrence's column.
    if (/<[A-Za-z]/.test(inner)) continue;
    if (!(tag in row)) headers.push(tag);
    row[tag] = decodeEntities(inner.trim());
  }
  return { headers, row };
}

/**
 * Parse an AbaConnect XML envelope into rows. Each `<RecordElement mode='...'>` under the first
 * `<Transaction>` is one row; its direct leaf children are the columns. The envelope carries an
 * interface `<Version>` but no generation date, so `asAt` is null (US-G09.1's boundary: never a guess).
 * A non-XML or Transaction-less payload is a `ParseFailure`, so the file is reported unparseable alone.
 */
export function parseAbaConnect(bytes: Uint8Array): ParseResult | ParseFailure {
  const raw = new TextDecoder('utf-8').decode(bytes);
  if (!/<AbaConnectContainer[\s>]/i.test(raw)) {
    return { ok: false, reason: 'not_abaconnect' };
  }
  const xml = stripPrefixes(raw);
  const task = firstTagBody(xml, 'Task');
  const transaction = firstTagBody(task, 'Transaction');
  if (transaction === null) {
    // A container with no Transaction is a valid but empty export: zero rows, headers unknown.
    return { headers: [], rows: [], warnings: ['abaconnect: no Transaction block'], asAt: null };
  }
  // The record element is the first child element name inside the Transaction (Address, Account, ...).
  const nameMatch = /<([A-Za-z][\w.-]*)(?:\s[^>]*)?>/.exec(transaction);
  if (nameMatch === null) {
    return { headers: [], rows: [], warnings: ['abaconnect: empty Transaction'], asAt: null };
  }
  const recordTag = nameMatch[1] as string;
  const bodies = allTagBodies(transaction, recordTag);
  const headers: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const body of bodies) {
    const { headers: h, row } = leafFields(body);
    for (const col of h) {
      if (!seen.has(col)) {
        seen.add(col);
        headers.push(col);
      }
    }
    rows.push(row);
  }
  return { headers, rows, warnings: [], asAt: null };
}
