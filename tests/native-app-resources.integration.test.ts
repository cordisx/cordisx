import { createPackage } from '@electron/asar'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import {
  createNativeSubmissionComposition,
  prepareNativeSubmissionBootstrap,
} from '../packages/cli/src/launcher/native-submission-composition.js'
import { readNativeSubmissionResources } from '../packages/cli/src/launcher/native-app-resources.js'
import { providerSyncCredentialEnvironmentKey } from '../packages/cli/src/launcher/provider-profile-sync-codex.js'
import { resources } from './fixtures/native-submission-structure.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function bundle(incompatible = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-app-'))
  roots.push(root)
  const contents = path.join(root, 'Fixture.app/Contents')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'webview/assets'), { recursive: true })
  await mkdir(path.join(contents, 'MacOS'), { recursive: true })
  await mkdir(path.join(contents, 'Resources'))
  const executable = path.join(contents, 'MacOS/Fixture')
  for (const file of [executable, path.join(contents, 'Resources/codex')]) {
    await writeFile(file, '#!/bin/sh\nexit 99\n')
    await chmod(file, 0o755)
  }
  await writeFile(
    path.join(contents, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>unknown-version</string><key>CFBundleVersion</key><string>unknown-build</string></dict></plist>',
  )
  for (const resource of resources()) {
    await writeFile(
      path.join(source, 'webview/assets', path.basename(resource.url)),
      incompatible ? 'export {}' : resource.source,
    )
  }
  await createPackage(source, path.join(contents, 'Resources/app.asar'))
  return { contents, executable }
}

it('reads the actual ASAR resource layout without relying on asset hash names', async () => {
  const f = await bundle()
  expect(readNativeSubmissionResources(f.contents).map(resource => resource.url).sort())
    .toEqual(resources().map(resource => resource.url).sort())
})

