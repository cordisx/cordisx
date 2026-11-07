import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type CdpSession, runtimeEvaluationException } from '../launcher/cdp-session.js'
import type { ManagedConsolePreparation } from '../launcher/managed-service-console-broker.js'

const nativeAgent = fileURLToPath(new URL('../../native/managed-console-agent.cjs', import.meta.url))

export interface ManagedConsoleBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface NativeManagedConsoleView {
  readonly closed: Promise<void>
  setBounds(bounds: ManagedConsoleBounds | undefined): void
  close(): void
}

export interface NativeManagedConsoleAdapter {
  open(
    prepared: Extract<ManagedConsolePreparation, { status: 'prepared' }>,
    signal: AbortSignal,
  ): Promise<NativeManagedConsoleView>
  dispose(): Promise<void>
}

export async function installNativeManagedConsoleAdapter(
  inspector: Pick<CdpSession, 'send'>,
  pid: number,
): Promise<NativeManagedConsoleAdapter | undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'cx-console-'))
  const socketPath = join(directory, 'view.sock')
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<ReturnType<typeof connect>>()
  let disposed = false
  const dispose = async () => {
    disposed = true
    for (const socket of sockets) socket.destroy()
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const response = await inspector.send('Runtime.evaluate', {
      expression: `process.mainModule.require(${JSON.stringify(nativeAgent)}).install(${
        JSON.stringify({ pid, socketPath, token })
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, 5_000)
    const value = (response.result as { value?: { ready?: unknown; pid?: unknown } } | undefined)?.value
    if (runtimeEvaluationException(response) || value?.ready !== true || value.pid !== pid) {
      await dispose()
      return
    }
  } catch {
    await dispose()
    return
  }

  return {
    async open(prepared, signal) {
      signal.throwIfAborted()
      if (disposed) throw new Error('Native managed console adapter is retired')
      const socket = connect(socketPath)
      sockets.add(socket)
      socket.setEncoding('utf8')
      const close = () => {
        socket.destroy()
      }
      signal.addEventListener('abort', close, { once: true })
      const closed = new Promise<void>(resolve =>
        socket.once('close', () => {
          sockets.delete(socket)
          signal.removeEventListener('abort', close)
          resolve()
        })
      )
      try {
        await new Promise<void>((resolve, reject) => {
          let input = ''
          const timer = setTimeout(close, 5000)
          const fail = () => reject(new Error('Native managed console mount unavailable'))
          const read = (chunk: string) => {
            input += chunk
            if (input.length > 256) return close()
            if (!input.endsWith('\n')) return
            if (input !== '{"status":"mounted"}\n') return close()
            clearTimeout(timer)
            socket.off('data', read)
            resolve()
          }
          socket.once('close', () => {
            clearTimeout(timer)
            fail()
          })
          socket.on('error', close)
          socket.on('data', read)
          socket.once('connect', () =>
            socket.write(
              JSON.stringify({
                action: 'open',
                token,
                origin: prepared.origin,
                url: prepared.url,
                cookie: prepared.cookie,
              }) + '\n',
            ))
          if (signal.aborted) close()
        })
        signal.throwIfAborted()
      } catch {
        close()
        throw new Error('Native managed console mount unavailable')
      }
      return {
        closed,
        setBounds(bounds) {
          if (!socket.destroyed) {
            socket.write(
              JSON.stringify(bounds === undefined ? { action: 'hide' } : { action: 'bounds', bounds }) + '\n',
            )
          }
        },
        close,
      }
    },
    dispose,
  }
}
