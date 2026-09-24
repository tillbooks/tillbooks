/**
 * G02, plugin architecture & extension registry: the barrel `src/api/` imports from (the one door,
 * per the module map's standing rule). The manifest lifecycle, the compat contract, the sandbox
 * boundary (the enforced data-reach half + the declared process seam), the reserved-name single
 * source (P3), and the registry-client seam.
 */

export {
  previewInstall,
  installPlugin,
  listPlugins,
  getPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  refreshPluginCompat,
  checkCompat,
  searchRegistry,
  getRegistryEntry,
} from './plugin.js';
export type {
  PluginManifest,
  PluginCapabilityDecl,
  PluginView,
  PreviewInstallOk,
  InstallPluginOk,
  UninstallPluginOk,
  CompatResult,
} from './plugin.js';

export {
  PLUGIN_SOURCES,
  PLUGIN_STATUSES,
  PLUGIN_CAPABILITY_KINDS,
  REGISTERING_CAPABILITY_KINDS,
  CORE_CONTRACT_VERSION,
  isPluginSource,
  isPluginStatus,
  isPluginCapabilityKind,
} from './enums.js';
export type { PluginSource, PluginStatus, PluginCapabilityKind } from './enums.js';

export { satisfies, isValidRange, parseVersion } from './compat.js';

export {
  registerMoneyPathTools,
  registerCoreToolNames,
  moneyPathTools,
  coreToolNames,
  isReservedMoneyPathTool,
  isCoreToolName,
} from './reserved.js';

export {
  runPluginToolCall,
  parseScope,
  grantedToolNames,
  grantedNetworkHosts,
  pluginProcessDescriptor,
  iframeSandboxDescriptor,
  registerSandboxHost,
  sandboxHost,
} from './sandbox.js';
export type {
  PluginInvoker,
  PluginProcessDescriptor,
  IframeSandboxDescriptor,
  PluginSandboxHost,
  ParsedScope,
} from './sandbox.js';

export { registerRegistryClient, registryClient } from './registryClient.js';
export type { RegistryClient, RegistryEntry, RegistrySearchResult } from './registryClient.js';

export { PLUGINS_SCHEMA_SQL } from './schema.js';
