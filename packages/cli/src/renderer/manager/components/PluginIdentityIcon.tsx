import type { ManagerPluginStatus } from '../../manager.js'

export function PluginIdentityIcon({ name, icon, status }: {
  readonly name: string
  readonly icon?: string | undefined
  readonly status?: ManagerPluginStatus | undefined
}) {
  const fallback = name.slice(0, 2).toLocaleUpperCase()
  return <span className="cxr-card-icon">
    {icon === undefined ? fallback : <img src={icon} alt="" />}
    {status === undefined ? null : <span className="cxr-status-dot" data-status={status} title={status} aria-label={`状态：${status}`} />}
  </span>
}
