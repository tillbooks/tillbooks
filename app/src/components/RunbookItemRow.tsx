/**
 * The runbook item row, shared by G20's implementation tasks and G22's checklist items (D127, canon:
 * one design language for one job). A row is a title, who acts on it, a status word (never a colour
 * alone), an optional due date in tabular numerals, an optional note (blocked by, skipped because,
 * stale since) and the actions the caller decides it carries. The caller owns every string: this
 * component renders what it is handed and resolves no key of its own, so G20 and G22 keep their own
 * catalogues.
 *
 * `current` marks the journey position (`aria-current="step"`); `compact` renders a done row on one
 * line so the whole journey stays in reading order without the done rows shouting (plan finding 8).
 */
import type { ReactNode } from 'react';

import './RunbookItemRow.css';

export interface RunbookItemRowProps {
  /** The item title, already localized. */
  title: string;
  /** Who acts on it, already localized ("du", "ein Agent", "das System"). */
  owner: string;
  /** The machine status, stamped as `data-status` for the caller's CSS and tests. */
  status: string;
  /** The status WORD (erfüllt, erledigt, bestätigt am ..., nicht zutreffend, offen). */
  statusLabel?: ReactNode;
  /** An ISO day, rendered by the caller (P11) into `dueLabel`; kept for tests and sorting. */
  dueAt?: string | null;
  dueLabel?: string;
  /** True when the date has passed and the item is still open. */
  overdue?: boolean;
  /** A note under the title: blocked by, the skip reason, the stale sign-off. */
  note?: ReactNode;
  /** The row's actions, in render order (one primary at most, decided by the caller). */
  actions?: ReactNode;
  /** The journey position (the next open item). */
  current?: boolean;
  /** A done or skipped row, one line. */
  compact?: boolean;
  /** Extra data attributes the caller wants on the row (a stable id for tests, an attention flag). */
  dataAttributes?: Record<string, string | undefined>;
  /** A tooltip-bearing element beside the title (the check key on a system item). */
  titleAside?: ReactNode;
}

export function RunbookItemRow({
  title,
  owner,
  status,
  statusLabel,
  dueAt,
  dueLabel,
  overdue = false,
  note,
  actions,
  current = false,
  compact = false,
  dataAttributes,
  titleAside,
}: RunbookItemRowProps) {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(dataAttributes ?? {})) if (v !== undefined) attrs[k] = v;
  return (
    <li
      className={compact ? 'runbook-item runbook-item--compact' : 'runbook-item'}
      data-status={status}
      data-overdue={overdue ? 'true' : undefined}
      aria-current={current ? 'step' : undefined}
      {...attrs}
    >
      <div className="runbook-item-main">
        <span className="runbook-item-title">
          {title}
          {titleAside}
        </span>
        <span className="runbook-item-owner">{owner}</span>
        {statusLabel !== undefined && <span className="runbook-item-status">{statusLabel}</span>}
        {dueLabel !== undefined && (
          <time className="runbook-item-due" dateTime={dueAt ?? undefined}>
            {dueLabel}
          </time>
        )}
      </div>
      {note !== undefined && note !== null && <div className="runbook-item-note">{note}</div>}
      {actions !== undefined && actions !== null && <div className="runbook-item-actions">{actions}</div>}
    </li>
  );
}
