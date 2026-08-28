import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
} from '../packages/cli/src/contracts.js'
import {
  installCordisXManager,
  projectManagerBreadcrumbs,
  requestPluginAuthorization,
  type ManagerModel,
  type ManagerPermissionSnapshot,
  type ManagerSnapshot,
} from '../packages/cli/src/renderer/manager.js'

const identity = { source: 'file:///plugins/demo/index.ts', id: 'demo' }
type TestTDesignSelect = HTMLElement & {
  disabled: boolean
  options: readonly { readonly value: string; readonly label: string }[]
  setSelectedValue(value: string | undefined, notify?: boolean): void
}

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
    availability: {
      status: 'unavailable',
      reasonText: '没有宿主提供方可路由声明范围',
      providers: [],
    },
    ...overrides,
  }
}

function snapshot(
  supportedCapabilities: ManagerSnapshot['platform']['supportedCapabilities'] = [],
  locale: 'en' | 'zh-CN' = 'zh-CN',
): ManagerSnapshot {
  return {
    version: '0.1.0',
    plugins: [
      { id: 'demo', source: identity.source, name: 'Demo', inject: [], config: {}, status: 'active' },
      { id: 'empty', source: 'file:///plugins/empty/index.ts', name: 'Empty', inject: [], config: {}, status: 'active' },
    ],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale, direction: 'ltr', version: 1 },
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
        availability: {
          status: 'unavailable',
          reasonText: '没有宿主提供方可路由声明范围',
          providers: [{
            providerId: 'external:openai',
            providerNameText: 'OpenAI Fleet',
            kind: 'external-provider',
            family: 'platform',
            status: 'unavailable',
            reasonText: 'OpenAI Fleet 当前不可用',
            scope: { providers: ['openai'] },
          }],
        },
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
  it('keeps root/current visible and moves only middle ancestors into overflow', () => {
    expect(projectManagerBreadcrumbs([62, 94, 72, 88], 205, 42)).toEqual({
      visible: [0, 3],
      overflow: [1, 2],
    })
    expect(projectManagerBreadcrumbs([62, 94, 72, 88], 400, 42)).toEqual({
      visible: [0, 1, 2, 3],
      overflow: [],
    })
  })

  it('uses distinct Host-owned labels for Agent capability rows and breadcrumbs', () => {
    const state = {
      ...snapshot(),
      permissions: [
        permission('agent.events.read'),
        permission('agent.history.read'),
        permission('agent.messages.append'),
      ],
    }
    const { dom, dispose } = install(state)
    try {
      const content = openPluginTab(dom.window.document, 'demo', 'permissions')
      expect([...content.querySelectorAll('[data-permission-item]')].map(item => item.getAttribute('aria-label'))).toEqual([
        '读取 Agent 事件', '读取 Agent 历史', '追加 Agent 消息',
      ])
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-open="agent.events.read"]')?.click()
      expect(dom.window.document.querySelector('[data-breadcrumb-current]')?.textContent).toBe('读取 Agent 事件')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('reviews required and optional declarations once with persistent allow as the primary action', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    const permissions = [
      permission('models.read', { required: true, reasonText: '读取当前账号模型' }),
      permission('turns.submit', { reasonText: '提交后续消息', policy: 'deny' }),
    ]
    const pending = requestPluginAuthorization(dom.window.document, { id: 'demo', name: 'Demo' }, {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
      schemaVersion: 1,
      planId: 'generation-1:demo',
      operation: 'enable',
      profileId: 'work',
      identity: { source: identity.source, pluginId: identity.id },
      defaultDecision: 'allow',
      declarations: permissions.map(item => ({
        capability: item.capability,
        required: item.required,
        reason: item.reason,
        scope: item.scope,
        policy: item.policy,
        decisionRequired: item.policy === 'ask',
      })),
    }, permissions)
    const dialog = dom.window.document.querySelector<HTMLElement>('[data-permission-authorization="demo"]')
    expect(dialog?.dataset.cordisxAppTheme).toBe('dark')
    dom.window.document.documentElement.className = 'electron-light'
    await Promise.resolve()
    expect(dialog?.dataset.cordisxAppTheme).toBe('light')
    expect(dialog?.querySelectorAll('h2')).toHaveLength(1)
    expect(dialog?.textContent?.match(/启用授权/g)).toHaveLength(1)
    expect(dialog?.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(dialog?.querySelector('[data-authorization-capability="models.read"]')?.textContent).toContain('必需')
    expect(dialog?.querySelector('[data-authorization-capability="turns.submit"]')?.textContent).toContain('可选')
    const required = dialog?.querySelector<HTMLInputElement>('[data-authorization-choice="models.read"]')
    const optional = dialog?.querySelector<HTMLInputElement>('[data-authorization-choice="turns.submit"]')
    expect(required).toMatchObject({ checked: true, disabled: true })
    expect(optional).toMatchObject({ checked: true, disabled: false })
    expect(dialog?.querySelector('.cxm-slot-card')).toBeNull()
    const primary = dialog?.querySelector<HTMLButtonElement>('[data-authorization-decision="allow"]')
    expect(primary?.dataset.primary).toBe('true')
    expect(dom.window.document.activeElement).toBe(primary)
    optional?.click()
    primary?.click()
    await expect(pending).resolves.toEqual({
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
      schemaVersion: 1,
      planId: 'generation-1:demo',
      operation: 'enable',
      profileId: 'work',
      identity: { source: identity.source, pluginId: identity.id },
      decisions: [
        { capability: 'models.read', scope: {}, decision: 'allow' },
        { capability: 'turns.submit', scope: {}, decision: 'deny' },
      ],
    })
    dom.window.close()
  })

  it('reuses the same centralized review contract for a future installer', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const modelPermission = permission('models.read', { required: true })
    const pending = requestPluginAuthorization(dom.window.document, { id: 'demo', name: 'Demo' }, {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
      schemaVersion: 1,
      planId: 'generation-1:demo',
      operation: 'install',
      profileId: 'work',
      identity: { source: identity.source, pluginId: identity.id },
      defaultDecision: 'allow',
      declarations: [{
        capability: modelPermission.capability,
        required: true,
        reason: modelPermission.reason,
        scope: modelPermission.scope,
        policy: 'ask',
        decisionRequired: true,
      }],
    }, [modelPermission])
    const dialog = dom.window.document.querySelector<HTMLElement>('[data-permission-authorization="demo"]')
    expect(dialog?.querySelector('h2')?.textContent).toBe('安装授权')
    expect(dialog?.querySelector('[data-authorization-decision="allow"]')?.textContent).toBe('始终允许并安装')
    dialog?.querySelector<HTMLButtonElement>('[data-authorization-decision="cancel"]')?.click()
    await expect(pending).resolves.toBeUndefined()
    dom.window.close()
  })

  it('renders a concise flat list with host-owned names and unavailable policy selects', () => {
    const { dom, dispose } = install(snapshot())
    try {
      const content = openPluginTab(dom.window.document, 'demo', 'permissions')
      expect(content.querySelector('[role="tabpanel"][aria-label="权限"]')).not.toBeNull()
      expect(content.querySelectorAll('[role="listitem"][data-permission-item]')).toHaveLength(7)
      expect([...content.querySelectorAll('[data-permission-item]')].map(item => item.getAttribute('aria-label'))).toEqual([
        '读取可用模型', '查看任务列表', '查看任务内容', '创建任务', '管理任务', '提交消息', '控制对话轮次',
      ])
      const capabilityIcons = [...content.querySelectorAll<HTMLElement>('.cxm-capability-icon[aria-hidden="true"][data-host-icon-key]')]
      expect(capabilityIcons).toHaveLength(7)
      expect(capabilityIcons.map(icon => icon.dataset.hostIconKey)).toEqual([
        'models-read', 'tasks-catalog-read', 'tasks-content-read', 'tasks-create', 'tasks-control', 'turns-submit', 'turns-control',
      ])
      expect(content.querySelector('[data-permission-item="tasks.create"] .cxm-required-badge')?.textContent).toBe('必需')
      expect(content.querySelector('[data-permission-item="models.read"] .cxm-required-badge')).toBeNull()
      expect(content.querySelectorAll('[data-permission-availability]')).toHaveLength(0)
      expect(content.querySelectorAll('[data-permission-capability]')).toHaveLength(7)
      const unavailablePolicies = [...content.querySelectorAll<TestTDesignSelect>('t-select[data-permission-capability]')]
      expect(unavailablePolicies.every(policy => policy.disabled)).toBe(true)
      expect(unavailablePolicies.every(policy => policy.options.map(option => option.label).join() === '不可用')).toBe(true)
      expect(content.querySelector('.cxm-slot-card')).toBeNull()
      expect([...content.querySelectorAll('h3')].map(item => item.textContent)).not.toContain('权限策略')

      const text = content.textContent ?? ''
      for (const hidden of [
        'models.read', '{}', '最近使用', '拒绝次数', 'Required capability denied',
        'current-connection-client-unavailable', '二次连接', '原始 bridge', '不是安全沙箱',
        '插件声明所需能力；Host 负责策略选择、持久化与执行。',
      ]) expect(text).not.toContain(hidden)
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('makes unavailable capabilities honestly non-editable without offering inactive policies', async () => {
    const state = snapshot(['models.read', 'tasks.create'])
    const { dom, dispose, policies } = install(state)
    try {
      const content = openPluginTab(dom.window.document, 'demo', 'permissions')
      const models = content.querySelector<TestTDesignSelect>('t-select[data-permission-capability="models.read"]')
      const createTask = content.querySelector<TestTDesignSelect>('t-select[data-permission-capability="tasks.create"]')
      expect(models).not.toBeNull()
      expect(createTask).not.toBeNull()
      expect(models!.options.map(option => [option.value, option.label])).toEqual([['ask', '不可用']])
      expect(createTask!.options.map(option => [option.value, option.label])).toEqual([['deny', '不可用']])
      expect(models!.disabled).toBe(true)
      expect(createTask!.disabled).toBe(true)
      expect(content.querySelector('[data-permission-capability="tasks.catalog.read"]')).not.toBeNull()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(policies).toEqual([])
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('opens a third-level permission detail with an honest unavailable policy and returns to the permission tab', async () => {
    const state = snapshot()
    const { dom, dispose, policies } = install(state)
    try {
      openPluginTab(dom.window.document, 'demo', 'permissions')
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-open="tasks.create"]')?.click()
      const detail = dom.window.document.querySelector<HTMLElement>('[data-permission-detail="tasks.create"]')
      expect(detail).not.toBeNull()
      const breadcrumb = [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-breadcrumb-action, .cxm-breadcrumb-current')]
      expect(breadcrumb.map(item => item.textContent)).toEqual(['插件', 'Demo', '权限', '创建任务'])
      expect(breadcrumb.slice(0, -1).every(item => item.matches('button[data-breadcrumb-target]'))).toBe(true)
      expect(breadcrumb.at(-1)?.matches('span[aria-current="page"]')).toBe(true)
      expect(detail?.textContent).toContain('申请使用对应的宿主功能')
      expect(detail?.textContent).toContain('必需权限')
      expect(detail?.textContent).toContain('不可用')
      expect(detail?.textContent).toContain('tasks.create')
      expect(detail?.textContent).toContain('openai')
      expect(detail?.textContent).toContain('OpenAI Fleet')
      expect(detail?.textContent).toContain('OpenAI Fleet 当前不可用')
      expect(detail?.querySelectorAll('[role="listitem"][data-permission-provider]')).toHaveLength(1)
      const headings = [...(detail?.querySelectorAll('h1, h2, h3') ?? [])].map(item => item.textContent)
      expect(new Set(headings).size).toBe(headings.length)
      expect(detail?.textContent).toContain('本次运行审计')
      expect(detail?.textContent).toContain('最近拒绝：2026-08-23T00:00:00.000Z')
      expect(detail?.textContent).not.toContain('current-connection-client-unavailable')

      const policy = detail?.querySelector<TestTDesignSelect>('t-select[data-permission-capability="tasks.create"]')
      expect(policy!.options.map(option => option.label)).toEqual(['不可用'])
      expect(policy!.disabled).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(policies).toEqual([])
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
      expect(dom.window.document.querySelector('[data-permission-detail]')).toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
      expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="权限"]')).not.toBeNull()
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('projects constrained middle ancestors into an ordered, navigable ellipsis menu', async () => {
    const state = snapshot()
    const { dom, dispose } = install(state)
    try {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('cxm-breadcrumbs') ? 190 : 0
        },
      })
      const rect = dom.window.HTMLElement.prototype.getBoundingClientRect
      Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value(this: HTMLElement) {
          if (this.classList.contains('cxm-breadcrumb-item')) {
            const width = Math.max(54, (this.textContent?.length ?? 0) * 15 + 18)
            return { x: 0, y: 0, top: 0, right: width, bottom: 24, left: 0, width, height: 24, toJSON: () => ({}) }
          }
          return rect.call(this)
        },
      })
      openPluginTab(dom.window.document, 'demo', 'permissions')
      dom.window.document.querySelector<HTMLButtonElement>('[data-permission-open="tasks.create"]')?.click()
      await Promise.resolve()

      const breadcrumbs = dom.window.document.querySelector<HTMLElement>('.cxm-breadcrumbs')
      expect(breadcrumbs?.dataset.breadcrumbOverflowCount).toBe('2')
      expect([...dom.window.document.querySelectorAll<HTMLElement>('.cxm-breadcrumb-list > .cxm-breadcrumb-item > .cxm-breadcrumb-action, .cxm-breadcrumb-list > .cxm-breadcrumb-item > .cxm-breadcrumb-current')]
        .map(item => item.textContent)).toEqual(['插件', '创建任务'])
      const overflow = dom.window.document.querySelector<HTMLDetailsElement>('.cxm-breadcrumb-overflow')
      expect(overflow?.querySelector('summary')?.getAttribute('aria-label')).toBe('显示省略的上级页面')
      const menuItems = [...(overflow?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      expect(menuItems.map(item => item.textContent)).toEqual(['Demo', '权限'])
      menuItems.at(-1)?.click()
      expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="权限"]')).not.toBeNull()
      expect(dom.window.history.length).toBe(1)
      expect(dom.window.location.href).toBe('https://codex.local/')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('keeps only actionable Host diagnostics in collapsed logs diagnostics', () => {
    const { dom, dispose } = install(snapshot())
    try {
      const permissions = openPluginTab(dom.window.document, 'empty', 'permissions')
      expect(permissions.textContent).toContain('该插件没有申请任何权限。')
      expect(permissions.querySelector('[role="list"]')).toBeNull()
      expect(permissions.textContent).not.toContain('Codex Desktop')

      const runtime = openPluginTab(dom.window.document, 'demo', 'runtime')
      expect(runtime.querySelector('[data-plugin-runtime-action="demo"]')?.getAttribute('aria-label')).toBe('屏蔽插件')
      expect(runtime.querySelector('[data-runtime-lifecycle="demo"]')).toBeNull()
      const logs = openPluginTab(dom.window.document, 'demo', 'logs')
      expect(logs.querySelector('[data-runtime-lifecycle="demo"]')).toBeNull()
      const diagnostics = logs.querySelector<HTMLDetailsElement>('details[data-runtime-diagnostics="platform"]')
      expect(diagnostics).not.toBeNull()
      expect(diagnostics?.open).toBe(false)
      expect(diagnostics?.querySelector('summary')?.textContent).toBe('诊断')
      expect(diagnostics?.textContent).toContain('current-connection-client-unavailable')
      expect(diagnostics?.textContent).not.toContain('二次连接')
      expect(diagnostics?.textContent).not.toContain('原始 bridge')
      expect(diagnostics?.textContent).not.toContain('当前权限仅适用于 Host API 调用。')
      expect(diagnostics?.textContent).not.toContain('查看权限说明')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('localizes actionable diagnostics chrome for English', () => {
    const { dom, dispose } = install(snapshot([], 'en'))
    try {
      const runtime = openPluginTab(dom.window.document, 'demo', 'runtime')
      expect(runtime.querySelector('[data-runtime-lifecycle="demo"]')).toBeNull()
      expect(runtime.querySelector('[data-plugin-runtime-action="demo"]')?.getAttribute('aria-label')).toBe('Block plugin')
      const logs = openPluginTab(dom.window.document, 'demo', 'logs')
      const diagnostics = logs.querySelector<HTMLDetailsElement>('details[data-runtime-diagnostics="platform"]')
      expect(logs.querySelector('[data-runtime-lifecycle="demo"]')).toBeNull()
      expect(diagnostics?.open).toBe(false)
      expect(diagnostics?.querySelector('summary')?.textContent).toBe('Diagnostics')

      diagnostics!.open = true
      expect(diagnostics?.querySelectorAll('h3')).toHaveLength(0)
      expect(diagnostics?.textContent).toContain('current-connection-client-unavailable')
      expect(diagnostics?.textContent).not.toContain('Permissions apply only to Host API calls.')
      expect(diagnostics?.textContent).not.toContain('View permission documentation')
      expect(diagnostics?.textContent).not.toMatch(/[\u3400-\u9fff]/u)
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
