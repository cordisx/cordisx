import type { Context } from '@deepseek-ai/cordis'
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'cordisx/react'
import type {
  CordisXModelDescriptor,
  CordisXPlatformModelRef,
  CordisXPlatformSessionRef,
  CordisXReactPageProps,
  CordisXSessionProjection,
  CordisXSessionSummary,
} from '../../contracts.js'

export interface ProviderFleetConfig {
  readonly providerIds: readonly string[]
  readonly defaultCwd: string
}

export interface ProviderFleetMessages {
  'page.subtitle': undefined
  'field.provider': undefined
  'field.model': undefined
  'field.cwd': undefined
  'field.initial-message': undefined
  'field.search': undefined
  'action.refresh': undefined
  'action.create': undefined
  'action.load-more': undefined
  'action.continue': undefined
  'action.fork': undefined
  'action.archive': undefined
  'action.restore': undefined
  'action.delete': undefined
  'action.send': undefined
  'action.steer': undefined
  'action.interrupt': undefined
  'state.loading': undefined
  'state.empty': undefined
  'state.no-models': undefined
  'state.select-session': undefined
  'state.error': { readonly message: string }
  'session.provider': { readonly provider: string }
  'session.model': { readonly model: string }
}

export function modelKey(ref: CordisXPlatformModelRef): string {
  return JSON.stringify([ref.providerId, ref.modelId])
}

export function parsedModel(value: string): CordisXPlatformModelRef | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string')
      ? { providerId: parsed[0] as string, modelId: parsed[1] as string }
      : undefined
  } catch {
    return undefined
  }
}

export function sessionKey(ref: CordisXPlatformSessionRef): string {
  return JSON.stringify([ref.providerId, ref.remoteSessionId])
}

