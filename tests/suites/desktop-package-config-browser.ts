import { expect, vi } from 'vitest'
import type { PackagePluginConfigStore } from '../../packages/cli/src/launcher/package-plugin-config.js'
import type { CdpClient } from '../fixtures/native-browser-cdp.js'

const pluginId = 'desktop-config-fixture'
const form = `[data-plugin-config-form=${pluginId}]`

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
): Promise<void> {
  const deadline = Date.now() + 30_000
  const expected = labels === undefined ? { label } : { label, labels }
  let last: unknown
  while (Date.now() < deadline) {
    const alive = await page.evaluate(`Boolean(globalThis.__cordisxRuntime)
      || document.querySelector('p[role=status]')?.hidden === true`)
    if (!alive) throw new Error('Manager session retired during configuration')
    try {
      expect(await store.loadStable(pluginId)).toEqual({ revision, config: expected })
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
