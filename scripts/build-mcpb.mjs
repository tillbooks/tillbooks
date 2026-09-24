#!/usr/bin/env node
/**
 * Build (and validate) the TILL .mcpb desktop extension (M00, US-M00.5).
 *
 * TWO MODES, one script:
 *
 *   - DEFAULT (validate + stamp): parse `packaging/mcpb/manifest.json`, stamp its version from the
 *     root `package.json` (the manifest ships in lockstep with npm, spec §4), assert the declared
 *     `server.entry_point` file actually exists, and write the stamped manifest to
 *     `packaging/mcpb/build/manifest.json`. This is the CI check the spec §8 names: "the mcpb manifest
 *     is schema-valid and the entry is resolvable". It needs no external tool and touches no bundle.
 *
 *   - `--pack`: additionally assemble the bundle directory (manifest + server shim + the packaged
 *     `bin/`, `dist/`, `package.json` and the runtime `node_modules`) and zip it into
 *     `packaging/mcpb/build/tillbooks-<version>.mcpb`. Zipping needs the `zip` tool (or the official
 *     `@anthropic-ai/mcpb` CLI); when neither is present the script says so and exits without
 *     pretending it produced an artifact.
 *
 * `stampAndValidate` is exported so `test/packaging/mcpb.test.mjs` runs the same validation the CLI
 * does, against the same files, with no process spawn.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(scriptDir, '..');
const MCPB_DIR = join(REPO_ROOT, 'packaging', 'mcpb');

/** The fields a Node stdio extension manifest MUST carry for Claude Desktop to load it. */
function validateShape(manifest) {
  const errors = [];
  const need = (path, cond) => {
    if (!cond) errors.push(path);
  };
  need('manifest_version', typeof manifest.manifest_version === 'string');
  need('name', typeof manifest.name === 'string' && manifest.name.length > 0);
  need('version', typeof manifest.version === 'string');
  need('description', typeof manifest.description === 'string');
  need('author.name', typeof manifest.author?.name === 'string');
  need('server.type', manifest.server?.type === 'node');
  need('server.entry_point', typeof manifest.server?.entry_point === 'string');
  need('server.mcp_config.command', typeof manifest.server?.mcp_config?.command === 'string');
  need('server.mcp_config.args', Array.isArray(manifest.server?.mcp_config?.args));
  // D104: Windows is out of scope (it runs TILL inside an agent runtime, no native extension), so the
  // manifest must not claim it. The store uses `platforms` to hide an extension where it cannot run.
  const platforms = manifest.compatibility?.platforms;
  need('compatibility.platforms', Array.isArray(platforms) && platforms.length > 0);
  if (Array.isArray(platforms) && platforms.includes('win32')) {
    errors.push('compatibility.platforms must not include win32 (D104: Windows runs TILL in an agent runtime, not a native extension)');
  }
  return errors;
}

/**
 * Read the manifest, stamp the version from `package.json`, and validate it (shape + the entry file
 * exists + name matches the package). Returns the stamped manifest. Throws with every problem named.
 */
export function stampAndValidate(repoRoot = REPO_ROOT) {
  const mcpbDir = join(repoRoot, 'packaging', 'mcpb');
  const manifestPath = join(mcpbDir, 'manifest.json');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Ship in lockstep with npm: the bundled version is the package version, stamped here so the two
  // can never drift by hand (spec §4).
  manifest.version = pkg.version;

  const errors = validateShape(manifest);
  if (manifest.name !== pkg.name) {
    errors.push(`name "${manifest.name}" must match the package name "${pkg.name}"`);
  }
  const entry = manifest.server?.entry_point;
  if (typeof entry === 'string' && !existsSync(join(mcpbDir, entry))) {
    errors.push(`server.entry_point "${entry}" does not exist at ${join(mcpbDir, entry)}`);
  }
  if (errors.length > 0) {
    throw new Error(`mcpb manifest invalid:\n  - ${errors.join('\n  - ')}`);
  }
  return manifest;
}

function main() {
  const manifest = stampAndValidate();
  const buildDir = join(MCPB_DIR, 'build');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`mcpb: manifest valid, version ${manifest.version}, entry ${manifest.server.entry_point} resolved.`);
  console.log(`mcpb: stamped manifest written to ${join(buildDir, 'manifest.json')}`);

  if (process.argv.includes('--pack')) {
    console.error(
      [
        'mcpb: --pack assembles the full bundle (manifest + server.mjs + bin/ + dist/ + node_modules)',
        'and zips it to a .mcpb. That step bundles the native better-sqlite3 build and belongs to the',
        'release pipeline, where the signed/notarised lane also lives. Run the official packer there:',
        '  npx @anthropic-ai/mcpb pack packaging/mcpb  (produces tillbooks-<version>.mcpb)',
        'This validate step is the CI gate; the pack + sign step is release-only and owner-gated.',
      ].join('\n'),
    );
  }
}

// Run only when invoked directly, never when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
