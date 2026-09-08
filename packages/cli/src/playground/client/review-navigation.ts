/**
 * Preview-only initial navigation through the contributed Host sidebar row.
 * This intentionally exercises the same authorized route action as a user click.
 */
export function activatePlaygroundReviewNavigation(
  document: Document,
  qualifiedContributionId: string,
): () => void {
  let active = true
  let observer: MutationObserver | undefined

  const view = document.defaultView
  const state = view?.history.state
  const route = state !== null && typeof state === 'object'
    ? (state as { readonly __cordisxRouteV1?: unknown }).__cordisxRouteV1
    : undefined
  // Review mode supplies a default only for a genuinely blank first entry.
  // Refreshing an existing plugin route or Host task URL must preserve the
  // one native history stack instead of being redirected to New room.
  if (view !== null && view !== undefined && (view.location.pathname !== '/' || route !== undefined)) {
    return () => undefined
  }

  const activate = (): boolean => {
    if (!active) return false
    const row = [...document.querySelectorAll<HTMLElement>('[data-sidebar-item]')]
      .find(candidate => candidate.dataset.sidebarItem === qualifiedContributionId)
    const button = row?.querySelector<HTMLButtonElement>('.cxsi-primary')
    if (button === undefined || button === null || button.disabled) return false
    active = false
    observer?.disconnect()
    button.click()
    return true
  }

  if (!activate()) {
    const seat = document.querySelector<HTMLElement>('[data-cordisx-playground-surface="sidebar.navigation.items"]')
    const MutationObserverConstructor = document.defaultView?.MutationObserver
    if (seat !== null && MutationObserverConstructor !== undefined) {
      observer = new MutationObserverConstructor(() => {
        activate()
      })
      observer.observe(seat, { childList: true, subtree: true })
    }
  }

  return () => {
    active = false
    observer?.disconnect()
  }
}

/**
 * Authorize only the owner and extension point containing the exact configured
 * review contribution. This is a Playground-only convenience for an explicit
 * local review composition; production permission policy remains unchanged.
 */
export async function authorizePlaygroundReviewNavigation(
  runtime: Pick<PlaygroundRuntime, 'snapshot' | 'setExtensionPointPolicies'>,
  qualifiedContributionId: string,
): Promise<void> {
  const snapshot = runtime.snapshot()
  const registration = snapshot.registrations.find(candidate =>
    candidate.qualifiedId === qualifiedContributionId
    && candidate.surface === 'sidebar.navigation.items'
  )
  if (registration === undefined) return
  if (!registration.authorized && registration.pointPolicyReason !== 'permission.review-pending') return
  const plugin = snapshot.plugins.find(candidate => candidate.id === registration.owner)
  if (plugin === undefined) return
  const pointIds = registration.authorized ? [] : [registration.surface]
  const routeId = registration.item?.route?.id
  const route = routeId === undefined
    ? undefined
    : snapshot.navigation.routes.find(candidate => candidate.owner === registration.owner && candidate.id === routeId)
  if (route !== undefined && !route.authorized && route.pointPolicyReason !== 'permission.policy-denied') {
    pointIds.push(route.definition.outlet)
  }
  // manager.content is mounted through a Host-owned Manager navigation root.
  // A fresh review tab needs both seats; authorizing only the sidebar/outlet
  // leaves the root absent from Manager's public navigation projection.
  if (route?.definition.outlet === 'manager.content') {
    const root = snapshot.registrations.find(candidate =>
      candidate.owner === registration.owner && candidate.surface === 'manager.settings.navigation-items'
      && candidate.item?.route?.id === routeId
    )
    if (root !== undefined && !root.authorized && root.pointPolicyReason === 'permission.review-pending') {
      pointIds.push('manager.settings.navigation-items')
    }
  }
  if (pointIds.length === 0) return
  await runtime.setExtensionPointPolicies(
    plugin.source,
    registration.owner,
    [...new Set(pointIds)].map(pointId => ({ pointId, policy: 'allow' })),
  )
}
