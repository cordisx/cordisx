import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
  issueNativeSessionHostToken,
  NativeAgentSessionBridge,
} from '../packages/cli/src/launcher/native-agent-session-rpc.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import {
  isNativeRequiredTaskSession,
  NativeAgentSessionPersistence,
} from '../packages/cli/src/renderer/native-agent-session-recovery.js'
import type { BrowserOwnerDocumentBridge } from '../packages/cli/src/renderer/owner-documents.js'
import { AgentRouteSessionScopeAuthority } from '../packages/cli/src/renderer/agent-route-session-scope.js'

test('required operation provenance stays in the original native owner record across restart and never restores a lease', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'task-provenance-'))
  const identity = { source: 'file:///task/chatroom.js', pluginId: 'chatroom' }
  const principal = { profileId: 'profile', generation: 'launch', moduleGeneration: 'module', identity }
  const options = {
    secret: 'secret',
    profileId: 'profile',
    generation: 'launch',
    store: new OwnerDocumentStore(home),
    principalAllowed: () => true,
  }
  const envelope = {
    version: 1,
    requestId: '1',
    token: issueOwnerDocumentPrincipalToken(options.secret, principal),
    nativeToken: issueNativeSessionHostToken(options),
  }
  const bridge = new NativeAgentSessionBridge(options)
  const call = (operation: string, input: object) => bridge.handle({ ...envelope, operation, ...input })
  const record = {
    operationId: 'required-operation',
    fingerprint: '{}',
    sessionId: 'session',
    messageId: 'message',
    context: { cwd: home },
    phase: 'intent',
    bindingPolicy: 'required',
  }
  let persistence: NativeAgentSessionPersistence | undefined
  try {
    await call('native-session-task-claim', { operationId: record.operationId, record })
    await expect(
      call('native-session-task-associate', { operationId: record.operationId, sessionId: 'foreign-session' }),
    ).rejects.toThrow('provenance')
    await call('native-session-save-binding', { sessionId: 'session', threadId: 'actual-native-id', completedTurns: 0 })
    await call('native-session-task-associate', { operationId: record.operationId, sessionId: 'session' })
    await call('native-session-save-binding', { sessionId: 'session', threadId: 'actual-native-id', completedTurns: 1 })
    const next = { ...options, generation: 'next-launch', store: new OwnerDocumentStore(home) }
    const nextPrincipal = { ...principal, generation: next.generation, moduleGeneration: 'next-module' }
    const binding = {
      ...identity,
      moduleGeneration: nextPrincipal.moduleGeneration,
      token: issueOwnerDocumentPrincipalToken(next.secret, nextPrincipal),
    }
    const restarted = new NativeAgentSessionBridge(next)
    const nextToken = issueNativeSessionHostToken(next)
    const records = await restarted.handle({
      version: 1,
      requestId: 'restart',
      token: binding.token,
      nativeToken: nextToken,
      operation: 'native-session-list',
    })
    expect(records).toMatchObject([{
      sessionId: 'session',
      requiredTaskOperationId: record.operationId,
      completedTurns: 1,
    }])
    persistence = new NativeAgentSessionPersistence(
      {
        request: async (token: string, input: object) =>
          restarted.handle({ version: 1, requestId: 'load', token, ...input }),
      } as BrowserOwnerDocumentBridge,
      [binding],
      nextToken,
    )
    await persistence.load()
    const owner = { pluginId: `${identity.source}:${identity.pluginId}`, generation: 2 }
    persistence.register(owner, { principal: binding, active: () => true })
    expect(isNativeRequiredTaskSession(owner, 'session')).toBe(true)
    expect(isNativeRequiredTaskSession({ ...owner, pluginId: 'foreign' }, 'session')).toBe(false)
    const scope = new AgentRouteSessionScopeAuthority({
      activeRoute: () => ({ owner, routeId: 'detail', instanceId: 'route', params: { sessionId: 'session' } }),
      routes: () => [{ id: 'detail', path: '/:sessionId', schemaVersion: 2 }],
      decide: async () => {
        throw new Error('Cold task must not request a route grant')
      },
      connectionGeneration: () => 2,
    })
    scope.install(owner, [{
      manifestVersion: 12,
      name: 'approvals.request',
      required: false,
      scope: {
        task: { kind: 'agent-task-command', commandId: 'send' },
        sessionIds: { kind: 'host-route-param', routeId: 'detail', param: 'sessionId' },
      },
    }])
    if (isNativeRequiredTaskSession(owner, 'session')) scope.tasks.markRequired(owner, 'session')
    expect(await scope.authorize(owner, 'approvals.request', 'session')).toBe(false)
  } finally {
    persistence?.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
