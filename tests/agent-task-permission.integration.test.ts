import type { PermissionPromptRequest } from '../packages/cli/src/renderer/platform/platform-permission-store.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { ApprovalAgentBinding, ApprovalQuestion } from '@cordisx/protocol/approval/v2'
import type { ApprovalOutcome } from '@cordisx/protocol/sessions/v1'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  normalizeTaskManifest,
} from '../packages/cli/src/agent-task-permission-manifest.js'
import {
  AgentRouteSessionScopeAuthority,
  type AgentRuntimePermissionDeclaration,
} from '../packages/cli/src/renderer/agent-route-session-scope.js'
import { HostAgentTaskApprovalRegistry } from '../packages/cli/src/renderer/agent-task-approvals.js'
import {
  CordisXAgentSessionRuntime,
  type CordisXDriverApprovalRequest,
} from '../packages/cli/src/renderer/agent-session-runtime.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'

const identity = { source: 'file:///chatroom.js', id: 'chatroom' }
const owner = { pluginId: `${identity.source}:${identity.id}`, generation: 1 }
const route = { kind: 'host-route-param' as const, routeId: 'room-session-detail', param: 'sessionId' as const }
const definition: AgentSetup['definitions'][number] = {
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
  contract: 'cordisx.agent-definition/v1',
  schemaVersion: 1,
  identity: { agentId: 'leader', revision: 'r1' },
  inherit: {
    promptSections: 'none',
    rules: 'none',
    skills: 'none',
    tools: 'none',
    mcpServers: 'none',
    runtimeDefaults: 'none',
  },
}
// Exact consumer runtime-manifest.json from plugin-chatroom 80f4b2e834f0d2ee444de2ac7de7e611d21ecefb.
const consumerManifest = JSON.parse(
  readFileSync(new URL('./fixtures/chatroom-task-runtime-manifest.json', import.meta.url), 'utf8'),
)
const manifest = () => normalizeTaskManifest(consumerManifest, identity.id)

