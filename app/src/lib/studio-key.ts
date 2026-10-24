/**
 * The Studio seat, browser side (critic probe P6, critic R3-B2, and D166 of 14.10.2026).
 *
 * The engine hands the human `studio` seat ONLY to a request that carries the Studio key or a session
 * token (`src/api/session.ts`, `src/api/studio-devices.ts`), in the `x-till-studio-key` header. Since
 * D166 the browser NEVER holds the key: it stays in an owner-only file on the person's computer.
 *
 *  - A LINK CARRIES A ONE-TIME TICKET. TILL opens the Studio at `http://HOST:PORT/#t=<ticket>` (the
 *    host mints it, or TILL.app derives it from the key file for exactly the running process). A URL
 *    fragment is never sent to a server, so only this browser sees it; this module strips it at once
 *    and redeems it (`POST /studio/redeem`) for a SESSION TOKEN kept in THIS TAB's `sessionStorage`.
 *    A spent ticket is worthless, so one left in history, autocomplete or a session restore is too.
 *  - PAIRING, IN THE SAME CALL (browsers only). The redeem carries the public half of an ECDSA P-256
 *    device key whose private half is NON-EXTRACTABLE (IndexedDB). The native TILL.app window pairs
 *    nothing: the app hands it a fresh ticket whenever it needs one (`isNativeWindow`). A bookmark or a new tab later signs a one-time
 *    challenge with it and gets its own token. A page served from the same origin by something else (a
 *    program squatting the port while TILL is down) finds a device id and a key handle it cannot
 *    export, and no challenge to sign: the review's "origin squatting" has nothing left to take.
 *  - A REFUSED TAB REPAIRS ITSELF, with no click, in this order:
 *      1. a newer credential this tab got meanwhile is simply used;
 *      2. the paired device unlocks a fresh token (after a restart, or a stray link);
 *      3. inside the native TILL.app, the app is asked (`webkit.messageHandlers.till`) to reload the
 *         window with a fresh ticket from the key file;
 *      4. in a browser, the engine is asked ONCE per tab to reopen the Studio through the operating
 *         system (`POST /studio/reopen`); its answer carries nothing. When the reopened tab pairs, this
 *         tab hears of it (the `storage` event on the device marker), unlocks and reloads.
 *    Meanwhile a calm full-page notice says what is happening. It never names a terminal.
 *  - Loops are impossible by construction: the per-tab reopen attempt is remembered in
 *    `sessionStorage` until the tab gets a working credential, the engine rate-limits the door, and the
 *    app is asked to rekey only when the page did not itself arrive with a ticket the engine refused.
 *
 * The Vite dev bridge still hands a `#k=<key>` link (it has no door); such a key stays in its tab.
 * Why a header and not a cookie is argued in `src/api/up.ts`.
 */
import type { RestResponse, Transport } from './client';

/** Mirrors `STUDIO_KEY_HEADER` in `src/api/session.ts`. */
export const STUDIO_KEY_HEADER = 'x-till-studio-key';

/** Mirrors `STUDIO_KEY_FRAGMENT` in `src/api/session.ts`: the dev bridge's link ends in `#k=<key>`. */
export const STUDIO_KEY_FRAGMENT = 'k';
/** Mirrors `STUDIO_TICKET_FRAGMENT`: TILL's own links end in `#t=<one-time ticket>` (D166). */
export const STUDIO_TICKET_FRAGMENT = 't';

/** Where THIS TAB keeps a key that arrived in a dev-bridge link (`sessionStorage`). */
export const STUDIO_KEY_STORAGE = 'till-studio-key';
/** Where THIS TAB keeps the session token its paired device unlocked (`sessionStorage`). */
export const STUDIO_SESSION_STORAGE = 'till-studio-session';
/** The paired device's id in `localStorage`: not a secret, the cross-tab "a device was paired" signal. */
export const STUDIO_DEVICE_STORAGE = 'till-studio-device';
/** Where THIS TAB remembers its one reopen attempt (`sessionStorage`, so a reload cannot loop). */
export const STUDIO_REOPEN_TRIED = 'till-studio-reopen-tried';

/** Mirrors `src/api/studio-door.ts`. */
export const STUDIO_REOPEN_PATH = '/studio/reopen';
export const STUDIO_ROTATE_PATH = '/studio/rotate-key';
export const STUDIO_REDEEM_PATH = '/studio/redeem';
export const STUDIO_CHALLENGE_PATH = '/studio/challenge';
export const STUDIO_UNLOCK_PATH = '/studio/unlock';
export const STUDIO_REOPEN_HEADER = 'x-till-reopen';

