import { describe, expect, it } from 'vitest'
import { parseMarketplaceFeed } from '../packages/cli/src/renderer/marketplace.js'

const PLUGIN_SCHEMA_V7 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v7.schema.json'
const FEED_SCHEMA_V7 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v7.schema.json'

describe('marketplace v7 internal trust', () => {
  it('accepts authority-bound v2 trust records', () => {
    const source = 'https://code.byted.org/fe/cordisx-plugins'
    const root = 'https://lf0-fast-deliver-inner.bytedance.net/obj/eden-internal/cordisx-marketplace/marketplace.json'
    const evidence = 'https://code.byted.org/fe/cordisx-marketplace/merge_requests/2'
    const integrity = `sha256:${'c'.repeat(64)}`
    const identity = { pluginId: 'aiden', canonicalSource: source }
    const value = {
      $schema: FEED_SCHEMA_V7,
      schemaVersion: 7,
      generatedAt: '2026-09-17T08:00:00Z',
      trust: {
        authority: 'byted.cordisx-marketplace.codeowners/v1',
        root,
        grantModel: 'protected-merge-chain-v1',
        cryptographicAttestation: 'unsupported',
      },
      fallbackLocale: 'en',
      name: 'CordisX Internal Marketplace',
      description: 'Approved internal plugins.',
      homepage: 'https://code.byted.org/fe/cordisx-marketplace',
      plugins: [{
        $schema: PLUGIN_SCHEMA_V7,
        schemaVersion: 7,
        id: 'aiden',
        fallbackLocale: 'en',
        name: 'Aiden',
        description: 'Internal provider integration.',
        version: '0.1.1',
        source,
        artifact: {
          publisherIdentity: 'npm:@byted',
          packageNamespace: '@byted',
          packageName: '@byted/cordisx-plugin-aiden',
          downloadUrl: 'https://bnpm.byted.org/@byted/cordisx-plugin-aiden/-/cordisx-plugin-aiden-0.1.1.tgz',
          integrity,
        },
        license: 'UNLICENSED',
        compatibility: { cordisx: '0.1.0-beta.5' },
        authors: [{ name: 'CordisX Plugin Team' }],
      }],
      official: [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v2.schema.json',
        schemaVersion: 2,
        designation: 'cordisx-official',
        identity: {
          ...identity,
          publisherIdentity: 'npm:@byted',
          packageNamespace: '@byted',
          packageName: '@byted/cordisx-plugin-aiden',
        },
        verificationPolicy: { id: 'cordisx-official-publisher', version: '1.0.0' },
        verifiedAt: '2026-09-16T12:00:00Z',
        reviewer: { authority: 'byted.cordisx-marketplace.codeowners/v1', evidenceRef: evidence },
        status: 'active',
        label: { key: 'official.label', fallback: 'Official' },
        description: { key: 'official.description', fallback: 'Maintained by the internal CordisX team.' },
      }],
      certifications: [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v2.schema.json',
        schemaVersion: 2,
        level: 'cordisx-certified',
        identity: {
          ...identity,
          packageName: '@byted/cordisx-plugin-aiden',
          version: '0.1.1',
          downloadUrl: 'https://bnpm.byted.org/@byted/cordisx-plugin-aiden/-/cordisx-plugin-aiden-0.1.1.tgz',
          integrity,
          sourceEvidence: {
            repository: source,
            sourceCommit: '7a7885204c874ff2dddf4288fa98402450f7ff64',
            mergeRequest: 'https://code.byted.org/fe/cordisx-plugins/merge_requests/4',
            mergeCommit: '033b595570f40f9a370f313e86f546bd84637f5d',
          },
        },
        eligibilityCeiling: {
          capability: 'ui.extension-points.render',
          scope: { extensionPoints: ['manager.settings.navigation-items', 'manager.content'] },
        },
        reviewPolicy: { id: 'cordisx-marketplace-review', version: '1.0.0' },
        reviewedAt: '2026-09-16T12:00:00Z',
        expiresAt: '2027-09-16T12:00:00Z',
        reviewer: { authority: 'byted.cordisx-marketplace.codeowners/v1', evidenceRef: evidence },
        status: 'active',
        label: { key: 'certified.label', fallback: 'Certified' },
        description: { key: 'certified.description', fallback: 'Reviewed through protected ownership.' },
      }],
    }

    const parsed = parseMarketplaceFeed(value, { feedUrl: root, trustedRoots: [root], now: '2026-09-17T09:00:00Z' })
    expect(parsed).toMatchObject({ schemaVersion: 7, plugins: [{ schemaVersion: 7, id: 'aiden' }] })
    expect(parsed.trust?.byPluginIdentity.get(`${source}\u0000aiden`)).toMatchObject({
      official: { designation: 'cordisx-official' },
      certification: { level: 'cordisx-certified' },
      certifiedPermission: {
        schemaVersion: 2,
        canonicalSource: source,
        pluginId: 'aiden',
        packageName: '@byted/cordisx-plugin-aiden',
        version: '0.1.1',
        downloadUrl: 'https://bnpm.byted.org/@byted/cordisx-plugin-aiden/-/cordisx-plugin-aiden-0.1.1.tgz',
        integrity,
        eligibilityCeiling: {
          capability: 'ui.extension-points.render',
          scope: { extensionPoints: ['manager.settings.navigation-items', 'manager.content'] },
        },
      },
    })
  })
})
