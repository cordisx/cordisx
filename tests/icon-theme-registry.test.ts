import { describe, expect, it } from 'vitest'
import type { CordisXIconThemeProviderDefinitionV1, IconThemeResolutionResult, NormalizedVectorDescriptor } from '../packages/cli/src/icon-theme-contracts.js'
import {
  BUILTIN_REICON_PROVIDER_GENERATION,
  BUILTIN_REICON_PROVIDER_HANDLE,
  IconThemeRegistry,
} from '../packages/cli/src/renderer/icon-theme-registry.js'

const descriptor: NormalizedVectorDescriptor = {
  format: 'cordisx.normalized-vector', formatVersion: 1,
  viewBox: { minX: 0, minY: 0, width: 24, height: 24 },
  paths: [{ paint: 'stroke', strokeWidth: 1.5, lineCap: 'round', lineJoin: 'round', commands: [{ op: 'move', x: 3, y: 12 }, { op: 'line', x: 21, y: 12 }] }],
}

const definition = (value: NormalizedVectorDescriptor = descriptor): CordisXIconThemeProviderDefinitionV1 => ({
  schemaVersion: 1, namespace: 'aurora', providerVersion: '2.1.0',
  descriptors: [{ key: 'action.save', variant: 'regular', state: 'default', descriptor: value }],
})

const principal = { principalHandle: 'ipp_aurora0000000001' as const, pluginId: 'aurora', providerGeneration: 'aurora-3' }