/** Mirrors `unlockMessage` in `src/api/studio-devices.ts`. */
export function unlockMessage(deviceId: string, nonce: string): string {
  return `till-studio-unlock\n${deviceId}\n${nonce}`;
}

/** The engine's refusals of a Studio call that has no credential, or one it does not hold. */
export const STUDIO_KEY_REFUSALS = ['studio_key_required', 'studio_key_invalid'] as const;

/** What this module answers locally once the tab is known to have no usable credential. */
export const STUDIO_KEY_MISSING = 'studio_key_missing';

/** The id of the full-page notice, so it is inserted once and tests can find it. */
export const STUDIO_KEY_NOTICE_ID = 'till-studio-key-notice';

/** How long the "opening" notice waits for the reopened tab before it says TILL opened elsewhere. */
export const REOPEN_SETTLE_MS = 8000;

const KEY_SHAPE = /^[A-Za-z0-9_-]{43,}$/;

// --- storage ---------------------------------------------------------------------------------------

function tabStorage(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null; // storage disabled: the tab then behaves as one without a credential
  }
}

function sharedStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

function currentWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

function readShaped(storage: Storage | null, name: string): string | null {
  try {
    const value = storage?.getItem(name) ?? null;
    return value !== null && KEY_SHAPE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function drop(storage: Storage | null, name: string, ifEquals?: string | null): void {
  try {
    if (ifEquals === undefined || storage?.getItem(name) === ifEquals) storage?.removeItem(name);
  } catch {
    // nothing to drop
  }
}

/** The paired device, as kept in IndexedDB: an id and a NON-EXTRACTABLE private key. */
export interface StoredDevice {
  deviceId: string;
  privateKey: CryptoKey;
}

/** Where the device lives. IndexedDB in a browser; a test swaps in a memory store. */
export interface DeviceStore {
  get(): Promise<StoredDevice | null>;
  put(device: StoredDevice): Promise<void>;
  clear(): Promise<void>;
}

const IDB_NAME = 'till-studio';
const IDB_STORE = 'device';
const IDB_ENTRY = 'current';

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbRun<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | null): Promise<T | null> {
  const db = await idbOpen();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const request = work(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(request === null ? null : ((request.result as T | undefined) ?? null));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const indexedDbDeviceStore: DeviceStore = {
  async get() {
    if (typeof indexedDB === 'undefined') return null;
    const value = await idbRun<StoredDevice>('readonly', (s) => s.get(IDB_ENTRY));
    return value !== null && typeof value.deviceId === 'string' && value.privateKey !== undefined ? value : null;
  },
  async put(device) {
    if (typeof indexedDB === 'undefined') throw new Error('indexeddb_unavailable');
    await idbRun('readwrite', (s) => s.put(device, IDB_ENTRY));
  },
  async clear() {
    if (typeof indexedDB === 'undefined') return;
    await idbRun('readwrite', (s) => s.delete(IDB_ENTRY));
  },
};

let deviceStore: DeviceStore = indexedDbDeviceStore;

/** Test seam: where the paired device is kept. */
export function setDeviceStoreForTests(store: DeviceStore | null): void {
  deviceStore = store ?? indexedDbDeviceStore;
}

/**
 * Is this page running inside the native TILL.app window? There the app hands the Studio a fresh ticket
 * whenever it needs one, so the page pairs NO device key: a WKWebView wraps a CryptoKey kept in
 * IndexedDB with a "WebCrypto Master Key" in the macOS Keychain, and an app whose signature changed
 * (every update of an unsigned build) is then held up by a Keychain prompt (found in the D166
 * end-to-end run, 14.10.2026).
 */
function isNativeWindow(win: Window): boolean {
  const bridge = (win as unknown as { webkit?: { messageHandlers?: { till?: { postMessage?: unknown } } } }).webkit?.messageHandlers?.till;
  return typeof bridge?.postMessage === 'function';
}

function subtle(): SubtleCrypto | null {
  try {
    return globalThis.crypto?.subtle ?? null;
  } catch {
    return null;
  }
}

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postJson(win: Window, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
  try {
    const resp = await win.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const parsed = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    return resp.ok ? parsed : null;
  } catch {
    return null;
  }
}

// --- module state ------------------------------------------------------------------------------------

/** Set once this tab is known to have no usable credential; cleared by a fresh link. */
let refused = false;
/** This page load took a key from the fragment. */
let arrivedWithKey = false;
/** The engine accepted a call from this page load at least once. */
let acceptedOnce = false;
/** A ticket this page load took from its link, not yet redeemed. */
let pendingTicket: string | null = null;
/** The redemption of `pendingTicket`, shared by every call that waits for it. */
let redeeming: Promise<boolean> | null = null;
/** One recovery at a time: concurrent refusals share it. */
let recovering: Promise<boolean> | null = null;
/** What the notice is saying. */
export type RepairState = 'opening' | 'elsewhere' | 'unavailable';
let repairState: RepairState = 'opening';
let storageListener: ((e: StorageEvent) => void) | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

// --- the credential ----------------------------------------------------------------------------------

/**
 * Take the ticket (or a dev-bridge key) out of the URL fragment and strip it from the URL at once. Any
 * other fragment content survives. A ticket waits in memory for its redemption; a dev-bridge key is
 * kept for THIS TAB. Returns what it took, or null. A malformed value is stripped and not kept.
 */
export function captureStudioKeyFromFragment(win: Window): string | null {
  const hash = win.location.hash.replace(/^#/, '');
  if (hash === '') return null;
  const params = new URLSearchParams(hash);
  if (!params.has(STUDIO_KEY_FRAGMENT) && !params.has(STUDIO_TICKET_FRAGMENT)) return null;
  const key = params.get(STUDIO_KEY_FRAGMENT);
  const ticket = params.get(STUDIO_TICKET_FRAGMENT);
  params.delete(STUDIO_KEY_FRAGMENT);
  params.delete(STUDIO_TICKET_FRAGMENT);
  const rest = params.toString();
  const { pathname, search } = win.location;
  win.history.replaceState(win.history.state, '', `${pathname}${search}${rest === '' ? '' : `#${rest}`}`);
  // The first cut of D166 kept the key in localStorage; whatever it left there goes.
  drop(sharedStorage(win), STUDIO_KEY_STORAGE);
  if (ticket !== null && /^(d\.)?[A-Za-z0-9_.-]{20,200}$/.test(ticket)) {
    pendingTicket = ticket;
    redeeming = null;
    refused = false; // a freshly opened link is a fresh chance
    arrivedWithKey = true;
    return ticket;
  }
  if (key === null || !KEY_SHAPE.test(key)) return null;
  try {
    tabStorage(win)?.setItem(STUDIO_KEY_STORAGE, key);
  } catch {
    return null;
  }
  refused = false;
  arrivedWithKey = true;
  return key;
}

/** The credential this tab sends: the key from its link, else its session token, else null. */
export function readStudioKey(win: Window | undefined = currentWindow()): string | null {
  if (win === undefined) return null;
  const storage = tabStorage(win);
  return readShaped(storage, STUDIO_KEY_STORAGE) ?? readShaped(storage, STUDIO_SESSION_STORAGE);
}

/** Does this tab hold a credential? (A served deployment, seated by its proxy, does not.) */
export function hasStudioKey(win?: Window): boolean {
  return (win === undefined ? readStudioKey() : readStudioKey(win)) !== null;
}

/** The header to send on an engine call: the credential when this tab has one, nothing otherwise. */
export function studioKeyHeaders(win?: Window): Record<string, string> {
  const key = win === undefined ? readStudioKey() : readStudioKey(win);
  return key === null ? {} : { [STUDIO_KEY_HEADER]: key };
}

/** Did the engine refuse this call for want of a valid credential? */
export function isStudioKeyRefusal(refusal: unknown): boolean {
  const text =
    typeof refusal === 'string'
      ? refusal
      : refusal instanceof Error
        ? refusal.message
        : [(refusal as { error?: unknown } | null)?.error, (refusal as { detail?: unknown } | null)?.detail]
            .filter((v): v is string => typeof v === 'string')
            .join(' ');
  return STUDIO_KEY_REFUSALS.some((code) => text.includes(code));
}

/** Has the engine refused this tab for good? Then no further request is sent. */
export function studioKeyRefused(): boolean {
  return refused;
}

/** What the notice says right now (tests). */
export function studioKeyRepairState(): RepairState {
  return repairState;
}

/** Test seam: forget everything, as a fresh page load would. */
export function resetStudioKeyState(): void {
  refused = false;
  arrivedWithKey = false;
  acceptedOnce = false;
  pendingTicket = null;
  redeeming = null;
  recovering = null;
  repairState = 'opening';
  const win = currentWindow();
  if (storageListener !== null && win !== undefined) win.removeEventListener('storage', storageListener);
  storageListener = null;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
}

// --- pairing and unlocking -----------------------------------------------------------------------------

/** A fresh device key: the private half NON-EXTRACTABLE. Null where WebCrypto is unavailable. */
async function newDeviceKey(): Promise<{ privateKey: CryptoKey; publicJwk: Record<string, unknown> } | null> {
  const crypto = subtle();
  if (crypto === null) return null;
  try {
    const pair = await crypto.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const jwk = await crypto.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  } catch {
    return null;
  }
}

/** Keep what the engine granted: the token for this tab, the paired device for this browser. */
async function keepGrant(
  win: Window,
  answer: Record<string, unknown> | null,
  device: { privateKey: CryptoKey } | null,
): Promise<boolean> {
  if (answer?.ok !== true || typeof answer.token !== 'string' || !KEY_SHAPE.test(answer.token)) return false;
  const storage = tabStorage(win);
  try {
    storage?.setItem(STUDIO_SESSION_STORAGE, answer.token);
  } catch {
    return false;
  }
  drop(storage, STUDIO_KEY_STORAGE);
  if (device !== null && typeof answer.deviceId === 'string') {
    try {
      await deviceStore.put({ deviceId: answer.deviceId, privateKey: device.privateKey });
      sharedStorage(win)?.setItem(STUDIO_DEVICE_STORAGE, answer.deviceId); // tells waiting tabs
    } catch {
      // the token still works for this tab; the browser just stays unpaired
    }
  }
  return true;
}

/**
 * Redeem the ticket this page's link carried, pairing this browser in the same call. Resolves true
 * when the tab now holds a token. Shared by every call that waits for it; a ticket is tried once.
 */
export function redeemPendingTicket(win: Window | undefined = currentWindow()): Promise<boolean> {
  if (win === undefined || pendingTicket === null) return Promise.resolve(false);
  redeeming ??= (async () => {
    const ticket = pendingTicket;
    pendingTicket = null;
    const device = isNativeWindow(win) ? null : await newDeviceKey();
    const previous = device === null ? null : await deviceStore.get().catch(() => null);
    const answer = await postJson(win, STUDIO_REDEEM_PATH, {
      ticket,
      ...(device !== null ? { publicKey: device.publicJwk } : {}),
      ...(previous !== null ? { replaces: previous.deviceId } : {}),
    });
    return keepGrant(win, answer, device);
  })();
  return redeeming;
}

/** Unlock a session token for THIS TAB with the paired device. Resolves true when it got one. */
export async function unlockWithDevice(win: Window): Promise<boolean> {
  const crypto = subtle();
  if (crypto === null || isNativeWindow(win)) return false; // the app rekeys instead
  try {
    const device = await deviceStore.get();
    if (device === null) return false;
    const challenge = await postJson(win, STUDIO_CHALLENGE_PATH, { deviceId: device.deviceId });
    if (challenge?.ok !== true || typeof challenge.nonce !== 'string') return false;
    const signature = await crypto.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      device.privateKey,
      new TextEncoder().encode(unlockMessage(device.deviceId, challenge.nonce)),
    );
    const answer = await postJson(win, STUDIO_UNLOCK_PATH, { deviceId: device.deviceId, nonce: challenge.nonce, signature: base64url(signature) });
    if (answer?.ok !== true || typeof answer.token !== 'string' || !KEY_SHAPE.test(answer.token)) return false;
    tabStorage(win)?.setItem(STUDIO_SESSION_STORAGE, answer.token);
    return true;
  } catch {
    return false;
  }
}

/** The engine accepted a call: this tab has a working credential, so a later refusal may repair again. */
function noteAccepted(win: Window | undefined): void {
  if (win === undefined || acceptedOnce) return;
  acceptedOnce = true;
  drop(tabStorage(win), STUDIO_REOPEN_TRIED);
}

/**
 * The credential `sent` was refused. Drop it (only if it is still the one held, so a newer one is never
 * thrown away) and try to get a working one without the person: a newer one this tab already has, else
 * the paired device. Concurrent refusals share one attempt.
 */
function recover(win: Window, sent: string | null): Promise<boolean> {
  const storage = tabStorage(win);
  drop(storage, STUDIO_KEY_STORAGE, sent);
  drop(storage, STUDIO_SESSION_STORAGE, sent);
  const now = readStudioKey(win);
  if (now !== null && now !== sent) return Promise.resolve(true);
  recovering ??= unlockWithDevice(win).finally(() => {
    recovering = null;
  });
  return recovering;
}

// --- the repair, when nothing silent worked ------------------------------------------------------------

/** The native TILL.app's bridge, when this page runs inside its window. */
interface NativeBridge {
  postMessage(message: unknown): void;
}
function nativeBridge(win: Window): NativeBridge | null {
  const bridge = (win as unknown as { webkit?: { messageHandlers?: { till?: NativeBridge } } }).webkit?.messageHandlers?.till;
  return bridge !== undefined && typeof bridge.postMessage === 'function' ? bridge : null;
}

function setRepairState(state: RepairState, doc: Document | undefined): void {
  repairState = state;
  if (doc !== undefined) showStudioKeyNotice(doc);
}

/** This tab is out of silent options: stop sending, and start the visible repair. */
export function markStudioKeyRefused(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (refused) return;
  refused = true;
  const win = doc?.defaultView ?? currentWindow();
  if (win === undefined || win === null) return;
  beginRepair(win, doc);
}

/** Read this tab's earlier reopen attempt, if any. */
function priorAttempt(win: Window): { opened: boolean } | null {
  try {
    const raw = tabStorage(win)?.getItem(STUDIO_REOPEN_TRIED) ?? null;
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { opened?: unknown };
    return { opened: parsed.opened === true };
  } catch {
    return null;
  }
}

function recordAttempt(win: Window, opened: boolean): void {
  try {
    tabStorage(win)?.setItem(STUDIO_REOPEN_TRIED, JSON.stringify({ at: Date.now(), opened }));
  } catch {
    // a tab that cannot remember gets no second attempt anyway: `refused` stays set for this page
  }
}

function beginRepair(win: Window, doc: Document | undefined): void {
  // Whatever happens next, a device paired by another tab (the reopened one) brings this tab back.
  if (storageListener === null) {
    storageListener = (e: StorageEvent) => {
      if (e.key !== STUDIO_DEVICE_STORAGE || e.newValue === null) return;
      void unlockWithDevice(win).then((ok) => {
        if (ok) win.location.reload();
      });
    };
    win.addEventListener('storage', storageListener);
  }

  const bridge = nativeBridge(win);
  if (bridge !== null) {
    // The app hands the key from its file. If THIS page already arrived with a key the engine
    // refused, the file is the problem, and asking again would only reload the same refusal.
    if (arrivedWithKey && !acceptedOnce) {
      setRepairState('unavailable', doc);
      return;
    }
    setRepairState('opening', doc);
    try {
      bridge.postMessage({ type: 'rekey' });
    } catch {
      setRepairState('unavailable', doc);
    }
    return;
  }

  const prior = priorAttempt(win);
  if (prior !== null) {
    setRepairState(prior.opened ? 'elsewhere' : 'unavailable', doc);
    return;
  }
  recordAttempt(win, false);
  setRepairState('opening', doc);
  void requestReopen(win).then((opened) => {
    recordAttempt(win, opened);
    if (!opened) {
      setRepairState('unavailable', doc);
      return;
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (refused) setRepairState('elsewhere', doc);
    }, REOPEN_SETTLE_MS);
  });
}

/** Ask the engine to reopen the Studio through the OS. Resolves true when it says it did. */
async function requestReopen(win: Window): Promise<boolean> {
  try {
    const resp = await win.fetch(STUDIO_REOPEN_PATH, { method: 'POST', headers: { [STUDIO_REOPEN_HEADER]: '1' } });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: unknown; opened?: unknown };
    return body.ok === true && body.opened === true;
  } catch {
    return false;
  }
}

/** The local answer for a call this tab cannot make. Shaped like any refusal the surfaces read. */
export function studioKeyMissingResponse(): RestResponse {
  return {
    status: 401,
    body: { ok: false, error: STUDIO_KEY_MISSING, detail: 'this tab has no Studio key; TILL is reopening itself' },
  };
}

/**
 * Wrap a transport so a refused tab first repairs itself silently (a newer credential, the paired
 * device), retries ONCE, and only then stops: from there every call is answered here, with no request,
 * and the visible repair is under way. A tab WITHOUT a credential still asks once rather than never,
 * because a served deployment (M01, behind a proxy) seats the person by the attested subject and needs
 * no key at all.
 */
export function guardStudioKey(inner: Transport): Transport {
  const attempt = async (action: string, input: Record<string, unknown>, retried: boolean): Promise<RestResponse> => {
    if (refused) {
      showStudioKeyNotice();
      return studioKeyMissingResponse();
    }
    const win = currentWindow();
    if (pendingTicket !== null || redeeming !== null) await redeemPendingTicket(win);
    const sent = readStudioKey();
    const resp = await inner(action, input);
    if (!resp.body.ok && isStudioKeyRefusal(resp.body)) {
      if (!retried && win !== undefined && (await recover(win, sent))) return attempt(action, input, true);
      markStudioKeyRefused();
      return studioKeyMissingResponse();
    }
    // A transport failure (status 0) says nothing about the credential; any answer from the engine does.
    if (resp.status !== 0) noteAccepted(win);
    return resp;
  };
  const guarded: Transport = (action, input) => attempt(action, input, false);
  if (inner.resetSession !== undefined) guarded.resetSession = inner.resetSession;
  return guarded;
}

/**
 * "Auf allen Geräten abmelden" (D166): the engine forgets every paired browser and every session token
 * and replaces the key. This tab keeps the seat with a fresh token and pairs this browser again in the
 * same call; every other browser and every copy is refused from its next request on. The answer never
 * carries the key.
 */
export async function rotateStudioKey(win: Window | undefined = currentWindow()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (win === undefined) return { ok: false, error: STUDIO_KEY_MISSING };
  const credential = readStudioKey(win);
  if (credential === null) return { ok: false, error: STUDIO_KEY_MISSING };
  try {
    const native = isNativeWindow(win);
    const device = native ? null : await newDeviceKey();
    const resp = await win.fetch(STUDIO_ROTATE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [STUDIO_KEY_HEADER]: credential },
      body: JSON.stringify(device !== null ? { publicKey: device.publicJwk } : {}),
    });
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!resp.ok || body?.ok !== true) {
      return { ok: false, error: typeof body?.error === 'string' ? body.error : 'studio_key_rotate_failed' };
    }
    if (!native) {
      await deviceStore.clear().catch(() => undefined); // the engine forgot it; so does this browser
      drop(sharedStorage(win), STUDIO_DEVICE_STORAGE);
    }
    return (await keepGrant(win, body, device)) ? { ok: true } : { ok: false, error: 'studio_key_rotate_failed' };
  } catch {
    return { ok: false, error: 'studio_key_rotate_failed' };
  }
}

