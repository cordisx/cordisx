/** Shared supplemental settings routing for Desktop and the existing service owner. */
export async function dispatchCodexSettings(
  authority: {
    execution?(operation: string, input: unknown, metadata?: unknown): Promise<unknown>
    modelServices?(operation: 'read' | 'save', input: unknown, metadata?: unknown): Promise<unknown>
  },
  operation: unknown,
  input: unknown,
  metadata?: unknown,
): Promise<unknown | undefined> {
  if (typeof operation === 'string' && operation.startsWith('execution:')) {
    return await authority.execution?.(operation.slice('execution:'.length), input, metadata)
      ?? { status: 'unavailable', code: 'EXECUTION_SETTINGS_UNAVAILABLE' }
  }
  if (operation === 'model-services:read' || operation === 'model-services:save') {
    return await authority.modelServices?.(operation === 'model-services:read' ? 'read' : 'save', input, metadata)
      ?? { status: 'unavailable', code: 'MODEL_SERVICES_UNAVAILABLE' }
  }
  return undefined
}
