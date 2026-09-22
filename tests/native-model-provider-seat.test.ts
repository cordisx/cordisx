import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  locateNativeModelProviderSeat,
  locateNativeModelSelectionControl,
} from '../packages/cli/src/renderer/adapter/native-model-provider-seat.js'
import { composer } from './fixtures/native-model-provider-composer.js'

describe('native model provider seat', () => {
  it('locates only the unique visible native intelligence trigger in the composer footer', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="thread">
        <footer data-composer-footer-responsive>
          <span id="seat"><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span>
          <button data-codex-intelligence-trigger="true">Unrelated</button>
        </footer>
      </main>
    </body>`)
    const elements = [...dom.window.document.querySelectorAll<HTMLElement>('*')]
    for (const element of elements) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      })
    }
    expect(locateNativeModelProviderSeat(dom.window.document)).toEqual({
      trigger: dom.window.document.querySelector('button[aria-haspopup]'),
      group: dom.window.document.getElementById('seat'),
      parent: dom.window.document.querySelector('footer'),
    })
    dom.window.close()
  })

  it('reads supported reasoning efforts from the audited native owner', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const { trigger } = composer(dom.window.document)
    expect(locateNativeModelSelectionControl(trigger)).toMatchObject({
      model: 'model-a',
      reasoningEffort: 'high',
      reasoningEfforts: ['low', 'high'],
    })
    dom.window.close()
  })

  it('fails closed for the superseded build-7119 owner shape', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const { trigger } = composer(dom.window.document)
    const fiber = (trigger as unknown as Record<string, unknown>)['__reactFiber$test'] as {
      return: { memoizedProps: Record<string, unknown> }
    }
    delete fiber.return.memoizedProps.modelOptions
    delete fiber.return.memoizedProps.powerSelections
    delete fiber.return.memoizedProps.menuView
    delete fiber.return.memoizedProps.open
    delete fiber.return.memoizedProps.onSelectModelOption
    delete fiber.return.memoizedProps.onToggleMenuView
    expect(locateNativeModelSelectionControl(trigger)).toBeUndefined()
    dom.window.close()
  })

  it('fails closed for ambiguous triggers', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <main data-codex-composer-root data-composer-placement="thread">
        <footer data-composer-footer-responsive>
          <button data-codex-intelligence-trigger="true" aria-haspopup="menu">One</button>
          <button data-codex-intelligence-trigger="true" aria-haspopup="menu">Two</button>
        </footer>
      </main>
    </body>`)
    for (const element of dom.window.document.querySelectorAll<HTMLElement>('*')) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      })
    }
    expect(locateNativeModelProviderSeat(dom.window.document)).toBeUndefined()
    dom.window.close()
  })

  it('rediscovers the trigger hidden by the owning selector', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' })
    const { trigger } = composer(dom.window.document)
    trigger.hidden = true
    trigger.dataset.cordisxModelProviderHidden = 'true'
    expect(locateNativeModelProviderSeat(dom.window.document)?.trigger).toBe(trigger)
    dom.window.close()
  })
})
