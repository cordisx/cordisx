import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { NativeSubmissionController } from './native-submission-controller.js'

type Selection = Readonly<{ threadId: string; providerId: string; model: string }>
const SESSION_APPS = ['codex', 'claude'] as const
const SESSION_OPERATIONS = ['list_sessions', 'read_session', 'start_session', 'send_message'] as const
export type SessionApp = typeof SESSION_APPS[number]
export type SessionOperation = typeof SESSION_OPERATIONS[number]
const sessionOperation = (value: unknown): SessionOperation | undefined =>
  typeof value === 'string' && value.startsWith('session:')
    && (SESSION_OPERATIONS as readonly string[]).includes(value.slice('session:'.length))
    ? value.slice('session:'.length) as SessionOperation
    : undefined
export class NativeAgentModelSelectionRejected extends Error {
  readonly reason = 'thread-not-idle'
}
export interface NativeAgentModelsAuthority {
  catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
  controller: Pick<NativeSubmissionController, 'prepareThreadResume' | 'completeThreadResume'>
  switchThread(input: Selection & { configOverrides: Readonly<Record<string, unknown>> }): Promise<void>
  reserve(threadId: string): boolean
  commit(input: Selection): void
  release(threadId: string): void
  createTask?(input: unknown, metadata: unknown): Promise<unknown>
  /** Cross-app session tools through the CordisX agent bridge; `app` names the target. */
  sessions?(app: SessionApp, operation: SessionOperation, input: unknown): Promise<unknown>
  taskCreationAvailable?(): Promise<boolean>
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)

/** Uses the UI's admitted catalog and credential leases; tool callers never supply a connection or secret. */
export function createNativeAgentModelsHandler(authority: NativeAgentModelsAuthority) {
  return async (operation: unknown, input: unknown, metadata?: unknown): Promise<unknown> => {
    const session = sessionOperation(operation)
    if (session !== undefined) {
      const args = object(input) ?? {}
      const app = args.app
      if (typeof app !== 'string' || !(SESSION_APPS as readonly string[]).includes(app)) {
        return { status: 'rejected', reason: `app must be one of ${SESSION_APPS.join(', ')}` }
      }
      if (authority.sessions === undefined) return { status: 'unavailable', reason: 'agent-bridge-unavailable' }
      const { app: _app, ...rest } = args
      try {
        return { status: 'ok', value: await authority.sessions(app as SessionApp, session, rest) }
      } catch (error) {
        return { status: 'unavailable', reason: error instanceof Error ? error.message : 'unavailable' }
      }
    }
    const catalog = await authority.catalog()
    if (operation === 'create' && authority.createTask) return await authority.createTask(input, metadata)
    if (operation === 'list') {
      return {
        threadCreation: await authority.taskCreationAvailable?.()
          ? { status: 'available', tool: 'create_thread_with_provider' }
          : { status: 'unavailable', reason: 'native-task-provider-creation-unavailable' },
        providers: catalog.map(provider => ({
          providerId: provider.providerId,
          title: provider.title ?? provider.providerId,
          models: provider.models.map(model => ({
            id: model.id,
            label: model.label,
            ...(() => {
              const reasoningCapabilities = parseModelReasoningCapabilities(model.reasoningCapabilities)
              return reasoningCapabilities === undefined ? {} : { reasoningCapabilities }
            })(),
          })),
        })),
      }
    }
    const selection = object(input)
    if (
      operation !== 'select' || !selection || !text(selection.threadId) || !text(selection.providerId, 128)
      || !text(selection.model)
      || Object.keys(selection).some(key => !['threadId', 'providerId', 'model'].includes(key))
    ) return { status: 'rejected', reason: 'invalid-selection' }
    const target: Selection = { threadId: selection.threadId, providerId: selection.providerId, model: selection.model }
    if (
      !catalog.some(provider =>
        provider.providerId === target.providerId && provider.models.some(model => model.id === target.model)
      )
    ) return { status: 'rejected', reason: 'selection-outside-catalog' }
    if (!authority.reserve(target.threadId)) return { status: 'rejected', reason: 'selection-busy' }
    let token: string | undefined
    let attempted = false
    try {
      const prepared = await authority.controller.prepareThreadResume(target)
      if (prepared.kind !== 'resume') return { status: 'rejected', reason: prepared.reason }
      token = prepared.resumeToken
      attempted = true
      await authority.switchThread({ ...target, configOverrides: prepared.configOverrides })
      const committed = await authority.controller.completeThreadResume({
        threadId: target.threadId,
        resumeToken: token,
        succeeded: true,
      })
      token = undefined
      if (!committed) return { status: 'reconciliation-required', ...target }
      authority.commit(target)
      return { status: 'selected', ...target }
    } catch (error) {
      if (error instanceof NativeAgentModelSelectionRejected) return { status: 'rejected', reason: error.reason }
      // A lost native acknowledgement can follow a successful resume. Never claim the old route is intact.
      return { status: attempted ? 'reconciliation-required' : 'rejected', reason: 'native-selection-unavailable' }
    } finally {
      if (token !== undefined) {
        await authority.controller.completeThreadResume({
          threadId: target.threadId,
          resumeToken: token,
          succeeded: false,
        }).catch(() => undefined)
      }
      authority.release(target.threadId)
    }
  }
}

/** One launch-scoped, owner-only endpoint shared by that app-server's MCP subprocesses. */
export async function startNativeAgentModelsServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-agent-models-'))
  const socketPath = path.join(directory, 'tools.sock')
  const bindingPath = path.join(directory, 'binding.json')
  const token = randomBytes(32).toString('hex')
  let handler: ReturnType<typeof createNativeAgentModelsHandler> | undefined
  let closed = false
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    // A message to an open Claude session waits in the agent bridge queue for that session.
    socket.setTimeout(90000, () => socket.destroy())
    let buffer = ''
    let started = false
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      if (started) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 256 * 1024) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      started = true
      void (async () => {
        try {
          const request = object(JSON.parse(buffer.slice(0, newline)))
          if (closed || !handler || request?.token !== token) throw new Error('unavailable')
          const value = await handler(request.operation, request.input, request.metadata)
          if (closed) throw new Error('unavailable')
          const response = JSON.stringify({ ok: true, value })
          if (Buffer.byteLength(response) > 8 * 1024 * 1024) throw new Error('too-large')
          socket.end(`${response}\n`)
        } catch {
          socket.end('{"ok":false,"error":"Native model tools unavailable"}\n')
        }
      })()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
    await writeFile(bindingPath, JSON.stringify({ version: 1, socketPath, token }), { mode: 0o600 })
  } catch (error) {
    server.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    bindingPath,
    bind(authority: NativeAgentModelsAuthority) {
      handler = createNativeAgentModelsHandler(authority)
    },
    async close() {
      if (closed) return
      closed = true
      handler = undefined
      sockets.forEach(socket => socket.destroy())
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}
