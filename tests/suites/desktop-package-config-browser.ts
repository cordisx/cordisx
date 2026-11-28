import { expect, vi } from 'vitest'
import type { PackagePluginConfigStore } from '../../packages/cli/src/launcher/package-plugin-config.js'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import type { CdpClient } from '../fixtures/native-browser-cdp.js'
import { decision, FakeRuntime, localPackage, request } from './plugin-lifecycle.fixtures.js'

const pluginId = 'desktop-config-fixture'
const form = `[data-plugin-config-form=${pluginId}]`

/** Wait for a replacement document before consulting its runtime readiness. */
export async function reloadDesktopConfigPage(
  page: CdpClient,
  ready: (page: CdpClient) => Promise<void>,
): Promise<void> {
  await page.evaluate('globalThis.__desktopConfigBeforeReload = true')
  await page.send('Page.reload')
  await vi.waitFor(async () => {
    expect(await page.evaluate('globalThis.__desktopConfigBeforeReload === undefined')).toBe(true)
  }, { timeout: 15_000 })
  await ready(page)
}

export async function verifyReadOnlyDesktopConfig(
  pages: readonly CdpClient[],
  label: string,
  secret: string,
): Promise<void> {
  for (const page of pages) {
    const projection = await page.evaluate<any>([
      '(() => {',
      '  const plugin = globalThis.__cordisxRuntime.snapshot().plugins',
      "    .find(item => item.id === 'desktop-config-fixture')",
      '  return { value: plugin?.configuration.value, writable: plugin?.configuration.writable,',
      '    body: document.body.textContent, pluginConfig: globalThis.__desktopConfigValue }',
      '})()',
    ].join('\n'))
    expect(projection.value).toEqual({ label })
    expect(projection.pluginConfig).toEqual({ label })
    expect(projection.writable).toBe(false)
    expect(JSON.stringify(projection)).not.toContain(secret)
  }
}

export async function verifyDesktopConfigRecovery(
  page: CdpClient,
  secret: string,
  label: string,
  ready: (page: CdpClient) => Promise<void>,
): Promise<void> {
  const unavailable = await page.evaluate<any>(`({
    plugins: globalThis.__cordisxRuntime.snapshot().plugins,
    body: document.body.textContent,
    pluginConfig: globalThis.__desktopConfigValue,
  })`)
  expect(unavailable.plugins.find((item: any) => item.id === pluginId)?.status).toBe('failed')
  expect(JSON.stringify(unavailable)).not.toContain(secret)
  expect(unavailable.pluginConfig).toBeUndefined()
  await reloadDesktopConfigPage(page, ready)
  expect(await page.evaluate('globalThis.__desktopConfigValue')).toEqual({ label })
}

export async function stageDesktopConfigFixture(input: {
  root: string
  homeDir: string
  profileId: string
  generation: string
  store: PackagePluginConfigStore
  writeFixture: boolean
  retainPrivateForWrite?: boolean
  label: string
  secret: string
}): Promise<void> {
  const sourceDirectory = await localPackage({
    root: input.root,
    id: pluginId,
    code: [
      "const descriptor = { type: 'object', dict: { label: { type: 'string' },",
      "  labels: { type: 'array', inner: { type: 'string' } },",
      "  token: { type: 'string', meta: { role: 'secret' } } } }",
      "export const Config = { ...descriptor, '~standard': { version: 1, vendor: 'schemastery',",
      '  validate: value => ({ value }) }, toJSON: () => descriptor }',
      "export const configApplies = 'live'",
      "export const inject = ['settings']",
      'export function apply(ctx, config) { globalThis.__desktopConfigValue = config;',
      '  ctx.settings.watch(value => { globalThis.__desktopConfigValue = value }) }',
    ].join('\n'),
  })
  const seed = new PluginLifecycleCoordinator({
    homeDir: input.homeDir,
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    permissionPolicies: [],
    runtime: new FakeRuntime(),
  })
  await seed.store.bindRuntimeGeneration()
  const planned = await seed.handle({
    ...request({ kind: 'inspect-local', sourceDirectory }, 0, input.generation),
    profileId: input.profileId,
  })
  if (planned.outcome !== 'planned' || !planned.candidateId || !planned.authorizationPlan) {
    throw new Error('configuration fixture package could not be planned')
  }
  const installed = await seed.handle({
    ...request(
      {
        kind: 'install',
        candidateId: planned.candidateId,
        authorizationDecision: decision(planned.authorizationPlan),
      },
      0,
      input.generation,
    ),
    profileId: input.profileId,
  })
  if (installed.outcome !== 'applied') throw new Error('configuration fixture package could not be installed')
  const candidate = await input.store.stage(
    pluginId,
    0,
    input.writeFixture && !input.retainPrivateForWrite
      ? { label: input.label }
      : { label: input.label, token: input.secret },
    'fixture-owner',
  )
  await input.store.commit(pluginId, candidate.candidateRevision, 'fixture-owner')
}

