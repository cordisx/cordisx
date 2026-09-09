import * as React from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { DialogProps, DialogProviderProps, DialogViewProps } from '../../ui.js'
import type { DialogHandleV1, DialogMountV1, DialogsV1 } from '../../dialog-contracts.js'
import { dialogBindings, dialogHandleOwners } from './model.js'

const OwnerContext = React.createContext<DialogsV1 | null>(null)
const HandleContext = React.createContext<DialogHandleV1 | null>(null)
export function useDialog(): DialogHandleV1 {
  const handle = React.useContext(HandleContext)
  if (!handle) throw new Error('useDialog must be called inside a dialog body')
  return handle
}
export const DialogOverlayContext = React.createContext<HTMLElement | null>(null)
export function DialogProvider({ service, children }: DialogProviderProps) {
  if (!dialogBindings.has(service)) throw new Error('DialogProvider requires the active owner-bound dialogs service')
  return <OwnerContext.Provider value={service}>{children}</OwnerContext.Provider>
}
class BodyBoundary extends React.Component<{ children: React.ReactNode; report: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.report()
  }
  render() {
    const zh = document.documentElement.lang.startsWith('zh')
    return this.state.failed
      ? (
        <div role="status">
          <p>{zh ? '暂时无法显示此内容' : 'Unable to display this content'}</p>
          <button type="button" onClick={() => this.setState({ failed: false })}>{zh ? '重试' : 'Retry'}</button>
        </div>
      )
      : this.props.children
  }
}
export function Dialog(props: DialogProps) {
  const contextService = React.useContext(OwnerContext)
  const service = props.service ?? contextService
  if (!service) throw new Error('Dialog requires DialogProvider or service')
  const binding = dialogBindings.get(service)
  if (!binding) throw new Error('Dialog owner is unavailable')
  const latest = React.useRef(props)
  latest.current = props
  const [seat, setSeat] = React.useState<HTMLElement | null>(null)
  const handle = React.useRef<DialogHandleV1 | undefined>(undefined)
  const instance = React.useId()
  React.useEffect(() => {
    if (!props.open) return
    let mounted = true
    const current = binding.openBody({
      ...latest.current,
      kind: latest.current.kind ?? 'dialog.jsx',
      instanceKey: instance,
    }, ({ container }) => {
      setSeat(container)
      return () => {
        if (mounted) setSeat(null)
      }
    })
    handle.current = current
    void current.result.then(result => {
      if (!mounted) return
      setSeat(null)
      latest.current.onOpenChange(false, result)
    })
    return () => {
      mounted = false
      setSeat(null)
      // Component unmount is lifecycle disposal, not a vetoable user-close request.
      binding.disposeBody(current)
      handle.current = undefined
    }
  }, [props.open, binding, instance])
  React.useLayoutEffect(() => {
    handle.current?.update(props)
  }, [props])
  return props.open && seat
    ? createPortal(
      <HandleContext.Provider value={handle.current!}>
        <DialogOverlayContext.Provider value={seat}>
          <BodyBoundary report={() => binding.owner.report(props.kind ?? 'dialog.jsx')}>
            <React.Suspense
              fallback={<p role="status">{document.documentElement.lang.startsWith('zh') ? '加载中…' : 'Loading…'}</p>}
            >
              {props.children}
            </React.Suspense>
          </BodyBoundary>
        </DialogOverlayContext.Provider>
      </HandleContext.Provider>,
      seat,
    )
    : null
}
/** Adapts a React body to the framework-neutral registration seat. */
export function defineDialog(Component: React.ComponentType<DialogViewProps>): DialogMountV1 {
  return context => {
    const root = createRoot(context.container)
    root.render(
      <HandleContext.Provider value={context.dialog}>
        <DialogOverlayContext.Provider value={context.container}>
          <BodyBoundary report={() => dialogHandleOwners.get(context.dialog)?.report('dialog.render-failed')}>
            <React.Suspense
              fallback={<p role="status">{document.documentElement.lang.startsWith('zh') ? '加载中…' : 'Loading…'}</p>}
            >
              <Component props={context.props} dialog={context.dialog} signal={context.signal} />
            </React.Suspense>
          </BodyBoundary>
        </DialogOverlayContext.Provider>
      </HandleContext.Provider>,
    )
    return () => root.unmount()
  }
}
