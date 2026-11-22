import { describe, expect, it, vi } from 'vitest'
import { startHeadlessCodexBackend } from '../packages/cli/src/launcher/headless-codex-backend.js'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import { createHeadlessCodexOperations } from '../packages/cli/src/launcher/headless-codex-operations.js'
import { JsonLineRpcError } from '../packages/cli/src/providers/json-line-rpc.js'

describe('headless Codex backend', () => {
  it('checks the native owner twice and returns only a digest', async () => {
    let userId = 'user'
    const request = vi.fn(async (method: string) => {
      if (method !== 'accountSession/list') throw new Error('unexpected method')
      return {
        activeSessionId: 'session',
        sessions: [{ sessionId: 'session', isActive: true, userId, selectedWorkspaceAccountId: 'workspace' }],
      }
    })
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () => ({ request, subscribeRequests: () => () => {}, close: async () => {} }) as never,
    })
    try {
      expect(await backend.nativeOwnerIdentity()).toMatch(/^desktop:[a-f0-9]{64}$/u)
      request.mockImplementationOnce(async () => ({
        activeSessionId: 'session',
        sessions: [{
          sessionId: 'session',
          isActive: true,
          userId: 'user',
          selectedWorkspaceAccountId: 'workspace',
        }],
      }))
      userId = 'other'
      expect(await backend.nativeOwnerIdentity()).toBeUndefined()
    } finally {
      await backend.close()
    }
  })
  it('distinguishes an explicit cold provider refusal from an uncertain resume', async () => {
    let failure: Error = new JsonLineRpcError(
      "thread/resume failed: cannot change this thread's model provider from openrouter to openai on resume",
      -32600,
    )
    const request = vi.fn(async (method: string) => {
      if (method === 'model/list') return { data: [] }
      if (method === 'thread/read') {
        return { thread: { id: 'chat', modelProvider: 'openrouter', status: { type: 'notLoaded' } } }
      }
      if (method === 'thread/resume') throw failure
      throw new Error(`unexpected method ${method}`)
    })
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      environment: {
        CORDISX_HEADLESS_PROVIDER_ID: 'openrouter',
        CORDISX_HEADLESS_MODEL_ID: 'old',
        CORDISX_HEADLESS_EXTRA_PROVIDER: 'openai',
        CORDISX_HEADLESS_EXTRA_MODELS: 'new',
      },
      startServer: async () => ({ request, subscribeRequests: () => () => {}, close: async () => {} }) as never,
    })
    try {
      const selection = { threadId: 'chat', providerId: 'openai', model: 'new' }
      expect(await backend.models('select', selection))
        .toEqual({ status: 'rejected', reason: 'provider-switch-unavailable' })
      failure = new JsonLineRpcError('thread/resume timed out')
      expect(await backend.models('select', selection))
        .toEqual({ status: 'reconciliation-required', reason: 'native-selection-unavailable' })
      failure = new JsonLineRpcError('thread/resume failed: invalid request', -32600)
      expect(await backend.models('select', selection))
        .toEqual({ status: 'reconciliation-required', reason: 'native-selection-unavailable' })
      failure = new JsonLineRpcError(
        "thread/resume failed: cannot change this thread's model provider from openrouter to openai on resume",
        -32603,
      )
      expect(await backend.models('select', selection))
        .toEqual({ status: 'reconciliation-required', reason: 'native-selection-unavailable' })
      failure = new JsonLineRpcError('thread/resume failed: provider mismatch', -32600, {
        type: 'modelProviderMismatch',
        modelProvider: 'openrouter',
        currentModelProvider: 'openai',
      })
      expect(await backend.models('select', selection))
        .toEqual({ status: 'rejected', reason: 'provider-switch-unavailable' })
      failure = new JsonLineRpcError('thread/resume failed: provider mismatch', -32600, {
        type: 'modelProviderMismatch',
        modelProvider: 'another',
        currentModelProvider: 'openai',
      })
      expect(await backend.models('select', selection))
        .toEqual({ status: 'reconciliation-required', reason: 'native-selection-unavailable' })
    } finally {
      await backend.close()
    }
  })
  it('confirms a fresh native settings event without resuming an empty idle thread', async () => {
    let listener: ((method: string, params: unknown) => void) | undefined
    let actual = 'new'
    const request = vi.fn(async (method: string) => {
      if (method === 'model/list') return { data: [{ id: 'new', model: 'new', hidden: false }] }
      if (method === 'thread/read') {
        return { thread: { id: 'empty', modelProvider: 'openai', status: { type: 'idle' } } }
      }
      if (method === 'thread/settings/update') {
        listener?.('thread/settings/updated', {
          threadId: 'empty',
          threadSettings: { modelProvider: 'openai', model: actual },
        })
        return {}
      }
      throw new Error('No rollout exists for an empty session')
    })
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () =>
        ({
          request,
          subscribeRequests: () => () => {},
          subscribeNotifications: value => {
            listener = value
            return () => {}
          },
          close: async () => {},
        }) as never,
    })
    try {
      const selection = { threadId: 'empty', providerId: 'openai', model: 'new' }
      expect(await backend.models('select', selection)).toMatchObject({ status: 'selected' })
      actual = 'other'
      expect(await backend.models('select', selection)).toMatchObject({ status: 'reconciliation-required' })
      expect(request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
    } finally {
      await backend.close()
    }
  })
  it('preserves the explicitly configured headless provider catalog and fences loaded provider switches', async () => {
    let currentProvider = 'aiden'
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'model/list') return { data: [{ id: 'first', model: 'first', hidden: false }] }
      if (method === 'thread/read') {
        return { thread: { id: 'thread-1', modelProvider: currentProvider, status: { type: 'idle' } } }
      }
      if (method === 'thread/settings/update') return {}
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-1' }, modelProvider: currentProvider, model: 'first' }
      }
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`)
    })
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      environment: {
        CORDISX_HEADLESS_PROVIDER_ID: 'aiden',
        CORDISX_HEADLESS_MODEL_ID: 'first',
        CORDISX_HEADLESS_EXTRA_PROVIDER: 'ark',
        CORDISX_HEADLESS_EXTRA_MODELS: 'second,third',
      },
      startServer: async () =>
        ({ generation: 'test', request, subscribeRequests: () => () => {}, close: async () => {} }) as never,
    })
    try {
      expect(await backend.models('list', {})).toMatchObject({
        providers: [
          { providerId: 'aiden', models: [{ id: 'first' }] },
          { providerId: 'ark', models: [{ id: 'second' }, { id: 'third' }] },
        ],
      })
      expect(await backend.models('select', { threadId: 'thread-1', providerId: 'aiden', model: 'first' }))
        .toMatchObject({ status: 'selected' })
      expect(await backend.models('select', { threadId: 'thread-1', providerId: 'ark', model: 'second' }))
        .toEqual({ status: 'rejected', reason: 'provider-switch-unavailable' })
      expect(await backend.models('select', { threadId: 'thread-1', providerId: 'aiden', model: 'unknown' }))
        .toMatchObject({ status: 'rejected', reason: 'selection-outside-catalog' })
      currentProvider = 'ark'
    } finally {
      await backend.close()
    }
  })
  it('uses the existing bridge and forwards native requests and notifications', async () => {
    const calls: string[] = []
    let onRequest: ((method: string, params: unknown, requestId?: string | number) => unknown) | undefined
    let onNotification: ((method: string, params: unknown) => void) | undefined
    const close = vi.fn(async () => {})
    const rpc: CodexAppServerRpc = {
      generation: 'own-process',
      request: async <T>(method: string) => {
        calls.push(method)
        if (method === 'config/read') return { config: { model: 'available' } } as T
        if (method === 'model/list') {
          return { data: [{ id: 'available', model: 'available', hidden: false, isDefault: true }] } as T
        }
        if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T
        if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T
        return {} as T
      },
      subscribeRequests: listener => {
        onRequest = listener
        return () => {
          onRequest = undefined
        }
      },
      subscribeNotifications: listener => {
        onNotification = listener
        return () => {
          onNotification = undefined
        }
      },
      close,
    }
    const start = vi.fn(async () => rpc)
    const notification = vi.fn()
    const approval = vi.fn(() => ({ decision: 'decline' }))
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      environment: { PATH: '/bin' },
      onRequest: approval,
      onNotification: notification,
      startServer: start,
    })
    expect(start.mock.calls[0]?.[0]).toMatchObject({ codexExecutable: '/codex', codexHome: '/login' })
    expect(start.mock.calls[0]?.[1]?.environment).toEqual({ PATH: '/bin', HOME: '/user' })
    expect(start.mock.calls[0]?.[1]?.experimentalApi).toBe(true)
    expect(onRequest?.('approval', { id: 1 }, 'native-id')).toEqual({ decision: 'decline' })
    expect(approval).toHaveBeenCalledWith('approval', { id: 1 }, 'native-id')
    onNotification?.('event', { id: 2 })
    expect(notification).toHaveBeenCalledWith('event', { id: 2 })
    const result = await backend.call('codex', 'start_session', { operationId: 'op-1', cwd: '/tmp', prompt: 'hello' })
    expect(result).toMatchObject({ status: 'started', sessionId: 'thread-1', turnId: 'turn-1' })
    expect(calls).toEqual(['config/read', 'model/list', 'thread/start', 'turn/start'])
    await Promise.all([backend.close(), backend.close()])
    expect(close).toHaveBeenCalledTimes(1)
    expect(onRequest).toBeUndefined()
    expect(onNotification).toBeUndefined()
  })
  it('exposes the native catalog and applies only an explicitly admitted selection', async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'model/list') {
        return { data: [{ id: 'available', model: 'available', hidden: false, isDefault: true }], nextCursor: null }
      }
      if (method === 'thread/read') {
        return { thread: { id: 'thread-1', modelProvider: 'openai', status: { type: 'idle' } } }
      }
      if (method === 'thread/settings/update') return {}
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, modelProvider: 'openai', model: 'available' }
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`)
    })
    const rpc = {
      generation: 'own',
      request,
      subscribeRequests: () => () => {},
      close: async () => {},
    } as unknown as CodexAppServerRpc
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () => rpc,
    })
    expect(await backend.models('list', {})).toMatchObject({
      providers: [{
        providerId: 'openai',
        defaultModelId: 'available',
        models: [{ id: 'available' }],
      }],
    })
    expect(await backend.models('select', { threadId: 'thread-1', providerId: 'other', model: 'available' }))
      .toMatchObject({ status: 'rejected' })
    expect(await backend.models('select', { threadId: 'thread-1', providerId: 'openai', model: 'missing' }))
      .toMatchObject({ status: 'rejected' })
    expect(
      await backend.models(
        'select',
        { threadId: 'thread-1', providerId: 'openai', model: 'available' },
        async () => false,
      ),
    )
      .toMatchObject({ status: 'rejected', reason: 'selection-changed' })
    expect(request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
    expect(await backend.models('select', { threadId: 'thread-1', providerId: 'openai', model: 'available' }))
      .toMatchObject({ status: 'selected' })
    expect(request).toHaveBeenCalledWith('thread/settings/update', { threadId: 'thread-1', model: 'available' })
    expect(request).toHaveBeenCalledWith('thread/resume', { threadId: 'thread-1' })
    let closed = false
    const codex = createHeadlessCodexOperations({ configPath: '/unused', models: backend.models, closed: () => closed })
    expect(await codex('list', {})).toMatchObject({ status: 'ok', providers: [{ providerId: 'openai' }] })
    expect(await codex('select', { providerId: 'openai', model: 'available' }, { 'openai/threadId': 'thread-1' }))
      .toMatchObject({ status: 'selected' })
    expect(await codex('select', { providerId: 'openai', model: 'available' })).toMatchObject({
      reason: 'invalid-selection',
    })
    expect(await codex('create', {})).toMatchObject({ code: 'CODEX_OPERATION_UNAVAILABLE' })
    expect(
      await codex('select', { providerId: 'openai', model: 'available' }, {
        'cordisx/channelContext': 'expired',
        'openai/threadId': 'thread-1',
      }),
    )
      .toMatchObject({ code: 'CHANNEL_CONTEXT_UNAVAILABLE' })
    expect(await codex('model-services:save', {}, { 'cordisx/channelContext': 'expired' }))
      .toMatchObject({ code: 'CHANNEL_CONTEXT_UNAVAILABLE' })
    closed = true
    expect(await codex('list', {})).toMatchObject({ code: 'CODEX_RUNTIME_UNAVAILABLE' })
    await backend.close()
  })
  it('rejects busy targets and reports unconfirmed native selections', async () => {
    let busy = true
    const request = vi.fn(async (method: string) => {
      if (method === 'model/list') {
        return {
          data: [
            { id: 'visible-id', model: 'visible', hidden: false, isDefault: true },
            { id: 'hidden-id', model: 'hidden', hidden: true, isDefault: false },
          ],
        }
      }
      if (method === 'thread/read') {
        return { thread: { id: 'thread-1', modelProvider: 'openai', status: { type: busy ? 'active' : 'idle' } } }
      }
      if (method === 'thread/settings/update') return {}
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, modelProvider: 'openai', model: 'different' }
      throw new Error('unexpected request')
    })
    const rpc = {
      generation: 'own',
      request,
      subscribeRequests: () => () => {},
      close: async () => {},
    } as unknown as CodexAppServerRpc
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () => rpc,
    })
    expect(await backend.models('list', {})).toMatchObject({
      providers: [{
        defaultModelId: 'visible',
        models: [{ id: 'visible' }],
      }],
    })
    const selection = { threadId: 'thread-1', providerId: 'openai', model: 'visible' }
    expect(await backend.models('select', selection)).toMatchObject({ status: 'rejected', reason: 'thread-not-idle' })
    expect(request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
    busy = false
    expect(await backend.models('select', selection)).toMatchObject({
      status: 'reconciliation-required',
      reason: 'native-selection-unconfirmed',
    })
    await backend.close()
  })
  it('recovers a failed system-error thread only after native terminal and readback checks', async () => {
    let status = 'systemError', turn = 'failed', actual = 'new'
    const request = vi.fn(async (method: string) => {
      if (method === 'model/list') return { data: [{ id: 'new', model: 'new', hidden: false }] }
      if (method === 'thread/read') {
        return { thread: { id: 'thread-1', modelProvider: 'openai', status: { type: status } } }
      }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: turn }] }
      if (method === 'thread/settings/update') return {}
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, modelProvider: 'openai', model: actual }
      throw new Error('unexpected request')
    })
    const rpc = {
      generation: 'own',
      request,
      subscribeRequests: () => () => {},
      close: async () => {},
    } as unknown as CodexAppServerRpc
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () => rpc,
    })
    const selection = { threadId: 'thread-1', providerId: 'openai', model: 'new' }
    turn = 'inProgress'
    expect(await backend.models('select', selection)).toMatchObject({ status: 'rejected', reason: 'thread-not-idle' })
    turn = 'failed'
    expect(
      await backend.models('select', selection, async () => {
        status = 'active'
        return true
      }),
    )
      .toMatchObject({ status: 'rejected', reason: 'thread-not-idle' })
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false)
    status = 'systemError'
    actual = 'old'
    expect(await backend.models('select', selection)).toMatchObject({ status: 'reconciliation-required' })
    actual = 'new'
    expect(await backend.models('select', selection)).toMatchObject({ status: 'selected' })
    await backend.close()
  })
  it('resumes a not-loaded thread with the exact selected provider and model', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'model/list') return { data: [{ id: 'new', model: 'new', hidden: false }] }
      if (method === 'thread/read') return { thread: { id: 'thread-1', status: { type: 'notLoaded' } } }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' }, modelProvider: 'openai', model: 'new' }
      throw new Error('unexpected request')
    })
    const rpc = {
      generation: 'own',
      request,
      subscribeRequests: () => () => {},
      close: async () => {},
    } as unknown as CodexAppServerRpc
    const backend = await startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () => rpc,
    })
    expect(await backend.models('select', { threadId: 'thread-1', providerId: 'openai', model: 'new' }))
      .toMatchObject({ status: 'selected' })
    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-1',
      modelProvider: 'openai',
      model: 'new',
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/settings/update')).toBe(false)
    await backend.close()
  })
  it('closes the process if request handling is unavailable', async () => {
    const close = vi.fn(async () => {})
    const rpc: CodexAppServerRpc = { generation: 'own', request: async <T>() => ({} as T), close }
    await expect(startHeadlessCodexBackend({
      codexExecutable: '/codex',
      codexHome: '/login',
      home: '/user',
      onRequest: () => ({}),
      startServer: async () => rpc,
    })).rejects.toThrow('request handling is unavailable')
    expect(close).toHaveBeenCalledOnce()
  })
})
