import { Context, Service } from '@deepseek-ai/cordis'
import type { CordisXApi, CordisXContribution } from '../contracts.js'
import { DomSlotRegistry } from './slots.js'

const BASE_STYLE_ID = 'cordisx-base-style'

function installBaseStyles(document: Document): () => void {
  document.getElementById(BASE_STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = BASE_STYLE_ID
  style.textContent = `
    [data-cordisx-outlet="header.actions"] { display: contents; }
    [data-cordisx-outlet="header.actions"] > [data-cordisx-contribution] { display: inline-flex; align-items: center; }
    [data-cordisx-outlet="composer.before"], [data-cordisx-outlet="composer.after"] { width: 100%; }
    [data-cordisx-outlet="shell.overlay"] { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
    [data-cordisx-outlet="shell.overlay"] > [data-cordisx-contribution] { pointer-events: auto; }
    [data-cordisx-error="true"] { padding: 6px 10px; color: #fca5a5; background: #450a0a; border-radius: 8px; font: 12px/1.4 system-ui, sans-serif; }
  `
  ;(document.head ?? document.documentElement).append(style)
  return () => style.remove()
}

/** Cordis service that owns the renderer adapter and caller-scoped contributions. */
export class CordisXService extends Service implements CordisXApi {
  private readonly slots: DomSlotRegistry

  constructor(ctx: Context) {
    super(ctx, 'cordisx')
    if (typeof document === 'undefined') throw new Error('CordisX requires a browser document')
    this.slots = new DomSlotRegistry(document)
    ctx.effect(() => installBaseStyles(document), 'cordisx: base styles')
    ctx.effect(() => () => this.slots.dispose(), 'cordisx: DOM slot registry')
  }

  /** Register against the calling plugin's fiber so unload removes the contribution. */
  contribute(contribution: CordisXContribution): () => void | Promise<void> {
    return this.ctx.effect(
      () => this.slots.register(contribution),
      `cordisx.contribute(${JSON.stringify(contribution.id)})`,
    )
  }
}
