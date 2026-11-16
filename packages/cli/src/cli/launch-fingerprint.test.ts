import { describe, expect, it } from 'vitest'
import { launchFingerprint } from './launch-fingerprint.js'
import { parseCordisXCli } from './parse.js'

const source = { url: 'https://example.test/marketplace.json', enabled: true, trusted: true }
const base = {
  version: 1,
  marketplaceSources: [source],
  apps: { codex: { profiles: { preview: { displayName: 'Preview', dataMode: 'shared' } } } },
}
const invocation = parseCordisXCli(['start'])
if (invocation.action !== 'start') throw new Error('Expected a managed start invocation')
const options = invocation.options

function fingerprint(management?: Record<string, unknown>): string {
  return launchFingerprint({
    source: JSON.stringify({
      ...base,
      apps: {
        codex: {
          profiles: {
            preview: {
              ...base.apps.codex.profiles.preview,
              ...(management === undefined ? {} : { management }),
            },
          },
        },
      },
    }),
    options,
    hostArgs: [],
    dataMode: 'shared',
    cwd: '/tmp/preview',
  })
}

const materialized = {
  revision: 1,
  migrations: { legacyBrowserSourcesV2: true },
  sources: [{ url: source.url, enabled: true }],
  hiddenCatalogEntries: [],
}

describe('launch configuration intent', () => {
  it('reuses the initial generation after inherited Marketplace selections are materialized', () => {
    expect(fingerprint(materialized)).toBe(fingerprint())
    expect(fingerprint({ ...materialized, revision: 9 })).toBe(fingerprint())
  })

  it.each([
    { sources: [{ url: source.url, enabled: false }] },
    { sources: [{ url: 'https://other.test/marketplace.json', enabled: true }] },
    { hiddenCatalogEntries: [{ sourceUrl: source.url, pluginId: 'channel' }] },
    { futureSetting: true },
  ])('preserves a real management intent change: %j', change => {
    expect(fingerprint({ ...materialized, ...change })).not.toBe(fingerprint())
  })
})
