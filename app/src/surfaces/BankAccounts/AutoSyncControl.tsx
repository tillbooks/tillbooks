/**
 * D142 (A36 §12): the daily automatic fetch of one EBICS connection, on the channel card. A checkbox
 * ("Täglich automatisch abrufen") and a Swiss time (default 07:00), saved together through
 * `set_bank_sync_schedule` with a fresh idempotency key per save. Under `till up` the scheduler then
 * fetches once a day at that time and catches up at start; the card says when the next run is and what
 * the last automatic run did. Changing it is a `pay` right, the verb's own gate: without it the controls
 * are disabled and the reason is said in words.
 *
 * At rest the card shows ONE summary line ("Automatisch täglich um 07:00 · nächster Abruf ...") and an
 * "Ändern" toggle; the editor opens on demand and closes after a save. A failed last run and the
 * missing right stay visible at rest, because they need the person.
 */
import { useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatDate } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { channelRefusal } from './channelWording';

/** The modes the engine admits (`AUTO_SYNC_MODES` in `core/banking/ebics/autoSync.ts`). */
export const AUTO_SYNC_MODES = ['daily', 'off'] as const;
export type AutoSyncMode = (typeof AUTO_SYNC_MODES)[number];

export interface AutoSyncDto {
  mode: AutoSyncMode;
  atTime: string;
  explicit: boolean;
  nextAt: string | null;
  lastAuto: { finishedAt: string; ok: boolean; code: string; retryable: boolean } | null;
  /** D142 critic R3-2: false when nobody set the schedule, so only the owner seat was tried. */
  setterKnown?: boolean;
  /** D143 critic LB-1: who set the schedule (none, owner, agent, person); it words `auto_sync_no_actor`. */
  scheduleSetter?: 'none' | 'owner' | 'agent' | 'person';
}

export interface AutoSyncControlProps {
  workspaceId: string;
  connectionId: string;
  autoSync: AutoSyncDto | undefined;
  canPay: boolean;
  onSaved: () => void;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "25.09.2026 07:02" in Swiss time, for the card's two facts. */
function stamp(instant: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
  const time = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
  return `${formatDate(day)} ${time}`;
}

export function AutoSyncControl({ workspaceId, connectionId, autoSync, canPay, onSaved }: AutoSyncControlProps) {
  const t = useT();
  const client = useClient();
  const id = useId();
  const [daily, setDaily] = useState((autoSync?.mode ?? 'daily') === 'daily');
  const [atTime, setAtTime] = useState(autoSync?.atTime ?? '07:00');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDaily((autoSync?.mode ?? 'daily') === 'daily');
    setAtTime(autoSync?.atTime ?? '07:00');
  }, [autoSync?.mode, autoSync?.atTime]);

  const dirty = daily !== ((autoSync?.mode ?? 'daily') === 'daily') || atTime !== (autoSync?.atTime ?? '07:00');
  const valid = HHMM.test(atTime);

  const save = async () => {
    setSaving(true);
    setError(null);
    const { body } = await client.call('set_bank_sync_schedule', {
      workspaceId,
      connectionId,
      mode: daily ? 'daily' : 'off',
      atTime,
      idempotencyKey: `d141-schedule-${connectionId}-${Date.now()}`,
    });
    setSaving(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setEditing(false);
    onSaved();
  };

  const last = autoSync?.lastAuto ?? null;
  const nextAt = autoSync?.mode === 'daily' ? autoSync.nextAt : null;
  // The engine answers `nextAt = now` when a run is due (a missed time, caught up on the next tick),
  // so a bare "14:57" beside "um 07:00" reads as a contradiction. Within a minute of now it is "due".
  const dueNow = nextAt !== null && Date.parse(nextAt) <= Date.now() + 60_000;
  const summary =
    (autoSync?.mode ?? 'daily') === 'daily'
      ? [
          t('channel.auto.summaryDaily', { time: autoSync?.atTime ?? '07:00' }),
          ...(nextAt === null ? [] : [dueNow ? t('channel.auto.dueNow') : t('channel.auto.summaryNext', { when: stamp(nextAt) })]),
        ].join(' · ')
      : t('channel.auto.summaryOff');
  return (
    <div className="bank-channel-auto" role="group" aria-label={t('channel.auto.title')}>
      <p className="bank-channel-auto-summary">
        <span>{summary}</span>
        {canPay && (
          <>
            {' · '}
            <button type="button" className="bank-channel-link" aria-expanded={editing} aria-controls={`${id}-editor`} onClick={() => setEditing((v) => !v)}>
              {editing ? t('channel.auto.done') : t('channel.auto.change')}
            </button>
          </>
        )}
      </p>
      {editing && (
        <div id={`${id}-editor`} className="bank-channel-auto-editor">
          <div className="bank-channel-auto-row">
            <label className="bank-channel-auto-toggle">
              <input type="checkbox" checked={daily} disabled={saving} onChange={(e) => setDaily(e.target.checked)} />
              {t('channel.auto.daily')}
            </label>
            <label className="bank-channel-auto-time" htmlFor={`${id}-time`}>
              {t('channel.auto.time')}
              <input
                id={`${id}-time`}
                type="time"
                step={60}
                className="field"
                value={atTime}
                disabled={saving || !daily}
                aria-invalid={!valid}
                onChange={(e) => setAtTime(e.target.value)}
              />
            </label>
            <button type="button" className="btn btn--secondary btn--sm" disabled={saving || !dirty || !valid} onClick={() => void save()}>
              {saving ? t('channel.auto.saving') : t('channel.auto.save')}
            </button>
          </div>
          <p className="bank-channel-note">{t('channel.auto.upOnly')}</p>
          {last !== null && last.ok && <p className="bank-channel-note">{t('channel.auto.lastOk', { when: stamp(last.finishedAt) })}</p>}
        </div>
      )}
      {!canPay && <p className="bank-channel-note">{t('channel.auto.denied')}</p>}
      {last !== null && !last.ok && (
        <p className="bank-channel-note">
          {t('channel.auto.lastFailed', { when: stamp(last.finishedAt), reason: channelRefusal(t, { ok: false, error: last.code, setterKnown: autoSync?.setterKnown, scheduleSetter: autoSync?.scheduleSetter } as Err) })}
        </p>
      )}
      {error !== null && <ErrorBanner error={error} message={channelRefusal(t, error)} />}
    </div>
  );
}
