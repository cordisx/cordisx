import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { installModelProviderSelector } from '../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import { attachNativeCreatedRoute, attachNativeCreation } from './fixtures/native-composer-creation.js'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, install, message, settle } from './fixtures/native-model-provider-transport-harness.js'

// Previous refresh fixtures reused one transport across different Composer roots.
// Production installation disposes that transport and creates a new owner.
it('hands an admitted selection through fresh pending and settled Composers without a draft preference', async () => {
  const h = await harness()
  h.transport.dispose()
  for (const name of ['HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    install(name, Reflect.get(h.dom.window, name))
  }
  install('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(h.dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  const registry = new ModelProviderRegistry(async () => [{
    providerId: 'provider-b',
    pluginId: 'test-provider',
    title: 'Chosen provider',
    models: [{ id: 'model-b', label: 'Chosen model', reasoningCapabilities: { efforts: ['low', 'high'] } }],
  }])
  registry.connectSource(() => () => {})
  const originalConnect = CodexDesktopNativeModelProviderTransport.connect
  const transports: CodexDesktopNativeModelProviderTransport[] = []
  vi.spyOn(CodexDesktopNativeModelProviderTransport, 'connect').mockImplementation(async (...args) => {
    const transport = await originalConnect(...args)
    if (transport) transports.push(transport)
    return transport
  })
  let draftSelected = false
  let releaseBinding: (() => void) | undefined
  let delayCreatedBinding = true
  h.channel.selectionRead.mockImplementation(async ({ scope, effective }) => {
    if (scope.threadId === 'created' && delayCreatedBinding) {
      await new Promise<void>(resolve => {
        releaseBinding = resolve
      })
    }
    if (scope.threadId === undefined && effective === undefined) return { available: false, revision: 1 }
    return {
      available: true,
      revision: 100,
      effective: scope.threadId === 'created' || draftSelected
        ? { providerId: 'provider-b', model: 'model-b' }
        : effective,
    }
  })
  h.channel.selectionSelect.mockImplementation(async () => {
    draftSelected = true
    return {
      status: 'accepted',
      available: true,
      revision: 101,
      effective: { providerId: 'provider-a', model: 'model-a' },
      pending: { providerId: 'provider-b', model: 'model-b', generation: 1 },
    }
  })
  h.channel.submissionPrepare.mockResolvedValue({
    status: 'allow-original',
    operationToken: 'creation-operation-token',
  })
  let dispose = () => {}
  try {
    await act(async () => {
      composer(h.dom.window.document, null)
      dispose = await installModelProviderSelector(h.dom.window.document, registry, () => 'en', true, {
        targetId: 'target',
        rendererGeneration: 'renderer',
      }, h.channel)
      await settle()
    })
    const draftTransport = transports[0]!
    await act(async () => {
      expect(await draftTransport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
      expect(await draftTransport.selectReasoningEffort('low')).toBe('accepted')
      const result = await (globalThis as any).__cordisxNativeSubmitHook({
        target: 'worktree',
        response: false,
        promptOverride: false,
      })
      expect(result).toMatchObject({ allow: true, operationToken: 'creation-operation-token', reasoningEffort: 'low' })
    })
    const preparedCount = h.channel.submissionPrepare.mock.calls.length
    const selectedCount = h.channel.selectionSelect.mock.calls.length
    h.channel.selectionRead.mockClear()
    const clientThreadId = 'client-new-thread:created-worktree'
    let pendingRoot: HTMLElement
    await act(async () => {
      const pending = composer(h.dom.window.document, null)
      pendingRoot = pending.trigger.closest<HTMLElement>('[data-codex-composer-root]')!
      pendingRoot.dataset.composerPlacement = 'thread'
      const shell = attachNativeCreation(pendingRoot, { clientThreadId })
      shell.owner.memoizedProps.pendingClientThreadId = null as never
      shell.owner.child.sibling = null as never
      await settle()
    })
    expect(transports).toHaveLength(2)
    expect(h.dom.window.document.querySelector('.cxmp-selector')).toBeNull()
    expect(pendingRoot!.querySelector('[data-cordisx-model-provider-hidden="true"]')).toBeNull()
    await act(async () => {
      attachNativeCreation(pendingRoot!, {
        clientThreadId,
        operationToken: 'creation-operation-token',
      })
      pendingRoot!.append(h.dom.window.document.createElement('span'))
      await settle()
    })
    expect(transports).toHaveLength(2)
    const pendingTransport = transports[1]!
    expect(pendingTransport).not.toBe(draftTransport)
    expect(pendingTransport.getSnapshot()).toMatchObject({
      available: false,
      busy: true,
      pendingCreation: { clientThreadId, model: 'model-b', reasoningEffort: 'low' },
      creationDisplay: { clientThreadId, providerId: 'provider-b', model: 'model-b', reasoningEffort: 'low' },
    })
    expect(pendingTransport.getSnapshot().draftPreference).toBeUndefined()
    expect(pendingTransport.getSnapshot().modelProvider).toBeUndefined()
    expect(pendingTransport.getSnapshot().model).toBeUndefined()
    expect(h.dom.window.document.querySelector('.cxmp-model-label')?.textContent).toBe('Chosen model')
    expect(h.dom.window.document.querySelector('.cxmp-effort-label')?.textContent).toBe('Light')
    expect(h.dom.window.document.querySelector<HTMLButtonElement>('.cxmp-model-trigger')?.disabled).toBe(true)
    expect(await pendingTransport.selectReasoningEffort('high')).toBe('unavailable')
    expect(h.channel.selectionSelect).toHaveBeenCalledTimes(selectedCount)
    expect(h.channel.submissionPrepare).toHaveBeenCalledTimes(preparedCount)
    expect(h.channel.selectionRead.mock.calls.some(([input]) => input.effective?.model === 'model-b')).toBe(false)
    await act(async () => {
      const completed = composer(h.dom.window.document, 'created')
      const props = (completed.trigger as any).__reactFiber$test.return.memoizedProps
      props.model = 'model-b'
      props.reasoningEffort = 'low'
      attachNativeCreatedRoute(
        completed.trigger.closest<HTMLElement>('[data-codex-composer-root]')!,
        clientThreadId,
        'created',
      )
      await settle()
      await settle()
    })
    expect(transports).toHaveLength(3)
    expect(transports[2]!.getSnapshot()).toMatchObject({
      available: false,
      threadId: 'created',
      creationDisplay: { model: 'model-b', reasoningEffort: 'low', providerId: 'provider-b' },
    })
    expect(h.dom.window.document.querySelector('.cxmp-model-label')?.textContent).toBe('Chosen model')
    expect(h.dom.window.document.querySelector('.cxmp-effort-label')?.textContent).toBe('Light')
    expect(h.dom.window.document.querySelector<HTMLButtonElement>('.cxmp-model-trigger')?.disabled).toBe(true)
    expect(h.dom.window.document.querySelector('.cxmp-selector')?.getAttribute('data-cordisx-model-send-eligible'))
      .toBe('false')
    await act(async () => {
      delayCreatedBinding = false
      releaseBinding?.()
      await settle()
      await settle()
    })
    expect(transports[2]!.getSnapshot()).toMatchObject({
      available: true,
      threadId: 'created',
      modelProvider: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'low',
      creationDisplay: { providerId: 'provider-b', model: 'model-b', reasoningEffort: 'low', serviceTier: null },
    })
    expect(transports[2]!.getSnapshot().serviceTier).toBeUndefined()
    expect(h.dom.window.document.querySelector<HTMLButtonElement>('.cxmp-model-trigger')?.disabled).toBe(false)
    expect(h.dom.window.document.querySelector<HTMLButtonElement>('.cxmp-provider-trigger')?.disabled).toBe(false)
    expect(h.dom.window.document.querySelector('.cxmp-selector')?.getAttribute('data-cordisx-model-send-eligible'))
      .toBe('true')
    await act(async () => {
      message(h.dom.window, {
        type: 'mcp-notification',
        hostId: 'local',
        message: {
          method: 'thread/settings/updated',
          params: { threadId: 'created', settings: { serviceTier: null } },
        },
      })
      await settle()
      await settle()
    })
    expect(transports[2]!.getSnapshot().pendingCreation).toBeUndefined()
    expect(transports[2]!.getSnapshot().creationDisplay).toBeUndefined()
    expect(h.dom.window.document.querySelector('.cxmp-model-label')?.textContent).toBe('Chosen model')
    expect(h.dom.window.document.querySelector('.cxmp-effort-label')?.textContent).toBe('Light')
    expect(h.dom.window.document.querySelectorAll('.cxmp-selector')).toHaveLength(1)
  } finally {
    await act(async () => dispose())
    registry.dispose()
    h.dom.window.close()
  }
})

it('clears a pending creation on the same Composer after cancellation', async () => {
  const h = await harness()
  try {
    const fresh = composer(h.dom.window.document, null)
    const root = fresh.trigger.closest<HTMLElement>('[data-codex-composer-root]')!
    const creation = attachNativeCreation(root)
    h.channel.selectionRead.mockResolvedValue({
      available: true,
      revision: 100,
      draftPreference: { providerId: 'provider-b', generation: 1 },
    })
    await settle()
    expect(h.transport.getSnapshot().pendingCreation?.model).toBe('model-b')
    creation.owner.memoizedProps.pendingClientThreadId = ''
    root.append(h.dom.window.document.createElement('span'))
    await settle()
    expect(h.transport.getSnapshot().pendingCreation).toBeUndefined()
    expect(h.transport.getSnapshot().model).not.toBe('model-b')
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})
