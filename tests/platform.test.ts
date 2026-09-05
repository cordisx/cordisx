import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXCapabilityDeclaration,
  type CordisXModelDescriptor,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
  type CordisXPlatformResult,
  type CordisXPluginIdentity,
  type CordisXPluginManifestV1,
  type CordisXSessionSummary,
} from '../packages/cli/src/contracts.js'
import {
  type CordisXPlatformAdapter,
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
  type PermissionPolicyStore,
  type PermissionPrompt,
  ProjectionPlatformAdapter,
  UnavailablePlatformAdapter,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'

const identity: CordisXPluginIdentity = { source: 'file:///plugins/demo.ts', id: 'demo' }
const models: readonly CordisXModelDescriptor[] = [
  {
    contract: 'cordisx.platform-model/v1',
    schemaVersion: 1,
    hostId: 'desktop',
    ref: { providerId: 'codex', modelId: 'gpt-5.6' },
    label: 'GPT-5.6',
    isDefault: true,
  },
  {
    contract: 'cordisx.platform-model/v1',
    schemaVersion: 1,
    hostId: 'desktop',
    ref: { providerId: 'zcode', modelId: 'z-1' },
    label: 'Z-1',
  },
]
const session: CordisXSessionSummary = {
  contract: 'cordisx.platform-session/v1',
  schemaVersion: 1,
  ref: { providerId: 'codex', remoteSessionId: 'task-1' },
  hostId: 'desktop',
  model: { providerId: 'codex', modelId: 'gpt-5.6' },
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

function prompt(
  decision: 'allow' | 'allow-once' | 'deny' = 'allow',
): PermissionPrompt & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(async () => decision) }
}

