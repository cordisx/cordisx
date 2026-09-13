/** Explicit experimental inputs: copy source bytes, never an existing installation. */
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { run, save } from './sdk-build-tools.mjs'
export async function snapshotSource(source, destination) {
  source = path.resolve(source)
  await mkdir(destination, { recursive: true })
  const names = (await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], source))
    .split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  let files = 0
  for (const name of [...new Set(names)]) {
    // A local installation may be an untracked symlink; it is never a source input.
    if (name.split('/').includes('node_modules')) continue
    const from = path.join(source, name)
    const stat = await lstat(from).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) continue
    if (!stat.isFile()) throw new Error(`Experimental snapshot requires regular source files: ${name}`)
    const bytes = await readFile(from)
    hash.update(name).update('\0').update(bytes).update('\0')
    const to = path.join(destination, name)
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
    files++
  }
  const evidence = {
    baseCommit: await run('git', ['rev-parse', 'HEAD'], source),
    sourceSha256: hash.digest('hex'),
    files,
    experimental: true,
  }
  await save(path.join(destination, 'experimental-source.json'), evidence)
  return evidence
}
