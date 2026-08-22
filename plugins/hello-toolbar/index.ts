import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/contracts.js'

export const name = 'hello-toolbar'
export const inject = ['cordisx']

interface Config {
  readonly label?: string
  readonly open?: boolean
}

/** Example UI plugin: a header action opens a reversible frame-wide inspector. */
export function apply(ctx: Context, config: Config = {}): void {
  let open = config.open ?? false
  let renderPanel = (): void => {}

  ctx.cordisx.contribute({
    id: 'hello-toolbar.panel',
    slot: 'shell.overlay',
    mount({ container }) {
      const panel = document.createElement('section')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'CordisX example plugin')
      Object.assign(panel.style, {
        position: 'absolute',
        right: '16px',
        bottom: '16px',
        width: 'min(360px, calc(100vw - 32px))',
        padding: '16px',
        border: '1px solid #a78bfa',
        borderRadius: '12px',
        background: 'linear-gradient(145deg, #24163d, #17141f)',
        color: '#f5f3ff',
        boxShadow: '0 18px 60px rgba(0,0,0,.35)',
        font: '13px/1.5 system-ui, sans-serif',
      })
      const title = document.createElement('strong')
      title.textContent = 'CORDISX · ISOLATED CODEX'
      const description = document.createElement('p')
      description.textContent = 'UI plugin injection is active in this project-scoped test window. Your system Codex window is a separate process.'
      description.style.margin = '8px 0 0'
      panel.append(title, description)
      container.append(panel)
      renderPanel = () => { panel.hidden = !open }
      renderPanel()
      return () => {
        renderPanel = () => {}
        panel.remove()
      }
    },
  })

  ctx.cordisx.contribute({
    id: 'hello-toolbar.action',
    slot: 'header.actions',
    mount({ container }) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = config.label ?? 'CordisX'
      button.title = 'Toggle the CordisX example panel'
      Object.assign(button.style, {
        height: '28px',
        padding: '0 10px',
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: '12px/1 system-ui, sans-serif',
      })
      const toggle = (): void => {
        open = !open
        button.setAttribute('aria-pressed', String(open))
        renderPanel()
      }
      button.addEventListener('click', toggle)
      button.setAttribute('aria-pressed', String(open))
      container.append(button)
      return () => {
        button.removeEventListener('click', toggle)
        button.remove()
      }
    },
  })
}
