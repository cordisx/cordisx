import type { CSSProperties } from 'react'
import {
  MANAGER_ICON_SEMANTICS,
  normalizedVectorCommandData,
  resolveHostIcon,
  type HostIconState,
  type ManagerIconToken,
} from '../icons.js'

export interface HostIconProps {
  readonly token: ManagerIconToken
  readonly className?: string
  readonly state?: HostIconState
}

/** React projection of the same Host-owned normalized descriptor renderer. */
export function HostIcon({ token, className, state }: HostIconProps) {
  const resolvedState = state ?? (token === 'favorite-active' ? 'favorite' : 'default')
  const { descriptor, resolution } = resolveHostIcon(globalThis.document, MANAGER_ICON_SEMANTICS[token], { state: resolvedState })
  const style: CSSProperties = { width: '1em', height: '1em', display: 'block', pointerEvents: 'none' }
  return <svg
    {...(className === undefined ? {} : { className })}
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    aria-hidden="true"
    focusable="false"
    data-host-icon-key={resolution.key}
    data-host-icon-provider={resolution.provider}
    data-host-icon-fallback={resolution.fallback}
    data-host-icon-state={resolution.state}
    data-host-icon-variant={resolution.variant}
    style={style}
  >
    {descriptor.paths.map((path, index) => <path
      key={index}
      d={path.commands.map(normalizedVectorCommandData).join(' ')}
      {...(path.paint === 'fill'
        ? { fill: 'currentColor', ...(path.fillRule === undefined ? {} : { fillRule: path.fillRule }) }
        : {
            fill: 'none', stroke: 'currentColor', strokeWidth: path.strokeWidth,
            strokeLinecap: path.lineCap, strokeLinejoin: path.lineJoin,
          })}
      {...(path.opacity === undefined ? {} : { opacity: path.opacity })}
    />)}
  </svg>
}
