/**
 * D177 point 7 (A39 §16.3 story 12): the bank table's columns are dragged, remembered per person, and
 * reset by a double-click. The handle is the window-splitter pattern, so the keyboard does the same. The
 * counterparty flexes until the person gives it a width.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ColumnResizer } from './ColumnResizer';
import { DEFAULT_COLUMN_WIDTHS, MIN_COLUMN_WIDTHS, columnStorageKey, readColumnWidths, useColumnWidths, type ResizableColumn } from './columns';

function Harness({ actor, column = 'amount' }: { actor: string; column?: ResizableColumn }) {
  const cols = useColumnWidths(actor);
  const width = cols.widths[column];
  return (
    <table>
      <colgroup>
        <col data-testid="col" style={width === null ? undefined : { width }} />
      </colgroup>
      <thead>
        <tr>
          <th>
            Betrag
            <ColumnResizer
              column={column}
              label={`Breite: ${column}`}
              width={width}
              onWidth={(w) => cols.setWidth(column, w)}
              onCommit={cols.commit}
              onReset={() => cols.reset(column)}
            />
          </th>
        </tr>
      </thead>
    </table>
  );
}

const handle = () => screen.getByRole('separator', { name: /^Breite: / });

describe('resizable columns (D177 point 7)', () => {
  afterEach(() => window.localStorage.clear());

  it('a drag sets the width, the release remembers it per person, and a fresh mount reads it back', () => {
    const { unmount } = render(<Harness actor="seat_a" />);
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_WIDTHS.amount));
    fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 160, pointerId: 1 });
    expect(screen.getByTestId('col')).toHaveStyle({ width: `${DEFAULT_COLUMN_WIDTHS.amount + 60}px` });
    expect(JSON.parse(window.localStorage.getItem(columnStorageKey('seat_a')) ?? '{}')).toEqual({ amount: DEFAULT_COLUMN_WIDTHS.amount + 60 });
    unmount();
    render(<Harness actor="seat_a" />);
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_WIDTHS.amount + 60));
  });

  it('the grip carries a test id per column, so a flow drags the table\'s grip and never the rail\'s', () => {
    render(<Harness actor="seat_a" column="date" />);
    expect(screen.getByTestId('bank-col-grip-date')).toBe(handle());
  });

  it('another person keeps the defaults: the memory is keyed by the seat', () => {
    window.localStorage.setItem(columnStorageKey('seat_a'), JSON.stringify({ amount: 300 }));
    render(<Harness actor="seat_b" />);
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_WIDTHS.amount));
  });

  it('a column never goes under its minimum (the date and the amount never cut)', () => {
    render(<Harness actor="seat_a" />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 0, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTHS.amount));
  });

  it('a double-click resets the column to its default and forgets the stored width', () => {
    window.localStorage.setItem(columnStorageKey('seat_a'), JSON.stringify({ amount: 260 }));
    render(<Harness actor="seat_a" />);
    expect(handle()).toHaveAttribute('aria-valuenow', '260');
    fireEvent.doubleClick(handle());
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_WIDTHS.amount));
    expect(window.localStorage.getItem(columnStorageKey('seat_a'))).toBeNull();
  });

  it('the counterparty flexes until the person drags it, and a reset makes it flex again', () => {
    render(<Harness actor="seat_a" column="party" />);
    // Flexing, it states its rendered width (jsdom renders none, so its minimum) and the column has none.
    expect(handle()).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTHS.party));
    expect(screen.getByTestId('col').getAttribute('style') ?? '').not.toMatch(/width/);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 300, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', '200');
    fireEvent.doubleClick(handle());
    expect(screen.getByTestId('col').getAttribute('style') ?? '').not.toMatch(/width/);
  });

  it('the keyboard moves it by a step and Home resets it', () => {
    render(<Harness actor="seat_a" column="amount" />);
    handle().focus();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_WIDTHS.amount + 8));
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_WIDTHS.amount));
  });

  it('an unreadable store reads as the defaults, never as an error', () => {
    window.localStorage.setItem(columnStorageKey('seat_a'), '{not json');
    expect(readColumnWidths(columnStorageKey('seat_a')).amount).toBe(DEFAULT_COLUMN_WIDTHS.amount);
    window.localStorage.setItem(columnStorageKey('seat_a'), JSON.stringify({ amount: 'wide', vat: -5 }));
    const read = readColumnWidths(columnStorageKey('seat_a'));
    expect(read.amount).toBe(DEFAULT_COLUMN_WIDTHS.amount);
    expect(read.vat).toBe(MIN_COLUMN_WIDTHS.vat);
    expect(read.party).toBeNull();
  });
});
