import { expect, it, vi } from 'vitest'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import {
  installMarketplaceArtifactBinding,
  MARKETPLACE_ARTIFACT_BINDING,
} from '../packages/cli/src/launcher/marketplace-artifact-cdp.js'

it('forwards native artifact requests without holding the generation gate and cancels the owner request', async () => {
  let listener: ((params: Record<string, unknown>) => void) | undefined
  const send = vi.fn(async () => ({}))
  const session = {
    send,
    onEvent: (_name: string, callback: typeof listener) => {
      listener = callback
      return () => listener = undefined
    },
  } as unknown as CdpSession
  const gate = {
    run: vi.fn(async () => {
      throw new Error('remote request held the local gate')
    }),
  }
  const started = vi.fn()
  const cancelled = vi.fn()
  const lifetime = new AbortController()
  const remove = installMarketplaceArtifactBinding({
    session,
    gate,
    signal: lifetime.signal,
    remote: {
      request: async (_request, signal) =>
        await new Promise(resolve => {
          started()
          signal.addEventListener('abort', () => {
            cancelled()
            resolve(undefined)
          }, { once: true })
        }),
    },
  })
  try {
    listener!({
      name: MARKETPLACE_ARTIFACT_BINDING,
      payload: JSON.stringify({
        kind: 'inspect',
        requestId: 'one',
        request: {
          schemaVersion: 8,
          pluginId: 'demo',
          version: '1.0.0',
          canonicalSource: 'https://example.com/plugins',
          artifact: {
            packageName: 'demo',
            downloadUrl: 'https://example.com/demo.tgz',
            integrity: `sha256:${'a'.repeat(64)}`,
          },
        },
      }),
    })
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
    listener!({
      name: MARKETPLACE_ARTIFACT_BINDING,
      payload: JSON.stringify({ kind: 'cancel', requestId: 'cancel-one', targetRequestId: 'one' }),
    })
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
    expect(gate.run).not.toHaveBeenCalled()
  } finally {
    remove()
    lifetime.abort()
  }
})
