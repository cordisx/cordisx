/**
 * Manager-page contract for the top-level `model-service` providers in the
 * CordisX home config. Keys are write-only: a read reports only whether the
 * declared environment variable has a value.
 */

export type ModelServiceProtocol = 'anthropic-messages' | 'openai-responses'

export interface ModelServiceView {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly protocols: readonly ModelServiceProtocol[]
  readonly codexModels: readonly string[]
  readonly claudeModels: readonly string[]
  readonly enabled: boolean
  /** Whether CordisX can supply the key: a stored environment entry or the launch environment has it. */
  readonly keyConfigured: boolean
}

export interface ModelServiceInput {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly protocols: readonly ModelServiceProtocol[]
  readonly codexModels: readonly string[]
  readonly claudeModels: readonly string[]
  readonly enabled: boolean
  /** A new key to store; omitted keeps the current one. */
  readonly apiKey?: string
}

export type ModelServicesReadResult =
  | { readonly status: 'ok'; readonly revision: string; readonly services: readonly ModelServiceView[] }
  | { readonly status: 'rejected'; readonly code: 'unavailable' }

export type ModelServicesSaveResult =
  | { readonly status: 'applied'; readonly applies: 'app-restart'; readonly revision: string }
  | {
    readonly status: 'rejected'
    readonly code: 'unavailable' | 'conflict' | 'invalid' | 'persist-failed'
    readonly message?: string
  }

export interface ModelServicesSaveRequest {
  readonly expectedRevision: string
  readonly services: readonly ModelServiceInput[]
}

/** The environment variable a declaration's key lives in, derived from its id. */
export function modelServiceKeyEnv(id: string): string {
  return `CORDISX_MODEL_SERVICE_${id.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_KEY`
}
