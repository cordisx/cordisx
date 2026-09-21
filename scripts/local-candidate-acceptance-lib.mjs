import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathInside } from '../packages/cli/scripts/local-acceptance-paths.mjs'

const execute = promisify(execFile)

export async function sha256File(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex')
}

export async function tarEntry(tarball, entry) {
  const { stdout } = await execute('tar', ['-xOf', tarball, `package/${entry}`], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

async function packageInventory(root) {
  const records = []
  const visit = async directory => {
    for (
      const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name)
      )
    ) {
      const target = path.join(directory, entry.name)
      const relative = path.relative(root, target)
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) {
        records.push({ path: relative, kind: 'symlink', target: await readlink(target) })
      } else if (metadata.isDirectory()) {
        await visit(target)
      } else if (metadata.isFile()) {
        records.push({ path: relative, kind: 'file', sha256: await sha256File(target) })
      } else throw new Error(`candidate package contains unsupported entry: ${relative}`)
    }
  }
  await visit(root)
  return records
}

async function verifyPackageContents(packageRoot, tarball) {
  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-candidate-extract-'))
  try {
    await execute('tar', ['-xf', tarball, '-C', extractionRoot])
    const expected = await packageInventory(path.join(extractionRoot, 'package'))
    const installed = await packageInventory(packageRoot)
    if (JSON.stringify(installed) !== JSON.stringify(expected)) {
      throw new Error('installed candidate package contents differ from its tarball')
    }
    return `sha256:${createHash('sha256').update(JSON.stringify(expected)).digest('hex')}`
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

export async function verifyInstalledPackage(prefix, packed, binName, runBin) {
  const packageRoot = path.join(prefix, 'node_modules', packed.name)
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== packed.name || manifest.version !== packed.version) {
    throw new Error(`installed ${packed.name} did not resolve to the packed candidate`)
  }
  const binRelative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (typeof binRelative !== 'string') throw new Error(`installed ${packed.name} does not expose ${binName}`)
  const bin = path.join(prefix, 'node_modules', '.bin', binName)
  const resolvedPackageRoot = await realpath(packageRoot)
  const binTarget = await realpath(bin)
  if (!pathInside(resolvedPackageRoot, binTarget)) {
    throw new Error(`${binName} resolves outside the installed candidate`)
  }
  const installedDigest = createHash('sha256').update(await readFile(path.join(packageRoot, binRelative))).digest('hex')
  const packedDigest = createHash('sha256').update(await tarEntry(packed.tarball, binRelative)).digest('hex')
  if (installedDigest !== packedDigest) throw new Error(`${binName} differs from the packed candidate`)
  const packageContentDigest = await verifyPackageContents(resolvedPackageRoot, packed.tarball)
  await runBin(bin, ['--help'], { cwd: prefix })
  return {
    name: manifest.name,
    version: manifest.version,
    bin: binName,
    binTarget,
    binDigest: `sha256:${installedDigest}`,
    packageContentDigest,
    matchesTarball: true,
  }
}
