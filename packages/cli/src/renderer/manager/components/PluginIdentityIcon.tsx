import type { ManagerPluginStatus } from '../../manager.js'
import { PluginIdentityMark } from './PluginIdentityMark.js'

export function PluginIdentityIcon({ pluginId, name, icon, status }: {
  readonly pluginId: string
  readonly name: string
  readonly icon?: string | undefined
  readonly status?: ManagerPluginStatus | undefined
}) {
  return <span className="cxr-card-icon" data-icon-kind={icon === undefined ? 'derived' : 'artwork'}>
    <PluginIdentityMark pluginId={pluginId} name={name} icon={icon} />
    {status === undefined ? null : <span className="cxr-status-dot" data-status={status} title={status} aria-label={`状态：${status}`} />}
  </span>
}
