import { expect, it, vi } from 'vitest'
import { installedManagerPermissionTarget } from '../packages/cli/src/cli/service-renderer-installed-permission.js'

const alias = `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}`
const source = 'https://example.test/plugins/fixture'
const digest = `sha256:${'b'.repeat(64)}` as const
const pluginId = 'fixture-service'

function fixture() {
  const controller = new AbortController()
  const context = {
    rendererId: 'c'.repeat(64),
    profileId: 'default',
    ownerGeneration: 'owner-1',
    admitted: true,
    signal: controller.signal,
  }
  const item = {
    id: pluginId,
    enabled: true,
    version: '1.0.0',
    digest,
    moduleGeneration: 'plugin-1',
    canonicalSource: source,
    dependencies: [],
  }
  const snapshot = {
    active: {
      recordKind: 'active',
      profileId: context.profileId,
      runtimeGeneration: context.ownerGeneration,
      plugins: [item],
    },
    registryEpoch: 1,
  }
  const projection = {
    resolve: vi.fn((received: typeof context, projected: string, id: string) => {
      if (received.signal !== context.signal || projected !== alias || id !== pluginId) throw new Error('unknown')
      return { pluginId, source, digest }
    }),
    projectManagerPolicies: vi.fn((_context, _alias, _plugin, records) => records),
    resolveManagerPolicies: vi.fn((_context, _alias, _plugin, records) => records),
  }
  const entry = {
    bootstrapConfirmed: true,
    peer: { identity: { rendererId: context.rendererId } },
    identity: projection,
    identityContext: context,
    identityAliases: new Map([[pluginId, alias]]),
    plugins: [{ id: pluginId, enabled: true, source, package: { ...item } }],
    snapshot,
    leases: [{ pluginId, moduleGeneration: item.moduleGeneration }],
  }
  let currentSnapshot = snapshot
  const lifecycle = { snapshot: () => currentSnapshot }
  const create = (received = context) =>
    installedManagerPermissionTarget({
      entry: entry as never,
      context: received,
      pluginId,
      lifecycle: lifecycle as never,
      current: () => true,
    })
  return {
    controller,
    context,
    create,
    entry,
    projection,
    replaceSnapshot: () =>
      currentSnapshot = {
        ...snapshot,
        registryEpoch: 2,
      },
  }
}

it('binds a Manager alias to the exact owner-selected package and graph', () => {
  const f = fixture()
  const target = f.create()
  expect(target.identity).toEqual({ id: pluginId, source: alias })
  expect(target.ownerIdentity).toEqual({ id: pluginId, source })
  expect(target.artifact).toEqual({ version: '1.0.0', integrity: digest })
  expect(target.isCurrent()).toBe(true)
  expect(target.project([])).toEqual({ identity: target.identity, moduleGeneration: 'plugin-1', policies: [] })
  f.controller.abort()
  expect(target.isCurrent()).toBe(false)
  expect(() => target.resolve([])).toThrow('renderer-installed-permission-unavailable')
})

it('rejects an unadmitted or different session and a replaced owner generation', () => {
  const f = fixture()
  expect(() => f.create({ ...f.context, admitted: false })).toThrow('renderer-installed-permission-unavailable')
  expect(() => f.create({ ...f.context, signal: new AbortController().signal }))
    .toThrow('renderer-installed-permission-unavailable')
  const target = f.create()
  f.replaceSnapshot()
  expect(target.isCurrent()).toBe(false)
  expect(() => target.project([])).toThrow('renderer-installed-permission-unavailable')
})

it('rejects a missing graph and any package whose staged identity changed', () => {
  const f = fixture()
  f.entry.leases.length = 0
  expect(() => f.create()).toThrow('renderer-installed-permission-unavailable')
  f.entry.leases.push({ pluginId, moduleGeneration: 'plugin-1' })
  f.projection.resolve.mockReturnValueOnce({ pluginId, source: 'https://example.test/other', digest })
  expect(() => f.create()).toThrow('renderer-installed-permission-unavailable')
})
