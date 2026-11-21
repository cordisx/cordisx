import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createManagerRendererGatewayAuthenticator,
  managerRendererGatewayPaths,
  type ManagerRendererGatewayProof,
} from '../packages/cli/src/cli/manager-renderer-gateway.js'
import {
  type ManagerRendererChannel,
  type ManagerRendererInvocation,
  ManagerRendererSessions,
} from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { startSupervisorControlServer } from '../packages/cli/src/cli/supervisor-control.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { attachmentHomeDigest } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  effectiveConfigFingerprint,
  processStartIdentity,
  type SupervisorState,
  writeSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'

const secret = () => randomBytes(32).toString('hex')

function proof(): ManagerRendererGatewayProof {
  return { pid: 42, processStartedAt: 'fixture start', instanceToken: secret() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('authenticates the existing control socket, fences profile and generation, and rejects replaced state', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-owner-fixture-'))
  const profileId = 'fixture'
  const paths = managerRendererGatewayPaths(homeDir, profileId)
  const processStartedAt = await processStartIdentity(process.pid)
  expect(processStartedAt).toBeDefined()
  const state: SupervisorState = {
    schemaVersion: 1,
    appId: 'manager',
    profileId,
    phase: 'ready',
    pid: process.pid,
    processStartedAt: processStartedAt!,
    instanceToken: secret(),
    createdAt: new Date().toISOString(),
    version: 'fixture',
    effectiveConfig: effectiveConfigFingerprint({ appId: 'codex', generation: 'owner-1' }),
  }
  const gateway: ManagerRendererGatewayProof = {
    pid: state.pid,
    processStartedAt: state.processStartedAt,
    instanceToken: state.instanceToken,
  }
  await mkdir(path.dirname(paths.socket), { recursive: true, mode: 0o700 })
  const server = await startSupervisorControlServer({
    socketPath: paths.socket,
    token: state.instanceToken,
    stop: () => {},
  })
  try {
    await writeSupervisorState(paths, state)
    const authenticate = createManagerRendererGatewayAuthenticator({
      homeDir,
      profileId,
      ownerAppId: 'codex',
      ownerGeneration: 'owner-1',
    })
    expect(await authenticate(gateway)).toBe(true)
    expect(await authenticate({ ...gateway, pid: gateway.pid + 1 })).toBe(false)
    expect(await authenticate({ ...gateway, processStartedAt: 'other start' })).toBe(false)
    expect(await authenticate({ ...gateway, instanceToken: secret() })).toBe(false)
    expect(await authenticate({ ...gateway, extra: 'unexpected' } as ManagerRendererGatewayProof)).toBe(false)
    expect(
      await createManagerRendererGatewayAuthenticator({
        homeDir,
        profileId,
        ownerAppId: 'codex',
        ownerGeneration: 'other-generation',
      })(gateway),
    ).toBe(false)
    const replacementDuringPing = createManagerRendererGatewayAuthenticator({
      homeDir,
      profileId,
      ownerAppId: 'codex',
      ownerGeneration: 'owner-1',
      ping: async () => {
        await writeSupervisorState(paths, { ...state, instanceToken: secret() })
        return true
      },
    })
    expect(await replacementDuringPing(gateway)).toBe(false)
    await writeSupervisorState(paths, state)
    const signals: AbortSignal[] = []
    const authority = new ManagerRendererSessions({
      profileId,
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      authenticateGateway: authenticate,
      monitorIntervalMs: 100,
      channels: new Map([['fixture-only', {
        prepare: (_payload, context) => ({
          mode: 'read',
          dispatch: async () => {
            signals.push(context.signal)
            return 'fixture'
          },
        }),
      }]]),
    })
    try {
      const browserSessionId = secret()
      const handle = (await authority.open(gateway, browserSessionId))!
      expect(handle).toBeDefined()
      expect(await authority.call({ gateway, browserSessionId, handle }, 'fixture-only', {})).toEqual({
        status: 'ok',
        value: 'fixture',
      })
      await server.close()
      expect(await authenticate(gateway)).toBe(false)
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true), { timeout: 2_000 })
    } finally {
      authority.dispose()
    }
  } finally {
    await server.close().catch(() => undefined)
    await rm(homeDir, { recursive: true, force: true })
  }
})

