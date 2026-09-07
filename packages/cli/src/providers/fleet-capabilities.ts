import type { CordisXPlatformCapability, CordisXPlatformDiagnostic } from '../contracts.js'

export const FLEET_CAPABILITIES: readonly CordisXPlatformCapability[] = Object.freeze([
  'models.read',
  'tasks.catalog.read',
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
  'turns.introduce',
  'approvals.decide',
])

export const CURRENT_CONNECTION_UNAVAILABLE: CordisXPlatformDiagnostic = Object.freeze({
  code: 'current-connection-client-unavailable',
  message:
    'The native Codex Desktop current connection remains unavailable; Provider Fleet connections are routed independently',
})
