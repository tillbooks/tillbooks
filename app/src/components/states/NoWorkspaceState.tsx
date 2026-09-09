/**
 * The no-workspace state: what a surface renders before a workspace exists.
 *
 * Every ctx verb needs a `workspaceId`, so a surface with none can show nothing. That is not a
 * licence to leave the operator standing in front of a wall: this state always carries the way out,
 * a link to `/setup`, so no surface is ever a dead end. Surfaces pass their own one-line reason
 * ("um Konten zu verwalten"); the headline and the action are shared so the way out reads the same
 * everywhere.
 */
import { useT } from '../../i18n';
import { EmptyState } from './EmptyState';

export interface NoWorkspaceStateProps {
  /** Why this surface needs a workspace. Defaults to the generic sentence. */
  body?: string;
}

export function NoWorkspaceState({ body }: NoWorkspaceStateProps) {
  const t = useT();
  return (
    <EmptyState
      title={t('states.noWorkspace.title')}
      hint={body ?? t('states.noWorkspace.body')}
      action={{ label: t('states.noWorkspace.action'), to: '/setup' }}
    />
  );
}
