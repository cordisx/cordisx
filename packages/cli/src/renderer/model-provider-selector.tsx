import { type SyntheticEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelProviderModelV1, ModelProviderV1 } from '@cordisx/protocol/model-providers/v1'
import { equivalentModel, type ModelProviderRegistry } from './model-providers.js'
import { HostBrandIcon } from './host-ui/HostBrandIcon.js'
import { BrainIcon } from './host-ui/BrainIcon.js'
import { CodexBrandIcon } from './host-ui/CodexBrandIcon.js'
import { HostIcon } from './host-ui/HostIcon.js'
import { HostMenuSurface } from './host-ui/HostMenu.js'
import { ModelBrandIcon } from './host-ui/ModelBrandIcon.js'
import { ProviderAction } from './model-provider-actions.js'
import { modelProviderCopy } from './model-provider-copy.js'
import { friendlyModelLabel } from './adapter/native-model-provider-seat.js'
import { nativeModelProviderInteractionAllowed } from './adapter/native-model-provider-interaction.js'
import { ProviderReasoningSlider } from './model-provider-reasoning.js'
import type { NativeProviderSubmitConfirmation, NativeSubmissionRejection } from './native-provider-selection-client.js'
import css from './model-providers.css?inline'
import { inferModelBrand } from '../model-selector-branding.js'

export interface NativeProviderModelOption {
  readonly id: string
  readonly label: string
  readonly disabled: boolean
  readonly supportsFastMode?: boolean
}

export interface NativeModelAssignment {
  readonly providerId: string
  readonly model: string
}

export interface ProviderSelectionSnapshot {
  readonly available: boolean
  readonly threadId?: string
  readonly modelProvider?: string
  readonly model?: string
  readonly modelLabel?: string | undefined
  readonly providerLabel?: string | undefined
  readonly nativeModels?: readonly NativeProviderModelOption[]
  readonly nativeModelsScope?: 'active-provider' | 'global'
  readonly nativeModelsProviderId?: string
  readonly nativeModelAssignments?: readonly NativeModelAssignment[]
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

export function providerMenuLabel(provider: Pick<ModelProviderV1, 'providerId' | 'title'>): string {
  if (provider.providerId === 'modelhub' && provider.title === 'ModelHub (Native Direct)') return 'ModelHub'
  if (provider.providerId === 'openrouter' && provider.title === 'OpenRouter (Native Responses)') return 'OpenRouter'
  return provider.title ?? provider.providerId
}

const searchTerms = (value: string, locale: string): readonly string[] =>
  value.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean)

const matchesTerms = (values: readonly string[], terms: readonly string[], locale: string): boolean => {
  const normalized = values.map(value => value.toLocaleLowerCase(locale))
  return terms.every(term => normalized.some(value => value.includes(term)))
}

export interface ProviderDisplayOrder {
  readonly usable: boolean
  readonly favorite: boolean
}

/** Keeps unusable rows visible first and places usable favorites nearest the bottom trigger. */
export function orderProviderRows<Row extends ProviderDisplayOrder>(rows: readonly Row[]): readonly Row[] {
  return [
    ...rows.filter(row => !row.usable),
    ...rows.filter(row => row.usable && !row.favorite),
    ...rows.filter(row => row.usable && row.favorite),
  ]
}

export function nativeModelsForProvider(
  snapshot: ProviderSelectionSnapshot,
  providerId: string,
): readonly NativeProviderModelOption[] {
  const models = snapshot.nativeModels ?? []
  if (snapshot.nativeModelsScope === 'active-provider') {
    return providerId === snapshot.nativeModelsProviderId ? models : []
  }
  if (snapshot.nativeModelsScope !== 'global') return models
  const assigned = new Set(
    (snapshot.nativeModelAssignments ?? [])
      .filter(assignment => assignment.providerId === providerId)
      .map(assignment => assignment.model),
  )
  return models.filter(model => assigned.has(model.id))
}

