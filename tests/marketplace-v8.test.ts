import { describe, expect, it } from 'vitest'
import { parseMarketplaceFeed } from '../packages/cli/src/renderer/marketplace.js'

const ROOT = 'https://catalog.example/marketplace.json'
const PLUGIN_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v8.schema.json'
const FEED_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v8.schema.json'

function plugin(packageName: string, publisherIdentity?: string) {
  return {
    $schema: PLUGIN_SCHEMA,
    schemaVersion: 8,
    id: packageName.startsWith('@') ? 'scoped-plugin' : 'plugin-composer-animal',
    fallbackLocale: 'en',
    name: 'Marketplace plugin',
    description: 'A Marketplace v8 package.',
    version: '0.1.2',
    source: packageName.startsWith('@')
      ? 'https://github.com/example/scoped-plugin'
      : 'https://github.com/cordisx/plugin-pet',
    artifact: {
      ...(publisherIdentity === undefined ? {} : { publisherIdentity }),
      packageName,
      downloadUrl: 'https://github.com/example/releases/download/v0.1.2/plugin.tgz',
      integrity: `sha256:${'a'.repeat(64)}`,
    },
    license: 'MIT',
    compatibility: { cordisx: '^0.1.0' },
    authors: [{ name: 'Example' }],
  }
}

function feed(plugins: readonly unknown[]) {
  return {
    $schema: FEED_SCHEMA,
    schemaVersion: 8,
    generatedAt: '2026-09-20T00:00:00Z',
    trust: {
      authority: 'cordisx.marketplace.codeowners/v1',
      root: ROOT,
      grantModel: 'protected-merge-chain-v1',
      cryptographicAttestation: 'unsupported',
    },
    fallbackLocale: 'en',
    name: 'Marketplace v8',
    description: 'Scoped and unscoped packages.',
    homepage: 'https://catalog.example/',
    plugins,
    official: [],
    certifications: [],
  }
}

describe('Marketplace v8 feed parsing', () => {
  it('accepts scoped and unscoped npm names without coupling publisher metadata to package scope', () => {
    const scoped = plugin('@unrelated/plugin', 'npm:another-author')
    const unscoped = plugin('plugin-composer-animal')
    const parsed = parseMarketplaceFeed(feed([unscoped, scoped]), {
      feedUrl: ROOT,
      trustedRoots: [ROOT],
      now: '2026-09-20T00:01:00Z',
    })

    expect(parsed.plugins.map(item => item.artifact)).toEqual([
      expect.objectContaining({ packageName: 'plugin-composer-animal' }),
      expect.objectContaining({ packageName: '@unrelated/plugin', publisherIdentity: 'npm:another-author' }),
    ])
    expect(parsed.plugins[0]?.artifact).not.toHaveProperty('publisherIdentity')
    expect(parsed.plugins[0]?.artifact).not.toHaveProperty('packageNamespace')
    expect(parsed.trust?.byPluginIdentity.size).toBe(0)
  })

  it('rejects mixed feed/plugin versions and v8 packageNamespace', () => {
    const mixed = {
      ...plugin('@example/legacy', 'npm:@example'),
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v7.schema.json',
      schemaVersion: 7,
      artifact: {
        publisherIdentity: 'npm:@example',
        packageNamespace: '@example',
        packageName: '@example/legacy',
        downloadUrl: 'https://github.com/example/releases/download/v0.1.2/plugin.tgz',
        integrity: `sha256:${'a'.repeat(64)}`,
      },
    }
    expect(() => parseMarketplaceFeed(feed([mixed]))).toThrow(
      'feed 与 plugin schemaVersion 必须一致',
    )
    expect(() =>
      parseMarketplaceFeed(feed([{
        ...mixed,
        artifact: { ...mixed.artifact, packageNamespace: '@cordisx' },
      }]))
    ).toThrow('packageNamespace')
  })

  it('keeps v7 scoped-only validation unchanged', () => {
    const legacy = {
      ...plugin('plugin-composer-animal', 'npm:example-author'),
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v7.schema.json',
      schemaVersion: 7,
    }
    expect(() =>
      parseMarketplaceFeed({
        ...feed([legacy]),
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v7.schema.json',
        schemaVersion: 7,
      })
    ).toThrow('packageNamespace')
  })
})
