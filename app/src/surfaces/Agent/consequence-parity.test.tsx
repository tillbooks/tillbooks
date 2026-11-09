/**
 * D156: a human confirming a governed write and an approver clearing an agent's draft of the SAME write
 * read the SAME sentence. Before D156 `ConsequenceLine` rendered the dial family's sentence while the
 * Vorschlag card rendered a per-verb override, so a revoke, a year close or an IBAN change said one
 * thing on the confirm and another on the card. Both now resolve through the engine's one catalogue
 * (projected into `command-source.generated.json`); this renders both faces and compares their text.
 */
import { describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider, type Locale } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { consequenceSentence, dialCapabilityForVerb } from '../../lib/approval-tiers';
import { VorschlagLine } from './VorschlagLine';
import type { DraftedAction } from './model';

const transport: Transport = async () => ({ status: 200, body: { ok: true } });

function wrap(node: React.ReactNode, locale: Locale) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale={locale}>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={ALLOW_ALL}>
            <MemoryRouter>{node}</MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

function draftOf(verb: string, dialCapability: string): DraftedAction {
  return {
    actionId: `aa_${verb}`,
    actor: 'agent',
    dialCapability,
    actionTool: verb,
    payload: { workspaceId: 'ws_test', idempotencyKey: 'k' },
    status: 'pending',
    createdAt: '2026-10-10T10:00:00.000Z',
    rejectReason: null,
  };
}

/** The verbs that disagreed before D156, plus a family-only verb and two input-keyed ones. */
const CASES: ReadonlyArray<[verb: string, inputKeyedFamily?: string]> = [
  ['post_entry'],
  ['close_year'],
  ['revoke_member'],
  ['invite_member'],
  ['set_bank_sync_schedule'],
  ['set_creditor_bank_profile'],
  ['lock_period'],
  ['reverse_payment'],
  ['send_invoice'],
  ['set_creditor_profile', 'pay'],
  ['book_bank_line', 'pay'],
];

describe('one consequence, two faces (D156)', () => {
  for (const locale of ['de-CH', 'en'] as const) {
    for (const [verb, inputKeyedFamily] of CASES) {
      it(`${verb} (${locale}): the confirm line and the Vorschlag card read the same sentence`, () => {
        const family = inputKeyedFamily ?? dialCapabilityForVerb(verb);
        expect(family, `${verb} is governed`).not.toBe(null);
        const expected = consequenceSentence(verb, locale, family);
        expect(expected, `${verb} carries a ${locale} sentence`).not.toBe(null);

        const confirm = wrap(<ConsequenceLine verb={verb} />, locale);
        const line = confirm.container.querySelector('.consequence-line-text')?.textContent ?? null;
        cleanup();

        const card = wrap(<VorschlagLine action={draftOf(verb, family as string)} onApprove={() => undefined} onReject={() => undefined} />, locale);
        // D167: the line carries the sentence behind its (i) tooltip and as the Genehmigen description.
        const onCard = card.container.querySelector('.vorschlag-consequence')?.textContent ?? null;
        const tip = card.container.querySelector('[role="tooltip"]')?.textContent ?? null;
        const describedBy = card.container.querySelector('.vorschlag-approve')?.getAttribute('aria-describedby') ?? '';
        const description = describedBy === '' ? null : (card.container.ownerDocument.getElementById(describedBy)?.textContent ?? null);
        cleanup();

        expect(line).toBe(expected);
        expect(onCard).toBe(expected);
        expect(tip).toBe(expected);
        expect(description).toBe(expected);
      });
    }
  }
});
