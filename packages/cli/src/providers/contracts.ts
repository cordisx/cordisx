import type {
  CordisXModelDescriptor,
  CordisXPlatformDiagnostic,
  CordisXPlatformModelRef,
  CordisXPlatformResult,
  CordisXPlatformSessionRef,
  CordisXSessionProjection,
  CordisXSessionSummary,
  CordisXTaskControlInput,
  CordisXTaskControlOutcome,
  CordisXTasksListInput,
  CordisXTurnControlInput,
  CordisXTurnControlOutcome,
  CordisXTurnStart,
} from '../contracts.js'

/** Launcher-owned definition. Credential values are read only by the provider process boundary. */
export interface CliProxyProviderConfig {
  readonly id: string
  readonly kind: 'cli-proxy-api'
  readonly displayName: string
  readonly baseUrl: string
  /** Opaque Host-owned credential reference. The value never crosses into renderer configuration. */
  readonly credentialRef?: string
  /** Legacy environment-name import retained only until a plugin-owned service config is saved. */
  readonly apiKeyEnv?: string
  readonly codexExecutable: string
  readonly codexHome: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly modelMappings?: readonly {
    readonly sourceModelId: string
    readonly modelId: string
    readonly displayName?: string
    readonly enabled: boolean
    readonly isDefault: boolean
  }[]
}

/** Explicit opt-in provider backed by the user's locally authenticated Codex CLI. */
export interface LocalCodexProviderConfig {
  readonly id: string
  readonly kind: 'local-codex'
  readonly displayName: string
  /** App-server provider id. This remains private to the Node adapter. */
  readonly sourceProviderId: string
  readonly codexExecutable: string
  readonly codexHome: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly modelMappings?: CliProxyProviderConfig['modelMappings']
}

export type CodexProviderConfig = CliProxyProviderConfig | LocalCodexProviderConfig

export type ProviderConnectionState = 'idle' | 'starting' | 'ready' | 'draining' | 'unavailable' | 'closed'

export interface ProviderConnectionStatus {
  readonly providerId: string
  readonly displayName: string
  readonly generation: string
  readonly state: ProviderConnectionState
  readonly diagnostic?: CordisXPlatformDiagnostic
  readonly external: boolean
  readonly nativeCurrentConnection: false
  readonly rawBridgeExposed: false
}

/** Adapter-local operations. A complete provider ref is checked before any remote id is used. */
export interface ProviderConnection {
  readonly providerId: string
  readonly generation: string
  status(): ProviderConnectionStatus
  listModels(): Promise<CordisXPlatformResult<readonly CordisXModelDescriptor[]>>
  listSessions(input: Omit<CordisXTasksListInput, 'providerIds'>): Promise<CordisXPlatformResult<{
    readonly sessions: readonly CordisXSessionSummary[]
    readonly nextCursor?: string
  }>>
  readSession(ref: CordisXPlatformSessionRef): Promise<CordisXPlatformResult<CordisXSessionProjection>>
  createSession(input: {
    readonly model: CordisXPlatformModelRef
    readonly cwd: string
    /** Host-private AgentLoop projection; never accepted by ctx.platform. */
    readonly developerInstructions?: string
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh'
  }): Promise<CordisXPlatformResult<CordisXSessionSummary>>
  controlSession(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>>
  submitTurn(input: { readonly session: CordisXPlatformSessionRef; readonly message: string }): Promise<CordisXPlatformResult<CordisXTurnStart>>
  controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>>
  /** Node-only normalized signal source; raw App Server frames never cross this seam. */
  subscribeLifecycle?(listener: (event: ProviderLifecycleSignal) => void): () => void
  close(): Promise<void>
}

export interface ProviderLifecycleSignal {
  readonly session: CordisXPlatformSessionRef
  readonly turnId: string
  readonly type: 'turn.started' | 'turn.completed' | 'turn.failed' | 'approval.required' | 'approval.resolved'
  readonly output?: readonly { readonly type: 'text'; readonly text: string }[]
  readonly failure?: { readonly code: string; readonly retryable: boolean }
  readonly approval?: { readonly approvalId: string; readonly kind: 'command' | 'file-change' | 'external-action' | 'other'; readonly state: 'pending' | 'resolved'; readonly outcome?: 'approved' | 'denied' | 'expired' | 'cancelled' }
}
