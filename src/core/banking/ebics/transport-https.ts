/**
 * A36, the EBICS 3.0 (H005) transport SEAM (`createEbicsHttpsTransport`): the host-wired implementation
 * of `EbicsTransportPort` over the private live wire (contract version 2, download only). D29/OP4:
 * OSS core, user-owned keys, egress from the user's own device.
 *
 * WHERE THE LINE IS (D108). The socket, the envelopes, the signatures, the response verification and
 * the order-data crypto are RUNTIME: the private `@tillbooks/ebics-wire` module the host loads through
 * `TILL_EBICS_RUNTIME` (`src/api/host-runtime.ts`). This module ships everything up to that wire: the
 * order-type mapping, the ONE statement BTF, the ZIP container reader that hands A20 the bytes the bank
 * wrote, and the contract checks the core owes the wire (A36-7 W2). With no wire every network step
 * answers `needs_bank_transport`, so this module opens NO socket and the E07 offline proof holds.
 *
 * THE CONTRACT (wire `docs/design-decisions.md` A36-2, A36-7):
 *  - HEV lists the host's EBICS versions: `ok` with H005, else `unsupported_ebics_version`.
 *  - INI and HIA are SEPARATE legs, each confirmed only by 000000 at both levels; every other answer
 *    comes back raw as `codes: {technical, business}` and the core decides (§4.2).
 *  - BTD requests exactly EOP / CH / ZIP / camt.053 version 08 and returns the VERIFIED container and
 *    the bank's TransactionID, the receipt handle. A success without a TransactionID of 32 hex digits
 *    is `ebics_wire_contract_error` (W2): nothing is used and no receipt can follow.
 *  - BTD-ACK takes that TransactionID and an explicit receipt code: 0 once the core's commit is
 *    durable, 1 after a failed commit. Never a processing outcome.
 *  - No upload of any kind and no SPR (D-A36.11, D-A36.12): the port has no method for either.
 *
 * THE CONTAINER (SMPG v1.3 §5.5: statements "are always provided ... as ZIP files"). `readZipContainer`
 * reads the members from the CENTRAL DIRECTORY (so a member written with a data descriptor, general
 * purpose bit 3, is read, where the old local-header walk stopped silently), checks the member count
 * against the end record, refuses encryption, anything but STORE and DEFLATE, and an unclean member
 * name, and checks every member's CRC-32 and size. The wire checks the same container before it
 * returns it; this is the core's own line, and a failure here is `untrusted_response` (§4.3 step 2).
 */

import { inflateRawSync } from 'node:zlib';
import type {
  EbicsTransportPort,
  EbicsTransportResult,
  EbicsConnectionRef,
  EbicsFetchedFile,
  EbicsKeyHashes,
  EbicsBtf,
  EbicsReturnCodes,
} from '../../context.js';

export type { EbicsBtf } from '../../context.js';

/**
 * The ONE download service (D-A36.3): ZKB's `EOP_CH_camt.053_08_-_ZIP`. Fixed in code: there is no
 * capture path and `ebics_connection.btf_params` stays unused. Frozen, so no caller can widen it.
 */
export const STATEMENT_BTF: Readonly<EbicsBtf> = Object.freeze({
  serviceName: 'EOP',
  msgName: 'camt.053',
  scope: 'CH',
  msgVersion: '08',
  containerType: 'ZIP',
});

/** A receipt handle: the bank's TransactionID, 16 octets as 32 hex digits (EBICS hexBinary). */
const TRANSACTION_ID = /^[0-9A-Fa-f]{32}$/;

// --- the ZIP container -------------------------------------------------------------------------

/** The most members a statement container may carry (a day per member; ZKB delivers far fewer). */
export const MAX_CONTAINER_MEMBERS = 4096;
/** The most bytes one member may inflate to (a camt.053 day-end statement is far smaller). */
export const MAX_MEMBER_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A clean relative member name: no control character, backslash, absolute path, drive or dot segment. */
function cleanMemberName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export type ZipReadResult = { ok: true; members: { name: string; bytes: Buffer }[] } | { ok: false; reason: string };

