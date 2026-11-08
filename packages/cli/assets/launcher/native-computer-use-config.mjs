import path from 'node:path'

/** Native Computer Use persists its default node_repl definition using the same
 * executable resolver as the App Server. The current Host shim only lives for
 * the owned launch and cannot be used as a durable Computer Use executable.
 */
export function withStableComputerUseCli(message, entry, bundledCli) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry) || entry === bundledCli) return message
  if (message?.method !== 'config/batchWrite' || !['string', 'number'].includes(typeof message.id)) return message
  const params = message.params
  if (params?.filePath != null || params?.expectedVersion != null || !Array.isArray(params?.edits)) return message
  const target = 'mcp_servers.node_repl'
  const edits = params.edits.filter(edit => edit?.keyPath === target)
  if (edits.length !== 1) return message
  const [edit] = edits
  if (edit.mergeStrategy !== 'replace' || edit.value?.env?.CODEX_CLI_PATH !== entry) return message
  const updated = { ...edit, value: { ...edit.value, env: { ...edit.value.env, CODEX_CLI_PATH: bundledCli } } }
  return {
    ...message,
    params: { ...params, edits: params.edits.map(item => item === edit ? updated : item) },
  }
}
