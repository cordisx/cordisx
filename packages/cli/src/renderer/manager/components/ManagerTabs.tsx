import { HostIcon } from '../../host-ui/HostIcon.js'
import type { ManagerIconToken } from '../../icons.js'

export interface ManagerTab<T extends string> {
  readonly id: T
  readonly label: string
  readonly icon: ManagerIconToken
}

export function ManagerTabs<T extends string>({ label, tabs, value, onChange }: {
  readonly label: string
  readonly tabs: readonly ManagerTab<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
}) {
  return <div className="cxr-tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <button key={tab.id} type="button" role="tab" data-plugin-detail-tab={tab.id} aria-selected={value === tab.id} onClick={() => onChange(tab.id)}>
      <HostIcon token={tab.icon} state={value === tab.id ? 'active' : 'default'} />
      <span>{tab.label}</span>
    </button>)}
  </div>
}
