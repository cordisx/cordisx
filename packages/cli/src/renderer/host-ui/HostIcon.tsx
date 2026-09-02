import { useLayoutEffect, useRef } from 'react'
import {
  MANAGER_ICON_TOKENS,
  iconThemeRegistryForDocument,
  renderManagerIconSvg,
  renderHostIconSvg,
  renderHostSurfaceIconSvg,
  type HostIconState,
  type ManagerIconToken,
} from '../icons.js'
import { resolveHostTheme } from '../host-theme.js'

export interface HostIconProps {
  readonly token: ManagerIconToken | string
  readonly className?: string
  readonly size?: number | string
  readonly state?: HostIconState
  readonly surfaceToken?: string
}

function isManagerIconToken(token: string): token is ManagerIconToken {
  return (MANAGER_ICON_TOKENS as readonly string[]).includes(token)
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
      const options = {
        theme,
        ...(size === undefined ? {} : { size }),
        ...(resolvedState === undefined ? {} : { state: resolvedState }),
      }
      icon.replaceChildren((surfaceToken !== undefined
        ? renderHostSurfaceIconSvg(document, surfaceToken, options)
        : isManagerIconToken(token)
          ? renderManagerIconSvg(document, token, options)
          : renderHostIconSvg(document, token, options)).svg)
    }
    render()
    const unsubscribe = iconThemeRegistryForDocument(document)?.subscribe(render)
    const Observer = document.defaultView?.MutationObserver
    const themeRoot = icon.closest<HTMLElement>('[data-cordisx-app-theme]') ?? document.documentElement
    if (Observer === undefined) return unsubscribe
    const observer = new Observer(render)
    observer.observe(themeRoot, { attributes: true, attributeFilter: ['class', 'data-cordisx-app-theme', 'data-theme', 'data-color-theme', 'data-color-scheme'] })
    return () => { observer.disconnect(); unsubscribe?.() }
  }, [resolvedState, size, surfaceToken, token])
  return <span ref={ref} className={['cordisx-host-icon', className].filter(Boolean).join(' ')}
    data-host-icon-key={token} {...(surfaceToken === undefined ? {} : { 'data-host-icon': surfaceToken })}
    aria-hidden="true" draggable={false}
    {...(size === undefined ? {} : { style: { inlineSize: size, blockSize: size, flexBasis: size } })} />
}