/**
 * Read a ZIP container's members from its central directory, verbatim (a container operation, never a
 * transform of the bank-authored XML inside). Pure and total: never throws, `{ok:false}` names why.
 */
export function readZipContainer(zip: Buffer): ZipReadResult {
  // The end-of-central-directory record: 22 bytes plus a comment of at most 65535 bytes, at the end.
  const minEnd = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= minEnd; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: 'no_end_of_central_directory' };
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) return { ok: false, reason: 'multi_disk_zip' };
  const count = zip.readUInt16LE(eocd + 10);
  if (zip.readUInt16LE(eocd + 8) !== count) return { ok: false, reason: 'member_count_mismatch' };
  if (count === 0) return { ok: false, reason: 'empty_container' };
  if (count > MAX_CONTAINER_MEMBERS) return { ok: false, reason: 'too_many_members' };
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) return { ok: false, reason: 'central_directory_out_of_range' };

  const members: { name: string; bytes: Buffer }[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) return { ok: false, reason: 'central_directory_truncated' };
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (p > eocd) return { ok: false, reason: 'central_directory_truncated' };

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) return { ok: false, reason: 'encrypted_member' };
    if (method !== 0 && method !== 8) return { ok: false, reason: 'unsupported_compression' };
    // A folder entry carries no statement: skipped, never imported.
    if (name.endsWith('/')) {
      if (size !== 0 || !cleanMemberName(name.slice(0, -1))) return { ok: false, reason: 'unclean_member_name' };
      continue;
    }
    if (!cleanMemberName(name)) return { ok: false, reason: 'unclean_member_name' };
    const folded = name.toLowerCase();
    if (seen.has(folded)) return { ok: false, reason: 'duplicate_member_name' };
    seen.add(folded);
    if (size > MAX_MEMBER_BYTES) return { ok: false, reason: 'member_too_large' };

    if (localOffset + 30 > cdOffset || zip.readUInt32LE(localOffset) !== 0x04034b50) return { ok: false, reason: 'local_header_missing' };
    const localFlags = zip.readUInt16LE(localOffset + 6);
    if ((localFlags & 0x0001) !== 0) return { ok: false, reason: 'encrypted_member' };
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > cdOffset) return { ok: false, reason: 'member_out_of_range' };
    const comp = zip.subarray(dataStart, dataStart + compSize);
    let bytes: Buffer;
    try {
      bytes = method === 0 ? Buffer.from(comp) : inflateRawSync(comp, { maxOutputLength: MAX_MEMBER_BYTES });
    } catch {
      return { ok: false, reason: 'member_inflate_failed' };
    }
    if (bytes.length !== size) return { ok: false, reason: 'member_size_mismatch' };
    if (crc32(bytes) !== crc) return { ok: false, reason: 'member_crc_mismatch' };
    members.push({ name, bytes });
  }
  if (members.length === 0) return { ok: false, reason: 'empty_container' };
  return { ok: true, members };
}

// --- the wire (contract version 2) -------------------------------------------------------------

/**
 * The LIVE bank wire, contract version 2 (the private module's `EbicsWire`): one EBICS order per call,
 * synchronous. D108: RUNTIME, not OSS core. The host passes the module's wire; omitted here, every
 * network step degrades honestly and no socket is opened.
 */
export type EbicsWire = (req: {
  connection: EbicsConnectionRef;
  orderType: string;
  btf?: EbicsBtf;
  transactionId?: string;
  receiptCode?: 0 | 1;
}) =>
  | { ok: true; responseBase64: string; transactionId?: string; codes?: EbicsReturnCodes }
  | { ok: false; reason: string; codes?: EbicsReturnCodes; phase?: string; detail?: string };

export interface EbicsHttpsTransportOptions {
  /** The runtime's live wire. Absent -> every network step returns `needs_bank_transport`. */
  wire?: EbicsWire;
}

const DEGRADE = { ok: false as const, reason: 'needs_bank_transport' };

