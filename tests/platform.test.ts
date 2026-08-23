import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXCapabilityDeclaration,
  type CordisXModelDescriptor,
  type CordisXPlatformResult,
  type CordisXPluginIdentity,
  type CordisXPluginManifestV1,
  type CordisXTaskSummary,
} from '../packages/cli/src/contracts.js'
import {
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  PermissionBroker,
  ProjectionPlatformAdapter,
  UnavailablePlatformAdapter,
  normalizePluginManifest,
  type CordisXPlatformAdapter,
  type PermissionPrompt,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'

const identity: CordisXPluginIdentity = { source: 'file:///plugins/demo.ts', id: 'demo' }
const models: readonly CordisXModelDescriptor[] = [
  { hostId: 'desktop', providerId: 'codex', id: 'gpt-5.6', label: 'GPT-5.6', isDefault: true },
  { hostId: 'desktop', providerId: 'zcode', id: 'z-1', label: 'Z-1' },
]
const task: CordisXTaskSummary = {
  id: 'task-1',
  hostId: 'desktop',
  providerId: 'codex',
  modelId: 'gpt-5.6',
  cwd: '/workspace/project',
  state: 'active',
}

function declaration(
  name: CordisXCapabilityDeclaration['name'],
  options: Partial<Omit<CordisXCapabilityDeclaration, 'name'>> = {},
): CordisXCapabilityDeclaration {
  return {
    name,
    required: options.required ?? false,
    reason: options.reason ?? { key: `permission.${name.replaceAll('.', '-')}`, fallback: `Use ${name}` },
    scope: options.scope ?? {},
  }
}

function manifest(id: string, capabilities: readonly CordisXCapabilityDeclaration[]): CordisXPluginManifestV1 {
  return normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id,
    capabilities,
  }, id)
}

function prompt(decision: 'allow' | 'deny' = 'allow'): PermissionPrompt & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(async () => decision) }
}

function resultError(code: 'adapter-failure'): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message: 'simulated adapter error', retryable: true } }
}

function fakeAdapter(overrides: Partial<CordisXPlatformAdapter> = {}): CordisXPlatformAdapter & {
  createTask: ReturnType<typeof vi.fn>
  submitTurn: ReturnType<typeof vi.fn>
  controlTask: ReturnType<typeof vi.fn>
} {
  const base = {
    status: () => ({
      hostId: 'desktop',
      hostName: 'Desktop',
      mode: 'read-write' as const,
      supportedCapabilities: [...(models.length > 0 ? ['models.read'] as const : [])],
      diagnostics: [],
      secondConnectionCreated: false as const,
      rawBridgeExposed: false as const,
    }),
    listModels: vi.fn(async () => ({ ok: true as const, value: models })),
    listTasks: vi.fn(async () => ({ ok: true as const, value: [task] })),
    readTask: vi.fn(async () => ({ ok: true as const, value: { ...task, turns: [] } })),
    createTask: vi.fn(async () => ({ ok: true as const, value: task })),
    controlTask: vi.fn(async input => input.action === 'delete'
      ? { ok: true as const, value: { action: 'delete' as const, taskId: input.taskId, deleted: true as const } }
      : { ok: true as const, value: { action: input.action, task } }),
    submitTurn: vi.fn(async () => ({ ok: true as const, value: { taskId: task.id, turnId: 'turn-1' } })),
    controlTurn: vi.fn(async input => ({ ok: true as const, value: { action: input.action, taskId: input.taskId } })),
  }
  return Object.assign(base, overrides) as unknown as ReturnType<typeof fakeAdapter>
}

async function platformContext(
  adapter: CordisXPlatformAdapter,
  broker: PermissionBroker,
  pluginIdentity: CordisXPluginIdentity = identity,
): Promise<{ root: Context; fiber: Awaited<ReturnType<Context['plugin']>>; ctx: Context }> {
  const root = new Context()
  const fiber = root.plugin(CordisXPlatformService, { adapter, broker })
  await fiber
  const ctx = root.extend({
    [CORDISX_PLUGIN_ID]: pluginIdentity.id,
    [CORDISX_PLUGIN_SOURCE]: pluginIdentity.source,
  })
  return { root, fiber, ctx }
}

