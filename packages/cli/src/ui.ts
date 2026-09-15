import type { DialogChromeV1, DialogHandleV1, DialogMountV1, DialogResultV1, DialogsV1 } from './dialog-contracts.js'
import type * as React from 'react'
import type { AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { CordisXConfigFormIcon } from './contracts.js'

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
}

export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Fill the Manager body seat; children explicitly own their scrolling. */
  readonly fill?: boolean
  readonly direction?: 'row' | 'column'
  readonly gap?: number | 'small' | 'medium' | 'large'
  readonly align?: React.CSSProperties['alignItems']
  readonly justify?: React.CSSProperties['justifyContent']
  readonly wrap?: boolean
}

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: 'article' | 'section' | 'div'
}

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: 'p' | 'span' | 'div'
  readonly tone?: 'default' | 'muted' | 'danger'
}

export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  readonly level?: 2 | 3 | 4 | 5 | 6
}

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly title: React.ReactNode
  readonly description?: React.ReactNode
  readonly action?: React.ReactNode
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}

export interface FieldListItem {
  readonly id: string
  readonly label: React.ReactNode
  readonly value: React.ReactNode
  readonly description?: React.ReactNode
}

export interface FieldListProps extends Omit<React.HTMLAttributes<HTMLDListElement>, 'children'> {
  readonly items: readonly FieldListItem[]
  readonly density?: 'default' | 'compact'
  readonly columns?: 1 | 2
}

export interface DisclosureProps
  extends Omit<React.DetailsHTMLAttributes<HTMLDetailsElement>, 'children' | 'defaultOpen' | 'onToggle' | 'open'>
{
  readonly summary: React.ReactNode
  readonly children?: React.ReactNode
  /** Controlled open state. Omit to use native uncontrolled disclosure behavior. */
  readonly open?: boolean
  /** Initial state for an uncontrolled disclosure. Ignored when `open` is provided. */
  readonly defaultOpen?: boolean
  readonly onToggle?: (open: boolean) => void
  readonly tone?: 'neutral' | 'warning' | 'danger'
}

export type IconName =
  | CordisXConfigFormIcon
  | 'search'
  | 'create'
  | 'success'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'role'
  | 'session'
  | 'relationship'
  | 'fit'
  | 'reset'
  | 'account'
  | 'refresh'
  | 'logout'
  | 'runtime'
  | 'readiness'
  | 'health'

export interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
  readonly name: IconName
}

export interface HorizontalSplitPaneProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly left: React.ReactNode
  readonly right: React.ReactNode
  readonly initialLeftSize: number
  readonly minLeftSize: number
  readonly maxLeftSize?: number
  readonly separatorLabel: string
}

export interface HoverCardProps extends
  Omit<
    React.HTMLAttributes<HTMLElement>,
    | 'children'
    | 'content'
    | 'onBlur'
    | 'onClick'
    | 'onFocus'
    | 'onKeyDown'
    | 'onPointerDown'
    | 'onPointerEnter'
    | 'onPointerLeave'
  >
{
  readonly trigger: React.ReactElement
  readonly content: React.ReactNode
  readonly placement?: 'top' | 'bottom'
}

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly prefixIcon?: React.ReactNode
}

export interface SelectProps {
  readonly className?: string
  readonly 'aria-label'?: string
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly prefixIcon?: React.ReactNode
  readonly density?: 'default' | 'compact'
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
}

export interface PanZoomCanvasHandle {
  getScale(): number
  fitToView(): void
  reset(): void
}

export interface PanZoomCanvasControls {
  readonly fitLabel: string
  readonly resetLabel: string
  readonly disabled?: boolean
  readonly onFit?: () => void
  readonly onReset?: () => void
}

export interface PanZoomCanvasProps extends
  Omit<
    React.HTMLAttributes<HTMLDivElement>,
    | 'children'
    | 'onChange'
    | 'onClickCapture'
    | 'onDragStart'
    | 'onKeyDown'
    | 'onPointerCancel'
    | 'onPointerDown'
    | 'onPointerMove'
    | 'onPointerUp'
    | 'onWheel'
  >
{
  readonly children: React.ReactNode
  readonly 'aria-label': string
  /** Establish a full-height Host page seat for canvas-style pages. */
  readonly fill?: boolean
  readonly minScale?: number
  readonly maxScale?: number
  readonly initialScale?: number
  readonly controls?: PanZoomCanvasControls
  readonly controllerRef?: React.Ref<PanZoomCanvasHandle>
  readonly onScaleChange?: (scale: number) => void
}

export interface SearchFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'value'>
{
  readonly value: string
  readonly onChange: (value: string) => void
}

export interface FilterToolbarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly 'aria-label': string
  readonly search: React.ReactElement
  readonly filters?: readonly React.ReactElement[]
  readonly actions?: React.ReactNode
}

export interface SelectionRailOption {
  readonly value: string
  readonly label: React.ReactNode
  readonly description?: React.ReactNode
  readonly disabled?: boolean
  readonly controls?: string
}

export interface SelectionRailProps {
  readonly className?: string
  readonly 'aria-label': string
  readonly value: string
  readonly options: readonly SelectionRailOption[]
  readonly onChange: (value: string) => void
  readonly layout?: 'responsive' | 'vertical' | 'horizontal'
}

