/**
 * N02 (D183, critic round 2): the Belege a Vorschlag will link, on its card, so a person never approves a
 * ten-year retention lock blind. Shown in Pendenzen and under Agent > Vorschläge alike (both render
 * `VorschlagLine`), before the approve control is reached.
 *
 * Every Beleg is a chip with its kind and file name; a receipt a person dropped through a link says so.
 * For a seat that may decide (the engine's `files_pending_preview` needs `manage_agent_dial` and
 * `read_file_content`), an image shows as a thumbnail and every Beleg opens in a new tab ("Öffnen"); a
 * seat that may not decide sees the chips only. The names come from the list read; the bytes only from
 * the preview verb.
 *
 * NEVER THE STORED MIME (security review). What a Beleg may become in the browser is decided by the type
 * the engine SNIFFED from its bytes (`sniffedMime`), never by the free-text mime stored with it: only a
 * PDF or a JPEG, PNG or WebP image opens in a tab or draws as a thumbnail; anything else (HEIC, or a file
 * that is not a receipt at all) only downloads, as `application/octet-stream` through an `<a download>`,
 * so no HTML or SVG can ever render in the Studio's origin.
 */
import { useCallback, useEffect, useState } from 'react';

import { useT } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import type { VorschlagBeleg } from './model';
import { downloadContent } from '../Files/model';
import './VorschlagBelege.css';

/** The SNIFFED types drawn as a thumbnail (HEIC has no browser rendering). */
const THUMB_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** The SNIFFED types that may open in a tab. Everything else downloads as octet-stream. */
export const TAB_TYPES = ['application/pdf', ...THUMB_TYPES];

/** One preview answer: the bytes and the type the engine sniffed from them. */
interface Preview {
  content: string;
  sniffed: string;
}

function kindKey(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'file';
}

export function VorschlagBelege({ actionId, belege, canPreview }: { actionId: string; belege: readonly VorschlagBeleg[]; canPreview: boolean }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({});
  const [failed, setFailed] = useState<string | null>(null);

  const read = useCallback(
    async (fileId: string): Promise<Preview | null> => {
      if (workspaceId === null) return null;
      const res = await client.call('files_pending_preview', { workspaceId, actionId, fileId });
      if (isErr(res.body)) return null;
      const body = res.body as { contentBase64?: unknown; sniffedMime?: unknown };
      if (typeof body.contentBase64 !== 'string') return null;
      return { content: body.contentBase64, sniffed: typeof body.sniffedMime === 'string' ? body.sniffedMime : 'application/octet-stream' };
    },
    [actionId, client, workspaceId],
  );

  const imageIds = belege.filter((b) => THUMB_TYPES.includes(b.mime)).map((b) => b.fileId).join(',');
  useEffect(() => {
    if (!canPreview || imageIds === '') return;
    let live = true;
    void (async () => {
      for (const b of belege) {
        if (!THUMB_TYPES.includes(b.mime)) continue;
        const preview = await read(b.fileId);
        // The stored mime only chose WHICH to fetch; the thumbnail is drawn only for a sniffed image.
        if (!live || preview === null || !THUMB_TYPES.includes(preview.sniffed)) continue;
        setThumbs((current) => ({ ...current, [b.fileId]: `data:${preview.sniffed};base64,${preview.content}` }));
      }
    })();
    return () => {
      live = false;
    };
  }, [canPreview, imageIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(
    async (b: VorschlagBeleg) => {
      setFailed(null);
      const preview = await read(b.fileId);
      if (preview === null) {
        setFailed(b.fileId);
        return;
      }
      if (!TAB_TYPES.includes(preview.sniffed)) {
        downloadContent({ contentBase64: preview.content, mime: 'application/octet-stream', filename: b.filename });
        return;
      }
      const bytes = Uint8Array.from(atob(preview.content), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: preview.sniffed }));
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    [read],
  );

  if (belege.length === 0) return null;
  return (
    <div className="vorschlag-belege">
      <p className="vorschlag-belege-head">{t('agent.belege.head', { count: belege.length })}</p>
      <ul className="vorschlag-belege-list">
        {belege.map((b) => (
          <li key={b.fileId} className="vorschlag-beleg">
            {thumbs[b.fileId] !== undefined ? (
              <img className="vorschlag-beleg-thumb" src={thumbs[b.fileId]} alt={t('agent.belege.thumbAlt', { name: b.filename })} />
            ) : null}
            <span className="vorschlag-beleg-name">
              {t(`agent.belege.kind.${kindKey(b.mime)}`)}: {b.filename}
            </span>
            {b.source === 'drop' ? <span className="vorschlag-beleg-note">{t('agent.belege.dropped')}</span> : null}
            {canPreview ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void open(b)}>
                {t('agent.belege.open')}
              </button>
            ) : null}
            {failed === b.fileId ? (
              <span className="vorschlag-beleg-note" role="alert">
                {t('agent.belege.failed')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
