import type { StartupProviderAdmission } from './startup-provider-admission.js'
import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import { callerThreadId } from './agent-bridge-context.js'
import { dispatchCodexSettings } from './codex-settings-dispatch.js'
import { bridgeFailure } from './agent-bridge-contract.js'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { NativeSubmissionController } from './native-submission-controller.js'

type Selection = Readonly<{ threadId: string; providerId: string; model: string }>
const SESSION_APPS = ['codex', 'claude'] as const
const SESSION_OPERATIONS = [
  'list_sessions',
  'read_session',
  'start_session',
  'send_message',
  'check_operation',
] as const
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
  /** Preparation callers cannot use other Host-owned side-effecting tools. */
  preparing?(metadata: unknown): boolean
  readonly startup?: StartupProviderAdmission
  catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
  controller: Pick<NativeSubmissionController, 'prepareThreadResume' | 'completeThreadResume'>
  switchThread(input: Selection & { configOverrides: Readonly<Record<string, unknown>> }): Promise<void>
  reserve(threadId: string): boolean | Promise<boolean>
  commit(input: Selection): void
  release(threadId: string): void
  createTask?(input: unknown, metadata: unknown): Promise<unknown>
  /** Cross-app session tools through the CordisX agent bridge; `app` names the target. */
  sessions?(app: SessionApp, operation: SessionOperation, input: unknown, metadata?: unknown): Promise<unknown>
  /** The read-only integration report. Reads files and probes; never launches or writes. */
  integrationStatus?(input: unknown): Promise<unknown>
  taskCreationAvailable?(): Promise<boolean>
  execution?(operation: string, input: unknown, metadata?: unknown): Promise<unknown>
  configuration?(operation: string, input: unknown, metadata?: unknown): Promise<unknown>
  modelServices?(operation: 'read' | 'save', input: unknown, metadata?: unknown): Promise<unknown>
  /** Channel operations use this launch's configured connection and conversation consumer. */
  channel?(operation: string, input: unknown, metadata?: unknown): Promise<unknown>
  channelModelSelection?(input: unknown, metadata?: unknown): Promise<unknown | undefined>
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)

