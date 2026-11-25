import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ChannelMessageContext } from './channel-message-context.js'
import type { ChannelConversationInput, ChannelConversationStore } from './channel-conversation-store.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { channelUserMemoryRequest } from './channel-user-memory-request.js'
import { channelUserMemorySettings } from './channel-user-memory-settings.js'
import { validateUserMemoryAssertions } from './channel-user-memory-model.js'
import type { ChannelUserMemoryAnalysis } from './channel-user-memory-model.js'
import type { ChannelMemoryPersonas } from './channel-memory-personas.js'
import type { ChannelMemoryStore, MemoryRecord } from './channel-memory-store.js'
import type { MemoryAuthority } from './channel-memory-policy.js'

export function createChannelUserMemoryContext(input: {
  file: string
  store: ChannelConversationStore
  personas: ChannelMemoryPersonas
  memory: ChannelMemoryStore
  signal: AbortSignal
  report?: ((code: string) => void) | undefined
}) {
  return async (
    record: ChannelConversationInput,
    taskId: string,
    context: ChannelMessageContext,
    jobId: string,
    analysis: ChannelUserMemoryAnalysis | undefined,
    selection: () => Promise<{ providerId?: string; model?: string }>,
  ): Promise<ChannelMessageContext> => {
    const { userMemory: _untrusted, ...base } = context
    const source = record.input.source.event, actor = source.actor
    const text = record.input.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    const recall = channelUserMemoryRequest(text)
    const introduction = !recall && text.length <= 4096 && /我|\b(?:i|my|me)\b/iu.test(text)
      && !/["“”「」『』`<>\n\r]/u.test(text) && !/^(?:不要|别|do not|don't)/iu.test(text)
      && !/^(?:请)?(?:帮我|替我|给我|为我|我(?:想|要|需要)你|can you|could you|please (?:help|make|do|run|send))|[?？]$/iu
        .test(text)
    if (!recall && !introduction || record.addressing?.mentions.length) return base
    const current = () => {
      const state = input.store.snapshot(), saved = state.inputs[record.recordId], job = state.jobs[jobId]
      const binding = job?.bindingId ? state.bindings[job.bindingId] : undefined
      return !input.signal.aborted && !!saved?.accepted && !!saved.routed && state.policy.enabled
        && saved.sequence === record.sequence && isDeepStrictEqual(saved.input, record.input)
        && job?.state === 'dispatching' && job.recordId === record.recordId
        && (!job.bindingId || binding?.state === 'active' && binding.sessionId === job.sessionId)
        && channelDispatchAllowed(state, source) && channelPolicyAllows(state.policy, 'send', source)
    }
    if (
      !actor?.userId || actor.adapterId !== source.adapterId || actor.accountId !== source.accountId
      || actor.tenantId !== source.tenantId || !source.messageId || !['direct', 'group'].includes(source.kind)
      || !current()
    ) return base
    const action = recall ? 'recall' : 'remember'
    try {
      const config = await channelUserMemorySettings(path.dirname(input.file))
      if (
        !config.enabled
        || (recall ? !config.recall || source.kind === 'group' && !config.groupRecall : !config.remember)
      ) return base
      const memory = await input.personas.taskConfigured(taskId, source)
        ? await input.personas.memoryForTask(taskId, source)
        : input.memory
      const authority: MemoryAuthority = {
        actor: {
          adapterId: source.adapterId,
          accountId: source.accountId,
          tenantId: source.tenantId,
          userId: actor.userId,
        },
        conversation: {
          adapterId: source.adapterId,
          accountId: source.accountId,
          tenantId: source.tenantId,
          conversationId: source.conversationId,
        },
        kind: source.kind as 'direct' | 'group',
        ...(recall ? { userRecall: recall } : {}),
      }
      let records: MemoryRecord[]
      if (recall) {
        const page = await memory.browse(authority, { limit: 4, maxBytes: 4096, userOnly: true }) as {
          cards: { id: string }[]
        }
        records = await memory.batch(authority, page.cards.map(card => card.id), 8192)
      } else {
        if (!analysis) throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
        const selected = config.providerId && config.model
          ? { providerId: config.providerId, model: config.model }
          : await selection()
        if (!selected.providerId || !selected.model) throw new Error('CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE')
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutMs)])
        const pending = analysis(text, { providerId: selected.providerId, model: selected.model }, signal)
        const assertions = validateUserMemoryAssertions({
          assertions: await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              if (signal.aborted) reject(new Error('CHANNEL_USER_MEMORY_UNAVAILABLE'))
              else {signal.addEventListener('abort', () => reject(new Error('CHANNEL_USER_MEMORY_UNAVAILABLE')), {
                  once: true,
                })}
            }),
          ]),
        }, text)
        if (!assertions.length || !current()) return base
        records = await memory.rememberUser(authority, assertions, {
          messageId: source.messageId,
          sequence: record.sequence,
        }, current)
      }
      if (!current()) return base
      return {
        ...base,
        userMemory: {
          action,
          status: records.length ? recall ? 'found' : 'saved' : 'not-found',
          records: records.map(row => ({
            id: row.id,
            revision: row.revision,
            title: row.title,
            summary: row.summary,
            updatedAt: row.updatedAt,
            evidenceType: row.evidenceType,
          })),
          grantsPermissions: false,
          audience: source.kind === 'group' ? 'current-group' : 'requesting-user',
        },
      }
    } catch (error) {
      const code = error instanceof Error
          && ['CHANNEL_USER_MEMORY_MODEL_UNAVAILABLE', 'CHANNEL_USER_MEMORY_CONFIG_INVALID'].includes(error.message)
        ? error.message
        : 'CHANNEL_USER_MEMORY_UNAVAILABLE'
      try {
        input.report?.(code)
      } catch {}
      return current()
        ? {
          ...base,
          userMemory: {
            action,
            status: 'unavailable',
            records: [],
            grantsPermissions: false,
            audience: source.kind === 'group' ? 'current-group' : 'requesting-user',
          },
        }
        : base
    }
  }
}

export function channelUserMemoryComposition(
  store: ChannelConversationStore,
  signal: AbortSignal,
  memory: { personas: ChannelMemoryPersonas; memory: ChannelMemoryStore },
  owner: { file: string; report?: ((code: string) => void) | undefined },
) {
  return {
    directory: path.dirname(owner.file),
    context: createChannelUserMemoryContext({
      store,
      signal,
      personas: memory.personas,
      memory: memory.memory,
      ...owner,
    }),
  }
}
