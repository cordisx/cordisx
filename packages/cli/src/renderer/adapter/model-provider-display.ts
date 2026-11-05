import type { ModelProviderDisplay } from '../../model-provider-display.js'

/** Serialized Host-only probe; reads the mounted CordisX selector without opening or changing it. */
export function readModelProviderDisplay(
  expected: { readonly profileId?: string; readonly runtimeGeneration?: string } = {},
): readonly ModelProviderDisplay[] {
  const root = globalThis as typeof globalThis & {
    __cordisxRuntime?: { activePluginGeneration(): { profileId: string; runtimeGeneration: string } }
  }
  const runtime = root.__cordisxRuntime
  if (!runtime || document.documentElement.dataset.cordisxReady !== 'true') return []
  const activation = runtime.activePluginGeneration()
  if (
    expected.profileId !== undefined && activation.profileId !== expected.profileId
    || expected.runtimeGeneration !== undefined && activation.runtimeGeneration !== expected.runtimeGeneration
  ) return []
  const registries = new Set<{ snapshot(): { providers: readonly ModelProviderDisplay[] } }>()
  for (const element of document.querySelectorAll('.cxmp-selector')) {
    const node = element as unknown as Record<string, unknown>
    const keys = Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$'))
    if (keys.length !== 1) continue
    type Fiber = {
      return?: Fiber
      memoizedProps?: { registry?: { snapshot(): { providers: readonly ModelProviderDisplay[] } }; transport?: unknown }
    }
    let fiber = node[keys[0]!] as Fiber | undefined
    const seen = new Set<Fiber>()
    for (let depth = 0; fiber && depth < 64 && !seen.has(fiber); depth++, fiber = fiber.return) {
      seen.add(fiber)
      const props = fiber.memoizedProps
      if (typeof props?.registry?.snapshot === 'function' && props.transport) {
        registries.add(props.registry)
        break
      }
    }
  }
  if (registries.size !== 1) return []
  const providers = [...registries][0]!.snapshot().providers
  if (!Array.isArray(providers) || providers.length > 128) return []
  if (
    root.__cordisxRuntime !== runtime
    || runtime.activePluginGeneration().runtimeGeneration !== activation.runtimeGeneration
  ) return []
  return providers.map(provider => ({
    providerId: provider.providerId,
    title: provider.title,
    icon: provider.icon,
    ...(provider.selectorBrand === undefined ? {} : { selectorBrand: provider.selectorBrand }),
  }))
}

export function modelProviderDisplayExpression(expected?: Parameters<typeof readModelProviderDisplay>[0]): string {
  return `(${readModelProviderDisplay.toString()})(${JSON.stringify(expected ?? {})})`
}
