import { expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createBarrier } from '../packages/cli/native/startup-navigation.cjs'

const request = { pid: 42, generation: 'owned' }
function fixture() {
  const calls = []
  const seedURL = 'data:text/html;charset=utf-8,loading'
  let attached = false
  class Window extends EventEmitter {
    static getAllWindows() {
      return []
    }
    id = 1
    isDestroyed() {
      return false
    }
    webContents = {
      id: 2,
      getURL: () => seedURL,
      isDestroyed: () => false,
      getOSProcessId: () => 3,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true
        },
        detach: () => {
          attached = false
        },
        sendCommand: async () => ({ targetInfo: { targetId: 'primary', type: 'page', url: seedURL } }),
      },
    }
    show() {
      calls.push('show')
    }
    focus() {
      calls.push('focus')
    }
    async loadURL(url, options) {
      calls.push({ url, options })
      return 'native-result'
    }
  }
  const barrier = createBarrier({ BrowserWindow: Window }, { pid: 42, type: 'browser' }, {
    ...request,
    seedURL,
    showSeed: true,
  })
  return { window: new Window(), barrier, calls, seedURL }
}

it('initializes the same webContents with local loading and preserves original navigation arguments/result', async () => {
  const { window, barrier, calls, seedURL } = fixture()
  let settled = false
  const result = window.loadURL('app://-/index.html', { extraHeaders: 'original' }).then(value => {
    settled = true
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(calls[0]).toEqual({ url: seedURL, options: undefined })
  const held = await barrier.identifyTarget(request)
  expect(held.windowId).toBe(1)
  expect(held.webContentsId).toBe(2)
  expect(() =>
    barrier.releaseNavigation(request, { ...held, targetId: 'other', identifier: 'script', sessionId: 'direct' })
  ).toThrow()
  barrier.releaseNavigation(request, { ...held, identifier: 'script', sessionId: 'direct' })
  expect(await result).toBe('native-result')
  expect(calls.at(-1)).toEqual({ url: 'app://-/index.html', options: { extraHeaders: 'original' } })
})

it('duplicate primary loads and closed windows fail without triggering native fallback', async () => {
  const { window, barrier, calls } = fixture()
  let settled = false
  window.loadURL('app://-/index.html').then(() => settled = true, () => settled = true)
  await new Promise(resolve => setImmediate(resolve))
  window.loadURL('app://-/index.html')
  expect(barrier.snapshot(request).phase).toBe('failed')
  expect(calls.filter(value => value.url === 'app://-/index.html')).toHaveLength(0)
  window.emit('closed')
  expect(settled).toBe(false)
  await expect(barrier.identifyTarget(request)).rejects.toThrow()
})
