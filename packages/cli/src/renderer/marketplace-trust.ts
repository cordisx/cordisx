const TRUST_AUTHORITY = 'cordisx.marketplace.codeowners/v1'
const TRUST_GRANT_MODEL = 'protected-merge-chain-v1'
const OFFICIAL_DESIGNATION = 'cordisx-official'
const CERTIFICATION_LEVEL = 'cordisx-certified'
const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
const REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}(?::[a-z0-9][a-z0-9._-]{0,95})?$/
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const OFFICIAL_SOURCE_PATTERN = /^https:\/\/github\.com\/cordisx\/[A-Za-z0-9_.-]+$/
const EVIDENCE_PATTERN = /^https:\/\/github\.com\/cordisx\/marketplace\/(?:pull\/[1-9][0-9]*|commit\/[a-f0-9]{40})$/

export interface MarketplaceLocalizedText {
  readonly namespace?: string
  readonly key: string
  readonly params?: Readonly<Record<string, string | number | boolean | null>>
  readonly fallback: string
}

export interface MarketplaceArtifactIdentity {
  readonly publisherIdentity: string
  readonly packageNamespace: string
  readonly packageName: string
  readonly integrity: string
}

export interface MarketplaceTrustPlugin {
  readonly identity: string
  readonly id: string
  readonly version: string
  readonly source: string
  readonly artifact?: MarketplaceArtifactIdentity
}

export interface MarketplaceOfficialRecord {
  readonly designation: 'cordisx-official'
  readonly identity: {
    readonly pluginId: string
    readonly canonicalSource: string
    readonly publisherIdentity: 'npm:@cordisx'
    readonly packageNamespace: '@cordisx'
    readonly packageName: string
  }
  readonly verificationPolicy: { readonly id: 'cordisx-official-publisher'; readonly version: string }
  readonly verifiedAt: string
  readonly reviewer: { readonly authority: typeof TRUST_AUTHORITY; readonly evidenceRef: string }
  readonly status: 'active' | 'revoked'
  readonly revokedAt?: string
  readonly label: MarketplaceLocalizedText
  readonly description: MarketplaceLocalizedText
}

export interface MarketplaceCertificationRecord {
  readonly level: 'cordisx-certified'
  readonly identity: {
    readonly pluginId: string
    readonly version: string
    readonly canonicalSource: string
    readonly integrity: string
  }
  readonly reviewPolicy: { readonly id: 'cordisx-marketplace-review'; readonly version: string }
  readonly reviewedAt: string
  readonly expiresAt: string
  readonly reviewer: { readonly authority: typeof TRUST_AUTHORITY; readonly evidenceRef: string }
  readonly status: 'active' | 'revoked' | 'expired'
  readonly revokedAt?: string
  readonly label: MarketplaceLocalizedText
  readonly description: MarketplaceLocalizedText
}

export interface MarketplacePluginTrust {
  readonly official?: MarketplaceOfficialRecord
  readonly certification?: MarketplaceCertificationRecord
}

export interface MarketplaceTrustEvaluation {
  readonly trusted: boolean
  readonly authority: typeof TRUST_AUTHORITY
  readonly generatedAt: string
  readonly byPluginIdentity: ReadonlyMap<string, MarketplacePluginTrust>
}

export interface MarketplaceTrustOptions {
  readonly feedUrl: string
  readonly trustedRoots: readonly string[]
  readonly now?: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON object`)
  return value as Record<string, unknown>
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key))
  if (unexpected.length > 0) throw new Error(`${label} 包含不支持的字段: ${unexpected.join(', ')}`)
  const missing = required.filter(key => value[key] === undefined)
  if (missing.length > 0) throw new Error(`${label} 缺少字段: ${missing.join(', ')}`)
}

function string(value: unknown, label: string, pattern?: RegExp, maxLength = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`${label} 不是有效字符串`)
  }
  return value
}

function literal<Value extends string>(value: unknown, expected: Value, label: string): Value {
  if (value !== expected) throw new Error(`${label} 必须为 ${expected}`)
  return expected
}

function instant(value: unknown, label: string): { readonly value: string; readonly epoch: number } {
  const text = string(value, label, undefined, 64)
  const epoch = Date.parse(text)
  if (!Number.isFinite(epoch)) throw new Error(`${label} 必须是有效 date-time`)
  return { value: text, epoch }
}

function canonicalHttpsUrl(value: unknown, label: string): string {
  const text = string(value, label)
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} 必须是无凭据、query、fragment 的 HTTPS URL`)
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.href !== text) throw new Error(`${label} 必须使用 canonical URL`)
  return text
}