function ProviderMenuLabel({ provider }: { readonly provider: Pick<ModelProviderV1, 'providerId' | 'title'> }) {
  const label = providerMenuLabel(provider)
  const viewport = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const measureOverflow = () => {
    const viewportNode = viewport.current
    const textNode = text.current
    if (viewportNode === null || textNode === null) return
    const overflow = Math.max(0, textNode.scrollWidth - viewportNode.clientWidth)
    viewportNode.dataset.overflow = overflow > 0 ? 'true' : 'false'
    viewportNode.style.setProperty('--cxmp-label-overflow', `${overflow}px`)
  }
  return (
    <span
      ref={viewport}
      className="cxmp-provider-label"
      title={label}
      onMouseEnter={measureOverflow}
      onMouseLeave={measureOverflow}
    >
      <span ref={text} className="cxmp-provider-label-text">{label}</span>
    </span>
  )
}

export function ModelProviderSelector({ registry, transport, locale, suspended = false }: {
  readonly registry: ModelProviderRegistry
  readonly transport: ProviderSelectionTransport
  readonly locale: string
  readonly suspended?: boolean
}) {
  const catalog = useSyncExternalStore(registry.subscribe, registry.snapshot)
  const native = useSyncExternalStore(listener => transport.subscribe(listener), () => transport.getSnapshot())
  const [open, setOpen] = useState<'provider' | 'model'>()
  const [providerQuery, setProviderQuery] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [modelExpanded, setModelExpanded] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [fastActionPending, setFastActionPending] = useState(false)
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<string>()
  const anchor = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLButtonElement>(null)
  const providerTrigger = useRef<HTMLButtonElement>(null)
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const providerSearch = useRef<HTMLInputElement>(null)
  const modelSearch = useRef<HTMLInputElement>(null)
  const modelOptionsId = `cxmp-model-options-${useId().replace(/:/g, '')}`
  const operation = useRef(0)
  const reasoningInFlight = useRef<Promise<void> | undefined>(undefined)
  const fastActionInFlight = useRef<number | undefined>(undefined)
  const attemptedDraftPreference = useRef<string | undefined>(undefined)
  const canInteract = () => !suspended && nativeModelProviderInteractionAllowed(anchor.current)
  const blockInteraction = (event: SyntheticEvent) => {
    if (canInteract()) return
    event.preventDefault()
    event.stopPropagation()
  }
  const copy = modelProviderCopy(locale)
  const selected = catalog.providers.find(provider => provider.providerId === native.modelProvider)
  const selectedModel = selected?.models.find(model => model.id === native.model)
  const pendingProvider = catalog.providers.find(provider => provider.providerId === native.pendingProviderId)
  const pendingModel = pendingProvider?.models.find(model => model.id === native.pendingModel)
    ?? (native.pendingProviderId === 'openai'
      ? nativeModelsForProvider(native, 'openai')?.find(model => model.id === native.pendingModel)
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
      ? nativeModelsForProvider(native, 'openai')
      : [])
  const disclosedModel = menuModels.find(model => model.id === displayedModelId)
  const disclosedModelLabel = friendlyModelLabel(disclosedModel?.label ?? copy.choose)
  const showModelSearch = menuModels.length > 8
  const modelTerms = showModelSearch ? searchTerms(modelQuery, locale) : []
  const filteredModels = open === 'model'
    ? menuModels.filter(model => {
      const label = friendlyModelLabel(model.label).toLocaleLowerCase(locale)
      return modelTerms.every(term => label.includes(term))
    })
    : []
  const feedback = error ?? status
  const visibleMenuFeedback = open === 'model'
    ? error === copy.busy ? undefined : error
    : feedback
  const displayedNativeModel = nativeModelsForProvider(native, displayedProviderId)
    ?.find(model => model.id === displayedModelId)
  const supportsFastMode = displayedNativeModel?.supportsFastMode === true
  const fastMode = supportsFastMode && native.serviceTier === 'priority'
  const canQueueFast = reasoningInFlight.current !== undefined
  const fastDisabled = !native.available || !supportsFastMode || fastActionPending
    || ((native.busy || switching) && !canQueueFast)
  const showInitialLoading = catalog.loading
    && catalog.providers.length === 0
    && catalog.entries.length === 0
    && (native.nativeModels?.length ?? 0) === 0

  useEffect(() => {
    if (suspended) setOpen(undefined)
  }, [suspended])

  useEffect(() => {
    operation.current++
    reasoningInFlight.current = undefined
    fastActionInFlight.current = undefined
    setSwitching(false)
    setFastActionPending(false)
    setOpen(undefined)
    setError(undefined)
    setStatus(undefined)
    return () => {
      operation.current++
      reasoningInFlight.current = undefined
      fastActionInFlight.current = undefined
    }
  }, [native.threadId])

  useEffect(() => {
    setProviderQuery('')
    setModelQuery('')
    setModelExpanded(false)
  }, [open, native.modelProvider, native.pendingProviderId])

  useEffect(() => {
    if (!showModelSearch) setModelQuery('')
  }, [showModelSearch])

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

  const runReasoningEffort = async (effort: string) => {
    if (!canInteract()) return
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

  const selectReasoningEffort = (effort: string): Promise<void> => {
    const pending = runReasoningEffort(effort)
    reasoningInFlight.current = pending
    const clear = () => {
      if (reasoningInFlight.current === pending) reasoningInFlight.current = undefined
    }
    void pending.then(clear, clear)
    return pending
  }

  const selectFastMode = async (enabled: boolean) => {
    if (!canInteract() || fastActionInFlight.current !== undefined) return
    const pendingReasoning = reasoningInFlight.current
    const generation = ++operation.current
    fastActionInFlight.current = generation
    setFastActionPending(true)
    setSwitching(true)
    setError(undefined)
    setStatus(undefined)
    try {
      if (pendingReasoning !== undefined) await pendingReasoning
      if (generation !== operation.current || !canInteract()) return
      const result = await transport.selectFastMode(enabled)
      if (generation !== operation.current) return
      if (result !== 'accepted') setError(result === 'busy' ? copy.busy : copy.failed)
    } catch {
      if (generation === operation.current) setError(copy.failed)
    } finally {
      if (fastActionInFlight.current === generation) {
        fastActionInFlight.current = undefined
        setFastActionPending(false)
      }
      if (generation === operation.current) setSwitching(false)
    }
  }

  const apply = async (provider: Pick<ModelProviderV1, 'providerId'>, model: ModelProviderModelV1) => {
    if (!canInteract()) return
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
          && nativeModelsForProvider(transport.getSnapshot(), 'openai')
            ?.some(item => item.id === model.id && !item.disabled))
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
    if (!canInteract()) return
    if (registry.hasLiveSource()) return
    const preference = native.draftPreference
    if (preference === undefined || native.threadId !== undefined || native.pendingProviderId !== undefined) return
    const key = `${preference.generation}:${preference.revision}:${preference.providerId}`
    if (attemptedDraftPreference.current === key) return
    const provider = preference.providerId === 'openai'
      ? {
        providerId: 'openai',
        models: nativeModelsForProvider(native, 'openai')?.filter(model => !model.disabled) ?? [],
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
    native.nativeModelAssignments,
    native.nativeModels,
    native.pendingProviderId,
    native.threadId,
    registry,
    suspended,
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
    if (!canInteract()) return
    returnFocus.current = button
    const next = open === kind ? undefined : kind
    setOpen(next)
    // Live catalogs already invalidate the registry and reconcile periodically.
    // Avoid transferring and rebuilding the full catalog on the interaction turn.
    if (next !== undefined && !registry.hasLiveSource()) void registry.refresh()
  }
  const nativeProvider = {
    providerId: native.modelProvider ?? 'openai',
    title: providerLabel,
    models: nativeModelsForProvider(native, native.modelProvider ?? 'openai') ?? [],
  }
  const officialProvider = {
    providerId: 'openai',
    models: nativeModelsForProvider(native, 'openai')?.filter(model => !model.disabled) ?? [],
  }
  const providerRows = [
    {
      key: 'official',
      kind: 'official' as const,
      provider: officialProvider,
      label: copy.official,
      usable: officialProvider.models.length > 0,
      favorite: false,
    },
    ...(!selected && nativeProvider.providerId !== 'openai'
      ? [{
        key: `native:${nativeProvider.providerId}`,
        kind: 'native' as const,
        provider: nativeProvider,
        label: providerLabel,
        usable: native.model !== undefined,
        favorite: false,
      }]
      : []),
    ...catalog.providers.map(provider => ({
      key: `catalog:${provider.providerId}`,
      kind: 'catalog' as const,
      provider,
      label: providerMenuLabel(provider),
      usable: provider.models.length > 0,
      favorite: provider.providerFavorite === true,
    })),
  ]
  const providerTerms = searchTerms(providerQuery, locale)
  const orderedProviderRows = orderProviderRows(providerRows)
  const filteredProviderRows = orderedProviderRows.filter(row =>
    matchesTerms([row.label, row.provider.providerId], providerTerms, locale)
  )
  const showProviderSearch = providerRows.length > 5
  const reasoningEfforts = native.reasoningEfforts ?? []
  return (
    <div
      className="cxmp-selector"
      ref={anchor}
      inert={suspended}
      onPointerDownCapture={blockInteraction}
      onClickCapture={blockInteraction}
      onKeyDownCapture={blockInteraction}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <style>{css}</style>
      <button
        ref={providerTrigger}
        type="button"
        className="cxmp-trigger cxmp-provider-trigger"
        disabled={suspended}
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
            disabled={suspended || fastDisabled}
            aria-busy={fastActionPending}
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
        disabled={suspended}
        data-cordisx-model-ready={native.available && displayedModel !== undefined && !switching ? 'true' : undefined}
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
        open={!suspended && open !== undefined}
        canFocus={canInteract}
        label={open === 'provider' ? copy.providers : copy.models}
        anchorRef={anchor}
        returnFocusRef={returnFocus}
        align="end"
        className="cxmp-menu"
        onClose={close}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'),
          ].filter(item => item.closest('[inert]') === null)
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
        {visibleMenuFeedback
          ? (
            <div className={error ? 'cxmp-menu-heading cxmp-error' : 'cxmp-menu-heading'}>
              {visibleMenuFeedback}
            </div>
          )
          : null}
        {native.busy && open !== 'model'
          ? <div className="cxmp-menu-heading" role="status">{copy.busy}</div>
          : null}
        <div className={open === 'provider' ? 'cxmp-menu-scroll' : 'cxmp-model-menu-body'}>
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
                {filteredProviderRows.map(row => (
                  <button
                    type="button"
                    className="cxmp-choice"
                    role="menuitemradio"
                    data-provider-id={row.provider.providerId}
                    key={row.key}
                    aria-checked={row.provider.providerId === displayedProviderId}
                    data-menu-initial={row.provider.providerId === displayedProviderId || undefined}
                    disabled={!native.available || switching || native.busy || !row.usable}
                    onClick={() => {
                      if (row.kind === 'native') {
                        if (native.model) choose(row.provider, { id: native.model, label: selectedModelLabel })
                        return
                      }
                      const model = selectionModelForProvider(displayedModel, row.provider, locale)
                      if (model) choose(row.provider, model)
                    }}
                  >
                    {row.kind === 'official'
                      ? <CodexBrandIcon />
                      : row.kind === 'native'
                      ? (
                        <span className="cxmp-provider-monogram" aria-hidden="true">
                          {providerLabel.slice(0, 1).toUpperCase()}
                        </span>
                      )
                      : row.provider.selectorBrand !== undefined
                      ? <ModelBrandIcon brand={row.provider.selectorBrand} kind="provider" />
                      : <HostBrandIcon icon={row.provider.icon} />}
                    {row.kind === 'catalog'
                      ? <ProviderMenuLabel provider={row.provider} />
                      : <span>{row.label}</span>}
                    {row.provider.providerId === displayedProviderId
                      ? <HostIcon token="control.check" />
                      : <span />}
                  </button>
                ))}
                {providerTerms.length > 0 && filteredProviderRows.length === 0
                  ? <div className="cxmp-menu-heading" role="status">{copy.noProviderMatches}</div>
                  : null}
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
                {reasoningEfforts.length > 0 || displayedNativeModel !== undefined
                  ? (
                    <div className="cxmp-model-controls">
                      <button
                        type="button"
                        className="cxmp-fast-toggle"
                        aria-label={fastMode ? copy.disableFastMode : copy.enableFastMode}
                        title={fastMode ? copy.disableFastMode : copy.enableFastMode}
                        aria-pressed={fastMode}
                        disabled={fastDisabled}
                        aria-busy={fastActionPending}
                        onClick={() => void selectFastMode(!fastMode)}
                      >
                        <HostIcon
                          surfaceToken="host:bolt"
                          token="status.info"
                          state={fastMode ? 'active' : 'default'}
                        />
                      </button>
                      {reasoningEfforts.length > 0
                        ? (
                          <ProviderReasoningSlider
                            key={JSON.stringify([native.modelProvider, native.model, reasoningEfforts])}
                            efforts={reasoningEfforts}
                            value={native.reasoningEffort}
                            disabled={!native.available || (native.busy && !switching)}
                            pending={switching}
                            fast={fastMode}
                            label={copy.reasoningEffort}
                            labelFor={copy.reasoningEffortLabel}
                            commit={selectReasoningEffort}
                          />
                        )
                        : null}
                    </div>
                  )
                  : null}
                <button
                  type="button"
                  className="cxmp-model-disclosure"
                  aria-expanded={modelExpanded}
                  aria-controls={modelOptionsId}
                  data-menu-initial={reasoningEfforts.length === 0 || undefined}
                  onClick={() => setModelExpanded(value => !value)}
                >
                  {modelExpanded
                    ? <BrainIcon className="cxmp-model-disclosure-leading" />
                    : (
                      <ModelBrandIcon
                        brand={disclosedModel === undefined
                          ? undefined
                          : ('selectorBrand' in disclosedModel ? disclosedModel.selectorBrand : undefined)
                            ?? inferModelBrand(disclosedModel.id, disclosedModel.label)}
                        kind="model"
                      />
                    )}
                  <span>{modelExpanded ? copy.choose : disclosedModelLabel}</span>
                  <HostIcon token="control.chevron-down" className="cxmp-model-disclosure-chevron" />
                </button>
                <div
                  id={modelOptionsId}
                  className="cxmp-model-options"
                  data-expanded={modelExpanded || undefined}
                  aria-hidden={!modelExpanded}
                  inert={!modelExpanded}
                >
                  <div className="cxmp-model-options-inner">
                    <div className="cxmp-menu-scroll">
                      {filteredModels.map(model => (
                        <button
                          key={model.id}
                          type="button"
                          className="cxmp-choice cxmp-model-choice"
                          role="menuitemradio"
                          aria-checked={model.id === displayedModelId}
                          disabled={!modelExpanded || !native.available || switching || native.busy
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
                            {modelTerms.length ? copy.noMatches : copy.emptyModels}
                          </div>
                        )
                        : null}
                    </div>
                    {showModelSearch
                      ? (
                        <div className="cxmp-search cxmp-search-bottom">
                          <HostIcon token="action.search" />
                          <input
                            ref={modelSearch}
                            type="search"
                            aria-label={copy.searchModels}
                            placeholder={copy.searchModels}
                            value={modelQuery}
                            disabled={!modelExpanded}
                            onChange={event => setModelQuery(event.currentTarget.value)}
                            onInput={event => setModelQuery(event.currentTarget.value)}
                            onKeyDown={event => {
                              if (event.nativeEvent.isComposing) return
                              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                event.preventDefault()
                                const choices = event.currentTarget.closest('.cxmp-model-options')
                                  ?.querySelectorAll<HTMLButtonElement>('.cxmp-model-choice:not(:disabled)')
                                const choice = event.key === 'ArrowUp' ? choices?.[choices.length - 1] : choices?.[0]
                                choice?.focus()
                                choice?.scrollIntoView?.({ block: 'nearest' })
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="cxmp-icon-action"
                            aria-label={copy.clearSearch}
                            title={copy.clearSearch}
                            disabled={!modelExpanded || modelQuery.length === 0}
                            onClick={() => {
                              setModelQuery('')
                              modelSearch.current?.focus()
                            }}
                          >
                            <HostIcon token="action.close" />
                          </button>
                        </div>
                      )
                      : null}
                  </div>
                </div>
              </>
            )}
        </div>
        {open === 'provider' && showProviderSearch
          ? (
            <div className="cxmp-search cxmp-search-bottom">
              <HostIcon token="action.search" />
              <input
                ref={providerSearch}
                type="search"
                aria-label={copy.searchProviders}
                placeholder={copy.searchProviders}
                value={providerQuery}
                onChange={event => setProviderQuery(event.currentTarget.value)}
                onInput={event => setProviderQuery(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const choices = event.currentTarget.closest('.cxmp-menu')?.querySelectorAll<HTMLButtonElement>(
                      '.cxmp-choice[role="menuitemradio"]:not(:disabled)',
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
                disabled={providerQuery.length === 0}
                onClick={() => {
                  setProviderQuery('')
                  providerSearch.current?.focus()
                }}
              >
                <HostIcon token="action.close" />
              </button>
            </div>
          )
          : null}
      </HostMenuSurface>
    </div>
  )
}
