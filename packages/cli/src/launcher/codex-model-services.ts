import { parseModelServicesSaveRequest, readModelServices, saveModelServices } from './model-service-store.js'
import { MODEL_SERVICE_SAFE_WRITE_CONTRACT } from '../model-service-contracts.js'

/** The Manager, CLI and MCP use the same write-only credential store and revision. */
export function createCodexModelServices(input: {
  readonly configPath: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly guard?: (
    operation: string,
    args: Record<string, unknown>,
    metadata?: unknown,
  ) => Promise<unknown | undefined>
}) {
  return async (operation: 'read' | 'save', value: unknown, metadata?: unknown): Promise<unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'rejected', code: 'INVALID_REQUEST' }
    }
    const args = value as Record<string, unknown>
    if (operation === 'read') {
      if (Object.keys(args).length) return { status: 'rejected', code: 'INVALID_REQUEST' }
      const result = await readModelServices(input.configPath, input.environment)
      return result.status === 'ok' ? { ...result, managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT } : result
    }
    // Channel-originated tasks cannot mutate profile/global settings through a generic tool.
    const guarded = await input.guard?.('execution-defaults-set', {}, metadata)
    if (guarded !== undefined) return guarded
    if (Object.keys(args).some(key => !['expectedRevision', 'services'].includes(key))) {
      return { status: 'rejected', code: 'INVALID_REQUEST' }
    }
    const request = parseModelServicesSaveRequest(args)
    return request ? saveModelServices(input.configPath, request) : { status: 'rejected', code: 'INVALID_REQUEST' }
  }
}
