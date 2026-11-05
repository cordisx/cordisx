import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig, parseHomeConfig } from '../packages/cli/src/config/home-config.js'
import { parseModelServiceRuntimeOptions } from '../packages/cli/src/config/model-service-runtime-options.js'
import { prepareSharedTerminalService } from '../packages/cli/src/cli/terminal-shared-service.js'
import { hostModelServiceEnvironment } from '../packages/cli/src/cli/native-submission-catalog-options.js'
import {
  modelServiceCodexProvider,
  modelServiceHeaderEnvironmentName,
} from '../packages/cli/src/launcher/model-service-runtime.js'
import { codexConfigModelProviders } from '../packages/cli/src/launcher/codex-config-model-providers.js'
import {
  mergeDeclaredIntoCodexProjection,
  projectModelServicesToCodex,
} from '../packages/cli/src/launcher/model-service-projection.js'
import { configuredEncryptedReplay } from '../packages/cli/src/launcher/configured-encrypted-replay.js'
import {
  parseModelServicesSaveRequest,
  readModelServices,
  saveModelServices,
} from '../packages/cli/src/launcher/model-service-store.js'

const options = {
  http_headers: { 'X-Private': 'private-test-header' },
  env_http_headers: { 'X-Environment': 'EXTRA_HEADER' },
  supports_websockets: false,
  request_max_retries: 0,
  stream_max_retries: 2,
  stream_idle_timeout_ms: 0,
} as const
const service = {
  id: 'runtime-service',
  kind: 'model-service',
  displayName: 'Runtime service',
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'SERVICE_KEY',
  protocols: ['openai-responses', 'anthropic-messages'],
  models: { codex: ['test-model'], claude: ['claude-model'] },
  runtimeOptions: { codex: options },
}
const configuration = (providers: unknown[] = [service]) => parseHomeConfig({ ...createDefaultHomeConfig(), providers })
const input = {
  id: service.id,
  displayName: service.displayName,
  baseUrl: service.baseUrl,
  protocols: ['openai-responses'] as const,
  codexModels: ['test-model'],
  claudeModels: [],
  enabled: true,
}

describe('model service runtime option validation', () => {
  it('retains omission, false and zero in the source configuration', () => {
    expect(configuration().providers[0]).toMatchObject(service)
    expect(parseModelServiceRuntimeOptions({ codex: {} })).toEqual({ codex: {} })
  })

  it.each([
    { other: 'sensitive-unknown-field' },
    { codex: { invalid: 'secret' } },
    { codex: { supports_websockets: 0 } },
    { codex: { request_max_retries: -1 } },
    { codex: { stream_max_retries: 1.5 } },
    { codex: { request_max_retries: 4_294_967_296 } },
    { codex: { stream_idle_timeout_ms: Number.MAX_SAFE_INTEGER + 1 } },
    { codex: { stream_idle_timeout_ms: Infinity } },
    { codex: { http_headers: { 'bad name': 'secret' } } },
    { codex: { http_headers: { Authorization: 'secret\r\ninjected' } } },
    { codex: { http_headers: { Header: 'secret', header: 'secret' } } },
    { codex: { env_http_headers: { Header: 'not-an-env-name' } } },
    { codex: { http_headers: { Header: 'secret' }, env_http_headers: { header: 'EXTRA_HEADER' } } },
  ])('rejects malformed options without exposing supplied values: %j', value => {
    let error: unknown
    try {
      parseModelServiceRuntimeOptions(value)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/secret|sensitive-unknown-field|injected|not-an-env-name/)
  })
})

