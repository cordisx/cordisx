import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlatformProviderBrokerBindingV1 } from '@cordisx/protocol/platform-provider/v1'
import { CapabilityRiskCatalog } from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V9,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV9 } from '../packages/cli/src/permission-model-v4.js'
import {
  HostBoundPlatformProviderBrokerV1,
  HostPlatformProviderConfigurationRegistryV1,
  issuePlatformProviderBrokerPolicy,
  PlatformProviderServiceHostV1,
  PlatformProviderWorkspaceAuthority,
} from '../packages/cli/src/launcher/platform-provider-service.js'
import {
  removeStagedPluginPackage,
  stagedPluginServiceModulePath,
} from '../packages/cli/src/launcher/plugin-package.js'
import { stagePluginPackageSourceV1 } from '../packages/cli/src/launcher/packages/index.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import { providerConnection } from '../packages/cli/src/launcher/platform-provider-connection.js'
import { factoryConfiguration } from '../packages/cli/src/launcher/platform-provider-validation.js'
import { validLifecycleEvent } from '../packages/cli/src/launcher/platform-provider-validation.js'

const roots = new Set<string>()
const schema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/cli-proxy-provider-runtime-config.v1.schema.json'
const valueSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-value.v1.schema.json'
const binding: PlatformProviderBrokerBindingV1 = {
  operation: 'models.list',
  direction: 'request',
  method: 'model/list',
  requestSchema: valueSchema,
  resultSchema: valueSchema,
}

