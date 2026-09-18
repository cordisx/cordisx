import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { releasePackageNames } from './release-packages.mjs'
import { releaseFromTag } from './release-version.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = 'cordisx/release-prepared-artifact/v1'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function sha512(file) {
  return createHash('sha512').update(await readFile(file)).digest('base64')
}

async function command(file, args) {
  return (await execute(file, args, { cwd: repositoryRoot, encoding: 'utf8' })).stdout.trim()
}

async function expectedIdentity(tag) {
  const release = releaseFromTag(tag)
  return {
    tag: release.tag,
    version: release.version,
    gitHead: await command('git', ['rev-parse', 'HEAD']),
    node: process.versions.node,
    npm: await command('npm', ['--version']),
    packages: releasePackageNames(),
  }
}

export async function writePreparedArtifactMetadata(archive, tag) {
  const identity = await expectedIdentity(tag)
  const archiveStat = await stat(archive)
  const metadata = {
    schema,
    ...identity,
    archive: path.basename(archive),
    size: archiveStat.size,
    sha512: await sha512(archive),
  }
  await writeFile(`${archive}.json`, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  return metadata
}

export async function verifyPreparedArtifact(archive, tag) {
  const [metadata, identity, archiveStat, archiveHash] = await Promise.all([
    readFile(`${archive}.json`, 'utf8').then(JSON.parse),
    expectedIdentity(tag),
    stat(archive),
    sha512(archive),
  ])
  if (metadata.schema !== schema) throw new Error('prepared release artifact schema mismatch')
  for (const field of ['tag', 'version', 'gitHead', 'node', 'npm']) {
    if (metadata[field] !== identity[field]) throw new Error(`prepared release artifact ${field} mismatch`)
  }
  if (JSON.stringify(metadata.packages) !== JSON.stringify(identity.packages)) {
    throw new Error('prepared release artifact package set mismatch')
  }
  if (metadata.archive !== path.basename(archive)) throw new Error('prepared release artifact filename mismatch')
  if (metadata.size !== archiveStat.size) throw new Error('prepared release artifact size mismatch')
  if (metadata.sha512 !== archiveHash) throw new Error('prepared release artifact digest mismatch')
  return metadata
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2]
  const archive = argument('--archive')
  const tag = argument('--tag')
  if (!archive || !tag || !['write', 'verify'].includes(operation)) {
    throw new Error('usage: release-prepared-artifact.mjs write|verify --archive <path> --tag <tag>')
  }
  const metadata = operation === 'write'
    ? await writePreparedArtifactMetadata(archive, tag)
    : await verifyPreparedArtifact(archive, tag)
  console.log(
    `[release] prepared artifact ${operation === 'write' ? 'recorded' : 'verified'} for ${metadata.gitHead}`,
  )
}
