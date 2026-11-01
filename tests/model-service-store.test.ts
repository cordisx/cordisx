import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  parseModelServicesSaveRequest,
  readModelServices,
  saveModelServices,
} from '../packages/cli/src/launcher/model-service-store.js'
import { modelServiceKeyEnv } from '../packages/cli/src/model-service-contracts.js'

async function home(extra: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-model-service-store-'))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const configPath = path.join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ ...createDefaultHomeConfig(), ...extra }), { mode: 0o600 })
  return configPath
}

const gateway = {
  id: 'gw-a',
  kind: 'cli-proxy-api',
  displayName: 'Gateway',
  baseUrl: 'http://127.0.0.1:8317/v1',
  apiKeyEnv: 'CLIPROXY_A_API_KEY',
}

const input = {
  id: 'sub2tok',
  displayName: 'sub2tok',
  baseUrl: 'https://api.sub2tok.com',
  protocols: ['anthropic-messages', 'openai-responses'] as const,
  codexModels: ['gpt-6.1-sol'],
  claudeModels: ['claude-opus-5-5'],
  enabled: true,
}

describe('model service store', () => {
  it('adds a service, stores its key write-only, and keeps gateway providers', async () => {
    const configPath = await home({ providers: [gateway] })
    const empty = await readModelServices(configPath, {})
    expect(empty).toEqual({ status: 'ok', revision: expect.any(String), services: [] })

    const saved = await saveModelServices(configPath, {
      expectedRevision: (empty as { revision: string }).revision,
      services: [{ ...input, apiKey: 'sk-secret' }],
    })
    expect(saved).toEqual({ status: 'applied', applies: 'app-restart', revision: expect.any(String) })

    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      providers: Array<Record<string, unknown>>
      environmentVariables: Array<Record<string, unknown>>
    }
    expect(stored.providers.map(provider => provider.id)).toEqual(['gw-a', 'sub2tok'])
    expect(stored.providers[1]).toEqual(expect.objectContaining({
      kind: 'model-service',
      apiKeyEnv: modelServiceKeyEnv('sub2tok'),
      models: { codex: ['gpt-6.1-sol'], claude: ['claude-opus-5-5'] },
    }))
    expect(stored.environmentVariables).toEqual([
      expect.objectContaining({ name: 'CORDISX_MODEL_SERVICE_SUB2TOK_KEY', value: 'sk-secret', enabled: true }),
    ])

    const read = await readModelServices(configPath, {})
    expect(read.status === 'ok' && read.services).toEqual([
      expect.objectContaining({ id: 'sub2tok', keyConfigured: true, codexModels: ['gpt-6.1-sol'] }),
    ])
    expect(JSON.stringify(read)).not.toContain('sk-secret')
  })

  it('keeps the existing key and variable name when an edit leaves the key empty', async () => {
    const configPath = await home({
      providers: [{
        id: 'manual',
        kind: 'model-service',
        displayName: 'Manual',
        baseUrl: 'https://manual.example.com',
        apiKeyEnv: 'MY_OWN_KEY',
        protocols: ['openai-responses'],
      }],
    })
    const before = await readModelServices(configPath, { MY_OWN_KEY: 'from-shell' })
    expect(before.status === 'ok' && before.services[0]!.keyConfigured).toBe(true)
    await saveModelServices(configPath, {
      expectedRevision: (before as { revision: string }).revision,
      services: [{ ...input, id: 'manual', displayName: 'Renamed', protocols: ['openai-responses'], claudeModels: [] }],
    })
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      providers: Array<Record<string, unknown>>
      environmentVariables: unknown[]
    }
    expect(stored.providers[0]).toEqual(expect.objectContaining({ displayName: 'Renamed', apiKeyEnv: 'MY_OWN_KEY' }))
    expect(stored.environmentVariables).toEqual([])
  })

  it('removes a key it stored when its service is deleted, and keeps keys it does not own', async () => {
    const configPath = await home({
      environmentVariables: [{ name: 'MY_OWN_KEY', value: 'mine', enabled: true }],
    })
    const first = await readModelServices(configPath, {}) as { revision: string }
    const added = await saveModelServices(configPath, {
      expectedRevision: first.revision,
      services: [{ ...input, apiKey: 'sk-secret' }],
    }) as { revision: string }
    await saveModelServices(configPath, { expectedRevision: added.revision, services: [] })
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as { environmentVariables: Array<{ name: string }> }
    expect(stored.environmentVariables.map(entry => entry.name)).toEqual(['MY_OWN_KEY'])
  })

  it('refuses a stale revision and an invalid service without writing', async () => {
    const configPath = await home()
    expect(await saveModelServices(configPath, { expectedRevision: 'stale', services: [input] })).toEqual({
      status: 'rejected',
      code: 'conflict',
    })
    const read = await readModelServices(configPath, {})
    const revision = (read as { revision: string }).revision
    const invalid = await saveModelServices(configPath, {
      expectedRevision: revision,
      services: [{ ...input, baseUrl: 'http://api.sub2tok.com' }],
    })
    expect(invalid).toEqual(expect.objectContaining({ status: 'rejected', code: 'invalid' }))
    expect(await saveModelServices(configPath, { expectedRevision: revision, services: [input, input] }))
      .toEqual(expect.objectContaining({ status: 'rejected', code: 'invalid' }))
    expect((await readModelServices(configPath, {}) as { services: unknown[] }).services).toEqual([])
  })

  it('accepts only the documented save request shape from the renderer', () => {
    expect(parseModelServicesSaveRequest({ expectedRevision: 'r', services: [input] })).toEqual({
      expectedRevision: 'r',
      services: [input],
    })
    expect(parseModelServicesSaveRequest({ expectedRevision: 'r', services: [{ ...input, apiKeyEnv: 'X' }] }))
      .toBeUndefined()
    expect(parseModelServicesSaveRequest({ expectedRevision: 'r', services: [{ ...input, protocols: ['grpc'] }] }))
      .toBeUndefined()
    expect(parseModelServicesSaveRequest({ services: [] })).toBeUndefined()
  })
})
