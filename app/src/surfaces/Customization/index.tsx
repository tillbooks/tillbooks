/**
 * Public entry point for the G00 Anpassung surface, wired at `/customization` in `router.tsx`.
 *
 * `CustomFieldRow` and `SavedViewPicker` are re-exported here on purpose: they are the two components
 * every other capability's screen is meant to reuse, so they are part of this surface's public face
 * rather than an internal detail a host would have to reach past the barrel to find.
 */
export { Customization, default } from './Customization';
export { CustomFieldRow, labelFor } from './CustomFieldRow';
export type { CustomFieldRowProps, FieldDefDto } from './CustomFieldRow';
export { SavedViewPicker } from './SavedViewPicker';
export type { SavedViewPickerProps, SavedViewDto } from './SavedViewPicker';
