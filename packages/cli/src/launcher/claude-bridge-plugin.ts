import { access, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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

/**
 * Adds the bridge's allow rules to `~/.claude/settings.json` so Codex requests
 * never wait on a dialog. Every other setting is kept as written; a file that
 * is not valid JSON is left alone and reported instead of overwritten.
 */
export async function ensureClaudeBridgePermissions(
  homedir: string,
): Promise<{ readonly added: readonly string[]; readonly skipped?: 'settings-unreadable' }> {
  const directory = path.join(homedir, '.claude')
  const file = path.join(directory, 'settings.json')
  let settings: Record<string, unknown> = {}
  let mode = 0o600
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { added: [], skipped: 'settings-unreadable' }
    }
    settings = parsed as Record<string, unknown>
    mode = (await stat(file)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { added: [], skipped: 'settings-unreadable' }
  }
  const permissions = settings.permissions !== null && typeof settings.permissions === 'object'
      && !Array.isArray(settings.permissions)
    ? settings.permissions as Record<string, unknown>
    : {}
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow as unknown[]] : []
  const added = CLAUDE_BRIDGE_PERMISSIONS.filter(rule => !allow.includes(rule))
  if (added.length === 0) return { added }
  const next = { ...settings, permissions: { ...permissions, allow: [...allow, ...added] } }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.cordisx-${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode })
  await chmod(temporary, mode)
  await rename(temporary, file)
  return { added }
}
