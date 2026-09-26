import {
  createContext,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from 'tdesign-react'
import { HostBreadcrumbs, type HostBreadcrumbSegment } from './HostBreadcrumbs.js'
import { HostIcon } from './HostIcon.js'

export interface HostFormPageDescriptor {
  readonly id: string
  readonly breadcrumbLabel: string
  readonly title: string
  readonly content: ReactElement
  readonly returnFocus?: HTMLElement
}

export type HostFormPageTrailEntry = Pick<HostFormPageDescriptor, 'id' | 'breadcrumbLabel' | 'title'>

export interface HostFormPageNavigation {
  readonly depth: number
  readonly trail: readonly HostFormPageTrailEntry[]
  readonly push: (page: HostFormPageDescriptor) => void
  readonly back: () => void
  readonly root: () => void
  readonly toDepth: (depth: number) => void
}

const HostFormPageContext = createContext<HostFormPageNavigation | undefined>(undefined)
const HostFormPageLayoutContext = createContext<'embedded' | 'fill'>('embedded')

function guardPageAction(event: SyntheticEvent, active: boolean): void {
  if (active) return
  event.preventDefault()
  event.stopPropagation()
}

export function useHostFormPageNavigation(): HostFormPageNavigation | undefined {
  return useContext(HostFormPageContext)
}

function restoreFocus(element: HTMLElement | undefined, stack: HTMLElement | null): void {
  window.setTimeout(() => {
    const preferred = element?.isConnected === true && !element.matches(':disabled') && !element.closest('[hidden]')
      ? element
      : undefined
    const fallback = stack?.querySelector<HTMLElement>(
      '.cxf-form-page-layer:not([hidden]) .cxf-form-subpage-header button:not(:disabled), .cxf-form-page-root:not([hidden]) :is(button,input,textarea,select,[tabindex]):not(:disabled):not([tabindex="-1"]), .cxf-form-page-root:not([hidden])',
    )
    ;(preferred ?? fallback)?.focus()
  }, 0)
}

/** Keeps the root form and every nested draft page mounted while exposing one page at a time. */
export function HostFormPageStack({ children, resetKey, layout = 'embedded' }: {
  readonly children: ReactNode
  readonly resetKey: string | number
  readonly layout?: 'embedded' | 'fill'
}) {
  const [pages, setPages] = useState<readonly HostFormPageDescriptor[]>([])
  const stack = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setPages(current => {
      if (current.length > 0) restoreFocus(current[0]?.returnFocus, stack.current)
      return []
    })
  }, [resetKey])
  const push = useCallback((page: HostFormPageDescriptor) => {
    setPages(current => [...current, page])
  }, [])
  const toDepth = useCallback((depth: number) => {
    const targetDepth = Math.max(0, Math.min(depth, pages.length))
    if (targetDepth === pages.length) return
    const closing = pages[targetDepth]
    setPages(current => current.slice(0, targetDepth))
    restoreFocus(closing?.returnFocus, stack.current)
  }, [pages])
  const back = useCallback(() => {
    toDepth(pages.length - 1)
  }, [pages.length, toDepth])
  const root = useCallback(() => {
    toDepth(0)
  }, [toDepth])
  const trail = useMemo<readonly HostFormPageTrailEntry[]>(
    () => pages.map(({ id, breadcrumbLabel, title }) => ({ id, breadcrumbLabel, title })),
    [pages],
  )
  const navigation = useMemo<HostFormPageNavigation>(
    () => ({ depth: pages.length, trail, push, back, root, toDepth }),
    [back, pages.length, push, root, toDepth, trail],
  )
  return (
    <HostFormPageContext.Provider value={navigation}>
      <HostFormPageLayoutContext.Provider value={layout}>
        <div ref={stack} className="cxf-form-page-stack" data-form-layout={layout}>
          <div
            className="cxf-form-page-root"
            tabIndex={-1}
            hidden={pages.length > 0}
            onClickCapture={event => guardPageAction(event, pages.length === 0)}
            onSubmitCapture={event => guardPageAction(event, pages.length === 0)}
          >
            {children}
          </div>
          {pages.map((page, index) => (
            <div
              key={page.id}
              className="cxf-form-page-layer"
              data-host-form-page={page.id}
              hidden={index !== pages.length - 1}
              onClickCapture={event => guardPageAction(event, index === pages.length - 1)}
              onSubmitCapture={event => guardPageAction(event, index === pages.length - 1)}
            >
              {page.content}
            </div>
          ))}
        </div>
      </HostFormPageLayoutContext.Provider>
    </HostFormPageContext.Provider>
  )
}

/** A page owns its scroll boundary and footer; inactive layers stay mounted in the stack. */
export function HostFormPage({ children, footer }: { readonly children: ReactNode; readonly footer?: ReactNode }) {
  const layout = useContext(HostFormPageLayoutContext)
  return (
    <div className="cxf-form-page" data-form-page-layout={layout}>
      <div className="cxf-form-page-scroll">{children}</div>
      {footer === undefined ? null : <footer className="cxf-form-page-footer">{footer}</footer>}
    </div>
  )
}

/** Shared page shell for a transactional child form inside a Host form surface. */
export function HostFormSubpage({ pageId, children, actions, breadcrumbLabel, backLabel }: {
  readonly pageId: string
  readonly children: ReactNode
  readonly actions: ReactNode
  readonly breadcrumbLabel: string
  readonly backLabel: string
}) {
  const navigation = useHostFormPageNavigation()
  if (navigation === undefined) throw new Error('HostFormSubpage must be rendered inside HostFormPageStack')
  const pageIndex = navigation.trail.findIndex(page => page.id === pageId)
  const page = navigation.trail[pageIndex]
  if (page === undefined) throw new Error(`HostFormSubpage page ${pageId} is not registered`)
  const segments: HostBreadcrumbSegment[] = []
  for (const [index, entry] of navigation.trail.slice(0, pageIndex + 1).entries()) {
    segments.push({
      key: `${entry.id}:parent`,
      label: entry.breadcrumbLabel,
      onActivate: () => navigation.toDepth(index),
    })
    segments.push({
      key: `${entry.id}:title`,
      label: entry.title,
      ...(index === pageIndex ? {} : { onActivate: () => navigation.toDepth(index + 1) }),
    })
  }
  return (
    <section className="cxf-form-subpage" aria-label={page.title}>
      <header className="cxf-form-subpage-header">
        <span className="cxf-form-subpage-header-seat">
          <Button
            type="button"
            shape="square"
            variant="text"
            aria-label={backLabel}
            icon={<HostIcon token="back" />}
            onClick={navigation.back}
          />
        </span>
        <HostBreadcrumbs segments={segments} label={breadcrumbLabel} />
      </header>
      <HostFormPage footer={<div className="cxf-form-actions cxf-form-subpage-actions">{actions}</div>}>
        <div className="cxf-form-subpage-body">{children}</div>
      </HostFormPage>
    </section>
  )
}
