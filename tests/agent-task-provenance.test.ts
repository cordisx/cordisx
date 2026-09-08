import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  issueNativeSessionHostToken,
  NativeAgentSessionBridge,
  nativeSessionStoreScope,
} from '../packages/cli/src/launcher/native-agent-session-rpc.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import {
  isNativeRequiredTaskSession,
  NativeAgentSessionPersistence,
} from '../packages/cli/src/renderer/native-agent-session-recovery.js'
import type { BrowserOwnerDocumentBridge } from '../packages/cli/src/renderer/owner-documents.js'
import { AgentRouteSessionScopeAuthority } from '../packages/cli/src/renderer/agent-route-session-scope.js'

test.each(['atomic', 'legacy-unmarked'] as const)(
  'required provenance survives %s cold restart without restoring a lease',
  async mode => {
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
    const definition = { agentId: 'worker', revision: 'r1' }
    const setup = {
      definition,
      definitions: [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
        contract: 'cordisx.agent-definition/v1',
        schemaVersion: 1,
        identity: definition,
        inherit: {
          promptSections: 'none',
          rules: 'none',
          skills: 'none',
          tools: 'none',
          mcpServers: 'none',
          runtimeDefaults: 'none',
        },
      }],
    }
    const record = {
      operationId: 'required-operation',
      fingerprint: JSON.stringify({ definition }),
      sessionId: 'session',
      messageId: 'message',
      context: { cwd: home },
      phase: 'intent',
      bindingPolicy: 'required',
    }
    let persistence: NativeAgentSessionPersistence | undefined
    try {
      await call('native-session-task-claim', { operationId: record.operationId, record })
      const input = {
        sessionId: 'session',
        threadId: 'actual-native-id',
        completedTurns: 0,
        setup,
        requiredTaskOperationId: record.operationId,
      }
      await expect(call('native-session-save-binding', { ...input, sessionId: 'foreign-session' })).rejects.toThrow(
        'intent',
      )
      const write = options.store.replace.bind(options.store)
      const failBinding = vi.spyOn(options.store, 'replace').mockImplementation(async request => {
        if (request.documentId.startsWith('native-session.')) throw new Error('binding write failed')
        return await write(request)
      })
      await expect(call('native-session-save-binding', input)).rejects.toThrow('binding write failed')
      expect(await call('native-session-load', { sessionId: 'session', setup })).toBeNull()
      expect(await call('native-session-task-load', { operationId: record.operationId })).toMatchObject({
        bindingPolicy: 'required',
      })
      failBinding.mockRestore()
      await call('native-session-save-binding', input)
      // A crash immediately after this first binding needs no second associate call.
      // Later turn checkpoints must preserve the same marker even when it is omitted.
      await call('native-session-save-binding', {
        sessionId: 'session',
        threadId: 'actual-native-id',
        completedTurns: 1,
        setup,
      })
      // Model the exact old crash snapshot: a durable required intent plus an
      // already committed native mapping with no required marker. Cold reads must
      // restrict it without migrating or deleting any stored records.
      const scopeIdentity = nativeSessionStoreScope(principal.profileId, identity)
      if (mode === 'legacy-unmarked') {
        const documents = await options.store.readDocuments(scopeIdentity, 'native-session.')
        const [documentId, snapshot] = Object.entries(documents)[0]!
        const { requiredTaskOperationId: _marker, ...unmarked } = snapshot.value as Record<string, unknown>
        expect(
          await options.store.replace({
            scope: scopeIdentity,
            documentId,
            expectedRevision: snapshot.revision,
            schemaVersion: 1,
            value: unmarked,
          }),
        ).toMatchObject({ status: 'accepted' })
      }
      await call('native-session-save-binding', {
        sessionId: 'ordinary-session',
        threadId: 'ordinary-native-id',
        completedTurns: 0,
        setup,
      })
      const beforeColdRead = await options.store.readDocuments(scopeIdentity, 'native-session.')
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
      }, { sessionId: 'ordinary-session' }])
      expect((records as { requiredTaskOperationId?: string }[])[1]?.requiredTaskOperationId).toBeUndefined()
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
      expect(isNativeRequiredTaskSession(owner, 'ordinary-session')).toBe(false)
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
      expect(await options.store.readDocuments(scopeIdentity, 'native-session.')).toEqual(beforeColdRead)
    } finally {
      persistence?.dispose()
      await rm(home, { recursive: true, force: true })
    }
  },
)
