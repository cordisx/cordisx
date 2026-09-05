import { afterEach, describe, expect, it } from 'vitest'
import { PlaygroundScenarioLabController } from '../packages/cli/src/playground/scenario-lab.js'
import {
  PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
  type PlaygroundRoomSimulationBinding,
  PlaygroundRoomSimulationBridgeRegistry,
  type PlaygroundRoomSimulationOwner,
} from '../packages/cli/src/renderer/playground-room-simulation-bridge.js'

const binding: PlaygroundRoomSimulationBinding = Object.freeze({
  contract: PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
  sessionId: 'cx-session.room-one.lead',
  roomId: 'room-one',
  runId: 'run-lead',
  memberId: 'lead',
  bindingId: 'session-room-binding-one',
  ownerGeneration: 'owner-one',
  generation: 'owner-one',
})

const available = <Value>(value: Value) =>
  Object.freeze({
    status: 'available' as const,
    ownerGeneration: 'owner-one',
    value,
  })

function owner(): PlaygroundRoomSimulationOwner {
  return {
    ownerGeneration: 'owner-one',
    resolveSession: async sessionId =>
      sessionId === binding.sessionId
        ? available(binding)
        : { status: 'unavailable', code: 'session-unbound', message: 'unbound' },
    inspect: async input =>
      available({
        binding: input,
        lifecycle: 'active',
        revision: 1,
        delegationTargets: [{ memberId: 'reviewer', label: 'Reviewer' }],
      }),
    injectMessage: async (_input, operationId) => available({ operationId, phase: 'accepted', binding }),
    emitAgentReply: async (_input, operationId) => available({ operationId, phase: 'accepted', binding }),
    emitAgentApprovalRequest: async (_input, operationId) => available({ operationId, phase: 'accepted', binding }),
    delegateTask: async (_input, operationId) => available({ operationId, phase: 'accepted', binding }),
    requestPermission: async (_input, operationId) => available({ operationId, phase: 'accepted', binding }),
    decidePermission: async (_input, operationId) => available({ operationId, phase: 'accepted', binding }),
    snapshot: async input => available({ binding: input, revision: 1, events: [] }),
    subscribe: () => () => {},
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('Playground Agent Session Room discovery', () => {
  it('resolves one exact Session through the current Chatroom owner', async () => {
    const registry = new PlaygroundRoomSimulationBridgeRegistry()
    registry.register(owner())

    await expect(registry.client.resolveSession(binding.sessionId!)).resolves.toEqual(available(binding))
    await expect(registry.client.resolveSession('')).resolves.toMatchObject({
      status: 'unavailable',
      code: 'invalid-binding',
    })
  })

  it('lets Scenario Lab discover Room targets from SessionId without a route-carried binding', async () => {
    const registry = new PlaygroundRoomSimulationBridgeRegistry()
    registry.register(owner())
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __cordisxRuntime: { playgroundRoomSimulationBridge: registry.client } },
    })
    const definition = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
      contract: 'cordisx.agent-definition/v1',
      schemaVersion: 1,
      identity: { agentId: 'chatroom.generalist', revision: 'revision-one' },
      name: 'Chatroom Agent',
      inherit: {
        promptSections: 'none',
        rules: 'none',
        skills: 'none',
        tools: 'none',
        mcpServers: 'none',
        runtimeDefaults: 'none',
      },
      promptSections: [],
    } as const
    const controller = new PlaygroundScenarioLabController({
      taskRef: binding.sessionId!,
      sessionId: binding.sessionId!,
      debugTaskId: 'Session task',
      detailsUrl: { url: `app://-/playground/simulator/tasks/${binding.sessionId}`, target: 'host' },
      agentLabel: 'Chatroom Agent',
      status: 'completed',
      identity: definition.identity,
      catalog: [definition],
      events: [],
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getSnapshot().injector.roomBridge).toEqual({
      state: 'available',
      delegationTargets: [{ memberId: 'reviewer', label: 'Reviewer' }],
    })
    controller.dispose()
  })
})
