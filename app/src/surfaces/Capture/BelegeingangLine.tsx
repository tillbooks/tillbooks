/**
 * N02 (D183): the Belegeingang status line at the top of Belege ohne Buchung: the watched folder, when
 * it was last read, what stopped it (a missing folder, scanning off, a folder two clients share), the
 * files it could not take, and "Ordner ändern" (the Einstellungen on `/setup`, where a person changes
 * `files.belegeingang_folder`; an agent cannot, the setting is human-only).
 *
 * A quiet line, not a panel: the queue below is the surface. Status is text, never colour alone; a read
 * that fails renders nothing (the queue's own error state already speaks for the surface).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { useT, formatDate } from '../../i18n';

interface BelegeingangStatus {
  folder: string;
  state: string;
  lastScanAt: string | null;
  errors: { file: string; error: string }[];
}

/** The engine states that need a sentence (`ok` and `never_scanned` say it with the time alone). */
const STATES_WITH_TEXT = ['off', 'folder_missing', 'folder_invalid', 'folder_shared', 'no_actor', 'not_local'];

/** The scan moment in the person's own clock: `12.06.2026 14:02`. */
function timeOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${formatDate(day)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function BelegeingangLine({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const [status, setStatus] = useState<BelegeingangStatus | null>(null);

  useEffect(() => {
    let live = true;
    void client.call('belegeingang_status', { workspaceId }).then((res) => {
      if (!live || res.body.ok !== true) return;
      const body = res.body as unknown as BelegeingangStatus;
      setStatus({ folder: body.folder, state: body.state, lastScanAt: body.lastScanAt, errors: Array.isArray(body.errors) ? body.errors : [] });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  if (status === null) return null;
  const stateText = STATES_WITH_TEXT.includes(status.state) ? t(`belegeingang.state.${status.state}`) : '';
  return (
    <p className="capture__belegeingang" data-state={status.state}>
      <span>{t('belegeingang.folder', { folder: status.folder })}</span>
      <span>{status.lastScanAt === null ? t('belegeingang.never') : t('belegeingang.lastScan', { at: timeOf(status.lastScanAt) })}</span>
      {stateText !== '' ? <span>{stateText}</span> : null}
      {status.errors.length > 0 ? (
        <span>{t('belegeingang.errors', { count: status.errors.length, files: status.errors.map((e) => e.file).join(', ') })}</span>
      ) : null}
      <Link to="/setup">{t('belegeingang.change')}</Link>
    </p>
  );
}
