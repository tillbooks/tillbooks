# Vendored XML schema for pain.001 validation (Rung B)

`pain.001.001.09.ch.03.xsd` is the Swiss ISO-20022 Customer Credit Transfer
Initiation schema, vendored verbatim so the offline test suite can validate
TILL's generated pain.001 against the real SIX schema (the same approach
`test/vat/fixtures/ech0217/` uses for the eCH schemas).

- Source: SIX "Swiss Payment Standards" download center, Credit Transfer XML
  Schema (SPS 2025 package):
  https://www.six-group.com/dam/download/banking-services/standardization/sps/ig-credit-transfer-xml-schema-sps-2025-en.zip
- The archive contains exactly this one file, dated 2022-03-07.
- Integrity pin (as SIX published it, CRLF line endings preserved):
  - size: 74674 bytes
  - sha256: `8daf0973bc1d8eaec5b494214d843d1dd4ccfe10b2bf61739004fa0c9f30d675`
  - The sibling `.gitattributes` marks `*.xsd -text`, so git stores this byte for
    byte (no CRLF to LF normalization); that is what keeps the sha256 above valid.
- Schema copyright: (C) SIX, www.iso-payments.ch. Vendored for conformance
  testing only. Self-contained: targetNamespace
  `urn:iso:std:iso:20022:tech:xsd:pain.001.001.09`, no external xs:import.

TILL's `generatePain001` (src/core/banking/pain001.ts) emits this namespace and
`pain001.ts` names this exact file as the out-of-scope full-XSD target; Rung B
brings it in scope via a schema-walking validator (the `ech0217-xsd.mjs`
pattern, extended for the `xs:complexContent`/`xs:restriction` the CH types use).
