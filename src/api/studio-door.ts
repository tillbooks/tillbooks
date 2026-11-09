/**
 * The Studio door (D166): the host-level calls a Studio tab makes about getting and keeping the human
 * seat, mounted by `till up` in local mode as one more face of the local router (so the localhost
 * guard covers it, exactly like `/mcp` and `/api/`). None of them reaches the action registry: the
 * key is host state, not ledger state, so it has no MCP verb and no agent can rotate it or pair.
 * NO ANSWER OF ANY OF THEM CARRIES THE STUDIO KEY (`studio-devices.ts` says why it never has to).
 *
 *   POST /studio/reopen      no credential needed. A tab with no working credential asks the host to
 *                            open the Studio again THROUGH THE OPERATING SYSTEM (`open` on macOS,
 *                            `xdg-open` on Linux) at a link with a fresh one-time ticket, in the
 *                            person's default browser. The answer says only whether it opened. A
 *                            program that fires it gets a TILL tab on the person's screen and nothing
 *                            else. Rate-limited; needs the custom `x-till-reopen` header, so a page on
 *                            another origin cannot fire it without a preflight nothing here answers.
 *   POST /studio/redeem      a one-time ticket from a link, traded for a session token; a device key's
 *                            public half sent along is paired in the same step.
 *   POST /studio/challenge   a one-time nonce for a paired device.
 *   POST /studio/unlock      the signed nonce, traded for a session token.
 *   POST /studio/prove       a nonce, answered with HMAC(key, "till-studio-server", this process, nonce):
 *                            how TILL.app tells the real `till up` from a program that took the port
 *                            (critic H1). It proves possession of the key and reveals nothing of it.
 *   POST /studio/rotate-key  the human seat needed. "Auf allen Geräten abmelden": forget every paired
 *                            browser, token and ticket, replace the key, and hand the CALLER a fresh
 *                            session token (and pair the device key it sends), never the new key.
 *   POST /studio/adopt-book  the human seat needed (D166 point 8). `{ path }`: adopt an existing TILL
 *                            book without a terminal. The host probes the file read-only, records it
 *                            in `<support dir>/book.json` (`book-adopt.ts`), answers
 *                            `{ ok: true, restarting: true }` and only THEN restarts itself (after the
 *                            answer has been flushed), so the next start opens that book. A refusal
 *                            names its code and never restarts. The book file is never copied, moved
 *                            or written; a host whose launcher pins the book refuses `book_path_pinned`.
 *   POST /studio/forget-book the human seat needed (D166 point 8, critic F1/F2). `{}`: "Vergessen und
 *                            neu beginnen" on the Studio's "not reachable" page. Removes `book.json`
 *                            only (fail closed: `book_not_forgotten` and no restart when it cannot),
 *                            then restarts the same way, onto the default book. The book file stays.
 *
 * The JSON calls require `content-type: application/json`, so another origin cannot send them without
 * a preflight either, and read at most `STUDIO_DOOR_MAX_BODY` bytes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { checkStudioKey, studioTicketLink, type HostStudioKey } from './session.js';
import type { StudioKeySource } from './studio-key-store.js';
import type { StudioDeviceRegistry } from './studio-devices.js';
import type { AdoptResult, ForgetResult } from './book-adopt.js';

/** The prefix every door path lives under. Only POSTs are door calls; a GET falls through. */
export const STUDIO_DOOR_PREFIX = '/studio/';
export const STUDIO_REOPEN_PATH = '/studio/reopen';
export const STUDIO_ROTATE_PATH = '/studio/rotate-key';
export const STUDIO_REDEEM_PATH = '/studio/redeem';
export const STUDIO_CHALLENGE_PATH = '/studio/challenge';
export const STUDIO_UNLOCK_PATH = '/studio/unlock';
export const STUDIO_PROVE_PATH = '/studio/prove';
export const STUDIO_ADOPT_PATH = '/studio/adopt-book';
export const STUDIO_FORGET_PATH = '/studio/forget-book';

/** The most a device call's body may be: a public JWK or a signature is a few hundred bytes. */
export const STUDIO_DOOR_MAX_BODY = 4096;

/** The custom header a reopen must carry: it makes a cross-origin call need a preflight. */
export const STUDIO_REOPEN_HEADER = 'x-till-reopen';

/** At most one reopen per this many milliseconds. */
export const REOPEN_MIN_INTERVAL_MS = 15_000;
/** And at most this many in any rolling hour, so a looping caller cannot keep opening tabs. */
export const REOPEN_MAX_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

