import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { createDefaultHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ManagedProviderOwner } from '../packages/cli/src/launcher/model-catalog/managed-provider-owner.js'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import { codexConfigModelProviders } from '../packages/cli/src/launcher/codex-config-model-providers.js'
import {
  CompositeCatalogManagement,
  NativeCatalogManagement,
} from '../packages/cli/src/launcher/model-catalog/native-catalog-management.js'
import {
  decodePortableBundle,
  encodePortableBundle,
  type PortableBundle,
  portableConnection,
} from '../packages/cli/src/launcher/model-catalog/portable-transfer-codec.js'
import {
  MANAGED_PROVIDER_CAPTURE_SCRIPT,
  managedProviderCaptureArguments,
} from '../packages/cli/src/launcher/model-catalog/managed-provider-capture.js'

vi.mock('../packages/cli/src/launcher/process-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/cli/src/launcher/process-identity.js')>(),
  liveProcessStartedAt: () => 'fixture-process-start',
}))

const connection = (endpoint = 'https://openrouter.ai/api/v1') =>
  portableConnection({
    title: 'OpenRouter',
    endpoint,
    protocol: 'responses',
    auth: 'bearer',
    models: [{
      id: 'exact-model',
      label: 'Exact model',
      protocolCapabilities: { responses: true },
      reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'low' },
    }],
  })
const bundle = (...connections: PortableBundle['connections'][number][]): PortableBundle => ({
  version: 1,
  connections,
})
const untrustedText = (value: unknown) =>
  `cordisx-models-v1.${deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64url')}`

