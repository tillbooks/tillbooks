/**
 * M00, the runtime line (spec §6, surface 2): mode + scheduler + last tick, read from
 * `delivery_status`.
 *
 * It is PRE-WORKSPACE by design (it describes the process, not a tenant), so unlike the Vertrauen
 * panel it renders even before a ledger exists, which is exactly when the first-run flow shows it. In
 * `agent_session` mode it renders the residency caveat as TEXT (never a tooltip, per §6 accessibility:
 * a caveat a screen reader can miss is not a caveat). Every state is glyph + text, never colour alone.
 *
 * The mode string is whatever the engine returns; this component does NOT keep its own copy of the
 * mode enum (that would be a mirror the §H-ENUM guard would have to police). An unknown mode falls
 * back to showing the raw string, which is honest rather than blank.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { ChevronRightGlyph } from '../../components/icons';

interface Scheduler {
  enabled: boolean;
  lastTickAt: string | null;
  nextTickAt: string | null;
}

interface DeliveryStatus {
  mode: string;
  version: string;
  host: string | null;
  port: number | null;
  studioServed: boolean;
  scheduler: Scheduler;
}

/** The four known modes, for choosing a localised label. Not a mirror of the engine enum: a plain
 *  lookup table of copy, with a raw-string fallback for anything it does not recognise. */
const MODE_KEYS: Record<string, string> = {
  up: 'runtime.mode.up',
  mcp: 'runtime.mode.mcp',
  serve: 'runtime.mode.serve',
  agent_session: 'runtime.mode.agent_session',
};

export function RuntimeLine() {
  const t = useT();
  const client = useClient();
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await client.call('delivery_status');
      if (!live) return;
      if (isErr(response.body)) {
        setFailed(true);
        return;
      }
      setStatus(response.body as unknown as DeliveryStatus);
    })();
    return () => {
      live = false;
    };
  }, [client]);

  if (failed) return null; // an unreadable process line is simply not shown, never a wrong one
  if (status === null) {
    return (
      <p className="runtime-line runtime-line--loading" role="status">
        {t('runtime.loading')}
      </p>
    );
  }

  const modeKey = MODE_KEYS[status.mode];
  const modeLabel = modeKey === undefined ? status.mode : t(modeKey);
  const scheduler = status.scheduler.enabled
    ? status.scheduler.lastTickAt === null
      ? t('runtime.scheduler.armed')
      : t('runtime.scheduler.last_tick', { at: formatTick(status.scheduler.lastTickAt) })
    : t('runtime.scheduler.off');

  return (
    <div className="runtime-line" role="status">
      <p className="runtime-line-mode">
        <ChevronRightGlyph className="runtime-line-glyph" size={14} />
        {t('runtime.mode.label', { mode: modeLabel })}
      </p>
      <p className="runtime-line-scheduler">{scheduler}</p>
      {status.mode === 'agent_session' && (
        <p className="runtime-line-caveat">{t('runtime.residency.caveat')}</p>
      )}
    </div>
  );
}

/** Render an ISO instant as `TT.MM.JJJJ HH:MM` (house style; identical digits in both locales). */
function formatTick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
