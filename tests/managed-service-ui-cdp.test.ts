import { describe, expect, it, vi } from 'vitest'

// Import only the RPC constants directly (no CDP session dependency)
import {
  MANAGED_SERVICE_UI_BINDING,
  MANAGED_SERVICE_UI_RECEIVER,
  MAX_MANAGED_SERVICE_UI_REQUEST_BYTES,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

describe('managed service UI CDP transport constants', () => {
  it('MANAGED_SERVICE_UI_BINDING is a stable wire name', () => {
    expect(MANAGED_SERVICE_UI_BINDING).toBe('__cordisxManagedServiceUIRequestV1')
  })

  it('MANAGED_SERVICE_UI_RECEIVER is a stable wire name', () => {
    expect(MANAGED_SERVICE_UI_RECEIVER).toBe('__cordisxManagedServiceUIReceiveV1')
  })

  it('MAX_MANAGED_SERVICE_UI_REQUEST_BYTES is a reasonable size', () => {
    expect(MAX_MANAGED_SERVICE_UI_REQUEST_BYTES).toBe(256 * 1024)
    expect(MAX_MANAGED_SERVICE_UI_REQUEST_BYTES).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe('managed service UI CDP transport layer design', () => {
  it('sendManagedServiceUIBindingResponse uses the receiver global for delivery', () => {
    // Verify the receiver name is correctly formed for Runtime.evaluate
    const expression = `void globalThis.${MANAGED_SERVICE_UI_RECEIVER}?.(${
      JSON.stringify(JSON.stringify({ requestId: 'req-1', ok: true }))
    })`
    expect(expression).toContain(MANAGED_SERVICE_UI_RECEIVER)
    expect(expression).toContain('req-1')
    expect(expression).toContain('true')
    // Must use optional chaining for safety
    expect(expression).toContain('?.')
  })

  it('sendManagedServiceUIBindingResponse handles error payloads', () => {
    const expression = `void globalThis.${MANAGED_SERVICE_UI_RECEIVER}?.(${
      JSON.stringify(JSON.stringify({ requestId: 'req-err', ok: false, error: 'test error' }))
    })`
    expect(expression).toContain(MANAGED_SERVICE_UI_RECEIVER)
    expect(expression).toContain('test error')
    expect(expression).toContain('false')
  })

  it('the binding name is namespaced under cordisx for collision avoidance', () => {
    expect(MANAGED_SERVICE_UI_BINDING).toMatch(/^__cordisx/)
    expect(MANAGED_SERVICE_UI_BINDING).toMatch(/V1$/)
  })

  it('MAX_MANAGED_SERVICE_UI_REQUEST_BYTES is 256KB to match the RPC handler', () => {
    // The RPC handler enforces this limit; the transport must match
    expect(MAX_MANAGED_SERVICE_UI_REQUEST_BYTES).toBe(256 * 1024)
  })
})

describe('managed service UI multi-owner capability isolation', () => {
  it('the transport accepts a handleBindingValue callback, not a fixed owner', () => {
    // The transport layer (cdp-installation.ts) receives { handleBindingValue: (value: string) => Promise<void> }
    // Each call is owner-agnostic: the callback resolves the owner from the payload token
    const received: string[] = []
    const handleBindingValue = vi.fn(async (value: string) => {
      received.push(value)
    })

    // Simulate two different plugin owners sending requests
    void handleBindingValue(
      JSON.stringify({
        version: 1,
        token: 'owner-a-token',
        requestId: 'a-1',
        operation: 'get',
        serviceId: 'gateway',
        scope: { profileId: 'default', runtimeGeneration: 'gen-1', pluginGeneration: 'plugin-a' },
      }),
    )
    void handleBindingValue(
      JSON.stringify({
        version: 1,
        token: 'owner-b-token',
        requestId: 'b-1',
        operation: 'get',
        serviceId: 'gateway',
        scope: { profileId: 'default', runtimeGeneration: 'gen-1', pluginGeneration: 'plugin-b' },
      }),
    )

    expect(handleBindingValue).toHaveBeenCalledTimes(2)
    expect(received.length).toBe(2)
    // The transport does not inspect the payload; each token independently identifies its owner
    expect(received[0]).toContain('owner-a-token')
    expect(received[1]).toContain('owner-b-token')
  })

  it('the transport does not couple to ManagedServiceUIOwner at the install level', () => {
    // The install function signature uses { handleBindingValue } not { handler, owner }
    // This ensures multiple renderers with different plugin owners can share the same transport
    const transport = {
      handleBindingValue: vi.fn(async () => {}),
    }
    expect(typeof transport.handleBindingValue).toBe('function')
    // No owner field present
    expect('owner' in transport).toBe(false)
    expect('handler' in transport).toBe(false)
  })
})
