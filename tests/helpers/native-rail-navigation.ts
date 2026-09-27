import type { NativeRouteSource } from '../../packages/cli/src/renderer/manager/native-route-transition.js'

/** Simulate Codex's native route and rail marking in Manager DOM tests. */
export function createNativeRouteSource(rail?: HTMLElement): NativeRouteSource & { navigate(): void } {
  let index = 0
  const listeners = new Set<() => void>()
  return {
    snapshot: () => ({
      available: true,
      key: `native-${index}`,
      index,
      nativeLocation: { pathname: index === 0 ? '/' : `/native/${index}`, search: '', hash: '' },
    }),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    navigate: () => {
      index += 1
      if (rail?.querySelector('[data-sidebar-destination][aria-current="page"]') === null) {
        const native = rail.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:automations"]')
        native?.setAttribute('aria-current', 'page')
        native?.setAttribute('data-selected', '')
      }
      for (const listener of listeners) listener()
    },
  }
}

export function bindNativeRailSelection(rail: HTMLElement): void {
  const buttons = [...rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination]')]
  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const item of buttons) {
        item.removeAttribute('aria-current')
        item.removeAttribute('data-selected')
      }
      button.setAttribute('aria-current', 'page')
      button.setAttribute('data-selected', '')
    })
  }
}
