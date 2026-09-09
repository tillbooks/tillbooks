/**
 * The collapsible Kostenstellen (cost-centre) section beneath the chart (spec A01 §6, US-A01.5).
 *
 * It owns cost-centre create/archive/delete. The assignment touch-point lives in A02's journal-line
 * editor (out of scope here). Archive-XOR-Delete is exclusive per row exactly as for accounts: a cost
 * centre with attributed lines offers Archive, one with none offers a confirm-gated Delete.
 */
import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { OverflowMenu } from '../../components/OverflowMenu';
import { AccountConfirm } from './AccountConfirm';
import { ArchiveGlyph } from './glyphs';
import { idemKey, isInUse, type CostCenter } from './model';

export interface CostCenterSectionProps {
  workspaceId: string;
  costCenters: CostCenter[];
  /** A24 `manage_chart` (F5): create and the Archive-XOR-Delete overflow are absent without it. */
  canManage: boolean;
  onChanged: () => void;
}

export function CostCenterSection({ workspaceId, costCenters, canManage, onChanged }: CostCenterSectionProps) {
  const t = useT();
  const client = useClient();

  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<CostCenter | null>(null);

  async function create() {
    if (code.trim() === '' || name.trim() === '') return;
    const resp = await client.call('create_cost_center', {
      workspaceId,
      code: code.trim(),
      name: name.trim(),
      idempotencyKey: idemKey('cc'),
    });
    if (!isErr(resp.body)) {
      setCode('');
      setName('');
      setCreating(false);
      onChanged();
    }
  }

  async function archive(costCenter: CostCenter) {
    const resp = await client.call('archive_cost_center', {
      workspaceId,
      costCenterId: costCenter.id,
    });
    if (!isErr(resp.body)) onChanged();
  }

  async function confirmDelete() {
    if (pendingDelete === null) return;
    const resp = await client.call('delete_cost_center', {
      workspaceId,
      costCenterId: pendingDelete.id,
      idempotencyKey: idemKey('cc-del'),
    });
    setPendingDelete(null);
    if (!isErr(resp.body)) onChanged();
  }

  return (
    <section className="cc-section panel" aria-labelledby="cc-title">
      <div className="cc-head panel-head">
        <button
          type="button"
          className="cc-toggle"
          aria-expanded={open}
          aria-label={t('costCenter.toggle')}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" className="cc-caret">
            {open ? '▾' : '▸'}
          </span>
          <h2 id="cc-title" className="cc-title">
            {t('costCenter.title')}
          </h2>
        </button>
        {canManage && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCreating(true)}>
            {t('costCenter.new')}
          </button>
        )}
      </div>

      {open && (
        <div className="cc-body">
          {creating && (
            <div className="cc-create">
              <label className="acc-field">
                <span className="acc-field-label">{t('costCenter.code')}</span>
                <input
                  className="acc-input t-num"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <label className="acc-field">
                <span className="acc-field-label">{t('costCenter.name')}</span>
                <input
                  className="acc-input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="cc-create-foot">
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCreating(false)}>
                  {t('account.cancel')}
                </button>
                <button type="button" className="btn btn--accent" onClick={create}>
                  {t('account.save')}
                </button>
              </div>
            </div>
          )}

          {costCenters.length === 0 ? (
            <p className="cc-empty">{t('costCenter.empty')}</p>
          ) : (
            <ul className="cc-list">
              {costCenters.map((costCenter) => {
                const inUse = isInUse(costCenter);
                const archived = costCenter.archived === true;
                return (
                  <li key={costCenter.id} className={`cc-row${archived ? ' acc-row-archived' : ''}`}>
                    <span className="acc-num t-num">{costCenter.code}</span>
                    <span className="cc-name">{costCenter.name}</span>
                    {archived && (
                      <span className="acc-archived-tag">
                        <ArchiveGlyph />
                        {t('account.archived')}
                      </span>
                    )}
                    {/* D15/C2, same treatment as the account rows directly above: a cost centre has
                        no primary action of its own, so its single Archive-XOR-Delete action sits in
                        the overflow rather than putting a red Delete on every row of the section. */}
                    {canManage && (
                    <span className="acc-actions">
                      <OverflowMenu
                        label={t('costCenter.rowActions', {
                          code: costCenter.code,
                          name: costCenter.name,
                        })}
                        items={
                          inUse
                            ? [
                                {
                                  key: 'archive',
                                  label: t('costCenter.archive'),
                                  onSelect: () => archive(costCenter),
                                },
                              ]
                            : [
                                {
                                  key: 'delete',
                                  label: t('costCenter.delete'),
                                  onSelect: () => setPendingDelete(costCenter),
                                  danger: true,
                                },
                              ]
                        }
                      />
                    </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {pendingDelete !== null && (
        <AccountConfirm
          title={t('costCenter.confirm.title')}
          message={t('costCenter.confirm.delete')}
          confirmLabel={t('costCenter.delete')}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
