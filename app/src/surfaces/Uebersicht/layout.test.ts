/** D178 points 12 and 13, D180: the arrangement rules as data. */
import { describe, expect, it } from 'vitest';

import {
  arrangement,
  asBankPlace,
  asContent,
  moveSlot,
  moveSlotTo,
  seriesWindow,
  tileArrangement,
  toggleSlot,
  toggleWidth,
  viewLayout,
  withSlots,
  withTileOrder,
  withTiles,
} from './layout';

const ids = (slots: readonly { id: string }[]) => slots.map((s) => s.id);
const shown = (slots: readonly { id: string; on: boolean }[]) => slots.filter((s) => s.on).map((s) => s.id);

describe('Übersicht cards: one free library (D180)', () => {
  it('an empty preference is the content\'s default set, shown, with every other card waiting hidden', () => {
    const bexio = arrangement('bexio', []);
    expect(ids(bexio)).toEqual(['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks', 'cash_flow', 'expense_bars']);
    expect(shown(bexio)).toEqual(['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks']);
    expect(shown(arrangement('trends', []))).toEqual(['cash_flow', 'expense_bars']);
    expect(shown(arrangement('figures', []))).toEqual([]);
    expect(arrangement('figures', [])).toHaveLength(6);
    expect(arrangement('bexio', 'not a list')).toHaveLength(6);
  });

  it('a stored list decides across contents: its order and its switches win, unknown ids and repeats are ignored', () => {
    const stored = [{ id: 'cash_flow', on: true }, { id: 'nonsense', on: true }, { id: 'open_tasks', on: false }, { id: 'cash_flow', on: false }];
    const slots = arrangement('bexio', stored);
    // A card of another content shows, because the list names it (the content no longer filters).
    expect(slots[0]).toEqual({ id: 'cash_flow', on: true });
    expect(slots[1]).toEqual({ id: 'open_tasks', on: false });
    // The content still fills in the cards the list never names, shown; the rest wait hidden.
    expect(shown(slots)).toEqual(['cash_flow', 'expense_donut', 'money_in_out', 'open_creditors']);
    expect(slots.find((s) => s.id === 'expense_bars')).toEqual({ id: 'expense_bars', on: false });
  });

  it('a card can be full width; the width survives a round trip and toggles back to half', () => {
    const slots = arrangement('bexio', [{ id: 'money_in_out', on: true, w: 'full' }, { id: 'open_tasks', on: true, w: 'wide' }]);
    expect(slots[0]).toEqual({ id: 'money_in_out', on: true, w: 'full' });
    expect(slots[1]).toEqual({ id: 'open_tasks', on: true });
    const wide = toggleWidth(slots, 'open_tasks');
    expect(withSlots(wide).slice(0, 2)).toEqual([
      { id: 'money_in_out', on: true, w: 'full' },
      { id: 'open_tasks', on: true, w: 'full' },
    ]);
    expect(toggleWidth(wide, 'money_in_out')[0]).toEqual({ id: 'money_in_out', on: true });
  });

  it('a write stores every card, so a later content switch cannot reshuffle an arranged page', () => {
    const next = withSlots(toggleSlot(arrangement('bexio', []), 'money_in_out'));
    expect(next).toHaveLength(6);
    expect(next).toContainEqual({ id: 'money_in_out', on: false });
    expect(shown(arrangement('trends', next))).toEqual(['expense_donut', 'open_creditors', 'open_tasks']);
  });
});

