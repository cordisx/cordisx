import { describe, expect, it } from 'vitest'
import { CdpPluginLifecycleRuntime, injectableTargets, type CdpTarget } from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
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
