import type {
  ExtensionPointInteractionHandleV2,
  ExtensionPointInteractionsV2,
} from '@cordisx/protocol/extension-point-interactions/v2'
import { ComposerVisualDrag } from './composer-visual-drag.js'

/** Independent, bounded hit targets for one registration generation. */
export class ComposerVisualInteractions {
  readonly handle: ExtensionPointInteractionsV2
  private readonly entries = new Map<
    string,
    { controller: ComposerVisualDrag; handle: ExtensionPointInteractionHandleV2 }
  >()
  private disposed = false
  constructor(
    private readonly parent: HTMLElement,
    private readonly bounds: () => { width: number; height: number },
    private readonly authority: { drag(): boolean; activate(): boolean },
  ) {
    this.handle = Object.freeze({
      version: 'cordisx.extension-point-interactions/v2',
      create: (id: string) => this.create(id),
    })
  }
  private create(id: string): ExtensionPointInteractionHandleV2 {
    if (this.disposed) throw new Error('Visual interactions retired')
    if (typeof id !== 'string' || !id.trim() || id.length > 100) throw new TypeError('Invalid visual interaction id')
    const existing = this.entries.get(id)
    if (existing) return existing.handle
    if (this.entries.size >= 32) throw new RangeError('Visual interaction limit reached')
    const controller = new ComposerVisualDrag(this.parent, this.bounds, this.authority, true)
    const handle = Object.freeze({
      ...controller.handle,
      dispose: () => {
        if (this.entries.get(id)?.controller !== controller) return
        this.entries.delete(id)
        controller.dispose()
      },
    })
    this.entries.set(id, { controller, handle })
    return handle
  }
  refresh(): void {
    for (const entry of this.entries.values()) entry.controller.refresh()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) entry.controller.dispose()
    this.entries.clear()
  }
}
