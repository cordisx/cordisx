import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelProviderModelV1, ModelProviderV1 } from '@cordisx/protocol/model-providers/v1'
import { equivalentModel, type ModelProviderRegistry } from './model-providers.js'
import { HostBrandIcon } from './host-ui/HostBrandIcon.js'
import { CodexBrandIcon } from './host-ui/CodexBrandIcon.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { HostMenuSurface } from './host-ui/HostMenu.js'
import { ModelBrandIcon } from './host-ui/ModelBrandIcon.js'
import { ProviderAction } from './model-provider-actions.js'
import { modelProviderCopy } from './model-provider-copy.js'
import { friendlyModelLabel } from './adapter/native-model-provider-seat.js'
import { ProviderReasoningSlider } from './model-provider-reasoning.js'
import type { NativeProviderSubmitConfirmation, NativeSubmissionRejection } from './native-provider-selection-client.js'
import css from './model-providers.css?inline'
import { inferModelBrand } from '../model-selector-branding.js'

export interface ProviderSelectionSnapshot {
  readonly available: boolean
  readonly threadId?: string
  readonly modelProvider?: string
  readonly model?: string
  readonly modelLabel?: string | undefined
  readonly providerLabel?: string | undefined
  readonly nativeModels?: readonly {
    readonly id: string
    readonly label: string
    readonly disabled: boolean
    readonly supportsFastMode?: boolean
  }[]
  readonly reasoningEffort?: string
  readonly reasoningEfforts?: readonly string[]
  readonly serviceTier?: 'priority' | null
  readonly busy: boolean
  readonly pendingProviderId?: string
  readonly pendingModel?: string
  readonly confirmation?: NativeProviderSubmitConfirmation
  readonly submissionError?: NativeSubmissionRejection
  readonly draftPreference?: Readonly<{
    readonly providerId: string
    readonly generation: number
    readonly revision: number
  }>
}

export interface ProviderSelectionTransport {
  getSnapshot(): ProviderSelectionSnapshot
  subscribe(listener: () => void): () => void
  select(
    target: { readonly providerId: string; readonly model: string },
    options?: Readonly<{ source: 'preference'; expectedRevision: number }>,
  ): Promise<'accepted' | 'busy' | 'unavailable'>
  selectReasoningEffort(reasoningEffort: string): Promise<'accepted' | 'busy' | 'unavailable'>
  selectFastMode(enabled: boolean): Promise<'accepted' | 'busy' | 'unavailable'>
  confirmSubmission?(confirmed: boolean): void
}

export function selectionModelForProvider(
  current: ModelProviderModelV1 | undefined,
  provider: Pick<ModelProviderV1, 'models' | 'defaultModelId'>,
  locale: string,
): ModelProviderModelV1 | undefined {
  const equivalent = current === undefined ? undefined : equivalentModel(current, provider.models)
  if (equivalent !== undefined) return equivalent
  if (current !== undefined) {
    const currentName = friendlyModelLabel(current.label).toLocaleLowerCase(locale)
    const sameName = provider.models.filter(model =>
      friendlyModelLabel(model.label).toLocaleLowerCase(locale) === currentName
    )
    if (sameName.length === 1) return sameName[0]
  }
  return provider.models.find(model => model.id === provider.defaultModelId) ?? provider.models[0]
}

