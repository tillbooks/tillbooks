/**
 * A PURE zip container reader over bytes (G18 US-G18.3 and the xlsx container in US-G18.2).
 *
 * NO `node:fs`, NO socket. The only Node built-in here is `node:zlib`'s synchronous `inflateRawSync`,
 * which is a pure byte transform (the DEFLATE codec), not file or network I/O: the adapter-purity test
 * forbids `fs`/sockets, and `zlib` is neither. Everything is done over the in-memory `Uint8Array`.
 *
 * WHY A HAND-ROLLED READER RATHER THAN A DEPENDENCY. The clean-room, MIT, local-first posture wants no
 * new third-party parser in the money path's neighbourhood, and a zip's structure is small: an
 * End-Of-Central-Directory record points at the central directory, whose entries name each member and
 * point at its local header, after which the compressed bytes sit. Reading it is a few field offsets.
 *
 * THE ZIP-BOMB GUARD IS CHECKED WHILE INFLATING, NEVER AFTER (spec §2 US-G18.3). `inflateRawSync` is
 * given a `maxOutputLength`, so a member that would inflate past the ceiling throws DURING inflation
 * and is reported as an unparseable member, rather than being fully expanded into memory and measured
 * afterwards. A running total across members enforces the same ceiling for the bundle as a whole.
 */

import { inflateRawSync } from 'node:zlib';

/** One member of a zip. `bytes` is present when it inflated within the ceiling; `error` names why not. */
export interface ZipMember {
  readonly name: string;
  readonly bytes?: Uint8Array;
  readonly error?: string;
}

export interface ZipResult {
  readonly ok: true;
  readonly members: readonly ZipMember[];
}

export interface ZipContainerFailure {
  readonly ok: false;
  readonly reason: string;
}

/** The inflated-size ceiling, matching the migration-class blob ceiling (US-G18.4). */
export const MAX_INFLATED_BYTES = 500 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function u16(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;
}

/** Find the End-Of-Central-Directory record, scanning backwards over the (bounded) comment tail. */
function findEocd(b: Uint8Array): number {
  // The comment is at most 0xffff bytes, so the EOCD's fixed 22-byte head starts no earlier than that.
  const min = Math.max(0, b.length - (0xffff + 22));
  for (let i = b.length - 22; i >= min; i--) {
    if (u32(b, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Unpack a zip's members. Returns a container failure only when the bytes are not a zip at all (no
 * EOCD); an empty zip is `{ok:true, members:[]}`. A member that fails to inflate, or would exceed the
 * ceiling, is returned with its `error` set and the rest are still unpacked (US-G18.3 error boundary).
 * Directory entries (names ending in `/`) are skipped: they carry no bytes.
 */
export function unzip(input: Uint8Array, opts: { maxTotal?: number } = {}): ZipResult | ZipContainerFailure {
  const maxTotal = opts.maxTotal ?? MAX_INFLATED_BYTES;
  const b = input;
  const eocd = findEocd(b);
  if (eocd < 0) return { ok: false, reason: 'not_a_zip' };
  const count = u16(b, eocd + 10);
  let cd = u32(b, eocd + 16);
  const members: ZipMember[] = [];
  let totalInflated = 0;

  for (let n = 0; n < count; n++) {
    if (cd + 46 > b.length || u32(b, cd) !== CDH_SIG) break;
    const method = u16(b, cd + 10);
    const compSize = u32(b, cd + 20);
    const uncompSize = u32(b, cd + 24);
    const fnLen = u16(b, cd + 28);
    const extraLen = u16(b, cd + 30);
    const commentLen = u16(b, cd + 32);
    const lho = u32(b, cd + 42);
    const name = new TextDecoder('utf-8').decode(b.subarray(cd + 46, cd + 46 + fnLen));
    cd = cd + 46 + fnLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // a directory entry, no data

    // A declared uncompressed size already past the remaining ceiling is refused BEFORE inflating.
    if (uncompSize > maxTotal - totalInflated) {
      members.push({ name, error: 'inflated_size_exceeds_ceiling' });
      continue;
    }
    if (u32(b, lho) !== LFH_SIG) {
      members.push({ name, error: 'corrupt' });
      continue;
    }
    const lfnLen = u16(b, lho + 26);
    const lextraLen = u16(b, lho + 28);
    const dataStart = lho + 30 + lfnLen + lextraLen;
    const comp = b.subarray(dataStart, dataStart + compSize);
    try {
      let bytes: Uint8Array;
      if (method === 0) {
        bytes = comp; // stored, no compression
        if (bytes.byteLength > maxTotal - totalInflated) {
          members.push({ name, error: 'inflated_size_exceeds_ceiling' });
          continue;
        }
      } else if (method === 8) {
        // The ceiling is enforced DURING inflation: a bomb throws here rather than filling memory.
        bytes = inflateRawSync(comp, { maxOutputLength: Math.max(1, maxTotal - totalInflated) });
      } else {
        members.push({ name, error: 'unsupported_compression' });
        continue;
      }
      totalInflated += bytes.byteLength;
      members.push({ name, bytes });
    } catch {
      members.push({ name, error: 'corrupt' });
    }
  }
  return { ok: true, members };
}
