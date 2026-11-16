import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { callerThreadId, callerTurnId } from './agent-bridge-context.js'

/** Resolve authority from a real dispatch, never from an Agent-supplied actor or name. */
export class ChannelAgentAccess {
  constructor(
    private readonly state: () => ChannelConversationState,
    private readonly native: () => ChannelNativeSessions | undefined,
  ) {}
  source(threadId: string, turnId?: string): ChannelEventRef | undefined {
    const active = this.native()?.sourceFor?.(threadId, turnId)
    if (active) return active
    const state = this.state()
    const jobs = Object.values(state.jobs).filter(job =>
      job.sessionId === threadId
      && ['dispatching', 'running'].includes(job.state) && (!turnId || job.turnId === turnId)
    )
    if (jobs.length !== 1) return undefined
    const job = jobs[0]!
    if (!Object.values(state.bindings).some(binding => binding.state === 'active' && binding.sessionId === threadId)) {
      return undefined
    }
    return state.inputs[job.recordId]?.input.source.event
  }
  caller(metadata: unknown): { source: ChannelEventRef; threadId: string; turnId?: string } | undefined {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
    const token = (metadata as Record<string, unknown>)['cordisx/channelContext']
    if (typeof token !== 'string') return undefined
    const entry = this.native()?.contextFor?.(token)
    const providedThread = callerThreadId(metadata), providedTurn = callerTurnId(metadata)
    if (providedThread !== undefined && providedThread !== entry?.threadId) return undefined
    if (providedTurn !== undefined && entry?.turnId !== undefined && providedTurn !== entry.turnId) return undefined
    if (!entry?.threadId) return undefined
    const source = this.source(entry.threadId, entry.turnId)
    return source ? { source, threadId: entry.threadId, ...(entry.turnId ? { turnId: entry.turnId } : {}) } : undefined
  }
  routine(command: unknown, threadId: string, turnId: string): boolean {
    const operation = this.native()?.cliApprovalOperation?.(command)
    if (!operation || operation.kind === 'write') return false
    const source = this.source(threadId, turnId)
    if (!source) return false
    if (operation.context) {
      const entry = this.native()?.contextFor(operation.context)
      if (entry?.threadId !== threadId || entry.turnId !== undefined && entry.turnId !== turnId) return false
    }
    if (operation.kind === 'read') {
      return operation.input.sessionId === undefined || operation.input.sessionId === threadId
    }
    const account = operation.input.account as Record<string, unknown> | undefined
    const targets = operation.operation === 'send-many' ? operation.input.targets : [operation.input.target]
    if (!account || !Array.isArray(targets) || !targets.length) return false
    const state = this.state()
    return state.policy.enabled && targets.every(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const target = value as Record<string, unknown>
      if (typeof target.id !== 'string' || !['direct', 'group'].includes(String(target.kind))) return false
      if (
        !['adapterId', 'accountId', 'tenantId'].every(field =>
          account[field] === source[field as keyof ChannelEventRef]
        )
      ) return false
      if (target.id !== source.conversationId && target.id !== source.actor?.userId) return false
      return this.sendAllowed(source, target.id, target.kind as 'direct' | 'group')
    })
  }
  sendAllowed(source: ChannelEventRef, conversationId: string, kind: 'direct' | 'group'): boolean {
    return channelPolicyAllows(this.state().policy, 'send', { ...source, conversationId, kind })
  }
}
