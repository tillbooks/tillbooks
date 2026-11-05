/**
 * N02 (D183, critic round 2): the Belege a Vorschlag will link, on its card. The decider sees an image as
 * a thumbnail and opens any Beleg; a seat that may not decide sees the names only and reads no bytes; a
 * dropped receipt says so. The engine is faked at the transport (`files_pending_preview`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { VorschlagBelege } from './VorschlagBelege';
import { parseBelege, type VorschlagBeleg } from './model';

const JPEG_B64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0) + 'synthetic');
const PDF_B64 = btoa('%PDF-1.4 synthetic');

const BELEGE: VorschlagBeleg[] = [
  { fileId: 'file_1', filename: 'quittung.jpg', mime: 'image/jpeg', bytes: 13, sha256: 'a', source: 'draft', pending: true },
  { fileId: 'file_2', filename: 'lieferschein.pdf', mime: 'application/pdf', bytes: 18, sha256: 'b', source: 'drop', pending: true },
];

/** What the engine sniffed per file (the ONLY type the card may act on). */
const SNIFFED: Record<string, { content: string; sniffed: string }> = {
  file_1: { content: JPEG_B64, sniffed: 'image/jpeg' },
  file_2: { content: PDF_B64, sniffed: 'application/pdf' },
  // Stored as "image/jpeg", but its bytes are HTML: never a thumbnail, never a tab.
  file_3: { content: btoa('<html><script>alert(1)</script></html>'), sniffed: 'application/octet-stream' },
};

function renderStrip(canPreview: boolean, seen: { action: string; input: Record<string, unknown> }[], belege: VorschlagBeleg[] = BELEGE) {
  const transport: Transport = async (action, input) => {
    seen.push({ action, input: input as Record<string, unknown> });
    if (action !== 'files_pending_preview') return { status: 404, body: { ok: false, error: 'unknown_action' } };
    const answer = SNIFFED[(input as { fileId: string }).fileId];
    return { status: 200, body: { ok: true, actionId: 'act_1', contentBase64: answer?.content, sniffedMime: answer?.sniffed } };
  };
  return render(
    <I18nProvider>
      <TillClientProvider client={new TillClient(transport)}>
        <WorkspaceProvider initialId="ws_test">
          <VorschlagBelege actionId="act_1" belege={belege} canPreview={canPreview} />
        </WorkspaceProvider>
      </TillClientProvider>
    </I18nProvider>,
  );
}

describe('VorschlagBelege (N02 critic round 2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the decider sees the image as a thumbnail, every Beleg named, the dropped one marked, and opens a PDF', async () => {
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:pdf', revokeObjectURL: () => {} }));
    renderStrip(true, seen);
    const thumb = await screen.findByRole('img');
    expect(thumb.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
    expect(screen.getByText(/quittung\.jpg/)).toBeTruthy();
    expect(screen.getByText(/lieferschein\.pdf/)).toBeTruthy();
    expect(screen.getByText(/Ablage-Link|dropped through a link/)).toBeTruthy();
    expect(seen[0]).toEqual({ action: 'files_pending_preview', input: { workspaceId: 'ws_test', actionId: 'act_1', fileId: 'file_1' } });
    const buttons = screen.getAllByRole('button', { name: /Öffnen|Open/ });
    await userEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(opened).toHaveBeenCalledWith('blob:pdf', '_blank', 'noopener'));
  });

  it('the stored mime decides nothing: bytes that are not a receipt never draw or open in a tab, they download as octet-stream', async () => {
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.push(b), 'blob:x'), revokeObjectURL: () => {} }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderStrip(true, seen, [{ fileId: 'file_3', filename: 'beleg.jpg', mime: 'image/jpeg', bytes: 40, sha256: 'c', source: 'draft', pending: true }]);
    await waitFor(() => expect(seen.length).toBe(1));
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Öffnen|Open/ }));
    await waitFor(() => expect(clicked).toHaveBeenCalled());
    expect(opened).not.toHaveBeenCalled();
    expect(blobs.at(-1)?.type).toBe('application/octet-stream');
    clicked.mockRestore();
  });

  it('a seat that may not decide sees the names only and no bytes are read', async () => {
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    renderStrip(false, seen);
    expect(await screen.findByText(/quittung\.jpg/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('parseBelege keeps only rows the card can read', () => {
    expect(parseBelege([{ fileId: 'f', filename: 'a.pdf', mime: 'application/pdf', bytes: 1, sha256: 's', source: 'drop', pending: true }, { fileId: 3 }, null])).toEqual([
      { fileId: 'f', filename: 'a.pdf', mime: 'application/pdf', bytes: 1, sha256: 's', source: 'drop', pending: true },
    ]);
    expect(parseBelege(undefined)).toEqual([]);
  });
});
