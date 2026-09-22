import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  locateNativeModelProviderSeat,
  locateNativeModelSelectionControl,
} from '../packages/cli/src/renderer/adapter/native-model-provider-seat.js'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import type {
  NativeProviderSelectionCommandChannel,
  NativeProviderSelectionProjection,
} from '../packages/cli/src/renderer/native-provider-selection-client.js'

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

function nativeRequest(view: Window, request: Record<string, unknown>): void {
  view.dispatchEvent(
    new view.CustomEvent('codex-message-from-view', {
      detail: { type: 'mcp-request', hostId: 'local', request },
    }),
  )
}

function composer(document: Document, threadId: string | null = 'thread-1', model = 'model-a', attachControl = true) {
  document.body.innerHTML = `<main data-codex-composer-root data-composer-placement="${threadId ? 'thread' : 'home'}">
    ${threadId ? `<i data-above-composer-conversation-id="${threadId}"></i>` : ''}
    <footer data-composer-footer-responsive>
      <span><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span>
    </footer>
  </main>`
  const elements = [...document.querySelectorAll<HTMLElement>('*')]
  for (const element of elements) {
    element.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 20,
      bottom: 20,
      width: 20,
      height: 20,
      toJSON: () => ({}),
    })
  }
  const trigger = document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
  const selectModel = vi.fn(async (nextModel: string, nextEffort: string) => {
    const fiber = (trigger as any).__reactFiber$test
    if (fiber) {
      fiber.return.memoizedProps.model = nextModel
      fiber.return.memoizedProps.reasoningEffort = nextEffort
    }
  })
  const attachNativeControl = () => {
    Object.defineProperty(trigger, '__reactFiber$test', {
      configurable: true,
      value: {
        memoizedProps: {},
        return: {
          memoizedProps: {
            model: 'model-a',
            reasoningEffort: 'high',
            models: [{
              model,
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'high' },
              ],
            }],
            modelOptions: [{ model: { model: 'model-a' }, disabledReason: null }],
            powerSelections: [
              { model: 'model-a', reasoningEffort: 'low' },
              { model: 'model-a', reasoningEffort: 'high' },
            ],
            menuView: 'simple',
            open: false,
            showReasoningEffortControls: true,
            onSelectModelOption: () => {},
            onToggleMenuView: () => {},
            onSelectModel: selectModel,
            onSelectReasoningEffort: () => {},
          },
        },
      },
    })
  }
  if (attachControl) attachNativeControl()
  return { attachNativeControl, selectModel, trigger }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitForRequest(
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

async function harness(handler?: (request: Record<string, unknown>, view: Window) => boolean | void) {
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
      requests.push(structuredClone(envelope.request))
      if (handler?.(envelope.request, dom.window)) return
      const params = envelope.request.params as Record<string, unknown>
      const result = envelope.request.method === 'thread/read'
        ? { thread: { id: params.threadId, status: { type: 'idle' }, modelProvider: 'provider-a' } }
        : envelope.request.method === 'config/read'
        ? { config: { model_provider: 'provider-a', model: 'model-a', model_reasoning_effort: 'high' } }
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
  const transport = await CodexDesktopNativeModelProviderTransport.connect(true, {
    targetId: 'target',
    rendererGeneration: 'renderer',
  }, channel)
  if (transport === undefined) throw new Error('transport unavailable')
  return { ...control, dom, requests, transport, channel }
}

describe('native model provider transport', () => {
  it.each(['thread/read', 'config/read'])(
    'does not restart an in-flight %s for unrelated startup DOM mutations',
    async method => {
      let hold = false
      const pending: { request: Record<string, unknown>; view: Window }[] = []
      const h = await harness((request, view) => {
        if (!hold || request.method !== method) return
        pending.push({ request, view })
        return true
      })
      try {
        hold = true
        composer(h.dom.window.document, 'thread-2')
        await settle()
        expect(pending.length).toBe(1)
        for (let index = 0; index < 5; index++) {
          h.dom.window.document.body.append(h.dom.window.document.createElement('aside'))
          await settle()
        }
        expect(pending.length).toBe(1)
        const first = pending[0]!
        message(first.view, {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: first.request.id,
            result: {
              thread: { id: 'thread-2', status: { type: 'idle' }, modelProvider: 'provider-a' },
              config: { model_provider: 'provider-a', model: 'model-a' },
            },
          },
        })
        await settle()
        expect(h.transport.getSnapshot()).toMatchObject({ available: true, threadId: 'thread-2' })
      } finally {
        h.transport.dispose()
        h.dom.window.close()
      }
    },
  )

  it.each(['thread', 'trigger', 'model'] as const)(
    'supersedes a pending read when the native %s changes',
    async kind => {
      let hold = false
      const pending: Record<string, unknown>[] = []
      const h = await harness(request => {
        if (!hold || request.method !== 'thread/read') return
        pending.push(request)
        return true
      })
      const respond = (request: Record<string, unknown>) =>
        message(h.dom.window, {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: request.id,
            result: {
              thread: { id: (request.params as any).threadId, status: { type: 'idle' }, modelProvider: 'provider-a' },
            },
          },
        })
      try {
        hold = true
        const next = composer(h.dom.window.document, 'thread-2')
        await settle()
        if (kind === 'thread') composer(h.dom.window.document, 'thread-3')
        else if (kind === 'trigger') composer(h.dom.window.document, 'thread-2')
        else {
          ;(next.trigger as any).__reactFiber$test.return.memoizedProps.model = 'model-b'
          h.dom.window.document.body.append(h.dom.window.document.createElement('aside'))
        }
        await settle()
        expect(pending.length).toBe(2)
        const configReads = h.requests.filter(request => request.method === 'config/read').length
        respond(pending[0]!)
        await settle()
        expect(h.transport.getSnapshot().available).toBe(false)
        expect(h.requests.filter(request => request.method === 'config/read').length).toBe(configReads)
        h.dom.window.document.body.append(h.dom.window.document.createElement('aside'))
        await settle()
        expect(pending.length).toBe(2)
        respond(pending[1]!)
        await settle()
        expect(h.transport.getSnapshot()).toMatchObject({
          available: true,
          threadId: kind === 'thread' ? 'thread-3' : 'thread-2',
          model: kind === 'model' ? 'model-b' : 'model-a',
        })
      } finally {
        h.transport.dispose()
        h.dom.window.close()
      }
    },
  )

  it.each(['failure', 'dispose'] as const)('releases pending read ownership on %s', async outcome => {
    let hold = false
    let pending: Record<string, unknown> | undefined
    const h = await harness(request => {
      if (!hold || request.method !== 'config/read') return
      pending = request
      return true
    })
    try {
      hold = true
      composer(h.dom.window.document, 'thread-2')
      await settle()
      expect(pending?.method).toBe('config/read')
      const changed = vi.fn()
      h.transport.subscribe(changed)
      if (outcome === 'dispose') h.transport.dispose()
      message(h.dom.window, {
        type: 'mcp-response',
        hostId: 'local',
        message: { id: pending!.id, error: { message: 'offline' } },
      })
      await settle()
      const requests = h.requests.length
      hold = false
      h.dom.window.document.body.append(h.dom.window.document.createElement('aside'))
      await settle()
      if (outcome === 'dispose') {
        expect(h.requests.length).toBe(requests)
        expect(changed).not.toHaveBeenCalled()
      } else {
        expect(h.requests.length).toBe(requests + 2)
        expect(h.transport.getSnapshot()).toMatchObject({ available: true, threadId: 'thread-2' })
      }
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it('connects through launcher capability without Desktop identity metadata', async () => {
    const h = await harness()
    expect(h.transport.getSnapshot().available).toBe(true)
    h.transport.dispose()
    h.dom.window.close()
  })
  it('treats an exact systemError status as terminal for ordinary Send recovery', async () => {
    const h = await harness((request, view) => {
      if (request.method !== 'thread/read') return
      queueMicrotask(() =>
        message(view, {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: request.id,
            result: { thread: { id: 'thread-1', modelProvider: 'provider-a', status: { type: 'systemError' } } },
          },
        })
      )
      return true
    })
    expect(h.transport.getSnapshot()).toMatchObject({ available: true, busy: false })
    message(h.dom.window, {
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'turn/started',
        params: { threadId: 'thread-1' },
      },
    })
    message(h.dom.window, {
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'thread/status/changed',
        params: { threadId: 'thread-1', status: { type: 'systemError' } },
      },
    })
    await settle()
    expect(h.transport.getSnapshot()).toMatchObject({ available: true, busy: false })
    h.transport.dispose()
    h.dom.window.close()
  })
  it('recovers controls when native Send removes inert without replacing the composer', async () => {
    const { dom, transport } = await harness()
    const root = dom.window.document.querySelector('[data-codex-composer-root]')!
    root.setAttribute('inert', '')
    await settle()
    expect(transport.getSnapshot().available).toBe(false)
    root.removeAttribute('inert')
    await settle()
    expect(transport.getSnapshot()).toMatchObject({ available: true, busy: false })
    transport.dispose()
    dom.window.close()
  })

  it('synchronizes the authoritative model after the first managed turn completes', async () => {
    const { dom, transport, channel, selectModel } = await harness()
    channel.selectionRead.mockResolvedValueOnce({
      available: true,
      revision: 10,
      effective: { providerId: 'provider-b', model: 'model-b' },
    })
    message(dom.window, {
      type: 'mcp-notification',
      hostId: 'local',
      message: { method: 'turn/completed', params: { threadId: 'thread-1' } },
    })
    await settle()
    expect(selectModel).toHaveBeenCalledWith('model-b', 'high')
    expect(transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-b', model: 'model-b' })
    transport.dispose()
    dom.window.close()
  })

  it('does not connect or invoke native persistence when managed routing is unavailable', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'app://-/index.html' })
    const { selectModel } = composer(dom.window.document)
    const sendMessageFromView = vi.fn(async () => {})
    install('window', dom.window)
    install('document', dom.window.document)
    install('location', dom.window.location)
    install('codexWindowType', 'electron')
    install('electronBridge', {
      sendMessageFromView,
    })

    expect(await CodexDesktopNativeModelProviderTransport.connect()).toBeUndefined()
    expect(await CodexDesktopNativeModelProviderTransport.connect(false)).toBeUndefined()
    expect(sendMessageFromView).not.toHaveBeenCalled()
    expect(selectModel).not.toHaveBeenCalled()
    dom.window.close()
  })

  it('keeps overlapping terminal refreshes fenced until the native optimistic update completes', async () => {
    const { dom, transport, channel, selectModel, trigger } = await harness()
    let finish!: () => void
    const completion = new Promise<void>(resolve => {
      finish = resolve
    })
    selectModel.mockImplementationOnce(async (model, effort) => {
      const props = (trigger as any).__reactFiber$test.return.memoizedProps
      props.model = model
      props.reasoningEffort = effort
      await completion
    })
    channel.selectionRead.mockResolvedValue({
      available: true,
      revision: 10,
      effective: { providerId: 'provider-b', model: 'model-b' },
    })
    const terminal = () =>
      message(dom.window, {
        type: 'mcp-notification',
        hostId: 'local',
        message: { method: 'turn/completed', params: { threadId: 'thread-1' } },
      })
    terminal()
    await settle()
    terminal()
    await settle()
    expect((globalThis as any).__cordisxNativeSubmissionAuthority.snapshot().idle).toBe(false)
    const hook = (globalThis as any).__cordisxNativeSubmitHook
    const action = {
      target: 'local',
      thread: 'thread-1',
      response: false,
      followUp: 'local',
      followUpThread: 'thread-1',
      defaultAction: 'steer',
      promptOverride: false,
    }
    await expect(hook(action)).resolves.toEqual({ allow: false })
    expect(channel.submissionPrepare).not.toHaveBeenCalled()
    expect(selectModel).toHaveBeenCalledTimes(1)
    finish()
    await settle()
    expect((globalThis as any).__cordisxNativeSubmissionAuthority.snapshot().idle).toBe(true)
    channel.submissionPrepare.mockResolvedValueOnce({ status: 'pass-through' })
    await expect(hook(action)).resolves.toEqual({ allow: true })
    expect(transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-b', model: 'model-b' })
    transport.dispose()
    dom.window.close()
  })

  it('commits an existing-thread provider immediately and synchronizes the native model control', async () => {
    const { dom, requests, selectModel, transport, channel } = await harness()
    expect(await transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    expect(requests.map(request => request.method)).toEqual(['thread/read', 'config/read'])
    expect(selectModel).toHaveBeenCalledWith('model-b', 'high')
    expect(channel.submissionPrepare).not.toHaveBeenCalled()
    expect(transport.getSnapshot()).toMatchObject({
      modelProvider: 'provider-b',
      model: 'model-b',
    })
    expect(transport.getSnapshot().pendingProviderId).toBeUndefined()
    transport.dispose()
    dom.window.close()
  })

  it('rejects provider selection while busy before native effects', async () => {
    const { dom, requests, selectModel, transport, channel } = await harness()
    message(dom.window, {
      type: 'mcp-notification',
      hostId: 'local',
      message: { method: 'turn/started', params: { threadId: 'thread-1' } },
    })
    expect(await transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('busy')
    expect(channel.selectionSelect).not.toHaveBeenCalled()
    expect(selectModel).not.toHaveBeenCalled()
    expect(requests.map(request => request.method)).toEqual(['thread/read', 'config/read'])
    expect(transport.getSnapshot()).toMatchObject({ busy: true, modelProvider: 'provider-a', model: 'model-a' })
    transport.dispose()
    dom.window.close()
  })

  it('clears busy from authoritative thread status when completion is not forwarded', async () => {
    let status = 'active'
    const { dom, requests, transport } = await harness((request, view) => {
      if (request.method !== 'thread/read') return
      const params = request.params as Record<string, unknown>
      queueMicrotask(() =>
        message(view, {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: request.id,
            result: { thread: { id: params.threadId, status: { type: status }, modelProvider: 'provider-a' } },
          },
        })
      )
      return true
    })
    nativeRequest(dom.window, {
      id: 'native-turn',
      method: 'turn/start',
      params: { threadId: 'thread-1', model: 'model-a' },
    })
    expect(transport.getSnapshot()).toMatchObject({ available: true, busy: true })

    await new Promise(resolve => setTimeout(resolve, 525))
    await settle()
    expect(transport.getSnapshot()).toMatchObject({ available: true, busy: true })

    status = 'idle'
    await new Promise(resolve => setTimeout(resolve, 525))
    await settle()
    expect(transport.getSnapshot()).toMatchObject({ available: true, busy: false })
    expect(requests.filter(request => request.method === 'thread/read')).toHaveLength(3)
    transport.dispose()
    dom.window.close()
  })

  it('preserves draft defaults and reasoning until ordinary Send', async () => {
    const { dom, requests, transport } = await harness()
    const fresh = composer(dom.window.document, null)
    await settle()
    expect(await transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    expect(fresh.selectModel).not.toHaveBeenCalled()
    expect(requests.some(request => request.method === 'config/batchWrite')).toBe(false)
    expect(transport.getSnapshot()).toMatchObject({
      modelProvider: 'provider-a',
      model: 'model-a',
      pendingProviderId: 'provider-b',
      reasoningEffort: 'high',
    })
    transport.dispose()
    dom.window.close()
  })

  it('projects a guarded launcher preference into a new draft selection', async () => {
    const { channel, dom, transport } = await harness()
    channel.selectionRead.mockResolvedValueOnce({
      available: true,
      revision: 10,
      effective: { providerId: 'provider-a', model: 'model-a' },
      draftPreference: { providerId: 'provider-b', generation: 4 },
    })
    composer(dom.window.document, null)
    await settle()
    expect(transport.getSnapshot()).toMatchObject({
      modelProvider: 'provider-a',
      model: 'model-a',
      draftPreference: { providerId: 'provider-b', generation: 4, revision: 10 },
    })
    await transport.select(
      { providerId: 'provider-b', model: 'model-b' },
      { source: 'preference', expectedRevision: 10 },
    )
    expect(channel.selectionSelect).toHaveBeenLastCalledWith(expect.objectContaining({
      providerId: 'provider-b',
      model: 'model-b',
      source: 'preference',
      expectedRevision: 10,
    }))
    transport.dispose()
    dom.window.close()
  })

  it('uses the native callback without unsubscribe for a model change inside one provider', async () => {
    const { dom, requests, selectModel, transport } = await harness()
    expect(await transport.select({ providerId: 'provider-a', model: 'model-b' })).toBe('accepted')
    expect(selectModel).toHaveBeenCalledWith('model-b', 'high')
    expect(requests.map(request => request.method)).toEqual(['thread/read', 'config/read'])
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'model-b' })
    transport.dispose()
    dom.window.close()
  })

  it('restores the native model and effort when a same-provider callback mutates then rejects', async () => {
    const { dom, selectModel, transport } = await harness()
    selectModel
      .mockRejectedValueOnce(new Error('native callback failed after mutation'))
      .mockResolvedValueOnce(undefined)
    expect(await transport.select({ providerId: 'provider-a', model: 'model-b' })).toBe('unavailable')
    expect(selectModel.mock.calls).toEqual([
      ['model-b', 'high'],
      ['model-a', 'high'],
    ])
    expect(transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'model-a' })
    transport.dispose()
    dom.window.close()
  })

  it('changes reasoning effort through the native model callback while preserving the model', async () => {
    const { dom, requests, selectModel, transport } = await harness()
    expect(transport.getSnapshot()).toMatchObject({
      reasoningEffort: 'high',
      reasoningEfforts: ['low', 'high'],
    })
    expect(await transport.selectReasoningEffort('low')).toBe('accepted')
    expect(selectModel).toHaveBeenCalledWith('model-a', 'low')
    expect(requests.map(request => request.method)).toEqual(['thread/read', 'config/read'])
    expect(transport.getSnapshot()).toMatchObject({ model: 'model-a', reasoningEffort: 'low' })
    expect(await transport.selectReasoningEffort('unsupported')).toBe('unavailable')
    transport.dispose()
    dom.window.close()
  })

  it('updates Fast mode through thread settings and publishes the effective service tier', async () => {
    const { dom, requests, transport, trigger } = await harness((request, view) => {
      if (request.method !== 'thread/settings/update') return
      queueMicrotask(() =>
        message(view, {
          type: 'mcp-response',
          hostId: 'local',
          message: { id: request.id, result: {} },
        })
      )
      return true
    })
    const props = (trigger as any).__reactFiber$test.return.memoizedProps
    props.models[0].displayName = 'Model A'
    props.models[0].additionalSpeedTiers = ['fast']
    props.models[0].serviceTiers = [{ id: 'priority', name: 'Fast' }]
    props.modelOptions[0].model = props.models[0]
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(await transport.selectFastMode(true)).toBe('accepted')
    expect(requests.at(-1)).toMatchObject({
      method: 'thread/settings/update',
      params: { threadId: 'thread-1', serviceTier: 'priority' },
    })
    expect(transport.getSnapshot().serviceTier).toBe('priority')
    expect((globalThis as any).__cordisxNativeServiceTierOverride).toBe('priority')
    props.selectedServiceTier = null
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(transport.getSnapshot().serviceTier).toBe('priority')
    expect((globalThis as any).__cordisxNativeServiceTierOverride).toBe('priority')
    transport.dispose()
    dom.window.close()
  })

  it('restores the native reasoning effort when its callback mutates then rejects', async () => {
    const { dom, selectModel, transport } = await harness()
    selectModel
      .mockRejectedValueOnce(new Error('native effort callback failed after mutation'))
      .mockResolvedValueOnce(undefined)
    expect(await transport.selectReasoningEffort('low')).toBe('unavailable')
    expect(selectModel.mock.calls).toEqual([
      ['model-a', 'low'],
      ['model-a', 'high'],
    ])
    expect(transport.getSnapshot()).toMatchObject({
      available: true,
      model: 'model-a',
      reasoningEffort: 'high',
      error: 'native effort callback failed after mutation',
    })
    transport.dispose()
    dom.window.close()
  })

  it('keeps availability and the switched provider through unrelated native mutations', async () => {
    const { dom, requests, transport } = await harness((request, view) => {
      const params = request.params as Record<string, unknown>
      if (request.method !== 'thread/resume') return
      queueMicrotask(() =>
        message(view, {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: request.id,
            result: { thread: { id: params.threadId }, modelProvider: params.modelProvider, model: params.model },
          },
        })
      )
      return true
    })
    expect(await transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    const count = requests.length
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(requests).toHaveLength(count)
    expect(transport.getSnapshot()).toMatchObject({
      available: true,
      threadId: 'thread-1',
      modelProvider: 'provider-b',
      model: 'model-b',
    })
    expect(transport.getSnapshot().pendingProviderId).toBeUndefined()
    transport.dispose()
    dom.window.close()
  })

  it('refreshes native labels and disabled catalog entries without changing the selected model', async () => {
    const { dom, transport } = await harness()
    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    const props = (trigger as any).__reactFiber$test.return.memoizedProps
    props.models[0].displayName = 'Friendly[Miniapp]'
    props.modelOptions = [{ model: props.models[0], disabledReason: null }]
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(transport.getSnapshot().modelLabel).toBe('Friendly')
    expect(transport.getSnapshot().nativeModels).toEqual([{
      id: 'model-a',
      label: 'Friendly',
      disabled: false,
      supportsFastMode: false,
    }])
    props.modelOptions[0].disabledReason = 'Login required'
    dom.window.document.body.append(dom.window.document.createElement('aside'))
    await settle()
    expect(transport.getSnapshot().nativeModels).toEqual([{
      id: 'model-a',
      label: 'Friendly',
      disabled: true,
      supportsFastMode: false,
    }])
    transport.dispose()
    dom.window.close()
  })

  it('recovers when the native React control attaches after the thread composer DOM', async () => {
    const { dom, requests, transport, channel } = await harness()
    const delayed = composer(dom.window.document, 'thread-2', 'model-a', false)
    await settle()
    expect(transport.getSnapshot()).toMatchObject({ available: false, busy: true })
    const requestCount = requests.length

    delayed.attachNativeControl()
    await new Promise(resolve => setTimeout(resolve, 75))
    await settle()

    expect(requests.slice(requestCount).map(request => request.method)).toEqual(['thread/read', 'config/read'])
    expect(transport.getSnapshot()).toMatchObject({
      available: true,
      busy: false,
      threadId: 'thread-2',
      modelProvider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
    expect(await transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    expect(channel.selectionSelect).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ threadId: 'thread-2' }),
    }))
    expect(transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-b', model: 'model-b' })
    expect(transport.getSnapshot().pendingProviderId).toBeUndefined()
    transport.dispose()
    dom.window.close()
  })

  it('fences navigation while the same-provider native callback is pending', async () => {
    let release!: () => void
    const callback = new Promise<void>(resolve => {
      release = resolve
    })
    const { dom, transport } = await harness((request, view) => {
      const params = request.params as Record<string, unknown>
      if (request.method !== 'thread/resume') return
      queueMicrotask(() =>
        message(view, {
          type: 'mcp-response',
          hostId: 'local',
          message: {
            id: request.id,
            result: { thread: { id: params.threadId }, modelProvider: params.modelProvider, model: params.model },
          },
        })
      )
      return true
    })
    const trigger = dom.window.document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
    const fiber = (trigger as unknown as Record<string, unknown>)['__reactFiber$test'] as {
      return: { memoizedProps: { onSelectModel: ReturnType<typeof vi.fn> } }
    }
    fiber.return.memoizedProps.onSelectModel.mockImplementation(async () => await callback)
    const selecting = transport.select({ providerId: 'provider-a', model: 'model-b' })
    await settle()
    composer(dom.window.document, 'thread-2')
    await settle()
    release()
    expect(await selecting).toBe('unavailable')
    await settle()
    expect(transport.getSnapshot()).toMatchObject({ threadId: 'thread-2', modelProvider: 'provider-a' })
    transport.dispose()
    dom.window.close()
  })

  it('fences navigation while immediate selection acknowledgement is delayed', async () => {
    const { dom, requests, transport, channel } = await harness()
    let resolve!: (value: any) => void
    channel.selectionSelect.mockImplementationOnce(() =>
      new Promise(done => {
        resolve = done
      })
    )
    const selecting = transport.select({ providerId: 'provider-b', model: 'model-b' })
    await settle()
    composer(dom.window.document, 'thread-2')
    await settle()
    resolve({
      status: 'accepted',
      revision: 100,
      effective: { providerId: 'provider-b', model: 'model-b' },
    })
    expect(await selecting).toBe('unavailable')
    expect(transport.getSnapshot()).toMatchObject({ threadId: 'thread-2', modelProvider: 'provider-a' })
    expect(transport.getSnapshot()).not.toHaveProperty('pendingProviderId')
    expect(requests.some(request => request.method === 'thread/resume' || request.method === 'config/batchWrite')).toBe(
      false,
    )
    transport.dispose()
    dom.window.close()
  })

  it('ignores background native responses and clears state on navigation', async () => {
    const { dom, transport } = await harness()
    nativeRequest(dom.window, {
      id: 'background-resume',
      method: 'thread/resume',
      params: { threadId: 'thread-2', modelProvider: 'provider-z', model: 'model-z' },
    })
    message(dom.window, {
      type: 'mcp-response',
      hostId: 'local',
      message: {
        id: 'background-resume',
        result: { thread: { id: 'thread-2' }, modelProvider: 'provider-z', model: 'model-z' },
      },
    })
    expect(transport.getSnapshot()).toMatchObject({ threadId: 'thread-1', modelProvider: 'provider-a' })
    composer(dom.window.document, null)
    await settle()
    expect(transport.getSnapshot()).not.toHaveProperty('threadId')
    expect(transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'model-a', busy: false })
    transport.dispose()
    dom.window.close()
  })
})

