import type * as React from 'react'

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

function HostComponent<Props>(name: string): React.ComponentType<Props> {
  return function UnavailableHostComponent(): never {
    throw new Error(`${name} is available only inside the CordisX renderer Host`)
  }
}

export const Button = HostComponent<ButtonProps>('Button')
export const Card = HostComponent<CardProps>('Card')
export const EmptyState = HostComponent<EmptyStateProps>('EmptyState')
export const Heading = HostComponent<HeadingProps>('Heading')
export const Stack = HostComponent<StackProps>('Stack')
export const Text = HostComponent<TextProps>('Text')
