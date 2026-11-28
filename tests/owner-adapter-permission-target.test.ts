import { expect, it } from 'vitest'
import { ownerAdapterInstalledPermissionTarget } from '../packages/cli/src/cli/owner-adapter-permission-target.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

it('binds native policy writes to the current owner-selected plugin and exact Manager point', async () => {
  const digest = `sha256:${'c'.repeat(64)}` as const
  const active = {
    recordKind: 'active',
    profileId: 'default',
    runtimeGeneration: 'owner-1',
    plugins: [{ id: 'demo', version: '1.0.0', digest, moduleGeneration: 'module-1', enabled: true, dependencies: [] }],
  }
  let snapshot = { active, registryEpoch: 1 }
  let live = true
  const target = await ownerAdapterInstalledPermissionTarget({
    homeDir: '/unused',
    profileId: 'default',
    generation: 'owner-1',
    pluginId: 'demo',
    context: { live: () => live } as never,
    lifecycle: { snapshot: () => snapshot } as never,
    loadPackage: async () =>
      ({
        digest,
        identitySource: 'file:///demo.js',
        browserArtifact: {},
        manifest: { id: 'demo', version: '1.0.0', dependencies: [] },
      }) as never,
  })
  const [record] = exactDomPermissionPolicies('default', [{
    id: 'demo',
    entry: '/demo.js',
    pointIds: ['manager.content'],
  }])
  expect(target.resolve([record!])).toEqual([record])
  expect(target.project([record!]).policies).toEqual([record])
  expect(() =>
    target.resolve([{
      ...record!,
      key: {
        ...record!.key,
        identity: {
          ...record!.key.identity,
          source: 'file:///other.js',
        },
      },
    }])
  ).toThrow()
  expect(() => target.resolve([{ ...record!, key: { ...record!.key, securityFingerprint: digest } }])).toThrow()
  snapshot = { ...snapshot, registryEpoch: 2 }
  expect(target.isCurrent()).toBe(false)
  expect(() => target.resolve([record!])).toThrow()
  live = false
})