/** Carry a wire failure through as the port's failure, fields and all (the core reads raw codes). */
function failure(r: { reason: string; codes?: EbicsReturnCodes; phase?: string; detail?: string }): {
  ok: false;
  reason: string;
  codes?: EbicsReturnCodes;
  phase?: string;
  detail?: string;
} {
  return {
    ok: false,
    reason: typeof r.reason === 'string' && r.reason.length > 0 ? r.reason : 'ebics_wire_contract_error',
    ...(r.codes !== undefined ? { codes: r.codes } : {}),
    ...(r.phase !== undefined ? { phase: r.phase } : {}),
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  };
}

/** The wire's answer, or a contract error when a drifted module returns anything but the result union. */
function shaped<T>(r: T): T | { ok: false; reason: string } {
  if (r === null || typeof r !== 'object' || typeof (r as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, reason: 'ebics_wire_contract_error' };
  }
  return r;
}

/**
 * Build the EBICS transport. With no `wire` it is a structurally complete SEAM that degrades honestly
 * (D108); the runtime supplies `wire` to make it live. It opens NO socket itself.
 */
export function createEbicsHttpsTransport(options: EbicsHttpsTransportOptions = {}): EbicsTransportPort {
  const wire = options.wire;
  // The `ok` variant of a no-payload result (the one place the structural cast lives).
  const OK = { ok: true } as EbicsTransportResult<Record<string, never>>;

  return {
    hostVersions(req): EbicsTransportResult<Record<string, never>> {
      if (wire === undefined) return DEGRADE;
      const r = shaped(wire({ connection: req.connection, orderType: 'HEV' }));
      return r.ok ? OK : failure(r);
    },

    sendKeyLeg(req): EbicsTransportResult<Record<string, never>> {
      if (wire === undefined) return DEGRADE;
      const r = shaped(wire({ connection: req.connection, orderType: req.leg }));
      return r.ok ? OK : failure(r);
    },

    fetchBankKeys(req): EbicsTransportResult<{ bankKeyHashes: EbicsKeyHashes }> {
      // HPB. Parsing the bank's public keys into hashes is the runtime's (`createEbicsTransport` in the
      // private module, composed in `host-runtime.ts`), so this seam never fabricates a hash.
      if (wire === undefined) return DEGRADE;
      const r = shaped(wire({ connection: req.connection, orderType: 'HPB' }));
      if (!r.ok) return failure(r);
      return { ok: false, reason: 'needs_bank_transport' };
    },

    download(req): EbicsTransportResult<{ transactionId: string; containerBase64: string; files: EbicsFetchedFile[] }> {
      if (wire === undefined) return DEGRADE;
      const r = shaped(wire({ connection: req.connection, orderType: 'BTD', btf: { ...STATEMENT_BTF } }));
      if (!r.ok) return failure(r);
      // W2: a download success names the transaction it opened, or it cannot be receipted and must not
      // be used. Refused before anything is persisted; no token is ever minted in its place.
      if (typeof r.transactionId !== 'string' || !TRANSACTION_ID.test(r.transactionId)) {
        return { ok: false, reason: 'ebics_wire_contract_error', detail: 'a BTD success without a TransactionID' };
      }
      if (typeof r.responseBase64 !== 'string' || r.responseBase64.length === 0) {
        return { ok: false, reason: 'ebics_wire_contract_error', detail: 'a BTD success without a container' };
      }
      const containerBytes = Buffer.from(r.responseBase64, 'base64');
      const read = readZipContainer(containerBytes);
      if (!read.ok) return { ok: false, reason: 'untrusted_response', detail: `order_data_integrity: ${read.reason}`, phase: 'Initialisation' };
      return {
        ok: true,
        transactionId: r.transactionId.toUpperCase(),
        containerBase64: containerBytes.toString('base64'),
        files: read.members.map((m) => ({ name: m.name, msgName: STATEMENT_BTF.msgName, contentBase64: m.bytes.toString('base64') })),
      };
    },

    acknowledge(req): EbicsTransportResult<Record<string, never>> {
      if (wire === undefined) return DEGRADE;
      const r = shaped(
        wire({ connection: req.connection, orderType: 'BTD-ACK', transactionId: req.transactionId, receiptCode: req.receiptCode }),
      );
      return r.ok ? OK : failure(r);
    },
  };
}
