import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelLogicalBindingAdmitted } from './channel-logical-continuation-bind.js'
import { startChannelLogicalContinuation } from './channel-logical-continuation.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import type { ChannelConversationJob, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import { confirmedGroupRecoveryScope } from './channel-confirmed-group-scope.js'
import { captureChannelGroupHistory, channelGroupProjectionVersion } from './channel-group-history-projection.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelTaskIntentObserved } from './channel-task-selection.js'
import { parseChatExecutionSettings } from '../chat-execution-settings.js'

/** Restore an already confirmed direct-chat selection before dispatch, without replaying a turn. */
export async function recoverConfirmedChannelProvider(input: {
  store: ChannelConversationStore
  native: ChannelNativeSessions
  fence: ChannelNativeSourceFence
  claims: Set<string>
  appId: string
  profileId: string
  access: () => ChannelConversationAccess | undefined
  event: ChannelEventRef
  job: ChannelConversationJob
  report?: (code: string) => void
}): Promise<boolean> {
  const { store, native, fence, claims, event, job, appId, profileId } = input
  const source = job.sessionId
  if (
    !source || !job.bindingId || job.autoCreate || claims.has(source)
    || !native.providerRecovery || typeof native.supportsCrossProviderFork !== 'function'
  ) return false
  const initial = store.snapshot()
  const target = await native.providerRecovery.target(source)
  if (!target || !await native.supportsCrossProviderFork(target)) return false
  const admitted = (
    state: ReturnType<ChannelConversationStore['snapshot']>,
    selection = { ...state.taskSettings[source]?.settings, ...target },
  ) =>
    event.kind === 'group'
      ? !!confirmedGroupRecoveryScope(state, event, profileId, source, job, target, selection)
      : channelLogicalBindingAdmitted(state, event, profileId, source)
  if (!admitted(initial)) return false
  if (!await native.idle(source) || await native.idle(source, true)) return false
  const release = fence.beginMigration(source)
  if (!release) return true
  claims.add(source)
  let held = true, phase = 'TARGET_CHECK'
  const diagnostic = (code: string) => {
    try {
      input.report?.(`CHANNEL_PROVIDER_RECOVERY_${code}`)
    } catch { /* Diagnostics must not affect task handling. */ }
  }
  const unknown = async (reason: string) => {
    diagnostic(reason)
    await store.mutate(state => {
      const current = state.jobs[job.id]
      if (current?.state === 'queued' && current.sessionId === source) {
        current.state = 'reconciliation-required'
        current.code = 'CONFIRMED_PROVIDER_RECOVERY_UNCERTAIN'
        current.failureNotice ??= 'pending'
      }
    })
  }
  try {
    if (!isDeepStrictEqual(await native.providerRecovery.target(source), target)) return true
    phase = 'TARGET_PROBE'
    const probe = await native.providerRecovery.probe(source, target, fence)
    if (probe.state === 'resumed') {
      phase = 'TARGET_READBACK'
      if (!isDeepStrictEqual(await native.providerRecovery.target(source), target)) {
        await unknown('TARGET_CHANGED')
        return true
      }
      return false
    }
    if (probe.state !== 'mismatch') {
      await unknown('TARGET_PROBE_UNCONFIRMED')
      return true
    }
    phase = 'TARGET_RECHECK'
    if (!isDeepStrictEqual(await native.providerRecovery.target(source), target)) return true
    phase = 'SAVE_TARGET'
    const preserved = await store.mutate(state => {
      const current = state.jobs[job.id], setting = state.taskSettings[source]
      if (
        current?.state !== 'queued' || current.sessionId !== source || current.bindingId !== job.bindingId
        || !admitted(state)
        || setting && (setting.application !== 'applied' || setting.pending || setting.pendingPatch
            || setting.settings.providerId !== target.providerId || setting.settings.model !== target.model)
      ) return false
      // A legacy binding may have no Channel settings. Preserve the independently
      // confirmed destination before loading the original provider.
      state.taskSettings[source] ??= { revision: 0, application: 'applied', settings: { ...target } }
      return true
    })
    if (!preserved) return true
    const savedSetting = structuredClone(store.snapshot().taskSettings[source]!)
    const execution = native.executionPreferences()
    if (!execution) {
      await unknown('EXECUTION_UNAVAILABLE')
      return true
    }
    await execution.settled()
    const beforeRestore = execution.read('local', source)
    if (!execution.observationConfirmed(source)) {
      await unknown('OBSERVATION_PENDING')
      return true
    }
    if (beforeRestore?.modelSelection === undefined) {
      // Older records have no modelSelection marker. Promote only the exact
      // applied target before native resume can replace effective with source.
      if (
        !beforeRestore || beforeRestore.application !== 'applied'
        || beforeRestore.appliedRevision !== undefined && beforeRestore.appliedRevision !== beforeRestore.revision
        || beforeRestore.effective?.modelProvider !== target.providerId
        || beforeRestore.effective?.model !== target.model
      ) {
        await unknown('LEGACY_SELECTION_UNCONFIRMED')
        return true
      }
      await execution.recordModelSelection(source, target, { value: undefined, record: beforeRestore })
    } else if (
      beforeRestore.modelSelection.status !== 'confirmed'
      || beforeRestore.modelSelection.providerId !== target.providerId
      || beforeRestore.modelSelection.model !== target.model
    ) {
      await unknown('SELECTION_CHANGED')
      return true
    }
    phase = 'SOURCE_RESUME'
    const original = await native.providerRecovery.restore(source, probe.sourceProvider, fence)
    if (!original || !await native.idle(source, true)) {
      await unknown('SOURCE_RESUME_UNCONFIRMED')
      return true
    }
    await execution.settled()
    const afterRestore = execution.read('local', source)
    const previous = afterRestore?.modelSelection
    if (
      !beforeRestore || afterRestore?.revision !== beforeRestore.revision
      || !execution.observationConfirmed(source) || !previous || previous.status !== 'confirmed'
      || !isDeepStrictEqual({ providerId: previous.providerId, model: previous.model }, target)
        && !isDeepStrictEqual({ providerId: previous.providerId, model: previous.model }, original)
    ) {
      await unknown('SOURCE_EXECUTION_CHANGED')
      return true
    }
    if (previous.providerId !== original.providerId || previous.model !== original.model) {
      await execution.recordModelSelection(source, original, { value: previous })
    }
    phase = 'SOURCE_SELECTION'
    const selection = await native.taskSelection(source)
    if (selection.providerId !== original.providerId || selection.model !== original.model) {
      await unknown('SOURCE_SELECTION_MISMATCH')
      return true
    }
    const before = store.snapshot(), sourceRef = { hostId: 'local' as const, appId, profileId, sessionId: source }
    const logicalId = logicalConversationIdentity(before.logicalContinuations, sourceRef)
    if (!logicalId) {
      await unknown('LOGICAL_ID_UNAVAILABLE')
      return true
    }
    const admin = event.kind === 'group'
      ? confirmedGroupRecoveryScope(before, event, profileId, source, job, target, selection)
      : undefined
    const sequence = before.inputs[job.recordId]?.sequence
    // The provider was already applied. Access is still rechecked against the
    // exact binding, authorizer, group policy, and task policy on every read.
    const expiresAt = Number.MAX_SAFE_INTEGER
    const capture = () =>
      admin && sequence !== undefined
        ? captureChannelGroupHistory({
          state: store.snapshot(),
          access: input.access(),
          bindingId: job.bindingId!,
          beforeSequence: sequence,
          authorizer: channelLogicalActor(admin),
          expiresAt,
          target,
          selection,
        })
        : undefined
    const projection = capture()
    if (event.kind === 'group' && (!admin || !projection)) {
      await unknown('GROUP_HISTORY_UNAVAILABLE')
      return true
    }
    const current = (state: ReturnType<ChannelConversationStore['snapshot']>) =>
      state.jobs[job.id]?.state === 'queued' && state.jobs[job.id]?.sessionId === source
      && state.jobs[job.id]?.bindingId === job.bindingId
      && isDeepStrictEqual(state.taskSettings[source], savedSetting)
      && execution.observationConfirmed(source)
      && execution.read('local', source)?.revision === beforeRestore.revision
      && isDeepStrictEqual(execution.read('local', source)?.modelSelection, { status: 'confirmed', ...original })
      && state.policyRevision === before.policyRevision && state.taskConfigRevision === before.taskConfigRevision
      && (event.kind === 'group'
        ? isDeepStrictEqual(confirmedGroupRecoveryScope(state, event, profileId, source, job, target, selection), admin)
        : channelLogicalBindingAdmitted(state, event, profileId, source))
    if (!current(before)) {
      await unknown('SOURCE_STATE_CHANGED')
      return true
    }
    // Release and reacquire synchronously inside start; no other JavaScript task
    // can write this source between the two owner-side fences.
    claims.delete(source)
    release()
    held = false
    phase = 'CONTINUATION'
    const result = await startChannelLogicalContinuation({
      ...input,
      request: {
        contract: 'cordisx.conversation-continuation-request/v1',
        operationId: 'confirmed-resume:' + job.id,
        logicalConversationId: logicalId,
        source: sourceRef,
        expectedRevision: before.logicalContinuations?.revision ?? 0,
        target,
        ...(projection
          ? {
            mode: 'linked' as const,
            historyConsent: 'on-demand' as const,
            historyCategories: ['user-text', 'assistant-text'] as const,
            handoffConsent: 'none' as const,
          }
          : { mode: 'fork' as const, historyConsent: 'inherit' as const }),
      },
      automatic: {
        selection,
        admitted: current,
        diagnostic,
        destinationConfiguration: configuration => {
          const effort = savedSetting.settings.effort === undefined
            ? undefined
            : parseChatExecutionSettings({ effort: savedSetting.settings.effort }).effort
          return {
            ...configuration,
            serviceTier: savedSetting.settings.fast === undefined
              ? configuration.serviceTier
              : savedSetting.settings.fast
              ? 'priority'
              : null,
            execution: {
              ...configuration.execution,
              ...(effort === undefined || effort === 'inherit' ? {} : { effort }),
            },
          }
        },
        confirmDestination: async destination =>
          channelTaskIntentObserved(savedSetting.settings, await native.taskSelection(destination)),
        ...(projection
          ? {
            group: {
              sourceVersion: async () => {
                const latest = capture()
                return latest && isDeepStrictEqual(latest, projection) && current(store.snapshot())
                  ? channelGroupProjectionVersion(projection)
                  : undefined
              },
            },
          }
          : {}),
        consume: state => {
          const setting = state.taskSettings[source]
          if (!setting || !isDeepStrictEqual(setting, savedSetting)) return false
          if (projection) {
            const intent = state.logicalContinuations?.intents['confirmed-resume:' + job.id]
            if (!intent) return false
            intent.groupProjection = structuredClone(projection)
          }
          setting.settings = { ...setting.settings, ...original }
          return true
        },
      },
    })
    if (result.state !== 'applied' || 'navigationReady' in result && result.navigationReady === false) {
      const reason = result.state === 'rejected' && [
          'SOURCE_BUSY',
          'SOURCE_FENCE_UNAVAILABLE',
          'PREFLIGHT_UNAVAILABLE',
          'PREFLIGHT_CHANGED',
          'SOURCE_CHANGED_OR_BUSY',
        ].includes(result.code)
        ? result.code
        : 'CONTINUATION_UNCONFIRMED'
      await unknown(reason)
    }
    return true
  } catch {
    await unknown(`${phase}_ERROR`).catch(() => {})
    return true
  } finally {
    if (held) release()
    claims.delete(source)
  }
}