export interface StudioDoor {
  /** The host's live key. `rotate` replaces it. */
  keys: StudioKeySource;
  /** The paired browsers (D166 layer 2). */
  devices: StudioDeviceRegistry;
  /** Open `link` (the Studio with a one-time ticket) through the operating system. Never returns it. */
  openStudio(link: string): void;
  /** The host's base URL, once bound. */
  baseUrl(): string | null;
  /** Clock seam for the rate limit. */
  now?: () => number;
  /**
   * D166 point 8: record `path` as the book the next start opens (`book-adopt.ts`). With either this
   * or `restart` absent, an adopt is refused `restart_unavailable` BEFORE anything is recorded: the
   * door never answers "restarting" for a host that cannot.
   */
  adoptBook?: (path: unknown) => AdoptResult;
  /** D166 point 8, critic F1/F2: forget the adopted book (`book.json` only), then restart onto the default. */
  forgetBook?: () => ForgetResult;
  /** Restart the host so it opens the adopted book. Called once, AFTER the adopt answer is flushed. */
  restart?: () => void;
}

/** What a reopen answers. Deliberately nothing that could carry a key. */
export type ReopenOutcome =
  | { ok: true; opened: boolean }
  | { ok: false; error: 'reopen_rate_limited'; retryAfterSeconds: number };

