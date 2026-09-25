import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import type {
  NativeProviderSelectionCommandChannel,
  NativeProviderSelectionProjection,
} from '../packages/cli/src/renderer/native-provider-selection-client.js'
import { composer } from './fixtures/native-model-provider-composer.js'

const originals = new Map<string, PropertyDescriptor | undefined>()

function install(name: string, value: unknown): void {
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

function message(view: Window, data: unknown): void {
  view.dispatchEvent(new view.MessageEvent('message', { data, source: view }))
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function exposeGlobalModels(control: ReturnType<typeof composer>): void {
  const props = (control.trigger as unknown as {
    __reactFiber$test: { return: { memoizedProps: Record<string, unknown> } }
  }).__reactFiber$test.return.memoizedProps as {
    models: { model: string; displayName?: string; supportedReasoningEfforts: unknown }[]
    modelOptions: { model: { model: string; displayName?: string }; disabledReason: string | null }[]
  }
  props.models[0]!.displayName = 'Model A'
  props.modelOptions[0]!.model = props.models[0]!
  props.models.push({
    model: 'model-b',
    displayName: 'Model B',
    supportedReasoningEfforts: props.models[0]!.supportedReasoningEfforts,
  })
  props.modelOptions.push({ model: props.models[1]!, disabledReason: null })
}

async function harness(catalog: () => string) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'app://-/index.html' })
  const control = composer(dom.window.document)
  exposeGlobalModels(control)
  install('window', dom.window)
  install('document', dom.window.document)
  install('location', dom.window.location)
  install('codexWindowType', 'electron')
  install('__cordisxNativeSubmitHook', undefined)
  install('__cordisxNativeSubmissionAuthority', undefined)
  install('electronBridge', {
    sendMessageFromView: async (envelope: { request?: Record<string, unknown> }) => {
      const request = envelope.request
      if (request === undefined) return
      const params = request.params as Record<string, unknown>
      const result = request.method === 'thread/read'
        ? { thread: { id: params.threadId, status: { type: 'idle' }, modelProvider: 'provider-a' } }
        : request.method === 'config/read'
        ? {
          config: {
            model_provider: 'provider-a',
            model: 'model-a',
            model_catalog_json: catalog(),
            model_reasoning_effort: 'high',
          },
        }
        : {}
      queueMicrotask(() =>
        message(dom.window, {
          type: 'mcp-response',
          hostId: 'local',
          message: { id: request.id, result },
        })
      )
    },
  })
  let projection: NativeProviderSelectionProjection = {
    available: true,
    revision: 1,
    effective: { providerId: 'provider-a', model: 'model-a' },
  }
  const channel: NativeProviderSelectionCommandChannel = {
    selectionRead: vi.fn(async input => {
      if (input.effective && !projection.pending) {
        projection = { ...projection, effective: input.effective, revision: projection.revision + 1 }
      }
      return projection
    }),
    selectionSelect: vi.fn(async input => {
      projection = {
        available: true,
        revision: projection.revision + 1,
        effective: { providerId: input.providerId, model: input.model },
      }
      return { ...projection, status: 'accepted' as const, effective: projection.effective! }
    }),
    submissionPrepare: vi.fn(async () => ({ status: 'pass-through' as const })),
    submissionConfirm: vi.fn(async () => ({ status: 'reject' as const, reason: 'unused' })),
    submissionCancel: vi.fn(async () => undefined),
  }
  const transport = await CodexDesktopNativeModelProviderTransport.connect(true, {
    targetId: 'target',
    rendererGeneration: 'renderer',
  }, channel)
  if (transport === undefined) throw new Error('transport unavailable')
  return { ...control, dom, transport }
}

describe('native model provider assignments', () => {
  it('retains confirmed provider pairs for a global catalog', async () => {
    const h = await harness(() => '/redacted/global-a.json')
    expect(h.transport.getSnapshot().nativeModelAssignments).toEqual([
      { providerId: 'provider-a', model: 'model-a' },
    ])
    expect(await h.transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    expect(h.transport.getSnapshot().nativeModelAssignments).toEqual([
      { providerId: 'provider-a', model: 'model-a' },
      { providerId: 'provider-b', model: 'model-b' },
    ])
    h.transport.dispose()
    expect(h.transport.getSnapshot().nativeModelAssignments).toEqual([])
    h.dom.window.close()
  })

  it.each(['thread', 'catalog', 'models'] as const)('invalidates assignments when the %s scope changes', async kind => {
    let catalog = '/redacted/global-a.json'
    const h = await harness(() => catalog)
    expect(await h.transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    expect(await h.transport.select({ providerId: 'provider-a', model: 'model-a' })).toBe('accepted')
    expect(h.transport.getSnapshot().nativeModelAssignments).toHaveLength(2)

    if (kind === 'catalog') catalog = '/redacted/global-b.json'
    if (kind === 'models') {
      const props = (h.trigger as unknown as {
        __reactFiber$test: { return: { memoizedProps: { modelOptions: unknown[] } } }
      }).__reactFiber$test.return.memoizedProps
      props.modelOptions.splice(1, 1, { model: { model: 'model-c', displayName: 'Model C' }, disabledReason: null })
      h.dom.window.document.body.append(h.dom.window.document.createElement('aside'))
    } else exposeGlobalModels(composer(h.dom.window.document, kind === 'thread' ? 'thread-2' : 'thread-1'))
    await settle()
    expect(h.transport.getSnapshot().nativeModelAssignments).toEqual([
      { providerId: 'provider-a', model: 'model-a' },
    ])
    h.transport.dispose()
    h.dom.window.close()
  })
})
