/**
 * G17's marked term and concept panel, held to the design's own gates: the definition layer is
 * behind a gesture, seeAlso replaces content in place with Esc to the ORIGINAL trigger, an unknown
 * key renders plain text (the build failure lives in test/guidance/), no handoff DOM without a
 * registered A35 provider, and no guidance render requests a remote resource or writes anywhere.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../i18n';
import { registerAgentHandoffProvider } from '../lib/guidance';
import { ConceptTerm } from './ConceptTerm';
import { SurfaceHelp } from './SurfaceHelp';

function renderWithI18n(ui: React.ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

afterEach(() => {
  registerAgentHandoffProvider(null);
  window.localStorage.clear();
});

describe('ConceptTerm', () => {
  it('renders a real button with the accessible name "Begriff X"; the body is behind the gesture', async () => {
    renderWithI18n(<p>Der <ConceptTerm k="vorsteuer" /> gilt.</p>);
    const term = screen.getByRole('button', { name: 'Begriff Vorsteuer' });
    // Row 8.1: no concept body string in the initially rendered DOM.
    expect(screen.queryByText(/Vorsteuer ist die MWST/)).not.toBeInTheDocument();
    await userEvent.click(term);
    expect(screen.getByRole('dialog', { name: 'Vorsteuer' })).toHaveTextContent(/Vorsteuer ist die MWST/);
  });

  it('seeAlso replaces the panel content IN PLACE; Esc returns to the ORIGINAL trigger; reopen starts fresh', async () => {
    renderWithI18n(<p><ConceptTerm k="saldosteuersatz" /></p>);
    const term = screen.getByRole('button', { name: 'Begriff Saldosteuersatz' });
    await userEvent.click(term);
    const dialog = screen.getByRole('dialog', { name: 'Saldosteuersatz' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Vorsteuer' }));
    // One dialog, new content, no stack.
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName('Vorsteuer');
    await userEvent.keyboard('{Escape}');
    expect(term).toHaveFocus();
    // Reopening starts at the term's own concept, not three seeAlso hops deep.
    await userEvent.click(term);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Saldosteuersatz');
  });

  it('an unknown key renders plain text with NO trigger (row 1.3: the failure is a build failure)', () => {
    renderWithI18n(<p><ConceptTerm k="no-such-concept" text="Wort" /></p>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Wort')).toBeInTheDocument();
  });

  it('emits NO handoff DOM with no A35 provider registered, and exactly one once one registers (rows 5.1/5.2)', async () => {
    const { unmount } = renderWithI18n(<p><ConceptTerm k="steuerperiode" /></p>);
    await userEvent.click(screen.getByRole('button', { name: 'Begriff Steuerperiode' }));
    expect(document.querySelector('.help-handoff')).toBeNull();
    unmount();

    const openWithDraft = vi.fn();
    registerAgentHandoffProvider({ label: 'Frag den Agenten', openWithDraft });
    renderWithI18n(<p><ConceptTerm k="steuerperiode" /></p>);
    await userEvent.click(screen.getByRole('button', { name: 'Begriff Steuerperiode' }));
    const handoff = screen.getByRole('button', { name: 'Frag den Agenten' });
    await userEvent.click(handoff);
    // Row 5.3: the panel closes in the same tick the handoff opens; the draft is unsent (a callback,
    // not a send), naming the concept.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openWithDraft).toHaveBeenCalledWith({ conceptKey: 'steuerperiode', term: 'Steuerperiode' });
  });

  it('requests no remote resource and writes nothing: no fetch, no img/iframe/font, no storage (§5c, §7b)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderWithI18n(<p><ConceptTerm k="bewilligung" /></p>);
    await userEvent.click(screen.getByRole('button', { name: 'Begriff Bewilligung der ESTV' }));
    const dialog = screen.getByRole('dialog');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dialog.querySelector('img, iframe, video, object, embed')).toBeNull();
    // The one outward affordance is an ANCHOR the user activates; nothing is prefetched.
    const link = within(dialog).getByRole('link');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(window.localStorage.length).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('SurfaceHelp', () => {
  it('a surface with no entry renders NO glyph at all (absence renders nothing)', () => {
    const { container } = renderWithI18n(<SurfaceHelp surface="NoSuchSurface" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a surface with an entry renders the glyph; its declared concepts replace content in place', async () => {
    renderWithI18n(<SurfaceHelp surface="VatSettings" />);
    const glyph = screen.getByRole('button', { name: 'Hilfe zu MWST-Einstellungen' });
    await userEvent.click(glyph);
    const dialog = screen.getByRole('dialog', { name: 'MWST-Einstellungen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Saldosteuersatz' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Saldosteuersatz');
    await userEvent.keyboard('{Escape}');
    expect(glyph).toHaveFocus();
  });
});
