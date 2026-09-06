import { type MarketplaceRankingExplanation } from './marketplace-ranking.js'
import { type MarketplaceSourceRecord } from './marketplace-source.js'
import {
  type MarketplaceCertificationRecord,
  type MarketplaceCertifiedPermissionProjectionV1,
  type MarketplaceOfficialRecord,
  type MarketplaceTrustEvaluation,
} from './marketplace-trust.js'

export interface MarketplaceAuthor {
  readonly name: string
  readonly url?: string
}

export interface MarketplacePluginLocalization {
  readonly name?: string
  readonly description?: string
  readonly authors?: readonly string[]
  readonly keywords?: readonly string[]
}

export interface MarketplaceFeedLocalization {
  readonly name?: string
}

export interface MarketplaceArtifact {
  readonly publisherIdentity: string
  readonly packageNamespace: string
  readonly packageName: string
  readonly downloadUrl: string
  readonly integrity: string
}
export interface MarketplaceCommerceDescriptor {
  readonly purchaseUrl: string
  readonly manageUrl?: string
  readonly recoveryUrl?: string
  readonly environment: 'sandbox' | 'live'
}

export interface MarketplacePlugin {
  readonly schemaVersion: 1 | 2 | 3 | 4
  readonly id: string
  /** Locale of the required base display metadata; v1 projects as legacy `en`. */
  readonly fallbackLocale: string
  readonly name: string
  readonly description: string
  readonly localizations: Readonly<Record<string, MarketplacePluginLocalization>>
  readonly version: string
  readonly source: string
  readonly homepage?: string
  readonly icon?: string
  readonly manifest?: string
  readonly artifact?: MarketplaceArtifact
  readonly commerce?: MarketplaceCommerceDescriptor
  readonly license: string
  readonly compatibility: { readonly cordisx: string }
  readonly authors: readonly MarketplaceAuthor[]
  readonly keywords: readonly string[]
}

export interface MarketplaceCatalogPlugin extends MarketplacePlugin {
  readonly identity: string
  readonly feedUrl: string
  readonly feedName: string
  readonly feedFallbackLocale: string
  readonly feedLocalizations: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly feedHomepage: string
  readonly official?: MarketplaceOfficialRecord
  readonly certification?: MarketplaceCertificationRecord
  readonly certifiedPermission?: MarketplaceCertifiedPermissionProjectionV1
}

export interface MarketplacePluginProjection {
  readonly name: string
  readonly description: string
  readonly authors: readonly MarketplaceAuthor[]
  readonly keywords: readonly string[]
  readonly feedName: string
  /** Current projection, fallback/English metadata, and canonical machine terms. */
  readonly searchValues: readonly string[]
}

export interface MarketplaceCatalogEligibility {
  readonly compatible?: boolean
  readonly visible?: boolean
  readonly policyBlocked?: boolean
}

export interface MarketplaceCatalogSearchOptions {
  readonly query: string
  readonly currentLocale: string
  readonly certifiedOnly?: boolean
  readonly officialOnly?: boolean
  readonly eligibility?: (plugin: MarketplaceCatalogPlugin) => MarketplaceCatalogEligibility
}

export interface MarketplaceCatalogSearchResult {
  readonly plugin: MarketplaceCatalogPlugin
  readonly projection: MarketplacePluginProjection
  readonly ranking: MarketplaceRankingExplanation
}

export interface MarketplaceSourceSnapshot {
  readonly url: string
  readonly status: 'loading' | 'loaded' | 'failed'
  readonly phase: 'disabled' | 'idle' | 'revalidating' | 'fresh' | 'stale' | 'error'
  readonly enabled: boolean
  readonly official: boolean
  readonly stale: boolean
  readonly revalidating: boolean
  readonly attempts: number
  readonly local?: MarketplaceSourceRecord['local']
  readonly name?: string
  readonly fallbackLocale?: string
  readonly localizations?: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly homepage?: string
  readonly pluginCount?: number
  readonly trusted?: boolean
  readonly lastSuccessAt?: string
  readonly error?: string
}

export interface MarketplaceSourceProjection {
  readonly name: string
  readonly description?: string
  readonly note?: string
  readonly searchValues: readonly string[]
}

export interface MarketplaceDuplicate {
  readonly identity: string
  readonly winnerFeedUrl: string
  readonly duplicateFeedUrl: string
}

export interface MarketplaceSnapshot {
  readonly sources: readonly string[]
  readonly sourceRecords: readonly MarketplaceSourceRecord[]
  readonly sourceStates: readonly MarketplaceSourceSnapshot[]
  readonly plugins: readonly MarketplaceCatalogPlugin[]
  readonly duplicates: readonly MarketplaceDuplicate[]
  readonly loading: boolean
  readonly revalidating: boolean
}

export interface MarketplaceModel {
  snapshot(): MarketplaceSnapshot
  setSources(sources: readonly string[]): Promise<void>
  setSourceRecords(sources: readonly MarketplaceSourceRecord[]): Promise<void>
  upsertSource(source: MarketplaceSourceRecord): Promise<void>
  removeSource(url: string): Promise<void>
  setSourceEnabled(url: string, enabled: boolean): Promise<void>
  moveSource(url: string, targetIndex: number): Promise<void>
  importSource(value: string): Promise<MarketplaceSourceRecord>
  reload(): Promise<void>
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface MarketplaceResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type MarketplaceFetcher = (url: string, init: RequestInit) => Promise<MarketplaceResponse>

export interface ParsedFeed {
  readonly schemaVersion: 1 | 2 | 3 | 4
  readonly fallbackLocale: string
  readonly name: string
  readonly localizations: Readonly<Record<string, MarketplaceFeedLocalization>>
  readonly homepage: string
  readonly plugins: readonly MarketplacePlugin[]
  readonly trust?: MarketplaceTrustEvaluation
}

export interface MarketplaceFeedParseOptions {
  readonly feedUrl: string
  readonly trustedRoots: readonly string[]
  readonly now?: string
}

export interface LoadResult {
  readonly state: MarketplaceSourceSnapshot
  readonly feed?: ParsedFeed
}

export interface MarketplaceModelOptions {
  readonly now?: () => number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly retryDelays?: readonly number[]
  readonly staleAfterMs?: number
}
