import { readFile } from 'node:fs/promises'
import type { ResolvedPackageCandidate } from './packages/types.js'

export interface StoredSeparatedPackageV2 {
  readonly contract: 'cordisx.launcher-staged-package/v2'
  readonly package: ResolvedPackageCandidate['packageManifest']
}

export interface StoredSeparatedPackageV3 {
  readonly contract: 'cordisx.launcher-staged-package/v3'
  readonly package: ResolvedPackageCandidate['packageManifest']
  readonly runtimeObject: {
    /** Digest declared by the source package for the original runtime document bytes. */
    readonly sourceDigest: `sha256:${string}`
    /** Digest of the normalized bytes persisted in this immutable store object. */
    readonly storedDigest: `sha256:${string}`
  }
}

export interface StoredSeparatedPackageV4 extends Omit<StoredSeparatedPackageV3, 'contract'> {
  readonly contract: 'cordisx.launcher-staged-package/v4'
  readonly distributionArtifact: {
    readonly integrity: `sha256:${string}`
  }
}

export type StoredSeparatedPackage = StoredSeparatedPackageV2 | StoredSeparatedPackageV3 | StoredSeparatedPackageV4

export function separatedPackage(value: unknown): value is StoredSeparatedPackage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const contract = (value as { contract?: unknown }).contract
  return contract === 'cordisx.launcher-staged-package/v2'
    || contract === 'cordisx.launcher-staged-package/v3'
    || contract === 'cordisx.launcher-staged-package/v4'
}

export async function readOptionalFile(file: string): Promise<string | undefined> {
  return await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}
