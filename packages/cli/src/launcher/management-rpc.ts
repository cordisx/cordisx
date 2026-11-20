import { managementMailboxPath, requestManagementMailbox, startManagementMailbox } from './management-mailbox.js'
import { readlink } from 'node:fs/promises'
import type { ModelExportRequest } from '../cli/model-export-parse.js'
import type { CliModelExportResult } from './model-catalog/cli-export.js'
import {
  parseTerminalProviderRequest,
  type TerminalProviderRequest,
  type TerminalProviderResult,
} from './terminal-provider.js'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import type {
  PluginManagementCatalogQuery,
  PluginManagementConfigRequest,
  PluginManagementLegacySourceMigration,
  PluginManagementRequest,
  PluginManagementSnapshot,
} from '../management/contracts.js'
import type { PluginManagementService } from '../management/service.js'
import {
  parseRendererConfigOperation,
  type RendererConfigOperation,
  type RendererConfigResult,
} from './renderer-config-management.js'
import { parsePermissionReviewOperation, type PermissionReviewOperation } from './permission-review-management.js'

export const MANAGEMENT_BINDING = '__cordisxPluginManagementRequestV1'
export const MANAGEMENT_RECEIVER = '__cordisxPluginManagementReceiveV1'
export const MAX_MANAGEMENT_REQUEST_BYTES = 256 * 1024
const MAX_MANAGEMENT_RESPONSE_BYTES = 8 * 1024 * 1024

export type PluginManagementRpcOperation =
  | PermissionReviewOperation
  | RendererConfigOperation
  | { readonly kind: 'query' }
  | {
    readonly kind: 'codex'
    readonly operation: string
    readonly input: unknown
    readonly context?: string
    readonly callerThreadId?: string
    readonly callerTurnId?: string
  }
  | { readonly kind: 'model-export'; readonly request: ModelExportRequest }
  | { readonly kind: 'terminal-provider'; readonly request: TerminalProviderRequest }
  | {
    readonly kind: 'channel'
    readonly operation: string
    readonly input: unknown
    readonly context?: string
    readonly callerThreadId?: string
  }
  | { readonly kind: 'refresh-catalog'; readonly sourceUrl?: string }
  | { readonly kind: 'query-catalog'; readonly query?: PluginManagementCatalogQuery }
  | {
    readonly kind: 'plugin-info'
    readonly query: { readonly pluginId: string; readonly sourceUrl?: string; readonly version?: string }
  }
  | { readonly kind: 'plan'; readonly request: PluginManagementRequest }
  | { readonly kind: 'execute'; readonly request: PluginManagementRequest; readonly expectedRevision?: number }
  | { readonly kind: 'migrate-legacy-sources'; readonly input: PluginManagementLegacySourceMigration }

export interface PluginManagementRpcRequest {
  readonly version: 1
  readonly requestId: string
  readonly token: string
  readonly profileId: string
  readonly operation: PluginManagementRpcOperation
}

export interface PluginManagementBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly service: PluginManagementService
}

export interface PluginManagementRpcEndpoint {
  readonly schemaVersion: 1
  readonly appId: string
  readonly profileId: string
  readonly configPath: string
  readonly pid: number
  readonly processStartedAt: string
  readonly token: string
  readonly generation: string
  readonly mailboxId?: string
  readonly pidNamespace?: string
}

export interface PluginManagementRpcPaths {
  readonly directory: string
  readonly socketDirectory: string
  readonly socket: string
  readonly state: string
}

export interface PluginManagementRpcServer {
  close(): Promise<void>
}

export function managementMailboxRoot(paths: PluginManagementRpcPaths): string {
  return path.join(paths.socketDirectory, `${path.basename(paths.socket, '.sock')}-mailbox`)
}