async function fixture() {
  let connection = { connectionId: 'native-connection', generation: 1 }
  let permission: 'allow-once' | 'allow' | 'deny' = 'allow-once'
  let humanOutcome: ApprovalOutcome = 'allowed-once'
  let answerWait: Promise<void> | undefined
  let root: ApprovalAgentBinding | undefined
  let live = true
  const durable = new Map<string, { sessionId: string; bindingPolicy: string }>()
  const identities = new Map([[owner.pluginId, identity]])
  const prompt = vi.fn(async (_request: PermissionPromptRequest) => permission)
  const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: prompt })
  const unregisterOwner = broker.register(identity, manifest())
  broker.replaceAgentRuntimeConnection(connection)
  let activeRoute:
    | { owner: typeof owner; routeId: string; instanceId: string; params: { sessionId: string } }
    | undefined
  const scopes = new AgentRouteSessionScopeAuthority({
    activeRoute: () => activeRoute,
    routes: () => [{ id: route.routeId, path: '/room/:roomId/session/:sessionId', schemaVersion: 2 }],
    decide: async plan => {
      const result = await broker.authorizeAgentRuntime({
        identity: identities.get(plan.owner.pluginId)!,
        capability: plan.capability,
        sessionId: plan.scope.sessionIds[0],
        scopeSource: plan.scopeSource,
        connection,
      })
      return { authorized: result.authorized, ...(result.lease === undefined ? {} : { leaseId: result.lease.leaseId }) }
    },
    isLeaseActive: (candidate, leaseId) =>
      broker.isAgentRuntimeLeaseActive(identities.get(candidate.pluginId)!, leaseId),
    connectionGeneration: () => connection.generation,
  })
  const declarations = manifest().capabilities.map(item => ({
    ...item,
    manifestVersion: 12,
  })) as AgentRuntimePermissionDeclaration[]
  scopes.install(owner, declarations)
  scopes.validateInstalledRoutes(owner)
  broker.setAgentTaskScopeValidator(
    (_identity, capability, sessionId, source) => scopes.tasks.validate(owner, capability, sessionId, source),
    async (_identity, capability, sessionId, source) => scopes.tasks.readback(owner, capability, sessionId, source),
  )
  let driverApprove!: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>
  const runtime = new CordisXAgentSessionRuntime({
    driver: {
      create: async () => ({ status: 'accepted' }),
      resume: async () => ({ status: 'accepted' }),
      submit: async () => 'accepted',
      discard: async () => 'accepted',
      cancel: async () => 'accepted',
      onReplacement: () => () => {},
      dispose: () => {},
      onApprovalRequest: callback => {
        driverApprove = callback
        return () => {}
      },
    },
    authorize: scopes.authorize.bind(scopes),
    declares: scopes.declares.bind(scopes),
    mintApprovalAuthorityLease: scopes.mintApprovalAuthorityLease.bind(scopes),
    requiresApprovalAuthorityLease: scopes.requiresApprovalAuthorityLease.bind(scopes),
    approvalAuthorityLeaseActive: scopes.approvalAuthorityLeaseActive.bind(scopes),
    revalidateApprovalAuthorityLease: async (candidate, lease) =>
      lease.contract !== 'cordisx.agent-task-approval-authority-lease/v1'
      || await scopes.tasks.readback(candidate, 'approvals.answer', lease.authority.sessionId, {
        kind: 'host-agent-task-authority',
        lease,
      }),
    releaseApprovalAuthorityLease: scopes.releaseApprovalAuthorityLease.bind(scopes),
    taskPermissions: {
      declares: (candidate, command) =>
        scopes.tasks.declares(candidate, 'approvals.request', command)
        && scopes.tasks.declares(candidate, 'approvals.answer', command),
      bind: (source, requester, current, readback) =>
        scopes.tasks.bind({ ...source, connectionGeneration: connection.generation }, requester, current, readback),
    },
  })
  broker.subscribeAgentRuntimePermissionFences(fence => {
    scopes.revoke(owner.pluginId, fence.code === 'route-replaced' ? 'permission-revoked' : fence.code)
    runtime.fenceOwner(owner.pluginId, fence.code)
  })
  const registry = new HostAgentTaskApprovalRegistry(
    runtime,
    owner,
    () => live,
    id => id === 'send',
    async (_request, record) => {
      const saved = durable.get(record.operationId)
      return saved?.bindingPolicy === 'required' && saved.sessionId === record.sessionId
    },
  )
  const signals: { sessionId: string; signal: AbortSignal | undefined }[] = []
  const installations = new Map<string, () => Promise<void>>()
  const human = vi.fn(async (question: ApprovalQuestion, bindingOrSignal?: unknown, taskSignal?: AbortSignal) => {
    signals.push({
      sessionId: question.requester.sessionId,
      signal: taskSignal ?? (bindingOrSignal instanceof AbortSignal ? bindingOrSignal : undefined),
    })
    await answerWait
    return humanOutcome
  })
  const unregister = registry.register({ commandId: 'send' }, {
    resolveRequest: question => {
      root ??= question.requester
      return {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
        contract: 'cordisx.approval-request-routing-result/v1',
        schemaVersion: 1,
        status: 'accepted',
        code: 'routed',
        routingId: question.routingId,
        registration: question.registration,
        requester: question.requester,
        authority: root,
      }
    },
    answerAuthority: human,
  })
  const install = async (sessionId: string) => {
    const result = await runtime.create(owner, {
      sessionId,
      setup: { definition: definition.identity, definitions: [definition] },
    })
    if (result.status !== 'accepted') throw new Error('Agent creation failed')
    durable.set(sessionId, { sessionId, bindingPolicy: 'required' })
    const close = await registry.capture('send')!.install(result.handle.agent, {
      operationId: sessionId,
      text: 'Task',
      definition: definition.identity,
      tool: { commandId: 'send', scope: { roomId: 'room', runId: sessionId } },
    }, {
      operationId: sessionId,
      sessionId,
      fingerprint: '{}',
      messageId: 'message',
      phase: 'approval-installing',
      bindingPolicy: 'required',
      context: { cwd: '/task' },
    })
    installations.set(sessionId, close)
    return result.handle
  }
  const existingLeader = async (foreign = false) => {
    const leaderOwner = foreign ? { pluginId: 'file:///foreign.js:foreign', generation: 1 } : owner
    if (foreign) {
      const foreignIdentity = { source: 'file:///foreign.js', id: 'foreign' }
      identities.set(leaderOwner.pluginId, foreignIdentity)
      broker.register(foreignIdentity, normalizeTaskManifest({ ...consumerManifest, id: 'foreign' }, 'foreign'))
      scopes.install(leaderOwner, declarations)
    }
    const acquired = await runtime.create(leaderOwner, {
      sessionId: foreign ? 'foreign-leader' : 'existing-leader',
      setup: { definition: definition.identity, definitions: [definition] },
    })
    if (acquired.status !== 'accepted') throw new Error('Existing Leader creation failed')
    await runtime.registerAuthorityAnswerer(leaderOwner, {
      agent: acquired.handle.agent,
      definition: definition.identity,
    }, human)
    root = {
      agentId: acquired.sessionId,
      sessionId: acquired.sessionId,
      agentGeneration: acquired.handle.agent.generation,
      definition: definition.identity,
    }
    return acquired.handle
  }
  const activateRoute = (sessionId: string) => {
    activeRoute = { owner, routeId: route.routeId, instanceId: 'real-route', params: { sessionId } }
    broker.replaceAgentRuntimeRouteScope({
      kind: 'host-route',
      active: true,
      owner: { source: identity.source, pluginId: identity.id },
      routeId: route.routeId,
      routeInstanceId: 'real-route',
      path: '/room/:roomId/session/:sessionId',
      params: { sessionId },
    })
  }
  return {
    broker,
    connection: () => connection,
    scopes,
    runtime,
    human,
    signals,
    closeInstallation: async (sessionId: string) => await installations.get(sessionId)?.(),
    prompt,
    install,
    unregister,
    activateRoute,
    existingLeader,
    durable,
    staleAuthority: () => {
      if (root !== undefined) root = { ...root, agentGeneration: root.agentGeneration + 1 }
    },
    approve: (sessionId: string) =>
      driverApprove({ sessionId, toolName: 'codex.commandExecution', reason: 'Run requested command' }),
    persistPermission: () => {
      permission = 'allow'
    },
    deny: () => {
      permission = 'deny'
    },
    reject: () => {
      humanOutcome = 'rejected'
    },
    waitAnswer: (promise: Promise<void>) => {
      answerWait = promise
    },
    changeManifestScope: () => {
      const changed = structuredClone(consumerManifest)
      changed.capabilities.find((item: { name: string }) => item.name === 'approvals.request').scope.sessionIds
        .routeId = 'other-detail'
      broker.register(identity, normalizeTaskManifest(changed, identity.id))
    },
    unregisterOwner,
    revokePermission: async () => {
      // Exercise the existing broker revocation path with a deny record, never seed an allow.
      await broker.seedAgentRuntimePolicies(broker.createDevelopmentAgentRuntimePolicySeedAuthority(), identity, [{
        capability: 'approvals.answer',
        sessionIds: ['root'],
        policy: 'deny-persistent',
      }])
    },
    replaceConnection: () => {
      connection = { ...connection, generation: 2 }
      broker.replaceAgentRuntimeConnection(connection)
    },
    close: async () => {
      live = false
      registry.dispose()
      await runtime.dispose()
    },
  }
}

