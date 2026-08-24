import { describe, expect, it } from 'vitest'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_SCHEMA_V1,
  normalizeCliProxyProviderRuntimeMutation,
  parseCliProxyProviderRuntimeConfig,
  parseCliProxyProviderStartupConfig,
  projectedModel,
  projectCliProxyProviderRuntimeConfig,
  sourceModelId,
  validateCliProxyProviderPlanes,
} from '../packages/cli/src/plugins/cli-proxy-api/service-config.js'

function runtimeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gateway-a',
    displayName: 'Gateway A',
    enabled: true,
    endpoint: { baseUrl: 'https://proxy.example.com/v1/', secretRef: 'keychain:cordisx/providers/gateway-a' },
    models: {
      mappings: [{
        sourceModelId: 'remote-coder', modelId: 'coder', displayName: 'Coder', enabled: true, isDefault: true,
      }],
    },
    timeoutMs: 30_000,
    ...overrides,
  }
}

function runtime(providers: readonly unknown[] = [runtimeProvider()]) {
  return {
    contract: 'cordisx.cli-proxy-provider-runtime-config/v1',
    schemaVersion: 1,
    providers,
  }
}

function startup(providers: readonly unknown[] = [{
  id: 'gateway-a', executable: 'codex', dataDir: 'providers/gateway-a/codex-home',
}]) {
  return {
    contract: 'cordisx.cli-proxy-provider-startup-config/v1',
    schemaVersion: 1,
    providers,
  }
}

describe('CLIProxy Providers service configuration contracts', () => {
  it('declares protocol-owned runtime and startup Schemastery planes with fixed apply modes', () => {
    expect(CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT).toMatchObject({
      identity: { pluginId: 'cli-proxy-api', serviceId: 'providers-runtime' },
      schema: { id: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_SCHEMA_V1, projection: { kind: 'schemastery' } },
      configApplies: 'service-restart',
    })
    expect(CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT).toMatchObject({
      identity: { pluginId: 'cli-proxy-api', serviceId: 'providers-startup' },
      schema: { id: CLI_PROXY_PROVIDER_STARTUP_CONFIG_SCHEMA_V1, projection: { kind: 'schemastery' } },
      configApplies: 'app-restart',
    })
    expect(JSON.stringify(CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT.schema.projection)).toContain('credential-ref')
  })

  it('normalizes endpoint and model mappings while preserving composite public model identity', () => {
    const parsed = parseCliProxyProviderRuntimeConfig(runtime())
    expect(parsed.providers[0]).toEqual({
      id: 'gateway-a',
      displayName: 'Gateway A',
      enabled: true,
      endpoint: { baseUrl: 'https://proxy.example.com/v1', secretRef: 'keychain:cordisx/providers/gateway-a' },
      models: {
        mappings: [{
          sourceModelId: 'remote-coder', modelId: 'coder', displayName: 'Coder', enabled: true, isDefault: true,
        }],
      },
      timeoutMs: 30_000,
    })
    expect(sourceModelId(parsed.providers[0]!, 'coder')).toBe('remote-coder')
    expect(projectedModel(parsed.providers[0]!, {
      modelId: 'remote-coder', displayName: 'Remote coder', isDefault: false,
    })).toEqual({ modelId: 'coder', displayName: 'Coder', isDefault: true })
  })

  it('redacts secret references into exact Host secret slots and preserves omitted references', () => {
    const current = parseCliProxyProviderRuntimeConfig(runtime())
    const next = normalizeCliProxyProviderRuntimeMutation(runtime([runtimeProvider({
      displayName: 'Renamed',
      endpoint: { baseUrl: 'https://next.example.com/v1' },
    })]), current)
    expect(next.providers[0]?.endpoint.secretRef).toBe('keychain:cordisx/providers/gateway-a')
    const descriptor = projectCliProxyProviderRuntimeConfig(next, ref => ref === undefined ? 'missing' : 'ready')
    expect(descriptor.secrets).toEqual([{ path: ['providers', '0', 'endpoint', 'secretRef'], set: true }])
    expect(JSON.stringify(descriptor.configuration)).not.toContain('secretRef')
    expect(JSON.stringify(descriptor)).not.toContain('keychain:cordisx/providers/gateway-a')
  })

  it('validates startup overrides separately and rejects orphans across planes', () => {
    const runtimeConfig = parseCliProxyProviderRuntimeConfig(runtime())
    const startupConfig = parseCliProxyProviderStartupConfig(startup())
    expect(() => validateCliProxyProviderPlanes(runtimeConfig, startupConfig)).not.toThrow()
    const orphan = parseCliProxyProviderStartupConfig(startup([{
      id: 'gateway-b', executable: 'codex', dataDir: 'providers/gateway-b/codex-home',
    }]))
    expect(() => validateCliProxyProviderPlanes(runtimeConfig, orphan)).toThrow('has no matching runtime provider')
  })

  it('fails closed on plaintext credentials, unsafe endpoints, duplicate mappings, and shared data roots', () => {
    expect(() => parseCliProxyProviderRuntimeConfig(runtime([runtimeProvider({
      endpoint: { baseUrl: 'https://proxy.example.com/v1', apiKey: 'plaintext' },
    })]))).toThrow('endpoint.apiKey is not supported')
    expect(() => parseCliProxyProviderRuntimeConfig(runtime([runtimeProvider({
      endpoint: { baseUrl: 'http://proxy.example.com/v1', secretRef: 'host-secret:providers/gateway-a' },
    })]))).toThrow('must use HTTPS or loopback HTTP')
    expect(() => parseCliProxyProviderRuntimeConfig(runtime([runtimeProvider({
      endpoint: { baseUrl: 'https://proxy.example.com/v1', secretRef: 'inline:plaintext' },
    })]))).toThrow('endpoint.secretRef is invalid')
    expect(() => parseCliProxyProviderRuntimeConfig(runtime([runtimeProvider({
      models: { mappings: [
        { sourceModelId: 'remote', modelId: 'one', enabled: true, isDefault: false },
        { sourceModelId: 'remote', modelId: 'two', enabled: true, isDefault: false },
      ] },
    })]))).toThrow('duplicate sourceModelId')
    expect(() => parseCliProxyProviderStartupConfig(startup([
      { id: 'gateway-a', executable: 'codex', dataDir: 'providers/shared' },
      { id: 'gateway-b', executable: 'codex', dataDir: 'providers/shared' },
    ]))).toThrow('dataDir must be unique')
  })
})
