import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  evaluateMarketplaceTrust,
  type MarketplaceTrustPlugin,
} from '../packages/cli/src/renderer/marketplace-trust.js'
import { normalizeCertifiedPermissionProjectionV1 } from '../packages/cli/src/permission-model-v4.js'

const ROOT = 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json'
const SOURCE = 'https://github.com/cordisx/example'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`
const EVIDENCE = `https://github.com/cordisx/marketplace/commit/${'c'.repeat(40)}`
const INTERNAL_ROOT =
  'https://lf0-fast-deliver-inner.bytedance.net/obj/eden-internal/cordisx-marketplace/marketplace.json'
const INTERNAL_SOURCE = 'https://code.byted.org/fe/cordisx-plugins'
const INTERNAL_EVIDENCE = 'https://code.byted.org/fe/cordisx-marketplace/merge_requests/2'
const INTERNAL_DOWNLOAD = 'https://bnpm.byted.org/@byted/cordisx-plugin-aiden/-/cordisx-plugin-aiden-0.1.1.tgz'
const INTERNAL_SOURCE_EVIDENCE = {
  repository: INTERNAL_SOURCE,
  sourceCommit: '7a7885204c874ff2dddf4288fa98402450f7ff64',
  mergeRequest: 'https://code.byted.org/fe/cordisx-plugins/merge_requests/4',
  mergeCommit: '033b595570f40f9a370f313e86f546bd84637f5d',
}
const INTERNAL_ELIGIBILITY_CEILING = {
  capability: 'ui.extension-points.render',
  scope: { extensionPoints: ['manager.settings.navigation-items', 'manager.content'] },
}
const require = createRequire(import.meta.url)
const protocolRoot = path.resolve(path.dirname(require.resolve('@cordisx/protocol/connector-service/v1')), '..')

async function certifiedProjectionValidator() {
  const schemas = await Promise.all([
    'ui-common.v1.schema.json',
    'plugin-lifecycle-common.v1.schema.json',
    'marketplace-certified-permission-projection.v1.schema.json',
  ].map(async name => JSON.parse(await readFile(path.join(protocolRoot, 'schemas', name), 'utf8')) as object))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  for (const schema of schemas) ajv.addSchema(schema)
  return ajv.getSchema(
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certified-permission-projection.v1.schema.json',
  )!
}

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
      downloadUrl: 'https://registry.npmjs.org/@cordisx/example/-/example-1.2.3.tgz',
      integrity: DIGEST,
    },
    ...overrides,
  }
}

