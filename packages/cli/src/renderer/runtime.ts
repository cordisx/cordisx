export { installCordisX, installCordisXComposition, prepareCordisXViteReactRuntime } from './runtime-install.js'
/**
 * Runtime module map retained for source-level conformance checks:
 * - manifestUsesTransientCanvas and V7/V8 manifest handling live in runtime-shared.
 * - agentLoopBrokerV4.dispose() remains in the ordered runtime disposal stage.
 */
export {
  CordisXInternalRendererBootstrap,
  RendererGenerationCleanupObservation,
  RendererPluginMutation,
} from './runtime-shared.js'
