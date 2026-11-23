import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { StandaloneRuntimeBundleCache } from '../packages/cli/src/launcher/standalone-runtime-bundle.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

const config = {
  version: 1 as const,
  rootDir: path.resolve('.'),
  codex: { debugPort: 9229 },
  providers: [],
  plugins: [],
}
const profileId = 'work'
const generation = 'owner-test'
const activation = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1 as const,
  recordKind: 'active' as const,
  profileId,
  revision: 0,
  lastGoodRevision: 0,
  runtimeGeneration: generation,
  plugins: [],
}

function options(rendererId: string, source: string, isCurrent: () => boolean | Promise<boolean> = () => true) {
  return {
    managerPresentationMode: 'standalone' as const,
    standaloneOwner: { rendererId, profileId, generation, managerOrigin: 'http://127.0.0.1:43123', isCurrent },
    profileId,
    generation,
    pluginActivation: activation,
    initialRegistryEpoch: 0,
    permission: {
      profileId,
      policies: [createPermissionPolicyRecord({
        profileId,
        identity: { source, id: 'fixture' },
        capability: 'models.read',
        scope: { providers: ['fixture'] },
        policy: 'deny',
      })],
    },
  }
}

it('shares only Host code across concurrent sessions and rejects stale owners', async () => {
  const cache = new StandaloneRuntimeBundleCache()
  const firstId = 'a'.repeat(64)
  const secondId = 'b'.repeat(64)
  const firstSource = 'https://first.fixture.invalid'
  const secondSource = 'https://second.fixture.invalid'
  try {
    const [first, second] = await Promise.all([
      buildRendererBundle(config, options(firstId, firstSource), cache),
      buildRendererBundle(config, options(secondId, secondSource), cache),
    ])
    expect(first).toContain(firstId)
    expect(first).toContain(firstSource)
    expect(first).not.toContain(secondId)
    expect(first).not.toContain(secondSource)
    expect(second).toContain(secondId)
    expect(second).toContain(secondSource)
    expect(second).not.toContain(firstId)
    expect(second).not.toContain(firstSource)
    expect(first).not.toContain(config.rootDir)
    const current = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(buildRendererBundle(config, options(firstId, firstSource, current), cache))
      .rejects.toThrow('owner attachment is unavailable')
    expect(current).toHaveBeenCalledTimes(3)
  } finally {
    cache.close()
  }
  await expect(buildRendererBundle(config, options(firstId, firstSource), cache))
    .rejects.toThrow('standalone-runtime-bundle-unavailable')
  await expect(buildRendererBundle(config, {}, cache)).rejects.toThrow('cache requires an owner')
}, 30_000)

it('does not return a bundle when the owner closes during compilation', async () => {
  const cache = new StandaloneRuntimeBundleCache()
  const runtime = fileURLToPath(new URL('../packages/cli/src/renderer/runtime.ts', import.meta.url))
  const source = 'import { installCordisX, installCordisXComposition } from ' + JSON.stringify(runtime)
    + '\nexport const fixture = true\n'
  const pending = cache.compose(source, runtime)
  cache.close()
  await expect(pending).rejects.toThrow('standalone-runtime-bundle-unavailable')
}, 30_000)
