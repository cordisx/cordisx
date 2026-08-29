import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  ICON_STATES,
  ICON_VARIANTS,
  SEMANTIC_ICON_KEYS,
  type CordisXIconThemeProviderDefinitionV1,
  type IconThemeResolutionResult,
  type NormalizedVectorDescriptor,
} from '../packages/cli/src/icon-theme-contracts.js'
import {
  BUILTIN_REICON_PROVIDER_GENERATION,
  IconThemeRegistry,
} from '../packages/cli/src/renderer/icon-theme-registry.js'
import {
  selectAndPersistIconTheme,
  type IconThemePreferenceWriter,
} from '../packages/cli/src/renderer/icon-theme-selection.js'

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

const require = createRequire(import.meta.url)
const protocolRoot = path.resolve(path.dirname(require.resolve('@cordisx/protocol/connector-service/v1')), '..')

async function formalRegistrationValidator() {
  const schemas = await Promise.all([
    'ui-common.v1.schema.json',
    'icon-theme-common.v1.schema.json',
    'icon-theme-provider-registration.v1.schema.json',
  ].map(async name => JSON.parse(await readFile(path.join(protocolRoot, 'schemas', name), 'utf8')) as object))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  for (const schema of schemas) ajv.addSchema(schema)
  return ajv.getSchema('https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-provider-registration.v1.schema.json')!
}

async function formalCommonSchema() {
  return JSON.parse(await readFile(path.join(protocolRoot, 'schemas', 'icon-theme-common.v1.schema.json'), 'utf8')) as {
    $defs: {
      semanticIconKey: { enum: string[] }
      variant: { enum: string[] }
      state: { enum: string[] }
      completeCoverageProof: {
        properties: Record<string, { const: unknown }>
      }
    }
  }
}

function fullDefinition(): CordisXIconThemeProviderDefinitionV1 {
  return {
    schemaVersion: 1,
    namespace: 'aurora',
    providerVersion: '2.1.0',
    descriptors: SEMANTIC_ICON_KEYS.flatMap(key => ICON_VARIANTS.flatMap(variant => ICON_STATES.map(state => ({
      key, variant, state, descriptor,
    })))),
  }
}

