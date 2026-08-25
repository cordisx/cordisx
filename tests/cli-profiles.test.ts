import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { resolveProfileSelection } from '../packages/cli/src/cli/profiles.js'

describe('named CLI profile resolution', () => {
  it('uses the configured default profile and permits an ephemeral data override', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-selection-'))
    const configPath = path.join(root, 'config.json')
    const selection = await resolveProfileSelection({
      config: createDefaultHomeConfig(),
      configPath,
      dataMode: 'host-isolated',
    })
    expect(selection).toMatchObject({
      appId: 'codex', profileId: 'default', dataMode: 'host-isolated', created: false,
    })
  })

  it('persists a missing explicit profile as isolated and reuses it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-profile-selection-'))
    const configPath = path.join(root, 'config.json')
    const first = await resolveProfileSelection({
      config: createDefaultHomeConfig(), configPath, appId: 'codex', profileId: 'work',
    })
    expect(first).toMatchObject({ profileId: 'work', dataMode: 'shared', created: true })
    const persisted = await loadHomeConfig(configPath)
    expect(persisted.apps.codex?.profiles.work).toEqual({ displayName: 'Work', dataMode: 'shared' })
    const second = await resolveProfileSelection({
      config: persisted, configPath, appId: 'codex', profileId: 'work',
    })
    expect(second).toMatchObject({ profileId: 'work', dataMode: 'shared', created: false })
  })
})
