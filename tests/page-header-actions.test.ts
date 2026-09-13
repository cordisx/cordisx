import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { mountPageHeaderActions } from '../packages/cli/src/renderer/page-header-actions.js'
import { pageChromeButton, PageRegistry } from '../packages/cli/src/renderer/navigation-pages.js'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_PAGE_SCHEMA_V4 } from '../packages/cli/src/contracts.js'
import type {
  CordisXLocalizedText,
  CordisXPageHeaderActionV4,
  CordisXPageHeaderVisual,
} from '../packages/cli/src/contracts.js'

const label = { key: 'guest', fallback: 'Anonymous guest' }
const command = (id: string) => ({ id, label: { key: id }, command: { id } })
const guest: CordisXPageHeaderActionV4 = {
  id: 'guest',
  label,
  visual: { kind: 'avatar' },
  menu: [command('profile'), { ...command('disabled'), disabled: { value: true } }, command('settings')],
}
function fixture(action = guest) {
  const dom = new JSDOM('<body><header></header><button id="after">After</button></body>')
  const document = dom.window.document
  const chrome = document.querySelector('header')!
  const calls: string[] = []
  let available = true
  let refresh = () => {}
  let relocalize = () => {}
  let updateLabel: (id: string, label: CordisXLocalizedText) => boolean = () => false
  let updateVisual: (id: string, visual: CordisXPageHeaderVisual) => boolean = () => false
  const dispose = mountPageHeaderActions({
    registerLabelUpdater: update => {
      updateLabel = update
    },
    registerVisualUpdater: update => {
      updateVisual = update
    },
    chrome,
    actions: [action],
    button: (label, icon) => pageChromeButton(document, label, icon),
    resolve: message => message.fallback ?? message.key,
    localize: callback => {
      relocalize = callback
      callback()
    },
    visible: () => true,
    available: () => available,
    subscribe: callback => {
      refresh = callback
      return () => {}
    },
    execute: async (_action, id) => {
      calls.push(id)
    },
  })
  return {
    dom,
    document,
    calls,
    relocalize: () => relocalize(),
    updateLabel: (id: string, label: CordisXLocalizedText) => updateLabel(id, label),
    updateVisual: (id: string, visual: CordisXPageHeaderVisual) => updateVisual(id, visual),
    dispose,
    trigger: chrome.querySelector('button')!,
    revoke: () => {
      available = false
      refresh()
    },
  }
}

