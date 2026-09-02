import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  type CordisXPluginBundleManagerSnapshotV1,
} from '../packages/cli/src/plugin-bundle-contracts.js'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { ManagerApp } from '../packages/cli/src/renderer/manager/ManagerApp.js'
import type { MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => null,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

function bundles(): CordisXPluginBundleManagerSnapshotV1 {
  return {
    $schema: CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
    schemaVersion: 1,
    profileId: 'work', revision: 3, pluginRevision: 7, runtimeGeneration: 'runtime-a', operationsAvailable: true,
    bundles: [{
      id: 'team-workflow', name: 'Team Workflow', description: 'Workflow tools', version: '1.2.0',
      digest: `sha256:${'a'.repeat(64)}`, authors: ['CordisX'], sourceLabel: 'team-workflow.bundle',
      canonicalSource: 'https://plugins.example/team-workflow', installedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      status: 'active', enabled: true, readme: '# Bundle README\n\nOnly this belongs in the README panel.',
      availableOperations: ['update', 'disable', 'uninstall'],
      members: [{
        pluginId: 'notes', name: 'Notes', requestedVersion: '1.0.0', installedVersion: '1.0.0', installedDigest: `sha256:${'b'.repeat(64)}`,
        required: true, enabledByDefault: true, enabled: true, state: 'shared', installedViaBundle: true,
        bundleIds: ['team-workflow', 'other-workflow'], directClaim: false, runtimeDependentIds: ['consumer'],
      }],
      permissions: [{
        permissionId: `permission:${'c'.repeat(64)}`, pluginId: 'notes', capability: 'models.read', scopeLabel: '{}', required: true,
        bundlePolicy: 'allow', effectivePolicy: 'deny', effectiveSource: 'shared-bundle-merge', affectedBundleIds: ['team-workflow', 'other-workflow'],
      }],
      claims: [
        { pluginId: 'notes', kind: 'bundle', claimantId: 'team-workflow' },
        { pluginId: 'notes', kind: 'bundle', claimantId: 'other-workflow' },
        { pluginId: 'notes', kind: 'runtime-dependency', claimantId: 'consumer' },
      ],
      dependencies: [{ pluginId: 'consumer', dependencyId: 'notes', version: '1.0.0' }],
      records: [{ recordId: 'record-1', at: '2026-09-02T00:00:00.000Z', kind: 'install', outcome: 'applied', message: 'Installed bundle.', pluginIds: ['notes'] }],
    }],
  }
}

function snapshot(): ManagerSnapshot {
  return {
    version: 'test', plugins: [], registrations: [], commands: [], navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'zh-CN', direction: 'ltr', version: 0 }, localeCatalogs: [], localizationDiagnostics: [],
    platform: { hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable', supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false },
    permissions: [], pluginLifecycle: { profileId: 'work', revision: 7, runtimeGeneration: 'runtime-a', operationsAvailable: true },
    pluginBundles: bundles(),
  }
}

async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)) }

async function click(document: Document, selector: string): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(selector)!.click()
    await settle()
  })
}

describe('React Manager plugin bundle pages', () => {
  it('keeps header metadata above the exact five tabs and renders only README inside the README panel', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    const previous = {
      document: globalThis.document, window: globalThis.window,
      HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver, getComputedStyle: globalThis.getComputedStyle,
      requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    }
    Object.assign(globalThis, {
      document: dom.window.document, window: dom.window,
      HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
    const state = snapshot()
    const model: ManagerModel = { snapshot: () => state, setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {} }
    const seat = dom.window.document.createElement('span')
    dom.window.document.body.append(seat)
    const root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement('div')))
    try {
      await act(async () => root.render(<ManagerApp model={model} marketplace={{} as MarketplaceModel} triggerSeat={seat} />))
      await click(dom.window.document, '[data-cordisx-manager-trigger]')
      await click(dom.window.document, '[data-tab="plugin-bundles"]')
      expect(dom.window.document.querySelector('[data-plugin-bundles-page]')).not.toBeNull()
      await click(dom.window.document, '[data-plugin-bundle-id="team-workflow"]')

      const detail = dom.window.document.querySelector<HTMLElement>('[data-plugin-bundle-detail="team-workflow"]')!
      const header = detail.querySelector<HTMLElement>('.cxr-bundle-identity')!
      expect(header.textContent).toContain('CordisX')
      expect(header.textContent).toContain('team-workflow.bundle')
      expect(header.textContent).toContain('1.2.0')
      expect(header.textContent).toContain(`sha256:${'a'.repeat(64)}`)
      expect([...detail.querySelectorAll<HTMLButtonElement>('.cxr-tabs button')].map(item => item.textContent)).toEqual(['README', '成员', '权限', '关联', '记录'])

      const readme = detail.querySelector<HTMLElement>('[data-bundle-readme-only="true"]')!
      expect(readme.textContent).toContain('Only this belongs in the README panel.')
      expect(readme.textContent).not.toContain('team-workflow.bundle')
      expect(readme.textContent).not.toContain('permission-blocked')

      await click(dom.window.document, '.cxr-tabs button:nth-child(2)')
      expect(dom.window.document.querySelector('[data-bundle-member="notes"]')?.textContent).toContain('共享于')
      await click(dom.window.document, '.cxr-tabs button:nth-child(3)')
      expect(dom.window.document.querySelector('.cxr-bundle-permission-editor')?.textContent).toContain('shared-bundle-merge')
      await click(dom.window.document, '.cxr-tabs button:nth-child(4)')
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toContain('runtime-dependency')
      await click(dom.window.document, '.cxr-tabs button:nth-child(5)')
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toContain('Installed bundle.')
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      if (previousActEnvironment === undefined) delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
      else (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
      dom.window.close()
    }
  })
})
