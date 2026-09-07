import type {
  AgentConversationShellPage as AgentConversationShellPageV4,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
  AgentConversationShellUpdate as AgentConversationShellUpdateV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import type {
  AgentConversationShellPage as AgentConversationShellPageV5,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV5,
  AgentConversationShellUpdate as AgentConversationShellUpdateV5,
} from '@cordisx/protocol/agent-conversation-shell/v5'
import type {
  AgentConversationItem as ProtocolItemV6,
  AgentConversationShellPage as AgentConversationShellPageV6,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV6,
  AgentConversationShellUpdate as AgentConversationShellUpdateV6,
} from '@cordisx/protocol/agent-conversation-shell/v6'
import type {
  AgentConversationItem as ProtocolItemV7,
  AgentConversationShellPage as AgentConversationShellPageV7,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV7,
  AgentConversationShellUpdate as AgentConversationShellUpdateV7,
} from '@cordisx/protocol/agent-conversation-shell/v12'
import { immutableSnapshot } from './validation.js'
import {
  type AgentConversationShellPage,
  type AgentConversationShellSnapshot,
  type AgentConversationShellUpdate,
  assertItem,
  assertSnapshot,
  assertSnapshotAssociations,
  exactKeys,
  plainObject,
  safeSequence,
} from './agent-conversation-shell-validation.js'
import {
  assertItemV4,
  assertItemV6,
  assertItemV7,
  assertSnapshotV4,
  assertSnapshotV5,
  assertSnapshotV6,
  assertSnapshotV7,
  assertSubscription,
  sameBinding,
  sameSubscription,
} from './agent-conversation-shell-validation-v4.js'
import { MountedConversationBase } from './agent-conversation-shell-base.js'

export abstract class MountedConversationUpdates extends MountedConversationBase {
  protected async consume(
    pages: AsyncIterable<
      | AgentConversationShellPage
      | AgentConversationShellPageV4
      | AgentConversationShellPageV5
      | AgentConversationShellPageV6
      | AgentConversationShellPageV7
    >,
  ): Promise<void> {
    for await (const pageInput of pages) {
      if (this.disposed) return
      if (this.terminal) throw new Error('conversation source emitted a page after terminal disposal')
      const page = immutableSnapshot(pageInput)
      this.applyPage(page)
      if (this.terminal) return
    }
    if (!this.disposed && !this.terminal) throw new Error('conversation source ended without terminal disposal')
  }

  private applyPage(
    page:
      | AgentConversationShellPage
      | AgentConversationShellPageV4
      | AgentConversationShellPageV5
      | AgentConversationShellPageV6
      | AgentConversationShellPageV7,
  ): void {
    plainObject(page, 'subscription page')
    exactKeys(
      page,
      ['subscription', 'afterSequence', 'phase', 'updates', 'nextAfterSequence', 'hasMore'],
      'subscription page',
    )
    assertSubscription(page.subscription, 'subscription page.subscription')
    if (this.subscription === undefined || !sameSubscription(page.subscription, this.subscription)) {
      throw new Error('subscription page descriptor differs from the accepted subscription')
    }
    safeSequence(page.afterSequence, 'subscription page.afterSequence')
    safeSequence(page.nextAfterSequence, 'subscription page.nextAfterSequence')
    if (page.afterSequence !== this.cursor) throw new Error('subscription page cursor is not serialized')
    if (page.phase !== 'replay' && page.phase !== 'live') throw new Error('subscription page phase is invalid')
    if (this.cursor < this.subscription.snapshotSequence && page.phase !== 'replay') {
      throw new Error('live subscription page arrived before the replay watermark')
    }
    if (this.cursor >= this.subscription.snapshotSequence && page.phase !== 'live') {
      throw new Error('replay subscription page arrived after its watermark')
    }
    if (!Array.isArray(page.updates) || page.updates.length > 128) {
      throw new Error('subscription page updates are invalid')
    }
    if (typeof page.hasMore !== 'boolean') throw new Error('subscription page.hasMore must be boolean')
    let expected = this.cursor + 1
    let terminal = false
    for (const [index, update] of page.updates.entries()) {
      this.assertUpdate(update, `subscription page.updates[${index}]`)
      if (update.sequence !== expected) {
        throw new Error(
          `subscription updates are not monotonic (expected ${expected}, received ${update.sequence}, page after ${page.afterSequence})`,
        )
      }
      if (page.phase === 'replay' && update.sequence > this.subscription.snapshotSequence) {
        throw new Error('replay subscription update crossed its snapshot watermark')
      }
      if (terminal) throw new Error('subscription page contains an update after terminal disposal')
      this.applyUpdate(update)
      terminal = update.kind === 'disposed'
      expected += 1
    }
    const expectedNext = page.updates.length === 0 ? this.cursor : page.updates.at(-1)!.sequence
    if (page.nextAfterSequence !== expectedNext) throw new Error('subscription next cursor is invalid')
    if (page.phase === 'replay' && page.nextAfterSequence > this.subscription.snapshotSequence) {
      throw new Error('replay subscription cursor crossed its snapshot watermark')
    }
    if (terminal && page.hasMore) throw new Error('terminal subscription page cannot have more pages')
    if (page.phase === 'replay' && !page.hasMore && page.nextAfterSequence !== this.subscription.snapshotSequence) {
      throw new Error('replay subscription did not reach its snapshot watermark')
    }
    this.cursor = page.nextAfterSequence
    this.terminal = terminal
    if (terminal) {
      this.releaseSource()
      this.renderStatus('unavailable')
    } else this.render()
  }

  private assertUpdate(
    value: unknown,
    label: string,
  ): asserts value is
    | AgentConversationShellUpdate
    | AgentConversationShellUpdateV4
    | AgentConversationShellUpdateV5
    | AgentConversationShellUpdateV6
    | AgentConversationShellUpdateV7
  {
    plainObject(value, label)
    if (value.kind === 'snapshot-replaced') {
      exactKeys(value, ['kind', 'sequence', 'snapshot'], label)
      safeSequence(value.sequence, `${label}.sequence`)
      if (this.record.version >= 7) {
        assertSnapshotV7(
          value.snapshot,
          this.record.version >= 10,
          this.record.version >= 11,
          this.record.version === 12,
        )
      } else if (this.record.version === 6) assertSnapshotV6(value.snapshot)
      else if (this.record.version === 5) assertSnapshotV5(value.snapshot)
      else if (this.record.version === 4) assertSnapshotV4(value.snapshot)
      else assertSnapshot(value.snapshot)
      return
    }
    if (value.kind === 'item-appended' || value.kind === 'item-updated') {
      exactKeys(value, ['kind', 'sequence', 'item'], label)
      safeSequence(value.sequence, `${label}.sequence`)
      if (this.record.version >= 7) {
        assertItemV7(
          value.item,
          `${label}.item`,
          this.record.version >= 10,
          this.record.version >= 11,
        )
      } else if (this.record.version === 6) assertItemV6(value.item, `${label}.item`)
      else if (this.record.version >= 4) assertItemV4(value.item, `${label}.item`)
      else assertItem(value.item, `${label}.item`)
      return
    }
    if (value.kind === 'disposed') {
      exactKeys(value, ['kind', 'sequence', 'reason'], label)
      safeSequence(value.sequence, `${label}.sequence`)
      if (!['explicit', 'owner-disposed', 'generation-replaced'].includes(value.reason as string)) {
        throw new Error(`${label}.reason is invalid`)
      }
      return
    }
    throw new Error(`${label}.kind is invalid`)
  }

  private applyUpdate(
    update:
      | AgentConversationShellUpdate
      | AgentConversationShellUpdateV4
      | AgentConversationShellUpdateV5
      | AgentConversationShellUpdateV6
      | AgentConversationShellUpdateV7,
  ): void {
    if (this.record.version >= 4) {
      this.applyUpdateV4(
        update as
          | AgentConversationShellUpdateV4
          | AgentConversationShellUpdateV5
          | AgentConversationShellUpdateV6
          | AgentConversationShellUpdateV7,
      )
    } else this.applyUpdateV3(update as AgentConversationShellUpdate)
  }

  private applyUpdateV3(update: AgentConversationShellUpdate): void {
    const snapshot = this.snapshot as AgentConversationShellSnapshot | undefined
    if (snapshot === undefined) throw new Error('conversation snapshot is unavailable')
    if (update.kind === 'disposed') return
    if (update.kind === 'snapshot-replaced') {
      if (update.snapshot.snapshotSequence !== update.sequence) {
        throw new Error('replacement snapshot sequence differs from its update')
      }
      this.assertSnapshotFence(update.snapshot)
      if (update.snapshot.generation !== snapshot.generation) {
        throw new Error('replacement snapshot crossed its generation fence')
      }
      this.snapshot = immutableSnapshot(update.snapshot)
      return
    }
    if (update.item.sequence > update.sequence) {
      throw new Error('conversation item sequence exceeds its update sequence')
    }
    const existing = snapshot.items.findIndex(item => item.itemId === update.item.itemId)
    if (update.kind === 'item-appended' && existing !== -1) throw new Error('item-appended references an existing item')
    if (update.kind === 'item-updated' && existing === -1) throw new Error('item-updated references an unknown item')
    const items = [...snapshot.items]
    if (existing === -1) items.push(update.item)
    else {
      const previous = items[existing]!
      if (previous.kind !== update.item.kind || previous.sequence !== update.item.sequence) {
        throw new Error('item-updated changed its stable kind or item sequence')
      }
      if (previous.kind === 'message' && update.item.kind === 'message') {
        if (
          previous.messageId !== update.item.messageId
          || JSON.stringify(previous.author) !== JSON.stringify(update.item.author)
          || previous.source !== update.item.source
          || JSON.stringify(previous.semantic) !== JSON.stringify(update.item.semantic)
        ) {
          throw new Error('item-updated changed its message association')
        }
        const priorReactions = previous.reactions ?? []
        const nextReactions = update.item.reactions ?? []
        if (nextReactions.length < priorReactions.length) throw new Error('item-updated removed an existing reaction')
        for (const [index, prior] of priorReactions.entries()) {
          const reaction = nextReactions[index]
          if (
            reaction === undefined
            || prior.reactionId !== reaction.reactionId
            || prior.actorParticipantId !== reaction.actorParticipantId
            || JSON.stringify(prior.value) !== JSON.stringify(reaction.value)
            || prior.state !== 'pending' && prior.state !== reaction.state
          ) {
            throw new Error('item-updated changed its reaction identity or terminal state')
          }
        }
        if (nextReactions.slice(priorReactions.length).some(reaction => reaction.state !== 'pending')) {
          throw new Error('item-updated appended a terminal reaction')
        }
      }
      if (
        previous.kind === 'member-presence' && update.item.kind === 'member-presence'
        && (previous.participantId !== update.item.participantId
          || previous.memberId !== update.item.memberId
          || previous.runId !== update.item.runId)
      ) {
        throw new Error('item-updated changed its member presence association')
      }
      if (previous.kind === 'approval' && update.item.kind === 'approval') {
        if (
          previous.participantId !== update.item.participantId
          || previous.memberId !== update.item.memberId
          || previous.runId !== update.item.runId
          || previous.binding.bindingId !== update.item.binding.bindingId
          || previous.binding.generation !== update.item.binding.generation
          || previous.turn !== update.item.turn
          || previous.approvalId !== update.item.approvalId
          || previous.approvalKind !== update.item.approvalKind
          || JSON.stringify(previous.rationale) !== JSON.stringify(update.item.rationale)
        ) {
          throw new Error('item-updated changed its approval association')
        }
        if (previous.state !== 'pending') {
          if (JSON.stringify(previous) !== JSON.stringify(update.item)) {
            throw new Error('item-updated changed a terminal approval')
          }
        } else if (update.item.state === 'pending' && JSON.stringify(previous) !== JSON.stringify(update.item)) {
          throw new Error('item-updated changed a pending approval without resolving it')
        }
      }
      items[existing] = update.item
    }
    const next = immutableSnapshot({ ...snapshot, snapshotSequence: update.sequence, items })
    assertSnapshotAssociations(next)
    this.snapshot = next
  }

  private applyUpdateV4(
    update:
      | AgentConversationShellUpdateV4
      | AgentConversationShellUpdateV5
      | AgentConversationShellUpdateV6
      | AgentConversationShellUpdateV7,
  ): void {
    const snapshot = this.snapshot as
      | AgentConversationShellSnapshotV4
      | AgentConversationShellSnapshotV5
      | AgentConversationShellSnapshotV6
      | AgentConversationShellSnapshotV7
      | undefined
    const label = `v${this.record.version}`
    if (snapshot === undefined) throw new Error(`${label} conversation snapshot is unavailable`)
    if (update.kind === 'disposed') return
    if (update.kind === 'snapshot-replaced') {
      if (update.snapshot.snapshotSequence !== update.sequence) {
        throw new Error(`${label} replacement snapshot sequence differs from its update`)
      }
      this.assertSnapshotFence(update.snapshot)
      if (update.snapshot.generation !== snapshot.generation) {
        throw new Error(`${label} replacement snapshot crossed its generation fence`)
      }
      if (this.record.version >= 7) {
        this.assertV7ApprovalReplacementPreservesTimeline(
          snapshot as AgentConversationShellSnapshotV7,
          update.snapshot as AgentConversationShellSnapshotV7,
        )
      }
      this.snapshot = immutableSnapshot(update.snapshot)
      return
    }
    if (update.item.sequence > update.sequence) {
      throw new Error(`${label} conversation item sequence exceeds its update sequence`)
    }
    const existing = snapshot.items.findIndex(item => item.itemId === update.item.itemId)
    if (update.kind === 'item-appended' && existing !== -1) {
      throw new Error(`${label} item-appended references an existing item`)
    }
    if (update.kind === 'item-updated' && existing === -1) {
      throw new Error(`${label} item-updated references an unknown item`)
    }
    const items = [...snapshot.items]
    if (existing === -1) items.push(update.item)
    else {
      const previous = items[existing]!
      if (previous.kind !== update.item.kind || previous.sequence !== update.item.sequence) {
        throw new Error(`${label} item-updated changed its stable kind or item sequence`)
      }
      if (previous.kind === 'message' && update.item.kind === 'message') {
        if (
          previous.messageId !== update.item.messageId
          || JSON.stringify(previous.author) !== JSON.stringify(update.item.author)
          || JSON.stringify(previous.source) !== JSON.stringify(update.item.source)
          || JSON.stringify(previous.semantic) !== JSON.stringify(update.item.semantic)
        ) throw new Error(`${label} item-updated changed its message association`)
      }
      if (
        previous.kind === 'member-presence' && update.item.kind === 'member-presence'
        && JSON.stringify([previous.participantId, previous.memberId, previous.runId, previous.sessionId])
          !== JSON.stringify([
            update.item.participantId,
            update.item.memberId,
            update.item.runId,
            update.item.sessionId,
          ])
      ) throw new Error(`${label} item-updated changed its member presence association`)
      if (previous.kind === 'approval' && update.item.kind === 'approval') {
        if (this.record.version >= 7) {
          const prior = previous as ProtocolItemV7 & { readonly kind: 'approval' }
          const next = update.item as ProtocolItemV7 & { readonly kind: 'approval' }
          if (
            JSON.stringify([
              prior.participantId,
              prior.memberId,
              prior.runId,
              prior.sessionId,
              prior.approvalId,
              prior.approvalKind,
              prior.requester,
              prior.authority,
              prior.reason,
            ])
              !== JSON.stringify([
                next.participantId,
                next.memberId,
                next.runId,
                next.sessionId,
                next.approvalId,
                next.approvalKind,
                next.requester,
                next.authority,
                next.reason,
              ])
          ) {
            throw new Error(`${label} item-updated changed its approval association`)
          }
          if (prior.state !== 'pending' && JSON.stringify(prior) !== JSON.stringify(next)) {
            throw new Error(`${label} item-updated changed a terminal approval`)
          }
          if (prior.state === 'pending' && next.state === 'pending' && JSON.stringify(prior) !== JSON.stringify(next)) {
            throw new Error(`${label} item-updated changed a pending approval without resolving it`)
          }
          if (
            prior.state === 'pending' && next.state !== 'pending' && next.agentGeneration !== undefined
            && next.agentGeneration !== prior.agentGeneration
          ) throw new Error(`${label} item-updated changed its approval generation`)
        } else {
          const priorApproval = previous as ProtocolItemV6 & { readonly kind: 'approval' }
          const nextApproval = update.item as ProtocolItemV6 & { readonly kind: 'approval' }
          const includeGeneration = this.record.version !== 6
          const prior = JSON.stringify([
            priorApproval.participantId,
            priorApproval.memberId,
            priorApproval.runId,
            priorApproval.sessionId,
            ...(includeGeneration ? [priorApproval.agentGeneration] : []),
            priorApproval.approvalId,
            priorApproval.approvalKind,
            priorApproval.rationale,
          ])
          const next = JSON.stringify([
            nextApproval.participantId,
            nextApproval.memberId,
            nextApproval.runId,
            nextApproval.sessionId,
            ...(includeGeneration ? [nextApproval.agentGeneration] : []),
            nextApproval.approvalId,
            nextApproval.approvalKind,
            nextApproval.rationale,
          ])
          if (prior !== next) throw new Error(`${label} item-updated changed its approval association`)
          if (previous.state !== 'pending' && JSON.stringify(previous) !== JSON.stringify(update.item)) {
            throw new Error(`${label} item-updated changed a terminal approval`)
          }
          if (
            this.record.version === 6 && previous.state === 'pending' && update.item.state === 'pending'
            && JSON.stringify(previous) !== JSON.stringify(update.item)
          ) throw new Error(`${label} item-updated changed a pending approval without resolving it`)
          if (
            this.record.version === 6 && previous.state === 'pending' && update.item.state !== 'pending'
            && update.item.agentGeneration !== undefined && update.item.agentGeneration !== previous.agentGeneration
          ) {
            throw new Error(`${label} item-updated changed its approval generation`)
          }
        }
      }
      items[existing] = update.item
    }
    const next = immutableSnapshot({ ...snapshot, snapshotSequence: update.sequence, items })
    if (this.record.version >= 7) {
      assertSnapshotV7(next, this.record.version >= 10, this.record.version >= 11, this.record.version === 12)
    } else if (this.record.version === 6) assertSnapshotV6(next)
    else if (this.record.version === 5) assertSnapshotV5(next)
    else assertSnapshotV4(next)
    this.snapshot = next
  }

  private assertV7ApprovalReplacementPreservesTimeline(
    previous: AgentConversationShellSnapshotV7,
    next: AgentConversationShellSnapshotV7,
  ): void {
    const nextById = new Map(next.items.map(item => [item.itemId, item] as const))
    let approvalTimelineEstablished = false
    for (const item of previous.items) {
      if (item.kind !== 'approval') continue
      approvalTimelineEstablished = true
      const candidate = nextById.get(item.itemId)
      // Shell v7 exposes no item-removal, timeline-reset, or retention
      // discontinuity. Once a source has established an approval timeline,
      // every replacement on that same live binding must retain it. A source
      // that needs to compact history has to close/rebind; it cannot erase
      // durable Room facts through snapshot-replaced.
      if (candidate?.kind !== 'approval') {
        throw new Error('v7 approval replacement removed an established approval from its timeline')
      }
      if (
        JSON.stringify([
          item.participantId,
          item.memberId,
          item.runId,
          item.sessionId,
          item.approvalId,
          item.approvalKind,
          item.requester,
          item.authority,
          item.reason,
        ])
          !== JSON.stringify([
            candidate.participantId,
            candidate.memberId,
            candidate.runId,
            candidate.sessionId,
            candidate.approvalId,
            candidate.approvalKind,
            candidate.requester,
            candidate.authority,
            candidate.reason,
          ])
      ) {
        throw new Error('v7 approval replacement changed its durable association')
      }
      if (candidate.agentGeneration !== undefined && candidate.agentGeneration !== item.agentGeneration) {
        throw new Error('v7 approval replacement changed its generation')
      }
      if (item.state !== 'pending' && JSON.stringify(candidate) !== JSON.stringify(item)) {
        throw new Error('v7 approval replacement rewrote an established terminal approval')
      }
    }
    if (!approvalTimelineEstablished) return
    for (const item of previous.items) {
      if (!nextById.has(item.itemId)) throw new Error('v7 approval replacement removed an existing timeline item')
    }
  }

  protected assertSnapshotFence(
    snapshot:
      | AgentConversationShellSnapshot
      | AgentConversationShellSnapshotV4
      | AgentConversationShellSnapshotV5
      | AgentConversationShellSnapshotV6
      | AgentConversationShellSnapshotV7,
  ): void {
    if (!sameBinding(snapshot.binding, this.binding)) throw new Error('conversation snapshot crossed its binding fence')
  }
}