describe('Host page v4 headers', () => {
  it.each(['light', 'dark'])('aligns mixed icon and text menu rows in the %s theme', theme => {
    const f = fixture({
      ...guest,
      menu: [
        { ...command('profile'), icon: 'host:people' },
        command('source'),
        { ...command('settings'), icon: 'host:settings' },
      ],
    })
    try {
      f.document.documentElement.dataset.theme = theme
      const chrome = f.document.querySelector('header')!
      chrome.style.color = theme === 'dark' ? 'rgb(240, 240, 240)' : 'rgb(24, 24, 24)'
      chrome.style.backgroundColor = theme === 'dark' ? 'rgb(24, 24, 24)' : 'rgb(240, 240, 240)'
      f.trigger.click()
      const rows = [...f.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(rows.map(row => row.textContent)).toEqual(['profile', 'source', 'settings'])
      for (const row of rows) {
        expect(f.dom.window.getComputedStyle(row).display).toBe('grid')
        expect(f.dom.window.getComputedStyle(row).gridTemplateColumns).toBe('16px minmax(0,1fr)')
        const leading = row.firstElementChild!
        expect(leading.className).toBe('cordisx-page-header-menu-leading')
        expect(leading.getAttribute('aria-hidden')).toBe('true')
        expect(f.dom.window.getComputedStyle(leading).width).toBe('16px')
        expect(row.lastElementChild!.className).toBe('cordisx-page-header-menu-label')
        expect(row.getAttribute('aria-label')).toBe(row.textContent)
      }
      expect(rows[1]!.firstElementChild!.childElementCount).toBe(0)
      for (const row of [rows[0]!, rows[2]!]) {
        const svg = row.querySelector('svg')!
        expect(svg.dataset.hostIconProvider).toBe('builtin:reicon')
        expect(svg.dataset.hostIconVariant).toBe('regular')
        expect(svg.dataset.hostIconTheme).toBe(theme)
        expect(f.dom.window.getComputedStyle(svg).width).toBe('16px')
        for (const path of svg.querySelectorAll('path')) {
          expect([path.getAttribute('fill'), path.getAttribute('stroke')]).toContain('currentColor')
        }
      }
      expect((f.document.querySelector('[role="menu"]') as HTMLElement).style.color).toBe(chrome.style.color)
    } finally {
      f.dispose()
      expect(f.document.querySelector('[role="menu"]')).toBeNull()
      f.dom.window.close()
    }
  })

  it('owns keyboard menu navigation, dispatch identity, focus return and portal cleanup', async () => {
    const f = fixture()
    expect(f.trigger.querySelector('[data-avatar="anonymous"]')).not.toBeNull()
    expect(f.trigger.getAttribute('aria-label')).toBe('Anonymous guest')
    f.trigger.click()
    const menu = f.document.querySelector('[role="menu"]')!
    expect(f.document.activeElement?.textContent).toBe('profile')
    menu.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(f.document.activeElement?.textContent).toBe('settings')
    menu.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(f.document.querySelector('[role="menu"]')).toBeNull()
    expect(f.document.activeElement).toBe(f.trigger)
    f.trigger.click()
    f.document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    await Promise.resolve()
    expect(f.calls).toEqual(['guest/profile'])
    f.trigger.click()
    f.dispose()
    expect(f.document.querySelector('[role="menu"]')).toBeNull()
    expect(f.document.querySelector('.cordisx-page-chrome-action')).toBeNull()
    f.dom.window.close()
  })
  it('closes on revocation and outside pointer input; failed avatars restore anonymous glyph', () => {
    const f = fixture({ ...guest, visual: { kind: 'avatar', src: 'data:image/png;base64,AAAA' } })
    f.trigger.querySelector('img')!.dispatchEvent(new f.dom.window.Event('error'))
    expect(f.trigger.querySelector('[data-avatar="anonymous"]')).not.toBeNull()
    f.trigger.click()
    f.document.body.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }))
    expect(f.document.querySelector('[role="menu"]')).toBeNull()
    f.trigger.click()
    f.revoke()
    expect(f.document.querySelector('[role="menu"]')).toBeNull()
    expect(f.trigger.disabled).toBe(true)
    f.dispose()
    f.dom.window.close()
  })
  it('suppresses duplicate pending commands', async () => {
    const dom = new JSDOM('<header></header>')
    let calls = 0
    let finish = () => {}
    const dispose = mountPageHeaderActions({
      chrome: dom.window.document.querySelector('header')!,
      actions: [command('create')],
      button: (label, icon) => pageChromeButton(dom.window.document, label, icon),
      resolve: message => message.key,
      localize: callback => callback(),
      visible: () => true,
      available: () => true,
      subscribe: () => () => {},
      execute: () => {
        calls++
        return new Promise<void>(resolve => {
          finish = resolve
        })
      },
    })
    const button = dom.window.document.querySelector('button')!
    button.click()
    button.click()
    expect(calls).toBe(1)
    expect(button.getAttribute('aria-busy')).toBe('true')
    finish()
    await Promise.resolve()
    expect(button.disabled).toBe(false)
    dispose()
    dom.window.close()
  })
  it('renders an opt-in primary command label and preserves its command dispatch', async () => {
    const f = fixture({ ...command('create'), icon: 'host:new', presentation: 'primary' })
    expect(f.trigger.dataset.presentation).toBe('primary')
    expect(f.trigger.querySelector('.cordisx-page-header-label')?.textContent).toBe('create')
    expect(f.trigger.querySelector('[data-host-icon="host:new"]')).not.toBeNull()
    f.trigger.click()
    await Promise.resolve()
    expect(f.calls).toEqual(['create'])
    f.dispose()
    f.dom.window.close()
  })
  it('opts only the outlined primary into a bordered transparent idle surface', async () => {
    const outlined = fixture({ ...command('create'), icon: 'host:new', presentation: 'primary', variant: 'outlined' })
    const ordinary = fixture({ ...command('create'), presentation: 'primary' })
    const icon = fixture(command('create'))
    try {
      expect(outlined.trigger.dataset.variant).toBe('outlined')
      expect(ordinary.trigger.dataset.variant).toBeUndefined()
      expect(icon.trigger.dataset.variant).toBeUndefined()
      expect(outlined.dom.window.getComputedStyle(outlined.trigger).backgroundColor).toBe('rgba(0, 0, 0, 0)')
      const rules = [...outlined.document.styleSheets].flatMap(sheet => [...sheet.cssRules])
      const variant = rules.find(rule => rule.cssText.includes('[data-variant="outlined"]')) as CSSStyleRule
      expect(variant.style.background).toBe('transparent')
      expect(variant.style.border).toContain('1px solid')
      const hover = rules.findIndex(rule => rule.cssText.includes(':hover:not(:disabled)'))
      expect(hover).toBeGreaterThan(rules.indexOf(variant))
      outlined.trigger.click()
      await Promise.resolve()
      expect(outlined.calls).toEqual(['create'])
      outlined.revoke()
      expect(outlined.trigger.disabled).toBe(true)
      expect(outlined.trigger.dataset.variant).toBe('outlined')
    } finally {
      for (const f of [outlined, ordinary, icon]) {
        f.dispose()
        f.dom.window.close()
      }
    }
  })
  it('rejects new fields under v3, nested/duplicate menus and remote images', () => {
    const register = (actions: readonly unknown[], version = 4) => {
      const pages = new PageRegistry()
      try {
        pages.register('demo', {
          $schema: version === 4 ? CORDISX_PAGE_SCHEMA_V4 : CORDISX_PAGE_SCHEMA_V3,
          schemaVersion: version,
          id: 'lobby',
          title: label,
          description: label,
          headerActions: actions,
        } as never, () => {})
      } finally {
        pages.dispose()
      }
    }
    expect(() => register([guest])).not.toThrow()
    expect(() =>
      register([{ ...command('create'), presentation: 'primary' }, { ...command('balance'), presentation: 'text' }, {
        ...command('status'),
        presentation: 'text',
      }])
    ).not.toThrow()
    expect(() => register([{ ...command('balance'), presentation: 'text' }], 3)).toThrow('unknown field')
    expect(() => register([{ ...guest, presentation: 'text' }])).toThrow('presentation')
    expect(() => register([{ ...command('balance'), presentation: 'text', visual: { kind: 'avatar' } }])).toThrow(
      'text',
    )
    expect(() => register([{ ...command('balance'), presentation: 'text', variant: 'outlined' }])).toThrow('variant')
    expect(() => register([{ ...command('create'), presentation: 'primary', variant: 'outlined' }])).not.toThrow()
    for (
      const action of [
        { ...command('create'), variant: 'outlined' },
        { ...command('create'), presentation: 'icon', variant: 'outlined' },
        { ...command('create'), presentation: 'primary', variant: 'filled' },
        { ...guest, variant: 'outlined' },
      ]
    ) expect(() => register([action])).toThrow('variant')
    expect(() => register([{ ...guest, menu: [{ ...command('profile'), variant: 'outlined' }] }])).toThrow(
      'unknown field',
    )
    expect(() => register([{ ...command('create'), variant: 'outlined' }], 3)).toThrow('unknown field')
    expect(() => register([{ ...command('create'), presentation: 'primary' }])).not.toThrow()
    expect(() => register([{ ...guest, presentation: 'primary' }])).toThrow('presentation')
    expect(() => register([{ ...command('create'), presentation: 'primary', visual: { kind: 'avatar' } }])).toThrow(
      'primary',
    )
    expect(() => register(['a', 'b'].map(id => ({ ...command(id), presentation: 'primary' })))).toThrow('one primary')
    expect(() => register([{ ...command('create'), presentation: 'primary' }], 3)).toThrow('unknown field')
    expect(() => register([guest], 3)).toThrow('unknown field')
    expect(() => register([{ ...guest, menu: [guest] }])).toThrow('unknown field')
    expect(() => register([{ ...guest, menu: [command('same'), command('same')] }])).toThrow('duplicate')
    expect(() => register([{ ...guest, visual: { kind: 'avatar', src: 'https://example.test/me.png' } }])).toThrow(
      'inline raster',
    )
  })
})

