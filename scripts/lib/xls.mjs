/**
 * Minimal reader for the legacy Excel format (.xls), which ISO still publishes the BTC
 * codification in.
 *
 * Two layers, and both have to be implemented because Node ships neither:
 *
 *   1. OLE2 / CFB. A FAT-like filesystem inside one file. The interesting payload is a stream
 *      named "Workbook".
 *   2. BIFF8. A flat sequence of {type, length, payload} records inside that stream.
 *
 * Scope is deliberately narrow: the cell types the BTC codification actually uses, which is text
 * and numbers. Anything unrecognised is skipped rather than guessed at, and structural corruption
 * throws instead of returning half a sheet.
 *
 * Vendored rather than taken from npm for the same reason as lib/xlsx.mjs: this runs by hand about
 * as often as ISO revises the list.
 */

const SECTOR_END = 0xfffffffe;
const SECTOR_FREE = 0xffffffff;

// ---------------------------------------------------------------------------------------------
// Layer 1: the OLE2 / CFB container
// ---------------------------------------------------------------------------------------------

/** Extracts the named streams from a compound file, as `{ name: Buffer }`. */
export function readCompoundFile(buf) {
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== 'd0cf11e0a1b11ae1') throw new Error('not an OLE2 compound file');

  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  const dirStart = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  const difatStart = buf.readUInt32LE(0x44);
  const difatCount = buf.readUInt32LE(0x48);

  // Sector 0 begins immediately after the 512-byte header, whatever the sector size.
  const sectorOffset = (n) => (n + 1) * sectorSize;
  const sector = (n) => {
    const start = sectorOffset(n);
    if (start + sectorSize > buf.length) throw new Error(`sector ${n} runs past end of file`);
    return buf.subarray(start, start + sectorSize);
  };

  // The DIFAT lists the FAT sectors: 109 entries inline in the header, the rest chained.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s === SECTOR_FREE || s === SECTOR_END) break;
    fatSectors.push(s);
  }
  let next = difatStart;
  for (let i = 0; i < difatCount && next !== SECTOR_END && next !== SECTOR_FREE; i++) {
    const s = sector(next);
    const perSector = sectorSize / 4 - 1; // last slot chains to the next DIFAT sector
    for (let j = 0; j < perSector; j++) {
      const v = s.readUInt32LE(j * 4);
      if (v === SECTOR_FREE || v === SECTOR_END) break;
      fatSectors.push(v);
    }
    next = s.readUInt32LE(sectorSize - 4);
  }

  // Flatten the FAT: entry N gives the sector following N, or a terminator.
  const fat = [];
  for (const fs of fatSectors) {
    const s = sector(fs);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(s.readUInt32LE(i * 4));
  }

  const chain = (start, table) => {
    const out = [];
    const seen = new Set();
    let cur = start;
    while (cur !== SECTOR_END && cur !== SECTOR_FREE && cur < table.length) {
      if (seen.has(cur)) throw new Error('cyclic sector chain in compound file');
      seen.add(cur);
      out.push(cur);
      cur = table[cur];
    }
    return out;
  };

  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));

  // Directory entries are 128 bytes each, laid out across a chain of sectors.
  const dir = readChain(dirStart);
  const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dir.readUInt16LE(p + 0x40);
    const type = dir.readUInt8(p + 0x42);
    if (type === 0) continue; // unallocated
    // nameLen counts bytes including the UTF-16 terminator.
    const name = dir.toString('utf16le', p, p + Math.max(0, nameLen - 2));
    entries.push({
      name,
      type, // 1 storage, 2 stream, 5 root
      start: dir.readUInt32LE(p + 0x74),
      size: Number(dir.readBigUInt64LE(p + 0x78)),
    });
  }

  const root = entries.find((e) => e.type === 5);
  if (!root) throw new Error('compound file has no root entry');

  // Streams below the cutoff live packed inside the root entry's mini stream.
  let miniFat = [];
  let miniStream = Buffer.alloc(0);
  if (miniFatStart !== SECTOR_END && miniFatStart !== SECTOR_FREE) {
    const mf = readChain(miniFatStart);
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readUInt32LE(i * 4));
    miniStream = readChain(root.start);
  }
  const readMini = (start, size) => {
    const parts = chain(start, miniFat).map((n) =>
      miniStream.subarray(n * miniSectorSize, (n + 1) * miniSectorSize),
    );
    return Buffer.concat(parts).subarray(0, size);
  };

  const streams = {};
  for (const e of entries) {
    if (e.type !== 2 || e.size === 0) continue;
    streams[e.name] =
      e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start).subarray(0, e.size);
  }
  return streams;
}

