import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelCommandDenied } from './channel-conversation-policy.js'
import {
  channelTaskChangeAllowed,
  channelTaskDefaults,
  channelTaskFields,
  type ChannelTaskPatch,
} from './channel-task-config.js'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelTaskSettings } from './channel-task-settings.js'
import type { ChannelModelCandidate } from './channel-model-priority.js'

/** A stalled catalog read cannot hold an incoming Channel job indefinitely. */
export async function boundedChannelSelectionValidation(
  validate: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      validate(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MODEL_PRIORITY_CATALOG_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function channelPriorityFenceCurrent(
  store: ChannelConversationStore,
  fence: { priority: number; taskConfig: number; policy: number },
  event: ChannelEventRef,
  jobId: string,
): boolean {
  const state = store.snapshot()
  return state.modelPriority.revision === fence.priority && state.taskConfigRevision === fence.taskConfig
    && state.policyRevision === fence.policy && state.policy.enabled && channelDispatchAllowed(state, event)
    && state.jobs[jobId]?.state === 'dispatching'
}

/** Select only before native dispatch; stale policy is requeued without creating a turn. */
export async function selectChannelCreationModel(input: {
  readonly store: ChannelConversationStore
  readonly captured: ChannelConversationState
  readonly tasks: ChannelTaskSettings
  readonly preflight?: (
    candidate: ChannelModelCandidate,
    signal?: AbortSignal,
    beforeProbe?: () => Promise<boolean>,
  ) => Promise<boolean>
  readonly signal: AbortSignal
  readonly event: ChannelEventRef
  readonly jobId: string
  readonly autoCreate: boolean
  readonly continuing: boolean
}): Promise<
  | { state: 'ready'; settings?: ChannelTaskPatch; fence?: { priority: number; taskConfig: number; policy: number } }
  | { state: 'stop' }
> {
  const { store, captured, tasks, event, jobId } = input
  if (!input.autoCreate) return { state: 'ready' }
  const defaults = channelTaskDefaults(captured.taskConfig, captured.policy, event)
  const priority = !input.continuing && !defaults.providerId && !defaults.model ? captured.modelPriority : undefined
  if (!priority?.candidates.length) return { state: 'ready', settings: await tasks.defaults(event) }
  const fence = {
    priority: priority.revision,
    taskConfig: captured.taskConfigRevision,
    policy: captured.policyRevision,
  }
  let settings: ChannelTaskPatch | undefined
  try {
    for (const candidate of priority.candidates) {
      const selection = { ...defaults, ...candidate }
      if (
        channelTaskFields(candidate).some(command => channelCommandDenied(captured.policy, event, command))
        || !channelTaskChangeAllowed(captured.taskConfig, captured.policy, event, candidate, selection)
      ) continue
      try {
        await boundedChannelSelectionValidation(() => tasks.validate(selection))
      } catch (error) {
        if (
          error instanceof Error
          && ['SELECTION_OUTSIDE_CATALOG', 'FAST_NOT_SUPPORTED', 'MODEL_EFFORT_UNAVAILABLE', 'MODEL_EFFORT_UNSUPPORTED']
            .includes(error.message)
        ) continue
        throw error
      }
      if (!channelPriorityFenceCurrent(store, fence, event, jobId)) break
      if (
        !input.preflight || !await input.preflight(
          candidate,
          input.signal,
          async () => channelPriorityFenceCurrent(store, fence, event, jobId),
        )
      ) continue
      settings = selection
      break
    }
  } catch {
    // Preflight cannot create a native effect; unavailable authority stops selection.
  }
  const current = store.snapshot()
  if (
    current.modelPriority.revision !== priority.revision || current.taskConfigRevision !== captured.taskConfigRevision
    || current.policyRevision !== captured.policyRevision || !current.policy.enabled
    || !channelDispatchAllowed(current, event) || current.jobs[jobId]?.state !== 'dispatching'
  ) {
    await store.mutate(state => {
      if (state.jobs[jobId]?.state === 'dispatching') state.jobs[jobId]!.state = 'queued'
    })
    return { state: 'stop' }
  }
  if (settings) {
    return {
      state: 'ready',
      settings,
      fence,
    }
  }
  await store.mutate(state => {
    const job = state.jobs[jobId]
    if (job?.state === 'dispatching') {
      job.state = 'failed'
      job.code = 'MODEL_PRIORITY_UNAVAILABLE'
      job.failureNotice ??= 'pending'
    }
  })
  return { state: 'stop' }
}