it('updates declared visuals without replacing the trigger or its open menu; fences invalid and retired updates', () => {
  const f = fixture()
  try {
    f.trigger.focus()
    f.trigger.click()
    const menu = f.document.querySelector('[role="menu"]')
    expect(f.updateVisual('missing', { kind: 'avatar' })).toBe(false)
    expect(f.updateVisual('guest', { kind: 'image', src: 'data:image/png;base64,AAAA' })).toBe(false)
    for (
      const src of [
        'https://example.com/a.png',
        'data:image/svg+xml;base64,AAAA',
        'data:image/png;base64,' + 'A'.repeat(262144),
      ]
    ) {
      expect(f.updateVisual('guest', { kind: 'avatar', src })).toBe(false)
    }
    expect(f.updateVisual('guest', { kind: 'avatar', src: 'data:image/png;base64,AAAA' })).toBe(true)
    const image = f.trigger.querySelector('img')!
    expect(f.document.querySelector('header button')).toBe(f.trigger)
    expect(f.document.querySelector('[role="menu"]')).toBe(menu)
    image.dispatchEvent(new f.dom.window.Event('error'))
    expect(f.trigger.querySelector('[data-avatar="anonymous"]')).not.toBeNull()
    expect(f.updateVisual('guest', { kind: 'avatar' })).toBe(true)
    f.dispose()
    expect(f.updateVisual('guest', { kind: 'avatar' })).toBe(false)
  } finally {
    f.dispose()
    f.dom.window.close()
  }
})

