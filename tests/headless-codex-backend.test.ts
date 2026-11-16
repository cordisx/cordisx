import { describe, expect, it, vi } from 'vitest'
import { startHeadlessCodexBackend } from '../packages/cli/src/launcher/headless-codex-backend.js'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'

describe('headless Codex backend', () => {
  it('uses the existing bridge and forwards native requests and notifications', async () => {
    const calls: string[] = []
    let onRequest: ((method: string, params: unknown, requestId?: string | number) => unknown) | undefined
    let onNotification: ((method: string, params: unknown) => void) | undefined
    const close = vi.fn(async () => {})
    const rpc: CodexAppServerRpc = {
      generation: 'own-process',
      request: async <T>(method: string) => {
        calls.push(method)
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
    expect(onRequest?.('approval', { id: 1 }, 'native-id')).toEqual({ decision: 'decline' })
    expect(approval).toHaveBeenCalledWith('approval', { id: 1 }, 'native-id')
    onNotification?.('event', { id: 2 })
    expect(notification).toHaveBeenCalledWith('event', { id: 2 })
    const result = await backend.call('codex', 'start_session', { operationId: 'op-1', cwd: '/tmp', prompt: 'hello' })
    expect(result).toMatchObject({ status: 'started', sessionId: 'thread-1', turnId: 'turn-1' })
    expect(calls).toEqual(['thread/start', 'turn/start'])
    await Promise.all([backend.close(), backend.close()])
    expect(close).toHaveBeenCalledTimes(1)
    expect(onRequest).toBeUndefined()
    expect(onNotification).toBeUndefined()
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