export function ModelProviderSelector({ registry, transport, locale }: {
  readonly registry: ModelProviderRegistry
  readonly transport: ProviderSelectionTransport
  readonly locale: string
}) {
  const catalog = useSyncExternalStore(registry.subscribe, registry.snapshot)
  const native = useSyncExternalStore(listener => transport.subscribe(listener), () => transport.getSnapshot())
  const [open, setOpen] = useState<'provider' | 'model'>()
  const [query, setQuery] = useState('')
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<string>()
  const anchor = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLButtonElement>(null)
  const providerTrigger = useRef<HTMLButtonElement>(null)
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const operation = useRef(0)
  const attemptedDraftPreference = useRef<string | undefined>(undefined)
  const copy = modelProviderCopy(locale)
  const selected = catalog.providers.find(provider => provider.providerId === native.modelProvider)
  const selectedModel = selected?.models.find(model => model.id === native.model)
  const pendingProvider = catalog.providers.find(provider => provider.providerId === native.pendingProviderId)
  const pendingModel = pendingProvider?.models.find(model => model.id === native.pendingModel)
    ?? (native.pendingProviderId === 'openai'
      ? native.nativeModels?.find(model => model.id === native.pendingModel)
      : undefined)
  const effectiveModel = selectedModel ?? (native.model === undefined
    ? undefined
    : { id: native.model, label: native.modelLabel ?? copy.choose })
  const selectedModelLabel = friendlyModelLabel(effectiveModel?.label ?? copy.choose)
  const providerLabel = selected?.title
    ?? (native.modelProvider === undefined || native.modelProvider === 'openai'
      ? copy.official
      : native.providerLabel ?? copy.unknown)
  const displayedProvider = pendingProvider ?? selected
  const displayedProviderId = native.pendingProviderId ?? native.modelProvider ?? 'openai'
  const displayedProviderLabel = displayedProviderId === 'openai'
    ? copy.official
    : displayedProvider?.title ?? providerLabel
  const displayedModel = pendingModel ?? effectiveModel
  const displayedModelId = displayedModel?.id
  const displayedModelLabel = friendlyModelLabel(displayedModel?.label ?? copy.choose)
  const menuProvider = native.pendingProviderId === undefined ? selected : pendingProvider
  const menuModels = menuProvider?.models
    ?? (displayedProviderId === 'openai'
      ? native.nativeModels ?? []
      : [])
  const terms = query.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean)
  const filteredModels = menuModels.filter(model => {
    const label = friendlyModelLabel(model.label).toLocaleLowerCase(locale)
    return terms.every(term => label.includes(term))
  })
  const feedback = error ?? status
  const displayedNativeModel = native.nativeModels?.find(model => model.id === displayedModelId)
  const supportsFastMode = displayedNativeModel?.supportsFastMode === true
  const fastMode = supportsFastMode && native.serviceTier === 'priority'
  const showInitialLoading = catalog.loading
    && catalog.providers.length === 0
    && catalog.entries.length === 0
    && (native.nativeModels?.length ?? 0) === 0

  useEffect(() => {
    operation.current++
    setSwitching(false)
    setOpen(undefined)
    setError(undefined)
    setStatus(undefined)
    return () => {
      operation.current++
    }
  }, [native.threadId])

  useEffect(() => {
    setQuery('')
  }, [open, native.modelProvider])

  useEffect(() => {
    if (native.submissionError !== undefined) {
      setStatus(undefined)
      setError(
        native.submissionError === 'unsupported-submission-intent' ? copy.unsupportedIntent : copy.submitRejected,
      )
    } else {
      setError(current => current === copy.unsupportedIntent || current === copy.submitRejected ? undefined : current)
    }
  }, [native.submissionError, copy.unsupportedIntent, copy.submitRejected])

  const selectReasoningEffort = async (effort: string) => {
    const generation = ++operation.current
    setSwitching(true)
    setError(undefined)
    setStatus(copy.switching)
    try {
      const result = await transport.selectReasoningEffort(effort)
      if (generation !== operation.current) return
      if (result !== 'accepted') {
        setStatus(undefined)
        setError(result === 'busy' ? copy.busy : copy.failed)
      } else if (transport.getSnapshot().reasoningEffort === effort) setStatus(copy.updated)
      else setStatus(copy.accepted)
    } catch {
      if (generation !== operation.current) return
      setStatus(undefined)
      setError(copy.failed)
    } finally {
      if (generation === operation.current) setSwitching(false)
    }
  }

  const selectFastMode = async (enabled: boolean) => {
    const generation = ++operation.current
    setSwitching(true)
    setError(undefined)
    setStatus(undefined)
    try {
      const result = await transport.selectFastMode(enabled)
      if (generation !== operation.current) return
      if (result !== 'accepted') setError(result === 'busy' ? copy.busy : copy.failed)
    } catch {
      if (generation === operation.current) setError(copy.failed)
    } finally {
      if (generation === operation.current) setSwitching(false)
    }
  }

  const apply = async (provider: Pick<ModelProviderV1, 'providerId'>, model: ModelProviderModelV1) => {
    const generation = ++operation.current
    setSwitching(true)
    setError(undefined)
    setStatus(copy.switching)
    setOpen(undefined)
    returnFocus.current?.focus({ preventScroll: true })
    try {
      const current = transport.getSnapshot()
      const cancelPending = current.pendingProviderId !== undefined
        && current.modelProvider === provider.providerId && current.model === model.id
      // Recheck catalog membership after confirmation; revoked services never switch.
      if (
        !cancelPending
        && !(provider.providerId === 'openai'
          && transport.getSnapshot().nativeModels?.some(item => item.id === model.id && !item.disabled))
        && !registry.snapshot().providers.some(item =>
          item.providerId === provider.providerId
          && item.models.some(candidate => candidate.id === model.id)
        )
      ) throw new Error('Provider retired')
      const result = await transport.select({ providerId: provider.providerId, model: model.id })
      if (generation !== operation.current) return
      if (result !== 'accepted') {
        setStatus(undefined)
        setError(result === 'busy' ? copy.busy : copy.failed)
      } else setStatus(undefined)
    } catch {
      if (generation !== operation.current) return
      setStatus(undefined)
      setError(copy.failed)
    } finally {
      if (generation === operation.current) setSwitching(false)
    }
  }

  useEffect(() => {
    // A newly discovered member must not turn a catalog update into a native selection.
    if (registry.hasLiveSource()) return
    const preference = native.draftPreference
    if (preference === undefined || native.threadId !== undefined || native.pendingProviderId !== undefined) return
    const key = `${preference.generation}:${preference.revision}:${preference.providerId}`
    if (attemptedDraftPreference.current === key) return
    const provider = preference.providerId === 'openai'
      ? {
        providerId: 'openai',
        models: (native.nativeModels ?? []).filter(model => !model.disabled),
      }
      : catalog.providers.find(candidate => candidate.providerId === preference.providerId)
    if (provider === undefined) return
    const model = selectionModelForProvider(displayedModel, provider, locale)
    if (model === undefined) return
    attemptedDraftPreference.current = key
    void transport.select(
      { providerId: provider.providerId, model: model.id },
      { source: 'preference', expectedRevision: preference.revision },
    )
  }, [
    catalog.providers,
    displayedModel,
    locale,
    native.draftPreference,
    native.nativeModels,
    native.pendingProviderId,
    native.threadId,
    registry,
    transport,
  ])

  const choose = (provider: Pick<ModelProviderV1, 'providerId'>, model: ModelProviderModelV1) => {
    if (native.busy) {
      setError(copy.busy)
      return
    }
    void apply(provider, model)
  }

  const close = () => {
    setOpen(undefined)
  }
  const toggle = (kind: 'provider' | 'model', button: HTMLButtonElement) => {
    returnFocus.current = button
    setOpen(current => current === kind ? undefined : kind)
    void registry.refresh()
  }
  const nativeProvider = {
    providerId: native.modelProvider ?? 'openai',
    title: providerLabel,
    models: native.nativeModels ?? [],
  }
  const officialProvider = {
    providerId: 'openai',
    models: (native.nativeModels ?? []).filter(model => !model.disabled),
  }
  const reasoningEfforts = native.reasoningEfforts ?? []
  return (
    <div
      className="cxmp-selector"
      ref={anchor}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <style>{css}</style>
      <button
        ref={providerTrigger}
        type="button"
        className="cxmp-trigger cxmp-provider-trigger"
        aria-label={`${copy.providers}: ${displayedProviderLabel}`}
        title={displayedProviderLabel}
        aria-haspopup="menu"
        aria-expanded={open === 'provider'}
        data-pending={native.pendingProviderId !== undefined || undefined}
        onClick={event => toggle('provider', event.currentTarget)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            returnFocus.current = event.currentTarget
            setOpen('provider')
          }
        }}
      >
        {displayedProviderId === 'openai'
          ? <CodexBrandIcon />
          : displayedProvider?.selectorBrand !== undefined
          ? <ModelBrandIcon brand={displayedProvider.selectorBrand} kind="provider" />
          : displayedProvider?.icon
          ? <HostBrandIcon icon={displayedProvider.icon} />
          : (
            <span className="cxmp-provider-monogram" aria-hidden="true">
              {displayedProviderLabel.slice(0, 1).toUpperCase()}
            </span>
          )}
      </button>
      {fastMode
        ? (
          <button
            type="button"
            className="cxmp-fast-trigger"
            aria-label={copy.disableFastMode}
            title={copy.disableFastMode}
            aria-pressed="true"
            disabled={!native.available || native.busy || switching}
            onClick={() => void selectFastMode(false)}
          >
            <HostIcon surfaceToken="host:bolt" token="status.info" state="active" />
          </button>
        )
        : null}
      <button
        ref={modelTrigger}
        type="button"
        className="cxmp-trigger cxmp-model-trigger"
        aria-label={`${copy.models}: ${displayedModelLabel}`}
        title={displayedModelLabel}
        aria-haspopup="menu"
        aria-expanded={open === 'model'}
        onClick={event => toggle('model', event.currentTarget)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            returnFocus.current = event.currentTarget
            setOpen('model')
          }
        }}
      >
        <span className="cxmp-model-label">{displayedModelLabel}</span>
        <span className="cxmp-model-separator" aria-hidden="true" />
        <span className="cxmp-effort-label">{copy.reasoningEffortLabel(native.reasoningEffort)}</span>
      </button>
      {feedback ? <span role={error ? 'alert' : 'status'} className="cxmp-announcement">{feedback}</span> : null}
      <HostMenuSurface
        open={open !== undefined}
        label={open === 'provider' ? copy.providers : copy.models}
        anchorRef={anchor}
        returnFocusRef={returnFocus}
        className="cxmp-menu"
        onClose={close}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'),
          ]
          const index = items.indexOf(document.activeElement as HTMLElement)
          const next = items[index + (event.shiftKey ? -1 : 1)]
          event.preventDefault()
          if (next) next.focus()
          else {
            close()
            returnFocus.current?.focus({ preventScroll: true })
          }
        }}
      >
        {open === 'model'
          ? (
            <div className="cxmp-search">
              <HostIcon token="action.search" />
              <input
                ref={search}
                type="search"
                aria-label={copy.searchModels}
                placeholder={copy.searchModels}
                value={query}
                data-menu-initial="true"
                onChange={event => setQuery(event.currentTarget.value)}
                onInput={event => setQuery(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const choices = event.currentTarget.closest('.cxmp-menu')?.querySelectorAll<HTMLButtonElement>(
                      '.cxmp-model-choice:not(:disabled)',
                    )
                    const choice = event.key === 'ArrowUp' ? choices?.[choices.length - 1] : choices?.[0]
                    choice?.focus()
                  }
                }}
              />
              <button
                type="button"
                className="cxmp-icon-action"
                aria-label={copy.clearSearch}
                title={copy.clearSearch}
                disabled={query.length === 0}
                onClick={() => {
                  setQuery('')
                  search.current?.focus()
                }}
              >
                <HostIcon token="action.close" />
              </button>
            </div>
          )
          : null}
        {feedback
          ? <div className={error ? 'cxmp-menu-heading cxmp-error' : 'cxmp-menu-heading'}>{feedback}</div>
          : null}
        {native.busy ? <div className="cxmp-menu-heading" role="status">{copy.busy}</div> : null}
        <div className="cxmp-menu-scroll">
          {!native.available ? <div className="cxmp-menu-heading" role="status">{copy.unavailable}</div> : null}
          {showInitialLoading ? <div className="cxmp-menu-heading" role="status">{copy.loading}</div> : null}
          {catalog.error
            ? (
              <button type="button" role="menuitem" className="cxmp-retry" onClick={() => void registry.refresh()}>
                {copy.loadFailed}
              </button>
            )
            : null}
          {open === 'provider'
            ? (
              <>
                <button
                  type="button"
                  className="cxmp-choice"
                  role="menuitemradio"
                  aria-checked={displayedProviderId === 'openai'}
                  data-menu-initial={displayedProviderId === 'openai' || undefined}
                  disabled={!native.available || switching || native.busy || officialProvider.models.length === 0}
                  onClick={() => {
                    const model = selectionModelForProvider(displayedModel, officialProvider, locale)
                    if (model) choose(officialProvider, model)
                  }}
                >
                  <CodexBrandIcon />
                  <span>{copy.official}</span>
                  {displayedProviderId === 'openai' ? <HostIcon token="control.check" /> : <span />}
                </button>
                {!selected && nativeProvider.providerId !== 'openai'
                  ? (
                    <button
                      type="button"
                      className="cxmp-choice"
                      role="menuitemradio"
                      aria-checked={displayedProviderId === nativeProvider.providerId}
                      disabled={!native.available || switching || !native.model}
                      onClick={() => {
                        if (native.model) choose(nativeProvider, { id: native.model, label: selectedModelLabel })
                      }}
                    >
                      <span className="cxmp-provider-monogram" aria-hidden="true">
                        {providerLabel.slice(0, 1).toUpperCase()}
                      </span>
                      <span>{providerLabel}</span>
                      {displayedProviderId === nativeProvider.providerId
                        ? <HostIcon token="control.check" />
                        : <span />}
                    </button>
                  )
                  : null}
                {catalog.providers.map(provider => (
                  <button
                    type="button"
                    className="cxmp-choice"
                    role="menuitemradio"
                    data-provider-id={provider.providerId}
                    key={provider.providerId}
                    aria-checked={provider.providerId === displayedProviderId}
                    data-menu-initial={provider.providerId === displayedProviderId || undefined}
                    disabled={!native.available || switching || native.busy || provider.models.length === 0}
                    onClick={() => {
                      const model = selectionModelForProvider(displayedModel, provider, locale)
                      if (model) choose(provider, model)
                    }}
                  >
                    {provider.selectorBrand !== undefined
                      ? <ModelBrandIcon brand={provider.selectorBrand} kind="provider" />
                      : <HostBrandIcon icon={provider.icon} />}
                    <span>{provider.title}</span>
                    {provider.providerId === displayedProviderId ? <HostIcon token="control.check" /> : <span />}
                  </button>
                ))}
                {catalog.entries.map(({ key, entry, notifications }) => (
                  <ProviderAction
                    key={key}
                    entry={entry}
                    failed={copy.actionFailed}
                    refresh={registry.refresh}
                    {...(notifications === undefined ? {} : { notifications })}
                  />
                ))}
              </>
            )
            : (
              <>
                {filteredModels.map(model => (
                  <button
                    key={model.id}
                    type="button"
                    className="cxmp-choice cxmp-model-choice"
                    role="menuitemradio"
                    aria-checked={model.id === displayedModelId}
                    data-menu-initial={model.id === displayedModelId || undefined}
                    disabled={!native.available || switching || native.busy
                      || ('disabled' in model && model.disabled === true)}
                    onClick={() => {
                      const provider = menuProvider
                        ?? (native.pendingProviderId === 'openai' ? officialProvider : nativeProvider)
                      if (provider) choose(provider, model)
                    }}
                  >
                    <ModelBrandIcon
                      brand={('selectorBrand' in model ? model.selectorBrand : undefined)
                        ?? inferModelBrand(model.id, model.label)}
                      kind="model"
                    />
                    <span>{friendlyModelLabel(model.label)}</span>
                    {model.id === displayedModelId ? <HostIcon token="control.check" /> : <span />}
                  </button>
                ))}
                {filteredModels.length === 0
                  ? (
                    <div className="cxmp-menu-heading" role="status">
                      {terms.length ? copy.noMatches : copy.emptyModels}
                    </div>
                  )
                  : null}
              </>
            )}
        </div>
        {open === 'model' && (reasoningEfforts.length > 0 || displayedNativeModel !== undefined)
          ? (
            <div className="cxmp-model-controls">
              <button
                type="button"
                className="cxmp-fast-toggle"
                aria-label={fastMode ? copy.disableFastMode : copy.enableFastMode}
                title={fastMode ? copy.disableFastMode : copy.enableFastMode}
                aria-pressed={fastMode}
                disabled={!native.available || native.busy || switching || !supportsFastMode}
                onClick={() => void selectFastMode(!fastMode)}
              >
                <HostIcon surfaceToken="host:bolt" token="status.info" state={fastMode ? 'active' : 'default'} />
              </button>
              {reasoningEfforts.length > 0
                ? (
                  <ProviderReasoningSlider
                    efforts={reasoningEfforts}
                    value={native.reasoningEffort}
                    disabled={!native.available || (native.busy && !switching)}
                    pending={switching}
                    label={copy.reasoningEffort}
                    labelFor={copy.reasoningEffortLabel}
                    commit={selectReasoningEffort}
                  />
                )
                : null}
            </div>
          )
          : null}
      </HostMenuSurface>
    </div>
  )
}
