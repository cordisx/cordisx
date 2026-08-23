import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { codexAppServerArguments } from '../packages/cli/src/providers/codex-app-server.js'

describe('external provider configuration', () => {
  it('resolves isolated roots while retaining only the credential environment name', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-provider-config-'))
    const configPath = path.join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: [{
        id: 'gateway-a', kind: 'cli-proxy-api', displayName: 'Gateway A',
        baseUrl: 'http://127.0.0.1:8317/v1/', apiKeyEnv: 'GATEWAY_A_KEY',
      }],
      plugins: [],
    }))
    const config = await loadConfig(configPath)
    expect(config.providers).toEqual([expect.objectContaining({
      id: 'gateway-a', baseUrl: 'http://127.0.0.1:8317/v1', apiKeyEnv: 'GATEWAY_A_KEY',
      codexHome: path.join(directory, 'providers/gateway-a/codex-home'),
    })])
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain('secret-value')
    expect(codexAppServerArguments(config.providers[0]!)).toEqual(expect.arrayContaining([
      'app-server', '--stdio', '-c', 'model_provider="gateway-a"', '-c', 'analytics.enabled=false',
    ]))
    expect(codexAppServerArguments(config.providers[0]!).join(' ')).not.toContain('secret-value')
  })

  it('rejects remote cleartext endpoints and duplicate data roots', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-provider-config-'))
    const configPath = path.join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1, providers: [{
        id: 'bad', kind: 'cli-proxy-api', displayName: 'Bad', baseUrl: 'http://example.com/v1', apiKeyEnv: 'BAD_KEY',
      }], plugins: [],
    }))
    await expect(loadConfig(configPath)).rejects.toThrow('must use HTTPS or loopback HTTP')

    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: [
        { id: 'one', kind: 'cli-proxy-api', displayName: 'One', baseUrl: 'https://one.test/v1', apiKeyEnv: 'ONE_KEY', dataDir: './same' },
        { id: 'two', kind: 'cli-proxy-api', displayName: 'Two', baseUrl: 'https://two.test/v1', apiKeyEnv: 'TWO_KEY', dataDir: './same' },
      ],
      plugins: [],
    }))
    await expect(loadConfig(configPath)).rejects.toThrow('dataDir must be unique per provider')
  })
})
