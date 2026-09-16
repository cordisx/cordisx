import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'

const MAX_BINDINGS = 128
const MAX_SOCKETS = 32
const MAX_REQUEST_BYTES = 1024
const MAX_CREDENTIAL_BYTES = 32_768

interface ServiceIdentity {
  readonly pluginId: string
  readonly serviceId: string
  readonly generation: string
}

interface Binding {
  readonly providerId: string
  readonly identity: ServiceIdentity
  revoked: boolean
}

export interface NativeProviderCredentialCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeout_ms: number
  readonly refresh_interval_ms: number
}

export type NativeProviderCredentialPreparation =
  | { readonly scheme: 'none'; readonly serviceGeneration: string; dispose(): void }
  | {
    readonly scheme: 'bearer'
    readonly serviceGeneration: string
    readonly auth: NativeProviderCredentialCommand
    dispose(): void
  }

export interface NativeProviderCredentialBroker {
  /** Retain the returned lease until its thread/provider binding retires, not just until RPC dispatch. */
  prepare(providerId: string): Promise<NativeProviderCredentialPreparation>
  close(): Promise<void>
}

export interface NativeProviderCredentialBrokerOptions {
  readonly resolve: (
    providerId: string,
  ) => NativeManagedGatewayConnectionSession | Promise<NativeManagedGatewayConnectionSession>
  readonly helperPath?: string
  readonly nodePath?: string
  readonly maxParallelRequests?: number
  readonly resolveTimeoutMs?: number
  readonly commandTimeoutMs?: number
  readonly refreshIntervalMs?: number
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new Error('invalid credential broker limit')
  }
  return result
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) > 0
    && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function identity(session: NativeManagedGatewayConnectionSession): ServiceIdentity {
  const { pluginId, serviceId, generation } = session.value.service
  if (![pluginId, serviceId, generation].every(validIdentity)) throw new Error('invalid service identity')
  return Object.freeze({ pluginId, serviceId, generation })
}

function sameIdentity(left: ServiceIdentity, right: ServiceIdentity): boolean {
  return left.pluginId === right.pluginId && left.serviceId === right.serviceId && left.generation === right.generation
}

function bearer(session: NativeManagedGatewayConnectionSession): string {
  const auth = session.value.endpoint.auth
  if (
    auth.scheme !== 'bearer' || typeof auth.token !== 'string' || auth.token.length === 0
    || Buffer.byteLength(auth.token) > MAX_CREDENTIAL_BYTES || /[\u0000-\u0020\u007f]/u.test(auth.token)
  ) throw new Error('native provider bearer unavailable')
  return auth.token
}

export function nativeProviderCredentialHelperPath(): string {
  return fileURLToPath(new URL('../../assets/launcher/native-provider-credential-helper.mjs', import.meta.url))
}

class Broker implements NativeProviderCredentialBroker {
  private readonly bindings = new Map<string, Binding>()
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Set<Promise<void>>()
  private readonly parallel: number
  private readonly resolveTimeout: number
  private readonly commandTimeout: number
  private readonly refreshInterval: number
  private readonly helper: string
  private readonly node: string
  private server: Server | undefined
  private directory: string | undefined
  private socketPath: string | undefined
  private starting: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private activeRequests = 0
  private closed = false

  constructor(private readonly options: NativeProviderCredentialBrokerOptions) {
    this.parallel = limit(options.maxParallelRequests, 8, MAX_SOCKETS)
    this.resolveTimeout = limit(options.resolveTimeoutMs, 4000, 30_000)
    this.commandTimeout = limit(options.commandTimeoutMs, 5000, 60_000)
    this.refreshInterval = limit(options.refreshIntervalMs, 200, 60_000)
    if (this.resolveTimeout >= this.commandTimeout) throw new Error('invalid credential broker timeout ordering')
    this.helper = options.helperPath ?? nativeProviderCredentialHelperPath()
    this.node = options.nodePath ?? process.execPath
    if (![this.helper, this.node].every(value => path.isAbsolute(value) && !value.includes('\0'))) {
      throw new Error('invalid credential helper command')
    }
  }

