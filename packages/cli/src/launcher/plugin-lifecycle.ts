// V7 and V8 package manifests share this single lifecycle coordinator entry.
export { PluginLifecycleCoordinator } from './plugin-lifecycle-operations.js'
export type {
  HostPermissionLifecycleApplyV2Request,
  HostPermissionLifecycleApplyV4Request,
  HostPermissionLifecycleReviewV2Request,
  HostPermissionLifecycleReviewV4Request,
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle-model.js'