function localizedText(value: unknown, label: string): MarketplaceLocalizedText {
  const entry = object(value, label)
  assertKeys(entry, ['namespace', 'key', 'params', 'fallback'], ['key', 'fallback'], label)
  const namespace = entry.namespace === undefined
    ? undefined
    : string(entry.namespace, `${label}.namespace`, REFERENCE_PATTERN, 193)
  const paramsValue = entry.params === undefined ? undefined : object(entry.params, `${label}.params`)
  if (paramsValue !== undefined && Object.keys(paramsValue).length > 32) throw new Error(`${label}.params 不能超过 32 项`)
  const params: Record<string, string | number | boolean | null> = {}
  for (const [key, param] of Object.entries(paramsValue ?? {})) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key) || (param !== null && !['string', 'number', 'boolean'].includes(typeof param))) {
      throw new Error(`${label}.params.${key} 不是有效 scalar 参数`)
    }
    params[key] = param as string | number | boolean | null
  }
  return {
    ...(namespace === undefined ? {} : { namespace }),
    key: string(entry.key, `${label}.key`, LOCAL_ID_PATTERN, 96),
    ...(paramsValue === undefined ? {} : { params }),
    fallback: string(entry.fallback, `${label}.fallback`, undefined, 4000),
  }
}

function reviewer(value: unknown, label: string): { readonly authority: typeof TRUST_AUTHORITY; readonly evidenceRef: string } {
  const entry = object(value, label)
  assertKeys(entry, ['authority', 'evidenceRef'], ['authority', 'evidenceRef'], label)
  return {
    authority: literal(entry.authority, TRUST_AUTHORITY, `${label}.authority`),
    evidenceRef: string(entry.evidenceRef, `${label}.evidenceRef`, EVIDENCE_PATTERN),
  }
}

