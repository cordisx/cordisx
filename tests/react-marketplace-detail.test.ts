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
    const [page, list, app] = await Promise.all([
      read('packages/cli/src/renderer/manager/pages/MarketplacePluginPage.tsx'),
      read('packages/cli/src/renderer/manager/pages/MarketplacePage.tsx'),
      read('packages/cli/src/renderer/manager/ManagerApp.tsx'),
    ])
    expect(page).toContain('cxr-plugin-identity cxr-marketplace-identity')
    expect(page).toContain('icon="import-plugin"')
    expect(page).toContain("favorite ? 'favorite-active' : 'favorite'")
    expect(page).toContain('writeMarketplaceFavorites(next)')
    expect(page).toContain('installUnavailable')
    expect(page).not.toContain('<Button tag="a"')
    expect(list).toContain('readMarketplaceFavorites')
    expect(list).toContain('writeMarketplaceFavorites(next)')
    expect(app).toContain('<MarketplacePluginPage marketplace={marketplace} snapshot={snapshot} router={route} />')
  })

  it('projects README, required permissions, and accessible source links as detail tabs', async () => {
    const [page, styles] = await Promise.all([
      read('packages/cli/src/renderer/manager/pages/MarketplacePluginPage.tsx'),
      read('packages/cli/src/renderer/manager/styles.ts'),
    ])
    expect(page).toContain("type MarketplaceDetailTab = 'readme' | 'permissions' | 'authors-source'")
    expect(page).toContain('<MarkdownDocument source={installed.readme} />')
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
