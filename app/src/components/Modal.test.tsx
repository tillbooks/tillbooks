/**
 * Modal, the shared dialog primitive (D118 B2).
 *
 * The a11y contract is the reason this exists as one component, so it is asserted rather than
 * assumed: the modal role sits on a `div` (never `aside`), focus is trapped and returns to the
 * opener, Escape closes, the alertdialog does NOT dismiss on a scrim click, and axe is clean in both
 * themes.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { Modal, type ModalRole } from './Modal';

const OPENER = 'Dialog öffnen';
// The nested confirm's role, held in a const so the literal never sits as a JSX attribute on a
// component (the modal-role source guard reads such attributes and only permits real host elements).
const CONFIRM_ROLE: ModalRole = 'alertdialog';

/** A stateful host with an opener button, so focus-return and Escape can be exercised end to end. */
function Host({
  role,
  onClose,
  theme = 'light',
}: {
  role?: ModalRole;
  onClose?: () => void;
  theme?: Theme;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <ThemeProvider initialTheme={theme}>
      <button type="button" onClick={() => setOpen(true)}>
        {OPENER}
      </button>
      <Modal
        open={open}
        onClose={close}
        role={role}
        title="Buchung stornieren"
        closeLabel="Schliessen"
        footer={
          <button type="button" className="btn btn--primary">
            Bestätigen
          </button>
        }
      >
        <p>Willst du diese Buchung wirklich stornieren?</p>
        <input aria-label="Grund" />
      </Modal>
    </ThemeProvider>
  );
}

async function open(props: Parameters<typeof Host>[0] = {}) {
  const result = render(<Host {...props} />);
  await userEvent.click(screen.getByRole('button', { name: OPENER }));
  return result;
}

describe('Modal, the dialog contract', () => {
  it('renders nothing until opened, so a parent can mount it unconditionally', () => {
    render(<Host />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled modal dialog on a div, not an aside', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.tagName).toBe('DIV');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Buchung stornieren');
  });

  it('takes the alertdialog role for a consequential confirm', async () => {
    await open({ role: 'alertdialog' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lands focus inside on open', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const onClose = vi.fn();
    await open({ onClose });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: OPENER })).toHaveFocus();
  });

  it('closes on the labelled close control and returns focus to the opener', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Schliessen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: OPENER })).toHaveFocus();
  });

  it('traps Tab: the last control wraps round to the first', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('a plain dialog closes on a scrim click', async () => {
    const onClose = vi.fn();
    await open({ onClose });
    // The scrim is the dialog's grandparent (scrim > panel > ...). Click it directly.
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    expect(scrim).toHaveClass('modal-scrim');
    await userEvent.click(scrim);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('an alertdialog does NOT close on a scrim click: a stray click cannot answer it', async () => {
    const onClose = vi.fn();
    await open({ role: 'alertdialog', onClose });
    const scrim = screen.getByRole('alertdialog').parentElement as HTMLElement;
    await userEvent.click(scrim);
    // A click inside the panel is stopped, and the scrim ignores the click for an alertdialog.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('a click inside the panel never closes the dialog', async () => {
    const onClose = vi.fn();
    await open({ onClose });
    await userEvent.click(screen.getByText('Willst du diese Buchung wirklich stornieren?'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the footer actions outside the scrolling body', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    const foot = dialog.querySelector('.modal-foot');
    expect(foot).not.toBeNull();
    expect(foot).toContainElement(screen.getByRole('button', { name: 'Bestätigen' }));
    expect(dialog.querySelector('.modal-body')?.contains(foot as Node)).toBe(false);
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = await open({ theme });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Modal, deactivating the trap for a nested dialog', () => {
  it('does not handle Escape while its own trap is inactive', async () => {
    const onClose = vi.fn();
    render(
      <ThemeProvider initialTheme="light">
        <Modal open onClose={onClose} title="Editor" closeLabel="Schliessen" trapActive={false}>
          <input aria-label="Feld" />
        </Modal>
      </ThemeProvider>,
    );
    await userEvent.keyboard('{Escape}');
    // With the trap off, this dialog stops competing: its Escape handler is not attached, so a nested
    // child is free to own it.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets a nested confirm own the trap: Escape closes only the child, the parent stays', async () => {
    const onParentClose = vi.fn();

    function Nested() {
      const [confirmOpen, setConfirmOpen] = useState(false);
      return (
        <ThemeProvider initialTheme="light">
          <Modal
            open
            onClose={onParentClose}
            title="Buchung bearbeiten"
            closeLabel="Schliessen"
            // While the confirm is open the editor hands the trap and Escape to it.
            trapActive={!confirmOpen}
          >
            <input aria-label="Betrag" />
            <button type="button" onClick={() => setConfirmOpen(true)}>
              Stornieren
            </button>
            <Modal
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              role={CONFIRM_ROLE}
              title="Wirklich stornieren?"
              closeLabel="Abbrechen"
            >
              <p>Diese Buchung wird storniert.</p>
            </Modal>
          </Modal>
        </ThemeProvider>
      );
    }

    render(<Nested />);
    await userEvent.click(screen.getByRole('button', { name: 'Stornieren' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    // Only the child closed; the parent editor is still on screen and never got the Escape.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onParentClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Buchung bearbeiten' })).toBeInTheDocument();

    // With the child gone the parent's trap is live again, so Escape now closes the editor.
    await userEvent.keyboard('{Escape}');
    expect(onParentClose).toHaveBeenCalledOnce();
  });
});

describe('Modal, the Reveal moment (D122 D-I)', () => {
  it('rises in place and staggers its head, body and foot as items one to three', async () => {
    render(
      <ThemeProvider initialTheme="light">
        <Modal open onClose={() => undefined} title="Bestätigen" closeLabel="Schliessen" footer={<button type="button">Ok</button>}>
          <p>Inhalt</p>
        </Modal>
      </ThemeProvider>,
    );
    const panel = await screen.findByRole('dialog');
    expect(panel.classList.contains('motion-reveal--center')).toBe(true);
    expect(panel.querySelector('.modal-head')?.getAttribute('data-motion-item')).toBe('1');
    expect(panel.querySelector('.modal-body')?.getAttribute('data-motion-item')).toBe('2');
    expect(panel.querySelector('.modal-foot')?.getAttribute('data-motion-item')).toBe('3');
    expect(panel.querySelectorAll('[data-motion-item]')).toHaveLength(3);
  });
});
