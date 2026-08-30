import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
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
        plugin: { name: 'Demo', source: 'file:///plugins/demo.js', trust: 'unverified' as const, icon: 'host:settings' },
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
        return () => { if (listener === next) listener = undefined }
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
  return instance
}

async function mounted(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

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
    expect(panel.querySelectorAll('[data-permission-action="cancel"], [data-permission-action="confirm"]')).toHaveLength(2)
    expect(panel.querySelectorAll('button[data-permission-decision]')).toHaveLength(0)
    expect(panel.querySelectorAll('[data-host-form-primitive="radio"]')).not.toHaveLength(0)
    expect(panel.querySelector('[data-permission-action="confirm"]')?.classList.contains('cxf-button')).toBe(true)
    expect(panel.querySelector('[data-permission-action="confirm"]')?.getAttribute('data-variant')).toBe('primary')
    expect(panel.textContent).toContain('Plugin-provided explanation')

    const low = panel.querySelector<HTMLElement>('[data-permission-capability="models.read"]')!
    expect(low.querySelector('[data-permission-review-mode="batch-eligible"]')?.textContent).toBe('Batch review')
    expect(low.querySelector<HTMLInputElement>('[data-permission-decision="allow-persistent"]')?.checked).toBe(true)
    const sensitive = panel.querySelector<HTMLElement>('[data-permission-capability="agent.events.read"]')!
    expect(sensitive.textContent).toContain('Unavailable now')
    expect(sensitive.querySelectorAll('[data-permission-decision]')).toHaveLength(4)
    expect(sensitive.querySelector<HTMLInputElement>('[data-permission-decision="allow-once"]')?.checked).toBe(true)
    const high = panel.querySelector<HTMLElement>('[data-permission-capability="tasks.control"]')!
    expect(high.querySelector('[data-permission-review-mode="explicit"]')?.textContent).toBe('Explicit review')
    expect(high.querySelector('[data-permission-decision="allow-persistent"]')).toBeNull()
    expect(high.querySelector<HTMLInputElement>('[data-permission-decision="deny-once"]')?.checked).toBe(true)
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
    const deny = overlay.querySelector<HTMLInputElement>(
      '[data-permission-capability="agent.events.read"] [data-permission-decision="deny-persistent"]',
    )!
    deny.click()
    deny.focus()
    expect(model.selection('agent.events.read')).toBe('deny-persistent')
    const identity = deny

    localization.setLocale('zh-CN')
    expect(overlay.querySelector('h2')?.textContent).toBe('安装前确认权限')
    expect(overlay.querySelector('[data-permission-capability="agent.events.read"] h3')?.textContent).toBe('读取 Agent 事件')
    expect(instance.window.document.activeElement).toBe(identity)
    expect(identity.checked).toBe(true)

    instance.window.document.documentElement.className = 'electron-light'
    await settle()
    expect(overlay.dataset.cordisxAppTheme).toBe('light')
    expect(overlay.style.getPropertyValue('--cx-surface')).toBe('#f8fafc')
    expect(instance.window.document.activeElement).toBe(identity)
    expect(identity.checked).toBe(true)
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
    expect(instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')?.dataset.permissionAuthorization)
      .toBe(staleActive.plan.planId)

    dialog.cancel(staleQueued.plan.planId, staleQueued.plan.binding)
    await expect(queuedResult).resolves.toEqual({ status: 'cancelled' })
    expect(instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')?.dataset.permissionAuthorization)
      .toBe(staleActive.plan.planId)

    dialog.cancel(staleActive.plan.planId, { ...staleActive.plan.binding, moduleGeneration: 'module-other' })
    expect(instance.window.document.querySelector<HTMLElement>('[data-permission-authorization]')?.dataset.permissionAuthorization)
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
    expect(once.checked).toBe(true)
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
    const css = instance.window.document.querySelector<HTMLStyleElement>('[data-permission-authorization-style]')!.textContent
    expect(css).toContain('var(--cx-surface)')
    expect(css).toContain('var(--cx-backdrop)')
    expect(css).toContain('var(--cx-focus)')
    expect(css).toContain('var(--cx-danger)')
    expect(css).toContain('-webkit-app-region: no-drag')
    expect(css).toContain('.cxf-button')
    const permissionCss = css.slice(css.indexOf('.cxp-overlay'))
    expect(permissionCss).not.toMatch(/#[a-f0-9]{3,8}|rgb\(|Canvas|prefers-color-scheme/iu)
    expect([...permissionCss.matchAll(/\.([a-z][\w-]*)/g)].every(match => (
      match[1]?.startsWith('cxp-') === true || match[1]?.startsWith('cxf-') === true
    ))).toBe(true)
    instance.window.document.querySelector<HTMLButtonElement>('[data-permission-action="cancel"]')?.click()
    await pending
    dialog.dispose()
    instance.window.close()
  })
})
