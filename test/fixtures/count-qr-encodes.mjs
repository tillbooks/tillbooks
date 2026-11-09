// A module-load hook that COUNTS calls into the QR encoder without replacing it.
//
// Why a loader and not a stub. The root suites run against the built `dist/` tree as real ESM, where
// an exported binding cannot be reassigned from the outside, so there is no way to wrap
// `encodeQrByteMode` after the fact. The hook rewrites the module's SOURCE at load time: the real
// function is renamed and kept, and a same-named wrapper takes its place, increments a counter and
// DELEGATES to it. Nothing about the symbol changes, so every drawing assertion in the suite that
// registers this hook is still an assertion about the engine's own output.
//
// The counter lives on `globalThis` because the transformed module executes on the main thread while
// the hook itself runs on the loader thread: the shared surface between them is the code text, not a
// variable. `readEncodeCount` / `resetEncodeCount` in the test file read that same global.
//
// Scope: this file is only loaded by a test that calls `module.register` on it, and `node --test`
// runs every test file in its own process, so no other suite sees the instrumented encoder.

const TARGET = 'dist/core/sales/qrcode.js';

/** The name the real implementation is moved to. Anything unlikely to collide will do. */
const REAL = '__tillCountedRealEncodeQrByteMode';

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith(TARGET)) return result;

  const source = String(result.source);
  const declaration = 'export function encodeQrByteMode(data) {';
  if (!source.includes(declaration)) {
    // Fail loudly rather than silently counting nothing: a test whose counter is stuck at zero
    // because the rename missed would read as a pass.
    throw new Error(`count-qr-encodes: could not find "${declaration}" in ${url}`);
  }

  // The wrapper is a hoisted function declaration, so calls made from INSIDE this module (the
  // `encodeText` helper) route through it too, rather than quietly skipping the counter.
  const instrumented =
    source.replace(declaration, `function ${REAL}(data) {`) +
    `\nexport function encodeQrByteMode(data) {\n` +
    `  globalThis.__tillQrEncodeCount = (globalThis.__tillQrEncodeCount ?? 0) + 1;\n` +
    `  return ${REAL}(data);\n` +
    `}\n`;

  return { ...result, source: instrumented };
}
