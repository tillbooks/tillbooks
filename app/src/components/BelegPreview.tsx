/**
 * A41.5: the Beleg preview, the one way the Studio SHOWS a stored receipt (a PDF or a photo) beside the
 * booking it evidences. Mounted in the bank line's review view, the Journal's entry drawer and the
 * Belegeingang's capture drawer.
 *
 * ZERO DEPENDENCIES (DESIGN.md "Dependencies"): no pdf.js. The bytes come from `files_get_content`, which
 * re-hashes them against the stored checksum and refuses (`integrity_mismatch`) rather than hand over a file
 * that changed; they become a blob URL that the BROWSER's own viewer renders: an `<iframe>` for a PDF, an
 * `<img>` for an image. The blob URL is revoked when the file changes and on unmount.
 *
 * States:
 *   - loading: a page-shaped skeleton (A4, 1 : 1.414), announced as a status;
 *   - error: the bytes could not be read or the re-hash failed: said in words, with "Herunterladen" (which
 *     asks the engine again, so a refused file is never saved either);
 *   - empty: no Beleg yet: the `FileDrop` zone when the host may attach one, else one quiet line;
 *   - a type the browser cannot show (a ZIP, an XML): the filename with "Herunterladen".
 *
 * THE FALLBACK. A narrow window and iOS / iPadOS WebKit (which draws only a PDF's first page inside an
 * iframe, as a picture, with no scrolling) get no inline PDF: a "Im neuen Tab öffnen" link and
 * "Herunterladen" instead. Every other state carries the same link under the page.
 */
import { useEffect, useId, useState } from 'react';

import { useClient } from '../lib/client-context';
import { isErr, type Err } from '../lib/client';
import { useT } from '../i18n';
import { FileDrop } from './FileDrop';
import { IconButton } from './IconButton';
import './BelegPreview.css';

export interface BelegPreviewFile {
  fileId: string;
  filename: string;
}

export interface BelegPreviewProps {
  workspaceId: string;
  /** The Belege to show, one at a time (a tab per file when there are several). Empty: the empty state. */
  files: readonly BelegPreviewFile[];
  /** The section's title ("Beleg", "Passender Beleg"). */
  title?: string;
  /** A quiet line under the title (why this Beleg is shown, e.g. "noch nicht angehängt"). */
  note?: string;
  /** Empty state: attach dropped or picked files. Absent or null: no drop zone (no right to attach). */
  onAttach?: ((files: File[]) => void) | null;
  /** Bound the page's height (a side panel), the page then scrolls inside the frame. */
  compact?: boolean;
}

/** A width under which no PDF is drawn inline (a phone, a squeezed panel): the new tab is the better view. */
export const INLINE_PDF_MIN_VIEWPORT = 640;

/**
 * iOS and iPadOS WebKit (every browser there is WebKit): an iframe shows only page 1 of a PDF, as an image.
 * iPadOS 13+ reports a desktop "Macintosh" agent, so touch points tell it from a Mac.
 */
export function isIosWebKit(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (nav === undefined) return false;
  const ua = nav.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

function narrowViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(`(max-width: ${INLINE_PDF_MIN_VIEWPORT - 1}px)`).matches;
}

type Shown = { kind: 'pdf' | 'image' | 'other'; url: string; mime: string; filename: string };
type State = { status: 'loading' } | { status: 'error'; error: Err } | { status: 'ready'; shown: Shown };

/**
 * THE ORIGIN TRAP (security review, 07.11.2026). A blob URL inherits the Studio's origin, so a scriptable file
 * (an HTML page, an SVG, any `text/*`) opened in an iframe or a new tab would run its script AS THE SIGNED-IN
 * PERSON, who may approve Vorschläge and book lines; and an agent can upload a file. So the blob's type is
 * NEVER the declared mime: it comes from this allowlist only, and only when the first bytes agree (a declared
 * PDF must start with `%PDF-`, an image with its format's signature). Everything else is
 * `application/octet-stream`, which no browser renders: the "other" state, download only, no frame, no link.
 * An `<img>` never runs script, whatever it holds. `image/svg+xml` and `text/*` are never on the list.
 */
const SAFE_IMAGE_TYPES: Readonly<Record<string, (b: Uint8Array) => boolean>> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/avif': (b) => ascii(b, 4, 8) === 'ftyp',
  'image/bmp': (b) => ascii(b, 0, 2) === 'BM',
};

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

/** What the bytes may be shown as, by the allowlist and the first bytes; the declared mime alone never decides. */
export function safeKindOf(mime: string, bytes: Uint8Array): { kind: Shown['kind']; type: string } {
  const declared = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (declared === 'application/pdf' && ascii(bytes, 0, 5) === '%PDF-') return { kind: 'pdf', type: 'application/pdf' };
  const sniff = SAFE_IMAGE_TYPES[declared];
  if (sniff !== undefined && sniff(bytes)) return { kind: 'image', type: declared === 'image/jpg' ? 'image/jpeg' : declared };
  return { kind: 'other', type: 'application/octet-stream' };
}

