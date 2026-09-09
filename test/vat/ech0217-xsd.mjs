/**
 * The eCH-0217 export's offline XSD validator.
 *
 * The engine was factored out to `test/lib/xsd.mjs` so a second money-path export (the SIX pain.001
 * bank file) could reuse the same schema-walking validator rather than growing a second one. This
 * module is now a thin re-export: `ech0217-export.test.mjs` keeps importing `parseXml`, `loadSchemas`
 * and `validateXml` from here, and their behaviour is byte-for-byte the shared engine's. The engine's
 * header explains why it exists, what the subset covers, and how its teeth are proven.
 */

export { parseXml, loadSchemas, validateXml } from '../lib/xsd.mjs';
