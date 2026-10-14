/**
 * The Studio key, browser side (critic probe P6 and critic R3-B2, owner decision 2026-10-12).
 *
 * The engine hands the human `studio` seat ONLY to a request that carries the per-launch Studio key
 * (`src/api/session.ts`). The key reaches this tab OUT OF BAND, the Jupyter-token way: `till up` (or
 * the Vite dev bridge) prints and opens `http://HOST:PORT/#k=<key>`. A URL fragment is never sent to a
 * server, so a program that fetches the Studio page learns nothing; only the browser that opened the
 * link has the key. On load this module moves the key into `sessionStorage` (this tab only) and strips
 * the fragment with `history.replaceState`, so it lingers neither in the address bar nor in a copied
 * link. Every engine call then sends it in the `x-till-studio-key` header (`studioKeyHeaders`).
 *
 * A tab WITHOUT a usable key (opened without the link, or holding the key of an earlier start after
 * TILL restarted) is told so ONCE by the engine (`studio_key_required` / `studio_key_invalid`). From
 * then on `guardStudioKey` answers every call locally, with no request at all, and a calm full-page
 * notice says how to get back in: open the link `till up` printed. Nothing loops, nothing retries.
 *
 * Why a header and not a cookie is argued in `src/api/up.ts`. In short: a custom header cannot ride on
 * a request another origin started, a cookie on `localhost` can.
 */
import type { RestResponse, Transport } from './client';

/** Mirrors `STUDIO_KEY_HEADER` in `src/api/session.ts`. */
export const STUDIO_KEY_HEADER = 'x-till-studio-key';

/** Mirrors `STUDIO_KEY_FRAGMENT` in `src/api/session.ts`: the link ends in `#k=<key>`. */
export const STUDIO_KEY_FRAGMENT = 'k';

/** Where this tab keeps the key: `sessionStorage`, so it lives as long as the tab and no longer. */
export const STUDIO_KEY_STORAGE = 'till-studio-key';

/** The engine's refusals of a Studio call that has no key, or a key it did not issue. */
export const STUDIO_KEY_REFUSALS = ['studio_key_required', 'studio_key_invalid'] as const;

/** What this module answers locally once the tab is known to have no usable key. */
export const STUDIO_KEY_MISSING = 'studio_key_missing';

/** The id of the full-page notice, so it is inserted once and tests can find it. */
export const STUDIO_KEY_NOTICE_ID = 'till-studio-key-notice';

const KEY_SHAPE = /^[A-Za-z0-9_-]{43,}$/;

function storage(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null; // storage disabled: the tab then behaves as one without a key
  }
}

/**
 * Take the key out of the URL fragment, keep it for this tab, and strip it from the URL. Any other
 * fragment content survives. Returns the key it kept, or null. A malformed `k` is stripped and not kept.
 */