describe('production task manifest through actual broker and runtime resolver', () => {
  it('routes root human and child to Leader without a current page route; real permission denial prevents answering', async () => {
    const f = await fixture()
    try {
      await f.install('root')
      expect(f.human).not.toHaveBeenCalled()
      expect(await f.approve('root')).toBe('allowed-once')
      await f.install('child')
      f.reject()
      expect(await f.approve('child')).toBe('rejected')
      expect(f.human).toHaveBeenCalledTimes(2)
      expect(f.prompt.mock.calls.length).toBeGreaterThan(0)
      f.deny()
      expect(await f.approve('child')).toBe('unavailable')
      expect(f.human).toHaveBeenCalledTimes(2)
    } finally {
      await f.close()
    }
  })

  it('routes a task to an ordinary existing Leader and rejects stale/foreign authorities', async () => {
    const f = await fixture()
    try {
      await f.existingLeader()
      await f.install('child')
      expect(await f.approve('child')).toBe('allowed-once')
      expect(f.scopes.tasks.hasSource(owner, 'existing-leader')).toBe(false)
      const answerPrompt = f.prompt.mock.calls.map(([request]) => request).find(request =>
        request.declaration.name === 'approvals.answer'
      )
      expect(answerPrompt?.declaration.reason.fallback).toContain('command send')
      expect(answerPrompt?.declaration.reason.fallback).toContain('requester Session child')
      expect(answerPrompt?.declaration.reason.fallback).toContain('authority Session existing-leader')
      f.staleAuthority()
      expect(await f.approve('child')).toBe('unavailable')
      await f.existingLeader(true)
      expect(await f.approve('child')).toBe('unavailable')
      expect(f.human).toHaveBeenCalledOnce()
    } finally {
      await f.close()
    }
  })

  it('keeps ordinary route scope independent, and never falls back after a required task registration closes', async () => {
    const f = await fixture()
    try {
      f.activateRoute('ordinary')
      expect(await f.scopes.authorize(owner, 'approvals.request', 'ordinary')).toBe(true)
      await f.install('root')
      f.activateRoute('root')
      f.unregister()
      expect(await f.scopes.authorize(owner, 'approvals.request', 'root')).toBe(false)
      expect(await f.approve('root')).toBe('unavailable')
      expect(f.human).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })

  it('keeps activation review separate and rejects structurally valid plugin-supplied task provenance', async () => {
    const f = await fixture()
    try {
      expect(f.broker.authorizationPlanV4(identity)?.declarations).toEqual([])
      await f.install('root')
      const before = f.prompt.mock.calls.length
      expect(
        await f.broker.authorizeAgentRuntime({
          identity,
          capability: 'approvals.request',
          sessionId: 'root',
          connection: f.connection(),
          scopeSource: {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-task-permission-source.v1.schema.json',
            contract: 'cordisx.agent-task-permission-source/v1',
            schemaVersion: 1,
            kind: 'host-agent-task',
            owner,
            operationId: 'root',
            commandId: 'send',
            sessionId: 'root',
            definition: definition.identity,
            taskRegistrationId: 'invented',
            connectionGeneration: 1,
          },
        }),
      ).toEqual({ authorized: false })
      expect(f.prompt.mock.calls.length).toBe(before)
      expect(f.human).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })

  it('does not reuse task persistent allow after the registered maximum scope changes', async () => {
    const f = await fixture()
    try {
      await f.install('root')
      f.persistPermission()
      expect(await f.approve('root')).toBe('allowed-once')
      f.changeManifestScope()
      f.deny()
      expect(await f.approve('root')).toBe('unavailable')
      expect(f.human).toHaveBeenCalledOnce()
    } finally {
      await f.close()
    }
  })

  it('does not reuse a persistent ordinary-route allow or old lease for a new task source', async () => {
    const f = await fixture()
    try {
      f.activateRoute('root')
      f.persistPermission()
      expect(await f.scopes.authorize(owner, 'approvals.request', 'root')).toBe(true)
      await f.install('root')
      f.deny()
      expect(await f.approve('root')).toBe('unavailable')
      expect(f.human).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })

  it.each(['missing', 'session', 'policy'] as const)(
    'rejects %s durable task provenance before answering',
    async defect => {
      const f = await fixture()
      try {
        await f.install('root')
        if (defect === 'missing') f.durable.delete('root')
        else {f.durable.set('root', {
            sessionId: defect === 'session' ? 'other' : 'root',
            bindingPolicy: defect === 'policy' ? 'none' : 'required',
          })}
        expect(await f.approve('root')).toBe('unavailable')
        expect(f.human).not.toHaveBeenCalled()
      } finally {
        await f.close()
      }
    },
  )

  it('immediately aborts a routed ordinary Leader callback when the required registration closes', async () => {
    const f = await fixture()
    let release!: () => void
    try {
      await f.existingLeader()
      await f.install('child')
      f.waitAnswer(
        new Promise<void>(resolve => {
          release = resolve
        }),
      )
      let settled: ApprovalOutcome | undefined
      const pending = f.approve('child').then(value => {
        settled = value
        return value
      })
      await vi.waitFor(() => expect(f.human).toHaveBeenCalledOnce())
      f.unregister()
      await vi.waitFor(() => expect(settled).toBeDefined())
      expect(f.signals[0]?.signal?.aborted).toBe(true)
      expect(await pending).not.toBe('allowed-once')
    } finally {
      release?.()
      await f.close()
    }
  })

  it('closes only the selected requester routing while an ordinary Leader and sibling remain live', async () => {
    const f = await fixture()
    let release!: () => void
    try {
      const leader = await f.existingLeader()
      await f.install('child')
      await f.install('sibling')
      f.waitAnswer(
        new Promise<void>(resolve => {
          release = resolve
        }),
      )
      const child = f.approve('child')
      const sibling = f.approve('sibling')
      await vi.waitFor(() => expect(f.human).toHaveBeenCalledTimes(2))
      await f.closeInstallation('child')
      expect(await child).not.toBe('allowed-once')
      expect(f.signals.find(item => item.sessionId === 'child')?.signal?.aborted).toBe(true)
      expect(f.signals.find(item => item.sessionId === 'sibling')?.signal?.aborted).toBe(false)
      expect(await f.runtime.get(owner, leader.agent.id)).toBeDefined()
      release()
      expect(await sibling).toBe('allowed-once')
    } finally {
      release?.()
      await f.close()
    }
  })

  it.each(['connection', 'registration', 'dispose', 'durable', 'owner', 'permission'] as const)(
    'rejects a late human answer after %s closure',
    async mode => {
      const f = await fixture()
      let release!: () => void
      try {
        const handle = await f.install('root')
        f.waitAnswer(
          new Promise<void>(resolve => {
            release = resolve
          }),
        )
        const pending = f.approve('root')
        await vi.waitFor(() => expect(f.human).toHaveBeenCalledOnce())
        if (mode === 'connection') f.replaceConnection()
        else if (mode === 'registration') f.unregister()
        else if (mode === 'durable') f.durable.delete('root')
        else if (mode === 'owner') f.unregisterOwner()
        else if (mode === 'permission') await f.revokePermission()
        else await handle.dispose()
        release()
        expect(await pending).not.toBe('allowed-once')
      } finally {
        release?.()
        await f.close()
      }
    },
  )
})
