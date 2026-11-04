import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'

it('installs the owned workspace before a helper that appears earlier in the CDP list', async () => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string') throw new Error('fixture did not bind TCP')
  const connections: string[] = []
  server.on('connection', (connection, request) => {
    connections.push(request.url!)
    connection.on('message', data => {
      const request = JSON.parse(String(data))
      connection.send(JSON.stringify({
        id: request.id,
        result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
          ? { identifier: 'bootstrap' }
          : { result: { value: { ok: true } } },
      }))
    })
  })
  let includeWorkspace = false
  const target = (id: string, document: string) => ({
    id,
    title: 'ChatGPT',
    type: 'page',
    url: `app://-/${document}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/${id}`,
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(
      JSON.stringify([
        target('helper', 'detached-window.html?initialRoute=%2Fdetached-window'),
        ...(includeWorkspace ? [target('workspace', 'index.html')] : []),
      ]),
      { status: 200 },
    )
  )
  const onReady = vi.fn()
  const status: string[] = []
  const abort = new AbortController()
  const watching = watchAndInject({
    port: address.port,
    source: 'void 0',
    signal: abort.signal,
    launcherOwnedNativeTarget: true,
    onReady,
    onStatus: line => status.push(line),
  })
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(onReady).not.toHaveBeenCalled()
    expect(connections).toEqual([])
    includeWorkspace = true
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1), { timeout: 3_000 })
    await vi.waitFor(() => expect(status).toContainEqual(expect.stringContaining('injected target helper')))
    expect(connections).toEqual(['/workspace', '/helper'])
  } finally {
    abort.abort()
    await watching
    fetch.mockRestore()
    server.close()
    await once(server, 'close')
  }
})
