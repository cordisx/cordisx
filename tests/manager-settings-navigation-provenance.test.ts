import { describe, expect, it } from 'vitest'
import { CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9 } from '../packages/cli/src/contracts.js'
import {
  MANAGER_SETTINGS_NAVIGATION_LEGACY_PROVENANCE,
  MANAGER_SETTINGS_NAVIGATION_VERSIONED_PROVENANCE,
  projectManagerSettingsNavigation,
} from '../packages/cli/src/renderer/manager-settings-navigation.js'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surfaces.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'

function registry(): SurfaceRegistry {
  const result = new SurfaceRegistry(new HostContextStore())
  result.setResolvers({
    command: () => false,
    route: () => false,
    managerSettingsNavigationRoute: () => ({ state: 'available' }),
  })
  return result
}

describe('Manager Settings navigation provenance', () => {
  it('keeps legacy and exact v9 registrations distinguishable', () => {
    const surfaces = registry()
    surfaces.register('demo', {
      name: 'manager.settings.navigation-items',
      id: 'legacy',
      group: 'before-settings',
    }, { route: { id: 'legacy' } })
    surfaces.register('demo', {
      $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
      schemaVersion: 9,
      name: 'manager.settings.navigation-items',
      id: 'grouped',
      group: 'after-settings',
    }, { route: { id: 'grouped' }, navigationGroup: { id: 'collaboration' } })

    expect(Object.fromEntries(surfaces.snapshot().map(item => [
      item.id,
      item.managerSettingsNavigationSurfaceProvenance,
    ]))).toEqual({
      legacy: { kind: 'legacy-unversioned' },
      grouped: {
        kind: 'versioned',
        $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
        schemaVersion: 9,
      },
    })
    surfaces.dispose()
  })

  it('fails closed on half-versioned or unversioned navigationGroup registrations', () => {
    const surfaces = registry()
    expect(() => surfaces.register('demo', {
      $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
      name: 'manager.settings.navigation-items',
      id: 'half',
      group: 'before-settings',
    } as never, { route: { id: 'half' } })).toThrow(/\$schema and schemaVersion together/u)
    expect(() => surfaces.register('demo', {
      name: 'manager.settings.navigation-items',
      id: 'unversioned-group',
      group: 'before-settings',
    }, { route: { id: 'unversioned-group' }, navigationGroup: { id: 'resources' } })).toThrow(
      /requires the exact surface-contribution\.v9 identity/u,
    )
    surfaces.dispose()
  })

  it('rechecks the provenance fence when an item is updated', () => {
    const surfaces = registry()
    const contribution = surfaces.register('demo', {
      name: 'manager.settings.navigation-items',
      id: 'legacy',
      group: 'before-settings',
    }, { route: { id: 'legacy' } })
    contribution.update({ route: { id: 'legacy' }, navigationGroup: { id: 'development' } })
    expect(surfaces.snapshot()[0]).toMatchObject({
      valid: false,
      error: expect.stringMatching(/requires the exact surface-contribution\.v9 identity/u),
    })
    surfaces.dispose()
  })

  it('projects declared, unassigned, and legacy fallback assignments without guessing a version', () => {
    const projection = projectManagerSettingsNavigation([
      {
        owner: 'demo',
        id: 'chat',
        group: 'before-settings',
        order: 20,
        navigationGroup: 'collaboration',
        surfaceProvenance: MANAGER_SETTINGS_NAVIGATION_VERSIONED_PROVENANCE,
      },
      {
        owner: 'demo',
        id: 'unassigned',
        group: 'after-settings',
        order: 30,
        surfaceProvenance: MANAGER_SETTINGS_NAVIGATION_VERSIONED_PROVENANCE,
      },
      {
        owner: 'legacy',
        id: 'tool',
        group: 'before-settings',
        order: 10,
        surfaceProvenance: MANAGER_SETTINGS_NAVIGATION_LEGACY_PROVENANCE,
      },
    ])

    expect(projection.contributions).toEqual([
      expect.objectContaining({
        id: 'chat',
        declaredGroup: 'collaboration',
        effectiveGroup: 'collaboration',
        assignment: 'declared',
      }),
      expect.objectContaining({ id: 'unassigned', effectiveGroup: 'other', assignment: 'unassigned-fallback' }),
      expect.objectContaining({ id: 'tool', effectiveGroup: 'other', assignment: 'legacy-fallback' }),
    ])
  })
})