it('does not grant any channel by default and binds handles to one browser and gateway', async () => {
  const gateway = proof()
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'g',
    ownerCurrent: () => true,
    authenticateGateway: async candidate => candidate.instanceToken === gateway.instanceToken,
  })
  try {
    const browserSessionId = secret()
    const handle = await authority.open(gateway, browserSessionId)
    expect(handle).toBeDefined()
    const invocation: ManagerRendererInvocation = { gateway, browserSessionId, handle: handle! }
    expect(await authority.call(invocation, '__cordisxPluginManagementRequestV1', {})).toEqual({
      status: 'unavailable',
    })
    expect(await authority.call({ ...invocation, browserSessionId: secret() }, 'unknown', {})).toEqual({
      status: 'unavailable',
    })
    expect(await authority.close({ ...invocation, gateway: { ...gateway, instanceToken: secret() } })).toBe(false)
    expect(await authority.close({ ...invocation, handle: { ...handle!, grant: secret() } })).toBe(false)
    expect(await authority.close(invocation)).toBe(true)
    expect(await authority.open(gateway, browserSessionId)).toBeUndefined()
  } finally {
    authority.dispose()
  }
})

it('tombstones browser revocation even while session authentication is pending', async () => {
  const gateway = proof()
  const waiting = deferred<boolean>()
  const authenticate = vi.fn().mockImplementationOnce(() => waiting.promise).mockResolvedValue(true)
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'g',
    ownerCurrent: () => true,
    authenticateGateway: authenticate,
  })
  try {
    const browserSessionId = secret()
    const opening = authority.open(gateway, browserSessionId)
    expect(await authority.revoke(gateway, browserSessionId)).toBe(true)
    waiting.resolve(true)
    expect(await opening).toBeUndefined()
  } finally {
    authority.dispose()
  }
})

it.each(['read', 'write'] as const)('fences an in-flight %s when the browser session closes', async mode => {
  const gateway = proof()
  const started = deferred<AbortSignal>()
  const finish = deferred<string>()
  const channel: ManagerRendererChannel = {
    prepare: (payload, context) => {
      if (payload === 'other browser') return { mode: 'read', dispatch: async () => 'still active' }
      if (payload !== 'allowed fixture') throw new Error('rejected')
      return {
        mode,
        dispatch: async () => {
          started.resolve(context.signal)
          return await finish.promise
        },
      }
    },
  }
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'g',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([['fixture-only', channel]]),
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    const invocation = { gateway, browserSessionId, handle }
    const otherBrowserSessionId = secret()
    const otherHandle = (await authority.open(gateway, otherBrowserSessionId))!
    const other = { gateway, browserSessionId: otherBrowserSessionId, handle: otherHandle }
    expect(
      await authority.call({ ...invocation, browserSessionId: otherBrowserSessionId }, 'fixture-only', 'other browser'),
    )
      .toEqual({ status: 'unavailable' })
    expect(await authority.call({ ...invocation, handle: otherHandle }, 'fixture-only', 'other browser')).toEqual({
      status: 'unavailable',
    })
    const pending = authority.call(invocation, 'fixture-only', 'allowed fixture')
    const signal = await started.promise
    expect(await authority.close(invocation)).toBe(true)
    expect(signal.aborted).toBe(true)
    finish.resolve('private fixture data')
    expect(await pending).toEqual({ status: mode === 'write' ? 'unknown' : 'unavailable' })
    expect(await authority.call(invocation, 'fixture-only', 'allowed fixture')).toEqual({ status: 'unavailable' })
    expect(await authority.call(other, 'fixture-only', 'other browser')).toEqual({
      status: 'ok',
      value: 'still active',
    })
  } finally {
    finish.resolve('cleanup')
    authority.dispose()
  }
})

