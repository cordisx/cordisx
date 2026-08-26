import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import type {
  CordisXMessageDefinition,
  CordisXMessageSchema,
  CordisXPageMount,
  CordisXPageMountContext,
  CordisXReactPageComponent,
} from '../contracts.js'
import { HostThemeProjection } from './host-theme.js'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
type StackDirection = 'row' | 'column'

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  readonly variant?: ButtonVariant
}

interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly direction?: StackDirection
  readonly gap?: number | 'small' | 'medium' | 'large'
  readonly align?: React.CSSProperties['alignItems']
  readonly justify?: React.CSSProperties['justifyContent']
  readonly wrap?: boolean
}

interface CardProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: 'article' | 'section' | 'div'
}

interface TextProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: 'p' | 'span' | 'div'
  readonly tone?: 'default' | 'muted' | 'danger'
}

interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  readonly level?: 2 | 3 | 4 | 5 | 6
}

interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly title: React.ReactNode
  readonly description?: React.ReactNode
  readonly action?: React.ReactNode
}

const SHARED_REACT_STYLES = `
.cxr-react-root{box-sizing:border-box;min-height:100%;padding:16px;color:var(--cx-text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.cxr-react-root *,.cxr-react-root *::before,.cxr-react-root *::after{box-sizing:border-box}
.cxr-ui-stack{display:flex;min-width:0}
.cxr-ui-card{min-width:0;padding:16px;border:1px solid var(--cx-border);border-radius:12px;background:var(--cx-surface-raised);color:var(--cx-text)}
.cxr-ui-text{margin:0;color:var(--cx-text)}
.cxr-ui-text[data-tone="muted"]{color:var(--cx-muted)}
.cxr-ui-text[data-tone="danger"]{color:var(--cx-danger)}
.cxr-ui-heading{margin:0;color:var(--cx-text);font:inherit;font-size:16px;font-weight:650;line-height:1.35}
.cxr-ui-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:6px 13px;border:1px solid transparent;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;transition:background-color .14s ease,border-color .14s ease,opacity .14s ease}
.cxr-ui-button:focus-visible{outline:2px solid var(--cx-focus);outline-offset:2px}
.cxr-ui-button:disabled{cursor:not-allowed;opacity:var(--cx-disabled)}
.cxr-ui-button[data-variant="primary"]{background:var(--cx-primary);color:var(--cx-primary-text)}
.cxr-ui-button[data-variant="secondary"]{border-color:var(--cx-border);background:var(--cx-surface-raised);color:var(--cx-text)}
.cxr-ui-button[data-variant="ghost"]{background:transparent;color:var(--cx-text)}
.cxr-ui-button[data-variant="danger"]{border-color:color-mix(in srgb,var(--cx-danger) 48%,transparent);background:color-mix(in srgb,var(--cx-danger) 14%,transparent);color:var(--cx-danger)}
.cxr-ui-button:not(:disabled):hover{background-image:linear-gradient(var(--cx-hover),var(--cx-hover))}
.cxr-ui-empty{display:flex;min-height:180px;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--cx-muted)}
.cxr-ui-empty-title{color:var(--cx-text);font-size:16px;font-weight:650}
.cxr-ui-error{display:grid;min-height:180px;place-content:center;gap:6px;padding:24px;text-align:center;color:var(--cx-danger)}
`

function joinClassName(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value !== '').join(' ')
}

function gapValue(gap: StackProps['gap']): string {
  if (typeof gap === 'number') return `${gap}px`
  if (gap === 'small') return '8px'
  if (gap === 'large') return '24px'
  return '16px'
}

function Button({ variant = 'secondary', className, type = 'button', ...props }: ButtonProps): React.ReactElement {
  return React.createElement('button', {
    ...props,
    type,
    className: joinClassName('cxr-ui-button', className),
    'data-variant': variant,
  })
}

function Stack({
  direction = 'column', gap = 'medium', align, justify, wrap = false, className, style, ...props
}: StackProps): React.ReactElement {
  return React.createElement('div', {
    ...props,
    className: joinClassName('cxr-ui-stack', className),
    style: {
      flexDirection: direction,
      gap: gapValue(gap),
      alignItems: align,
      justifyContent: justify,
      flexWrap: wrap ? 'wrap' : 'nowrap',
      ...style,
    },
  })
}

