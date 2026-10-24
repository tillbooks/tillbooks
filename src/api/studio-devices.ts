/**
 * How a browser gets the human seat without the Studio key ever leaving its owner-only file (D166).
 *
 * WHAT WENT WRONG IN THE FIRST CUTS, found by the security review one layer at a time:
 *
 *   - the key in `localStorage`: storage belongs to the ORIGIN `http://127.0.0.1:PORT`, and an origin on
 *     the loopback belongs to whoever holds the port. While TILL is down any program, under ANY account
 *     (ports are not per user), can bind it and read the storage when the person opens a bookmark;
 *   - the key in LINKS (`/#k=<key>`): a link lands in browser history, autocomplete and session restore.
 *     Opened again later, while a squatter holds the port, it hands over a key that, since D166, no
 *     longer dies with the process.
 *
 * THE DESIGN. The long-lived key stays in `<support dir>/studio.key`. What travels is worth nothing
 * a moment later:
 *
 *   1. TICKETS IN LINKS. Every link that opens the Studio carries a ONE-TIME ticket (`/#t=<ticket>`),
 *      never the key. The running host mints one when IT opens the Studio (the start, an OS reopen),
 *      and TILL.app (or a second `till up`) derives one from the key file: an HMAC of the key over this
 *      process's id (its pid and start time, from the lock) and a fresh nonce. A ticket is single-use,
 *      a host-minted one expires, and a derived one is good only for the process it names, so a ticket
 *      a squatter or a history entry keeps is dead by the time anyone could use it.
 *   2. REDEEM AND PAIR IN ONE STEP. The tab trades its ticket for a SESSION TOKEN (32 random bytes in
 *      this process's memory, kept by the tab in `sessionStorage`) and, in the same call, registers the
 *      PUBLIC half of a WebCrypto P-256 device key whose private half is NON-EXTRACTABLE (no script can
 *      read its bytes). The public halves live owner-only in `<support dir>/studio-devices.json`.
 *   3. UNLOCK. A bookmark or a new tab asks for a one-time challenge, signs it with the device key, and
 *      gets a session token. A restart forgets every token; the tab just unlocks again.
 *
 * WHAT A SQUATTER GETS: a device id (not a secret), a key handle it cannot export, and spent tickets.
 * It can sign only while its own code runs on the origin, and a challenge comes only from the real
 * TILL, which cannot run on the port the squatter holds. The residual no web page can close (critic
 * M1, DECISIONS D166): code a squatter got onto the origin in a BROWSER outlives the squatter, through
 * a page left open, the HTTP cache or a service worker, and runs again when the person next opens TILL
 * in that browser, same-origin with the real TILL and able to use the paired device. TILL.app is the
 * protected path: it proves the server (`prove`) before it loads anything, re-proves it while the
 * window is open, and clears the cache and service workers at launch.
 *
 * "Auf allen Geräten abmelden" forgets every device and every token and replaces the key.
 */

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type webcrypto } from 'node:crypto';
import { join } from 'node:path';

import { readOwnerOnlyFile, writeOwnerOnlyFile } from './studio-key-store.js';

type JsonWebKey = webcrypto.JsonWebKey;

export const STUDIO_DEVICES_FILE = 'studio-devices.json';

/** At most this many paired browsers; pairing a new one past it forgets the oldest. */
export const MAX_PAIRED_DEVICES = 32;
/** A challenge is good for this long, once. */
export const CHALLENGE_TTL_MS = 60_000;
/** A derived ticket is good for this long after the time it names (critic L2: no ticket lives for a whole process). */
export const DERIVED_TICKET_TTL_MS = 10 * 60_000;
/** At most this many open challenges PER DEVICE (critic L3: flooding one device id evicts only its own). */
export const MAX_CHALLENGES_PER_DEVICE = 4;
/** A host-minted ticket is good for this long, once (the terminal banner's link may be opened late). */
export const TICKET_TTL_MS = 10 * 60_000;
/** Bounds on what a caller can make this host remember. The oldest entry is dropped first. */
export const MAX_OPEN_CHALLENGES = 64;
export const MAX_OPEN_TICKETS = 64;
export const MAX_SESSION_TOKENS = 512;
export const MAX_SPENT_DERIVED = 1024;

