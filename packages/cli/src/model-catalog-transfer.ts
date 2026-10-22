/** Host-private clipboard transfer; this is not a plugin contract. */
export const CATALOG_TRANSFER_MAX_TEXT = 48_000
export const CATALOG_TRANSFER_MAX_JSON = 256_000
export const CATALOG_TRANSFER_MAX_REQUEST_BYTES = 65_536
export const CATALOG_TRANSFER_MAX_CONNECTIONS = 24
export const CATALOG_TRANSFER_MAX_MODELS_PER_CONNECTION = 10_000

export interface CatalogTransferSelection {
  readonly bindingRef: string
  readonly modelIds: readonly string[]
}

export interface CatalogTransferExportRequest {
  readonly selections: readonly CatalogTransferSelection[]
  readonly variables?: readonly {
    readonly sourceName: string
    readonly name: string
    readonly value?: string
    readonly description?: string
    readonly generator?: CatalogEnvironmentGenerator
  }[]
  readonly includeValues?: boolean
}

export interface CatalogTransferEnvironmentVariable {
  readonly name: string
  readonly value: string
  readonly enabled: boolean
  readonly description?: string
  readonly generator?: CatalogEnvironmentGenerator
}

export interface CatalogEnvironmentGenerator {
  readonly kind: 'shell'
  readonly script: string
}

export interface CatalogTransferVariablePreparation extends CatalogTransferEnvironmentVariable {
  readonly sourceName: string
  readonly bindings: readonly string[]
  readonly available: boolean
}

export type CatalogTransferExportPreparationResult =
  | { readonly status: 'ok'; readonly variables: readonly CatalogTransferVariablePreparation[] }
  | { readonly status: 'rejected'; readonly code: 'invalid' | 'unavailable' | 'too-large' }

export interface CatalogTransferImportRequest {
  readonly text: string
  readonly variables: readonly {
    readonly sourceName: string
    readonly name: string
    readonly value: string
    readonly enabled: boolean
    readonly description?: string
    readonly generator?: CatalogEnvironmentGenerator
  }[]
}

export interface CatalogEnvironmentGeneratorRunRequest {
  readonly runId: string
  readonly script: string
}

export type CatalogEnvironmentGeneratorRunResult =
  | { readonly status: 'ok'; readonly runId: string; readonly value: string }
  | {
    readonly status: 'rejected'
    readonly runId: string
    readonly code: 'invalid' | 'unavailable' | 'busy' | 'failed' | 'timeout' | 'cancelled' | 'too-large' | 'empty'
  }

export type CatalogEnvironmentGeneratorCancelResult =
  | { readonly status: 'cancelled'; readonly runId: string }
  | { readonly status: 'idle'; readonly runId: string }
  | { readonly status: 'rejected'; readonly runId: string; readonly code: 'invalid' | 'unavailable' }

export type CatalogTransferImportPreparationResult =
  | {
    readonly status: 'ok'
    readonly variables: readonly CatalogTransferVariablePreparation[]
    readonly connections: readonly { readonly transferId: string; readonly title: string }[]
  }
  | { readonly status: 'rejected'; readonly code: 'invalid' | 'unavailable' | 'too-large' }

export type CatalogEnvironmentReadResult =
  | {
    readonly status: 'ok'
    readonly entries: readonly CatalogTransferEnvironmentVariable[]
    readonly applies: 'app-restart'
  }
  | { readonly status: 'rejected'; readonly code: 'unavailable' }

export type CatalogEnvironmentSaveResult =
  | { readonly status: 'applied'; readonly applies: 'app-restart' }
  | { readonly status: 'rejected'; readonly code: 'invalid' | 'unavailable' | 'persist-failed' }

export type CatalogTransferExportResult =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'rejected'; readonly code: 'invalid' | 'unavailable' | 'too-large' }

export type CatalogTransferImportResult =
  | {
    readonly status: 'applied'
    readonly imported: number
    readonly skipped: number
    readonly bindingRefs: readonly string[]
  }
  | { readonly status: 'rejected'; readonly code: 'invalid' | 'unavailable' | 'too-large' | 'persist-failed' }
