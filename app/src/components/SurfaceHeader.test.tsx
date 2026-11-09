/**
 * SurfaceHeader, the shared page header (D118 B2).
 *
 * The contract: an h1 title (optionally id'd for the surface's aria-labelledby), an optional
 * subtitle, an inline help slot, and a right-aligned actions slot. Renders regardless of state, so
 * the title stops being duplicated across a surface's early returns. axe clean in both themes.
 *
 * P6: no hairline at rest; `data-stuck` (the hairline's hook in SurfaceHeader.css) arrives only once
 * the scroll region has scrolled content under the pinned header, and leaves again at the top.
 */
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { SurfaceHeader } from './SurfaceHeader';

function renderHeader(
  props: Partial<React.ComponentProps<typeof SurfaceHeader>> = {},
  theme: Theme = 'light',
) {
  return render(
    <ThemeProvider initialTheme={theme}>
      <SurfaceHeader title="Kontakte" {...props} />
    </ThemeProvider>,
  );
}

describe('SurfaceHeader', () => {
  it('renders the title as the surface heading', () => {
    renderHeader();
    expect(screen.getByRole('heading', { level: 1, name: 'Kontakte' })).toBeInTheDocument();
  });

  it('gives the heading an id when asked, for the surface aria-labelledby', () => {
    renderHeader({ titleId: 'contacts-title' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('id', 'contacts-title');
  });

  it('renders an optional subtitle', () => {
    renderHeader({ subtitle: 'Alle Kunden und Lieferanten' });
    expect(screen.getByText('Alle Kunden und Lieferanten')).toBeInTheDocument();
  });

  it('omits the subtitle when none is given', () => {
    const { container } = renderHeader();
    expect(container.querySelector('.surface-header-subtitle')).toBeNull();
  });

  it('hosts an inline help slot beside the title', () => {
    renderHeader({ help: <button type="button">Hilfe</button> });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toContainElement(screen.getByRole('button', { name: 'Hilfe' }));
  });

  it('renders the actions slot, and omits the actions container when empty', () => {
    const { container, rerender } = renderHeader({
      actions: (
        <button type="button" className="btn btn--primary">
          Neu
        </button>
      ),
    });
    expect(screen.getByRole('button', { name: 'Neu' })).toBeInTheDocument();

    rerender(
      <ThemeProvider initialTheme="light">
        <SurfaceHeader title="Kontakte" />
      </ThemeProvider>,
    );
    expect(container.querySelector('.surface-header-actions')).toBeNull();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = renderHeader(
      {
        titleId: 'contacts-title',
        subtitle: 'Alle Kunden und Lieferanten',
        actions: (
          <button type="button" className="btn btn--primary">
            Neu
          </button>
        ),
      },
      theme,
    );
    const results = await axe(container, {
      rules: { region: { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  describe('the scrolled-state hairline (P6)', () => {
    function renderInMain() {
      return render(
        <ThemeProvider initialTheme="light">
          <main>
            <SurfaceHeader title="Journal" />
            <p>Inhalt</p>
          </main>
        </ThemeProvider>,
      );
    }

    async function scrollMainTo(main: HTMLElement, top: number) {
      Object.defineProperty(main, 'scrollTop', { configurable: true, value: top });
      await act(async () => {
        fireEvent.scroll(main);
      });
    }

    it('carries no data-stuck at rest', () => {
      const { container } = renderInMain();
      expect(container.querySelector('.surface-header')).not.toHaveAttribute('data-stuck');
    });

    it('stamps data-stuck once main scrolls content under it, and drops it back at the top', async () => {
      const { container } = renderInMain();
      const main = container.querySelector('main') as HTMLElement;
      const header = container.querySelector('.surface-header') as HTMLElement;

      await scrollMainTo(main, 120);
      await waitFor(() => expect(header).toHaveAttribute('data-stuck'));

      await scrollMainTo(main, 0);
      await waitFor(() => expect(header).not.toHaveAttribute('data-stuck'));
    });

    it('stays unstuck while a banner above it keeps it below the pin line', async () => {
      const { container } = renderInMain();
      const main = container.querySelector('main') as HTMLElement;
      const header = container.querySelector('.surface-header') as HTMLElement;
      // Scrolled, but the header's top is still 40px below main's padding edge: it is not pinned.
      header.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 40, width: 800, height: 60 });

      await scrollMainTo(main, 8);
      // Give the frame-coalesced measure its frame before asserting the negative.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(header).not.toHaveAttribute('data-stuck');
    });

    it('renders outside a main without tracking anything', () => {
      const { container } = renderHeader();
      expect(container.querySelector('.surface-header')).not.toHaveAttribute('data-stuck');
    });
  });
});
