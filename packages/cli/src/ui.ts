import type * as React from 'react'
import type { AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { CordisXConfigFormIcon } from './contracts.js'

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
}

export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
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
