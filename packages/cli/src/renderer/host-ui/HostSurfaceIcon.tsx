import type { CordisXIconToken } from '../../contracts.js'
import type { ManagerIconToken } from '../icons.js'
import { HostIcon } from './HostIcon.js'

const PROTOCOL_ICON_MAP: Readonly<Record<string, ManagerIconToken>> = {
  'host:analytics': 'overview',
  'host:back': 'back',
  'host:close': 'close',
  'host:error': 'diagnostics',
  'host:files': 'document',
  'host:folder': 'document',
  'host:history': 'runtime',
  'host:info': 'point-info',
  'host:layers': 'outlets',
  'host:key': 'permissions',
  'host:more': 'more',
  'host:open': 'external-link',
  'host:palette': 'configuration',
  'host:refresh': 'reload-plugin',
  'host:reset': 'reload-plugin',
  'host:review': 'overview',
  'host:settings': 'settings',
  'host:save': 'configuration',
  'host:clock': 'runtime',
  'host:success': 'overview',
  'host:warning': 'diagnostics',
  'host:tags': 'contributions',
}

/** Closed protocol icon projection; unknown plugin tokens receive a neutral Host fallback. */
export function HostSurfaceIcon({ token }: { readonly token: CordisXIconToken }) {
  return <HostIcon token={PROTOCOL_ICON_MAP[token] ?? 'more'} />
}