export async function verifyDesktopConfigLifecycle(
  store: PackagePluginConfigStore,
  desktop: CdpClient,
  first: CdpClient,
  second: CdpClient,
  reopen: () => Promise<CdpClient>,
): Promise<CdpClient> {
  const watch = async (page: CdpClient) => {
    await page.evaluate(`(() => {
      globalThis.__fixtureDialogRoots = []
      const attach = Element.prototype.attachShadow
      Element.prototype.attachShadow = function(options) {
        const root = attach.call(this, options)
        globalThis.__fixtureDialogRoots.push(root)
        return root
      }
      globalThis.__fixtureExecutions = []
      const forward = window.fetch.bind(window)
      window.fetch = async (url, options) => {
        let operation
        if (url === '/api/renderer/binding' && typeof options?.body === 'string') {
          try { operation = JSON.parse(JSON.parse(options.body).payload).operation.kind } catch {}
        }
        const response = await forward(url, options)
        if (operation === 'execute') {
          const reply = await response.clone().json().catch(() => undefined)
          globalThis.__fixtureExecutions.push({ ok: reply?.ok, status: reply?.value?.status })
        }
        return response
      }
    })()`)
  }
  const open = async (page: CdpClient) => {
    if (await page.evaluate(`Boolean(document.querySelector('[data-plugin-detail=${pluginId}]'))`)) return
    await vi.waitFor(async () => {
      expect(await page.evaluate(`Boolean(document.querySelector('[data-plugin-id=${pluginId}]'))`)).toBe(true)
    }, { timeout: 20_000 })
    await page.evaluate(`document.querySelector('[data-plugin-id=${pluginId}]').click()`)
    await vi.waitFor(async () => {
      expect(await page.evaluate(`Boolean(document.querySelector('[data-plugin-detail=${pluginId}]'))`)).toBe(true)
    }, { timeout: 20_000 })
  }
  const change = async (page: CdpClient, action: 'disable' | 'enable') => {
    const selector = JSON.stringify(`[data-plugin-lifecycle-action="${action}"]`)
    const previous = await page.evaluate<number>('globalThis.__fixtureExecutions.length')
    await vi.waitFor(async () => {
      expect(
        await page.evaluate(`(() => {
        const button = document.querySelector(${selector})
        if (!button || button.disabled || button.classList.contains('t-is-disabled')) return false
        button.click(); return true
      })()`),
      ).toBe(true)
    }, { timeout: 20_000 })
    if (action === 'disable') {
      await vi.waitFor(async () => {
        expect(
          await page.evaluate(`globalThis.__fixtureDialogRoots.some(root =>
          root.querySelector('dialog[open] [data-action=confirm]'))`),
        ).toBe(true)
      }, { timeout: 20_000 })
      await page.evaluate(`globalThis.__fixtureDialogRoots.find(root =>
        root.querySelector('dialog[open] [data-action=confirm]'))
        .querySelector('dialog[open] [data-action=confirm]').click()`)
    }
    await vi.waitFor(async () => {
      expect(
        await page.evaluate(`globalThis.__fixtureExecutions.slice(${previous})
        .some(item => item.ok === true && item.status === 'applied')`),
      ).toBe(true)
    }, { timeout: 45_000 })
  }
  await watch(first)
  await open(first)
  await change(first, 'disable')
  const expected = { label: 'first update' }
  expect(await store.loadStable(pluginId)).toEqual({ revision: 2, config: expected })
  for (const page of [desktop, first, second]) {
    expect(
      await page.evaluate(`globalThis.__cordisxRuntime.activePluginGeneration().plugins
      .find(item => item.id === '${pluginId}')?.enabled`),
    ).toBe(false)
  }
  second = await reopen()
  await watch(second)
  await open(second)
  expect(
    await second.evaluate(`globalThis.__cordisxRuntime.snapshot().plugins
    .find(item => item.id === '${pluginId}')?.configuration.writable`),
  ).toBe(false)
  for (const page of [desktop, first, second]) await page.evaluate('globalThis.__desktopConfigValue = undefined')
  await change(second, 'enable')
  expect(await store.loadStable(pluginId)).toEqual({ revision: 2, config: expected })
  for (const page of [desktop, first, second]) {
    expect(await page.evaluate('globalThis.__desktopConfigValue')).toEqual(expected)
  }
  await second.evaluate("globalThis.__desktopConfigDocumentMarker = 'same-document'")
  await second.evaluate('document.querySelector("[data-plugin-detail-tab=config]").click()')
  await vi.waitFor(async () => {
    expect(
      await second.evaluate(`globalThis.__cordisxRuntime.snapshot().plugins
      .find(item => item.id === '${pluginId}')?.configuration.writable`),
    ).toBe(true)
  }, { timeout: 15_000 })
  await editDesktopConfig(second, 'after lifecycle')
  await expectDesktopConfigApplied(second, desktop, store, 3, 'after lifecycle')
  await vi.waitFor(async () => {
    expect(await first.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: 'after lifecycle' })
  }, { timeout: 15_000 })
  return second
}

