import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  installCordisXManager,
  type ManagerModel,
  type ManagerSnapshot,
} from '../packages/cli/src/renderer/manager.js'

function snapshot(): ManagerSnapshot {
  const identity = { source: 'file:///plugins/demo/index.ts', id: 'demo' }
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
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [{
        code: 'current-connection-client-unavailable',
        message: 'The current connection client is unavailable',
      }],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
    permissions: [
      {
        identity,
        capability: 'models.read',
        required: false,
        reason: { key: 'permission.models', fallback: 'Read models' },
        reasonText: '读取当前模型',
        scope: {},
        policy: 'ask',
        denialCount: 0,
      },
      {
        identity,
        capability: 'tasks.create',
        required: true,
        reason: { key: 'permission.tasks', fallback: 'Create tasks' },
        reasonText: '创建任务',
        scope: { providers: ['openai'] },
        policy: 'deny',
        denialCount: 1,
        blockedReason: 'Required capability denied: tasks.create',
      },
    ],
  }
}

function openPermissions(document: Document, pluginId: string): HTMLElement {
  document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
  document.querySelector<HTMLButtonElement>(`[data-plugin-id="${pluginId}"]`)?.click()
  document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.click()
  const content = document.querySelector<HTMLElement>('.cxm-content')
  if (content === null) throw new Error('manager content is missing')
  return content
}

function count(text: string, value: string): number {
  return text.split(value).length - 1
}

describe('Platform permission presentation hierarchy', () => {
  it('uses the selected tab as context and renders one permission group as flat peers', () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const state = snapshot()
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: () => () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)

    try {
      const content = openPermissions(dom.window.document, 'demo')
      const activeTab = dom.window.document.querySelector('[data-plugin-detail-tab="permissions"][aria-selected="true"]')
      expect(activeTab?.textContent).toBe('权限')

      const headings = [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .map(item => item.textContent?.trim())
        .filter((item): item is string => item !== undefined && item !== '')
      expect(headings).toEqual(['能力声明', '宿主连接'])
      expect(headings.every(item => !item.includes('权限'))).toBe(true)

      const policyControls = [...content.querySelectorAll<HTMLElement>('[data-permission-capability]')]
      expect(policyControls.map(item => item.dataset.permissionCapability)).toEqual(['models.read', 'tasks.create'])
      expect(policyControls.every(item => item.closest('.cxm-slot-card') === null)).toBe(true)
      expect(policyControls.every(item => item.closest('[data-permission-item]') !== null)).toBe(true)
      expect(content.querySelector('section section')).toBeNull()

      const text = content.textContent ?? ''
      expect(count(text, 'current-connection-client-unavailable')).toBe(1)
      expect(count(text, '不是安全沙箱')).toBe(1)
      expect(count(text, 'Required capability denied: tasks.create')).toBe(1)
      expect(content.querySelector('[data-permission-item="tasks.create"]')?.textContent)
        .toContain('Required capability denied: tasks.create')

      const hostHeading = [...content.querySelectorAll('h3')]
        .find(item => item.textContent?.trim() === '宿主连接')
      const hostProjection = [...(hostHeading?.parentElement?.children ?? [])]
        .slice(hostHeading === undefined ? 0 : [...hostHeading.parentElement!.children].indexOf(hostHeading) + 1)
        .map(item => item.textContent ?? '')
        .join('\n')
      expect(hostProjection).toContain('Codex Desktop')
      expect(hostProjection).toContain('current-connection-client-unavailable')
      expect(hostProjection).toContain('不是安全沙箱')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('retains the affected plugin context in the empty state without recreating the tab heading', () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const state = snapshot()
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: () => () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)

    try {
      const content = openPermissions(dom.window.document, 'empty')
      const headings = [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(item => item.textContent?.trim())
      expect(headings).toEqual(['能力声明', '宿主连接'])
      expect(content.querySelector('.cxm-empty')?.textContent).toContain('该插件')
      expect(content.textContent).not.toContain('Platform 权限')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
