/** Host-private diagnostics for one explicitly selected local development entry. */
export interface CordisXLocalDevelopmentSnapshot {
  readonly origin: 'local-dev'
  readonly pluginId: string
  readonly sourcePath: string
  readonly state: 'building' | 'ready' | 'failed'
  readonly lastSuccessfulAt?: string
  readonly error?: string
}
