import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectPermissionCapabilityName } from '../packages/cli/src/permission-locales.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function read(relative: string): Promise<string> {
  return await readFile(path.join(projectRoot, relative), 'utf8')
}

describe('React Marketplace plugin detail', () => {
  it('projects Host capability names from the canonical permission catalogs', () => {
    expect(projectPermissionCapabilityName('models.read', 'zh-CN')).toBe('读取可用模型')
    expect(projectPermissionCapabilityName('models.read', 'en-US')).toBe('Read available models')
  })

  it('uses an installed-style identity header with honest install and persistent favorite actions', async () => {
    const [page, list, app, installer] = await Promise.all([
      read('packages/cli/src/renderer/manager/pages/MarketplacePluginPage.tsx'),
      read('packages/cli/src/renderer/manager/pages/MarketplacePage.tsx'),
      read('packages/cli/src/renderer/manager/ManagerApp.tsx'),
      read('packages/cli/src/renderer/manager/model/use-marketplace-installer.ts'),
    ])
    expect(page).toContain('cxr-plugin-identity cxr-marketplace-identity')
    expect(page).toContain("favorite ? 'favorite-active' : 'favorite'")
    expect(page).toContain('writeMarketplaceFavorites(next)')
    expect(page).toContain('useManagerMarketplaceInstaller')
    expect(page).toContain("icon={installing ? 'close' : 'import-plugin'}")
    expect(page).toContain('const installedVersion = installed?.package?.version')
    expect(page).toContain('item.id === plugin.id && item.source === plugin.source')
    expect(page).toContain('const unmanagedInstalled = installed !== undefined && installedVersion === undefined')
    expect(page).toContain('const installDisabled = unmanagedInstalled || exactVersionInstalled')
    expect(page).toContain('usePluginLifecycleActions')
    expect(page).toContain(': installedVersion === undefined')
    expect(page).toContain(': copy.update}')
    expect(page).toContain('disabled={!installing && (installDisabled || (')
    expect(page).toContain('lifecycle.busyPluginId !== undefined && lifecycle.busyPluginId === installed?.id')
    expect(page).toContain('plugin.artifact === undefined')
    expect(page).not.toContain('<Button tag="a"')
    expect(list).toContain('readMarketplaceFavorites')
    expect(list).toContain('writeMarketplaceFavorites(next)')
    expect(list).toContain('useManagerMarketplaceInstaller')
    expect(list).toContain('void installer.run(result.plugin, result.projection.name)')
    expect(app).toContain('const installer = useMarketplaceInstaller')
    expect(app).toContain('<MarketplaceInstallerProvider installer={installer}>')
    expect(app.replace(/\s+/gu, ' ')).toContain(
      '<MarketplacePluginPage manager={model} marketplace={marketplace} snapshot={snapshot} router={route} '
        + 'pluginManagement={pluginManagement} pluginManagementSnapshot={pluginManagementSnapshot} />',
    )
    expect(installer).toContain('item.identity.source === planV4.identity.source')
    expect(installer).toContain('item.identity.source === planV2.identity.source')
  })

  it('projects README, required permissions, and accessible source links as detail tabs', async () => {
    const [page, styles] = await Promise.all([
      read('packages/cli/src/renderer/manager/pages/MarketplacePluginPage.tsx'),
      read('packages/cli/src/renderer/manager/styles.ts'),
    ])
    expect(page).toContain("type MarketplaceDetailTab = 'readme' | 'permissions' | 'authors-source'")
    expect(page).toContain('manager.previewMarketplaceArtifact')
    expect(page).toContain('const readme = installed?.readme ?? marketplaceReadme')
    expect(page).toContain('<MarkdownDocument source={readme} />')
    expect(page).toContain('managerSnapshot.permissions.filter')
    expect(page).toContain('searchPermissionsLabel')
    expect(page).toContain('visiblePermissions.map')
    expect(page).toContain('projectPermissionCapabilityName')
    expect(page).toContain('<span className="cxr-card-title">{permissionName(item.capability)}</span>')
    expect(page).toContain('<code className="cxr-card-code">{item.capability}</code>')
    expect(page).toContain('cxr-list cxr-permission-list')
    expect(page).toContain('<article className="cxr-card cxr-permission-summary" role="listitem"')
    expect(page).not.toContain('permissionReason')
    expect(styles).toContain(
      '.cxr-permission-summary .cxr-card-description { overflow: visible; text-overflow: clip; white-space: normal; }',
    )
    expect(styles).toContain('.cxr-permission-list { grid-template-columns: minmax(0,1fr); }')
    expect(page).not.toContain("router.navigate({ kind: 'permission'")
    expect(page).toContain('item.required ? copy.required : copy.optional')
    expect(page).toContain('cxr-marketplace-detail-grid')
    expect(page).toContain('target="_blank" rel="noopener noreferrer"')
    expect(page).toContain('aria-label={externalLabel(link.label)}')
    expect(page).toContain('该商店记录尚未提供可预览的权限清单')
  })
})
