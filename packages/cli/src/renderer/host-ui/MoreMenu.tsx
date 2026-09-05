import { Dropdown, type DropdownOption } from 'tdesign-react'
import { HostIcon } from './HostIcon.js'
import { IconButton } from './IconButton.js'
import type { ManagerIconToken } from '../icons.js'

export interface MoreMenuItem {
  readonly id: string
  readonly label: string
  readonly icon: ManagerIconToken
  readonly disabled?: boolean
  readonly onSelect: () => void
}

export function MoreMenu({ label, items }: { readonly label: string; readonly items: readonly MoreMenuItem[] }) {
  const options: DropdownOption[] = items.map(item => ({
    value: item.id,
    content: item.label,
    prefixIcon: <HostIcon token={item.icon} />,
    ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
  }))
  return (
    <Dropdown
      trigger="click"
      placement="bottom-right"
      options={options}
      minColumnWidth={180}
      onClick={item => items.find(candidate => candidate.id === item.value)?.onSelect()}
    >
      <span>
        <IconButton icon="more" label={label} aria-haspopup="menu" />
      </span>
    </Dropdown>
  )
}
