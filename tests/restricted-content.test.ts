import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  encodeRestrictedJson,
  mountRestrictedScene,
  type RestrictedScene,
  type RestrictedSceneActionResult,
  validateRestrictedScene,
} from '../packages/cli/src/renderer/restricted-content/index.js'

const buttonScene: RestrictedScene = { version: 1, root: { type: 'button', label: 'Play', action: { x: 1, y: 2 } } }
const numberScene: RestrictedScene = {
  version: 1,
  root: {
    type: 'number-action',
    label: 'Raise to',
    min: 10,
    max: 100,
    step: 5,
    value: 20,
    action: { type: 'raise' },
    valueKey: 'to',
  },
}

function fixture() {
  const dom = new JSDOM('<main></main>')
  let shadow!: ShadowRoot
  const original = dom.window.HTMLElement.prototype.attachShadow
  vi.spyOn(dom.window.HTMLElement.prototype, 'attachShadow').mockImplementation(function(this: HTMLElement, options) {
    shadow = original.call(this, options)
    return shadow
  })
  let current = true
  const abort = new AbortController()
  const onAction = vi.fn((): RestrictedSceneActionResult | Promise<RestrictedSceneActionResult> => ({
    status: 'accepted',
  }))
  const seat = mountRestrictedScene({
    element: dom.window.document.querySelector('main')!,
    onAction,
    isCurrent: () => current,
    signal: abort.signal,
  })
  return {
    dom,
    shadow,
    seat,
    abort,
    onAction,
    retire: () => {
      current = false
    },
  }
}

