/**
 * SettingRow and SettingGroup: one setting per row, its name, one short line that says what it does,
 * and the control on the right (D187, the owner's pick "Einstellungen A").
 *
 * The owner's review of Meine Einstellungen: the free space beside each control should say what the
 * setting does, and the bare revert icon made no sense. So the explanation is visible here (a setting
 * screen is where words belong, D152), and "Standard" appears beside a control only while its value
 * differs from the default, with the default's words in its tooltip.
 *
 * SettingGroup is a small heading over a run of rows. The rows are separated by a hairline, not by
 * boxes, so the page stays one surface (Ruhig 3).
 */
import { useId, type ReactNode } from 'react';

import { useT } from '../i18n';
import { Tooltip } from './Tooltip';
import './SettingRow.css';

export interface SettingRowProps {
  /** The setting's name. */
  label: ReactNode;
  /** One short line: what the setting does. */
  description?: ReactNode;
  /** The control: a Segmented, a Select, a switch, an input. Labelled by the row's name. */
  children: ReactNode;
  /**
   * Set while the value differs from the default: shows "Standard", which calls `onReset`. Pass the
   * default's words, they become the button's tooltip ("Zurück auf den Standard: System").
   */
  reset?: { defaultLabel: string; onReset: () => void };
  /** An id for the name, so the control can point `aria-labelledby` at it. */
  labelId?: string;
  /** Lines under the explanation that come and go (a refusal, a stale value). */
  status?: ReactNode;
  /** A stable hook for tests and deep links (`data-key`). */
  dataKey?: string;
}

export function SettingRow({ label, description, children, reset, labelId, status, dataKey }: SettingRowProps) {
  const t = useT();
  const autoId = useId();
  const nameId = labelId ?? `setting-${autoId}`;
  const descId = description === undefined ? undefined : `${nameId}-desc`;
  return (
    <div className="setting-row" role="group" aria-labelledby={nameId} aria-describedby={descId} data-key={dataKey}>
      <div className="setting-row-text">
        <div className="setting-row-name" id={nameId}>
          {label}
        </div>
        {description !== undefined && (
          <p className="setting-row-desc" id={descId}>
            {description}
          </p>
        )}
        {status}
      </div>
      <div className="setting-row-control">
        {reset !== undefined && (
          <Tooltip content={t('calm.settingResetContext', { value: reset.defaultLabel })}>
            <button type="button" className="setting-row-reset" onClick={reset.onReset}>
              {t('calm.settingReset')}
            </button>
          </Tooltip>
        )}
        {children}
      </div>
    </div>
  );
}

export function SettingGroup({
  title,
  action,
  children,
  dataKey,
}: {
  title: ReactNode;
  /** A quiet act for the whole group, beside its heading (reset all). */
  action?: ReactNode;
  children: ReactNode;
  dataKey?: string;
}) {
  const id = useId();
  return (
    <section className="setting-group" aria-labelledby={id} data-area={dataKey}>
      <div className="setting-group-head">
        <h2 className="setting-group-title" id={id}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default SettingRow;
