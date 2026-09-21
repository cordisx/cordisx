import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { advanceReleaseState, readReleaseFiles, RELEASE_PHASES, verifyReleaseState } from './release-manifest.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function assertReleaseRecoveryPackage(metadata, packageName, manifest) {
  const pkg = manifest.packages.find(candidate => candidate.name === packageName)
  assert(pkg !== undefined, `${packageName} is not present in the release manifest`)
  assert(metadata?.version === manifest.release.version, `${packageName} registry version mismatch`)
  assert(metadata?.dist?.integrity === pkg.tarball.integrity, `${packageName} registry tarball integrity mismatch`)
  assert(metadata.gitHead === manifest.source.commitSha, `${packageName} registry gitHead mismatch`)
}

export function releaseRecoveryStages(nextPhase) {
  if (nextPhase === null) return []
  const index = RELEASE_PHASES.indexOf(nextPhase)
  assert(index !== -1, `unknown release phase ${nextPhase}`)
  return RELEASE_PHASES.slice(index)
}

export async function loadReleaseRecovery({
  manifestFile,
  stateFile,
  artifactRoot,
  commitSha,
  tag,
  version,
  registry,
  distTag,
  packages,
}) {
  const loaded = await readReleaseFiles({ manifestFile, stateFile, artifactRoot, commitSha })
  const { manifest } = loaded
  assert(manifest.release.tag === tag, 'release manifest tag mismatch')
  assert(manifest.release.version === version, 'release manifest version mismatch')
  assert(manifest.release.registry === registry, 'release manifest registry mismatch')
  assert(manifest.release.distTag === distTag, 'release manifest dist-tag mismatch')
  assert(
    JSON.stringify(manifest.packages.map(pkg => pkg.name)) === JSON.stringify(packages),
    'release manifest package set mismatch',
  )
  return loaded
}

export async function advanceReleaseRecovery(file, state, manifest, phase, evidence, options = {}) {
  const next = advanceReleaseState(state, manifest, phase, evidence, options)
  if (next === state) return state
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  verifyReleaseState(next, manifest, options)
  return next
}
