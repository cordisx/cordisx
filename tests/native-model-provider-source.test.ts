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

async function harness(options: {
  readonly config: () => Record<string, unknown>
  readonly threadProvider?: string
}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'app://-/index.html' })
  composer(dom.window.document)
  const modelListRequests: Record<string, unknown>[] = []
  install('window', dom.window)
  install('document', dom.window.document)
  install('location', dom.window.location)
  install('codexWindowType', 'electron')
  install('electronBridge', {
    sendMessageFromView: async (envelope: { request?: Record<string, unknown> }) => {
      const request = envelope.request
      if (request === undefined) return
      const params = request.params as Record<string, unknown>
      if (request.method === 'model/list') modelListRequests.push(structuredClone(request))
      const result = request.method === 'thread/read'
        ? {
          thread: {
            id: params.threadId,
            status: { type: 'idle' },
            modelProvider: options.threadProvider ?? 'provider-a',
          },
        }
        : request.method === 'config/read'
        ? { config: options.config() }
        : request.method === 'model/list'
        ? {
          data: [{ id: 'protocol-gpt', model: 'model-a', displayName: 'GPT Official', hidden: false }],
          nextCursor: null,
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
    effective: { providerId: options.threadProvider ?? 'provider-a', model: 'model-a' },
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
      return { ...projection, status: 'accepted', effective: projection.effective! }
    }),
    submissionPrepare: vi.fn(async () => ({ status: 'pass-through' as const })),
    submissionConfirm: vi.fn(async () => ({ status: 'reject' as const, reason: 'unused' })),
    submissionCancel: vi.fn(async () => undefined),
  }
  install('__cordisxNativeSubmitHook', undefined)
  install('__cordisxNativeSubmissionAuthority', undefined)
  const transport = await CodexDesktopNativeModelProviderTransport.connect(true, {
    targetId: 'target',
    rendererGeneration: 'renderer',
  }, channel)
  if (transport === undefined) throw new Error('transport unavailable')
  const source = () =>
    transport.getSnapshot() as ReturnType<typeof transport.getSnapshot> & {
      readonly nativeModelsProviderId?: string
    }
  return { channel, dom, modelListRequests, source, transport }
}

describe('native model provider source', () => {
  it('keeps native control models for a configured global catalog without listing models', async () => {
    const { dom, modelListRequests, source, transport } = await harness({
      config: () => ({
        model_provider: 'profile-default',
        model: 'model-a',
        model_catalog_json: '/redacted/global-model-catalog.json',
        model_reasoning_effort: 'high',
      }),
    })
    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    const props = (trigger as any).__reactFiber$test.return.memoizedProps
    props.models[0].displayName = 'Friendly[Miniapp]'
    props.modelOptions = [{ model: props.models[0], disabledReason: null }]
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(source()).toMatchObject({
      modelProvider: 'provider-a',
      modelLabel: 'Friendly',
      nativeModelsScope: 'global',
      nativeModels: [{ id: 'model-a', label: 'Friendly', disabled: false, supportsFastMode: false }],
    })
    expect(source()).not.toHaveProperty('nativeModelsProviderId')
    expect(modelListRequests).toEqual([])
    props.modelOptions[0].disabledReason = 'Login required'
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(source().nativeModels).toEqual([{
      id: 'model-a',
      label: 'Friendly',
      disabled: true,
      supportsFastMode: false,
    }])
    transport.dispose()
    dom.window.close()
  })

  it('clears active-provider source identity when a global catalog becomes configured', async () => {
    let globalCatalog = false
    const { dom, modelListRequests, source, transport } = await harness({
      config: () => ({
        model_provider: 'openai',
        model: 'model-a',
        ...(globalCatalog ? { model_catalog_json: '/redacted/global-model-catalog.json' } : {}),
      }),
    })
    expect(source().nativeModelsProviderId).toBe('openai')
    expect(modelListRequests).toHaveLength(1)
    globalCatalog = true
    composer(dom.window.document, 'thread-1')
    await settle()
    expect(source().nativeModelsScope).toBe('global')
    expect(source()).not.toHaveProperty('nativeModelsProviderId')
    expect(modelListRequests).toHaveLength(1)
    transport.dispose()
    dom.window.close()
  })

  it('keeps the base provider native source through effective provider round trips', async () => {
    const { channel, dom, modelListRequests, source, transport } = await harness({
      config: () => ({ model: 'model-a', model_reasoning_effort: 'high' }),
      threadProvider: 'deepseek',
    })
    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    const props = (trigger as any).__reactFiber$test.return.memoizedProps
    props.models[0].displayName = 'Native Model A'
    props.modelOptions = [{ model: props.models[0], disabledReason: 'Login required' }]
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(source()).toMatchObject({
      modelProvider: 'deepseek',
      nativeModelsScope: 'active-provider',
      nativeModelsProviderId: 'openai',
      nativeModels: [{ id: 'model-a', label: 'GPT Official', disabled: false, supportsFastMode: false }],
    })
    expect(modelListRequests).toHaveLength(1)
    for (
      const [providerId, disabled] of [
        ['openai', true],
        ['deepseek', false],
        ['openai', true],
      ] as const
    ) {
      expect(await transport.select({ providerId, model: 'model-a' })).toBe('accepted')
      expect(source()).toMatchObject({ modelProvider: providerId, nativeModelsProviderId: 'openai' })
      expect(source().nativeModels).toEqual([{
        id: 'model-a',
        label: 'GPT Official',
        disabled,
        supportsFastMode: false,
      }])
    }
    expect(channel.selectionSelect).toHaveBeenCalledTimes(3)
    expect(modelListRequests).toHaveLength(1)
    transport.dispose()
    dom.window.close()
  })
})
