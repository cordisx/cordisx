import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import { LocalCodexProviderAdapter } from '../packages/cli/src/providers/local-codex-adapter.js'
import type { LocalCodexProviderConfig } from '../packages/cli/src/providers/contracts.js'

describe('Local Codex provider adapter', () => {
  it('routes local Codex through its source provider and converts real delta and approval shapes', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-adapter-'))
    const calls: { method: string; params: unknown }[] = []
    let notification: ((method: string, params: unknown) => void) | undefined
    let serverRequest: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined
    const local: LocalCodexProviderConfig = {
      id: 'codex-local',
      kind: 'local-codex',
      displayName: 'Local Codex',
      sourceProviderId: 'openai',
      codexExecutable: 'codex',
      codexHome,
      enabled: true,
      timeoutMs: 1_000,
    }
    const localRpc: CodexAppServerRpc = {
      generation: 'local-generation',
      async request<Result>(method: string, params: unknown): Promise<Result> {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'local-session', modelProvider: 'openai', cwd: '/workspace', turns: [] } } as Result
        }
        if (method === 'turn/start') return { turn: { id: 'introduction-turn' } } as Result
        if (method === 'turn/interrupt') return {} as Result
        throw new Error(`unexpected method ${method}`)
      },
      subscribeNotifications(listener) {
        notification = listener
        return () => {
          notification = undefined
        }
      },
      subscribeRequests(listener) {
        serverRequest = listener
        return () => {
          serverRequest = undefined
        }
      },
      async close() {},
    }
    const adapter = new LocalCodexProviderAdapter(local, localRpc)
    const events: unknown[] = []
    adapter.subscribeLifecycle(event => events.push(event))
    const created = await adapter.createSession({
      model: { providerId: 'codex-local', modelId: 'gpt-5.6-luna' },
      cwd: '/workspace',
      approvalPolicy: 'on-request',
    })
    expect(created.ok && created.value.ref).toEqual({ providerId: 'codex-local', remoteSessionId: 'local-session' })
    expect(calls[0]?.params).toMatchObject({
      modelProvider: 'openai',
      model: 'gpt-5.6-luna',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      developerInstructions: expect.stringContaining(
        'Host-authenticated member-self-introduction turn with no user input',
      ),
    })
    notification?.('turn/started', { threadId: 'local-session', turn: { id: 'turn-1' } })
    notification?.('item/agentMessage/delta', {
      threadId: 'local-session',
      turnId: 'turn-1',
      itemId: 'assistant-1',
      delta: 'Real ',
    })
    notification?.('item/agentMessage/delta', {
      threadId: 'local-session',
      turnId: 'turn-1',
      itemId: 'assistant-1',
      delta: 'reply',
    })
    notification?.('turn/completed', { threadId: 'local-session', turn: { id: 'turn-1', status: 'completed' } })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'turn.started',
        session: { providerId: 'codex-local', remoteSessionId: 'local-session' },
      }),
      expect.objectContaining({ type: 'turn.completed', output: [{ type: 'text', text: 'Real reply' }] }),
    ]))
    const approvalResponse = Promise.resolve(
      serverRequest?.('item/commandExecution/requestApproval', {
        threadId: 'local-session',
        turnId: 'turn-2',
        itemId: 'command-1',
        approvalId: 'approval-1',
      }),
    )
    await expect(adapter.decideApproval({
      session: { providerId: 'codex-local', remoteSessionId: 'local-session' },
      turnId: 'turn-2',
      approvalId: 'approval-1',
      decision: 'approved',
      operationId: 'approve-1',
      operationDigest: 'digest-1',
    })).resolves.toMatchObject({ ok: true, value: { decision: 'approved' } })
    await expect(approvalResponse).resolves.toEqual({ decision: 'accept' })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.required',
        approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' },
      }),
      expect.objectContaining({
        type: 'approval.resolved',
        approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'approved' },
      }),
    ]))
    await expect(adapter.requestMemberSelfIntroduction({
      session: { providerId: 'codex-local', remoteSessionId: 'local-session' },
      operationId: 'intro-1',
      operationDigest: 'digest-intro',
      participantId: 'agent-1',
      memberId: 'agent-1',
      runId: 'run-1',
    })).resolves.toMatchObject({
      ok: true,
      value: { turnId: 'introduction-turn', messageId: 'cxloop-introduction:intro-1' },
    })
    expect(calls.find(call => call.method === 'turn/start')?.params).toEqual({
      threadId: 'local-session',
      input: [],
      clientUserMessageId: 'intro-1',
    })
    const introductionInput = (calls.find(call => call.method === 'turn/start')?.params as { input?: unknown }).input
    expect(introductionInput).toEqual([])
    expect(calls.find(call => call.method === 'turn/start')?.params).not.toHaveProperty('responsesapiClientMetadata')
    await expect(adapter.cancelMemberSelfIntroduction({
      session: { providerId: 'codex-local', remoteSessionId: 'local-session' },
      turnId: 'introduction-turn',
      operationId: 'cancel-intro-1',
      operationDigest: 'digest-cancel-intro',
    })).resolves.toMatchObject({ ok: true, value: { turnId: 'introduction-turn' } })
    expect(calls.find(call => call.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'local-session',
      turnId: 'introduction-turn',
    })
    expect(adapter.status()).toMatchObject({ external: false, nativeCurrentConnection: false, rawBridgeExposed: false })
    await adapter.close()
  })
})
