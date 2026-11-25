import { expect, it, vi } from 'vitest'
import {
  DesktopManagerConfigProjection,
  isDesktopConfigFieldValue,
  projectDesktopManagerConfig,
} from '../packages/cli/src/cli/desktop-manager-config-projection.js'

const item = {
  id: 'demo',
  version: '1.0.0',
  digest: 'sha256:' + 'a'.repeat(64),
  moduleGeneration: 'demo-generation',
  enabled: true,
  dependencies: [],
}
const snapshot: any = { active: { profileId: 'default', revision: 3, plugins: [item] }, registryEpoch: 2 }
const plugin: any = {
  id: item.id,
  source: 'https://example.test/demo',
  enabled: true,
  revision: 4,
  package: { ...item },
  config: { display: { label: 'visible' }, token: 'synthetic-secret' },
}
const proof: any = {
  snapshot,
  plugin: {
    id: item.id,
    source: plugin.source,
    package: { ...item, dependencies: [] },
    configuration: {
      namespace: item.id,
      schemaKind: 'schemastery',
      revision: 4,
      lastGoodRevision: 4,
      value: { display: { label: 'visible' } },
      fields: [
        { path: ['display', 'label'], type: 'string' },
        { path: ['token'], type: 'string', role: 'secret' },
      ],
      secrets: [{ path: ['token'], set: false }],
    },
  },
}

it('projects only the exact native schema fields and never serializes a secret', () => {
  const result = projectDesktopManagerConfig(snapshot, plugin, proof)
  expect(result).toEqual({ display: { label: 'visible' } })
  expect(JSON.stringify(result)).not.toContain('synthetic-secret')
})

it('projects a configured archive only from the matching Desktop configuration proof', async () => {
  const configured = {
    id: 'configured-demo',
    source: 'https://example.test/configured-demo',
    enabled: true,
    revision: 4,
    configuredArchiveDigest: 'sha256:' + 'b'.repeat(64),
    distributionArtifact: { version: '1.0.0', integrity: 'sha256:' + 'c'.repeat(64) },
    config: { label: 'visible', token: 'synthetic-configured-secret' },
  }
  const native = {
    snapshot,
    plugin: {
      id: configured.id,
      source: configured.source,
      configured: { ...configured.distributionArtifact, moduleGeneration: 'artifact_configured' },
      configuration: {
        namespace: configured.id,
        schemaKind: 'schemastery',
        revision: 4,
        lastGoodRevision: 4,
        value: { label: 'visible' },
        fields: [
          { path: ['label'], type: 'string' },
          { path: ['token'], type: 'string', role: 'secret' },
        ],
        secrets: [{ path: ['token'], set: false }],
      },
    },
  }
  expect(projectDesktopManagerConfig(snapshot, configured as any, native as any)).toEqual({ label: 'visible' })
  const projector = new DesktopManagerConfigProjection({
    current: () => true,
    seat: () => Symbol.for('configured-seat'),
    read: async () => native as any,
  })
  expect(await projector.canWrite(snapshot, configured as any)).toBe(false)
  expect(await projector.canCoordinateLifecycle(snapshot, configured as any)).toBe(false)
  for (
    const changed of [
      { ...configured, source: 'https://example.test/other' },
      {
        ...configured,
        distributionArtifact: { ...configured.distributionArtifact, integrity: 'sha256:' + 'd'.repeat(64) },
      },
      { ...configured, revision: 5 },
      { ...configured, config: { ...configured.config, undeclared: 'synthetic-private' } },
    ]
  ) {
    expect(() => projectDesktopManagerConfig(snapshot, changed as any, native as any)).toThrow(
      'desktop-manager-config-unavailable',
    )
  }
  const leaked = structuredClone(native)
  ;(leaked.plugin.configuration.value as Record<string, string>).token = 'synthetic-configured-secret'
  expect(() => projectDesktopManagerConfig(snapshot, configured as any, leaked as any)).toThrow(
    'desktop-manager-config-unavailable',
  )
})

it('rejects stale identity, unclassified fields, leaked secrets and pending restarts', () => {
  const stale = structuredClone(proof)
  stale.plugin.package.moduleGeneration = 'different'
  expect(() => projectDesktopManagerConfig(snapshot, plugin, stale)).toThrow('desktop-manager-config-unavailable')
  const unknown = structuredClone(proof)
  const unknownPlugin = { ...plugin, config: { ...plugin.config, unclassified: 'private' } }
  unknown.plugin.configuration.value.unclassified = 'private'
  expect(() => projectDesktopManagerConfig(snapshot, unknownPlugin, unknown)).toThrow(
    'desktop-manager-config-unavailable',
  )
  const leaked = structuredClone(proof)
  leaked.plugin.configuration.value.token = 'synthetic-secret'
  expect(() => projectDesktopManagerConfig(snapshot, plugin, leaked)).toThrow('desktop-manager-config-unavailable')
  const pending = structuredClone(proof)
  pending.plugin.configuration.lastGoodRevision = 3
  expect(() => projectDesktopManagerConfig(snapshot, plugin, pending)).toThrow('desktop-manager-config-unavailable')
  const standard = structuredClone(proof)
  standard.plugin.configuration.schemaKind = 'standard'
  expect(() => projectDesktopManagerConfig(snapshot, plugin, standard)).toThrow('desktop-manager-config-unavailable')
})

