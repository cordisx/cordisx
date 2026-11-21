import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementResult, PluginManagementSnapshot } from '../packages/cli/src/management/contracts.js'
import { localPackageV4, localPackageV5 } from './suites/plugin-lifecycle.fixtures.js'

const run = promisify(execFile)

it('applies scoped deferred reviews for V5 and V4 manifests through the real service owner and socket', async () => {
  const root = await mkdtemp('/tmp/cx-permission-review-owner-')
  const cordisxHome = path.join(root, 'cordisx')
  const cli = path.resolve('packages/cli/dist/src/cli.js')
  const profile = 'review-fixture'
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CORDISX_')),
  )
  env.CORDISX_HOME = cordisxHome
  env.CORDISX_MODEL_API_PORT = '0'
  const command = async (action: string) =>
    await run(process.execPath, [
      cli,
      action,
      '--mode',
      'service',
      'codex',
      profile,
      '--json',
    ], { env, cwd: root, timeout: 30000 })
  try {
    await mkdir(cordisxHome)
    const v4Package = await localPackageV5(root)
    const v2Package = await localPackageV4(root)
    expect(JSON.parse((await command('start')).stdout)).toMatchObject({ status: 'ready', mode: 'service' })
    const paths = pluginManagementRpcPaths(cordisxHome, 'codex', profile)
    const endpoint = (await readPluginManagementRpcEndpoint(paths))!
    const request = (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
      requestPluginManagementRpc(paths, endpoint, operation)
    const reviewPlan = async (sourceDirectory: string) => {
      const planned = await request({
        kind: 'plan',
        request: { kind: 'plugin-plan-local', sourceDirectory },
      }) as PluginManagementResult
      if (planned.status !== 'planned' || !planned.executionRequest) throw new Error('planning failed')
      const result = await request({ kind: 'execute', request: planned.executionRequest }) as PluginManagementResult
      if (result.status !== 'permission-review-required') throw new Error(`review was not required: ${result.status}`)
      return result
    }
    const before = await reviewPlan(v4Package)
    const plan = before.permissionPlan
    if (plan.schemaVersion !== 7) throw new Error('expected deferred permission plan')
    expect(plan.identity.pluginId).toBe('permission-v5')
    const declarations = plan.declarations.filter(item => item.decisionRequired)
    expect(declarations.map(item => [item.capability, item.required])).toEqual([['models.read', true]])
    expect(plan.declarations.find(item => item.capability === 'ui.host-dom.read')).toMatchObject({
      required: false,
      decisionRequired: false,
      authorizationMode: 'deferred',
    })
    for (const declaration of declarations) {
      expect(declaration.allowedDecisions).toContain('allow-once')
      expect(declaration.allowedDecisions).toContain('deny-once')
    }
    const decision = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json' as const,
      schemaVersion: 7 as const,
      origin: 'explicit-user' as const,
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: declarations.map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: item.required ? 'allow-once' as const : 'deny-once' as const,
      })),
    }
    const operation = {
      kind: 'permission-review-apply' as const,
      userConfirmed: true as const,
      expectedRevision: before.snapshot.activationRevision,
      decision,
    }
    // Cancelling the review sends no decision, and does not change activation.
    expect((await request({ kind: 'query' }) as PluginManagementSnapshot).activationRevision).toBe(0)
    await expect(request({ ...operation, userConfirmed: false } as never)).rejects.toThrow('invalid permission review')
    await expect(request({ ...operation, decision: { ...decision, profileId: 'other-profile' } })).rejects.toThrow(
      'invalid permission review',
    )
    await expect(requestPluginManagementRpc(paths, { ...endpoint, token: '0'.repeat(64) }, operation))
      .rejects.toThrow('scope is invalid')
    expect(await request({ ...operation, expectedRevision: 50 })).toEqual({
      status: 'rejected',
      reason: 'stale-revision',
    })
    expect(
      await request({
        ...operation,
        decision: { ...decision, binding: { ...decision.binding, runtimeGeneration: 'expired' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'stale-generation' })
    expect(await request({ ...operation, decision: { ...decision, decisions: [] } })).toEqual({
      status: 'rejected',
      reason: 'permission-denied',
    })
    expect(
      await request({
        ...operation,
        decision: { ...decision, decisions: decision.decisions.map(item => ({ ...item, scope: {} })) },
      }),
    ).toEqual({ status: 'rejected', reason: 'permission-denied' })
    expect(
      await request({
        ...operation,
        decision: { ...decision, identity: { ...decision.identity, pluginId: 'other-plugin' } },
      }),
    ).toEqual({ status: 'rejected', reason: 'permission-denied' })
    expect(
      await request({
        ...operation,
        decision: {
          ...decision,
          decisions: decision.decisions.map(item => ({ ...item, securityFingerprint: `sha256:${'0'.repeat(64)}` })),
        },
      }),
    ).toEqual({ status: 'rejected', reason: 'permission-denied' })
    expect(
      await request({
        ...operation,
        decision: { ...decision, decisions: decision.decisions.map(item => ({ ...item, decision: 'deny-once' })) },
      }),
    ).toEqual({ status: 'rejected', reason: 'permission-denied' })
    expect((await request({ kind: 'query' }) as PluginManagementSnapshot).activationRevision).toBe(0)

    const applied = await Promise.all([request(operation), request(operation)])
    expect(applied).toContainEqual(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({ outcome: 'applied', operation: 'install', revision: 1 }),
    }))
    expect(applied).toContainEqual({
      status: 'rejected',
      reason: expect.stringMatching(/^(review-busy|stale-revision)$/),
    })
    expect(await request({ kind: 'query' })).toMatchObject({
      activationRevision: 1,
      plugins: [{ id: 'permission-v5', status: 'unavailable-in-service-mode' }],
    })
    // Replaying a confirmed choice after the activation changed is never applied twice.
    expect(await request(operation)).toEqual({ status: 'rejected', reason: 'stale-revision' })

    const next = await reviewPlan(v2Package)
    const v2 = next.permissionPlan
    if (v2.schemaVersion !== 7) throw new Error('expected deferred permission plan')
    expect(v2.declarations.find(item => item.capability === 'tasks.control')).toMatchObject({
      required: false,
      decisionRequired: false,
      authorizationMode: 'deferred',
    })
    const v2Operation = {
      kind: 'permission-review-apply' as const,
      userConfirmed: true as const,
      expectedRevision: next.snapshot.activationRevision,
      decision: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json' as const,
        schemaVersion: 7 as const,
        origin: 'explicit-user' as const,
        planId: v2.planId,
        operation: v2.operation,
        profileId: v2.profileId,
        identity: v2.identity,
        binding: v2.binding,
        decisions: v2.declarations.filter(item => item.decisionRequired).map(item => ({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: item.required ? 'allow-once' as const : 'deny-once' as const,
        })),
      },
    }
    expect(
      await request({
        ...v2Operation,
        decision: { ...v2Operation.decision, decisions: [] },
      }),
    ).toEqual({ status: 'rejected', reason: 'permission-denied' })
    expect(await request(v2Operation)).toMatchObject({
      status: 'ok',
      result: { outcome: 'applied', operation: 'install', revision: 2 },
    })
  } finally {
    await command('stop').catch(() => undefined)
    const allowRemoval = async (directory: string) => {
      await chmod(directory, 0o700)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await allowRemoval(path.join(directory, entry.name))
      }
    }
    await allowRemoval(root)
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
