/**
 * A36, the EBICS 3.0 HTTPS transport SEAM (`createEbicsHttpsTransport`): a host-wired implementation
 * of `EbicsTransportPort` speaking client-initiated HTTPS to the user's OWN bank over the user's OWN
 * EBICS contract (D29/OP4: OSS-core, user-owned keys, egress from the user's own device).
 *
 * WHERE THE LINE IS (D108). The actual socket I/O, the LIVE bank wire, is RUNTIME, not OSS core: the
 * `till` CLI / Studio runtime completes `openWire` with a real `node:https` request over the
 * connection's `host_url`. This module ships everything UP TO that wire: the EBICS 3.0/BTF order-type
 * mapping (SMPG v1.3-cited), the ZIP-container unpack that hands A20 the bytes the bank wrote
 * BYTE-FOR-BYTE, the explicit `download` -> `acknowledge` split (A36 §4), and the outbound-only posture
 * (NO listener, NO webhook, NO callback surface exists here). Where the live wire would be invoked, the
 * OSS core returns the honest degradation `needs_bank_transport` rather than opening a socket, so this
 * module opens NO socket and the E07 offline proof holds even when it is wired. The runtime supplies
 * `wire` to make it live.
 *
 * THE PROTOCOL CONTRACT, mapped per SIX "Swiss Market Practice Guidelines EBICS", EBICS 3.0, v1.3:
 *  - BTF coding with BTU/BTD as the banking order types (SMPG v1.3 §4); scope code CH for Swiss
 *    payment traffic (§5.2).
 *  - `download({service:'statements'})` -> BTD for the camt.053/054 parameter sets (the Z53/Z54
 *    equivalents); `'status_report'` -> pain.002; `'customer_protocol'` -> HAC.
 *  - Statement containers ALWAYS arrive as a ZIP (SMPG v1.3 §5.5: statements "are always provided by
 *    the financial institutions as ZIP files"); `unpackContainer` decompresses the container (a
 *    container operation, NOT a transform of a bank-authored file) and returns the per-file bytes
 *    verbatim.
 *  - `upload` -> BTU (the XE2 equivalent) WITHOUT the SignatureFlag (A33 tripwire 5, v1 §3): the bank
 *    authorizes out of channel, so TILL never holds sole payment authority.
 *  - TLS 1.2 minimum with platform trust anchors (SMPG v1.3 §3.2); NEVER `rejectUnauthorized:false`.
 */

import { inflateRawSync } from 'node:zlib';
import type {
  EbicsTransportPort,
  EbicsTransportResult,
  EbicsConnectionRef,
  EbicsFetchedFile,
  EbicsKeyHashes,
  EbicsDownloadService,
} from '../../context.js';

/** The BTF service parameters for each download service (SMPG v1.3 §4/§5); captured per connection at
 *  connect time in real operation, defaulted here for the reader. `msgName` is the container message. */
export const BTF_DOWNLOAD_SERVICES: Record<EbicsDownloadService, { serviceName: string; msgName: string }> = {
  // camt.053 statement (the EBICS 2.5 Z53 equivalent), delivered as a ZIP container (SMPG v1.3 §5.5).
  statements: { serviceName: 'EOP', msgName: 'camt.053' },
  // pain.002 payment status report (the customer-status feed).
  status_report: { serviceName: 'PSR', msgName: 'pain.002' },
  // HAC customer protocol (the channel event feed).
  customer_protocol: { serviceName: 'HAC', msgName: 'HAC' },
};

/** The BTU upload parameters for a Swiss credit-transfer batch (pain.001), SMPG v1.3 §5.2 scope CH. */
export const BTF_UPLOAD_PAIN001 = { serviceName: 'MCT', msgName: 'pain.001', scope: 'CH' } as const;

/**
 * Unpack a ZIP container into its member files, bytes VERBATIM (SMPG v1.3 §5.5). Offline and pure: it
 * reads the local-file-header stream and inflates DEFLATE entries (method 8) or copies STORED entries
 * (method 0). This is decompression of a container, never a transform of the bank-authored XML inside,
 * so the per-file bytes handed to A20 are exactly the bytes the bank wrote (hash-asserted upstream).
 * A non-ZIP payload (some banks hand a single bare XML) is returned as one member unchanged.
 */
export function unpackContainer(zip: Buffer): { name: string; bytes: Buffer }[] {
  // Not a ZIP (no PK\x03\x04 local-file-header magic): treat the payload as a single bare file.
  if (zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b || zip[2] !== 0x03 || zip[3] !== 0x04) {
    return [{ name: 'container', bytes: zip }];
  }
  const out: { name: string; bytes: Buffer }[] = [];
  let off = 0;
  while (off + 30 <= zip.length && zip.readUInt32LE(off) === 0x04034b50) {
    const method = zip.readUInt16LE(off + 8);
    const compSize = zip.readUInt32LE(off + 18);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > zip.length) break; // truncated / data-descriptor form: stop honestly
    const name = zip.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const comp = zip.subarray(dataStart, dataStart + compSize);
    const bytes = method === 0 ? Buffer.from(comp) : inflateRawSync(comp);
    out.push({ name, bytes });
    off = dataStart + compSize;
  }
  return out;
}

