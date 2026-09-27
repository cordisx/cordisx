import type { ReactNode } from 'react'
import { Button } from 'tdesign-react'
import type { ManagerIconToken } from '../icons.js'
import { HostIcon } from './HostIcon.js'
import css from './empty-state.css?inline'

/** Host-owned list status. Actions exist only when the caller can execute them. */
export function EmptyState({ icon, title, description, state = 'empty', action, illustration }: {
  readonly illustration?: ReactNode
  readonly icon: ManagerIconToken
  readonly title: string
  readonly description?: string | undefined
  readonly state?: 'empty' | 'search' | 'error' | 'loading' | 'unavailable'
  readonly action?: {
    readonly label: string
    readonly onClick: () => void
    readonly disabled?: boolean
    readonly variant?: 'primary'
  } | undefined
}) {
  return (
    <>
      <style>{css}</style>
      <div
        className="cxh-empty-state"
        data-empty-state={state}
        data-empty-presentation={illustration ? 'hero' : 'inline'}
        role={state === 'error' ? 'alert' : 'status'}
        aria-busy={state === 'loading'}
      >
        {illustration
          ? <div className="cxh-empty-state-illustration">{illustration}</div>
          : <HostIcon token={icon} size={24} />}
        <div className="cxh-empty-state-body">
          <p className="cxh-empty-state-title">{title}</p>
          {description ? <p className="cxh-empty-state-description">{description}</p> : null}
          {action
            ? (
              <Button
                tag="button"
                variant="outline"
                onClick={action.onClick}
                disabled={action.disabled === true}
                data-empty-action={action.variant ?? 'secondary'}
              >
                {action.label}
              </Button>
            )
            : null}
        </div>
      </div>
    </>
  )
}
