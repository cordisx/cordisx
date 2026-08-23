import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXLocalizationSeat, CordisXLocalizationSnapshot } from '../src/contracts.js'
import {
  canonicalLocale,
  CordisXI18nService,
  DocumentLocaleAdapter,
  LocalizationRegistry,
  type CordisXLocaleSource,
} from '../src/renderer/i18n.js'
import { CORDISX_PLUGIN_ID } from '../src/renderer/service.js'

class MutableLocaleSource implements CordisXLocaleSource {
  private readonly listeners = new Set<() => void>()
  private snapshot: CordisXLocalizationSnapshot

  constructor(locale = 'en', direction: CordisXLocalizationSnapshot['direction'] = 'ltr') {
    this.snapshot = { locale, direction, version: 0 }
  }

  getSnapshot(): CordisXLocalizationSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(locale: string, direction = this.snapshot.direction): void {
    this.snapshot = { locale, direction, version: this.snapshot.version + 1 }
    for (const listener of this.listeners) listener()
  }
}

describe('LocalizationRegistry', () => {
  it('uses exact, language, and declared-default locale fallback with ICU params', () => {
    const source = new MutableLocaleSource('zh-CN')
    const registry = new LocalizationRegistry(source)
    registry.define('demo', {
      namespace: 'demo',
      locale: 'en',
      default: true,
      messages: { greeting: 'Hello, {name}!', 'default.only': 'Default' },
    })
    registry.define('demo', {
      namespace: 'demo',
      locale: 'zh-CN',
      messages: { greeting: '你好，{name}！' },
    })

    expect(registry.resolve('demo', { key: 'greeting', params: { name: 'CordisX' } })).toMatchObject({
      text: '你好，CordisX！',
      locale: 'zh-CN',
    })
    expect(registry.resolve('demo', { key: 'default.only' })).toMatchObject({ text: 'Default', locale: 'en' })

    source.set('en-GB')
    expect(registry.resolve('demo', { key: 'greeting', params: { name: 'CordisX' } })).toMatchObject({
      text: 'Hello, CordisX!',
      locale: 'en',
    })
    registry.dispose()
  })

  it('replaces and restores a dictionary, rejects competing defaults, and disposes cleanly', () => {
    const source = new MutableLocaleSource()
    const registry = new LocalizationRegistry(source)
    const removeOriginal = registry.define('demo', {
      namespace: 'demo',
      locale: 'en',
      default: true,
      messages: { label: 'Original' },
    })
    const removeReplacement = registry.define('demo', {
      namespace: 'demo',
      locale: 'en',
      default: true,
      messages: { label: 'Replacement' },
    })
    expect(registry.resolve('demo', { key: 'label' }).text).toBe('Replacement')
    expect(() => registry.define('demo', {
      namespace: 'demo',
      locale: 'zh-CN',
      default: true,
      messages: { label: '冲突' },
    })).toThrow(/already has a live default/)

    removeReplacement()
    expect(registry.resolve('demo', { key: 'label' }).text).toBe('Original')
    removeOriginal()
    expect(registry.resolve('demo', { key: 'label' })).toMatchObject({
      text: '[[demo:label]]',
      diagnostic: 'missing-namespace',
    })
    registry.dispose()
    expect(() => registry.define('demo', {
      namespace: 'demo',
      locale: 'en',
      messages: { label: 'Late' },
    })).toThrow(/disposed/)
  })

  it('records deterministic missing namespace, key, and param diagnostics', () => {
    const registry = new LocalizationRegistry(new MutableLocaleSource())
    expect(registry.resolve('demo', { key: 'missing', fallback: 'Fallback' })).toMatchObject({
      text: 'Fallback',
      diagnostic: 'missing-namespace',
    })
    registry.define('demo', {
      namespace: 'demo',
      locale: 'en',
      default: true,
      messages: { greeting: 'Hello, {name}!' },
    })
    expect(registry.resolve('demo', { key: 'missing' })).toMatchObject({
      text: '[[demo:missing]]',
      diagnostic: 'missing-key',
    })
    expect(registry.resolve('demo', { key: 'greeting' })).toMatchObject({
      text: '[[demo:greeting]]',
      diagnostic: 'missing-params',
    })
    expect(registry.diagnostics().map(item => item.diagnostic)).toEqual(['missing-params', 'missing-key'])
    registry.dispose()
  })

  it('requires canonical locale serialization and owned namespaces', () => {
    expect(canonicalLocale('EN-us')).toBe('en-US')
    const registry = new LocalizationRegistry(new MutableLocaleSource())
    expect(() => registry.define('demo', {
      namespace: 'demo',
      locale: 'EN-us',
      messages: { label: 'Label' },
    })).toThrow(/canonical serialization/)
    expect(() => registry.define('demo', {
      namespace: 'other:foreign',
      locale: 'en',
      messages: { label: 'Label' },
    })).toThrow(/foreign locale namespace/)
    registry.dispose()
  })
})

