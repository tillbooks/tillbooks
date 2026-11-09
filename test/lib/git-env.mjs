/**
 * The environment every test runs git with: scripts/lib/git-env.mjs's `gitEnv` (the inherited
 * environment minus every GIT_* variable that can point git at a repository or change its
 * configuration; identity and transport kept), plus what the test passes in `extra`. The why lives
 * there: inside a git hook a test's `git init <tmp>` otherwise rewrites the REAL repository.
 * test/style/tests-run-git-with-a-clean-env.test.mjs enforces that every test uses it.
 */

import { gitEnv } from '../../scripts/lib/git-env.mjs';

/**
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function cleanGitEnv(extra = {}) {
  return gitEnv(extra);
}

/** Config for throwaway repositories: never signed (commits nor tags), never hooked, first branch develop. */
export const TEMP_REPO_GIT = {
  GIT_AUTHOR_NAME: 'till-test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'till-test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null',
  GIT_CONFIG_KEY_3: 'init.defaultBranch', GIT_CONFIG_VALUE_3: 'develop',
};