function official(status: 'active' | 'revoked' = 'active'): Record<string, unknown> {
  return {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v1.schema.json',
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
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v1.schema.json',
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

function feed(
  officialRecords: unknown[],
  certificationRecords: unknown[],
  trustRoot = ROOT,
  generatedAt = '2026-08-24T00:00:00Z',
): Record<string, unknown> {
  return {
    generatedAt,
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

function internalPlugin(overrides: Partial<MarketplaceTrustPlugin> = {}): MarketplaceTrustPlugin {
  return plugin({
    identity: `${INTERNAL_SOURCE}\u0000aiden`,
    id: 'aiden',
    version: '0.1.1',
    source: INTERNAL_SOURCE,
    artifact: {
      publisherIdentity: 'npm:@byted',
      packageNamespace: '@byted',
      packageName: '@byted/cordisx-plugin-aiden',
      downloadUrl: INTERNAL_DOWNLOAD,
      integrity: DIGEST,
    },
    ...overrides,
  })
}

function internalOfficial(): Record<string, unknown> {
  return {
    ...official(),
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v2.schema.json',
    schemaVersion: 2,
    identity: {
      pluginId: 'aiden',
      canonicalSource: INTERNAL_SOURCE,
      publisherIdentity: 'npm:@byted',
      packageNamespace: '@byted',
      packageName: '@byted/cordisx-plugin-aiden',
    },
    reviewer: { authority: 'byted.cordisx-marketplace.codeowners/v1', evidenceRef: INTERNAL_EVIDENCE },
  }
}

function internalCertification(): Record<string, unknown> {
  return {
    ...certification(),
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v2.schema.json',
    schemaVersion: 2,
    identity: {
      pluginId: 'aiden',
      canonicalSource: INTERNAL_SOURCE,
      packageName: '@byted/cordisx-plugin-aiden',
      version: '0.1.1',
      downloadUrl: INTERNAL_DOWNLOAD,
      integrity: DIGEST,
      sourceEvidence: INTERNAL_SOURCE_EVIDENCE,
    },
    eligibilityCeiling: INTERNAL_ELIGIBILITY_CEILING,
    reviewer: { authority: 'byted.cordisx-marketplace.codeowners/v1', evidenceRef: INTERNAL_EVIDENCE },
  }
}

function internalFeed(
  officialRecords: unknown[] = [internalOfficial()],
  certificationRecords: unknown[] = [internalCertification()],
): Record<string, unknown> {
  return {
    schemaVersion: 7,
    generatedAt: '2026-09-17T08:00:00Z',
    trust: {
      authority: 'byted.cordisx-marketplace.codeowners/v1',
      root: INTERNAL_ROOT,
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
    const ordinary = evaluateMarketplaceTrust(feed([], []), [plugin()], OPTIONS)
    const thirdPartyCertified = evaluateMarketplaceTrust(
      feed([], [certification()]),
      [plugin({
        artifact: {
          ...plugin().artifact!,
          publisherIdentity: 'npm:@third-party',
          packageNamespace: '@third-party',
          packageName: '@third-party/example',
        },
      })],
      OPTIONS,
    )

    expect(both.byPluginIdentity.get(`${SOURCE}\u0000example`)).toEqual(expect.objectContaining({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
      certification: expect.objectContaining({ level: 'cordisx-certified' }),
    }))
    expect(officialOnly.byPluginIdentity.get(`${SOURCE}\u0000example`)).toEqual({
      official: expect.objectContaining({ designation: 'cordisx-official' }),
    })
    expect(ordinary.byPluginIdentity.get(`${SOURCE}\u0000example`)).toBeUndefined()
    expect(thirdPartyCertified.byPluginIdentity.get(`${SOURCE}\u0000example`)).toEqual({
      certification: expect.objectContaining({ level: 'cordisx-certified' }),
      certifiedPermission: expect.objectContaining({ kind: 'cordisx-certified-permission-eligibility' }),
    })
  })

  it('requires exact asserted publisher identity for v8 Official matching', () => {
    const v8 = plugin({
      schemaVersion: 8,
      artifact: {
        publisherIdentity: 'npm:@cordisx',
        packageName: '@cordisx/example',
        downloadUrl: plugin().artifact!.downloadUrl,
        integrity: DIGEST,
      },
    })
    expect(evaluateMarketplaceTrust(feed([official()], []), [v8], OPTIONS).byPluginIdentity.get(v8.identity)?.official)
      .toBeDefined()

    for (const publisherIdentity of [undefined, 'npm:another-author']) {
      expect(() =>
        evaluateMarketplaceTrust(feed([official()], []), [{
          ...v8,
          artifact: { ...v8.artifact!, publisherIdentity },
        }], OPTIONS)
      ).toThrow('发布链不匹配')
    }
  })

  it('keeps an ordinary unscoped v8 artifact admitted without promoting trust', () => {
    const ordinary = plugin({
      schemaVersion: 8,
      source: 'https://github.com/independent/pet',
      id: 'plugin-composer-animal',
      identity: 'https://github.com/independent/pet\u0000plugin-composer-animal',
      artifact: {
        packageName: 'plugin-composer-animal',
        downloadUrl: 'https://github.com/independent/pet/releases/download/v0.1.2/plugin-composer-animal-0.1.2.tgz',
        integrity: DIGEST,
      },
    })
    const result = evaluateMarketplaceTrust(feed([], []), [ordinary], OPTIONS)
    expect(result.byPluginIdentity.get(ordinary.identity)).toBeUndefined()
  })

  it('keeps v8 certification independent from package scope and publisher identity', () => {
    const unscoped = plugin({
      schemaVersion: 8,
      artifact: {
        packageName: 'independent-example',
        downloadUrl: plugin().artifact!.downloadUrl,
        integrity: DIGEST,
      },
    })
    const trust = evaluateMarketplaceTrust(feed([], [certification()]), [unscoped], OPTIONS)
      .byPluginIdentity.get(unscoped.identity)

    expect(trust?.official).toBeUndefined()
    expect(trust?.certification).toEqual(expect.objectContaining({ level: 'cordisx-certified' }))
    expect(trust?.certifiedPermission).toEqual(expect.objectContaining({
      kind: 'cordisx-certified-permission-eligibility',
    }))
  })

  it('projects a formally valid exact immutable permission eligibility input without Official or grant policy', async () => {
    const result = evaluateMarketplaceTrust(feed([official()], [certification()]), [plugin()], OPTIONS)
    const projection = result.byPluginIdentity.get(`${SOURCE}\u0000example`)?.certifiedPermission
    const payload = {
      source: SOURCE,
      pluginId: 'example',
      version: '1.2.3',
      integrity: DIGEST,
      reviewPolicy: { id: 'cordisx-marketplace-review', version: '1.0.0' },
      reviewedAt: '2026-08-20T00:00:00Z',
      expiresAt: '2027-08-20T00:00:00Z',
      evidence: { kind: 'protected-marketplace-review', reference: EVIDENCE },
      feed: { generatedAt: '2026-08-24T00:00:00Z', root: ROOT, authority: 'cordisx.marketplace.codeowners/v1' },
    }

    expect(projection).toEqual({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certified-permission-projection.v1.schema.json',
      schemaVersion: 1,
      kind: 'cordisx-certified-permission-eligibility',
      status: 'active',
      ...payload,
      fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
      revision: '2026-08-24T00:00:00Z',
    })
    expect(projection).not.toHaveProperty('official')
    expect(projection).not.toHaveProperty('capabilities')
    expect(projection).not.toHaveProperty('grant')
    expect(Object.isFrozen(projection)).toBe(true)
    const validate = await certifiedProjectionValidator()
    expect(validate(projection), JSON.stringify(validate.errors)).toBe(true)
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
    expect(() => evaluateMarketplaceTrust(feed([], [certification()]), [nextVersion], OPTIONS)).toThrow(
      'exact artifact 不匹配',
    )
    expect(() =>
      evaluateMarketplaceTrust(feed([], [certification()]), [plugin({
        artifact: { ...plugin().artifact!, integrity: OTHER_DIGEST },
      })], OPTIONS)
    ).toThrow('exact artifact 不匹配')
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
    expect(() => evaluateMarketplaceTrust(feed([], [missingDigest]), [plugin()], OPTIONS)).toThrow(
      '缺少字段: integrity',
    )

    expect(() =>
      evaluateMarketplaceTrust(
        feed([], [certification('active', {
          expiresAt: '2026-08-24T00:30:00Z',
        })]),
        [plugin()],
        OPTIONS,
      )
    ).toThrow('不能保持 active')
  })

  it('applies revocation on the next feed evaluation without changing the other dimension', () => {
    const before = evaluateMarketplaceTrust(feed([official()], [certification()]), [plugin()], OPTIONS)
    const after = evaluateMarketplaceTrust(feed([official()], [certification('revoked')]), [plugin()], OPTIONS)

    expect(before.byPluginIdentity.get(`${SOURCE}\u0000example`)?.certification).toBeDefined()
    expect(after.byPluginIdentity.get(`${SOURCE}\u0000example`)?.official).toBeDefined()
    expect(after.byPluginIdentity.get(`${SOURCE}\u0000example`)?.certification).toBeUndefined()
    expect(after.byPluginIdentity.get(`${SOURCE}\u0000example`)?.certifiedPermission).toBeUndefined()
  })

  it('changes projection revision and fingerprint on a later feed replacement', () => {
    const before = evaluateMarketplaceTrust(feed([], [certification()]), [plugin()], OPTIONS)
      .byPluginIdentity.get(`${SOURCE}\u0000example`)?.certifiedPermission
    const after = evaluateMarketplaceTrust(
      feed([], [certification()], ROOT, '2026-08-24T00:30:00Z'),
      [plugin()],
      { ...OPTIONS, now: '2026-08-24T01:00:00Z' },
    ).byPluginIdentity.get(`${SOURCE}\u0000example`)?.certifiedPermission

    expect(after?.revision).toBe('2026-08-24T00:30:00Z')
    expect(after?.fingerprint).not.toBe(before?.fingerprint)
  })

  it('projects and normalizes exact internal v2 certification without granting through Official', () => {
    const options = { feedUrl: INTERNAL_ROOT, trustedRoots: [INTERNAL_ROOT], now: '2026-09-17T09:00:00Z' } as const
    const result = evaluateMarketplaceTrust(internalFeed(), [internalPlugin()], options)
    const trust = result.byPluginIdentity.get(`${INTERNAL_SOURCE}\u0000aiden`)
    const projection = trust?.certifiedPermission

    expect(trust?.official).toEqual(expect.objectContaining({ designation: 'cordisx-official' }))
    expect(trust?.official).not.toHaveProperty('permissions')
    expect(projection).toMatchObject({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certified-permission-projection.v2.schema.json',
      schemaVersion: 2,
      canonicalSource: INTERNAL_SOURCE,
      pluginId: 'aiden',
      packageName: '@byted/cordisx-plugin-aiden',
      version: '0.1.1',
      downloadUrl: INTERNAL_DOWNLOAD,
      integrity: DIGEST,
      sourceEvidence: INTERNAL_SOURCE_EVIDENCE,
      eligibilityCeiling: INTERNAL_ELIGIBILITY_CEILING,
      evidence: { reference: INTERNAL_EVIDENCE },
      feed: { authority: 'byted.cordisx-marketplace.codeowners/v1', root: INTERNAL_ROOT },
    })
    expect(projection).not.toHaveProperty('permissions')
    expect(projection).not.toHaveProperty('official')
    const { $schema: _schema, schemaVersion: _version, kind: _kind, status: _status, fingerprint, ...payload } =
      projection!
    expect(fingerprint).toBe(`sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`)
    expect(normalizeCertifiedPermissionProjectionV1(
      projection,
      { source: INTERNAL_SOURCE, pluginId: 'aiden' },
      { version: '0.1.1', integrity: DIGEST },
      new Date('2026-09-17T09:00:00Z'),
    )).toEqual(projection)
  })

  it('accepts the canonical Protocol v2 vector and its revision-bound fingerprint', () => {
    const canonical = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certified-permission-projection.v2.schema.json',
      schemaVersion: 2,
      kind: 'cordisx-certified-permission-eligibility',
      status: 'active',
      canonicalSource: INTERNAL_SOURCE,
      pluginId: 'aiden',
      packageName: '@byted/cordisx-plugin-aiden',
      version: '0.1.2',
      downloadUrl: 'https://bnpm.byted.org/@byted/cordisx-plugin-aiden/-/cordisx-plugin-aiden-0.1.2.tgz',
      integrity: 'sha256:d330c9289d09ecb99ba4a9d38fcd7b2c3671af6cd6f883b51ca713509f35fccf',
      sourceEvidence: INTERNAL_SOURCE_EVIDENCE,
      reviewPolicy: { id: 'cordisx-marketplace-review', version: '1.0.0' },
      reviewedAt: '2026-09-18T07:06:37.000Z',
      expiresAt: '2027-09-18T07:06:37.000Z',
      evidence: {
        kind: 'protected-marketplace-review',
        reference: 'https://code.byted.org/fe/cordisx-marketplace/merge_requests/5',
      },
      eligibilityCeiling: INTERNAL_ELIGIBILITY_CEILING,
      feed: {
        generatedAt: '2026-09-18T08:00:00.000Z',
        root: INTERNAL_ROOT,
        authority: 'byted.cordisx-marketplace.codeowners/v1',
      },
      revision: '2026-09-18T08:00:00.000Z',
      fingerprint: 'sha256:70d7b8930625e32a2d6e0a4f04e3759f198a261c322a4f02391ba9613123be65',
    }
    expect(normalizeCertifiedPermissionProjectionV1(
      canonical,
      { source: INTERNAL_SOURCE, pluginId: 'aiden' },
      { version: '0.1.2', integrity: canonical.integrity },
      new Date('2026-09-18T09:00:00.000Z'),
    )).toEqual(canonical)
  })

  it('rejects internal/public authority-version pairing and exact identity changes', () => {
    const options = { feedUrl: INTERNAL_ROOT, trustedRoots: [INTERNAL_ROOT], now: '2026-09-17T09:00:00Z' } as const
    const publicOfficial = official()
    expect(() => evaluateMarketplaceTrust(internalFeed([publicOfficial], []), [internalPlugin()], options)).toThrow(
      'official[0].$schema',
    )

    const oldFeed = internalFeed([], [])
    oldFeed.schemaVersion = 6
    expect(() => evaluateMarketplaceTrust(oldFeed, [internalPlugin()], options)).toThrow('仅支持 feed schemaVersion 7')

    const badPackage = internalOfficial()
    ;(badPackage.identity as Record<string, unknown>).packageName = '@byted/aiden'
    expect(() => evaluateMarketplaceTrust(internalFeed([badPackage], []), [internalPlugin()], options)).toThrow(
      'packageName',
    )

    const permissionBearingOfficial = internalOfficial()
    permissionBearingOfficial.permissions = ['models.read']
    expect(() => evaluateMarketplaceTrust(internalFeed([permissionBearingOfficial], []), [internalPlugin()], options))
      .toThrow('不支持的字段: permissions')

    const badEvidence = internalCertification()
    ;(badEvidence.reviewer as Record<string, unknown>).evidenceRef = 'https://code.byted.org/fe/other/merge_requests/2'
    expect(() => evaluateMarketplaceTrust(internalFeed([], [badEvidence]), [internalPlugin()], options)).toThrow(
      'evidenceRef',
    )

    expect(() =>
      evaluateMarketplaceTrust(
        internalFeed([], [internalCertification()]),
        [internalPlugin({ version: '0.1.2' })],
        options,
      )
    ).toThrow('exact artifact 不匹配')
    expect(() =>
      evaluateMarketplaceTrust(internalFeed([], [internalCertification()]), [internalPlugin({
        artifact: { ...internalPlugin().artifact!, integrity: OTHER_DIGEST },
      })], options)
    ).toThrow('exact artifact 不匹配')
  })

  it('rejects internal v2 projections with altered fingerprint, authority, source, version, or digest', () => {
    const options = { feedUrl: INTERNAL_ROOT, trustedRoots: [INTERNAL_ROOT], now: '2026-09-17T09:00:00Z' } as const
    const projection = evaluateMarketplaceTrust(
      internalFeed([], [internalCertification()]),
      [internalPlugin()],
      options,
    )
      .byPluginIdentity.get(`${INTERNAL_SOURCE}\u0000aiden`)?.certifiedPermission
    expect(projection).toBeDefined()
    const normalize = (value: unknown) =>
      normalizeCertifiedPermissionProjectionV1(
        value,
        { source: INTERNAL_SOURCE, pluginId: 'aiden' },
        { version: '0.1.1', integrity: DIGEST },
        new Date('2026-09-17T09:00:00Z'),
      )
    expect(normalize({ ...projection!, fingerprint: `sha256:${'0'.repeat(64)}` })).toBeUndefined()
    expect(normalize({ ...projection!, feed: { ...projection!.feed, authority: 'cordisx.marketplace.codeowners/v1' } }))
      .toBeUndefined()
    expect(normalize({ ...projection!, canonicalSource: 'https://github.com/cordisx/aiden' })).toBeUndefined()
    expect(normalize({ ...projection!, source: INTERNAL_SOURCE })).toBeUndefined()
    expect(normalize({
      ...projection!,
      eligibility: {
        capability: 'ui.extension-points.render',
        extensionPoints: INTERNAL_ELIGIBILITY_CEILING.scope.extensionPoints,
      },
    })).toBeUndefined()
    expect(normalize({
      ...projection!,
      eligibilityCeiling: {
        ...projection!.eligibilityCeiling,
        scope: { extensionPoints: [...projection!.eligibilityCeiling.scope.extensionPoints].reverse() },
      },
    })).toBeUndefined()
    expect(normalize({ ...projection!, version: '0.1.2' })).toBeUndefined()
    expect(normalize({ ...projection!, integrity: OTHER_DIGEST })).toBeUndefined()
    const { fingerprint: _fingerprint, revision: _revision, ...withoutRevision } = projection!
    expect(normalize({
      ...projection!,
      fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(withoutRevision)).digest('hex')}`,
    })).toBeUndefined()
  })

  it.each([
    ['plugin id', (payload: Record<string, any>) => ({ ...payload, pluginId: 'Bad ID' })],
    ['version length', (payload: Record<string, any>) => ({ ...payload, version: `1.2.3+${'a'.repeat(65)}` })],
    ['review policy version', (payload: Record<string, any>) => ({
      ...payload,
      reviewPolicy: { ...payload.reviewPolicy, version: '1.0' },
    })],
    ['reviewedAt date-time', (payload: Record<string, any>) => ({ ...payload, reviewedAt: '2026-09-16' })],
    ['expiresAt date-time', (payload: Record<string, any>) => ({ ...payload, expiresAt: '2027-09-16' })],
    ['generatedAt date-time', (payload: Record<string, any>) => ({
      ...payload,
      feed: { ...payload.feed, generatedAt: '2026-09-17' },
    })],
    ['feed root URI', (payload: Record<string, any>) => ({
      ...payload,
      feed: { ...payload.feed, root: 'https://bad host/path' },
    })],
    ['feed root query', (payload: Record<string, any>) => ({
      ...payload,
      feed: { ...payload.feed, root: 'https://marketplace.example/feed.json?channel=stable' },
    })],
    ['evidence URI', (payload: Record<string, any>) => ({
      ...payload,
      evidence: {
        ...payload.evidence,
        reference: `https://code.byted.org/fe/cordisx-marketplace/commit/${'g'.repeat(40)}`,
      },
    })],
  ])('rejects a re-fingerprinted v2 projection with invalid %s', (_field, mutate) => {
    const options = { feedUrl: INTERNAL_ROOT, trustedRoots: [INTERNAL_ROOT], now: '2026-09-17T09:00:00Z' } as const
    const projection = evaluateMarketplaceTrust(
      internalFeed([], [internalCertification()]),
      [internalPlugin()],
      options,
    ).byPluginIdentity.get(`${INTERNAL_SOURCE}\u0000aiden`)!.certifiedPermission!
    const { $schema, schemaVersion, kind, status, fingerprint: _fingerprint, ...payload } = projection
    const invalidPayload = mutate(structuredClone(payload))
    const invalid = {
      $schema,
      schemaVersion,
      kind,
      status,
      ...invalidPayload,
      fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(invalidPayload)).digest('hex')}`,
    }
    expect(normalizeCertifiedPermissionProjectionV1(
      invalid,
      { source: invalid.canonicalSource, pluginId: invalid.pluginId },
      { version: invalid.version, integrity: invalid.integrity },
      new Date('2026-09-17T09:00:00Z'),
    )).toBeUndefined()
  })

  it('applies the common strict projection formats to public v1', () => {
    const projection = evaluateMarketplaceTrust(feed([], [certification()]), [plugin()], OPTIONS)
      .byPluginIdentity.get(`${SOURCE}\u0000example`)!.certifiedPermission!
    const { fingerprint: _fingerprint, ...invalid } = { ...projection, reviewedAt: '2026-08-20' }
    const payload = {
      source: invalid.source,
      pluginId: invalid.pluginId,
      version: invalid.version,
      integrity: invalid.integrity,
      reviewPolicy: invalid.reviewPolicy,
      reviewedAt: invalid.reviewedAt,
      expiresAt: invalid.expiresAt,
      evidence: invalid.evidence,
      feed: invalid.feed,
    }
    expect(normalizeCertifiedPermissionProjectionV1(
      { ...invalid, fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}` },
      { source: SOURCE, pluginId: 'example' },
      { version: '1.2.3', integrity: DIGEST },
      new Date('2026-08-24T01:00:00Z'),
    )).toBeUndefined()
  })
})
