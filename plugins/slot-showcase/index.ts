import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXMessageSchema,
  type CordisXPluginManifestV1,
} from '../../src/contracts.js'

export const name = 'slot-showcase'
export const inject = ['slots', 'i18n']
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'slot-showcase',
  name: 'Slot Showcase',
  capabilities: [
    {
      name: 'models.read',
      required: false,
      reason: {
        key: 'permission.models',
        fallback: 'Show models currently available through the host connection',
      },
      scope: {},
    },
  ],
} as const satisfies CordisXPluginManifestV1

interface Config {
  readonly accent?: string
  readonly label?: string
  readonly open?: boolean
}

interface Messages extends CordisXMessageSchema {
  'permission.models': undefined
}

const SLOT_LABELS = [
  'header.actions',
  'composer.before',
  'composer.after',
  'sidebar.footer',
  'shell.overlay',
] as const

/** Visual demo plugin that exercises every CordisX v0.1 semantic UI slot. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.i18n.define<Messages>({
    namespace: 'slot-showcase',
    locale: 'en',
    default: true,
    messages: { 'permission.models': 'Show models currently available through the host connection' },
  })
  ctx.i18n.define<Messages>({
    namespace: 'slot-showcase',
    locale: 'zh-CN',
    messages: { 'permission.models': '显示当前宿主连接实际可用的模型' },
  })
  const accent = config.accent ?? '#8b5cf6'
  let open = config.open ?? true
  let renderOverlay = (): void => {}

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'slot-showcase.overlay',
  }, ({ container, document }) => {
    const panel = document.createElement('section')
    panel.dataset.cordisxDemoMarker = 'slot-showcase'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'CordisX slot showcase')
    Object.assign(panel.style, {
      position: 'absolute',
      right: '24px',
      bottom: '24px',
      width: 'min(360px, calc(100vw - 48px))',
      overflow: 'hidden',
      border: `1px solid color-mix(in srgb, ${accent} 58%, white 12%)`,
      borderRadius: '16px',
      background: 'linear-gradient(145deg, rgba(29, 24, 45, .98), rgba(14, 18, 29, .98))',
      color: '#f8fafc',
      boxShadow: '0 24px 80px rgba(0, 0, 0, .48)',
      font: '13px/1.45 ui-sans-serif, system-ui, sans-serif',
      backdropFilter: 'blur(18px)',
    })

    const heading = document.createElement('div')
    Object.assign(heading.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '15px 16px',
      borderBottom: '1px solid rgba(255, 255, 255, .09)',
      background: `linear-gradient(100deg, color-mix(in srgb, ${accent} 28%, transparent), transparent)`,
    })

    const titleGroup = document.createElement('div')
    const eyebrow = document.createElement('div')
    eyebrow.textContent = 'CORDISX · LIVE DEMO'
    Object.assign(eyebrow.style, {
      color: '#c4b5fd',
      fontSize: '10px',
      fontWeight: '800',
      letterSpacing: '.12em',
    })
    const title = document.createElement('strong')
    title.textContent = 'Five semantic slots are active'
    Object.assign(title.style, {
      display: 'block',
      marginTop: '3px',
      fontSize: '15px',
    })
    titleGroup.append(eyebrow, title)

    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '×'
    close.setAttribute('aria-label', 'Close CordisX demo panel')
    Object.assign(close.style, {
      width: '28px',
      height: '28px',
      border: '1px solid rgba(255, 255, 255, .14)',
      borderRadius: '8px',
      background: 'rgba(255, 255, 255, .06)',
      color: 'inherit',
      cursor: 'pointer',
      font: '20px/1 system-ui, sans-serif',
    })
    heading.append(titleGroup, close)

    const list = document.createElement('div')
    Object.assign(list.style, {
      display: 'grid',
      gap: '7px',
      padding: '13px 16px 16px',
    })
    for (const slot of SLOT_LABELS) {
      const row = document.createElement('div')
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '8px 10px',
        borderRadius: '9px',
        background: 'rgba(255, 255, 255, .045)',
      })
      const name = document.createElement('code')
      name.textContent = slot
      name.style.font = '11px/1.2 ui-monospace, SFMono-Regular, monospace'
      const status = document.createElement('span')
      status.textContent = 'ACTIVE'
      Object.assign(status.style, {
        color: '#86efac',
        fontSize: '9px',
        fontWeight: '800',
        letterSpacing: '.08em',
      })
      row.append(name, status)
      list.append(row)
    }

    const note = document.createElement('p')
    note.textContent = 'Injected into an isolated Codex renderer. Unloading this Cordis fiber removes every contribution.'
    Object.assign(note.style, {
      margin: '0',
      padding: '0 16px 16px',
      color: '#aeb7c7',
      fontSize: '11px',
    })
    panel.append(heading, list, note)
    container.append(panel)

    const closePanel = (): void => {
      open = false
      renderOverlay()
    }
    close.addEventListener('click', closePanel)
    renderOverlay = () => { panel.hidden = !open }
    renderOverlay()
    return () => {
      close.removeEventListener('click', closePanel)
      renderOverlay = () => {}
      panel.remove()
    }
  }))

  ctx.slots.inject('header.actions', () => ctx.slots.register({
    name: 'header.actions',
    id: 'slot-showcase.header-action',
  }, ({ container, document }) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.title = 'Toggle the CordisX slot showcase'
    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '28px',
      padding: '0 10px',
      border: `1px solid color-mix(in srgb, ${accent} 60%, transparent)`,
      borderRadius: '999px',
      background: `color-mix(in srgb, ${accent} 14%, transparent)`,
      color: 'inherit',
      cursor: 'pointer',
      font: '600 11px/1 system-ui, sans-serif',
    })
    const dot = document.createElement('span')
    dot.textContent = '●'
    dot.style.color = '#86efac'
    const label = document.createElement('span')
    label.textContent = config.label ?? 'CX Demo'
    button.append(dot, label)

    const toggle = (): void => {
      open = !open
      button.setAttribute('aria-pressed', String(open))
      renderOverlay()
    }
    button.addEventListener('click', toggle)
    button.setAttribute('aria-pressed', String(open))
    container.append(button)
    return () => {
      button.removeEventListener('click', toggle)
      button.remove()
    }
  }))

  ctx.slots.inject('composer.before', () => ctx.slots.register({
    name: 'composer.before',
    id: 'slot-showcase.composer-before',
  }, ({ container, document }) => {
    const card = document.createElement('div')
    Object.assign(card.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      width: 'min(760px, calc(100% - 32px))',
      margin: '0 auto 8px',
      padding: '8px 12px',
      border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
      borderRadius: '10px',
      background: `color-mix(in srgb, ${accent} 8%, transparent)`,
      color: 'inherit',
      font: '11px/1.35 system-ui, sans-serif',
    })
    const title = document.createElement('strong')
    title.textContent = '✦ Prompt Lens'
    const detail = document.createElement('span')
    detail.textContent = 'composer.before'
    detail.style.opacity = '.58'
    card.append(title, detail)
    container.append(card)
    return () => card.remove()
  }))

  ctx.slots.inject('composer.after', () => ctx.slots.register({
    name: 'composer.after',
    id: 'slot-showcase.composer-after',
  }, ({ container, document }) => {
    const status = document.createElement('div')
    status.textContent = '● CordisX demo active · composer.after'
    Object.assign(status.style, {
      width: 'min(760px, calc(100% - 32px))',
      margin: '6px auto 0',
      color: '#86efac',
      font: '600 10px/1.2 system-ui, sans-serif',
      letterSpacing: '.02em',
      textAlign: 'center',
    })
    container.append(status)
    return () => status.remove()
  }))

  ctx.slots.inject('sidebar.footer', () => ctx.slots.register({
    name: 'sidebar.footer',
    id: 'slot-showcase.sidebar-footer',
  }, ({ container, document }) => {
    const badge = document.createElement('div')
    Object.assign(badge.style, {
      margin: '8px',
      padding: '9px 10px',
      border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
      borderRadius: '10px',
      background: 'color-mix(in srgb, currentColor 4%, transparent)',
      color: 'inherit',
      font: '11px/1.35 system-ui, sans-serif',
    })
    const title = document.createElement('strong')
    title.textContent = 'CordisX Showcase'
    title.style.display = 'block'
    const detail = document.createElement('span')
    detail.textContent = '5 slots online'
    detail.style.opacity = '.58'
    badge.append(title, detail)
    container.append(badge)
    return () => badge.remove()
  }))
}