/** The prefix of a ticket derived from the key file (TILL.app, a second `till up`). */
export const DERIVED_TICKET_PREFIX = 'd.';

/** The domain-separated message a device signs. Mirrored in `app/src/lib/studio-key.ts`. */
export function unlockMessage(deviceId: string, nonce: string): string {
  return `till-studio-unlock\n${deviceId}\n${nonce}`;
}

/**
 * The domain-separated message a derived ticket MACs: the host it is for, when it was made (ms since
 * the epoch), and a nonce. Mirrored in `packaging/macos/TillApp.swift`.
 */
export function ticketMessage(instanceId: string, issuedAt: number, nonce: string): string {
  return `till-studio-ticket\n${instanceId}\n${issuedAt}\n${nonce}`;
}

/**
 * The domain-separated message a host's PROOF MACs (`prove`): TILL.app sends a nonce and accepts the
 * server only when it answers with this HMAC, which only a process holding the key can produce and
 * which names exactly the process the lock names (critic H1: an answering port is not a proof). The
 * prefix differs from the ticket's, so a proof can never be used as a ticket. Mirrored in TillApp.swift.
 */
export function proofMessage(instanceId: string, nonce: string): string {
  return `till-studio-server\n${instanceId}\n${nonce}`;
}

/** The id of one running host: its pid and start time, exactly as its lock records them. */
export function instanceIdOf(pid: number, startedAt: string): string {
  return `${pid}.${startedAt}`;
}

/** Derive a one-time ticket from the key for the host `instanceId` (TILL.app does the same in Swift). */
export function deriveTicket(
  key: string,
  instanceId: string,
  issuedAt: number = Date.now(),
  nonce: string = randomBytes(18).toString('base64url'),
): string {
  const mac = createHmac('sha256', key).update(ticketMessage(instanceId, issuedAt, nonce), 'utf8').digest('base64url');
  return `${DERIVED_TICKET_PREFIX}${issuedAt}.${nonce}.${mac}`;
}

export function studioDevicesPath(supportDir: string): string {
  return join(supportDir, STUDIO_DEVICES_FILE);
}

/** The public half of a device key, exactly as stored: P-256, no private member. */
interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

interface PairedDevice {
  id: string;
  publicKey: PublicJwk;
  pairedAt: string;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** Is `value` the public half of a P-256 key, and nothing more? A private member (`d`) is refused. */
export function asPublicP256(value: unknown): PublicJwk | null {
  if (typeof value !== 'object' || value === null) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk) return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || !B64URL_32.test(jwk.x) || !B64URL_32.test(jwk.y)) return null;
  const publicKey: PublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  try {
    createPublicKey({ key: publicKey as JsonWebKey, format: 'jwk' }); // a point on the curve, or it throws
  } catch {
    return null;
  }
  return publicKey;
}

const token32 = (): string => randomBytes(32).toString('base64url');
const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** What a session call answers. A token is handed out; the key never is. */
export type SessionGrant = { ok: true; token: string; deviceId?: string };
export type RedeemResult = SessionGrant | { ok: false; error: 'ticket_invalid' | 'device_key_invalid' };
export type ChallengeResult = { ok: true; nonce: string } | { ok: false; error: 'device_unknown' };
export type UnlockResult = SessionGrant | { ok: false; error: 'device_unknown' | 'challenge_invalid' | 'signature_invalid' };

export interface StudioDeviceRegistry {
  /** A one-time ticket for a link THIS host opens. */
  mintTicket(): string;
  /** Trade a ticket for a session token, and pair the device whose public key comes with it. */
  redeem(ticket: unknown, publicKey?: unknown, replaces?: unknown): RedeemResult;
  /** A session token for a caller that already holds the human seat (the rotation), plus its device. */
  grant(publicKey?: unknown): RedeemResult;
  challenge(deviceId: unknown): ChallengeResult;
  unlock(deviceId: unknown, nonce: unknown, signature: unknown): UnlockResult;
  /** The host's proof for `nonce` (TILL.app checks it before it loads anything), or null. */
  prove(nonce: unknown): string | null;
  /** Is `presented` a live session token? */
  accepts(presented: string): boolean;
  /**
   * Forget every device, token, ticket and challenge (the rotation). Throws when the empty list cannot
   * be written, so a "forgotten" device can never come back after a restart.
   */
  forgetAll(): void;
  /** How many devices are paired (tests, diagnostics). */
  count(): number;
}

