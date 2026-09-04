import type { ManagerSettingsNavigationItemSnapshot, ManagerSnapshot } from '../../manager.js'
import { managerCopy } from '../../ui-copy.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { BrandMark } from '../../host-ui/BrandMark.js'
import { HostSurfaceIcon } from '../../host-ui/HostSurfaceIcon.js'
import type { ManagerIconToken } from '../../icons.js'
import { sortManagerSettingsNavigationItems } from '../../manager-settings-navigation.js'
import { primaryFor, type ManagerPrimaryPage, type ManagerRouter } from '../model/routes.js'

const core: readonly { readonly page: ManagerPrimaryPage; readonly icon: ManagerIconToken; readonly copy: Parameters<typeof managerCopy>[1] }[] = [
  { page: 'plugins', icon: 'plugins', copy: 'manager.nav.plugins' },
  { page: 'plugin-bundles', icon: 'plugins', copy: 'manager.nav.plugin-bundles' },
  { page: 'extension-points', icon: 'outlets', copy: 'manager.nav.extension-points' },
  { page: 'routes', icon: 'routes', copy: 'manager.nav.routes' },
  { page: 'marketplace', icon: 'marketplace', copy: 'manager.nav.marketplace' },
]

export interface NavigationProps {
  readonly snapshot: ManagerSnapshot
  readonly router: ManagerRouter
}

function contributed(item: ManagerSettingsNavigationItemSnapshot, router: ManagerRouter) {
  const active = router.route.kind === 'manager-content' && router.route.id === item.id
  return (
    <button
      key={item.id}
      type="button"
      disabled={item.disabled}
      title={item.disabledReason}
      data-settings-navigation-item={item.id}
      {...(active ? { 'aria-current': 'page' as const } : {})}
      onClick={() => router.navigate({ kind: 'manager-content', id: item.id, reference: item.route })}
    >
      <HostSurfaceIcon token={item.icon} state={active ? 'active' : 'default'} />
      <span>{item.title}</span>
    </button>
  )
}

export function Navigation({ snapshot, router }: NavigationProps) {
  const locale = snapshot.localization.locale
  const primary = router.route.kind === 'manager-content' ? undefined : primaryFor(router.route)
  const contributions = sortManagerSettingsNavigationItems(snapshot.settingsNavigationItems ?? [])
  return (
    <nav className="cxr-nav" aria-label={managerCopy(locale, 'manager.navigation')}>
      {core.map(item => (
        <button key={item.page} type="button" data-tab={item.page} {...(primary === item.page ? { 'aria-current': 'page' as const } : {})} onClick={() => router.navigate({ kind: 'primary', page: item.page })}>
          <HostIcon token={item.icon} state={primary === item.page ? 'active' : 'default'} />
          <span>{managerCopy(locale, item.copy)}</span>
        </button>
      ))}
      {contributions.filter(item => item.group === 'before-settings').map(item => contributed(item, router))}
      {contributions.filter(item => item.group === 'after-settings').map(item => contributed(item, router))}
      <span className="cxr-nav-spacer" />
      <button type="button" data-tab="about" {...(primary === 'about' ? { 'aria-current': 'page' as const } : {})} onClick={() => router.navigate({ kind: 'primary', page: 'about' })}>
        <BrandMark />
        <span>{managerCopy(locale, 'manager.nav.about')}</span>
      </button>
    </nav>
  )
}
