import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'
import {
  configuredChannelManagementToolHandler,
  createConfiguredChannelConsumer,
} from '../packages/cli/src/cli/channel-consumer-composition.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'

it('configures Desktop-only logical preferences through the live local management endpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'logical-preference-rpc-'))
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  const configured = await createConfiguredChannelConsumer({
    service: undefined,
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    logicalOwnerOnly: true,
    native: () => undefined,
    report: () => {},
  })
  await configured.logicalOwner!.store.bindCommitBarrier(async () => {})
  const server = await startPluginManagementRpcServer({
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    configPath,
    generation: 'fixture-launch',
    processStartedAt: (await processStartIdentity(process.pid))!,
    service: {} as PluginManagementService,
    ...configuredChannelManagementToolHandler(configured.tools),
  })
  vi.stubEnv('CORDISX_HOME', root)
  vi.stubEnv('CODEX_THREAD_ID', '')
  const output: string[] = []
  const call = async (operation: string, input: object) => {
    await runConfiguredChannelCommand([operation, '--input', JSON.stringify(input)], line => output.push(line))
    return JSON.parse(output.pop()!)
  }
  try {
    expect(await call('logical-status', { sessionId: 'source' }))
      .toEqual({ status: 'ok', operations: [], recoveryReady: true })
    expect(await call('logical-chain', { sessionId: 'source' })).toEqual({ status: 'ok', links: [] })
    expect(await configured.tools.callLocal('logical-chain', { sessionId: 'source' }, { agent: true }))
      .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
    await expect(call('logical-mode-default-set', { mode: 'fresh', expectedRevision: 0 }))
      .rejects.toThrow('CHANNEL_OPERATION_REJECTED')
    expect(JSON.parse(output.pop()!)).toMatchObject({ status: 'rejected' })
    expect(await call('logical-mode-default-set', { mode: 'fork', expectedRevision: 0 }))
      .toMatchObject({ status: 'ok', preference: { mode: 'fork' } })
    const choice = await call('logical-mode-conversation', { sessionId: 'source' })
    expect(
      await call('logical-mode-conversation-set', {
        sessionId: 'source',
        mode: 'linked',
        expectedRevision: 0,
        expectedConversationId: choice.conversationId,
      }),
    )
      .toMatchObject({ status: 'ok', preference: { mode: 'linked' }, revision: 1 })
    expect(await call('logical-mode-conversation', { sessionId: 'source' }))
      .toMatchObject({ status: 'ok', preference: { mode: 'linked' }, revision: 1 })
    await channelLogicalTransactionStore(configured.logicalOwner!.store).mutate(state => {
      const source = { hostId: 'local', appId: 'codex', profileId: 'default', sessionId: 'source' }
      state.logicalContinuations!.intents.operation = {
        request: {
          contract: 'cordisx.conversation-continuation-request/v1',
          operationId: 'operation',
          logicalConversationId: 'conversation',
          source,
          expectedRevision: 0,
          target: { providerId: 'openai', model: 'model' },
          mode: 'fresh',
          historyConsent: 'none',
        },
        actor: { principal: 'desktop:fixture', scope: 'desktop:codex:default' },
        evidence: {
          sourceHistoryVersion: 'version',
          handoff: 'none',
          sourceConfiguration: {
            providerId: 'openai',
            model: 'model',
            cwd: '/fixture',
            serviceTier: null,
            approvalsReviewer: 'user',
            sandbox: { type: 'readOnly' },
            permissionProfile: null,
            execution: { workMode: 'default', approval: 'on-request', effort: 'low', execution: 'read-only' },
          },
        },
        state: 'unknown',
        destination: { ...source, sessionId: 'orphan' },
      }
    })
    configured.logicalOwner!.bindRecoveryProbe(async sources => sources.join(',') === 'source,orphan')
    const recovery = { sessionId: 'source', operationId: 'operation', confirmOrphanPossible: true }
    expect(await configured.tools.callLocal('logical-abandon', recovery, { agent: true }))
      .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
    await expect(call('logical-abandon', { ...recovery, confirmOrphanPossible: false })).rejects.toThrow(
      'CHANNEL_OPERATION_REJECTED',
    )
    expect(JSON.parse(output.pop()!)).toMatchObject({ status: 'rejected', code: 'INVALID_REQUEST' })
    expect(await call('logical-abandon', recovery)).toEqual({ status: 'ok', orphanPossible: true })
    expect(await call('logical-status', { sessionId: 'source', operationId: 'operation' }))
      .toMatchObject({
        operations: [{ state: 'rejected', orphanDestination: 'orphan', code: 'USER_ABANDONED_UNKNOWN' }],
      })
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    await configured.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
