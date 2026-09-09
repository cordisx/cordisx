import { RESTRICTED_LIMITS, type RestrictedJson } from './json.js'
import {
  type RestrictedScene,
  type RestrictedSceneNode,
  validateRestrictedScene,
  validRestrictedNumber,
} from './scene.js'

export type RestrictedScenePublishResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly code: 'invalid-scene' | 'stale-sequence' | 'disposed' | 'rate-limited' }

export interface RestrictedSceneSeat {
  publish(snapshot: { readonly sequence: number; readonly scene: RestrictedScene | null }): RestrictedScenePublishResult
  dispose(): void
}

export interface RestrictedSceneMountOptions {
  readonly element: HTMLElement
  readonly onAction: (
    action: { readonly sequence: number; readonly payload: RestrictedJson },
  ) => RestrictedSceneActionResult | Promise<RestrictedSceneActionResult>
  /** Host-owned owner/generation fence. Never derived from scene or action data. */
  readonly isCurrent: () => boolean
  readonly signal?: AbortSignal
}

export interface RestrictedSceneActionResult {
  readonly status: 'accepted' | 'rejected' | 'uncertain'
}

/** Renders only a validated data tree. No uploaded browser JavaScript or HTML runs. */
export function mountRestrictedScene(options: RestrictedSceneMountOptions): RestrictedSceneSeat {
  const { element } = options
  const doc = element.ownerDocument
  const surface = doc.createElement('div')
  surface.dataset.cordisxRestrictedScene = 'v1'
  const root = surface.attachShadow({ mode: 'closed' })
  const style = doc.createElement('style')
  // All selectors and values are Host-owned. No scene string enters CSS.
  style.textContent = `
    :host { display: block; color: inherit; font: inherit; overflow-wrap: anywhere; }
    * { box-sizing: border-box; min-width: 0; }
    .stack { display: flex; flex-direction: column; gap: 8px; }
    .horizontal { flex-direction: row; flex-wrap: wrap; align-items: center; }
    .grid { display: grid; gap: 4px; }
    .muted { opacity: .7; }
    .accent { font-weight: 600; }
    .text { white-space: pre-wrap; }
    button, input { font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 4px; padding: 6px; }
    button { cursor: pointer; white-space: pre-wrap; }
    button:disabled { opacity: .5; cursor: default; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  `
  const body = doc.createElement('div')
  root.append(style, body)
  element.append(surface)
  let disposed = false
  let sequence = -1
  let revision = 0
  let acted = false
  let windowStart = 0
  let windowCount = 0
  let controls: (HTMLButtonElement | HTMLInputElement)[] = []

  function current(): boolean {
    return !disposed && !options.signal?.aborted && options.isCurrent()
  }

  function clear(): void {
    revision++
    controls = []
    body.replaceChildren()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    clear()
    surface.remove()
    options.signal?.removeEventListener('abort', dispose)
  }

  function render(node: RestrictedSceneNode, activeRevision: number, activeSequence: number): HTMLElement {
    if (node.type === 'text') {
      const text = doc.createElement('div')
      text.className = `text ${node.tone ?? 'default'}`
      text.textContent = node.text
      return text
    }
    if (node.type === 'button' || node.type === 'number-action') {
      const button = doc.createElement('button')
      button.type = 'button'
      button.textContent = node.label
      button.disabled = node.type === 'button' && node.disabled === true
      if (node.type === 'button' && node.ariaLabel !== undefined) button.setAttribute('aria-label', node.ariaLabel)
      let input: HTMLInputElement | undefined
      let container: HTMLDivElement | undefined
      if (node.type === 'number-action') {
        container = doc.createElement('div')
        container.className = 'stack'
        const field = doc.createElement('label')
        field.className = 'stack'
        const label = doc.createElement('span')
        label.textContent = node.label
        input = doc.createElement('input')
        input.type = 'number'
        input.min = String(node.min)
        input.max = String(node.max)
        input.step = String(node.step)
        input.value = String(node.value)
        input.setAttribute('aria-label', node.label)
        field.append(label, input)
        container.append(field, button)
        controls.push(input)
      }
      button.addEventListener('click', () => {
        if (
          !current() || !surface.isConnected || !button.isConnected || button.disabled || acted
          || activeRevision !== revision || activeSequence !== sequence
        ) return
        let payload = node.action
        if (node.type === 'number-action') {
          const value = input!.valueAsNumber
          if (!validRestrictedNumber(node, value)) {
            input!.setCustomValidity('Enter a whole number within the allowed range and step.')
            input!.reportValidity()
            return
          }
          input!.setCustomValidity('')
          payload = { ...node.action, [node.valueKey]: value }
        }
        // Lock before invoking client code, including re-entrant callbacks.
        acted = true
        const activeControls = controls.map(control => ({ control, disabled: control.disabled }))
        for (const sibling of controls) sibling.disabled = true
        void (async () => {
          try {
            const result = await options.onAction({
              sequence: activeSequence,
              payload: JSON.parse(JSON.stringify(payload)) as RestrictedJson,
            })
            // Only explicit rejection is safe to retry. Unknown/throw/accepted
            // remain locked until reconciliation publishes a fresh projection.
            if (
              result?.status !== 'rejected' || !current() || activeRevision !== revision || activeSequence !== sequence
            ) return
            acted = false
            for (const { control, disabled } of activeControls) control.disabled = disabled
          } catch { /* Ambiguous outcome: client must reconcile using the same idempotency key. */ }
        })()
      })
      controls.push(button)
      return container ?? button
    }
    const container = doc.createElement('div')
    if (node.type === 'grid') {
      container.className = 'grid'
      container.style.gridTemplateColumns = `repeat(${node.columns}, minmax(0, 1fr))`
    } else {
      container.className = node.direction === 'horizontal' ? 'stack horizontal' : 'stack'
    }
    for (const child of node.children) container.append(render(child, activeRevision, activeSequence))
    return container
  }

  const seat: RestrictedSceneSeat = {
    publish(snapshot) {
      if (!current()) {
        dispose()
        return { status: 'rejected', code: 'disposed' }
      }
      if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || snapshot.sequence <= sequence) {
        return { status: 'rejected', code: 'stale-sequence' }
      }
      sequence = snapshot.sequence
      acted = false
      // Invalidate prior actions even if this newer projection is malformed.
      clear()
      const now = performance.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        windowCount = 0
      }
      if (++windowCount > RESTRICTED_LIMITS.publishesPerSecond) return { status: 'rejected', code: 'rate-limited' }
      if (snapshot.scene === null) return { status: 'accepted' }
      let scene: RestrictedScene
      try {
        scene = validateRestrictedScene(snapshot.scene)
      } catch {
        return { status: 'rejected', code: 'invalid-scene' }
      }
      body.append(render(scene.root, revision, sequence))
      return { status: 'accepted' }
    },
    dispose,
  }
  options.signal?.addEventListener('abort', dispose, { once: true })
  if (!current()) dispose()
  return seat
}
