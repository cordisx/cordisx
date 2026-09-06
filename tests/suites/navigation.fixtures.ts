import { type CordisXLocalizationSeat } from '../../packages/cli/src/contracts.js'
import type { CordisXI18nService, LocalizationEffectOwner } from '../../packages/cli/src/renderer/i18n.js'
import { type OutletController, type OutletHostSnapshot } from '../../packages/cli/src/renderer/navigation.js'

declare module '../../packages/cli/src/contracts.js' {
  interface CordisXOutletMap {
    'panel.right': { readonly scope: 'panel' }
  }
}

export class FakeOutlet implements OutletController {
  private readonly listeners = new Set<() => void>()
  private snapshot: OutletHostSnapshot
  shows = 0
  hides = 0

  constructor(container: HTMLElement, contextKey = 'context:one', nativeSessionId?: string) {
    this.snapshot = {
      available: true,
      container,
      contextKey,
      placement: 'absolute',
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    }
  }

  getSnapshot(): OutletHostSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  show(): void {
    this.shows += 1
  }
  hide(): void {
    this.hides += 1
  }

  set(container: HTMLElement, contextKey: string, nativeSessionId = this.snapshot.nativeSessionId): void {
    this.snapshot = {
      available: true,
      container,
      contextKey,
      placement: 'absolute',
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    }
    for (const listener of [...this.listeners]) listener()
  }
}

export function fakeI18n(): CordisXI18nService {
  return {
    resolveFor(_owner: string, message: { key: string; fallback?: string }) {
      return { text: message.fallback ?? message.key, namespace: 'demo', key: message.key }
    },
    clearDiagnosticSite() {},
    seatFor(owner: string, namespace: string | undefined, own: LocalizationEffectOwner): CordisXLocalizationSeat {
      const seat: CordisXLocalizationSeat = {
        namespace: `${owner}:${namespace ?? owner}`,
        t: key => String(key),
        message: (key, params) => ({ key, ...(params === undefined ? {} : { params }) }),
        getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 0 }),
        subscribe: listener =>
          own(() => {
            void listener
            return () => {}
          }),
        effect: setup => own(() => setup({ locale: 'en', direction: 'ltr', version: 0 })),
        bindText: (node, message) =>
          own(() => {
            const previous = node.textContent
            node.textContent = message.fallback ?? message.key
            return () => {
              node.textContent = previous
            }
          }),
        bindAttribute: (element, name, message) =>
          own(() => {
            const previous = element.getAttribute(name)
            element.setAttribute(name, message.fallback ?? message.key)
            return () => previous === null ? element.removeAttribute(name) : element.setAttribute(name, previous)
          }),
      }
      return seat
    },
  } as unknown as CordisXI18nService
}

export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

export function copySessionStorage(source: Storage, target: Storage): void {
  for (let index = 0; index < source.length; index += 1) {
    const key = source.key(index)
    if (key !== null) target.setItem(key, source.getItem(key)!)
  }
}
