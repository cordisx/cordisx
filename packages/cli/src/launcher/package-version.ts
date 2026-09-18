import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function resolveOwningPackageVersion(
  moduleUrl: string,
  packageName: string,
): Promise<string> {
  let directory = path.dirname(fileURLToPath(moduleUrl))
  while (true) {
    const packagePath = path.join(directory, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === packageName && typeof manifest.version === 'string') return manifest.version
    } catch {
      // Keep walking until the owning package manifest is found.
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`${packageName} package version could not be resolved`)
    directory = parent
  }
}
