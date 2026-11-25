import { readFile } from 'node:fs/promises'
import { expect, vi } from 'vitest'
import type { CdpClient } from '../fixtures/native-browser-cdp.js'

/** Verify shared model service creation and readback without owning either page. */
export async function verifyDesktopSharedModelServices(first: CdpClient, second: CdpClient, configPath: string) {
  for (const page of [first, second]) {
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(item =>
        ['Model services', '模型服务'].includes(item.textContent.trim()))
      if (!button) throw new Error('Model services navigation is unavailable')
      button.click()
    })()`)
    await vi.waitFor(async () => {
      expect(await page.evaluate('Boolean(document.querySelector(".cxms-shared-header"))')).toBe(true)
      expect(await page.evaluate('getComputedStyle(document.querySelector(".cxms-shared-header")).display'))
        .toBe('flex')
    }, { timeout: 15_000 })
  }
  await first.evaluate(`(() => {
    const add = [...document.querySelectorAll('.cxms-shared-header button')].find(button =>
      ['Add shared service', '添加跨应用服务'].includes(button.textContent.trim()))
    if (!add) throw new Error('Model service add action is unavailable')
    add.click()
  })()`)
  await vi.waitFor(async () => {
    expect(await first.evaluate('Boolean(document.querySelector(".cxmc-editor [data-config-path=id] input"))'))
      .toBe(true)
    expect(await first.evaluate('getComputedStyle(document.querySelector(".cxmc-editor-actions")).display'))
      .toBe('flex')
  }, { timeout: 10_000 })
  for (
    const [field, value] of [
      ['id', 'desktop-fixture'],
      ['displayName', 'Desktop fixture'],
      ['baseUrl', 'https://example.test'],
      ['codexModels', 'fixture-model'],
      ['apiKey', 'desktop-fixture-secret'],
    ]
  ) {
    await first.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(`.cxmc-editor [data-config-path="${field}"] input`)})
      if (!input) throw new Error('Model service field is unavailable')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
  }
  await vi.waitFor(async () => {
    expect(await first.evaluate('!document.querySelector(".cxmc-editor-actions button:last-child").disabled'))
      .toBe(true)
  }, { timeout: 10_000 })
  await first.evaluate('document.querySelector(".cxmc-editor-actions button:last-child").click()')
  for (const page of [first, second]) {
    await vi.waitFor(async () => {
      expect(await page.evaluate('Boolean(document.querySelector("[data-shared-model-service=desktop-fixture]"))'))
        .toBe(true)
    }, { timeout: 20_000 })
    expect(await page.evaluate('document.body.textContent.includes("desktop-fixture-secret")')).toBe(false)
  }
  const stored = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Array<{ id: string }> }
  expect(stored.providers.some(provider => provider.id === 'desktop-fixture')).toBe(true)
}
