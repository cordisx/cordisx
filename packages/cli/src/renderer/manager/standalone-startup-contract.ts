import type { ManagerRoute } from './model/routes.js'

export type StandaloneStartupFailure = 'result-unknown' | 'refresh' | 'insecure-context' | undefined

/** Host-private handoff from the unprivileged starting surface to the admitted Manager. */
export interface StandaloneStartupSurface {
  readonly disposed: boolean
  stage(activate: (route: ManagerRoute) => void): () => void
  connected(): boolean
  unavailable(reason?: StandaloneStartupFailure): void
  dispose(): void
}

export type StandaloneStartupWindow = Window & {
  __cordisxManagerStartupV1?: StandaloneStartupSurface
}

export function standaloneStartupFor(document: Document): StandaloneStartupSurface | undefined {
  return (document.defaultView as StandaloneStartupWindow | null)?.__cordisxManagerStartupV1
}
