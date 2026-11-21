import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { adoptStandaloneChannelProjection } from '../packages/cli/src/renderer/channel-manager-owner-update.js'
import { CordisXChannelManagerPresentationService } from '../packages/cli/src/renderer/channel-manager-presentation.js'
import { stateFor } from '../packages/cli/src/renderer/channel-manager-state.js'
import { compactChannelHandoff } from '../packages/cli/src/cli/service-renderer-configured-channel.js'

it('adopts a confirmed redacted view while preserving the mounted service', () => {
  const image = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
    contract: 'cordisx.raster-image-snapshot/v1' as const,
    schemaVersion: 1 as const,
    mediaType: 'image/png' as const,
    encoding: 'base64' as const,
    width: 1,
    height: 1,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  }
  const connection = {
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    displayName: 'Before',
    adapterKind: 'simulator',
    enabled: true,
    transportMode: 'simulator',
    secretState: 'ready' as const,
  }
  const initial = {
    contract: 'cordisx.channel-manager-projection/v1' as const,
    schemaVersion: 1 as const,
    status: 'verified' as const,
    service: {
      configurationKind: 'host' as const,
      configApplies: 'service-restart' as const,
      revision: 1,
      lastGoodRevision: 1,
      writable: true,
    },
    connections: [connection],
    routes: [],
    bindings: [],
    diagnostics: [],
    accounts: [{
      ...connection,
      implementationStatus: 'verified' as const,
      connectionState: 'ready' as const,
      generation: 1,
      inbound: { pending: 0, retrying: 0, deadLetter: 0 },
      outbound: { pending: 0, retrying: 0, deadLetter: 0 },
    }],
  }
  const manager = new CordisXChannelManagerPresentationService(new Context(), {
    presentationMode: 'configuration-only',
    projection: initial,
    serviceConfig: {} as never,
  })
  const changed = vi.fn()
  const state = stateFor(manager)
  state.listeners.add(changed)
  state.runtimeProjection = {
    contract: 'cordisx.channel-manager-runtime/v1',
    schemaVersion: 1,
    observedAt: '2025-01-01T00:00:00.000Z',
    accounts: [{ ...initial.accounts[0]!, accountName: 'Current account', accountAvatar: image }],
    bindings: [],
  } as never
  const after = {
    ...initial,
    service: { ...initial.service, revision: 2, lastGoodRevision: 2 },
    connections: [{ ...connection, displayName: 'After' }],
    accounts: [{ ...initial.accounts[0]!, accountName: 'Current account', displayName: 'After' }],
  }
  const oversized = {
    ...initial,
    accounts: [{ ...initial.accounts[0]!, accountAvatar: { ...image, data: 'x'.repeat(300_000) } }],
  }
  expect(JSON.stringify(oversized).length).toBeGreaterThan(256 * 1024)
  expect(compactChannelHandoff(oversized).accounts[0]).not.toHaveProperty('accountAvatar')
  expect(adoptStandaloneChannelProjection(manager, after, 2)).toBe(true)
  expect(stateFor(manager).projection.accounts[0]?.displayName).toBe('After')
  expect(stateFor(manager).projection.accounts[0]?.accountAvatar).toEqual(image)
  expect(changed).toHaveBeenCalledOnce()
  expect(adoptStandaloneChannelProjection(manager, initial, 1)).toBe(false)
  expect(adoptStandaloneChannelProjection(manager, { ...after, secretRef: 'must-not-cross' }, 2)).toBe(false)
  expect(adoptStandaloneChannelProjection(manager, {
    ...after,
    service: { ...after.service, writable: false },
  }, 2)).toBe(false)
  expect(changed).toHaveBeenCalledOnce()
  const renamed = {
    ...after,
    service: { ...after.service, revision: 3, lastGoodRevision: 3 },
    accounts: [{ ...after.accounts[0]!, accountName: 'Different account' }],
  }
  expect(adoptStandaloneChannelProjection(manager, renamed, 3)).toBe(true)
  expect(stateFor(manager).projection.accounts[0]).not.toHaveProperty('accountAvatar')
})
