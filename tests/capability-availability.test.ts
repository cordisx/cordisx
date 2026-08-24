import { describe, expect, it } from 'vitest'
import type {
  CordisXAgentEventStatus,
  CordisXAgentHistoryStatus,
  CordisXLocalizedText,
} from '../packages/cli/src/contracts.js'
import type { CordisXCapabilityProviderReport } from '../packages/cli/src/capability-availability-contracts.js'
import {
  CapabilityAvailabilityRegistry,
  externalProviderCapabilityProviders,
  hostLocalCapabilityProviders,
  platformAdapterCapabilityProvider,
} from '../packages/cli/src/renderer/capability-availability.js'
import { UnavailablePlatformAdapter } from '../packages/cli/src/renderer/platform.js'

const reason: CordisXLocalizedText = Object.freeze({ key: 'fixture', fallback: 'Fixture reason' })

function agentStatus(mode: CordisXAgentEventStatus['mode'] = 'unavailable'): CordisXAgentEventStatus {
  return {
    hostId: 'codex-desktop', hostName: 'Codex Desktop', mode,
    adapterId: 'codex', adapterVersion: 'fixture', experimental: [], diagnostics: [],
    secondConnectionCreated: false, rawBridgeExposed: false,
  }
}

function historyStatus(mode: CordisXAgentHistoryStatus['mode'] = 'available'): CordisXAgentHistoryStatus {
  return {
    hostId: 'codex-desktop', hostName: 'Codex Desktop history', mode,
    adapterId: 'codex-history', adapterVersion: 'fixture', profileId: 'work',
    defaultPayloadPolicy: 'referenced', diagnostics: [], filesystemExposed: false, rawBridgeExposed: false,
  }
}

function registry(): CapabilityAvailabilityRegistry {
  return new CapabilityAvailabilityRegistry([
    platformAdapterCapabilityProvider(new UnavailablePlatformAdapter().status(), {
      providerId: 'desktop-current-connection', kind: 'current-connection',
    }),
    ...hostLocalCapabilityProviders({
      agentStatus: agentStatus(), historyStatus: historyStatus(), configurationWritable: true,
    }),
  ])
}

describe('capability availability registry', () => {
  it('keeps Host-local Agent events and history available when Desktop current connection is unavailable', () => {
    const available = registry()
    expect(available.resolve('agent.events.read', {}).status).toBe('supported')
    expect(available.resolve('agent.history.read', {}).status).toBe('supported')
    expect(available.resolve('models.read', {}).status).toBe('unavailable')
    expect(available.resolve('agent.messages.append', {}).status).toBe('unavailable')
  })

  it('routes external Fleet capabilities by exact provider scope', () => {
    const available = new CapabilityAvailabilityRegistry([
      platformAdapterCapabilityProvider(new UnavailablePlatformAdapter().status(), {
        providerId: 'desktop-current-connection', kind: 'current-connection',
      }),
      ...externalProviderCapabilityProviders([
        { providerId: 'alpha', displayName: 'Alpha', generation: 'generation-alpha', state: 'ready' },
        { providerId: 'beta', displayName: 'Beta', state: 'unavailable' },
      ]),
    ])
    expect(available.resolve('tasks.catalog.read', {}).status).toBe('supported')
    expect(available.resolve('tasks.catalog.read', { providers: ['alpha'] }).status).toBe('supported')
    expect(available.resolve('tasks.catalog.read', { providers: ['beta'] }).status).toBe('unavailable')
    expect(available.resolve('tasks.catalog.read', { providers: ['alpha', 'beta'] }).status).toBe('degraded')
    expect(available.resolve('tasks.content.read', {
      sessions: [{ providerId: 'alpha', remoteSessionId: 'session-1' }],
    }).status).toBe('supported')
  })

  it('does not share a scoped result between plugin declarations', () => {
    const available = new CapabilityAvailabilityRegistry(externalProviderCapabilityProviders([
      { providerId: 'alpha', displayName: 'Alpha', state: 'ready' },
      { providerId: 'beta', displayName: 'Beta', state: 'unavailable' },
    ]))
    const firstPlugin = available.resolve('models.read', { providers: ['alpha'] })
    const secondPlugin = available.resolve('models.read', { providers: ['beta'] })
    expect(firstPlugin.status).toBe('supported')
    expect(secondPlugin.status).toBe('unavailable')
    expect(firstPlugin.providers.map(item => item.providerId)).toEqual(['external:alpha'])
    expect(secondPlugin.providers.map(item => item.providerId)).toEqual(['external:beta'])
  })

  it('distinguishes true unsupported and provider-reported degraded coverage', () => {
    const provider: CordisXCapabilityProviderReport = {
      providerId: 'projection', providerName: reason, kind: 'host-local', family: 'platform',
      status: 'degraded', reason,
      routes: [{ capability: 'models.read', status: 'degraded', reason, scope: {} }],
    }
    const available = new CapabilityAvailabilityRegistry([provider])
    expect(available.resolve('models.read', {}).status).toBe('degraded')
    expect(available.resolve('tasks.create', {}).status).toBe('unavailable')
  })

  it('blocks only required capabilities with no satisfying provider', () => {
    expect(registry().unavailableRequired([
      { name: 'agent.events.read', required: true, scope: {} },
      { name: 'models.read', required: true, scope: {} },
      { name: 'tasks.catalog.read', required: false, scope: {} },
    ])).toEqual(['models.read'])
  })

  it('reports Host service families without inventing Platform permission routes', () => {
    const providers = hostLocalCapabilityProviders({
      agentStatus: agentStatus(), historyStatus: historyStatus(), configurationWritable: false,
    })
    expect(providers.map(item => [item.family, item.status, item.routes.length])).toEqual(expect.arrayContaining([
      ['agent-events', 'supported', 1],
      ['agent-history', 'supported', 1],
      ['configuration', 'degraded', 0],
      ['console', 'unavailable', 0],
      ['package-lifecycle', 'unavailable', 0],
    ]))
  })

  it('rejects duplicate provider identities', () => {
    const [provider] = externalProviderCapabilityProviders([{ providerId: 'alpha', displayName: 'Alpha', state: 'ready' }])
    expect(() => new CapabilityAvailabilityRegistry([provider!, provider!])).toThrow('duplicate capability provider')
  })
})
