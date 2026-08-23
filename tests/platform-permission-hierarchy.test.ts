import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  installCordisXManager,
  type ManagerModel,
  type ManagerPermissionSnapshot,
  type ManagerSnapshot,
} from '../packages/cli/src/renderer/manager.js'

const identity = { source: 'file:///plugins/demo/index.ts', id: 'demo' }

function permission(
  capability: ManagerPermissionSnapshot['capability'],
  overrides: Partial<ManagerPermissionSnapshot> = {},
): ManagerPermissionSnapshot {
  return {
    identity,
    capability,
    required: false,
    reason: { key: `permission.${capability}`, fallback: `Reason for ${capability}` },
    reasonText: '申请使用对应的宿主功能',
    scope: {},
    policy: 'ask',
    denialCount: 0,
    ...overrides,
  }
}

function snapshot(supportedCapabilities: ManagerSnapshot['platform']['supportedCapabilities'] = []): ManagerSnapshot {
  return {
    version: '0.1.0',
    plugins: [
      { id: 'demo', source: identity.source, name: 'Demo', inject: [], config: {}, status: 'active' },
      { id: 'empty', source: 'file:///plugins/empty/index.ts', name: 'Empty', inject: [], config: {}, status: 'active' },
    ],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'zh-CN', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: supportedCapabilities.length === 0 ? 'unavailable' : 'read-write',
      supportedCapabilities,
      diagnostics: [{
        code: 'current-connection-client-unavailable',
        message: 'The current connection client is unavailable',
      }],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
    permissions: [
      permission('models.read'),
      permission('tasks.catalog.read'),
      permission('tasks.content.read'),
      permission('tasks.create', {
        required: true,
        scope: { providers: ['openai'] },
        policy: 'deny',
        lastDeniedAt: '2026-08-23T00:00:00.000Z',
        denialCount: 1,
        blockedReason: 'Required capability denied: tasks.create',
      }),
      permission('tasks.control'),
      permission('turns.submit'),
      permission('turns.control'),
    ],
  }
}

function install(state: ManagerSnapshot): { dom: JSDOM; dispose: () => void; policies: string[] } {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
  const policies: string[] = []
  const model: ManagerModel = {
    snapshot: () => state,
    setPluginBlocked: async () => {},
    setPermissionPolicy: async (_id, capability, policy) => {
      policies.push(`${capability}:${policy}`)
    },
    subscribe: () => () => {},
  }
  return { dom, dispose: installCordisXManager(dom.window.document, model), policies }
}

function openPluginTab(document: Document, pluginId: string, tab: 'permissions' | 'runtime'): HTMLElement {
  document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
  document.querySelector<HTMLButtonElement>(`[data-plugin-id="${pluginId}"]`)?.click()
  document.querySelector<HTMLButtonElement>(`[data-plugin-detail-tab="${tab}"]`)?.click()
  const content = document.querySelector<HTMLElement>('.cxm-content')
  if (content === null) throw new Error('manager content is missing')
  return content
}

