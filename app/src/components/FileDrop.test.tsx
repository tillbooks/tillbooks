/**
 * FileDrop, the one way to hand the Studio a file (K-13, D137).
 *
 * Asserted: the real file input is kept and named by the German button text (never the browser's
 * "Choose File"), it is reachable by keyboard, a pick calls `onFiles` and resets the input, a drop
 * delivers the same way but only the files `accept` allows, the drop target shows while a file is
 * held over it, disabled means inert, and axe is clean in both themes and both variants.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { I18nProvider, type Locale } from '../i18n';
import { FileDrop, matchesAccept, type FileDropProps } from './FileDrop';

function renderDrop(props: Partial<FileDropProps> = {}, theme: Theme = 'light', locale: Locale = 'de-CH') {
  const onFiles = props.onFiles ?? vi.fn();
  const result = render(
    <ThemeProvider initialTheme={theme}>
      <I18nProvider initialLocale={locale}>
        <FileDrop {...props} onFiles={onFiles} />
      </I18nProvider>
    </ThemeProvider>,
  );
  return { ...result, onFiles };
}

const pdf = () => new File(['%PDF'], 'beleg.pdf', { type: 'application/pdf' });
const png = () => new File(['png'], 'foto.png', { type: 'image/png' });
const xml = () => new File(['<x/>'], 'camt.053.xml', { type: 'application/xml' });

describe('FileDrop, the real input under a German button', () => {
  it('keeps a real file input, named by the visible button text', () => {
    renderDrop();
    const input = screen.getByLabelText('Datei wählen');
    expect(input).toHaveAttribute('type', 'file');
    expect(screen.getByText('Datei hierher ziehen')).toBeInTheDocument();
    // The browser's own English copy never appears: the input is clipped and the label speaks.
    expect(screen.queryByText(/Choose File|No file chosen/)).toBeNull();
  });

  it('pluralises the button and the prompt when several files are allowed', () => {
    renderDrop({ multiple: true });
    expect(screen.getByLabelText('Dateien wählen')).toHaveAttribute('multiple');
    expect(screen.getByText('Dateien hierher ziehen')).toBeInTheDocument();
  });

  it('speaks English in the en locale', () => {
    renderDrop({}, 'light', 'en');
    expect(screen.getByLabelText('Choose file')).toHaveAttribute('type', 'file');
    expect(screen.getByText('Drop a file here')).toBeInTheDocument();
  });

  it('is reachable by keyboard: the input itself is the Tab stop', async () => {
    renderDrop();
    await userEvent.tab();
    expect(screen.getByLabelText('Datei wählen')).toHaveFocus();
  });

  it('a pick calls onFiles with the file and resets the input so the same file fires again', async () => {
    const { onFiles } = renderDrop({ accept: '.pdf' });
    const input = screen.getByLabelText('Datei wählen') as HTMLInputElement;
    const file = pdf();
    await userEvent.upload(input, file);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(input.value).toBe('');
    await userEvent.upload(input, file);
    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it('describes the input with the hint', () => {
    renderDrop({ hint: 'PDF oder Bild, höchstens 20 MB' });
    const input = screen.getByLabelText('Datei wählen');
    expect(input).toHaveAccessibleDescription('PDF oder Bild, höchstens 20 MB');
  });

  it('a caller label replaces the default and names the input', () => {
    renderDrop({ label: 'Kontoauszug wählen' });
    expect(screen.getByLabelText('Kontoauszug wählen')).toHaveAttribute('type', 'file');
  });
});

describe('FileDrop, dropping', () => {
  function zone(container: HTMLElement) {
    return container.querySelector('.file-drop--zone') as HTMLElement;
  }

  it('shows the target while a file is held over it, and clears it on leave', () => {
    const { container } = renderDrop();
    const target = zone(container);
    fireEvent.dragEnter(target, { dataTransfer: { files: [] } });
    expect(target).toHaveAttribute('data-over');
    // Crossing a child fires another enter and a leave; the zone stays "over".
    fireEvent.dragEnter(target.querySelector('.file-drop-prompt') as HTMLElement, { dataTransfer: { files: [] } });
    fireEvent.dragLeave(target.querySelector('.file-drop-prompt') as HTMLElement);
    expect(target).toHaveAttribute('data-over');
    fireEvent.dragLeave(target);
    expect(target).not.toHaveAttribute('data-over');
  });

  it('delivers dropped files that match accept and rejects the rest', () => {
    const onReject = vi.fn();
    const { container, onFiles } = renderDrop({ accept: '.pdf,image/*', multiple: true, onReject });
    const a = pdf();
    const b = png();
    const c = xml();
    fireEvent.drop(zone(container), { dataTransfer: { files: [a, b, c] } });
    expect(onFiles).toHaveBeenCalledWith([a, b]);
    expect(onReject).toHaveBeenCalledWith([c]);
    expect(zone(container)).not.toHaveAttribute('data-over');
  });

  it('a drop of only wrong files never reaches onFiles', () => {
    const onReject = vi.fn();
    const { container, onFiles } = renderDrop({ accept: '.xml', onReject });
    fireEvent.drop(zone(container), { dataTransfer: { files: [pdf()] } });
    expect(onFiles).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('takes one file from a multi-file drop unless multiple is set', () => {
    const { container, onFiles } = renderDrop();
    const a = pdf();
    fireEvent.drop(zone(container), { dataTransfer: { files: [a, png()] } });
    expect(onFiles).toHaveBeenCalledWith([a]);
  });

  it('disabled: the input is disabled and a drop does nothing', () => {
    const { container, onFiles } = renderDrop({ disabled: true });
    expect(screen.getByLabelText('Datei wählen')).toBeDisabled();
    fireEvent.dragEnter(zone(container), { dataTransfer: { files: [] } });
    expect(zone(container)).not.toHaveAttribute('data-over');
    fireEvent.drop(zone(container), { dataTransfer: { files: [pdf()] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('the button variant is the button alone, with no drop zone', () => {
    const { container } = renderDrop({ variant: 'button' });
    expect(container.querySelector('.file-drop--zone')).toBeNull();
    expect(screen.getByLabelText('Datei wählen')).toHaveAttribute('type', 'file');
    expect(screen.queryByText('Datei hierher ziehen')).toBeNull();
  });
});

describe('FileDrop, matchesAccept', () => {
  it('matches extensions, wildcard MIME types and exact MIME types, and accepts all without a list', () => {
    expect(matchesAccept(pdf(), '.pdf')).toBe(true);
    expect(matchesAccept(pdf(), '.PDF')).toBe(true);
    expect(matchesAccept(png(), 'image/*')).toBe(true);
    expect(matchesAccept(xml(), 'application/xml')).toBe(true);
    expect(matchesAccept(xml(), '.pdf, image/*')).toBe(false);
    expect(matchesAccept(xml(), undefined)).toBe(true);
    expect(matchesAccept(xml(), '')).toBe(true);
  });
});

describe('FileDrop, accessibility and the stylesheet', () => {
  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme, both variants', async (theme) => {
    const { container } = render(
      <ThemeProvider initialTheme={theme}>
        <I18nProvider>
          <FileDrop onFiles={() => undefined} hint="PDF oder Bild" />
          <FileDrop onFiles={() => undefined} variant="button" label="Erweiterung installieren" />
        </I18nProvider>
      </ThemeProvider>,
    );
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('clips the input rather than removing it, and draws focus on the visible button', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/FileDrop.css'), 'utf8');
    const input = /\.file-drop-input\s*\{([^}]*)\}/.exec(css);
    expect(input).not.toBeNull();
    expect(input![1]).not.toMatch(/display:\s*none/);
    expect(input![1]).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(css).toMatch(/\.file-drop-button:has\(\.file-drop-input:focus-visible\)\s*\{[^}]*var\(--t-focus-border\)/);
  });
});