/** The rate limit, as its own small piece so it can be reasoned about (and tested) alone. */
export function createReopenLimiter(now: () => number = Date.now): () => ReopenOutcome {
  const recent: number[] = [];
  return () => {
    const t = now();
    while (recent.length > 0 && t - (recent[0] as number) >= HOUR_MS) recent.shift();
    const last = recent[recent.length - 1];
    if (last !== undefined && t - last < REOPEN_MIN_INTERVAL_MS) {
      return { ok: false, error: 'reopen_rate_limited', retryAfterSeconds: Math.ceil((REOPEN_MIN_INTERVAL_MS - (t - last)) / 1000) };
    }
    if (recent.length >= REOPEN_MAX_PER_HOUR) {
      const oldest = recent[0] as number;
      return { ok: false, error: 'reopen_rate_limited', retryAfterSeconds: Math.ceil((HOUR_MS - (t - oldest)) / 1000) };
    }
    recent.push(t);
    return { ok: true, opened: true };
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The seat the door checks: the key, or a paired browser's session token. */
export function doorHostKey(door: Pick<StudioDoor, 'keys' | 'devices'>): HostStudioKey {
  return { current: () => door.keys.current(), accepts: (presented) => door.devices.accepts(presented) };
}

/** Read a small JSON body, or null when it is not JSON, too large, or not an object. */
function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      total += c.length;
      if (total > STUDIO_DOOR_MAX_BODY) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Serve one door call. Returns false for anything that is not a door POST, so the host falls through
 * (a GET under `/studio/` is the SPA's business, not this face's).
 */
export function createStudioDoorHandler(door: StudioDoor): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const take = createReopenLimiter(door.now ?? Date.now);
  const seat = doorHostKey(door);
  return async (req, res) => {
    if (req.method !== 'POST') return false;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (pathname === STUDIO_REOPEN_PATH) {
      req.resume(); // reads no body: drain it so the answer flushes
      if (req.headers[STUDIO_REOPEN_HEADER] !== '1') {
        sendJson(res, 400, { ok: false, error: 'reopen_header_required', message: `A reopen carries the ${STUDIO_REOPEN_HEADER}: 1 header.` });
        return true;
      }
      // A tab that already holds a working credential has nothing to reopen.
      if (checkStudioKey(req.headers, seat) === 'valid') {
        sendJson(res, 200, { ok: true, opened: false } satisfies ReopenOutcome);
        return true;
      }
      const base = door.baseUrl();
      const outcome: ReopenOutcome = base === null ? { ok: true, opened: false } : take();
      if (outcome.ok && outcome.opened && base !== null) {
        try {
          door.openStudio(studioTicketLink(base, door.devices.mintTicket()));
        } catch {
          // best-effort, like the open at start: the tab shows its calm fallback either way
        }
      }
      sendJson(res, outcome.ok ? 200 : 429, outcome);
      return true;
    }

    if (pathname === STUDIO_ADOPT_PATH || pathname === STUDIO_FORGET_PATH) {
      // The human seat, exactly as the rotation checks it: an agent or a stray local program cannot
      // repoint the person's books.
      const key = checkStudioKey(req.headers, seat);
      if (key !== 'valid') {
        req.resume();
        sendJson(res, 401, {
          ok: false,
          error: key === 'absent' ? 'studio_key_required' : 'studio_key_invalid',
          message: 'Only the person (the Studio key or a session token) can choose the book.',
        });
        return true;
      }
      const body = await readSmallJson(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'door_body_invalid', message: `A JSON object of at most ${STUDIO_DOOR_MAX_BODY} bytes, sent as application/json.` });
        return true;
      }
      const { adoptBook, forgetBook, restart } = door;
      const act = pathname === STUDIO_ADOPT_PATH ? adoptBook : forgetBook;
      if (act === undefined || restart === undefined) {
        sendJson(res, 409, { ok: false, error: 'restart_unavailable' });
        return true;
      }
      const done = pathname === STUDIO_ADOPT_PATH ? (adoptBook as NonNullable<typeof adoptBook>)(body.path) : (forgetBook as NonNullable<typeof forgetBook>)();
      if (!done.ok) {
        const status =
          done.error === 'book_not_saved' || done.error === 'book_not_forgotten'
            ? 500
            : done.error === 'book_path_pinned' || done.error === 'book_already_open'
              ? 409
              : 400;
        sendJson(res, status, { ok: false, error: done.error });
        return true;
      }
      // Restart only once the answer is out, so the tab learns "restarting" before the port goes. If
      // the connection drops first, `close` still fires: the book is recorded either way.
      let restarted = false;
      const restartOnce = () => {
        if (restarted) return;
        restarted = true;
        try {
          restart();
        } catch {
          // the recorded book opens on the next start in any case
        }
      };
      res.once('finish', restartOnce);
      res.once('close', restartOnce);
      sendJson(res, 200, { ok: true, restarting: true });
      return true;
    }

    if (
      pathname === STUDIO_REDEEM_PATH ||
      pathname === STUDIO_CHALLENGE_PATH ||
      pathname === STUDIO_UNLOCK_PATH ||
      pathname === STUDIO_ROTATE_PATH ||
      pathname === STUDIO_PROVE_PATH
    ) {
      if (pathname === STUDIO_ROTATE_PATH) {
        const key = checkStudioKey(req.headers, seat);
        if (key !== 'valid') {
          req.resume();
          sendJson(res, 401, {
            ok: false,
            error: key === 'absent' ? 'studio_key_required' : 'studio_key_invalid',
            message: 'Only the person (the Studio key or a session token) can sign every device out.',
          });
          return true;
        }
      }
      const body = await readSmallJson(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'door_body_invalid', message: `A JSON object of at most ${STUDIO_DOOR_MAX_BODY} bytes, sent as application/json.` });
        return true;
      }
      if (pathname === STUDIO_ROTATE_PATH) {
        try {
          // Devices first, then the key, each FAIL CLOSED: a list that cannot be emptied, or a key that
          // cannot be written, stops the rotation, so no revoked device or key survives on disk to come
          // back after a restart. Emptied devices with an unchanged key is the conservative half-way:
          // those browsers pair again through a reopen.
          door.devices.forgetAll();
          door.keys.rotate();
        } catch {
          sendJson(res, 500, { ok: false, error: 'studio_key_rotate_failed', message: 'The new key could not be saved. The key is unchanged.' });
          return true;
        }
        // The caller held the seat; it keeps it with a fresh token, and its device key is paired anew.
        // A device that cannot be saved still leaves the caller a (deviceless) token.
        const granted = door.devices.grant(body.publicKey);
        sendJson(res, 200, granted.ok ? granted : door.devices.grant(undefined));
        return true;
      }
      if (pathname === STUDIO_PROVE_PATH) {
        const proof = door.devices.prove(body.nonce);
        sendJson(res, proof === null ? 400 : 200, proof === null ? { ok: false, error: 'nonce_invalid' } : { ok: true, proof });
        return true;
      }
      const result =
        pathname === STUDIO_REDEEM_PATH
          ? door.devices.redeem(body.ticket, body.publicKey, body.replaces)
          : pathname === STUDIO_CHALLENGE_PATH
            ? door.devices.challenge(body.deviceId)
            : door.devices.unlock(body.deviceId, body.nonce, body.signature);
      sendJson(res, result.ok ? 200 : 401, result);
      return true;
    }

    req.resume();
    sendJson(res, 404, { ok: false, error: 'not_a_studio_door_call' });
    return true;
  };
}
