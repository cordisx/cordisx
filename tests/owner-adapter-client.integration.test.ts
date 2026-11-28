import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { OwnerAdapterClient } from '../packages/cli/src/cli/owner-adapter-client.js'
import { dispatchOwnerAdapterRpcOperation } from '../packages/cli/src/cli/owner-adapter-rpc.js'
import { OwnerAdapterSessions } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { requestSupervisorPing, startSupervisorControlServer } from '../packages/cli/src/cli/supervisor-control.js'
import {
  effectiveConfigFingerprint,
  processStartIdentity,
  supervisorPaths,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

it('connects two native sessions to one authenticated service and reports owner loss', async () => {
  const homeDir = await mkdtemp('/tmp/cx-adapter-client-')
  const appId = 'codex'
  const profileId = 'default'
  const generation = 'owner-1'
  const startedAt = (await processStartIdentity(process.pid))!
  const token = 'a'.repeat(64)
  const paths = supervisorPaths(homeDir, appId, profileId)
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
  const artifactStarted = vi.fn()
  const artifactCancelled = vi.fn()
  const documentWrites = vi.fn()
  const sessions = new OwnerAdapterSessions({
    scope: { homeDigest: 'b'.repeat(64), ownerAppId: appId, profileId, generation },
    adapter: { appId, adapterId: 'codex-desktop' },
    ownerCurrent: () => true,
    snapshot: () => snapshot,
    attach: async peer => {
      expect(await peer.request('synchronize', snapshot)).toEqual(snapshot)
    },
    document: async value => {
      if ((value as { operation?: unknown }).operation === 'replace') {
        documentWrites()
        throw new Error('receipt lost after commit')
      }
      return { status: 'loaded', snapshot: { revision: documentWrites.mock.calls.length } }
    },
    modelServicesRead: async () => ({ status: 'ok', revision: 'owner-revision', services: [] }),
    artifact: async (value, signal) => {
      const request = value as { requestId: string }
      if (request.requestId === 'preview-one') return { readme: 'fixture' }
      return await new Promise(resolve => {
        artifactStarted()
        signal.addEventListener('abort', () => {
          artifactCancelled()
          resolve(undefined)
        }, { once: true })
      })
    },
  })
  let control: Awaited<ReturnType<typeof startSupervisorControlServer>> | undefined
  let server: Awaited<ReturnType<typeof startPluginManagementRpcServer>> | undefined
  let first: OwnerAdapterClient | undefined
  let second: OwnerAdapterClient | undefined
  try {
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      mode: 'service',
      appId,
      profileId,
      phase: 'ready',
      pid: process.pid,
      processStartedAt: startedAt,
      instanceToken: token,
      createdAt: new Date().toISOString(),
      version: 'fixture',
      effectiveConfig: effectiveConfigFingerprint({ appId, profileId }),
    })
    control = await startSupervisorControlServer({ socketPath: paths.socket, token, stop: () => {} })
    server = await startPluginManagementRpcServer({
      homeDir,
      appId,
      profileId,
      configPath: path.join(homeDir, 'config.json'),
      generation,
      processStartedAt: startedAt,
      service: {} as PluginManagementService,
      ownerAdapter: async operation => await dispatchOwnerAdapterRpcOperation(sessions, operation),
    })
    const lost = vi.fn()
    first = await OwnerAdapterClient.connect({ homeDir, appId, profileId, onLost: lost })
    second = await OwnerAdapterClient.connect({ homeDir, appId, profileId, onLost: lost })
    expect(first.snapshot).toEqual(snapshot)
    expect(second.snapshot).toEqual(snapshot)
    expect(first.rendererId).not.toBe(second.rendererId)
    const handle = async (command: { payload: unknown }) => ({ ok: true as const, value: command.payload })
    expect(await first.modelServicesRead()).toEqual({ status: 'rejected', code: 'unavailable' })
    expect(await first.admit(handle)).toBe(true)
    expect(await second.admit(handle)).toBe(true)
    expect(await first.modelServicesRead()).toEqual({ status: 'ok', revision: 'owner-revision', services: [] })
    await expect(first.documentBinding({ operation: 'replace' })).resolves.toEqual({
      status: 'unavailable',
      code: 'host-unavailable',
      diagnostic: 'owner document write result is unknown; reload before retrying',
      recoverable: false,
    })
    expect(documentWrites).toHaveBeenCalledOnce()
    await expect(first.documentBinding({ operation: 'load' })).resolves.toEqual({
      status: 'loaded',
      snapshot: { revision: 1 },
    })
    const artifact = (requestId: string) => ({
      kind: 'preview',
      requestId,
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
    })
    expect(await first.artifact(artifact('preview-one'), new AbortController().signal)).toEqual({ readme: 'fixture' })
    const cancellation = new AbortController()
    const pendingArtifact = first.artifact(artifact('preview-two'), cancellation.signal)
    await vi.waitFor(() => expect(artifactStarted).toHaveBeenCalledOnce())
    cancellation.abort()
    await expect(pendingArtifact).rejects.toThrow()
    await vi.waitFor(() => expect(artifactCancelled).toHaveBeenCalledOnce())
    const reservation = sessions.reserve()
    expect(reservation.peers).toHaveLength(2)
    expect(reservation.release()).toBe(true)

    await first.close()
    expect(await requestSupervisorPing(paths.socket, token)).toBe(true)
    const remaining = sessions.reserve()
    expect(remaining.peers).toHaveLength(1)
    expect(remaining.release()).toBe(true)
    await server.close()
    server = undefined
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 5_000 })
  } finally {
    await first?.close()
    await second?.close()
    sessions.close()
    await server?.close()
    await control?.close()
    await rm(homeDir, { recursive: true, force: true })
  }
}, 30_000)
