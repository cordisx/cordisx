import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
} from '../../packages/cli/src/agent-loop-contracts.js'

export function base(commandId: string) {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
    contract: 'cordisx.agent-loop-command/v4' as const,
    schemaVersion: 4 as const,
    commandId,
  }
}

export const definition = {
  $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  contract: 'cordisx.agent-definition/v1' as const,
  schemaVersion: 1 as const,
  identity: { agentId: 'agent-1', revision: 'revision-1' },
  name: 'Agent One',
  promptSections: [{ sectionId: 'introduction', kind: 'introduction' as const, text: 'Coordinates this exact room.' }],
  inherit: {
    promptSections: 'none' as const,
    rules: 'none' as const,
    skills: 'none' as const,
    tools: 'none' as const,
    mcpServers: 'none' as const,
    runtimeDefaults: 'none' as const,
  },
}

export const options = () => ({
  ownerKey: 'plugin-owner',
  active: () => true,
  authorize: async (request: { capability: string }) => ({
    capability: request.capability as never,
    state: 'allowed' as const,
    code: 'allowed' as const,
  }),
  authorizeV4: async (request: { capability: string }) => ({
    capability: request.capability as never,
    state: 'allowed' as const,
    code: 'allowed' as const,
  }),
})