describe('Übersicht key figures (D180)', () => {
  const available = ['revenue', 'cash', 'ar_aging', 'utilisation', 'bank_inbox'];

  it('an empty preference is the order the read answered, every tile shown', () => {
    expect(tileArrangement([], available)).toEqual(available.map((id) => ({ id, on: true })));
  });

  it('the stored order and switches win; a stored tile the read did not return is dropped, never added', () => {
    const stored = [{ id: 'stock_value', on: true }, { id: 'utilisation', on: false }, { id: 'cash', on: true }, { id: 'bogus', on: true }];
    const slots = tileArrangement(stored, available);
    expect(ids(slots)).toEqual(['utilisation', 'cash', 'revenue', 'ar_aging', 'bank_inbox']);
    expect(slots[0]).toEqual({ id: 'utilisation', on: false });
    // RBAC or setup decides: stock_value is not available, so it never renders.
    expect(ids(slots)).not.toContain('stock_value');
    // And a write keeps it stored for the day it becomes available again.
    expect(withTiles(stored, slots)).toContainEqual({ id: 'stock_value', on: true });
  });

  it('moves are clamped at both ends, and a drop lands in the target\'s place', () => {
    const slots = tileArrangement([], available);
    expect(ids(moveSlot(slots, 0, -1))).toEqual(available);
    expect(ids(moveSlot(slots, 4, 1))).toEqual(available);
    expect(ids(moveSlot(slots, 1, -1))).toEqual(['cash', 'revenue', 'ar_aging', 'utilisation', 'bank_inbox']);
    expect(ids(moveSlotTo(slots, 'bank_inbox', 'revenue'))).toEqual(['bank_inbox', 'revenue', 'cash', 'ar_aging', 'utilisation']);
    expect(ids(moveSlotTo(slots, 'revenue', 'utilisation'))).toEqual(['cash', 'ar_aging', 'utilisation', 'revenue', 'bank_inbox']);
    expect(ids(moveSlotTo(slots, 'nope', 'cash'))).toEqual(available);
  });
});

describe('a saved view\'s layout (D180)', () => {
  it('reads the period, the cards and the bank place from filters, and the tiles from columns', () => {
    const layout = viewLayout({
      filters: { rangePreset: 'year', widgets: [{ id: 'cash_flow', on: true, w: 'full' }], bankAction: 'bar' },
      columns: ['cash', 'revenue', 'cash'],
    });
    expect(layout.rangePreset).toBe('year');
    expect(layout.widgets).toEqual([{ id: 'cash_flow', on: true, w: 'full' }]);
    expect(layout.bankAction).toBe('bar');
    expect(layout.tiles?.slice(0, 3)).toEqual([
      { id: 'cash', on: true },
      { id: 'revenue', on: true },
      { id: 'ar_aging', on: false },
    ]);
    expect(layout.tiles).toHaveLength(9);
  });

  it('a view saved before D180 (columns and a period only) orders its tiles and hides nothing, the bank item included', () => {
    const layout = viewLayout({ columns: ['revenue', 'cash'], filters: { rangePreset: 'year' } });
    expect(layout).toEqual({ rangePreset: 'year', tileOrder: ['revenue', 'cash'] });
    const current = tileArrangement([{ id: 'utilisation', on: false }], ['bank_inbox', 'revenue', 'cash', 'ar_aging', 'utilisation']);
    expect(withTileOrder(current, layout.tileOrder ?? [])).toEqual([
      { id: 'revenue', on: true },
      { id: 'cash', on: true },
      { id: 'utilisation', on: false },
      { id: 'bank_inbox', on: true },
      { id: 'ar_aging', on: true },
    ]);
    // An agent's view with columns alone reads the same way.
    expect(viewLayout({ columns: ['cash'] })).toEqual({ tileOrder: ['cash'] });
  });

  it('a D180 view carries the whole tile list (even every tile hidden) and a custom period', () => {
    const allHidden = [{ id: 'revenue', on: false }, { id: 'cash', on: false }];
    const layout = viewLayout({
      columns: [],
      filters: { rangePreset: 'custom', from: '2026-02-01', to: '2026-04-30', tiles: allHidden, widgets: [], bankAction: 'tile' },
    });
    expect(layout.tiles).toEqual(allHidden);
    expect(layout.custom).toEqual({ from: '2026-02-01', to: '2026-04-30' });
    expect(viewLayout({ filters: { rangePreset: 'custom', from: 'soon', to: '2026-04-30' } }).custom).toBeUndefined();
  });

  it('a view that carries nothing readable changes nothing', () => {
    expect(viewLayout({ filters: { rangePreset: 'week', bankAction: 'wall' }, columns: [] })).toEqual({});
    expect(viewLayout({})).toEqual({});
  });
});

describe('Übersicht prefs and the charts\' window', () => {
  it('unknown pref values fall back to the defaults', () => {
    expect(asContent('x')).toBe('bexio');
    expect(asBankPlace(undefined)).toBe('tile');
  });

  it('the charts\' window is the twelve months ending with the range\'s month', () => {
    expect(seriesWindow('2026-07-15')).toEqual({ from: '2025-08-01', to: '2026-07-31' });
    expect(seriesWindow('2026-12-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(seriesWindow('2028-02-10')).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });
});
