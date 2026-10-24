/**
 * D177 point 7: the drag handle at a header cell's right edge. A pointer drag sets the column's width
 * (held inside its bounds), a double-click resets it, and the keyboard does both: ArrowLeft and
 * ArrowRight move it by a step, Home resets it. It is the WAI-ARIA window splitter: a focusable
 * `separator` with its value, so a screen reader hears which column it sizes and how wide it is.
 *
 * A pointer-tracking drag is not motion (DESIGN.md "Motion"): it follows the pointer, never eased.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { COLUMN_KEY_STEP, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTHS, type ResizableColumn } from './columns';

export interface ColumnResizerProps {
  column: ResizableColumn;
  /** The column's name in words, for the handle's accessible name ("Breite: Datum"). */
  label: string;
  /** The column's set width, or null while it flexes (a drag then starts from its rendered width). */
  width: number | null;
  onWidth: (width: number) => void;
  /** The drag let go, or a key moved it: remember the width. */
  onCommit: () => void;
  onReset: () => void;
}

export function ColumnResizer({ column, label, width, onWidth, onCommit, onReset }: ColumnResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const self = useRef<HTMLSpanElement | null>(null);
  /** The width the column has now: its set width, else the header cell's rendered one. */
  const current = () => width ?? Math.round(self.current?.parentElement?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTHS[column]);
  // A flexing column still states its width (a focusable separator owes `aria-valuenow`): the rendered one.
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (width !== null) return;
    const w = Math.round(self.current?.parentElement?.getBoundingClientRect().width ?? 0);
    setMeasured(w > 0 ? w : MIN_COLUMN_WIDTHS[column]);
  }, [width, column]);

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startX: e.clientX, startWidth: current(), pointerId: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (a test, an old engine) cannot be captured; the drag still follows it.
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (d === null) return;
    onWidth(d.startWidth + (e.clientX - d.startX));
  };
  const end = (e: PointerEvent<HTMLSpanElement>) => {
    if (drag.current === null) return;
    try {
      e.currentTarget.releasePointerCapture(drag.current.pointerId);
    } catch {
      // Nothing was captured.
    }
    drag.current = null;
    onCommit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onWidth(current() + (e.key === 'ArrowRight' ? COLUMN_KEY_STEP : -COLUMN_KEY_STEP));
      onCommit();
    } else if (e.key === 'Home') {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width ?? measured ?? MIN_COLUMN_WIDTHS[column]}
      aria-valuemin={MIN_COLUMN_WIDTHS[column]}
      aria-valuemax={MAX_COLUMN_WIDTH}
      tabIndex={0}
      ref={self}
      className="bank-col-resize"
      data-column={column}
      data-testid={`bank-col-grip-${column}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