afterEach(async () => {
  delete (globalThis as { __platformProviderTest?: unknown }).__platformProviderTest
  await Promise.all([...roots].map(async root => {
    const homeDir = path.join(root, 'home')
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(
      digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`).catch(() => undefined)),
    )
    await rm(root, { recursive: true, force: true })
  }))
  roots.clear()
})

function owner() {
  return {
    ownerHandle: 'ppo_owner-1' as const,
    pluginId: 'provider-plugin',
    serviceId: 'providers-runtime',
    sourceDigest: `sha256:${'a'.repeat(64)}` as const,
    hostGeneration: 'host-1',
    pluginGeneration: 'plugin-1',
  }
}

describe('generic Platform provider Host service', () => {
  it('binds broker calls to the Host catalog and rejects raw authority values', async () => {
    expect(() =>
      issuePlatformProviderBrokerPolicy({
        owner: owner(),
        providerId: 'gateway-a',
        providerGeneration: 'provider-1',
        operations: ['models.list'],
        request: { bindings: [{ ...binding, method: 'thread/delete' }] },
        catalog: { catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] },
      })
    ).toThrow('unsupported by the Host catalog')

    const policy = issuePlatformProviderBrokerPolicy({
      owner: owner(),
      providerId: 'gateway-a',
      providerGeneration: 'provider-1',
      operations: ['models.list'],
      request: { bindings: [binding] },
      catalog: { catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] },
    })
    const broker = new HostBoundPlatformProviderBrokerV1(policy, {
      exchange: async (_method, params) => params,
      subscribe: () => () => undefined,
      respond: async () => {},
      dispose: async () => {},
    })
    await expect(broker.exchange({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
      contract: 'cordisx.platform-provider-broker-request/v1',
      schemaVersion: 1,
      requestId: 'request-1',
      operation: 'models.list',
      method: 'model/list',
      requestSchema: valueSchema,
      params: { SeCrEtRef: 'hidden', EndPointURL: 'https://gateway.example' },
    })).resolves.toMatchObject({ status: 'rejected', code: 'invalid-request' })
    await broker.dispose()
  })

  it('stages a v9 package service, publishes it into one Fleet, and drains before disposal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-platform-provider-'))
    roots.add(root)
    const source = path.join(root, 'source')
    const homeDir = path.join(root, 'home')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await writeFile(path.join(source, 'src/index.js'), 'export function apply() {}\n')
    await writeFile(
      path.join(source, 'src/provider.js'),
      `
export async function apply(ctx, input) {
  const configuration = input.configurations[0]
  globalThis.__platformProviderTest = { ...globalThis.__platformProviderTest, configuration, events: [] }
  globalThis.__platformProviderTest.registration = await ctx.platformProviders.register({
    descriptor: {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-descriptor.v1.schema.json',
      contract: 'cordisx.platform-provider-descriptor/v1',
      schemaVersion: 1,
      providerId: configuration.providerId,
      displayName: configuration.displayName,
      implementationStatus: 'experimental',
      operations: ['models.list'],
    },
    mapping: globalThis.__platformProviderTest.mappingMismatch ? { models: [] } : configuration.mapping ?? { models: [] },
    brokerRequest: { bindings: [{
      operation: 'models.list', direction: 'request', method: 'model/list',
      requestSchema: '${valueSchema}', resultSchema: '${valueSchema}',
    }] },
    async createAdapter(factory) {
      if ('endpoint' in factory.configuration || 'secretRef' in factory.configuration || 'transport' in factory.broker) {
        throw new Error('private authority leaked to factory')
      }
      const probe = await factory.broker.exchange({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
        contract: 'cordisx.platform-provider-broker-request/v1', schemaVersion: 1,
        requestId: 'probe', operation: 'models.list', method: 'model/list',
        requestSchema: '${valueSchema}', params: {},
      }, factory.signal)
      if (probe.status !== 'accepted') throw new Error('broker probe failed')
      return {
        providerId: factory.providerId,
        providerGeneration: factory.providerGeneration,
        models: { list: async () => ({ ok: true, value: { models: [{ ref: { providerId: factory.providerId, modelId: 'model-a' }, label: 'Model A' }] } }) },
        sessions: {
          list: async () => ({ ok: true, value: { sessions: [] } }),
          read: async () => ({ ok: false, error: { code: 'session-not-found', message: 'missing' } }),
          create: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        },
        turns: {
          submit: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          introduce: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        },
        approvals: { decide: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }) },
        subscribeLifecycle: () => {
          if (globalThis.__platformProviderTest.disposeDuringSubscribe) {
            globalThis.__platformProviderTest.registrationDisposal = globalThis.__platformProviderTest.registration.dispose()
          }
          return { subscriptionId: 'ppls_test', unsubscribe() { globalThis.__platformProviderTest.events.push('unsubscribe') } }
        },
        async drain() { globalThis.__platformProviderTest.events.push('drain') },
        async dispose() { globalThis.__platformProviderTest.events.push('dispose') },
      }
    },
  })
}
`,
    )
    const runtime = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
      schemaVersion: 9,
      id: 'provider-plugin',
      capabilities: [],
      services: [{
        id: 'providers-runtime',
        kind: 'platform-provider',
        owner: 'host',
        schema,
        applicationMode: 'service-restart',
        entry: './src/provider.js',
      }],
    }
    const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
    await writeFile(path.join(source, 'runtime.json'), runtimeText)
    await writeFile(
      path.join(source, 'cordisx-package.json'),
      `${
        JSON.stringify(
          {
            $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V9,
            schemaVersion: 9,
            id: runtime.id,
            version: '1.0.0',
            entry: './src/index.js',
            distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
            compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V9] },
            dependencies: [],
            runtimeManifest: {
              path: './runtime.json',
              schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
              digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
            },
          },
          null,
          2,
        )
      }\n`,
    )
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    }, {
      homeDir,
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V9]: value =>
          normalizePluginManifestV9(value, runtime.id, new CapabilityRiskCatalog()),
      },
    })
    expect(staged.serviceModules).toEqual([
      expect.objectContaining({ declaration: expect.objectContaining({ kind: 'platform-provider' }) }),
    ])

    const fleet = await ProviderFleet.create([])
    let releasePrior = (): void => {}
    let priorCloseStarted = false
    const priorClose = new Promise<void>(resolve => {
      releasePrior = resolve
    })
    await fleet.publishConnections([{
      connection: {
        providerId: 'gateway-a',
        generation: 'prior-generation',
        status: () => ({
          providerId: 'gateway-a',
          displayName: 'Prior',
          generation: 'prior-generation',
          state: 'ready',
          external: true,
          nativeCurrentConnection: false,
          rawBridgeExposed: false,
        }),
        listModels: async () => ({ ok: true, value: [] }),
        subscribeLifecycle: () => () => undefined,
        close: async () => {
          priorCloseStarted = true
          await priorClose
        },
      } as never,
      displayName: 'Prior',
    }])
    const configurations = new HostPlatformProviderConfigurationRegistryV1()
    configurations.register({
      protocolVersion: 2,
      schema,
      applicationMode: 'service-restart',
      project: () => [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v2',
        schemaVersion: 2,
        configurationRevision: 1,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        enabled: true,
        requestTimeoutMs: 30_000,
        mapping: {
          models: [{
            sourceModelId: 'model-a',
            modelId: 'public-a',
            displayName: 'Public A',
            enabled: true,
            isDefault: true,
          }],
        },
      }],
    })
    const transportEvents: string[] = []
    const brokers = {
      catalog: () => ({ catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] }),
      open: async ({ rawConfiguration }: { readonly rawConfiguration: unknown }) => {
        expect(rawConfiguration).toEqual({ endpoint: 'https://gateway.example', secretRef: 'host-secret:key' })
        return {
          exchange: async () => ({}),
          subscribe: () => () => undefined,
          respond: async () => {},
          dispose: async () => {
            transportEvents.push('transport-dispose')
          },
        }
      },
    }
    const serviceHost = new PlatformProviderServiceHostV1({ configurations, brokers, fleet })
    const servicePath = stagedPluginServiceModulePath(homeDir, staged.digest, 'providers-runtime')
    ;(globalThis as { __platformProviderTest?: { disposeDuringSubscribe: boolean } }).__platformProviderTest = {
      disposeDuringSubscribe: true,
    }
    const access = {
      packageIdentity: { pluginId: runtime.id, version: '1.0.0', integrity: staged.digest },
      pluginIdentity: { source: staged.identitySource, pluginId: runtime.id, generation: 'plugin-1' },
      serviceId: 'providers-runtime',
      hostGeneration: 'host-1',
      serviceKind: 'platform-provider' as const,
      owner: 'host' as const,
      schema,
      applicationMode: 'service-restart' as const,
      artifactDirectory: path.dirname(path.dirname(servicePath)),
      runtimeEntry: './services/providers-runtime.mjs' as const,
    }
    const activation = serviceHost.activate(
      access,
      { endpoint: 'https://gateway.example', secretRef: 'host-secret:key' },
    )
    for (let attempt = 0; attempt < 100 && !priorCloseStarted; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(priorCloseStarted).toBe(true)
    await expect(fleet.listModels({})).resolves.toMatchObject({
      ok: true,
      value: { models: [{ ref: { providerId: 'gateway-a', modelId: 'public-a' }, label: 'Public A' }] },
    })
    expect((globalThis as { __platformProviderTest?: { configuration: unknown } }).__platformProviderTest)
      .toMatchObject({
        configuration: {
          providerId: 'gateway-a',
          requestTimeoutMs: 30_000,
          mapping: { models: [{ modelId: 'public-a' }] },
        },
      })
    expect(
      (globalThis as {
        __platformProviderTest?: { registration?: { registration?: unknown } }
      }).__platformProviderTest?.registration?.registration,
    ).toMatchObject({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-registration.v2.schema.json',
      contract: 'cordisx.platform-provider-registration/v2',
      schemaVersion: 2,
      mapping: { models: [{ sourceModelId: 'model-a', modelId: 'public-a' }] },
      configuration: { schemaVersion: 2, mapping: { models: [{ modelId: 'public-a' }] } },
    })

    const registrationDisposal = (globalThis as {
      __platformProviderTest?: { registrationDisposal?: Promise<void> }
    }).__platformProviderTest?.registrationDisposal
    expect(registrationDisposal).toBeDefined()
    let disposalSettled = false
    void registrationDisposal?.finally(() => {
      disposalSettled = true
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposalSettled).toBe(false)
    releasePrior()
    const active = await activation
    await registrationDisposal
    expect(active.registrations).toEqual([])
    expect(fleet.status().mode).toBe('unavailable')
    await active.dispose()
    expect((globalThis as { __platformProviderTest?: { events: string[] } }).__platformProviderTest?.events)
      .toEqual(['unsubscribe', 'drain', 'dispose'])
    expect(transportEvents).toEqual(['transport-dispose'])
    expect(fleet.status().mode).toBe('unavailable')
    ;(globalThis as { __platformProviderTest?: { mappingMismatch?: boolean } }).__platformProviderTest = {
      mappingMismatch: true,
    }
    await expect(serviceHost.activate(
      access,
      { endpoint: 'https://gateway.example', secretRef: 'host-secret:key' },
    )).rejects.toThrow('mapping differs from its Host projection')

    const mismatchedConfigurations = new HostPlatformProviderConfigurationRegistryV1()
    mismatchedConfigurations.register({
      protocolVersion: 2,
      schema,
      applicationMode: 'service-restart',
      project: () => [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v1.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v1',
        schemaVersion: 1,
        configurationRevision: 1,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        enabled: true,
        requestTimeoutMs: 30_000,
      }],
    })
    await expect(new PlatformProviderServiceHostV1({
      configurations: mismatchedConfigurations,
      brokers,
      fleet,
    }).activate(access, {})).rejects.toThrow('requires Protocol v2 configurations')

    const v1Configurations = new HostPlatformProviderConfigurationRegistryV1()
    v1Configurations.register({
      protocolVersion: 1,
      schema,
      applicationMode: 'service-restart',
      project: () => [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v1.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v1',
        schemaVersion: 1,
        configurationRevision: 2,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        enabled: true,
        requestTimeoutMs: 30_000,
      }],
    })
    ;(globalThis as { __platformProviderTest?: Record<string, unknown> }).__platformProviderTest = {}
    const v1Active = await new PlatformProviderServiceHostV1({
      configurations: v1Configurations,
      brokers,
      fleet,
    }).activate(access, { endpoint: 'https://gateway.example', secretRef: 'host-secret:key' })
    expect(v1Active.registrations).toMatchObject([{ contract: 'cordisx.platform-provider-registration/v1' }])
    await v1Active.dispose()
    await fleet.close()
  })

  it('fences operations and provider identities while applying model mappings', async () => {
    const workspaces = new PlatformProviderWorkspaceAuthority()
    const workspace = workspaces.issue('/tmp/provider-workspace')
    const policy = issuePlatformProviderBrokerPolicy({
      owner: owner(),
      providerId: 'gateway-a',
      providerGeneration: 'host-1:plugin-1:gateway-a',
      operations: ['models.list'],
      request: { bindings: [binding] },
      catalog: { catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] },
    })
    let transportDisposed = false
    const broker = new HostBoundPlatformProviderBrokerV1(policy, {
      exchange: async () => ({}),
      subscribe: () => () => undefined,
      respond: async () => {},
      dispose: async () => {
        transportDisposed = true
      },
    })
    const adapter = {
      providerId: 'gateway-a',
      providerGeneration: 'host-1:plugin-1:gateway-a',
      models: {
        list: async () => ({
          ok: true,
          value: {
            models: [
              { ref: { providerId: 'gateway-a', modelId: 'source-a' }, label: 'Source A' },
            ],
          },
        }),
      },
      sessions: {
        list: async () => ({ ok: true, value: { sessions: [] } }),
        read: async () => ({ ok: false, error: { code: 'session-not-found', message: 'missing' } }),
        create: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
      },
      turns: {
        submit: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        introduce: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
      },
      approvals: { decide: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }) },
      subscribeLifecycle: () => ({ subscriptionId: 'ppls_test', unsubscribe() {} }),
      async drain() {
        throw new Error('drain failed')
      },
      async dispose() {},
    } as never
    const connection = providerConnection({
      descriptor: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-descriptor.v1.schema.json',
        contract: 'cordisx.platform-provider-descriptor/v1',
        schemaVersion: 1,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        implementationStatus: 'verified',
        operations: ['models.list'],
      },
      mapping: {
        models: [{
          sourceModelId: 'source-a',
          modelId: 'public-a',
          displayName: 'Public A',
          enabled: true,
          isDefault: true,
        }],
      },
      adapter,
      broker,
      workspaces,
    })
    await expect(connection.listModels()).resolves.toMatchObject({
      ok: true,
      value: [{ ref: { providerId: 'gateway-a', modelId: 'public-a' }, label: 'Public A', isDefault: true }],
    })
    await expect(connection.listSessions({ limit: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter-read-only' },
    })
    adapter.models.list = async () =>
      ({
        ok: true,
        value: { models: [{ ref: { providerId: 'foreign', modelId: 'source-a' }, label: 'forged' }] },
      }) as never
    await expect(connection.listModels()).resolves.toMatchObject({ ok: false, error: { code: 'adapter-failure' } })
    await expect(connection.close()).rejects.toThrow('drain failed')
    expect(transportDisposed).toBe(true)
    workspaces.dispose()
    expect(workspace.workspaceHandle).toMatch(/^ppw_/)
  })

  it('rejects malformed broker envelopes and malformed lifecycle events before transport use', async () => {
    let exchanged = false
    const policy = issuePlatformProviderBrokerPolicy({
      owner: owner(),
      providerId: 'gateway-a',
      providerGeneration: 'provider-1',
      operations: ['models.list'],
      request: { bindings: [binding] },
      catalog: { catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] },
    })
    const broker = new HostBoundPlatformProviderBrokerV1(policy, {
      exchange: async () => {
        exchanged = true
        return {}
      },
      subscribe: () => () => undefined,
      respond: async () => {},
      dispose: async () => {},
    })
    await expect(broker.exchange({
      $schema: 'wrong',
      contract: 'cordisx.platform-provider-broker-request/v1',
      schemaVersion: 1,
      requestId: 'request-1',
      operation: 'models.list',
      method: 'model/list',
      requestSchema: valueSchema,
      params: {},
    } as never)).rejects.toThrow('invalid')
    expect(exchanged).toBe(false)
    expect(validLifecycleEvent({ type: 'approval.required' }, 'gateway-a', 'provider-1')).toBe(false)
    expect(() =>
      factoryConfiguration({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v2',
        schemaVersion: 2,
        configurationRevision: 1,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        enabled: true,
        requestTimeoutMs: 30_000,
        mapping: {
          models: [{
            sourceModelId: 'source',
            modelId: 'public',
            displayName: 'x'.repeat(201),
            enabled: true,
            isDefault: true,
          }],
        },
      })
    ).toThrow('invalid or duplicated')
    await broker.dispose()
  })

  it('atomically replaces the same provider generation and fences the stale publication handle', async () => {
    const fleet = await ProviderFleet.create([])
    const closed: string[] = []
    const connection = (generation: string, label: string) =>
      ({
        providerId: 'gateway-a',
        generation,
        status: () => ({
          providerId: 'gateway-a',
          displayName: label,
          generation,
          state: 'ready',
          external: true,
          nativeCurrentConnection: false,
          rawBridgeExposed: false,
        }),
        listModels: async () => ({
          ok: true,
          value: [{
            contract: 'cordisx.platform-model/v1',
            schemaVersion: 1,
            ref: { providerId: 'gateway-a', modelId: generation },
            hostId: generation,
            label,
          }],
        }),
        listSessions: async () => ({ ok: true, value: { sessions: [] } }),
        readSession: async () => ({ ok: false, error: { code: 'task-not-found', message: 'missing' } }),
        createSession: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        controlSession: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        submitTurn: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        decideApproval: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        requestMemberSelfIntroduction: async () => ({
          ok: false,
          error: { code: 'adapter-read-only', message: 'unsupported' },
        }),
        cancelMemberSelfIntroduction: async () => ({
          ok: false,
          error: { code: 'adapter-read-only', message: 'unsupported' },
        }),
        controlTurn: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        subscribeLifecycle: () => () => undefined,
        close: async () => {
          closed.push(generation)
        },
      }) as never
    const first = await fleet.publishConnections([{
      connection: connection('generation-1', 'Old'),
      displayName: 'Old',
    }])
    const second = await fleet.publishConnections([{
      connection: connection('generation-2', 'New'),
      displayName: 'New',
    }])
    expect(closed).toContain('generation-1')
    await first.dispose()
    await expect(fleet.listModels({ providerIds: ['gateway-a'] })).resolves.toMatchObject({
      ok: true,
      value: { models: [{ ref: { providerId: 'gateway-a', modelId: 'generation-2' }, label: 'New' }] },
    })
    await second.dispose()
    expect(closed).toContain('generation-2')
    await fleet.close()
  })

  it('keeps the whole prior batch active when a replacement fails before publication', async () => {
    const fleet = await ProviderFleet.create([])
    const closed: string[] = []
    const connection = (providerId: string, generation: string, throws = false) =>
      ({
        providerId,
        generation,
        status: () => ({
          providerId,
          displayName: providerId,
          generation,
          state: 'ready',
          external: true,
          nativeCurrentConnection: false,
          rawBridgeExposed: false,
        }),
        listModels: async () => ({
          ok: true,
          value: [{
            contract: 'cordisx.platform-model/v1',
            schemaVersion: 1,
            ref: { providerId, modelId: generation },
            hostId: generation,
            label: generation,
          }],
        }),
        listSessions: async () => ({ ok: true, value: { sessions: [] } }),
        readSession: async () => ({ ok: false, error: { code: 'task-not-found', message: 'missing' } }),
        createSession: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        controlSession: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        submitTurn: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        decideApproval: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        requestMemberSelfIntroduction: async () => ({
          ok: false,
          error: { code: 'adapter-read-only', message: 'unsupported' },
        }),
        cancelMemberSelfIntroduction: async () => ({
          ok: false,
          error: { code: 'adapter-read-only', message: 'unsupported' },
        }),
        controlTurn: async () => ({ ok: false, error: { code: 'adapter-read-only', message: 'unsupported' } }),
        subscribeLifecycle: () => {
          if (throws) throw new Error('subscription failed')
          return () => undefined
        },
        close: async () => {
          closed.push(`${providerId}:${generation}`)
        },
      }) as never
    const prior = await fleet.publishConnections([
      { connection: connection('provider-a', 'a1'), displayName: 'A' },
      { connection: connection('provider-b', 'b1'), displayName: 'B' },
    ])
    await expect(fleet.publishConnections([
      { connection: connection('provider-a', 'a2'), displayName: 'A2' },
      { connection: connection('provider-b', 'b2', true), displayName: 'B2' },
    ])).rejects.toThrow('subscription failed')
    expect(closed).toEqual([])
    await expect(fleet.listModels({ providerIds: ['provider-a', 'provider-b'] })).resolves.toMatchObject({
      ok: true,
      value: {
        models: [
          { ref: { providerId: 'provider-a', modelId: 'a1' } },
          { ref: { providerId: 'provider-b', modelId: 'b1' } },
        ],
      },
    })
    await prior.dispose()
    await fleet.close()
  })
})
