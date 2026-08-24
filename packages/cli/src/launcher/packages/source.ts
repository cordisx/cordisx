import { fileURLToPath } from 'node:url'
import type { LocalPackageSource, LocalPackageSourceKind } from './types.js'
import { PackageLifecycleError } from './types.js'

export interface PluginPackageSourceV1 {
  readonly kind: LocalPackageSourceKind
  readonly location: string
  readonly downloadedFrom?: string
  readonly expectedDigest?: string
}

/** Host-only adapter from the formal source descriptor to a snapshot request. */
export function resolvePluginPackageSourceV1(source: PluginPackageSourceV1): LocalPackageSource {
  if (source.kind !== 'local-directory' && source.kind !== 'local-package' && source.kind !== 'downloaded-tarball') {
    throw new PackageLifecycleError('invalid-package-source', 'package source kind is unsupported')
  }
  let location: URL
  try {
    location = new URL(source.location)
  } catch {
    throw new PackageLifecycleError('invalid-package-source', 'package source location must be a file URL')
  }
  if (location.protocol !== 'file:' || location.search !== '' || location.hash !== '') {
    throw new PackageLifecycleError('invalid-package-source', 'package source location must be a query-free file URL')
  }
  if (source.kind === 'downloaded-tarball') {
    if (source.downloadedFrom === undefined || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(source.downloadedFrom)) {
      throw new PackageLifecycleError('invalid-package-source', 'downloaded tarball requires its HTTPS discovery URL')
    }
  } else if (source.downloadedFrom !== undefined) {
    throw new PackageLifecycleError('invalid-package-source', 'downloadedFrom is valid only for downloaded tarballs')
  }
  if (source.expectedDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(source.expectedDigest)) {
    throw new PackageLifecycleError('invalid-package-source', 'expectedDigest must be sha256:<lowercase hex>')
  }
  return {
    kind: source.kind,
    path: fileURLToPath(location),
    ...(source.downloadedFrom === undefined ? {} : { downloadedFrom: source.downloadedFrom }),
    ...(source.expectedDigest === undefined ? {} : { expectedIntegrity: source.expectedDigest as `sha256:${string}` }),
  }
}
