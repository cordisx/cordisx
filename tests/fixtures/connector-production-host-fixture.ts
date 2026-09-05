import {
  CORDISX_CONNECTOR_COMMAND_SCHEMA_V1,
  CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1,
  type CordisXConnectorCommand,
  type CordisXConnectorRegistrationIdentity,
  type CordisXHostConnector,
} from '../../packages/cli/src/renderer/connectors.js'
import type { CordisXInternalRendererBootstrap } from '../../packages/cli/src/renderer/runtime.js'

const connectorIds = ['smoke.flow', 'smoke.unsubscribe', 'smoke.owner-replay', 'smoke.owner-live'] as const
const pluginIds = [
  'connector-harness-flow',
  'connector-harness-unsubscribe',
  'connector-harness-owner-replay',
  'connector-harness-owner-live',
] as const

function open(registration: CordisXConnectorRegistrationIdentity, commandId: string): CordisXConnectorCommand {
  return {
    $schema: CORDISX_CONNECTOR_COMMAND_SCHEMA_V1,
    contract: 'cordisx.connector-command/v1',
    schemaVersion: 1,
    commandId,
    registration,
    type: 'conversation.open',
    open: { mode: 'create' },
  }
}

function connector(id: string, execute: (command: CordisXConnectorCommand) => Promise<void>): CordisXHostConnector {
  return {
    descriptor: {
      $schema: CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1,
      contract: 'cordisx.connector-service-descriptor/v1',
      schemaVersion: 1,
      connectorId: id,
      protocolVersion: 1,
      capabilities: ['conversation.open', 'events.receive', 'lifecycle.dispose'],
    },
    execute: async command => {
      await execute(command)
      return { ok: true, value: { kind: 'opened', conversation: `opaque:${id}:${command.commandId}` } }
    },
  }
}

function status(id: string): string | undefined {
  return document.querySelector<HTMLElement>(`[data-connector-harness-result="${id}"]`)?.dataset.status
}

function publish(value: Record<string, unknown>): void {
  document.documentElement.dataset.connectorHarnessReport = JSON.stringify(value)
}

/**
 * Fixed test-only Host fixture. It is imported only by the isolated smoke
 * bundle and never appears in the product bundle, package, config, or plugin
 * context. Its sole renderer output is a redacted assertion record.
 */
export const installConnectorProductionFixture: CordisXInternalRendererBootstrap = ({ connectors }) => {
  const registrations = new Map<string, CordisXConnectorRegistrationIdentity>()
  let listenerRaceIssued = false
  let replacementIssued = false
  let stopped = false

  const register = (id: string): CordisXConnectorRegistrationIdentity => {
    const registered = connectors.register(connector(id, async command => {
      if (id === 'smoke.flow' && command.commandId === 'flow-outer') {
        const registration = registrations.get(id)
        if (registration === undefined) throw new Error('flow registration is unavailable')
        await connectors.command(open(registration, 'flow-reentrant'), true)
      }
      if (id === 'smoke.flow' && command.commandId === 'flow-parallel') {
        await new Promise<void>(resolve => queueMicrotask(resolve))
      }
    }))
    if (!registered.ok) throw new Error(`fixture registration failed: ${registered.error.code}`)
    registrations.set(id, registered.value.registration)
    return registered.value.registration
  }

  for (const id of connectorIds) register(id)
  connectors.setInternalSubscriptionObserver(async registration => {
    if (registration.connectorId !== 'smoke.flow' || listenerRaceIssued) return
    listenerRaceIssued = true
    await connectors.command(open(registration, 'flow-listener-race'), true)
  })

  const deadline = Date.now() + 15_000
  const timer = setInterval(() => {
    if (stopped) return
    if (status('connector-harness-flow') === 'replace-ready' && !replacementIssued) {
      replacementIssued = true
      register('smoke.flow')
    }
    const values = pluginIds.map(id => status(id))
    const active = values.filter((value): value is string => value !== undefined)
    const complete = active.length === 1
      && active.every(value => value === 'passed' || value === 'denied' || value.startsWith('failed'))
    if (!complete && Date.now() < deadline) return
    stopped = true
    clearInterval(timer)
    const snapshot = connectors.snapshot()
    const passed = complete && active.every(value => value === 'passed' || value === 'denied')
    const flowPassed = status('connector-harness-flow') === 'passed'
    const cancellationPassed = [
      'connector-harness-unsubscribe',
      'connector-harness-owner-replay',
      'connector-harness-owner-live',
    ]
      .some(id => status(id) === 'passed')
    publish({
      status: passed ? 'passed' : 'failed',
      policy: active.every(value => value === 'denied') ? 'fail-closed' : 'allow',
      listenerBeforeWatermark: listenerRaceIssued,
      replayToLive: flowPassed,
      cancellation: cancellationPassed,
      replacementTerminal: replacementIssued && flowPassed,
      rawBridgeExposed: snapshot.rawBridgeExposed,
      secondConnectionCreated: snapshot.secondConnectionCreated,
      pluginStates: active,
    })
  }, 5)
  return () => {
    stopped = true
    clearInterval(timer)
    connectors.setInternalSubscriptionObserver(undefined)
  }
}
