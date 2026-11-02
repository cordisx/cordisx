import type { StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import { createStartupUIRPC, parseStartupUIRequest } from './startup-ui-rpc.js'

/** Separate Host authority; never represented by, or delegated to, a plugin owner. */
export function createStartupHostUIBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly observer: StartupObserverV1
}) {
  const rpc = createStartupUIRPC([], input)
  return {
    token: input.token,
    async handleBindingValue(payload: string): Promise<Record<string, unknown>> {
      let requestId = 'invalid'
      try {
        if (payload.length > 256 * 1024) throw new Error('startup request too large')
        const value = JSON.parse(payload) as Record<string, unknown>
        if (typeof value.requestId === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value.requestId)) {
          requestId = value.requestId
        } else throw new Error('startup request id is invalid')
        if (value.version !== 1 || value.token !== input.token) throw new Error('startup request is not authorized')
        const scope = value.scope as Record<string, unknown> | undefined
        if (
          !scope || Object.keys(scope).sort().join(',') !== 'profileId,runtimeGeneration'
          || scope.profileId !== input.profileId || scope.runtimeGeneration !== input.generation
        ) throw new Error('startup Host scope is stale or spoofed')
        const request = parseStartupUIRequest(value)
        const result = await rpc.handle({ kind: 'host', hostGeneration: input.generation }, request)
        return { requestId, ok: true, value: result }
      } catch {
        return { requestId, ok: false, code: 'startup-host-request-rejected' }
      }
    },
    dispose: () => rpc.dispose(),
  }
}