function officialRecord(value: unknown, index: number, generatedAt: number): MarketplaceOfficialRecord {
  const label = `official[${index}]`
  const entry = object(value, label)
  assertKeys(entry, [
    '$schema', 'schemaVersion', 'designation', 'identity', 'verificationPolicy', 'verifiedAt', 'reviewer', 'status',
    'revokedAt', 'label', 'description',
  ], [
    '$schema', 'schemaVersion', 'designation', 'identity', 'verificationPolicy', 'verifiedAt', 'reviewer', 'status',
    'label', 'description',
  ], label)
  literal(entry.$schema, 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-official.v1.schema.json', `${label}.$schema`)
  if (entry.schemaVersion !== 1) throw new Error(`${label}.schemaVersion 必须为 1`)
  const identityValue = object(entry.identity, `${label}.identity`)
  assertKeys(identityValue, ['pluginId', 'canonicalSource', 'publisherIdentity', 'packageNamespace', 'packageName'], [
    'pluginId', 'canonicalSource', 'publisherIdentity', 'packageNamespace', 'packageName',
  ], `${label}.identity`)
  const canonicalSource = canonicalHttpsUrl(identityValue.canonicalSource, `${label}.identity.canonicalSource`)
  if (!OFFICIAL_SOURCE_PATTERN.test(canonicalSource)) throw new Error(`${label}.identity.canonicalSource 不是 CordisX official source`)
  const policy = object(entry.verificationPolicy, `${label}.verificationPolicy`)
  assertKeys(policy, ['id', 'version'], ['id', 'version'], `${label}.verificationPolicy`)
  const verifiedAt = instant(entry.verifiedAt, `${label}.verifiedAt`)
  if (verifiedAt.epoch > generatedAt) throw new Error(`${label}.verifiedAt 晚于 feed generatedAt`)
  const status = entry.status === 'active' || entry.status === 'revoked' ? entry.status : undefined
  if (status === undefined) throw new Error(`${label}.status 不受支持`)
  const revokedAt = entry.revokedAt === undefined ? undefined : instant(entry.revokedAt, `${label}.revokedAt`)
  if (status === 'active' && revokedAt !== undefined) throw new Error(`${label} active 时不能包含 revokedAt`)
  if (status === 'revoked' && (revokedAt === undefined || revokedAt.epoch < verifiedAt.epoch || revokedAt.epoch > generatedAt)) {
    throw new Error(`${label} revokedAt 缺失或超出有效区间`)
  }
  return {
    designation: literal(entry.designation, OFFICIAL_DESIGNATION, `${label}.designation`),
    identity: {
      pluginId: string(identityValue.pluginId, `${label}.identity.pluginId`, LOCAL_ID_PATTERN, 96),
      canonicalSource,
      publisherIdentity: literal(identityValue.publisherIdentity, 'npm:@cordisx', `${label}.identity.publisherIdentity`),
      packageNamespace: literal(identityValue.packageNamespace, '@cordisx', `${label}.identity.packageNamespace`),
      packageName: string(identityValue.packageName, `${label}.identity.packageName`, /^@cordisx\/[a-z0-9][a-z0-9._-]*$/, 214),
    },
    verificationPolicy: {
      id: literal(policy.id, 'cordisx-official-publisher', `${label}.verificationPolicy.id`),
      version: string(policy.version, `${label}.verificationPolicy.version`, SEMVER_PATTERN, 160),
    },
    verifiedAt: verifiedAt.value,
    reviewer: reviewer(entry.reviewer, `${label}.reviewer`),
    status,
    ...(revokedAt === undefined ? {} : { revokedAt: revokedAt.value }),
    label: localizedText(entry.label, `${label}.label`),
    description: localizedText(entry.description, `${label}.description`),
  }
}

function certificationRecord(value: unknown, index: number, evaluatedAt: number, generatedAt: number): MarketplaceCertificationRecord {
  const label = `certifications[${index}]`
  const entry = object(value, label)
  assertKeys(entry, [
    '$schema', 'schemaVersion', 'level', 'identity', 'reviewPolicy', 'reviewedAt', 'expiresAt', 'reviewer', 'status',
    'revokedAt', 'label', 'description',
  ], [
    '$schema', 'schemaVersion', 'level', 'identity', 'reviewPolicy', 'reviewedAt', 'expiresAt', 'reviewer', 'status',
    'label', 'description',
  ], label)
  literal(entry.$schema, 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-certification.v1.schema.json', `${label}.$schema`)
  if (entry.schemaVersion !== 1) throw new Error(`${label}.schemaVersion 必须为 1`)
  const identityValue = object(entry.identity, `${label}.identity`)
  assertKeys(identityValue, ['pluginId', 'version', 'canonicalSource', 'integrity'], [
    'pluginId', 'version', 'canonicalSource', 'integrity',
  ], `${label}.identity`)
  const policy = object(entry.reviewPolicy, `${label}.reviewPolicy`)
  assertKeys(policy, ['id', 'version'], ['id', 'version'], `${label}.reviewPolicy`)
  const reviewedAt = instant(entry.reviewedAt, `${label}.reviewedAt`)
  const expiresAt = instant(entry.expiresAt, `${label}.expiresAt`)
  if (reviewedAt.epoch > generatedAt) throw new Error(`${label}.reviewedAt 晚于 feed generatedAt`)
  if (expiresAt.epoch <= reviewedAt.epoch) throw new Error(`${label}.expiresAt 必须晚于 reviewedAt`)
  const status = entry.status === 'active' || entry.status === 'revoked' || entry.status === 'expired' ? entry.status : undefined
  if (status === undefined) throw new Error(`${label}.status 不受支持`)
  const revokedAt = entry.revokedAt === undefined ? undefined : instant(entry.revokedAt, `${label}.revokedAt`)
  if (status === 'active' && (revokedAt !== undefined || expiresAt.epoch <= evaluatedAt)) {
    throw new Error(`${label} 已撤销或过期，不能保持 active`)
  }
  if (status === 'expired' && (revokedAt !== undefined || expiresAt.epoch > evaluatedAt)) {
    throw new Error(`${label} status=expired 与时效不匹配`)
  }
  if (status === 'revoked' && (revokedAt === undefined || revokedAt.epoch < reviewedAt.epoch || revokedAt.epoch > evaluatedAt)) {
    throw new Error(`${label} revokedAt 缺失或超出有效区间`)
  }
  return {
    level: literal(entry.level, CERTIFICATION_LEVEL, `${label}.level`),
    identity: {
      pluginId: string(identityValue.pluginId, `${label}.identity.pluginId`, LOCAL_ID_PATTERN, 96),
      version: string(identityValue.version, `${label}.identity.version`, SEMVER_PATTERN, 160),
      canonicalSource: canonicalHttpsUrl(identityValue.canonicalSource, `${label}.identity.canonicalSource`),
      integrity: string(identityValue.integrity, `${label}.identity.integrity`, DIGEST_PATTERN, 71),
    },
    reviewPolicy: {
      id: literal(policy.id, 'cordisx-marketplace-review', `${label}.reviewPolicy.id`),
      version: string(policy.version, `${label}.reviewPolicy.version`, SEMVER_PATTERN, 160),
    },
    reviewedAt: reviewedAt.value,
    expiresAt: expiresAt.value,
    reviewer: reviewer(entry.reviewer, `${label}.reviewer`),
    status,
    ...(revokedAt === undefined ? {} : { revokedAt: revokedAt.value }),
    label: localizedText(entry.label, `${label}.label`),
    description: localizedText(entry.description, `${label}.description`),
  }
}

function officialIdentity(record: MarketplaceOfficialRecord): string {
  return [
    record.identity.canonicalSource,
    record.identity.pluginId,
    record.identity.publisherIdentity,
    record.identity.packageNamespace,
    record.identity.packageName,
  ].join('\u0000')
}

function certificationIdentity(record: MarketplaceCertificationRecord): string {
  return [
    record.identity.canonicalSource,
    record.identity.pluginId,
    record.identity.version,
    record.identity.integrity,
  ].join('\u0000')
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Validate every trust record, then project active records only for an explicitly configured root. */
export function evaluateMarketplaceTrust(
  feedValue: unknown,
  plugins: readonly MarketplaceTrustPlugin[],
  options: MarketplaceTrustOptions,
): MarketplaceTrustEvaluation {
  const feed = object(feedValue, 'feed')
  const generatedAt = instant(feed.generatedAt, 'feed.generatedAt')
  const now = options.now === undefined ? Date.now() : instant(options.now, 'options.now').epoch
  const evaluatedAt = Math.max(generatedAt.epoch, now)
  const trust = object(feed.trust, 'feed.trust')
  assertKeys(trust, ['authority', 'root', 'grantModel', 'cryptographicAttestation'], [
    'authority', 'root', 'grantModel', 'cryptographicAttestation',
  ], 'feed.trust')
  const authority = literal(trust.authority, TRUST_AUTHORITY, 'feed.trust.authority')
  const root = canonicalHttpsUrl(trust.root, 'feed.trust.root')
  literal(trust.grantModel, TRUST_GRANT_MODEL, 'feed.trust.grantModel')
  literal(trust.cryptographicAttestation, 'unsupported', 'feed.trust.cryptographicAttestation')
  const normalizedFeedUrl = canonicalHttpsUrl(options.feedUrl, 'options.feedUrl')
  const normalizedTrustedRoots = options.trustedRoots.map((value, index) => canonicalHttpsUrl(value, `options.trustedRoots[${index}]`))
  const isConfiguredFeed = normalizedTrustedRoots.includes(normalizedFeedUrl)
  if (isConfiguredFeed && root !== normalizedFeedUrl) throw new Error('configured Marketplace trust feed 的 trust.root 与 feed URL 不匹配')
  const trusted = isConfiguredFeed && root === normalizedFeedUrl

  if (!Array.isArray(feed.official)) throw new Error('feed.official 必须是数组')
  if (!Array.isArray(feed.certifications)) throw new Error('feed.certifications 必须是数组')
  const official = feed.official.map((record, index) => officialRecord(record, index, generatedAt.epoch))
  const certifications = feed.certifications.map((record, index) => certificationRecord(record, index, evaluatedAt, generatedAt.epoch))
  const officialKeys = official.map(officialIdentity)
  const certificationKeys = certifications.map(certificationIdentity)
  if (new Set(officialKeys).size !== officialKeys.length) throw new Error('feed.official 包含重复 identity')
  if (new Set(certificationKeys).size !== certificationKeys.length) throw new Error('feed.certifications 包含重复 exact artifact identity')
  if (officialKeys.some((key, index) => index > 0 && compareText(officialKeys[index - 1] ?? '', key) > 0)) {
    throw new Error('feed.official 未按 identity 确定性排序')
  }
  if (certificationKeys.some((key, index) => index > 0 && compareText(certificationKeys[index - 1] ?? '', key) > 0)) {
    throw new Error('feed.certifications 未按 exact artifact identity 确定性排序')
  }

  const pluginByIdentity = new Map(plugins.map(plugin => [plugin.identity, plugin]))
  const projected = new Map<string, MarketplacePluginTrust>()
  for (const record of official) {
    const identity = `${record.identity.canonicalSource}\u0000${record.identity.pluginId}`
    const plugin = pluginByIdentity.get(identity)
    if (plugin?.artifact === undefined
      || plugin.id !== record.identity.pluginId
      || plugin.source !== record.identity.canonicalSource
      || plugin.artifact.publisherIdentity !== record.identity.publisherIdentity
      || plugin.artifact.packageNamespace !== record.identity.packageNamespace
      || plugin.artifact.packageName !== record.identity.packageName) {
      throw new Error(`official identity 与当前插件发布链不匹配: ${record.identity.pluginId}`)
    }
    if (trusted && record.status === 'active') projected.set(identity, { ...projected.get(identity), official: record })
  }
  for (const record of certifications) {
    const identity = `${record.identity.canonicalSource}\u0000${record.identity.pluginId}`
    const plugin = pluginByIdentity.get(identity)
    if (plugin?.artifact === undefined
      || plugin.id !== record.identity.pluginId
      || plugin.version !== record.identity.version
      || plugin.source !== record.identity.canonicalSource
      || plugin.artifact.integrity !== record.identity.integrity) {
      throw new Error(`certification 与当前 exact artifact 不匹配: ${record.identity.pluginId}@${record.identity.version}`)
    }
    if (trusted && record.status === 'active') projected.set(identity, { ...projected.get(identity), certification: record })
  }
  return { trusted, authority, generatedAt: generatedAt.value, byPluginIdentity: projected }
}
