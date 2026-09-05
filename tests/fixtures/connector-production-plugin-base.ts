import type { Context } from '@deepseek-ai/cordis'
import { type CordisXPluginManifestV1 } from '../../packages/cli/src/contracts.js'
import { type CordisXConnectorRegistrationIdentity } from '../../packages/cli/src/renderer/connectors.js'

type Scenario = 'flow' | 'unsubscribe' | 'owner-replay' | 'owner-live'

function result(id: string, value: string): void {
  let node = document.querySelector<HTMLElement>(`[data-connector-harness-result="${id}"]`)
  if (node === null) {
    node = document.createElement('i')
    node.hidden = true
    node.dataset.connectorHarnessResult = id
    document.documentElement.append(node)
  }
  node.dataset.status = value
}

function command(registration: CordisXConnectorRegistrationIdentity, commandId: string) {
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-command.v1.schema.json',
    contract: 'cordisx.connector-command/v1' as const,
    schemaVersion: 1 as const,
    commandId,
    registration,
    type: 'conversation.open' as const,
    open: { mode: 'create' as const },
  }
}

async function done(handle: Awaited<ReturnType<Context['connectors']['subscribe']>>): Promise<boolean> {
  if (!('handle' in handle)) return false
  const iterator = handle.handle.pages[Symbol.asyncIterator]()
  return (await iterator.next()).done === true && (await iterator.next()).done === true
}

export function connectorProductionPlugin(id: string, scenario: Scenario) {
  const connectorId = `smoke.${scenario}`
  const manifest = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v1.schema.json',
    schemaVersion: 1,
    id,
    name: `Connector production ${scenario}`,
    capabilities: [{
      name: 'agent.events.read',
      required: false,
      reason: {
        key: 'connector.production.fixture',
        fallback: 'Read the Host Connector fixture during isolated smoke.',
      },
      scope: {},
    }, {
      name: 'agent.messages.append',
      required: false,
      reason: {
        key: 'connector.production.fixture.write',
        fallback: 'Exercise the Host Connector fixture during isolated smoke.',
      },
      scope: {},
    }],
  } as const satisfies CordisXPluginManifestV1

  return {
    inject: ['connectors'] as const,
    manifest,
    apply(ctx: Context): void {
      void (async () => {
        let stage = 'discover'
        try {
          const discovery = await ctx.connectors.discover()
          if (discovery.status === 'denied') return result(id, 'denied')
          if (discovery.status !== 'accepted') return result(id, `failed:${stage}`)
          stage = 'registration'
          const registration = discovery.snapshot.registrations.find(item =>
            item.registration.connectorId === connectorId
          )?.registration
          if (registration === undefined) return result(id, `failed:${stage}`)
          stage = 'seed'
          const seed = await ctx.connectors.execute(command(registration, `${scenario}-seed`))
          if (seed.status !== 'accepted') return result(id, `failed:${stage}`)

          if (scenario === 'unsubscribe') {
            stage = 'unsubscribe-replay'
            const replay = await ctx.connectors.subscribe(registration, -1)
            if (!('handle' in replay)) return result(id, 'failed')
            replay.handle.unsubscribe()
            if (!await done(replay)) return result(id, 'failed')
            stage = 'unsubscribe-live'
            const live = await ctx.connectors.subscribe(registration, 0)
            if (!('handle' in live)) return result(id, 'failed')
            await ctx.connectors.execute(command(registration, 'unsubscribe-live'))
            live.handle.unsubscribe()
            return result(id, await done(live) ? 'passed' : 'failed')
          }

          if (scenario === 'owner-replay') {
            stage = 'owner-replay'
            const replay = await ctx.connectors.subscribe(registration, -1)
            ctx.connectors.dispose()
            return result(id, await done(replay) ? 'passed' : 'failed')
          }

          if (scenario === 'owner-live') {
            stage = 'owner-live'
            const live = await ctx.connectors.subscribe(registration, 0)
            await ctx.connectors.execute(command(registration, 'owner-live'))
            ctx.connectors.dispose()
            return result(id, await done(live) ? 'passed' : 'failed')
          }

          stage = 'flow-subscribe'
          const subscription = await ctx.connectors.subscribe(registration, -1)
          if (!('handle' in subscription)) return result(id, 'failed')
          stage = 'flow-concurrent'
          await Promise.all([
            ctx.connectors.execute(command(registration, 'flow-outer')),
            ctx.connectors.execute(command(registration, 'flow-parallel')),
          ])
          const iterator = subscription.handle.pages[Symbol.asyncIterator]()
          stage = 'flow-pages'
          const pages = await Promise.all(Array.from({ length: 5 }, async () => await iterator.next()))
          const sequences = pages.flatMap(page => page.value?.events.map(event => event.sequence) ?? [])
          const phases = pages.map(page => page.value?.phase)
          if (
            sequences.join(',') !== '0,1,2,3,4' || phases.slice(0, 2).some(phase => phase !== 'replay')
            || phases.slice(2).some(phase => phase !== 'live')
          ) {
            return result(id, 'failed')
          }
          stage = 'flow-terminal'
          result(id, 'replace-ready')
          const terminal = await iterator.next()
          const afterTerminal = await iterator.next()
          return result(
            id,
            terminal.done === false
              && terminal.value?.events[0]?.type === 'connector.disposed'
              && terminal.value?.events[0]?.disposeReason === 'generation-replaced'
              && afterTerminal.done === true
              ? 'passed'
              : 'failed',
          )
        } catch {
          result(id, `failed:${stage}`)
        }
      })()
      ctx.effect(() => () => ctx.connectors.dispose())
    },
  }
}