it('monitors gateway loss and aborts all its browser sessions without waiting for a request', async () => {
  const gateway = proof()
  let healthy = true
  const signals: AbortSignal[] = []
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'g',
    ownerCurrent: () => true,
    authenticateGateway: async () => healthy,
    monitorIntervalMs: 100,
    channels: new Map([['fixture-only', {
      prepare: (_payload, context) => ({
        mode: 'read',
        dispatch: async () => {
          signals.push(context.signal)
          return 'ok'
        },
      }),
    }]]),
  })
  try {
    for (let index = 0; index < 2; index++) {
      const browserSessionId = secret()
      const handle = (await authority.open(gateway, browserSessionId))!
      expect(await authority.call({ gateway, browserSessionId, handle }, 'fixture-only', {})).toEqual({
        status: 'ok',
        value: 'ok',
      })
    }
    healthy = false
    await vi.waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true), { timeout: 2_000 })
  } finally {
    authority.dispose()
  }
})

it('routes an authenticated session over the real production owner RPC to its real read-only management service', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-renderer-rpc-'))
  const configPath = path.join(homeDir, 'config.json')
  const appId = 'codex'
  const profileId = 'default'
  const generation = 'owner-1'
  const paths = managerRendererGatewayPaths(homeDir, profileId)
  const processStartedAt = await processStartIdentity(process.pid)
  expect(processStartedAt).toBeDefined()
  const gateway = { pid: process.pid, processStartedAt: processStartedAt!, instanceToken: secret() }
  const state: SupervisorState = {
    schemaVersion: 1,
    appId: 'manager',
    profileId,
    phase: 'ready',
    ...gateway,
    createdAt: new Date().toISOString(),
    version: 'fixture',
    effectiveConfig: effectiveConfigFingerprint({ appId, generation }),
  }
  await mkdir(path.dirname(paths.socket), { recursive: true, mode: 0o700 })
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  await writeSupervisorState(paths, state)
  const supervisor = await startSupervisorControlServer({
    socketPath: paths.socket,
    token: gateway.instanceToken,
    stop: () => {},
  })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId,
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: {
      stage: async () => undefined,
      commit: async () => undefined,
      abort: async () => undefined,
      reload: async () => undefined,
    },
  })
  const participants = new ServiceRendererParticipants({
    homeDigest: attachmentHomeDigest(homeDir),
    ownerAppId: appId,
    profileId,
    generation,
  })
  participants.bind({
    snapshot: () => ({ active: { plugins: [] }, registryEpoch: 0 }) as never,
    attach: async () => {},
  })
  let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
  try {
    composition = await openProductionPluginManagementComposition({
      configPath,
      homeDir,
      appId,
      profileId,
      runtimeGeneration: generation,
      token: secret(),
      coordinator,
      rendererParticipant: participants.participant,
      rendererParticipants: participants,
      processStartedAt: processStartedAt!,
    })
    const rpcPaths = pluginManagementRpcPaths(homeDir, appId, profileId)
    const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
    const browserSessionId = secret()
    const open = { kind: 'manager-renderer' as const, action: 'open' as const, gateway, browserSessionId }
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...open, gateway: { ...gateway, pid: 999999 } }))
      .toEqual({ status: 'unavailable' })
    await expect(requestPluginManagementRpc(rpcPaths, endpoint, { ...open, unexpected: 'ignored?' } as typeof open))
      .rejects.toThrow('MANAGER_RENDERER_INVALID')
    const opened = await requestPluginManagementRpc(rpcPaths, endpoint, open) as {
      status: string
      handle: { rendererId: string; ownerGeneration: string; grant: string }
    }
    expect(opened).toMatchObject({ status: 'ok', handle: { ownerGeneration: generation } })
    const query = JSON.stringify({
      version: 1,
      requestId: 'browser-query-1',
      token: 'renderer-controlled-and-not-authority',
      profileId,
      operation: { kind: 'query' },
    })
    const call = {
      kind: 'manager-renderer' as const,
      action: 'call' as const,
      gateway,
      browserSessionId,
      handle: opened.handle,
      channel: 'plugin-management',
      payload: query,
    }
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, call)).toMatchObject({
      status: 'ok',
      value: {
        requestId: 'browser-query-1',
        ok: true,
        value: { profileId, runtime: { runtimeGeneration: generation } },
      },
    })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...call, browserSessionId: secret() }))
      .toEqual({ status: 'unavailable' })
    expect(
      await requestPluginManagementRpc(rpcPaths, endpoint, {
        ...call,
        payload: JSON.stringify({ ...JSON.parse(query), profileId: 'another-profile' }),
      }),
    ).toEqual({ status: 'unavailable' })
    for (
      const operation of [{ kind: 'execute', request: { kind: 'plugin-disable', pluginId: 'fixture' } }, {
        kind: 'migrate-legacy-sources',
        input: { sources: [] },
      }]
    ) {
      expect(
        await requestPluginManagementRpc(rpcPaths, endpoint, {
          ...call,
          payload: JSON.stringify({ ...JSON.parse(query), operation }),
        }),
      ).toEqual({ status: 'unavailable' })
    }
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...call, channel: 'plugin-configuration' }))
      .toEqual({ status: 'unavailable' })
    const fencing = composition.fenceManagers!()
    void fencing.catch(() => {})
    const common = { kind: 'manager-renderer' as const, gateway, browserSessionId, handle: opened.handle }
    const polled = await requestPluginManagementRpc(rpcPaths, endpoint, {
      ...common,
      action: 'poll',
      timeoutMs: 5_000,
    }) as {
      status: string
      value: { command: { id: string; sequence: number; method: string; payload: { fenceId: string } } }
    }
    expect(polled.value.command.method).toBe('quiesce')
    expect(
      await requestPluginManagementRpc(rpcPaths, endpoint, {
        ...common,
        action: 'acknowledge',
        receipt: {
          id: polled.value.command.id,
          sequence: polled.value.command.sequence,
          ok: true,
          value: {
            fenceId: polled.value.command.payload.fenceId,
            rendererId: opened.handle.rendererId,
            ownerGeneration: generation,
            quiesced: true,
          },
        },
      }),
    ).toEqual({ status: 'ok', value: { accepted: true } })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'close' }))
      .toEqual({ status: 'ok' })
    const fence = await fencing
    const other = { ...open, browserSessionId: secret() }
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, other)).toEqual({ status: 'unavailable' })
    expect(fence.release()).toBe(true)
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, other)).toMatchObject({ status: 'ok' })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...other, action: 'revoke' }))
      .toEqual({ status: 'ok' })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...open, action: 'revoke' }))
      .toEqual({ status: 'ok' })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, call)).toEqual({ status: 'unavailable' })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, open)).toEqual({ status: 'unavailable' })
    await composition.close()
    await expect(requestPluginManagementRpc(rpcPaths, endpoint, call)).rejects.toThrow()
  } finally {
    await composition?.close()
    participants.close()
    await supervisor.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})

