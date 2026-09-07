import { resolveAgentDefinitionCatalog } from './agent-loop.js'
import type { AgentDefinition, AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentTools } from '@cordisx/protocol/agent-tools/v1'
import type { EntityRegistry } from '@cordisx/protocol/entities/v1'
import type { CordisXAgentSessionRuntime } from './agent-session-runtime.js'
import { HostAgentTasks } from './agent-tasks.js'
import { nativeAgentTaskClient } from './native-agent-session-recovery.js'

/** Production plugin mount supplies current authority; plugins cannot supply dependencies. */
export function installAgentTasks(ctx: Context, input: {
  readonly runtime: CordisXAgentSessionRuntime
  readonly entities: EntityRegistry
  readonly tools: AgentTools & { validateCommand(commandId: string): Promise<boolean> }
  readonly active: () => boolean
}): void {
  const owner = input.runtime.ownerFromContext(ctx)
  const client = nativeAgentTaskClient(owner)
  const tasks = new HostAgentTasks({
    ...client,
    resolveContext: async context => {
      if (context?.kind === 'inherit' && !await input.runtime.authorizeTask(owner, 'read', context.sessionId)) {
        return { status: 'unavailable', code: 'permission-denied' }
      }
      return await client.resolveContext(context)
    },
    active: input.active,
    authorize: async (operation, sessionId) => await input.runtime.authorizeTask(owner, operation, sessionId),
    validateDefinition: async request => {
      const definitions = new Map<string, AgentDefinition>()
      const visit = async (identity: AgentDefinitionIdentity): Promise<boolean> => {
        const key = JSON.stringify([identity.agentId, identity.revision])
        if (definitions.has(key)) return true
        if (definitions.size >= 128) return false
        const result = await input.entities.get(identity)
        if (result.status !== 'found') return false
        definitions.set(key, result.entity.definition)
        for (const parent of result.entity.definition.extends ?? []) if (!await visit(parent)) return false
        return true
      }
      try {
        if (!await visit(request.definition)) return false
        const catalog = [...definitions.values()]
        if (catalog.length === 0) return false
        resolveAgentDefinitionCatalog({
          definition: request.definition,
          definitions: catalog as [AgentDefinition, ...AgentDefinition[]],
        })
        return true
      } catch {
        return false
      }
    },
    validateTool: async commandId => await input.tools.validateCommand(commandId),
    create: async (request, record) => {
      const acquired = await input.runtime.createEntity(
        owner,
        {
          sessionId: record.sessionId,
          definition: request.definition,
          ...(request.options === undefined ? {} : { options: request.options }),
        },
        input.entities,
        record.context,
      )
      return acquired.status === 'accepted' ? await input.runtime.get(owner, acquired.sessionId) : undefined
    },
    bind: async (commandId, sessionId, scope) => {
      await input.tools.bind({ commandId, sessionId, scope })
    },
    submit: async (agent, messageId, text) =>
      (await agent.followup({
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation },
      })).status === 'accepted',
    observe: async sessionId =>
      (await input.runtime.get(owner, sessionId))?.status
        ?? { status: 'unavailable', code: 'host-unavailable' },
  })
  ctx.effect(() => ctx.reflect.provide('agentTasks', tasks))
}
