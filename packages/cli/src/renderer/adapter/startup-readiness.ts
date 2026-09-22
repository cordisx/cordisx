import type { NativeAccountCapabilityDescriptor } from '../../native-account-capability.js'

/** Serialized only into the launcher-owned primary document. No identity leaves it. */
export async function readNativeStartupReadiness(
  descriptor: NativeAccountCapabilityDescriptor,
  load: (url: string) => Promise<Record<string, unknown>> = url => import(/* @vite-ignore */ url),
): Promise<{
  ready: boolean
  reason?: string
  receipt?: Record<string, unknown>
  observations?: { receipt: Record<string, unknown>; hostUsable: true; cordisxReady: true; authenticated: true }
}> {
  const root = globalThis as typeof globalThis & {
    __cordisxStartupDocument?: { snapshot(): { receipt: Record<string, unknown>; phase: string } }
    __cordisxProductionInstallId?: string
    __cordisxProductionBootstrapState?: { installId?: string; status?: string }
    __cordisxCompositionBoot?: Promise<unknown>
    __cordisxBoot?: Promise<unknown>
    __cordisxRuntime?: unknown
  }
  const initial = root.__cordisxStartupDocument?.snapshot()
  if (!initial || initial.phase !== 'covered' || location.href !== 'app://-/index.html') {
    return { ready: false, reason: 'document-pending' }
  }
  const current = (): boolean =>
    root.__cordisxStartupDocument?.snapshot().receipt.nonce === initial.receipt.nonce
    && performance.timeOrigin === initial.receipt.timeOrigin
  const boot = root.__cordisxCompositionBoot ?? root.__cordisxBoot
  if (!boot || root.__cordisxRuntime === undefined) return { ready: false, reason: 'cordisx-pending' }
  const installId = root.__cordisxProductionInstallId
  if (
    installId && (root.__cordisxProductionBootstrapState?.installId !== installId
      || root.__cordisxProductionBootstrapState.status !== 'evaluated')
  ) {
    return { ready: false, reason: 'production-bootstrap-pending' }
  }
  try {
    await boot
  } catch {
    return { ready: false, reason: 'cordisx-boot-failed' }
  }
  if (!current() || root.__cordisxProductionInstallId !== installId) return { ready: false, reason: 'document-changed' }
  let invocation: (Promise<unknown> & { [key: symbol]: unknown }) | undefined
  try {
    const native = await load(descriptor.module) as Record<string, {
      accessInputs?: { readAccountInfo(): Promise<unknown> }
    }>
    const inputs = native[descriptor.exportName]?.accessInputs
    if (typeof inputs?.readAccountInfo !== 'function') return { ready: false, reason: 'account-service-pending' }
    invocation = inputs.readAccountInfo() as typeof invocation
    const account = await invocation as { status?: string; data?: unknown }
    if (!current()) return { ready: false, reason: 'document-changed' }
    if (account?.status !== 'ready' || account.data == null) return { ready: false, reason: 'account-not-ready' }
  } catch {
    return { ready: false, reason: 'account-unavailable' }
  } finally {
    const dispose = (Symbol as SymbolConstructor & { dispose?: symbol }).dispose
    if (dispose && invocation && typeof invocation[dispose] === 'function') {
      ;(invocation[dispose] as () => void).call(invocation)
    }
  }
  // Keep version-sensitive DOM knowledge in the Host adapter. A login form or
  // root element alone never establishes an interactive native application.
  const visible = (element: HTMLElement): boolean => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return element.isConnected && box.width > 0 && box.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden'
      && element.closest('[aria-hidden="true"]') === null
  }
  const editor = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"], textarea')]
    .some(element =>
      visible(element) && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true'
    )
  const manager = document.querySelector<HTMLElement>('[data-cordisx-react-manager="true"]')
  const model = document.querySelector<HTMLElement>('[data-cordisx-model-ready="true"]')
  if (!(editor && model && visible(model)) && !(manager && visible(manager))) {
    return { ready: false, reason: 'native-controls-pending' }
  }
  if (!current()) return { ready: false, reason: 'document-changed' }
  return {
    ready: true,
    receipt: initial.receipt,
    observations: { receipt: initial.receipt, hostUsable: true, cordisxReady: true, authenticated: true },
  }
}