export class StudioDevicesNotPersisted extends Error {
  constructor() {
    super('studio_devices_not_persisted');
  }
}

function load(file: string): PairedDevice[] {
  const raw = readOwnerOnlyFile(file);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { devices?: unknown };
    if (!Array.isArray(parsed.devices)) return [];
    const devices: PairedDevice[] = [];
    for (const d of parsed.devices as Array<Record<string, unknown>>) {
      const publicKey = asPublicP256(d?.publicKey);
      if (publicKey !== null && typeof d.id === 'string' && B64URL_32.test(d.id) && typeof d.pairedAt === 'string') {
        devices.push({ id: d.id, publicKey, pairedAt: d.pairedAt });
      }
    }
    return devices.slice(-MAX_PAIRED_DEVICES);
  } catch {
    return [];
  }
}

/** Drop the oldest entries of a Map until it has room for one more. */
function makeRoom<K, V>(map: Map<K, V>, max: number): void {
  while (map.size >= max) map.delete(map.keys().next().value as K);
}

export interface StudioDeviceOptions {
  /** Keep the device list on disk (default). Off for a host that must not write. */
  persist?: boolean;
  /** The live Studio key, which a derived ticket is MACed with. */
  key?: () => string;
  /** This host's instance id (`instanceIdOf`), which a derived ticket must name. */
  instanceId?: string;
  /** Clock seam for the expiries. */
  now?: () => number;
}

