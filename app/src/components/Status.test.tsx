/**
 * Status, one state word with its glyph (K-22, D137).
 *
 * Asserted: every kind renders a 14px SVG glyph from the icon set AND the word (never colour alone,
 * never a text dingbat), each kind a distinct shape, the status colours only on success/warn/danger
 * glyphs, never the accent, and axe clean in both themes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { Status, STATUS_GLYPH_SIZE, type StatusKind } from './Status';

const KINDS: [StatusKind, string][] = [
  ['success', 'Bezahlt'],
  ['warn', 'Überfällig'],
  ['danger', 'Abgelehnt'],
  ['neutral', 'Entwurf'],
  ['pending', 'Versendet'],
  ['inactive', 'Archiviert'],
];

describe('Status, the glyph and the word', () => {
  it.each(KINDS)('%s renders a 14px svg glyph and the word "%s"', (kind, label) => {
    const { container } = render(<Status kind={kind} label={label} />);
    const root = container.querySelector('.status-word');
    expect(root).toHaveAttribute('data-kind', kind);
    const svg = root?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('width', String(STATUS_GLYPH_SIZE));
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(label)).toBeInTheDocument();
    // The accessible text is the word alone: the glyph is decorative.
    expect(root).toHaveTextContent(label, { normalizeWhitespace: true });
    expect(root?.textContent).toBe(label);
  });

  it('draws a different shape for every kind, so the state never rests on colour', () => {
    const shapes = KINDS.map(([kind, label]) => {
      const { container, unmount } = render(<Status kind={kind} label={label} />);
      const markup = container.querySelector('svg')?.innerHTML ?? '';
      unmount();
      return markup;
    });
    expect(new Set(shapes).size).toBe(KINDS.length);
  });

  it('is plain text, not a live region', () => {
    const { container } = render(<Status kind="success" label="Gebucht" />);
    // A state in a table cell is read with its row, never announced on its own.
    expect(container.querySelector('[role], [aria-live]')).toBeNull();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme: Theme) => {
    const { container } = render(
      <ThemeProvider initialTheme={theme}>
        <ul>
          {KINDS.map(([kind, label]) => (
            <li key={kind}>
              <Status kind={kind} label={label} />
            </li>
          ))}
        </ul>
      </ThemeProvider>,
    );
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Status, the stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/Status.css'), 'utf8');

  it('tints only the success, warn and danger glyphs with the status colours', () => {
    expect(css).toMatch(/\[data-kind='success'\] \.status-word-glyph\s*\{[^}]*var\(--t-success\)/);
    expect(css).toMatch(/\[data-kind='warn'\] \.status-word-glyph\s*\{[^}]*var\(--t-warn\)/);
    expect(css).toMatch(/\[data-kind='danger'\] \.status-word-glyph\s*\{[^}]*var\(--t-danger\)/);
    // The word never takes a status colour: the only status-coloured rules are the three glyph rules.
    expect(css.match(/var\(--t-(?:success|warn|danger)\)/g)).toHaveLength(3);
  });

  it('never spends the accent, never paints a chip ground, never reaches for faint ink', () => {
    expect(css).not.toMatch(/--t-accent/);
    expect(css).not.toMatch(/background/);
    expect(css).not.toMatch(/--t-text-faint/);
  });
});
