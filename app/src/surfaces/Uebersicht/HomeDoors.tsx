/**
 * F-05 (friction ledger, Phase 2): the daily doors on the home.
 *
 * THE DEFECT. The verbs a person reaches for every day sat behind the collapsed rail groups: the
 * journal composer behind Buchhaltung, the backup three interactions deep (Einstellungen > Betrieb >
 * Daten & Sicherung), and the demo twelve rows down the Einstellungen group. J7.1 measured S 3 and
 * C 6 against an ideal of one screen and two acts; every J3 row paid the home toll. The rail stays
 * default-collapsed (D118 A1); the fix is real doors ON THE HOME, not an expanded rail.
 *
 * WHAT THIS IS. Ordinary header actions on the Übersicht, in the SurfaceHeader's action slot where
 * the design law puts a surface's actions: ONE primary (Buchen, the accent, because a booking is
 * what the books are for), Sichern as its secondary neighbour, and, only while the workspace is
 * still empty, a quiet third door into the demo. Not a second rail: three controls, no grouping
 * chrome, and the demo door disappears on its own once a real figure exists.
 *
 *   - Buchen opens the journal composer directly (`/journal?new=1`), one act from the home.
 *   - Sichern opens Betrieb at the Daten & Sicherung panel (`/operations#data-title`; the shell
 *     scrolls a hash target into view after the route change).
 *   - Demo ausprobieren mints the demo workspace with the same verb the Erste Schritte door uses
 *     (`create_demo_workspace`) and adopts it in place; the shared demo banner then says so above
 *     every surface. It shows only while the workspace has no data, so a demo never offers a demo.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspace } from '../../app/workspace';
import { useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import './HomeDoors.css';

/** A fresh idempotency key per demo mint, so a retry after a transport failure is a retry. */
function newKey(): string {
  return `demo-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Date.now()}`;
}

export function HomeDoors({ fresh }: { fresh: boolean }) {
  const t = useT();
  const client = useClient();
  const { setWorkspaceId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  async function startDemo(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = (await client.call('create_demo_workspace', { idempotencyKey: newKey() })).body;
    setBusy(false);
    if (isErr(res)) {
      setError(res);
      return;
    }
    const id = (res as { workspaceId?: unknown }).workspaceId;
    if (typeof id === 'string') setWorkspaceId(id);
  }

  return (
    <div className="home-doors" role="group" aria-label={t('dashboard.doors.label')}>
      {fresh && (
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void startDemo()}>
          {busy ? t('dashboard.doors.demoBusy') : t('dashboard.doors.demo')}
        </button>
      )}
      <Link to="/operations#data-title" className="btn btn--secondary">
        {t('dashboard.doors.backup')}
      </Link>
      <Link to="/journal?new=1" className="btn btn--primary">
        {t('dashboard.doors.book')}
      </Link>
      {error !== null && (
        <div className="home-doors-error">
          <ErrorBanner error={error} onRetry={() => void startDemo()} />
        </div>
      )}
    </div>
  );
}

export default HomeDoors;
