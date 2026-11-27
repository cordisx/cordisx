import { approvalReviewCatalogEnvironment } from './approval-review-catalog.js'
import { desktopStaticCatalogEnvironment } from './desktop-native-context-observer.js'

/** Construct only the launch-owned intermediary environment. */
export function nativeSubmissionEnvironment(input: {
  nativeEntry: { executable: string }
  cli: string
  node: string
  control: { socketPath: string; nonce: string }
  agentModels: { bindingPath: string }
  options: {
    environment?: Readonly<Record<string, string | undefined>>
    staticCatalog?: Parameters<typeof desktopStaticCatalogEnvironment>[0]
    reviewCatalog?: Parameters<typeof approvalReviewCatalogEnvironment>[0]
  }
  recovery: { environment: Readonly<Record<string, string>> }
}) {
  return {
    CODEX_CLI_PATH: input.nativeEntry.executable,
    // Dot must not open a second connection to the chat intermediary's control socket.
    CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH: input.options.environment?.CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH || input.cli,
    CORDISX_NATIVE_CONTROL_SOCKET: input.control.socketPath,
    CORDISX_NATIVE_CONTROL_NONCE: input.control.nonce,
    CORDISX_NATIVE_REAL_CODEX_PATH: input.cli,
    CORDISX_NATIVE_CLI_ENTRY_PATH: input.nativeEntry.executable,
    CORDISX_NATIVE_NODE_PATH: input.node,
    CORDISX_NATIVE_AGENT_MODELS_BINDING: input.agentModels.bindingPath,
    ...input.recovery.environment,
    ...desktopStaticCatalogEnvironment(input.options.staticCatalog),
    ...approvalReviewCatalogEnvironment(input.options.reviewCatalog),
  }
}
