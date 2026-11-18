/**
 * SettingRow and SettingGroup: one setting per row, ONE visible line (DESIGN.md "The seven screen types",
 * Settings; the owner's pick A of the Einstellungen redesign, 18.11.2026, which replaced D187's visible
 * explanation line after rows grew to about 70px).
 *
 * The line: the label (one line, cut with an ellipsis) and, while the value differs from the default, a
 * 6px dim dot after it. What the setting does is the label's tooltip, on hover and on keyboard focus, and
 * the row's accessible description. On the row's hover or focus only: Auf Standard zurück (while changed,
 * the default's words in its tooltip) and whatever `tools` the caller adds (the Einstellungen put the
 * Änderungen clock there). The control sits in one fixed column on the right, so every control of a page
 * starts and ends on the same line.
 *
 * Every tooltip under a row is portalled and held inside the viewport (`TooltipPortalContext`), so a tip
 * near the left edge is never cut.
 *
 * SettingGroup is a small dim heading over a run of rows. The rows are separated by a hairline, not by
 * boxes, so the page stays one surface (Ruhig 3).
 */
import { useId, type ReactNode } from 'react';

import { useT } from '../i18n';
import { IconButton } from './IconButton';
import { Tooltip, TooltipPortalContext } from './Tooltip';
import './SettingRow.css';

export interface SettingRowProps {
  /** The setting's name, plain text: one line. */
  label: ReactNode;
  /** What the setting does: the label's tooltip and the row's accessible description, never a visible line. */
  description?: ReactNode;
  /**
   * The rare line that must be read BEFORE the click, so it stays visible under the label: a posture the
   * control publishes (Sync), or a consequence that destroys something (Diagnostics). Never an explanation;
   * that is `description`. Also the row's accessible description.
   */
  note?: ReactNode;
  /** The control: a Segmented, a Select, a switch, an input. Labelled by the row's name. */
  children: ReactNode;
  /**
   * Set while the value differs from the default: the row shows Auf Standard zurück on hover or focus, which
   * calls `onReset`. Pass the default's words, they become the button's tooltip ("Standard: System"); an empty
   * string (a structured value with no words) leaves the tooltip at the setting's name.
   */
  reset?: { defaultLabel: string; onReset: () => void };
  /** The value differs from the default: the dot after the label. Defaults to whether `reset` is set. */
  changed?: boolean;
  /** An open question waits on this row (A41 ask-first): the dot in the warn ink, its words in `description`. */
  open?: boolean;
  /** More icon buttons beside the reset, shown on the row's hover or focus (the Änderungen clock). */
  tools?: ReactNode;
  /** A glyph that always shows before the control (the padlock of a missing permission). */
  mark?: ReactNode;
  /** An id for the name, so the control can point `aria-labelledby` at it. */
  labelId?: string;
  /** Lines under the row that come and go (a refusal, an open question, the history). */
  status?: ReactNode;
  /** A stable hook for tests and deep links (`data-key`). */
  dataKey?: string;
}

export function SettingRow({ label, description, note, children, reset, changed, open = false, tools, mark, labelId, status, dataKey }: SettingRowProps) {
  const t = useT();
  const autoId = useId();
  const nameId = labelId ?? `setting-${autoId}`;
  const descId = description === undefined ? undefined : `${nameId}-desc`;
  const noteId = note === undefined ? undefined : `${nameId}-note`;
  const describedBy = [descId, noteId].filter((x) => x !== undefined).join(' ') || undefined;
  const isChanged = changed ?? reset !== undefined;
  const name = (
    <span className="setting-row-label" id={nameId} tabIndex={description === undefined ? undefined : 0}>
      {label}
    </span>
  );
  return (
    <TooltipPortalContext.Provider value={true}>
      <div
        className="setting-row"
        role="group"
        aria-labelledby={nameId}
        aria-describedby={describedBy}
        data-key={dataKey}
        data-changed={isChanged || undefined}
        data-open={open || undefined}
      >
        <div className="setting-row-name">
          {description === undefined ? (
            name
          ) : (
            <Tooltip align="start" descriptionId={descId} content={<span id={descId}>{description}</span>}>
              {name}
            </Tooltip>
          )}
          {(open || isChanged) && <span className={open ? 'setting-row-dot setting-row-dot--open' : 'setting-row-dot'} aria-hidden="true" />}
        </div>
        <div className="setting-row-tools">
          {reset !== undefined && (
            <IconButton icon="reset" small context={reset.defaultLabel === '' ? label : t('calm.settingResetContext', { value: reset.defaultLabel })} onClick={reset.onReset} />
          )}
          {tools}
        </div>
        <div className="setting-row-control">
          {mark}
          {children}
        </div>
        {note !== undefined && (
          <p className="setting-row-note" id={noteId}>
            {note}
          </p>
        )}
        {status !== undefined && <div className="setting-row-status">{status}</div>}
      </div>
    </TooltipPortalContext.Provider>
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
