import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import { renderAgentDeveloperInstructions, resolveAgentDefinitionCatalog } from './agent-loop.js'

/** Resolve the selected definition, including its existing inheritance policy. */
export function nativeAgentInstructions(setup: AgentSetup | undefined): string | undefined {
  if (setup === undefined) return undefined
  const { target } = resolveAgentDefinitionCatalog(setup)
  const identity = JSON.stringify({
    ...target.identity,
    ...(target.name === undefined ? {} : { name: target.name }),
    ...(target.description === undefined ? {} : { description: target.description }),
  })
  return [
    `## CordisX Agent identity\n\n${identity}`,
    renderAgentDeveloperInstructions(target),
  ].filter(section => section !== undefined).join('\n\n')
}