describe('Platform capability runtime', () => {
  it('validates provider and model against current adapter data before two-phase creation', async () => {
    const adapter = fakeAdapter()
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt())
    broker.register(identity, manifest(identity.id, [declaration('tasks.create')]))
    broker.setPolicy(identity, 'tasks.create', 'allow')
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      await expect(ctx.platform.tasks.create({ providerId: 'missing', modelId: 'x', cwd: '/workspace' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-provider' } })
      await expect(ctx.platform.tasks.create({ providerId: 'codex', modelId: 'missing', cwd: '/workspace' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-model' } })
      await expect(ctx.platform.tasks.create({
        providerId: 'codex',
        modelId: 'gpt-5.6',
        cwd: '/workspace',
        initialMessage: 'Start here',
      })).resolves.toMatchObject({
        ok: true,
        value: { status: 'created', task: { id: 'task-1' }, initialTurn: { turnId: 'turn-1' } },
      })
      expect(adapter.createTask).toHaveBeenCalledTimes(1)
      expect(adapter.submitTurn).toHaveBeenCalledWith({ taskId: 'task-1', message: 'Start here' })
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('retains the created task when the initial turn fails and never performs cleanup control', async () => {
    const adapter = fakeAdapter({ submitTurn: vi.fn(async () => resultError('adapter-failure')) })
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt())
    broker.register(identity, manifest(identity.id, [declaration('tasks.create')]))
    broker.setPolicy(identity, 'tasks.create', 'allow')
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      const result = await ctx.platform.tasks.create({
        providerId: 'codex',
        modelId: 'gpt-5.6',
        cwd: '/workspace',
        initialMessage: 'Start here',
      })
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'created-initial-turn-failed',
          task: { id: 'task-1' },
          error: { code: 'initial-turn-failed', retryable: true },
        },
      })
      expect(adapter.controlTask).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('enforces ask, deny, allow, required/optional, and scope without adapter dispatch on denial', async () => {
    const ask = prompt('deny')
    const adapter = fakeAdapter()
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), ask, () => new Date('2026-08-23T08:00:00.000Z'))
    broker.register(identity, manifest(identity.id, [
      declaration('models.read', { required: true, scope: { providers: ['codex'] } }),
      declaration('turns.submit', { scope: { taskIds: ['task-1'], cwdRoots: ['/other'] } }),
    ]))
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      await expect(ctx.platform.models.list({ providerId: 'codex' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } })
      expect(ask.request).toHaveBeenCalledTimes(1)

      broker.setPolicy(identity, 'models.read', 'allow')
      await expect(ctx.platform.models.list({ providerId: 'codex' }))
        .resolves.toMatchObject({ ok: true, value: [{ providerId: 'codex' }] })

      broker.setPolicy(identity, 'models.read', 'deny')
      expect(broker.requiredDenied(identity)).toEqual(['models.read'])
      broker.setPolicy(identity, 'models.read', 'allow')
      broker.setPolicy(identity, 'turns.submit', 'deny')
      expect(broker.requiredDenied(identity)).toEqual([])

      broker.setPolicy(identity, 'turns.submit', 'allow')
      await expect(ctx.platform.turns.submit({ taskId: 'task-2', message: 'outside scope' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
      await expect(ctx.platform.turns.submit({ taskId: 'task-1', message: 'outside cwd scope' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
      expect(adapter.submitTurn).not.toHaveBeenCalled()
      expect(broker.snapshots().find(item => item.capability === 'turns.submit')).toMatchObject({ denialCount: 2 })
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('binds call identity to the Cordis context and ignores spoof-like arguments', async () => {
    const other: CordisXPluginIdentity = { source: 'file:///plugins/other.ts', id: 'other' }
    const adapter = fakeAdapter()
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt())
    broker.register(identity, manifest(identity.id, [declaration('turns.submit', { scope: { taskIds: ['task-1'] } })]))
    broker.register(other, manifest(other.id, [declaration('turns.submit', { scope: { taskIds: ['other-task'] } })]))
    broker.setPolicy(identity, 'turns.submit', 'allow')
    broker.setPolicy(other, 'turns.submit', 'deny')
    const { fiber, ctx } = await platformContext(adapter, broker, identity)
    try {
      const spoofed = { taskId: 'task-1', message: 'hello', pluginId: 'other', source: other.source }
      await expect(ctx.platform.turns.submit(spoofed)).resolves.toMatchObject({ ok: true })
      expect(adapter.submitTurn).toHaveBeenCalledWith(spoofed)
      expect((ctx.platform as unknown as { options?: unknown }).options).toBeUndefined()
      expect(Object.keys(ctx.platform)).not.toEqual(expect.arrayContaining(['adapter', 'broker', 'options']))
      const otherPermission = broker.snapshots().find(item => item.identity.id === 'other')
      expect(otherPermission).toMatchObject({ policy: 'deny' })
      expect(otherPermission?.lastUsedAt).toBeUndefined()
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('resets an allow decision to ask when a declaration fingerprint changes', async () => {
    const ask = prompt('allow')
    const store = new MemoryPermissionPolicyStore()
    const broker = new PermissionBroker(store, ask)
    broker.register(identity, manifest(identity.id, [declaration('models.read', { scope: { providers: ['codex'] } })]))
    broker.setPolicy(identity, 'models.read', 'allow')
    expect(broker.policy(identity, 'models.read')).toBe('allow')
    broker.register(identity, manifest(identity.id, [declaration('models.read', { scope: { providers: ['codex', 'zcode'] } })]))
    expect(broker.policy(identity, 'models.read')).toBe('ask')
    const adapter = fakeAdapter()
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      await expect(ctx.platform.models.list({ providerId: 'zcode' })).resolves.toMatchObject({ ok: true })
      expect(ask.request).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('offers authoritative read-only projections while refusing writes', async () => {
    const projection = new ProjectionPlatformAdapter({
      getSnapshot: () => ({
        hostId: 'host',
        hostName: 'Projection Host',
        models,
        tasks: [task],
        taskContents: [{ ...task, turns: [] }],
      }),
    })
    expect(projection.status()).toMatchObject({
      mode: 'read-only',
      supportedCapabilities: ['models.read', 'tasks.catalog.read', 'tasks.content.read'],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    })
    await expect(projection.listModels({ providerId: 'codex' })).resolves.toMatchObject({ ok: true, value: [{ id: 'gpt-5.6' }] })
    await expect(projection.readTask({ taskId: 'task-1' })).resolves.toMatchObject({ ok: true, value: { turns: [] } })
    await expect(projection.createTask({ providerId: 'codex', modelId: 'gpt-5.6', cwd: '/workspace' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'adapter-read-only' } })
  })

  it('reports the unavailable current-connection boundary without a raw bridge or second connection', async () => {
    const adapter = new UnavailablePlatformAdapter()
    expect(adapter.status()).toEqual(expect.objectContaining({
      mode: 'unavailable',
      secondConnectionCreated: false,
      rawBridgeExposed: false,
      diagnostics: [expect.objectContaining({ code: 'current-connection-client-unavailable' })],
    }))
    await expect(adapter.listModels({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'current-connection-client-unavailable' },
    })
  })
})
