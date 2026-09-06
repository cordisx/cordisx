import type {
  AgentPageComposerCommandAdapter,
  AgentPageComposerCommandRequest,
  AgentPageComposerCommandResult,
} from '@cordisx/protocol/agent-page-admission/v2'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'

import type { CordisXCommandReference } from '../contracts.js'
import type { CordisXAgentSessionRuntime } from './agent-session-runtime.js'
import type { CordisXCommandService } from './commands.js'
import type { PageAdmissionBinding, PageAdmissionRoute } from './page-admission-lifecycle.js'

/** Host-private factory behind the public mount-bound pageComposer prop. */
export function createPageComposerAdapter(input: {
  readonly ownerId: string
  readonly owner: PluginOwnerIdentity
  readonly binding: PageAdmissionBinding
  readonly route: PageAdmissionRoute
  readonly generation: string
  readonly signal: AbortSignal
  readonly runtime: CordisXAgentSessionRuntime
  readonly commands: CordisXCommandService
}): AgentPageComposerCommandAdapter {
  return Object.freeze({
    execute: async (request: AgentPageComposerCommandRequest): Promise<AgentPageComposerCommandResult> => {
      if (input.signal.aborted) return { status: 'unavailable', code: 'page-replaced' }
      const context = input.runtime.beginPageComposerCommand(input.owner, {
        binding: input.binding,
        route: input.route,
        generation: input.generation,
        commandId: request.command.id,
        submitPayload: request.submitPayload,
      })
      if (context === undefined) return { status: 'unavailable', code: 'host-unavailable' }
      let failure: unknown
      try {
        await input.commands.executeForPage(
          input.ownerId,
          request.command as CordisXCommandReference,
          `page:${context.origin.executionId}`,
          context,
        )
      } catch (error) {
        failure = error
      }
      return input.runtime.finishPageComposerCommand(input.owner, context, failure)
    },
  })
}