function Card({ as = 'section', className, ...props }: CardProps): React.ReactElement {
  return React.createElement(as, { ...props, className: joinClassName('cxr-ui-card', className) })
}

function Text({ as = 'p', tone = 'default', className, ...props }: TextProps): React.ReactElement {
  return React.createElement(as, {
    ...props,
    className: joinClassName('cxr-ui-text', className),
    'data-tone': tone,
  })
}

function Heading({ level = 2, className, ...props }: HeadingProps): React.ReactElement {
  return React.createElement(`h${level}`, { ...props, className: joinClassName('cxr-ui-heading', className) })
}

function EmptyState({ title, description, action, className, ...props }: EmptyStateProps): React.ReactElement {
  return React.createElement('div', { ...props, className: joinClassName('cxr-ui-empty', className) },
    React.createElement('div', { className: 'cxr-ui-empty-title' }, title),
    description === undefined ? null : React.createElement('div', undefined, description),
    action === undefined ? null : React.createElement('div', undefined, action),
  )
}

interface ErrorBoundaryProps {
  readonly children: React.ReactNode
}

interface ErrorBoundaryState {
  readonly error?: Error
}

class SharedReactErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {}

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error): void {
    console.error('[cordisx] React plugin page failed', error)
  }

  render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return React.createElement('div', { className: 'cxr-ui-error', role: 'alert' },
        React.createElement('strong', undefined, 'Plugin page failed to render'),
        React.createElement('span', undefined, this.state.error.message),
      )
    }
    return this.props.children
  }
}

export interface SharedReactRuntime {
  readonly React: typeof React
  readonly jsxRuntime: typeof jsxRuntime
  readonly jsxDevRuntime: typeof jsxDevRuntime
  readonly ui: Readonly<{
    Button: typeof Button
    Card: typeof Card
    EmptyState: typeof EmptyState
    Heading: typeof Heading
    Stack: typeof Stack
    Text: typeof Text
  }>
  readonly defineReactPage: <Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema>(
    component: CordisXReactPageComponent<Messages>,
  ) => CordisXPageMount<Messages>
  dispose(): void
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxSharedReactRuntime: SharedReactRuntime | undefined
}

/** Publish one Host-owned React singleton for every plugin in this renderer generation. */
export function installSharedReactRuntime(document: Document): SharedReactRuntime {
  if (globalThis.__cordisxSharedReactRuntime !== undefined) {
    throw new Error('CordisX shared React runtime is already installed')
  }
  const style = document.createElement('style')
  style.dataset.cordisxSharedReact = 'true'
  style.textContent = SHARED_REACT_STYLES
  ;(document.head ?? document.documentElement).append(style)
  const theme = new HostThemeProjection(document)
  const roots = new Set<Root>()
  let disposed = false

  const defineReactPage: SharedReactRuntime['defineReactPage'] = component => context => {
    if (disposed) throw new Error('CordisX shared React runtime is disposed')
    const root = createRoot(context.container)
    roots.add(root)
    context.container.classList.add('cxr-react-root')
    const detachTheme = theme.attach(context.container)
    let mounted = true
    const unmount = (): void => {
      if (!mounted) return
      mounted = false
      context.signal.removeEventListener('abort', unmount)
      roots.delete(root)
      root.unmount()
      detachTheme()
      context.container.classList.remove('cxr-react-root')
    }
    context.signal.addEventListener('abort', unmount, { once: true })
    const {
      container: _container,
      document: _document,
      controls: _controls,
      ...props
    } = context as CordisXPageMountContext
    root.render(React.createElement(
      SharedReactErrorBoundary,
      undefined,
      React.createElement(component as CordisXReactPageComponent, props),
    ))
    return unmount
  }

  const runtime: SharedReactRuntime = Object.freeze({
    React,
    jsxRuntime,
    jsxDevRuntime,
    ui: Object.freeze({ Button, Card, EmptyState, Heading, Stack, Text }),
    defineReactPage,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const root of roots) root.unmount()
      roots.clear()
      theme.dispose()
      style.remove()
      if (globalThis.__cordisxSharedReactRuntime === runtime) {
        globalThis.__cordisxSharedReactRuntime = undefined
      }
    },
  })
  globalThis.__cordisxSharedReactRuntime = runtime
  return runtime
}
