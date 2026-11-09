/**
 * G08-G1, the regression test for the blocker the /ux-architect gate found.
 *
 * `ErrorBoundary.test.tsx` mounts the boundary directly around a throwing child and passes. The real
 * application never has that arrangement: the boundary wraps `<RouterProvider>` from the OUTSIDE, and
 * React Router catches a route render throw first. So a real crash rendered the router's own
 * developer page ("Unexpected Application Error!", an English stack, a note addressed to "Hey
 * developer") and US-G08.7 could not complete, while every test stayed green.
 *
 * These two tests are written to fail in exactly that situation:
 *   1. structurally, every route must carry an `errorElement`, so a new surface cannot be added
 *      without one and quietly reintroduce the developer page;
 *   2. behaviourally, a throw inside a route must render OUR panel and must NOT render the router's.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';

import { allowConsole } from '../test-console';
import { I18nProvider } from '../i18n';
import { RouteCrash } from './ErrorBoundary';
import { routes } from './router';

/** Walk the route tree, so a nested child cannot slip through unguarded. */
function everyRoute(list: readonly RouteObject[]): RouteObject[] {
  return list.flatMap((route) => [route, ...everyRoute(route.children ?? [])]);
}

function Throws(): never {
  throw new Error('Beratung Müller AG 1234.55');
}

describe('the router hands a crash to G08, not to its own developer page', () => {
  beforeEach(() => {
    // React and the router both log a caught render throw. That is the situation under test, not
    // stray noise, so it is opted in explicitly rather than by widening the global guard.
    allowConsole(/Throws|The above error occurred|Uncaught \[|React Router caught/);
  });

  it('every route carries an errorElement, so no surface can reintroduce the developer page', () => {
    // An index route redirecting elsewhere has nothing of its own to throw, so it is exempt.
    const unguarded = everyRoute(routes)
      .filter((route) => route.index !== true)
      .filter((route) => route.errorElement === undefined);
    expect(unguarded.map((r) => r.path ?? '(pathless)')).toEqual([]);
  });

  it('a throw inside a route renders the crash panel and never the router default', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <Throws />, errorElement: <RouteCrash /> }],
      { initialEntries: ['/'] },
    );
    render(
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>,
    );

    expect(await screen.findByText(/Dieser Bildschirm funktioniert nicht mehr|This screen stopped working/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /neu laden|reload/i })).toBeInTheDocument();
    // The exact strings the user was getting instead, in the language they were getting them in.
    expect(screen.queryByText(/Unexpected Application Error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hey developer/i)).not.toBeInTheDocument();
  });

  it('the crash panel never shows the exception message, which is where the books leak', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <Throws />, errorElement: <RouteCrash /> }],
      { initialEntries: ['/'] },
    );
    const { container } = render(
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>,
    );
    await screen.findByText(/Dieser Bildschirm funktioniert nicht mehr|This screen stopped working/);
    for (const secret of ['Müller', 'Beratung', '1234.55']) {
      expect(container.textContent ?? '').not.toContain(secret);
    }
  });
});
