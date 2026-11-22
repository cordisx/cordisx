/** Private owner-to-Manager readback request; it carries no service capability or credentials. */
export interface ManagedServiceStateConfirmation {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly sequence: number
  readonly phase: 'prepare' | 'confirm'
}
