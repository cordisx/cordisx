import type { CordisXIconToken } from '../../contracts.js'
import { hostSurfaceIconKey, normalizedVectorCommandData, resolveHostIcon } from '../icons.js'

/** Closed protocol icon projection; unknown plugin tokens receive a neutral Host fallback. */
export function HostSurfaceIcon({ token }: { readonly token: CordisXIconToken }) {
  const { descriptor, resolution } = resolveHostIcon(globalThis.document, hostSurfaceIconKey(token) ?? token)
  return <span className="cordisx-host-icon" data-host-icon={token} aria-hidden="true"><svg
    viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true" focusable="false"
    data-host-icon-key={resolution.key} data-host-icon-provider={resolution.provider}
    data-host-icon-fallback={resolution.fallback} data-host-icon-state={resolution.state}
    data-host-icon-variant={resolution.variant}
  >{descriptor.paths.map((path, index) => <path
      key={index} d={path.commands.map(normalizedVectorCommandData).join(' ')}
      {...(path.paint === 'fill'
        ? { fill: 'currentColor', ...(path.fillRule === undefined ? {} : { fillRule: path.fillRule }) }
        : { fill: 'none', stroke: 'currentColor', strokeWidth: path.strokeWidth, strokeLinecap: path.lineCap, strokeLinejoin: path.lineJoin })}
      {...(path.opacity === undefined ? {} : { opacity: path.opacity })}
    />)}</svg></span>
}
