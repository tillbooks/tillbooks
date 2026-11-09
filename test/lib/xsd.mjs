/**
 * An offline, subset XSD validator, driven by REAL vendored schema files rather than a transcription.
 *
 * This is the SHARED engine. It began life as `test/vat/ech0217-xsd.mjs` (which now re-exports from
 * here so its behaviour is unchanged) and was factored out so a second money-path export could reuse
 * it: the SIX pain.001.001.09.ch.03 schema, validated the same way the eCH-0217 export is.
 *
 * WHY THIS EXISTS AT ALL. A08's export layer once shipped a defect where `pdf.includes(...)` passed
 * while the content was drawn off the page: the string was in the file and not on the page. The
 * analogue for an XML export is a document that carries every right element in the wrong structure,
 * and `xml.includes('<...>')` is exactly as blind to it. These content models are `xs:sequence`, so
 * ORDER is normative, and a substring assertion cannot see the difference. So the generated file is
 * validated, against the schema, by walking the schema.
 *
 * WHY NOT A LIBRARY. This repo has two runtime dependencies and its suites run offline. A native
 * libxml binding for one test is a poor trade, and fetching an XSD at test time would make the suite
 * need the network. So the schema documents are VENDORED verbatim (eCH-0217 under
 * `test/vat/fixtures/ech0217/`, SIX pain.001 under `test/banking/fixtures/xsd/`) and callers pass
 * their paths in. It is a SUBSET validator: it implements what those documents actually use, and it
 * THROWS on any schema construct it does not implement rather than passing it silently, so the subset
 * can never quietly grow past what it checks.
 *
 * WHAT THE SUBSET COVERS. Simple types (facet chains down to a primitive, with xs:token whiteSpace
 * collapse); complexType content models expressed as a DIRECT `xs:sequence`/`xs:choice`, as
 * `xs:complexContent > xs:restriction` (the SIX CH schema's shape, ~50x: the restriction fully
 * restates the model, so its own sequence/choice is the effective one), and as
 * `xs:simpleContent > xs:extension`/`xs:restriction` (text validated as the base simple type PLUS the
 * declared `xs:attribute`, e.g. the amount `Ccy`); `xs:any` (accept any children here); and
 * `xs:attribute`. Patterns are translated from XSD (.NET) regex to JS where the two disagree
 * (Unicode block names, character-class subtraction), throwing on any construct not translated.
 *
 * WHY IT IS NOT SELF-GRADING. A validator that accepts everything makes every document valid. Its
 * teeth are proven by negative controls in `test/vat/ech0217-export.test.mjs` and
 * `test/banking/pain001-zkb-validation.test.mjs`: the official/generated documents must PASS, and a
 * set of deliberate mutations (two children swapped, a required child dropped, an out-of-facet value,
 * a corrupt IBAN) must each FAIL and name the fault. When `xmllint` is on the machine, the same
 * documents are also run through libxml2 as an independent second opinion.
 *
 * Not production code.
 */

import { readFileSync } from 'node:fs';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

// --- A minimal namespace-aware XML parser ------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (whole, ref) => {
    if (ref in ENTITIES) return ENTITIES[ref];
    if (ref.startsWith('#x') || ref.startsWith('#X')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return whole;
  });
}

/**
 * Parse a document into `{ ns, local, attrs, prefixes, children, text }` nodes.
 *
 * `prefixes` is the in-scope prefix map AT that element, which is what lets a QName inside an
 * attribute value (`type="eCH-0217:amountType"`) be resolved the way XML says it must be: by the
 * declarations in scope where it is written, never by the prefix string alone.
 */
