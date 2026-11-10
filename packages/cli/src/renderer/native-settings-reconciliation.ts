import type { SelectionPatch, SelectionSnapshot } from './native-model-provider-state.js'
import type { NativeModelSelectionControl } from './adapter/native-model-provider-seat.js'

/** Coalesce settings notifications until the current selection operation releases its fence. */
export class NativeSettingsReconciliation {
  private pending = false
  private tier: 'priority' | null | undefined
  private revision = 0
  constructor(
    private readonly owner: {
      invalidate(): void
      publish(patch?: SelectionPatch): void
      ready(): boolean
      reconcile(): void
      matchesStorage(event: StorageEvent): boolean
    },
  ) {}

  update(patch?: SelectionPatch): void {
    this.owner.invalidate()
    this.revision++
    if (patch && Object.hasOwn(patch, 'serviceTier')) this.tier = patch.serviceTier
    this.pending = true
    this.owner.publish(patch)
  }

  flush(): void {
    if (!this.pending || !this.owner.ready()) return
    this.pending = false
    this.owner.reconcile()
  }

  epoch(): number {
    return this.revision
  }
  clearTierIfUnchanged(epoch: number): void {
    if (epoch === this.revision) this.tier = undefined
  }
  protect(state: SelectionSnapshot, control: NativeModelSelectionControl): SelectionSnapshot {
    if (this.tier === undefined) return state
    const tier = this.tier
    if (control.serviceTierKnown && control.serviceTier === tier) this.tier = undefined
    return state.serviceTier === tier ? state : { ...state, serviceTier: tier }
  }

  readonly focus = (): void => {
    if (this.owner.ready()) this.owner.reconcile()
  }
  readonly storage = (event: StorageEvent): void => {
    if (this.owner.matchesStorage(event)) this.focus()
  }
  reset(): void {
    this.pending = false
    this.tier = undefined
    this.revision++
  }
}