export function captureStudioKeyFromFragment(win: Window): string | null {
  const hash = win.location.hash.replace(/^#/, '');
  if (hash === '') return null;
  const params = new URLSearchParams(hash);
  if (!params.has(STUDIO_KEY_FRAGMENT)) return null;
  const key = params.get(STUDIO_KEY_FRAGMENT) ?? '';
  params.delete(STUDIO_KEY_FRAGMENT);
  const rest = params.toString();
  const { pathname, search } = win.location;
  win.history.replaceState(win.history.state, '', `${pathname}${search}${rest === '' ? '' : `#${rest}`}`);
  if (!KEY_SHAPE.test(key)) return null;
  try {
    storage(win)?.setItem(STUDIO_KEY_STORAGE, key);
  } catch {
    return null;
  }
  refused = false; // a freshly opened link is a fresh chance
  return key;
}

/** The key this tab holds, or null. */
export function readStudioKey(win: Window | undefined = typeof window === 'undefined' ? undefined : window): string | null {
  if (win === undefined) return null;
  try {
    const key = storage(win)?.getItem(STUDIO_KEY_STORAGE) ?? null;
    return key !== null && KEY_SHAPE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** The header to send on an engine call: the key when this tab has one, nothing otherwise. */
export function studioKeyHeaders(win?: Window): Record<string, string> {
  const key = win === undefined ? readStudioKey() : readStudioKey(win);
  return key === null ? {} : { [STUDIO_KEY_HEADER]: key };
}

/** Did the engine refuse this call for want of a valid Studio key? */
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

/** Set once the engine refused this tab's key (or its lack of one); cleared by a fresh link. */
let refused = false;

/** Has the engine refused this tab? Then no further request is sent. */
export function studioKeyRefused(): boolean {
  return refused;
}

/** Test seam: forget a refusal, as a fresh page load would. */
export function resetStudioKeyState(): void {
  refused = false;
}

/** The engine refused this tab: drop the useless key, stop sending, and show how to get back in. */
export function markStudioKeyRefused(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  refused = true;
  if (doc === undefined) return;
  try {
    doc.defaultView?.sessionStorage.removeItem(STUDIO_KEY_STORAGE);
  } catch {
    // nothing to drop
  }
  showStudioKeyNotice(doc);
}

/** The local answer for a call this tab cannot make. Shaped like any refusal the surfaces read. */
export function studioKeyMissingResponse(): RestResponse {
  return {
    status: 401,
    body: { ok: false, error: STUDIO_KEY_MISSING, detail: 'open TILL through the link till up printed' },
  };
}

/**
 * Wrap a transport so a tab without a usable key asks the engine ONCE and then stops: after the
 * engine's refusal every call is answered here, with no request, and the notice is on screen. A tab
 * WITHOUT a key still asks once rather than never, because a served deployment (M01, behind a proxy)
 * seats the person by the attested subject and needs no key at all.
 */
export function guardStudioKey(inner: Transport): Transport {
  const guarded: Transport = async (action, input) => {
    if (refused) {
      showStudioKeyNotice();
      return studioKeyMissingResponse();
    }
    const resp = await inner(action, input);
    if (!resp.body.ok && isStudioKeyRefusal(resp.body)) {
      markStudioKeyRefused();
      return studioKeyMissingResponse();
    }
    return resp;
  };
  if (inner.resetSession !== undefined) guarded.resetSession = inner.resetSession;
  return guarded;
}

/**
 * The notice copy, in both Studio languages. du, no sharp s, no em dash (house style), and calm: it
 * says what happened and the one thing to do, with no alarm and no blame.
 */
export const STUDIO_KEY_NOTICE = {
  'de-CH': {
    title: 'Öffne TILL über den Link aus dem Terminal',
    body: 'Diesem Tab fehlt der Schlüssel zu deinen Büchern. Beim Start zeigt till up einen Link an, der mit #k= endet, und öffnet ihn. Öffne diesen Link. Nach einem Neustart von TILL gilt nur der neue Link.',
  },
  en: {
    title: 'Open TILL through the link from your terminal',
    body: 'This tab does not have the key to your books. When it starts, till up prints a link that ends in #k= and opens it. Open that link. After TILL restarts, only the new link works.',
  },
} as const;

/** Put the full-page notice up, once. Plain DOM, so it shows whatever state the app is in. */
export function showStudioKeyNotice(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc === undefined || doc.getElementById(STUDIO_KEY_NOTICE_ID) !== null || doc.body === null) return;
  const panel = doc.createElement('div');
  panel.id = STUDIO_KEY_NOTICE_ID;
  panel.setAttribute('role', 'alert');
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
  const column = doc.createElement('div');
  Object.assign(column.style, { maxWidth: '36rem', display: 'flex', flexDirection: 'column', gap: 'var(--t-space-6)' });
  for (const [lang, copy] of Object.entries(STUDIO_KEY_NOTICE)) {
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
  panel.append(column);
  doc.body.append(panel);
}

// On load, before the router renders (this module is imported by the client the app is built on):
// the index route redirects with `replace`, which would drop the fragment, so it is read now.
if (typeof window !== 'undefined') captureStudioKeyFromFragment(window);
