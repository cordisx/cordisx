import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConfigBridgeHandler, parseConfigBindingRequest } from '../packages/cli/src/launcher/config-rpc.js'

const token = 'a'.repeat(64)
const generation = 'b'.repeat(32)
const request = {
  version: 1,
  operation: 'stage',
  requestId: 'request-1',
  token,
  identity: { source: 'file:///plugins/example.ts', pluginId: 'example' },
  scope: { profileId: 'work', generation },
  expectedRevision: 2,
  config: { timeout: 45 },
}

describe('config CDP request boundary', () => {
  it('persists a configured archive under its verified HTTPS identity without borrowing activation authority', async () => {
    const source = 'https://github.com/cordisx/example'
    const stage = vi.fn(async () => ({ revision: 3 }))
    const handler = createConfigBridgeHandler({
      token,
      profileId: 'work',
      generation,
      configPath: '/not-used/config.json',
      configuredPluginConfig: { stage } as never,
      composition: {
        version: 1,
        rootDir: '/',
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [{
          id: 'example',
          entry: '/immutable/module.js',
          enabled: true,
          config: {},
          source,
          distributionArtifact: { version: '1.0.0', integrity: `sha256:${'c'.repeat(64)}` },
        }],
      },
    })
    const parsed = parseConfigBindingRequest(
      { ...request, identity: { source, pluginId: 'example' } },
      token,
      'work',
      generation,
    )
    await expect(handler.handle(parsed)).resolves.toEqual({ revision: 3 })
    expect(stage).toHaveBeenCalledTimes(1)
    await expect(
      handler.handle({ ...parsed, identity: { source: 'https://github.com/cordisx/spoofed', pluginId: 'example' } }),
    )
      .rejects.toThrow('identity is stale or spoofed')
    expect(stage).toHaveBeenCalledTimes(1)
  })
  it('accepts only the bound token, profile, and launcher generation', () => {
    expect(parseConfigBindingRequest(request, token, 'work', generation)).toMatchObject({
      operation: 'stage',
      expectedRevision: 2,
      config: { timeout: 45 },
    })
    expect(() => parseConfigBindingRequest({ ...request, token: 'b'.repeat(64) }, token, 'work', generation))
      .toThrow('token is invalid')
    expect(() =>
      parseConfigBindingRequest(
        { ...request, scope: { ...request.scope, profileId: 'other' } },
        token,
        'work',
        generation,
      )
    )
      .toThrow('profile is stale or spoofed')
    expect(() =>
      parseConfigBindingRequest(
        { ...request, scope: { ...request.scope, generation: 'old' } },
        token,
        'work',
        generation,
      )
    )
      .toThrow('generation is stale or spoofed')
  })

  it('rejects unknown transport fields and prototype mutation data', () => {
    expect(() => parseConfigBindingRequest({ ...request, configPath: '/tmp/config.json' }, token, 'work', generation))
      .toThrow('config request.configPath is not supported')
    const polluted = JSON.parse(JSON.stringify({ ...request, config: { safe: true } })) as Record<string, unknown>
    ;(polluted.identity as Record<string, unknown>).unexpected = true
    expect(() => parseConfigBindingRequest(polluted, token, 'work', generation))
      .toThrow('config request identity.unexpected is not supported')
  })

  it('binds plugin source to the launcher composition before persistence', async () => {
    const entry = path.resolve('/plugins/example.ts')
    const handler = createConfigBridgeHandler({
      token,
      profileId: 'work',
      generation,
      configPath: '/not-used/config.json',
      composition: {
        version: 1,
        rootDir: '/',
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [{ id: 'example', entry, enabled: true, config: {}, revision: 0 }],
      },
    })
    const parsed = parseConfigBindingRequest(
      {
        ...request,
        identity: { source: 'file:///plugins/spoofed.ts', pluginId: 'example' },
      },
      token,
      'work',
      generation,
    )
    await expect(handler.handle(parsed)).rejects.toThrow('identity is stale or spoofed')
  })
})
