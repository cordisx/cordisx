import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { localDevelopmentPackageInfo } from './development.js'
import type { CordisXConfigPlugin } from './config.js'

async function commonDirectory(entry: string): Promise<string> {
  if (!(await stat(entry)).isFile()) throw new Error('development identity entry must be a file')
  const resolved = await realpath(entry)
  const result = await promisify(execFile)('git', [
    '-C',
    path.dirname(resolved),
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  return await realpath(result.stdout.trim())
}

/** Explicit Host composition choice, never a plugin manifest/runtime claim. */
export async function resolveDevelopmentIdentitySource(
  plugin: Pick<CordisXConfigPlugin, 'id' | 'entry' | 'developmentIdentityEntry'>,
): Promise<string> {
  const actual = path.resolve(plugin.entry)
  const identityEntry = plugin.developmentIdentityEntry === undefined
    ? actual
    : path.resolve(plugin.developmentIdentityEntry)
  if (plugin.developmentIdentityEntry !== undefined) {
    const [actualGit, identityGit, actualPackage, identityPackage] = await Promise.all([
      commonDirectory(actual),
      commonDirectory(identityEntry),
      localDevelopmentPackageInfo(actual),
      localDevelopmentPackageInfo(identityEntry),
    ])
    if (actualGit !== identityGit) {
      throw new Error('development identity entries must belong to the same Git worktree family')
    }
    if (actualPackage.manifest?.id !== plugin.id || identityPackage.manifest?.id !== plugin.id) {
      throw new Error('development identity entries must declare the same plugin package id')
    }
  }
  // Preserve the original algorithm exactly: hash path.resolve(entry), not realpath.
  const sourceKey = createHash('sha256').update(identityEntry).digest('hex').slice(0, 24)
  return `file:///cordisx-local-dev/${sourceKey}/${plugin.id}.js`
}