describe('Platform permission presentation hierarchy', () => {
  it('renders a concise flat list with host-owned names, icons, support state, and no engineering details', () => {
    const { dom, dispose } = install(snapshot())
    try {
      const content = openPluginTab(dom.window.document, 'demo', 'permissions')
      expect(content.querySelector('[role="tabpanel"][aria-label="权限"]')).not.toBeNull()
      expect(content.querySelectorAll('[role="listitem"][data-permission-item]')).toHaveLength(7)
      expect([...content.querySelectorAll('[data-permission-item]')].map(item => item.getAttribute('aria-label'))).toEqual([
        '读取可用模型', '查看任务列表', '查看任务内容', '创建任务', '管理任务', '提交消息', '控制对话轮次',
      ])
      expect(content.querySelectorAll('.cxm-capability-icon[aria-hidden="true"] svg')).toHaveLength(7)
      expect(content.querySelector('[data-permission-item="tasks.create"] .cxm-required-badge')?.textContent).toBe('必需')
      expect(content.querySelector('[data-permission-item="models.read"] .cxm-required-badge')).toBeNull()
      expect(content.querySelectorAll('[data-permission-unavailable]')).toHaveLength(7)
      expect(content.querySelector('[data-permission-capability]')).toBeNull()
      expect(content.querySelector('.cxm-slot-card')).toBeNull()
      expect(content.querySelector('h3')).toBeNull()

      const text = content.textContent ?? ''
      for (const hidden of [
        'models.read', '{}', '最近使用', '拒绝次数', 'Required capability denied',
        'current-connection-client-unavailable', '二次连接', '原始 bridge', '不是安全沙箱',
      ]) expect(text).not.toContain(hidden)
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('shows all three localized policies only for capabilities supported by the current host', async () => {
    const state = snapshot(['models.read', 'tasks.create'])
    const { dom, dispose, policies } = install(state)
    try {
      const content = openPluginTab(dom.window.document, 'demo', 'permissions')
      const models = content.querySelector<HTMLSelectElement>('[data-permission-capability="models.read"]')
      const createTask = content.querySelector<HTMLSelectElement>('[data-permission-capability="tasks.create"]')
      expect(models).not.toBeNull()
      expect(createTask).not.toBeNull()
      expect([...models!.options].map(option => [option.value, option.textContent])).toEqual([
        ['ask', '每次询问'], ['allow', '始终允许'], ['deny', '始终拒绝'],
      ])
      expect(content.querySelector('[data-permission-capability="tasks.catalog.read"]')).toBeNull()
      models!.value = 'allow'
      models!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(policies).toEqual(['models.read:allow'])
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('opens a third-level permission detail, keeps policy recovery available, and returns to the permission tab', async () => {
    const state = snapshot()
    const { dom, dispose, policies } = install(state)
    try {
      openPluginTab(dom.window.document, 'demo', 'permissions')
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-open="tasks.create"]')?.click()
      const detail = dom.window.document.querySelector<HTMLElement>('[data-permission-detail="tasks.create"]')
      expect(detail).not.toBeNull()
      expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('权限/创建任务')
      expect(detail?.textContent).toContain('申请使用对应的宿主功能')
      expect(detail?.textContent).toContain('必需权限')
      expect(detail?.textContent).toContain('当前宿主暂不支持')
      expect(detail?.textContent).toContain('tasks.create')
      expect(detail?.textContent).toContain('openai')
      expect(detail?.textContent).toContain('本次运行审计')
      expect(detail?.textContent).toContain('最近拒绝：2026-08-23T00:00:00.000Z')
      expect(detail?.textContent).not.toContain('current-connection-client-unavailable')

      const policy = detail?.querySelector<HTMLSelectElement>('[data-permission-capability="tasks.create"]')
      expect([...policy!.options].map(option => option.textContent)).toEqual(['每次询问', '始终允许', '始终拒绝'])
      policy!.value = 'ask'
      policy!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(policies).toEqual(['tasks.create:ask'])
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
      expect(dom.window.document.querySelector('[data-permission-detail]')).toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
      expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="权限"]')).not.toBeNull()
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('moves host connection and security engineering facts into collapsed runtime diagnostics', () => {
    const { dom, dispose } = install(snapshot())
    try {
      const permissions = openPluginTab(dom.window.document, 'empty', 'permissions')
      expect(permissions.textContent).toContain('该插件没有申请任何权限。')
      expect(permissions.querySelector('[role="list"]')).toBeNull()
      expect(permissions.textContent).not.toContain('Codex Desktop')

      const runtime = openPluginTab(dom.window.document, 'demo', 'runtime')
      const diagnostics = runtime.querySelector<HTMLDetailsElement>('details[data-runtime-diagnostics="platform"]')
      expect(diagnostics).not.toBeNull()
      expect(diagnostics?.open).toBe(false)
      expect(diagnostics?.querySelector('summary')?.textContent).toBe('诊断')
      expect(diagnostics?.textContent).toContain('current-connection-client-unavailable')
      expect(diagnostics?.textContent).toContain('二次连接 否')
      expect(diagnostics?.textContent).toContain('原始 bridge 暴露 否')
      expect(diagnostics?.textContent).toContain('不是安全沙箱')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
