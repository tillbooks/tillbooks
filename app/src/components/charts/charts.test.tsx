/**
 * The chart primitive (D178): the geometry as numbers, and each chart's accessible shape: one `role="img"`
 * with its summary, the legend in words, and a table twin carrying every value the marks draw.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { arcPath, donutAngles, linear, niceCeil } from './scale';
import { InOutBars } from './InOutBars';
import { Donut } from './Donut';
import { LineChart, Sparkline } from './LineChart';
import { RankBars } from './RankBars';

const wrap = (ui: React.ReactElement) => render(<I18nProvider initialLocale="de-CH">{ui}</I18nProvider>);

describe('scale', () => {
  it('maps linearly and survives a zero-width domain', () => {
    expect(linear(0, 100, 180, 0)(50)).toBe(90);
    expect(linear(5, 5, 10, 20)(5)).toBe(10);
  });

  it('rounds a maximum up to a 1-2-5 step', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(42000)).toBe(50000);
    expect(niceCeil(1500)).toBe(2000);
    expect(niceCeil(1000)).toBe(1000);
  });

  it('cuts the ring into ordered segments with a gap, a lone part as a full ring', () => {
    const [a, b] = donutAngles([3, 1], 0.04);
    expect(a?.a0).toBeCloseTo(0.02);
    expect(a?.a1).toBeCloseTo((3 / 4) * Math.PI * 2 - 0.02);
    expect(b?.a0).toBeCloseTo((3 / 4) * Math.PI * 2 + 0.02);
    const [only, zero] = donutAngles([5, 0]);
    expect(only?.a1).toBeGreaterThan(Math.PI * 2 - 0.001);
    expect(zero?.a1).toBe(zero?.a0);
    expect(arcPath(80, 80, 76, 50, 0, Math.PI)).toMatch(/^M80\.00,4\.00 A76,76 0 0 1/);
  });
});

describe('charts', () => {
  const points = [
    { key: '2026-01', label: 'Jan', longLabel: 'Januar 2026', inMinor: 0, outMinor: 12000 },
    { key: '2026-02', label: 'Feb', longLabel: 'Februar 2026', inMinor: 30000, outMinor: 0 },
  ];

  it('InOutBars: one image with its summary, both series named with totals, a table twin', () => {
    const { container } = wrap(
      <InOutBars points={points} currency="CHF" summary="Geld rein und raus" labels={{ in: 'Geld rein', out: 'Geld raus', period: 'Monat', table: 'Als Tabelle' }} />,
    );
    expect(screen.getByRole('img', { name: 'Geld rein und raus' })).toBeInTheDocument();
    expect(container.querySelectorAll('.chart-mark--in')).toHaveLength(1);
    expect(container.querySelectorAll('.chart-mark--out')).toHaveLength(1);
    const legend = container.querySelector('figcaption') as HTMLElement;
    expect(legend.textContent).toContain('Geld rein');
    expect(legend.textContent).toContain('300.00');
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('Januar 2026');
  });

  it('Donut: every part named with amount and share, the rest neutral', () => {
    const { container } = wrap(
      <Donut
        parts={[
          { key: 'a', label: '6000 Miete', valueMinor: 30000 },
          { key: 'r', label: 'Übrige', valueMinor: 10000, rest: true },
        ]}
        totalMinor={40000}
        currency="CHF"
        summary="Grösste Aufwände"
        labels={{ total: 'Total', part: 'Konto', amount: 'Betrag', share: 'Anteil', table: 'Als Tabelle' }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Grösste Aufwände' })).toBeInTheDocument();
    expect(container.querySelectorAll('path.chart-mark')).toHaveLength(2);
    expect(container.querySelector('.chart-parts')?.textContent).toContain('75 %');
    expect(container.querySelector('path.chart-step--rest')).not.toBeNull();
  });

  it('LineChart draws one line and a marker per point; Sparkline is decorative', () => {
    const { container } = wrap(
      <LineChart
        points={points.map((p) => ({ key: p.key, label: p.label, longLabel: p.longLabel, valueMinor: p.inMinor - p.outMinor }))}
        currency="CHF"
        summary="Geldfluss"
        labels={{ period: 'Monat', value: 'Netto', table: 'Als Tabelle' }}
      />,
    );
    expect(container.querySelectorAll('.chart-line')).toHaveLength(1);
    expect(container.querySelectorAll('.chart-dot')).toHaveLength(2);
    const spark = render(<Sparkline values={[1, 3, 2]} />);
    expect(spark.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('RankBars lists each row with its amount and a bar scaled to the largest', () => {
    const { container } = wrap(
      <RankBars rows={[{ key: 'a', label: 'Miete', valueMinor: 200 }, { key: 'b', label: 'Material', valueMinor: 100 }]} currency="CHF" label="Grösste Aufwände" />,
    );
    const bars = container.querySelectorAll<HTMLElement>('.chart-rank__bar');
    expect(bars[0]?.style.width).toBe('100%');
    expect(bars[1]?.style.width).toBe('50%');
    expect(screen.getByRole('list', { name: 'Grösste Aufwände' })).toBeInTheDocument();
  });
});
