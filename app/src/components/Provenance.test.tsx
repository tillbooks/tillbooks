/**
 * C3 (D118): the provenance line names who, what and when, links to the A35 trace only for an
 * agent-authored row, and stays quiet (no coloured badge, the agent origin named in words).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { Provenance, type ProvenanceProps } from './Provenance';

function renderProv(props: ProvenanceProps) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <Provenance {...props} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('Provenance', () => {
  it('names a human actor and the date, with no trace link', () => {
    renderProv({ origin: 'human', actor: 'mem_anna', timestamp: '2026-08-12T09:30:00Z' });
    expect(screen.getByText(/Erfasst durch mem_anna/)).toBeTruthy();
    expect(screen.getByText(/12\.08\.2026/)).toBeTruthy();
    expect(screen.queryByText('Spur ansehen')).toBeNull();
  });

  it('names the agent in words and links to the trace when one exists', () => {
    renderProv({
      origin: 'agent',
      actor: 'agent',
      action: 'Entwurf angenommen',
      timestamp: '2026-08-12',
      traceHref: '/agent?session=s1',
    });
    expect(screen.getByText(/Erfasst durch den Agenten/)).toBeTruthy();
    expect(screen.getByText(/Entwurf angenommen/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Spur ansehen' });
    expect(link.getAttribute('href')).toBe('/agent?session=s1');
  });

  it('names the Studio seat in words, never as the raw D13 key (J3.5, "humanize machine labels")', () => {
    renderProv({ origin: 'human', actor: 'studio', action: 'Manuell', timestamp: '2026-08-12' });
    expect(screen.getByText(/Erfasst im Studio/)).toBeTruthy();
    expect(screen.queryByText(/Erfasst durch studio/)).toBeNull();
  });

  it('falls back to a neutral label when the read names no actor', () => {
    renderProv({ origin: 'unknown', actor: null, timestamp: '2026-08-12' });
    expect(screen.getByText(/Erfasst,/)).toBeTruthy();
  });

  it('carries the origin as data, not colour', () => {
    const { container } = renderProv({ origin: 'agent', actor: 'agent', timestamp: '2026-08-12' });
    expect(container.querySelector('.provenance')?.getAttribute('data-origin')).toBe('agent');
  });
});
