import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelProviderSelector,
  type ProviderSelectionSnapshot,
} from '../packages/cli/src/renderer/model-provider-selector.js'
import { canReplaceNativeModelProviderTrigger } from '../packages/cli/src/renderer/install-model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'

const globals = Object.fromEntries(
  ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Reflect.get(globalThis, key)]),
)
let root: Root | undefined
let dom: JSDOM | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  dom?.window.close()
  Object.assign(globalThis, globals)
})

async function setup(model = 'shared', busy = false, options?: {
  readonly firstLabel?: string
  readonly firstAliases?: readonly string[]
  readonly firstModels?: readonly {
    readonly id: string
    readonly label: string
    readonly aliases?: readonly string[]
  }[]
  readonly secondModels?: readonly {
    readonly id: string
    readonly label: string
    readonly aliases?: readonly string[]
  }[]
  readonly secondDefaultModelId?: string
  readonly draft?: boolean
  readonly draftPreference?: ProviderSelectionSnapshot['draftPreference']
  readonly nativeModels?: ProviderSelectionSnapshot['nativeModels']
  readonly branded?: boolean
  readonly liveCatalog?: boolean
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
      providerId: 'first',
      pluginId: 'p',
      ...(options?.branded ? { selectorBrand: { brand: 'openrouter' as const, source: 'override' as const } } : {}),
      models: options?.firstModels ?? [{
        id: model,
        label: options?.firstLabel ?? 'Current',
        ...(options?.firstAliases === undefined ? {} : { aliases: options.firstAliases }),
      }],
    },
    {
      providerId: 'second',
      pluginId: 'q',
      ...(options?.branded ? { selectorBrand: { brand: 'moonshot' as const, source: 'inferred' as const } } : {}),
      models: options?.secondModels
        ?? [{ id: 'shared', label: 'Equivalent' }, { id: 'other', label: 'Other', group: 'Alternative' }],
      ...(options?.secondDefaultModelId === undefined ? {} : { defaultModelId: options.secondDefaultModelId }),
    },
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

async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(`${selector}:not(:disabled)`)
  expect(button).not.toBeNull()
  await act(async () => {
    button!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const providerTrigger = '.cxmp-provider-trigger'
const modelTrigger = '.cxmp-model-trigger'

describe('provider selection interaction', () => {
  it('opens a subscribed provider catalog without re-reading it on the interaction turn', async () => {
    const { registry } = await setup('model-0', false, {
      liveCatalog: true,
      branded: true,
      firstModels: Array.from({ length: 500 }, (_, index) => ({
        id: `openrouter/model-${index}`,
        label: `OpenRouter Model ${index}`,
      })),
    })
    const refresh = vi.spyOn(registry, 'refresh')
    let timerFired = false
    const timer = new Promise<void>(resolve =>
      setTimeout(() => {
        timerFired = true
        resolve()
      }, 0)
    )

    await click(providerTrigger)
    await timer

    expect(refresh).not.toHaveBeenCalled()
    expect(timerFired).toBe(true)
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3)
    expect(document.querySelectorAll('.cxmp-model-choice')).toHaveLength(0)
    await click(providerTrigger)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('refreshes a fallback catalog when either selector is opened', async () => {
    const { registry } = await setup()
    const refresh = vi.spyOn(registry, 'refresh').mockResolvedValue()
    await click(providerTrigger)
    expect(refresh).toHaveBeenCalledTimes(1)
    await click(providerTrigger)
    await click(modelTrigger)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not apply draft fallback when a live catalog refresh changes members', async () => {
    const result = await setup('shared', false, {
      draft: true,
      liveCatalog: true,
      draftPreference: { providerId: 'second', generation: 7, revision: 3 },
    })
    expect(result.select).not.toHaveBeenCalled()
    result.registry.dispose()
  })
  it('applies a launcher draft preference with the existing legal model pairing strategy', async () => {
    const { select } = await setup('source-model', false, {
      draft: true,
      draftPreference: { providerId: 'second', generation: 7, revision: 3 },
      firstLabel: 'GPT-5.6-Sol[Responses]',
      secondDefaultModelId: 'fallback',
      secondModels: [
        { id: 'fallback', label: 'Default model' },
        { id: 'provider-specific-sol', label: 'gpt-5.6-sol' },
      ],
    })
    expect(select).toHaveBeenCalledWith(
      { providerId: 'second', model: 'provider-specific-sol' },
      { source: 'preference', expectedRevision: 3 },
    )
  })

  it('waits for a legal built-in model before applying an OpenAI draft preference', async () => {
    const { select, update } = await setup('provider-model', false, {
      draft: true,
      draftPreference: { providerId: 'openai', generation: 8, revision: 4 },
    })
    expect(select).not.toHaveBeenCalled()
    await update({ nativeModels: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', disabled: false }] })
    expect(select).toHaveBeenCalledWith(
      { providerId: 'openai', model: 'gpt-6-astra' },
      { source: 'preference', expectedRevision: 4 },
    )
  })

  it('shows the built-in Codex choice and theme-inheriting icon without a configured provider', async () => {
    const { update, select } = await setup()
    await update({
      modelProvider: undefined,
      model: 'gpt-6-astra',
      nativeModels: [
        { id: 'gpt-6-astra', label: 'GPT-6-Astra', disabled: false },
      ],
    })
    expect(document.querySelector(`${providerTrigger} svg`)?.getAttribute('fill')).toBe('currentColor')
    await click(providerTrigger)
    const official = document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
    expect(official.textContent).toBe('Codex')
    expect(official.getAttribute('aria-checked')).toBe('true')
    await act(async () => official.click())
    expect(select).toHaveBeenLastCalledWith({ providerId: 'openai', model: 'gpt-6-astra' })
  })

  it('can return from a plugin to the matching native model', async () => {
    const { update, select } = await setup('shared')
    await update({ nativeModels: [{ id: 'shared', label: 'Current', disabled: false }] })
    await click(providerTrigger)
    const official = document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
    expect(official.getAttribute('aria-checked')).toBe('false')
    await act(async () => official.click())
    expect(select).toHaveBeenLastCalledWith({ providerId: 'openai', model: 'shared' })
  })

  it('updates the visible provider and model immediately after selection', async () => {
    const { select } = await setup()
    await click(providerTrigger)
    await click('[role="menuitemradio"][aria-checked="false"]')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(select).toHaveBeenCalledWith({ providerId: 'second', model: 'shared' })
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toContain('second')
    expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('Equivalent')
    await click(providerTrigger)
    expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toContain('second')
    await click(providerTrigger)
    await click(modelTrigger)
    expect(document.querySelector('.cxmp-menu')?.querySelectorAll('.cxmp-model-choice')).toHaveLength(2)
    expect([...document.querySelectorAll('.cxmp-model-choice')].map(choice => choice.textContent)).toEqual([
      'Equivalent',
      'Other',
    ])
    expect(document.querySelector('.cxmp-model-choice[aria-checked="true"]')?.textContent).toBe('Equivalent')
  })

  it('keeps a uniquely matching model name selected when changing providers', async () => {
    const { select } = await setup('source-model', false, {
      firstLabel: 'GPT-5.6-Sol[Responses]',
      secondDefaultModelId: 'fallback',
      secondModels: [
        { id: 'fallback', label: 'Default model' },
        { id: 'provider-specific-sol', label: 'gpt-5.6-sol' },
      ],
    })
    await click(providerTrigger)
    await click('[role="menuitemradio"][aria-checked="false"]')
    expect(select).toHaveBeenCalledWith({ providerId: 'second', model: 'provider-specific-sol' })
    expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('gpt-5.6-sol')
  })

  it('preserves TraeX GPT-5.6 when switching to the equivalent Aiden route', async () => {
    const { select } = await setup('traex/traex-gpt-5.6-sol', false, {
      firstLabel: 'traex-gpt-5.6-sol',
      firstAliases: ['traex-gpt-5.6-sol'],
      secondDefaultModelId: 'aiden/doubao-seed-2.1-pro',
      secondModels: [
        {
          id: 'aiden/doubao-seed-2.1-pro',
          label: 'Doubao-Seed-2.1-Pro',
          aliases: ['doubao-seed-2.1-pro'],
        },
        { id: 'aiden/gpt-5.6-sol', label: 'gpt-5.6-sol', aliases: ['gpt-5.6-sol'] },
      ],
    })
    await click(providerTrigger)
    await click('[role="menuitemradio"][aria-checked="false"]')
    expect(select).toHaveBeenCalledWith({ providerId: 'second', model: 'aiden/gpt-5.6-sol' })
    expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('gpt-5.6-sol')
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('does not fall back to the current provider while a pending provider catalog is unavailable', async () => {
    const { update } = await setup()
    await update({ pendingProviderId: 'loading-provider', pendingModel: 'loading-model' })
    await click(modelTrigger)
    expect(document.querySelectorAll('.cxmp-model-choice')).toHaveLength(0)
    expect(document.querySelector('.cxmp-menu')?.textContent).not.toContain('Current')
  })

  it('separates providers from the current provider models without exposing model IDs', async () => {
    const { select } = await setup('missing')
    await click(modelTrigger)
    const menu = document.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Current')
    expect(menu?.textContent).not.toContain('Equivalent')
    expect(menu?.textContent).not.toContain('Other')
    expect(menu?.textContent).not.toContain('missing')
    expect(menu?.textContent).not.toContain('shared')
    expect(select).not.toHaveBeenCalled()
    await click(providerTrigger)
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Current')
    await click('[role="menuitemradio"][aria-checked="false"]')
    expect(select).toHaveBeenCalledWith({ providerId: 'second', model: 'shared' })
  })

  it('renders independent provider and model brand seats without changing labels or selection', async () => {
    await setup('openai/gpt-5.6', false, {
      branded: true,
      firstLabel: 'GPT 5.6',
      secondModels: [
        { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
        { id: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
      ],
    })
    await click(providerTrigger)
    expect(document.querySelector('[data-provider-id="first"] [data-selector-brand="openrouter"]')).not.toBeNull()
    expect(document.querySelector('[data-provider-id="second"] [data-selector-brand="moonshot"]')).not.toBeNull()
    await click(providerTrigger)
    await click(modelTrigger)
    const selected = document.querySelector('.cxmp-model-choice[aria-checked="true"]')
    expect(selected?.textContent).toBe('GPT 5.6')
    expect(selected?.querySelector('[data-selector-brand="openai"]')).not.toBeNull()
    expect(selected?.querySelector('[data-selector-brand="openrouter"]')).toBeNull()
  })

  it('blocks model routing while busy and keeps plugin setup entries usable', async () => {
    const { registry, select } = await setup('shared', true)
    const action = vi.fn()
    await act(async () => {
      registry.bind('new', '1', () => true).facade.insert({
        id: 'api-key',
        label: 'Custom',
        icon: 'host:key',
        action: { label: 'Set API key', icon: 'host:key', run: action },
      })
    })
    await click(providerTrigger)
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(choices.some(button => button.getAttribute('aria-checked') === 'true' && button.disabled)).toBe(true)
    expect(choices.filter(button => button.getAttribute('aria-checked') === 'false').every(button => button.disabled))
      .toBe(true)
    await click('[aria-label="Set API key"]')
    expect(action).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
  })

  it('reports provider action failures through owner notifications and keeps retry usable', async () => {
    const { registry } = await setup()
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('token=private-value at /private/account/config.json'))
      .mockResolvedValueOnce(undefined)
    const show = vi.fn(() => ({ dismiss() {} }))
    await act(async () => {
      registry.bind('provider', '1', () => true, {
        contract: 'cordisx.notifications/v1',
        show,
      }).facade.insert({
        id: 'login',
        label: 'Aiden',
        icon: 'host:key',
        action: { label: 'Log in', icon: 'host:key', run: action },
      })
    })
    await click(providerTrigger)
    await click('[aria-label="Log in"]')
    expect(document.querySelector('.cxmp-action-entry .cxmp-error')).toBeNull()
    expect(show).toHaveBeenCalledOnce()
    const notification = show.mock.calls[0]![0]
    expect(notification).toMatchObject({
      kind: 'model-provider.action-failed',
      type: 'error',
      message: 'Action failed. Please retry.',
      description: 'Aiden',
      details: 'token=[redacted] at [path redacted]',
    })
    await act(async () => notification.action.run(new AbortController().signal))
    expect(action).toHaveBeenCalledTimes(2)
    expect(registry.snapshot().loading).toBe(false)
  })

  it('replaces a login action icon with the Host loader while pending and restores it after settle', async () => {
    const { registry } = await setup()
    let finish!: () => void
    const action = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    await act(async () => {
      registry.bind('provider', '1', () => true).facade.insert({
        id: 'login',
        label: 'Aiden',
        icon: 'host:key',
        action: { label: 'Log in', icon: 'host:log-in', run: action },
      })
    })
    await click(providerTrigger)
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Log in"]')!
    expect(button.querySelector('[data-host-icon="host:log-in"]')).not.toBeNull()

    await act(async () => {
      button.click()
      button.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(action).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.querySelector('[data-host-icon="host:loader"]')).not.toBeNull()
    expect(button.querySelector('[data-host-icon="host:log-in"]')).toBeNull()

    await act(async () => {
      finish()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBe('false')
    expect(button.querySelector('[data-host-icon="host:log-in"]')).not.toBeNull()
    expect(button.querySelector('[data-host-icon="host:loader"]')).toBeNull()
  })

  it('clears stale busy state when an action is replaced under the same registry key', async () => {
    const { registry } = await setup()
    let finish!: () => void
    const first = registry.bind('action-owner', '1', () => true)
    let registration!: ReturnType<typeof first.facade.insert>
    await act(async () => {
      registration = first.facade.insert({
        id: 'setup',
        label: 'Old action',
        icon: 'host:key',
        action: {
          label: 'Run old action',
          icon: 'host:key',
          run: () =>
            new Promise<void>(resolve => {
              finish = resolve
            }),
        },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await click(providerTrigger)
    await click('[aria-label="Run old action"]')
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Run old action"]')?.disabled).toBe(true)

    await act(async () => {
      registration.dispose()
      registry.bind('action-owner', '2', () => true).facade.insert({
        id: 'setup',
        label: 'New action',
        icon: 'host:key',
        action: { label: 'Run new action', icon: 'host:key', run: vi.fn() },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Run new action"]')?.disabled).toBe(false)
    await act(async () => {
      finish()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  })

  it('preserves keyboard focus when the catalog refreshes while the menu is open', async () => {
    const { registry } = await setup()
    await click(providerTrigger)
    const second = document.querySelector<HTMLButtonElement>('[data-provider-id="second"]')!
    second.focus()
    await act(async () => registry.refresh())
    expect(document.activeElement).toBe(second)
  })

  it('restores the single model trigger on Escape and collapses on repeated click', async () => {
    await setup('missing')
    await click(modelTrigger)
    const activeModel = document.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')!
    activeModel.focus()
    await act(async () => {
      activeModel.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => Promise.resolve())
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.classList.contains('cxmp-trigger')).toBe(true)
    await click(modelTrigger)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await click(modelTrigger)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('reports accepted work separately from an observed effective selection', async () => {
    const { select } = await setup()
    await click(providerTrigger)
    await click('[role="menuitemradio"][aria-checked="false"]')
    expect(select).toHaveBeenCalledWith({ providerId: 'second', model: 'shared' })
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('does not render a send-time switch dialog and preserves standard transport errors', async () => {
    const { update, confirmSubmission } = await setup()
    await update({
      pendingProviderId: 'second',
      pendingModel: 'shared',
      confirmation: {
        confirmationId: 'confirmation-token',
        expectedSelectionRevision: 3,
        target: { providerId: 'second', model: 'shared', generation: 2 },
        threadId: 't1',
      },
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(confirmSubmission).not.toHaveBeenCalled()
    await update({ confirmation: undefined, submissionError: 'unsupported-submission-intent' })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'This action does not support switching model services yet.',
    )
    await update({ submissionError: undefined })
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a reasoning slider inside the model menu and shows two independent triggers', async () => {
    const { select, selectReasoningEffort } = await setup()
    expect(document.querySelectorAll('.cxmp-trigger')).toHaveLength(2)
    expect(document.querySelector(modelTrigger)?.textContent).toContain('Current')
    expect(document.querySelector(modelTrigger)?.textContent).not.toContain('first')
    await click(modelTrigger)
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Reasoning effort')
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    await act(async () => {
      slider.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
      Object.getOwnPropertyDescriptor(dom!.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '0')
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
      slider.dispatchEvent(new dom!.window.Event('change', { bubbles: true }))
    })
    await act(async () => slider.dispatchEvent(new dom!.window.Event('pointerup', { bubbles: true })))
    expect(selectReasoningEffort).toHaveBeenCalledWith('low')
    expect(select).not.toHaveBeenCalled()
  })

  it('shows Fast availability in the menu and the active state beside the model trigger', async () => {
    const { selectFastMode, update } = await setup()
    await update({
      nativeModels: [{ id: 'shared', label: 'Current', disabled: false, supportsFastMode: true }],
      serviceTier: null,
    })
    expect(document.querySelector('.cxmp-fast-trigger')).toBeNull()
    await click(modelTrigger)
    const fast = document.querySelector<HTMLButtonElement>('.cxmp-fast-toggle')!
    expect(fast.disabled).toBe(false)
    expect(fast.getAttribute('aria-pressed')).toBe('false')
    await click('.cxmp-fast-toggle')
    expect(selectFastMode).toHaveBeenCalledWith(true)
    expect(document.querySelector('.cxmp-fast-trigger')?.getAttribute('aria-pressed')).toBe('true')
    // An unregistered surface token silently renders the neutral minus placeholder instead of the bolt.
    expect(document.querySelector('.cxmp-fast-trigger svg')?.getAttribute('data-host-icon-provider'))
      .toBe('builtin:reicon')
    expect(document.querySelector(`${modelTrigger} .cxmp-model-separator`)).not.toBeNull()
    expect(document.querySelector(`${modelTrigger} .cxmp-effort-label`)?.textContent).toBe('High')
    expect(document.querySelector(`${modelTrigger} .cordisx-host-icon`)).toBeNull()
  })

  it('disables Fast in the model menu when the selected model does not support it', async () => {
    const { update } = await setup()
    await update({
      nativeModels: [{ id: 'shared', label: 'Current', disabled: false, supportsFastMode: false }],
      serviceTier: 'priority',
    })
    await click(modelTrigger)
    expect(document.querySelector<HTMLButtonElement>('.cxmp-fast-toggle')?.disabled).toBe(true)
    expect(document.querySelector('.cxmp-fast-trigger')).toBeNull()
  })

  it('owns the combined native trigger independently of external model membership', async () => {
    const { registry, snapshot } = await setup()
    expect(canReplaceNativeModelProviderTrigger(snapshot, registry.snapshot())).toBe(true)
    expect(canReplaceNativeModelProviderTrigger({ ...snapshot, reasoningEfforts: [] }, registry.snapshot())).toBe(true)
    expect(canReplaceNativeModelProviderTrigger({ ...snapshot, reasoningEffort: undefined }, registry.snapshot())).toBe(
      true,
    )
    expect(canReplaceNativeModelProviderTrigger(snapshot, { providers: [], entries: [], loading: false })).toBe(true)
    expect(canReplaceNativeModelProviderTrigger(
      { ...snapshot, available: false },
      registry.snapshot(),
    )).toBe(true)
    expect(canReplaceNativeModelProviderTrigger(
      { ...snapshot, available: false },
      { providers: [], entries: [], loading: false },
    )).toBe(false)
  })

  it('uses the audited current display name and never falls back to an internal model ID', async () => {
    const { update } = await setup()
    await update({ modelProvider: 'native', model: 'internal-route-id', modelLabel: 'GPT-6 Astra[Responses][Miniapp]' })
    expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('GPT-6 Astra')
    await update({ modelLabel: undefined })
    expect(document.querySelector(`${modelTrigger} .cxmp-model-label`)?.textContent).toBe('Choose model')
    expect(document.body.textContent).not.toContain('internal-route-id')
  })

  it('keeps slider arrow keys local and restores the correct trigger on Escape', async () => {
    await setup()
    await click(modelTrigger)
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    slider.focus()
    const key = new dom!.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    await act(async () => slider.dispatchEvent(key))
    expect(key.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(slider)
    await act(async () =>
      slider.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector('.cxmp-menu')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector(modelTrigger))
    await click(providerTrigger)
    expect(document.querySelector('input[type="range"]')).toBeNull()
    expect(document.querySelector(modelTrigger)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not assign the global native catalog to an unowned custom provider', async () => {
    const { update } = await setup()
    await update({
      modelProvider: 'gateway',
      providerLabel: 'Gateway',
      model: 'internal',
      modelLabel: 'Friendly',
      nativeModels: [
        { id: 'internal', label: 'Friendly[Miniapp]', disabled: false },
        { id: 'unavailable', label: 'Unavailable model', disabled: true },
      ],
    })
    await click(modelTrigger)
    const menu = document.querySelector('.cxmp-menu')!
    expect(menu.textContent).toContain('No models available')
    expect(menu.querySelector('.cxmp-model-choice')).toBeNull()
  })

  it('rejects a stale option even when it remains in the native global catalog', async () => {
    const { registry, select } = await setup('shared', false, {
      nativeModels: [{ id: 'shared', label: 'Global shared', disabled: false }],
    })
    await click(modelTrigger)
    const stale = document.querySelector<HTMLButtonElement>('.cxmp-model-choice')!
    const current = registry.snapshot()
    vi.spyOn(registry, 'snapshot').mockReturnValue({ ...current, providers: [] })
    await act(async () => stale.click())
    expect(select).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('disables reasoning while busy and reflects authoritative readback', async () => {
    const { update } = await setup('shared', true)
    await click(modelTrigger)
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(true)
    await update({ busy: false, reasoningEffort: 'low' })
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('0')
    expect(document.querySelector('input[type="range"]')?.getAttribute('aria-valuetext')).toBe('Light')
    expect(document.querySelector('.cxmp-selector > [role="status"]:not(.cxmp-announcement)')).toBeNull()
  })

  it('keeps the focused slider mounted and focusable during its own pending commit', async () => {
    const { selectReasoningEffort, update } = await setup()
    let finish!: () => void
    selectReasoningEffort.mockImplementationOnce(() =>
      new Promise(resolve => {
        finish = () => resolve('accepted')
      })
    )
    await click(modelTrigger)
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    slider.focus()
    await act(async () => {
      slider.value = '0'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
      slider.dispatchEvent(new dom!.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
    })
    await update({ busy: true })
    expect(slider.disabled).toBe(false)
    expect(slider.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(slider)
    await act(async () => finish())
    await update({ busy: false, reasoningEffort: 'low' })
    expect(slider.getAttribute('aria-valuetext')).toBe('Light')
  })

  it('cancels pending selection through the native provider even without native catalog entries', async () => {
    const { update, select } = await setup()
    await update({
      modelProvider: 'gateway',
      providerLabel: 'Gateway',
      model: 'native-model',
      modelLabel: 'Native model',
      nativeModels: [],
      pendingProviderId: 'second',
      pendingModel: 'shared',
    })
    await click(providerTrigger)
    const currentProvider = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(button => button.textContent?.includes('Gateway'))
    expect(currentProvider).toBeDefined()
    await act(async () => {
      currentProvider!.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(select).toHaveBeenCalledWith({ providerId: 'gateway', model: 'native-model' })
  })

  it('ignores a previous thread reasoning failure and unlocks the new thread immediately', async () => {
    const { selectReasoningEffort, update } = await setup()
    let fail!: (error: Error) => void
    selectReasoningEffort.mockImplementationOnce(() =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
    )
    await click(modelTrigger)
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    await act(async () => {
      slider.value = '0'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
      slider.dispatchEvent(new dom!.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
    })
    await update({ threadId: 't2', modelProvider: 'first', model: 'shared' })
    await click(modelTrigger)
    expect(document.querySelector('input[type="range"]')?.getAttribute('aria-busy')).toBe('false')
    await act(async () => fail(new Error('Old thread failed')))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the model menu honest for empty, loading and failed catalogs', async () => {
    const { registry, update } = await setup()
    await update({ modelProvider: 'unknown', nativeModels: [], reasoningEfforts: [] })
    await click(modelTrigger)
    expect(document.querySelector('.cxmp-menu')?.textContent).toContain('No models available')
    const current = registry.snapshot()
    vi.spyOn(registry, 'snapshot').mockReturnValue({ ...current, providers: [], entries: [], loading: true })
    await update({ busy: true })
    expect(document.querySelector('.cxmp-menu')?.textContent).toContain('Loading')
    vi.mocked(registry.snapshot).mockReturnValue({ ...current, loading: false, error: 'offline' })
    await update({ busy: false })
    expect(document.querySelector('.cxmp-retry')?.textContent).toContain('Could not load')
  })

  it('keeps background provider refreshes silent while the menu is open', async () => {
    const { registry, update } = await setup()
    await click(providerTrigger)
    const menu = document.querySelector('.cxmp-menu')
    const current = registry.snapshot()
    vi.spyOn(registry, 'snapshot').mockReturnValue({ ...current, loading: true })
    await update({ busy: true })
    expect(document.querySelector('.cxmp-menu')).toBe(menu)
    expect(menu?.textContent).not.toContain('Loading')
    expect(menu?.textContent).toContain('first')
    expect(menu?.textContent).toContain('second')
  })

  it('moves from model choices to the slider with Tab without losing menu focus', async () => {
    await setup()
    await click(modelTrigger)
    const choice = document.querySelector<HTMLButtonElement>('.cxmp-model-choice')!
    choice.focus()
    await act(async () =>
      choice.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    )
    expect(document.activeElement).toBe(document.querySelector('input[type="range"]'))
  })

  it('filters friendly names from the fixed search header and keeps the reasoning footer available', async () => {
    const { update } = await setup()
    await update({
      modelProvider: 'openai',
      model: 'sol',
      modelLabel: 'GPT-5.6-Sol',
      nativeModels: [
        { id: 'sol', label: 'GPT-5.6-Sol[Responses][Miniapp]', disabled: false },
        { id: 'astra', label: 'GPT-6-Astra', disabled: false },
      ],
    })
    await click(modelTrigger)
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(document.activeElement).toBe(search)
    expect(search.closest('.cxmp-menu-scroll')).toBeNull()
    const input = async (value: string) =>
      act(async () => {
        search.value = value
        search.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
      })
    await input('gpt SOL')
    expect(document.querySelectorAll('.cxmp-model-choice')).toHaveLength(1)
    expect(document.querySelector('.cxmp-model-choice')?.textContent).toBe('GPT-5.6-Sol')
    expect(document.activeElement).toBe(search)
    await input('Miniapp')
    expect(document.querySelectorAll('.cxmp-model-choice')).toHaveLength(0)
    expect(document.querySelector('.cxmp-menu')?.textContent).toContain('No matching models')
    expect(document.querySelector('input[type="range"]')).not.toBeNull()
    await click('[aria-label="Clear search"]')
    expect(document.querySelectorAll('.cxmp-model-choice')).toHaveLength(2)
    expect(document.activeElement).toBe(search)
    await act(async () =>
      search.dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      )
    )
    expect(document.activeElement).toBe(document.querySelector('.cxmp-model-choice'))
    await click(providerTrigger)
    expect(document.querySelector('input[type="search"]')).toBeNull()
    await click(modelTrigger)
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('')
  })

  it('keeps login actions operable while model routing is unavailable', async () => {
    const { registry, update } = await setup()
    const login = vi.fn()
    await act(async () => {
      registry.bind('offline', '1', () => true).facade.insert({
        id: 'login',
        label: 'Offline provider',
        icon: 'host:key',
        action: { label: 'Log in', icon: 'host:key', run: login },
      })
    })
    await update({ available: false })
    await click(providerTrigger)
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Model services unavailable')
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .every(button => button.disabled)).toBe(true)
    await click('[aria-label="Log in"]')
    expect(login).toHaveBeenCalledOnce()
  })
})