export interface MarkdownViewerProps {
  readonly source: string
  readonly className?: string
  readonly 'aria-label'?: string
}

/** UTF-16 selection offsets, matching textarea and browser selection APIs. */
export interface MarkdownEditorSelection {
  readonly start: number
  readonly end: number
}

/** Imperative editing operations only; the Host-owned DOM remains private. */
export interface MarkdownEditorHandle {
  focus(options?: { readonly preventScroll?: boolean }): void
  getSelection(): MarkdownEditorSelection
  setSelection(start: number, end: number): void
}

export interface MarkdownEditorProps {
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly className?: string
  readonly style?: React.CSSProperties
  readonly 'aria-label': string
  readonly 'aria-describedby'?: string
  readonly 'aria-controls'?: string
  readonly 'aria-activedescendant'?: string
  readonly onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>
  readonly onCompositionStart?: React.CompositionEventHandler<HTMLTextAreaElement>
  readonly onCompositionEnd?: React.CompositionEventHandler<HTMLTextAreaElement>
  readonly onSelectionChange?: (selection: MarkdownEditorSelection) => void
  readonly ref?: React.Ref<MarkdownEditorHandle>
}

/** Presentation-only composer seat. It never accepts or exposes an attachment action. */
export interface AttachmentPlaceholderProps {
  readonly className?: string
  readonly 'aria-label'?: string
  readonly title?: string
  /** Bounded Host geometry; plugins cannot supply arbitrary dimensions. */
  readonly size?: 30 | 32
}

export interface AgentAvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly participant: Readonly<{ readonly id: string; readonly name: string; readonly avatar?: AgentAvatarRef }>
  readonly fallback?: 'initials' | 'neutral'
}

function HostComponent<Props>(name: string): React.ComponentType<Props> {
  return function UnavailableHostComponent(): never {
    throw new Error(`${name} is available only inside the CordisX renderer Host`)
  }
}

export const Button = HostComponent<ButtonProps>('Button')
export const Card = HostComponent<CardProps>('Card')
export const EmptyState = HostComponent<EmptyStateProps>('EmptyState')
export const StatusBadge = HostComponent<StatusBadgeProps>('StatusBadge')
export const FieldList = HostComponent<FieldListProps>('FieldList')
export const Disclosure = HostComponent<DisclosureProps>('Disclosure')
export const Heading = HostComponent<HeadingProps>('Heading')
export const Icon = HostComponent<IconProps>('Icon')
export const HorizontalSplitPane = HostComponent<HorizontalSplitPaneProps>('HorizontalSplitPane')
export const HoverCard = HostComponent<HoverCardProps>('HoverCard')
export const PanZoomCanvas = HostComponent<PanZoomCanvasProps>('PanZoomCanvas')
export const FilterToolbar = HostComponent<FilterToolbarProps>('FilterToolbar')
export const SearchField = HostComponent<SearchFieldProps>('SearchField')
export const Select = HostComponent<SelectProps>('Select')
export const SelectionRail = HostComponent<SelectionRailProps>('SelectionRail')
export const MarkdownEditor = HostComponent<MarkdownEditorProps>('MarkdownEditor')
export const MarkdownViewer = HostComponent<MarkdownViewerProps>('MarkdownViewer')
export const AttachmentPlaceholder = HostComponent<AttachmentPlaceholderProps>('AttachmentPlaceholder')
export const AgentAvatar = HostComponent<AgentAvatarProps>('AgentAvatar')
export const Stack = HostComponent<StackProps>('Stack')
export const Text = HostComponent<TextProps>('Text')

export type HostDialogCloseReason = 'escape' | 'backdrop'

export interface HostDialogProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'title'> {
  readonly open: boolean
  readonly title: React.ReactNode
  readonly description?: React.ReactNode
  readonly children?: React.ReactNode
  readonly actions?: React.ReactNode
  readonly tone?: 'neutral' | 'danger'
  readonly width?: 'small' | 'medium'
  readonly initialFocusRef?: React.RefObject<HTMLElement | null>
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>
  readonly closeOnBackdrop?: boolean
  readonly onClose: (reason: HostDialogCloseReason) => void
}

/** Chrome accepts only structured descriptors; JSX is confined to the body seat. */
export interface ManagedDialogProps extends DialogChromeV1 {
  readonly service?: DialogsV1
  readonly kind?: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean, result: DialogResultV1) => void
  readonly children: React.ReactNode
}
export type DialogProps = ManagedDialogProps | HostDialogProps
export interface DialogProviderProps {
  readonly service: DialogsV1
  readonly children: React.ReactNode
}
export interface DialogViewProps {
  readonly props: Readonly<Record<string, unknown>>
  readonly dialog: DialogHandleV1
  readonly signal: AbortSignal
}
export const Dialog = HostComponent<DialogProps>('Dialog')
export const DialogProvider = HostComponent<DialogProviderProps>('DialogProvider')
export function defineDialog(_component: React.ComponentType<DialogViewProps>): DialogMountV1 {
  throw new Error('defineDialog is available only inside the CordisX renderer Host')
}

export function useDialog(): DialogHandleV1 {
  throw new Error('useDialog is available only inside a CordisX dialog body')
}
