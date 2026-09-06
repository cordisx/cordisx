export {
  assertExtensionPointDescriptorLocalization,
  ExtensionPointDescriptorRegistry,
} from './extension-point-descriptors.js'
export type {
  ExtensionPointCatalogTextProjection,
  ExtensionPointDescriptorDiagnostic,
  HostExtensionPointAnchorProjection,
  HostExtensionPointProjection,
} from './extension-point-descriptors.js'
export {
  BrowserExtensionPointPolicyStore,
  buildExtensionPointRuntimeSnapshot,
  canonicalExtensionPointSource,
  extensionPointIdentityKey,
  MemoryExtensionPointPolicyStore,
} from './extension-point-runtime-snapshot.js'
export type {
  ExtensionPointAccessDecision,
  ExtensionPointAccessDiagnostic,
  ExtensionPointAccessResolver,
  ExtensionPointAnchorSnapshot,
  ExtensionPointAuthorizationAuthority,
  ExtensionPointContributionSnapshot,
  ExtensionPointPluginUsageSnapshot,
  ExtensionPointPolicyDiagnostic,
  ExtensionPointPolicyStore,
  ExtensionPointRuntimeSnapshot,
  ExtensionPointSnapshot,
} from './extension-point-runtime-snapshot.js'
export { ExtensionPointPolicyBroker } from './extension-point-policy.js'
export {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
} from './extension-point-catalog.js'
