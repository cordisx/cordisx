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
  readonly apiKeyEnv: string
  readonly codexExecutable: string
  readonly codexHome: string
  readonly enabled: boolean
  readonly timeoutMs: number
}

export type ProviderConnectionState = 'idle' | 'starting' | 'ready' | 'draining' | 'unavailable' | 'closed'

export interface ProviderConnectionStatus {
  readonly providerId: string
  readonly displayName: string
  readonly generation: string
  readonly state: ProviderConnectionState
  readonly diagnostic?: CordisXPlatformDiagnostic
  readonly external: true
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
  createSession(input: { readonly model: CordisXPlatformModelRef; readonly cwd: string }): Promise<CordisXPlatformResult<CordisXSessionSummary>>
  controlSession(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>>
  submitTurn(input: { readonly session: CordisXPlatformSessionRef; readonly message: string }): Promise<CordisXPlatformResult<CordisXTurnStart>>
  controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>>
  close(): Promise<void>
}
