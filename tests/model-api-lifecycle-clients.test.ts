import { expect, it, vi } from 'vitest'
import { ModelApiLifecycleClients } from '../packages/cli/src/launcher/model-api-lifecycle-clients.js'
import type { ModelApiConnection } from '../packages/cli/src/launcher/model-api-server.js'

function connection() {
  return { baseUrl: 'http://127.0.0.1:1/v1', headers: {}, dispose: vi.fn() }
}

it('keeps affected requests until disposal while allowing unrelated active clients', async () => {
  const clients = new ModelApiLifecycleClients()
  const source = connection()
  const opened = await clients.open(new AbortController().signal, async () => ({
    connection: source,
    pluginId: 'plugin-one',
  }))
  expect(clients.reserveForLifecycle(['plugin-one'])).toBeUndefined()
  const unrelated = clients.reserveForLifecycle(['plugin-two'])!
  expect(unrelated.isCurrent()).toBe(true)
  await expect(clients.open(new AbortController().signal, async () => ({ connection: connection() })))
    .rejects.toThrow('coordinating')
  expect(unrelated.release()).toBe(true)
  opened.dispose()
  opened.dispose()
  expect(source.dispose).toHaveBeenCalledOnce()
  expect(clients.reserveForLifecycle(['plugin-one'])?.release()).toBe(true)
  clients.close()
})

it('fences in-flight resolution and disposes a connection returned after cancellation', async () => {
  const clients = new ModelApiLifecycleClients()
  const abort = new AbortController()
  const source = connection()
  let resolve!: (value: { connection: ModelApiConnection; pluginId: string }) => void
  const opened = clients.open(abort.signal, async () =>
    await new Promise(ready => {
      resolve = ready
    }))
  expect(clients.reserveForLifecycle(['plugin-one'])).toBeUndefined()
  abort.abort()
  resolve({ connection: source, pluginId: 'plugin-one' })
  await expect(opened).rejects.toThrow()
  expect(source.dispose).toHaveBeenCalledOnce()
  expect(clients.reserveForLifecycle(['plugin-one'])?.release()).toBe(true)
  await expect(clients.open(new AbortController().signal, async () => {
    throw new Error('failed')
  }))
    .rejects.toThrow('failed')
  expect(clients.reserveForLifecycle(['plugin-one'])?.release()).toBe(true)
  clients.close()
})

it('closes all tracked connections and refuses admission after a failed reservation', async () => {
  const clients = new ModelApiLifecycleClients()
  const first = connection()
  const second = connection()
  first.dispose.mockImplementation(() => {
    throw new Error('cleanup failed')
  })
  await clients.open(new AbortController().signal, async () => ({ connection: first, pluginId: 'plugin-one' }))
  const opened = await clients.open(new AbortController().signal, async () => ({
    connection: second,
    pluginId: 'plugin-two',
  }))
  const reservation = clients.reserveForLifecycle(['plugin-three'])!
  reservation.fence()
  expect(reservation.release()).toBe(false)
  await expect(clients.open(new AbortController().signal, async () => ({ connection: connection() })))
    .rejects.toThrow('coordinating')
  expect(() => clients.close()).toThrow('cleanup failed')
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(second.dispose).toHaveBeenCalledOnce()
  opened.dispose()
  expect(second.dispose).toHaveBeenCalledOnce()
})