it('coordinates sidecar Channel writes with the service renderer fleet before dispatch', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-channel-fence-'))
  const configPath = path.join(homeDir, 'config.json')
  const appId = 'codex', profileId = 'default', generation = 'owner-1'
  const processStartedAt = (await processStartIdentity(process.pid))!
  const gateway = { pid: process.pid, processStartedAt, instanceToken: secret() }
  const paths = managerRendererGatewayPaths(homeDir, profileId)
  await mkdir(path.dirname(paths.socket), { recursive: true, mode: 0o700 })
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  await writeSupervisorState(paths, {
    schemaVersion: 1,
    appId: 'manager',
    profileId,
    phase: 'ready',
    ...gateway,
    createdAt: new Date().toISOString(),
    version: 'fixture',
    effectiveConfig: effectiveConfigFingerprint({ appId, generation }),
  })
  const supervisor = await startSupervisorControlServer({
    socketPath: paths.socket,
    token: gateway.instanceToken,
    stop: () => {},
  })
  const scope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: appId, profileId, generation }
  const lifecycle = new ServiceRendererLifecycle({ scope, projectMutation: async () => undefined })
  lifecycle.initialize({
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId,
    runtimeGeneration: generation,
    revision: 0,
    lastGoodRevision: 0,
    plugins: [],
  })
  const participants = new ServiceRendererParticipants(scope)
  participants.bind(lifecycle)
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId,
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: lifecycle,
  })
  const finish = deferred<{ status: string }>()
  const handle = vi.fn(async () => await finish.promise)
  let composition: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
  try {
    composition = await openProductionPluginManagementComposition({
      mode: 'service',
      configPath,
      homeDir,
      appId,
      profileId,
      runtimeGeneration: generation,
      token: secret(),
      coordinator,
      rendererParticipant: participants.participant,
      rendererParticipants: participants,
      rendererLifecycle: lifecycle,
      managerChannelCredentials: handle,
      processStartedAt,
    })
    const rpcPaths = pluginManagementRpcPaths(homeDir, appId, profileId)
    const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
    const browserSessionId = secret()
    const open = { kind: 'manager-renderer' as const, action: 'open' as const, gateway, browserSessionId }
    const opened = await requestPluginManagementRpc(rpcPaths, endpoint, open) as {
      status: string
      handle: { rendererId: string; ownerGeneration: string; grant: string }
    }
    expect(opened.status).toBe('ok')
    const mutation = {
      kind: 'manager-channel-credentials' as const,
      action: 'set-enabled' as const,
      sessionId: browserSessionId,
      serviceGeneration: 'service-1',
      expectedRevision: 0,
      account: { adapterId: 'feishu' as const, accountId: 'cli_fixture', tenantId: 'tenant' },
      enabled: true,
    }
    // A renderer cannot dispose itself while waiting for its own result.
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, mutation)).toEqual({
      status: 'unavailable',
      code: 'PROFILE_COORDINATION_UNAVAILABLE',
    })
    expect(handle).not.toHaveBeenCalled()

    const changing = requestPluginManagementRpc(rpcPaths, endpoint, { ...mutation, sessionId: secret() })
    const common = { kind: 'manager-renderer' as const, gateway, browserSessionId, handle: opened.handle }
    const polled = await requestPluginManagementRpc(rpcPaths, endpoint, {
      ...common,
      action: 'poll',
      timeoutMs: 5_000,
    }) as {
      value: { command: { id: string; sequence: number; method: string; payload: { fenceId: string } } }
    }
    expect(polled.value.command.method).toBe('quiesce')
    expect(handle).not.toHaveBeenCalled()
    const other = { ...open, browserSessionId: secret() }
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, other)).toEqual({ status: 'unavailable' })
    expect(() => lifecycle.prepare('blocked')).toThrow('service renderer fence is active')
    expect(
      await requestPluginManagementRpc(rpcPaths, endpoint, {
        ...common,
        action: 'acknowledge',
        receipt: {
          id: polled.value.command.id,
          sequence: polled.value.command.sequence,
          ok: true,
          value: {
            fenceId: polled.value.command.payload.fenceId,
            rendererId: opened.handle.rendererId,
            ownerGeneration: generation,
            quiesced: true,
          },
        },
      }),
    ).toEqual({ status: 'ok', value: { accepted: true } })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...common, action: 'close' }))
      .toEqual({ status: 'ok' })
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce())
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, other)).toEqual({ status: 'unavailable' })
    finish.resolve({ status: 'applied' })
    expect(await changing).toEqual({ status: 'applied' })
    const reopened = await requestPluginManagementRpc(rpcPaths, endpoint, other) as { status: string }
    expect(reopened.status).toBe('ok')
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...other, action: 'revoke' }))
      .toEqual({ status: 'ok' })

    handle.mockResolvedValueOnce({ status: 'unknown' })
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...mutation, sessionId: secret() })).toEqual({
      status: 'unknown',
      code: 'RESULT_UNKNOWN',
    })
    expect(() => lifecycle.snapshot()).toThrow('service renderer lifecycle is unavailable')
    expect(await requestPluginManagementRpc(rpcPaths, endpoint, { ...open, browserSessionId: secret() }))
      .toEqual({ status: 'unavailable' })
  } finally {
    finish.resolve({ status: 'unknown' })
    await composition?.close()
    participants.close()
    await lifecycle.close()
    await supervisor.close()
    await rm(homeDir, { recursive: true, force: true })
  }
}, 30_000)
