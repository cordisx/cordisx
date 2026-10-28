import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, expect, vi } from 'vitest'
import {
  ModelProviderSelector,
  type ProviderSelectionSnapshot,
} from '../../packages/cli/src/renderer/model-provider-selector.js'
import { ModelProviderRegistry } from '../../packages/cli/src/renderer/model-providers.js'
import type { ModelReasoningCapabilities } from '../../packages/cli/src/model-reasoning-capabilities.js'
const globals = Object.fromEntries(
  ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Reflect.get(globalThis, key)]),
)
let root: Root | undefined
export let dom: JSDOM | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  dom?.window.close()
  Object.assign(globalThis, globals)
})
export async function setup(model = 'shared', busy = false, options?: {
  readonly firstLabel?: string
  readonly firstAliases?: readonly string[]
  readonly firstModels?: readonly {
    readonly id: string
    readonly label: string
    readonly aliases?: readonly string[]
    readonly reasoningCapabilities?: ModelReasoningCapabilities
  }[]
  readonly secondModels?: readonly {
    readonly id: string
    readonly label: string
    readonly aliases?: readonly string[]
    readonly reasoningCapabilities?: ModelReasoningCapabilities
  }[]
  readonly secondDefaultModelId?: string
  readonly draft?: boolean
  readonly draftPreference?: ProviderSelectionSnapshot['draftPreference']
  readonly nativeModels?: ProviderSelectionSnapshot['nativeModels']
  readonly branded?: boolean
  readonly liveCatalog?: boolean
  readonly firstProviderId?: string
  readonly firstProviderTitle?: string
  readonly secondProviderId?: string
  readonly secondProviderTitle?: string
  readonly additionalProviders?: readonly {
    readonly providerId: string
    readonly title: string
    readonly models: readonly { readonly id: string; readonly label: string }[]
  }[]
}) {
  dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://example.test' })
  Object.assign(
    globalThis,
    Object.fromEntries(['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver']
      .map(key => [key, key === 'window' ? dom!.window : Reflect.get(dom!.window, key)])),
    { IS_REACT_ACT_ENVIRONMENT: true },
  )
  dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
  }
  dom.window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
  }
  // React was imported before JSDOM and selected its legacy input-event adapter.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  const registry = new ModelProviderRegistry(async () => [
    {
      providerId: options?.firstProviderId ?? 'first',
      pluginId: 'p',
      ...(options?.firstProviderTitle === undefined ? {} : { title: options.firstProviderTitle }),
      ...(options?.branded ? { selectorBrand: { brand: 'openrouter' as const, source: 'override' as const } } : {}),
      models: options?.firstModels ?? [{
        id: model,
        label: options?.firstLabel ?? 'Current',
        ...(options?.firstAliases === undefined ? {} : { aliases: options.firstAliases }),
        reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'low' },
      }],
    },
    {
      providerId: options?.secondProviderId ?? 'second',
      pluginId: 'q',
      ...(options?.secondProviderTitle === undefined ? {} : { title: options.secondProviderTitle }),
      ...(options?.branded ? { selectorBrand: { brand: 'moonshot' as const, source: 'inferred' as const } } : {}),
      models: options?.secondModels
        ?? [{ id: 'shared', label: 'Equivalent' }, { id: 'other', label: 'Other', group: 'Alternative' }],
      ...(options?.secondDefaultModelId === undefined ? {} : { defaultModelId: options.secondDefaultModelId }),
    },
    ...(options?.additionalProviders ?? []).map(provider => ({
      ...provider,
      pluginId: `plugin:${provider.providerId}`,
    })),
  ])
  if (options?.liveCatalog) registry.connectSource(() => () => {})
  await registry.refresh()
  let snapshot: ProviderSelectionSnapshot = {
    available: true,
    ...(options?.draft ? {} : { threadId: 't1' }),
    modelProvider: 'first',
    model,
    ...(options?.nativeModels === undefined ? {} : { nativeModels: options.nativeModels }),
    reasoningEffort: 'high',
    reasoningEfforts: ['low', 'high'],
    busy,
    ...(options?.draftPreference === undefined ? {} : { draftPreference: options.draftPreference }),
  }
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const select = vi.fn(async (
    target: { providerId: string; model: string },
    _selectionOptions?: Readonly<{ source: 'preference'; expectedRevision: number }>,
  ) => {
    snapshot = {
      ...snapshot,
      modelProvider: target.providerId,
      model: target.model,
      pendingProviderId: undefined,
      pendingModel: undefined,
      draftPreference: undefined,
    }
    notify()
    return 'accepted' as const
  })
  const selectReasoningEffort = vi.fn(async () => 'accepted' as const)
  const selectFastMode = vi.fn(async (enabled: boolean) => {
    snapshot = { ...snapshot, serviceTier: enabled ? 'priority' : null }
    notify()
    return 'accepted' as const
  })
  const confirmSubmission = vi.fn()
  root = createRoot(document.getElementById('root')!)
  await act(async () =>
    root!.render(
      <ModelProviderSelector
        registry={registry}
        locale="en"
        transport={{
          getSnapshot: () => snapshot,
          subscribe: listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          select,
          selectReasoningEffort,
          selectFastMode,
          confirmSubmission,
        }}
      />,
    )
  )
  return {
    registry,
    select,
    selectReasoningEffort,
    selectFastMode,
    snapshot,
    confirmSubmission,
    update: async (patch: Partial<ProviderSelectionSnapshot>) => {
      await act(async () => {
        snapshot = { ...snapshot, ...patch }
        notify()
      })
    },
  }
}
export async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(`${selector}:not(:disabled)`)
  expect(button).not.toBeNull()
  await act(async () => {
    button!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
export const providerTrigger = '.cxmp-provider-trigger'
export const modelTrigger = '.cxmp-model-trigger'
