/**
 * A41.5: the Beleg preview. The bytes come from `files_get_content` and the browser's own viewer draws them
 * from a blob URL (revoked on change and unmount); a refused re-hash is said in words with Herunterladen; no
 * Beleg is the drop zone; iOS WebKit and a narrow window get the new tab instead of an inline PDF.
 * SYNTHETIC DATA ONLY: invented file ids, names and bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { I18nProvider } from '../i18n';
import { BelegPreview, isIosWebKit, safeKindOf } from './BelegPreview';

const PDF_BASE64 = btoa('%PDF-1.4 synthetic');
/** The PNG signature and a few invented bytes. */
const PNG_BASE64 = btoa('\x89PNG\r\n\x1a\nsynthetic');
const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function recording(handler: (input: Record<string, unknown>) => RestResponse) {
  const calls: Record<string, unknown>[] = [];
  const transport: Transport = async (action, input) => {
    if (action !== 'files_get_content') return { status: 404, body: { ok: false, error: 'unknown_action' } };
    calls.push(input);
    return handler(input);
  };
  return { transport, calls };
}

function show(transport: Transport, ui: Parameters<typeof BelegPreview>[0]) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <BelegPreview {...ui} />
      </I18nProvider>
    </TillClientProvider>,
  );
}

let created: string[] = [];
let revoked: string[] = [];
beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => {
      n += 1;
      created.push(`blob:test/${n}`);
      return `blob:test/${n}`;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn((u: string) => revoked.push(u)) });
});
afterEach(() => vi.restoreAllMocks());

