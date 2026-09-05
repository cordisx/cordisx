import type { Disposable } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'

/** JSON-compatible data whose meaning belongs exclusively to its provider. */
export type CordisXVisualData =
  | null
  | boolean
  | number
  | string
  | readonly CordisXVisualData[]
  | { readonly [key: string]: CordisXVisualData }

/** Host-projected appearance for one bounded visual seat. */
export type CordisXVisualTheme = 'light' | 'dark'

export interface CordisXVisualProps<Data extends CordisXVisualData = CordisXVisualData> {
  /** Detached and deeply frozen before the provider receives it. */
  readonly data: Data
  readonly theme: CordisXVisualTheme
}

export type CordisXVisualRenderer<Data extends CordisXVisualData = CordisXVisualData> = ComponentType<
  CordisXVisualProps<Data>
>

/** Fiber-owned visual-provider registration for trusted renderer plugins. */
export interface CordisXVisuals {
  register<Data extends CordisXVisualData = CordisXVisualData>(
    id: string,
    renderer: CordisXVisualRenderer<Data>,
  ): Disposable<void>
}
