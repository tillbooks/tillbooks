/**
 * The SYNTHETIC SEED registry (D-ENV-8): what fills a `synthetic` environment's data root.
 *
 * A seed is a function that populates a fresh SQLite file at a given path and THROWS on failure (so
 * `env_reset`'s build-then-swap can leave the prior env intact, matrix E3a). The default seed is the
 * Seeblick golden ledger (`scripts/seed-demo-rich.mjs`, driven through the public API), per D-ENV-8;
 * `minimal` is a schema-only empty ledger, the fast, dependency-free choice a gate or a test selects.
 * The seed is SELECTABLE per environment (the concept's "keep the seed selectable via an input
 * field"), so this registry is the vocabulary the `seed` input is validated against.
 *
 * The registry is INJECTABLE (it rides `LandscapeDeps`), which is what keeps the engine testable: a
 * unit test hands in a fast in-process seed (or a deliberately failing one) rather than shelling out
 * to the heavy Seeblick script, and only real use pays for the golden ledger.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SqliteStore } from '../store/sqlite-store.js';

/** Populate the SQLite file at `targetDbPath`. Throws on any failure (the build-then-swap contract). */
export type Seeder = (targetDbPath: string) => void;

/** name -> seeder. The `seed` input names one of these; an unknown name is refused. */
export type SeederRegistry = Readonly<Record<string, Seeder>>;

/** The default seed name (D-ENV-8: the Seeblick golden ledger is the default synthetic seed). */
export const DEFAULT_SEED = 'seeblick';

/**
 * A schema-only empty ledger: open a store at the path (which applies `SCHEMA_SQL` + the additive
 * schema) and close it. Fast, in-process, no build required. This is the seed a gate/test selects.
 */
export const minimalSeeder: Seeder = (targetDbPath) => {
  const store = new SqliteStore({ location: targetDbPath });
  store.close();
};

/**
 * The Seeblick golden ledger, produced by driving `scripts/seed-demo-rich.mjs` over the public API
 * against the target file. Requires `dist/` to be built (the script imports the compiled engine), so
 * it throws a clear error when the script or the build is absent rather than seeding a half-ledger.
 */
export function makeSeeblickSeeder(repoRoot: string): Seeder {
  return (targetDbPath) => {
    const script = join(repoRoot, 'scripts', 'seed-demo-rich.mjs');
    if (!existsSync(script)) {
      throw new Error(`seeblick seed unavailable: ${script} not found`);
    }
    if (!existsSync(join(repoRoot, 'dist', 'api', 'rest.js'))) {
      throw new Error('seeblick seed unavailable: dist/ not built (run `npm run build` first)');
    }
    execFileSync(process.execPath, [script, '--reset'], {
      env: { ...process.env, TILL_DB_PATH: targetDbPath },
      stdio: 'pipe',
    });
  };
}

/** The default registry: `seeblick` (golden ledger, needs a build) plus `minimal` (schema-only). */
export function defaultSeeders(repoRoot: string): SeederRegistry {
  return { seeblick: makeSeeblickSeeder(repoRoot), minimal: minimalSeeder };
}