describe('A41.5: BelegPreview', () => {
  it('loads the bytes, shows a PDF in the browser\'s own viewer, and revokes the blob URL on unmount', async () => {
    const { transport, calls } = recording(() => ok({ contentBase64: PDF_BASE64, mime: 'application/pdf', filename: 'rechnung-oktober.pdf' }));
    let requests = 0;
    const counted: Transport = (action, input) => {
      requests += 1;
      return transport(action, input);
    };
    const { unmount } = show(counted, { workspaceId: 'ws_1', files: [{ fileId: 'file_1', filename: 'rechnung-oktober.pdf' }] });
    // Loading: a page-shaped skeleton, announced, while the one read is in flight.
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(requests).toBe(1);
    const frame = await screen.findByTitle('Beleg rechnung-oktober.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'blob:test/1');
    expect(calls).toEqual([{ workspaceId: 'ws_1', fileId: 'file_1' }]);
    expect(screen.getByRole('link', { name: 'Im neuen Tab öffnen' })).toHaveAttribute('href', 'blob:test/1');
    expect(screen.getByRole('button', { name: 'Herunterladen' })).toBeInTheDocument();
    unmount();
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('an image is an <img>; several files are one tab each, and switching revokes the previous URL', async () => {
    const { transport } = recording((input) =>
      input.fileId === 'file_a' ? ok({ contentBase64: PNG_BASE64, mime: 'image/png', filename: 'quittung.png' }) : ok({ contentBase64: PDF_BASE64, mime: 'application/pdf', filename: 'rechnung.pdf' }),
    );
    show(transport, { workspaceId: 'ws_1', files: [{ fileId: 'file_a', filename: 'quittung.png' }, { fileId: 'file_b', filename: 'rechnung.pdf' }] });
    expect((await screen.findByRole('img', { name: 'Beleg quittung.png' })).tagName).toBe('IMG');
    await userEvent.click(within(screen.getByRole('group', { name: 'Belege dieser Buchung' })).getByRole('button', { name: 'rechnung.pdf' }));
    await screen.findByTitle('Beleg rechnung.pdf');
    expect(revoked).toContain('blob:test/1');
  });

  it('a failed re-hash is said in words and offers Herunterladen, which asks the engine again and saves nothing it refuses', async () => {
    const { transport, calls } = recording(() => ({ status: 409, body: { ok: false, error: 'integrity_mismatch' } }));
    show(transport, { workspaceId: 'ws_1', files: [{ fileId: 'file_1', filename: 'kaputt.pdf' }] });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Der Beleg lässt sich nicht anzeigen');
    expect(alert).toHaveTextContent('Prüfsumme');
    await userEvent.click(within(alert).getByRole('button', { name: 'Herunterladen' }));
    await waitFor(() => expect(alert).toHaveTextContent('Auch der Download wurde verweigert.'));
    expect(calls).toHaveLength(2);
    expect(created).toEqual([]);
    expect(screen.queryByRole('link', { name: 'Im neuen Tab öffnen' })).toBeNull();
  });

  it('no Beleg: the drop zone when the host may attach, one quiet line when it may not; nothing is fetched', () => {
    const { transport, calls } = recording(() => ok({}));
    const attached: File[][] = [];
    const { unmount } = show(transport, { workspaceId: 'ws_1', files: [], onAttach: (f) => attached.push(f) });
    expect(screen.getByLabelText('Beleg wählen')).toBeInTheDocument();
    unmount();
    show(transport, { workspaceId: 'ws_1', files: [] });
    expect(screen.getByText('Noch kein Beleg.')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  // Security review (07.11.2026): a blob URL inherits the Studio's origin, so a scriptable file must never be
  // framed or opened in a tab: its script would run as the signed-in person.
  it('an HTML file and an SVG file get no frame, no image and no open link: download only, as octet-stream', async () => {
    const types: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        types.push(blob.type);
        return `blob:test/${types.length}`;
      },
    });
    for (const [mime, bytes, filename] of [
      ['text/html', '<script>parent.approve()</script>', 'beleg.html'],
      ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>go()</script></svg>', 'beleg.svg'],
    ] as const) {
      const { transport } = recording(() => ok({ contentBase64: btoa(bytes), mime, filename }));
      const { container, unmount } = show(transport, { workspaceId: 'ws_1', files: [{ fileId: 'file_x', filename }] });
      await screen.findByText('Für diesen Dateityp gibt es keine Vorschau.');
      expect(container.querySelector('iframe, img, object, embed')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Im neuen Tab öffnen' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Herunterladen' })).toBeInTheDocument();
      unmount();
    }
    expect(types).toEqual(['application/octet-stream', 'application/octet-stream']);
  });

  it('a declared PDF whose bytes are not a PDF falls back, and only allowlisted, sniffed types render', async () => {
    const { transport } = recording(() => ok({ contentBase64: btoa('<html><script>x()</script></html>'), mime: 'application/pdf', filename: 'tarnung.pdf' }));
    const { container } = show(transport, { workspaceId: 'ws_1', files: [{ fileId: 'file_x', filename: 'tarnung.pdf' }] });
    await screen.findByText('Für diesen Dateityp gibt es keine Vorschau.');
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Im neuen Tab öffnen' })).toBeNull();
    const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect(safeKindOf('application/pdf', bytes('%PDF-1.7'))).toEqual({ kind: 'pdf', type: 'application/pdf' });
    expect(safeKindOf('image/png', bytes('\x89PNG\r\n'))).toEqual({ kind: 'image', type: 'image/png' });
    expect(safeKindOf('image/png', bytes('<svg>'))).toEqual({ kind: 'other', type: 'application/octet-stream' });
    expect(safeKindOf('image/svg+xml', bytes('<svg>'))).toEqual({ kind: 'other', type: 'application/octet-stream' });
    expect(safeKindOf('text/html', bytes('%PDF-1.7'))).toEqual({ kind: 'other', type: 'application/octet-stream' });
    expect(safeKindOf('application/pdf; charset=utf-8', bytes('%PDF-1.7')).kind).toBe('pdf');
  });

  it('iOS and iPadOS WebKit are told from a Mac by touch points (they draw only a PDF\'s first page inline)', () => {
    expect(isIosWebKit({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebKit({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebKit({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 0 })).toBe(false);
  });

  it('on iOS WebKit the PDF is not drawn inline: the new tab and Herunterladen instead', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    const { transport } = recording(() => ok({ contentBase64: PDF_BASE64, mime: 'application/pdf', filename: 'rechnung.pdf' }));
    show(transport, { workspaceId: 'ws_1', files: [{ fileId: 'file_1', filename: 'rechnung.pdf' }] });
    await screen.findByRole('link', { name: 'Im neuen Tab öffnen' });
    expect(screen.queryByTitle('Beleg rechnung.pdf')).toBeNull();
    expect(screen.getByText(/nur die erste Seite/)).toBeInTheDocument();
  });
});
