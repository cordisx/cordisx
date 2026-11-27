import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { dispatchOwnerAdapterRpcOperation } from '../packages/cli/src/cli/owner-adapter-rpc.js'
import { OwnerAdapterSessions } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

it('uses the private owner transport for an adapter and leaves the owner alive after the adapter closes', async () => {
  const root = await mkdtemp('/tmp/cx-adapter-rpc-')
  const appId = 'codex'
  const profileId = 'default'
  const generation = 'owner-1'
  const startedAt = (await processStartIdentity(process.pid))!
  const active: CordisXPluginActivationRecordV1 = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId,
    runtimeGeneration: generation,
    revision: 0,
    lastGoodRevision: 0,
    plugins: [],
  }
  const snapshot = { active, registryEpoch: 0 }
  const sessions = new OwnerAdapterSessions({
    scope: { homeDigest: 'a'.repeat(64), ownerAppId: appId, profileId, generation },
    adapter: { appId, adapterId: 'codex-desktop' },
    ownerCurrent: () => true,
    snapshot: () => snapshot,
    attach: async peer => {
      expect(await peer.request('synchronize', snapshot)).toEqual(snapshot)
    },
    document: async value => ({ size: (value as { value: string }).value.length }),
    artifact: async value => ({ kind: (value as { kind: string }).kind }),
  })
  let server: Awaited<ReturnType<typeof startPluginManagementRpcServer>> | undefined
  try {
    server = await startPluginManagementRpcServer({
      homeDir: root,
      appId,
      profileId,
      configPath: path.join(root, 'config.json'),
      generation,
      processStartedAt: startedAt,
      service: {} as PluginManagementService,
      ownerAdapter: async operation => await dispatchOwnerAdapterRpcOperation(sessions, operation),
    })
    const paths = pluginManagementRpcPaths(root, appId, profileId)
    const endpoint = (await readPluginManagementRpcEndpoint(paths))!
    const request = (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
      requestPluginManagementRpc(paths, endpoint, operation)
    await expect(requestPluginManagementRpc(paths, { ...endpoint, token: 'f'.repeat(64) }, {
      kind: 'owner-adapter',
      action: 'open',
      pid: process.pid,
      processStartedAt: startedAt,
    })).rejects.toThrow()
    const opened = await request({
      kind: 'owner-adapter',
      action: 'open',
      pid: process.pid,
      processStartedAt: startedAt,
    }) as { status: string; value: { sessionId: string; grant: string; snapshot: typeof snapshot } }
    expect(opened).toMatchObject({ status: 'ok', value: { snapshot } })
    const { sessionId, grant } = opened.value
    const admit = request({ kind: 'owner-adapter', action: 'admit', sessionId, grant })
    const polled = await request({ kind: 'owner-adapter', action: 'poll', sessionId, grant, timeoutMs: 1_000 }) as {
      status: string
      value: { command: { id: string; sequence: number; method: string; payload: unknown } }
    }
    expect(polled).toMatchObject({ status: 'ok', value: { command: { method: 'synchronize', payload: snapshot } } })
    const command = polled.value.command
    expect(
      await request({
        kind: 'owner-adapter',
        action: 'acknowledge',
        sessionId,
        grant,
        receipt: { id: command.id, sequence: command.sequence, ok: true, value: snapshot },
      }),
    ).toEqual({ status: 'ok' })
    expect(await admit).toEqual({ status: 'ok' })
    expect(
      await request({
        kind: 'owner-adapter',
        action: 'document',
        sessionId,
        grant,
        payload: { operation: 'replace', value: 'x'.repeat(300_000) },
      }),
    ).toEqual({ status: 'ok', value: { size: 300_000 } })
    expect(
      await request({
        kind: 'owner-adapter',
        action: 'artifact',
        sessionId,
        grant,
        payload: {
          kind: 'preview',
          requestId: 'preview-one',
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
        },
      }),
    ).toEqual({ status: 'ok', value: { kind: 'preview' } })
    await expect(request({
      kind: 'owner-adapter',
      action: 'management',
      sessionId,
      grant,
      payload: { kind: 'query', value: 'x'.repeat(300_000) },
    })).rejects.toThrow('exceeds maximum size')
    expect(await request({ kind: 'owner-adapter', action: 'close', sessionId, grant })).toEqual({ status: 'ok' })
    expect(
      await request({
        kind: 'owner-adapter',
        action: 'open',
        pid: process.pid,
        processStartedAt: startedAt,
      }),
    ).toMatchObject({ status: 'ok', value: { snapshot } })
  } finally {
    sessions.close()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