describe('native model provider seat', () => {
  it('locates only the unique visible native intelligence trigger in the composer footer', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="thread">
        <footer data-composer-footer-responsive>
          <span id="seat"><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span>
          <button data-codex-intelligence-trigger="true">Unrelated</button>
        </footer>
      </main>
    </body>`)
    const elements = [...dom.window.document.querySelectorAll<HTMLElement>('*')]
    for (const element of elements) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      })
    }
    expect(locateNativeModelProviderSeat(dom.window.document)).toEqual({
      trigger: dom.window.document.querySelector('button[aria-haspopup]'),
      group: dom.window.document.getElementById('seat'),
      parent: dom.window.document.querySelector('footer'),
    })
    dom.window.close()
  })

  it('reads supported reasoning efforts from the audited native owner', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const { trigger } = composer(dom.window.document)
    expect(locateNativeModelSelectionControl(trigger)).toMatchObject({
      model: 'model-a',
      reasoningEffort: 'high',
      reasoningEfforts: ['low', 'high'],
    })
    dom.window.close()
  })

  it('fails closed for the superseded build-7119 owner shape', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const { trigger } = composer(dom.window.document)
    const fiber = (trigger as unknown as Record<string, unknown>)['__reactFiber$test'] as {
      return: { memoizedProps: Record<string, unknown> }
    }
    delete fiber.return.memoizedProps.modelOptions
    delete fiber.return.memoizedProps.powerSelections
    delete fiber.return.memoizedProps.menuView
    delete fiber.return.memoizedProps.open
    delete fiber.return.memoizedProps.onSelectModelOption
    delete fiber.return.memoizedProps.onToggleMenuView
    expect(locateNativeModelSelectionControl(trigger)).toBeUndefined()
    dom.window.close()
  })

  it('fails closed for ambiguous triggers', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="thread">
        <footer data-composer-footer-responsive>
          <button data-codex-intelligence-trigger="true" aria-haspopup="menu">One</button>
          <button data-codex-intelligence-trigger="true" aria-haspopup="menu">Two</button>
        </footer>
      </main>
    </body>`)
    for (const element of dom.window.document.querySelectorAll<HTMLElement>('*')) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      })
    }
    expect(locateNativeModelProviderSeat(dom.window.document)).toBeUndefined()
    dom.window.close()
  })

  it('rediscovers the trigger hidden by the owning selector', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' })
    const { trigger } = composer(dom.window.document)
    trigger.hidden = true
    trigger.dataset.cordisxModelProviderHidden = 'true'
    expect(locateNativeModelProviderSeat(dom.window.document)?.trigger).toBe(trigger)
    dom.window.close()
  })
})