it('roundtrips write-only headers through Manager edits, replacement, patch deletion and clearing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-store-'))
  const file = path.join(root, 'config.json')
  try {
    await writeFile(file, JSON.stringify(configuration()))
    const read = await readModelServices(file, { SERVICE_KEY: 'private-key' })
    if (read.status !== 'ok') throw new Error('read unavailable')
    expect(JSON.stringify(read)).not.toMatch(/private-test-header|private-key/)
    expect(read.services[0]?.httpHeaderNames).toEqual(['X-Private'])
    const { http_headers: fixedHeaders, ...safeOptions } = options
    expect(read.services[0]?.runtimeOptions?.codex).toEqual(safeOptions)
    const save = async (edits: Record<string, unknown>) => {
      const current = await readModelServices(file, {})
      if (current.status !== 'ok') throw new Error('read unavailable')
      const request = parseModelServicesSaveRequest({
        expectedRevision: current.revision,
        services: [{ ...input, ...edits }],
      })
      if (!request) throw new Error('request invalid')
      expect(await saveModelServices(file, request)).toMatchObject({ status: 'applied' })
      return JSON.parse(await readFile(file, 'utf8')).providers[0].runtimeOptions
    }
    expect(await save({ displayName: 'Renamed' })).toEqual({ codex: options })
    expect(await save({ runtimeOptions: { codex: { supports_websockets: true } } })).toEqual({
      codex: { supports_websockets: true, http_headers: options.http_headers },
    })
    expect(await save({ httpHeadersPatch: { 'x-private': null, 'X-Another': 'new-private' } })).toEqual({
      codex: { supports_websockets: true, http_headers: { 'X-Another': 'new-private' } },
    })
    expect(await save({ runtimeOptions: null })).toBeNull()
    expect(await save({ displayName: 'After explicit clear' })).toBeNull()
    const current = await readModelServices(file, {})
    if (current.status !== 'ok') throw new Error('read unavailable')
    expect(current.services[0]).not.toHaveProperty('runtimeOptions')
    expect(current.services[0]).not.toHaveProperty('httpHeaderNames')
    expect(
      await saveModelServices(file, {
        expectedRevision: current.revision,
        services: [{ ...input, httpHeadersPatch: { Header: 'private\r\ninjected' } }],
      }),
    ).toEqual({ status: 'rejected', code: 'invalid' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('uses the same safe mapper for launch TOML, terminal and native configured request overrides', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-projection-'))
  try {
    const config = configuration([{
      ...service,
      runtimeOptions: {
        codex: {
          ...options,
          http_headers: { ...options.http_headers, 'X-Empty': '' },
        },
      },
    }])
    const mapped = modelServiceCodexProvider(config.providers[0] as Parameters<typeof modelServiceCodexProvider>[0])
    const environment = hostModelServiceEnvironment(
      { SERVICE_KEY: 'key', EXTRA_HEADER: 'env-secret' },
      [],
      undefined,
      config.providers,
    )
    expect(environment[modelServiceHeaderEnvironmentName(service.id, 'X-Private')]).toBe('private-test-header')
    expect(environment).not.toHaveProperty(modelServiceHeaderEnvironmentName(service.id, 'X-Empty'))
    expect(mapped.http_headers).toEqual({ 'X-Empty': '' })
    expect(() => hostModelServiceEnvironment(environment, [], undefined, config.providers)).toThrow(/conflicts/)
    const terminal = prepareSharedTerminalService(config, 'codex', service.id, 'test-model', {
      SERVICE_KEY: 'key',
      EXTRA_HEADER: 'env-secret',
    })
    expect(terminal?.provider).toEqual(mapped)
    expect(terminal?.environment).toEqual(environment)
    const claude = prepareSharedTerminalService(config, 'claude-code', service.id, 'claude-model', {
      SERVICE_KEY: 'key',
    })
    expect(claude?.provider).toBeUndefined()
    expect(JSON.stringify(claude)).not.toContain('stream_idle_timeout_ms')
    await writeFile(
      path.join(root, 'config.toml'),
      '[model_providers.runtime-service]\nrequest_max_retries=10\ncustom_native_option="keep"\n[model_providers.runtime-service.http_headers]\nStale="old-secret"\n',
    )
    await projectModelServicesToCodex(config.providers, root)
    const raw = await readFile(path.join(root, 'config.toml'), 'utf8')
    expect(raw).not.toMatch(/private-test-header|old-secret/)
    const definition = (parse(raw).model_providers as Record<string, unknown>)[service.id]
    expect(definition).toEqual({ ...mapped, custom_native_option: 'keep' })
    const catalog = mergeDeclaredIntoCodexProjection(await codexConfigModelProviders(root), config.providers)
    expect(catalog.providers).toEqual([expect.objectContaining({ providerId: service.id })])
    expect(JSON.stringify(catalog)).not.toMatch(/private-test-header|X-Private|X-Empty|EXTRA_HEADER|env_http_headers/)
    const admitted = await configuredEncryptedReplay(root, () => 'http://127.0.0.1:1234/route', config.providers)(
      service.id,
    )
    expect(admitted[`model_providers.${service.id}`]).toEqual({
      ...mapped,
      base_url: 'http://127.0.0.1:1234/route',
      custom_native_option: 'keep',
    })
    expect(JSON.stringify(admitted)).not.toContain('private-test-header')
    await projectModelServicesToCodex(configuration([{ ...service, runtimeOptions: { codex: {} } }]).providers, root)
    const cleared = (parse(await readFile(path.join(root, 'config.toml'), 'utf8')).model_providers as Record<
      string,
      Record<string, unknown>
    >)[service.id]!
    expect(cleared).toMatchObject({ custom_native_option: 'keep' })
    expect(cleared.request_max_retries).toBeUndefined()
    expect(cleared.env_http_headers).toBeUndefined()
    await projectModelServicesToCodex(config.providers, root)
    await projectModelServicesToCodex([], root)
    expect(
      (parse(await readFile(path.join(root, 'config.toml'), 'utf8')).model_providers as Record<string, unknown>)[
        service.id
      ],
    ).toEqual(cleared)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a secret-only external edit inside the full-array CAS boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-header-cas-'))
  const filename = path.join(root, 'config.json')
  try {
    await writeFile(filename, JSON.stringify(configuration()))
    const before = await readModelServices(filename, {})
    if (before.status !== 'ok') throw new Error('missing model services')
    await writeFile(
      filename,
      JSON.stringify(configuration([{
        ...service,
        runtimeOptions: {
          codex: {
            ...options,
            http_headers: { 'X-Private': 'different-private-value' },
          },
        },
      }])),
    )
    const after = await readModelServices(filename, {})
    if (after.status !== 'ok') throw new Error('missing model services')
    expect(after.services).toEqual(before.services)
    expect(after.revision).not.toBe(before.revision)
    expect(await saveModelServices(filename, { expectedRevision: before.revision, services: [input] }))
      .toMatchObject({ status: 'rejected', code: 'conflict' })
    expect(await readFile(filename, 'utf8')).toContain('different-private-value')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('projects explicit null over a never-projected native table and leaves only cleared ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-explicit-clear-'))
  const filename = path.join(root, 'config.toml')
  try {
    await writeFile(
      filename,
      '[model_providers.runtime-service]\nrequest_max_retries=9\ncustom_option="keep"\n[model_providers.runtime-service.http_headers]\n"X-Old"="old-literal"\n',
    )
    const config = configuration([{ ...service, runtimeOptions: null }])
    await projectModelServicesToCodex(config.providers, root)
    const raw = await readFile(filename, 'utf8')
    expect(raw).toContain('# cordisx-cleared-model-service-options')
    expect(raw).not.toMatch(/request_max_retries|X-Old|old-literal/)
    expect(raw).toContain('custom_option = "keep"')
    expect(await configuredEncryptedReplay(root, () => 'http://127.0.0.1:1234/route', config.providers)(service.id))
      .toMatchObject({ 'cordisx.model_service_options': [service.id] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
