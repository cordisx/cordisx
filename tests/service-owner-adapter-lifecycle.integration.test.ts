import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { OwnerAdapterCdpClient } from '../packages/cli/src/cli/owner-adapter-cdp-client.js'
import { OwnerAdapterClient } from '../packages/cli/src/cli/owner-adapter-client.js'
import { createOwnerAdapterManagement } from '../packages/cli/src/cli/owner-adapter-management.js'
import { loadOwnerAdapterMutation } from '../packages/cli/src/cli/owner-adapter-mutation.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import type { CdpSharedAdmission } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { loadStagedPluginPackage, removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import type { CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { assertOwnedServicesStopped, captureOwnedService } from './fixtures/owned-service-cleanup.js'
import { decision, FormalRuntime, localPackage, request } from './suites/plugin-lifecycle.fixtures.js'

const run = promisify(execFile)
const cli = path.resolve('packages/cli/dist/src/cli.js')

it('synchronizes a native adapter with a production service plugin transaction', async () => {
  const root = await mkdtemp('/tmp/cx-service-adapter-lifecycle-')
  const homeDir = path.join(root, 'home')
  const profileId = 'default'
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CORDISX_')),
  )
  Object.assign(env, {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex'),
    CORDISX_HOME: homeDir,
    CORDISX_MODEL_API_PORT: '0',
    CORDISX_WEB_ENABLED: '0',
  })
  const command = async (action: string) =>
    JSON.parse(
      (await run(
        process.execPath,
        [cli, action, '--mode', 'service', '--json'],
        { cwd: root, env, timeout: 60_000 },
      )).stdout,
    )
  const owners: Awaited<ReturnType<typeof captureOwnedService>>[] = []
  let requested = false
  let client: OwnerAdapterClient | undefined
  let manager: ReturnType<typeof createOwnerAdapterManagement> | undefined
  try {
    await mkdir(homeDir)
    await writeFile(path.join(homeDir, 'config.json'), JSON.stringify(createDefaultHomeConfig()))
    const seed = new PluginLifecycleCoordinator({
      homeDir,
      profileId,
      runtimeGeneration: 'seed',
      permissionPolicies: [],
      runtime: new FormalRuntime(),
      headless: true,
    })
    const sourceDirectory = await localPackage({ root, id: 'native-fixture' })
    const scoped = (...args: Parameters<typeof request>) => ({ ...request(...args), profileId })
    const planned = await seed.handle(scoped({ kind: 'inspect-local', sourceDirectory }, 0, 'seed'))
    const installed = await seed.handle(scoped(
      {
        kind: 'install',
        candidateId: planned.candidateId!,
        authorizationDecision: decision(planned.authorizationPlan!),
      },
      0,
      'seed',
    ))
    expect(installed).toMatchObject({ outcome: 'applied', revision: 1 })

    requested = true
    const ready = await command('start')
    owners.push(await captureOwnedService(homeDir))
    client = await OwnerAdapterClient.connect({ homeDir, appId: 'codex', profileId, onLost: () => {} })
    let snapshot = structuredClone(client.snapshot)
    const installedPlugin = snapshot.active.plugins.find(plugin => plugin.id === 'native-fixture')!
    const stagedPackage = await loadStagedPluginPackage(homeDir, installedPlugin.digest)
    const documentToken = (moduleGeneration: string) =>
      issueOwnerDocumentPrincipalToken(client!.documentSecret, {
        profileId,
        generation: client!.snapshot.active.runtimeGeneration,
        moduleGeneration,
        identity: { pluginId: installedPlugin.id, source: stagedPackage.identitySource },
      })
    const document = (token: string, operation: 'load' | 'replace') => ({
      version: 1,
      requestId: `doc-${operation}`,
      token,
      operation,
      documentId: 'fixture-state',
      ...(operation === 'replace' ? { expectedRevision: 0, schemaVersion: 1, value: { shared: true } } : {}),
    })
    const oldToken = documentToken(installedPlugin.moduleGeneration)
    expect(await client.document(document(oldToken, 'load'))).toEqual({ status: 'missing', revision: 0 })
    await expect(client.document(document(oldToken, 'replace'))).rejects.toThrow('adapter-owner-unavailable')
    let staged: PluginRuntimeMutation | undefined
    const methods: string[] = []
    const admission = {
      readSnapshot: async () => snapshot,
      prepareBrowserGraph: async () => {},
      stage: async (mutation: PluginRuntimeMutation) => {
        staged = mutation
        return {
          transactionId: mutation.transactionId,
          transactionEpoch: mutation.transactionEpoch,
          expectedRegistryEpoch: mutation.expectedRegistryEpoch,
          afterRegistryEpoch: mutation.afterRegistryEpoch,
          observation: mutation.candidate,
          affectedPluginIds: mutation.affectedPluginIds,
        }
      },
      publish: async () => ({
        transactionId: staged!.transactionId,
        transactionEpoch: staged!.transactionEpoch,
        registryEpoch: staged!.afterRegistryEpoch,
        active: staged!.candidate,
      }),
      complete: async () => ({
        transactionId: staged!.transactionId,
        transactionEpoch: staged!.transactionEpoch,
        registryEpoch: staged!.afterRegistryEpoch,
        active: staged!.candidate,
        disposedAfter: staged!.previous,
      }),
      finalize: async () => {
        const { transactionId: _transactionId, ...rest } = staged!.candidate
        void _transactionId
        snapshot = {
          active: { ...rest, recordKind: 'active', lastGoodRevision: rest.revision } as CordisXPluginActivationRecordV1,
          registryEpoch: staged!.afterRegistryEpoch!,
        }
      },
      release: () => {},
    } as unknown as CdpSharedAdmission
    const native = new OwnerAdapterCdpClient({
      cdp: { beginSharedAdmission: () => admission, terminal: () => {} },
      loadMutation: async value =>
        await loadOwnerAdapterMutation({
          value,
          homeDir,
          profileId,
          generation: client!.snapshot.active.runtimeGeneration,
          rendererId: client!.rendererId,
        }),
    })
    expect(
      await client.admit(async frame => {
        methods.push(frame.method)
        return await native.handle(frame)
      }),
    ).toBe(true)
    expect(await client.document(document(oldToken, 'replace'))).toMatchObject({
      status: 'accepted',
      snapshot: { revision: 1, value: { shared: true } },
    })
    manager = createOwnerAdapterManagement(client)
    const revisions: number[] = []
    const unsubscribe = manager.subscribe(value => revisions.push(value.activationRevision))
    const generation = client.snapshot.active.runtimeGeneration
    const nativePlan = await client.lifecycle({
      request: scoped(
        { kind: 'disable', pluginId: 'native-fixture', impactToken: '' },
        snapshot.active.revision,
        generation,
      ),
    }) as any
    expect(nativePlan.outcome).toBe('planned')
    const nativeResult = await client.lifecycle({
      request: scoped(
        {
          kind: 'disable',
          pluginId: 'native-fixture',
          impactToken: nativePlan.impactToken,
        },
        snapshot.active.revision,
        generation,
      ),
    }) as any
    expect(nativeResult.outcome, JSON.stringify(nativeResult.error ?? {})).toBe('applied')
    expect(snapshot.active.plugins.find(plugin => plugin.id === 'native-fixture')?.enabled).toBe(false)
    expect(await client.document(document(oldToken, 'load'))).toMatchObject({ status: 'unavailable' })
    const plan = await manager.plan({ kind: 'plugin-enable', pluginId: 'native-fixture' }) as any
    expect(plan.status).toBe('planned')
    const result = await manager.execute(plan.executionRequest, plan.snapshot.revision) as any
    expect(result.status, JSON.stringify(result.error ?? result.lifecycle?.error ?? {})).toBe('applied')
    expect(snapshot.active.plugins.find(plugin => plugin.id === 'native-fixture')?.enabled).toBe(true)
    const newGeneration = snapshot.active.plugins.find(plugin => plugin.id === 'native-fixture')!.moduleGeneration
    expect(newGeneration).not.toBe(installedPlugin.moduleGeneration)
    expect(await client.document(document(oldToken, 'load'))).toMatchObject({ status: 'unavailable' })
    expect(await client.document(document(documentToken(newGeneration), 'load'))).toMatchObject({
      status: 'loaded',
      snapshot: { revision: 1, value: { shared: true } },
    })
    expect(revisions).toContain(snapshot.active.revision)
    unsubscribe()
    expect(methods).toEqual([
      'synchronize',
      'prepare',
      'stage',
      'publish',
      'complete',
      'finalize',
      'prepare',
      'stage',
      'publish',
      'complete',
      'finalize',
    ])
    await client.close()
    expect(await command('status')).toMatchObject({ status: 'ready', pid: ready.pid })
    expect(await command('stop')).toMatchObject({ status: 'stopped' })
  } finally {
    manager?.close()
    await client?.close()
    if (owners.length > 0) await command('stop').catch(() => undefined)
    await assertOwnedServicesStopped(homeDir, owners, requested)
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