// --- adopting an existing book (D166 point 8) ------------------------------------------------------------

export const STUDIO_ADOPT_PATH = '/studio/adopt-book';
export const STUDIO_PROVE_PATH = '/studio/prove';

/** What an adopt answers: the host restarts onto the book, or the refusal code it named. */
export type AdoptOutcome = { ok: true } | { ok: false; error: string };

/**
 * Adopt an existing TILL book (`POST /studio/adopt-book`, the human seat): the host probes the file
 * read-only, remembers it, and restarts onto it once the answer is out. Never throws; a call that got
 * no usable answer reads `adopt_failed`.
 */
export async function adoptBook(path: string, win: Window | undefined = currentWindow()): Promise<AdoptOutcome> {
  if (win === undefined) return { ok: false, error: STUDIO_KEY_MISSING };
  const credential = readStudioKey(win);
  if (credential === null) return { ok: false, error: STUDIO_KEY_MISSING };
  try {
    const resp = await win.fetch(STUDIO_ADOPT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [STUDIO_KEY_HEADER]: credential },
      body: JSON.stringify({ path }),
    });
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (resp.ok && body?.ok === true && body.restarting === true) return { ok: true };
    return { ok: false, error: typeof body?.error === 'string' ? body.error : 'adopt_failed' };
  } catch {
    return { ok: false, error: 'adopt_failed' };
  }
}

