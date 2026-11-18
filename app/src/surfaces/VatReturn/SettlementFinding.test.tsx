/**
 * D198 stateless check: the settlement feed's pre-filing check on the MWST-Abrechnung. The engine's
 * `settlement` field is read defensively (absent or empty: nothing shows); a finding shows one icon per kind
 * with its number, the words in the tooltip, and the events behind a disclosure. Synthetic figures and ids.
 * Asserted by text and label, never by a status role (`loading-state-convention.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { SettlementFinding } from './SettlementFinding';
import { parseSettlementFinding } from './model';

const item = (eventId: string, reason: string, extra: Record<string, unknown> = {}) => ({
  system: 'kurswerk',
  processor: 'zahlfix',
  eventId,
  kind: 'sale',
  day: '2026-08-03',
  amountMinor: 5405,
  netMinor: 5000,
  vatMinor: 405,
  reason,
  figure: 0,
  entries: [],
  pullId: null,
  ...extra,
});

const ENGINE = {
  missing: [
    item('kw:sale:3001', 'missing'),
    // A reader refusal without a readable day: listed in every period, its figures unknown.
    item('kw:sale:3005', 'missing', { code: 'invalid_day', day: null, netMinor: null, vatMinor: null }),
  ],
  missingCount: 2,
  missingVatMinor: { sale: 405, refund: 0, input: 0 },
  bookedTwice: [item('kw:sale:3009', 'booked_twice', { figure: 2 })],
  amended: [item('kw:sale:3010', 'amended', { figure: 1, changed: [{ field: 'vatMinor', was: 405, now: 810 }] })],
  overrideCheck: [item('kw:sale:3011', 'override_check', { changed: [{ field: 'vatMinor', was: 405, now: 810 }] })],
  earlier: [item('kw:sale:2001', 'missing', { day: '2026-05-04' })],
  earlierCount: 1,
  beforeFromDate: { count: 0, vatMinor: 0 },
  templateSkipped: { count: 0, vatMinor: 0 },
  cancellingGroupsHidden: { groups: 0, events: 0, setting: 'hide_test' },
  unplaceable: { count: 1, items: [{ system: 'kurswerk', processor: 'zahlfix', code: 'missing_id', kind: 'sale', day: '2026-08-06', amountMinor: 5405 }] },
  bookedTest: [],
  testExcluded: { sale: { events: 1, vatMinor: 162 }, refund: { events: 1, vatMinor: -162 }, input: { events: 0, vatMinor: 0 } },
  testActivity: { byKind: {}, testResidueMinor: 93, unrefundedTestSales: [], unreversedTestTransfers: [] },
  uncoveredSources: [{ system: 'kurswerk', processor: 'zahlfix', gaps: [{ from: '2026-09-01', to: '2026-09-30' }] }],
  hasFindings: true,
};

describe('the settlement feed finding', () => {
  it('reads nothing from an absent or empty field', () => {
    expect(parseSettlementFinding(undefined)).toBeNull();
    expect(parseSettlementFinding({ hasFindings: false, missing: [], uncoveredSources: [] })).toBeNull();
  });

  it('never nets the VAT of test events: a sale and its refund count as their magnitude', () => {
    expect(parseSettlementFinding(ENGINE)?.testExcluded).toEqual({ events: 2, vatMinor: 324 });
  });

  it('A42: counts the events ignored in the Umsatz review as their VAT magnitude, and shows them as one icon', () => {
    const withIgnored = { ...ENGINE, ignored: { sale: { events: 1, vatMinor: 405 }, refund: { events: 1, vatMinor: -162 }, input: { events: 0, vatMinor: 0 } } };
    const finding = parseSettlementFinding(withIgnored);
    expect(finding?.ignored).toEqual({ events: 2, vatMinor: 567 });
    expect(parseSettlementFinding(ENGINE)?.ignored).toEqual({ events: 0, vatMinor: 0 });
    render(
      <I18nProvider initialLocale="de-CH">
        <SettlementFinding finding={finding!} currency="CHF" />
      </I18nProvider>,
    );
    expect(screen.getByLabelText(/^2 Ereignisse mit MWST hast du in der Umsatz-Prüfung ignoriert \(.*5\.67 MWST ausgelassen\)$/)).toBeInTheDocument();
  });

  it('reads every list of the stateless check, an undated refusal included', () => {
    const finding = parseSettlementFinding(ENGINE);
    expect(finding?.items.map((i) => [i.eventId, i.reason, i.earlier, i.day])).toEqual([
      ['kw:sale:3001', 'missing', false, '2026-08-03'],
      ['kw:sale:3005', 'missing', false, null],
      ['kw:sale:3009', 'booked_twice', false, '2026-08-03'],
      ['kw:sale:3010', 'amended', false, '2026-08-03'],
      ['kw:sale:3011', 'override_check', false, '2026-08-03'],
      ['kw:sale:2001', 'missing', true, '2026-05-04'],
    ]);
    expect([finding?.missingCount, finding?.doubleCount, finding?.amendedCount, finding?.overrideCheckCount, finding?.unplaceable]).toEqual([2, 1, 1, 1, 1]);
  });

  it('shows one icon per kind with its number and the words on hover, and the events behind a disclosure', () => {
    const finding = parseSettlementFinding(ENGINE);
    expect(finding).not.toBeNull();
    render(
      <I18nProvider initialLocale="de-CH">
        <SettlementFinding finding={finding!} currency="CHF" />
      </I18nProvider>,
    );
    expect(screen.getByLabelText('Abrechnungs-Feed')).toBeInTheDocument();
    expect(screen.getByLabelText(/^2 Ereignisse dieser Periode sind nicht im Buch \(.*4\.05 MWST\)$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^1 frühere Ereignisse brauchen einen Blick/)).toBeInTheDocument();
    expect(screen.getByLabelText('1 Ereignisse sind doppelt gebucht')).toBeInTheDocument();
    expect(screen.getByLabelText('1 Ereignisse hat der Feed geändert, nachdem der Import sie gebucht hat')).toBeInTheDocument();
    expect(screen.getByLabelText('1 Ereignisse, die du als ausserhalb des Imports erledigt markiert hast, hat der Feed seither geändert')).toBeInTheDocument();
    expect(screen.getByLabelText('1 Ereignisse kamen ohne ID aus dem Feed und lassen sich nicht benennen')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Testzahlungen: 2 mit MWST ausgelassen/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Testzahlungen lassen .*0\.93 auf dem Durchlaufkonto$/)).toBeInTheDocument();
    expect(screen.getByLabelText('kurswerk · zahlfix: nicht abgeholt vom 01.09.2026 bis 30.09.2026')).toBeInTheDocument();
    // No helper sentence on the page: the words live in the labels and tooltips only.
    expect(screen.getAllByText(/nicht im Buch \(/).every((el) => el.getAttribute('role') === 'tooltip')).toBe(true);
    expect(screen.getByText('Ereignisse zeigen')).toBeInTheDocument();
    expect(screen.getAllByText('nicht im Buch')).toHaveLength(3);
    expect(screen.getByText('doppelt gebucht')).toBeInTheDocument();
    expect(screen.getByText('vom Feed geändert')).toBeInTheDocument();
    expect(screen.getByText('Zahlen geändert, Override prüfen')).toBeInTheDocument();
  });
});
