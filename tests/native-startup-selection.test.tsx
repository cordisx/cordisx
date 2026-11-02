// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'
import { composer } from './fixtures/native-model-provider-composer.js'
import { installModelProviderSelector } from '../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { readNativeStartupReadiness } from '../packages/cli/src/renderer/adapter/startup-readiness.js'
import { startupObserver } from './helpers/startup-model-fixture.js'

const send = { target: 'local', thread: 'thread-1', response: false, promptOverride: false }
const page = globalThis as any

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function setup(failedRead = false) {
  const h = await harness({ realController: true, catalog: () => [] })
  h.setLive({ ...h.draft, navigationGeneration: 0, threadId: 'thread-1' })
  composer(document)
  const editor = document.createElement('textarea')
  document.body.append(editor)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 20, height: 20 } as DOMRect)
  vi.stubGlobal('location', { href: 'app://-/index.html' })
  vi.stubGlobal('codexWindowType', 'electron')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const requests: Record<string, any>[] = []
  let first: Record<string, any> | undefined
  const reply = (request: Record<string, any>, result: unknown) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'mcp-response', hostId: 'local', message: { id: request.id, result } },
        source: window,
      }),
    )
  vi.stubGlobal('electronBridge', {
    sendMessageFromView({ request }: { request: Record<string, any> }) {
      requests.push(request)
      if (request.method === 'thread/read' && !first) {
        first = request
        return
      }
      queueMicrotask(() =>
        reply(
          request,
          request.method === 'config/read'
            ? { config: { model_provider: 'openai', model: 'model-a' } }
            : { data: [], nextCursor: null },
        )
      )
    },
  })
  const registry = new ModelProviderRegistry(async () => [])
  registry.connectStartup(startupObserver().observer)
  const channel = failedRead
    ? {
      ...h.channel,
      selectionRead: async () => {
        throw new Error('read unavailable')
      },
    }
    : h.channel
  let dispose!: () => void
  await act(async () => {
    dispose = await installModelProviderSelector(
      document,
      registry,
      () => 'en',
      true,
      h.world.__cordisxNativeProviderOwner,
      channel,
    )
  })
  const hook = page.__cordisxNativeSubmitHook
  return {
    ...h,
    registry,
    hook,
    requests,
    async finish() {
      await act(async () => {
        reply(first!, { thread: { id: 'thread-1', status: { type: 'idle' }, modelProvider: 'openai' } })
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    },
    async close() {
      await act(async () => dispose())
      registry.dispose()
      await h.installed.dispose()
      await h.actual.dispose()
      vi.restoreAllMocks()
    },
  }
}

describe('actual selector installation with deferred native initial reads', () => {
  it('mounts the core marker before bridge reads finish, keeps Host intent through read completion, and rejects send', async () => {
    const h = await setup()
    try {
      expect(h.requests.map(request => request.method)).toEqual(['thread/read'])
      expect(document.querySelector('.cxmp-selector[data-cordisx-model-selector-ready="true"]')).not.toBeNull()
      vi.stubGlobal('__cordisxStartupDocument', {
        snapshot: () => ({ phase: 'covered', receipt: { nonce: 'owned', timeOrigin: performance.timeOrigin } }),
      })
      vi.stubGlobal('__cordisxRuntime', {})
      vi.stubGlobal('__cordisxBoot', Promise.resolve())
      expect(await readNativeStartupReadiness(undefined)).toMatchObject({ ready: true, surface: 'workspace-ready' })
      expect(await h.hook(send)).toEqual({ allow: false })
      await act(async () => document.querySelector<HTMLButtonElement>('.cxmp-provider-trigger')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('[data-provider-id="first"]')!.click())
      expect(document.body.textContent).toContain('Selected · waiting for models')
      expect(await h.hook(send)).toEqual({ allow: false })
      await h.finish()
      const scope = { ...h.draft, navigationGeneration: 0, threadId: 'thread-1' }
      expect(h.authority.selection.snapshot(scope)).toMatchObject({
        effective: { providerId: 'openai', model: 'model-a' },
        pendingProviderIntent: { providerId: 'first' },
      })
      expect(await h.hook(send)).toEqual({ allow: false })
      expect(h.prepare).not.toHaveBeenCalled()
      expect(h.switchThread).not.toHaveBeenCalled()
      const marker = document.querySelector<HTMLElement>('.cxmp-selector')!
      marker.setAttribute('inert', '')
      expect(await readNativeStartupReadiness(undefined)).toMatchObject({ ready: false })
    } finally {
      await h.close()
    }
  })

  it('keeps send closed when the initial authoritative selection read fails', async () => {
    const h = await setup(true)
    try {
      expect(await h.hook(send)).toEqual({ allow: false })
      await h.finish()
      expect(await h.hook(send)).toEqual({ allow: false })
      expect(h.prepare).not.toHaveBeenCalled()
      expect(h.switchThread).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})
