import type { Context, Disposable } from '@deepseek-ai/cordis'

import type { CordisXJsonValue } from './contracts.js'

export const CORDISX_OWNER_DOCUMENT_SERVICE_V1 = 'cordisx.owner-documents/v1' as const

export interface CordisXOwnerDocumentSnapshotV1 {
  readonly contract: typeof CORDISX_OWNER_DOCUMENT_SERVICE_V1
  readonly revision: number
  /** Consumer-owned document schema. The Host stores it without interpreting the value. */
  readonly schemaVersion: number
  readonly value: CordisXJsonValue
}

export type CordisXOwnerDocumentUnavailableCodeV1 =
  | 'bridge-unavailable'
  | 'stale-generation'
  | 'corrupt-store'
  | 'unsupported-store-schema'
  | 'quota-exceeded'
  | 'invalid-request'
  | 'host-unavailable'

export type CordisXOwnerDocumentLoadResultV1 =
  | { readonly status: 'loaded'; readonly snapshot: CordisXOwnerDocumentSnapshotV1 }
  | { readonly status: 'missing'; readonly revision: 0 }
  | {
    readonly status: 'unavailable'
    readonly code: CordisXOwnerDocumentUnavailableCodeV1
    /** Bounded Host diagnostic. Stored document values are never included. */
    readonly diagnostic: string
    /** The Host retained the original store for recovery and did not overwrite it. */
    readonly recoverable: boolean
  }

export interface CordisXOwnerDocumentReplaceCommandV1 {
  readonly contract: typeof CORDISX_OWNER_DOCUMENT_SERVICE_V1
  readonly documentId: string
  readonly expectedRevision: number
  readonly schemaVersion: number
  readonly value: CordisXJsonValue
}

export type CordisXOwnerDocumentReplaceResultV1 =
  | { readonly status: 'accepted'; readonly snapshot: CordisXOwnerDocumentSnapshotV1 }
  | { readonly status: 'conflict'; readonly actualRevision: number }
  | Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }>

/**
 * One Host-bound, profile- and plugin-owner-scoped durable document service.
 *
 * The Host derives the owner from its issued plugin principal. Callers cannot
 * choose another profile, source, plugin id, or runtime generation.
 */
export interface CordisXOwnerDocumentsV1 {
  load(documentId: string): Promise<CordisXOwnerDocumentLoadResultV1>
  replace(command: CordisXOwnerDocumentReplaceCommandV1): Promise<CordisXOwnerDocumentReplaceResultV1>
  /** Explicit CAS transaction alias. It has the exact same atomic semantics as replace. */
  transaction(command: CordisXOwnerDocumentReplaceCommandV1): Promise<CordisXOwnerDocumentReplaceResultV1>
  /** Emits full load-result replacements. The owning client fences generation and disposal. */
  subscribe(documentId: string, listener: (result: CordisXOwnerDocumentLoadResultV1) => void): Disposable<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Versioned Host-owned durable JSON documents scoped to the current plugin owner. */
    readonly documents: CordisXOwnerDocumentsV1
  }
}

export type OwnerDocumentContext = Context