it('shares a fenced readback across pages and invalidates it on seat loss', async () => {
  const read = vi.fn(async () => proof)
  let current = true
  const seat = Symbol('desktop-seat')
  const projection = new DesktopManagerConfigProjection({ current: () => current, seat: () => seat, read })
  const [first, second] = await Promise.all([
    projection.project(snapshot, plugin),
    projection.project(snapshot, plugin),
  ])
  expect(first).toEqual(second)
  expect(read).toHaveBeenCalledOnce()
  await projection.project(snapshot, plugin)
  expect(read).toHaveBeenCalledOnce()
  projection.clear()
  await projection.project(snapshot, plugin)
  expect(read).toHaveBeenCalledTimes(2)
  current = false
  await expect(projection.project(snapshot, plugin)).rejects.toThrow('desktop-manager-config-unavailable')
})

it('discards a late native readback after the last Desktop seat is lost', async () => {
  let finish!: (value: any) => void
  const read = vi.fn(() => new Promise<any>(resolve => finish = resolve))
  const seat = Symbol('desktop-seat')
  const projection = new DesktopManagerConfigProjection({ current: () => true, seat: () => seat, read })
  const pending = projection.project(snapshot, plugin)
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  projection.clear()
  finish(proof)
  await expect(pending).rejects.toThrow('desktop-manager-config-unavailable')
})

it('never reuses a cached proof after a Desktop seat changes or becomes ambiguous', async () => {
  const read = vi.fn(async () => proof)
  let seat: symbol | undefined = Symbol('first-seat')
  const projection = new DesktopManagerConfigProjection({ current: () => true, seat: () => seat, read })
  await projection.project(snapshot, plugin)
  await projection.project(snapshot, plugin)
  expect(read).toHaveBeenCalledTimes(1)
  seat = undefined
  await expect(projection.project(snapshot, plugin)).rejects.toThrow('desktop-manager-config-unavailable')
  seat = Symbol('changed-seat')
  await projection.project(snapshot, plugin)
  expect(read).toHaveBeenCalledTimes(2)
})

it('discards a native readback if the seat changes while the read is pending', async () => {
  let finish!: (value: any) => void
  let seat: symbol | undefined = Symbol('first-seat')
  const read = vi.fn(() => new Promise<any>(resolve => finish = resolve))
  const projection = new DesktopManagerConfigProjection({ current: () => true, seat: () => seat, read })
  const pending = projection.project(snapshot, plugin)
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  seat = Symbol('replacement-seat')
  finish(proof)
  await expect(pending).rejects.toThrow('desktop-manager-config-unavailable')
})

it('offers writes only for a live, non-secret proof and remembers confirmed readback for another page', async () => {
  const clean = { ...plugin, config: { display: { label: 'visible' } } }
  const native = structuredClone(proof)
  native.plugin.configuration.writable = true
  native.plugin.configuration.applies = 'live'
  const read = vi.fn(async () => native)
  let seat: symbol | undefined = Symbol('seat')
  const projection = new DesktopManagerConfigProjection({ current: () => true, seat: () => seat, read })
  expect(await projection.canWrite(snapshot, plugin)).toBe(false)
  expect(await projection.canWrite(snapshot, clean)).toBe(true)
  expect(await projection.canCoordinateLifecycle(snapshot, plugin)).toBe(false)
  expect(await projection.canCoordinateLifecycle(snapshot, clean)).toBe(true)
  const readonlyProof = structuredClone(native)
  readonlyProof.plugin.configuration.writable = false
  const readonlyProjection = new DesktopManagerConfigProjection({
    current: () => true,
    seat: () => Symbol.for('readonly-seat'),
    read: async () => readonlyProof,
  })
  expect(await readonlyProjection.canWrite(snapshot, clean)).toBe(false)
  expect(await readonlyProjection.canCoordinateLifecycle(snapshot, clean)).toBe(true)
  const next = { ...clean, revision: 5, config: { display: { label: 'updated' } } }
  const updated = structuredClone(native)
  updated.plugin.configuration.revision = 5
  updated.plugin.configuration.lastGoodRevision = 5
  updated.plugin.configuration.value.display.label = 'updated'
  expect(projection.remember(snapshot, next, updated)).toBe(true)
  expect(await projection.project(snapshot, next)).toEqual({ display: { label: 'updated' } })
  expect(read).toHaveBeenCalledTimes(2)
  seat = undefined
  expect(projection.remember(snapshot, next, updated)).toBe(false)
})