describe('portable model transfer', () => {
  const owners: ManagedProviderOwner[] = []
  const homes: string[] = []
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close()
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })

  it('round trips only one selected model with explicit per-model capabilities', () => {
    const payload = bundle(connection())
    const text = encodePortableBundle(payload)
    expect(text).toMatch(/^cordisx-models-v1\.[A-Za-z0-9_-]+$/u)
    expect(decodePortableBundle(text)).toEqual(payload)
    expect(text).not.toContain('exact-model')
  })

  it('round trips v2 variables while omitting values unless they are explicitly supplied', () => {
    const selected = portableConnection({
      title: 'Environment service',
      endpoint: 'https://openrouter.ai/api/v1',
      protocol: 'responses',
      auth: 'bearer',
      environment: 'MODEL_KEY',
      models: [{ id: 'exact-model', label: 'Exact model' }],
    })
    const withoutValue: PortableBundle = {
      version: 2,
      environment: [{ name: 'MODEL_KEY', description: 'Model service key' }],
      connections: [selected],
    }
    const withoutValueText = encodePortableBundle(withoutValue)
    expect(withoutValueText).toMatch(/^cordisx-models-v2\.[A-Za-z0-9_-]+$/u)
    expect(decodePortableBundle(withoutValueText)).toEqual(withoutValue)
    expect(JSON.stringify(decodePortableBundle(withoutValueText))).not.toContain('fixture-secret')

    const withValue: PortableBundle = {
      ...withoutValue,
      environment: [{ name: 'MODEL_KEY', value: 'fixture-secret', description: 'Model service key' }],
    }
    expect(decodePortableBundle(encodePortableBundle(withValue))).toEqual(withValue)
  })

  it('round trips a v3 shell generator without exporting its current value', () => {
    const selected = portableConnection({
      title: 'Generated environment service',
      endpoint: 'https://openrouter.ai/api/v1',
      protocol: 'responses',
      auth: 'bearer',
      environment: 'MODEL_KEY',
      models: [{ id: 'exact-model', label: 'Exact model' }],
    })
    const payload: PortableBundle = {
      version: 3,
      environment: [{
        name: 'MODEL_KEY',
        description: 'Generated locally',
        generator: { kind: 'shell', script: "printf 'literal $(ordinary data)'" },
      }],
      connections: [selected],
    }
    const text = encodePortableBundle(payload)
    expect(text).toMatch(/^cordisx-models-v3\.[A-Za-z0-9_-]+$/u)
    expect(decodePortableBundle(text)).toEqual(payload)
    expect(JSON.stringify(decodePortableBundle(text))).not.toContain('current-secret')
  })

  it('rejects secret-like and unknown endpoint paths rather than copying them', () => {
    expect(() => connection('https://gateway.example/key/sk-demo-not-secret')).toThrow('invalid')
    expect(() => connection('https://gateway.example/custom/tenant')).toThrow('invalid')
    expect(() => connection('https://opencode.ai/zen/go/v1')).not.toThrow()
    expect(() => connection('https://api.deepseek.com')).not.toThrow()
    expect(() => connection('https://openrouter.ai/api/v1')).not.toThrow()
  })

  it('rejects malformed, oversized, unsupported, and hostile clipboard bundles', () => {
    const valid = bundle(connection())
    expect(() => decodePortableBundle('cordisx-models-v2.bad')).toThrow('invalid')
    expect(() => decodePortableBundle('x'.repeat(48_001))).toThrow('invalid')
    expect(() => decodePortableBundle(untrustedText({ ...valid, version: 2 }))).toThrow('invalid')
    expect(() =>
      decodePortableBundle(untrustedText({
        ...valid,
        connections: [{ ...valid.connections[0], endpoint: 'https://evil.example/key/sk-demo-not-secret' }],
      }))
    ).toThrow('invalid')
    expect(() =>
      decodePortableBundle(untrustedText({
        ...valid,
        connections: [{ ...valid.connections[0], secret: 'fixture-secret' }],
      }))
    ).toThrow('invalid')
  })

  it('keeps native secret-path endpoints private and validates exact model selections', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'portable-native-'))
    homes.push(home)
    await writeFile(
      path.join(home, 'config.toml'),
      [
        '[model_providers.gateway]',
        'name = "Gateway"',
        'base_url = "https://gateway.example/key/sk-demo-not-secret"',
        'env_key = "DUMMY_KEY"',
      ].join('\n'),
    )
    const unsafe = await codexConfigModelProviders(home)
    expect(unsafe.portableConnections?.has('gateway')).toBe(false)
    const native = await NativeCatalogManagement.open({
      load: async () => ({
        providers: [{
          providerId: 'gateway',
          pluginId: 'cordisx.codex-config',
          title: 'Gateway',
          models: [
            { id: 'one', label: 'One', aliases: [] },
            { id: 'two', label: 'Two', aliases: [] },
          ],
        }],
        providerIds: new Set(['gateway']),
        providerWireApis: new Map([['gateway', 'responses' as const]]),
        portableConnections: new Map([['gateway', {
          endpoint: 'https://openrouter.ai/api/v1',
          protocol: 'responses' as const,
          auth: 'bearer' as const,
        }]]),
        sourceAvailable: true,
        diagnostics: [],
      }),
    })
    const management = new CompositeCatalogManagement(native)
    try {
      const selected = await management.export({
        selections: [{
          bindingRef: 'codex-config:gateway',
          modelIds: ['one'],
        }],
        includeValues: false,
        variables: [],
      }, () => true)
      expect(selected.status).toBe('ok')
      if (selected.status === 'ok') {
        expect(decodePortableBundle(selected.text).connections[0]?.models.map(model => model.id)).toEqual(['one'])
      }
      expect(
        await management.export({
          selections: [{
            bindingRef: 'codex-config:gateway',
            modelIds: ['missing'],
          }],
          includeValues: false,
          variables: [],
        }, () => true),
      ).toMatchObject({ status: 'rejected', code: 'invalid' })
      expect(
        await management.export({
          selections: [{
            bindingRef: 'plugin:sample',
            modelIds: ['one'],
          }],
          includeValues: false,
          variables: [],
        }, () => true),
      ).toMatchObject({ status: 'rejected', code: 'invalid' })
    } finally {
      management.close()
    }
  })

  it('exports a command-auth native model without executing or exposing the credential command', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'portable-command-auth-'))
    homes.push(home)
    const privateKeyPath = path.join(home, 'private-provider-key')
    await writeFile(privateKeyPath, 'fixture-private-key')
    await writeFile(
      path.join(home, 'models.json'),
      JSON.stringify({ models: [{ slug: 'exact-command-model', display_name: 'Exact command model' }] }),
    )
    await writeFile(
      path.join(home, 'config.toml'),
      [
        '[model_providers.command]',
        'name = "Command Provider"',
        'base_url = "https://openrouter.ai/api/v1"',
        'wire_api = "responses"',
        '[model_providers.command.auth]',
        'command = "/bin/cat"',
        `args = [${JSON.stringify(privateKeyPath)}]`,
        'refresh_interval_ms = 0',
      ].join('\n'),
    )
    const projection = await codexConfigModelProviders(home, { command: 'models.json' })
    expect(projection.portableEnvironment?.get('command')).toEqual({ placeholder: true })
    const native = await NativeCatalogManagement.open({ load: async () => projection })
    const management = new CompositeCatalogManagement(native)
    try {
      const selections = [{ bindingRef: 'codex-config:command', modelIds: ['exact-command-model'] }]
      const prepared = management.prepareExport({ selections }, () => true)
      expect(prepared).toEqual({
        status: 'ok',
        variables: [expect.objectContaining({
          sourceName: 'CORDISX_MODEL_SERVICE_KEY',
          name: 'CORDISX_MODEL_SERVICE_KEY',
          value: '',
          available: false,
        })],
      })
      const selected = await management.export({
        selections,
        includeValues: false,
        variables: [{
          sourceName: 'CORDISX_MODEL_SERVICE_KEY',
          name: 'COMMAND_KEY',
          value: 'user-entered-value',
        }],
      }, () => true)
      expect(selected.status).toBe('ok')
      if (selected.status === 'ok') {
        const decoded = decodePortableBundle(selected.text)
        expect(decoded).toEqual({
          version: 2,
          environment: [{ name: 'COMMAND_KEY' }],
          connections: [{
            transferId: expect.any(String),
            title: 'Command Provider',
            endpoint: 'https://openrouter.ai/api/v1',
            protocol: 'responses',
            auth: 'bearer',
            environment: 'COMMAND_KEY',
            models: [{ id: 'exact-command-model', label: 'Exact command model' }],
          }],
        })
        expect(JSON.stringify(decoded)).not.toMatch(
          /bin\/cat|private-provider-key|fixture-private-key|timeout_ms|refresh_interval_ms/u,
        )
      }
      const withValue = await management.export({
        selections,
        includeValues: true,
        variables: [{
          sourceName: 'CORDISX_MODEL_SERVICE_KEY',
          name: 'COMMAND_KEY',
          value: 'user-entered-value',
        }],
      }, () => true)
      expect(withValue.status).toBe('ok')
      if (withValue.status === 'ok') {
        const decoded = decodePortableBundle(withValue.text)
        expect(decoded.version === 2 ? decoded.environment : []).toEqual([
          { name: 'COMMAND_KEY', value: 'user-entered-value' },
        ])
      }
    } finally {
      management.close()
    }
  })

  it('prepares only selected environment dependencies and exports values only by explicit opt-in', async () => {
    const native = await NativeCatalogManagement.open({
      load: async () => ({
        providers: [
          {
            providerId: 'inline',
            pluginId: 'cordisx.codex-config',
            title: 'Inline provider',
            models: [{ id: 'inline-model', label: 'Inline model', aliases: [] }],
          },
          {
            providerId: 'named',
            pluginId: 'cordisx.codex-config',
            title: 'Named provider',
            models: [{ id: 'named-model', label: 'Named model', aliases: [] }],
          },
        ],
        providerIds: new Set(['inline', 'named']),
        providerWireApis: new Map([
          ['inline', 'responses' as const],
          ['named', 'responses' as const],
        ]),
        portableConnections: new Map([
          ['inline', {
            endpoint: 'https://openrouter.ai/api/v1',
            protocol: 'responses' as const,
            auth: 'bearer' as const,
          }],
          ['named', { endpoint: 'https://api.deepseek.com', protocol: 'responses' as const, auth: 'bearer' as const }],
        ]),
        portableEnvironment: new Map([
          ['inline', { value: 'inline-value', placeholder: true }],
          ['named', { name: 'CORDISX_MODEL_SERVICE_KEY', placeholder: false }],
        ]),
        sourceAvailable: true,
        diagnostics: [],
      }),
    })
    const managed = {
      snapshot: () => ({ epoch: 'managed', sequence: 0, views: [], canCreateConnection: true }),
      command: async () => ({ status: 'rejected' as const, code: 'unsupported' as const }),
      subscribe: () => () => {},
      environmentEntries: () => [{
        name: 'CORDISX_MODEL_SERVICE_KEY',
        value: 'named-value',
        enabled: true,
        description: 'Named key',
      }],
    }
    const management = new CompositeCatalogManagement(native, managed)
    try {
      const selections = [
        { bindingRef: 'codex-config:inline', modelIds: ['inline-model'] },
        { bindingRef: 'codex-config:named', modelIds: ['named-model'] },
      ]
      const prepared = management.prepareExport({ selections }, () => true)
      expect(prepared).toEqual({
        status: 'ok',
        variables: [
          expect.objectContaining({
            sourceName: 'CORDISX_MODEL_SERVICE_KEY_1',
            value: 'inline-value',
            bindings: ['codex-config:inline'],
          }),
          expect.objectContaining({
            sourceName: 'CORDISX_MODEL_SERVICE_KEY',
            value: 'named-value',
            description: 'Named key',
            bindings: ['codex-config:named'],
          }),
        ],
      })
      if (prepared.status !== 'ok') throw new Error('unexpected preparation failure')
      const variables = prepared.variables.map(variable => ({
        sourceName: variable.sourceName,
        name: variable.name,
        value: variable.value,
        ...(variable.description === undefined ? {} : { description: variable.description }),
      }))
      const withoutValues = await management.export({ selections, includeValues: false, variables }, () => true)
      expect(withoutValues.status).toBe('ok')
      if (withoutValues.status === 'ok') {
        const decoded = decodePortableBundle(withoutValues.text)
        expect(decoded.version).toBe(2)
        if (decoded.version === 2) {
          expect(decoded.environment.every(variable => variable.value === undefined)).toBe(true)
        }
      }
      const withValues = await management.export({ selections, includeValues: true, variables }, () => true)
      expect(withValues.status).toBe('ok')
      if (withValues.status === 'ok') {
        const decoded = decodePortableBundle(withValues.text)
        expect(decoded.version).toBe(2)
        if (decoded.version === 2) {
          expect(decoded.environment.map(variable => variable.value))
            .toEqual(['inline-value', 'named-value'])
        }
      }
    } finally {
      management.close()
    }
  })

  it('imports keyless atomically, preserves exact metadata, and skips only the same transfer identity', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'portable-transfer-'))
    homes.push(homeDir)
    const initial = createDefaultHomeConfig()
    const configPath = path.join(homeDir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        ...initial,
        apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
      }),
      { mode: 0o600 },
    )
    const owner = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(owner)
    const first = bundle(connection())
    const result = await owner.importPortable(decodePortableBundle(encodePortableBundle(first)))
    expect(result).toMatchObject({ imported: 1, skipped: 0 })
    const view = owner.snapshot()[0]!
    expect(view.credentialState).toBe('unset')
    expect(view.settings.strategy).toEqual({ kind: 'manual', ids: ['exact-model'] })
    expect(view.settings.models).toEqual(first.connections[0]!.models)
    expect(owner.connection(view.id)).toBeUndefined()
    await expect(owner.nativeConnection(view.id)).rejects.toMatchObject({ code: 'unsupported' })
    expect(await owner.importPortable(first)).toMatchObject({ imported: 0, skipped: 1 })
    expect(owner.snapshot()).toHaveLength(1)
    const second = bundle(connection())
    expect(await owner.importPortable(second)).toMatchObject({ imported: 1, skipped: 0 })
    expect(owner.snapshot()).toHaveLength(2)
    const before = await readFile(configPath, 'utf8')
    await expect(owner.importPortable(bundle(connection(), {
      ...first.connections[0]!,
      endpoint: 'https://api.deepseek.com',
    }))).rejects.toThrow('source-invalid')
    expect(await readFile(configPath, 'utf8')).toBe(before)
    await owner.close()
    const reopened = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(reopened)
    expect(reopened.snapshot()).toHaveLength(2)
    expect(reopened.snapshot()[0]?.credentialState).toBe('unset')
    expect(reopened.snapshot()[0]?.settings.models).toEqual(first.connections[0]?.models)
    expect(await reopened.importPortable(first)).toMatchObject({ imported: 0, skipped: 1 })
    await reopened.close()
    const capture = vi.fn(async (_signal: AbortSignal, _endpoint: string) => 'fixture-key')
    const composition = await ManagedCatalogComposition.open({
      homeDir,
      profileId: 'test',
      responsesAvailable: true,
      capture,
    })
    try {
      const imported = composition.snapshot().views[0]!
      const scope = {
        bindingRef: imported.bindingRef,
        scopeRevision: imported.scopeRevision,
        expectedRevision: imported.revision,
      }
      expect(
        await composition.command({
          ...scope,
          expectedRevision: 'stale-revision',
          operation: 'requestCredentialReplacement',
        }, () => true),
      ).toMatchObject({ status: 'conflict' })
      expect(capture).not.toHaveBeenCalled()
      expect(await composition.command({ ...scope, operation: 'requestCredentialReplacement' }, () => true))
        .toMatchObject({ status: 'applied' })
      expect(capture).toHaveBeenCalledOnce()
      expect(capture.mock.calls[0]?.[1]).toBe('https://openrouter.ai/api/v1')
      expect(composition.snapshot().views[0]?.credentialState).toBe('set')
    } finally {
      await composition.close()
    }
  })

  it('imports v2 variables atomically, allocates collisions, rewrites references, and uses them after reload', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'portable-environment-transfer-'))
    homes.push(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        environmentVariables: [{ name: 'DESTINATION_KEY', value: 'existing-value', enabled: true }],
        apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
      }),
      { mode: 0o600 },
    )
    const first = portableConnection({
      title: 'First environment service',
      endpoint: 'https://openrouter.ai/api/v1',
      protocol: 'responses',
      auth: 'bearer',
      environment: 'SOURCE_ONE',
      models: [{ id: 'first-model', label: 'First model' }],
    })
    const second = portableConnection({
      title: 'Second environment service',
      endpoint: 'https://api.deepseek.com',
      protocol: 'responses',
      auth: 'bearer',
      environment: 'SOURCE_TWO',
      models: [{ id: 'second-model', label: 'Second model' }],
    })
    const transferable: PortableBundle = {
      version: 2,
      environment: [{ name: 'SOURCE_ONE' }, { name: 'SOURCE_TWO', value: 'prefilled-value' }],
      connections: [first, second],
    }
    const owner = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(owner)
    expect(owner.preparePortableImport(transferable)).toEqual([
      expect.objectContaining({ sourceName: 'SOURCE_ONE', name: 'SOURCE_ONE', value: '' }),
      expect.objectContaining({ sourceName: 'SOURCE_TWO', name: 'SOURCE_TWO', value: 'prefilled-value' }),
    ])
    const beforeInvalid = await readFile(configPath, 'utf8')
    await expect(owner.importPortable(transferable, [
      { sourceName: 'SOURCE_ONE', name: 'DESTINATION_KEY', value: 'first-value', enabled: true },
      { sourceName: 'SOURCE_TWO', name: 'invalid-name', value: 'second-value', enabled: true },
    ])).rejects.toThrow('source-invalid')
    expect(await readFile(configPath, 'utf8')).toBe(beforeInvalid)

    const imported = await owner.importPortable(transferable, [
      { sourceName: 'SOURCE_ONE', name: 'DESTINATION_KEY', value: 'first-value', enabled: true },
      { sourceName: 'SOURCE_TWO', name: 'DESTINATION_KEY', value: 'second-value', enabled: true },
    ])
    expect(imported).toMatchObject({ imported: 2, skipped: 0 })
    const saved = await loadHomeConfig(configPath)
    expect(saved.environmentVariables).toEqual([
      { name: 'DESTINATION_KEY', value: 'existing-value', enabled: true },
      { name: 'DESTINATION_KEY_1', value: 'first-value', enabled: true },
      { name: 'DESTINATION_KEY_2', value: 'second-value', enabled: true },
    ])
    const records = saved.apps.codex?.profiles.test?.managedProviders ?? []
    expect(records.map(record => record.environmentReference)).toEqual(['DESTINATION_KEY_1', 'DESTINATION_KEY_2'])
    await owner.close()

    const reopened = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(reopened)
    const firstSession = await reopened.nativeConnection(imported.bindingRefs[0]!)
    const secondSession = await reopened.nativeConnection(imported.bindingRefs[1]!)
    expect(firstSession.value.endpoint.auth).toEqual({ scheme: 'bearer', token: 'first-value' })
    expect(secondSession.value.endpoint.auth).toEqual({ scheme: 'bearer', token: 'second-value' })
  })

  it('preserves a v3 generator when the imported environment variable is renamed', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'portable-generator-transfer-'))
    homes.push(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        environmentVariables: [{ name: 'DESTINATION_KEY', value: 'existing-value', enabled: true }],
        apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
      }),
      { mode: 0o600 },
    )
    const connection = portableConnection({
      title: 'Generated service',
      endpoint: 'https://openrouter.ai/api/v1',
      protocol: 'responses',
      auth: 'bearer',
      environment: 'SOURCE_KEY',
      models: [{ id: 'generated-model', label: 'Generated model' }],
    })
    const transferable: PortableBundle = {
      version: 3,
      environment: [{
        name: 'SOURCE_KEY',
        generator: { kind: 'shell', script: "printf 'generated-value'" },
      }],
      connections: [connection],
    }
    const owner = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(owner)
    expect(owner.preparePortableImport(transferable)).toEqual([
      expect.objectContaining({
        sourceName: 'SOURCE_KEY',
        name: 'SOURCE_KEY',
        generator: { kind: 'shell', script: "printf 'generated-value'" },
      }),
    ])
    await owner.importPortable(transferable, [{
      sourceName: 'SOURCE_KEY',
      name: 'DESTINATION_KEY',
      value: 'generated-value',
      enabled: true,
      generator: { kind: 'shell', script: "printf 'generated-value'" },
    }])
    const saved = await loadHomeConfig(configPath)
    expect(saved.environmentVariables).toEqual([
      { name: 'DESTINATION_KEY', value: 'existing-value', enabled: true },
      {
        name: 'DESTINATION_KEY_1',
        value: 'generated-value',
        enabled: true,
        generator: { kind: 'shell', script: "printf 'generated-value'" },
      },
    ])
    expect(saved.apps.codex?.profiles.test?.managedProviders?.[0]?.environmentReference)
      .toBe('DESTINATION_KEY_1')
  })

  it('treats a managed environment reference as authoritative over a stale inline secret', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'managed-environment-authority-'))
    homes.push(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    const record = {
      id: 'a'.repeat(43),
      revision: 'b'.repeat(43),
      scopeRevision: 'c'.repeat(43),
      credentialRevision: 'd'.repeat(43),
      credentialRef: 'e'.repeat(43),
      environmentReference: 'MODEL_KEY',
      secret: 'stale-inline-secret',
      settings: {
        title: 'Environment authority',
        endpoint: 'https://openrouter.ai/api/v1',
        protocol: 'responses' as const,
        discoveryEnabled: true,
        strategy: { kind: 'auto' as const, mode: 'augment' as const, adapter: 'detect' as const, ttlMs: 60_000 },
        supplement: [],
      },
    }
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        environmentVariables: [{ name: 'MODEL_KEY', value: 'disabled-value', enabled: false }],
        apps: {
          codex: {
            defaultProfile: 'test',
            profiles: { test: { displayName: 'Test', dataMode: 'shared', managedProviders: [record] } },
          },
        },
      }),
      { mode: 0o600 },
    )
    const owner = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(owner)
    expect(owner.snapshot()[0]?.credentialState).toBe('unset')
    await expect(owner.nativeConnection(record.id)).rejects.toMatchObject({ code: 'unsupported' })

    await owner.saveEnvironment([{ name: 'MODEL_KEY', value: 'enabled-value', enabled: true }])
    expect(owner.snapshot()[0]?.credentialState).toBe('set')
    const session = await owner.nativeConnection(record.id)
    expect(session.value.endpoint.auth).toEqual({ scheme: 'bearer', token: 'enabled-value' })

    const externallyChanged = {
      ...await loadHomeConfig(configPath),
      environmentVariables: [{ name: 'MODEL_KEY', value: 'external-value', enabled: true }],
    }
    await writeFile(configPath, JSON.stringify(externallyChanged), { mode: 0o600 })
    const beforeConflict = await readFile(configPath, 'utf8')
    await expect(owner.saveEnvironment([
      { name: 'MODEL_KEY', value: 'overwritten-value', enabled: true },
    ])).rejects.toThrow('source-invalid')
    expect(await readFile(configPath, 'utf8')).toBe(beforeConflict)
  })

  it('imports 286 selected models across restart and still permits adding a key', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'portable-large-transfer-'))
    homes.push(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
      }),
      { mode: 0o600 },
    )
    const models = Array.from({ length: 286 }, (_, index) => ({
      id: `openrouter/vendor-model-${String(index).padStart(3, '0')}`,
      label: `Vendor Model ${String(index).padStart(3, '0')} Extended`,
    }))
    const large = bundle(portableConnection({
      title: 'OpenRouter fixture',
      endpoint: 'https://openrouter.ai/api/v1',
      protocol: 'responses',
      auth: 'bearer',
      models,
    }))
    const text = encodePortableBundle(large)
    const decoded = decodePortableBundle(text)
    expect(decoded.connections[0]?.models).toEqual(models)
    const owner = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(owner)
    expect(await owner.importPortable(decoded)).toMatchObject({ imported: 1, skipped: 0 })
    expect(owner.snapshot()[0]?.credentialState).toBe('unset')
    expect(owner.snapshot()[0]?.settings.models).toEqual(models)
    await owner.close()
    const reopened = await ManagedProviderOwner.open({ homeDir, profileId: 'test' })
    owners.push(reopened)
    expect(reopened.snapshot()).toHaveLength(1)
    expect(reopened.snapshot()[0]?.settings.models).toEqual(models)
    expect(await reopened.importPortable(decodePortableBundle(text))).toMatchObject({ imported: 0, skipped: 1 })
    expect(reopened.snapshot()).toHaveLength(1)
    const imported = reopened.snapshot()[0]!
    const keyed = await reopened.save(
      { id: imported.id, expectedRevision: imported.revision, settings: imported.settings },
      async () => 'fixture-key',
    )
    expect(keyed.credentialState).toBe('set')
    expect(keyed.settings.models).toEqual(models)
    expect(await reopened.importPortable(decodePortableBundle(text))).toMatchObject({ imported: 0, skipped: 1 })
  })

  it('passes the exact canonical destination as data to the static native key prompt', () => {
    const args = managedProviderCaptureArguments('https://openrouter.ai/api/v1')
    expect(args.at(-1)).toBe('https://openrouter.ai/api/v1')
    expect(args.at(-2)).toBe(MANAGED_PROVIDER_CAPTURE_SCRIPT)
    expect(MANAGED_PROVIDER_CAPTURE_SCRIPT).toContain('argv[0]')
    expect(MANAGED_PROVIDER_CAPTURE_SCRIPT).toContain('destination:')
    expect(MANAGED_PROVIDER_CAPTURE_SCRIPT).not.toContain('openrouter.ai')
  })
})
