/**
 * OverflowMenu: the WAI-ARIA menu button keyboard model (D15/C2).
 *
 * D15/C2 names roving focus, Escape to close and click-outside as the requirement, so each of them
 * is asserted here rather than assumed. Keyboard behaviour that is not tested does not stay
 * working, and the Escape-returns-focus-to-the-trigger case is the one that silently regresses.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

function items(overrides: Partial<OverflowMenuItem>[] = []): OverflowMenuItem[] {
  const base: OverflowMenuItem[] = [
    { key: 'archive', label: 'Archivieren', onSelect: vi.fn() },
    { key: 'duplicate', label: 'Duplizieren', onSelect: vi.fn() },
    { key: 'delete', label: 'Löschen', onSelect: vi.fn(), danger: true },
  ];
  return base.map((item, i) => ({ ...item, ...(overrides[i] ?? {}) }));
}

function renderMenu(list: OverflowMenuItem[] = items()) {
  render(
    <div>
      <button type="button">before</button>
      <OverflowMenu label="Aktionen für Konto 1020" items={list} />
    </div>,
  );
  return screen.getByRole('button', { name: 'Aktionen für Konto 1020' });
}

describe('OverflowMenu', () => {
  it('gives the trigger a real accessible name and the menu-button ARIA contract', () => {
    const trigger = renderMenu();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click with the correct roles and marks itself expanded', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('aria-labelledby', trigger.id);
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('Enter opens the menu and puts focus on the FIRST item', async () => {
    const trigger = renderMenu();
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('menuitem', { name: 'Archivieren' })).toHaveFocus();
  });

  it('Space opens the menu and puts focus on the first item', async () => {
    const trigger = renderMenu();
    trigger.focus();
    await userEvent.keyboard(' ');

    expect(screen.getByRole('menuitem', { name: 'Archivieren' })).toHaveFocus();
  });

  it('ArrowDown opens at the first item, ArrowUp opens at the LAST', async () => {
    const trigger = renderMenu();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archivieren' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toHaveFocus();
  });

  it('arrow keys move between items and wrap at both ends', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);

    expect(screen.getByRole('menuitem', { name: 'Archivieren' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Duplizieren' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toHaveFocus();

    // Wraps forward from the last item back to the first.
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archivieren' })).toHaveFocus();
    // And backward from the first to the last.
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toHaveFocus();
  });

  it('Home and End jump to the first and last item', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);

    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Archivieren' })).toHaveFocus();
  });

  it('focus is ROVING: exactly one item is tabbable at a time', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);

    const tabbable = () =>
      screen.getAllByRole('menuitem').filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAccessibleName('Archivieren');

    await userEvent.keyboard('{ArrowDown}');
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAccessibleName('Duplizieren');
  });

  it('Escape closes the menu and returns focus TO THE TRIGGER, not the body', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard('{ArrowDown}');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('a pointer press outside closes the menu without stealing focus back', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'before' }));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).not.toHaveFocus();
  });

  it('Tab closes the menu and lets focus move on', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);

    await userEvent.tab();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('selecting an item runs its action, closes, and restores focus to the trigger', async () => {
    const list = items();
    const trigger = renderMenu(list);
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplizieren' }));

    expect(list[1].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('the destructive item sits LAST and is the only one carrying the danger variant', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);

    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems[menuItems.length - 1]).toHaveAccessibleName('Löschen');
    expect(menuItems[menuItems.length - 1]).toHaveClass('btn--danger');
    expect(menuItems[0]).not.toHaveClass('btn--danger');
  });

  it('the danger colouring exists only once the menu is open', async () => {
    const trigger = renderMenu();
    expect(document.querySelector('.btn--danger')).toBeNull();

    await userEvent.click(trigger);
    expect(document.querySelector('.btn--danger')).not.toBeNull();
  });

  it('a disabled item stays focusable but does not fire', async () => {
    const list = items([{}, { disabled: true }]);
    const trigger = renderMenu(list);
    await userEvent.click(trigger);

    await userEvent.keyboard('{ArrowDown}');
    const disabledItem = screen.getByRole('menuitem', { name: 'Duplizieren' });
    expect(disabledItem).toHaveFocus();
    expect(disabledItem).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(disabledItem);
    expect(list[1].onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('clicking the trigger a second time closes the menu', async () => {
    const trigger = renderMenu();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('a menu with no items disables the trigger rather than opening an empty popup', async () => {
    const trigger = renderMenu([]);
    expect(trigger).toBeDisabled();

    await userEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
