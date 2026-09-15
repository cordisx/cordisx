import { chmod } from 'node:fs/promises'
import path from 'node:path'

interface ManagedResourceMode {
  readonly path: `./${string}`
  readonly mode: 'data' | 'executable'
}

export function collectManagedResourceDirectories(resources: readonly ManagedResourceMode[]): ReadonlySet<string> {
  const directories = new Set<string>()
  for (const resource of resources) {
    let directory = path.posix.dirname(resource.path.slice(2))
    while (directory !== '.') {
      directories.add(directory)
      directory = path.posix.dirname(directory)
    }
  }
  return directories
}

export async function repairManagedServiceResourceModes(
  directory: string,
  resources: readonly ManagedResourceMode[],
): Promise<void> {
  if (process.platform === 'win32' || resources.length === 0) return
  await Promise.all([
    chmod(path.join(directory, 'managed-service-resources.json'), 0o444),
    ...resources.map(resource =>
      chmod(path.join(directory, resource.path.slice(2)), resource.mode === 'executable' ? 0o500 : 0o444)
    ),
    ...[...collectManagedResourceDirectories(resources)]
      .sort((left, right) => right.length - left.length)
      .map(relative => chmod(path.join(directory, relative), 0o555)),
  ])
  await chmod(directory, 0o555)
}