describe('restricted scene validation', () => {
  it('matches the shareable scene conformance fixtures', () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('../packages/cli/src/renderer/restricted-content/conformance.json', import.meta.url),
        'utf8',
      ),
    )
    for (const item of fixtures.valid) expect(() => validateRestrictedScene(item.scene), item.name).not.toThrow()
    for (const item of fixtures.invalid) expect(() => validateRestrictedScene(item.scene), item.name).toThrow()
  })
  it('accepts unknown game layouts and detaches actions from caller mutation', () => {
    const source = structuredClone(buttonScene)
    const scene = validateRestrictedScene(source)
    expect(scene).toEqual(source)
    expect(scene).not.toBe(source)
    expect(validateRestrictedScene(numberScene)).toEqual(numberScene)
    expect(
      validateRestrictedScene({
        version: 1,
        root: {
          type: 'grid',
          columns: 19,
          children: Array.from({ length: 361 }, () => buttonScene.root),
        },
      }),
    ).toBeTruthy()
  })

  it.each([
    { type: 'html', html: '<script>fetch("https://leak.invalid")</script>' },
    { type: 'text', text: 'hello', style: 'background:url(https://leak.invalid)' },
    { type: 'text', text: 'hello', url: 'file:///etc/passwd' },
    { type: 'button', label: 'x', action: {}, onclick: 'parent.Host()' },
    { type: 'grid', columns: 20, children: [] },
    { type: 'stack', direction: 'diagonal', children: [] },
    { type: 'button', label: 'x', action: JSON.parse('{"__proto__":{"polluted":true}}') },
    { ...numberScene.root, valueKey: 'constructor' },
    { ...numberScene.root, valueKey: 'nested.key' },
    { ...numberScene.root, value: 11 },
    { ...numberScene.root, step: 0 },
    { ...numberScene.root, action: [] },
    { ...numberScene.root, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  ])('rejects unauthorized primitive or field %j', root => {
    expect(() => validateRestrictedScene({ version: 1, root })).toThrow()
  })

  it('enforces text, bytes, depth, children, node count and action limits', () => {
    expect(() => validateRestrictedScene({ version: 1, root: { type: 'text', text: 'x'.repeat(2049) } })).toThrow()
    expect(() =>
      validateRestrictedScene({ version: 1, root: { type: 'button', label: 'x', action: 'x'.repeat(4096) } })
    ).toThrow()
    expect(() =>
      validateRestrictedScene({ version: 1, root: { type: 'stack', children: Array(401).fill(buttonScene.root) } })
    ).toThrow()
    let root: unknown = { type: 'text', text: 'ok' }
    for (let i = 0; i < 15; i++) root = { type: 'stack', children: [root] }
    expect(() => validateRestrictedScene({ version: 1, root })).not.toThrow()
    expect(() => validateRestrictedScene({ version: 1, root: { type: 'stack', children: [root] } })).toThrow()
    const many = {
      type: 'stack',
      children: Array(4).fill({ type: 'stack', children: Array(300).fill({ type: 'text', text: '' }) }),
    }
    expect(() => validateRestrictedScene({ version: 1, root: many })).toThrow()
    expect(() =>
      validateRestrictedScene({
        version: 1,
        root: { type: 'stack', children: Array(40).fill({ type: 'text', text: '界'.repeat(1000) }) },
      })
    ).toThrow()
  })

  it('rejects non-JSON values, getters, sparse arrays and cycles without invoking getters', () => {
    const getter = vi.fn(() => 1)
    const object = Object.defineProperty({}, 'secret', { enumerable: true, get: getter })
    for (const value of [object, [undefined], Array(2), NaN, Infinity, 1n, new Date(), { constructor: 1 }]) {
      expect(() => encodeRestrictedJson(value, 4096)).toThrow()
    }
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(() => encodeRestrictedJson(cycle, 4096)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('trusted scene DOM and lifecycle', () => {
  it('keeps two seats independent and rejects clicks from a disposed seat', () => {
    const first = fixture()
    const second = fixture()
    first.seat.publish({ sequence: 7, scene: buttonScene })
    second.seat.publish({ sequence: 7, scene: buttonScene })
    const retired = first.shadow.querySelector('button')!
    first.seat.dispose()
    retired.dispatchEvent(new first.dom.window.Event('click'))
    second.shadow.querySelector('button')!.click()
    expect(first.onAction).not.toHaveBeenCalled()
    expect(second.onAction).toHaveBeenCalledExactlyOnceWith({ sequence: 7, payload: { x: 1, y: 2 } })
    second.seat.dispose()
    first.dom.window.close()
    second.dom.window.close()
  })

  it('renders HTML and URL strings only as text; creates no execution or egress elements', () => {
    const f = fixture()
    const text = '<img src="http://127.0.0.1/leak"><script>parent.Host()</script>'
    expect(f.seat.publish({ sequence: 0, scene: { version: 1, root: { type: 'text', text } } })).toEqual({
      status: 'accepted',
    })
    expect(f.shadow.querySelector('.text')?.textContent).toBe(text)
    expect(f.shadow.querySelector('script,img,iframe,a,form,object,link')).toBeNull()
    f.seat.dispose()
    f.dom.window.close()
  })

  it('rejects old sequence, detached controls, retired owner and late callbacks', async () => {
    const f = fixture()
    let resolve!: (result: RestrictedSceneActionResult) => void
    f.onAction.mockImplementationOnce(() =>
      new Promise(done => {
        resolve = done
      })
    )
    f.seat.publish({ sequence: 1, scene: buttonScene })
    const old = f.shadow.querySelector('button')!
    old.click()
    old.click()
    expect(f.onAction).toHaveBeenCalledTimes(1)
    f.seat.publish({ sequence: 2, scene: buttonScene })
    const fresh = f.shadow.querySelector('button')!
    fresh.click()
    resolve({ status: 'rejected' })
    await Promise.resolve()
    expect(fresh.disabled).toBe(true)
    old.dispatchEvent(new f.dom.window.Event('click'))
    expect(f.onAction).toHaveBeenCalledTimes(2)
    expect(f.seat.publish({ sequence: 1, scene: buttonScene })).toEqual({ status: 'rejected', code: 'stale-sequence' })
    f.seat.publish({ sequence: 3, scene: buttonScene })
    f.retire()
    f.shadow.querySelector('button')!.click()
    expect(f.onAction).toHaveBeenCalledTimes(2)
    f.abort.abort()
    expect(f.dom.window.document.querySelector('main')!.children).toHaveLength(0)
    f.seat.dispose()
    f.dom.window.close()
  })

  it('unlocks explicit rejection for a corrected amount at the same sequence', async () => {
    const f = fixture()
    f.onAction.mockReturnValueOnce({ status: 'rejected' })
    f.seat.publish({ sequence: 5, scene: numberScene })
    const input = f.shadow.querySelector('input')!
    const button = f.shadow.querySelector('button')!
    input.value = '11'
    button.click()
    expect(f.onAction).not.toHaveBeenCalled()
    input.value = '25'
    button.click()
    expect(f.onAction).toHaveBeenLastCalledWith({ sequence: 5, payload: { type: 'raise', to: 25 } })
    expect(button.disabled).toBe(true)
    await Promise.resolve()
    expect(button.disabled).toBe(false)
    input.value = '30'
    button.click()
    expect(f.onAction).toHaveBeenLastCalledWith({ sequence: 5, payload: { type: 'raise', to: 30 } })
    f.seat.dispose()
    f.dom.window.close()
  })

  it('preserves disabled state and keeps uncertain actions locked', async () => {
    const f = fixture()
    f.onAction.mockReturnValue({ status: 'uncertain' })
    f.seat.publish({
      sequence: 0,
      scene: {
        version: 1,
        root: {
          type: 'stack',
          children: [buttonScene.root, { type: 'button', label: 'No', disabled: true, action: {} }],
        },
      },
    })
    const buttons = f.shadow.querySelectorAll('button')
    buttons[1]!.click()
    expect(f.onAction).not.toHaveBeenCalled()
    buttons[0]!.click()
    await Promise.resolve()
    buttons[0]!.click()
    expect(f.onAction).toHaveBeenCalledTimes(1)
    f.seat.publish({ sequence: 1, scene: null })
    expect(f.shadow.querySelector('button')).toBeNull()
    f.seat.dispose()
    f.dom.window.close()
  })

  it('invalidates stale actions on malformed projection and bounds publish work', () => {
    const f = fixture()
    f.seat.publish({ sequence: 0, scene: buttonScene })
    const old = f.shadow.querySelector('button')!
    expect(f.seat.publish({ sequence: 1, scene: { version: 1, root: { type: 'html' } } as unknown as RestrictedScene }))
      .toEqual({ status: 'rejected', code: 'invalid-scene' })
    old.click()
    expect(f.onAction).not.toHaveBeenCalled()
    let result
    for (let sequence = 2; sequence < 40; sequence++) result = f.seat.publish({ sequence, scene: null })
    expect(result).toEqual({ status: 'rejected', code: 'rate-limited' })
    f.seat.dispose()
    expect(f.seat.publish({ sequence: 100, scene: buttonScene })).toEqual({ status: 'rejected', code: 'disposed' })
    f.dom.window.close()
  })
})
