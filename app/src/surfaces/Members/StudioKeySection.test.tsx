/**
 * D166: "Auf allen Geräten abmelden". It shows only where this tab holds a Studio credential, takes a
 * confirm, sends the CURRENT key to the rotate door, keeps the new key for this browser, and says so;
 * a failed rotation says the old key still applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { I18nProvider } from '../../i18n';
import { STUDIO_KEY_HEADER, STUDIO_KEY_STORAGE, STUDIO_ROTATE_PATH, readStudioKey, resetStudioKeyState } from '../../lib/studio-key';
import { StudioKeySection } from './StudioKeySection';
import de from './messages.de-CH.json';

const KEY = 'A'.repeat(43);
const NEW_TOKEN = 'B'.repeat(43);

function renderSection() {
  return render(
    <I18nProvider>
      <StudioKeySection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetStudioKeyState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudioKeySection (D166)', () => {
  it('renders nothing where this browser holds no key (a served deployment)', () => {
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms, rotates with the current key, keeps the new one, and says so', async () => {
    window.sessionStorage.setItem(STUDIO_KEY_STORAGE, KEY);
    const sent: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, key: new Headers(init?.headers).get(STUDIO_KEY_HEADER) });
        return new Response(JSON.stringify({ ok: true, token: NEW_TOKEN }), { status: 200 });
      }),
    );
    const { container } = renderSection();
    expect(screen.getByRole('heading', { name: de.members.device.title })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByRole('button', { name: de.members.device.signOutAll }));
    const dialog = await screen.findByRole('alertdialog', { name: de.members.device.confirm.title });
    expect(dialog).toHaveTextContent(de.members.device.confirm.body);
    expect(sent).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: de.members.device.confirm.confirm }));
    await waitFor(() => expect(screen.getByText(de.members.device.done)).toBeInTheDocument());
    expect(sent[0]).toEqual({ url: STUDIO_ROTATE_PATH, key: KEY });
    expect(readStudioKey()).toBe(NEW_TOKEN);
  });

  it('a failed rotation keeps the current key and says so', async () => {
    window.sessionStorage.setItem(STUDIO_KEY_STORAGE, KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'studio_key_rotate_failed' }), { status: 500 })));
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: de.members.device.signOutAll }));
    await userEvent.click(await screen.findByRole('button', { name: de.members.device.confirm.confirm }));
    await waitFor(() => expect(screen.getByText(de.members.device.failed)).toBeInTheDocument());
    expect(readStudioKey()).toBe(KEY);
  });

  it('the copy never names a terminal, uses du, and has no sharp s (both locales)', async () => {
    const en = (await import('./messages.en.json')).default;
    const banned = String.fromCharCode(0xdf, 0x2014);
    for (const copy of [de.members.device, en.members.device]) {
      const text = JSON.stringify(copy);
      for (const ch of banned) expect(text).not.toContain(ch);
      expect(text).not.toMatch(/terminal|till up|#k=/i);
    }
    expect(JSON.stringify(de.members.device)).not.toMatch(/\b(Sie|Ihre?n?)\b/);
  });
});
