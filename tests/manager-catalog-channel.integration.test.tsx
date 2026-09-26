import React, { act } from 'react'
import vm from 'node:vm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import { ScriptSourceRuntime } from '../packages/cli/src/launcher/model-catalog/script-runtime.js'
import { createNativeSubmissionCdpAuthority } from '../packages/cli/src/launcher/native-submission-cdp-channel.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import type { NativeSubmissionController } from '../packages/cli/src/launcher/native-submission-controller.js'
import { nativeModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'
import type { MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'
import { managerModel, managerSnapshot } from './helpers/react-manager.js'
import { reactManagerFixture } from './helpers/react-manager.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

it('connects the production Host channel to Manager, selector membership and write-only script commands', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'catalog-manager-composition-'))
  const config = createDefaultHomeConfig()
  await writeFile(
    join(homeDir, 'config.json'),
    JSON.stringify({
      ...config,
      apps: {
        codex: {
          defaultProfile: 'fixture',
          profiles: { fixture: { displayName: 'Fixture', dataMode: 'shared' } },
        },
      },
    }),
    { mode: 0o600 },
  )
  const fixture = reactManagerFixture()
  const { ManagerApp } = await import('../packages/cli/src/renderer/manager/ManagerApp.js')
  const navigation = new HostManagerNavigationController()
  const fetcher = vi.fn(async () => {
    throw new Error('Fixture forbids network')
  })
  const capture = vi.fn(async () => 'injected-test-secret')
  const runScript = vi.spyOn(ScriptSourceRuntime.prototype, 'run')
  const composition = await ManagedCatalogComposition.open({
    homeDir,
    profileId: 'fixture',
    fetcher,
    capture,
    responsesAvailable: true,
  })
  const command = vi.spyOn(composition, 'command')
  const authority = createNativeSubmissionCdpAuthority({
    management: composition,
    catalog: async () => composition.catalog(),
    catalogSubscribe: listener => composition.subscribe(listener),
    isThreadIdle: async () => true,
  })
  const controller = {
    commitSelection: vi.fn(),
    releaseScope: vi.fn(async () => {}),
  } as unknown as NativeSubmissionController
  authority.bindController(controller)
  const world: Record<string, any> = { crypto, setTimeout, clearTimeout }
  let receive!: (params: Record<string, any>) => void
  const session = {
    isClosed: () => false,
    onEvent: (_event: string, listener: typeof receive) => {
      receive = listener
      return () => {}
    },
    send: async (method: string, params: Record<string, any>) => {
      if (method === 'Runtime.addBinding') {
        world[params.name] = (payload: string) => receive({ name: params.name, payload })
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'fixture-script' }
      if (method === 'Runtime.evaluate') vm.runInNewContext(params.expression, world)
      return {}
    },
  }
  const installed = await authority.install(session as unknown as CdpSession, {
    id: 'fixture-target',
    type: 'page',
    url: 'app://-/index.html',
    title: 'Fixture',
  })
  const global = globalThis as typeof globalThis & {
    __cordisxNativeProviderCommandChannel?: typeof world.__cordisxNativeProviderCommandChannel
  }
  const previous = global.__cordisxNativeProviderCommandChannel
  global.__cordisxNativeProviderCommandChannel = world.__cordisxNativeProviderCommandChannel
  const registry = nativeModelProviderRegistry()
  try {
    await registry.management!.refresh()
    await fixture.render(
      <ManagerApp
        model={managerModel(managerSnapshot({ platform: { ...managerSnapshot().platform, hostId: 'codex-desktop' } }), {
          modelProviders: registry,
        })}
        marketplace={{} as MarketplaceModel}
        triggerSeat={fixture.document.createElement('span')}
        navigationController={navigation}
      />,
    )
    await act(async () => navigation.openRoute({ kind: 'primary', page: 'model-services' }))
    expect((fixture.element('[aria-label="Add model connection"]') as HTMLButtonElement).disabled).toBe(false)
    expect(fixture.document.querySelectorAll('[data-binding-ref]')).toHaveLength(0)
    await fixture.click('[aria-label="Add model connection"]')
    expect(fixture.document.querySelector('.cxmp-toolbar')).toBeNull()
    expect(fixture.document.querySelector('[data-schema-form]')).not.toBeNull()
    expect(fixture.document.querySelector('[data-config-path="protocol"]')).toBeNull()
    await fixture.click('.cxr-header [aria-label="Back"]')
    expect(fixture.document.querySelector('.cxmp-toolbar')).not.toBeNull()
    await fixture.click('[aria-label="Add model connection"]')
    await fixture.click('.cxmc-editor-actions button:first-child')
    expect(fixture.document.querySelector('.cxmp-toolbar')).not.toBeNull()
    await fixture.click('[aria-label="Add model connection"]')
    await fixture.type('[data-config-path="title"] input', 'Fixture connection')
    await fixture.type('[data-config-path="endpoint"] input', 'https://fixture.invalid/v1')
    for (const [id, label] of [['Model-A', 'First fixture model'], ['model-a', 'Second fixture model']]) {
      await fixture.click('[data-config-path="models"] [aria-label="Add item"]')
      expect(fixture.document.querySelector('.cxf-form-subpage')).not.toBeNull()
      await fixture.type('.cxf-form-subpage [data-config-path$=".id"] input', id!)
      await fixture.type('.cxf-form-subpage [data-config-path$=".label"] input', label!)
      await fixture.click('.cxf-form-subpage .cxf-form-action-buttons button:last-child')
    }
    expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(false)
    await fixture.click('.cxmc-editor-actions button:last-child')
    await act(async () => {
      await vi.waitFor(() => expect(command).toHaveBeenCalled())
      await vi.waitFor(() => expect(composition.snapshot().views[0]?.rows).toHaveLength(2))
      await registry.management!.refresh()
      await registry.refresh()
    })
    expect(command.mock.calls[0]?.[0]).toMatchObject({
      operation: 'createConnection',
      settings: { protocol: 'responses' },
    })
    expect(composition.snapshot().views[0]?.rows.map(row => [row.id, row.label])).toEqual([
      ['Model-A', 'First fixture model'],
      ['model-a', 'Second fixture model'],
    ])
    expect(capture).toHaveBeenCalledOnce()
    expect(fixture.document.querySelectorAll('[data-binding-ref]')).toHaveLength(1)
    expect(registry.snapshot().providers[0]?.models.map(model => model.id)).toEqual(['Model-A', 'model-a'])
    await fixture.click('[aria-label="Block model: Model-A"]')
    await act(async () => {
      await vi.waitFor(() =>
        expect(composition.snapshot().views[0]?.rows.find(row => row.id === 'Model-A')?.blocked).toBe(true)
      )
      await registry.management!.refresh()
      await registry.refresh()
    })
    const view = registry.management!.snapshot().views[0]!
    expect(view.rows.find(row => row.id === 'Model-A')).toMatchObject({ blocked: true, selectable: false })
    expect(registry.snapshot().providers[0]?.models.map(model => model.id)).toEqual(['model-a'])
    expect(composition.admits(view.providerId, 'Model-A')).toBe(false)
    expect(composition.admits(view.providerId, 'model-a')).toBe(true)
    await fixture.click('[aria-label="Pin model: model-a"]')
    await act(async () => {
      await vi.waitFor(() =>
        expect(composition.snapshot().views[0]?.rows.find(row => row.id === 'model-a')?.pinned).toBe(true)
      )
      await registry.management!.refresh()
    })
    expect(controller.commitSelection).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()

    const current = registry.management!.snapshot().views[0]!
    await act(async () => {
      const result = await registry.management!.command({
        operation: 'configureScript',
        bindingRef: current.bindingRef,
        scopeRevision: current.scopeRevision,
        expectedRevision: current.revision,
        mode: 'replace',
        config: {
          schemaVersion: 1,
          command: {
            kind: 'exec',
            executable: process.execPath,
            args: [
              '-e',
              'process.stdout.write(JSON.stringify({schemaVersion:1,complete:true,models:[{id:"script-model"}]}))',
            ],
          },
          cwd: homeDir,
          environment: { inherit: false, refs: {}, values: {} },
          timeoutMs: 1000,
          maxStdoutBytes: 1_048_576,
          maxStderrBytes: 65_536,
          maxModels: 1000,
        },
      })
      expect(result.status).toBe('applied')
    })
    expect(runScript).not.toHaveBeenCalled()
    expect(registry.management!.snapshot().views[0]?.rows.every(row => !row.present)).toBe(true)
    expect(JSON.stringify(registry.management!.snapshot())).not.toMatch(
      /injected-test-secret|process\.stdout|environment|executable/,
    )
    await fixture.click('[aria-label="Run script"]')
    await act(async () => {
      await vi.waitFor(() =>
        expect(composition.snapshot().views[0]?.rows.some(row => row.id === 'script-model')).toBe(true)
      )
      await registry.management!.refresh()
      await registry.refresh()
    })
    expect(fixture.element('[data-model-id="script-model"]').textContent).toContain('script-model')
    expect(runScript).toHaveBeenCalledOnce()
    expect(registry.snapshot().providers[0]?.models[0]?.provenance).toContain('script')
    expect(fetcher).not.toHaveBeenCalled()
    expect(controller.commitSelection).not.toHaveBeenCalled()
    await installed.dispose()
    await act(async () => {
      await registry.management!.refresh()
    })
    expect(registry.management!.snapshot().connected).toBe(false)
    expect((fixture.element('[aria-label="Run script"]') as HTMLButtonElement).disabled).toBe(true)
  } finally {
    registry.dispose()
    await installed.dispose()
    await composition.close()
    runScript.mockRestore()
    if (previous === undefined) delete global.__cordisxNativeProviderCommandChannel
    else global.__cordisxNativeProviderCommandChannel = previous
    await fixture.dispose()
    await rm(homeDir, { recursive: true, force: true })
  }
})
