import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { requireStartupGateHelper, startupGateHelper } from '../shortcuts/native.js'

const lightMark = fileURLToPath(new URL('../../assets/brand/cordisx-mark-light.svg', import.meta.url))
const darkMark = fileURLToPath(new URL('../../assets/brand/cordisx-mark-dark.svg', import.meta.url))

type StartupGateEvent = 'visible' | 'host-hidden' | 'ready' | 'retry' | 'dismiss'
type StartupGateAction = 'retry' | 'dismiss'

export interface StartupGate {
  stage(message: string): Promise<void>
  hostLaunched(pid: number, startedAt: string): Promise<void>
  ready(): Promise<void>
  failed(message: string): Promise<StartupGateAction>
  close(): Promise<void>
}

class NativeStartupGate implements StartupGate {
  private readonly pending = new Map<StartupGateEvent, number>()
  private readonly waiters = new Map<
    StartupGateEvent,
    Array<{
      resolve(): void
      reject(error: Error): void
    }>
  >()
  private failure: Error | undefined
  private exited = false
  private actionWaiter: {
    resolve(action: StartupGateAction): void
    reject(error: Error): void
  } | undefined

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      let value: { event?: unknown; error?: unknown }
      try {
        value = JSON.parse(line) as { event?: unknown; error?: unknown }
      } catch {
        return
      }
      if (value.event === 'gate-error') {
        this.reject(new Error(typeof value.error === 'string' ? value.error : 'CordisX startup gate failed'))
        return
      }
      if (value.event === 'retry' || value.event === 'dismiss') {
        this.actionWaiter?.resolve(value.event)
        this.actionWaiter = undefined
        return
      }
      if (!['visible', 'host-hidden', 'ready'].includes(String(value.event))) return
      this.publish(value.event as StartupGateEvent)
    })
    child.stdin.on('error', error => this.reject(error))
    child.once('error', error => this.reject(error))
    child.once('exit', (code, signal) => {
      this.exited = true
      if (this.failure === undefined && code !== 0) {
        this.reject(new Error(`CordisX startup gate exited (${code ?? signal ?? 'unknown'})`))
      } else this.reject(new Error('CordisX startup gate closed before startup completed'))
    })
  }

  private publish(event: StartupGateEvent): void {
    const waiter = this.waiters.get(event)?.shift()
    if (waiter !== undefined) waiter.resolve()
    else this.pending.set(event, (this.pending.get(event) ?? 0) + 1)
  }

  private reject(error: Error): void {
    this.failure ??= error
    this.actionWaiter?.reject(this.failure)
    this.actionWaiter = undefined
    for (const waiters of this.waiters.values()) for (const waiter of waiters.splice(0)) waiter.reject(this.failure)
  }

  private wait(event: StartupGateEvent): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const count = this.pending.get(event) ?? 0
    if (count > 0) {
      this.pending.set(event, count - 1)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(event) ?? []
      waiters.push({ resolve, reject })
      this.waiters.set(event, waiters)
    })
  }

  private send(value: Record<string, unknown>): void {
    if (this.failure !== undefined) throw this.failure
    if (this.exited || !this.child.stdin.writable) throw new Error('CordisX startup gate is unavailable')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  async waitUntilVisible(): Promise<void> {
    await this.wait('visible')
  }

  async stage(message: string): Promise<void> {
    this.send({ event: 'stage', message })
  }

  async hostLaunched(pid: number, startedAt: string): Promise<void> {
    const hidden = this.wait('host-hidden')
    this.send({ event: 'host-launched', pid, startedAt })
    await hidden
  }

  async ready(): Promise<void> {
    const ready = this.wait('ready')
    this.send({ event: 'ready' })
    await ready
  }

  async failed(message: string): Promise<StartupGateAction> {
    if (this.failure !== undefined) throw this.failure
    const action = new Promise<StartupGateAction>((resolve, reject) => {
      this.actionWaiter = { resolve, reject }
    })
    this.send({ event: 'failed', message })
    return await action
  }

  async close(): Promise<void> {
    if (this.exited) return
    try {
      this.send({ event: 'close' })
    } catch {
      this.child.kill()
      return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 1_000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

export async function openNativeStartupGate(): Promise<StartupGate> {
  if (process.platform !== 'darwin') throw new Error('The CordisX startup gate requires macOS')
  await requireStartupGateHelper()
  const gate = new NativeStartupGate(spawn(startupGateHelper, [lightMark, darkMark], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('CordisX startup gate did not become visible')), 5_000)
  })
  try {
    await Promise.race([gate.waitUntilVisible(), timeout])
  } catch (error) {
    await gate.close()
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return gate
}
