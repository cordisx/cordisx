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

export interface PanZoomCanvasProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onChange'> {
  readonly children: React.ReactNode
  readonly 'aria-label': string
  /** Establish a full-height Host page seat for canvas-style pages. */
  readonly fill?: boolean
  readonly minScale?: number
  readonly maxScale?: number
  readonly initialScale?: number
  readonly controllerRef?: React.Ref<PanZoomCanvasHandle>
  readonly onScaleChange?: (scale: number) => void
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
export const Select = HostComponent<SelectProps>('Select')
export const SelectionRail = HostComponent<SelectionRailProps>('SelectionRail')
export const MarkdownViewer = HostComponent<MarkdownViewerProps>('MarkdownViewer')
export const AttachmentPlaceholder = HostComponent<AttachmentPlaceholderProps>('AttachmentPlaceholder')
export const AgentAvatar = HostComponent<AgentAvatarProps>('AgentAvatar')
export const Stack = HostComponent<StackProps>('Stack')
export const Text = HostComponent<TextProps>('Text')
