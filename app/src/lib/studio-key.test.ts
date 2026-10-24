/**
 * The Studio key, browser side (critic P6, R3-B2 and D166): the key arrives in the URL fragment of the
 * link TILL opens, lives in THIS TAB's sessionStorage, and leaves the URL. Once accepted, the browser
 * pairs a NON-EXTRACTABLE device key; a new tab or a bookmark unlocks a session token with it. Nothing
 * a page could read and replay is stored in localStorage. A refused tab repairs itself with no click
 * (the device, the native app's bridge, or ONE OS reopen per tab) and shows a calm notice that never
 * names a terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchTransport, type RestResponse } from './client';
import { mcpTransportOver } from './mcp-transport';
import {
  REOPEN_SETTLE_MS,
  STUDIO_CHALLENGE_PATH,
  STUDIO_DEVICE_STORAGE,
  STUDIO_KEY_HEADER,
  STUDIO_KEY_MISSING,
  STUDIO_KEY_NOTICE,
  STUDIO_KEY_NOTICE_ID,
  STUDIO_KEY_STORAGE,
  STUDIO_REDEEM_PATH,
  STUDIO_REOPEN_HEADER,
  STUDIO_REOPEN_PATH,
  STUDIO_REOPEN_TRIED,
  STUDIO_ROTATE_PATH,
  STUDIO_SESSION_STORAGE,
  STUDIO_UNLOCK_PATH,
  STUDIO_ADOPT_PATH,
  STUDIO_PROVE_PATH,
  adoptBook,
  captureStudioKeyFromFragment,
  guardStudioKey,
  hasNativeBookPicker,
  hasStudioKey,
  isStudioKeyRefusal,
  pickBookNatively,
  readStudioKey,
  reloadAfterRestart,
  resetStudioKeyState,
  rotateStudioKey,
  setDeviceStoreForTests,
  studioKeyHeaders,
  studioKeyRefused,
  studioKeyRepairState,
  unlockMessage,
  type DeviceStore,
  type StoredDevice,
} from './studio-key';

const KEY = 'A'.repeat(43);
const TICKET = 'K'.repeat(43);
const TOKEN = 'T'.repeat(43);
const ROTATED_TOKEN = 'R'.repeat(43);

function notice(): HTMLElement | null {
  return document.getElementById(STUDIO_KEY_NOTICE_ID);
}

const refusedInvalid = async (): Promise<RestResponse> => ({ status: 401, body: { ok: false, error: 'studio_key_invalid' } });

function memoryDeviceStore(): DeviceStore & { device: StoredDevice | null } {
  const store = {
    device: null as StoredDevice | null,
    get: async () => store.device,
    put: async (d: StoredDevice) => {
      store.device = d;
    },
    clear: async () => {
      store.device = null;
    },
  };
  return store;
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A fake engine door: redeems ONE ticket (pairing the device sent along), challenges, VERIFIES the
 * WebCrypto signature with the registered public key, unlocks, reopens and rotates (answering with a
 * token, never a key). Records every call with its credential header.
 */
