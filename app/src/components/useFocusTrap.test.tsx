/**
 * useFocusTrap, the one modal focus discipline (K-29, K-31, D137).
 *
 * Asserted here, on the hook itself, rather than through a surface:
 *   - Escape closes the INNERMOST open layer. With a popup open inside the trap (the composer's
 *     account list, measured live closing the whole booking), the first Escape closes only the list;
 *     the next one closes the dialog. A disclosure that merely reports `aria-expanded="true"` owns no
 *     popup and does not hold Escape back.
 *   - A key pressed inside ANOTHER modal is that modal's (the feedback dialog over a drawer).
 *   - `initialFocus` lands focus on a named element, and `firstInvalidOrField` picks the first invalid
 *     field, else the first field, else the container: never the close control.
 */
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AccountCombobox } from './AccountCombobox';
import {
  firstInvalidOrField,
  focusFirstInvalid,
  hasOpenPopup,
  useFocusTrap,
  type InitialFocus,
} from './useFocusTrap';

const CHART = [
  { id: 'acc_1020', number: '1020', name: 'Bank' },
  { id: 'acc_1000', number: '1000', name: 'Kasse' },
  { id: 'acc_2000', number: '2000', name: 'Kreditoren' },
];

function Trap({
  onEscape,
  initialFocus,
  children,
  label = 'Buchung erfassen',
}: {
  onEscape: () => void;
  initialFocus?: InitialFocus;
  children: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape, initialFocus });
  return (
    <div role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
      {children}
    </div>
  );
}

describe('useFocusTrap, Escape closes the innermost layer (K-29)', () => {
  it('Escape with the account list open closes only the list; the next Escape closes the dialog', async () => {
    const onEscape = vi.fn();
    function Composer() {
      const [account, setAccount] = useState('');
      return (
        <Trap onEscape={onEscape}>
          <AccountCombobox ariaLabel="Konto 1" accounts={CHART} value={account} onChange={setAccount} />
          <input aria-label="Soll 1" />
        </Trap>
      );
    }
    render(<Composer />);
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    await userEvent.type(box, '10');
    expect(box).toHaveAttribute('aria-expanded', 'true');

    await userEvent.keyboard('{Escape}');
    // The list closed, the dialog did not: the typed booking survives.
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(onEscape).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Buchung erfassen' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('an expanded disclosure (no popup) does not hold Escape back', async () => {
    const onEscape = vi.fn();
    render(
      <Trap onEscape={onEscape}>
        <button type="button" aria-expanded="true">
          Details
        </button>
      </Trap>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('hasOpenPopup reads a combobox or an aria-haspopup owner, never a plain disclosure', () => {
    const node = document.createElement('div');
    node.innerHTML = '<button aria-expanded="true">Gruppe</button>';
    expect(hasOpenPopup(node)).toBe(false);
    node.innerHTML = '<button aria-haspopup="menu" aria-expanded="true">Aktionen</button>';
    expect(hasOpenPopup(node)).toBe(true);
    node.innerHTML = '<button aria-haspopup="false" aria-expanded="true">X</button>';
    expect(hasOpenPopup(node)).toBe(false);
    node.innerHTML = '<input role="combobox" aria-expanded="true" />';
    expect(hasOpenPopup(node)).toBe(true);
    node.innerHTML = '<input role="combobox" aria-expanded="false" />';
    expect(hasOpenPopup(node)).toBe(false);
  });
});

describe('useFocusTrap, the topmost modal owns the keyboard', () => {
  it('a key pressed inside another modal (portaled beside this one) is left to that modal', async () => {
    const onDrawerEscape = vi.fn();
    const onDialogEscape = vi.fn();
    function Stacked() {
      return (
        <>
          <Trap onEscape={onDrawerEscape} label="Kontakt">
            <input aria-label="Name" />
          </Trap>
          {createPortal(
            <Trap onEscape={onDialogEscape} label="Fehler melden">
              <input aria-label="Betreff" />
            </Trap>,
            document.body,
          )}
        </>
      );
    }
    render(<Stacked />);
    const subject = screen.getByRole('textbox', { name: 'Betreff' });
    subject.focus();

    // Tab stays in the dialog on top: the drawer's trap does not pull it back into the drawer.
    await userEvent.tab();
    expect(subject).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(onDialogEscape).toHaveBeenCalledOnce();
    expect(onDrawerEscape).not.toHaveBeenCalled();
  });
});

describe('useFocusTrap, initial focus (K-31)', () => {
  function Form({ initialFocus, invalid = false }: { initialFocus?: InitialFocus; invalid?: boolean }) {
    return (
      <Trap onEscape={() => undefined} initialFocus={initialFocus}>
        <button type="button" aria-label="Schliessen">
          x
        </button>
        <input aria-label="Name" />
        <input aria-label="E-Mail" aria-invalid={invalid ? 'true' : undefined} />
      </Trap>
    );
  }

  it('without initialFocus, lands on the first focusable (unchanged default)', () => {
    render(<Form />);
    expect(screen.getByRole('button', { name: 'Schliessen' })).toHaveFocus();
  });

  it('firstInvalidOrField skips the close control and lands on the first field', () => {
    render(<Form initialFocus={firstInvalidOrField} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });

  it('firstInvalidOrField prefers the first invalid field', () => {
    render(<Form initialFocus={firstInvalidOrField} invalid />);
    expect(screen.getByRole('textbox', { name: 'E-Mail' })).toHaveFocus();
  });

  it('firstInvalidOrField falls back to the container when there is no field', () => {
    render(
      <Trap onEscape={() => undefined} initialFocus={firstInvalidOrField}>
        <button type="button">Schliessen</button>
      </Trap>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('accepts a selector resolved inside the container', () => {
    render(<Form initialFocus='[aria-label="E-Mail"]' />);
    expect(screen.getByRole('textbox', { name: 'E-Mail' })).toHaveFocus();
  });

  it('accepts a ref, and falls back to the first focusable when it names nothing', () => {
    function WithRef({ attach }: { attach: boolean }) {
      const target = useRef<HTMLInputElement>(null);
      return (
        <Trap onEscape={() => undefined} initialFocus={target}>
          <button type="button">Schliessen</button>
          <input aria-label="Betrag" ref={attach ? target : undefined} />
        </Trap>
      );
    }
    const { unmount } = render(<WithRef attach />);
    expect(screen.getByRole('textbox', { name: 'Betrag' })).toHaveFocus();
    unmount();
    render(<WithRef attach={false} />);
    expect(screen.getByRole('button', { name: 'Schliessen' })).toHaveFocus();
  });

  it('focusFirstInvalid moves focus to the first invalid field after a rejected save', () => {
    render(<Form invalid />);
    const dialog = screen.getByRole('dialog');
    expect(focusFirstInvalid(dialog)).toBe(true);
    expect(screen.getByRole('textbox', { name: 'E-Mail' })).toHaveFocus();
  });

  it('focusFirstInvalid reports false when no field is invalid, so the caller keeps its banner', () => {
    render(<Form />);
    expect(focusFirstInvalid(screen.getByRole('dialog'))).toBe(false);
  });
});
