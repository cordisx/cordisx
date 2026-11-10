import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { install } from '../packages/cli/src/launcher/cdp-installation.js'
import { uninstall } from '../packages/cli/src/launcher/cdp-installation-support.js'

describe('confirmed owned Host exit cleanup', () => {
  it.each([true, false])('confirmed exit %s preserves the cleanup boundary', async exited => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (typeof address === 'string') throw new Error('fixture did not bind TCP')
    server.on('connection', socket =>
      socket.on('message', data => {
        const request = JSON.parse(String(data))
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
      installed.session.close()
      const cleanup = uninstall(record, undefined, () => exited)
      if (exited) await expect(cleanup).resolves.toBeUndefined()
      else await expect(cleanup).rejects.toThrow('native-interception (session open)')
      expect(interception.dispose).toHaveBeenCalledOnce()
      if (!exited) {
        interception.dispose.mockImplementation(async () => {})
        await expect(uninstall(record)).resolves.toBeUndefined()
        expect(interception.dispose).toHaveBeenCalledTimes(2)
      }

      expect(removeListener).toHaveBeenCalledTimes(exited ? 1 : 2)
    } finally {
      installed.session.close()
      for (const socket of server.clients) socket.terminate()
      server.close()
      await once(server, 'close')
    }
  })
})
