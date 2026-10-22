import { JSDOM } from 'jsdom'
import { afterEach, vi } from 'vitest'
import { composer } from './native-model-provider-composer.js'
import { CodexDesktopNativeModelProviderTransport } from '../../packages/cli/src/renderer/native-model-provider-transport.js'
import type {
  NativeProviderSelectionCommandChannel,
  NativeProviderSelectionProjection,
} from '../../packages/cli/src/renderer/native-provider-selection-client.js'

const originals = new Map<string, PropertyDescriptor | undefined>()
export function install(name: string, value: unknown): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
  originals.clear()
})

export function message(view: Window, data: unknown): void {
  view.dispatchEvent(new view.MessageEvent('message', { data, source: view }))
}

export function nativeRequest(view: Window, request: Record<string, unknown>): void {
  view.dispatchEvent(
    new view.CustomEvent('codex-message-from-view', {
      detail: { type: 'mcp-request', hostId: 'local', request },
    }),
  )
}

export async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

export async function waitForRequest(
  requests: readonly Record<string, unknown>[],
  predicate: (request: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = requests.find(predicate)
    if (request !== undefined) return request
    await settle()
  }
  throw new Error('request not observed')
}

export async function harness(
  handler?: (request: Record<string, unknown>, view: Window) => boolean | void,
  catalogReasoning?: Parameters<typeof CodexDesktopNativeModelProviderTransport.connect>[3],
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'app://-/index.html' })
  const control = composer(dom.window.document)
  const requests: Record<string, unknown>[] = []
  install('window', dom.window)
  install('document', dom.window.document)
  install('location', dom.window.location)
  install('codexWindowType', 'electron')
  install('electronBridge', {
    sendMessageFromView: async (envelope: { request?: Record<string, unknown> }) => {
      if (envelope.request === undefined) return
      const request = structuredClone(envelope.request)
      if (request.method !== 'model/list') requests.push(request)
      if (handler?.(envelope.request, dom.window)) return
      const params = envelope.request.params as Record<string, unknown>
      const result = envelope.request.method === 'thread/read'
        ? { thread: { id: params.threadId, status: { type: 'idle' }, modelProvider: 'provider-a' } }
        : envelope.request.method === 'config/read'
        ? { config: { model_provider: 'provider-a', model: 'model-a', model_reasoning_effort: 'high' } }
        : envelope.request.method === 'model/list'
        ? {
          data: [{ id: 'protocol-model-a', model: 'model-a', displayName: 'Model A', hidden: false }],
          nextCursor: null,
        }
        : {}
      queueMicrotask(() =>
        message(dom.window, {
          type: 'mcp-response',
          hostId: 'local',
          message: { id: envelope.request!.id, result },
        })
      )
    },
  })
  let projection: NativeProviderSelectionProjection = {
    available: true,
    revision: 1,
    effective: { providerId: 'provider-a', model: 'model-a' },
  }
  const channel = {
    selectionRead: vi.fn<NativeProviderSelectionCommandChannel['selectionRead']>(async input => {
      if (input.effective && !projection.pending) {
        projection = { ...projection, effective: input.effective, revision: projection.revision + 1 }
      }
      return projection
    }),
    selectionSelect: vi.fn<NativeProviderSelectionCommandChannel['selectionSelect']>(async input => {
      const existingThread = dom.window.document.querySelector('[data-above-composer-conversation-id]') !== null
      const sameProvider = input.providerId === projection.effective?.providerId
      projection = {
        available: true,
        revision: projection.revision + 1,
        effective: existingThread || sameProvider
          ? { providerId: input.providerId, model: input.model }
          : projection.effective!,
        ...(existingThread || sameProvider
          ? {}
          : { pending: { providerId: input.providerId, model: input.model, generation: projection.revision + 1 } }),
      }
      return { ...projection, status: 'accepted', effective: projection.effective! }
    }),
    submissionPrepare: vi.fn<NativeProviderSelectionCommandChannel['submissionPrepare']>(async () => ({
      status: 'confirm',
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: projection.revision,
    })),
    submissionConfirm: vi.fn<NativeProviderSelectionCommandChannel['submissionConfirm']>(async () => ({
      status: 'allow-original',
      operationToken: 'allowed-operation-token',
      projection: { available: true, revision: 97, effective: { providerId: 'provider-b', model: 'model-b' } },
    })),
    submissionCancel: vi.fn(async () => undefined),
  }
  install('__cordisxNativeSubmitHook', undefined)
  install('__cordisxNativeSubmissionAuthority', undefined)
  const transport = await CodexDesktopNativeModelProviderTransport.connect(
    true,
    {
      targetId: 'target',
      rendererGeneration: 'renderer',
    },
    channel,
    catalogReasoning,
  )
  if (transport === undefined) throw new Error('transport unavailable')
  return { ...control, dom, requests, transport, channel }
}
