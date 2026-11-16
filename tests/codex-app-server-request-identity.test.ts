import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { startLocalCodexAppServer } from '../packages/cli/src/providers/codex-app-server.js'

describe('local App Server request identity', () => {
  it.each([19, 'native-19'])('retains request %s through the actual private transport subscription', async id => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-request-identity-'))
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) {
        this.signalCode = signal
        this.emit('exit', null, signal)
        return true
      },
    })
    const replies: Record<string, unknown>[] = []
    stdin.on('data', chunk => {
      const message = JSON.parse(String(chunk)) as Record<string, unknown>
      if (message.method === 'initialize') stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`)
      else if (message.id !== undefined) replies.push(message)
    })
    const server = await startLocalCodexAppServer({
      id: 'local',
      kind: 'local-codex',
      displayName: 'Local',
      sourceProviderId: 'openai',
      codexHome: root,
      codexExecutable: '/unused-codex',
      enabled: true,
      timeoutMs: 1_000,
    }, { spawnProcess: (() => child) as unknown as typeof spawn, environment: {} })
    const requests: (string | number | undefined)[] = []
    let resolved: unknown
    const unsubscribe = server.subscribeRequests!((_method, _params, requestId) => {
      requests.push(requestId)
      return { decision: 'decline' }
    })
    const unsubscribeNotifications = server.subscribeNotifications!((method, params) => {
      if (method === 'serverRequest/resolved') resolved = params
    })
    try {
      stdout.write(`${JSON.stringify({ id, method: 'item/fileChange/requestApproval', params: { itemId: 'item' } })}\n`)
      await new Promise(resolve => setImmediate(resolve))
      expect(requests).toEqual([id])
      expect(replies).toEqual([{ id, result: { decision: 'decline' } }])
      stdout.write(`${JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: id } })}\n`)
      expect(resolved).toEqual({ requestId: requests[0] })
      unsubscribe()
      stdout.write(`${JSON.stringify({ id: 'retired', method: 'item/fileChange/requestApproval', params: {} })}\n`)
      await new Promise(resolve => setImmediate(resolve))
      expect(requests).toEqual([id])
      expect(replies.at(-1)).toMatchObject({ id: 'retired', error: { code: -32603 } })
    } finally {
      unsubscribeNotifications()
      await server.close()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
      await rm(root, { recursive: true, force: true })
    }
  })
})
