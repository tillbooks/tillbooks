/** The shared reorder wrapper (D180): a finished drag becomes exactly one reorder, or none. */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { SortableList, reorderOf } from './SortableList';

const drag = (active: string, over: string | null) =>
  ({ active: { id: active }, over: over === null ? null : { id: over } }) as unknown as Parameters<typeof reorderOf>[0];

describe('SortableList', () => {
  it('a drop on another item is a reorder; a drop on itself or outside is none', () => {
    expect(reorderOf(drag('cash', 'revenue'))).toEqual(['cash', 'revenue']);
    expect(reorderOf(drag('cash', 'cash'))).toBeNull();
    expect(reorderOf(drag('cash', null))).toBeNull();
  });

  it('renders the chosen list element with its name and style, and never calls onReorder by itself', () => {
    const onReorder = vi.fn();
    render(
      <SortableList ids={['a']} onReorder={onReorder} className="probe" as="ol" ariaLabel="Probe" style={{ ['--probe' as string]: 3 }}>
        <li>a</li>
      </SortableList>,
    );
    const list = screen.getByRole('list', { name: 'Probe' });
    expect(list.tagName).toBe('OL');
    expect(list.style.getPropertyValue('--probe')).toBe('3');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('dnd-kit stays silent: no English default announcement or instructions reach the DOM', async () => {
    const { useSortable } = await import('@dnd-kit/sortable');
    function Row({ id }: { id: string }) {
      const { setNodeRef } = useSortable({ id });
      return <li ref={setNodeRef}>{id}</li>;
    }
    render(
      <SortableList ids={['ar_aging', 'cash']} onReorder={vi.fn()} className="probe">
        <Row id="ar_aging" />
        <Row id="cash" />
      </SortableList>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/draggable item/i);
    expect(text).not.toMatch(/To pick up|press space or enter|arrow keys/i);
  });
});
