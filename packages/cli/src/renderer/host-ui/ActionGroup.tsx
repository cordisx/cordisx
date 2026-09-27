import { Children, Fragment, isValidElement, type ReactNode } from 'react'

/** Stable visual seats keep separators outside action and popover hit targets. */
export function ActionGroup({ children, className, label, role }: {
  readonly children?: ReactNode
  readonly className?: string
  readonly role?: 'toolbar'
  readonly label?: string
}) {
  const seats = (nodes: ReactNode, prefix = ''): ReactNode[] =>
    Children.toArray(nodes).flatMap((node, index) => {
      const key = `${prefix}${isValidElement(node) ? node.key ?? index : index}`
      if (isValidElement<{ children?: ReactNode; hidden?: boolean }>(node)) {
        if (node.props.hidden) return []
        if (node.type === Fragment) return seats(node.props.children, `${key}/`)
      }
      return <span className="cxh-action-slot" key={key}>{node}</span>
    })
  return (
    <div className={['cxh-action-group', className].filter(Boolean).join(' ')} role={role} aria-label={label}>
      {seats(children)}
    </div>
  )
}
