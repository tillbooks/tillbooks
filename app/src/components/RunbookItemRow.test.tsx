/**
 * RunbookItemRow, the shared checklist and runbook row.
 *
 * Asserted: the machine status is stamped as `data-status` and the status word renders, `current`
 * marks the journey step, `compact` and `overdue` toggle their class and attribute, the due `<time>`
 * carries `dateTime` only when a day is given, `note` and `actions` leave no empty wrapper, caller
 * data attributes land on the row with `undefined` values dropped, and axe is clean.
 * The component resolves no i18n key of its own, so no provider is needed. Every render sits in an
 * `<ol>` because the row is an `<li>`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { RunbookItemRow, type RunbookItemRowProps } from './RunbookItemRow';

const BASE: RunbookItemRowProps = {
  title: 'Kontoauszug prüfen',
  owner: 'du',
  status: 'open',
};

function renderRow(props: Partial<RunbookItemRowProps> = {}) {
  const utils = render(
    <ol>
      <RunbookItemRow {...BASE} {...props} />
    </ol>,
  );
  const row = utils.container.querySelector('li') as HTMLLIElement;
  return { ...utils, row };
}

describe('RunbookItemRow', () => {
  it('renders the title and the owner inside one list item', () => {
    const { row } = renderRow();
    expect(row).not.toBeNull();
    expect(screen.getByRole('listitem')).toBe(row);
    expect(row.className).toBe('runbook-item');
    expect(screen.getByText('Kontoauszug prüfen')).toBeInTheDocument();
    expect(screen.getByText('du')).toBeInTheDocument();
  });

  it('stamps status as data-status and renders statusLabel as text', () => {
    const { row } = renderRow({ status: 'done', statusLabel: 'erledigt' });
    expect(row).toHaveAttribute('data-status', 'done');
    expect(screen.getByText('erledigt')).toBeInTheDocument();
  });

  it('renders a node as the status label, and no status span without one', () => {
    const { row, rerender } = renderRow({ statusLabel: <strong>bestätigt am 12.08.2026</strong> });
    expect(row.querySelector('.runbook-item-status strong')).toHaveTextContent('bestätigt am 12.08.2026');

    rerender(
      <ol>
        <RunbookItemRow {...BASE} />
      </ol>,
    );
    expect(row.querySelector('.runbook-item-status')).toBeNull();
  });

  it('sets aria-current="step" with current, and omits the attribute without it', () => {
    const { row, rerender } = renderRow({ current: true });
    expect(row).toHaveAttribute('aria-current', 'step');

    rerender(
      <ol>
        <RunbookItemRow {...BASE} />
      </ol>,
    );
    expect(row).not.toHaveAttribute('aria-current');
  });

  it('adds runbook-item--compact with compact, and not without it', () => {
    const { row, rerender } = renderRow({ compact: true });
    expect(row).toHaveClass('runbook-item', 'runbook-item--compact');

    rerender(
      <ol>
        <RunbookItemRow {...BASE} compact={false} />
      </ol>,
    );
    expect(row).toHaveClass('runbook-item');
    expect(row).not.toHaveClass('runbook-item--compact');
  });

  it('sets data-overdue="true" with overdue, and omits the attribute without it', () => {
    const { row, rerender } = renderRow({ overdue: true });
    expect(row).toHaveAttribute('data-overdue', 'true');

    rerender(
      <ol>
        <RunbookItemRow {...BASE} overdue={false} />
      </ol>,
    );
    expect(row).not.toHaveAttribute('data-overdue');
  });

  describe('the due date', () => {
    it('renders a <time> with the label and dateTime from dueAt', () => {
      const { row } = renderRow({ dueLabel: '30.11.2026', dueAt: '2026-11-30' });
      const time = row.querySelector('time');
      expect(time).not.toBeNull();
      expect(time).toHaveTextContent('30.11.2026');
      expect(time).toHaveAttribute('datetime', '2026-11-30');
    });

    it('leaves datetime off when dueAt is null or missing', () => {
      const { row, rerender } = renderRow({ dueLabel: 'ohne Datum', dueAt: null });
      expect(row.querySelector('time')).toHaveTextContent('ohne Datum');
      expect(row.querySelector('time')).not.toHaveAttribute('datetime');

      rerender(
        <ol>
          <RunbookItemRow {...BASE} dueLabel="ohne Datum" />
        </ol>,
      );
      expect(row.querySelector('time')).not.toHaveAttribute('datetime');
    });

    it('renders no <time> without dueLabel, even when dueAt is set', () => {
      const { row } = renderRow({ dueAt: '2026-11-30' });
      expect(row.querySelector('time')).toBeNull();
    });
  });

  describe('note and actions', () => {
    it('render when given', () => {
      const { row } = renderRow({
        note: 'Blockiert durch: Belege',
        actions: <button type="button">Erledigen</button>,
      });
      expect(row.querySelector('.runbook-item-note')).toHaveTextContent('Blockiert durch: Belege');
      expect(screen.getByRole('button', { name: 'Erledigen' }).closest('.runbook-item-actions')).not.toBeNull();
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('leave no empty wrapper when %s', (_name, value) => {
      const { row } = renderRow({ note: value, actions: value });
      expect(row.querySelector('.runbook-item-note')).toBeNull();
      expect(row.querySelector('.runbook-item-actions')).toBeNull();
    });
  });

  it('renders titleAside beside the title', () => {
    const { row } = renderRow({ titleAside: <span data-testid="aside">check.key</span> });
    expect(row.querySelector('.runbook-item-title')).toContainElement(screen.getByTestId('aside'));
  });

  it('puts dataAttributes on the <li> and drops undefined values', () => {
    const { row } = renderRow({ dataAttributes: { 'data-item': 'i1', 'data-stale': undefined } });
    expect(row).toHaveAttribute('data-item', 'i1');
    expect(row).not.toHaveAttribute('data-stale');
  });

  it('has no axe violations in a full row, current and overdue', async () => {
    const { container } = renderRow({
      status: 'open',
      statusLabel: 'offen',
      dueLabel: '30.11.2026',
      dueAt: '2026-11-30',
      overdue: true,
      current: true,
      note: 'Blockiert durch: Belege',
      actions: <button type="button">Erledigen</button>,
    });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations in a compact done row', async () => {
    const { container } = renderRow({ status: 'done', statusLabel: 'erledigt', compact: true });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
