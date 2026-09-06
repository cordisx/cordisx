import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPermissionAuthorizationPlanV2 } from '../packages/cli/src/capability-risk-catalog.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_LOCALE_CATALOGS } from '../packages/cli/src/permission-locales.js'
import type { CordisXCapabilityDeclarationV2 } from '../packages/cli/src/permission-contracts.js'
import { BrowserPermissionAuthorizationDialog } from '../packages/cli/src/renderer/permission-authorization-dialog.js'

function declaration(
  name: CordisXCapabilityDeclarationV2['name'],
  required: boolean,
  scope: CordisXCapabilityDeclarationV2['scope'],
): CordisXCapabilityDeclarationV2 {
  return {
    name,
    required,
    rationale: {
      title: { key: `${name}.title`, fallback: 'Why this plugin asks' },
      description: { key: `${name}.description`, fallback: 'The plugin uses this for its timeline.' },
      feature: { key: `${name}.feature`, fallback: 'Task timeline' },
      deniedBehavior: { key: `${name}.denied`, fallback: 'The timeline remains unavailable.' },
    },
    security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
    scope,
  }
}

function viewModel(
  operation: 'install' | 'runtime' = 'install',
  suffix = '1',
  moduleGeneration = 'demo-1',
) {
  return new PermissionAuthorizationViewModel(buildPermissionAuthorizationPlanV2({
    planId: `${operation}-permission-plan-${suffix}`,
    operation,
    profileId: 'work',
    identity: { source: 'file:///plugins/demo.js', pluginId: 'demo' },
    binding: {
      operationId: `${operation}:demo:${suffix}`,
      runtimeGeneration: 'runtime-1',
      moduleGeneration,
      requestId: `request-${suffix}`,
    },
    declarations: [
      declaration('models.read', true, {}),
      declaration('agent.events.read', false, { sessionIds: ['session-1'] }),
      declaration('tasks.control', true, {
        sessions: [{ providerId: 'codex', remoteSessionId: 'thread-1' }],
      }),
    ],
    policies: [],
    contextFor: item => ({
      operation,
      providerKind: item.name.startsWith('agent.') ? 'host-local' : 'current-connection',
      providerTrust: item.name === 'tasks.control' ? 'unverified' : 'native',
      availability: item.name === 'agent.events.read' ? 'unavailable' : 'supported',
    }),
  }))
}

function localizedRequest(initial: 'en' | 'zh-CN' = 'en') {
  let locale = initial
  let listener: (() => void) | undefined
  const resolve = (message: { readonly key: string; readonly fallback?: string }): string => {
    const catalog = CORDISX_PERMISSION_LOCALE_CATALOGS.find(item => item.locale === locale)!
    return catalog.messages[message.key] ?? message.fallback ?? `[[${message.key}]]`
  }
  return {
    request: {
      project: () => ({
        plugin: {
          name: 'Demo',
          source: 'file:///plugins/demo.js',
          trust: 'unverified' as const,
          icon: 'host:settings',
        },
        availability: {
          'models.read': {
            status: 'supported' as const,
            reason: { key: 'available', fallback: 'The current connection is available.' },
            providerIds: ['desktop-current'],
          },
          'agent.events.read': {
            status: 'unavailable' as const,
            reason: { key: 'unavailable', fallback: 'No matching event provider is active.' },
            providerIds: ['host-agent-events'],
          },
        },
        resolve,
        scope: (scope: unknown) => JSON.stringify(scope),
        requestSource: 'package-install',
      }),
      subscribeLocale: (next: () => void) => {
        listener = next
        return () => {
          if (listener === next) listener = undefined
        }
      },
    },
    setLocale(next: 'en' | 'zh-CN') {
      locale = next
      listener?.()
    },
    subscribed: () => listener !== undefined,
  }
}

function dom(theme: 'light' | 'dark', systemDark = theme === 'dark') {
  const instance = new JSDOM(
    `<!doctype html><html class="electron-${theme}"><body><button id="before">Before</button><div id="native" data-stable="true"></div></body></html>`,
    { pretendToBeVisual: true },
  )
  Object.defineProperty(instance.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: systemDark,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    vi.stubGlobal(key, Reflect.get(instance.window, key))
  }
  vi.stubGlobal('getComputedStyle', instance.window.getComputedStyle.bind(instance.window))
  vi.stubGlobal('requestAnimationFrame', instance.window.requestAnimationFrame.bind(instance.window))
  vi.stubGlobal('cancelAnimationFrame', instance.window.cancelAnimationFrame.bind(instance.window))
  return instance
}

