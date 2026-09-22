import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  requestDockRefresh,
  requestShortcutPresentation,
  startSupervisorControlServer,
} from '../cli/supervisor-control.js'
import { presentation } from './presentation.js'
let cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})
it('strips identity, URL and oversize images at the boundary', () => {
  expect(presentation({ status: 'available', identity: 'private', avatar: 'https://remote/image' })).toEqual({
    status: 'available',
  })
  expect(presentation({ status: 'available', avatar: 'data:image/png;base64,' + 'A'.repeat(65536) })).toEqual({
    status: 'available',
  })
})
it('serves one bounded presentation only to the owning instance token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-pres-'))
  cleanups.push(() => rm(root, { recursive: true }))
  const socket = path.join(root, 'c.sock'),
    token = 'a'.repeat(64),
    avatar = 'data:image/png;base64,' + 'AAAA'.repeat(2500)
  let calls = 0
  const server = await startSupervisorControlServer({
    socketPath: socket,
    token,
    stop: () => {},
    readPresentation: async () => {
      calls++
      return { status: 'available', avatar }
    },
  })
  cleanups.push(() => server.close())
  expect(await requestShortcutPresentation(socket, 'wrong')).toEqual({ status: 'unavailable' })
  expect(calls).toBe(0)
  expect(await requestShortcutPresentation(socket, token)).toEqual({ status: 'available', avatar })
  expect(calls).toBe(1)
})
it('refreshes Dock only for the owning token and passes a record path, never code or image bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-dock-control-'))
  cleanups.push(() => rm(root, { recursive: true }))
  const socket = path.join(root, 'c.sock'), token = 'b'.repeat(64), records: (string | undefined)[] = []
  const server = await startSupervisorControlServer({
    socketPath: socket,
    token,
    stop: () => {},
    refreshDock: async record => {
      records.push(record)
      return true
    },
  })
  cleanups.push(() => server.close())
  expect(await requestDockRefresh(socket, 'wrong', '/private/entry.json')).toBe(false)
  expect(records).toEqual([])
  expect(await requestDockRefresh(socket, token, '/private/entry.json')).toBe(true)
  expect(records).toEqual(['/private/entry.json'])
})

it('allows native icon preparation to exceed the ordinary five-second control deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-dock-slow-'))
  cleanups.push(() => rm(root, { recursive: true }))
  const socket = path.join(root, 'c.sock'), token = 'c'.repeat(64)
  const server = await startSupervisorControlServer({
    socketPath: socket,
    token,
    stop: () => {},
    refreshDock: async () => {
      await new Promise(resolve => setTimeout(resolve, 5_100))
      return true
    },
  })
  cleanups.push(() => server.close())
  expect(await requestDockRefresh(socket, token, '/private/entry.json')).toBe(true)
}, 10_000)

it('cancels background icon preparation immediately when the supervisor closes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-dock-cancel-'))
  cleanups.push(() => rm(root, { recursive: true }))
  const socket = path.join(root, 'c.sock'), token = 'd'.repeat(64)
  let entered!: () => void
  const preparing = new Promise<void>(resolve => {
    entered = resolve
  })
  let aborted = false
  const server = await startSupervisorControlServer({
    socketPath: socket,
    token,
    stop: () => {},
    refreshDock: async (_record, signal) => {
      entered()
      return await new Promise<boolean>(resolve => {
        signal?.addEventListener('abort', () => {
          aborted = true
          resolve(false)
        }, { once: true })
      })
    },
  })
  const pending = requestDockRefresh(socket, token, '/private/entry.json')
  await preparing
  await server.close()
  expect(await pending).toBe(false)
  expect(aborted).toBe(true)
}, 2_000)