function bytesOf(contentBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Save a blob URL under its filename (revoked by the preview, never here). */
function saveAs(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** The engine's bytes of one file as a blob URL, with the states; the URL is revoked on change and unmount. */
function useFileUrl(workspaceId: string, fileId: string | null, attempt: number): State {
  const client = useClient();
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    if (fileId === null) return undefined;
    let live = true;
    let url: string | null = null;
    setState({ status: 'loading' });
    void client.call('files_get_content', { workspaceId, fileId }).then(
      ({ body }) => {
        if (!live) return;
        if (isErr(body)) {
          setState({ status: 'error', error: body });
          return;
        }
        const payload = body as unknown as { contentBase64?: unknown; mime?: unknown; filename?: unknown };
        if (typeof payload.contentBase64 !== 'string') {
          setState({ status: 'error', error: { ok: false, error: 'unreadable' } as Err });
          return;
        }
        const mime = typeof payload.mime === 'string' && payload.mime !== '' ? payload.mime : 'application/octet-stream';
        let safe: { kind: Shown['kind']; type: string };
        try {
          const bytes = bytesOf(payload.contentBase64);
          safe = safeKindOf(mime, bytes);
          url = URL.createObjectURL(new Blob([bytes], { type: safe.type }));
        } catch {
          setState({ status: 'error', error: { ok: false, error: 'unreadable' } as Err });
          return;
        }
        setState({ status: 'ready', shown: { kind: safe.kind, url, mime: safe.type, filename: typeof payload.filename === 'string' ? payload.filename : '' } });
      },
      () => {
        if (live) setState({ status: 'error', error: { ok: false, error: 'transport_error' } as Err });
      },
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [client, workspaceId, fileId, attempt]);
  return state;
}

/**
 * The preview of the Belege FILED on a record (`files_list_linked`, the OP3 pair): the Journal's entry drawer
 * mounts it above the record's Dateien panel. Nothing while the list reads, none is filed, or the seat may not
 * read a file's bytes; attaching stays the Dateien panel's (`reloadKey` re-reads after it attached).
 */
export function LinkedBelegPreview({ workspaceId, entityKind, entityId, canRead, reloadKey = 0, compact = true }: { workspaceId: string; entityKind: string; entityId: string; canRead: boolean; reloadKey?: number; compact?: boolean }) {
  const client = useClient();
  const [files, setFiles] = useState<{ key: string; files: BelegPreviewFile[] } | null>(null);
  const key = `${entityKind}:${entityId}:${reloadKey}`;
  useEffect(() => {
    if (!canRead) return undefined;
    let live = true;
    void client.call('files_list_linked', { workspaceId, entityKind, entityId }).then(({ body }) => {
      if (!live) return;
      const raw = isErr(body) ? [] : (body as unknown as { files?: unknown }).files;
      const list = Array.isArray(raw) ? raw : [];
      const parsed: BelegPreviewFile[] = [];
      for (const f of list as unknown[]) {
        const r = typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : null;
        if (r !== null && typeof r.id === 'string') parsed.push({ fileId: r.id, filename: typeof r.filename === 'string' ? r.filename : '' });
      }
      setFiles({ key, files: parsed });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, entityKind, entityId, canRead, key]);
  if (!canRead || files === null || files.key !== key || files.files.length === 0) return null;
  return <BelegPreview key={key} workspaceId={workspaceId} files={files.files} compact={compact} />;
}

export function BelegPreview({ workspaceId, files, title, note, onAttach = null, compact = false }: BelegPreviewProps) {
  const t = useT();
  const titleId = useId();
  const client = useClient();
  const [at, setAt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const file = files[Math.min(at, Math.max(files.length - 1, 0))] ?? null;
  const state = useFileUrl(workspaceId, file?.fileId ?? null, attempt);
  /** The error state's Herunterladen: the engine's bytes again; saved only when it hands them over. */
  const downloadDirect = async () => {
    if (file === null) return;
    setDownloading(true);
    setDownloadFailed(false);
    const { body } = await client.call('files_get_content', { workspaceId, fileId: file.fileId });
    setDownloading(false);
    const payload = body as unknown as { contentBase64?: unknown; mime?: unknown; filename?: unknown };
    if (isErr(body) || typeof payload.contentBase64 !== 'string') {
      setDownloadFailed(true);
      return;
    }
    // A download is never rendered: octet-stream, saved by the `download` attribute.
    const url = URL.createObjectURL(new Blob([bytesOf(payload.contentBase64)], { type: 'application/octet-stream' }));
    saveAs(url, typeof payload.filename === 'string' && payload.filename !== '' ? payload.filename : file.filename);
    // Revoked on the next tick: a synchronous revoke races the click in Safari (Files/model.ts).
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setAttempt((n) => n + 1);
  };
  const [inlinePdf] = useState(() => !narrowViewport() && !isIosWebKit());
  const heading = title ?? t('belegPreview.title');

  if (file === null) {
    return (
      <section className="beleg-preview beleg-preview--empty" aria-labelledby={titleId} data-state="empty">
        <h3 id={titleId} className="beleg-preview__title">
          {heading}
        </h3>
        {onAttach !== null ? (
          <FileDrop onFiles={onAttach} multiple accept="application/pdf,image/*" prompt={t('belegPreview.dropPrompt')} label={t('belegPreview.choose')} />
        ) : (
          <p className="beleg-preview__note">{t('belegPreview.none')}</p>
        )}
      </section>
    );
  }

  const name = (state.status === 'ready' && state.shown.filename !== '' ? state.shown.filename : file.filename) || t('belegPreview.unnamed');
  let page;
  if (state.status === 'loading') {
    page = (
      <div className="beleg-preview__skeleton" role="status" aria-busy="true">
        <span className="visually-hidden">{t('belegPreview.loading', { name })}</span>
        <i style={{ width: '40%' }} />
        <i style={{ width: '60%' }} />
        <i style={{ width: '50%' }} />
        <i style={{ width: '100%', marginTop: 24 }} />
        <i style={{ width: '100%' }} />
        <i style={{ width: '35%', justifySelf: 'end' }} />
      </div>
    );
  } else if (state.status === 'error') {
    const why = state.error.error === 'integrity_mismatch' ? t('belegPreview.error.integrity') : state.error.error === 'file_too_large_use_stream' ? t('belegPreview.error.tooLarge') : t('belegPreview.error.unreadable');
    page = (
      <div className="beleg-preview__state" role="alert" data-error={state.error.error}>
        <p className="beleg-preview__state-title">{t('belegPreview.error.title')}</p>
        <p className="beleg-preview__note">{why}</p>
        {/* Herunterladen asks the engine again: a file whose re-hash still fails is refused there too, never saved. */}
        <button type="button" className="btn btn--secondary btn--sm" disabled={downloading} onClick={() => void downloadDirect()}>
          {t('belegPreview.download')}
        </button>
        {downloadFailed && <p className="beleg-preview__note">{t('belegPreview.error.downloadRefused')}</p>}
      </div>
    );
  } else if (state.shown.kind === 'image') {
    page = <img className="beleg-preview__image" src={state.shown.url} alt={t('belegPreview.alt', { name })} />;
  } else if (state.shown.kind === 'pdf' && inlinePdf) {
    // No `sandbox`: Chromium's PDF viewer refuses to render inside a sandboxed iframe. The allowlist and the
    // `%PDF-` sniff above are the guard: this frame only ever holds a blob typed `application/pdf`.
    page = <iframe className="beleg-preview__frame" src={state.shown.url} title={t('belegPreview.alt', { name })} />;
  } else {
    page = (
      <div className="beleg-preview__state" data-fallback={state.shown.kind === 'pdf' ? 'pdf' : 'type'}>
        <p className="beleg-preview__state-title">{name}</p>
        <p className="beleg-preview__note">{state.shown.kind === 'pdf' ? t('belegPreview.fallbackPdf') : t('belegPreview.fallbackType')}</p>
      </div>
    );
  }

  const ready = state.status === 'ready' ? state.shown : null;
  return (
    <section className={compact ? 'beleg-preview beleg-preview--compact' : 'beleg-preview'} aria-labelledby={titleId} data-state={state.status}>
      <div className="beleg-preview__head">
        <h3 id={titleId} className="beleg-preview__title">
          {heading}
        </h3>
        {note !== undefined && note !== '' && <p className="beleg-preview__note">{note}</p>}
      </div>
      {files.length > 1 && (
        <div className="beleg-preview__tabs" role="group" aria-label={t('belegPreview.files')}>
          {files.map((f, i) => (
            <button key={f.fileId} type="button" className="btn btn--ghost btn--sm beleg-preview__tab" aria-pressed={f.fileId === file.fileId} onClick={() => setAt(i)}>
              {f.filename || t('belegPreview.unnamed')}
            </button>
          ))}
        </div>
      )}
      <div className="beleg-preview__page">{page}</div>
      <div className="beleg-preview__foot">
        <span className="beleg-preview__name" title={name}>
          {name}
        </span>
        {ready !== null && ready.kind !== 'other' && (
          <a className="beleg-preview__open" href={ready.url} target="_blank" rel="noopener">
            {t('belegPreview.openTab')}
          </a>
        )}
        {ready !== null && <IconButton icon="download" small context={name} onClick={() => saveAs(ready.url, name)} />}
      </div>
    </section>
  );
}
