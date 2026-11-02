import { createHash } from 'node:crypto'
import type { NativeResourceTransform, NativeResourceTransformResult } from './contracts.js'

/** Opt in only for owned transforms whose output is fixed by these exact original bytes. */
export function fixedNativeTransform(transform: NativeResourceTransform): NativeResourceTransform {
  let output: NativeResourceTransformResult | undefined
  return Object.freeze({
    ...transform,
    outputContract: 'fixed-original-v1' as const,
    transform(source: string) {
      if (createHash('sha256').update(source).digest('hex') !== transform.sha256) {
        throw new Error(`Native resource changed after capability discovery: ${transform.url}`)
      }
      output ??= Object.freeze({ ...transform.transform(source) })
      return output
    },
  })
}
