/**
 * H08, the MaintenanceLogDrawer: the right-hand create/edit panel for a fixed-asset maintenance log
 * entry. The asset is already known (the surface scopes it), so the drawer captures only the event:
 * date, type, title, description, performer (a free-text external party), a cost section (total or
 * parts + labour, entered in CHF major units and converted to Rappen by the surface on save), an
 * external reference and notes.
 *
 * On EDIT the identity fields (date, type, performer) are read-only: the engine holds them immutable
 * after create, so the drawer never offers to change them (it would only earn a rejection). The engine
 * is the real gate; this drawer's disabled states are the courteous half.
 */
import type { Dispatch, SetStateAction } from 'react';

import type { Err } from '../../lib/client';
import { useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { DetailDrawer } from '../../components/DetailDrawer';

/** The registered maintenance types, mirrored from the engine's §H-ENUM (spec §4). */
const MAINTENANCE_TYPES = ['corrective', 'preventive', 'inspection', 'calibration', 'upgrade', 'other'] as const;

export interface MaintenanceDraft {
  logDate: string;
  maintenanceType: string;
  title: string;
  description: string;
  externalParty: string;
  costChf: string;
  partsChf: string;
  labourChf: string;
  externalReference: string;
  notes: string;
}

export const EMPTY_MAINTENANCE_DRAFT: MaintenanceDraft = {
  logDate: '',
  maintenanceType: 'corrective',
  title: '',
  description: '',
  externalParty: '',
  costChf: '',
  partsChf: '',
  labourChf: '',
  externalReference: '',
  notes: '',
};

export interface MaintenanceLogDrawerProps {
  mode: 'create' | 'edit';
  draft: MaintenanceDraft;
  setDraft: Dispatch<SetStateAction<MaintenanceDraft>>;
  writeError: Err | null;
  canWrite: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export function MaintenanceLogDrawer({ mode, draft, setDraft, writeError, canWrite, onSubmit, onClose }: MaintenanceLogDrawerProps) {
  const t = useT();
  const set = (patch: Partial<MaintenanceDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const isEdit = mode === 'edit';

  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={isEdit ? t('assets.maintenance.form.editTitle') : t('assets.maintenance.form.createTitle')}
      closeLabel={t('assets.common.close')}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('assets.maintenance.back')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSubmit}
            disabled={!canWrite || draft.title.trim() === '' || (!isEdit && draft.logDate.trim() === '')}
          >
            {t('assets.maintenance.save')}
          </button>
        </>
      }
    >
      {writeError && <ErrorBanner error={writeError} />}

      <div className="fa-field">
        <label htmlFor="fa-mnt-date">{t('assets.maintenance.field.logDate')}</label>
        <input
          id="fa-mnt-date"
          type="date"
          value={draft.logDate}
          disabled={isEdit}
          onChange={(e) => set({ logDate: e.target.value })}
        />
      </div>

      <div className="fa-field">
        <label htmlFor="fa-mnt-type">{t('assets.maintenance.field.type')}</label>
        <select id="fa-mnt-type" value={draft.maintenanceType} disabled={isEdit} onChange={(e) => set({ maintenanceType: e.target.value })}>
          {MAINTENANCE_TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {t(`assets.maintenance.type.${ty}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="fa-field">
        <label htmlFor="fa-mnt-title">{t('assets.maintenance.field.title')}</label>
        <input id="fa-mnt-title" value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
      </div>

      <div className="fa-field">
        <label htmlFor="fa-mnt-desc">{t('assets.maintenance.field.description')}</label>
        <textarea id="fa-mnt-desc" value={draft.description} rows={3} onChange={(e) => set({ description: e.target.value })} />
      </div>

      <div className="fa-field">
        <label htmlFor="fa-mnt-party">{t('assets.maintenance.field.externalParty')}</label>
        <input
          id="fa-mnt-party"
          value={draft.externalParty}
          disabled={isEdit}
          onChange={(e) => set({ externalParty: e.target.value })}
        />
      </div>

      <fieldset className="fa-fieldset">
        <legend>{t('assets.maintenance.field.cost')}</legend>
        <div className="fa-field">
          <label htmlFor="fa-mnt-cost">{t('assets.maintenance.field.costTotal')}</label>
          <input id="fa-mnt-cost" inputMode="decimal" value={draft.costChf} onChange={(e) => set({ costChf: e.target.value })} />
        </div>
        <div className="fa-field">
          <label htmlFor="fa-mnt-parts">{t('assets.maintenance.field.partsCost')}</label>
          <input id="fa-mnt-parts" inputMode="decimal" value={draft.partsChf} onChange={(e) => set({ partsChf: e.target.value })} />
        </div>
        <div className="fa-field">
          <label htmlFor="fa-mnt-labour">{t('assets.maintenance.field.labourCost')}</label>
          <input id="fa-mnt-labour" inputMode="decimal" value={draft.labourChf} onChange={(e) => set({ labourChf: e.target.value })} />
        </div>
      </fieldset>

      <div className="fa-field">
        <label htmlFor="fa-mnt-ref">{t('assets.maintenance.field.externalReference')}</label>
        <input id="fa-mnt-ref" value={draft.externalReference} onChange={(e) => set({ externalReference: e.target.value })} />
      </div>

      <div className="fa-field">
        <label htmlFor="fa-mnt-notes">{t('assets.maintenance.field.notes')}</label>
        <textarea id="fa-mnt-notes" value={draft.notes} rows={2} onChange={(e) => set({ notes: e.target.value })} />
      </div>
    </DetailDrawer>
  );
}

export default MaintenanceLogDrawer;