export function pluginManagementRpcPaths(homeDir: string, appId: string, profileId: string): PluginManagementRpcPaths {
  const directory = path.join(homeDir, 'run', appId, profileId)
  const scope = createHash('sha256').update(`${path.resolve(homeDir)}\0${appId}\0${profileId}`).digest('hex').slice(
    0,
    24,
  )
  const socketDirectory = path.join(
    '/tmp',
    `cordisx-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
  )
  return {
    directory,
    socketDirectory,
    socket: path.join(socketDirectory, `management-${scope}.sock`),
    state: path.join(directory, 'management.json'),
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function parsePluginManagementRpcRequest(
  value: unknown,
  scope: Pick<PluginManagementBridgeHandler, 'token' | 'profileId'>,
): PluginManagementRpcRequest {
  const request = record(value, 'plugin management request')
  if (request.version !== 1 || request.token !== scope.token || request.profileId !== scope.profileId) {
    throw new Error('plugin management request scope is invalid')
  }
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(request.requestId)) {
    throw new Error('plugin management request id is invalid')
  }
  const operation = record(request.operation, 'plugin management operation')
  if (
    ![
      'query',
      'plugin-configuration',
      'permission-review-apply',
      'model-export',
      'terminal-provider',
      'channel',
      'codex',
      'refresh-catalog',
      'query-catalog',
      'plugin-info',
      'plan',
      'execute',
      'migrate-legacy-sources',
    ].includes(String(operation.kind))
  ) throw new Error('plugin management operation is unsupported')
  if (operation.kind === 'plugin-configuration') parseRendererConfigOperation(operation, scope.profileId)
  if (operation.kind === 'permission-review-apply') parsePermissionReviewOperation(operation, scope.profileId)
  if (operation.kind === 'terminal-provider') parseTerminalProviderRequest(operation.request)
  if (
    operation.kind === 'channel' && (typeof operation.operation !== 'string'
      || !/^[a-z][a-z-]{0,48}$/u.test(operation.operation)
      || operation.context !== undefined
        && (typeof operation.context !== 'string' || !/^[a-f0-9]{48}$/u.test(operation.context))
      || operation.callerThreadId !== undefined
        && (typeof operation.callerThreadId !== 'string'
          || !/^[a-zA-Z0-9._:-]{1,512}$/u.test(operation.callerThreadId)))
  ) throw new Error('invalid Channel operation')
  if (
    operation.kind === 'codex' && (typeof operation.operation !== 'string'
      || !/^[a-z][a-z:_-]{0,64}$/u.test(operation.operation)
      || operation.context !== undefined
        && (typeof operation.context !== 'string' || !/^[a-f0-9]{48}$/u.test(operation.context))
      || [operation.callerThreadId, operation.callerTurnId].some(value =>
        value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,512}$/u.test(value))
      ))
  ) throw new Error('invalid Codex operation')
  return request as unknown as PluginManagementRpcRequest
}

export async function handlePluginManagementRpcRequest(
  service: PluginManagementService,
  request: PluginManagementRpcRequest,
): Promise<unknown> {
  const operation = request.operation
  if (operation.kind === 'terminal-provider') throw new Error('Terminal providers require the native catalog owner')
  if (operation.kind === 'plugin-configuration') throw new Error('Plugin configuration requires the renderer owner')
  if (operation.kind === 'permission-review-apply') throw new Error('Permission review requires the lifecycle owner')
  if (operation.kind === 'channel') throw new Error('Channel requires the configured runtime owner')
  if (operation.kind === 'codex') throw new Error('Codex requires the native runtime owner')
  if (operation.kind === 'model-export') throw new Error('Model export requires the native catalog owner')
  if (operation.kind === 'query') return await service.query()
  if (operation.kind === 'refresh-catalog') return await service.refreshCatalog(operation.sourceUrl)
  if (operation.kind === 'query-catalog') return await service.queryCatalog(operation.query)
  if (operation.kind === 'plugin-info') return await service.pluginInfo(operation.query)
  if (operation.kind === 'plan') return await service.plan(operation.request)
  if (operation.kind === 'execute') return await service.execute(operation.request, operation.expectedRevision)
  return await service.migrateLegacySources(operation.input)
}

function validEndpoint(value: unknown): value is PluginManagementRpcEndpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.schemaVersion === 1
    && typeof item.appId === 'string'
    && typeof item.profileId === 'string'
    && typeof item.configPath === 'string'
    && Number.isSafeInteger(item.pid) && (item.pid as number) > 0
    && typeof item.processStartedAt === 'string'
    && typeof item.token === 'string' && /^[a-f0-9]{64}$/u.test(item.token)
    && typeof item.generation === 'string'
    && (item.mailboxId === undefined || typeof item.mailboxId === 'string' && /^[a-f0-9]{32}$/u.test(item.mailboxId))
    && (item.pidNamespace === undefined
      || typeof item.pidNamespace === 'string' && /^pid:\[\d+\]$/u.test(item.pidNamespace))
}

export async function readPluginManagementRpcEndpoint(
  paths: PluginManagementRpcPaths,
): Promise<PluginManagementRpcEndpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.state, 'utf8')) as unknown
    return validEndpoint(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function publishEndpoint(paths: PluginManagementRpcPaths, endpoint: PluginManagementRpcEndpoint): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await chmod(paths.directory, 0o700)
  const temporary = path.join(paths.directory, `.management-${randomBytes(12).toString('hex')}.tmp`)
  await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, paths.state)
}

function respond(socket: Socket, value: Record<string, unknown>): void {
  const payload = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(payload) > MAX_MANAGEMENT_RESPONSE_BYTES) {
    socket.end('{"ok":false,"error":"plugin management response is too large"}\n')
    return
  }
  socket.end(payload)
}

export async function startPluginManagementRpcServer(input: {
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly configPath: string
  readonly generation: string
  readonly processStartedAt: string
  readonly service: PluginManagementService
  readonly modelExport?: (request: ModelExportRequest) => Promise<CliModelExportResult>
  readonly terminalProvider?: (request: TerminalProviderRequest) => Promise<TerminalProviderResult>
  readonly channel?: (operation: string, input: unknown, metadata?: unknown) => Promise<unknown>
  readonly codex?: (operation: string, input: unknown, metadata?: unknown) => Promise<unknown>
  readonly rendererConfiguration?: (operation: RendererConfigOperation) => Promise<RendererConfigResult>
  readonly permissionReview?: (operation: PermissionReviewOperation) => Promise<unknown>
  readonly sandboxMailbox?: boolean
}): Promise<PluginManagementRpcServer> {
  const paths = pluginManagementRpcPaths(input.homeDir, input.appId, input.profileId)
  const token = randomBytes(32).toString('hex')
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await mkdir(paths.socketDirectory, { recursive: true, mode: 0o700 })
  const socketDirHandle = await open(
    paths.socketDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await socketDirHandle.chmod(0o700)
  } finally {
    await socketDirHandle.close()
  }
  await rm(paths.socket, { force: true })
  const dispatch = async (parsed: unknown): Promise<unknown> => {
    const request = parsePluginManagementRpcRequest(parsed, { token, profileId: input.profileId })
    return request.operation.kind === 'permission-review-apply'
      ? await (input.permissionReview?.(request.operation)
        ?? Promise.resolve({ status: 'unavailable', reason: 'lifecycle-unavailable' }))
      : request.operation.kind === 'plugin-configuration'
      ? await (input.rendererConfiguration?.(request.operation)
        ?? Promise.resolve({ status: 'unavailable', reason: 'renderer-unavailable' }))
      : request.operation.kind === 'codex'
      ? await (input.codex?.(request.operation.operation, request.operation.input, {
        ...(request.operation.context ? { 'cordisx/channelContext': request.operation.context } : {}),
        ...(request.operation.callerThreadId ? { 'openai/threadId': request.operation.callerThreadId } : {}),
        ...(request.operation.callerTurnId ? { 'openai/turnId': request.operation.callerTurnId } : {}),
        'openai/toolCallId': request.requestId,
      }) ?? Promise.resolve({ status: 'unavailable', code: 'CODEX_RUNTIME_UNAVAILABLE' }))
      : request.operation.kind === 'channel'
      ? await (input.channel?.(
        request.operation.operation,
        request.operation.input,
        request.operation.context || request.operation.callerThreadId
          ? {
            ...(request.operation.context ? { 'cordisx/channelContext': request.operation.context } : {}),
            ...(request.operation.callerThreadId
              ? { 'openai/threadId': request.operation.callerThreadId }
              : {}),
          }
          : undefined,
      )
        ?? Promise.resolve({ status: 'unavailable', code: 'CHANNEL_NOT_CONFIGURED' }))
      : request.operation.kind === 'terminal-provider'
      ? await (input.terminalProvider?.(request.operation.request)
        ?? Promise.reject(new Error('Terminal provider unavailable; update the running CordisX Host')))
      : request.operation.kind === 'model-export'
      ? await (input.modelExport?.(request.operation.request)
        ?? Promise.reject(
          new Error('Model export unavailable; this runtime needs compatible native catalog support'),
        ))
      : await handlePluginManagementRpcRequest(input.service, request)
  }
  const sockets = new Set<Socket>()
  const server: Server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    let payload = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      payload += chunk
      if (Buffer.byteLength(payload) > MAX_MANAGEMENT_REQUEST_BYTES) return socket.destroy()
      const newline = payload.indexOf('\n')
      if (newline < 0) return
      const line = payload.slice(0, newline)
      payload = ''
      void (async () => {
        let requestId = 'invalid'
        try {
          const parsed = JSON.parse(line) as { requestId?: unknown }
          if (typeof parsed.requestId === 'string') requestId = parsed.requestId
          respond(socket, { requestId, ok: true, value: await dispatch(parsed) })
        } catch (error) {
          respond(socket, {
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'plugin management request was rejected',
          })
        }
      })()
    })
  })
  const mailboxRoot = managementMailboxRoot(paths)
  let mailboxParent: Awaited<ReturnType<typeof open>> | undefined
  if (input.sandboxMailbox && process.platform === 'linux') {
    const socketDirectory = await open(
      paths.socketDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const anchoredRoot = `/proc/self/fd/${socketDirectory.fd}/${path.basename(mailboxRoot)}`
      await mkdir(anchoredRoot, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      mailboxParent = await open(anchoredRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      await mailboxParent.chmod(0o700)
    } catch (error) {
      await mailboxParent?.close().catch(() => undefined)
      throw error
    } finally {
      await socketDirectory.close()
    }
  } else if (input.sandboxMailbox) {
    await mkdir(mailboxRoot, { recursive: true, mode: 0o700 })
    await chmod(mailboxRoot, 0o700)
  }
  const mailboxId = input.sandboxMailbox ? randomBytes(16).toString('hex') : undefined
  const mailbox = mailboxId
    ? await startManagementMailbox({
      directory: managementMailboxPath(mailboxRoot, mailboxId),
      token,
      ...(mailboxParent ? { parentHandle: mailboxParent } : {}),
      dispatch: async parsed => {
        const request = parsePluginManagementRpcRequest(parsed, { token, profileId: input.profileId })
        const operation = request.operation
        // A process in the sandbox is never a local administrator merely because it can
        // read the endpoint. The live Channel source token remains mandatory.
        if (operation.kind !== 'channel' && operation.kind !== 'codex' || !operation.context) {
          throw new Error('CHANNEL_CONTEXT_REQUIRED')
        }
        if (operation.kind === 'channel' && operation.operation.startsWith('admin-')) {
          throw new Error('LOCAL_USER_REQUIRED')
        }
        if (
          operation.kind === 'codex' && ![
            'capabilities',
            'list',
            'select',
            'execution:execution-settings',
            'execution:execution-settings-set',
            'configuration:fast',
            'configuration:fast-set',
            'configuration:project',
            'configuration:project-set',
          ].includes(operation.operation)
        ) throw new Error('LOCAL_USER_REQUIRED')
        return dispatch(parsed)
      },
    })
    : undefined
  const pidNamespace = process.platform === 'linux'
    ? await readlink('/proc/self/ns/pid').catch(() => undefined)
    : undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(paths.socket, () => resolve())
    })
    await chmod(paths.socket, 0o600)
    await publishEndpoint(paths, {
      schemaVersion: 1,
      appId: input.appId,
      profileId: input.profileId,
      configPath: path.resolve(input.configPath),
      pid: process.pid,
      processStartedAt: input.processStartedAt,
      token,
      generation: input.generation,
      ...(mailboxId ? { mailboxId } : {}),
      ...(mailboxId && pidNamespace ? { pidNamespace } : {}),
    })
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.allSettled([mailbox?.close(), rm(paths.socket, { force: true }), rm(paths.state, { force: true })])
    throw error
  }
  return {
    async close(): Promise<void> {
      await mailbox?.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      const current = await readPluginManagementRpcEndpoint(paths)
      if (current?.token === token) await rm(paths.state, { force: true })
      await rm(paths.socket, { force: true })
    },
  }
}

export async function requestPluginManagementRpc(
  paths: PluginManagementRpcPaths,
  endpoint: PluginManagementRpcEndpoint,
  operation: PluginManagementRpcOperation,
  options: { readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const requestId = `management-${randomBytes(12).toString('hex')}`
  return await new Promise((resolve, reject) => {
    const socket = connect(paths.socket)
    let response = ''
    let settled = false
    const settle = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      operation()
    }
    // Executing an install/update can download and stage a large package.
    const normalDeadline = operation.kind === 'execute' ? 180_000 : 60_000
    const deadline = options.timeoutMs === undefined || !Number.isFinite(options.timeoutMs)
      ? normalDeadline
      : Math.max(1, Math.min(normalDeadline, options.timeoutMs))
    const timer = setTimeout(() => socket.destroy(new Error('plugin management request timed out')), deadline)
    socket.setEncoding('utf8')
    socket.once('error', error => settle(() => reject(error)))
    socket.on('data', chunk => {
      response += chunk
      if (Buffer.byteLength(response) > MAX_MANAGEMENT_RESPONSE_BYTES) {
        socket.destroy(new Error('plugin management response is too large'))
      }
    })
    socket.once('end', () => {
      try {
        const value = JSON.parse(response.trim()) as {
          readonly ok?: unknown
          readonly value?: unknown
          readonly error?: unknown
        }
        if (value.ok === true) settle(() => resolve(value.value))
        else {settle(() =>
            reject(new Error(typeof value.error === 'string' ? value.error : 'plugin management request failed'))
          )}
      } catch (error) {
        settle(() => reject(error))
      }
    })
    socket.once('connect', () =>
      socket.write(`${
        JSON.stringify({
          version: 1,
          requestId,
          token: endpoint.token,
          profileId: endpoint.profileId,
          operation,
        })
      }\n`))
  })
}

/** Only an explicitly recorded, different Linux PID namespace permits the mailbox path. */
export async function usesNamespacedManagementRpc(endpoint: PluginManagementRpcEndpoint): Promise<boolean> {
  if (!endpoint.mailboxId || !endpoint.pidNamespace || process.platform !== 'linux') return false
  const current = await readlink('/proc/self/ns/pid').catch(() => undefined)
  return current !== undefined && current !== endpoint.pidNamespace
}

/** Host identity may be invisible only when the endpoint proves a different Linux PID namespace. */
export async function requestNamespacedManagementRpc(
  paths: PluginManagementRpcPaths,
  endpoint: PluginManagementRpcEndpoint,
  operation: PluginManagementRpcOperation,
): Promise<unknown> {
  if (!endpoint.mailboxId || !await usesNamespacedManagementRpc(endpoint)) throw new Error('MAILBOX_UNAVAILABLE')
  return requestManagementMailbox({
    directory: managementMailboxPath(managementMailboxRoot(paths), endpoint.mailboxId),
    token: endpoint.token,
    value: {
      version: 1,
      requestId: `management-${randomBytes(12).toString('hex')}`,
      token: endpoint.token,
      profileId: endpoint.profileId,
      operation,
    },
  })
}

export function managementMutationOperation(
  request: PluginManagementConfigRequest,
  expectedRevision: number,
): PluginManagementRpcOperation {
  return { kind: 'execute', request, expectedRevision }
}

export interface PluginManagementSnapshotEvent {
  readonly version: 1
  readonly kind: 'snapshot'
  readonly profileId: string
  readonly generation: string
  readonly snapshot: PluginManagementSnapshot
}
