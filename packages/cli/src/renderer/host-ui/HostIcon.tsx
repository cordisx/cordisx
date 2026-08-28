import { useLayoutEffect, useRef } from 'react'
import type { SemanticIconKey } from '../../icon-theme-contracts.js'
import {
  MANAGER_ICON_SEMANTICS,
  iconThemeRegistryForDocument,
  renderHostIconSvg,
  type HostIconState,
  type ManagerIconToken,
} from '../icons.js'
import { resolveHostTheme } from '../host-theme.js'

export interface HostIconProps {
  readonly token: ManagerIconToken | SemanticIconKey
  readonly className?: string
  readonly size?: number | string
  readonly state?: HostIconState
  readonly surfaceToken?: string
}

function semanticKey(token: ManagerIconToken | SemanticIconKey): SemanticIconKey {
  return token in MANAGER_ICON_SEMANTICS
    ? MANAGER_ICON_SEMANTICS[token as ManagerIconToken]
    : token as SemanticIconKey
}

/** React adapter for the exact same Host-owned DOM renderer as imperative chrome. */
export function HostIcon({ token, className, size, state, surfaceToken }: HostIconProps) {
  const resolvedState = state ?? (token === 'favorite-active' ? 'favorite' : undefined)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const icon = ref.current
    if (icon === null) return
    const document = icon.ownerDocument
    const render = () => {
      const themeRoot = icon.closest<HTMLElement>('[data-cordisx-app-theme]')
      const projected = themeRoot?.dataset.cordisxAppTheme
      const theme = projected === 'dark' || projected === 'light' ? projected : resolveHostTheme(document).theme
      icon.replaceChildren(renderHostIconSvg(document, semanticKey(token), {
        theme,
        ...(size === undefined ? {} : { size }),
        ...(resolvedState === undefined ? {} : { state: resolvedState }),
      }).svg)
    }
    render()
    const unsubscribe = iconThemeRegistryForDocument(document)?.subscribe(render)
    const Observer = document.defaultView?.MutationObserver
    const themeRoot = icon.closest<HTMLElement>('[data-cordisx-app-theme]') ?? document.documentElement
    if (Observer === undefined) return unsubscribe
    const observer = new Observer(render)
    observer.observe(themeRoot, { attributes: true, attributeFilter: ['class', 'data-cordisx-app-theme', 'data-theme', 'data-color-theme', 'data-color-scheme'] })
    return () => { observer.disconnect(); unsubscribe?.() }
  }, [resolvedState, size, token])
  return <span ref={ref} className={['cordisx-host-icon', className].filter(Boolean).join(' ')}
    data-host-icon-key={token} {...(surfaceToken === undefined ? {} : { 'data-host-icon': surfaceToken })}
    aria-hidden="true" draggable={false}
    {...(size === undefined ? {} : { style: { inlineSize: size, blockSize: size, flexBasis: size } })} />
}