export const STUDIO_FORGET_PATH = '/studio/forget-book';

/**
 * "Vergessen und neu beginnen" (`POST /studio/forget-book`, the human seat): the host forgets the
 * adopted book (never the file) and restarts onto the default book. Never throws.
 */
export async function forgetAdoptedBook(win: Window | undefined = currentWindow()): Promise<AdoptOutcome> {
  if (win === undefined) return { ok: false, error: STUDIO_KEY_MISSING };
  const credential = readStudioKey(win);
  if (credential === null) return { ok: false, error: STUDIO_KEY_MISSING };
  try {
    const resp = await win.fetch(STUDIO_FORGET_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [STUDIO_KEY_HEADER]: credential },
      body: '{}',
    });
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (resp.ok && body?.ok === true && body.restarting === true) return { ok: true };
    return { ok: false, error: typeof body?.error === 'string' ? body.error : 'adopt_failed' };
  } catch {
    return { ok: false, error: 'adopt_failed' };
  }
}

/** The native TILL.app's file picker bridge (`tillPick`, a reply-capable handler), when present. */
interface NativePicker {
  postMessage(message: unknown): Promise<unknown>;
}
function nativePicker(win: Window): NativePicker | null {
  const bridge = (win as unknown as { webkit?: { messageHandlers?: { tillPick?: NativePicker } } }).webkit?.messageHandlers?.tillPick;
  return bridge !== undefined && typeof bridge.postMessage === 'function' ? bridge : null;
}

