/**
 * Segmented, one of 2 to 5 sibling values (K-11, D137).
 *
 * The APG radio group is asserted, not assumed: a named radiogroup of radios with `aria-checked`, one
 * Tab stop, arrow keys that move AND select with wraparound, Home and End. The owner's exemption is
 * asserted against the stylesheet: the chosen segment is a neutral raise and never reads the accent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { Segmented, type SegmentedOption } from './Segmented';

type Period = 'month' | 'quarter' | 'year';

const OPTIONS: SegmentedOption<Period>[] = [
  { value: 'month', label: 'Monat' },
  { value: 'quarter', label: 'Quartal' },
  { value: 'year', label: 'Jahr' },
];

function Host({
  theme = 'light',
  initial = 'month',
  onChange,
  disabled,
}: {
  theme?: Theme;
  initial?: Period;
  onChange?: (value: Period) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<Period>(initial);
  return (
    <ThemeProvider initialTheme={theme}>
      <Segmented
        options={OPTIONS}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        label="Zeitraum"
        disabled={disabled}
      />
    </ThemeProvider>
  );
}

describe('Segmented, the radio group contract', () => {
  it('is a named radiogroup of radios, exactly the chosen one checked', () => {
    render(<Host />);
    expect(screen.getByRole('radiogroup', { name: 'Zeitraum' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Quartal' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Jahr' })).toHaveAttribute('aria-checked', 'false');
  });

  it('is a single Tab stop on the chosen segment', () => {
    render(<Host initial="quarter" />);
    expect(screen.getByRole('radio', { name: 'Quartal' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: 'Jahr' })).toHaveAttribute('tabindex', '-1');
  });

  it('keeps one Tab stop on the first segment when the value names no option', () => {
    render(
      <Segmented options={OPTIONS} value={'week' as Period} onChange={() => undefined} label="Zeitraum" />,
    );
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveAttribute('tabindex', '0');
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(0);
  });

  it('picks on click and reports the value once; picking the chosen value again reports nothing', async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Jahr' }));
    expect(onChange).toHaveBeenCalledWith('year');
    expect(screen.getByRole('radio', { name: 'Jahr' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Jahr' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move focus AND selection, wrapping at both ends', async () => {
    render(<Host />);
    screen.getByRole('radio', { name: 'Monat' }).focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Quartal' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Quartal' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Jahr' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Jahr' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Quartal' })).toHaveAttribute('aria-checked', 'true');
  });

  it('Home and End jump to the ends', async () => {
    render(<Host initial="quarter" />);
    screen.getByRole('radio', { name: 'Quartal' }).focus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Jahr' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a disabled control reports nothing', async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} disabled />);
    await userEvent.click(screen.getByRole('radio', { name: 'Jahr' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes a visible label by id instead of aria-label', () => {
    render(
      <>
        <span id="seg-label">Ansicht</span>
        <Segmented
          options={[
            { value: 'list', label: 'Liste' },
            { value: 'board', label: 'Board' },
          ]}
          value="list"
          onChange={() => undefined}
          labelledBy="seg-label"
        />
      </>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Ansicht' })).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = render(<Host theme={theme} />);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Segmented, the stylesheet (K-11 and the accent exemption)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/Segmented.css'), 'utf8');

  it('is a 32px bg-soft track with equal-width segments', () => {
    expect(css).toMatch(/\.segmented\s*\{[^}]*height:\s*32px/);
    expect(css).toMatch(/\.segmented\s*\{[^}]*background:\s*var\(--t-bg-soft\)/);
    expect(css).toMatch(/\.segmented\s*\{[^}]*grid-auto-columns:\s*1fr/);
  });

  it('raises the chosen segment neutrally: bg-elev, the control shadow, a hairline', () => {
    const chosen = /\.segmented-option\[aria-checked='true'\]\s*\{([^}]*)\}/.exec(css);
    expect(chosen).not.toBeNull();
    expect(chosen![1]).toMatch(/background:\s*var\(--t-bg-elev\)/);
    expect(chosen![1]).toMatch(/box-shadow:\s*var\(--t-shadow-control\)/);
    expect(chosen![1]).toMatch(/border-color:\s*var\(--t-border\)/);
  });

  it('never spends the accent, outside the focus cue', () => {
    const withoutFocus = css.replace(/[^{}]*:focus-visible\s*\{[^}]*\}/g, '');
    expect(withoutFocus).not.toMatch(/--t-accent/);
  });

  it('gives every segment a transparent border for the focus cue, and colour-only hover transitions', () => {
    expect(css).toMatch(/\.segmented-option\s*\{[^}]*border:\s*1px solid transparent/);
    expect(css).toMatch(/transition:[^;]*var\(--t-motion-hover\)/);
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
