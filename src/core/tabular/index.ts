/**
 * A20 §13.1 (D205): the tabular reader layer, one table reader for every export TILL reads (a bank CSV or
 * XLSX statement, a settlement table, a migration file): decode, layout detection below a preamble, the
 * delimited reader, and an XLSX workbook read into a grid and written out as RFC 4180 text.
 */

export { decodeTextBytes, TABULAR_ENCODINGS } from './decode.js';
export type { DetectedTextEncoding, TabularEncoding } from './decode.js';
export { detectTableLayout, delimiterChar, TABULAR_DELIMITERS } from './layout.js';
export type { TabularDelimiter } from './layout.js';
export { readDelimitedRows, splitDelimitedLine } from './delimited.js';
export type { TabularRow } from './delimited.js';
export {
  readXlsxGrid,
  isXlsxFailure,
  xlsxGridToText,
  cellText,
  cellKindOf,
  serialToIsoDate,
  shortestDecimal,
  formatKindOf,
  sniffContainer,
  decodeXmlEntities,
  XLSX_MAX_INFLATED_BYTES,
  XLSX_MAX_COLUMNS,
  XLSX_CELL_MAX_CHARS,
  XLSX_PREAMBLE_ROWS,
} from './xlsx.js';
export type { XlsxCell, XlsxCellKind, XlsxGrid, XlsxFailure, XlsxFailureKind, XlsxStyleKind, ReadXlsxGridOptions, GridTextLimits, GridText, TabularCellKind } from './xlsx.js';
export { readTable, readTextTable, readXlsxTable, sniffTabular, isTabularFailure, TABULAR_CONTAINERS, TABULAR_MAX_ROWS, TABULAR_MAX_INFLATED_BYTES } from './table.js';
export type { TabularTable, TabularFailure, TabularContainer, ReadTableOptions } from './table.js';
export { IMPORT_PROFILE_FORMAT, IMPORT_PROFILE_KINDS, readImportProfileEnvelope, profileMatches } from './profile.js';
export type { ImportProfile, ImportProfileKind, ProfileRefusal } from './profile.js';