describe('descriptor-only icon theme registry', () => {
  it('keeps the Host catalog and complete proof exact with the pinned formal Protocol schema', async () => {
    const schema = await formalCommonSchema()
    expect(SEMANTIC_ICON_KEYS).toEqual(schema.$defs.semanticIconKey.enum)
    expect(ICON_VARIANTS).toEqual(schema.$defs.variant.enum)
    expect(ICON_STATES).toEqual(schema.$defs.state.enum)
    expect(schema.$defs.completeCoverageProof.properties).toMatchObject({
      catalogDigest: { const: 'sha256:fabbf2ac3d7177bc353432e4175240cc3fe10d040321e2b785c1da0f77634771' },
      keyCount: { const: 64 },
      variantCount: { const: 3 },
      stateCount: { const: 8 },
      tupleCount: { const: 1536 },
    })
  })

  it('publishes a pinned, formally valid complete Reicon default without raw geometry in its proof', async () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const selection = registry.selection()
    const registration = registry.registration(registry.builtinProviderHandle)!
    expect(selection).toMatchObject({ profileRevision: 0, outcome: 'default', selectedProvider: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' } })
    expect(selection.defaultProvider).toEqual(selection.fallbackProvider)
    expect(registration.coverage).toMatchObject({
      kind: 'complete',
      proof: {
        catalogDigest: 'sha256:fabbf2ac3d7177bc353432e4175240cc3fe10d040321e2b785c1da0f77634771',
        keyCount: 64,
        tupleCount: 1536,
        rawDataExported: false,
      },
    })
    expect(JSON.stringify(registration.coverage)).not.toMatch(/commands|paths|svg|iconData|callback/u)
    const validate = await formalRegistrationValidator()
    expect(validate(registration), JSON.stringify(validate.errors)).toBe(true)
  })

  it('keeps builtin and plugin handles fresh per registry while pins stay exact within one registry', () => {
    const first = new IconThemeRegistry('host-first', 'profile-main')
    const second = new IconThemeRegistry('host-second', 'profile-main')
    expect(first.builtinProviderHandle).not.toBe(second.builtinProviderHandle)
    expect(first.selection().defaultProvider.providerHandle).toBe(first.builtinProviderHandle)
    expect(first.selection().fallbackProvider.providerHandle).toBe(first.builtinProviderHandle)
    expect(first.selection().selectedProvider.providerHandle).toBe(first.builtinProviderHandle)
    const firstPlugin = first.registerPlugin('register-first', 0, 'host-first', principal, definition()).registration!
    const secondPlugin = second.registerPlugin('register-second', 0, 'host-second', principal, definition()).registration!
    expect(firstPlugin.providerHandle).not.toBe(secondPlugin.providerHandle)
  })

  it('fails closed instead of serializing a schema-invalid 1,536-tuple plugin partial', async () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const complete = fullDefinition()
    expect(complete.descriptors).toHaveLength(1536)
    const rejected = registry.registerPlugin('register-complete', 0, 'host-12', principal, complete)
    expect(rejected).toMatchObject({ result: { outcome: 'rejected', profileRevision: 0 } })
    expect(rejected.registration).toBeUndefined()

    const accepted = registry.registerPlugin('register-partial', 0, 'host-12', principal, {
      ...complete,
      descriptors: complete.descriptors.slice(0, 1535),
    }).registration!
    const validate = await formalRegistrationValidator()
    expect(validate(accepted), JSON.stringify(validate.errors)).toBe(true)
    expect(accepted.coverage).toMatchObject({ kind: 'partial' })
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
    expect(registry.rollback('rollback-1', 2, 'host-12', registration.providerHandle, 'aurora-3', registry.builtinProviderHandle, BUILTIN_REICON_PROVIDER_GENERATION, 'invalid-descriptor')).toMatchObject({ outcome: 'rolled-back', profileRevision: 3 })
    const late: IconThemeResolutionResult = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-result.v1.schema.json',
      schemaVersion: 1, requestId: request.requestId, providerGeneration: 'aurora-3', outcome: 'resolved', descriptor,
    }
    expect(registry.acceptResolution(request, late)).toMatchObject({ provider: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' }, fallback: 'reicon' })
    expect(registry.selection()).toMatchObject({ outcome: 'rolled-back', reason: 'invalid-descriptor', selectedProvider: { providerHandle: registry.builtinProviderHandle } })
  })

  it('keeps process Host generations and provider handles fresh while rejecting an old-process result', () => {
    const processA = new IconThemeRegistry('host-process-a', 'profile-main')
    const processB = new IconThemeRegistry('host-process-b', 'profile-main')
    const stablePrincipal = { ...principal, providerGeneration: 'artifact_stable_generation_1' }
    const registrationA = processA.registerPlugin('register-a', 0, 'host-process-a', stablePrincipal, definition()).registration!
    const registrationB = processB.registerPlugin('register-b', 0, 'host-process-b', stablePrincipal, definition()).registration!
    expect(processA.hostGeneration).not.toBe(processB.hostGeneration)
    expect(registrationA.providerGeneration).toBe(registrationB.providerGeneration)
    expect(registrationA.providerHandle).not.toBe(registrationB.providerHandle)

    processA.select('select-a', 1, 'host-process-a', registrationA.providerHandle, registrationA.providerGeneration)
    const oldRequest = processA.createResolutionRequest('action.save', 'regular', 'default')
    processB.select('select-b', 1, 'host-process-b', registrationB.providerHandle, registrationB.providerGeneration)
    const oldResult: IconThemeResolutionResult = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-result.v1.schema.json',
      schemaVersion: 1,
      requestId: oldRequest.requestId,
      providerGeneration: oldRequest.providerGeneration,
      outcome: 'resolved',
      descriptor,
    }
    expect(processB.acceptResolution(oldRequest, oldResult)).toMatchObject({
      provider: { providerId: 'builtin:reicon' },
      fallback: 'reicon',
    })
    expect(processB.resolve('action.save', 'regular', 'default')).toMatchObject({
      provider: { providerId: 'plugin:aurora:aurora' },
      fallback: 'none',
    })
  })

  it('refuses selected disposal, disposes an exact retired generation, and redacts snapshots', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const registration = registry.registerPlugin('register-1', 0, 'host-12', principal, definition()).registration!
    registry.select('select-1', 1, 'host-12', registration.providerHandle, 'aurora-3')
    expect(registry.disposeProvider('dispose-selected', 2, 'host-12', registration.providerHandle, 'aurora-3')).toMatchObject({ outcome: 'rejected', error: { code: 'provider-selected' } })
    registry.select('select-default', 2, 'host-12', registry.builtinProviderHandle, BUILTIN_REICON_PROVIDER_GENERATION)
    expect(registry.disposeProvider('dispose-1', 3, 'host-12', registration.providerHandle, 'aurora-3')).toMatchObject({ outcome: 'applied', profileRevision: 4, disposedGeneration: 'aurora-3' })
    const snapshot = JSON.stringify(registry.redactedSnapshot())
    expect(snapshot).not.toMatch(/providerHandle|principalHandle|descriptors|commands|paths|source|requestId|raw/u)
    expect(snapshot).toContain('plugin:aurora:aurora')
  })

  it('fails a drifted rollback closed onto the non-provider neutral fallback', () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    let notifications = 0
    registry.subscribe(() => { notifications += 1 })
    const registration = registry.registerPlugin('register-1', 0, 'host-12', principal, definition()).registration!
    registry.select('select-1', 1, 'host-12', registration.providerHandle, 'aurora-3')
    const beforeRollback = notifications
    expect(registry.rollback('rollback-bad', 2, 'host-12', registration.providerHandle, 'aurora-3', registry.builtinProviderHandle, 'reicon-drift')).toMatchObject({ outcome: 'rollback-failed', profileRevision: 2 })
    expect(notifications).toBe(beforeRollback + 1)
    expect(registry.resolve('action.save', 'regular', 'default')).toMatchObject({ provider: { providerId: 'host:neutral' }, fallback: 'neutral' })
  })

  it('does not let an earlier persistence rejection roll back over a later selection winner', async () => {
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    registry.registerPlugin('register-1', 0, 'host-12', principal, definition())
    const providers = registry.redactedSnapshot().providers
    const aurora = providers.find(provider => provider.providerId === 'plugin:aurora:aurora')!
    const builtin = providers.find(provider => provider.providerId === 'builtin:reicon')!
    const pending: Array<{
      candidate: Record<string, unknown>
      resolve: (value: {
        revision: number
        providerId: `builtin:${string}` | `plugin:${string}:${string}`
        namespace: string
        providerVersion: string
        providerGeneration: string
      }) => void
      reject: (error: Error) => void
    }> = []
    const writer: IconThemePreferenceWriter = {
      persist: (_expected, _selected, candidate) => new Promise((resolve, reject) => {
        pending.push({ candidate: { ...candidate }, resolve, reject })
      }),
    }

    const earlier = selectAndPersistIconTheme(registry, writer, 'host-12', 1, aurora)
    const earlierObserved = earlier.catch(error => error as Error)
    expect(registry.selection().profileRevision).toBe(2)
    const later = selectAndPersistIconTheme(registry, writer, 'host-12', 2, builtin)
    expect(registry.selection().profileRevision).toBe(3)
    expect(pending).toHaveLength(2)
    for (const item of pending) expect(Object.keys(item.candidate).sort()).toEqual([
      'namespace', 'providerGeneration', 'providerId', 'providerVersion',
    ])

    pending[1]!.resolve({
      revision: 1,
      providerId: 'builtin:reicon',
      namespace: 'reicon',
      providerVersion: '1.2.1',
      providerGeneration: 'reicon-1.2.1',
    })
    await expect(later).resolves.toBeUndefined()
    pending[0]!.reject(new Error('earlier persistence rejected'))
    const earlierError = await earlierObserved
    expect(earlierError).toBeInstanceOf(Error)
    expect(earlierError.message).toBe('earlier persistence rejected')
    expect(registry.selection()).toMatchObject({
      profileRevision: 3,
      selectedProvider: { providerId: 'builtin:reicon' },
    })
  })
})
