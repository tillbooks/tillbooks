/**
 * F-13 (friction ledger, Phase 2), story J2.5: the mandates strip, the Treuhänder's cross-mandate
 * attention view on the ONE personalised home (D118 A5).
 *
 * THE DEFECT IT ENDS. A member of several workspaces had no surface that said which mandate needed
 * them: the switcher listed names only, so Reto opened each mandate to read its "Wartet auf dich"
 * strip (measured S 2 per mandate against the story's one screen). This strip lists every mandate
 * the session may open with that mandate's waiting count, read through the SAME `attention_summary`
 * the per-workspace strip and the rail badge read, one call per mandate, in parallel. One click
 * switches; the current mandate is marked, never re-opened.
 *
 * WHERE IT LIVES, AND WHERE IT DOES NOT. It renders on `/overview` only, above the tile wall, and
 * it renders NOTHING for a single workspace: a solo owner never sees a one-row list of themselves.
 * It is not a second rail and not a rail lane: the Favoriten lane stays the rail's only personal
 * surface (DESIGN.md, D118 A3), and this strip is the home's own composition of an existing read.
 *
 * HONESTY. A count is the engine's `total`, never a list length; a denied read (`total: null`) shows
 * the name alone (the padlock is explained on the hub, not here); a failed read is a muted retry on
 * that row, never a zero. Beyond `EAGER_CAP` mandates the counts are read on demand behind one
 * disclosure, so a Treuhänder with forty mandates does not fire forty reads on every home load.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspace } from '../../app/workspace';
import { useT } from '../../i18n';
import './MandatesStrip.css';

/** How many mandates read their count eagerly; the rest wait behind the disclosure. */
export const EAGER_CAP = 8;

interface MandateRow {
  workspaceId: string;
  name: string;
}

type Count = { status: 'loading' } | { status: 'error' } | { status: 'ok'; total: number | null };

/** The rows `list_workspaces` answers, read defensively: an unreadable list is "no strip". */
function parseMandates(body: unknown): MandateRow[] | null {
  if (body === null || typeof body !== 'object') return null;
  const list = (body as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return null;
  const rows: MandateRow[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    if (w.archived === true) continue;
    if (typeof w.workspaceId !== 'string' || w.workspaceId === '') continue;
    rows.push({ workspaceId: w.workspaceId, name: typeof w.name === 'string' && w.name !== '' ? w.name : w.workspaceId });
  }
  return rows;
}

export function MandatesStrip() {
  const t = useT();
  const client = useClient();
  const { workspaceId, setWorkspaceId } = useWorkspace();
  const [mandates, setMandates] = useState<MandateRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, Count>>({});
  const [showAll, setShowAll] = useState(false);
  // The ids whose read is in flight or done, so a re-render never fires a second read for a row.
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    void client.call('list_workspaces', {}).then((response) => {
      if (!live) return;
      setMandates(isErr(response.body) ? null : parseMandates(response.body));
    });
    return () => {
      live = false;
    };
  }, [client]);

  const readCount = useCallback(
    (id: string) => {
      requested.current.add(id);
      setCounts((c) => ({ ...c, [id]: { status: 'loading' } }));
      void client.call('attention_summary', { workspaceId: id, topLimit: 1 }).then((response) => {
        if (isErr(response.body)) {
          setCounts((c) => ({ ...c, [id]: { status: 'error' } }));
          return;
        }
        const total = (response.body as { total?: unknown }).total;
        setCounts((c) => ({ ...c, [id]: { status: 'ok', total: typeof total === 'number' ? total : null } }));
      });
    },
    [client],
  );

  // Read the eager rows once the list is known; the lazy tail reads when the disclosure opens.
  useEffect(() => {
    if (mandates === null || mandates.length < 2) return;
    const visible = showAll ? mandates : mandates.slice(0, EAGER_CAP);
    for (const m of visible) if (!requested.current.has(m.workspaceId)) readCount(m.workspaceId);
  }, [mandates, showAll, readCount]);

  if (mandates === null || mandates.length < 2) return null;

  const visible = showAll ? mandates : mandates.slice(0, EAGER_CAP);
  const hidden = mandates.length - visible.length;

  return (
    <nav className="mandates" aria-label={t('dashboard.mandates.label')}>
      <ul className="mandates-list">
        {visible.map((m) => {
          const current = m.workspaceId === workspaceId;
          const count = counts[m.workspaceId] ?? { status: 'loading' as const };
          return (
            <li key={m.workspaceId} className={current ? 'mandates-row mandates-row--current' : 'mandates-row'}>
              <button
                type="button"
                className="mandates-btn"
                aria-current={current ? 'true' : undefined}
                aria-label={current ? undefined : t('dashboard.mandates.switchTo', { name: m.name })}
                onClick={() => {
                  if (!current) setWorkspaceId(m.workspaceId);
                }}
              >
                <span className="mandates-name">{m.name}</span>
                <MandateCount count={count} />
              </button>
              {count.status === 'error' && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => readCount(m.workspaceId)}>
                  {t('dashboard.mandates.retry')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button type="button" className="btn btn--ghost btn--sm mandates-more" onClick={() => setShowAll(true)}>
          {t('dashboard.mandates.showAll', { count: mandates.length })}
        </button>
      )}
    </nav>
  );
}

/** The per-row count: text always, a glyph never alone, and no fake zero for a denied read. */
function MandateCount({ count }: { count: Count }) {
  const t = useT();
  if (count.status === 'loading') return <span className="mandates-count mandates-count--dim">{t('dashboard.mandates.loading')}</span>;
  if (count.status === 'error') return <span className="mandates-count mandates-count--dim">{t('dashboard.mandates.error')}</span>;
  if (count.total === null) return null;
  if (count.total === 0) return <span className="mandates-count mandates-count--dim">{t('dashboard.mandates.allClear')}</span>;
  const shown = count.total > 99 ? '99+' : String(count.total);
  return <span className="mandates-count">{t('dashboard.mandates.count', { count: shown })}</span>;
}
