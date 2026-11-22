import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it, vi } from 'vitest'
import { createNativeProviderTransport } from '../packages/cli/assets/launcher/native-provider-transport.mjs'
import { nativeProviderFailure } from '../packages/cli/assets/launcher/native-provider-errors.mjs'
import { harness } from './fixtures/native-intermediary-harness.js'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { acquireProfileLogicalSource } from '../packages/cli/src/launcher/profile-logical-source-lease.js'
import { desktopLogicalNativeRequests } from '../packages/cli/src/launcher/desktop-logical-native.js'
import { bindProfileLogicalFences } from '../packages/cli/src/launcher/profile-logical-fence-projection.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import { startDesktopLogicalContinuation } from '../packages/cli/src/launcher/desktop-logical-continuation.js'
import { DesktopLogicalTurnAuthority } from '../packages/cli/src/launcher/desktop-logical-turn-authority.js'
import { createDesktopLogicalComposition } from '../packages/cli/src/launcher/desktop-logical-composition.js'
import { abandonDesktopLogicalContinuation } from '../packages/cli/src/launcher/desktop-logical-abandon.js'
import { LogicalContinuationControl } from '../packages/cli/src/launcher/logical-continuation-control.js'

it('keeps native provider identity per connection, preserves history ids and namespaces approval replies', async () => {
  const args = [path.resolve('tests/fixtures/native-provider-process.mjs'), 'app-server']
  const primary = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(primary, 'close')
  const diagnostics: unknown[] = []
  const uncertain: unknown[] = []
  const transport = createNativeProviderTransport(primary, {
    executable: process.execPath,
    args,
    env: process.env,
    diagnostic: (event: unknown) => diagnostics.push(event),
    uncertain: (id: unknown) => uncertain.push(id),
  })
  const lines = createInterface({ input: transport.stdout })
  const replies: any[] = []
  const waiting: ((value: any) => void)[] = []
  lines.on('line', line => {
    const reply = JSON.parse(line)
    const receive = waiting.shift()
    if (receive) receive(reply)
    else replies.push(reply)
  })
  const read = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve))
  const send = (message: unknown) => transport.stdin.write(JSON.stringify(message) + '\n')
  const approvalIds: string[] = []
  try {
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect((await read()).id).toBe('init')
    for (const provider of ['provider-a', 'provider.b']) {
      send({
        id: `start-${provider}`,
        method: 'thread/start',
        params: {
          modelProvider: provider,
          config: {
            model_provider: provider,
            [`model_providers.${provider}`]: {
              wire_api: 'responses',
              base_url: 'http://127.0.0.1:1234/v1',
              experimental_bearer_token: 'test-private-token',
            },
          },
        },
      })
      const start = await read()
      expect(start.result.modelProvider).toBe(provider)
      expect(start.result.argvHasSecret).toBe(false)
      const threadId = start.result.thread.id
      send({ id: `turn-${provider}`, method: 'turn/start', params: { threadId, input: [] } })
      expect((await read()).result.current).toBe(provider)
      send({ id: `approval-${provider}`, method: 'fixture/approval', params: { threadId } })
      const approval = await read()
      expect(approval.method).toBe('item/commandExecution/requestApproval')
      approvalIds.push(approval.id)
      send({ id: approval.id, result: { decision: 'decline' } })
      expect((await read()).result).toEqual({ current: provider, approved: { decision: 'decline' } })
      send({ id: `cancelled-approval-${provider}`, method: 'fixture/approval', params: { threadId } })
      const cancelledApproval = await read()
      send({ id: `cancel-${provider}`, method: 'fixture/cancel-approval', params: { threadId } })
      expect(await read()).toEqual({
        method: 'serverRequest/resolved',
        params: { requestId: cancelledApproval.id, threadId },
      })
      expect((await read()).error.message).toBe('approval cancelled')
      expect((await read()).result).toEqual({ cancelled: true })
      send({ id: cancelledApproval.id, result: { decision: 'accept' } })
      send({ id: `after-cancel-${provider}`, method: 'config/read', params: {} })
      expect((await read()).id).toBe(`after-cancel-${provider}`)
      send({
        id: `resume-${provider}`,
        method: 'thread/resume',
        params: {
          threadId: `saved-${provider}`,
          config: { [`model_providers.${provider}`]: { wire_api: 'responses' } },
        },
      })
      expect((await read()).result.thread.id).toBe(`saved-${provider}`)
    }
    expect(new Set(approvalIds).size).toBe(2)
    // Fork uses the destination connection even though the source belongs to another one.
    // Subsequent native requests must use the new owner without carrying another config override.
    send({ id: 'official-source', method: 'thread/start', params: { modelProvider: 'openai' } })
    const originalThreadId = (await read()).result.thread.id
    let latestThreadId = originalThreadId
    for (const provider of ['provider-a', 'provider.b', 'openai', 'provider.b', 'provider-a', 'openai']) {
      const sourceThreadId = latestThreadId
      send({
        id: `fork-${sourceThreadId}`,
        method: 'thread/fork',
        params: {
          threadId: sourceThreadId,
          modelProvider: provider,
          model: 'test-model',
          ephemeral: false,
          excludeTurns: true,
          deferGoalContinuation: true,
          config: provider === 'openai' ? {} : {
            [`model_providers.${provider}`]: {
              wire_api: 'responses',
              base_url: 'http://127.0.0.1:1234/v1',
              experimental_bearer_token: 'test-private-token',
            },
          },
        },
      })
      const fork = await read()
      expect(fork.error).toBeUndefined()
      expect(fork.result).toMatchObject({ current: provider, modelProvider: provider, sourceThreadId })
      expect(fork.result.argvHasSecret).toBe(false)
      latestThreadId = fork.result.thread.id
      expect(latestThreadId).not.toBe(sourceThreadId)
      send({
        id: `branch-turn-${latestThreadId}`,
        method: 'turn/start',
        params: { threadId: latestThreadId, input: [] },
      })
      expect((await read()).result.current).toBe(provider)
      send({ id: `branch-read-${latestThreadId}`, method: 'thread/read', params: { threadId: latestThreadId } })
      expect((await read()).result.thread).toMatchObject({ id: latestThreadId, modelProvider: provider })
    }
    send({ id: 'unchanged-original', method: 'thread/read', params: { threadId: originalThreadId } })
    expect((await read()).result.thread).toMatchObject({ id: originalThreadId, modelProvider: 'openai' })
    send({ id: 'primary', method: 'config/read', params: {} })
    expect((await read()).result.current).toBe('openai')
    expect(transport.workers().map((worker: { providerId: string }) => worker.providerId))
      .toEqual(['provider-a', 'provider.b'])
    const workerPids = transport.workers().map((worker: { pid: number }) => worker.pid)
    send({ id: 'active-turn', method: 'turn/start', params: { threadId: 'saved-provider-a', input: [] } })
    const activeTurn = (await read()).result.turn
    send({ id: 'active-approval', method: 'fixture/approval', params: { threadId: 'saved-provider-a' } })
    const activeApproval = await read()
    send({ id: 'exit-worker', method: 'fixture/exit', params: { threadId: 'saved-provider-a' } })
    expect((await read()).error.message).toContain('Check thread history')
    expect((await read()).error.message).toContain('Check thread history')
    expect(uncertain).toEqual(expect.arrayContaining(['active-approval', 'exit-worker']))
    expect(await read()).toMatchObject({
      method: 'turn/completed',
      params: { threadId: 'native-provider-a-1', turn: { status: 'failed' } },
    })
    expect(await read()).toMatchObject({ method: 'thread/status/changed', params: { status: { type: 'systemError' } } })
    expect(await read()).toMatchObject({
      method: 'turn/completed',
      params: { threadId: 'saved-provider-a', turn: { id: activeTurn.id, status: 'failed' } },
    })
    expect(await read()).toMatchObject({ method: 'thread/status/changed', params: { status: { type: 'systemError' } } })
    let resolvedApproval = await read()
    while (resolvedApproval.method === 'turn/completed' || resolvedApproval.method === 'thread/status/changed') {
      resolvedApproval = await read()
    }
    expect(resolvedApproval).toEqual({
      method: 'serverRequest/resolved',
      params: { requestId: activeApproval.id, threadId: 'saved-provider-a' },
    })
    expect(transport.workers().map((worker: { providerId: string }) => worker.providerId)).toEqual(['provider.b'])
    expect(diagnostics).toContainEqual(expect.objectContaining({
      phase: 'provider-exited',
      provider: 'provider-a',
      exitCode: 7,
      signal: null,
    }))
    send({ id: 'primary-after-exit', method: 'config/read', params: {} })
    expect((await read()).result.current).toBe('openai')
    transport.close()
    for (const pid of workerPids) {
      for (let attempts = 0; attempts < 100; attempts++) {
        try {
          process.kill(pid, 0)
        } catch {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(() => process.kill(pid, 0)).toThrow()
    }
  } finally {
    transport.close()
    primary.kill('SIGTERM')
    lines.close()
    await closed
  }
})

