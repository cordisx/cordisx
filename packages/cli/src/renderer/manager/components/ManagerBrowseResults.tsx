import type { ComponentProps } from 'react'

/** The browse collection owns scrolling; its sibling toolbar stays in view. */
export function ManagerBrowseResults({ className = '', ...props }: ComponentProps<'div'>) {
  return <div {...props} className={`cxr-browse-results ${className}`} />
}
