import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  CLAUDE_CREDENTIAL_HELPER,
  claudeLibraryIdFor,
  readClaudeProviderCatalog,
  seedClaudeDesktopProfile,
} from '../packages/cli/src/launcher/claude-desktop-profile.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { missingClaudeBridgePermissions } from '../packages/cli/src/launcher/claude-bridge-plugin.js'

const run = promisify(execFile)

const sub2tok = {
  id: 'sub2tok',
  kind: 'model-service',
  displayName: 'sub2tok',
  baseUrl: 'https://api.sub2tok.com',
  apiKeyEnv: 'SUB2TOK_API_KEY',
  protocols: ['anthropic-messages', 'openai-responses'],
  models: { claude: ['claude-opus-5-5'] },
}

function providers(entries: unknown[]) {
  return parseHomeConfig({
    version: 1,
    defaultApp: 'codex',
    providers: entries,
    plugins: [],
    apps: { codex: { defaultProfile: 'default', profiles: { default: { displayName: 'D', dataMode: 'shared' } } } },
  }).providers
}

async function dataDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'cx-claude-profile-'))
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

describe('Claude Desktop profile seeding', () => {
  it('derives a lowercase UUID library id, stable per provider', () => {
    expect(claudeLibraryIdFor('sub2tok')).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    )
    expect(claudeLibraryIdFor('sub2tok')).toBe(claudeLibraryIdFor('sub2tok'))
    expect(claudeLibraryIdFor('other')).not.toBe(claudeLibraryIdFor('sub2tok'))
  })

  it('writes a helper-script gateway entry with no key on disk and applies the named provider', async () => {
    const root = await dataDir()
    const result = await seedClaudeDesktopProfile({
      dataDir: root,
      providers: providers([sub2tok, { ...sub2tok, id: 'second', displayName: 'Second' }]),
      selectedId: 'second',
    })
    expect(result).toEqual({ providerIds: ['sub2tok', 'second'], appliedProviderId: 'second', diagnostics: [] })

    const entry = await json(path.join(root, 'configLibrary', `${claudeLibraryIdFor('sub2tok')}.json`))
    expect(entry).toEqual({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'https://api.sub2tok.com',
      inferenceCredentialKind: 'helper-script',
      inferenceCredentialHelper: path.join(root, CLAUDE_CREDENTIAL_HELPER),
      inferenceCredentialHelperArgs: ['SUB2TOK_API_KEY'],
      disableDeploymentModeChooser: true,
    })
    const meta = await json(path.join(root, 'configLibrary', '_meta.json'))
    expect(meta.appliedId).toBe(claudeLibraryIdFor('second'))
    expect(meta.entries).toEqual([
      { id: claudeLibraryIdFor('sub2tok'), name: 'sub2tok' },
      { id: claudeLibraryIdFor('second'), name: 'Second' },
    ])
    expect((await json(path.join(root, 'claude_desktop_config.json'))).deploymentMode).toBe('3p')
    expect((await stat(path.join(root, 'configLibrary', '_meta.json'))).mode & 0o777).toBe(0o600)
  })

  it('runs a credential helper that prints only the named variable', async () => {
    const root = await dataDir()
    await seedClaudeDesktopProfile({ dataDir: root, providers: providers([sub2tok]) })
    const helper = path.join(root, CLAUDE_CREDENTIAL_HELPER)
    const { stdout } = await run(helper, ['SUB2TOK_API_KEY'], {
      env: { PATH: process.env.PATH, SUB2TOK_API_KEY: 'k-123' },
    })
    expect(stdout).toBe('k-123')
    await expect(run(helper, ['MISSING_KEY'], { env: { PATH: process.env.PATH } })).rejects.toThrow()
    await expect(run(helper, ['$(touch x)'], { env: { PATH: process.env.PATH } })).rejects.toThrow()
  })

  it('keeps entries and settings the user added in Claude, and keeps their applied choice on relaunch', async () => {
    const root = await dataDir()
    const library = path.join(root, 'configLibrary')
    await mkdir(library, { recursive: true })
    const own = claudeLibraryIdFor('sub2tok')
    const foreign = '11111111-2222-4333-8444-555555555555'
    await writeFile(
      path.join(library, `${own}.json`),
      JSON.stringify({ modelPrefer1mContext: true, inferenceGatewayApiKey: 'old' }),
    )
    await writeFile(
      path.join(library, '_meta.json'),
      JSON.stringify({ appliedId: foreign, entries: [{ id: foreign, name: 'Mine' }] }),
    )

    const result = await seedClaudeDesktopProfile({ dataDir: root, providers: providers([sub2tok]) })
    expect(result.appliedProviderId).toBeUndefined()
    const meta = await json(path.join(library, '_meta.json'))
    expect(meta.appliedId).toBe(foreign)
    expect(meta.entries).toEqual([{ id: own, name: 'sub2tok' }, { id: foreign, name: 'Mine' }])
    const entry = await json(path.join(library, `${own}.json`))
    expect(entry.modelPrefer1mContext).toBe(true)
    // An inline key from an older setup is dropped in favour of the helper.
    expect(entry.inferenceGatewayApiKey).toBeUndefined()

    const catalog = await readClaudeProviderCatalog(providers([sub2tok]), root)
    expect(catalog.map(item => [item.providerId, item.source, item.applied])).toEqual([
      ['sub2tok', 'declared', false],
      [foreign, 'library', true],
    ])
  })

  it('reports a provider Claude cannot use', async () => {
    const result = await seedClaudeDesktopProfile({
      dataDir: await dataDir(),
      providers: providers([{ ...sub2tok, protocols: ['openai-responses'] }]),
      selectedId: 'sub2tok',
    })
    expect(result.diagnostics).toEqual([
      { providerId: 'sub2tok', code: 'protocol-unsupported' },
      { providerId: 'sub2tok', code: 'provider-unknown' },
    ])
  })

  it('parses the claude launch command with a provider', () => {
    expect(parseCordisXCli(['start', 'claude', 'work', '--provider', 'sub2tok'])).toEqual(expect.objectContaining({
      action: 'start',
      app: 'claude',
      profile: 'work',
      options: expect.objectContaining({ provider: 'sub2tok' }),
    }))
  })

  it('reports the bridge permission rules the user has not allowed yet', async () => {
    const homedir = await dataDir()
    expect(await missingClaudeBridgePermissions(homedir)).toEqual([
      'mcp__ccd_session__start_session',
      'mcp__ccd_session_mgmt__send_message',
    ])
    await mkdir(path.join(homedir, '.claude'), { recursive: true })
    await writeFile(
      path.join(homedir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls)', 'mcp__ccd_session__start_session'] } }),
    )
    expect(await missingClaudeBridgePermissions(homedir)).toEqual(['mcp__ccd_session_mgmt__send_message'])
  })
})
