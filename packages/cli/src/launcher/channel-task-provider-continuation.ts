import { isDeepStrictEqual } from 'node:util'
import { parseModelReasoningCapabilities, resolveModelReasoningEffort } from '../model-reasoning-capabilities.js'
import { channelLogicalBindingAdmitted } from './channel-logical-continuation-bind.js'
import { startChannelLogicalContinuation } from './channel-logical-continuation.js'
import { channelTaskContinuationCurrent } from './channel-logical-continuation-scope.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import { channelCommandDenied } from './channel-conversation-policy.js'
import { channelTaskChangeAllowed, channelTaskFields, type ChannelTaskPatch } from './channel-task-config.js'
import { channelTaskCatalog, channelTaskIntentObserved } from './channel-task-selection.js'
import type {
  ChannelConversationState,
  ChannelConversationStore,
  ChannelTaskRequest,
} from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import { taskProviderOperation } from './channel-task-provider-reference.js'

/**
 * An explicit, authorized Channel selection may inherit the same direct-chat
 * history when native 0.172 cannot change its provider in place. Never repeat
 * an uncertain fork; the normal continuation fence remains its recovery path.
 */
export async function continueChannelTaskProvider(input: {
  store: ChannelConversationStore
  native: ChannelNativeSessions
  fence: ChannelNativeSourceFence
  claims: Set<string>
  appId: string
  profileId: string
  request: ChannelTaskRequest
  revision: number
  selection: ChannelTaskPatch
}) {
  const { store, native, request, revision, selection, profileId } = input
  const source = request.threadId, event = request.source
  const desired = request.selection
  if (
    event.kind !== 'direct' || !desired.providerId || !desired.model || !selection.providerId
    || desired.providerId === selection.providerId || !native.supportsCrossProviderFork
  ) return undefined
  try {
    if (!await native.supportsCrossProviderFork({ providerId: desired.providerId, model: desired.model })) {
      return undefined
    }
  } catch {
    return { state: 'rejected' as const, code: 'PREFLIGHT_UNAVAILABLE' }
  }
  const claim = { requestId: request.id, revision }
  const state = store.snapshot()
  const bindings = Object.values(state.bindings).filter(row => row.state === 'active' && row.sessionId === source)
  if (bindings.length !== 1) return { state: 'rejected' as const, code: 'SOURCE_CHANGED_OR_BUSY' }
  const bindingId = bindings[0]!.id
  const sourceRef = { hostId: 'local', appId: input.appId, profileId, sessionId: source }
  const logicalId = logicalConversationIdentity(state.logicalContinuations, sourceRef)
  if (!logicalId) return { state: 'rejected' as const, code: 'LOGICAL_ID_UNAVAILABLE' }
  let providers: ReturnType<typeof channelTaskCatalog>
  try {
    providers = channelTaskCatalog(await native.modelOperation('list', {}))
  } catch {
    return { state: 'rejected' as const, code: 'SELECTION_UNAVAILABLE' }
  }
  const model = providers.find(row => row.providerId === desired.providerId)?.models.find(row =>
    row.id === desired.model
  )
  if (!model) return { state: 'rejected' as const, code: 'SELECTION_UNAVAILABLE' }
  const capabilities = parseModelReasoningCapabilities(model.reasoningCapabilities)
  let targetSelection: ChannelTaskPatch | undefined
  const current = (snapshot: ChannelConversationState) => {
    const latest = snapshot.taskRequests[request.id]
    return channelTaskContinuationCurrent(snapshot, event, source, claim)
      && channelLogicalBindingAdmitted(snapshot, event, profileId, source, claim)
      && !!latest?.approvedBy && isDeepStrictEqual(latest.approvedBy, request.approvedBy)
      && isDeepStrictEqual(latest.patch, request.patch) && isDeepStrictEqual(latest.selection, desired)
      && !channelTaskFields(latest.patch).some(command =>
        channelCommandDenied(snapshot.policy, latest.approvedBy!, command)
      )
      && channelTaskChangeAllowed(snapshot.taskConfig, snapshot.policy, latest.approvedBy, latest.patch, desired)
  }
  if (!current(state)) return { state: 'rejected' as const, code: 'MODEL_CHANGE_PERMISSION_DENIED' }
  const operationId = taskProviderOperation(request.id, revision)
  const result = await startChannelLogicalContinuation({
    ...input,
    event,
    request: {
      contract: 'cordisx.conversation-continuation-request/v1',
      operationId,
      logicalConversationId: logicalId,
      source: sourceRef,
      expectedRevision: state.logicalContinuations?.revision ?? 0,
      target: { providerId: desired.providerId, model: desired.model },
      mode: 'fork',
      historyConsent: 'inherit',
    },
    automatic: {
      selection,
      taskClaim: claim,
      admitted: current,
      destinationConfiguration: sourceConfig => {
        const effort = desired.effort === 'inherit'
          ? resolveModelReasoningEffort(capabilities, sourceConfig.execution.effort) ?? 'inherit'
          : desired.effort ?? sourceConfig.execution.effort
        if (!effort) throw new Error('TARGET_EFFORT_UNAVAILABLE')
        const serviceTier = desired.fast === true
          ? 'priority'
          : desired.fast === false && sourceConfig.serviceTier === 'priority'
          ? null
          : sourceConfig.serviceTier
        return { ...sourceConfig, serviceTier, execution: { ...sourceConfig.execution, effort } }
      },
      confirmDestination: async destination => {
        targetSelection = await native.taskSelection(destination)
        return targetSelection.providerId === desired.providerId && targetSelection.model === desired.model
      },
      consume: snapshot => {
        const latest = snapshot.taskRequests[request.id], sourceSetting = snapshot.taskSettings[source]
        const binding = snapshot.bindings[bindingId]
        if (
          !latest || !sourceSetting || !binding || binding.state !== 'active' || binding.sessionId === source
          || !targetSelection
        ) return false
        const applied = channelTaskIntentObserved(desired, targetSelection)
        snapshot.taskSettings[source] = {
          revision,
          application: 'applied',
          settings: structuredClone(request.baseSelection),
        }
        snapshot.taskSettings[binding.sessionId] = applied
          ? { revision, application: 'applied', settings: structuredClone(targetSelection) }
          : {
            revision,
            application: 'saved',
            settings: structuredClone(targetSelection),
            pending: structuredClone(desired),
            pendingPatch: structuredClone(request.patch),
            baseSelection: structuredClone(targetSelection),
          }
        latest.state = applied ? 'applied' : 'queued'
        delete latest.code
        return true
      },
    },
  })
  return result
}
