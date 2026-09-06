import { describe, expect, it } from 'vitest'
import type { PlatformProviderBrokerBindingV1 } from '@cordisx/protocol/platform-provider/v1'
import {
  HostBoundPlatformProviderBrokerV1,
  issuePlatformProviderBrokerPolicy,
  PlatformProviderWorkspaceAuthority,
} from '../packages/cli/src/launcher/platform-provider-service.js'
import {
  CODEX_APP_SERVER_PLATFORM_BINDINGS_V1,
  CodexAppServerPlatformBrokerAuthority,
} from '../packages/cli/src/providers/codex-app-server-platform-broker.js'

const schema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/cli-proxy-provider-runtime-config.v1.schema.json'
const valueSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-value.v1.schema.json'
const owner = {
  ownerHandle: 'ppo_test' as const,
  pluginId: 'provider-plugin',
  serviceId: 'providers-runtime',
  sourceDigest: `sha256:${'a'.repeat(64)}` as const,
  hostGeneration: 'host-1',
  pluginGeneration: 'plugin-1',
}

function binding(direction: 'request' | 'event', method: string): PlatformProviderBrokerBindingV1 {
  const operation = direction === 'request' ? 'models.list' as const : 'approvals.decide' as const
  return direction === 'request'
    ? { direction, operation, method, requestSchema: valueSchema, resultSchema: valueSchema }
    : { direction, operation, method, eventSchema: valueSchema, responseSchema: valueSchema }
}

