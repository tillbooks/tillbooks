import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { allowConsole } from '../../test-console';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { PermissionDenied, Padlock } from './PermissionDenied';
import { NoWorkspaceState } from './NoWorkspaceState';

function renderWithI18n(ui: React.ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

/** For states that carry a route link, which needs a router in scope. */
function renderRouted(ui: React.ReactNode) {
  return render(
    <I18nProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

describe('Skeleton', () => {
  it('announces the loading state and renders the requested block count', () => {
    // LOADING-PROOF-EXEMPT: A component unit test: Skeleton is rendered directly with props, so
    // there is no transport, no request, and nothing that could be in flight to prove.
    const { container } = renderWithI18n(<Skeleton rows={4} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.skeleton')).toHaveLength(4);
  });
});

describe('Skeleton, the shape props (K-34)', () => {
  it('lays tiles out as an equal-column grid, each block the tile height', () => {
    const { container } = renderWithI18n(<Skeleton rows={8} columns={4} height={112} />);
    const region = container.querySelector('.skeleton-region') as HTMLElement;
    expect(region).toHaveClass('skeleton-region--grid');
    expect(region.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.skeleton'));
    expect(blocks).toHaveLength(8);
    for (const block of blocks) {
      expect(block.style.height).toBe('112px');
      expect(block.style.width).toBe('100%');
    }
  });

  it('a stack shortens its last line; a caller width sizes every block', () => {
    const { container, unmount } = renderWithI18n(<Skeleton rows={3} />);
    const stacked = Array.from(container.querySelectorAll<HTMLElement>('.skeleton')).map((b) => b.style.width);
    expect(stacked).toEqual(['100%', '100%', '60%']);
    unmount();
    const sized = renderWithI18n(<Skeleton rows={2} width={96} />);
    const widths = Array.from(sized.container.querySelectorAll<HTMLElement>('.skeleton')).map((b) => b.style.width);
    expect(widths).toEqual(['96px', '96px']);
  });
});

describe('EmptyState', () => {
  it('renders default title and hint from i18n', () => {
    renderWithI18n(<EmptyState />);
    expect(screen.getByRole('heading', { name: 'Noch nichts vorhanden' })).toBeInTheDocument();
    expect(screen.getByText('Lege den ersten Eintrag an, um zu beginnen.')).toBeInTheDocument();
  });

  it('fires the optional first action', async () => {
    const onClick = vi.fn();
    renderWithI18n(<EmptyState action={{ label: 'Konto anlegen', onClick }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  // The CTA used to carry `.state-action`, a parallel button style outside the shared control
  // system. It is on `.btn` now, in the secondary variant by owner decision (D21): every state
  // panel wears the same quiet button and the accent stays on the surfaces' own actions. These
  // assertions are about the shared control, so a drift back to a bespoke class or a silent
  // promotion to an accent variant fails here rather than in a screenshot review.
  it('renders its CTA on the shared control system, in the secondary variant (D21)', () => {
    renderWithI18n(<EmptyState action={{ label: 'Konto anlegen', onClick: vi.fn() }} />);
    const cta = screen.getByRole('button', { name: 'Konto anlegen' });
    expect(cta).toHaveClass('btn', 'btn--secondary');
    expect(cta).not.toHaveClass('btn--primary', 'btn--accent');
  });

  it('has no axe violations', async () => {
    const { container } = renderWithI18n(<EmptyState />);
    // Page-level best-practice rules (must live in a landmark, must have an h1) do not apply to an
    // isolated fragment: the shell provides both. They are disabled here, not the a11y content rules.
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('ErrorBanner', () => {
  it('maps a known engine error code to a friendly message under role=alert', () => {
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'workspace_not_found' }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Aktion fehlgeschlagen');
    expect(alert).toHaveTextContent('Der gewählte Arbeitsbereich wurde nicht gefunden.');
  });

  it('falls back to a generic sentence for an unmapped error code', () => {
    // This test walks the i18n fallback path ON PURPOSE, and that path shouts in dev. The shout is
    // the point (an unmapped code IS a defect in production copy), so it is declared here rather
    // than left as ambient stderr that every future reader has to re-classify.
    allowConsole(/missing translation for "errors\.some_new_code"/);
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'some_new_code' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Die Aktion konnte nicht abgeschlossen werden.',
    );
  });

  it('offers a retry when a handler is given', async () => {
    const onRetry = vi.fn();
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'invalid_input' }} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('ErrorBanner, one glyph and one ground (K-35)', () => {
  it('opens with the glyph alone: no text exclamation mark before the title', () => {
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'workspace_not_found' }} />);
    const title = screen.getByText('Aktion fehlgeschlagen');
    expect(title.textContent).toBe('Aktion fehlgeschlagen');
    expect(screen.getByRole('alert').textContent).not.toContain('!');
    expect(screen.getByRole('alert').querySelectorAll('svg')).toHaveLength(1);
  });

  it('a read failure has its own title and never asks to check input', () => {
    allowConsole(/missing translation for "errors\.some_read_code"/);
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'some_read_code' }} context="read" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Laden fehlgeschlagen');
    expect(alert).toHaveTextContent('Die Daten konnten nicht geladen werden. Versuche es erneut.');
    expect(alert).not.toHaveTextContent('prüfe die Eingaben');
    expect(alert).toHaveAttribute('data-context', 'read');
  });

  it('a mapped code keeps its own sentence in the read context, under the read title', () => {
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'workspace_not_found' }} context="read" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Laden fehlgeschlagen');
    expect(alert).toHaveTextContent('Der gewählte Arbeitsbereich wurde nicht gefunden.');
  });

  it('holds retry in the one actions row', () => {
    renderWithI18n(<ErrorBanner error={{ ok: false, error: 'invalid_input' }} onRetry={vi.fn()} />);
    const retry = screen.getByRole('button', { name: 'Erneut versuchen' });
    expect(retry.parentElement).toHaveClass('error-actions');
  });

  it('the stylesheet lays it on danger-soft with no border, the title in the text ink at 600, actions 16px apart', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/states/states.css'), 'utf8');
    expect(css).toMatch(/\.error-banner\s*\{[^}]*border:\s*0/);
    expect(css).toMatch(/\.error-banner\s*\{[^}]*background:\s*var\(--t-danger-soft\)/);
    expect(css).toMatch(/\.error-title\s*\{[^}]*color:\s*var\(--t-text\)/);
    expect(css).toMatch(/\.error-title\s*\{[^}]*font-weight:\s*600/);
    expect(css).toMatch(/\.error-actions\s*\{[^}]*gap:\s*var\(--t-space-2\)/);
  });

  it.each(['action', 'read'] as const)('has no axe violations in the %s context', async (context) => {
    const { container } = renderWithI18n(
      <ErrorBanner error={{ ok: false, error: 'invalid_input' }} onRetry={vi.fn()} context={context} />,
    );
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('EmptyState, the filtered-empty state (K-33)', () => {
  it('says what the filter hides and offers to clear it', async () => {
    const onClear = vi.fn();
    renderWithI18n(<EmptyState filtered={{ onClear }} />);
    expect(screen.getByRole('heading', { name: 'Keine Treffer.' })).toBeInTheDocument();
    expect(screen.getByText('Der Filter blendet alle Einträge aus.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('never offers create, even when a create action is passed alongside', () => {
    renderWithI18n(
      <EmptyState
        filtered={{ onClear: vi.fn(), clearLabel: 'Suche leeren' }}
        action={{ label: 'Zahlung erfassen', onClick: vi.fn() }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Zahlung erfassen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Suche leeren' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('takes the caller copy over the shared filtered copy', () => {
    renderWithI18n(
      <EmptyState filtered={{ onClear: vi.fn() }} title="Keine offenen Zahlungen im Filter." hint="Der Status Bezahlt ist ausgeblendet." />,
    );
    expect(screen.getByRole('heading', { name: 'Keine offenen Zahlungen im Filter.' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithI18n(<EmptyState filtered={{ onClear: vi.fn() }} />);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('PermissionDenied', () => {
  it('states the missing right with default copy', () => {
    renderWithI18n(<PermissionDenied />);
    expect(screen.getByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
    expect(screen.getByText('Dir fehlt das nötige Recht für diese Ansicht.')).toBeInTheDocument();
  });

  it('exports Padlock as an alias', () => {
    expect(Padlock).toBe(PermissionDenied);
  });

  it('offers an optional escape hatch so it is not a dead end', async () => {
    const onClick = vi.fn();
    renderWithI18n(<PermissionDenied action={{ label: 'Zugriff anfragen', onClick }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zugriff anfragen' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('spends no accent on its escape hatch: shared control, secondary variant', () => {
    renderWithI18n(<PermissionDenied action={{ label: 'Zugriff anfragen', onClick: vi.fn() }} />);
    const cta = screen.getByRole('button', { name: 'Zugriff anfragen' });
    expect(cta).toHaveClass('btn', 'btn--secondary');
    // A way out of a surface the operator cannot use is not the thing the screen wants them to do.
    expect(cta).not.toHaveClass('btn--primary', 'btn--accent');
  });
});

describe('NoWorkspaceState', () => {
  it('always offers the way out, so a no-workspace surface is never a dead end', () => {
    renderRouted(<NoWorkspaceState />);
    expect(screen.getByRole('heading', { name: 'Kein Arbeitsbereich vorhanden' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
  });

  it('takes a surface-specific reason but keeps the shared way out', () => {
    renderRouted(<NoWorkspaceState body="Konten gehören zu einem Arbeitsbereich." />);
    expect(screen.getByText('Konten gehören zu einem Arbeitsbereich.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderRouted(<NoWorkspaceState />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EmptyState link action', () => {
  it('renders a route link when the action carries a `to`', () => {
    renderRouted(<EmptyState action={{ label: 'Einrichten', to: '/setup' }} />);
    expect(screen.getByRole('link', { name: 'Einrichten' })).toHaveAttribute('href', '/setup');
  });

  // The link form and the button form must be visually identical, or the route CTA reads as
  // decoration. They share the shared control's classes exactly; only the element differs.
  it('gives the link form the SAME shared control classes as the button form', () => {
    const { unmount } = renderRouted(<EmptyState action={{ label: 'Einrichten', to: '/setup' }} />);
    const link = screen.getByRole('link', { name: 'Einrichten' });
    const linkClasses = link.className;
    expect(link).toHaveClass('btn', 'btn--secondary');
    unmount();

    renderWithI18n(<EmptyState action={{ label: 'Einrichten', onClick: vi.fn() }} />);
    expect(screen.getByRole('button', { name: 'Einrichten' }).className).toBe(linkClasses);
  });
});
