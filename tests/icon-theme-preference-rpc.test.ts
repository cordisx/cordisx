import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  IconThemePreferenceConflictError,
  parseIconThemePreferenceBindingRequest,
  persistIconThemePreference,
  type IconThemePreferencePersistenceContext,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'

const token = 'a'.repeat(64)
const candidate = {
  providerId: 'plugin:aurora:aurora' as const,
  namespace: 'aurora',
  providerVersion: '2.1.0',
  providerGeneration: 'aurora-3',
}

async function context(): Promise<IconThemePreferencePersistenceContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-preference-'))
  const configPath = path.join(root, '.cordisx', 'config.json')
  await ensureHomeConfig(configPath)
  return { configPath, appId: 'codex', profileId: 'default', hostGeneration: 'host-12', token }
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    token,
    requestId: 'icon-preference-1',
    scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-12' },
    expectedPreferenceRevision: 0,
    expectedProfileRevision: 2,
    selectedProfileRevision: 3,
    candidate,
    ...overrides,
  }
}

describe('Host icon-theme preference persistence', () => {
  it('persists an exact redacted identity with profile and revision CAS fencing', async () => {
    const ctx = await context()
    const request = parseIconThemePreferenceBindingRequest(payload(), ctx)
    await expect(persistIconThemePreference(ctx, request)).resolves.toEqual({ revision: 1, ...candidate })
    expect((await loadHomeConfig(ctx.configPath)).apps.codex?.profiles.default?.iconTheme).toEqual({ revision: 1, ...candidate })
    await expect(persistIconThemePreference(ctx, request)).rejects.toBeInstanceOf(IconThemePreferenceConflictError)

    const next = parseIconThemePreferenceBindingRequest(payload({
      requestId: 'icon-preference-2',
      expectedPreferenceRevision: 1,
      expectedProfileRevision: 3,
      selectedProfileRevision: 4,
      candidate: {
        providerId: 'builtin:reicon', namespace: 'reicon', providerVersion: '1.2.1', providerGeneration: 'reicon-1.2.1',
      },
    }), ctx)
    await expect(persistIconThemePreference(ctx, next)).resolves.toMatchObject({ revision: 2, providerId: 'builtin:reicon' })
  })

  it('rejects generation spoofing, malformed transitions, raw/private fields, and hostile identities', async () => {
    const ctx = await context()
    const cases = [
      payload({ scope: { appId: 'codex', profileId: 'default', hostGeneration: 'host-11' } }),
      payload({ selectedProfileRevision: 4 }),
      payload({ candidate: { ...candidate, providerHandle: 'iph_private' } }),
      payload({ candidate: { ...candidate, providerGeneration: '/tmp/private-provider' } }),
      { ...payload(), principalHandle: 'ipp_private' },
    ]
    for (const hostile of cases) expect(() => parseIconThemePreferenceBindingRequest(hostile, ctx)).toThrow()
  })
})
