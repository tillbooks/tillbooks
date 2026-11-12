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
 *   - `--pack [--tgz <tillbooks-x.y.z.tgz>]`: additionally assemble the bundle and zip it into
 *     `packaging/mcpb/build/tillbooks-<version>.mcpb` (plus `.sha256`). The bundle is the npm package
 *     itself, unpacked: `package.json`, `bin/`, `dist/`, and its production `node_modules` installed
 *     from the root `package-lock.json`, with the stamped `manifest.json` and the `server.mjs` shim
 *     beside them. `--tgz` packs from a tarball that was already verified (the release passes the one
 *     it published to npm, so the extension carries exactly those bytes); without it the script runs
 *     `npm pack` of this tree. better-sqlite3 ships N-API prebuilds for every platform; only those of
 *     the manifest's `compatibility.platforms` stay (linux keeps its musl builds too), and its C
 *     sources go. Before zipping, the script STARTS the bundled server the way Claude Desktop does
 *     (`node server.mjs` over stdio, a throwaway database and support directory) and requires that
 *     `initialize` names this version and that `tools/list` answers. Zipping uses the system `zip`.
 *
 * `stampAndValidate` and `keptPrebuilds` are exported so `test/packaging/mcpb.test.mjs` runs the same
 * logic the CLI does, against the same files, with no process spawn.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, copyFileSync, mkdtempSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
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

/**
 * The better-sqlite3 prebuilds (`<platform>-<arch>.node`) a bundle for `platforms` keeps. A linux
 * bundle keeps the musl builds too: better-sqlite3 loads `linuxmusl-<arch>` on Alpine and the like.
 */
export function keptPrebuilds(platforms, names) {
  const wanted = new Set(platforms.flatMap((p) => (p === 'linux' ? ['linux', 'linuxmusl'] : [p])));
  return names.filter((name) => wanted.has(name.replace(/-[^-]+\.node$/, '')));
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `npm pack` of this tree into `dest`, or the given tarball; returns the tarball path. */
function tarball(dest, given) {
  if (given) {
    const tgz = resolve(given);
    if (!existsSync(tgz)) throw new Error(`mcpb: --tgz ${tgz} does not exist`);
    return tgz;
  }
  console.log('mcpb: npm pack (prepack builds dist/)');
  const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', dest], { cwd: REPO_ROOT, encoding: 'utf8' });
  const tgz = join(dest, out.trim().split('\n').pop());
  if (!existsSync(tgz)) throw new Error(`mcpb: npm pack did not produce a tarball (${tgz})`);
  return tgz;
}

/**
 * Start the bundled server the way Claude Desktop does and ask it who it is. The database and the
 * support directory are throwaway paths (and HOME with them), so the smoke never opens a real book.
 */
async function smoke(bundle, manifest) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const scratch = mkdtempSync(join(tmpdir(), 'till-mcpb-smoke-'));
  mkdirSync(join(scratch, 'support'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(bundle, manifest.server.entry_point)],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: scratch,
      TILL_DB_PATH: join(scratch, 'smoke.till.db'),
      TILL_SUPPORT_DIR: join(scratch, 'support'),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'till-mcpb-smoke', version: manifest.version });
  try {
    await client.connect(transport);
    const info = client.getServerVersion();
    if (info?.name !== manifest.name || info?.version !== manifest.version) {
      throw new Error(`mcpb: the bundled server says ${JSON.stringify(info)}, expected ${manifest.name} ${manifest.version}`);
    }
    let tools = 0;
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools += page.tools.length;
      cursor = page.nextCursor;
    } while (cursor);
    if (tools === 0) throw new Error('mcpb: the bundled server lists no tools');
    // The manifest's description names a tool count; the bundle must serve exactly that many.
    const claimed = Number(/(\d+) MCP tools/.exec(manifest.description)?.[1]);
    if (Number.isFinite(claimed) && claimed !== tools) {
      throw new Error(`mcpb: the manifest says ${claimed} MCP tools, the bundled server lists ${tools}`);
    }
    console.log(`mcpb: smoke: ${info.name} ${info.version} over stdio, ${tools} tools`);
  } catch (e) {
    if (stderr) process.stderr.write(stderr);
    throw e;
  } finally {
    await client.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function pack(manifest, buildDir, givenTgz) {
  const bundle = join(buildDir, 'bundle');
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });

  const tgz = tarball(buildDir, givenTgz);
  execFileSync('tar', ['-xzf', tgz, '-C', bundle, '--strip-components', '1']);
  const packed = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'));
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    throw new Error(`mcpb: ${basename(tgz)} is ${packed.name}@${packed.version}, the manifest is ${manifest.name}@${manifest.version}`);
  }
  if (!existsSync(join(bundle, 'bin', 'till.mjs')) || !existsSync(join(bundle, 'dist', 'api', 'mcp.js'))) {
    throw new Error(`mcpb: ${basename(tgz)} carries no bin/till.mjs or dist/api/mcp.js`);
  }

  console.log('mcpb: installing production dependencies from package-lock.json');
  copyFileSync(join(REPO_ROOT, 'package-lock.json'), join(bundle, 'package-lock.json'));
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: bundle,
    stdio: 'inherit',
  });
  rmSync(join(bundle, 'package-lock.json'));

  // Only the prebuilds of the platforms the manifest claims; no C sources, no build tree.
  const bsq = join(bundle, 'node_modules', 'better-sqlite3');
  const prebuilds = join(bsq, 'prebuilds');
  const all = readdirSync(prebuilds);
  const keep = keptPrebuilds(manifest.compatibility.platforms, all);
  for (const platform of manifest.compatibility.platforms) {
    if (!keep.some((name) => name.startsWith(`${platform}-`))) {
      throw new Error(`mcpb: better-sqlite3 carries no ${platform} prebuild; the extension would not open a book there`);
    }
  }
  for (const name of all) if (!keep.includes(name)) rmSync(join(prebuilds, name));
  for (const dir of ['deps', 'src', 'build']) rmSync(join(bsq, dir), { recursive: true, force: true });
  console.log(`mcpb: better-sqlite3 prebuilds kept: ${keep.join(', ')}`);

  writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  copyFileSync(join(MCPB_DIR, manifest.server.entry_point), join(bundle, manifest.server.entry_point));

  await smoke(bundle, manifest);

  const out = join(buildDir, `${manifest.name}-${manifest.version}.mcpb`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', out, '.'], { cwd: bundle });
  const digest = sha256(out);
  writeFileSync(`${out}.sha256`, `${digest}  ${basename(out)}\n`, 'utf8');
  const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`mcpb: packed ${out} (${mb} MB, sha256 ${digest})`);
}

async function main() {
  const manifest = stampAndValidate();
  const buildDir = join(MCPB_DIR, 'build');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`mcpb: manifest valid, version ${manifest.version}, entry ${manifest.server.entry_point} resolved.`);
  console.log(`mcpb: stamped manifest written to ${join(buildDir, 'manifest.json')}`);

  if (process.argv.includes('--pack')) {
    const at = process.argv.indexOf('--tgz');
    await pack(manifest, buildDir, at > 0 ? process.argv[at + 1] : undefined);
  }
}

// Run only when invoked directly, never when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