async function mounted(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve))
  vi.unstubAllGlobals()
})

describe('Host-owned permission authorization dialog', () => {
  it('uses a single heading, flat permission list, radio lifetimes, and Cancel/Confirm decisions', async () => {
    const instance = dom('dark', false)
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const request = localizedRequest()
    const pending = dialog.show(viewModel(), request.request)
    await mounted()
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')!
    const panel = overlay.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.querySelectorAll('h2')).toHaveLength(1)
    expect(panel.querySelector('h2')?.textContent).toBe('Review permissions before installing')
    expect(panel.textContent?.match(/Review permissions before installing/g)).toHaveLength(1)
    expect(panel.querySelectorAll('[role="list"]')).toHaveLength(1)
    expect(panel.querySelectorAll('[role="listitem"]')).toHaveLength(3)
    expect(panel.querySelectorAll('.cxp-item .cxp-item')).toHaveLength(0)
    expect(panel.querySelectorAll('fieldset')).toHaveLength(3)
    expect(panel.querySelectorAll('[data-permission-action="cancel"], [data-permission-action="confirm"]'))
      .toHaveLength(2)
    expect(panel.querySelectorAll('button[data-permission-decision]')).toHaveLength(0)
    expect(panel.querySelectorAll('label.t-radio > input[type="radio"]')).not.toHaveLength(0)
    expect(panel.querySelector('[data-permission-action="confirm"]')?.classList.contains('t-button')).toBe(true)
    expect(panel.querySelector('[data-permission-action="confirm"]')?.classList.contains('t-button--theme-primary'))
      .toBe(true)
    expect(panel.textContent).toContain('Plugin-provided explanation')

    const low = panel.querySelector<HTMLElement>('[data-permission-capability="models.read"]')!
    expect(low.querySelector('[data-permission-review-mode="batch-eligible"]')?.textContent).toBe('Batch review')
    expect(low.querySelector<HTMLInputElement>('[data-permission-decision="allow-persistent"] input')?.checked).toBe(
      true,
    )
    const sensitive = panel.querySelector<HTMLElement>('[data-permission-capability="agent.events.read"]')!
    expect(sensitive.textContent).toContain('Unavailable now')
    expect(sensitive.querySelectorAll('[data-permission-decision]')).toHaveLength(4)
    expect(sensitive.querySelector<HTMLInputElement>('[data-permission-decision="allow-once"] input')?.checked).toBe(
      true,
    )
    const high = panel.querySelector<HTMLElement>('[data-permission-capability="tasks.control"]')!
    expect(high.querySelector('[data-permission-review-mode="explicit"]')?.textContent).toBe('Explicit review')
    expect(high.querySelector('[data-permission-decision="allow-persistent"]')).toBeNull()
    expect(high.querySelector<HTMLInputElement>('[data-permission-decision="deny-once"] input')?.checked).toBe(true)
    expect(high.querySelector<HTMLElement>('.cxp-denial')?.hidden).toBe(false)

    panel.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')?.click()
    await expect(pending).resolves.toMatchObject({
      status: 'confirmed',
      decision: { planId: 'install-permission-plan-1', binding: { runtimeGeneration: 'runtime-1' } },
    })
    expect(instance.window.document.querySelector('[data-permission-authorization]')).toBeNull()
    dialog.dispose()
    instance.window.close()
  })

  it('follows the renderer theme over the opposite OS preference and preserves live locale/decision/focus state', async () => {
    const instance = dom('dark', false)
    const before = instance.window.document.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const localization = localizedRequest()
    const model = viewModel()
    const pending = dialog.show(model, localization.request)
    await mounted()
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')!
    expect(overlay.dataset.cordisxAppTheme).toBe('dark')
    expect(overlay.dataset.cordisxThemeSource).toBe('renderer-attribute')
    expect(overlay.style.getPropertyValue('--cx-surface')).toBe('#17191d')
    expect(overlay.style.getPropertyValue('--cx-primary')).toBe('#c7ccd4')
    expect(instance.window.getComputedStyle(overlay).getPropertyValue('--td-brand-color')).toBe('var(--cx-primary)')
    expect(instance.window.getComputedStyle(overlay).getPropertyValue('--td-text-color-primary')).toBe('var(--cx-text)')
    expect(instance.window.getComputedStyle(overlay).colorScheme).toBe('dark')
    const deny = overlay.querySelector<HTMLInputElement>(
      '[data-permission-capability="agent.events.read"] [data-permission-decision="deny-persistent"]',
    )!
    deny.click()
    deny.focus()
    expect(model.selection('agent.events.read')).toBe('deny-persistent')
    const identity = deny

    localization.setLocale('zh-CN')
    expect(overlay.querySelector('h2')?.textContent).toBe('安装前确认权限')
    expect(overlay.querySelector('[data-permission-capability="agent.events.read"] h3')?.textContent).toBe(
      '读取 Agent 事件',
    )
    expect(instance.window.document.activeElement).toBe(identity)
    expect(identity.querySelector<HTMLInputElement>('input')?.checked).toBe(true)

    instance.window.document.documentElement.className = 'electron-light'
    await settle()
    expect(overlay.dataset.cordisxAppTheme).toBe('light')
    expect(overlay.style.getPropertyValue('--cx-surface')).toBe('#f8fafc')
    expect(overlay.style.getPropertyValue('--cx-primary')).toBe('#3d4755')
    expect(instance.window.getComputedStyle(overlay).getPropertyValue('--td-brand-color')).toBe('var(--cx-primary)')
    expect(instance.window.getComputedStyle(overlay).getPropertyValue('--td-bg-color-container')).toBe(
      'var(--cx-surface)',
    )
    expect(instance.window.getComputedStyle(overlay).colorScheme).toBe('light')
    expect(instance.window.document.activeElement).toBe(identity)
    expect(identity.querySelector<HTMLInputElement>('input')?.checked).toBe(true)
    expect(model.selection('agent.events.read')).toBe('deny-persistent')
    expect(instance.window.document.querySelector('#native')?.getAttribute('data-stable')).toBe('true')
    expect(instance.window.document.querySelector('#native')?.attributes).toHaveLength(2)

    overlay.querySelector<HTMLButtonElement>('[data-permission-action="cancel"]')?.click()
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(instance.window.document.activeElement).toBe(before)
    expect(localization.subscribed()).toBe(false)
    expect(instance.window.document.querySelector('[data-permission-authorization-style]')).toBeNull()
    dialog.dispose()
    instance.window.close()
  })

  it('queues multiple requests, exposes only one modal, and clears active/queued requests on dispose', async () => {
    const instance = dom('light', true)
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const first = dialog.show(viewModel('runtime'), localizedRequest().request)
    const second = dialog.show(viewModel('install'), localizedRequest().request)
    const third = dialog.show(viewModel('runtime'), localizedRequest().request)
    await mounted()
    expect(instance.window.document.querySelectorAll('[data-permission-authorization]')).toHaveLength(1)
    instance.window.document.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')?.click()
    await expect(first).resolves.toMatchObject({ status: 'confirmed' })
    await mounted()
    expect(instance.window.document.querySelectorAll('[data-permission-authorization]')).toHaveLength(1)
    expect(instance.window.document.querySelector('h2')?.textContent).toBe('Review permissions before installing')
    dialog.dispose()
    await expect(second).resolves.toEqual({ status: 'cancelled' })
    await expect(third).resolves.toEqual({ status: 'cancelled' })
    expect(instance.window.document.querySelector('[data-permission-authorization]')).toBeNull()
    expect(instance.window.document.querySelector('[data-permission-authorization-style]')).toBeNull()
    instance.window.close()
  })

  it('cancels exact active and queued plans without blocking the surviving review', async () => {
    const instance = dom('light')
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const staleActive = viewModel('runtime', 'stale-active', 'module-stale')
    const surviving = viewModel('install', 'surviving', 'module-current')
    const staleQueued = viewModel('runtime', 'stale-queued', 'module-stale')
    const activeResult = dialog.show(staleActive, localizedRequest().request)
    const survivingResult = dialog.show(surviving, localizedRequest().request)
    const queuedResult = dialog.show(staleQueued, localizedRequest().request)
    await mounted()
    expect(
      instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')?.dataset
        .permissionAuthorization,
    )
      .toBe(staleActive.plan.planId)

    dialog.cancel(staleQueued.plan.planId, staleQueued.plan.binding)
    await expect(queuedResult).resolves.toEqual({ status: 'cancelled' })
    expect(
      instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')?.dataset
        .permissionAuthorization,
    )
      .toBe(staleActive.plan.planId)

    dialog.cancel(staleActive.plan.planId, { ...staleActive.plan.binding, moduleGeneration: 'module-other' })
    expect(
      instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')?.dataset
        .permissionAuthorization,
    )
      .toBe(staleActive.plan.planId)
    dialog.cancel(staleActive.plan.planId, staleActive.plan.binding)
    await expect(activeResult).resolves.toEqual({ status: 'cancelled' })
    await mounted()
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')!
    expect(overlay.dataset.permissionAuthorization).toBe(surviving.plan.planId)
    overlay.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')?.click()
    await expect(survivingResult).resolves.toMatchObject({ status: 'confirmed' })
    expect(instance.window.document.querySelector('[data-permission-authorization]')).toBeNull()
    dialog.dispose()
    instance.window.close()
  })

  it('reprojects light to dark in place without replacing the focused selection', async () => {
    const instance = dom('light', true)
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const model = viewModel('runtime')
    const pending = dialog.show(model, localizedRequest().request)
    await mounted()
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')!
    const once = overlay.querySelector<HTMLInputElement>(
      '[data-permission-capability="agent.events.read"] [data-permission-decision="allow-once"]',
    )!
    once.focus()
    expect(overlay.dataset.cordisxAppTheme).toBe('light')
    instance.window.document.documentElement.className = 'electron-dark'
    await settle()
    expect(overlay.dataset.cordisxAppTheme).toBe('dark')
    expect(instance.window.document.activeElement).toBe(once)
    expect(once.querySelector<HTMLInputElement>('input')?.checked).toBe(true)
    expect(model.selection('agent.events.read')).toBe('allow-once')
    overlay.querySelector<HTMLButtonElement>('[data-permission-action="cancel"]')?.click()
    await pending
    dialog.dispose()
    instance.window.close()
  })

  it('uses only the formal semantic theme tokens and scopes all permission CSS to its removable portal', async () => {
    const instance = dom('light')
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const pending = dialog.show(viewModel(), localizedRequest().request)
    await mounted()
    const css =
      instance.window.document.querySelector<HTMLStyleElement>('[data-permission-authorization-style]')!.textContent
    expect(css).toContain('var(--cx-surface)')
    expect(css).toContain('var(--cx-backdrop)')
    expect(css).toContain('var(--cx-focus)')
    expect(css).toContain('var(--cx-danger)')
    expect(css).toContain('-webkit-app-region: no-drag')
    expect(css).toContain('.cxp-button')
    const permissionCss = css.slice(css.indexOf('.cxp-overlay'))
    expect(permissionCss).not.toMatch(/#[a-f0-9]{3,8}|rgb\(|Canvas|prefers-color-scheme/iu)
    expect([...permissionCss.matchAll(/\.([a-z][\w-]*)/g)].every(match => (
      match[1]?.startsWith('cxp-') === true || match[1]?.startsWith('t-radio') === true
    ))).toBe(true)
    instance.window.document.querySelector<HTMLButtonElement>('[data-permission-action="cancel"]')?.click()
    await pending
    dialog.dispose()
    instance.window.close()
  })

  it('commits actual React input changes once and retains open technical details through locale changes', async () => {
    const instance = dom('light')
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const model = viewModel()
    const select = vi.spyOn(model, 'select')
    const locale = localizedRequest()
    const pending = dialog.show(model, locale.request)
    const panel = instance.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    const item = panel.querySelector<HTMLElement>('[data-permission-capability="agent.events.read"]')!
    const denial = item.querySelector<HTMLElement>('.cxp-denial')!
    const details = item.querySelector<HTMLDetailsElement>('details')!
    details.open = true
    const input = item.querySelector<HTMLInputElement>('[data-permission-decision="deny-persistent"] input')!
    expect(input.classList.contains('t-radio__former')).toBe(true)
    input.click()
    expect(select).toHaveBeenCalledExactlyOnceWith('agent.events.read', 'deny-persistent')
    expect(denial.hidden).toBe(false)
    locale.setLocale('zh-CN')
    expect(item.querySelector('details')).toBe(details)
    expect(details.open).toBe(true)
    expect(item.querySelector('[data-permission-decision="deny-persistent"] input')).toBe(input)
    expect(input.checked).toBe(true)
    panel.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')!.click()
    await expect(pending).resolves.toMatchObject({
      status: 'confirmed',
      decision: {
        decisions: expect.arrayContaining([
          expect.objectContaining({ capability: 'agent.events.read', decision: 'deny-persistent' }),
        ]),
      },
    })
    expect(locale.subscribed()).toBe(false)
    input.click()
    expect(select).toHaveBeenCalledTimes(1)
    dialog.dispose()
    instance.window.close()
  })

  it('keeps one radio tab stop per capability, supports keyboard choices, and traps both Tab directions', async () => {
    const instance = dom('dark')
    const before = instance.window.document.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const model = viewModel()
    const pending = dialog.show(model, localizedRequest().request)
    const panel = instance.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    const groups = [...panel.querySelectorAll('[role="radiogroup"]')]
    for (const group of groups) expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    const group = groups[1]!
    const choices = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
    choices[0]!.focus()
    const press = (target: HTMLElement, key: string, shiftKey = false): KeyboardEvent => {
      const event = new instance.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event
    }
    expect(press(choices[0]!, 'ArrowRight').defaultPrevented).toBe(true)
    expect(instance.window.document.activeElement).toBe(choices[1])
    expect(model.selection('agent.events.read')).toBe(choices[1]!.dataset.permissionDecision)
    press(choices[1]!, 'ArrowUp')
    expect(instance.window.document.activeElement).toBe(choices[0])
    choices[2]!.focus()
    press(choices[2]!, ' ')
    expect(model.selection('agent.events.read')).toBe(choices[2]!.dataset.permissionDecision)
    choices[3]!.focus()
    press(choices[3]!, 'Enter')
    expect(model.selection('agent.events.read')).toBe(choices[3]!.dataset.permissionDecision)
    expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    const first = panel.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')!
    const confirm = panel.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')!
    confirm.focus()
    expect(press(confirm, 'Tab').defaultPrevented).toBe(true)
    expect(instance.window.document.activeElement).toBe(first)
    expect(press(first, 'Tab', true).defaultPrevented).toBe(true)
    expect(instance.window.document.activeElement).toBe(confirm)
    press(confirm, 'Escape')
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(instance.window.document.activeElement).toBe(before)
    dialog.dispose()
    instance.window.close()
  })

  it('hands off Manage permissions and removes component styles and event handlers on disposal', async () => {
    const instance = dom('light')
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const first = dialog.show(viewModel(), localizedRequest().request)
    const manage = instance.window.document.querySelector<HTMLButtonElement>('[data-permission-action="manage"]')!
    expect(manage.tagName).toBe('BUTTON')
    expect(manage.classList.contains('t-button')).toBe(true)
    manage.click()
    await expect(first).resolves.toEqual({ status: 'manage-permissions' })
    await mounted()
    const request = localizedRequest()
    const second = dialog.show(viewModel('runtime'), request.request)
    expect(instance.window.document.querySelector('[data-permission-authorization-components]')).not.toBeNull()
    dialog.dispose()
    await expect(second).resolves.toEqual({ status: 'cancelled' })
    expect(request.subscribed()).toBe(false)
    expect(instance.window.document.querySelector('[data-permission-authorization-components]')).toBeNull()
    await expect(dialog.show(viewModel(), localizedRequest().request)).resolves.toEqual({ status: 'cancelled' })
    instance.window.close()
  })

  it('cleans a failing initial render and admits the next request without a leaked active root', async () => {
    const instance = dom('dark')
    const before = instance.window.document.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
    const locale = localizedRequest()
    let count = 0
    const failed = dialog.show(viewModel(), {
      ...locale.request,
      project() {
        count += 1
        if (count === 2) throw new Error('Projection failed during mount')
        return locale.request.project()
      },
    })
    await expect(failed).rejects.toThrow('Projection failed during mount')
    expect(locale.subscribed()).toBe(false)
    expect(instance.window.document.querySelector('.cxh-tdesign-root')).toBeNull()
    expect(instance.window.document.activeElement).toBe(before)
    const survivor = dialog.show(viewModel('runtime', 'survivor'), localizedRequest().request)
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')!
    expect(overlay.dataset.permissionAuthorization).toBe('runtime-permission-plan-survivor')
    overlay.querySelector<HTMLButtonElement>('[data-permission-action="confirm"]')!.click()
    await expect(survivor).resolves.toMatchObject({ status: 'confirmed' })
    dialog.dispose()
    instance.window.close()
  })

  it.each(['throws', 'shape', 'identity', 'decisions'] as const)(
    'fails closed on locale projection %s and releases the queued review',
    async failure => {
      const instance = dom('dark')
      const dialog = new BrowserPermissionAuthorizationDialog(instance.window.document)
      const model = viewModel()
      const locale = localizedRequest()
      const failed = dialog.show(model, locale.request)
      const survivor = dialog.show(viewModel('runtime', 'survivor'), localizedRequest().request)
      const oldRoot = instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')!
      const original = model.project.bind(model)
      vi.spyOn(model, 'project').mockImplementation(input => {
        if (failure === 'throws') throw new Error('Locale projection failed')
        const value = original(input)
        if (failure === 'shape') return { ...value, items: [] }
        if (failure === 'identity') return { ...value, items: [...value.items].reverse() }
        return {
          ...value,
          items: value.items.map(item => ({ ...item, authorizationOptions: item.authorizationOptions.slice(1) })),
        }
      })
      locale.setLocale('zh-CN')
      await expect(failed).rejects.toThrow(/projection|permission decisions/u)
      await mounted()
      expect(locale.subscribed()).toBe(false)
      expect(oldRoot.isConnected).toBe(false)
      expect(oldRoot.childElementCount).toBe(0)
      expect(oldRoot.style.getPropertyValue('--cx-primary')).toBe('')
      expect(oldRoot.hasAttribute('data-cordisx-app-theme')).toBe(false)
      const roots = [...instance.window.document.querySelectorAll<HTMLElement>('[data-permission-authorization]')]
      expect(roots).toHaveLength(1)
      expect(roots[0]!.dataset.permissionAuthorization).toBe('runtime-permission-plan-survivor')
      roots[0]!.querySelector<HTMLButtonElement>('[data-permission-action="cancel"]')!.click()
      await expect(survivor).resolves.toEqual({ status: 'cancelled' })
      expect(instance.window.document.querySelector('.cxh-tdesign-root')).toBeNull()
      dialog.dispose()
      instance.window.close()
    },
  )

  it('bundles the real TDesign stylesheet and parses all component rules under the removable Host scope', async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../packages/cli/src/renderer/host-ui/tdesign-styles.ts', import.meta.url))],
      bundle: true,
      write: false,
      format: 'esm',
      loader: { '.css': 'text' },
    })
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`
    )
    let inspected = false
    const parsed = transform({
      filename: 'host-tdesign.css',
      code: Buffer.from(module.HOST_TDESIGN_REACT_STYLES),
      errorRecovery: false,
      visitor: {
        StyleSheet(sheet) {
          expect(sheet.rules).toHaveLength(3)
          const tokens = sheet.rules[1]!
          expect(tokens.type).toBe('style')
          if (tokens.type !== 'style') throw new Error('Expected Host theme tokens')
          expect(tokens.value.selectors[0]).toMatchObject([
            { type: 'class', name: 'cxh-tdesign-root' },
            { type: 'attribute', name: 'data-cordisx-app-theme' },
            { type: 'attribute', name: 'data-cordisx-theme-source' },
          ])
          const declarations = tokens.value.declarations.declarations.filter(item => item.property === 'custom')
          for (
            const [tdesign, host] of [
              ['--td-brand-color', '--cx-primary'],
              ['--td-text-color-primary', '--cx-text'],
              ['--td-bg-color-container', '--cx-surface'],
              ['--td-border-level-2-color', '--cx-border'],
              ['--td-error-color', '--cx-danger'],
            ]
          ) {
            expect(declarations.find(item => item.value.name === tdesign)?.value.value).toEqual([
              { type: 'var', value: { name: { ident: host, from: null }, fallback: null } },
            ])
          }
          expect(declarations.some(item => item.value.name === '--td-bg-color-component-disabled')).toBe(true)
          expect(declarations.some(item => item.value.name === '--td-brand-color-disabled')).toBe(true)
          const scope = sheet.rules[0]!
          expect(scope.type).toBe('scope')
          if (scope.type !== 'scope') throw new Error('Expected a Host component scope')
          expect(scope.value.scopeStart).toEqual([[{ type: 'class', name: 'cxh-tdesign-root' }]])
          const styles = scope.value.rules.filter(rule => rule.type === 'style')
          const classes = styles.flatMap(rule =>
            rule.value.selectors.flat().filter(selector => selector.type === 'class').map(selector => selector.name)
          )
          expect(classes).toContain('t-radio')
          expect(classes).toContain('t-button')
          inspected = true
        },
      },
    })
    expect(parsed.warnings).toHaveLength(0)
    expect(inspected).toBe(true)
  })
})