it('allows the Host to fork through its authenticated native intermediary', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const source = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    const fork = await h.server.nativeRequest('thread/fork', {
      threadId: source.thread.id,
      modelProvider: 'openai',
      model: 'test-model',
    }) as { sourceThreadId: string; thread: { id: string } }
    expect(fork.sourceThreadId).toBe(source.thread.id)
    expect(fork.thread.id).not.toBe(source.thread.id)
  } finally {
    await h.close()
  }
})

it('holds a migration fence across real intermediary writes and preserves ordinary Desktop access afterward', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const source = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    const threadId = source.thread.id
    expect(await h.server.restoreLogicalFences(4, [threadId])).toBe(true)
    h.send({ id: 'persisted-block', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'persisted-block', error: { code: -32000 } })
    expect(await h.server.restoreLogicalFences(3, [])).toBe(false)
    expect(await h.server.restoreLogicalFences(5, [])).toBe(true)
    h.send({ id: 'held', method: 'fixture/hold-write', params: { threadId } })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'fixture/write-accepted' })
    expect(await h.server.acquireLogicalFence(threadId)).toBeUndefined()
    h.send({ id: 'finish', method: 'fixture/finish-write', params: { threadId } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'held', result: { completed: true } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'finish', result: { completed: true } })
    const lease = await h.server.acquireLogicalFence(threadId)
    expect(lease).toBeDefined()
    h.send({ id: 'blocked', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'blocked', error: { code: -32000 } })
    const fork = await h.server.nativeRequest(
      'thread/fork',
      { threadId, modelProvider: 'openai', model: 'test-model' },
      undefined,
      lease,
    )
    expect(fork).toMatchObject({ sourceThreadId: threadId })
    expect(await h.server.releaseLogicalFence(threadId, lease!)).toBe(true)
    h.send({ id: 'allowed', method: 'turn/start', params: { threadId, input: [] } })
    const started = JSON.parse(await h.read())
    expect(started).toMatchObject({ id: 'allowed', result: { current: 'openai' } })
    expect(await h.server.acquireLogicalFence(threadId)).toBeUndefined()
    h.send({ id: 'finish-turn', method: 'fixture/finish-turn', params: { threadId, turnId: started.result.turn.id } })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'turn/completed' })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'finish-turn' })
    const nextLease = await h.server.acquireLogicalFence(threadId)
    expect(nextLease).toBeDefined()
    expect(await h.server.releaseLogicalFence(threadId, nextLease!)).toBe(true)
  } finally {
    await h.close()
  }
})

