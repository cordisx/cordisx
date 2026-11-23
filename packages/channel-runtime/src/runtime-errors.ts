import { ChannelIntegrityError } from './runtime-validation.js'
import type { ChannelCapability, ChannelPermissionDecision } from './types.js'
export class RetryableChannelError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RetryableChannelError'
    this.code = normalizedErrorCode(code)
  }
}

export class UncertainChannelSendError extends Error {
  readonly code: string
  constructor(code = 'OUTBOUND_RESULT_UNKNOWN') {
    super(code)
    this.name = 'UncertainChannelSendError'
    this.code = normalizedErrorCode(code)
  }
}

export class ChannelPermissionError extends Error {
  readonly capability: ChannelCapability
  readonly decision: Exclude<ChannelPermissionDecision, 'allow'>

  constructor(capability: ChannelCapability, decision: Exclude<ChannelPermissionDecision, 'allow'>) {
    super(`Channel capability ${capability} is ${decision}`)
    this.name = 'ChannelPermissionError'
    this.capability = capability
    this.decision = decision
  }
}

export class ChannelGenerationFencedError extends Error {
  constructor() {
    super('Channel adapter generation is no longer current')
    this.name = 'ChannelGenerationFencedError'
  }
}

function normalizedErrorCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9._-]+/g, '_').slice(0, 128)
  return normalized.length === 0 ? 'CHANNEL_ERROR' : normalized
}

export function errorCode(error: unknown): string {
  if (error instanceof UncertainChannelSendError) return error.code
  if (error instanceof RetryableChannelError) return error.code
  if (error instanceof ChannelIntegrityError) return 'INTEGRITY_ERROR'
  return normalizedErrorCode(error instanceof Error ? error.name : 'CHANNEL_ERROR')
}

import type { ChannelAdapterDescriptor } from './types.js'
export function secretStateForStartFailure(
  descriptor: ChannelAdapterDescriptor,
  error: unknown,
): ChannelAdapterDescriptor['secretState'] {
  if (!(error instanceof Error)) return descriptor.secretState
  if (error.name === 'CHANNEL_SECRET_MISSING') return 'missing'
  if (error.name === 'CHANNEL_SECRET_UNAVAILABLE' || error.name === 'CHANNEL_SECRET_REF_INVALID') return 'unavailable'
  return descriptor.secretState
}
