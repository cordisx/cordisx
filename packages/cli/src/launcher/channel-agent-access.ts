import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { callerThreadId, callerTurnId } from './agent-bridge-context.js'
import { continuationRoutine } from './channel-continuation-approval.js'
import { sameChannelPrincipal } from './channel-source-principal.js'

/** Resolve authority from a real dispatch, never from an Agent-supplied actor or name. */
export class ChannelAgentAccess {
  constructor(
    private readonly state: () => ChannelConversationState,
    private readonly native: () => ChannelNativeSessions | undefined,
  ) {}
  hasPreparation(): boolean {
    return this.native()?.hasPreparation() === true
  }
  preparation(metadata: unknown): boolean {
    const row = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
    const token = row['cordisx/channelContext']
    const threadId = callerThreadId(metadata)
    const tokenThread = typeof token === 'string' ? this.native()?.contextFor(token)?.threadId : undefined
    return (
      typeof threadId === 'string' && this.native()?.isPreparing(threadId) === true
      || typeof tokenThread === 'string' && this.native()?.isPreparing(tokenThread) === true
      || this.native()?.hasPreparation() === true && row['cordisx/mcpRequestId'] !== undefined && !threadId
        && !tokenThread
    )
  }
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
    // The token selects a message only after the turn still resolves to the same principal.
    const verified = this.source(entry.threadId, entry.turnId)
    const source = entry.source === undefined
      ? verified
      : verified && (verified === entry.source || sameChannelPrincipal(verified, entry.source))
      ? entry.source
      : undefined
    return source ? { source, threadId: entry.threadId, ...(entry.turnId ? { turnId: entry.turnId } : {}) } : undefined
  }
  requestText(metadata: unknown): string | undefined {
    const caller = this.caller(metadata)
    if (!caller) return undefined
    const matches = Object.values(this.state().inputs ?? {}).filter(record => {
      const event = record.input.source.event
      return ['adapterId', 'accountId', 'tenantId', 'conversationId', 'messageId'].every(key =>
        event[key as keyof ChannelEventRef] === caller.source[key as keyof ChannelEventRef]
      )
        && event.actor?.userId === caller.source.actor?.userId
    })
    if (matches.length !== 1) return undefined
    return matches[0]!.input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }
  routine(command: unknown, threadId: string, turnId: string): boolean {
    const operation = this.native()?.cliApprovalOperation?.(command)
    if (!operation || operation.kind === 'write') return false
    if (
      this.native()?.isPreparing(threadId)
      && !['continuation-history', 'continuation-takeover-ready'].includes(operation.operation)
    ) return false
    let source = this.source(threadId, turnId)
    if (operation.context) {
      const entry = this.native()?.contextFor(operation.context)
      if (entry?.threadId !== threadId || entry.turnId !== undefined && entry.turnId !== turnId) return false
      if (entry.source) {
        if (!source || source !== entry.source && !sameChannelPrincipal(source, entry.source)) return false
        source = entry.source
      }
    }
    if (!source) return false
    const continuation = continuationRoutine(operation, threadId, turnId, this.native())
    if (continuation !== undefined) return continuation
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