export async function openDesktopConfig(page: CdpClient): Promise<void> {
  await vi.waitFor(async () => {
    expect(await page.evaluate(`Boolean(document.querySelector('[data-plugin-id=${pluginId}]'))`)).toBe(true)
  }, { timeout: 15_000 })
  await page.evaluate(`document.querySelector('[data-plugin-id=${pluginId}]').click()`)
  await vi.waitFor(async () => {
    expect(await page.evaluate('Boolean(document.querySelector("[data-plugin-detail-tab=config]"))')).toBe(true)
  }, { timeout: 15_000 })
  await page.evaluate('document.querySelector("[data-plugin-detail-tab=config]").click()')
  await vi.waitFor(async () => {
    expect(await page.evaluate(`Boolean(document.querySelector('${form} [data-config-path=label] input'))`)).toBe(true)
  }, { timeout: 15_000 })
}

export async function draftDesktopConfig(page: CdpClient, label: string): Promise<void> {
  await page.evaluate(`(() => {
    const input = document.querySelector('${form} [data-config-path=label] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await vi.waitFor(async () => {
    expect(await page.evaluate(`!document.querySelector('${form} button[type=submit]').disabled`)).toBe(true)
  }, { timeout: 10_000 })
}

export async function editDesktopConfig(page: CdpClient, label: string): Promise<void> {
  await draftDesktopConfig(page, label)
  await submitDesktopConfig(page)
}

export async function submitDesktopConfig(page: CdpClient): Promise<void> {
  await page.evaluate(`document.querySelector('${form} button[type=submit]').click()`)
}

/** Hold a real busy reply in transit while the peer adoption reaches this page. */
export async function holdDesktopConfigReply(page: CdpClient): Promise<void> {
  await page.evaluate([
    '(() => {',
    '  const originalFetch = globalThis.fetch.bind(globalThis);',
    '  globalThis.__holdConfigReply = new Promise(resolve => globalThis.__releaseConfigReply = resolve);',
    '  globalThis.__configReplyHeld = false;',
    '  globalThis.fetch = async (url, options) => {',
    '    const response = await originalFetch(url, options);',
    '    if (url === "/api/renderer/binding" && JSON.parse(options.body).channel === "desktop-package-config") {',
    '      globalThis.__configReplyHeld = true;',
    '      await globalThis.__holdConfigReply;',
    '    }',
    '    return response;',
    '  };',
    '  const runtime = globalThis.__cordisxRuntime;',
    '  const adopt = runtime.adoptStandaloneDesktopPackageConfig.bind(runtime);',
    '  runtime.adoptStandaloneDesktopPackageConfig = async value => {',
    '    if (!value.origin) globalThis.__peerAdoptionStarted = true;',
    '    return await adopt(value);',
    '  };',
    '})()',
  ].join('\n'))
}

export async function waitForHeldConfigReply(page: CdpClient): Promise<void> {
  await vi.waitFor(async () => {
    expect(await page.evaluate('globalThis.__configReplyHeld')).toBe(true)
  }, { timeout: 10_000 })
}

export async function releaseHeldConfigReplyAfterAdoption(page: CdpClient): Promise<void> {
  await vi.waitFor(async () => {
    expect(await page.evaluate('globalThis.__peerAdoptionStarted')).toBe(true)
  }, { timeout: 10_000 })
  await page.evaluate('globalThis.__releaseConfigReply()')
}

export async function openConfiguredChannel(page: CdpClient): Promise<void> {
  await page.evaluate('document.querySelector("[data-settings-navigation-item^=channel]").click()')
  await vi.waitFor(async () => {
    expect(await page.evaluate('Boolean(document.querySelector("[data-manager-collection-item]"))')).toBe(true)
    expect(
      await page.evaluate(
        'document.body.textContent.includes("Simulator") || document.body.textContent.includes("模拟器")',
      ),
    ).toBe(true)
  }, { timeout: 20_000 })
  await page.evaluate('document.querySelector("[data-manager-collection-item] .cxr-manager-collection-open").click()')
  await vi.waitFor(async () => {
    expect(await page.evaluate('Boolean(document.querySelector("[data-channel-manager]"))')).toBe(true)
  }, { timeout: 15_000 })
}

export async function expectDesktopConfigApplied(
  page: CdpClient,
  desktop: CdpClient,
  store: PackagePluginConfigStore,
  revision: number,
  label: string,
  labels?: readonly string[],
  privateValue?: string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  const expected = labels === undefined ? { label } : { label, labels }
  let last: unknown
  while (Date.now() < deadline) {
    const alive = await page.evaluate(`Boolean(globalThis.__cordisxRuntime)
      || document.documentElement.dataset.cordisxManagerReady === 'true'`)
    if (!alive) throw new Error('Manager session retired during configuration')
    try {
      expect(await store.loadStable(pluginId)).toEqual({
        revision,
        config: { ...expected, ...(privateValue === undefined ? {} : { token: privateValue }) },
      })
      expect(
        await page.evaluate(`globalThis.__cordisxRuntime.snapshot().plugins.find(p => p.id === '${pluginId}')
        ?.configuration.value`),
      ).toEqual(expected)
      expect(await desktop.evaluate('globalThis.__desktopConfigValue')).toEqual(expected)
      expect(await page.evaluate('globalThis.__desktopConfigDocumentMarker')).toBe('same-document')
      expect(['saved', 'pristine']).toContain(await page.evaluate(`document.querySelector('${form}')?.dataset.state`))
      return
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw last
}

/** Exercise the existing tag control and confirm the array on both Manager pages. */
export async function verifyDesktopArrayUpdate(
  page: CdpClient,
  other: CdpClient,
  desktop: CdpClient,
  store: PackagePluginConfigStore,
): Promise<void> {
  await vi.waitFor(async () => {
    expect(await page.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: 'retained draft' })
    expect(await page.evaluate('globalThis.__desktopConfigDocumentMarker')).toBe('same-document')
    expect(await page.evaluate(`Boolean(document.querySelector('${form} [data-config-path=labels] input'))`)).toBe(true)
  }, { timeout: 10_000 })
  await page.send('Page.bringToFront')
  await page.evaluate(`document.querySelector('${form} [data-config-path=labels] input').focus()`)
  await page.send('Input.insertText', { text: 'one' })
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await vi.waitFor(async () => {
    expect(await page.evaluate(`!document.querySelector('${form} button[type=submit]').disabled`)).toBe(true)
  }, { timeout: 10_000 })
  await submitDesktopConfig(page)
  await expectDesktopConfigApplied(page, desktop, store, 5, 'retained draft', ['one'])
  await vi.waitFor(async () => {
    expect(await other.evaluate('globalThis.__desktopConfigValue')).toEqual({
      label: 'retained draft',
      labels: ['one'],
    })
    expect(await other.evaluate('globalThis.__desktopConfigDocumentMarker')).toBe('same-document')
  }, { timeout: 15_000 })
}

export async function expectDesktopConfigConflict(page: CdpClient, label: string, saved: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await page.evaluate(`document.querySelector('${form}')?.dataset.state`)).toBe('conflict')
    expect(await page.evaluate(`document.querySelector('${form} [data-config-path=label] input')?.value`)).toBe(label)
    expect(await page.evaluate(`document.querySelector('${form} button[type=submit]')?.disabled`)).toBe(true)
    expect(
      await page.evaluate(`globalThis.__cordisxRuntime.snapshot().plugins.find(p => p.id === '${pluginId}')
      ?.configuration.value`),
    ).toEqual({ label: saved })
    expect(await page.evaluate('globalThis.__desktopConfigValue')).toEqual({ label: saved })
    expect(await page.evaluate('globalThis.__desktopConfigDocumentMarker')).toBe('same-document')
  }, { timeout: 20_000 })
}