it.skipIf(process.platform !== 'darwin')(
  'creates and cleans the real composition for an unknown App identity without executing its binaries',
  async () => {
    const f = await bundle()
    const codexHome = path.join(f.contents, 'codex-home')
    await mkdir(codexHome)
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model = "deepseek-chat"',
        '[model_providers.deepseek]',
        'name = "DeepSeek"',
        'base_url = "https://api.deepseek.example/v1"',
        'env_key = "DEEPSEEK_API_KEY"',
      ].join('\n'),
    )
    const prepareNativeConnection = vi.fn()
    const values = new Map<string, string>()
    const keychain = {
      async read(service: string, account: string) {
        const value = values.get(`${service}/${account}`)
        if (!value) throw Error()
        return value
      },
      async status(service: string, account: string): Promise<'set' | 'unset'> {
        return values.has(`${service}/${account}`) ? 'set' : 'unset'
      },
      async upsert(service: string, account: string, value: string) {
        values.set(`${service}/${account}`, value)
      },
      async remove(service: string, account: string) {
        values.delete(`${service}/${account}`)
      },
    }
    await writeFile(path.join(codexHome, 'scoped.json'), JSON.stringify({ models: [{ slug: 'deepseek-chat' }] }))
    const composition = await createNativeSubmissionComposition(
      { nativeProviderIds: [], prepareNativeConnection },
      f.executable,
      codexHome,
      {
        configModelCatalogs: { deepseek: 'scoped.json' },
        managedCatalog: {
          homeDir: codexHome,
          profileId: 'fixture',
          keychain,
          capture: async () => 'fixture-managed-secret',
          fetcher: async () =>
            Response.json({
              object: 'list',
              data: [
                { object: 'model', id: 'deepseek-flash', owned_by: 'deepseek' },
                { object: 'model', id: 'unknown', owned_by: 'deepseek' },
              ],
            }),
        },
      },
    )
    try {
      expect(composition.installation.transforms).toHaveLength(2)
      expect(composition.environment.CORDISX_NATIVE_REAL_CODEX_PATH).toBe(
        await realpath(path.join(f.contents, 'Resources/codex')),
      )
      expect(prepareNativeConnection).not.toHaveBeenCalled()
      const world: Record<string, any> = { crypto, setTimeout, clearTimeout }
      const liveScope = () => ({ ...world.__cordisxNativeProviderOwner, navigationGeneration: 1 })
      let receive: (params: Record<string, unknown>) => void
      const session = {
        isClosed: () => false,
        onEvent: (_event: string, handler: typeof receive) => {
          receive = handler
          return () => undefined
        },
        send: vi.fn(async (method: string, params: Record<string, any>) => {
          if (method === 'Runtime.addBinding') {
            world[params.name] = (payload: string) => receive({ name: params.name, payload })
          }
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' }
          if (method === 'Runtime.evaluate') {
            if (params.expression === 'globalThis.__cordisxNativeSubmissionAuthority?.snapshot?.()') {
              return { result: { value: { scope: liveScope() } } }
            }
            vm.runInNewContext(params.expression, world)
          }
          return {}
        }),
      }
      const installed = await composition.installation.authority.install(session as unknown as CdpSession, {
        id: 'target',
        url: 'app://-/index.html',
        type: 'page',
        title: '',
      })
      try {
        const catalog = await world.__cordisxNativeProviderCommandChannel.catalogRead()
        expect(catalog).toEqual([{
          providerId: 'deepseek',
          pluginId: 'cordisx.codex-config',
          title: 'DeepSeek',
          selectorBrand: { brand: 'deepseek', source: 'inferred' },
          models: [{ id: 'deepseek-chat', label: 'deepseek-chat', aliases: [] }],
        }])
        expect(JSON.stringify(catalog)).not.toMatch(/base_url|env_key|api\.deepseek/u)
        await writeFile(path.join(codexHome, 'scoped.json'), JSON.stringify({ models: [{ slug: 'shared' }] }))
        expect((await world.__cordisxNativeProviderCommandChannel.catalogRead())[0].models)
          .toEqual([{ id: 'shared', label: 'shared', aliases: [] }])
        const channel = world.__cordisxNativeProviderCommandChannel
        const scope = liveScope()
        await channel.selectionRead({ scope, effective: { providerId: 'openai', model: 'native-default' } })
        const action = { operationId: 'fixture-send', operationGeneration: 1, intent: 'ordinary-send' }
        expect(await channel.submissionPrepare({ scope, action })).toMatchObject({ status: 'pass-through' })
        await channel.selectionSelect({ scope, providerId: 'deepseek', model: 'shared' })
        expect(await channel.submissionPrepare({ scope, action })).toMatchObject({ status: 'allow-original' })
        await writeFile(path.join(codexHome, 'scoped.json'), JSON.stringify({ models: [{ slug: 'replacement' }] }))
        expect(await channel.submissionPrepare({ scope, action })).toMatchObject({ status: 'reject' })
        expect(prepareNativeConnection).not.toHaveBeenCalled()
        const settings = {
          title: 'Managed fixture',
          endpoint: 'https://fixture.invalid/v1',
          protocol: 'responses',
          discoveryEnabled: false,
          strategy: { kind: 'manual', ids: ['managed-model'] },
        }
        const events = vi.fn()
        const unsubscribe = channel.catalogManagementSubscribe(events)
        expect((await channel.catalogManagementCommand({ operation: 'createConnection', settings })).status).toBe(
          'applied',
        )
        await vi.waitFor(async () => expect((await channel.catalogManagementRead()).views[0].selectableCount).toBe(1))
        const view = (await channel.catalogManagementRead()).views[0]
        expect(JSON.stringify(view)).not.toContain('fixture-managed-secret')
        await channel.selectionSelect({ scope, providerId: view.providerId, model: 'managed-model' })
        expect(await channel.submissionPrepare({ scope, action })).toMatchObject({ status: 'allow-original' })
        const current = (await channel.catalogManagementRead()).views[0]
        expect(
          (await channel.catalogManagementCommand({
            operation: 'setOverlay',
            bindingRef: current.bindingRef,
            scopeRevision: current.scopeRevision,
            expectedRevision: current.revision,
            modelId: 'managed-model',
            blocked: true,
          })).status,
        ).toBe('applied')
        expect(await channel.submissionPrepare({ scope, action })).toMatchObject({ status: 'reject' })
        expect(events).toHaveBeenCalled()
        expect(
          (await channel.catalogManagementCommand({
            operation: 'createConnection',
            settings: {
              title: 'Official protocol fixture',
              endpoint: 'https://api.deepseek.com',
              protocol: 'chat-completions',
              discoveryEnabled: true,
              strategy: { kind: 'auto', adapter: 'detect', mode: 'only', ttlMs: 60000 },
            },
          })).status,
        ).toBe('applied')
        await vi.waitFor(async () => expect((await channel.catalogManagementRead()).views[1].selectableCount).toBe(1))
        const official = (await channel.catalogManagementRead()).views[1]
        await channel.selectionSelect({ scope, providerId: official.providerId, model: 'deepseek-flash' })
        expect(await channel.submissionPrepare({ scope, action })).toMatchObject({ status: 'allow-original' })
        await expect(channel.selectionSelect({ scope, providerId: official.providerId, model: 'unknown' })).rejects
          .toThrow()
        unsubscribe()
      } finally {
        await installed.dispose()
      }
    } finally {
      await composition.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'reports fixed completion stages without letting the observer alter startup',
  async () => {
    const f = await bundle()
    const codexHome = path.join(f.contents, 'stage-codex-home')
    await mkdir(codexHome)
    const stages: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let releaseStatus!: () => void
    const blockedStatus = new Promise<void>(resolve => releaseStatus = resolve)
    const values = new Map<string, string>()
    const keychain = {
      async read(service: string, account: string) {
        const value = values.get(`${service}/${account}`)
        if (value === undefined) throw new Error('missing fixture value')
        return value
      },
      async status(service: string, account: string): Promise<'set' | 'unset'> {
        await blockedStatus
        return values.has(`${service}/${account}`) ? 'set' : 'unset'
      },
      async upsert(service: string, account: string, value: string) {
        values.set(`${service}/${account}`, value)
      },
      async remove(service: string, account: string) {
        values.delete(`${service}/${account}`)
      },
    }
    const bootstrap = await prepareNativeSubmissionBootstrap(f.executable, {
      cacheDirectory: path.join(f.contents, 'stage-cache'),
    })
    let settled = false
    const completing = bootstrap.complete(
      { nativeProviderIds: [], prepareNativeConnection: vi.fn() },
      codexHome,
      {
        managedCatalog: { homeDir: codexHome, profileId: 'stage-fixture', keychain },
        nativeModelDiscovery: false,
        onStage: stage => {
          stages.push(stage)
          throw new Error('fixture observer failure')
        },
      },
    ).finally(() => settled = true)
    await vi.waitFor(() => expect(stages).toContain('native-submission-resource-analysis-ready'))
    expect(settled).toBe(false)
    expect(stages).not.toContain('native-submission-managed-catalog-ready')
    releaseStatus()
    const composition = await completing
    try {
      expect(stages).toEqual([
        'native-submission-completion-start',
        'native-submission-resource-analysis-ready',
        'native-submission-managed-catalog-ready',
        'native-submission-native-catalog-ready',
        'native-submission-controller-bound',
      ])
      expect(warn).not.toHaveBeenCalledWith('[cordisx] native managed model providers unavailable')
    } finally {
      await composition.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'continues native startup when managed Keychain ownership is unavailable',
  async () => {
    const f = await bundle()
    const codexHome = path.join(f.contents, 'unavailable-owner-codex-home')
    await mkdir(codexHome)
    const stages: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unavailable = async (): Promise<never> => {
      throw new Error('fixture unavailable')
    }
    const bootstrap = await prepareNativeSubmissionBootstrap(f.executable, {
      cacheDirectory: path.join(f.contents, 'unavailable-owner-cache'),
    })
    const composition = await bootstrap.complete(
      { nativeProviderIds: [], prepareNativeConnection: vi.fn() },
      codexHome,
      {
        managedCatalog: {
          homeDir: codexHome,
          profileId: 'unavailable-owner',
          keychain: { read: unavailable, status: unavailable, upsert: unavailable, remove: unavailable },
        },
        nativeModelDiscovery: false,
        onStage: stage => stages.push(stage),
      },
    )
    try {
      expect(stages.at(-1)).toBe('native-submission-controller-bound')
      expect(warn).toHaveBeenCalledWith('[cordisx] native managed model providers unavailable')
    } finally {
      await composition.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'commits explicit provider bindings before returning launch credentials and excludes conflicted bindings',
  async () => {
    const f = await bundle()
    const codexHome = path.join(f.contents, 'codex-home')
    await mkdir(codexHome)
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '# native owner remains authoritative',
        '[model_providers.native-conflict]',
        'name = "Native conflict"',
        'base_url = "https://native.example.test/v1"',
        'wire_api = "responses"',
        'env_key = "NATIVE_CONFLICT_KEY"',
        '',
      ].join('\n'),
    )
    const values = new Map<string, string>()
    const keychain = {
      async read(service: string, account: string) {
        const value = values.get(`${service}/${account}`)
        if (!value) throw Error()
        return value
      },
      async status(service: string, account: string): Promise<'set' | 'unset'> {
        return values.has(`${service}/${account}`) ? 'set' : 'unset'
      },
      async upsert(service: string, account: string, value: string) {
        values.set(`${service}/${account}`, value)
      },
      async remove(service: string, account: string) {
        values.delete(`${service}/${account}`)
      },
    }
    const secrets = ['committed-secret', 'conflicted-secret']
    let secretIndex = 0
    const owner = await ManagedCatalogComposition.open({
      homeDir: codexHome,
      profileId: 'fixture-sync',
      keychain,
      responsesAvailable: true,
      capture: async () => secrets[secretIndex++]!,
    })
    const settings = (title: string, endpoint: string) => ({
      title,
      endpoint,
      protocol: 'responses' as const,
      discoveryEnabled: false,
      strategy: { kind: 'manual' as const, ids: ['shared-model'] },
    })
    expect(
      (await owner.command({
        operation: 'createConnection',
        settings: settings('Committed managed', 'https://committed.example.test/v1'),
      }, () => true)).status,
    ).toBe('applied')
    expect(
      (await owner.command({
        operation: 'createConnection',
        settings: settings('Conflicted managed', 'https://conflicted.example.test/v1'),
      }, () => true)).status,
    ).toBe('applied')
    const committed = owner.snapshot().views.find(view => view.title === 'Committed managed')!
    const conflicted = owner.snapshot().views.find(view => view.title === 'Conflicted managed')!
    await owner.close()

    const committedBindingId = 'cx-binding-0123456789abcdef'
    const conflictedBindingId = 'cx-binding-fedcba9876543210'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const composition = await createNativeSubmissionComposition(
      { nativeProviderIds: [], prepareNativeConnection: vi.fn() },
      f.executable,
      codexHome,
      {
        managedCatalog: {
          homeDir: codexHome,
          profileId: 'fixture-sync',
          keychain,
          capture: async () => {
            throw new Error('fixture must reuse the stored credential')
          },
        },
        providerBindings: [
          {
            bindingId: committedBindingId,
            connectionId: `cx-connection-${committed.bindingRef}`,
            localProviderId: 'cordisx-committed',
            enabled: true,
            credentialDelivery: 'process-env',
          },
          {
            bindingId: conflictedBindingId,
            connectionId: `cx-connection-${conflicted.bindingRef}`,
            localProviderId: 'native-conflict',
            enabled: true,
            credentialDelivery: 'process-env',
          },
        ],
      },
    )
    try {
      const raw = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
      const ledger = await readFile(
        path.join(codexHome, 'apps/codex/profiles/fixture-sync/provider-sync/provider-profile-bindings.json'),
        'utf8',
      )
      expect(raw).toContain('[model_providers.cordisx-committed]')
      expect(raw).toContain('base_url = "https://committed.example.test/v1"')
      expect(raw).toContain('base_url = "https://native.example.test/v1"')
      expect(raw).not.toContain('https://conflicted.example.test/v1')
      expect(composition.environment[providerSyncCredentialEnvironmentKey(committedBindingId)])
        .toBe('committed-secret')
      expect(composition.environment[providerSyncCredentialEnvironmentKey(conflictedBindingId)]).toBeUndefined()
      expect(JSON.stringify(composition.environment)).not.toContain('conflicted-secret')
      expect(`${raw}\n${ledger}`).not.toMatch(/committed-secret|conflicted-secret/u)
      expect(JSON.parse(ledger).bindings).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('id-conflict'))
    } finally {
      await composition.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'rejects a truly incompatible App before starting credential or control services',
  async () => {
    const f = await bundle(true)
    const prepareNativeConnection = vi.fn()
    await expect(createNativeSubmissionComposition(
      { nativeProviderIds: [], prepareNativeConnection },
      f.executable,
      path.join(f.contents, 'codex-home'),
    ))
      .rejects.toThrow('Native capability submit-guard')
    expect(prepareNativeConnection).not.toHaveBeenCalled()
  },
)
