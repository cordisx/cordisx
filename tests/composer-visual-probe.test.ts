import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { probeComposerVisual } from '../packages/cli/src/renderer/adapter/composer-visual-probe.js'

function fixture() {
  const dom = new JSDOM(
    '<div data-codex-composer-root data-composer-placement="main"><div contenteditable="true" role="textbox"></div><div data-composer-footer-responsive><button class="size-token-button-composer" aria-label="Start voice chat" aria-busy="false"><svg></svg></button></div></div>',
  )
  const { document } = dom.window
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 28,
    bottom: 28,
    width: 28,
    height: 28,
    toJSON() {},
  })
  return { document, button: document.querySelector('button')!, editor: document.querySelector('[contenteditable]')! }
}
describe('native Composer visual semantic probe', () => {
  it('uses actual operation labels independently of draft content and preserves native controls', () => {
    const { document, button, editor } = fixture()
    editor.textContent = 'private draft must never be projected'
    for (
      const [label, action] of [
        ['Start voice chat', 'voice'],
        ['Send', 'send'],
        ['Stop', 'stop'],
        ['Queue', 'queue'],
        ['Steer', 'steer'],
        ['Resume', 'resume'],
        ['Cancel voice chat', 'cancel'],
      ]
    ) {
      button.setAttribute('aria-label', label!)
      const result = probeComposerVisual(document)
      expect(result.status).toBe('available')
      if (result.status !== 'available') throw new Error(result.reason)
      expect(result.seat.action).toBe(action)
      expect(result.seat.draftEmpty).toBe(false)
      expect(result.seat.button).toBe(button)
      expect(Object.keys(result.seat)).not.toContain('text')
    }
  })
  it('fails closed on unknown, ambiguous, hidden, and unobservable native controls', () => {
    const { document, button } = fixture()
    button.setAttribute('aria-label', 'Unexpected operation')
    expect(probeComposerVisual(document).status).toBe('unavailable')
    button.setAttribute('aria-label', 'Send')
    button.setAttribute('aria-busy', 'unknown')
    expect(probeComposerVisual(document).status).toBe('unavailable')
    button.setAttribute('aria-busy', 'false')
    button.parentElement!.append(button.cloneNode(true))
    expect(probeComposerVisual(document).status).toBe('unavailable')
    document.body.innerHTML = ''
    expect(probeComposerVisual(document).status).toBe('pending')
  })
  it('projects disabled and busy without treating a running response as busy', () => {
    const { document, button } = fixture()
    button.setAttribute('aria-label', 'Stop')
    const first = probeComposerVisual(document)
    expect(first.status === 'available' && first.seat.enabled).toBe(true)
    button.setAttribute('aria-busy', 'true')
    const second = probeComposerVisual(document)
    expect(second.status === 'available' && second.seat.busy && second.seat.enabled).toBe(true)
  })
})
