import { describe, expect, it } from 'vitest'
import {
  extractLegacyChannelStyle,
  restoreLegacyChannelStyle,
} from '../packages/cli/src/launcher/legacy-channel-styles.js'
import type { BuiltPluginGenerationArtifact } from '../packages/cli/src/launcher/production-plugin-build.js'

describe('legacy Channel stylesheet extraction', () => {
  it('reads exactly one static top-level string without executing the module', () => {
    const source = 'globalThis.shouldNotRun = true; const channel_default = ".channel { display: flex }";'
    expect(extractLegacyChannelStyle(source)).toBe('.channel { display: flex }')
    expect(Reflect.get(globalThis, 'shouldNotRun')).toBeUndefined()
  })

  it.each([
    'const channel_default = makeStyle();',
    'const channel_default = "first"; const channel_default = "second";',
    'function nested() { const channel_default = "hidden" }',
    'const channel_default = `dynamic ${value}`;',
  ])('rejects a non-static or ambiguous declaration', source => {
    expect(() => extractLegacyChannelStyle(source)).toThrow()
  })

  it('does not inspect or change graphs outside the exact release identity', async () => {
    const artifact = { manifest: { initialStyles: [] } } as unknown as BuiltPluginGenerationArtifact
    const identity = {
      pluginId: 'channel',
      version: '0.1.7',
      canonicalSource: 'https://github.com/cordisx/plugin-channel',
    }
    const integrity = 'sha256:0cc75afbf84d117835863b00a57e0412c621b8ec4e2c387327a6dd2e4f123856' as const
    for (
      const changed of [
        { packageManifest: { ...identity, pluginId: 'other' }, artifactIntegrity: integrity },
        { packageManifest: { ...identity, version: '0.1.8' }, artifactIntegrity: integrity },
        {
          packageManifest: { ...identity, canonicalSource: 'https://example.test/channel' },
          artifactIntegrity: integrity,
        },
        { packageManifest: identity, artifactIntegrity: `sha256:${'a'.repeat(64)}` as const },
      ]
    ) {
      expect(await restoreLegacyChannelStyle({ ...changed, entry: '/missing', artifact })).toBe(artifact)
    }
  })
})