describe('DocumentLocaleAdapter', () => {
  it('observes upstream html lang and dir without writing either attribute', async () => {
    const dom = new JSDOM('<html lang="en" dir="ltr"><body></body></html>')
    const adapter = new DocumentLocaleAdapter(dom.window.document)
    let changes = 0
    adapter.subscribe(() => { changes += 1 })

    dom.window.document.documentElement.lang = 'zh-cn'
    dom.window.document.documentElement.dir = 'rtl'
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.getSnapshot()).toEqual({ locale: 'zh-CN', direction: 'rtl', version: 1 })
    expect(dom.window.document.documentElement.lang).toBe('zh-cn')
    expect(dom.window.document.documentElement.dir).toBe('rtl')
    expect(changes).toBe(1)
    adapter.dispose()
    dom.window.close()
  })
})

describe('CordisXI18nService', () => {
  it('owns dictionaries, typed seats, reactive effects, and bindings on the plugin fiber', async () => {
    interface DemoMessages {
      greeting: { readonly name: string }
      status: undefined
    }

    const dom = new JSDOM('<html lang="en" dir="ltr"><body><span id="text"></span></body></html>')
    vi.stubGlobal('document', dom.window.document)
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXI18nService)
    let seat: CordisXLocalizationSeat<DemoMessages> | undefined
    let effectRuns = 0
    let effectCleanups = 0

    try {
      await serviceFiber
      const pluginContext = ctx.extend({ [CORDISX_PLUGIN_ID]: 'demo' })
      const plugin = pluginContext.plugin({
        inject: ['i18n'],
        apply(pluginCtx: Context) {
          pluginCtx.i18n.define<DemoMessages>({
            namespace: 'demo',
            locale: 'en',
            default: true,
            messages: { greeting: 'Hello, {name}!', status: 'Ready' },
          })
          pluginCtx.i18n.define<DemoMessages>({
            namespace: 'demo',
            locale: 'zh-CN',
            messages: { greeting: '你好，{name}！', status: '就绪' },
          })
          pluginCtx.i18n.inject<DemoMessages>('demo', (injected) => {
            seat = injected
            injected.bindText(
              dom.window.document.getElementById('text')!,
              injected.message('greeting', { name: 'CordisX' }),
            )
            injected.effect(() => {
              effectRuns += 1
              return () => { effectCleanups += 1 }
            })
            return () => {}
          })
        },
      })
      await plugin

      expect(seat?.t('status')).toBe('Ready')
      expect(dom.window.document.getElementById('text')?.textContent).toBe('Hello, CordisX!')
      expect(effectRuns).toBe(1)

      dom.window.document.documentElement.lang = 'zh-CN'
      dom.window.document.documentElement.dir = 'rtl'
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(seat?.getSnapshot()).toMatchObject({ locale: 'zh-CN', direction: 'rtl' })
      expect(dom.window.document.getElementById('text')?.textContent).toBe('你好，CordisX！')
      expect(effectRuns).toBe(2)
      expect(effectCleanups).toBe(1)

      await plugin.dispose()
      expect(effectCleanups).toBe(2)
      expect((ctx.i18n as CordisXI18nService).catalogs()).toEqual([])
    } finally {
      await serviceFiber.dispose()
      vi.unstubAllGlobals()
      dom.window.close()
    }
  })
})
