import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { install } from '../packages/cli/src/launcher/cdp-installation.js'
import { uninstall } from '../packages/cli/src/launcher/cdp-installation-support.js'

describe('confirmed owned Host exit cleanup', () => {
  it.each([
    { label: 'confirmed Host exit', exited: true, closed: true, targetMissing: false, fails: false, cspRestores: 0 },
    {
      label: 'closed channel on a live Host',
      exited: false,
      closed: true,
      targetMissing: false,
      fails: true,
      cspRestores: 1,
    },
    {
      label: 'unlisted responsive renderer',
      exited: false,
      closed: false,
      targetMissing: true,
      fails: true,
      cspRestores: 1,
    },
    {
      label: 'unlisted disconnected renderer',
      exited: false,
      closed: true,
      targetMissing: true,
      fails: false,
      cspRestores: 0,
    },
  ])('$label preserves the cleanup boundary', async ({ exited, closed, targetMissing, fails, cspRestores }) => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture did not bind TCP')
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data))
        requests.push(request)
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'owned' } }
            : request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'exit-bootstrap' }
            : { result: { value: { ok: true } } },
        }))
      }))
    const installed = await install({
      id: 'owned',
      title: 'Codex',
      type: 'page',
      url: 'https://example.test/',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}`,
    }, 'globalThis.__fixture=true')
    const interception = {
      dispose: vi.fn(async () => {
        throw new Error('CDP connection is closed')
      }),
    }
    const removeListener = vi.fn(installed.removeBindingListener)
    const record = {
      ...installed,
      loopbackModules: true,
      nativeInterception: interception,
      removeBindingListener: removeListener,
    } as typeof installed
    try {
      if (closed) installed.session.close()
      else expect(await installed.session.isResponsive()).toBe(true)
      const cleanup = uninstall(record, undefined, () => exited, targetMissing)
      if (fails) await expect(cleanup).rejects.toThrow('native-interception (session open)')
      else await expect(cleanup).resolves.toBeUndefined()
      expect(interception.dispose).toHaveBeenCalledOnce()
      expect(requests.filter(request => request.method === 'Page.setBypassCSP' && request.params?.enabled === false))
        .toHaveLength(cspRestores)
      if (fails) {
        interception.dispose.mockImplementation(async () => {})
        await expect(uninstall(record)).resolves.toBeUndefined()
        expect(interception.dispose).toHaveBeenCalledTimes(2)
      }

      expect(removeListener).toHaveBeenCalledTimes(fails ? 2 : 1)
    } finally {
      installed.session.close()
      for (const socket of server.clients) socket.terminate()
      server.close()
      await once(server, 'close')
    }
  })
})