function fakeDoor(opts: { reopen?: { status: number; body: unknown } } = {}) {
  let ticket: string | null = TICKET;
  const tokens = new Set([TOKEN]);
  const devices = new Map<string, CryptoKey>();
  const nonces = new Map<string, string>();
  const calls: Array<{ url: string; credential: string | null; body: unknown; headers: Headers }> = [];
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const credential = headers.get(STUDIO_KEY_HEADER);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, credential, body, headers });
      if (url === STUDIO_REDEEM_PATH) {
        if (body?.ticket !== ticket) return json(401, { ok: false, error: 'ticket_invalid' });
        ticket = null; // once
        if (body.publicKey === undefined) return json(200, { ok: true, token: TOKEN });
        const jwk = body.publicKey as JsonWebKey;
        if ('d' in jwk) return json(401, { ok: false, error: 'device_key_invalid' });
        const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const deviceId = `D${String(++n).padStart(42, '0')}`;
        devices.set(deviceId, pub);
        return json(200, { ok: true, token: TOKEN, deviceId });
      }
      if (url === STUDIO_CHALLENGE_PATH) {
        const deviceId = body?.deviceId as string;
        if (!devices.has(deviceId)) return json(401, { ok: false, error: 'device_unknown' });
        const nonce = `N${String(++n).padStart(42, '0')}`;
        nonces.set(nonce, deviceId);
        return json(200, { ok: true, nonce });
      }
      if (url === STUDIO_UNLOCK_PATH) {
        const { deviceId, nonce, signature } = body as { deviceId: string; nonce: string; signature: string };
        const pub = devices.get(deviceId);
        if (pub === undefined || nonces.get(nonce) !== deviceId) return json(401, { ok: false, error: 'challenge_invalid' });
        nonces.delete(nonce);
        const good = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          pub,
          b64urlDecode(signature),
          new TextEncoder().encode(unlockMessage(deviceId, nonce)),
        );
        return good ? json(200, { ok: true, token: TOKEN }) : json(401, { ok: false, error: 'signature_invalid' });
      }
      if (url === STUDIO_REOPEN_PATH) {
        const answer = opts.reopen ?? { status: 200, body: { ok: true, opened: true } };
        return json(answer.status, answer.body);
      }
      if (url === STUDIO_ROTATE_PATH) {
        if (credential === null || !tokens.has(credential)) return json(401, { ok: false, error: 'studio_key_invalid' });
        devices.clear();
        tokens.clear();
        tokens.add(ROTATED_TOKEN);
        const jwk = body?.publicKey as JsonWebKey | undefined;
        if (jwk === undefined) return json(200, { ok: true, token: ROTATED_TOKEN });
        const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const deviceId = `D${String(++n).padStart(42, '0')}`;
        devices.set(deviceId, pub);
        return json(200, { ok: true, token: ROTATED_TOKEN, deviceId });
      }
      return json(404, { ok: false });
    }),
  );
  return { calls, devices, door: () => calls.map((c) => c.url) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

let devices: ReturnType<typeof memoryDeviceStore>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  notice()?.remove();
  resetStudioKeyState();
  devices = memoryDeviceStore();
  setDeviceStoreForTests(devices);
  delete (window as unknown as { webkit?: unknown }).webkit;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setDeviceStoreForTests(null);
  delete (window as unknown as { webkit?: unknown }).webkit;
});

describe('the link carries a one-time ticket, never the key', () => {
  it('takes the ticket out of the URL at once and keeps nothing in storage until it is redeemed', () => {
    window.localStorage.setItem(STUDIO_KEY_STORAGE, KEY); // what the first D166 cut left behind
    window.history.replaceState(null, '', `/overview?tab=2#t=${TICKET}`);
    expect(captureStudioKeyFromFragment(window)).toBe(TICKET);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TICKET);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/overview?tab=2');
    expect(window.localStorage.getItem(STUDIO_KEY_STORAGE)).toBeNull();
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) expect(store.getItem(store.key(i)!)).not.toBe(TICKET);
    }
    expect(readStudioKey()).toBeNull();
  });

  it('the dev bridge still hands a #k= key; it stays in its tab, never in localStorage', () => {
    window.history.replaceState(null, '', `/#k=${KEY}&section=open`);
    expect(captureStudioKeyFromFragment(window)).toBe(KEY);
    expect(window.sessionStorage.getItem(STUDIO_KEY_STORAGE)).toBe(KEY);
    expect(window.localStorage.getItem(STUDIO_KEY_STORAGE)).toBeNull();
    expect(window.location.hash).toBe('#section=open');
    expect(hasStudioKey()).toBe(true);
    expect(studioKeyHeaders()).toEqual({ [STUDIO_KEY_HEADER]: KEY });
  });

  it('strips a malformed value without keeping it, and leaves a fragment with neither alone', () => {
    window.history.replaceState(null, '', '/#k=short');
    expect(captureStudioKeyFromFragment(window)).toBeNull();
    expect(window.location.hash).toBe('');
    expect(readStudioKey()).toBeNull();
    expect(studioKeyHeaders()).toEqual({});

    window.history.replaceState(null, '', '/#section=open');
    expect(captureStudioKeyFromFragment(window)).toBeNull();
    expect(window.location.hash).toBe('#section=open');
  });
});