export function parseXml(text) {
  let i = 0;
  const stack = [];
  let root = null;

  const skipTo = (marker) => {
    const at = text.indexOf(marker, i);
    if (at === -1) throw new Error(`parseXml: unterminated ${marker} near offset ${i}`);
    i = at + marker.length;
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) {
      const chunk = text.slice(i, lt);
      if (stack.length > 0 && chunk.trim().length > 0) {
        stack[stack.length - 1].text += unescapeXml(chunk);
      }
      i = lt;
    }
    if (text.startsWith('<?', i)) {
      skipTo('?>');
      continue;
    }
    if (text.startsWith('<!--', i)) {
      skipTo('-->');
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      if (end === -1) throw new Error('parseXml: unterminated CDATA');
      if (stack.length > 0) stack[stack.length - 1].text += text.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      skipTo('>');
      continue;
    }
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end === -1) throw new Error('parseXml: unterminated end tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (open === undefined) throw new Error(`parseXml: stray end tag </${name}>`);
      if (open.rawName !== name) throw new Error(`parseXml: </${name}> closes <${open.rawName}>`);
      i = end + 1;
      continue;
    }

    // A start tag. Scan to the matching '>' without being fooled by a '>' inside an attribute.
    let j = i + 1;
    let quote = null;
    while (j < text.length) {
      const ch = text[j];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j += 1;
    }
    if (j >= text.length) throw new Error('parseXml: unterminated start tag');
    let inner = text.slice(i + 1, j);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);

    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (nameMatch === null) throw new Error(`parseXml: unnamed element near offset ${i}`);
    const rawName = nameMatch[1];
    const rawAttrs = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(inner.slice(rawName.length))) !== null) {
      rawAttrs[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
    }

    const parent = stack[stack.length - 1];
    const prefixes = { ...(parent?.prefixes ?? {}) };
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === 'xmlns') prefixes[''] = v;
      else if (k.startsWith('xmlns:')) prefixes[k.slice(6)] = v;
    }

    const colon = rawName.indexOf(':');
    const prefix = colon === -1 ? '' : rawName.slice(0, colon);
    const local = colon === -1 ? rawName : rawName.slice(colon + 1);
    const ns = prefixes[prefix] ?? '';
    if (colon !== -1 && prefixes[prefix] === undefined) {
      throw new Error(`parseXml: undeclared prefix "${prefix}" on <${rawName}>`);
    }

    const attrs = {};
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      attrs[k.includes(':') ? k.slice(k.indexOf(':') + 1) : k] = v;
    }

    const node = { rawName, ns, local, attrs, prefixes, children: [], text: '' };
    if (parent !== undefined) parent.children.push(node);
    else if (root === null) root = node;
    else throw new Error(`parseXml: a second root element <${rawName}>`);

    if (!selfClosing) stack.push(node);
    i = j + 1;
  }

  if (stack.length > 0) throw new Error(`parseXml: <${stack[stack.length - 1].rawName}> was never closed`);
  if (root === null) throw new Error('parseXml: no root element');
  return root;
}

// --- Loading the schema documents ---------------------------------------------------------------

/** Resolve a QName written inside `node` (an attribute value) against that node's prefix scope. */
function resolveQName(node, value) {
  const colon = value.indexOf(':');
  const prefix = colon === -1 ? '' : value.slice(0, colon);
  const local = colon === -1 ? value : value.slice(colon + 1);
  const ns = node.prefixes[prefix];
  if (ns === undefined) throw new Error(`schema: undeclared prefix "${prefix}" in QName "${value}"`);
  return `{${ns}}${local}`;
}

const kids = (node, local) => node.children.filter((c) => c.ns === XSD_NS && c.local === local);
const kid = (node, local) => kids(node, local)[0];

/**
 * Load one or more `.xsd` files into a single lookup.
 *
 * `xs:import` is honoured by NAMESPACE only: every schema this needs is passed in explicitly, so
 * nothing here ever reaches the network for a `schemaLocation`. An import naming a namespace no
 * passed file declares is an error, never a silently unchecked element.
 */
