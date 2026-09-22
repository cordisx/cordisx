import { createPackage } from '@electron/asar'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { createNativeSubmissionComposition } from '../packages/cli/src/launcher/native-submission-composition.js'
import { readNativeSubmissionResources } from '../packages/cli/src/launcher/native-app-resources.js'
import { resources } from './fixtures/native-submission-structure.js'

const roots: string[] = []
afterEach(async () => {
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
    await writeFile(path.join(codexHome, 'scoped.json'), JSON.stringify({ models: [{ slug: 'deepseek-chat' }] }))
    const composition = await createNativeSubmissionComposition(
      { nativeProviderIds: [], prepareNativeConnection },
      f.executable,
      codexHome,
      { configModelCatalogs: { deepseek: 'scoped.json' } },
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
      } finally {
        await installed.dispose()
      }
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