it('updates text labels in place, renders markup as text and fences invalid, nested item and retired updates', () => {
  const f = fixture({ ...command('balance'), presentation: 'text' })
  const menu = fixture()
  try {
    expect(f.trigger.dataset.presentation).toBe('text')
    expect(f.trigger.querySelector('svg')).toBeNull()
    expect(f.dom.window.getComputedStyle(f.trigger).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    f.trigger.focus()
    const message = { key: 'balance', fallback: '<b>余额 120</b>' }
    expect(f.updateLabel('balance', message)).toBe(true)
    expect(f.trigger.textContent).toBe(message.fallback)
    expect(f.trigger.querySelector('b')).toBeNull()
    expect(f.trigger.getAttribute('aria-label')).toBe(message.fallback)
    expect(f.trigger.dataset.cordisxTooltip).toBe(message.fallback)
    expect(f.document.activeElement).toBe(f.trigger)
    expect(f.document.querySelector('header button')).toBe(f.trigger)
    message.fallback = 'mutated caller'
    f.relocalize()
    expect(f.trigger.textContent).toBe('<b>余额 120</b>')
    for (
      const invalid of [
        null,
        { key: 'balance', html: '<b>x</b>' },
        { key: 'balance', params: { amount: Infinity } },
        { key: 'balance', params: new Date() },
        { key: 'balance', namespace: 123 },
        {
          key: 'balance',
          fallback: '余'.repeat(5500),
        },
      ]
    ) {
      expect(f.updateLabel('balance', invalid as CordisXLocalizedText)).toBe(false)
    }
    expect(f.updateLabel('native', { key: 'balance' })).toBe(false)
    menu.trigger.click()
    const openMenu = menu.document.querySelector('[role="menu"]')
    expect(menu.updateLabel('guest', { key: 'balance' })).toBe(true)
    expect(menu.updateLabel('profile', { key: 'balance' })).toBe(false)
    expect(menu.document.querySelector('[role="menu"]')).toBe(openMenu)
    expect(f.trigger.textContent).toBe('<b>余额 120</b>')
    f.revoke()
    expect(f.updateLabel('balance', { key: 'balance', fallback: '余额 —' })).toBe(true)
    expect(f.trigger.disabled).toBe(true)
    f.dispose()
    expect(f.updateLabel('balance', { key: 'balance' })).toBe(false)
  } finally {
    for (const item of [f, menu]) {
      item.dispose()
      item.dom.window.close()
    }
  }
})

it('keeps explicit accessible labels and disabled reasons when a primary label changes', () => {
  const f = fixture({
    ...command('balance'),
    presentation: 'primary',
    ariaLabel: { key: 'ledger', fallback: 'Open ledger' },
    disabled: { value: true, reason: { key: 'loading', fallback: 'Loading' } },
  })
  try {
    expect(f.updateLabel('balance', { key: 'balance', fallback: '余额 120' })).toBe(true)
    expect(f.trigger.textContent).toBe('余额 120')
    expect(f.trigger.getAttribute('aria-label')).toBe('Open ledger')
    expect(f.trigger.dataset.cordisxTooltip).toBe('Loading')
    expect(f.trigger.disabled).toBe(true)
  } finally {
    f.dispose()
    f.dom.window.close()
  }
})

it('retains cloned params on locale refresh and preserves pending command identity during label updates', async () => {
  const dom = new JSDOM('<header></header>')
  const document = dom.window.document
  let update: (id: string, label: CordisXLocalizedText) => boolean = () => false
  let refresh = () => {}
  let language = '余额'
  let finish = () => {}
  const calls: string[] = []
  const dispose = mountPageHeaderActions({
    registerLabelUpdater: callback => {
      update = callback
    },
    chrome: document.querySelector('header')!,
    actions: [{ ...command('balance'), presentation: 'text', icon: 'host:info' }],
    button: (label, icon) => pageChromeButton(document, label, icon),
    resolve: message => `${language} ${message.params?.amount ?? '—'}`,
    localize: callback => {
      refresh = callback
      callback()
    },
    visible: () => true,
    available: () => true,
    subscribe: () => () => {},
    execute: (_action, id) => {
      calls.push(id)
      return new Promise<void>(resolve => {
        finish = resolve
      })
    },
  })
  try {
    const trigger = document.querySelector('button')!
    const message = { key: 'balance', params: { amount: 120 } }
    expect(update('balance', message)).toBe(true)
    message.params.amount = 999
    language = 'Balance'
    refresh()
    expect(trigger.textContent).toBe('Balance 120')
    expect(trigger.querySelector('[data-host-icon="host:info"]')).not.toBeNull()
    trigger.click()
    expect(update('balance', { key: 'balance', params: { amount: 150 } })).toBe(true)
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    trigger.click()
    expect(calls).toEqual(['balance'])
    finish()
    await Promise.resolve()
    expect(trigger.disabled).toBe(false)
    expect(trigger.textContent).toBe('Balance 150')
  } finally {
    dispose()
    dom.window.close()
  }
})

it('updates account menu labels in place without changing focus, items or dispatch authorization', async () => {
  const f = fixture()
  try {
    f.trigger.click()
    const menu = f.document.querySelector('[role="menu"]')!
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const focused = f.document.activeElement
    const message = { key: 'account', fallback: '<b>GH L</b>' }
    expect(f.updateVisual('guest', { kind: 'avatar', src: 'data:image/png;base64,AAAA' })).toBe(true)
    expect(f.updateLabel('guest', message)).toBe(true)
    expect(f.document.querySelector('header button')).toBe(f.trigger)
    expect(f.document.querySelector('[role="menu"]')).toBe(menu)
    expect([...menu.querySelectorAll('[role="menuitem"]')]).toEqual(items)
    expect(f.document.activeElement).toBe(focused)
    expect(f.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(f.trigger.getAttribute('aria-label')).toBe('<b>GH L</b>')
    expect(f.trigger.dataset.cordisxTooltip).toBe('<b>GH L</b>')
    expect(menu.getAttribute('aria-label')).toBe('<b>GH L</b>')
    expect(menu.querySelector('b')).toBeNull()
    expect(items.map(item => item.textContent)).toEqual(['profile', 'disabled', 'settings'])
    expect(items[1]!.disabled).toBe(true)
    message.fallback = 'caller mutation'
    f.relocalize()
    expect(menu.getAttribute('aria-label')).toBe('<b>GH L</b>')
    expect(f.updateLabel('profile', { key: 'wrong' })).toBe(false)
    expect(f.updateLabel('guest', { key: 'account', params: { value: Infinity } })).toBe(false)
    items[0]!.click()
    expect(f.trigger.getAttribute('aria-busy')).toBe('true')
    expect(f.updateLabel('guest', { key: 'account', fallback: 'Updated account' })).toBe(true)
    expect(f.trigger.disabled).toBe(true)
    expect(f.trigger.getAttribute('aria-busy')).toBe('true')
    f.trigger.click()
    await Promise.resolve()
    expect(f.calls).toEqual(['guest/profile'])
    f.revoke()
    expect(f.updateLabel('guest', { key: 'account', fallback: 'Unavailable account' })).toBe(true)
    expect(f.trigger.disabled).toBe(true)
    f.trigger.click()
    expect(f.document.querySelector('[role="menu"]')).toBeNull()
    f.dispose()
    expect(f.updateLabel('guest', { key: 'account' })).toBe(false)
  } finally {
    f.dispose()
    f.dom.window.close()
  }
})

it('preserves explicit account menu accessible labels and disabled tooltip overrides', () => {
  const f = fixture({ ...guest, ariaLabel: { key: 'account', fallback: 'Open account menu' } })
  const disabled = fixture({
    ...guest,
    ariaLabel: { key: 'account', fallback: 'Open account menu' },
    disabled: { value: true, reason: { key: 'loading', fallback: 'Loading account' } },
  })
  try {
    f.trigger.click()
    expect(f.updateLabel('guest', { key: 'name', fallback: 'GH L' })).toBe(true)
    expect(f.trigger.getAttribute('aria-label')).toBe('Open account menu')
    expect(f.trigger.dataset.cordisxTooltip).toBe('Open account menu')
    expect(f.document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Open account menu')
    expect(disabled.updateLabel('guest', { key: 'name', fallback: 'GH L' })).toBe(true)
    expect(disabled.trigger.getAttribute('aria-label')).toBe('Open account menu')
    expect(disabled.trigger.dataset.cordisxTooltip).toBe('Loading account')
    expect(disabled.trigger.disabled).toBe(true)
  } finally {
    for (const item of [f, disabled]) {
      item.dispose()
      item.dom.window.close()
    }
  }
})
