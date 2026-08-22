import WebSocket from 'ws'

export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

interface CdpResponse {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

class CdpSession {
  private nextId = 1
  private readonly pending = new Map<number, {
    readonly resolve: (value: Record<string, unknown>) => void
    readonly reject: (error: Error) => void
  }>()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as CdpResponse
      if (message.id === undefined) return
      const callback = this.pending.get(message.id)
      if (callback === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) callback.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      else callback.resolve(message.result ?? {})
    })
    socket.on('close', () => {
      for (const callback of this.pending.values()) callback.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new CdpSession(socket)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        // ws may pass null on success even though its TypeScript callback uses undefined.
        if (error == null) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  close(): void {
    this.socket.close()
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Read the current Electron target table from the loopback debugging endpoint. */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
  const value = await response.json() as unknown
  if (!Array.isArray(value)) throw new Error('CDP target list is not an array')
  return value.filter((item): item is CdpTarget => {
    return item !== null && typeof item === 'object' && typeof (item as CdpTarget).id === 'string'
  })
}

function injectable(target: CdpTarget): boolean {
  return target.type === 'page'
    && typeof target.webSocketDebuggerUrl === 'string'
    && !target.url.startsWith('devtools://')
    && !target.url.includes('initialRoute=%2Favatar-overlay')
}

function targetScore(target: CdpTarget): number {
  const label = `${target.title} ${target.url}`.toLowerCase()
  return label.includes('codex') ? 10 : label.includes('chatgpt') ? 5 : 0
}

/** Select renderer pages, preferring targets visibly associated with Codex. */
export function injectableTargets(targets: readonly CdpTarget[]): CdpTarget[] {
  const pages = targets.filter(injectable).sort((left, right) => targetScore(right) - targetScore(left))
  const matched = pages.filter(target => targetScore(target) > 0)
  return matched.length > 0 ? matched : pages.slice(0, 1)
}

interface InstalledScript {
  readonly target: CdpTarget
  readonly identifier: string
}

async function install(target: CdpTarget, source: string): Promise<InstalledScript> {
  const url = target.webSocketDebuggerUrl
  if (url === undefined) throw new Error(`target ${target.id} has no websocket URL`)
  const session = await CdpSession.connect(url)
  try {
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    const added = await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    const identifier = added.identifier
    if (typeof identifier !== 'string') throw new Error('CDP did not return an injection identifier')
    await session.send('Runtime.evaluate', {
      expression: source,
      allowUnsafeEvalBlockedByCSP: true,
    })
    return { target, identifier }
  } finally {
    session.close()
  }
}

async function uninstall(installed: InstalledScript): Promise<void> {
  const url = installed.target.webSocketDebuggerUrl
  if (url === undefined) return
  const session = await CdpSession.connect(url)
  try {
    await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed.identifier })
    await session.send('Runtime.evaluate', {
      expression: 'void globalThis.__cordisxRuntime?.dispose?.()',
      allowUnsafeEvalBlockedByCSP: true,
    })
  } finally {
    session.close()
  }
}

export interface WatchInjectionOptions {
  readonly port: number
  readonly source: string
  readonly signal: AbortSignal
  readonly onStatus?: (message: string) => void
}

/** Track every current Codex page and keep one removable bootstrap installed per target. */
export async function watchAndInject(options: WatchInjectionOptions): Promise<void> {
  const installed = new Map<string, InstalledScript>()
  try {
    while (!options.signal.aborted) {
      try {
        const targets = injectableTargets(await listTargets(options.port))
        const live = new Set(targets.map(target => target.id))
        for (const id of installed.keys()) if (!live.has(id)) installed.delete(id)
        for (const target of targets) {
          const current = installed.get(target.id)
          if (current?.target.webSocketDebuggerUrl === target.webSocketDebuggerUrl) continue
          if (current !== undefined) {
            await uninstall(current).catch(() => undefined)
            installed.delete(target.id)
          }
          const record = await install(target, options.source)
          installed.set(target.id, record)
          options.onStatus?.(`injected target ${target.id} (${target.title || target.url})`)
        }
      } catch (error) {
        options.onStatus?.(`waiting for Codex CDP on 127.0.0.1:${options.port}: ${String(error)}`)
      }
      await delay(750, options.signal)
    }
  } finally {
    await Promise.allSettled([...installed.values()].map(uninstall))
  }
}
