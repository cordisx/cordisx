import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The CordisX bridge plugin shipped with the CLI. Claude Desktop passes its own
 * environment to the Claude Code sessions it starts, so naming this folder in
 * `CLAUDE_CODE_PLUGIN_DIRS` loads the bridge in that profile's sessions only.
 */
export async function claudeBridgePluginDir(): Promise<string> {
  const directory = fileURLToPath(new URL('../../assets/claude-bridge', import.meta.url))
  await access(path.join(directory, '.claude-plugin', 'plugin.json'))
  return directory
}
