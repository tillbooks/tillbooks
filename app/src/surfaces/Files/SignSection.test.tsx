import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { I18nProvider } from '../../i18n';
import { SignSection, type SignRequestItem, type SignSectionProps } from './SignSection';

/**
 * E01's drawer section, in isolation (the host wiring is exercised through `Files.test.tsx`'s
 * drawer coverage; this file proves the section's own §6 contract): all six statuses render as
 * glyph PLUS text, the per-status row actions are exactly the spec's (draft: Senden, Signiert
 * markieren, Verwerfen; sent|viewed: Zurückziehen, Signiert markieren, Als abgelehnt markieren;
 * terminal: none), the QES/SES hint follows the selected level, Senden renders DISABLED with the
 * Berechtigung hint without `sign.send`, the CTA is hidden entirely without `sign.write`, and the
 * `needs_provider` refusal renders as the connect-or-complete-manually affordance, never raw.
 */

function request(overrides: Partial<SignRequestItem> = {}): SignRequestItem {
  return {
    id: 'sigreq_1',
    status: 'draft',
    signatureLevel: 'ses',
    signerName: 'Muster AG',
    signerEmail: 'muster@example.ch',
    message: null,
    expiresAt: null,
    declinedReason: null,
    expiredReason: null,
    signedFileId: null,
    ...overrides,
  };
}

function renderSection(overrides: Partial<SignSectionProps> = {}) {
  const props: SignSectionProps = {
    requests: [],
    contacts: [
      { id: 'contact_1', name: 'Muster AG', email: 'muster@example.ch' },
      { id: 'contact_2', name: 'Ohne Mail AG', email: null },
    ],
    canWrite: true,
    canSend: true,
    busy: false,
    error: null,
    onCreate: vi.fn(),
    onSend: vi.fn(),
    onMarkSigned: vi.fn(),
    onDecline: vi.fn(),
    onWithdraw: vi.fn(),
    onDeleteDraft: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <SignSection {...props} />
    </I18nProvider>,
  );
  return { props, view };
}

describe('the Signatur section states', () => {
  it('renders the empty state with the request CTA', () => {
    renderSection();
    expect(screen.getByText('Noch keine Signaturanfragen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Signatur anfordern' })).toBeInTheDocument();
  });

  it('renders the loading state', () => {
    // LOADING-PROOF-EXEMPT: SignSection is presentational: the null requests prop the parent passes drives the skeleton, so there is no transport, no request, and nothing in flight to prove.
    renderSection({ requests: null });
    expect(screen.getByRole('status')).toHaveTextContent('Signaturanfragen werden geladen');
  });

  it('renders every status as glyph plus text, never colour alone', () => {
    renderSection({
      requests: [
        request({ id: 'r1', status: 'draft' }),
        request({ id: 'r2', status: 'sent' }),
        request({ id: 'r3', status: 'viewed' }),
        request({ id: 'r4', status: 'signed' }),
        request({ id: 'r5', status: 'declined', declinedReason: 'zu teuer' }),
        request({ id: 'r6', status: 'expired', expiredReason: 'withdrawn' }),
      ],
    });
    for (const label of ['Entwurf', 'Gesendet', 'Angesehen', 'Signiert', 'Abgelehnt', 'Abgelaufen']) {
      const chip = screen.getByText(label);
      expect(chip).toBeInTheDocument();
      // The glyph is an aria-hidden SVG beside the label, so the TEXT carries the meaning.
      expect(chip.closest('.sign-chip')?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }
    // The decline reason and the withdrawn provenance are visible facts, not tooltips.
    expect(screen.getByText('zu teuer')).toBeInTheDocument();
    expect(screen.getByText('zurückgezogen')).toBeInTheDocument();
  });

  it('renders the needs_provider refusal as the honest affordance, never a raw code', () => {
    renderSection({ error: { ok: false, error: 'needs_provider' } });
    expect(
      screen.getByText('Kein E-Signatur-Anbieter verbunden. Schliesse die Signatur manuell per Upload ab oder verbinde einen Anbieter (Cloud).'),
    ).toBeInTheDocument();
    expect(screen.queryByText('needs_provider')).not.toBeInTheDocument();
  });
});