export function loadSchemas(paths) {
  const elements = new Map();
  const types = new Map();
  const namespaces = new Set();
  const imported = new Set();

  for (const path of paths) {
    const doc = parseXml(readFileSync(path, 'utf8'));
    if (doc.ns !== XSD_NS || doc.local !== 'schema') throw new Error(`${path}: not an xs:schema`);
    const target = doc.attrs.targetNamespace ?? '';
    // All three vendored schemas are elementFormDefault="qualified", so a LOCAL element sits in the
    // namespace of the schema that DECLARES it, not of the document being validated. That is not a
    // detail: `sendingApplication` is an eCH-0217 element whose type is eCH-0058's, and its three
    // children are therefore eCH-0058 elements. Stamping the owning namespace onto every schema node
    // here is what lets the walk cross that seam instead of demanding one namespace throughout.
    if (doc.attrs.elementFormDefault !== 'qualified') {
      throw new Error(`${path}: elementFormDefault="${doc.attrs.elementFormDefault}" is not implemented by this subset validator`);
    }
    const stamp = (n) => {
      n.__ns = target;
      for (const c of n.children) stamp(c);
    };
    stamp(doc);
    namespaces.add(target);
    for (const imp of kids(doc, 'import')) {
      if (imp.attrs.namespace !== undefined) imported.add(imp.attrs.namespace);
    }
    for (const el of kids(doc, 'element')) elements.set(`{${target}}${el.attrs.name}`, el);
    for (const ct of kids(doc, 'complexType')) types.set(`{${target}}${ct.attrs.name}`, ct);
    for (const st of kids(doc, 'simpleType')) types.set(`{${target}}${st.attrs.name}`, st);
  }

  for (const ns of imported) {
    if (!namespaces.has(ns)) {
      throw new Error(`schema: namespace "${ns}" is imported but no vendored .xsd for it was passed`);
    }
  }
  return { elements, types };
}

// --- Simple-type facets --------------------------------------------------------------------------

const PRIMITIVE = {
  [`{${XSD_NS}}string`]: () => null,
  // `xs:token` NEVER fails on whitespace. Its whiteSpace=collapse facet is a NORMALISATION, applied
  // to the value before any other facet is checked, so "Muster  AG" is a perfectly valid xs:token
  // whose value is "Muster AG". This used to reject such values outright, which made the validator
  // stricter than the schema and stricter than libxml2: it reported an ESTV-rejected file where the
  // ESTV would have accepted and stored the collapsed form. Verified against `xmllint --schema`,
  // which validates a double space, a tab and a newline here and rejects only 256 characters
  // (maxLength 255) and a whitespace-only name (minLength 1, after collapsing). See `collapse`.
  [`{${XSD_NS}}token`]: () => null,
  [`{${XSD_NS}}decimal`]: (v) => (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v) ? null : 'not a valid xs:decimal'),
  [`{${XSD_NS}}int`]: (v) =>
    /^[+-]?\d+$/.test(v) && Number(v) >= -2147483648 && Number(v) <= 2147483647 ? null : 'not a valid xs:int',
  [`{${XSD_NS}}nonNegativeInteger`]: (v) => (/^\+?\d+$/.test(v) ? null : 'not a valid xs:nonNegativeInteger'),
  [`{${XSD_NS}}date`]: (v) => (/^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(v) ? null : 'not a valid xs:date'),
  [`{${XSD_NS}}dateTime`]: (v) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v) ? null : 'not a valid xs:dateTime',
  // `xs:boolean` has exactly four lexical forms. The SIX schema derives `BatchBookingIndicator` from
  // it, and `<BtchBookg>true</BtchBookg>` must validate while a stray word must not.
  [`{${XSD_NS}}boolean`]: (v) => (/^(true|false|0|1)$/.test(v) ? null : 'not a valid xs:boolean'),
};

const KNOWN_FACETS = new Set([
  'enumeration',
  'minLength',
  'maxLength',
  'length',
  'pattern',
  'fractionDigits',
  'totalDigits',
  'minInclusive',
  'maxInclusive',
  'minExclusive',
  'maxExclusive',
  'whiteSpace',
]);

/**
 * The facet children DECLARED on one `xs:restriction`/`xs:extension` node.
 *
 * `xs:annotation` is documentation, not a facet, and `xs:attribute` is handled separately by the
 * simpleContent path, so both are skipped; anything else in the XSD namespace that is not a known
 * facet throws, so an unimplemented facet cannot pass unchecked.
 */
function collectFacets(node) {
  const facets = [];
  for (const f of node.children) {
    if (f.ns !== XSD_NS) continue;
    if (f.local === 'annotation' || f.local === 'attribute') continue;
    if (!KNOWN_FACETS.has(f.local)) {
      throw new Error(`schema: facet xs:${f.local} is not implemented by this subset validator`);
    }
    facets.push({ kind: f.local, value: f.attrs.value });
  }
  return facets;
}

/**
 * Extend a resolved simple-type chain with the facets and base of one further `xs:restriction`/
 * `xs:extension`. Later facets are appended, which is the XSD rule for facets at different
 * derivation steps: every one in the chain must hold (an AND across the whole chain).
 */
