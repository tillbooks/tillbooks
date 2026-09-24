/**
 * D02's 3-way-match panel, EMBEDDED in the A17 vendor-bill detail (spec §6: the match panel is NOT a
 * new screen). It is a self-contained, D02-owned component mounted with a single line in A17's
 * `BillEditor` for a posted bill: A17's detail is not refactored, only given this affordance.
 *
 * It lists the bill supplier's matchable POs (`po_list`), shows the three columns per line
 * (bestellt / erhalten / verrechnet) via `po_get`, and runs `match_bill`. Within tolerance it reports
 * ✓ Abgeglichen; over tolerance it reports ⚠ Abweichung and offers an override (which the engine still
 * gates on `post`). D02 posts nothing here: the bill's own posting already ran through A17 -> A02.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { Status } from '../../components/Status';

const newKey = () => crypto.randomUUID();

interface PoOpt {
  id: string;
  number: string;
  status: string;
  supplierContactId: string;
}

interface PoLine {
  id: string;
  description: string | null;
  itemId: string | null;
  qty: number;
  receivedQty: number;
  billedQty: number;
}

export interface BillMatchPanelProps {
  billId: string;
  vendorId: string;
}

export function BillMatchPanel({ billId, vendorId }: BillMatchPanelProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [candidates, setCandidates] = useState<PoOpt[]>([]);
  const [poId, setPoId] = useState('');
  const [lines, setLines] = useState<PoLine[]>([]);
  const [verdict, setVerdict] = useState<'matched' | 'overridden' | 'variance' | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (workspaceId === null) return;
    void (async () => {
      const res = await client.call('po_list', { workspaceId, supplierContactId: vendorId });
      if (!isErr(res.body)) {
        const raw = (res.body as unknown as { pos?: unknown }).pos;
        const pos = Array.isArray(raw) ? (raw as PoOpt[]) : [];
        setCandidates(pos.filter((p) => p.status === 'sent' || p.status === 'received'));
      }
    })();
  }, [client, workspaceId, vendorId]);

  useEffect(() => {
    if (workspaceId === null || poId === '') {
      setLines([]);
      return;
    }
    void (async () => {
      const res = await client.call('po_get', { workspaceId, poId });
      if (!isErr(res.body)) {
        const raw = (res.body as unknown as { lines?: unknown }).lines;
        setLines(Array.isArray(raw) ? (raw as PoLine[]) : []);
      }
    })();
  }, [client, workspaceId, poId]);

  const runMatch = useCallback(
    async (override: boolean) => {
      if (workspaceId === null || poId === '') return;
      setMessage('');
      const res = await client.call('match_bill', { workspaceId, poId, billId, ...(override ? { override: true } : {}), actor: 'Studio', idempotencyKey: newKey() });
      if (isErr(res.body)) {
        if (res.body.error === 'variance_exceeded') {
          setVerdict('variance');
          setMessage(t('po.error.variance_exceeded'));
        } else {
          setVerdict(null);
          setMessage(t(`po.error.${res.body.error}`) || res.body.error);
        }
        return;
      }
      const status = (res.body as { match?: { status?: string } }).match?.status;
      setVerdict(status === 'overridden' ? 'overridden' : 'matched');
      setMessage('');
    },
    [client, workspaceId, poId, billId, t],
  );

  const lineColumns: DataTableColumn<PoLine>[] = [
    { key: 'item', header: t('po.field.item'), render: (l) => l.description ?? l.itemId ?? '' },
    { key: 'ordered', header: t('po.field.ordered'), numeric: true, render: (l) => l.qty },
    { key: 'received', header: t('po.field.received'), numeric: true, render: (l) => l.receivedQty },
    { key: 'billed', header: t('po.field.billed'), numeric: true, render: (l) => l.billedQty },
  ];

  if (candidates.length === 0) {
    return (
      <section className="po-match-panel" aria-label={t('po.action.match')}>
        <h3>{t('po.action.match')}</h3>
        <p>{t('po.emptyMatch')}</p>
      </section>
    );
  }

  return (
    <section className="po-match-panel" aria-label={t('po.action.match')}>
      <h3>{t('po.action.match')}</h3>
      <div className="po-field">
        <span>{t('po.field.number')}</span>
        <Select
          value={poId}
          onChange={(value) => {
            setPoId(value);
            setVerdict(null);
            setMessage('');
          }}
          options={[
            { value: '', label: t('po.field.supplierPick') },
            ...candidates.map((p) => ({ value: p.id, label: p.number })),
          ]}
          ariaLabel={t('po.field.number')}
        />
      </div>

      {lines.length > 0 && <DataTable columns={lineColumns} rows={lines} rowKey={(l) => l.id} caption={t('po.lines.caption')} />}

      {/* The verdict as the one Status word (K-22), never a text glyph. */}
      {verdict === 'matched' && (
        <p role="status">
          <Status kind="success" label={t('po.match.ok')} />
        </p>
      )}
      {verdict === 'overridden' && (
        <p role="status">
          <Status kind="success" label={t('po.match.overridden')} />
        </p>
      )}
      {verdict === 'variance' && (
        <p role="status">
          <Status kind="warn" label={message} />
        </p>
      )}
      {verdict !== 'variance' && message !== '' && <p role="status">{message}</p>}

      {poId !== '' && verdict !== 'matched' && verdict !== 'overridden' && (
        <div className="po-detail-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void runMatch(false)}>
            {t('po.action.match')}
          </button>
          {verdict === 'variance' && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void runMatch(true)}>
              {t('po.match.override')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default BillMatchPanel;
