/**
 * The environment every git call of this repository's tooling and tests runs with: the inherited one
 * minus every GIT_* variable that can point git at a repository or change its configuration.
 *
 * WHY. Inside a git hook, git exports GIT_DIR (and may export GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_QUARANTINE_PATH,
 * GIT_CONFIG* ...). A git that inherits them works on THAT repository whatever its cwd or `-C` says,
 * so a throwaway `git init` or `git config` started under a hook rewrites the real repository. Every
 * git call names its repository by cwd or `-C` and runs with this environment
 * (test/style/tests-run-git-with-a-clean-env.test.mjs enforces it).
 *
 * Kept, because neither can point git at another repository: identity (GIT_AUTHOR_*,
 * GIT_COMMITTER_*) and transport (GIT_SSH*, GIT_ASKPASS, GIT_TERMINAL_PROMPT, GIT_PROXY_COMMAND,
 * GIT_HTTP_USER_AGENT).
 */

export const KEEP_GIT_VARIABLE = /^GIT_(AUTHOR_|COMMITTER_|SSH|ASKPASS$|TERMINAL_PROMPT$|PROXY_COMMAND$|HTTP_USER_AGENT$)/;

/**
 * `env` (default: this process's) without the repository-locating GIT_* variables, plus `extra`.
 * @param {Record<string, string>} [extra]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function gitEnv(extra = {}, env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith('GIT_') && !KEEP_GIT_VARIABLE.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}
