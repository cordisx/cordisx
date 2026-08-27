import { describe, expect, it } from 'vitest'
import {
  CdpLifecycleRequestGate,
  CdpPluginLifecycleRuntime,
  injectableTargets,
  serviceConfigResponseEvaluation,
  type CdpTarget,
} from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PluginPermissionIdentityRegistry } from '../packages/cli/src/launcher/permission-rpc.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { RollbackPlan } from '../packages/cli/src/launcher/packages/authority.js'

function target(id: string, title: string, url = 'https://example.test/'): CdpTarget {
  return { id, title, url, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1/${id}` }
}

describe('injectableTargets', () => {
  it('keeps Codex renderer pages and excludes unrelated Electron pages', () => {
    expect(injectableTargets([
      target('settings', 'Settings'),
      target('codex', 'Codex'),
      target('avatar', 'Codex', 'app://-/index.html?initialRoute=%2Favatar-overlay'),
      target('auth', 'Authentication'),
    ]).map(item => item.id)).toEqual(['codex'])
  })

  it('fails closed when branding is absent instead of injecting an unrelated page', () => {
    expect(injectableTargets([
      target('first', 'Desktop'),
      target('second', 'Settings'),
    ])).toEqual([])
  })
})

describe('service config CDP responses', () => {
  it('returns to the exact execution context that issued the binding request', () => {
    const params = serviceConfigResponseEvaluation({ requestId: 'request-1', ok: true, value: [] }, 73)
    expect(params).toMatchObject({ contextId: 73, allowUnsafeEvalBlockedByCSP: true, returnByValue: true })
    expect(params.expression).toContain('__cordisxServiceConfigReceiveV1')
    expect(serviceConfigResponseEvaluation({ requestId: 'request-2', ok: false })).not.toHaveProperty('contextId')
  })
})

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
    plugins: [{ id: 'demo', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, moduleGeneration: generation, enabled: revision === 0, dependencies: [] }],
  }
}

describe('CdpPluginLifecycleRuntime', () => {
  it('removes a closed development renderer and refuses a replacement until the generation fence clears', () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const first = { send: async () => ({}) } as never
    const second = { send: async () => ({}) } as never
    const unregisterFirst = runtime.register(first)
    const fence = runtime.prepare('in-flight')
    expect(fence.expectedRegistryEpoch).toBe(0)
    expect(() => runtime.register(second)).toThrow('cannot register a CordisX renderer during a plugin generation transaction')
    runtime.cancelPreparation('in-flight')
    const unregisterSecond = runtime.register(second)
    unregisterSecond()
    unregisterFirst()
    expect(() => runtime.prepare('after-target-close')).toThrow('no ready CordisX renderer is available')
  })

  it('projects first-build local diagnostics without requiring a formal lifecycle bridge', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const expressions: string[] = []
    runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        expressions.push(String(params.expression ?? ''))
        return { result: { value: { ok: true, result: true } } }
      },
    } as never)
    await runtime.updateDevelopmentStatus({
      origin: 'local-dev',
      pluginId: 'broken',
      sourcePath: '/absolute/plugin/broken.ts',
      state: 'failed',
      error: 'fixture build failed',
    })
    expect(expressions).toHaveLength(1)
    expect(expressions[0]).toContain('updateLocalDevelopmentStatus')
    expect(expressions[0]).toContain('/absolute/plugin/broken.ts')
  })

  it('stages every renderer before reporting one failure so the closure can roll back everywhere', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    const stageCalls = [0, 0]
    const session = (index: number, fail: boolean) => ({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) {
          stageCalls[index]! += 1
          return { result: { value: fail ? { ok: false, error: 'fixture readiness failure' } : {
            ok: true,
            result: { transactionId: 'tx', transactionEpoch: 'tx:formal', expectedRegistryEpoch: 0, afterRegistryEpoch: 1 },
          } } }
        }
        if (expression.includes('rollbackPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch: 'tx:formal', registryEpoch: 2, active: previous, disposedAfter: candidate,
        } } } }
        return {}
      },
    })
    runtime.register(session(0, false) as never)
    runtime.register(session(1, true) as never)
    const fence = runtime.prepare('tx')
    const mutation: PluginRuntimeMutation = {
      transactionId: 'tx',
      ...fence,
      afterRegistryEpoch: 1,
      operation: 'disable',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
    }
    await expect(runtime.stage(mutation)).rejects.toThrow('fixture readiness failure')
    expect(stageCalls).toEqual([1, 1])
    await expect(runtime.rollback('tx')).resolves.toMatchObject({ registryEpoch: 2, active: previous, disposedAfter: candidate })
    expect(runtime.prepare('tx-after-rollback')).toMatchObject({ expectedRegistryEpoch: 2 })
  })

  it('releases an empty staged transaction when its last renderer closes before rollback', async () => {
    const permissions = new PluginPermissionIdentityRegistry([{ id: 'demo', source: 'file:///demo-old.js' }])
    const runtime = new CdpPluginLifecycleRuntime(permissions)
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    let transactionEpoch = ''
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        return { result: { value: undefined } }
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    const mutation: PluginRuntimeMutation = {
      transactionId: 'tx',
      ...fence,
      afterRegistryEpoch: 1,
      operation: 'update',
      previous,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      package: {
        manifest: { id: 'demo' },
        digest: `sha256:${'b'.repeat(64)}`,
        moduleSource: '',
        artifactSource: 'void 0',
        serviceModules: [],
        identitySource: 'file:///demo-new.js',
      } as never,
    }
    await runtime.stage(mutation)
    expect(permissions.allowed({ id: 'demo', source: 'file:///demo-new.js' })).toBe(true)

    unregister()
    await expect(runtime.rollback('tx')).resolves.toEqual({
      transactionId: 'tx',
      transactionEpoch,
      registryEpoch: 0,
      active: previous,
      disposedAfter: candidate,
    })
    expect(permissions.allowed({ id: 'demo', source: 'file:///demo-old.js' })).toBe(true)
    expect(permissions.allowed({ id: 'demo', source: 'file:///demo-new.js' })).toBe(false)

    const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
    expect(runtime.prepare('replacement')).toMatchObject({ expectedRegistryEpoch: 0 })
    runtime.cancelPreparation('replacement')
    unregisterReplacement()
  })

  it('releases terminal fences when renderer finalize and abort calls fail', async () => {
    for (const terminal of ['finalize', 'abort'] as const) {
      const runtime = new CdpPluginLifecycleRuntime()
      const previous = activation(0, 'demo-old')
      const candidate = activation(1, 'demo-new')
      let transactionEpoch = ''
      const unregister = runtime.register({
        async send(_method: string, params: Record<string, unknown>) {
          const expression = String(params.expression ?? '')
          if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
            transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
          } } } }
          if (expression.includes('publishPluginMutation')) return { result: { value: { ok: true, result: {
            transactionId: 'tx', transactionEpoch, registryEpoch: 1, active: candidate,
          } } } }
          if (expression.includes('completePluginMutation')) return { result: { value: { ok: true, result: {
            transactionId: 'tx', transactionEpoch, registryEpoch: 1, active: candidate, disposedAfter: previous,
          } } } }
          if (expression.includes(`${terminal}PluginMutation`)) return { result: { value: { ok: false, error: `fixture ${terminal} failure` } } }
          return {}
        },
      } as never)
      const fence = runtime.prepare('tx')
      transactionEpoch = fence.transactionEpoch
      await runtime.stage({
        transactionId: 'tx', ...fence, afterRegistryEpoch: 1, operation: 'disable', previous, candidate,
        targetId: 'demo', affectedPluginIds: ['demo'],
      })
      if (terminal === 'finalize') {
        await runtime.publish('tx')
        await runtime.complete('tx')
      }
      await expect(terminal === 'finalize' ? runtime.finalize('tx') : runtime.abort('tx')).rejects.toThrow(`fixture ${terminal} failure`)

      const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
      expect(runtime.prepare(`replacement-${terminal}`)).toMatchObject({ expectedRegistryEpoch: terminal === 'finalize' ? 1 : 0 })
      runtime.cancelPreparation(`replacement-${terminal}`)
      unregisterReplacement()
      unregister()
    }
  })

  it('restores the bootstrap epoch when the published renderer closes before cleanup', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    let transactionEpoch = ''
    const unregister = runtime.register({
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        if (expression.includes('stagePluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, expectedRegistryEpoch: 0, afterRegistryEpoch: 1,
        } } } }
        if (expression.includes('publishPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch, registryEpoch: 1, active: candidate,
        } } } }
        return {}
      },
    } as never)
    const fence = runtime.prepare('tx')
    transactionEpoch = fence.transactionEpoch
    await runtime.stage({
      transactionId: 'tx', ...fence, afterRegistryEpoch: 1, operation: 'disable', previous, candidate,
      targetId: 'demo', affectedPluginIds: ['demo'],
    })
    await expect(runtime.publish('tx')).resolves.toMatchObject({ registryEpoch: 1, active: candidate })

    unregister()
    await expect(runtime.complete('tx')).rejects.toThrow('cleanup observations disagree')
    await expect(runtime.rollback('tx')).resolves.toMatchObject({ registryEpoch: 0, active: previous, disposedAfter: candidate })
    const unregisterReplacement = runtime.register({ send: async () => ({}) } as never)
    expect(runtime.prepare('replacement-after-publish')).toMatchObject({ expectedRegistryEpoch: 0 })
    runtime.cancelPreparation('replacement-after-publish')
    unregisterReplacement()
  })

  it('recovers a rollback plan in a fresh renderer and adopts the restored durable revision', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const previous = activation(0, 'demo-old')
    const candidate = activation(1, 'demo-new')
    const expressions: string[] = []
    const session = {
      async send(_method: string, params: Record<string, unknown>) {
        const expression = String(params.expression ?? '')
        expressions.push(expression)
        if (expression.includes('recoverPluginMutation')) return { result: { value: { ok: true, result: {
          transactionId: 'tx', transactionEpoch: 'tx:formal', registryEpoch: 2,
          active: previous, disposedAfter: candidate,
        } } } }
        if (expression.includes('adoptRecoveredActivation')) return { result: { value: { ok: true } } }
        return {}
      },
    }
    runtime.register(session as never)
    const tuple = (record: CordisXPluginActivationRecordV1) => ({
      profileId: record.profileId,
      revision: record.revision,
      lastGoodRevision: record.lastGoodRevision,
      runtimeGeneration: record.runtimeGeneration,
      plugins: record.plugins,
    })
    const plan: RollbackPlan = {
      transactionId: 'tx',
      transactionEpoch: 'tx:formal',
      rollbackToken: 'rollback:test' as RollbackPlan['rollbackToken'],
      candidateFingerprint: 'candidate-fingerprint',
      expectedPublished: tuple(candidate),
      rollbackTarget: tuple(previous),
      expectedRegistryEpoch: 0,
      rollbackRegistryEpoch: 2,
    }
    await expect(runtime.recoverRollback(plan)).resolves.toMatchObject({
      transactionId: 'tx', registryEpoch: 2, active: previous, disposedAfter: candidate,
    })
    const restored = { ...previous, recordKind: 'active' as const, revision: 2, lastGoodRevision: 0 }
    await runtime.adoptRecoveredActivation(restored, 2)
    await runtime.synchronizeRecoveredActivation(session as never)
    expect(expressions.filter(expression => expression.includes('recoverPluginMutation'))).toHaveLength(1)
    expect(expressions.filter(expression => expression.includes('adoptRecoveredActivation'))).toHaveLength(1)
    expect(runtime.prepare('next')).toMatchObject({ expectedRegistryEpoch: 2 })
  })
})

describe('CdpLifecycleRequestGate', () => {
  it('releases the single-flight fence before a response-triggered follow-up', async () => {
    const gate = new CdpLifecycleRequestGate()
    const values: number[] = []
    let followUp: Promise<void> | undefined

    await gate.run(async () => 1, async value => {
      values.push(value)
      followUp = gate.run(async () => 2, async next => { values.push(next) })
    })
    await followUp

    expect(values).toEqual([1, 2])
  })

  it('rejects a genuinely concurrent lifecycle task', async () => {
    const gate = new CdpLifecycleRequestGate()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const active = gate.run(async () => { await blocked }, async () => undefined)

    await expect(gate.run(async () => undefined, async () => undefined)).rejects.toThrow(/already active/)
    release()
    await active
  })
})
