import { expect, it } from 'vitest'
import { createManagerRendererGatewayAuthenticator } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { effectiveConfigFingerprint, type SupervisorState } from '../packages/cli/src/cli/supervisor-state.js'

it('authenticates the owner independently of the selected Manager deployment', async () => {
  const ownerFingerprint = effectiveConfigFingerprint({ appId: 'codex', generation: 'owner-1' })
  let state: SupervisorState = {
    schemaVersion: 1,
    appId: 'manager',
    profileId: 'fixture',
    phase: 'ready',
    pid: 42,
    processStartedAt: 'fixture-start',
    instanceToken: 'a'.repeat(64),
    createdAt: 'fixture',
    version: 'fixture',
    effectiveConfig: effectiveConfigFingerprint({ appId: 'codex', generation: 'owner-1', deployment: 'revision' }),
    managerOwnerFingerprint: ownerFingerprint,
  }
  const proof = { pid: state.pid, processStartedAt: state.processStartedAt, instanceToken: state.instanceToken }
  const authenticate = createManagerRendererGatewayAuthenticator({
    homeDir: '/fixture',
    profileId: 'fixture',
    ownerAppId: 'codex',
    ownerGeneration: 'owner-1',
    readState: async () => ({ status: 'valid', state }),
    identify: async () => 'alive',
    ping: async () => true,
  })
  expect(await authenticate(proof)).toBe(true)
  state = { ...state, managerOwnerFingerprint: 'b'.repeat(64) }
  expect(await authenticate(proof)).toBe(false)
  state = { ...state, effectiveConfig: ownerFingerprint }
  expect(await authenticate(proof)).toBe(false)
  state = { ...state, effectiveConfig: ownerFingerprint, managerOwnerFingerprint: undefined }
  expect(await authenticate(proof)).toBe(true)
})
