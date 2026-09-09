import { useLayoutEffect, useRef } from 'react'
import type { DialogActionV1 } from '../../dialog-contracts.js'
import { DialogCenter, type DialogEntry } from './model.js'

const paths = {
  share: 'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7',
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  close: 'M6 6l12 12M18 6 6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
}
function Glyph({ name }: { name: keyof typeof paths }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}
export function DialogShell(
  { entry, center, document }: { entry: DialogEntry; center: DialogCenter; document: Document },
) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = `cxd-title-${entry.id}`
  const descriptionId = `cxd-description-${entry.id}`
  useLayoutEffect(() => {
    const element = ref.current!
    const previouslyFocused = document.activeElement as HTMLElement | null
    entry.focus = () => element.focus()
    element.showModal()
    const cancel = (event: Event) => {
      event.preventDefault()
      void center.close(entry, 'escape')
    }
    element.addEventListener('cancel', cancel)
    return () => {
      delete entry.focus
      element.removeEventListener('cancel', cancel)
      element.close()
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [entry, center, document])
  const action = (item: DialogActionV1, iconOnly = false, primary = false) => (
    <button
      key={item.id}
      type="button"
      data-action={item.id}
      data-primary={primary}
      data-tone={item.tone}
      className={iconOnly ? 'icon-button' : undefined}
      title={iconOnly ? item.label : undefined}
      aria-label={item.label}
      aria-busy={entry.busy === item.id || item.pending || undefined}
      disabled={entry.closing || !!entry.busy || item.disabled || item.pending}
      onClick={() => {
        void center.run(entry, item)
      }}
    >
      {iconOnly ? <Glyph name={item.icon ?? 'help'} /> : item.label}
      {(entry.busy === item.id || item.pending) && !iconOnly ? '…' : null}
    </button>
  )
  const header = entry.chrome.headerActions ?? []
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={entry.chrome.description ? descriptionId : undefined}
      data-size={entry.chrome.size ?? 'medium'}
      onClick={event => {
        if (event.target !== event.currentTarget || !entry.chrome.closeOnBackdrop) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top
          || event.clientY > bounds.bottom
        ) void center.close(entry, 'backdrop')
      }}
    >
      <header>
        <div className="heading">
          <div className="source">{entry.owner.name()}</div>
          <h2 id={titleId}>{entry.chrome.title}</h2>
          {entry.chrome.description
            ? <p id={descriptionId} className="description">{entry.chrome.description}</p>
            : null}
        </div>
        <div className="header-actions">
          {header.slice(0, 2).map(item => action(item, true))}
          {header.length > 2
            ? (
              <details>
                <summary aria-label={center.copy.more} title={center.copy.more}>
                  <Glyph name="more" />
                </summary>
                <div className="menu">{header.slice(2).map(item => action(item))}</div>
              </details>
            )
            : null}
          <button
            type="button"
            className="icon-button"
            data-dialog-close="true"
            title={center.copy.close}
            aria-label={center.copy.close}
            disabled={entry.closing}
            onClick={() => {
              void center.close(entry, 'close-button')
            }}
          >
            <Glyph name="close" />
          </button>
        </div>
      </header>
      <div className="body" data-layout={entry.chrome.bodyLayout ?? 'scroll'}>
        <slot name="body" />
      </div>
      {entry.chrome.footer
        ? (
          <footer>
            {entry.chrome.footer.status
              ? <span className="status" role="status">{entry.chrome.footer.status}</span>
              : null}
            <div className="footer-actions">
              {entry.chrome.footer.secondaryActions?.map(item => action(item))}
              {entry.chrome.footer.primaryAction ? action(entry.chrome.footer.primaryAction, false, true) : null}
            </div>
          </footer>
        )
        : null}
      <slot name="notifications" />
    </dialog>
  )
}
