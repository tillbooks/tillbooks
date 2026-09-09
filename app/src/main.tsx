import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import './styles/global.css';
import { TillClientProvider } from './lib/client-context';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './app/theme';
import { DensityProvider } from './app/density';
import { WorkspaceProvider } from './app/workspace';
import { FeedbackProvider } from './components/FeedbackProvider';
import { ErrorBoundary } from './app/ErrorBoundary';
import { captureInviteDeepLink } from './app/identity';
import { router } from './app/router';

// M03 invite (N4b): capture `?invite=<token>` BEFORE the router renders. The index route redirects
// `/` to the first rail surface with a string `to` and `replace`, which drops the query string, so
// a mount-time read would always find the token already gone. The capture stashes the token for the
// not-a-member page's prefill and strips it from the URL in the same breath (token hygiene: a
// bearer-shaped token must not linger in browser history). Prefill only: nothing auto-redeems.
captureInviteDeepLink();

const root = document.getElementById('root');
if (!root) throw new Error('No #root element. index.html is the only place it should come from.');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <DensityProvider>
        <TillClientProvider>
          <I18nProvider>
            <WorkspaceProvider>
              {/* The feedback context sits OUTSIDE the boundary on purpose: a render throw must not
                  take the thing that reports it with it. The boundary then wraps the router, so a
                  throw inside any surface lands on a recoverable panel instead of blanking the
                  document, which is what happens today. */}
              <FeedbackProvider>
                <ErrorBoundary>
                  <RouterProvider router={router} />
                </ErrorBoundary>
              </FeedbackProvider>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </DensityProvider>
    </ThemeProvider>
  </StrictMode>,
);
