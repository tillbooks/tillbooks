/**
 * G00, the customization framework: custom fields (OP7), saved views (OP10), and the OP3 entity
 * registry both of them key against.
 *
 * The barrel is the only thing `src/api/` imports from, the same rule every other engine module
 * follows. `ENTITY_KINDS` is exported because `actionCapabilities.ts` resolves `set_field_value`'s
 * inherited capability through it, which is the one place outside this module that legitimately reads
 * the registry.
 */

export {
  ENTITY_KINDS,
  ENTITY_KIND_IDS,
  editCapabilityForKind,
  entityKindDef,
} from './entities.js';
export type { EntityKindDef } from './entities.js';

export {
  FIELD_TYPES,
  MAX_FIELDS_PER_KIND,
  MAX_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_VALUE_BYTES,
  archiveField,
  confirmField,
  defineField,
  isValidFieldValue,
  listFieldDefs,
  listFieldValues,
  setFieldValue,
} from './fields.js';
export type { DefineFieldInput, FieldDefView } from './fields.js';

export {
  LAYOUTS,
  MAX_VIEW_JSON_BYTES,
  MAX_VIEW_NAME_LENGTH,
  applySavedView,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  resolveSavedViewFilters,
  updateSavedView,
} from './views.js';
export type { CreateSavedViewInput, SavedViewPatch, SavedViewView } from './views.js';

export { CUSTOMIZATION_SCHEMA_SQL } from './schema.js';

// G05, document templates: the branding seam around the statutory artifacts.
export {
  DOCUMENT_TEMPLATE_KINDS,
  TEMPLATE_LANGUAGE_MODES,
  TEMPLATE_LOCALES,
  OPTIONAL_LINE_ITEM_COLUMNS,
  MAX_FOOTER_LINES,
  archiveDocumentTemplate,
  createDocumentTemplate,
  freezeRenderedTemplate,
  getDocumentTemplate,
  listDocumentTemplates,
  resolveRenderTemplate,
  setDefaultDocumentTemplate,
  updateDocumentTemplate,
} from './documentTemplates.js';
export type {
  CreateDocumentTemplateInput,
  DocumentTemplatePatch,
  ResolvedRenderTemplate,
} from './documentTemplates.js';
export { previewDocumentTemplate } from './documentTemplatePreview.js';
export { DOCUMENT_TEMPLATE_SCHEMA_SQL } from './documentTemplateSchema.js';

// G05 §10, dispatch texts and the cross-document send log (D29).
export {
  DISPATCH_TEXT_KINDS,
  DISPATCH_CHANNELS,
  DISPATCH_OUTCOMES,
  DISPATCH_VARIABLES,
  MAX_DISPATCH_SUBJECT_LENGTH,
  MAX_DISPATCH_BODY_LENGTH,
  dispatchTextUpsert,
  dispatchPreview,
  listDispatches,
  recordDispatch,
  resolveDispatchText,
  renderDispatchTemplate,
} from './dispatch.js';
export type { DispatchTextUpsertInput, DispatchPreviewInput, RecordDispatchInput } from './dispatch.js';
export { DISPATCH_SCHEMA_SQL } from './dispatchSchema.js';
