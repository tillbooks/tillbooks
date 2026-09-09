#!/usr/bin/env node
/**
 * The .mcpb entry shim (M00, US-M00.5).
 *
 * Claude Desktop launches this as a stdio subprocess and pipes JSON-RPC over stdin/stdout. It is the
 * SAME thing `till mcp` does, so rather than fork a second startup path this shim re-execs the
 * package's own `bin/till.mjs mcp`, inheriting stdio and the environment (TILL_DB_PATH,
 * TILL_SUPPORT_DIR, which the manifest fills from the user-config surface). One startup path means the
 * WAL-checkpoint-on-close behaviour and the F12 pinned-agent-actor posture are shared, not duplicated.
 *
 * WHY NOT IMPORT dist/api/mcp.js DIRECTLY. The transport binds to the child's stdio; re-execing the
 * bin keeps this shim independent of the compiled module layout inside the bundle, so a change to
 * where `startMcpServer` lives cannot silently break the extension while the CLI still works.
 *
 * The bundle produced by `scripts/build-mcpb.mjs` places this file NEXT TO the packaged `tillbooks`
 * package (bin/ + dist/ + node_modules/), so `bin/till.mjs` is resolved relative to `__dirname`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'bin', 'till.mjs');

const child = spawn(process.execPath, [bin, 'mcp'], { stdio: 'inherit' });

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  process.stderr.write(`till mcpb: failed to start the TILL MCP server: ${err.message}\n`);
  process.exit(1);
});