describe('descriptor-only icon theme registry', () => {
  it('publishes a pinned, complete Reicon default without raw geometry in its proof', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const selection = registry.selection()
    const registration = registry.registration(BUILTIN_REICON_PROVIDER_HANDLE)!
    expect(selection).toMatchObject({ profileRevision: 0, outcome: 'default', selectedProvider: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' } })
    expect(selection.defaultProvider).toEqual(selection.fallbackProvider)
    expect(registration.coverage).toMatchObject({ kind: 'complete', proof: { tupleCount: 1176, rawDataExported: false } })
    expect(JSON.stringify(registration.coverage)).not.toMatch(/commands|paths|svg|iconData|callback/u)
  })

  it('derives plugin identity and serves a partial hit before exact Reicon fallback', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const registered = registry.registerPlugin('register-1', 0, 'host-12', principal, definition())
    const registration = registered.registration!
    expect(registered.result).toMatchObject({ outcome: 'staged', profileRevision: 1 })
    expect(registration).toMatchObject({
      authority: 'host', principal: { pluginId: 'aurora' },
      identity: { providerId: 'plugin:aurora:aurora', namespace: 'aurora', providerVersion: '2.1.0' },
      providerGeneration: 'aurora-3', status: 'ready', coverage: { kind: 'partial' },
    })
    expect(registry.selectProvider('select-1', 1, 'host-12', {
      providerId: 'plugin:aurora:aurora', namespace: 'aurora', providerVersion: '2.1.0', providerGeneration: 'aurora-3',
    })).toMatchObject({ outcome: 'applied', profileRevision: 2 })
    expect(registry.resolve('action.save', 'regular', 'default')).toMatchObject({ provider: { providerId: 'plugin:aurora:aurora' }, fallback: 'none' })
    expect(registry.resolve('action.save', 'filled', 'default')).toMatchObject({ provider: { providerId: 'builtin:reicon' }, fallback: 'reicon' })
  })

  it('rejects callbacks, identity impersonation, raw path data and hostile descriptor fields atomically', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const cases: unknown[] = [
      { ...definition(), resolve: () => descriptor },
      { ...definition(), providerId: 'builtin:reicon' },
      definition({ ...descriptor, paths: [{ paint: 'fill', commands: [{ op: 'move', x: 0, y: 0 }, { op: 'line', x: 1, y: 1 }], d: 'M0 0L1 1' }] } as NormalizedVectorDescriptor),
      definition({ ...descriptor, paths: [{ ...descriptor.paths[0], color: 'red', onClick: () => {} }] } as NormalizedVectorDescriptor),
    ]
    for (const [index, hostile] of cases.entries()) {
      const outcome = registry.registerPlugin(`hostile-${index}`, 0, 'host-12', principal, hostile as CordisXIconThemeProviderDefinitionV1)
      expect(outcome.result).toMatchObject({ outcome: 'rejected' })
      expect(outcome.registration).toBeUndefined()
      expect(registry.selection().profileRevision).toBe(0)
    }
  })

  it('fences stale revision, Host generation and provider generation', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const registration = registry.registerPlugin('register-1', 0, 'host-12', principal, definition()).registration!
    expect(registry.select('select-stale-rev', 0, 'host-12', registration.providerHandle, 'aurora-3')).toMatchObject({ outcome: 'conflict', profileRevision: 1, error: { code: 'stale-revision' } })
    expect(registry.select('select-stale-host', 1, 'host-11', registration.providerHandle, 'aurora-3')).toMatchObject({ outcome: 'conflict', profileRevision: 1, error: { code: 'stale-host-generation' } })
    expect(registry.select('select-stale-provider', 1, 'host-12', registration.providerHandle, 'aurora-2')).toMatchObject({ outcome: 'rejected', profileRevision: 1, error: { code: 'stale-provider-generation' } })
  })

  it('ignores late results after rollback and restores exact pinned Reicon', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const registration = registry.registerPlugin('register-1', 0, 'host-12', principal, definition()).registration!
    registry.select('select-1', 1, 'host-12', registration.providerHandle, 'aurora-3')
    const request = registry.createResolutionRequest('action.save', 'regular', 'default')
    expect(registry.rollback('rollback-1', 2, 'host-12', registration.providerHandle, 'aurora-3', BUILTIN_REICON_PROVIDER_HANDLE, BUILTIN_REICON_PROVIDER_GENERATION, 'invalid-descriptor')).toMatchObject({ outcome: 'rolled-back', profileRevision: 3 })
    const late: IconThemeResolutionResult = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-result.v1.schema.json',
      schemaVersion: 1, requestId: request.requestId, providerGeneration: 'aurora-3', outcome: 'resolved', descriptor,
    }
    expect(registry.acceptResolution(request, late)).toMatchObject({ provider: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' }, fallback: 'reicon' })
    expect(registry.selection()).toMatchObject({ outcome: 'rolled-back', reason: 'invalid-descriptor', selectedProvider: { providerHandle: BUILTIN_REICON_PROVIDER_HANDLE } })
  })

  it('refuses selected disposal, disposes an exact retired generation, and redacts snapshots', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const registration = registry.registerPlugin('register-1', 0, 'host-12', principal, definition()).registration!
    registry.select('select-1', 1, 'host-12', registration.providerHandle, 'aurora-3')
    expect(registry.disposeProvider('dispose-selected', 2, 'host-12', registration.providerHandle, 'aurora-3')).toMatchObject({ outcome: 'rejected', error: { code: 'provider-selected' } })
    registry.select('select-default', 2, 'host-12', BUILTIN_REICON_PROVIDER_HANDLE, BUILTIN_REICON_PROVIDER_GENERATION)
    expect(registry.disposeProvider('dispose-1', 3, 'host-12', registration.providerHandle, 'aurora-3')).toMatchObject({ outcome: 'applied', profileRevision: 4, disposedGeneration: 'aurora-3' })
    const snapshot = JSON.stringify(registry.redactedSnapshot())
    expect(snapshot).not.toMatch(/providerHandle|principalHandle|descriptors|commands|paths|source|requestId|raw/u)
    expect(snapshot).toContain('plugin:aurora:aurora')
  })

  it('fails a drifted rollback closed onto the non-provider neutral fallback', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const registration = registry.registerPlugin('register-1', 0, 'host-12', principal, definition()).registration!
    registry.select('select-1', 1, 'host-12', registration.providerHandle, 'aurora-3')
    expect(registry.rollback('rollback-bad', 2, 'host-12', registration.providerHandle, 'aurora-3', BUILTIN_REICON_PROVIDER_HANDLE, 'reicon-drift')).toMatchObject({ outcome: 'rollback-failed', profileRevision: 2 })
    expect(registry.resolve('action.save', 'regular', 'default')).toMatchObject({ provider: { providerId: 'host:neutral' }, fallback: 'neutral' })
  })
})
