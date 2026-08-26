import { forwardRef } from 'react'
import { Button, type ButtonProps } from 'tdesign-react'
import { HostIcon } from './HostIcon.js'
import type { ManagerIconToken } from '../icons.js'

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'content' | 'icon' | 'shape' | 'title'> {
  readonly icon: ManagerIconToken
  readonly label: string
  readonly description?: string
}

export const IconButton = forwardRef<HTMLElement, IconButtonProps>(function IconButton(
  { icon, label, description, className, ...props }, ref,
) {
  return (
    <Button {...props} ref={ref} type="button" shape="square" variant="text"
      className={['cxm-manager-icon-action', className].filter(Boolean).join(' ')}
      aria-label={label} aria-description={description}
      title={description === undefined ? label : `${label} · ${description}`}
      icon={<HostIcon token={icon} />} data-cordisx-no-drag="true" />
  )
})
