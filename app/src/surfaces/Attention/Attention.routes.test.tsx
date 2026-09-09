/**
 * G15 story 2.3, at the app boundary: a hub row can never reach a Placeholder.
 *
 * The engine registration guard (`assertProvidersRegistrable`) refuses a provider whose deep link is
 * not in its `ROUTED_SURFACES` set; this test proves the app half, that each of those routes resolves
 * to a REAL built surface in the router (not the Placeholder). If a surface is ever un-wired, this
 * goes red with the route named, rather than a hub row silently opening a "coming soon" screen.
 */
import { describe, it, expect } from 'vitest';

import { BUILT_SURFACE_PATHS } from '../../app/router';

/** The owning-surface routes the five providers deep-link to (engine `ROUTED_SURFACES`, F-01 / F-07, G22). */
const PROVIDER_ROUTES = ['/reconciliation', '/dunning', '/agent', '/journal', '/checklisten'];

describe('G15 provider deep links resolve to built surfaces', () => {
  it('every attention provider route is a real built surface, never a Placeholder', () => {
    for (const route of PROVIDER_ROUTES) {
      expect(BUILT_SURFACE_PATHS).toContain(route);
    }
  });

  it('the old /inbox route is gone (absorbed into /attention, D-1)', () => {
    expect(BUILT_SURFACE_PATHS).not.toContain('/inbox');
    expect(BUILT_SURFACE_PATHS).toContain('/attention');
  });
});
