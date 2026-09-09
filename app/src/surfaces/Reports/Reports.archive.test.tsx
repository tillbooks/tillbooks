/**
 * G13, the labelled Vorsystem comparative on the statements (spec §6 safeguard 5): the column
 * HEADER carries the prior-system label and covered range itself; a window the archive does not
 * wholly cover renders a dash with its reason, never a zero; and the parser carries the label
 * through, so a client dropping it would have to do so deliberately.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { TrialBalance } from './TrialBalance';
import {
  parseTrialBalance,
  compareSourceFor,
  comparePresetFrom,
  comparePeriodFor,
  type TrialBalanceView,
} from './model';
import trialFixture from './trial-balance.compare.fixture.json';

const COMPARATIVE = {
  source: 'archive' as const,
  status: 'ok' as const,
  system: 'bexio',
  coveredFrom: '2019-01',
  coveredTo: '2025-12',
  unlistedNetMinor: 0,
};

function renderTrial(view: TrialBalanceView) {
  return render(
    <I18nProvider initialLocale="en">
      <TrialBalance view={view} locale="en" onDrill={() => {}} />
    </I18nProvider>,
  );
}

describe('the Vorsystem comparative', () => {
  it('parses the comparative label through, on the recorded live compare fixture plus the label', () => {
    const view = parseTrialBalance({ ...trialFixture, comparative: COMPARATIVE });
    expect(view).not.toBeNull();
    expect(view?.comparative).toEqual(COMPARATIVE);
    // And a malformed label fails the WHOLE parse rather than rendering unlabelled figures.
    expect(parseTrialBalance({ ...trialFixture, comparative: { source: 'archive', status: 'sort_of' } })).toBeNull();
  });

  it('carries the prior-system label and covered range IN the column header', () => {
    const view = parseTrialBalance({ ...trialFixture, comparative: COMPARATIVE }) as TrialBalanceView;
    renderTrial(view);
    expect(
      screen.getByRole('columnheader', { name: 'Prior system bexio, 2019-01 to 2025-12' }),
    ).toBeInTheDocument();
  });

  it('renders a dash with the reason, never a zero, when the archive holds no figures', () => {
    const base = parseTrialBalance(trialFixture) as TrialBalanceView;
    // A partial window: compareTo present (the column renders), every compare figure absent.
    const rows = base.rows.map((row) => {
      const { compareClosingMinor, deltaMinor, ...rest } = row;
      void compareClosingMinor;
      void deltaMinor;
      return rest;
    });
    const view: TrialBalanceView = {
      ...base,
      rows,
      comparative: { ...COMPARATIVE, status: 'partial' },
    };
    renderTrial(view);
    const dashes = screen.getAllByTitle('Window only partially covered by the archive');
    // One dash per rendered account row: every absent compare value became a reasoned dash, so no
    // cell was left to read as an implicit zero.
    expect(dashes.length).toBe(view.rows.length);
    for (const dash of dashes) expect(dash).toHaveTextContent('–');
  });

  it('maps the archive preset to a prior-year window with source archive, and round-trips the URL', () => {
    expect(comparePresetFrom('archive')).toBe('archive');
    expect(compareSourceFor('archive')).toBe('archive');
    expect(compareSourceFor('year')).toBeUndefined();
    expect(comparePeriodFor('archive', '2026-01-01', '2026-12-31')).toEqual({
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    });
  });
});