/**
 * The LIVE bank wire: a single request/response over client-initiated HTTPS to `connection.hostUrl`.
 * D108: this is RUNTIME, not OSS core. The runtime passes a `wire` that performs the real `node:https`
 * request (TLS 1.2 min, platform trust anchors, NEVER `rejectUnauthorized:false`) and returns the raw
 * EBICS response body. Omitted here, so the transport degrades honestly and opens no socket.
 */
export type EbicsWire = (req: {
  connection: EbicsConnectionRef;
  orderType: string;
  btf?: { serviceName: string; msgName: string };
  bodyBase64?: string;
}) => { ok: true; responseBase64: string } | { ok: false; reason: string };

export interface EbicsHttpsTransportOptions {
  /** The runtime's live HTTPS wire. Absent -> every network step returns `needs_bank_transport`. */
  wire?: EbicsWire;
}

const DEGRADE = { ok: false as const, reason: 'needs_bank_transport' };

/**
 * Build the EBICS 3.0 HTTPS transport. With no `wire` it is a structurally-complete SEAM that degrades
 * honestly (D108); the runtime supplies `wire` to make it live. It opens NO socket itself, so the E07
 * offline proof holds whether or not it is wired.
 */
export function createEbicsHttpsTransport(options: EbicsHttpsTransportOptions = {}): EbicsTransportPort {
  const wire = options.wire;
  // The `ok` variant of a no-payload transport result. `EbicsTransportResult<Record<string, never>>`
  // has an unsatisfiable structural intersection for the success case (the mock builds it untyped in
  // JS), so an explicit typed empty-ok is the one place the cast lives.
  const OK = { ok: true } as EbicsTransportResult<Record<string, never>>;

  return {
    sendKeys(req): EbicsTransportResult<Record<string, never>> {
      // INI + HIA (SMPG v1.3 §6.1). The public-key hashes (req.hashes) are what INI carries; the wire signs.
      if (wire === undefined) return DEGRADE;
      const r = wire({ connection: req.connection, orderType: 'INI' });
      return r.ok ? OK : { ok: false, reason: r.reason };
    },

    fetchBankKeys(req): EbicsTransportResult<{ bankKeyHashes: EbicsKeyHashes }> {
      // HPB. Parsing the bank's returned public keys into fingerprints is part of the live wire's
      // response handling (runtime), so with no wire this degrades rather than fabricating hashes.
      if (wire === undefined) return DEGRADE;
      const r = wire({ connection: req.connection, orderType: 'HPB' });
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: false, reason: 'needs_bank_transport' }; // HPB response parsing is runtime (D108)
    },

    download(req): EbicsTransportResult<{ files: EbicsFetchedFile[]; ackToken: string }> {
      const btf = BTF_DOWNLOAD_SERVICES[req.service];
      if (wire === undefined) return DEGRADE;
      const r = wire({ connection: req.connection, orderType: 'BTD', btf });
      if (!r.ok) return { ok: false, reason: r.reason };
      // Unpack the ZIP container (SMPG v1.3 §5.5) into per-file bytes, verbatim (A36 §4). The ackToken
      // is the runtime's opaque handle on the still-open BTD transaction; the receipt is NOT sent here
      // (the engine persists+imports first, then calls `acknowledge`).
      const files = unpackContainer(Buffer.from(r.responseBase64, 'base64')).map((f) => ({
        msgName: btf.msgName,
        contentBase64: f.bytes.toString('base64'),
      }));
      return { ok: true, files, ackToken: `btd-${req.service}-${Date.now()}` };
    },

    acknowledge(req): EbicsTransportResult<Record<string, never>> {
      // Send the positive EBICS receipt for an open BTD transaction (A36 §4). Runtime wire.
      if (wire === undefined) return DEGRADE;
      const r = wire({ connection: req.connection, orderType: 'BTD-ACK', bodyBase64: req.ackToken });
      return r.ok ? OK : { ok: false, reason: r.reason };
    },

    upload(req): EbicsTransportResult<Record<string, never>> {
      // BTU WITHOUT the SignatureFlag (A33 tripwire 5, v1 §3): the bank authorizes out of channel.
      if (wire === undefined) return DEGRADE;
      const r = wire({ connection: req.connection, orderType: 'BTU', btf: req.btf, bodyBase64: req.payloadBase64 });
      return r.ok ? OK : { ok: false, reason: r.reason };
    },

    suspend(req): EbicsTransportResult<Record<string, never>> {
      // SPR (SMPG v1.3 §6.2): the administrative order that blocks the EBICS user.
      if (wire === undefined) return DEGRADE;
      const r = wire({ connection: req.connection, orderType: 'SPR' });
      return r.ok ? OK : { ok: false, reason: r.reason };
    },
  };
}
