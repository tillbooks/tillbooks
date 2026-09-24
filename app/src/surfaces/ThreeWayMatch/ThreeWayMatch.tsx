/**
 * I04, Einkauf -> Abgleich-Ausnahmen (`/three-way-match`): the Procurement Match Exceptions list.
 *
 * The open exceptions (posted, unmatched bills whose live three-way evaluation is a variance or
 * nothing-received) with the supplier, the amount at risk and the age. Opening a row raises the
 * bill's embedded `ThreeWayMatchPanel`: the per-line comparison plus Confirm / Override.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 money-path wave)
 *
 * The exception list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place); the amount-at-risk column is a numeric, right-aligned `.t-num` cell, and the
 * open row washes selected through the `rowClassName` hook. The page header is the shared
 * `SurfaceHeader`, and the detail is the shared `DetailDrawer`, which adds the focus trap, Escape and
 * scrim the old side-by-side panel lacked; its trap yields (`trapActive={false}`) while the panel's
 * confirm alertdialog is open. The permission gate is a CONVENIENCE and the engine is the real gate
 * (the standing Studio rule). Every figure renders VERBATIM from the read verbs.
 *
 * Round 2 (D137): the states are Status words, the bordered and success-edged badges are gone
 * (K-22); the open exception is the current-row pill instead of a background wash (K-24); sizes are
 * tokens (K-37). The amount-at-risk figure and its formatting are untouched.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, NoWorkspaceState } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { ThreeWayMatchPanel, MATCH_STATUS_KIND } from './ThreeWayMatchPanel';
import { Status } from '../../components/Status';
import './ThreeWayMatch.css';

interface Exception {
  billId: string;
  poId: string | null;
  supplierId: string;
  status: string;
  valueVarianceRappen: number;
  amountAtRiskRappen: number;
  ageDays: number;
}

const chf = (rappen: number) => (rappen / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ThreeWayMatch() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const [exc, contacts] = await Promise.all([
      client.call('match_three_way_exceptions', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
    ]);
    setLoading(false);
    if (isErr(exc.body)) {
      setError(exc.body);
      return;
    }
    setExceptions((exc.body as unknown as { exceptions?: Exception[] }).exceptions ?? []);
    if (!isErr(contacts.body)) {
      const raw = (contacts.body as unknown as { contacts?: { id: string; name: string }[] }).contacts ?? [];
      setNames(Object.fromEntries(raw.map((c) => [c.id, c.name])));
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const supplierName = (row: Exception) => names[row.supplierId] ?? row.supplierId;

  const columns: DataTableColumn<Exception>[] = [
    { key: 'supplier', header: t('procurement.match.col.supplier'), render: supplierName },
    {
      key: 'status',
      header: t('procurement.match.col.status'),
      render: (r) => <Status kind={MATCH_STATUS_KIND[r.status] ?? 'neutral'} label={t(`procurement.match.status.${r.status}`)} />,
    },
    { key: 'atRisk', header: t('procurement.match.col.atRisk'), numeric: true, render: (r) => chf(r.amountAtRiskRappen) },
    { key: 'age', header: t('procurement.match.col.age'), numeric: true, render: (r) => r.ageDays },
  ];

  if (workspaceId === null) return <NoWorkspaceState body={t('procurement.match.noWorkspace')} />;

  const selectedRow = exceptions.find((e) => e.billId === selected) ?? null;
  const closeDetail = () => {
    setSelected(null);
    setDialogOpen(false);
  };

  return (
    <div className="twm-surface">
      <SurfaceHeader title={t('procurement.match.exceptions')} help={<SurfaceHelp surface="ThreeWayMatch" />} />

      <DataTable
        columns={columns}
        rows={exceptions}
        rowKey={(r) => r.billId}
        caption={t('procurement.match.exceptions')}
        loading={loading}
        error={error ?? undefined}
        onRetry={() => void load()}
        skeletonRows={4}
        onRowClick={(r) => setSelected(r.billId)}
        rowLabel={supplierName}
        isRowCurrent={(r) => r.billId === selected}
        emptyState={<EmptyState title={t('procurement.match.emptyTitle')} hint={t('procurement.match.emptyHint')} />}
      />

      {selectedRow !== null && (
        <DetailDrawer
          open
          onClose={closeDetail}
          title={supplierName(selectedRow)}
          closeLabel={t('procurement.match.close')}
          headerExtra={
            <Status kind={MATCH_STATUS_KIND[selectedRow.status] ?? 'neutral'} label={t(`procurement.match.status.${selectedRow.status}`)} />
          }
          trapActive={!dialogOpen}
        >
          <ThreeWayMatchPanel
            billId={selectedRow.billId}
            onDialogOpenChange={setDialogOpen}
            onMatched={() => {
              // Refresh the list so the now matched bill drops out of the exceptions behind the
              // drawer; keep the drawer mounted on its success confirmation.
              void load();
            }}
          />
        </DetailDrawer>
      )}
    </div>
  );
}

export default ThreeWayMatch;
