/**
 * Minimal reader for the modern Office formats (.xlsx and .docx).
 *
 * Both are ZIP containers holding XML. Node ships everything needed: `zlib` inflates the entries
 * and the XML here is regular enough to read with expressions. Deliberately not a general Office
 * implementation: it handles what the BTC workbooks actually use and refuses anything else loudly.
 *
 * Vendored rather than taken from npm on purpose. This runs by hand roughly as often as ISO revises
 * the BTC list, so a dependency would cost more in supply-chain surface than it saves in code.
 */
import { inflateRawSync } from 'node:zlib';

/** Entries are found through the central directory, so entry order in the file does not matter. */
export function unzip(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  // The end-of-central-directory record sits last, after a comment of up to 64 KiB.
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra fields, and its lengths are the authoritative
    // ones: some writers pad the local extra field differently from the central one.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** The five XML predefined entities plus numeric character references. */
export function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" survives as the literal "&lt;"
}

/** "BC12" -> 54. Column refs are bijective base-26, so there is no zero digit. */
export function columnIndex(ref) {
  const letters = ref.match(/^([A-Z]+)/)[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Reads a workbook into `{ sheetName: rows }`, each row an array of strings.
 *
 * Numbers arrive as their raw stored text, so a date serial reads as "45342" rather than a date.
 * That is intentional: this reader does not guess at number formats, and the caller decides.
 */
export function readWorkbook(buf) {
  const files = unzip(buf);
  const text = (p) => {
    const f = files.get(p);
    if (!f) throw new Error(`missing workbook part: ${p}`);
    return f.toString('utf8');
  };

  // Shared strings: one <si> may hold several <t> runs, which concatenate into one value.
  const shared = [];
  if (files.has('xl/sharedStrings.xml')) {
    for (const si of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let s = '';
      for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += decodeXml(t[1]);
      shared.push(s);
    }
  }

  const rels = text('xl/_rels/workbook.xml.rels');
  const out = {};

  for (const m of text('xl/workbook.xml').matchAll(/<sheet[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const name = decodeXml(m[1]);
    const rel = rels.match(new RegExp(`Id="${m[2]}"[^>]*?Target="([^"]+)"`));
    if (!rel) throw new Error(`no relationship target for sheet ${name}`);
    const path = 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');

    const rows = [];
    for (const row of text(path).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const ref = attrs.match(/r="([A-Z]+\d+)"/);
        const type = attrs.match(/t="([^"]+)"/)?.[1];

        let value = '';
        if (type === 'inlineStr') {
          for (const t of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) value += decodeXml(t[1]);
        } else {
          const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (raw != null) value = type === 's' ? (shared[Number(raw)] ?? '') : decodeXml(raw);
        }
        // A cell with no r= attribute follows the previous one, which is legal but rare.
        cells[ref ? columnIndex(ref[1]) : cells.length] = value;
      }
      rows.push(Array.from(cells, (x) => x ?? ''));
    }
    out[name] = rows;
  }
  return out;
}

/** Concatenated <w:t> text of a .docx, enough to read a version string out of the title page. */
export function readDocxText(buf) {
  const doc = unzip(buf).get('word/document.xml');
  if (!doc) throw new Error('not a .docx: no word/document.xml');
  return [...doc.toString('utf8').matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((m) => decodeXml(m[1]))
    .join(' ')
    .replace(/\s+/g, ' ');
}