function extendChain(schema, baseQ, ownFacets, seen) {
  if (baseQ in PRIMITIVE) return { primitive: baseQ, facets: ownFacets };
  if (seen.has(baseQ)) throw new Error(`schema: cyclic simpleType restriction at ${baseQ}`);
  seen.add(baseQ);
  const baseNode = schema.types.get(baseQ);
  if (baseNode === undefined) throw new Error(`schema: unknown base type ${baseQ}`);
  const below = simpleTypeChain(schema, baseNode, seen);
  return { primitive: below.primitive, facets: [...below.facets, ...ownFacets] };
}

/** Collect the facet chain of a simple type, walking `xs:restriction base=` down to a primitive. */
function simpleTypeChain(schema, typeNode, seen = new Set()) {
  const restriction = kid(typeNode, 'restriction');
  if (restriction === undefined) {
    throw new Error(`schema: simpleType "${typeNode.attrs.name ?? '(inline)'}" has no xs:restriction, which this subset validator does not implement`);
  }
  const baseQ = resolveQName(restriction, restriction.attrs.base);
  return extendChain(schema, baseQ, collectFacets(restriction), seen);
}

/**
 * Translate an XSD pattern into a JS-compatible one.
 *
 * XSD's pattern grammar is XML Schema regex (the same family as .NET), which is not JavaScript's.
 * Most patterns overlap and pass through untouched. Two constructs in the SIX pain.001 schema do not
 * and must be rewritten, or `new RegExp(...)` throws and every string element in the document errors
 * instead of validating:
 *
 *  - Unicode BLOCK names `\p{IsBasicLatin}` (JS has no `\p{Is...}`), mapped to their code-point range.
 *  - character-class SUBTRACTION `[base-[excl]]` (JS has no subtraction), rewritten to a negative
 *    lookahead: `[base-[excl]]` matches a char in `base` and not in `excl`, i.e. `(?:(?![excl])[base])`.
 *
 * Anything else with a `\p{Is...}` block this does not know THROWS, keeping the subset honest: an
 * untranslated construct is never silently dropped.
 */
const UNICODE_BLOCKS = {
  IsBasicLatin: '\\u0000-\\u007F',
  'IsLatin-1Supplement': '\\u00A0-\\u00FF',
  'IsLatinExtended-A': '\\u0100-\\u017F',
};

function xsdPatternToJs(pattern) {
  let out = pattern.replace(/\\p\{(Is[A-Za-z0-9-]+)\}/g, (whole, block) => {
    if (!(block in UNICODE_BLOCKS)) {
      throw new Error(`schema: XSD pattern uses Unicode block \\p{${block}} which this subset validator does not translate`);
    }
    return UNICODE_BLOCKS[block];
  });
  // `[body-[sub]]` (subtraction) -> `(?:(?![sub])[body])`. The outer class must END here (`]]`), so
  // this cannot fire on an inner `]-[` boundary between two adjacent classes (phone, UUID patterns).
  out = out.replace(/\[([^\]]*?)-\[([^\]]*)\]\]/g, (whole, body, sub) => `(?:(?![${sub}])[${body}])`);
  return out;
}

/**
 * XSD whiteSpace normalisation, which happens BEFORE any other facet is applied.
 *
 * `xs:string` keeps whitespace as-is; every type derived from `xs:token` collapses it. Applying
 * `minLength`/`maxLength` to the raw string instead of the collapsed one is how this validator
 * disagreed with libxml2 about `organisationName`.
 */
function collapse(primitive, value) {
  return primitive === `{${XSD_NS}}token` ? value.replace(/[\s]+/g, ' ').trim() : value;
}