/** Uses the UI's admitted catalog and credential leases; tool callers never supply a connection or secret. */
export function createNativeAgentModelsHandler(authority: NativeAgentModelsAuthority) {
  return async (
    operation: unknown,
    input: unknown,
    metadata?: unknown,
    beforeEffect?: () => Promise<boolean>,
  ): Promise<unknown> => {
    if (
      authority.preparing?.(metadata)
      && !['channel:continuation-history', 'channel:continuation-takeover-ready'].includes(String(operation))
    ) {
      return { status: 'rejected', reason: 'preparation-read-only' }
    }
    if (typeof operation === 'string' && operation.startsWith('channel:')) {
      return authority.channel === undefined
        ? { status: 'unavailable', code: 'CHANNEL_NOT_CONFIGURED' }
        : await authority.channel(operation.slice('channel:'.length), input, metadata)
    }
    const supplemental = await dispatchCodexSettings(authority, operation, input, metadata)
    if (supplemental !== undefined) return supplemental
    if (operation === 'capabilities') {
      return {
        status: 'ok',
        capabilities: {
          providerCatalog: true,
          providerSelection: true,
          providerCreation: await authority.taskCreationAvailable?.() === true,
          executionSettings: authority.execution !== undefined,
          modelServices: authority.modelServices !== undefined,
          projectSwitch: authority.configuration !== undefined,
          fastSettings: authority.configuration !== undefined,
          modelCreationDefaults: authority.configuration !== undefined,
        },
      }
    }
    const session = sessionOperation(operation)
    if (session !== undefined) {
      const args = object(input) ?? {}
      const app = args.app
      if (typeof app !== 'string' || !(SESSION_APPS as readonly string[]).includes(app)) {
        return bridgeFailure('unknown-app', { message: `app must be one of ${SESSION_APPS.join(', ')}`, detail: 'app' })
      }
      if (authority.sessions === undefined) {
        return bridgeFailure('agent-bridge-unavailable', {
          status: 'unavailable',
          message: 'The CordisX agent bridge is not running',
        })
      }
      const { app: _app, callerSessionId: _caller, callerSummary: _summary, ...rest } = args
      try {
        // The bridge answers with the whole result: a value, or its structured failure.
        const caller = session === 'start_session' ? callerThreadId(metadata) : undefined
        return await authority.sessions(
          app as SessionApp,
          session,
          caller === undefined ? rest : { ...rest, callerSessionId: caller },
          metadata,
        )
      } catch (error) {
        return bridgeFailure('agent-bridge-unavailable', {
          status: 'unavailable',
          message: error instanceof Error ? error.message : 'The CordisX agent bridge is unavailable',
        })
      }
    }
    if (operation === 'integration_status') {
      const args = object(input) ?? {}
      if (args.app !== undefined && !(SESSION_APPS as readonly unknown[]).includes(args.app)) {
        return { status: 'rejected', reason: `app must be one of ${SESSION_APPS.join(', ')}` }
      }
      if (authority.integrationStatus === undefined) {
        return { status: 'unavailable', reason: 'integration-status-unavailable' }
      }
      return { status: 'ok', value: await authority.integrationStatus(args) }
    }
    const catalog = await authority.catalog()
    if (operation === 'create' && authority.createTask) return await authority.createTask(input, metadata)
    if (operation === 'list') {
      return {
        status: 'ok',
        ...(authority.startup?.snapshot === undefined ? {} : { startup: await authority.startup.snapshot() }),
        threadCreation: await authority.taskCreationAvailable?.()
          ? { status: 'available', tool: 'create_thread_with_provider' }
          : { status: 'unavailable', reason: 'native-task-provider-creation-unavailable' },
        providers: catalog.map(provider => ({
          providerId: provider.providerId,
          title: provider.title ?? provider.providerId,
          ...(provider.defaultModelId ? { defaultModelId: provider.defaultModelId } : {}),
          models: provider.models.map(model => ({
            id: model.id,
            label: model.label,
            ...(model.supportsFastMode === undefined ? {} : { supportsFastMode: model.supportsFastMode }),
            ...(() => {
              const reasoningCapabilities = parseModelReasoningCapabilities(model.reasoningCapabilities)
              return reasoningCapabilities === undefined ? {} : { reasoningCapabilities }
            })(),
          })),
        })),
      }
    }
    const selectionInput = object(input)
    const selection: Record<string, unknown> | undefined = selectionInput === undefined ? undefined : {
      ...selectionInput,
      threadId: selectionInput.threadId === undefined ? callerThreadId(metadata) : selectionInput.threadId,
    }
    if (
      operation !== 'select' || !selection || !text(selection.threadId) || !text(selection.providerId, 128)
      || !text(selection.model)
      || Object.keys(selection).some(key => !['threadId', 'providerId', 'model'].includes(key))
    ) return { status: 'rejected', reason: 'invalid-selection' }
    const target: Selection = { threadId: selection.threadId, providerId: selection.providerId, model: selection.model }
    const channel = await authority.channelModelSelection?.(selection, metadata)
    if (channel !== undefined) return channel
    const startup = authority.startup?.availability(target.providerId, target.model)
    if (startup !== undefined && !startup.available) return { status: 'unavailable', reason: startup.reason }
    if (
      !catalog.some(provider =>
        provider.providerId === target.providerId && provider.models.some(model => model.id === target.model)
      )
    ) return { status: 'rejected', reason: 'selection-outside-catalog' }
    if (!await authority.reserve(target.threadId)) return { status: 'rejected', reason: 'selection-busy' }
    let token: string | undefined
    let attempted = false
    try {
      const prepared = await authority.controller.prepareThreadResume(target)
      if (prepared.kind !== 'resume') return { status: 'rejected', reason: prepared.startupReason ?? prepared.reason }
      token = prepared.resumeToken
      if (beforeEffect && !await beforeEffect()) return { status: 'rejected', reason: 'selection-changed' }
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
    async call(operation: string, input: unknown, metadata?: unknown) {
      return handler && !closed
        ? handler(operation, input, metadata)
        : { status: 'unavailable', code: 'CODEX_RUNTIME_UNAVAILABLE' }
    },
    bind(authority: NativeAgentModelsAuthority) {
      handler = createNativeAgentModelsHandler(authority)
      const { channelModelSelection: _guard, ...trusted } = authority
      return createNativeAgentModelsHandler(trusted)
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
