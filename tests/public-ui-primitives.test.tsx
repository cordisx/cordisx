import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { PublicMarkdownViewer } from '../packages/cli/src/renderer/host-ui/PublicMarkdownViewer.js'
import { PublicSelectionRail } from '../packages/cli/src/renderer/host-ui/PublicSelectionRail.js'

interface TestGlobals {
  readonly document: typeof globalThis.document
  readonly window: typeof globalThis.window
  readonly MutationObserver: typeof globalThis.MutationObserver
  readonly IS_REACT_ACT_ENVIRONMENT: typeof globalThis.IS_REACT_ACT_ENVIRONMENT
}

const previous: TestGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

function installDom(narrow = false): JSDOM {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="root"></div></body></html>', { url: 'https://host.invalid/' })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: (query: string) => ({
      matches: query === '(max-width: 640px)' ? narrow : query.includes('dark'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  })
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return dom
}

function Rail({ layout = 'responsive' }: { readonly layout?: 'responsive' | 'vertical' | 'horizontal' }) {
  const [value, setValue] = useState('identity')
  return <>
    <PublicSelectionRail
      aria-label="Prompt sections"
      layout={layout}
      value={value}
      options={[
        { value: 'identity', label: 'Identity', controls: 'prompt-panel' },
        { value: 'disabled', label: 'Unavailable', controls: 'prompt-panel', disabled: true },
        { value: 'instructions', label: 'Instructions', description: 'System prompt', controls: 'prompt-panel' },
      ]}
      onChange={setValue}
    />
    <div id="prompt-panel" role="tabpanel">{value}</div>
  </>
}

describe('public Host UI primitives', () => {
  it('selects vertical sections with Arrow, Home, and End while skipping disabled tabs', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<Rail layout="vertical" />))
      const tablist = dom.window.document.querySelector<HTMLElement>('[role="tablist"]')!
      expect(tablist.getAttribute('aria-orientation')).toBe('vertical')
      const identity = dom.window.document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
      await act(async () => identity.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toBe('instructions')
      const instructions = dom.window.document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
      expect(dom.window.document.activeElement).toBe(instructions)
      await act(async () => instructions.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toBe('identity')
      const first = dom.window.document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
      await act(async () => first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })))
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toBe('instructions')
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('uses horizontal Arrow navigation in the narrow responsive layout', async () => {
    const dom = installDom(true)
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<Rail />))
      const tablist = dom.window.document.querySelector<HTMLElement>('[role="tablist"]')!
      expect(tablist.dataset.layout).toBe('horizontal')
      expect(tablist.getAttribute('aria-orientation')).toBe('horizontal')
      const identity = dom.window.document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!
      await act(async () => identity.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
      expect(dom.window.document.querySelector('[role="tabpanel"]')?.textContent).toBe('instructions')
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('sanitizes unsafe Markdown and preserves safe themed media and external-link fences', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<PublicMarkdownViewer aria-label="Prompt Markdown" source={[
        '<picture>',
        '  <source media="(prefers-color-scheme: dark)" srcset="https://cdn.example/dark.svg">',
        '  <source media="(prefers-color-scheme: light)" srcset="https://cdn.example/light.svg">',
        '  <img alt="Agent" src="https://cdn.example/agent.png" onerror="alert(1)">',
        '</picture>',
        '',
        '[safe](https://example.com) [unsafe](javascript:alert(1))',
        '',
        '<script>alert(1)</script><iframe src="https://unsafe.invalid"></iframe>',
      ].join('\n')} />))
      const document = dom.window.document
      expect(document.querySelector('[aria-label="Prompt Markdown"]')).not.toBeNull()
      expect(document.querySelector('script')).toBeNull()
      expect(document.querySelector('iframe')).toBeNull()
      expect(document.querySelector('img')?.hasAttribute('onerror')).toBe(false)
      expect(document.querySelector('picture source[media="all"]')?.getAttribute('srcset')).toBe('https://cdn.example/dark.svg')
      const links = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      expect(links[0]?.getAttribute('target')).toBe('_blank')
      expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer')
      expect(links[1]?.hasAttribute('href')).toBe(false)
      await act(async () => {
        document.documentElement.dataset.theme = 'light'
        await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      })
      expect(document.querySelector('picture source[media="all"]')?.getAttribute('srcset')).toBe('https://cdn.example/light.svg')
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
})