function activationDecision(
  plan: CordisXPermissionAuthorizationPlanV1,
  decisions: Readonly<Record<string, CordisXPermissionAuthorizationDecisionV1['decisions'][number]['decision']>>,
): CordisXPermissionAuthorizationDecisionV1 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
    schemaVersion: 1,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    decisions: plan.declarations
      .filter(item => decisions[item.capability] !== undefined)
      .map(item => ({ capability: item.capability, scope: item.scope, decision: decisions[item.capability]! })),
  }
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
    listModels: vi.fn(async input => ({
      ok: true as const,
      value: {
        contract: 'cordisx.platform-model-page/v1' as const,
        schemaVersion: 1 as const,
        providerIds: input.providerIds ?? [],
        models,
      },
    })),
    listTasks: vi.fn(async input => ({
      ok: true as const,
      value: {
        contract: 'cordisx.platform-session-page/v1' as const,
        schemaVersion: 1 as const,
        query: input,
        snapshotId: 'snapshot-1',
        sessions: [session],
      },
    })),
    readTask: vi.fn(async () => ({ ok: true as const, value: { ...session, turns: [] } })),
    createTask: vi.fn(async () => ({ ok: true as const, value: session })),
    controlTask: vi.fn(async input =>
      input.action === 'delete'
        ? { ok: true as const, value: { action: 'delete' as const, session: input.session, deleted: true as const } }
        : { ok: true as const, value: { action: input.action, session } }
    ),
    submitTurn: vi.fn(async input => ({ ok: true as const, value: { session: input.session, turnId: 'turn-1' } })),
    controlTurn: vi.fn(async input => ({ ok: true as const, value: { action: input.action, session: input.session } })),
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
      await expect(ctx.platform.tasks.create({ model: { providerId: 'missing', modelId: 'x' }, cwd: '/workspace' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-provider' } })
      await expect(ctx.platform.tasks.create({ model: { providerId: 'codex', modelId: 'missing' }, cwd: '/workspace' }))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-model' } })
      await expect(ctx.platform.tasks.create({
        model: { providerId: 'codex', modelId: 'gpt-5.6' },
        cwd: '/workspace',
        initialMessage: 'Start here',
      })).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'created',
          session: { ref: { providerId: 'codex', remoteSessionId: 'task-1' } },
          initialTurn: { turnId: 'turn-1' },
        },
      })
      expect(adapter.createTask).toHaveBeenCalledTimes(1)
      expect(adapter.submitTurn).toHaveBeenCalledWith({
        session: { providerId: 'codex', remoteSessionId: 'task-1' },
        message: 'Start here',
      })
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('retains the created session when the initial turn fails and never performs cleanup control', async () => {
    const adapter = fakeAdapter({ submitTurn: vi.fn(async () => resultError('adapter-failure')) })
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt())
    broker.register(identity, manifest(identity.id, [declaration('tasks.create')]))
    broker.setPolicy(identity, 'tasks.create', 'allow')
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      const result = await ctx.platform.tasks.create({
        model: { providerId: 'codex', modelId: 'gpt-5.6' },
        cwd: '/workspace',
        initialMessage: 'Start here',
      })
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'created-initial-turn-failed',
          session: { ref: { providerId: 'codex', remoteSessionId: 'task-1' } },
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
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      ask,
      () => new Date('2026-08-23T08:00:00.000Z'),
    )
    broker.register(
      identity,
      manifest(identity.id, [
        declaration('models.read', { required: true, scope: { providers: ['codex'] } }),
        declaration('turns.submit', {
          scope: { sessions: [{ providerId: 'codex', remoteSessionId: 'task-1' }], cwdRoots: ['/other'] },
        }),
      ]),
    )
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      await expect(ctx.platform.models.list({ providerIds: ['codex'] }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } })
      expect(ask.request).toHaveBeenCalledTimes(1)

      broker.setPolicy(identity, 'models.read', 'allow')
      await expect(ctx.platform.models.list({ providerIds: ['codex'] }))
        .resolves.toMatchObject({ ok: true, value: { models: [{ ref: { providerId: 'codex' } }] } })

      broker.setPolicy(identity, 'models.read', 'deny')
      expect(broker.requiredDenied(identity)).toEqual(['models.read'])
      broker.setPolicy(identity, 'models.read', 'allow')
      broker.setPolicy(identity, 'turns.submit', 'deny')
      expect(broker.requiredDenied(identity)).toEqual([])

      broker.setPolicy(identity, 'turns.submit', 'allow')
      await expect(ctx.platform.turns.submit({
        session: { providerId: 'codex', remoteSessionId: 'task-2' },
        message: 'outside scope',
      }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
      await expect(ctx.platform.turns.submit({
        session: { providerId: 'zcode', remoteSessionId: 'task-1' },
        message: 'same local id, other provider',
      }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
      await expect(ctx.platform.turns.submit({
        session: { providerId: 'codex', remoteSessionId: 'task-1' },
        message: 'outside cwd scope',
      }))
        .resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
      expect(adapter.submitTurn).not.toHaveBeenCalled()
      expect(broker.snapshots().find(item => item.capability === 'turns.submit')).toMatchObject({
        denialCount: 3,
        lastRequested: { session: { providerId: 'codex', remoteSessionId: 'task-1' } },
      })
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('binds call identity to the Cordis context and ignores spoof-like arguments', async () => {
    const other: CordisXPluginIdentity = { source: 'file:///plugins/other.ts', id: 'other' }
    const adapter = fakeAdapter()
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt())
    broker.register(
      identity,
      manifest(identity.id, [declaration('turns.submit', {
        scope: { sessions: [{ providerId: 'codex', remoteSessionId: 'task-1' }] },
      })]),
    )
    broker.register(
      other,
      manifest(other.id, [declaration('turns.submit', {
        scope: { sessions: [{ providerId: 'codex', remoteSessionId: 'other-task' }] },
      })]),
    )
    broker.setPolicy(identity, 'turns.submit', 'allow')
    broker.setPolicy(other, 'turns.submit', 'deny')
    const { fiber, ctx } = await platformContext(adapter, broker, identity)
    try {
      const spoofed = {
        session: { providerId: 'codex', remoteSessionId: 'task-1' },
        message: 'hello',
        pluginId: 'other',
        source: other.source,
      }
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
    expect(broker.authorizationPlan(identity).declarations[0]?.decisionRequired).toBe(false)
    broker.register(
      identity,
      manifest(identity.id, [declaration('models.read', { scope: { providers: ['codex', 'zcode'] } })]),
    )
    expect(broker.policy(identity, 'models.read')).toBe('ask')
    expect(broker.authorizationPlan(identity).declarations[0]?.decisionRequired).toBe(true)
    const adapter = fakeAdapter()
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      await expect(ctx.platform.models.list({ providerIds: ['zcode'] })).resolves.toMatchObject({ ok: true })
      expect(ask.request).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('keeps authority stable across required/reason metadata changes', async () => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt())
    broker.register(
      identity,
      manifest(identity.id, [declaration('models.read', {
        required: false,
        reason: { key: 'permission.models', fallback: 'Read models' },
        scope: { providers: ['codex'] },
      })]),
    )
    await broker.setPolicy(identity, 'models.read', 'allow')
    broker.register(
      identity,
      manifest(identity.id, [declaration('models.read', {
        required: true,
        reason: { key: 'permission.models.updated', fallback: 'Updated explanation' },
        scope: { providers: ['codex'] },
      })]),
    )
    expect(broker.policy(identity, 'models.read')).toBe('allow')
    await broker.setPolicy(identity, 'models.read', 'ask')
    expect(broker.authorizationPlan(identity).declarations[0]).toMatchObject({ policy: 'ask', decisionRequired: false })
  })

  it('requires a new decision when the launcher-bound source identity changes', async () => {
    const store = new MemoryPermissionPolicyStore()
    const original = new PermissionBroker(store, prompt(), () => new Date(), 30_000, 'work', 'generation-1')
    original.register(identity, manifest(identity.id, [declaration('models.read')]))
    await original.setPolicy(identity, 'models.read', 'allow')
    const replacement = { source: 'file:///plugins/reinstalled-demo.ts', id: identity.id }
    const next = new PermissionBroker(store, prompt(), () => new Date(), 30_000, 'work', 'generation-2')
    next.register(replacement, manifest(replacement.id, [declaration('models.read')]))
    expect(next.policy(replacement, 'models.read')).toBe('ask')
    expect(next.authorizationPlan(replacement).declarations[0]?.decisionRequired).toBe(true)
  })

  it('allows only the current call without persisting allow-once', async () => {
    const store = new MemoryPermissionPolicyStore()
    const write = vi.spyOn(store, 'write')
    const ask: PermissionPrompt = {
      request: vi.fn()
        .mockResolvedValueOnce('allow-once')
        .mockResolvedValueOnce('deny'),
    }
    const broker = new PermissionBroker(store, ask)
    broker.register(identity, manifest(identity.id, [declaration('models.read')]))
    const adapter = fakeAdapter()
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      await expect(ctx.platform.models.list({})).resolves.toMatchObject({ ok: true })
      await expect(ctx.platform.models.list({})).resolves.toMatchObject({
        ok: false,
        error: { code: 'permission-denied' },
      })
      expect(write).not.toHaveBeenCalled()
      expect(broker.policy(identity, 'models.read')).toBe('ask')
      expect(ask.request).toHaveBeenCalledTimes(2)
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('persists always-allow before dispatch and reuses it without prompting', async () => {
    let releaseWrite: (() => void) | undefined
    const store = new MemoryPermissionPolicyStore()
    vi.spyOn(store, 'write').mockImplementation(async (records) => {
      await new Promise<void>(resolve => {
        releaseWrite = resolve
      })
      store.records = records
    })
    const ask = prompt('allow')
    const broker = new PermissionBroker(store, ask)
    broker.register(identity, manifest(identity.id, [declaration('models.read')]))
    const adapter = fakeAdapter()
    const { fiber, ctx } = await platformContext(adapter, broker)
    try {
      const pending = ctx.platform.models.list({})
      await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'))
      expect(adapter.listModels).not.toHaveBeenCalled()
      releaseWrite?.()
      await expect(pending).resolves.toMatchObject({ ok: true })
      await expect(ctx.platform.models.list({})).resolves.toMatchObject({ ok: true })
      expect(ask.request).toHaveBeenCalledTimes(1)
      expect(broker.policy(identity, 'models.read')).toBe('allow')
    } finally {
      await fiber.dispose()
      broker.dispose()
    }
  })

  it('issues one non-durable activation ticket per declaration and clears it on disable', async () => {
    const store = new MemoryPermissionPolicyStore()
    const write = vi.spyOn(store, 'write')
    const broker = new PermissionBroker(store, prompt('deny'), () => new Date(), 30_000, 'work', 'generation-1')
    broker.register(
      identity,
      manifest(identity.id, [
        declaration('models.read', { required: true }),
        declaration('tasks.catalog.read'),
      ]),
    )
    await broker.setPolicy(identity, 'models.read', 'deny')
    write.mockClear()
    const plan = broker.authorizationPlan(identity)
    const allowOnce = activationDecision(plan, {
      'models.read': 'allow-once',
      'tasks.catalog.read': 'allow-once',
    })
    await broker.authorizeActivation(identity, allowOnce)
    expect(broker.requiredDenied(identity)).toEqual([])
    await expect(broker.authorize(identity, 'models.read', {})).resolves.toMatchObject({ ok: true })
    await expect(broker.authorize(identity, 'models.read', {})).resolves.toMatchObject({ ok: false })
    expect(write).not.toHaveBeenCalled()
    await broker.authorizeActivation(identity, allowOnce)
    broker.clearOnce(identity)
    await expect(broker.authorize(identity, 'tasks.catalog.read', {})).resolves.toMatchObject({ ok: false })
  })

  it('migrates only an exact legacy identity/capability/scope match and retires it after write', async () => {
    const legacy = {
      identityKey: JSON.stringify([identity.source, identity.id]),
      capability: 'models.read' as const,
      fingerprint: JSON.stringify({
        name: 'models.read',
        required: true,
        reason: { key: 'old.reason', fallback: 'Old reason' },
        scope: { providers: ['codex'] },
      }),
      policy: 'allow' as const,
    }
    const written: unknown[] = []
    const retired: unknown[] = []
    const store: PermissionPolicyStore = {
      read: () => [],
      write: async records => {
        written.push(records)
      },
      legacy: () => [legacy, { ...legacy, identityKey: JSON.stringify(['file:///plugins/other.js', identity.id]) }],
      retireLegacy: async record => {
        retired.push(record)
      },
    }
    const broker = new PermissionBroker(store, prompt(), () => new Date(), 30_000, 'work', 'generation-1')
    broker.register(
      identity,
      manifest(identity.id, [declaration('models.read', {
        required: false,
        reason: { key: 'new.reason', fallback: 'New reason' },
        scope: { providers: ['codex'] },
      })]),
    )
    await broker.settled()
    expect(broker.policy(identity, 'models.read')).toBe('allow')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject([{ key: { profileId: 'work', identity: { pluginId: 'demo' } }, policy: 'allow' }])
    expect(retired).toEqual([legacy])
  })

  it('rolls a persistent policy back when Host configuration rejects the write', async () => {
    const store: PermissionPolicyStore = {
      read: () => [],
      write: async () => {
        throw new Error('write failed')
      },
    }
    const broker = new PermissionBroker(store, prompt())
    broker.register(identity, manifest(identity.id, [declaration('models.read')]))
    await expect(broker.setPolicy(identity, 'models.read', 'allow')).rejects.toThrow('write failed')
    expect(broker.policy(identity, 'models.read')).toBe('ask')
  })

  it('persists required allow and optional deny as one atomic activation batch', async () => {
    const store = new MemoryPermissionPolicyStore()
    const write = vi.spyOn(store, 'write')
    const broker = new PermissionBroker(store, prompt(), () => new Date(), 30_000, 'work', 'generation-1')
    broker.register(
      identity,
      manifest(identity.id, [
        declaration('models.read', { required: true }),
        declaration('tasks.catalog.read'),
      ]),
    )
    const plan = broker.authorizationPlan(identity)
    await expect(broker.authorizeActivation(
      identity,
      activationDecision(plan, {
        'models.read': 'allow',
      }),
    )).rejects.toThrow('incomplete')
    await expect(broker.authorizeActivation(identity, {
      ...activationDecision(plan, { 'models.read': 'ask', 'tasks.catalog.read': 'deny' }),
      profileId: 'spoofed',
    })).rejects.toThrow('current plan')
    expect(write).not.toHaveBeenCalled()
    await broker.authorizeActivation(
      identity,
      activationDecision(plan, {
        'models.read': 'allow',
        'tasks.catalog.read': 'deny',
      }),
    )
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith([
      expect.objectContaining({ key: expect.objectContaining({ capability: 'models.read' }), policy: 'allow' }),
      expect.objectContaining({ key: expect.objectContaining({ capability: 'tasks.catalog.read' }), policy: 'deny' }),
    ])
    expect(broker.requiredDenied(identity)).toEqual([])
    expect(broker.policy(identity, 'tasks.catalog.read')).toBe('deny')
  })

  it('normalizes composite session scope and fails closed on naked, malformed, duplicate, or unknown scope', () => {
    const reason = { key: 'permission.turn-submit', fallback: 'Submit turns' }
    const scoped = (scope: unknown) =>
      normalizePluginManifest({
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: identity.id,
        capabilities: [{ name: 'turns.submit', required: false, reason, scope }],
      }, identity.id)

    expect(() => scoped({ taskIds: ['thread-1'] })).toThrow('unknown field taskIds')
    expect(() => scoped({ sessionIds: ['agent-session-1'] })).toThrow('cannot use Agent sessionIds scope')
    expect(() => scoped({ sessions: ['thread-1'] })).toThrow('must be an object')
    expect(() => scoped({ sessions: [{ remoteSessionId: 'thread-1' }] })).toThrow('providerId is invalid')
    expect(() => scoped({ sessions: [{ providerId: 'main', remoteSessionId: 'thread-1', raw: true }] }))
      .toThrow('unknown field raw')
    expect(() =>
      scoped({
        sessions: [
          { providerId: 'main', remoteSessionId: 'thread-1' },
          { providerId: 'main', remoteSessionId: 'thread-1' },
        ],
      })
    ).toThrow('duplicate session references')

    const normalized = scoped({
      sessions: [
        { providerId: 'zcode', remoteSessionId: 'thread-1' },
        { providerId: 'codex', remoteSessionId: 'thread-1' },
      ],
    })
    expect(normalized.capabilities[0]?.scope.sessions).toEqual([
      { providerId: 'codex', remoteSessionId: 'thread-1' },
      { providerId: 'zcode', remoteSessionId: 'thread-1' },
    ])

    expect(() =>
      normalizePluginManifest({
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: identity.id,
        capabilities: [{
          name: 'agent.events.read',
          required: false,
          reason: { key: 'permission.agent-events', fallback: 'Read Agent events' },
          scope: { sessions: [{ providerId: 'main', remoteSessionId: 'thread-1' }] },
        }],
      }, identity.id)
    ).toThrow('cannot use Platform sessions scope')

    expect(
      normalizePluginManifest({
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: identity.id,
        capabilities: [{
          name: 'agent.events.read',
          required: false,
          reason: { key: 'permission.agent-events', fallback: 'Read Agent events' },
          scope: { sessionIds: ['agent-session-1'] },
        }],
      }, identity.id).capabilities[0]?.scope,
    ).toEqual({ sessionIds: ['agent-session-1'] })
  })

  it('offers authoritative read-only projections while refusing writes', async () => {
    const projection = new ProjectionPlatformAdapter({
      getSnapshot: () => ({
        hostId: 'host',
        hostName: 'Projection Host',
        models,
        sessions: [session],
        sessionContents: [{ ...session, turns: [] }],
      }),
    })
    expect(projection.status()).toMatchObject({
      mode: 'read-only',
      supportedCapabilities: ['models.read', 'tasks.catalog.read', 'tasks.content.read'],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    })
    await expect(projection.listModels({ providerIds: ['codex'] })).resolves.toMatchObject({
      ok: true,
      value: { models: [{ ref: { modelId: 'gpt-5.6' } }] },
    })
    await expect(projection.readTask({ session: { providerId: 'codex', remoteSessionId: 'task-1' } }))
      .resolves.toMatchObject({ ok: true, value: { turns: [] } })
    await expect(projection.createTask({ model: { providerId: 'codex', modelId: 'gpt-5.6' }, cwd: '/workspace' }))
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
