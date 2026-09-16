import { describe, expect, it, vi } from 'vitest'

import type {
  NativeProviderCredentialBroker,
  NativeProviderCredentialPreparation,
} from '../packages/cli/src/launcher/native-provider-credential-broker.js'
import type { NativeManagedGatewayConnectionSession } from '../packages/cli/src/launcher/managed-service-native-connection.js'
import { nativeSubmissionCredentialBroker } from '../packages/cli/src/launcher/native-submission-credentials.js'

function endpoint(
  input: Readonly<{ generation?: string; scheme?: 'none' | 'bearer'; dispose: () => void }>,
): NativeManagedGatewayConnectionSession {
  return {
    value: {
      service: { pluginId: 'plugin-a', serviceId: 'gateway', generation: input.generation ?? 'service-1' },
      endpoint: {
        origin: 'http://127.0.0.1:43127',
        apiPath: '/v1',
        auth: input.scheme === 'none' ? { scheme: 'none' } : { scheme: 'bearer', token: 'never-project-this' },
      },
      models: { generation: 'models-1', defaultAlias: 'default', aliases: [] },
      cleanup: { authorityId: 'never-project-this-either' },
    },
    dispose: input.dispose,
  }
}

describe('native submission credential adapter', () => {
  it('combines matching private snapshots and retains only the durable broker lease', async () => {
    const disposePreparation = vi.fn()
    const disposeEndpoint = vi.fn()
    const preparation: NativeProviderCredentialPreparation = {
      scheme: 'bearer',
      serviceGeneration: 'service-1',
      auth: {
        command: '/usr/bin/node',
        args: ['/private/helper.mjs', '/private/socket', 'opaque-handle'],
        cwd: '/private',
        timeout_ms: 5_000,
        refresh_interval_ms: 200,
      },
      dispose: disposePreparation,
    }
    const credentials = {
      prepare: vi.fn(async () => preparation),
      close: vi.fn(async () => undefined),
    } satisfies NativeProviderCredentialBroker
    const broker = nativeSubmissionCredentialBroker({
      credentials,
      resolveEndpoint: () => endpoint({ dispose: disposeEndpoint }),
    })

    const lease = await broker.prepare('provider-a')
    expect(lease).toEqual({
      serviceGeneration: 'service-1',
      endpoint: { baseUrl: 'http://127.0.0.1:43127/v1', wireApi: 'responses' },
      auth: {
        scheme: 'bearer-command',
        command: '/usr/bin/node',
        args: ['/private/helper.mjs', '/private/socket', 'opaque-handle'],
        cwd: '/private',
        timeoutMs: 5_000,
        refreshIntervalMs: 200,
      },
      dispose: expect.any(Function),
    })
    expect(JSON.stringify(lease)).not.toMatch(/never-project-this/)
    expect(disposeEndpoint).toHaveBeenCalledOnce()
    expect(disposePreparation).not.toHaveBeenCalled()
    await lease.dispose()
    expect(disposePreparation).toHaveBeenCalledOnce()
  })

  it.each([
    { generation: 'service-2', scheme: 'bearer' as const },
    { generation: 'service-1', scheme: 'none' as const },
  ])('rejects endpoint identity drift and disposes both snapshots: %j', async drift => {
    const disposePreparation = vi.fn()
    const disposeEndpoint = vi.fn()
    const credentials = {
      prepare: vi.fn(async () => ({
        scheme: 'bearer' as const,
        serviceGeneration: 'service-1',
        auth: {
          command: '/usr/bin/node',
          args: ['/private/helper.mjs'],
          cwd: '/private',
          timeout_ms: 5_000,
          refresh_interval_ms: 200,
        },
        dispose: disposePreparation,
      })),
      close: vi.fn(async () => undefined),
    }
    const broker = nativeSubmissionCredentialBroker({
      credentials,
      resolveEndpoint: () => endpoint({ ...drift, dispose: disposeEndpoint }),
    })

    await expect(broker.prepare('provider-a')).rejects.toThrow('credential endpoint unavailable')
    expect(disposeEndpoint).toHaveBeenCalledOnce()
    expect(disposePreparation).toHaveBeenCalledOnce()
  })
})
