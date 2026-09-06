import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import {
  CdpPluginLifecycleRuntime,
  type CdpTarget,
  iconThemePreferenceDeliveryEvaluation,
  injectableTargets,
  RENDERER_DISPOSE_EXPRESSION,
  resolveCdpInjectionTimeoutMs,
  runtimeEvaluationException,
  serviceConfigResponseEvaluation,
  watchAndInject,
} from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PluginPermissionIdentityRegistry } from '../packages/cli/src/launcher/permission-rpc.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { RollbackPlan } from '../packages/cli/src/launcher/packages/authority.js'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import {
  ICON_THEME_PREFERENCE_BINDING,
  IconThemePreferenceBroadcastHub,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'
import { BrowserIconThemePreferenceBridge } from '../packages/cli/src/renderer/icon-theme-preference-binding.js'
import { OwnerDocumentLeaseRegistry } from '../packages/cli/src/launcher/owner-document-rpc.js'
import type { PluginGenerationGraphLease } from '../packages/cli/src/launcher/plugin-generation-loader.js'

function target(id: string, title: string, url = 'https://example.test/'): CdpTarget {
  return { id, title, url, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1/${id}` }
}

function deferred<Value = void>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function iconThemeReceiverPayload(expression: string): Record<string, unknown> | undefined {
  const encoded = expression.match(/receiver\(((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\)/u)?.[1]
  if (encoded === undefined) return undefined
  try {
    return JSON.parse(JSON.parse(encoded) as string) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readyLeaseEcho(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return payload?.kind === 'document-ready'
    ? { readyLeaseToken: payload.readyLeaseToken, readyLeaseRevision: payload.readyLeaseRevision }
    : {}
}

function activation(revision: number, generation: string): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 0 ? 'active' : 'candidate',
    ...(revision === 0 ? {} : { transactionId: 'tx' }),
    profileId: 'work',
    revision,
    lastGoodRevision: 0,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'demo',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      moduleGeneration: generation,
      enabled: revision === 0,
      dependencies: [],
    }],
  }
}

describe('CdpPluginLifecycleRuntime', () => {
  it('atomically hands first-browser-graph admission into the shared generation fence', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const current = activation(0, 'demo-old')
    const existing = { send: async () => ({}) } as never
    const unregister = runtime.register(existing)
    let releaseAdmission!: () => void
    let admissionStarted!: () => void
    const admissionGate = new Promise<void>(resolve => {
      releaseAdmission = resolve
    })
    const started = new Promise<void>(resolve => {
      admissionStarted = resolve
    })
    const admissions: unknown[] = []
    runtime.setBrowserGraphAdmission(async input => {
      admissions.push(input)
      admissionStarted()
      await admissionGate
      return { commit: () => undefined, rollback: async () => undefined }
    })

    const pending = runtime.prepareBrowserGraph('first-graph', current)
    await started
    expect(() => runtime.prepare('overlap')).toThrow('another plugin generation transaction is unresolved')
    expect(() => runtime.beginJoin({ send: async () => ({}) } as never)).toThrow(
      'cannot join a CordisX renderer during a plugin generation transaction',
    )
    releaseAdmission()
    const fence = await pending
    expect(fence.expectedRegistryEpoch).toBe(0)
    expect(runtime.requiresBrowserGraphTransport()).toBe(true)
    expect(admissions).toEqual([expect.objectContaining({
      transactionId: 'first-graph',
      active: current,
      expectedRegistryEpoch: 0,
      sessions: [existing],
    })])
    expect(() => runtime.beginJoin({ send: async () => ({}) } as never)).toThrow(
      'cannot join a CordisX renderer during a plugin generation transaction',
    )
    runtime.cancelPreparation('first-graph')

    const join = runtime.beginJoin({ send: async () => ({}) } as never)
    await expect(runtime.prepareBrowserGraph('blocked-by-join', current)).rejects.toThrow(
      'another plugin generation transaction is unresolved',
    )
    join.abort()
    unregister()

    const staleRuntime = new CdpPluginLifecycleRuntime()
    const unregisterStale = staleRuntime.register({ send: async () => ({}) } as never)
    let releaseStale!: () => void
    const staleGate = new Promise<void>(resolve => {
      releaseStale = resolve
    })
    const rollback = vi.fn(async () => undefined)
    staleRuntime.setBrowserGraphAdmission(async () => {
      await staleGate
      return { commit: () => undefined, rollback }
    })
    const staleAdmission = staleRuntime.prepareBrowserGraph('stale-admission', current)
    unregisterStale()
    releaseStale()
    await expect(staleAdmission).rejects.toThrow('browser graph admission reservation became stale')
    expect(rollback).toHaveBeenCalledOnce()
    expect(staleRuntime.requiresBrowserGraphTransport()).toBe(false)
  })

  it('publishes candidate graph resources transactionally and retires only the losing generation', async () => {
    const previous = activation(0, 'demo-old')
    const candidateBase = activation(1, 'demo-new')
    const candidate = { ...candidateBase, plugins: candidateBase.plugins.map(plugin => ({ ...plugin, enabled: true })) }
    const graphLease = (name: string, generation: string) => {
      const retire = vi.fn()
      return {
        lease: {
          leaseId: name,
          pluginId: 'demo',
          moduleGeneration: generation,
          baseUrl: `http://127.0.0.1/${name}/`,
          entryUrl: `http://127.0.0.1/${name}/module.js`,
          initialStyleUrls: [],
          importSource: `Promise.resolve(globalThis.__${name}Module)`,
          publishSource: `globalThis.__${name}Published = true`,
          retireSource: `globalThis.__${name}Retired = true`,
          retire,
        } satisfies PluginGenerationGraphLease,
        retire,
      }
    }
    const old = graphLease('oldGraph', 'demo-old')
    const next = graphLease('nextGraph', 'demo-new')
    const expressions: string[] = []
    let transactionEpoch = ''
    let oldRetirementAcknowledged = false
    let finalizeCalls = 0
    const runtime = new CdpPluginLifecycleRuntime()
    runtime.registerActivePluginGenerationLease(old.lease)
    const bootstrapRefresh = vi.fn(async (active: CordisXPluginActivationRecordV1, registryEpoch: number) => {
      expect(active).toEqual(candidate)
      expect(registryEpoch).toBe(1)
      expect(runtime.activeBrowserGraph('demo', 'demo-new')?.loadSource).toBe(next.lease.importSource)
      expect(old.retire).not.toHaveBeenCalled()
    })
    runtime.markBrowserGraphTransportReady()
    runtime.setBrowserGraphBootstrapRefresh(bootstrapRefresh)
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        expressions.push(expression)
        if (expression.includes('stagePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'tx',
                  transactionEpoch,
                  expectedRegistryEpoch: 0,
                  afterRegistryEpoch: 1,
                },
              },
            },
          }
        }
        if (expression.includes('publishPluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'tx',
                  transactionEpoch,
                  registryEpoch: 1,
                  active: candidate,
                },
              },
            },
          }
        }
        if (expression.includes('completePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'tx',
                  transactionEpoch,
                  registryEpoch: 1,
                  active: candidate,
                  disposedAfter: previous,
                },
              },
            },
          }
        }
        if (expression.includes('finalizePluginMutation')) {
          finalizeCalls += 1
          return { result: { value: { ok: true, result: true } } }
        }
        if (expression === next.lease.publishSource) {
          expect(params.returnByValue).toBe(true)
          return { result: { value: true } }
        }
        if (expression === old.lease.retireSource) {
          expect(params.returnByValue).toBe(true)
          return { result: { value: oldRetirementAcknowledged } }
        }
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    await runtime.stage({
      transactionId: 'tx',
      ...fence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      package: {
        manifest: { id: 'demo', runtimeManifest: { schemaVersion: 1, capabilities: [] } },
        digest: `sha256:${'b'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///demo-next.js',
      } as never,
      runtimeArtifactSource: next.lease.importSource,
      runtimeArtifactLease: next.lease,
    })
    expect(expressions).toContainEqual(expect.stringContaining('__cordisxPendingPluginModulesV1'))
    expect(expressions).toContainEqual(expect.stringContaining('"demo": await'))
    await runtime.publish('tx')
    const publication = expressions.find(expression => expression.includes(next.lease.publishSource))!
    expect(publication.indexOf(next.lease.publishSource)).toBeLessThan(
      publication.indexOf('runtime.publishPluginMutation'),
    )
    expect(old.retire).not.toHaveBeenCalled()
    await runtime.complete('tx')
    await expect(runtime.finalize('tx')).rejects.toThrow('plugin generation resource operation failed')
    expect(finalizeCalls).toBe(1)
    expect(old.retire).not.toHaveBeenCalled()
    oldRetirementAcknowledged = true
    await runtime.finalize('tx')
    expect(finalizeCalls).toBe(2)
    expect(bootstrapRefresh).toHaveBeenCalledTimes(2)
    expect(expressions).toContain(old.lease.retireSource)
    expect(old.retire).toHaveBeenCalledOnce()
    expect(next.retire).not.toHaveBeenCalled()
    unregister()

    const rollbackRuntime = new CdpPluginLifecycleRuntime()
    const rollbackOld = graphLease('rollbackOld', 'demo-old')
    const rollbackNext = graphLease('rollbackNext', 'demo-new')
    const rollbackExpressions: string[] = []
    let rollbackEpoch = ''
    rollbackRuntime.registerActivePluginGenerationLease(rollbackOld.lease)
    const unregisterRollback = rollbackRuntime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        rollbackExpressions.push(expression)
        if (expression.includes('stagePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'rollback',
                  transactionEpoch: rollbackEpoch,
                  expectedRegistryEpoch: 0,
                  afterRegistryEpoch: 1,
                },
              },
            },
          }
        }
        if (expression.includes('rollbackPluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'rollback',
                  transactionEpoch: rollbackEpoch,
                  registryEpoch: 2,
                  active: previous,
                  disposedAfter: candidate,
                },
              },
            },
          }
        }
        if (expression === rollbackNext.lease.retireSource) {
          expect(params.returnByValue).toBe(true)
          return { result: { value: true } }
        }
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    const rollbackFence = rollbackRuntime.prepare('rollback')
    rollbackEpoch = rollbackFence.transactionEpoch
    await rollbackRuntime.stage({
      transactionId: 'rollback',
      ...rollbackFence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      runtimeArtifactSource: rollbackNext.lease.importSource,
      runtimeArtifactLease: rollbackNext.lease,
      package: {
        manifest: { id: 'demo', runtimeManifest: { schemaVersion: 1, capabilities: [] } },
        digest: `sha256:${'c'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///demo-rollback.js',
      } as never,
    })
    await rollbackRuntime.rollback('rollback')
    expect(rollbackExpressions).toContain(rollbackNext.lease.retireSource)
    expect(rollbackNext.retire).toHaveBeenCalledOnce()
    expect(rollbackOld.retire).not.toHaveBeenCalled()
    unregisterRollback()

    const failedRuntime = new CdpPluginLifecycleRuntime()
    const failedNext = graphLease('failedNext', 'demo-new')
    let failedEpoch = ''
    let failedRetirementAttempts = 0
    const unregisterFailed = failedRuntime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'failed',
                  transactionEpoch: failedEpoch,
                  expectedRegistryEpoch: 0,
                  afterRegistryEpoch: 1,
                },
              },
            },
          }
        }
        if (expression.includes('rollbackPluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'failed',
                  transactionEpoch: failedEpoch,
                  registryEpoch: 2,
                  active: previous,
                  disposedAfter: candidate,
                },
              },
            },
          }
        }
        if (expression.includes('publishPluginMutation')) {
          if (expression.includes(failedNext.lease.publishSource)) {
            return {
              result: {
                value: { ok: false, error: 'plugin generation resource publication failed' },
              },
            }
          }
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'failed',
                  transactionEpoch: failedEpoch,
                  registryEpoch: 1,
                  active: candidate,
                },
              },
            },
          }
        }
        if (expression === failedNext.lease.publishSource) {
          expect(params.returnByValue).toBe(true)
          return { result: { value: false } }
        }
        if (expression === failedNext.lease.retireSource) {
          expect(params.returnByValue).toBe(true)
          failedRetirementAttempts += 1
          if (failedRetirementAttempts === 1) return { result: { value: false } }
          if (failedRetirementAttempts === 2) {
            return { result: { value: true }, exceptionDetails: { text: 'retirement failed' } }
          }
          return { result: { value: true } }
        }
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    const failedFence = failedRuntime.prepare('failed')
    failedEpoch = failedFence.transactionEpoch
    await failedRuntime.stage({
      transactionId: 'failed',
      ...failedFence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      runtimeArtifactSource: failedNext.lease.importSource,
      runtimeArtifactLease: failedNext.lease,
      package: {
        manifest: { id: 'demo', runtimeManifest: { schemaVersion: 1, capabilities: [] } },
        digest: `sha256:${'d'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///demo-failed.js',
      } as never,
    })
    await expect(failedRuntime.publish('failed')).rejects.toThrow('plugin generation resource publication failed')
    expect(failedRuntime.currentRegistryEpoch()).toBe(0)
    expect(failedNext.retire).not.toHaveBeenCalled()
    await expect(failedRuntime.rollback('failed')).rejects.toThrow('plugin generation resource operation failed')
    expect(failedRuntime.currentRegistryEpoch()).toBe(0)
    expect(failedNext.retire).not.toHaveBeenCalled()
    await expect(failedRuntime.rollback('failed')).rejects.toThrow('plugin generation resource operation failed')
    expect(failedRuntime.currentRegistryEpoch()).toBe(0)
    expect(failedNext.retire).not.toHaveBeenCalled()
    await expect(failedRuntime.rollback('failed')).resolves.toMatchObject({ transactionId: 'failed' })
    expect(failedRuntime.currentRegistryEpoch()).toBe(2)
    expect(failedNext.retire).toHaveBeenCalledOnce()
    unregisterFailed()
  })

  it('imports and promotes browser graph leases for the complete dependency closure', async () => {
    const activationItem = (
      id: string,
      moduleGeneration: string,
      dependencies: readonly { id: string; version: string }[] = [],
    ) => ({
      id,
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}` as const,
      moduleGeneration,
      enabled: true,
      dependencies,
    })
    const previous: CordisXPluginActivationRecordV1 = {
      ...activation(0, 'unused'),
      plugins: [
        activationItem('base', 'base-old'),
        activationItem('consumer', 'consumer-old', [{ id: 'base', version: '1.0.0' }]),
      ],
    }
    const candidate: CordisXPluginActivationRecordV1 = {
      ...activation(1, 'unused'),
      plugins: [
        activationItem('base', 'base-new'),
        activationItem('consumer', 'consumer-new', [{ id: 'base', version: '1.0.0' }]),
      ],
    }
    const lease = (pluginId: string, moduleGeneration: string, name: string): PluginGenerationGraphLease => ({
      leaseId: name,
      pluginId,
      moduleGeneration,
      baseUrl: `http://127.0.0.1/${name}/`,
      entryUrl: `http://127.0.0.1/${name}/module.js`,
      initialStyleUrls: [],
      importSource: `Promise.resolve(globalThis.__${name}Module)`,
      publishSource: `globalThis.__${name}Published = true`,
      retireSource: `globalThis.__${name}Retired = true`,
      retire: vi.fn(),
    })
    const oldBase = lease('base', 'base-old', 'oldBase')
    const oldConsumer = lease('consumer', 'consumer-old', 'oldConsumer')
    const nextBase = lease('base', 'base-new', 'nextBase')
    const nextConsumer = lease('consumer', 'consumer-new', 'nextConsumer')
    const expressions: string[] = []
    let transactionEpoch = ''
    const runtime = new CdpPluginLifecycleRuntime()
    runtime.registerActivePluginGenerationLease(oldBase)
    runtime.registerActivePluginGenerationLease(oldConsumer)
    runtime.markBrowserGraphTransportReady()
    runtime.setBrowserGraphBootstrapRefresh(async () => {
      expect(runtime.activeBrowserGraph('base', 'base-new')?.loadSource).toBe(nextBase.importSource)
      expect(runtime.activeBrowserGraph('consumer', 'consumer-new')?.loadSource).toBe(nextConsumer.importSource)
      expect(oldBase.retire).not.toHaveBeenCalled()
      expect(oldConsumer.retire).not.toHaveBeenCalled()
    })
    runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        expressions.push(expression)
        if (
          expression === nextBase.publishSource || expression === nextConsumer.publishSource
          || expression === oldBase.retireSource || expression === oldConsumer.retireSource
        ) {
          return { result: { value: true } }
        }
        if (expression.includes('stagePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'tx',
                  transactionEpoch,
                  expectedRegistryEpoch: 0,
                  afterRegistryEpoch: 1,
                },
              },
            },
          }
        }
        if (expression.includes('publishPluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'tx',
                  transactionEpoch,
                  registryEpoch: 1,
                  active: candidate,
                },
              },
            },
          }
        }
        if (expression.includes('completePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'tx',
                  transactionEpoch,
                  registryEpoch: 1,
                  active: candidate,
                  disposedAfter: previous,
                },
              },
            },
          }
        }
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    await runtime.stage({
      transactionId: 'tx',
      ...fence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'base',
      affectedPluginIds: ['base', 'consumer'],
      package: {
        manifest: { id: 'base', runtimeManifest: { schemaVersion: 1, capabilities: [] } },
        digest: `sha256:${'b'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///base-next.js',
      } as never,
      runtimeArtifactSource: nextBase.importSource,
      runtimeArtifactLease: nextBase,
      runtimeArtifactLeases: [nextBase, nextConsumer],
    })
    const importExpression = expressions.find(expression => expression.includes(nextBase.importSource))!
    expect(importExpression.indexOf('"base": await')).toBeLessThan(importExpression.indexOf('"consumer": await'))
    expect(importExpression).toContain(nextBase.importSource)
    expect(importExpression).toContain(nextConsumer.importSource)
    await runtime.publish('tx')
    const publication = expressions.find(expression => expression.includes(nextBase.publishSource))!
    expect(publication.indexOf(nextBase.publishSource)).toBeLessThan(publication.indexOf(nextConsumer.publishSource))
    expect(publication.indexOf(nextConsumer.publishSource)).toBeLessThan(
      publication.indexOf('runtime.publishPluginMutation'),
    )
    await runtime.complete('tx')
    await runtime.finalize('tx')
    expect(oldBase.retire).toHaveBeenCalledOnce()
    expect(oldConsumer.retire).toHaveBeenCalledOnce()
    expect(runtime.activeBrowserGraph('base', 'base-new')?.loadSource).toBe(nextBase.importSource)
    expect(runtime.activeBrowserGraph('consumer', 'consumer-new')?.loadSource).toBe(nextConsumer.importSource)

    const rollbackRuntime = new CdpPluginLifecycleRuntime()
    const rollbackBase = lease('base', 'base-new', 'rollbackBase')
    const rollbackConsumer = lease('consumer', 'consumer-new', 'rollbackConsumer')
    let rollbackEpoch = ''
    let baseRetirementAttempts = 0
    let consumerRetirementAttempts = 0
    rollbackRuntime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'rollback-closure',
                  transactionEpoch: rollbackEpoch,
                  expectedRegistryEpoch: 0,
                  afterRegistryEpoch: 1,
                },
              },
            },
          }
        }
        if (expression.includes('rollbackPluginMutation')) {
          return {
            result: {
              value: {
                ok: true,
                result: {
                  transactionId: 'rollback-closure',
                  transactionEpoch: rollbackEpoch,
                  registryEpoch: 2,
                  active: previous,
                  disposedAfter: candidate,
                },
              },
            },
          }
        }
        if (expression === rollbackConsumer.retireSource) {
          consumerRetirementAttempts += 1
          return { result: { value: true } }
        }
        if (expression === rollbackBase.retireSource) {
          baseRetirementAttempts += 1
          return { result: { value: baseRetirementAttempts > 1 } }
        }
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    const rollbackFence = rollbackRuntime.prepare('rollback-closure')
    rollbackEpoch = rollbackFence.transactionEpoch
    await rollbackRuntime.stage({
      transactionId: 'rollback-closure',
      ...rollbackFence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'base',
      affectedPluginIds: ['base', 'consumer'],
      package: {
        manifest: { id: 'base', runtimeManifest: { schemaVersion: 1, capabilities: [] } },
        digest: `sha256:${'b'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///base-next.js',
      } as never,
      runtimeArtifactSource: rollbackBase.importSource,
      runtimeArtifactLease: rollbackBase,
      runtimeArtifactLeases: [rollbackBase, rollbackConsumer],
    })
    await expect(rollbackRuntime.rollback('rollback-closure')).rejects.toThrow(
      'plugin generation resource operation failed',
    )
    expect(consumerRetirementAttempts).toBe(1)
    expect(rollbackConsumer.retire).toHaveBeenCalledOnce()
    expect(baseRetirementAttempts).toBe(1)
    expect(rollbackBase.retire).not.toHaveBeenCalled()
    await expect(rollbackRuntime.rollback('rollback-closure')).resolves.toMatchObject({
      transactionId: 'rollback-closure',
    })
    expect(consumerRetirementAttempts).toBe(1)
    expect(rollbackConsumer.retire).toHaveBeenCalledOnce()
    expect(baseRetirementAttempts).toBe(2)
    expect(rollbackBase.retire).toHaveBeenCalledOnce()
  })
})