describe('Codex App Server Platform broker authority', () => {
  it('keeps raw configuration in Host open and translates only opaque workspace handles', async () => {
    let notification: ((method: string, params: unknown) => void) | undefined
    let request: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined
    let rpcClosed = false
    const rpcCalls: Array<{ method: string; params: unknown }> = []
    const authority = new CodexAppServerPlatformBrokerAuthority({
      serviceSchemas: [schema],
      open: async input => {
        expect(input.rawConfiguration).toEqual({ endpoint: 'host-private', secretRef: 'host-secret:key' })
        return {
          generation: 'rpc-1',
          request: async (method, params) => {
            rpcCalls.push({ method, params })
            if ((params as { probePrivate?: boolean }).probePrivate) {
              return { endpoint: 'https://private.invalid' } as never
            }
            if ((params as { probeWorkspace?: boolean }).probeWorkspace) {
              return { workspace: '/private/provider-workspace' } as never
            }
            if ((params as { probeWorkspaceAfterCwd?: boolean }).probeWorkspaceAfterCwd) {
              return { cwd: '/tmp/provider-workspace', workspace: '/private/provider-workspace' } as never
            }
            if ((params as { probeWorkspaceBeforeCwd?: boolean }).probeWorkspaceBeforeCwd) {
              return { workspace: '/private/provider-workspace', cwd: '/tmp/provider-workspace' } as never
            }
            return { cwd: '/tmp/provider-workspace', value: 'ok' } as never
          },
          subscribeNotifications: listener => {
            notification = listener
            return () => {
              notification = undefined
            }
          },
          subscribeRequests: listener => {
            request = listener
            return () => {
              request = undefined
            }
          },
          close: async () => {
            rpcClosed = true
          },
        }
      },
    })
    const requested = [
      binding('request', 'model/list'),
      binding('event', 'item/commandExecution/requestApproval'),
    ] as [PlatformProviderBrokerBindingV1, ...PlatformProviderBrokerBindingV1[]]
    const policy = issuePlatformProviderBrokerPolicy({
      owner,
      providerId: 'gateway-a',
      providerGeneration: 'host-1:plugin-1:gateway-a',
      operations: ['models.list', 'approvals.decide'],
      request: { bindings: requested },
      catalog: authority.catalog(schema),
    })
    const workspaces = new PlatformProviderWorkspaceAuthority()
    const workspace = workspaces.issue('/tmp/provider-workspace')
    const transport = await authority.open({
      owner,
      configuration: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v2',
        schemaVersion: 2,
        configurationRevision: 1,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        enabled: true,
        requestTimeoutMs: 30_000,
        mapping: { models: [] },
      },
      rawConfiguration: { endpoint: 'host-private', secretRef: 'host-secret:key' },
      policy,
      workspaces,
    })
    const broker = new HostBoundPlatformProviderBrokerV1(policy, transport)
    const result = await broker.exchange({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
      contract: 'cordisx.platform-provider-broker-request/v1',
      schemaVersion: 1,
      requestId: 'request-1',
      operation: 'models.list',
      method: 'model/list',
      requestSchema: valueSchema,
      params: { workspace: { workspaceHandle: workspace.workspaceHandle } },
    })
    expect(rpcCalls).toEqual([{ method: 'model/list', params: { cwd: '/tmp/provider-workspace' } }])
    expect(result).toMatchObject({
      status: 'accepted',
      value: { workspace: { workspaceHandle: expect.stringMatching(/^ppw_/) }, value: 'ok' },
    })
    await expect(broker.exchange({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
      contract: 'cordisx.platform-provider-broker-request/v1',
      schemaVersion: 1,
      requestId: 'request-2',
      operation: 'models.list',
      method: 'model/list',
      requestSchema: valueSchema,
      params: { probePrivate: true },
    })).resolves.toMatchObject({ status: 'rejected', code: 'invalid-request' })
    for (
      const params of [
        { probeWorkspace: true },
        { probeWorkspaceAfterCwd: true },
        { probeWorkspaceBeforeCwd: true },
      ]
    ) {
      await expect(broker.exchange({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
        contract: 'cordisx.platform-provider-broker-request/v1',
        schemaVersion: 1,
        requestId: `request-${Object.keys(params)[0]}`,
        operation: 'models.list',
        method: 'model/list',
        requestSchema: valueSchema,
        params,
      })).resolves.toMatchObject({ status: 'rejected', code: 'invalid-request' })
    }

    const events: unknown[] = []
    await expect(request?.('item/commandExecution/requestApproval', {})).rejects.toThrow(
      'No Platform provider listener',
    )
    const subscription = broker.subscribe(['approvals.decide'], event => {
      events.push(event)
    })
    expect(() => request?.('unsupported/request', {})).toThrow('Unsupported App Server request')
    notification?.('turn/started', { workspace: '/private/provider-workspace' })
    await Promise.resolve()
    expect(events).toEqual([])
    await expect(
      request?.('item/commandExecution/requestApproval', {
        workspace: '/private/provider-workspace',
      }),
    ).rejects.toThrow('workspace is Host-private')
    await expect(
      request?.('item/commandExecution/requestApproval', {
        cwd: '/tmp/provider-workspace',
        workspace: '/private/provider-workspace',
      }),
    ).rejects.toThrow('workspace is Host-private')
    await expect(
      request?.('item/commandExecution/requestApproval', {
        workspace: '/private/provider-workspace',
        cwd: '/tmp/provider-workspace',
      }),
    ).rejects.toThrow('workspace is Host-private')
    const response = request?.('item/commandExecution/requestApproval', {
      threadId: 'session-1',
      turnId: 'turn-1',
      itemId: 'approval-1',
      cwd: '/tmp/provider-workspace',
    }) as Promise<unknown>
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) await Promise.resolve()
    const event = events[0] as { eventId: string }
    expect(event).toMatchObject({
      operation: 'approvals.decide',
      method: 'item/commandExecution/requestApproval',
      responseRequired: true,
      payload: { workspace: { workspaceHandle: expect.stringMatching(/^ppw_/) } },
    })
    await expect(broker.respond({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-response.v1.schema.json',
      contract: 'cordisx.platform-provider-broker-response/v1',
      schemaVersion: 1,
      eventId: event.eventId,
      operation: 'approvals.decide',
      method: 'item/commandExecution/requestApproval',
      responseSchema: valueSchema,
      value: { decision: 'accept' },
    })).resolves.toBe('accepted')
    await expect(response).resolves.toEqual({ decision: 'accept' })
    notification?.('turn/started', {})
    subscription.unsubscribe()
    await expect(request?.('item/commandExecution/requestApproval', {})).rejects.toThrow(
      'No Platform provider listener',
    )
    await broker.dispose()
    expect(rpcClosed).toBe(true)
    expect(notification).toBeUndefined()
    expect(request).toBeUndefined()
    workspaces.dispose()
  })

  it('rejects a synchronously delivered request before a broker can subscribe', async () => {
    let reentrantRequest: Promise<unknown> | undefined
    const authority = new CodexAppServerPlatformBrokerAuthority({
      serviceSchemas: [schema],
      open: async () => ({
        generation: 'rpc-reentrant',
        request: async () => ({}),
        subscribeRequests: listener => {
          reentrantRequest = Promise.resolve(listener('item/commandExecution/requestApproval', {}))
          return () => undefined
        },
        close: async () => undefined,
      }),
    })
    const requested = [binding('event', 'item/commandExecution/requestApproval')] as [
      PlatformProviderBrokerBindingV1,
      ...PlatformProviderBrokerBindingV1[],
    ]
    const policy = issuePlatformProviderBrokerPolicy({
      owner,
      providerId: 'gateway-reentrant',
      providerGeneration: 'host-1:plugin-1:gateway-reentrant',
      operations: ['approvals.decide'],
      request: { bindings: requested },
      catalog: authority.catalog(schema),
    })
    const workspaces = new PlatformProviderWorkspaceAuthority()
    const transport = await authority.open({
      owner,
      configuration: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v2',
        schemaVersion: 2,
        configurationRevision: 1,
        providerId: 'gateway-reentrant',
        displayName: 'Gateway Reentrant',
        enabled: true,
        requestTimeoutMs: 30_000,
        mapping: { models: [] },
      },
      rawConfiguration: {},
      policy,
      workspaces,
    })
    await expect(reentrantRequest).rejects.toThrow('No Platform provider listener')
    await transport.dispose()
    workspaces.dispose()
  })

  it('rejects unknown service schemas and publishes the exact method catalog', async () => {
    const authority = new CodexAppServerPlatformBrokerAuthority({
      serviceSchemas: [schema],
      open: async () => {
        throw new Error('not reached')
      },
    })
    expect(() => authority.catalog('https://example.invalid/schema')).toThrow('unsupported')
    expect(CODEX_APP_SERVER_PLATFORM_BINDINGS_V1).toHaveLength(22)
  })
})