/** Does this page run inside TILL.app with its native file picker? */
export function hasNativeBookPicker(win: Window | undefined = currentWindow()): boolean {
  return win !== undefined && nativePicker(win) !== null;
}

/**
 * Ask TILL.app for a book file through its native open panel. The chosen absolute path, or null when
 * the person cancelled (or there is no picker). Never throws.
 */
export async function pickBookNatively(win: Window | undefined = currentWindow()): Promise<string | null> {
  const picker = win === undefined ? null : nativePicker(win);
  if (picker === null) return null;
  try {
    const chosen = await picker.postMessage({ type: 'pickBook' });
    return typeof chosen === 'string' && chosen !== '' ? chosen : null;
  } catch {
    return null;
  }
}

/** How often, and how long at most, a browser tab waits for the restarted host before it reloads. */
export const RESTART_POLL_MS = 1000;
export const RESTART_WAIT_MS = 30_000;

/** One fixed nonce per wait: the same nonce answers with the same proof only from the same process. */
function waitNonce(): string {
  const bytes = new Uint8Array(18);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return base64url(bytes.buffer);
}

async function proofOf(win: Window, nonce: string): Promise<string | null> {
  try {
    const resp = await win.fetch(STUDIO_PROVE_PATH, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    const body = (await resp.json().catch(() => null)) as { proof?: unknown } | null;
    return resp.ok && typeof body?.proof === 'string' ? body.proof : null;
  } catch {
    return null;
  }
}

/**
 * A browser tab after an adopt: wait until the host has restarted, then reload, so the tab comes back
 * on the adopted book (its session token died with the old process; the paired device unlocks a new
 * one by itself). The restart is told apart from the old process by `POST /studio/prove`: the same
 * nonce is answered with a different proof by a different process (the proof names the process), and
 * a host that is down answers nothing. So the tab reloads once the proof CHANGED, or once the host
 * answered again after being unreachable, or after `RESTART_WAIT_MS` whatever happened. The proof is
 * a read; it reveals nothing of the key. `baseline` is the proof taken before the adopt was sent.
 */
export async function reloadAfterRestart(
  win: Window,
  opts: {
    nonce: string;
    baseline: string | null;
    pollMs?: number;
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Stops the wait without a reload (the page that started it went away). */
    signal?: AbortSignal;
  },
): Promise<void> {
  const pollMs = opts.pollMs ?? RESTART_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? RESTART_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const aborted = (): boolean => opts.signal?.aborted === true;
  let sawDown = false;
  for (let waited = 0; waited < maxWaitMs; waited += pollMs) {
    await sleep(pollMs);
    if (aborted()) return;
    const proof = await proofOf(win, opts.nonce);
    if (aborted()) return;
    if (proof === null) {
      sawDown = true;
      continue;
    }
    if (sawDown || (opts.baseline !== null && proof !== opts.baseline)) break;
  }
  if (aborted()) return;
  win.location.reload();
}

/** Take the "before" proof for `reloadAfterRestart`, with a fresh nonce. */
export async function restartBaseline(win: Window | undefined = currentWindow()): Promise<{ nonce: string; baseline: string | null }> {
  const nonce = waitNonce();
  return { nonce, baseline: win === undefined ? null : await proofOf(win, nonce) };
}

/**
 * The notice copy, in both Studio languages, per repair state. du, no sharp s, no em dash (house
 * style), calm, and never a terminal step (owner rule, D166): it says what is happening and, only when
 * TILL cannot fix it by itself, the one thing a person can do without a terminal.
 */
export const STUDIO_KEY_NOTICE: Record<RepairState, Record<'de-CH' | 'en', { title: string; body: string }>> = {
  opening: {
    'de-CH': {
      title: 'TILL wird geöffnet …',
      body: 'Einen Moment. TILL öffnet sich mit dem Schlüssel zu deinen Büchern neu.',
    },
    en: {
      title: 'Opening TILL …',
      body: 'One moment. TILL is reopening with the key to your books.',
    },
  },
  elsewhere: {
    'de-CH': {
      title: 'TILL ist in einem anderen Fenster offen',
      body: 'TILL hat sich mit deinem Schlüssel in deinem Standardbrowser neu geöffnet. Diesen Tab kannst du schliessen.',
    },
    en: {
      title: 'TILL is open in another window',
      body: 'TILL reopened with your key in your default browser. You can close this tab.',
    },
  },
  unavailable: {
    'de-CH': {
      title: 'Öffne TILL über das TILL-Symbol',
      body: 'Diesem Tab fehlt der Schlüssel zu deinen Büchern, und TILL konnte sich nicht von selbst neu öffnen. Klicke auf das TILL-Symbol im Dock oder in deinen Programmen.',
    },
    en: {
      title: 'Open TILL from its icon',
      body: 'This tab does not have the key to your books, and TILL could not reopen itself. Click the TILL icon in your Dock or your applications.',
    },
  },
};

/** Put the full-page notice up (once), showing the current repair state. Plain DOM, so it shows whatever state the app is in. */
export function showStudioKeyNotice(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc === undefined || doc.body === null) return;
  let panel = doc.getElementById(STUDIO_KEY_NOTICE_ID);
  if (panel === null) {
    panel = doc.createElement('div');
    panel.id = STUDIO_KEY_NOTICE_ID;
    // A status, not an alert: nothing is wrong that the person has to act on while TILL reopens.
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    Object.assign(panel.style, {
      position: 'fixed',
      inset: '0',
      zIndex: 'var(--t-z-overlay)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--t-space-6)',
      background: 'var(--t-bg)',
      color: 'var(--t-text)',
      fontFamily: 'var(--t-font)',
    });
    doc.body.append(panel);
  }
  if (panel.dataset.state === repairState) return;
  panel.dataset.state = repairState;
  const column = doc.createElement('div');
  Object.assign(column.style, { maxWidth: '36rem', display: 'flex', flexDirection: 'column', gap: 'var(--t-space-6)' });
  for (const [lang, copy] of Object.entries(STUDIO_KEY_NOTICE[repairState])) {
    const block = doc.createElement('section');
    block.lang = lang;
    Object.assign(block.style, { display: 'flex', flexDirection: 'column', gap: 'var(--t-space-2)' });
    const title = doc.createElement('h1');
    title.textContent = copy.title;
    Object.assign(title.style, { margin: '0', fontSize: 'var(--t-font-xl)', lineHeight: 'var(--t-lh-xl)' });
    const body = doc.createElement('p');
    body.textContent = copy.body;
    Object.assign(body.style, { margin: '0', color: 'var(--t-text-dim)', lineHeight: 'var(--t-lh-body)' });
    block.append(title, body);
    column.append(block);
  }
  panel.replaceChildren(column);
}

// On load, before the router renders (this module is imported by the client the app is built on):
// the index route redirects with `replace`, which would drop the fragment, so it is read now.
if (typeof window !== 'undefined') {
  captureStudioKeyFromFragment(window);
  // A link that differs from the open page only in its fragment (TILL.app's rekey while the Studio is
  // at `/`, a reopened link in the same tab) does not reload the page (critic r3 L3): take the ticket
  // here, redeem it, and reload with the working credential.
  window.addEventListener('hashchange', () => {
    if (captureStudioKeyFromFragment(window) === null || pendingTicket === null) return;
    void redeemPendingTicket(window).then((ok) => {
      if (ok) window.location.reload();
    });
  });
}
