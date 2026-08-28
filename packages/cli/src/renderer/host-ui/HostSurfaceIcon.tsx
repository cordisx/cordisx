import type { CordisXIconToken } from '../../contracts.js'
import { hostSurfaceIconKey } from '../icons.js'
import { HostIcon } from './HostIcon.js'

/** Legacy host:* token adapter over the closed Protocol semantic catalog. */
export function HostSurfaceIcon({ token }: { readonly token: CordisXIconToken }) {
  return <HostIcon token={hostSurfaceIconKey(token) ?? 'control.minus'} surfaceToken={token} />
}
