import { fileURLToPath } from 'node:url'

/** Configure only this intermediary's child and remove launcher secrets from its environment. */
export function nativeLaunchConfiguration(environment, args, node = process.execPath) {
  const socketPath = environment.CORDISX_NATIVE_CONTROL_SOCKET
  const nonce = environment.CORDISX_NATIVE_CONTROL_NONCE
  const executable = environment.CORDISX_NATIVE_REAL_CODEX_PATH
  const nativeCliEntry = environment.CORDISX_NATIVE_CLI_ENTRY_PATH
  const agentModelsBinding = environment.CORDISX_NATIVE_AGENT_MODELS_BINDING
  const staticCatalog = {
    path: environment.CORDISX_NATIVE_STATIC_CATALOG_PATH,
    sha256: environment.CORDISX_NATIVE_STATIC_CATALOG_SHA256,
    nativeVersion: environment.CORDISX_NATIVE_STATIC_CATALOG_VERSION,
  }
  if (!socketPath || !nonce || !executable?.startsWith('/')) throw new Error('Native intermediary is not configured')
  for (
    const key of [
      'CODEX_CLI_PATH',
      'CORDISX_NATIVE_CONTROL_SOCKET',
      'CORDISX_NATIVE_CONTROL_NONCE',
      'CORDISX_NATIVE_REAL_CODEX_PATH',
      'CORDISX_NATIVE_CLI_ENTRY_PATH',
      'CORDISX_NATIVE_NODE_PATH',
      'CORDISX_NATIVE_AGENT_MODELS_BINDING',
      'CORDISX_NATIVE_STATIC_CATALOG_PATH',
      'CORDISX_NATIVE_STATIC_CATALOG_SHA256',
      'CORDISX_NATIVE_STATIC_CATALOG_VERSION',
    ]
  ) delete environment[key]
  const nativeArgs = [...args]
  if (
    staticCatalog.path?.startsWith('/') && /^[a-f0-9]{64}$/u.test(staticCatalog.sha256 ?? '')
    && staticCatalog.nativeVersion === '0.167.0-alpha.3.2' && nativeArgs.includes('app-server')
  ) {
    nativeArgs.unshift(
      '-c',
      `model_catalog_json=${JSON.stringify(staticCatalog.path)}`,
      '-c',
      'model_provider="openai"',
    )
  }
  if (agentModelsBinding && nativeArgs.includes('app-server')) {
    nativeArgs.unshift(
      '-c',
      `mcp_servers.cordisx_models.command=${JSON.stringify(node)}`,
      '-c',
      `mcp_servers.cordisx_models.args=${
        JSON.stringify([
          fileURLToPath(new URL('./native-agent-models-mcp.mjs', import.meta.url)),
          agentModelsBinding,
        ])
      }`,
      '-c',
      'mcp_servers.cordisx_models.tool_timeout_sec=90',
      '-c',
      'mcp_servers.cordisx_models.default_tools_approval_mode="approve"',
    )
  }
  return { socketPath, nonce, executable, nativeCliEntry, staticCatalog, nativeArgs }
}