  private async resolve(providerId: string): Promise<NativeManagedGatewayConnectionSession> {
    let accepting = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const resolution = Promise.resolve().then(() => this.options.resolve(providerId)).then(session => {
      if (!accepting || this.closed) {
        session.dispose()
        throw new Error('credential resolution retired')
      }
      return session
    })
    try {
      return await Promise.race([
        resolution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('credential resolution timed out')), this.resolveTimeout)
        }),
      ])
    } catch {
      throw new Error('native provider credential unavailable')
    } finally {
      accepting = false
      clearTimeout(timer)
    }
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error('native provider credential broker is closed')
    this.starting ??= (async () => {
      const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'cx-cred-'))
      const socketPath = path.join(directory, 'c.sock')
      const server = createServer(socket => this.accept(socket))
      try {
        await chmod(directory, 0o700)
        if (Buffer.byteLength(socketPath) > 103) throw new Error('credential socket path is too long')
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(socketPath, resolve)
        })
        await chmod(socketPath, 0o600)
        if (this.closed) throw new Error('native provider credential broker is closed')
        this.directory = directory
        this.socketPath = socketPath
        this.server = server
      } catch {
        for (const socket of this.sockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
        throw new Error('native provider credential broker unavailable')
      }
    })()
    await this.starting
  }

  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= MAX_SOCKETS) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    let input = Buffer.alloc(0)
    let handled = false
    const fail = (): void => {
      if (!socket.destroyed) socket.end('{"ok":false}\n')
    }
    socket.setTimeout(this.commandTimeout)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.once('timeout', () => socket.destroy())
    socket.on('data', chunk => {
      if (handled) return
      if (input.byteLength + chunk.byteLength > MAX_REQUEST_BYTES) {
        handled = true
        fail()
        return
      }
      input = Buffer.concat([input, chunk])
      const newline = input.indexOf(10)
      if (newline < 0) return
      handled = true
      if (newline !== input.length - 1) {
        fail()
        return
      }
      const task = this.deliver(input.subarray(0, newline).toString('utf8'), socket)
        .catch(fail).finally(() => this.pending.delete(task))
      this.pending.add(task)
    })
  }

  private async deliver(source: string, socket: Socket): Promise<void> {
    if (this.closed || this.activeRequests >= this.parallel) throw new Error('credential request unavailable')
    const request = JSON.parse(source) as unknown
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid request')
    const record = request as Record<string, unknown>
    const handle = record.operationHandle
    if (Object.keys(record).length !== 1 || typeof handle !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(handle)) {
      throw new Error('invalid request')
    }
    const binding = this.bindings.get(handle)
    if (binding === undefined || binding.revoked) throw new Error('credential binding unavailable')
    this.activeRequests += 1
    let session: NativeManagedGatewayConnectionSession | undefined
    try {
      session = await this.resolve(binding.providerId)
      if (!sameIdentity(binding.identity, identity(session)) || session.value.endpoint.auth.scheme !== 'bearer') {
        binding.revoked = true
        this.bindings.delete(handle)
      }
      if (this.closed || binding.revoked || socket.destroyed) throw new Error('credential binding retired')
      socket.end(`${JSON.stringify({ ok: true, credential: bearer(session) })}\n`)
    } finally {
      try {
        session?.dispose()
      } finally {
        this.activeRequests -= 1
      }
    }
  }

  async prepare(providerId: string): Promise<NativeProviderCredentialPreparation> {
    if (this.closed) throw new Error('native provider credential broker is closed')
    if (!validIdentity(providerId)) throw new Error('invalid native provider identifier')
    let session: NativeManagedGatewayConnectionSession | undefined
    try {
      session = await this.resolve(providerId)
      const service = identity(session)
      if (session.value.endpoint.auth.scheme === 'none') {
        return Object.freeze({ scheme: 'none', serviceGeneration: service.generation, dispose: () => undefined })
      }
      bearer(session)
      await this.start()
      if (this.closed || this.bindings.size >= MAX_BINDINGS || !this.directory || !this.socketPath) {
        throw new Error('credential broker unavailable')
      }
      const handle = randomBytes(32).toString('base64url')
      const binding: Binding = { providerId, identity: service, revoked: false }
      this.bindings.set(handle, binding)
      return Object.freeze({
        scheme: 'bearer',
        serviceGeneration: service.generation,
        auth: Object.freeze({
          command: this.node,
          args: Object.freeze([this.helper, this.socketPath, handle]),
          cwd: this.directory,
          timeout_ms: this.commandTimeout,
          refresh_interval_ms: this.refreshInterval,
        }),
        dispose: () => {
          binding.revoked = true
          this.bindings.delete(handle)
        },
      })
    } catch {
      throw new Error('native provider credential unavailable')
    } finally {
      session?.dispose()
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true
      for (const binding of this.bindings.values()) binding.revoked = true
      this.bindings.clear()
      for (const socket of this.sockets) socket.destroy()
      await this.starting?.catch(() => undefined)
      await Promise.allSettled([...this.pending])
      if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
      if (this.directory) await rm(this.directory, { recursive: true, force: true })
    })()
    return this.closing
  }
}

export function createNativeProviderCredentialBroker(
  options: NativeProviderCredentialBrokerOptions,
): NativeProviderCredentialBroker {
  return new Broker(options)
}
