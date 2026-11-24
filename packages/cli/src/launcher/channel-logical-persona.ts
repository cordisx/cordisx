import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelMemoryPersonas } from './channel-memory-personas.js'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { eventThread } from './channel-conversation-refs.js'
import { failChannelLogicalPersona } from './channel-conversation-dispatch.js'

type Link = { source: string; destination: string }

/** Follow only committed links approved for the same Channel actor and binding. */
function personaPath(
  state: ChannelConversationState,
  jobId: string,
  event: ChannelEventRef,
  appId: string | undefined,
  profileId: string,
): Link[] | false {
  const job = state.jobs[jobId], logical = state.logicalContinuations
  if (!appId || !job?.sessionId || !logical) return []
  let current = { hostId: 'local', appId, profileId, sessionId: job.sessionId }
  const links: Link[] = [], seen = new Set<string>()
  let logicalId: string | undefined
  for (let depth = 0; depth <= 16; depth++) {
    if (seen.has(current.sessionId)) return false
    seen.add(current.sessionId)
    const matches = Object.values(logical.relations).filter(relation =>
      relation.mode !== 'fresh' && isDeepStrictEqual(relation.destination, current)
    )
    if (!matches.length) break
    if (matches.length !== 1 || depth === 16) return false
    const relation = matches[0]!, intent = logical.intents[relation.operationId]
    if (!intent || intent.state !== 'applied') return false
    // A group projection never authorizes native per-actor persona migration.
    if (intent.groupProjection) break
    if (
      ![intent.actor, intent.channelHistoryActor].some(actor => isDeepStrictEqual(actor, channelLogicalActor(event)))
    ) {
      break
    }
    const binding = job.bindingId && state.bindings[job.bindingId]
    if (
      job.state !== 'dispatching' || !isDeepStrictEqual(state.inputs[job.recordId]?.input.source.event, event)
      || !state.policy.enabled || !channelPolicyAllows(state.policy, 'dispatch', event)
      || !binding || binding.state !== 'active' || binding.sessionId !== job.sessionId
      || binding.hostId !== 'local' || binding.profileId !== profileId
      || !isDeepStrictEqual(binding.channel, eventThread(event))
      || logicalId && logicalId !== relation.logicalConversationId
      || relation.source.hostId !== current.hostId || relation.source.appId !== current.appId
      || relation.source.profileId !== current.profileId
    ) return false
    logicalId = relation.logicalConversationId
    links.unshift({ source: relation.source.sessionId, destination: current.sessionId })
    current = relation.source
  }
  return links
}

/** Pin the original persona before dispatch, then recheck the committed route. */
export async function prepareChannelLogicalPersona(
  personas: ChannelMemoryPersonas,
  snapshot: () => ChannelConversationState,
  jobId: string,
  event: ChannelEventRef,
  appId: string | undefined,
  profileId: string,
): Promise<boolean> {
  try {
    const path = personaPath(snapshot(), jobId, event, appId, profileId)
    if (path === false) return false
    for (const link of path) {
      if (!isDeepStrictEqual(personaPath(snapshot(), jobId, event, appId, profileId), path)) return false
      if (await personas.taskConfigured(link.source, event)) {
        await personas.pinAlias(link.source, link.destination, event)
      } else if (await personas.taskConfigured(link.destination, event)) return false
    }
    return isDeepStrictEqual(personaPath(snapshot(), jobId, event, appId, profileId), path)
  } catch {
    return false
  }
}

export async function ensureChannelLogicalPersona(
  personas: ChannelMemoryPersonas,
  store: ChannelConversationStore,
  jobId: string,
  event: ChannelEventRef,
  input: { readonly appId?: string | undefined; readonly profileId: string; readonly report?: (code: string) => void },
) {
  if (
    await prepareChannelLogicalPersona(
      personas,
      () => store.snapshot(),
      jobId,
      event,
      input.appId,
      input.profileId,
    )
  ) {
    return true
  }
  await store.mutate(state => failChannelLogicalPersona(state, jobId))
  input.report?.('CONTINUATION_PERSONA_UNAVAILABLE')
  return false
}
