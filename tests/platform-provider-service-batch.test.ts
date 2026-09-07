import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import {
  HostPlatformProviderConfigurationRegistryV1,
  platformProviderCandidateConfiguration,
  PlatformProviderServiceBatchRuntime,
} from '../packages/cli/src/launcher/platform-provider-service.js'
import type { PlatformProviderBrokerBindingV1 } from '@cordisx/protocol/platform-provider/v1'

const schema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/test-provider-config.v1.schema.json'
const valueSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-value.v1.schema.json'
const binding: PlatformProviderBrokerBindingV1 = {
  operation: 'models.list',
  direction: 'request',
  method: 'model/list',
  requestSchema: valueSchema,
  resultSchema: valueSchema,
}

it('keeps active services across rollback, replaces them on finalize, and disposes the final generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-provider-batch-'))
  const services = path.join(root, 'services')
  await mkdir(services)
  await writeFile(
    path.join(services, 'provider.mjs'),
    `
export async function apply(ctx, input) {
  const configuration = input.configurations[0]
  globalThis.__providerBatchEvents ??= []
  const sequence = globalThis.__providerBatchEvents.filter(item => item === 'apply').length + 1
  globalThis.__providerBatchEvents.push('apply')
  await ctx.platformProviders.register({
    descriptor: {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-descriptor.v1.schema.json',
      contract: 'cordisx.platform-provider-descriptor/v1', schemaVersion: 1,
      providerId: configuration.providerId, displayName: configuration.displayName,
      implementationStatus: 'experimental', operations: ['models.list'],
    },
    mapping: { models: [] },
    brokerRequest: { bindings: [{
      operation: 'models.list', direction: 'request', method: 'model/list',
      requestSchema: '${valueSchema}', resultSchema: '${valueSchema}',
    }] },
    async createAdapter(factory) {
      return {
        providerId: factory.providerId,
        providerGeneration: factory.providerGeneration,
        models: { list: async () => ({ ok: true, value: { models: [{
          ref: { providerId: factory.providerId, modelId: 'model-' + sequence }, label: 'Model ' + sequence,
        }] } }) },
        sessions: {
          list: async () => ({ ok: true, value: { sessions: [] } }),
          read: async () => ({ ok: false, error: { code: 'missing', message: 'missing' } }),
          create: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        },
        turns: {
          submit: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          introduce: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        },
        approvals: { decide: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }) },
        subscribeLifecycle: () => ({ subscriptionId: 'batch-' + sequence, unsubscribe() {} }),
        async drain() { globalThis.__providerBatchEvents.push('drain-' + sequence) },
        async dispose() { globalThis.__providerBatchEvents.push('dispose-' + sequence) },
      }
    },
  })
}
`,
  )
  const configurations = new HostPlatformProviderConfigurationRegistryV1()
  configurations.register({
    protocolVersion: 1,
    schema,
    applicationMode: 'service-restart',
    project: () => [{
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v1.schema.json',
      contract: 'cordisx.platform-provider-factory-configuration/v1',
      schemaVersion: 1,
      configurationRevision: 1,
      providerId: 'external',
      displayName: 'External',
      enabled: true,
      requestTimeoutMs: 1_000,
    }],
  })
  const access = {
    packageIdentity: { pluginId: 'provider-plugin', version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` as const },
    pluginIdentity: { source: 'https://plugins.example/provider', pluginId: 'provider-plugin', generation: 'plugin-1' },
    serviceId: 'providers-runtime',
    hostGeneration: 'host-1',
    serviceKind: 'platform-provider' as const,
    owner: 'host' as const,
    schema,
    applicationMode: 'service-restart' as const,
    artifactDirectory: root,
    runtimeEntry: './services/provider.mjs' as const,
  }
  const batch = new PlatformProviderServiceBatchRuntime({
    configurations,
    brokers: {
      catalog: () => ({ catalogDigest: `sha256:${'b'.repeat(64)}`, bindings: [binding] }),
      open: async () => ({
        exchange: async () => ({}),
        subscribe: () => () => undefined,
        respond: async () => undefined,
        dispose: async () => undefined,
      }),
    },
    candidates: async () => [{ access, rawConfiguration: {} }],
  })
  const closeProviderGeneration = vi.fn(async () => undefined)
  const fleet = await ProviderFleet.create([], { agentLoopAuthority: { closeProviderGeneration } as never })
  const models = async () => {
    const result = await fleet.listModels({})
    return result.ok ? result.value.models.map(item => item.ref.modelId) : []
  }
  try {
    const initial = await batch.reconfigure(fleet, [])
    await initial.finalize()
    expect(await models()).toEqual(['model-1'])
    const firstGeneration = fleet.providerStatuses()[0]!.generation
    const rollback = await batch.reconfigure(fleet, [])
    expect(await models()).toEqual(['model-2'])
    const rolledBackGeneration = fleet.providerStatuses()[0]!.generation
    expect(rolledBackGeneration).not.toBe(firstGeneration)
    await rollback.rollback()
    expect(await models()).toEqual(['model-1'])
    const replacement = await batch.reconfigure(fleet, [])
    closeProviderGeneration.mockRejectedValueOnce(new Error('first cleanup attempt failed'))
    await expect(replacement.finalize()).resolves.toBeUndefined()
    expect(await models()).toEqual(['model-3'])
    const finalGeneration = fleet.providerStatuses()[0]!.generation
    expect(new Set([firstGeneration, rolledBackGeneration, finalGeneration]).size).toBe(3)
    expect(closeProviderGeneration).toHaveBeenCalledWith({
      providerId: 'external',
      providerGeneration: rolledBackGeneration,
    })
    expect(closeProviderGeneration.mock.calls.filter(([value]) => value.providerGeneration === firstGeneration))
      .toHaveLength(2)
    expect(closeProviderGeneration).toHaveBeenCalledWith({
      providerId: 'external',
      providerGeneration: firstGeneration,
    })
    await batch.close()
    expect(await models()).toEqual([])
    expect((globalThis as { __providerBatchEvents?: string[] }).__providerBatchEvents).toEqual(
      expect.arrayContaining(['dispose-2', 'dispose-1', 'dispose-3']),
    )
  } finally {
    delete (globalThis as { __providerBatchEvents?: unknown }).__providerBatchEvents
    await batch.close()
    await fleet.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('applies a config override only to its exact plugin and service owner', () => {
  const access = (pluginId: string, serviceId: string) =>
    ({
      pluginIdentity: { pluginId },
      serviceId,
    }) as never
  const first = { access: access('first', 'runtime'), rawConfiguration: { owner: 'first' } }
  const second = { access: access('second', 'runtime'), rawConfiguration: { owner: 'second' } }
  const override = { pluginId: 'first', serviceId: 'runtime', rawConfiguration: { owner: 'updated' } }
  expect(platformProviderCandidateConfiguration(first, override)).toEqual({ owner: 'updated' })
  expect(platformProviderCandidateConfiguration(second, override)).toEqual({ owner: 'second' })
  expect(platformProviderCandidateConfiguration(first, { ...override, serviceId: 'other' })).toEqual({ owner: 'first' })
})

it('serializes unsettled Fleet transactions and fences close against later work', async () => {
  const batch = new PlatformProviderServiceBatchRuntime({
    configurations: new HostPlatformProviderConfigurationRegistryV1(),
    brokers: {} as never,
    candidates: async () => [],
  })
  const fleet = await ProviderFleet.create([])
  const first = await batch.reconfigure(fleet, [])
  let secondStarted = false
  const secondPromise = batch.reconfigure(fleet, []).then(value => {
    secondStarted = true
    return value
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(secondStarted).toBe(false)
  await first.rollback()
  const second = await secondPromise
  expect(secondStarted).toBe(true)
  let closeFinished = false
  const close = batch.close().then(() => {
    closeFinished = true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(closeFinished).toBe(false)
  await second.finalize()
  await close
  await expect(batch.reconfigure(fleet, [])).rejects.toThrow('batch is closed')
  await fleet.close()
})
