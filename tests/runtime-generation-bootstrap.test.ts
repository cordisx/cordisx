import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  createBrandMarkElement: (document: Document, className?: string) => {
    const mark = document.createElement('span')
    if (className !== undefined) mark.className = className
    return mark
  },
  BrandMark: () => null,
  AnimatedBrandMark: () => null,
}))

interface RuntimeHandle {
  dispose(): Promise<void>
}

function installBrowserGlobals(): JSDOM {
  const dom = new JSDOM('<html lang="en"><head></head><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://codex.local/',
  })
  const browser = dom.window
  Object.defineProperty(browser.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => ({ length: 1 }),
  })
  for (const [name, value] of [
    ['window', browser],
    ['document', browser.document],
    ['history', browser.history],
    ['location', browser.location],
    ['navigator', browser.navigator],
    ['localStorage', browser.localStorage],
    ['HTMLElement', browser.HTMLElement],
    ['Element', browser.Element],
    ['Node', browser.Node],
    ['Text', browser.Text],
    ['Event', browser.Event],
    ['CustomEvent', browser.CustomEvent],
    ['KeyboardEvent', browser.KeyboardEvent],
    ['MouseEvent', browser.MouseEvent],
    ['MutationObserver', browser.MutationObserver],
    ['getComputedStyle', browser.getComputedStyle.bind(browser)],
    ['requestAnimationFrame', browser.requestAnimationFrame.bind(browser)],
    ['cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser)],
  ] as const) vi.stubGlobal(name, value)
  return dom
}

function metadata(generation: string) {
  return {
    version: 'test',
    providers: [],
    profileId: 'work',
    generation,
  } as const
}

async function disposeRuntime(): Promise<void> {
  const runtime = (globalThis as typeof globalThis & { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
  await runtime?.dispose()
  // React's scheduler may retain a final Immediate after root unmount; keep
  // the browser globals alive until that queue is drained.
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

afterEach(async () => {
  await disposeRuntime()
  vi.unstubAllGlobals()
  const globals = globalThis as typeof globalThis & Record<string, unknown>
  Reflect.deleteProperty(globals, '__cordisxBoot')
  Reflect.deleteProperty(globals, '__cordisxBootGeneration')
  Reflect.deleteProperty(globals, '__cordisxRequestedGeneration')
  Reflect.deleteProperty(globals, '__cordisxRuntime')
})

describe('production renderer generation bootstrap', () => {
  it('reuses one Promise and starts once for a same-generation duplicate', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const firstBootstrap = vi.fn(async () => undefined)
    const duplicateBootstrap = vi.fn(async () => undefined)

    const first = installCordisX([], metadata('same-generation'), firstBootstrap)
    const duplicate = installCordisX([], metadata('same-generation'), duplicateBootstrap)
    expect(duplicate).toBe(first)
    await expect(first).resolves.toBeDefined()
    expect(firstBootstrap).toHaveBeenCalledOnce()
    expect(duplicateBootstrap).not.toHaveBeenCalled()

    await disposeRuntime()
    dom.window.close()
  })

  it('starts only the newest generation when old and new bootstraps arrive in one tick', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const oldBootstrap = vi.fn(async () => undefined)
    const newBootstrap = vi.fn(async () => undefined)

    const old = installCordisX([], metadata('old-generation'), oldBootstrap)
    const newest = installCordisX([], metadata('new-generation'), newBootstrap)
    await expect(old).rejects.toThrow('CordisX bootstrap generation was superseded')
    await expect(newest).resolves.toBeDefined()
    expect(oldBootstrap).not.toHaveBeenCalled()
    expect(newBootstrap).toHaveBeenCalledOnce()

    await disposeRuntime()
    dom.window.close()
  })

  it('clears failed boot globals so the same generation can retry cleanly', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const failingBootstrap = vi.fn(async () => { throw new Error('fixture generation boot failed') })
    const retryBootstrap = vi.fn(async () => undefined)

    const failed = installCordisX([], metadata('retry-generation'), failingBootstrap)
    await expect(failed).rejects.toThrow('fixture generation boot failed')
    await Promise.resolve()
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    expect(globals.__cordisxBoot).toBeUndefined()
    expect(globals.__cordisxBootGeneration).toBeUndefined()
    expect(globals.__cordisxRequestedGeneration).toBeUndefined()

    const retry = installCordisX([], metadata('retry-generation'), retryBootstrap)
    expect(retry).not.toBe(failed)
    await expect(retry).resolves.toBeDefined()
    expect(failingBootstrap).toHaveBeenCalledOnce()
    expect(retryBootstrap).toHaveBeenCalledOnce()

    await disposeRuntime()
    dom.window.close()
  })
})
