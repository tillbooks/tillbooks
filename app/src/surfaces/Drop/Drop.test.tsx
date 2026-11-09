/**
 * N02 (D183), the drop page's states: ready (the target named), uploading then done (with the way to the
 * booking), a pending Vorschlag, unpaired browser, unknown, expired, used, wrong type (refused before a
 * byte is sent, and by the engine), duplicate, failed with retry, and permission denied. The engine's
 * two calls are faked at `fetch`, exactly the boundary the page talks to (`/studio-drop/*`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { Drop } from './Drop';

const TARGET = {
  kind: 'journal_entry',
  id: 'entry_1',
  number: '2026-0142',
  text: 'Bürobedarf',
  date: '2026-06-12',
  amountMinor: 8450,
  currency: 'CHF',
  actionTool: null,
  route: '/journal?entry=entry_1',
};

function link(state: 'ready' | 'used' | 'expired', target: Record<string, unknown> = TARGET) {
  return { ok: true, link: { state, linkId: 'drop_1', workspaceId: 'ws_1', expiresAt: '2026-06-13T10:00:00.000Z', usedAt: null, fileId: null, target } };
}

type Answer = { status: number; body: Record<string, unknown> };

function fakeFetch(resolve: Answer, redeem?: Answer) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = path.endsWith('/resolve') ? resolve : (redeem ?? { status: 500, body: { ok: false, error: 'nope' } });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/drop/tok_abcdefghijklmnopqrstuvwxyz']}>
        <Routes>
          <Route path="/drop/:token" element={<Drop />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function pick(name: string, type: string, bytes: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([bytes], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('Drop page (N02)', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ready: names the target, then uploads and offers the way to the booking', async () => {
    const calls = fakeFetch(
      { status: 200, body: link('ready') },
      { status: 200, body: { ok: true, fileId: 'file_1', mime: 'image/jpeg', filename: 'quittung.jpg', duplicate: false, duplicateOf: null, holder: null, pending: false, target: TARGET } },
    );
    renderPage();
    const title = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(title.textContent).toContain('2026-0142'));
    expect(title.textContent).toContain('Bürobedarf');
    pick('quittung.jpg', 'image/jpeg', 'jpeg bytes');
    const back = await screen.findByRole('link');
    expect(back.getAttribute('href')).toBe('/journal?entry=entry_1');
    expect(calls.map((c) => c.path)).toEqual(['/studio-drop/resolve', '/studio-drop/redeem']);
    expect(calls[1]?.body.token).toBe('tok_abcdefghijklmnopqrstuvwxyz');
    expect(typeof calls[1]?.body.contentBase64).toBe('string');
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview');
  });

  it('a drop onto a waiting Vorschlag: the receipt is held and the page says it links on approval', async () => {
    const target = { ...TARGET, kind: 'drafted_action', number: null, route: '/agent' };
    fakeFetch(
      { status: 200, body: link('ready', target) },
      { status: 200, body: { ok: true, fileId: 'file_2', mime: 'application/pdf', filename: 'b.pdf', duplicate: false, duplicateOf: null, holder: null, pending: true, target } },
    );
    renderPage();
    await screen.findByText(/sobald du den Vorschlag genehmigst|once you approve the proposal/);
    pick('b.pdf', 'application/pdf', '%PDF-1.4');
    const back = await screen.findByRole('link');
    expect(back.getAttribute('href')).toBe('/agent');
  });

  it('wrong type is refused before anything is sent', async () => {
    const calls = fakeFetch({ status: 200, body: link('ready') });
    renderPage();
    await screen.findByText(/Datei wählen|Choose file/);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const zone = input.closest('.file-drop') ?? input.parentElement?.parentElement ?? document.body;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], types: ['Files'] } });
    await screen.findByRole('alert');
    expect(calls.map((c) => c.path)).toEqual(['/studio-drop/resolve']);
  });

  it('the engine refusals: wrong type, duplicate (naming the holder), failed with retry', async () => {
    fakeFetch({ status: 200, body: link('ready') }, { status: 422, body: { ok: false, error: 'unsupported_type' } });
    const first = renderPage();
    await screen.findByText(/Datei wählen|Choose file/);
    pick('fake.jpg', 'image/jpeg', 'not really');
    expect((await screen.findByRole('alert')).textContent).toMatch(/kein PDF|not a PDF/);
    first.unmount();

    fakeFetch(
      { status: 200, body: link('ready') },
      // R1 under `refuse`: no override hint, so it is said and nothing is asked.
      { status: 409, body: { ok: false, error: 'receipt_already_booked', holders: [{ fileId: 'f', entityKind: 'vendor_bill', entityId: 'b', reservedBy: null }], setting: 'files.duplicate_beleg' } },
    );
    const second = renderPage();
    await screen.findByText(/Datei wählen|Choose file/);
    pick('r.jpg', 'image/jpeg', 'jpeg');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Lieferantenrechnung|supplier invoice/);
    second.unmount();

    fakeFetch({ status: 200, body: link('ready') }, { status: 503, body: { ok: false, error: 'store_busy' } });
    renderPage();
    await screen.findByText(/Datei wählen|Choose file/);
    pick('r.jpg', 'image/jpeg', 'jpeg');
    expect((await screen.findByRole('alert')).textContent).toMatch(/nicht geklappt|did not work/);
    expect(screen.getByText(/Datei wählen|Choose file/)).toBeTruthy();
  });

  it('R1: a receipt already booked elsewhere asks for the reason, and the same drop is sent again with it', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const answers: Answer[] = [
      { status: 200, body: link('ready') },
      {
        status: 409,
        body: { ok: false, error: 'receipt_already_booked', holders: [{ fileId: 'f', entityKind: 'journal_entry', entityId: 'entry_9', reservedBy: null }], override: 'bookAgain with overrideReason' },
      },
      { status: 200, body: { ok: true, fileId: 'file_3', mime: 'image/jpeg', filename: 'r.jpg', duplicate: true, duplicateOf: 'f', holder: null, pending: false, target: TARGET } },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        const answer = answers.shift() as Answer;
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
      }),
    );
    renderPage();
    await screen.findByText(/Datei wählen|Choose file/);
    pick('r.jpg', 'image/jpeg', 'jpeg');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/Buchung|entry/);
    expect(dialog.textContent).toMatch(/entry_9/);
    // No reason, no second booking.
    fireEvent.click(screen.getByRole('button', { name: /Trotzdem buchen|Book anyway/ }));
    expect((await screen.findByText(/Gib einen Grund an|Enter a reason/)).textContent).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith('/redeem'))).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/^Grund$|^Reason$/), { target: { value: 'Zweite Position' } });
    fireEvent.click(screen.getByRole('button', { name: /Trotzdem buchen|Book anyway/ }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const second = calls.filter((c) => c.path.endsWith('/redeem'))[1];
    expect(second?.body).toMatchObject({ bookAgain: true, overrideReason: 'Zweite Position', filename: 'r.jpg' });
  });

  it('unpaired browser: says so and offers to open TILL or copy the link', async () => {
    fakeFetch({ status: 401, body: { ok: false, error: 'studio_key_required' } });
    renderPage();
    await screen.findByRole('button', { name: /In TILL öffnen|Open in TILL/ });
    expect(screen.getByRole('button', { name: /Link kopieren|Copy link/ })).toBeTruthy();
  });

  it('unknown, expired, used and denied links each say what happened and what to do', async () => {
    for (const [answer, pattern] of [
      [{ status: 404, body: { ok: false, error: 'drop_link_unknown' } }, /kennt TILL nicht|does not know this link/],
      [{ status: 200, body: link('expired') }, /abgelaufen|expired/],
      [{ status: 200, body: link('used') }, /schon benutzt|already used/],
      [{ status: 403, body: { ok: false, error: 'permission_denied' } }, /fehlt das Recht|do not have the right/],
      [{ status: 500, body: { ok: false, error: 'bridge_error' } }, /antwortet gerade nicht|not answering/],
    ] as const) {
      fakeFetch(answer);
      const view = renderPage();
      await screen.findByText(pattern);
      view.unmount();
    }
  });
});
