/**
 * The Studio key, browser side (critic P6 and R3-B2): the key arrives in the URL fragment of the link
 * `till up` opens, moves into this tab's sessionStorage, and leaves the URL. A tab without a usable
 * key is refused by the engine ONCE, then shows the notice and sends nothing more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchTransport, type RestResponse } from './client';
import { mcpTransportOver } from './mcp-transport';
import {
  STUDIO_KEY_HEADER,
  STUDIO_KEY_MISSING,
  STUDIO_KEY_NOTICE,
  STUDIO_KEY_NOTICE_ID,
  STUDIO_KEY_STORAGE,
  captureStudioKeyFromFragment,
  guardStudioKey,
  isStudioKeyRefusal,
  readStudioKey,
  resetStudioKeyState,
  studioKeyHeaders,
  studioKeyRefused,
} from './studio-key';

const KEY = 'A'.repeat(43);
const NEW_KEY = 'B'.repeat(43);

function notice(): HTMLElement | null {
  return document.getElementById(STUDIO_KEY_NOTICE_ID);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  notice()?.remove();
  resetStudioKeyState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the key arrives in the fragment of the printed link', () => {
  it('moves it into sessionStorage and strips it from the URL', () => {
    window.history.replaceState(null, '', `/overview?tab=2#k=${KEY}`);
    expect(captureStudioKeyFromFragment(window)).toBe(KEY);
    expect(window.sessionStorage.getItem(STUDIO_KEY_STORAGE)).toBe(KEY);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(KEY);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/overview?tab=2');
    expect(readStudioKey()).toBe(KEY);
    expect(studioKeyHeaders()).toEqual({ [STUDIO_KEY_HEADER]: KEY });
  });

  it('keeps any other fragment content', () => {
    window.history.replaceState(null, '', `/#k=${KEY}&section=open`);
    captureStudioKeyFromFragment(window);
    expect(window.location.hash).toBe('#section=open');
  });

  it('strips a malformed key without keeping it, and leaves a fragment with no key alone', () => {
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

describe('a tab without a usable key', () => {
  it('asks the engine ONCE, then shows the notice and sends nothing more', async () => {
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

    for (let i = 0; i < 5; i++) await transport('list_accounts', {});
    expect(inner).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`#${STUDIO_KEY_NOTICE_ID}`)).toHaveLength(1);
  });

  it('after a restart: the old key is refused, dropped from the tab, and the notice says to re-open the link', async () => {
    window.sessionStorage.setItem(STUDIO_KEY_STORAGE, KEY);
    const inner = vi.fn(async (): Promise<RestResponse> => ({ status: 401, body: { ok: false, error: 'studio_key_invalid' } }));
    const transport = guardStudioKey(inner);
    await transport('list_workspaces', {});
    expect(readStudioKey()).toBeNull();
    expect(notice()?.textContent).toContain('#k=');
    await transport('list_workspaces', {});
    expect(inner).toHaveBeenCalledTimes(1);

    // Re-opening the NEW printed link is the way back in.
    window.history.replaceState(null, '', `/#k=${NEW_KEY}`);
    captureStudioKeyFromFragment(window);
    expect(studioKeyRefused()).toBe(false);
    expect(studioKeyHeaders()).toEqual({ [STUDIO_KEY_HEADER]: NEW_KEY });
  });

  it('a served deployment (no key, seated by the proxy) is not refused and shows nothing', async () => {
    const inner = vi.fn(async (): Promise<RestResponse> => ({ status: 200, body: { ok: true } }));
    const transport = guardStudioKey(inner);
    expect((await transport('whoami', {})).status).toBe(200);
    expect((await transport('whoami', {})).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
  });

  it('the notice is calm, in both languages, du, with no sharp s and no em dash', () => {
    for (const copy of Object.values(STUDIO_KEY_NOTICE)) {
      // Built from code points so this file itself carries neither character (check:style reads tests).
    const banned = String.fromCharCode(0xdf, 0x2014);
    for (const ch of banned) expect(`${copy.title} ${copy.body}`).not.toContain(ch);
      expect(copy.body).toContain('till up');
      expect(copy.body).toContain('#k=');
    }
    expect(STUDIO_KEY_NOTICE['de-CH'].title).toMatch(/^Öffne TILL/);
    expect(STUDIO_KEY_NOTICE['de-CH'].body).toMatch(/deinen/);
    expect(STUDIO_KEY_NOTICE['de-CH'].body).not.toMatch(/\b(Sie|Ihre?n?)\b/);
  });

  it('recognises the refusal in every shape it arrives in', () => {
    expect(isStudioKeyRefusal({ ok: false, error: 'studio_key_invalid' })).toBe(true);
    expect(isStudioKeyRefusal({ ok: false, error: 'transport_error', detail: 'HTTP 401: {"error":"studio_key_required"}' })).toBe(true);
    expect(isStudioKeyRefusal(new Error('studio_key_required'))).toBe(true);
    expect(isStudioKeyRefusal({ ok: false, error: 'workspace_not_found' })).toBe(false);
  });
});

describe('the transports', () => {
  it('the REST bridge sends the key, and a refusal stops it', async () => {
    window.sessionStorage.setItem(STUDIO_KEY_STORAGE, KEY);
    const seen: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
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
