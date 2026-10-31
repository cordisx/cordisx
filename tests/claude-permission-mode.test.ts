import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  enableClaudeBypassMode,
  writeClaudeManagedSettings,
} from '../packages/cli/src/launcher/claude-permission-mode.js'

async function temporary(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'cx-claude-mode-'))
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, 'utf8'))
}

describe('Claude managed settings', () => {
  it('keeps the machine settings and names bypass as the default mode', async () => {
    const root = await temporary()
    const systemDir = path.join(root, 'system')
    await mkdir(systemDir)
    await writeFile(path.join(systemDir, 'managed-settings.json'), JSON.stringify({
      hooks: {},
      permissions: { deny: ['Bash(rm:*)'], defaultMode: 'plan' },
    }))
    await writeFile(path.join(systemDir, 'managed-mcp.json'), '{"mcpServers":{}}')

    const directory = await writeClaudeManagedSettings({ profileRoot: path.join(root, 'profile'), systemDir })

    expect(directory).toBe(path.join(root, 'profile', 'managed'))
    expect(await readJson(path.join(directory, 'managed-settings.json'))).toEqual({
      hooks: {},
      permissions: { deny: ['Bash(rm:*)'], defaultMode: 'bypassPermissions' },
    })
    expect(await readFile(path.join(directory, 'managed-mcp.json'), 'utf8')).toBe('{"mcpServers":{}}')
  })

  it('writes the default mode alone when the machine has no managed settings', async () => {
    const root = await temporary()
    const directory = await writeClaudeManagedSettings({
      profileRoot: root,
      systemDir: path.join(root, 'absent'),
    })
    expect(await readJson(path.join(directory, 'managed-settings.json'))).toEqual({
      permissions: { defaultMode: 'bypassPermissions' },
    })
  })
})

describe('Claude bypass preferences', () => {
  it('offers bypass to every account the profile has used and keeps other preferences', async () => {
    const dataDir = await temporary()
    await mkdir(path.join(dataDir, 'claude-code-sessions', 'account-a', 'org'), { recursive: true })
    await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'account-b' }))
    await writeFile(path.join(dataDir, 'claude_desktop_config.json'), JSON.stringify({
      deploymentMode: '3p',
      preferences: { sidebarMode: 'epitaxy', bypassPermissionsGateByAccount: { 'account-a': false, other: false } },
    }))

    expect(await enableClaudeBypassMode(dataDir)).toEqual(['account-a', 'account-b'])
    expect(await readJson(path.join(dataDir, 'claude_desktop_config.json'))).toEqual({
      deploymentMode: '3p',
      preferences: {
        sidebarMode: 'epitaxy',
        bypassPermissionsGateByAccount: { 'account-a': true, 'account-b': true, other: false },
        bypassPermissionsOptInByAccount: { 'account-a': true, 'account-b': true },
      },
    })
  })

  it('leaves a profile Claude has not opened yet alone', async () => {
    const dataDir = await temporary()
    expect(await enableClaudeBypassMode(dataDir)).toEqual([])
    await writeFile(path.join(dataDir, 'claude_desktop_config.json'), '{"preferences":{}}')
    expect(await enableClaudeBypassMode(dataDir)).toEqual([])
    expect(await readFile(path.join(dataDir, 'claude_desktop_config.json'), 'utf8')).toBe('{"preferences":{}}')
  })
})
