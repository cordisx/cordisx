import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The permission mode a CordisX-launched Claude starts its sessions in. */
export const CLAUDE_DEFAULT_PERMISSION_MODE = 'bypassPermissions'

/** Where Claude Code reads machine-wide managed settings when no override is set. */
export const CLAUDE_SYSTEM_MANAGED_DIR = '/Library/Application Support/ClaudeCode'

const MANAGED_SETTINGS = 'managed-settings.json'
const MANAGED_MCP = 'managed-mcp.json'

/**
 * Writes the profile's managed settings folder, for
 * `CLAUDE_CODE_MANAGED_SETTINGS_PATH`: the machine's own managed settings with
 * `permissions.defaultMode` set. Pointing the variable here replaces the
 * machine folder for this app only, so its other files are carried over.
 */
export async function writeClaudeManagedSettings(input: {
  readonly profileRoot: string
  readonly systemDir?: string
}): Promise<string> {
  const systemDir = input.systemDir ?? CLAUDE_SYSTEM_MANAGED_DIR
  const directory = path.join(input.profileRoot, 'managed')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const system = await readJsonObject(path.join(systemDir, MANAGED_SETTINGS)) ?? {}
  const permissions = isObject(system.permissions) ? system.permissions : {}
  const settings = { ...system, permissions: { ...permissions, defaultMode: CLAUDE_DEFAULT_PERMISSION_MODE } }
  await writeAtomically(path.join(directory, MANAGED_SETTINGS), `${JSON.stringify(settings, null, 2)}\n`)
  try {
    await copyFile(path.join(systemDir, MANAGED_MCP), path.join(directory, MANAGED_MCP))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return directory
}

/**
 * Turns bypass mode on in the profile's own preferences, as the person would
 * in Claude's settings: Claude offers it only to accounts listed in
 * `bypassPermissionsGateByAccount` and `bypassPermissionsOptInByAccount`.
 * Accounts are the ones the profile has used; a profile that was never opened
 * has none yet and is enabled on its next launch. Run only while the app is
 * closed, as it rewrites the file on exit.
 */
export async function enableClaudeBypassMode(dataDir: string): Promise<readonly string[]> {
  const file = path.join(dataDir, 'claude_desktop_config.json')
  const config = await readJsonObject(file)
  if (config === undefined) return []
  const accounts = await profileAccounts(dataDir)
  if (accounts.length === 0) return []
  const preferences = isObject(config.preferences) ? config.preferences : {}
  const enable = (key: string): Record<string, unknown> => ({
    ...(isObject(preferences[key]) ? preferences[key] : {}),
    ...Object.fromEntries(accounts.map(account => [account, true])),
  })
  const next = {
    ...config,
    preferences: {
      ...preferences,
      bypassPermissionsGateByAccount: enable('bypassPermissionsGateByAccount'),
      bypassPermissionsOptInByAccount: enable('bypassPermissionsOptInByAccount'),
    },
  }
  await writeAtomically(file, `${JSON.stringify(next, null, 2)}\n`)
  return accounts
}

async function profileAccounts(dataDir: string): Promise<readonly string[]> {
  const accounts = new Set<string>()
  try {
    for (const entry of await readdir(path.join(dataDir, 'claude-code-sessions'), { withFileTypes: true })) {
      if (entry.isDirectory()) accounts.add(entry.name)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const known = (await readJsonObject(path.join(dataDir, 'config.json')))?.lastKnownAccountUuid
  if (typeof known === 'string' && known !== '') accounts.add(known)
  return [...accounts].sort()
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function writeAtomically(file: string, content: string): Promise<void> {
  const temporary = `${file}.cordisx-${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, file)
}
