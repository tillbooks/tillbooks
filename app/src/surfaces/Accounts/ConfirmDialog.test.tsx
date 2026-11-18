import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { ConfirmDialog } from './ConfirmDialog';

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <I18nProvider>
      <button type="button">opener</button>
      <ConfirmDialog message="Wirklich?" confirmLabel="Löschen" onConfirm={onConfirm} onCancel={onCancel} />
    </I18nProvider>,
  );
  return { onConfirm, onCancel };
}

describe('shared ConfirmDialog accessibility (A10-G12)', () => {
  it('takes focus inside the dialog on open, on the safe way out', () => {
    setup();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getAllByRole('button')[1]);
  });

  it('closes on Escape without confirming', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('wraps Tab inside the dialog', () => {
    setup();
    const confirm = screen.getByRole('button', { name: 'Löschen' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getAllByRole('button')[1]);
  });
});
