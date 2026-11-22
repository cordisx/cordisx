import { expect, it, vi } from 'vitest'
import {
  DesktopManagerConfigProjection,
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
