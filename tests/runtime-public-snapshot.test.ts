import { describe, expect, it } from 'vitest'
import type { ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { projectPublicRuntimeSnapshot } from '../packages/cli/src/renderer/public-runtime-snapshot.js'

describe('public runtime snapshot privacy', () => {
  it('removes control metadata from top-level and extension-point plugin registrations', () => {
    const registration = {
      owner: 'fixture', id: 'reasoning', qualifiedId: 'fixture:reasoning', surface: 'composer.reasoning-intensity',
      group: 'default', order: 0, item: {}, visible: true, authorized: true, pointPolicy: 'inherit', effectivePointPolicy: 'allow',
      disabled: false, valid: true, pending: false, currentContext: 'active', rendered: true,
      control: {
        principalHandle: 'principal:must-not-leak',
        identity: { source: 'file:///private/local-plugin.ts', pluginId: 'fixture', pointId: 'composer.reasoning-intensity' },
        claimId: 'reasoning', contributionId: 'reasoning', mode: 'compose', priority: 0,
        authorization: 'allowed', state: 'selected', reason: 'policy.ordered',
      },
    }
    const manager = {
      version: 'test',
      registrations: [registration],
      plugins: [{ id: 'fixture', development: { sourcePath: '/private/local-plugin.ts' } }],
      localDevelopment: [{ sourcePath: '/private/local-plugin.ts' }],
      extensionPointControls: { diagnostics: [{ principalHandle: 'principal:diagnostic' }] },
      extensionPoints: {
        schemaVersion: 1,
        points: [{
          id: 'composer.reasoning-intensity',
          plugins: [{ identity: { source: 'file:///private/local-plugin.ts', id: 'fixture' }, registrations: [registration] }],
        }],
      },
    } as unknown as ManagerSnapshot

    const projected = projectPublicRuntimeSnapshot(manager)
    expect(projected).not.toHaveProperty('localDevelopment')
    expect(projected).not.toHaveProperty('extensionPointControls')
    expect(projected.registrations[0]).not.toHaveProperty('control')
    expect(projected.extensionPoints?.points[0]?.plugins[0]?.registrations[0]).not.toHaveProperty('control')
    expect(JSON.stringify(projected)).not.toMatch(/principalHandle|principal:must-not-leak|principal:diagnostic|sourcePath/)
    expect(manager.extensionPoints?.points[0]?.plugins[0]?.registrations[0]).toHaveProperty('control')
  })
})