export function useProviderFleetModel(
  ctx: Context,
  config: ProviderFleetConfig,
  t: CordisXReactPageProps<ProviderFleetMessages>['t'],
) {
  const configuredProviders = useMemo(
    () => config.providerIds.length === 0 ? undefined : [...new Set(config.providerIds)],
    [],
  )
  const [models, setModels] = useState<readonly CordisXModelDescriptor[]>([])
  const [sessions, setSessions] = useState<readonly CordisXSessionSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selected, setSelected] = useState<CordisXSessionProjection | CordisXSessionSummary>()
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [cwd, setCwd] = useState(config.defaultCwd)
  const [search, setSearch] = useState('')
  const [initialMessage, setInitialMessage] = useState('')
  const [composer, setComposer] = useState('')
  const [steer, setSteer] = useState('')
  const [status, setStatus] = useState('')

  const showError = (error: { readonly message: string }) => setStatus(t('state.error', { message: error.message }))
  const providerIds = provider === ''
    ? configuredProviders ?? [...new Set(models.map(item => item.ref.providerId))].sort()
    : [provider]
  const visibleModels = models.filter(item => provider === '' || item.ref.providerId === provider)

  const refreshSessions = useCallback(
    async (cursor?: string, append = false, requestedProviderIds?: readonly string[]) => {
      setStatus(t('state.loading'))
      const result = await ctx.platform.tasks.list({
        ...((requestedProviderIds ?? providerIds).length === 0
          ? {}
          : { providerIds: requestedProviderIds ?? providerIds }),
        ...(cwd.trim() === '' ? {} : { cwd: cwd.trim() }),
        ...(search.trim() === '' ? {} : { searchTerm: search.trim() }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: 50,
      })
      if (!result.ok) {
        showError(result.error)
        return
      }
      setSessions(current =>
        append
          ? [
            ...current,
            ...result.value.sessions.filter(item =>
              !new Set(current.map(entry => sessionKey(entry.ref))).has(sessionKey(item.ref))
            ),
          ]
          : result.value.sessions
      )
      setNextCursor(result.value.nextCursor)
      setStatus(models.length === 0 ? t('state.no-models') : '')
    },
    [provider, cwd, search, models, t],
  )

  const refreshAll = useCallback(async () => {
    setStatus(t('state.loading'))
    const result = await ctx.platform.models.list(
      configuredProviders === undefined ? {} : { providerIds: configuredProviders },
    )
    if (!result.ok) {
      showError(result.error)
      return
    }
    setModels(result.value.models)
    const nextVisible = result.value.models.filter(item => provider === '' || item.ref.providerId === provider)
    setModel(current =>
      nextVisible.some(item => modelKey(item.ref) === current)
        ? current
        : modelKey(
          (nextVisible.find(item => item.isDefault) ?? nextVisible[0])?.ref ?? { providerId: '', modelId: '' },
        )
    )
    const discoveredProviders = configuredProviders
      ?? [...new Set(result.value.models.map(item => item.ref.providerId))].sort()
    await refreshSessions(undefined, false, provider === '' ? discoveredProviders : [provider])
  }, [provider, refreshSessions, t])

  useEffect(() => {
    void refreshAll()
  }, [])

  const read = async (ref: CordisXPlatformSessionRef) => {
    const result = await ctx.platform.tasks.read({ session: ref })
    if (!result.ok) showError(result.error)
    else setSelected(result.value)
  }
  const create = async () => {
    const selectedModel = parsedModel(model)
    if (selectedModel === undefined || cwd.trim() === '') return
    const result = await ctx.platform.tasks.create({
      model: selectedModel,
      cwd: cwd.trim(),
      ...(initialMessage.trim() === '' ? {} : { initialMessage: initialMessage.trim() }),
    })
    if (!result.ok) {
      showError(result.error)
      return
    }
    setSelected(result.value.session)
    setInitialMessage('')
    if (result.value.status === 'created-initial-turn-failed') showError(result.value.error)
    await refreshSessions()
    if (result.value.status === 'created' && result.value.initialTurn !== undefined) {
      await read(result.value.session.ref)
    }
  }
  const controlSession = async (action: 'continue' | 'fork' | 'archive' | 'restore' | 'delete') => {
    if (selected === undefined) return
    const result = await ctx.platform.tasks.control(
      { action, session: selected.ref } as Parameters<typeof ctx.platform.tasks.control>[0],
    )
    if (!result.ok) {
      showError(result.error)
      return
    }
    setSelected(result.value.action === 'delete' ? undefined : result.value.session)
    await refreshSessions()
  }
  const submit = async () => {
    if (selected === undefined || composer.trim() === '') return
    const result = await ctx.platform.turns.submit({ session: selected.ref, message: composer.trim() })
    if (!result.ok) showError(result.error)
    else {
      setComposer('')
      await read(selected.ref)
    }
  }
  const activeTurn = selected !== undefined && 'turns' in selected
    ? [...selected.turns].reverse().find(turn => turn.state === 'in-progress')
    : undefined
  const controlTurn = async (action: 'steer' | 'interrupt') => {
    if (selected === undefined || activeTurn === undefined) return
    const result = await ctx.platform.turns.control(
      action === 'steer'
        ? { action, session: selected.ref, turnId: activeTurn.id, message: steer.trim() }
        : { action, session: selected.ref, turnId: activeTurn.id },
    )
    if (!result.ok) showError(result.error)
    else await read(selected.ref)
  }
  const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') void refreshSessions()
  }
  const sessionActions: readonly ('continue' | 'fork' | 'archive' | 'restore' | 'delete')[] =
    selected?.state === 'archived'
      ? ['restore', 'delete']
      : ['continue', 'fork', 'archive', 'delete']

  return {
    activeTurn,
    composer,
    controlSession,
    controlTurn,
    create,
    cwd,
    initialMessage,
    model,
    models,
    nextCursor,
    provider,
    read,
    refreshAll,
    refreshSessions,
    search,
    searchKey,
    selected,
    sessionActions,
    sessions,
    setComposer,
    setCwd,
    setInitialMessage,
    setModel,
    setProvider,
    setSearch,
    setSteer,
    status,
    steer,
    submit,
    visibleModels,
  }
}
