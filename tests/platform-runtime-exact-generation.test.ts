import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { CordisXPermissionAuthorizationPlanV2 } from '../packages/cli/src/permission-contracts.js'
import { CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2 } from '../packages/cli/src/permission-contracts.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  normalizePluginManifestV13,
} from '../packages/cli/src/runtime-exact-request-permissions.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import type { CliProxyProviderConfig } from '../packages/cli/src/providers/contracts.js'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import {
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'

const identity = { source: 'https://plugins.example/runtime-exact-generation', id: 'runtime-exact-generation' }

function config(root: string): CliProxyProviderConfig {
  return {
    id: 'alpha',
    kind: 'cli-proxy-api',
    displayName: 'Alpha',
    baseUrl: 'https://alpha.example/v1',
    apiKeyEnv: 'ALPHA_KEY',
    codexExecutable: 'codex',
    codexHome: path.join(root, 'alpha'),
    enabled: true,
    timeoutMs: 1_000,
  }
}

function decision(plan: CordisXPermissionAuthorizationPlanV2) {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2 as const,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: 'allow-once' as const,
    })),
  }
}

it('keeps exact preflight, permission prompt, and dispatch on one Fleet provider generation', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-exact-generation-'))
  const calls: Array<{ readonly generation: string; readonly method: string }> = []
  let generation = 0
  const fleet = await ProviderFleet.create([config(rootDir)], {
    startServer: async (): Promise<CodexAppServerRpc> => {
      const current = `alpha-${++generation}`
      return {
        generation: current,
        request: async <Result>(method: string): Promise<Result> => {
          calls.push({ generation: current, method })
          if (method === 'model/list') {
            return { data: [{ id: 'model-a', model: 'model-a', displayName: 'Model A' }], nextCursor: null } as Result
          }
          if (method === 'thread/start') {
            return {
              thread: {
                id: 'session-a',
                preview: '',
                modelProvider: 'alpha',
                createdAt: 1,
                updatedAt: 1,
                cwd: '/workspace',
                turns: [],
              },
              model: 'model-a',
            } as Result
          }
          throw new Error(`unexpected ${method}`)
        },
        close: async () => undefined,
      }
    },
  })
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    100,
    'work',
    'runtime-1',
    undefined,
    undefined,
    {
      request: async plan => {
        const replacement = await fleet.reconfigure([config(rootDir)])
        await replacement.rollback()
        return decision(plan)
      },
    },
  )
  broker.register(
    identity,
    normalizePluginManifestV13({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
      schemaVersion: 13,
      id: identity.id,
      capabilities: [{ name: 'tasks.create', required: false, scope: { runtime: 'exact-request' } }],
      services: [],
    }, identity.id),
    { pluginId: identity.id, moduleGeneration: 'module-1' },
  )
  const context = new Context()
  const fiber = context.plugin(CordisXPlatformService, { adapter: fleet, broker, executionPlatform: 'posix' })
  await fiber
  const plugin = context.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
  try {
    await expect(plugin.platform.tasks.create({
      model: { providerId: 'alpha', modelId: 'model-a' },
      cwd: '/workspace',
    })).resolves.toMatchObject({ ok: true })
    expect(calls.filter(call => call.method === 'model/list' || call.method === 'thread/start')).toEqual([
      { generation: 'alpha-1', method: 'model/list' },
      { generation: 'alpha-1', method: 'thread/start' },
    ])
  } finally {
    await fiber.dispose()
    broker.dispose()
    await fleet.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})
