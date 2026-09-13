import type { HttpNativeAccountUnavailableReason } from './plugin-http-native-account-diagnostics.js'
import { createHash } from 'node:crypto'

export type PluginHttpRetirementReason =
  | 'connection-closed'
  | 'client-disposed'
  | 'client-revoked'
  | 'principal-retired'
  | 'native-account-changed'
  | 'native-account-unavailable'
  | 'native-calling-context-unavailable'
  | 'session-forgotten'
  | 'authority-disposed'

/** Fixed Host-private rejection branches; never include request or error values. */
export type PluginHttpInvalidRequestReason =
  | 'record-invalid'
  | 'origin-invalid'
  | 'client-id-invalid'
  | 'client-limit'
  | 'managed-deadline-invalid'
  | 'managed-queue-limit'
  | 'managed-response-invalid'
  | 'operation-unsupported'
  | 'authority-request-exception'
  | 'session-scope-invalid'
  | 'session-origin-insecure'
  | 'session-retained-scope-mismatch'
  | 'authorization-credential-invalid'
  | 'authorization-origin-insecure'
  | 'authorization-secret-invalid'
  | 'authorization-secret-unexpected'
  | 'exchange-field-invalid'
  | 'exchange-response-invalid'
  | 'request-id-invalid'
  | 'request-id-duplicate'
  | 'request-concurrency-limit'
  | 'request-path-invalid'
  | 'request-origin-invalid'
  | 'request-method-invalid'
  | 'request-deadline-invalid'
  | 'request-body-invalid'
  | 'request-header-invalid'
export class PluginHttpInvalidRequestError extends Error {
  constructor(readonly reason: PluginHttpInvalidRequestReason) {
    super('invalid-request')
  }
}

export interface PluginHttpDiagnostic {
  readonly event:
    | 'retired'
    | 'client-disposed'
    | 'connection-not-owned'
    | 'native-account-read-unavailable'
    | 'invalid-request'
  readonly pluginId: string
  readonly client: string
  readonly connection?: string
  readonly reason?: PluginHttpRetirementReason | HttpNativeAccountUnavailableReason | PluginHttpInvalidRequestReason
}

/** Only opaque correlation tags and bounded reasons reach normal operator diagnostics. */
export function emitPluginHttpDiagnostic(
  listener: ((event: PluginHttpDiagnostic) => void) | undefined,
  input: {
    event: PluginHttpDiagnostic['event']
    pluginId: string
    client: string
    connection?: string
    reason?: PluginHttpRetirementReason | HttpNativeAccountUnavailableReason | PluginHttpInvalidRequestReason
  },
): void {
  const tag = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)
  if (!listener) return
  try {
    listener(Object.freeze({
      event: input.event,
      pluginId: input.pluginId,
      client: tag(input.client),
      ...(input.connection === undefined ? {} : { connection: tag(input.connection) }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }))
  } catch { /* Diagnostic subscribers cannot change transport cleanup. */ }
}
