import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findCordisXProjectConfig,
  loadConfig,
  resolveCordisXProjectConfig,
} from '../packages/cli/src/launcher/config.js'

describe('loadConfig', () => {
  it('resolves plugin entries relative to the config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'demo', entry: './plugins/demo.ts' }],
      }),
    )
    const config = await loadConfig(configPath)
    expect(config.codex.debugPort).toBe(9229)
    expect(config.plugins[0]?.entry).toBe(path.join(directory, 'plugins/demo.ts'))
    expect(config.plugins[0]?.enabled).toBe(true)
  })

  it('separates an embedded project root from its config root and resolves every plugin from the config', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-embedded-config-'))
    const configRoot = path.join(projectRoot, '.cordisx')
    const configPath = path.join(configRoot, 'config.json')
    await mkdir(configRoot)
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        codex: { executable: './tools/codex' },
        providers: [{
          id: 'gateway',
          kind: 'cli-proxy-api',
          displayName: 'Gateway',
          baseUrl: 'https://gateway.example.com/v1',
          apiKeyEnv: 'GATEWAY_KEY',
        }],
        plugins: [
          { id: 'chatroom', entry: './plugins/chatroom/src/index.tsx' },
          { id: 'calendar', entry: './plugins/calendar/src/index.tsx', enabled: false },
        ],
      }),
    )

    const config = await loadConfig(configPath)

    expect(config).toMatchObject({
      rootDir: projectRoot,
      projectRoot,
      configRoot,
      configPath,
      codex: { executable: path.join(configRoot, 'tools/codex') },
    })
    expect(config.plugins.map(plugin => plugin.entry)).toEqual([
      path.join(configRoot, 'plugins/chatroom/src/index.tsx'),
      path.join(configRoot, 'plugins/calendar/src/index.tsx'),
    ])
    expect(config.providers[0]).toMatchObject({
      id: 'gateway',
      codexHome: path.join(configRoot, 'providers/gateway/codex-home'),
    })
  })

  it('discovers the nearest project config upwards and prefers the embedded layout at one root', async () => {
    const outer = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-discovery-'))
    const projectRoot = path.join(outer, 'business-project')
    const nested = path.join(projectRoot, 'packages', 'feature', 'src')
    const configRoot = path.join(projectRoot, '.cordisx')
    await mkdir(nested, { recursive: true })
    await mkdir(configRoot)
    await writeFile(path.join(projectRoot, 'cordisx.config.json'), JSON.stringify({ version: 1, plugins: [] }))
    await writeFile(path.join(configRoot, 'config.json'), JSON.stringify({ version: 1, plugins: [] }))

    await expect(findCordisXProjectConfig(nested)).resolves.toEqual({
      layout: 'embedded',
      configPath: path.join(configRoot, 'config.json'),
      configRoot,
      projectRoot,
    })
  })

  it('does not treat an excluded user-home config as an embedded project', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-home-'))
    const configRoot = path.join(home, '.cordisx')
    const configPath = path.join(configRoot, 'config.json')
    const businessDirectory = path.join(home, 'work', 'business', 'src')
    await mkdir(configRoot)
    await mkdir(businessDirectory, { recursive: true })
    await writeFile(configPath, JSON.stringify({ version: 1, plugins: [] }))

    await expect(findCordisXProjectConfig(businessDirectory, {
      excludeConfigPaths: [configPath],
    })).resolves.toBeUndefined()
  })

  it('lets a caller keep a .cordisx home config rooted at its own directory', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-home-root-'))
    const configRoot = path.join(home, '.cordisx')
    const configPath = path.join(configRoot, 'config.json')
    await mkdir(configRoot)
    await writeFile(configPath, JSON.stringify({ version: 1, plugins: [] }))

    const config = await loadConfig(configPath, { projectRoot: configRoot })
    expect(config.rootDir).toBe(configRoot)
    expect(config.projectRoot).toBe(configRoot)
    expect(config.configRoot).toBe(configRoot)
  })

  it('keeps the legacy root config discoverable and normalizes explicit relative paths', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-legacy-config-'))
    const nested = path.join(projectRoot, 'src')
    const configPath = path.join(projectRoot, 'cordisx.config.json')
    await mkdir(nested)
    await writeFile(configPath, JSON.stringify({ version: 1, plugins: [] }))

    await expect(findCordisXProjectConfig(nested)).resolves.toEqual({
      layout: 'legacy',
      configPath,
      configRoot: projectRoot,
      projectRoot,
    })
    expect(resolveCordisXProjectConfig('../cordisx.config.json', nested)).toEqual({
      layout: 'legacy',
      configPath,
      configRoot: projectRoot,
      projectRoot,
    })
    expect(resolveCordisXProjectConfig('./development.json', nested)).toEqual({
      layout: 'explicit',
      configPath: path.join(nested, 'development.json'),
      configRoot: nested,
      projectRoot: nested,
    })
  })

  it('returns no implicit project config when neither supported layout exists', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-missing-'))
    await expect(findCordisXProjectConfig(directory)).resolves.toBeUndefined()
  })

  it('rejects duplicate plugin ids', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: 'demo', entry: './one.ts' },
          { id: 'demo', entry: './two.ts' },
        ],
      }),
    )
    await expect(loadConfig(configPath)).rejects.toThrow('duplicate plugin id: demo')
  })

  it('uses the same lowercase 96-character owner contract as renderer registries', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'Demo', entry: './demo.ts' }],
      }),
    )
    await expect(loadConfig(configPath)).rejects.toThrow('invalid plugin id: Demo')

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: `a${'b'.repeat(96)}`, entry: './demo.ts' }],
      }),
    )
    await expect(loadConfig(configPath)).rejects.toThrow(/invalid plugin id/)

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'host', entry: './demo.ts' }],
      }),
    )
    await expect(loadConfig(configPath)).rejects.toThrow('reserved plugin id: host')
  })

  it('resolves the built-in Channel renderer bundle without treating service config as renderer config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: 'channel', entry: 'cordisx:channel', enabled: true }],
      }),
    )
    const config = await loadConfig(configPath)
    expect(config.plugins[0]).toMatchObject({ id: 'channel', enabled: true, config: {} })
    expect(config.plugins[0]?.entry).toMatch(/plugins\/channel\/index\.(?:ts|js)$/)
  })
})
