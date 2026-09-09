/**
 * A37, managed bank connectivity: the module's public surface. The managed branches of A33's five
 * verbs (spec §4), the enums (§H-ENUM), and the schema. The `ManagedChannelPort` seam lives on
 * `WorkspaceContext` (context.ts); this module never opens a socket itself. There are NO new MCP
 * verbs: the five A33 verbs dispatch by channel kind (spec §5).
 */

export {
  connectManagedChannel,
  syncManagedChannel,
  transmitManagedBatch,
  managedChannelStatusList,
  disconnectManagedChannel,
  isManagedConnectionId,
  readManagedConnection,
  readManagedConnectionForAccount,
} from './channel.js';

export {
  MANAGED_PROVIDER,
  MANAGED_CONNECTION_STATE,
  MANAGED_ORDER_DIRECTION,
  MANAGED_ORDER_KIND,
  MANAGED_ORDER_STATUS,
  MANAGED_SCOPE,
  CHANNEL_KIND,
  isManagedConnectionState,
  isManagedOrderStatus,
  isChannelKind,
} from './enums.js';
export type {
  ManagedProvider,
  ManagedConnectionState,
  ManagedOrderDirection,
  ManagedOrderKind,
  ManagedOrderStatus,
  ManagedScope,
  ChannelKind,
} from './enums.js';

export { MANAGED_SCHEMA_SQL } from './schema.js';
