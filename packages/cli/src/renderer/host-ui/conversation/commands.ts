import type { AgentConversationAction, AgentConversationCommandReference, AgentConversationMessage, AgentConversationModel } from './model.js'

export type AgentConversationCommandContext =
  | {
      readonly kind: 'header'
      readonly bindingId: string
      readonly ownerGeneration: string
      readonly command: AgentConversationCommandReference
    }
  | {
      readonly kind: 'message'
      readonly bindingId: string
      readonly ownerGeneration: string
      readonly itemId: string
      readonly command: AgentConversationCommandReference
    }
  | {
      readonly kind: 'composer-submit'
      readonly bindingId: string
      readonly ownerGeneration: string
      readonly command: AgentConversationCommandReference
      readonly submitPayload: { readonly text: string }
    }

export interface AgentConversationCommandRequest {
  readonly ownerId: string
  readonly invocationKey: string
  readonly reference: AgentConversationCommandReference
  readonly context: AgentConversationCommandContext
}

/**
 * Host-owned execution seam. The formal runtime adapter will implement this
 * only after the public protocol package is merged; renderer models never carry
 * callbacks or Connector handles.
 */
export interface AgentConversationCommandExecutor {
  execute(request: AgentConversationCommandRequest): Promise<unknown>
}

export class AgentConversationCommandController {
  private readonly running = new Set<string>()

  constructor(private readonly executor: AgentConversationCommandExecutor) {}

  isRunning(invocationKey: string): boolean {
    return this.running.has(invocationKey)
  }

  runHeader(model: AgentConversationModel, action: AgentConversationAction): Promise<unknown> {
    if (!model.headerActions.includes(action)) throw new Error(`header action ${action.id} is not in the current model`)
    if (action.disabled) throw new Error(action.disabledReason ?? `action ${action.id} is disabled`)
    return this.run(model, `header:${action.id}`, action.command, {
      kind: 'header', bindingId: model.bindingId, ownerGeneration: model.ownerGeneration, command: action.command,
    })
  }

  runMessage(model: AgentConversationModel, itemId: string, action: AgentConversationAction): Promise<unknown> {
    if (action.disabled) throw new Error(action.disabledReason ?? `action ${action.id} is disabled`)
    const message = model.entries.find((entry): entry is AgentConversationMessage => entry.kind === 'message' && entry.id === itemId)
    if (message === undefined) throw new Error(`message ${itemId} is not in the current model`)
    if (!message.actions.includes(action)) throw new Error(`message action ${action.id} is not in the current model`)
    return this.run(model, `message:${itemId}:${action.id}`, action.command, {
      kind: 'message', bindingId: model.bindingId, ownerGeneration: model.ownerGeneration, itemId, command: action.command,
    })
  }

  runComposer(model: AgentConversationModel, text: string): Promise<unknown> {
    if (model.composer.availability !== 'available' || model.composer.disabled) {
      throw new Error(model.composer.disabledReason ?? 'composer is unavailable')
    }
    if (text.trim().length === 0 || text.length > 65_536) throw new Error('composer text must contain 1 to 65536 characters')
    return this.run(model, 'composer-submit', model.composer.submit, {
      kind: 'composer-submit', bindingId: model.bindingId, ownerGeneration: model.ownerGeneration,
      command: model.composer.submit, submitPayload: Object.freeze({ text }),
    })
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
      return await this.executor.execute(Object.freeze({ ownerId: model.ownerId, invocationKey, reference, context }))
    } finally {
      this.running.delete(invocationKey)
    }
  }
}