it('projects a declared primitive array while rejecting unclassified or sensitive array contents', async () => {
  const arrayPlugin = { ...plugin, config: { labels: ['one', 'two'] } }
  const native = structuredClone(proof)
  native.plugin.configuration.value = { labels: ['one', 'two'] }
  native.plugin.configuration.fields = [{ path: ['labels'], type: 'array', arrayItemType: 'string' }]
  native.plugin.configuration.secrets = []
  native.plugin.configuration.writable = true
  native.plugin.configuration.applies = 'live'
  expect(projectDesktopManagerConfig(snapshot, arrayPlugin, native)).toEqual({ labels: ['one', 'two'] })
  const projector = new DesktopManagerConfigProjection({
    current: () => true,
    seat: () => Symbol.for('array-seat'),
    read: async () => native,
  })
  expect(await projector.canWrite(snapshot, arrayPlugin)).toBe(true)
  const objectPlugin = { ...arrayPlugin, config: { labels: [{ secret: 'synthetic' }] } }
  const objectProof = structuredClone(native)
  objectProof.plugin.configuration.value = objectPlugin.config
  objectProof.plugin.configuration.fields[0].arrayItemType = undefined
  expect(() => projectDesktopManagerConfig(snapshot, objectPlugin, objectProof)).toThrow(
    'desktop-manager-config-unavailable',
  )
  const mixed = { ...arrayPlugin, config: { labels: ['one', 2] } }
  const mixedProof = structuredClone(native)
  mixedProof.plugin.configuration.value = mixed.config
  expect(() => projectDesktopManagerConfig(snapshot, mixed, mixedProof)).toThrow('desktop-manager-config-unavailable')
  const oversized = { ...arrayPlugin, config: { labels: Array.from({ length: 257 }, () => 'value') } }
  const oversizedProof = structuredClone(native)
  oversizedProof.plugin.configuration.value = oversized.config
  expect(() => projectDesktopManagerConfig(snapshot, oversized, oversizedProof)).toThrow(
    'desktop-manager-config-unavailable',
  )
  const sensitive = structuredClone(native)
  sensitive.plugin.configuration.fields[0].role = 'secret'
  expect(() => projectDesktopManagerConfig(snapshot, arrayPlugin, sensitive)).toThrow(
    'desktop-manager-config-unavailable',
  )
})

it('enforces primitive array element types and bounded natural numbers', () => {
  const field = (arrayItemType: string) => ({ type: 'array', arrayItemType }) as never
  expect(isDesktopConfigFieldValue(field('boolean'), [true, false])).toBe(true)
  expect(isDesktopConfigFieldValue(field('boolean'), ['true'])).toBe(false)
  expect(isDesktopConfigFieldValue(field('number'), [1, 2.5])).toBe(true)
  expect(isDesktopConfigFieldValue(field('number'), [Number.NaN])).toBe(false)
  expect(isDesktopConfigFieldValue(field('natural'), [0, 2])).toBe(true)
  expect(isDesktopConfigFieldValue(field('natural'), [-1, 2.5])).toBe(false)
})

it('rejects values that do not match the declared scalar field in a native readback', () => {
  const numericPlugin = { ...plugin, config: { count: 'not-a-number' } }
  const numericProof = structuredClone(proof)
  numericProof.plugin.configuration.value = numericPlugin.config
  numericProof.plugin.configuration.fields = [{ path: ['count'], type: 'number' }]
  numericProof.plugin.configuration.secrets = []
  expect(() => projectDesktopManagerConfig(snapshot, numericPlugin, numericProof)).toThrow(
    'desktop-manager-config-unavailable',
  )
  const scalar = (type: string, choices?: unknown[]) => ({ type, choices }) as never
  expect(isDesktopConfigFieldValue(scalar('string'), true)).toBe(false)
  expect(isDesktopConfigFieldValue(scalar('boolean'), 'true')).toBe(false)
  expect(isDesktopConfigFieldValue(scalar('number'), 2.5)).toBe(true)
  expect(isDesktopConfigFieldValue(scalar('natural'), -1)).toBe(false)
  expect(isDesktopConfigFieldValue(scalar('natural'), 1.5)).toBe(false)
  expect(isDesktopConfigFieldValue(scalar('natural'), 2)).toBe(true)
  const choices = [{ label: 'one', value: 'one' }, { label: 'two', value: 'two' }]
  expect(isDesktopConfigFieldValue(scalar('union', choices), 'one')).toBe(true)
  expect(isDesktopConfigFieldValue(scalar('union', choices), 'other')).toBe(false)
})
