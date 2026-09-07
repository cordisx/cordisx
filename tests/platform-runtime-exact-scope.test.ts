import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  type CordisXPermissionAuthorizationPlanV2,
} from '../packages/cli/src/permission-contracts.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  normalizePluginManifestV12,
  normalizePluginManifestV13,
} from '../packages/cli/src/runtime-exact-request-permissions.js'
import {
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'
import {
  materializeRuntimeExactScope,
  normalizeAbsoluteCwd,
} from '../packages/cli/src/renderer/platform/platform-runtime-exact-scope.js'

const identity = { source: 'https://plugins.example/runtime-exact', id: 'runtime-exact' }

function manifest() {
  return normalizePluginManifestV13({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
    schemaVersion: 13,
    id: identity.id,
    capabilities: [
      { name: 'tasks.create', required: false, scope: { runtime: 'exact-request' } },
      { name: 'tasks.control', required: false, scope: { runtime: 'exact-request' } },
    ],
    services: [],
  }, identity.id)
}

function allowOnce(plan: CordisXPermissionAuthorizationPlanV2) {
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

describe('Platform runtime exact-request scope', () => {
  it('admits the marker only at v13 with optional required semantics', () => {
    const candidate = {
      id: identity.id,
      capabilities: [{ name: 'tasks.create', required: false, scope: { runtime: 'exact-request' } }],
      services: [],
    }
    expect(() =>
      normalizePluginManifestV12({
        ...candidate,
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
        schemaVersion: 12,
      }, identity.id)
    ).toThrow('manifest v12 must not declare runtime exact-request scope')
    expect(() =>
      normalizePluginManifestV13({
        ...candidate,
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
        schemaVersion: 13,
        capabilities: [{ name: 'tasks.create', required: true, scope: { runtime: 'exact-request' } }],
      }, identity.id)
    ).toThrow('Invalid runtime exact-request declaration')
  })

  it('preserves v10 visuals, v11 usage, and v12 Agent task declarations through v13', () => {
    const capabilities = [
      {
        name: 'ui.extension-points.render',
        required: false,
        scope: { extensionPoints: ['composer.frame.overlay'] },
      },
      {
        name: 'ui.extension-points.interact',
        required: false,
        scope: { extensionPoints: ['composer.frame.overlay'], events: ['pointer.observe'] },
      },
      { name: 'usage.read', required: false, scope: { profile: 'current' } },
      {
        name: 'approvals.request',
        required: false,
        scope: { task: { kind: 'agent-task-command', commandId: 'delegate' } },
      },
    ]
    const v12 = normalizePluginManifestV12({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
      schemaVersion: 12,
      id: identity.id,
      capabilities,
      services: [],
    }, identity.id)
    const v13 = normalizePluginManifestV13({
      ...v12,
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
      schemaVersion: 13,
      capabilities: [...v12.capabilities, {
        name: 'tasks.create',
        required: false,
        scope: { runtime: 'exact-request' },
      }],
    }, identity.id)
    expect(v13.capabilities.map(item => item.name)).toEqual([
      'ui.extension-points.render',
      'ui.extension-points.interact',
      'usage.read',
      'approvals.request',
      'tasks.create',
    ])
  })

  it('keeps markers out of activation decisions and materializes each validated request', async () => {
    const plans: CordisXPermissionAuthorizationPlanV2[] = []
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date(),
      50,
      'work',
      'runtime-1',
      undefined,
      undefined,
      {
        request: async plan => {
          plans.push(plan)
          return allowOnce(plan)
        },
      },
    )
    broker.register(identity, manifest(), { pluginId: identity.id, moduleGeneration: 'module-1' })
    expect(broker.authorizationPlanV2(identity, 'install').declarations).toEqual([])
    expect(broker.requiredDenied(identity)).toEqual([])
    expect(broker.runtimeExactExplanations()).toEqual([
      { identity, capability: 'tasks.create' },
      { identity, capability: 'tasks.control' },
    ])

    await expect(broker.authorize(identity, 'tasks.create', {
      providerId: 'provider-a',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      cwd: '/workspace/a',
    })).resolves.toMatchObject({
      ok: true,
      value: {
        declaration: {
          scope: {
            providers: ['provider-a'],
            cwdRoots: ['/workspace/a'],
          },
        },
      },
    })
    await expect(broker.authorize(identity, 'tasks.create', {
      providerId: 'provider-a',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      cwd: '/workspace/b',
    })).resolves.toMatchObject({ ok: true })
    expect(plans).toHaveLength(2)
    expect(plans[0]?.declarations[0]?.securityFingerprint).not.toBe(plans[1]?.declarations[0]?.securityFingerprint)

    const promptsBeforeMissing = plans.length
    await expect(broker.authorize(identity, 'tasks.create', {
      providerId: 'provider-a',
    })).resolves.toMatchObject({ ok: false, error: { code: 'permission-undeclared' } })
    expect(plans).toHaveLength(promptsBeforeMissing)

    const session = { providerId: 'provider-a', remoteSessionId: 'session-a' }
    await expect(broker.authorize(identity, 'tasks.control', { providerId: 'provider-a', session }))
      .resolves.toMatchObject({ ok: true })
    await expect(broker.authorize(identity, 'tasks.control', { providerId: 'provider-a', session }))
      .resolves.toMatchObject({ ok: true })
    expect(plans).toHaveLength(4)
  })

  it('canonicalizes CWD with the explicit execution platform and rejects ambiguous namespaces', () => {
    expect(normalizeAbsoluteCwd('/workspace/project/../secret', 'posix')).toBe('/workspace/secret')
    expect(normalizeAbsoluteCwd('C:\\workspace\\project', 'posix')).toBeUndefined()
    expect(normalizeAbsoluteCwd('C:\\workspace\\project\\..\\secret', 'win32')).toBe('C:\\workspace\\secret')
    expect(normalizeAbsoluteCwd('C:\\', 'win32')).toBe('C:\\')
    expect(normalizeAbsoluteCwd('\\\\server\\share\\project\\..\\secret', 'win32'))
      .toBe('\\\\server\\share\\secret')
    expect(normalizeAbsoluteCwd('\\\\?\\C:\\workspace\\secret', 'win32')).toBeUndefined()
    expect(normalizeAbsoluteCwd('\\\\.\\pipe\\name', 'win32')).toBeUndefined()
    expect(normalizeAbsoluteCwd('C:\\CON\\secret', 'win32')).toBeUndefined()
    expect(normalizeAbsoluteCwd('C:\\workspace\\name. ', 'win32')).toBeUndefined()
    expect(normalizeAbsoluteCwd('\\workspace\\project', 'win32')).toBeUndefined()
    expect(materializeRuntimeExactScope('tasks.content.read', {
      providerId: 'provider-a',
      session: { providerId: 'provider-a', remoteSessionId: 'session-a' },
    }, 'posix')).toEqual({ sessions: [{ providerId: 'provider-a', remoteSessionId: 'session-a' }] })
  })

  it('validates the live provider and model before prompting or dispatching exact creation', async () => {
    const plans: CordisXPermissionAuthorizationPlanV2[] = []
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date(),
      50,
      'work',
      'runtime-1',
      undefined,
      undefined,
      {
        request: async plan => {
          plans.push(plan)
          return allowOnce(plan)
        },
      },
    )
    broker.register(identity, manifest(), { pluginId: identity.id, moduleGeneration: 'module-1' })
    const createTask = vi.fn(async input => ({
      ok: true as const,
      value: {
        contract: 'cordisx.platform-session/v1' as const,
        schemaVersion: 1 as const,
        ref: { providerId: 'provider-a', remoteSessionId: 'session-a' },
        hostId: 'desktop',
        model: input.model,
        cwd: input.cwd,
        state: 'active' as const,
      },
    }))
    const exactAdapter = {
      listModels: async () => ({
        ok: true as const,
        value: {
          contract: 'cordisx.platform-model-page/v1' as const,
          schemaVersion: 1 as const,
          providerIds: ['provider-a'],
          models: [{
            contract: 'cordisx.platform-model/v1' as const,
            schemaVersion: 1 as const,
            hostId: 'desktop',
            ref: { providerId: 'provider-a', modelId: 'model-a' },
            label: 'Model A',
          }],
        },
      }),
      createTask,
    }
    const root = new Context()
    const fiber = root.plugin(CordisXPlatformService, {
      executionPlatform: 'posix',
      broker,
      adapter: {
        ...exactAdapter,
        withExactProviderGeneration: async (_providerId: string, operation: (value: never) => Promise<unknown>) =>
          await operation(exactAdapter as never),
      } as never,
    })
    await fiber
    const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    try {
      await expect(ctx.platform.tasks.create({
        model: { providerId: 'provider-a', modelId: 'missing' },
        cwd: '/workspace',
      })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-model' } })
      expect(plans).toHaveLength(0)
      await expect(ctx.platform.tasks.create({
        model: { providerId: 'provider-a', modelId: 'model-a' },
        cwd: '/workspace/project/../target',
      })).resolves.toMatchObject({ ok: true })
      expect(plans[0]?.declarations[0]?.scope).toEqual({ providers: ['provider-a'], cwdRoots: ['/workspace/target'] })
      expect(createTask).toHaveBeenCalledWith({
        model: { providerId: 'provider-a', modelId: 'model-a' },
        cwd: '/workspace/target',
      })
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })
})