it('keeps the intermediary fence closed after a provider exits with a write in flight', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const source = await h.server.nativeRequest('thread/start', {
      modelProvider: 'provider-b',
      config: { 'model_providers.provider-b': { wire_api: 'responses' } },
    }) as { thread: { id: string } }
    h.send({ id: 'exit', method: 'fixture/exit', params: { threadId: source.thread.id } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'exit', error: { code: -32000 } })
    expect(await h.server.acquireLogicalFence(source.thread.id)).toBeUndefined()
    expect(h.child.exitCode).toBeNull()
  } finally {
    await h.close()
  }
})

it('reserves a newly created destination before revealing it to the Host', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-logical-owner-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const source = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    const owner = profileLogicalConversationOwner(store)
    await bindProfileLogicalFences(owner, h.server)
    const sourceReservation = await acquireProfileLogicalSource(owner, h.server, source.thread.id)
    if (sourceReservation.state !== 'acquired') throw new Error('source unavailable')
    const sourceLease = sourceReservation.lease
    expect(owner.fence.isMigrating(source.thread.id)).toBe(true)
    const sourceRef = { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: source.thread.id }
    const transaction = channelLogicalTransactionStore(store)
    await transaction.mutate(state => {
      state.logicalContinuations!.intents.operation = {
        request: {
          contract: 'cordisx.conversation-continuation-request/v1',
          operationId: 'operation',
          logicalConversationId: 'conversation',
          source: sourceRef,
          expectedRevision: 0,
          target: { providerId: 'openai', model: 'test-model' },
          mode: 'fork',
          historyConsent: 'inherit',
        },
        actor: { principal: 'fixture', scope: 'fixture' },
        evidence: {
          sourceHistoryVersion: 'fixture',
          handoff: 'none',
          sourceConfiguration: {
            providerId: 'openai',
            model: 'test-model',
            cwd: '/workspace',
            serviceTier: null,
            approvalsReviewer: 'user',
            sandbox: { type: 'readOnly' },
            permissionProfile: null,
            execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
          },
        },
        state: 'creating',
      }
    })
    expect(await sourceReservation.release()).toBe(false)
    await expect(h.server.createFencedLogicalDestination(
      'thread/fork',
      { threadId: source.thread.id, modelProvider: 'openai', model: 'test-model' },
      source.thread.id,
      'wrong-lease',
    )).rejects.toThrow()
    const logicalNative = desktopLogicalNativeRequests({
      control: h.server,
      sourceThreadId: source.thread.id,
      sourceLease,
    })
    const created = await logicalNative.nativeRequest('thread/fork', {
      threadId: source.thread.id,
      modelProvider: 'openai',
      model: 'test-model',
    }) as { thread: { id: string } }
    const destination = created.thread.id
    expect(logicalNative.destination()).toBe(destination)
    await logicalNative.nativeRequest('thread/name/set', { threadId: destination, name: 'fixture' })
    await transaction.mutate(state => {
      const intent = state.logicalContinuations!.intents.operation!
      intent.state = 'unknown'
      intent.destination = { ...sourceRef, sessionId: destination }
    })
    h.send({ id: 'blocked-destination', method: 'turn/start', params: { threadId: destination, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'blocked-destination', error: { code: -32000 } })
    await expect(logicalNative.nativeRequest('thread/fork', { threadId: source.thread.id }))
      .rejects.toThrow('LOGICAL_CREATION_ALREADY_ATTEMPTED')
    await transaction.mutate(state => {
      const intent = state.logicalContinuations!.intents.operation!
      intent.state = 'rejected'
      intent.code = 'USER_ABANDONED_UNKNOWN'
      intent.orphanDestination = intent.destination
      delete intent.destination
    })
    expect(await logicalNative.releaseDestination()).toBe(true)
    expect(await sourceReservation.release()).toBe(true)
    h.send({ id: 'allowed-destination', method: 'turn/start', params: { threadId: destination, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'allowed-destination', result: { current: 'openai' } })
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
    await h.close()
  }
})

