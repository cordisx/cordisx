/** Mount the reversible, host-owned CordisX manager UI. */
export interface ManagerInstallOptions {
  /** A host-owned trigger seat. Playground supplies this instead of probing Codex DOM. */
  readonly triggerTarget?: () => HTMLElement | undefined
}
