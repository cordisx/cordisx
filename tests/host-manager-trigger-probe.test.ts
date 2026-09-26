import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerTriggerTarget } from '../packages/cli/src/renderer/host-probes.js'

describe('native Manager trigger probe', () => {
  const makeVisible = (document: Document) => {
    for (const button of document.querySelectorAll('button')) {
      button.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
  }

  it('finds the current Codex mode control when hidden accessibility text changes textContent', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <button aria-haspopup="menu" aria-label="切换模式，当前模式：Codex">
        <span class="sr-only">Codex</span><span>Codex</span><svg><title>Codex</title></svg>
      </button>
    </body>`)
    makeVisible(dom.window.document)
    const button = dom.window.document.querySelector('button')
    expect(resolveManagerTriggerTarget(dom.window.document)).toBe(button)
  })

  it('keeps the legacy exact-label control and rejects ambiguous or non-Codex controls', () => {
    const dom = new JSDOM('<!doctype html><body><button aria-haspopup="menu">Codex</button></body>')
    const document = dom.window.document
    makeVisible(document)
    expect(resolveManagerTriggerTarget(document)).toBe(document.querySelector('button'))
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button aria-haspopup="menu" aria-label="Switch mode, current mode: Codex">Codex</button>',
    )
    makeVisible(document)
    expect(resolveManagerTriggerTarget(document)).toBeUndefined()
    document.querySelector('button')?.remove()
    document.querySelector('button')?.setAttribute('aria-label', 'Switch mode, current mode: ChatGPT')
    document.querySelector('button')!.textContent = 'ChatGPT'
    expect(resolveManagerTriggerTarget(document)).toBeUndefined()
  })
})