function checkFacets(raw, { primitive, facets }) {
  const value = collapse(primitive, raw);
  const primitiveError = PRIMITIVE[primitive](value);
  if (primitiveError !== null) return `"${value}" is ${primitiveError}`;

  const enums = facets.filter((f) => f.kind === 'enumeration').map((f) => f.value);
  if (enums.length > 0 && !enums.includes(value)) {
    return `"${value}" is not one of the enumerated values [${enums.join(', ')}]`;
  }
  for (const f of facets) {
    switch (f.kind) {
      case 'enumeration':
      case 'whiteSpace':
        break;
      case 'length':
        if (value.length !== Number(f.value)) return `"${value}" has length ${value.length}, length is ${f.value}`;
        break;
      case 'minLength':
        if (value.length < Number(f.value)) return `"${value}" has length ${value.length}, minLength is ${f.value}`;
        break;
      case 'maxLength':
        if (value.length > Number(f.value)) return `"${value}" has length ${value.length}, maxLength is ${f.value}`;
        break;
      case 'pattern': {
        // An XSD pattern is anchored at both ends by definition, which a JS regex is not, and its
        // regex grammar is XML Schema's, not JS's, so `.NET`-isms are translated first (see
        // `xsdPatternToJs`). The error still names the ORIGINAL pattern, not the translation.
        if (!new RegExp(`^(?:${xsdPatternToJs(f.value)})$`, 'u').test(value)) {
          return `"${value}" does not match pattern ${f.value}`;
        }
        break;
      }
      case 'fractionDigits': {
        const dot = value.indexOf('.');
        const digits = dot === -1 ? 0 : value.length - dot - 1;
        if (digits > Number(f.value)) return `"${value}" has ${digits} fraction digits, fractionDigits is ${f.value}`;
        break;
      }
      case 'totalDigits': {
        const digits = value.replace(/[+-.]/g, '').replace(/^0+(?=\d)/, '').length;
        if (digits > Number(f.value)) return `"${value}" has ${digits} digits, totalDigits is ${f.value}`;
        break;
      }
      case 'minInclusive':
        if (Number(value) < Number(f.value)) return `"${value}" is below minInclusive ${f.value}`;
        break;
      case 'maxInclusive':
        if (Number(value) > Number(f.value)) return `"${value}" is above maxInclusive ${f.value}`;
        break;
      case 'minExclusive':
        if (Number(value) <= Number(f.value)) return `"${value}" is not above minExclusive ${f.value}`;
        break;
      case 'maxExclusive':
        if (Number(value) >= Number(f.value)) return `"${value}" is not below maxExclusive ${f.value}`;
        break;
      default:
        throw new Error(`schema: unhandled facet ${f.kind}`);
    }
  }
  return null;
}

// --- The content-model walk -----------------------------------------------------------------------

const occurs = (node) => ({
  min: node.attrs.minOccurs === undefined ? 1 : Number(node.attrs.minOccurs),
  max: node.attrs.maxOccurs === undefined ? 1 : node.attrs.maxOccurs === 'unbounded' ? Infinity : Number(node.attrs.maxOccurs),
});

/**
 * Try to consume children starting at `from` against one particle.
 *
 * Returns `{ next, errors }`. `next` is where the cursor lands; the particle's own minOccurs is
 * enforced here, so a missing required child is an error and a missing optional one is not.
 */
function matchParticle(schema, particle, children, from, errors, path) {
  const { min, max } = occurs(particle);
  let cursor = from;
  let count = 0;

  while (count < max) {
    if (particle.local === 'element') {
      const child = children[cursor];
      const wanted = particle.attrs.name ?? particle.attrs.ref?.split(':').pop();
      if (child === undefined || child.local !== wanted || child.ns !== particle.__ns) break;
      validateElement(schema, particle, child, errors, `${path}/${wanted}`);
      cursor += 1;
    } else if (particle.local === 'sequence' || particle.local === 'choice') {
      const probe = matchGroup(schema, particle, children, cursor, [], path);
      if (probe === null) break;
      // Re-run against the real error sink now that the branch is known to fit.
      matchGroup(schema, particle, children, cursor, errors, path);
      if (probe === cursor) {
        // A group that consumed nothing would loop forever; one empty match is enough.
        count += 1;
        break;
      }
      cursor = probe;
    } else if (particle.local === 'any') {
      // A wildcard slot (`SupplementaryDataEnvelope1` uses `<xs:any namespace="##any"
      // processContents="lax"/>`). Consume one child of ANY name. With `lax` and no guaranteed
      // declaration in the loaded subset, the child and its subtree are accepted as-is.
      const child = children[cursor];
      if (child === undefined) break;
      cursor += 1;
    } else {
      throw new Error(`schema: particle xs:${particle.local} is not implemented by this subset validator`);
    }
    count += 1;
  }

  if (count < min) {
    const wanted = particle.attrs.name ?? `xs:${particle.local}`;
    const got = children[cursor];
    errors.push(
      `${path}: expected ${min === 1 ? '' : `${min}x `}<${wanted}> here, found ${got === undefined ? 'end of element' : `<${got.local}>`}`,
    );
    return null;
  }
  return cursor;
}

