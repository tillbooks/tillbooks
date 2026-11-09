// A36 test support: SYNTHETIC camt.053 day-end statements, a ZIP container writer, and an in-process
// EBICS transport port (contract 2: HEV, INI and HIA as separate legs, HPB, BTD with a TransactionID,
// BTD-ACK with a receipt code) for the channel suites.
//
// Synthetic by construction (CLAUDE.md, private data never ships): invented IBANs over the clearing
// number 09999 that no Swiss bank uses, invented names, amounts, references and message ids, written
// to the published SPS camt.053.001.08 structure.

import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { readZipContainer } from '../../dist/core/banking/ebics/transport-https.js';

// --- IBANs ---------------------------------------------------------------------------------------

function mod97(numeric) {
  let r = 0;
  for (const ch of numeric) r = (r * 10 + Number(ch)) % 97;
  return r;
}

/** A Swiss-format IBAN with valid check digits over the synthetic clearing number 09999. */
export function syntheticIban(accountNumber) {
  const account = String(accountNumber).padStart(12, '0').slice(-12);
  const bban = `09999${account}`;
  const check = String(98 - mod97(`${bban}121700`)).padStart(2, '0');
  return `CH${check}${bban}`;
}

// --- camt.053 -------------------------------------------------------------------------------------

function amount(minor) {
  const abs = Math.abs(minor);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function balance(code, minor, date, currency, intermediate) {
  return (
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry>${intermediate ? '<SubTp><Cd>INTM</Cd></SubTp>' : ''}</Tp>` +
    `<Amt Ccy="${currency}">${amount(minor)}</Amt><CdtDbtInd>${minor < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>` +
    `<Dt><Dt>${date}</Dt></Dt></Bal>`
  );
}

function entry(e, date, currency, ref) {
  const credit = e.minor >= 0;
  return (
    `<Ntry><Amt Ccy="${currency}">${amount(e.minor)}</Amt><CdtDbtInd>${credit ? 'CRDT' : 'DBIT'}</CdtDbtInd>` +
    `<RvslInd>false</RvslInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt>` +
    `<AcctSvcrRef>${ref}</AcctSvcrRef>` +
    `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${credit ? 'RCDT' : 'ICDT'}</Cd><SubFmlyCd>AUTT</SubFmlyCd></Fmly></Domn></BkTxCd>` +
    `<NtryDtls><TxDtls><Refs><AcctSvcrRef>${ref}-1</AcctSvcrRef><EndToEndId>NOTPROVIDED</EndToEndId></Refs>` +
    `<Amt Ccy="${currency}">${amount(e.minor)}</Amt><CdtDbtInd>${credit ? 'CRDT' : 'DBIT'}</CdtDbtInd>` +
    `<RmtInf><Ustrd>${e.text ?? 'Synthetische Buchung'}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`
  );
}

/**
 * One synthetic camt.053.001.08 day-end statement, as a string.
 *  - `seq` is `ElctrncSeqNb` (omit with `seq: null`), `date` the statement day.
 *  - `toNextMidnight` writes `ToDtTm` as the next day's 00:00 (ZKB may), else 23:59:59.
 *  - `page` writes `GrpHdr/MsgPgntn` (and INTM balances between pages); `stmtPage` writes `Stmt/StmtPgntn`.
 *  - `closing` overrides the computed CLBD (for an inconsistent statement); `noClosing` drops CLBD.
 *  - `msgId` / `stmtId` override the identifiers (a re-created copy keeps the number, not the id).
 */
export function camt053({
  iban,
  seq,
  date,
  opening,
  entries = [],
  currency = 'CHF',
  msgId,
  stmtId,
  page,
  stmtPage,
  toNextMidnight = false,
  closing,
  noClosing = false,
  copy = false,
}) {
  const id = msgId ?? `SYN${date.replace(/-/g, '')}${String(seq ?? 0).padStart(4, '0')}`;
  const close = closing ?? opening + entries.reduce((sum, e) => sum + e.minor, 0);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const toDtTm = toNextMidnight ? `${next.toISOString().slice(0, 10)}T00:00:00+01:00` : `${date}T23:59:59+01:00`;
  const msgPgntn = page === undefined ? '' : `<MsgPgntn><PgNb>${page.number}</PgNb><LastPgInd>${page.last}</LastPgInd></MsgPgntn>`;
  const stmtPgntn = stmtPage === undefined ? '' : `<StmtPgntn><PgNb>${stmtPage.number}</PgNb><LastPgInd>${stmtPage.last}</LastPgInd></StmtPgntn>`;
  const year = date.slice(0, 4);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>` +
    `<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${date}T23:30:00+01:00</CreDtTm>${msgPgntn}</GrpHdr>` +
    `<Stmt><Id>${stmtId ?? `${id}-S`}</Id>${stmtPgntn}${seq === null || seq === undefined ? '' : `<ElctrncSeqNb>${seq}</ElctrncSeqNb>`}` +
    `${copy ? '<CpyDplcInd>DUPL</CpyDplcInd>' : ''}<CreDtTm>${date}T23:30:00+01:00</CreDtTm>` +
    `<FrToDt><FrDtTm>${date}T00:00:00+01:00</FrDtTm><ToDtTm>${toDtTm}</ToDtTm></FrToDt>` +
    `<Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>${currency}</Ccy><Ownr><Nm>Synthetische Test GmbH</Nm></Ownr></Acct>` +
    balance('OPBD', opening, date, currency, page !== undefined && page.number > 1) +
    (noClosing ? '' : balance('CLBD', close, date, currency, page !== undefined && !page.last)) +
    entries.map((e, k) => entry(e, date, currency, `SYN-${year}-${seq ?? 'x'}-${k + 1}-${iban.slice(-4)}`)).join('') +
    `</Stmt></BkToCstmrStmt></Document>`
  );
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Consecutive day-end statements whose balances chain (each OPBD is the previous CLBD); numbers restart
 * at 1 on a year turn. Returns [{ seq, date, opening, closing, xml }].
 */
export function chain({ iban, firstSeq, firstDate, opening, days }) {
  const out = [];
  let seq = firstSeq;
  let date = firstDate;
  let bal = opening;
  for (let k = 0; k < days.length; k += 1) {
    if (k > 0) {
      const next = addDays(date, 1);
      seq = next.slice(0, 4) !== date.slice(0, 4) ? 1 : seq + 1;
      date = next;
    }
    const entries = days[k] ?? [];
    const xml = camt053({ iban, seq, date, opening: bal, entries });
    const closing = bal + entries.reduce((sum, e) => sum + e.minor, 0);
    out.push({ seq, date, opening: bal, closing, xml });
    bal = closing;
  }
  return out;
}

// --- ZIP ------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A real ZIP (local headers, central directory, end record). `deflate` compresses members;
 * `dataDescriptor` writes each member with general-purpose bit 3 (zero CRC and sizes in the local
 * header, the real values after the data), the shape the old core reader stopped at.
 */
export function zip(entries, { deflate = true, dataDescriptor = false, corruptCrc = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const bytes = Buffer.from(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const body = deflate ? deflateRawSync(bytes) : bytes;
    const crc = corruptCrc ? (crc32(bytes) ^ 0x1) >>> 0 : crc32(bytes);
    const flags = dataDescriptor ? 0x0008 : 0;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(dataDescriptor ? 0 : body.length, 18);
    local.writeUInt32LE(dataDescriptor ? 0 : bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const parts = [local, nameBytes, body];
    if (dataDescriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(bytes.length, 12);
      parts.push(dd);
    }
    const localAll = Buffer.concat(parts);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    locals.push(localAll);
    offset += localAll.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A container of camt.053 statements, named the way ZKB names members (by pickup date). */
export function container(xmls, opts = {}) {
  const stamp = opts.stamp ?? '20261001';
  return zip(
    xmls.map((xml, k) => ({ name: `camt.053_${stamp}_${String(k + 1).padStart(3, '0')}.xml`, data: Buffer.from(xml, 'utf8') })),
    opts,
  );
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// --- the in-process EBICS transport (contract 2) -------------------------------------------------

export const BANK_HASHES = Object.freeze({
  electronicSignature: '',
  authentication: 'a'.repeat(64),
  encryption: 'b'.repeat(64),
  certificateHashes: { authentication: 'c'.repeat(64), encryption: 'd'.repeat(64) },
  keyHashes: { authentication: 'e'.repeat(64), encryption: 'f'.repeat(64) },
});

/**
 * An in-process bank behind the core's `EbicsTransportPort`. Statements stay on offer until a POSITIVE
 * receipt; each download opens a new TransactionID. `log` records every call in order, and a test's
 * `note(label)` interleaves its own events, so "no receipt before the commit" is assertable.
 *
 * Faults, each one-shot unless noted: `nextLeg(leg, result)`, `nextHpb(result)`, `nextDownload(result)`
 * (a result, `'throw'`, `'throw-after-deliver'` or `'replay-last'`), `nextAck(result)`;
 * `state.throwOnAck = true`, `state.onAck = (req) => ...` and `state.hev = result` are sticky.
 */
export function mockBank({ bankHashes = BANK_HASHES } = {}) {
  const log = [];
  const offers = [];
  const receipts = [];
  const faults = { legs: [], hpb: [], download: [], ack: [] };
  const state = { bankHashes: structuredClone(bankHashes), hev: null, throwOnAck: false, onAck: null, lastAnswer: null, transactions: new Map() };
  const take = (list, pred = () => true) => {
    const i = list.findIndex(pred);
    return i === -1 ? undefined : list.splice(i, 1)[0];
  };
  const port = {
    hostVersions(req) {
      log.push({ kind: 'HEV' });
      return state.hev ?? { ok: true };
    },
    sendKeyLeg(req) {
      log.push({ kind: req.leg, connection: req.connection });
      const f = take(faults.legs, (x) => x.leg === req.leg);
      if (f !== undefined) {
        if (f.result === 'throw') throw new Error(`the ${req.leg} answer was lost`);
        return f.result;
      }
      return { ok: true };
    },
    fetchBankKeys(req) {
      log.push({ kind: 'HPB', pin: req.connection.bankKeyHashes ?? null });
      const f = take(faults.hpb);
      if (f !== undefined) return f;
      return { ok: true, bankKeyHashes: structuredClone(state.bankHashes) };
    },
    download(req) {
      log.push({ kind: 'BTD', service: req.service, pin: req.connection.bankKeyHashes ?? null });
      const f = take(faults.download);
      if (f !== undefined && f !== 'throw-after-deliver' && f !== 'replay-last') {
        if (f === 'throw') throw new Error('the download answer was lost');
        return f;
      }
      if (f === 'replay-last') {
        // A genuine, earlier answer served again (the wire's replay record lives for one process only).
        if (state.lastAnswer === null) throw new Error('nothing to replay');
        return structuredClone(state.lastAnswer);
      }
      const offer = offers.find((o) => !o.receipted);
      if (offer === undefined) return { ok: false, reason: 'bank_code', codes: { technical: '000000', business: '090005' }, phase: 'Initialisation' };
      const transactionId = randomBytes(16).toString('hex').toUpperCase();
      state.transactions.set(transactionId, offer);
      offer.transactions.push(transactionId);
      // The bank delivered, and the process died before it saw the answer: no persist, no receipt.
      if (f === 'throw-after-deliver') throw new Error('the process died after the download');
      // The members as the core's transport hands them over (central directory, count and CRC checks).
      const read = readZipContainer(offer.bytes);
      if (!read.ok) return { ok: false, reason: 'untrusted_response', detail: `order_data_integrity: ${read.reason}`, phase: 'Initialisation' };
      const files = read.members.map((m) => ({ name: m.name, msgName: 'camt.053', contentBase64: m.bytes.toString('base64') }));
      const answer = { ok: true, transactionId, containerBase64: offer.bytes.toString('base64'), files };
      state.lastAnswer = structuredClone(answer);
      return answer;
    },
    acknowledge(req) {
      log.push({ kind: 'BTD-ACK', transactionId: req.transactionId, receiptCode: req.receiptCode, pin: req.connection.bankKeyHashes ?? null });
      if (state.onAck !== null) state.onAck(req);
      if (state.throwOnAck) throw new Error('the receipt never left');
      const f = take(faults.ack);
      if (f !== undefined) return f;
      receipts.push({ transactionId: req.transactionId, receiptCode: req.receiptCode });
      const offer = state.transactions.get(req.transactionId);
      if (offer !== undefined && req.receiptCode === 0) offer.receipted = true;
      return { ok: true };
    },
  };
  return {
    port,
    log,
    receipts,
    offers,
    state,
    offer(bytes) {
      const o = { bytes: Buffer.from(bytes), receipted: false, transactions: [] };
      offers.push(o);
      return o;
    },
    note(label) {
      log.push({ kind: 'NOTE', label });
    },
    nextLeg(leg, result) {
      faults.legs.push({ leg, result });
    },
    nextHpb(result) {
      faults.hpb.push(result);
    },
    nextDownload(result) {
      faults.download.push(result);
    },
    nextAck(result) {
      faults.ack.push(result);
    },
    rotateKeys() {
      state.bankHashes = { ...state.bankHashes, authentication: '1'.repeat(64), encryption: '2'.repeat(64), certificateHashes: { authentication: '3'.repeat(64), encryption: '4'.repeat(64) } };
    },
  };
}

/** A BTD refusal the way the wire reports one (raw codes). */
export function bankCode(code, level = 'business') {
  return {
    ok: false,
    reason: 'bank_code',
    codes: level === 'technical' ? { technical: code, business: null } : { technical: '000000', business: code },
    phase: 'Initialisation',
  };
}