describe('per-status row actions (spec §6)', () => {
  it('a draft row offers Senden, Signiert markieren and Verwerfen', () => {
    renderSection({ requests: [request({ status: 'draft' })] });
    expect(screen.getByRole('button', { name: 'Senden' })).toBeEnabled();
    expect(screen.getByText('Als signiert markieren (Upload)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entwurf verwerfen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zurückziehen' })).not.toBeInTheDocument();
  });

  it('a sent row offers Zurückziehen, Signiert markieren and Als abgelehnt markieren', () => {
    const { props } = renderSection({ requests: [request({ status: 'sent' })] });
    expect(screen.queryByRole('button', { name: 'Senden' })).not.toBeInTheDocument();
    expect(screen.getByText('Als signiert markieren (Upload)')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Zurückziehen' }).click();
    screen.getByRole('button', { name: 'Als abgelehnt markieren' }).click();
    expect(props.onWithdraw).toHaveBeenCalledWith('sigreq_1');
    expect(props.onDecline).toHaveBeenCalledWith('sigreq_1');
  });

  it('a terminal row offers no actions at all', () => {
    renderSection({ requests: [request({ status: 'signed' })] });
    for (const name of ['Senden', 'Zurückziehen', 'Als abgelehnt markieren', 'Entwurf verwerfen']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Als signiert markieren (Upload)')).not.toBeInTheDocument();
  });
});

describe('the permission split (US-E01.2)', () => {
  it('without sign.write the CTA and every row action are hidden', () => {
    renderSection({ canWrite: false, requests: [request({ status: 'draft' })] });
    expect(screen.queryByRole('button', { name: 'Signatur anfordern' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Senden' })).not.toBeInTheDocument();
    // The tracking list itself stays readable: the chip is a fact, not a control.
    expect(screen.getByText('Entwurf')).toBeInTheDocument();
  });

  it('without sign.send the Senden button renders DISABLED with the Berechtigung hint, not hidden', () => {
    renderSection({ canSend: false, requests: [request({ status: 'draft' })] });
    const send = screen.getByRole('button', { name: /Senden/ });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'Zum Senden brauchst du die Berechtigung sign.send.');
    // Glyph AND text on the hint: the barred mark is aria-hidden beside the label.
    expect(send.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('the request form and the statutory level hints (spec §3)', () => {
  it('shows the SES caveat by default and the OR Art. 14 note when QES is selected', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Signatur anfordern' }));
    expect(screen.getByText('Die EES genügt gesetzlichen Schriftform-Erfordernissen nicht.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Signaturniveau'), 'qes');
    expect(
      screen.getByText('Die QES ist der eigenhändigen Unterschrift gleichgestellt (OR Art. 14); nötig nur bei gesetzlicher Schriftform.'),
    ).toBeInTheDocument();
  });

  it('offers a contact without an email DISABLED with the reason, and submits the chosen signer', async () => {
    const user = userEvent.setup();
    const { props } = renderSection();
    await user.click(screen.getByRole('button', { name: 'Signatur anfordern' }));
    const picker = screen.getByLabelText('Unterzeichnende Person');
    expect(within(picker).getByRole('option', { name: 'Ohne Mail AG (keine E-Mail)' })).toBeDisabled();
    await user.selectOptions(picker, 'contact_1');
    await user.click(screen.getByRole('button', { name: 'Anfrage erstellen' }));
    expect(props.onCreate).toHaveBeenCalledWith({ signerContactId: 'contact_1', signatureLevel: 'ses' });
  });
});

describe('accessibility', () => {
  it('the populated section has no axe violations', async () => {
    const { view } = renderSection({
      requests: [request({ status: 'draft' }), request({ id: 'r2', status: 'sent' })],
    });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
