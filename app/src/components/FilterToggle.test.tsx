import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { FilterToggle } from './FilterToggle';

describe('FilterToggle (D187)', () => {
  it('says how many facets are on, and none when nothing is set', () => {
    const { rerender, container } = render(<FilterToggle context="Rolle, Archivierte" count={2} open={false} onToggle={() => {}} />);
    expect(container.querySelector('.filter-count')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveAccessibleDescription('Rolle, Archivierte (2)');
    rerender(<FilterToggle context="Rolle, Archivierte" count={0} open={false} onToggle={() => {}} />);
    expect(container.querySelector('.filter-count')).toBeNull();
  });

  it('toggles the facet row open and closed', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<FilterToggle context="Rolle" count={0} open={false} onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Filter' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenLastCalledWith(true);
    rerender(<FilterToggle context="Rolle" count={0} open onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});
