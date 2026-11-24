import { identity } from './channel-conversation-refs.js'
import type {
  ChannelConversationJob,
  ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'

export const channelIdlePriorityOperation = (jobId: string) => `channel-idle:${identity(jobId)}`

/** The business turn was never sent; only its destination creation is uncertain. */
export function channelIdlePriorityUncertain(state: ChannelConversationState, job: ChannelConversationJob): boolean {
  const intent = state.logicalContinuations?.intents[channelIdlePriorityOperation(job.id)]
  return job.state === 'reconciliation-required' && job.code === 'IDLE_PRIORITY_MIGRATION_UNCERTAIN'
    && !job.turnId && intent?.state === 'unknown' && intent.request.source.sessionId === job.sessionId
}

/** Recovery must not redispatch a message whose destination creation was interrupted. */
export async function recoverChannelIdlePriorityJob(store: ChannelConversationStore, jobId: string): Promise<boolean> {
  if (store.snapshot().logicalContinuations?.intents[channelIdlePriorityOperation(jobId)]?.state !== 'unknown') {
    return false
  }
  return store.mutate(state => {
    const current = state.jobs[jobId]
    if (
      current?.state === 'queued'
      && state.logicalContinuations?.intents[channelIdlePriorityOperation(jobId)]?.state === 'unknown'
    ) {
      current.state = 'reconciliation-required'
      current.code = 'IDLE_PRIORITY_MIGRATION_UNCERTAIN'
      current.failureNotice ??= 'pending'
      return true
    }
    return false
  })
}
