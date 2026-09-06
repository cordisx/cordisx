import { useRef } from 'react'
import type { ManagerSettingsNavigationItemSnapshot, ManagerSnapshot } from '../../manager.js'
import { managerCopy } from '../../ui-copy.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { BrandMark } from '../../host-ui/BrandMark.js'
import { HostSurfaceIcon } from '../../host-ui/HostSurfaceIcon.js'
import type { ManagerIconToken } from '../../icons.js'
import {
  CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG,
  type ManagerNavigationVisualGroup,
  sortManagerSettingsNavigationItems,
} from '../../manager-settings-navigation.js'
import { type ManagerPrimaryPage, type ManagerRouter, primaryFor } from '../model/routes.js'

const core: readonly {
  readonly page: ManagerPrimaryPage
  readonly icon: ManagerIconToken
  readonly copy: Parameters<typeof managerCopy>[1]
  readonly group: ManagerNavigationVisualGroup
}[] = [
  { page: 'plugins', icon: 'plugins', copy: 'manager.nav.plugins', group: 'resources' },
  { page: 'marketplace', icon: 'marketplace', copy: 'manager.nav.marketplace', group: 'resources' },
  { page: 'extension-points', icon: 'outlets', copy: 'manager.nav.extension-points', group: 'development' },
  { page: 'routes', icon: 'routes', copy: 'manager.nav.routes', group: 'development' },
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

function groupLabel(locale: string, group: ManagerNavigationVisualGroup): string {
  return managerCopy(locale, `manager.nav.group.${group}`)
}

export function Navigation({ snapshot, router }: NavigationProps) {
  const navigation = useRef<HTMLElement>(null)
  const locale = snapshot.localization.locale
  const primary = router.route.kind === 'manager-content' ? undefined : primaryFor(router.route)
  const contributions = sortManagerSettingsNavigationItems(snapshot.settingsNavigationItems ?? [])
  const groups = CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.groups.flatMap(group => {
    const coreItems = core.filter(item => item.group === group.id)
    const contributedItems = contributions.filter(item => (item.navigationGroup ?? 'other') === group.id)
    return coreItems.length === 0 && contributedItems.length === 0 ? [] : [{ group, coreItems, contributedItems }]
  })
  return (
    <nav
      ref={navigation}
      className="cxr-nav"
      aria-label={managerCopy(locale, 'manager.navigation')}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        const buttons = [...(navigation.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const current = buttons.indexOf(event.target as HTMLButtonElement)
        if (current < 0 || buttons.length === 0) return
        event.preventDefault()
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowUp'
          ? (current - 1 + buttons.length) % buttons.length
          : (current + 1) % buttons.length
        buttons[next]?.focus()
      }}
    >
      {groups.map(({ group, coreItems, contributedItems }) => {
        const before = contributedItems.filter(item => item.group === 'before-settings')
        const after = contributedItems.filter(item => item.group === 'after-settings')
        const label = groupLabel(locale, group.id)
        const headingId = `cxr-navigation-group-${group.id}`
        return (
          <section
            className="cxr-nav-group"
            data-navigation-group={group.id}
            role="group"
            aria-labelledby={headingId}
            key={group.id}
          >
            <span id={headingId} className="cxr-nav-group-label" role="heading" aria-level={2}>{label}</span>
            {before.map(item => contributed(item, router))}
            {coreItems.map(item => (
              <button
                key={item.page}
                type="button"
                data-tab={item.page}
                {...(primary === item.page ? { 'aria-current': 'page' as const } : {})}
                onClick={() => router.navigate({ kind: 'primary', page: item.page })}
              >
                <HostIcon token={item.icon} state={primary === item.page ? 'active' : 'default'} />
                <span>{managerCopy(locale, item.copy)}</span>
              </button>
            ))}
            {after.map(item => contributed(item, router))}
          </section>
        )
      })}
      <span className="cxr-nav-spacer" />
      <button
        type="button"
        data-tab="about"
        {...(primary === 'about' ? { 'aria-current': 'page' as const } : {})}
        onClick={() => router.navigate({ kind: 'primary', page: 'about' })}
      >
        <BrandMark />
        <span>{managerCopy(locale, 'manager.nav.about')}</span>
      </button>
    </nav>
  )
}
