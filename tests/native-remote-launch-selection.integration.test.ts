import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import { prepareNativeSubmissionBootstrap } from '../packages/cli/src/launcher/native-submission-composition.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import { bundle } from './fixtures/native-app-bundle.js'

it.skipIf(process.platform !== 'darwin')(
  'waits for a service-owned model before accepting its launch selection',
  async () => {
    const roots: string[] = []
    const ownerHome = await mkdtemp(path.join(os.tmpdir(), 'cx-remote-launch-owner-'))
    roots.push(ownerHome)
    const app = await bundle(roots)
    const codexHome = path.join(app.contents, 'codex-home')
    await mkdir(codexHome)
    await writeFile(path.join(ownerHome, 'config.json'), JSON.stringify(createDefaultHomeConfig()))
    const source = { homeDir: ownerHome, profileId: 'client-profile', appIds: ['codex'], selectedAppId: 'codex' }
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const list = vi.fn(async () => {
      await gate
      return {
        kind: 'list' as const,
        providers: [{
          providerId: 'owner-provider',
          title: 'Owner provider',
          managed: true,
          models: [{ id: 'owner-model', label: 'Owner model' }],
        }],
      }
    })
    const server = await startPluginManagementRpcServer({
      homeDir: ownerHome,
      appId: 'codex',
      profileId: 'client-profile',
      configPath: path.join(ownerHome, 'config.json'),
      generation: 'owner-generation',
      processStartedAt: (await processStartIdentity(process.pid))!,
      service: {} as PluginManagementService,
      terminalProvider: list,
    })
    let bootstrap: Awaited<ReturnType<typeof prepareNativeSubmissionBootstrap>> | undefined
    try {
      bootstrap = await prepareNativeSubmissionBootstrap(app.executable, {
        cacheDirectory: path.join(ownerHome, 'cache'),
        remoteTerminalProvider: source,
      })
      let settled = false
      const completed = bootstrap.complete(
        { nativeProviderIds: [], prepareNativeConnection: vi.fn() },
        codexHome,
        {
          nativeModelDiscovery: false,
          remoteTerminalProvider: source,
          nativeClientScope: { homeDir: ownerHome, profileId: 'client-profile' },
          defaultProviderId: 'owner-provider',
          defaultModelId: 'owner-model',
        },
      ).then(result => {
        settled = true
        return result
      }, error => {
        settled = true
        throw error
      })
      // Capture rejection while deliberately keeping the owner response pending.
      void completed.catch(() => undefined)
      await vi.waitFor(() => expect(list).toHaveBeenCalled())
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(settled).toBe(false)
      release()
      const composition = await completed
      try {
        const result = await composition.terminalProvider({ kind: 'list' })
        expect(result).toMatchObject({
          kind: 'list',
          providers: [{ providerId: 'owner-provider', models: [{ id: 'owner-model' }] }],
        })
        const status = await composition.codex!('integration_status', { app: 'codex' }) as {
          status: string
          value: { problems: { area: string }[] }
        }
        expect(status.status).toBe('ok')
        expect(status.value.problems.some(problem => problem.area === 'config')).toBe(false)

        const input = { operationId: 'fixture-operation', prompt: 'fixture', target: { type: 'projectless' } }
        const threadId = 'fixture-source'
        const key = createHash('sha256').update(`${threadId}\0${input.operationId}`).digest('hex')
        const fingerprint = createHash('sha256').update(JSON.stringify([threadId, input])).digest('hex')
        const directory = path.join(ownerHome, 'apps/codex/profiles/client-profile/agent-task-intents')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const receipt = { status: 'created', native: { threadId: 'fixture-created' } }
        await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ fingerprint, result: receipt }))
        expect(
          await composition.codex!('create', input, {
            'openai/threadId': threadId,
            'openai/turnId': 'fixture-turn',
            'openai/toolCallId': 'fixture-call',
          }),
        ).toEqual(receipt)
      } finally {
        await composition.close()
      }
    } finally {
      release()
      await bootstrap?.close()
      await server.close()
      for (const root of roots) await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