/** The registry of one host. */
export function openStudioDeviceRegistry(supportDir: string, opts: StudioDeviceOptions = {}): StudioDeviceRegistry {
  const persist = opts.persist !== false;
  const now = opts.now ?? Date.now;
  const file = studioDevicesPath(supportDir);
  let devices: PairedDevice[] = persist ? load(file) : [];
  const challenges = new Map<string, { deviceId: string; expires: number }>(); // nonce -> its device
  const tickets = new Map<string, number>(); // sha256(ticket) -> expiry
  const spentDerived = new Map<string, true>(); // derived-ticket nonces already redeemed by THIS process
  const tokens = new Map<string, string>(); // sha256(token) -> deviceId ('' for a token with no device)

  const save = (next: PairedDevice[]): boolean =>
    !persist || writeOwnerOnlyFile(file, `${JSON.stringify({ version: 1, devices: next }, null, 2)}\n`);

  const find = (deviceId: unknown): PairedDevice | undefined =>
    typeof deviceId === 'string' ? devices.find((d) => d.id === deviceId) : undefined;

  function issueToken(deviceId: string): string {
    makeRoom(tokens, MAX_SESSION_TOKENS);
    const token = token32();
    tokens.set(digest(token), deviceId);
    return token;
  }

  /** Spend a ticket if it is good. Single use, whatever kind. */
  function spend(ticket: unknown): boolean {
    if (typeof ticket !== 'string' || ticket.length > 200) return false;
    if (ticket.startsWith(DERIVED_TICKET_PREFIX)) {
      if (opts.key === undefined || opts.instanceId === undefined) return false;
      const [issued, nonce, mac, extra] = ticket.slice(DERIVED_TICKET_PREFIX.length).split('.');
      if (extra !== undefined || issued === undefined || nonce === undefined || mac === undefined) return false;
      if (!/^\d{1,15}$/.test(issued) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
      const issuedAt = Number(issued);
      // Good from one minute "early" (clock skew between the app and the host is the same machine's,
      // so a minute is generous) until the TTL after it was made.
      if (issuedAt > now() + 60_000 || now() - issuedAt > DERIVED_TICKET_TTL_MS) return false;
      if (spentDerived.has(nonce)) return false;
      const expected = createHmac('sha256', opts.key()).update(ticketMessage(opts.instanceId, issuedAt, nonce), 'utf8').digest();
      const presented = Buffer.from(mac, 'base64url');
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;
      makeRoom(spentDerived, MAX_SPENT_DERIVED);
      spentDerived.set(nonce, true);
      return true;
    }
    const h = digest(ticket);
    const expires = tickets.get(h);
    tickets.delete(h);
    return expires !== undefined && expires > now();
  }

  /** Pair the device (when a public key came along) and hand out a token. */
  function pairAndGrant(publicKey: unknown, replaces: unknown): RedeemResult {
    if (publicKey === undefined || publicKey === null) return { ok: true, token: issueToken('') };
    const key = asPublicP256(publicKey);
    if (key === null) return { ok: false, error: 'device_key_invalid' };
    const id = token32();
    const next = [...devices.filter((d) => d.id !== replaces), { id, publicKey: key, pairedAt: new Date(now()).toISOString() }].slice(
      -MAX_PAIRED_DEVICES,
    );
    // The ticket is already spent: a device list that cannot be saved still leaves the caller a
    // (deviceless) token rather than nothing (critic L4).
    if (!save(next)) return { ok: true, token: issueToken('') };
    devices = next;
    return { ok: true, token: issueToken(id), deviceId: id };
  }

  return {
    mintTicket() {
      const t = now();
      for (const [h, expires] of tickets) if (expires <= t) tickets.delete(h);
      makeRoom(tickets, MAX_OPEN_TICKETS);
      const ticket = token32();
      tickets.set(digest(ticket), t + TICKET_TTL_MS);
      return ticket;
    },

    redeem(ticket, publicKey, replaces) {
      // Validate the device key BEFORE spending the ticket, so a malformed key does not burn it.
      if (publicKey !== undefined && publicKey !== null && asPublicP256(publicKey) === null) return { ok: false, error: 'device_key_invalid' };
      if (!spend(ticket)) return { ok: false, error: 'ticket_invalid' };
      return pairAndGrant(publicKey, replaces);
    },

    grant(publicKey) {
      return pairAndGrant(publicKey, undefined);
    },

    challenge(deviceId) {
      const device = find(deviceId);
      if (device === undefined) return { ok: false, error: 'device_unknown' };
      const t = now();
      for (const [nonce, c] of challenges) if (c.expires <= t) challenges.delete(nonce);
      // Per device first: a caller that knows one device id can only push out that device's own
      // older challenges. The global cap stays as the backstop on memory.
      const own = [...challenges].filter(([, c]) => c.deviceId === device.id);
      for (const [nonce] of own.slice(0, Math.max(0, own.length - MAX_CHALLENGES_PER_DEVICE + 1))) challenges.delete(nonce);
      makeRoom(challenges, MAX_OPEN_CHALLENGES);
      const nonce = token32();
      challenges.set(nonce, { deviceId: device.id, expires: t + CHALLENGE_TTL_MS });
      return { ok: true, nonce };
    },

    unlock(deviceId, nonce, signature) {
      const device = find(deviceId);
      if (device === undefined) return { ok: false, error: 'device_unknown' };
      if (typeof nonce !== 'string') return { ok: false, error: 'challenge_invalid' };
      const open = challenges.get(nonce);
      challenges.delete(nonce); // single use, whatever happens next
      if (open === undefined || open.deviceId !== device.id || open.expires <= now()) return { ok: false, error: 'challenge_invalid' };
      if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return { ok: false, error: 'signature_invalid' };
      let good = false;
      try {
        good = verify(
          'sha256',
          Buffer.from(unlockMessage(device.id, nonce), 'utf8'),
          { key: createPublicKey({ key: device.publicKey as JsonWebKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        );
      } catch {
        good = false;
      }
      if (!good) return { ok: false, error: 'signature_invalid' };
      return { ok: true, token: issueToken(device.id) };
    },

    prove(nonce) {
      if (opts.key === undefined || opts.instanceId === undefined) return null;
      if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
      return createHmac('sha256', opts.key()).update(proofMessage(opts.instanceId, nonce), 'utf8').digest('base64url');
    },

    accepts(presented) {
      const deviceId = tokens.get(digest(presented));
      if (deviceId === undefined) return false;
      // A device-bound token dies with its device; a deviceless one (a browser with no WebCrypto) lives
      // as long as the process or until a rotation.
      return deviceId === '' || devices.some((d) => d.id === deviceId);
    },

    forgetAll() {
      if (!save([])) throw new StudioDevicesNotPersisted();
      devices = [];
      challenges.clear();
      tickets.clear();
      tokens.clear();
      // `spentDerived` is kept: a derived ticket is MACed with the OLD key, which no longer verifies.
    },

    count: () => devices.length,
  };
}
