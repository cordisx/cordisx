import type {
  AgentConversationAction,
  AgentConversationBindingReference,
  AgentConversationCommandReference,
  AgentConversationMessage,
  AgentConversationModel,
} from './model.js'
import { immutableSnapshot } from '../../validation.js'

interface AgentConversationCommandContextBase {
  readonly binding: AgentConversationBindingReference
  readonly generation: string
  readonly command: AgentConversationCommandReference
}

export type AgentConversationCommandContext =
  | (AgentConversationCommandContextBase & {
      readonly scope: 'header'
      readonly itemId?: never
      readonly submitPayload?: never
    })
  | (AgentConversationCommandContextBase & {
      readonly scope: 'message'
      readonly itemId: string
      readonly submitPayload?: never
    })
  | (AgentConversationCommandContextBase & {
      readonly scope: 'composer-submit'
      readonly itemId?: never
      readonly submitPayload: string
    })

export interface AgentConversationCommandRequest {
  readonly ownerId: string
  readonly shell: 'agent-desktop'
  readonly invocationKey: string
  readonly reference: AgentConversationCommandReference
  readonly context: AgentConversationCommandContext
}

export interface AgentConversationCommandFence {
  readonly ownerId: string
  readonly shell: 'agent-desktop'
  readonly binding: AgentConversationBindingReference
  readonly generation: string
  /** Host-private UI freshness fence; intentionally absent from public command context. */
  readonly snapshotSequence: number
}

/**
 * Host-owned execution seam. The formal runtime adapter will implement this
 * only after the public protocol package is merged; renderer models never carry
 * callbacks or Connector handles.
 */
export interface AgentConversationCommandExecutor {
  execute(request: AgentConversationCommandRequest): Promise<unknown>
}

export function agentConversationCommandFence(model: AgentConversationModel): AgentConversationCommandFence {
  return immutableSnapshot({
    ownerId: model.ownerId,
    shell: model.shell,
    binding: model.binding,
    generation: model.generation,
    snapshotSequence: model.snapshotSequence,
  })
}

export class AgentConversationCommandController {
  private readonly running = new Set<string>()
  private readonly fence: AgentConversationCommandFence

  constructor(private readonly executor: AgentConversationCommandExecutor, model: AgentConversationModel) {
    this.fence = agentConversationCommandFence(model)
  }

  isRunning(invocationKey: string): boolean {
    return this.running.has(invocationKey)
  }

  runHeader(model: AgentConversationModel, action: AgentConversationAction): Promise<unknown> {
    this.assertCurrent(model)
    const isNewRoomAction = model.selection.kind === 'new-room' && model.selection.newRoomAction === action
    if (!isNewRoomAction && !model.headerActions.includes(action)) {
      throw new Error(`header action ${action.id} is not in the current model`)
    }
    if (action.disabled) throw new Error(action.disabledReason ?? `action ${action.id} is disabled`)
    return this.run(model, `header:${action.id}`, action.command, {
      binding: model.binding, generation: model.generation, scope: 'header', command: action.command,
    })
  }

  runMessage(model: AgentConversationModel, itemId: string, action: AgentConversationAction): Promise<unknown> {
    this.assertCurrent(model)
    if (action.disabled) throw new Error(action.disabledReason ?? `action ${action.id} is disabled`)
    const message = model.entries.find((entry): entry is AgentConversationMessage => entry.kind === 'message' && entry.itemId === itemId)
    if (message === undefined) throw new Error(`message ${itemId} is not in the current model`)
    if (!message.actions.includes(action)) throw new Error(`message action ${action.id} is not in the current model`)
    return this.run(model, `message:${itemId}:${action.id}`, action.command, {
      binding: model.binding, generation: model.generation, scope: 'message', itemId, command: action.command,
    })
  }

  runComposer(model: AgentConversationModel, text: string): Promise<unknown> {
    this.assertCurrent(model)
    if (model.composer.availability !== 'available' || model.composer.disabled) {
      throw new Error(model.composer.disabledReason ?? 'composer is unavailable')
    }
    const payloadLength = [...text].length
    if (payloadLength === 0 || payloadLength > 65_536) throw new Error('composer text must contain 1 to 65536 characters')
    return this.run(model, 'composer-submit', model.composer.submit, {
      binding: model.binding, generation: model.generation, scope: 'composer-submit',
      command: model.composer.submit, submitPayload: text,
    })
  }

  private assertCurrent(model: AgentConversationModel): void {
    if (model.ownerId !== this.fence.ownerId) throw new Error('conversation command crossed its owner fence')
    if (model.shell !== this.fence.shell) throw new Error('conversation command crossed its shell fence')
    if (model.binding.bindingId !== this.fence.binding.bindingId) throw new Error('conversation command crossed its binding fence')
    if (model.binding.ownerGeneration !== this.fence.binding.ownerGeneration) {
      throw new Error('conversation command crossed its owner generation fence')
    }
    if (model.generation !== this.fence.generation) throw new Error('conversation command crossed its snapshot generation fence')
    if (model.snapshotSequence !== this.fence.snapshotSequence) throw new Error('conversation command used a stale snapshot')
  }

  private async run(
    model: AgentConversationModel,
    invocationKey: string,
    reference: AgentConversationCommandReference,
    context: AgentConversationCommandContext,
  ): Promise<unknown> {
    if (this.running.has(invocationKey)) throw new Error(`conversation command ${invocationKey} is already running`)
    this.running.add(invocationKey)
    try {
      const request = immutableSnapshot<AgentConversationCommandRequest>({
        ownerId: model.ownerId, shell: model.shell, invocationKey, reference, context,
      })
      return await this.executor.execute(request)
    } finally {
      this.running.delete(invocationKey)
    }
  }
}