it('restores unresolved source fences before admitting Desktop input on startup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-logical-recovery-'))
  const file = path.join(dir, 'state.json')
  const initial = await ChannelConversationStore.open(file)
  const source = { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: 'native-openai-1' }
  await channelLogicalTransactionStore(initial).mutate(state => {
    state.logicalContinuations!.intents.operation = {
      request: {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId: 'operation',
        logicalConversationId: 'conversation',
        source,
        expectedRevision: 0,
        target: { providerId: 'openai', model: 'test-model' },
        mode: 'fresh',
        historyConsent: 'none',
      },
      actor: { principal: 'fixture', scope: 'desktop:codex:fixture' },
      evidence: {
        sourceHistoryVersion: 'fixture',
        handoff: 'none',
        sourceConfiguration: {
          providerId: 'openai',
          model: 'test-model',
          cwd: '/workspace',
          serviceTier: null,
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly' },
          permissionProfile: null,
          execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
        },
      },
      state: 'unknown',
    }
  })
  await initial.close()
  const store = await ChannelConversationStore.open(file)
  const h = await harness(undefined, 'native-provider-process.mjs', { requireLogicalFences: true })
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await expect(h.server.nativeRequest('thread/start', { modelProvider: 'openai' })).rejects.toThrow()
    const owner = profileLogicalConversationOwner(store)
    h.server.bindLogicalFenceOwner(owner)
    expect(JSON.parse(await h.read()).id).toBe('initialize')
    const started = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    expect(started.thread.id).toBe(source.sessionId)
    h.send({ id: 'blocked', method: 'turn/start', params: { threadId: source.sessionId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'blocked', error: { code: -32000 } })
    await expect(abandonDesktopLogicalContinuation(owner, 'codex', 'fixture', {
      sessionId: source.sessionId,
      operationId: 'operation',
    })).rejects.toThrow('INVALID_REQUEST')
    expect(
      await abandonDesktopLogicalContinuation(owner, 'codex', 'fixture', {
        sessionId: source.sessionId,
        operationId: 'operation',
        confirmOrphanPossible: true,
      }),
    ).toEqual({ status: 'ok', orphanPossible: true })
    expect(store.snapshot().logicalContinuations?.intents.operation?.code).toBe('USER_ABANDONED_UNKNOWN')
    h.send({ id: 'allowed', method: 'turn/start', params: { threadId: source.sessionId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'allowed', result: { current: 'openai' } })
  } finally {
    await store.close()
    await h.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('commits a restricted Desktop continuation through the real intermediary and shared store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-logical-intermediary-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  const owner = profileLogicalConversationOwner(store)
  const h = await harness(undefined, 'native-provider-process.mjs', { requireLogicalFences: true })
  try {
    h.server.bindLogicalFenceOwner(owner)
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const source = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    const config = {
      providerId: 'openai',
      model: 'test-model',
      cwd: '/workspace',
      serviceTier: null,
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
      permissionProfile: null,
      execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
    }
    const native = {
      continuationConfiguration: async () => config,
      logicalSourceVersion: async () => 'version',
      supportsLogicalFork: () => true,
      createLogicalDestination: async (
        request: { source: { sessionId: string } },
        _evidence: unknown,
        fence: typeof owner.fence,
        _available: unknown,
        send: (method: 'thread/start', params: {}) => Promise<unknown>,
      ) => {
        const created = await send('thread/start', { modelProvider: 'openai' }) as { thread: { id: string } }
        return {
          state: 'created',
          confirmed: true,
          destination: { ...request.source, sessionId: created.thread.id },
          releaseTarget: fence.beginMigration(created.thread.id)!,
        }
      },
    }
    const sourceRef = { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: source.thread.id }
    const result = await startDesktopLogicalContinuation({
      owner,
      control: h.server,
      native: native as never,
      appId: 'codex',
      profileId: 'fixture',
      preference: { scope: 'conversation', expectedRevision: 0 },
      authority: {
        identity: async () => 'desktop:fixture',
        current: () => true,
        targetAllowed: async () => true,
        linkedHistoryReady: true,
      },
      request: {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId: 'operation',
        logicalConversationId: 'conversation',
        source: sourceRef,
        expectedRevision: 0,
        target: { providerId: 'openai', model: 'test-model' },
        mode: 'linked',
        historyConsent: 'on-demand',
        handoffConsent: 'none',
        historyCategories: ['user-text', 'assistant-text'],
      },
    })
    expect(result).toMatchObject({ state: 'applied', navigationReady: true })
    expect(store.snapshot().logicalContinuations?.relations.operation).toMatchObject({
      mode: 'linked',
      source: sourceRef,
    })
    expect(store.snapshot().logicalContinuations?.preferences?.[JSON.stringify(['conversation', 'conversation'])])
      .toMatchObject({ mode: 'linked' })
  } finally {
    await store.close()
    await h.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('binds a marked Desktop send to its acknowledged native turn without forwarding the ticket', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const source = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    const authority = new DesktopLogicalTurnAuthority(async () => 'desktop:fixture')
    h.server.bindLogicalTurns(authority)
    h.server.bindLogicalHistory(async params => {
      const call = params as { threadId: string; turnId: string }
      return {
        success: await authority.activeIdentity(call.threadId, call.turnId) === 'desktop:fixture',
        contentItems: [{ type: 'inputText', text: 'fixture' }],
      }
    })
    const ticket = (await authority.issue({
      targetId: 'window',
      rendererGeneration: 'generation',
      navigationGeneration: 1,
      composerId: 'composer',
      threadId: source.thread.id,
    }))!
    h.send({
      id: 'logical-send',
      method: 'turn/start',
      params: {
        threadId: source.thread.id,
        input: [],
        fixtureNotify: true,
        config: { 'cordisx.operation_token': ticket },
      },
    })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'turn/started' })
    const response = JSON.parse(await h.read())
    expect(response).toMatchObject({ id: 'logical-send', result: { fixtureConfigPresent: false } })
    const turnId = response.result.turn.id
    h.send({ id: 'read-history', method: 'fixture/logical-history', params: { threadId: source.thread.id, turnId } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'read-history', result: { approved: { success: true } } })
    h.send({ id: 'finish-turn', method: 'fixture/finish-turn', params: { threadId: source.thread.id, turnId } })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'turn/completed' })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'finish-turn' })
    h.send({ id: 'after-turn', method: 'fixture/logical-history', params: { threadId: source.thread.id, turnId } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'after-turn', result: { approved: { success: false } } })
  } finally {
    await h.close()
  }
})

