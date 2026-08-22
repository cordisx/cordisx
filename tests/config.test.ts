import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/launcher/config.js'

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
})