/** Walk one xs:sequence or xs:choice. Returns the cursor after it, or null when it cannot match. */
function matchGroup(schema, group, children, from, errors, path) {
  if (group.local === 'sequence') {
    let cursor = from;
    for (const particle of group.children) {
      if (particle.ns !== XSD_NS || particle.local === 'annotation') continue;
      const next = matchParticle(schema, particle, children, cursor, errors, path);
      if (next === null) return null;
      cursor = next;
    }
    return cursor;
  }
  if (group.local === 'choice') {
    // eCH-0217 uses `xs:choice` over branches that are themselves minOccurs="0", so "no branch
    // present" is legal. A branch that matches at least one child wins; otherwise the choice
    // consumes nothing, which is only legal when some branch is optional.
    let anyOptional = false;
    for (const particle of group.children) {
      if (particle.ns !== XSD_NS || particle.local === 'annotation') continue;
      if (occurs(particle).min === 0) anyOptional = true;
      const probe = matchParticle(schema, particle, children, from, [], path);
      if (probe !== null && probe > from) {
        matchParticle(schema, particle, children, from, errors, path);
        return probe;
      }
    }
    if (anyOptional) return from;
    errors.push(`${path}: no branch of the xs:choice matched`);
    return null;
  }
  throw new Error(`schema: model group xs:${group.local} is not implemented by this subset validator`);
}

/** Validate one element instance against its declaration. */
function validateElement(schema, decl, node, errors, path) {
  let typeNode;
  if (decl.attrs.type !== undefined) {
    const q = resolveQName(decl, decl.attrs.type);
    if (q in PRIMITIVE) {
      const err = checkFacets(node.text.trim(), { primitive: q, facets: [] });
      if (err !== null) errors.push(`${path}: ${err}`);
      if (node.children.length > 0) errors.push(`${path}: has child elements but its type is simple`);
      return;
    }
    typeNode = schema.types.get(q);
    if (typeNode === undefined) throw new Error(`schema: unknown type ${q} on ${path}`);
  } else {
    typeNode = kid(decl, 'simpleType') ?? kid(decl, 'complexType');
    if (typeNode === undefined) throw new Error(`schema: element ${path} has neither @type nor an inline type`);
  }

  if (typeNode.local === 'simpleType') {
    if (node.children.length > 0) errors.push(`${path}: has child elements but its type is simple`);
    const err = checkFacets(node.text.trim(), simpleTypeChain(schema, typeNode));
    if (err !== null) errors.push(`${path}: ${err}`);
    return;
  }

  // complexType.
  validateComplexType(schema, typeNode, node, errors, path);
}

/**
 * Validate one element instance against a complexType.
 *
 * Three content shapes are covered, plus attributes:
 *
 *  - `xs:simpleContent > xs:extension|xs:restriction`: the element carries TEXT of the base simple
 *    type and NO child elements, plus the declared attributes. This is the SIX amount type: a decimal
 *    body with a required `Ccy` attribute.
 *  - `xs:complexContent > xs:restriction`: element-only content whose model is the restriction's own
 *    `xs:sequence`/`xs:choice`. The SIX CH schema builds nearly every type this way and the CH
 *    restriction fully restates the model, so the restriction's group IS the effective one. An
 *    `xs:extension` under complexContent (which would ADD to the base model) is not present in these
 *    schemas and throws rather than being mishandled.
 *  - a DIRECT `xs:sequence`/`xs:choice` on the complexType (the eCH-0217 shape).
 */
