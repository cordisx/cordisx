import { Context, Service } from '@deepseek-ai/cordis'
import {
  CORDISX_SLOT_NAMES,
  type CordisXSlotComponent,
  type CordisXSlotName,
  type CordisXSlotOptions,
  type CordisXSlots,
} from '../contracts.js'
import { DomSlotRegistry, type SlotRegistrationSnapshot } from './slots.js'

const BASE_STYLE_ID = 'cordisx-base-style'

/** Plugin id inherited by a runtime-created child Context. */
export const CORDISX_PLUGIN_ID = Symbol('cordisx.pluginId')
/** Launcher-owned source inherited by the same runtime-created child Context. */
export const CORDISX_PLUGIN_SOURCE = Symbol('cordisx.pluginSource')

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

function assertSlotName(name: CordisXSlotName): void {
  if (!(CORDISX_SLOT_NAMES as readonly string[]).includes(name)) {
    throw new Error(`slot ${JSON.stringify(name)} is not declared by the CordisX host`)
  }
}

/** DSH-style slot service backed by the Codex DOM adapter. */
export class CordisXSlotService extends Service implements CordisXSlots {
  private readonly registry: DomSlotRegistry

  constructor(ctx: Context) {
    super(ctx, 'slots')
    if (typeof document === 'undefined') throw new Error('CordisX requires a browser document')
    this.registry = new DomSlotRegistry(document)
    ctx.effect(() => installBaseStyles(document), 'cordisx: base styles')
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: DOM slot registry')
  }

  /** Install an effect against the caller fiber while this host declaration exists. */
  inject(name: CordisXSlotName, setup: Parameters<CordisXSlots['inject']>[1]): ReturnType<CordisXSlots['inject']> {
    assertSlotName(name)
    return this.ctx.effect(setup, `slots.inject(${JSON.stringify(name)})`)
  }

  /** Register against the caller fiber so plugin unload removes the entry. */
  register(options: CordisXSlotOptions, component: CordisXSlotComponent): ReturnType<CordisXSlots['register']> {
    assertSlotName(options.name)
    const pluginId = (this.ctx as Context & { [CORDISX_PLUGIN_ID]?: string })[CORDISX_PLUGIN_ID]
    return this.ctx.effect(
      () => this.registry.register(options, component, pluginId),
      `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`,
    )
  }

  /** Internal manager snapshot of current semantic-slot registrations. */
  snapshot(): readonly SlotRegistrationSnapshot[] {
    return this.registry.snapshot()
  }
}
