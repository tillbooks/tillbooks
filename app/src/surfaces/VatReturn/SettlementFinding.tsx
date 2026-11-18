/**
 * D198 stateless check: the settlement feed's pre-filing check on the MWST-Abrechnung. A FINDING, never a
 * block. Low cognitive load (CLAUDE.md): one head line, then one icon per kind of finding with its number,
 * the words on hover or focus (`Tooltip`), and the events behind a disclosure. Only what is non-zero shows.
 *
 * Read-only: the import books an event; a person who handled one outside the import says so with the
 * override (`resolve_settlement_event` `handled_outside`), and reverses a double booking.
 */
import type { ReactElement } from 'react';

import { useT, formatMoney, formatDate } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { BankGlyph, CalendarGlyph, ExchangeGlyph, HashGlyph, HelpGlyph, NoteGlyph, StatusDangerGlyph, StatusInactiveGlyph, StatusWarnGlyph, TagGlyph } from '../../components/icons';
import type { SettlementFinding as Finding } from './model';

function Chip({ label, icon, value }: { label: string; icon: ReactElement; value: string }) {
  return (
    <Tooltip content={label}>
      <span className="vr-settlement-chip" tabIndex={0} aria-label={label}>
        {icon}
        <span aria-hidden="true">{value}</span>
      </span>
    </Tooltip>
  );
}

export function SettlementFinding({ finding, currency }: { finding: Finding; currency: string }) {
  const t = useT();
  const money = (minor: number): string => formatMoney(minor, currency);
  const chips: ReactElement[] = [];
  if (finding.missingCount > 0) {
    chips.push(
      <Chip
        key="missing"
        icon={<StatusWarnGlyph size={16} />}
        value={String(finding.missingCount)}
        label={t('vat.feed.tip.missing', { count: finding.missingCount, amount: money(finding.missingVatMinor) })}
      />,
    );
  }
  if (finding.earlierCount > 0) {
    chips.push(<Chip key="earlier" icon={<CalendarGlyph size={16} />} value={String(finding.earlierCount)} label={t('vat.feed.tip.earlier', { count: finding.earlierCount })} />);
  }
  if (finding.doubleCount > 0) {
    chips.push(<Chip key="double" icon={<StatusDangerGlyph size={16} />} value={String(finding.doubleCount)} label={t('vat.feed.tip.double', { count: finding.doubleCount })} />);
  }
  if (finding.amendedCount > 0) {
    chips.push(<Chip key="amended" icon={<NoteGlyph size={16} />} value={String(finding.amendedCount)} label={t('vat.feed.tip.amended', { count: finding.amendedCount })} />);
  }
  if (finding.overrideCheckCount > 0) {
    chips.push(
      <Chip key="overrideCheck" icon={<HashGlyph size={16} />} value={String(finding.overrideCheckCount)} label={t('vat.feed.tip.overrideCheck', { count: finding.overrideCheckCount })} />,
    );
  }
  if (finding.testExcluded.events > 0 || finding.unrefundedTestSales > 0 || finding.unreversedTestTransfers > 0 || finding.bookedTest > 0) {
    chips.push(
      <Chip
        key="test"
        icon={<TagGlyph size={16} />}
        value={String(finding.testExcluded.events + finding.unrefundedTestSales + finding.unreversedTestTransfers + finding.bookedTest)}
        label={t('vat.feed.tip.test', {
          excluded: finding.testExcluded.events,
          vat: money(finding.testExcluded.vatMinor),
          open: finding.unrefundedTestSales + finding.unreversedTestTransfers,
          booked: finding.bookedTest,
        })}
      />,
    );
  }
  if (finding.ignored.events > 0) {
    chips.push(
      <Chip
        key="ignored"
        icon={<StatusInactiveGlyph size={16} />}
        value={String(finding.ignored.events)}
        label={t('vat.feed.tip.ignored', { count: finding.ignored.events, vat: money(finding.ignored.vatMinor) })}
      />,
    );
  }
  if (finding.testResidueMinor !== 0) {
    chips.push(<Chip key="residue" icon={<ExchangeGlyph size={16} />} value={money(finding.testResidueMinor)} label={t('vat.feed.tip.residue', { amount: money(finding.testResidueMinor) })} />);
  }
  if (finding.unplaceable > 0) {
    chips.push(<Chip key="unplaceable" icon={<HelpGlyph size={16} />} value={String(finding.unplaceable)} label={t('vat.feed.tip.unplaceable', { count: finding.unplaceable })} />);
  }
  if (finding.gaps.length > 0) {
    const words = finding.gaps.map((g) => t('vat.feed.gap', { source: g.source, from: formatDate(g.from), to: formatDate(g.to) })).join('; ');
    chips.push(<Chip key="gaps" icon={<BankGlyph size={16} />} value={String(finding.gaps.length)} label={words} />);
  }
  return (
    <section className="vr-settlement panel" aria-label={t('vat.feed.title')}>
      <p className="vr-settlement-head">
        <StatusWarnGlyph size={16} />
        <span>{t('vat.feed.title')}</span>
        <span className="vr-settlement-chips">{chips}</span>
      </p>
      {finding.items.length > 0 && (
        <details className="vr-settlement-details">
          <summary>{t('vat.feed.show')}</summary>
          <table className="vr-settlement-table">
            <thead>
              <tr>
                <th scope="col">{t('vat.feed.col.day')}</th>
                <th scope="col" className="t-money">{t('vat.feed.col.amount')}</th>
                <th scope="col" className="t-money">{t('vat.feed.col.vat')}</th>
                <th scope="col">{t('vat.feed.col.why')}</th>
              </tr>
            </thead>
            <tbody>
              {finding.items.map((s) => (
                <tr key={`${s.earlier ? 'earlier' : 'period'}:${s.reason}:${s.eventId}`}>
                  <td>{s.day === null ? '' : formatDate(s.day)}</td>
                  <td className="t-money">{s.amountMinor === null ? '' : formatMoney(s.amountMinor, currency)}</td>
                  <td className="t-money">{s.vatMinor === null ? '' : formatMoney(s.vatMinor, currency)}</td>
                  <td>{t(`vat.feed.reason.${s.reason}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
