export const FEEDBACK_MANIFEST_CONTRACT = 'cordisx.feedback-manifest/v1' as const
export const FEEDBACK_POLICY_VERSION = 'level-0/v1' as const

export type FeedbackArtifactStatus = 'present' | 'truncated'
export type FeedbackEvidenceType = 'product_log' | 'structured_event' | 'environment_projection' | 'user_report'

export interface FeedbackArtifact {
  readonly path: string
  readonly purpose: string
  readonly evidenceType: FeedbackEvidenceType
  readonly status: FeedbackArtifactStatus
  readonly bytes: number
  readonly sha256: string
  readonly redactions: number
  readonly omittedBytes?: number
}

export interface FeedbackMissing {
  readonly field: string
  readonly status: 'missing' | 'unsupported' | 'permission_denied' | 'not_applicable' | 'truncated'
  readonly reason: string
}

export interface FeedbackManifest {
  readonly contract: typeof FEEDBACK_MANIFEST_CONTRACT
  readonly schemaVersion: 1
  readonly bundleId: string
  readonly createdAt: string
  readonly producer: {
    readonly cordisxVersion: string
    readonly nodeVersion: string
    readonly platform: 'darwin' | 'linux' | 'win32' | 'other'
    readonly osVersion: string
    readonly arch: string
    readonly hostVersion: null
    readonly hostBuild: null
  }
  readonly policy: {
    readonly version: typeof FEEDBACK_POLICY_VERSION
    readonly localOnly: true
    readonly contentCollection: 'excluded'
  }
  readonly target: {
    readonly app: { readonly kind: 'codex' | 'other'; readonly ref?: string }
    readonly profile: { readonly kind: 'default' | 'named'; readonly ref: string }
    readonly dataMode: 'shared' | 'host-isolated'
  }
  readonly selection: {
    readonly launchId: string | null
    readonly from: string
    readonly until: string
    readonly correlationConfidence: 'exact' | 'partial' | 'none'
    readonly disposition:
      | 'ready'
      | 'ready_then_cleanup_degraded'
      | 'injection_failed'
      | 'launch_failed'
      | 'terminated'
      | 'unknown'
    readonly cdpPort: null
  }
  readonly limits: {
    readonly lookbackSeconds: number
    readonly maxBytes: number
    readonly maxEvents: number
    readonly collectionTimeoutMs: number
  }
  readonly artifacts: readonly FeedbackArtifact[]
  readonly exclusions: readonly { readonly category: string; readonly reason: string }[]
  readonly missing: readonly FeedbackMissing[]
  readonly redactions: { readonly total: number; readonly byCategory: Readonly<Record<string, number>> }
  readonly warnings: readonly { readonly code: string; readonly message: string }[]
  readonly archive?: {
    readonly format: 'zip'
    readonly bytes: number
    readonly sha256: string
    readonly verified: true
  }
}

export interface FeedbackResult {
  readonly status: 'collected' | 'inspected' | 'exported'
  readonly bundlePath: string
  readonly manifestPath: string
  readonly bundleId: string
  readonly summary: {
    readonly launches: number
    readonly includedArtifacts: number
    readonly excludedCategories: number
    readonly missingSources: number
    readonly redactions: number
    readonly bytes: number
  }
  readonly archivePath?: string
}
