/**
 * `displayName` (K-38, D137): a seat or an actor is never shown as its raw id.
 *
 * Asserted against the real locale catalogue (through the provider), so a label that is not in both
 * locales fails here rather than on a surface.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { I18nProvider, useT, type Locale } from '../i18n';
import { displayName, type SeatMember } from './displayName';

function tFor(locale: Locale) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider initialLocale={locale}>{children}</I18nProvider>
  );
  return renderHook(() => useT(), { wrapper }).result.current;
}

const ROSTER: SeatMember[] = [
  { userId: 'user_1', actorId: 'studio', displayName: null, email: null },
  { userId: 'user_2', actorId: null, displayName: 'Anna Muster', email: 'anna@example.ch' },
  { userId: 'user_3', actorId: null, displayName: '', email: 'beat@example.ch' },
  { userId: 'user_4', actorId: 'agent', displayName: null, email: null },
  { userId: 'user_5', actorId: 'treuhand:mueller', displayName: null, email: null },
];

describe('displayName, with a roster', () => {
  const t = tFor('de-CH');

  it('a member with a name reads as the name, the id kept beside it', () => {
    expect(displayName('user_2', ROSTER, t)).toEqual({ id: 'user_2', label: 'Anna Muster', resolved: true });
  });

  it('a member with only an email reads as the email', () => {
    expect(displayName('user_3', ROSTER, t).label).toBe('beat@example.ch');
  });

  it('a seated actor with neither reads as its seat, matched by user id or by actor id', () => {
    expect(displayName('user_1', ROSTER, t).label).toBe('Studio auf diesem Gerät');
    expect(displayName('studio', ROSTER, t).label).toBe('Studio auf diesem Gerät');
    expect(displayName('user_4', ROSTER, t).label).toBe('MCP-Agent');
  });

  it('any other nameless member reads as this installation', () => {
    expect(displayName('user_5', ROSTER, t).label).toBe('Diese Installation');
  });
});

describe('displayName, without a roster entry', () => {
  const t = tFor('de-CH');

  it('names the seated actors, numbers the minted users, and never prints the raw id', () => {
    expect(displayName('agent', [], t).label).toBe('MCP-Agent');
    expect(displayName('user_7', [], t)).toEqual({ id: 'user_7', label: 'Person 7', resolved: false });
    expect(displayName('contact.created', [], t).label).toBe('Unbekannte Person');
    for (const id of ['user_1', 'user_42', 'studio', 'agent', 'something_else']) {
      expect(displayName(id, [], t).label).not.toBe(id);
      expect(displayName(id, [], t).label).not.toMatch(/user_\d+/);
    }
  });

  it('an absent id is an empty label, not a placeholder', () => {
    expect(displayName(null, ROSTER, t)).toEqual({ id: '', label: '', resolved: false });
    expect(displayName(undefined, ROSTER, t).label).toBe('');
    expect(displayName('', ROSTER, t).label).toBe('');
  });
});

describe('displayName, in English', () => {
  const t = tFor('en');

  it('speaks the English seat labels', () => {
    expect(displayName('studio', [], t).label).toBe('Studio on this machine');
    expect(displayName('agent', [], t).label).toBe('MCP agent');
    expect(displayName('user_5', ROSTER, t).label).toBe('This installation');
    expect(displayName('user_9', [], t).label).toBe('Person 9');
    expect(displayName('x', [], t).label).toBe('Unknown person');
  });
});
