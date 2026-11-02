import { createHash } from 'node:crypto'
import type { NativeResourceTransform, NativeResourceTransformResult } from '@cordisx/codex-adapter'

/** Session-local only: arbitrary legacy functions are never assumed pure. */
export class TransformMaterializationSession {
  private readonly transforms = new WeakMap<NativeResourceTransform, NativeResourceTransform>()
  private readonly results = new WeakMap<
    NativeResourceTransform,
    { digest: string; output: NativeResourceTransformResult }
  >()

  freeze(transform: NativeResourceTransform): NativeResourceTransform {
    const existing = this.transforms.get(transform)
    if (existing) return existing
    const frozen = transform.outputContract === 'fixed-original-v1'
      ? Object.freeze({ ...transform, transform: (source: string) => this.materialize(transform, source) })
      : Object.freeze(transform)
    this.transforms.set(transform, frozen)
    this.transforms.set(frozen, frozen)
    return frozen
  }

  materialize(transform: NativeResourceTransform, source: string): NativeResourceTransformResult {
    const digest = createHash('sha256').update(source).digest('hex')
    if (digest !== transform.sha256) {
      throw new Error(`Native resource changed after capability discovery: ${transform.url}`)
    }
    if (transform.outputContract !== 'fixed-original-v1') return transform.transform(source)
    const cached = this.results.get(transform)
    if (cached?.digest === digest) return cached.output
    const output = Object.freeze({ ...transform.transform(source) })
    this.results.set(transform, { digest, output })
    return output
  }
}