function validateComplexType(schema, typeNode, node, errors, path) {
  const simpleContent = kid(typeNode, 'simpleContent');
  if (simpleContent !== undefined) {
    const derivation = kid(simpleContent, 'extension') ?? kid(simpleContent, 'restriction');
    if (derivation === undefined) {
      throw new Error(`schema: xs:simpleContent with neither xs:extension nor xs:restriction at ${path}`);
    }
    if (node.children.length > 0) {
      errors.push(`${path}: simpleContent type carries child element <${node.children[0].local}> but its content is text`);
    }
    const baseQ = resolveQName(derivation, derivation.attrs.base);
    const chain = extendChain(schema, baseQ, collectFacets(derivation), new Set());
    const err = checkFacets(node.text.trim(), chain);
    if (err !== null) errors.push(`${path}: ${err}`);
    validateAttributes(schema, derivation, node, errors, path);
    return;
  }

  // Where the content model and the attributes live: the complexType itself, or, under
  // xs:complexContent, the xs:restriction that restates the model.
  let holder = typeNode;
  const complexContent = kid(typeNode, 'complexContent');
  if (complexContent !== undefined) {
    const restriction = kid(complexContent, 'restriction');
    if (restriction === undefined) {
      const extension = kid(complexContent, 'extension');
      throw new Error(
        extension !== undefined
          ? `schema: xs:complexContent xs:extension is not implemented by this subset validator (at ${path})`
          : `schema: xs:complexContent with no xs:restriction at ${path}`,
      );
    }
    holder = restriction;
  }

  // Element-only content: stray text is a fault.
  if (node.text.trim().length > 0) errors.push(`${path}: element-only content, but it carries text "${node.text.trim()}"`);
  const group = kid(holder, 'sequence') ?? kid(holder, 'choice');
  if (group === undefined) {
    if (node.children.length > 0) errors.push(`${path}: has children but its type declares no content model`);
  } else {
    const end = matchGroup(schema, group, node.children, 0, errors, path);
    if (end !== null && end < node.children.length) {
      errors.push(`${path}: unexpected <${node.children[end].local}> after the content model was satisfied`);
    }
  }
  validateAttributes(schema, holder, node, errors, path);
}

/**
 * Validate the `xs:attribute` declarations on a complexType (or on the restriction/extension that
 * holds them) against the instance's attributes.
 *
 * A required attribute that is absent is a fault; a present attribute is checked against its simple
 * type. The eCH-0217 types declare none, so this is a no-op there; the SIX amount type declares the
 * mandatory `Ccy`, which is the whole reason attribute validation exists here.
 */
function validateAttributes(schema, holder, node, errors, path) {
  for (const attr of kids(holder, 'attribute')) {
    const name = attr.attrs.name;
    if (name === undefined) {
      throw new Error(`schema: xs:attribute with a ref (not a name) at ${path} is not implemented by this subset validator`);
    }
    const use = attr.attrs.use ?? 'optional';
    const present = Object.prototype.hasOwnProperty.call(node.attrs, name);
    if (!present) {
      if (use === 'required') errors.push(`${path}: missing required attribute @${name}`);
      continue;
    }
    if (use === 'prohibited') {
      errors.push(`${path}: attribute @${name} is prohibited but present`);
      continue;
    }
    let chain;
    if (attr.attrs.type !== undefined) {
      const q = resolveQName(attr, attr.attrs.type);
      if (q in PRIMITIVE) chain = { primitive: q, facets: [] };
      else {
        const st = schema.types.get(q);
        if (st === undefined) throw new Error(`schema: unknown attribute type ${q} at ${path}/@${name}`);
        chain = simpleTypeChain(schema, st);
      }
    } else {
      const inline = kid(attr, 'simpleType');
      if (inline === undefined) throw new Error(`schema: attribute @${name} at ${path} has neither @type nor an inline simpleType`);
      chain = simpleTypeChain(schema, inline);
    }
    const err = checkFacets(node.attrs[name], chain);
    if (err !== null) errors.push(`${path}/@${name}: ${err}`);
  }
}

/**
 * Validate an XML document string against the loaded schemas.
 *
 * Returns `{ valid, errors }` rather than throwing, so a test can assert on WHICH fault was found
 * and not merely that something went wrong.
 */
export function validateXml(xml, schema) {
  const errors = [];
  let doc;
  try {
    doc = parseXml(xml);
  } catch (e) {
    return { valid: false, errors: [`not well-formed: ${e.message}`] };
  }
  const rootQ = `{${doc.ns}}${doc.local}`;
  const decl = schema.elements.get(rootQ);
  if (decl === undefined) {
    return { valid: false, errors: [`root element ${rootQ} is not declared as a global element in the schema`] };
  }
  validateElement(schema, decl, doc, errors, doc.local);
  return { valid: errors.length === 0, errors };
}
