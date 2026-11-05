/**
 * N04 (D183), the "Wiederholen" section of a Vorlage: Monat / Quartal / Jahr, the day (31 = the last day of
 * the month), ab, bis, Vorschlagen / Direkt buchen, the asked amounts keyed by leg index, and "Nächste
 * Ausführung". One live schedule per Vorlage series: saving replaces it, "Nicht mehr wiederholen" ends it.
 * "Direkt buchen" is a person's choice (the engine refuses it to an agent) and an edit of the Vorlage drops
 * it to proposing until it is set again, which the section says. Reads `vorlage_schedules`; writes
 * `set_vorlage_schedule` and `clear_vorlage_schedule`.
 */

import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { formatDate, useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import type { VorlageScheduleView, VorlageSchedulesOk } from '../../../../src/core/ledger/vorlageSchedule';

export interface VorlageScheduleSectionProps {
  workspaceId: string;
  vorlageId: string;
  /** The Vorlage's asked legs: index and label, in order. */
  asks: { index: number; label: string }[];
  canEdit: boolean;
  today: string;
}

const EVERY = ['month', 'quarter', 'year'] as const;

/** Rappen from a typed amount ("1250.50", "1'250.50"), or null. */
function minorOf(text: string): number | null {
  const clean = text.replace(/['\s]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export function VorlageScheduleSection({ workspaceId, vorlageId, asks, canEdit, today }: VorlageScheduleSectionProps) {
  const t = useT();
  const client = useClient();
  const [current, setCurrent] = useState<VorlageScheduleView | null | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const [every, setEvery] = useState<(typeof EVERY)[number]>('month');
  const [day, setDay] = useState('1');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState('');
  const [mode, setMode] = useState<'propose' | 'post'>('propose');
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  useEffect(() => {
    let live = true;
    void client.call('vorlage_schedules', { workspaceId, vorlageId }).then(({ body }) => {
      if (!live) return;
      if (isErr(body)) {
        setCurrent(null);
        return;
      }
      const active = (body as unknown as VorlageSchedulesOk).schedules.find((s) => s.status === 'active') ?? null;
      setCurrent(active);
      if (active !== null) {
        setEvery(active.every);
        setDay(String(active.anchorDay));
        setStart(active.start);
        setEnd(active.end ?? '');
        setMode(active.mode);
        setAmounts(Object.fromEntries(Object.entries(active.asks).map(([k, v]) => [Number(k), (v / 100).toFixed(2)])));
      }
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, vorlageId, nonce]);

  const save = async () => {
    const asked: Record<string, number> = {};
    for (const a of asks) {
      const v = minorOf(amounts[a.index] ?? '');
      if (v === null) {
        setError({ ok: false, error: 'invalid_input', field: `asks.${a.index}` } as Err);
        return;
      }
      asked[String(a.index)] = v;
    }
    setBusy(true);
    setError(null);
    const { body } = await client.call('set_vorlage_schedule', {
      workspaceId,
      vorlageId,
      every,
      anchorDay: Number(day),
      start,
      ...(end !== '' ? { end } : {}),
      mode,
      asks: asked,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setNonce((n) => n + 1);
  };

  const stop = async () => {
    if (current === null || current === undefined) return;
    setBusy(true);
    setError(null);
    const { body } = await client.call('clear_vorlage_schedule', { workspaceId, scheduleId: current.scheduleId, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setNonce((n) => n + 1);
  };

  return (
    <section className="bank-rules__schedule" aria-label={t('vorlage.schedule.title')}>
      <h4 className="bank-rules__schedule-title">{t('vorlage.schedule.title')}</h4>
      {current !== undefined && current !== null && (
        <p className="bank-rules__schedule-next t-num" data-state="active">
          {current.nextRun !== null ? t('vorlage.schedule.next', { date: formatDate(current.nextRun) }) : t('vorlage.schedule.noNext')}
          {current.mode === 'post' && current.effectiveMode === 'propose' ? ` ${t('vorlage.schedule.dropped')}` : ''}
        </p>
      )}
      {current === null && <p className="bank-rules__schedule-next">{t('vorlage.schedule.none')}</p>}
      {canEdit && (
        <div className="bank-rules__schedule-form">
          <label>
            {t('vorlage.schedule.every')}
            <select value={every} disabled={busy} onChange={(e) => setEvery(e.target.value as (typeof EVERY)[number])}>
              {EVERY.map((e) => (
                <option key={e} value={e}>
                  {t(`vorlage.schedule.every_${e}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('vorlage.schedule.day')}
            <input type="number" min={1} max={31} inputMode="numeric" className="t-num" value={day} disabled={busy} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label>
            {t('vorlage.schedule.start')}
            <input type="date" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            {t('vorlage.schedule.end')}
            <input type="date" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <fieldset className="bank-rules__schedule-mode">
            <legend>{t('vorlage.schedule.mode')}</legend>
            <label>
              <input type="radio" name={`mode-${vorlageId}`} checked={mode === 'propose'} disabled={busy} onChange={() => setMode('propose')} />
              {t('vorlage.schedule.propose')}
            </label>
            <label>
              <input type="radio" name={`mode-${vorlageId}`} checked={mode === 'post'} disabled={busy} onChange={() => setMode('post')} />
              {t('vorlage.schedule.post')}
            </label>
          </fieldset>
          {asks.map((a) => (
            <label key={a.index}>
              {a.label}
              <input type="text" inputMode="decimal" className="t-num" value={amounts[a.index] ?? ''} disabled={busy} onChange={(e) => setAmounts((m) => ({ ...m, [a.index]: e.target.value }))} />
            </label>
          ))}
          <div className="bank-rules__schedule-acts">
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void save()}>
              {t('vorlage.schedule.save')}
            </button>
            {current !== null && current !== undefined && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void stop()}>
                {t('vorlage.schedule.stop')}
              </button>
            )}
          </div>
        </div>
      )}
      {error !== null && <ErrorBanner error={error} />}
    </section>
  );
}