describe('redeem and pair: no secret a page could read is stored in the browser', () => {
  it('the first call redeems the ticket, pairing a NON-EXTRACTABLE device key; localStorage holds only the device id', async () => {
    const door = fakeDoor();
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    captureStudioKeyFromFragment(window);
    const inner = vi.fn(async (): Promise<RestResponse> => ({ status: 200, body: { ok: true, sent: studioKeyHeaders()[STUDIO_KEY_HEADER] } }));
    const resp = await guardStudioKey(inner)('whoami', {});
    expect(resp.body).toMatchObject({ ok: true, sent: TOKEN });
    expect(door.door()).toEqual([STUDIO_REDEEM_PATH]);
    expect(door.calls[0]?.credential).toBeNull();
    expect(Object.keys(door.calls[0]?.body as object).sort()).toEqual(['publicKey', 'ticket']);
    expect(devices.device?.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', devices.device!.privateKey)).rejects.toThrow();
    expect(window.localStorage.getItem(STUDIO_DEVICE_STORAGE)).toBe(devices.device?.deviceId);
    expect(window.sessionStorage.getItem(STUDIO_SESSION_STORAGE)).toBe(TOKEN);
    for (let i = 0; i < window.localStorage.length; i++) {
      const value = window.localStorage.getItem(window.localStorage.key(i)!);
      expect([TOKEN, TICKET, KEY]).not.toContain(value);
    }
  });

  it('a bookmark or new tab of a paired browser unlocks a session token with a signed challenge and carries on', async () => {
    const door = fakeDoor();
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    captureStudioKeyFromFragment(window);
    await guardStudioKey(async () => ({ status: 200, body: { ok: true } }))('whoami', {});

    // A new tab: fresh module state and an empty sessionStorage, the same localStorage and IndexedDB.
    resetStudioKeyState();
    window.sessionStorage.clear();
    const inner = vi.fn(async (): Promise<RestResponse> =>
      studioKeyHeaders()[STUDIO_KEY_HEADER] === TOKEN ? { status: 200, body: { ok: true } } : { status: 401, body: { ok: false, error: 'studio_key_required' } },
    );
    const resp = await guardStudioKey(inner)('list_workspaces', {});
    expect(resp.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(door.door()).toEqual([STUDIO_REDEEM_PATH, STUDIO_CHALLENGE_PATH, STUDIO_UNLOCK_PATH]);
    expect(window.sessionStorage.getItem(STUDIO_SESSION_STORAGE)).toBe(TOKEN);
    expect(notice()).toBeNull();
  });

  it('a spent or crafted ticket cannot strand a paired browser: the device takes over (key fixation)', async () => {
    fakeDoor();
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    captureStudioKeyFromFragment(window);
    await guardStudioKey(async () => ({ status: 200, body: { ok: true } }))('whoami', {});
    resetStudioKeyState();
    window.sessionStorage.clear();

    window.history.replaceState(null, '', `/#t=${TICKET}`); // the same link again, from history
    captureStudioKeyFromFragment(window);
    const inner = vi.fn(async (): Promise<RestResponse> =>
      studioKeyHeaders()[STUDIO_KEY_HEADER] === TOKEN ? { status: 200, body: { ok: true } } : { status: 401, body: { ok: false, error: 'studio_key_required' } },
    );
    expect((await guardStudioKey(inner)('whoami', {})).status).toBe(200);
    expect(notice()).toBeNull();
  });

  it('a restart (every token forgotten) is repaired by unlocking again, with no notice', async () => {
    fakeDoor();
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    captureStudioKeyFromFragment(window);
    await guardStudioKey(async () => ({ status: 200, body: { ok: true } }))('whoami', {});
    resetStudioKeyState();
    window.sessionStorage.clear();
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, 'O'.repeat(43)); // a token of the previous process
    let first = true;
    const resp = await guardStudioKey(async () => {
      if (first) {
        first = false;
        return refusedInvalid();
      }
      return { status: 200, body: { ok: true } };
    })('whoami', {});
    expect(resp.status).toBe(200);
    expect(window.sessionStorage.getItem(STUDIO_SESSION_STORAGE)).toBe(TOKEN);
    expect(notice()).toBeNull();
  });
});

describe('a tab with nothing silent left repairs itself visibly', () => {
  it('asks the engine ONCE, then asks the door to reopen through the OS, with no credential in the request', async () => {
    const door = fakeDoor();
    const inner = vi.fn(
      async (): Promise<RestResponse> => ({
        status: 0,
        body: { ok: false, error: 'transport_error', detail: 'Error POSTing to endpoint: {"error":"studio_key_required"}' },
      }),
    );
    const transport = guardStudioKey(inner);
    const first = await transport('list_workspaces', {});
    expect(first.status).toBe(401);
    expect(first.body).toMatchObject({ ok: false, error: STUDIO_KEY_MISSING });
    expect(studioKeyRefused()).toBe(true);
    expect(notice()).not.toBeNull();
    expect(studioKeyRepairState()).toBe('opening');

    for (let i = 0; i < 5; i++) await transport('list_accounts', {});
    expect(inner).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`#${STUDIO_KEY_NOTICE_ID}`)).toHaveLength(1);

    await flush();
    const reopen = door.calls.filter((c) => c.url === STUDIO_REOPEN_PATH);
    expect(reopen).toHaveLength(1);
    expect(reopen[0]?.headers.get(STUDIO_REOPEN_HEADER)).toBe('1');
    expect(reopen[0]?.credential).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem(STUDIO_REOPEN_TRIED) ?? '{}')).toMatchObject({ opened: true });
  });

  it('when the reopened tab pairs, this tab unlocks and reloads', async () => {
    fakeDoor();
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    // The reopened tab, same browser: it redeems the ticket the OS handed it, pairing the device.
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    captureStudioKeyFromFragment(window);
    const { redeemPendingTicket } = await import('./studio-key');
    expect(await redeemPendingTicket(window)).toBe(true);
    window.sessionStorage.removeItem(STUDIO_SESSION_STORAGE); // that token was the other tab's
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    window.dispatchEvent(new StorageEvent('storage', { key: STUDIO_DEVICE_STORAGE, newValue: devices.device!.deviceId }));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says TILL opened elsewhere when nothing arrives in this browser in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    fakeDoor();
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    expect(studioKeyRepairState()).toBe('opening');
    vi.advanceTimersByTime(REOPEN_SETTLE_MS);
    expect(studioKeyRepairState()).toBe('elsewhere');
    expect(notice()?.dataset.state).toBe('elsewhere');
  });

  it('one attempt per tab: a reload of a still-keyless tab does not reopen again (no loop)', async () => {
    const door = fakeDoor();
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    notice()?.remove();
    resetStudioKeyState();
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    expect(door.calls.filter((c) => c.url === STUDIO_REOPEN_PATH)).toHaveLength(1);
    expect(studioKeyRepairState()).toBe('elsewhere');
  });

  it('a refused door (rate-limited, or no door at all) ends calmly in the icon hint', async () => {
    fakeDoor({ reopen: { status: 429, body: { ok: false, error: 'reopen_rate_limited', retryAfterSeconds: 9 } } });
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    expect(studioKeyRepairState()).toBe('unavailable');
    expect(notice()?.textContent).toContain(STUDIO_KEY_NOTICE.unavailable['de-CH'].title);
  });

  it('inside TILL.app it asks the app to rekey, and asks the server for no reopen', async () => {
    const door = fakeDoor();
    const postMessage = vi.fn();
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { till: { postMessage } } };
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'rekey' });
    expect(door.calls.filter((c) => c.url === STUDIO_REOPEN_PATH)).toHaveLength(0);
    expect(studioKeyRepairState()).toBe('opening');
  });

  it('inside TILL.app the ticket is redeemed WITHOUT a device key, and nothing is read from or put into IndexedDB', async () => {
    const door = fakeDoor();
    const postMessage = vi.fn();
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { till: { postMessage } } };
    const get = vi.spyOn(devices, 'get');
    const put = vi.spyOn(devices, 'put');
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    captureStudioKeyFromFragment(window);
    expect((await guardStudioKey(async () => ({ status: 200, body: { ok: true } }))('whoami', {})).status).toBe(200);
    expect(door.calls[0]?.body).toEqual({ ticket: TICKET });
    expect(window.sessionStorage.getItem(STUDIO_SESSION_STORAGE)).toBe(TOKEN);
    // A restart: the token is refused, and the app is asked to rekey; no device unlock is tried.
    await guardStudioKey(refusedInvalid)('whoami', {});
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'rekey' });
    expect(door.door()).toEqual([STUDIO_REDEEM_PATH]);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('inside TILL.app a page whose own link ticket was refused does not ask again (no reload loop)', async () => {
    fakeDoor();
    const postMessage = vi.fn();
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { till: { postMessage } } };
    window.history.replaceState(null, '', `/#t=${'X'.repeat(43)}`);
    captureStudioKeyFromFragment(window);
    await guardStudioKey(refusedInvalid)('list_workspaces', {});
    await flush();
    expect(postMessage).not.toHaveBeenCalled();
    expect(studioKeyRepairState()).toBe('unavailable');
  });

  it('a ticket arriving by a fragment-only change (no page load) is taken and redeemed (critic r3 L3)', async () => {
    const door = fakeDoor();
    window.history.replaceState(null, '', `/#t=${TICKET}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => expect(window.sessionStorage.getItem(STUDIO_SESSION_STORAGE)).toBe(TOKEN));
    expect(window.location.hash).toBe('');
    expect(door.door()).toEqual([STUDIO_REDEEM_PATH]);
  });

  it('a served deployment (no key, seated by the proxy) is not refused and shows nothing', async () => {
    const inner = vi.fn(async (): Promise<RestResponse> => ({ status: 200, body: { ok: true } }));
    const transport = guardStudioKey(inner);
    expect((await transport('whoami', {})).status).toBe(200);
    expect((await transport('whoami', {})).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
  });

  it('the notice is calm, in both languages, du, no sharp s, no em dash, and NEVER names a terminal (owner, D166)', () => {
    // Built from code points so this file itself carries neither character (check:style reads tests).
    const banned = String.fromCharCode(0xdf, 0x2014);
    for (const states of Object.values(STUDIO_KEY_NOTICE)) {
      for (const copy of Object.values(states)) {
        const text = `${copy.title} ${copy.body}`;
        for (const ch of banned) expect(text).not.toContain(ch);
        expect(text).not.toMatch(/terminal|till up|#k=|Befehl|command|Link aus/i);
      }
      expect(states['de-CH'].body).not.toMatch(/\b(Sie|Ihre?n?)\b/);
    }
    expect(STUDIO_KEY_NOTICE.opening['de-CH'].title).toBe('TILL wird geöffnet …');
  });

  it('recognises the refusal in every shape it arrives in', () => {
    expect(isStudioKeyRefusal({ ok: false, error: 'studio_key_invalid' })).toBe(true);
    expect(isStudioKeyRefusal({ ok: false, error: 'transport_error', detail: 'HTTP 401: {"error":"studio_key_required"}' })).toBe(true);
    expect(isStudioKeyRefusal(new Error('studio_key_required'))).toBe(true);
    expect(isStudioKeyRefusal({ ok: false, error: 'workspace_not_found' })).toBe(false);
  });
});

describe('Auf allen Geräten abmelden', () => {
  it('sends the current credential and a NEW device key, keeps the fresh token, and never receives a key', async () => {
    const door = fakeDoor();
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, TOKEN);
    expect(await rotateStudioKey()).toEqual({ ok: true });
    expect(door.door()).toEqual([STUDIO_ROTATE_PATH]);
    expect(door.calls[0]?.credential).toBe(TOKEN);
    expect(Object.keys(door.calls[0]?.body as object)).toEqual(['publicKey']);
    expect(readStudioKey()).toBe(ROTATED_TOKEN);
    expect(devices.device).not.toBeNull();
    expect(window.localStorage.getItem(STUDIO_DEVICE_STORAGE)).toBe(devices.device?.deviceId);
  });

  it('a failed rotation keeps the current credential', async () => {
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'studio_key_rotate_failed' }), { status: 500 })));
    expect(await rotateStudioKey()).toEqual({ ok: false, error: 'studio_key_rotate_failed' });
    expect(readStudioKey()).toBe(TOKEN);
  });
});

describe('the transports', () => {
  it('the REST bridge sends the key, and a refusal stops it', async () => {
    window.sessionStorage.setItem(STUDIO_KEY_STORAGE, KEY);
    const seen: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === STUDIO_REOPEN_PATH) return new Response(JSON.stringify({ ok: true, opened: true }), { status: 200 });
        seen.push(new Headers(init?.headers).get(STUDIO_KEY_HEADER));
        return new Response(JSON.stringify({ ok: false, error: 'studio_key_invalid' }), { status: 401 });
      }),
    );
    const transport = fetchTransport();
    await transport('list_accounts', {});
    await transport('list_accounts', {});
    expect(seen).toEqual([KEY]);
    expect(notice()).not.toBeNull();
  });

  it('a dead MCP session is closed when it fails, so its stream stops retrying', async () => {
    const close = vi.fn(async () => undefined);
    let connects = 0;
    const transport = mcpTransportOver(async () => {
      connects += 1;
      return {
        callTool: async () => {
          throw new Error('fetch failed');
        },
        close,
      } as never;
    });
    expect((await transport('list_accounts', {})).status).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(connects).toBe(1);
  });
});

/**
 * D166 point 8: adopting an existing book from the first run, with no terminal. The door call carries
 * the tab's credential; TILL.app's native picker answers through a reply-capable bridge; a browser tab
 * waits for the restarted host (a changed proof, or the host coming back) before it reloads.
 */
describe('adopting an existing book (D166 point 8)', () => {
  it('posts the path with the credential and reads restarting as success', async () => {
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, TOKEN);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, restarting: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await adoptBook('/Users/du/till.db')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(STUDIO_ADOPT_PATH);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get(STUDIO_KEY_HEADER)).toBe(TOKEN);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ path: '/Users/du/till.db' });
  });

  it('hands back the refusal code, and a dead connection as adopt_failed', async () => {
    window.sessionStorage.setItem(STUDIO_SESSION_STORAGE, TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'book_path_pinned' }), { status: 409 })));
    expect(await adoptBook('/x.db')).toEqual({ ok: false, error: 'book_path_pinned' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))));
    expect(await adoptBook('/x.db')).toEqual({ ok: false, error: 'adopt_failed' });
  });

  it('sends nothing from a tab with no credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await adoptBook('/x.db')).toEqual({ ok: false, error: STUDIO_KEY_MISSING });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses TILL.app's tillPick bridge when present, and reads a cancel as null", async () => {
    expect(hasNativeBookPicker()).toBe(false);
    expect(await pickBookNatively()).toBeNull();
    const postMessage = vi.fn(async (): Promise<unknown> => '/Users/du/Dokumente/till.db');
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { tillPick: { postMessage } } };
    expect(hasNativeBookPicker()).toBe(true);
    expect(await pickBookNatively()).toBe('/Users/du/Dokumente/till.db');
    expect(postMessage).toHaveBeenCalledWith({ type: 'pickBook' });
    postMessage.mockResolvedValueOnce(null);
    expect(await pickBookNatively()).toBeNull();
  });

  /** A fake `/studio/prove`: answers in order, `null` is a refused connection (the host is down). */
  function proveSequence(answers: (string | null)[]) {
    let i = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(STUDIO_PROVE_PATH);
      expect(init?.cache).toBe('no-store');
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer === null || answer === undefined) throw new TypeError('connection refused');
      return new Response(JSON.stringify({ ok: true, proof: answer }), { status: 200 });
    });
  }

  function fakeWindow(fetchMock: ReturnType<typeof proveSequence>) {
    const reload = vi.fn();
    return { win: { fetch: fetchMock, location: { reload } } as unknown as Window, reload };
  }

  const instant = async (): Promise<void> => {};

  it('a browser tab reloads once the proof changed (a new process answers), without waiting out the limit', async () => {
    const fetchMock = proveSequence(['OLD', 'OLD', 'NEW']);
    const { win, reload } = fakeWindow(fetchMock);
    await reloadAfterRestart(win, { nonce: 'n'.repeat(24), baseline: 'OLD', sleep: instant });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a browser tab reloads once the host came back after being unreachable', async () => {
    const fetchMock = proveSequence([null, null, 'ANY']);
    const { win, reload } = fakeWindow(fetchMock);
    await reloadAfterRestart(win, { nonce: 'n'.repeat(24), baseline: null, sleep: instant });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a browser tab reloads after the limit even if nothing ever changed', async () => {
    const fetchMock = proveSequence(['OLD']);
    const { win, reload } = fakeWindow(fetchMock);
    await reloadAfterRestart(win, { nonce: 'n'.repeat(24), baseline: 'OLD', pollMs: 1000, maxWaitMs: 5000, sleep: instant });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
