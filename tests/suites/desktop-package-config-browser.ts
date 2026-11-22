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

export async function editDesktopConfig(page: CdpClient, label: string): Promise<void> {
  await page.evaluate(`(() => {
    const input = document.querySelector('${form} [data-config-path=label] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await vi.waitFor(async () => {
    expect(await page.evaluate(`!document.querySelector('${form} button[type=submit]').disabled`)).toBe(true)
  }, { timeout: 10_000 })
  await page.evaluate(`document.querySelector('${form} button[type=submit]').click()`)
}

export async function expectDesktopConfigApplied(
  page: CdpClient,
  desktop: CdpClient,
  store: PackagePluginConfigStore,
  revision: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  let last: unknown
  while (Date.now() < deadline) {
    const alive = await page.evaluate(`Boolean(globalThis.__cordisxRuntime)
      || document.querySelector('p[role=status]')?.hidden === true`)
    if (!alive) throw new Error('Manager session retired during configuration')
    try {
      expect(await store.loadStable(pluginId)).toEqual({ revision, config: { label } })
      expect(
        await page.evaluate(`globalThis.__cordisxRuntime.snapshot().plugins.find(p => p.id === '${pluginId}')
        ?.configuration.value`),
      ).toEqual({ label })
      expect(await desktop.evaluate('globalThis.__desktopConfigValue')).toEqual({ label })
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

export async function expectDesktopConfigBusy(page: CdpClient, label: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await page.evaluate(`document.querySelector('${form}')?.dataset.state`)).toBe('error')
    expect(await page.evaluate(`document.querySelector('${form} [data-config-path=label] input')?.value`)).toBe(label)
    expect(await page.evaluate('globalThis.__desktopConfigDocumentMarker')).toBe('same-document')
  }, { timeout: 20_000 })
}
