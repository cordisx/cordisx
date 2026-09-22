import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const agentPath = require.resolve('../packages/cli/native/visibility-agent.cjs')
const originalProcessType = Object.getOwnPropertyDescriptor(process, 'type')

afterEach(() => {
  delete require.cache[agentPath]
  if (originalProcessType === undefined) Reflect.deleteProperty(process, 'type')
  else Object.defineProperty(process, 'type', originalProcessType)
})

describe('owned Host visibility agent', () => {
  it('keeps the requested window transparent until the native route paints', async () => {
    Object.defineProperty(process, 'type', { configurable: true, value: 'browser' })
    const windows: FakeWindow[] = []
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>()
    const ipcMain = {
      handle(channel: string, listener: (event: unknown, message: unknown) => unknown) {
        handlers.set(channel, listener)
      },
    }
    const app = new EventEmitter()

    class FakeWindow {
      static getAllWindows() {
        return windows
      }

      static fromWebContents(webContents: FakeWindow['webContents']) {
        return windows.find(window => window.webContents === webContents)
      }

      visible = false
      destroyed = false
      minimized = false
      opacity = 1
      inactiveShows = 0
      activeShows = 0
      paintEvaluations = 0
      readonly webContents = {
        id: 17,
        getURL: () => 'app://-/index.html',
        isDestroyed: () => false,
        executeJavaScript: async (expression: string) => {
          expect(expression).toContain('requestAnimationFrame(() => requestAnimationFrame')
          this.paintEvaluations += 1
          return true
        },
      }

      isDestroyed() {
        return this.destroyed
      }
      isVisible() {
        return this.visible
      }
      isMinimized() {
        return this.minimized
      }
      getOpacity() {
        return this.opacity
      }
      setOpacity(opacity: number) {
        this.opacity = opacity
      }
      show() {
        this.visible = true
        this.activeShows += 1
      }
      showInactive() {
        this.visible = true
        this.inactiveShows += 1
      }
      hide() {
        this.visible = false
      }
      focus() {
        this.visible = true
      }
      restore() {
        this.minimized = false
        this.visible = true
      }
    }

    const window = new FakeWindow()
    windows.push(window)
    const agent = require(agentPath) as {
      install(options: { pid: number }, electron: unknown): { ready: boolean }
      releaseWhenReady(options: {
        pid: number
        statePath: string
        instanceToken: string
      }): Promise<{ armed: boolean }>
    }
    expect(agent.install({ pid: process.pid }, { app, BrowserWindow: FakeWindow, ipcMain }).ready).toBe(true)

    const originalHandler = async () => 'handled'
    ipcMain.handle('codex_desktop:message-from-view', originalHandler)
    window.show()
    expect(window.visible).toBe(true)
    expect(window.opacity).toBe(0)
    expect(window.inactiveShows).toBe(1)
    expect(window.activeShows).toBe(0)

    const token = 'a'.repeat(64)
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-visibility-agent-'))
    const statePath = path.join(root, 'state.json')
    await writeFile(
      statePath,
      JSON.stringify({
        phase: 'ready',
        hostPid: process.pid,
        instanceToken: token,
      }),
    )
    const release = agent.releaseWhenReady({ pid: process.pid, statePath, instanceToken: token })
    await expect(Promise.race([
      release.then(() => 'released'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ])).resolves.toBe('pending')

    await expect(handlers.get('codex_desktop:message-from-view')!(
      { sender: window.webContents },
      { type: 'ready' },
    )).resolves.toBe('handled')
    await expect(release).resolves.toMatchObject({ armed: true })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(window.paintEvaluations).toBe(1)
    expect(window.opacity).toBe(1)
    expect(window.activeShows).toBe(1)
  })
})
