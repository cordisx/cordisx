import { access, readFile } from 'node:fs/promises'
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

/** Claude session tools the bridge needs without a dialog; Claude asks the person for them by default. */
export const CLAUDE_BRIDGE_PERMISSIONS = [
  'mcp__ccd_session__start_session',
  'mcp__ccd_session_mgmt__send_message',
] as const

/** The bridge rules the user's Claude settings do not allow yet. Reads only; settings stay the user's. */
export async function missingClaudeBridgePermissions(homedir: string): Promise<readonly string[]> {
  let allow: unknown
  try {
    const settings = JSON.parse(await readFile(path.join(homedir, '.claude', 'settings.json'), 'utf8')) as {
      permissions?: { allow?: unknown }
    }
    allow = settings.permissions?.allow
  } catch {
    allow = undefined
  }
  const rules = Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === 'string') : []
  return CLAUDE_BRIDGE_PERMISSIONS.filter(rule => !rules.includes(rule))
}
