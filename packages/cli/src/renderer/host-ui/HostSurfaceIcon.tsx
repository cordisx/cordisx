import type { CordisXIconToken } from '../../contracts.js'
import { type HostIconState, hostSurfaceIconKey } from '../icons.js'
import { HostIcon } from './HostIcon.js'

/** Legacy host:* token adapter over the closed Protocol semantic catalog. */
export function HostSurfaceIcon(
  { token, state }: { readonly token: CordisXIconToken; readonly state?: HostIconState },
) {
  return (
    <HostIcon
      token={hostSurfaceIconKey(token) ?? token}
      surfaceToken={token}
      {...(state === undefined ? {} : { state })}
    />
  )
}
