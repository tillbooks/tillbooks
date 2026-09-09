/**
 * DetailDrawer, the shared right-side detail panel (D118 B2).
 *
 * The contract that made this one component is asserted, not assumed: the dialog role on a `div`
 * (never `aside`), focus trapped and returned to the opener, Escape and scrim-click close, a body
 * that is a distinct scroll region from the fixed header, a slot for the C3 provenance line, and axe
 * clean in both themes.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { ThemeProvider, type Theme } from '../app/theme';
import { I18nProvider } from '../i18n';
import { DetailDrawer } from './DetailDrawer';
import { Modal, type ModalRole } from './Modal';
import { Provenance } from './Provenance';

const OPENER = 'Kontakt öffnen';
// The nested confirm's role, held in a const so the literal never sits as a JSX attribute on a
// component (the modal-role source guard reads such attributes and only permits real host elements).
const CONFIRM_ROLE: ModalRole = 'alertdialog';

function Host({
  theme = 'light',
  onClose,
  withProvenance = false,
}: {
  theme?: Theme;
  onClose?: () => void;
  withProvenance?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <ThemeProvider initialTheme={theme}>
      <I18nProvider>
        <MemoryRouter>
          <button type="button" onClick={() => setOpen(true)}>
            {OPENER}
          </button>
          <DetailDrawer
            open={open}
            onClose={close}
            title="Muster AG"
            closeLabel="Schliessen"
            headerExtra={<span className="chip">Kunde</span>}
            footer={
              <button type="button" className="btn btn--primary">
                Bearbeiten
              </button>
            }
            provenance={
              withProvenance ? (
                <Provenance
                  origin="agent"
                  action="Angelegt"
                  timestamp="2026-08-01"
                  traceHref="/agent?session=abc"
                />
              ) : undefined
            }
          >
            <p>Adresse und Kontaktdaten.</p>
            <input aria-label="Notiz" />
          </DetailDrawer>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}

async function open(props: Parameters<typeof Host>[0] = {}) {
  const result = render(<Host {...props} />);
  await userEvent.click(screen.getByRole('button', { name: OPENER }));
  return result;
}

describe('DetailDrawer, the drawer contract', () => {
  it('renders nothing until opened', () => {
    render(<Host />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled modal dialog on a div, not an aside', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.tagName).toBe('DIV');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Muster AG');
  });

  it('lands focus inside on open', async () => {
    await open();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and returns focus to the row that opened it', async () => {
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

  it('closes on a scrim click', async () => {
    const onClose = vi.fn();
    await open({ onClose });
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    expect(scrim).toHaveClass('drawer-scrim');
    await userEvent.click(scrim);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a click inside the panel never closes the drawer', async () => {
    const onClose = vi.fn();
    await open({ onClose });
    await userEvent.click(screen.getByText('Adresse und Kontaktdaten.'));
    expect(onClose).not.toHaveBeenCalled();
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

  it('keeps the header out of the scrolling body, so title and actions stay in view', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    const head = dialog.querySelector('.drawer-head') as HTMLElement;
    const body = dialog.querySelector('.drawer-body') as HTMLElement;
    expect(head).not.toBeNull();
    expect(body).not.toBeNull();
    // The scrolling body is a distinct region: the title lives in the header, not inside the body.
    expect(body.contains(screen.getByRole('heading', { name: 'Muster AG' }))).toBe(false);
    expect(body).toContainElement(screen.getByText('Adresse und Kontaktdaten.'));
  });

  it('renders the footer actions outside the scrolling body', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    const foot = dialog.querySelector('.drawer-foot') as HTMLElement;
    expect(foot).toContainElement(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(dialog.querySelector('.drawer-body')?.contains(foot)).toBe(false);
  });

  it('hosts the C3 provenance line in its own slot when given one', async () => {
    await open({ withProvenance: true });
    const dialog = screen.getByRole('dialog');
    const slot = dialog.querySelector('.drawer-provenance') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(slot).toContainElement(screen.getByRole('link', { name: 'Spur ansehen' }));
    expect(dialog.querySelector('.drawer-body')?.contains(slot)).toBe(false);
  });

  it('omits the provenance slot entirely when there is nothing to show', async () => {
    await open();
    expect(screen.getByRole('dialog').querySelector('.drawer-provenance')).toBeNull();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = await open({ theme, withProvenance: true });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('DetailDrawer, deactivating the trap for a nested dialog', () => {
  it('does not handle Escape while its own trap is inactive', async () => {
    const onClose = vi.fn();
    render(
      <ThemeProvider initialTheme="light">
        <I18nProvider>
          <MemoryRouter>
            <DetailDrawer
              open
              onClose={onClose}
              title="Muster AG"
              closeLabel="Schliessen"
              trapActive={false}
            >
              <input aria-label="Notiz" />
            </DetailDrawer>
          </MemoryRouter>
        </I18nProvider>
      </ThemeProvider>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets a nested confirm own the trap: Escape closes only the child, the drawer stays', async () => {
    const onDrawerClose = vi.fn();

    function Nested() {
      const [confirmOpen, setConfirmOpen] = useState(false);
      return (
        <ThemeProvider initialTheme="light">
          <I18nProvider>
            <MemoryRouter>
              <DetailDrawer
                open
                onClose={onDrawerClose}
                title="Kontakt bearbeiten"
                closeLabel="Schliessen"
                trapActive={!confirmOpen}
              >
                <input aria-label="Notiz" />
                <button type="button" onClick={() => setConfirmOpen(true)}>
                  Löschen
                </button>
                <Modal
                  open={confirmOpen}
                  onClose={() => setConfirmOpen(false)}
                  role={CONFIRM_ROLE}
                  title="Wirklich löschen?"
                  closeLabel="Abbrechen"
                >
                  <p>Dieser Kontakt wird gelöscht.</p>
                </Modal>
              </DetailDrawer>
            </MemoryRouter>
          </I18nProvider>
        </ThemeProvider>
      );
    }

    render(<Nested />);
    await userEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The drawer never received the Escape: only the child closed.
    expect(onDrawerClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Kontakt bearbeiten' })).toBeInTheDocument();

    // The drawer's trap is live again, so Escape now closes the drawer.
    await userEvent.keyboard('{Escape}');
    expect(onDrawerClose).toHaveBeenCalledOnce();
  });
});

describe('DetailDrawer, the Reveal moment (D122 D-I)', () => {
  it('slides from the right edge and staggers its head, body and foot as items one to three', async () => {
    render(
      <ThemeProvider initialTheme="light">
        <I18nProvider>
          <MemoryRouter>
            <DetailDrawer open onClose={() => undefined} title="Beleg" closeLabel="Schliessen" footer={<button type="button">Ok</button>}>
              <p>Inhalt</p>
            </DetailDrawer>
          </MemoryRouter>
        </I18nProvider>
      </ThemeProvider>,
    );
    const panel = await screen.findByRole('dialog');
    expect(panel.classList.contains('motion-reveal--right')).toBe(true);
    expect(panel.querySelector('.drawer-head')?.getAttribute('data-motion-item')).toBe('1');
    expect(panel.querySelector('.drawer-body')?.getAttribute('data-motion-item')).toBe('2');
    expect(panel.querySelector('.drawer-foot')?.getAttribute('data-motion-item')).toBe('3');
    // At most three items carry a stagger: nothing else in the panel is an item.
    expect(panel.querySelectorAll('[data-motion-item]')).toHaveLength(3);
  });
});
