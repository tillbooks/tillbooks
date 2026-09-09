/**
 * F00's "Wartet auf dich" strip (D90 D-2): the dashboard's top row names the waiting work without
 * becoming the work queue. It is F00's own composition pattern applied to G15's verb, so F00 stays an
 * amendment rather than a no-op: it OWNS the strip, G15 owns the verb behind it (`attention_summary`).
 *
 * It carries its OWN loading, empty, denied and failed states, and never shows a fake zero: a denied
 * actor (`visibleQueues == 0`, `total: null`) renders nothing here (the padlock lives on the hub), a
 * failed read is a muted line with a retry, an all-clear (`total: 0`) is a quiet line, and pending work
 * is a link into `/attention`. Counts now appear in a fourth place (rail, hub, dashboard, module); the
 * strip is the dashboard one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import './AttentionStrip.css';

type StripState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; total: number | null; leadTitleKey: string | null; leadTitleParams: Record<string, string | number> };

interface LeadItem {
  titleKey: string;
  titleParams: Record<string, string | number>;
}

function parseLead(body: unknown): LeadItem | null {
  const top = (body as { top?: unknown }).top;
  if (!Array.isArray(top) || top.length === 0) return null;
  const first = top[0] as Record<string, unknown>;
  if (typeof first.titleKey !== 'string') return null;
  return { titleKey: first.titleKey, titleParams: (first.titleParams ?? {}) as Record<string, string | number> };
}

export function AttentionStrip() {
  const t = useT();
  const client = useClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceId();
  const [state, setState] = useState<StripState>({ status: 'loading' });
  const active = useRef<string | null>(workspaceId);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    active.current = workspaceId;
    setState({ status: 'loading' });
    const res = await client.call('attention_summary', { workspaceId, topLimit: 1 });
    if (active.current !== workspaceId) return;
    if (isErr(res.body)) {
      setState({ status: 'error' });
      return;
    }
    const total = (res.body as { total?: unknown }).total;
    const lead = parseLead(res.body);
    setState({
      status: 'ok',
      total: typeof total === 'number' ? total : null,
      leadTitleKey: lead?.titleKey ?? null,
      leadTitleParams: lead?.titleParams ?? {},
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (workspaceId === null) return null;
  if (state.status === 'loading') {
    // Deliberately NOT `role="status"`: the dashboard's own skeleton owns that live region, and a
    // second one would make "the tile wall is loading" ambiguous. The strip is a quiet supplementary
    // line; its loading text carries the meaning.
    return <div className="att-strip att-strip--muted">{t('dashboard.attentionStrip.loading')}</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="att-strip att-strip--muted">
        {t('dashboard.attentionStrip.error')}{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
          {t('dashboard.attentionStrip.retry')}
        </button>
      </div>
    );
  }
  // A denied actor is told nothing here (the hub's padlock is where that is explained).
  if (state.total === null) return null;
  if (state.total === 0) {
    return <div className="att-strip att-strip--muted">{t('dashboard.attentionStrip.allClear')}</div>;
  }
  const count = state.total > 99 ? '99+' : String(state.total);
  const lead = state.leadTitleKey !== null ? t(state.leadTitleKey, state.leadTitleParams) : '';
  return (
    <button type="button" className="att-strip att-strip--link" onClick={() => navigate('/attention')}>
      <span className="att-strip-count">{t('dashboard.attentionStrip.count', { count })}</span>
      {lead !== '' && <span className="att-strip-lead">{lead}</span>}
      <span className="att-strip-go" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