it('requires both provider admission and logical identity for the first continued turn', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const target = await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
      thread: { id: string }
    }
    const authority = new DesktopLogicalTurnAuthority(async () => 'desktop:fixture')
    h.server.bindLogicalTurns(authority)
    const ticket = 'provider-operation-ticket-0123456789'
    expect(
      await authority.issue(
        {
          targetId: 'window',
          rendererGeneration: 'generation',
          navigationGeneration: 1,
          composerId: 'composer',
          threadId: 'source',
        },
        target.thread.id,
        ticket,
      ),
    ).toBe(ticket)
    h.send({
      id: 'attached-send',
      method: 'turn/start',
      params: {
        threadId: target.thread.id,
        input: [],
        fixtureNotify: true,
        config: { 'cordisx.operation_token': ticket },
      },
    })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'turn/started' })
    const response = JSON.parse(await h.read())
    expect(response).toMatchObject({ id: 'attached-send', result: { fixtureConfigPresent: false } })
    expect(await authority.activeIdentity(target.thread.id, response.result.turn.id)).toBe('desktop:fixture')
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ operationToken: ticket }))
    expect(h.authorize).toHaveBeenCalled()
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ operationToken: ticket, succeeded: true }))
  } finally {
    await h.close()
  }
})

it('reads a committed linked history through the composed Desktop turn and intermediary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-history-intermediary-'))
  const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
  const owner = profileLogicalConversationOwner(store)
  const h = await harness(undefined, 'native-provider-process.mjs', { requireLogicalFences: true })
  try {
    h.server.bindLogicalFenceOwner(owner)
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const start = async () =>
      await h.server.nativeRequest('thread/start', { modelProvider: 'openai' }) as {
        thread: { id: string }
      }
    const source = { hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId: (await start()).thread.id }
    const destination = { ...source, sessionId: (await start()).thread.id }
    const engine = new LogicalContinuationControl(channelLogicalTransactionStore(store), {
      state: root => root.logicalContinuations!,
      admitted: () => true,
      bind: () => true,
      preflight: async () => ({
        sourceHistoryVersion: 'version',
        handoff: 'none' as const,
        sourceConfiguration: {
          providerId: 'openai',
          model: 'test-model',
          cwd: '/workspace',
          serviceTier: null,
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly' },
          permissionProfile: null,
          execution: {
            workMode: 'default' as const,
            approval: 'on-request' as const,
            effort: 'low',
            execution: 'read-only' as const,
          },
        },
      }),
      create: async () => ({ state: 'created' as const, destination }),
      confirm: async () => true,
    })
    expect(
      (await engine.start({ principal: 'desktop:fixture', scope: 'desktop:codex:fixture' }, {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId: 'operation',
        logicalConversationId: 'conversation',
        source,
        expectedRevision: 0,
        target: { providerId: 'openai', model: 'test-model' },
        mode: 'linked',
        historyConsent: 'on-demand',
        handoffConsent: 'none',
        historyCategories: ['user-text'],
      })).state,
    ).toBe('applied')
    const logical = createDesktopLogicalComposition({
      control: h.server,
      owner,
      profileId: 'fixture',
      identity: async () => 'desktop:fixture',
    })
    logical.bindNative({
      logicalTurnActive: async () => true,
      logicalSourceVersion: async () => 'version',
      logicalContextTokens: () => [],
      logicalHistoryPage: async () => ({
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'PAPERKITE' }] }],
      }),
    } as never)
    const scope = {
      targetId: 'window',
      rendererGeneration: 'generation',
      navigationGeneration: 1,
      composerId: 'composer',
      threadId: destination.sessionId,
    }
    const ticket = await logical.preparation!.prepare(scope)
    if (ticket.state !== 'issued') throw new Error('ticket unavailable')
    h.send({
      id: 'logical-send',
      method: 'turn/start',
      params: {
        threadId: destination.sessionId,
        input: [],
        fixtureNotify: true,
        config: { 'cordisx.operation_token': ticket.token },
      },
    })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'turn/started' })
    const response = JSON.parse(await h.read())
    h.send({
      id: 'read-history',
      method: 'fixture/logical-history',
      params: { threadId: destination.sessionId, turnId: response.result.turn.id },
    })
    const output = JSON.parse(await h.read())
    expect(output.result.approved.success).toBe(true)
    expect(output.result.approved.contentItems[0].text).toContain('PAPERKITE')
  } finally {
    await store.close()
    await h.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('routes the scoped history tool through the Host and fails closed without a handler', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ id: 'first', method: 'fixture/logical-history', params: { threadId: 'chat' } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'first', result: { approved: { success: false } } })
    const turnEvents: unknown[] = []
    h.server.subscribeContinuationEvents((method, params) => turnEvents.push({ method, params }))
    h.send({ id: 'started', method: 'fixture/start-turn-notification', params: { threadId: 'chat' } })
    expect(JSON.parse(await h.read())).toMatchObject({ method: 'turn/started' })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'started' })
    const handler = vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'fixture' }] }))
    h.server.bindLogicalHistory(handler)
    h.send({ id: 'second', method: 'fixture/logical-history', params: { threadId: 'chat' } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'second', result: { approved: { success: true } } })
    expect(turnEvents).toContainEqual({ method: 'turn/started', params: { threadId: 'chat', turn: { id: 'turn' } } })
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'chat', turnId: 'turn', callId: 'call' }))
    handler.mockRejectedValueOnce(new Error('fixture failure'))
    h.send({ id: 'third', method: 'fixture/logical-history', params: { threadId: 'chat' } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'third', result: { approved: { success: false } } })
    expect(h.child.exitCode).toBeNull()
    const worker = await h.server.nativeRequest('thread/start', {
      modelProvider: 'provider-b',
      config: { 'model_providers.provider-b': { wire_api: 'responses' } },
    }) as { thread: { id: string } }
    h.send({ id: 'worker', method: 'fixture/logical-history', params: { threadId: worker.thread.id } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'worker', result: { approved: { success: true } } })
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: worker.thread.id }))
  } finally {
    await h.close()
  }
})

