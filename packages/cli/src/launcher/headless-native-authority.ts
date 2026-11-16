import path from 'node:path'
import { ChatExecutionPreferences } from './chat-execution-preferences.js'
import type { HeadlessNativeAuthority } from '../cli/headless-service.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

type RequestId = string | number
type NativeReader = (method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>
interface ChatControl {
  received(message: Record<string, unknown>): void
  respond(message: Record<string, unknown>): Promise<unknown>
  dispose(): void
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Adapts the shared native chat-control and execution store to an owned app-server. */
export async function createHeadlessNativeAuthority(input: {
  homeDir: string
  configPath: string
  appId: string
  profileId: string
  report(code: string): void
}) {
  const execution = await ChatExecutionPreferences.open({
    file: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'chat-execution.json'),
    configPath: input.configPath,
    appId: input.appId,
    profileId: input.profileId,
  })
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const pending = new Map<
    RequestId,
    { threadId: string; turnId: string; resolve(value: unknown): void; reject(error: Error): void }
  >()
  let read: NativeReader | undefined
  let closed = false
  // The asset is copied beside dist/src in the normal package build. A dynamic path avoids
  // declaring another implementation of the native chat-control contract in TypeScript.
  const asset = '../../assets/launcher/native-chat-control.mjs'
  const { createNativeChatControl } = await import(asset) as {
    createNativeChatControl(options: Record<string, unknown>): ChatControl
  }
  const control = createNativeChatControl({
    closed: () => closed,
    controlCall: async () => {
      throw new Error('UNUSED_HEADLESS_CONTROL_CALL')
    },
    readNative: (method: NativeBridgeMethod, params: Record<string, unknown>) => {
      if (!read) throw new Error('HEADLESS_BACKEND_UNAVAILABLE')
      return read(method, params)
    },
    writeNative: async (message: Record<string, unknown>) => {
      const id = message.id as RequestId
      const request = pending.get(id)
      if (!request) throw new Error('HEADLESS_APPROVAL_EXPIRED')
      pending.delete(id)
      request.resolve(message.result)
    },
    emit: async (event: Record<string, unknown>) => {
      if (event.type === 'native-approval-event') { for (const listener of listeners) listener(event) }
    },
  })
  const authority: HeadlessNativeAuthority = {
    execution,
    request: (method, params, id?: RequestId) => {
      if (closed || id === undefined || pending.has(id)) throw new Error('HEADLESS_APPROVAL_ID_UNAVAILABLE')
      if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        throw new Error('HEADLESS_NATIVE_REQUEST_UNSUPPORTED')
      }
      const details = record(params)
      if (
        typeof details.threadId !== 'string' || typeof details.turnId !== 'string' || typeof details.itemId !== 'string'
      ) {
        throw new Error('HEADLESS_APPROVAL_INVALID')
      }
      if (pending.size >= 128) throw new Error('HEADLESS_APPROVAL_CAPACITY')
      return new Promise((resolve, reject) => {
        pending.set(id, { threadId: details.threadId as string, turnId: details.turnId as string, resolve, reject })
        control.received({ method, params, id })
      })
    },
    notification: (method, params) => {
      control.received({ method, params })
      const value = record(params)
      if (
        method === 'serverRequest/resolved'
        && (typeof value.requestId === 'string' || typeof value.requestId === 'number')
      ) {
        const request = pending.get(value.requestId)
        if (request && request.threadId === value.threadId) {
          pending.delete(value.requestId)
          request.reject(new Error('HEADLESS_APPROVAL_RESOLVED'))
        }
      }
      if (method === 'turn/completed' || method === 'thread/closed') {
        const turnId = record(value.turn).id ?? value.turnId
        for (const [id, request] of pending) {
          if (request.threadId === value.threadId && (!turnId || turnId === request.turnId)) {
            pending.delete(id)
            request.reject(new Error('HEADLESS_APPROVAL_CANCELLED'))
          }
        }
      }
      if (method === 'thread/settings/updated' && typeof value.threadId === 'string') {
        void execution.observe(value.threadId, value.threadSettings).catch(() =>
          input.report('EXECUTION_OBSERVATION_FAILED')
        )
      }
    },
    subscribeApprovals: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    respondApproval: async value => {
      const result = record(await control.respond(value))
      // Resolving the RPC handler does not acknowledge the subsequent transport write.
      // Keep the decision uncertain until the native resolved notification arrives.
      if (result.status === 'submitted') throw new Error('HEADLESS_APPROVAL_WRITE_UNCONFIRMED')
      return result
    },
    nativeRequest: async (method, params, next) => {
      if (!['thread/start', 'thread/resume', 'turn/start'].includes(method)) return next(params)
      let prepared = await execution.prepare(method, params)
      if (prepared.contextRequired && method === 'turn/start' && typeof params.threadId === 'string') {
        if (!read) throw new Error('HEADLESS_BACKEND_UNAVAILABLE')
        const thread = record(
          record(await read('thread/read', { threadId: params.threadId, includeTurns: false })).thread,
        )
        if (thread.id !== params.threadId) throw new Error('EXECUTION_CONTEXT_UNAVAILABLE')
        prepared = await execution.prepare(method, params, thread)
      }
      if (prepared.contextRequired) throw new Error('EXECUTION_CONTEXT_UNAVAILABLE')
      const result = await next(prepared.params)
      if (prepared.captureId) {
        await execution.complete(prepared.captureId, true, result).catch(() =>
          input.report('EXECUTION_PERSISTENCE_FAILED')
        )
      }
      return result
    },
  }
  return {
    authority,
    setReader: (reader: NativeReader) => {
      read = reader
    },
    close: async () => {
      if (closed) return
      closed = true
      control.dispose()
      for (const request of pending.values()) request.reject(new Error('HEADLESS_SERVICE_CLOSED'))
      pending.clear()
      listeners.clear()
      await execution.close()
    },
  }
}
