import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { codexAppServerArguments } from '../packages/cli/src/providers/codex-app-server.js'

describe('external provider configuration', () => {
  it('resolves plugin-owned runtime/startup service planes ahead of the legacy top-level import', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cordisx-provider-config-'))
    const configPath = path.join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: [{
        id: 'legacy', kind: 'cli-proxy-api', displayName: 'Legacy',
        baseUrl: 'https://legacy.example.com/v1', apiKeyEnv: 'LEGACY_KEY',
      }],
      plugins: [{
        id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', enabled: true,
        services: {
          'providers-runtime': { profiles: { default: {
            revision: 2, lastGoodRevision: 2,
            config: {
              contract: 'cordisx.cli-proxy-provider-runtime-config/v1', schemaVersion: 1,
              providers: [{
                id: 'gateway-a', displayName: 'Gateway A', enabled: true,
                endpoint: { baseUrl: 'https://proxy.example.com/v1', secretRef: 'host-secret:env/GATEWAY_A_KEY' },
                models: { mappings: [{
                  sourceModelId: 'remote-coder', modelId: 'coder', displayName: 'Coder', enabled: true, isDefault: true,
                }] },
                timeoutMs: 45_000,
              }],
            },
          } } },
          'providers-startup': { profiles: { default: {
            revision: 1, lastGoodRevision: 1,
            config: {
              contract: 'cordisx.cli-proxy-provider-startup-config/v1', schemaVersion: 1,
              providers: [{ id: 'gateway-a', executable: './bin/codex', dataDir: 'provider-data/gateway-a' }],
            },
          } } },
        },
      }],
    }))
    const config = await loadConfig(configPath, { profileId: 'default' })
    expect(config.providers).toEqual([expect.objectContaining({
      id: 'gateway-a',
      baseUrl: 'https://proxy.example.com/v1',
      credentialRef: 'host-secret:env/GATEWAY_A_KEY',
      codexExecutable: path.join(directory, 'bin/codex'),
      codexHome: path.join(directory, 'provider-data/gateway-a'),
      timeoutMs: 45_000,
      modelMappings: [expect.objectContaining({ sourceModelId: 'remote-coder', modelId: 'coder' })],
    })])
    expect(JSON.stringify(config.providers)).not.toContain('LEGACY_KEY')
    const args = codexAppServerArguments(config.providers[0]!, 'CORDISX_PROVIDER_CREDENTIAL')
    expect(args.join(' ')).not.toContain('host-secret:')
    expect(args.join(' ')).toContain('env_key = "CORDISX_PROVIDER_CREDENTIAL"')
  })

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
