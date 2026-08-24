import { describe, expect, it } from 'vitest'
import {
  evaluateMarketplaceTrust,
  type MarketplaceTrustPlugin,
} from '../packages/cli/src/renderer/marketplace-trust.js'

const ROOT = 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'
const SOURCE = 'https://github.com/cordisx/example'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`
const EVIDENCE = `https://github.com/cordisx/marketplace/commit/${'c'.repeat(40)}`

function plugin(overrides: Partial<MarketplaceTrustPlugin> = {}): MarketplaceTrustPlugin {
  return {
    identity: `${SOURCE}\u0000example`,
    id: 'example',
    version: '1.2.3',
    source: SOURCE,
    artifact: {
      publisherIdentity: 'npm:@cordisx',
      packageNamespace: '@cordisx',
      packageName: '@cordisx/example',
      integrity: DIGEST,
    },
    ...overrides,
  }
}

function official(status: 'active' | 'revoked' = 'active'): Record<string, unknown> {
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v1.schema.json',
    schemaVersion: 1,
    designation: 'cordisx-official',
    identity: {
      pluginId: 'example',
      canonicalSource: SOURCE,
      publisherIdentity: 'npm:@cordisx',
      packageNamespace: '@cordisx',
      packageName: '@cordisx/example',
    },
    verificationPolicy: { id: 'cordisx-official-publisher', version: '1.0.0' },
    verifiedAt: '2026-08-20T00:00:00Z',
    reviewer: { authority: 'cordisx.marketplace.codeowners/v1', evidenceRef: EVIDENCE },
    status,
    ...(status === 'revoked' ? { revokedAt: '2026-08-23T00:00:00Z' } : {}),
    label: { key: 'official.label', fallback: 'Official' },
    description: { key: 'official.description', fallback: 'Created and maintained by CordisX.' },
  }
}

function certification(
  status: 'active' | 'revoked' | 'expired' = 'active',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v1.schema.json',
    schemaVersion: 1,
    level: 'cordisx-certified',
    identity: { pluginId: 'example', version: '1.2.3', canonicalSource: SOURCE, integrity: DIGEST },
    reviewPolicy: { id: 'cordisx-marketplace-review', version: '1.0.0' },
    reviewedAt: '2026-08-20T00:00:00Z',
    expiresAt: '2027-08-20T00:00:00Z',
    reviewer: { authority: 'cordisx.marketplace.codeowners/v1', evidenceRef: EVIDENCE },
    status,
    ...(status === 'revoked' ? { revokedAt: '2026-08-23T00:00:00Z' } : {}),
    label: { key: 'certified.label', fallback: 'CordisX Certified' },
    description: { key: 'certified.description', fallback: 'Reviewed under policy 1.0.0.' },
    ...overrides,
  }
}

function feed(officialRecords: unknown[], certificationRecords: unknown[], trustRoot = ROOT): Record<string, unknown> {
  return {
    generatedAt: '2026-08-24T00:00:00Z',
    trust: {
      authority: 'cordisx.marketplace.codeowners/v1',
      root: trustRoot,
      grantModel: 'protected-merge-chain-v1',
      cryptographicAttestation: 'unsupported',
    },
    official: officialRecords,
    certifications: certificationRecords,
  }
}

const OPTIONS = { feedUrl: ROOT, trustedRoots: [ROOT], now: '2026-08-24T01:00:00Z' } as const

describe('marketplace trust evaluator', () => {
  it('projects Official and Certified independently from the configured trust root', () => {
    const both = evaluateMarketplaceTrust(feed([official()], [certification()]), [plugin()], OPTIONS)
    const officialOnly = evaluateMarketplaceTrust(feed([official()], []), [plugin()], OPTIONS)
    const thirdPartyCertified = evaluateMarketplaceTrust(
      feed([], [certification()]),
      [plugin({ artifact: { ...plugin().artifact!, publisherIdentity: 'npm:@third-party', packageNamespace: '@third-party', packageName: '@third-party/example' } })],
      OPTIONS,
    )

    expect(both.byPluginIdentity.get(`${SOURCE}\u0000example`)).toEqual(expect.objectContaining({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
      certification: expect.objectContaining({ level: 'cordisx-certified' }),
    }))
    expect(officialOnly.byPluginIdentity.get(`${SOURCE}\u0000example`)).toEqual({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
    })
    expect(thirdPartyCertified.byPluginIdentity.get(`${SOURCE}\u0000example`)).toEqual({
      certification: expect.objectContaining({ level: 'cordisx-certified' }),
    })
  })

  it('validates but does not project records from an unconfigured root', () => {
    const otherRoot = 'https://catalog.example/marketplace.json'
    const result = evaluateMarketplaceTrust(feed([official()], [certification()], otherRoot), [plugin()], {
      feedUrl: otherRoot,
      trustedRoots: [ROOT],
      now: OPTIONS.now,
    })

    expect(result.trusted).toBe(false)
    expect(result.byPluginIdentity.size).toBe(0)
  })

  it('lets Official continue across versions but never lets certification inherit to a new version or digest', () => {
    const nextVersion = plugin({ version: '1.2.4' })
    expect(evaluateMarketplaceTrust(feed([official()], []), [nextVersion], OPTIONS).byPluginIdentity.size).toBe(1)
    expect(() => evaluateMarketplaceTrust(feed([], [certification()]), [nextVersion], OPTIONS)).toThrow('exact artifact 不匹配')
    expect(() => evaluateMarketplaceTrust(feed([], [certification()]), [plugin({
      artifact: { ...plugin().artifact!, integrity: OTHER_DIGEST },
    })], OPTIONS)).toThrow('exact artifact 不匹配')
  })

  it('rejects unknown authority, official publisher mismatch, missing digest, and expired active records', () => {
    const unknownAuthority = feed([], [])
    ;(unknownAuthority.trust as Record<string, unknown>).authority = 'plugin.submitter/v1'
    expect(() => evaluateMarketplaceTrust(unknownAuthority, [plugin()], OPTIONS)).toThrow('feed.trust.authority')

    const mismatchedOfficial = official()
    ;(mismatchedOfficial.identity as Record<string, unknown>).packageName = '@cordisx/not-example'
    expect(() => evaluateMarketplaceTrust(feed([mismatchedOfficial], []), [plugin()], OPTIONS)).toThrow('发布链不匹配')

    const missingDigest = certification()
    delete (missingDigest.identity as Record<string, unknown>).integrity
    expect(() => evaluateMarketplaceTrust(feed([], [missingDigest]), [plugin()], OPTIONS)).toThrow('缺少字段: integrity')

    expect(() => evaluateMarketplaceTrust(feed([], [certification('active', {
      expiresAt: '2026-08-24T00:30:00Z',
    })]), [plugin()], OPTIONS)).toThrow('不能保持 active')
  })

  it('applies revocation on the next feed evaluation without changing the other dimension', () => {
    const before = evaluateMarketplaceTrust(feed([official()], [certification()]), [plugin()], OPTIONS)
    const after = evaluateMarketplaceTrust(feed([official()], [certification('revoked')]), [plugin()], OPTIONS)

    expect(before.byPluginIdentity.get(`${SOURCE}\u0000example`)?.certification).toBeDefined()
    expect(after.byPluginIdentity.get(`${SOURCE}\u0000example`)?.official).toBeDefined()
    expect(after.byPluginIdentity.get(`${SOURCE}\u0000example`)?.certification).toBeUndefined()
  })
})
