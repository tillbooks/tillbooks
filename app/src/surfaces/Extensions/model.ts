/**
 * G02 wire shapes and the engine-enum mirrors for the Erweiterungen surface.
 *
 * MIRRORED, NOT INVENTED: `PLUGIN_SOURCES`, `PLUGIN_STATUSES` and `PLUGIN_CAPABILITY_KINDS` are the
 * §H-ENUM sets in `src/core/plugins/enums.ts`, restated here for the panel and held equal to the
 * engine by `test/style/studio-mirrors-engine-enums.test.mjs` (the `ENTITY_KINDS`/`DocumentStatus`
 * precedent). A status this file omits, or one it invents, reddens that guard.
 */

export const PLUGIN_SOURCES = ['local', 'registry'] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

export const PLUGIN_STATUSES = ['installed', 'disabled', 'incompatible'] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

export const PLUGIN_CAPABILITY_KINDS = ['mcp_tool', 'studio_screen', 'report_source', 'automation_action'] as const;
export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number];

export interface PluginCapabilityDto {
  kind: PluginCapabilityKind;
  name: string;
}

export interface PluginDto {
  id: string;
  name: string;
  version: string;
  source: string;
  status: string;
  compatRange: string;
  coreVersion: string;
  compatible: boolean;
  sha256: string;
  installedBy: string;
  registryRef: string | null;
  requested: readonly string[];
  granted: readonly string[];
  capabilities: readonly PluginCapabilityDto[];
  capabilityCount: number;
  lastCompatCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewDto {
  name: string;
  version: string;
  capabilities: readonly PluginCapabilityDto[];
  requested: readonly string[];
  compatible: boolean;
  compatRange: string;
  coreVersion: string;
}

export interface RegistryEntryDto {
  registryRef: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  requestedScopes: readonly string[];
  compatRange: string;
}

/** The status glyph (glyph + label, never colour alone: the DESIGN.md accessibility rule). */
export function statusGlyph(status: string): string {
  switch (status) {
    case 'installed':
      return '●'; // filled circle
    case 'disabled':
      return '○'; // hollow circle
    case 'incompatible':
      return '✕'; // cross
    default:
      return '○';
  }
}