// ---------------------------------------------------------------------------------------------
// Layer 2: BIFF8 records
// ---------------------------------------------------------------------------------------------

const REC = {
  FORMULA: 0x0006,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  MULRK: 0x00bd,
  BOUNDSHEET: 0x0085,
  NUMBER: 0x0203,
  LABEL: 0x0204,
  RK: 0x027e,
  BOF: 0x0809,
  STRING: 0x0207,
};

/** Splits a stream into its records. CONTINUE records stay separate; callers that care rejoin. */
function records(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    if (p + 4 + len > buf.length) break; // trailing padding, not an error
    out.push({ type, data: buf.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return out;
}

/**
 * Decodes an RK number.
 *
 * The low two bits are flags and the upper 30 carry either a signed integer or the high half of an
 * IEEE-754 double with its low half zeroed. Both variants may additionally be scaled by 100.
 */
function decodeRk(rk) {
  const isInt = (rk & 0x02) !== 0;
  let value;
  if (isInt) {
    value = rk >> 2; // arithmetic shift keeps the sign
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(rk & 0xfffffffc, 4);
    value = b.readDoubleLE(0);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

/**
 * Reads the shared string table.
 *
 * The awkward part: a single string may straddle a CONTINUE boundary, and when it does the
 * continuation begins with a fresh flags byte whose only meaningful bit says whether the remaining
 * characters are 16-bit or compressed 8-bit. Handling that is most of what this function is.
 */
function readSharedStrings(sstRecord, continues) {
  const segments = [sstRecord, ...continues];
  let seg = 0;
  let pos = 8; // skip the total/unique counts at the head of the SST record
  let wide = false;

  const remaining = () => segments[seg].length - pos;

  /**
   * Step to the next segment.
   *
   * The subtlety that makes this format awkward: a CONTINUE record carries a leading flags byte
   * ONLY when the previous string was cut mid-character-data. A string that ends flush with the
   * record boundary is followed by a CONTINUE that opens directly on the next string header. Eating
   * a flags byte unconditionally desynchronises the whole table a few hundred strings later.
   */
  const nextSegment = (midString) => {
    seg++;
    if (seg >= segments.length) throw new Error('shared string table ended mid-string');
    if (midString) {
      wide = (segments[seg].readUInt8(0) & 0x01) !== 0;
      pos = 1;
    } else {
      pos = 0;
    }
  };

  const unique = sstRecord.readUInt32LE(4);
  const out = [];

  for (let i = 0; i < unique; i++) {
    // Between strings, so any boundary crossed here carries no flags byte.
    while (remaining() <= 0) nextSegment(false);
    if (remaining() < 3) throw new Error('shared string header split across a CONTINUE boundary');

    let cch = segments[seg].readUInt16LE(pos);
    const flags = segments[seg].readUInt8(pos + 2);
    pos += 3;
    wide = (flags & 0x01) !== 0;
    const rich = (flags & 0x08) !== 0;
    const ext = (flags & 0x04) !== 0;

    let runs = 0;
    let extLen = 0;
    if (rich) {
      runs = segments[seg].readUInt16LE(pos);
      pos += 2;
    }
    if (ext) {
      extLen = segments[seg].readUInt32LE(pos);
      pos += 4;
    }

    let s = '';
    while (cch > 0) {
      // A boundary reached with characters still owed is mid-string, so a flags byte follows and
      // the remaining characters may change width.
      if (remaining() < (wide ? 2 : 1)) nextSegment(true);
      const width = wide ? 2 : 1;
      const take = Math.min(cch, Math.floor(remaining() / width));
      const slice = segments[seg].subarray(pos, pos + take * width);
      s += wide ? slice.toString('utf16le') : latin1ToString(slice);
      pos += take * width;
      cch -= take;
    }

    // Formatting runs and phonetic data trail the characters. Crossing a boundary while skipping
    // them is still mid-string as far as the record layout is concerned.
    let skip = runs * 4 + extLen;
    while (skip > 0) {
      if (remaining() <= 0) nextSegment(true);
      const take = Math.min(skip, remaining());
      pos += take;
      skip -= take;
    }
    out.push(s);
  }
  return out;
}

/** Compressed BIFF strings are code page 1252-ish; the BTC list stays inside ASCII. */
function latin1ToString(buf) {
  return buf.toString('latin1');
}

/**
 * Renders a number as its stored text.
 *
 * `String` already does the right thing in both directions: an integral double prints as "45342"
 * rather than "45342.0", and a fractional one keeps its digits. Kept as a named function so the
 * intent is explicit at the call sites, which is that a date serial stays a serial and is never
 * reinterpreted as a date here.
 */
function numberToCell(n) {
  return String(n);
}

/**
 * Reads an .xls into `{ sheetName: rows }`, each row an array of strings.
 *
 * Rows are dense and rectangular per row: gaps become empty strings so callers can index by column.
 */
export function readLegacyWorkbook(buf) {
  const streams = readCompoundFile(buf);
  const wb = streams.Workbook ?? streams.Book;
  if (!wb) throw new Error('no Workbook stream: not an .xls');

  const recs = records(wb);

  // Sheet names and the offset of each sheet's own BOF, in the global substream.
  const sheets = [];
  for (const r of recs) {
    if (r.type !== REC.BOUNDSHEET) continue;
    const pos = r.data.readUInt32LE(0);
    const cch = r.data.readUInt8(6);
    const flags = r.data.readUInt8(7);
    const wide = (flags & 0x01) !== 0;
    const chars = r.data.subarray(8, 8 + cch * (wide ? 2 : 1));
    sheets.push({ name: wide ? chars.toString('utf16le') : latin1ToString(chars), pos });
  }

  // The shared string table lives in the global substream, before the sheets.
  let shared = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].type !== REC.SST) continue;
    const cont = [];
    for (let j = i + 1; j < recs.length && recs[j].type === REC.CONTINUE; j++) cont.push(recs[j].data);
    shared = readSharedStrings(recs[i].data, cont);
    break;
  }

  // Walk each sheet's substream from its recorded byte offset.
  const out = {};
  for (const sh of sheets) {
    const cells = new Map(); // row -> Map(col -> string)
    let maxRow = -1;
    const put = (row, col, value) => {
      if (!cells.has(row)) cells.set(row, new Map());
      cells.get(row).set(col, value);
      if (row > maxRow) maxRow = row;
    };

    let p = sh.pos;
    let started = false;
    while (p + 4 <= wb.length) {
      const type = wb.readUInt16LE(p);
      const len = wb.readUInt16LE(p + 2);
      const data = wb.subarray(p + 4, p + 4 + len);
      p += 4 + len;

      if (type === REC.BOF) {
        if (started) break; // the next substream began; this sheet is done
        started = true;
        continue;
      }
      if (type === REC.EOF) break;

      switch (type) {
        case REC.LABELSST:
          put(data.readUInt16LE(0), data.readUInt16LE(2), shared[data.readUInt32LE(6)] ?? '');
          break;
        case REC.LABEL: {
          const cch = data.readUInt16LE(6);
          const wide = (data.readUInt8(8) & 0x01) !== 0;
          const chars = data.subarray(9, 9 + cch * (wide ? 2 : 1));
          put(
            data.readUInt16LE(0),
            data.readUInt16LE(2),
            wide ? chars.toString('utf16le') : latin1ToString(chars),
          );
          break;
        }
        case REC.RK:
          put(data.readUInt16LE(0), data.readUInt16LE(2), numberToCell(decodeRk(data.readInt32LE(6))));
          break;
        case REC.MULRK: {
          const row = data.readUInt16LE(0);
          const first = data.readUInt16LE(2);
          const count = (data.length - 6) / 6;
          for (let i = 0; i < count; i++) {
            const rk = data.readInt32LE(4 + i * 6 + 2);
            put(row, first + i, numberToCell(decodeRk(rk)));
          }
          break;
        }
        case REC.NUMBER:
          put(data.readUInt16LE(0), data.readUInt16LE(2), numberToCell(data.readDoubleLE(6)));
          break;
        default:
          break; // every other record type is irrelevant here
      }
    }

    const rows = [];
    for (let r = 0; r <= maxRow; r++) {
      const row = cells.get(r);
      if (!row) {
        rows.push([]);
        continue;
      }
      const width = Math.max(...row.keys()) + 1;
      rows.push(Array.from({ length: width }, (_, c) => row.get(c) ?? ''));
    }
    out[sh.name] = rows;
  }
  return out;
}

export const _internals = { decodeRk, readSharedStrings, records };
