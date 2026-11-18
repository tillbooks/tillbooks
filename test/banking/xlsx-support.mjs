// A20 §13.1: a minimal XLSX WRITER for the tabular tests, so a statement workbook is packed in memory from
// invented rows (never a committed binary, never a real export). Built on the migration suite's zip writer.
//
// A row is an array of cells: a string (a shared string), a number (a General number), `{ n, s }` (a number
// with the cellXfs style s, its raw text n as the file stores it), `{ date: 'YYYY-MM-DD', s? }` (the date's
// serial in a date style), `{ inline: 'text' }`, or null (no cell).

import { writeZip } from '../migration/zipWrite.mjs';

/** The cellXfs styles every workbook here carries: 0 General, 1 built-in 14, 2 custom dd.mm.yyyy, 3 built-in 2 (0.00), 4 built-in 20 (h:mm). */
export const STYLE = { general: 0, date14: 1, dateCustom: 2, fixed2: 3, time: 4 };

/** Further cellXfs styles, one per built-in format id (index 5 onwards): the dates 15, 16, 17, 22 and the times 18, 19, 21, 45, 46, 47. */
export const BUILTIN_STYLES = [15, 16, 17, 22, 18, 19, 21, 45, 46, 47];
export const styleOfBuiltin = (id) => 5 + BUILTIN_STYLES.indexOf(id);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DAY = 86_400_000;

/** The serial of an ISO date in the 1900 or the 1904 system. */
export function serialOf(iso, date1904 = false) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return date1904 ? (t - Date.UTC(1904, 0, 1)) / DAY : (t - Date.UTC(1899, 11, 30)) / DAY;
}

function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Pack a workbook. `sheets`: [{ name, rows, startRow? }]; `date1904`; `deflate` (compress every part);
 * `pad` (extra characters inside the first sheet, to model a member that inflates past a ceiling).
 */
export function xlsxBook({ sheets, date1904 = false, deflate = false, pad = 0 }) {
  const shared = [];
  const sharedIndex = new Map();
  const ss = (v) => {
    if (!sharedIndex.has(v)) {
      sharedIndex.set(v, shared.length);
      shared.push(v);
    }
    return sharedIndex.get(v);
  };
  const sheetXml = sheets.map((sheet, si) => {
    const start = sheet.startRow ?? 1;
    const rows = sheet.rows
      .map((cells, ri) => {
        const r = start + ri;
        const body = cells
          .map((c, ci) => {
            if (c === null || c === undefined) return '';
            const ref = `${colName(ci)}${r}`;
            if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${ss(c)}</v></c>`;
            if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
            if (c.inline !== undefined) return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.inline)}</t></is></c>`;
            if (c.date !== undefined) return `<c r="${ref}" s="${c.s ?? STYLE.date14}"><v>${serialOf(c.date, date1904)}</v></c>`;
            return `<c r="${ref}"${c.s !== undefined ? ` s="${c.s}"` : ''}><v>${c.n}</v></c>`;
          })
          .join('');
        return `<row r="${r}">${body}</row>`;
      })
      .join('');
    const filler = si === 0 && pad > 0 ? ' '.repeat(pad) : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${filler}</worksheet>`;
  });
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      (date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>') +
      `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      '</Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/></numFmts>' +
      '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
      `<cellXfs count="${5 + BUILTIN_STYLES.length}"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" xfId="0"/><xf numFmtId="20" xfId="0"/>${BUILTIN_STYLES.map((id) => `<xf numFmtId="${id}" xfId="0"/>`).join('')}</cellXfs>` +
      '</styleSheet>',
  };
  sheetXml.forEach((xml, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = xml;
  });
  parts['xl/sharedStrings.xml'] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}">` +
    shared.map((v) => `<si><t xml:space="preserve">${esc(v)}</t></si>`).join('') +
    '</sst>';
  return writeZip(Object.entries(parts).map(([name, content]) => ({ name, content, deflate })));
}

/** The base64 of a workbook, as the Studio sends it. */
export const b64 = (buf) => Buffer.from(buf).toString('base64');
