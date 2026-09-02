import { describe, expect, it } from 'vitest'
import { CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1 } from '../packages/cli/src/plugin-bundle-contracts.js'
import { parsePluginLifecycleBindingRequest, type PluginLifecycleBridgeHandler } from '../packages/cli/src/launcher/plugin-lifecycle-rpc.js'

const handler = {
  token: 'secret', profileId: 'work', generation: 'runtime-a', coordinator: {}, bundleCoordinator: {},
} as unknown as PluginLifecycleBridgeHandler

describe('plugin bundle lifecycle private binding', () => {
  it('accepts a fenced bundle request and rejects an unsupported operation before dispatch', () => {
    const request = {
      $schema: CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId: 'bundle-request-1', profileId: 'work', expectedRevision: 3, expectedPluginRevision: 7, runtimeGeneration: 'runtime-a',
      operation: { kind: 'uninstall', bundleId: 'team-workflow', impactToken: '' },
    }
    expect(parsePluginLifecycleBindingRequest({
      token: 'secret', privateRequest: { kind: 'bundle-operation-v1', requestId: request.requestId, profileId: 'work', runtimeGeneration: 'runtime-a', request },
    }, handler)).toMatchObject({ kind: 'bundle-operation-v1', requestId: 'bundle-request-1' })
    expect(() => parsePluginLifecycleBindingRequest({
      token: 'secret', privateRequest: { kind: 'bundle-operation-v1', requestId: request.requestId, profileId: 'work', runtimeGeneration: 'runtime-a', request: { ...request, operation: { kind: 'execute-bundle-code' } } },
    }, handler)).toThrow('unsupported')
  })

  it('accepts only same-profile same-generation bundle snapshot reads', () => {
    expect(parsePluginLifecycleBindingRequest({ token: 'secret', privateRequest: { kind: 'bundle-snapshot-v1', requestId: 'snapshot-1', profileId: 'work', runtimeGeneration: 'runtime-a' } }, handler)).toEqual({ kind: 'bundle-snapshot-v1', requestId: 'snapshot-1' })
    expect(() => parsePluginLifecycleBindingRequest({ token: 'secret', privateRequest: { kind: 'bundle-snapshot-v1', requestId: 'snapshot-1', profileId: 'other', runtimeGeneration: 'runtime-a' } }, handler)).toThrow('stale')
  })

  it('requires explicit override-clear intent on permission operations', () => {
    const request = {
      $schema: CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId: 'bundle-permissions-1', profileId: 'work', expectedRevision: 3, expectedPluginRevision: 7, runtimeGeneration: 'runtime-a',
      operation: { kind: 'set-permissions', bundleId: 'team-workflow', bundlePermissions: [], pluginOverrides: [], impactToken: '' },
    }
    expect(() => parsePluginLifecycleBindingRequest({
      token: 'secret', privateRequest: { kind: 'bundle-operation-v1', requestId: request.requestId, profileId: 'work', runtimeGeneration: 'runtime-a', request },
    }, handler)).toThrow('clearPluginOverrides is required')
  })
})