it('passes model input and history above 64 MiB through the real intermediary without retiring a sibling turn', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const start = () =>
      h.server.nativeRequest('thread/start', {
        modelProvider: 'provider-b',
        config: { 'model_providers.provider-b': { wire_api: 'responses' } },
      }) as Promise<{ thread: { id: string } }>
    const first = await start()
    const sibling = await start()
    const active = await h.server.nativeRequest('turn/start', { threadId: sibling.thread.id, input: [] })
    expect(active).toMatchObject({ current: 'provider-b', turn: { status: 'inProgress' } })
    expect(
      await h.server.nativeRequest('thread/turns/list', {
        threadId: first.thread.id,
        limit: 1,
        itemsView: 'notLoaded',
      }),
    ).toEqual({ data: [{ id: 'fixture-turn', status: 'inProgress', items: [] }], nextCursor: null })
    expect(await h.server.nativeRequest('thread/items/list', { threadId: first.thread.id, limit: 1 }))
      .toEqual({
        data: [{ turnId: 'fixture-turn', item: { type: 'agentMessage', text: 'fixture-history' } }],
        nextCursor: null,
      })
    const bytes = 65 * 1024 * 1024
    const read = await h.server.nativeRequest('thread/read', {
      threadId: first.thread.id,
      includeTurns: true,
      fixtureBytes: bytes,
    }) as { thread: { turns: Array<{ items: Array<{ text: string }> }> } }
    const text = read.thread.turns[0]!.items[0]!.text
    expect(text.length).toBe(bytes)
    h.send({ id: 'large-input', method: 'turn/start', params: { threadId: first.thread.id, input: [{ text }] } })
    expect(JSON.parse(await h.read()).result).toMatchObject({
      current: 'provider-b',
      textLength: bytes,
      textDigest: createHash('sha256').update(text).digest('hex'),
    })
    const next = await h.server.nativeRequest('turn/start', { threadId: sibling.thread.id, input: [] })
    expect(next).toMatchObject({ current: 'provider-b', turn: { status: 'inProgress' } })
    expect(h.child.exitCode).toBeNull()
    expect(h.startupEvents().some(event => event.phase === 'provider-exited')).toBe(false)
  } finally {
    await h.close()
  }
})

it('recognizes only exact structured pre-turn provider failures and preserves policy errors', () => {
  expect(
    nativeProviderFailure({
      error: { code: -32600, data: { type: 'modelProviderNotConfigured', modelProvider: 'provider' } },
    }),
  ).toBe('provider')
  const mismatch = {
    code: -32600,
    data: { type: 'modelProviderMismatch', modelProvider: 'provider', currentModelProvider: 'openai' },
  }
  expect(nativeProviderFailure({ error: mismatch })).toBe('provider')
  expect(nativeProviderFailure({ error: { ...mismatch, code: -32000 } })).toBeUndefined()
  expect(
    nativeProviderFailure({
      error: { code: -32600, data: { type: 'modelProviderPolicyConflict', modelProvider: 'provider' } },
    }),
  ).toBeUndefined()
})
