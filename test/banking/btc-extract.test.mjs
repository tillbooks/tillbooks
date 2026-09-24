// Guards for the vendored spreadsheet readers behind scripts/extract-btc.mjs.
//
// The extractor itself needs the network, so it cannot run here: these tests pin the fiddly pure
// decoding underneath it, which is where a silent corruption would actually come from. The real
// end-to-end proof is that `npm run extract:btc -- --check` reproduces both committed fixtures
// byte for byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { columnIndex, decodeXml, unzip, readWorkbook } from '../../scripts/lib/xlsx.mjs';
import { _internals } from '../../scripts/lib/xls.mjs';

const { decodeRk } = _internals;

test('column refs decode as bijective base-26, which has no zero digit', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('Z9'), 25);
  // The carry is the interesting part: AA is 26, not 27, because there is no "A0".
  assert.equal(columnIndex('AA1'), 26);
  assert.equal(columnIndex('AZ1'), 51);
  assert.equal(columnIndex('BA1'), 52);
  assert.equal(columnIndex('XFD1048576'), 16383); // the last column Excel allows
});

test('XML entity decoding unescapes ampersands last, so &amp;lt; stays literal', () => {
  assert.equal(decodeXml('a &lt;b&gt; c'), 'a <b> c');
  assert.equal(decodeXml('Fish &amp; Chips'), 'Fish & Chips');
  // If &amp; were expanded first this would wrongly collapse to "<".
  assert.equal(decodeXml('&amp;lt;'), '&lt;');
  assert.equal(decodeXml('&#65;&#x42;'), 'AB');
});

test('RK numbers decode across all four flag combinations', () => {
  // bit1 set = integer payload in the top 30 bits; bit0 set = additionally divide by 100.
  assert.equal(decodeRk(0x00000002 | (1 << 2)), 1);
  assert.equal(decodeRk(0x00000002 | (45342 << 2)), 45342);
  assert.equal(decodeRk(0x00000003 | (12345 << 2)), 123.45);
  // Negative integers rely on an arithmetic shift, not a logical one.
  assert.equal(decodeRk((-7 << 2) | 0x02), -7);
  // Float payload: the top 32 bits of an IEEE-754 double, low half zeroed. 0x3FF0.. is 1.0.
  assert.equal(decodeRk(0x3ff00000), 1);
  assert.equal(decodeRk(0x40590000), 100);
  assert.equal(decodeRk(0x40590000 | 0x01), 1);
});

/** Builds a minimal single-entry zip so the reader can be exercised without a real workbook. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflateRawSync(Buffer.from(content, 'utf8'));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(Buffer.byteLength(content), 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

test('the zip reader finds entries through the central directory', () => {
  const zip = makeZip({ 'a.txt': 'hello', 'b/c.txt': 'world' });
  const files = unzip(zip);
  assert.equal(files.get('a.txt').toString('utf8'), 'hello');
  assert.equal(files.get('b/c.txt').toString('utf8'), 'world');
});

test('the workbook reader resolves sheets by relationship id and shares strings', () => {
  const zip = makeZip({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Codes &amp; Notes" sheetId="1" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId7" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>PMNT</t></si><si><t>Split </t><t>runs</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="B2"><v>45342</v></c></row>' +
      '</sheetData></worksheet>',
  });

  const book = readWorkbook(zip);
  // The sheet name arrives entity-decoded, and the relationship id is honoured over sheet order.
  assert.deepEqual(Object.keys(book), ['Codes & Notes']);
  const rows = book['Codes & Notes'];
  // A gap at B1 becomes an empty string so callers can index by column.
  assert.deepEqual(rows[0], ['PMNT', '', 'Split runs']);
  // Numbers keep their stored text: a date serial must not be silently reinterpreted as a date.
  assert.deepEqual(rows[1], ['', '45342']);
});
