import type { ReactNode, Ref } from 'react'
import { managerCopy } from '../../ui-copy.js'

/** The Host-owned Manager chrome, shared by the live and starting surfaces. */
export function ManagerFrame({
  standaloneMode,
  workspaceMode,
  open,
  surface,
  locale,
  sidebar,
  header,
  children,
  mainRef,
  onClose,
}: {
  readonly standaloneMode: boolean
  readonly workspaceMode: boolean
  readonly open: boolean
  readonly surface: 'pane' | 'modal'
  readonly locale: string
  readonly sidebar: ReactNode
  readonly header: ReactNode
  readonly children: ReactNode
  readonly mainRef?: Ref<HTMLElement>
  readonly onClose?: () => void
}) {
  return (
    <div
      className={standaloneMode ? 'cxr-standalone-layer' : surface === 'pane' ? 'cxr-pane-layer' : 'cxr-backdrop'}
      data-cordisx-manager-pane={open && surface === 'pane' ? 'true' : undefined}
      data-cordisx-manager-modal={open && surface === 'modal' && !standaloneMode ? 'true' : undefined}
      data-cordisx-manager-workspace={workspaceMode ? 'true' : undefined}
      aria-hidden={open ? undefined : true}
      inert={!open}
      style={open ? undefined : { display: 'none' }}
      onMouseDown={event => {
        if (!standaloneMode && surface === 'modal' && event.target === event.currentTarget) onClose?.()
      }}
    >
      <section
        className={surface === 'pane' ? 'cxr-pane-shell' : 'cxr-dialog'}
        role={surface === 'modal' && !standaloneMode ? 'dialog' : undefined}
        aria-modal={surface === 'modal' && !standaloneMode ? 'true' : undefined}
        aria-label={managerCopy(locale, 'manager.dialog')}
      >
        {surface === 'modal' ? <aside className="cxr-sidebar">{sidebar}</aside> : null}
        <main ref={mainRef} className="cxr-main" tabIndex={-1}>
          {surface === 'modal' ? header : null}
          {children}
        </main>
      </section>
    </div>
  )
}
