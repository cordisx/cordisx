import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationJob, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import { channelGroupPriorityCurrent } from './channel-group-priority.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'
import { channelTaskCatalog, validateChannelTaskSelection } from './channel-task-selection.js'
import { boundedChannelSelectionValidation } from './channel-model-priority-dispatch.js'
import { channelIdlePriorityOperation } from './channel-idle-priority-status.js'
import { attemptChannelGroupLinked } from './channel-group-linked-attempt.js'

async function bounded<T>(operation: Promise<T>, timeout = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Same-provider selection uses the native idle/selection fence; no business turn is replayed. */
export async function attemptChannelGroupPriority(input: {
  store: ChannelConversationStore
  native?: ChannelNativeSessions | undefined
  access?: (() => ChannelConversationAccess | undefined) | undefined
  fence?: ChannelNativeSourceFence | undefined
  claims: Set<string>
  appId?: string | undefined
  profileId: string
  event: ChannelEventRef
  job: ChannelConversationJob
  signal: AbortSignal
}): Promise<boolean> {
  const { store, native, claims, job, event, signal } = input
  if (!native || !input.appId || !job.bindingId || !job.sessionId || job.autoCreate || event.kind !== 'group') {
    return false
  }
  const source = job.sessionId, grant = store.snapshot().logicalContinuations?.idlePriorityGrants?.[job.bindingId]
  if (!grant?.groupScope || grant.source.appId !== input.appId || grant.source.profileId !== input.profileId) {
    return false
  }
  const candidates = [grant.target, ...(grant.fallbackTargets ?? [])]
  if (!candidates.some(candidate => channelGroupPriorityCurrent(store.snapshot(), grant, event, candidate))) {
    return false
  }
  if (claims.has(source)) return true
  const captured = store.snapshot(), sequence = captured.inputs[job.recordId]?.sequence
  if (
    sequence === undefined || Object.values(captured.jobs).some(other => {
      const otherSequence = captured.inputs[other.recordId]?.sequence
      return other.id !== job.id && other.sessionId === source && other.state === 'queued'
        && otherSequence !== undefined
        && (otherSequence < sequence || otherSequence === sequence && other.id < job.id)
    })
  ) return true
  claims.add(source)
  let effectReserved = false, originalUnavailable = false, effectAllowed = true
  const ready = (state: ReturnType<ChannelConversationStore['snapshot']>, target?: typeof grant.target) =>
    !signal.aborted && (target
      ? channelGroupPriorityCurrent(state, grant, event, target)
      : candidates.some(candidate => channelGroupPriorityCurrent(state, grant, event, candidate)))
    && state.jobs[job.id]?.bindingId === grant.bindingId && state.jobs[job.id]?.sessionId === source
    && (state.jobs[job.id]?.state === 'queued' || !grant.groupLinked
        && state.jobs[job.id]?.state === 'reconciliation-required'
        && state.jobs[job.id]?.code === 'GROUP_PRIORITY_EFFECT_UNCERTAIN')
    && state.inputs[job.recordId]?.accepted === true && state.inputs[job.recordId]?.routed === true
    && isDeepStrictEqual(state.inputs[job.recordId]?.input.source.event, event)
    && !Object.values(state.jobs).some(other =>
      other.id !== job.id && other.sessionId === source
      && ['dispatching', 'running', 'replying', 'reconciliation-required'].includes(other.state)
    )
    && (!state.taskSettings[source] || state.taskSettings[source]?.application === 'applied')
    && !Object.values(state.taskRequests).some(request =>
      request.threadId === source
      && ['pending', 'queued', 'applying', 'submitted', 'unknown'].includes(request.state)
    )
    && !Object.values(state.logicalContinuations?.intents ?? {}).some(intent =>
      intent.request.source.sessionId === source && ['creating', 'unknown'].includes(intent.state)
      && intent.request.operationId !== channelIdlePriorityOperation(job.id)
    )
    && (!state.liveTakeovers[source] || ['finished', 'abandoned'].includes(state.liveTakeovers[source]!.state))
    && (!state.continuations[source]?.intent || state.continuations[source]?.intent?.state === 'completed')
  const current = (target?: typeof grant.target) => ready(store.snapshot(), target)
  const failed = () =>
    store.mutate(state => {
      const latest = state.jobs[job.id]
      if (latest?.state === 'queued' && ready(state)) {
        latest.state = 'failed'
        latest.code = 'MODEL_PRIORITY_UNAVAILABLE'
        latest.failureNotice ??= 'pending'
      }
    })
  try {
    if (!await bounded(native.idle(source, true)) || !current()) return true
    const selection = await bounded(native.taskSelection(source))
    if (!isDeepStrictEqual(selection, grant.selection)) {
      await channelLogicalTransactionStore(store).mutate(state => {
        if (isDeepStrictEqual(state.logicalContinuations?.idlePriorityGrants?.[grant.bindingId], grant)) {
          removeChannelIdlePriorityGrant(state.logicalContinuations, grant.bindingId)
        }
      })
      return false
    }
    const guard = async (target?: typeof grant.target) =>
      current(target)
      && isDeepStrictEqual(await bounded(native.taskSelection(source)), grant.selection)
    const original = await native.priorityEvidence(
      { providerId: selection.providerId!, model: selection.model! },
      signal,
      guard,
    )
    if (original === 'healthy' || original === 'inconclusive') return false
    if (original !== 'unavailable' || !await guard()) return true
    originalUnavailable = true
    let selected: typeof grant.target | undefined
    for (const candidate of candidates) {
      if (!await guard(candidate)) {
        if (!await guard()) return true
        continue
      }
      try {
        await boundedChannelSelectionValidation(async () => {
          validateChannelTaskSelection(channelTaskCatalog(await native.modelOperation('list', {})), {
            ...selection,
            ...candidate,
          })
          await native.validateTaskConfiguration({ ...selection, ...candidate }, source)
        })
      } catch {
        continue
      }
      const result = await native.priorityEvidence(candidate, signal, () => guard(candidate))
      if (result === 'cancelled' || !await guard(candidate)) return true
      if (result === 'healthy') {
        selected = candidate
        break
      }
    }
    if (!selected) {
      await failed()
      return true
    }
    const target = selected
    if (grant.groupLinked) {
      if (!input.fence || !input.access || !native.logicalMigrationLease) {
        await failed()
        return true
      }
      await attemptChannelGroupLinked({
        ...input,
        native,
        access: input.access,
        fence: input.fence,
        appId: input.appId,
        grant,
        target,
        sequence,
        admitted: state => ready(state, target),
      })
      return true
    }
    effectReserved = await store.mutate(state => {
      const latest = state.jobs[job.id]
      if (!latest || latest.state !== 'queued' || !ready(state, target)) {
        return false
      }
      latest.state = 'reconciliation-required'
      latest.code = 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
      return true
    })
    if (!effectReserved) return true
    const result = await bounded(
      native.applyTaskSelection(source, { ...selection, ...target }, async applied => {
        const latest = store.snapshot().jobs[job.id]
        return effectAllowed && latest?.state === 'reconciliation-required'
          && latest.code === 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
          && current(target)
          && isDeepStrictEqual(await bounded(native.taskSelection(source)), { ...selection, ...applied })
          && effectAllowed && current(target)
      }),
      15_000,
    )
    if (
      result.status !== 'selected' || result.application !== 'applied'
      || !isDeepStrictEqual(await bounded(native.taskSelection(source)), { ...selection, ...target })
      || !current(target)
    ) {
      await store.mutate(state => {
        if (state.jobs[job.id]?.state === 'reconciliation-required') state.jobs[job.id]!.failureNotice ??= 'pending'
      })
      return true
    }
    await channelLogicalTransactionStore(store).mutate(state => {
      const latest = state.jobs[job.id]
      if (
        latest?.state !== 'reconciliation-required' || latest.code !== 'GROUP_PRIORITY_EFFECT_UNCERTAIN'
        || !ready(state, target)
      ) {
        if (latest?.state === 'reconciliation-required') latest.failureNotice ??= 'pending'
        return
      }
      const candidates = [grant.target, ...(grant.fallbackTargets ?? [])]
      const remaining = candidates.slice(candidates.findIndex(row => isDeepStrictEqual(row, target)) + 1)
      if (!remaining.length) removeChannelIdlePriorityGrant(state.logicalContinuations, grant.bindingId)
      else {state.logicalContinuations!.idlePriorityGrants![grant.bindingId] = {
          ...grant,
          selection: { ...selection, ...target },
          target: remaining[0]!,
          fallbackTargets: remaining.slice(1),
        }}
      const settings = state.taskSettings[source]
      if (settings) {
        settings.revision += 1
        settings.settings = { ...selection, ...target }
      }
      latest.state = 'queued'
      delete latest.code
    })
    return true
  } catch {
    if (effectReserved) {
      await store.mutate(state => {
        if (state.jobs[job.id]?.state === 'reconciliation-required') state.jobs[job.id]!.failureNotice ??= 'pending'
      }).catch(() => {})
    } else if (originalUnavailable && !signal.aborted) await failed().catch(() => {})
    return true
  } finally {
    effectAllowed = false
    claims.delete(source)
  }
}
