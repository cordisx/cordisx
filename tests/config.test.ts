import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

describe('loadConfig', () => {
  it('resolves plugin entries relative to the config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      plugins: [{ id: 'demo', entry: './plugins/demo.ts' }],
    }))
    const config = await loadConfig(configPath)
    expect(config.codex.debugPort).toBe(9229)
    expect(config.plugins[0]?.entry).toBe(path.join(directory, 'plugins/demo.ts'))
    expect(config.plugins[0]?.enabled).toBe(true)
  })

  it('rejects duplicate plugin ids', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: 'demo', entry: './one.ts' },
        { id: 'demo', entry: './two.ts' },
      ],
    }))
    await expect(loadConfig(configPath)).rejects.toThrow('duplicate plugin id: demo')
  })

  it('uses the same lowercase 96-character owner contract as renderer registries', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      plugins: [{ id: 'Demo', entry: './demo.ts' }],
    }))
    await expect(loadConfig(configPath)).rejects.toThrow('invalid plugin id: Demo')

    await writeFile(configPath, JSON.stringify({
      version: 1,
      plugins: [{ id: `a${'b'.repeat(96)}`, entry: './demo.ts' }],
    }))
    await expect(loadConfig(configPath)).rejects.toThrow(/invalid plugin id/)

    await writeFile(configPath, JSON.stringify({
      version: 1,
      plugins: [{ id: 'host', entry: './demo.ts' }],
    }))
    await expect(loadConfig(configPath)).rejects.toThrow('reserved plugin id: host')
  })

  it('resolves the built-in Channel renderer bundle without treating service config as renderer config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-config-'))
    const configPath = path.join(directory, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      plugins: [{ id: 'channel', entry: 'cordisx:channel', enabled: true }],
    }))
    const config = await loadConfig(configPath)
    expect(config.plugins[0]).toMatchObject({ id: 'channel', enabled: true, config: {} })
    expect(config.plugins[0]?.entry).toMatch(/plugins\/channel\/index\.(?:ts|js)$/)
  })
})
